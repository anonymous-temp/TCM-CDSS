// 把原先落在 gitignore 的 artifacts/robustness-cases.json 重建为可版本控制、可复现的 77 案夹具。
//
// 组成：
//   - 20 条已逐案保留公开网页出处的病案（web-cases-batch3）；
//   - 57 条通过现代医案 replayEligible 治理闸门、且舌脉均可提取的病例。
//
// 夹具只带患者事实，不带原方、金标准证候或治疗原则，防止把答案泄漏给被测流水线。
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const publicCasesPath = path.join(repoRoot, "artifacts/web-cases-batch3.json");
const modernCorpusPath = path.join(repoRoot, "src/data/tcm-modern-case-eval-corpus.json");
const targetPath = path.join(repoRoot, "src/data/tcm-robustness-cases.source.json");
const APPLY = process.argv.includes("--apply");
const CHECK = process.argv.includes("--check");
const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { hardDoseSafetyBoundaryReasons, withSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");

const publicCases = JSON.parse(readFileSync(publicCasesPath, "utf8")).cases || [];
const modernCorpus = JSON.parse(readFileSync(modernCorpusPath, "utf8"));

function extractObservation(text, marker) {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const pattern = marker === "舌"
    ? /(舌(?:质|体|尖|边|下|象)?[^，。；\n]{1,28}(?:苔[^，。；\n]{1,20})?)/
    : /(脉(?:象)?[^，。；\n]{1,24})/;
  return normalized.match(pattern)?.[1]?.trim() || "";
}

function expectationForFixture(item) {
  const ageMatch = String(item.age || "").match(/\d+(?:\.\d+)?/);
  const age = ageMatch ? Number(ageMatch[0]) : undefined;
  const text = `${item.chiefComplaint || ""}。${item.presentIllness || ""}`;
  const gated = withSafetyGate({
    id: `fixture-${item.id}`,
    phase: "diagnose",
    patient: { sex: item.sex, ...(Number.isFinite(age) ? { age } : {}) },
    chiefComplaint: item.chiefComplaint,
    symptoms: { general: item.presentIllness, tcmFourExams: item.fourExamDetail },
    tongue: item.tongue,
    pulse: item.pulse,
    vitals: "",
    labs: item.labs,
    pastHistory: item.pastHistory,
    medicationHistory: item.medicationHistory,
    allergyHistory: item.allergyHistory,
    questionRounds: 1,
    maxQuestionRounds: 1,
    conversation: [],
    diagnosis: "",
    prescription: "",
    riskAssessment: "",
    hisRecord: {
      schemaVersion: "tcm-cdss-his-v1",
      source: "tcm-cdss-his",
      caseId: `fixture-${item.id}`,
      updatedAt: "2026-08-14T00:00:00.000Z",
      tongueImageUploaded: false,
      // HIS snapshot存在时人口学字段是权威源；若生成器漏写 sex/age，安全层会按设计拒绝
      // 回退到顶层兼容 DTO，并可能把“16岁月经初潮”误读成当前年龄。在线回归请求本来就
      // 包含这两个字段，离线期望生成必须与真实请求保持同构。
      fields: {
        zhushu: item.chiefComplaint,
        sex: item.sex,
        age: item.age,
        xianbingshi: text,
        tcmTongue: item.tongue,
        tcmPulse: item.pulse,
      },
      rawText: text,
    },
  });
  if (gated.safetyGate.redFlags.length > 0) return "should_not_prescribe_redflag";
  if (hardDoseSafetyBoundaryReasons(gated).length > 0) return "should_downgrade_incomplete";
  return "should_prescribe";
}

const publicFixture = publicCases.map((item) => {
  const fixture = {
    id: `public-${String(item.no).padStart(3, "0")}`,
    category: `public_${String(item.tcmDisease || "门诊病案").replace(/\s+/g, "_")}`,
    sourceUrl: item.source,
    sourceRef: `artifacts/web-cases-batch3.json#no=${item.no}`,
    sex: String(item.sex || ""),
    age: String(item.age || ""),
    chiefComplaint: String(item.chiefComplaint || ""),
    presentIllness: String(item.presentHistory || ""),
    tongue: String(item.tongue || ""),
    pulse: String(item.pulse || ""),
    fourExamDetail: [item.presentHistory, item.tongue, item.pulse].filter(Boolean).join("；"),
    pastHistory: "",
    allergyHistory: "",
    medicationHistory: "",
    labs: "",
  };
  const expectation = expectationForFixture(fixture);
  return {
    ...fixture,
    expectation,
    robustnessNote: expectation === "should_not_prescribe_redflag"
      ? "当前病案的活动性急危重线索必须由确定性安全层前置留痕"
      : expectation === "should_downgrade_incomplete"
        ? "儿童、妊娠、哺乳或备孕等特殊人群存在剂量硬边界，应稳定降级为非剂量分析"
        : "公开门诊病案；验证完整流程、结构化合同、药名/剂量/方义与审方出口",
  };
});

const eligibleModern = (modernCorpus.cases || [])
  .filter((item) => item.replayEligible === true)
  .filter((item) => String(item.chiefComplaint || "").trim().length >= 4)
  .filter((item) => String(item.fourExams || "").trim().length >= 4)
  .map((item) => ({
    item,
    tongue: extractObservation(item.fourExams, "舌"),
    pulse: extractObservation(item.fourExams, "脉"),
    group: String(item.diagnosisTcm || item.diseases?.[0] || "未分类").trim(),
  }))
  .filter(({ tongue, pulse }) => tongue && pulse)
  .sort((left, right) => left.item.caseId.localeCompare(right.item.caseId));

// 先每病种取一条，再按第二/第三条轮转，避免 57 条被单一高频病种占满。
const groups = new Map();
for (const candidate of eligibleModern) {
  const group = groups.get(candidate.group) || [];
  group.push(candidate);
  groups.set(candidate.group, group);
}
const selectedModern = [];
for (let round = 0; selectedModern.length < 57; round += 1) {
  let added = 0;
  for (const group of [...groups.keys()].sort((a, b) => a.localeCompare(b, "zh-CN"))) {
    const candidate = groups.get(group)?.[round];
    if (!candidate) continue;
    selectedModern.push(candidate);
    added += 1;
    if (selectedModern.length === 57) break;
  }
  assert.ok(added > 0, "舌脉齐全的受治理现代病案不足 57 条");
}

const modernFixture = selectedModern.map(({ item, tongue, pulse, group }) => {
  const fixture = {
    id: `modern-${item.caseId.replace(/^T16-MR-/, "")}`,
    category: `modern_${group.replace(/\s+/g, "_")}`,
    sourceUrl: "https://github.com/anonymous-temp/TCM-CDSS/blob/main/src/data/tcm-modern-case-eval-corpus.json",
    sourceRef: item.sourceRef,
    governanceRef: item.replayGovernance,
    sex: String(item.patientSex || ""),
    age: item.patientAge == null ? "" : String(item.patientAge),
    chiefComplaint: String(item.chiefComplaint || ""),
    presentIllness: String(item.fourExams || ""),
    tongue,
    pulse,
    fourExamDetail: String(item.fourExams || ""),
    pastHistory: "",
    allergyHistory: "",
    medicationHistory: "",
    labs: String(item.diagnosisWestern || ""),
  };
  const expectation = expectationForFixture(fixture);
  return {
    ...fixture,
    expectation,
    robustnessNote: expectation === "should_not_prescribe_redflag"
      ? "受治理现代医案回放；当前急危重线索必须前置留痕，输入不下发原方或金标准"
      : "受治理现代医案回放；输入仅含患者事实，不下发原方、证候金标准或治疗原则",
  };
});

const output = {
  schemaVersion: "tcm-cdss-robustness-cases-v1",
  generatedAt: "2026-08-14",
  evaluationOnly: true,
  runtimeRetrievalAllowed: false,
  derivation: {
    publicCases: "artifacts/web-cases-batch3.json: 全部 20 条，保留逐案公开来源 URL",
    modernCases: "src/data/tcm-modern-case-eval-corpus.json: replayEligible=true、舌脉均可提取，按病种轮转取 57 条",
    leakageBoundary: "只含患者事实；原方、金标准证候与治疗原则不进入回归请求",
  },
  cases: [...publicFixture, ...modernFixture],
};

assert.equal(output.cases.length, 77);
assert.equal(new Set(output.cases.map((item) => item.id)).size, 77);

const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (CHECK) {
  assert.equal(readFileSync(targetPath, "utf8"), serialized, "77 病例夹具不是当前受治理源数据的可复现产物");
}
if (APPLY) writeFileSync(targetPath, serialized, "utf8");

console.log(JSON.stringify({
  cases: output.cases.length,
  publicCases: publicFixture.length,
  governedModernCases: modernFixture.length,
  distinctModernCategories: new Set(modernFixture.map((item) => item.category)).size,
  expectations: Object.groupBy(output.cases, (item) => item.expectation),
  applied: APPLY,
  checked: CHECK,
}, (_key, value) => Array.isArray(value) ? value.length : value, 2));
