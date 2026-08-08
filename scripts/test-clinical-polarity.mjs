import assert from "node:assert/strict";
import {
  affirmedAllergyText,
  affirmedClinicalSourceClauses,
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
  ["没吐过血", "negative", undefined],
  ["没有咳过血", "negative", undefined],
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
  ["第二天没精神", "affirmed", "第二天没精神"],
  ["最近没力气", "affirmed", "最近没力气"],
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

// Polarity scope is a per-consumer decision, not one global policy. Recall callers take affirmed
// only; contraindication/audit callers must also receive `uncertain`, because dropping an
// unresolved comorbidity removes the very fact that would have raised a warning. Explicit denials
// must never surface under either scope — that direction would invert into a false positive.
// Hedge phrasings are covered as a class: whether a given cue currently lands in UNCERTAIN_CUE or
// falls through to `affirmed` must not change what a safety-side caller ends up seeing.
const hedgedFindings = [
  "可能有心衰",
  "疑似心功能不全",
  "既往可能有房颤",
  "不排除肾功能不全",
  "不能除外消化道出血",
  "考虑存在肝功能异常",
  "怀疑有胆囊炎",
  "似有肝功能异常",
];
for (const text of hedgedFindings) {
  assert.equal(
    affirmedClinicalText(text, "affirmed_or_uncertain"),
    text,
    `安全侧必须保留未定所见：${text}`,
  );
}

const explicitDenials = ["否认心衰", "未发现肾功能不全", "已排除消化道出血"];
for (const text of explicitDenials) {
  for (const scope of ["affirmed", "affirmed_or_uncertain"]) {
    assert.equal(affirmedClinicalText(text, scope), undefined, `明确否定不得进入任何 scope：${text}/${scope}`);
  }
}

// Default scope stays affirmed-only so recall callers are unchanged by the opt-in.
assert.equal(affirmedClinicalText("可能有心衰"), undefined);
assert.equal(affirmedClinicalText("突发胸痛3小时"), "突发胸痛3小时");
assert.equal(affirmedClinicalText("突发胸痛3小时", "affirmed_or_uncertain"), "突发胸痛3小时");
// A denial adjacent to an unresolved finding must not drag the finding out of the safety scope.
assert.equal(
  affirmedClinicalText("否认心衰。可能有肾功能不全", "affirmed_or_uncertain"),
  "可能有肾功能不全",
);

// 口语否定增补层（polarity-negation-assist.server）的三条安全边界。
// 确定性正则漏判的口语否定实测：胸口不疼 / 早就不疼了 / 哪有什么胸痛 / 胸痛这个倒是没有。
const assistOverlay = new Set(["胸口不疼", "早就不疼了", "哪有什么胸痛", "胸痛这个倒是没有"]);

// 1. 证据类 scope：增补生效，口语否定不再被当作阳性事实。
for (const clause of assistOverlay) {
  assert.ok(affirmedClinicalText(clause), `${clause} 在确定性层仍被判为阳性（这正是增补层存在的原因）`);
  assert.equal(
    affirmedClinicalText(clause, "affirmed", assistOverlay),
    undefined,
    `${clause} 经增补后必须不再作为阳性事实进入检索与依据`,
  );
}

// 2. ★ 风险类 scope 必须完全忽略增补集 ★
// rxaudit 与方剂禁忌用 affirmed_or_uncertain，故意保留未消解表述以免漏警告；
// 在那里补否定 = 少一条警告，方向与证据类恰好相反。
for (const clause of assistOverlay) {
  assert.equal(
    affirmedClinicalText(clause, "affirmed_or_uncertain", assistOverlay),
    affirmedClinicalText(clause, "affirmed_or_uncertain"),
    `${clause} 在风险类 scope 下不得因增补层而被抹掉——那会删掉本该触发的警告`,
  );
}

// 3. 单向性：增补层只能把阳性降为否定，永远不能把否定改成阳性。
assert.equal(
  affirmedClinicalText("否认胸痛", "affirmed", new Set(["否认胸痛"])),
  undefined,
  "增补集不得把确定性层判定的否定改写成阳性",
);

// 4. 阳性对照与「否定形态的症状词」不受影响。
assert.equal(affirmedClinicalText("胸痛", "affirmed", assistOverlay), "胸痛");
for (const symptom of ["没精神", "没力气", "没胃口"]) {
  assert.equal(
    affirmedClinicalText(symptom, "affirmed", assistOverlay),
    symptom,
    `${symptom} 是症状本身而非否认，不得被增补层误删`,
  );
}

// ── 「无X」型阳性体征：**刻意不在极性层改判** ────────────────────────────────
// 我曾在这里加过「查受控词表 → 无汗/无苔/少苔/少气懒言 判 affirmed」，用的是前缀匹配。
// 那是 fail-open，已回退。真实语料（artifacts/ 1531 份）里以这四个词开头的分句 38 条，
// 其中 34 条带后续内容，包含**真否认**：
//     无苔腻、脉滑等痰湿征象      → 被翻成「有痰湿」
//     无苔腻、小便黄赤等湿热征象  → 被翻成「有湿热」
//     无汗出肢冷记录              → 被翻成阳性
// 把「没有湿热征象」读成「有湿热征象」会把辨证推向反方向，比原缺陷（无汗被吞掉）严重得多。
//
// src/lib/clinical-vocabulary.ts 的注释早就写明了这条边界，我当时没找到那份资产：
//   「不在极性层做全局改判——同一字串在症状回顾式否认里是真否定，把患者的否认读成
//     阳性体征比原缺陷更危险……在极性层改判会让错误读法流向全系统的每一条结论。」
// 正确的承接点是**只有排除权**的守卫（affirmativeNegationFormsIn，受治理表 68 条）：
// 守卫唯一的权力是移除候选，不确定时多排除一个方向相反的候选，方向上是安全的。
// 本断言把这条边界钉住：极性层**不得**再把「无X」判成 affirmed。
for (const denial of ["无汗", "无苔", "无苔腻、脉滑等痰湿征象", "无苔黄腻、脉濡数等湿热征象"]) {
  assert.equal(
    clinicalClausePolarity(denial),
    "negative",
    `极性层又把「${denial}」改判成阳性——这条路已实证为 fail-open，缓解措施应放在只有排除权的守卫里`,
  );
}

// 「无」的非否定用法是一个**封闭语法类**（无+虚词），枚举它是安全的，不属于穷举自然语言。
// 「无法完全否认呕血」= 排除不了呕血，原来被判 negative —— 红旗直接被抹掉，
// 这是本轮词表审计里方向最危险的一条。
assert.equal(clinicalClausePolarity("无法完全否认呕血"), "uncertain", "「排除不了」被读成「已否认」——红旗被抹掉");
assert.equal(clinicalClausePolarity("无法否认黑便史"), "uncertain", "同上");
for (const modal of ["无需处理", "无论寒热", "无从判断"]) {
  assert.notEqual(clinicalClausePolarity(modal), "negative", `「${modal}」是情态/连词，不是临床否认`);
}

// 反向必须一条不丢：真否认仍然是 negative，否则这条修复就是把门拆了。
for (const denial of ["否认胸痛", "无胸痛", "无发热", "未见异常", "无高血压病史", "无药物过敏史", "无恶心呕吐"]) {
  assert.equal(clinicalClausePolarity(denial), "negative", `真否认「${denial}」被放行成阳性`);
}

// 转折词：阳性事实不得被前半句的否定吞掉。原来漏了「唯/仅/只是」。
assert.deepEqual(
  affirmedClinicalSourceClauses("未见明显异常，唯血压偏高"),
  ["血压偏高"],
  "「唯」后的阳性事实被前半句否定整条吞掉——静默丢失阳性事实比多报一条危险",
);
assert.deepEqual(affirmedClinicalSourceClauses("否认胸痛，仅诉乏力"), ["诉乏力"], "「仅」后的阳性事实丢失");

console.log(JSON.stringify({
  cases: cases.length + 20 + 16 + temporalCases.length + hedgedFindings.length + explicitDenials.length * 2 + 4,
  failures: 0,
}));
