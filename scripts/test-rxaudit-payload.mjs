import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const {
  applyRxAuditInputAdvisories,
  auditPrescriptionWithLingxi,
  buildAuditData,
  buildAuditInputAdvisories,
  buildAuditInputAdvisorySection,
  buildAuditItemsFromHerbs,
  buildRxAuditScopeSection,
  buildMedicationExtractionContext,
  extractMedicationSemanticsForAudit,
  isExplicitNoCurrentMedicationHistory,
  isMechanicallyPreventableAuditIssue,
  medicationCandidatesFromSource,
  rxAuditSubmissionIssue,
  runBoundedRxAudit,
  rxAuditDoctorLevelCodeForCustomer,
  structuredCurrentMedications,
  verifyMedicationSemanticCoverage,
} = await jiti.import("../src/lib/rxaudit.ts");
const { currentMedicationsFromSemanticExtraction, medicationSemanticConsistencyReasons, recoverGroundedAdministrationTimings } = await jiti.import("../src/lib/medication-event-extractor.ts");
const { sanitizeFreeTextForModel } = await jiti.import("../src/lib/diagnosis-safety.ts");

function auditData(overrides = {}, medicationExtraction) {
  const fields = {
    zhushu: "入睡困难三个月",
    xianbingshi: "入睡困难三个月，否认胸痛、气促",
    jiwangshi: "既往无高血压病史；糖尿病病史：无；确诊脂肪肝2年",
    guomin: "药物过敏：无",
    yongyaoshi: "未服用阿司匹林，但目前服用氯吡格雷75mg每日一次",
    vitalsT: "36.6℃",
    vitalsP: "74次/分",
    vitalsR: "18次/分",
    vitalsBP: "118/72mmHg",
    ...overrides.fields,
  };
  const state = {
    customerId: "hospital-A",
    patient: { sex: "男", age: 46 },
    chiefComplaint: fields.zhushu,
    pastHistory: fields.jiwangshi,
    allergyHistory: fields.guomin,
    medicationHistory: fields.yongyaoshi,
    tongue: "舌淡，苔薄白",
    pulse: "脉细弱",
    diagnosis: "## 西医诊断\n失眠障碍\n\n## 中医辨证结论\n证型：心脾两虚证",
    prescription: ["## 中药饮片处方", "| 药名 | 剂量 |", "|---|---|", "| 黄芪 | 15g |", "| 茯苓 | 12g |", "| 酸枣仁 | 15g |", "| 甘草 | 6g |"].join("\n"),
    hisRecord: { fields },
    conversation: [],
    ...overrides,
  };
  const built = buildAuditData(state, undefined, medicationExtraction);
  assert.ok(built, "audit payload should be built");
  return built.data;
}

function auditPatient(overrides = {}, medicationExtraction) {
  return auditData(overrides, medicationExtraction).prescription.patient;
}

const patient = auditPatient();
assert.equal(patient.past_medical_history, "确诊脂肪肝2年");
assert.equal(patient.present_illness, "入睡困难三个月");
assert.match(patient.clinical_summary, /目前服用氯吡格雷75mg每日一次/);
assert.doesNotMatch(patient.clinical_summary, /阿司匹林|过敏：无/);
assert.match(patient.physical_examination, /T 36\.6℃/);
assert.match(patient.physical_examination, /P 74次\/分/);
assert.match(patient.physical_examination, /R 18次\/分/);
assert.match(patient.physical_examination, /BP 118\/72mmHg/);

const originalDoctorLevelMap = process.env.RXAI_AUDIT_DOCTOR_LEVEL_CODES_BY_CUSTOMER;
delete process.env.RXAI_AUDIT_DOCTOR_LEVEL_CODES_BY_CUSTOMER;
assert.equal(auditData().prescription.doctor_level_code, "UNVERIFIED", "missing tenant permission is explicit and non-authorizing");
process.env.RXAI_AUDIT_DOCTOR_LEVEL_CODES_BY_CUSTOMER = JSON.stringify({ "hospital-A": "NARCOTIC_AUTH", "hospital-B": "CHIEF" });
assert.equal(auditData().prescription.doctor_level_code, "NARCOTIC_AUTH", "the authenticated case customer selects its configured provider permission code");
assert.equal(rxAuditDoctorLevelCodeForCustomer("hospital-C"), "UNVERIFIED", "a different customer cannot inherit another tenant's permission");
process.env.RXAI_AUDIT_DOCTOR_LEVEL_CODES_BY_CUSTOMER = JSON.stringify({ "hospital-A": "ROOT" });
assert.equal(auditData().prescription.doctor_level_code, "UNVERIFIED", "unknown codes fail closed");
if (originalDoctorLevelMap == null) delete process.env.RXAI_AUDIT_DOCTOR_LEVEL_CODES_BY_CUSTOMER;
else process.env.RXAI_AUDIT_DOCTOR_LEVEL_CODES_BY_CUSTOMER = originalDoctorLevelMap;

const topLevelVitals = auditPatient({
  fields: { vitalsT: "", vitalsP: "", vitalsR: "", vitalsBP: "" },
  vitals: { T: "37.1℃", P: "82次/分", R: "19次/分", BP: "126/78mmHg" },
});
assert.match(topLevelVitals.physical_examination, /T 37\.1℃/);
assert.match(topLevelVitals.physical_examination, /BP 126\/78mmHg/);

const hisAuthoritative = auditPatient({
  patient: { sex: "男", age: 30 },
  pastHistory: "否认慢性病史",
  allergyHistory: "无药物过敏",
  medicationHistory: "未服药",
  fields: {
    sex: "女",
    age: "45岁",
    jiwangshi: "确诊房颤2年",
    guomin: "对青霉素过敏",
    yongyaoshi: "现服华法林3mg每日一次",
  },
});
assert.equal(hisAuthoritative.gender, "FEMALE");
assert.equal(hisAuthoritative.age, 45);
assert.equal(hisAuthoritative.past_medical_history, "确诊房颤2年");
assert.match(hisAuthoritative.clinical_summary, /青霉素过敏/);
assert.match(hisAuthoritative.clinical_summary, /华法林3mg每日一次/);
assert.deepEqual(hisAuthoritative.current_medications, [{ drug_name: "华法林", dose_daily: "现服华法林3mg每日一次" }]);

const sixMonthOld = auditPatient({ fields: { age: "6个月" } });
assert.equal(sixMonthOld.age, 0.5, "month age must be represented in years without integer coercion");
const decimalAge = auditPatient({ patient: { sex: "男", age: 17.5 }, fields: { age: "17.5岁" } });
assert.equal(decimalAge.age, 17.5, "decimal age must not be rounded up to an adult boundary");

