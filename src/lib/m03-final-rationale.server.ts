import "server-only";
import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { deliveryHash } from "./delivery-trusted-record.server";
import { primaryModelJsonTask } from "./cross-model-small-task.server";
import { buildFinalRationaleContext, finalRationaleMessages, type FinalRationaleContext } from "./m03-final-rationale-context.server";
import { FINAL_RATIONALE_VERSION, finalRationaleMode, type FinalRationaleMode } from "./m03-final-rationale-policy";
import { parseRationaleOutline, type RationaleRejection } from "./m03-final-rationale-outline.server";
import { checkFinalRationaleClaims, type RationaleClaimCheck } from "./m03-final-rationale-claims.server";
import { validateRationalePair, type RationalePair } from "./m03-final-rationale-validation.server";

export const FINAL_RATIONALE_TIMEOUT_MS = 8000;
const FINAL_RATIONALE_MAX_TOKENS = 700;
const SIGNING_RESERVE_MS = 250;
const MIN_START_MS = 1000;
const MIN_REVISION_MS = 4000;

type Messages = ReturnType<typeof finalRationaleMessages>;
type TransportOptions = {
  signal: AbortSignal; timeoutMs: number;
  onNetworkAttempt: () => void;
  onUsage: (usage: { promptTokens: number; completionTokens: number } | undefined) => void;
};
export type RationaleTransport = (messages: Messages, options: TransportOptions) => Promise<unknown>;
type AuthorOptions = {
  state: CaseState; scope: string; signal: AbortSignal; deadline: () => number;
  mode?: FinalRationaleMode; transport?: RationaleTransport; timeoutMs?: number; claimCheck?: RationaleClaimCheck;
  caseRef?: string; requestRef?: string; observe?: (event: RationaleEvent) => void;
};
type RationaleRequest = { key: string; controller: AbortController; reply: Promise<unknown> };
type Delivery = "new" | "old" | "limited" | "cache" | "none";
type SkipReason = "off" | "no_chief" | "cache" | "two_pass" | "unavailable" | "limited" | "cancelled" | "projection";
type RationaleEvent = {
  mode: FinalRationaleMode; version: string; caseRef?: string; requestRef?: string; snapshot?: string;
  bounded?: boolean; lineage?: boolean; secondaries?: number;
  eligible: boolean; launched: boolean; requests: number; physicalCalls: number; validReplies: number;
  verified: boolean; signed: boolean; adopted: boolean; delivery: Delivery; prefetch: "none" | "hit" | "stale" | "cancelled";
  retried: boolean; softAccepted: boolean; softReasons: Pick<RationaleRejection, "code" | "field">[]; reasons: Pick<RationaleRejection, "code" | "field">[]; skip?: SkipReason;
  claimCheck: "skipped" | "checked" | "unavailable"; claimCalls: number; claimRemovals: number;
  promptTokens: number; completionTokens: number; modelMs: number; validationMs: number; waitMs: number;
};

const emptyEvent = (mode: FinalRationaleMode): RationaleEvent => ({
  mode, version: FINAL_RATIONALE_VERSION, eligible: false, launched: false, requests: 0, physicalCalls: 0, validReplies: 0, verified: false, signed: false,
  adopted: false, delivery: "none", prefetch: "none", retried: false, softAccepted: false, softReasons: [], reasons: [], promptTokens: 0, completionTokens: 0,
  claimCheck: "skipped", claimCalls: 0, claimRemovals: 0, modelMs: 0, validationMs: 0, waitMs: 0,
});
const log = (event: RationaleEvent) => console.info("[tcm-cdss:telemetry] m03_final_rationale", event);

export function logSkippedFinalRationale(skip: SkipReason, delivery: Delivery, correlation?: { caseRef?: string; requestRef?: string }) {
  log({ ...emptyEvent(finalRationaleMode()), ...correlation, delivery, skip });
}

const transport: RationaleTransport = (messages, options) => primaryModelJsonTask(
  "m03_final_rationale", "diagnose", messages,
  { maxTokens: FINAL_RATIONALE_MAX_TOKENS, timeoutMs: options.timeoutMs,
    requestOwned: { model: "deepseek-flash", onNetworkAttempt: options.onNetworkAttempt, onUsage: options.onUsage } },
  (content) => typeof content === "string" && content.trim() ? content : undefined,
  options.signal,
);

