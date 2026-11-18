import "server-only";

import compositeNames from "../data/tcm-syndrome-composite-names.source.json";
import promotion from "../data/tcm-syndrome-element-promotion.source.json";
import deficiency from "../data/tcm-deficiency-element-lexicon.source.json";
import { affirmedClinicalSourceClauses, clinicalEventTemporalScopeAt } from "./clinical-polarity";
import { governedFourCharacterMethodTerms, resolveNationalStandardTcmSyndromeTerm } from "./clinical-governance-tables";
import { clinicalGroundingText, clauseLocalMentionPolarityAt } from "./diagnosis-safety";
import { applyGovernedCompositeName, compositeSyndromeRename } from "./delivered-surface";
import { withMethodImpliedNatureElements } from "./analysis-element-closure";
import { closureGuardReason } from "./m03-element-closure-guard.server";
import { isCriticalSyndromeName } from "./m03-critical-syndrome";
import {
  checkM03ElementClosure, closureObject, closureRule, closureStrings, collectM03ElementAssertions,
  deliveryNamePairs, deliveryPairCovered, elementAssertionsInText, elementClosureLexicon, elementClosurePolicy, m03ElementContext, pairKey,
  pruneM03ElementAssertions, rowElementPairs, selectedElementRow,
  type ClosureJson, type ElementAssertion, type ElementClosurePolicy, type ElementPair, type FinalM03ElementContext,
} from "./m03-element-assertions";
import { elementSupportEnabled } from "./m03-element-support.server";
import {
  diagnosticsCriteriaFor, evaluateCriteriaMatches, primaryManifestationTerms, reconcileSecondarySyndromes, requestGroupedSecondaryCriteria,
  secondaryCriteriaTargets, secondaryStructurallyInvalid, sharesPrimaryCriteriaManifestation,
  type CriteriaEntry, type CriteriaMatches, type CriteriaVerdict, type SecondaryCriteriaVerifier,
} from "./m03-secondary-syndrome-consistency.server";
import {
  decideElementSupport, entailedElements, groupedCollapseSignal, syndromeElementLedger, withdrawM03RationaleFallback,
  type ClosureContext,
} from "./m03-syndrome-element-closure.server";
import { textbookFormulaRowsForDisease } from "./tcm-textbook-syndromes";

export { findUnsupportedM03ElementAssertions, type FinalM03ElementContext } from "./m03-element-assertions";

const str = (v: unknown) => typeof v === "string" ? v.trim() : "";
const dedupe = <T,>(values: readonly T[]) => [...new Set(values)];
const coveredByLegacy = (pair: ElementPair, names: readonly string[]) => {
  const hit = entailedElements(names).get(pair.type);
  return hit === "any" || Boolean(hit && (!pair.organ || hit.has(pair.organ)));
};
const readJson = (content: string) => {
  try { return closureObject(JSON.parse(content)); } catch { return undefined; }
};
const criticalName = (name: string) => isCriticalSyndromeName(name) || name.endsWith("脱证");
function hasM03ElementScope(root: ClosureJson): boolean {
  const overview = closureObject(root.overview);
  const chain = closureObject(root.pathogenesis)?.chain;
  return Boolean(str(overview?.primarySyndrome)) && (overview?.primarySyndromeResolution !== "unresolved"
    || Array.isArray(chain) && chain.length > 0);
}
const namesOf = (context: FinalM03ElementContext) => [context.primarySyndrome, ...context.secondarySyndromes];
const family = new Map(elementClosureLexicon.families.map(row => [row.type, row]));
const localized: Record<string, Record<string, string[]>> = elementClosureLexicon.locatedCriteria;
const deficiencyTypes: Record<string, { genericEntry: string; organEntrySuffix: string }> = deficiency.types;

type ClosureLookup = { entries: string[]; name?: string };
export function closureCriteriaLookup(pair: ElementPair, compound?: string): ClosureLookup {
  if (compound) {
    const row = elementClosureLexicon.compounds.find(row => row.mention === compound);
    if (row) {
      const situated = ("located" in row ? row.located : undefined) as Record<string, string[]> | undefined;
      const [entry, name] = pair.organ && situated?.[pair.organ] || [];
      // Components are individually tested. A generic component cannot license a located compound.
      return entry ? { entries: [entry], name } : { entries: pair.organ ? [] : row.entries, name: row.name };
    }
  }
  if (pair.organ) {
    const [entry, name] = localized[pair.type]?.[pair.organ] || [];
    if (entry && diagnosticsCriteriaFor(entry)) return { entries: [entry], name };
    const suffix = deficiencyTypes[pair.type]?.organEntrySuffix;
    const locatedEntry = suffix && diagnosticsCriteriaFor(`${pair.organ}${suffix}`);
    return locatedEntry ? { entries: [locatedEntry.name], name: locatedEntry.name } : { entries: [] };
  }
  const row = family.get(pair.type);
  return { entries: row?.entry ? [row.entry] : [], name: row?.name };
}

