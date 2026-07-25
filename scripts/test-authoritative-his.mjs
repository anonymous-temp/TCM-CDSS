import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const { currentVitalsSummary, evaluateSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { buildHisAiSchemePayload } = await jiti.import("../src/lib/his-scheme.ts");

const normalized = normalizeCaseStateInput({
  id: "his-authority",
  patient: { sex: "男", age: 30 },
  chiefComplaint: "顶层主诉",
  pastHistory: "顶层既往史",
  allergyHistory: "顶层无过敏",
  medicationHistory: "顶层未服药",
  tongue: "顶层舌象",
  pulse: "顶层脉象",
  vitals: {
    bloodPressure: "118/72mmHg", BP: "190/122mmHg",
    pulse: "76次/分", HR: "140次/分",
    temperature: "36.6℃", T: "39.5℃",
    respiration: "18次/分", R: "30次/分",
  },
  hisRecord: {
    schemaVersion: "tcm-cdss-his-v1",
    source: "tcm-cdss-his",
    caseId: "his-authority",
    updatedAt: new Date(0).toISOString(),
    tongueImageUploaded: false,
    fields: {
      sex: "女", age: "45岁", zhushu: "HIS主诉", jiwangshi: "HIS既往史",
      guomin: "青霉素过敏", yongyaoshi: "现服华法林3mg每日一次",
      tcmTongue: "舌淡苔薄白", tcmPulse: "脉细弱", vitalsBP: "118/72mmHg",
      vitalsP: "76次/分", vitalsT: "36.6℃", vitalsR: "18次/分",
    },
    rawText: "HIS主诉",
  },
});
assert.ok(normalized);
assert.equal(normalized.patient.sex, "女");
assert.equal(normalized.patient.age, 45);
assert.equal(normalized.chiefComplaint, "HIS主诉");
assert.equal(normalized.pastHistory, "HIS既往史");
assert.equal(normalized.allergyHistory, "青霉素过敏");
assert.equal(normalized.medicationHistory, "现服华法林3mg每日一次");
assert.equal(normalized.tongue, "舌淡苔薄白");
assert.equal(normalized.pulse, "脉细弱");
assert.equal(normalized.vitals.bloodPressure, "118/72mmHg");
assert.equal(normalized.vitals.BP, "190/122mmHg");
assert.match(JSON.stringify(normalized.vitals.sourceConflicts), /190\/122/);
assert.match(JSON.stringify(normalized.vitals.sourceConflicts), /140/);
assert.match(JSON.stringify(normalized.vitals.sourceConflicts), /39\.5/);
assert.match(JSON.stringify(normalized.vitals.sourceConflicts), /30/);
const safetyGate = evaluateSafetyGate(normalized);
assert.equal(safetyGate.status, "needs_information");
assert.equal(safetyGate.redFlags.length, 0, "isolated severe-but-not-extreme vitals are advisories, not emergency locks");
for (const vital of ["血压", "脉搏", "体温", "呼吸"]) {
  assert.match((safetyGate.advisories || []).join("；"), new RegExp(vital), `conflicting ${vital} alias must independently reach the safety gate`);
}
assert.match(currentVitalsSummary(normalized) || "", /BP 118\/72/);
assert.match(currentVitalsSummary(normalized) || "", /P 76/);
assert.match(currentVitalsSummary(normalized) || "", /T 36\.6/);
assert.match(currentVitalsSummary(normalized) || "", /R 18/);

const scheme = buildHisAiSchemePayload(normalized);
assert.equal(scheme.aiMedicalRecord.pastHistory, "HIS既往史");
assert.equal(scheme.aiMedicalRecord.allergyHistory, "青霉素过敏");
assert.equal(scheme.aiMedicalRecord.medicationHistory, "现服华法林3mg每日一次");
assert.match(scheme.aiMedicalRecord.tcmFourDiagnosis, /舌淡苔薄白/);
assert.match(scheme.aiMedicalRecord.vitals, /118\/72/);

const schemeWithStructuredHerb = buildHisAiSchemePayload({
  ...normalized,
  // This assertion verifies structured-herb identity, so use a complete low-risk adoption context.
  // The authoritative fixture above intentionally contains active warfarin and must now remain on
  // the non-dose path under the high-risk gate.
  hisRecord: undefined,
  patient: { sex: "男", age: 45 },
  chiefComplaint: "入睡困难伴多梦3个月",
  symptoms: { presentHistory: "近3个月每周5晚入睡超过1小时，多梦易醒，白天疲乏" },
  pastHistory: "否认心肾功能异常及出血性疾病",
  allergyHistory: "否认药物过敏",
  medicationHistory: "否认当前用药",
  tongue: "舌淡苔薄白",
  pulse: "脉细弱",
  questionRounds: 1,
  reasoningPrescribe: {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    formula: {
      candidates: [{
        name: "测试候选",
        herbs: [{
          name: "炒酸枣仁",
          processing: "炒",
          dose: "15g",
          role: "君",
          prescriptionRole: "养心安神",
          targetKind: "pathogenesis_node",
          targetRef: "P1",
          targetPathogenesis: "心血不足，心神失养",
          function: "养心安神",
          decoctionRequirement: "捣碎后同煎",
        }],
      }],
      modifications: [],
    },
  },
});
assert.equal(schemeWithStructuredHerb.prescriptions.structuredHerbs.length, 1);
assert.deepEqual(schemeWithStructuredHerb.prescriptions.structuredHerbs[0], {
  itemNo: 1,
  name: "炒酸枣仁",
  processing: "炒",
  dose: "15g",
  role: "君",
  prescriptionRole: "养心安神",
  targetKind: "pathogenesis_node",
  targetRef: "P1",
  targetPathogenesis: "心血不足，心神失养",
  function: "养心安神",
  decoctionRequirement: "捣碎后同煎",
});

console.log(JSON.stringify({ cases: 24, failures: 0 }));
