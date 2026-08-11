// 经方可追溯率的根因回归（2026-08-11）。
//
// 甲方 0807 起的最大遗留项是「经方可追溯率」。50 例基层实测把它拆成了三条**确定性**缺陷，
// 都不是模型质量问题：
//
//  ① 同一个问题「这张处方是不是 X 方」有两个互不相识的判官。
//     身份判官 verifyFormulaCompilationComponent 读受治理编译目录，两侧过 ingredientLinks
//     受控解析表，认党参代人参、认品种等价；出处判官 resolveFormulaSources 读另外三张名录目录，
//     两张表没有的方就查不到。实测 15 个带方名的候选里 10 个被出处判官判 ∅，而身份判官
//     对这 10 个全部 verified。
//  ② 出处判官判 ∅ 时，enrichReasoning 把它当成「这不是经方」，把方名改写成「本例辨证组方」、
//     constructionType 降为 self_devised。
//  ③ 最后一公里的身份恢复只补 name/formulaNames/constructionType，既不补 formulaSource，
//     也发生在可见正文重建**之后**。于是同一份响应两个答案：医生页面「自拟方」，
//     签名载荷与 HIS「四君子汤加减」。50 例里页面 34/39 显示自拟方，其中 10 例是标准经方。
//
// 本套件钉住收敛后的三条不变量，避免任何一条再被拆开各写各的。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  enrichPrescriptionProvenance,
  formulaCompilationReferences,
  resolveFormulaSources,
  restoreGovernedFormulaIdentity,
  verifyFormulaCompilationComponents,
} = await import("../src/lib/tcm-formula-provenance.ts");
const { applyDeterministicHerbFunctions, synchronizeVisibleClinicalSummary } = await import("../src/lib/diagnosis-visible-summary.ts");

const herbs = (...names) => names.map((name) => ({ name }));
let failures = 0;
const check = (fn, label) => {
  try { fn(); } catch (error) {
    failures += 1;
    console.error(`✗ ${label}\n  ${error.message}`);
  }
};

// ── 不变量 1：身份判官接受的组成，出处判官必须也接受 ────────────────────────────
//
// 这是①的直接钉子。判据方向是单向的：verified ⇒ 有出处。反向不要求（名录目录里
// 命中一个身份判官管不到的变体版本是允许的）。
const governedCatalog = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-governed-catalog.json", import.meta.url), "utf8"));
const governedRows = Array.isArray(governedCatalog.formulas)
  ? governedCatalog.formulas
  : Object.values(governedCatalog.formulas || governedCatalog.entries || {});
let scanned = 0;
const divergent = [];
for (const row of governedRows) {
  const name = String(row?.name || "");
  if (!name) continue;
  const [reference] = formulaCompilationReferences([name]);
  if (!reference || reference.ingredients.length < 2) continue;
  scanned += 1;
  const baseline = herbs(...reference.ingredients);
  const [verification] = verifyFormulaCompilationComponents([name], baseline, false, false);
  if (!verification?.verified) continue;
  if (resolveFormulaSources(name, baseline).length === 0) divergent.push(name);
}
check(() => {
  assert.ok(scanned >= 500, `受治理编译基准样本过小（${scanned}），本不变量形同虚设`);
  assert.deepEqual(
    divergent.slice(0, 20),
    [],
    `身份核验通过却拿不到出处的方（前 20 个，共 ${divergent.length} 个）：这正是两个判官各写各的`,
  );
}, `不变量 1：${scanned} 个受治理基准上「核验通过 ⇒ 有出处」`);

