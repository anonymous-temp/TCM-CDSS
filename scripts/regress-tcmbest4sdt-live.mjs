// TCM-BEST4SDT（中国中医科学院等，arXiv:2512.02816，figshare 10.6084/m9.figshare.30615956，
// Apache-2.0）辨证论治任务（TCM_SDT.json，300 例）的生产路径活体评测。
//
// 数据获取（不入库，用 TCMBEST_DATA_PATH 指向本地下载）：
//   curl -L -o TCM_SDT.json https://raw.githubusercontent.com/DYJG-research/TCM-BEST4SDT/main/TCM_SDT.json
//
// 无泄漏适配：只把 instruction（病例叙述）发给 CDSS；output 里的证型/病性/病位/治则治法
// 金标准与全部选择题选项都只在响应返回后用于判分——不向模型泄露答案空间。
// 论文原评测用 judge/reward 模型打 14 维分；这里按闭集自由文本标签做确定性判分：
//   syndromeExact / syndromeContain   证型命中（归一化相等 / 互为包含）
//   therapyOverlap                    治则治法词条与 M03 治法文本的覆盖数（金标准按、/；切分）
//   locationOverlap                   病位脏腑词在 M03 病位辨析中的覆盖数
//   withheld / contract_fail          与 regress-tcmsd-live 同口径
//
// 用法：
//   TCMBEST_DATA_PATH=/tmp/tcm-datasets/TCM_SDT.json TCMBEST_SAMPLE_SIZE=8 \
//   TCMBEST_SAMPLE_SEED=20260826 OUT_DIR=artifacts/tcmbest4sdt-live \
//   BASE_URL=... CDSS_API_TOKEN=... CDSS_CUSTOMER_ID=... npm run regress:tcmbest4sdt
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumeTcmEvalNdjson, parseTcmEvalReasoning, sha256Text, normalizeTcmEvalText } from "./lib/tcmeval-sdt.mjs";

const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const CUSTOMER_ID = process.env.CDSS_CUSTOMER_ID || "";
const DATA_PATH = process.env.TCMBEST_DATA_PATH || "artifacts/tcm-best4sdt/TCM_SDT.json";
const SAMPLE_SIZE = Math.max(0, Number(process.env.TCMBEST_SAMPLE_SIZE || 8));
const SAMPLE_SEED = process.env.TCMBEST_SAMPLE_SEED || "20260826";
const ONLY = new Set((process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean));
const OUT_DIR = process.env.OUT_DIR || "artifacts/tcmbest4sdt-live";
const TIMEOUT_MS = Number(process.env.LIVE_MODEL_TIMEOUT_MS || 240_000);

if (!BASE_URL || !TOKEN) { console.error("BASE_URL 与 CDSS_API_TOKEN 必填。"); process.exit(2); }
if (!existsSync(DATA_PATH)) {
  console.error(`未找到 TCM-BEST4SDT 数据文件：${DATA_PATH}（见文件头下载说明）`);
  process.exit(2);
}

function goldOf(record) {
  const gold = {};
  for (const line of Array.isArray(record.output) ? record.output : []) {
    const text = String(line || "");
    const m = text.match(/^(证型|病因|病机|病性|病位|治则治法)：(.+)$/u);
    if (m) gold[m[1]] = m[2].trim();
  }
  return gold;
}

const raw = JSON.parse(readFileSync(DATA_PATH, "utf8"));
const records = (Array.isArray(raw) ? raw : Object.values(raw).find(Array.isArray) || [])
  .map((r) => ({ ...r, id: `tcmbest_${r.id}`, gold: goldOf(r) }))
  .filter((r) => r.gold["证型"] && String(r.instruction || "").trim());
let selected = records;
if (ONLY.size) selected = selected.filter((r) => ONLY.has(r.id));
else if (SAMPLE_SIZE > 0 && SAMPLE_SIZE < selected.length) {
  selected = [...selected]
    .sort((a, b) => sha256Text(`${SAMPLE_SEED}:${a.id}`).localeCompare(sha256Text(`${SAMPLE_SEED}:${b.id}`)))
    .slice(0, SAMPLE_SIZE);
}
if (!selected.length) { console.error("TCM-BEST4SDT 选择结果为空"); process.exit(2); }
mkdirSync(OUT_DIR, { recursive: true });

function buildCaseState(record) {
  const narrative = String(record.instruction).trim();
  const clauses = narrative.split(/[，。；;]/).map((s) => s.trim()).filter(Boolean);
  // 病例叙述常自带人口学（「患者女，38岁」「三岁小女孩」）——逐字抽取（不编造）。
  const head = narrative.slice(0, 60);
  const sex = /女|妇|娠|孕|产后/.test(head) ? "女" : /男/.test(head) ? "男" : undefined;
  const ageMatch = head.match(/(\d{1,3})\s*岁/) || head.match(/([一二三四五六七八九十]{1,3})岁/);
  const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const age = ageMatch
    ? (/^\d+$/.test(ageMatch[1]) ? Number(ageMatch[1]) : CN[ageMatch[1]] ?? undefined)
    : undefined;
  return {
    id: `${record.id}_${SAMPLE_SEED}`,
    phase: "diagnose",
    patient: { ...(sex ? { sex } : {}), ...(Number.isFinite(age) ? { age } : {}) },
    chiefComplaint: clauses.slice(0, 2).join("，") || narrative.slice(0, 60),
    symptoms: { general: narrative },
    tongue: clauses.filter((c) => /[舌苔]/.test(c)).join("，"),
    pulse: clauses.filter((c) => /脉|指纹/.test(c)).join("，"),
    vitals: "",
    pastHistory: "",
    medicationHistory: "",
    allergyHistory: "",
    tcmLineagePreference: "unrestricted",
    conversation: [],
    questionRounds: 1,
    maxQuestionRounds: 1,
    diagnosis: "",
    prescription: "",
    riskAssessment: "",
  };
}

