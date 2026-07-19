import assert from "node:assert/strict";
import {
  affirmedAllergyText,
  affirmedClinicalText,
  affirmedCurrentMedicationText,
  clinicalClausePolarity,
  clinicalEventTemporalScopeAt,
} from "../src/lib/clinical-polarity.ts";

const cases = [
  ["否认肝肾功能不全", "negative", undefined],
  ["患者：未发现明确肾功能异常", "negative", undefined],
  ["肾功能不全已排除", "negative", undefined],
  ["无高血压、糖尿病等慢性病史", "negative", undefined],
  ["无药物过敏", "negative", undefined],
  ["无特殊用药", "negative", undefined],
  ["没吃其他药", "negative", undefined],
  ["未服用阿司匹林", "negative", undefined],
  ["既往无高血压病史", "negative", undefined],
  ["既往未患高血压", "negative", undefined],
  ["高血压病史：无", "negative", undefined],
  ["药物过敏：无", "negative", undefined],
  ["当前用药：无", "negative", undefined],
  ["不是黑便，也没有吐血", "negative", undefined],
  ["并非胸痛，是胃脘胀满", "negative", "是胃脘胀满"],
  ["不曾晕厥", "negative", undefined],
  ["肾功能异常待排除", "uncertain", undefined],
  ["既往病史不详", "uncertain", undefined],
  ["无菌性脑膜炎病史", "affirmed", "无菌性脑膜炎病史"],
  ["高血压10年", "affirmed", "高血压10年"],
];

for (const [input, polarity, affirmed] of cases) {
  assert.equal(clinicalClausePolarity(input), polarity, input);
  assert.equal(affirmedClinicalText(input), affirmed, input);
}

