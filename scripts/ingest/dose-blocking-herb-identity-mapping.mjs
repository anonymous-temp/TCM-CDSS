// 剂量阻断药名 → 药典正名候选映射（v4 pro，闭集约束，产出勾选清单）
//
// ★ 为什么产出是勾选清单而不是直接入库 ★
// 药味身份决定**开出去的是什么药**，是替换语义：判错不是少给剂量，是给错药。
// 实测反例足够多：竹节白附子→白附子 会把禹白附（天南星科）与关白附（毛茛科，毒性更强）合并；
// 大附子、炒杏仁这类去缀归一同样触及毒性药。所以这一层只做**证据收集**，裁定权在人。
//
// ★ 闭集约束 ★
// 模型只能从 T9 里**已有数值剂量边界**的标准名中选。选不出就返回 null——它无法引入任何新药材，
// 也无法把一味药映射到一个连剂量上下限都没有的名字（那样映射了也解不开阻断）。
// 返回的名字逐一核对，不在闭集内一律丢弃。
//
// ★ 不在处理范围 ★
// 含禁用（犀角/穿山甲…）或毒剧药（巴豆/川乌/水银/斑蝥…）的方剂**保持阻断**。
// 那不是缺陷，是正确的保守行为；把它们"解开"等于让系统自动给毒剧药配剂量。
//
// 密钥只从环境变量读，不写入任何文件：
//   node --env-file-if-exists=.env.local scripts/ingest/dose-blocking-herb-identity-mapping.mjs [并发] [--limit=N]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error("缺少 DEEPSEEK_API_KEY（或 OPENAI_API_KEY）。密钥不写入文件，请用 --env-file-if-exists=.env.local 注入。");
  process.exit(2);
}
const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const MODEL = process.env.DOSE_IDENTITY_MODEL || "deepseek-v4-pro";
const CONC = Number(process.argv[2] || 4);
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] || 0);

const catalog = JSON.parse(readFileSync("src/data/tcm-formula-governed-catalog.json", "utf8"));
const knowledge = JSON.parse(readFileSync("src/data/tcm-knowledge.json", "utf8"));

/** 闭集：T9/KB 里**同时**有标准名与数值剂量边界的药材。映射不到这里面就没有意义。 */
const doseBounded = new Map();
for (const herb of knowledge.herbs || []) {
  const name = String(herb.name || "").trim();
  if (!name) continue;
  // 剂量边界在 entries[] 里，type=dose 的条目带 minG/maxG（药典 2020 一部）。
  const dose = (herb.entries || []).find((item) => item.type === "dose" && item.minG != null && item.maxG != null);
  if (dose) doseBounded.set(name, { min: dose.minG, max: dose.maxG, basis: dose.basis });
}
if (doseBounded.size === 0) throw new Error("闭集为空：tcm-knowledge.json 的剂量字段名可能变了，先修这里再跑");

// 禁用与毒剧：这些方保持阻断，不进本轮
const BANNED = /^(犀角|穿山甲|虎骨|羚羊角|玳瑁|象皮|豹骨|海龙)/;
const TOXIC = /^(巴豆|川乌|草乌|乌头|附子|生半夏|生南星|马钱子|番木鳖|斑蝥|蟾酥|水银|轻粉|粉霜|黄丹|铅丹|密陀僧|砒|信石|硇砂|胆矾|藜芦|甘遂|大戟|芫花|狼毒|闹羊花|洋金花|雄黄|雌黄|硫黄|硫磺|银朱|铅粉|水蛭|虻虫|蜈蚣|全蝎|土鳖|蟅虫|白附子|竹节白附子|朱砂|丹砂)/;
const blockedSubstance = (name) => BANNED.test(name) || TOXIC.test(name);

/** 待解析药名 → 出现在哪些方里（供模型判断语境）。只收非毒剧、且方剂本身不含毒剧药的。 */
const byHerb = new Map();
for (const entry of catalog.entries) {
  if (!entry.retrievalEligible || entry.doseCompilationEligible) continue;
  const blockers = [...new Set([
    ...(entry.unresolvedDoseIngredientNames || []),
    ...(entry.missingDoseBoundaryIngredientNames || []),
  ])];
  if (blockers.some(blockedSubstance)) continue;
  for (const herb of blockers) {
    if (blockedSubstance(herb)) continue;
    const bucket = byHerb.get(herb) || { formulas: [], blockedFormulaCount: 0 };
    if (bucket.formulas.length < 4) bucket.formulas.push({ name: entry.name, source: entry.source });
    bucket.blockedFormulaCount += 1;
    byHerb.set(herb, bucket);
  }
}
const targets = [...byHerb.entries()]
  .map(([herb, info]) => ({ herb, ...info }))
  .sort((a, b) => b.blockedFormulaCount - a.blockedFormulaCount);
const batch = LIMIT > 0 ? targets.slice(0, LIMIT) : targets;

