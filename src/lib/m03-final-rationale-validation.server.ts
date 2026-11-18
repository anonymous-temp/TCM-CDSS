import "server-only";
import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { engineeringJargonInText, governedTreatmentMethodOccurrencesInText, resolveNationalStandardTcmSyndromeTerm, treatmentMethodsShareLineage } from "./clinical-governance-tables";
import { findInternalEngineeringTags } from "./internal-tag-hygiene";
import { isGenericClinicalDescription, withoutDenialsOfRecordedFindings, withoutUnrecordedNormalCommentary } from "./diagnosis-visible-summary";
import { clinicalWordingForSyntheticPhrases, projectDeliveredReasoning, readabilityCleaned, withoutOrphanMechanismFragments, withoutTrailingFragment, withoutUnrecordedCourseAndLocation } from "./delivered-surface";
import { identifyKnownFormulaNames } from "./tcm-formula-provenance";
import { lineageWordingMatchingDirection } from "./lineage-formula-wording";
import { isLineageLensSentence, LINEAGE_LENS_SUBJECT, lineageLensSubject } from "./tcm-lineages";
import { recordedFindingReading } from "./diagnosis-safety";
import { natureLabelSignTerms, textHasSign } from "./analysis-element-closure";
import coldHeat from "../data/tcm-cold-heat-signs.source.json";
import { CHINESE_NUMERAL_BEFORE_UNIT, PATIENT_SELF_REFERENCE } from "./clinical-polarity";
import { filterAnsweredFinalRationaleUncertainties } from "./pathogenesis-columns";
import namesLexicon from "../data/tcm-syndrome-lexicon.json";
import criteriaLexicon from "../data/tcm-diagnostics-syndrome-criteria.json";
import rules from "../data/m03-final-rationale-policy.source.json";
import { bindRationaleQuote, GOVERNED_FINDINGS, isNormalInspection, rationaleElements, type BoundQuote, type FinalRationaleContext, type Finding, type Inspection } from "./m03-final-rationale-context.server";
import { parseRationaleOutline, type FinalRationaleOutline, type RationaleRejection } from "./m03-final-rationale-outline.server";

export type RationalePair = { tcmDiseaseRationale: string; tcmDiagnosticRationale: string };
export type RationaleVerdict = { ok: true; pair: RationalePair } | { ok: false; reasons: RationaleRejection[] };
const placeholder = /\{\{(q[1-9]\d?)\}\}/gu;
const idsIn = (value: string) => [...value.matchAll(placeholder)].map((match) => match[1]);
const bare = (value: string) => value.replace(placeholder, " ").trim();
const compact = (value: string) => value.replace(/[\s，,、。；;：:！？!？]/gu, "");
const clauses = (value: string) => value.split(/[。；;！？]/u).map((clause) => clause.trim()).filter(Boolean);
const unclosed = (value: string) => [["（", "）"], ["(", ")"], ["“", "”"], ["「", "」"], ["《", "》"]].some(([left, right]) =>
  value.split(left).length !== value.split(right).length);
const reassessment = new RegExp(rules.reassessment, "u");
const missing = new RegExp(rules.missing, "u");
const endpoint = /(?:[属为示见因与从以由呈伴并且及而、，：；]作?|\b)\s*。$/u;
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
function distinctQuotes(refs: string[], quotes: Quotes): number {
  const distinct: BoundQuote[] = [];
  for (const id of refs) {
    const quote = quotes[id];
    if (quote && !distinct.some((prior) => prior.term === quote.term ||
      (prior.line === quote.line && prior.at < quote.end && quote.at < prior.end))) distinct.push(quote);
  }
  return distinct.length;
}
const thermalSigns = {
  cold: coldHeat.dimensions.filter((item) => item.cold).map((item) => new RegExp(item.cold, "u")),
  heat: coldHeat.dimensions.filter((item) => item.heat).map((item) => new RegExp(item.heat, "u")),
};
const isTextbookGeneralization = (clause: string, at: number, whole: string) =>
  !PATIENT_SELF_REFERENCE.test(clause) && (new RegExp(rules.textbookGeneralization, "u").test(clause) ||
    (/^若/u.test(clause) && !idsIn(clause).length) || isGenericClinicalDescription(at, whole));

