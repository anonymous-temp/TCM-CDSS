import assert from "node:assert/strict";

const originalInfo = console.info;
const logs = [];
console.info = (...args) => logs.push(args);
const { getCdssStageTelemetrySnapshot, recordCdssStageTelemetry } = await import("../src/lib/cdss-stage-telemetry.ts");

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

console.log("stage telemetry tests passed: 16 assertions");
