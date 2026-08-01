// 缺字药名 LLM 修复器（v4 pro，构建期）：逐方给出 源段原文+缺字组成,修复单字药名。
// 证据纪律:修复结果必须 a) 原文支持(evidence=text,全名或其长形出现在源段) 或
// b) 该方通行组成知识(evidence=canonical,标注备查)——两都不占进复核队列,绝不猜。
// 真单字物料(盐/酒/醋/蜜/茶/葱/蜡/墨)按通行名归一(食盐/黄酒/米醋/蜂蜜/茶叶/葱白/蜂蜡/京墨)。
// 用法: DEEPSEEK_API_KEY=sk-... node scripts/ingest/corrupt-herb-repair-llm.mjs [并发]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const WORK = JSON.parse(readFileSync(resolve(ROOT, process.env.WORKLIST || "artifacts/corrupt-herb-repair/worklist.json"), "utf-8"));
const OUTDIR = resolve(ROOT, "artifacts/corrupt-herb-repair");
const OUTFILE = process.env.OUTFILE || "repairs.json";
const KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
if (!KEY) throw new Error("DEEPSEEK_API_KEY or OPENAI_API_KEY required");
const BASE_URL = String(
  process.env.DEEPSEEK_API_KEY
    ? (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com")
    : (process.env.OPENAI_BASE_URL || "https://api.deepseek.com"),
).replace(/\/+$/, "");
const MODEL = process.env.CORRUPT_HERB_REPAIR_MODEL || "deepseek-v4-pro";
const CONC = Number(process.argv[2] || 4);
const PACK = Number(process.env.PACK || 10);

const SYSTEM = `你是中医古籍 OCR 缺字修复师。输入若干首方剂的源段原文与其当前组成（含单字缺字药名），对每首输出一个 JSON 对象，整体组成 JSON 数组，不要输出其他文字。
每条字段:
- name: 方名（与输入一致）
- repairs: [{"from":"缺字","to":"修复后全名","evidence":"text|canonical|substance","quote":"原文依据片段(≤30字,evidence=text 时必填)"}]
  - evidence=text: 全名（或其更长形,如 官桂→肉桂）就出现在源段中
  - evidence=canonical: 源段不支持,但该方通行组成明确（如《三因方》三圣丸之砂即朱砂）
  - evidence=substance: 真单字物料的通行归一（盐→食盐、酒→黄酒、醋→米醋、蜜→蜂蜜、茶→茶叶、葱→葱白、蜡→蜂蜡、墨→京墨）
- unrepairable: ["无法修复的缺字"](两不占时列出,绝不猜)
要求:只输出 JSON 数组;to 必须是完整规范药名(≥2字,物料归一除外);宁进 unrepairable 也不猜。`;

async function callApi(user, attempt = 0) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
      temperature: 0,
      max_tokens: 5000,
      reasoning_effort: "high",
      thinking: { type: "enabled" },
      stream: false,
    }),
  });
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    return callApi(user, attempt + 1);
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const text = (await res.json()).choices?.[0]?.message?.content || "";
  const lb = text.indexOf("["), rb = text.lastIndexOf("]");
  if (lb < 0 || rb < 0) throw new Error(`no json: ${text.slice(0, 100)}`);
  return JSON.parse(text.slice(lb, rb + 1));
}

const t9 = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-herb-identity-catalog.json"), "utf-8"));
const ri = t9.resolutionIndex;
const knownHerb = new Set(Object.keys(ri));
for (const v of Object.values(ri)) {
  if (v?.canonicalName) knownHerb.add(v.canonicalName);
  for (const a of v?.aliases || []) knownHerb.add(a);
}
function herbInText(herb, text) {
  if (!herb) return false;
  if (text.includes(herb)) return true;
  for (const suf of ["子", "仁", "皮", "肉", "片", "炭", "末", "萸", "黄", "苓", "芍", "草", "参", "归", "芎", "朴", "芪", "桂", "母", "星", "夏", "枳", "姜", "枣"]) {
    if (herb.endsWith(suf) && text.includes(herb.slice(0, -1))) return true;
  }
  const v = ri[herb];
  if (v?.canonicalName && text.includes(v.canonicalName)) return true;
  for (const a of v?.aliases || []) if (text.includes(a)) return true;
  return false;
}
const queue = [];
for (let i = 0; i < WORK.length; i += PACK) queue.push(WORK.slice(i, i + PACK));
const out = [];
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) {
    const pack = queue.shift();
    const user = pack.map((w, k) =>
      `【方${k + 1}】${w.name}（${w.book || "?"}·${w.chapter || "?"}）\n缺字:${w.singles.join("、")}\n现组成:${(w.currentIngredients || []).join("、")}\n源段:\n${(w.sectionText || "").slice(0, 1000)}`
    ).join("\n\n");
    let arr;
    try {
      arr = await callApi(user);
      if (!Array.isArray(arr)) throw new Error("not array");
    } catch (e) {
      for (const w of pack) out.push({ name: w.name, ok: false, error: String(e).slice(0, 120) });
      continue;
    }
    const byName = new Map(arr.filter((x) => x && typeof x === "object").map((x) => [String(x.name || ""), x]));
    for (const w of pack) {
      const j = byName.get(w.name);
      if (!j) { out.push({ name: w.name, ok: false, error: "missing in response" }); continue; }
      // 确定性复核
      const good = [], bad = [];
      for (const r of j.repairs || []) {
        const from = String(r.from || "").trim(), to = String(r.to || "").trim();
        if (!w.singles.includes(from)) { bad.push({ ...r, why: "from 不在缺字清单" }); continue; }
        if (to.length < 2) { bad.push({ ...r, why: "to 仍是单字" }); continue; }
        if (!knownHerb.has(to) && !ri[to]) { bad.push({ ...r, why: "to 不在 T9 药名表" }); continue; }
        if (r.evidence === "text" && !herbInText(to, w.sectionText || "")) { bad.push({ ...r, why: "声称原文支持但原文无此名" }); continue; }
        good.push({ from, to, evidence: r.evidence, quote: r.quote || null });
      }
      const repaired = new Set(good.map((g) => g.from));
      out.push({ name: w.name, ok: true, repairs: good, rejected: bad, unrepairable: [...new Set([...(j.unrepairable || []), ...w.singles.filter((s) => !repaired.has(s))])] });
    }
    console.log(JSON.stringify({ done: out.length, of: WORK.length }));
  }
}));
writeFileSync(resolve(OUTDIR, OUTFILE), JSON.stringify(out, null, 2) + "\n");
const stats = {
  formulas: out.length,
  fullyRepaired: out.filter((o) => o.ok && o.unrepairable.length === 0 && o.repairs.length > 0).length,
  partial: out.filter((o) => o.ok && o.unrepairable.length > 0).length,
  failed: out.filter((o) => !o.ok).length,
  repairs: out.reduce((n, o) => n + (o.repairs || []).length, 0),
  canonicalEvidence: out.reduce((n, o) => n + (o.repairs || []).filter((r) => r.evidence === "canonical").length, 0),
};
console.log(JSON.stringify(stats));
