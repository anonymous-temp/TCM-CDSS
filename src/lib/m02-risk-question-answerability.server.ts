import "server-only";

import { stripRiskQuestionQuotePrefix } from "./followup-conversation";
import { m02PossibleRiskQuestion } from "./m02-question-contract";
import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";

/**
 * 急症筛查题出题前的核对：这道题的答案是不是已经写在病历里（2026-10-14）。
 *
 * 做什么：事实层把某类急症线索判为需要澄清时，追问会换成该类目的固定筛查题（followup-conversation 的
 * POSSIBLE_RISK_QUESTIONS）。固定题按类目写死，不看本例病历已经写了什么。实测 242 例里 17 例出这类题，其中 13 例
 * 病历已经逐项写明：问「是否静息也喘、不能平卧、说话受限、口唇发紫」，病历写着「现能平卧，能完整成句说话，无口唇发紫」；
 * 问「是否出现说话不清、口角歪斜、单侧肢体无力」，病历写着「无言语不清，无肢体麻木无力，无头痛」。
 *
 * 为什么用模型：「病历有没有回答这道题」是开放语言上的判断（否认的写法、相反现状的写法、生命体征数值），词表判不了。
 * 做法取自「先核对可答性再提问」的研究结论（MediQ 的重复题 / 不可答题过滤；Sufficient Context 的可答性判定）：
 * 让模型只回答这一件窄事，并交出病历原文片段，服务端逐字核对片段确实在病历里。
 *
 * 边界：
 *  · 只决定「这道筛查题还要不要问」。事实层的线索本身、安全闸门的结论、剂量授权都不读这里的结果；
 *  · 只有「已写明没有」或「前提不成立」且引文全部逐字核对通过才算已回答；病历写明其中一项存在、没提到、含糊，一律照常出题；
 *  · 超时、未配置、输出非法都按「没有回答」处理（照常出题），失败结果不缓存。
 * 开关：CDSS_M02_RISK_QUESTION_ANSWERABILITY=false 关闭（一律照常出题）。
 */
const TIMEOUT_MS = (() => {
  const value = Number(process.env.M02_RISK_QUESTION_ANSWERABILITY_TIMEOUT_MS || 5_000);
  return Number.isFinite(value) && value >= 2_000 && value <= 12_000 ? Math.round(value) : 5_000;
})();
const MAX_RECORD_CHARS = 2_400;

function enabled(): boolean {
  return process.env.CDSS_M02_RISK_QUESTION_ANSWERABILITY !== "false";
}

const compact = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");

/**
 * 模型输出 → 这道题是否已由病历回答。只有 verdict 为 answered_negative / not_applicable，
 * 且至少一条引文、每条引文都能在病历里逐字找到（忽略空白）时返回 true。
 */
export function recordAnswersRiskQuestion(content: unknown, recordText: string): boolean {
  if (typeof content !== "string" || !content.trim()) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return false; }
  if (!parsed || typeof parsed !== "object") return false;
  const { verdict, quotes } = parsed as { verdict?: unknown; quotes?: unknown };
  if (verdict !== "answered_negative" && verdict !== "not_applicable") return false;
  if (!Array.isArray(quotes) || quotes.length === 0 || quotes.length > 6) return false;
  const record = compact(recordText);
  return quotes.every((quote) => {
    const text = typeof quote === "string" ? compact(quote) : "";
    return text.length >= 2 && text.length <= 60 && record.includes(text);
  });
}

export async function riskQuestionAnsweredByRecord(
  input: { recordText: string; question: string; patient?: { sex?: unknown; age?: unknown } },
  signal?: AbortSignal,
): Promise<boolean> {
  if (!enabled() || signal?.aborted) return false;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return false;
  const recordText = input.recordText.slice(0, MAX_RECORD_CHARS);
  if (!recordText.trim() || !input.question.trim()) return false;
  const messages = [
    {
      role: "system" as const,
      content: [
        "你是病历核对器，不负责诊断，也不判断病情轻重。",
        "任务：下面有一份病历和一道准备问接诊医生的急症筛查题。判断这道题的答案是否已经写在病历里。",
        "方法：把题目拆成它列举的各项表现，逐项到病历里找。",
        "- answered_negative：病历已经写明这些表现没有发生——逐项否认（如“无胸痛”“无口唇发紫”），或写了与之相反的现状（如“能平卧”“能完整成句说话”“精神尚可”“出血已止”），或记录的生命体征数值在该年龄的正常范围内（可以回答“是否高热、呼吸急促、血压下降”这类项目；儿童按年龄的正常范围）。题目列举的主要表现都有着落、且没有任何一项被病历写为存在时才选它。",
        "- not_applicable：题目的前提在本例不成立（如题目问妊娠期急症，而病历写明月经刚净、已绝经、患者为男性，或产后哺乳期且无再次妊娠的线索）。",
        // 2026-10-18 留出例 S128：瘾疹患者的过敏筛查题列着「全身风团」，那正是本次主诉；喉头肿胀、声嘶、喘憋、头晕病历都已否认，
        // 第一版因风团「存在」判 answered_positive，题照出，独立评审判问了病历已写明的内容。
        "- 题目列举的表现里，正是本次主诉或就诊原因本身的那一项（如风团患者题中的“全身风团”、腹痛患者题中的“腹痛”）不计入判断：其余各项都已否认时选 answered_negative；其余各项中有一项被写为存在时才选 answered_positive。",
        "- answered_positive：病历写明其中至少一项（主诉本身那一项除外）正在发生。",
        "- not_answered：其余情况——病历没有提到、只提到一小部分、或写法含糊。拿不准时选它。",
        "quotes：给出 1–4 条支持你判断的病历原文片段，必须逐字复制病历里的连续文字（每条不超过 30 字），不要改写、不要拼接。",
        "只输出 JSON：{\"verdict\":\"answered_negative|not_applicable|answered_positive|not_answered\",\"quotes\":[\"…\"]}，不要解释。",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        patient: { sex: input.patient?.sex ?? null, age: input.patient?.age ?? null },
        record: recordText,
        question: input.question,
      }),
    },
  ];
  return memoizedSmallTask<boolean>("m02_risk_question_answerability", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task: "m02_risk_question_answerability", stage: "question", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 220,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const content = response.choices[0]?.message?.content;
      return { value: recordAnswersRiskQuestion(content, recordText), cacheable: typeof content === "string" && content.trim().length > 0 };
    } catch {
      return { value: false, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, false, signal);
}

type RiskQuestionCase = Parameters<typeof m02PossibleRiskQuestion>[0] & { patient?: { sex?: unknown; age?: unknown } };

/**
 * 本例此刻会出的急症筛查题里，病历已经回答了的那些类目（最多核对两个）。出题路由把它们写进
 * m02SuppressedRiskCategories，这些类目就不再出筛查题。「其他急危重线索」没有固定的筛查内容，不在这里核对
 *（enforceM02UnansweredAxes 优先采用模型按该线索写的澄清题）。
 */
export async function riskCategoriesAnsweredByRecord(
  caseState: RiskQuestionCase,
  recordText: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const answered: string[] = [];
  for (let round = 0; round < 2; round += 1) {
    const risk = m02PossibleRiskQuestion({ ...caseState, m02SuppressedRiskCategories: answered });
    if (!risk || risk.category === "other_critical") break;
    const isAnswered = await riskQuestionAnsweredByRecord({
      recordText,
      question: stripRiskQuestionQuotePrefix(risk.question),
      patient: { sex: caseState?.patient?.sex, age: caseState?.patient?.age },
    }, signal);
    if (!isAnswered) break;
    answered.push(risk.category);
  }
  return answered;
}
