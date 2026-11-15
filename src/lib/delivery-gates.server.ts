import "server-only";
import { deliveryGatePolicy } from "./delivery-gate-policy";
import { changedSentenceUnits } from "./delivery-rewrite-sentences";
import { buildRewriteIntegrityColumn, checkRewriteIntegrity, type SharedIntegrityBatch } from "./delivery-rewrite-integrity.server";
import { checkFinalPatientFacts, type DeliveryCandidate, type FactReviewer, type VerifiedFactCache } from "./delivery-patient-facts.server";
import { buildTrustedRecordIndex, deliveryHash } from "./delivery-trusted-record.server";
import { independentModelJsonTask, independentModelPair } from "./cross-model-small-task.server";
import { scanDeliveryInvariants, type InvariantFinding } from "./delivery-invariants";
import { buildDeliveryInvariantGovernance } from "./delivery-invariant-governance";
import { findingsToDeliveryRepairRequests, deliveryRepairStayedInScope, type DeliveryRepairRequest } from "./delivery-gate-repair";
import { applyDeliveryTextCuts, collectDeliveryText, pointerValue, pointerParts, sentenceRange, stableDeliveryJson, type DeliveryTextCut } from "./delivery-text";
import type { RewriteEvent } from "./delivery-gate-types";

type Policy = ReturnType<typeof deliveryGatePolicy>;
export type ProtectedDeliveryRange = { path: string; start: number; end: number };
export type DeliveryGateIO = {
  review?: FactReviewer;
  repair?: (snapshot: { m03?: unknown; m04?: unknown }, requests: DeliveryRepairRequest[], signal: AbortSignal, deadline: number) => Promise<unknown>;
  /** Pure renderer; MUST NOT run conclusion selection or fill missing clinical text. */
  render?: (candidate: DeliveryCandidate) => DeliveryCandidate;
  accept?: (candidate: DeliveryCandidate) => boolean;
};
export type DeliveryGateInput = {
  candidate: DeliveryCandidate; caseState: unknown; priorM03?: unknown; events?: readonly RewriteEvent[];
  protectedRanges?: readonly ProtectedDeliveryRange[]; policy?: Policy; signal: AbortSignal; absoluteDeadline: number;
  cache?: VerifiedFactCache; repairAvailable?: boolean;
};
export type DeliveryGateResult = {
  candidate: DeliveryCandidate; hash: string; changed: boolean; accepted: boolean; reusable: boolean; passed: boolean;
  findings: InvariantFinding[]; unknown: number; cuts: number; repairs: number; durationMs: number;
};
const setAt = (root: unknown, path: string, value: unknown) => {
  const parts = pointerParts(path); const key = parts.pop()!;
  const parent = parts.reduce<unknown>((node, part) => node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined, root);
  if (parent && typeof parent === "object") (parent as Record<string, unknown>)[key] = value;
};
/** Intersection with caller-owned provenance, including mixed safety/narrative fields. */
export function deliveryCutAllowed(cut: DeliveryTextCut, protectedRanges: readonly ProtectedDeliveryRange[]): boolean {
  return !protectedRanges.some(range => range.path === cut.path && cut.start < range.end && range.start < cut.end);
}

export async function boundedDeliveryTask<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, deadline: number): Promise<T | undefined> {
  if (signal.aborted || Date.now() >= deadline) return undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    const stopped = new Promise<undefined>(resolve => { abort = () => { controller.abort(); resolve(undefined); };
      signal.addEventListener("abort", abort, { once: true }); timer = setTimeout(abort, Math.max(1, deadline - Date.now())); });
    return await Promise.race([work(controller.signal).catch(() => undefined), stopped]);
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort(); }
}