function hasBareFinding(value: string, context: FinalRationaleContext, allowTextbook: boolean): boolean {
  const metadata = [context.input.conclusion.disease, ...context.input.conclusion.names].sort((a, b) => b.length - a.length);
  let withoutNames = bare(value);
  for (const name of metadata) withoutNames = withoutNames.replaceAll(name, " ");
  const terms = new Set([...GOVERNED_FINDINGS, ...context.facts.map((item) => item.term), ...context.input.chief.map((item) => item.term)]);
  for (const match of withoutNames.matchAll(/[^，,。；;！？\n]+/gu)) {
    const clause = match[0].trim();
    if (!clause) continue;
    const general = allowTextbook && isTextbookGeneralization(clause, match.index, withoutNames);
    for (const term of terms) {
      if (!clause.includes(term)) continue;
      const reading = recordedFindingReading(context.recordText, term);
      // Open-language rule is a governed lexical probe. A documented fact must still be quoted.
      if (missing.test(clause) && !PATIENT_SELF_REFERENCE.test(clause) && reading === "absent") continue;
      if (general) continue;
      return true;
    }
    if (general) continue;
    if (new RegExp(rules.patientQualifiers, "u").test(match[0])) return true;
    if (/\d/u.test(clause) || [...clause.matchAll(CHINESE_NUMERAL_BEFORE_UNIT)].length) return true;
    if (new RegExp(rules.unquotedAssertion, "u").test(clause)) return true;
  }
  return false;
}

function hasForeignSyndrome(value: string, allowed: readonly string[]): boolean {
  let remaining = bare(value);
  for (const name of [...allowed].sort((a, b) => b.length - a.length)) remaining = remaining.replaceAll(name, " ");
  if (namedSyndromes.some((name) => remaining.includes(name))) return true;
  return [...remaining.matchAll(anchoredSyndrome)].some((match) => {
    const text = match[1].replace(new RegExp(rules.syndromePredicateTail, "u"), "");
    return Boolean(resolveNationalStandardTcmSyndromeTerm(text));
  });
}

function hasRoleReversal(value: string, names: readonly string[]): boolean {
  for (const segment of bare(value).split(/[，,。；;、]/u)) {
    if (segment.includes(names[0]) && new RegExp(rules.secondaryRole, "u").test(segment)) return true;
    if (names.slice(1).some((name) => segment.includes(name)) && new RegExp(rules.primaryRole, "u").test(segment)) return true;
  }
  return false;
}

function verifyInspection(field: Inspection, slot: FinalRationaleOutline["t"], prose: string, quotes: Quotes, context: FinalRationaleContext): string | undefined {
  const readings = context.input[field];
  const absence = new RegExp(field === "tongue" ? rules.tongueMissing : rules.pulseMissing, "u");
  const declaredMissing = absence.test(bare(prose));
  if (!readings.length) return slot[0] === "u" && declaredMissing ? undefined : "inspection_missing_disclosure";
  if (slot[0] === "u" || declaredMissing) return "inspection_recorded";
  const [reading, refs, meaning, target] = slot;
  if (context.input.conflicting[field] !== (reading === "c")) return "inspection_conflict";
  if (reading === "s" && (readings.every((finding) => isNormalInspection(field, finding)) || (target !== undefined && !context.input.conclusion.names[target]))) return "inspection_normal";
  if (reading !== "s" && target !== undefined) return "inspection_target";
  if (reading !== "s" && !new RegExp(rules.inspectionMeaning[reading], "u").test(meaning)) return "inspection_meaning";
  if (!readings.every((finding) => refs.some((id) => quotes[id] && covers(quotes[id], finding))) ||
    refs.some((id) => !quotes[id] || !readings.some((finding) => covers(quotes[id], finding)))) return "inspection_components";
  const passages = clauses(prose);
  if (!passages.some((sentence) => sentence.includes(meaning) && refs.every((id) => idsIn(sentence).includes(id))) ||
    compact(meaning).length < 4 || hasBareFinding(meaning, context, false) ||
    new RegExp(rules.inspectionEmptyMeaning, "u").test(meaning)) return "inspection_meaning";
  const names = context.input.conclusion.names;
  if (rationaleElements.asserted(meaning).some((unit) => !rationaleElements.fits(unit, [names[target ?? 0]]))) return "foreign_element";
  return undefined;
}

