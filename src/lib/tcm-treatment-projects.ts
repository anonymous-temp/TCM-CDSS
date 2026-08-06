import tcmNondrugTreatmentJson from "../data/tcm-nondrug-treatment-evidence-catalog.json" with { type: "json" };

export const TCM_TREATMENT_PROJECT_CODES = [
  "acupuncture", "moxibustion", "tuina", "cupping", "guasha", "needle_knife",
  "acupoint_application", "medicated_plaster", "fumigation_wash", "medicated_bath",
  "auricular", "thread_embedding", "medicated_ironing", "bloodletting", "fire_cautery",
  "hook_cutting", "thread_drainage", "ligation", "diet_therapy", "mind_therapy",
  "qigong_daoyin", "miscellaneous",
] as const;

export const TCM_TREATMENT_INDICATION_TAGS = [
  "digestive",
  "respiratory",
  "upper_airway",
  "musculoskeletal_pain",
  "neurologic_rehabilitation",
  "dizziness_balance",
  "movement_disorder",
  "gynecology",
  "dermatology",
  "headache",
  "sleep_emotion",
  "metabolic_rehabilitation",
  "anorectal",
] as const;

export type TcmTreatmentProjectCode = typeof TCM_TREATMENT_PROJECT_CODES[number];
export type TcmTreatmentIndicationTag = typeof TCM_TREATMENT_INDICATION_TAGS[number];
export type TcmTreatmentProjectRisk = "low" | "moderate" | "specialist";
export type TcmTreatmentPlanTemplate = {
  id: string;
  indicationTag: TcmTreatmentIndicationTag;
  matchAny: readonly string[];
  sitesOrPoints: readonly string[];
  techniqueBoundary: string;
  scheduleSuggestion: string;
  sourceRefs: readonly string[];
  parameterCompleteness: string;
};

export type TcmTreatmentProjectDefinition = {
  code: TcmTreatmentProjectCode;
  name: string;
  risk: TcmTreatmentProjectRisk;
  indicationTags: readonly TcmTreatmentIndicationTag[];
  containsMedication: boolean;
  requiresMedicationAudit: boolean;
  operatorRequirement: string;
  safetyFocus: string;
  aliases: string[];
  evidenceStatus: string;
  protocolSourceRefs: readonly string[];
  recommendationMode: string;
  executable: boolean;
  governedParameterTemplateAvailable: boolean;
  governedFrequencyTemplateAvailable: boolean;
  coverageDisposition: string;
  clinicianReviewRequired: true;
  patientSpecificParametersAllowed: boolean;
  parameterPolicy: string;
  planTemplates: readonly TcmTreatmentPlanTemplate[];
};

type ProjectCatalogInput = Omit<TcmTreatmentProjectDefinition, "containsMedication" | "requiresMedicationAudit"> &
  Partial<Pick<TcmTreatmentProjectDefinition, "containsMedication" | "requiresMedicationAudit">>;

function defineProject(definition: ProjectCatalogInput): TcmTreatmentProjectDefinition {
  const containsMedication = definition.containsMedication === true;
  const requiresMedicationAudit = definition.requiresMedicationAudit === true;
  if (containsMedication !== requiresMedicationAudit) {
    throw new Error(`Medication governance metadata must agree for ${definition.code}`);
  }
  return { ...definition, containsMedication, requiresMedicationAudit };
}

type GovernedTreatmentProjectRow = {
  projectCode: TcmTreatmentProjectCode;
  projectName: string;
  aliases: string[];
  riskLevel: TcmTreatmentProjectRisk;
  indicationTags: TcmTreatmentIndicationTag[];
  containsMedication: boolean;
  requiresMedicationAudit: boolean;
  operatorRequirement: string;
  safetyFocus: string;
  evidenceStatus: string;
  protocolSourceRefs: string[];
  recommendationMode: string;
  executable: boolean;
  governedParameterTemplateAvailable: boolean;
  governedFrequencyTemplateAvailable: boolean;
  coverageDisposition: string;
  clinicianReviewRequired: true;
  patientSpecificParametersAllowed: boolean;
  parameterPolicy: string;
  planTemplates: TcmTreatmentPlanTemplate[];
};

const GOVERNED_TREATMENT_ROWS = tcmNondrugTreatmentJson.entries as readonly GovernedTreatmentProjectRow[];

