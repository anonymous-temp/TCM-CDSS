/**
 * Browser-safe observation helpers; no request state or patient text at module scope.
 * F integration (server): import { withRewriteLedger } from './delivery-rewrite-ledger.server';
 * const { value, ledger } = await withRewriteLedger({ requestId, stage: 'diagnose' },
 *   () => traceProjection('final', candidate, x => existingProjection(x)));
 * CDSS_DELIVERY_REWRITE_LEDGER=off|memory|archive, default off. Archive means collect
 * only: the caller must explicitly save the returned sidecar in controlled storage.
 * No helper writes files, logs text, applies edits, signs or changes safety decisions.
 */
import type { GateContext, IntegrityVerdict, RewriteEvent, RuleSpec, TextSlot } from "./delivery-gate-types";

export const DELIVERY_REWRITE_RULES = Object.freeze({
  surface: { ruleId: "surface.projection", ruleVersion: "r1064", expected: { kind: "unclassified", reason: "Existing delivery projection; inspect intermediate leaf events" } },
  negative: { ruleId: "m03.negative_missing", ruleVersion: "r1064", expected: { kind: "unclassified", reason: "Record-dependent negative assertion rewrite" } },
  denied: { ruleId: "m03.denied_recorded", ruleVersion: "r1064", expected: { kind: "unclassified", reason: "Remove denial contradicted by recorded finding" } },
  formula: { ruleId: "formula.review", ruleVersion: "r1064", expected: { kind: "unclassified", reason: "Existing formula commentary review; final herb table is a lock" } },
  provenance: { ruleId: "provenance.identity", ruleVersion: "r1064", expected: { kind: "unclassified", reason: "Governed formula identity and source projection" } },
  processing: { ruleId: "herb.processing", ruleVersion: "r1064", expected: { kind: "unclassified", reason: "Processing from governed table; final herb table is a lock" } },
} satisfies Record<string, RuleSpec>);

export const pointerPart = (value: string) => value.replace(/~/gu, "~0").replace(/\//gu, "~1");
/** Schema locks are structural, not clinical language or a new safety policy. */
export function deliveryPathProtected(path: string): boolean {
  const keys = path.split("/").map(k => k.replace(/~1/gu, "/").replace(/~0/gu, "~"));
  const lockedKeys = new Set(["herbs", "patentAndWestern", "safetyGate", "redFlags", "clinicalReview", "patientFact", "syndromeEvidence", "primarySyndromeBasis", "quote", "sourceQuote", "citation", "excerpt", "dose", "dosePerDay", "doseOrHandling", "coding", "code", "reasonCode", "contractSignature"]);
  return keys.some(k => lockedKeys.has(k));
}
/** UTF-16 fingerprint for stale-offset detection only, never a signing hash. */
export function rewriteTextHash(text: string): string {
  let a = 2166136261; let b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return `${text.length}:${a >>> 0}:${b >>> 0}`;
}
export function deliveryTextLeaves(value: unknown, path: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown, p: string) => {
    if (typeof v === "string") out.set(p, v);
    else if (v && typeof v === "object") for (const [k, child] of Object.entries(v)) walk(child, `${p}/${pointerPart(k)}`);
  };
  walk(value, path); return out;
}
type Pair = { before?: string; after?: string; oldPath: string; path: string };
/** Exact subtrees first, then explicit ids, then positional fallback. Duplicates consume separate slots. */
function pairLeaves(before: unknown, after: unknown, oldPath: string, path: string, out: Pair[]): void {
  if (typeof before === "string" || typeof after === "string") {
    if ((before == null || typeof before === "string") && (after == null || typeof after === "string")) {
      out.push({ before: before as string | undefined, after: after as string | undefined, oldPath, path }); return;
    }
    if (typeof before === "string") out.push({ before, oldPath, path });
    if (typeof after === "string") out.push({ after, oldPath, path });
    if (before && typeof before === "object") pairLeaves(before, undefined, oldPath, path, out);
    if (after && typeof after === "object") pairLeaves(undefined, after, oldPath, path, out);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const used = new Set<number>(); const matches = new Map<number, number>();
    for (let j = 0; j < after.length; j++) {
      const i = before.findIndex((v, k) => !used.has(k) && JSON.stringify(v) === JSON.stringify(after[j]));
      if (i >= 0) { used.add(i); matches.set(j, i); }
    }
    for (let j = 0; j < after.length; j++) if (!matches.has(j)) {
      const item = after[j];
      let i = item && typeof item === "object" && "id" in item
        ? before.findIndex((v, k) => !used.has(k) && v && typeof v === "object" && v.id === item.id) : -1;
      const explicitId = item && typeof item === "object" && "id" in item;
      if (!explicitId && i < 0 && j < before.length && !used.has(j)) i = j;
      if (!explicitId && i < 0) i = before.findIndex((_, k) => !used.has(k));
      if (i >= 0) { used.add(i); matches.set(j, i); }
    }
    for (let j = 0; j < after.length; j++) {
      const i = matches.get(j); pairLeaves(i === undefined ? undefined : before[i], after[j], `${oldPath}/${i ?? j}`, `${path}/${j}`, out);
    }
    before.forEach((v, i) => { if (!used.has(i)) pairLeaves(v, undefined, `${oldPath}/${i}`, `${path}/${i}`, out); });
    return;
  }
  const oldObject = before && typeof before === "object" ? before as Record<string, unknown> : {};
  const newObject = after && typeof after === "object" ? after as Record<string, unknown> : {};
  if (Object.keys(oldObject).length || Object.keys(newObject).length) {
    for (const k of new Set([...Object.keys(oldObject), ...Object.keys(newObject)])) pairLeaves(oldObject[k], newObject[k], `${oldPath}/${pointerPart(k)}`, `${path}/${pointerPart(k)}`, out);
  } else if (typeof before === "string" || typeof after === "string") {
    out.push({ before: typeof before === "string" ? before : undefined, after: typeof after === "string" ? after : undefined, oldPath, path });
  }
}

