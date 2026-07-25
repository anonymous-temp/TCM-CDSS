import requiredFieldMatrixJson from "../data/clinical-required-field-matrix.json" with { type: "json" };

const COLLECT_SEX_VALUES = new Set(["男", "女", "其他或未明确"]);

export type CollectRequiredFieldValidation =
  | { ok: true; patientSex: "男" | "女" | "其他或未明确" }
  | { ok: false; error: string };

/** Server-side M01 contract; the UI marker is not an authority boundary. */
export function validateCollectRequiredFields(value: unknown): CollectRequiredFieldValidation {
  const patientSex = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (!COLLECT_SEX_VALUES.has(patientSex)) {
    const sexLabel = requiredFieldMatrixJson.entries.find((item) => item.id === "sex")?.label || "性别/生理状态";
    return { ok: false, error: `${sexLabel} required；无法确认时请选择“其他或未明确”` };
  }
  return { ok: true, patientSex: patientSex as "男" | "女" | "其他或未明确" };
}

export function patientSexAllowsDoseLevelSuggestion(value: unknown): boolean {
  const patientSex = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  return patientSex === "男" || patientSex === "女";
}
