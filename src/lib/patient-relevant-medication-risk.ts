import {
  assessConceptionState,
  assessLactationState,
  assessPregnancyState,
  isPositiveOrPossibleClinicalState,
} from "./clinical-state";
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

const REPRODUCTIVE_TERM = /孕妇|妊娠|孕期|哺乳|乳母|备孕|生育计划/;
const REPRODUCTIVE_PREFIX = /^(?:孕妇|妊娠|孕期|哺乳|乳母|备孕|生育计划)/;
const RETAINED_POPULATION_TERM = /儿童|小儿|婴幼儿|经期|月经期|老年|年老|肝功能|肾功能|过敏|糖尿病|高血压/;
const PHYSIOLOGICALLY_OUT_OF_SCOPE =
  /(?:已|自然)?绝经(?:后|[^。；\n]{0,12}\d+\s*(?:年|个月|月))|双侧卵巢切除|子宫全切(?:除)?|无子宫/;

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
  return !((age != null && age >= 60) || PHYSIOLOGICALLY_OUT_OF_SCOPE.test(text));
}

function scrubMixedPopulationClause(clause: string): string {
  return clause
    .replace(/(?:妊娠期妇女|孕期妇女|哺乳期妇女|备孕妇女|孕妇|乳母)(?:\s*[、和与及或/]\s*)?/g, "")
    .replace(/^[\s、，,和与及或/]+/, "")
    .replace(/[、，,和与及或/]+(?=[。！？!?]?$)/, "")
    .trim();
}

function sanitizeRiskAtom(atom: string): string {
  if (!REPRODUCTIVE_TERM.test(atom)) return atom.trim();
  const retained: string[] = [];
  for (const part of atom.split(/[，,]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (!REPRODUCTIVE_TERM.test(trimmed)) {
      retained.push(trimmed);
      continue;
    }
    const withoutNumbering = trimmed.replace(/^\d{1,3}[.．、]\s*/, "");
    if (REPRODUCTIVE_PREFIX.test(withoutNumbering)) continue;
    if (!RETAINED_POPULATION_TERM.test(withoutNumbering)) continue;
    const scrubbed = scrubMixedPopulationClause(trimmed);
    if (scrubbed && !REPRODUCTIVE_TERM.test(scrubbed)) retained.push(scrubbed);
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
