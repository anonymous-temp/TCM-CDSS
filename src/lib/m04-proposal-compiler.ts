import { z } from "zod";
import {
  normalizeModelNullableText,
  normalizePrescriptionRole,
  type ClinicalReasoningResultV2,
} from "./diagnosis-types";
import { sanitizeUnverifiedClinicalNarrative } from "./customer-evidence";
import { formulaStructureTarget, normalizeFormulaStructureRole } from "./herb-target-contract";
import { controlledCourseDays, controlledDoseCount, prescriptionRegimenIssue } from "./prescription-regimen-contract";
import { getTcmHerbDoseLimit, getTcmHerbGenerationSafetyProfile, governedHerbSubstitutes, isKnownTcmHerbName } from "./tcm-knowledge";
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";
import { TCM_TREATMENT_PROJECT_CODES } from "./tcm-treatment-projects";
import { compileTcmTreatmentRecommendations } from "./tcm-treatment-capabilities.server";
import {
  canonicalTcmHerbIdentity,
  highImpactHerbDirectionIssue,
} from "./diagnosis-stage-contract";
import { getM03TherapyLock } from "./m03-therapy-lock";
import { affirmedClinicalText, stripClinicalSectionLabel } from "./clinical-polarity";
import type { CaseState } from "./diagnosis-types";

const evidence = {
  evidenceLevel: "model_inference" as const,
  source: "基于本例证候、病机、治法与候选药味的配伍分析",
  confidence: "中" as const,
};

function compileHerbVerification(name: string): {
  verificationTier: "verified" | "unverified_dose" | "identity_pending" | "toxic_regulated";
  doseSource: "governed_boundary" | "classical_source" | "none";
  verificationReasons: string[];
  isToxic: boolean;
} {
  const identity = resolveGovernedTcmHerbIdentity(name);
  const canonicalName = identity.doseCanonicalName || identity.canonicalName;
  if (!canonicalName) {
    return {
      verificationTier: "identity_pending",
      doseSource: "none",
      verificationReasons: [
        identity.status === "ambiguous"
          ? `药味身份存在多个候选：${identity.candidates.join("、") || "待药师核定"}`
          : "药味身份尚未进入受治理标准名目录",
      ],
      isToxic: false,
    };
  }

  const doseLimit = getTcmHerbDoseLimit(canonicalName);
  const safety = getTcmHerbGenerationSafetyProfile(canonicalName);
  if (safety.isToxic) {
    return {
      verificationTier: "toxic_regulated",
      doseSource: doseLimit && !doseLimit.sourceConflict ? "governed_boundary" : "none",
      verificationReasons: [
        ...safety.toxicity.map((item) => `毒性提示：${item}`),
        ...(doseLimit?.sourceConflict ? ["剂量边界存在分用途冲突，需药师按实际用途复核"] : []),
      ].slice(0, 8),
      isToxic: true,
    };
  }

  if (!doseLimit || doseLimit.min == null || doseLimit.max == null || doseLimit.sourceConflict) {
    return {
      verificationTier: "unverified_dose",
      doseSource: "none",
      verificationReasons: [
        doseLimit?.sourceConflict
          ? "剂量边界存在分用途冲突，当前数值不能标为已核验"
          : "本地受治理知识库尚无完整数值型内服剂量边界",
      ],
      isToxic: false,
    };
  }

  return {
    verificationTier: "verified",
    doseSource: "governed_boundary",
    verificationReasons: [`受治理剂量边界 ${doseLimit.min}-${doseLimit.max}g 已用于生成后校验`],
    isToxic: false,
  };
}

function medicineEvidenceFromSource(source: string) {
  const clean = source.trim().slice(0, 800);
  const evidenceLevel = /\[(?:EVID-INST|OFFICIAL-CPM-GUIDE)-\d+\]|\[OFFICIAL-CPM-GUIDE\]|说明书/i.test(clean)
    ? "instruction" as const
    : /\[(?:LOCAL-INST|LABEL-NMPA)-\d+\]|药品标签|批准文号/i.test(clean)
      ? "drug_label" as const
      : /\[(?:EVID-GUIDE|OFFICIAL-[A-Z0-9_-]+)-\d+\]|\[OFFICIAL-[A-Z0-9_-]+\]|指南|共识/i.test(clean)
        ? "guideline" as const
        : /\[EVID-PAPER-\d+\]|DOI|PMID|文献|研究|系统评价/i.test(clean)
          ? "literature" as const
          : "insufficient" as const;
  return {
    evidenceLevel,
    source: evidenceLevel === "insufficient" ? "" : clean,
    confidence: evidenceLevel === "insufficient" ? "低" as const : "中" as const,
  };
}

// ─── 非药物调护「注意事项」的确定性归一与兜底 ──────────────────────────────────
// 这里替换了原先的 monitoring(metric/timing/trigger) 归一逻辑。合同层已不再对该字段产生任何
// 驳回码，因此本模块承担两件事：(1) 逐条清洗模型提交的自由文本，只丢行、绝不驳回整份提案；
// (2) 清洗后为空时用确定性兜底保证 UI / M05 永远有非空注意事项——这个「必有内容」的保证由
// 确定性代码提供，不由驳回码提供。

// 通用安全文案：不断言任何患者事实、不含任何剂量，因此不违反证据绑定基线。
const BASELINE_PRECAUTIONS = [
  "服药期间如出现皮疹、瘙痒、明显恶心呕吐、腹泻或心悸等新发不适，应立即停药并联系接诊医生。",
  "本方为本次辨证形成的候选方案，未经医生复核不得自行加量、延长疗程或转给他人服用。",
  "如同时在服用其他中药、中成药或西药，复诊时须携带完整用药清单交由医生核对。",
] as const;

// 放开自由文本会带来一个新风险：模型可能把剂量级指令（「不适时加服半剂」「再加茯苓10g」）
// 写进注意事项，从而绕过药味工作台与审方链路。这条正则把该风险重新关掉——命中即丢弃该行，
// 而不是驳回整份处方（fail-safe 而非 fail-closed 到不出方）。
/**
 * 面向患者/医生的**建议正文**里不得出现剂量写法——剂量是 M04 药味表与灵犀审方的职责。
 * 导出供 M05 随访撰写层复用：同一条「正文不得带剂量」的判据不该有第二份实现。
 */
export const PRECAUTION_DOSE_LIKE = /\d+(?:\.\d+)?\s*(?:g|克|mg|毫克|ml|毫升|片|粒|袋|丸|支)/i;
// 全串锚定，避免误伤「若症状加重请遵医嘱调整」这类正常句子——只有整行就是占位语时才丢弃。
// 允许一个字段名前缀：模型最常见的占位写法不是裸的「待补充」，而是「注意事项：待补充」。
// 原实现只列了裸占位词，而它们全部短于下面 6 字的长度下限、且长度检查先行，
// 于是这条正则实际上永远命中不到——一条给人以安全感的死规则。前缀分支把它救活。
const PRECAUTION_PLACEHOLDER = /^(?:注意事项|风险提示|注意|提示|其他)?[：:，,、]?\s*(?:待检索|待确认|待补充|待评估|待完善|证据不足|遵医嘱|按说明书|无特殊|暂无|不适用|无)[。.]?$/;

function normalizedPrecautionKey(value: string): string {
  return value.normalize("NFKC").replace(/[\s，,。；;：:、（）()【】\[\]“”"']+/g, "");
}

/** 逐条清洗模型提交的注意事项：只丢行、绝不驳回。 */
function normalizeSubmittedPrecautions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const text = sanitizeUnverifiedClinicalNarrative(raw).trim();
    if (text.length < 6 || text.length > 200) continue;
    if (PRECAUTION_DOSE_LIKE.test(text)) continue;
    if (PRECAUTION_PLACEHOLDER.test(text)) continue;
    const key = normalizedPrecautionKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
    if (kept.length >= 6) break;
  }
  return kept;
}

/** 从签名 M03 里取一个可用于纵向比较的患者事实锚点。 */
function priorFactAnchor(prior?: ClinicalReasoningResultV2 | null): string | undefined {
  if (!prior) return undefined;
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
  return [
    ...strings(prior.westernDiagnosis?.primary?.supportingFacts),
    ...strings(prior.overview?.primarySyndromeBasis),
    ...(Array.isArray(prior.pathogenesis?.chain)
      ? prior.pathogenesis.chain.flatMap((node) => strings([node.patientFact, node.syndromeEvidence]))
      : []),
  ].find((value) => {
    const clean = value.trim();
    return clean.length >= 2 && clean.length <= 240;
  })?.trim();
}

