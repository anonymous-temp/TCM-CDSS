/**
 * 证型标签待裁定清单（决策支持，不是决策）。
 *
 * 给方剂打 syndromeTags 决定它能否被身份锁锁定、进而被开成处方——这是临床裁定，
 * 不能由脚本代劳。本脚本只做三件机械事：
 *   ① 找出「仅差证型标签」的方剂（已可检索、已可编译剂量，只缺标签）
 *   ② 附上它现有的主治原文，供人判断
 *   ③ 从主治原文里**字面命中**受控证候词表，给出候选证候 ID 供勾选
 * 候选一律是字面匹配结果，不做任何语义推断；命中为空是正常的，说明需要人从头判断。
 *
 * 输出 artifacts/syndrome-tag-adjudication.json，并按来源分组——
 * official_classic_catalog 应优先处理：临床价值最高，且量最小。
 *
 * 用法：npx jiti scripts/report-syndrome-tag-adjudication.mjs [--source=official_classic_catalog]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const catalog = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-governed-catalog.json", import.meta.url), "utf8"));
const lexicon = JSON.parse(readFileSync(new URL("../src/data/tcm-syndrome-lexicon.json", import.meta.url), "utf8"));

/** 受控证候：canonical + aliases 都作为字面匹配面。 */
const syndromeSurfaces = [];
for (const entry of lexicon.entries || []) {
  for (const surface of [entry.canonical, ...(entry.aliases || [])]) {
    if (typeof surface === "string" && surface.length >= 2) {
      syndromeSurfaces.push({ id: entry.id, canonical: entry.canonical, surface });
    }
  }
}

const sourceFilter = process.argv.find((arg) => arg.startsWith("--source="))?.split("=")[1];

const pending = catalog.entries
  .filter((entry) => entry.retrievalEligible)
  .filter((entry) => (entry.syndromeTags || []).length === 0)
  .filter((entry) => entry.doseCompilationEligible)
  .filter((entry) => !sourceFilter || entry.sourceClass === sourceFilter)
  .map((entry) => {
    const indicationText = (entry.indications || []).join("；");
    const seen = new Set();
    const candidates = [];
    for (const item of syndromeSurfaces) {
      if (!indicationText.includes(item.surface) || seen.has(item.id)) continue;
      seen.add(item.id);
      candidates.push({ syndromeId: item.id, canonical: item.canonical, matchedSurface: item.surface });
    }
    return {
      formulaName: entry.name,
      sourceClass: entry.sourceClass,
      source: entry.source,
      indications: entry.indications || [],
      // 字面命中的受控证候；空数组表示主治原文没有出现任何受控证候名，需人工从头判断。
      candidateSyndromes: candidates.slice(0, 6),
      ingredients: (entry.ingredients || []).slice(0, 12),
    };
  })
  .sort((left, right) =>
    right.candidateSyndromes.length - left.candidateSyndromes.length ||
    left.formulaName.localeCompare(right.formulaName, "zh-CN"));

const bySource = {};
for (const row of pending) {
  const bucket = bySource[row.sourceClass] || (bySource[row.sourceClass] = { total: 0, withCandidates: 0 });
  bucket.total += 1;
  if (row.candidateSyndromes.length > 0) bucket.withCandidates += 1;
}

if (!existsSync("artifacts")) mkdirSync("artifacts", { recursive: true });
const out = "artifacts/syndrome-tag-adjudication.json";
writeFileSync(out, `${JSON.stringify({
  schemaVersion: "syndrome-tag-adjudication-v1",
  note: "candidateSyndromes 为主治原文的字面命中结果，仅供勾选；不构成任何临床建议，空数组属正常情况。",
  summary: { pending: pending.length, withCandidates: pending.filter((r) => r.candidateSyndromes.length > 0).length, bySource },
  entries: pending,
}, null, 2)}\n`, "utf8");

console.log(`待裁定（仅差证型标签，已可检索且可编译剂量）：${pending.length}`);
console.log(`  其中主治原文字面命中受控证候的：${pending.filter((r) => r.candidateSyndromes.length > 0).length}`);
for (const [source, bucket] of Object.entries(bySource).sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${source.padEnd(34)} ${String(bucket.total).padStart(4)}  有候选 ${bucket.withCandidates}`);
}
console.log(`\n输出：${out}`);
console.log("优先处理 official_classic_catalog：临床价值最高、量最小。");
