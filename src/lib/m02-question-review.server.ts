import {
  m02QuestionRationaleNeedsNeutralization,
  neutralizeM02PlanQuestionRationales,
  parseM02PlanFromContent,
  removeM02PlanQuestions,
} from "./m02-question-contract";
import { createTextModelClient, getPrimaryTextModelConfig, isDeepseekModel } from "./text-model";

type ReviewStatus = "retain" | "rewrite_leading" | "remove_known" | "remove_duplicate" | "remove_nonexclusive";
type ReviewDecision = { questionId: string; status: ReviewStatus; reason: string };
type ReviewModelCall = (prompt: string, signal: AbortSignal) => Promise<string>;

const VALID_STATUSES = new Set<ReviewStatus>(["retain", "rewrite_leading", "remove_known", "remove_duplicate", "remove_nonexclusive"]);

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

function defaultModelCall(): ReviewModelCall | null {
  const config = getPrimaryTextModelConfig();
  if (!config.configured || !isDeepseekModel(config.model)) return null;
  const client = createTextModelClient(config);
  return async (prompt, signal) => {
    const completion = await client.chat.completions.create({
      model: config.model,
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
): Promise<string> {
  const plan = parseM02PlanFromContent(content);
  if (!plan || plan.decision !== "ask" || plan.questions.length === 0) return content;
  const deterministicLeadingIds = plan.questions
    .filter(m02QuestionRationaleNeedsNeutralization)
    .map((question) => question.id);
  const deterministicallyNeutralized = deterministicLeadingIds.length > 0
    ? neutralizeM02PlanQuestionRationales(content, deterministicLeadingIds)
    : content;
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
      "每题必须返回一个决定：retain；rewrite_leading（问题仍有价值，但理由或预期影响把未确认的诊断、具体证型/病机、治法、方药/药物、治疗强度或紧急程度当成既定事实）；remove_known（病历已明确回答，包括同义改写和相同时间范围）；remove_duplicate（与另一题询问同一事实轴）；remove_nonexclusive（A/B两个临床选项可同时成立、不是单选分支）。",
      "出现 rewrite_leading 时只做分类，不提供替代文案；服务端会使用中性模板。不要因为病历没写而删除问题，不要判断诊断是否正确。只有确有删除条件才删除。",
      "严格输出JSON：{\"decisions\":[{\"questionId\":\"q1\",\"status\":\"retain\",\"reason\":\"简短理由\"}]}。每个输入问题必须且只能出现一次。",
      `【已知病历】${clinicalSource.slice(0, 16_000)}`,
      `【结构化问题】${JSON.stringify(plan.questions.map((question) => ({
        questionId: question.id,
        question: question.question,
        reason: question.reason,
        expectedDecisionImpact: question.expectedDecisionImpact,
        decisionBranch: question.decisionBranch,
        options: question.options.map((option) => ({ kind: option.kind, answer: option.answer, recordValue: option.recordValue, requiresDetail: option.requiresDetail })),
      })))}`,
    ].join("\n\n");
    const decisions = parseReview(await call(prompt, controller.signal), plan.questions.map((question) => question.id));
    if (!decisions) return deterministicallyNeutralized;
    const removed = decisions.filter((item) => item.status.startsWith("remove_"));
    const leadingIds = new Set([
      ...deterministicLeadingIds,
      ...decisions.filter((item) => item.status === "rewrite_leading").map((item) => item.questionId),
    ]);
    const afterRemoval = removed.length > 0
      ? removeM02PlanQuestions(
          content,
          removed.map((item) => item.questionId),
          "语义复核已移除病历已回答、重复或不满足单选互斥要求的候选问题。",
        )
      : content;
    return leadingIds.size > 0
      ? neutralizeM02PlanQuestionRationales(afterRemoval, [...leadingIds])
      : afterRemoval;
  } catch {
    return deterministicallyNeutralized;
  } finally {
    clearTimeout(timeout);
    requestSignal?.removeEventListener("abort", abort);
  }
}
