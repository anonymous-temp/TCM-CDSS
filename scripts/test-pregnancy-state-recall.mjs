// 妊娠/哺乳状态识别的召回底线。
//
// 为什么单独立一条套件：assessPregnancyState 的结果经 hasPositivePregnancyOrLactationRisk
// 直接门控**剂量级处方**（diagnosis-safety.ts:3133 命中即锁"剂量级候选处方前需补齐或复核"）。
// 判不出来不是少个标签，是孕妇直接拿到剂量级处方。
//
// 原实现只认书面正式写法（已妊娠/妊娠中/孕N周/HCG阳性…），实测门诊病历里最常见的
// 「患者女，28岁，孕妇，感冒3天」「怀孕了，最近咳得厉害」「妊娠期」「有身孕」**全部判 unknown**。
// 这就是"几个关键词冒充覆盖"最危险的一种形态：冒充的是替换语义的身份判定，且失败方向是放行。
//
// 本套件双向钉：既要认出口语写法（漏 = 危险），也不许把备孕/不孕/避孕/孕前/否认妊娠
// 读成当前妊娠（误 = 无谓降级，且会侵蚀医生对系统的信任）。
import assert from "node:assert/strict";
import { assessPregnancyState, assessLactationState } from "../src/lib/clinical-state.ts";

const statusOf = (result) => (typeof result === "string" ? result : result?.status);

// 必须识别为当前妊娠——漏掉任何一条都意味着孕妇可能拿到剂量级处方。
const MUST_BE_POSITIVE = [
  "患者女，28岁，孕妇，感冒3天",
  "怀孕了，最近咳得厉害",
  "妊娠期",
  "现在怀着孩子",
  "有身孕",
  "身怀六甲",
  "宫内早孕",
  "孕期恶心呕吐明显",
  "已妊娠",
  "妊娠中",
  "孕12周",
  "孕早期",
  "HCG阳性",
];
for (const text of MUST_BE_POSITIVE) {
  assert.equal(statusOf(assessPregnancyState(text)), "positive",
    `妊娠识别漏判会让孕妇直接拿到剂量级处方：${text}`);
}

// 可疑也必须落闸（hasPositivePregnancyOrLactationRisk 取 positive|possible）。
for (const text of ["停经45天，验孕棒两条杠", "疑似妊娠", "不能排除怀孕"]) {
  assert.equal(statusOf(assessPregnancyState(text)), "possible", `可疑妊娠必须落闸：${text}`);
}

// 明确否认必须是 negative——不得因为补了口语阳性写法而把否认盖过去。
for (const text of ["未孕", "未怀孕", "否认妊娠", "HCG阴性", "妊娠试验阴性"]) {
  assert.equal(statusOf(assessPregnancyState(text)), "negative", `明确否认不得被阳性词表盖过：${text}`);
}

// 这些都**不是**当前妊娠。误判为 positive 会造成无谓降级，医生会开始无视降级提示。
for (const text of ["备孕中", "不孕症3年", "长期避孕", "孕前检查正常", "妊娠期高血压用药禁忌咨询"]) {
  const status = statusOf(assessPregnancyState(text));
  assert.notEqual(status, "positive", `不得读成当前妊娠：${text}（实得 ${status}）`);
  assert.notEqual(status, "possible", `不得读成可疑妊娠：${text}（实得 ${status}）`);
}

// 哺乳同为剂量门控输入，同样不能只认书面语。
for (const text of ["哺乳期", "正在哺乳", "母乳喂养中"]) {
  assert.equal(statusOf(assessLactationState(text)), "positive", `哺乳识别漏判同样放行剂量级处方：${text}`);
}
for (const text of ["已断奶", "未哺乳"]) {
  assert.notEqual(statusOf(assessLactationState(text)), "positive", `不得读成正在哺乳：${text}`);
}

console.log(JSON.stringify({
  pregnancyPositive: MUST_BE_POSITIVE.length,
  cases: MUST_BE_POSITIVE.length + 3 + 5 + 5 + 5,
  failures: 0,
}));
