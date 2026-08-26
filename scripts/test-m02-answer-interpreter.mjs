import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const {
  M02_ANSWER_INTERPRETATION_SCHEMA_VERSION,
  interpretM02Answer,
  validateM02AnswerModelOutput,
} = jiti("../src/lib/m02-answer-interpreter.server.ts");
const { POST } = jiti("../src/app/api/diagnosis/question/interpret/route.ts");

const caseState = {
  id: "m02-answer-test",
  customerId: "test-hospital",
  phase: "question",
  patient: { age: 42 },
  chiefComplaint: "反复皮疹，拟核实过敏史和当前用药",
  symptoms: {},
  completeness: { level: "B", redFlag: 0.4, infoGain: 0.5, managementImpact: 0.5, answerability: 0.8 },
  questionRounds: 0,
  maxQuestionRounds: 1,
  conversation: [],
};

function question({ id, question: text, targetField, branch }) {
  return {
    id,
    question: text,
    reason: "该信息会改变后续安全判断。",
    targetField,
    decisionBranch: branch,
    expectedDecisionImpact: "根据回答更新相应临床分支。",
    informationGain: 0.9,
    sourceEvidence: [],
    options: [
      { id: "yes", label: "有", answer: "有相关情况", kind: "clinical_fact", requiresDetail: true },
      { id: "no", label: "无", answer: "无相关情况", kind: "clinical_fact", recordValue: "无相关情况" },
      { id: "unknown", label: "不清楚", answer: "本次未取得该信息", kind: "unknown" },
    ],
  };
}

const plan = {
  schemaVersion: "tcm-cdss-m02-plan-v1",
  decision: "ask",
  rationale: "仍有两个治疗安全相关问题需要核实。",
  questions: [
    question({ id: "q-allergy", question: "患者是否有明确的药物过敏史？", targetField: "allergyHistory", branch: "treatment_safety" }),
    question({ id: "q-medication", question: "患者目前是否正在使用药物？", targetField: "medicationHistory", branch: "treatment_safety" }),
  ],
};

function output(answers) {
  return JSON.stringify({ schemaVersion: M02_ANSWER_INTERPRETATION_SCHEMA_VERSION, answers });
}

function fakeModel(outputs, phases = []) {
  let index = 0;
  return async ({ phase }) => {
    phases.push(phase);
    return outputs[Math.min(index++, outputs.length - 1)];
  };
}

const oralAnswer = "第一个没有，第二个我真不清楚。";
const oralResult = await interpretM02Answer({
  caseState,
  plan,
  doctorAnswer: oralAnswer,
  modelCall: fakeModel([output([
    {
      questionId: "q-allergy",
      targetField: "allergyHistory",
      recordValue: "第一个没有",
      clinicalFacts: [{ status: "negative", quote: "第一个没有" }],
      groundedQuotes: ["第一个没有"],
    },
    {
      questionId: "q-medication",
      targetField: "medicationHistory",
      recordValue: null,
      clinicalFacts: [{ status: "unknown", quote: "第二个我真不清楚" }],
      groundedQuotes: ["第二个我真不清楚"],
    },
  ])]),
});
assert.equal(oralResult.ok, true, "multi-question colloquial answer should map to both original questions");
assert.deepEqual(oralResult.answers.map((item) => item.questionId), ["q-allergy", "q-medication"]);
assert.equal(oralResult.answers[0].clinicalFacts[0].status, "negative", "negation remains explicit");
assert.equal(oralResult.answers[1].recordValue, null, "unknown answer must not become a clinical record fact");
assert.equal(oralResult.answers[1].clinicalFacts[0].status, "unknown", "unclear answer remains unknown");

const repairedPhases = [];
const repairedAuthorization = await interpretM02Answer({
  caseState,
  plan,
  doctorAnswer: "没有药物过敏。",
  modelCall: fakeModel([
    output([{
      questionId: "q-allergy",
      targetField: "tcmPulse",
      recordValue: "没有药物过敏",
      groundedQuotes: ["没有药物过敏"],
    }]),
    output([{
      questionId: "q-allergy",
      targetField: "allergyHistory",
      recordValue: "没有药物过敏",
      clinicalFacts: [{ status: "negative", quote: "没有药物过敏" }],
      groundedQuotes: ["没有药物过敏"],
    }]),
  ], repairedPhases),
});
assert.equal(repairedAuthorization.ok, true, "one repair may recover an unauthorized targetField");
assert.deepEqual(repairedPhases, ["interpret", "repair"], "repair is bounded to the second model call");
assert.equal(repairedAuthorization.answers[0].targetField, "allergyHistory");

