#!/usr/bin/env node
/**
 * 现代医案「症状表述 → 受控方剂」倒排索引生成器。
 *
 * ── 为什么需要这一路 ────────────────────────────────────────────────────────────
 * 经典方召回此前只有三路：概念正则、**古籍主治原文**词面、证候假设。前两路都在比对字面，
 * 而古籍主治写的是「起碎疙瘩，形如黍屑，色赤肿痛」（枇杷清肺饮），现代病历写的是
 * 「面部粟疹累累，色红」——同一个临床事实，字面零重合。实测 17 个目录内金标准方
 * recall@8 只有 35%，召不回的恰恰是银翘散、温胆汤、黄芪建中汤这类门诊核心方。
 *
 * 缺的不是算法而是**现代语料**：仓库里的现代医案语料有 2371 条医案带方名，其中银翘散 41 例、
 * 温胆汤 65 例，每一例都写着现代临床用语的四诊描述。把「哪些现代症状词在真实医案里与哪首方
 * 同现、同现了几例」编译成倒排表，就补上了古籍主治词覆盖不到的那一层表述。
 *
 * ── 治理边界（这一条比功能本身重要） ─────────────────────────────────────────────
 * 源语料封套写着 evaluationOnly=true / runtimeRetrievalAllowed=false，理由是它含**自拟方**与
 * **原始剂量**，不得作处方依据。本生成器因此是**构建期统计派生**，产物只含三类东西：
 *   1) 2–4 字中文症状 n-gram（滑窗片段，不是可复原的医案正文）；
 *   2) 受治理目录内的方剂 id（目录外方名——含「经验方」这类自拟方——一律丢弃并记账）；
 *   3) 支持例数与权重（整数与浮点数）。
 * 产物里**没有**医案正文、剂量、药味、医家姓名、行锚，也没有任何单条医案可被反查。
 * 运行时只 import 本产物，绝不 import 源语料——`runtimeRetrievalAllowed=false` 因此仍然成立。
 * 下游用法同样受限：这一路只影响候选池与排序，不参与身份锁、正向充分性与剂量编译
 *（见 src/lib/tcm-formula-indications.ts 的 MODERN_CASE_PATH_WEIGHT 注释）。
 *
 * 用法：npm run build:modern-case-index
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);
const CORPUS_PATH = join(projectRoot, "src/data/tcm-modern-case-eval-corpus.json");
const CATALOG_PATH = join(projectRoot, "src/data/tcm-formula-governed-catalog.json");
const DISEASE_LEXICON_PATH = join(projectRoot, "src/data/tcm-disease-lexicon.json");
const OUTPUT_PATH = join(projectRoot, "src/data/tcm-modern-case-formula-index.json");

/**
 * n-gram 机制与古籍主治词索引（tcm-formula-indications.ts 的 INDICATION_TERM_INDEX）保持一致：
 * 2–4 字滑窗、只在连续中文串内切、下游只对「极大词」计分。两处口径必须相同，否则同一句话
 * 在两路里被切成不同粒度，权重就没有可比性。
 */
const TERM_MIN_LENGTH = 2;
const TERM_MAX_LENGTH = 4;
/**
 * 抽取字段。取的是**患者侧表述**：主诉、四诊、病机分析、中医诊断名与病名。
 * 不取 herbs / course / outcome / physician——那些是处方与身份信息，与召回无关且属治理边界外。
 */
const TEXT_FIELDS = ["chiefComplaint", "fourExams", "patternAnalysis", "diagnosisTcm"];
/**
 * 一个词若挂到超过这一比例的方剂上，它描述的是「医案都这么写」而不是「这首方对应什么」。
 * 0.15 是实测拐点：起初取 0.06（≈20 首方）把「心悸」「失眠」这类**主症**整词删掉了，
 * 结果归脾汤、温胆汤连候选池都进不去——主症挂的方多是正常的，压制它们该由提升度负责，
 * 不该由词表准入负责。放宽到 0.15 后同一批病例的本路自身排名 r1 从 2 升到 4/18。
 */
const TERM_FORMULA_DF_RATIO = 0.15;
/** 支持度收缩先验：s/(s+PRIOR)。s=1 只拿 0.25，s=3 到 0.5，s=10 到 0.77。 */
const SUPPORT_PRIOR = 3;
/** 提升度参考值：lift 达到该值即认为完全特异（ln 归一化的上界）。 */
const LIFT_REFERENCE = 24;
/** 提升度低于此值的配对不入库：该词并不比基线更指向这首方，留着只是噪声。 */
const MIN_PAIR_LIFT = 1.5;
/** 低于此权重的配对不入库：留着只增加体积与噪声。 */
const MIN_PAIR_WEIGHT = 0.02;
/** 每个词最多保留多少首方：长尾词挂太多方等于把候选池灌满。 */
const MAX_FORMULAS_PER_TERM = 24;

