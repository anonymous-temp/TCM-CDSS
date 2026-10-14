import { callDiagnosisStream } from "@/lib/diagnosis-api";
import { buildQuestionPrompt } from "@/lib/diagnosis-prompts";
import {
  buildCaseAwareQuestionFallback,
  enforceM02UnansweredAxes,
  ensureQuestionStructuredEnvelope,
  m02ClinicalFactsFootprint,
  m02ProceedPlanContent,
  m02ProceedWhenSettled,
  redFlagDispositionQuestion,
  withM02Completeness,
} from "@/lib/m02-question-contract";
import { riskCategoriesAnsweredByRecord } from "@/lib/m02-risk-question-answerability.server";
import { readCustomerBoundCaseStateRequest } from "@/lib/diagnosis-request";
import type { CaseState } from "@/lib/diagnosis-types";
import { deriveOperationalCompleteness, markdownNdjsonResponse, sanitizeCaseStateForModel, trustedInputText, evaluateSafetyGate } from "@/lib/diagnosis-safety";
import { maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { reviewM02QuestionPlan } from "@/lib/m02-question-review.server";
import { prefetchDiagnoseInputs } from "@/lib/stage-prefetch.server";
import { precomputeNoAnswerPath } from "@/lib/no-answer-precompute.server";

export async function POST(req: Request) {
  const parsed = await readCustomerBoundCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;
  if (!(parsed.caseState.chiefComplaint || parsed.caseState.hisRecord?.fields.zhushu || "").trim()) {
    return Response.json({ error: "请先填写主诉，再生成本轮关键追问。" }, { status: 422 });
  }
  if (parsed.caseState.phase !== "question") {
    return Response.json({ error: "当前流程不在追问阶段，请从现有阶段继续。" }, { status: 409 });
  }
  if (parsed.caseState.questionRounds >= parsed.caseState.maxQuestionRounds) {
    return Response.json({ error: "本轮追问已结束，请按已提供信息进入辨病辨证。" }, { status: 409 });
  }
  // 预取 M03 两半开跑前的四样输入（EviMed 检索、方名召回改写、否定增补、证候重排；见
  // stage-prefetch.server.ts）。它们只取病例字段；外部接口直调时 M03 的病例通常与此刻相同，
  // 命中缓存即省掉 M03 前置的串行等待（线上约 3.8s）。病例随后被改写只是未命中；失败静默。
  prefetchDiagnoseInputs(parsed.caseState);
  // 出题的同时按「不回答」把辨证、开方先算出来：医生跳过追问时后两步直接取现成结果（no-answer-precompute.server.ts）。
  precomputeNoAnswerPath(req, parsed.caseState);
  // 事实抽取与出题并行（2026-09-27）。外部接口按 collect → question 直调时，事实层抽取
  // （qwen3.8-max，冷启动实测 6.6s）此前必须先做完才开始出题（3.4s），M02 整段约 10s。
  // M02 只经 m02ClinicalFactsFootprint 读取事实层；先用「无事实」病例发出题，事实回来后
  // 指纹为空（绝大多数门诊病例）就采用先发结果，否则丢弃并按事实重出——结果与串行逐字等价。
  // 事实已在客户端快照或服务端缓存里时（浏览器流程先走 red-flags），走原串行路径。
  const factsReady = maybeAttachClinicalFactsBackstop(parsed.caseState, undefined, req.signal);
  const settled = await Promise.race([
    factsReady,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 30)),
  ]);
  if (settled) return questionStageResponse(settled, req.signal);
  const factFreeState: CaseState = { ...parsed.caseState, clinicalFacts: undefined };
  const speculativeController = new AbortController();
  const speculative = questionStageResponse(
    factFreeState,
    AbortSignal.any([req.signal, speculativeController.signal]),
  );
  const discardSpeculative = () => {
    speculativeController.abort();
    void speculative.then((response) => response.body?.cancel().catch(() => undefined)).catch(() => undefined);
  };
  let caseState: CaseState;
  try {
    caseState = await factsReady;
  } catch (error) {
    discardSpeculative();
    throw error;
  }
  // 先发结果可用的条件：M02 从事实层读到的内容相同，且「闸门是否已判急危重」相同——后者决定这一轮是出追问还是出
  // 急症处置确认题，而处置去向判断（disposition）不在 redFlags 清单里，指纹看不到它。
  const redFlagState = (state: CaseState) => evaluateSafetyGate(state).status === "red_flag";
  if (m02ClinicalFactsFootprint(caseState) === m02ClinicalFactsFootprint(factFreeState) &&
    redFlagState(caseState) === redFlagState(factFreeState)) return speculative;
  discardSpeculative();
  return questionStageResponse(caseState, req.signal);
}

