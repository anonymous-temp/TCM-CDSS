import "server-only";
import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { authoritativePatientAgeYears, clinicalGroundingText, clauseLocalMentionPolarityAt, recordMentionPolarityAt, recordedFindingReading } from "./diagnosis-safety";
import { clinicalEventTemporalScopeAt, RECORD_GAP_MARKER, stripClinicalSectionLabel } from "./clinical-polarity";
import { isUnrecordedInspectionFieldValue } from "./clinical-state";
import { buildTrustedRecordIndex, deliveryHash } from "./delivery-trusted-record.server";
import { chiefComplaintFindings, chiefComplaintPhrase, rationaleFindingsChecklist } from "./rationale-findings-checklist";
import { followupConversationView } from "./followup-conversation";
import { getLineageCard, resolveLineageCode } from "./tcm-lineages";
import { isTextbookDiseaseName, splitTextbookDiseaseSubtype, textbookDiseaseDiagnosisPoints, textbookRowForSyndrome, tongueOptionsMutuallyExclusive, pulseOptionsMutuallyExclusive, withoutFingerVeinClause } from "./tcm-textbook-syndromes";
import { diagnosticsCriteriaFor, elementCompositeCriteriaEntry, compoundCriteriaEntries } from "./m03-secondary-syndrome-consistency.server";
import { entailedElements, syndromeElementLedger } from "./m03-syndrome-element-closure.server";
import { withoutNormalFindingSegments } from "./diagnosis-visible-summary";
import { inspectionLexiconNormal, TCM_INSPECTION_AXES } from "./tcm-inspection-lexicon";
import exam from "../data/physical-exam-claim-lexicon.source.json";
import symptomAxis from "../data/tcm-symptom-axis-map.source.json";
import rules from "../data/m03-final-rationale-policy.source.json";
import { FINAL_RATIONALE_VERSION } from "./m03-final-rationale-policy";
import { FINAL_RATIONALE_SYSTEM, type RationaleRejection } from "./m03-final-rationale-outline.server";

export type Inspection = "tongue" | "pulse";
type Line = { id: string; text: string; path: string; offset: number; contextOffset: number; inspection?: Inspection; chief: boolean; current: boolean; context: string };
export type Finding = { line: string; at: number; term: string };
const unique = <T>(items: readonly T[]) => [...new Set(items)];
const inspectionKeys = ["tongue", "pulse"] as const;
const inspectionPaths = {
  tongue: new RegExp(rules.tonguePath, "u"),
  pulse: new RegExp(rules.pulsePath, "u"),
};
const inspectionPrefix = { tongue: new RegExp(rules.tonguePrefix, "u"), pulse: /^(?:脉象|切诊)\s*[:：]\s*/u };
const inspectionWords = { tongue: /^(?:舌(?!下含服)|苔)/u, pulse: new RegExp(rules.pulseFindingPrefix, "u") };
const historyHeading = new RegExp(rules.historyHeading, "u");

export const GOVERNED_FINDINGS = unique([
  ...symptomAxis.entries.flatMap((entry) => entry.terms),
  ...exam.groups.flatMap((entry) => entry.terms),
  ...TCM_INSPECTION_AXES.flatMap((axis) => [...axis.groups.flatMap((group) => group.terms), ...axis.normal.split(/[，、]/u)]),
]).filter((term) => term.length >= 2).sort((a, b) => b.length - a.length);

/** All callers of the closure package are kept behind this adapter. The synthetic chain reads
 * every supplied clause, including the lineage sentence, without inheriting therapy permissions. */
export const rationaleElements = {
  allowed(names: readonly string[]) {
    return entailedElements(names);
  },
  asserted(value: string) {
    return syndromeElementLedger({ pathogenesis: { chain: value.split(/[，,。；;！？]/u).map((pathogenesis) => ({ pathogenesis })) } });
  },
  fits(unit: { type: string; organs: string[] }, names: readonly string[]) {
    const hit = entailedElements(names).get(unit.type);
    return hit === "any" || Boolean(hit && unit.organs.every((organ) => hit.has(organ)));
  },
};