/** One immutable final snapshot; integrity rides the first facts batch, never a third serial call. */
export async function runDeliveryGates(input: DeliveryGateInput, io: DeliveryGateIO = {}): Promise<DeliveryGateResult> {
  const started = Date.now();
  const policy = input.policy || deliveryGatePolicy();
  const original = structuredClone(input.candidate);
  const result = (candidate: DeliveryCandidate, extra: Partial<DeliveryGateResult> = {}): DeliveryGateResult => ({
    candidate, hash: deliveryHash(candidate), changed: deliveryHash(candidate) !== deliveryHash(original), accepted: true, reusable: true,
    passed: true, findings: [], unknown: 0, cuts: 0, repairs: 0, durationMs: Date.now() - started, ...extra,
  });
  if (policy.mode === "off") return result(original);
  const deadline = Math.min(input.absoluteDeadline, started + policy.timeoutMs);
  const record = buildTrustedRecordIndex(input.caseState);
  const units = changedSentenceUnits(input.events || [], { payload: original.structured, visible: original.visibleText });
  const locks = input.protectedRanges || [];
  for (const unit of units) {
    const path = unit.path === "/visible" ? "/visibleText" : unit.path.replace(`/${original.stage}`, "/structured");
    if (locks.some(range => range.path === path && unit.start < range.end && range.start < unit.end)) unit.protected = true;
  }
  let resolveIntegrity: (value: Awaited<SharedIntegrityBatch>) => void = () => {};
  const sharedBatch: SharedIntegrityBatch = new Promise(resolve => { resolveIntegrity = resolve; });
  let firstBatch = true;
  const reviewer: FactReviewer = async request => {
    const include = firstBatch && policy.integrity !== "off"; firstBatch = false;
    const column = include ? buildRewriteIntegrityColumn(units) : undefined;
    const messages = column ? [...request.messages, { role: "system" as const, content: column.instruction },
      { role: "user" as const, content: JSON.stringify({ integrity: column.integrity }) }] : request.messages;
    try {
      const reply = await (io.review || (async req => independentModelJsonTask("delivery_final", req.candidate.stage, req.messages,
        { maxTokens: 5000, timeoutMs: req.timeoutMs }, value => value, req.signal)))({ ...request, messages });
      if (include) resolveIntegrity(reply ? { content: reply.results[1], independent: independentModelPair(reply.identities) } : undefined);
      return reply;
    } catch { if (include) resolveIntegrity(undefined); return undefined; }
  };
  const pair = () => original.stage === "diagnose" ? { m03: original.structured } : { m03: input.priorM03, m04: original.structured };
  const scan = (snapshot: ReturnType<typeof pair>) => {
    if (policy.invariants === "off") return [];
    const scanInput = { ...snapshot, recordIndex: record };
    return scanDeliveryInvariants({ ...scanInput, governedContext: buildDeliveryInvariantGovernance({ ...scanInput, ageYears: record.ageYears }) });
  };
  const findings = scan(pair());
  const timeoutMs = Math.max(1, deadline - Date.now());
  // Facts may be disabled independently: an integrity-only request still uses the same proven pair.
  const needsModel = policy.facts !== "off" || policy.integrity !== "off" && units.some(unit => !unit.protected);
  const factPromise = needsModel && !input.signal.aborted && Date.now() < deadline ? checkFinalPatientFacts(original, record, policy.incremental ? input.cache : {}, input.signal,
    { reviewer, timeoutMs }).finally(() => resolveIntegrity(undefined)) : Promise.resolve(undefined);
  const repairPlan = findingsToDeliveryRepairRequests(findings, pair(), policy.invariants);
  let repaired = pair(); let repairs = 0;
  // Existing ownership authority is deterministic; no new model judgement or retry entitlement.
  for (const request of repairPlan.requests.filter(request => request.operation === "restore_ownership")) {
    const next = structuredClone(repaired);
    for (const expected of request.expected) setAt(next, expected.path, expected.value);
    if (deliveryRepairStayedInScope(repaired, next, { ...request, snapshot: stableDeliveryJson(repaired) })) repaired = next;
  }
  const writable = repairPlan.requests.filter(request => request.operation !== "restore_ownership" && request.operation !== "delete_sentence");
  if (writable.length && input.repairAvailable && io.repair && !input.signal.aborted && Date.now() < deadline) {
    repairs = 1;
    try {
      const snapshot = structuredClone(repaired);
      const next = await boundedDeliveryTask(child => io.repair!(structuredClone(snapshot), writable, child, deadline), input.signal, deadline);
      // Validate each operation against only its own writes; all other bytes remain locked.
      // This preserves append-only differential semantics even with mixed repair owners.
      const combined = { ...writable[0], operation: "rewrite_fields" as const,
        snapshot: stableDeliveryJson(snapshot), allowedPaths: [...new Set(writable.flatMap(request => request.allowedPaths))],
        lockedPaths: writable.flatMap(request => request.lockedPaths).filter(path => !writable.some(request => request.allowedPaths.some(allowed => allowed.startsWith(path + "/")))) };
      const perOperation = writable.every(request => {
        const isolated = structuredClone(snapshot);
        for (const path of request.allowedPaths) setAt(isolated, path, pointerValue(next, path));
        return deliveryRepairStayedInScope(snapshot, isolated, { ...request, snapshot: stableDeliveryJson(snapshot) });
      });
      if (next && perOperation && deliveryRepairStayedInScope(snapshot, next, combined)) repaired = next as typeof repaired;
    } catch { /* shared budget exhausted: retain findings, delete only addressable prose below */ }
  }
  const [facts, integrity] = await Promise.all([factPromise,
    checkRewriteIntegrity(units, { requestId: "final", stage: original.stage, mode: policy.integrity, sharedBatch, timeoutMs }, input.signal)]);
  if (facts && input.cache && policy.incremental) Object.assign(input.cache, facts.cache);
  const cuts: DeliveryTextCut[] = policy.facts === "enforce" ? [...(facts?.cuts || [])] : [];
  if (policy.integrity === "enforce") for (const edit of integrity.edits) {
    const path = edit.path === "/visible" ? "/visibleText" : edit.path.replace(`/${original.stage}`, "/structured");
    const text = pointerValue(original, path);
    if (typeof text === "string" && edit.action === "delete") cuts.push({ path, occurrenceId: path, before: text,
      start: edit.start, end: edit.end, quote: edit.expectedText, reason: "integrity" });
  }
  const remaining = scan(repaired);
  if (policy.invariants === "enforce") for (const finding of remaining) {
    if (finding.mode !== "enforce" || finding.status !== "violation" || finding.ruleId === "R11") continue;
    const root = original.stage === "diagnose" ? "/m03" : "/m04";
    if (!finding.path.startsWith(root + "/")) continue;
    const path = finding.path.replace(root, "/structured");
    const text = pointerValue(original, path);
    // Only a known offending span is deletable. Structural omissions stay unresolved.
    const quote = typeof finding.actual === "string" ? finding.actual : "";
    if (typeof text !== "string" || !quote || !text.includes(quote)) continue;
    if (!["formula", "integrity"].includes(finding.repairOwner)) continue;
    const [start, end] = sentenceRange(text, text.indexOf(quote), text.indexOf(quote) + quote.length);
    cuts.push({ path, occurrenceId: path, before: text, start, end, quote: text.slice(start, end), reason: finding.ruleId });
  }
  let candidate = { ...original, structured: original.stage === "diagnose" ? repaired.m03 : repaired.m04 };
  const permitted = cuts.filter(cut => deliveryCutAllowed(cut, locks));
  const applied = applyDeliveryTextCuts(candidate, permitted);
  candidate = applied.value;
  const changed = deliveryHash(candidate) !== deliveryHash(original);
  const beforeRender = candidate;
  if (changed && io.render) candidate = io.render(candidate);
  // A renderer may derive visible text, but never repopulate deleted structured text.
  const rendererChangedPayload = deliveryHash(beforeRender.structured) !== deliveryHash(candidate.structured);
  const unknown = (policy.facts !== "off" ? facts?.coverage.filter(row => row.status === "unknown").length ?? 1 : 0)
    + (policy.integrity !== "off" ? integrity.verdicts.filter(row => row.status === "unknown" && !units.find(unit => unit.sentenceId === row.sentenceId)?.protected).length : 0);
  const requiredUnknown = policy.facts === "enforce" && (!facts || facts.status === "unknown") || policy.integrity === "enforce" && integrity.verdicts.some(row => row.status === "unknown" && !units.find(unit => unit.sentenceId === row.sentenceId)?.protected);
  const blockedCut = permitted.length !== cuts.length || applied.stale > 0 || policy.integrity === "enforce" && integrity.requiresSafetyRender.length > 0;
  let accepted = !blockedCut && !rendererChangedPayload && (!io.accept || io.accept(candidate));
  const finalFindings = scan(original.stage === "diagnose" ? { m03: candidate.structured } : { m03: input.priorM03, m04: candidate.structured });
  const unresolved = policy.invariants === "enforce" && finalFindings.some(row => row.status === "violation" && row.mode === "enforce" && row.ruleId !== "R11");
  // Invariants are document quality, never a new T1. The caller's existing complete
  // safety/schema acceptance may retain an annotated candidate; findings remain unresolved.
  accepted &&= !unresolved || Boolean(io.accept?.(candidate));
  // Repair/new rendered prose must cross the same barrier with the SAME remaining clock.
  // Simple deletions cannot create new facts and must not resurrect an old sentence.
  if (accepted && changed && (repairs > 0 || candidate.visibleText !== original.visibleText)) {
    const rechecked = await runDeliveryGates({ ...input, candidate, events: [], repairAvailable: false,
      absoluteDeadline: deadline, policy: { ...policy, timeoutMs: Math.max(1, deadline - Date.now()) } }, { ...io, repair: undefined, render: undefined });
    accepted = rechecked.accepted && rechecked.passed && !rechecked.changed;
  }
  return result(candidate, { accepted, passed: accepted && !requiredUnknown && unknown === 0 && !unresolved, reusable: accepted && !changed && unknown === 0 && !unresolved,
    findings: finalFindings, unknown, cuts: applied.applied, repairs, durationMs: Date.now() - started });
}

