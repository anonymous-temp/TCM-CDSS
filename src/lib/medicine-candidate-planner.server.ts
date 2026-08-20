import { z } from "zod";
import type { CaseState } from "./diagnosis-types";
import { diagnoseReasoningFromState } from "./diagnosis-parse";
import {
  fetchExternalEvidence,
  formatInstructionEvidenceRecord,
  type ExternalEvidenceItem,
} from "./evimed-guide";
import {
  buildEvidenceScope,
  medicineEvidenceBindingValid,
  medicineProblemMatchesCase,
} from "./evidence-source-validation";
import {
  retrieveLocalPatentMedicineCandidates,
  type LocalPatentMedicineCandidate,
} from "./local-patent-medicine-candidates";
import type { EvidenceBoundMedicineProposal } from "./m04-proposal-compiler";
import { parseMedicationLabelUsage } from "./medication-label-usage";
import { medicineAvailabilityView } from "./drug-inventory.server";
import { createTextModelClient, getPrimaryTextModelConfig, isApprovedTextModel, textModelRequestTuning } from "./text-model";

const PlannerSchema = z.object({
  localEvidenceIds: z.array(z.string().regex(/^LOCAL-INST-\d{3}$/)).max(2).default([]),
  westernMedicines: z.array(z.object({
    genericName: z.string().min(2).max(80),
    correspondingProblem: z.string().min(2).max(120),
  })).max(3).default([]),
});

type PlannerSelection = z.infer<typeof PlannerSchema>;

export type MedicineCandidatePlan = {
  candidates: EvidenceBoundMedicineProposal[];
  evidenceContext: string;
  status: "available" | "no_match" | "planner_unavailable";
};

