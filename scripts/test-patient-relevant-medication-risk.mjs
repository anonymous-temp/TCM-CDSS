import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  clinicianVisibleMedicationRiskNote,
  reproductiveMedicationRiskApplies,
} = await jiti.import("../src/lib/patient-relevant-medication-risk.ts");

function state({ sex = "女", age = 78, pastHistory = "既往体健；50岁自然绝经，已绝经28年。", extraText = "" } = {}) {
  return {
    id: "visible-medication-risk-test",
    phase: "done",
    patient: { sex, age },
    chiefComplaint: "反酸、嗳气反复1年",
    symptoms: {},
    pastHistory,
    hisRecord: {
      schemaVersion: "tcm-cdss-his-v1",
      source: "tcm-cdss-his",
      caseId: "visible-medication-risk-test",
      updatedAt: "2026-08-19T00:00:00.000Z",
      tongueImageUploaded: false,
      fields: { sex, age: `${age}岁`, jiwangshi: pastHistory, extraText },
      rawText: [pastHistory, extraText].filter(Boolean).join("；"),
    },
  };
}

const labelRisk = [
  "1.孕妇慎用。2.忌生冷油腻食物。3.长期服用应向医师咨询。",
  "儿童、孕妇、哺乳期妇女、经期妇女、年老体弱者应在医师指导下服用。",
  "妊娠期前3个月慎用。",
  "如与其他药物同时使用可能会发生药物相互作用，详情请咨询医师或药师。",
].join("；");

const elderly = state();
assert.equal(reproductiveMedicationRiskApplies(elderly), false, "60岁以上且无阳性生殖状态时不展示生育相关条款");
const elderlyVisible = clinicianVisibleMedicationRiskNote(labelRisk, elderly);
assert.doesNotMatch(elderlyVisible, /孕妇|妊娠|哺乳|备孕|乳母/, "78岁绝经女性页面仍出现妊娠/哺乳条款");
assert.match(elderlyVisible, /忌生冷油腻食物/, "过滤生育条款时不得误删普通用药注意事项");
assert.match(elderlyVisible, /年老体弱者应在医师指导下服用/, "混合特殊人群条款必须保留老年患者相关内容");
assert.match(elderlyVisible, /药物相互作用/, "相互作用提示必须保留");
assert.equal(
  clinicianVisibleMedicationRiskNote("孕妇及肝肾功能不全者禁用", elderly),
  "肝肾功能不全者禁用",
  "去除孕妇人群后必须保留同句的肝肾功能不全禁忌",
);
assert.equal(
  clinicianVisibleMedicationRiskNote("孕妇、儿童及年老体弱者应在医师指导下服用", elderly),
  "儿童及年老体弱者应在医师指导下服用",
  "混合人群条款不得连坐删除儿童及年老体弱者提示",
);
assert.equal(
  clinicianVisibleMedicationRiskNote("孕妇禁用", elderly),
  "",
  "纯生育相关禁忌对明确绝经患者应隐藏",
);

const menopausal = state({ age: 58, pastHistory: "已绝经5年。" });
assert.equal(reproductiveMedicationRiskApplies(menopausal), false, "明确绝经状态应关闭无关生育条款展示");
assert.doesNotMatch(clinicianVisibleMedicationRiskNote("孕妇忌服；肾功能不全者慎用", menopausal), /孕妇/);
assert.match(clinicianVisibleMedicationRiskNote("孕妇忌服；肾功能不全者慎用", menopausal), /肾功能不全/);

const adult = state({ age: 32, pastHistory: "既往体健。" });
assert.equal(reproductiveMedicationRiskApplies(adult), true, "生育年龄女性必须保留说明书生育相关条款");
assert.equal(clinicianVisibleMedicationRiskNote(labelRisk, adult), labelRisk, "适用患者的原始说明书提示不得改写");

const explicitPregnancy = state({ age: 65, pastHistory: "辅助生殖后确认已妊娠8周。" });
assert.equal(reproductiveMedicationRiskApplies(explicitPregnancy), true, "明确妊娠阳性必须覆盖年龄过滤");
assert.match(clinicianVisibleMedicationRiskNote(labelRisk, explicitPregnancy), /孕妇|妊娠/);

const male = state({ sex: "男", age: 45, pastHistory: "既往体健。" });
assert.equal(reproductiveMedicationRiskApplies(male), false, "男性不展示妊娠哺乳说明书条款");
assert.doesNotMatch(clinicianVisibleMedicationRiskNote(labelRisk, male), /孕妇|妊娠|哺乳/);

const unknownSex = state({ sex: "其他或未明确", age: 78, pastHistory: "既往体健。" });
assert.equal(reproductiveMedicationRiskApplies(unknownSex), true, "性别未明确时不得仅凭年龄隐藏生育相关条款");
assert.equal(clinicianVisibleMedicationRiskNote(labelRisk, unknownSex), labelRisk);

const source = { riskNote: labelRisk };
clinicianVisibleMedicationRiskNote(source.riskNote, elderly);
assert.equal(source.riskNote, labelRisk, "医生可见投影不得修改签名载荷或后台审方原文");

const recordCompletenessNoise = "病历尚未确认发热是否存在；忌辛辣、生冷、油腻食物；如正在使用其他药物，请核对相互作用";
const patientRelevantOnly = clinicianVisibleMedicationRiskNote(recordCompletenessNoise, adult);
assert.doesNotMatch(patientRelevantOnly, /病历尚未确认|是否存在/, "药品卡片不得把记录完整性陈述当成患者风险展示");
assert.match(patientRelevantOnly, /忌辛辣、生冷、油腻食物/);
assert.match(patientRelevantOnly, /相互作用/);
assert.equal(clinicianVisibleMedicationRiskNote("病历尚未确认发热是否存在", adult), "", "只有记录完整性噪声时应省略风险栏而不是输出占位");

console.log(JSON.stringify({ suite: "patient-relevant-medication-risk", cases: 8, failures: 0 }));
