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
  /** True when the provider actually returned stream content for this stage (模型返回). */
  modelResponded?: boolean;
  reasonCode?: string;
}>;

/** Independent clinical review (M03/M04 reviewer chain) outcome vocabulary. */
export type CdssClinicalReviewOutcome = "accepted" | "repair_demanded" | "invalid" | "unavailable";

export type CdssClinicalReviewTelemetryEvent = Readonly<{
  stage: "diagnose" | "prescribe";
  outcome: CdssClinicalReviewOutcome;
  provider: string;
  model: string;
  /** Which candidate-chain entry produced this outcome: "preferred" | "cross_model_fallback". */
  source: string;
  durationMs: number;
  attemptCount: number;
  /** Execution reason: accepted | repair | not_configured | deadline | invalid_contract | http_error | transport_error. */
  reasonCode?: string;
  /** Reviewer clinical issue code (criteria_not_met, formula_indication_mismatch, …) when present. */
  issueCode?: string;
  /** Truncated sha256 of the review request+response payload; correlation-only, never PHI. */
  payloadHash?: string;
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
  modelResponded: number;
  reasonCodes: Record<string, number>;
};

type ClinicalReviewAggregate = {
  total: number;
  durationMsTotal: number;
  attemptCountTotal: number;
  outcomes: Record<CdssClinicalReviewOutcome, number>;
  recentEvents: Array<{
    at: number;
    outcome: CdssClinicalReviewOutcome;
  }>;
  reasons: Record<string, number>;
  issueCodes: Record<string, number>;
  reviewers: Record<string, number>;
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
  clinicalReviews: Record<string, ClinicalReviewAggregate>;
  funnel: FunnelCounters;
};
const TELEMETRY_STORE = Symbol.for("tcm-cdss.stage-telemetry.v1");

/** Bounded distinct keys per map; overflow folds into "other" so a buggy reason stream cannot grow memory. */
const MAX_DISTINCT_KEYS = 64;
const CLINICAL_REVIEW_RECENT_WINDOW_MS = 15 * 60_000;
const CLINICAL_REVIEW_RECENT_EVENT_LIMIT = 100;

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
    reviewAttemptCountTotal: 0,
    reviewDurationMsTotal: 0,
    reviewRebindCount: 0,
    auditReached: 0,
    modelResponded: 0,
    reasonCodes: nullProtoRecord(),
  };
}

function emptyClinicalReviewAggregate(): ClinicalReviewAggregate {
  return {
    total: 0,
    durationMsTotal: 0,
    attemptCountTotal: 0,
    outcomes: { accepted: 0, repair_demanded: 0, invalid: 0, unavailable: 0 },
    recentEvents: [],
    reasons: nullProtoRecord(),
    issueCodes: nullProtoRecord(),
    reviewers: nullProtoRecord(),
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
      clinicalReviews: {},
      funnel: emptyFunnel(),
    };
  }
  const state = root[TELEMETRY_STORE];
  // Backfill shape for stores created by an earlier module version in the same process.
  if (!state.clinicalReviews) state.clinicalReviews = {};
  if (!state.funnel) state.funnel = emptyFunnel();
  return state;
}

function safeReasonCode(value: string | undefined): string | undefined {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 100);
  return normalized || undefined;
}

/** Provider/model keys keep dots and dashes readable (deepseek-v4.5-flash); still bounded and non-PHI. */
function safeIdentityKey(value: string | undefined): string {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9_.:/-]/g, "_").slice(0, 120);
  return normalized || "none";
}

function bumpKey(map: Record<string, number>, rawKey: string | undefined): void {
  const safe = safeReasonCode(rawKey);
  if (!safe) return;
  const key = map[safe] == null && Object.keys(map).length >= MAX_DISTINCT_KEYS ? "other" : safe;
  map[key] = (map[key] || 0) + 1;
}

