import assert from "node:assert/strict";
import { createJiti } from "jiti";

process.env.RXAI_AUDIT_ENABLED = "true";
process.env.RXAI_AUDIT_BASE_URL = "http://127.0.0.1:39091";
process.env.RXAI_AUDIT_API_KEY = "test-audit-key";
process.env.RXAI_AUDIT_ALLOW_INSECURE_HTTP = "true";
process.env.RXAI_AUDIT_RETRY_ATTEMPTS = "0";
process.env.RXAI_AUDIT_CACHE_TTL_MS = "90000";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const {
  getRxAuditCacheTtlMs,
  resetRxAuditResultCache,
  runBoundedRxAudit,
} = await jiti.import("../src/lib/rxaudit.ts");

function auditState(id, dose = "10g") {
  return {
    id,
    phase: "assess",
    patient: { sex: "男", age: 46 },
    chiefComplaint: "入睡困难3个月",
    diagnosis: "失眠障碍；心脾两虚证",
    medicationHistory: "",
    allergyHistory: "否认药物过敏",
    pastHistory: "否认肝肾功能不全",
    conversation: [],
    reasoningPrescribe: {
      stage: "prescribe",
      formula: {
        candidates: [{
          name: "本例辨证组方",
          herbs: [{ name: "白术", dose, processing: null, decoctionRequirement: null }],
          decoction: {
            doseCount: "5剂",
            dosesPerDay: 1,
            administrationTimesPerDay: 2,
            course: "5日",
            method: "每日1剂，水煎服，每日分2次服",
            followUpNode: "完成5剂后复诊",
          },
        }],
        modifications: [],
      },
    },
  };
}

assert.equal(getRxAuditCacheTtlMs("1"), 90000, "低于60秒回落默认值");
assert.equal(getRxAuditCacheTtlMs("60000"), 60000);
assert.equal(getRxAuditCacheTtlMs("120000"), 120000);
assert.equal(getRxAuditCacheTtlMs("120001"), 90000, "高于120秒回落默认值");

resetRxAuditResultCache();
const originalFetch = globalThis.fetch;
let providerCalls = 0;
let providerMode = "success";
globalThis.fetch = async () => {
  providerCalls += 1;
  if (providerMode === "failure") return new Response("upstream down", { status: 503 });
  return Response.json({
    code: 200,
    trace_id: `TRACE-CACHE-${providerCalls}`,
    data: {
      audit_id: `AUDIT-CACHE-${providerCalls}`,
      audit_result: "PASS",
      highest_risk_level: "INFO",
      need_manual_review: false,
      issues: [],
    },
  });
};

try {
  const first = await runBoundedRxAudit(auditState("cache-same"), 0);
  const second = await runBoundedRxAudit(auditState("cache-same"), 0);
  assert.equal(first.providerAudit.ok, true);
  assert.equal(first.cacheStatus, "miss");
  assert.equal(second.providerAudit.ok, true);
  assert.equal(second.cacheStatus, "hit");
  assert.equal(providerCalls, 1, "同一完整处方版本在 TTL 内只能外呼一次");

  const changedDose = await runBoundedRxAudit(auditState("cache-same", "12g"), 0);
  assert.equal(changedDose.cacheStatus, "miss");
  assert.equal(providerCalls, 2, "剂量变化必须换缓存键并重新审方");

  const changedVitals = await runBoundedRxAudit({
    ...auditState("cache-same"),
    vitals: { BP: "186/112mmHg", P: "108次/分" },
  }, 0);
  assert.equal(changedVitals.cacheStatus, "miss");
  assert.equal(providerCalls, 3, "审方会发送的患者上下文变化必须换缓存键，不能只哈希药味");

  providerMode = "failure";
  const failedOnce = await runBoundedRxAudit(auditState("cache-failure"), 0);
  const failedTwice = await runBoundedRxAudit(auditState("cache-failure"), 0);
  assert.equal(failedOnce.providerAudit.ok, false);
  assert.equal(failedTwice.providerAudit.ok, false);
  assert.equal(failedOnce.cacheStatus, "miss");
  assert.equal(failedTwice.cacheStatus, "miss");
  assert.equal(providerCalls, 5, "失败、降级和不可用结果不得进入成功缓存");
} finally {
  globalThis.fetch = originalFetch;
  resetRxAuditResultCache();
}

console.log(JSON.stringify({ suite: "rxaudit-cache", providerCalls, failures: 0 }));
