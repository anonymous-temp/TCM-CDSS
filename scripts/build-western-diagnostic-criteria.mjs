#!/usr/bin/env node
// 西医诊断标准要点表（受治理来源，2026-10-18）：src/data/western-diagnostic-criteria.source.json
//
// 用途：西医病名一致性核对（western-name-evidence-check.server.ts）判「名称比病历能支撑的更具体」（情形 D）时，
// 按这张表里该病的诊断标准要点核对，而不是只靠提示词里手写的十几个病（甲方标准病历 7 牙髓炎、留出例 S102 PCOS 一类）。
//
// 做法（每个病名）：DeepSeek Search API 查「<病名> 诊断标准」→ 只取权威度≥3 的页面正文 → deepseek-flash 抽取要点
//（是否可按临床表现诊断、必需的检查、病程门槛、定义性表现）并给出一句页面原文 → 服务端核对原文逐字在页面正文里，核不上的不收。
// 每条都带网址、站名、标题、抽取日期与原文，可人工复核。已有条目不重抽（断点续跑）；--refresh 重抽全部（会覆盖人工核对的改动）。
// 新增条目须人工核对后再标 reviewedAt；2026-10-18 首批 132 条逐条核对，27 条按公认标准订正（reviewCorrection 记改前与依据）。
//
// 用法：OPENAI_API_KEY=… node scripts/build-western-diagnostic-criteria.mjs names.txt [--refresh]
//（或 CDSS_ENV_FILE=/path/local.env；密钥只在进程内使用，不打印。）
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("src/data/western-diagnostic-criteria.source.json");
const [namesFile, ...flags] = process.argv.slice(2);
if (!namesFile) {
  console.error("usage: node scripts/build-western-diagnostic-criteria.mjs names.txt [--refresh]");
  process.exit(2);
}
if (process.env.CDSS_ENV_FILE) {
  for (const line of fs.readFileSync(process.env.CDSS_ENV_FILE, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && !(line.slice(0, at) in process.env)) process.env[line.slice(0, at)] = line.slice(at + 1);
  }
}
const KEY = process.env.OPENAI_API_KEY || "";
const BASE = (process.env.OPENAI_BASE_URL || "https://api.deepseek.com").replace(/\/+$/u, "").replace(/\/v1$/u, "");
const MODEL = process.env.CRITERIA_MODEL || "deepseek-flash";
if (!KEY) { console.error("missing OPENAI_API_KEY"); process.exit(2); }

const names = [...new Set(fs.readFileSync(namesFile, "utf8").split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")))];
const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { schemaVersion: 1, entries: [] };
const byName = new Map(existing.entries.map((entry) => [entry.name, entry]));
const refresh = flags.includes("--refresh");

const compact = (value) => String(value || "").normalize("NFKC").replace(/\s+/gu, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(url, body, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    return { status: response.status, json: await response.json().catch(() => ({})) };
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM = [
  "你是医学资料摘录员。给你一个西医病名和一段权威网页正文（诊疗手册、指南、教材类）。只根据正文，摘出这个病的诊断要点。",
  "输出 JSON：{",
  "\"relevant\": 正文是否在讲这个病的诊断（true/false）,",
  "\"clinicallyDiagnosable\": 是否按典型病史和临床表现即可诊断、不必依赖某项检查（true/false）,",
  "\"requiredTests\": [确诊必须依赖的检查或化验，每项≤20字，没有就空数组],",
  "\"durationThreshold\": \"病程门槛（如“症状出现至少6个月、近3个月符合标准”），没有就空串\",",
  "\"definingFeatures\": [定义性的必备表现或标准条目，每项≤30字，最多5项],",
  "\"quote\": \"正文里支持上面要点的一句原文，逐字复制，20–150字\"",
  "}",
  "页面讲的必须正是这个病：讲的是相近的另一个病（如给的是“湿疹”，页面讲的是“特应性皮炎”；给的是“功能性消化不良”，页面讲的是“消化不良”的鉴别）时 relevant=false。",
  "requiredTests 只写“不做就不能确诊该病”的检查；用于排除其他病、评估严重程度或寻找病因的辅助检查不写。临床表现即可诊断的病 requiredTests 为空。",
  "durationThreshold 只写诊断标准明文规定的病程（如罗马IV“诊断前症状出现至少6个月”）。",
  "不得写正文没有的内容；正文不是在讲这个病的诊断时 relevant=false，其余字段留空。",
].join("\n");

async function extract(name, page) {
  const content = String(page.content || "").slice(0, 7000);
  if (content.length < 200) return undefined;
  const { status, json } = await post(`${BASE}/chat/completions`, {
    model: MODEL,
    temperature: 0,
    max_tokens: 700,
    response_format: { type: "json_object" },
    thinking: { type: "disabled" },
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify({ disease: name, page: content }) }],
  }, 60_000);
  if (status !== 200) return undefined;
  let parsed;
  try { parsed = JSON.parse(json.choices?.[0]?.message?.content || ""); } catch { return undefined; }
  if (!parsed?.relevant) return undefined;
  const quote = String(parsed.quote || "").trim();
  // 原文核对：摘录的那一句必须逐字（忽略空白）在页面正文里，核不上的不收。
  if (compact(quote).length < 15 || !compact(content).includes(compact(quote))) return undefined;
  const list = (value, max, len) => (Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter((item) => item && item.length <= len).slice(0, max);
  return {
    clinicallyDiagnosable: parsed.clinicallyDiagnosable === true,
    requiredTests: list(parsed.requiredTests, 6, 30),
    durationThreshold: String(parsed.durationThreshold || "").trim().slice(0, 60),
    definingFeatures: list(parsed.definingFeatures, 5, 40),
    quote,
  };
}

let added = 0;
for (const name of names) {
  if (!refresh && byName.has(name)) continue;
  const search = await post(`${BASE}/v1/tools/search`, { query: `${name} 诊断标准`, count: 8, need_content: true });
  const pages = (search.json.results || [])
    .filter((item) => (item.authority ?? -1) >= 3 && String(item.content || "").length >= 200)
    .sort((a, b) => (b.rerank_score || 0) - (a.rerank_score || 0))
    .slice(0, 3);
  let entry;
  for (const page of pages) {
    const extracted = await extract(name, page).catch(() => undefined);
    if (!extracted) continue;
    entry = { name, ...extracted, url: String(page.url).split("#")[0], siteName: page.site_name || "", title: page.title || "", retrievedAt: new Date().toISOString().slice(0, 10) };
    break;
  }
  console.log(`${name}\t${search.status}\t${pages.length}\t${entry ? `${entry.siteName}|${entry.clinicallyDiagnosable ? "临床" : "须检查"}|${entry.requiredTests.join("、")}|${entry.durationThreshold}` : "—"}`);
  if (entry) {
    byName.set(name, entry);
    added += 1;
    const entries = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
    fs.writeFileSync(OUT, `${JSON.stringify({ ...existing, schemaVersion: 1, generatedBy: "scripts/build-western-diagnostic-criteria.mjs", entries }, null, 1)}\n`);
  }
  await sleep(250);
}
console.log(`done: ${added} added, ${byName.size} total`);
