// v4 flash 方证批量抽取（多书通用版）：方书批 → 结构化方证 JSONL + 全文对拍
// 用法: DEEPSEEK_API_KEY=sk-... node scripts/ingest/tcmoc-formula-extract-books.mjs [并发] [书序号起] [书序号止]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const BOOKS_DIR = resolve(ROOT, "中医补充数据/tcmoc-master/books");
const OUTDIR = resolve(ROOT, "artifacts/tcmoc-formula-extract-books");
mkdirSync(OUTDIR, { recursive: true });
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) throw new Error("DEEPSEEK_API_KEY required");
const CONC = Number(process.argv[2] || 4);
const BOOK_START = Number(process.argv[3] || 0);
const BOOK_END = Number(process.argv[4] || 999);

// 本批：散文体方书（条文式条目结构，与医方集解同构）
const BOOKS = [
  "091-成方切用.txt", "072-医方考.txt", "082-古今名医方论.txt", "639-删补名医方论.txt",
  "089-医方论.txt", "092-时方妙用.txt", "088-绛雪园古方选注.txt", "071-医方集宜.txt",
  "067-仁斋直指方论（附补遗）.txt", "558-三因极一病证方论.txt",
].slice(BOOK_START, BOOK_END);

const FORMULA_CHAPTER = /(?:汤|丸|散|丹|膏|饮|方|煎|饮子|汁|粥|茶|酒|露|霜|锭|片|栓)$/;

function parseBook(file) {
  const raw = readFileSync(resolve(BOOKS_DIR, file), "utf-8");
  const title = (raw.slice(0, 800).match(/书名：([^\n]+)/) || [])[1]?.trim() || file.replace(/^\d+-|\.txt$/g, "");
  const sections = raw.split(/<篇名>/).slice(1)
    .map((s) => {
      const nl = s.indexOf("\n");
      return { chapter: s.slice(0, nl).trim(), body: s.slice(nl + 1).replace(/<目录>[^\n]*/g, "").trim() };
    })
    .filter((s) => s.chapter && s.body.length > 60)
    .filter((s) => FORMULA_CHAPTER.test(s.chapter) || s.body.includes("治"));
  return { title, sections };
}

const mkSystem = (book) => `你是中医古籍方证结构化抽取器。输入《${book}》的一个方剂条目（含 OCR 丢字），输出单个 JSON 对象，不要输出任何其他文字。
字段:
- name: 方名（条目篇名）
- source: 出处（条目内"（《xx》）"类，无则 null）
- composition: [{"herb":"规范药名","dose":"原文剂量或null","processing":"炮制或null"}]，只能包含原文组成行实际出现的药味；OCR 丢字按上下文修复并记录 ocrRepairs
- indications: 主治（原文摘要，≤80字）
- usage: 煎服法/用法（无则 null）
- modifications: [{"trigger":"原文加减条件","action":"加/减/换药名"}]
- analysis: 方义归经要点（≤60字）
- ocrRepairs: ["原样→修复样"]
要求：只输出 JSON；宁可少抽也绝不凭记忆补充药味；拿不准写 null。`;

async function callApi(book, entry, attempt = 0) {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: mkSystem(book) },
        { role: "user", content: `条目篇名：${entry.chapter}\n\n${entry.body.slice(0, 2200)}` },
      ],
      temperature: 0, max_tokens: 2200, thinking: { type: "disabled" }, stream: false,
    }),
  });
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    return callApi(book, entry, attempt + 1);
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || "";
  const lb = text.indexOf("{"), rb = text.lastIndexOf("}");
  if (lb < 0 || rb < 0) throw new Error(`no json: ${text.slice(0, 100)}`);
  return JSON.parse(text.slice(lb, rb + 1));
}

const t9 = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-herb-identity-catalog.json"), "utf-8"));
const ri = t9.resolutionIndex;
function herbInText(herb, text) {
  if (!herb) return false;
  if (text.includes(herb)) return true;
  for (const suf of ["子", "仁", "皮", "肉", "片", "炭", "末", "萸", "黄", "苓", "芍", "草", "参", "归", "芎", "朴", "芪", "桂", "母", "星", "夏", "枳", "姜", "枣"]) {
    if (herb.endsWith(suf) && text.includes(herb.slice(0, -1))) return true;
  }
  const v = ri[herb];
  if (v?.canonicalName && text.includes(v.canonicalName)) return true;
  if (herb.startsWith("熟地") && text.includes("熟地")) return true;
  if (herb === "厚朴" && text.includes("浓朴")) return true;
  return false;
}

const summary = {};
for (const file of BOOKS) {
  const { title, sections } = parseBook(file);
  const out = [];
  const queue = [...sections];
  let ok = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      try {
        const j = await callApi(title, entry);
        const bad = (j.composition || []).filter((c) => c.herb && !herbInText(c.herb, entry.body)).map((c) => c.herb);
        out.push({ book: title, chapter: entry.chapter, ok: true, unmatchedHerbs: bad, extracted: j, sourceText: entry.body.slice(0, 300) });
        ok++;
      } catch (e) {
        out.push({ book: title, chapter: entry.chapter, ok: false, error: String(e).slice(0, 160) });
      }
    }
  }));
  out.sort((a, b) => a.chapter.localeCompare(b.chapter, "zh"));
  writeFileSync(resolve(OUTDIR, `${title}.jsonl`), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
  summary[title] = { sections: sections.length, ok, unmatched: out.filter((r) => r.ok && r.unmatchedHerbs.length > 0).length };
  console.log(JSON.stringify({ book: title, ...summary[title] }));
}
writeFileSync(resolve(OUTDIR, "_summary.json"), JSON.stringify(summary, null, 2) + "\n");