// Every candidate can spend the existing secondary-criteria slot once. Compatibility
// readers and closure readers use the same raw matches, with their own count policy.
function createCriteriaBatch(recordText: string, targets: readonly CriteriaEntry[], policy: ElementClosurePolicy, signal?: AbortSignal,
  request = requestGroupedSecondaryCriteria) {
  const planned = new Map(targets.map(entry => [entry.name, entry]));
  let result: Promise<Map<string, CriteriaMatches>> | undefined;
  const run = () => result ??= Promise.resolve().then(() => request([...planned.values()], recordText, signal)).catch(() => new Map());
  const verify: SecondaryCriteriaVerifier = async (name, context) => {
    const selected = secondaryCriteriaTargets(name);
    for (const entry of selected) planned.set(entry.name, entry);
    return reduceVerdicts(selected.map(entry => {
      return run().then(matches => {
        const own = matches.get(entry.name);
        if (!own) return noVerdict(entry.name);
        return policy.mode === "enforce" ? evaluateClosureCriteria(entry, own, recordText, context.primaryTerms, closureRule(policy, "d6"))
          : evaluateCriteriaMatches(entry, own, context);
      });
    }));
  };
  return { run, verify, started: () => result !== undefined };
}

const noVerdict = (entry?: string): CriteriaVerdict => ({ verdict: "unknown", entry, specific: 0, category: 0, listed: 0, distinct: 0 });
async function reduceVerdicts(values: Array<Promise<CriteriaVerdict>>): Promise<CriteriaVerdict> {
  const verdicts = await Promise.all(values);
  return verdicts.find(item => item.verdict === "unknown") ?? verdicts.find(item => item.verdict === "fail")
    ?? verdicts.find(item => !item.strict) ?? verdicts[0] ?? noVerdict();
}

function criteriaRecord(context: ClosureContext): string {
  const histories = [context.caseState?.symptoms, context.caseState?.hisRecord?.fields].flatMap(value => {
    const fields = closureObject(value);
    return fields ? elementClosureLexicon.historicalFieldKeys.flatMap(key => {
      const history = fields[key];
      return typeof history === "string" ? history.trim().split(/\r?\n/u) : [];
    }) : [];
  });
  return histories.length ? context.recordText.split(/\r?\n/u).filter(line => !histories.includes(line.trim())).join("\n") : context.recordText;
}

function currentRecordParts(record: string): { body: string[]; tongue: string[]; pulse: string[] } {
  const result: { body: string[]; tongue: string[]; pulse: string[] } = { body: [], tongue: [], pulse: [] };
  let domain: keyof typeof result | undefined = "body";
  for (const line of record.split(/\r?\n/u)) {
    const heading = /^\s*([^：:]{1,16})[：:]/u.exec(line)?.[1];
    if (heading) {
      domain = elementClosureLexicon.historicalHeaders.some(marker => heading.startsWith(marker)) ? undefined
        : elementClosureLexicon.tongueHeaders.some(marker => heading.startsWith(marker)) ? "tongue"
        : elementClosureLexicon.pulseHeaders.some(marker => heading.startsWith(marker)) ? "pulse" : "body";
    }
    if (!domain) continue;
    const close = heading ? line.indexOf(heading) + heading.length + 1 : 0;
    const value = line.slice(close);
    const chunks = value.split(/(?<=[。；;\n])/u);
    for (const chunk of chunks) {
      if (elementClosureLexicon.historicalHeaders.some(marker => chunk.trimStart().startsWith(marker))) continue;
      const hit = chunk.trim().startsWith("舌") ? "tongue" : chunk.trim().startsWith("脉") ? "pulse" : domain;
      if (chunk.trim()) result[hit].push(chunk);
    }
  }
  return result;
}

const affirms = (value: string, term: string) => {
  for (let at = value.indexOf(term); at >= 0; at = value.indexOf(term, at + term.length)) {
    if (clauseLocalMentionPolarityAt(value, at) === "affirmed"
      && clinicalEventTemporalScopeAt(value, at, term.length, { groundingQuote: true }) === "current") return true;
  }
  return false;
};

function narrowEvidence(pair: ElementPair, primary: string, record: ReturnType<typeof currentRecordParts>): string[] {
  if (pair.organ) return [];
  const { yang, stasis } = elementClosureLexicon.narrow;
  if (pair.type === "阳虚" && yang.primary.some(marker => primary.includes(marker))) {
    const finding = (terms: readonly string[], clauses: readonly string[]) => terms.find(term => clauses.some(clause => affirms(clause, term)));
    const systemic = finding(yang.systemic, record.body.flatMap(part => part.split(/[，,、]/u))
      .filter(clause => !yang.localOnly.some(marker => clause.includes(marker))));
    const assist = finding(yang.assist, record.body);
    const pulse = finding(yang.pulse, record.pulse);
    return systemic && assist && pulse ? [systemic, assist, pulse] : [];
  }
  if (pair.type === "stasis") {
    const fixed = record.body.find(clause => stasis.fixed.some(term => affirms(clause, term)) && stasis.quality.some(term => affirms(clause, term)));
    const tongue = stasis.tongue.find(term => record.tongue.some(clause => affirms(clause, term)));
    return fixed && tongue ? [stasis.fixed.find(term => affirms(fixed, term))!, stasis.quality.find(term => affirms(fixed, term))!, tongue] : [];
  }
  return [];
}

