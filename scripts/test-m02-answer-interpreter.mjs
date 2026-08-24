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

console.log("M02 answer interpreter tests passed: authorization, grounding, negation/unknown, repair, and multi-question speech.");
