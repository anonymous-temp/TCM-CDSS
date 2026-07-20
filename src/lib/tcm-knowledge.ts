import knowledge from "../data/tcm-knowledge.json";
import herbFunctionCategories from "../data/tcm-herb-function-categories.json";
import type { CaseState } from "./diagnosis-types";

type KnowledgeEntry = {
  type: string;
  herb?: string;
  doseText?: string;
  minG?: number | null;
  maxG?: number | null;
  routeForm?: string;
  method?: string;
  methodCodes?: string;
  category?: string;
  formula?: string;
  leftDrug?: string;
  rightDrug?: string;
  severity?: string;
  population?: string;
  riskLevel?: string;
  quote?: string;
  allowedMethod?: string;
  wrongMethods?: string;
  riskCode?: string;
  riskName?: string;
  functionText?: string;
  primaryCategory?: string;
  secondaryCategory?: string;
  toxicity?: string;
  pregnancyRule?: string;
  lactationRule?: string;
  basis?: string;
  sourceUrl?: string;
  action?: string;
  note?: string;
  riskTags?: string[];
  methods?: string[];
};

type KnowledgeHerb = {
  name: string;
  aliases: string[];
  entries: KnowledgeEntry[];
};

type CommonHerb = {
  name: string;
  minG?: number | null;
  maxG?: number | null;
  methods?: string[];
  riskTags?: string[];
  basis?: string;
};

type PatentRisk = {
  productOrGroup: string;
  matchedHisDrugs: string;
  keyRiskFields: string;
  triggerCondition: string;
  severity: string;
  action: string;
  sourceIds: string;
};

type WesternInteraction = {
  ruleId: string;
  left: string;
  right: string;
  matchedLeft: string;
  matchedRight: string;
  condition: string;
  severity: string;
  action: string;
  sourceIds: string;
};

type CurrentMedicationConflict = {
  ruleId: string;
  ruleName: string;
  existingMedClass: string;
  newMedClass: string;
  existingExamples: string;
  newExamples: string;
  condition: string;
  severity: string;
  action: string;
  sourceIds: string;
};

type LabThreshold = {
  ruleId: string;
  domain: string;
  lab: string;
  normalizedLabCode: string;
  condition: string;
  operator: string;
  thresholdValue: string;
  thresholdUnit: string;
  severity: string;
  drugOrClass: string;
  representativeDrugs: string;
  action: string;
  missingLabPolicy: string;
  sourceIds: string;
  hisPriority: string;
};

type HisRouteDictionary = {
  hisValue: string;
  normalizedCode: string;
  valueType: string;
  routeClass: string;
  allowedContext: string;
  riskContext: string;
  frequencyPerDay: string;
  auditEffect: string;
  sourceBasis: string;
};

type HisSpecConversion = {
  category: string;
  queriedDrug: string;
  goodsName: string;
  goodsId: string;
  goodsSpec: string;
  goodsForm: string;
  defaultUse: string;
  defaultFrequency: string;
  strengthValue: string;
  strengthUnit: string;
  conversionStatus: string;
  ruleUse: string;
  remainingDataGaps: string;
};

type ClinicalStateRule = {
  stateCode: string;
  stateName: string;
  positiveTerms: string;
  negationTerms: string;
  temporalOrScopeTerms: string;
  triggerPolicy: string;
  defaultSeverity: string;
  sourceIds: string;
};

type HisTcmMapping = {
  queriedDrug: string;
  goodsName: string;
  goodsId: string;
  goodsSpec: string;
  goodsForm: string;
  mappedStandardNames: string;
  variants: string;
  status: string;
  priority: string;
  remainingDataGaps: string;
};

type KnowledgeData = {
  schemaVersion: string;
  generatedAt: string;
  summary: {
    herbCount: number;
    commonHerbCount: number;
    patentRiskCount: number;
    westernInteractionCount: number;
    currentMedicationConflictCount?: number;
    labThresholdCount?: number;
    hisRouteDictionaryCount?: number;
    hisSpecConversionCount?: number;
    clinicalStateDictionaryCount?: number;
    hisTcmMappingCount?: number;
  };
  herbs: KnowledgeHerb[];
  commonHerbs: CommonHerb[];
  patentRisks: PatentRisk[];
  westernInteractions: WesternInteraction[];
  currentMedicationConflicts?: CurrentMedicationConflict[];
  labThresholds?: LabThreshold[];
  hisSupport?: {
    routeDictionary: HisRouteDictionary[];
    specConversions: HisSpecConversion[];
    clinicalStateDictionary: ClinicalStateRule[];
    tcmMappings: HisTcmMapping[];
  };
  globalRules: string[];
};

export type TcmKnowledgeHit = {
  name: string;
  score: number;
  entries: KnowledgeEntry[];
};

export type PrescribedHerb = {
  name: string;
  dose: number | null;
  line: string;
};

const data = knowledge as KnowledgeData;
const herbNames = data.herbs.map((item) => item.name).filter(Boolean);
const herbNamesByLength = [...herbNames].sort((a, b) => b.length - a.length);
function normalizedHerbLookupToken(value: string): string {
  return value.replace(/[\s（）()]/g, "").replace(/(?:饮片|颗粒)$/g, "");
}

const canonicalHerbNameByToken = new Map<string, string>();
for (const item of data.herbs) {
  const parenthetical = Array.from(item.name.matchAll(/[（(]([^（）()]+)[）)]/g), (match) => match[1])
    .flatMap((value) => value.split(/[、，,；;\/]/).map((part) => part.trim()).filter(Boolean));
  const baseName = item.name.replace(/[（(][^（）()]+[）)]/g, "").trim();
  for (const variant of [item.name, baseName, ...parenthetical, ...item.aliases]) {
    const token = normalizedHerbLookupToken(variant);
    if (token && !canonicalHerbNameByToken.has(token)) canonicalHerbNameByToken.set(token, item.name);
  }
}
for (const item of data.commonHerbs) {
  const token = normalizedHerbLookupToken(item.name);
  if (token && !canonicalHerbNameByToken.has(token)) canonicalHerbNameByToken.set(token, item.name);
}