// ── 50 例实测里被判 ∅ 的 10 个方，逐个具名钉住 ─────────────────────────────────
//
// 具名而不只靠上面的全量扫描：全量扫描喂的是基准组成本身，而这 10 例是真实处方
// （党参代人参、加味、减味），走的是不同的判据分支。
const MEASURED = [
  ["参苓白术散", ["人参", "白术", "茯苓", "山药", "薏苡仁", "白扁豆", "莲子", "砂仁", "桔梗", "炙甘草"], "《太平惠民和剂局方》"],
  ["四君子汤加减", ["党参", "白术", "茯苓", "炙甘草"], "《太平惠民和剂局方》"],
  ["异功散加减", ["党参", "白术", "茯苓", "黄芪", "陈皮", "炙甘草"], "《小儿药证直诀》"],
  ["五子衍宗丸加减", ["菟丝子", "枸杞子", "覆盆子", "五味子", "车前子", "淫羊藿", "巴戟天", "香附", "当归", "炙甘草"], "《医学入门》"],
  ["缩泉丸加味", ["黄芪", "山药", "益智", "乌药", "茯苓", "甘草"], "《魏氏家藏方》"],
  ["五磨饮子加减", ["木香", "枳实", "槟榔", "乌药", "火麻仁", "大黄", "厚朴", "陈皮", "甘草"], "《医方集解》"],
  ["六神散加减", ["党参", "白术", "茯苓", "山药", "薏苡仁", "白扁豆", "砂仁", "炙甘草"], "《三因极一病证方论》"],
  ["杏仁煎加减", ["苦杏仁", "桑白皮", "紫菀", "五味子", "木通", "生姜", "蜂蜜", "砂糖"], "《三因极一病证方论》"],
  ["四神散加味", ["肉桂", "当归", "川芎", "五灵脂", "延胡索", "干姜", "白芍", "甘草"], "《三因极一病证方论》"],
  ["调经方加味", ["延胡索", "川芎", "当归", "香附", "枳壳", "甘草"], "《惠直堂经验方》"],
];
for (const [name, composition, expectedSource] of MEASURED) {
  check(() => {
    const resolved = resolveFormulaSources(name, herbs(...composition));
    assert.equal(resolved.length, 1, `${name} 必须解析出唯一出处，实际 ${resolved.length} 条`);
    assert.ok(
      resolved[0].source.includes(expectedSource),
      `${name} 出处应含 ${expectedSource}，实际「${resolved[0].source}」`,
    );
  }, `50 例实测：${name} 拿得到方剂出处`);
}

// ── 放宽边界：三族既有防护一字未减 ──────────────────────────────────────────────
const sanjia = formulaCompilationReferences(["三甲复脉汤"])[0];
check(() => {
  assert.deepEqual(
    resolveFormulaSources("三甲复脉汤", herbs(...sanjia.ingredients.map((n) => (n === "炙甘草" ? "甘草" : n)))),
    [],
    "未标炮制的甘草不得继承炙甘草基准的经典出处",
  );
}, "边界：炮制身份仍然严格");
const qinggu = formulaCompilationReferences(["清骨散"])[0];
check(() => {
  assert.deepEqual(resolveFormulaSources("清骨散加减", herbs(...qinggu.ingredients.slice(0, 6))), [], "低于最低保留数仍不得给出处");
  assert.deepEqual(
    resolveFormulaSources("清骨散加减", herbs(...qinggu.ingredients.filter((n) => !qinggu.requiredIngredients.includes(n)))),
    [],
    "缺身份锚点药仍不得给出处",
  );
}, "边界：最低保留数与锚点药仍然严格");
check(() => {
  const qingwei = formulaCompilationReferences(["清胃散"])[0];
  const resolved = resolveFormulaSources("清胃散", herbs(...qingwei.ingredients.map((n) => (n === "当归身" ? "当归" : n))));
  assert.equal(resolved.length, 1, "药用部位差异照给身份");
  assert.equal(resolved[0].exactComposition, false, "药用部位差异不得判逐字一致");
  assert.equal(resolveFormulaSources("清胃散", herbs(...qingwei.ingredients))[0]?.exactComposition, true, "原样基准仍判逐字一致");
}, "边界：受控解析表授予身份但不授予逐字一致");

// ── 不变量 2：恢复身份的那一次核验，必须同时给出出处 ────────────────────────────
const candidateFixture = (name, composition) => ({
  name,
  formulaNames: [],
  constructionType: "self_devised",
  modificationStatus: "modified",
  therapyMatch: "健脾益气",
  formulaAnalysis: "健脾益气为主",
  applicable: "适用于脾气亏虚证。",
  notApplicable: "证候变化时暂停采用，并重新辨证。",
  formulaSource: { evidenceLevel: "model_inference", source: "本例证候、病机、治法与药味功效的结构化匹配（病例内推理，需医生复核）", confidence: "中" },
  baseFormulas: [],
  herbs: composition.map((herbName) => ({ name: herbName, dose: "9g" })),
});
const prescribeFixture = (name, composition) => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  overview: { primarySyndrome: "脾气亏虚证", overallPathogenesis: "脾气亏虚，运化失健" },
  formula: { candidates: [candidateFixture(name, composition)] },
});
const priorFixture = (names, mode = "single") => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { recommendedFormulaNames: names, formulaSelectionMode: mode },
});

