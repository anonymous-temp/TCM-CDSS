// 剂量线歧义药味按方裁定(芍药/白蜜/萆薢/贝母/菖蒲/贯众 82 方,v4-pro 最高思考深度)。
// 纪律同 §8/§12:直书>交叉>方义推断>留空;白蜜需区分 真药味 vs 赋形剂(赋形剂保持阻断);
// 贯众只许绵马贯众一个目标(狗脊为错误映射,已排除)。
// 用法: DEEPSEEK_API_KEY=sk-... npx jiti scripts/ingest/dose-line-variety-adjudication.mjs [并发]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findSectionByFormulaName } from "./tcmoc-sections.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const OUTDIR = resolve(ROOT, "artifacts/dose-line-variety-adjudication");
mkdirSync(OUTDIR, { recursive: true });
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) throw new Error("DEEPSEEK_API_KEY required");
const CONC = Number(process.argv[2] || 4);
const WORK = JSON.parse(readFileSync(resolve(ROOT, "artifacts/dose-line-adjudicate-work.json"), "utf-8"));
const cat = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-formula-governed-catalog.json"), "utf-8")).entries;
const byName = new Map(cat.map((e) => [e.name, e]));

const SYS = `你是中医文献考据专家。按方裁定古方裸药名的品种/身份归属。可选结论见每项 options。
证据优先级:1.原书条文/注疏直书(最强);2.组成语境交叉;3.方义推断(配伍药对+主治+朝代药源);4.皆不足→留空(绝不猜)。
特别纪律:
- 白蜜:若方中作煎服/内服主药则为「蜂蜜」;若作炼蜜为丸/调敷赋形剂则为「保留阻断(赋形剂)」。
- 贯众:唯一目标「绵马贯众」,其他一律不选。
- 贝母:川贝润肺宜虚咳燥咳、浙贝清热散结宜实热痈肿、伊贝母只限原文直书或明确西北方书语境。
输出 JSON 数组:[{"name":"方名","to":"结论","confidence":"high|medium","evidence":"直书/交叉/推断 + ≤30字依据","blank":true|false}]
拿不准就 blank:true。只输出 JSON 数组。`;

async function callApi(batch, attempt = 0) {
  const payload = batch.map((w) => {
    const e = byName.get(w.name) || {};
    const found = findSectionByFormulaName(w.name);
    return {
      name: w.name, herb: w.herb, options: w.options,
      composition: (e.ingredients || []).join("、"),
      indications: (e.indications || e.standardIndications || []).join("；").slice(0, 160),
      source: e.source || "",
      sectionExcerpt: (found?.text || "").slice(0, 500),
    };
  });
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: `请裁定以下 ${batch.length} 首方剂的裸药名归属:\n${JSON.stringify(payload, null, 1)}` },
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
  if (lb < 0 || rb < 0) throw new Error(`no json: ${text.slice(0, 100)}`);
  return JSON.parse(text.slice(lb, rb + 1));
}

const PACK = 8;
const queue = [];
for (let i = 0; i < WORK.length; i += PACK) queue.push(WORK.slice(i, i + PACK));
const out = [];
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) {
    const batch = queue.shift();
    try {
      const arr = await callApi(batch);
      const byN = new Map(arr.filter((x) => x && typeof x === "object").map((x) => [String(x.name || ""), x]));
      for (const w of batch) {
        const j = byN.get(w.name);
        if (!j) { out.push({ ...w, ok: false, error: "missing" }); continue; }
        const valid = j.blank === true ? null : (w.options.includes(j.to) ? j.to : null);
        out.push({ ...w, ok: true, to: valid, confidence: j.confidence || "medium", evidence: String(j.evidence || "").slice(0, 100), blank: j.blank === true || !valid });
      }
    } catch (e) {
      for (const w of batch) out.push({ ...w, ok: false, error: String(e).slice(0, 120) });
    }
    console.log(JSON.stringify({ done: out.length, of: WORK.length }));
  }
}));
writeFileSync(resolve(OUTDIR, "adjudicated.json"), JSON.stringify(out, null, 2) + "\n");
const decided = out.filter((o) => o.ok && o.to && !o.blank);
console.log(JSON.stringify({ total: out.length, decided: decided.length, blank: out.filter((o) => o.blank).length, failed: out.filter((o) => !o.ok).length }));
