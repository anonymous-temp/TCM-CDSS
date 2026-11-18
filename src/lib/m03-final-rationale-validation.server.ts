import "server-only";
import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { engineeringJargonInText, governedTreatmentMethodOccurrencesInText, resolveNationalStandardTcmSyndromeTerm, treatmentMethodsShareLineage } from "./clinical-governance-tables";
import { findInternalEngineeringTags } from "./internal-tag-hygiene";
import { isGenericClinicalDescription, withoutDenialsOfRecordedFindings, withoutUnrecordedNormalCommentary } from "./diagnosis-visible-summary";
import { projectDeliveredReasoning, withoutOrphanMechanismFragments, withoutTrailingFragment, withoutUnrecordedCourseAndLocation } from "./delivered-surface";
import { identifyKnownFormulaNames } from "./tcm-formula-provenance";
import { lineageWordingMatchingDirection } from "./lineage-formula-wording";
import { isLineageLensSentence, lineageLensSubject } from "./tcm-lineages";
import { recordedFindingReading, clauseLocalMentionPolarityAt } from "./diagnosis-safety";
import { CHINESE_NUMERAL_BEFORE_UNIT, PATIENT_SELF_REFERENCE } from "./clinical-polarity";
import { filterAnsweredFinalRationaleUncertainties } from "./pathogenesis-columns";
import namesLexicon from "../data/tcm-syndrome-lexicon.json";
import criteriaLexicon from "../data/tcm-diagnostics-syndrome-criteria.json";
import rules from "../data/m03-final-rationale-policy.source.json";
import redFlagTerms from "../data/redflag-discriminators.source.json";
import { TCM_INSPECTION_AXES } from "./tcm-inspection-lexicon";
import { bindRationaleQuote, GOVERNED_FINDINGS, inspectionUnavailable, isNormalInspection, recordedRationaleSitePain, type BoundQuote, type FinalRationaleContext, type Finding, type Inspection } from "./m03-final-rationale-context.server";
import { unsupportedRationaleElements } from "./m03-final-rationale-elements.server";
import { parseRationaleOutline, type FinalRationaleOutline, type RationaleRejection } from "./m03-final-rationale-outline.server";

export type RationalePair = { tcmDiseaseRationale: string; tcmDiagnosticRationale: string };
export type RationaleVerdict = { ok: true; pair: RationalePair; softAccepted?: true; reasons?: RationaleRejection[] }
  | { ok: false; reasons: RationaleRejection[] };
type ValidationOptions = { revision?: boolean; legacyLayout?: boolean };
const softCodes = new Set(["foreign_element", "inspection_normal", "group_repeated_finding", "secondary_support", "inspection_adjacent_excerpt"]);
export const isSoftRationaleRejection = ({ code }: RationaleRejection) => softCodes.has(code);
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
const diseaseDefinition = new RegExp(rules.explicitDiseaseDefinition, "u");
const bareNegation = new RegExp(rules.bareNegation, "u");
const explicitFinding = new RegExp(rules.findingAssertionLead, "u");
const equivalents: Record<string, string[]> = rules.affirmedFindingEquivalents;
const frequentNocturnalUrination = new RegExp(rules.frequentNocturnalUrination, "gu");
const internalRationale = new RegExp(rules.internalRationaleWording, "u");
const legacyUnexplained = new RegExp(rules.legacyUnexplainedWording, "u");
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

