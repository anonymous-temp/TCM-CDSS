import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildCaseAwareQuestionFallback,
  enforceM02UnansweredAxes,
  ensureQuestionStructuredEnvelope,
  ensureSingleRoundQuestionContract,
  m02QuestionRationaleNeedsNeutralization,
  neutralizeM02PlanQuestionRationales,
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

const genericDetailOnlyPlan = structuredClone(typedPlan);
genericDetailOnlyPlan.questions[0].options[1] = {
  id: "detail",
  label: "补充表现",
  answer: "请补充具体表现",
  kind: "clinical_fact",
  requiresDetail: true,
};
const genericDetailOnlyContent = ensureQuestionStructuredEnvelope(
  JSON.stringify({ completeness: { level: "B" }, m02Plan: genericDetailOnlyPlan }),
  "这阵子嘴里发黏，到了下午脑袋发沉",
);
assert.notEqual(
  parseM02PlanFromContent(genericDetailOnlyContent)?.questions[0]?.question,
  typedPlan.questions[0].question,
  "a generic detail-entry instruction is not accepted as one side of a clinical branch",
);
assert.doesNotMatch(genericDetailOnlyContent, /请补充具体表现/, "invalid JSON-only options are replaced by the bounded concrete fallback");

const genericVisibleOption = block(
  1,
  "口中发黏在进食后是否明显加重？",
  ["进食后口中发黏明显加重", "请补充实际异常", "本次未取得该信息"],
);
const genericVisibleRepaired = ensureQuestionStructuredEnvelope(genericVisibleOption, "口中发黏");
assert.doesNotMatch(genericVisibleRepaired, /请补充实际异常/, "legacy visible questions receive the same generic-option rejection");
assert.notEqual(parseM02PlanFromContent(genericVisibleRepaired)?.questions[0]?.question, "口中发黏在进食后是否明显加重？");

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
let semanticReviewPrompt = "";
const semanticallyReviewed = await reviewM02QuestionPlan(
  groundedTyped,
  "现病史：进食后口中黏腻明显加重。",
  undefined,
  async (prompt) => {
    semanticReviewPrompt = prompt;
    return JSON.stringify({ decisions: [{ questionId: "q1", status: "remove_known", reason: "病历已明确记录进食后加重" }] });
  },
);
assert.equal(parseM02PlanFromContent(semanticallyReviewed)?.decision, "proceed", "semantic review removes a paraphrased known-answer question without inventing another one");
assert.doesNotMatch(semanticallyReviewed, /口中发黏在进食后是否明显加重/);
assert.match(semanticReviewPrompt, /任一子条件已由病历明确回答/, "review contract decomposes bundled known and unknown subconditions");
assert.match(semanticReviewPrompt, /sourceEvidence/, "the independent reviewer receives the provider's claimed grounding for known-answer detection");

let conservativeReviewAttempt = 0;
const conservativelyReviewed = await reviewM02QuestionPlan(
  groundedTyped,
  "现病史：进食后口中黏腻明显加重。",
  undefined,
  async () => {
    conservativeReviewAttempt += 1;
    return JSON.stringify({ decisions: [{
      questionId: "q1",
      status: conservativeReviewAttempt === 1 ? "retain" : "remove_known",
      reason: conservativeReviewAttempt === 1 ? "未识别重复" : "病历已明确记录进食后加重",
    }] });
  },
);
assert.equal(conservativeReviewAttempt, 2, "M02 semantic review uses two independent bounded draws");
assert.equal(
  parseM02PlanFromContent(conservativelyReviewed)?.decision,
  "proceed",
  "one reviewer detecting a known bundled condition overrides another reviewer's false retain",
);

