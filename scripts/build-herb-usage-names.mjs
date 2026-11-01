#!/usr/bin/env node
// 真的作为药名用过的名字：教材证型表的组成、方剂目录的组成里出现过，而身份表里只有未复核来源（unique_source_backed）或没有条目的名字（第三十三轮）。
// 方义规则判「方外药」时，这类名字必须在这张表里才算药名：别名表 4672 条未复核别名里混着「血通」「能消」「重药」这种普通词。
// 输入：src/data/tcm-textbook-syndrome-formula-table.json、tcm-formula-sources.json、tcm-herb-identity-catalog.json。输出：src/data/tcm-herb-usage-names.json。
import fs from "node:fs";
const read = (name) => JSON.parse(fs.readFileSync(`src/data/${name}`, "utf8"));
const index = read("tcm-herb-identity-catalog.json").resolutionIndex;
const names = new Map();
const add = (name, source) => {
  const value = String(name || "").replace(/[（(][^）)]*[）)]/gu, "").trim();
  if (!/^[一-鿿]{2,6}$/u.test(value)) return;
  const status = index[value]?.status;
  if (status && status !== "unique_source_backed") return;
  names.set(value, (names.get(value) || 0) + source);
};
for (const row of read("tcm-textbook-syndrome-formula-table.json").rows) {
  for (const herb of row.composition || []) add(herb, 1);
}
for (const value of Object.values(read("tcm-formula-sources.json").formulas || {})) {
  for (const variant of Array.isArray(value) ? value : [value]) for (const herb of variant?.ingredients || []) add(herb, 1);
}
// 只出现过一次的多半是切分残片。加减条目不算来源：切分残片多（「液体中」「入银花」「软坚」）。
const kept = [...names].filter(([, count]) => count >= 2).map(([name]) => name).sort();
fs.writeFileSync("src/data/tcm-herb-usage-names.json", `${JSON.stringify({ generatedBy: "scripts/build-herb-usage-names.mjs", count: kept.length, names: kept })}\n`);
console.log(kept.length);