const repeatedUnauthorized = await interpretM02Answer({
  caseState,
  plan,
  doctorAnswer: "没有药物过敏。",
  modelCall: fakeModel([output([{
    questionId: "q-allergy",
    targetField: "tcmPulse",
    recordValue: "没有药物过敏",
    groundedQuotes: ["没有药物过敏"],
  }])]),
});
assert.equal(repeatedUnauthorized.ok, false, "repeated targetField escalation must fail closed");
assert.equal(repeatedUnauthorized.failure.code, "model_output_invalid");
assert.equal(repeatedUnauthorized.failure.attempts, 2);

const hallucinatedValue = output([{
  questionId: "q-allergy",
  targetField: "allergyHistory",
  recordValue: "青霉素过敏",
  clinicalFacts: [{ status: "negative", quote: "没有过敏" }],
  groundedQuotes: ["没有过敏"],
}]);
const hallucinationValidation = validateM02AnswerModelOutput(hallucinatedValue, plan, "患者说没有过敏");
assert.equal(hallucinationValidation.ok, false, "a recordValue absent from the answer must be rejected");
assert.ok(hallucinationValidation.reasons.includes("record_value_not_grounded"));

const hallucinatedResult = await interpretM02Answer({
  caseState,
  plan,
  doctorAnswer: "患者说没有过敏",
  modelCall: fakeModel([hallucinatedValue]),
});
assert.equal(hallucinatedResult.ok, false, "hallucination must return typed failure after one repair");
assert.equal(hallucinatedResult.failure.code, "model_output_invalid");

const transientPhases = [];
let transientCalls = 0;
const recoveredTransient = await interpretM02Answer({
  caseState,
  plan,
  doctorAnswer: "没有药物过敏。",
  modelCall: async ({ phase }) => {
    transientPhases.push(phase);
    transientCalls += 1;
    if (transientCalls === 1) throw Object.assign(new Error("upstream bad gateway"), { status: 502 });
    return output([{
      questionId: "q-allergy",
      targetField: "allergyHistory",
      recordValue: "没有药物过敏",
      clinicalFacts: [{ status: "negative", quote: "没有药物过敏" }],
      groundedQuotes: ["没有药物过敏"],
    }]);
  },
});
assert.equal(recoveredTransient.ok, true, "one transient 502 retry should recover inside the shared deadline");
assert.equal(transientCalls, 2);
assert.deepEqual(transientPhases, ["interpret", "interpret"], "transport retry must not consume the contract-repair phase");

let permanentCalls = 0;
const permanentFailure = await interpretM02Answer({
  caseState,
  plan,
  doctorAnswer: "没有药物过敏。",
  modelCall: async () => {
    permanentCalls += 1;
    throw Object.assign(new Error("bad request"), { status: 400 });
  },
});
assert.equal(permanentFailure.ok, false);
assert.equal(permanentFailure.failure.code, "model_request_failed");
assert.equal(permanentFailure.failure.attempts, 1);
assert.equal(permanentCalls, 1, "non-transient failures must not be retried");

const fabricatedQuote = validateM02AnswerModelOutput(output([{
  questionId: "q-medication",
  targetField: "medicationHistory",
  recordValue: "每天服阿司匹林",
  groundedQuotes: ["每天服阿司匹林"],
}]), plan, "偶尔吃点药，名字记不清");
assert.equal(fabricatedQuote.ok, false, "groundedQuotes must be byte-for-byte answer substrings");
assert.ok(fabricatedQuote.reasons.includes("quote_not_grounded"));

const wrongQuestion = validateM02AnswerModelOutput(output([{
  questionId: "q-outside-plan",
  targetField: "allergyHistory",
  recordValue: "没有药物过敏",
  groundedQuotes: ["没有药物过敏"],
}]), plan, "没有药物过敏");
assert.equal(wrongQuestion.ok, false, "questionId outside the plan must be rejected");
assert.ok(wrongQuestion.reasons.includes("question_not_in_plan"));

const invalidRouteResponse = await POST(new Request("http://localhost/api/diagnosis/question/interpret", {
  method: "POST",
  headers: { "content-type": "application/json", "x-cdss-customer-id": "test-hospital" },
  body: JSON.stringify({ caseState, m02Plan: { ...plan, questions: [] }, answer: "没有" }),
}));
assert.equal(invalidRouteResponse.status, 422, "route rejects an invalid plan before any model call");
assert.equal((await invalidRouteResponse.json()).failure.code, "invalid_plan");

