import assert from "node:assert/strict";

const { enforceStructuredStageOwnership, isM03WesternSupportContractReason, repairCompletedStructuredSentinel, resolveCompletedStructuredResponse, shouldRunTargetedStructuredRetry } = await import("../src/lib/diagnosis-structured-repair.ts");
const { applyDeterministicDecoctionMethod, applyDeterministicHerbFunctions, groundStructuredPatientFacts, normalizeDiagnoseConfidenceAndLabels, restoreValidatedM03Chain, sanitizeOptionalPathogenesisClassifications, synchronizeVisibleClinicalSummary } = await import("../src/lib/diagnosis-visible-summary.ts");
const { parseOpenAICompatCompletionPayload } = await import("../src/lib/openai-compatible-response.ts");
const { buildM03DiagnosticReviewPrompt, parseM03DiagnosticReview } = await import("../src/lib/m03-diagnostic-review.ts");
const { buildM04ClinicalReviewPrompt, parseM04ClinicalReview } = await import("../src/lib/m04-clinical-review.ts");
const { enforceReviewedPrescriptionOutput } = await import("../src/lib/prescription-output-safety.ts");
const { normalizeClinicalConfidence, normalizePrescriptionRole, normalizeReasoningV2, normalizeWesternDiagnosisStatus } = await import("../src/lib/diagnosis-types.ts");
const { getTcmHerbFunctionDisplayText } = await import("../src/lib/tcm-knowledge.ts");
const { buildM04ClinicalRepairHint } = await import("../src/lib/structured-clinical-repair.ts");
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "sentinel_count_0_0"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "json_invalid"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_primary_syndrome_unstable"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_therapy_method_unstable"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_location_classification_empty"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_nature_classification_empty"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_western_primary_ambiguous"), true);
for (const reason of [
  "m03_western_support_empty",
  "m03_western_support_tcm_pollution",
  "m03_western_support_demographic_padding",
  "m03_western_support_normal_vital_padding",
  "m03_western_support_nondiscriminating",
  "m03_western_support_historical_only",
  "m03_western_support_polarity_mismatch",
]) {
  assert.equal(isM03WesternSupportContractReason(reason), true, `${reason} belongs to the repairable western-support contract class`);
  assert.equal(shouldRunTargetedStructuredRetry("diagnose", reason), true, `${reason} must reach the bounded second repair`);
}
assert.equal(isM03WesternSupportContractReason("m03_western_support_unknown"), false);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_primary_diagnosis_semantic_review"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_tcm_reasoning_semantic_review"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_formula_indication_semantic_review"), true);
assert.equal(shouldRunTargetedStructuredRetry("prescribe", "m04_clinical_semantic_review"), true);
for (const reason of [
  "m04_formula_composition_semantic_review",
  "m04_herb_plan_semantic_review",
  "m04_dose_rationale_semantic_review",
  "m04_patient_context_semantic_review",
]) assert.equal(shouldRunTargetedStructuredRetry("prescribe", reason), true, `${reason} must reach bounded prescription repair`);
assert.equal(shouldRunTargetedStructuredRetry("prescribe", "json_invalid"), true);
assert.equal(shouldRunTargetedStructuredRetry("prescribe", "sentinel_count_0_1"), true);
assert.equal(shouldRunTargetedStructuredRetry("prescribe", "structured_resolver_rejected"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "provider_timeout"), false);
for (const reason of [
  "m04_candidate_0_emperor_missing",
  "m04_candidate_0_emperor_excess",
  "m04_candidate_0_herb_2_emperor_not_primary",
]) {
  const emperorRepairHint = buildM04ClinicalRepairHint(reason);
  assert.match(emperorRepairHint, /恰有 1–2 味君药/);
  assert.match(emperorRepairHint, /targetKind=pathogenesis_node、targetRef=P1/);
  assert.match(emperorRepairHint, /不得新增患者事实、药味或病机节点/);
}
const formulaCompositionRepairHint = buildM04ClinicalRepairHint("m04_formula_reference_declassified");
assert.match(formulaCompositionRepairHint, /不重不漏地纳入.*ingredients/s);
assert.match(formulaCompositionRepairHint, /恰有 1–2 味君药/);
assert.match(formulaCompositionRepairHint, /不得按药味顺序机械指定君药/);
assert.deepEqual(parseM03DiagnosticReview('{"status":"accepted","issueCode":"none"}'), { status: "accepted", issueCode: "none" });
assert.deepEqual(parseM03DiagnosticReview('{"status":"repair","issueCode":"criteria_not_met"}'), { status: "repair", issueCode: "criteria_not_met" });
assert.deepEqual(parseM03DiagnosticReview('{"status":"repair","issueCode":"formula_indication_mismatch"}'), { status: "repair", issueCode: "formula_indication_mismatch" });
assert.deepEqual(parseM03DiagnosticReview('```json\n{"status":"accepted","issueCode":"none"}\n```'), { status: "accepted", issueCode: "none" }, "gateway code fences do not turn a valid reviewer decision into unavailable");
assert.deepEqual(parseM03DiagnosticReview('{"status":"accepted","issueCode":"criteria_not_met"}'), { status: "unavailable", issueCode: "review_unavailable" });
const m03ReviewPrompt = buildM03DiagnosticReviewPrompt(
  "稀便半个月，无腹痛",
  { westernDiagnosis: { primary: { name: "IBS-D" } } },
  "[EVID-GUIDE-001] 慢性腹泻诊断标准摘要",
);
assert.match(m03ReviewPrompt, /病程阈值[\s\S]*必备核心症状[\s\S]*症状性工作诊断[\s\S]*不得把尚未满足标准的病因[\s\S]*临床闭环[\s\S]*中性功能性病机[\s\S]*空链必须返回[\s\S]*命名方的核心适应证/);
assert.match(m03ReviewPrompt, /患者事实边界：稀便半个月，无腹痛[\s\S]*本轮可用证据[\s\S]*绝不能当作患者事实[\s\S]*EVID-GUIDE-001/);
assert.deepEqual(parseM04ClinicalReview('{"status":"accepted","issueCode":"none"}'), { status: "accepted", issueCode: "none" });
assert.deepEqual(parseM04ClinicalReview('{"status":"repair","issueCode":"herb_plan_mismatch"}'), { status: "repair", issueCode: "herb_plan_mismatch" });
assert.deepEqual(parseM04ClinicalReview('复核结果：{"status":"repair","issueCode":"dose_rationale_concern"}'), { status: "repair", issueCode: "dose_rationale_concern" }, "bounded transport prose is tolerated while enum values stay strict");
assert.deepEqual(parseM04ClinicalReview('{"status":"repair","issueCode":"unknown"}'), { status: "unavailable", issueCode: "review_unavailable" });
const m04ReviewPrompt = buildM04ClinicalReviewPrompt(
  "稀便半个月，无腹痛",
  { overview: { primarySyndrome: "脾虚湿困" } },
  { formula: { candidates: [{ name: "痛泻要方加减" }] } },
  "[EVID-LITERATURE-001] 方剂适应证摘要",
);
assert.match(m04ReviewPrompt, /外部合理用药审方/);
assert.match(m04ReviewPrompt, /实际药味组成[\s\S]*不得用患者未提供/);
assert.match(m04ReviewPrompt, /本轮可用证据[\s\S]*绝不能当作患者事实[\s\S]*EVID-LITERATURE-001/);
assert.match(m04ReviewPrompt, /对重要未知状态保持保守鲁棒/);
assert.match(m04ReviewPrompt, /不得用一句.*采纳前复核.*掩盖/);