const semanticMedicationPatient = auditPatient({
  fields: { yongyaoshi: "此前服用华法林3mg每日一次，今日已改为阿司匹林100mg每日一次" },
}, {
  source: "model",
  events: [
    { drugName: "华法林", status: "stopped", doseText: "3mg", frequency: "每日一次", sourceQuotes: ["此前服用华法林3mg每日一次"], confidence: 0.98 },
    { drugName: "阿司匹林", status: "current", doseText: "100mg", frequency: "每日一次", sourceQuotes: ["今日已改为阿司匹林100mg每日一次"], confidence: 0.98 },
  ],
  unresolvedReferences: [],
  needsManualReview: false,
});
assert.deepEqual(semanticMedicationPatient.current_medications, [{ drug_name: "阿司匹林", dose_daily: "100mg，每日一次" }]);
assert.match(semanticMedicationPatient.clinical_summary, /今日已改为阿司匹林/);
assert.doesNotMatch(semanticMedicationPatient.clinical_summary, /华法林/);

const recoveredMealTiming = recoverGroundedAdministrationTimings(
  "目前服用阿司匹林100mg，饭后半小时服用",
  [{ drugName: "阿司匹林", status: "current", doseText: "100mg", frequency: null, sourceQuotes: ["目前服用阿司匹林100mg"], confidence: 0.99 }],
);
assert.equal(recoveredMealTiming[0]?.administrationTiming, "饭后半小时服用", "a grounded trailing meal-timing clause is recovered without relying on model field placement");
assert.deepEqual(currentMedicationsFromSemanticExtraction({ source: "model", events: recoveredMealTiming, unresolvedReferences: [], needsManualReview: false }), [{ drug_name: "阿司匹林", dose_daily: "100mg，饭后半小时服用" }]);
const recoveredMultiDrugTiming = recoverGroundedAdministrationTimings(
  "阿司匹林100mg餐后服用，氯吡格雷75mg睡前服用",
  [
    { drugName: "阿司匹林", status: "current", doseText: "100mg", frequency: null, sourceQuotes: ["阿司匹林100mg"], confidence: 0.99 },
    { drugName: "氯吡格雷", status: "current", doseText: "75mg", frequency: null, sourceQuotes: ["氯吡格雷75mg"], confidence: 0.99 },
  ],
);
assert.deepEqual(recoveredMultiDrugTiming.map((event) => event.administrationTiming), ["餐后服用", "睡前服用"], "each administration timing stays bound to the nearest named drug in a multi-drug list");
assert.equal(recoverGroundedAdministrationTimings(
  "目前服用阿司匹林100mg，但不是饭后服用",
  [{ drugName: "阿司匹林", status: "current", doseText: "100mg", frequency: null, sourceQuotes: ["目前服用阿司匹林100mg"], confidence: 0.99 }],
)[0]?.administrationTiming, undefined, "a negated administration timing is never converted into a regimen fact");

const partialSemanticMedicationPatient = auditPatient({
  fields: { yongyaoshi: "目前服用阿司匹林100mg每日一次，但其后已停用" },
}, {
  source: "model",
  events: [
    { drugName: "阿司匹林", status: "stopped", doseText: "100mg", frequency: "每日一次", sourceQuotes: ["目前服用阿司匹林100mg每日一次", "其后已停用"], confidence: 0.98 },
  ],
  unresolvedReferences: ["其后"],
  needsManualReview: true,
  reason: "unresolved_reference",
});
assert.equal(partialSemanticMedicationPatient.current_medications, undefined, "available semantic results must not be mixed with deterministic guesses");

const unavailableMedicationExtraction = {
  source: "unavailable",
  events: [],
  unresolvedReferences: [],
  needsManualReview: true,
  reason: "model_not_configured",
};

const incompleteMedicationExtraction = verifyMedicationSemanticCoverage(
  "目前服用阿司匹林100mg每日一次和氯吡格雷75mg每日一次",
  {
    source: "model",
    events: [{ drugName: "阿司匹林", status: "current", doseText: "100mg", frequency: "每日一次", sourceQuotes: ["目前服用阿司匹林100mg每日一次"], confidence: 0.99 }],
    unresolvedReferences: [],
    needsManualReview: false,
  },
);
assert.equal(incompleteMedicationExtraction.needsManualReview, true);
assert.match(incompleteMedicationExtraction.reason || "", /medication_candidate_coverage_incomplete/);
for (const explicitNoMedication of [
  "否认当前其他用药",
  "没有长期药物",
  "从未服用其他药物",
  "本次尚未使用其他药物",
  "目前未服任何药",
  "现阶段无现用药品",
  "现用药不详",
]) {
  const covered = verifyMedicationSemanticCoverage(explicitNoMedication, {
    source: "model",
    events: [],
    unresolvedReferences: [],
    needsManualReview: false,
  });
  assert.equal(covered.needsManualReview, false, `${explicitNoMedication} must not create a fictitious missing medication candidate`);
  assert.doesNotMatch(covered.reason || "", /medication_candidate_coverage_incomplete/);
}
for (const explicitNoMedication of [
  "否认当前其他用药",
  "没有长期药物",
  "从未服用其他药物",
  "本次尚未使用其他药物",
  "目前未服任何药物",
  "现阶段无现用药品",
]) {
  assert.equal(isExplicitNoCurrentMedicationHistory(explicitNoMedication), true, `${explicitNoMedication} should bypass semantic extraction`);
}
for (const mixedOrUnknown of [
  "现服氨氯地平5mg每日一次，未使用其他药物",
  "现服氨氯地平5mg每日一次未使用其他药物",
  "阿司匹林100mg每日一次目前未服其他药",
  "患者现用药为二甲双胍0.5g每日两次无其他用药",
  "未停用阿司匹林100mg每日一次",
  "现用药不详",
]) {
  assert.equal(isExplicitNoCurrentMedicationHistory(mixedOrUnknown), false, `${mixedOrUnknown} must not be collapsed to no current medication`);
}
for (const [source, medicine] of [
  ["现服氨氯地平5mg每日一次未使用其他药物", "氨氯地平"],
  ["阿司匹林100mg每日一次目前未服其他药", "阿司匹林"],
  ["患者现用药为二甲双胍0.5g每日两次无其他用药", "二甲双胍"],
]) {
  assert.match(JSON.stringify(medicationCandidatesFromSource(source)), new RegExp(medicine), `${medicine} must survive a no-punctuation HIS concatenation`);
}
const affirmedNegatedStopMedication = verifyMedicationSemanticCoverage("未停用阿司匹林100mg每日一次", {
  source: "model",
  events: [],
  unresolvedReferences: [],
  needsManualReview: false,
});
assert.match(affirmedNegatedStopMedication.reason || "", /medication_candidate_coverage_incomplete/, "a negated stop still affirms current medication and must remain a coverage candidate");
const truncatedMedicationExtraction = verifyMedicationSemanticCoverage(
  "目前服用阿司匹林100mg每日一次",
  {
    source: "model",
    events: [{ drugName: "阿司匹林", status: "current", doseText: "100mg", frequency: "每日一次", sourceQuotes: ["目前服用阿司匹林100mg每日一次"], confidence: 0.99 }],
    unresolvedReferences: [],
    needsManualReview: false,
  },
  true,
);
assert.match(truncatedMedicationExtraction.reason || "", /medication_context_truncated/);
const conflictingMedicationExtraction = verifyMedicationSemanticCoverage(
  "目前服用阿司匹林100mg每日一次，其后已停用",
  {
    source: "model",
    events: [
      { drugName: "阿司匹林", status: "current", doseText: "100mg", frequency: "每日一次", sourceQuotes: ["目前服用阿司匹林100mg每日一次"], confidence: 0.99 },
      { drugName: "阿司匹林", status: "stopped", doseText: null, frequency: null, sourceQuotes: ["阿司匹林100mg每日一次", "其后已停用"], confidence: 0.99 },
    ],
    unresolvedReferences: [],
    needsManualReview: false,
  },
);
assert.match(conflictingMedicationExtraction.reason || "", /medication_status_conflict/);

