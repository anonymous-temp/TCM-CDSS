import { originalFormulaNameKey } from "./formula-original-composition";
import { deriveFormulaDelta } from "./m04-final-snapshot";
import { withOpeningMatchingFormulaName } from "./formula-analysis-review";
import { asRecords, asText, type FormulaDelta } from "./m04-final-content-types";
import { originalHerbMatches } from "./tcm-formula-provenance";

function repeatsVerifiedChanges(sentence: string, changes: FormulaDelta["changes"]): boolean {
  return sentence.split(/[，,]/u).every(clause => {
    const mention = /^(?:并|另)?(去|加)([^，,。；;]+)$/u.exec(clause.trim());
    if (!mention) return false;
    const kind = mention[1] === "去" ? "removed" : "added";
    const names = changes.filter(change => change.kind === kind).map(change => (kind === "removed" ? change.from : change.to) || "");
    return mention[2].replace(/一味$/u, "").split("、").every(herb => names.some(name => originalHerbMatches(name, herb)));
  });
}

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
  const identity = `本方以${label}为基础加减`;
  let rest = analysis;
  if (rest.startsWith(opening)) rest = rest.slice(opening.length);
  else if (rest.startsWith(identity)) rest = rest.slice(identity.length).replace(/^[，,。；;：:]\s*/u, "");
  // 核过的原方与药表共同决定加去。旧草稿只复述这份清单、或说明为何改投自拟方的首句不能跟在成方之后。
  // 逐句保留有配伍依据的加减解释，以及单独的用药注意事项。
  for (let leading; (leading = /^([^。；;]+)[。；;]/u.exec(rest));) {
    const sentence = leading[1].trim();
    if (sentence !== `本方以${name}` && !repeatsVerifiedChanges(sentence, delta.changes) && !/(?:改以|改为|改用)自拟方$/u.test(sentence)) break;
    rest = rest.slice(leading[0].length);
  }
  return opening + rest;
}

