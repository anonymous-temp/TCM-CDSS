import "server-only";
import { currentRewriteLedger } from "./delivery-rewrite-ledger.server";
import { runDeliveryGates, protectedDeliveryRanges, type DeliveryGateIO } from "./delivery-gates.server";
import { deliveryGatePolicy } from "./delivery-gate-policy";
import { deliveryHash } from "./delivery-trusted-record.server";
import { markStageGenerationNonReusable } from "./stage-generation-outcome.server";
import type { DeliveryCandidate } from "./delivery-patient-facts.server";
import { scrubInternalVocabularyFromVisibleText } from "./diagnosis-visible-summary";
import { normalizeReasoningV2, type CaseState } from "./diagnosis-types";
import { synchronizeVisibleClinicalSummary } from "./diagnosis-visible-summary";
import { sanitizeDiagnoseStreamingDraft } from "./diagnosis-stream-safety";

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const NON_DOSE = /<!-- CDSS_NON_DOSE_CANDIDATE_JSON:([\s\S]*?) -->/u;
export function splitDeliveryContent(content: string, stage: "diagnose" | "prescribe") {
  const at = content.indexOf(START), end = content.indexOf(END, at);
  if (at >= 0 && end > at) {
    if (at !== content.lastIndexOf(START) || end !== content.lastIndexOf(END)) throw new Error("delivery_multiple_payloads");
    const structured = JSON.parse(content.slice(at + START.length, end));
    // Signatures/attestations are bound only after the clinical snapshot is complete.
    delete structured.contractSignature; delete structured.contractSignatureVersion; delete structured.clinicalReview;
    return { candidate: { stage, structured, visibleText: content.slice(0, at) + content.slice(end + END.length) } as DeliveryCandidate, kind: "reasoning" as const };
  }
  const nonDose = content.match(NON_DOSE);
  if (nonDose) return { candidate: { stage, structured: JSON.parse(nonDose[1]), visibleText: content.replace(NON_DOSE, "") } as DeliveryCandidate, kind: "non_dose" as const };
  return { candidate: { stage, structured: null, visibleText: content } as DeliveryCandidate, kind: "visible" as const };
}
export function joinDeliveryContent(candidate: DeliveryCandidate, kind: ReturnType<typeof splitDeliveryContent>["kind"]): string {
  if (kind === "visible") return candidate.visibleText || "";
  if (kind === "non_dose") return `${candidate.visibleText || ""}<!-- CDSS_NON_DOSE_CANDIDATE_JSON:${JSON.stringify(candidate.structured).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e").replace(/-/gu, "\\u002d")} -->`;
  return `${candidate.visibleText || ""}${START}\n${JSON.stringify(candidate.structured)}\n${END}`;
}
/** Last projection shared by all exits and the saved-output replay. No model or signature here. */
export function renderFinalDeliveryContent(content: string, stage: "diagnose" | "prescribe", context: string, state?: CaseState): string {
  const at = content.indexOf(START);
  if (at < 0) return content;
  const heading = content.slice(0, at).search(stage === "prescribe" ? /^# 候选方药\s*$/m : /^##\s/m);
  const lead = heading > 0 ? content.slice(0, heading) : "";
  const rendered = synchronizeVisibleClinicalSummary(content, stage, context, state);
  return lead && !rendered.includes(lead.trim()) ? `${lead}${rendered}` : rendered;
}
export function prepareFinalDeliveryContent(content: string): string {
  // The caller has already completed the last delivery projection. Reapplying that
  // projector here is unsafe: some existing processing-name rules are not fixed points.
  const surfaced = content;
  const start = surfaced.lastIndexOf(START), end = surfaced.indexOf(END, start);
  let final = surfaced;
  if (start >= 0 && end > start) {
    const normalized = normalizeReasoningV2(JSON.parse(surfaced.slice(start + START.length, end)));
    if (normalized) final = `${surfaced.slice(0, start + START.length)}\n${JSON.stringify(normalized, null, 2)}\n${surfaced.slice(end)}`;
  }
  return final;
}
export type FinalDeliveryOptions = {
  stage: "diagnose" | "prescribe"; caseState: unknown; priorM03?: unknown; signal: AbortSignal;
  deadline: () => number; policy?: ReturnType<typeof deliveryGatePolicy>;
  prepare: (content: string) => string; render: (content: string) => string;
  accept: (content: string) => boolean; sign: (content: string) => string;
  fallback: () => string; io?: DeliveryGateIO;
};
/** Request-local shared barrier for ordinary delivery, early checkpoint, non-dose and fallback exits. */
export function createFinalDeliveryBarrier(options: FinalDeliveryOptions) {
  const policy = options.policy || deliveryGatePolicy();
  const verified = new Map<string, string>();
  let repairSpent = false;
  let spentMs = 0;
  const cache = {};
  const clean = (value: string) => scrubInternalVocabularyFromVisibleText(options.stage === "diagnose" ? sanitizeDiagnoseStreamingDraft(value) : value);
  const observe = (phase: string, before: string, after: string) => {
    if (policy.mode === "off") return;
    try {
      const left = splitDeliveryContent(before, options.stage).candidate;
      const right = splitDeliveryContent(after, options.stage).candidate;
      const ledger = currentRewriteLedger();
      ledger?.snapshot(phase, left.structured, right.structured);
      ledger?.text({ ruleId: `wire.${phase}.visible`, ruleVersion: "r1064", expected: { kind: "unclassified", reason: "rendered final prose" } },
        { path: "/visible" }, left.visibleText || "", right.visibleText || "");
    } catch { /* No parseable clinical object yet. The final snapshot is still checked. */ }
  };
  const run = async (content: string): Promise<string> => {
    if (policy.mode === "off") return content;
    const first = splitDeliveryContent(content, options.stage);
    const hit = verified.get(deliveryHash(first.candidate));
    if (hit) return hit;
    const prepared = clean(options.prepare(content));
    observe("final_projection", content, prepared);
    const { candidate, kind } = splitDeliveryContent(prepared, options.stage);
    // Mixed safety fields are locked as entire occurrences until their producer supplies narrower provenance.
    const locks = protectedDeliveryRanges(candidate, ["/structured/management/redFlagLoop", "/structured/management/followupSafetyNet",
      "/structured/formula/precautions", "/structured/nonPharma/precautions", ...(kind === "visible" ? ["/visibleText"] : [])]);
    // 三项子检查都只记录（shadow）时，检查改动不了交付内容：在后台跑完只留遥测，不让每个阶段白等约 0.9 秒
    //（第四十七轮新 40 份实测：M03、M04 各 +0.9 秒）。任何一项 enforce 时照旧同步等。
    if (policy.integrity !== "enforce" && policy.facts !== "enforce" && policy.invariants !== "enforce" && kind === "reasoning" && options.accept(joinDeliveryContent(candidate, kind))) {
      void runDeliveryGates({ candidate, caseState: options.caseState, priorM03: options.priorM03,
        events: currentRewriteLedger()?.events, protectedRanges: locks, policy, signal: options.signal,
        absoluteDeadline: Math.min(options.deadline(), Date.now() + policy.timeoutMs), cache, repairAvailable: false }, {
        ...options.io,
        render: next => splitDeliveryContent(clean(options.render(joinDeliveryContent(next, kind))), options.stage).candidate,
        accept: next => options.accept(joinDeliveryContent(next, kind)),
      }).then((checked) => console.info("[tcm-cdss:timing] delivery_gates", { stage: options.stage, background: true, durationMs: checked.durationMs,
        unknown: checked.unknown, findings: checked.findings.length, passed: checked.passed })).catch(() => undefined);
      const signed = clean(options.sign(prepared));
      const hash = deliveryHash(splitDeliveryContent(signed, options.stage).candidate);
      verified.set(hash, signed);
      verified.set(deliveryHash(first.candidate), signed);
      return signed;
    }
    const checked = await runDeliveryGates({ candidate, caseState: options.caseState, priorM03: options.priorM03,
      events: currentRewriteLedger()?.events, protectedRanges: locks, policy, signal: options.signal,
      absoluteDeadline: Math.min(options.deadline(), Date.now() + Math.max(0, policy.timeoutMs - spentMs)),
      cache, repairAvailable: !repairSpent }, {
      ...options.io,
      render: next => splitDeliveryContent(clean(options.render(joinDeliveryContent(next, kind))), options.stage).candidate,
      accept: next => kind !== "reasoning" || options.accept(joinDeliveryContent(next, kind)),
    });
    spentMs += checked.durationMs;
    repairSpent ||= checked.repairs > 0;
    if (!checked.reusable) markStageGenerationNonReusable();
    console.info("[tcm-cdss:timing] delivery_gates", { stage: options.stage, durationMs: checked.durationMs,
      unknown: checked.unknown, findings: checked.findings.length, cuts: checked.cuts, repairs: checked.repairs, accepted: checked.accepted, passed: checked.passed, hash: checked.hash });
    if (!checked.accepted) {
      markStageGenerationNonReusable();
      // This is the existing deterministic incomplete/non-dose contract. No failed model draft is rescued.
      const fallback = clean(options.fallback());
      const fallbackSnapshot = splitDeliveryContent(fallback, options.stage).candidate;
      // Audit the deterministic limited/non-dose exit too. It has no new generation or repair
      // entitlement and is never advertised as a passed/reusable candidate.
      await runDeliveryGates({ candidate: fallbackSnapshot, caseState: options.caseState, priorM03: options.priorM03,
        policy: { ...policy, mode: "shadow", facts: policy.facts === "off" ? "off" : "shadow",
          integrity: policy.integrity === "off" ? "off" : "shadow", invariants: policy.invariants === "off" ? "off" : "shadow" },
        signal: options.signal, absoluteDeadline: Math.min(options.deadline(), Date.now() + Math.max(0, policy.timeoutMs - spentMs)),
        repairAvailable: false, protectedRanges: protectedDeliveryRanges(fallbackSnapshot, ["/visibleText"]) }, options.io);
      verified.set(deliveryHash(splitDeliveryContent(fallback, options.stage).candidate), fallback);
      return fallback;
    }
    const next = checked.changed ? joinDeliveryContent(checked.candidate, kind) : prepared;
    const signed = kind === "reasoning" ? options.sign(next) : next;
    const final = clean(signed);
    const finalSnapshot = splitDeliveryContent(final, options.stage).candidate;
    if (deliveryHash(finalSnapshot) !== checked.hash) throw new Error("delivery_changed_after_gate");
    verified.set(checked.hash, final);
    verified.set(deliveryHash(first.candidate), final);
    return final;
  };
  return { run, observe };
}
