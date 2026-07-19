// 100+ 条真实 LLM 推理(M03 diagnose + M04 prescribe)
// 跳过 M01/M02,直接给完整 caseState 走 diagnose → 抽签名 → prescribe
// 用法: nohup node scripts/regress-real-100-evaluate.mjs > /tmp/real-100.log 2>&1 &
//
// 结果口径(2026-07 修正):
//   - HTTP 200 本身从不算成功。M03 完整成功 = 200 + 可提取签名 reasoning-v2 + 非签名有限结果。
//   - 签名有限结果(signed-limited: overview.primarySyndromeResolution="unresolved" 且
//     pathogenesis.chain 为空,evidence.source ∈ {服务端M03有限结果门禁, 服务端急危重安全门禁})
//     单独归类,按 fixture expect.m03 判定 reasonable/abnormal,绝不计入完整 M03 成功。
//   - M04 确定性非剂量占位(<!-- CDSS_NON_DOSE_PRESCRIPTION -->)不计入剂量成功,
//     按 fixture expect.m04 判定 reasonable/wrong。
import fs from "node:fs";
import path from "node:path";
import { REDFLAG_MATRIX_100 } from "./fixtures/redflag-matrix-100.mjs";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";
const STREAM_REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";
const NON_DOSE_MARKER = "<!-- CDSS_NON_DOSE_PRESCRIPTION -->";
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
// 现病史必须走真实 CaseState 契约:hisRecord.fields.xianbingshi(见 src/lib/diagnosis-types.ts
// HisRecordSnapshot);normalizeCaseStateInput 会经 mergeHisSymptoms 把它镜像到
// symptoms.presentHistory。顶层 historyPresentIllness 不在 CaseStateInputSchema 中,会被请求
// 归一化静默丢弃(本脚本旧 bug:生成 prompt 与 grounding 上下文只剩主诉,人为制造最劣稀疏输入)。
// chief-only 稀疏探针:fixture hist 为空(BO01/BO02)时不写 hisRecord/symptoms,保留真实稀疏路径覆盖。
const COMPLETE = { level: "C", redFlag: 0.85, infoGain: 0.9, managementImpact: 0.9, answerability: 0.9 };
function toCaseState(c) {
  const hist = (c.hist || "").trim();
  const state = {
    id: c.id,
    phase: "collect",
    patient: { sex: c.sex || "男", age: Number.isFinite(c.age) ? c.age : 45 },
    chiefComplaint: c.chief || "未提供主诉",
    symptoms: hist ? { presentHistory: hist } : {},
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
  if (hist) {
    state.hisRecord = {
      schemaVersion: "tcm-cdss-his-v1",
      source: "tcm-cdss-his",
      caseId: c.id,
      updatedAt: new Date().toISOString(),
      tongueImageUploaded: false,
      fields: { xianbingshi: hist },
      rawText: `【现病史】${hist}`,
    };
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

// ---- 结局判据 ----
const LIMITED_EVIDENCE_SOURCES = new Set(["服务端M03有限结果门禁", "服务端急危重安全门禁"]);

// 签名有限结果:结构化三判据(unresolved + 空病机链 + 服务端门禁证据来源);
// 医生可见表头(信息不足/高风险安全建议模式)作为佐证,防止 source 文案漂移造成漏检。
// 对应 src/lib/diagnosis-safety.ts buildSafetyLimitedDiagnosisReasoning / diagnose route 截断兜底。
function isSignedLimitedDiagnosis(reasoning, content) {
  if (!reasoning || reasoning.stage !== "diagnose") return false;
  const overview = reasoning.overview || {};
  if (overview.primarySyndromeResolution !== "unresolved") return false;
  const chain = reasoning.pathogenesis?.chain;
  if (!Array.isArray(chain) || chain.length > 0) return false;
  return LIMITED_EVIDENCE_SOURCES.has(overview.evidence?.source || "") ||
    content.includes("信息不足建议模式") || content.includes("高风险安全建议模式");
}

// fixture 级期望结局(redflag-matrix-100.mjs 末尾按类别/特例标注;缺省 ordinary active = full+dose)
function expectedOutcomes(c) {
  const m03 = c.expect?.m03;
  const m04 = c.expect?.m04;
  return {
    m03: ["full", "limited", "any"].includes(m03) ? m03 : "full",
    m04: ["dose", "non_dose", "any"].includes(m04) ? m04 : "dose",
  };
}

// 真实剂量内容 = 非确定性占位 + 至少一个 Ng 饮片剂量(服务端 M04 报告药味清单剂量列,如 10g)
function hasRealDoseContent(content) {
  return !content.includes(NON_DOSE_MARKER) && /\d+\s*g/.test(content);
}

// ---- M04 内容统计(best-effort;解析不出的字段一律 null,绝不编造)----
// 优先解析流内 reasoning-v2(stage=prescribe)结构化负载;失败回退医生可见 Markdown
// (# 候选方药 / **方剂出处**: / ### 药味清单 君臣佐使列 / ## 随症加减,见 diagnosis-visible-summary.ts)。
function parseJunHerbsFromMarkdown(content) {
  const tableHeading = content.match(/^###\s*药味清单[^\n]*$/m);
  if (tableHeading) {
    const rest = content.slice(tableHeading.index + tableHeading[0].length);
    const nextHeading = rest.search(/^#{1,6}\s/m);
    const block = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
    const rows = block.split("\n").filter((line) => /^\|\s*\d+\s*\|/.test(line));
    if (rows.length === 0) return null; // 有标题无数据行 → 不可解析
    // 列: | 序号 | 药名 | 炮制/煎服要求 | 剂量 | 君臣佐使 | ...(split 后下标 1..5)
    return rows
      .map((line) => line.split("|").map((cell) => cell.trim()))
      .filter((cells) => cells[5] === "君")
      .map((cells) => cells[2])
      .filter(Boolean);
  }
  // 方义分析兜底:"君药以X、Y为组"
  const roleLine = content.match(/君药以([^，,。；;\n]+?)为组/);
  if (roleLine) {
    const names = roleLine[1].split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
    return names.length > 0 ? names : null;
  }
  return null;
}

function parseM04ContentStats(content) {
  const stats = {
    structured: false,
    formulaSourcePresent: null,  // 方剂出处是否可追溯(true/false;不可解析 null)
    construction: null,          // classical | self_devised | declassified | null
    constructionType: null,      // 结构化原值 single_base/combined/self_devised/single_herb
    modificationsNonEmpty: null, // 随症加减/modifications 是否非空
    junHerbs: null,              // 君药药名数组;负载/表格存在但无君药为 [](如实异常)
  };
  const reasoning = extractStageReasoning(content, "prescribe");
  const candidate = Array.isArray(reasoning?.formula?.candidates) ? reasoning.formula.candidates[0] : null;
  if (candidate && typeof candidate === "object") {
    stats.structured = true;
    const source = candidate.formulaSource?.source;
    stats.formulaSourcePresent = typeof source === "string" && source.trim().length > 0;
    const ct = typeof candidate.constructionType === "string" ? candidate.constructionType : null;
    stats.constructionType = ct;
    if (candidate.identityDeclassified === true) stats.construction = "declassified";
    else if (ct === "single_base" || ct === "combined") stats.construction = "classical";
    else if (ct === "self_devised" || ct === "single_herb") stats.construction = "self_devised";
    const mods = reasoning.formula?.modifications;
    stats.modificationsNonEmpty = Array.isArray(mods) ? mods.length > 0 : null;
    const herbs = Array.isArray(candidate.herbs) ? candidate.herbs : null;
    stats.junHerbs = herbs
      ? herbs.filter((h) => h && h.role === "君" && typeof h.name === "string" && h.name.trim()).map((h) => h.name.trim())
      : null;
    return stats;
  }
  // Markdown 兜底
  const sourceLine = content.match(/\*\*(?:方剂出处|经典方出处|方剂资料收载来源)\*\*[：:]\s*([^\n]+)/);
  if (sourceLine) {
    stats.formulaSourcePresent = sourceLine[1].trim().length > 0;
    stats.construction = "classical";
  } else if (/实际组成未沿用原命名经方身份/.test(content)) {
    stats.construction = "declassified";
  } else if (/\*\*组方依据\*\*|自拟方|自拟候选/.test(content)) {
    stats.formulaSourcePresent = false;
    stats.construction = "self_devised";
  }
  const modHeading = content.match(/^##\s*随[症证]加减[^\n]*$/m);
  if (modHeading) {
    const rest = content.slice(modHeading.index + modHeading[0].length);
    const nextHeading = rest.search(/^#{1,6}\s/m);
    const block = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
    stats.modificationsNonEmpty = block.split("\n").some((line) => /^\s*[-*]\s+\S/.test(line));
  }
  stats.junHerbs = parseJunHerbsFromMarkdown(content);
  return stats;
}

async function runOne(c) {
  const t0 = Date.now();
  const expected = expectedOutcomes(c);
  const hadPresentIllness = Boolean((c.hist || "").trim());
  const state = toCaseState(c);
  const m03 = await callStage("/api/diagnosis/diagnose", state);
  let signedReasoning = null;
  let m04 = null;
  let m04Attempted = false;
  if (m03.status === 200) {
    signedReasoning = extractStageReasoning(m03.content, "diagnose");
    if (signedReasoning) {
      m04Attempted = true;
      const m04state = { ...state, reasoningDiagnose: signedReasoning, phase: "prescribe" };
      m04 = await callStage("/api/diagnosis/prescribe", m04state);
    } else {
      m04 = { status: 0, ms: 0, content: "[NO_SIGNED_REASONING_FROM_M03]", raw: "" };
    }
  } else {
    m04 = { status: 0, ms: 0, content: "[M03_FAILED_SKIP_M04]", raw: "" };
  }
  const totalMs = Date.now() - t0;

  // --- M03 结局分类(HTTP 200 本身不算成功;签名有限结果单独归类)---
  const m03Limited = isSignedLimitedDiagnosis(signedReasoning, m03.content);
  let m03Outcome;
  if (m03.status !== 200) m03Outcome = "http_failed";
  else if (!signedReasoning) m03Outcome = "unsigned_200";
  else if (m03Limited) m03Outcome = "signed_limited";
  else m03Outcome = "full_signed";
  const m03Verdict =
    m03Outcome === "signed_limited"
      ? (expected.m03 === "limited" ? "limited_expected" : expected.m03 === "any" ? "limited_observed" : "limited_abnormal")
      : m03Outcome === "full_signed"
        ? (expected.m03 === "limited" ? "full_when_limited_expected" : "full_signed")
        : m03Outcome;

  // --- M04 结局分类(非剂量占位不算剂量成功;无真实剂量内容不算 validDose)---
  const m04NonDose = m04.status === 200 && m04.content.includes(NON_DOSE_MARKER);
  const m04Dose = m04.status === 200 && hasRealDoseContent(m04.content);
  let m04Outcome;
  if (!m04Attempted) m04Outcome = "not_attempted";
  else if (m04.status !== 200) m04Outcome = "http_failed";
  else if (m04NonDose) m04Outcome = "non_dose";
  else if (m04Dose) m04Outcome = "dose";
  else m04Outcome = "unclassified_200";
  const m04Verdict =
    m04Outcome === "non_dose"
      ? (expected.m04 === "non_dose" ? "non_dose_expected" : expected.m04 === "any" ? "non_dose_observed" : "non_dose_wrong")
      : m04Outcome === "dose"
        ? (expected.m04 === "non_dose" ? "dose_wrong" : "dose_ok")
        : m04Outcome;
  const m04ContentStats = m04.status === 200 ? parseM04ContentStats(m04.content) : null;

  // 保存全文
  const outFile = path.join(OUTPUT_DIR, `${c.id}-full.txt`);
  const text = `=== ${c.id} | ${c.cat || ""} | ${c.notes || c.expect?.notes || ""} ===
病例(简化): 主诉=${(c.chief || "").slice(0,80)} | 现病史=${(c.hist || "").slice(0,200)}${hadPresentIllness ? " (→hisRecord.fields.xianbingshi)" : " (无,chief-only 稀疏探针)"}
生命体征: ${JSON.stringify(c.vitals || {})}
期望: ${c.expect?.redFlag ? "RED_FLAG" : "no_flag"} m03=${expected.m03} m04=${expected.m04} ${c.expect?.notes || ""}
判定: m03=${m03Outcome}/${m03Verdict} m04=${m04Outcome}/${m04Verdict}

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
    expected,
    hadPresentIllness,
    m03Outcome, m03Verdict, m03Limited,
    m04Attempted, m04Outcome, m04Verdict,
    m04ContentStats,
    expect: c.expect,
    m03HasFormula: m03.content.includes("方") && (m03.content.includes("汤") || m03.content.includes("丸") || m03.content.includes("散")),
    m04HasFormula: m04.content.includes("方") && (m04.content.includes("汤") || m04.content.includes("丸") || m04.content.includes("散")),
    m04HasHerbs: /(\d+)\s*g/.test(m04.content),
    m04NonDose,
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
      const ok = results.filter(Boolean).filter(r => r.m03Outcome === "full_signed").length;
      console.log(`[${done}/${items.length}] ${items[i].id} done | m03=${results[i].m03Status}:${results[i].m03Outcome || "-"}/${results[i].m03Ms}ms m04=${results[i].m04Status}:${results[i].m04Outcome || "-"}/${results[i].m04Ms}ms | running fullSigned=${ok} | total ${results[i].totalMs}ms`);
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

// ============ Summary(HTTP 200 从不单独算成功;按 fixture 期望结局分流)============
const total = results.length;
const count = (fn) => results.filter(fn).length;
// --- M03 ---
const m03HttpOk = count(r => r.m03Status === 200);
const m03Signed = count(r => r.signed);
const m03FullSigned = count(r => r.m03Outcome === "full_signed");
const m03Limited = count(r => r.m03Outcome === "signed_limited");
const m03LimitedReasonable = count(r => r.m03Verdict === "limited_expected");
const m03LimitedAbnormal = count(r => r.m03Verdict === "limited_abnormal");
const m03LimitedObservedAny = count(r => r.m03Verdict === "limited_observed"); // expect=any,不计异常
const m03FullWhenLimitedExpected = count(r => r.m03Verdict === "full_when_limited_expected"); // historical/stable 拦截未命中
const m03Unsigned200 = count(r => r.m03Outcome === "unsigned_200");
const m03Failed = results.filter(r => r.m03Status !== 200);
// --- M04 ---
const m04Attempted = count(r => r.m04Attempted);
const m04HttpOk = count(r => r.m04Status === 200);
const m04Dose = count(r => r.m04Outcome === "dose");
const m04NonDose = count(r => r.m04Outcome === "non_dose");
const m04Unclassified = count(r => r.m04Outcome === "unclassified_200");
const m04ValidDose = count(r => r.m04Verdict === "dose_ok"); // 真实剂量内容 且 期望 ∈ {dose, any}
const m04DoseWrong = count(r => r.m04Verdict === "dose_wrong"); // 期望非剂量却给了剂量(拦截块漏检)
const m04NonDoseReasonable = count(r => r.m04Verdict === "non_dose_expected");
const m04NonDoseObservedAny = count(r => r.m04Verdict === "non_dose_observed"); // expect=any,不计异常
const m04NonDoseWrong = count(r => r.m04Verdict === "non_dose_wrong"); // 期望剂量却被降级(过度拦截/截断)
const m04Failed = results.filter(r => r.m04Attempted && r.m04Status !== 200);
// --- 旧口径字段(兼容历史看板;不再作为成功判据)---
const withFormula = results.filter(r => r.m04HasFormula);
const withHerbs = results.filter(r => r.m04HasHerbs);
const withErrors = results.filter(r => (r.errorTags || []).length > 0);
// --- 时延 ---
const percentile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : 0;
};
const latency = {
  m03P50: percentile(results.map(r => r.m03Ms), 0.5),
  m03P95: percentile(results.map(r => r.m03Ms), 0.95),
  totalP50: percentile(results.map(r => r.totalMs), 0.5),
  totalP95: percentile(results.map(r => r.totalMs), 0.95),
};
// --- M04 内容统计(分母 = 该字段可解析(non-null)例数,解析不出不计入也不编造)---
const rate = (num, den) => (den > 0 ? Number((num / den).toFixed(4)) : null);
const m04ContentCases = results.filter(r => r.m04ContentStats);
const stat = (fn) => m04ContentCases.filter(fn);
const structuredParsed = stat(r => r.m04ContentStats.structured).length;
const sourceParsed = stat(r => r.m04ContentStats.formulaSourcePresent !== null);
const sourcePresent = sourceParsed.filter(r => r.m04ContentStats.formulaSourcePresent === true).length;
const constructionParsed = stat(r => r.m04ContentStats.construction !== null);
const classicalCount = constructionParsed.filter(r => r.m04ContentStats.construction === "classical").length;
const selfDevisedCount = constructionParsed.filter(r => r.m04ContentStats.construction === "self_devised").length;
const declassifiedCount = constructionParsed.filter(r => r.m04ContentStats.construction === "declassified").length;
const modsParsed = stat(r => r.m04ContentStats.modificationsNonEmpty !== null);
const modsNonEmpty = modsParsed.filter(r => r.m04ContentStats.modificationsNonEmpty === true).length;
const junParsed = stat(r => Array.isArray(r.m04ContentStats.junHerbs));
const junCounts = {};
for (const r of junParsed) for (const name of r.m04ContentStats.junHerbs) junCounts[name] = (junCounts[name] || 0) + 1;
const m04Content = {
  casesWithM04Content: m04ContentCases.length,
  structuredParsed,
  formulaSource: { parsed: sourceParsed.length, present: sourcePresent, presentRate: rate(sourcePresent, sourceParsed.length) },
  construction: {
    parsed: constructionParsed.length,
    classical: classicalCount,
    selfDevised: selfDevisedCount,
    declassified: declassifiedCount,
    classicalRate: rate(classicalCount, constructionParsed.length),
    selfDevisedRate: rate(selfDevisedCount, constructionParsed.length),
  },
  modifications: { parsed: modsParsed.length, nonEmpty: modsNonEmpty, nonEmptyRate: rate(modsNonEmpty, modsParsed.length) },
  junHerbs: {
    parsed: junParsed.length,
    distinct: Object.keys(junCounts).length,
    top: Object.entries(junCounts).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, n]) => ({ name, count: n })),
  },
};
// --- 按类别 ---
const byCat = {};
for (const r of results) {
  byCat[r.cat] = byCat[r.cat] || { total: 0, m03FullSigned: 0, m03Limited: 0, m03LimitedAbnormal: 0, m04Dose: 0, m04NonDose: 0, m04NonDoseWrong: 0, m04DoseWrong: 0 };
  const st = byCat[r.cat];
  st.total += 1;
  if (r.m03Outcome === "full_signed") st.m03FullSigned += 1;
  if (r.m03Outcome === "signed_limited") st.m03Limited += 1;
  if (r.m03Verdict === "limited_abnormal") st.m03LimitedAbnormal += 1;
  if (r.m04Outcome === "dose") st.m04Dose += 1;
  if (r.m04Outcome === "non_dose") st.m04NonDose += 1;
  if (r.m04Verdict === "non_dose_wrong") st.m04NonDoseWrong += 1;
  if (r.m04Verdict === "dose_wrong") st.m04DoseWrong += 1;
}
const limitedAbnormalCases = results.filter(r => r.m03Verdict === "limited_abnormal");
const fullWhenLimitedCases = results.filter(r => r.m03Verdict === "full_when_limited_expected");
const nonDoseWrongCases = results.filter(r => r.m04Verdict === "non_dose_wrong");
const doseWrongCases = results.filter(r => r.m04Verdict === "dose_wrong");

console.log("\n\n========= 真实推理总结(新口径:HTTP 200 ≠ 成功) =========");
console.log(`总耗时: ${totalElapsed.toFixed(1)}s (${(totalElapsed/60).toFixed(1)}min)`);
console.log(`M03: 完整签名 ${m03FullSigned}/${total} | 签名有限 ${m03Limited} (合理 ${m03LimitedReasonable} / 异常 ${m03LimitedAbnormal} / 观察 ${m03LimitedObservedAny}) | 200未签名 ${m03Unsigned200} | HTTP失败 ${m03Failed.length}`);
console.log(`     期望 limited 却出完整结果(historical/stable 拦截未命中): ${m03FullWhenLimitedExpected}`);
console.log(`M04: 真实剂量 ${m04Dose}/${m04Attempted} attempted (validDose ${m04ValidDose} / doseWrong ${m04DoseWrong}) | 非剂量 ${m04NonDose} (合理 ${m04NonDoseReasonable} / 异常 ${m04NonDoseWrong} / 观察 ${m04NonDoseObservedAny}) | 未分类200 ${m04Unclassified} | HTTP失败 ${m04Failed.length}`);
console.log(`M04 内容: 出处可追溯 ${sourcePresent}/${sourceParsed.length} (${rate(sourcePresent, sourceParsed.length) ?? "-"}) | 经典方 ${classicalCount} / 自拟 ${selfDevisedCount} / 身份降级 ${declassifiedCount} / 未知 ${m04ContentCases.length - constructionParsed.length}`);
console.log(`M04 内容: 随症加减非空 ${modsNonEmpty}/${modsParsed.length} | 君药可解析 ${junParsed.length} 例 ${Object.keys(junCounts).length} 味,top: ${m04Content.junHerbs.top.slice(0, 8).map(t => `${t.name}×${t.count}`).join(" ") || "-"}`);
console.log(`结构化负载解析: ${structuredParsed}/${m04ContentCases.length} | 流式错误标记: ${withErrors.length}`);
console.log(`旧口径参考: M03 200=${m03HttpOk} M04 200=${m04HttpOk} 含方剂=${withFormula.length} 含剂量g=${withHerbs.length}`);
console.log(`平均单条耗时: ${(totalElapsed/total).toFixed(1)}s`);
console.log(`M03 p50/p95: ${latency.m03P50}ms / ${latency.m03P95}ms`);
console.log(`全链 p50/p95: ${latency.totalP50}ms / ${latency.totalP95}ms`);

console.log("\n--- 按类别 ---");
for (const [c, st] of Object.entries(byCat).sort()) {
  console.log(`  ${c}: M03完整 ${st.m03FullSigned}/${st.total} | M03有限 ${st.m03Limited}(异常${st.m03LimitedAbnormal}) | M04剂量 ${st.m04Dose} 非剂量 ${st.m04NonDose}(错${st.m04NonDoseWrong}) | doseWrong ${st.m04DoseWrong}`);
}

if (m03Failed.length) {
  console.log("\n--- M03 HTTP 失败明细 ---");
  for (const r of m03Failed.slice(0, 20)) console.log(`  ${r.id}: status=${r.m03Status} err=${r.errorTags?.join(",") || ""}`);
}
if (m04Failed.length) {
  console.log("\n--- M04 HTTP 失败明细 ---");
  for (const r of m04Failed.slice(0, 20)) console.log(`  ${r.id}: status=${r.m04Status} err=${r.errorTags?.join(",") || ""}`);
}
if (limitedAbnormalCases.length) {
  console.log("\n--- M03 签名有限-异常(期望完整却被降级) ---");
  for (const r of limitedAbnormalCases.slice(0, 30)) console.log(`  ${r.id} (${r.cat}) expected=${r.expected.m03}/${r.expected.m04}`);
}
if (fullWhenLimitedCases.length) {
  console.log("\n--- M03 期望 limited 却出完整(拦截未命中) ---");
  for (const r of fullWhenLimitedCases.slice(0, 30)) console.log(`  ${r.id} (${r.cat})`);
}
if (nonDoseWrongCases.length) {
  console.log("\n--- M04 非剂量-异常(期望剂量却被降级) ---");
  for (const r of nonDoseWrongCases.slice(0, 30)) console.log(`  ${r.id} (${r.cat}) m03=${r.m03Outcome}`);
}
if (doseWrongCases.length) {
  console.log("\n--- M04 剂量-异常(期望非剂量却给了剂量) ---");
  for (const r of doseWrongCases.slice(0, 30)) console.log(`  ${r.id} (${r.cat}) m03=${r.m03Outcome}`);
}

// Save JSON summary
const summaryFile = path.join(OUTPUT_DIR, "_summary.json");
fs.writeFileSync(summaryFile, JSON.stringify({
  totalElapsed, total,
  outcomes: {
    m03: {
      httpOk: m03HttpOk,
      signed: m03Signed,
      fullSigned: m03FullSigned,
      limited: m03Limited,
      limitedReasonable: m03LimitedReasonable,
      limitedAbnormal: m03LimitedAbnormal,
      limitedObservedAny: m03LimitedObservedAny,
      fullWhenLimitedExpected: m03FullWhenLimitedExpected,
      unsigned200: m03Unsigned200,
      httpFailed: m03Failed.length,
    },
    m04: {
      attempted: m04Attempted,
      notAttempted: total - m04Attempted,
      httpOk: m04HttpOk,
      dose: m04Dose,
      nonDose: m04NonDose,
      unclassified200: m04Unclassified,
      validDose: m04ValidDose,
      doseWrong: m04DoseWrong,
      nonDoseReasonable: m04NonDoseReasonable,
      nonDoseObservedAny: m04NonDoseObservedAny,
      nonDoseWrong: m04NonDoseWrong,
      httpFailed: m04Failed.length,
    },
  },
  latency,
  m04Content,
  sparseProbeCases: results.filter(r => !r.hadPresentIllness).map(r => r.id),
  // 旧口径字段(兼容历史看板/脚本;不作为成功判据)
  m03Ok: m03HttpOk, m04Ok: m04HttpOk,
  withFormula: withFormula.length, withHerbs: withHerbs.length,
  nonDose: m04NonDose,
  byCat, results,
  timestamp: new Date().toISOString(),
}, null, 2));
console.log(`\nSummary → ${summaryFile}`);
console.log(`Per-case full text → ${OUTPUT_DIR}/<case-id>-full.txt`);