const semanticConflictCases = [
  {
    id: "explicit-current-as-historical",
    source: "患者本人目前服用阿司匹林100mg每日一次",
    expectedReason: /medication_temporal_status_conflict/,
    events: [{ drugName: "阿司匹林", status: "historical", doseText: "100mg", frequency: "每日一次", sourceQuotes: ["患者本人目前服用阿司匹林100mg每日一次"], confidence: 0.99 }],
  },
  {
    id: "explicit-current-as-stopped",
    source: "患者本人目前服用阿司匹林100mg每日一次",
    expectedReason: /medication_temporal_status_conflict/,
    events: [{ drugName: "阿司匹林", status: "stopped", doseText: "100mg", frequency: "每日一次", sourceQuotes: ["患者本人目前服用阿司匹林100mg每日一次"], confidence: 0.99 }],
  },
  {
    id: "explicit-stop-as-current",
    source: "患者本人已停用阿司匹林",
    expectedReason: /medication_temporal_status_conflict/,
    events: [{ drugName: "阿司匹林", status: "current", doseText: null, frequency: null, sourceQuotes: ["患者本人已停用阿司匹林"], confidence: 0.99 }],
  },
  {
    id: "historical-as-current",
    source: "患者本人既往服用华法林",
    expectedReason: /medication_temporal_status_conflict/,
    events: [{ drugName: "华法林", status: "current", doseText: null, frequency: null, sourceQuotes: ["患者本人既往服用华法林"], confidence: 0.99 }],
  },
  {
    id: "family-medication-as-patient",
    source: "妻子长期服用华法林",
    expectedReason: /medication_patient_subject_conflict/,
    events: [{ drugName: "华法林", status: "current", doseText: null, frequency: null, sourceQuotes: ["妻子长期服用华法林"], confidence: 0.99 }],
  },
  {
    id: "negated-medication-as-current",
    source: "患者本人否认服用阿司匹林",
    expectedReason: /medication_polarity_conflict/,
    events: [{ drugName: "阿司匹林", status: "current", doseText: null, frequency: null, sourceQuotes: ["患者本人否认服用阿司匹林"], confidence: 0.99 }],
  },
  {
    id: "drug-identity-not-grounded",
    source: "患者本人目前服用华法林3mg每日一次",
    expectedReason: /medication_event_identity_conflict/,
    events: [{ drugName: "阿司匹林", status: "current", doseText: "3mg", frequency: "每日一次", sourceQuotes: ["患者本人目前服用华法林3mg每日一次"], confidence: 0.99 }],
  },
  {
    id: "dose-not-grounded",
    source: "患者本人目前服用华法林3mg每日一次",
    expectedReason: /medication_event_data_not_grounded/,
    events: [{ drugName: "华法林", status: "current", doseText: "5mg", frequency: "每日一次", sourceQuotes: ["患者本人目前服用华法林3mg每日一次"], confidence: 0.99 }],
  },
  {
    id: "replacement-timeline-reversed",
    source: "此前服用华法林3mg每日一次，今日已改为利伐沙班20mg每日一次",
    expectedReason: /medication_replacement_timeline_conflict/,
    events: [
      { drugName: "华法林", status: "current", doseText: "3mg", frequency: "每日一次", sourceQuotes: ["此前服用华法林3mg每日一次"], confidence: 0.99 },
      { drugName: "利伐沙班", status: "historical", doseText: "20mg", frequency: "每日一次", sourceQuotes: ["今日已改为利伐沙班20mg每日一次"], confidence: 0.99 },
    ],
  },
];
for (const item of semanticConflictCases) {
  const checked = verifyMedicationSemanticCoverage(item.source, {
    source: "model",
    events: item.events,
    unresolvedReferences: [],
    needsManualReview: false,
  });
  assert.equal(checked.needsManualReview, true, item.id);
  assert.match(checked.reason || "", item.expectedReason, item.id);
}

const validReplacementExtraction = verifyMedicationSemanticCoverage(
  "此前服用华法林3mg每日一次，今日已改为利伐沙班20mg每日一次",
  {
    source: "model",
    events: [
      { drugName: "华法林", status: "stopped", doseText: "3mg", frequency: "每日一次", sourceQuotes: ["此前服用华法林3mg每日一次"], confidence: 0.99 },
      { drugName: "利伐沙班", status: "current", doseText: "20mg", frequency: "每日一次", sourceQuotes: ["今日已改为利伐沙班20mg每日一次"], confidence: 0.99 },
    ],
    unresolvedReferences: [],
    needsManualReview: false,
  },
);
assert.equal(validReplacementExtraction.needsManualReview, false, "a correctly ordered replacement must remain model-authoritative");

const validCurrentThenReplacementExtraction = verifyMedicationSemanticCoverage(
  "目前服用阿司匹林100mg每日一次，后改用氯吡格雷75mg每日一次",
  {
    source: "model",
    events: [
      { drugName: "阿司匹林", status: "stopped", doseText: "100mg", frequency: "每日一次", sourceQuotes: ["目前服用阿司匹林100mg每日一次", "后改用氯吡格雷75mg每日一次"], confidence: 0.99 },
      { drugName: "氯吡格雷", status: "current", doseText: "75mg", frequency: "每日一次", sourceQuotes: ["后改用氯吡格雷75mg每日一次"], confidence: 0.99 },
    ],
    unresolvedReferences: [],
    needsManualReview: false,
  },
);
assert.equal(validCurrentThenReplacementExtraction.needsManualReview, false, "a later replacement must supersede the old drug's earlier current evidence");

const splitStatusEvents = [
  { drugName: "阿司匹林", status: "stopped", doseText: null, frequency: null, sourceQuotes: ["阿司匹林已停用"], confidence: 0.99 },
  { drugName: "氯吡格雷", status: "current", doseText: null, frequency: null, sourceQuotes: ["氯吡格雷照旧"], confidence: 0.99 },
];
assert.deepEqual(
  medicationSemanticConsistencyReasons(
    "目前服用阿司匹林和氯吡格雷，两者中的阿司匹林已停用，氯吡格雷照旧",
    splitStatusEvents,
  ),
  [],
  "one drug's explicit stop must not leak onto an adjacent current drug",
);

