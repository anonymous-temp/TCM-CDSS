import {
  enforceM02UnansweredAxes,
  ensureQuestionStructuredEnvelope,
  m02QuestionRationaleNeedsNeutralization,
  neutralizeM02PlanQuestionRationales,
  parseM02PlanFromContent,
  removeM02PlanQuestions,
} from "./m02-question-contract";
import { createTextModelClient, getPrimaryTextModelConfig, isDeepseekModel } from "./text-model";

type ReviewStatus = "retain" | "rewrite_leading" | "remove_known" | "remove_duplicate" | "remove_nonexclusive" | "remove_low_priority";
type ReviewDecision = { questionId: string; status: ReviewStatus; reason: string };
type ReviewModelCall = (prompt: string, signal: AbortSignal) => Promise<string>;

const VALID_STATUSES = new Set<ReviewStatus>(["retain", "rewrite_leading", "remove_known", "remove_duplicate", "remove_nonexclusive", "remove_low_priority"]);

function startsAsIndependentPositive(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  return /^(?:患者|目前|当前|本次)?\s*(?:存在|出现|发生|伴有|伴|有)(?!无)/.test(normalized) ||
    /^(?:患者|目前|当前|本次)?\s*(?:已经|已|正在|处于)?\s*(?:妊娠|怀孕|备孕)(?!.*(?:未|无|否认))/.test(normalized);
}

function compactOption(value: string): string {
  return value.normalize("NFKC").replace(/[\s，。；、：:,.!?！？()（）\[\]【】_*_-]+/g, "");
}

function explicitlyNegativeOption(value: string): boolean {
  return /(?:没有|否认|未见|不伴|不存在|未出现|未发生|从未|无)(?!法|需)/.test(value.normalize("NFKC"));
}

function binaryPresenceOptionsNotExclusive(question: string, answers: string[]): boolean {
  if (answers.length !== 2 || !/(?:是否|有无|有没有|可有|伴不伴)/.test(question)) return false;
  const negativeCount = answers.filter(explicitlyNegativeOption).length;
  // A presence/absence question needs one affirmative and one negative branch. Two differently
  // worded positive manifestations (or two negative variants) are multi-select choices disguised
  // as a radio button and must not reach the clinician.
  return negativeCount !== 1;
}

function optionAnswersOverlap(answers: string[]): boolean {
  if (answers.length !== 2) return false;
  const [left, right] = answers.map(compactOption);
  return Boolean(left && right) && (left === right || (left.length >= 3 && right.includes(left)) || (right.length >= 3 && left.includes(right)));
}

function isUnrelatedReproductiveStatusQuestion(question: string, clinicalSource: string): boolean {
  if (!/(?:妊娠|怀孕|备孕|哺乳)/.test(question)) return false;
  // Reproductive status remains clinically important at the medication boundary, but it must not
  // displace one of the single M02 round's chief-complaint questions unless the encounter itself is
  // reproductive/obstetric. Unknown status is preserved for the later doctor-confirmation boundary.
  return !/(?:月经|经期|经量|痛经|闭经|停经|备孕|妊娠|怀孕|孕期|产后|哺乳|带下|阴道|胎动|妇科|不孕)/.test(clinicalSource);
}

function deterministicRemovalStatus(question: NonNullable<ReturnType<typeof parseM02PlanFromContent>>["questions"][number], clinicalSource: string): ReviewStatus | undefined {
  const clinicalOptions = question.options.filter((option) => option.kind === "clinical_fact");
  if (isUnrelatedReproductiveStatusQuestion(question.question, clinicalSource)) {
    return "remove_low_priority";
  }
  // Two independent positive findings are not a single-choice branch: both can be true at once.
  // Keep categorical alternatives (cold/hot, watery/formed, etc.) for the semantic reviewer.
  if (clinicalOptions.length === 2 && clinicalOptions.every((option) => startsAsIndependentPositive(option.answer))) {
    return "remove_nonexclusive";
  }
  const clinicalAnswers = clinicalOptions.map((option) => option.answer);
  if (binaryPresenceOptionsNotExclusive(question.question, clinicalAnswers) || optionAnswersOverlap(clinicalAnswers)) {
    return "remove_nonexclusive";
  }
  // "Dry cough" is already the answer to a sputum-presence question. Asking for sputum colour or
  // texture again cannot add information unless the record later documents sputum production.
  if (/(?:干咳|无痰)/.test(clinicalSource) && /(?:有没有|是否|有无).{0,16}痰|咳嗽.{0,12}痰/.test(question.question)) {
    return "remove_known";
  }
  return undefined;
}