function verifyDisease(outline: FinalRationaleOutline, quotes: Quotes, context: FinalRationaleContext): string | undefined {
  const { disease } = context.input.conclusion;
  if (!outline.x.includes(disease) || hasForeignSyndrome(outline.x, [disease])) return "disease_name";
  if (!outline.d.length || !outline.d.some(([id]) => quotes[id] && covers(quotes[id], context.input.chief[0]))) return "disease_chief";
  const refs = new Set(outline.d.map(([id]) => id));
  if (!idsIn(outline.x).length || idsIn(outline.x).some((id) => !refs.has(id)) ||
    outline.d.some(([id, point, link]) => !quotes[id] ||
      (point !== null && !context.input.diseaseReference?.points.some(([key]) => key === point)) ||
      compact(link.replaceAll(disease, "")).length < 3 || compact(link) === compact(quotes[id].text) || !clauses(outline.x).some((part) => idsIn(part).includes(id) && part.includes(link)))) return "disease_reasoning";
  const caseClaims = clauses(bare(outline.x)).filter((part) => !isTextbookGeneralization(part, 0, part));
  if (rationaleElements.asserted(caseClaims.join("。").replaceAll(disease, "")).length) return "disease_element";
  return undefined;
}

function verifyGroups(outline: FinalRationaleOutline, quotes: Quotes, context: FinalRationaleContext): string | undefined {
  const names = context.input.conclusion.names;
  if (!outline.g.length || outline.g[0][0] !== 0 || !outline.g[0][1].some((id) => quotes[id] && covers(quotes[id], context.input.chief[0]))) return "chief_group";
  if (names.some((_, index) => !outline.g.some(([target]) => target === index))) return "target_missing";
  if (outline.g.some(([target], index, groups) => index > 0 && groups[index - 1][0] > target)) return "target_order";
  const passages = clauses(outline.y);
  const groupRefs = new Set<string>();
  for (const [target, refs, mechanism, elements, points] of outline.g) {
    const name = names[target];
    if (!name || refs.some((id) => !quotes[id]) || points?.some((id) => !context.input.syndrome[target]?.points.some(([point]) => point === id))) return "group_reference";
    if (target > 0 && distinctQuotes(refs, quotes) < 2) return "secondary_support";
    for (const inspection of [outline.t, outline.p]) {
      if (inspection[0] !== "u" && inspection[0] !== "s" && inspection[1].some((id) => refs.includes(id))) return "inspection_used_as_support";
    }
    if (hasForeignSyndrome(mechanism, [name]) || compact(mechanism.replaceAll(name, "")).length < 4 || hasBareFinding(mechanism, context, false)) return "group_reasoning";
    const asserted = rationaleElements.asserted(mechanism);
    const allowed = rationaleElements.allowed([name]);
    if (asserted.some((unit) => !rationaleElements.fits(unit, [name])) ||
      elements.some((element) => !allowed.has(element)) ||
      asserted.some((unit) => !elements.includes(unit.type))) return "foreign_element";
    if ([...allowed.keys()].some((element) => element !== "location") && !elements.length) return "group_elements";
    const at = passages.findIndex((part) => part.includes(mechanism) && refs.every((id) => idsIn(part).includes(id)));
    if (at < 0 || ![passages[at], passages[at + 1]].some((part) => part?.includes(name))) return "group_prose_link";
    if (rationaleElements.asserted(bare(passages[at])).some((unit) => !rationaleElements.fits(unit, [name]))) return "foreign_element";
    refs.forEach((id) => groupRefs.add(id));
  }
  const inspectionRefs = [...(outline.t[0] === "u" ? [] : outline.t[1]), ...(outline.p[0] === "u" ? [] : outline.p[1])];
  const unexplainedRefs = outline.u.flatMap(([refs]) => refs);
  const explained = [...groupRefs, ...inspectionRefs, ...unexplainedRefs];
  if (unexplainedRefs.some((id) => groupRefs.has(id)) ||
    outline.u.some(([refs, why]) => !passages.some((part) => part.includes(why) && refs.every((id) => idsIn(part).includes(id))))) return "unexplained_link";
  if ([...context.input.chief, ...context.input.important].some((finding) =>
    !explained.some((id) => quotes[id] && covers(quotes[id], finding)))) return "finding_omitted";
  if (idsIn(outline.y).some((id) => !explained.includes(id) && !outline.l?.[1].includes(id))) return "quote_not_planned";
  const supports = [...groupRefs, ...(outline.t[0] === "s" ? outline.t[1] : []), ...(outline.p[0] === "s" ? outline.p[1] : [])];
  if (distinctQuotes(supports, quotes) < 2) return "syndrome_evidence_gap";
  if (context.input.conclusion.resolution === "bounded" && !boundedSyndromeSupported(context, supports.map((id) => quotes[id]))) return "syndrome_evidence_gap";
  return undefined;
}

