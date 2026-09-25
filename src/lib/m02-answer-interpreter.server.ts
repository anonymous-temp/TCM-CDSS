import { classifyBlanketAnswer } from "@/lib/clinical-vocabulary";
import {
  parseM02Plan,
  type M02Plan,
  type M02TargetField,
} from "./m02-question-contract";

/**
 * `POST /api/diagnosis/question/interpret` 的确定性实现：把医生对 M02 追问的自由文本回答逐题归属到
 * 计划里已授权的 targetField，recordValue 就是医生原话（去首尾空白，不改一字）。
 *
 * 2026-09-25 之前这里由模型「解读」。实验 E3（12 例真实 M02 追问 × 5 种医生口吻共 65 条）：模型给的
 * recordValue 与原话逐字相同 19 条、截成子串 30 条（截掉了「降压药一直吃着」「烟抽二十年」
 * 「高血压病史5年」「无紫绀咯血」「咽干口苦」这类临床内容）、不写入 14 条（含「说不清有无黑便」
 * 「耳朵嗡嗡响」）、失败 2 条，p50 2.6s。页面已改为直接写原话、不再调用本接口；接口因甲方验收
 * 调用过而保留，请求与响应形状不变。
 *
 * 归属规则：
 * - 整句总括回答（「都没有」「都不清楚」，受治理词表 classifyBlanketAnswer）对计划内每题生效，
 *   并带 clinicalFacts（negative / unknown）——与改动前同一条确定性通路；
 * - 否则按页面拼接回答时用的「问题<id>：」前缀切段（全角或半角冒号），一段延续到下一个前缀，
 *   可跨多行；前缀之前的文字不归属任何题；
 * - 单题计划没有前缀时整段回答归这一题；
 * - 多题计划找不到任何可识别前缀、同一题出现两次、或所有段落都为空 ⇒ answer_not_attributable
 *   （200 + ok:false），医生原话由调用方保留。
 */
export const M02_ANSWER_INTERPRETATION_SCHEMA_VERSION = "tcm-cdss-m02-answer-interpretation-v1" as const;

const MAX_ANSWER_LENGTH = 6_000;
// 对外接口文档：groundedQuotes 单条 ≤500 字符。原话段落同时是 recordValue 与唯一引文，超长不截断
// （截断就是改写医生原话），按回答过长拒绝。
const MAX_SEGMENT_LENGTH = 500;

export type M02AnswerClinicalFact = {
  status: "positive" | "negative" | "historical" | "unknown" | "uncertain";
  quote: string;
};

export type M02InterpretedAnswer = {
  questionId: string;
  targetField: M02TargetField;
  recordValue: string | null;
  clinicalFacts?: M02AnswerClinicalFact[];
  groundedQuotes: string[];
};

export type M02AnswerInterpretationFailureCode =
  | "invalid_request"
  | "invalid_case_state"
  | "invalid_plan"
  | "invalid_answer"
  | "answer_not_attributable";

export type M02AnswerInterpretationResult =
  | {
      ok: true;
      schemaVersion: typeof M02_ANSWER_INTERPRETATION_SCHEMA_VERSION;
      answers: M02InterpretedAnswer[];
    }
  | {
      ok: false;
      failure: {
        code: M02AnswerInterpretationFailureCode;
        message: string;
        retryable: boolean;
        attempts: number;
      };
    };

const FAILURE_MESSAGES: Record<M02AnswerInterpretationFailureCode, string> = {
  invalid_request: "请求体缺少 M02 回答解释所需的数据。",
  invalid_case_state: "caseState 无效。",
  invalid_plan: "M02Plan 无效、已结束或不包含可解释的问题。",
  invalid_answer: "医生自由文本回答为空或过长。",
  answer_not_attributable: "请按『问题ID：回答』逐题作答；医生原话由调用方保留",
};

function failure(code: M02AnswerInterpretationFailureCode): M02AnswerInterpretationResult {
  return { ok: false, failure: { code, message: FAILURE_MESSAGES[code], retryable: false, attempts: 0 } };
}

