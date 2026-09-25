import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
// ── 本套件钉的是 M03 终审出口的具体度投影 ─────────────────────────────────────────
// 触发条件（完整度未达 C、或红旗；B 级且辨证轴充分时豁免）决定「要不要标注边界」；
// 标注**一个字都不删**，只加边界（owner 决策 2026-09-13）。旧的去具体度清空投影只在
// CDSS_GATE_DISPOSITION=block 回退档生效，2026-09-25 随该档一并删除。
const { applyM03DecisionSpecificityPolicy, annotateM03DecisionSpecificityBoundary, synchronizeVisibleClinicalSummary } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");

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

// 投影是否触发：标注边界会写入这一条可见的不确定项；未触发时内容逐字节原样返回。
const BOUNDARY_ITEM = "辨证与方剂具体度边界";
const boundaryAnnotated = (result) => result.pathogenesis.uncertainties.some((row) => row.item === BOUNDARY_ITEM);

assert.equal(applyM03DecisionSpecificityPolicy(content, state("C", "ready")), content, "C-level ready cases retain full specificity");

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
// 投影行为：B 级 + 剂量安全轴缺口 → 不触发投影；其余触发边界标注（内容保留）。
const doseSafetyState = {
  completeness: { level: "B", redFlag: 0.4, infoGain: 0.5, managementImpact: 0.75, answerability: 0.5 },
  safetyGate: doseSafetyOnlyGate,
};
const keptContent = applyM03DecisionSpecificityPolicy(wrap(reasoning), doseSafetyState);
assert.equal(keptContent, wrap(reasoning), "dose-safety-only B-level gaps do not trigger the specificity boundary at all");
const keptReasoning = JSON.parse(keptContent.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/)[1]);
assert.equal(keptReasoning.overview.primarySyndrome, "外感风邪证",
  "a B-level case whose only gaps are dose-safety keeps its syndrome");
assert.deepEqual(keptReasoning.overview.recommendedFormulaNames, ["三拗汤"], "the formula direction survives too");
// 反证 4：同为 B 级但缺口含舌象 → 触发边界标注。
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
assert.ok(boundaryAnnotated(cappedReasoning), "a four-exam gap triggers the specificity boundary");
assert.match(cappedReasoning.overview.primarySyndromeResolutionReason, /完整度未达C级/);
assert.equal(cappedReasoning.overview.primarySyndrome, "外感风邪证", "the boundary annotates, it never rewrites the syndrome");
// 反证 5：红旗态永远触发，无论缺项形态。
const redFlagState = { completeness: { level: "B" }, safetyGate: { ...doseSafetyOnlyGate, status: "red_flag" } };
const redFlagReasoning = JSON.parse(applyM03DecisionSpecificityPolicy(wrap(reasoning), redFlagState)
  .match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/)[1]);
assert.ok(boundaryAnnotated(redFlagReasoning), "a red-flag gate always triggers the specificity boundary");
assert.match(redFlagReasoning.overview.primarySyndromeResolutionReason, /急危重风险未排除/);