export function createRewriteLedger(context: GateContext) {
  const events: RewriteEvent[] = [];
  let serial = 0; let occurrence = 0;
  let paths = new Map<string, string>();
  const revisions = new Map<string, number>();
  const locked = (path: string) => deliveryPathProtected(path) || (context.protectedPaths?.some(p => path === p || path.startsWith(`${p}/`)) ?? false);
  const add = (rule: RuleSpec, slot: TextSlot, before: string, after: string, attribution: RewriteEvent["attribution"], phase: string, observationOnly = false) => {
    if (before === after) return undefined;
    const occurrenceId = slot.occurrenceId || paths.get(slot.path) || `${context.requestId}:o${++occurrence}`;
    if (!observationOnly) paths.set(slot.path, occurrenceId);
    const revision = (revisions.get(occurrenceId) || 0) + 1; revisions.set(occurrenceId, revision);
    const event: RewriteEvent = { eventId: `${context.requestId}:e${++serial}`, requestId: context.requestId, stage: context.stage,
      phase, ruleId: rule.ruleId, ruleVersion: rule.ruleVersion, path: slot.path, occurrenceId, revision, before, after,
      expected: { ...rule.expected }, attribution, protected: Boolean(rule.protected || slot.protected || locked(slot.path)), ...(observationOnly ? { observationOnly: true } : {}) };
    events.push(event); return event;
  };
  return {
    context, events,
    text(rule: RuleSpec, slot: TextSlot, before: string, after: string) { return add(rule, slot, before, after, "leaf", context.phase || "leaf"); },
    observe(rule: RuleSpec, before: string, after: string) { return add(rule, { path: `/${context.stage}/$unresolved` }, before, after, "leaf", context.phase || "leaf", true); },
    snapshot(phase: string, before: unknown, after: unknown, rule?: RuleSpec, fromEvent = events.length) {
      const pairs: Pair[] = []; pairLeaves(before, after, `/${context.stage}`, `/${context.stage}`, pairs);
      const previousPaths = new Map(paths);
      const nextPaths = new Map<string, string>();
      const priorEvents = events.slice(fromEvent);
      for (const pair of pairs) {
        const occurrenceId = (pair.before !== undefined ? previousPaths.get(pair.oldPath) : undefined) || `${context.requestId}:o${++occurrence}`;
        if (pair.after !== undefined) nextPaths.set(pair.path, occurrenceId);
        if (pair.oldPath !== pair.path) for (const prior of events) if (!prior.observationOnly && prior.occurrenceId === occurrenceId && !prior.tombstone) {
          prior.previousPath ??= prior.path; prior.path = pair.path;
        }
        if (pair.before === pair.after) continue;
        const beforeText = pair.before ?? ""; const afterText = pair.after ?? "";
        const candidates = pairs.filter(p => p.before === pair.before && p.after === pair.after);
        if (candidates.length === 1) {
          let observed = beforeText;
          const observedChain: RewriteEvent[] = [];
          for (const leaf of priorEvents) if (leaf.observationOnly && leaf.before === observed) {
            observed = leaf.after; observedChain.push(leaf);
            if (observed === afterText) break;
          }
          if (observedChain.length && observed === afterText) {
            for (const leaf of observedChain) {
              leaf.path = pair.path; leaf.occurrenceId = occurrenceId; delete leaf.observationOnly;
              leaf.revision = (revisions.get(occurrenceId) || 0) + 1; revisions.set(occurrenceId, leaf.revision);
              leaf.protected ||= locked(pair.path);
              if (pair.oldPath !== pair.path) leaf.previousPath = pair.oldPath;
              if (pair.after === undefined || pair.after === "") leaf.tombstone = true;
            }
            continue;
          }
        }
        // A real leaf chain covers this whole field, including repeated rewrites.
        let current = beforeText;
        const chain: RewriteEvent[] = [];
        for (const event of priorEvents) if (!event.observationOnly && event.path === pair.path && event.before === current) { current = event.after; chain.push(event); }
        if (chain.length && current === afterText) continue;
        const event = add(rule || { ruleId: "unattributed", ruleVersion: "r1064", expected: { kind: "unclassified", reason: "No leaf or frozen family covers final difference" } },
          { path: pair.path, occurrenceId }, beforeText, afterText, rule ? "family" : "unattributed", phase);
        if (!event) continue;
        if (pair.oldPath !== pair.path) event.previousPath = pair.oldPath;
        if (pair.after === undefined || pair.after === "") event.tombstone = true;
        // Do not guess which duplicate field a free text callback belonged to.
        if (candidates.length === 1) for (const leaf of priorEvents) if (leaf.observationOnly && beforeText.includes(leaf.before) && afterText.includes(leaf.after)) leaf.parentEventId = event.eventId;
      }
      paths = nextPaths;
    },
  };
}
export type RewriteLedger = ReturnType<typeof createRewriteLedger>;
// A resolver is installed once by the server adapter. Only AsyncLocalStorage owns request data.
let currentLedger: () => RewriteLedger | undefined = () => undefined;
export function installRewriteLedgerResolver(resolver: () => RewriteLedger | undefined): void { currentLedger = resolver; }
export function trackedText(rule: RuleSpec, slot: TextSlot, fn: (s: string) => string, input: string): string {
  const after = fn(input); currentLedger()?.text(rule, slot, input, after); return after;
}
export function observeTextRewrite<T>(rule: RuleSpec, before: string, work: () => T, text: (result: T) => string = v => String(v)): T {
  const result = work(); const ledger = currentLedger();
  if (ledger) ledger.observe(rule, before, text(result));
  return result;
}
export function traceProjection<T>(phase: string, input: T, work: (value: T) => T, rule?: RuleSpec): T {
  const ledger = currentLedger();
  if (!ledger) return work(input);
  const before = structuredClone(input); const start = ledger.events.length;
  const result = work(input); ledger.snapshot(phase, before, result, rule, start); return result;
}

