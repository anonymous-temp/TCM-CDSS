import assert from "node:assert/strict";
import { createJiti } from "jiti";
import icdIndex from "../src/data/icd10-diagnosis-index.json" with { type: "json" };

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { applyDeterministicIcd10Coding, resolveIcd10Diagnosis } = await jiti.import("../src/lib/icd10-diagnosis-coding.server.ts");
const { isSupportedIcd10PayerCode } = await jiti.import("../src/lib/icd10-code.ts");

for (const [name, code] of [
  ["原发性高血压", "I10.x09"],
  ["急性上呼吸道感染", "J06.900"],
  ["2型糖尿病", "E11.900"],
  ["失眠障碍", "G47.000x001"],
  ["心房颤动", "I48.900x004"],
  ["功能性消化不良", "K30.x00"],
  ["偏头痛", "G43.900"],
]) {
  assert.equal(resolveIcd10Diagnosis(name)?.code, code, `${name} must resolve from the full payer ICD-10 workbook`);
}
assert.equal(resolveIcd10Diagnosis("颈椎病"), undefined, "a broad name with only subtype rows must remain uncoded");
assert.equal(resolveIcd10Diagnosis("心房颤动", "需排除"), undefined, "a differential must not be presented as a confirmed ICD code");
assert.deepEqual(
  { code: resolveIcd10Diagnosis("慢性咳嗽")?.code, mapping: resolveIcd10Diagnosis("慢性咳嗽")?.mapping },
  { code: "R05.x00", mapping: "governed_alias" },
);
assert.equal(
  icdIndex.entries.filter((entry) => !isSupportedIcd10PayerCode(entry.code)).length,
  0,
  "the structured M03 contract must accept every code emitted by the governed payer workbook",
);
assert.equal(isSupportedIcd10PayerCode("I10.x09"), true);
assert.equal(isSupportedIcd10PayerCode("A01.000x005+J17.0*"), true);
assert.equal(isSupportedIcd10PayerCode("I10;DROP"), false);
assert.deepEqual(
  { code: resolveIcd10Diagnosis("COPD")?.code, mapping: resolveIcd10Diagnosis("COPD")?.mapping },
  { code: "J44.900", mapping: "governed_alias" },
);
for (const [name, code, display] of [
  ["胃食管反流症状", "R12.x00x002", "反酸"],
  ["反酸烧心症状", "R12.x00x002", "反酸"],
  ["嗳气症状", "R14.x00x002", "嗳气"],
]) {
  const coding = resolveIcd10Diagnosis(name);
  assert.deepEqual(
    { code: coding?.code, display: coding?.display, mapping: coding?.mapping },
    { code, display, mapping: "governed_alias" },
    `${name} 必须降为规范症状编码，不能显示一个无 ICD 的混合标签`,
  );
}
assert.equal(resolveIcd10Diagnosis("胃食管反流症状", "证据有限")?.code, "R12.x00x002",
  "证据有限仍可编码已记录的规范症状");
assert.equal(resolveIcd10Diagnosis("反酸", "证据有限")?.code, "R12.x00x002");
assert.equal(resolveIcd10Diagnosis("胃食管反流症状，病因待查", "考虑")?.code, "R12.x00x002",
  "病因待查后缀不得阻断症状编码");
assert.equal(resolveIcd10Diagnosis("胃食管反流病，病因待查", "考虑"), undefined,
  "病因待查的疾病名不得借症状编码规则升级为 K21");
assert.equal(resolveIcd10Diagnosis("胃食管反流病", "证据有限"), undefined,
  "证据有限不得把疾病倾向升级成 K21 正式疾病编码");
assert.equal(resolveIcd10Diagnosis("急性上呼吸道感染，病因待查", "考虑")?.code, "J06.900",
  "病原未分型不应阻断本就未特指病原的急性上呼吸道感染编码");
assert.equal(resolveIcd10Diagnosis("急性痛风性关节炎，病因待查", "考虑"), undefined,
  "具体病因疾病不得借急性上呼吸道感染的受控例外获得正式编码");

