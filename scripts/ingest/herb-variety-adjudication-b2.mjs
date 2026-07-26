// 歧义药味按方裁定(第二批:剂量阻塞方):芍药/贝母/紫苏/皂角 → 品种,v4-pro + 证据纪律。
// 纪律沿用 §8.2-8.4:原书/注疏直书 > 全语料交叉(组成语境) > 方义推断(组成药对/朝代药源) > 留空。
// 拿不准一律留空(安全默认);判定必须引用依据,品种必须是 T9 已知名。
// 用法: DEEPSEEK_API_KEY=sk-... node scripts/ingest/herb-variety-adjudication-b2.mjs [并发]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sectionText, findSectionByFormulaName } from "./tcmoc-sections.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const OUTDIR = resolve(ROOT, "artifacts/herb-variety-adjudication-b2");
mkdirSync(OUTDIR, { recursive: true });
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) throw new Error("DEEPSEEK_API_KEY required");
const CONC = Number(process.argv[2] || 4);
const TARGETS = {
  芍药: ["白芍", "赤芍"],
  贝母: ["川贝母", "浙贝母", "土贝母"],
  紫苏: ["紫苏叶", "紫苏梗", "紫苏子"],
  皂角: ["皂荚", "猪牙皂"],
};

const cat = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-formula-governed-catalog.json"), "utf-8")).entries;
const supp = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-verified-formula-supplements.json"), "utf-8")).entries;
const t9 = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-herb-identity-catalog.json"), "utf-8"));
const t9Known = new Set(Object.keys(t9.resolutionIndex));
for (const v of Object.values(t9.resolutionIndex)) if (v?.canonicalName) t9Known.add(v.canonicalName);

// 收集剂量阻塞且组成含裸药名的方
const work = [];
for (const e of cat) {
  if (!e.doseBlockingReasons?.length) continue;
  const herbs = (e.ingredients || []).filter((h) => typeof h === "string" && TARGETS[h.trim()]);
  if (!herbs.length) continue;
  const s = supp[e.name] || {};
  const ver = (s.verification || [])[0] || {};
  const m = String(ver.url || "").match(/tcmoc-books:([^:]+):(.+)$/);
  let text = m ? sectionText(m[1], m[2]) : undefined;
  let book = m?.[1], chapter = m?.[2];
  if (!text) {
    const found = findSectionByFormulaName(e.name);
    if (found) { text = found.text; book = found.book; chapter = found.chapter; }
  }
  work.push({
    name: e.name, herbs,
    source: s.source || e.source || "",
    composition: (e.ingredients || []).join("、"),
    indications: (e.indications || s.indications || []).join("；").slice(0, 200),
    book, chapter, sectionText: (text || "").slice(0, 900),
  });
}
console.log(JSON.stringify({ formulas: work.length, byHerb: Object.fromEntries(Object.keys(TARGETS).map((t) => [t, work.filter((w) => w.herbs.includes(t)).length])) }));

const SYS = `你是中医文献考据专家。按方裁定古方裸药名的品种归属。可选结论:
芍药→白芍/赤芍;贝母→川贝母/浙贝母/土贝母;紫苏→紫苏叶/紫苏梗/紫苏子;皂角→皂荚/猪牙皂。
证据优先级:
1. 原书条文/注疏**直书**(如"白芍药""川贝""苏叶""牙皂")——最强,直接采纳;
2. 组成语境交叉(同书他处或他书同方写明品种);
3. 方义推断(配伍药对+主治+朝代药源习惯,如宋代以前芍药多不分、明清后赤白渐分;川贝润肺宜虚咳、浙贝清热宜实热;苏叶解表、苏梗安胎行气、苏子降气化痰;猪牙皂开窍力峻、皂荚涤痰通便)——必须写明推断链;
4. 以上皆不足 → 留空。**拿不准一律留空**,绝不猜。
输出 JSON 数组:[{"name":"方名","decisions":[{"herb":"芍药","to":"白芍","confidence":"high|medium","evidence":"直书/交叉/推断 + ≤40字依据"}],"blankHerbs":["拿不准的药名"]}]
只输出 JSON 数组。`;

async function callApi(batch, attempt = 0) {
  const payload = batch.map((w) => ({
    name: w.name, source: w.source, herbs: w.herbs, composition: w.composition,
    indications: w.indications, sectionExcerpt: w.sectionText.slice(0, 700),
  }));
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: `请裁定以下 ${batch.length} 首方剂的裸药名品种:\n${JSON.stringify(payload, null, 1)}` },
      ],
      temperature: 0, max_tokens: 4500, reasoning_effort: "high", thinking: { type: "enabled" }, stream: false,
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

const PACK = 6;
const queue = [];
for (let i = 0; i < work.length; i += PACK) queue.push(work.slice(i, i + PACK));
const out = [];
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) {
    const batch = queue.shift();
    try {
      const arr = await callApi(batch);
      const byName = new Map(arr.filter((x) => x && typeof x === "object").map((x) => [String(x.name || ""), x]));
      for (const w of batch) {
        const j = byName.get(w.name);
        if (!j) { out.push({ name: w.name, ok: false, error: "missing in response" }); continue; }
        const accepted = [], rejected = [];
        for (const d of j.decisions || []) {
          const allowed = TARGETS[d.herb] || [];
          if (!w.herbs.includes(d.herb)) { rejected.push({ ...d, why: "herb 不在该方裸名清单" }); continue; }
          if (!allowed.includes(d.to)) { rejected.push({ ...d, why: "to 非合法品种" }); continue; }
          if (!t9Known.has(d.to)) { rejected.push({ ...d, why: "to 不在 T9" }); continue; }
          accepted.push({ herb: d.herb, to: d.to, confidence: d.confidence || "medium", evidence: String(d.evidence || "").slice(0, 120) });
        }
        out.push({ name: w.name, ok: true, accepted, rejected, blankHerbs: j.blankHerbs || [] });
      }
    } catch (e) {
      for (const w of batch) out.push({ name: w.name, ok: false, error: String(e).slice(0, 140) });
    }
    console.log(JSON.stringify({ done: out.length, of: work.length }));
  }
}));
writeFileSync(resolve(OUTDIR, "adjudicated.json"), JSON.stringify(out, null, 2) + "\n");
const stats = {
  formulas: out.length,
  ok: out.filter((o) => o.ok).length,
  decisions: out.reduce((n, o) => n + (o.accepted || []).length, 0),
  rejected: out.reduce((n, o) => n + (o.rejected || []).length, 0),
  highConf: out.reduce((n, o) => n + (o.accepted || []).filter((a) => a.confidence === "high").length, 0),
};
console.log(JSON.stringify(stats));