function boundedSyndromeSupported(context: FinalRationaleContext, quotes: BoundQuote[]): boolean {
  const name = context.input.conclusion.names[0];
  const allowed = rationaleElements.allowed([name]);
  const signs = natureLabelSignTerms(name);
  const thermal = [...(allowed.has("cold") ? thermalSigns.cold : []), ...(allowed.has("heat") ? thermalSigns.heat : [])];
  const points = context.input.syndrome[0].points.map(([, value]) => value);
  if (signs.length === 0 && thermal.length === 0 && points.length === 0) return true;
  return quotes.some((quote) => thermal.some((pattern) => pattern.test(quote.text)) ||
    (!context.input.chief.some((chief) => covers(quote, chief)) &&
      (signs.some((sign) => textHasSign(quote.text, sign)) ||
        points.some((point) => quote.text.includes(point) || (quote.term.length >= 2 && point.includes(quote.term))))));
}

function verifyLineage(outline: FinalRationaleOutline, context: FinalRationaleContext): string | undefined {
  const { lineage, method, formulas, direction } = context.input;
  const passages = clauses(outline.y);
  const lens = (part: string) => isLineageLensSentence(part) || Object.values(LINEAGE_LENS_SUBJECT).some((subject) => part.includes(`${subject}学派`));
  if (clauses(outline.x).some(lens)) return "lineage_disease";
  if (!lineage) return outline.l || passages.some(lens) ? "lineage_unsolicited" : undefined;
  if (!outline.l || outline.l[0] !== lineage.code) return "lineage_required";
  const [, refs, last] = outline.l;
  const final = passages.at(-1) || "";
  if (!final || compact(final) !== compact(last) || passages.slice(0, -1).some(lens) || !refs.every((id) => idsIn(final).includes(id))) return "lineage_last";
  const subject = LINEAGE_LENS_SUBJECT[lineage.code];
  if (!(subject ? lineageLensSubject(final) === subject || (lens(final) && final.includes(subject)) : final.includes(lineage.label))) return "lineage_subject";
  if (hasBareFinding(last, context, false)) return "lineage_unquoted";
  const directionNames = new Set([...identifyKnownFormulaNames(direction || ""), ...(formulas || []), ...identifyKnownFormulaNames(method || "")]);
  if (identifyKnownFormulaNames(bare(last)).some((name) => !directionNames.has(name))) return "lineage_formula";
  const methods = governedTreatmentMethodOccurrencesInText(bare(last));
  const finalMethods = governedTreatmentMethodOccurrencesInText(method);
  if (methods.some(({ entry }) => !finalMethods.some((final) => treatmentMethodsShareLineage(entry, final.entry)))) return "lineage_method";
  if (lineage.adaptation?.applicable === "not-applicable" && !new RegExp(rules.lineageDeference, "u").test(last)) return "lineage_adaptation";
  const probe = { ...context.root, overview: { ...context.root.overview, tcmDiagnosticRationale: final } };
  if (lineageWordingMatchingDirection(probe).overview.tcmDiagnosticRationale !== final) return "lineage_formula";
  return undefined;
}

function verifyCertainty(outline: FinalRationaleOutline, context: FinalRationaleContext): string | undefined {
  if (reassessment.test(outline.x)) return "disease_retracted";
  const { names, resolution } = context.input.conclusion;
  if (resolution === "resolved" && clauses(outline.y).some((clause) => reassessment.test(clause) &&
    (names.some((name) => clause.includes(name)) || new RegExp(rules.missingResolvedName, "u").test(clause)))) return "syndrome_retracted";
  if (resolution === "bounded" && (!outline.b.length || !outline.b.some(([, gap]) => bare(outline.y).includes(gap)) ||
    outline.b.some(([, gap]) => ["affirmed", "denied", "conflicting"].includes(recordedFindingReading(context.recordText, gap))) ||
    !new RegExp(rules.bounded, "u").test(outline.y) || /确诊|证据充分/u.test(outline.y))) return "bounded_limit";
  return undefined;
}

