#!/usr/bin/env node
/**
 * 经方方证表构建与校验（2026-10-19，第八轮 WP-A）。
 *
 * 输入：src/data/tcm-jingfang-patterns.source.json（受治理的手工整理表：每个方证的条文、主症、证名、区分点）
 * 输出：src/data/tcm-jingfang-patterns.json（运行时读取的紧凑生成物）
 *
 * 逐条校验（任何一条不过就报错退出，不写生成物）：
 *  · 条文（clauses）：必须逐字出自本地《伤寒论》《金匮要略方论》原文的 [line, endLine] 行区间（去掉空白后比对），
 *    原文文件按 gb18030 解码并核对 sha256（文件不在本机时报错；加 --skip-books 只在无原文的环境里做结构校验）；
 *  · 主症（keySymptoms）：每个短语必须逐字出现在本方证的条文里；
 *  · 教材主症（textbookSymptoms）：逐字出自《伤寒论选读》指定行（教材文件在本机时核验；不在时只做结构校验并提示）；
 *  · 证名来源（syndromeSource）：GB/T 16751.2-2021 术语表（tcm-syndrome-lexicon.json）、《方剂学》主治
 *    （tcm-formula-textbook-functions.json）或《伤寒论选读》指定行，三者必居其一且核验通过；
 *  · 区分点（differentiation）：对比方证必须在表内，出处条文必须是本方证或对比方证条文之一；
 *  · 方名：在受治理方剂目录（tcm-formula-governed-catalog.json）里按名称/别名查不到的标记 catalogMissing:true；
 *    目录里同名方的出处不是《伤寒论》《金匮要略》的标记 catalogSourceNote（锁方时取到的是后世同名方）。
 *
 * 用法：node scripts/build-jingfang-patterns.mjs            校验并写出生成物
 *       node scripts/build-jingfang-patterns.mjs --check    校验并核对生成物与现有文件逐字相同
 *       --skip-books                                        无原文环境：跳过原文与教材逐字核验（仅 CI 之外的特殊场合）
 *       --source=PATH --output=PATH                         换输入/输出路径（测试用，反证在临时副本上做）
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const args = new Set(argv);
const argValue = (name) => argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
// --source=PATH / --output=PATH 只给测试用：在临时副本上做「改一个字就必须报错」的反证，不碰仓库里的两份文件。
const SOURCE_PATH = argValue("--source") || join(ROOT, "src/data/tcm-jingfang-patterns.source.json");
const OUTPUT_PATH = argValue("--output") || join(ROOT, "src/data/tcm-jingfang-patterns.json");
const skipBooks = args.has("--skip-books");

const compact = (text) => String(text).replace(/\s+/gu, "");
// 比对用：连标点一并去掉（来源核验里「寒热错杂，中焦痞塞」与「寒热错杂中焦痞塞」算同一段）。
const squash = (text) => String(text).replace(/[\s，。、；：:;,.（）()“”"'《》]+/gu, "");
const errors = [];
const fail = (message) => errors.push(message);

const source = JSON.parse(readFileSync(SOURCE_PATH, "utf8"));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

// ── 原文 ──
const bookLines = new Map();
for (const book of source.books) {
  const path = join(ROOT, book.file);
  if (skipBooks && !existsSync(path)) continue;
  if (!existsSync(path)) { fail(`原文文件不存在：${book.file}（无原文环境请加 --skip-books）`); continue; }
  if (sha256(path) !== book.sha256) fail(`原文文件 sha256 与登记不符：${book.file}`);
  bookLines.set(book.name, new TextDecoder(book.encoding).decode(readFileSync(path)).split("\n").map((line) => line.replace(/\r$/u, "")));
}
// ── 教材 ──
let textbookLines = null;
{
  const path = join(ROOT, source.textbook.file);
  if (existsSync(path) && !skipBooks) {
    if (sha256(path) !== source.textbook.sha256) fail(`教材文件 sha256 与登记不符：${source.textbook.file}`);
    textbookLines = readFileSync(path, "utf8").split("\n");
  } else {
    console.warn(`提示：教材文件不在本机或已跳过，textbookSymptoms 与「伤寒论选读」证名来源只做结构校验。`);
  }
}
// ── 证名与方名数据 ──
const lexicon = new Set(JSON.parse(readFileSync(join(ROOT, "src/data/tcm-syndrome-lexicon.json"), "utf8")).entries.map((entry) => entry.canonical));
const fangjiFunctions = new Map(JSON.parse(readFileSync(join(ROOT, "src/data/tcm-formula-textbook-functions.json"), "utf8")).entries.map((entry) => [entry.name, entry]));
const catalogByName = new Map();
for (const entry of JSON.parse(readFileSync(join(ROOT, "src/data/tcm-formula-governed-catalog.json"), "utf8")).entries) {
  for (const name of [entry.name, ...(entry.aliases || [])]) {
    if (!catalogByName.has(name)) catalogByName.set(name, []);
    catalogByName.get(name).push(entry);
  }
}

const ids = new Set();
const formulas = new Set();
const patternNames = new Map();
const byFormula = new Map(source.patterns.map((pattern) => [pattern.formula, pattern]));
const generated = [];

for (const pattern of source.patterns) {
  const tag = `${pattern.id || "?"} ${pattern.formula}`;
  if (!pattern.id || ids.has(pattern.id)) fail(`${tag}: id 缺失或重复`);
  ids.add(pattern.id);
  if (formulas.has(pattern.formula)) fail(`${tag}: 方名重复`);
  formulas.add(pattern.formula);
  for (const name of [pattern.patternName, ...(pattern.aliases || [])]) {
    if (patternNames.has(name) && patternNames.get(name) !== pattern.id) fail(`${tag}: 方证名 ${name} 与 ${patternNames.get(name)} 重复`);
    patternNames.set(name, pattern.id);
  }
  if (!/证$/u.test(pattern.patternName)) fail(`${tag}: 方证名应以「证」结尾`);

  // 条文逐字
  if (!Array.isArray(pattern.clauses) || pattern.clauses.length === 0) fail(`${tag}: 没有条文`);
  const clauseTexts = [];
  for (const clause of pattern.clauses || []) {
    clauseTexts.push(clause.text);
    if (/[\u0000-\u001f]/u.test(clause.text)) fail(`${tag}: 条文含控制字符 ${clause.book}:${clause.line}`);
    const lines = bookLines.get(clause.book);
    if (!lines) { if (!skipBooks) fail(`${tag}: 未登记的书 ${clause.book}`); continue; }
    if (!(clause.line >= 1 && clause.endLine >= clause.line && clause.endLine <= lines.length)) { fail(`${tag}: 行号越界 ${clause.book}:${clause.line}-${clause.endLine}`); continue; }
    const region = compact(lines.slice(clause.line - 1, clause.endLine).join(""));
    if (!region.includes(compact(clause.text))) fail(`${tag}: 条文不在原文 ${clause.book} 第 ${clause.line}-${clause.endLine} 行`);
    // 条文必须从该行区间的条文起首处取起（起始行以「N．」开头，N 即 clauseNo）
    const head = (lines[clause.line - 1] || "").replace(/^属性：/u, "");
    if (!head.startsWith(`${clause.clauseNo}．`)) fail(`${tag}: 起始行不是第 ${clause.clauseNo} 条的开头 ${clause.book}:${clause.line}`);
    const body = compact(lines[clause.line - 1].replace(/^属性：/u, "").replace(/^\d+．/u, ""));
    if (!compact(clause.text).startsWith(body.slice(0, Math.min(body.length, 6)))) fail(`${tag}: 条文不是从该条起首取起 ${clause.book}:${clause.line}`);
  }
  const joined = compact(clauseTexts.join("|"));
  if (!Array.isArray(pattern.keySymptoms) || pattern.keySymptoms.length < 1) fail(`${tag}: 没有条文主症`);
  // 判定「至少两条互相印证」需要至少两个可对的症状（条文主症 + 教材主症）；只有一个特异症状的（半夏厚朴汤「咽中如有炙脔」）显式写 minQuotes:1。
  const totalSymptoms = (pattern.keySymptoms || []).length + (pattern.textbookSymptoms || []).length;
  if ((pattern.minQuotes ?? 2) === 1 ? totalSymptoms < 1 : totalSymptoms < 2) fail(`${tag}: 可对的症状太少（${totalSymptoms}）`);
  if (![1, 2].includes(pattern.minQuotes ?? 2)) fail(`${tag}: minQuotes 只能是 1 或 2`);
  for (const symptom of pattern.keySymptoms || []) {
    if (!joined.includes(compact(symptom))) fail(`${tag}: 主症「${symptom}」不在本方证条文里`);
  }
  if (new Set(pattern.keySymptoms).size !== (pattern.keySymptoms || []).length) fail(`${tag}: 主症有重复`);

  // 教材主症
  for (const item of pattern.textbookSymptoms || []) {
    if (textbookLines && !squash(textbookLines[item.line - 1] || "").includes(squash(item.text))) fail(`${tag}: 教材主症「${item.text}」不在《伤寒论选读》第 ${item.line} 行`);
    if ((pattern.keySymptoms || []).includes(item.text)) fail(`${tag}: 教材主症「${item.text}」与条文主症重复`);
  }

  // 证名来源
  const source1 = pattern.syndromeSource || {};
  const base = String(pattern.syndromeName || "").replace(/证$/u, "");
  if (!/证$/u.test(pattern.syndromeName || "")) fail(`${tag}: 证名应以「证」结尾`);
  if (source1.kind === "GB/T 16751.2-2021") {
    if (!lexicon.has(source1.term) || !(source1.term === pattern.syndromeName || source1.term === base)) fail(`${tag}: 证名 ${pattern.syndromeName} 不是 GB/T 16751.2 术语（${source1.term}）`);
  } else if (source1.kind === "方剂学") {
    const entry = fangjiFunctions.get(source1.formula);
    if (!entry || !squash(entry.indications).includes(squash(base))) fail(`${tag}: 证名 ${pattern.syndromeName} 不在《方剂学》${source1.formula}的主治里`);
  } else if (source1.kind === "伤寒论选读") {
    if (textbookLines && !squash(textbookLines[source1.line - 1] || "").includes(squash(source1.quote))) fail(`${tag}: 证名引文不在《伤寒论选读》第 ${source1.line} 行`);
    if (!squash(source1.quote).includes(squash(base))) fail(`${tag}: 证名 ${pattern.syndromeName} 不在其来源引文「${source1.quote}」里`);
  } else {
    fail(`${tag}: 证名来源缺失或种类不明`);
  }

  // 区分点
  const diff = pattern.differentiation || {};
  const other = byFormula.get(diff.vs);
  if (!other || other === pattern) fail(`${tag}: 区分点的对比方证 ${diff.vs} 不在表内`);
  else {
    const allowed = new Set([...pattern.clauses, ...other.clauses].map((clause) => `${clause.book}:${clause.line}`));
    if (!diff.text || !Array.isArray(diff.basis) || diff.basis.length === 0) fail(`${tag}: 区分点缺文字或出处`);
    for (const ref of diff.basis || []) if (!allowed.has(`${ref.book}:${ref.line}`)) fail(`${tag}: 区分点出处 ${ref.book}:${ref.line} 不是本方证或对比方证的条文`);
  }

  // 方名与目录
  const catalogEntries = catalogByName.get(pattern.formula) || [];
  const catalog = catalogEntries.length === 0
    ? { status: "missing" }
    : {
        status: "ok",
        ...(catalogEntries.some((entry) => /伤寒论|金匮/u.test(entry.source || "")) ? {} : { sourceNote: `目录同名方出处为${catalogEntries[0].source}，不是《伤寒论》《金匮要略》` }),
      };

  generated.push({
    id: pattern.id,
    formula: pattern.formula,
    patternName: pattern.patternName,
    ...(pattern.aliases?.length ? { aliases: pattern.aliases } : {}),
    syndromeName: pattern.syndromeName,
    syndromeSource: source1.kind === "GB/T 16751.2-2021" ? `GB/T 16751.2-2021 ${source1.term}`
      : source1.kind === "方剂学" ? `《方剂学》${source1.formula}主治`
        : `《伤寒论选读》第${source1.line}行`,
    symptoms: [...pattern.keySymptoms, ...(pattern.textbookSymptoms || []).map((item) => item.text)],
    minQuotes: pattern.minQuotes ?? 2,
    clauses: pattern.clauses.map((clause) => ({ book: clause.book, line: clause.line, text: clause.text })),
    differentiation: { vs: diff.vs, text: diff.text },
    catalog,
    ...(catalog.status === "missing" ? { catalogMissing: true } : {}),
  });
}

if (errors.length > 0) {
  console.error(`校验失败 ${errors.length} 处：`);
  for (const message of errors.slice(0, 60)) console.error(` - ${message}`);
  process.exit(1);
}

const sourceDigest = createHash("sha256").update(readFileSync(SOURCE_PATH)).digest("hex");
const output = {
  schemaVersion: "tcm-jingfang-patterns-v1",
  verifiedAt: source.verifiedAt,
  adjudicationRef: source.adjudicationRef,
  sourceSha256: sourceDigest,
  genericSymptoms: source.genericSymptoms,
  counts: {
    patterns: generated.length,
    catalogMissing: generated.filter((item) => item.catalogMissing).length,
    catalogSourceNote: generated.filter((item) => item.catalog.sourceNote).length,
  },
  patterns: generated,
};
const text = `${JSON.stringify(output, null, 1)}\n`;
if (args.has("--check")) {
  if (!existsSync(OUTPUT_PATH) || readFileSync(OUTPUT_PATH, "utf8") !== text) {
    console.error("生成物与 source 不一致：请重跑 node scripts/build-jingfang-patterns.mjs");
    process.exit(1);
  }
  console.log(`ok ${generated.length} 个方证（生成物与 source 一致）`);
} else {
  writeFileSync(OUTPUT_PATH, text);
  console.log(`写出 ${generated.length} 个方证；目录缺失 ${output.counts.catalogMissing}，出处提示 ${output.counts.catalogSourceNote}`);
}