// 2026-08-26 甲方复测衍生（活体 3/3 复现，DeepSeek 与 Qwen 输出同形）：医生按序号作答
// 「第一个不清楚，第二个没有。」时，模型给出临床上正确的可记录片段 recordValue="没有"、
// 逐字引文 "第二个没有"。旧判据要求 recordValue **逐字等于**某条 groundedQuotes，
// 序号前缀（第二个）不可记录却被硬塞进等式，修复轮模型再次给出同一（正确）输出——
// 定点：两轮都被拒，接口返回 model_output_invalid。接地不变量只需要「recordValue 是医生
// 原话的逐字连续子串，且被某条已声明引文覆盖」；等式是过严的表达，不是安全边界。
// clinicalFacts.quote 与 groundedQuotes 的关系同形，一起按包含判定。
const ordinalAnswer = "第一个不清楚，第二个没有。";
const ordinalOutput = (medication) => output([
  { questionId: "q-allergy", targetField: "allergyHistory", recordValue: null,
    clinicalFacts: [{ status: "unknown", quote: "第一个不清楚" }], groundedQuotes: ["第一个不清楚"] },
  { questionId: "q-medication", targetField: "medicationHistory", ...medication },
]);
const ordinalContained = validateM02AnswerModelOutput(
  ordinalOutput({ recordValue: "没有", clinicalFacts: [{ status: "negative", quote: "第二个没有" }], groundedQuotes: ["第二个没有"] }),
  plan, ordinalAnswer,
);
assert.equal(ordinalContained.ok, true, `recordValue contained in a declared verbatim quote is grounded: ${JSON.stringify(ordinalContained)}`);
const ordinalFactContained = validateM02AnswerModelOutput(
  ordinalOutput({ recordValue: "没有", clinicalFacts: [{ status: "negative", quote: "没有" }], groundedQuotes: ["第二个没有"] }),
  plan, ordinalAnswer,
);
assert.equal(ordinalFactContained.ok, true, `clinical fact quote contained in a declared quote is grounded: ${JSON.stringify(ordinalFactContained)}`);
// 反证：包含判定不能放开成「在原话里出现即可」——recordValue 必须落在某条已声明引文之内。
const ordinalUndeclared = validateM02AnswerModelOutput(
  ordinalOutput({ recordValue: "没有", clinicalFacts: [{ status: "negative", quote: "第二个没有" }], groundedQuotes: ["第一个不清楚"] }),
  plan, ordinalAnswer,
);
assert.equal(ordinalUndeclared.ok, false);
assert.ok(ordinalUndeclared.reasons.includes("record_value_not_grounded"), "recordValue outside every declared quote is still rejected");
const ordinalFabricated = validateM02AnswerModelOutput(
  ordinalOutput({ recordValue: "没有用药", clinicalFacts: [{ status: "negative", quote: "第二个没有" }], groundedQuotes: ["第二个没有"] }),
  plan, ordinalAnswer,
);
assert.equal(ordinalFabricated.ok, false);
assert.ok(ordinalFabricated.reasons.includes("record_value_not_grounded"), "a recordValue absent from the doctor's words is still rejected");
const ordinalFactUndeclared = validateM02AnswerModelOutput(
  ordinalOutput({ recordValue: "没有", clinicalFacts: [{ status: "negative", quote: "第二个" }], groundedQuotes: ["没有"] }),
  plan, ordinalAnswer,
);
assert.equal(ordinalFactUndeclared.ok, false);
assert.ok(ordinalFactUndeclared.reasons.includes("clinical_fact_quote_not_declared"), "a fact quote outside every declared quote is still rejected");
// 端到端：真实模型输出形态经 interpretM02Answer 一次通过，不进修复轮。
const ordinalPhases = [];
const ordinalResult = await interpretM02Answer({
  caseState, plan, doctorAnswer: ordinalAnswer,
  modelCall: fakeModel([ordinalOutput({ recordValue: "没有", clinicalFacts: [{ status: "negative", quote: "第二个没有" }], groundedQuotes: ["第二个没有"] })], ordinalPhases),
});
assert.equal(ordinalResult.ok, true, `ordinal-referenced answer is accepted: ${JSON.stringify(ordinalResult)}`);
assert.deepEqual(ordinalPhases, ["interpret"], "no repair round is spent on a correct output");
assert.equal(ordinalResult.answers[1].recordValue, "没有");
assert.equal(ordinalResult.answers[1].clinicalFacts[0].status, "negative");

