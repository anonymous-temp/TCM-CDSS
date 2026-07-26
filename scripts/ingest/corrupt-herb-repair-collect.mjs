// 缺字药名修复工作清单构建器：为 121 首 supplements 缺字方收集 源书/篇名/原文段落/现组成。
// 用法: node scripts/ingest/corrupt-herb-repair-collect.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const BOOKS_DIR = resolve(ROOT, "中医补充数据/tcmoc-master/books");
const OUT = resolve(ROOT, "artifacts/corrupt-herb-repair/worklist.json");

const cat = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-formula-governed-catalog.json"), "utf-8")).entries;
const supp = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-verified-formula-supplements.json"), "utf-8")).entries;

// 书名 → 书文件
const bookFile = new Map();
for (const f of readdirSync(BOOKS_DIR)) {
  const m = f.match(/^\d+-(.+)\.txt$/);
  if (m) bookFile.set(m[1], f);
}
const sectionCache = new Map();
function sectionText(book, chapter) {
  if (!bookFile.has(book)) return undefined;
  if (!sectionCache.has(book)) {
    const raw = readFileSync(resolve(BOOKS_DIR, bookFile.get(book)), "utf-8");
    const map = new Map();
    for (const s of raw.split(/<篇名>/).slice(1)) {
      const nl = s.indexOf("\n");
      map.set(s.slice(0, nl).trim(), s.slice(nl + 1).replace(/<目录>[^\n]*/g, "").trim());
    }
    sectionCache.set(book, map);
  }
  const map = sectionCache.get(book);
  if (map.has(chapter)) return map.get(chapter);
  // 篇名带序号变体(如 三黄宝蜡丸（十五）)或目录变体时按包含匹配
  for (const [k, v] of map) if (k.includes(chapter) || chapter.includes(k)) return v;
  return undefined;
}

const worklist = [];
for (const e of cat) {
  const singles = (e.ingredients || []).filter((h) => typeof h === "string" && h.trim().length === 1);
  if (!singles.length) continue;
  if (e.sourceCatalog !== "project_verified_supplement") continue; // SZJG 25 首走 OVERRIDES 通道,另列
  const s = supp[e.name];
  if (!s) { worklist.push({ name: e.name, singles, error: "no-supplement-entry" }); continue; }
  const ver = (s.verification || [])[0] || {};
  const m = String(ver.url || "").match(/tcmoc-books:([^:]+):(.+)$/);
  let book = m?.[1], chapter = m?.[2];
  let text = book && chapter ? sectionText(book, chapter) : undefined;
  if (!text) {
    // 锚点缺失时全书扫篇名
    for (const [b] of bookFile) {
      const t = sectionText(b, e.name);
      if (t) { book = b; chapter = e.name; text = t; break; }
    }
  }
  worklist.push({
    name: e.name,
    singles,
    source: s.source,
    book, chapter,
    sectionFound: Boolean(text),
    sectionText: text ? text.slice(0, 1200) : undefined,
    currentIngredients: e.ingredients,
    requiredIngredients: e.requiredIngredients,
  });
}
const missing = worklist.filter((w) => !w.sectionFound);
console.log(JSON.stringify({ total: worklist.length, sectionFound: worklist.length - missing.length, missing: missing.map((m) => m.name) }));
writeFileSync(OUT, JSON.stringify(worklist, null, 2) + "\n");