/** 确定性兜底：即便模型一条注意事项都没给出（或全被过滤），输出仍恒为非空。 */
function deterministicPrecautions(prior?: ClinicalReasoningResultV2 | null): string[] {
  const anchor = priorFactAnchor(prior)?.replace(/[。；;]+$/g, "");
  return [
    ...(anchor ? [`请留意${anchor}的变化；若明显加重或持续无改善，应提前复诊由医生复评。`] : []),
    ...BASELINE_PRECAUTIONS,
  ].slice(0, 6);
}

/** Coerce an unambiguous positive-integer regimen value (1, "1", "每日1剂", "一日2次", "2次/日")
 *  to a number; anything unclear returns undefined so the contract can fail closed. */
function coerceRegimenPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 30) return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const match = /^(?:每日|一日|每天|1日)?\s*([1-9]\d?)\s*(?:剂|次|遍|袋|包)?\s*(?:\/|每)?\s*(?:日|天)?$/.exec(text);
  if (!match) return undefined;
  const n = Number.parseInt(match[1], 10);
  return n >= 1 && n <= 30 ? n : undefined;
}

/** Providers often carry the frequency only inside the decoction method free text
 *  ("水煎服，每日1剂，早晚分2次温服"). When the structured dosesPerDay /
 *  administrationTimesPerDay fields are absent, extract the value from the model's own method
 *  text — deterministic extraction, never invention; no match means the contract still fails
 *  closed. */
function deriveRegimenFromMethodText(method: string | undefined): { dosesPerDay?: number; administrationTimesPerDay?: number } {
  if (!method) return {};
  const out: { dosesPerDay?: number; administrationTimesPerDay?: number } = {};
  const doses = /(?:每日|一日|每天|日)\s*([123一二三])\s*剂/.exec(method);
  if (doses) {
    const map: Record<string, number> = { "1": 1, "2": 2, "3": 3, 一: 1, 二: 2, 两: 2, 三: 3 } as never;
    out.dosesPerDay = map[doses[1]] ?? map[doses[1]?.replace("两", "二")];
  }
  const times = /(?:分\s*([123456两二三四五六])\s*次|早晚分服|分早晚(?:两次)?(?:温服|服用)?|([123456])\s*次分服)/.exec(method);
  if (times) {
    const raw = times[1] || times[2] || (times[0].includes("早晚") ? "2" : undefined);
    const map: Record<string, number> = { "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6 } as never;
    if (raw && map[raw]) out.administrationTimesPerDay = map[raw];
  }
  return out;
}

const PatentAndWesternProposalSchema = z.object({
  type: z.enum(["西药", "中成药"]),
  name: z.string().min(1).max(300),
  specification: z.preprocess(normalizeModelNullableText, z.string().max(300).nullable().optional()).transform((value) => value ?? null),
  singleDose: z.preprocess(normalizeModelNullableText, z.string().max(300).nullable().optional()).transform((value) => value ?? null),
  frequency: z.preprocess(normalizeModelNullableText, z.string().max(300).nullable().optional()).transform((value) => value ?? null),
  route: z.preprocess(normalizeModelNullableText, z.string().max(300).nullable().optional()).transform((value) => value ?? null),
  usageBoundary: z.string().min(1).max(800),
  course: z.preprocess(normalizeModelNullableText, z.string().max(500).nullable().optional()).transform((value) => value ?? null),
  positioning: z.enum(["联合治疗", "替代方案", "短期对症", "需医生评估"]),
  correspondingProblem: z.string().min(1).max(800),
  evidenceId: z.string().regex(/^(?:EVID|LOCAL)-INST-\d{3}$/),
  evidenceFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  evidenceSource: z.string().max(800).optional(),
  relationship: z.string().min(1).max(800),
  riskNote: z.string().min(1).max(1000),
});

const M04ProposalSchema = z.object({
  schemaVersion: z.literal("tcm-cdss-m04-proposal-v1"),
  candidate: z.object({
    name: z.string().min(1).max(300),
    therapyMatch: z.string().min(1).max(1200).optional(),
    applicable: z.string().min(1).max(1200).optional(),
    notApplicable: z.string().min(1).max(1200).optional(),
    herbs: z.array(z.object({
      name: z.string().min(1).max(120),
      processing: z.preprocess(normalizeModelNullableText, z.string().max(120).nullable()),
      dose: z.string().min(1).max(120),
      role: z.preprocess(normalizePrescriptionRole, z.enum(["君", "臣", "佐", "使"])),
      targetKind: z.enum(["pathogenesis_node", "formula_structure"]),
      targetRef: z.string().min(1).max(20),
      structureRole: z.enum(["middle_jiao_support", "harmonize", "guide", "temper"]).nullable().optional().transform((value) => value ?? null),
      isToxic: z.boolean().optional().catch(false),
      /**
       * 该药在本方中的作用（2026-08-11 线上实测补回）。
       *
       * 提示词模板一直在向模型要这个字段（diagnosis-prompts 的 `"function":"该药在本方中承担的具体作用"`），
       * 但 schema 从来没有声明它，zod 默认剥掉未声明键——模型写的方义被静默丢弃，
       * 编译器再无条件覆写成一句「由服务端知识库生成」。医生看到的就是这句零内容自述。
       * 要了又扔，是这条缺陷的全部成因。
       *
       * 补回它**不放宽任何证据边界**：模型文本仍要过 herbFunctionMatchesKnowledge——
       * 那正是合同层用的同一个导出谓词。最终交付值只有三种：过 KB 谓词的模型文本、
       * KB 对齐串、或修复耗尽后的受控角色兜底句。反而是今天在交付一句服务端自造、零证据的话。
       */
      function: z.string().min(2).max(300).optional(),
      decoctionRequirement: z.preprocess(
        normalizeModelNullableText,
        z.string().max(200).nullable().optional(),
      ).transform((value) => value ?? undefined),
    })).min(1).max(50),
    formulaAnalysis: z.string().min(1).max(4000).optional(),
    decoction: z.object({
      doseCount: z.string().min(1).max(120).refine((value) => controlledDoseCount(value) != null),
      dosesPerDay: z.number().int().min(1).max(3),
      administrationTimesPerDay: z.number().int().min(1).max(6),
      method: z.string().min(1).max(1000).optional(),
      course: z.string().min(1).max(1000).refine((value) => controlledCourseDays(value) != null),
      followUpNode: z.string().min(1).max(1000).optional(),
    }),
  }),
  patentAndWestern: z.array(PatentAndWesternProposalSchema).max(6).default([]),
  modifications: z.array(z.object({
    trigger: z.string().min(2).max(500),
    targetRef: z.string().regex(/^P\d{1,2}$/),
    actionType: z.enum(["add", "remove", "adjust"]),
    herbName: z.string().min(1).max(120),
    reason: z.string().min(2).max(800),
  })).max(4).default([]),
  modificationReview: z.object({
    submittedCount: z.number().int().min(0).max(30),
    retainedCount: z.number().int().min(0).max(30),
    droppedCount: z.number().int().min(0).max(30),
    droppedReason: z.string().max(1200).nullable(),
    droppedReasons: z.array(z.object({
      code: z.string().min(1).max(80),
      count: z.number().int().min(1).max(30),
      message: z.string().min(1).max(300),
    })).max(12),
  }).optional(),
  nonPharma: z.object({
    diet: z.string().min(1).max(1600),
    lifestyle: z.string().min(1).max(1600),
    emotion: z.string().min(1).max(1600),
    acupointCare: z.string().max(1600).nullable(),
    tcmTreatments: z.array(z.object({
      projectCode: z.enum(TCM_TREATMENT_PROJECT_CODES),
      targetRef: z.string().regex(/^P\d{1,2}$/),
    })).max(3).default([]),
    // 注意事项：无 min(1)、无 refine。归一化（normalizeSubmittedPrecautions）已经在 safeParse
    // 之前把非法行丢掉并截断到 6 条，所以这里的类型/长度错误实际不可达——即字段级驳回面为零。
    // 原先的 monitoring 是 .min(1) + 两条 refine，是「随访监测能单独打掉整份处方」的隐蔽入口
    // （zod 路径码 too_small_nonPharma_monitoring 同样没有修复引导语）。
    precautions: z.array(z.string().min(2).max(200)).max(6).default([]),
  }),
}).superRefine((proposal, context) => {
  const seenHerbs = new Map<string, number>();
  proposal.candidate.herbs.forEach((herb, index) => {
    const key = canonicalTcmHerbIdentity(herb.name);
    const firstIndex = seenHerbs.get(key);
    if (firstIndex != null) {
      context.addIssue({
        code: "custom",
        path: ["candidate", "herbs", index, "name"],
        message: `药味与第${firstIndex + 1}行属于同一知识库规范身份（含别名或同源炮制品），必须合并为一个明确剂量；当前协议未提供并列炮制品的结构化理由字段`,
      });
    } else {
      seenHerbs.set(key, index);
    }
  });
  if (proposal.candidate.decoction.administrationTimesPerDay < proposal.candidate.decoction.dosesPerDay) {
    context.addIssue({
      code: "custom",
      path: ["candidate", "decoction", "administrationTimesPerDay"],
      message: "每日分服次数不得少于每日剂数",
    });
  }
  if (prescriptionRegimenIssue(
    proposal.candidate.decoction.doseCount,
    proposal.candidate.decoction.course,
    proposal.candidate.decoction.dosesPerDay,
  ) === "course_inconsistent") {
    context.addIssue({
      code: "custom",
      path: ["candidate", "decoction", "course"],
      message: "总剂数必须等于每日剂数乘以疗程天数",
    });
  }
});

export type M04Proposal = z.infer<typeof M04ProposalSchema>;
export type EvidenceBoundMedicineProposal = M04Proposal["patentAndWestern"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unwrapSingleText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(value)) {
    return value.length === 1 ? unwrapSingleText(value[0]) : undefined;
  }
  if (!isRecord(value)) return undefined;
  const candidates = ["value", "text", "name", "label", "herbName", "formulaName", "nodeId", "targetRef", "ref", "id", "code"]
    .map((key) => unwrapSingleText(value[key]))
    .filter((item): item is string => Boolean(item));
  return new Set(candidates).size === 1 ? candidates[0] : undefined;
}

