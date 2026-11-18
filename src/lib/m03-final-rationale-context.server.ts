import "server-only";
import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { authoritativePatientAgeYears, normalizeClinicalText, clinicalGroundingText, clauseLocalMentionPolarityAt, recordMentionPolarityAt, recordedFindingReading } from "./diagnosis-safety";
import { affirmedClinicalSourceClauses, clinicalClausePolarity, clinicalEventTemporalScopeAt, RECORD_GAP_MARKER, stripClinicalSectionLabel } from "./clinical-polarity";
import { isUnrecordedInspectionFieldValue } from "./clinical-state";
import { buildTrustedRecordIndex, deliveryHash } from "./delivery-trusted-record.server";
import { chiefComplaintFindings, chiefComplaintPhrase, rationaleFindingsChecklist } from "./rationale-findings-checklist";
import { followupConversationView } from "./followup-conversation";
import { getLineageCard, resolveLineageCode } from "./tcm-lineages";
import { isTextbookDiseaseName, splitTextbookDiseaseSubtype, textbookDiseaseDiagnosisPoints, textbookRowForSyndrome, tongueOptionsMutuallyExclusive, pulseOptionsMutuallyExclusive, withoutFingerVeinClause } from "./tcm-textbook-syndromes";
import { diagnosticsCriteriaFor, elementCompositeCriteriaEntry, compoundCriteriaEntries } from "./m03-secondary-syndrome-consistency.server";
import { allowedRationaleElements, finalRationaleElementContext } from "./m03-final-rationale-elements.server";
import { withoutNormalFindingSegments } from "./diagnosis-visible-summary";
import { inspectionLexiconNormal, TCM_INSPECTION_AXES } from "./tcm-inspection-lexicon";
import exam from "../data/physical-exam-claim-lexicon.source.json";
import symptomAxis from "../data/tcm-symptom-axis-map.source.json";
import chiefConcepts from "../data/tcm-differential-chief-concepts.source.json";
import rules from "../data/m03-final-rationale-policy.source.json";
import deliveryFactsPolicy from "../data/delivery-facts-policy.source.json";
import { courseSpans } from "./western-record-course";
import { FINAL_RATIONALE_VERSION } from "./m03-final-rationale-policy";
import { FINAL_RATIONALE_SYSTEM, rationaleRevision, type RationaleRejection } from "./m03-final-rationale-outline.server";

export type Inspection = "tongue" | "pulse";
type Line = { id: string; text: string; path: string; offset: number; contextOffset: number; inspection?: Inspection; chief: boolean; current: boolean; context: string; reading: string; onsets: Array<{ start: number; end: number }> };
export type Finding = { line: string; at: number; term: string };
const unique = <T>(items: readonly T[]) => [...new Set(items)];
const inspectionKeys = ["tongue", "pulse"] as const;
const inspectionPaths = {
  tongue: new RegExp(rules.tonguePath, "u"),
  pulse: new RegExp(rules.pulsePath, "u"),
};
const inspectionPrefix = { tongue: new RegExp(rules.tonguePrefix, "u"), pulse: /^(?:脉象|切诊)\s*[:：]\s*/u };
const inspectionWords = { tongue: /^(?:舌(?!下含服)|苔)/u, pulse: new RegExp(rules.pulseFindingPrefix, "u") };
export const inspectionUnavailable = new RegExp(rules.inspectionUnavailable, "u");
const inspectionLabel = new RegExp(rules.inspectionLabel, "u");
const stripInspectionLabel = (value: string) => value.replace(inspectionLabel, "");
const familyObject = new RegExp(rules.familyObject, "gu");
const historyHeading = new RegExp(rules.historyHeading, "u");

export const GOVERNED_FINDINGS = unique([
  ...symptomAxis.entries.flatMap((entry) => entry.terms),
  ...exam.groups.flatMap((entry) => entry.terms),
  ...TCM_INSPECTION_AXES.flatMap((axis) => [...axis.groups.flatMap((group) => group.terms), ...axis.normal.split(/[，、]/u)]),
]).filter((term) => term.length >= 2).sort((a, b) => b.length - a.length);