const numberEnv = (name, fallback) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};
const params = {
  termMinLength: TERM_MIN_LENGTH,
  termMaxLength: TERM_MAX_LENGTH,
  textFields: TEXT_FIELDS,
  termFormulaDfRatio: numberEnv("MODERN_CASE_INDEX_DF_RATIO", TERM_FORMULA_DF_RATIO),
  supportPrior: numberEnv("MODERN_CASE_INDEX_SUPPORT_PRIOR", SUPPORT_PRIOR),
  liftReference: numberEnv("MODERN_CASE_INDEX_LIFT_REFERENCE", LIFT_REFERENCE),
  minPairLift: numberEnv("MODERN_CASE_INDEX_MIN_LIFT", MIN_PAIR_LIFT),
  minPairWeight: numberEnv("MODERN_CASE_INDEX_MIN_WEIGHT", MIN_PAIR_WEIGHT),
  maxFormulasPerTerm: numberEnv("MODERN_CASE_INDEX_MAX_FORMULAS", MAX_FORMULAS_PER_TERM),
  diseaseSynonymExpansion: process.env.MODERN_CASE_INDEX_DISEASE_SYNONYMS !== "false",
};

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
if (corpus.schemaVersion !== "tcm-modern-case-eval-corpus-v1") {
  throw new Error(`源语料 schemaVersion 非预期：${corpus.schemaVersion}`);
}
// 派生自评测语料这件事必须显式确认过再派生：封套语义变了就要重新审这条边界。
if (corpus.evaluationOnly !== true || corpus.runtimeRetrievalAllowed !== false) {
  throw new Error("源语料封套语义已变（evaluationOnly/runtimeRetrievalAllowed），需重新审查派生边界");
}

const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
/**
 * 方名归一只认受治理目录的 name/aliases，且只认 retrievalEligible 的条目——
 * 目录外方名（「经验方」这类自拟方占绝大多数）一律丢弃并记账，绝不新建方剂身份。
 * 同名多条时取先出现的一条：目录本身已做同名异方裁定，这里不再二次判定。
 */
const formulaIdByName = new Map();
const formulaNameById = new Map();
for (const entry of catalog.entries || []) {
  if (!entry.retrievalEligible) continue;
  formulaNameById.set(entry.id, entry.name);
  for (const name of [entry.name, ...(entry.aliases || [])]) {
    const key = typeof name === "string" ? name.trim() : "";
    if (key && !formulaIdByName.has(key)) formulaIdByName.set(key, entry.id);
  }
}

/**
 * 病名同义归一（受治理来源，非手写词表）。
 *
 * 医案与病历各写各的病名：枇杷清肺饮的 3 条医案全写「粉刺」，而门诊病历写「痤疮」——
 * 同一个 GB/T 15657-2021 条目（A08.01.20 粉刺，别名含痤疮/青春痘/肺风粉刺），字面却零重合，
 * 于是这首方在痤疮病例下一条词都命中不到。
 *
 * 归一放在**构建期**而不是运行时：命中某个受治理病名的医案，其全部别名一并写进该案文本再切词，
 * 索引因此同时挂上「粉刺」和「痤疮」两种写法。运行时仍然只做一次查表，不需要加载病名词表，
 * 也不引入任何运行时语义判断。歧义别名（词表自带 ambiguousAliases）一律不展开。
 */
const diseaseLexicon = JSON.parse(readFileSync(DISEASE_LEXICON_PATH, "utf8"));
const ambiguousAliases = new Set((diseaseLexicon.ambiguousAliases || []).map((item) => item.alias));
const diseaseSynonymGroups = (diseaseLexicon.entries || [])
  .filter((entry) => !entry.isCategoryHeading)
  .map((entry) => [entry.canonical, ...(entry.aliases || [])]
    .filter((name) => typeof name === "string" && name.length >= 2 && !ambiguousAliases.has(name)))
  .filter((group) => group.length > 1);
