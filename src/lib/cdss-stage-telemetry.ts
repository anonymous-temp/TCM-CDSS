export type CdssTelemetryStage = "collect" | "question" | "diagnose" | "prescribe" | "assess" | "unstructured";
export type CdssTelemetryOutcome = "success" | "repaired" | "fallback" | "contract_rejected" | "provider_error";

export type CdssStageTelemetryEvent = Readonly<{
  stage: CdssTelemetryStage;
  outcome: CdssTelemetryOutcome;
  durationMs: number;
  retryCount?: number;
  reviewStatus?: "accepted" | "repair" | "unavailable" | "not_run";
  reviewAttemptCount?: number;
  reviewDurationMs?: number;
  reviewRebindCount?: number;
  auditReached?: boolean;
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
  reviewAttemptCountTotal: number;
  reviewDurationMsTotal: number;
  reviewRebindCount: number;
  auditReached: number;
};

type TelemetryStore = { startedAt: string; updatedAt: string; stages: Record<string, StageAggregate> };
const TELEMETRY_STORE = Symbol.for("tcm-cdss.stage-telemetry.v1");

function emptyAggregate(): StageAggregate {
  return {
    total: 0,
    durationMsTotal: 0,
    recentDurationsMs: [],
    retryCountTotal: 0,
    retried: 0,
    outcomes: { success: 0, repaired: 0, fallback: 0, contract_rejected: 0, provider_error: 0 },
    reviewUnavailable: 0,
    reviewAttemptCountTotal: 0,
    reviewDurationMsTotal: 0,
    reviewRebindCount: 0,
    auditReached: 0,
  };
}

function store(): TelemetryStore {
  const root = globalThis as typeof globalThis & { [TELEMETRY_STORE]?: TelemetryStore };
  if (!root[TELEMETRY_STORE]) {
    const now = new Date().toISOString();
    root[TELEMETRY_STORE] = { startedAt: now, updatedAt: now, stages: {} };
  }
  return root[TELEMETRY_STORE];
}

function safeReasonCode(value: string | undefined): string | undefined {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 100);
  return normalized || undefined;
}

export function recordCdssStageTelemetry(event: CdssStageTelemetryEvent): void {
  const state = store();
  const aggregate = state.stages[event.stage] || emptyAggregate();
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
  aggregate.reviewAttemptCountTotal += Math.max(0, Math.round(event.reviewAttemptCount || 0));
  aggregate.reviewDurationMsTotal += Math.max(0, Math.round(event.reviewDurationMs || 0));
  aggregate.reviewRebindCount += Math.max(0, Math.round(event.reviewRebindCount || 0));
  if (event.auditReached) aggregate.auditReached += 1;
  state.stages[event.stage] = aggregate;
  state.updatedAt = new Date().toISOString();
  console.info("[tcm-cdss:telemetry] stage_result", {
    ...event,
    reasonCode: safeReasonCode(event.reasonCode) || "none",
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
      reviewAttemptCountTotal: aggregate.reviewAttemptCountTotal,
      reviewDurationMsTotal: aggregate.reviewDurationMsTotal,
      averageReviewDurationMs: aggregate.total > 0 ? Math.round(aggregate.reviewDurationMsTotal / aggregate.total) : 0,
      reviewRebindCount: aggregate.reviewRebindCount,
      auditReached: aggregate.auditReached,
    }])),
  };
}
