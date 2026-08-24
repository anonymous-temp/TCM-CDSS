import assert from "node:assert/strict";

const originalInfo = console.info;
const logs = [];
console.info = (...args) => logs.push(args);
const { getCdssStageTelemetrySnapshot, recordCdssClinicalReviewTelemetry, recordCdssStageTelemetry } = await import("../src/lib/cdss-stage-telemetry.ts");

for (const [durationMs, outcome, retryCount] of [
  [10, "success", 0],
  [20, "repaired", 1],
  [30, "provider_error", 2],
  [40, "success", 0],
]) {
  recordCdssStageTelemetry({
    stage: "diagnose",
    outcome,
    durationMs,
    retryCount,
    reviewStatus: durationMs === 30 ? "unavailable" : "accepted",
    reviewAttemptCount: durationMs === 30 ? 2 : 1,
    reviewDurationMs: durationMs,
    reviewRebindCount: durationMs === 30 ? 1 : 0,
    reasonCode: durationMs === 30 ? "Provider error: patient 张三" : undefined,
  });
}
recordCdssStageTelemetry({ stage: "assess", outcome: "success", durationMs: 12, auditReached: true });
console.info = originalInfo;

const snapshot = getCdssStageTelemetrySnapshot();
assert.equal(snapshot.schemaVersion, "tcm-cdss-stage-telemetry-v1");
assert.equal(snapshot.stages.diagnose.total, 4);
assert.equal(snapshot.stages.diagnose.averageDurationMs, 25);
assert.equal(snapshot.stages.diagnose.p50DurationMs, 20);
assert.equal(snapshot.stages.diagnose.p95DurationMs, 40);
assert.equal(snapshot.stages.diagnose.retryCountTotal, 3);
assert.equal(snapshot.stages.diagnose.retried, 2);
assert.equal(snapshot.stages.diagnose.reviewUnavailable, 1);
assert.equal(snapshot.stages.diagnose.reviewAttemptCountTotal, 5);
assert.equal(snapshot.stages.diagnose.reviewDurationMsTotal, 100);
assert.equal(snapshot.stages.diagnose.averageReviewDurationMs, 25);
assert.equal(snapshot.stages.diagnose.reviewRebindCount, 1);
assert.equal(snapshot.stages.diagnose.outcomes.provider_error, 1);
assert.equal(snapshot.stages.assess.auditReached, 1);
assert.equal(logs.length, 5);
assert.doesNotMatch(JSON.stringify(logs), /张三/);
assert.match(JSON.stringify(logs), /provider_error:_patient/);

// ─── P2-8 funnel counters + per-stage modelResponded / reasonCodes ──────────
console.info = (...args) => logs.push(args);
recordCdssStageTelemetry({ stage: "diagnose", outcome: "contract_rejected", durationMs: 40, modelResponded: true, reasonCode: "final_contract_rejected" });
recordCdssStageTelemetry({ stage: "diagnose", outcome: "fallback", durationMs: 41, modelResponded: true, reasonCode: "signed_limited_fallback_quarantine_loop" });
recordCdssStageTelemetry({ stage: "prescribe", outcome: "success", durationMs: 42, modelResponded: true, reasonCode: "accepted" });
recordCdssStageTelemetry({ stage: "assess", outcome: "success", durationMs: 12, auditReached: true, reasonCode: "audit_available" });
recordCdssStageTelemetry({ stage: "assess", outcome: "success", durationMs: 13, auditReached: true, reasonCode: "audit_rxaudit_total_timeout" });
recordCdssStageTelemetry({ stage: "assess", outcome: "success", durationMs: 14, auditReached: true, reasonCode: "audit unavailable: patient 李四" });

