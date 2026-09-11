import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const dataRoot = path.join(root, "src/data");
const sources = {};
const read = file => {
  const source = fs.readFileSync(path.join(dataRoot, file), "utf8");
  sources[file] = createHash("sha256").update(source).digest("hex");
  return JSON.parse(source);
};
const terms = new Set();
const add = value => {
  if (typeof value === "string" && /^[\u3400-\u9fff]{2,3}$/.test(value.trim())) terms.add(value.trim());
};
for (const file of ["tcm-disease-lexicon.json", "tcm-location-lexicon.json"]) {
  for (const row of read(file).entries) {
    add(row.canonical);
    for (const alias of row.aliases || []) add(alias);
  }
}
for (const axis of read("tcm-inspection-lexicon.json").axes) {
  for (const group of axis.groups || []) for (const term of group.terms || []) add(term);
}
const grammar = read("phi-clinical-lexical-grammar.source.json");
for (const group of grammar.groups) {
  // 构词组是 prefixes × suffixes 的乘积；副词、连接词这类不成乘积的封闭集合用 terms 逐词列出。
  for (const prefix of group.prefixes || []) for (const suffix of group.suffixes || []) add(prefix + suffix);
  for (const term of group.terms || []) add(term);
}
const followers = [...new Set(grammar.lexemeFollowers?.characters || [])];
if (followers.some((value) => !/^[㐀-鿿]$/.test(value))) throw new Error("lexemeFollowers must be single CJK characters");
const expected = JSON.stringify({ schemaVersion: "phi-clinical-lexemes-v1", sources, terms: [...terms].sort(), lexemeFollowers: followers.sort() }, null, 2) + "\n";
const target = path.join(dataRoot, "phi-clinical-lexemes.json");
if (process.argv.includes("--check")) {
  if (fs.readFileSync(target, "utf8") !== expected) throw new Error("PHI clinical lexemes differ from governed sources; rebuild them");
} else {
  fs.writeFileSync(target, expected);
}
console.log(JSON.stringify({ artifact: "phi-clinical-lexemes", terms: terms.size, checked: process.argv.includes("--check") }));