let partialReviewAttempt = 0;
const partiallyAvailableReview = await reviewM02QuestionPlan(
  groundedTyped,
  "现病史：进食后口中黏腻明显加重。",
  undefined,
  async () => {
    partialReviewAttempt += 1;
    return partialReviewAttempt === 1
      ? "not-json"
      : JSON.stringify({ decisions: [{ questionId: "q1", status: "remove_known", reason: "病历已明确回答" }] });
  },
);
assert.equal(parseM02PlanFromContent(partiallyAvailableReview)?.decision, "proceed", "one valid review remains authoritative when the parallel draw is invalid");

const allRejectedWithFallback = await reviewM02QuestionPlan(
  groundedTyped,
  "现病史：进食后口中黏腻明显加重。",
  undefined,
  async () => JSON.stringify({ decisions: [{ questionId: "q1", status: "remove_known", reason: "病历已明确记录进食后加重" }] }),
  buildCaseAwareQuestionFallback(novelCase),
);
assert.equal(parseM02PlanFromContent(allRejectedWithFallback)?.decision, "ask", "when review rejects every provider question, the route retains one bounded M02 opportunity");
assert.match(allRejectedWithFallback, /加重、缓解还是反复波动/, "the replacement is server-owned and clinically bounded rather than a model-authored filler question");