// 2026-08-26 线上活体抓到（部署 2f220b6 后探针 #2）：医生答「都没有。」，模型输出
// recordValue="有"、status=positive——「有」是「没有」的**字面内部子串**，接地判据
// （无论逐字相等还是包含）都视其为已接地：否定词吞没肯定片段。这是构词式类缺陷
// （判据分层允许确定性守卫的三种例外之一）。守卫语义：recordValue 或 positive/historical
// 事实引文在医生原话中的**每一处出现**都紧跟在否定语素（没/无/未/不/非/否认）之后、
// 且片段自身不携带否定语素时 ⇒ 拒绝。任何一处非否定出现（「有咳嗽，没有发热」）都放行。
const blanketNegation = "都没有。";
const negatedFragmentPositive = validateM02AnswerModelOutput(output([
  { questionId: "q-allergy", targetField: "allergyHistory", recordValue: "有",
    clinicalFacts: [{ status: "positive", quote: "有" }], groundedQuotes: ["有"] },
]), plan, blanketNegation);
assert.equal(negatedFragmentPositive.ok, false, "a fragment inside 没有 must not ground a positive record");
assert.ok(negatedFragmentPositive.reasons.includes("record_value_polarity_negated"), JSON.stringify(negatedFragmentPositive));
assert.ok(negatedFragmentPositive.reasons.includes("clinical_fact_polarity_negated"), JSON.stringify(negatedFragmentPositive));
// 正确形态照常通过：总括否定 → 两题 negative，引文整条「都没有」。
const blanketNegationCorrect = validateM02AnswerModelOutput(output([
  { questionId: "q-allergy", targetField: "allergyHistory", recordValue: "都没有",
    clinicalFacts: [{ status: "negative", quote: "都没有" }], groundedQuotes: ["都没有"] },
  { questionId: "q-medication", targetField: "medicationHistory", recordValue: "都没有",
    clinicalFacts: [{ status: "negative", quote: "都没有" }], groundedQuotes: ["都没有"] },
]), plan, blanketNegation);
assert.equal(blanketNegationCorrect.ok, true, `blanket negation mapped to negative facts stays valid: ${JSON.stringify(blanketNegationCorrect)}`);
// 片段自身携带否定语素（「没有」）不受守卫影响——序号作答修复的形态保持绿。
const negationCarryingFragment = validateM02AnswerModelOutput(output([
  { questionId: "q-medication", targetField: "medicationHistory", recordValue: "没有",
    clinicalFacts: [{ status: "negative", quote: "第二个没有" }], groundedQuotes: ["第二个没有"] },
]), plan, "第一个不清楚，第二个没有。");
assert.equal(negationCarryingFragment.ok, true, `negation-carrying recordValue is untouched: ${JSON.stringify(negationCarryingFragment)}`);
// 存在任何一处非否定出现即放行：「有咳嗽，没有发热」的「有」不能被连坐。
const mixedOccurrence = validateM02AnswerModelOutput(output([
  { questionId: "q-allergy", targetField: "allergyHistory", recordValue: "有咳嗽",
    clinicalFacts: [{ status: "positive", quote: "有咳嗽" }], groundedQuotes: ["有咳嗽"] },
]), plan, "有咳嗽，没有发热。");
assert.equal(mixedOccurrence.ok, true, `a non-negated occurrence keeps the positive record valid: ${JSON.stringify(mixedOccurrence)}`);
// 「无汗」类：被否定语素前缀覆盖的症状词不得作为阳性事实接地。
const noSweat = validateM02AnswerModelOutput(output([
  { questionId: "q-allergy", targetField: "allergyHistory", recordValue: null,
    clinicalFacts: [{ status: "positive", quote: "汗" }], groundedQuotes: ["无汗"] },
]), plan, "无汗，恶寒重。");
assert.equal(noSweat.ok, false);
assert.ok(noSweat.reasons.includes("clinical_fact_polarity_negated"), JSON.stringify(noSweat));
// 否认 + 片段：两字否定语素同样覆盖。
const denied = validateM02AnswerModelOutput(output([
  { questionId: "q-allergy", targetField: "allergyHistory", recordValue: "药物过敏",
    clinicalFacts: [{ status: "positive", quote: "药物过敏" }], groundedQuotes: ["否认药物过敏"] },
]), plan, "否认药物过敏。");
assert.equal(denied.ok, false);
assert.ok(denied.reasons.includes("record_value_polarity_negated"), JSON.stringify(denied));

