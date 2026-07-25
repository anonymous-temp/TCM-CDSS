// 医方集解 338 条 import_candidate → tcm-verified-formula-supplements.json（verified 通道）
// 规则：同名异方 5 例与 41 条复核队列不入库，转治理复核文件；目录已有名仅合并 indications（build 的 setdefault 语义）。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = resolve(ROOT, "artifacts/tcmoc-formula-extract-yifangjijie/yifangjijie-final-governed.jsonl");
const SUPP = resolve(ROOT, "src/data/tcm-verified-formula-supplements.json");
const REVIEW = resolve(ROOT, "artifacts/tcmoc-formula-extract-yifangjijie/governance-review-queue.json");

// 与目录组成显著不同的同名方（同名异方，进裁定而非合并）
const ADJUDICATE = new Set(["柴葛解肌汤", "蠲痹汤", "清暑益气汤", "地黄饮子", "白术散"]);
// 纯辅料，不作为 requiredIngredients 核心
const ADJUVANT = new Set(["甘草", "炙甘草", "生姜", "大枣", "姜", "枣"]);

const rows = readFileSync(SRC, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
const supp = JSON.parse(readFileSync(SUPP, "utf-8"));
const reviewQueue = { adjudicationCandidates: [], reviewQueue: [] };

let imported = 0, skippedReview = 0, skippedAdjudicate = 0;
for (const row of rows) {
  if (row.governanceStatus !== "import_candidate") {
    reviewQueue.reviewQueue.push({ chapter: row.chapter, residualIssues: row.residualIssues, note: "自纠后仍有未命中药味，需人工核对原文（可能为 LLM 污染或疑难异文）" });
    skippedReview++;
    continue;
  }
  const j = row.extracted;
  const name = String(j.name || row.chapter).trim();
  if (ADJUDICATE.has(name)) {
    reviewQueue.adjudicationCandidates.push({
      name,
      note: "《医方集解》版组成与目录现版显著不同（同名异方），需 evidenceAdjudications 裁定身份与取舍",
      extractedComposition: (j.composition || []).map((c) => c.herb),
      extractedSource: j.source || "《医方集解》",
    });
    skippedAdjudicate++;
    continue;
  }
  const herbs = [...new Set((j.composition || []).map((c) => String(c.herb || "").trim()).filter(Boolean))];
  if (herbs.length < 2) { skippedReview++; reviewQueue.reviewQueue.push({ chapter: row.chapter, residualIssues: ["composition<2"], note: "组成不足两味" }); continue; }
  const required = herbs.filter((h) => !ADJUVANT.has(h)).slice(0, 3);
  const indications = [j.indications, j.analysis].filter((s) => typeof s === "string" && s.trim()).slice(0, 3);
  if (supp.entries[name]) {
    // 已有治理条目：不覆盖其 source/tags/requiredIngredients/verification，仅补充缺失的 indications
    const cur = supp.entries[name];
    const merged = [...(cur.indications || []), ...indications.filter((i) => !(cur.indications || []).includes(i))];
    supp.entries[name] = { ...cur, indications: merged };
    imported++;
    continue;
  }
  supp.entries[name] = {
    source: j.source ? String(j.source) : "《医方集解》",
    indications,
    ingredients: herbs,
    requiredIngredients: required.length >= 2 ? required : herbs.slice(0, 3),
    verification: [
      { title: `《医方集解》·${row.chapter}（tcmoc 原文 + v4flash 抽取 + 全文对拍核验）`, url: `urn:tcm-cdss:tcmoc-books:087-医方集解.txt:${row.chapter}` },
    ],
  };
  imported++;
}
writeFileSync(SUPP, JSON.stringify(supp, null, 2) + "\n");
writeFileSync(REVIEW, JSON.stringify(reviewQueue, null, 2) + "\n");
console.log(JSON.stringify({ imported, skippedAdjudicate, skippedReview, supplementEntries: Object.keys(supp.entries).length, reviewFile: REVIEW }));
