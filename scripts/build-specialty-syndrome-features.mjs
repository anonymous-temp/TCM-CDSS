// 专科证型特征串生成器(2026-08-04)。
//
// 问题:受治理证候词表 tcm-syndrome-lexicon.json 有 2060 条 GB/T 16751.2-2021 术语,但它按**术语
// 分类学**组织(八纲/病因/气血/脏腑/经络…),每条只有 canonical/aliases/locations/natures ——
// **0 条带症状特征串**,也不含科别维度。实测后果:甲方考题集里 4 道题面是教材证候原文**逐字照抄**
// (307 胸痹·心肾阳虚 / 311 胎动不安·癥瘕伤胎 / 338 黄疸·阴黄寒湿阻遏 / 340 口疮·风热乘脾),
// 系统全部判错。缺的不是推理能力,是**确定性锚点**:没有「这串症状 = 这个证」的受控对照表,
// 模型只能自由命名,于是丢脏腑定位(307)、把主证降格为兼证(311)、证名与所选方自相矛盾(338)、
// 漏掉表邪层(340)。
//
// 本脚本把 src/data/tcm-specialty-syndrome-features.source.json(逐条带 basis 与 sourceRefs 的
// 教材级特征串)编译成运行时可用的确定性匹配表,由 src/lib/clinical-vocabulary.ts 读取。
//
// ★ 反臆造不变量(构建期强制,违者直接失败)★
//   matchTerms 的每一条必须是 keySymptoms/tongue/pulse/additionalVerbatim 中**某个分句**的
//   字符子序列 —— 即只能从教材原文里**删字**,不能加入原文没有的概念。原文之外确需补入的桥接词
//   (如现代病名「子宫肌瘤」↔ 中医「癥瘕」)只能进 adjudicatedTerms,且每条必须写 basis。
//
// 用法: npm run build:specialty-syndrome-features
import fs from "node:fs";
import path from "node:path";

const DATA = path.join(process.cwd(), "src/data");
const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));

const SOURCE_FILE = "tcm-specialty-syndrome-features.source.json";
const TARGET_FILE = "clinical-vocabulary-specialty-features.json";

const source = read(SOURCE_FILE);
const lexicon = read("tcm-syndrome-lexicon.json");

const errors = [];
const fail = (entryId, message) => errors.push(`${entryId}: ${message}`);

// ── 受治理证候词表索引(用于校验 syndromeId 真实存在) ──
const syndromeById = new Map();
for (const row of [...lexicon.entries, ...(lexicon.clinicalExtensions || [])]) {
  syndromeById.set(row.id, row);
}

// ── 正字法归一 ──
// 异体/通用字(黯/暗、颚/腭…)在教材原文与病历书写之间自由互换。这是**正字法**层而非临床术语层,
// 不归一会让确定性匹配栽在纯书写差异上(实测:教材「舌黯红」vs 病历「舌暗红」)。
const ORTHOGRAPHIC = { ...(source.orthographicVariants?.map || {}) };
const normalize = (text) => [...String(text || "")].map((ch) => ORTHOGRAPHIC[ch] || ch).join("");

// ── 分句 ──
// 教材证候原文是逗号/顿号分隔的短句流。子序列校验必须**限定在单个分句内**:跨句子序列过于宽松
// (「口干」几乎是任何长句的子序列),限定在分句内才真正约束住「只能删字」。
const CLAUSE_SPLIT = /[，,、；;。．：:！!？?（）()「」『』《》〈〉【】\s]+/;
const clausesOf = (text) => normalize(text).split(CLAUSE_SPLIT).filter(Boolean);

/** term 是否为 clause 的字符子序列(顺序保持,允许删字,不允许加字)。 */
function isSubsequence(term, clause) {
  let i = 0;
  for (const ch of clause) {
    if (ch === term[i]) i += 1;
    if (i === term.length) return true;
  }
  return i === term.length;
}

const REQUIRED_STRING_FIELDS = ["specialty", "diseaseCategory", "disease", "syndromeName", "keySymptoms", "therapy", "representativeFormula", "basis"];
const ALLOWED_SPECIALTIES = new Set(Object.keys(source.specialties || {}));

const compiled = [];
const seenIds = new Set();

