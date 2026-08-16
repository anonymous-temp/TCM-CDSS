// TCMEval-SDT 外部评测集跑分（L1/L2/L3 分层受控）。
//
// 数据来源：figshare DOI 10.6084/m9.figshare.27184596.v5，CC BY 4.0，
// 下载于 2026-08-16，落在 参考/external-eval/TCMEval-SDT/（gitignored，不进仓、不进镜像）。
//   Train_TCM_Data_v1.json       200 例  ← 含 gold reasoning 全文
//   Test_TCM_Data_v1.json         50 例  ← 答案字段在文件里是**空的**
//   Validation_TCM_Data_v1.json   50 例  ← 同上
//   Test_data_result.txt / Validation_data_result.txt  ← 答案键在这里
//     格式：病例ID@临床信息(分号分隔)@病机答案字母@证候答案字母@解释性总结
// 三个划分的 Medical Record ID 互不相交（实测 train∩test=0, train∩val=0, test∩val=0）。
//
// 【分层纪律由代码强制，不靠自觉】
//   L1 = train(200)。本仓 2026-08-16 已用其中 194 例定位缺陷，**已污染**，只能做覆盖分析。
//   L2 = validation(50)。持续回归记分牌。
//   L3 = test(50)。仅在发版评审/交付验收时跑，给医院的第三方口径分数。
// 默认只跑 L2。跑 L3 必须显式 SPLIT=test 且 ACKNOWLEDGE_L3=1——
// 这道门存在的理由：L3 一旦被看过就不再是「我们自己没调过」的那个分数，
// 而它是唯一能对医院这么说的东西。方案 §六记着「L2 规模只会缩小，这是设计意图」。
//
// 【本轮口径（甲方 2026-08-16 决定）】
// 不为 TCM-SD 的 GB/T 15657-1995 单独做证型映射。**直接用我们现行的
// GB/T 16751.2-2021 口径跑**，跑完之后由模型判断两套口径是否相容——
// 判断交给模型，不由工程侧手工对表（手工对表 26 年跨度的两套国标，
// 既慢又会把「我认为它们等价」混进数据）。
//
//   BASE_URL=… CDSS_API_TOKEN=… npm run regress:tcmeval-sdt
//   SPLIT=validation|test|train  LIMIT=n  OUT_DIR=…  可覆盖
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const DATA_DIR = path.join(repoRoot, "参考/external-eval/TCMEval-SDT");

const SPLIT = (process.env.SPLIT || "validation").toLowerCase();
const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const LIMIT = Number(process.env.LIMIT || 0);
const OUT_DIR = path.resolve(repoRoot, process.env.OUT_DIR || `artifacts/tcmeval-sdt-${SPLIT}`);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 240_000);
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 55);
const RATE_WINDOW_MS = 10 * 60 * 1000;
const CONCURRENCY = Math.max(1, Math.min(3, Number(process.env.CONCURRENCY || 2)));

const SPLIT_FILES = {
  train: { cases: "Train_TCM_Data_v1.json", answers: null, layer: "L1" },
  validation: { cases: "Validation_TCM_Data_v1.json", answers: "Validation_data_result.txt", layer: "L2" },
  test: { cases: "Test_TCM_Data_v1.json", answers: "Test_data_result.txt", layer: "L3" },
};
const cfg = SPLIT_FILES[SPLIT];
if (!cfg) throw new Error(`未知划分：${SPLIT}（可选 train|validation|test）`);
if (cfg.layer === "L3" && process.env.ACKNOWLEDGE_L3 !== "1") {
  throw new Error(
    "test 划分是 L3 盲测集，只在发版评审/交付验收时跑一次。"
    + "确需运行请显式设置 ACKNOWLEDGE_L3=1，并在 docs 的流转登记里记一笔——"
    + "L3 被看过之后就不再是「我们自己没调过」的那个分数。",
  );
}
if (cfg.layer === "L1") {
  console.warn("[分层] train 划分已于 2026-08-16 用于定位缺陷（194/200），属**已污染**的 L1，"
    + "结果只能做覆盖分析，不得作为改进证明。");
}

const cases = JSON.parse(readFileSync(path.join(DATA_DIR, cfg.cases), "utf8"));
mkdirSync(OUT_DIR, { recursive: true });