function bareFindingProblem(value: string, context: FinalRationaleContext, allowTextbook: boolean, requireQuote = false):
  { phrase: string; code: "text_unquoted_finding" | "text_record_boundary" | "lineage_unquoted_finding" } | undefined {
  const metadata = [context.input.conclusion.disease, ...context.input.conclusion.names].sort((a, b) => b.length - a.length);
  const terms = new Set([...GOVERNED_FINDINGS, ...context.facts.map((item) => item.term), ...context.input.chief.map((item) => item.term)]);
  for (const match of value.matchAll(/[^，,。；;！？\n]+/gu)) {
    const phrase = bare(match[0]);
    if (allowTextbook && !bareNegation.test(phrase) && (isTextbookGeneralization(match[0], match.index, value) ||
      (diseaseDefinition.test(phrase) && !PATIENT_SELF_REFERENCE.test(phrase)))) continue;
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
      const termAt = clause.indexOf(term);
      const lead = clause.slice(0, termAt);
      if (boundedGap.test(clause) && !bareNegation.test(clause) && !PATIENT_SELF_REFERENCE.test(clause) &&
        !explicitFinding.test(lead) && reading === "absent") continue;
      if (requireQuote && (reading === "affirmed" || reading === "conflicting")) return { phrase, code: "lineage_unquoted_finding" };
      if (reading === "affirmed" || reading === "conflicting") continue;
      const variants = [...(equivalents[term] || []), ...(term === "尿频"
        ? [...context.recordText.matchAll(frequentNocturnalUrination)].map(([matched]) => matched) : [])];
      if (reading === "absent" && (recordedInspectionWording(term, context) || recordedRationaleSitePain(context, term) ||
        variants.some((variant) => recordedFindingReading(context.recordText, variant) === "affirmed") ||
        (fatigueTerms.has(term) && [...fatigueTerms].some((other) => recordedFindingReading(context.recordText, other) === "affirmed")))) {
        if (requireQuote) return { phrase, code: "lineage_unquoted_finding" };
        continue;
      }
      return { phrase, code: "text_unquoted_finding" };
    }
  }
}

function hasForeignSyndrome(value: string, allowed: readonly string[], anyMention = false): string | undefined {
  let remaining = bare(value);
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
  const manifestations = context.elements.row?.[field] || context.elements.row?.manifestations || "";
  const typical = readings.some(({ term }) => {
    const normalized = (text: string) => text.replace(tongueTermAffix, "").replace(/^脉|脉$/gu, "");
    const reading = normalized(term);
    return Boolean(reading && manifestations.split(/[，、；。]/u).some((part) => normalized(part.trim()) === reading));
  });
  if (outline[key]?.[0] === "s" && readings.every((finding) => isNormalInspection(field, finding)) && !typical) {
    reject("inspection_normal", key, readings.map(({ term }) => term).join("、"));
  }
  const passages = clauses(outline.y).map((sentence) => ({ sentence, refs: idsIn(sentence) }));
  for (const finding of readings) {
    const references = passages.filter(({ refs }) => refs.some((id) => quotes[id] && covers(quotes[id], finding)));
    if (!references.length) reject("inspection_components", key, finding.term);
    else if (!references.some(({ sentence }) => hanCount(bare(sentence)) >= 4)) reject("inspection_meaning", key, references[0].sentence);
  }
  const slot = outline[key];
  if (slot && slot[0] !== "u") {
    for (const id of slot[1]) {
      const quote = quotes[id];
      const isInspectionPart = (finding: Finding) => covers(quote, finding);
      if (quote && readings.some(isInspectionPart) && [...context.input.chief, ...context.input.important].some(isInspectionPart)) {
        reject("inspection_adjacent_excerpt", key, quote.text);
      }
    }
  }
}