assert.equal(parseOpenAICompatCompletionPayload('{"choices":[{"message":{"content":"完整结果"},"finish_reason":"stop"}]}')?.choices?.[0]?.message?.content, "完整结果");
assert.equal(parseOpenAICompatCompletionPayload([
  'data: {"choices":[{"delta":{"content":"完整"},"finish_reason":null}]}',
  'data: {"choices":[{"delta":{"content":"结果"},"finish_reason":"stop"}]}',
  "data: [DONE]",
].join("\n"))?.choices?.[0]?.message?.content, "完整结果");
assert.equal(parseOpenAICompatCompletionPayload("not-json-or-sse"), null);
const protectedHerbTable = enforceReviewedPrescriptionOutput([
  "| 药名 | 炮制/规格 | 剂量 |",
  "|---|---|---|",
  "| 山药 | 饮片 | 15g |",
  "| 茯苓 | 饮片 | 15g |",
  "另建议阿司匹林片每日1片。",
].join("\n"));
assert.match(protectedHerbTable, /\| 山药 \| 饮片 \| 15g \|/);
assert.match(protectedHerbTable, /\| 茯苓 \| 饮片 \| 15g \|/);
assert.doesNotMatch(protectedHerbTable, /阿司匹林片每日1片/);
assert.match(protectedHerbTable, /移至西药\/中成药候选区独立审方后另行评估/);
const sanitizedMixedMedicationNarrative = enforceReviewedPrescriptionOutput("可配合生活方式干预。另建议二甲双胍片口服，每日2次。");
assert.doesNotMatch(sanitizedMixedMedicationNarrative, /二甲双胍片|每日2次/);
assert.match(sanitizedMixedMedicationNarrative, /移至西药\/中成药候选区独立审方后另行评估/);
const sanitizedNonHerbTable = enforceReviewedPrescriptionOutput([
  "| 触发条件 | 建议用药 | 剂量 |",
  "|---|---|---|",
  "| 胸痛 | 阿司匹林肠溶片 | 每日1片 |",
].join("\n"));
assert.doesNotMatch(sanitizedNonHerbTable, /阿司匹林肠溶片|每日1片/);
assert.match(sanitizedNonHerbTable, /独立审方后另行评估/);
const sanitizedDisguisedHerbRow = enforceReviewedPrescriptionOutput([
  "| 药名 | 炮制/规格 | 剂量 |",
  "|---|---|---|",
  "| 阿司匹林肠溶片 | 100mg | 每日1片 |",
  "| 茯苓 | 饮片 | 15g |",
].join("\n"));
assert.doesNotMatch(sanitizedDisguisedHerbRow, /阿司匹林肠溶片|100mg|每日1片/);
assert.match(sanitizedDisguisedHerbRow, /\| 茯苓 \| 饮片 \| 15g \|/);
const prescriptionJsonWithConcreteMedicineUsage = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  formula: {
    candidates: [{ name: "本例辨证组方", herbs: [{ name: "茯苓", dose: "15g" }] }],
    patentAndWestern: [{ name: "示例片", usageBoundary: "口服，每日2次，由医生按说明书复核" }],
  },
};
const protectedPrescriptionJson = enforceReviewedPrescriptionOutput([
  "## 候选方药",
  "中药饮片方案见下表。",
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify(prescriptionJsonWithConcreteMedicineUsage, null, 2),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
const protectedPrescriptionJsonText = protectedPrescriptionJson
  .split("<!-- DIAGNOSIS_JSON_START -->")[1]
  .split("<!-- DIAGNOSIS_JSON_END -->")[0]
  .trim();
assert.deepEqual(
  JSON.parse(protectedPrescriptionJsonText),
  prescriptionJsonWithConcreteMedicineUsage,
  "narrative medication cleanup must never corrupt the validated M04 JSON block",
);
assert.equal(normalizePrescriptionRole("臣兼佐"), "臣");
assert.equal(normalizePrescriptionRole("佐、使"), "佐");
assert.equal(normalizePrescriptionRole("主要治疗"), "主要治疗");
assert.equal(normalizeWesternDiagnosisStatus("疑似"), "考虑");
assert.equal(normalizeWesternDiagnosisStatus("优先排除"), "需排除");
assert.equal(normalizeWesternDiagnosisStatus("尚不明确"), "证据有限");
assert.equal(normalizeWesternDiagnosisStatus("unexpected-provider-value"), "证据有限");
assert.equal(normalizeWesternDiagnosisStatus("不考虑"), "证据有限");
assert.equal(normalizeClinicalConfidence("较高"), "高");
assert.equal(normalizeClinicalConfidence("中等"), "中");
assert.equal(normalizeClinicalConfidence("待评估"), "低");
assert.equal(normalizeClinicalConfidence("不高"), "低");
assert.equal(getTcmHerbFunctionDisplayText("神曲", "佐", "脾气亏虚，运化失司"), "佐药配伍定位：承接“脾气亏虚，运化失司”的组方目标");

const valid = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { primarySyndrome: "心脾两虚" },
};
const startMarker = "<!-- DIAGNOSIS_JSON_START -->";
const endMarker = "<!-- DIAGNOSIS_JSON_END -->";
const m03WithUnauthorizedFormula = `${startMarker}\n${JSON.stringify({ ...valid, formula: { candidates: [{ name: "归脾汤", herbs: [{ name: "酸枣仁", dose: "15g" }] }] } })}\n${endMarker}`;
const ownedM03 = enforceStructuredStageOwnership(m03WithUnauthorizedFormula, "diagnose");
assert.equal(JSON.parse(ownedM03.split(startMarker)[1].split(endMarker)[0].trim()).formula, null);
assert.equal(enforceStructuredStageOwnership(m03WithUnauthorizedFormula, "prescribe"), m03WithUnauthorizedFormula);
const syncReasoning = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    primarySyndrome: "心脾两虚证",
    overallPathogenesis: "脾气虚弱，心血不足，心神失养",
    overallTherapy: "健脾益气，养血安神",
    recommendedFormulaDirection: "归脾汤加减方向",
    evidence: { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" },
  },
  pathogenesis: {
    summary: "心脾两虚",
    locationDifferentiation: { items: ["心", "脾"], evidence: { evidenceLevel: "model_inference", source: "本例资料" } },
    natureDifferentiation: { items: ["虚"], evidence: { evidenceLevel: "model_inference", source: "本例资料" } },
    chain: [],
    uncertainties: [],
  },
  therapy: { overallPrinciple: "健脾益气，养血安神", subTherapies: [] },
  formula: null,
  nonPharma: null,
  lineageAdaptation: null,
};
const normalizedWithoutWesternDiagnosis = normalizeReasoningV2(syncReasoning);
assert.equal(normalizedWithoutWesternDiagnosis?.stage, "diagnose", "a malformed or missing Western diagnosis block must not discard the TCM reasoning contract");
assert.equal(normalizedWithoutWesternDiagnosis?.westernDiagnosis.primary.status, "证据有限");
assert.equal(normalizedWithoutWesternDiagnosis?.overview.primarySyndrome, "心脾两虚证");
const driftedVisible = [
  "## 中医证候诊断",
  "**证候诊断**：脾虚证",
  "## 总体病机",
  "**核心病机**：脾虚不运",
  "## 治法框架",
  "**总治法**：单纯健脾",
  startMarker,
  JSON.stringify(syncReasoning),
  endMarker,
].join("\n");
const synchronizedVisible = synchronizeVisibleClinicalSummary(driftedVisible, "diagnose");
assert.match(synchronizedVisible, /\*\*证型\*\*：心脾两虚证/);
assert.match(synchronizedVisible, /\*\*总体病机\*\*：脾气虚弱，心血不足，心神失养/);
assert.match(synchronizedVisible, /\*\*总治法\*\*：健脾益气，养血安神/);
assert.equal(synchronizedVisible.slice(synchronizedVisible.indexOf(startMarker)), driftedVisible.slice(driftedVisible.indexOf(startMarker)));
assert.doesNotMatch(synchronizeVisibleClinicalSummary(driftedVisible.replace("## 治法框架", "| 辨证 | 痰热内扰 | 清热化痰 |\n## 治法框架"), "diagnose"), /痰热内扰|清热化痰/);
assert.equal(synchronizeVisibleClinicalSummary(driftedVisible.replace(endMarker, ""), "diagnose"), driftedVisible.replace(endMarker, ""));
assert.equal(synchronizeVisibleClinicalSummary(driftedVisible, "prescribe"), driftedVisible);
const paraphrasedFactReasoning = {
  ...syncReasoning,
  pathogenesis: {
    ...syncReasoning.pathogenesis,
    chain: [{
      nodeId: "P1",
      patientFact: "晨起神疲、纳差便溏",
      syndromeEvidence: "晨起神疲、纳差便溏",
      pathogenesis: "脾气虚弱，运化失健",
      therapyDirection: "健脾益气",
    }],
  },
};
const groundedFactContent = groundStructuredPatientFacts([
  "## 病机链",
  startMarker,
  JSON.stringify(paraphrasedFactReasoning),
  endMarker,
].join("\n"), "晨起疲乏；食欲欠佳；大便溏薄");
const groundedFactJson = JSON.parse(groundedFactContent.split(startMarker)[1].split(endMarker)[0].trim());
assert.equal(groundedFactJson.pathogenesis.chain[0].patientFact, "晨起疲乏；食欲欠佳；大便溏薄");
const transformedPolarityDrift = [
  "## 已净化展示",
  startMarker,
  JSON.stringify({
    ...syncReasoning,
    pathogenesis: {
      ...syncReasoning.pathogenesis,
      chain: syncReasoning.pathogenesis.chain.map((node) => ({ ...node, patientFact: "发热" })),
    },
  }),
  endMarker,
].join("\n");
const acceptedGroundedContent = ["## 原始已验证结果", startMarker, JSON.stringify(syncReasoning), endMarker].join("\n");
const restoredPolarity = restoreValidatedM03Chain(transformedPolarityDrift, acceptedGroundedContent);
const restoredPolarityJson = JSON.parse(restoredPolarity.split(startMarker)[1].split(endMarker)[0].trim());
assert.deepEqual(
  restoredPolarityJson.pathogenesis.chain,
  syncReasoning.pathogenesis.chain,
  "customer-output transforms must not replace a server-validated patient fact with opposite polarity",
);
const prescribeReasoning = {
  ...syncReasoning,
  stage: "prescribe",
  formula: { candidates: [{
    name: "归脾汤加减",
    herbs: [
      { name: "酸枣仁", processing: "炒", decoctionRequirement: "捣碎后同煎", dose: "15g", role: "君", prescriptionRole: "养心安神", targetPathogenesis: "心血不足", function: "养血安神" },
      { name: "炙甘草", processing: null, decoctionRequirement: null, dose: "6g", role: "使", prescriptionRole: "调和诸药", targetPathogenesis: "调和诸药", function: "益气和中" },
      { name: "大枣", processing: null, decoctionRequirement: null, dose: "3枚", role: "佐", prescriptionRole: "补益脾胃", targetPathogenesis: "脾气虚弱", function: "益气养血" },
    ],
    decoction: { doseCount: "5剂", method: "每日1剂，冷水浸泡30分钟，煎煮2次，合并药液约400mL，早晚分服", course: "5日", followUpNode: "5日复诊" },
  }], modifications: [{ action: "加黄芩9g", doseOrHandling: "9g" }] },
};
const driftedPrescription = [
  "**总体病机**：脾虚",
  "**总治法**：健脾",
  "**剂数**：3剂",
  "**煎服法**：水煎服",
  "**疗程建议**：3日",
  "| 药名 | 剂量 |",
  "|---|---|",
  "| 酸枣仁 | 10g |",
  startMarker,
  JSON.stringify(prescribeReasoning),
  endMarker,
].join("\n");
const synchronizedPrescription = synchronizeVisibleClinicalSummary(driftedPrescription, "prescribe");
assert.match(synchronizedPrescription, /\*\*煎服法\*\*：每日1剂，冷水浸泡30分钟，煎煮2次，合并药液约400mL，早晚分服/);
assert.match(synchronizedPrescription, /\*\*疗程建议\*\*：5日；首次复诊：5日复诊/);
assert.match(synchronizedPrescription, /\| 1 \| 酸枣仁 \| 炒；捣碎后同煎 \| 15g \|/);
assert.match(synchronizedPrescription, /\| 2 \| 炙甘草 \| 饮片 \| 6g \|/);
assert.doesNotMatch(synchronizedPrescription, /\| 酸枣仁 \| 10g \|/);
assert.doesNotMatch(synchronizeVisibleClinicalSummary(driftedPrescription.replace(startMarker, "口苦时加黄芩9g。\n" + startMarker), "prescribe"), /口苦时加黄芩9g/);
assert.match(synchronizedPrescription, /# 候选方药\s+## 归脾汤加减/);
assert.doesNotMatch(synchronizedPrescription, /\*\*\*\*|对应病机：；/, "incomplete legacy modification rows must be omitted from the visible report");
const adultDecoction = applyDeterministicDecoctionMethod(driftedPrescription, "年龄：46岁");
const adultDecoctionJson = JSON.parse(adultDecoction.split(startMarker)[1].split(endMarker)[0].trim());
assert.match(adultDecoctionJson.formula.candidates[0].decoction.method, /约500mL/);
const childDecoction = applyDeterministicDecoctionMethod(driftedPrescription, "年龄：8岁");
const childDecoctionJson = JSON.parse(childDecoction.split(startMarker)[1].split(endMarker)[0].trim());
assert.match(childDecoctionJson.formula.candidates[0].decoction.method, /约200mL/);
const adolescentDecoction = applyDeterministicDecoctionMethod(driftedPrescription, "年龄：17岁");
const adolescentDecoctionJson = JSON.parse(adolescentDecoction.split(startMarker)[1].split(endMarker)[0].trim());
assert.match(adolescentDecoctionJson.formula.candidates[0].decoction.method, /约200mL/);
const structuredAgeDecoction = applyDeterministicDecoctionMethod(driftedPrescription, "主诉：咳嗽3天", 8);
const structuredAgeDecoctionJson = JSON.parse(structuredAgeDecoction.split(startMarker)[1].split(endMarker)[0].trim());
assert.match(structuredAgeDecoctionJson.formula.candidates[0].decoction.method, /约200mL/, "structured age owns pediatric volume without relying on prose formatting");
for (const [label, clinicalContext, structuredAge] of [
  ["newborn zero age", "主诉：出生后黄疸", 0],
  ["month age", "患者6月龄，反复湿疹", undefined],
  ["combined year-month age", "患者1岁6个月，反复咳嗽", undefined],
  ["decimal year age", "年龄：1.5岁", undefined],
]) {
  const pediatricContent = applyDeterministicDecoctionMethod(driftedPrescription, clinicalContext, structuredAge);
  const pediatricJson = JSON.parse(pediatricContent.split(startMarker)[1].split(endMarker)[0].trim());
  assert.match(pediatricJson.formula.candidates[0].decoction.method, /约200mL/, `${label} keeps the pediatric decoction boundary`);
}
const caregiverContextDecoction = applyDeterministicDecoctionMethod(driftedPrescription, "患者为成年人，近期照顾5岁患儿，自己入睡困难");
const caregiverContextJson = JSON.parse(caregiverContextDecoction.split(startMarker)[1].split(endMarker)[0].trim());
assert.match(caregiverContextJson.formula.candidates[0].decoction.method, /约500mL/, "a related child's age cannot change the adult patient's decoction volume");
const canonicalFunctionContent = applyDeterministicHerbFunctions(driftedPrescription.replace("养血安神", "美容养颜"));
const canonicalFunctionJson = JSON.parse(canonicalFunctionContent.split(startMarker)[1].split(endMarker)[0].trim());
assert.match(canonicalFunctionJson.formula.candidates[0].herbs[0].function, /安神/);
assert.doesNotMatch(canonicalFunctionJson.formula.candidates[0].herbs[0].function, /美容养颜/);
const repaired = repairCompletedStructuredSentinel(
  `## 中医证候诊断\n心脾两虚\n\n${startMarker}\n${JSON.stringify(valid)}`,
  "diagnose",
);
assert.match(repaired || "", /DIAGNOSIS_JSON_END/);
assert.match(repaired || "", /心脾两虚/);
assert.equal(repairCompletedStructuredSentinel(`${startMarker}\n{\"schemaVersion\":`, "diagnose"), undefined);
assert.equal(repairCompletedStructuredSentinel(JSON.stringify(valid), "diagnose"), undefined);
assert.equal(repairCompletedStructuredSentinel(`${startMarker}\n${JSON.stringify({ ...valid, stage: "prescribe" })}`, "diagnose"), undefined);
assert.equal(repairCompletedStructuredSentinel(`${startMarker}\njunk\n${JSON.stringify(valid)}`, "diagnose"), undefined);
assert.equal(repairCompletedStructuredSentinel(`${startMarker}\n${JSON.stringify(valid)}\nSECOND_RESULT_TRUNCATED {`, "diagnose"), undefined);
assert.equal(repairCompletedStructuredSentinel(`${startMarker}\n{}\n${startMarker}\n${JSON.stringify(valid)}`, "diagnose"), undefined);

const unsupportedSparseM03 = `${startMarker}\n${JSON.stringify({
  ...syncReasoning,
  overview: { ...syncReasoning.overview, primarySyndrome: "痰热扰心证", overallPathogenesis: "痰热扰心", overallTherapy: "清热化痰" },
  pathogenesis: { ...syncReasoning.pathogenesis, chain: [] },
  therapy: { ...syncReasoning.therapy, overallPrinciple: "清热化痰", overallMethod: "清热化痰" },
})}\n${endMarker}`;
const sparseSanitized = normalizeDiagnoseConfidenceAndLabels(
  sanitizeOptionalPathogenesisClassifications(unsupportedSparseM03, "主诉：入睡困难2周"),
  "主诉：入睡困难2周",
);
const sparseSanitizedJson = JSON.parse(sparseSanitized.split(startMarker)[1].split(endMarker)[0].trim());
assert.equal(sparseSanitizedJson.pathogenesis.chain.length, 0, "a sparse model conclusion must remain incomplete until model repair or independent review supplies a grounded chain");
assert.equal(sparseSanitizedJson.overview.primarySyndromeResolution, "bounded", "an uncorroborated syndrome must remain an explicitly bounded working conclusion");
assert.match(sparseSanitizedJson.overview.primarySyndromeResolutionReason, /有限资料|复核/, "bounded conclusions must explain their uncertainty");
assert.deepEqual(sparseSanitizedJson.overview.primarySyndromeBasis, [], "the contract must not invent supporting patient quotes");
assert.equal(sparseSanitizedJson.overview.evidence.confidence, "低", "bounded conclusions must not retain inflated evidence confidence");

const complete = `## 中医证候诊断\n心脾两虚\n${repaired.slice(repaired.indexOf(startMarker))}`;
assert.equal(resolveCompletedStructuredResponse(complete, "diagnose", "stop"), complete);
const smartClosingDelimiter = `${startMarker}\n${JSON.stringify({ ...valid, overview: { primarySyndrome: "心脾两虚证", detail: "健脾益气，养血安神" } }).replace('安神"}', '安神”}')}\n${endMarker}`;
const normalizedSmartClosingDelimiter = resolveCompletedStructuredResponse(smartClosingDelimiter, "diagnose", "stop");
assert.equal(JSON.parse(normalizedSmartClosingDelimiter.split(startMarker)[1].split(endMarker)[0].trim()).overview.detail, "健脾益气，养血安神");
const smartWrappedJson = `${startMarker}\n{“schemaVersion”:“tcm-cdss-reasoning-v2”,“stage”:“diagnose”,“overview”:{“primarySyndrome”:“心脾两虚”}}\n${endMarker}`;
assert.equal(JSON.parse(resolveCompletedStructuredResponse(smartWrappedJson, "diagnose", "stop").split(startMarker)[1].split(endMarker)[0].trim()).stage, "diagnose");
const legitimateSmartQuoteInProse = `${startMarker}\n${JSON.stringify({ ...valid, overview: { primarySyndrome: "医者所谓“心脾两虚”证" } })}\n${endMarker}`;
assert.match(resolveCompletedStructuredResponse(legitimateSmartQuoteInProse, "diagnose", "stop") || "", /“心脾两虚”/);
for (const endPrefix of ["", "<", "<!-- DIAGNOSIS_JSON_END", "<!-- DIAGNOSIS_JSON_END --"]) {
  const repairedPrefix = resolveCompletedStructuredResponse(`${startMarker}\n${JSON.stringify(valid)}\n${endPrefix}`, "diagnose", "stop");
  assert.match(repairedPrefix || "", /DIAGNOSIS_JSON_END -->/);
}
assert.equal(resolveCompletedStructuredResponse(`${startMarker}\n${JSON.stringify(valid)}\n<!-- DIAGNOSIS_JSON_NOPE`, "diagnose", "stop"), undefined);
for (const reason of ["length", "content_filter", "tool_calls", "function_call", null]) {
  assert.equal(resolveCompletedStructuredResponse(complete, "diagnose", reason), undefined);
}
assert.equal(resolveCompletedStructuredResponse(`${complete}\nextra`, "diagnose", "stop"), undefined);

const missingStart = `## 中医证候诊断\n心脾两虚\n\n${JSON.stringify(valid)}\n${endMarker}`;
const repairedMissingStart = resolveCompletedStructuredResponse(missingStart, "diagnose", "stop");
assert.match(repairedMissingStart || "", /心脾两虚/);
assert.equal((repairedMissingStart?.match(/<!-- DIAGNOSIS_JSON_START -->/g) || []).length, 1);
assert.equal((repairedMissingStart?.match(/<!-- DIAGNOSIS_JSON_END -->/g) || []).length, 1);

const prescribe = { ...valid, stage: "prescribe", overview: { treatmentPrinciple: "健脾养心" } };
assert.match(
  resolveCompletedStructuredResponse(`${JSON.stringify(prescribe)}\n${endMarker}\n\n`, "prescribe", "stop") || "",
  /DIAGNOSIS_JSON_START/,
);

for (const reason of ["length", "content_filter", "tool_calls", "function_call", null]) {
  assert.equal(resolveCompletedStructuredResponse(missingStart, "diagnose", reason), undefined);
}
assert.equal(resolveCompletedStructuredResponse(`${missingStart}\nextra`, "diagnose", "stop"), undefined);
assert.equal(resolveCompletedStructuredResponse(`${missingStart}\n${endMarker}`, "diagnose", "stop"), undefined);
assert.equal(
  resolveCompletedStructuredResponse(`{\"decoy\":true}\n${JSON.stringify(valid)}\n${endMarker}`, "diagnose", "stop"),
  undefined,
);
assert.equal(
  resolveCompletedStructuredResponse(`${JSON.stringify({ ...valid, schemaVersion: "tcm-cdss-reasoning-v1" })}\n${endMarker}`, "diagnose", "stop"),
  undefined,
);
assert.equal(
  resolveCompletedStructuredResponse(`${JSON.stringify({ ...valid, stage: "prescribe" })}\n${endMarker}`, "diagnose", "stop"),
  undefined,
);
assert.equal(
  resolveCompletedStructuredResponse(`${JSON.stringify({ ...valid, note: "字面量 { 不是结构 }" })}\n${endMarker}`, "diagnose", "stop"),
  undefined,
);
assert.equal(
  resolveCompletedStructuredResponse(`{\"schemaVersion\":\"tcm-cdss-reasoning-v2\",\"stage\":\"diagnose\"\n${endMarker}`, "diagnose", "stop"),
  undefined,
);
assert.equal(
  resolveCompletedStructuredResponse(`{\"wrapper\":${JSON.stringify(valid)}\n${endMarker}`, "diagnose", "stop"),
  undefined,
);
assert.equal(resolveCompletedStructuredResponse(`[${JSON.stringify(valid)}]\n${endMarker}`, "diagnose", "stop"), undefined);
assert.equal(resolveCompletedStructuredResponse(`${JSON.stringify(valid)}\nnot-adjacent\n${endMarker}`, "diagnose", "stop"), undefined);

console.log(JSON.stringify({ cases: 58, failures: 0 }));
