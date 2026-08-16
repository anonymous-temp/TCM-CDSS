// T2′ 反事实基线：单轴翻转最小对，指标 BTR。
//
// **BTR = P(反事实答错 | 基础病例答对)** —— 基础病例答对的前提下，把一条辨证轴的四诊证据
// 整组翻转之后仍然给出原答案（或给出与新证据相悖的答案）的条件概率。
// 它测的不是「会不会辨证」，而是「结论跟着证据走，还是跟着主诉的常见证型走」。
//
// 【为什么值得单独测】TCMEval-SDT 194 例实测的头号临床问题是**候选有了、收敛错了**：
// 热证 25 例遗漏中 21 例已经出现在鉴别诊断里、阴虚 21 例中 13 例、寒证 16 例中 10 例。
// 常规准确率把这件事平均掉了，BTR 不会——它专门盯「基础答对但一翻就错」。
// 指标形态借自 MamaBench（arXiv:2607.14385，非中医领域），该文结论是
// base accuracy 比 robust accuracy 高估 16–28 个百分点；**这个数字不能外推到中医**，
// 借的只是指标形态，不是结论。
//
// 【为什么病例是构造的、不从 L2 抽】方案 v2 原文写「基线病例从 L2 抽取并封存」。
// 执行时发现这条依赖可以绕开，而且绕开更对：反事实病例的正确答案**不可能来自标注**——
// 标注集只标了原始病例的证型，翻转之后那条病例的金标准在任何数据集里都不存在，只能推导。
// 既然两条路都得推导，就直接用**鉴别点定义**构造最小对（翻转的那一轴恰好是两个证型的
// 鉴别依据），正确答案由定义给出，同时完全不碰 L2、零污染风险。
// 偏离已写进 docs/辨证框架层-迭代方案-v3-20260816.md。
//
// 【三条与鲁棒性探针一致的约束】
//  1) 不代替系统做判断：caseState 不预置 completeness，withSafetyGate 每次从记录重算。
//  2) 断点续跑：每次调用单独落盘，已有结果直接跳过（线上单次 M03 要 20–60s）。
//  3) 限流自律：线上 60 次/10 分钟按身份计，自带滚动窗口令牌桶。
//
//   BASE_URL=… CDSS_API_TOKEN=… npm run regress:counterfactual-btr
//   REPEATS=3 OUT_DIR=artifacts/counterfactual-btr 可覆盖
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const OUT_DIR = path.resolve(repoRoot, process.env.OUT_DIR || "artifacts/counterfactual-btr");
const REPEATS = Math.max(1, Math.min(5, Number(process.env.REPEATS || 3)));
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 240_000);
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 55);
const RATE_WINDOW_MS = 10 * 60 * 1000;
const ONLY = (process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";

const spec = JSON.parse(readFileSync(path.join(repoRoot, "src/data/tcm-counterfactual-baseline.source.json"), "utf8"));
const pairs = spec.pairs.filter((pair) => !ONLY.length || ONLY.includes(pair.id));
mkdirSync(OUT_DIR, { recursive: true });

// ---------- 限流令牌桶 ----------
const stamps = [];
async function acquireSlot() {
  for (;;) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > RATE_WINDOW_MS) stamps.shift();
    if (stamps.length < RATE_LIMIT) { stamps.push(now); return; }
    const waitMs = RATE_WINDOW_MS - (now - stamps[0]) + 500;
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 30_000)));
  }
}

function consume(raw) {
  let content = "";
  let errorFrame = "";
  let sawEnd = false;
  for (const line of raw.split("\n").filter(Boolean)) {
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    if (typeof frame.error === "string") errorFrame = frame.error;
    if (typeof frame.content !== "string") continue;
    if (frame.content === "[END]") { sawEnd = true; continue; }
    content = frame.content.startsWith(REPLACE_MARKER)
      ? frame.content.slice(REPLACE_MARKER.length)
      : content + frame.content;
  }
  return { content, errorFrame, sawEnd };
}

function reasoningOf(content) {
  const start = content.lastIndexOf(START);
  const end = start >= 0 ? content.indexOf(END, start) : -1;
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(content.slice(start + START.length, end).trim()); } catch { return null; }
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
      const retryAfter = Number(response.headers.get("Retry-After") || 30);
      clearTimeout(timer);
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter * 1000 + 1000, 120_000)));
      return post(routePath, caseState, attempt + 1);
    }
    return { raw: await response.text(), status: response.status, ms: Date.now() - startedAt };
  } catch (error) {
    return { raw: "", status: 0, ms: Date.now() - startedAt, transport: String(error?.message || error) };
  } finally { clearTimeout(timer); }
}

