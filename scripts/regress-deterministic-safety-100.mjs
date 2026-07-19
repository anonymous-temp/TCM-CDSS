// 100 条确定性安全门 unit 测试 - 直接 import withSafetyGate,绕开 HTTP/LLM
// 这是真正的"确定性"回归,与 red-flags route 行为完全一致(只是不调 clinicalFacts LLM)
import { createJiti } from "jiti";
import { REDFLAG_MATRIX_100 } from "./fixtures/redflag-matrix-100.mjs";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

const { withSafetyGate, evaluateSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");

function buildCase(c) {
  const state = {
    patient: {},
    chiefComplaint: c.chief,
    conversation: [],
    hisRecord: {
      caseId: `safety-${c.id}`,
      source: "regression",
      importedAt: new Date(0).toISOString(),
      rawText: [c.chief, c.hist].filter(Boolean).join("。"),
      fields: { zhushu: c.chief, xianbingshi: c.hist },
    },
  };
  if (c.vitals && Object.keys(c.vitals).length) {
    state.vitals = {};
    if (c.vitals.bp) state.vitals.bloodPressure = c.vitals.bp;
    if (c.vitals.hr) state.vitals.heartRate = String(c.vitals.hr);
    if (c.vitals.t) state.vitals.temperature = String(c.vitals.t);
    if (c.vitals.rr) state.vitals.respiratoryRate = String(c.vitals.rr);
    if (c.vitals.spo2) state.vitals.spo2 = String(c.vitals.spo2);
    state.hisRecord.fields.vitalsDetail = Object.entries(c.vitals).map(([key, value]) => `${key}:${value}`).join(" ");
  }
  return state;
}

const results = [];
const cat = id => id.slice(0, 2);

for (const c of REDFLAG_MATRIX_100) {
  const state = buildCase(c);
  const startedAt = Date.now();
  const result = withSafetyGate(state);
  const latencyMs = Date.now() - startedAt;
  const gate = result.safetyGate || evaluateSafetyGate(state);
  const expect = c.expect || {};
  const issues = [];

  if (expect.redFlag) {
    if (gate.status !== "red_flag") issues.push(`expected red_flag, got ${gate.status}`);
    if (gate.allowDosePrescription !== false) issues.push(`allowDosePrescription should be false, got ${gate.allowDosePrescription}`);
    if ((gate.redFlags || []).length === 0) issues.push(`expected ≥1 redFlag, got []`);
  } else {
    if (gate.status === "red_flag") {
      // 边界用例 (SP/MIX) 可能合理报红旗,记为软告警
      if (c.id.startsWith("SP") || c.id.startsWith("MIX")) {
        issues.push(`warn:borderline red_flag: ${(gate.redFlags || []).join("; ")}`);
      } else {
        issues.push(`UNEXPECTED red_flag: ${(gate.redFlags || []).join("; ")}`);
      }
    }
  }

  results.push({
    id: c.id, cat: cat(c.id), pass: issues.every((issue) => issue.startsWith("warn:")), issues,
    latencyMs,
    gateStatus: gate.status,
    allowDose: gate.allowDosePrescription,
    redFlagCount: (gate.redFlags || []).length,
    missingCount: (gate.missingItems || []).length,
    redFlags: gate.redFlags || [],
    missingItems: gate.missingItems || [],
    notes: c.notes || c.expect?.notes,
  });
}

// 报告
const total = results.length;
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass);
const byCat = {};
for (const r of results) {
  byCat[r.cat] = byCat[r.cat] || { total: 0, pass: 0, warn: 0 };
  byCat[r.cat].total += 1;
  if (r.pass) byCat[r.cat].pass += 1;
  if (r.issues.some(s => s.startsWith("warn:"))) byCat[r.cat].warn += 1;
}

console.log("======== 100 条 确定性安全门 unit 回归 ========");
console.log(`通过: ${passed}/${total} (${(passed/total*100).toFixed(1)}%)`);
console.log(`失败: ${failed.length}\n`);
console.log("--- 按类别 ---");
for (const [c, st] of Object.entries(byCat).sort()) {
  const rate = (st.pass / st.total * 100).toFixed(0);
  const warnStr = st.warn ? `, ${st.warn} warn` : "";
  console.log(`  ${c}: ${st.pass}/${st.total} (${rate}%${warnStr})`);
}

const latencies = results.map(r => r.latencyMs).sort((a,b) => a-b);
console.log(`\n--- 延迟(纯确定性,无 LLM) ---`);
console.log(`  p50: ${latencies[Math.floor(latencies.length/2)]}ms`);
console.log(`  p95: ${latencies[Math.floor(latencies.length*0.95)]}ms`);
console.log(`  max: ${latencies.at(-1)}ms`);

if (failed.length) {
  console.log(`\n--- 失败/告警明细 ---`);
  for (const f of failed) {
    console.log(`  ${f.id} (${f.cat}) [${f.gateStatus}, allowDose=${f.allowDose}, missing=${f.missingCount}, rf=${f.redFlagCount}]: ${f.issues.join("; ")}`);
    if (f.redFlags.length) console.log(`    redFlags: ${JSON.stringify(f.redFlags)}`);
    if (f.missingItems.length) console.log(`    missing: ${JSON.stringify(f.missingItems)}`);
  }
}

console.log("\n--- 红旗覆盖率(RF 类应触发的类别分布) ---");
const rfCats = {};
for (const r of results.filter(x => x.cat === "RF")) {
  for (const f of r.redFlags) {
    const key = f.slice(0, 30);
    rfCats[key] = (rfCats[key] || 0) + 1;
  }
}
for (const [k, n] of Object.entries(rfCats)) console.log(`  ${k}: ${n}`);

const summary = {
  total, passed, failed: failed.length,
  byCat,
  latency: { p50: latencies[Math.floor(latencies.length/2)], p95: latencies[Math.floor(latencies.length*0.95)], max: latencies.at(-1) },
  failures: failed,
  timestamp: new Date().toISOString(),
};
console.log("\nJSON Summary:");
console.log(JSON.stringify(summary, null, 2));

if (failed.length > 0) process.exit(1);
