/**
 * 公开网络医案端到端评测（50 份）。
 *
 * 与 regress-customer-test-cases 的差别：甲方 10 例是标准化表单录入；这里是真实医案的
 * 自由文本，病名/证型用的是各家习惯写法（"肝气克脾犯胃""饮犯胸阳"），且覆盖疑难与
 * 古典病名（悬饮、瘾疹、项痹）。因此它测的是**术语治理与召回的覆盖广度**，
 * 而不只是流程是否跑通。
 *
 * 判分口径与甲方套件一致：病名按包含关系、证型按 2-gram 要素覆盖率——医案的证型写法
 * 本就百家争鸣，全等比对没有意义。
 *
 * 用法：BASE_URL=http://127.0.0.1:3000 node scripts/regress-web-cases.mjs
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const SOURCE = process.env.WEB_CASES_FILE || "artifacts/web-cases-50.json";
const ARTIFACT_DIR = process.env.WEB_CASES_DIR || "artifacts/web-cases-run";
const ONLY = new Set((process.env.WEB_CASES || "").split(",").map((s) => s.trim()).filter(Boolean));
const STREAM_REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";

async function post(route, body, timeoutMs = 300_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${BASE_URL}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
      body: JSON.stringify(body), signal: controller.signal,
    });
    const raw = await res.text();
    return { status: res.status, ms: Date.now() - startedAt, raw };
  } catch (error) {
    return { status: 0, ms: Date.now() - startedAt, raw: "", error: String(error?.message || error) };
  } finally { clearTimeout(timer); }
}

function ndjson(raw) {
  let content = ""; const errors = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.content === "string" && parsed.content !== "[END]") content += parsed.content;
      if (typeof parsed.error === "string") errors.push(parsed.error);
    } catch { /* 非 NDJSON 帧 */ }
  }
  const marker = content.lastIndexOf(STREAM_REPLACE_MARKER);
  return {
    visible: marker >= 0 ? content.slice(marker + STREAM_REPLACE_MARKER.length) : content,
    // 模型原始正文（被最终替换掉的那段）。0 味时唯一能回答「模型到底写了什么、
    // 哪条合同判死的」的证据；不留就只能看到降级文案，没法归因。
    generated: marker >= 0 ? content.slice(0, marker) : "",
    ended: raw.includes('"[END]"'),
    errors,
  };
}

function sentinel(text) {
  const block = text.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/);
  if (!block) return null;
  try { return JSON.parse(block[1]); } catch { return null; }
}

/** 证型判分：按 2-gram 要素覆盖率，不做全等（医案证型写法各家不同）。 */
function syndromeAgreement(expected, actual) {
  if (!actual) return { score: 0, missed: [] };
  const norm = (s) => String(s || "").replace(/[证候（）()\s，,、。]/g, "");
  const e = norm(expected); const a = norm(actual);
  const grams = new Set();
  for (let i = 0; i + 2 <= e.length; i += 1) grams.add(e.slice(i, i + 2));
  const matched = [...grams].filter((g) => a.includes(g));
  return {
    score: grams.size === 0 ? 0 : Number((matched.length / grams.size).toFixed(2)),
    missed: [...grams].filter((g) => !matched.includes(g)),
  };
}

function caseStateOf(entry) {
  const rawText = [
    `患者${entry.sex}，${entry.age}岁。`,
    `主诉：${entry.chiefComplaint}。`,
    `现病史：${entry.presentHistory}。`,
    entry.tongue ? `舌象：${entry.tongue}。` : "",
    entry.pulse ? `脉象：${entry.pulse}。` : "",
  ].filter(Boolean).join("");
  return {
    // 签名绑定项，必须稳定：缺失会让 M04 拿不到有效 M03 签名。
    id: `web-case-${entry.no}`,
    phase: "collect",
    patient: { sex: entry.sex === "男" ? "男" : "女", age: String(entry.age), occupation: "" },
    chiefComplaint: entry.chiefComplaint,
    hisRecord: {
      source: "manual",
      encounterId: `web-${entry.no}`,
      rawText,
      fields: {
        zhushu: entry.chiefComplaint,
        xianbingshi: entry.presentHistory,
        jiwangshi: "",
        guomingshi: "",
        yongyaoshi: "",
        tizheng: "",
      },
      collectedAt: new Date(0).toISOString(),
    },
    tongue: entry.tongue || "",
    pulse: entry.pulse || "",
    faceNote: "",
    pastHistory: "", medicationHistory: "", allergyHistory: "",
    completeness: { level: "A", redFlag: 0.3, infoGain: 0.3, managementImpact: 0.3, answerability: 0.3 },
    conversation: [], diagnosis: "", prescription: "", riskAssessment: "",
    questionRounds: 0, maxQuestionRounds: 2,
  };
}

