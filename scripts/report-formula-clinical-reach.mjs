/**
 * 方剂临床可达性盘点：医生真正拿得到的方有多少。
 *
 * 为什么不用「入库条数」或「补了多少标签」做验收：一个方剂要真正到达医生，必须同时满足
 *   ① 能被检索到（pre-generation 短名单里出现过，模型才可能选它）
 *   ② 能被身份锁锁定（syndromeTags 非空，否则模型选中后会被
 *      enforceRetrievedM03FormulaSelection 剥离，结果降级为自拟方）
 *   ③ 能编译出剂量（doseCompilationEligible，否则只能给方名给不了处方）
 * 只满足①的方剂对医生是负价值——展示了、选了、然后被剥离。
 *
 * 本脚本输出的 fullChain 才是验收数，其余分项用于定位缺口在哪一环。
 * 用法：npx jiti scripts/report-formula-clinical-reach.mjs [--json]
 */
import { readFileSync } from "node:fs";

const catalog = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-governed-catalog.json", import.meta.url), "utf8"));
const retrievalIndex = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-retrieval-index.json", import.meta.url), "utf8")).indexes;

const entries = catalog.entries.filter((entry) => entry.retrievalEligible);
const conceptReachable = new Set(Object.values(retrievalIndex.conceptToFormulaIds || {}).flat());

/** 与 tcm-formula-indications.ts 的倒排索引同口径：主治原文里有可索引词才算能被文本召回。 */
const COMMON_TERM_DF_RATIO = 0.08;
const termDocCount = new Map();
const entryTerms = new Map();
for (const entry of entries) {
  const text = (entry.indications || []).join("；");
  const terms = new Set();
  for (const run of text.match(/[一-龥]{2,}/g) || []) {
    for (let size = 2; size <= 4; size += 1) {
      for (let start = 0; start + size <= run.length; start += 1) terms.add(run.slice(start, start + size));
    }
  }
  entryTerms.set(entry.id, terms);
  for (const term of terms) termDocCount.set(term, (termDocCount.get(term) || 0) + 1);
}
const indexableTerm = (term) => (termDocCount.get(term) || 0) / Math.max(1, entries.length) <= COMMON_TERM_DF_RATIO;

const rows = entries.map((entry) => {
  const terms = entryTerms.get(entry.id) || new Set();
  return {
    name: entry.name,
    sourceClass: entry.sourceClass,
    retrievable: conceptReachable.has(entry.id) || [...terms].some(indexableTerm),
    lockable: (entry.syndromeTags || []).length > 0,
    dosable: Boolean(entry.doseCompilationEligible),
  };
});

const count = (predicate) => rows.filter(predicate).length;
const fullChain = count((r) => r.retrievable && r.lockable && r.dosable);
const summary = {
  governedFormulas: rows.length,
  retrievable: count((r) => r.retrievable),
  lockable: count((r) => r.lockable),
  dosable: count((r) => r.dosable),
  retrievableAndLockable: count((r) => r.retrievable && r.lockable),
  /** ★ 验收数：既检索得到、又锁得住、又开得出剂量。 */
  fullChain,
  fullChainPct: Math.round((fullChain / Math.max(1, rows.length)) * 1000) / 10,
  // 缺口定位：只差一环的方剂最值得优先治理，投入产出比最高。
  blockedOnlyByTags: count((r) => r.retrievable && r.dosable && !r.lockable),
  blockedOnlyByDose: count((r) => r.retrievable && r.lockable && !r.dosable),
  blockedOnlyByRetrieval: count((r) => r.lockable && r.dosable && !r.retrievable),
  // 展示了却锁不住 = 对医生负价值：选中即被剥离，结果降级为自拟方。
  offeredButNeverLockable: count((r) => r.retrievable && !r.lockable),
  // 数据缺陷（非治理进度）：源书生僻字丢失后只剩单字药名，如黄芪→「黄」。
  // 单列出来，避免一个抽取 bug 长期伪装成剂量缺口。
  formulasWithCorruptIngredientNames: entries.filter((e) => (e.corruptIngredientNames || []).length > 0).length,
};

const bySource = {};
for (const row of rows) {
  const bucket = bySource[row.sourceClass] || (bySource[row.sourceClass] = { total: 0, fullChain: 0, blockedOnlyByTags: 0 });
  bucket.total += 1;
  if (row.retrievable && row.lockable && row.dosable) bucket.fullChain += 1;
  if (row.retrievable && row.dosable && !row.lockable) bucket.blockedOnlyByTags += 1;
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ summary, bySource }, null, 2));
} else {
  console.log("方剂临床可达性盘点");
  console.log("─".repeat(58));
  console.log(`受控方剂总数              ${summary.governedFormulas}`);
  console.log(`  可被检索到              ${summary.retrievable}`);
  console.log(`  可被身份锁锁定          ${summary.lockable}`);
  console.log(`  可编译剂量              ${summary.dosable}`);
  console.log("─".repeat(58));
  console.log(`★ 全链路可达（验收数）    ${summary.fullChain}  (${summary.fullChainPct}%)`);
  console.log("─".repeat(58));
  console.log(`仅差证型标签              ${summary.blockedOnlyByTags}   ← 投入产出比最高`);
  console.log(`仅差剂量可编译            ${summary.blockedOnlyByDose}`);
  console.log(`仅差检索命中              ${summary.blockedOnlyByRetrieval}`);
  console.log(`展示了却永远锁不住        ${summary.offeredButNeverLockable}   ← 对医生负价值`);
  console.log(`组成含缺字药名            ${summary.formulasWithCorruptIngredientNames}   ← 数据缺陷，需回源修抽取`);
  console.log("─".repeat(58));
  console.log("按来源：");
  for (const [source, bucket] of Object.entries(bySource).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${source.padEnd(34)} ${String(bucket.fullChain).padStart(4)}/${String(bucket.total).padEnd(5)} 仅差标签 ${bucket.blockedOnlyByTags}`);
  }
}
