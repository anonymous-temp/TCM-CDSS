/**
 * 证型标签候选映射（闭集语义 → 人工裁定清单）。
 *
 * 为什么需要模型：按主治原文**字面匹配**受控证候词表，373 条全部零候选——
 * 古文主治写的是症状（半夏白术天麻汤「痰厥头痛，胸隔多痰，动则眩晕」），
 * 证候词表收的是证候名（痰浊上扰），两者字面不相交。这不是词表不全，是层级不同。
 *
 * ★ 本脚本产出的是「勾选清单」，不是标签 ★
 * 输出只写入 artifacts/，绝不写入 src/data、绝不进入运行时。给方剂打 syndromeTags
 * 决定它能否被身份锁锁定进而开成处方，属临床裁定，必须由人确认后再走既有治理通道入库。
 *
 * 闭集约束：模型只能从注入的受控证候候选里选，返回的 ID 逐一核对，不在闭集内的一律丢弃——
 * 模型无法引入任何新证候。低置信度条目保留但标注，供人优先复核。
 *
 * 密钥只从环境变量读，不写入任何文件：
 *   DEEPSEEK_API_KEY=sk-... npx jiti scripts/ingest/syndrome-tag-candidate-mapping.mjs [--limit=20] [--source=official_classic_catalog]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error("缺少 DEEPSEEK_API_KEY（或 OPENAI_API_KEY）环境变量。密钥不写入文件，请在命令行注入。");
  process.exit(2);
}
const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const MODEL = process.env.CONTROLLED_TERMINOLOGY_MODEL || "deepseek-v4-flash";

const catalog = JSON.parse(readFileSync("src/data/tcm-formula-governed-catalog.json", "utf8"));
const lexicon = JSON.parse(readFileSync("src/data/tcm-syndrome-lexicon.json", "utf8"));

/** 受控证候闭集：id → canonical，模型只能在此集合内选择。 */
const syndromeById = new Map();
for (const entry of lexicon.entries || []) {
  if (entry?.id && entry?.canonical) syndromeById.set(entry.id, entry.canonical);
}

const limitArg = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] || 0);
const sourceArg = process.argv.find((a) => a.startsWith("--source="))?.split("=")[1];

const pending = catalog.entries
  .filter((e) => e.retrievalEligible && (e.syndromeTags || []).length === 0 && e.doseCompilationEligible)
  .filter((e) => !sourceArg || e.sourceClass === sourceArg)
  // 经典方目录优先：临床价值最高、量最小。
  .sort((a, b) => (a.sourceClass === "official_classic_catalog" ? -1 : 0) - (b.sourceClass === "official_classic_catalog" ? -1 : 0));
const batch = limitArg > 0 ? pending.slice(0, limitArg) : pending;

/**
 * 每个方剂注入一份**按主治文本词面预筛**的候选证候，控制 token 且让模型只在闭集内选。
 * 预筛用脏器/病性词做粗召回，宁滥勿缺——真正的收敛靠模型判断 + 人工裁定两道。
 */
const AXES = ["心", "肝", "脾", "肺", "肾", "胃", "胆", "膀胱", "大肠", "小肠", "气", "血", "阴", "阳", "寒", "热", "湿", "痰", "瘀", "风", "燥", "火", "虚", "实"];
function prefilterSyndromes(indicationText) {
  const axes = AXES.filter((axis) => indicationText.includes(axis));
  const scored = [];
  for (const [id, canonical] of syndromeById) {
    const hits = axes.filter((axis) => canonical.includes(axis)).length;
    if (hits > 0) scored.push({ id, canonical, hits });
  }
  return scored.sort((a, b) => b.hits - a.hits || a.canonical.localeCompare(b.canonical)).slice(0, 40);
}

const SYSTEM = [
  "你是中医证候归类助手。给定一首方剂的主治原文和一组受控证候候选，判断该方主治最对应哪些证候。",
  "只能从给定候选里选，最多选 3 个，按契合度从高到低。",
  "输出严格 JSON：{\"picks\":[{\"id\":\"候选ID\",\"confidence\":0.0-1.0}],\"note\":\"一句话依据\"}",
  "候选里没有合适的就返回 {\"picks\":[],\"note\":\"候选不覆盖\"}——宁可不选，不要勉强。",
  "依据只能来自主治原文本身，不得引入原文没有的症状。",
].join("\n");

async function mapOne(entry) {
  const indicationText = (entry.indications || []).join("；").slice(0, 500);
  const candidates = prefilterSyndromes(indicationText);
  if (candidates.length === 0) return { formulaName: entry.name, sourceClass: entry.sourceClass, indicationText, picks: [], note: "预筛无候选" };
  const user = [
    `方名：${entry.name}`,
    `主治原文：${indicationText}`,
    "受控证候候选：",
    ...candidates.map((c) => `${c.id}\t${c.canonical}`),
  ].join("\n");
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      // 该模型会先产出 reasoning_content，预算不足会导致 content 为空（项目已知陷阱）。
      max_tokens: 1500,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
    }),
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const payload = await response.json();
  const raw = payload.choices?.[0]?.message?.content || "";
  let parsed = { picks: [], note: "" };
  // 模型可能把 JSON 包在代码围栏或前后缀里；取第一个平衡的对象再解析。
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  try { parsed = JSON.parse(jsonText); } catch { parsed = { picks: [], note: raw ? "解析失败" : "空响应" }; }
  // 闭集核验：不在本次候选集内的 ID 一律丢弃，模型无法引入新证候。
  const allowed = new Set(candidates.map((c) => c.id));
  const picks = (Array.isArray(parsed.picks) ? parsed.picks : [])
    .filter((p) => p && allowed.has(p.id))
    .slice(0, 3)
    .map((p) => ({ syndromeId: p.id, canonical: syndromeById.get(p.id), confidence: Number(p.confidence) || 0 }));
  return { formulaName: entry.name, sourceClass: entry.sourceClass, source: entry.source, indicationText, picks, note: String(parsed.note || "").slice(0, 120) };
}

const results = [];
let failed = 0;
const CONCURRENCY = 6;
for (let i = 0; i < batch.length; i += CONCURRENCY) {
  const slice = batch.slice(i, i + CONCURRENCY);
  const settled = await Promise.allSettled(slice.map(mapOne));
  for (const item of settled) {
    if (item.status === "fulfilled") results.push(item.value);
    else failed += 1;
  }
  process.stderr.write(`\r已处理 ${Math.min(i + CONCURRENCY, batch.length)}/${batch.length}  失败 ${failed}`);
}
process.stderr.write("\n");

if (!existsSync("artifacts")) mkdirSync("artifacts", { recursive: true });
const out = "artifacts/syndrome-tag-candidates.json";
writeFileSync(out, `${JSON.stringify({
  schemaVersion: "syndrome-tag-candidates-v1",
  model: MODEL,
  note: "勾选清单，非标签。必须人工裁定后再走既有治理通道入库；本文件不进入运行时。",
  summary: {
    processed: results.length,
    failed,
    withPicks: results.filter((r) => r.picks.length > 0).length,
    highConfidence: results.filter((r) => r.picks.some((p) => p.confidence >= 0.8)).length,
  },
  entries: results,
}, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  processed: results.length,
  failed,
  withPicks: results.filter((r) => r.picks.length > 0).length,
  highConfidence: results.filter((r) => r.picks.some((p) => p.confidence >= 0.8)).length,
  out,
}, null, 2));
