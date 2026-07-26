// tcmoc 书目与篇段共享工具(第 4 处使用,前 3 处散落在 collect/rescue/reextract 脚本里,
// 已出现漂移风险,抽为共享模块)。
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const BOOKS_DIR = resolve(ROOT, "中医补充数据/tcmoc-master/books");

const bookFile = new Map();
for (const f of readdirSync(BOOKS_DIR)) {
  const m = f.match(/^\d+-(.+)\.txt$/);
  if (m) bookFile.set(m[1], f);
}
const rawCache = new Map();
export function sectionsOf(book) {
  if (!rawCache.has(book)) {
    if (!bookFile.has(book)) return new Map();
    const raw = readFileSync(resolve(BOOKS_DIR, bookFile.get(book)), "utf-8");
    const map = new Map();
    for (const s of raw.split(/<篇名>/).slice(1)) {
      const nl = s.indexOf("\n");
      map.set(s.slice(0, nl).trim(), s.slice(nl + 1).replace(/<目录>[^\n]*/g, "").trim());
    }
    rawCache.set(book, map);
  }
  return rawCache.get(book);
}
export function sectionText(book, chapter) {
  const map = sectionsOf(book);
  if (map.has(chapter)) return map.get(chapter);
  for (const [k, v] of map) if (k.includes(chapter) || chapter.includes(k)) return v;
  return undefined;
}
export function findSectionByFormulaName(name) {
  for (const f of readdirSync(BOOKS_DIR)) {
    const m = f.match(/^\d+-(.+)\.txt$/);
    if (!m) continue;
    const t = sectionText(m[1], name);
    if (t) return { book: m[1], chapter: name, text: t };
  }
  return undefined;
}
