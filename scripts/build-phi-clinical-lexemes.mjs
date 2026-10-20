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
// 病历抬头规则（scrubRecordHeaderName）只认 headerExempt 组的词条：「高龄男性」「成年女性」不是「姓名，男/女」。
const headerTerms = new Set();
for (const group of grammar.groups) if (group.headerExempt) for (const term of group.terms || []) if (terms.has(term)) headerTerms.add(term);
// 方义起句：候选「方中」+「有」+ 药名/药性类别词。药名取药典药味（含别名）的前两字，类别词来自语法源。
const formulaReading = (() => {
  const spec = grammar.formulaReading;
  if (!spec) return undefined;
  const openers = new Set(spec.classOpeners || []);
  for (const herb of read("tcm-knowledge.json").herbs || []) {
    for (const name of [herb.name, ...(herb.aliases || [])]) {
      if (typeof name === "string" && /^[㐀-鿿]{2,}$/.test(name.trim())) openers.add(name.trim().slice(0, 2));
    }
  }
  // 《中药学》十版功效归类名（活血化瘀药、清热解毒药…）的前两字：「方中有活血化瘀之品」。
  for (const name of Object.values(read("tcm-herb-function-categories.json").categories || {}).flat()) {
    if (typeof name === "string" && /^[㐀-鿿]{3,}$/.test(name)) openers.add(name.slice(0, 2));
  }
  if ([...openers].some((value) => !/^[㐀-鿿]{2}$/.test(value))) throw new Error("formulaReading openers must be two CJK characters");
  if ((spec.objectSuffixes || []).some((value) => !/^[㐀-鿿]{2}$/.test(value))) throw new Error("formulaReading objectSuffixes must be two CJK characters");
  return { candidates: [...spec.candidates].sort(), linkChars: [...spec.linkChars].sort(), openers: [...openers].sort(), objectSuffixes: [...(spec.objectSuffixes || [])].sort() };
})();
// 跨候选边界的部位词（左小腹痛 = 「左小」+「腹痛」）：候选 + 其后紧跟的一个字才构成词。
const straddleOpenings = (grammar.straddleOpenings || []).flatMap((item) => item.candidates.map((candidate) => ({ candidate, nextChars: [...item.nextChars].sort() })))
  .sort((a, b) => a.candidate.localeCompare(b.candidate, "zh"));
const followers = [...new Set(grammar.lexemeFollowers?.characters || [])];
if (followers.some((value) => !/^[㐀-鿿]$/.test(value))) throw new Error("lexemeFollowers must be single CJK characters");
const expected = JSON.stringify({ schemaVersion: "phi-clinical-lexemes-v1", sources, terms: [...terms].sort(), lexemeFollowers: followers.sort(), headerTerms: [...headerTerms].sort(), formulaReading, straddleOpenings }, null, 2) + "\n";
const target = path.join(dataRoot, "phi-clinical-lexemes.json");
if (process.argv.includes("--check")) {
  if (fs.readFileSync(target, "utf8") !== expected) throw new Error("PHI clinical lexemes differ from governed sources; rebuild them");
} else {
  fs.writeFileSync(target, expected);
}
console.log(JSON.stringify({ artifact: "phi-clinical-lexemes", terms: terms.size, checked: process.argv.includes("--check") }));
