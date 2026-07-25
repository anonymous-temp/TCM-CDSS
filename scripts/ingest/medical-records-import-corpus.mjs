// Medical Records 抽取结果 → T16 现代医案评测语料（与 nihaixia T16 语料同封套、分文件）。
// 为什么分文件:tcm-classic-case-eval-corpus.json 的 364 案是人工审过的黄金基线,
// 回放测试钉着 30 案回放池;18k LLM 抽取案混进去会稀释基线信任度,且任何一条污染
// 都会连带黄金池。分文件 = 同一 T16 层、同一评测口径、互不影响。
// 纪律:只有 verified=true(药味+诊断名全文对拍通过)的案才进语料;其余进复核队列。
// replayEligible 一律 false——现代案带剂量与自拟方,不经治理不得进回放池(安全默认)。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = resolve(ROOT, "artifacts/medical-records-extract/cases-extracted.jsonl");
const OUT = resolve(ROOT, "src/data/tcm-modern-case-eval-corpus.json");
const REVIEW = resolve(ROOT, "artifacts/medical-records-extract/review-queue.json");

const catalog = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-formula-governed-catalog.json"), "utf-8"));
const catalogNames = new Set((catalog.entries || []).map((e) => e.name));
for (const e of catalog.entries || []) for (const a of e.aliases || []) catalogNames.add(a);

// 出生日期脱敏(确定性,不靠模型自觉):patientAge 里的「(推算:YYYY年M月D日出生…)」括注与
// 任何字段里的「出生于…/于…出生」整段一律剥除。实测 4/17270 案模型把推算过程写进了字段,
// 提示词约束是软性的,边界清洗才是硬性的。
const DOB_PATTERNS = [
  /（推算：[^）]*）/g,
  /[(（]?出生于\s*\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日[)）]?/g,
  /于\s*\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日出生/g,
];
function scrubDob(value) {
  if (typeof value === "string") {
    let out = value;
    for (const re of DOB_PATTERNS) out = out.replace(re, "");
    return out.replace(/\s{2,}/g, " ").trim();
  }
  if (Array.isArray(value)) return value.map(scrubDob);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDob(v)]));
  return value;
}

const rows = readFileSync(SRC, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
const cases = [];
const review = [];
for (const r of rows) {
  if (!r.ok || !r.verified) {
    review.push({ line: r.line, reason: !r.ok ? r.error : `对拍未过:${(r.unmatchedHerbs || []).join("、")}${r.diagOk === false ? ";诊断名非原文" : ""}`, sourceText: r.sourceText });
    continue;
  }
  const j = scrubDob(r.extracted);
  const formulaName = j.formulaName && catalogNames.has(String(j.formulaName).trim()) ? String(j.formulaName).trim() : undefined;
  const complaints = [j.chiefComplaint, j.fourExams].filter((s) => typeof s === "string" && s.trim()).join("；");
  cases.push({
    caseId: `T16-MR-${String(r.line).padStart(5, "0")}`,
    title: `${j.diagnosisTcm || "医案"}案${j.physician ? `(${j.physician})` : ""}`,
    date: j.visitDate || null,
    diseases: [j.diagnosisTcm, j.diagnosisWestern].filter((s) => typeof s === "string" && s.trim()),
    sixChannels: [],
    expectedFormulaNames: formulaName ? [formulaName] : [],
    physician: j.physician || null,
    patientSex: j.patientSex || null,
    patientAge: j.patientAge || null,
    chiefComplaint: j.chiefComplaint || null,
    fourExams: j.fourExams || null,
    patternAnalysis: j.patternAnalysis || null,
    diagnosisTcm: j.diagnosisTcm || null,
    diagnosisWestern: j.diagnosisWestern || null,
    treatmentPrinciple: j.treatmentPrinciple || null,
    herbs: (j.herbs || []).map((h) => ({ herb: String(h.herb || ""), dose: h.dose || null })).filter((h) => h.herb),
    course: j.course || null,
    outcome: j.outcome || null,
    containsQuarantinedContent: false,
    replaySanitizedFromQuarantinedSource: false,
    replayInput: complaints ? `已记录患者事实:${complaints}` : "",
    replayEligible: false,
    sourceRef: `中医补充数据/灵丹GitHub/Medical Records.txt#L${r.line}`,
    sourceType: "llm_extracted_modern_case",
    tier: "experience",
  });
}

const out = {
  schemaVersion: "tcm-modern-case-eval-corpus-v1",
  evaluationOnly: true,
  runtimeRetrievalAllowed: false,
  source: "灵丹GitHub/Medical Records.txt(现代名医案 18,114 条,出版社版权)",
  extractedBy: "scripts/ingest/medical-records-extract.mjs(deepseek v4-flash 九字段抽取 + 药味/诊断名全文对拍)",
  safetyBoundary: "现代医案含自拟方与原始剂量,一律 replayEligible=false,不进运行时检索,不作处方依据;仅用于评测回放与治理审阅。",
  cases,
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
writeFileSync(REVIEW, JSON.stringify({ count: review.length, items: review }, null, 2) + "\n");
console.log(JSON.stringify({ written: OUT, cases: cases.length, reviewQueue: review.length, withFormulaInCatalog: cases.filter((c) => c.expectedFormulaNames.length).length }));
