// composition<2 单方章节重抽器:首轮抽取在 2200 字窗口内没找到组成行的 20 首真方,
// 用完整源段(≤3000 字)重抽,变体表增强对拍,产物入救援目录。
// 用法: DEEPSEEK_API_KEY=sk-... node scripts/ingest/composition-reextract.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const BOOKS_DIR = resolve(ROOT, "中医补充数据/tcmoc-master/books");
const OUTDIR = resolve(ROOT, "artifacts/tcmoc-formula-extract-rescued");
const CANDIDATES = JSON.parse(readFileSync(resolve(ROOT, "artifacts/composition-reextract-single.json"), "utf-8"));
const KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
if (!KEY) throw new Error("DEEPSEEK_API_KEY or OPENAI_API_KEY required");

const bookFile = new Map();
for (const f of readdirSync(BOOKS_DIR)) {
  const m = f.match(/^\d+-(.+)\.txt$/);
  if (m) bookFile.set(m[1], f);
}
const rawCache = new Map();
function sectionText(book, chapter) {
  if (!bookFile.has(book)) return undefined;
  if (!rawCache.has(book)) {
    const raw = readFileSync(resolve(BOOKS_DIR, bookFile.get(book)), "utf-8");
    const map = new Map();
    for (const s of raw.split(/<篇名>/).slice(1)) {
      const nl = s.indexOf("\n");
      map.set(s.slice(0, nl).trim(), s.slice(nl + 1).replace(/<目录>[^\n]*/g, "").trim());
    }
    rawCache.set(book, map);
  }
  const map = rawCache.get(book);
  if (map.has(chapter)) return map.get(chapter);
  for (const [k, v] of map) if (k.includes(chapter) || chapter.includes(k)) return v;
  return undefined;
}

const t9 = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-herb-identity-catalog.json"), "utf-8"));
const ri = t9.resolutionIndex;
import { VARIANTS, GUARDS } from "./variant-map.mjs";
function herbInText(herb, text) {
  if (!herb) return false;
  if (text.includes(herb)) return true;
  for (const suf of ["子", "仁", "皮", "肉", "片", "炭", "末", "萸", "黄", "苓", "芍", "草", "参", "归", "芎", "朴", "芪", "桂", "母", "星", "夏", "枳", "姜", "枣"]) {
    if (herb.endsWith(suf) && text.includes(herb.slice(0, -1))) return true;
  }
  const v = ri[herb];
  if (v?.canonicalName && text.includes(v.canonicalName)) return true;
  for (const a of v?.aliases || []) if (text.includes(a)) return true;
  for (const x of VARIANTS[herb] || []) if (text.includes(x)) return true;
  const g = GUARDS[herb];
  if (g && !g.competitors.some((c) => text.includes(c))) {
    for (const x of g.variants) if (text.includes(x)) return true;
  }
  return false;
}

const mkSystem = (book) => `你是中医古籍方证结构化抽取器。输入《${book}》的一个方剂条目全文,输出单个 JSON 对象,不要输出其他文字。
字段:
- name: 方名（条目篇名）
- source: 出处（条目内"（《xx》）"类,无则 null）
- composition: [{"herb":"规范药名","dose":"原文剂量或null","processing":"炮制或null"}],只能包含原文组成行实际出现的药味;OCR 丢字按上下文修复并记录 ocrRepairs
- indications: 主治（原文摘要,≤80字）
- usage: 煎服法/用法（无则 null）
- modifications: [{"trigger":"原文加减条件","action":"加/减/换药名"}]
- analysis: 方义归经要点（≤60字）
- ocrRepairs: ["原样→修复样"]
要求:只输出 JSON;宁可少抽也绝不凭记忆补充药味;拿不准写 null。`;

async function callApi(book, chapter, text, attempt = 0) {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: mkSystem(book) },
        { role: "user", content: `条目篇名:${chapter}\n\n${text.slice(0, 3000)}` },
      ],
      temperature: 0, max_tokens: 2200, thinking: { type: "disabled" }, stream: false,
    }),
  });
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    return callApi(book, chapter, text, attempt + 1);
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const content = (await res.json()).choices?.[0]?.message?.content || "";
  const lb = content.indexOf("{"), rb = content.lastIndexOf("}");
  if (lb < 0 || rb < 0) throw new Error(`no json: ${content.slice(0, 100)}`);
  return JSON.parse(content.slice(lb, rb + 1));
}

const out = [];
for (const c of CANDIDATES) {
  const text = sectionText(c.book, c.chapter);
  if (!text) { out.push({ book: c.book, chapter: c.chapter, ok: false, error: "no section" }); continue; }
  try {
    const j = await callApi(c.book, c.chapter, text);
    const bad = (j.composition || []).filter((x) => x.herb && !herbInText(x.herb, text)).map((x) => x.herb);
    out.push({ book: c.book, chapter: c.chapter, ok: true, unmatchedHerbs: bad, extracted: j, sourceText: text.slice(0, 300), rescuedVia: "composition-reextract-20260725" });
    console.log(JSON.stringify({ name: j.name, herbs: (j.composition || []).length, unmatched: bad.length }));
  } catch (e) {
    out.push({ book: c.book, chapter: c.chapter, ok: false, error: String(e).slice(0, 120) });
  }
}
writeFileSync(resolve(OUTDIR, "composition-reextract.jsonl"), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(JSON.stringify({ total: out.length, ok: out.filter((r) => r.ok).length, clean: out.filter((r) => r.ok && !r.unmatchedHerbs.length).length }));
