import "server-only";
import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { engineeringJargonInText, governedTreatmentMethodOccurrencesInText, resolveNationalStandardTcmSyndromeTerm, treatmentMethodsShareLineage } from "./clinical-governance-tables";
import { findInternalEngineeringTags } from "./internal-tag-hygiene";
import { projectDeliveredReasoning, withoutOrphanMechanismFragments, withoutTrailingFragment } from "./delivered-surface";
import { identifyKnownFormulaNames } from "./tcm-formula-provenance";
import { lineageWordingMatchingDirection } from "./lineage-formula-wording";
import { isLineageLensSentence, lineageLensSubject } from "./tcm-lineages";
import { clauseLocalMentionPolarityAt } from "./diagnosis-safety";
import { filterAnsweredFinalRationaleUncertainties } from "./pathogenesis-columns";
import namesLexicon from "../data/tcm-syndrome-lexicon.json";
import criteriaLexicon from "../data/tcm-diagnostics-syndrome-criteria.json";
import rules from "../data/m03-final-rationale-policy.source.json";
import { hasCurrentRationaleQuote, type FinalRationaleContext, type Inspection } from "./m03-final-rationale-context.server";
import { unsupportedRationaleElements } from "./m03-final-rationale-elements.server";
import { rationaleMentionsChiefSymptom } from "./m03-rationale-coverage.server";
import { parseRationaleOutline, type RationaleProse, type RationaleRejection } from "./m03-final-rationale-outline.server";

export type RationalePair = { tcmDiseaseRationale: string; tcmDiagnosticRationale: string };
export type RationaleVerdict = { ok: true; pair: RationalePair; softAccepted?: true; reasons?: RationaleRejection[] }
  | { ok: false; reasons: RationaleRejection[] };
export const rationaleLength = (value: string) => [...value.replace(/\s/gu, "")].length;
const clauses = (value: string) => value.split(/[。；;]/u).map((clause) => clause.trim()).filter(Boolean);
const unclosed = (value: string) => [["（", "）"], ["(", ")"], ["“", "”"], ["「", "」"], ["《", "》"]].some(([left, right]) =>
  value.split(left).length !== value.split(right).length);
const reassessment = new RegExp(rules.reassessment, "u");
const boundedGap = new RegExp(rules.boundedGap, "u");
const endpoint = /[属为示见因与从以由呈伴并且及而、，：；]作?\s*。$/u;
const anchoredSyndrome = new RegExp(rules.namedSyndromeLead, "gu");
const namedSyndromes = [...new Set([
  ...namesLexicon.entries.filter((row) => row.termClass === "clinical_term").flatMap((row) =>
    [row.standardTerm, ...("standardAliases" in row ? row.standardAliases || [] : [])]),
  ...criteriaLexicon.entries.map((row) => row.name),
  ...Object.keys(criteriaLexicon.aliases),
])].filter((name) => name.endsWith("证")).sort((a, b) => b.length - a.length);

function hasForeignSyndrome(value: string, allowed: readonly string[], anyMention = false): string | undefined {
  let remaining = value;
  for (const name of [...allowed].sort((a, b) => b.length - a.length)) remaining = remaining.replaceAll(name, " ");
  const named = namedSyndromes.find((name) => {
    const at = remaining.indexOf(name);
    if (at < 0) return false;
    if (anyMention || name !== "表证") return true;
    // A diagnostic axis in a missing-data clause is not a second named syndrome.
    return !boundedGap.test(remaining.slice(at).split(/[。；;]/u)[0]) &&
      clauseLocalMentionPolarityAt(remaining, at) === "affirmed";
  });
  if (named) return named;
  for (const match of remaining.matchAll(anchoredSyndrome)) {
    const text = match[1].replace(new RegExp(rules.syndromePredicateTail, "u"), "");
    if (resolveNationalStandardTcmSyndromeTerm(text)) return text;
  }
}