function verifyProse(original: string, expanded: string, field: "x" | "y", lineage: boolean, context: FinalRationaleContext): string | undefined {
  const size = [...expanded.replace(/\s/gu, "")].length;
  if (field === "x" ? size < 10 || size > 60 : size < 16 || size > (lineage ? 260 : 200)) return "text_length";
  if (unclosed(expanded) || /[{}<>\[\]\n\r]|^\s*(?:辨病依据|辨证依据)\s*[:：]/u.test(expanded) ||
    !/。$/u.test(expanded) || endpoint.test(expanded) || clauses(original).some((part) => idsIn(part).length > 0 && !/\p{Script=Han}/u.test(bare(part))) ||
    withoutTrailingFragment(expanded) !== expanded || withoutOrphanMechanismFragments(expanded) !== expanded) return "text_fragment";
  if (readabilityCleaned(clinicalWordingForSyntheticPhrases(expanded)) !== expanded) return "text_surface_drift";
  if (engineeringJargonInText(expanded).length || findInternalEngineeringTags(expanded).length || /模型输出|提示词/u.test(expanded)) return "text_engineering";
  if (hasBareFinding(original, context, field === "x")) return "text_unquoted_finding";
  if (withoutUnrecordedNormalCommentary(expanded, context.recordText) !== expanded ||
    withoutDenialsOfRecordedFindings(expanded, context.recordText) !== expanded) return "text_record_boundary";
  // Probe bare claims, leaving verified quote spans and explicit textbook comparisons intact.
  // The projector's course/location cleanup is never applied to accepted prose.
  const claim = clauses(bare(original)).filter((part) => !isTextbookGeneralization(part, 0, part)).join("。");
  if (/\S/u.test(claim) && withoutUnrecordedCourseAndLocation(claim, "", undefined) !== claim) return "text_record_boundary";
  return undefined;
}

export function validateRationalePair(raw: unknown, context: FinalRationaleContext): RationaleVerdict {
  const parsed = parseRationaleOutline(raw);
  if ("reasons" in parsed) return { ok: false, reasons: parsed.reasons };
  const { outline } = parsed;
  if (outline.s === "evidence_gap") return { ok: false, reasons: [{ code: "evidence_gap", field: "s" }] };
  const reasons: RationaleRejection[] = [];
  const reject = (code: string | undefined, field: string) => { if (code) reasons.push({ code, field }); };
  const quotes: Quotes = {};
  const declaredSpans = new Set<string>();
  for (const [id, ref] of Object.entries(outline.q)) {
    const quote = bindRationaleQuote(context, ref);
    const occurrence = quote ? `${quote.line}:${quote.at}:${quote.end}` : "";
    if (!quote || declaredSpans.has(occurrence)) reject("quote_occurrence", `q.${id}`);
    else {
      declaredSpans.add(occurrence);
      quotes[id] = quote;
    }
  }
  const used = new Set([...idsIn(outline.x), ...idsIn(outline.y)]);
  if ([...used].some((id) => !quotes[id]) || Object.keys(quotes).some((id) => !used.has(id))) reject("quote_reference", "q");
  if (reasons.length) return { ok: false, reasons };
  reject(verifyDisease(outline, quotes, context), "d");
  reject(verifyGroups(outline, quotes, context), "g");
  reject(verifyInspection("tongue", outline.t, outline.y, quotes, context), "t");
  reject(verifyInspection("pulse", outline.p, outline.y, quotes, context), "p");
  reject(verifyLineage(outline, context), "l");
  reject(verifyCertainty(outline, context), "b");
  const names = context.input.conclusion.names;
  const starts = names.map((name) => bare(outline.y).indexOf(name));
  if (starts.some((at, index) => at < 0 || (index > 0 && at <= starts[index - 1])) || hasRoleReversal(outline.y, names) ||
    hasForeignSyndrome(outline.y, names)) reject("syndrome_name", "y");
  if (rationaleElements.asserted(bare(outline.y)).some((unit) => !rationaleElements.fits(unit, names))) reject("foreign_element", "y");
  const expand = (value: string) => value.replace(placeholder, (_, id: string) => quotes[id].text);
  const pair = { tcmDiseaseRationale: expand(outline.x), tcmDiagnosticRationale: expand(outline.y) };
  reject(verifyProse(outline.x, pair.tcmDiseaseRationale, "x", false, context), "x");
  reject(verifyProse(outline.y, pair.tcmDiagnosticRationale, "y", Boolean(outline.l), context), "y");
  if (!reasons.length) {
    const candidate = withFinalRationalePair(context.root, pair, context);
    const carried = projectDeliveredReasoning({ ...candidate, stage: "prescribe" }, { recordText: context.recordText });
    if (carried.overview.tcmDiseaseRationale !== pair.tcmDiseaseRationale ||
      carried.overview.tcmDiagnosticRationale !== pair.tcmDiagnosticRationale) reject("m04_carryover_drift", "y");
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
