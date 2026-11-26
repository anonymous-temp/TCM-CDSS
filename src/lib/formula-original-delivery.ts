import { originalFormulaNameKey } from "./formula-original-composition";
import { deriveFormulaDelta } from "./m04-final-snapshot";
import { withOpeningMatchingFormulaName } from "./formula-analysis-review";
import { asRecords, asText } from "./m04-final-content-types";

/** Bind the public opening to the final name and versioned original composition. */
export function finalFormulaOpening(candidate: Record<string, unknown>, modifications: unknown = []): string {
  const name = asText(candidate.name);
  const analysis = withOpeningMatchingFormulaName(asText(candidate.formulaAnalysis), name).text;
  const label = originalFormulaNameKey(name);
  if (!analysis || label === name || !asRecords(candidate.herbs).length) return analysis;
  const bases = asRecords(candidate.baseFormulas);
  if (!bases.length || bases.map((base) => asText(base.name)).join("合") !== label) return analysis;
  const delta = deriveFormulaDelta({ ...candidate, _formula: { modifications } }, { record: "", prior: {} });
  if (delta.status !== "known") return analysis;
  const parts = [
    ["去", delta.changes.filter((change) => change.kind === "removed").map((change) => change.from)],
    ["加", delta.changes.filter((change) => change.kind === "added").map((change) => change.to)],
  ] as const;
  const edits = parts.flatMap(([verb, names]) => names.length ? [verb + [...new Set(names)].join("、")] : []);
  if (!edits.length) return analysis;
  const opening = `本方以${label}为基础，${edits.join("，")}。`;
  if (analysis.startsWith(opening)) return analysis;
  const identity = `本方以${label}为基础加减`;
  if (analysis.startsWith(identity)) {
    const rest = analysis.slice(identity.length).replace(/^[，,。；;：:]\s*/u, "");
    return opening + rest;
  }
  // Preserve authored reasons. When there is no identity sentence, prepend the verified delta.
  return opening + analysis;
}
