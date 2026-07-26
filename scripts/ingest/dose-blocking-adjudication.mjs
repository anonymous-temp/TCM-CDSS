// 剂量阻断药名 300 个:中医师裁定(v4-pro 最高思考深度)→ 勾选清单 + T9 通道导入件。
// 纪律:身份是替换语义(判错=给错药),同名异物一律留空;赋形/外用载体语境要标 riskClass,
// 不勾是默认答案;判定必须给依据。输出文案一律称「中医师裁定」。
// 用法: DEEPSEEK_API_KEY=sk-... node scripts/ingest/dose-blocking-adjudication.mjs [并发]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const OUTDIR = resolve(ROOT, "artifacts/dose-blocking-adjudication");
mkdirSync(OUTDIR, { recursive: true });
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) throw new Error("DEEPSEEK_API_KEY required");
const CONC = Number(process.argv[2] || 4);
const WORK = JSON.parse(readFileSync(resolve(ROOT, "artifacts/dose-blocking-300-worklist.json"), "utf-8"));

const SYS = `你是世界最专业的中医师兼本草文献考据家。对每个「剂量阻断药名」裁定其身份归属与处置。
候选提案来自闭集(仅含已有药典数值剂量的标准名)。逐条给出:
- decision: "adopt"(采纳提案)/"adjust"(采纳但改标准名或加注)/"blank"(不勾,保持阻断)
- standardName: 最终标准名(adopt/adjust 时必填)
- riskClass: "none"|"excipient"(赋形/外用载体为主,剂量语义≠饮片煎服)|"toxic"(毒剧贴边)|"homonym"(同名异物风险)
- evidence: ≤50字依据(文献/药典/炮制常识,写明判定点)
铁律:
1. 同名异物必须 blank(如白附子=禹白附/关白附,毒性不同,合并即事故)。
2. 药方里以赋形/外用为主的物料(炼蜜为丸、油膏调敷、黄蜡、猪膏类),即使身份可定,也标 excipient——身份映射可对,但须注明剂量语义不属饮片。
3. 毒性药(马钱子/斑蝥/砒霜/水银/铅粉/生乌头生附子生半夏生南星生巴豆等及其制品)一律 blank 并标 toxic——给毒性药自动配剂量是系统最不该做的事。
4. 拿不准一律 blank——不勾是默认答案,留空不是保守是负责。
5. 古今正名演变(旋复花→旋覆花、蓬术→莪术、葫芦巴→胡芦巴)且药性无异者,果断 adopt。
输出 JSON 数组:[{"name":"药名","decision":"...","standardName":"...","riskClass":"...","evidence":"..."}]
只输出 JSON 数组。`;

async function callApi(batch, attempt = 0) {
  const payload = batch.map((e) => ({
    name: e.name, blockedCount: e.blockedCount, exampleFormulas: e.formulas,
    proposal: { standardName: e.proposal, dose: e.dose, basis: e.basis, doseBasis: e.doseBasis, formDist: e.formDist },
  }));
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: `请裁定以下 ${batch.length} 个药名:\n${JSON.stringify(payload, null, 1)}` },
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

const t9 = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-herb-identity-catalog.json"), "utf-8"));
const t9Known = new Set(Object.keys(t9.resolutionIndex));
for (const v of Object.values(t9.resolutionIndex)) {
  if (v?.canonicalName) t9Known.add(v.canonicalName);
  for (const a of v?.aliases || []) t9Known.add(a);
  for (const c of v?.candidates || []) t9Known.add(c);
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
      const byName = new Map(arr.filter((x) => x && typeof x === "object").map((x) => [String(x.name || ""), x]));
      for (const e of batch) {
        const j = byName.get(e.name);
        if (!j) { out.push({ ...e, ok: false, error: "missing in response" }); continue; }
        const decision = ["adopt", "adjust", "blank"].includes(j.decision) ? j.decision : "blank";
        const std = String(j.standardName || e.proposal || "").trim();
        const warn = decision !== "blank" && !t9Known.has(std) ? `standardName 不在 T9:${std}` : null;
        out.push({
          ...e, ok: true, decision, standardName: decision === "blank" ? null : std,
          riskClass: ["none", "excipient", "toxic", "homonym"].includes(j.riskClass) ? j.riskClass : "none",
          evidence: String(j.evidence || "").slice(0, 150), t9Warning: warn,
        });
      }
    } catch (e2) {
      for (const e of batch) out.push({ ...e, ok: false, error: String(e2).slice(0, 140) });
    }
    console.log(JSON.stringify({ done: out.length, of: WORK.length }));
  }
}));
writeFileSync(resolve(OUTDIR, "adjudicated.json"), JSON.stringify(out, null, 2) + "\n");
const stats = {
  total: out.length,
  adopt: out.filter((o) => o.decision === "adopt").length,
  adjust: out.filter((o) => o.decision === "adjust").length,
  blank: out.filter((o) => o.decision === "blank").length,
  excipient: out.filter((o) => o.riskClass === "excipient").length,
  toxic: out.filter((o) => o.riskClass === "toxic").length,
  homonym: out.filter((o) => o.riskClass === "homonym").length,
  t9Warn: out.filter((o) => o.t9Warning).length,
  failed: out.filter((o) => !o.ok).length,
};
console.log(JSON.stringify(stats));