function independentDomains(record: ReturnType<typeof currentRecordParts>, quotes: readonly string[]) {
  const domains = new Set<string>();
  for (const quote of quotes) {
    if (record.tongue.some(part => affirms(part, quote))) { domains.add("tongue"); continue; }
    if (record.pulse.some(part => affirms(part, quote))) { domains.add("pulse"); continue; }
    // Overlapping extracts and repeated transcriptions belong to the same body observation.
    const chunks = record.body.flatMap(part => affirmedClinicalSourceClauses(part));
    const index = chunks.findIndex(part => part.includes(quote));
    if (index >= 0) domains.add(`body/${index}`);
  }
  return domains;
}

export function evaluateClosureCriteria(entry: CriteriaEntry, matches: CriteriaMatches, recordText: string, primaryTerms: readonly string[],
  d6: boolean, narrow: readonly string[] = []): CriteriaVerdict {
  const record = currentRecordParts(recordText);
  const current = [...record.body, ...record.tongue, ...record.pulse].join("\n");
  const affirmed = affirmedClinicalSourceClauses(current);
  const scopedMatches = matches.filter(({ quote }) => quote && affirmed.some(clause => affirms(clause, quote)));
  if (!d6) return evaluateCriteriaMatches(entry, scopedMatches, { recordText: current, primaryTerms, breadth: true });
  const ordinary = evaluateCriteriaMatches(entry, scopedMatches, { recordText: current, primaryTerms, breadth: true });
  const sharedQuotes = (ordinary.observedQuotes || []).filter(quote => sharesPrimaryCriteriaManifestation(quote, primaryTerms));
  const distinct = (ordinary.quotes || []).filter(quote => !sharedQuotes.includes(quote));
  const domains = independentDomains(record, distinct);
  if (ordinary.strict && distinct.length && domains.size >= 2) return { ...ordinary, evidenceDomains: domains.size, sharedQuotes };
  if (narrow.length) {
    const all = evaluateCriteriaMatches(entry, scopedMatches, { recordText: current, primaryTerms: [] });
    const quotes = all.quotes || [];
    const domainCount = independentDomains(record, quotes).size;
    // The existing task must recognize the differentiating text and the two independent domains.
    const confirmed = narrow.every(term => quotes.some(quote => quote.includes(term) || term.includes(quote)));
    if (confirmed && domainCount >= 2 && (all.strict || entry.name === "血瘀证" && all.specific >= 2)) {
      return { ...all, verdict: "pass", strict: true, evidenceDomains: domainCount, sharedQuotes };
    }
  }
  return { ...ordinary, strict: false, evidenceDomains: domains.size, sharedQuotes };
}

function groundedComposite(root: ClosureJson, recordText: string, policy: ElementClosurePolicy) {
  const primary = m03ElementContext(root).primarySyndrome;
  if (!compositeNames.rules.some(rule => rule.primary.includes(primary))) return;
  const lookahead = structuredClone(root);
  withMethodImpliedNatureElements(lookahead, recordText);
  // The nature column may already have lost a component while the complete
  // analysis still locates and asserts it. Only the temporary naming view uses it.
  const nature = closureObject(closureObject(lookahead.pathogenesis)?.natureDifferentiation);
  if (nature) {
    const asserted = collectM03ElementAssertions(root, policy, true).filter(hit =>
      ["prose", "mechanism", "location"].includes(hit.source) && hit.field !== "/overview/tcmDiseaseRationale");
    nature.items = dedupe([...closureStrings(nature.items), ...asserted.flatMap(hit => family.get(hit.type)?.label || [])]);
  }
  const rename = compositeSyndromeRename(lookahead, recordText, true);
  return rename?.to;
}

type EvidenceSnapshot = { composite?: string; context: FinalM03ElementContext; matches: Map<string, CriteriaMatches>; requested: Set<string> };
type AssertionGroup = { key: string; hits: ElementAssertion[]; lookup: ClosureLookup };
function assertionGroups(root: ClosureJson, policy: ElementClosurePolicy): AssertionGroup[] {
  const grouped = new Map<string, AssertionGroup>();
  for (const hit of collectM03ElementAssertions(root, policy, true)) {
    const key = hit.type === "unmapped" ? `${pairKey(hit)}${hit.label}` : pairKey(hit);
    const group = grouped.get(key) || { key, hits: [], lookup: closureCriteriaLookup(hit) };
    group.hits.push(hit);
    grouped.set(key, group);
  }
  return [...grouped.values()];
}

function boundRowContext(root: ClosureJson, prior?: FinalM03ElementContext): FinalM03ElementContext {
  const context = m03ElementContext(root);
  if (prior?.disease === context.disease && prior.textbookRow) {
    const original = selectedElementRow({ ...context, textbookRow: prior.textbookRow });
    if (original) return { ...context, textbookRow: original };
  }
  const row = selectedElementRow(context);
  return row ? { ...context, textbookRow: row } : context;
}

