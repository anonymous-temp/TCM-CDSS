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

const { buildTcmKnowledgeContext, getTcmHerbDoseLimit } = await jiti.import("../src/lib/tcm-knowledge.ts");
const { createInitialCaseState } = await jiti.import("../src/lib/diagnosis-types.ts");
const knowledge = (await jiti.import("../src/data/tcm-knowledge.json", { default: true }));
const catalog = (await jiti.import("../src/data/tcm-formula-governed-catalog.json", { default: true }));

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
assert.ok(
  fullyCovered >= 150,
  `仅 ${fullyCovered} 个受控方剂的全部药味可解析剂量（修复前为 7）；低于 150 说明剂量覆盖面又退化了`,
);

console.log(JSON.stringify({
  doseResolvableHerbs: doseResolvable.length,
  curatedWorklistRows: knowledge.commonHerbs.length,
  governedFormulasFullyDosable: fullyCovered,
  coreTonicsPresent: CORE_TONICS.length - missingTonics.length,
  failures: 0,
}, null, 2));