const validStopThenReplaceExtraction = verifyMedicationSemanticCoverage(
  "二甲双胍已经停用，改用恩格列净10mg每天一次",
  {
    source: "model",
    events: [
      { drugName: "二甲双胍", status: "stopped", doseText: null, frequency: null, sourceQuotes: ["二甲双胍已经停用"], confidence: 0.99 },
      { drugName: "恩格列净", status: "current", doseText: "10mg", frequency: "每天一次", sourceQuotes: ["改用恩格列净10mg每天一次"], confidence: 0.99 },
    ],
    unresolvedReferences: [],
    needsManualReview: false,
  },
);
assert.equal(validStopThenReplaceExtraction.needsManualReview, false, "the old drug's stop must not leak across a replacement connector onto the new drug");

const mixedTimelineEvents = [
  { drugName: "心得安", status: "historical", doseText: null, frequency: null, sourceQuotes: ["年轻时吃过心得安"], confidence: 0.99 },
  { drugName: "美托洛尔", status: "current", doseText: null, frequency: null, sourceQuotes: ["现在因房颤服美托洛尔"], confidence: 0.99 },
  { drugName: "华法林", status: "stopped", doseText: null, frequency: null, sourceQuotes: ["华法林已改成利伐沙班"], confidence: 0.99 },
  { drugName: "利伐沙班", status: "current", doseText: null, frequency: null, sourceQuotes: ["华法林已改成利伐沙班"], confidence: 0.99 },
];
assert.deepEqual(
  medicationSemanticConsistencyReasons(
    "年轻时吃过心得安；现在因房颤服美托洛尔，华法林已改成利伐沙班",
    mixedTimelineEvents,
  ),
  [],
  "a replacement relation must bind to the nearest old drug rather than cross an adjacent medication",
);

const validStopProhibitionExtraction = verifyMedicationSemanticCoverage(
  "华法林3mg每日一次不能停用",
  {
    source: "model",
    events: [{ drugName: "华法林", status: "current", doseText: "3mg", frequency: "每日一次", sourceQuotes: ["华法林3mg每日一次不能停用"], confidence: 0.99 }],
    unresolvedReferences: [],
    needsManualReview: false,
  },
);
assert.equal(validStopProhibitionExtraction.needsManualReview, false, "a stop prohibition must not be inverted into an explicit stop");

const temporalConflictExtraction = verifyMedicationSemanticCoverage(
  semanticConflictCases[0].source,
  {
    source: "model",
    events: semanticConflictCases[0].events,
    unresolvedReferences: [],
    needsManualReview: false,
  },
);
const temporalConflictAdvisories = buildAuditInputAdvisories({
  reasoningPrescribe: {
    stage: "prescribe",
    formula: { candidates: [{ herbs: [{ name: "丹参", dose: "15g", processing: null, decoctionRequirement: null }] }] },
  },
}, 0, temporalConflictExtraction);
assert.match(temporalConflictAdvisories.map((item) => item.message).join("；"), /现用或停用状态冲突.*人工核对/);
const guardedProviderPass = applyRxAuditInputAdvisories({
  ok: true,
  source: "lingxi",
  degraded: false,
  auditResult: "PASS",
  highestRiskLevel: "INFO",
  needManualReview: false,
  issues: [],
  itemCount: 1,
}, temporalConflictAdvisories);
assert.equal(guardedProviderPass.auditResult, "MANUAL_REVIEW", "a medication event conflict must never remain a silent provider PASS");
assert.equal(guardedProviderPass.needManualReview, true);

const incompleteAdvisories = buildAuditInputAdvisories({
  reasoningPrescribe: {
    stage: "prescribe",
    formula: { candidates: [{ herbs: [{ name: "丹参", dose: "15g", processing: null, decoctionRequirement: null }] }] },
  },
}, 0, incompleteMedicationExtraction);
assert.ok(incompleteAdvisories.some((item) => item.code === "medication_semantics_incomplete"));
assert.match(incompleteAdvisories.map((item) => item.message).join("；"), /未覆盖原文中的全部用药候选.*人工核对/);
const deterministicFallbackPatient = auditPatient({
  fields: { yongyaoshi: "现服华法林3mg每日一次" },
}, unavailableMedicationExtraction);
assert.deepEqual(deterministicFallbackPatient.current_medications, [{ drug_name: "华法林", dose_daily: "现服华法林3mg每日一次" }]);
assert.deepEqual(buildAuditInputAdvisories({
  reasoningPrescribe: {
    stage: "prescribe",
    formula: { candidates: [{ herbs: [{ name: "丹参", dose: "15g", processing: null, decoctionRequirement: null }] }] },
  },
}, 0, unavailableMedicationExtraction), [{
  code: "medication_semantics_unavailable",
  itemNo: 0,
  drugName: "现用药",
  message: "现用药时间线或指代未能可靠结构化，联用风险需结合原始用药史人工核对",
}]);

const deidentified = auditPatient({
  fields: { xianbingshi: "本例张三近3日头晕，MRN#A-12345678，门诊号: OP/2026-7788" },
});
assert.doesNotMatch(deidentified.present_illness, /张三|A-12345678|OP\/2026-7788/);
assert.match(deidentified.present_illness, /已脱敏/);

const medicationPhiState = {
  patient: { name: "张三", sex: "男", age: 46 },
  chiefComplaint: "RAW_HIS_FULL_SENTINEL_不得外发",
  medicationHistory: "top-level medication fallback must not win",
  hisRecord: {
    fields: {
      patientName: "张三",
      xianbingshi: "RAW_HIS_FULL_SENTINEL_不得外发，地址：上海市某路1号",
      yongyaoshi: "姓名：张三，MRN: MED-123456，手机号13800138000，目前服用华法林3mg每日一次",
    },
  },
  conversation: [],
};
const safeMedicationContext = buildMedicationExtractionContext(medicationPhiState);
assert.match(safeMedicationContext.text || "", /华法林3mg每日一次/);
assert.doesNotMatch(safeMedicationContext.text || "", /张三|MED-123456|13800138000|RAW_HIS_FULL_SENTINEL|top-level medication fallback/);

