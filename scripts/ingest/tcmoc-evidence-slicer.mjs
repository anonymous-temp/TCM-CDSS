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
for (const [alias, canonical] of Object.entries(aliasTable?.aliases || aliasTable || {})) {
  if (!aliasToCanonical.has(alias)) aliasToCanonical.set(alias, typeof canonical === "string" ? canonical : canonical?.name);
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
const MIN_CHARS = 200, MAX_CHARS = 600, OVERLAP = 60;

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
  for (const sec of sections) {
    const nl = sec.indexOf("\n");
    const chapter = (nl > 0 ? sec.slice(0, nl) : sec.slice(0, 40)).trim();
    const body = (nl > 0 ? sec.slice(nl + 1) : "").replace(/<目录>/g, "\n").replace(/<[^>]{1,12}>/g, " ");
    const paras = body.split(/\n\s*\n+/).map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p.length >= 30);
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
    if (buf.length >= MIN_CHARS) yield { book, chapter, text: buf, meta, cat, idx: recIdx++ };
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
      tier: "canon",
      safetyClass: "standard",
      sourceRef: `tcmoc-books/${f}`,
    }));
    count++; records++;
  }
  bookStats[bookName || f] = count;
  books++;
}
writeFileSync(OUT, lines.join("\n") + "\n");
writeFileSync(MANIFEST, JSON.stringify({
  schemaVersion: "tcmoc-evidence-manifest-v1",
  generatedAt: new Date().toISOString().slice(0, 10),
  mode, files: files.length, books, records,
  emptyBooks: badBooks,
  outputSha256: sha(lines.join("\n")),
  outputFile: OUT.split("/").pop(),
  bookStats: Object.fromEntries(Object.entries(bookStats).sort((a, b) => b[1] - a[1]).slice(0, 60)),
}, null, 2) + "\n");
console.log(JSON.stringify({ mode, files: files.length, books, records, emptyBooks: badBooks.length, outMB: (statSync(OUT).size / 1048576).toFixed(1) }));