function normalizeDose(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return value;
  const amount = value.value ?? value.amount ?? value.dose;
  const unit = unwrapSingleText(value.unit ?? value.doseUnit);
  if (typeof amount === "string" && /\p{L}/u.test(amount)) return amount.trim();
  if ((typeof amount === "number" || (typeof amount === "string" && /^\d+(?:\.\d+)?$/.test(amount.trim()))) && unit) {
    return `${String(amount).trim()}${unit}`;
  }
  return value;
}

type RegimenQuantity = { amount?: string | number; unit?: string };

function unwrapRegimenQuantity(value: unknown, depth = 0): RegimenQuantity {
  if (depth > 4) return {};
  if (typeof value === "number" || typeof value === "string") return { amount: value };
  if (Array.isArray(value)) return value.length === 1 ? unwrapRegimenQuantity(value[0], depth + 1) : {};
  if (!isRecord(value)) return {};
  const unit = unwrapSingleText(
    value.unit ?? value.doseUnit ?? value.countUnit ?? value.durationUnit ?? value.unitLabel,
  );
  const rawAmount = value.value ?? value.data ?? value.amount ?? value.number ?? value.count ?? value.duration ?? value.text;
  const inner = unwrapRegimenQuantity(rawAmount, depth + 1);
  return { amount: inner.amount, unit: unit || inner.unit };
}

function normalizeBoundedCount(
  value: unknown,
  allowedUnits: readonly string[],
  maximumByUnit: Readonly<Record<string, number>>,
): unknown {
  const quantity = unwrapRegimenQuantity(value);
  let text = typeof quantity.amount === "string" ? quantity.amount.trim() : "";
  if (
    quantity.unit &&
    (typeof quantity.amount === "number" || (typeof quantity.amount === "string" && /^\d+(?:\.\d+)?$/.test(quantity.amount.trim())))
  ) {
    text = `${String(quantity.amount).trim()}${quantity.unit}`;
  }
  const compact = text.replace(/\s+/g, "");
  const unit = allowedUnits.find((candidate) => compact.endsWith(candidate));
  if (!unit) return value;
  const rawAmountText = compact.slice(0, -unit.length);
  const amountText = normalizeSmallChineseCount(rawAmountText) || rawAmountText;
  if (!/^\d+(?:\.\d+)?(?:[-至~～]\d+(?:\.\d+)?)?$/.test(amountText)) return value;
  const amounts = amountText.split(/[-至~～]/).map(Number);
  const maximum = maximumByUnit[unit];
  if (!amounts.every((amount) => Number.isFinite(amount) && amount > 0 && amount <= maximum)) return value;
  if (amounts.length === 2 && amounts[0] > amounts[1]) return value;
  return `${amountText}${unit}`;
}

function normalizeSmallChineseCount(value: string): string | undefined {
  if (/^\d+(?:\.\d+)?$/.test(value)) return value;
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value in digits) return String(digits[value]);
  if (value === "十") return "10";
  const teen = value.match(/^十([一二两三四五六七八九])$/);
  if (teen) return String(10 + digits[teen[1]]);
  const tens = value.match(/^([二两三])十([一二两三四五六七八九])?$/);
  if (tens) return String(digits[tens[1]] * 10 + (tens[2] ? digits[tens[2]] : 0));
  return undefined;
}

function normalizeUnitlessCount(value: unknown, unit: "剂" | "日", maximum: number): unknown {
  const raw = unwrapRegimenQuantity(value).amount;
  const token = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  const normalized = normalizeSmallChineseCount(token);
  if (!normalized) return value;
  const amount = Number(normalized);
  return Number.isInteger(amount) && amount > 0 && amount <= maximum ? `${amount}${unit}` : value;
}

function unwrapRegimenRecord(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 3) return undefined;
  if (Array.isArray(value)) return value.length === 1 ? unwrapRegimenRecord(value[0], depth + 1) : undefined;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      return unwrapRegimenRecord(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 1 && /^(?:value|data|regimen|decoction)$/.test(entries[0][0])) {
    return unwrapRegimenRecord(entries[0][1], depth + 1) || value;
  }
  return value;
}

function normalizeDoseCount(value: unknown): unknown {
  const normalized = normalizeBoundedCount(value, ["剂"], { 剂: 30 });
  return normalized === value ? normalizeUnitlessCount(value, "剂", 30) : normalized;
}

function normalizeCourse(value: unknown): unknown {
  const normalized = normalizeBoundedCount(value, ["日", "天", "周"], { 日: 90, 天: 90, 周: 12 });
  return normalized === value ? normalizeUnitlessCount(value, "日", 90) : normalized;
}

function normalizeModificationAction(value: unknown): "add" | "remove" | "adjust" | undefined {
  const raw = unwrapSingleText(value)?.toLowerCase().replace(/[\s_（）()【】\[\]:：-]/g, "");
  if (!raw) return undefined;
  if (/^(?:add|加|加入|添加|增加|增添|加味)$/.test(raw)) return "add";
  if (/^(?:remove|delete|减|减去|去除|删除|撤除|去掉)$/.test(raw)) return "remove";
  if (/^(?:adjust|调整|调量|调整剂量|增减剂量|剂量调整)$/.test(raw)) return "adjust";
  return undefined;
}

