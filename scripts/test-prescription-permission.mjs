import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const {
  buildSafetyLimitedDiagnosisReasoning,
  derivePrescriptionPermission,
  withSafetyGate,
} = await jiti.import("../src/lib/diagnosis-safety.ts");
const { buildHisAiSchemePayload } = await jiti.import("../src/lib/his-scheme.ts");

const base = {
  id: "permission-case",
  phase: "done",
  patient: { sex: "男", age: 42 },
  chiefComplaint: "入睡困难伴多梦2个月",
  symptoms: {},
  tongue: "舌淡，苔薄白",
  pulse: "脉细",
  allergyHistory: "否认药物及食物过敏",
  medicationHistory: "否认当前用药",
  pastHistory: "否认明显打鼾、目击呼吸暂停及日间嗜睡，无高血压病史",
  vitals: { temperature: "36.6℃", pulse: "72次/分", respiration: "18次/分", bloodPressure: "118/76mmHg" },
  conversation: [],
  completeness: { level: "C", redFlag: 0, infoGain: 0.8, managementImpact: 0.8, answerability: 0.8 },
  questionRounds: 1,
  maxQuestionRounds: 1,
  diagnosis: "## 西医诊断\n失眠障碍待临床确认\n\n## 中医证候\n心脾两虚证\n\n## 总体病机\n心脾两虚，神失所养。",
  prescription: "## 中药饮片候选处方\n归脾汤加减\n| 药味 | 剂量 |\n|---|---|\n| 党参 | 10g |\n| 炒白术 | 10g |\n\n## 西药/中成药方案\n本例暂不推荐具体西药或中成药。",
  riskAssessment: "## 合理用药审方\n未发现明确禁忌，仍需医生复核。\n\n## 随访计划\n一周后复诊。",
};

function permission(state) {
  return derivePrescriptionPermission(withSafetyGate(state));
}

assert.deepEqual(permission(base), {
  candidateMode: "full_dose",
  formalAdoption: "eligible_after_doctor_confirmation",
  reasons: [],
});

const sparse = { ...base, patient: {}, tongue: undefined, pulse: undefined, allergyHistory: undefined, medicationHistory: undefined, vitals: {} };
const sparsePermission = permission(sparse);
assert.equal(sparsePermission.candidateMode, "limited_dose", "稀疏病历应继续生成有限剂量候选");
assert.equal(sparsePermission.formalAdoption, "eligible_after_doctor_confirmation", "普通缺项应提示医生确认而不是硬拦截");

const sparseScheme = buildHisAiSchemePayload(withSafetyGate(sparse));
assert.ok(sparseScheme.prescriptions.herbal.length > 0, "有限候选仍应在 HIS 方案中可见");
assert.equal(sparseScheme.writeBackPolicy.allowSingleItemAdoption, true);
assert.equal(sparseScheme.candidateStatus, "valid");

const advisoryOnly = {
  ...base,
  safetyGate: {
    status: "ready",
    allowDiagnosis: true,
    allowDosePrescription: true,
    action: "proceed",
    missingItems: [],
    redFlags: [],
    advisories: ["建议尽快复测血压；提示不阻断辅助推理。"],
    reasons: [],
  },
};
assert.equal(permission(advisoryOnly).candidateMode, "full_dose", "普通风险提示不得降低候选权限");

const auditAlert = {
  ...base,
  riskAssessment: "## 合理用药审方\nCRITICAL：需医生重点复核。",
  prescriptionRevision: {
    source: "herb_workbench",
    candidateIndex: 0,
    herbHash: "hash",
    auditedAt: new Date(0).toISOString(),
    auditResult: "BLOCK",
    highestRiskLevel: "CRITICAL",
    auditAvailable: true,
    needManualReview: true,
  },
};
assert.deepEqual(permission(auditAlert), permission(base), "审方只提供提示，不改变候选或正式采纳权限");

for (const pastHistory of [
  "妊娠8周",
  "现妊娠8周",
  "确认怀孕，孕10周",
  "高血压5年；目前妊娠12周",
  "既往史栏误填：确认怀孕，孕10周",
]) {
  const pregnancy = { ...base, patient: { sex: "女", age: 31 }, pastHistory };
  assert.equal(permission(pregnancy).candidateMode, "non_dose_only", `当前妊娠必须阻断剂量候选: ${pastHistory}`);
  assert.equal(permission(pregnancy).formalAdoption, "blocked", `当前妊娠不得正式采纳: ${pastHistory}`);
}