const originalModelFetch = globalThis.fetch;
const previousModelEnv = Object.fromEntries([
  "AI_TEXT_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
].map((key) => [key, process.env[key]]));
const capturedModelRequests = [];
process.env.AI_TEXT_PROVIDER = "deepseek";
process.env.OPENAI_API_KEY = "phi-sentinel-model-key";
process.env.OPENAI_BASE_URL = "https://api.deepseek.com";
process.env.OPENAI_MODEL = "deepseek-chat";
globalThis.fetch = async (_url, init) => {
  capturedModelRequests.push(JSON.parse(String(init?.body || "{}")));
  return Response.json({
    id: "chatcmpl-phi-sentinel",
    object: "chat.completion",
    created: 1,
    model: "deepseek-chat",
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: JSON.stringify({
          events: [{
            drugName: "华法林",
            status: capturedModelRequests.length === 1 ? "historical" : "current",
            doseText: "3mg",
            frequency: "每日一次",
            sourceQuotes: ["目前服用华法林3mg每日一次"],
            confidence: 0.99,
          }],
          unresolvedReferences: [],
        }),
      },
    }],
  });
};
try {
  const extracted = await extractMedicationSemanticsForAudit(medicationPhiState);
  assert.equal(extracted.source, "model");
  assert.equal(extracted.needsManualReview, false, "a repaired explicit-current event should proceed without a stale conflict flag");
  assert.equal(capturedModelRequests.length, 2, "an explicit current/status conflict must trigger the model repair pass");
  assert.match(JSON.stringify(capturedModelRequests[1]), /medication_temporal_status_conflict/);
  const outboundModelText = JSON.stringify(capturedModelRequests);
  assert.match(outboundModelText, /华法林3mg每日一次/);
  assert.doesNotMatch(outboundModelText, /张三|MED-123456|13800138000|RAW_HIS_FULL_SENTINEL|top-level medication fallback/);
} finally {
  globalThis.fetch = originalModelFetch;
  for (const [key, value] of Object.entries(previousModelEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

const mixedPolarity = auditPatient({
  fields: {
    guomin: "否认青霉素、头孢，磺胺过敏",
    yongyaoshi: "否认阿司匹林、华法林，氯吡格雷75mg每日一次",
  },
});
assert.match(mixedPolarity.clinical_summary, /磺胺过敏/);
assert.match(mixedPolarity.clinical_summary, /氯吡格雷75mg每日一次/);
assert.doesNotMatch(mixedPolarity.clinical_summary, /青霉素|华法林/);
assert.deepEqual(mixedPolarity.current_medications, [{ drug_name: "氯吡格雷", dose_daily: "氯吡格雷75mg每日一次" }]);

const stoppedMedication = auditPatient({ fields: { guomin: "无药物过敏", yongyaoshi: "既往服用华法林，3月前已停用" } });
assert.equal(stoppedMedication.clinical_summary, undefined);

const restartedMedication = auditPatient({ fields: { guomin: "无药物过敏", yongyaoshi: "既往服用华法林，已停药，今日新启用阿司匹林100mg每日一次" } });
assert.match(restartedMedication.clinical_summary, /新启用阿司匹林100mg每日一次/);
assert.doesNotMatch(restartedMedication.clinical_summary, /华法林/);
assert.deepEqual(restartedMedication.current_medications, [{ drug_name: "阿司匹林", dose_daily: "新启用阿司匹林100mg每日一次" }]);

assert.deepEqual(structuredCurrentMedications("当前规律服用华法林"), [{ drug_name: "华法林", dose_daily: "当前规律服用华法林" }]);
assert.deepEqual(structuredCurrentMedications("二甲双胍0.5g每日2次、缬沙坦80mg每日1次"), [
  { drug_name: "二甲双胍", dose_daily: "二甲双胍0.5g每日2次" },
  { drug_name: "缬沙坦", dose_daily: "缬沙坦80mg每日1次" },
]);
assert.deepEqual(structuredCurrentMedications("既往服用华法林，3月前已停用"), []);
assert.deepEqual(structuredCurrentMedications("现服华法林3毫克每日一次"), [
  { drug_name: "华法林", dose_daily: "现服华法林3毫克每日一次" },
]);
assert.deepEqual(structuredCurrentMedications("目前皮下注射胰岛素10U每日一次"), [
  { drug_name: "胰岛素", dose_daily: "目前皮下注射胰岛素10U每日一次" },
]);
assert.deepEqual(structuredCurrentMedications("舌下含服硝酸甘油0.5毫克必要时使用、吸入布地奈德200微克每日两次"), [
  { drug_name: "硝酸甘油", dose_daily: "舌下含服硝酸甘油0.5毫克必要时使用" },
  { drug_name: "布地奈德", dose_daily: "吸入布地奈德200微克每日两次" },
]);
assert.deepEqual(structuredCurrentMedications("当前用药：阿司匹林100mg每日一次，氯吡格雷75mg每日一次"), [
  { drug_name: "阿司匹林", dose_daily: "当前用药:阿司匹林100mg每日一次" },
  { drug_name: "氯吡格雷", dose_daily: "氯吡格雷75mg每日一次" },
]);
assert.deepEqual(structuredCurrentMedications("目前服用阿司匹林100mg每日一次及氯吡格雷75mg每日一次"), [
  { drug_name: "阿司匹林", dose_daily: "目前服用阿司匹林100mg每日一次" },
  { drug_name: "氯吡格雷", dose_daily: "氯吡格雷75mg每日一次" },
]);
assert.deepEqual(structuredCurrentMedications("现服华法林3mg，每日一次"), [
  { drug_name: "华法林", dose_daily: "现服华法林3mg，每日一次" },
]);
assert.deepEqual(structuredCurrentMedications("暂不服用阿司匹林"), []);
assert.deepEqual(structuredCurrentMedications("二甲双胍0.5g，每日2次，缬沙坦80mg，每日1次"), [
  { drug_name: "二甲双胍", dose_daily: "二甲双胍0.5g，每日2次" },
  { drug_name: "缬沙坦", dose_daily: "缬沙坦80mg，每日1次" },
]);
assert.deepEqual(structuredCurrentMedications("已停阿司匹林"), []);
assert.deepEqual(structuredCurrentMedications("未停用阿司匹林100mg每日一次"), [
  { drug_name: "阿司匹林", dose_daily: "仍在服用阿司匹林100mg每日一次" },
]);
assert.deepEqual(structuredCurrentMedications("已停阿司匹林，目前服用氯吡格雷75mg每日一次"), [
  { drug_name: "氯吡格雷", dose_daily: "目前服用氯吡格雷75mg每日一次" },
]);
assert.deepEqual(structuredCurrentMedications("阿司匹林已停，氯吡格雷75mg每日一次仍在服用"), [
  { drug_name: "氯吡格雷", dose_daily: "氯吡格雷75mg每日一次仍在服用" },
]);
assert.deepEqual(structuredCurrentMedications("目前服用阿司匹林100mg每日一次及氯吡格雷75mg每日一次，已停阿司匹林"), [
  { drug_name: "氯吡格雷", dose_daily: "氯吡格雷75mg每日一次" },
]);
assert.deepEqual(structuredCurrentMedications("阿司匹林100mg每日一次，氯吡格雷75mg每日一次，已停"), [
  { drug_name: "阿司匹林", dose_daily: "阿司匹林100mg每日一次" },
]);
assert.deepEqual(structuredCurrentMedications("不停用阿司匹林100mg每日一次"), [
  { drug_name: "阿司匹林", dose_daily: "仍在服用阿司匹林100mg每日一次" },
]);
for (const historyOnly of [
  "3年前服用华法林3mg每日一次",
  "2023年服用华法林3mg每日一次",
  "二〇二三年服用华法林3mg每日一次",
  "几年前吃过华法林",
  "前几年服用华法林3mg每日一次",
  "以前吃过华法林",
  "之前吃过华法林",
  "曾服用华法林3mg每日一次",
  "去年服用华法林3mg每日一次",
  "小时候服用华法林3mg每日一次",
  "好几年前吃过华法林",
  "十多年前服用过华法林",
  "于2023年服用华法林3mg每日一次",
]) {
  assert.deepEqual(structuredCurrentMedications(historyOnly), [], historyOnly);
}
for (const restartedStatement of [
  "停用阿司匹林后再服用阿司匹林100mg每日一次",
  "停用阿司匹林后又开始服用阿司匹林100mg每日一次",
  "停用阿司匹林后重新开始服用阿司匹林100mg每日一次",
  "停用阿司匹林后恢复口服阿司匹林100mg每日一次",
]) {
  assert.deepEqual(structuredCurrentMedications(restartedStatement).map((item) => item.drug_name), ["阿司匹林"], restartedStatement);
}
assert.deepEqual(structuredCurrentMedications("目前服用阿司匹林和氯吡格雷，后者已停用").map((item) => item.drug_name), ["阿司匹林"]);
assert.deepEqual(structuredCurrentMedications("阿司匹林和氯吡格雷，均未停用").map((item) => item.drug_name), ["阿司匹林", "氯吡格雷"]);
assert.deepEqual(structuredCurrentMedications("当前用药包括阿司匹林、氯吡格雷").map((item) => item.drug_name), ["阿司匹林", "氯吡格雷"]);
assert.deepEqual(structuredCurrentMedications("二甲双胍与缬沙坦目前都在服用").map((item) => item.drug_name), ["二甲双胍", "缬沙坦"]);
for (const historyOnly of ["在2022年短期服用华法林3mg每日一次", "二十余年前服用华法林", "十来年前吃过华法林", "大学期间服用华法林", "青年时期服用华法林", "上世纪服用华法林"]) {
  assert.deepEqual(structuredCurrentMedications(historyOnly), [], historyOnly);
}
for (const restartedStatement of ["停用阿司匹林后复服阿司匹林100mg每日一次", "停用阿司匹林后恢复吃阿司匹林100mg每日一次", "停用阿司匹林后改回服用阿司匹林100mg每日一次"]) {
  assert.deepEqual(structuredCurrentMedications(restartedStatement).map((item) => item.drug_name), ["阿司匹林"], restartedStatement);
}
assert.deepEqual(structuredCurrentMedications("目前服用阿司匹林100mg每日一次，现已停止"), []);
assert.deepEqual(structuredCurrentMedications("目前服用阿司匹林和氯吡格雷。前者已停用").map((item) => item.drug_name), ["氯吡格雷"]);
assert.deepEqual(structuredCurrentMedications("目前服用阿司匹林和氯吡格雷。两者均已停用"), []);
assert.deepEqual(structuredCurrentMedications("药物包括阿司匹林、氯吡格雷").map((item) => item.drug_name), ["阿司匹林", "氯吡格雷"]);
assert.deepEqual(structuredCurrentMedications("当前用药包括二甲双胍500mg每日两次、二甲双胍格列本脲1片每日一次").map((item) => item.drug_name), ["二甲双胍", "二甲双胍格列本脲"]);
assert.deepEqual(structuredCurrentMedications("当前服用阿司匹林一百毫克每日一次").map((item) => item.drug_name), ["阿司匹林"]);
assert.deepEqual(structuredCurrentMedications("华法林3mg每日一次，迄今没有停过").map((item) => item.drug_name), ["华法林"]);
assert.match(structuredCurrentMedications("目前服用阿司匹林100mg，早晚各一次")[0]?.dose_daily || "", /早晚各一次/);
assert.deepEqual(structuredCurrentMedications("3年前服用华法林3mg每日一次，目前服用阿司匹林100mg每日一次"), [
  { drug_name: "阿司匹林", dose_daily: "目前服用阿司匹林100mg每日一次" },
]);
for (const restarted of ["重新服用", "重新启用"]) {
  assert.deepEqual(structuredCurrentMedications(`已停阿司匹林，今日${restarted}阿司匹林100mg每日一次`), [
    { drug_name: "阿司匹林", dose_daily: `${restarted}阿司匹林100mg每日一次` },
  ]);
}
assert.deepEqual(structuredCurrentMedications("不建议停用阿司匹林100mg每日一次"), [
  { drug_name: "阿司匹林", dose_daily: "仍在服用阿司匹林100mg每日一次" },
]);
for (const activeStatement of ["不推荐停用", "没有必要停用", "不应贸然停用"]) {
  assert.deepEqual(structuredCurrentMedications(`${activeStatement}阿司匹林100mg每日一次`), [
    { drug_name: "阿司匹林", dose_daily: "仍在服用阿司匹林100mg每日一次" },
  ]);
}
for (const activeStatement of ["建议不要停用", "不应轻易停用", "没有必要马上停用", "医生不推荐停用"]) {
  assert.deepEqual(structuredCurrentMedications(`${activeStatement}阿司匹林100mg每日一次`), [
    { drug_name: "阿司匹林", dose_daily: "仍在服用阿司匹林100mg每日一次" },
  ]);
}
assert.deepEqual(structuredCurrentMedications("已停阿司匹林，现再次服用阿司匹林100mg每日一次"), [
  { drug_name: "阿司匹林", dose_daily: "现再次服用阿司匹林100mg每日一次" },
]);
assert.deepEqual(structuredCurrentMedications("3年前开始服用华法林3mg每日一次，至今未停用"), [
  { drug_name: "华法林", dose_daily: "3年前开始服用华法林3mg每日一次" },
]);
for (const currentStatement of [
  "从2023年开始服用华法林3mg每日一次，至今未停用",
  "3年前开始服用华法林3mg每日一次，一直没有停用",
  "华法林3mg每日一次，一直服用至今",
]) {
  assert.deepEqual(structuredCurrentMedications(currentStatement), [
    { drug_name: "华法林", dose_daily: currentStatement.split("，")[0] },
  ]);
}
for (const restartedStatement of [
  "阿司匹林停药后再次启用阿司匹林100mg每日一次",
  "停用阿司匹林后重新启用阿司匹林100mg每日一次",
]) {
  assert.deepEqual(structuredCurrentMedications(restartedStatement), [
    { drug_name: "阿司匹林", dose_daily: restartedStatement.split("后")[1] },
  ]);
}
for (const historyOnly of [
  "20余年前服用华法林3mg每日一次",
  "大概五年前服用华法林3mg每日一次",
  "年轻时服用华法林",
  "退休前服用华法林",
  "很久以前服用华法林",
  "早些年服用华法林",
]) {
  assert.deepEqual(structuredCurrentMedications(historyOnly), [], historyOnly);
}
assert.deepEqual(structuredCurrentMedications("目前服用阿司匹林100mg，后来已经停用了"), []);
assert.deepEqual(structuredCurrentMedications("停药后续服阿司匹林100mg每日一次").map((item) => item.drug_name), ["阿司匹林"]);
assert.deepEqual(structuredCurrentMedications("目前服用阿司匹林100mg，后改用氯吡格雷75mg每日一次").map((item) => item.drug_name), ["氯吡格雷"]);
for (const list of ["当前用药：阿司匹林；氯吡格雷", "当前用药：阿司匹林\n氯吡格雷"]) {
  assert.deepEqual(structuredCurrentMedications(list).map((item) => item.drug_name), ["阿司匹林", "氯吡格雷"], list);
}
for (const statement of [
  "目前服用阿司匹林和氯吡格雷。第一种已停用",
  "目前服用阿司匹林和氯吡格雷。前一种已停用",
]) {
  assert.deepEqual(structuredCurrentMedications(statement).map((item) => item.drug_name), ["氯吡格雷"], statement);
}
for (const activeStatement of ["不能随便停用", "切勿停用", "避免停用", "不宜骤停", "暂不考虑停用"]) {
  assert.deepEqual(structuredCurrentMedications(`${activeStatement}阿司匹林100mg每日一次`).map((item) => item.drug_name), ["阿司匹林"], activeStatement);
}
assert.deepEqual(structuredCurrentMedications("目前服用盐酸二甲双胍片500mg，已停二甲双胍"), []);
assert.deepEqual(structuredCurrentMedications("目前服用华法林1/2片每日一次").map((item) => item.drug_name), ["华法林"]);
assert.match(structuredCurrentMedications("目前服用甲氨蝶呤10mg，每周一次")[0]?.dose_daily || "", /每周一次/);
for (const administration of ["饭后服用", "随餐服用"]) {
  const current = structuredCurrentMedications(`目前服用阿司匹林100mg，${administration}`);
  assert.deepEqual(current.map((item) => item.drug_name), ["阿司匹林"], administration);
  assert.match(current[0]?.dose_daily || "", new RegExp(administration));
}

const structuredDiagnosis = buildAuditData({
  patient: { sex: "男", age: 67 },
  chiefComplaint: "心悸",
  diagnosis: "## 西医诊断\n- 心房颤动\n\n## 中医辨证结论\n证型：气虚血瘀证",
  prescription: ["## 中药饮片处方", "| 药名 | 剂量 |", "|---|---|", "| 丹参 | 15g |"].join("\n"),
  conversation: [],
});
assert.equal(structuredDiagnosis.data.prescription.diagnoses[0].diagnosis_name, "心房颤动");
assert.equal(structuredDiagnosis.data.options.enable_llm_audit, false, "synchronous M05 must return rule findings without optional audit-LLM latency");

const missingDoseAdvisories = buildAuditInputAdvisories({
  reasoningPrescribe: {
    stage: "prescribe",
    formula: { candidates: [{ herbs: [{ name: "白术", dose: null, processing: null, decoctionRequirement: null }] }] },
  },
});
assert.deepEqual(missingDoseAdvisories, [{ code: "missing_dose", itemNo: 1, drugName: "白术", message: "白术未标注单次剂量" }]);
const markdownMissingDoseState = {
  patient: {},
  chiefComplaint: "测试",
  diagnosis: "",
  conversation: [],
  prescription: ["## 中药饮片处方", "| 药名 | 剂量 |", "|---|---|", "| 黄芪 | 15g |", "| 白术 | |"].join("\n"),
};
assert.deepEqual(buildAuditInputAdvisories(markdownMissingDoseState), [
  { code: "missing_dose", itemNo: 2, drugName: "白术", message: "白术未标注单次剂量" },
]);
assert.equal(buildAuditData(markdownMissingDoseState)?.itemCount, 2, "Markdown fallback must retain incomplete herb rows for visible data-quality review");
for (const dose of ["剂量待定", "0g", "-3g"]) {
  const advisories = buildAuditInputAdvisories({
    reasoningPrescribe: {
      stage: "prescribe",
      formula: { candidates: [{ herbs: [{ name: "白术", dose, processing: null, decoctionRequirement: null }] }] },
    },
  });
  assert.deepEqual(advisories, [{ code: "missing_dose", itemNo: 1, drugName: "白术", message: "白术未标注单次剂量" }], dose);
  assert.match(buildAuditInputAdvisorySection(advisories), /处方信息待核对[\s\S]*不等同于剂量审核通过/, dose);
}

const degreeNegation = auditPatient({ fields: { xianbingshi: "腹痛不是很重，仍持续存在" } });
assert.match(degreeNegation.present_illness, /腹痛不是很重/);
const newPositiveAfterDenial = auditPatient({ fields: { xianbingshi: "否认胸痛，今晨突发气促" } });
assert.equal(newPositiveAfterDenial.present_illness, "今晨突发气促");
const correctedSymptom = auditPatient({ fields: { xianbingshi: "并非胸痛，是胃脘胀满" } });
assert.equal(correctedSymptom.present_illness, "是胃脘胀满");
const degreePositiveAfterDenial = auditPatient({ fields: { xianbingshi: "否认胸痛，腹痛不是很重" } });
assert.equal(degreePositiveAfterDenial.present_illness, "腹痛不是很重");
const durationPositiveAfterDenial = auditPatient({ fields: { xianbingshi: "并非胸痛，腹痛持续两天" } });
assert.equal(durationPositiveAfterDenial.present_illness, "腹痛持续两天");
const continuedDenialList = auditPatient({ fields: { xianbingshi: "否认胸痛，腹痛" } });
assert.equal(continuedDenialList.present_illness, undefined);

const deidentifiedPastHistory = auditPatient({ fields: { jiwangshi: "本例张三既往高血压" } });
assert.doesNotMatch(deidentifiedPastHistory.past_medical_history, /张三/);
assert.match(deidentifiedPastHistory.past_medical_history, /已脱敏/);
assert.doesNotMatch(sanitizeFreeTextForModel("本例张三既往高血压"), /张三/);

const doseConflictAuditItems = buildAuditItemsFromHerbs({
  reasoningPrescribe: {
    stage: "prescribe",
    formula: { candidates: [{
      herbs: [{ name: "槟榔", dose: "6g", processing: null, decoctionRequirement: null }],
      decoction: {
        doseCount: "5剂",
        dosesPerDay: 1,
        administrationTimesPerDay: 2,
        course: "5日",
        method: "每日1剂，水煎服，每日分2次服",
        followUpNode: "完成5剂后复诊",
      },
    }] },
  },
});
assert.match(String(doseConflictAuditItems[0]?.decoction_requirement || ""), /分用途剂量范围.*实际用途.*给药途径/, "LingXi receives the dose-source conflict as a concrete review requirement");
assert.equal(doseConflictAuditItems[0]?.frequency_code, "QD");
assert.equal(doseConflictAuditItems[0]?.frequency_name, "每日1剂，每日分2次服");
assert.equal(doseConflictAuditItems[0]?.route_name, "口服");
assert.equal(doseConflictAuditItems[0]?.course_days, 5);
const multidimensionalRegimenState = {
  reasoningPrescribe: {
    stage: "prescribe",
    formula: {
      candidates: [{
        herbs: [{ name: "黄连", dose: "3g", processing: null, decoctionRequirement: null }],
        decoction: {
          doseCount: "6剂",
          dosesPerDay: 2,
          administrationTimesPerDay: 3,
          course: "3日",
          method: "每日2剂，水煎服，每日分3次服",
          followUpNode: "完成6剂后复诊",
        },
      }],
      patentAndWestern: [{
        type: "中成药",
        name: "示例中成药",
        specification: "每袋6g",
        usageBoundary: "仅作候选复核",
        course: "3日",
        positioning: "替代方案",
        correspondingProblem: "口苦",
        evidence: { evidenceLevel: "instruction", source: "示例说明书" },
        relationship: "不默认与饮片联用",
        riskNote: "复核过敏史与现用药",
      }, {
        type: "西药",
        name: "示例西药",
        specification: "10mg",
        usageBoundary: "仅供讨论",
        course: "3日",
        positioning: "需医生评估",
        correspondingProblem: "伴随症状",
        evidence: { evidenceLevel: "instruction", source: "示例说明书" },
        relationship: "由医生评估联用",
        riskNote: "复核相互作用",
      }],
      modifications: [],
    },
  },
};
const multidimensionalItems = buildAuditItemsFromHerbs(multidimensionalRegimenState);
assert.equal(multidimensionalItems[0]?.frequency_code, "BID");
assert.equal(multidimensionalItems[0]?.frequency_name, "每日2剂，每日分3次服");
assert.equal(multidimensionalItems[0]?.course_days, 3);
assert.equal(multidimensionalItems[1]?.drug_type, "中成药");
assert.equal(multidimensionalItems[2]?.drug_type, "西药");
assert.equal("single_dose" in multidimensionalItems[1], false, "medicine candidates are submitted without fabricated single-dose values");
assert.match(buildRxAuditScopeSection(multidimensionalRegimenState), /中药饮片 1 味；中成药 1 项；西药 1 项/);
assert.match(buildRxAuditScopeSection(multidimensionalRegimenState), /未伪造单次剂量/);
assert.equal(rxAuditSubmissionIssue({
  reasoningPrescribe: {
    stage: "prescribe",
    formula: { candidates: [{
      herbs: [{ name: "黄连", dose: "3g" }],
      decoction: {
        doseCount: "5剂",
        dosesPerDay: 1,
        course: "5日",
        method: "每日1剂，水煎服",
        followUpNode: "完成5剂后复诊",
      },
    }] },
  },
}), "regimen_incomplete", "missing administrationTimesPerDay must fail closed before provider submission");
const incompleteRegimenState = {
  reasoningPrescribe: {
    stage: "prescribe",
    formula: { candidates: [{
      herbs: [{ name: "槟榔", dose: "6g", processing: null, decoctionRequirement: null }],
      decoction: { doseCount: "5剂", course: "", method: "水煎服", followUpNode: "" },
    }] },
  },
};
assert.equal(rxAuditSubmissionIssue(incompleteRegimenState), "regimen_incomplete");
assert.deepEqual(buildAuditItemsFromHerbs(incompleteRegimenState), [], "a dose-only prescription must never be sent to LingXi");
const fetchBeforeSubmissionGateTest = globalThis.fetch;
let blockedSubmissionFetches = 0;
globalThis.fetch = async () => {
  blockedSubmissionFetches += 1;
  throw new Error("external audit must not be reached for an incomplete regimen");
};
try {
  const boundedBlocked = await runBoundedRxAudit(incompleteRegimenState);
  assert.equal(boundedBlocked.providerAudit.ok, false);
  assert.equal(boundedBlocked.providerAudit.reason, "regimen_incomplete");
  const directBlocked = await auditPrescriptionWithLingxi(incompleteRegimenState);
  assert.equal(directBlocked.ok, false);
  assert.equal(directBlocked.reason, "regimen_incomplete");
  assert.equal(blockedSubmissionFetches, 0, "every audit entry point must reject the incomplete regimen before network I/O");
} finally {
  globalThis.fetch = fetchBeforeSubmissionGateTest;
}
assert.equal(rxAuditSubmissionIssue({
  reasoningPrescribe: {
    stage: "prescribe",
    formula: { candidates: [{
      herbs: [{ name: "槟榔", dose: "剂量待定", processing: null, decoctionRequirement: null }],
      decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日", method: "每日1剂，水煎服，每日分2次服", followUpNode: "完成5剂后复诊" },
    }] },
  },
}), "herb_dose_incomplete");
const traceableAudit = buildAuditData({
  patient: {},
  conversation: [],
  reasoningPrescribe: {
    stage: "prescribe",
    formula: { candidates: [{
      herbs: [{ name: "酸枣仁", dose: "15g", processing: "炒", role: "君", prescriptionRole: "养心安神", targetKind: "pathogenesis_node", targetRef: "P1", targetPathogenesis: "心血不足，心神失养", function: "养心安神" }],
      decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日", method: "每日1剂，水煎服，每日分2次服", followUpNode: "完成5剂后复诊" },
    }] },
  },
});
assert.match(String(traceableAudit?.data?.prescription?.patient?.clinical_summary || ""), /酸枣仁→P1.*心血不足.*养心安神/, "target trace remains available through the provider-supported clinical_summary field");
assert.deepEqual(Object.keys(traceableAudit?.data?.prescription?.items?.[0] || {}).filter((key) => /target|pathogenesis|function/.test(key)), [], "strict provider items receive no unsupported extension fields");
assert.equal(isMechanicallyPreventableAuditIssue({ issueType: "TCM_DECOCTION_METHOD", title: "", description: "木香 应后下,处方未标注" }), true);
assert.equal(isMechanicallyPreventableAuditIssue({ issueType: "DOSE_OVER", title: "用法用量需调整", description: "甘草超过常用量" }), true);
assert.equal(isMechanicallyPreventableAuditIssue({ issueType: "DRUG_INTERACTION", title: "相互作用", description: "需结合患者情况复核" }), false);

console.log(JSON.stringify({ cases: 64 + semanticConflictCases.length + 16, failures: 0 }));