function normalizeModificationFact(value: string): string {
  return value
    .replace(/^(?:患者|主诉|现病史|问诊补充|当前|目前)[：:\s]*/g, "")
    .replace(/[\s，,。；;：:、（）()【】\[\]“”"']/g, "")
    .trim();
}

const MODIFICATION_FACT_CONCEPTS = [
  /失眠|不寐|入睡|夜醒|多梦|早醒/,
  /疼痛|头痛|胃痛|胃脘痛|腹痛|腰痛|膝痛|关节痛/,
  /乏力|疲乏|倦怠|没劲/,
  /心悸|心慌/,
  /咳嗽|咳痰|痰多/,
  /气短|气促|喘|呼吸困难/,
  /恶心|呕吐|反酸|烧心/,
  /腹泻|便溏|稀便/,
  /便秘|大便干|排便困难/,
  /头晕|眩晕/,
  /口干|口渴/,
  /怕冷|畏寒|恶寒/,
  /发热|发烧|身热/,
  /自汗|盗汗|出汗/,
  /水肿|浮肿/,
] as const;

/**
 * Modifications are current-visit symptom adjustments, not speculative future prescriptions.
 * The trigger therefore has to be a literal fact already signed by M03. This closes the whole
 * class of generic "复诊时若出现..." rows without trying to rewrite model prose into a fact.
 */
export function modificationTriggerGroundedInM03(
  trigger: string,
  prior?: ClinicalReasoningResultV2 | null,
): boolean {
  return Boolean(resolveModificationTriggerSource(trigger, prior));
}

export type ModificationTriggerSource = {
  kind: "primary_syndrome_basis" | "pathogenesis_patient_fact" | "western_supporting_fact";
  sourceRef: string;
  sourceQuote: string;
};

export function resolveModificationTriggerSource(
  trigger: string,
  prior?: ClinicalReasoningResultV2 | null,
): ModificationTriggerSource | undefined {
  if (!prior || prior.stage !== "diagnose") return undefined;
  if (/(?:^|[，,；;])\s*(?:若|如|当|一旦)|复诊时|接诊时核实|症状变化时|出现时|加重时|未缓解时|以后出现/.test(trigger)) {
    return undefined;
  }
  const normalizedTrigger = normalizeModificationFact(trigger);
  if (normalizedTrigger.length < 2) return undefined;
  const anchors: ModificationTriggerSource[] = [
    ...(prior.overview.primarySyndromeBasis || []).map((sourceQuote, index) => ({
      kind: "primary_syndrome_basis" as const,
      sourceRef: `overview.primarySyndromeBasis[${index}]`,
      sourceQuote,
    })),
    ...prior.pathogenesis.chain.map((node, index) => ({
      kind: "pathogenesis_patient_fact" as const,
      sourceRef: `pathogenesis.chain[${index}].patientFact${node.nodeId ? `:${node.nodeId}` : ""}`,
      sourceQuote: node.patientFact,
    })),
    ...(prior.westernDiagnosis.primary.supportingFacts || []).map((sourceQuote, index) => ({
      kind: "western_supporting_fact" as const,
      sourceRef: `westernDiagnosis.primary.supportingFacts[${index}]`,
      sourceQuote,
    })),
  ].filter((item) => typeof item.sourceQuote === "string" && Boolean(item.sourceQuote.trim()));
  return anchors.find((anchor) => {
    const normalizedAnchor = normalizeModificationFact(anchor.sourceQuote);
    return normalizedAnchor.length >= 2 &&
      (normalizedTrigger.includes(normalizedAnchor) || normalizedAnchor.includes(normalizedTrigger));
  }) || anchors.find((anchor) =>
    MODIFICATION_FACT_CONCEPTS.some((concept) =>
      concept.test(trigger) && concept.test(anchor.sourceQuote)));
}

type ModificationDropCode =
  | "malformed"
  | "contains_unaudited_dose"
  | "trigger_not_current_fact"
  | "unknown_herb"
  | "invalid_target"
  | "action_conflicts_with_candidate"
  | "bounded_limit"
  | "direction_conflict";

const MODIFICATION_DROP_MESSAGES: Readonly<Record<ModificationDropCode, string>> = {
  malformed: "条目缺少触发事实、病机引用、动作、药名或理由",
  contains_unaudited_dose: "条件性加减夹带了未经审方的具体剂量",
  trigger_not_current_fact: "触发条件不能回溯到本次病历已确认的当前事实",
  unknown_herb: "该药味不在中药知识库收录范围",
  invalid_target: "所引病机不属于本次已确认的病机",
  action_conflicts_with_candidate: "增减动作与当前处方药味状态冲突",
  bounded_limit: "超过单次最多展示 4 条随症加减的安全边界",
  direction_conflict: "拟加药味与已锁定病机或治法方向冲突",
};

/** 与 diagnosis-types.ts modificationReview.submittedCount 的 `.max(30)` 同源（该字段无 catch，超限即整份拒收）。 */
const MODIFICATION_REVIEW_COUNT_LIMIT = 30;

type ModificationNormalization = {
  items: unknown[];
  submittedCount: number;
  droppedReasons: ModificationDropCode[];
};

function normalizeModifications(
  value: unknown,
  prior?: ClinicalReasoningResultV2 | null,
  prescribedHerbNames: ReadonlySet<string> = new Set(),
): ModificationNormalization {
  if (!Array.isArray(value)) return { items: [], submittedCount: 0, droppedReasons: [] };
  const governedNodeIds = new Set(
    prior?.stage === "diagnose"
      ? prior.pathogenesis.chain.map((node) => node.nodeId).filter(Boolean)
      : [],
  );
  const droppedReasons: ModificationDropCode[] = [];
  const normalizedItems = value.flatMap((item) => {
    const drop = (reason: ModificationDropCode) => {
      droppedReasons.push(reason);
      return [];
    };
    if (!isRecord(item)) return drop("malformed");
    const actionType = normalizeModificationAction(item.actionType ?? item.action ?? item["动作"]);
    const trigger = unwrapSingleText(item.trigger ?? item["触发条件"]);
    const targetRef = unwrapSingleText(item.targetRef ?? item["病机引用"]);
    const herbName = unwrapSingleText(item.herbName ?? item.herb ?? item["药名"]);
    const reason = unwrapSingleText(item.reason ?? item["理由"]);
    // Conditional modifications are optional decision support. A malformed optional row must not
    // invalidate an otherwise complete core prescription, but no missing field may be invented.
    const doseBearingText = [trigger, herbName, reason].filter(Boolean).join("；");
    if (!actionType || !trigger || !targetRef || !herbName || !reason) return drop("malformed");
    if (/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半]+)\s*(?:mg|g|毫克|克)(?!\s*\/\s*(?:L|升))/i.test(doseBearingText)) {
      return drop("contains_unaudited_dose");
    }
    if (!modificationTriggerGroundedInM03(trigger, prior)) return drop("trigger_not_current_fact");
    const normalizedHerbName = canonicalTcmHerbIdentity(herbName.trim());
    // 随症加减是可选决策支持，不能让一条模型臆造的药味、病机引用或动作拖垮
    // 已通过核心契约的候选处方。服务端只保留知识库可识别且与当前上下文一致的行。
    if (!isKnownTcmHerbName(normalizedHerbName)) return drop("unknown_herb");
    if (governedNodeIds.size > 0 && !governedNodeIds.has(targetRef)) return drop("invalid_target");
    const herbIdentity = canonicalTcmHerbIdentity(normalizedHerbName);
    if (["remove", "adjust"].includes(actionType) && !prescribedHerbNames.has(herbIdentity)) return drop("action_conflicts_with_candidate");
    if (actionType === "add" && prescribedHerbNames.has(herbIdentity)) return drop("action_conflicts_with_candidate");
    return [{ ...item, trigger, targetRef, actionType, herbName: normalizedHerbName, reason }];
  });
  if (normalizedItems.length > 4) {
    droppedReasons.push(...Array.from(
      { length: normalizedItems.length - 4 },
      () => "bounded_limit" as const,
    ));
  }
  const items = normalizedItems.slice(0, 4);
  // 钳到契约上限：submittedCount 的 `.max(30)` 没有 catch，31 条**可选**随症加减会让整份
  // M04 提案落到 T1 硬拒且无修复引导——直接违反本文件上方写下的不变量（畸形的可选行不得
  // 作废一份完整的核心处方）。真实提交量另走日志，不进契约。
  return { items, submittedCount: Math.min(value.length, MODIFICATION_REVIEW_COUNT_LIMIT), droppedReasons };
}

function summarizeModificationReview(
  submittedCount: number,
  retainedCount: number,
  reasons: ModificationDropCode[],
) {
  const grouped = [...new Set(reasons)].map((code) => ({
    code,
    count: reasons.filter((reason) => reason === code).length,
    message: MODIFICATION_DROP_MESSAGES[code],
  }));
  return {
    submittedCount,
    retainedCount,
    droppedCount: Math.max(0, submittedCount - retainedCount),
    droppedReason: grouped.length > 0
      ? grouped.map((item) => `${item.message}${item.count > 1 ? `（${item.count}条）` : ""}`).join("；")
      : null,
    droppedReasons: grouped,
  };
}

function trustedCandidateName(
  prior: ClinicalReasoningResultV2 | null | undefined,
  proposedName?: string,
): string | undefined {
  if (!prior || prior.stage !== "diagnose") return undefined;
  if (["self_devised", "none"].includes(prior.overview.formulaSelectionMode || "none")) {
    return "本例辨证组方";
  }
  const names = Array.from(new Set((prior.overview.recommendedFormulaNames || [])
    .map((name) => name.trim())
    .filter(Boolean)));
  if (names.length > 0) {
    const base = prior.overview.formulaSelectionMode === "combined" && names.length > 1
      ? names.join("合")
      : prior.overview.formulaSelectionMode === "alternatives"
        ? names.find((name) => proposedName?.includes(name)) || names[0]
        : names[0];
    return /加减$/.test(base) ? base : `${base}加减`;
  }
  const direction = prior.overview.recommendedFormulaDirection?.trim();
  return direction || undefined;
}