for (const pastHistory of [
  "既往妊娠8周自然流产史",
  "妊娠史：曾怀孕8周后自然流产",
  "既往孕3产1",
  "曾经怀孕，现已终止妊娠",
]) {
  assert.notEqual(
    permission({ ...base, patient: { sex: "女", age: 31 }, pastHistory }).candidateMode,
    "non_dose_only",
    `明确历史妊娠不得误判为当前妊娠: ${pastHistory}`,
  );
}

const pediatric = { ...base, patient: { sex: "男", age: 8 } };
assert.equal(permission(pediatric).candidateMode, "non_dose_only");

const semanticUnavailable = {
  ...base,
  clinicalFacts: {
    redFlags: [],
    semanticStatus: "unavailable",
    unavailableReason: "timeout",
    sourceCoverage: "full",
    reviewStatus: "unavailable",
  },
};
assert.equal(permission(semanticUnavailable).candidateMode, "non_dose_only", "语义红旗筛查未完成时只允许非剂量分析");
assert.equal(permission(semanticUnavailable).formalAdoption, "blocked");

const urgentActiveBleeding = {
  ...base,
  chiefComplaint: "这两天反复解少量黑便，目前精神和血压稳定",
  clinicalFacts: {
    redFlags: [{
      category: "gi_bleed",
      subject: "patient",
      status: "positive",
      urgency: "urgent",
      triageBasis: "urgent_review",
      quote: "反复解少量黑便",
    }],
    semanticStatus: "checked",
    reviewStatus: "checked",
    sourceCoverage: "full",
  },
};
const urgentGate = withSafetyGate(urgentActiveBleeding).safetyGate;
assert.equal(urgentGate?.status, "red_flag", "活动性黑便应按消化道出血风险进入急症分流");
assert.equal(permission(urgentActiveBleeding).candidateMode, "non_dose_only", "活动性消化道出血不得生成剂量候选");
assert.equal(permission(urgentActiveBleeding).formalAdoption, "blocked");

const emergency = {
  ...base,
  chiefComplaint: "当前持续胸痛30分钟未缓解",
  safetyGate: {
    status: "red_flag",
    allowDiagnosis: true,
    allowDosePrescription: false,
    action: "refer_or_emergency",
    missingItems: [],
    redFlags: ["疑似时间敏感性急性心血管事件"],
    reasons: ["请优先急诊评估"],
  },
};
assert.equal(permission(emergency).candidateMode, "non_dose_only");
assert.equal(permission(emergency).formalAdoption, "blocked");

const emergencyLimited = buildSafetyLimitedDiagnosisReasoning(emergency, emergency.safetyGate);
assert.equal(emergencyLimited.stage, "diagnose");
assert.equal(emergencyLimited.overview.primarySyndromeResolution, "unresolved");
assert.equal(emergencyLimited.pathogenesis.chain.length, 0);
assert.equal(emergencyLimited.formula, null);
assert.equal(emergencyLimited.overview.evidence.evidenceLevel, "deterministic_rule");
assert.match(emergencyLimited.management.redFlagLoop, /120/);

const exhaustedGate = {
  status: "needs_information",
  allowDiagnosis: false,
  allowDosePrescription: false,
  action: "complete_before_prescription",
  missingItems: ["稳定的证候与病机链"],
  redFlags: [],
  reasons: ["M03结构或临床复核未通过"],
};
const exhaustedLimited = buildSafetyLimitedDiagnosisReasoning(base, exhaustedGate);
assert.equal(exhaustedLimited.overview.primarySyndromeResolution, "unresolved");
assert.equal(exhaustedLimited.pathogenesis.chain.length, 0);
assert.equal(exhaustedLimited.formula, null);
assert.match(exhaustedLimited.overview.primarySyndromeResolutionReason, /未形成/);

const noChief = { ...base, chiefComplaint: "" };
assert.equal(permission(noChief).candidateMode, "blocked");

console.log(JSON.stringify({ cases: 40, failures: 0 }));