function recordLines(state: CaseState): Line[] {
  const sources = buildTrustedRecordIndex(state).sources;
  const conversation = followupConversationView(state.conversation);
  const followupAnswers = new Set(conversation.answers.map((answer) => answer.answer));
  const hasPrimaryRecord = Boolean(state.hisRecord?.rawText || Object.values(state.hisRecord?.fields || {}).some(Boolean) || conversation.primaryNarrative.length);
  const lines: Line[] = [];
  const chiefText = state.chiefComplaint || "";
  const chiefCourses = courseSpans(chiefText);
  const chiefTerms = unique([
    ...chiefComplaintFindings(state),
    ...chiefText.split(/[，,。；;、]|伴/u).map(chiefComplaintPhrase).filter((term) => term.length >= 2),
    ...GOVERNED_FINDINGS.filter((term) => chiefText.includes(term)),
    ...chiefConcepts.concepts.filter(({ forms }) => forms.some((form) => chiefText.includes(form) && recordedFindingReading(chiefText, form) === "affirmed"))
      .flatMap(({ forms }) => forms),
  ]);
  for (const source of sources) {
    if (source.sourcePath === "/tongueImageDesc") continue;
    if (source.sourcePath.startsWith("/symptoms/") && hasPrimaryRecord) continue;
    // A bare answer can quote what it actually says. Assistant question text is never a source.
    if (source.role === "answer" && followupAnswers.has(source.text) && !/\p{Script=Han}{2}/u.test(source.text)) continue;
    const field = inspectionKeys.find((key) => inspectionPaths[key].test(source.sourcePath));
    const chief = /\/(?:chiefComplaint|zhushu)$/u.test(source.sourcePath);
    let current = source.role !== "history";
    for (const match of source.text.matchAll(/[^\r\n]+/gu)) {
      const raw = match[0];
      const trimmed = raw.trimStart();
      if (historyHeading.test(trimmed)) current = false;
      else if (stripClinicalSectionLabel(trimmed) !== trimmed || inspectionKeys.some((key) => inspectionPrefix[key].test(trimmed))) current = source.role !== "history";
      if (field && isUnrecordedInspectionFieldValue(trimmed, field)) continue;
      const prefix = field ? inspectionPrefix[field] : undefined;
      const content = prefix ? trimmed.replace(prefix, "") : trimmed;
      const text = content.trimEnd();
      const contextOffset = raw.length - content.length;
      if (!text || lines.some((line) => line.text === text && line.inspection === field && line.current === current && line.chief === chief)) continue;
      const fieldKey = source.sourcePath.split("/").at(-1) || "";
      const onsets = current && (fieldKey === "presentHistory" || deliveryFactsPolicy.hpiKeys.includes(fieldKey))
        ? onsetAnchors(raw, chiefCourses, chiefTerms) : [];
      // A family term used as the object of recognition does not supply the symptom's subject.
      const reading = raw.replace(familyObject, (name) => "某".repeat(name.length));
      lines.push({ id: "", onsets, path: source.sourcePath, offset: match.index + contextOffset, contextOffset,
        context: raw, reading, text, inspection: field, chief, current });
    }
  }
  // Bound the prompt using complete lines and keep direct four-examination entries and the chief complaint first.
  lines.sort((a, b) => Number(b.chief) - Number(a.chief) || Number(Boolean(b.inspection)) - Number(Boolean(a.inspection)) || Number(b.current) - Number(a.current));
  return lines.map((line, index) => ({ ...line, id: `r${index + 1}` }));
}

function offsets(text: string, term: string): number[] {
  const positions: number[] = [];
  if (!term) return positions;
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) positions.push(at);
  return positions;
}

const courseOnset = new RegExp(rules.courseOnset, "u");
const painTerm = new RegExp(`^([\\p{Script=Han}]{1,5}?)${rules.painTerminal}$`, "u");
const continuation = new RegExp(rules.currentCourseContinuation, "gu");
const observation = new RegExp(rules.affirmativeObservation, "u");
const partialRelief = new RegExp(rules.partialRelief, "gu");