function closureCoverage(context: FinalM03ElementContext, policy: ElementClosurePolicy) {
  const names = namesOf(context);
  const entailed = names.flatMap(name => deliveryNamePairs(name, policy));
  const row = selectedElementRow(context);
  const permitted = rowElementPairs(row, policy);
  const named = (pair: ElementPair) => closureRule(policy, "d3") ? deliveryPairCovered(pair, entailed) : coveredByLegacy(pair, names);
  return { named, row, rowAllows: (pair: ElementPair) => deliveryPairCovered(pair, permitted) };
}

function proposedEntries(root: ClosureJson, policy: ElementClosurePolicy): CriteriaEntry[] {
  const context = m03ElementContext(root);
  const { named, rowAllows } = closureCoverage(context, policy);
  const entries = new Map<string, CriteriaEntry>();
  const add = (names: readonly string[]) => {
    for (const name of names) {
      const entry = diagnosticsCriteriaFor(name);
      if (entry) entries.set(entry.name, entry);
    }
  };
  for (const group of assertionGroups(root, policy)) {
    const pair = group.hits[0];
    if (named(pair) || (rowAllows(pair) && !hasCompositeCandidate(context.primarySyndrome, pair, policy))
      || group.hits.every(hit => hit.source === "method" || hit.source === "pending")) continue;
    add(group.lookup.entries);
    const hit = group.hits[0];
    if (hit.organ && hit.type === "阳虚" && closureRule(policy, "d6")) add([deficiency.types.阳虚.genericEntry]);
    for (const part of group.hits) if (part.compound) add(closureCriteriaLookup(part, part.compound).entries);
  }
  return [...entries.values()];
}

export async function collectM03ClosureEvidence(content: string, context: ClosureContext, policy: ElementClosurePolicy, signal?: AbortSignal,
  io: { request?: typeof requestGroupedSecondaryCriteria; reconcile?: typeof reconcileSecondarySyndromes } = {}):
Promise<{ content: string; evidence?: EvidenceSnapshot; legacyDecision?: Awaited<ReturnType<typeof decideElementSupport>> }> {
  const root = readJson(content);
  if (!root) return { content };
  const candidate = m03ElementContext(root);
  const row = selectedElementRow(candidate);
  candidate.textbookRow = row && { id: row.id };
  const composite = closureRule(policy, "d7") ? groundedComposite(root, context.recordText, policy) : undefined;
  const closureEntries = proposedEntries(root, policy);
  const existingCriteria = new Map<string, CriteriaEntry>();
  await decideElementSupport(content, context, signal, async name => {
    for (const entry of secondaryCriteriaTargets(name)) existingCriteria.set(entry.name, entry);
    return noVerdict(name);
  }, false);
  const entries = policy.mode === "observe" ? [...closureEntries, ...existingCriteria.values()] : closureEntries;
  const current = criteriaRecord(context);
  const batch = createCriteriaBatch(current, entries, policy, signal, io.request);
  const next = await (io.reconcile || reconcileSecondarySyndromes)(content, context, signal, batch.verify, policy.mode === "enforce").catch(() => content);
  const canRequest = process.env.CDSS_M03_SECONDARY_CRITERIA !== "false" || Boolean(io.request);
  const available = canRequest && (batch.started() || existingCriteria.size > 0);
  const matches = available ? await batch.run() : new Map<string, CriteriaMatches>();
  const legacyDecision = policy.mode === "observe" && available
    ? await decideElementSupport(content, context, signal, batch.verify) : undefined;
  return { content: next, evidence: { context: candidate, composite, matches, requested: new Set(available ? closureEntries.map(entry => entry.name) : []) }, legacyDecision };
}

function matchesCandidate(evidence: EvidenceSnapshot | undefined, current: FinalM03ElementContext): evidence is EvidenceSnapshot {
  if (!evidence || evidence.context.disease !== current.disease) return false;
  if (evidence.context.primarySyndrome === current.primarySyndrome) return true;
  const selected = selectedElementRow(current);
  return Boolean(selected && selected.id === evidence.context.textbookRow?.id);
}

type Disposition = "named" | "row_permitted" | `promoted:${string}` | "withdrawn" | "withdrawn_task_failed";
type ClosureLedgerRow = { pair: ElementPair; fields: string[]; disposition: Disposition; rowId?: string };
export type M03ClosureResult = {
  guard?: string; root: ClosureJson; ledger: ClosureLedgerRow[]; fits: (hit: ElementAssertion) => boolean; taskFailed: number; possible: string[];
};
type Plan = { name: string; hits: ElementAssertion[] };

function canCarry(from: string, to: string, policy: ElementClosurePolicy): boolean {
  const candidate = deliveryNamePairs(to, policy);
  const original = deliveryNamePairs(from, policy);
  return original.length > 0 && original.every(pair => deliveryPairCovered(pair, candidate));
}

function exactProposedName(name: string | undefined) {
  return resolveNationalStandardTcmSyndromeTerm(name)?.standardTerm;
}

