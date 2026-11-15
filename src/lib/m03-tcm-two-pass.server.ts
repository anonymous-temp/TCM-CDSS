import "server-only";
import { buildM03TcmConclusionPrompt, freezeM03TcmConclusion, M03_TCM_CONCLUSION_PROVIDER_SCHEMA,
  type FrozenM03TcmConclusion, type M03TcmContext } from "./m03-tcm-conclusion";
import { checkM03TcmConclusion, m03TcmCheckPolicy, withinM03TcmBudget, type M03TcmConclusionCheckIO } from "./m03-tcm-conclusion-checks.server";
import { authorM03TcmNarrative, type M03TcmModelIO } from "./m03-tcm-narrative.server";
import { m03TcmNarrativeSentences, pruneInvalidM03TcmSentences, usableM03TcmNarrative, type NarrativeViolation, type M03TcmNarrative } from "./m03-tcm-narrative";
import { validateM03TcmNarrative, type M03TcmTextCheckIO } from "./m03-tcm-text-validation.server";
import { projectM03TcmHalf, assertM03TcmProjection, type M03TcmHalf } from "./m03-tcm-projection";
import { projectDeliveredM03TcmDisplay, projectDeliveredReasoning } from "./delivered-surface";
import { createM03TcmConclusionModelChecks, type M03TcmCheckTransport } from "./m03-tcm-check-adapters.server";

export type M03TcmTwoPassIO = M03TcmModelIO & M03TcmConclusionCheckIO & M03TcmTextCheckIO & Partial<M03TcmCheckTransport>;
export type M03TcmTwoPassOptions = { enabled?: boolean; rewrite?: boolean; signal?: AbortSignal; absoluteDeadline?: number };
export type M03TcmTwoPassResult =
  | { kind: "disabled" }
  | { kind: "unusable" | "upstream_unavailable"; reasons: string[]; reusable: false }
  | { kind: "ready" | "bounded"; tcmRaw: string; half: M03TcmHalf; frozen: FrozenM03TcmConclusion;
      narrative: M03TcmNarrative; quality: { rewrites: number; prunedSentenceIds: string[]; reasons: string[] }; reusable: boolean };
/** Only these non-secret switches are read. P5 must include their effective identity in its cache key. */
export function m03TcmTwoPassPolicy(env: Record<string, string | undefined> = process.env) {
  return { enabled: env.CDSS_M03_TCM_TWO_PASS === "true" && env.M03_PARALLEL_GENERATION?.trim().toLowerCase() !== "false",
    prefetch: env.CDSS_M03_TCM_CHECK_PREFETCH !== "false", rewrite: env.CDSS_M03_TCM_NARRATIVE_REWRITE !== "false",
    checks: m03TcmCheckPolicy(env), version: "m03-tcm-two-pass-v1" };
}

/**
 * P5 integration boundary (main switch defaults off):
 * - ctx is one sanitized fact/catalog snapshot. Fact polarity/scope/normality and ID mappings
 *   are server inputs, not fields to accept from either generation response.
 * - complete owns provider validation, same-task strict fallback and usage telemetry. When
 *   completeCheck is supplied, its propose/verify phases use different configured families.
 *   Existing decision-only check callbacks can be injected instead, with revision/hash binding.
 * - S1a/S1b and the narrow frozen-conclusion relation checker bind their replies to the entire
 *   supplied input, including projected on final checks. Missing checkers fail closed.
 * - ready/bounded contribute only TCM-owned fields at the existing parallel merge. Refill
 *   server-only deferredFormulaSelection after merge's anti-forgery stripping, retain the
 *   Western half and management, and rerun the final full-payload checks/footprint after any
 *   later normalization before rendering, clinicalReview rebinding and the existing signature.
 * - unusable uses the existing limited contract; upstream_unavailable uses the existing
 *   upstream failure path. Never rescue either with an old full-TCM draft or generic repair.
 * - reusable=false must forget touched model memo keys. Include effective switches,
 *   schema/prompt/check versions and governed-data identity in the parent stage cache key.
 * This module emits no stream frames and never signs or triggers M04 prefetch.
 */
