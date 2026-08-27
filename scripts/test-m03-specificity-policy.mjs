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
// ─── 辨证轴/剂量轴拆分（2026-08-26，TCM-SD 12/12 全拒答的判层归因）────────────────
// 证据：TCM-SD 真实住院病历（现病史+查体+舌脉俱全）门禁只缺「性别/生理状态、过敏史、
// 用药明细」三项——全是剂量安全轴缺口（candidateMode 已独立管辖剂量），完整度被压到 B，
// 特异性投影把辨证连坐清空成「症状级工作判断」。与 2026-08-15 拆开红旗/剂量授权两轴同形：
// 剂量安全缺口不得摁死证候命名轴。判据：missingItemCodes 全部落在剂量安全闭集（舌/脉/主诉
// 缺失会生成各自的码，所以子集判断自带四诊在场保证），且门禁为 needs_information、无红旗。
const { syndromeAxisInformationSufficient } = await jiti.import("../src/lib/diagnosis-safety.ts");
const wrap = (value) => `报告正文\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(value)}\n<!-- DIAGNOSIS_JSON_END -->`;
const doseSafetyOnlyGate = {
  status: "needs_information",
  allowDiagnosis: true,
  allowDosePrescription: false,
  missingItems: ["性别/生理状态（剂量建议前需明确生理风险分层）", "过敏史（明确有/无及过敏原/反应）", "当前用药（明确有/无及药物清单）"],
  missingItemCodes: ["sex_unknown", "allergy_unknown", "medication_unknown"],
  redFlags: [],
  advisories: [],
  reasons: [],
};
assert.equal(syndromeAxisInformationSufficient(doseSafetyOnlyGate), true,
  "dose-safety-only gaps leave the syndrome axis sufficient");
