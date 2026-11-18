import "server-only";
import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { engineeringJargonInText, governedTreatmentMethodOccurrencesInText, resolveNationalStandardTcmSyndromeTerm, treatmentMethodsShareLineage } from "./clinical-governance-tables";
import { findInternalEngineeringTags } from "./internal-tag-hygiene";
import { isGenericClinicalDescription, withoutDenialsOfRecordedFindings, withoutUnrecordedNormalCommentary } from "./diagnosis-visible-summary";
import { projectDeliveredReasoning, withoutOrphanMechanismFragments, withoutTrailingFragment, withoutUnrecordedCourseAndLocation } from "./delivered-surface";
import { identifyKnownFormulaNames } from "./tcm-formula-provenance";
import { lineageWordingMatchingDirection } from "./lineage-formula-wording";
import { isLineageLensSentence, LINEAGE_LENS_SUBJECT, lineageLensSubject } from "./tcm-lineages";
import { recordedFindingReading } from "./diagnosis-safety";
import { CHINESE_NUMERAL_BEFORE_UNIT, PATIENT_SELF_REFERENCE } from "./clinical-polarity";
import { filterAnsweredFinalRationaleUncertainties } from "./pathogenesis-columns";
import namesLexicon from "../data/tcm-syndrome-lexicon.json";
import criteriaLexicon from "../data/tcm-diagnostics-syndrome-criteria.json";
import rules from "../data/m03-final-rationale-policy.source.json";
import redFlagTerms from "../data/redflag-discriminators.source.json";
import { TCM_INSPECTION_AXES } from "./tcm-inspection-lexicon";
import { bindRationaleQuote, GOVERNED_FINDINGS, isNormalInspection, rationaleElements, recordedRationaleSitePain, type BoundQuote, type FinalRationaleContext, type Finding, type Inspection } from "./m03-final-rationale-context.server";
import { parseRationaleOutline, type FinalRationaleOutline, type RationaleRejection } from "./m03-final-rationale-outline.server";

export type RationalePair = { tcmDiseaseRationale: string; tcmDiagnosticRationale: string };
export type RationaleVerdict = { ok: true; pair: RationalePair } | { ok: false; reasons: RationaleRejection[] };
const placeholder = /\{\{(q[1-9]\d?)\}\}/gu;
const idsIn = (value: string) => [...value.matchAll(placeholder)].map((match) => match[1]);
const bare = (value: string) => value.replace(placeholder, " ").trim();
const hanCount = (value: string) => (value.match(/\p{Script=Han}/gu) || []).length;
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

type Quotes = Record<string, BoundQuote>;
const covers = (quote: BoundQuote, finding: Finding) => quote.line === finding.line &&
  quote.at <= finding.at && quote.end >= finding.at + finding.term.length;
const sameOccurrence = (a: BoundQuote, b: BoundQuote) => a.line === b.line && a.at < b.end && b.at < a.end;
function distinctQuotes(refs: string[], quotes: Quotes): number {
  const distinct: BoundQuote[] = [];
  for (const id of refs) {
    const quote = quotes[id];
    if (quote && !distinct.some((prior) => sameOccurrence(prior, quote))) distinct.push(quote);
  }
  return distinct.length;
}
const textbookLanguage = new RegExp(rules.textbookGeneralization, "u");
const patientQualifiers = new RegExp(rules.patientQualifiers, "u");
const recurrence = new RegExp(rules.recurrenceAssertion, "u");
const fatigueTerms = new Set(redFlagTerms.quoteAnchors.fatigueFraming);
const tongueTermAffix = new RegExp(rules.tongueTermAffix, "gu");
const inspectionTerms = Object.fromEntries(TCM_INSPECTION_AXES.map((axis) =>
  [axis.field, new Set([...axis.groups.flatMap((group) => group.terms), ...axis.normal.split(/[，、]/u)])]));