function normalizeHerb(
  value: unknown,
  fallbackName?: string,
): unknown {
  if (!isRecord(value)) return value;
  const herb = { ...value };
  const rawName = unwrapSingleText(herb.name ?? herb.herbName ?? herb["药名"]) || fallbackName;
  if (rawName) {
    const operation = /^(?:生|制|炒|麸炒|土炒|米炒|蜜炙|炙|醋制|酒制|盐制|姜制|醋炒|酒炒|盐炒|姜炒|煅|炮|炒炭|煅炭|切片|去粗皮|去皮|去心|去芦|去核|擘|捣碎|打碎|研碎|劈开|捣碎后同煎|打碎后同煎|先煎|久煎|后下|包煎|另煎|另炖|烊化|冲服|兑服|同煎|禁止同煎)$/;
    const parentheticalGroups = Array.from(rawName.matchAll(/[（(]([^（）()]{1,30})[）)]/g), (match) => match[1].trim());
    const parentheticalOperations = parentheticalGroups.flatMap((group) => group.split(/[、，,；;]|或(?=另煎|另炖|后下|冲服)/).map((item) => item.trim()).filter(Boolean));
    const withoutParentheses = rawName.replace(/[（(][^（）()]{1,30}[）)]/g, "").trim();
    const suffix = withoutParentheses.match(/(捣碎后同煎|打碎后同煎|禁止同煎|先煎|久煎|后下|包煎|另煎|另炖|烊化|冲服|兑服)$/)?.[1];
    const operationalAnnotations = [...parentheticalOperations, ...(suffix ? [suffix] : [])];
    const annotationsAreControlled = operationalAnnotations.length > 0 &&
      parentheticalOperations.every((item) => operation.test(item));
    if (annotationsAreControlled) {
      herb.name = (suffix ? withoutParentheses.slice(0, -suffix.length) : withoutParentheses).trim();
      const processingAnnotations = operationalAnnotations.filter((item) => /^(?:生|制|炒|麸炒|土炒|蜜炙|炙|醋制|酒制|盐制|姜制|煅|捣碎|打碎|研碎|劈开)/.test(item));
      const decoctionAnnotations = operationalAnnotations.filter((item) => /(?:先煎|久煎|后下|包煎|另煎|另炖|烊化|冲服|兑服|同煎)/.test(item));
      if (!herb.processing && processingAnnotations.length > 0) herb.processing = [...new Set(processingAnnotations)].join("、");
      if (!herb.decoctionRequirement && decoctionAnnotations.length > 0) herb.decoctionRequirement = [...new Set(decoctionAnnotations)].join("、");
    } else {
      herb.name = rawName;
    }

    const currentName = typeof herb.name === "string" ? herb.name.trim() : "";
    if (currentName && !isKnownTcmHerbName(currentName)) {
      const prefixPattern = /^(麸炒|土炒|米炒|蜜炙|醋制|酒制|盐制|姜制|醋炒|酒炒|盐炒|姜炒|炒|炙|制|煅|炮|焦|生)(.+)$/;
      const suffixPattern = /^(.{2,})(炒炭|煅炭|炭)$/;
      const prefixed = currentName.match(prefixPattern);
      const suffixed = currentName.match(suffixPattern);
      const baseName = prefixed?.[2]?.trim() || suffixed?.[1]?.trim() || "";
      const processingName = prefixed?.[1] || suffixed?.[2] || "";
      if (baseName && processingName && isKnownTcmHerbName(baseName)) {
        herb.name = baseName;
        const existing = unwrapSingleText(herb.processing ?? herb["炮制"] ?? herb["规格"]);
        herb.processing = [...new Set([existing, processingName].filter((item): item is string => Boolean(item)))].join("、");
      }
    }
    const normalizedCurrentName = typeof herb.name === "string" ? herb.name.trim() : "";
    const canonicalName = canonicalTcmHerbIdentity(normalizedCurrentName);
    if (canonicalName && isKnownTcmHerbName(canonicalName)) {
      if (canonicalName !== normalizedCurrentName) {
        const processingPrefix = normalizedCurrentName.match(/^(蜜炙|麸炒|土炒|米炒|醋制|酒制|盐制|姜制|醋炒|酒炒|盐炒|姜炒|炒|炙|制|煅|炮|焦)(.+)$/)?.[1];
        if (processingPrefix) {
          const existing = unwrapSingleText(herb.processing ?? herb["炮制"] ?? herb["规格"]);
          herb.processing = [...new Set([existing, processingPrefix].filter((item): item is string => Boolean(item)))].join("、");
        }
      }
      herb.name = canonicalName;
    }
  }
  herb.dose = normalizeDose(herb.dose ?? herb["剂量"]);

  const processing = unwrapSingleText(herb.processing ?? herb["炮制"] ?? herb["规格"]);
  if (processing) herb.processing = processing;
  const role = unwrapSingleText(herb.role ?? herb["君臣佐使"]);
  if (role) {
    const canonical = normalizePrescriptionRole(role);
    if (["君", "臣", "佐", "使"].includes(String(canonical))) {
      herb.role = canonical;
    } else {
      const compact = role.toLowerCase().replace(/[\s（）()\[\]【】_:：-]/g, "").replaceAll("药", "");
      const aliases: Array<[RegExp, "君" | "臣" | "佐" | "使"]> = [
        [/^(?:主|核心|首要|monarch|chief|principal)$/, "君"],
        [/^(?:辅|重要辅助|minister|deputy)$/, "臣"],
        [/^(?:协助|佐助|assistant|adjunct)$/, "佐"],
        [/^(?:引经|调和|envoy|guide)$/, "使"],
      ];
      const matched = aliases.find(([pattern]) => pattern.test(compact));
      if (matched) herb.role = matched[1];
    }
  }
  const decoctionRequirement = unwrapSingleText(herb.decoctionRequirement ?? herb["煎法"]);
  if (decoctionRequirement) herb.decoctionRequirement = decoctionRequirement;
  const rawTargetKind = unwrapSingleText(herb.targetKind ?? herb["靶点类型"]);
  if (rawTargetKind) {
    const compactTargetKind = rawTargetKind.toLowerCase().replace(/[\s_-]/g, "");
    if (/^(?:pathogenesisnode|病机节点|病机)$/.test(compactTargetKind)) herb.targetKind = "pathogenesis_node";
    if (/^(?:formulastructure|方剂结构|组方结构)$/.test(compactTargetKind)) herb.targetKind = "formula_structure";
  }
  const targetRef = unwrapSingleText(herb.targetRef ?? herb["靶点引用"]);
  if (targetRef) herb.targetRef = targetRef;
  if (herb.targetKind === "pathogenesis_node") {
    // structureRole only describes controlled formula-structure support. It is inapplicable to a
    // pathogenesis-node herb, so explanatory provider text must not invalidate an otherwise safe row.
    herb.structureRole = null;
  } else if (herb.targetKind === "formula_structure") {
    // Preserve the submitted reference. Only the exact governed constant is valid; a contradictory
    // P-node or provider prose must reach semantic validation and trigger repair, never be silently
    // rewritten into a different clinical relationship.
    if (!herb.targetRef) herb.targetRef = "FORMULA_STRUCTURE";
    const structureRole = unwrapSingleText(herb.structureRole ?? herb["结构作用"]);
    const normalizedStructureRole = normalizeFormulaStructureRole(structureRole) ||
      (/^(?:佐|使)$/.test(String(herb.role || "")) ? "harmonize" : undefined);
    if (normalizedStructureRole) herb.structureRole = normalizedStructureRole;
  }
  return herb;
}

function normalizeHerbs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((herb) => normalizeHerb(herb));
  if (!isRecord(value)) return value;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 50) return value;
  return entries.map(([name, herb]) => normalizeHerb(herb, name));
}

function normalizeEmperorCardinality(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const emperorIndexes = value.flatMap((herb, index) =>
    isRecord(herb) && herb.role === "君" ? [index] : []
  );
  if (emperorIndexes.length <= 2) return value;
  // The provider already chose the medicines and their pathogenesis targets. Cardinality is a
  // redundant presentation invariant, so demote excess labels without adding/removing a medicine,
  // changing a dose, or retargeting clinical meaning. Only P1-targeted emperors may survive; if the
  // provider supplied no P1 emperor, retain the invalid result for targeted clinical repair.
  const primaryEmperorIndexes = emperorIndexes.filter((index) => {
    const herb = value[index];
    return isRecord(herb) && herb.targetKind === "pathogenesis_node" && herb.targetRef === "P1";
  });
  if (primaryEmperorIndexes.length === 0) return value;
  const retained = new Set(primaryEmperorIndexes.slice(0, 2));
  return value.map((herb, index) =>
    isRecord(herb) && herb.role === "君" && !retained.has(index)
      ? { ...herb, role: "臣" }
      : herb
  );
}

