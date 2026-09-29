import { createHash } from "node:crypto";
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
  findLocalPatentMedicineLabel,
  formatLocalPatentMedicineRecord,
  localPrescriptionPatentMedicineEntries,
  patentMedicineBaseName,
  retrieveLocalPatentMedicineCandidates,
  type LocalPatentMedicineCandidate,
} from "./local-patent-medicine-candidates";
import type { EvidenceBoundMedicineProposal } from "./m04-proposal-compiler";
import { parseMedicationLabelUsage } from "./medication-label-usage";
import { inventoryAvailabilityView, type InventoryAvailabilityView } from "./drug-inventory.server";
import { createTextModelClient, getPrimaryTextModelConfig, isApprovedTextModel, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";

const PlannerSchema = z.object({
  localEvidenceIds: z.array(z.string().regex(/^LOCAL-INST-\d{3}$/)).max(2).default([]),
  // AI 提名的中成药（2026-09-28）：本地候选都不合适时由规划模型提名，系统先在本地说明书目录
  // （非处方 + 处方，过同一套病例相关性与安全排除）里核对，再查 EviMed 说明书；核对不到的不采用。
  patentMedicines: z.array(z.object({
    name: z.string().min(2).max(80),
    correspondingProblem: z.string().min(2).max(120),
  })).max(2).catch([]).default([]),
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
  type: "西药" | "中成药" = "西药",
): EvidenceBoundMedicineProposal | undefined {
  if (!item.fingerprint) return undefined;
  const risk = compact([
    item.contraindication,
    item.specialPopulation,
    item.interaction,
  ].filter(Boolean).join("；"), 800) || "采用前核对完整说明书禁忌、注意事项、特殊人群和相互作用。";
  const labelUsage = parseMedicationLabelUsage(item.usage);
  return {
    type,
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
 * 而 M04 编排总闸是 180s，尾部一次慢规划仍会显著挤压生成与修复轮，
 * 也就是"医生点了生成方药到底拿不拿得到东西"。
 *
 * 压这个闸的前提是它的降级态**不是空态**：selection 为空时下面仍保留本地受治理中成药候选
 * （score>=3 的首选，见 :232-236），丢的只是模型精选与西药说明书精确检索这层增益，
 * 且规划器产物本就是无剂量的建议性候选（positioning="需医生评估"）。
 * 闸命中打日志——候选被裁掉必须可测量，不允许静默截断。
 */
export const MEDICINE_PLANNER_MODEL_TIMEOUT_MS = 12_000;

/** 规划器提示词版本，进缓存键：改了提示词，旧缓存不得再命中。 */
const PLANNER_PROMPT_VERSION = "2026-09-28-inventory-ai-patent-v3";

/**
 * 规划结果缓存与并发合流（2026-09-27，提速）。规划器输入是（模型，病例规划文本，本地候选目录）
 * 的纯函数、temperature 0；M03 签名完成时服务端按同一份已签名推理**预取**本次 M04 的规划，
 * M04 路由再调用时直接命中，省掉规划器（约 1.2s）与其后串行的西药说明书检索。
 * 只缓存成功解析的结果（10 分钟、至多 64 条）；共享请求不绑定任一调用方的中止信号，
 * 调用方中止时只是自己按「规划器不可用」返回，与原降级语义一致。
 */
const PLANNER_CACHE_TTL_MS = 10 * 60_000;
const PLANNER_CACHE_MAX = 64;
const plannerCache = new Map<string, { storedAt: number; value: PlannerSelection }>();
const plannerInFlight = new Map<string, Promise<PlannerSelection | undefined>>();

function awaitPlannerWithSignal(
  pending: Promise<PlannerSelection | undefined>,
  signal: AbortSignal | undefined,
): Promise<PlannerSelection | undefined> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      () => { signal.removeEventListener("abort", onAbort); resolve(undefined); },
    );
  });
}