for (const entry of source.entries) {
  const id = entry.id || "<missing-id>";
  if (!entry.id) fail(id, "缺 id");
  if (seenIds.has(id)) fail(id, "id 重复");
  seenIds.add(id);

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof entry[field] !== "string" || entry[field].trim().length === 0) fail(id, `字段 ${field} 缺失或为空`);
  }
  if (ALLOWED_SPECIALTIES.size > 0 && !ALLOWED_SPECIALTIES.has(entry.specialty)) {
    fail(id, `specialty「${entry.specialty}」不在受控科别表 ${[...ALLOWED_SPECIALTIES].join("/")} 内`);
  }
  if (typeof entry.basis === "string" && entry.basis.trim().length < 8) fail(id, "basis 过短,必须写清依据来源与出处");

  // sourceRefs 必须解析到 sources 表
  const refs = Array.isArray(entry.sourceRefs) ? entry.sourceRefs : [];
  if (refs.length === 0) fail(id, "缺 sourceRefs");
  for (const ref of refs) {
    if (!source.sources[ref]) fail(id, `sourceRef「${ref}」未在 sources 中登记`);
  }

  // syndromeId 若非 null 必须真实存在于受治理证候词表
  if (entry.syndromeId !== null && entry.syndromeId !== undefined) {
    if (!syndromeById.has(entry.syndromeId)) fail(id, `syndromeId「${entry.syndromeId}」不存在于 tcm-syndrome-lexicon.json`);
  } else if (typeof entry.syndromeIdNote !== "string" || entry.syndromeIdNote.trim().length < 8) {
    fail(id, "syndromeId 为 null 时必须写 syndromeIdNote 说明为何词表里找不到");
  }

  // ── 逐条建立「术语 → 来源分句」的可追溯映射,同时执行反臆造校验 ──
  const verbatimGroups = [
    { kind: "symptom", text: entry.keySymptoms },
    { kind: "tongue", text: entry.tongue },
    { kind: "pulse", text: entry.pulse },
    ...(entry.additionalVerbatim || []).map((extra) => ({ kind: "symptom", text: extra.text, ref: extra.sourceRef })),
  ].filter((group) => typeof group.text === "string" && group.text.trim().length > 0);

  for (const extra of entry.additionalVerbatim || []) {
    if (!extra.sourceRef || !source.sources[extra.sourceRef]) fail(id, `additionalVerbatim 的 sourceRef「${extra.sourceRef}」未登记`);
  }

  const clauseIndex = verbatimGroups.flatMap((group) => clausesOf(group.text).map((clause) => ({ ...group, clause })));

  const terms = [];
  const matchTerms = Array.isArray(entry.matchTerms) ? entry.matchTerms : [];
  if (matchTerms.length < 3) fail(id, `matchTerms 仅 ${matchTerms.length} 条,不足以形成有鉴别力的特征串(至少 3 条)`);

  for (const raw of matchTerms) {
    const term = normalize(raw).trim();
    if (term.length < 2) {
      fail(id, `matchTerm「${raw}」过短(<2 字),噪声过大`);
      continue;
    }
    // 反臆造:必须能在某个分句里找到它的字符子序列。命中哪一组就归哪一类(舌/脉优先)。
    const hits = clauseIndex.filter((row) => isSubsequence(term, row.clause));
    if (hits.length === 0) {
      fail(id, `matchTerm「${raw}」不是任何证候原文分句的子序列——疑似臆造。若确需补入,请放进 adjudicatedTerms 并写 basis`);
      continue;
    }
    const kind = hits.find((h) => h.kind === "tongue")?.kind
      || hits.find((h) => h.kind === "pulse")?.kind
      || "symptom";
    terms.push({ term, kind, sourceClause: hits[0].clause });
  }

  for (const adjudicated of entry.adjudicatedTerms || []) {
    const term = normalize(adjudicated.term || "").trim();
    if (term.length < 2) {
      fail(id, `adjudicatedTerm「${adjudicated.term}」过短或为空`);
      continue;
    }
    if (typeof adjudicated.basis !== "string" || adjudicated.basis.trim().length < 10) {
      fail(id, `adjudicatedTerm「${term}」缺 basis——原文之外的桥接词必须逐条写明依据`);
      continue;
    }
    terms.push({ term, kind: "adjudicated", sourceClause: null, mapsTo: adjudicated.mapsTo || null });
  }

  // 去重(同一写法只保留一次,舌/脉/裁定类优先于普通症状)
  const rank = { tongue: 3, pulse: 3, adjudicated: 2, symptom: 1 };
  const deduped = new Map();
  for (const item of terms) {
    const prev = deduped.get(item.term);
    if (prev && rank[prev.kind] >= rank[item.kind]) continue;
    deduped.set(item.term, item);
  }

  compiled.push({
    id,
    specialty: entry.specialty,
    diseaseCategory: entry.diseaseCategory,
    disease: entry.disease,
    syndromeName: entry.syndromeName,
    syndromeAliases: [...new Set([entry.syndromeName, ...(entry.syndromeAliases || [])].filter(Boolean))],
    syndromeId: entry.syndromeId ?? null,
    therapy: entry.therapy,
    representativeFormula: entry.representativeFormula,
    verbatim: {
      keySymptoms: entry.keySymptoms,
      tongue: entry.tongue || null,
      pulse: entry.pulse || null,
    },
    terms: [...deduped.values()].sort((a, b) => b.term.length - a.term.length),
    sourceRefs: refs,
  });
}

if (errors.length > 0) {
  console.error(`专科证型特征串源文件校验失败(${errors.length} 条):`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}

const bySpecialty = {};
for (const row of compiled) bySpecialty[row.specialty] = (bySpecialty[row.specialty] || 0) + 1;
const diseases = new Set(compiled.map((row) => `${row.specialty}/${row.disease}`));

const output = {
  schemaVersion: "tcm-cdss-specialty-syndrome-features-v1",
  generatedFrom: SOURCE_FILE,
  governance: source.governance,
  specialties: source.specialties,
  counts: {
    specialtySyndromeFeatures: compiled.length,
    specialtySyndromeDiseases: diseases.size,
    specialtySyndromeTerms: compiled.reduce((sum, row) => sum + row.terms.length, 0),
    ...Object.fromEntries(Object.entries(source.specialties || {}).map(([label, spec]) => [
      `specialtyFeatures_${spec.key}`,
      bySpecialty[label] || 0,
    ])),
  },
  orthographicVariants: ORTHOGRAPHIC,
  sources: source.sources,
  entries: compiled,
};

const target = path.join(DATA, TARGET_FILE);
fs.writeFileSync(target, `${JSON.stringify(output, null, 1)}\n`);
console.log(JSON.stringify({ written: path.relative(process.cwd(), target), ...output.counts }, null, 2));