function normalizeM04ProposalInput(
  value: unknown,
  prior?: ClinicalReasoningResultV2 | null,
): unknown {
  if (!isRecord(value)) return value;
  if (value.schemaVersion != null && value.schemaVersion !== "tcm-cdss-m04-proposal-v1") return value;

  let rawCandidate = value.candidate;
  if (rawCandidate == null && Array.isArray(value.candidates) && value.candidates.length === 1) {
    rawCandidate = value.candidates[0];
  }
  if (rawCandidate == null && isRecord(value.candidates)) rawCandidate = value.candidates;
  if (rawCandidate == null && (value.name != null || value.formulaName != null) && (value.herbs != null || value.medicines != null)) {
    rawCandidate = value;
  }
  if (typeof rawCandidate === "string" && !rawCandidate.trim().startsWith("{") && (value.herbs != null || value.medicines != null)) {
    rawCandidate = { name: rawCandidate, herbs: value.herbs ?? value.medicines, decoction: value.decoction };
  }
  if (Array.isArray(rawCandidate)) {
    if (rawCandidate.length !== 1) return value;
    rawCandidate = rawCandidate[0];
  }
  if (typeof rawCandidate === "string" && rawCandidate.trim().startsWith("{")) {
    try {
      const nested = JSON.parse(rawCandidate);
      if (isRecord(nested)) rawCandidate = nested;
    } catch {
      return value;
    }
  }
  if (isRecord(rawCandidate)) {
    const entries = Object.entries(rawCandidate);
    const nestedEntry = entries.length === 1 && /^(?:0|value|data|proposal|candidate)$/.test(entries[0][0])
      ? entries[0][1]
      : undefined;
    if (isRecord(nestedEntry)) rawCandidate = nestedEntry;
  }
  if (!isRecord(rawCandidate)) return value;

  const candidate = { ...rawCandidate };
  const proposedName = unwrapSingleText(candidate.name ?? candidate.formulaName ?? candidate["方名"]);
  const lockedName = trustedCandidateName(prior, proposedName);
  if (lockedName || proposedName) candidate.name = lockedName || proposedName;
  candidate.herbs = normalizeEmperorCardinality(
    normalizeHerbs(candidate.herbs ?? candidate.medicines ?? candidate["药味"]),
  );

  const rawDecoction = unwrapRegimenRecord(candidate.decoction ?? candidate["煎服"]);
  const decoction = rawDecoction ? { ...rawDecoction } : {};
  const normalizedDoseCount = normalizeDoseCount(decoction.doseCount ?? decoction["剂数"]);
  const normalizedCourse = normalizeCourse(decoction.course ?? decoction["疗程"]);
  const doseCount = typeof normalizedDoseCount === "string"
    ? controlledDoseCount(normalizedDoseCount)
    : undefined;
  const courseDays = typeof normalizedCourse === "string"
    ? controlledCourseDays(normalizedCourse)
    : undefined;
  let dosesPerDay = coerceRegimenPositiveInt(decoction.dosesPerDay);
  if (dosesPerDay != null) decoction.dosesPerDay = dosesPerDay;
  const administrationTimesPerDay = coerceRegimenPositiveInt(decoction.administrationTimesPerDay);
  if (administrationTimesPerDay != null) decoction.administrationTimesPerDay = administrationTimesPerDay;
  // Structured frequency fields omitted by the provider but present in its own method free text
  // ("每日1剂，早晚分2次温服") are extracted deterministically; no invention, absence still
  // fails closed at the contract.
  if (decoction.dosesPerDay == null || decoction.administrationTimesPerDay == null) {
    const derived = deriveRegimenFromMethodText(unwrapSingleText(decoction.method ?? decoction["煎服法"] ?? decoction["方法"]));
    if (decoction.dosesPerDay == null && derived.dosesPerDay != null) {
      decoction.dosesPerDay = derived.dosesPerDay;
      dosesPerDay = derived.dosesPerDay;
    }
    if (decoction.administrationTimesPerDay == null && derived.administrationTimesPerDay != null) {
      decoction.administrationTimesPerDay = derived.administrationTimesPerDay;
    }
  }
  // Total doses and daily doses jointly determine the course. Do not invent either frequency
  // dimension; only canonicalize the redundant course when the submitted controlled values agree.
  if (doseCount != null && dosesPerDay != null && doseCount % dosesPerDay === 0) {
    decoction.doseCount = `${doseCount}剂`;
    decoction.course = `${doseCount / dosesPerDay}日`;
  } else if (courseDays != null && dosesPerDay != null && courseDays * dosesPerDay <= 30) {
    decoction.doseCount = `${courseDays * dosesPerDay}剂`;
    decoction.course = `${courseDays}日`;
  } else {
    decoction.doseCount = normalizedDoseCount;
    decoction.course = normalizedCourse;
  }
  // These fields are optional because the server owns their final canonical form. Providers
  // commonly wrap a scalar as { value: "..." } or ["..."]; normalize an unambiguous wrapper and
  // drop an empty/malformed optional value instead of rejecting an otherwise complete proposal.
  const method = unwrapSingleText(decoction.method ?? decoction["煎服法"] ?? decoction["方法"]);
  if (method) decoction.method = method;
  else delete decoction.method;
  const followUpNode = unwrapSingleText(decoction.followUpNode ?? decoction["复诊节点"] ?? decoction["随访节点"]);
  if (followUpNode) decoction.followUpNode = followUpNode;
  else delete decoction.followUpNode;
  candidate.decoction = decoction;

  const concreteMedicationValue = (item: unknown) => typeof item === "string" &&
    item.trim().length > 0 &&
    !/(?:按说明书|医生复核|医生评估|待确认|待核验|待检索|结合病情|另行确定)/.test(item);
  // Some providers preserve every required M04 sibling but accidentally place the three
  // proposal-level fields inside candidate after a targeted repair. Their names and ownership are
  // unambiguous, so lift only those exact fields without changing any clinical value. This is an
  // envelope canonicalization, not a safety relaxation; each lifted value still passes its normal
  // schema and semantic validation below.
  const rawPatentAndWestern = value.patentAndWestern ?? candidate.patentAndWestern;
  const rawModifications = value.modifications ?? candidate.modifications;
  const rawNonPharmaValue = value.nonPharma ?? candidate.nonPharma;
  const patentAndWestern = Array.isArray(rawPatentAndWestern)
    ? rawPatentAndWestern.flatMap((raw) => {
        if (!isRecord(raw)) return [];
        if (![raw.name, raw.evidenceId, raw.evidenceFingerprint, raw.correspondingProblem]
          .every(concreteMedicationValue)) return [];
        const parsed = PatentAndWesternProposalSchema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      }).slice(0, 6)
    : [];
  const prescribedHerbNames = new Set(
    Array.isArray(candidate.herbs)
      ? candidate.herbs.flatMap((herb) => isRecord(herb) && typeof herb.name === "string" ? [canonicalTcmHerbIdentity(herb.name)] : [])
      : [],
  );
  const modificationNormalization = normalizeModifications(rawModifications, prior, prescribedHerbNames);
  const modifications = modificationNormalization.items;
  const rawNonPharma = isRecord(rawNonPharmaValue) ? { ...rawNonPharmaValue } : rawNonPharmaValue;
  const nonPharma = isRecord(rawNonPharma)
    ? (() => {
        const submittedPrecautions = normalizeSubmittedPrecautions(rawNonPharma.precautions);
        const precautions = submittedPrecautions.length > 0
          ? submittedPrecautions
          : deterministicPrecautions(prior);
        return {
        ...rawNonPharma,
        acupointCare: null,
        // These are optional recommendations chosen from a server-owned catalog. Extra, repeated,
        // or malformed model rows must not invalidate an otherwise usable prescription.
        tcmTreatments: Array.isArray(rawNonPharma.tcmTreatments)
          ? [...new Map(rawNonPharma.tcmTreatments.flatMap((item) => {
              if (!isRecord(item)) return [];
              const projectCode = unwrapSingleText(item.projectCode ?? item.code);
              const targetRef = unwrapSingleText(item.targetRef ?? item.ref);
              if (!projectCode || !targetRef) return [];
              return [[`${projectCode}:${targetRef}`, { projectCode, targetRef }] as const];
            })).values()].slice(0, 3)
          : [],
        // 注意事项同样是「丢行不驳回」：过短/过长、含剂量级文字（避免自由文本变成绕过药味
        // 工作台与审方的剂量通道）、占位语和重复行逐条丢弃；全部被丢掉时用确定性兜底补齐，
        // 因此这个字段永远不可能让一份已通过核心契约的处方作废。哲学同上方 tcmTreatments。
        precautions,
      };
      })()
    : rawNonPharma;

  return {
    ...value,
    schemaVersion: "tcm-cdss-m04-proposal-v1",
    candidate,
    patentAndWestern,
    modifications,
    modificationReview: summarizeModificationReview(
      modificationNormalization.submittedCount,
      modifications.length,
      modificationNormalization.droppedReasons,
    ),
    nonPharma,
  };
}