function renamePrimary(root: ClosureJson, from: string, to: string): void {
  const overview = closureObject(root.overview)!;
  overview.primarySyndrome = to;
  for (const key of ["tcmDiagnosticRationale", "overallPathogenesis"]) {
    if (typeof overview[key] === "string") overview[key] = str(overview[key]).split(from).join(to);
  }
  if (Array.isArray(overview.tcmDifferentials)) overview.tcmDifferentials = overview.tcmDifferentials.filter(value => {
    const row = closureObject(value);
    return row && ![from, to].includes(str(row.syndrome));
  });
}

function suggestComposite(primary: string, hit: ElementAssertion, policy: ElementClosurePolicy) {
  const row = promotion.rules.find(rule => rule.primary.includes(primary) &&
    (rule.element === hit.type || rule.element === "location" && rule.organ === hit.organ && rule.requires === hit.type));
  const candidate = exactProposedName(row?.composite);
  return candidate && canCarry(primary, candidate, policy) && deliveryPairCovered(hit, deliveryNamePairs(candidate, policy)) ? candidate : undefined;
}

function hasCompositeCandidate(primary: string, hit: ElementAssertion, policy: ElementClosurePolicy) {
  return closureRule(policy, "d7") && (Boolean(suggestComposite(primary, hit, policy))
    || elementClosureLexicon.qualifiedComposites.some(rule => rule.from === primary && rule.pairs.some(pair => pairKey(pair) === pairKey(hit))));
}

function absorbDuplicateSecondary(root: ClosureJson, evidence: EvidenceSnapshot | undefined, recordText: string, policy: ElementClosurePolicy) {
  const overview = closureObject(root.overview)!;
  const context = m03ElementContext(root);
  const standard = resolveNationalStandardTcmSyndromeTerm(context.primarySyndrome);
  const primaryPairs = deliveryNamePairs(context.primarySyndrome, policy);
  const primaryBasis = closureStrings(overview.primarySyndromeBasis);
  const current = currentRecordParts(recordText);
  const rationale = str(overview.tcmDiagnosticRationale);
  const secondaries = context.secondarySyndromes.filter(name => {
    if (criticalName(name)) return true;
    const standardSecondary = resolveNationalStandardTcmSyndromeTerm(name);
    if (standard && standardSecondary?.id === standard.id) return false;
    const pairs = deliveryNamePairs(name, policy);
    if (!pairs.length || !evidence) return true;
    const targets = secondaryCriteriaTargets(name);
    if (!targets.length) return true;
    const matches = targets.flatMap(entry => evidence.matches.get(entry.name) || []);
    const quotes = dedupe(matches.flatMap(match => match.quote && [...current.body, ...current.tongue, ...current.pulse].some(part => affirms(part, match.quote!)) ? [match.quote] : []));
    // A distinct national term can be redundant for this case when its explanation and evidence
    // are coextensive with the primary. The linkage stays with these quotes and this draft.
    const sameMechanism = pairs.every(pair => deliveryPairCovered(pair, primaryPairs))
      || pairs.every(pair => pair.type === "qi-stagnation" && !pair.organ)
      && rationale.split(/[。；;]/u).some(sentence => sentence.includes(context.primarySyndrome.replace(/证$/u, ""))
        && elementAssertionsInText(sentence, "mechanism", policy).some(hit => hit.type === "qi-stagnation")
        && primaryBasis.some(quote => sentence.includes(quote) || sharesPrimaryCriteriaManifestation(quote, sentence.split(/[，,、]/u))));
    return !(sameMechanism && quotes.length >= 2 && quotes.every(quote => sharesPrimaryCriteriaManifestation(quote, primaryBasis)));
  });
  if (secondaries.length !== context.secondarySyndromes.length) overview.secondarySyndromes = secondaries;
}