function sitePainPattern(term: string): RegExp | undefined {
  const site = painTerm.exec(term)?.[1].replace(/部位?$/u, "");
  return site ? new RegExp(`${site}${rules.painModifier}${rules.painTerminal}`, "gu") : undefined;
}

function describesChief(text: string, chiefTerms: readonly string[]): boolean {
  return chiefTerms.some((term) => {
    if (recordedFindingReading(text, term) === "affirmed") return true;
    const expanded = sitePainPattern(term)?.exec(text);
    return Boolean(expanded && clauseLocalMentionPolarityAt(text, expanded.index + expanded[0].length - 1) === "affirmed");
  });
}

function onsetAnchors(text: string, chiefCourses: ReturnType<typeof courseSpans>, chiefTerms: string[]) {
  if (!chiefCourses.length) return [];
  const normalized = normalizeClinicalText(text);
  const onsets: Line["onsets"] = [];
  for (const { 0: sentence, index } of normalized.matchAll(/[^。；;]+/gu)) {
    for (const span of courseSpans(sentence)) {
      if (!chiefCourses.some((chief) => chief.lower === span.lower && chief.upper === span.upper)) continue;
      const at = span.index + span.length;
      const onsetClause = sentence.slice(at);
      if (courseOnset.test(onsetClause) && describesChief(onsetClause, chiefTerms)) {
        onsets.push({ start: index + span.index, end: index + at + 1 });
      }
    }
    // An earlier illness and a still-recurring chief complaint can share the same HPI sentence.
    for (const match of sentence.matchAll(continuation)) {
      if (describesChief(sentence.slice(match.index + match[0].length), chiefTerms)) {
        onsets.push({ start: index + match.index, end: index + match.index + match[0].length });
      }
    }
  }
  return onsets;
}

function isCurrentEpisode(line: Line, offset: number, length: number): boolean {
  const scope = clinicalEventTemporalScopeAt(line.context, offset, length, { groundingQuote: true });
  if (scope === "current") return true;
  const sentenceStart = Math.max(...["。", "；", ";"].map((delimiter) => line.context.lastIndexOf(delimiter, offset - 1))) + 1;
  const onset = line.onsets.find(({ end }) => end > sentenceStart && end <= offset);
  if (!onset) return false;
  if (scope === "historical_resolved") {
    // Same-episode conditional, partial relief is a presenting feature. Keep any complete
    // remission visible to the shared temporal reader.
    const maskedRelief = line.context.replace(partialRelief, (relief) => " ".repeat(relief.length));
    if (clinicalEventTemporalScopeAt(maskedRelief, offset, length, { groundingQuote: true }) === "historical_resolved") return false;
  }
  if (line.context.slice(onset.start, onset.end).match(continuation)) {
    return clinicalEventTemporalScopeAt(line.context.slice(onset.end), offset - onset.end, length, { groundingQuote: true }) === "current";
  }
  // Keep any independent historical anchor before or after the onset that matches the chief complaint.
  const beforeOnset = line.context.slice(sentenceStart, onset.start);
  return clinicalEventTemporalScopeAt(beforeOnset, beforeOnset.length) === "current" &&
    clinicalEventTemporalScopeAt(line.context.slice(onset.end), offset - onset.end, length, { groundingQuote: true }) === "current";
}

function independentlyAffirmedAt(text: string, offset: number): boolean {
  const start = Math.max(...["，", ",", "。", "；", ";"].map((mark) => text.lastIndexOf(mark, offset - 1))) + 1;
  const clause = text.slice(start).split(/[，,。；;]/u)[0];
  // Accept a documented positive after an earlier negation only when it has an independent predicate.
  // The existing affirmed-clause reader still guards negation lists and conditional statements.
  return (recordedFindingReading(text, clause) === "affirmed" || observation.test(clause)) &&
    affirmedClinicalSourceClauses(text).some((affirmed) => affirmed.includes(clause));
}

