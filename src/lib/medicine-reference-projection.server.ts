import "server-only";
import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { findLocalPatentMedicineEntry } from "./local-patent-medicine-candidates";

type Medicine = NonNullable<NonNullable<ClinicalReasoningResultV2["formula"]>["patentAndWestern"]>[number];

/** Re-derive provenance from governed data at the server trust boundary. A client reference flag or
 * signature-shaped string is never sufficient. Only this exact label cell is a reference domain;
 * patient-specific columns and every noncanonical/extended risk cell remain current risk prose.
 * External evidence cannot be independently verified here and retains conservative classification.
 */
export function localLabelRiskProjection(item: Medicine): string | undefined {
  if (item.type !== "中成药" || !/^LOCAL-INST-\d+$/.test(item.evidenceId || "")) return undefined;
  const label = findLocalPatentMedicineEntry(item.name);
  if (!label || label.name !== item.name || label.specification !== item.specification ||
    label.fingerprint !== item.evidenceFingerprint || !item.evidence?.source.includes(`[${item.evidenceId}]`)) return undefined;
  const canonicalRisk = [label.contraindication, label.precaution, label.pregnancyLactation, label.interaction]
    .filter(Boolean).join("；").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 800);
  if (!canonicalRisk) return undefined;
  // This parses punctuation boundaries, not clinical language. Existing patient grounding may
  // rewrite one clause; only whole remaining clauses equal to the governed label are references.
  // Never remove a label substring embedded in a patient-specific sentence, or an extra copy.
  const clauses = (text: string) => text.split(/([。；;])/);
  const available = new Map<string, number>();
  for (const clause of clauses(canonicalRisk).filter((_, index) => index % 2 === 0)) {
    if (clause.trim()) available.set(clause.trim(), (available.get(clause.trim()) || 0) + 1);
  }
  return clauses(item.riskNote).map((clause, index) => {
    if (index % 2 !== 0) return clause;
    const remaining = available.get(clause.trim()) || 0;
    if (!remaining) return clause;
    available.set(clause.trim(), remaining - 1);
    return "";
  }).join("");
}