/** 字面预筛：给模型一份**受控闭集子集**，控 token 且让它只在其中选。宁滥勿缺。 */
const boundedNames = [...doseBounded.keys()];
function prefilter(herb) {
  const bare = herb.replace(/^(生|炒|炙|煅|制|醋|酒|盐|蜜|姜|土|麸|焦|煨|净|明|真|好|上|大|小|嫩|老)+/, "")
    .replace(/(仁|肉|皮|尖|梢|须|心|末|霜|炭|片|丝)$/, "");
  const scored = boundedNames.map((name) => {
    let score = 0;
    for (const ch of new Set(bare)) if (name.includes(ch)) score += 1;
    if (name.includes(bare) || bare.includes(name)) score += 4;
    return { name, score };
  }).filter((item) => item.score > 0);
  return scored.sort((a, b) => b.score - a.score).slice(0, 45).map((item) => item.name);
}

const SYSTEM = [
  "你是中药材品名考据助手。给定一个古方组成里出现的药名，判断它对应现行《中国药典》体系里的哪一个标准名。",
  "只能从给定的「受控标准名候选」里选，选不出就返回 null——你不能引入候选外的名字。",
  "输出严格 JSON：{\"standardName\":\"候选之一或null\",\"basis\":\"≤40字依据\",\"confidence\":0.0-1.0,\"caution\":\"同名异物或毒性提示，无则空串\"}",
  "判定纪律：",
  "1. 只有**确属同一药材**才映射。仅仅名字相似、或同科不同属，一律返回 null。",
  "2. 涉及同名异物必须返回 null 并在 caution 写明。例：白附子有禹白附（天南星科）与关白附（毛茛科）两种，毒性不同，不可合并。",
  "3. 炮制品与生品若药典分列且用量不同，按原文写的那个判；分不清返回 null。",
  "4. 食药同源之物（粳米、葱白、白蜜、黄酒等）若药典未收标准饮片名，返回 null——它们不该走饮片剂量编制。",
  "5. 拿不准一律 null。留空的方剂保持不可编译剂量，这是安全默认，不会造成错误处方。",
].join("\n");

async function mapOne(item, attempt = 0) {
  const candidates = prefilter(item.herb);
  if (candidates.length === 0) {
    return { herb: item.herb, blockedFormulaCount: item.blockedFormulaCount, standardName: null, basis: "预筛无候选", confidence: 0, caution: "" };
  }
  const user = [
    `古方药名：${item.herb}`,
    `它阻断了 ${item.blockedFormulaCount} 首方的剂量编制。出现于：`,
    ...item.formulas.map((f) => `  《${f.source}》${f.name}`),
    "",
    "受控标准名候选（只能从中选，均已有数值剂量边界）：",
    candidates.join("、"),
  ].join("\n");
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 2000,
        reasoning_effort: "max",
        thinking: { type: "enabled" },
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
      }),
    });
    if (response.status === 429 && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 4000 * (attempt + 1)));
      return mapOne(item, attempt + 1);
    }
    if (!response.ok) throw new Error(`http_${response.status}`);
    const payload = await response.json();
    const raw = payload.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
    // 闭集核验：不在本次候选内、或没有剂量边界的，一律丢弃。
    const proposed = String(parsed.standardName ?? "").trim();
    const accepted = proposed && candidates.includes(proposed) && doseBounded.has(proposed) ? proposed : null;
    return {
      herb: item.herb,
      blockedFormulaCount: item.blockedFormulaCount,
      exampleFormulas: item.formulas,
      standardName: accepted,
      doseBound: accepted ? doseBounded.get(accepted) : null,
      rejectedProposal: proposed && !accepted ? proposed : "",
      basis: String(parsed.basis || "").slice(0, 120),
      confidence: Number(parsed.confidence) || 0,
      caution: String(parsed.caution || "").slice(0, 120),
    };
  } catch (error) {
    return { herb: item.herb, blockedFormulaCount: item.blockedFormulaCount, standardName: null, basis: `失败:${String(error).slice(0, 60)}`, confidence: 0, caution: "" };
  }
}

const results = [];
for (let i = 0; i < batch.length; i += CONC) {
  const slice = batch.slice(i, i + CONC);
  results.push(...await Promise.all(slice.map(mapOne)));
  process.stderr.write(`\r已处理 ${Math.min(i + CONC, batch.length)}/${batch.length}`);
}
process.stderr.write("\n");

if (!existsSync("artifacts")) mkdirSync("artifacts", { recursive: true });
const out = "artifacts/dose-blocking-herb-identity-candidates.json";
const mapped = results.filter((r) => r.standardName);
writeFileSync(out, `${JSON.stringify({
  schemaVersion: "dose-blocking-herb-identity-candidates-v1",
  model: MODEL,
  note: "勾选清单，非映射表。药味身份是替换语义（判错=给错药），必须人工裁定后再走既有治理通道入库；本文件不进入运行时。含禁用/毒剧药的方剂已排除在外，保持阻断是正确行为。",
  summary: {
    processed: results.length,
    mapped: mapped.length,
    blank: results.length - mapped.length,
    rejectedOutOfClosedSet: results.filter((r) => r.rejectedProposal).length,
    withCaution: results.filter((r) => r.caution).length,
    unlockableFormulaInstances: mapped.reduce((sum, r) => sum + r.blockedFormulaCount, 0),
  },
  entries: results,
}, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  processed: results.length,
  mapped: mapped.length,
  blank: results.length - mapped.length,
  rejectedOutOfClosedSet: results.filter((r) => r.rejectedProposal).length,
  unlockableFormulaInstances: mapped.reduce((sum, r) => sum + r.blockedFormulaCount, 0),
  out,
}, null, 2));