function buildCaseState(id, arm) {
  const fields = {
    zhushu: arm.chiefComplaint,
    sex: "女", age: "45",
    xianbingshi: arm.symptoms,
    tcmTongue: arm.tongue,
    tcmPulse: arm.pulse,
    jiwangshi: "既往体健",
    guomin: "否认药物食物过敏史",
    yongyaoshi: "否认长期用药",
    vitalsT: "36.7", vitalsP: "78", vitalsR: "18", vitalsBP: "118/74",
    tcmLineagePreference: "unrestricted",
  };
  return {
    id: `cf_${id}`.replace(/[^A-Za-z0-9_]/g, "_"),
    phase: "diagnose",
    patient: { sex: "女", age: 45 },
    chiefComplaint: arm.chiefComplaint,
    symptoms: { general: arm.symptoms, tcmFourExams: `${arm.tongue}；${arm.pulse}` },
    tongue: arm.tongue,
    pulse: arm.pulse,
    vitals: "T36.7 P78 R18 BP118/74",
    labs: "",
    pastHistory: "既往体健",
    medicationHistory: "否认长期用药",
    allergyHistory: "否认药物食物过敏史",
    tcmLineagePreference: "unrestricted",
    hisRecord: {
      schemaVersion: "tcm-cdss-his-v1", source: "tcm-cdss-his",
      caseId: `cf_${id}`, updatedAt: new Date().toISOString(),
      tongueImageUploaded: false, fields,
      rawText: Object.values(fields).filter(Boolean).join("。"),
    },
    questionRounds: 1, maxQuestionRounds: 1, conversation: [],
    diagnosis: "", prescription: "", riskAssessment: "",
  };
}

/**
 * 判分只看**证候结论文本**，且期望词与禁止词都要查。
 * 只查期望词会漏掉「两个都写了」这种骑墙答案——那在临床上等于没收敛，
 * 恰恰是本轮要测的那个缺陷（候选有了、收敛错了）。
 */
function scoreArm(reasoning, arm) {
  const overview = reasoning?.overview || {};
  const syndromeText = [
    overview.primarySyndrome,
    ...(Array.isArray(overview.secondarySyndromes) ? overview.secondarySyndromes : []),
    reasoning?.syndromeDifferentiation?.primarySyndrome,
  ].filter((value) => typeof value === "string").join("；");
  if (!syndromeText) return { verdict: "no_syndrome", syndromeText: "" };
  // 「当前证候依据不足以形成稳定结论」是产品的**主动弃权**，不是答错也不是答对。
  // 混进 other 会让两种完全不同的失败长得一样：一个是判反了，一个是不敢判。
  if (/依据不足|不足以形成稳定结论|无法形成稳定/.test(syndromeText)) {
    return { verdict: "abstained", syndromeText };
  }
  // 概念正则，不是完整词穷举。首跑就栽在这里：系统答「肾阴亏虚，虚火内扰」——临床完全正确，
  // 但期望词写的是「肾阴虚」，而「肾阴亏虚」里『阴』后面跟的是『亏』不是『虚』，子串对不上，
  // 3 次被判为答错。**测量仪器犯的是和产品同一种毛病，而且更隐蔽**——它错的方向是让产品
  // 看起来更差，不容易引起怀疑。
  const expected = new RegExp(arm.expectedPattern);
  const forbidden = new RegExp(arm.forbiddenPattern);
  const hitExpected = expected.test(syndromeText) ? [syndromeText.match(expected)[0]] : [];
  const hitForbidden = forbidden.test(syndromeText) ? [syndromeText.match(forbidden)[0]] : [];
  let verdict;
  if (hitExpected.length && !hitForbidden.length) verdict = "correct";
  else if (hitExpected.length && hitForbidden.length) verdict = "straddled";
  else if (hitForbidden.length) verdict = "opposite";
  else verdict = "other";
  return { verdict, syndromeText, hitExpected, hitForbidden };
}