export function isCurrentFindingAt(line: Line, at: number, term: string, affirmedSpan = false): boolean {
  const offset = line.contextOffset + at;
  const polarity = recordMentionPolarityAt(line.reading, offset);
  return line.current && polarity !== "excluded" &&
    (polarity === "affirmed" || affirmedSpan || independentlyAffirmedAt(line.reading, offset)) &&
    clauseLocalMentionPolarityAt(line.reading, offset) === "affirmed" &&
    isCurrentEpisode(line, offset, term.length);
}

function findingInLine(line: Line, term: string): Finding | undefined {
  const at = offsets(line.text, term).find((offset) => isCurrentFindingAt(line, offset, term));
  return at === undefined ? undefined : { line: line.id, at, term };
}

export function inspectionFindings(lines: readonly Line[], field: Inspection): Finding[] {
  const found: Finding[] = [];
  const covered = new Set<string>();
  for (const line of lines.filter((entry) => entry.current)) {
    const explicit = line.inspection === field;
    if (line.inspection && !explicit) continue;
    for (const match of line.text.matchAll(/[^，,。；;、！？]+/gu)) {
      const raw = match[0].trim();
      const term = stripInspectionLabel(raw).replace(inspectionPrefix[field], "").trim();
      if ((!explicit && !inspectionWords[field].test(term)) || inspectionUnavailable.test(raw) || isUnrecordedInspectionFieldValue(term, field) || !/\p{Script=Han}/u.test(term)) continue;
      if (field === "pulse" && (new RegExp(rules.barePulseCount, "u").test(term) || withoutFingerVeinClause(term) !== term)) continue;
      const start = match.index + match[0].indexOf(term);
      const coating = field === "tongue" ? term.indexOf("苔", 1) : -1;
      const components = coating > 0 && term.startsWith("舌") && !term.startsWith("舌苔") ? [term.slice(0, coating), term.slice(coating)] : [term];
      let at = start;
      for (const component of components) {
        // 无苔、无异常 are observations as phrases. Availability was checked above.
        const anchor = /^(?:无苔|无异常)/u.test(component) ? component.slice(0, 1) : component;
        if (!covered.has(component) && isCurrentFindingAt(line, at, anchor)) {
          found.push({ line: line.id, at, term: component });
          covered.add(component);
        }
        at += component.length;
      }
    }
  }
  return found;
}

function chiefFindings(state: CaseState, lines: readonly Line[], disease: string): Finding[] {
  const diseaseCore = splitTextbookDiseaseSubtype(disease).disease;
  const nominated = unique([...chiefComplaintFindings(state), ...GOVERNED_FINDINGS]);
  const found: Finding[] = [];
  for (const line of lines.filter((entry) => entry.chief)) {
    for (const clause of line.text.split(/[，,。；;、\n]|伴/u)) {
      const phrase = chiefComplaintPhrase(clause);
      if (!phrase || (isTextbookDiseaseName(phrase) && phrase !== diseaseCore)) continue;
      const terms = nominated.filter((term) => clause.includes(term)).sort((a, b) => b.length - a.length);
      const selected = terms.filter((term, index) => !terms.slice(0, index).some((longer) => longer.includes(term)));
      for (const term of selected.length ? selected : [phrase]) {
        const finding = findingInLine(line, term);
        if (finding && !found.some((entry) => entry.term === term)) found.push(finding);
      }
    }
  }
  return found;
}

function syndromeReferences(names: string[], disease: string, ageYears: number | undefined, chiefComplaint: string) {
  let pointId = 0;
  return names.map((name) => {
    const row = textbookRowForSyndrome(disease, name, { ageYears, chiefComplaint });
    const criteria = diagnosticsCriteriaFor(name) ?? elementCompositeCriteriaEntry(name);
    const components = criteria?.components?.map(diagnosticsCriteriaFor).filter(Boolean) ?? compoundCriteriaEntries(name);
    const pointTexts = unique([...(row?.manifestations.split(/[，、；。]/u) || []), ...(criteria?.specific || []), ...(criteria?.manifestations || []), ...components.flatMap((component) => component?.specific || [])]).slice(0, 14);
    return {
      name, row: row ? { book: row.book, term: row.syndromeName, id: row.id, evidence: row.evidence } : null,
      criteria: criteria ? { name: criteria.name, line: criteria.line || undefined, components: criteria.components, book: "中医诊断学" } : null,
      points: pointTexts.map((value) => [`S${++pointId}`, value] as const),
    };
  });
}

