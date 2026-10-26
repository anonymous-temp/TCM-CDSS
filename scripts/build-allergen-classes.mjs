// 致敏物质分类（src/data/allergen-classes.source.json，158KB，带出处与说明）→ 运行时精简表 src/data/allergen-classes.json。
// 交付面与开方合同会进页面打包，只读精简表。用法：node scripts/build-allergen-classes.mjs [--check]
import fs from "node:fs";
const SOURCE = "src/data/allergen-classes.source.json";
const OUTPUT = "src/data/allergen-classes.json";
const source = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
const uniq = (list) => [...new Set((list || []).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
const herbEntries = (list) => (list || []).flatMap((herb) => [herb.name, ...(herb.writtenVariants || []).map((variant) => variant.name)]
  .filter(Boolean).map((name) => ({ name: name.trim(), action: herb.action, ...(herb.sameAsFood?.length ? { sameAsFood: herb.sameAsFood } : {}) })));
const classes = source.classes.map((item) => ({
  id: item.id,
  labelZh: item.labelZh,
  recordTerms: uniq([...(item.recordTerms || []), ...(item.genericRecordTerms || [])]),
  genericRecordTerms: uniq(item.genericRecordTerms),
  intoleranceTerms: uniq(item.intoleranceTerms),
  singleCharTerms: uniq(item.singleCharTerms),
  foodTerms: uniq(item.foodTerms),
  cautionFoodTerms: uniq([...(item.cautionFoodTerms || []), ...(item.crossReactiveFoodTerms?.terms || [])]),
  excludeTerms: uniq([...(item.excludeTerms || []), ...(item.gbExemptTerms || [])]),
  herbs: [...herbEntries(item.herbs), ...herbEntries(item.crossReactiveHerbs).map((herb) => ({ ...herb, action: "caution" }))],
  ...(item.processedFormPattern ? { processedFormPattern: {
    prefixes: item.processedFormPattern.prefixes || [],
    exceptPrefixedNames: item.processedFormPattern.exceptPrefixedNames || [],
    alsoHoneyFried: item.processedFormPattern.alsoHoneyFried || [],
    notHoneyFried: item.processedFormPattern.notHoneyFried || [],
    action: item.processedFormPattern.action || "caution",
  } } : {}),
  medicineIngredientTerms: (item.medicineIngredientTerms || []).filter((entry) => entry?.term).map((entry) => ({ term: entry.term, action: entry.action || "caution" })),
  ...(item.intoleranceHandling ? { intoleranceHandling: { foodAction: item.intoleranceHandling.foodAction, herbAction: item.intoleranceHandling.herbAction, medicineAction: item.intoleranceHandling.medicineAction } } : {}),
  ...(item.umbrellaOf ? { umbrellaOf: item.umbrellaOf } : {}),
}));
// 病历里「这一句在说过敏」的提示词（过敏史一栏整行都算）。不耐受单列：按各类的 intoleranceHandling 处理。
const RECORD_CUES = ["过敏", "忌食", "不耐受", "不耐", "sIgE", "特异性IgE", "食物激发试验"];
// 单字词（鱼、虾、蛋…）只在紧跟这些字时算过敏记录（「对虾过敏」「鱼类过敏」）。
const SINGLE_CHAR_RECORD_FOLLOWERS = ["过敏", "类过敏", "等过敏", "及其制品过敏"];
const output = { generatedFrom: SOURCE, version: source.version, recordCues: RECORD_CUES, singleCharRecordFollowers: SINGLE_CHAR_RECORD_FOLLOWERS, classes };
const text = `${JSON.stringify(output)}\n`;
if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";
  if (current !== text) { console.error(`${OUTPUT} 与源表不同步，请运行 node scripts/build-allergen-classes.mjs`); process.exit(1); }
  console.log(JSON.stringify({ ok: true, classes: classes.length }));
} else {
  fs.writeFileSync(OUTPUT, text);
  console.log(JSON.stringify({ written: OUTPUT, classes: classes.length, bytes: text.length }));
}