/** Aggregate only; damage means association with a bad terminal sentence, not causation. */
export function rewriteRuleStatistics(sidecars: readonly { caseId: string; events: readonly RewriteEvent[]; sentences: readonly { sentenceId: string; events: readonly RewriteEvent[] }[]; verdicts: readonly IntegrityVerdict[] }[] | undefined) {
  if (!sidecars) return { mode: "legacy-final-only" as const, ruleCounts: null, historicalRewriteHits: null, historicalDamageRate: null };
  const rows = new Map<string, { hits: Set<string>; observations: Set<string>; cases: Set<string>; sentences: Set<string>; judged: Set<string>; bad: Set<string>; unknown: Set<string>; protected: Set<string>; unattributed: Set<string> }>();
  const row = (id: string) => { if (!rows.has(id)) rows.set(id, { hits: new Set(), observations: new Set(), cases: new Set(), sentences: new Set(), judged: new Set(), bad: new Set(), unknown: new Set(), protected: new Set(), unattributed: new Set() }); return rows.get(id)!; };
  for (const sidecar of sidecars) {
    for (const event of sidecar.events) if (event.before !== event.after) {
      const r = row(event.ruleId); const key = `${sidecar.caseId}:${event.eventId}`;
      if (event.observationOnly) { r.observations.add(key); r.cases.add(sidecar.caseId); continue; }
      r.hits.add(key); r.cases.add(sidecar.caseId); if (event.protected) r.protected.add(key); if (event.attribution === "unattributed") r.unattributed.add(key);
    }
    for (const sentence of sidecar.sentences) for (const id of new Set(sentence.events.filter(e => !e.observationOnly).map(e => e.ruleId))) {
      const r = row(id); const key = `${sidecar.caseId}:${sentence.sentenceId}`; r.sentences.add(key);
      const verdict = sidecar.verdicts.find(v => v.sentenceId === sentence.sentenceId);
      if (!verdict || verdict.status === "unknown") { if (!r.judged.has(key)) r.unknown.add(key); }
      else { r.unknown.delete(key); r.judged.add(key); if (verdict.status !== "pass") r.bad.add(key); }
    }
  }
  return { mode: "observed-sidecars" as const, ruleCounts: Object.fromEntries([...rows].map(([id, r]) => [id, {
    hits: r.observations.size ? null : r.hits.size, boundHits: r.hits.size, unboundObservations: r.observations.size,
    cases: r.cases.size, changedSentences: r.sentences.size, adjudicatedSentences: r.judged.size,
    associatedBadSentences: r.bad.size, unknownSentences: r.unknown.size, protectedChanges: r.protected.size,
    unattributedChanges: r.unattributed.size, damageRate: r.judged.size ? r.bad.size / r.judged.size : null,
    coverageRate: r.sentences.size ? r.judged.size / r.sentences.size : null,
  }])) };
}