export function buildFinalRationaleContext(root: ClinicalReasoningResultV2, state: CaseState, scope: string) {
  const { overview, pathogenesis, therapy, lineageAdaptation } = root;
  const names = [overview.primarySyndrome, ...(overview.secondarySyndromes || [])];
  if (root.stage !== "diagnose" || !overview.tcmDiseaseName || !names[0] || names[0] === "症状级工作判断" ||
    !["resolved", "bounded"].includes(overview.primarySyndromeResolution || "") ||
    !overview.tcmDiseaseRationale || !overview.tcmDiagnosticRationale || !pathogenesis.chain.length ||
    !pathogenesis.locationDifferentiation || !pathogenesis.natureDifferentiation) return undefined;

  const fullLines = recordLines(state);
  let remaining = 6800;
  const lines = fullLines.filter((line) => {
    if (line.text.length > 1800 || line.text.length > remaining) return false;
    remaining -= line.text.length;
    return true;
  });
  const recordText = clinicalGroundingText(state);
  const chief = chiefFindings(state, lines, overview.tcmDiseaseName);
  if (!chief.length) return undefined;
  const tongue = inspectionFindings(fullLines, "tongue");
  const pulse = inspectionFindings(fullLines, "pulse");
  const displayed = new Set(lines.map((line) => line.id));
  // An omitted measured finding cannot be described as unrecorded.
  if ([...tongue, ...pulse].some((finding) => !displayed.has(finding.line))) return undefined;
  const conflicting = {
    tongue: tongue.some((a) => tongue.some((b) => a !== b && tongueOptionsMutuallyExclusive(a.term, b.term))),
    pulse: pulse.some((a) => pulse.some((b) => a !== b && pulseOptionsMutuallyExclusive(a.term, b.term))),
  };
  const age = authoritativePatientAgeYears(state) ?? undefined;
  const disease = overview.tcmDiseaseName;
  const source = textbookDiseaseDiagnosisPoints(disease, age) ?? textbookDiseaseDiagnosisPoints(splitTextbookDiseaseSubtype(disease).disease, age);
  const points = (source?.points || []).slice(0, 12).map((point, index) => [`D${index + 1}`, point] as const);
  const syndrome = syndromeReferences(names, disease, age, state.chiefComplaint);
  const code = resolveLineageCode(state.tcmLineagePreference);
  const card = code === "unrestricted" ? null : getLineageCard(code);
  const facts = (state.clinicalFacts?.affirmedSymptoms || []).filter((item) =>
    lines.some((line) => line.text.includes(item.quote) && findingInLine(line, item.term)));
  const important = rationaleFindingsChecklist(state, 8).flatMap((term) => {
    const finding = lines.map((line) => findingInLine(line, term)).find(Boolean);
    return finding && !chief.some((item) => item.term.includes(term)) && ![...tongue, ...pulse].some((item) => item.term.includes(term) || term.includes(item.term)) ? [finding] : [];
  });
  const fingerVein = lines.flatMap((line) => line.text.split(/[，,。；;、！？]/u).flatMap((part) => {
    const term = part.trim();
    if (!/^(?:小儿)?指纹.+/u.test(term) || RECORD_GAP_MARKER.test(term)) return [];
    const finding = findingInLine(line, term);
    return finding ? [finding] : [];
  }));
  const ground = (term: string) => lines.map((line) => findingInLine(line, term)).find(Boolean);
  const location = pathogenesis.locationDifferentiation;
  const nature = pathogenesis.natureDifferentiation;
  const input = {
    records: lines.map(({ id, text, path, current, inspection }) => [id, text, inspection || path.split("/").at(-1), current ? undefined : "history"]),
    chief, tongue, pulse, conflicting, important: [...new Map([...important, ...fingerVein].map((item) => [item.term, item])).values()],
    conclusion: { disease, names, resolution: overview.primarySyndromeResolution, reason: overview.primarySyndromeResolutionReason, confidence: overview.evidence?.confidence },
    axes: {
      location: { ...location, details: location.details?.map(({ location, basis }) => ({ location, basis: ground(basis) ?? null })) },
      nature: { ...nature, basis: nature.basis ? ground(nature.basis) ?? null : null },
    },
    ground: unique([...overview.primarySyndromeBasis, ...pathogenesis.chain.map((node) => node.patientFact)])
      .map(ground).filter((finding): finding is Finding => Boolean(finding)),
    pending: pathogenesis.uncertainties,
    allowed: names.map(allowedRationaleElements),
    method: therapy?.overallMethod, direction: overview.recommendedFormulaDirection, formulas: overview.recommendedFormulaNames,
    lineage: card ? { code, label: card.label, lens: card.dxEmphasis, adaptation: lineageAdaptation } : null,
    diseaseReference: source ? { book: source.book, definition: source.definition, points } : null,
    syndrome,
  };
  const key = deliveryHash({
    version: FINAL_RATIONALE_VERSION, stateId: state.id, scope, input, recordText, facts,
    sources: lines.map(({ path, offset, context }) => [path, offset, context]),
    safety: state.safetyGate, caseCompleteness: state.completeness,
    safetyManagement: root.management, completeness: root.completeness,
    theory: { method: therapy, lineageAdaptation, location, nature, primaryBasis: overview.primarySyndromeBasis },
  });
  const elements = finalRationaleElementContext(root, { ageYears: age, chiefComplaint: state.chiefComplaint });
  return { key, input, lines, facts, recordText, state, root, elements };
}