async function runPlannerModel(
  caseState: CaseState,
  localCandidates: readonly LocalPatentMedicineCandidate[],
  requestSignal?: AbortSignal,
  inventoryLabels: ReadonlyMap<string, string> = new Map(),
): Promise<PlannerSelection | undefined> {
  const config = getPrimaryTextModelConfig();
  if (!config.configured || !isApprovedTextModel(config.model)) return undefined;
  if (requestSignal?.aborted) return undefined;
  const key = createHash("sha256")
    .update(JSON.stringify([config.model, config.baseUrl || "", PLANNER_PROMPT_VERSION, casePlanningText(caseState), localCandidates.map((item) => [
      item.id, item.name, compact(item.indication, 240), item.matchedConcepts, item.matchedPatientFacts, inventoryLabels.get(item.id) || "",
    ])]))
    .digest("hex");
  const cached = plannerCache.get(key);
  if (cached && Date.now() - cached.storedAt < PLANNER_CACHE_TTL_MS) return cached.value;
  if (cached) plannerCache.delete(key);
  const joined = plannerInFlight.get(key);
  if (joined) return awaitPlannerWithSignal(joined, requestSignal);
  const pending = runPlannerModelUncached(caseState, localCandidates, undefined, inventoryLabels)
    .then((value) => {
      if (value) {
        plannerCache.set(key, { storedAt: Date.now(), value });
        while (plannerCache.size > PLANNER_CACHE_MAX) {
          const oldest = plannerCache.keys().next().value;
          if (oldest === undefined) break;
          plannerCache.delete(oldest);
        }
      }
      return value;
    })
    .finally(() => plannerInFlight.delete(key));
  plannerInFlight.set(key, pending);
  return awaitPlannerWithSignal(pending, requestSignal);
}

async function runPlannerModelUncached(
  caseState: CaseState,
  localCandidates: readonly LocalPatentMedicineCandidate[],
  requestSignal?: AbortSignal,
  inventoryLabels: ReadonlyMap<string, string> = new Map(),
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
    // AI 提名中成药只作最后一档（甲方 2026-09-28 的优先级：院内 → 本地库/EviMed → AI）：本地说明书
    // 检索对本例有候选时不开放提名。本机 65 例实测：开放时模型几乎每例都另提（82 个里 70 个核对不到
    // 说明书），规划器中位耗时 +0.6～2.4 秒，而核对到的只多出约每 4 例 1 个候选。
    const allowPatentProposals = localCandidates.length === 0;
    const localCatalog = localCandidates.map((item) => ({
      evidenceId: item.id,
      name: item.name,
      indication: compact(item.indication, 240),
      matchedConcepts: item.matchedConcepts,
      matchedPatientFacts: item.matchedPatientFacts,
      ...(inventoryLabels.get(item.id) ? { 院内: inventoryLabels.get(item.id) } : {}),
    }));
    const completion = await observeModelTask({ task: "medicine_candidate_plan", stage: "prescribe", model: config.model }, () => createTextModelClient(config).chat.completions.create({
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
            ...(inventoryLabels.size > 0
              ? ["候选若带「院内」字段（院内有货/缺货/库存外用药），适用程度相当时优先选院内有货的；院内没有但明显更适合本例的照常选，系统会标注为库存外用药。"]
              : []),
            ...(allowPatentProposals
              ? ["本例本地中成药说明书检索没有候选：可在 patentMedicines 中提名最多2个适合本例的中成药（写国家批准上市的完整药名，不得提名注射剂）；系统会核对说明书，核对不到的不会采用。"]
              : []),
            "西药仅在当前西医诊断已有足够依据且药物适应证可直接覆盖该诊断/症状时提出；不得为待排诊断、阴性症状、单纯中医证候提出西药。",
            "不得提出抗菌药、激素、抗凝药、抗精神病药或其他高风险药物，除非病例已有明确对应诊断和必要证据。",
            "每个对应问题必须是病例中当前阳性的具体诊断或症状，不得写‘调理’‘改善体质’等泛化词。",
            allowPatentProposals
              ? "结构固定为：{\"localEvidenceIds\":[],\"patentMedicines\":[{\"name\":\"\",\"correspondingProblem\":\"\"}],\"westernMedicines\":[{\"genericName\":\"\",\"correspondingProblem\":\"\"}]}。"
              : "结构固定为：{\"localEvidenceIds\":[],\"westernMedicines\":[{\"genericName\":\"\",\"correspondingProblem\":\"\"}]}。",
          ].join("\n"),
        },
        {
          role: "user",
          content: `病例事实：${casePlanningText(caseState)}\n本地中成药候选：${JSON.stringify(localCatalog)}`,
        },
      ],
    }, { signal: controller.signal }));
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

