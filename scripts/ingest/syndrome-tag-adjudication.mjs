// 证型标签待裁定清单 → v4 pro(max effort) 辅助裁定 → 勾选清单
// 用法: DEEPSEEK_API_KEY=sk-... node scripts/ingest/syndrome-tag-adjudication.mjs [并发] [组过滤]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = resolve(ROOT, "artifacts/证型标签待裁定清单.md");
const OUTDIR = resolve(ROOT, "artifacts/syndrome-tag-adjudication");
mkdirSync(OUTDIR, { recursive: true });
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) throw new Error("DEEPSEEK_API_KEY required");
const CONC = Number(process.argv[2] || 4);
const GROUP_FILTER = process.argv[3] || "";

// ─── 解析清单 ───
const md = readFileSync(SRC, "utf-8");
const entries = [];
for (const block of md.split(/^### /m).slice(1)) {
  const lines = block.split("\n");
  const name = lines[0].trim();
  const srcM = block.match(/\*出处：([^*]+)\*/);
  const indM = block.match(/^> (.+)$/m);
  const cands = [...block.matchAll(/- \[ \] (.+?) {2}`([^`]+)` {2}\(模型置信 ([\d.]+)\)/g)]
    .map((m) => ({ name: m[1].trim(), id: m[2].trim(), conf: Number(m[3]) }));
  // 组标题从上级 ## 行推
  entries.push({ name, source: srcM?.[1]?.trim() || "", indications: indM?.[1]?.trim() || "", candidates: cands });
}
// 重新按 ## 组切分赋组
const groupOf = [];
for (const chunk of md.split(/^## /m)) {
  const gm = chunk.match(/^(.+?)（(\d+) 首）/);
  if (!gm) continue;
  const gname = gm[1].trim();
  const count = Number(gm[2]);
  for (let i = 0; i < count; i++) groupOf.push(gname);
}
if (groupOf.length === entries.length) entries.forEach((e, i) => (e.group = groupOf[i]));
const targets = GROUP_FILTER ? entries.filter((e) => e.group?.includes(GROUP_FILTER)) : entries;
console.log(`entries=${entries.length} targets=${targets.length}`);

// T1 词表：正名/别名 → id
const t1 = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-syndrome-lexicon.json"), "utf-8"));
const aliasToId = new Map();
const idToCanonical = new Map();
for (const e of t1.entries) {
  aliasToId.set(e.canonical, e.id);
  idToCanonical.set(e.id, e.canonical);
  for (const a of e.aliases || []) aliasToId.set(a, e.id);
}

const SYS = `你是中医方证证型裁定专家。任务：对每个方剂，依据其**主治原文**裁定它主治的核心证候（0–2 个）。
铁律：
1. 只允许勾选对主治原文**直接支持**的证候；主治里没有体现的绝不勾。主治过简无法判断 → 留空。
2. 证候必须是该方的**主证**（核心针对的病机），不是兼治、不是或然证。
3. 候选仅供阅读，**置信度不可信**——必须以主治原文为唯一依据。可勾 0 个、1 个或 2 个最贴的；也可在候选外给受控标准证候名（必须是国标《中医临床诊疗术语》体系内的规范名称）。
4. **拿不准就留空**——留空是安全默认，不判错。
5. 输出 JSON 数组（每方一项）：[{"name":"方名","decision":"adopt"|"blank","tags":["证候名"],"reason":"≤30字，引用主治原文关键点"}]
只输出 JSON 数组。`;

async function adjudicate(batch, attempt = 0) {
  const payload = batch.map((e) => ({
    name: e.name, source: e.source, indications: e.indications,
    candidates: e.candidates.map((c) => c.name),
  }));
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: `请裁定以下 ${batch.length} 首方剂：\n${JSON.stringify(payload, null, 1)}` },
      ],
      temperature: 0,
      max_tokens: 4000,
      reasoning_effort: "high",
      thinking: { type: "enabled" },
      stream: false,
    }),
  });
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    return adjudicate(batch, attempt + 1);
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || "";
  const lb = text.indexOf("["), rb = text.lastIndexOf("]");
  if (lb < 0 || rb < 0) throw new Error(`no json array: ${text.slice(0, 120)}`);
  return JSON.parse(text.slice(lb, rb + 1));
}

const BATCH = 5;
const batches = [];
for (let i = 0; i < targets.length; i += BATCH) batches.push(targets.slice(i, i + BATCH));
console.log(`batches=${batches.length}`);
const results = [];
let done = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (batches.length) {
    const batch = batches.shift();
    try {
      const out = await adjudicate(batch);
      for (const item of out) {
        const src = batch.find((e) => e.name === item.name) || {};
        // 确定性校验：tag 必须在 T1 可解析
        const tags = (item.decision === "adopt" ? item.tags || [] : [])
          .map((t) => ({ name: t, id: aliasToId.get(t) || aliasToId.get(String(t).replace(/证$/, "")) || null }))
          .filter((t) => t.id);
        const dropped = (item.decision === "adopt" ? item.tags || [] : []).length - tags.length;
        results.push({
          name: item.name, group: src.group || "", source: src.source || "",
          decision: tags.length > 0 ? "adopt" : "blank",
          tags: tags.map((t) => ({ name: idToCanonical.get(t.id) || t.name, id: t.id })),
          modelTags: item.tags || [], droppedUnresolved: dropped,
          reason: item.reason || "",
        });
      }
    } catch (e) {
      for (const e2 of batch) results.push({ name: e2.name, group: e2.group || "", decision: "error", error: String(e).slice(0, 160) });
    }
    done++;
    if (done % 10 === 0) console.log(`progress ${done}/${Math.ceil(targets.length / BATCH)}`);
  }
}));
results.sort((a, b) => entries.findIndex((e) => e.name === a.name) - entries.findIndex((e) => e.name === b.name));
writeFileSync(resolve(OUTDIR, "adjudicated.json"), JSON.stringify(results, null, 2) + "\n");
const adopt = results.filter((r) => r.decision === "adopt");
console.log(JSON.stringify({
  total: results.length,
  adopt: adopt.length,
  blank: results.filter((r) => r.decision === "blank").length,
  error: results.filter((r) => r.decision === "error").length,
  tagsTotal: adopt.reduce((s, r) => s + r.tags.length, 0),
  droppedUnresolved: results.reduce((s, r) => s + (r.droppedUnresolved || 0), 0),
}));
