// 残余未解病名 v4-pro 批量归一裁定(中医师纪律:只映射无歧义的,拿不准一律留空)。
// 输入:现代医案未解病名(频次≥1,词表当前状态);输出:经验证的扩展别名(目标必须在词表)。
// 用法: DEEPSEEK_API_KEY=sk-... node scripts/ingest/disease-name-tail-adjudication.mjs [并发]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const OUTDIR = resolve(ROOT, "artifacts/disease-name-tail-adjudication");
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) throw new Error("DEEPSEEK_API_KEY required");
const CONC = Number(process.argv[2] || 4);

const { mkdirSync } = await import("node:fs");
mkdirSync(OUTDIR, { recursive: true });
const { resolveTcmDiseaseName } = await import("../../src/lib/clinical-terminology.ts");
const corpus = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-modern-case-eval-corpus.json"), "utf-8"));
const icd = JSON.parse(readFileSync(resolve(ROOT, "src/data/icd10-diagnosis-index.json"), "utf-8"));
const icdNames = new Set(icd.entries.map((e) => e.name));
const lex = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-disease-lexicon.json"), "utf-8"));
const known = new Set();
for (const e of lex.entries) { known.add(e.canonical); for (const a of e.aliases || []) known.add(a); }

const freq = new Map();
for (const c of corpus.cases) for (const d of c.diseases || []) {
  const n = String(d || "").trim();
  if (n) freq.set(n, (freq.get(n) || 0) + 1);
}
const targets = [...freq]
  .filter(([n]) => (resolveTcmDiseaseName(n) || {}).status === "unverified")
  .filter(([n]) => !icdNames.has(n))
  .sort((a, b) => b[1] - a[1]);
console.log(JSON.stringify({ targets: targets.length, totalFreq: targets.reduce((s, [, c]) => s + c, 0) }));

const SYS = `你是中医病名规范化专家(熟悉 GB/T 15657 中医病证分类与代码、规划教材与现代临床用名)。
输入一批现代医案里的病名写法,对每个给出归一裁定:
- to: 应归一的规范病名(只在身份明确时给出;异体字/俗称/亚型写法/中西医对应明确者才给)
- hold: true(身份不明、多指、过简、非病名、歧义时,宁可留空)
- note: ≤24字依据
铁律:病名身份是替换语义,判错=给错诊断;同名异物/多指必须 hold;西医病名(冠心病/胃炎等)不要映射,返回 hold 并标 western:true。
输出 JSON 数组:[{"name":"..","to":"..或null","hold":true|false,"western":true|false,"note":".."}]
只输出 JSON 数组。`;

async function callApi(batch, attempt = 0) {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: `请裁定以下 ${batch.length} 个病名写法:\n${JSON.stringify(batch.map(([n, c]) => ({ name: n, freq: c })), null, 0)}` },
      ],
      temperature: 0, max_tokens: 5000, reasoning_effort: "high", thinking: { type: "enabled" }, stream: false,
    }),
  });
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    return callApi(batch, attempt + 1);
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const text = (await res.json()).choices?.[0]?.message?.content || "";
  const lb = text.indexOf("["), rb = text.lastIndexOf("]");
  if (lb < 0 || rb < 0) throw new Error(`no json: ${text.slice(0, 120)}`);
  return JSON.parse(text.slice(lb, rb + 1));
}

const PACK = 25;
const queue = [];
for (let i = 0; i < targets.length; i += PACK) queue.push(targets.slice(i, i + PACK));
const out = [];
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) {
    const batch = queue.shift();
    try {
      const arr = await callApi(batch);
      const byName = new Map(arr.filter((x) => x && typeof x === "object").map((x) => [String(x.name || ""), x]));
      for (const [n, c] of batch) {
        const j = byName.get(n);
        if (!j) { out.push({ name: n, freq: c, ok: false }); continue; }
        out.push({ name: n, freq: c, ok: true, to: j.to || null, hold: j.hold !== false, western: j.western === true, note: String(j.note || "").slice(0, 80) });
      }
    } catch (e) {
      for (const [n, c] of batch) out.push({ name: n, freq: c, ok: false, error: String(e).slice(0, 120) });
    }
    console.log(JSON.stringify({ done: out.length, of: targets.length }));
  }
}));
writeFileSync(resolve(OUTDIR, "adjudicated.json"), JSON.stringify(out, null, 2) + "\n");
const mapped = out.filter((o) => o.ok && o.to && !o.hold);
const valid = mapped.filter((o) => known.has(o.to));
console.log(JSON.stringify({
  total: out.length,
  mapped: mapped.length,
  mappedFreq: mapped.reduce((s, o) => s + o.freq, 0),
  validTarget: valid.length,
  validFreq: valid.reduce((s, o) => s + o.freq, 0),
  western: out.filter((o) => o.western).length,
  held: out.filter((o) => o.ok && o.hold).length,
}));