/** 规划器追加候选（院内有货的检索外候选、AI 提名后核对到的本地说明书）的编号起点，避开证据段的 001–010。 */
const PLANNER_EXTRA_LOCAL_ID_OFFSET = 500;
/** 院内有货、与本例相关（评分 ≥3，与规划器兜底首选同一门槛）但在病例检索前 10 名之外的中成药：最多补入几个。 */
const IN_STOCK_EXTRA_LIMIT = 5;
/** AI 提名中成药查 EviMed 说明书的时限（毫秒）。本地说明书目录核对不耗联网时间，优先走本地。 */
const AI_PATENT_EVIDENCE_BUDGET_MS = 1_500;
const IN_STOCK_MIN_SCORE = 3;

type ResolvedPlannerMedicine = { candidate: EvidenceBoundMedicineProposal; record?: string };

function inventoryLabelOf(view: InventoryAvailabilityView | undefined, name: string, kind: "patent" | "western"): string | undefined {
  return view?.inventoryLoaded ? view.statusOf(name, kind).label : undefined;
}

function inStockFirst<T>(items: readonly T[], inStock: (item: T) => boolean): T[] {
  return [...items.filter(inStock), ...items.filter((item) => !inStock(item))];
}

/**
 * AI 提名的中成药核对（2026-09-28，甲方：AI 提名但查不到说明书的不出现，尽量降低这种情况、联网兜底但不明显加时）。
 * 1) 本地说明书目录（非处方 3,908 + 处方 4,899 种）：必须通过与病例检索同一套相关性与安全排除
 *    （适应证概念命中、体质前提、方剂鉴别反证、寒热对立、说明书自排除），零联网耗时；
 * 2) 本地查不到才查 EviMed 说明书（与西药同一条检索与绑定校验，和西药检索并行，受规划器时限约束）；
 * 3) 都核对不到：不采用，只记一条遥测。
 */