export function solveM03ElementClosure(input: ClosureJson, context: ClosureContext, policy: ElementClosurePolicy = elementClosurePolicy(),
  snapshot?: EvidenceSnapshot, allowNames = true, evaluate = evaluateClosureCriteria, priorRow?: FinalM03ElementContext): M03ClosureResult {
  const root = structuredClone(input);
  const overview = closureObject(root.overview);
  const original = boundRowContext(root, priorRow || snapshot?.context);
  if (!overview || !hasM03ElementScope(root)) {
    return { root, ledger: [], fits: () => true, taskFailed: 0, possible: [] };
  }
  const evidence = matchesCandidate(snapshot, original) ? snapshot : undefined;
  if (allowNames && closureRule(policy, "d7") && !namesOf(original).some(criticalName)) {
    const collected = evidence?.context.primarySyndrome === original.primarySyndrome &&
      original.secondarySyndromes.every(name => evidence.context.secondarySyndromes.includes(name)) ? evidence.composite : undefined;
    const composite = groundedComposite(root, context.recordText, policy) || collected;
    if (composite) applyGovernedCompositeName(overview, original.primarySyndrome, original.secondarySyndromes, composite);
  }
  const initial = boundRowContext(root, original);
  const groups = assertionGroups(root, policy);
  const scope = closureCoverage(initial, policy);
  const d6 = closureRule(policy, "d6");
  const d7 = closureRule(policy, "d7");
  const currentRecord = criteriaRecord(context);
  const record = currentRecordParts(currentRecord);
  const primaryTerms = primaryManifestationTerms(scope.row);
  const failed = new Set<string>();
  const promoted = new Map<string, string>();
  if (initial.primarySyndrome !== original.primarySyndrome) {
    const prior = closureCoverage(original, policy);
    for (const group of groups) if (!prior.named(group.hits[0]) && scope.named(group.hits[0])) {
      promoted.set(group.key, initial.primarySyndrome);
    }
  }
  const possible = new Set<string>();
  const plans: Plan[] = [];
  const signatures = new Set<string>();

  const consider = (hits: ElementAssertion[], lookup: ClosureLookup) => {
    if (!hits.length || !lookup.entries.length) return;
    const name = exactProposedName(lookup.name);
    const signature = JSON.stringify([hits.map(pairKey).sort(), lookup.entries, name]);
    if (signatures.has(signature)) return;
    signatures.add(signature);
    if (name) possible.add(name);
    const verdicts = lookup.entries.map(ref => {
      const target = diagnosticsCriteriaFor(ref);
      if (!target) return noVerdict(ref);
      const raw = evidence?.matches.get(target.name);
      if (raw) {
        const narrow = d6 ? narrowEvidence(hits[0], initial.primarySyndrome, record) : [];
        return evaluate(target, raw, currentRecord, primaryTerms, d6, narrow);
      }
      if (evidence?.requested.has(target.name)) for (const hit of hits) failed.add(pairKey(hit));
      return noVerdict(ref);
    });
    if (name && verdicts.every(verdict => verdict.verdict === "pass" && verdict.strict && (!d6
      || verdict.evidenceDomains !== undefined && verdict.evidenceDomains >= 2
      && (verdict.quotes || []).some(quote => !sharesPrimaryCriteriaManifestation(quote, primaryTerms))))) plans.push({ name, hits });
  };

  for (const { hits, lookup } of groups) {
    if (scope.named(hits[0]) || (scope.rowAllows(hits[0]) && !hasCompositeCandidate(initial.primarySyndrome, hits[0], policy)) || hits.every(hit => hit.source === "method" || hit.source === "pending")) continue;
    for (const hit of hits.filter(hit => hit.compound)) {
      const parts = collectCompoundParts(groups, hit);
      if (parts.length > 1) consider(parts, closureCriteriaLookup(hit, hit.compound));
    }
    const independent = hits.find(hit => !hit.compound && hit.source !== "method" && hit.source !== "pending");
    if (independent) consider([independent], lookup);
    if (d6 && hits[0].type === "阳虚" && hits[0].organ) {
      const general = { ...hits[0], organ: undefined };
      if (narrowEvidence(general, initial.primarySyndrome, record).length) consider([general], closureCriteriaLookup(general));
    }
  }

  if (allowNames && d7) {
    const critical = groups.flatMap(group => group.hits.filter(hit => hit.source !== "method" && family.get(hit.type)?.critical));
    if (critical.length && !namesOf(initial).some(criticalName) && groupedCollapseSignal(context)) {
      const row = textbookFormulaRowsForDisease(initial.disease).find(row => criticalName(row.syndromeName)
        && exactProposedName(row.syndromeName) && critical.some(hit => deliveryPairCovered(hit, deliveryNamePairs(row.syndromeName, policy))));
      if (row && initial.secondarySyndromes.length < 6) {
        renamePrimary(root, initial.primarySyndrome, row.syndromeName);
        overview.secondarySyndromes = dedupe([...initial.secondarySyndromes, initial.primarySyndrome]);
        const criticalPairs = deliveryNamePairs(row.syndromeName, policy);
        for (const group of groups) if (deliveryPairCovered(group.hits[0], criticalPairs)) promoted.set(group.key, row.syndromeName);
      }
    }
    absorbDuplicateSecondary(root, evidence, currentRecord, policy);
    const primary = m03ElementContext(root).primarySyndrome;
    const compound = elementClosureLexicon.qualifiedComposites.find(row => row.from === primary && row.pairs.every(pair =>
      plans.some(plan => plan.hits.some(hit => pairKey(hit) === pairKey(pair)))));
    const combinedName = exactProposedName(compound?.to);
    if (compound && combinedName && canCarry(primary, combinedName, policy)
      && compound.pairs.every(pair => deliveryPairCovered(pair, deliveryNamePairs(combinedName, policy)))) {
      renamePrimary(root, primary, combinedName);
      for (const pair of compound.pairs) promoted.set(pairKey(pair), combinedName);
    }
    plans.sort((a, b) => Number(b.hits.some(hit => hit.organ)) - Number(a.hits.some(hit => hit.organ))
      || b.hits.length - a.hits.length || a.name.localeCompare(b.name, "zh-CN"));
    for (const plan of plans) {
      const final = boundRowContext(root, initial);
      const coverage = closureCoverage(final, policy);
      const fresh = plan.hits.filter(hit => !coverage.named(hit) && (!coverage.rowAllows(hit)
        || Boolean(suggestComposite(final.primarySyndrome, hit, policy))));
      if (!fresh.length || fresh.some(hit => family.get(hit.type)?.critical)) continue;
      const composite = fresh.length === 1 ? suggestComposite(final.primarySyndrome, fresh[0], policy) : undefined;
      if (!composite && fresh.every(hit => coverage.rowAllows(hit))) continue;
      const candidate = composite || plan.name;
      const own = deliveryNamePairs(candidate, policy);
      if (!fresh.every(hit => deliveryPairCovered(hit, own))) continue;
      if (composite) {
        renamePrimary(root, final.primarySyndrome, composite);
        overview.secondarySyndromes = final.secondarySyndromes.filter(name => criticalName(name)
          || !canCarry(name, composite, policy));
      } else {
        const rationale = str(overview.tcmDiagnosticRationale);
        if (final.secondarySyndromes.length >= 6 || secondaryStructurallyInvalid(final.primarySyndrome, candidate, rationale)) continue;
        overview.secondarySyndromes = [...final.secondarySyndromes, candidate];
      }
      const actual = closureCoverage(boundRowContext(root, initial), policy);
      for (const hit of fresh) if (actual.named(hit)) promoted.set(pairKey(hit), candidate);
      const therapy = closureObject(root.therapy);
      const method = (promotion.secondaryMethods as Record<string, string>)[candidate];
      const allowedMethod = method && elementAssertionsInText(method, "method", policy);
      if (therapy && allowedMethod && governedFourCharacterMethodTerms().includes(method)
        && allowedMethod.length && allowedMethod.every(hit => actual.named(hit) || actual.rowAllows(hit))) {
        const existing = str(therapy.overallMethod);
        const coversMethod = elementAssertionsInText(existing, "method", policy);
        if (fresh.some(hit => !deliveryPairCovered(hit, coversMethod))) {
          therapy.overallMethod = dedupe([existing, method].filter(Boolean)).join("，");
          if (typeof overview.overallTherapy === "string") overview.overallTherapy = therapy.overallMethod;
        }
      }
    }
  }

  const final = closureCoverage(boundRowContext(root, initial), policy);
  const fits = (hit: ElementAssertion) => final.named(hit) || final.rowAllows(hit);
  const beforeCut = assertionGroups(root, policy);
  const ledger = beforeCut.map(group => {
    const { type, organ } = group.hits[0];
    const pair = { type, organ };
    const added = promoted.get(group.key);
    const rowId = !final.named(pair) && final.rowAllows(pair) ? final.row?.id : undefined;
    const disposition: Disposition = final.named(pair) ? added ? `promoted:${added}` : "named"
      : rowId ? "row_permitted" : failed.has(group.key) ? "withdrawn_task_failed" : "withdrawn";
    return { pair, fields: dedupe(group.hits.map(hit => hit.field || "")), disposition, ...(rowId ? { rowId } : {}) };
  });
  const oldUnits = syndromeElementLedger(root).filter(unit => unit.type !== "location" && unit.sources.includes("rationale") &&
    !unit.organs.some(organ => fits({ type: unit.type, organ } as ElementAssertion)) && !fits({ type: unit.type, organ: unit.organs[0] } as ElementAssertion));
  if (allowNames) withdrawM03RationaleFallback(root, oldUnits);
  const guard = pruneM03ElementAssertions(root, policy, fits, context.recordText)
    || closureGuardReason(input, root, context.caseState ? clinicalGroundingText(context.caseState) : context.recordText)
    || (checkM03ElementClosure(root, policy, fits).length ? "remaining_assertions" : undefined);
  if (guard) return { root: input, guard, ledger: [], fits: () => true, taskFailed: 0, possible: [] };
  return { root, ledger, fits, taskFailed: ledger.filter(row => row.disposition === "withdrawn_task_failed").length, possible: [...possible] };
}