function parseJsonObject(content: string): unknown {
  const clean = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(clean.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function compact(value: string | undefined, max: number): string {
  return (value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizedMedicineName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s（）()【】\[\]·]/g, "")
    .replace(/(?:缓释|控释|肠溶)?(?:片|胶囊|颗粒|丸|口服液|注射液|喷雾剂|滴丸|糖浆|散|膏)$/g, "")
    .toLowerCase();
}

function medicineNameMatches(query: string, item: ExternalEvidenceItem): boolean {
  const expected = normalizedMedicineName(query);
  const actual = normalizedMedicineName(item.medicineName || item.title);
  return expected.length >= 2 && actual.length >= 2 && (actual.includes(expected) || expected.includes(actual));
}

function casePlanningText(caseState: CaseState): string {
  const reasoning = diagnoseReasoningFromState(caseState) || caseState.reasoningDiagnose || caseState.reasoningV2;
  return [
    reasoning?.westernDiagnosis?.primary?.name,
    ...(reasoning?.westernDiagnosis?.primary?.supportingFacts || []),
    reasoning?.overview?.primarySyndrome,
    ...(reasoning?.overview?.primarySyndromeBasis || []),
    caseState.chiefComplaint,
    caseState.hisRecord?.fields.zhushu,
    caseState.hisRecord?.fields.xianbingshi,
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => compact(value, 240))
    .join("；")
    .slice(0, 2200);
}

function localCandidateToProposal(candidate: LocalPatentMedicineCandidate): EvidenceBoundMedicineProposal {
  const problem = candidate.matchedConcepts.join("、") || compact(candidate.indication, 100);
  const risk = compact([
    candidate.contraindication,
    candidate.precaution,
    candidate.pregnancyLactation,
    candidate.interaction,
  ].filter(Boolean).join("；"), 800) || "采用前核对完整说明书禁忌、注意事项、特殊人群和相互作用。";
  const labelUsage = parseMedicationLabelUsage(candidate.usage);
  return {
    type: "中成药",
    name: candidate.name,
    specification: compact(candidate.specification, 300) || null,
    singleDose: labelUsage.singleDose || null,
    frequency: labelUsage.frequency || null,
    route: labelUsage.route || null,
    administrationTiming: labelUsage.administrationTiming || null,
    usageBoundary: "说明书用法字段已与本候选的说明书条目及指纹绑定。",
    course: labelUsage.course || null,
    positioning: "需医生评估",
    correspondingProblem: problem,
    evidenceId: candidate.id,
    evidenceFingerprint: candidate.fingerprint,
    relationship: "与中药饮片方案不默认联用，由医生结合重复功效、相互作用和治疗目标择一或评估联用。",
    riskNote: risk,
  };
}

function externalCandidateToProposal(
  item: ExternalEvidenceItem,
  evidenceId: string,
  correspondingProblem: string,
): EvidenceBoundMedicineProposal | undefined {
  if (!item.fingerprint) return undefined;
  const risk = compact([
    item.contraindication,
    item.specialPopulation,
    item.interaction,
  ].filter(Boolean).join("；"), 800) || "采用前核对完整说明书禁忌、注意事项、特殊人群和相互作用。";
  const labelUsage = parseMedicationLabelUsage(item.usage);
  return {
    type: "西药",
    name: compact(item.medicineName || item.title, 300),
    specification: compact(item.specification, 300) || null,
    singleDose: labelUsage.singleDose || null,
    frequency: labelUsage.frequency || null,
    route: labelUsage.route || null,
    administrationTiming: labelUsage.administrationTiming || null,
    usageBoundary: "说明书用法字段已与本候选的说明书条目及指纹绑定；本候选仍为医生讨论项。",
    course: labelUsage.course || null,
    positioning: "需医生评估",
    correspondingProblem: compact(correspondingProblem, 120),
    evidenceId,
    evidenceFingerprint: item.fingerprint,
    relationship: "是否与当前中药饮片方案联用或替代，须由医生结合完整用药史和治疗目标决定。",
    riskNote: risk,
  };
}

/**
 * 规划器模型闸（2026-08-08）。原为 35s —— 整条 M04 前置里唯一的重腿，其余语义层 6s，
 * 而 M04 编排总闸只有 120s，尾部一次慢规划就吃掉四分之一预算，挤压的是生成与修复轮，
 * 也就是"医生点了生成方药到底拿不拿得到东西"。
 *
 * 压这个闸的前提是它的降级态**不是空态**：selection 为空时下面仍保留本地受治理中成药候选
 * （score>=3 的首选，见 :232-236），丢的只是模型精选与西药说明书精确检索这层增益，
 * 且规划器产物本就是无剂量的建议性候选（positioning="需医生评估"）。
 * 闸命中打日志——候选被裁掉必须可测量，不允许静默截断。
 */
export const MEDICINE_PLANNER_MODEL_TIMEOUT_MS = 12_000;

async function runPlannerModel(
  caseState: CaseState,
  localCandidates: readonly LocalPatentMedicineCandidate[],
  requestSignal?: AbortSignal,
): Promise<PlannerSelection | undefined> {
  const config = getPrimaryTextModelConfig();
  if (!config.configured || !isApprovedTextModel(config.model)) return undefined;
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort();
  if (requestSignal?.aborted) controller.abort();
  else requestSignal?.addEventListener("abort", abortFromRequest, { once: true });
  let deadlineFired = false;
  const timeout = setTimeout(() => {
    deadlineFired = true;
    controller.abort();
  }, MEDICINE_PLANNER_MODEL_TIMEOUT_MS);
  try {
    const localCatalog = localCandidates.map((item) => ({
      evidenceId: item.id,
      name: item.name,
      indication: compact(item.indication, 240),
      matchedConcepts: item.matchedConcepts,
      matchedPatientFacts: item.matchedPatientFacts,
    }));
    const completion = await createTextModelClient(config).chat.completions.create({
      model: config.model,
      temperature: 0,
      max_tokens: 900,
      response_format: { type: "json_object" },
      ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
      messages: [
        {
          role: "system",
          content: [
            "你是门诊用药候选规划器，只输出JSON，不生成剂量、频次、疗程或处方。",
            "依据当前已确认诊断和阳性事实：从给定本地中成药说明书候选中最多选择2个ID；另提出最多3个应精确检索说明书的西药通用名。",
            "西药仅在当前西医诊断已有足够依据且药物适应证可直接覆盖该诊断/症状时提出；不得为待排诊断、阴性症状、单纯中医证候提出西药。",
            "不得提出抗菌药、激素、抗凝药、抗精神病药或其他高风险药物，除非病例已有明确对应诊断和必要证据。",
            "每个对应问题必须是病例中当前阳性的具体诊断或症状，不得写‘调理’‘改善体质’等泛化词。",
            "结构固定为：{\"localEvidenceIds\":[],\"westernMedicines\":[{\"genericName\":\"\",\"correspondingProblem\":\"\"}]}。",
          ].join("\n"),
        },
        {
          role: "user",
          content: `病例事实：${casePlanningText(caseState)}\n本地中成药候选：${JSON.stringify(localCatalog)}`,
        },
      ],
    }, { signal: controller.signal });
    const parsed = PlannerSchema.safeParse(parseJsonObject(completion.choices[0]?.message?.content || ""));
    return parsed.success ? parsed.data : undefined;
  } catch {
    if (deadlineFired) {
      // 不含患者内容：只报闸命中，用于统计"因为闸而降级到纯本地候选"的比例。
      console.warn("[tcm-cdss:medicine-planner] planner model deadline reached; falling back to local candidates", {
        deadlineMs: MEDICINE_PLANNER_MODEL_TIMEOUT_MS,
        localCandidateCount: localCandidates.length,
      });
    }
    return undefined;
  } finally {
    clearTimeout(timeout);
    requestSignal?.removeEventListener("abort", abortFromRequest);
  }
}

async function resolveWesternCandidate(
  selection: PlannerSelection["westernMedicines"][number],
  index: number,
  caseText: string,
): Promise<{ candidate: EvidenceBoundMedicineProposal; record: string } | undefined> {
  if (!medicineProblemMatchesCase(selection.correspondingProblem, caseText)) return undefined;
  const result = await fetchExternalEvidence("instruction", selection.genericName, { count: 6 });
  const item = result.list.find((candidate) => {
    const indication = compact(candidate.indication || candidate.summary, 500);
    return medicineNameMatches(selection.genericName, candidate) &&
      Boolean(candidate.fingerprint && indication) &&
      medicineProblemMatchesCase(selection.correspondingProblem, indication);
  });
  if (!item) return undefined;
  const evidenceId = `EVID-INST-${String(101 + index).padStart(3, "0")}`;
  const record = formatInstructionEvidenceRecord(item, evidenceId);
  const candidate = externalCandidateToProposal(item, evidenceId, selection.correspondingProblem);
  if (!candidate) return undefined;
  const scope = buildEvidenceScope(record);
  if (!medicineEvidenceBindingValid(
    candidate.evidenceId,
    candidate.evidenceFingerprint,
    candidate.name,
    candidate.correspondingProblem,
    candidate.specification,
    scope,
  )) return undefined;
  return { candidate, record };
}

export async function planEvidenceBoundMedicineCandidates(
  caseState: CaseState,
  customerIdOrSignal?: string | AbortSignal,
  explicitRequestSignal?: AbortSignal,
): Promise<MedicineCandidatePlan> {
  const customerId = typeof customerIdOrSignal === "string" ? customerIdOrSignal : undefined;
  const requestSignal = typeof customerIdOrSignal === "string" ? explicitRequestSignal : customerIdOrSignal;
  const medicineAvailability = customerId ? await medicineAvailabilityView(customerId) : undefined;
  const inCustomerInventory = (name: string, kind: "patent" | "western") =>
    !medicineAvailability?.inventoryLoaded || medicineAvailability.statusOf(name, kind) === "in_stock";
  const localCandidates = retrieveLocalPatentMedicineCandidates(caseState, 10)
    .filter((item) => inCustomerInventory(item.name, "patent"));
  const selection = await runPlannerModel(caseState, localCandidates, requestSignal);
  const selectedLocalIds = selection?.localEvidenceIds.length
    ? selection.localEvidenceIds
    : localCandidates[0]?.score >= 3
      ? [localCandidates[0].id]
      : [];
  const selectedLocal = selectedLocalIds.flatMap((id) => {
    const candidate = localCandidates.find((item) => item.id === id);
    return candidate ? [localCandidateToProposal(candidate)] : [];
  }).slice(0, 2);

  const caseText = casePlanningText(caseState);
  const resolvedWestern = selection
    ? await Promise.all(selection.westernMedicines.map((item, index) => resolveWesternCandidate(item, index, caseText)))
    : [];
  const western = resolvedWestern.filter((item): item is NonNullable<typeof item> =>
    Boolean(item) && inCustomerInventory(item?.candidate.name || "", "western"));
  const candidates = [...selectedLocal, ...western.map((item) => item.candidate)].slice(0, 5);
  const evidenceContext = western.length > 0
    ? [
        "【病例规划后的西药说明书精确检索（仅供医生讨论）】",
        ...western.map((item) => item.record),
        "选择纪律：这些条目已按药名精确检索并核对适应证与本例阳性问题；仍不形成剂量、频次或疗程医嘱。",
      ].join("\n")
    : "";
  return {
    candidates,
    evidenceContext,
    status: candidates.length > 0 ? "available" : selection ? "no_match" : "planner_unavailable",
  };
}