const source = JSON.parse(await fs.readFile(SOURCE, "utf8"));
const selected = source.cases.filter((c) => ONLY.size === 0 || ONLY.has(String(c.no)));
await fs.mkdir(ARTIFACT_DIR, { recursive: true });
const summary = [];

// 并发跑例。串行 50 例 = 纯模型时延累加（实测 94 分钟），例与例之间无共享状态，
// 唯一的共享约束是服务端模型限流（CDSS_MODEL_RATE_LIMIT_PER_10_MIN，默认 60/10min）：
// 每例约 5-8 次模型调用，4 并发≈14 次/分钟，本地测试服务器需将该上限调高（wrapper 里设）。
// 默认 1 保持旧行为，避免误伤生产限流。
const CONCURRENCY = Math.max(1, Number(process.env.WEB_CASES_CONCURRENCY || "1") || 1);

async function runCase(entry) {
  process.stderr.write(`[web] ${entry.no}. ${entry.tcmDisease}-${entry.syndrome} …\n`);
  let base = caseStateOf(entry);
  // 与产品客户端一致：先做语义红旗预检并回传，避免各阶段重复预检。
  const rf = await post("/api/diagnosis/red-flags", { caseState: base }, 90_000);
  try {
    const parsed = JSON.parse(rf.raw);
    if (rf.status === 200 && parsed?.clinicalFacts) base = { ...base, clinicalFacts: parsed.clinicalFacts };
  } catch { /* 预检不可用时按产品语义继续 */ }

  const record = { ...entry, stages: {} };
  const answered = {
    ...base, phase: "diagnose", questionRounds: 1,
    completeness: { level: "C", redFlag: 0.85, infoGain: 0.9, managementImpact: 0.9, answerability: 0.9 },
  };
  const diagnose = await post("/api/diagnosis/diagnose", { caseState: answered });
  const d = ndjson(diagnose.raw);
  const reasoningDiagnose = sentinel(d.visible);
  record.stages.diagnose = { status: diagnose.status, ms: diagnose.ms, errors: d.errors, reasoning: reasoningDiagnose, visible: d.visible };

  if (reasoningDiagnose) {
    const prescribeState = { ...answered, phase: "prescribe", diagnosis: d.visible, reasoningDiagnose };
    const prescribe = await post("/api/diagnosis/prescribe", { caseState: prescribeState });
    const p = ndjson(prescribe.raw);
    const reasoningPrescribe = sentinel(p.visible);
    record.stages.prescribe = {
      status: prescribe.status, ms: prescribe.ms, errors: p.errors,
      reasoning: reasoningPrescribe, visible: p.visible,
      // 只在 0 味时留模型原文：出方成功不需要它，失败时它是唯一的归因证据。
      generated: /^\| *\d+ *\|/m.test(p.visible) ? "" : p.generated.slice(0, 24_000),
    };
    const assess = await post("/api/diagnosis/assess", {
      caseState: { ...prescribeState, phase: "assess", prescription: p.visible, reasoningPrescribe },
    });
    const a = ndjson(assess.raw);
    record.stages.assess = { status: assess.status, ms: assess.ms, errors: a.errors };
  }

  await fs.writeFile(path.join(ARTIFACT_DIR, `case-${entry.no}.json`), JSON.stringify(record, null, 2));

  const overview = reasoningDiagnose?.overview;
  const candidate = record.stages.prescribe?.reasoning?.formula?.candidates?.[0];
  const agreement = syndromeAgreement(entry.syndrome, overview?.primarySyndrome);
  const row = {
    no: entry.no,
    expectedDisease: entry.tcmDisease, actualDisease: overview?.tcmDiseaseName || null,
    diseaseHit: Boolean(overview?.tcmDiseaseName && (
      overview.tcmDiseaseName.includes(entry.tcmDisease) || entry.tcmDisease.includes(overview.tcmDiseaseName))),
    expectedSyndrome: entry.syndrome, actualSyndrome: overview?.primarySyndrome || null,
    syndromeScore: agreement.score,
    expectedFormula: entry.formula,
    lockedFormulas: overview?.recommendedFormulaNames || [],
    herbCount: Array.isArray(candidate?.herbs) ? candidate.herbs.length : 0,
    // 0 味不都是缺陷。网络医案 11（头痛30年 + 呕吐 + 视物重影）是颅内压增高三联征，
    // 安全门拒绝出剂量方是**正确**的临床行为；把它和「合同校验没过」混在一个出方率里，
    // 等于用一个指标同时奖励和惩罚同一件事。按降级文案的来源分类。
    outcome: (Array.isArray(candidate?.herbs) && candidate.herbs.length > 0)
      ? "prescribed"
      : /模型处方输出被截断|未通过处方合同校验/.test(record.stages.prescribe?.visible || "")
        ? "contract_rejected"
        : /尚未形成通过临床复核的稳定证候结果|辨病辨证结果完整性/.test(record.stages.prescribe?.visible || "")
          ? "diagnosis_unstable"
          : record.stages.prescribe
            ? "safety_blocked"
            : "diagnose_failed",
    diagnoseMs: diagnose.ms, prescribeMs: record.stages.prescribe?.ms ?? null,
    assessStatus: record.stages.assess?.status ?? null,
    errors: [...(d.errors || []), ...(record.stages.prescribe?.errors || [])],
  };
  summary.push(row);
  process.stderr.write(`  ↳ ${JSON.stringify(row)}\n`);
}