function verifyDisease(outline: FinalRationaleOutline, quotes: Quotes, context: FinalRationaleContext, reject: Reject) {
  const { disease } = context.input.conclusion;
  if (!bare(outline.x).includes(disease)) reject("disease_name", "x");
  const explicitSyndrome = hasForeignSyndrome(outline.x, [disease], true);
  if (explicitSyndrome) reject("disease_element", "x", explicitSyndrome);
  if (!idsIn(outline.x).some((id) => context.input.chief.some((chief) => quotes[id] && covers(quotes[id], chief)))) reject("disease_chief", "x");
  if (hanCount(bare(outline.x).replaceAll(disease, "")) < 6) reject("disease_reasoning", "x", bare(outline.x));
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
  for (const [index, { refs }] of groups.entries()) {
    const mechanism = outline.g[index][1];
    const repeated = refs.map((id) => quotes[id]).find((quote) => quote && quote.term.length >= 2 &&
      mechanism.split(/[，,。；;]/u).some((clause) => clause.trim() === quote.term) &&
      recordedFindingReading(context.recordText, quote.term) === "affirmed");
    if (repeated) reject("group_repeated_finding", "g", mechanism);
    const represented = refs.some((id) => {
      const quote = quotes[id];
      if (!quote) return false;
      const anchor = { ...quote, at: quote.at + quote.text.indexOf(quote.term) };
      return used.some((usedId) => quotes[usedId] && covers(quotes[usedId], anchor));
    });
    if (!represented) reject("group_reference", "g", refs.join("、"));
  }
  for (const name of names.slice(1)) {
    const refs = groups.filter((group) => group.name === name).flatMap((group) => group.refs);
    if (distinctQuotes(refs, quotes) < 2) reject("secondary_support", "g", name);
  }
  for (const sentence of clauses(outline.y)) {
    const count = idsIn(sentence).length;
    const reasoning = names.reduce((value, name) => value.replaceAll(name, ""), bare(sentence));
    if (count > 6 || (count > 0 && hanCount(reasoning) < 4)) reject("group_reasoning", "y", sentence);
  }
}

const lineageSubjects = Object.entries(rules.lineageAliases).flatMap(([code, aliases]) =>
  aliases.map((subject) => [code, subject, new RegExp(`^(?:从|按)?${subject}${rules.lineageAttributionTail}`, "u")] as const));
const attributedLineage = (part: string) => lineageSubjects.find(([, subject, pattern]) =>
  lineageLensSubject(part, [subject]) === subject || pattern.test(part))?.[0];
const lineageLens = (part: string) => isLineageLensSentence(part) || Boolean(attributedLineage(part));
const lineagePassages = (value: string) => clauses(value).filter(lineageLens);
const lineageDoesNotApply = new RegExp(rules.lineageDoesNotApply, "u");
const negativeLineageTreatment = new RegExp(rules.negativeLineageTreatment, "u");