function collectCompoundParts(groups: readonly AssertionGroup[], hit: ElementAssertion): ElementAssertion[] {
  return groups.flatMap(group => group.hits.find(part => part.compound === hit.compound && part.field === hit.field && part.start === hit.start) || []);
}

export function createM03ElementClosure(context: ClosureContext, policy = elementClosurePolicy()) {
  let evidence: EvidenceSnapshot | undefined;
  let establishedRow: FinalM03ElementContext | undefined;
  let identity = "";
  let lastAudit = "";
  let guard: string | undefined;
  // One candidate spans the alignment and delivery passes. Keep the pre-edit
  // values only for fields actually changed by closure. A fresh named candidate
  // starts a new transaction, including a repair of the same syndrome.
  const originals = new Map<string, { section: string; field: string; value: unknown }>();
  let transactionName = "";
  const history = new Map<string, ClosureLedgerRow>();
  const deliver = (root: ClosureJson, allowNames: boolean) => {
    if (guard) return { root, guard, ledger: [], fits: () => true, taskFailed: 0, possible: [] };
    const current = boundRowContext(root, establishedRow);
    const contextKey = JSON.stringify([current.disease, selectedElementRow(current)?.id || current.primarySyndrome]);
    if (identity !== contextKey) { identity = contextKey; history.clear(); }
    const decision = solveM03ElementClosure(root, context, policy, evidence, allowNames, evaluateClosureCriteria, current);
    const name = JSON.stringify([current.disease, current.primarySyndrome]);
    if (allowNames || transactionName !== name) originals.clear();
    transactionName = JSON.stringify([current.disease, m03ElementContext(decision.root).primarySyndrome]);
    if (decision.guard && originals.size) {
      const restored = structuredClone(root);
      for (const { section, field, value } of originals.values()) {
        const parent = closureObject(restored[section]);
        if (parent) parent[field] = structuredClone(value);
      }
      // Run the normal contract again; never undo a subsequent safety repair.
      const record = context.caseState ? clinicalGroundingText(context.caseState) : context.recordText;
      if (!closureGuardReason(root, restored, record)) decision.root = restored;
    }
    if (!decision.guard) for (const section of ["overview", "pathogenesis", "therapy"]) {
      const before = closureObject(root[section]);
      const after = closureObject(decision.root[section]);
      if (!before || !after) continue;
      for (const field of Object.keys(after)) {
        const key = `${section}/${field}`;
        if (!originals.has(key) && JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
          originals.set(key, { section, field, value: structuredClone(before[field]) });
        }
      }
    }
    if (decision.guard) {
      guard = decision.guard;
      history.clear();
      console.info("[tcm-cdss:telemetry] m03_syndrome_element_closure", { phase: "closure_guard", reason: guard, mode: policy.mode });
    }
    establishedRow = boundRowContext(decision.root, current);
    for (const row of decision.ledger) {
      const key = JSON.stringify([row.pair, row.fields]);
      const previous = history.get(key);
      if (row.disposition === "named" && previous?.disposition.startsWith("promoted:")) continue;
      history.set(key, row);
    }
    return decision;
  };
  const inspect = (root: ClosureJson) => {
    if (!hasM03ElementScope(root)) return [];
    const current = closureCoverage(boundRowContext(root, establishedRow), policy);
    return checkM03ElementClosure(root, policy, hit => current.named(hit) || current.rowAllows(hit));
  };
  const runtime = {
    guarded: () => Boolean(guard),
    policy: { ...policy, mode: elementSupportEnabled() ? policy.mode : "off" as const },
    permits: (root: ClosureJson, hit: ElementAssertion) => {
      if (guard) return true;
      const current = closureCoverage(boundRowContext(root, establishedRow), policy);
      return current.named(hit) || current.rowAllows(hit);
    },
    collect: async (content: string, signal: AbortSignal, io?: Parameters<typeof collectM03ClosureEvidence>[4]) => {
      const next = await collectM03ClosureEvidence(content, context, policy, signal, io);
      evidence = next.evidence;
      return next;
    },
    mergeContribution: (original: string, replacement: string, rationale: boolean) => {
      if (guard) return replacement;
      if (original === replacement) return original;
      const next = readJson(replacement);
      if (!next) return original;
      const before = readJson(original);
      if (!before) return original;
      const scope = closureCoverage(boundRowContext(next, establishedRow), policy);
      const earlier = collectM03ElementAssertions(before, policy, rationale);
      const additions = collectM03ElementAssertions(next, policy, rationale).filter(hit => rationale
        ? hit.field === "/overview/tcmDiagnosticRationale" : hit.source === "method");
      return additions.some(hit => !scope.named(hit) && !scope.rowAllows(hit) && !earlier.some(old =>
        old.field === hit.field && pairKey(old) === pairKey(hit) && old.phrase === hit.phrase)) ? original : replacement;
    },
    allowsWriter: (root: ClosureJson, value: string, source: "nature" | "method" | "element" | "pending") => {
      if (guard) return true;
      const scope = closureCoverage(boundRowContext(root, establishedRow), policy);
      const allowed = (hit: ElementPair) => scope.named(hit) || scope.rowAllows(hit);
      return source === "element" ? allowed({ type: value }) : elementAssertionsInText(value, source, policy).every(allowed);
    },
    settle: deliver,
    inspect,
    audit: (root: ClosureJson) => {
      if (!hasM03ElementScope(root)) return [];
      const shadow = policy.mode === "observe" ? deliver(root, true) : undefined;
      const findings = inspect(root);
      const projected = shadow ? inspect(shadow.root) : findings;
      const auditKey = JSON.stringify([m03ElementContext(root), findings.map(hit => hit.field), [...history]]);
      if (auditKey === lastAudit) return findings;
      lastAudit = auditKey;
      const units = shadow?.ledger || [...history.values()];
      console.info("[tcm-cdss:telemetry] m03_syndrome_element_closure", {
        mode: policy.mode, phase: "final", units: units.map(row => ({
          element: pairKey(row.pair), disposition: row.disposition, fields: row.fields, ...(row.rowId ? { row: row.rowId } : {}),
        })),
        withdrawnTaskFailed: units.filter(row => row.disposition === "withdrawn_task_failed").length,
        ...(guard ? { closure_guard: guard } : {}),
        finalUnsupported: findings.length, finalPaths: dedupe(findings.flatMap(hit => hit.field || [])),
        ...(shadow ? { shadowUnsupported: projected.length } : {}),
      });
      return findings;
    },
  };
  return runtime;
}
export type M03ElementClosureRuntime = ReturnType<typeof createM03ElementClosure>;
