export type CdssTelemetryStage = "collect" | "question" | "diagnose" | "prescribe" | "assess" | "unstructured";
export type CdssTelemetryOutcome = "success" | "repaired" | "fallback" | "contract_rejected" | "provider_error";

export type CdssStageTelemetryEvent = Readonly<{
  stage: CdssTelemetryStage;
  outcome: CdssTelemetryOutcome;
  durationMs: number;
  retryCount?: number;
  /**
   * 「复核不可用」与「复核不同意、服务端有界受理」是两回事（甲方 08cc573 复测第 3 项）。
   * 编排语义上有界建议按 unavailable 走（不再触发修复轮），但签名 attestation 记的是
   * accepted + reviewDecision=repair + 原始问题码。运维指标此前只有 unavailable 一档，
   * 于是 30h 生产实测 10/58 例被计成「复核不可用 17%」——与签名载荷说的完全相反。
   */
  reviewStatus?: "accepted" | "repair" | "unavailable" | "bounded_advisory" | "not_run";
  reviewAttemptCount?: number;
  reviewDurationMs?: number;
  reviewRebindCount?: number;
  auditReached?: boolean;
  /** True when the provider actually returned stream content for this stage (模型返回). */
  modelResponded?: boolean;
  reasonCode?: string;
}>;

type StageAggregate = {
  total: number;
  durationMsTotal: number;
  recentDurationsMs: number[];
  retryCountTotal: number;
  retried: number;
  outcomes: Record<CdssTelemetryOutcome, number>;
  reviewUnavailable: number;
  /** 复核不同意但候选已过确定性安全合同、按质量意见有界受理的次数。不计入 reviewUnavailable。 */
  reviewBoundedAdvisory: number;
  reviewAttemptCountTotal: number;
  reviewDurationMsTotal: number;
  reviewRebindCount: number;
  auditReached: number;
  modelResponded: number;
  reasonCodes: Record<string, number>;
};

/** Request-funnel counters derived from stage events (P2-8). */
type FunnelCounters = {
  modelResponses: number;
  contractRejected: number;
  repairSucceeded: number;
  signedLimitedFallback: number;
  signedLimitedFallbackQuarantineLoop: number;
  m04Reached: number;
  m05Reached: number;
  rxAuditAvailable: number;
  rxAuditUnavailable: number;
};

type TelemetryStore = {
  startedAt: string;
  updatedAt: string;
  stages: Record<string, StageAggregate>;
  funnel: FunnelCounters;
};
const TELEMETRY_STORE = Symbol.for("tcm-cdss.stage-telemetry.v1");

/** Bounded distinct keys per map; overflow folds into "other" so a buggy reason stream cannot grow memory. */
const MAX_DISTINCT_KEYS = 64;

function nullProtoRecord(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

function emptyAggregate(): StageAggregate {
  return {
    total: 0,
    durationMsTotal: 0,
    recentDurationsMs: [],
    retryCountTotal: 0,
    retried: 0,
    outcomes: { success: 0, repaired: 0, fallback: 0, contract_rejected: 0, provider_error: 0 },
    reviewUnavailable: 0,
    reviewBoundedAdvisory: 0,
    reviewAttemptCountTotal: 0,
    reviewDurationMsTotal: 0,
    reviewRebindCount: 0,
    auditReached: 0,
    modelResponded: 0,
    reasonCodes: nullProtoRecord(),
  };
}

function emptyFunnel(): FunnelCounters {
  return {
    modelResponses: 0,
    contractRejected: 0,
    repairSucceeded: 0,
    signedLimitedFallback: 0,
    signedLimitedFallbackQuarantineLoop: 0,
    m04Reached: 0,
    m05Reached: 0,
    rxAuditAvailable: 0,
    rxAuditUnavailable: 0,
  };
}

function store(): TelemetryStore {
  const root = globalThis as typeof globalThis & { [TELEMETRY_STORE]?: TelemetryStore };
  if (!root[TELEMETRY_STORE]) {
    const now = new Date().toISOString();
    root[TELEMETRY_STORE] = {
      startedAt: now,
      updatedAt: now,
      stages: {},
      funnel: emptyFunnel(),
    };
  }
  const state = root[TELEMETRY_STORE];
  // Backfill shape for stores created by an earlier module version in the same process.
  if (!state.funnel) state.funnel = emptyFunnel();
  return state;
}

function safeReasonCode(value: string | undefined): string | undefined {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 100);
  return normalized || undefined;
}

function bumpKey(map: Record<string, number>, rawKey: string | undefined): void {
  const safe = safeReasonCode(rawKey);
  if (!safe) return;
  const key = map[safe] == null && Object.keys(map).length >= MAX_DISTINCT_KEYS ? "other" : safe;
  map[key] = (map[key] || 0) + 1;
}