const primaryRole = new RegExp(rules.primaryRole, "u");
const secondaryRole = new RegExp(rules.secondaryRole, "u");
function syndromeMentions(value: string, names: readonly string[]) {
  const mentions = names.flatMap((name) => {
    const positions: Array<{ name: string; at: number; end: number }> = [];
    if (!name) return positions;
    for (let at = value.indexOf(name); at !== -1; at = value.indexOf(name, at + name.length)) {
      positions.push({ name, at, end: at + name.length });
    }
    return positions;
  }).sort((a, b) => a.at - b.at || b.end - a.end);
  return mentions.filter((mention, index) =>
    !mentions.slice(0, index).some((prior) => prior.at <= mention.at && prior.end >= mention.end));
}

function hasRoleReversal(value: string, names: readonly string[]): boolean {
  for (const segment of value.split(/[，,。；;、]/u)) {
    const mentions = syndromeMentions(segment, names);
    for (const [index, { name, at, end }] of mentions.entries()) {
      const before = segment.slice(mentions[index - 1]?.end ?? 0, at).trim();
      const after = segment.slice(end, mentions[index + 1]?.at).trim();
      if (name === names[0] && (secondaryRole.test(before) || /兼$/u.test(before) || /^为兼证/u.test(after))) return true;
      if (name !== names[0] && (primaryRole.test(before) || /^为主证/u.test(after))) return true;
    }
  }
  return false;
}

type Reject = (code: string, field: string, phrase?: string) => void;

const inspectionProse = {
  tongue: { marker: "舌", missing: new RegExp(rules.tongueMissing, "u"), affix: new RegExp(rules.tongueTermAffix, "gu") },
  pulse: { marker: "脉", missing: new RegExp(rules.pulseMissing, "u"), affix: /^脉|脉$/gu },
};

/** A component may be compacted or reordered in prose. Count its characters without its field label. */
function verifyInspection(field: Inspection, prose: string, context: FinalRationaleContext, reject: Reject) {
  const key = field === "tongue" ? "t" : "p";
  const readings = context.input[field];
  const { marker, missing, affix } = inspectionProse[field];
  const declaredMissing = prose.match(missing)?.[0];
  if (!readings.length) {
    if (!declaredMissing) reject("inspection_missing_disclosure", key);
    return;
  }
  const passages = clauses(prose).filter((clause) => clause.includes(marker));
  if (declaredMissing || !passages.length || readings.some(({ term }) => {
    const component = [...term.replace(affix, "").replace(/[^\p{Script=Han}]/gu, "")];
    return !passages.some((passage) => component.filter((char) => passage.includes(char)).length * 2 >= component.length);
  })) reject("inspection_recorded", key, declaredMissing);
}

const lineageSubjects = Object.entries(rules.lineageAliases).flatMap(([code, aliases]) =>
  aliases.map((subject) => [code, subject, new RegExp(`^(?:从|按)?${subject}${rules.lineageAttributionTail}`, "u")] as const));
const attributedLineage = (part: string) => lineageSubjects.find(([, subject, pattern]) =>
  lineageLensSubject(part, [subject]) === subject || pattern.test(part))?.[0];
const lineageLens = (part: string) => isLineageLensSentence(part) || Boolean(attributedLineage(part));
const lineagePassages = (value: string) => clauses(value).filter(lineageLens);
const lineageDoesNotApply = new RegExp(rules.lineageDoesNotApply, "u");
const negativeLineageTreatment = new RegExp(rules.negativeLineageTreatment, "u");

