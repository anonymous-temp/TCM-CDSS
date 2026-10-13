import assert from "node:assert/strict";
import { createJiti } from "jiti";

// 接口调用方的真实传参形状（2026-10-13 从生产留存请求核对，甲方两个诊所编号全部如此）：
//   · 整份病历在 symptoms 的中文键下（现病史/既往史/过敏史/个人史/家族史/婚育史/辅助检查）；
//   · 追问作答 = conversation 里一条 assistant（题干）+ 一条 user（所选选项原文）；
//   · 追问跳过 = conversation 里只有一条 user，内容是「本次未能确认，请继续现场评估」；
//   · 后续调用不回传 questionRounds / questionOutcome / phase。
// 此前闸门把「conversation 里有 user 消息」当成「病历在对话里」，symptoms 整体出局：追问有一条回答或一次跳过后，
// 现病史写明的呕血黑便不报红旗、孕 28 周和华法林照常给带剂量处方、性别/舌/脉/过敏史全变未提供（生产验证）。
// 既有套件的夹具全是页面形状（hisRecord，或 presentHistory + 空 conversation），这一类从未被测到。
//
// 每个风险 × 四种传参（无追问 / 跳过 / 一题作答 / 两题作答）必须给出同一个闸门结论。

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": "/dev/null" } });
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const {
  deriveOperationalCompleteness,
  derivePrescriptionPermission,
  evaluateSafetyGate,
  trustedInputText,
} = await jiti.import("../src/lib/diagnosis-safety.ts");
const {
  FOLLOWUP_SKIP_SENTENCE,
  POSSIBLE_RISK_QUESTIONS,
  confirmedRiskScreeningCategories,
  followupConversationView,
  isFollowupSkipMessage,
} = await jiti.import("../src/lib/followup-conversation.ts");

const neutralAnswer = [
  { role: "assistant", content: "本次起病以来，恶寒与发热的关系及口渴、汗出情况是哪一种？" },
  { role: "user", content: "起病以来恶寒重、发热轻，无汗，口不渴" },
];
const secondAnswer = [
  { role: "assistant", content: "近期大便情况是哪一种？" },
  { role: "user", content: "大便成形，每日一次" },
];
const SHAPES = {
  "无追问": [],
  "跳过": [{ role: "user", content: FOLLOWUP_SKIP_SENTENCE }],
  "一题作答": neutralAnswer,
  "两题作答": [...neutralAnswer, ...secondAnswer],
};

function customerCase(overrides, conversation) {
  const raw = {
    id: `shape-${Math.random().toString(36).slice(2, 8)}`,
    chiefComplaint: "上腹不适3天",
    patient: { sex: "男", age: 56 },
    symptoms: {
      现病史: "患者3天前进食油腻后出现上腹胀满不适，无恶心呕吐，纳差，二便调。",
      既往史: "既往体健，否认慢性疾病",
      过敏史: "否认药物过敏史，否认食物过敏史",
      个人史: "无烟酒等不良嗜好",
      家族史: "否认家族遗传病史",
      婚育史: "已婚",
      辅助检查: "无",
    },
    tongue: "舌淡红，苔薄白",
    pulse: "脉弦",
    vitals: { T: "36.6", P: "78", R: "18", BP: "126/78" },
    tcmLineagePreference: "unrestricted",
    ...overrides,
    conversation,
  };
  if (overrides.symptoms) raw.symptoms = { ...overrides.symptoms };
  const state = normalizeCaseStateInput(raw);
  assert.ok(state, "甲方形状的请求必须能被归一");
  return state;
}

const baseSymptoms = {
  既往史: "既往体健，否认慢性疾病",
  过敏史: "否认药物过敏史，否认食物过敏史",
  个人史: "无烟酒等不良嗜好",
  婚育史: "已婚",
  辅助检查: "无",
};

