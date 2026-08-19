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
import { assessConceptionState, assessPregnancyState, assessLactationState } from "../src/lib/clinical-state.ts";

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

// 单纯闭经是“状态待核实”，不是当前妊娠的阳性证据；否则闭经/高泌乳素病例会整类误降级。
for (const text of [
  "停经7个月，B超示子宫内膜5mm，E2偏低、PRL升高",
  "闭经半年，妊娠状态尚未核实",
]) {
  const status = statusOf(assessPregnancyState(text));
  assert.notEqual(status, "positive", `闭经本身不得推断当前妊娠：${text}`);
  assert.notEqual(status, "possible", `无验孕证据的闭经不得升级为可疑妊娠：${text}`);
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
for (const text of [
  "哺乳期",
  "正在哺乳",
  "母乳喂养中",
  "剖宫产术后第4天，双乳柔软，泌乳畅，乳量少，婴儿需添加奶粉喂养",
  "产后5天乳汁量少，正在混合喂养",
]) {
  assert.equal(statusOf(assessLactationState(text)), "positive", `哺乳识别漏判同样放行剂量级处方：${text}`);
}
for (const text of ["已断奶", "未哺乳"]) {
  assert.notEqual(statusOf(assessLactationState(text)), "positive", `不得读成正在哺乳：${text}`);
}

// 甲方 2026-08-18 反流同例：一个「无」统领并列的妊娠/哺乳/备孕三项。
// 旧实现按“最后出现的候选状态获胜”，把末尾「备孕可能」单独读成 possible，直接锁死 M04。
const coordinatedNegative = "已绝经28年，无妊娠、哺乳或备孕可能";
assert.equal(statusOf(assessPregnancyState(coordinatedNegative)), "negative", "并列否定必须覆盖妊娠");
assert.equal(statusOf(assessLactationState(coordinatedNegative)), "negative", "并列否定必须覆盖哺乳");
assert.equal(statusOf(assessConceptionState(coordinatedNegative)), "negative", "并列否定必须覆盖备孕可能，不得被末尾 possible 翻转");

const { evaluateSafetyGate, hardDoseSafetyBoundaryReasons } = await import("../src/lib/diagnosis-safety.ts");
const safetyCase = (age, pastHistory = "") => ({
  id: `pregnancy-screen-${age}`,
  phase: "diagnose",
  patient: { sex: "女", age },
  chiefComplaint: "反酸、嗳气反复1年余",
  symptoms: { presentHistory: "反酸、嗳气，餐后加重" },
  tongue: "舌淡，苔白腻",
  pulse: "脉细缓",
  pastHistory,
  allergyHistory: "否认食物及药物过敏史",
  medicationHistory: "未使用药物",
  conversation: [],
  questionRounds: 1,
  maxQuestionRounds: 1,
});

const elderlyUnknownGate = evaluateSafetyGate(safetyCase(78));
assert.ok(
  !(elderlyUnknownGate.missingItemCodes || []).some((code) => ["pregnancy_unknown", "lactation_unknown", "conception_unknown"].includes(code)),
  `78岁女性不得再追问妊娠/哺乳/备孕：${JSON.stringify(elderlyUnknownGate.missingItems)}`,
);
const youngerUnknownGate = evaluateSafetyGate(safetyCase(38));
assert.ok(
  (youngerUnknownGate.missingItemCodes || []).includes("pregnancy_unknown"),
  "生育年龄女性未记录状态时仍须保持 fail-closed 筛查",
);
const postpartumState = {
  ...safetyCase(32),
  chiefComplaint: "产后乳汁量少4日",
  symptoms: {
    presentHistory: "剖宫产术后第4天，双乳柔软，泌乳畅，乳量少，婴儿需添加奶粉喂养；术中出血约300mL；已输液500mL；血红蛋白122g/L。",
  },
  pastHistory: "",
  allergyHistory: "",
  medicationHistory: "",
};
const postpartumGate = evaluateSafetyGate(postpartumState);
assert.ok(
  !(postpartumGate.missingItemCodes || []).includes("medication_details"),
  `血红蛋白 g/L 化验值不得被当成未写清的药物剂量：${JSON.stringify(postpartumGate.missingItems)}`,
);
assert.ok(
  !(postpartumGate.missingItemCodes || []).includes("lactation_unknown"),
  `产后泌乳事实必须识别为当前哺乳状态：${JSON.stringify(postpartumGate.missingItems)}`,
);
assert.ok(
  hardDoseSafetyBoundaryReasons(postpartumState).some((item) => /哺乳/.test(item)),
  "产后第4天且泌乳中的病例必须保持哺乳期剂量硬边界",
);
assert.deepEqual(
  hardDoseSafetyBoundaryReasons(safetyCase(78, coordinatedNegative)).filter((item) => /妊娠|哺乳|备孕/.test(item)),
  [],
  "78岁且明确并列否定不得形成特殊人群硬边界",
);
assert.ok(
  hardDoseSafetyBoundaryReasons(safetyCase(78, "患者自述已妊娠8周")).some((item) => /妊娠|哺乳|备孕/.test(item)),
  "高龄字段不得覆盖明确阳性妊娠事实",
);

// ─── 妊娠状态必须真的门控到非药物治疗项目 ───
// 识别对了但没人用，等于没识别。此前 tcmTreatmentProjectExclusionReason 的全部禁忌只有
// 婴幼儿湿疹/糖尿病足/活动性炎症/灸法热证/心衰/肾功能异常六项，**妊娠一项没有**——
// 而妊娠禁针（合谷、三阴交、昆仑、至阴等催产活血穴，腰骶与下腹部腧穴）是针灸最基本的禁忌。
// 现改为复用本文件上面验证的确定性状态层，而不是再写第七条正则。
const { tcmTreatmentProjectExclusionReason } = await import("../src/lib/tcm-treatment-capabilities.server.ts");
const priorFixture = {
  overview: { primarySyndrome: "寒湿痹阻", overallPathogenesis: "寒湿阻络" },
  pathogenesis: { chain: [] },
  therapy: { overallPrinciple: "散寒除湿", overallMethod: "温经通络" },
  westernDiagnosis: { primary: { name: "腰肌劳损", status: "考虑" }, differentials: [] },
};
const caseWith = (text) => ({ chiefComplaint: text, symptoms: {}, patient: { sex: "女", age: 28 } });
const INVASIVE_OR_THERMAL = ["acupuncture", "moxibustion", "bloodletting", "thread_embedding", "cupping", "guasha", "needle_knife"];
for (const text of ["患者女，28岁，孕妇，腰痛3天", "怀孕了，最近腰酸", "停经45天，验孕棒两条杠，颈肩痛"]) {
  for (const code of INVASIVE_OR_THERMAL) {
    assert.ok(tcmTreatmentProjectExclusionReason(code, priorFixture, caseWith(text)),
      `妊娠/可疑妊娠必须拦下 ${code}：${text}`);
  }
}
// 非侵入、无穴位刺激的项目不受此条影响——过度阻断会让医生开始无视禁忌提示。
for (const code of ["diet_therapy", "mind_therapy"]) {
  assert.equal(tcmTreatmentProjectExclusionReason(code, priorFixture, caseWith("患者女，28岁，孕妇，腰痛3天")), undefined,
    `${code} 非侵入非热疗，不应因妊娠被拦`);
}
// 未孕对照：不得因补了口语阳性词表而误拦普通患者。
for (const code of INVASIVE_OR_THERMAL) {
  assert.equal(tcmTreatmentProjectExclusionReason(code, priorFixture, caseWith("颈肩痛3天，未孕")), undefined,
    `明确未孕不得被误拦：${code}`);
}

console.log(JSON.stringify({
  pregnancyPositive: MUST_BE_POSITIVE.length,
  cases: MUST_BE_POSITIVE.length + 3 + 5 + 5 + 5 + 21 + 2 + 7,
  failures: 0,
}));