function modificationIssue(proposal: M04Proposal, prior: ClinicalReasoningResultV2): string | undefined {
  const nodeIds = new Set(prior.pathogenesis.chain.map((node) => node.nodeId).filter(Boolean));
  const prescribed = new Set(proposal.candidate.herbs.map((herb) => canonicalTcmHerbIdentity(herb.name)));
  for (const [index, item] of proposal.modifications.entries()) {
    if (!nodeIds.has(item.targetRef)) return `modification_${index}_target`;
    if (!isKnownTcmHerbName(item.herbName.trim())) return `modification_${index}_unknown_herb`;
    const herbIdentity = canonicalTcmHerbIdentity(item.herbName);
    if (["remove", "adjust"].includes(item.actionType) && !prescribed.has(herbIdentity)) {
      return `modification_${index}_missing_herb`;
    }
    if (item.actionType === "add" && prescribed.has(herbIdentity)) {
      return `modification_${index}_duplicate_herb`;
    }
  }
  return undefined;
}

export function m04ProposalIssueCode(
  value: unknown,
  prior?: ClinicalReasoningResultV2 | null,
): string | undefined {
  const parsed = M04ProposalSchema.safeParse(normalizeM04ProposalInput(value, prior));
  if (parsed.success) return prior ? modificationIssue(parsed.data, prior) : undefined;
  const first = parsed.error.issues[0];
  const path = first.path.map((part) => String(part).replace(/[^a-zA-Z0-9_-]/g, "_")).join("_") || "root";
  return `${first.code}_${path}`.slice(0, 180);
}

function valueShape(value: unknown, depth = 0): string {
  if (depth > 3) return "nested";
  if (Array.isArray(value)) return `array(${value.length})<${value.length === 1 ? valueShape(value[0], depth + 1) : "multiple"}>`;
  if (!value || typeof value !== "object") return typeof value;
  const entries = Object.entries(value as Record<string, unknown>)
    .slice(0, 12)
    .map(([key, item]) => `${key}:${valueShape(item, depth + 1)}`);
  return `object{${entries.join(",")}}`;
}

/** Safe diagnostics for provider contract drift. Values are never logged, only types and keys. */
export function m04ProposalRegimenShape(value: unknown): { candidate: string; decoction: string; doseCount: string; course: string } {
  const root = isRecord(value) ? value : {};
  let candidateValue: unknown = root.candidate ?? root.candidates;
  if (Array.isArray(candidateValue) && candidateValue.length === 1) candidateValue = candidateValue[0];
  if (typeof candidateValue === "string" && candidateValue.trim().startsWith("{")) {
    try { candidateValue = JSON.parse(candidateValue); } catch { /* shape remains string */ }
  }
  const candidate = isRecord(candidateValue) ? candidateValue : {};
  let decoctionValue: unknown = candidate.decoction ?? candidate["煎服"];
  if (Array.isArray(decoctionValue) && decoctionValue.length === 1) decoctionValue = decoctionValue[0];
  if (typeof decoctionValue === "string" && decoctionValue.trim().startsWith("{")) {
    try { decoctionValue = JSON.parse(decoctionValue); } catch { /* shape remains string */ }
  }
  const decoction = isRecord(decoctionValue) ? decoctionValue : {};
  return {
    candidate: valueShape(candidateValue),
    decoction: valueShape(decoctionValue),
    doseCount: valueShape(decoction.doseCount ?? decoction["剂数"]),
    course: valueShape(decoction.course ?? decoction["疗程"]),
  };
}

/**
 * 中成药「对应问题」必须是**本例真有的问题**。
 *
 * 逐分句核：病历明确否认的分句直接丢弃；既不是已签名结论（主证候/西医主诊断）
 * 又在病历里找不到落点的分句同样丢弃——那是说明书主治被整段搬过来了。
 * 全部丢光时回落到已签名结论本身，而不是留一句听起来像临床判断的话。
 */
function chartGroundedCorrespondingProblem(
  value: string,
  caseState: CaseState | undefined,
  prior: ClinicalReasoningResultV2,
): string {
  const chart = [
    caseState?.chiefComplaint,
    ...Object.values(caseState?.symptoms || {}).map((item) => (typeof item === "string" ? item : "")),
    caseState?.pastHistory, caseState?.tongue, caseState?.pulse,
  ].filter((item): item is string => typeof item === "string" && Boolean(item.trim())).join("\n");
  const signed = [
    prior.overview?.primarySyndrome,
    prior.overview?.tcmDiseaseName,
    prior.westernDiagnosis?.primary?.name,
  ].filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  if (!chart.trim()) return value;
  // 只在病历的**阳性**部分找落点：病历写「否认咽痛」时，「咽痛」不该算本例的问题。
  // 这里必须用极性层，而不是判分句自身的极性——否定在病历那一侧，不在分句里。
  const affirmedChart = affirmedClinicalText(chart) || "";
  const kept = value
    .split(/[、，,；;]/)
    .map((clause) => stripClinicalSectionLabel(clause).trim())
    .filter(Boolean)
    .filter((clause) => {
      if (signed.some((item) => clause.includes(item) || item.includes(clause))) return true;
      // 说明书搬来的症状：病历阳性面里找不到任何 2 字落点即丢弃。
      for (let index = 0; index + 2 <= clause.length; index += 1) {
        const token = clause.slice(index, index + 2);
        if (affirmedChart.includes(token) && !/[的所致者与和及]/.test(token)) return true;
      }
      return false;
    });
  return kept.length > 0 ? kept.join("、") : (signed[0] || value);
}

