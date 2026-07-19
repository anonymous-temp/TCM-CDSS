import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildCaseAwareQuestionFallback,
  enforceM02UnansweredAxes,
  ensureQuestionStructuredEnvelope,
  ensureSingleRoundQuestionContract,
  parseM02PlanFromContent,
} = jiti("../src/lib/m02-question-contract.ts");
const { applyUserAnswer } = jiti("../src/lib/diagnosis-engine.ts");
const { reviewM02QuestionPlan } = jiti("../src/lib/m02-question-review.server.ts");

function block(index, question, options = ["存在该表现", "经询问未见该表现", "本次未取得该信息"]) {
  return [
    `**问题${index}：** ${question}`,
    "（追问理由：该信息可能改变当前临床判断。）",
    "补录字段：现病史",
    "可选项：",
    `A. ${options[0]}`,
    `B. ${options[1]}`,
    `C. ${options[2]}`,
  ].join("\n");
}

const novelCase = { chiefComplaint: "这阵子嘴里发黏，到了下午脑袋发沉" };
const rankedModelQuestions = [
  block(1, "口中黏腻和头重通常在进食后、空腹还是劳累后更明显？"),
  block(2, "同时是否有食欲变化、大便黏滞或口渴饮水变化？"),
  block(3, "本次是否取得舌脉？"),
].join("\n\n");
const ranked = ensureSingleRoundQuestionContract(rankedModelQuestions, buildCaseAwareQuestionFallback(novelCase), novelCase);
assert.equal((ranked.match(/\*\*问题\d+[：:]/g) || []).length, 2, "one round is capped at two questions");
assert.ok(ranked.indexOf("进食后、空腹") < ranked.indexOf("食欲变化"), "valid model information-gain order must be preserved");
assert.doesNotMatch(ranked, /本次是否取得舌脉/);

const oneHighValue = ensureSingleRoundQuestionContract(block(1, "目前最影响日常活动的具体表现是什么？"), buildCaseAwareQuestionFallback(novelCase), novelCase);
assert.equal((oneHighValue.match(/\*\*问题\d+[：:]/g) || []).length, 1, "a single valid model question must not be padded to two");

const duplicateModelQuestions = [
  block(1, "目前最影响日常活动的具体表现是什么？"),
  block(2, "目前最影响日常活动的具体表现是什么？"),
  block(3, "这些表现一天中什么时候最明显？"),
].join("\n\n");
const deduplicated = ensureSingleRoundQuestionContract(duplicateModelQuestions, buildCaseAwareQuestionFallback(novelCase), novelCase);
assert.equal((deduplicated.match(/\*\*问题\d+[：:]/g) || []).length, 2);
assert.equal((deduplicated.match(/最影响日常活动/g) || []).length, 1, "duplicate questions occupy only one slot");

const malformed = ensureSingleRoundQuestionContract("模型未输出可解析问题", buildCaseAwareQuestionFallback(novelCase), novelCase);
assert.match(malformed, /目前总体在加重、缓解还是反复波动/);
assert.equal((malformed.match(/\*\*问题\d+[：:]/g) || []).length, 1);

const possiblePoisoning = {
  chiefComplaint: "喝了别人递来的饮料后整个人不对劲，怀疑被下药",
  clinicalFacts: { redFlags: [{ category: "poisoning", status: "possible", urgency: "clarify", quote: "怀疑被下药" }] },
};
const poisoningFallback = buildCaseAwareQuestionFallback(possiblePoisoning);
assert.match(poisoningFallback, /接触或摄入的物质、时间和大致剂量/);
assert.match(poisoningFallback, /请补充具体表现/);
const riskRestored = ensureSingleRoundQuestionContract(block(1, "这些不适什么时候开始？"), poisoningFallback, possiblePoisoning);
assert.match(riskRestored.split("\n\n")[0], /接触或摄入的物质、时间和大致剂量/);
assert.equal((riskRestored.match(/\*\*问题\d+[：:]/g) || []).length, 2);

const providerAlreadyAskedRisk = ensureSingleRoundQuestionContract(
  block(1, "请核实可能接触或摄入的物质、时间和大致剂量；目前是否有意识、呼吸或抽搐异常？"),
  poisoningFallback,
  possiblePoisoning,
);
assert.equal((providerAlreadyAskedRisk.match(/\*\*问题\d+[：:]/g) || []).length, 1, "a grounded safety question must not be duplicated");

const compoundPositive = ensureSingleRoundQuestionContract(
  block(1, "是否有呕血、黑便或吞咽困难？", ["存在呕血、黑便或吞咽困难中的一项", "经询问未见上述表现", "本次未取得该信息"]),
  buildCaseAwareQuestionFallback({ chiefComplaint: "胃不舒服" }),
  { chiefComplaint: "胃不舒服" },
);
assert.match(compoundPositive, /A\. .*请补充具体表现/, "grouped positives require an atomic doctor-entered detail");

