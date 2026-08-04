// 临床词表单一来源生成器(2026-08-04 根治「硬编码词表」元问题)。
//
// 问题:临床语义判断所需的词表——病位词、病性词、人群限定词、证候→轴分解——长期由各模块
// **手写**在 TS 常量里(实测 src/lib 下 4207 处中文字面量/正则)。手写表与受治理词表必然漂移,
// 而漂移的表现就是一个个临床缺陷:方向判错、人群误伤、等价判 0 分。逐个修永远修不完,
// 因为下一个人还会手写下一张表。
//
// 根治:所有临床判断词表由本脚本从**受治理词表**生成,运行时只读生成物
// (src/lib/clinical-vocabulary.ts 提供访问器);新增手写词表由
// scripts/test-clinical-vocabulary-single-source.mjs 守卫在回归里拦截。
//
// 数据来源(全部为受治理产物,不含任何手写临床词):
//   tcm-location-lexicon.json      36 条病位(id/canonical/aliases/system)
//   tcm-nature-lexicon.json        31 条病性(id/canonical/aliases/kind)
//   tcm-syndrome-lexicon.json    2060 条证候(每条自带 locations[]/natures[] 轴分解)
//   tcm-treatment-principle-lexicon.json 1276 条治则治法
//
// 用法: npm run build:clinical-vocabulary
import fs from "node:fs";
import path from "node:path";

const DATA = path.join(process.cwd(), "src/data");
const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));
const rowsOf = (doc) => (Array.isArray(doc) ? doc : doc.entries || doc.terms || Object.values(doc).find(Array.isArray) || []);

const locations = rowsOf(read("tcm-location-lexicon.json"));
const natures = rowsOf(read("tcm-nature-lexicon.json"));
const syndromes = rowsOf(read("tcm-syndrome-lexicon.json"));

/** 词条的全部可匹配写法:规范名 + 别名。去空去重,长词在前(避免短词吃掉长词)。 */
function surfaceForms(row) {
  return [...new Set([row.canonical, row.standardTerm, ...(row.aliases || [])].filter(
    (value) => typeof value === "string" && value.trim().length > 0,
  ))].sort((a, b) => b.length - a.length);
}

const locationForms = locations.map((row) => ({ id: row.id, canonical: row.canonical, system: row.system || null, forms: surfaceForms(row) }));
const natureForms = natures.map((row) => ({ id: row.id, canonical: row.canonical, kind: row.kind || null, forms: surfaceForms(row) }));

// 证候 → 轴分解。词表里 2060 条证候每条都带 locations/natures,这正是各模块手写
// 「气血亏虚 → {气虚,血虚}」这类映射时重复造的轮子。只收录真正带轴的条目。
const syndromeAxes = {};
for (const row of syndromes) {
  const locs = (row.locations || []).filter(Boolean);
  const nats = (row.natures || []).filter(Boolean);
  if (locs.length === 0 && nats.length === 0) continue;
  for (const form of surfaceForms(row)) {
    // 同名冲突时保留轴更具体(轴数更多)的那条:粗粒度类目词不应覆盖具体证候。
    const existing = syndromeAxes[form];
    if (existing && existing.locations.length + existing.natures.length >= locs.length + nats.length) continue;
    syndromeAxes[form] = { id: row.id, locations: locs, natures: nats };
  }
}

// 人群限定词。受治理证候/治则词表按**术语分类学**组织(病因/脏腑/气血…),不含科别与生理
// 阶段维度,人群词无法从它们派生;因此它有一份专属的受治理源文件——集中、带 basis、可审核,
// 代码内不得再手写(守卫测试拦截)。
const populationSource = read("tcm-population-scope.source.json");
const populationForms = Object.fromEntries(
  Object.entries(populationSource.groups).map(([group, spec]) => [
    group,
    [...new Set((spec.terms || []).filter((t) => typeof t === "string" && t.trim()))]
      .sort((a, b) => b.length - a.length),
  ]),
);

const output = {
  schemaVersion: "tcm-cdss-clinical-vocabulary-v1",
  generatedFrom: {
    locations: "tcm-location-lexicon.json",
    natures: "tcm-nature-lexicon.json",
    syndromes: "tcm-syndrome-lexicon.json",
    populations: "tcm-population-scope.source.json",
  },
  counts: {
    locations: locationForms.length,
    natures: natureForms.length,
    syndromeAxes: Object.keys(syndromeAxes).length,
    ...Object.fromEntries(Object.entries(populationForms).map(([k, v]) => [`population_${k}`, v.length])),
  },
  locations: locationForms,
  natures: natureForms,
  syndromeAxes,
  populations: populationForms,
  populationSourceNote: populationSource.note,
};

const target = path.join(DATA, "clinical-vocabulary-derived.json");
fs.writeFileSync(target, `${JSON.stringify(output, null, 1)}\n`);
console.log(JSON.stringify({ written: path.relative(process.cwd(), target), ...output.counts }, null, 2));
