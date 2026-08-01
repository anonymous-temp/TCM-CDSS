/**
 * Invariant: 同一个药名在「存在性 / 功用 / 剂量」三个查询上的答案必须一致。
 *
 * isKnownTcmHerbName 此前不查 T9 受控饮片名解析，而功用层（getTcmHerbFunctionText）与剂量层
 * （canonicalKnowledgeHerbName）都查——于是 桂心/黄芩片/山萸肉/麦门冬 这类饮片名功用查得到、
 * 剂量算得出，"存在性"却答否。实测受治理经典方基准组成里 333 个饮片名被误报"知识库未收"
 * （覆盖 1644 张可编译方，桂心出现在 80 张、黄芩片 58 张、杏仁 54 张），验证器据此驳回整方，
 * 排查时也被它误导。
 *
 * 类级锁法：不点名单个药，而是断言**每一张可编译受治理方的每一味基准组成**都必须 isKnown——
 * 以后无论多少张方、多少个饮片写法，进了可编译目录就自动被这条覆盖。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isKnownTcmHerbName, getTcmHerbFunctionText, getTcmHerbFunctionCategories } from "../src/lib/tcm-knowledge.ts";
import { executableFormulaCompilationReferences } from "../src/lib/tcm-formula-provenance.ts";

const catalog = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-governed-catalog.json", import.meta.url), "utf8"));
const rows = Array.isArray(catalog) ? catalog : (catalog.entries || Object.values(catalog).find(Array.isArray));
const names = [...new Set(rows.filter((entry) => entry.doseCompilationEligible).map((entry) => entry.name))];
assert.ok(names.length >= 1000, `可编译方数量异常（${names.length}），目录可能没生成`);

let formulas = 0;
const unknownByHerb = new Map();
for (const name of names) {
  let ref;
  try { ref = executableFormulaCompilationReferences([name])[0]; } catch { continue; }
  if (!ref) continue;
  formulas += 1;
  for (const herb of ref.ingredients || []) {
    if (!isKnownTcmHerbName(herb)) unknownByHerb.set(herb, (unknownByHerb.get(herb) || 0) + 1);
  }
}
assert.ok(formulas >= 1000, `实际可编译方数量异常（${formulas}）`);
const unknownList = [...unknownByHerb.entries()].sort((a, b) => b[1] - a[1]);
assert.deepEqual(
  unknownList, [],
  `可编译基准方组成中存在"存在性答否"的药名（药名×方数）：${unknownList.slice(0, 20).map(([k, v]) => `${k}(${v})`).join("、")}`,
);

// 反向：确实不存在的名字必须仍然答否——T9 只放行人工裁定过且非歧义的行。
for (const fake of ["不存在的药", "测试假药名", "阿司匹林"]) {
  assert.equal(isKnownTcmHerbName(fake), false, `「${fake}」不得被判为已收药名`);
}

// 一致性抽查：存在性答是的饮片名，功用/分类也必须查得到（三个查询共用同一条解析）。
for (const herb of ["桂心", "黄芩片", "山萸肉", "麦门冬", "白芍药", "杏仁", "当归身", "盐车前子"]) {
  assert.equal(isKnownTcmHerbName(herb), true, `受控饮片名「${herb}」必须判为已收`);
  const hasConcept = Boolean(getTcmHerbFunctionText(herb)) || getTcmHerbFunctionCategories(herb).length > 0;
  assert.ok(hasConcept, `「${herb}」存在性答是但功用/分类查不到——三个查询又分叉了`);
}

console.log(JSON.stringify({ suite: "herb-name-resolution", formulas, unknownNames: unknownList.length, failures: 0 }, null, 2));
