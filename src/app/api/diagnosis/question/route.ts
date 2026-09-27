import { callDiagnosisStream } from "@/lib/diagnosis-api";
import { buildQuestionPrompt } from "@/lib/diagnosis-prompts";
import {
  buildCaseAwareQuestionFallback,
  enforceM02UnansweredAxes,
  ensureQuestionStructuredEnvelope,
  m02ClinicalFactsFootprint,
  withM02Completeness,
} from "@/lib/m02-question-contract";
import { readCustomerBoundCaseStateRequest } from "@/lib/diagnosis-request";
import type { CaseState } from "@/lib/diagnosis-types";
import { deriveOperationalCompleteness, markdownNdjsonResponse, sanitizeCaseStateForModel, trustedInputText } from "@/lib/diagnosis-safety";
import { maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { reviewM02QuestionPlan } from "@/lib/m02-question-review.server";
import { prefetchDiagnoseInputs } from "@/lib/stage-prefetch.server";

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
  if (m02ClinicalFactsFootprint(caseState) === m02ClinicalFactsFootprint(factFreeState)) return speculative;
  discardSpeculative();
  return questionStageResponse(caseState, req.signal);
}

async function questionStageResponse(caseState: CaseState, signal: AbortSignal): Promise<Response> {
  const fallbackQuestions = buildCaseAwareQuestionFallback(caseState);
  const safeCaseState = sanitizeCaseStateForModel(caseState);
  const sourceText = trustedInputText(safeCaseState);
  // 对外信封里的 completeness 由服务端按当前病历确定性写入（与各阶段路由 withSafetyGate 同一口径），
  // 模型不打分。每个出口（成功、上游失败兜底、非 2xx 兜底）都经这一步。
  const completeness = deriveOperationalCompleteness(caseState);
  const withCompleteness = (content: string) => withM02Completeness(content, completeness);
  const fallback = withCompleteness(enforceM02UnansweredAxes(
    ensureQuestionStructuredEnvelope(fallbackQuestions, sourceText),
    sourceText,
  ));
  const prompt = buildQuestionPrompt(safeCaseState);
  const response = await callDiagnosisStream(prompt, "deepseek", undefined, "question", {
    requestSignal: signal,
    streamErrorFallback: fallbackQuestions,
    outputTransform: (content) => withCompleteness(enforceM02UnansweredAxes(
      ensureQuestionStructuredEnvelope(content, sourceText, fallbackQuestions),
      sourceText,
      fallbackQuestions,
      caseState,
    )),
    finalOutputTransform: async (content) => withCompleteness(reviewM02QuestionPlan(content, sourceText, fallbackQuestions)),
  });
  if (response.ok || signal.aborted) return response;
  await response.body?.cancel().catch(() => undefined);
  return markdownNdjsonResponse(fallback);
}
