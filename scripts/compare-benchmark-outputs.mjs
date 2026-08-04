// 金标准基准比对器: 读取 harness 产物目录, 按题型(benchmarkKind)逐例打分。
//
// 用法一(比对打分):
//   node scripts/compare-benchmark-outputs.mjs <benchmark.json> <artifactDir>
// 用法二(派生「中成药金标准」子集, 见下文 M04 口径):
//   node scripts/compare-benchmark-outputs.mjs --derive-patent-subset <benchmark.json> <out.json>
//
// 中成药子集的完整跑法(需先起服务器并配好 CDSS_API_TOKEN; 千万不要设 WEB_CASES_STAGES=diagnose):
//   node scripts/compare-benchmark-outputs.mjs --derive-patent-subset \
//     artifacts/web-cases-batch4-mcq.json artifacts/web-cases-batch4-patent.json
//   WEB_CASES_FILE=artifacts/web-cases-batch4-patent.json \
//     WEB_CASES_DIR=artifacts/web-cases-batch4-patent-run \
//     node scripts/regress-web-cases.mjs
//   node scripts/compare-benchmark-outputs.mjs \
//     artifacts/web-cases-batch4-patent.json artifacts/web-cases-batch4-patent-run
//
// 打分口径(确定性、可复查):
//  syndrome: 金标准与 primarySyndrome 双向包含 → 1; 字符二元组重叠率 → [0,1]
//  therapy:  金标准治法词逐词(2字窗)命中 overallMethod/overallPrinciple/subTherapies 的比例
//  formula:  金标准方名出现在 recommendedFormulaNames(锁定) → 1; 出现在正文 → 0.5
//  pathogenesis: 与 overallPathogenesis/summary 的二元组重叠率
//
// ── 目录外方剂题 = 中成药题, 必须按 M04 打分(2026-08-04 口径修正) ─────────────
// batch4-mcq 里有一批方剂题的金标准是**中成药**(消痤丸、连花清瘟胶囊、感冒清热颗粒…)。
// 中成药候选只在 M04 产出(formula.patentAndWestern), M03 的 recommendedFormulaNames 是
// **饮片方**锁定位, 结构上永远不可能命中中成药名。此前用 WEB_CASES_STAGES=diagnose 只跑 M03
// 再拿这批题按 M03 口径打分, 得到的 0/24 是**口径错**造成的假象, 不是模型能力。
//
// 现在: 金标准经 executableFormulaCompilationReferences 判定**不在受治理饮片目录内**的方剂题,
// 一律走中成药口径:
//   · 产物里没有 prescribe 阶段 → 不计 0 分, 单独进 *_no_m04 桶并计数(把"没跑"与"跑了没中"分开);
//   · 有 prescribe 阶段 → 对 stages.prescribe.reasoning.formula.patentAndWestern[] 打分:
//       1.0  名称等同: 与金标准逐字相同, 或去剂型后缀后同名(消痤丸 ≡ 消痤胶囊)
//       0.6  同受控经典方骨架: 双方都能归到同一受治理经典方(归脾丸 / 归脾颗粒 → 归脾汤)
//       ≤0.5 同类中成药: 双方都能在本地中成药说明书目录查到时, 取「功能主治」二元组
//            Dice 相似度 × 0.5(同治法同主治的不同厂牌/组方给部分分)
//       0.3  下限: 金标准只在 M04 可见正文里被提及, 未进结构化中成药候选
//       0    结构化候选与说明书主治都不相干
// 剂型后缀剥离与经典方骨架判定都复用 src/lib 的受治理实现(patentMedicineBaseName /
// governedClassicFormulaName / executableFormulaCompilationReferences), 本脚本内不另写药名表。
//
// 输出: 总分布 + 每型均分 + 未计分例计数 + 低分例清单(供人工读误差类)。
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
// 受治理等价层(2026-08-03 口径修正): 纯二元组把「血虚 vs 气血亏虚证」判 0 分——
// 中医证候等价必须走病位/病性特征分解,金标准特征被覆盖的召回率才是临床等价度。
const { clinicalAxesFromAffirmedText } = await jiti.import("../src/lib/tcm-syndrome-hypothesis.ts");
const { affirmedTcmTherapyConcepts } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const { executableFormulaCompilationReferences } = await jiti.import("../src/lib/tcm-formula-provenance.ts");
// 中成药口径全部复用运行时的受治理实现, 避免基准脚本里长出第二套药名/剂型表。
const { findLocalPatentMedicineEntry, governedClassicFormulaName, patentMedicineBaseName } =
  await jiti.import("../src/lib/local-patent-medicine-candidates.ts");

