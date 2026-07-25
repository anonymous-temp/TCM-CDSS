// v4 flash 方证抽取 pilot：医方集解 <篇名> 条目 → 结构化方证 JSON
// 用法: DEEPSEEK_API_KEY=sk-... node scripts/ingest/tcmoc-formula-extract-pilot.mjs [条目数上限]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = resolve(ROOT, "中医补充数据/tcmoc-master/books/087-医方集解.txt");
const OUT = resolve(ROOT, "artifacts/tcmoc-formula-extract-yifangjijie-pilot.jsonl");
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) throw new Error("DEEPSEEK_API_KEY required");
const LIMIT = Number(process.argv[2] || 10);

const raw = readFileSync(SRC, "utf-8");
const sections = raw.split(/<篇名>/).slice(1)
  .map((s) => {
    const nl = s.indexOf("\n");
    return { chapter: s.slice(0, nl).trim(), body: s.slice(nl + 1).replace(/<目录>[^\n]*/g, "").trim() };
  })
  .filter((s) => s.chapter && s.body.length > 80 && !/^(自序|凡例|目录)/.test(s.chapter));

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

async function extract(entry) {
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
      max_tokens: 2000,
      thinking: { type: "disabled" },
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || "";
  const lb = text.indexOf("{"), rb = text.lastIndexOf("}");
  if (lb < 0 || rb < 0) throw new Error(`no json in output: ${text.slice(0, 120)}`);
  return JSON.parse(text.slice(lb, rb + 1));
}

const results = [];
for (const entry of sections.slice(0, LIMIT)) {
  try {
    const j = await extract(entry);
    results.push({ chapter: entry.chapter, ok: true, extracted: j });
    console.log(`✓ ${entry.chapter}: ${(j.composition || []).map((c) => c.herb).join("、").slice(0, 60)}`);
  } catch (e) {
    results.push({ chapter: entry.chapter, ok: false, error: String(e).slice(0, 200) });
    console.log(`✗ ${entry.chapter}: ${String(e).slice(0, 120)}`);
  }
}
writeFileSync(OUT, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} ok -> ${OUT}`);
