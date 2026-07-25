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

export function governedTcmTreatmentPlanTemplate(
  code: TcmTreatmentProjectCode,
  clinicalText: string,
  allowedIndicationTags?: ReadonlySet<TcmTreatmentIndicationTag>,
): TcmTreatmentPlanTemplate | undefined {
  const normalized = clinicalText.normalize("NFKC");
  const definition = PROJECT_BY_CODE.get(code);
  if (!definition?.patientSpecificParametersAllowed) return undefined;
  return definition.planTemplates.find((template) =>
    (!allowedIndicationTags || allowedIndicationTags.has(template.indicationTag)) &&
    template.matchAny.some((term) => normalized.includes(term)));
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