{
  const queue = [...selected];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      try {
        await runCase(entry);
      } catch (error) {
        // 单例崩溃不拖垮整轮；按失败行记入汇总，保持 50 例账目完整。
        process.stderr.write(`  ↳ 病例 ${entry.no} 异常: ${String(error?.message || error)}\n`);
        summary.push({ no: entry.no, expectedDisease: entry.tcmDisease, actualDisease: null, diseaseHit: false,
          expectedSyndrome: entry.syndrome, actualSyndrome: null, syndromeScore: 0, expectedFormula: entry.formula,
          lockedFormulas: [], herbCount: 0, outcome: "harness_error", diagnoseMs: 0, prescribeMs: null,
          assessStatus: null, errors: [String(error?.message || error)] });
      }
    }
  });
  await Promise.all(workers);
  summary.sort((a, b) => a.no - b.no);
}

const n = summary.length || 1;
const out = {
  artifactDir: ARTIFACT_DIR,
  cases: summary.length,
  diseaseHitRate: `${summary.filter((r) => r.diseaseHit).length}/${summary.length}`,
  syndromeAvgScore: Number((summary.reduce((t, r) => t + r.syndromeScore, 0) / n).toFixed(2)),
  prescribed: summary.filter((r) => r.herbCount > 0).length,
  outcomes: summary.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] || 0) + 1 }), {}),
  namedFormula: summary.filter((r) => r.lockedFormulas.length > 0).length,
  assessOk: summary.filter((r) => r.assessStatus === 200).length,
  medianDiagnoseMs: summary.map((r) => r.diagnoseMs).sort((a, b) => a - b)[Math.floor(summary.length / 2)] ?? null,
  summary,
};
await fs.writeFile(path.join(ARTIFACT_DIR, "summary.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