// ---------------------------------------------------------------------------------------------
// 1. 急危重红旗：写在现病史里，四种传参都必须报，且红旗集合相同
// ---------------------------------------------------------------------------------------------
const RED_FLAG_PROBES = [
  { name: "上消化道出血", chiefComplaint: "上腹不适3天", symptoms: { ...baseSymptoms, 现病史: "患者今晨呕吐咖啡样物约200ml，解柏油样黑便2次，伴头晕、心慌。" } },
  { name: "卒中", chiefComplaint: "头晕1天", symptoms: { ...baseSymptoms, 现病史: "患者今晨起床后突然出现右侧肢体无力，言语不清，口角歪斜，持续不缓解。" } },
  { name: "胸痛伴大汗", chiefComplaint: "胸痛2小时", symptoms: { ...baseSymptoms, 现病史: "患者2小时前突发胸骨后压榨样疼痛，向左肩臂放射，伴大汗淋漓、气促，持续不缓解。" } },
];
for (const probe of RED_FLAG_PROBES) {
  const expected = evaluateSafetyGate(customerCase(probe, SHAPES["无追问"]));
  assert.equal(expected.status, "red_flag", `${probe.name}：无追问时就应报红旗（夹具前提）`);
  for (const [shape, conversation] of Object.entries(SHAPES)) {
    const state = customerCase(probe, conversation);
    const gate = evaluateSafetyGate(state);
    assert.equal(gate.status, "red_flag", `${probe.name} × ${shape}：现病史里的急危重表现必须报红旗`);
    assert.deepEqual([...gate.redFlags].sort(), [...expected.redFlags].sort(), `${probe.name} × ${shape}：红旗集合应与无追问时相同`);
    assert.equal(derivePrescriptionPermission(state).candidateMode, "non_dose_only", `${probe.name} × ${shape}：红旗未解除不得给剂量`);
  }
}

// ---------------------------------------------------------------------------------------------
// 2. 独立硬边界：妊娠、哺乳、抗凝——写在现病史/婚育史/既往史里，四种传参都不得给剂量
// ---------------------------------------------------------------------------------------------
const BOUNDARY_PROBES = [
  { name: "妊娠（现病史）", chiefComplaint: "咳嗽3天", patient: { sex: "女", age: 29 }, symptoms: { ...baseSymptoms, 现病史: "患者孕28周，3天前受凉后咳嗽，咳白痰，无发热。" } },
  { name: "妊娠（婚育史）", chiefComplaint: "咳嗽3天", patient: { sex: "女", age: 29 }, symptoms: { ...baseSymptoms, 现病史: "3天前受凉后咳嗽，咳白痰，无发热。", 婚育史: "已婚，目前妊娠20周" } },
  { name: "哺乳", chiefComplaint: "乳房胀痛2天", patient: { sex: "女", age: 30 }, symptoms: { ...baseSymptoms, 现病史: "患者产后3个月，目前哺乳期，2天前出现左侧乳房胀痛。" } },
  { name: "抗凝（既往史）", chiefComplaint: "腰痛1周", patient: { sex: "男", age: 66 }, symptoms: { ...baseSymptoms, 现病史: "1周前劳累后出现腰部酸痛，活动后加重，休息可缓解，无下肢麻木。", 既往史: "房颤病史5年，长期口服华法林" } },
];
for (const probe of BOUNDARY_PROBES) {
  for (const [shape, conversation] of Object.entries(SHAPES)) {
    const state = customerCase(probe, conversation);
    const permission = derivePrescriptionPermission(state);
    assert.equal(permission.candidateMode, "non_dose_only", `${probe.name} × ${shape}：不得给出带剂量处方（实际 ${permission.candidateMode}）`);
  }
}

