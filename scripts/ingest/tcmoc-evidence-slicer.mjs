// tcmoc 古籍 → T15 证据层切片器（确定性，无 LLM）
// 输入: 中医补充数据/tcmoc-master/books/*.txt (UTF-8)
// 输出: src/data/tcm-classic-text-evidence-tcmoc.jsonl + manifest
// 用法: node scripts/ingest/tcmoc-evidence-slicer.mjs [全部|方书批|文件名子串...]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = resolve(ROOT, "中医补充数据/tcmoc-master/books");
const OUT = resolve(ROOT, "src/data/tcm-classic-text-evidence-tcmoc.jsonl");
const MANIFEST = resolve(ROOT, "src/data/tcm-classic-text-evidence-tcmoc-manifest.json");

// 方名识别：T8 治理目录 + 别名 + 异文，一次合并正则扫描（构建期确定性，非 LLM）
const catalog = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-formula-governed-catalog.json"), "utf-8"));
let aliasTable = {};
try { aliasTable = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-formula-aliases.json"), "utf-8")); } catch { /* 异文表可选 */ }
const aliasToCanonical = new Map();
for (const entry of catalog.entries || []) {
  for (const a of [entry.name, ...(entry.aliases || [])]) aliasToCanonical.set(a, entry.name);
}
// tcm-formula-aliases.json 的形状是 {schemaVersion, generatedFrom, entries:[{canonical, aliases:[]}]}。
// 原来写成 Object.entries(aliasTable?.aliases || aliasTable || {})：.aliases 不存在，于是回落到整个
// 对象，遍历出来的是 schemaVersion/generatedFrom/entries 三个顶层键——整张异文表被静默丢弃，
// 肾气丸/复脉汤/葛根芩连汤/苓桂甘枣汤等 12 个别名从未参与过方名识别正则。
for (const entry of aliasTable?.entries || []) {
  const canonical = typeof entry?.canonical === "string" ? entry.canonical : "";
  if (!canonical) continue;
  for (const alias of entry.aliases || []) {
    if (typeof alias === "string" && alias && !aliasToCanonical.has(alias)) aliasToCanonical.set(alias, canonical);
  }
}
const formulaPattern = new RegExp(
  [...aliasToCanonical.keys()].sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "g",
);
function formulasInText(text) {
  const hits = new Set();
  for (const m of text.matchAll(formulaPattern)) {
    const canonical = aliasToCanonical.get(m[0]);
    if (canonical) hits.add(canonical);
  }
  return [...hits].slice(0, 12);
}

const sha = (s) => createHash("sha256").update(s).digest("hex");
// MIN_CHARS 是段落**合并的目标下限**，不是记录的准入门槛。原实现在收尾处写成
// `if (buf.length >= MIN_CHARS) yield`，于是任何总长不足 200 字的 <篇名> 条目被整段丢弃：
// 实测 144,161 个条目里丢了 72,747 个（50.5%，791 万字），其中 13,920 个条目的篇名本身就是方名，
// 10,946 个条内含剂量原文。丢得最狠的恰恰是结构最规整、临床最可用的部分——
// 名医别录 804 条丢 777 条(97%)、药性切用 737 丢 733(99%)、惠直堂经验方 971 丢 924(95%)。
// 一条 80 字的本草药性条或单验方是**完整条目**，不是碎片，必须独立成记录。
const MIN_CHARS = 200, MAX_CHARS = 600, OVERLAP = 60;
const MIN_RECORD_CHARS = 24;
const MIN_PARAGRAPH_CHARS = 16;

// 方书批（编号前缀）
const FORMULA_BOOK_PREFIXES = new Set(("062,067,068,071,072,082,084,087,088,089,091,092,093,094,095,096,097,102,104,105,110,113,115,118,121,122,124,152,184,190,220,284,463,499,558,619,639,651,689").split(","));

function parseMeta(text) {
  const head = text.slice(0, 800);
  const pick = (re) => { const m = head.match(re); return m ? m[1].trim() : ""; };
  return {
    book: pick(/书名：([^\n]+)/) || undefined,
    author: pick(/作者：([^\n]+)/) || undefined,
    dynasty: pick(/朝代：([^\n]+)/) || undefined,
    year: pick(/年份：([^\n]+)/) || undefined,
  };
}

/**
 * 证据层级。原来对全部 701 部硬编码 tier:"canon"，于是《本草纲目》的泛提及段落与《伤寒论》条文
 * 处于同一最高层级，运行时排序（tierRank canon=0）被一刀切稀释——检索一个方名时返回的常常是
 * 大型类书里顺带提到该方的段落，而不是该方的专条。
 * 这里只用元数据头里的**朝代/年份**做确定性分级，不做任何内容判断：
 *   有古代朝代 → canon；民国/近代 → common；无朝代元数据（现代整理本、无结构化头）→ experience。
 * 分不出来时取更低层级，不取更高——层级只影响排序优先，取低只会少露出，取高会挤掉真正的经典条文。
 */
const MODERN_DYNASTY = /现代|当代|中华人民共和国|新中国/;
const RECENT_DYNASTY = /民国|近代|清末民初/;
function evidenceTier(meta) {
  const dynasty = (meta.dynasty || "").trim();
  if (!dynasty) return "experience";
  if (MODERN_DYNASTY.test(dynasty)) return "experience";
  if (RECENT_DYNASTY.test(dynasty)) return "common";
  return "canon";
}

function parseCatalogFromFilename(name) {
  // (12.3-13344.12).综合性补给-中医丛书.《本草思辨录》.周岩.md / 087-医方集解.txt
  const m = name.match(/^\(([^)]+)\)\.([^.]+)\.(.+)$/);
  if (m) return { catalogCode: m[1], category: m[2], fileTitle: m[3].replace(/\.(txt|md)$/, "") };
  const n = name.match(/^(\d+)-(.+)\.(txt|md)$/);
  if (n) return { catalogCode: n[1], category: "", fileTitle: n[2] };
  return { catalogCode: "", category: "", fileTitle: name.replace(/\.(txt|md)$/, "") };
}