export function rationalePairFrom(root: ClinicalReasoningResultV2 | undefined): RationalePair | undefined {
  const overview = root?.overview;
  if (typeof overview?.tcmDiseaseRationale !== "string" || typeof overview.tcmDiagnosticRationale !== "string") return undefined;
  return { tcmDiseaseRationale: overview.tcmDiseaseRationale, tcmDiagnosticRationale: overview.tcmDiagnosticRationale };
}

/** Stable comparison after normalization and signing. Metadata is bound after authoring. */
export function finalRationaleDeliveryHash(root: ClinicalReasoningResultV2) {
  // 按 JSON 视图比较：一侧来自内存对象（可能带显式 undefined 键，如 guidelineReferences），另一侧来自解析回来的交付内容。
  const content = JSON.parse(JSON.stringify(root)) as ClinicalReasoningResultV2;
  delete content.clinicalReview;
  delete content.contractSignature;
  delete content.contractSignatureVersion;
  return deliveryHash(content);
}

export function createFinalRationaleAuthor(options: AuthorOptions) {
  const mode = options.mode ?? finalRationaleMode();
  const event = { ...emptyEvent(mode), caseRef: options.caseRef, requestRef: options.requestRef };
  const invoke = options.transport ?? transport;
  const timeout = options.timeoutMs ?? FINAL_RATIONALE_TIMEOUT_MS;
  let draft: RationaleRequest | undefined;
  let active: RationaleRequest | undefined;
  let finished = false;

  const remaining = () => options.deadline() - Date.now() - SIGNING_RESERVE_MS;
  const reason = (code: string) => { event.reasons.push({ code, field: "$" }); };
  const contextFor = (root: ClinicalReasoningResultV2) => buildFinalRationaleContext(root, options.state, options.scope);

  const start = (context: FinalRationaleContext, revise: RationaleRejection[] = []): RationaleRequest | undefined => {
    const timeoutMs = Math.min(timeout, remaining());
    if (event.requests >= 2 || options.signal.aborted || finished ||
      timeoutMs < Math.min(timeout, revise.length ? MIN_REVISION_MS : MIN_START_MS)) return undefined;
    const startedAt = Date.now();
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal.reason);
    options.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    event.requests++;
    event.launched = true;
    let settle: (value: unknown) => void = () => {};
    const aborted = new Promise<undefined>((resolve) => controller.signal.addEventListener("abort", () => {
      if (controller.signal.reason === "timeout") reason("fallback_timeout");
      resolve(undefined);
    }, { once: true }));
    const reply = Promise.race([aborted, new Promise((resolve) => { settle = resolve; })]).finally(() => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      event.modelMs += Date.now() - startedAt;
    });
    const request = { key: context.key, controller, reply };
    active = request;
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return undefined;
      return invoke(finalRationaleMessages(context, revise), {
        signal: controller.signal, timeoutMs,
        onNetworkAttempt: () => { event.physicalCalls++; },
        onUsage: (usage) => {
          if (finished || controller.signal.aborted) return;
          event.promptTokens += usage?.promptTokens || 0;
          event.completionTokens += usage?.completionTokens || 0;
        },
      });
    }).then((value) => {
      if (!controller.signal.aborted && value !== undefined) {
        const parsed = parseRationaleOutline(value);
        if (parsed.outline || parsed.reasons?.[0]?.code === "evidence_gap") event.validReplies++;
      }
      settle(value);
    }).catch(() => {
      if (!controller.signal.aborted) reason("transport_error");
      settle(undefined);
    });
    return request;
  };

  const prefetch = (projection: () => ClinicalReasoningResultV2 | undefined) => {
    if (mode === "off" || draft || finished || options.signal.aborted) return;
    try {
      const root = projection();
      const context = root && contextFor(root);
      if (context) draft = start(context);
    } catch { /* The ordinary terminal candidate may still be valid. */ }
  };

  const waitFor = async (request: RationaleRequest) => {
    const started = Date.now();
    try { return await request.reply; }
    finally { event.waitMs += Date.now() - started; }
  };

  const propose = async (root: ClinicalReasoningResultV2) => {
    if (mode === "off" || finished || options.signal.aborted) return undefined;
    try {
      const context = contextFor(root);
      if (!context) return undefined;
      event.eligible = true;
      event.snapshot = context.key;
      event.bounded = context.input.conclusion.resolution === "bounded";
      event.lineage = Boolean(context.input.lineage);
      event.secondaries = context.input.conclusion.names.length - 1;
      let request = draft;
      if (draft) {
        const hit = draft.key === context.key;
        event.prefetch = hit ? "hit" : "stale";
        if (!hit) {
          draft.controller.abort("stale");
          request = undefined;
        }
      }
      request ??= start(context);
      if (!request) { reason("budget_unavailable"); return undefined; }
      let raw = await waitFor(request);
      if (options.signal.aborted || finished || request.controller.signal.aborted) return undefined;
      if (raw === undefined) { reason("no_reply"); return undefined; }
      const validate = (revision = false) => {
        const started = Date.now();
        try { return validateRationalePair(raw, context, { revision }); }
        finally { event.validationMs += Date.now() - started; }
      };
      let result = validate();
      if (!result.ok) {
        event.reasons.push(...result.reasons.map(({ code, field }) => ({ code, field })));
        if (result.reasons.some((item) => item.code === "evidence_gap")) return undefined;
        // 第五十轮实测：退修把 M03 的九成位多拖 4–5 秒，换来约 15 个百分点的采纳率；缺省不退修，首稿不合格即沿用旧两段。
        if (process.env.CDSS_M03_FINAL_RATIONALE_RETRY !== "true") return undefined;
        const retry = start(context, result.reasons);
        if (!retry) return undefined;
        event.retried = true;
        raw = await waitFor(retry);
        if (options.signal.aborted || finished || retry.controller.signal.aborted) return undefined;
        if (raw === undefined) { reason("no_reply"); return undefined; }
        result = validate(true);
        if (!result.ok) {
          for (const { code, field } of result.reasons) event.reasons.push({ code, field });
          return undefined;
        }
      }
      if (result.softAccepted) {
        event.softAccepted = true;
        event.softReasons = (result.reasons || []).map(({ code, field }) => ({ code, field }));
      }
      const claimBudget = remaining();
      const claimSignal = claimBudget > 0
        ? AbortSignal.any([options.signal, AbortSignal.timeout(claimBudget)])
        : AbortSignal.abort();
      const { verdict, claimCheck, claimCalls, claimRemovals } = await checkFinalRationaleClaims(result, context, claimSignal, options.claimCheck);
      Object.assign(event, { claimCheck, claimCalls, claimRemovals });
      if (options.signal.aborted || finished) return undefined;
      if (!verdict.ok) {
        event.reasons.push(...verdict.reasons.map(({ code, field }) => ({ code, field })));
        return undefined;
      }
      event.verified = true;
      return { pair: verdict.pair, context, adopt: mode === "on" };
    } catch {
      reason("validation_error");
      return undefined;
    }
  };

  const finish = (delivery: Delivery, signed = false, skip?: SkipReason) => {
    if (finished) return;
    finished = true;
    if (event.prefetch === "none" && draft) event.prefetch = "cancelled";
    draft?.controller.abort("finished");
    active?.controller.abort("finished");
    event.delivery = delivery;
    event.signed = signed;
    event.adopted = delivery === "new" && signed;
    event.skip = skip ?? (mode === "off" ? "off" : options.signal.aborted ? "cancelled" : undefined);
    // A stale/aborted reply can settle after final delivery. Logging a copy freezes the counters.
    (options.observe || log)({ ...event, reasons: [...event.reasons], softReasons: [...event.softReasons] });
  };

  const rejectTransaction = (detail?: string) => {
    event.verified = false;
    reason(detail ? `transaction_${detail}` : "transaction_rejected");
  };
  return { enabled: mode !== "off", prefetch, propose, finish, reason, rejectTransaction };
}
