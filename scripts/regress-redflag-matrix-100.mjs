// 批量执行 100 条 red-flags 安全门测试 - 简化并发版
import { REDFLAG_MATRIX_100 } from "./fixtures/redflag-matrix-100.mjs";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || process.env.TCM_CDSS_API_TOKEN || "";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 30000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);

const cat = id => id.slice(0, 2);

function buildCase(c) {
  const state = { patient: { ...(c.sex ? { sex: c.sex } : {}), ...(c.age ? { age: c.age } : {}) }, chiefComplaint: c.chief, historyPresentIllness: c.hist };
  if (c.vitals && Object.keys(c.vitals).length) {
    state.vitals = {};
    if (c.vitals.bp) state.vitals.bp = c.vitals.bp;
    if (c.vitals.hr) state.vitals.heartRate = String(c.vitals.hr);
    if (c.vitals.t) state.vitals.temperature = String(c.vitals.t);
    if (c.vitals.rr) state.vitals.respiratoryRate = String(c.vitals.rr);
    if (c.vitals.spo2) state.vitals.spo2 = String(c.vitals.spo2);
  }
  return state;
}

async function callRedFlags(c) {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/api/diagnosis/red-flags`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
      body: JSON.stringify({ caseState: buildCase(c) }),
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, status: res.status, latencyMs, error: `HTTP ${res.status}: ${txt.slice(0,200)}` };
    }
    const body = await res.json();
    return { ok: true, status: 200, latencyMs, body };
  } catch (e) {
    return { ok: false, status: 0, latencyMs: Date.now() - startedAt, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

function summarize(c, result) {
  const expect = c.expect || {};
  const issues = [];
  if (!result.ok) {
    issues.push(`call_failed: ${result.error}`);
    return { id: c.id, cat: cat(c.id), pass: false, issues, latencyMs: result.latencyMs };
  }
  const gate = result.body?.safetyGate;
  if (!gate) {
    issues.push("missing safetyGate in response");
    return { id: c.id, cat: cat(c.id), pass: false, issues, latencyMs: result.latencyMs };
  }
  if (expect.redFlag) {
    if (gate.status !== "red_flag") issues.push(`expected red_flag, got ${gate.status}`);
    if (gate.allowDosePrescription !== false) issues.push(`allowDosePrescription should be false`);
    if ((gate.redFlags || []).length === 0) issues.push(`expected ≥1 redFlag, got []`);
  } else {
    if (gate.status === "red_flag") {
      // 边界用例 (SP/部分NG/MIX) 可能合理报红旗,记为软告警
      if (c.id.startsWith("SP") || c.id.startsWith("MIX") || c.id === "NG05" || c.id === "NG07") {
        issues.push(`warn:borderline red_flag: ${(gate.redFlags || []).join("; ")}`);
      } else {
        issues.push(`UNEXPECTED red_flag: ${(gate.redFlags || []).join("; ")}`);
      }
    }
  }
  return {
    id: c.id, cat: cat(c.id), pass: issues.length === 0, issues,
    latencyMs: result.latencyMs,
    gateStatus: gate.status,
    allowDose: gate.allowDosePrescription,
    redFlagCount: (gate.redFlags || []).length,
    missingCount: (gate.missingItems || []).length,
    redFlags: gate.redFlags || [],
    missingItems: gate.missingItems || [],
  };
}

// 简单 worker pool
async function pool(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function run() {
  console.log(`Running ${REDFLAG_MATRIX_100.length} cases against ${BASE_URL}, concurrency=${CONCURRENCY}, timeout=${TIMEOUT_MS}ms\n`);
  let progress = 0;
  let passedSoFar = 0;
  const results = await pool(REDFLAG_MATRIX_100, async (c) => {
    const r = await callRedFlags(c);
    const summary = summarize(c, r);
    progress += 1;
    if (summary.pass) passedSoFar += 1;
    if (progress % 10 === 0 || progress === REDFLAG_MATRIX_100.length) {
      console.log(`  ${progress}/${REDFLAG_MATRIX_100.length} (${passedSoFar} pass)`);
    }
    return summary;
  }, CONCURRENCY);

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
  const latencies = results.map(r => r.latencyMs).filter(Boolean).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length / 2)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const maxLatency = latencies.at(-1) || 0;

  console.log("\n======== 100 条 red-flags 安全门回归 ========");
  console.log(`通过: ${passed}/${total} (${(passed/total*100).toFixed(1)}%)`);
  console.log(`失败: ${failed.length}\n`);
  console.log("--- 按类别 ---");
  for (const [c, st] of Object.entries(byCat).sort()) {
    const rate = (st.pass / st.total * 100).toFixed(0);
    const warnStr = st.warn ? `, ${st.warn} warn` : "";
    console.log(`  ${c}: ${st.pass}/${st.total} (${rate}%${warnStr})`);
  }
  console.log(`\n--- 延迟 ---`);
  console.log(`  p50: ${p50}ms, p95: ${p95}ms, max: ${maxLatency}ms\n`);
  if (failed.length) {
    console.log("--- 失败/告警明细 ---");
    for (const f of failed) {
      console.log(`  ${f.id} (${f.cat}): ${f.issues.join("; ")}`);
    }
  }

  // 输出 JSON 摘要
  const summary = {
    total, passed, failed: failed.length,
    byCat, latency: { p50, p95, max: maxLatency },
    failures: failed.map(f => ({ id: f.id, cat: f.cat, issues: f.issues, gateStatus: f.gateStatus, redFlags: f.redFlags, missingItems: f.missingItems })),
    timestamp: new Date().toISOString(),
  };
  console.log("\nJSON Summary:");
  console.log(JSON.stringify(summary, null, 2));

  if (failed.length > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(2); });