function* sliceBook(filename, rawText) {
  const meta = parseMeta(rawText);
  const cat = parseCatalogFromFilename(filename);
  const book = meta.book || cat.fileTitle.replace(/[《》]/g, "");
  // 按 <篇名> 切段；段内按空行分段落；合并/拆分至 200-600 字
  const sections = rawText.split(/<篇名>/);
  let recIdx = 0;
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const sec = sections[sectionIndex];
    // 只有 <篇名> 标记**之后**的段（下标 ≥1）首行才是篇名；下标 0 是标记之前的前言块，它没有篇名。
    // 原实现对两者一视同仁地取「首行为篇名、其余为正文」，并且用 `nl > 0` 判定首行：
    // 文件若以换行开头（无结构化头的现代整理本都是），nl===0 不满足条件，body 直接成空串，
    // 整部书产出 0 条。实测三部高价值现代语料因此全丢：赵绍琴临证验案精选、李培生老中医经验集、外经微言。
    const hasChapterLine = sectionIndex > 0;
    const nl = sec.indexOf("\n");
    const chapter = hasChapterLine ? (nl >= 0 ? sec.slice(0, nl) : sec).trim() : "";
    const rawBody = hasChapterLine ? (nl >= 0 ? sec.slice(nl + 1) : "") : sec;
    // 元数据头（书名/作者/朝代/年份）本身不是临床条文。它此前被 MIN_CHARS=200 顺带挡住，
    // 收尾门槛放宽后就会以「《名医别录》·名医别录 → 书名：名医别录 作者：陶弘景…」这种形式
    // 混进证据库。这里显式剥掉，而不是靠长度门槛间接过滤——靠长度过滤等于把噪声控制寄托在
    // 一个为别的目的设的常数上，正是上面那个 50.5% 丢失的成因。
    const body = rawBody
      .replace(/<目录>/g, "\n")
      .replace(/<[^>]{1,12}>/g, " ")
      .replace(/^\s*(?:书名|作者|朝代|年份|校注|整理)：[^\n]*$/gm, "");
    const paras = body.split(/\n\s*\n+/).map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p.length >= MIN_PARAGRAPH_CHARS);
    let buf = "";
    for (const p of paras) {
      if (buf && buf.length + p.length > MAX_CHARS) {
        yield { book, chapter, text: buf, meta, cat, idx: recIdx++ };
        buf = buf.slice(-OVERLAP) + " " + p;
      } else {
        buf = buf ? buf + " " + p : p;
      }
      while (buf.length > MAX_CHARS * 1.6) {
        yield { book, chapter, text: buf.slice(0, MAX_CHARS), meta, cat, idx: recIdx++ };
        buf = buf.slice(MAX_CHARS - OVERLAP);
      }
    }
    if (buf.length >= MIN_RECORD_CHARS) yield { book, chapter, text: buf, meta, cat, idx: recIdx++ };
  }
}

