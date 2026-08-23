// 药味功效串的**跨药串味**检测（2026-08-11 线上实测）。
//
// 甲方实测：平肝潜阳方里，石决明被解释成「祛风止痒」、牛膝被解释成「消肿止痛、排脓止痛」。
// 根因不在展示层，在编译产物：石决明的 functionText 与**千里光**首段逐字相同——
// 身份目录里两者互为别名（石决明的本草别名正是千里光），上游按别名图把菊科草药千里光的
// 功效整段贴到了鲍鱼壳石决明上，连 primaryCategory 都一并变成「清热药」。
//
// 这类污染此前完全隐形：功效串是自由文本，没有任何断言看它属不属于这味药。
// 本套件把它变成可枚举的：凡是「A 的整段功效串 = B 的某一段，且 A/B 在身份目录里因别名互指」
// 的组合一律列出来。命中不等于一定错（同基原不同药用部位可能确实共享功效），
// 因此判据是**白名单登记制**：要么在 CONTROLLED_HERB_FUNCTION_TEXT 里给出药典原文覆盖，
// 要么在下面的 ACCEPTED_SHARED_FUNCTION_TEXT 里逐条登记为何可以共享。两者都没有就红。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const knowledge = JSON.parse(readFileSync(new URL("../src/data/tcm-knowledge.json", import.meta.url), "utf8"));
const identity = JSON.parse(readFileSync(new URL("../src/data/tcm-herb-identity-catalog.json", import.meta.url), "utf8"));
const { getTcmHerbFunctionCategories, getTcmHerbFunctionText, getTcmHerbRiskProfile } = await import("../src/lib/tcm-knowledge.ts");

/**
 * 已登记的可共享功效串。每条必须写明**为什么**两味药可以共享同一段功效文本，
 * 「看起来差不多」不是理由。
 */
const ACCEPTED_SHARED_FUNCTION_TEXT = new Map([
  ["白果|银杏叶", "同一植物（银杏）的种仁与叶，编译源对两者收录了同一段功效摘要；两者的剂量与毒性边界各自独立，不受此表影响。"],
  ["牵牛子|牵牛", "同一味药的两种写法（牵牛子的简称），非跨药串味。"],
]);

const functionRows = [];
for (const herb of knowledge.herbs || []) {
  for (const entry of herb.entries || []) {
    if (entry.type === "herbRisk" && typeof entry.functionText === "string" && entry.functionText.trim()) {
      functionRows.push({ name: herb.name, text: entry.functionText.trim() });
    }
  }
}
assert.ok(functionRows.length >= 300, `功效串样本过小（${functionRows.length}），本套件形同虚设`);

// 身份目录里因别名互指的药对：这是串味发生的通道。
const aliasLinked = new Set();
const link = (a, b) => { if (a && b && a !== b) aliasLinked.add([a, b].sort().join("|")); };
// ① standardName ↔ 它登记的每一个别名。石决明的 variants 里赫然写着「千里光」——
//    这正是本次串味的通道：菊科草药与鲍鱼壳被登记成了同一味药的异名。
const standardNames = new Set((identity.entries || []).map((row) => row?.standardName).filter(Boolean));
for (const row of identity.entries || []) {
  for (const variant of row?.variants || []) {
    const name = typeof variant === "string" ? variant : variant?.name;
    // 只在别名本身也是另一味**正名**时才算「两味药被别名连起来」。
    if (standardNames.has(name)) link(row.standardName, name);
  }
}
// ② 一个输入名指向多味正名（歧义组）：同样是串味通道。
for (const item of identity.ambiguities || []) {
  const candidates = Array.isArray(item?.candidates) ? item.candidates : [];
  for (const a of candidates) for (const b of candidates) link(a, b);
}

// 「A 的整段功效串 == B 的某一段」——按全角分号切段，与编译产物的拼接方式一致。
const segmentsOf = (text) => text.split(/[；;]/).map((part) => part.trim()).filter(Boolean);
const contaminated = [];
for (const outer of functionRows) {
  for (const inner of functionRows) {
    if (outer.name === inner.name) continue;
    const innerSegments = segmentsOf(inner.text);
    if (innerSegments.length < 2) continue;
    if (!innerSegments.includes(outer.text.trim())) continue;
    const key = [outer.name, inner.name].sort().join("|");
    if (ACCEPTED_SHARED_FUNCTION_TEXT.has(key)) continue;
    // 已由受控药典原文覆盖的药味不再计入：运行时读到的是药典文本，编译产物已被短路。
    const runtime = getTcmHerbFunctionText(outer.name) || "";
    if (runtime && !runtime.startsWith(outer.text.trim())) continue;
    contaminated.push({ herb: outer.name, borrowedFrom: inner.name, aliasLinked: aliasLinked.has(key), text: outer.text });
  }
}

const unique = [...new Map(contaminated.map((item) => [`${item.herb}|${item.borrowedFrom}`, item])).values()];
assert.deepEqual(
  unique.map((item) => `${item.herb} 的功效串整段等于 ${item.borrowedFrom} 的一段${item.aliasLinked ? "（两者在身份目录里因别名互指）" : ""}`),
  [],
  "存在跨药串味的功效串：要么在 CONTROLLED_HERB_FUNCTION_TEXT 补药典原文覆盖，要么在 ACCEPTED_SHARED_FUNCTION_TEXT 逐条登记理由",
);

// 甲方实测的两味必须逐字回到药典功用，且不得再出现借来的动词。
for (const [herb, mustInclude, mustNotInclude] of [
  ["石决明", ["平肝潜阳", "清肝明目"], ["祛风止痒", "解毒消肿"]],
  ["牛膝", ["逐瘀通经", "引血下行"], ["排脓止痛", "消肿解毒"]],
  ["川牛膝", ["逐瘀通经", "通利关节"], ["排脓止痛"]],
  ["桔梗", ["宣肺", "利咽", "祛痰", "排脓"], ["清利头目", "养血", "补血气"]],
]) {
  const text = getTcmHerbFunctionText(herb) || "";
  for (const fragment of mustInclude) {
    assert.ok(text.includes(fragment), `${herb} 的功效应含药典原文「${fragment}」，实际：${text}`);
  }
  for (const fragment of mustNotInclude) {
    assert.ok(!text.includes(fragment), `${herb} 的功效不得含借自别味药的「${fragment}」，实际：${text}`);
  }
}

assert.deepEqual(getTcmHerbFunctionCategories("桔梗"), ["化痰止咳平喘药"],
  "桔梗不得继续继承生成库里错误的清化热痰分类");
assert.doesNotMatch(getTcmHerbRiskProfile("桔梗"), /清化热痰|清热药/,
  "风险画像尾部不得把已纠正的错误分类重新注入方向门禁");

console.log(JSON.stringify({
  suite: "herb-function-cross-contamination",
  functionRows: functionRows.length,
  aliasLinkedPairs: aliasLinked.size,
  acceptedSharedPairs: ACCEPTED_SHARED_FUNCTION_TEXT.size,
  contaminated: unique.length,
  failures: 0,
}));
