#!/usr/bin/env node
// 从教材对照表导出「教材病名」清单（只有名字，几 KB），供术语归一使用：归一模块会进浏览器包，不能直接引 5MB 的整表。
// 用法：node scripts/build-tcm-textbook-disease-names.mjs   （改了对照表或补充表之后重跑）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const table = JSON.parse(fs.readFileSync(path.join(root, "src/data/tcm-textbook-syndrome-formula-table.json"), "utf8"));
const supplement = JSON.parse(fs.readFileSync(path.join(root, "src/data/tcm-textbook-syndrome-supplement.source.json"), "utf8"));
// 与运行时候选同一范围：以中医病名立节的教材（tcm-textbook-syndromes.ts 的 CANDIDATE_BOOK_PRIORITY）。
const BOOKS = new Set(["supplement", "neike", "fuke", "waike", "erke", "yanke", "gushang"]);
const names = new Set();
for (const row of [...table.rows, ...supplement.rows]) {
  if (BOOKS.has(row.bookKey) && typeof row.disease === "string" && row.disease.trim() && Array.isArray(row.formulas) && row.formulas.length > 0) names.add(row.disease.trim());
}
const out = { generatedBy: "scripts/build-tcm-textbook-disease-names.mjs", count: names.size, names: [...names].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")) };
fs.writeFileSync(path.join(root, "src/data/tcm-textbook-disease-names.json"), `${JSON.stringify(out, null, 1)}\n`);
console.log(`textbook disease names: ${names.size}`);