const CONTROLLED_HERB_ALIASES: Record<string, string> = {
  桂圆肉: "龙眼肉",
  黄耆: "黄芪",
  炒白术: "白术",
  麸炒白术: "白术",
  炒酸枣仁: "酸枣仁",
  制远志: "远志",
  蜜炙黄芪: "黄芪",
  炙黄芪: "黄芪",
  蜜炙甘草: "甘草",
  炙甘草: "甘草",
  夜交藤: "首乌藤",
  丹皮: "牡丹皮",
  生地: "生地黄",
  生地黄: "生地黄",
};
const CONTROLLED_HERB_DOSE_EQUIVALENTS: Record<string, { target: string; basis: string }> = {
  茯神: {
    target: "茯苓",
    basis: "茯神为带松根的茯苓部位，用量按茯苓现有知识边界复核",
  },
};
const CONTROLLED_EXACT_HERB_DOSE_LIMITS: Record<string, TcmHerbDoseLimit> = {
  // The shared 地黄 source row contains both 鲜地黄 12-30g and 生地黄 10-15g. Preserve the
  // explicit pharmacopoeia preparation boundary instead of inheriting the first range in that row.
  生地黄: { min: 10, max: 15, basis: "中华人民共和国药典：2020年版．一部（地黄条目：生地黄）", sourceType: "routeDose" },
};
const CONTROLLED_STANDALONE_HERBS = new Set(["茯神", "生地黄"]);
const CONTROLLED_HERB_FUNCTION_TEXT: Record<string, string> = {
  人参: "大补元气，复脉固脱，补脾益肺，生津养血，安神益智",
  黄芪: "补气升阳，固表止汗，利水消肿，生津养血，托毒排脓，敛疮生肌",
  白术: "健脾益气，燥湿利水，止汗，安胎",
  龙眼肉: "补益心脾，养血安神",
  木香: "行气止痛，健脾消食",
  甘草: "补脾益气，清热解毒，祛痰止咳，缓急止痛，调和诸药",
  酸枣仁: "养心补肝，宁心安神，敛汗生津",
  茯苓: "利水渗湿，健脾，宁心安神",
  远志: "安神益智，交通心肾，祛痰开窍",
  生姜: "解表散寒，温中止呕，温肺止咳，解毒，调和诸药",
  茯神: "宁心安神，利水渗湿",
  麦冬: "养阴生津，润肺清心",
  生地黄: "清热凉血，养阴生津",
};
const CONTROLLED_HERB_FUNCTION_CATEGORIES: Record<string, string[]> = {
  麦冬: ["补虚药", "补阴药"],
  // The source workbook records only the heat-clearing chapter for 生地黄. Its governed function
  // text also carries the standard 养阴生津 direction, so both directions must be queryable.
  生地黄: ["清热凉血药", "清热药", "补虚药", "补阴药"],
};

export function isKnownTcmHerbName(value: string): boolean {
  const normalized = normalizedHerbLookupToken(value);
  if (canonicalHerbNameByToken.has(normalized) || CONTROLLED_STANDALONE_HERBS.has(normalized)) return true;
  const controlled = CONTROLLED_HERB_ALIASES[normalized];
  if (controlled && canonicalHerbNameByToken.has(normalizedHerbLookupToken(controlled))) return true;
  const withoutProcessing = normalized.replace(/^(?:蜜炙|麸炒|土炒|炒|炙|醋制|酒制|盐制|姜制|煅|制|生)/, "");
  return withoutProcessing !== normalized && canonicalHerbNameByToken.has(withoutProcessing);
}

function stringifyClinicalValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function caseText(caseState: CaseState): string {
  return [
    caseState.hisRecord?.rawText,
    caseState.chiefComplaint,
    stringifyClinicalValue(caseState.symptoms),
    caseState.tongue,
    caseState.pulse,
    caseState.faceNote,
    stringifyClinicalValue(caseState.vitals),
    caseState.pastHistory,
    caseState.medicationHistory,
    caseState.allergyHistory,
    caseState.diagnosis,
    caseState.prescription,
    caseState.riskAssessment,
  ].filter(Boolean).join("\n");
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function extractKnownHerbNames(text: string, limit = 24): string[] {
  const normalized = text.replace(/\s+/g, "");
  const direct = herbNames.filter((name) => name.length >= 2 && normalized.includes(name));
  return unique(direct).slice(0, limit);
}

function scoreHerb(herb: KnowledgeHerb, query: string): number {
  const normalized = query.replace(/\s+/g, "");
  let score = 0;
  if (normalized.includes(herb.name)) score += 12;
  for (const entry of herb.entries) {
    const text = [
      entry.herb,
      entry.doseText,
      entry.category,
      entry.formula,
      entry.leftDrug,
      entry.rightDrug,
      entry.population,
      entry.riskLevel,
      entry.riskName,
      entry.primaryCategory,
      entry.secondaryCategory,
      entry.toxicity,
      entry.basis,
      entry.quote,
      entry.note,
    ].filter(Boolean).join(" ");
    if (text && normalized.includes(herb.name)) score += 2;
    for (const token of query.split(/[，,；;。.\s\n]+/).filter((item) => item.length >= 2)) {
      if (text.includes(token)) score += 1;
    }
  }
  return score;
}

function compactEntry(entry: KnowledgeEntry): string {
  if (entry.type === "dose" || entry.type === "curatedDose") {
    const range = entry.doseText || (
      entry.minG != null && entry.maxG != null ? `${entry.minG}-${entry.maxG}g` : ""
    );
    const method = entry.methods?.length ? `；煎服/方法：${entry.methods.join("、")}` : "";
    const tags = entry.riskTags?.length ? `；风险标签：${entry.riskTags.join("、")}` : "";
    return `剂量：${range || "待核验"}${method}${tags}；依据：${entry.basis || "药典/院内规则待核验"}`;
  }
  if (entry.type === "routeDose") {
    return `分途径剂量：${entry.routeForm || "未分型"}，${entry.doseText || "待核验"}；${entry.method || ""}；依据：${entry.basis || "待核验"}`;
  }
  if (entry.type === "incompatibility") {
    return `配伍禁忌：${entry.category || ""}${entry.formula ? `（${entry.formula}）` : ""}，${entry.leftDrug || ""}-${entry.rightDrug || ""}，强度${entry.severity || "待定"}；依据：${entry.basis || "十八反十九畏/院内规则"}`;
  }
  if (entry.type === "specialPopulation") {
    return `特殊人群：${entry.population || "特殊状态"} ${entry.riskLevel || entry.severity || "需复核"}；${entry.quote || ""}；动作：${entry.action || "医生复核"}；依据：${entry.basis || "药典/院内规则"}`;
  }
  if (entry.type === "decoction") {
    return `煎服法：建议${entry.allowedMethod || "常规复核"}；错误方法：${entry.wrongMethods || "无"}；动作：${entry.action || "医生复核"}；依据：${entry.basis || "药典/院内规则"}`;
  }
  if (entry.type === "herbRisk") {
    return `功效/风险：${entry.riskName || entry.riskCode || "风险待核验"}；类别：${[entry.primaryCategory, entry.secondaryCategory].filter(Boolean).join("/")}；毒性：${entry.toxicity || "未标注"}；妊娠：${entry.pregnancyRule || "未标注"}；哺乳：${entry.lactationRule || "未标注"}；依据：${entry.basis || "知识库"}`;
  }
  return `${entry.type}：${entry.basis || "知识库记录"}`;
}

function pickEntries(entries: KnowledgeEntry[], max = 6): KnowledgeEntry[] {
  const priority: Record<string, number> = {
    incompatibility: 0,
    specialPopulation: 1,
    herbRisk: 2,
    dose: 3,
    routeDose: 4,
    decoction: 5,
    curatedDose: 6,
  };
  return [...entries]
    .sort((a, b) => (priority[a.type] ?? 99) - (priority[b.type] ?? 99))
    .slice(0, max);
}

export type TcmHerbPairIncompatibility = {
  leftDrug: string;
  rightDrug: string;
  category: string;
  severity: string;
  basis: string;
};

function highRiskPairRules(): TcmHerbPairIncompatibility[] {
  const seen = new Set<string>();
  const rules: TcmHerbPairIncompatibility[] = [];
  for (const herb of data.herbs) {
    for (const entry of herb.entries) {
      if (entry.type !== "incompatibility" || entry.severity !== "HIGH" || !entry.leftDrug || !entry.rightDrug) continue;
      const leftDrug = canonicalKnowledgeHerbName(entry.leftDrug);
      const rightDrug = canonicalKnowledgeHerbName(entry.rightDrug);
      const key = [leftDrug, rightDrug].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push({
        leftDrug,
        rightDrug,
        category: entry.category || "高风险配伍",
        severity: entry.severity,
        basis: entry.basis || "本地结构化配伍规则",
      });
    }
  }
  return rules;
}

const HIGH_RISK_PAIR_RULES = highRiskPairRules();

export function findTcmHerbPairIncompatibilities(herbs: readonly string[]): TcmHerbPairIncompatibility[] {
  const selected = new Set(herbs.map(canonicalKnowledgeHerbName).filter(Boolean));
  return HIGH_RISK_PAIR_RULES.filter((rule) => selected.has(rule.leftDrug) && selected.has(rule.rightDrug));
}

export function buildTcmHerbPairAdvisory(herbs: readonly string[]): string {
  const conflicts = findTcmHerbPairIncompatibilities(herbs);
  if (conflicts.length === 0) return "";
  return [
    "## 生成前配伍预检提示",
    ...conflicts.map((item) => `- **${item.leftDrug}—${item.rightDrug}**：命中${item.category || "高风险配伍"}；依据：${item.basis || "本地结构化配伍规则"}。请医生或药师重点复核，本提示不阻断诊疗流程。`),
  ].join("\n");
}

function formatHighRiskPairIndex(): string {
  return HIGH_RISK_PAIR_RULES.map((rule) => `${rule.leftDrug}-${rule.rightDrug}`).join("、");
}

export function getTcmKnowledgeStatus() {
  return {
    schemaVersion: data.schemaVersion,
    generatedAt: data.generatedAt,
    summary: data.summary,
    localPharmacopoeiaBasis: "2020版历史规则基线",
    requiredCurrentPharmacopoeia: "2025版",
  };
}

export function searchTcmKnowledge(query: string, limit = 10): TcmKnowledgeHit[] {
  const explicitNames = extractKnownHerbNames(query, limit);
  const explicit = explicitNames
    .map((name) => data.herbs.find((item) => item.name === name))
    .filter((item): item is KnowledgeHerb => Boolean(item))
    .map((item) => ({ name: item.name, score: 100, entries: pickEntries(item.entries) }));

  if (explicit.length >= limit) return explicit.slice(0, limit);

  const scored = data.herbs
    .filter((item) => !explicitNames.includes(item.name))
    .map((item) => ({ item, score: scoreHerb(item, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit - explicit.length))
    .map(({ item, score }) => ({ name: item.name, score, entries: pickEntries(item.entries) }));

  return [...explicit, ...scored];
}

function searchPatentRisks(query: string, limit = 5): PatentRisk[] {
  const text = query.replace(/\s+/g, "");
  return data.patentRisks.filter((item) =>
    [item.productOrGroup, item.matchedHisDrugs, item.keyRiskFields, item.triggerCondition]
      .some((field) => field && text.includes(field.split(/[；;]/)[0]))
  ).slice(0, limit);
}

function searchWesternInteractions(query: string, limit = 5): WesternInteraction[] {
  const text = query.replace(/\s+/g, "");
  return data.westernInteractions.filter((item) => {
    const leftHit = tokenIncludedPositive([item.left, item.matchedLeft].filter(Boolean).join("；"), text);
    const rightHit = tokenIncludedPositive([item.right, item.matchedRight].filter(Boolean).join("；"), text);
    return leftHit && rightHit;
  }).slice(0, limit);
}

function tokenIncluded(field: string, text: string): boolean {
  return field
    .split(/[；;、\/\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .some((token) => text.includes(token));
}

function tokenAppearsInPositiveCurrentContext(text: string, token: string): boolean {
  let index = text.indexOf(token);
  while (index !== -1) {
    const before = text.slice(Math.max(0, index - 28), index);
    const after = text.slice(index + token.length, index + token.length + 12);
    const negated = /(否认|无|没有|未服用|未使用|未用|已停用|停用|既往|家族史)[^。；;\n]{0,18}$/.test(before) ||
      /已停用|停药|既往使用|家族/.test(after);
    if (!negated) return true;
    index = text.indexOf(token, index + token.length);
  }
  return false;
}

function tokenIncludedPositive(field: string, text: string): boolean {
  return field
    .split(/[；;、\/\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .some((token) => tokenAppearsInPositiveCurrentContext(text, token));
}

function searchCurrentMedicationConflicts(query: string, limit = 5): CurrentMedicationConflict[] {
  const text = query.replace(/\s+/g, "");
  return (data.currentMedicationConflicts || []).filter((item) => {
    const existingHit = tokenIncludedPositive([item.existingMedClass, item.existingExamples].filter(Boolean).join("；"), text);
    const newHit = tokenIncludedPositive([item.newMedClass, item.newExamples].filter(Boolean).join("；"), text);
    return existingHit && newHit;
  }).slice(0, limit);
}

function searchLabThresholds(query: string, limit = 8): LabThreshold[] {
  const text = query.replace(/\s+/g, "");
  return (data.labThresholds || []).filter((item) =>
    [item.lab, item.condition, item.drugOrClass, item.representativeDrugs, item.missingLabPolicy]
      .some((field) => field && tokenIncluded(field, text))
  ).slice(0, limit);
}

function searchHisTcmMappings(query: string, limit = 8): HisTcmMapping[] {
  const text = query.replace(/\s+/g, "");
  return (data.hisSupport?.tcmMappings || []).filter((item) =>
    [item.queriedDrug, item.goodsName, item.mappedStandardNames, item.variants]
      .some((field) => field && tokenIncluded(field, text))
  ).slice(0, limit);
}

function searchHisSpecConversions(query: string, limit = 8): HisSpecConversion[] {
  const text = query.replace(/\s+/g, "");
  return (data.hisSupport?.specConversions || []).filter((item) =>
    [item.queriedDrug, item.goodsName, item.goodsSpec, item.defaultUse, item.defaultFrequency]
      .some((field) => field && tokenIncluded(field, text))
  ).slice(0, limit);
}

function formatHisSupportContext(query: string): string {
  const lines: string[] = [];
  const mappings = searchHisTcmMappings(query);
  const specs = searchHisSpecConversions(query);
  const stateRules = (data.hisSupport?.clinicalStateDictionary || []).slice(0, 10);
  const routeRules = (data.hisSupport?.routeDictionary || []).filter((item) =>
    ["口服", "水煎服", "先煎", "后下", "包煎", "冲服", "另煎"].some((key) => item.hisValue.includes(key))
  ).slice(0, 12);

  lines.push("HIS对接与字段归一规则：HIS药名、规格、给药途径、频次和煎服法必须先归一再进入规则匹配；AUTO_PARSED_NEEDS_REVIEW 规格换算只能作为医生/药师复核提示，不得作为强确定剂量依据。");

  if (mappings.length > 0) {
    lines.push("命中HIS中药本地映射：");
    for (const item of mappings) {
      lines.push(`- ${item.queriedDrug || item.goodsName} → ${item.mappedStandardNames || "待映射"}；规格：${item.goodsSpec || "未提供"}；状态：${item.status}；缺口：${item.remainingDataGaps || "无"}`);
    }
  }

  if (specs.length > 0) {
    lines.push("命中HIS规格/剂量换算候选：");
    for (const item of specs) {
      lines.push(`- ${item.goodsName || item.queriedDrug} ${item.goodsSpec || ""}：${item.strengthValue || "?"}${item.strengthUnit || ""}；默认用法：${[item.defaultUse, item.defaultFrequency].filter(Boolean).join("/")}；状态：${item.conversionStatus}；用途：${item.ruleUse}`);
    }
  }

  if (routeRules.length > 0) {
    lines.push(`给药途径/频次/煎服法字典示例：${routeRules.map((item) => `${item.hisValue}→${item.normalizedCode}(${item.routeClass})`).join("；")}`);
  }

  if (stateRules.length > 0) {
    lines.push("否定/时态过滤规则：当前患者状态为真才触发禁忌；否认、既往、家族史不得当作当前禁忌。示例：" +
      stateRules.map((item) => `${item.stateName}：阳性[${item.positiveTerms}]，否定[${item.negationTerms}]`).join("；")
    );
  }

  return lines.join("\n");
}

function formatCommonDoseIndex(): string {
  const common = data.commonHerbs.flatMap((item) => {
    const limit = getTcmHerbDoseLimit(item.name);
    if (limit?.min == null || limit.max == null) return [];
    const dose = `${limit.min}-${limit.max}g`;
    const method = item.methods?.length ? `，${item.methods.join("、")}` : "";
    const risk = item.riskTags?.length ? `，${item.riskTags.join("、")}` : "";
    const sourceConflict = limit.sourceConflict
      ? "，存在分用途剂量差异，模型采用保守主范围并交由审方按实际用途复核"
      : "";
    return [`${item.name}${dose}${method}${risk}${sourceConflict}`];
  });
  const controlled = ["茯神", "夜交藤"].flatMap((name) => {
    const limit = getTcmHerbDoseLimit(name);
    return limit?.min != null && limit.max != null ? [`${name}${limit.min}-${limit.max}g`] : [];
  });
  const commonNames = new Set(data.commonHerbs.map((item) => item.name));
  const conflictGoverned = data.herbs.flatMap((item) => {
    if (commonNames.has(item.name)) return [];
    const limit = getTcmHerbDoseLimit(item.name);
    if (limit?.min == null || limit.max == null || !limit.sourceConflict) return [];
    return [`${item.name}${limit.min}-${limit.max}g，存在分用途剂量差异，模型采用保守主范围并交由审方按实际用途复核`];
  });
  return [...common, ...controlled, ...conflictGoverned].join("；");
}

export function buildTcmKnowledgeContext(caseState: CaseState, stage: "diagnose" | "prescribe" | "assess"): string {
  const text = caseText(caseState);
  const hits = searchTcmKnowledge(text, stage === "prescribe" ? 12 : 16);
  const patentRisks = searchPatentRisks(text);
  const westernInteractions = searchWesternInteractions(text);
  const currentMedicationConflicts = searchCurrentMedicationConflicts(text);
  const labThresholds = searchLabThresholds(text);
  const sections: string[] = [];

  sections.push("## 院内合理用药/中医药知识库支持");
  sections.push(`知识库版本：${data.schemaVersion}；生成时间：${data.generatedAt}；饮片条目：${data.summary.herbCount}。`);
  sections.push("使用边界：以下内容仅作为证据与风险提示素材，不替代医生审方；不得输出“硬拦截/自动通过”。");
  sections.push("药典版本边界：本地剂量规则含2020版历史基线；2025年10月1日起处方采纳必须以《中华人民共和国药典》2025年版、现行说明书及院内药事规则复核，历史基线不得表述为现行药典核验结论。");
  sections.push(`全局规则：${data.globalRules.join(" ")}`);
  sections.push(formatHisSupportContext(text));

  if (stage === "prescribe") {
    sections.push(`候选处方剂量限定名单（用于候选处方剂量核验；herbs[]只能选择本名单或下方命中规则中带明确最小/最大剂量的药味；未覆盖药味不得输出剂量或放入候选处方）：${formatCommonDoseIndex()}`);
    sections.push(`模型生成前置配伍核验索引（来自本地结构化高风险配伍规则；候选方不得同时包含任一药对，医生工作台修改后仍以真实审方为准）：${formatHighRiskPairIndex()}`);
  }

  if (hits.length > 0) {
    sections.push("命中饮片/药味规则：");
    for (const hit of hits) {
      const details = hit.entries.map((entry) => `  - ${compactEntry(entry)}`).join("\n");
      sections.push(`- ${hit.name}\n${details}`);
    }
  } else {
    sections.push("命中饮片/药味规则：暂未从病例文本命中具体药味；处方生成时需优先选择可核验药味，并标注依据。");
  }

  if (patentRisks.length > 0) {
    sections.push("命中中成药重点风险：");
    for (const item of patentRisks) {
      sections.push(`- ${item.productOrGroup}：${item.keyRiskFields}；触发：${item.triggerCondition}；动作：${item.action}；依据：${item.sourceIds}`);
    }
  }

  if (westernInteractions.length > 0) {
    sections.push("命中西药/中成药相互作用或同类互斥：");
    for (const item of westernInteractions) {
      sections.push(`- ${item.left} + ${item.right}：${item.condition}；强度${item.severity}；动作：${item.action}；依据：${item.sourceIds}`);
    }
  }

  if (currentMedicationConflicts.length > 0) {
    sections.push("命中当前用药-新处方冲突/同类互斥：");
    for (const item of currentMedicationConflicts) {
      sections.push(`- ${item.ruleName}：当前用药${item.existingExamples}，新处方${item.newExamples}；条件：${item.condition}；强度${item.severity}；提示动作：${item.action}；依据：${item.sourceIds}`);
    }
  }

  if (labThresholds.length > 0 || stage === "assess") {
    sections.push("实验室/检查阈值规则：");
    const rules = labThresholds.length > 0 ? labThresholds : (data.labThresholds || []).slice(0, 6);
    for (const item of rules) {
      sections.push(`- ${item.condition}（${item.lab} ${item.operator} ${item.thresholdValue}${item.thresholdUnit}）：涉及${item.drugOrClass}，强度${item.severity}；缺失策略：${item.missingLabPolicy}；动作：${item.action}；依据：${item.sourceIds}`);
    }
  }

  return sections.join("\n");
}

function parseDoseValue(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:g|克)/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function doseForHerb(text: string, herb: string): number | null {
  const compact = text.replace(/\s+/g, "");
  const index = compact.indexOf(herb);
  if (index < 0) return null;
  const afterHerb = compact.slice(index + herb.length);
  const nextHerbIndex = herbNamesByLength
    .filter((name) => name !== herb)
    .map((name) => afterHerb.indexOf(name))
    .filter((value) => value >= 0)
    .sort((a, b) => a - b)[0];
  const separatorIndex = afterHerb.search(/[，,、；;。]/);
  const stopIndex = [nextHerbIndex, separatorIndex]
    .filter((value): value is number => typeof value === "number" && value >= 0)
    .sort((a, b) => a - b)[0];
  const contextAfterHerb = stopIndex == null
    ? afterHerb.slice(0, 24)
    : afterHerb.slice(0, stopIndex);
  const windowText = `${herb}${contextAfterHerb}`;
  return parseDoseValue(windowText);
}

function cleanTableCell(value: string): string {
  return value
    .replace(/\*\*/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function parseMarkdownCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function herbNameFromText(text: string): string | null {
  const compact = cleanTableCell(text);
  return herbNamesByLength.find((name) => compact.includes(name)) || null;
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

function addPrescribedHerb(rows: PrescribedHerb[], name: string | null, dose: number | null, line: string): void {
  if (!name) return;
  const existing = rows.find((item) => item.name === name);
  if (existing) {
    if (existing.dose == null && dose != null) existing.dose = dose;
    if (!existing.line.includes(line)) existing.line = `${existing.line}\n${line}`;
    return;
  }
  rows.push({ name, dose, line });
}

function isLikelyNonPrescriptionLine(line: string): boolean {
  return /(禁忌|禁用|慎用|风险|提示|证据|依据|不宜与|十八反|十九畏|相反|相畏|来源|支持证据|医生动作|复核|排除|避免|若|如出现|患者须知)/.test(line);
}

function isLikelyNonPrescriptionFreeTextLine(line: string): boolean {
  return isLikelyNonPrescriptionLine(line);
}

function isPrescriptionHeading(line: string): boolean {
  return /^#{1,6}\s*(?:中药饮片处方|候选处方|处方正文|处方明细|推荐处方|候选方药方案)/.test(line);
}

function isNonPrescriptionHeading(line: string): boolean {
  return /^#{1,6}\s*(?:西药|中成药|用药风险|安全校验|处方风险|风险随访|随访|非药物|注意事项|组方依据|加减思路|适用条件|不适用条件|证据|引用)/.test(line);
}

function hasTableHeaderCue(cells: string[]): boolean {
  return cells.some((cell) => /(药名|饮片|中药|剂量|用量|风险|提示|证据|依据|医生动作|涉及对象|风险说明|提示强度)/.test(cell));
}

function isRiskReviewHeader(cells: string[]): boolean {
  const joined = cells.join("");
  return /(提示强度|涉及对象|风险说明|医生动作|触发处置)/.test(joined);
}

export function extractPrescribedHerbs(prescriptionText: string): PrescribedHerb[] {
  const rows: PrescribedHerb[] = [];
  const lines = prescriptionText.split(/\r?\n/);
  let pipeHeader: { nameIndex: number; doseIndex: number } | null = null;
  let tabHeader: { nameIndex: number; doseIndex: number } | null = null;
  let inPrescriptionSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s+/.test(line)) {
      inPrescriptionSection = isPrescriptionHeading(line);
      if (isNonPrescriptionHeading(line)) inPrescriptionSection = false;
      pipeHeader = null;
      tabHeader = null;
      continue;
    }

    const pipeCells = parseMarkdownCells(line);
    if (pipeCells.length > 0) {
      const compactCells = pipeCells.map(cleanTableCell);
      const nameIndex = compactCells.findIndex((cell) => /药名|饮片|中药/.test(cell));
      const doseIndex = compactCells.findIndex((cell) => /剂量|用量/.test(cell));
      if (nameIndex >= 0 && doseIndex >= 0) {
        pipeHeader = { nameIndex, doseIndex };
        inPrescriptionSection = true;
        continue;
      }
      if (isRiskReviewHeader(compactCells)) {
        pipeHeader = null;
        inPrescriptionSection = false;
        continue;
      }
      if (!pipeHeader && hasTableHeaderCue(compactCells)) {
        pipeHeader = null;
        continue;
      }
      if (pipeHeader && inPrescriptionSection && !isSeparatorRow(pipeCells)) {
        const name = herbNameFromText(pipeCells[pipeHeader.nameIndex] || "");
        const dose = parseDoseValue(pipeCells[pipeHeader.doseIndex] || "") ?? doseForHerb(line, name || "");
        addPrescribedHerb(rows, name, dose, line);
      }
      continue;
    }

    const tabCells = line.includes("\t") ? line.split("\t").map((cell) => cell.trim()) : [];
    if (tabCells.length > 1) {
      const compactCells = tabCells.map(cleanTableCell);
      const nameIndex = compactCells.findIndex((cell) => /药名|饮片|中药/.test(cell));
      const doseIndex = compactCells.findIndex((cell) => /剂量|用量/.test(cell));
      if (nameIndex >= 0 && doseIndex >= 0) {
        tabHeader = { nameIndex, doseIndex };
        inPrescriptionSection = true;
        continue;
      }
      if (isRiskReviewHeader(compactCells)) {
        tabHeader = null;
        inPrescriptionSection = false;
        continue;
      }
      if (!tabHeader && hasTableHeaderCue(compactCells)) {
        tabHeader = null;
        continue;
      }
      if (tabHeader && inPrescriptionSection) {
        const name = herbNameFromText(tabCells[tabHeader.nameIndex] || "");
        const dose = parseDoseValue(tabCells[tabHeader.doseIndex] || "") ?? doseForHerb(line, name || "");
        addPrescribedHerb(rows, name, dose, line);
      }
      continue;
    }

    pipeHeader = null;
    tabHeader = null;
  }

  const prescriptionScope = prescriptionText
    .split(/\n(?=#{1,6}\s*(?:西药|中成药|用药风险|安全校验|处方风险|风险随访|随访|非药物|注意事项))/)[0] || prescriptionText;
  for (const rawLine of prescriptionScope.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || isLikelyNonPrescriptionFreeTextLine(line)) continue;
    const matchedNames: string[] = [];
    for (const herb of herbNamesByLength) {
      if (!line.includes(herb)) continue;
      if (matchedNames.some((name) => name.includes(herb))) continue;
      const dose = doseForHerb(line, herb);
      if (dose == null) continue;
      addPrescribedHerb(rows, herb, dose, line);
      matchedNames.push(herb);
    }
  }

  return rows;
}

function canonicalKnowledgeHerbName(value: string): string {
  const normalized = normalizedHerbLookupToken(value);
  const controlled = CONTROLLED_HERB_ALIASES[normalized];
  if (controlled) return canonicalHerbNameByToken.get(normalizedHerbLookupToken(controlled)) || controlled;
  const direct = canonicalHerbNameByToken.get(normalized);
  if (direct) return direct;
  const withoutProcessing = normalized.replace(/^(?:蜜炙|麸炒|土炒|炒|炙|醋制|酒制|盐制|姜制|煅|制|生)/, "");
  return canonicalHerbNameByToken.get(withoutProcessing) || withoutProcessing;
}

const commonTcmHerbNames = new Set(data.commonHerbs.map((item) => item.name));

/**
 * Whether a herb belongs to the governed common-clinic subset. Consumers use this as a stable
 * ranking signal only; it does not grant dose, efficacy, or safety authority by itself.
 */
export function isCommonTcmHerbName(herb: string): boolean {
  return commonTcmHerbNames.has(canonicalKnowledgeHerbName(herb));
}

export type TcmGovernedHighImpactConcept = "orifice_open" | "mass_soften";

const TCM_GOVERNED_HIGH_IMPACT_HERBS: Readonly<Record<TcmGovernedHighImpactConcept, ReadonlySet<string>>> = {
  orifice_open: new Set(["远志", "麝香", "冰片", "石菖蒲", "苏合香", "安息香"]),
  mass_soften: new Set(["牡蛎", "鳖甲", "昆布", "海藻", "瓦楞子", "海蛤壳"]),
};

/**
 * Server-governed action classes for herbs whose concise catalog category can hide a
 * direction-changing specialist action. This mapping is clinical data, not UI text parsing.
 */
export function getTcmHerbGovernedHighImpactConcepts(herb: string): TcmGovernedHighImpactConcept[] {
  const canonical = canonicalKnowledgeHerbName(herb);
  return (Object.entries(TCM_GOVERNED_HIGH_IMPACT_HERBS) as Array<[TcmGovernedHighImpactConcept, ReadonlySet<string>]>)
    .filter(([, herbs]) => herbs.has(canonical) || [...herbs].some((entry) => canonicalKnowledgeHerbName(entry) === canonical))
    .map(([concept]) => concept);
}

export type TcmHerbDoseLimit = {
  min?: number | null;
  max?: number | null;
  basis?: string;
  sourceType?: "dose" | "routeDose" | "curatedDose" | "common";
  sourceConflict?: boolean;
  alternatives?: Array<{
    min: number;
    max: number;
    sourceType: "dose" | "routeDose";
    basis?: string;
    routeForm?: string;
    method?: string;
  }>;
};

function validDoseEntries(entries: KnowledgeEntry[], type: string): KnowledgeEntry[] {
  return entries.filter((entry) =>
    entry.type === type &&
    entry.minG != null && entry.maxG != null &&
    Number.isFinite(Number(entry.minG)) && Number.isFinite(Number(entry.maxG)) &&
    Number(entry.minG) > 0 && Number(entry.minG) <= Number(entry.maxG)
  );
}

function resolvedDoseEntry(
  entries: KnowledgeEntry[],
  sourceType: "dose" | "routeDose",
  equivalentBasis?: string,
  competingEntries: KnowledgeEntry[] = [],
): TcmHerbDoseLimit | null {
  if (entries.length === 0) return null;
  const primary = entries[0];
  const overlapping = entries.filter((entry) =>
    Number(entry.minG) <= Number(primary.maxG) && Number(entry.maxG) >= Number(primary.minG)
  );
  const min = Math.max(...overlapping.map((entry) => Number(entry.minG)));
  const max = Math.min(...overlapping.map((entry) => Number(entry.maxG)));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
  const sourceConflict = [...entries, ...competingEntries].some((entry) =>
    Number(entry.maxG) < min || Number(entry.minG) > max
  );
  const alternatives = [...entries, ...competingEntries].flatMap((entry) => {
    const entryMin = Number(entry.minG);
    const entryMax = Number(entry.maxG);
    if (!(entryMax < min || entryMin > max)) return [];
    return [{
      min: entryMin,
      max: entryMax,
      sourceType: entry.type === "routeDose" ? "routeDose" as const : "dose" as const,
      ...(entry.basis ? { basis: entry.basis } : {}),
      ...(entry.routeForm ? { routeForm: entry.routeForm } : {}),
      ...(entry.method ? { method: entry.method } : {}),
    }];
  });
  const bases = [...new Set(entries.map((entry) => entry.basis).filter(Boolean))].join("；");
  return {
    min,
    max,
    basis: equivalentBasis || bases,
    sourceType,
    ...(sourceConflict ? { sourceConflict: true } : {}),
    ...(alternatives.length > 0 ? { alternatives } : {}),
  };
}

export function getTcmHerbDoseLimit(herb: string): TcmHerbDoseLimit | null {
  const canonical = canonicalKnowledgeHerbName(herb);
  const exact = CONTROLLED_EXACT_HERB_DOSE_LIMITS[canonical];
  if (exact) return { ...exact };
  const equivalent = CONTROLLED_HERB_DOSE_EQUIVALENTS[canonical];
  const doseName = equivalent?.target || canonical;
  const herbData = data.herbs.find((item) => item.name === doseName || item.aliases.includes(doseName));
  // 主药典剂量条目是本地历史规则包的首要边界。分途径条目仅在主条目缺失时接管；若两类
  // 范围不相交则显式标记冲突，而不是把整味药静默降成“无剂量数据”。
  const entries = herbData?.entries || [];
  const primaryDoseEntries = validDoseEntries(entries, "dose");
  const decoctionRouteEntries = validDoseEntries(entries, "routeDose").filter((entry) =>
    /煎服|汤剂|另煎|另炖/.test(`${entry.routeForm || ""}${entry.method || ""}`)
  );
  const primary = resolvedDoseEntry(primaryDoseEntries, "dose", equivalent?.basis, decoctionRouteEntries);
  if (primary) return primary;
  const route = resolvedDoseEntry(decoctionRouteEntries, "routeDose", equivalent?.basis);
  if (route) return route;
  const curated = herbData?.entries.find((entry) => entry.type === "curatedDose" && entry.minG != null && entry.maxG != null);
  if (curated) return { min: curated.minG, max: curated.maxG, basis: equivalent?.basis || curated.basis, sourceType: "curatedDose" };
  const common = data.commonHerbs.find((item) => item.name === doseName);
  return common ? { min: common.minG, max: common.maxG, basis: equivalent?.basis || common.basis, sourceType: "common" } : null;
}

export function getTcmHerbFunctionText(herb: string): string {
  const canonical = canonicalKnowledgeHerbName(herb);
  const herbData = data.herbs.find((item) => item.name === canonical || item.aliases.includes(canonical));
  const extracted = (herbData?.entries || [])
    .map((entry) => entry.functionText)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("；");
  const categoryIndex = herbFunctionCategories.categories as Record<string, string[]>;
  const categories = categoryIndex[canonical] || [];
  const controlled = CONTROLLED_HERB_FUNCTION_TEXT[canonical];
  if (controlled) return [controlled, ...categories.slice(0, 2)].filter(Boolean).join("；");

  const categoryConcepts: Array<[RegExp, RegExp]> = [
    [/补气|补虚/, /大补元气|补中益气|健脾益气|补气|益气|固表|升阳/],
    [/补血/, /补血|养血|益血/],
    [/安神/, /安神|宁心|宁神|定志|镇惊/],
    [/理气/, /理气|行气|疏肝|解郁|止痛/],
    [/清热/, /清热|泻火|凉血|解毒/],
    [/利水|祛湿/, /利水|渗湿|祛湿|燥湿/],
    [/活血/, /活血|化瘀|通经|止痛/],
    [/化痰|止咳|平喘/, /化痰|祛痰|止咳|平喘/],
    [/温里|补阳/, /温中|温阳|补阳|散寒/],
    [/消食/, /消食|导滞|健胃/],
  ];
  const activeConcepts = categoryConcepts.filter(([category]) => categories.some((item) => category.test(item))).map(([, concept]) => concept);
  const actionWord = /补|益|养|健|安|宁|行|理|疏|清|泻|温|散|化|祛|利|止|固|敛|活|通|消|和|调|润|解|生津|托毒|排脓/;
  const unsuitable = /美容|养颜|驻颜|减肥|抗癌|延年益寿|包治|根治|痛经|痈肿|壮阳/;
  const ranked = extracted.split(/[、，；;]+/).map((text, index) => ({ text: text.trim(), index }))
    .filter((item) => item.text.length >= 2 && item.text.length <= 12 && actionWord.test(item.text) && !unsuitable.test(item.text))
    .map((item) => ({
      ...item,
      score: (activeConcepts.some((pattern) => pattern.test(item.text)) ? 20 : 0) +
        (item.text.length >= 4 && item.text.length <= 8 ? 4 : 0) - item.index / 1000,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const concise: string[] = [];
  for (const item of ranked) {
    if (concise.some((existing) => existing.includes(item.text) || item.text.includes(existing))) continue;
    concise.push(item.text);
    if (concise.length >= 5) break;
  }
  return [concise.join("，"), ...categories.slice(0, 2)].filter(Boolean).join("；");
}

/**
 * Return the governed textbook category labels used for direction-level checks. These labels are
 * deliberately kept separate from the broader merged function text, whose historical sources may
 * contain noisy or overly broad indications that are unsuitable for high-impact safety decisions.
 */
export function getTcmHerbFunctionCategories(herb: string): string[] {
  const canonical = canonicalKnowledgeHerbName(herb);
  const categoryIndex = herbFunctionCategories.categories as Record<string, string[]>;
  return [...new Set([...(categoryIndex[canonical] || []), ...(CONTROLLED_HERB_FUNCTION_CATEGORIES[canonical] || [])])];
}

/**
 * Return the server-owned text shown in the prescription's "配伍意义" column. A small subset of
 * catalogued herbs has a governed name and dose boundary but no concise function sentence in the
 * local source files. That documentation gap is not a medication-safety failure: use the already
 * signed pathogenesis target and controlled 君臣佐使 role to describe its place in this candidate,
 * without inventing a pharmacological claim.
 */
export function getTcmHerbFunctionDisplayText(herb: string, role = "", target = ""): string {
  const knowledgeText = getTcmHerbFunctionText(herb).trim();
  if (knowledgeText) return knowledgeText;
  const controlledRole = /^(?:君|臣|佐|使)$/.test(role.trim()) ? role.trim() : "配伍";
  const controlledTarget = target.replace(/[|\r\n<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "本方治疗目标";
  return `${controlledRole}药配伍定位：承接“${controlledTarget}”的组方目标`;
}

export function getTcmHerbRiskProfile(herb: string): string {
  const canonical = canonicalKnowledgeHerbName(herb);
  const herbData = data.herbs.find((item) => item.name === canonical || item.aliases.includes(canonical));
  return (herbData?.entries || [])
    .flatMap((entry) => [entry.riskCode, entry.riskName, entry.primaryCategory, entry.secondaryCategory, entry.toxicity])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("；");
}