const mode = process.argv[2] || "方书批";
const filter = process.argv.slice(3);
const files = readdirSync(SRC).filter((f) => /\.(txt|md)$/.test(f)).filter((f) => {
  if (mode === "全部") return true;
  if (filter.length) return filter.some((x) => f.includes(x));
  return FORMULA_BOOK_PREFIXES.has(f.slice(0, 3));
});

let records = 0, books = 0, badBooks = [];
const tierCounts = { canon: 0, common: 0, experience: 0 };
const lines = [];
const bookStats = {};
for (const f of files.sort()) {
  const raw = readFileSync(resolve(SRC, f), "utf-8");
  if (!raw.trim()) { badBooks.push(f); continue; }
  let count = 0;
  let bookName = "";
  for (const rec of sliceBook(f, raw)) {
    bookName = bookName || rec.book || f;
    const evidenceId = `TCMOC-${sha(f + rec.chapter + rec.idx).slice(0, 16).toUpperCase()}`;
    lines.push(JSON.stringify({
      evidenceId,
      book: rec.book,
      citation: `《${rec.book}》${rec.chapter ? `·${rec.chapter}` : ""}`,
      catalogCode: rec.cat.catalogCode || undefined,
      category: rec.cat.category || undefined,
      author: rec.meta.author,
      dynasty: rec.meta.dynasty,
      year: rec.meta.year,
      anchorLevel: "chapter_paragraph",
      chapter: rec.chapter,
      paragraphIndex: rec.idx,
      text: rec.text,
      formulas: formulasInText(rec.text),
      tier: evidenceTier(rec.meta),
      safetyClass: "standard",
      sourceRef: `tcmoc-books/${f}`,
    }));
    tierCounts[evidenceTier(rec.meta)] += 1;
    count++; records++;
  }
  bookStats[bookName || f] = count;
  // 解析出 0 条同样是「空书」。原来 badBooks 只收文件本身为空的情况，一本有内容却因解析缺陷
  // 产出 0 条的书照样 books++ 并写进 bookStats，manifest 于是报 emptyBooks: []——
  // 缺陷被自己的完整性清单吞掉，任何基于 manifest 的测试都测不出来。
  if (count === 0) badBooks.push(f);
  books++;
}
writeFileSync(OUT, lines.join("\n") + "\n");
writeFileSync(MANIFEST, JSON.stringify({
  schemaVersion: "tcmoc-evidence-manifest-v1",
  generatedAt: new Date().toISOString().slice(0, 10),
  mode, files: files.length, books, records,
  // 产出 0 条的书必须逐个列名，不能只报个数——列名才能追回源文件。
  emptyBooks: badBooks,
  emptyBookCount: badBooks.length,
  tierCounts,
  outputSha256: sha(lines.join("\n")),
  outputFile: OUT.split("/").pop(),
  // 全量书目条数，不再截断到前 60：截断后无法据此发现零产出的书。
  bookStats: Object.fromEntries(Object.entries(bookStats).sort((a, b) => b[1] - a[1])),
}, null, 2) + "\n");
console.log(JSON.stringify({ mode, files: files.length, books, records, emptyBooks: badBooks.length, tierCounts, outMB: (statSync(OUT).size / 1048576).toFixed(1) }));