// 修复轮必须携带人类可读的中文指引（实测两家模型只见英文代码时原样重复被拒输出）。
const guidancePrompts = [];
// 注意：整句「都没有。」现在走确定性总括通路，不会到模型；这里用句中形态触发极性拒绝。
const guidanceResult = await interpretM02Answer({
  caseState, plan, doctorAnswer: "过敏那个没有。",
  modelCall: async ({ userPrompt, phase }) => {
    guidancePrompts.push({ phase, userPrompt });
    if (phase === "interpret") {
      return output([{ questionId: "q-allergy", targetField: "allergyHistory", recordValue: "有",
        clinicalFacts: [{ status: "positive", quote: "有" }], groundedQuotes: ["有"] }]);
    }
    return output([
      { questionId: "q-allergy", targetField: "allergyHistory", recordValue: "没有",
        clinicalFacts: [{ status: "negative", quote: "没有" }], groundedQuotes: ["过敏那个没有"] },
    ]);
  },
});
assert.equal(guidanceResult.ok, true, `polarity rejection repairs to negative facts: ${JSON.stringify(guidanceResult)}`);
const repairPrompt = guidancePrompts.find((item) => item.phase === "repair")?.userPrompt || "";
assert.ok(repairPrompt.includes("record_value_polarity_negated"), "repair prompt keeps the machine reason code");
assert.ok(repairPrompt.includes("被否定的片段"), "repair prompt carries the human-readable polarity guidance");
assert.ok(repairPrompt.includes("rejectionGuidance"), "guidance travels in a dedicated field");

// 整句总括回答走确定性通路：零模型调用、对 plan 内每个问题生效。
{
  let blanketModelCalls = 0;
  const countingModel = async () => { blanketModelCalls += 1; return output([]); };
  const blanketNo = await interpretM02Answer({ caseState, plan, doctorAnswer: "都没有。", modelCall: countingModel });
  assert.equal(blanketNo.ok, true, `blanket negation resolves deterministically: ${JSON.stringify(blanketNo)}`);
  assert.equal(blanketModelCalls, 0, "no model call is spent on a whole-sentence blanket answer");
  assert.deepEqual(blanketNo.answers.map((a) => [a.questionId, a.recordValue, a.clinicalFacts[0].status]),
    [["q-allergy", "都没有", "negative"], ["q-medication", "都没有", "negative"]]);
  for (const phrase of ["均无", "无。", "没有", "两个都没有。", "否认。"]) {
    const r = await interpretM02Answer({ caseState, plan, doctorAnswer: phrase, modelCall: countingModel });
    assert.equal(r.ok, true, `"${phrase}" resolves deterministically`);
    assert.ok(r.answers.every((a) => a.clinicalFacts[0].status === "negative"), phrase);
  }
  const blanketUnknown = await interpretM02Answer({ caseState, plan, doctorAnswer: "都不清楚。", modelCall: countingModel });
  assert.equal(blanketUnknown.ok, true);
  assert.ok(blanketUnknown.answers.every((a) => a.recordValue === null && a.clinicalFacts[0].status === "unknown"),
    "blanket unknown maps to null record + unknown facts");
  assert.equal(blanketModelCalls, 0, "none of the blanket forms reached the model");
  // 反证：句中混合表达绝不能被总括通路吞掉——必须进模型。
  const mixed = await interpretM02Answer({
    caseState, plan, doctorAnswer: "没有过敏，有咳嗽。",
    modelCall: async () => output([{ questionId: "q-allergy", targetField: "allergyHistory", recordValue: "没有过敏",
      clinicalFacts: [{ status: "negative", quote: "没有过敏" }], groundedQuotes: ["没有过敏"] }]),
  });
  assert.equal(mixed.ok, true);
  assert.equal(mixed.answers.length, 1, "a mixed sentence goes through the model, not the blanket path");
  const ordinalNotBlanket = await interpretM02Answer({
    caseState, plan, doctorAnswer: "第一个没有。",
    modelCall: async () => output([{ questionId: "q-allergy", targetField: "allergyHistory", recordValue: "没有",
      clinicalFacts: [{ status: "negative", quote: "第一个没有" }], groundedQuotes: ["第一个没有"] }]),
  });
  assert.equal(ordinalNotBlanket.ok, true);
  assert.equal(ordinalNotBlanket.answers.length, 1, "an ordinal-scoped negation is NOT blanket — only the addressed question is answered");
}

console.log("M02 answer interpreter tests passed: authorization, grounding, negation/unknown, repair, and multi-question speech.");
