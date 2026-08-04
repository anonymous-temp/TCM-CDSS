// 阴性形式的阳性体征(受治理生成器,2026-08-04)。
//
// 问题(甲方实测 #7 的真正根因):中医大量**阳性**体征用否定词表达——
// 无汗、不渴、小便不利、大便不通、不得眠——它们是证候的**定义性指征**,不是「没有该症状」。
// 而极性层(clinical-polarity)按语言学规则把「无/不/否认」一律当否定剥离,于是:
//   affirmedClinicalText("无汗") → undefined
// 「无汗」进不了召回层、进不了鉴别守卫、不算证据。表实证的关键指征凭空消失,
// 系统随即把太阳伤寒(表实无汗)当成太阳中风(表虚有汗),推荐桂枝合剂。
//
// 此前的处理是典型的「修实例不修类」:tcm-formula-contraindications.ts 里手写了 10 个词
// (且「无汗」不在其中),又被 tcm-classic-inference.ts 复制了一份,只保护古方主治解析
// 这一条通路。极性层本身——所有模块真正调用的那一层——从来不知道这类词的存在。
//
// 本生成器**从受治理数据派生**这张表,不靠人工列举:
//   1. 鉴别图 tcm-formula-discrimination-graph.json 的 supportTerms/againstTerms ——
//      能作为方剂鉴别点的否定式短语,按构造就是阳性体征(否则无从鉴别);
//   2. 存量 10 词种子(出处:古方主治状态词,原在 tcm-formula-contraindications.ts)。
// 两路取并集,长词优先,供极性层在剥离否定前做保护性还原。
// (古方主治原文一度作为第三路,因语义歧义导致真否定被误读为阳性而移除,见下方收录门槛。)
//
// 用法: npm run build:affirmative-negation-forms
import fs from "node:fs";
import path from "node:path";

const DATA = path.join(process.cwd(), "src/data");
const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));

// 否定式短语的形态:以否定词起头,后接 1–3 个汉字的体征词。
// 这是**构词形态**判据(哪些串长得像否定式),不是临床词表——具体收哪些词由数据决定。
//
// 引导词只取「无/不/未」。「少」曾被纳入,实测抽出「少腹痛引睾丸」「少阴下利咽痛」——
// 中医里「少腹」是解剖部位、「少阴/少阳」是经络名,都不表否定;把它当否定引导词会
// 把一整片经络条文当成体征词收进来。「难」在受治理语料中近乎不出现,一并去掉。
const NEGATION_LEAD = /(?:^|[，。；、,;])((?:无|不|未)[一-龥]{1,3})/g;

/** 从一段文本里抽出所有否定式短语。 */
function negationForms(text) {
  const out = [];
  const value = String(text || "");
  for (const match of value.matchAll(NEGATION_LEAD)) {
    const term = match[1];
    if (term.length >= 2) out.push(term);
  }
  return out;
}

const tally = new Map();
const bump = (term, source) => {
  if (!term) return;
  let entry = tally.get(term);
  if (!entry) { entry = { term, count: 0, sources: new Set() }; tally.set(term, entry); }
  entry.count += 1;
  entry.sources.add(source);
};

// 来源 1:鉴别图。能当鉴别点的否定式短语,按构造即阳性体征。
const graph = read("tcm-formula-discrimination-graph.json");
for (const edge of graph.edges || []) {
  for (const which of ["from", "to"]) {
    const side = edge.sides?.[which];
    if (!side) continue;
    for (const term of [...(side.supportTerms || []), ...(side.againstTerms || [])]) {
      // 鉴别词本身就是独立短语,不需要切分,只需判形态。
      if (/^(?:无|不|未)[一-龥]{1,3}$/.test(term)) bump(term, "discrimination_graph");
    }
  }
}

// 来源 2:受治理方剂目录的古方主治原文。
const catalog = read("tcm-formula-governed-catalog.json");
for (const entry of catalog.entries || []) {
  for (const indication of entry.indications || []) {
    for (const term of negationForms(indication)) bump(term, "governed_catalog_indications");
  }
}

// 来源 3:存量种子(原手写于 tcm-formula-contraindications.ts,出处为古方主治状态词)。
const SEED_SOURCE = "legacy_tcm_affirmed_state_terms";
for (const term of read("tcm-affirmative-negation-seed.source.json").terms) bump(term, SEED_SOURCE);

// 收录门槛:**只认策展来源**(鉴别图鉴别词 + 存量种子),古方主治原文一律不收。
//
// 主治原文是自由行文,按形态抽取先是带出整句片段(「不吐不泻而但」「不论虚实皆治」),
// 收紧长度与频次后仍留下**语义有歧义**的词——实测「无发热」入表后,病历里
// 「无发热、咳嗽、消瘦或心悸」这种症状回顾式否认被整条判成阳性,把真否定读成了阳性体征。
//
// 判据由此改为来源可信度而非词形:能出现在鉴别图 supportTerms/againstTerms 里的否定式短语,
// 按构造就是**用于区分方剂的诊断特征**(否则无从鉴别),其阳性读法无歧义;
// 主治行文里的否定式短语没有这层保证。宁可漏收也不错收——漏收只少一条保护,
// 错收会把患者的否认读成阳性体征,那是比原缺陷更危险的方向。
const rows = [...tally.values()]
  .filter((entry) => entry.sources.has(SEED_SOURCE) || entry.sources.has("discrimination_graph"))
  .map((entry) => ({ term: entry.term, support: entry.count, sources: [...entry.sources].sort() }))
  .sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term));

const output = {
  schemaVersion: "tcm-cdss-affirmative-negation-forms-v1",
  note: "阴性形式的阳性体征：以否定词表达但属阳性诊断依据的中医体征词。极性层在剥离否定前须保护这些词，否则「无汗」「不渴」等证候定义性指征会被静默丢弃。",
  basis: "由受治理鉴别图的鉴别词、受治理方剂目录的古方主治原文，以及存量古方主治状态词种子派生；不含人工列举的临床判断词。",
  generatedFrom: {
    discriminationGraph: "tcm-formula-discrimination-graph.json",
    governedCatalog: "tcm-formula-governed-catalog.json",
    seed: "tcm-affirmative-negation-seed.source.json",
  },
  admissionPolicy: "curated_sources_only",
  count: rows.length,
  terms: rows,
};

const target = path.join(DATA, "tcm-affirmative-negation-forms.json");
fs.writeFileSync(target, `${JSON.stringify(output, null, 1)}\n`);
console.log(JSON.stringify({ written: path.relative(process.cwd(), target), count: rows.length, sample: rows.slice(0, 12).map((r) => r.term) }, null, 2));
