import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { applyM03DecisionSpecificityPolicy, synchronizeVisibleClinicalSummary } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");

const reasoning = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "感冒",
    tcmDiseaseRationale: "外感风寒所致",
    tcmDiagnosticRationale: "风寒束表，宣降失司",
    tcmDifferentials: [{ syndrome: "风热犯表证", reason: "无汗不支持", distinguishingPoints: "口渴", nextCheck: "舌象" }],
    tcmDiseaseDifferentials: [{ disease: "咳嗽", reason: "肺失宣降", distinguishingPoints: "咳嗽为主", nextCheck: "肺部检查" }],
    secondarySyndromes: ["风寒束表"],
    primarySyndrome: "外感风邪证",
    primarySyndromeResolution: "bounded",
    primarySyndromeResolutionReason: "病程较短",
    primarySyndromeBasis: ["咳嗽1天"],
    overallPathogenesis: "风邪犯肺，肺失宣降",
    overallTherapy: "疏风宣肺",
    recommendedFormulaDirection: "三拗汤加减方向",
    recommendedFormulaNames: ["三拗汤"],
    formulaSelectionMode: "single",
    deferredFormulaSelection: { direction: "三拗汤", names: ["三拗汤"], mode: "single", reason: "system_retrieved_governed_lock" },
    evidence: { evidenceLevel: "model_inference", source: "麻黄汤证据来源", confidence: "中" },
  },
  westernDiagnosis: {
    primary: {
      name: "麻黄汤适应证",
      coding: { system: "ICD-10", code: "J06.900", display: "急性上呼吸道感染", source: "风寒束表证编码来源" },
      status: "考虑",
      confidence: "高",
      supportingFacts: ["咳嗽1天", "既往服用麻黄汤", "针刺肺俞后好转", "既往服用自拟疏风止咳汤", "曾用院内安神方后好转", "接受梅花针治疗后好转"],
      supportingFactKinds: [
        { fact: "咳嗽1天", kind: "exam" },
        { fact: "既往服用麻黄汤", kind: "exam" },
        { fact: "针刺肺俞后好转", kind: "sign" },
        { fact: "既往服用自拟疏风止咳汤", kind: "symptom" },
        { fact: "曾用院内安神方后好转", kind: "exam" },
        { fact: "接受梅花针治疗后好转", kind: "sign" },
      ],
      clinicalRationale: "风寒束表证倾向",
      limitations: ["麻黄汤方向待确认"],
      suggestedChecks: ["可考虑针刺肺俞"],
      guidelineReferences: [{ evidenceId: "EVID-GUIDE-001", citation: "三拗汤鉴别指南", sourceType: "guideline" }],
      evidence: { evidenceLevel: "model_inference", source: "针刺肺俞依据", confidence: "中" },
    },
    differentials: [{ name: "支气管炎", reason: "风寒束表证", distinguishingPoints: "麻黄汤反应", nextCheck: "针刺肺俞" }],
    candidates: [
      { name: "麻黄汤适应证", likelihood: "高", keyEvidence: ["风寒束表证"], againstEvidence: ["三拗汤未用"] },
      { name: "支气管炎", likelihood: "中", keyEvidence: ["麻黄汤反应"], againstEvidence: ["未针刺肺俞"] },
    ],
  },
  pathogenesis: {
    summary: "风邪犯肺，肺失宣降",
    locationDifferentiation: { items: ["肺", "卫表"], details: [{ location: "肺", basis: "咳嗽" }], resolution: "resolved", evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } },
    natureDifferentiation: { items: ["风寒"], rootDeficiency: [], branchExcess: ["风寒束表"], basis: "恶寒", resolution: "resolved", evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } },
    symptomClusters: [{ symptoms: ["咳嗽"], mechanism: "风邪犯肺" }],
    caseRelationship: { rootPattern: "风寒束表", mainManifestation: "咳嗽", relationship: "表邪束肺" },
    chain: [{ patientFact: "咳嗽1天", syndromeEvidence: "恶寒", pathogenesis: "风寒束表", therapyDirection: "辛温解表", evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } }],
    uncertainties: [{ item: "方药选择", reason: "可考虑麻黄汤并针刺肺俞", affects: "风寒束表证处理" }],
  },
  therapy: { overallPrinciple: "辛温解表，宣肺止咳", overallMethod: "疏风宣肺", subTherapies: [{ therapy: "辛温解表", targetPathogenesis: "风寒束表", priority: "主要", evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } }] },
  formula: { candidates: [{ name: "三拗汤", positioning: "首选", herbs: [], evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } }], patentAndWestern: null },
  nonPharma: { diet: "风寒宣肺食疗", lifestyle: "避风寒", emotion: "", acupointCare: "肺俞", tcmTreatments: [], precautions: [] },
  lineageAdaptation: { schemaVersion: "tcm-cdss-reasoning-v2", lineageCode: "cold_damage", label: "伤寒派", applicable: "applicable", applicabilityReason: "风寒束表", influencedDecisions: [], unaffectedBySafety: [], safetyDeference: "" },
  terminologyMappings: [{ raw: "风寒束表", canonical: "风寒束表证" }],
  management: {
    redFlagLoop: "风寒束表证时可考虑麻黄汤",
    mustCollect: ["核实发热", "辨证后针刺肺俞"],
    followupSafetyNet: "可先辛温解表，并观察三拗汤反应",
  },
};

