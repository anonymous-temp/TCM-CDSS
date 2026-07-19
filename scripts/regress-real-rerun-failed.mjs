// 重跑 30 条失败的(MI/OK/TR 全部 + BO 部分)
import fs from "node:fs";
import path from "node:path";
import { REDFLAG_MATRIX_100 } from "./fixtures/redflag-matrix-100.mjs";

const BASE_URL = "http://127.0.0.1:3000";
const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";
const STREAM_REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";
const OUTPUT_DIR = "/tmp/cdss-real-100";

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
  const timer = setTimeout(() => ctrl.abort(), 300000);
  try {
    const res = await fetch(`${BASE_URL}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

const COMPLETE = { level: "C", redFlag: 0.85, infoGain: 0.9, managementImpact: 0.9, answerability: 0.9 };
function toCaseState(c) {
  const state = {
    id: c.id, phase: "collect", patient: { sex: c.sex || "男", age: c.age ?? 45 },
    chiefComplaint: c.chief || "未提供主诉",
    pastHistory: "无特殊可记录。",
    allergyHistory: "否认药物食物过敏。",
    medicationHistory: "否认当前用药。",
    tongue: "舌淡红,苔薄白", pulse: "细平", faceNote: "面色如常",
    completeness: COMPLETE, conversation: [], diagnosis: "", prescription: "", riskAssessment: "",
  };
  // 现病史的真实承载字段是 hisRecord.fields.xianbingshi（另镜像到 symptoms.presentHistory）；
  // 不存在 historyPresentIllness 字段，写入它会被请求归一化静默丢弃。
  if (c.hist) {
    state.hisRecord = {
      schemaVersion: "tcm-cdss-his-v1",
      source: "tcm-cdss-his",
      caseId: c.id,
      fields: { xianbingshi: c.hist },
      rawText: c.hist,
    };
    state.symptoms = { presentHistory: c.hist };
  }
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

// 找出失败的(检查每个 file 是否含 FETCH_ERROR)
const failed = [];
for (const c of REDFLAG_MATRIX_100) {
  const f = path.join(OUTPUT_DIR, `${c.id}-full.txt`);
  if (!fs.existsSync(f)) { failed.push(c); continue; }
  const content = fs.readFileSync(f, "utf8");
  if (content.includes("[FETCH_ERROR]") || content.includes("[STREAM_ERROR]")) {
    failed.push(c);
  }
}
console.log(`重跑 ${failed.length} 条失败用例...`);

async function pool(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); } catch (e) { results[i] = { id: items[i].id, error: e.message }; }
      done += 1;
      console.log(`[${done}/${items.length}] ${items[i].id} m03=${results[i].m03Status}/${results[i].m03Ms}ms m04=${results[i].m04Status}/${results[i].m04Ms}ms`);
    }
  });
  await Promise.all(runners);
  return results;
}

async function runOne(c) {
  const state = toCaseState(c);
  const m03 = await callStage("/api/diagnosis/diagnose", state);
  let signedReasoning = null;
  let m04 = null;
  if (m03.status === 200) {
    signedReasoning = extractStageReasoning(m03.content, "diagnose");
    if (signedReasoning) {
      m04 = await callStage("/api/diagnosis/prescribe", { ...state, reasoningDiagnose: signedReasoning, phase: "prescribe" });
    } else {
      m04 = { status: 0, ms: 0, content: "[NO_SIGNED_REASONING_FROM_M03]", raw: "" };
    }
  } else {
    m04 = { status: 0, ms: 0, content: "[M03_FAILED_SKIP_M04]", raw: "" };
  }
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
  };
}

const results = await pool(failed, runOne, 3);
const m03Ok = results.filter(r => r.m03Status === 200).length;
const m04Ok = results.filter(r => r.m04Status === 200).length;
console.log(`\n重跑完成: M03 ${m03Ok}/${failed.length}, M04 ${m04Ok}/${failed.length}`);
