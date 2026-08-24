// CHP2020-FUNCTION-20260814 离线发布闸门。
// 联网采集脚本负责来源回查；本套件负责保证已落库快照的数量、证据链、身份边界与运行时效果。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const source = JSON.parse(readFileSync(
  path.join(repoRoot, "src/data/tcm-herb-function-supplements.source.json"),
  "utf8",
));
const BATCH_ID = "CHP2020-FUNCTION-20260814";
const batch = (source.entries || []).filter((entry) => entry.reviewBatch === BATCH_ID);
const regressionBatch = (source.entries || []).filter(
  (entry) => entry.reviewBatch === "CHP2020-FUNCTION-REGRESSION-20260814",
);

const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { affirmedTcmTherapyConcepts } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const { getTcmHerbFunctionText, getTcmHerbFunctionDisplayText } = await jiti.import("../src/lib/tcm-knowledge.ts");

assert.equal(batch.length, 84, "药典功效治理批次必须恰好 84 味");
assert.equal(new Set(batch.map((entry) => entry.herb)).size, batch.length, "批次内药名不得重复");
assert.equal(new Set((source.entries || []).map((entry) => entry.herb)).size, (source.entries || []).length,
  "补充表全局药名不得重复");

const identityForks = new Set(["芍药", "贝母", "沙参", "皂角", "菖蒲", "紫苏"]);
for (const [index, entry] of batch.entries()) {
  assert.ok(!identityForks.has(entry.herb), `${entry.herb} 是身份分叉名，不得做全局功效补录`);
  assert.ok(entry.supplement.length >= 4 && entry.supplement.length <= 60, `${entry.herb} 功效长度异常`);
  assert.doesNotMatch(entry.supplement, /用于|主治|治疗|适用于|[，。；;]$/,
    `${entry.herb} 功效段混入主治或尾标点`);
  assert.equal(entry.sourceName, "国家药典委员会药典在线", `${entry.herb} 来源名`);
  assert.equal(
    entry.sourceUrl,
    `https://ydz.chp.org.cn/#/item?bookId=1&entryId=${entry.chpEntryId}`,
    `${entry.herb} 词条 URL 与 entryId 不一致`,
  );
  assert.ok(Number.isInteger(entry.chpEntryId) && entry.chpEntryId > 0, `${entry.herb} entryId 非法`);
  assert.ok(entry.chpQuote.startsWith(`${entry.supplement}。`), `${entry.herb} 功效不是药典引文前缀`);
  assert.ok(entry.chpQuote.includes("用于"), `${entry.herb} 引文缺失功能/主治分界`);
  assert.ok(entry.basis.includes(entry.chpQuote), `${entry.herb} basis 未携带原文`);
  assert.ok(entry.basis.includes(`「${entry.herb}」`), `${entry.herb} basis 未绑定词条名`);
  assert.ok(Number.isInteger(entry.corpusUseCount) && entry.corpusUseCount >= 0, `${entry.herb} 频次非法`);
  if (index > 0) {
    assert.ok(batch[index - 1].corpusUseCount >= entry.corpusUseCount, "批次必须保持语料频次降序");
  }
  const concepts = affirmedTcmTherapyConcepts(entry.supplement);
  assert.ok(concepts.has(entry.missingConcept), `${entry.herb} 声明的治法概念无法从功效正文重算`);

  const runtimeText = String(getTcmHerbFunctionText(entry.herb) || "");
  assert.ok(runtimeText.includes(entry.supplement), `${entry.herb} 补充文本未进入运行时知识出口`);
  assert.ok(
    runtimeText.split(/[；;，,、]/).map((item) => item.trim()).filter(Boolean).some((item) => !/药$/.test(item)),
    `${entry.herb} 运行时仍只有分类标签`,
  );
}

const byHerb = new Map(batch.map((entry) => [entry.herb, entry]));
assert.equal(byHerb.get("僵蚕")?.supplement, "息风止痉，祛风止痛，化痰散结");
assert.equal(byHerb.get("地龙")?.supplement, "清热定惊，通络，平喘，利尿");

const multiroleBatch = (source.entries || []).filter(
  (entry) => entry.reviewBatch === "CHP2020-FUNCTION-MULTIROLE-20260824",
);
assert.deepEqual(multiroleBatch.map((entry) => entry.herb), ["葛根", "升麻"]);
for (const entry of multiroleBatch) {
  assert.equal(entry.sourceName, "国家药典委员会药典在线");
  assert.equal(entry.sourceUrl, `https://ydz.chp.org.cn/#/item?bookId=1&entryId=${entry.chpEntryId}`);
  assert.ok(entry.chpQuote.startsWith(`${entry.supplement}。`));
  for (const clause of entry.supplement.split("，")) {
    assert.match(getTcmHerbFunctionText(entry.herb), new RegExp(clause));
  }
}
assert.equal(multiroleBatch.find((entry) => entry.herb === "升麻")?.chpEntryId, 107);
assert.equal(multiroleBatch.find((entry) => entry.herb === "葛根")?.chpEntryId, 527);

const jiangcanDisplay = getTcmHerbFunctionDisplayText("炒僵蚕", "臣", "肝风夹痰", "息风止痉");
const dilongDisplay = getTcmHerbFunctionDisplayText("地龙", "佐", "络脉阻滞", "清热通络");
assert.doesNotMatch(jiangcanDisplay, /具体配伍作用需医生结合方义复核/);
assert.doesNotMatch(dilongDisplay, /具体配伍作用需医生结合方义复核/);
assert.match(jiangcanDisplay, /息风止痉|化痰散结/);
assert.match(dilongDisplay, /清热定惊|通络/);

assert.deepEqual(regressionBatch.map((entry) => entry.herb), ["制何首乌", "羚羊角"]);
const preparedHeshouwu = regressionBatch.find((entry) => entry.herb === "制何首乌");
assert.equal(preparedHeshouwu.chpEntryId, 272);
assert.equal(preparedHeshouwu.supplement, "补肝肾，益精血，乌须发，强筋骨，化浊降脂");
assert.match(getTcmHerbFunctionText("制何首乌"), /补肝肾.*益精血/);
assert.doesNotMatch(
  getTcmHerbFunctionDisplayText("制何首乌", "佐", "肝肾亏虚，精血不足", "补肝肾，益精血"),
  /具体配伍作用需医生结合方义复核/,
);
const antelopeHorn = regressionBatch.find((entry) => entry.herb === "羚羊角");
assert.equal(antelopeHorn.chpEntryId, 515);
assert.equal(antelopeHorn.supplement, "平肝息风，清肝明目，散血解毒");
assert.match(getTcmHerbFunctionText("羚羊角"), /平肝息风.*清肝明目/);

console.log(JSON.stringify({
  suite: "chp-herb-function-supplements",
  batchId: BATCH_ID,
  entries: batch.length,
  criticalPlaceholdersRemoved: ["炒僵蚕", "地龙", "制何首乌", "羚羊角"],
}));
