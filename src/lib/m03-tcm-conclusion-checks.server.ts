import "server-only";
import { z } from "zod";
import {
  activeM03TcmUnits, deepFreezeM03, locateM03TcmQuotes, m03TcmHash, parseM03TcmProposal,
  type CheckStatus, type CheckedUnit, type M03TcmConclusion, type M03TcmConclusionProposal,
  type M03TcmContext, type RecordQuote,
} from "./m03-tcm-conclusion";
import { criteriaItemsFor, diagnosticsCriteriaFor, evaluateCriteriaMatches, secondaryStructurallyInvalid } from "./m03-secondary-syndrome-consistency.server";
import { isCriticalSyndromeName } from "./m03-critical-syndrome";
import { resolveM03TcmAnchor } from "./m03-tcm-anchor";
import type { FormulaReferenceCaseSafety } from "./tcm-formula-provenance";
import { recordAnemiaGrade } from "./delivered-surface";
import { textbookRowForSyndrome } from "./tcm-textbook-syndromes";

export type M03TcmCheckInput = {
  baseRevision: number; inputHash: string; proposal: M03TcmConclusionProposal;
  quotes: RecordQuote[]; context: M03TcmContext;
};
export type M03TcmCheckEnvelope<T> = { baseRevision: number; inputHash: string; result: T };
const MatchSchema = z.object({ item: z.string().min(1).max(200), quoteId: z.string().min(1).max(100) }).strict();
const UnitResultSchema = z.object({ id: z.string(), status: z.enum(["matched", "fail", "unknown"]), matches: z.array(MatchSchema).max(40) }).strict();
const DiseaseResultSchema = z.object({ checker: z.enum(["visit_reason", "history", "disease_points"]),
  status: z.enum(["pass", "fail", "unknown", "not_applicable"]), replacement: z.string().nullable(), quoteIds: z.array(z.string()).max(16) }).strict();
const MethodResultSchema = z.object({ id: z.string(), status: z.enum(["pass", "fail", "unknown"]) }).strict();
export type M03TcmConclusionCheckIO = {
  /** Narrow cross-provider semantic quote→item matching. Server owns criteria counting. */
  checkUnits?: (input: M03TcmCheckInput, signal: AbortSignal, absoluteDeadline: number) => Promise<M03TcmCheckEnvelope<unknown[]>>;
  /** Adapt legacy unknown/skip explicitly; never pass a legacy failure-as-fits through unchanged. */
  checkDisease?: (input: M03TcmCheckInput, signal: AbortSignal, absoluteDeadline: number) => Promise<M03TcmCheckEnvelope<unknown[]>>;
  checkMethods?: (input: M03TcmCheckInput, signal: AbortSignal, absoluteDeadline: number) => Promise<M03TcmCheckEnvelope<unknown[]>>;
  checkLineage?: (input: M03TcmCheckInput, signal: AbortSignal, absoluteDeadline: number) => Promise<M03TcmCheckEnvelope<{ status: CheckStatus }>>;
  caseSafety: FormulaReferenceCaseSafety;
};
export type ConclusionCheckResult =
  | { kind: "ready" | "bounded"; record: M03TcmConclusion; reasons: string[] }
  | { kind: "redraw"; violations: string[]; draft: M03TcmConclusionProposal }
  | { kind: "unusable"; reasons: string[] };