// ---------------------------------------------------------------------------------------------
// 3. 对照：普通病历在四种传参下结论一致，且病历里写了的字段不被判成未提供
// ---------------------------------------------------------------------------------------------
{
  const control = { chiefComplaint: "恶寒发热、鼻塞流涕2天", patient: { sex: "女", age: 24 }, symptoms: { ...baseSymptoms, 现病史: "患者2天前淋雨后出现恶寒发热，恶寒重、发热轻，自测体温37.5℃，伴鼻塞、流清涕，稍有咳嗽，无汗，无胸闷胸痛。", 婚育史: "未婚，否认妊娠，未哺乳，无备孕计划", 用药史: "否认当前用药" } };
  const reference = customerCase(control, SHAPES["无追问"]);
  const referenceGate = evaluateSafetyGate(reference);
  assert.notEqual(referenceGate.status, "red_flag", "普通感冒不应报红旗");
  for (const code of ["sex_unknown", "allergy_unknown", "medication_unknown", "tongue_unknown", "pulse_unknown"]) {
    assert.ok(!referenceGate.missingItemCodes.includes(code), `病历已写明的字段不应进入待补项：${code}`);
  }
  const referenceCompleteness = deriveOperationalCompleteness(reference);
  assert.equal(referenceCompleteness.level, "C", "现病史、舌脉、体征、既往与过敏史齐全的病历完整度应为 C");
  for (const [shape, conversation] of Object.entries(SHAPES)) {
    const state = customerCase(control, conversation);
    const gate = evaluateSafetyGate(state);
    assert.equal(gate.status, referenceGate.status, `对照 × ${shape}：闸门状态应与无追问时相同`);
    assert.deepEqual([...gate.missingItemCodes].sort(), [...referenceGate.missingItemCodes].sort(), `对照 × ${shape}：待补项应与无追问时相同`);
    assert.equal(deriveOperationalCompleteness(state).level, "C", `对照 × ${shape}：完整度不应因追问而下降`);
    assert.equal(derivePrescriptionPermission(state).candidateMode, derivePrescriptionPermission(reference).candidateMode, `对照 × ${shape}：剂量授权应与无追问时相同`);
  }
  // 同一份病历用规范键（presentHistory + 顶层病史字段）传入，结论相同：中文键只是另一种写法。
  const canonical = normalizeCaseStateInput({
    id: "shape-canonical", chiefComplaint: control.chiefComplaint, patient: control.patient,
    symptoms: { presentHistory: control.symptoms.现病史, 个人史: control.symptoms.个人史, 婚育史: control.symptoms.婚育史, exams: "无" },
    pastHistory: control.symptoms.既往史, allergyHistory: control.symptoms.过敏史, medicationHistory: control.symptoms.用药史,
    tongue: "舌淡红，苔薄白", pulse: "脉弦", vitals: { T: "36.6", P: "78", R: "18", BP: "126/78" }, conversation: [],
  });
  assert.equal(evaluateSafetyGate(canonical).status, referenceGate.status);
  assert.deepEqual([...evaluateSafetyGate(canonical).missingItemCodes].sort(), [...referenceGate.missingItemCodes].sort(), "中文键与规范键的待补项应相同");
  assert.equal(reference.symptoms.presentHistory, control.symptoms.现病史, "现病史应归到 presentHistory");
  assert.equal(reference.symptoms.现病史, undefined, "归位后不保留重复的中文键");
  assert.equal(reference.pastHistory, control.symptoms.既往史);
  assert.equal(reference.allergyHistory, control.symptoms.过敏史);
  assert.equal(reference.medicationHistory, control.symptoms.用药史);
  assert.equal(reference.symptoms.exams, "无");
  assert.equal(reference.symptoms.个人史, control.symptoms.个人史, "没有规范槽位的键原样保留");
}

// 顶层与 symptoms 各写了一份且不同：两份都保留，不互相覆盖。
{
  const state = normalizeCaseStateInput({
    id: "shape-both", chiefComplaint: "腰痛1周", patient: { sex: "男", age: 66 },
    symptoms: { 现病史: "1周前劳累后出现腰部酸痛。", 既往史: "房颤病史5年，长期口服华法林" },
    pastHistory: "高血压病史10年", conversation: [],
  });
  assert.equal(state.pastHistory, "高血压病史10年");
  assert.equal(state.symptoms.既往史, "房颤病史5年，长期口服华法林");
  assert.equal(derivePrescriptionPermission(state).candidateMode, "non_dose_only", "留在 symptoms 里的那份既往史仍要进闸门");
}

// ---------------------------------------------------------------------------------------------
// 4. 跳过句不是病历内容
// ---------------------------------------------------------------------------------------------
{
  assert.ok(isFollowupSkipMessage(FOLLOWUP_SKIP_SENTENCE));
  assert.ok(isFollowupSkipMessage(" 本次未能确认，请继续现场评估。 "));
  assert.ok(!isFollowupSkipMessage("本次未能确认是否黑便"), "带内容的回答不是跳过");
  assert.ok(!isFollowupSkipMessage("无"));
  const state = customerCase({}, SHAPES["跳过"]);
  assert.deepEqual(state.conversation, [], "跳过句在入口剔除");
  assert.equal(state.questionOutcome, "skipped");
  assert.equal(state.questionRounds, 1, "跳过也是已经问过一轮");
  assert.ok(!trustedInputText(state).includes("本次未能确认"), "跳过句不得进入安全与接地语料");
  // 题干 + 跳过：没人回答的那道题一并剔除，题干里的急症词不能留在对话里。
  const asked = customerCase({}, [
    { role: "assistant", content: POSSIBLE_RISK_QUESTIONS.cardiac.question },
    { role: "user", content: FOLLOWUP_SKIP_SENTENCE },
  ]);
  assert.deepEqual(asked.conversation, []);
  assert.equal(asked.questionOutcome, "skipped");
  const answered = customerCase({}, SHAPES["一题作答"]);
  assert.equal(answered.questionOutcome, "answered");
  assert.equal(answered.questionRounds, 1);
  assert.equal(customerCase({}, []).questionOutcome, undefined);
  assert.equal(customerCase({}, []).questionRounds, 0);
  // 调用方自己回传了轮次与结果时，以调用方为准。
  const explicit = normalizeCaseStateInput({ id: "x", chiefComplaint: "咳嗽", symptoms: {}, conversation: SHAPES["一题作答"], questionRounds: 0, questionOutcome: "not_needed" });
  assert.equal(explicit.questionRounds, 0);
  assert.equal(explicit.questionOutcome, "not_needed");
}

