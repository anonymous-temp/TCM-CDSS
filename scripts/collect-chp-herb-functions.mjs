// 国家药典委员会《中华人民共和国药典》2020 年版一部功效正文治理批次。
//
// 目标不是“尽量多抓”，而是从当前运行时确认为数据缺口的药味中，选出临床评测语料里
// 使用频率最高、且药典词条身份能精确回指的 84 味。任何一项不满足即跳过：
//   1. 当前 getTcmHerbFunctionText 只有分类标签、没有功效正文；
//   2. 药典词条标题与规范药名逐字一致（不替身份分叉名做猜测）；
//   3. 【功能与主治】能明确切出“功能”段，不混入“用于……”主治；
//   4. 功效正文至少能映射到一个受控治法概念。
//
// 默认只打印候选与拒绝原因；加 --apply 才追加到受治理补充表。
// 网络来源：国家药典委员会药典在线 https://ydz.chp.org.cn/
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const knowledgePath = path.join(repoRoot, "src/data/tcm-knowledge.json");
const corpusPath = path.join(repoRoot, "src/data/tcm-modern-case-eval-corpus.json");
const targetPath = path.join(repoRoot, "src/data/tcm-herb-function-supplements.source.json");
// 批次参数化。**默认行为不变**：不传 CHP_BATCH_ID 时仍是对首批 84 味做在线逐条复核，
// 既有的幂等保证（重复执行不会追加第二批）原样保留。
// 传 CHP_BATCH_ID=<新批次号> 才会挑选下一批缺口药味——这样补第二批不必改代码，
// 也不会因为改了常量就把首批的复核路径弄丢。
const BATCH_ID = process.env.CHP_BATCH_ID || "CHP2020-FUNCTION-20260814";
const REGRESSION_BATCH_ID = "CHP2020-FUNCTION-REGRESSION-20260814";
// 批量大小随批次走：首批是历史约定的 84，新批默认取当前全部可抓缺口（由 CHP_BATCH_SIZE 覆盖）。
const BATCH_SIZE = Number(process.env.CHP_BATCH_SIZE || (process.env.CHP_BATCH_ID ? 0 : 84));
const APPLY = process.argv.includes("--apply");

const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { getTcmHerbFunctionText } = await jiti.import("../src/lib/tcm-knowledge.ts");
const { affirmedTcmTherapyConcepts } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");

const knowledge = JSON.parse(readFileSync(knowledgePath, "utf8"));
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const target = JSON.parse(readFileSync(targetPath, "utf8"));
const existing = new Set((target.entries || []).map((entry) => String(entry.herb || "").trim()));
const existingBatch = (target.entries || []).filter((entry) => entry.reviewBatch === BATCH_ID);
const regressionBatch = (target.entries || []).filter((entry) => entry.reviewBatch === REGRESSION_BATCH_ID);

// 这些词不是一种确定的饮片身份。给它们补一个全局功效会跨越白芍/赤芍、川贝母/浙贝母等
// 既有身份门禁；正确处置是先完成按方身份裁定，而不是把不确定性藏进补充表。
const IDENTITY_FORKS = new Set(["芍药", "贝母", "沙参", "皂角", "菖蒲", "紫苏"]);

function hasOnlyCategoryLabels(herb) {
  const raw = String(getTcmHerbFunctionText(herb) || "").trim();
  return raw
    .split(/[；;，,、]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !/药$/.test(item)).length === 0;
}