/** Schema roles plus explicit server-owned fields form the authoritative no-edit map. */
export function protectedDeliveryRanges(candidate: DeliveryCandidate, extraPaths: readonly string[] = []): ProtectedDeliveryRange[] {
  const protectedText = collectDeliveryText(candidate).filter(unit => unit.role !== "clinical_narrative" || extraPaths.some(path => unit.path === path || unit.path.startsWith(path + "/")));
  const ranges = protectedText.map(unit => ({ path: unit.path, start: 0, end: unit.text.length }));
  const visible = candidate.visibleText || "";
  // Preserve the visible occurrence of every server-owned safety/citation/quote. The
  // remaining rendered narrative is still checked and may be cut as complete sentences.
  for (const unit of protectedText.filter(unit => unit.path !== "/visibleText" && unit.text)) {
    let at = visible.indexOf(unit.text);
    while (at >= 0) { ranges.push({ path: "/visibleText", start: at, end: at + unit.text.length }); at = visible.indexOf(unit.text, at + unit.text.length); }
  }
  const heading = visible.search(/^#{1,3}\s/m);
  if (heading > 0) ranges.push({ path: "/visibleText", start: 0, end: heading });
  for (const match of visible.matchAll(/<!--[\s\S]*?-->/gu)) ranges.push({ path: "/visibleText", start: match.index, end: match.index + match[0].length });
  return ranges;
}