/** 答案键：病例ID@临床信息@病机答案@证候答案@解释性总结 */
function loadAnswers() {
  if (!cfg.answers) return new Map();
  const raw = readFileSync(path.join(DATA_DIR, cfg.answers), "utf8");
  const map = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("@");
    if (parts.length < 4) continue;
    map.set(parts[0].trim(), {
      clinicalInformation: (parts[1] || "").split(";").map((s) => s.trim()).filter(Boolean),
      pathogenesisAnswer: (parts[2] || "").trim(),
      syndromeAnswer: (parts[3] || "").trim(),
      explanatorySummary: parts.slice(4).join("@").trim(),
    });
  }
  return map;
}
const answers = loadAnswers();

// ---------- 限流 ----------
const stamps = [];
async function acquireSlot() {
  for (;;) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > RATE_WINDOW_MS) stamps.shift();
    if (stamps.length < RATE_LIMIT) { stamps.push(now); return; }
    await new Promise((r) => setTimeout(r, Math.min(RATE_WINDOW_MS - (now - stamps[0]) + 500, 30_000)));
  }
}

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";

function consume(raw) {
  let content = "";
  let errorFrame = "";
  for (const line of raw.split("\n").filter(Boolean)) {
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    if (typeof frame.error === "string") errorFrame = frame.error;
    if (typeof frame.content !== "string" || frame.content === "[END]") continue;
    content = frame.content.startsWith(REPLACE_MARKER)
      ? frame.content.slice(REPLACE_MARKER.length)
      : content + frame.content;
  }
  return { content, errorFrame };
}

async function post(routePath, caseState, attempt = 0) {
  await acquireSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${BASE_URL}${routePath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
      body: JSON.stringify({ caseState }),
      signal: controller.signal,
    });
    if (response.status === 429 && attempt < 4) {
      clearTimeout(timer);
      const retryAfter = Number(response.headers.get("Retry-After") || 30);
      await new Promise((r) => setTimeout(r, Math.min(retryAfter * 1000 + 1000, 120_000)));
      return post(routePath, caseState, attempt + 1);
    }
    return { raw: await response.text(), status: response.status, ms: Date.now() - startedAt };
  } catch (error) {
    return { raw: "", status: 0, ms: Date.now() - startedAt, transport: String(error?.message || error) };
  } finally { clearTimeout(timer); }
}

/**
 * 病案原文 → caseState。
 * **不预置 completeness**：withSafetyGate 每次从记录重算。预置 C 级会把「系统认为信息够不够」
 * 这个最该被测的判断替换成探针自己的假设，测出来的是探针不是产品（与鲁棒性探针同一条约束）。
 * 历史医案普遍缺现代生命体征与三史，进 B 级是**预期的 fail-closed**，不是缺陷。
 */
function buildCaseState(item) {
  const id = String(item["Medical Record ID"] || "").trim();
  const clinical = String(item["Clinical Data"] || "").trim();
  const safeId = `sdt_${SPLIT}_${id}`.replace(/[^A-Za-z0-9_]/g, "_");
  const fields = { zhushu: clinical.slice(0, 120), xianbingshi: clinical, tcmLineagePreference: "unrestricted" };
  return {
    id: safeId, phase: "diagnose",
    patient: {},
    chiefComplaint: clinical.slice(0, 120),
    symptoms: { general: clinical, tcmFourExams: "" },
    tongue: "", pulse: "", vitals: "", labs: "",
    pastHistory: "", medicationHistory: "", allergyHistory: "",
    tcmLineagePreference: "unrestricted",
    hisRecord: {
      schemaVersion: "tcm-cdss-his-v1", source: "tcm-cdss-his", caseId: safeId,
      updatedAt: new Date().toISOString(), tongueImageUploaded: false, fields, rawText: clinical,
    },
    questionRounds: 1, maxQuestionRounds: 1, conversation: [],
    diagnosis: "", prescription: "", riskAssessment: "",
  };
}