/**
 * T12 is the sole runtime project registry. Recommendation code may rank eligible projects, but it
 * cannot invent a project, relax its medication-audit flag, or turn a governance row executable.
 */
export const TCM_TREATMENT_PROJECTS: readonly TcmTreatmentProjectDefinition[] =
  GOVERNED_TREATMENT_ROWS.map((row) => defineProject({
    code: row.projectCode,
    name: row.projectName,
    risk: row.riskLevel,
    indicationTags: row.indicationTags,
    containsMedication: row.containsMedication,
    requiresMedicationAudit: row.requiresMedicationAudit,
    operatorRequirement: row.operatorRequirement,
    safetyFocus: row.safetyFocus,
    aliases: row.aliases,
    evidenceStatus: row.evidenceStatus,
    protocolSourceRefs: row.protocolSourceRefs,
    recommendationMode: row.recommendationMode,
    executable: row.executable,
    governedParameterTemplateAvailable: row.governedParameterTemplateAvailable,
    governedFrequencyTemplateAvailable: row.governedFrequencyTemplateAvailable,
    coverageDisposition: row.coverageDisposition,
    clinicianReviewRequired: row.clinicianReviewRequired,
    patientSpecificParametersAllowed: row.patientSpecificParametersAllowed,
    parameterPolicy: row.parameterPolicy,
    planTemplates: row.planTemplates,
  }));

const expectedProjectCodes = new Set(TCM_TREATMENT_PROJECT_CODES);
if (
  TCM_TREATMENT_PROJECTS.length !== expectedProjectCodes.size ||
  TCM_TREATMENT_PROJECTS.some((item) => !expectedProjectCodes.has(item.code)) ||
  new Set(TCM_TREATMENT_PROJECTS.map((item) => item.code)).size !== expectedProjectCodes.size
) {
  throw new Error("T12 treatment project catalog does not exactly cover the runtime project-code contract");
}

const PROJECT_BY_CODE = new Map(TCM_TREATMENT_PROJECTS.map((item) => [item.code, item]));
const PROJECT_CODE_BY_ALIAS = new Map(TCM_TREATMENT_PROJECTS.flatMap((item) =>
  [item.code, item.name, ...item.aliases].map((alias) => [alias.toLowerCase(), item.code] as const)
));

export function isKnownTcmTreatmentProjectCode(value: unknown): value is TcmTreatmentProjectCode {
  return typeof value === "string" && PROJECT_BY_CODE.has(value as TcmTreatmentProjectCode);
}

export function parseTcmTreatmentCapabilities(value: unknown): TcmTreatmentProjectCode[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，;；|]/)
      : [];
  return [...new Set(entries.flatMap((entry) => {
    const normalized = String(entry || "").trim().toLowerCase();
    const code = PROJECT_CODE_BY_ALIAS.get(normalized);
    return code ? [code] : [];
  }))];
}

export function getTcmTreatmentProjectDefinition(code: TcmTreatmentProjectCode): TcmTreatmentProjectDefinition | undefined {
  return PROJECT_BY_CODE.get(code);
}

/**
 * 按**给定的适应证优先级**选取治理模板。
 *
 * 旧签名接收的是一个无序 Set，实现用 `planTemplates.find(...)`——于是真正决定选哪套穴位的是
 * **目录里模板的排列顺序**，而不是本例的适应证。针刺的模板表第一条恰好是失眠方
 * （安眠/神门/内关/心俞），只要病历里出现「失眠」二字，头痛病例也会拿到这套安眠穴位，
 * 而卡片标题上写的却是按项目亲和度算出来的另一个适应证（头痛症状）——同一张卡片里
 * 「适应证」和「穴位」来自两套互不相干的判据（生产实测 fixa-d1b：肝阳上亢头痛 → 安眠/心俞）。
 *
 * 改为按调用方给出的**有序**适应证逐个匹配：先找排第一的适应证有没有对应模板，没有再退而求其次。
 * 选中的模板自带 indicationTag，呈现层据此标注，两者不可能再分叉。
 */