const content = `报告正文\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
const state = (level, status) => ({
  chiefComplaint: "咳嗽1天",
  patient: {},
  symptoms: { presentHistory: "咳嗽1天。既往服用自拟疏风止咳汤，曾用院内安神方后好转，接受梅花针治疗后好转。" },
  completeness: { level, redFlag: 0.8, infoGain: 0.7, managementImpact: 0.7, answerability: 0.7 },
  safetyGate: { status, allowDiagnosis: true, allowDosePrescription: status === "ready", action: "continue", missingItems: [], redFlags: status === "red_flag" ? ["急性胸痛伴大汗"] : [], reasons: [] },
});
const parsed = (value) => JSON.parse(value.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
const forbiddenSpecificity = /外感风邪证|风热犯表证|风寒束表|风邪犯肺|辛温解表|疏风宣肺|麻黄汤|三拗汤|伤寒派|针刺肺俞|肺俞|自拟疏风止咳汤|院内安神方|梅花针/;

for (const level of ["A", "B"]) {
  const result = parsed(applyM03DecisionSpecificityPolicy(content, state(level, "ready")));
  assert.equal(result.overview.primarySyndrome, "症状级工作判断");
  assert.equal(result.overview.primarySyndromeResolution, "unresolved");
  assert.deepEqual(result.overview.recommendedFormulaNames, []);
  assert.equal(result.overview.recommendedFormulaDirection, "");
  assert.equal(result.overview.formulaSelectionMode, "none");
  assert.equal(result.overview.deferredFormulaSelection, undefined);
  assert.match(result.overview.primarySyndromeResolutionReason, /完整度未达C级/);
  assert.ok(result.management.mustCollect.some((item) => /必要四诊/.test(item)));
  assert.equal(result.management.mustCollect.length, 1, "model-authored management collection rows must not cross the specificity boundary");
  assert.equal(result.management.redFlagLoop, undefined, "non-red-flag sparse cases must not retain model-authored red-flag text");
  assert.match(result.management.followupSafetyNet, /补充.*关键信息.*复评/);
  assert.doesNotMatch(JSON.stringify(result), forbiddenSpecificity, `${level}-level output must remove all TCM syndrome/pathogenesis/therapy/formula specificity`);
  assert.equal(result.formula, null);
  assert.equal(result.nonPharma, null);
  assert.equal(result.lineageAdaptation, null);
  assert.deepEqual(result.pathogenesis.chain, []);
  assert.equal(result.pathogenesis.uncertainties.length, 1);
  assert.equal(result.pathogenesis.uncertainties[0].item, "辨证与方剂具体度边界");
  assert.deepEqual(result.therapy.subTherapies, []);
  assert.equal(result.westernDiagnosis.primary.name, "症状级西医工作判断");
  assert.deepEqual(result.westernDiagnosis.primary.supportingFacts, []);
  assert.deepEqual(result.westernDiagnosis.primary.supportingFactKinds, []);
  assert.equal(result.westernDiagnosis.primary.confidence, "低");
  assert.equal(result.westernDiagnosis.primary.coding, undefined);
  assert.deepEqual(result.westernDiagnosis.differentials, []);
  assert.deepEqual(result.westernDiagnosis.candidates, []);
  assert.deepEqual(result.overview.evidence, { evidenceLevel: "insufficient", source: "当前病例信息不足", confidence: "低" });
  const visible = synchronizeVisibleClinicalSummary(applyM03DecisionSpecificityPolicy(content, state(level, "ready")), "diagnose");
  assert.doesNotMatch(visible, forbiddenSpecificity, `${level}-level visible Markdown and sentinel must share the same declassified projection`);
}

const redFlag = parsed(applyM03DecisionSpecificityPolicy(content, state("C", "red_flag")));
assert.equal(redFlag.overview.primarySyndromeResolution, "unresolved");
assert.deepEqual(redFlag.overview.recommendedFormulaNames, []);
assert.equal(redFlag.overview.recommendedFormulaDirection, "");
assert.match(redFlag.overview.primarySyndromeResolutionReason, /急危重风险未排除/);
assert.ok(redFlag.management.mustCollect.some((item) => /急危重风险评估/.test(item)));
assert.match(redFlag.management.redFlagLoop, /急危重风险未排除/);
assert.match(redFlag.management.followupSafetyNet, /立即急诊或呼叫急救/);
assert.doesNotMatch(JSON.stringify(redFlag), forbiddenSpecificity, "red-flag output must remove all TCM syndrome/pathogenesis/therapy/formula specificity");

assert.equal(applyM03DecisionSpecificityPolicy(content, state("C", "ready")), content, "C-level ready cases retain full specificity");

for (let iteration = 0; iteration < 20; iteration += 1) {
  const sparse = parsed(applyM03DecisionSpecificityPolicy(content, state("B", "ready")));
  assert.equal(sparse.overview.recommendedFormulaNames.length, 0, `sparse iteration ${iteration + 1}`);
  assert.doesNotMatch(JSON.stringify(sparse), forbiddenSpecificity, `sparse iteration ${iteration + 1}`);
  const acute = parsed(applyM03DecisionSpecificityPolicy(content, state("C", "red_flag")));
  assert.equal(acute.overview.recommendedFormulaNames.length, 0, `red-flag iteration ${iteration + 1}`);
  assert.doesNotMatch(JSON.stringify(acute), forbiddenSpecificity, `red-flag iteration ${iteration + 1}`);
}

console.log(JSON.stringify({ suite: "m03-specificity-policy", checks: 73, failures: 0 }));