type QuestionCaseState = CaseState & { m02SuppressedRiskCategories?: readonly string[] };

async function questionStageResponse(inputCaseState: CaseState, signal: AbortSignal): Promise<Response> {
  const safeCaseState = sanitizeCaseStateForModel(inputCaseState);
  const sourceText = trustedInputText(safeCaseState);
  // 对外信封里的 completeness 由服务端按当前病历确定性写入（与各阶段路由 withSafetyGate 同一口径），
  // 模型不打分。每个出口（成功、上游失败兜底、非 2xx 兜底）都经这一步。
  const completeness = deriveOperationalCompleteness(inputCaseState);
  const withCompleteness = (content: string) => withM02Completeness(content, completeness);
  // 安全闸门已判急危重：不再生成追问。急症已由病历本身成立，问别的类目的筛查题、辨证题或基本问诊都不合时宜
  //（2026-10-13/14 独立评审：疑似脑膜炎问卒中表现、脱水休克问大便性状、失血性休克问怕冷怕热）。
  // 调用方的流程仍要一道题时，问是否已安排急诊评估或转诊（redFlagDispositionQuestion）；允许如实返回「无需追问」时直接 proceed。
  const gate = evaluateSafetyGate(inputCaseState);
  if (gate.status === "red_flag") {
    const envelope = ensureQuestionStructuredEnvelope(
      m02ProceedWhenSettled()
        ? m02ProceedPlanContent("已识别急危重情况，应先按急症处置，本轮不再追问。")
        : redFlagDispositionQuestion(gate.redFlags || []),
      sourceText,
    );
    return markdownNdjsonResponse(withCompleteness(envelope));
  }
  // 事实层判为需要澄清的急症线索，出筛查题之前先核对病历是否已经回答；已回答的类目不再出题。
  const answeredRiskCategories = await riskCategoriesAnsweredByRecord(inputCaseState, sourceText, signal);
  const caseState: QuestionCaseState = answeredRiskCategories.length > 0
    ? { ...inputCaseState, m02SuppressedRiskCategories: answeredRiskCategories }
    : inputCaseState;
  const fallbackQuestions = buildCaseAwareQuestionFallback(caseState);
  // 模型判断「不需要再问」时用的那道题：先问病历没写到的基本问诊项（见 buildCaseAwareQuestionFallback 的 settled）。
  // 模型输出不可用（解析失败、上游失败）时仍用上面的安全兜底。
  const settledQuestions = buildCaseAwareQuestionFallback(caseState, { settled: true });
  const fallback = withCompleteness(enforceM02UnansweredAxes(
    ensureQuestionStructuredEnvelope(fallbackQuestions, sourceText),
    sourceText,
  ));
  const prompt = buildQuestionPrompt(safeCaseState, answeredRiskCategories);
  const response = await callDiagnosisStream(prompt, "deepseek", undefined, "question", {
    requestSignal: signal,
    streamErrorFallback: fallbackQuestions,
    outputTransform: (content) => withCompleteness(enforceM02UnansweredAxes(
      ensureQuestionStructuredEnvelope(content, sourceText, fallbackQuestions),
      sourceText,
      settledQuestions,
      caseState,
    )),
    finalOutputTransform: async (content) => withCompleteness(reviewM02QuestionPlan(content, sourceText, settledQuestions)),
  });
  if (response.ok || signal.aborted) return response;
  await response.body?.cancel().catch(() => undefined);
  return markdownNdjsonResponse(fallback);
}