// 整句总括回答（闭集构词式，2026-08-26）：「都没有。」「均无」「都不清楚」这类整句总括是医生对多问追问
// 最常见的回答，语义完全由构词决定。**只匹配整句**，句中混合表达（「没有过敏，有咳嗽」）不在此列。
// 词表经受治理源 tcm-blanket-answer-forms.source.json → clinical-vocabulary 读取，
// 代码内不写中文词表（test:clinical-vocabulary-single-source 拦截）。
function blanketAnswerInterpretation(plan: M02Plan, doctorAnswer: string): M02InterpretedAnswer[] | null {
  const classified = classifyBlanketAnswer(doctorAnswer);
  if (classified === null) return null;
  const negation = classified === "negation";
  const quote = doctorAnswer.replace(/[。.!！~～\s]+$/u, "");
  if (!quote) return null;
  return plan.questions.map((question) => ({
    questionId: question.id,
    targetField: question.targetField,
    recordValue: negation ? quote : null,
    clinicalFacts: [{ status: negation ? ("negative" as const) : ("unknown" as const), quote }],
    groundedQuotes: [quote],
  }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 按「问题<id>：」前缀切段；返回 null 表示没有任何可识别前缀，"ambiguous" 表示同一题出现两次。 */
function prefixedSegments(plan: M02Plan, doctorAnswer: string): Map<string, string> | "ambiguous" | null {
  // 长 id 在前，避免 q1 吃掉 q10 的前缀；冒号紧跟 id，本身也排除了这种误配。
  const ids = plan.questions.map((question) => question.id).sort((a, b) => b.length - a.length);
  const prefix = new RegExp(`问题\\s*(${ids.map(escapeRegExp).join("|")})\\s*[：:]`, "gu");
  const matches = [...doctorAnswer.matchAll(prefix)];
  if (matches.length === 0) return null;
  const segments = new Map<string, string>();
  for (const [index, match] of matches.entries()) {
    const questionId = match[1];
    if (segments.has(questionId)) return "ambiguous";
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? doctorAnswer.length : doctorAnswer.length;
    segments.set(questionId, doctorAnswer.slice(start, end).trim());
  }
  return segments;
}

function rawAnswer(questionId: string, targetField: M02TargetField, segment: string): M02InterpretedAnswer {
  return { questionId, targetField, recordValue: segment, groundedQuotes: [segment] };
}

export function interpretM02Answer(input: { plan: unknown; doctorAnswer: unknown }): M02AnswerInterpretationResult {
  const plan = parseM02Plan(input.plan);
  if (!plan || plan.decision !== "ask" || plan.questions.length === 0) return failure("invalid_plan");

  const doctorAnswer = typeof input.doctorAnswer === "string" ? input.doctorAnswer.trim() : "";
  if (!doctorAnswer || doctorAnswer.length > MAX_ANSWER_LENGTH) return failure("invalid_answer");

  const blanket = blanketAnswerInterpretation(plan, doctorAnswer);
  if (blanket) return { ok: true, schemaVersion: M02_ANSWER_INTERPRETATION_SCHEMA_VERSION, answers: blanket };

  const segments = prefixedSegments(plan, doctorAnswer);
  if (segments === "ambiguous") return failure("answer_not_attributable");
  let answers: M02InterpretedAnswer[];
  if (segments) {
    answers = plan.questions.flatMap((question) => {
      const segment = segments.get(question.id);
      return segment ? [rawAnswer(question.id, question.targetField, segment)] : [];
    });
  } else if (plan.questions.length === 1) {
    answers = [rawAnswer(plan.questions[0].id, plan.questions[0].targetField, doctorAnswer)];
  } else {
    return failure("answer_not_attributable");
  }
  if (answers.length === 0) return failure("answer_not_attributable");
  if (answers.some((answer) => (answer.recordValue || "").length > MAX_SEGMENT_LENGTH)) return failure("invalid_answer");
  return { ok: true, schemaVersion: M02_ANSWER_INTERPRETATION_SCHEMA_VERSION, answers };
}
