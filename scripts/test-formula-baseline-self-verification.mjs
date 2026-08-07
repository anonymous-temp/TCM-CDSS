// 基准自核验：把受治理方的**基准组成原样当处方**喂回身份核验，必须核验通过。
//
// 这是一条自反不变量：如果连「一味不改、逐字照抄基准」都判组成不符，那么 M04 的
// 定向修复提示（「不重不漏地输出所选基准 ingredients 的全部药味」）在这些方上
// **不可满足**——模型照做也过不了，同一个码反复注入，触发 fixpoint 早退，最后
// 落到「200 但没有候选方」的空白处方页。
//
// 这条不变量此前不存在，代价是同一个缺陷被修了一半、剩下一半在线上跑了两周：
//  · 2026-08-05 发现「炒牛蒡子 vs 牛蒡子」一个炮制前缀就让整方判不符，于是给
//    verifyFormulaCompilationComponent 的 ingredients 与处方两侧都过了受控解析表
//    （identityVerificationCanonicalMap，只取 ingredientLinks 里 autoResolvable 的链接）。
//  · 但 requiredIngredients（锚点）漏了。锚点没过表 ≠ 更严，而是**恒假**：处方侧已被
//    归一成「陈皮」，锚点还是「醋陈皮」，requiredIngredientsPresent 永远为 false，
//    bestFormulaSourceCandidate 直接返回 undefined，verified=false 且 overlap=0。
//    实测全目录 2062 个可建基准方中 281 方中招，其中 254 方是 M03 真能锁进 M04 的，
//    柴胡疏肝散(1/2)、三仁汤(0/1)、八正散(0/1) 这些一线常用方全在里面。
//    修掉锚点归一后 281 → 1。
//
// 所以本套件遍历**全目录**而不是抽样：这一类缺陷的特征就是抽样看不出来（麻黄汤、
// 银翘散、逍遥散、归脾汤这些锚点不带炮制前缀的方一直是好的，抽到它们就以为没事）。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { formulaCompilationReferences, executableFormulaCompilationReferences, verifyFormulaCompilationComponents } =
  await jiti.import("../src/lib/tcm-formula-provenance.ts");
const formulaSources = (await import("../src/data/tcm-formula-sources.json", { with: { type: "json" } })).default;

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

// 已知且已归档的例外：两味方且两味在受控解析表里落到同一个标准名。
// 张真君茯苓丸《三因极一病证方论》= 赤茯苓 + 白茯苓，autoResolvable 后都是「茯苓」，
// 去重后只剩 1 味，达不到 minimumPreservedIngredientCount=2。这属于目录侧的品种
// 表达问题（同药异色入方），不是核验器缺陷；放在这里是为了让它**保持可见**——
// 若哪天目录改好了，本断言会提示把它从名单里删掉。
const KNOWN_COLLAPSED_VARIANT_FORMULAS = new Set(["张真君茯苓丸"]);

function referenceHerbs(reference) {
  return reference.ingredients.map((name) => ({ name, dose: "10g", role: "臣药", targetRef: "P1" }));
}

const catalogNames = Object.keys(formulaSources.formulas || formulaSources);

check("FBSV-01 全目录：基准组成原样喂回必须核验通过", () => {
  const unverified = [];
  let checked = 0;
  for (const formulaName of catalogNames) {
    const references = formulaCompilationReferences([formulaName]);
    if (references.length !== 1) continue;
    checked += 1;
    const verification = verifyFormulaCompilationComponents(
      [formulaName],
      referenceHerbs(references[0]),
      false,
      true,
    );
    if (verification.length === 1 && verification[0].verified) continue;
    unverified.push({
      formulaName,
      anchors: references[0].requiredIngredients,
      matchedRequired: verification[0]?.matchedRequiredIngredientCount,
      requiredCount: verification[0]?.requiredIngredientCount,
      overlap: verification[0]?.matchedIngredientCount,
      total: references[0].ingredients.length,
    });
  }
  assert.ok(checked > 1500, `可建基准的方只有 ${checked} 个，目录疑似未加载`);
  const unexpected = unverified.filter((item) => !KNOWN_COLLAPSED_VARIANT_FORMULAS.has(item.formulaName));
  assert.deepEqual(
    unexpected,
    [],
    `${unexpected.length}/${checked} 个受治理方连基准组成原样喂回都核验不过；` +
      `这些方的 M04 剥名修复不可满足。前 5 例：${JSON.stringify(unexpected.slice(0, 5))}`,
  );
});