function redundantAcuteAbdomenQuestionIds(plan: NonNullable<ReturnType<typeof parseM02PlanFromContent>>): string[] {
  const triage = plan.questions.find((question) => {
    const acuteMarkers = question.question.match(/突然|剧烈|加重|反跳痛|僵硬|持续呕吐|停止排气排便/g) || [];
    return /腹痛|肚子.{0,6}痛/.test(question.question) && acuteMarkers.length >= 2;
  });
  if (!triage) return [];
  return plan.questions.flatMap((question) =>
    question.id !== triage.id &&
    /腹痛|肚子.{0,6}痛|绞痛|持续性疼痛/.test(`${question.question}；${question.reason}；${question.expectedDecisionImpact}`)
      ? [question.id]
      : []);
}

function parseReview(value: string, questionIds: string[]): ReviewDecision[] | null {
  try {
    const parsed = JSON.parse(value) as { decisions?: unknown };
    if (!Array.isArray(parsed.decisions) || parsed.decisions.length !== questionIds.length) return null;
    const allowedIds = new Set(questionIds);
    const seen = new Set<string>();
    const decisions: ReviewDecision[] = [];
    for (const raw of parsed.decisions) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const item = raw as Record<string, unknown>;
      const questionId = typeof item.questionId === "string" ? item.questionId.trim() : "";
      const status = typeof item.status === "string" && VALID_STATUSES.has(item.status as ReviewStatus)
        ? item.status as ReviewStatus
        : undefined;
      const reason = typeof item.reason === "string" ? item.reason.trim().slice(0, 200) : "";
      if (!allowedIds.has(questionId) || seen.has(questionId) || !status || !reason) return null;
      seen.add(questionId);
      decisions.push({ questionId, status, reason });
    }
    return decisions;
  } catch {
    return null;
  }
}

const REMOVAL_PRIORITY: readonly ReviewStatus[] = [
  "remove_known",
  "remove_duplicate",
  "remove_nonexclusive",
  "remove_low_priority",
];

/**
 * M02 known-answer suppression is intentionally conservative: a single independent reviewer that
 * identifies a known, duplicate or non-exclusive axis is enough to remove it. Retention requires
 * every available review to agree that the question is usable. This prevents one false-negative
 * semantic review from leaking a bundled known subcondition back to the clinician.
 */
function fuseReviewDecisions(
  reviews: readonly ReviewDecision[][],
  questionIds: readonly string[],
): ReviewDecision[] {
  return questionIds.map((questionId) => {
    const decisions = reviews.flatMap((review) => review.filter((item) => item.questionId === questionId));
    for (const status of REMOVAL_PRIORITY) {
      const removal = decisions.find((item) => item.status === status);
      if (removal) return removal;
    }
    const rewrite = decisions.find((item) => item.status === "rewrite_leading");
    if (rewrite) return rewrite;
    const retain = decisions.find((item) => item.status === "retain");
    return retain || { questionId, status: "retain", reason: "可用语义复核未发现明确移除条件" };
  });
}