function recordedInspectionWording(term: string, context: FinalRationaleContext): boolean {
  if (/^舌[^苔]+苔.+/u.test(term) && term.split(/(?=苔)/u).every((part) =>
    context.input.tongue.some((finding) => finding.term.includes(part)))) return true;
  return (["tongue", "pulse"] as const).some((field) => {
    if (!inspectionTerms[field].has(term)) return false;
    // The governed axis allows both a prefix and a suffix (e.g. 脉细 / 细脉).
    const prefixOrSuffix = field === "tongue" ? tongueTermAffix : /^脉|脉$/gu;
    const component = term.replace(prefixOrSuffix, "");
    return Boolean(component && component !== term && context.input[field].some((finding) =>
      finding.term.replace(prefixOrSuffix, "").includes(component)));
  });
}
const isTextbookGeneralization = (clause: string, at: number, whole: string) =>
  !idsIn(clause).length && !PATIENT_SELF_REFERENCE.test(clause) &&
  (textbookLanguage.test(clause) || /^若/u.test(clause) || isGenericClinicalDescription(at + clause.length, whole));

function bareFindingProblem(value: string, context: FinalRationaleContext, allowTextbook: boolean):
  { phrase: string; code: "text_unquoted_finding" | "text_record_boundary" } | undefined {
  const metadata = [context.input.conclusion.disease, ...context.input.conclusion.names].sort((a, b) => b.length - a.length);
  const terms = new Set([...GOVERNED_FINDINGS, ...context.facts.map((item) => item.term), ...context.input.chief.map((item) => item.term)]);
  for (const match of value.matchAll(/[^，,。；;！？\n]+/gu)) {
    if (allowTextbook && isTextbookGeneralization(match[0], match.index, value)) continue;
    const phrase = bare(match[0]);
    let clause = phrase;
    for (const name of metadata) clause = clause.replaceAll(name, " ");
    const qualifier = patientQualifiers.exec(clause)?.[0]?.trim();
    if (/\d/u.test(clause) || [...clause.matchAll(CHINESE_NUMERAL_BEFORE_UNIT)].length ||
      (qualifier && !context.recordText.includes(qualifier)) ||
      (recurrence.test(clause) && !context.recordText.includes("反复"))) return { phrase, code: "text_unquoted_finding" };
    for (const term of terms) {
      if (!clause.includes(term)) continue;
      const reading = recordedFindingReading(context.recordText, term);
      if (reading === "affirmed" && recordedFindingReading(clause, term) === "denied") return { phrase, code: "text_record_boundary" };
      if (reading === "affirmed" || reading === "conflicting") continue;
      if (boundedGap.test(clause) && !PATIENT_SELF_REFERENCE.test(clause) && reading === "absent") continue;
      if (reading === "absent" && (recordedInspectionWording(term, context) || recordedRationaleSitePain(context, term) ||
        (fatigueTerms.has(term) && [...fatigueTerms].some((other) => recordedFindingReading(context.recordText, other) === "affirmed")))) continue;
      return { phrase, code: "text_unquoted_finding" };
    }
  }
}

function foreignSyndromeIn(value: string, allowed: readonly string[]): string | undefined {
  let remaining = bare(value);
  for (const name of [...allowed].sort((a, b) => b.length - a.length)) remaining = remaining.replaceAll(name, " ");
  const named = namedSyndromes.find((name) => remaining.includes(name));
  if (named) return named;
  for (const match of remaining.matchAll(anchoredSyndrome)) {
    const text = match[1].replace(new RegExp(rules.syndromePredicateTail, "u"), "");
    if (resolveNationalStandardTcmSyndromeTerm(text)) return text;
  }
}