function verifyLineage(outline: FinalRationaleOutline, context: FinalRationaleContext, reject: Reject) {
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
  if (lineage.adaptation?.applicable === "not-applicable" && !lineageDoesNotApply.test(bare(final))) reject("lineage_applicability", "l", final);
  const directionNames = new Set([...identifyKnownFormulaNames(direction || ""), ...(formulas || []), ...identifyKnownFormulaNames(method || "")]);
  const theory = lineageSubjects.find(([code, , pattern]) => code === lineage.code && pattern.test(final))?.[2];
  const recommendations = bare(theory ? final.replace(theory, "") : final).split(/[，,。；;]/u).filter((clause) => !negativeLineageTreatment.test(clause));
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

function verifyCertainty(outline: FinalRationaleOutline, context: FinalRationaleContext, reject: Reject) {
  const { disease, names, resolution } = context.input.conclusion;
  const withdrawnDisease = clauses(bare(outline.x)).find((clause) => reassessment.test(clause) &&
    (clause.includes(disease) || new RegExp(rules.missingResolvedDisease, "u").test(clause)));
  if (resolution === "resolved" && withdrawnDisease) reject("disease_retracted", "x", withdrawnDisease);
  if (resolution === "resolved") for (const field of ["y", "l"] as const) {
    const withdrawnSyndrome = clauses(bare(outline[field] || "")).find((clause) => reassessment.test(clause) &&
      (names.some((name) => clause.includes(name)) || new RegExp(rules.missingResolvedName, "u").test(clause)));
    if (withdrawnSyndrome) reject("syndrome_retracted", field, withdrawnSyndrome);
  }
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

function verifyProse(original: string, expanded: string, field: "x" | "y" | "l", context: FinalRationaleContext, reject: Reject, legacyLayout?: boolean) {
  const size = [...expanded.replace(/\s/gu, "")].length;
  if (field === "x" ? size < 10 || size > 90 : field === "y" ? size < 40 || size > 300 : size > 180) reject("text_length", field);
  if (unclosed(expanded) || /[{}<>\[\]\n\r]|^\s*(?:辨病依据|辨证依据)\s*[:：]/u.test(expanded) ||
    !/。$/u.test(expanded) || endpoint.test(expanded) ||
    withoutTrailingFragment(expanded) !== expanded || withoutOrphanMechanismFragments(expanded) !== expanded) reject("text_fragment", field);
  if (engineeringJargonInText(expanded).length || findInternalEngineeringTags(expanded).length || /模型输出|提示词/u.test(expanded)) reject("text_engineering", field);
  const internal = internalRationale.exec(expanded)?.[0];
  if (internal) reject("text_internal", field, internal);
  const bareProblem = bareFindingProblem(original, context, field === "x", field === "l" && !legacyLayout);
  if (bareProblem) reject(bareProblem.code, field, bareProblem.phrase);
  // Check author assertions separately. The quote binder already checked the record at each exact occurrence.
  const claim = clauses(original).filter((part) => !isTextbookGeneralization(part, 0, part)).map(bare).join("。");
  const masked = original.replace(placeholder, "Ｑ");
  const denials = withoutDenialsOfRecordedFindings(masked, context.recordText);
  const normal = withoutUnrecordedNormalCommentary(masked, context.recordText);
  const qualifiers = withoutUnrecordedCourseAndLocation(claim, context.recordText);
  const probes = [[masked, denials], [masked, normal], [claim, qualifiers]] as const;
  const altered = probes.find(([before, after]) => before !== after);
  if (altered) reject("text_record_boundary", field, changedClause(...altered));
}

/** Archived outlines sometimes stored an entire finding list with its source row in u.
 * Recover only the verbatim pieces on that row, and only when the associated old aside is present. */
function normalizeLegacyUnexplained(raw: unknown, context: FinalRationaleContext): unknown {
  let value = raw;
  if (typeof value === "string") {
    if (value.length > 12_000) return raw;
    try { value = JSON.parse(value); } catch { return raw; }
  }
  if (!value || typeof value !== "object" || !("q" in value) || !value.q || typeof value.q !== "object" ||
    !("u" in value) || !Array.isArray(value.u) || !("y" in value) || typeof value.y !== "string") return raw;
  let y = value.y;
  const q = { ...value.q } as FinalRationaleOutline["q"];
  const u = value.u.map((entry: unknown) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !/^r\d+$/u.test(entry[0]) || typeof entry[1] !== "string") return entry;
    const [line, explanation] = entry as [string, string];
    const marker = `{{${line}}}`;
    const asides = y.split(/(?<=[。；;])/u).filter((part) => part.trimStart().startsWith(marker) && legacyUnexplained.test(part));
    if (asides.length !== 1 || idsIn(asides[0]).length) return entry;
    const boundary = new RegExp(rules.legacyUnexplainedFindingEnd, "u");
    const match = boundary.exec(explanation);
    if (!match) return entry;
    const findingList = explanation.slice(0, match.index);
    const whole = bindRationaleQuote(context, [line, findingList]);
    const findings = whole ? [findingList] : findingList.split(/[，,、]/u).map((part) => part.trim());
    if (!findings.length || !findings.every((part) => bindRationaleQuote(context, [line, part]))) return entry;
    const ids = Array.from({ length: 99 }, (_, index) => `q${index + 1}`).filter((id) => !Object.hasOwn(q, id)).slice(0, findings.length);
    if (ids.length !== findings.length) return entry;
    ids.forEach((id, index) => { q[id] = [line, findings[index]]; });
    y = y.replace(asides[0], "");
    return [ids, explanation];
  });
  return { ...value, q, u, y };
}

