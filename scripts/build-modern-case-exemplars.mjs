// 由现代医案语料派生运行时「相似医案」索引（2026-09-27，甲方确认语料全部版权可运行时使用）。
// 输入：src/data/tcm-modern-case-eval-corpus.json（评测语料本身仍保持 evaluationOnly，不在运行时直接读）
//       src/data/tcm-modern-case-exemplar-exclusions.source.json（评测独立性排除名单）
// 输出：src/data/tcm-modern-case-exemplars.json —— 只含辨证与组方思路（病名、主诉四诊摘要、病机、治法、方名、药味名），
//       不含剂量、疗程与患者身份信息；运行时只作「参考医案」呈现给模型，不是处方依据。
// 用法：node scripts/build-modern-case-exemplars.mjs
import fs from "node:fs";
const ROOT = new URL("../", import.meta.url).pathname;
const corpus = JSON.parse(fs.readFileSync(`${ROOT}src/data/tcm-modern-case-eval-corpus.json`, "utf8"));
const exclusions = JSON.parse(fs.readFileSync(`${ROOT}src/data/tcm-modern-case-exemplar-exclusions.source.json`, "utf8")).excludedCaseIds || {};
// 禁用/野生动物保护来源药材：含这些药的医案整例不入索引（不能让模型模仿不可开具的处方）。
const BANNED_HERB = /穿山甲|山甲|甲珠|犀角|虎骨|豹骨|熊胆/;
const clip = (value, max) => {
  const text = String(value || "").replace(/\s+/g, "").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const herbName = (raw) => String(raw || "").replace(/[\d.]+\s*(?:g|克|钱|两|mg)?/g, "").replace(/[（(][^）)]*[）)]/g, "").trim();
const stats = { input: corpus.cases.length, excludedForEvaluation: 0, bannedHerb: 0, incomplete: 0, quarantined: 0, kept: 0 };
const exemplars = [];
for (const item of corpus.cases) {
  if (exclusions[item.caseId]) { stats.excludedForEvaluation += 1; continue; }
  if (item.containsQuarantinedContent) { stats.quarantined += 1; continue; }
  const herbs = [...new Set((item.herbs || []).map((herb) => herbName(herb.herb)).filter((name) => name.length >= 1 && name.length <= 8))];
  if (herbs.some((name) => BANNED_HERB.test(name))) { stats.bannedHerb += 1; continue; }
  const dxT = clip(item.diagnosisTcm, 20);
  const dxW = clip(item.diagnosisWestern, 30);
  const pattern = clip(item.patternAnalysis, 90);
  if (herbs.length < 3 || !pattern || !(dxT || dxW) || !item.chiefComplaint) { stats.incomplete += 1; continue; }
  exemplars.push({
    id: item.caseId,
    dxW: dxW || undefined,
    dxT: dxT || undefined,
    cc: clip(item.chiefComplaint, 60),
    ex: clip(item.fourExams, 110),
    pa: pattern,
    tp: clip(item.treatmentPrinciple, 40) || undefined,
    fm: (item.expectedFormulaNames || []).slice(0, 2).map((name) => clip(name, 16)),
    hb: herbs.slice(0, 16),
  });
}
stats.kept = exemplars.length;
const out = {
  schemaVersion: "tcm-modern-case-exemplars-v1",
  generatedBy: "scripts/build-modern-case-exemplars.mjs",
  derivedFrom: "src/data/tcm-modern-case-eval-corpus.json",
  license: "甲方 2026-09-27 确认该现代医案语料全部版权，可在运行时作为参考医案使用。",
  runtimeUse: "相似医案参考：只呈现辨证与组方思路供模型借鉴，不含剂量与疗程，不是处方依据；处方仍须通过全部确定性合同与剂量/配伍核验。",
  exclusions: "tcm-modern-case-exemplar-exclusions.source.json（评测独立性）；含禁用动物药的医案整例排除；隔离内容整例排除。",
  stats,
  exemplars,
};
fs.writeFileSync(`${ROOT}src/data/tcm-modern-case-exemplars.json`, `${JSON.stringify(out)}\n`);
console.log(JSON.stringify(stats));
