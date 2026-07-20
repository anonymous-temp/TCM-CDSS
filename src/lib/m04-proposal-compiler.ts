import { z } from "zod";
import {
  normalizeModelNullableText,
  normalizePrescriptionRole,
  type ClinicalReasoningResultV2,
} from "./diagnosis-types";
import { sanitizeUnverifiedClinicalNarrative } from "./customer-evidence";
import { formulaStructureTarget, normalizeFormulaStructureRole } from "./herb-target-contract";
import { controlledCourseDays, controlledDoseCount, prescriptionRegimenIssue } from "./prescription-regimen-contract";
import { isKnownTcmHerbName } from "./tcm-knowledge";
import { TCM_TREATMENT_PROJECT_CODES } from "./tcm-treatment-projects";
import { compileTcmTreatmentRecommendations } from "./tcm-treatment-capabilities.server";
import { canonicalTcmHerbIdentity, highImpactHerbDirectionIssue } from "./diagnosis-stage-contract";
import { getM03TherapyLock } from "./m03-therapy-lock";

const evidence = {
  evidenceLevel: "model_inference" as const,
  source: "基于本例证候、病机、治法与候选药味的配伍分析",
  confidence: "中" as const,
};

function medicineEvidenceFromSource(source: string) {
  const clean = source.trim().slice(0, 800);
  const evidenceLevel = /\[(?:EVID-INST|OFFICIAL-CPM-GUIDE)-\d+\]|\[OFFICIAL-CPM-GUIDE\]|说明书/i.test(clean)
    ? "instruction" as const
    : /\[LABEL-NMPA-\d+\]|药品标签|批准文号/i.test(clean)
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

const PatentAndWesternProposalSchema = z.object({
  type: z.enum(["西药", "中成药"]),
  name: z.string().min(1).max(300),
  specification: z.string().min(1).max(300),
  singleDose: z.string().min(1).max(300),
  frequency: z.string().min(1).max(300),
  route: z.string().min(1).max(300),
  usageBoundary: z.string().min(1).max(800),
  course: z.string().min(1).max(500),
  positioning: z.enum(["联合治疗", "替代方案", "短期对症", "需医生评估"]),
  correspondingProblem: z.string().min(1).max(800),
  evidenceSource: z.string().min(1).max(800),
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
      decoctionRequirement: z.preprocess(
        normalizeModelNullableText,
        z.string().max(200).nullable().optional(),
      ).transform((value) => value ?? undefined),
    })).min(1).max(50),
    formulaAnalysis: z.string().min(1).max(4000).optional(),
    decoction: z.object({
      doseCount: z.string().min(1).max(120).refine((value) => controlledDoseCount(value) != null),
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
  nonPharma: z.object({
    diet: z.string().min(1).max(1600),
    lifestyle: z.string().min(1).max(1600),
    emotion: z.string().min(1).max(1600),
    acupointCare: z.string().max(1600).nullable(),
    tcmTreatments: z.array(z.object({
      projectCode: z.enum(TCM_TREATMENT_PROJECT_CODES),
      targetRef: z.string().regex(/^P\d{1,2}$/),
    })).max(3).default([]),
    monitoring: z.array(z.object({
      metric: z.string().max(300),
      timing: z.string().max(300),
      trigger: z.string().max(600),
    })).min(1).max(20),
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
  if (prescriptionRegimenIssue(proposal.candidate.decoction.doseCount, proposal.candidate.decoction.course) === "course_inconsistent") {
    context.addIssue({
      code: "custom",
      path: ["candidate", "decoction", "course"],
      message: "每日1剂的剂数必须与疗程天数一致",
    });
  }
});

export type M04Proposal = z.infer<typeof M04ProposalSchema>;

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

function normalizeModifications(
  value: unknown,
  prior?: ClinicalReasoningResultV2 | null,
  prescribedHerbNames: ReadonlySet<string> = new Set(),
): unknown[] {
  if (!Array.isArray(value)) return [];
  const governedNodeIds = new Set(
    prior?.stage === "diagnose"
      ? prior.pathogenesis.chain.map((node) => node.nodeId).filter(Boolean)
      : [],
  );
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const actionType = normalizeModificationAction(item.actionType ?? item.action ?? item["动作"]);
    const trigger = unwrapSingleText(item.trigger ?? item["触发条件"]);
    const targetRef = unwrapSingleText(item.targetRef ?? item["病机引用"]);
    const herbName = unwrapSingleText(item.herbName ?? item.herb ?? item["药名"]);
    const reason = unwrapSingleText(item.reason ?? item["理由"]);
    // Conditional modifications are optional decision support. A malformed optional row must not
    // invalidate an otherwise complete core prescription, but no missing field may be invented.
    const doseBearingText = [trigger, herbName, reason].filter(Boolean).join("；");
    if (!actionType || !trigger || !targetRef || !herbName || !reason || /(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半]+)\s*(?:mg|g|毫克|克)(?!\s*\/\s*(?:L|升))/i.test(doseBearingText)) return [];
    const normalizedHerbName = canonicalTcmHerbIdentity(herbName.trim());
    // 随症加减是可选决策支持，不能让一条模型臆造的药味、病机引用或动作拖垮
    // 已通过核心契约的候选处方。服务端只保留知识库可识别且与当前上下文一致的行。
    if (!isKnownTcmHerbName(normalizedHerbName)) return [];
    if (governedNodeIds.size > 0 && !governedNodeIds.has(targetRef)) return [];
    const herbIdentity = canonicalTcmHerbIdentity(normalizedHerbName);
    if (["remove", "adjust"].includes(actionType) && !prescribedHerbNames.has(herbIdentity)) return [];
    if (actionType === "add" && prescribedHerbNames.has(herbIdentity)) return [];
    return [{ ...item, trigger, targetRef, actionType, herbName: normalizedHerbName, reason }];
  }).slice(0, 4);
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
  // The executable regimen is fixed at one dose per day, so dose count and course are one fact,
  // not two independent model decisions. Canonicalize the redundant field from whichever bounded
  // value the model supplied instead of retrying an otherwise valid prescription for prose such as
  // "五剂为一疗程". If both are present, dose count owns the executable duration.
  if (doseCount != null) {
    decoction.doseCount = `${doseCount}剂`;
    decoction.course = `${doseCount}日`;
  } else if (courseDays != null && courseDays <= 30) {
    decoction.doseCount = `${courseDays}剂`;
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
  const patentAndWestern = Array.isArray(value.patentAndWestern)
    ? value.patentAndWestern.flatMap((raw) => {
        if (!isRecord(raw)) return [];
        if (![raw.name, raw.specification, raw.singleDose, raw.frequency, raw.route, raw.course, raw.evidenceSource]
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
  const modifications = normalizeModifications(value.modifications, prior, prescribedHerbNames);
  const rawNonPharma = isRecord(value.nonPharma) ? { ...value.nonPharma } : value.nonPharma;
  const nonPharma = isRecord(rawNonPharma)
    ? {
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
        monitoring: Array.isArray(rawNonPharma.monitoring) ? rawNonPharma.monitoring.slice(0, 20) : rawNonPharma.monitoring,
      }
    : rawNonPharma;

  return {
    ...value,
    schemaVersion: "tcm-cdss-m04-proposal-v1",
    candidate,
    patentAndWestern,
    modifications,
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

export function compileM04Proposal(
  value: unknown,
  prior: ClinicalReasoningResultV2 | null | undefined,
): ClinicalReasoningResultV2 | undefined {
  if (!prior || prior.stage !== "diagnose") return undefined;
  const parsed = M04ProposalSchema.safeParse(normalizeM04ProposalInput(value, prior));
  if (!parsed.success) return undefined;
  // Preserve the exact model proposal through compilation. Dose normalization may canonicalize
  // representation, but must never change the clinical value before the independent audit sees it.
  const proposal = parsed.data;
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
    return {
      ...herb,
      prescriptionRole: `${herb.role}药：${intendedTherapy}`,
      targetPathogenesis,
      function: "由服务端知识库生成",
      evidence,
    };
  });
  const compiledModifications = proposal.modifications.flatMap((item) => {
    const node = prior.pathogenesis.chain.find((candidate) => candidate.nodeId === item.targetRef);
    const declaredDirection = [item.reason, node?.therapyDirection, node?.pathogenesis]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .join("；");
    // A conditional add/remove row is optional decision support, not the current prescription.
    // Omit a row that conflicts with M03 instead of discarding the audited core prescription or
    // passing an unaudited hypothetical medicine downstream.
    if (item.actionType === "add" && highImpactHerbDirectionIssue(item.herbName, declaredDirection, prior)) return [];
    const actionVerb = item.actionType === "add" ? "加" : item.actionType === "remove" ? "减" : "调整";
    return [{
      trigger: cleanNarrative(item.trigger, "症状或证候发生相应变化时"),
      targetPathogenesis: node?.pathogenesis || node?.syndromeEvidence || item.targetRef,
      action: `${actionVerb}${item.herbName.trim()}`,
      doseOrHandling: null,
      reason: cleanNarrative(item.reason, "随证调整治疗重点"),
      riskNote: "实际采用时请在药味工作台确定剂量，并按调整后的完整处方重新审方。",
      evidence,
    }];
  });
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
        applicable: cleanNarrative(proposal.candidate.applicable, `适用于与本例锁定证候“${prior.overview.primarySyndrome}”及病机链一致的情况。`),
        notApplicable: cleanNarrative(proposal.candidate.notApplicable, "证候、病机、舌脉或安全边界变化时暂停采用，并重新辨证。"),
        herbs: compiledHerbs,
        formulaAnalysis: cleanNarrative(proposal.candidate.formulaAnalysis, "由服务端按最终药味、君臣佐使和病机引用生成。"),
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
            singleDose: item.singleDose,
            frequency: item.frequency,
            route: item.route,
            usageBoundary: cleanNarrative(item.usageBoundary, "用法用量按说明书和医生复核"),
            course: cleanNarrative(item.course, "疗程由医生结合病情确定"),
            positioning: item.positioning,
            correspondingProblem: cleanNarrative(item.correspondingProblem, "对应本例现代医学诊断倾向"),
            evidence: medicineEvidenceFromSource(item.evidenceSource),
            relationship: cleanNarrative(item.relationship, "与中药饮片方案的联用或替代关系由医生确定"),
            riskNote: cleanNarrative(item.riskNote, "需复核禁忌、相互作用、重复用药和特殊人群风险"),
          }))
        : [],
      modifications: compiledModifications,
    },
    nonPharma: {
      ...proposal.nonPharma,
      acupointCare: null,
      tcmTreatments: compileTcmTreatmentRecommendations(proposal.nonPharma.tcmTreatments, prior),
    },
    lineageAdaptation: prior.lineageAdaptation,
    management: prior.management,
  };
}

export function compileM04JsonObjectContent(
  content: string,
  prior: ClinicalReasoningResultV2 | null | undefined,
): ClinicalReasoningResultV2 | undefined {
  try {
    const parsed = JSON.parse(content.trim()) as { schemaVersion?: unknown };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    // M04 is intentionally an untrusted, minimal proposal. Accepting a complete V2 object here
    // would let the provider replace M03-owned overview/pathogenesis/therapy fields and bypass the
    // server compiler. Legacy full-V2 responses must be regenerated through the proposal contract.
    return compileM04Proposal(parsed, prior);
  } catch {
    return undefined;
  }
}