// ---------------------------------------------------------------------------------------------
// 5. 急症筛查题：题干不是病历，阳性选项连同题干才算阳性
// ---------------------------------------------------------------------------------------------
{
  const record = { chiefComplaint: "腹痛伴恶心3天", symptoms: { ...baseSymptoms, 现病史: "患者3天前无明显诱因出现脐周隐痛，伴恶心，无呕吐，二便调。" } };
  const risk = POSSIBLE_RISK_QUESTIONS.acute_abdomen;
  const positive = customerCase(record, [{ role: "assistant", content: risk.question }, { role: "user", content: risk.positive }]);
  assert.deepEqual(confirmedRiskScreeningCategories(positive.conversation).map((item) => item.category), ["acute_abdomen"]);
  const positiveGate = evaluateSafetyGate(positive);
  assert.equal(positiveGate.status, "red_flag", "医生对急腹症筛查题选了「存在上述任一情况」，必须按阳性处理");
  assert.equal(derivePrescriptionPermission(positive).candidateMode, "non_dose_only");
  const negative = customerCase(record, [{ role: "assistant", content: risk.question }, { role: "user", content: risk.negative }]);
  assert.deepEqual(confirmedRiskScreeningCategories(negative.conversation), []);
  assert.notEqual(evaluateSafetyGate(negative).status, "red_flag", "阴性选项不报红旗；题干里的「反跳痛、腹部僵硬」不是病历内容");
  // 每一类筛查题的题干都不得因为出现在对话里而自己触发红旗。
  for (const [category, item] of Object.entries(POSSIBLE_RISK_QUESTIONS)) {
    const mild = { chiefComplaint: "纳差1周", symptoms: { ...baseSymptoms, 现病史: "患者1周来食欲欠佳，餐后稍胀，无恶心呕吐，二便调。" } };
    const withNegative = customerCase(mild, [{ role: "assistant", content: item.question }, { role: "user", content: item.negative }]);
    assert.notEqual(evaluateSafetyGate(withNegative).status, "red_flag", `${category}：题干 + 阴性选项不应报红旗`);
    const withPositive = customerCase(mild, [{ role: "assistant", content: item.question }, { role: "user", content: item.positive }]);
    assert.equal(evaluateSafetyGate(withPositive).status, "red_flag", `${category}：题干 + 阳性选项必须报红旗`);
  }
  // 阳性选项离开题干（或跟在别的题后面）不构成确认。
  const orphan = customerCase(record, [{ role: "user", content: risk.positive }]);
  assert.deepEqual(confirmedRiskScreeningCategories(orphan.conversation), []);
  const view = followupConversationView(positive.conversation);
  assert.equal(view.answers.length, 1);
  assert.deepEqual(view.primaryNarrative, []);
}

// ---------------------------------------------------------------------------------------------
// 6. 生命体征的序列化残留按未提供处理
// ---------------------------------------------------------------------------------------------
{
  const state = customerCase({ vitals: { T: { ValueKind: 3 }, P: { ValueKind: 3 }, R: { ValueKind: 3 }, BP: { ValueKind: 3 } } }, []);
  assert.deepEqual(state.vitals, {}, "对象形态的体征值不进入病例");
  assert.ok(!/生命体征：3/.test(trustedInputText(state)), "ValueKind 的数字不得冒充体征");
  const mixed = customerCase({ vitals: { T: "39.2", P: { ValueKind: 3 }, BP: "118/76" } }, []);
  assert.deepEqual(mixed.vitals, { T: "39.2", BP: "118/76" });
}

// ---------------------------------------------------------------------------------------------
// 7. 旧式对话调用方不变：对话里有主叙述时，symptoms 仍按「可能是模型整理的二手内容」处理
// ---------------------------------------------------------------------------------------------
{
  const chat = normalizeCaseStateInput({
    id: "shape-chat", chiefComplaint: "头晕",
    symptoms: { pain: "胸痛伴大汗、向左肩放射" },
    conversation: [{ role: "user", content: "我这两天头晕，否认胸痛，没有出汗，也不恶心" }],
  });
  assert.ok(!trustedInputText(chat).includes("胸痛伴大汗"), "主叙述在对话里时，symptoms 不进安全语料");
  assert.notEqual(evaluateSafetyGate(chat).status, "red_flag");
  // 主叙述 + 之后的追问作答：仍以主叙述为准，作答并入。
  const chatAnswered = normalizeCaseStateInput({
    id: "shape-chat2", chiefComplaint: "头晕",
    symptoms: { pain: "胸痛伴大汗、向左肩放射" },
    conversation: [
      { role: "user", content: "我这两天头晕，否认胸痛，没有出汗，也不恶心" },
      { role: "assistant", content: "头晕与体位变化有关吗？" },
      { role: "user", content: "起床时明显，躺下缓解" },
    ],
  });
  const text = trustedInputText(chatAnswered);
  assert.ok(!text.includes("胸痛伴大汗"));
  assert.ok(text.includes("起床时明显，躺下缓解"));
  assert.ok(!text.includes("头晕与体位变化有关吗"), "题干不进入安全语料");
}