function normalizeLegacyProse(outline: FinalRationaleOutline) {
  const { l } = outline;
  const suffix = l?.trim().replace(/。$/u, "");
  if (suffix) {
    const y = outline.y.trim();
    const start = y.lastIndexOf(suffix);
    if (start >= 0 && /^。?$/u.test(y.slice(start + suffix.length))) {
      outline.y = y.slice(0, start).trimEnd();
      // Archived prompts asked for an explicit comparison with the settled direction.
      outline.l = l!.replace(new RegExp(rules.legacyDirectionBoilerplate, "gu"), "");
    }
  }
  const unexplained = new Set(outline.u.flatMap(([refs]) => refs));
  // A capability note from the retired layout is equivalent to noting the missing measurement.
  for (const [id, quote] of Object.entries(outline.q)) {
    if (!inspectionUnavailable.test(quote[1])) continue;
    outline.y = outline.y.replace(new RegExp(`\\{\\{${id}\\}\\}[，,]\\s*(?=[舌脉])`, "gu"), "");
    outline.u = outline.u.map(([refs, reason]): [string[], string] => [refs.filter((ref) => ref !== id), reason]).filter(([refs]) => refs.length);
    unexplained.delete(id);
  }
  if (!unexplained.size) return;
  // Old prompts required an editorial aside in y. Remove only the cited aside
  // tied to u. Independent reasoning, safety observations and other text stay.
  outline.y = outline.y.split(/(?<=[。；;])/u).filter((part) => {
    const ids = idsIn(part);
    return !(ids.length && ids.every((id) => unexplained.has(id)) && legacyUnexplained.test(bare(part)));
  }).join("").replace(/[；;]$/u, "。");
}

function withoutRepeatedExcerpt(value: string, quotes: Quotes): string {
  const adjacent = /(\{\{(q[1-9]\d?)\}\})[，,、]\s*([^，,、；;。！？]+)(?=[，,、；;。！？])/gu;
  let previous: string;
  do {
    previous = value;
    value = value.replace(adjacent, (whole, first: string, id: string, next: string) => {
      const quote = quotes[id];
      if (!quote) return whole;
      const [nextId] = idsIn(next.trim());
      const other = nextId && next.trim() === `{{${nextId}}}` ? quotes[nextId] : undefined;
      return next.trim() === quote.text || (other && quote.line === other.line && quote.at === other.at && quote.end === other.end)
        ? first : whole;
    });
  } while (value !== previous);
  return value;
}