function verifyLineage(outline: RationaleProse, context: FinalRationaleContext, reject: Reject) {
  const { lineage, method, formulas, direction } = context.input;
  const embedded = lineagePassages(outline.y)[0];
  const diseaseLens = lineagePassages(outline.x)[0];
  if (diseaseLens) reject("lineage_disease", "x", diseaseLens);
  if (!lineage) {
    const unsolicited = embedded || outline.l;
    if (unsolicited !== null && unsolicited !== undefined) reject("lineage_unsolicited", embedded ? "y" : "l", unsolicited);
    return;
  }
  if (embedded) reject("lineage_embedded", "y", embedded);
  const final = outline.l?.trim();
  if (!final) { reject("lineage_last", "l"); return; }
  if (/[。！？]/u.test(final.slice(0, -1))) reject("lineage_last", "l", final);
  if (attributedLineage(final) !== lineage.code) reject("lineage_subject", "l", final);
  if (lineage.adaptation?.applicable === "not-applicable" && !lineageDoesNotApply.test(final)) reject("lineage_applicability", "l", final);
  const directionNames = new Set([...identifyKnownFormulaNames(direction || ""), ...(formulas || []), ...identifyKnownFormulaNames(method || "")]);
  const theory = lineageSubjects.find(([code, , pattern]) => code === lineage.code && pattern.test(final))?.[2];
  const recommendations = (theory ? final.replace(theory, "") : final).split(/[，,。；;]/u).filter((clause) => !negativeLineageTreatment.test(clause));
  const wrongFormula = recommendations.flatMap(identifyKnownFormulaNames).find((name) => !directionNames.has(name));
  const probe = { ...context.root, overview: { ...context.root.overview, tcmDiagnosticRationale: final } };
  if (wrongFormula || lineageWordingMatchingDirection(probe).overview.tcmDiagnosticRationale !== final) {
    reject("lineage_formula", "l", wrongFormula || final);
  }
  const methods = recommendations.flatMap(governedTreatmentMethodOccurrencesInText);
  const finalMethods = governedTreatmentMethodOccurrencesInText(`${method || ""}、${direction || ""}`);
  const wrongMethod = methods.find(({ entry }) => !finalMethods.some((allowed) => treatmentMethodsShareLineage(entry, allowed.entry)));
  if (wrongMethod) reject("lineage_method", "l", wrongMethod.entry.canonical);
}

function verifyCertainty({ x, y, l }: RationaleProse, context: FinalRationaleContext, reject: Reject) {
  const { disease, names, resolution } = context.input.conclusion;
  if (resolution !== "resolved") return;
  const withdrawnDisease = clauses(x).find((clause) => reassessment.test(clause) &&
    (clause.includes(disease) || new RegExp(rules.missingResolvedDisease, "u").test(clause)));
  if (withdrawnDisease) reject("disease_retracted", "x", withdrawnDisease);
  for (const [field, value] of [["y", y], ["l", l || ""]] as const) {
    const withdrawnSyndrome = clauses(value).find((clause) => reassessment.test(clause) &&
      (names.some((name) => clause.includes(name)) || new RegExp(rules.missingResolvedName, "u").test(clause)));
    if (withdrawnSyndrome) reject("syndrome_retracted", field, withdrawnSyndrome);
  }
}

function verifySentence(value: string, field: string, reject: Reject) {
  if (unclosed(value) || /[{}<>\[\]\n\r]|^\s*(?:辨病依据|辨证依据)\s*[:：]/u.test(value) ||
    !/。$/u.test(value) || endpoint.test(value) ||
    withoutTrailingFragment(value) !== value || withoutOrphanMechanismFragments(value) !== value) reject("text_fragment", field);
  if (engineeringJargonInText(value).length || findInternalEngineeringTags(value).length || /模型输出|提示词/u.test(value)) reject("text_engineering", field);
  const internal = value.match(new RegExp(rules.internalRationaleWording, "u"))?.[0];
  if (internal) reject("text_internal", field, internal);
}