const primaryRole = new RegExp(rules.primaryRole, "u");
const secondaryRole = new RegExp(rules.secondaryRole, "u");
function hasRoleReversal(value: string, names: readonly string[]): boolean {
  const nameOrder = [...names].sort((a, b) => b.length - a.length);
  for (const segment of bare(value).split(/[，,。；;、]/u)) {
    const mentions = nameOrder.flatMap((name) => {
      const at = segment.indexOf(name);
      return at < 0 ? [] : [{ name, at, end: at + name.length }];
    }).sort((a, b) => a.at - b.at || b.end - a.end)
      .filter((mention, index, all) => !all.slice(0, index).some((prior) => prior.at <= mention.at && prior.end >= mention.end));
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

function verifyInspection(field: Inspection, outline: FinalRationaleOutline, quotes: Quotes, context: FinalRationaleContext, reject: Reject) {
  const key = field === "tongue" ? "t" : "p";
  const readings = context.input[field];
  const absence = new RegExp(field === "tongue" ? rules.tongueMissing : rules.pulseMissing, "u");
  const declaredMissing = bare(outline.y).match(absence)?.[0];
  if (!readings.length) {
    if (!declaredMissing) reject("inspection_missing_disclosure", key);
    return;
  }
  if (declaredMissing) reject("inspection_recorded", key, declaredMissing);
  if (outline[key]?.[0] === "s" && readings.every((finding) => isNormalInspection(field, finding))) {
    reject("inspection_normal", key, readings.map(({ term }) => term).join("、"));
  }
  const passages = clauses(outline.y).map((sentence) => ({ sentence, refs: idsIn(sentence) }));
  for (const finding of readings) {
    const references = passages.filter(({ refs }) => refs.some((id) => quotes[id] && covers(quotes[id], finding)));
    if (!references.length) reject("inspection_components", key, finding.term);
    else if (!references.some(({ sentence }) => hanCount(bare(sentence)) >= 4)) reject("inspection_meaning", key, references[0].sentence);
  }
}

function verifyDisease(outline: FinalRationaleOutline, quotes: Quotes, context: FinalRationaleContext, reject: Reject) {
  const { disease } = context.input.conclusion;
  if (!bare(outline.x).includes(disease)) reject("disease_name", "x");
  const explicitSyndrome = foreignSyndromeIn(outline.x, [disease]);
  if (explicitSyndrome) reject("disease_element", "x", explicitSyndrome);
  if (!idsIn(outline.x).some((id) => context.input.chief.some((chief) => quotes[id] && covers(quotes[id], chief)))) reject("disease_chief", "x");
  if (hanCount(bare(outline.x).replaceAll(disease, "")) < 6) reject("disease_reasoning", "x", bare(outline.x));
  for (const part of outline.x.matchAll(/[^，,。；;！？]+/gu)) {
    if (isTextbookGeneralization(part[0], part.index, outline.x)) continue;
    let claim = bare(part[0]).replaceAll(disease, "");
    if (explicitSyndrome) claim = claim.replaceAll(explicitSyndrome, "");
    if (rationaleElements.asserted(claim).length) reject("disease_element", "x", claim);
  }
}

function verifyGroups(outline: FinalRationaleOutline, quotes: Quotes, context: FinalRationaleContext, reject: Reject) {
  const names = context.input.conclusion.names;
  const used = idsIn(outline.y);
  const oneBased = outline.g[0]?.[2] === 1;
  const groups = outline.g.map(([refs, , target]) => ({
    refs, name: typeof target === "number" ? names[target - Number(oneBased)] ?? (names.length === 1 ? names[0] : undefined) : target,
  }));
  const first = groups[0];
  if (first?.name !== names[0] || !context.input.chief.some((chief) => first.refs.some((id) => quotes[id] && covers(quotes[id], chief)))) {
    reject("chief_group", "g", first?.name);
  }
  for (const { refs } of groups) {
    const missingRefs = refs.filter((id) => !quotes[id] || !used.some((usedId) => quotes[usedId] && covers(quotes[usedId], {
      line: quotes[id].line, at: quotes[id].at, term: quotes[id].text,
    })));
    if (missingRefs.length) reject("group_reference", "g", missingRefs.join("、"));
  }
  for (const name of names.slice(1)) {
    const refs = groups.filter((group) => group.name === name).flatMap((group) => group.refs);
    if (distinctQuotes(refs, quotes) < 2) reject("secondary_support", "g", name);
  }
  for (const sentence of clauses(outline.y)) {
    const count = idsIn(sentence).length;
    if (count > 6 || (count > 0 && hanCount(bare(sentence)) < 6)) reject("group_reasoning", "y", sentence);
  }
}

const attributedLineages = Object.values(LINEAGE_LENS_SUBJECT).map((subject) =>
  [subject, new RegExp(`^(?:从|按)?${subject}${rules.lineageAttributionTail}`, "u")] as const);
const attributedLineage = (part: string) => lineageLensSubject(part) ||
  attributedLineages.find(([, pattern]) => pattern.test(part))?.[0];
const lineageLens = (part: string) => isLineageLensSentence(part) || Boolean(attributedLineage(part));

function verifyLineage(outline: FinalRationaleOutline, context: FinalRationaleContext, reject: Reject) {
  const { lineage, method, formulas, direction } = context.input;
  const fullSentences = (value: string) => value.split(/[。！？]/u).map((part) => part.trim()).filter(Boolean);
  const passages = fullSentences(outline.y);
  const diseaseLens = fullSentences(outline.x).find(lineageLens);
  if (diseaseLens) reject("lineage_disease", "x", diseaseLens);
  if (!lineage) {
    const unsolicited = passages.find(lineageLens);
    if (unsolicited) reject("lineage_unsolicited", "y", unsolicited);
    return;
  }
  const final = passages.at(-1) || "";
  if (!lineageLens(final)) { reject("lineage_last", "y", final); return; }
  const subject = LINEAGE_LENS_SUBJECT[lineage.code];
  if (!(subject ? attributedLineage(final) === subject : final.includes(lineage.label))) {
    reject("lineage_subject", "y", final);
  }
  const directionNames = new Set([...identifyKnownFormulaNames(direction || ""), ...(formulas || []), ...identifyKnownFormulaNames(method || "")]);
  const wrongFormula = identifyKnownFormulaNames(bare(final)).find((name) => !directionNames.has(name));
  const probe = { ...context.root, overview: { ...context.root.overview, tcmDiagnosticRationale: final } };
  if (wrongFormula || lineageWordingMatchingDirection(probe).overview.tcmDiagnosticRationale !== final) {
    reject("lineage_formula", "y", wrongFormula || final);
  }
  const methods = governedTreatmentMethodOccurrencesInText(bare(final));
  const finalMethods = governedTreatmentMethodOccurrencesInText(`${method || ""}、${direction || ""}`);
  const wrongMethod = methods.find(({ entry }) => !finalMethods.some((allowed) => treatmentMethodsShareLineage(entry, allowed.entry)));
  if (wrongMethod) reject("lineage_method", "y", wrongMethod.entry.canonical);
}

function verifyCertainty(outline: FinalRationaleOutline, context: FinalRationaleContext, reject: Reject) {
  const { disease, names, resolution } = context.input.conclusion;
  const withdrawnDisease = clauses(bare(outline.x)).find((clause) => reassessment.test(clause) &&
    (clause.includes(disease) || new RegExp(rules.missingResolvedDisease, "u").test(clause)));
  if (resolution === "resolved" && withdrawnDisease) reject("disease_retracted", "x", withdrawnDisease);
  const withdrawnSyndrome = clauses(bare(outline.y)).find((clause) => reassessment.test(clause) &&
    (names.some((name) => clause.includes(name)) || new RegExp(rules.missingResolvedName, "u").test(clause)));
  if (resolution === "resolved" && withdrawnSyndrome) reject("syndrome_retracted", "y", withdrawnSyndrome);
  const prose = bare(outline.y);
  if (resolution === "bounded" && !(new RegExp(rules.bounded, "u").test(prose) && boundedGap.test(prose))) reject("bounded_limit", "y");
}

function changedClause(before: string, after: string): string | undefined {
  const remaining = new Set(after.split(/[，,。；;]/u).map((part) => part.trim()));
  const parts = before.split(/[，,。；;]/u).map((part) => part.trim()).filter(Boolean);
  const missingPart = parts.find((part) => !remaining.has(part));
  if (missingPart) return missingPart;
  const count = (value: string, part: string) => value.split(part).length;
  return parts.find((part) => count(before, part) !== count(after, part));
}

function verifyProse(original: string, expanded: string, field: "x" | "y", context: FinalRationaleContext, reject: Reject) {
  const size = [...expanded.replace(/\s/gu, "")].length;
  if (field === "x" ? size < 10 || size > 80 : size < 40 || size > (context.input.lineage ? 340 : 280)) reject("text_length", field);
  if (unclosed(expanded) || /[{}<>\[\]\n\r]|^\s*(?:辨病依据|辨证依据)\s*[:：]/u.test(expanded) ||
    !/。$/u.test(expanded) || endpoint.test(expanded) ||
    withoutTrailingFragment(expanded) !== expanded || withoutOrphanMechanismFragments(expanded) !== expanded) reject("text_fragment", field);
  if (engineeringJargonInText(expanded).length || findInternalEngineeringTags(expanded).length || /模型输出|提示词/u.test(expanded)) reject("text_engineering", field);
  const bareProblem = bareFindingProblem(original, context, field === "x");
  if (bareProblem) reject(bareProblem.code, field, bareProblem.phrase);
  // Course and location probes see only prose, while polarity checks also see each restored quote.
  const claim = clauses(original).filter((part) => !isTextbookGeneralization(part, 0, part)).map(bare).join("。");
  const denials = withoutDenialsOfRecordedFindings(expanded, context.recordText);
  const normal = withoutUnrecordedNormalCommentary(expanded, context.recordText);
  const qualifiers = withoutUnrecordedCourseAndLocation(claim, context.recordText);
  const probes = [[expanded, denials], [expanded, normal], [claim, qualifiers]] as const;
  const altered = probes.find(([before, after]) => before !== after);
  if (altered) reject("text_record_boundary", field, changedClause(...altered));
}

export function validateRationalePair(raw: unknown, context: FinalRationaleContext): RationaleVerdict {
  const parsed = parseRationaleOutline(raw);
  if ("reasons" in parsed) return { ok: false, reasons: parsed.reasons };
  const { outline } = parsed;
  if (outline.s === "evidence_gap") return { ok: false, reasons: [{ code: "evidence_gap", field: "s" }] };
  const reasons: RationaleRejection[] = [];
  const reject: Reject = (code, field, phrase) => {
    if (!reasons.some((reason) => reason.code === code && reason.field === field && reason.phrase === phrase)) {
      reasons.push({ code, field, ...(phrase ? { phrase } : {}) });
    }
  };
  const quotes: Quotes = {};
  const used = new Set([...idsIn(outline.x), ...idsIn(outline.y)]);
  for (const id of used) {
    const ref = outline.q[id];
    const quote = ref && bindRationaleQuote(context, ref);
    if (quote) quotes[id] = quote;
    else if (ref) reject("quote_occurrence", `q.${id}`, ref[1]);
    else reject("quote_reference", `q.${id}`, `{{${id}}}`);
  }
  if (reasons.length) return { ok: false, reasons };

  // Group declarations can use a second ID for the same record occurrence.
  for (const id of outline.g.flatMap(([refs]) => refs)) {
    if (!quotes[id] && outline.q[id]) {
      const quote = bindRationaleQuote(context, outline.q[id]);
      if (quote) quotes[id] = quote;
    }
  }
  verifyDisease(outline, quotes, context, reject);
  verifyGroups(outline, quotes, context, reject);
  verifyInspection("tongue", outline, quotes, context, reject);
  verifyInspection("pulse", outline, quotes, context, reject);
  verifyLineage(outline, context, reject);
  verifyCertainty(outline, context, reject);
  const names = context.input.conclusion.names;
  const starts = names.map((name) => bare(outline.y).indexOf(name));
  if (starts.some((at, index) => at < 0 || (index > 0 && at <= starts[index - 1])) || hasRoleReversal(outline.y, names)) reject("syndrome_name", "y");
  const foreignName = foreignSyndromeIn(outline.y, names);
  if (foreignName) reject("foreign_syndrome", "y", foreignName);
  const unsettled = new RegExp(rules.unsettledElement, "u");
  for (const part of bare(outline.y).split(/[，,。；;！？]/u).map((clause) => clause.trim())) {
    if (!unsettled.test(part) && rationaleElements.asserted(part).some((unit) => !rationaleElements.fits(unit, names))) {
      reject("foreign_element", "y", part);
    }
  }
  const expand = (value: string) => value.replace(placeholder, (_, id: string) => quotes[id].text);
  const pair = { tcmDiseaseRationale: expand(outline.x), tcmDiagnosticRationale: expand(outline.y) };
  verifyProse(outline.x, pair.tcmDiseaseRationale, "x", context, reject);
  verifyProse(outline.y, pair.tcmDiagnosticRationale, "y", context, reject);
  if (!reasons.length) {
    const candidate = withFinalRationalePair(context.root, pair, context);
    const carried = projectDeliveredReasoning({ ...candidate, stage: "prescribe" }, { recordText: context.recordText });
    if (carried.overview.tcmDiseaseRationale !== pair.tcmDiseaseRationale) reject("m04_carryover_drift", "x", changedClause(pair.tcmDiseaseRationale, carried.overview.tcmDiseaseRationale ?? ""));
    if (carried.overview.tcmDiagnosticRationale !== pair.tcmDiagnosticRationale) reject("m04_carryover_drift", "y", changedClause(pair.tcmDiagnosticRationale, carried.overview.tcmDiagnosticRationale ?? ""));
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, pair };
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