// 证候标签的轴分解走**受治理词表**(clinical-vocabulary.ts):词表里 2060 条证候每条都自带
// locations/natures,此前这里手写 LABEL_LOCATIONS/LABEL_NATURES 两张表就是「代码内手写词表」
// 的又一例——连写这个比对器的人也重复造了同一个轮子。已迁至单一来源。
const { governedSyndromeLabelAxes } = await jiti.import("../src/lib/clinical-vocabulary.ts");
function labelAxes(label) {
  const axes = governedSyndromeLabelAxes(label);
  return new Set([...axes.locations.map((v) => `位:${v}`), ...axes.natures.map((v) => `性:${v}`)]);
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

function bigrams(text) {
  const clean = String(text || "").replace(/[^一-鿿]/g, "");
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  return set;
}

function bigramOverlap(a, b) {
  const ga = bigrams(a), gb = bigrams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / ga.size;
}

/** 对称重叠(Dice), 用于说明书主治相似度: 避免候选说明书越长越"像"。 */
function bigramDice(a, b) {
  const ga = bigrams(a), gb = bigrams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return (2 * hit) / (ga.size + gb.size);
}

// ── 中成药金标准口径 ─────────────────────────────────────────────────────────
/** 金标准字段里的方名: 去掉括号注释(如「保和丸（加减）」)。 */
function goldFormulaName(c) {
  return String(c.formula || "").replace(/[（(].*$/, "").trim();
}

/** 该方剂题的金标准是否落在受治理饮片目录外 → 只能由 M04 中成药候选回答。 */
function isOutOfCatalogFormulaGold(c) {
  if (c.benchmarkKind !== "formula") return false;
  if (c.benchmarkTarget === "patent_medicine") return true;
  const gold = goldFormulaName(c);
  return Boolean(gold) && !isGovernedFormula(gold);
}

/** 受治理经典方骨架: 先按本名, 再按去剂型基础名 + 汤/散/丸/饮/煎 回退(归脾颗粒 → 归脾汤)。 */
function classicBackbone(name) {
  const raw = String(name || "").trim();
  if (!raw) return undefined;
  const direct = (() => {
    try { return executableFormulaCompilationReferences([raw])[0]?.formulaName; } catch { return undefined; }
  })();
  if (direct) return direct;
  try { return governedClassicFormulaName(raw); } catch { return undefined; }
}

function patentIndication(name) {
  try { return findLocalPatentMedicineEntry(name)?.indication || ""; } catch { return ""; }
}

function sameProduct(goldName, candidateName) {
  if (!goldName || !candidateName) return false;
  if (goldName === candidateName) return true;
  try {
    const goldBase = patentMedicineBaseName(goldName);
    return goldBase.length >= 2 && goldBase === patentMedicineBaseName(candidateName);
  } catch { return false; }
}

/**
 * M04 中成药候选 vs 中成药金标准。返回 unscored 时表示该例根本没跑 M04——必须单独计数,
 * 不能按 0 分并入均值(那正是 0/24 假象的成因)。
 */
function scorePatentMedicineCase(c, rec) {
  const gold = goldFormulaName(c);
  const prescribe = rec?.stages?.prescribe;
  if (!prescribe) {
    return { score: null, unscored: true, actual: "(该产物未跑 M04, 中成药候选无从比对)", kindOverride: "formula_patent_no_m04" };
  }
  const candidates = (prescribe?.reasoning?.formula?.patentAndWestern || [])
    .filter((item) => item && item.type === "中成药" && typeof item.name === "string" && item.name.trim())
    .map((item) => item.name.trim());
  const goldBackbone = classicBackbone(gold);
  const goldIndication = patentIndication(gold);
  let best = 0;
  let bestName = "";
  let bestTier = "无中成药候选";
  for (const name of candidates) {
    let score = 0;
    let tier = "不相干";
    if (sameProduct(gold, name)) { score = 1; tier = "名称等同"; }
    else {
      const backbone = classicBackbone(name);
      if (goldBackbone && backbone && backbone === goldBackbone) { score = 0.6; tier = `同经典方骨架(${backbone})`; }
      const indication = patentIndication(name);
      const similarity = goldIndication && indication ? 0.5 * bigramDice(goldIndication, indication) : 0;
      if (similarity > score) { score = similarity; tier = "同类中成药(说明书主治相近)"; }
    }
    if (score > best) { best = score; bestName = name; bestTier = tier; }
  }
  // 金标准只在 M04 可见正文里出现(讨论/加减说明), 未进结构化中成药候选: 给下限分, 不给命中。
  if (best < 0.3 && gold && String(prescribe.visible || "").includes(gold)) {
    best = 0.3;
    bestName = bestName || "(仅正文提及)";
    bestTier = "仅正文提及, 未进结构化候选";
  }
  const actual = candidates.length === 0
    ? `(M04 无中成药候选; ${prescribe?.reasoning?.formula?.medicineCandidateStatus?.reason || "未给出原因"})`
    : `${bestTier}: ${bestName || "无"} | 全部候选: ${candidates.join("、")}`;
  return { score: best, actual: actual.slice(0, 160), kindOverride: "formula_patent_medicine" };
}

// ── 派生「中成药金标准」子集 ─────────────────────────────────────────────────
// 筛选判据与打分判据是同一条(isOutOfCatalogFormulaGold), 二者不会漂移。
function derivePatentSubset(sourceFile, outFile) {
  const source = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  const selected = source.cases
    .filter((c) => c.benchmarkKind === "formula" && !isGovernedFormula(goldFormulaName(c)))
    .map((c) => {
      const gold = goldFormulaName(c);
      const entry = (() => {
        try { return findLocalPatentMedicineEntry(gold); } catch { return undefined; }
      })();
      return {
        ...c,
        benchmarkTarget: "patent_medicine",
        // 说明书目录命中情况仅作人工复查线索, 不参与筛选(筛选判据只有"不在受治理饮片目录内")。
        patentIndexMatch: entry ? { name: entry.name, category: entry.category } : null,
        governedClassicBackbone: classicBackbone(gold) || null,
      };
    });
  // 目录外 ≠ 一定是中成药: 也可能是目录未收的经典方或合方(「麻杏石甘汤合苏葶丸」),
  // 甚至是题面解析残留(#306 金标准为「生品」)。这些例既查不到饮片目录也查不到说明书目录,
  // 单独列出供人工复查, 不在此处凭规则删除——删例会改变基准分母, 必须是有记录的人工决定。
  const unresolved = selected
    .filter((c) => !c.patentIndexMatch && !c.governedClassicBackbone)
    .map((c) => ({ no: c.no, gold: goldFormulaName(c) }));
  const payload = {
    note: [
      "中成药金标准子集: 从 web-cases-batch4-mcq.json 派生。",
      "筛选判据: benchmarkKind==\"formula\" 且金标准方名经 executableFormulaCompilationReferences 判定不在受治理饮片目录内。",
      "这批题只能由 M04 的 formula.patentAndWestern 回答, 必须跑全流程(不要设 WEB_CASES_STAGES=diagnose)。",
      "跑法(需已起服务器): WEB_CASES_FILE=artifacts/web-cases-batch4-patent.json WEB_CASES_DIR=<dir> node scripts/regress-web-cases.mjs",
      "再比对: node scripts/compare-benchmark-outputs.mjs artifacts/web-cases-batch4-patent.json <dir>",
      "重新生成本文件: node scripts/compare-benchmark-outputs.mjs --derive-patent-subset artifacts/web-cases-batch4-mcq.json artifacts/web-cases-batch4-patent.json",
    ].join(" "),
    derivedFrom: path.basename(sourceFile),
    selectionCriterion: "benchmarkKind==formula && !executableFormulaCompilationReferences(gold)",
    caseCount: selected.length,
    unresolvedGoldCases: unresolved,
    cases: selected,
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`派生 ${selected.length} 例中成药金标准题 → ${outFile}`);
  console.log(`  其中 ${selected.filter((c) => c.patentIndexMatch).length} 例金标准可在本地中成药说明书目录直接查到。`);
  console.log(`  ${unresolved.length} 例金标准两个目录都查不到, 需人工复查是否确为中成药题:`);
  console.log(`    ${unresolved.map((c) => `#${c.no} ${c.gold}`).join(" / ")}`);
}

const argv = process.argv.slice(2);
if (argv[0] === "--derive-patent-subset") {
  const [, sourceFile, outFile] = argv;
  if (!sourceFile || !outFile) {
    console.error("usage: node scripts/compare-benchmark-outputs.mjs --derive-patent-subset <benchmark.json> <out.json>");
    process.exit(2);
  }
  derivePatentSubset(sourceFile, outFile);
  process.exit(0);
}

const [benchFile, artifactDir] = argv;
if (!benchFile || !artifactDir) {
  console.error("usage: node scripts/compare-benchmark-outputs.mjs <benchmark.json> <artifactDir>");
  console.error("       node scripts/compare-benchmark-outputs.mjs --derive-patent-subset <benchmark.json> <out.json>");
  process.exit(2);
}
const cases = JSON.parse(fs.readFileSync(benchFile, "utf8")).cases;

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
  if (isOutOfCatalogFormulaGold(c)) {
    // 金标准是目录外方(多为中成药/合方): M03 的饮片锁定位结构上不可能命中它。
    // 正确的比对面是 M04 的中成药候选; 没跑 M04 的产物单独计数而不是记 0 分。
    return scorePatentMedicineCase(c, rec);
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
// 「口径不适用」与「答错」必须分开: 前者进 unscored, 不污染均分。
const unscoredByKind = {};
const lowScores = [];
let missing = 0;
for (const c of cases) {
  const f = path.join(artifactDir, `case-${c.no}.json`);
  if (!fs.existsSync(f)) { missing++; continue; }
  const rec = JSON.parse(fs.readFileSync(f, "utf8"));
  const { score, actual, kindOverride, unscored } = scoreCase(c, rec);
  const bucket = kindOverride || c.benchmarkKind;
  if (unscored) {
    (unscoredByKind[bucket] ||= []).push({ no: c.no, reason: actual });
    continue;
  }
  (byKind[bucket] ||= []).push(score);
  if (score < 0.4) {
    lowScores.push({
      no: c.no, kind: bucket,
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
for (const [kind, items] of Object.entries(unscoredByKind)) {
  console.log(`${kind}: n=${items.length} 未计分(口径不适用, 不计入任何均分) 例: ${items.slice(0, 8).map((i) => `#${i.no}`).join(" ")}`);
  console.log(`  原因: ${items[0]?.reason || ""}`);
}
console.log(`缺产物: ${missing}`);
console.log(`\n低分例(${lowScores.length}, 供误差类分析, 前20):`);
for (const l of lowScores.slice(0, 20)) {
  console.log(`  #${l.no} [${l.kind}] gold=${l.gold} | actual=${l.actual}`);
}
fs.writeFileSync(path.join(artifactDir, "benchmark-comparison.json"), JSON.stringify({
  byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { n: v.length, avg: avg(v), strict: v.filter((s) => s >= 0.99).length }])),
  unscoredByKind: Object.fromEntries(Object.entries(unscoredByKind).map(([k, v]) => [k, { n: v.length, cases: v }])),
  lowScores,
}, null, 2));