export function validateRationaleProse(prose: RationaleProse, context: FinalRationaleContext): RationaleVerdict {
  const { x, y, l } = prose;
  const { disease, names } = context.input.conclusion;
  const reasons: RationaleRejection[] = [];
  const reject: Reject = (code, field, phrase) => reasons.push({ code, field, ...(phrase ? { phrase } : {}) });
  if (!x.includes(disease)) reject("disease_name", "x");
  const diseaseSyndrome = hasForeignSyndrome(x, [disease], true);
  if (diseaseSyndrome) reject("disease_element", "x", diseaseSyndrome);
  const mentions = syndromeMentions(y, names);
  const starts = names.map((name) => mentions.find((mention) => mention.name === name)?.at ?? -1);
  if (starts.some((at, index) => at < 0 || (index > 0 && at <= starts[index - 1])) || hasRoleReversal(y, names)) reject("syndrome_name", "y");
  if (l && hasRoleReversal(l, names)) reject("syndrome_name", "l");
  for (const [field, value] of [["y", y], ["l", l || ""]] as const) {
    const foreignName = hasForeignSyndrome(value, names);
    if (foreignName) reject("foreign_syndrome", field, foreignName);
  }
  for (const [field, value] of [["x", x], ["y", y]] as const) {
    if (!context.input.chief.some(({ term }) => rationaleMentionsChiefSymptom(value, term))) reject("chief_missing", field);
  }
  verifyInspection("tongue", y, context, reject);
  verifyInspection("pulse", y, context, reject);
  verifyCertainty(prose, context, reject);
  verifyLineage(prose, context, reject);
  const xLength = rationaleLength(x);
  const yLength = rationaleLength(y);
  if (xLength < 20 || xLength > 90) reject("text_length", "x");
  if (yLength < 100 || yLength > 300) reject("text_length", "y");
  if (l && yLength + rationaleLength(l) > 360) reject("text_length", "l");
  verifySentence(x, "x", reject);
  verifySentence(y, "y", reject);
  if (l) verifySentence(l, "l", reject);
  if (reasons.length) return { ok: false, reasons };

  const pair = { tcmDiseaseRationale: x, tcmDiagnosticRationale: y + (l || "") };
  const candidate = withFinalRationalePair(context.root, pair, context);
  const carried = projectDeliveredReasoning({ ...candidate, stage: "prescribe" }, { recordText: context.recordText });
  if (carried.overview.tcmDiseaseRationale !== pair.tcmDiseaseRationale) reject("m04_carryover_drift", "x");
  if (carried.overview.tcmDiagnosticRationale !== pair.tcmDiagnosticRationale) reject("m04_carryover_drift", "y");
  return reasons.length ? { ok: false, reasons } : { ok: true, pair };
}

export function validateRationalePair(raw: unknown, context: FinalRationaleContext, { revision = false } = {}): RationaleVerdict {
  const parsed = parseRationaleOutline(raw);
  if (!parsed.outline) return { ok: false, reasons: parsed.reasons };
  const { outline } = parsed;
  const verdict = validateRationaleProse(outline, context);
  const reasons = verdict.ok ? [] : verdict.reasons;
  const evidence = [
    ...outline.d.map((quote) => ({ quote, field: "d" })),
    ...outline.g.flatMap(([quotes]) => quotes.map((quote) => ({ quote, field: "g" }))),
  ];
  const alignment = new Map([...new Set(evidence.map(({ quote }) => quote))]
    .map((quote) => [quote, hasCurrentRationaleQuote(context, quote)]));
  const unaligned = evidence.filter(({ quote }) => !alignment.get(quote));
  if (unaligned.length * 3 > evidence.length) {
    for (const { field, quote } of unaligned) reasons.push({ code: "quote_occurrence", field, phrase: quote });
  }
  if (reasons.length || !verdict.ok) return { ok: false, reasons };

  for (const [field, value] of [["y", outline.y], ...outline.g.map(([, mechanism]) => ["g", mechanism] as const)] as const) {
    for (const { phrase } of unsupportedRationaleElements(value, context.elements, context.recordText)) {
      if (!reasons.some((reason) => reason.field === field && reason.phrase === phrase)) reasons.push({ code: "foreign_element", field, phrase });
    }
  }
  if (!reasons.length) return verdict;
  return revision ? { ...verdict, softAccepted: true, reasons } : { ok: false, reasons };
}

export function withFinalRationalePair(root: ClinicalReasoningResultV2, pair: RationalePair, context: FinalRationaleContext): ClinicalReasoningResultV2 {
  const currentRecord = context.lines.filter((line) => line.current).map((line) => line.context).join("\n");
  const rows = root.pathogenesis.uncertainties;
  const uncertainties = rows && filterAnsweredFinalRationaleUncertainties(rows, currentRecord, root);
  return {
    ...root,
    overview: { ...root.overview, ...pair },
    pathogenesis: uncertainties === rows ? root.pathogenesis : { ...root.pathogenesis, uncertainties },
  };
}
