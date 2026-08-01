/**
 * Invariant: the M04「候选处方剂量限定名单」must equal what the code actually enforces.
 *
 * Why this test exists. The list is handed to M04 in categorical prohibition language
 * (「herbs[]只能选择本名单…未覆盖药味不得输出剂量或放入候选处方」) while the real gate,
 * doseWithinConservativeModelLimit, validates against every dose-resolvable 饮片. When the list was
 * built from data.commonHerbs — the 99-row `tcm_curated_llm_candidates` worklist whose every row
 * reads「待人工复核」— the emitted whitelist contained 马钱子/巴豆霜/斑蝥/朱砂/雄黄/蟾酥/轻粉/罂粟壳
 * but NOT 黄芪/白术/茯苓/当归/龙眼肉, and only 7 of 500 governed formulas had all ingredients inside
 * it. A model obeying that prohibition is being told to prescribe out of a toxicity list.
 *
 * The rule this locks: prompt scope == enforcement scope. A future edit that narrows the list back
 * to a curated subset fails here.
 */
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

const { buildTcmKnowledgeContext, getTcmHerbDoseLimit, clinicianDoseHerbClass } = await jiti.import("../src/lib/tcm-knowledge.ts");
const { createInitialCaseState } = await jiti.import("../src/lib/diagnosis-types.ts");
const knowledge = (await jiti.import("../src/data/tcm-knowledge.json", { default: true }));
const catalog = (await jiti.import("../src/data/tcm-formula-governed-catalog.json", { default: true }));
const governanceManifest = (await jiti.import("../src/data/clinical-governance-table-manifest.json", { default: true }));

const caseState = createInitialCaseState();
caseState.patient.sex = "女";
caseState.chiefComplaint = "入睡困难、多梦易醒3个月，乏力健忘，饭量减少";
caseState.conversation = [{ role: "user", content: caseState.chiefComplaint }];
const context = buildTcmKnowledgeContext(caseState, "prescribe");

const doseSection = context.split("候选处方剂量限定名单")[1]?.split("\n")[0] || "";
assert.ok(doseSection.length > 0, "prescribe context must carry the dose-limit list");

// 1. 组方基石药味必须在名单内。它们的缺席正是原缺陷的临床表现。
const CORE_TONICS = ["人参", "黄芪", "白术", "茯苓", "甘草", "当归", "白芍", "川芎", "熟地黄", "党参", "大枣", "龙眼肉"];
const missingTonics = CORE_TONICS.filter((herb) => !doseSection.includes(herb));
assert.deepEqual(
  missingTonics,
  [],
  `候选处方剂量限定名单缺少组方基石药味：${missingTonics.join("、")}。名单若来自「待人工复核」候选队列而非全部可解析剂量饮片，就会只剩毒性药而没有补益药。`,
);

// 2. 名单范围必须等于代码门禁范围，而不是 commonHerbs 子集。
const doseResolvable = knowledge.herbs.filter((herb) => {
  const limit = getTcmHerbDoseLimit(herb.name);
  return limit?.min != null && limit?.max != null;
});
const listed = doseResolvable.filter((herb) => doseSection.includes(herb.name));
assert.ok(
  listed.length >= doseResolvable.length * 0.98,
  `名单只覆盖 ${listed.length}/${doseResolvable.length} 味可解析剂量饮片；prompt 的禁止性措辞要求它等于代码校验范围`,
);
assert.ok(
  doseResolvable.length > knowledge.commonHerbs.length * 3,
  `可解析剂量饮片 ${doseResolvable.length} 味应远多于 commonHerbs ${knowledge.commonHerbs.length} 行；若接近说明又退回了候选队列`,
);

// 3. 毒性药可以在名单内（药典收载且有剂量），但必须逐条带毒性标注，不能与普通药味无差别并列。
for (const toxic of ["马钱子", "巴豆霜", "斑蝥"]) {
  if (!doseSection.includes(toxic)) continue;
  const segment = doseSection.split("；").find((row) => row.startsWith(toxic)) || "";
  assert.match(segment, /生成前安全:[^；]*毒性/, `${toxic} 出现在剂量名单中时必须带毒性标注`);
}

// 4. 端到端：整个方剂锁链路为之整改的归脾汤，其全部药味必须可解析剂量。
const guipi = catalog.entries.find((entry) => entry.name === "归脾汤");
assert.ok(guipi, "governed catalog must contain 归脾汤");
const guipiIngredients = (guipi.ingredients || []).map((item) => (typeof item === "string" ? item : item.name || item.herb || ""));
const unresolvable = guipiIngredients.filter((herb) => {
  const limit = getTcmHerbDoseLimit(herb);
  return !(limit?.min != null && limit?.max != null);
});
assert.deepEqual(unresolvable, [], `归脾汤 药味无法解析剂量：${unresolvable.join("、")}`);