const lowValueOnly = ensureSingleRoundQuestionContract(block(1, "请问患者喜欢什么颜色？"), buildCaseAwareQuestionFallback(novelCase), novelCase);
assert.doesNotMatch(lowValueOnly, /喜欢什么颜色/);
assert.match(lowValueOnly, /加重、缓解还是反复波动/);

const envelope = ensureQuestionStructuredEnvelope(oneHighValue);
assert.match(envelope, /DIAGNOSIS_JSON_START[\s\S]*"completeness"[\s\S]*DIAGNOSIS_JSON_END/);
assert.equal(parseM02PlanFromContent(envelope)?.questions.length, 1, "provider failure falls back to a typed one-question plan");

const typedPlan = {
  schemaVersion: "tcm-cdss-m02-plan-v1",
  decision: "ask",
  rationale: "仍有一个会改变首要鉴别的未决分支。",
  questions: [{
    id: "q1",
    question: "口中发黏在进食后是否明显加重？",
    reason: "与进食的时间关系会改变湿困与其他方向的权重。",
    targetField: "xianbingshi",
    decisionBranch: "differential",
    expectedDecisionImpact: "区分进食相关加重与无明显时间关系。",
    informationGain: 0.86,
    sourceEvidence: ["嘴里发黏"],
    options: [
      { id: "after-meal", label: "进食后加重", answer: "进食后口中黏腻明显加重", kind: "clinical_fact", recordValue: "进食后口中黏腻明显加重" },
      { id: "no-relation", label: "无明显关系", answer: "与进食无明显关系", kind: "clinical_fact", recordValue: "口中黏腻与进食无明显关系" },
      { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
    ],
  }],
};
const typedContent = `${oneHighValue}\n\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ completeness: { level: "B" }, m02Plan: typedPlan })}\n<!-- DIAGNOSIS_JSON_END -->`;
const groundedTyped = ensureQuestionStructuredEnvelope(typedContent, "这阵子嘴里发黏，到了下午脑袋发沉");
assert.equal(parseM02PlanFromContent(groundedTyped)?.questions[0]?.targetField, "xianbingshi", "typed plan is the authoritative target-field contract");
const labeledEvidencePlan = structuredClone(typedPlan);
labeledEvidencePlan.questions[0].sourceEvidence = ["主诉：嘴里发黏"];
const normalizedLabeledEvidence = ensureQuestionStructuredEnvelope(
  JSON.stringify({ completeness: { level: "B" }, m02Plan: labeledEvidencePlan }),
  "这阵子嘴里发黏，到了下午脑袋发沉",
);
assert.deepEqual(
  parseM02PlanFromContent(normalizedLabeledEvidence)?.questions[0]?.sourceEvidence,
  ["嘴里发黏"],
  "a closed-set clinical field label is removed before the remaining evidence is verified verbatim",
);
const jsonOnlyTyped = ensureQuestionStructuredEnvelope(
  JSON.stringify({ completeness: { level: "B" }, m02Plan: typedPlan }),
  "这阵子嘴里发黏，到了下午脑袋发沉",
);
assert.equal(parseM02PlanFromContent(jsonOnlyTyped)?.questions[0]?.question, typedPlan.questions[0].question, "JSON-only provider output renders the same authoritative question");
assert.match(jsonOnlyTyped, /\*\*问题1：\*\* 口中发黏在进食后是否明显加重/);

const usefulVisibleWithBrokenEnvelope = `${block(1, "腹痛是否在进食后明显加重？", ["进食后腹痛加重", "腹痛与进食无明显关系", "本次未取得该信息"])}\n\n<!-- DIAGNOSIS_JSON_START -->\n{broken`;
const preservedUsefulQuestion = ensureQuestionStructuredEnvelope(usefulVisibleWithBrokenEnvelope, "腹痛3天");
assert.match(preservedUsefulQuestion, /腹痛是否在进食后明显加重/, "malformed metadata must not silently replace a valid provider question with a generic fallback");
assert.equal(parseM02PlanFromContent(preservedUsefulQuestion)?.questions[0]?.question, "腹痛是否在进食后明显加重？");

const riskGuardedPlan = enforceM02UnansweredAxes(
  jsonOnlyTyped,
  "喝了别人递来的饮料后整个人不对劲，怀疑被下药",
  poisoningFallback,
  possiblePoisoning,
);
assert.match(parseM02PlanFromContent(riskGuardedPlan)?.questions[0]?.question || "", /接触或摄入的物质/, "grounded possible red flag is enforced in the structured plan, not only in visible text");
const semanticallyReviewed = await reviewM02QuestionPlan(
  groundedTyped,
  "现病史：进食后口中黏腻明显加重。",
  undefined,
  async () => JSON.stringify({ decisions: [{ questionId: "q1", status: "remove_known", reason: "病历已明确记录进食后加重" }] }),
);
assert.equal(parseM02PlanFromContent(semanticallyReviewed)?.decision, "proceed", "semantic review removes a paraphrased known-answer question without inventing another one");
assert.doesNotMatch(semanticallyReviewed, /口中发黏在进食后是否明显加重/);

const leadingPlan = structuredClone(typedPlan);
leadingPlan.questions[0].reason = "盗汗程度直接影响阴虚火旺的严重性判断，重度盗汗需考虑紧急处理或更积极的滋阴降火治疗。";
leadingPlan.questions[0].expectedDecisionImpact = "据此选用知柏地黄丸或天王补心丹。";
leadingPlan.questions[0].decisionBranch = "syndrome";
const leadingContent = ensureQuestionStructuredEnvelope(
  JSON.stringify({ completeness: { level: "B" }, m02Plan: leadingPlan }),
  "这阵子嘴里发黏，到了下午脑袋发沉",
);
const modelNeutralized = await reviewM02QuestionPlan(
  leadingContent,
  "这阵子嘴里发黏，到了下午脑袋发沉",
  undefined,
  async () => JSON.stringify({ decisions: [{ questionId: "q1", status: "rewrite_leading", reason: "理由提前确立证型和方药" }] }),
);
assert.equal(parseM02PlanFromContent(modelNeutralized)?.decision, "ask", "a useful question remains after its leading rationale is classified");
assert.match(parseM02PlanFromContent(modelNeutralized)?.questions[0]?.reason || "", /未确认前不预设具体证型或治法/);
assert.doesNotMatch(modelNeutralized, /阴虚火旺|知柏地黄丸|天王补心丹|滋阴降火|紧急处理/, "visible and structured surfaces both use the server-owned neutral rationale");

const fallbackNeutralized = await reviewM02QuestionPlan(
  leadingContent,
  "这阵子嘴里发黏，到了下午脑袋发沉",
  undefined,
  async () => { throw new Error("review unavailable"); },
);
assert.match(parseM02PlanFromContent(fallbackNeutralized)?.questions[0]?.reason || "", /未确认前不预设具体证型或治法/);
assert.doesNotMatch(fallbackNeutralized, /知柏地黄丸|天王补心丹/, "the deterministic backstop also neutralizes obvious prescription leakage when the reviewer is unavailable");
const oneClinicalOption = structuredClone(typedPlan);
oneClinicalOption.questions[0].options = oneClinicalOption.questions[0].options.slice(1);
const invalidOptionEnvelope = ensureQuestionStructuredEnvelope(`${oneHighValue}\n\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ completeness: { level: "B" }, m02Plan: oneClinicalOption })}\n<!-- DIAGNOSIS_JSON_END -->`);
assert.notEqual(parseM02PlanFromContent(invalidOptionEnvelope)?.questions[0]?.question, typedPlan.questions[0].question, "a single clinical branch plus unknown is not a valid single-choice plan");
const ungroundedTyped = ensureQuestionStructuredEnvelope(typedContent, "完全不同的病历文本");
assert.notEqual(parseM02PlanFromContent(ungroundedTyped)?.questions[0]?.question, typedPlan.questions[0].question, "fabricated source evidence rejects the provider plan and uses a bounded fallback");
const explicitGenericFallback = ensureQuestionStructuredEnvelope("not-json", "入睡困难");
assert.match(explicitGenericFallback, /本轮追问已降级.*通用安全追问/, "a generic M02 fallback is explicit instead of silently replacing the provider plan");

const proseState = {
  patient: {},
  symptoms: {},
  conversation: [],
  allergyHistory: undefined,
  medicationHistory: undefined,
  tongue: undefined,
  pulse: undefined,
};
const proseAnswer = "问题1：存在呕血、黑便或吞咽困难中的一项，请补充具体表现。医生补充：只是吞咽时轻微不适，否认呕血和黑便。";
const proseUpdated = applyUserAnswer(proseState, proseAnswer);
assert.equal(proseUpdated.conversation.at(-1)?.content, proseAnswer);
assert.equal(proseUpdated.allergyHistory, undefined);
assert.equal(proseUpdated.medicationHistory, undefined);
assert.equal(proseUpdated.tongue, undefined);
assert.equal(proseUpdated.pulse, undefined);
assert.deepEqual(proseUpdated.symptoms, {}, "free-text group labels must not be promoted into trusted red-flag facts by keyword parsing");

console.log(JSON.stringify({ cases: 27, failures: 0 }));