async function runArm(pairId, armName, arm, rep) {
  const file = path.join(OUT_DIR, `${pairId}__${armName}__r${rep}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const caseState = buildCaseState(`${pairId}_${armName}_r${rep}`, arm);
  const response = await post("/api/diagnosis/diagnose", caseState);
  const { content, errorFrame, sawEnd } = consume(response.raw);
  const reasoning = reasoningOf(content);
  const scored = scoreArm(reasoning, arm);
  const record = {
    pairId, arm: armName, rep,
    status: response.status, ms: response.ms, sawEnd, errorFrame,
    transport: response.transport || "",
    ...scored,
    resolution: reasoning?.overview?.primarySyndromeResolution
      || reasoning?.syndromeDifferentiation?.resolution || "",
    natureResolution: reasoning?.natureDifferentiation?.resolution || "",
    clinicalReview: reasoning?.clinicalReview?.status || "",
    unavailableReason: reasoning?.clinicalReview?.unavailableReason || "",
  };
  writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
  return record;
}

const RESCORE = process.env.RESCORE === "1";
const results = [];
if (RESCORE) {
  // 重评只改判分，不重发请求——syndromeText 已随每次调用落盘。
  for (const pair of pairs) {
    for (let rep = 1; rep <= REPEATS; rep += 1) {
      for (const [armName, arm] of [["base", pair.base], ["flipped", pair.flipped]]) {
        const file = path.join(OUT_DIR, `${pair.id}__${armName}__r${rep}.json`);
        if (!existsSync(file)) continue;
        const record = JSON.parse(readFileSync(file, "utf8"));
        const rescored = { ...record, ...scoreArm({ overview: { primarySyndrome: record.syndromeText } }, arm) };
        rescored.syndromeText = record.syndromeText;
        writeFileSync(file, JSON.stringify(rescored, null, 2), "utf8");
        results.push(rescored);
      }
    }
  }
}
for (const pair of RESCORE ? [] : pairs) {
  for (let rep = 1; rep <= REPEATS; rep += 1) {
    for (const [armName, arm] of [["base", pair.base], ["flipped", pair.flipped]]) {
      const record = await runArm(pair.id, armName, arm, rep);
      results.push(record);
      process.stdout.write(
        `${pair.id.padEnd(30)} ${armName.padEnd(8)} r${rep} ${String(record.verdict).padEnd(12)}`
        + ` ${Math.round(record.ms / 1000)}s ${record.syndromeText.slice(0, 34)}\n`,
      );
    }
  }
}

// ---------- 汇总 ----------
const byPairRep = new Map();
for (const record of results) {
  const key = `${record.pairId}#${record.rep}`;
  if (!byPairRep.has(key)) byPairRep.set(key, {});
  byPairRep.get(key)[record.arm] = record;
}

let baseCorrect = 0;
let btrNumerator = 0;
const perPair = {};
for (const [key, arms] of byPairRep) {
  const pairId = key.split("#")[0];
  perPair[pairId] ||= { baseCorrect: 0, flipWrongGivenBaseCorrect: 0, reps: 0, flipVerdicts: [] };
  perPair[pairId].reps += 1;
  const isBaseCorrect = arms.base?.verdict === "correct";
  if (isBaseCorrect) {
    baseCorrect += 1;
    perPair[pairId].baseCorrect += 1;
    perPair[pairId].flipVerdicts.push(arms.flipped?.verdict || "missing");
    if (arms.flipped?.verdict !== "correct") {
      btrNumerator += 1;
      perPair[pairId].flipWrongGivenBaseCorrect += 1;
    }
  }
}

// 稳定率：同一 arm 三次重复给出同一判定的比例（判定层面，不比对逐字文本——
// 措辞抖动不是不稳定，结论翻面才是）
const stability = {};
for (const pair of pairs) {
  for (const armName of ["base", "flipped"]) {
    const verdicts = results.filter((r) => r.pairId === pair.id && r.arm === armName).map((r) => r.verdict);
    const top = Object.entries(verdicts.reduce((acc, v) => ({ ...acc, [v]: (acc[v] || 0) + 1 }), {}))
      .sort((a, b) => b[1] - a[1])[0];
    stability[`${pair.id}#${armName}`] = verdicts.length ? Number((top[1] / verdicts.length).toFixed(3)) : null;
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  repeats: REPEATS,
  pairs: pairs.length,
  totalCalls: results.length,
  transportFailures: results.filter((r) => r.status !== 200).length,
  baseCorrectCount: baseCorrect,
  baseCorrectRate: byPairRep.size ? Number((baseCorrect / byPairRep.size).toFixed(3)) : null,
  // 这就是 BTR：分母是「基础答对」的次数，不是全部次数
  btr: baseCorrect ? Number((btrNumerator / baseCorrect).toFixed(3)) : null,
  btrNumerator, btrDenominator: baseCorrect,
  perPair, stability,
  verdictHistogram: results.reduce((acc, r) => ({ ...acc, [`${r.arm}:${r.verdict}`]: (acc[`${r.arm}:${r.verdict}`] || 0) + 1 }), {}),
  abstentions: results.filter((r) => r.verdict === "abstained").length,
  abstentionsByPair: results.filter((r) => r.verdict === "abstained")
    .reduce((acc, r) => ({ ...acc, [`${r.pairId}:${r.arm}`]: (acc[`${r.pairId}:${r.arm}`] || 0) + 1 }), {}),
  note: baseCorrect === 0
    ? "基础病例一次都没答对，BTR 无定义——先查基础准确率，不要报 BTR"
    : "BTR 分母为基础答对次数；straddled（同时写出期望与禁止证型）计为答错，骑墙在临床上等于没收敛",
};
writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
console.log(JSON.stringify(summary, null, 2));
