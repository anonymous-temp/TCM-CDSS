// 100 条真实 LLM 推理(M03 diagnose + M04 prescribe)
// 跳过 M01/M02,直接给完整 caseState 走 diagnose → 抽签名 → prescribe
// 用法: nohup node scripts/regress-real-100-evaluate.mjs > /tmp/real-100.log 2>&1 &
import fs from "node:fs";
import path from "node:path";
import { REDFLAG_MATRIX_100 } from "./fixtures/redflag-matrix-100.mjs";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";
const STREAM_REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const OUTPUT_DIR = process.env.OUTPUT_DIR || "/tmp/cdss-real-100";
const SELECTED_IDS = new Set((process.env.REAL100_CASES || "").split(",").map((id) => id.trim()).filter(Boolean));
const CASES = SELECTED_IDS.size > 0
  ? REDFLAG_MATRIX_100.filter((testCase) => SELECTED_IDS.has(testCase.id))
  : REDFLAG_MATRIX_100;
if (SELECTED_IDS.size > 0 && CASES.length !== SELECTED_IDS.size) {
  const known = new Set(CASES.map((testCase) => testCase.id));
  const unknown = [...SELECTED_IDS].filter((id) => !known.has(id));
  throw new Error(`Unknown REAL100_CASES: ${unknown.join(",")}`);
}
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function extractStageReasoning(content, stage) {
  const start = content.lastIndexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return null;
  try {
    const r = JSON.parse(content.slice(start + START_MARKER.length, end).trim());
    if (r?.schemaVersion === "tcm-cdss-reasoning-v2" && r.stage === stage) return r;
  } catch {}
  return null;
}