function bumpIdentityKey(map: Record<string, number>, key: string): void {
  const bounded = map[key] == null && Object.keys(map).length >= MAX_DISTINCT_KEYS ? "other" : key;
  map[bounded] = (map[bounded] || 0) + 1;
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

/**
 * Aggregate-only observability for the independent clinical reviewer chain (P1-4). The per-request
 * record rides the existing "[tcm-cdss:timing] clinical_review" log in diagnosis-api.ts (extended
 * with outcome + payloadHash); this channel exists to make invalid/unavailable/repair-loop ratios
 * measurable per stage without parsing logs. All fields are config values, reason vocabulary or
 * truncated hashes — never patient content.
 */
export function recordCdssClinicalReviewTelemetry(event: CdssClinicalReviewTelemetryEvent): void {
  const state = store();
  const aggregate = state.clinicalReviews[event.stage] || emptyClinicalReviewAggregate();
  if (!aggregate.recentEvents) aggregate.recentEvents = [];
  aggregate.total += 1;
  aggregate.durationMsTotal += Math.max(0, Math.round(event.durationMs));
  aggregate.attemptCountTotal += Math.max(0, Math.round(event.attemptCount));
  aggregate.outcomes[event.outcome] += 1;
  const now = Date.now();
  aggregate.recentEvents.push({ at: now, outcome: event.outcome });
  aggregate.recentEvents = aggregate.recentEvents
    .filter((recent) => now - recent.at <= CLINICAL_REVIEW_RECENT_WINDOW_MS)
    .slice(-CLINICAL_REVIEW_RECENT_EVENT_LIMIT);
  bumpKey(aggregate.reasons, event.reasonCode);
  bumpKey(aggregate.issueCodes, event.issueCode);
  bumpIdentityKey(
    aggregate.reviewers,
    `${safeIdentityKey(event.provider)}/${safeIdentityKey(event.model)}/${safeIdentityKey(event.source)}`,
  );
  state.clinicalReviews[event.stage] = aggregate;
  state.updatedAt = new Date().toISOString();
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

export function getCdssStageTelemetrySnapshot(): unknown {
  const state = store();
  const now = Date.now();
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
      modelResponded: aggregate.modelResponded,
      reasonCodes: { ...(aggregate.reasonCodes || nullProtoRecord()) },
    }])),
    funnel: { ...state.funnel },
    clinicalReviews: Object.fromEntries(Object.entries(state.clinicalReviews).map(([stage, aggregate]) => {
      const recentEvents = (aggregate.recentEvents || [])
        .filter((recent) => now - recent.at <= CLINICAL_REVIEW_RECENT_WINDOW_MS)
        .slice(-CLINICAL_REVIEW_RECENT_EVENT_LIMIT);
      aggregate.recentEvents = recentEvents;
      const recentAccepted = recentEvents.filter((event) => event.outcome === "accepted").length;
      const recentRepairDemanded = recentEvents.filter((event) => event.outcome === "repair_demanded").length;
      const recentInvalid = recentEvents.filter((event) => event.outcome === "invalid").length;
      const recentUnavailable = recentEvents.filter((event) => event.outcome === "unavailable").length;
      const recentCompleted = recentAccepted + recentRepairDemanded;
      const recentSampleSize = recentEvents.length;
      return [stage, {
        total: aggregate.total,
        outcomes: { ...aggregate.outcomes },
        averageDurationMs: aggregate.total > 0 ? Math.round(aggregate.durationMsTotal / aggregate.total) : 0,
        attemptCountTotal: aggregate.attemptCountTotal,
        recentWindow: {
          durationMinutes: CLINICAL_REVIEW_RECENT_WINDOW_MS / 60_000,
          maximumSampleSize: CLINICAL_REVIEW_RECENT_EVENT_LIMIT,
          sampleSize: recentSampleSize,
          completed: recentCompleted,
          accepted: recentAccepted,
          repairDemanded: recentRepairDemanded,
          invalid: recentInvalid,
          unavailable: recentUnavailable,
          completionRate: recentSampleSize > 0 ? Number((recentCompleted / recentSampleSize).toFixed(4)) : null,
          acceptanceRate: recentSampleSize > 0 ? Number((recentAccepted / recentSampleSize).toFixed(4)) : null,
          unavailableRate: recentSampleSize > 0 ? Number((recentUnavailable / recentSampleSize).toFixed(4)) : null,
        },
        reasons: { ...aggregate.reasons },
        issueCodes: { ...aggregate.issueCodes },
        reviewers: { ...aggregate.reviewers },
      }];
    })),
  };
}
