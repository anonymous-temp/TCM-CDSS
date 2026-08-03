// 金标准基准比对器: 读取 harness 产物目录, 按题型(benchmarkKind)对 M03 结论逐例打分。
// 用法: node scripts/compare-benchmark-outputs.mjs <benchmark.json> <artifactDir>
// 打分口径(确定性、可复查):
//  syndrome: 金标准与 primarySyndrome 双向包含 → 1; 字符二元组重叠率 → [0,1]
//  therapy:  金标准治法词逐词(2字窗)命中 overallMethod/overallPrinciple/subTherapies 的比例
//  formula:  金标准方名出现在 recommendedFormulaNames(锁定) → 1; 出现在正文 → 0.5
//  pathogenesis: 与 overallPathogenesis/summary 的二元组重叠率
// 输出: 总分布 + 每型均分 + 低分例清单(供人工读误差类)。
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
// 受治理等价层(2026-08-03 口径修正): 纯二元组把「血虚 vs 气血亏虚证」判 0 分——
// 中医证候等价必须走病位/病性特征分解,金标准特征被覆盖的召回率才是临床等价度。
const { clinicalAxesFromAffirmedText } = await jiti.import("../src/lib/tcm-syndrome-hypothesis.ts");
const { affirmedTcmTherapyConcepts } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const { executableFormulaCompilationReferences } = await jiti.import("../src/lib/tcm-formula-provenance.ts");

// 证候**标签**级病位/病性分解(clinicalAxesFromAffirmedText 面向症状叙述,不解标签):
// 「气血亏虚」→ {气虚,血虚};「脾肾两虚」→ {脾虚,肾虚};亏/不足/两虚 归一为虚。
const LABEL_LOCATIONS = ["心","肝","脾","肺","肾","胃","胆","大肠","小肠","膀胱","胞宫","冲任","经络","肌肤","卫表","表","清窍","咽喉","筋骨"];
const LABEL_NATURES = ["气虚","血虚","阴虚","阳虚","气滞","气郁","血瘀","痰","湿","热","火","寒","风","毒","食积","津亏","精亏","水停"];
function labelAxes(label) {
  const t = String(label || "");
  const feats = new Set();
  for (const loc of LABEL_LOCATIONS) if (t.includes(loc)) feats.add(`位:${loc}`);
  for (const nat of LABEL_NATURES) {
    if (t.includes(nat)) { feats.add(`性:${nat}`); continue; }
    const m = nat.match(/^(.+)虚$/);
    if (m && new RegExp(`${m[1]}[^，。；]{0,2}(虚|亏|不足|衰|竭|伤|耗|欲?脱)`).test(t) && t.includes(m[1])) feats.add(`性:${nat}`);
  }
  // 「X两虚/俱虚」展开: 脾肾两虚 → 脾虚+肾虚
  const dual = t.match(/([心肝脾肺肾气血阴阳])([心肝脾肺肾气血阴阳])(?:两虚|俱虚|亏虚|不足)/);
  if (dual) { feats.add(`性:${dual[1]}虚`); feats.add(`性:${dual[2]}虚`); }
  return feats;
}
function axisRecall(gold, actual) {
  try {
    const gl = labelAxes(gold);
    if (gl.size === 0) {
      const g = clinicalAxesFromAffirmedText([gold]);
      const gf = [...(g.locations || []), ...(g.natures || [])];
      if (gf.length === 0) return 0;
      const a = clinicalAxesFromAffirmedText([actual]);
      const af = new Set([...(a.locations || []), ...(a.natures || [])]);
      return gf.filter((f) => af.has(f)).length / gf.length;
    }
    const al = labelAxes(actual);
    return [...gl].filter((f) => al.has(f)).length / gl.size;
  } catch { return 0; }
}
function therapyConceptRecall(gold, actualText) {
  try {
    const g = affirmedTcmTherapyConcepts(gold);
    if (!g || g.size === 0) return 0;
    const a = affirmedTcmTherapyConcepts(actualText);
    return [...g].filter((c) => a.has(c)).length / g.size;
  } catch { return 0; }
}
function isGovernedFormula(name) {
  try { return executableFormulaCompilationReferences([name]).length > 0; } catch { return false; }
}

const [benchFile, artifactDir] = process.argv.slice(2);
if (!benchFile || !artifactDir) {
  console.error("usage: node scripts/compare-benchmark-outputs.mjs <benchmark.json> <artifactDir>");
  process.exit(2);
}
const cases = JSON.parse(fs.readFileSync(benchFile, "utf8")).cases;

function bigramOverlap(a, b) {
  const grams = (t) => {
    const clean = (t || "").replace(/[^一-鿿]/g, "");
    const set = new Set();
    for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
    return set;
  };
  const ga = grams(a), gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / ga.size;
}

