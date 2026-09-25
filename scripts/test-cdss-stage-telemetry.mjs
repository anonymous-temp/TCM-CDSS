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

// ─── P2-8 funnel counters + per-stage modelResponded / reasonCodes ──────────
console.info = (...args) => logs.push(args);
recordCdssStageTelemetry({ stage: "diagnose", outcome: "contract_rejected", durationMs: 40, modelResponded: true, reasonCode: "final_contract_rejected" });
recordCdssStageTelemetry({ stage: "diagnose", outcome: "fallback", durationMs: 41, modelResponded: true, reasonCode: "signed_limited_fallback_quarantine_loop" });
recordCdssStageTelemetry({ stage: "prescribe", outcome: "success", durationMs: 42, modelResponded: true, reasonCode: "accepted" });
recordCdssStageTelemetry({ stage: "assess", outcome: "success", durationMs: 12, auditReached: true, reasonCode: "audit_available" });
recordCdssStageTelemetry({ stage: "assess", outcome: "success", durationMs: 13, auditReached: true, reasonCode: "audit_rxaudit_total_timeout" });
recordCdssStageTelemetry({ stage: "assess", outcome: "success", durationMs: 14, auditReached: true, reasonCode: "audit unavailable: patient 李四" });
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
// 阶段事件才写日志；模型复核遥测通道随复核环节一并删除（2026-09-25）。
assert.equal(logs.length, 11);
assert.ok(!("clinicalReviews" in extended), "已删除的复核遥测通道不得再出现在快照里");
assert.doesNotMatch(JSON.stringify(logs), /李四/);
assert.doesNotMatch(JSON.stringify(extended), /李四|张三/);

// ─── reviewStatus 各档分开计数（自 test:review-bounded-advisory 迁入，2026-09-25）────────
// 模型复核环节已移除，编排只再上报 unavailable / not_run；bounded_advisory 等档位保留为
// health 快照里的常量字段（看板不断档）。计数逻辑本身仍须各档互不污染。
{
  const readDiagnose = () => getCdssStageTelemetrySnapshot().stages.diagnose;
  const before = readDiagnose();
  const baseUnavailable = Number(before.reviewUnavailable || 0);
  const baseBounded = Number(before.reviewBoundedAdvisory || 0);
  console.info = () => undefined;
  recordCdssStageTelemetry({ stage: "diagnose", outcome: "success", durationMs: 1000, reviewStatus: "bounded_advisory" });
  const afterBounded = readDiagnose();
  assert.equal(Number(afterBounded.reviewBoundedAdvisory || 0), baseBounded + 1, "bounded_advisory 未被单独计数");
  assert.equal(Number(afterBounded.reviewUnavailable || 0), baseUnavailable, "bounded_advisory 污染了 reviewUnavailable 计数");
  recordCdssStageTelemetry({ stage: "diagnose", outcome: "success", durationMs: 1000, reviewStatus: "unavailable" });
  recordCdssStageTelemetry({ stage: "diagnose", outcome: "success", durationMs: 1000, reviewStatus: "not_run" });
  console.info = originalInfo;
  const afterUnavailable = readDiagnose();
  assert.equal(Number(afterUnavailable.reviewUnavailable || 0), baseUnavailable + 1, "unavailable 漏计，或 not_run 被误计成 unavailable");
  assert.equal(Number(afterUnavailable.reviewBoundedAdvisory || 0), baseBounded + 1, "unavailable 被误计成 bounded_advisory");
}

console.log("stage telemetry tests passed: 49 assertions");
