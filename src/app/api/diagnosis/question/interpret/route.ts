import { readJsonRequest } from "@/lib/diagnosis-request";
import { normalizeCaseStateInput } from "@/lib/diagnosis-types";
import {
  interpretM02Answer,
  type M02AnswerInterpretationFailureCode,
} from "@/lib/m02-answer-interpreter.server";
import { parseM02Plan } from "@/lib/m02-question-contract";

export const runtime = "nodejs";

function typedFailure(
  code: M02AnswerInterpretationFailureCode,
  message: string,
  status: number,
) {
  return Response.json({
    ok: false,
    failure: { code, message, retryable: false, attempts: 0 },
  }, { status });
}

function failureStatus(code: M02AnswerInterpretationFailureCode): number {
  if (code === "invalid_request" || code === "invalid_case_state") return 400;
  if (code === "invalid_plan" || code === "invalid_answer") return 422;
  if (code === "model_not_configured") return 503;
  if (code === "model_timeout") return 504;
  if (code === "request_aborted") return 408;
  return 502;
}

export async function POST(req: Request) {
  const parsed = await readJsonRequest(req, { maxBytes: 1_000_000 });
  if (!parsed.ok) {
    return typedFailure(
      "invalid_request",
      parsed.response.status === 413 ? "请求体超过 1000000 字节限制。" : "请求体不是有效 JSON。",
      parsed.response.status,
    );
  }
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    return typedFailure("invalid_request", "请求体必须是 JSON 对象。", 400);
  }

  const body = parsed.body as Record<string, unknown>;
  if (body.caseState == null || body.m02Plan == null || body.answer == null) {
    return typedFailure("invalid_request", "caseState、m02Plan 和 answer 均为必填项。", 400);
  }

  const caseState = normalizeCaseStateInput(body.caseState);
  if (!caseState) return typedFailure("invalid_case_state", "caseState 无效。", 400);

  const plan = parseM02Plan(body.m02Plan);
  if (!plan || plan.decision !== "ask" || plan.questions.length === 0) {
    return typedFailure("invalid_plan", "m02Plan 必须是已验证且包含问题的 M02 ask plan。", 422);
  }

  if (typeof body.answer !== "string" || !body.answer.trim() || body.answer.trim().length > 6_000) {
    return typedFailure("invalid_answer", "answer 必须是 1 至 6000 字符的自由文本。", 422);
  }

  const result = await interpretM02Answer({
    caseState,
    plan,
    doctorAnswer: body.answer,
    requestSignal: req.signal,
  });
  return result.ok
    ? Response.json(result)
    : Response.json(result, { status: failureStatus(result.failure.code) });
}
