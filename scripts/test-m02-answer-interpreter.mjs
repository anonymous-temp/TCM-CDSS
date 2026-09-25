// POST /api/diagnosis/question/interpret —— 确定性逐题归属（2026-09-25 起不再调模型）。
//
// 背景：实验 E3（65 条真实医生口吻回答）里模型解读把 30 条截成子串、14 条不写入，丢掉的正是
// 「降压药一直吃着」「说不清有无黑便」这类临床内容。现在 recordValue 就是医生原话（去首尾空白），
// 按页面拼接回答时用的「问题<id>：」前缀逐题切段；接口保留、请求/响应形状与 HTTP 状态不变，
// 只新增一个失败码 answer_not_attributable（200 + ok:false）。
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
} = jiti("../src/lib/m02-answer-interpreter.server.ts");
const { POST } = jiti("../src/app/api/diagnosis/question/interpret/route.ts");

// 任何外呼都算失败：这个接口不再有模型调用。
let upstreamCalls = 0;
globalThis.fetch = async () => {
  upstreamCalls += 1;
  throw new Error("question/interpret must not call any upstream");
};

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

// 页面给出的问题 id 就是 q1/q2（enforceM02UnansweredAxes 统一重排），回答前缀按 id 拼。
const plan = {
  schemaVersion: "tcm-cdss-m02-plan-v1",
  decision: "ask",
  rationale: "仍有两个治疗安全相关问题需要核实。",
  questions: [
    question({ id: "q1", question: "患者是否有明确的药物过敏史？", targetField: "allergyHistory", branch: "treatment_safety" }),
    question({ id: "q2", question: "患者目前是否正在使用药物？", targetField: "medicationHistory", branch: "treatment_safety" }),
  ],
};
const singlePlan = {
  ...plan,
  rationale: "仍有一个分诊问题需要核实。",
  questions: [question({ id: "q1", question: "近期是否出现黑便？", targetField: "xianbingshi", branch: "triage" })],
};

const interpret = (m02Plan, doctorAnswer) => interpretM02Answer({ plan: m02Plan, doctorAnswer });
const ok = (result, label) => {
  assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
  assert.equal(result.schemaVersion, M02_ANSWER_INTERPRETATION_SCHEMA_VERSION);
  return result.answers;
};
const notAttributable = (result, label) => {
  assert.deepEqual(result, {
    ok: false,
    failure: {
      code: "answer_not_attributable",
      message: "请按『问题ID：回答』逐题作答；医生原话由调用方保留",
      retryable: false,
      attempts: 0,
    },
  }, label);
};

// ── 1. 前缀切段：原话逐字、按计划题序、只有接口文档里的四个键 ─────────────────────────────
{
  const answers = ok(interpret(plan, "问题q1：青霉素过敏，起皮疹\n问题q2：降压药一直吃着"), "prefix segmentation");
  assert.deepEqual(answers, [
    { questionId: "q1", targetField: "allergyHistory", recordValue: "青霉素过敏，起皮疹", groundedQuotes: ["青霉素过敏，起皮疹"] },
    { questionId: "q2", targetField: "medicationHistory", recordValue: "降压药一直吃着", groundedQuotes: ["降压药一直吃着"] },
  ], "each segment is recorded verbatim to its authorized targetField, with no clinicalFacts");
  // 半角冒号、题序与计划相反、前缀前后的空白：归属仍按 id，值仍逐字。
  const reordered = ok(interpret(plan, "  问题q2: 烟抽二十年，降压药一直吃着 \n问题q1:无  "), "half-width colon + reversed order");
  assert.deepEqual(reordered.map((a) => [a.questionId, a.recordValue]), [["q1", "无"], ["q2", "烟抽二十年，降压药一直吃着"]]);
  // 只答了其中一题：另一题不出现（不是写 null）。
  const partial = ok(interpret(plan, "问题q2：否认长期用药"), "one question answered");
  assert.deepEqual(partial.map((a) => a.questionId), ["q2"]);
  // 前缀之前的文字不归属任何题。
  const preamble = ok(interpret(plan, "回答如下：\n问题q1：无\n问题q2：二甲双胍"), "preamble");
  assert.deepEqual(preamble.map((a) => a.recordValue), ["无", "二甲双胍"]);
}

// ── 2. 多行段落：一段延续到下一个前缀，行内换行原样保留 ─────────────────────────────────
{
  const answers = ok(interpret(plan, "问题q1：否认药物过敏\n问题q2：高血压病史5年\n降压药一直吃着，名字说不清\n问题"), "multi-line segment");
  assert.equal(answers[1].recordValue, "高血压病史5年\n降压药一直吃着，名字说不清\n问题",
    "a segment runs until the next recognized prefix, across lines; an unrecognized '问题' is ordinary text");
  assert.deepEqual(answers[1].groundedQuotes, [answers[1].recordValue]);
  assert.equal(answers[0].recordValue, "否认药物过敏");
}