function defaultModelCall(): ReviewModelCall | null {
  const config = getPrimaryTextModelConfig();
  if (!config.configured || !isDeepseekModel(config.model)) return null;
  // M02 is generated by the fast primary model. Use the configured independent clinical-review
  // model for semantic known-answer and exclusivity checks so the generator does not grade its own
  // wording. The same approved endpoint and credentials are retained.
  const reviewModel = process.env.PRIMARY_CLINICAL_REVIEW_MODEL?.trim()
    || process.env.PRIMARY_REVIEW_MODEL?.trim()
    || config.model;
  if (!isDeepseekModel(reviewModel)) return null;
  const client = createTextModelClient(config);
  return async (prompt, signal) => {
    const completion = await client.chat.completions.create({
      model: reviewModel,
      temperature: 0,
      max_tokens: 900,
      response_format: { type: "json_object" },
      ...(isDeepseekModel(config.model) ? {
        reasoning_effort: "low" as const,
        thinking: { type: "disabled" as const },
      } : {}),
      messages: [
        { role: "system", content: "你只分类追问及其理由是否合规；不得生成诊断、处方、改写文案或新的患者事实。" },
        { role: "user", content: prompt },
      ],
    }, { signal });
    return completion.choices[0]?.message?.content || "";
  };
}