export async function runM03TcmTwoPass(ctx: M03TcmContext, io: M03TcmTwoPassIO, options: M03TcmTwoPassOptions = {}): Promise<M03TcmTwoPassResult> {
  const policy = m03TcmTwoPassPolicy();
  if (!(options.enabled ?? policy.enabled)) return { kind: "disabled" };
  ctx = structuredClone(ctx);
  const signal = options.signal || new AbortController().signal;
  const deadline = options.absoluteDeadline ?? Date.now() + 180_000;
  const modelChecks = io.completeCheck ? createM03TcmConclusionModelChecks({ completeCheck: io.completeCheck }, io.caseSafety) : undefined;
  const checkIO = { ...modelChecks, ...io };
  const redrawViolations: string[] = [];
  let frozen: FrozenM03TcmConclusion | undefined;
  let conclusionReasons: string[] = [];
  for (let revision = 1; revision <= 2; revision++) {
    let value: unknown;
    try {
      const result = await withinM03TcmBudget((child) => io.complete({ task: "m03_tcm_conclusion", prompt: buildM03TcmConclusionPrompt(ctx, redrawViolations),
        schema: M03_TCM_CONCLUSION_PROVIDER_SCHEMA, maxTokens: 1000, signal: child, absoluteDeadline: deadline }), signal, deadline);
      if (result.finishReason !== "stop") return { kind: "upstream_unavailable", reasons: ["incomplete_conclusion"], reusable: false };
      value = typeof result.value === "string" ? JSON.parse(result.value) : result.value;
    } catch { signal.throwIfAborted(); return { kind: "upstream_unavailable", reasons: ["conclusion_transport_unavailable"], reusable: false }; }
    const checked = await checkM03TcmConclusion(value, ctx, checkIO, signal, deadline, revision, policy.checks);
    if (checked.kind === "redraw") {
      redrawViolations.push(...checked.violations);
      if (revision === 2) return { kind: "unusable", reasons: [...new Set(redrawViolations)], reusable: false };
      continue;
    }
    if (checked.kind === "unusable") {
      if (revision === 1 && checked.reasons.includes("invalid_proposal")) { redrawViolations.push(...checked.reasons); continue; }
      return { kind: "unusable", reasons: checked.reasons, reusable: false };
    }
    // Accumulated confirmed contradictions may not be forgotten by the redraw.
    const rejectedNames = redrawViolations.map((item) => item.split(":")[1]).filter(Boolean);
    if (rejectedNames.includes(checked.record.disease.name)) return { kind: "unusable", reasons: ["redraw_ignored_constraint"], reusable: false };
    try { frozen = freezeM03TcmConclusion(checked.record, ctx); }
    catch { return { kind: "unusable", reasons: ["conclusion_not_closed"], reusable: false }; }
    conclusionReasons = checked.reasons;
    break;
  }
  if (!frozen) return { kind: "unusable", reasons: ["conclusion_missing"], reusable: false };
  let draft = await authorM03TcmNarrative(frozen, ctx, io, signal, deadline);
  if (!draft) return { kind: "upstream_unavailable", reasons: ["narrative_unavailable"], reusable: false };
  let checked = await validateM03TcmNarrative(draft, frozen, ctx, io, signal, deadline);
  let rewrites = 0;
  if (checked.status !== "pass" && (options.rewrite ?? policy.rewrite)) {
    rewrites = 1;
    const rewritten = await authorM03TcmNarrative(frozen, ctx, io, signal, deadline, checked.violations);
    // Invalid rewrite: prune all known offending units of the first draft; never return it unchanged.
    if (rewritten) { draft = rewritten; checked = await validateM03TcmNarrative(draft, frozen, ctx, io, signal, deadline); }
  }
  const violations: NarrativeViolation[] = [...checked.violations];
  const prunedIds = new Set<string>();
  const prune = () => {
    const before = m03TcmNarrativeSentences(draft!).map((slot) => slot.sentence.id);
    draft = pruneInvalidM03TcmSentences(draft!, violations);
    const kept = new Set(m03TcmNarrativeSentences(draft).map((slot) => slot.sentence.id));
    before.filter((id) => !kept.has(id)).forEach((id) => prunedIds.add(id));
  };
  if (violations.length) prune();
  const project = () => {
    const assembled = projectM03TcmHalf(frozen!, draft!, ctx);
    // C2 的治则投影按安全快照判断红旗；重复投影也必须携带同一已定状态。
    const displayOptions = { recordText: ctx.facts.map((field) => field.text).join("\n"),
      safetyGate: { status: ctx.safety.redFlag ? "red_flag" as const : "ready" as const } };
    const delivered = projectDeliveredM03TcmDisplay(assembled, displayOptions);
    assertM03TcmProjection(frozen!, delivered, ctx);
    // Client/HIS consumers repeat projection with the same safety snapshot; conclusions stay frozen.
    assertM03TcmProjection(frozen!, projectDeliveredReasoning(delivered, { safetyGate: displayOptions.safetyGate }), ctx);
    assertM03TcmProjection(frozen!, projectDeliveredReasoning(delivered, displayOptions), ctx);
    return delivered;
  };
  for (let finalCheck = 0; finalCheck < 2; finalCheck++) {
    if (!usableM03TcmNarrative(draft)) return { kind: "unusable", reasons: ["narrative_core_pruned"], reusable: false };
    let half: M03TcmHalf;
    try { half = project(); }
    catch { return { kind: "unusable", reasons: ["conclusion_projection_drift"], reusable: false }; }
    const final = await validateM03TcmNarrative(draft, frozen, ctx, io, signal, deadline, half);
    if (final.status === "pass") {
      const bounded = prunedIds.size > 0 || frozen.primary.resolution !== "resolved" || half.overview.tcmDiseaseDifferentials!.length < 2;
      return { kind: bounded ? "bounded" : "ready", tcmRaw: JSON.stringify(half), half, frozen, narrative: draft,
        quality: { rewrites, prunedSentenceIds: [...prunedIds], reasons: [...conclusionReasons, ...violations.map((item) => item.code)] },
        reusable: !bounded && checked.status !== "unknown" };
    }
    violations.push(...final.violations); prune();
  }
  return { kind: "unusable", reasons: ["final_text_unverified"], reusable: false };
}
