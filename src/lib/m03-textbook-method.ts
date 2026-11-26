import { textbookAnchorableMethod } from "./tcm-formula-provenance";
import { textbookRowForSyndrome, textbookTreatmentRow, therapyWithoutUnsupportedSymptomItems } from "./tcm-textbook-syndromes";

const split = (method: string) => method.split(/[，,、；;]/u).map(item => item.trim()).filter(Boolean);

/** Fill a missing textbook item only for the exact signed syndrome and formula, with the same first treatment. */
export function completeSignedTextbookMethod(method: string, overview: Record<string, unknown>, recordText: string): string {
  const diseaseName = String(overview.tcmDiseaseName || "");
  const syndromeName = String(overview.primarySyndrome || "");
  const formulas = overview.recommendedFormulaNames;
  if (!recordText || !Array.isArray(formulas) || formulas.length !== 1 ||
      Array.isArray(overview.secondarySyndromes) && overview.secondarySyndromes.length) return method;
  const row = textbookRowForSyndrome(diseaseName, syndromeName, { recordText });
  if (!row || row.syndromeName !== syndromeName || !row.formulas.includes(formulas[0]) ||
      textbookTreatmentRow(row, recordText, undefined, formulas)?.id !== row.id) return method;
  const items = split(method);
  const textbook = split(therapyWithoutUnsupportedSymptomItems(textbookAnchorableMethod(row.therapy), { recordText, diseaseName, syndromeName, bookKey: row.bookKey }));
  if (items[0] !== textbook[0] || textbook.length < 2 || textbook.some(item => item.length !== 4) ||
      textbook.every(item => items.includes(item))) return method;
  const combined = [...new Set([...textbook, ...items])];
  return combined.length <= 3 ? combined.join("，") : method;
}
