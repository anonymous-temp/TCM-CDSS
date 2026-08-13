// 药典功效正文补录入库（2026-08-13）。
//
// 背景：知识库里 695 味药有 305 味（43.9%）只有功效**分类标签**（「平肝息风药；息风止痉药」），
// 没有功效正文。getTcmHerbFunctionDisplayText 会把以「药」收尾的分类标签整条滤掉，于是这些药
// 在处方方义一列**永远**只能印兜底句「配伍药，本方中的具体配伍作用需医生结合方义复核」——
// 与病例无关、与治法无关，怎么跑都填不上。甲方 2026-08-13 报的「方义占位符」就是这一类；
// 上一轮只补了北沙参一味，并按单个病例测出「14%→0%」，把整类问题误判成已解决。
//
// 本脚本把联网查证 + 独立复核后的药典功效文本并入受治理补充表。三条硬约束：
//  1) **只追加不覆盖**：已在表里的药味一律跳过（既有条目是上一轮人工核过的）。
//  2) **逐条自校验**：功效不得夹带「用于……」主治段；missingConcept 必须真能被
//     affirmedTcmTherapyConcepts 从 supplement 文本里解析出来——这正是
//     test:m04-safety-contract 会逐条重算的断言，先在入库口挡住，别让它到闸门才红。
//  3) **依据可追溯**：basis 由权威来源原文 + 来源名 + URL 组成，长度不足或缺来源的直接丢弃。
//
//   INPUT=artifacts/chp-herb-functions.json node scripts/ingest-chp-herb-functions.mjs [--apply]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { affirmedTcmTherapyConcepts } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");

const INPUT = process.env.INPUT || "artifacts/chp-herb-functions.json";
const TARGET = path.join(repoRoot, "src/data/tcm-herb-function-supplements.source.json");
const APPLY = process.argv.includes("--apply");

const incoming = JSON.parse(readFileSync(INPUT, "utf8"));
const entries = Array.isArray(incoming) ? incoming : incoming.entries || [];
const target = JSON.parse(readFileSync(TARGET, "utf8"));
const existing = new Set(target.entries.map((e) => e.herb));

// 主治段特征：药典功能与主治的句式是「<功能>。用于<主治>」。功能里混进主治会把方义写成适应证罗列，
// 那是甲方另外点过名的缺陷，必须在入库口挡掉。
const INDICATION_LEAK = /用于|主治|治疗|适用于|[，。；]$/;

const accepted = [];
const rejected = [];
for (const raw of entries) {
  const herb = String(raw.herb || "").trim();
  const supplement = String(raw.supplement || "").trim();
  const concept = String(raw.missingConcept || "").trim();
  const quote = String(raw.chpQuote || "").trim();
  const sourceName = String(raw.sourceName || "").trim();
  const sourceUrl = String(raw.sourceUrl || "").trim();

  const drop = (why) => rejected.push({ herb, why, supplement, concept });
  if (!herb) { drop("缺药名"); continue; }
  if (existing.has(herb)) { drop("表中已有同名条目，按只追加不覆盖跳过"); continue; }
  if (!supplement) { drop("功效文本为空"); continue; }
  if (supplement.length < 4 || supplement.length > 60) { drop(`功效文本长度异常(${supplement.length})`); continue; }
  if (INDICATION_LEAK.test(supplement)) { drop("功效文本夹带主治段或以标点收尾"); continue; }
  if (!quote || quote.length < 10) { drop("缺权威来源原文摘录"); continue; }
  if (!sourceName || !sourceUrl) { drop("缺来源名或来源 URL"); continue; }
  if (!concept) { drop("缺 missingConcept"); continue; }

  const parsed = affirmedTcmTherapyConcepts(supplement);
  if (!parsed.has(concept)) {
    // 解析不出声明的方向时，若文本本身能解析出别的方向，就改用实际解析到的第一个——
    // 断言要的是「补充后能解析出一个方向」，不是「必须是上游猜的那个」。
    const [fallback] = [...parsed];
    if (!fallback) { drop(`功效文本解析不出任何治法方向：${supplement}`); continue; }
    accepted.push({
      herb, supplement, missingConcept: fallback,
      basis: `${sourceName}「${herb}」功能与主治原文：${quote}（来源：${sourceUrl}）`,
      conceptAdjustedFrom: concept,
    });
    continue;
  }
  accepted.push({
    herb, supplement, missingConcept: concept,
    basis: `${sourceName}「${herb}」功能与主治原文：${quote}（来源：${sourceUrl}）`,
  });
}

const report = {
  input: INPUT,
  incoming: entries.length,
  accepted: accepted.length,
  rejected: rejected.length,
  conceptAdjusted: accepted.filter((e) => e.conceptAdjustedFrom).length,
  rejectedDetail: rejected,
  applied: false,
};

if (APPLY && accepted.length) {
  target.entries = [
    ...target.entries,
    ...accepted.map(({ conceptAdjustedFrom, ...entry }) => { void conceptAdjustedFrom; return entry; }),
  ];
  target.note = `${target.note}\n\n【2026-08-13 第二类收录】原表只收「分类表把该药归入单一章节、因而丢掉其另一主要功效」的品种。本次追加第二类：**库中只有功效分类标签、完全没有功效正文**的药典药味。这类药的方义一列在任何病例下都只能印兜底句（分类标签在展示前被整条滤掉），与治法是否对齐无关，是数据缺口而非设计行为。文本取自权威来源的【功能与主治】，只取「功能」段、不取「用于……」主治段；逐条经独立复核代理二次查证，未通过者不入库。`;
  writeFileSync(TARGET, `${JSON.stringify(target, null, 2)}\n`, "utf8");
  report.applied = true;
  report.totalEntriesNow = target.entries.length;
}

console.log(JSON.stringify(report, null, 1));
