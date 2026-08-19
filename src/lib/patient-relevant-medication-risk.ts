import {
  assessConceptionState,
  assessLactationState,
  assessPregnancyState,
  isPositiveOrPossibleClinicalState,
} from "./clinical-state";
import { populationScopeForms } from "./clinical-vocabulary";
import { ageValue, type CaseState } from "./diagnosis-types";

type MedicationRiskCaseContext = Partial<Pick<
  CaseState,
  | "patient"
  | "chiefComplaint"
  | "symptoms"
  | "pastHistory"
  | "medicationHistory"
  | "allergyHistory"
  | "tongue"
  | "pulse"
  | "faceNote"
  | "hisRecord"
>>;

const REPRODUCTIVE_FORMS = populationScopeForms("reproductive_label");
const REPRODUCTIVE_EXCLUSION_FORMS = populationScopeForms("reproductive_exclusion");
const RETAINED_POPULATION_FORMS = [
  ...populationScopeForms("pediatric"),
  ...populationScopeForms("geriatric"),
  ...populationScopeForms("medication_label_retained"),
];
const REPRODUCTIVE_LIST_MEMBER = new RegExp(
  `(?:${REPRODUCTIVE_FORMS.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:\\s*[、和与及或/]\\s*)?`,
  "g",
);

function includesAny(value: string, forms: readonly string[]): boolean {
  return forms.some((form) => value.includes(form));
}

function startsWithAny(value: string, forms: readonly string[]): boolean {
  return forms.some((form) => value.startsWith(form));
}

function contextText(state?: MedicationRiskCaseContext | null): string {
  if (!state) return "";
  const hisFields = state.hisRecord?.fields
    ? Object.values(state.hisRecord.fields).filter((value): value is string => typeof value === "string")
    : [];
  const symptomText = state.symptoms && typeof state.symptoms === "object"
    ? JSON.stringify(state.symptoms)
    : "";
  return [
    state.patient?.sex,
    state.patient?.age,
    state.chiefComplaint,
    state.pastHistory,
    state.medicationHistory,
    state.allergyHistory,
    state.tongue,
    state.pulse,
    state.faceNote,
    symptomText,
    state.hisRecord?.rawText,
    ...hisFields,
  ].filter((value) => value != null && String(value).trim()).join("；");
}

/**
 * Whether pregnancy/lactation/conception label clauses are clinically relevant to the current
 * patient-facing candidate card. Explicit positive/possible facts always win over age or menopause.
 */
export function reproductiveMedicationRiskApplies(
  state?: MedicationRiskCaseContext | null,
): boolean {
  if (!state) return true;
  const text = contextText(state);
  if (
    isPositiveOrPossibleClinicalState(assessPregnancyState(text)) ||
    isPositiveOrPossibleClinicalState(assessLactationState(text)) ||
    isPositiveOrPossibleClinicalState(assessConceptionState(text))
  ) return true;

  const sex = String(state.patient?.sex || state.hisRecord?.fields?.sex || "").trim();
  if (/男/.test(sex) && !/女/.test(sex)) return false;
  if (!/女/.test(sex)) return true;

  const age = ageValue(state.hisRecord?.fields?.age) ?? ageValue(state.patient?.age);
  return !((age != null && age >= 60) || includesAny(text, REPRODUCTIVE_EXCLUSION_FORMS));
}

function scrubMixedPopulationClause(clause: string): string {
  return clause
    .replace(REPRODUCTIVE_LIST_MEMBER, "")
    .replace(/^[\s、，,和与及或/]+/, "")
    .replace(/[、，,和与及或/]+(?=[。！？!?]?$)/, "")
    .trim();
}

function sanitizeRiskAtom(atom: string): string {
  if (!includesAny(atom, REPRODUCTIVE_FORMS)) return atom.trim();
  const retained: string[] = [];
  for (const part of atom.split(/[，,]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (!includesAny(trimmed, REPRODUCTIVE_FORMS)) {
      retained.push(trimmed);
      continue;
    }
    const withoutNumbering = trimmed.replace(/^\d{1,3}[.．、]\s*/, "");
    if (startsWithAny(withoutNumbering, REPRODUCTIVE_FORMS)) continue;
    if (!includesAny(withoutNumbering, RETAINED_POPULATION_FORMS)) continue;
    const scrubbed = scrubMixedPopulationClause(trimmed);
    if (scrubbed && !includesAny(scrubbed, REPRODUCTIVE_FORMS)) retained.push(scrubbed);
  }
  return retained.join("，");
}

/**
 * Patient-facing projection only. The signed candidate and full label/audit payload stay unchanged.
 */
export function clinicianVisibleMedicationRiskNote(
  riskNote: string | null | undefined,
  state?: MedicationRiskCaseContext | null,
): string {
  const source = String(riskNote || "").trim();
  if (!source || reproductiveMedicationRiskApplies(state)) return source;
  const atoms = source
    .replace(/([。！？!?])\s*(?=\d{1,3}[.．、])/g, "$1\n")
    .split(/[；;\n]+/)
    .map(sanitizeRiskAtom)
    .filter(Boolean);
  return atoms.join("；");
}
