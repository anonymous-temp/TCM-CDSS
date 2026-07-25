import assert from "node:assert/strict";
import { authoritativePatientAgeYears, canForceProceedPastSafetyGate, evaluateSafetyGate } from "../src/lib/diagnosis-safety.ts";

// 儿科病例即便只用定性词标注(患儿/婴儿/男童/月龄…)、无数字年龄，也必须命中"儿童剂量级处方规则"门，
// fail-closed 到儿科医师/药师个体化复核，绝不退化为成人剂量。成人则不得误伤。
const base = { conversation: [], patient: {}, completeness: { level: "C" } };
const gate = (cs) => evaluateSafetyGate({ ...base, ...cs });
const hasPedRule = (g) => g.missingItems.some((x) => x.includes("儿童剂量级处方规则"));

const cases = [
  ["患儿(无年龄)命中", { chiefComplaint: "患儿，发热3天伴咳嗽，纳差" }, true],
  ["男童6月龄命中", { chiefComplaint: "男童6月龄，湿疹反复" }, true],
  ["婴儿命中", { chiefComplaint: "婴儿腹泻2天" }, true],
  ["age=0新生儿命中", { chiefComplaint: "出生后黄疸", patient: { age: 0 } }, true],
  ["小数年龄0.5岁命中", { chiefComplaint: "咳嗽3天", patient: { age: 0.5 } }, true],
  ["患者1岁6个月命中", { chiefComplaint: "患者1岁6个月，反复咳嗽" }, true],
  ["句首12岁口语病历命中", { chiefComplaint: "12岁反复咳嗽3天，舌淡苔薄白" }, true],
  ["数字年龄5岁命中", { chiefComplaint: "发热咳嗽", patient: { age: "5" } }, true],
  ["成人42岁不误命中", { chiefComplaint: "失眠2周，易醒", patient: { age: "42" } }, false],
  ["成人照顾孩子不误命中", { chiefComplaint: "成人因近期照顾孩子夜间频繁醒来，自己失眠2周" }, false],
  ["患者照顾5岁患儿不误命中", { chiefComplaint: "患者为成年人，近期照顾5岁患儿，自己入睡困难" }, false],
  ["无儿科线索成人不误命中", { chiefComplaint: "反复胃胀1月，嗳气" }, false],
];

assert.equal(authoritativePatientAgeYears({ ...base, chiefComplaint: "出生后黄疸", patient: { age: 0 } }), 0, "age=0 must remain an authoritative newborn age");
assert.equal(authoritativePatientAgeYears({ ...base, chiefComplaint: "患者6月龄，反复湿疹" }), 0.5, "month age converts to years without integer-age drift");
assert.equal(authoritativePatientAgeYears({ ...base, chiefComplaint: "患者1岁6个月，反复咳嗽" }), 1.5, "combined year-month age remains precise");
assert.equal(authoritativePatientAgeYears({ ...base, chiefComplaint: "患者1.5岁，纳差" }), 1.5, "decimal year age remains precise");
assert.equal(authoritativePatientAgeYears({ ...base, chiefComplaint: "12岁反复咳嗽3天，舌淡苔薄白" }), 12, "a concise primary-care age-first complaint remains a patient demographic");
assert.equal(authoritativePatientAgeYears({ ...base, chiefComplaint: "患者为成年人，近期照顾5岁患儿，自己入睡困难" }), undefined, "a related child's age is not the patient's age");
assert.equal(authoritativePatientAgeYears({
  ...base,
  chiefComplaint: "便秘三个月",
  patient: { age: 56 },
  conversation: [
    { role: "user", content: "初始记录：便秘三个月" },
    { role: "assistant", content: "已完成一轮追问" },
    { role: "user", content: "本次未取得该信息" },
  ],
}), 56, "structured compatibility age remains authoritative when a later follow-up answer does not repeat it");
assert.equal(authoritativePatientAgeYears({
  ...base,
  chiefComplaint: "失眠",
  patient: { age: 42 },
  conversation: [{ role: "user", content: "近期照顾5岁患儿，自己睡不好" }],
}), 42, "a related person's age cannot replace the structured patient age");
assert.equal(authoritativePatientAgeYears({
  ...base,
  chiefComplaint: "咳嗽",
  patient: { age: 56 },
  hisRecord: {
    schemaVersion: "tcm-cdss-his-v1",
    source: "tcm-cdss-his",
    caseId: "age-source-test",
    updatedAt: "2026-07-22T00:00:00.000Z",
    tongueImageUploaded: false,
    fields: {},
    rawText: "主诉咳嗽",
  },
}), undefined, "an HIS snapshot with no age never falls back to a compatibility DTO age");
assert.equal(authoritativePatientAgeYears({
  ...base,
  patient: { age: 56 },
  chiefComplaint: "咳嗽",
  hisRecord: {
    schemaVersion: "tcm-cdss-his-v1",
    source: "tcm-cdss-his",
    caseId: "raw-age-source-test",
    updatedAt: "2026-07-22T00:00:00.000Z",
    tongueImageUploaded: false,
    fields: {},
    rawText: "8岁男童咳嗽3天，舌淡苔薄白。",
  },
}), 8, "a patient-bound age in the current HIS raw record is authoritative");
assert.equal(authoritativePatientAgeYears({
  ...base,
  patient: { age: 56 },
  chiefComplaint: "失眠",
  hisRecord: {
    schemaVersion: "tcm-cdss-his-v1",
    source: "tcm-cdss-his",
    caseId: "relative-age-source-test",
    updatedAt: "2026-07-22T00:00:00.000Z",
    tongueImageUploaded: false,
    fields: {},
    rawText: "患者为成年人，近期照顾5岁患儿，自己入睡困难。",
  },
}), undefined, "a related child's age in HIS raw text never becomes the patient's age");

let pass = 0;
for (const [name, cs, expected] of cases) {
  const g = gate(cs);
  assert.equal(hasPedRule(g), expected, `${name}: expected ${expected}`);
  if (expected) {
    assert.equal(g.allowDosePrescription, false, `${name}: 命中儿童门时应禁止剂量级处方`);
    assert.equal(canForceProceedPastSafetyGate(g), true, `${name}: 追问可跳过，但后续权限仍必须保持非剂量儿科边界`);
  }
  console.log(`PASS  ${name}  -> pedGate=${hasPedRule(g)}`);
  pass++;
}
console.log(`\n${pass}/${cases.length} passed`);