const raw = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({
  westernDiagnosis: { primary: { name: "原发性高血压", status: "考虑", coding: { system: "ICD-10", code: "Z99", display: "模型伪造", source: "模型" } } },
})}\n<!-- DIAGNOSIS_JSON_END -->`;
const transformed = applyDeterministicIcd10Coding(raw);
assert.match(transformed, /"code":"I10\.x09"/);
assert.doesNotMatch(transformed, /Z99|模型伪造/);

const refluxSymptomRaw = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({
  westernDiagnosis: { primary: { name: "胃食管反流症状，病因待查", status: "考虑" }, differentials: [{ name: "胃食管反流病" }] },
})}\n<!-- DIAGNOSIS_JSON_END -->`;
const refluxSymptomTransformed = applyDeterministicIcd10Coding(refluxSymptomRaw);
const refluxPayload = JSON.parse(refluxSymptomTransformed
  .split("<!-- DIAGNOSIS_JSON_START -->")[1]
  .split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(refluxPayload.westernDiagnosis.primary.name, "反酸",
  "症状层主诊断名必须与 ICD 编码名称一致");
assert.equal(refluxPayload.westernDiagnosis.primary.coding.code, "R12.x00x002");
assert.equal(refluxPayload.westernDiagnosis.differentials[0].name, "胃食管反流病",
  "疾病实体继续保留在鉴别诊断，不因症状编码而消失");

const refluxDiseasePendingRaw = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({
  westernDiagnosis: {
    primary: {
      name: "胃食管反流病，病因待查",
      status: "考虑",
      supportingFacts: ["反酸、嗳气反复1年余", "餐后反酸加重"],
      clinicalRationale: "当前症状支持胃食管反流病工作判断，但尚无胃镜或反流监测依据。",
      limitations: ["未提供胃镜、24小时食管pH监测"],
      suggestedChecks: ["胃镜检查"],
    },
    differentials: [{ name: "慢性胃炎", reason: "胃脘隐痛", distinguishingPoints: "待胃镜鉴别", nextCheck: "胃镜" }],
  },
})}\n<!-- DIAGNOSIS_JSON_END -->`;
const refluxDiseasePendingTransformed = applyDeterministicIcd10Coding(refluxDiseasePendingRaw);
const refluxDiseasePendingPayload = JSON.parse(refluxDiseasePendingTransformed
  .split("<!-- DIAGNOSIS_JSON_START -->")[1]
  .split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(refluxDiseasePendingPayload.westernDiagnosis.primary.name, "反酸",
  "疾病名同时声称病因待查且只有反酸症状依据时，必须降为可编码的症状级工作诊断");
assert.equal(refluxDiseasePendingPayload.westernDiagnosis.primary.coding.code, "R12.x00x002");
assert.ok(refluxDiseasePendingPayload.westernDiagnosis.differentials.some((item) => item.name === "胃食管反流病"),
  "降级时必须把胃食管反流病保留到鉴别诊断，不能静默删除疾病方向");

const refluxDeniedRaw = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({
  westernDiagnosis: { primary: { name: "胃食管反流病，病因待查", status: "考虑", supportingFacts: ["否认反酸、烧心"] }, differentials: [] },
})}\n<!-- DIAGNOSIS_JSON_END -->`;
const refluxDeniedPayload = JSON.parse(applyDeterministicIcd10Coding(refluxDeniedRaw)
  .split("<!-- DIAGNOSIS_JSON_START -->")[1]
  .split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.notEqual(refluxDeniedPayload.westernDiagnosis.primary.name, "反酸",
  "否定式反酸不得被确定性层制造成阳性症状诊断");

const uriPendingRaw = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({
  westernDiagnosis: { primary: {
    name: "急性上呼吸道感染，病因待查",
    status: "考虑",
    clinicalRationale: "当前症状支持急性上呼吸道感染，病因待查；尚未取得具体病原学证据。",
  } },
})}\n<!-- DIAGNOSIS_JSON_END -->`;
const uriPendingPayload = JSON.parse(applyDeterministicIcd10Coding(uriPendingRaw)
  .split("<!-- DIAGNOSIS_JSON_START -->")[1]
  .split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(uriPendingPayload.westernDiagnosis.primary.name, "急性上呼吸道感染");
assert.equal(uriPendingPayload.westernDiagnosis.primary.coding.code, "J06.900");
assert.doesNotMatch(uriPendingPayload.westernDiagnosis.primary.clinicalRationale, /病因待查/,
  "规范主诊断后，诊断依据不得继续复述被删除的自相矛盾标签");

console.log(JSON.stringify({ cases: 34, failures: 0 }));