const constipationPlan = structuredClone(typedPlan);
const stoolCharacterQuestion = {
  ...constipationPlan.questions[0],
  id: "q1",
  question: "大便是干硬如羊粪，还是软条状？",
  reason: "大便性状会改变便秘的鉴别方向。",
  expectedDecisionImpact: "用于区分不同的便秘特征。",
  sourceEvidence: ["大便老解不出来"],
  options: [
    { id: "hard", label: "干硬如羊粪", answer: "大便干硬如羊粪", kind: "clinical_fact", recordValue: "大便干硬如羊粪" },
    { id: "soft", label: "软条状", answer: "大便软条状，不干硬", kind: "clinical_fact", recordValue: "大便软条状，不干硬" },
    { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
  ],
};
const knownTrajectoryQuestion = {
  ...constipationPlan.questions[0],
  id: "q2",
  question: "与刚出现时相比，便秘目前总体在加重、缓解还是反复波动？",
  reason: "症状变化趋势可能改变鉴别方向。",
  expectedDecisionImpact: "根据病情趋势调整下一步评估。",
  sourceEvidence: ["最近三个月越来越明显"],
  options: [
    { id: "worse", label: "加重", answer: "近期明显加重", kind: "clinical_fact", recordValue: "近期明显加重" },
    { id: "stable", label: "稳定或缓解", answer: "目前总体稳定、反复波动或有所缓解", kind: "clinical_fact", recordValue: "目前总体稳定、反复波动或有所缓解" },
    { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
  ],
};
const constipationContent = ensureQuestionStructuredEnvelope(
  JSON.stringify({
    completeness: { level: "B" },
    m02Plan: { ...constipationPlan, questions: [stoolCharacterQuestion, knownTrajectoryQuestion] },
  }),
  "大便老解不出来，四五天一次，肚子还胀。最近三个月越来越明显。",
);
const constipationGuarded = enforceM02UnansweredAxes(
  constipationContent,
  "大便老解不出来，四五天一次，肚子还胀。最近三个月越来越明显。",
);
assert.deepEqual(
  parseM02PlanFromContent(constipationGuarded)?.questions.map((question) => question.question),
  [stoolCharacterQuestion.question],
  "an explicit worsening trajectory suppresses only the repeated trajectory axis and preserves the unknown stool-character axis",
);

for (const source of [
  "这两周症状逐渐加重。",
  "与起初相比已经明显好转。",
  "近期总体稳定。",
  "症状一直时好时坏。",
]) {
  const fallbackOnly = enforceM02UnansweredAxes(
    ensureQuestionStructuredEnvelope(buildCaseAwareQuestionFallback({ chiefComplaint: "本次主要不适" }), source),
    source,
  );
  assert.equal(parseM02PlanFromContent(fallbackOnly)?.decision, "proceed", `known trajectory must not re-enter through the generic fallback: ${source}`);
}

const independentPositivePlan = structuredClone(typedPlan);
independentPositivePlan.questions[0] = {
  ...independentPositivePlan.questions[0],
  id: "q1",
  question: "除了反酸烧心，有没有胸痛、吞咽困难或咳嗽？",
  sourceEvidence: [],
  options: [
    { id: "a", label: "胸痛或吞咽困难", answer: "存在胸痛或吞咽困难", kind: "clinical_fact", recordValue: "存在胸痛或吞咽困难" },
    { id: "b", label: "咳嗽", answer: "存在咳嗽", kind: "clinical_fact", recordValue: "存在咳嗽" },
    { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
  ],
};
const independentPositiveContent = ensureQuestionStructuredEnvelope(
  JSON.stringify({ completeness: { level: "B" }, m02Plan: independentPositivePlan }),
  "晚上平躺反酸烧心",
);
const independentPositiveReviewed = await reviewM02QuestionPlan(
  independentPositiveContent,
  "晚上平躺反酸烧心",
  undefined,
  async () => { throw new Error("review should not be needed"); },
);
assert.equal(parseM02PlanFromContent(independentPositiveReviewed)?.decision, "proceed", "two simultaneously possible positive findings cannot be rendered as a single-choice question");

const timePrefixedPositivePlan = structuredClone(typedPlan);
timePrefixedPositivePlan.questions[0] = {
  ...timePrefixedPositivePlan.questions[0],
  question: "近半年咳嗽加重以来，是否伴有发热？",
  sourceEvidence: [],
  options: [
    { id: "a", label: "曾发热", answer: "近半年咳嗽加重期间伴有发热", kind: "clinical_fact", recordValue: "近半年咳嗽加重期间伴有发热" },
    { id: "b", label: "反复发热", answer: "近半年咳嗽加重期间反复出现发热", kind: "clinical_fact", recordValue: "近半年咳嗽加重期间反复出现发热" },
    { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
  ],
};
const timePrefixedPositiveContent = ensureQuestionStructuredEnvelope(
  JSON.stringify({ completeness: { level: "B" }, m02Plan: timePrefixedPositivePlan }),
  "抽烟多年，晨起咳白痰，近半年加重",
);
const timePrefixedPositiveReviewed = await reviewM02QuestionPlan(
  timePrefixedPositiveContent,
  "抽烟多年，晨起咳白痰，近半年加重",
  undefined,
  async () => { throw new Error("binary same-polarity choices must be rejected before semantic review"); },
);
assert.equal(parseM02PlanFromContent(timePrefixedPositiveReviewed)?.decision, "proceed", "a yes/no question cannot expose two differently worded affirmative radio choices");

const unrelatedPregnancyPlan = structuredClone(typedPlan);
unrelatedPregnancyPlan.questions = [
  { ...unrelatedPregnancyPlan.questions[0], id: "q1", sourceEvidence: [] },
  {
    ...unrelatedPregnancyPlan.questions[0],
    id: "q2",
    question: "目前是否处于妊娠或备孕状态？",
    targetField: "tcmDetail",
    decisionBranch: "treatment_safety",
    sourceEvidence: [],
    options: [
      { id: "a", label: "已妊娠", answer: "目前已经妊娠", kind: "clinical_fact", recordValue: "目前已经妊娠" },
      { id: "b", label: "未妊娠或备孕", answer: "目前未妊娠且无备孕计划", kind: "clinical_fact", recordValue: "目前未妊娠且无备孕计划" },
      { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
    ],
  },
];
const unrelatedPregnancyContent = ensureQuestionStructuredEnvelope(
  JSON.stringify({ completeness: { level: "B" }, m02Plan: unrelatedPregnancyPlan }),
  "早晨喷嚏一串串，清鼻涕不停",
);
const unrelatedPregnancyReviewed = await reviewM02QuestionPlan(
  unrelatedPregnancyContent,
  "早晨喷嚏一串串，清鼻涕不停",
  undefined,
  async () => { throw new Error("unrelated reproductive status must be removed deterministically"); },
);
assert.deepEqual(
  parseM02PlanFromContent(unrelatedPregnancyReviewed)?.questions.map((question) => question.id),
  ["q1"],
  "an unrelated pregnancy/trying-to-conceive question cannot displace a chief-complaint axis in the single M02 round",
);

const dryCoughPlan = structuredClone(typedPlan);
dryCoughPlan.questions[0] = {
  ...dryCoughPlan.questions[0],
  id: "q1",
  question: "咳嗽时有没有痰？如果有，痰是什么颜色、质地？",
  sourceEvidence: [],
  options: [
    { id: "a", label: "干咳无痰", answer: "干咳无痰", kind: "clinical_fact", recordValue: "干咳无痰" },
    { id: "b", label: "有痰", answer: "请补充痰的颜色、质地", kind: "clinical_fact", requiresDetail: true },
    { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
  ],
};
const dryCoughContent = ensureQuestionStructuredEnvelope(
  JSON.stringify({ completeness: { level: "B" }, m02Plan: dryCoughPlan }),
  "感冒好了还一直干咳，嗓子痒",
);
const dryCoughReviewed = await reviewM02QuestionPlan(
  dryCoughContent,
  "感冒好了还一直干咳，嗓子痒",
  undefined,
  async () => { throw new Error("review should not be needed"); },
);
assert.equal(parseM02PlanFromContent(dryCoughReviewed)?.decision, "proceed", "a sputum-presence question is removed when dry cough is already documented");
const dryCoughReviewedWithFallback = await reviewM02QuestionPlan(
  dryCoughContent,
  "感冒好了还一直干咳，嗓子痒",
  undefined,
  async () => { throw new Error("review should not be needed"); },
  buildCaseAwareQuestionFallback({ chiefComplaint: "感冒好了还一直干咳，嗓子痒" }),
);
assert.equal(parseM02PlanFromContent(dryCoughReviewedWithFallback)?.decision, "ask", "route-level deterministic rejection retains one bounded M02 opportunity");
assert.match(dryCoughReviewedWithFallback, /静息也喘|咯血|持续高热/, "a rejected respiratory question falls back to the server-owned respiratory safety axis");
assert.match(dryCoughReviewedWithFallback, /夜间、运动、过敏暴露|某种药物/, "the same respiratory fallback retains a discriminating trigger axis");
assert.doesNotMatch(dryCoughReviewedWithFallback, /加重、缓解还是反复波动/, "complaint-aware continuity no longer collapses to one generic trajectory question");
assert.doesNotMatch(dryCoughReviewedWithFallback, /有没有痰|痰是什么颜色/, "the rejected known-answer axis cannot reappear in the continuity fallback");

const acuteAbdomenPlan = structuredClone(typedPlan);
acuteAbdomenPlan.questions = [
  {
    ...acuteAbdomenPlan.questions[0],
    id: "q1",
    question: "腹痛是否突然加重或剧烈，并伴反跳痛、腹部僵硬、持续呕吐或停止排气排便？",
    decisionBranch: "differential",
    sourceEvidence: [],
  },
  {
    ...acuteAbdomenPlan.questions[0],
    id: "q2",
    question: "肚子胀的时候，有没有一阵一阵的绞痛或者持续性的疼痛？",
    reason: "区分急腹症（如肠梗阻）与功能性便秘，影响是否需紧急转诊。",
    expectedDecisionImpact: "若为绞痛或持续疼痛，需考虑急腹症并紧急处理；若仅为胀满无痛，可继续按便秘诊疗。",
    decisionBranch: "triage",
    sourceEvidence: [],
  },
];
const acuteAbdomenContent = ensureQuestionStructuredEnvelope(
  JSON.stringify({ completeness: { level: "B" }, m02Plan: acuteAbdomenPlan }),
  "大便四五天一次，肚子还胀",
);
const possibleAcuteAbdomen = {
  chiefComplaint: "便秘伴腹胀",
  clinicalFacts: { redFlags: [{ category: "acute_abdomen", status: "positive", urgency: "urgent", quote: "肚子还胀" }] },
};
const acuteAbdomenRiskCanonicalized = enforceM02UnansweredAxes(
  acuteAbdomenContent,
  "大便四五天一次，肚子还胀",
  buildCaseAwareQuestionFallback(possibleAcuteAbdomen),
  possibleAcuteAbdomen,
);
assert.deepEqual(
  parseM02PlanFromContent(acuteAbdomenRiskCanonicalized)?.questions.map((question) => question.question),
  ["腹痛是否突然加重或剧烈，并伴反跳痛、腹部僵硬、持续呕吐或停止排气排便？"],
  "a grounded acute-abdomen axis replaces every provider wording on the same triage branch instead of occupying two slots",
);
assert.deepEqual(parseM02PlanFromContent(acuteAbdomenRiskCanonicalized)?.questions.map((question) => question.id), ["q1"], "risk replacement reindexes IDs deterministically");
const acuteAbdomenReviewed = await reviewM02QuestionPlan(
  acuteAbdomenContent,
  "大便四五天一次，肚子还胀",
  undefined,
  async () => JSON.stringify({ decisions: [{ questionId: "q1", status: "retain", reason: "保留急腹症分诊问题" }] }),
);
assert.deepEqual(
  parseM02PlanFromContent(acuteAbdomenReviewed)?.questions.map((question) => question.id),
  ["q1"],
  "a broad acute-abdomen triage question prevents a second abdominal-pain-character question from consuming the same round",
);

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

const vagueRationalePlan = structuredClone(typedPlan);
vagueRationalePlan.questions[0].question = "受伤后有无出现肉眼血尿或排尿异常？";
vagueRationalePlan.questions[0].reason = "用于了解泌尿系统情况。";
vagueRationalePlan.questions[0].expectedDecisionImpact = "明确是否存在泌尿系统受累。";
vagueRationalePlan.questions[0].sourceEvidence = [];
const vagueRationaleContent = ensureQuestionStructuredEnvelope(
  JSON.stringify({ completeness: { level: "B" }, m02Plan: vagueRationalePlan }),
  "搬重物后腰痛",
);
const vagueRationaleNeutralized = await reviewM02QuestionPlan(
  vagueRationaleContent,
  "搬重物后腰痛",
  undefined,
  async () => JSON.stringify({ decisions: [{ questionId: "q1", status: "retain", reason: "问题本身有鉴别价值" }] }),
);
assert.match(
  parseM02PlanFromContent(vagueRationaleNeutralized)?.questions[0]?.reason || "",
  /有助于区分不同可能原因并确定下一步检查方向/,
  "a non-empty but non-actionable rationale is replaced by the branch-specific clinician-facing explanation",
);
assert.doesNotMatch(vagueRationaleNeutralized, /用于了解泌尿系统情况/, "vague model prose cannot survive only because the field is non-empty");

const knownHeadacheQualityPlan = structuredClone(typedPlan);
knownHeadacheQualityPlan.questions[0] = {
  ...knownHeadacheQualityPlan.questions[0],
  question: "头痛是什么性质，是跳痛、胀痛还是紧箍样疼痛？",
  reason: "头痛性质有助于区分不同可能原因并确定下一步检查方向。",
  expectedDecisionImpact: "根据性质调整常见头痛的鉴别顺序。",
  sourceEvidence: ["像戴了个紧箍"],
  options: [
    { id: "pulsatile", label: "跳痛或搏动痛", answer: "头痛呈跳痛或搏动痛", kind: "clinical_fact", recordValue: "头痛呈跳痛或搏动痛" },
    { id: "pressure", label: "胀紧或紧箍样", answer: "头痛呈胀紧或紧箍样", kind: "clinical_fact", recordValue: "头痛呈胀紧或紧箍样" },
    { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
  ],
};
const headacheSource = "下午脑袋像戴了个紧箍，脖子也酸；加班多的时候就来";
const headacheFallback = buildCaseAwareQuestionFallback({ chiefComplaint: "下午脑袋像戴了个紧箍，脖子也酸" });
const headachePriorityGuarded = enforceM02UnansweredAxes(
  ensureQuestionStructuredEnvelope(JSON.stringify({ completeness: { level: "B" }, m02Plan: knownHeadacheQualityPlan }), headacheSource),
  headacheSource,
  headacheFallback,
  { chiefComplaint: "下午脑袋像戴了个紧箍，脖子也酸" },
);
assert.deepEqual(
  parseM02PlanFromContent(headachePriorityGuarded)?.questions.map((question) => question.question),
  [
    "目前或本次头痛发作时，是否出现突发最剧烈头痛、发热伴颈强、说话不清或单侧肢体无力？",
    "头痛发作时是否伴有恶心、呕吐、畏光或畏声？",
  ],
  "a headache-quality question already answered by the chief complaint yields to red-flag and associated-symptom axes",
);

const episodicTemporalPlan = structuredClone(typedPlan);
episodicTemporalPlan.questions[0] = {
  ...episodicTemporalPlan.questions[0],
  question: "每次喘鸣发作时是否出现过晕厥、眼前发黑或跌倒？",
  reason: "晕厥可能改变处置优先级，需要核实当前状态。",
  expectedDecisionImpact: "用于评估目前是否需要优先急诊。",
  decisionBranch: "triage",
  sourceEvidence: [],
  options: [
    { id: "present", label: "发作时曾出现", answer: "发作时曾出现晕厥、眼前发黑或跌倒", kind: "clinical_fact", requiresDetail: true },
    { id: "absent", label: "发作时均未出现", answer: "发作时均未出现晕厥、眼前发黑或跌倒", kind: "clinical_fact", recordValue: "发作时均未出现晕厥、眼前发黑或跌倒" },
    { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
  ],
};
assert.equal(
  m02QuestionRationaleNeedsNeutralization(episodicTemporalPlan.questions[0]),
  true,
  "an episodic question cannot be justified as checking the current symptom state",
);
const episodicTemporalContent = ensureQuestionStructuredEnvelope(
  JSON.stringify({ completeness: { level: "B" }, m02Plan: episodicTemporalPlan }),
  "反复喘鸣，活动后更明显",
);
const episodicTemporalNeutralized = await reviewM02QuestionPlan(
  episodicTemporalContent,
  "反复喘鸣，活动后更明显",
  undefined,
  async (prompt) => {
    assert.match(prompt, /问题标题、追问理由与预期影响必须使用一致的时间范围/);
    assert.match(prompt, /发作时的事件.*核实当前状态/);
    return JSON.stringify({ decisions: [{ questionId: "q1", status: "retain", reason: "问题本身有分诊价值" }] });
  },
);
const episodicTemporalQuestion = parseM02PlanFromContent(episodicTemporalNeutralized)?.questions[0];
assert.equal(episodicTemporalQuestion?.question, episodicTemporalPlan.questions[0].question, "neutralization preserves the useful clinical question");
assert.match(episodicTemporalQuestion?.reason || "", /核实其是否发生及发生时的具体情况/);
assert.doesNotMatch(episodicTemporalQuestion?.reason || "", /核实当前状态/);
assert.equal(
  neutralizeM02PlanQuestionRationales(episodicTemporalNeutralized),
  episodicTemporalNeutralized,
  "the server-owned temporal rewrite is idempotent",
);

const tcmPrecommitPlan = structuredClone(typedPlan);
tcmPrecommitPlan.questions[0] = {
  ...tcmPrecommitPlan.questions[0],
  question: "发作时是否感觉心跳异常，比如心跳过快、过慢或不规律？",
  reason: "心悸是心系病证的核心症状，与主诉直接相关，影响证候分型和方药选择。",
  expectedDecisionImpact: "若伴心悸，提示心气不足或心血瘀阻；若不伴心悸，则更可能为痰饮凌心或肺气上逆。",
  decisionBranch: "syndrome",
  sourceEvidence: [],
};
assert.equal(
  m02QuestionRationaleNeedsNeutralization(tcmPrecommitPlan.questions[0]),
  true,
  "a useful question cannot pre-commit its unanswered branches to named TCM patterns or formula selection",
);
const tcmPrecommitContent = ensureQuestionStructuredEnvelope(
  JSON.stringify({ completeness: { level: "B" }, m02Plan: tcmPrecommitPlan }),
  "反复喘鸣，活动后更明显",
);
const tcmPrecommitNeutralized = neutralizeM02PlanQuestionRationales(tcmPrecommitContent);
assert.match(parseM02PlanFromContent(tcmPrecommitNeutralized)?.questions[0]?.reason || "", /未确认前不预设具体证型或治法/);
assert.doesNotMatch(tcmPrecommitNeutralized, /心系病证|心气不足|心血瘀阻|痰饮凌心|肺气上逆|方药选择/);
const oneClinicalOption = structuredClone(typedPlan);
oneClinicalOption.questions[0].options = oneClinicalOption.questions[0].options.slice(1);
const invalidOptionEnvelope = ensureQuestionStructuredEnvelope(`${oneHighValue}\n\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ completeness: { level: "B" }, m02Plan: oneClinicalOption })}\n<!-- DIAGNOSIS_JSON_END -->`);
assert.notEqual(parseM02PlanFromContent(invalidOptionEnvelope)?.questions[0]?.question, typedPlan.questions[0].question, "a single clinical branch plus unknown is not a valid single-choice plan");
const ungroundedTyped = ensureQuestionStructuredEnvelope(typedContent, "完全不同的病历文本");
assert.notEqual(parseM02PlanFromContent(ungroundedTyped)?.questions[0]?.question, typedPlan.questions[0].question, "fabricated source evidence rejects the provider plan and uses a bounded fallback");
const explicitGenericFallback = ensureQuestionStructuredEnvelope("not-json", "入睡困难");
const diarrheaFallbackVariants = [
  "最近吃点东西就想跑厕所，稀稀的有半个月",
  "拉肚子两周，一天四次",
  "饭后大便稀，反复十天",
];
for (const chiefComplaint of diarrheaFallbackVariants) {
  const visibleFallback = buildCaseAwareQuestionFallback({ chiefComplaint });
  const structuredFallback = ensureQuestionStructuredEnvelope(visibleFallback, chiefComplaint);
  const plan = parseM02PlanFromContent(structuredFallback);
  assert.equal(plan?.decision, "ask");
  assert.equal(plan?.questions.length, 2, `${chiefComplaint} must retain two complaint-family fallback axes`);
  assert.match(structuredFallback, /血便|黑便/);
  assert.match(structuredFallback, /发热|夜间|尿量/);
  assert.match(structuredFallback, /旅行|可疑饮食|生水/);
  assert.doesNotMatch(structuredFallback, /与刚出现时相比.*加重/);
}
assert.match(explicitGenericFallback, /本轮追问已降级.*与当前主诉匹配的安全追问/, "a generic M02 fallback is explicit instead of silently replacing the provider plan");
const malformedDiarrheaEnvelope = ensureQuestionStructuredEnvelope(
  "{malformed provider json",
  diarrheaFallbackVariants[0],
  buildCaseAwareQuestionFallback({ chiefComplaint: diarrheaFallbackVariants[0] }),
);
assert.equal(parseM02PlanFromContent(malformedDiarrheaEnvelope)?.questions.length, 2, "route-level parse failure must activate the complaint-family fallback instead of recreating a generic trajectory question");
assert.match(malformedDiarrheaEnvelope, /血便|黑便/);
assert.match(malformedDiarrheaEnvelope, /旅行|可疑饮食|生水/);
assert.match(malformedDiarrheaEnvelope, /模型结构化追问计划不可用/);

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

console.log(JSON.stringify({ cases: 35, failures: 0 }));