export function governedTcmTreatmentPlanTemplateForTags(
  code: TcmTreatmentProjectCode,
  clinicalText: string,
  orderedIndicationTags: readonly TcmTreatmentIndicationTag[],
): TcmTreatmentPlanTemplate | undefined {
  const normalized = clinicalText.normalize("NFKC");
  const definition = PROJECT_BY_CODE.get(code);
  if (!definition?.patientSpecificParametersAllowed) return undefined;
  // matchAny 不是「同一标签下多模板的消歧器」，而是**本例绑定判据本身**：
  // 调用方（compileTcmTreatmentRecommendations、以及回归套件）允许传入项目声明的全部适应证标签，
  // 由这里按病历原文决定命中哪一条。
  //
  // 2026-08-06 曾试图放宽为「该标签下只有一条模板时，标签命中即足够」，用来解决
  // 「入睡困难」匹配不到 sleep_emotion 模板的问题——**实测灾难性**：头痛病例拿到了
  // 中脘、天枢、足三里这套消化类穴位，因为标签列表里的 digestive 恰好只有一条模板。
  // 那次放宽等于取消本例绑定，而本例绑定正是甲方 9.1 / 6.1 两轮投诉的核心。
  // 词表稀疏要在**模板 matchAny 数据侧**补齐（见 test:tcm-treatments 的词表一致性断言），
  // 不能靠削弱这里的判据换取覆盖率。
  for (const tag of orderedIndicationTags) {
    const matched = definition.planTemplates.find((template) =>
      template.indicationTag === tag &&
      template.matchAny.some((term) => normalized.includes(term)));
    if (matched) return matched;
  }
  return undefined;
}

/**
 * 该模板的 sitesOrPoints 是否**真的是穴位/部位**（甲方评测 2026-08-04 9.1）。
 *
 * 目录里有三条模板把「点哪儿由别处决定」写进了 sitesOrPoints 字段：
 *   moxibustion-influenza-hunan-2025      → 「按针刺方案中与当前证型匹配的穴位」
 *   thread-embedding-obesity-…-assessment → 「具体埋线穴位须经专科查体和辨证确认」
 *   bloodletting-influenza-…-specialist   → 「点刺或刺络部位须由专科医师按证型现场确定」
 * 它们是**延期说明**，不是穴位。呈现层照单全收，于是医生看到的「常用穴位」是一句话
 * （生产实测：产后头痛例灸法卡片的常用穴位 = 「按针刺方案中与当前证型匹配的穴位」）——
 * 甲方原话「推荐治疗项目应列出常用穴位」指的正是这个。
 *
 * 判据取目录自带的 parameterCompleteness 字段，不做任何文本识别：该字段以
 * `points_require_syndrome_selection` / `points_require_exam` / `site_requires_exam` 结尾时，
 * 目录自己声明这条模板的穴位/部位尚未治理。
 * `exact_points_require_exam`（针刺骨骼肌肉痛：局部阿是穴 + 循经远端穴）**不在此列**——
 * 它给出的是受治理的取穴范围，精确定位才需查体，属于正常的临床表述。
 */
export function tcmTreatmentTemplatePointsAreGoverned(template: TcmTreatmentPlanTemplate): boolean {
  const completeness = String(template.parameterCompleteness || "");
  if (completeness.endsWith("exact_points_require_exam")) return true;
  return !(
    completeness.endsWith("points_require_syndrome_selection") ||
    completeness.endsWith("points_require_exam") ||
    completeness.endsWith("site_requires_exam")
  );
}

/** True when every governed template of the project legitimately has no acupoints/sites
 *  (e.g. 食疗法/意疗法 regimen-style projects). Such projects must not be rejected for an
 *  empty suggestedSitesOrPoints list in a governed plan. */
export function tcmTreatmentProjectIsPointFree(code: string): boolean {
  const definition = PROJECT_BY_CODE.get(code as TcmTreatmentProjectCode);
  if (!definition || definition.planTemplates.length === 0) return false;
  return definition.planTemplates.every((template) => template.sitesOrPoints.length === 0);
}

const GENERIC_CLINIC_ASSESSMENT_POSITIONING = "可由本机构医生结合现场查体和禁忌复核后决定是否开展。";

/** Keep clinically material boundaries, but hide the identical card boilerplate from the UI/report. */
export function tcmTreatmentAssessmentPositioningForDisplay(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized !== GENERIC_CLINIC_ASSESSMENT_POSITIONING ? normalized : undefined;
}