export type FinalRationaleContext = NonNullable<ReturnType<typeof buildFinalRationaleContext>>;

/** A pain adjective may refine the recorded symptom without changing its anatomical site. */
export function recordedRationaleSitePain(context: FinalRationaleContext, term: string): boolean {
  const pattern = sitePainPattern(term);
  return Boolean(pattern && context.lines.some((line) => [...line.text.matchAll(pattern)].some((match) =>
    isCurrentFindingAt(line, match.index + match[0].length - 1, match[0].slice(-1)))));
}

export function finalRationaleMessages(context: FinalRationaleContext, reasons: RationaleRejection[] = []) {
  return [
    { role: "system" as const, content: FINAL_RATIONALE_SYSTEM },
    { role: "user" as const, content: JSON.stringify({ ...context.input, snapshot: context.key, ...(reasons.length ? { revise: reasons.map(rationaleRevision) } : {}) }) },
  ];
}

export type BoundQuote = Finding & { text: string; end: number };

export function bindRationaleQuote(context: FinalRationaleContext, quote: readonly [string, string, (string | null)?, (string | null)?]): BoundQuote | undefined {
  const [id, raw, anchor, scope] = quote;
  const line = context.lines.find((entry) => entry.id === id);
  if (!line || !raw || (scope && scope !== "current")) return undefined;
  const spans = offsets(line.text, raw);
  if (!spans.length) return undefined;
  let excerpts = [{ text: raw, offset: 0 }];
  if (stripInspectionLabel(raw).length > 40) {
    // The original must be verbatim. Shorten only to the clause bearing the identified finding.
    const findings = [...context.input.chief, ...context.input.tongue, ...context.input.pulse, ...context.input.important]
      .filter((finding) => finding.line === id);
    excerpts = [...raw.matchAll(/[^，,。；;！？]+/gu)].flatMap((match) => {
      const text = match[0].trim();
      const matchesFinding = anchor ? text.includes(anchor) : findings.some(({ term }) => text.includes(term));
      return matchesFinding ? [{ text, offset: match.index + match[0].indexOf(text) }] : [];
    });
    if (new Set(excerpts.map(({ text }) => text)).size !== 1) return undefined;
  }
  const bound = spans.flatMap((start) => excerpts.flatMap(({ text, offset }) => {
    if (stripInspectionLabel(text).length > 40) return [];
    const result = bindAt(context, line, [id, text, anchor, scope], start + offset);
    return result ? [result] : [];
  }));
  return bound.length === 1 ? bound[0] : undefined;
}