function recordLines(state: CaseState): Line[] {
  const sources = buildTrustedRecordIndex(state).sources;
  const conversation = followupConversationView(state.conversation);
  const followupAnswers = new Set(conversation.answers.map((answer) => answer.answer));
  const hasPrimaryRecord = Boolean(state.hisRecord?.rawText || Object.values(state.hisRecord?.fields || {}).some(Boolean) || conversation.primaryNarrative.length);
  const lines: Line[] = [];
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
      lines.push({ id: "", path: source.sourcePath, offset: match.index + contextOffset, contextOffset, context: raw, text, inspection: field, chief, current });
    }
  }
  // Bound the prompt using complete lines and keep direct four-examination entries and the chief complaint first.
  lines.sort((a, b) => Number(b.chief) - Number(a.chief) || Number(Boolean(b.inspection)) - Number(Boolean(a.inspection)) || Number(b.current) - Number(a.current));
  return lines.map((line, index) => ({ ...line, id: `r${index + 1}` }));
}

function offsets(text: string, term: string): number[] {
  if (!term) return [];
  return [...text.matchAll(new RegExp(term.replace(/[.*+?^$${}()|[\]\\]/gu, "\\$&"), "gu"))].map((match) => match.index);
}

export function isCurrentFindingAt(line: Line, at: number, term: string): boolean {
  const offset = line.contextOffset + at;
  return line.current && recordMentionPolarityAt(line.context, offset) === "affirmed" &&
    clauseLocalMentionPolarityAt(line.context, offset) === "affirmed" &&
    clinicalEventTemporalScopeAt(line.context, offset, term.length) === "current";
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
      const term = raw.replace(inspectionPrefix[field], "");
      if ((!explicit && !inspectionWords[field].test(term)) || isUnrecordedInspectionFieldValue(term, field) || !/\p{Script=Han}/u.test(term)) continue;
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
    allowed: names.map((name) => Object.fromEntries([...rationaleElements.allowed([name])].map(([key, value]) => [key, value === "any" ? value : [...value]]))),
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
  return { key, input, lines, facts, recordText, state, root };
}

export type FinalRationaleContext = NonNullable<ReturnType<typeof buildFinalRationaleContext>>;

export function finalRationaleMessages(context: FinalRationaleContext, reasons: RationaleRejection[] = []) {
  return [
    { role: "system" as const, content: FINAL_RATIONALE_SYSTEM },
    { role: "user" as const, content: JSON.stringify({ ...context.input, snapshot: context.key, ...(reasons.length ? { revise: reasons } : {}) }) },
  ];
}

export type BoundQuote = Finding & { text: string; end: number };

export function bindRationaleQuote(context: FinalRationaleContext, quote: readonly [string, string, string, string?]): BoundQuote | undefined {
  const [id, text, term, scope] = quote;
  const line = context.lines.find((entry) => entry.id === id);
  if (!line || (scope && scope !== "current") || text !== text.trim() || !text.includes(term) || /[\r\n<>]/u.test(text) || /^[、，,。；;]|[。；;]$/u.test(text)) return undefined;
  const spans = offsets(line.text, text);
  const terms = offsets(text, term);
  if (spans.length !== 1 || terms.length !== 1) return undefined;
  const start = spans[0], at = start + terms[0];
  if (!isCurrentFindingAt(line, at, term)) return undefined;
  // An assertion can carry more than one finding (including one in a denial run).
  for (const finding of GOVERNED_FINDINGS) {
    if (!text.includes(finding)) continue;
    for (const local of offsets(text, finding)) {
      if (!isCurrentFindingAt(line, start + local, finding)) return undefined;
    }
  }
  const localFragment = text.split(/[，,、]/u).filter(Boolean);
  if (localFragment.some((part) => !isCurrentFindingAt(line, start + text.indexOf(part), part))) return undefined;
  const reading = recordedFindingReading(line.context, term);
  if (reading !== "affirmed" && reading !== "conflicting") return undefined;
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