const fullyCovered = catalog.entries.filter((entry) => {
  const ingredients = (entry.ingredients || []).map((item) => (typeof item === "string" ? item : item.name || item.herb || "")).filter(Boolean);
  return ingredients.length > 0 && ingredients.every((herb) => {
    const limit = getTcmHerbDoseLimit(herb);
    return limit?.min != null && limit?.max != null;
  });
}).length;
const governedDoseCompilationEligible = catalog.entries.filter((entry) => entry.doseCompilationEligible === true).length;
assert.ok(
  fullyCovered >= 300,
  `仅 ${fullyCovered} 个受控方剂的全部药味可解析剂量（修复前为 7，接入 T9 饮片名解析后为 327）；低于 300 说明剂量覆盖面又退化了`,
);
// 剂量豁免层启用后（甲方 2026-08-01 决策：降低门禁、审方兜底），编译许可数**必然**高于
// 「全部药味可解析剂量」数——差额正是那些无法定数值边界、改由医师确定用量的成分
//（琥珀、龙骨、粳米、朱砂…）。它们不再阻断出方，但也没有获得剂量背书：
// HIS 载荷按 clinicianDoseHerbClass 把它们标为 unverified_dose / toxic_regulated。
// 因此这里不再要求许可数 ≤ 可解析数，改为守住「差额全部来自豁免层」这条更强的不变量：
// 任何一首获许可却含**非豁免**未解析药味的方，都说明豁免链路漏了口子。
{
  const leaked = catalog.entries.filter((entry) => entry.doseCompilationEligible === true).filter((entry) => {
    const ingredients = (entry.ingredients || [])
      .map((item) => (typeof item === "string" ? item : item.name || item.herb || ""))
      .filter(Boolean);
    return ingredients.some((herb) => {
      const limit = getTcmHerbDoseLimit(herb);
      if (limit?.min != null && limit?.max != null) return false;
      return !clinicianDoseHerbClass(herb);
    });
  }).map((entry) => entry.name);
  assert.deepEqual(leaked.slice(0, 10), [],
    `获剂量编译许可的方中存在既无法定剂量、又不在医师定量豁免表内的药味（共 ${leaked.length} 首）`);
}
assert.equal(
  governedDoseCompilationEligible,
  governanceManifest.buildSummary.formulaDoseCompilationEligible,
  "M04 测试、T8 目录与治理 manifest 的剂量可编译统计口径必须一致",
);



// 5. T9 受控饮片名解析必须接进剂量层：经典方组成用的是饮片规格与古名。
for (const [input, canonical] of [["黄芩片", "黄芩"], ["附片", "附子"], ["山萸肉", "山茱萸"], ["麦门冬", "麦冬"], ["盐菟丝子", "菟丝子"], ["燀桃仁", "桃仁"], ["熟地", "熟地黄"]]) {
  const resolved = getTcmHerbDoseLimit(input);
  const target = getTcmHerbDoseLimit(canonical);
  assert.ok(resolved, `受控饮片名 ${input} 必须能解析剂量（T9 已将其映射到 ${canonical}）`);
  assert.equal(resolved.min, target?.min, `${input} 的剂量下限必须等于 ${canonical}`);
  assert.equal(resolved.max, target?.max, `${input} 的剂量上限必须等于 ${canonical}`);
}

// 6. Fail-closed：歧义名与毒性药生品不得因上述解析而获得剂量。
for (const ambiguousName of ["芍药", "贝母", "沙参"]) {
  assert.equal(getTcmHerbDoseLimit(ambiguousName), null, `${ambiguousName} 是歧义名（需医生指定具体品种），不得自动解析出剂量`);
}
for (const rawToxic of ["生川乌", "生草乌", "生半夏", "生附子"]) {
  assert.equal(getTcmHerbDoseLimit(rawToxic), null, `${rawToxic} 是毒性药生品，不得通过炮制前缀剥离获得内服剂量`);
}

console.log(JSON.stringify({
  doseResolvableHerbs: doseResolvable.length,
  curatedWorklistRows: knowledge.commonHerbs.length,
  ingredientDoseResolvableFormulas: fullyCovered,
  governedDoseCompilationEligible,
  coreTonicsPresent: CORE_TONICS.length - missingTonics.length,
  failures: 0,
}, null, 2));