async function post(pathname, state) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}),
        ...(CUSTOMER_ID ? { "x-cdss-customer-id": CUSTOMER_ID } : {}),
      },
      body: JSON.stringify({ caseState: state }),
      signal: controller.signal,
    });
    return { status: response.status, raw: await response.text(), ms: Date.now() - startedAt };
  } catch (error) {
    return { status: 0, raw: "", ms: Date.now() - startedAt, transport: error?.name || "error" };
  } finally {
    clearTimeout(timer);
  }
}

const norm = (value) => normalizeTcmEvalText(String(value || "")).replace(/证$/u, "");
const containEither = (a, b) => Boolean(a && b && a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a)));
const splitTerms = (value) => String(value || "").split(/[、，,；;\s]+/).map((s) => s.trim()).filter(Boolean);

const results = [];
for (const record of selected) {
  const perCasePath = join(OUT_DIR, `${record.id}.json`);
  if (existsSync(perCasePath)) {
    results.push(JSON.parse(readFileSync(perCasePath, "utf8")));
    console.log(`[skip] ${record.id}（已有结果）`);
    continue;
  }
  const caseState = buildCaseState(record);
  let working = caseState;
  const pre = await post("/api/diagnosis/red-flags", caseState);
  try {
    const body = JSON.parse(pre.raw);
    if (body.clinicalFacts) working = { ...working, clinicalFacts: body.clinicalFacts };
  } catch { /* 安全门响应异常不阻断评测 */ }
  const res = await post("/api/diagnosis/diagnose", working);
  const content = consumeTcmEvalNdjson(res.raw).content;
  const reasoning = parseTcmEvalReasoning(content);
  const overview = reasoning?.overview || {};
  const goldSyndrome = norm(record.gold["证型"]);
  const primary = norm(overview.primarySyndrome);
  const secondaries = (Array.isArray(overview.secondarySyndromes) ? overview.secondarySyndromes : [])
    .map((s) => norm(typeof s === "string" ? s : s?.name));
  const all = [primary, ...secondaries].filter(Boolean);
  const withheld = !reasoning ? false : (overview.primarySyndromeResolution === "unresolved" || !primary);
  const therapyText = [
    reasoning?.therapy?.overallPrinciple,
    reasoning?.therapy?.overallMethod,
    ...(Array.isArray(reasoning?.therapy?.subTherapies) ? reasoning.therapy.subTherapies.map((t) => t?.therapy) : []),
  ].filter(Boolean).join("；");
  const therapyTerms = splitTerms(record.gold["治则治法"]);
  const therapyHits = therapyTerms.filter((t) => therapyText.includes(t) || splitTerms(therapyText).some((m) => containEither(m, t)));
  const locationTerms = splitTerms(record.gold["病位"]);
  const locationText = JSON.stringify(reasoning?.pathogenesis?.locationDifferentiation || "") + (overview.primarySyndrome || "");
  const locationHits = locationTerms.filter((t) => locationText.includes(t));
  const review = reasoning?.clinicalReview || {};
  const item = {
    id: record.id,
    gold: record.gold["证型"],
    status: res.status,
    ms: res.ms,
    bucket: !reasoning ? "contract_fail" : withheld ? "withheld" : "scored",
    primary: overview.primarySyndrome || "",
    syndromeExact: all.some((s) => s === goldSyndrome),
    syndromeContain: all.some((s) => containEither(s, goldSyndrome)),
    therapy: { gold: therapyTerms, hits: therapyHits },
    location: { gold: locationTerms, hits: locationHits },
    review: { status: review.status, decision: review.reviewDecision },
  };
  results.push(item);
  writeFileSync(perCasePath, `${JSON.stringify(item, null, 1)}\n`);
  console.log(`[${item.bucket}] ${record.id} ${item.ms}ms 金=${record.gold["证型"]} 出=${item.primary}${item.syndromeExact ? " ✓" : item.syndromeContain ? " ≈" : ""} 治法${therapyHits.length}/${therapyTerms.length}`);
}

const scored = results.filter((r) => r.bucket === "scored");
const summary = {
  suite: "tcm-best4sdt-live",
  dataset: "TCM-BEST4SDT TCM_SDT.json (Apache-2.0)",
  seed: SAMPLE_SEED,
  total: results.length,
  buckets: results.reduce((acc, r) => ({ ...acc, [r.bucket]: (acc[r.bucket] || 0) + 1 }), {}),
  syndromeExact: scored.filter((r) => r.syndromeExact).length,
  syndromeContain: scored.filter((r) => r.syndromeContain).length,
  scoredCount: scored.length,
  therapyTermRecall: (() => {
    const gold = scored.reduce((n, r) => n + r.therapy.gold.length, 0);
    const hit = scored.reduce((n, r) => n + r.therapy.hits.length, 0);
    return gold ? Number((hit / gold).toFixed(3)) : null;
  })(),
  locationTermRecall: (() => {
    const gold = scored.reduce((n, r) => n + r.location.gold.length, 0);
    const hit = scored.reduce((n, r) => n + r.location.hits.length, 0);
    return gold ? Number((hit / gold).toFixed(3)) : null;
  })(),
  latencyMs: {
    p50: [...results].map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)] || 0,
    max: Math.max(...results.map((r) => r.ms), 0),
    over180s: results.filter((r) => r.ms > 180_000).length,
  },
};
writeFileSync(join(OUT_DIR, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
console.log(JSON.stringify(summary, null, 1));
process.exit(results.some((r) => r.bucket === "contract_fail") ? 1 : 0);