export function recordCdssStageTelemetry(event: CdssStageTelemetryEvent): void {
  const state = store();
  const aggregate = state.stages[event.stage] || emptyAggregate();
  if (!aggregate.reasonCodes) aggregate.reasonCodes = nullProtoRecord();
  aggregate.total += 1;
  const durationMs = Math.max(0, Math.round(event.durationMs));
  const retryCount = Math.max(0, Math.round(event.retryCount || 0));
  aggregate.durationMsTotal += durationMs;
  aggregate.recentDurationsMs.push(durationMs);
  if (aggregate.recentDurationsMs.length > 500) aggregate.recentDurationsMs.shift();
  aggregate.retryCountTotal += retryCount;
  if (retryCount > 0) aggregate.retried += 1;
  aggregate.outcomes[event.outcome] += 1;
  if (event.reviewStatus === "unavailable") aggregate.reviewUnavailable += 1;
  if (event.reviewStatus === "bounded_advisory") aggregate.reviewBoundedAdvisory += 1;
  aggregate.reviewAttemptCountTotal += Math.max(0, Math.round(event.reviewAttemptCount || 0));
  aggregate.reviewDurationMsTotal += Math.max(0, Math.round(event.reviewDurationMs || 0));
  aggregate.reviewRebindCount += Math.max(0, Math.round(event.reviewRebindCount || 0));
  if (event.auditReached) aggregate.auditReached += 1;
  if (event.modelResponded) aggregate.modelResponded += 1;
  const reason = safeReasonCode(event.reasonCode);
  bumpKey(aggregate.reasonCodes, event.reasonCode);
  // Funnel derivation (P2-8): one request's progression stays countable from the same events the
  // per-stage aggregates already consume; rxaudit availability is derived from the assess route's
  // audit_available / audit_<reason> reason vocabulary (providerAudit.ok === false → unavailable).
  if (event.modelResponded) state.funnel.modelResponses += 1;
  if (event.outcome === "contract_rejected") state.funnel.contractRejected += 1;
  if (event.outcome === "repaired") state.funnel.repairSucceeded += 1;
  if (reason?.includes("signed_limited_fallback")) {
    state.funnel.signedLimitedFallback += 1;
    if (reason === "signed_limited_fallback_quarantine_loop") state.funnel.signedLimitedFallbackQuarantineLoop += 1;
  }
  if (event.stage === "prescribe") state.funnel.m04Reached += 1;
  if (event.stage === "assess") {
    state.funnel.m05Reached += 1;
    if (reason === "audit_available") state.funnel.rxAuditAvailable += 1;
    else if (reason?.startsWith("audit_")) state.funnel.rxAuditUnavailable += 1;
  }
  state.stages[event.stage] = aggregate;
  state.updatedAt = new Date().toISOString();
  console.info("[tcm-cdss:telemetry] stage_result", {
    ...event,
    reasonCode: reason || "none",
  });
}


function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

export function getCdssStageTelemetrySnapshot(): unknown {
  const state = store();
  return {
    schemaVersion: "tcm-cdss-stage-telemetry-v1",
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    stages: Object.fromEntries(Object.entries(state.stages).map(([stage, aggregate]) => [stage, {
      total: aggregate.total,
      outcomes: { ...aggregate.outcomes },
      averageDurationMs: aggregate.total > 0 ? Math.round(aggregate.durationMsTotal / aggregate.total) : 0,
      p50DurationMs: percentile(aggregate.recentDurationsMs, 0.5),
      p95DurationMs: percentile(aggregate.recentDurationsMs, 0.95),
      recentLatencySampleSize: aggregate.recentDurationsMs.length,
      retryCountTotal: aggregate.retryCountTotal,
      retried: aggregate.retried,
      reviewUnavailable: aggregate.reviewUnavailable,
      reviewBoundedAdvisory: aggregate.reviewBoundedAdvisory,
      reviewAttemptCountTotal: aggregate.reviewAttemptCountTotal,
      reviewDurationMsTotal: aggregate.reviewDurationMsTotal,
      averageReviewDurationMs: aggregate.total > 0 ? Math.round(aggregate.reviewDurationMsTotal / aggregate.total) : 0,
      reviewRebindCount: aggregate.reviewRebindCount,
      auditReached: aggregate.auditReached,
      modelResponded: aggregate.modelResponded,
      reasonCodes: { ...(aggregate.reasonCodes || nullProtoRecord()) },
    }])),
    funnel: { ...state.funnel },
  };
}