/** 选项文本 → 字母。"A:痰浊;B:耗损心气和心阴;…" */
function parseOptions(raw) {
  const map = new Map();
  for (const chunk of String(raw || "").split(";")) {
    const m = chunk.match(/^\s*([A-J])\s*[:：]\s*(.+?)\s*$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/**
 * 把产品输出映射到选项字母——**由模型裁判，不用字符串匹配**。
 *
 * 【为什么必须换掉字符串匹配】冒烟 2 例实测，字面匹配 100% 判为「未映射」，而产品答案
 * 逐条看都是对的：
 *   病例123 金标准病机 A:肝气横逆 + J:胃气不得下降
 *           产品输出「肝气郁结，横逆犯胃，胃失和降，气机上逆」——概念全中，字符串全不中
 * 中医证候/病机是**同义异写极多**的表述体系，字面匹配在这里系统性低估。
 * 这也回过头修正了本仓 2026-08-16 那轮 194 例评测的结论：报告称「病机 150/194 未映射」，
 * 其中相当一部分恐怕同样是判分器造成的，而非临床失败——那个数字不能直接当缺陷量。
 *
 * 【多选】答案键里 34/50 条是多选（`B;J` 这种分号分隔），单选比对永远不等。
 *
 * 裁判用**跨厂商那一路**（与生成方不同的模型身份），避免自己判自己。
 */
const JUDGE_BASE = process.env.BAILIAN_QWEN_BASE_URL || "";
const JUDGE_KEY = process.env.BAILIAN_QWEN_API_KEY || "";
const JUDGE_MODEL = process.env.BAILIAN_QWEN_MODEL || "qwen-plus";

async function judgeOptions(productionText, optionsRaw, kind) {
  if (!JUDGE_KEY || !productionText.trim()) return { letters: [], how: JUDGE_KEY ? "empty_production" : "judge_unconfigured" };
  const prompt = [
    `下面是一份中医病案的${kind}结论，以及一组候选选项。`,
    "请判断该结论**在中医概念上**对应哪些选项。注意同义异写（如「横逆犯胃」与「肝气横逆」、",
    "「胃失和降」与「胃气不得下降」为同一概念），按概念判断，不要按字面。",
    "",
    `【${kind}结论】${productionText}`,
    "",
    `【候选选项】${optionsRaw}`,
    "",
    "只输出一个 JSON：{\"letters\":[命中的选项字母],\"why\":\"一句话理由\"}",
    "命中可以是 0 到 3 个。宁可少选不要多选——把不成立的选项算成命中，会让评测虚高。",
  ].join("\n");
  try {
    const r = await fetch(`${JUDGE_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${JUDGE_KEY}` },
      body: JSON.stringify({ model: JUDGE_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 300, temperature: 0 }),
    });
    if (!r.ok) return { letters: [], how: `judge_http_${r.status}` };
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { letters: [], how: "judge_unparseable" };
    const parsed = JSON.parse(m[0]);
    const letters = (Array.isArray(parsed.letters) ? parsed.letters : [])
      .map((x) => String(x).trim().toUpperCase()).filter((x) => /^[A-J]$/.test(x));
    return { letters: [...new Set(letters)], how: "judged", why: String(parsed.why || "").slice(0, 120) };
  } catch (error) {
    return { letters: [], how: `judge_error:${String(error?.message || error).slice(0, 60)}` };
  }
}

/** 金标准字母集合：`B;J` → ["B","J"] */
const goldLetters = (raw) => String(raw || "").split(/[;,、\s]+/).map((x) => x.trim().toUpperCase()).filter((x) => /^[A-J]$/.test(x));

const selected = LIMIT > 0 ? cases.slice(0, LIMIT) : cases;
const results = [];
let cursor = 0;
async function worker() {
  for (;;) {
    const index = cursor++;
    if (index >= selected.length) return;
    const item = selected[index];
    const id = String(item["Medical Record ID"] || "").trim();
    const file = path.join(OUT_DIR, `${id.replace(/[^\w一-龥]/g, "_")}.json`);
    if (existsSync(file)) { results[index] = JSON.parse(readFileSync(file, "utf8")); continue; }

    const response = await post("/api/diagnosis/diagnose", buildCaseState(item));
    const { content, errorFrame } = consume(response.raw);
    const s = content.lastIndexOf(START);
    const e = s >= 0 ? content.indexOf(END, s) : -1;
    let reasoning = null;
    if (s >= 0 && e > s) { try { reasoning = JSON.parse(content.slice(s + START.length, e).trim()); } catch { /* keep null */ } }

    const gold = answers.get(id) || {};
    const overview = reasoning?.overview || {};
    const syndromeText = [overview.primarySyndrome, ...(overview.secondarySyndromes || [])].filter(Boolean).join("；");
    const pathogenesisText = [overview.overallPathogenesis,
      ...((reasoning?.pathogenesis?.chain || []).map((n) => n?.pathogenesis))].filter(Boolean).join("；");

    const syndromeMatch = await judgeOptions(syndromeText, item["Options of TCM Syndrome"], "证候");
    const pathogenesisMatch = await judgeOptions(pathogenesisText, item["Options of TCM Pathogenesis"], "病机");

    const record = {
      id, split: SPLIT, layer: cfg.layer,
      status: response.status, ms: response.ms, errorFrame, transport: response.transport || "",
      productionSyndrome: syndromeText,
      productionPathogenesis: pathogenesisText,
      syndromeLetters: syndromeMatch.letters, syndromeMatchHow: syndromeMatch.how, syndromeWhy: syndromeMatch.why || "",
      pathogenesisLetters: pathogenesisMatch.letters, pathogenesisMatchHow: pathogenesisMatch.how, pathogenesisWhy: pathogenesisMatch.why || "",
      goldSyndromeLetters: goldLetters(gold.syndromeAnswer),
      goldPathogenesisLetters: goldLetters(gold.pathogenesisAnswer),
      goldSyndromeText: goldLetters(gold.syndromeAnswer).map((l) => parseOptions(item["Options of TCM Syndrome"]).get(l)).filter(Boolean).join("；"),
      goldPathogenesisText: goldLetters(gold.pathogenesisAnswer).map((l) => parseOptions(item["Options of TCM Pathogenesis"]).get(l)).filter(Boolean).join("；"),
      clinicalReview: reasoning?.clinicalReview?.status || "",
      reviewProvider: reasoning?.clinicalReview?.provider || "",
      reviewIndependent: reasoning?.clinicalReview?.independentFromGenerator ?? null,
      resolution: overview.primarySyndromeResolution || "",
    };
    writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
    results[index] = record;
    process.stdout.write(`${id.padEnd(10)} 证候[${record.syndromeLetters.join("")}]/[${record.goldSyndromeLetters.join("")}] `
      + `病机[${record.pathogenesisLetters.join("")}]/[${record.goldPathogenesisLetters.join("")}] ${Math.round(record.ms / 1000)}s\n`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

const done = results.filter(Boolean);
const scored = done.filter((r) => r.status === 200);
// 多选任务的三种口径必须分开报：全中 / 部分中 / 未映射。
// 只报「全中率」会把「答对一半」和「完全没答对」混成同一个数字。
function tally(rows, gotKey, goldKey) {
  let exact = 0; let partial = 0; let unmapped = 0; let hit = 0; let goldTotal = 0; let predTotal = 0;
  for (const r of rows) {
    const got = new Set(r[gotKey] || []);
    const gold = new Set(r[goldKey] || []);
    goldTotal += gold.size; predTotal += got.size;
    if (!got.size) { unmapped += 1; continue; }
    const inter = [...got].filter((x) => gold.has(x));
    hit += inter.length;
    if (inter.length === gold.size && got.size === gold.size) exact += 1;
    else if (inter.length > 0) partial += 1;
  }
  return {
    exactSetMatch: exact,
    exactRate: rows.length ? Number((exact / rows.length).toFixed(4)) : null,
    partialMatch: partial,
    anyHitRate: rows.length ? Number(((exact + partial) / rows.length).toFixed(4)) : null,
    unmapped,
    recall: goldTotal ? Number((hit / goldTotal).toFixed(4)) : null,
    precision: predTotal ? Number((hit / predTotal).toFixed(4)) : null,
  };
}
const summary = {
  generatedAt: new Date().toISOString(),
  dataset: "TCMEval-SDT", doi: "10.6084/m9.figshare.27184596.v5", license: "CC BY 4.0",
  split: SPLIT, layer: cfg.layer, baseUrl: BASE_URL,
  cases: selected.length, completed: done.length,
  transportFailures: done.filter((r) => r.status !== 200).length,
  syndrome: tally(scored, "syndromeLetters", "goldSyndromeLetters"),
  pathogenesis: tally(scored, "pathogenesisLetters", "goldPathogenesisLetters"),
  judgeHealth: {
    // 裁判自身失败必须单列，否则「模型没答对」与「裁判没跑起来」长得一样
    syndrome: scored.reduce((a, r) => ({ ...a, [r.syndromeMatchHow]: (a[r.syndromeMatchHow] || 0) + 1 }), {}),
    pathogenesis: scored.reduce((a, r) => ({ ...a, [r.pathogenesisMatchHow]: (a[r.pathogenesisMatchHow] || 0) + 1 }), {}),
  },
  crossProviderReview: {
    accepted: scored.filter((r) => r.clinicalReview === "accepted").length,
    unavailable: scored.filter((r) => r.clinicalReview === "unavailable").length,
    independentTrue: scored.filter((r) => r.reviewIndependent === true).length,
    providers: [...new Set(scored.map((r) => r.reviewProvider).filter(Boolean))],
  },
  resolutionDistribution: scored.reduce((acc, r) => ({ ...acc, [r.resolution || "(空)"]: (acc[r.resolution || "(空)"] || 0) + 1 }), {}),
  medianMs: scored.length ? scored.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(scored.length / 2)] : null,
};
writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
console.log(JSON.stringify(summary, null, 2));