export function compileM04Proposal(
  value: unknown,
  prior: ClinicalReasoningResultV2 | null | undefined,
  caseState?: CaseState,
  trustedMedicineCandidates: readonly EvidenceBoundMedicineProposal[] = [],
): ClinicalReasoningResultV2 | undefined {
  if (!prior || prior.stage !== "diagnose") return undefined;
  const parsed = M04ProposalSchema.safeParse(normalizeM04ProposalInput(value, prior));
  if (!parsed.success) return undefined;
  // Preserve the exact model proposal through compilation. Dose normalization may canonicalize
  // representation, but must never change the clinical value before the independent audit sees it.
  const trustedMedicines = trustedMedicineCandidates.flatMap((item) => {
    const checked = PatentAndWesternProposalSchema.safeParse(item);
    return checked.success ? [checked.data] : [];
  }).slice(0, 6);
  // Medicine discovery is a server-owned evidence plan. The generative M04 proposal may still
  // echo valid rows, but it cannot erase the independently retrieved plan or inject a different
  // drug. Merge by exact evidence identity before independent clinical review.
  const proposal = {
    ...parsed.data,
    patentAndWestern: [...new Map(
      [...parsed.data.patentAndWestern, ...trustedMedicines]
        .map((item) => [`${item.evidenceId}:${item.evidenceFingerprint}`, item] as const),
    ).values()].slice(0, 6),
  };
  if (modificationIssue(proposal, prior)) return undefined;
  const cleanNarrative = (value: string | undefined, fallback: string) =>
    sanitizeUnverifiedClinicalNarrative(value || "") || fallback;
  const compiledHerbs = proposal.candidate.herbs.map((herb) => {
    const node = herb.targetKind === "pathogenesis_node"
      ? prior.pathogenesis.chain.find((candidate) => candidate.nodeId === herb.targetRef)
      : undefined;
    const targetPathogenesis = node?.pathogenesis || node?.syndromeEvidence ||
      formulaStructureTarget(herb.structureRole) || herb.targetRef;
    const intendedTherapy = node?.therapyDirection || targetPathogenesis;
    const verification = compileHerbVerification(herb.name);
    return {
      ...herb,
      ...verification,
      isToxic: herb.isToxic === true || verification.isToxic,
      prescriptionRole: `${herb.role}药：${intendedTherapy}`,
      targetPathogenesis,
      // 不再无条件覆写成自述句：模型给了就用（下游 herbFunctionMatchesKnowledge 会核），
      // 没给就留空，交给 applyDeterministicHerbFunctions 用 KB 对齐串或受控兜底句补。
      function: (herb.function || "").trim(),
      evidence,
    };
  });
  const directionDropReasons: ModificationDropCode[] = [];
  // 替代药的排除基准是**本候选方的全部药味**：不得建议方里已有的药，也不得与方内任何一味相反相畏。
  const candidateHerbNames = compiledHerbs
    .map((herb) => (typeof herb.name === "string" ? herb.name.trim() : ""))
    .filter(Boolean);
  const compiledModifications = proposal.modifications.flatMap((item) => {
    const node = prior.pathogenesis.chain.find((candidate) => candidate.nodeId === item.targetRef);
    const declaredDirection = [item.reason, node?.therapyDirection, node?.pathogenesis]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .join("；");
    // A conditional add/remove row is optional decision support, not the current prescription.
    // Omit a row that conflicts with M03 instead of discarding the audited core prescription or
    // passing an unaudited hypothetical medicine downstream.
    if (item.actionType === "add" && highImpactHerbDirectionIssue(item.herbName, declaredDirection, prior)) {
      directionDropReasons.push("direction_conflict");
      return [];
    }
    const triggerSource = resolveModificationTriggerSource(item.trigger, prior);
    if (!triggerSource) {
      directionDropReasons.push("trigger_not_current_fact");
      return [];
    }
    const actionVerb = item.actionType === "add" ? "加" : item.actionType === "remove" ? "减" : "调整";
    // 可替换药味（甲方 2026-08-05）。**只对 add 行给**：remove/adjust 针对的是现方已有药味，
    // 「替代」在那里没有语义。候选完全由受治理数据确定性推导（同功效分类 + 药典剂量边界 +
    // 十八反十九畏排除），模型不参与——让模型提名替代药等于让它开药。
    const substitutions = item.actionType === "add"
      ? governedHerbSubstitutes(item.herbName, candidateHerbNames)
      : [];
    return [{
      trigger: item.trigger,
      triggerSource,
      targetPathogenesis: node?.pathogenesis || node?.syndromeEvidence || item.targetRef,
      action: `${actionVerb}${item.herbName.trim()}`,
      doseOrHandling: null,
      reason: cleanNarrative(item.reason, "随证调整治疗重点"),
      riskNote: "实际采用时请在药味工作台确定剂量，并按调整后的完整处方重新审方。",
      ...(substitutions.length > 0 ? { substitutions } : {}),
      evidence: {
        evidenceLevel: "model_inference" as const,
        source: `患者事实（${triggerSource.sourceRef}）：${triggerSource.sourceQuote}；对应病机节点：${item.targetRef}`,
        confidence: "中" as const,
      },
    }];
  });
  const m03FormulaNames = Array.isArray(prior.overview.recommendedFormulaNames)
    ? prior.overview.recommendedFormulaNames.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
    : [];
  const selfDevisedFromM03 = m03FormulaNames.length === 0 || ["none", "self_devised"].includes(String(prior.overview.formulaSelectionMode || ""));
  return {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    completeness: prior.completeness,
    overview: prior.overview,
    westernDiagnosis: prior.westernDiagnosis,
    pathogenesis: prior.pathogenesis,
    therapy: prior.therapy,
    formula: {
      candidates: [{
        name: proposal.candidate.name,
        formulaNames: [],
        positioning: "首选",
        formulaSource: evidence,
        // M03 owns the treatment direction. M04 may select medicines but cannot rewrite that lock
        // through a free-text therapyMatch field.
        therapyMatch: getM03TherapyLock(prior).candidateMatch,
        applicable: cleanNarrative(
          proposal.candidate.applicable,
          selfDevisedFromM03
            ? "经典方主治与本例当前阳性事实及核心病机未形成完整匹配，故按已锁定病机与治法辨证组方。"
            : `适用于与本例锁定证候“${prior.overview.primarySyndrome}”及病机链一致的情况。`,
        ),
        notApplicable: cleanNarrative(proposal.candidate.notApplicable, "证候、病机、舌脉或安全边界变化时暂停采用，并重新辨证。"),
        herbs: compiledHerbs,
        formulaAnalysis: cleanNarrative(proposal.candidate.formulaAnalysis, "依据最终药味、君臣佐使与对应病机生成。"),
        decoction: {
          ...proposal.candidate.decoction,
          method: proposal.candidate.decoction.method || "由服务端生成",
          followUpNode: proposal.candidate.decoction.followUpNode || "由服务端生成",
        },
      }],
      patentAndWestern: proposal.patentAndWestern.length > 0
        ? proposal.patentAndWestern.map((item) => ({
            type: item.type,
            name: item.name,
            specification: item.specification,
            evidenceId: item.evidenceId,
            evidenceFingerprint: item.evidenceFingerprint,
            recommendationMode: item.type === "西药" ? "discussion_only" as const : "candidate_review" as const,
            // EviMed's current instruction summary may not return a complete executable regimen.
            // Keep both categories non-dose until every regimen field can be bound to the same
            // fingerprint; western medicines are explicitly discussion-only in this release.
            singleDose: undefined,
            frequency: undefined,
            route: undefined,
            usageBoundary: item.type === "西药"
              ? "仅供与接诊医生讨论，不构成处方或剂量建议。"
              : cleanNarrative(item.usageBoundary, "仅作有说明书依据的候选，具体用法须依据完整说明书和医生评估。"),
            course: "本候选不形成疗程医嘱",
            positioning: item.positioning,
            // 「对应问题」讲的是**这位病人的问题**，必须对着病历核，不能只对着说明书核。
            // 原实现只在 evidence-source-validation 里校验它是否落在说明书的适应证段内，
            // 于是模型把说明书主治整段抄过来也能通过——甲方实测：病人没有黄痰、没有咽痛，
            // 中成药那一行的「对应问题」却写着「风热犯肺所致咳嗽、咳黄痰、咽痛」。
            // 说明书核验保留（那是绑定真实条目的凭据），这里再加一道**病历核验**。
            correspondingProblem: chartGroundedCorrespondingProblem(
              cleanNarrative(item.correspondingProblem, "对应本例现代医学诊断倾向"),
              caseState,
              prior,
            ),
            evidence: medicineEvidenceFromSource(`[${item.evidenceId}]`),
            relationship: cleanNarrative(item.relationship, "与中药饮片方案的联用或替代关系由医生确定"),
            riskNote: cleanNarrative(item.riskNote, "需复核禁忌、相互作用、重复用药和特殊人群风险"),
          }))
        : [],
      medicineCandidateStatus: proposal.patentAndWestern.length > 0
        ? { status: "available" as const, reason: "已形成与本例问题匹配并绑定真实说明书条目的候选。" }
        : { status: "no_evidence_match" as const, reason: "未检索到与本例诊断或证候匹配、且可核验到具体说明书条目的西药或中成药候选。" },
      modifications: compiledModifications,
      modificationReview: summarizeModificationReview(
        proposal.modificationReview?.submittedCount ?? proposal.modifications.length,
        compiledModifications.length,
        [
          ...((proposal.modificationReview?.droppedReasons || []).flatMap((item) =>
            Array.from({ length: item.count }, () => item.code as ModificationDropCode))),
          ...directionDropReasons,
        ],
      ),
    },
    nonPharma: {
      ...proposal.nonPharma,
      acupointCare: null,
      tcmTreatments: compileTcmTreatmentRecommendations(proposal.nonPharma.tcmTreatments, prior, caseState),
    },
    lineageAdaptation: prior.lineageAdaptation,
    management: prior.management,
  };
}

export function compileM04JsonObjectContent(
  content: string,
  prior: ClinicalReasoningResultV2 | null | undefined,
  caseState?: CaseState,
  trustedMedicineCandidates: readonly EvidenceBoundMedicineProposal[] = [],
): ClinicalReasoningResultV2 | undefined {
  try {
    const parsed = JSON.parse(content.trim()) as { schemaVersion?: unknown };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    // M04 is intentionally an untrusted, minimal proposal. Accepting a complete V2 object here
    // would let the provider replace M03-owned overview/pathogenesis/therapy fields and bypass the
    // server compiler. Legacy full-V2 responses must be regenerated through the proposal contract.
    return compileM04Proposal(parsed, prior, caseState, trustedMedicineCandidates);
  } catch {
    return undefined;
  }
}