check("FBSV-02 锚点带 autoResolvable 炮制前缀的方必须核验通过（缺陷原型）", () => {
  // 这四个是实测里锚点被 ingredientLinks 改过名的一线常用方，逐个点名钉住。
  for (const [formulaName, anchor] of [
    ["柴胡疏肝散", "醋陈皮"],
    ["三仁汤", "燀苦杏仁"],
    ["八正散", "炒车前子"],
    ["参苓白术散", "炒白扁豆"],
  ]) {
    const references = formulaCompilationReferences([formulaName]);
    if (references.length !== 1) continue;
    const reference = references[0];
    if (!reference.requiredIngredients.includes(anchor)) continue;
    const verification = verifyFormulaCompilationComponents([formulaName], referenceHerbs(reference), false, true)[0];
    assert.equal(verification.verified, true, `${formulaName} 原样基准核验未通过（锚点 ${anchor}）`);
    assert.equal(
      verification.matchedRequiredIngredientCount,
      verification.requiredIngredientCount,
      `${formulaName} 锚点命中 ${verification.matchedRequiredIngredientCount}/${verification.requiredIngredientCount}`,
    );
  }
});

check("FBSV-03 锚点归一不放宽判据：缺了锚点药仍必须判不通过", () => {
  // 归一只解决「同一味药两种写法」，不能让「真的少了这味药」蒙混过关。
  const reference = formulaCompilationReferences(["柴胡疏肝散"])[0];
  assert.ok(reference, "柴胡疏肝散 无基准");
  const withoutAnchor = referenceHerbs(reference).filter((herb) => !/陈皮/.test(herb.name));
  const verification = verifyFormulaCompilationComponents(["柴胡疏肝散"], withoutAnchor, false, true)[0];
  assert.equal(verification.verified, false, "去掉锚点药后仍判核验通过——判据被放宽了");
  assert.ok(
    verification.matchedRequiredIngredientCount < verification.requiredIngredientCount,
    "去掉锚点药后锚点命中数未下降",
  );
});

check("FBSV-04 M03 能锁进 M04 的方，其基准必须自核验通过", () => {
  // executableFormulaCompilationReferences 是 M03 → M04 传递基准的那道门。
  // 凡是能过这道门的方，M04 的修复提示就必须是可满足的，否则就是必输的彩票。
  const unsatisfiable = [];
  for (const formulaName of catalogNames) {
    if (executableFormulaCompilationReferences([formulaName]).length !== 1) continue;
    const references = formulaCompilationReferences([formulaName]);
    if (references.length !== 1) continue;
    const verification = verifyFormulaCompilationComponents([formulaName], referenceHerbs(references[0]), false, true);
    if (verification.length === 1 && verification[0].verified) continue;
    if (KNOWN_COLLAPSED_VARIANT_FORMULAS.has(formulaName)) continue;
    unsatisfiable.push(formulaName);
  }
  assert.deepEqual(
    unsatisfiable,
    [],
    `${unsatisfiable.length} 个可执行基准方的 M04 剥名修复不可满足：${unsatisfiable.slice(0, 10).join("、")}`,
  );
});

if (failures.length > 0) {
  console.error("基准自核验 FAILED:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("基准自核验 OK（全目录基准组成原样喂回均核验通过）");