check(() => {
  const restored = restoreGovernedFormulaIdentity(
    prescribeFixture("本例辨证组方", ["党参", "白术", "茯苓", "炙甘草"]),
    priorFixture(["四君子汤"]),
  ).formula.candidates[0];
  assert.equal(restored.formulaNames.length, 1, "M03 锁定方名且组成核验通过时必须恢复身份");
  assert.notEqual(restored.formulaSource.evidenceLevel, "model_inference", "恢复身份的同一次核验必须写回出处，不能留 model_inference");
  assert.ok(restored.formulaSource.source.includes("《太平惠民和剂局方》"), `出处应逐字来自受治理目录，实际「${restored.formulaSource.source}」`);
  assert.equal(restored.baseFormulas.length, 1, "恢复身份时必须同时给出基准方核验明细");
  assert.equal(restored.baseFormulas[0].verificationStatus, "verified_individually");
}, "不变量 2a：M03 锁定方名这一路，恢复身份即给出处");

check(() => {
  const restored = restoreGovernedFormulaIdentity(
    prescribeFixture("本例辨证组方", ["麻黄", "桂枝", "苦杏仁", "炙甘草"]),
    priorFixture([], "self_devised"),
  ).formula.candidates[0];
  assert.ok(restored.formulaNames.length === 1, "M03 未锁方名时按组成反查仍须恢复身份");
  assert.notEqual(restored.formulaSource.evidenceLevel, "model_inference", "按组成反查恢复的身份同样必须带出处");
}, "不变量 2b：按组成反查这一路，恢复身份即给出处");

check(() => {
  const untouched = restoreGovernedFormulaIdentity(
    prescribeFixture("本例辨证组方", ["山药", "麦芽", "鸡内金", "陈皮"]),
    priorFixture(["五皮散"]),
  ).formula.candidates[0];
  assert.equal(untouched.formulaNames.length, 0, "组成核验不过时绝不恢复身份");
  assert.equal(untouched.formulaSource.evidenceLevel, "model_inference", "不恢复身份就不得凭空补出处");
}, "不变量 2c：核验不过既不给方名也不给出处（fail-closed 方向不变）");

// ── 不变量 3：医生页面与签名载荷对同一张方给同一个答案 ──────────────────────────
//
// 钉的是路由里 enrich → 恢复身份 → 重建可见正文 的**顺序**。顺序一旦倒回去，
// 页面会重新显示「自拟方」而载荷显示经方名，这条断言立刻红。
const renderStream = (reasoning) => [
  "# 候选方药",
  "",
  `## ${reasoning.formula.candidates[0].name}`,
  "",
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify(reasoning, null, 2),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n");

for (const [label, name, composition, prior] of [
  ["M03 锁定四君子汤 + 党参代人参", "本例辨证组方", ["党参", "白术", "茯苓", "炙甘草"], priorFixture(["四君子汤"])],
  ["M03 未锁方名 + 组成即麻黄汤", "本例辨证组方", ["麻黄", "桂枝", "苦杏仁", "炙甘草"], priorFixture([], "self_devised")],
]) {
  check(() => {
    const enriched = enrichPrescriptionProvenance(renderStream(prescribeFixture(name, composition)), "");
    const finalized = applyDeterministicHerbFunctions(enriched, { fillRolePlaceholder: true });
    const restored = restoreGovernedFormulaIdentity(JSON.parse(
      finalized.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/)[1],
    ), prior);
    const synchronized = synchronizeVisibleClinicalSummary(renderStream(restored), "prescribe");
    const visible = synchronized.split("<!-- DIAGNOSIS_JSON_START -->")[0];
    const payloadName = restored.formula.candidates[0].name;
    assert.ok(visible.includes(`## ${payloadName}`), `可见正文标题必须与载荷方名一致：载荷「${payloadName}」`);
    assert.ok(!/\*\*方案类型\*\*：自拟方/.test(visible), "载荷已是命名方时，页面不得仍写自拟方");
    assert.match(visible, /\*\*方剂出处\*\*：/, "命名方的页面必须打印方剂出处");
  }, `不变量 3：${label} —— 页面与载荷同一个答案`);
}

if (failures > 0) {
  console.error(`\n经方可追溯率收敛回归失败 ${failures} 项`);
  process.exit(1);
}
console.log(JSON.stringify({
  governedBaselinesScanned: scanned,
  measuredFormulas: MEASURED.length,
  failures: 0,
}));