function scoreCase(c, rec) {
  const reasoning = rec?.stages?.diagnose?.reasoning;
  if (!reasoning) return { score: 0, actual: "(无结构化结果)" };
  const ov = reasoning.overview || {};
  const th = reasoning.therapy || {};
  const kind = c.benchmarkKind;
  if (kind === "syndrome") {
    const actual = ov.primarySyndrome || "";
    const gold = c.syndrome;
    const secondary = (ov.secondarySyndromes || []).join("；");
    if (actual.includes(gold) || gold.includes(actual.replace(/证$/, "")) && actual) return { score: 1, actual };
    const direct = bigramOverlap(gold, actual);
    const withSecondary = bigramOverlap(gold, `${actual}；${secondary}`);
    const axes = axisRecall(gold, `${actual}；${secondary}`);
    return { score: Math.max(direct, withSecondary * 0.9, axes), actual };
  }
  if (kind === "therapy") {
    const actualText = [th.overallPrinciple, th.overallMethod, ov.overallTherapy,
      ...(th.subTherapies || []).map((s) => s.therapy)].filter(Boolean).join("；");
    return { score: Math.max(bigramOverlap(c.expectedTherapy, actualText), therapyConceptRecall(c.expectedTherapy, actualText)), actual: actualText.slice(0, 60) };
  }
  if (kind === "formula" && !isGovernedFormula(c.formula.replace(/[（(].*$/, ""))) {
    // 金标准是目录外方(多为中成药/合方): 饮片锁定结构上不可能命中,单列桶按正文提及打分。
    const goldName = c.formula.replace(/[（(].*$/, "");
    const visible = rec?.stages?.diagnose?.visible || "";
    return { score: visible.includes(goldName) ? 1 : 0, actual: "(目录外金标准)", kindOverride: "formula_out_of_catalog" };
  }
  if (kind === "formula") {
    const gold = c.formula.replace(/[（(].*$/, "");
    const locked = (ov.recommendedFormulaNames || []).join("、");
    if (locked.includes(gold)) return { score: 1, actual: locked };
    const visible = rec?.stages?.diagnose?.visible || "";
    if (visible.includes(gold)) return { score: 0.5, actual: `正文提及(未锁定): ${locked || "无锁定"}` };
    return { score: bigramOverlap(gold, locked || ov.recommendedFormulaDirection || ""), actual: locked || ov.recommendedFormulaDirection || "(无)" };
  }
  if (kind === "pathogenesis") {
    const actualText = [ov.overallPathogenesis, reasoning.pathogenesis?.summary].filter(Boolean).join("；");
    return { score: Math.max(bigramOverlap(c.expectedPathogenesis, actualText), axisRecall(c.expectedPathogenesis, actualText)), actual: actualText.slice(0, 60) };
  }
  return { score: 0, actual: "(未知题型)" };
}

const byKind = {};
const lowScores = [];
let missing = 0;
for (const c of cases) {
  const f = path.join(artifactDir, `case-${c.no}.json`);
  if (!fs.existsSync(f)) { missing++; continue; }
  const rec = JSON.parse(fs.readFileSync(f, "utf8"));
  const { score, actual, kindOverride } = scoreCase(c, rec);
  (byKind[kindOverride || c.benchmarkKind] ||= []).push(score);
  if (score < 0.4) {
    lowScores.push({
      no: c.no, kind: c.benchmarkKind,
      gold: c.syndrome || c.formula || c.expectedTherapy || c.expectedPathogenesis,
      actual, vignette: c.presentHistory.slice(0, 60),
    });
  }
}
const avg = (list) => list.reduce((a, b) => a + b, 0) / (list.length || 1);
console.log("=== 金标准基准比对 ===");
for (const [kind, scores] of Object.entries(byKind)) {
  const strict = scores.filter((s) => s >= 0.99).length;
  console.log(`${kind}: n=${scores.length} 严格命中=${strict}(${(strict / scores.length * 100).toFixed(0)}%) 均分=${avg(scores).toFixed(3)}`);
}
console.log(`缺产物: ${missing}`);
console.log(`\n低分例(${lowScores.length}, 供误差类分析, 前20):`);
for (const l of lowScores.slice(0, 20)) {
  console.log(`  #${l.no} [${l.kind}] gold=${l.gold} | actual=${l.actual}`);
}
fs.writeFileSync(path.join(artifactDir, "benchmark-comparison.json"), JSON.stringify({ byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { n: v.length, avg: avg(v), strict: v.filter((s) => s >= 0.99).length }])), lowScores }, null, 2));