export async function reviewM02QuestionPlan(
  content: string,
  clinicalSource: string,
  requestSignal?: AbortSignal,
  modelCall?: ReviewModelCall,
  fallbackContent = "",
): Promise<string> {
  const initialPlan = parseM02PlanFromContent(content);
  if (!initialPlan || initialPlan.decision !== "ask" || initialPlan.questions.length === 0) return content;
  const deterministicRemovalIds = initialPlan.questions
    .filter((question) => deterministicRemovalStatus(question, clinicalSource))
    .map((question) => question.id)
    .concat(redundantAcuteAbdomenQuestionIds(initialPlan));
  const guardedContent = deterministicRemovalIds.length > 0
    ? removeM02PlanQuestions(
        content,
        deterministicRemovalIds,
        "确定性复核已移除病历已回答或不满足单选互斥要求的候选问题。",
      )
    : content;
  const plan = parseM02PlanFromContent(guardedContent);
  if (!plan || plan.decision !== "ask" || plan.questions.length === 0) {
    // Deterministic checks can reject the entire provider plan before the independent reviewer is
    // called (for example a dry-cough record paired with a redundant sputum-presence question, or
    // two affirmative radio options). The route always provides one server-owned trend/risk
    // fallback, so retain the same single M02 opportunity used after semantic rejection. Without
    // this branch the exact same invalid plan would sometimes proceed and sometimes ask depending
    // only on which reviewer caught it first.
    return plan?.decision === "proceed" && fallbackContent.trim()
      ? enforceM02UnansweredAxes(
          ensureQuestionStructuredEnvelope(fallbackContent, clinicalSource),
          clinicalSource,
        )
      : guardedContent;
  }
  const deterministicLeadingIds = plan.questions
    .filter(m02QuestionRationaleNeedsNeutralization)
    .map((question) => question.id);
  const deterministicallyNeutralized = deterministicLeadingIds.length > 0
    ? neutralizeM02PlanQuestionRationales(guardedContent, deterministicLeadingIds)
    : guardedContent;
  const call = modelCall || defaultModelCall();
  if (!call) return deterministicallyNeutralized;

  const controller = new AbortController();
  const abort = () => controller.abort(requestSignal?.reason);
  if (requestSignal?.aborted) abort();
  else requestSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("m02_question_review_timeout")), 15_000);
  try {
    const prompt = [
      "复核一轮供医生点选的追问。病历是唯一已知事实来源，不能使用常识补足。",
      "每题必须返回一个决定：retain；rewrite_leading（问题仍有价值，但理由或预期影响把未确认的诊断、具体证型/病机、治法、方药/药物、治疗强度或紧急程度当成既定事实，或者与问题的时间范围矛盾）；remove_known（病历已明确回答，包括同义改写和相同时间范围）；remove_duplicate（与另一题询问同一事实轴）；remove_nonexclusive（A/B两个临床选项可同时成立、不是单选分支）；remove_low_priority（妊娠/备孕、舌脉、人口学或泛化病程等问题挤占了仍未澄清的主诉直接鉴别、风险或处置轴）。",
      "问题标题、追问理由与预期影响必须使用一致的时间范围。问题询问既往或某次发作时的事件，理由却声称在“核实当前状态”，必须 rewrite_leading；问题只问目前正在发生的状态，理由却声称核实既往或发作时情况，也必须 rewrite_leading。当前处置决策可以参考既往事件，但不能把事件本身的时间改写为当前。",
      "逐题拆解标题和A/B中的每个并列子条件。只要其中任一子条件已由病历明确回答，就必须 remove_known，不能把已知子条件与另一个未知子条件用“或/和”捆绑后继续追问。例如病历已有“晚上躺下反酸”，再问“饭后或平躺时是否加重”必须 remove_known，只能由下一轮候选问题单独询问尚未知的进食关系。sourceEvidence 若本身就是某个选项的答案，也必须 remove_known。",
      "出现 rewrite_leading 时只做分类，不提供替代文案；服务端会使用中性模板。不要因为病历没写而删除问题，不要判断诊断是否正确。普通非妇产主诉不得用妊娠/备孕问题挤占本轮名额；舌脉、人口学和泛化病程也不得排在尚未知的主诉性质、时序、诱因、伴随风险与现代医学鉴别之前。只有确有删除条件才删除。",
      "严格输出JSON：{\"decisions\":[{\"questionId\":\"q1\",\"status\":\"retain\",\"reason\":\"简短理由\"}]}。每个输入问题必须且只能出现一次。",
      `【已知病历】${clinicalSource.slice(0, 16_000)}`,
      `【结构化问题】${JSON.stringify(plan.questions.map((question) => ({
        questionId: question.id,
        question: question.question,
        reason: question.reason,
        expectedDecisionImpact: question.expectedDecisionImpact,
        decisionBranch: question.decisionBranch,
        sourceEvidence: question.sourceEvidence,
        options: question.options.map((option) => ({ kind: option.kind, answer: option.answer, recordValue: option.recordValue, requiresDetail: option.requiresDetail })),
      })))}`,
    ].join("\n\n");
    const questionIds = plan.questions.map((question) => question.id);
    // Two independent draws run in parallel under one bounded deadline. One invalid/failed draw
    // cannot erase a valid decision from the other; when both fail, the deterministic backstop
    // remains authoritative and the workflow continues without inventing a new patient fact.
    const attempts = await Promise.allSettled([
      call(prompt, controller.signal),
      call(prompt, controller.signal),
    ]);
    const reviews = attempts.flatMap((attempt) => {
      if (attempt.status !== "fulfilled") return [];
      const parsed = parseReview(attempt.value, questionIds);
      return parsed ? [parsed] : [];
    });
    if (reviews.length === 0) return deterministicallyNeutralized;
    const decisions = fuseReviewDecisions(reviews, questionIds);
    const removed = decisions.filter((item) => item.status.startsWith("remove_"));
    const leadingIds = new Set([
      ...deterministicLeadingIds,
      ...decisions.filter((item) => item.status === "rewrite_leading").map((item) => item.questionId),
    ]);
    const afterRemoval = removed.length > 0
      ? removeM02PlanQuestions(
          guardedContent,
          removed.map((item) => item.questionId),
          "语义复核已移除病历已回答、重复或不满足单选互斥要求的候选问题。",
        )
      : guardedContent;
    const afterRemovalPlan = parseM02PlanFromContent(afterRemoval);
    // If every model question was rejected, that means the provider did identify a need to ask
    // but expressed it through already-known, duplicate, non-exclusive or low-priority axes. Do
    // not silently turn that reviewer outcome into "no questions needed". Offer one bounded,
    // server-owned high-value fallback instead; the unanswered-axis guard still suppresses it when
    // its concrete answer is already present. This preserves one useful M02 opportunity without
    // making information completeness a hard gate for M03/M04.
    const continuityContent = afterRemovalPlan?.decision === "proceed" && fallbackContent.trim()
      ? enforceM02UnansweredAxes(
          ensureQuestionStructuredEnvelope(fallbackContent, clinicalSource),
          clinicalSource,
        )
      : afterRemoval;
    return leadingIds.size > 0
      ? neutralizeM02PlanQuestionRationales(continuityContent, [...leadingIds])
      : continuityContent;
  } catch {
    return deterministicallyNeutralized;
  } finally {
    clearTimeout(timeout);
    requestSignal?.removeEventListener("abort", abort);
  }
}
