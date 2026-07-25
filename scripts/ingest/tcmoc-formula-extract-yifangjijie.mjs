// v4 flash 方证批量抽取：医方集解全条目 → 结构化方证 JSONL + 原文对拍
// 用法: DEEPSEEK_API_KEY=sk-... node scripts/ingest/tcmoc-formula-extract-yifangjijie.mjs [并发] [起始序号] [结束序号]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = resolve(ROOT, "中医补充数据/tcmoc-master/books/087-医方集解.txt");
const OUTDIR = resolve(ROOT, "artifacts/tcmoc-formula-extract-yifangjijie");
mkdirSync(OUTDIR, { recursive: true });
const OUT = resolve(OUTDIR, "yifangjijie-full.jsonl");
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) throw new Error("DEEPSEEK_API_KEY required");
const CONC = Number(process.argv[2] || 4);
const START = Number(process.argv[3] || 0);
const END = Number(process.argv[4] || 10_000);

const raw = readFileSync(SRC, "utf-8");
const sections = raw.split(/<篇名>/).slice(1)
  .map((s) => {
    const nl = s.indexOf("\n");
    return { chapter: s.slice(0, nl).trim(), body: s.slice(nl + 1).replace(/<目录>[^\n]*/g, "").trim() };
  })
  .filter((s) => s.chapter && s.body.length > 80 && !/^(自序|凡例|目录)/.test(s.chapter))
  .filter((s) => !/(之剂第[一二三四五六七八九十]+|门第[一二三四五六七八九十]+)$/.test(s.chapter))
  .slice(START, END);

const SYSTEM = `你是中医古籍方证结构化抽取器。输入《医方集解》的一个方剂条目（含 OCR 丢字），输出单个 JSON 对象，不要输出任何其他文字。
字段:
- name: 方名（条目篇名）
- source: 出处（条目内"（《xx》）"类，无则 null）
- composition: [{"herb":"规范药名","dose":"原文剂量或null","processing":"炮制或null"}]，OCR 丢字按上下文与常识修复（如"黄 "后接"（炙。钱半）"应为"黄芪"），并在 ocrRepairs 记录
- indications: 主治（原文摘要，≤80字）
- usage: 煎服法/用法（无则 null）
- modifications: [{"trigger":"原文加减条件","action":"加/减/换药名"}]
- analysis: 方义归经要点（≤60字）
- ocrRepairs: ["原样→修复样"]
要求：只输出 JSON；药名去括号剂量写规范名；拿不准的字段写 null 不编造。`;

async function callApi(entry, attempt = 0) {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `条目篇名：${entry.chapter}\n\n${entry.body.slice(0, 2200)}` },
      ],
      temperature: 0,
      max_tokens: 2200,
      thinking: { type: "disabled" },
      stream: false,
    }),
  });
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    return callApi(entry, attempt + 1);
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || "";
  const lb = text.indexOf("{"), rb = text.lastIndexOf("}");
  if (lb < 0 || rb < 0) throw new Error(`no json: ${text.slice(0, 100)}`);
  return JSON.parse(text.slice(lb, rb + 1));
}

// 对拍：组成药名必须能在原文中找到，或在 ocrRepairs 中声明了修复来源
function crossCheck(entry, j) {
  const text = entry.body;
  const issues = [];
  for (const c of j.composition || []) {
    const herb = String(c.herb || "");
    if (!herb) { issues.push("empty_herb"); continue; }
    if (text.includes(herb)) continue;
    const repaired = (j.ocrRepairs || []).some((r) => String(r).includes("→") && String(r).split("→")[1].includes(herb));
    const looseMatch = herb.length >= 2 && [...herb].every((ch) => text.includes(ch)) && (j.ocrRepairs || []).length > 0;
    if (!repaired && !looseMatch) issues.push(`herb_not_in_source:${herb}`);
  }
  if (j.name && j.name !== entry.chapter && !entry.chapter.includes(j.name) && !String(j.name).includes(entry.chapter)) {
    issues.push(`name_mismatch:${j.name}!=${entry.chapter}`);
  }
  if (!Array.isArray(j.composition) || j.composition.length === 0) issues.push("no_composition");
  return issues;
}

let done = 0, ok = 0;
const results = [];
const queue = sections.map((entry, i) => ({ entry, i }));
async function worker() {
  while (queue.length) {
    const { entry, i } = queue.shift();
    try {
      const j = await callApi(entry);
      const issues = crossCheck(entry, j);
      results.push({ seq: START + i, chapter: entry.chapter, ok: true, issues, extracted: j, sourceText: entry.body.slice(0, 400) });
      ok++;
    } catch (e) {
      results.push({ seq: START + i, chapter: entry.chapter, ok: false, error: String(e).slice(0, 200) });
    }
    done++;
    if (done % 20 === 0) console.log(`progress ${done}/${sections.length} (ok=${ok})`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
results.sort((a, b) => a.seq - b.seq);
writeFileSync(OUT, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
const withIssues = results.filter((r) => r.ok && r.issues.length > 0);
console.log(JSON.stringify({ total: results.length, ok, failed: results.length - ok, withIssues: withIssues.length, out: OUT }));
