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

// 教材节名是西医病名、而教材自己在该节定义里写明「属中医学“X”范畴」的（中医外科学「血栓闭塞性脉管炎」：属中医学“脱疽”的范畴），
// 交付时中医病名栏写 X，不写西医节名（2026-10-19 X-C-0606/0335：中医病名栏是「血栓闭塞性脉管炎」，应为「脱疽」）。
// 只认两个同时成立的条件，不列病例：① 节名本身不是 GB/T 15657 的正名；② 该节定义里「中医学“X”」引号内的名字是 GB/T 15657 正名或别名
//（别名取其正名）。节名是 GB/T 别名的（股骨头缺血性坏死 → 骨蚀）优先取与它同属一条的那个引号名；其余取第一个。
const lexicon = JSON.parse(fs.readFileSync(path.join(root, "src/data/tcm-disease-lexicon.json"), "utf8")).entries.filter((entry) => entry.temporary !== true);
const canonicalOf = new Map();
const canonicalNames = new Set();
for (const entry of lexicon) {
  canonicalNames.add(entry.canonical);
  canonicalOf.set(entry.canonical, entry.canonical);
  for (const alias of entry.aliases || []) if (!canonicalOf.has(alias)) canonicalOf.set(alias, entry.canonical);
}
const governed = (name) => canonicalOf.get(name) || canonicalOf.get(`${name}病`) || canonicalOf.get(name.replace(/病$/u, ""));
const tcmNameBySectionName = {};
const tcmNameBasis = {};
for (const disease of table.diseases) {
  if (!BOOKS.has(disease.bookKey) || !names.has(disease.disease) || tcmNameBySectionName[disease.disease]) continue;
  const own = governed(disease.disease);
  if (own && canonicalNames.has(disease.disease)) continue;
  // 「属中医学“骨痹”“骨蚀”范畴」：紧接着的几个引号名都是该节对应的中医病名。
  const quoted = [...String(disease.definition || "").matchAll(/中医学?((?:[“"][^”"]{2,8}[”"])+)/gu)]
    .flatMap((match) => [...match[1].matchAll(/[“"]([^”"]{2,8})[”"]/gu)].map((item) => item[1]));
  const resolved = quoted.map((name) => ({ name, canonical: governed(name) })).filter((item) => item.canonical);
  if (resolved.length === 0) continue;
  const pick = resolved.find((item) => item.canonical === own) || resolved[0];
  tcmNameBySectionName[disease.disease] = pick.canonical;
  tcmNameBasis[disease.disease] = { book: disease.book, line: disease.line, quote: String(disease.definition).slice(0, 120) };
}
const out = { generatedBy: "scripts/build-tcm-textbook-disease-names.mjs", count: names.size, names: [...names].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")), tcmNameBySectionName, tcmNameBasis };
fs.writeFileSync(path.join(root, "src/data/tcm-textbook-disease-names.json"), `${JSON.stringify(out, null, 1)}\n`);
console.log(`textbook disease names: ${names.size}; western-titled sections with a TCM name: ${JSON.stringify(tcmNameBySectionName)}`);