// ---------------------------------------------------------------------------------------------
// 8. 跳过追问的请求与「出题时预先计算」的请求是同一个结果指纹
// ---------------------------------------------------------------------------------------------
{
  const { stageRequestFingerprint } = await jiti.import("../src/lib/stage-result-coalescing.server.ts");
  const { noAnswerCaseState } = await jiti.import("../src/lib/no-answer-precompute.server.ts");
  const tenant = { clientId: "client", customerId: "00000239" };
  const record = {
    id: "visit-1", chiefComplaint: "恶寒发热、鼻塞流涕2天", patient: { sex: "女", age: 24 },
    symptoms: { 现病史: "2天前淋雨后恶寒发热，无汗，鼻塞流清涕。", 既往史: "既往体健", 过敏史: "否认药物过敏史" },
    tcmLineagePreference: "unrestricted",
  };
  // 甲方的追问请求（带 phase/questionRounds）→ 服务端据此组出的预先计算请求
  const questionState = normalizeCaseStateInput({ ...record, phase: "question", questionRounds: 0 });
  const precomputed = normalizeCaseStateInput(noAnswerCaseState(questionState));
  // 甲方跳过后发来的辨证请求
  const skipped = normalizeCaseStateInput({ ...record, conversation: [{ role: "user", content: FOLLOWUP_SKIP_SENTENCE }] });
  const fingerprint = (state) => stageRequestFingerprint("diagnose", tenant, state);
  assert.equal(fingerprint(precomputed), fingerprint(skipped), "预先算好的结果必须能被跳过后的请求复用");
  // 不追问直接辨证、换病例编号、只差标点与空格：也是同一份病历
  assert.equal(fingerprint(normalizeCaseStateInput({ ...record, conversation: [] })), fingerprint(skipped));
  assert.equal(fingerprint(normalizeCaseStateInput({ ...record, id: "visit-2" })), fingerprint(skipped), "病例编号不进指纹");
  assert.equal(
    fingerprint(normalizeCaseStateInput({ ...record, symptoms: { ...record.symptoms, 现病史: "2天前淋雨后恶寒发热,无汗, 鼻塞流清涕。。" } })),
    fingerprint(skipped),
    "只差标点写法与空格的病历是同一份病历",
  );
  // 作答、病历内容不同、租户不同：不是同一份
  assert.notEqual(fingerprint(customerCase({ ...record }, SHAPES["一题作答"])), fingerprint(skipped), "有追问作答的病历不复用未作答的结果");
  assert.notEqual(
    fingerprint(normalizeCaseStateInput({ ...record, symptoms: { ...record.symptoms, 现病史: "2天前淋雨后发热，有汗，咽痛。" } })),
    fingerprint(skipped),
  );
  assert.notEqual(stageRequestFingerprint("diagnose", { ...tenant, customerId: "90000405" }, skipped), fingerprint(skipped), "不同诊所不共用结果");
  assert.notEqual(
    fingerprint(normalizeCaseStateInput({ ...record, symptoms: { ...record.symptoms, 现病史: "2天前淋雨后恶寒，发热无汗，鼻塞流清涕。" } })),
    fingerprint(skipped),
    "标点位置改变了意思的不是同一份病历",
  );
  // 代码版本变了，旧结果不再回放
  const currentBuild = fingerprint(skipped);
  const previousDigest = process.env.CDSS_BUILD_SOURCE_DIGEST;
  process.env.CDSS_BUILD_SOURCE_DIGEST = "another-build";
  const otherBuild = fingerprint(skipped);
  if (previousDigest == null) delete process.env.CDSS_BUILD_SOURCE_DIGEST; else process.env.CDSS_BUILD_SOURCE_DIGEST = previousDigest;
  assert.notEqual(otherBuild, currentBuild, "发版后旧结果不再回放");
  assert.equal(fingerprint(skipped), currentBuild);
}

console.log("customer request shape: ok");