function entryIdFromHerb(herb) {
  const urls = (herb.entries || [])
    .map((entry) => String(entry.sourceUrl || ""))
    .filter((url) => url.includes("ydz.chp.org.cn"));
  for (const url of urls) {
    const match = url.match(/[?&]entryId=(\d+)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function plainText(html) {
  return String(html || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function functionParagraph(html) {
  const match = String(html || "").match(
    /<b>【功能与主治】<\/b>\s*<\/p>\s*<p>([\s\S]*?)<\/p>/i,
  );
  return match ? plainText(match[1]) : "";
}

function functionOnly(paragraph) {
  return String(paragraph || "")
    .split(/。\s*用于/)[0]
    .replace(/[。；;，,、\s]+$/g, "")
    .trim();
}

const useCount = new Map();
for (const clinicalCase of corpus.cases || []) {
  for (const item of clinicalCase.herbs || []) {
    const herb = String(item.herb || "").trim();
    if (herb) useCount.set(herb, (useCount.get(herb) || 0) + 1);
  }
}

// 已落库后默认进入“逐条在线复核”模式，严格复查同一批 84 味；不能因为它们已不再是数据缺口，
// 就悄悄继续选下一批 84 味。--apply 因此也是幂等的，重复执行不会追加第二批。
const candidates = existingBatch.length > 0
  ? existingBatch.map((entry) => ({
    herb: { name: entry.herb },
    entryId: entry.chpEntryId,
    useCount: entry.corpusUseCount,
  }))
  : (knowledge.herbs || [])
    .filter((herb) => !existing.has(herb.name))
    .filter((herb) => !IDENTITY_FORKS.has(herb.name))
    .filter((herb) => hasOnlyCategoryLabels(herb.name))
    .map((herb) => ({ herb, entryId: entryIdFromHerb(herb), useCount: useCount.get(herb.name) || 0 }))
    .filter((item) => item.entryId)
    .sort((left, right) => right.useCount - left.useCount || left.herb.name.localeCompare(right.herb.name, "zh-CN"));

async function fetchOfficial(item) {
  const apiUrl = `https://ydz.chp.org.cn/front-api/entry/${item.entryId}`;
  try {
    const response = await fetch(apiUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) return { rejected: { herb: item.herb.name, why: `HTTP ${response.status}`, apiUrl } };
    const payload = await response.json();
    const detail = payload?.data;
    if (!detail || payload?.code !== 200) {
      return { rejected: { herb: item.herb.name, why: `接口 code=${payload?.code ?? "unknown"}`, apiUrl } };
    }
    if (String(detail.title || "").trim() !== item.herb.name) {
      return {
        rejected: {
          herb: item.herb.name,
          why: `药典词条标题不一致：${String(detail.title || "")}`,
          apiUrl,
        },
      };
    }
    const chpQuote = functionParagraph(detail.htmlContent);
    const supplement = functionOnly(chpQuote);
    if (!chpQuote || !supplement || chpQuote === supplement) {
      return { rejected: { herb: item.herb.name, why: "无法可靠分离功能段与主治段", apiUrl } };
    }
    if (/用于|主治|治疗|适用于/.test(supplement)) {
      return { rejected: { herb: item.herb.name, why: "功能文本混入主治语义", apiUrl } };
    }
    const concepts = [...affirmedTcmTherapyConcepts(supplement)];
    if (!concepts.length) {
      return { rejected: { herb: item.herb.name, why: `受控治法解析为空：${supplement}`, apiUrl } };
    }
    const sourceUrl = `https://ydz.chp.org.cn/#/item?bookId=1&entryId=${item.entryId}`;
    return {
      accepted: {
        herb: item.herb.name,
        supplement,
        missingConcept: concepts[0],
        basis: `《中华人民共和国药典》2020年版一部「${item.herb.name}」【功能与主治】：${chpQuote}`,
        sourceUrl,
        sourceName: "国家药典委员会药典在线",
        chpEntryId: item.entryId,
        chpQuote,
        reviewBatch: BATCH_ID,
        corpusUseCount: item.useCount,
      },
    };
  } catch (error) {
    return { rejected: { herb: item.herb.name, why: String(error?.message || error), apiUrl } };
  }
}

const results = [];
const concurrency = 8;
let cursor = 0;
async function worker() {
  for (;;) {
    const index = cursor++;
    if (index >= candidates.length) return;
    results[index] = await fetchOfficial(candidates[index]);
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));

const allAccepted = results.flatMap((result) => result?.accepted ? [result.accepted] : []);
const accepted = BATCH_SIZE > 0 ? allAccepted.slice(0, BATCH_SIZE) : allAccepted;
const rejected = results.flatMap((result) => result?.rejected ? [result.rejected] : []);
// 首批沿用"必须凑满 84 味"的硬约束（它锁的是那批已落库数据的完整性）。
// 新批次不设下限：逐味 fail-closed 校验本来就会刷掉一部分，凑不满不是错误，
// 硬要凑满反而会诱使放宽校验——那才是真问题。被刷掉的一律打印原因。
if (BATCH_SIZE > 0 && accepted.length !== BATCH_SIZE) {
  throw new Error(`药典功效批次不足 ${BATCH_SIZE} 味：仅 ${accepted.length} 味通过 fail-closed 校验`);
}
if (BATCH_SIZE === 0 && accepted.length === 0) {
  throw new Error(`新批次一味都没通过 fail-closed 校验（候选 ${candidates.length} 味）——先看拒绝原因，不要放宽校验`);
}

if (existingBatch.length > 0) {
  const liveByHerb = new Map(accepted.map((entry) => [entry.herb, entry]));
  for (const stored of existingBatch) {
    const live = liveByHerb.get(stored.herb);
    if (!live) throw new Error(`${stored.herb} 在线复核缺失`);
    for (const field of ["supplement", "chpQuote", "sourceUrl", "chpEntryId", "missingConcept"]) {
      if (stored[field] !== live[field]) {
        throw new Error(`${stored.herb} 在线药典与落库字段 ${field} 不一致`);
      }
    }
  }
}

// 77 条临床回归过程中发现的新增数据缺口单列批次，不能挤占或改写已核验的 84 味。
// 同样逐条回查官方接口，任何标题、引文或功效变化都 fail-closed。
const regressionResults = await Promise.all(regressionBatch.map((entry) => fetchOfficial({
  herb: { name: entry.herb },
  entryId: entry.chpEntryId,
  useCount: entry.corpusUseCount,
})));
for (const [index, stored] of regressionBatch.entries()) {
  const live = regressionResults[index]?.accepted;
  if (!live) {
    const why = regressionResults[index]?.rejected?.why || "unknown";
    throw new Error(`${stored.herb} 回归补录在线复核失败：${why}`);
  }
  for (const field of ["supplement", "chpQuote", "sourceUrl", "chpEntryId", "missingConcept"]) {
    if (stored[field] !== live[field]) {
      throw new Error(`${stored.herb} 在线药典与回归补录字段 ${field} 不一致`);
    }
  }
}

if (APPLY && existingBatch.length === 0) {
  target.entries = [...(target.entries || []), ...accepted];
  target.generatedAt = "2026-08-14";
  target.note = `${target.note}\n\n【${BATCH_ID}】追加 ${BATCH_SIZE} 味药典功效正文：候选来自当前运行时“仅有分类标签”的真实缺口，按受治理现代医案用药频次排序；逐味回指国家药典委员会药典在线词条，要求标题精确一致，只截取【功能与主治】中的功能段，并能解析到受控治法概念。身份分叉名与任何解析不确定项均不入库。`;
  writeFileSync(targetPath, `${JSON.stringify(target, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify({
  batchId: BATCH_ID,
  requested: BATCH_SIZE,
  accepted: accepted.length,
  mode: existingBatch.length > 0 ? "verify-existing-batch" : "collect-new-batch",
  applied: APPLY && existingBatch.length === 0,
  targetEntriesAfter: (target.entries || []).length,
  regressionEntriesVerified: regressionBatch.map((entry) => entry.herb),
  herbs: accepted.map(({ herb, supplement, chpEntryId, corpusUseCount }) => ({
    herb, supplement, chpEntryId, corpusUseCount,
  })),
  rejected: rejected.slice(0, 80),
}, null, 2));