// Completing a dose-background field must not erase an otherwise supported syndrome.
// Exercise the actual normalization/gate rather than trusting a caller-provided C score.
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const { withSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");
const completeInput = {
  id: "specificity-ready-parity", patient: { sex: "男", age: 45 },
  chiefComplaint: "胃脘胀满2月", conversation: [],
  hisRecord: { fields: {
    sex: "男", age: "45", zhushu: "胃脘胀满2月",
    xianbingshi: "近两月胃脘胀满，餐后明显，嗳气后缓解，二便正常。",
    tcmTongue: "舌淡，苔薄白", tcmPulse: "脉细缓",
    jiwangshi: "既往体健", guomin: "否认药物过敏", yongyaoshi: "否认当前用药",
  } },
};
const readyState = withSafetyGate(normalizeCaseStateInput(completeInput));
assert.equal(readyState.completeness.level, "B", "lack of vitals/screen keeps aggregate grade B");
assert.equal(readyState.safetyGate.status, "ready", "actual gate has no remaining information gaps");
const allergyUnknownInput = structuredClone(completeInput);
allergyUnknownInput.hisRecord.fields.guomin = "";
const allergyUnknownState = withSafetyGate(normalizeCaseStateInput(allergyUnknownInput));
assert.equal(allergyUnknownState.safetyGate.status, "needs_information");
const alreadyKept = parsed(applyM03DecisionSpecificityPolicy(content, allergyUnknownState));
assert.equal(alreadyKept.overview.primarySyndrome, reasoning.overview.primarySyndrome);
assert.deepEqual(
  parsed(applyM03DecisionSpecificityPolicy(content, readyState)),
  alreadyKept,
  "completing allergy history must not erase the same supported reasoning",
);
assert.equal(applyM03DecisionSpecificityPolicy(applyM03DecisionSpecificityPolicy(content, readyState), readyState), content,
  "repeated final projection preserves a supported ready+B result");
for (const key of ["tcmTongue", "tcmPulse", "xianbingshi"]) {
  const sparseInput = structuredClone(completeInput);
  sparseInput.hisRecord.fields[key] = "未记录";
  const sparse = withSafetyGate(normalizeCaseStateInput(sparseInput));
  assert.ok(boundaryAnnotated(parsed(applyM03DecisionSpecificityPolicy(content, sparse))),
    `a real ${key} evidence gap does not inherit the ready exception`);
}

// ═══ 标注边界，不撤回分析 ══════════════════════════════════════════════════════════
// owner 决策 2026-09-13：「推理出来的结果要都输出出来，有问题的带风险提示输出，
// 但不要拦截、作废和清空」。222 例实测里 28 例的证候、病位病性与病机链就是在这一步
// 被服务端撤回的（甲方风寒病例流中已出现「感冒／风寒束表证」，最终变成「症状级工作判断」）。
const adviseKeptFields = (state, label) => {
  const result = parsed(applyM03DecisionSpecificityPolicy(content, state));
  assert.equal(result.overview.primarySyndrome, "外感风邪证", `${label}: 主证不得被改写`);
  assert.equal(result.overview.tcmDiseaseName, "感冒", `${label}: 中医病名不得删除`);
  assert.deepEqual(result.overview.primarySyndromeBasis, ["咳嗽1天"], `${label}: 证候依据不得清空`);
  assert.deepEqual(result.overview.recommendedFormulaNames, ["三拗汤"], `${label}: 方剂方向不得清空`);
  assert.equal(result.overview.overallPathogenesis, "风邪犯肺，肺失宣降", `${label}: 总体病机不得改写`);
  assert.equal(result.pathogenesis.chain.length, 1, `${label}: 病机链不得清空`);
  assert.deepEqual(result.pathogenesis.locationDifferentiation.items, ["肺", "卫表"], `${label}: 病位不得清空`);
  assert.deepEqual(result.pathogenesis.natureDifferentiation.items, ["风寒"], `${label}: 病性不得清空`);
  assert.equal(result.therapy.subTherapies.length, 1, `${label}: 子治法不得清空`);
  assert.notEqual(result.formula, null, `${label}: 方药不得归零`);
  assert.notEqual(result.nonPharma, null, `${label}: 非药物建议不得归零`);
  assert.equal(result.westernDiagnosis.primary.name, "麻黄汤适应证", `${label}: 西医工作诊断不得改写`);
  assert.ok(result.westernDiagnosis.primary.supportingFacts.length > 0, `${label}: 西医支持依据不得清空`);
  assert.equal(result.westernDiagnosis.differentials.length, 1, `${label}: 西医鉴别不得清空`);
  // 边界必须显式存在，而且是「有界」而不是「未形成结论」。
  assert.equal(result.overview.primarySyndromeResolution, "bounded", `${label}: 肯定级结论降为 bounded`);
  assert.ok(result.pathogenesis.uncertainties.some((row) => row.item === "辨证与方剂具体度边界"),
    `${label}: 必须写入可见的不确定项`);
  assert.ok(result.westernDiagnosis.primary.limitations.length >= 2, `${label}: 边界必须进西医 limitations`);
  return result;
};
adviseKeptFields(state("A", "ready"), "A 级");
const adviseSparse = adviseKeptFields(state("B", "ready"), "B 级");
assert.match(adviseSparse.overview.primarySyndromeResolutionReason, /完整度未达C级/);
// 边界措辞不得写成清空文案：同一页里既写「仅保留症状级工作判断」又印着具体证候，
// 医生读到的是自相矛盾（2026-09-14 上线首次实测发现）。
assert.doesNotMatch(adviseSparse.overview.primarySyndromeResolutionReason, /仅保留症状级工作判断/,
  "保留了证候，边界文案不得说成只剩症状级判断");
assert.ok(adviseSparse.management.mustCollect.some((item) => /必要四诊/.test(item)));
// 模型自己写的补采项也必须保留（不是替换成一条服务端项）。
assert.ok(adviseSparse.management.mustCollect.includes("核实发热"), "既有补采项保留");
const adviseRedFlag = adviseKeptFields(state("C", "red_flag"), "红旗");
assert.match(adviseRedFlag.overview.primarySyndromeResolutionReason, /急危重风险未排除/);
assert.doesNotMatch(adviseRedFlag.overview.primarySyndromeResolutionReason, /仅保留症状级工作判断/,
  "红旗同样不得把保留说成清空");
assert.match(adviseRedFlag.management.redFlagLoop, /急危重风险未排除/);
assert.match(adviseRedFlag.management.followupSafetyNet, /立即急诊或呼叫急救/);
// 模型原有的 redFlagLoop 文本保留在后面，不被顶掉。
assert.ok(adviseRedFlag.management.redFlagLoop.includes("风寒束表证时可考虑麻黄汤"), "模型原文保留");
// 可见正文必须把边界印出来（`**辨证边界**` 对 bounded 也渲染）。
const adviseVisible = synchronizeVisibleClinicalSummary(
  applyM03DecisionSpecificityPolicy(content, state("B", "ready")), "diagnose");
assert.match(adviseVisible, /\*\*辨证边界\*\*/, "可见正文必须印出辨证边界");
assert.match(adviseVisible, /外感风邪证/, "可见正文保留具体证候");
// 幂等：重复施加不重复追加同一条边界。
const onceAnnotated = applyM03DecisionSpecificityPolicy(content, state("B", "ready"));
const twiceAnnotated = applyM03DecisionSpecificityPolicy(onceAnnotated, state("B", "ready"));
const twiceReasoning = parsed(twiceAnnotated);
assert.equal(twiceReasoning.pathogenesis.uncertainties.filter((row) => row.item === "辨证与方剂具体度边界").length, 1,
  "重复投影不得重复追加不确定项");
assert.equal(twiceReasoning.management.mustCollect.filter((item) => /必要四诊/.test(item)).length, 1,
  "重复投影不得重复追加补采项");
assert.equal(
  (twiceReasoning.overview.primarySyndromeResolutionReason.match(/完整度未达C级/g) || []).length, 1,
  "重复投影不得重复追加边界理由");
// 残留的旧环境变量不得复活清空投影（block 档已删除）。try/finally：jiti 断言失败后会重跑整个
// 文件，残留变量会把失败归因到别处。
{
  const previous = process.env.CDSS_GATE_DISPOSITION;
  process.env.CDSS_GATE_DISPOSITION = "block";
  try {
    for (const [level, status] of [["B", "ready"], ["C", "red_flag"]]) {
      assert.equal(parsed(applyM03DecisionSpecificityPolicy(content, state(level, status))).overview.primarySyndrome,
        "外感风邪证", `残留 CDSS_GATE_DISPOSITION=block 不得清空 ${level}/${status} 的证候`);
    }
  } finally {
    if (previous === undefined) delete process.env.CDSS_GATE_DISPOSITION;
    else process.env.CDSS_GATE_DISPOSITION = previous;
  }
}
// 标注函数本身也直接钉一次：不带 sentinel 的正文原样返回，非 diagnose 载荷不动。
assert.equal(annotateM03DecisionSpecificityBoundary("纯正文", { reason: "r", mustCollect: "m", activeRedFlag: false }), "纯正文");
const prescribePayload = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "prescribe" })}\n<!-- DIAGNOSIS_JSON_END -->`;
assert.equal(annotateM03DecisionSpecificityBoundary(prescribePayload, { reason: "r", mustCollect: "m", activeRedFlag: false }),
  prescribePayload, "非 diagnose 载荷不得被标注");

console.log(JSON.stringify({ suite: "m03-specificity-policy", failures: 0 }));