/** 病名 → 该病名所在的全部同义写法。同一写法落在多个条目时取并集。 */
const diseaseSynonymsByName = new Map();
for (const group of diseaseSynonymGroups) {
  for (const name of group) {
    const bucket = diseaseSynonymsByName.get(name);
    if (bucket) for (const other of group) bucket.add(other);
    else diseaseSynonymsByName.set(name, new Set(group));
  }
}
function diseaseSynonymExpansion(text) {
  const expanded = new Set();
  for (const [name, synonyms] of diseaseSynonymsByName) {
    if (!text.includes(name)) continue;
    for (const synonym of synonyms) if (!text.includes(synonym)) expanded.add(synonym);
  }
  return [...expanded];
}

const CJK_RUN = /[一-龥]{2,}/g;
function caseTerms(text) {
  const terms = new Set();
  for (const run of text.match(CJK_RUN) || []) {
    for (let size = params.termMinLength; size <= params.termMaxLength; size += 1) {
      for (let start = 0; start + size <= run.length; start += 1) terms.add(run.slice(start, start + size));
    }
  }
  return terms;
}

const pairSupport = new Map(); // term -> Map(formulaId -> 支持例数)
const termCaseCount = new Map();
const formulaCaseCount = new Map();
const droppedNameCounts = new Map();
let casesWithExpectedFormula = 0;
let casesMappedToCatalog = 0;
let diseaseExpandedCases = 0;

for (const item of corpus.cases || []) {
  const names = item.expectedFormulaNames || [];
  if (names.length === 0) continue;
  casesWithExpectedFormula += 1;
  const ids = new Set();
  for (const name of names) {
    const key = typeof name === "string" ? name.trim() : "";
    const id = key ? formulaIdByName.get(key) : undefined;
    if (id) ids.add(id);
    else if (key) droppedNameCounts.set(key, (droppedNameCounts.get(key) || 0) + 1);
  }
  if (ids.size === 0) continue;
  const text = [
    ...params.textFields.map((field) => (typeof item[field] === "string" ? item[field] : "")),
    ...(Array.isArray(item.diseases) ? item.diseases.filter((name) => typeof name === "string") : []),
  ].filter(Boolean).join("；");
  const expanded = params.diseaseSynonymExpansion
    ? [text, ...diseaseSynonymExpansion(text)].join("；")
    : text;
  if (expanded.length > text.length) diseaseExpandedCases += 1;
  const terms = caseTerms(expanded);
  if (terms.size === 0) continue;
  casesMappedToCatalog += 1;
  for (const id of ids) formulaCaseCount.set(id, (formulaCaseCount.get(id) || 0) + 1);
  for (const term of terms) {
    termCaseCount.set(term, (termCaseCount.get(term) || 0) + 1);
    let bucket = pairSupport.get(term);
    if (!bucket) pairSupport.set(term, (bucket = new Map()));
    for (const id of ids) bucket.set(id, (bucket.get(id) || 0) + 1);
  }
}

const totalCases = casesMappedToCatalog;
const distinctFormulas = formulaCaseCount.size;
if (totalCases < 1000 || distinctFormulas < 100) {
  throw new Error(`可用医案过少（案 ${totalCases} / 方 ${distinctFormulas}），索引不予生成`);
}

/**
 * 配对权重 = 支持度收缩 × 提升度 × 词长加成，全部落在 0–1。
 *
 * - **支持度收缩** s/(s+prior)：任务边界要求「仅 1 例支持的配对权重必须显著低于古籍主治词」。
 *   s=1 只有 0.17，乘完提升度与词长后典型落在 0.05–0.12；古籍主治词权重是 0.4–2.0，
 *   两者相差一个数量级，单例噪声不可能压过一条真实主治命中。
 * - **提升度** (s/n_t)/(n_f/N)：只有支持度会让「舌苔薄白」这类人人都写的词把大方带上来——
 *   它在所有方里都同现，lift≈1，权重被压到接近 0；而「粟疹」只在少数几例里出现且集中在
 *   一首方上，lift 很高。这就是「稀有度」在本层的具体形式：它衡量的是**词对方的指向性**，
 *   比单纯的文档频率更贴合「这个词能不能把这首方选出来」。
 * - **词长加成** 与古籍主治词索引同口径：长词更具体。
 */
function pairWeight({ support, termCases, formulaCases, termLength }) {
  const expected = (termCases * formulaCases) / totalCases;
  const lift = expected > 0 ? support / expected : 0;
  // 提升度不足 = 这个词并不比基线更指向这首方，不入库。
  if (lift < params.minPairLift) return 0;
  const supportShrink = support / (support + params.supportPrior);
  const liftScore = Math.min(1, Math.log(1 + lift) / Math.log(1 + params.liftReference));
  const lengthBoost = Math.min(1, (termLength - 1) / 3);
  return supportShrink * liftScore * (0.7 + 0.3 * lengthBoost);
}