// ─── P1-4 independent clinical review telemetry ─────────────────────────────
recordCdssClinicalReviewTelemetry({
  stage: "diagnose", outcome: "accepted", provider: "DeepSeek", model: "deepseek-v4-pro", source: "preferred",
  durationMs: 800, attemptCount: 1, reasonCode: "accepted", issueCode: "none", payloadHash: "sha256:0123456789abcdef",
});
recordCdssClinicalReviewTelemetry({
  stage: "diagnose", outcome: "repair_demanded", provider: "deepseek", model: "deepseek-v4-pro", source: "preferred",
  durationMs: 900, attemptCount: 1, reasonCode: "repair", issueCode: "criteria_not_met", payloadHash: "sha256:fedcba9876543210",
});
recordCdssClinicalReviewTelemetry({
  stage: "diagnose", outcome: "invalid", provider: "deepseek", model: "deepseek-v4-flash", source: "cross_model_fallback",
  durationMs: 1200, attemptCount: 2, reasonCode: "invalid_contract", payloadHash: "sha256:aaaabbbbccccdddd",
});
recordCdssClinicalReviewTelemetry({
  stage: "prescribe", outcome: "unavailable", provider: "deepseek", model: "deepseek-v4-pro", source: "cross_model_fallback",
  durationMs: 5000, attemptCount: 2, reasonCode: "deadline",
});
console.info = originalInfo;

const extended = getCdssStageTelemetrySnapshot();
assert.equal(extended.stages.diagnose.total, 6);
assert.equal(extended.stages.diagnose.modelResponded, 2);
assert.equal(extended.stages.diagnose.reasonCodes.final_contract_rejected, 1);
assert.equal(extended.stages.diagnose.reasonCodes.signed_limited_fallback_quarantine_loop, 1);
assert.equal(extended.stages.diagnose.outcomes.contract_rejected, 1);
assert.equal(extended.stages.diagnose.outcomes.fallback, 1);
assert.equal(extended.stages.prescribe.modelResponded, 1);
assert.equal(extended.stages.assess.total, 4);
assert.equal(extended.stages.assess.auditReached, 4);
assert.deepEqual(extended.funnel, {
  modelResponses: 3,
  contractRejected: 1,
  repairSucceeded: 1,
  signedLimitedFallback: 1,
  signedLimitedFallbackQuarantineLoop: 1,
  m04Reached: 1,
  m05Reached: 4,
  rxAuditAvailable: 1,
  rxAuditUnavailable: 2,
});
const diagnoseReviews = extended.clinicalReviews.diagnose;
assert.equal(diagnoseReviews.total, 3);
assert.deepEqual(diagnoseReviews.outcomes, { accepted: 1, repair_demanded: 1, invalid: 1, unavailable: 0 });
assert.equal(diagnoseReviews.attemptCountTotal, 4);
assert.equal(diagnoseReviews.averageDurationMs, 967);
assert.equal(diagnoseReviews.reasons.accepted, 1);
assert.equal(diagnoseReviews.reasons.repair, 1);
assert.equal(diagnoseReviews.reasons.invalid_contract, 1);
assert.equal(diagnoseReviews.issueCodes.criteria_not_met, 1);
assert.equal(diagnoseReviews.reviewers["deepseek/deepseek-v4-pro/preferred"], 2);
assert.equal(diagnoseReviews.reviewers["deepseek/deepseek-v4-flash/cross_model_fallback"], 1);
assert.deepEqual(diagnoseReviews.recentWindow, {
  durationMinutes: 15,
  maximumSampleSize: 100,
  sampleSize: 3,
  completed: 2,
  accepted: 1,
  repairDemanded: 1,
  invalid: 1,
  unavailable: 0,
  completionRate: 0.6667,
  acceptanceRate: 0.3333,
  unavailableRate: 0,
});
const prescribeReviews = extended.clinicalReviews.prescribe;
assert.equal(prescribeReviews.total, 1);
assert.equal(prescribeReviews.outcomes.unavailable, 1);
assert.equal(prescribeReviews.reasons.deadline, 1);
assert.equal(prescribeReviews.recentWindow.completionRate, 0);
assert.equal(prescribeReviews.recentWindow.unavailableRate, 1);
// Review telemetry is aggregate-only: the per-request record rides the extended
// "[tcm-cdss:timing] clinical_review" log in diagnosis-api.ts, so only stage events log here.
assert.equal(logs.length, 11);
assert.doesNotMatch(JSON.stringify(logs), /李四/);
assert.doesNotMatch(JSON.stringify(extended), /李四|张三/);

console.log("stage telemetry tests passed: 44 assertions");