assert.equal(affirmedClinicalText("高血压10年；否认糖尿病；肾功能异常待排"), "高血压10年");
assert.equal(affirmedClinicalText("否认高血压，但既往确诊糖尿病"), "既往确诊糖尿病");
assert.equal(affirmedClinicalText("否认药物过敏，现服阿司匹林100mg每日一次"), "现服阿司匹林100mg每日一次");
assert.equal(affirmedClinicalText("对青霉素过敏；否认其他药物过敏"), "对青霉素过敏");
assert.equal(affirmedClinicalText("未服用阿司匹林，但目前服用氯吡格雷75mg每日一次"), "目前服用氯吡格雷75mg每日一次");
assert.equal(affirmedClinicalText("无药物过敏，今日服用布洛芬一次"), "今日服用布洛芬一次");
assert.equal(affirmedClinicalText("无药物过敏、现服华法林3mg每日一次"), "现服华法林3mg每日一次");
assert.equal(affirmedClinicalText("否认高血压、糖尿病、冠心病"), undefined);
assert.equal(affirmedCurrentMedicationText("未服用华法林，3日前开始服用阿司匹林100mg每日一次"), "3日前开始服用阿司匹林100mg每日一次");
assert.equal(affirmedCurrentMedicationText("既往服用华法林，3月前已停用"), undefined);
assert.equal(affirmedCurrentMedicationText("否认阿司匹林、华法林，氯吡格雷75mg每日一次"), "氯吡格雷75mg每日一次");
assert.equal(affirmedAllergyText("否认青霉素、头孢，磺胺过敏"), "磺胺过敏");
assert.equal(affirmedCurrentMedicationText("既往服用华法林，已停药，今日新启用阿司匹林100mg每日一次"), "新启用阿司匹林100mg每日一次");
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
  assert.equal(affirmedCurrentMedicationText(historyOnly), undefined, historyOnly);
}
for (const restartedStatement of [
  "停用阿司匹林后再服用阿司匹林100mg每日一次",
  "停用阿司匹林后又开始服用阿司匹林100mg每日一次",
  "停用阿司匹林后重新开始服用阿司匹林100mg每日一次",
  "停用阿司匹林后恢复口服阿司匹林100mg每日一次",
]) {
  assert.match(affirmedCurrentMedicationText(restartedStatement) || "", /阿司匹林100mg每日一次/, restartedStatement);
}
assert.equal(affirmedCurrentMedicationText("目前服用阿司匹林和氯吡格雷，后者已停用"), "目前服用阿司匹林");
assert.equal(affirmedCurrentMedicationText("阿司匹林和氯吡格雷，均未停用"), "阿司匹林；氯吡格雷");
assert.equal(affirmedCurrentMedicationText("当前用药包括阿司匹林、氯吡格雷"), "当前用药包括阿司匹林；氯吡格雷");
assert.equal(affirmedCurrentMedicationText("二甲双胍与缬沙坦目前都在服用"), "二甲双胍；缬沙坦目前都在服用");
for (const historyOnly of ["在2022年短期服用华法林3mg每日一次", "二十余年前服用华法林", "十来年前吃过华法林", "大学期间服用华法林", "青年时期服用华法林", "上世纪服用华法林"]) {
  assert.equal(affirmedCurrentMedicationText(historyOnly), undefined, historyOnly);
}
for (const restartedStatement of ["停用阿司匹林后复服阿司匹林100mg每日一次", "停用阿司匹林后恢复吃阿司匹林100mg每日一次", "停用阿司匹林后改回服用阿司匹林100mg每日一次"]) {
  assert.match(affirmedCurrentMedicationText(restartedStatement) || "", /阿司匹林100mg每日一次/, restartedStatement);
}
assert.equal(affirmedCurrentMedicationText("目前服用阿司匹林100mg每日一次，现已停止"), undefined);
assert.equal(affirmedCurrentMedicationText("目前服用阿司匹林和氯吡格雷。前者已停用"), "氯吡格雷");
assert.equal(affirmedCurrentMedicationText("目前服用阿司匹林和氯吡格雷。两者均已停用"), undefined);
assert.equal(affirmedCurrentMedicationText("药物包括阿司匹林、氯吡格雷"), "药物包括阿司匹林；氯吡格雷");
assert.equal(affirmedCurrentMedicationText("当前用药包括二甲双胍500mg每日两次、二甲双胍格列本脲1片每日一次"), "当前用药包括二甲双胍500mg每日两次；二甲双胍格列本脲1片每日一次");
assert.equal(affirmedCurrentMedicationText("当前服用阿司匹林一百毫克每日一次"), "当前服用阿司匹林一百毫克每日一次");
assert.equal(affirmedCurrentMedicationText("华法林3mg每日一次，迄今没有停过"), "华法林3mg每日一次");
assert.equal(affirmedCurrentMedicationText("目前服用阿司匹林100mg，早晚各一次"), "目前服用阿司匹林100mg，早晚各一次");
assert.equal(affirmedCurrentMedicationText("已停阿司匹林，今日重新服用阿司匹林100mg每日一次"), "重新服用阿司匹林100mg每日一次");
assert.equal(affirmedCurrentMedicationText("已停阿司匹林，现再次服用阿司匹林100mg每日一次"), "现再次服用阿司匹林100mg每日一次");
assert.equal(affirmedCurrentMedicationText("不建议停用阿司匹林100mg每日一次"), "仍在服用阿司匹林100mg每日一次");
for (const activeStatement of ["不推荐停用", "没有必要停用", "不应贸然停用"]) {
  assert.equal(affirmedCurrentMedicationText(`${activeStatement}阿司匹林100mg每日一次`), "仍在服用阿司匹林100mg每日一次");
}
for (const activeStatement of ["建议不要停用", "不应轻易停用", "没有必要马上停用", "医生不推荐停用"]) {
  assert.equal(affirmedCurrentMedicationText(`${activeStatement}阿司匹林100mg每日一次`), "仍在服用阿司匹林100mg每日一次");
}
assert.equal(affirmedCurrentMedicationText("3年前开始服用华法林3mg每日一次，至今未停用"), "3年前开始服用华法林3mg每日一次");
assert.equal(affirmedCurrentMedicationText("从2023年开始服用华法林3mg每日一次，至今未停用"), "从2023年开始服用华法林3mg每日一次");
assert.equal(affirmedCurrentMedicationText("阿司匹林停药后再次启用阿司匹林100mg每日一次"), "再次启用阿司匹林100mg每日一次");
assert.equal(affirmedCurrentMedicationText("停用阿司匹林后重新启用阿司匹林100mg每日一次"), "重新启用阿司匹林100mg每日一次");
assert.equal(affirmedCurrentMedicationText("3年前开始服用华法林3mg每日一次，一直没有停用"), "3年前开始服用华法林3mg每日一次");
assert.equal(affirmedCurrentMedicationText("华法林3mg每日一次，一直服用至今"), "华法林3mg每日一次");
assert.equal(clinicalClausePolarity("不是很重的腹痛"), "affirmed");
assert.equal(affirmedClinicalText("腹痛不是很重"), "腹痛不是很重");
assert.equal(affirmedClinicalText("否认胸痛，今晨突发气促"), "今晨突发气促");
assert.equal(
  affirmedClinicalText("无发热、咳嗽、消瘦或心悸，盗汗以入睡后为主，醒后可缓解"),
  "盗汗以入睡后为主,醒后可缓解",
  "an explicit positive pattern after a comma-scoped negative list starts a new affirmed clause",
);
assert.equal(affirmedClinicalText("并非胸痛，是胃脘胀满"), "是胃脘胀满");
assert.equal(affirmedClinicalText("否认胸痛，腹痛不是很重"), "腹痛不是很重");
assert.equal(affirmedClinicalText("并非胸痛，腹痛持续两天"), "腹痛持续两天");
assert.equal(affirmedClinicalText("否认胸痛，腹痛"), undefined);
assert.equal(affirmedClinicalText("否认胸痛，腹痛反复两日"), "腹痛反复两日");
assert.equal(affirmedClinicalText("并非胸痛，今日有腹痛"), "今日有腹痛");
assert.equal(affirmedClinicalText("否认胸痛，腹痛不是特别严重"), "腹痛不是特别严重");
assert.equal(affirmedClinicalText("否认胸痛，腹痛，气促"), undefined);

const temporalCases = [
  {
    text: "上周胸痛去急诊查过，之后已经完全缓解；今天只是复诊，目前无胸痛气促",
    index: (text) => text.indexOf("胸痛"),
    expected: "historical_resolved",
  },
  {
    text: "今天只是复诊，目前无胸痛气促；上周曾因胸痛去急诊，之后已经完全缓解",
    index: (text) => text.lastIndexOf("胸痛"),
    expected: "historical_resolved",
  },
  {
    text: "上周心电图正常、肌钙蛋白阴性；今天突发胸痛",
    index: (text) => text.indexOf("胸痛"),
    expected: "current",
  },
  {
    text: "今天突发胸痛；上周心电图正常、肌钙蛋白阴性",
    index: (text) => text.indexOf("胸痛"),
    expected: "current",
  },
  {
    text: "胸痛发生在上周，之后已完全消失",
    index: (text) => text.indexOf("胸痛"),
    expected: "historical_resolved",
  },
];

for (const temporalCase of temporalCases) {
  assert.equal(
    clinicalEventTemporalScopeAt(temporalCase.text, temporalCase.index(temporalCase.text), "胸痛".length),
    temporalCase.expected,
    temporalCase.text,
  );
}

console.log(JSON.stringify({ cases: cases.length + 20 + temporalCases.length, failures: 0 }));