const terms = {};
let indexPairs = 0;
let droppedByDf = 0;
let droppedByWeight = 0;
let droppedByCap = 0;
const supportHistogram = { "1": 0, "2": 0, "3-4": 0, "5-9": 0, "10+": 0 };
for (const [term, bucket] of pairSupport) {
  if (bucket.size / distinctFormulas > params.termFormulaDfRatio) {
    droppedByDf += 1;
    continue;
  }
  const scored = [];
  for (const [id, support] of bucket) {
    const weight = pairWeight({
      support,
      termCases: termCaseCount.get(term) || 1,
      formulaCases: formulaCaseCount.get(id) || 1,
      termLength: term.length,
    });
    if (weight < params.minPairWeight) {
      droppedByWeight += 1;
      continue;
    }
    scored.push([id, Math.round(weight * 1000) / 1000, support]);
  }
  if (scored.length === 0) continue;
  scored.sort((left, right) => right[1] - left[1] || right[2] - left[2] || left[0].localeCompare(right[0]));
  if (scored.length > params.maxFormulasPerTerm) {
    droppedByCap += scored.length - params.maxFormulasPerTerm;
    scored.length = params.maxFormulasPerTerm;
  }
  terms[term] = scored;
  indexPairs += scored.length;
  for (const [, , support] of scored) {
    if (support === 1) supportHistogram["1"] += 1;
    else if (support === 2) supportHistogram["2"] += 1;
    else if (support <= 4) supportHistogram["3-4"] += 1;
    else if (support <= 9) supportHistogram["5-9"] += 1;
    else supportHistogram["10+"] += 1;
  }
}

// 产物自检：任何一条不成立都说明派生逻辑或治理边界破了，宁可不出产物。
for (const [term, entries] of Object.entries(terms)) {
  if (term.length < params.termMinLength || term.length > params.termMaxLength || !/^[一-龥]+$/.test(term)) {
    throw new Error(`索引词形态非法（只允许 ${params.termMinLength}–${params.termMaxLength} 字纯中文）：${term}`);
  }
  for (const [id, weight, support] of entries) {
    if (!formulaNameById.has(id)) throw new Error(`索引出现目录外方剂 id：${id}`);
    if (!(weight > 0 && weight <= 1)) throw new Error(`权重越界：${term}/${id}=${weight}`);
    if (!Number.isInteger(support) || support < 1) throw new Error(`支持例数非法：${term}/${id}=${support}`);
  }
}

const droppedNames = [...droppedNameCounts]
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  .map(([name, count]) => ({ name, cases: count }));

const output = {
  schemaVersion: "tcm-modern-case-formula-index-v1",
  generatedBy: "scripts/build-modern-case-formula-index.mjs",
  derivedFrom: "src/data/tcm-modern-case-eval-corpus.json",
  derivationBoundary: [
    "构建期统计派生物：只含 2–4 字症状 n-gram、受治理目录方剂 id、支持例数与权重。",
    "不含医案正文、剂量、药味、医家、行锚，单条医案不可反查；目录外方名（含自拟方）已丢弃。",
    "运行时只读本产物，不读源语料——源语料 runtimeRetrievalAllowed=false 仍然成立。",
    "用途仅限召回候选池与排序，不参与方剂身份锁、正向充分性判定与剂量编译。",
  ].join("\n"),
  params,
  counts: {
    corpusCases: (corpus.cases || []).length,
    casesWithExpectedFormula,
    casesMappedToCatalog,
    droppedFormulaNameCases: [...droppedNameCounts.values()].reduce((total, value) => total + value, 0),
    distinctFormulas,
    indexTerms: Object.keys(terms).length,
    indexPairs,
    droppedByDf,
    droppedByWeight,
    droppedByCap,
    diseaseExpandedCases,
    diseaseSynonymGroups: diseaseSynonymGroups.length,
    supportHistogram,
  },
  droppedFormulaNames: droppedNames.slice(0, 50),
  formulaCaseCounts: Object.fromEntries([...formulaCaseCount].sort((left, right) => right[1] - left[1])),
  terms,
};

writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 0)}\n`);
console.log(JSON.stringify({
  output: "src/data/tcm-modern-case-formula-index.json",
  ...output.counts,
  droppedTopNames: droppedNames.slice(0, 5).map((item) => `${item.name}×${item.cases}`),
}, null, 2));