/** One absolute clock and caller abort for every injected call (including an uncooperative fake IO). */
export async function withinM03TcmBudget<T>(run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, absoluteDeadline: number): Promise<T> {
  signal.throwIfAborted();
  const remaining = absoluteDeadline - Date.now();
  if (remaining <= 0) throw new Error("m03_tcm_deadline");
  const local = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => { local.abort(signal.reason); reject(signal.reason || new Error("m03_tcm_aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { local.abort(); reject(new Error("m03_tcm_deadline")); }, remaining);
  });
  try { return await Promise.race([run(local.signal), cancelled]); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
}

/** Old revision results never touch a later record, even when a callback completed successfully. */
export function acceptM03TcmCheck<T>(input: M03TcmCheckInput, envelope: M03TcmCheckEnvelope<T> | undefined): T | undefined {
  return envelope && envelope.baseRevision === input.baseRevision && envelope.inputHash === input.inputHash ? envelope.result : undefined;
}
const unique = <T>(values: readonly T[]) => [...new Set(values)];
const currentAbnormal = (quote: RecordQuote) => quote.scope === "current" && quote.polarity === "affirmed" && quote.observation === "abnormal";

export { m03TcmCheckPolicy } from "./m03-tcm-policy";
import { m03TcmCheckPolicy } from "./m03-tcm-policy";

export async function checkM03TcmConclusion(
  value: unknown, ctx: M03TcmContext, io: M03TcmConclusionCheckIO,
  signal: AbortSignal, absoluteDeadline: number, revision = 1, enabled = m03TcmCheckPolicy(),
): Promise<ConclusionCheckResult> {
  const parseViolations: string[] = [];
  let proposal: M03TcmConclusionProposal;
  try { proposal = parseM03TcmProposal(value, ctx, parseViolations); }
  catch (error) { return { kind: "unusable", reasons: ["invalid_proposal", error instanceof Error ? error.message : "proposal_shape"] }; }
  const quotes = locateM03TcmQuotes(proposal, ctx);
  const input: M03TcmCheckInput = deepFreezeM03(structuredClone({ baseRevision: revision,
    inputHash: m03TcmHash({ revision, proposal, ctx }), proposal, quotes, context: ctx })) as M03TcmCheckInput;
  const execute = async <T>(fn: ((input: M03TcmCheckInput, signal: AbortSignal, deadline: number) => Promise<M03TcmCheckEnvelope<T>>) | undefined) => {
    if (!fn) return undefined;
    try { return acceptM03TcmCheck(input, await withinM03TcmBudget((child) => fn(input, child, absoluteDeadline), signal, absoluteDeadline)); }
    catch { signal.throwIfAborted(); return undefined; }
  };
  const [rawUnits, rawDiseases, rawMethods, lineage] = await Promise.all([
    execute(io.checkUnits), execute(io.checkDisease), execute(io.checkMethods), execute(proposal.lineage ? io.checkLineage : undefined),
  ]);
  signal.throwIfAborted();
  const units = Array.isArray(rawUnits) ? rawUnits.flatMap((raw) => { const result = UnitResultSchema.safeParse(raw); return result.success ? [result.data] : []; }) : [];
  const diseases = Array.isArray(rawDiseases) ? rawDiseases.flatMap((raw) => { const result = DiseaseResultSchema.safeParse(raw); return result.success ? [result.data] : []; }) : [];
  const methodChecks = Array.isArray(rawMethods) ? rawMethods.flatMap((raw) => { const result = MethodResultSchema.safeParse(raw); return result.success ? [result.data] : []; }) : [];
  const quoteIds = (indices: readonly number[]) => unique(indices.map((index) => `Q${index + 1}`)).filter((id) => quotes.some((quote) => quote.id === id));
  const diseaseQuotes = quoteIds(proposal.disease.quotes);
  const diseaseRows = diseases.filter((row) => diseases.filter((other) => other.checker === row.checker).length === 1 &&
    (row.checker !== "disease_points" || enabled.diseasePoints) && (row.checker !== "visit_reason" || enabled.visitReason));
  const failed = diseaseRows.filter((row) => row.status === "fail" && row.quoteIds.length > 0 && row.quoteIds.every((id) => quotes.some((quote) => quote.id === id)));
  if (failed.length > 0) {
    const order = ["visit_reason", "history", "disease_points"];
    return { kind: "redraw", draft: proposal, violations: failed.sort((a, b) => order.indexOf(a.checker) - order.indexOf(b.checker))
      .map((row) => `${row.checker}:${proposal.disease.name}:${ctx.diseases.some((item) => item.name === row.replacement) ? row.replacement : ""}`) };
  }
  // Both applicable semantic disease checks must be available; a skip is never evidence.
  const diseasePassed = ["visit_reason", "disease_points"].every((checker) => {
    const row = diseaseRows.find((item) => item.checker === checker);
    return row?.status === "pass" || checker === "visit_reason" && row?.status === "not_applicable";
  }) && diseaseRows.some((row) => row.status === "pass") && diseaseQuotes.some((id) => quotes.some((quote) => quote.id === id && currentAbnormal(quote)));
  if (!diseasePassed) return { kind: "unusable", reasons: ["disease_unverified"] };
  const record: M03TcmConclusion = {
    version: "m03-tcm-conclusion-v1", revision, disease: { name: proposal.disease.name, quoteIds: diseaseQuotes, status: "pass" }, quotes,
    locations: [], root: [], branch: [], primary: { name: proposal.primary, locationIds: [], elementIds: [], resolution: "bounded" }, secondary: [],
    methods: [], direction: proposal.direction, formulaLock: { names: [], mode: "none", sourceIds: [] },
    anchor: { textbookRowId: null, jingfangId: null, compositeRuleId: null }, pending: [], lineage: null,
    checks: diseaseRows.map((row) => ({ checker: row.checker, inputHash: input.inputHash, status: row.status })),
  };
  const pending = (id: string, label: string, seen: string[], criteria: string[], reason: string) => {
    if (!record.pending.some((item) => item.id === id)) record.pending.push({ id, target: label, seenQuoteIds: seen, missingCriteriaIds: criteria, reasonCode: reason });
  };
  const proposals = [...proposal.locations, ...proposal.elements.root, ...proposal.elements.branch];
  for (const unit of proposals) {
    const candidate = ctx.units.find((item) => item.id === unit.id)!;
    const replies = units.filter((item) => item.id === unit.id);
    const reply = replies.length === 1 && (candidate.kind === "location" || enabled.elements) ? replies[0] : undefined;
    const refs = quoteIds(unit.quotes);
    const matches = reply?.status === "matched" ? reply.matches.filter((match) => candidate.criteriaIds.includes(match.item) && refs.includes(match.quoteId) && quotes.some((quote) => quote.id === match.quoteId && currentAbnormal(quote))) : [];
    const entry = candidate.criteriaName ? diagnosticsCriteriaFor(candidate.criteriaName) : undefined;
    const criterionMatches = entry ? matches.filter((match) => criteriaItemsFor(entry).includes(match.item)).map((match) => ({ item: match.item, quote: quotes.find((quote) => quote.id === match.quoteId)!.text })) : [];
    // Primary and base factors must not subtract their own manifestations. Secondary independence is checked below.
    const unitQuotes = quotes.filter((quote) => refs.includes(quote.id) && currentAbnormal(quote));
    const verdict = entry ? evaluateCriteriaMatches(entry, criterionMatches, { recordText: unitQuotes.map((quote) => quote.text).join("。"), primaryTerms: [], breadth: true }) : undefined;
    const strict = candidate.kind === "location" ? matches.length > 0 : verdict?.verdict === "pass" && verdict.strict === true;
    const status: CheckStatus = strict ? "pass" : reply?.status === "fail" || verdict?.verdict === "fail" ? "fail" : "unknown";
    // The legacy Hb rule contributes a derived finding; retain its real numeric quote and rule ID.
    const derivedHb = verdict?.quotes?.includes("血红蛋白偏低") ? unitQuotes.filter((quote) => recordAnemiaGrade(quote.text, undefined) !== undefined).map((quote) => quote.id) : [];
    const counted = unique([...matches.map((match) => match.quoteId), ...derivedHb]);
    record.checks.push({ checker: unit.id, inputHash: input.inputHash, status });
    if (!strict || counted.length === 0) { pending(unit.id, candidate.label, refs, candidate.criteriaIds, verdict?.verdict === "pass" ? "breadth_only" : "unit_unverified"); continue; }
    const checked: CheckedUnit = { id: unit.id, label: candidate.label, locationIds: [...candidate.locationIds], quoteIds: counted,
      criteriaIds: unique([...matches.map((match) => match.item), ...(derivedHb.length ? ["rule:record-anemia-grade"] : [])]), status: "pass", strict: true, reasonCode: "strict_criteria" };
    if (candidate.kind === "location") record.locations.push(checked);
    else record[candidate.kind].push(checked);
  }
  // Dependencies on a withdrawn location invalidate only the units that need it.
  for (const kind of ["root", "branch"] as const) record[kind] = record[kind].filter((unit) => {
    if (unit.locationIds.every((id) => record.locations.some((location) => location.id === id))) return true;
    pending(unit.id, unit.label, unit.quoteIds, unit.criteriaIds, "location_unverified"); return false;
  });
  const supported = (name: string) => {
    const candidate = ctx.syndromes.find((item) => item.name === name);
    const ids = new Set(activeM03TcmUnits(record).map((unit) => unit.id));
    return candidate && [...candidate.elementIds, ...candidate.locationIds].every((id) => ids.has(id)) &&
      (candidate.elementIds.length > 0 || candidate.neutral === true && candidate.locationIds.length > 0) ? candidate : undefined;
  };
  const primary = supported(proposal.primary);
  const passedElements = [...record.root, ...record.branch].map((unit) => unit.id);
  const composite = primary && ctx.syndromes.find((candidate) => candidate.compositeRuleId && supported(candidate.name) &&
    candidate.elementIds.length === passedElements.length && passedElements.every((id) => candidate.elementIds.includes(id)) &&
    primary.elementIds.every((id) => candidate.elementIds.includes(id)));
  // Bounded names must already be governed neutral candidates, never an invented substitute.
  const selected = composite || primary || ctx.syndromes.find((candidate) => candidate.neutral && supported(candidate.name));
  if (!selected) return { kind: "unusable", reasons: ["naming_gap"] };
  record.primary = { name: selected.name, locationIds: [...selected.locationIds], elementIds: [...selected.elementIds], resolution: "bounded" };
  const primaryTerms = unique(selected.elementIds.flatMap((id) => activeM03TcmUnits(record).find((unit) => unit.id === id)?.quoteIds || []).flatMap((id) => quotes.find((quote) => quote.id === id)?.text || []));
  for (const name of proposal.secondary) {
    const candidate = enabled.secondary ? supported(name) : undefined;
    if (!candidate || secondaryStructurallyInvalid(selected.name, name, "", record.disease.name)) { pending(`secondary:${name}`, name, [], [], "secondary_structure"); continue; }
    const independent = candidate.elementIds.every((id) => {
      const unit = ctx.units.find((item) => item.id === id)!;
      const entry = unit.criteriaName && diagnosticsCriteriaFor(unit.criteriaName);
      const result = units.find((item) => item.id === id);
      const matches = result?.matches.filter((match) => proposals.find((item) => item.id === id)?.quotes.includes(Number(match.quoteId.slice(1)) - 1) && unit.criteriaIds.includes(match.item) && quotes.some((quote) => quote.id === match.quoteId && currentAbnormal(quote))) || [];
      return entry && evaluateCriteriaMatches(entry, matches.map((match) => ({ item: match.item, quote: quotes.find((quote) => quote.id === match.quoteId)!.text })),
        { recordText: quotes.filter((quote) => activeM03TcmUnits(record).find((item) => item.id === id)?.quoteIds.includes(quote.id) && currentAbnormal(quote)).map((quote) => quote.text).join("。"), primaryTerms }).strict === true;
    });
    if (independent && candidate.elementIds.some((id) => !selected.elementIds.includes(id))) record.secondary.push({ name, locationIds: [...candidate.locationIds], elementIds: [...candidate.elementIds] });
    else pending(`secondary:${name}`, name, [], [], "secondary_not_independent");
  }
  // Existing critical-syndrome identity may promote only an already checked candidate.
  const critical = record.secondary.findIndex((item) => isCriticalSyndromeName(item.name));
  if (!isCriticalSyndromeName(record.primary.name) && critical >= 0) {
    const promoted = record.secondary[critical];
    const previous = record.primary;
    record.primary = { ...promoted, resolution: "bounded" };
    record.secondary[critical] = { name: previous.name, locationIds: previous.locationIds, elementIds: previous.elementIds };
  }
  if (isCriticalSyndromeName(record.primary.name) && record.disease.name !== "虚脱" && !textbookRowForSyndrome(record.disease.name, record.primary.name)) {
    if (!ctx.diseases.some((item) => item.name === "虚脱")) return { kind: "unusable", reasons: ["critical_disease_candidate_missing"] };
    return { kind: "redraw", draft: proposal, violations: [`critical:${record.disease.name}:虚脱`] };
  }
  // Naming cannot silently drop a passed factor or leave it asserted outside the name.
  const named = new Set([record.primary, ...record.secondary].flatMap((item) => item.elementIds));
  for (const kind of ["root", "branch"] as const) record[kind] = record[kind].filter((unit) => {
    if (named.has(unit.id)) return true;
    pending(unit.id, unit.label, unit.quoteIds, unit.criteriaIds, "naming_gap"); return false;
  });
  const validIds = new Set(activeM03TcmUnits(record).map((unit) => unit.id));
  for (const method of proposal.methods) {
    const candidate = ctx.methods.find((item) => item.text === method.text)!;
    const replies = methodChecks.filter((item) => item.id === candidate.id);
    const refs = quoteIds(method.quotes).filter((id) => quotes.some((quote) => quote.id === id && currentAbnormal(quote)));
    if (enabled.methods && replies.length === 1 && replies[0].status === "pass" && refs.length > 0 && method.targets.every((id) => validIds.has(id))) {
      record.methods.push({ ...candidate, targets: unique(method.targets), quoteIds: refs });
    } else pending(`method:${candidate.id}`, candidate.text, refs, [], "method_unverified");
  }
  if (record.methods.length === 0) return { kind: "unusable", reasons: ["methods_unverified"] };
  if (enabled.lineage && proposal.lineage && lineage?.status === "pass" && ctx.lineage && proposal.lineage.targets.every((id) => validIds.has(id))) record.lineage = proposal.lineage;
  else if (proposal.lineage) pending("lineage", ctx.lineage?.label || proposal.primary, [], [], "lineage_unverified");
  record.primary.resolution = record.pending.length === 0 && primary && primary.elementIds.length > 0 ? "resolved" : "bounded";
  const anchored = resolveM03TcmAnchor(record, ctx, io.caseSafety);
  if (anchored.record.methods.length === 0) return { kind: "unusable", reasons: ["methods_unverified"] };
  return { kind: record.primary.resolution === "bounded" ? "bounded" : "ready", record: anchored.record, reasons: [...parseViolations, ...anchored.reasons] };
}
