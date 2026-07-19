import { callDiagnosisStream } from "@/lib/diagnosis-api";
import { buildQuestionPrompt } from "@/lib/diagnosis-prompts";
import {
  buildCaseAwareQuestionFallback,
  enforceM02UnansweredAxes,
  ensureQuestionStructuredEnvelope,
} from "@/lib/m02-question-contract";
import { readCaseStateRequest } from "@/lib/diagnosis-request";
import { markdownNdjsonResponse, sanitizeCaseStateForModel, trustedInputText } from "@/lib/diagnosis-safety";
import { maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { reviewM02QuestionPlan } from "@/lib/m02-question-review.server";

export async function POST(req: Request) {
  const parsed = await readCaseStateRequest(req);
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
  const caseState = await maybeAttachClinicalFactsBackstop(parsed.caseState, undefined, req.signal);
  const fallbackQuestions = buildCaseAwareQuestionFallback(caseState);
  const fallback = ensureQuestionStructuredEnvelope(fallbackQuestions);
  const safeCaseState = sanitizeCaseStateForModel(caseState);
  const sourceText = trustedInputText(safeCaseState);
  const prompt = buildQuestionPrompt(safeCaseState);
  const response = await callDiagnosisStream(prompt, "deepseek", undefined, "question", {
    requestSignal: req.signal,
    streamErrorFallback: fallbackQuestions,
    outputTransform: (content) => enforceM02UnansweredAxes(
      ensureQuestionStructuredEnvelope(content, sourceText),
      sourceText,
      fallbackQuestions,
      caseState,
    ),
    finalOutputTransform: (content) => reviewM02QuestionPlan(content, sourceText, req.signal),
  });
  if (response.ok || req.signal.aborted) return response;
  await response.body?.cancel().catch(() => undefined);
  return markdownNdjsonResponse(fallback);
}