export function validateRationalePair(raw: unknown, context: FinalRationaleContext, options: ValidationOptions = {}): RationaleVerdict {
  const parsed = parseRationaleOutline(options.legacyLayout ? normalizeLegacyUnexplained(raw, context) : raw);
  if ("reasons" in parsed) {
    const mistakenRow = (typeof raw === "string" ? raw : JSON.stringify(raw) || "").match(/\{\{r\d+\}\}/u)?.[0];
    return { ok: false, reasons: mistakenRow
      ? [...parsed.reasons, { code: "quote_line_number", field: "$", phrase: mistakenRow }] : parsed.reasons };
  }
  const { outline } = parsed;
  if (outline.s === "evidence_gap") return { ok: false, reasons: [{ code: "evidence_gap", field: "s" }] };
  if (options.legacyLayout) normalizeLegacyProse(outline);
  const reasons: RationaleRejection[] = [];
  const reject: Reject = (code, field, phrase) => {
    if (!reasons.some((reason) => reason.code === code && reason.field === field && reason.phrase === phrase)) {
      reasons.push({ code, field, ...(phrase ? { phrase } : {}) });
    }
  };
  const prose = [["x", outline.x], ["y", outline.y], ["l", outline.l || ""]] as const;
  for (const [field, text] of prose) {
    const lineNumber = text.match(/\{\{r\d+\}\}/u)?.[0];
    if (lineNumber) reject("quote_line_number", field, lineNumber);
  }
  const quotes: Quotes = {};
  const uRefs = outline.u.flatMap(([refs]) => refs);
  const yRefs = idsIn(outline.y);
  if (!options.legacyLayout && uRefs.some((id) => yRefs.includes(id))) reject("text_internal", "y", "u");
  const used = new Set([...prose.flatMap(([, text]) => idsIn(text)), ...uRefs]);
  for (const id of used) {
    const ref = outline.q[id];
    const quote = ref && bindRationaleQuote(context, ref);
    if (quote) quotes[id] = quote;
    else if (ref) reject("quote_occurrence", `q.${id}`, ref[1]);
    else reject("quote_reference", `q.${id}`, `{{${id}}}`);
  }
  if (reasons.length) return { ok: false, reasons };

  // An alternate ID can point to exactly the same source occurrence.
  const planIds = [...outline.g.flatMap(([refs]) => refs), ...[outline.t, outline.p].flatMap((slot) =>
    slot && slot[0] !== "u" ? slot[1] : [])];
  for (const id of planIds) {
    if (!quotes[id] && outline.q[id]) {
      const quote = bindRationaleQuote(context, outline.q[id]);
      if (quote) quotes[id] = quote;
    }
  }
  outline.x = withoutRepeatedExcerpt(outline.x, quotes);
  outline.y = withoutRepeatedExcerpt(outline.y, quotes);
  if (outline.l) outline.l = withoutRepeatedExcerpt(outline.l.trim(), quotes);
  verifyDisease(outline, quotes, context, reject);
  verifyGroups(outline, quotes, context, reject);
  verifyInspection("tongue", outline, quotes, context, reject);
  verifyInspection("pulse", outline, quotes, context, reject);
  verifyLineage(outline, context, reject);
  verifyCertainty(outline, context, reject);
  const names = context.input.conclusion.names;
  const starts = names.map((name) => bare(outline.y).indexOf(name));
  if (starts.some((at, index) => at < 0 || (index > 0 && at <= starts[index - 1])) || hasRoleReversal(outline.y, names)) reject("syndrome_name", "y");
  if (outline.l && hasRoleReversal(outline.l, names)) reject("syndrome_name", "l");
  for (const field of ["y", "l"] as const) {
    const value = outline[field] || "";
    const foreignName = hasForeignSyndrome(value, names);
    if (foreignName) reject("foreign_syndrome", field, foreignName);
    for (const hit of unsupportedRationaleElements(bare(value), context.elements, context.recordText)) {
      reject("foreign_element", field, hit.phrase);
    }
  }
  for (const [, mechanism, name] of outline.g) {
    if (typeof name === "string" && !names.includes(name)) {
      const foreignName = hasForeignSyndrome(name, names);
      if (foreignName) reject("foreign_syndrome", "g", foreignName);
    }
    for (const hit of unsupportedRationaleElements(mechanism, context.elements, context.recordText)) reject("foreign_element", "g", hit.phrase);
  }
  const expand = (value: string) => value.replace(placeholder, (_, id: string) => quotes[id].text);
  const x = expand(outline.x);
  const y = expand(outline.y);
  const l = outline.l ? expand(outline.l) : "";
  verifyProse(outline.x, x, "x", context, reject);
  verifyProse(outline.y, y, "y", context, reject);
  if (outline.l) verifyProse(outline.l, l, "l", context, reject, options.legacyLayout);
  const unexplained: BoundQuote[] = [];
  for (const id of uRefs) {
    const quote = quotes[id];
    if (!unexplained.some((prior) => sameOccurrence(prior, quote))) unexplained.push(quote);
  }
  const additional = unexplained.length ? `另有${unexplained.map(({ text }) => text).join("、")}，本证难以概括，是否另有兼夹尚待核实。` : "";
  if (additional && internalRationale.test(additional)) reject("text_internal", "u");
  const pair = { tcmDiseaseRationale: x, tcmDiagnosticRationale: y + additional + l };
  if (reasons.every(isSoftRationaleRejection)) {
    const candidate = withFinalRationalePair(context.root, pair, context);
    const carried = projectDeliveredReasoning({ ...candidate, stage: "prescribe" }, { recordText: context.recordText });
    if (carried.overview.tcmDiseaseRationale !== pair.tcmDiseaseRationale) reject("m04_carryover_drift", "x", changedClause(pair.tcmDiseaseRationale, carried.overview.tcmDiseaseRationale ?? ""));
    if (carried.overview.tcmDiagnosticRationale !== pair.tcmDiagnosticRationale) reject("m04_carryover_drift", "y", changedClause(pair.tcmDiagnosticRationale, carried.overview.tcmDiagnosticRationale ?? ""));
  }
  if (!reasons.length) return { ok: true, pair };
  if (options.revision && reasons.every(isSoftRationaleRejection)) return { ok: true, pair, softAccepted: true, reasons };
  return { ok: false, reasons };
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