// 反证 1：混入辨证证据类缺口（舌象）→ 不足。
assert.equal(syndromeAxisInformationSufficient({
  ...doseSafetyOnlyGate,
  missingItems: [...doseSafetyOnlyGate.missingItems, "舌象"],
  missingItemCodes: [...doseSafetyOnlyGate.missingItemCodes, "tongue_unknown"],
}), false, "a four-exam gap keeps the syndrome axis insufficient");
// 反证 2：红旗门禁 → 不足；ready（无缺项）→ 不适用此判据。
assert.equal(syndromeAxisInformationSufficient({ ...doseSafetyOnlyGate, status: "red_flag" }), false);
assert.equal(syndromeAxisInformationSufficient({ ...doseSafetyOnlyGate, status: "ready", missingItems: [], missingItemCodes: [] }), false);
// 闭集补齐（2026-08-26 第二轮，TCM-BEST4SDT 实测）：妊娠/哺乳/备孕状态与儿科体重、
// 儿童剂量规则同属「决定能不能给药」，不决定「证候叫什么」——与性别/过敏史/用药同轴。
assert.equal(syndromeAxisInformationSufficient({
  ...doseSafetyOnlyGate,
  missingItems: ["妊娠/哺乳/备孕状态（妊娠）", "妊娠/哺乳/备孕状态（哺乳）", "妊娠/哺乳/备孕状态（备孕）"],
  missingItemCodes: ["pregnancy_unknown", "lactation_unknown", "conception_unknown"],
}), true, "reproductive-status gaps are dose-axis only");
assert.equal(syndromeAxisInformationSufficient({
  ...doseSafetyOnlyGate,
  missingItems: ["儿童体重数值", "未配置儿童剂量级处方规则（需儿科中医师/药师个体化复核）"],
  missingItemCodes: ["pediatric_weight_unknown", "pediatric_dose_rules_unavailable"],
}), true, "pediatric dosing gaps do not block syndrome naming");
// 安全评估/处置轴（2026-08-26 第三轮，owner 裁定）：这些码回答的是「要不要先做别的评估」，
// 不是「证候叫什么」，不再清空辨证。依据与 2026-08-01「检测永不阻断」同一条：红旗本身都
// 允许 M03 继续生成风险分析与鉴别，专项筛查建议反而清空辨证是自相矛盾。
// 注意这条**推翻了本文件上一轮（同日）写的相反断言**——上一轮把它们一并归入压制侧是
// 过度保守：semantic_screen_unavailable 是我们自己的**附加**语义层没跑成（确定性红旗层
// 仍在，且该层按设计只增不减），因我方降级而清空医生的辨证，代价与收益不成比例。
// 剂量侧一步没放：这些码仍进 missingItems → status=needs_information → 剂量不放行。
for (const code of ["semantic_screen_unavailable", "high_risk_missing_vitals", "priority_evaluation_required", "behavioral_crisis_screening", "osa_screening", "thyroid_screening"]) {
  assert.equal(syndromeAxisInformationSufficient({
    ...doseSafetyOnlyGate,
    missingItems: [...doseSafetyOnlyGate.missingItems, `占位：${code}`],
    missingItemCodes: [...doseSafetyOnlyGate.missingItemCodes, code],
  }), true, `${code} is a disposition-axis gap and must not erase the syndrome`);
}
// 反证：辨证证据轴与病历质量轴的缺口仍然压制——四诊合参是证候命名的证据基础，
// 主诉缺失无从辨证，年龄冲突/体征数值错误意味着病历本身不可信。
for (const code of ["tongue_unknown", "pulse_unknown", "chief_complaint", "age_conflict", "age_invalid", "blood_pressure_invalid", "vitals_invalid", "vitals_source_conflict"]) {
  assert.equal(syndromeAxisInformationSufficient({
    ...doseSafetyOnlyGate,
    missingItems: [...doseSafetyOnlyGate.missingItems, `占位：${code}`],
    missingItemCodes: [...doseSafetyOnlyGate.missingItemCodes, code],
  }), false, `${code} is a syndrome-evidence / record-quality gap and must keep the cap`);
}
// 反证：未登记的新码一律 default-deny（将来加码时不会静默放行）。
assert.equal(syndromeAxisInformationSufficient({
  ...doseSafetyOnlyGate,
  missingItems: [...doseSafetyOnlyGate.missingItems, "占位：未来新增码"],
  missingItemCodes: [...doseSafetyOnlyGate.missingItemCodes, "some_future_code"],
}), false, "an unclassified code defaults to capping");
// 反证 3：码与条目数不对应（如妊娠特殊人群条目无码追加）→ 保守判不足。
assert.equal(syndromeAxisInformationSufficient({
  ...doseSafetyOnlyGate,
  missingItems: [...doseSafetyOnlyGate.missingItems, "特殊人群用药复核（妊娠/哺乳/备孕阳性）"],
}), false, "an uncoded extra item fails closed");
// 投影行为：B 级 + 剂量安全轴缺口 → 辨证保留；其余照旧清空。
const doseSafetyState = {
  completeness: { level: "B", redFlag: 0.4, infoGain: 0.5, managementImpact: 0.75, answerability: 0.5 },
  safetyGate: doseSafetyOnlyGate,
};
const keptContent = applyM03DecisionSpecificityPolicy(wrap(reasoning), doseSafetyState);
const keptReasoning = JSON.parse(keptContent.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/)[1]);
assert.equal(keptReasoning.overview.primarySyndrome, "外感风邪证",
  "a B-level case whose only gaps are dose-safety keeps its syndrome");
assert.deepEqual(keptReasoning.overview.recommendedFormulaNames, ["三拗汤"], "the formula direction survives too");
// 反证 4：同为 B 级但缺口含舌象 → 仍清空成症状级。
const mixedGapState = {
  completeness: { level: "B", redFlag: 0.4, infoGain: 0.5, managementImpact: 0.75, answerability: 0.5 },
  safetyGate: {
    ...doseSafetyOnlyGate,
    missingItems: [...doseSafetyOnlyGate.missingItems, "舌象"],
    missingItemCodes: [...doseSafetyOnlyGate.missingItemCodes, "tongue_unknown"],
  },
};
const cappedContent = applyM03DecisionSpecificityPolicy(wrap(reasoning), mixedGapState);
const cappedReasoning = JSON.parse(cappedContent.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/)[1]);
assert.equal(cappedReasoning.overview.primarySyndrome, "症状级工作判断");
// 反证 5：红旗态永远清空，无论缺项形态。
const redFlagState = { completeness: { level: "B" }, safetyGate: { ...doseSafetyOnlyGate, status: "red_flag" } };
const redFlagReasoning = JSON.parse(applyM03DecisionSpecificityPolicy(wrap(reasoning), redFlagState)
  .match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/)[1]);
assert.equal(redFlagReasoning.overview.primarySyndrome, "症状级工作判断");