async function resolveProposedPatentMedicine(
  proposal: PlannerSelection["patentMedicines"][number],
  index: number,
  caseText: string,
  localPools: readonly (readonly LocalPatentMedicineCandidate[])[],
  caseState?: CaseState,
): Promise<ResolvedPlannerMedicine | undefined> {
  if (!medicineProblemMatchesCase(proposal.correspondingProblem, caseText)) return undefined;
  if (/注射/.test(proposal.name)) return undefined;
  const wanted = proposal.name.normalize("NFKC").replace(/\s/g, "");
  const wantedBase = patentMedicineBaseName(wanted);
  for (const pool of localPools) {
    const match = pool.find((item) => item.name === wanted) ||
      (wantedBase.length >= 2 ? pool.find((item) => patentMedicineBaseName(item.name) === wantedBase) : undefined);
    if (match) {
      const id = `LOCAL-INST-${String(PLANNER_EXTRA_LOCAL_ID_OFFSET + 30 + index + 1).padStart(3, "0")}`;
      const candidate = { ...match, id };
      return { candidate: localCandidateToProposal(candidate), record: formatLocalPatentMedicineRecord(candidate) };
    }
  }
  // 本地说明书目录里有这个药名、但适应证没命中受控临床概念：仍过同一套安全排除，并要求说明书适应证
  // 覆盖本例问题（与 EviMed 核对同一判据）。本机 65 例实测：AI 提名 82 个里只有 10 个能在病例检索池里
  // 核对到，EviMed 只补到 2 个——按名查全部 8,807 种本地说明书是零联网耗时的兜底。
  const label = caseState ? findLocalPatentMedicineLabel(proposal.name) : undefined;
  if (label && caseState && !/注射/.test(label.name) &&
      medicineProblemMatchesCase(proposal.correspondingProblem, compact(label.indication, 700))) {
    const [screened] = retrieveLocalPatentMedicineCandidates(caseState, 1, undefined, {
      entries: [label],
      idOffset: PLANNER_EXTRA_LOCAL_ID_OFFSET + 40 + index,
      requireConceptMatch: false,
    });
    if (screened) {
      return { candidate: localCandidateToProposal(screened), record: formatLocalPatentMedicineRecord(screened) };
    }
    // 本地说明书在，但被安全排除拦下：不再去 EviMed 绕过这个结论。
    return undefined;
  }
  // EviMed 兜底有时限：与西药检索并行，最多再等 AI_PATENT_EVIDENCE_BUDGET_MS，超时按核对不到处理，
  // 不拖长规划器（它在 M04 生成前的关键路径上）。
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    fetchExternalEvidence("instruction", proposal.name, { count: 6 }).catch(() => ({ list: [] as ExternalEvidenceItem[] })),
    new Promise<{ list: ExternalEvidenceItem[] }>((resolveBudget) => {
      budgetTimer = setTimeout(() => resolveBudget({ list: [] }), AI_PATENT_EVIDENCE_BUDGET_MS);
    }),
  ]).finally(() => { if (budgetTimer) clearTimeout(budgetTimer); });
  const item = result.list.find((candidate) => {
    const indication = compact(candidate.indication || candidate.summary, 500);
    return medicineNameMatches(proposal.name, candidate) &&
      !/注射/.test(candidate.medicineName || candidate.title || "") &&
      Boolean(candidate.fingerprint && indication) &&
      medicineProblemMatchesCase(proposal.correspondingProblem, indication);
  });
  if (!item) return undefined;
  const evidenceId = `EVID-INST-${String(201 + index).padStart(3, "0")}`;
  const record = formatInstructionEvidenceRecord(item, evidenceId);
  const candidate = externalCandidateToProposal(item, evidenceId, proposal.correspondingProblem, "中成药");
  if (!candidate) return undefined;
  if (!medicineEvidenceBindingValid(
    candidate.evidenceId,
    candidate.evidenceFingerprint,
    candidate.name,
    candidate.correspondingProblem,
    candidate.specification,
    buildEvidenceScope(record),
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
  // 库存只是参考（甲方 2026-09-28）：不在院内库存里的中成药/西药**不再删除**，院内有货的排前面，
  // 其余照常推荐、出方时标「库存外用药」。此前只同步了饮片的诊所（生产 105 份库存里 100 份）
  // 因为「中成药不在库存里」而拿不到任何中成药和西药推荐。
  const inventory = customerId ? await inventoryAvailabilityView(customerId) : undefined;
  const patentSynced = Boolean(inventory?.inventoryLoaded && inventory.coverage.patent === "synced");
  const inStock = (name: string, kind: "patent" | "western") =>
    Boolean(inventory?.inventoryLoaded && inventory.statusOf(name, kind).availability === "in_stock");

  // 病例检索前 10 名（编号 001–010，与 M04 证据段同一序列）+ 其后同一排序的非处方候选。
  // 本地检索每次约 0.1 秒 CPU（逐条匹配临床概念），所以前 10 名之外与处方目录只在用得上时才算：
  // 本院同步了中成药（补入院内有货的药）或模型提名了中成药（核对说明书）。
  let otcPool = retrieveLocalPatentMedicineCandidates(caseState, patentSynced ? 60 : 10);
  let rxPool: LocalPatentMedicineCandidate[] | undefined;
  const extendedPools = (): readonly (readonly LocalPatentMedicineCandidate[])[] => {
    if (otcPool.length <= 10) otcPool = retrieveLocalPatentMedicineCandidates(caseState, 60);
    rxPool ||= retrieveLocalPatentMedicineCandidates(caseState, 60, undefined, {
      entries: localPrescriptionPatentMedicineEntries(),
      idOffset: PLANNER_EXTRA_LOCAL_ID_OFFSET + 100,
    });
    return [otcPool, rxPool];
  };
  const baseCandidates = otcPool.slice(0, 10);
  const baseKeys = new Set(baseCandidates.map((item) => patentMedicineBaseName(item.name) || item.name));
  const inStockExtras: LocalPatentMedicineCandidate[] = [];
  if (patentSynced) {
    const [otc, rx] = extendedPools();
    for (const item of [...otc.slice(10), ...rx]) {
      if (inStockExtras.length >= IN_STOCK_EXTRA_LIMIT) break;
      const key = patentMedicineBaseName(item.name) || item.name;
      if (item.score < IN_STOCK_MIN_SCORE || baseKeys.has(key) || !inStock(item.name, "patent")) continue;
      baseKeys.add(key);
      inStockExtras.push({
        ...item,
        id: `LOCAL-INST-${String(PLANNER_EXTRA_LOCAL_ID_OFFSET + inStockExtras.length + 1).padStart(3, "0")}`,
      });
    }
  }
  const localCandidates = inStockFirst([...baseCandidates, ...inStockExtras], (item) => inStock(item.name, "patent"));
  // 院内状态只在本院同步了中成药时写给规划模型：没同步时每个候选都会显示「库存外用药」，
  // 本机 65 例实测模型因此几乎每例都另提中成药（46 次核对不到说明书），规划器中位耗时 +1.1 秒。
  const inventoryLabels = new Map(patentSynced ? localCandidates.flatMap((item) => {
    const label = inventoryLabelOf(inventory, item.name, "patent");
    return label ? [[item.id, label] as const] : [];
  }) : []);
  const rawSelection = await runPlannerModel(caseState, localCandidates, requestSignal, inventoryLabels);
  // 本地有候选时即便模型仍写了 patentMedicines 也不采用（与提示同一规则，确定性兜底）。
  const selection = rawSelection && localCandidates.length > 0 ? { ...rawSelection, patentMedicines: [] } : rawSelection;
  const selectedLocalIds = selection?.localEvidenceIds.length
    ? selection.localEvidenceIds
    : localCandidates.find((item) => item.score >= IN_STOCK_MIN_SCORE)
      ? [localCandidates.find((item) => item.score >= IN_STOCK_MIN_SCORE)!.id]
      : [];
  const selectedLocalCandidates = selectedLocalIds.flatMap((id) => {
    const candidate = localCandidates.find((item) => item.id === id);
    return candidate ? [candidate] : [];
  }).slice(0, 2);
  const selectedLocal = inStockFirst(selectedLocalCandidates, (item) => inStock(item.name, "patent"))
    .map((candidate) => ({
      candidate: localCandidateToProposal(candidate),
      // 规划器追加的候选（501 起）不在 M04 证据段的病例检索列表里，说明书条目随规划结果一并注入。
      record: Number(candidate.id.slice(-3)) > PLANNER_EXTRA_LOCAL_ID_OFFSET ? formatLocalPatentMedicineRecord(candidate) : undefined,
    }));

  const caseText = casePlanningText(caseState);
  const [resolvedWestern, resolvedPatent] = selection
    ? await Promise.all([
        Promise.all(selection.westernMedicines.map((item, index) => resolveWesternCandidate(item, index, caseText))),
        selection.patentMedicines.length > 0
          ? (() => {
              const pools = extendedPools();
              return Promise.all(selection.patentMedicines.map((item, index) =>
                resolveProposedPatentMedicine(item, index, caseText, pools, caseState)));
            })()
          : Promise.resolve([]),
      ])
    : [[], []];
  if (selection?.patentMedicines.length) {
    // 不含患者内容：AI 提名的中成药各有多少在本地目录、EviMed 核对到，多少核对不到（因此未采用）。
    const verified = resolvedPatent.filter((item): item is ResolvedPlannerMedicine => Boolean(item));
    console.info("[tcm-cdss:medicine-planner] ai_patent_proposals", {
      proposed: selection.patentMedicines.length,
      verifiedLocal: verified.filter((item) => item.candidate.evidenceId.startsWith("LOCAL-INST-")).length,
      verifiedEvimed: verified.filter((item) => item.candidate.evidenceId.startsWith("EVID-INST-")).length,
      unverified: selection.patentMedicines.length - verified.length,
    });
  }
  const aiPatent = resolvedPatent.filter((item): item is ResolvedPlannerMedicine => Boolean(item))
    .filter((item) => !selectedLocal.some((local) => local.candidate.name === item.candidate.name));
  const western = inStockFirst(
    resolvedWestern.filter((item): item is NonNullable<typeof item> => Boolean(item)),
    (item) => inStock(item.candidate.name, "western"),
  );
  const planned: ResolvedPlannerMedicine[] = [...selectedLocal, ...aiPatent, ...western].slice(0, 6);
  const candidates = planned.map((item) => item.candidate);
  const localRecords = planned.filter((item) => item.candidate.type === "中成药" && item.record && item.candidate.evidenceId.startsWith("LOCAL-INST-"))
    .map((item) => item.record as string);
  const externalRecords = (type: "西药" | "中成药") => planned
    .filter((item) => item.record && item.candidate.type === type && item.candidate.evidenceId.startsWith("EVID-INST-"))
    .map((item) => item.record as string);
  const westernRecords = externalRecords("西药");
  const aiPatentRecords = externalRecords("中成药");
  const evidenceContext = [
    localRecords.length > 0
      ? [
          "【规划器补充的中成药说明书（院内有货或 AI 提名后核对到的条目；不是自动处方）】",
          ...localRecords,
          "选择纪律：只能复制上方同一条目的药名、规格、ID和指纹；适应证必须覆盖本例当前阳性问题。",
        ].join("\n")
      : "",
    aiPatentRecords.length > 0
      ? [
          "【AI 提名中成药的说明书核对（EviMed；仅供医生讨论）】",
          ...aiPatentRecords,
          "选择纪律：这些条目已按药名精确检索并核对适应证与本例阳性问题；仍不形成剂量、频次或疗程医嘱。",
        ].join("\n")
      : "",
    westernRecords.length > 0
      ? [
          "【病例规划后的西药说明书精确检索（仅供医生讨论）】",
          ...westernRecords,
          "选择纪律：这些条目已按药名精确检索并核对适应证与本例阳性问题；仍不形成剂量、频次或疗程医嘱。",
        ].join("\n")
      : "",
  ].filter(Boolean).join("\n\n");
  return {
    candidates,
    evidenceContext,
    status: candidates.length > 0 ? "available" : selection ? "no_match" : "planner_unavailable",
  };
}

/** 测试用：AI 提名中成药的核对（本地说明书目录 → EviMed），不经规划模型。 */
export const medicinePlannerTestHooks = {
  resolveProposedPatentMedicine,
  retrieveCandidatePools(caseState: CaseState) {
    return [
      retrieveLocalPatentMedicineCandidates(caseState, 60),
      retrieveLocalPatentMedicineCandidates(caseState, 60, undefined, {
        entries: localPrescriptionPatentMedicineEntries(),
        idOffset: PLANNER_EXTRA_LOCAL_ID_OFFSET + 100,
      }),
    ] as const;
  },
};