async function callStage(pathname, caseState) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300000); // 5 分钟超时
  try {
    const res = await fetch(`${BASE_URL}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
      body: JSON.stringify({ caseState }),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    const ms = Date.now() - t0;
    let content = "";
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    if (json && typeof json === "object" && !Array.isArray(json) && (json.section || json.followup || json.error)) {
      content = json.section || json.followup || json.error || "";
    } else {
      for (const line of raw.split("\n")) {
        const s = line.trim();
        if (!s) continue;
        try {
          const o = JSON.parse(s);
          if (typeof o.content === "string" && o.content !== "[END]") content += o.content;
          if (o.error) content += `\n[STREAM_ERROR] ${o.error}\n`;
        } catch {}
      }
      const mi = content.lastIndexOf(STREAM_REPLACE_MARKER);
      if (mi >= 0) content = content.slice(mi + STREAM_REPLACE_MARKER.length);
    }
    return { status: res.status, ms, content, raw: raw.slice(0, 500) };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, content: `[FETCH_ERROR] ${e.message}`, raw: "" };
  } finally {
    clearTimeout(timer);
  }
}

// 把 redflag-matrix-100 (chief/hist/vitals/expect) 扩展成完整 caseState
const COMPLETE = { level: "C", redFlag: 0.85, infoGain: 0.9, managementImpact: 0.9, answerability: 0.9 };
function toCaseState(c) {
  const state = {
    id: c.id,
    phase: "collect",
    patient: { sex: "男", age: 45 },
    chiefComplaint: c.chief || "未提供主诉",
    historyPresentIllness: c.hist || "",
    pastHistory: "无特殊可记录。",
    allergyHistory: "否认药物食物过敏。",
    medicationHistory: "否认当前用药。",
    tongue: "舌淡红,苔薄白",
    pulse: "细平",
    faceNote: "面色如常",
    completeness: COMPLETE,
    conversation: [],
    diagnosis: "",
    prescription: "",
    riskAssessment: "",
  };
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

async function runOne(c) {
  const t0 = Date.now();
  const state = toCaseState(c);
  const m03 = await callStage("/api/diagnosis/diagnose", state);
  let signedReasoning = null;
  let m04 = null;
  if (m03.status === 200) {
    signedReasoning = extractStageReasoning(m03.content, "diagnose");
    if (signedReasoning) {
      const m04state = { ...state, reasoningDiagnose: signedReasoning, phase: "prescribe" };
      m04 = await callStage("/api/diagnosis/prescribe", m04state);
    } else {
      m04 = { status: 0, ms: 0, content: "[NO_SIGNED_REASONING_FROM_M03]", raw: "" };
    }
  } else {
    m04 = { status: 0, ms: 0, content: "[M03_FAILED_SKIP_M04]", raw: "" };
  }
  const totalMs = Date.now() - t0;
  // 保存全文
  const outFile = path.join(OUTPUT_DIR, `${c.id}-full.txt`);
  const text = `=== ${c.id} | ${c.cat || ""} | ${c.notes || ""} ===
病例(简化): 主诉=${(c.chief || "").slice(0,80)} | 现病史=${(c.hist || "").slice(0,200)}
生命体征: ${JSON.stringify(c.vitals || {})}
期望: ${c.expect?.redFlag ? "RED_FLAG" : "no_flag"} ${c.expect?.notes || ""}

--- M03 辨病辨证 (status=${m03.status} ms=${m03.ms}) ---
${m03.content}

--- M04 候选方药 (status=${m04.status} ms=${m04.ms}) ---
${m04.content}
`;
  fs.writeFileSync(outFile, text);
  return {
    id: c.id, cat: c.cat || c.id.slice(0,2),
    m03Status: m03.status, m03Ms: m03.ms, m03Len: m03.content.length,
    m04Status: m04.status, m04Ms: m04.ms, m04Len: m04.content.length,
    totalMs,
    signed: !!signedReasoning,
    expect: c.expect,
    m03HasFormula: m03.content.includes("方") && (m03.content.includes("汤") || m03.content.includes("丸") || m03.content.includes("散")),
    m04HasFormula: m04.content.includes("方") && (m04.content.includes("汤") || m04.content.includes("丸") || m04.content.includes("散")),
    m04HasHerbs: /(\d+)\s*g/.test(m04.content),
    m04NonDose: m04.content.includes("<!-- CDSS_NON_DOSE_PRESCRIPTION -->"),
    errorTags: [m03.content, m04.content].flatMap(t => (t.match(/\[(STREAM_ERROR|FETCH_ERROR|NO_SIGNED|TRUNCATED|M03_FAILED)\]/g) || [])),
  };
}

// 并发 worker pool
async function pool(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { id: items[i].id, error: e.message };
      }
      done += 1;
      const ok = results.filter(Boolean).filter(r => r.m03Status === 200).length;
      console.log(`[${done}/${items.length}] ${items[i].id} done | m03=${results[i].m03Status}/${results[i].m03Ms}ms m04=${results[i].m04Status}/${results[i].m04Ms}ms | running ok=${ok} | total ${results[i].totalMs}ms`);
    }
  });
  await Promise.all(runners);
  return results;
}

console.log(`BASE_URL=${BASE_URL} CONCURRENCY=${CONCURRENCY} OUTPUT_DIR=${OUTPUT_DIR}`);
console.log(`Running ${CASES.length} cases M03+M04...\n`);
const t0 = Date.now();
const results = await pool(CASES, runOne, CONCURRENCY);
const totalElapsed = (Date.now() - t0) / 1000;

// Summary
const total = results.length;
const m03Ok = results.filter(r => r.m03Status === 200).length;
const m04Ok = results.filter(r => r.m04Status === 200).length;
const m03Fail = results.filter(r => r.m03Status !== 200);
const m04Fail = results.filter(r => r.m03Status === 200 && r.m04Status !== 200);
const withFormula = results.filter(r => r.m04HasFormula);
const withHerbs = results.filter(r => r.m04HasHerbs);
const nonDose = results.filter(r => r.m04NonDose);
const withErrors = results.filter(r => r.errorTags.length > 0);
const percentile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : 0;
};
const m03Latencies = results.map(r => r.m03Ms);
const totalLatencies = results.map(r => r.totalMs);
const latency = {
  m03P50: percentile(m03Latencies, 0.5),
  m03P95: percentile(m03Latencies, 0.95),
  totalP50: percentile(totalLatencies, 0.5),
  totalP95: percentile(totalLatencies, 0.95),
};

console.log("\n\n========= 100 条真实推理总结 =========");
console.log(`总耗时: ${totalElapsed.toFixed(1)}s (${(totalElapsed/60).toFixed(1)}min)`);
console.log(`M03 成功: ${m03Ok}/${total} (${(m03Ok/total*100).toFixed(0)}%)`);
console.log(`M04 成功: ${m04Ok}/${total} (${(m04Ok/total*100).toFixed(0)}%)`);
console.log(`M04 含方剂: ${withFormula.length}/${total}`);
console.log(`M04 含剂量(g): ${withHerbs.length}/${total}`);
console.log(`M04 明确非剂量: ${nonDose.length}/${total}`);
console.log(`流式错误标记: ${withErrors.length}`);
console.log(`平均单条耗时: ${(totalElapsed/total).toFixed(1)}s`);
console.log(`M03 p50/p95: ${latency.m03P50}ms / ${latency.m03P95}ms`);
console.log(`全链 p50/p95: ${latency.totalP50}ms / ${latency.totalP95}ms`);

console.log("\n--- 按类别 ---");
const byCat = {};
for (const r of results) {
  byCat[r.cat] = byCat[r.cat] || { total: 0, m03ok: 0, m04ok: 0, formula: 0 };
  byCat[r.cat].total += 1;
  if (r.m03Status === 200) byCat[r.cat].m03ok += 1;
  if (r.m04Status === 200) byCat[r.cat].m04ok += 1;
  if (r.m04HasFormula) byCat[r.cat].formula += 1;
}
for (const [c, st] of Object.entries(byCat).sort()) {
  console.log(`  ${c}: M03 ${st.m03ok}/${st.total} | M04 ${st.m04ok}/${st.total} | 含方剂 ${st.formula}`);
}

if (m03Fail.length) {
  console.log("\n--- M03 失败明细 ---");
  for (const r of m03Fail.slice(0, 20)) console.log(`  ${r.id}: status=${r.m03Status} err=${r.errorTags?.join(",") || ""}`);
}
if (m04Fail.length) {
  console.log("\n--- M04 失败明细 ---");
  for (const r of m04Fail.slice(0, 20)) console.log(`  ${r.id}: status=${r.m04Status} err=${r.errorTags?.join(",") || ""}`);
}

// Save JSON summary
const summaryFile = path.join(OUTPUT_DIR, "_summary.json");
fs.writeFileSync(summaryFile, JSON.stringify({
  totalElapsed, total, m03Ok, m04Ok, withFormula: withFormula.length, withHerbs: withHerbs.length,
  nonDose: nonDose.length,
  latency, byCat, results,
  timestamp: new Date().toISOString(),
}, null, 2));
console.log(`\nSummary → ${summaryFile}`);
console.log(`Per-case full text → ${OUTPUT_DIR}/<case-id>-full.txt`);