// ── 3. 整句总括：对计划内每题生效，带 negative / unknown 事实（与改动前同一条确定性通路）─────
{
  const blanketNo = ok(interpret(plan, "都没有。"), "blanket negation");
  assert.deepEqual(blanketNo, ["q1", "q2"].map((questionId, index) => ({
    questionId,
    targetField: plan.questions[index].targetField,
    recordValue: "都没有",
    clinicalFacts: [{ status: "negative", quote: "都没有" }],
    groundedQuotes: ["都没有"],
  })));
  for (const phrase of ["均无", "无。", "没有", "两个都没有。", "否认。"]) {
    const answers = ok(interpret(plan, phrase), phrase);
    assert.ok(answers.length === 2 && answers.every((a) => a.clinicalFacts[0].status === "negative"), phrase);
  }
  const blanketUnknown = ok(interpret(plan, "都不清楚。"), "blanket unknown");
  assert.ok(blanketUnknown.length === 2 && blanketUnknown.every((a) => a.recordValue === null && a.clinicalFacts[0].status === "unknown"),
    "blanket unknown maps to null record + unknown facts");
  // 反证：句中混合表达、序号作答都不是总括——多题计划下无前缀即不可归属，绝不被当成「全否认」。
  notAttributable(interpret(plan, "没有过敏，有咳嗽。"), "a mixed sentence is not a blanket negation");
  notAttributable(interpret(plan, "第一个没有。"), "an ordinal-scoped negation is not a blanket negation");
}

// ── 4. 单题计划：无前缀时整段回答归这一题；有前缀照常去掉前缀 ─────────────────────────────
{
  assert.deepEqual(ok(interpret(singlePlan, "  说不清有无黑便 "), "single-question plan"), [
    { questionId: "q1", targetField: "xianbingshi", recordValue: "说不清有无黑便", groundedQuotes: ["说不清有无黑便"] },
  ], "the whole answer is the record for a single-question plan — including hedged answers the model used to drop");
  assert.equal(ok(interpret(singlePlan, "问题q1：耳朵嗡嗡响\n晚上明显"), "single + prefix")[0].recordValue, "耳朵嗡嗡响\n晚上明显");
  // 单题计划里句中混合表达照样逐字写入，不被总括通路吞掉。
  assert.equal(ok(interpret(singlePlan, "没有黑便，有咳嗽。"), "single mixed")[0].recordValue, "没有黑便，有咳嗽。");
}

// ── 5. 不可归属：多题计划无前缀 / 同题两次 / 全部空段 ───────────────────────────────────
notAttributable(interpret(plan, "第一个没有，第二个我真不清楚。"), "a multi-question blob without prefixes");
notAttributable(interpret(plan, "问题1：没有\n问题2：有"), "visible card numbers are not question ids");
notAttributable(interpret(plan, "问题q1：没有\n问题q1：补充：偶有皮疹"), "the same question answered twice is ambiguous");
notAttributable(interpret(plan, "问题q1：\n问题q2： "), "prefixes with empty segments attribute nothing");

// ── 6. 边界：计划/回答校验不变；单题原话超过接口文档的 500 字引文上限按回答过长拒绝（不截断原话）──
assert.equal(interpret({ ...plan, questions: [] }, "没有").failure.code, "invalid_plan");
assert.equal(interpret({ ...plan, decision: "proceed", questions: [] }, "没有").failure.code, "invalid_plan");
assert.equal(interpret(plan, "   ").failure.code, "invalid_answer");
assert.equal(interpret(singlePlan, "黑".repeat(501)).failure.code, "invalid_answer");
assert.equal(ok(interpret(singlePlan, "黑".repeat(500)), "500-char segment")[0].recordValue.length, 500);

// ── 7. 路由：请求/响应形状与 HTTP 状态 ────────────────────────────────────────────────
const post = (body) => POST(new Request("http://localhost/api/diagnosis/question/interpret", {
  method: "POST",
  headers: { "content-type": "application/json", "x-cdss-customer-id": "test-hospital" },
  body: JSON.stringify(body),
}));
{
  const invalidPlan = await post({ caseState, m02Plan: { ...plan, questions: [] }, answer: "没有" });
  assert.equal(invalidPlan.status, 422, "route rejects an invalid plan");
  assert.equal((await invalidPlan.json()).failure.code, "invalid_plan");
  const missing = await post({ caseState, m02Plan: plan });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).failure.code, "invalid_request");
  const tooLong = await post({ caseState, m02Plan: plan, answer: "无".repeat(6_001) });
  assert.equal(tooLong.status, 422);
  assert.equal((await tooLong.json()).failure.code, "invalid_answer");

  const success = await post({ caseState, m02Plan: plan, answer: "问题q1：青霉素过敏\n问题q2：降压药一直吃着" });
  assert.equal(success.status, 200);
  const successBody = await success.json();
  assert.deepEqual(Object.keys(successBody), ["ok", "schemaVersion", "answers"]);
  assert.deepEqual(successBody.answers.map((a) => a.recordValue), ["青霉素过敏", "降压药一直吃着"]);

  const blob = await post({ caseState, m02Plan: plan, answer: "第一个没有，第二个我真不清楚。" });
  assert.equal(blob.status, 200, "an unattributable answer is a business outcome, not an HTTP error");
  notAttributable(await blob.json(), "route: unattributable blob");
}
assert.equal(upstreamCalls, 0, "no upstream call was made");

console.log("M02 answer interpretation (deterministic): prefix segmentation, multi-line, blanket negation/unknown, single-question plan, unattributable blob, route shape.");