function bindAt(context: FinalRationaleContext, line: Line,
  [id, raw, anchor, scope]: readonly [string, string, (string | null)?, (string | null)?], rawStart: number): BoundQuote | undefined {
  const text = stripInspectionLabel(raw);
  const term = (anchor && stripInspectionLabel(anchor)) || text;
  if (!text || (scope && scope !== "current") || text !== text.trim() || !text.includes(term) || /[\r\n<>]/u.test(text) || /^[、，,。；;]|[。；;]$/u.test(text)) return undefined;
  const terms = offsets(text, term);
  if (terms.length !== 1) return undefined;
  const start = rawStart + raw.length - text.length, at = start + terms[0];
  const readingStart = line.contextOffset + start;
  const readingText = line.reading.slice(readingStart, readingStart + text.length);
  const readingTerm = readingText.slice(terms[0], terms[0] + term.length);
  const reading = recordedFindingReading(line.reading, readingTerm);
  // A contiguous, independently affirmed span can carry several clauses in a witness report.
  // Local subject, negation and temporal checks still apply to each clause and governed finding.
  const affirmativePassage = /[，,]/u.test(readingText) && recordedFindingReading(line.reading, readingText) === "affirmed" &&
    affirmedClinicalSourceClauses(line.reading).some((affirmed) => affirmed.includes(readingText));
  if (!isCurrentFindingAt(line, at, term, affirmativePassage)) return undefined;
  // An assertion can carry more than one finding (including one in a denial run).
  for (const finding of GOVERNED_FINDINGS) {
    if (!text.includes(finding)) continue;
    for (const local of offsets(text, finding)) {
      if (!isCurrentFindingAt(line, start + local, finding, affirmativePassage)) return undefined;
    }
  }
  const fragments = [...text.matchAll(/[^，,。；;！？]+/gu)];
  for (const fragment of fragments) {
    const part = fragment[0].trim();
    if (clinicalClausePolarity(part) !== "affirmed" &&
      !((GOVERNED_FINDINGS.includes(part) || /^无(?:苔|异常)$/u.test(part)) && recordedFindingReading(line.context, part) === "affirmed")) return undefined;
    if (!isCurrentFindingAt(line, start + fragment.index, fragment[0], affirmativePassage)) return undefined;
  }
  if (reading !== "affirmed" && reading !== "conflicting") {
    // Whole-quote matching can inherit a preceding denial across a comma even when every
    // component of a contiguous descriptive span has an affirmed reading at its own position.
    const affirmedSpan = fragments.length > 1 && fragments.every((fragment) =>
      recordMentionPolarityAt(line.reading, line.contextOffset + start + fragment.index) === "affirmed") &&
      affirmedClinicalSourceClauses(line.reading).some((affirmed) => affirmed.includes(readingText));
    if (reading === "denied" || !(affirmedSpan || independentlyAffirmedAt(line.reading, line.contextOffset + at))) return undefined;
  }
  // A separately attested current negative conflicts with a proposed positive for the same occurrence.
  if (context.state.clinicalFacts?.redFlags.some((fact) => fact.status === "negative" && fact.quote?.includes(term) &&
      line.text.indexOf(fact.quote) >= 0 && fact.quote.includes(text))) return undefined;
  return { line: id, at: start, end: start + text.length, term, text };
}

export function isNormalInspection(field: Inspection, finding: Finding): boolean {
  const normal = inspectionLexiconNormal(field).split(/[，、]/u);
  return normal.some((part) => part === finding.term) || new RegExp(rules.normalInspection, "u").test(finding.term) ||
    (!/^[无不]/u.test(finding.term) && withoutNormalFindingSegments(finding.term) === "");
}
