import { redFlagExplicitOnly } from "./clinical-facts";
import { pulseOptionsMutuallyExclusive, textbookDiscriminatingQuestion, tongueOptionsMutuallyExclusive, withoutFingerVeinClause } from "./tcm-textbook-syndromes";
import { FOLLOWUP_SKIP_SENTENCE, POSSIBLE_RISK_QUESTIONS, riskQuestionQuotePrefix, riskScreeningQuestionFor, type RiskQuestionVariant } from "./followup-conversation";
import { PEDIATRIC_STRUCTURED_WORD_PATTERN, pediatricDoseRuleForAgeYears, pediatricDoseRuleForStageWords } from "./pediatric-dose-rule";
import { affirmedClinicalText } from "./clinical-polarity";
import type { Completeness } from "./diagnosis-types";

type QuestionFallbackCase = {
  patient?: { age?: number | string; sex?: string };
  chiefComplaint?: string;
  symptoms?: Record<string, unknown>;
  tongue?: string;
  pulse?: string;
  clinicalFacts?: { redFlags?: Array<{ category?: string; status?: string; urgency?: string; quote?: string; subject?: string }> };
  /** 病历已经回答了其急症筛查题的类目（路由按 m02-risk-question-answerability 的核对结果写入），这些类目不再出筛查题。 */
  m02SuppressedRiskCategories?: readonly string[];
  /**
   * 病历已写明该类急症表现正在发生的类目（核对结果 affirmed，2026-10-19）：固定筛查题「是否确实出现…」问的正是病历已写的事，
   * 不再强制出它；事实层线索仍进出题提示词，由模型问病历没写的严重度/处置一项。闸门与剂量不读这里。
   */
  m02AffirmedRiskCategories?: readonly string[];
  /**
   * 病历已逐项否认其中几项、其余未提的类目（核对结果 partly）：模型针对该线索写的澄清题（triage / treatment_safety）就用它，
   * 不再前置整张固定清单；模型没写时仍出固定筛查题兜底。
   */
  m02ModelOwnedRiskCategories?: readonly string[];
  vitals?: Record<string, unknown>;
  hisRecord?: { fields?: { age?: string; sex?: string; zhushu?: string; xianbingshi?: string; tcmDetail?: string; tcmTongue?: string; tcmPulse?: string } };
};

export const M02_TARGET_FIELDS = [
  "xianbingshi",
  "jiwangshi",
  "allergyHistory",
  "medicationHistory",
  "vitalsDetail",
  "tcmFace",
  "tcmTongue",
  "tcmPulse",
  "tcmDetail",
  "fuzhuJiancha",
] as const;

export type M02TargetField = typeof M02_TARGET_FIELDS[number];
export type M02DecisionBranch = "triage" | "differential" | "syndrome" | "treatment_safety";

export type M02PlanOption = {
  id: string;
  label: string;
  answer: string;
  // 需求1：选项须含「其他」，由医生自己输入。它与 unknown 不是一回事：
  //   unknown = 本次没取得这条信息（不写入病历）；
  //   other   = 取得了信息，但两个预设分支都不合适，医生要自己写（写入病历）。
  // 两者混用会让「问到了但答案不在选项里」被记成「没问到」，那是一条被丢掉的患者事实。
  kind: "clinical_fact" | "other" | "unknown";
  recordValue?: string;
  requiresDetail?: boolean;
};

export type M02PlanQuestion = {
  id: string;
  question: string;
  reason: string;
  targetField: M02TargetField;
  decisionBranch: M02DecisionBranch;
  expectedDecisionImpact: string;
  informationGain: number;
  sourceEvidence: string[];
  options: M02PlanOption[];
};

export type M02Plan = {
  schemaVersion: "tcm-cdss-m02-plan-v1";
  decision: "ask" | "proceed";
  rationale: string;
  questions: M02PlanQuestion[];
};

type PossibleRiskQuestion = {
  category: string;
  question: string;
  positive: string;
  negative: string;
};

const QUESTION_SENTINEL_START = "<!-- DIAGNOSIS_JSON_START -->";
const QUESTION_SENTINEL_END = "<!-- DIAGNOSIS_JSON_END -->";
const UNKNOWN_OPTION = /(?:不清楚|不确定|未取得|未能确认|不知道|待确认|未测(?:量|具体)?|未记录|说不清)/;
// 服务端确定性追加的「其他（请补充）」在 Markdown 往返后据此认回。
const OTHER_OPTION = /^\s*其他(?:（请补充）|\(请补充\))?\s*$|医生补充的具体情况/;
const LOW_VALUE_QUESTION = /(姓名|联系方式|手机号|身份证|职业|住址|爱好|喜欢.{0,4}(?:颜色|音乐|电影)|天气|早餐吃了什么)/;
const GENERIC_DETAIL_ONLY_OPTION = /^(?:(?:存在|出现|有)(?:异常|表现|情况|症状)[，,；;\s]*)?(?:请)?(?:补充|填写|记录)(?:实际|具体)?(?:异常|表现|情况|症状|信息)?[。.]?$|^(?:存在|出现|有)(?:异常|表现|情况|症状)[。.]?$/;
const M02_DECISION_BRANCHES = new Set<M02DecisionBranch>(["triage", "differential", "syndrome", "treatment_safety"]);
const M02_TARGET_FIELD_SET = new Set<string>(M02_TARGET_FIELDS);
const DEFAULT_M02_MIN_INFORMATION_GAIN = 0.6;

export function getM02MinimumInformationGain(value: unknown = process.env.M02_MIN_INFORMATION_GAIN): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0.3 && parsed <= 0.9
    ? parsed
    : DEFAULT_M02_MIN_INFORMATION_GAIN;
}
const LEADING_M02_RATIONALE = new RegExp([
  "(?:紧急|立即|尽快|积极)(?:处理|治疗|用药|干预)",
  "(?:滋阴|温阳|清热|泻火|活血|化瘀|攻下|化痰|祛湿|补气|养血|安神|通络|解表)(?:治疗|治法|法|用药)?",
  "(?:选用|使用|采用|推荐|指导|考虑)[^。；\\n]{0,36}(?:汤|丸|散|饮|丹|方|药)",
  "[\\u3400-\\u9fff]{2,18}(?:汤|丸|散|饮|丹)(?:加减)?(?:等|或|、|用于|适合|治疗)",
  "(?:直接影响|决定|明确|证实|支持|提示)[^。；\\n]{0,40}(?:证候|证型|病机|诊断|严重性)",
  "(?:阴虚|阳虚|气虚|血虚|气滞|血瘀|痰湿|湿热|寒湿|实热|虚热|火旺|肝郁|脾虚|肾虚|心神不宁)[^。；\\n]{0,30}(?:判断|权重|程度|严重性|治疗|治法|方药)",
  "(?:是|属于)[^。；\\n]{0,32}(?:病证|证候|证型|病机)(?:的)?(?:核心|主要|典型|关键)",
  "(?:影响|决定|指导)[^。；\\n]{0,24}(?:证候分型|证型|治法|方药选择|选方用药)",
  "(?:若|如)[^。；\\n]{0,50}(?:提示|支持|倾向|更可能|考虑)[^。；\\n]{0,40}(?:[气血阴阳肝心脾肺肾]|痰|湿|瘀|寒|热|火|风)[^。；\\n]{0,12}(?:虚|实|滞|瘀|阻|逆|亏|陷|郁|结|盛|衰|亢|旺|闭|饮|热|寒|湿|火)",
].join("|"));
const ACTIONABLE_M02_RATIONALE = /(?:改变|影响|区分|辨别|判别|鉴别|判断|排除|排查|决定|提示|有助|风险|安全|诊断|检查|用药|处置|治疗|优先|转诊)/;
const HISTORICAL_OR_EPISODIC_M02_QUESTION = /(?:发作时|发作期间|发作过程中|每次发作|既往|过去|曾经|曾有|是否.{0,16}(?:出现过|发生过|有过)|有无.{0,16}(?:出现过|发生过|有过))/;
const CURRENT_STATE_ONLY_M02_RATIONALE = /(?:核实|确认|了解|评估|判断).{0,12}(?:当前|目前|现在|此刻)(?:状态|情况|是否|有无|表现)/;
const CURRENT_STATE_M02_QUESTION = /(?:(?:目前|当前|现在|此刻).{0,12}(?:是否|有无|有没有|仍|还|正在|状态|情况|表现)|本次是否正在)/;
const HISTORICAL_STATE_ONLY_M02_RATIONALE = /(?:核实|确认|了解|评估|判断).{0,12}(?:既往|过去|曾经|发作时)(?:状态|情况|是否|有无|表现|经过)/;

const NEUTRAL_M02_RATIONALE: Record<M02DecisionBranch, { reason: string; expectedDecisionImpact: string }> = {
  triage: {
    reason: "该信息可能改变即时处置优先级，需要先核实其是否发生及发生时的具体情况。",
    expectedDecisionImpact: "核实结果用于决定是否需要优先现场或急诊评估；未确认前不预设风险等级。",
  },
  differential: {
    reason: "该信息有助于区分不同可能原因并确定下一步检查方向；未确认前保持未知。",
    expectedDecisionImpact: "根据回答调整鉴别方向和检查顺序；未确认前不排除或确立具体诊断。",
  },
  syndrome: {
    reason: "该信息有助于缩小证候范围；未确认前不预设具体证型或治法。",
    expectedDecisionImpact: "根据回答缩小证候范围；未确认前不确立证型、治法或方药。",
  },
  treatment_safety: {
    reason: "该信息可能影响候选治疗的适用边界和医生复核重点；未确认前不预设用药方案。",
    expectedDecisionImpact: "根据回答调整候选治疗的安全边界；未确认前不推荐具体药物、方剂或剂量。",
  },
};

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

const M02_EVIDENCE_FIELD_LABEL = /^(?:病历原文|已知病历|主诉|现病史|既往史|用药史|过敏史|生命体征|舌象|脉象|面象|问诊补充|辅助检查)[：:]\s*/;

/**
 * Providers sometimes preserve the exact clinical quote but prepend the field label shown in the
 * prompt (for example, `主诉：饭后腹胀`). The label is presentation metadata, not part of the
 * clinician-entered fact. Remove only this closed set of wrappers and retain the plan only when the
 * resulting quote still occurs verbatim in the trusted source. Paraphrases remain ungrounded.
 */
function groundedM02Evidence(value: unknown, sourceText: string): string | undefined {
  const bounded = boundedText(value, 200);
  if (!bounded) return undefined;
  if (!sourceText || sourceText.includes(bounded)) return bounded;
  const unquoted = bounded.replace(M02_EVIDENCE_FIELD_LABEL, "").replace(/^[“”"']+|[“”"']+$/g, "").trim();
  return unquoted && sourceText.includes(unquoted) ? unquoted : undefined;
}

function extractQuestionEnvelope(content: string): unknown {
  const start = content.indexOf(QUESTION_SENTINEL_START);
  const end = start >= 0 ? content.indexOf(QUESTION_SENTINEL_END, start) : -1;
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(content.slice(start + QUESTION_SENTINEL_START.length, end).trim());
  } catch {
    return null;
  }
}

export function parseM02Plan(value: unknown, sourceText = ""): M02Plan | null {
  if (!value || typeof value !== "object") return null;
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== "tcm-cdss-m02-plan-v1") return null;
  if (root.decision !== "ask" && root.decision !== "proceed") return null;
  const rationale = boundedText(root.rationale, 400);
  if (!rationale || !Array.isArray(root.questions)) return null;
  if (root.decision === "proceed" && root.questions.length !== 0) return null;
  if (root.decision === "ask" && (root.questions.length < 1 || root.questions.length > 2)) return null;

  const questions: M02PlanQuestion[] = [];
  const ids = new Set<string>();
  const normalizedQuestions = new Set<string>();
  // 逐条隔离，不连坐整份计划。
  //
  // 原实现在这个循环里到处 `return null`，而那是**整份计划**的 null：M02 一轮只问 1–2 题，
  // 第二题任何一处不合格（哪怕只是命中「姓名/天气」这类低价值词表）就让医生一道追问都拿不到。
  // 这是本仓库复发 7 次的同一形状——单条非法连坐整批（见 test:reasoning-catch-isolation
  // 记录的前 6 次：子治法 / 外治 / 中成药 / 备选方 …）。
  // 计划级失败只保留计划级的原因（rationale 缺失、decision 与题数不符、一条都不剩）。
  const rejectedQuestionIds: string[] = [];
  for (const rawQuestion of root.questions) {
    const keep = parseOneQuestion(rawQuestion);
    if (keep) questions.push(keep);
    else rejectedQuestionIds.push(
      typeof (rawQuestion as Record<string, unknown> | null)?.id === "string"
        ? String((rawQuestion as Record<string, unknown>).id) : "(无 id)");
  }
  // 一条都不剩时计划不可用——与今天的行为一致，不是新增放宽。
  if (root.decision === "ask" && questions.length === 0) return null;
  if (rejectedQuestionIds.length > 0) {
    console.warn("[tcm-cdss:m02] 逐条隔离丢弃不合格追问", { rejected: rejectedQuestionIds });
  }
  const minimumInformationGain = getM02MinimumInformationGain();
  const valuableQuestions = questions.filter((question) => question.informationGain >= minimumInformationGain);
  if (valuableQuestions.length < questions.length) {
    console.info("[tcm-cdss:m02] 低信息增益追问已跳过", {
      threshold: minimumInformationGain,
      dropped: questions.length - valuableQuestions.length,
    });
  }
  if (root.decision === "ask" && valuableQuestions.length === 0) {
    return {
      schemaVersion: "tcm-cdss-m02-plan-v1",
      decision: "proceed",
      rationale: `候选追问的预期信息增益均低于 ${minimumInformationGain.toFixed(2)}，按现有信息继续辨病辨证。`,
      questions: [],
    };
  }
  return {
    schemaVersion: "tcm-cdss-m02-plan-v1",
    decision: root.decision,
    rationale,
    questions: valuableQuestions,
  };

  function parseOneQuestion(rawQuestion: unknown): M02PlanQuestion | null {
    if (!rawQuestion || typeof rawQuestion !== "object") return null;
    const item = rawQuestion as Record<string, unknown>;
    const id = boundedText(item.id, 40);
    const question = boundedText(item.question, 240);
    const reason = boundedText(item.reason, 300);
    const expectedDecisionImpact = boundedText(item.expectedDecisionImpact, 300);
    const targetField = typeof item.targetField === "string" && M02_TARGET_FIELD_SET.has(item.targetField)
      ? item.targetField as M02TargetField
      : undefined;
    const decisionBranch = typeof item.decisionBranch === "string" && M02_DECISION_BRANCHES.has(item.decisionBranch as M02DecisionBranch)
      ? item.decisionBranch as M02DecisionBranch
      : undefined;
    const informationGain = typeof item.informationGain === "number" && Number.isFinite(item.informationGain) && item.informationGain >= 0 && item.informationGain <= 1
      ? item.informationGain
      : undefined;
    if (!id || ids.has(id) || !question || LOW_VALUE_QUESTION.test(question) || !reason || !targetField || !decisionBranch || !expectedDecisionImpact || informationGain == null) return null;
    const normalizedQuestion = comparable(question);
    if (!normalizedQuestion || normalizedQuestions.has(normalizedQuestion)) return null;
    ids.add(id);
    normalizedQuestions.add(normalizedQuestion);

    // 依据条目逐条隔离（2026-10-17）：依据只说明为什么要问，不是答案。此前多写一条（5 条）或有一条不是逐字原文
    //（病历「头痛，呈隐痛」写成「头痛呈隐痛」），整道题作废、退到主诉类别的兜底题——本地复测甲方 10 例 × 3 里 9 次、
    // 留出 32 例里 4 次是这样（离线复现病历 3：4 次生成 4 次作废，全是依据条目的问题）。现在只丢掉不能逐字核对的那条，最多留 4 条。
    // 一条都核对不上（给了依据却没有一条在病历里）仍按编造处理，整题作废。
    if (!Array.isArray(item.sourceEvidence)) return null;
    const groundedEvidence = item.sourceEvidence
      .map((entry) => groundedM02Evidence(entry, sourceText))
      .filter((entry): entry is string => Boolean(entry));
    if (item.sourceEvidence.length > 0 && groundedEvidence.length === 0) return null;
    const sourceEvidence = groundedEvidence.slice(0, 4);

    // 模型给 3 个（两个互斥临床分支 + 本次未取得）；服务端在下方确定性追加「其他（请补充）」，
    // 因此经历「结构化 → Markdown → 反解析」往返后会带 4 个回来。两种长度都必须接受，
    // 否则往返回来的计划会整份判空——这正是加「其他」时踩到的坑。
    if (!Array.isArray(item.options) || (item.options.length !== 3 && item.options.length !== 4)) return null;
    const options: M02PlanOption[] = [];
    const optionIds = new Set<string>();
    let unknownCount = 0;
    for (const rawOption of item.options) {
      if (!rawOption || typeof rawOption !== "object") return null;
      const option = rawOption as Record<string, unknown>;
      const optionId = boundedText(option.id, 40);
      const label = boundedText(option.label, 80);
      const answer = boundedText(option.answer, 300);
      // "other" 必须被接受为合法入参：本函数会在末尾确定性追加一个「其他（请补充）」，
      // 而问题计划会经历「结构化 → 渲染成 Markdown → 反解析回结构化」的往返（见 renderEnvelope
      // 与下方的 Markdown 反解析）。若不接受 other，往返回来的那一份就会因 kind 非法而整份判空。
      const kind = option.kind === "clinical_fact" || option.kind === "unknown" || option.kind === "other"
        ? option.kind
        : undefined;
      const requiresDetail = option.requiresDetail === true;
      const recordValue = boundedText(option.recordValue, 400);
      if (!optionId || optionIds.has(optionId) || !label || !answer || !kind) return null;
      if (kind === "unknown") {
        unknownCount += 1;
        if (recordValue || requiresDetail) return null;
      } else if (kind === "other") {
        // 其他项由服务端生成，形状固定：只要求医生补充，不携带预置 recordValue。
        if (recordValue) return null;
      } else if (!recordValue && !requiresDetail) {
        return null;
      } else if (isGenericDetailOnlyQuestionOption(answer)) {
        // A generic data-entry instruction is not an acquired patient fact and cannot form one
        // side of a mutually exclusive clinical branch. Reject the whole provider plan so the
        // bounded fallback can preserve workflow continuity without recording a false fact.
        return null;
      }
      optionIds.add(optionId);
      options.push({ id: optionId, label, answer, kind, recordValue, requiresDetail });
    }
    if (unknownCount !== 1 || options.filter((option) => option.kind === "clinical_fact").length !== 2) return null;
    // 「其他」由服务端确定性追加，不交给模型产出：交给模型意味着措辞不稳定、还可能漏给，
    // 而这一项是医生把「问到了、但答案不在预设分支里」写进病历的唯一入口。
    // 追加必须幂等——同一份计划会经历「结构化 → Markdown → 反解析」的往返，重复追加会让
    // 选项越滚越多。插在 unknown 之前：先给能记录事实的选项，最后才是「本次未取得」。
    if (!options.some((option) => option.kind === "other")) {
      const unknownIndex = options.findIndex((option) => option.kind === "unknown");
      const otherOption: M02PlanOption = {
        id: `${id}_other`,
        label: "其他（请补充）",
        answer: "医生补充的具体情况",
        kind: "other",
        requiresDetail: true,
      };
      options.splice(unknownIndex >= 0 ? unknownIndex : options.length, 0, otherOption);
    }
    return {
      id,
      question,
      reason,
      targetField,
      decisionBranch,
      expectedDecisionImpact,
      informationGain,
      sourceEvidence: sourceEvidence as string[],
      options,
    };
  }
}

export function parseM02PlanFromContent(content: string): M02Plan | null {
  const envelope = extractQuestionEnvelope(content);
  if (!envelope || typeof envelope !== "object") return null;
  return parseM02Plan((envelope as { m02Plan?: unknown }).m02Plan);
}

// These phrases are used only after the semantic red-flag model has emitted a
// grounded category. They are a safety fallback, not a symptom classifier.

/** possibleRiskQuestion 读取的那部分事实层红旗（唯一口径，m02ClinicalFactsFootprint 同源复用）。 */
function groundedRiskFactCandidates(state?: QuestionFallbackCase) {
  // 只认明确现症时（clinical-facts.redFlagExplicitOnly，默认）：急症筛查题只为事实层判为 urgent 的线索而出。
  // 此前 status=possible 或 urgency=clarify 就出题——生产留存里 3 例普通感冒（头痛、头晕）第一题都是
  //「是否出现突然说话不清、口角歪斜、单侧肢体无力…」，医生直接跳过。
  const suppressed = new Set([...(state?.m02SuppressedRiskCategories || []), ...(state?.m02AffirmedRiskCategories || [])]);
  const flags = (state?.clinicalFacts?.redFlags || []).filter((item) => typeof item.category === "string" && !suppressed.has(item.category));
  if (redFlagExplicitOnly()) return flags.filter((item) => item.urgency === "urgent");
  return flags.filter((item) => item.status === "possible" || item.urgency === "clarify" || item.urgency === "urgent");
}

/**
 * M02 从语义事实层读到的**全部**内容的指纹（2026-09-27，M02 事实抽取与出题并行）。
 *
 * M02 只在两处读 clinicalFacts：出题提示词的 redFlagSemanticFacts（buildQuestionPrompt 里
 * status=positive|possible 的条目）与接地风险追问（groundedRiskFactCandidates）。两份事实的指纹
 * 相同 ⇒ 提示词、兜底追问、接地风险替换三者逐字相同 ⇒ 不带事实先发的出题结果可以原样采用。
 * question 路由据此在事实抽取（qwen3.8-max，冷启动约 6.6s）进行中先发出题（约 3.4s），
 * 事实回来后指纹不同就丢弃先发结果、按事实重出——输出与串行时逐字等价，只省等待。
 * 新增任何读取 clinicalFacts 的 M02 环节，必须同时进入本指纹，否则先发结果会漏掉它。
 * 2026-10-19 起兜底题还读一处：需优先评估的线索（m02PriorityEvaluationQuestion），只读 status=positive|possible 的条目，
 * 已在 promptFacts 里（整条对象序列化，含 urgency、subject、quote）。
 */
export function m02ClinicalFactsFootprint(state?: QuestionFallbackCase): string {
  const flags = state?.clinicalFacts?.redFlags || [];
  const promptFacts = flags.filter((item) => item.status === "positive" || item.status === "possible");
  const riskFacts = groundedRiskFactCandidates(state);
  return JSON.stringify([promptFacts, riskFacts]);
}

function possibleRiskQuestion(state?: QuestionFallbackCase): PossibleRiskQuestion | undefined {
  const candidates = groundedRiskFactCandidates(state)
    .sort((left, right) => {
      const rank = (item: { status?: string; urgency?: string }) =>
        item.urgency === "urgent" ? 3 : item.urgency === "clarify" ? 2 : item.status === "possible" ? 1 : 0;
      return rank(right) - rank(left);
    });
  const category = candidates[0]?.category;
  return category ? screeningQuestionForFinding(category, candidates[0]?.quote, state) : undefined;
}

/** 兜底题看的病历全文（各字段拼接；甲方把病历放在 symptoms 的各个键下）。 */
function fallbackRecordText(state?: QuestionFallbackCase): string {
  return [
    state?.chiefComplaint,
    ...Object.values(state?.hisRecord?.fields || {}),
    ...Object.values(state?.symptoms || {}),
  ].filter((value): value is string => typeof value === "string").join("；");
}

function fallbackAgeDays(state: QuestionFallbackCase | undefined, recordText: string): number | undefined {
  return m02PatientAgeDays(state?.patient?.age ?? state?.hisRecord?.fields?.age, recordText);
}

/**
 * 某类急症线索的筛查题：类目固定题，按人群或病历写法换成 followup-conversation.RISK_QUESTION_VARIANTS 里的写法
 *（2026-10-19 r1019 第四轮）。闸门识别作答时各种写法同等对待，阳性选项不变。
 *  · 新生儿、乳婴儿的儿童危重筛查问吃奶，不问「拒绝饮水」；未满 3 岁（或年龄不详的儿童）的感染筛查不问寒战、血压；
 *  · 出血：事实层给了病历原话时，原话放在题干前（出血部位就在引文里），只问是否仍在出血及头晕心慌出冷汗；
 *    没有原话时男性去掉阴道流血一项；
 *  · 「其他急危重线索」没有类目自己的筛查内容，题干总带病历原话（2026-10-14 独立评审：脱离上下文读不出指的是什么）。
 * 闸门识别作答时会先去掉题干前的引文。
 */
function screeningQuestionForFinding(category: string, rawQuote: unknown, state?: QuestionFallbackCase): PossibleRiskQuestion | undefined {
  if (!POSSIBLE_RISK_QUESTIONS[category]) return undefined;
  const recordText = fallbackRecordText(state);
  const band = m02YoungChildBand(fallbackAgeDays(state, recordText), recordText);
  const quote = category === "other_critical" || category === "bleeding" ? riskQuestionQuote(rawQuote) : "";
  const sex = `${state?.patient?.sex || ""}${state?.hisRecord?.fields?.sex || ""}`;
  const variant: RiskQuestionVariant | undefined =
    category === "pediatric_critical" && (band === "neonate" || band === "infant") ? "infant"
      : category === "sepsis" && band ? "youngChild"
        : category === "bleeding" && quote ? "anchored"
          : category === "bleeding" && /男/u.test(sex) && !/女/u.test(sex) ? "male"
            : undefined;
  const question = riskScreeningQuestionFor(category, variant);
  if (!question) return undefined;
  return { category, ...question, question: quote ? `${riskQuestionQuotePrefix(quote)}${question.question}` : question.question };
}

/**
 * 安全闸门会列为「需优先评估」、本轮却没有筛查题的那条事实层线索（2026-10-19 r1019 第四轮，Claude 评审 B 集）。
 *
 * 急症筛查题只为 urgency=urgent 的线索而出（groundedRiskFactCandidates）；事实层判为 clarify 的阳性线索、没有类目筛查题的
 * 上消化道警示征象、以及病历已写明正在发生（affirmed）的类目，闸门都列在 priority_evaluation_required 里，而模型这一轮没问、
 * 服务端兜底题照旧问「怕冷还是怕热」，绕过了该优先问的那件事（B-MedDG-train-dialog11584#1 突然瘫软、4926#6 腹胀不排气、
 * 12121#12 黑便、12324#4 62 岁腹痛加重、14432#7 黑便后虚脱）。这里按事实层那条线索出题：
 *  · 类目有筛查题、病历没写明正在发生 → 该类目的筛查题（与急症筛查题同一张表、同一套写法，闸门照常识别作答）；
 *  · 出血类已写明正在发生 → 循环灌注筛查题（出血量够不够影响循环，是出血病例下一步要定的事），题干前带病历原话；
 *  · 其余（类目没有筛查题、「其他急危重线索」、或已写明正在发生）→ 以病历原话为题，只问这一情况近来是加重、持续还是已缓解（不进闸门识别：
 *    不是急症筛查，回答作为病历补充）。
 * 只读 status=positive|possible 的线索（m02ClinicalFactsFootprint 的 promptFacts 已覆盖，先发结果的等价性不受影响），
 * 判据与闸门的优先评估项相同（clinical-facts.priorityEvaluationItemsFromFacts：本人、clarify 及以上；只认明确现症时只认 positive）；
 * emergency 已由闸门判急危重，路由出处置题，不走这里。病历已回答其筛查题的类目（m02SuppressedRiskCategories）不再问。
 */
export function m02PriorityEvaluationQuestion(state?: QuestionFallbackCase): string | undefined {
  const answered = new Set(state?.m02SuppressedRiskCategories || []);
  const affirmed = new Set(state?.m02AffirmedRiskCategories || []);
  const finding = (state?.clinicalFacts?.redFlags || [])
    .filter((item) => typeof item.category === "string" && !answered.has(item.category) &&
      (item.subject ?? "patient") === "patient" &&
      (item.status === "positive" || (!redFlagExplicitOnly() && item.status === "possible")) &&
      (item.urgency === "urgent" || item.urgency === "clarify"))
    .sort((left, right) => (left.urgency === "urgent" ? 0 : 1) - (right.urgency === "urgent" ? 0 : 1))[0];
  if (!finding?.category) return undefined;
  const category = finding.category;
  const quote = riskQuestionQuote(finding.quote);
  const reason = "这一线索可能需要急诊或优先处置，需先由医生核实。";
  if ((category === "gi_bleed" || category === "bleeding") && affirmed.has(category)) {
    const shock = POSSIBLE_RISK_QUESTIONS.shock;
    return questionBlock(1, `${quote ? riskQuestionQuotePrefix(quote) : ""}${shock.question}`, reason, "现病史", [shock.positive, shock.negative, FOLLOWUP_SKIP_SENTENCE]);
  }
  // 「其他急危重线索」的筛查题只问「是否仍在发生」，答「仍在发生」即按急症确认处理——那是为 urgent 线索设的；
  // 这里的线索可能只到 clarify 级，改问近来的变化，不把一句「仍在」升成急症。
  const screening = affirmed.has(category) || category === "other_critical" ? undefined : screeningQuestionForFinding(category, finding.quote, state);
  if (screening) return questionBlock(1, screening.question, reason, "现病史", [screening.positive, screening.negative, FOLLOWUP_SKIP_SENTENCE]);
  if (!quote) return undefined;
  return questionBlock(
    1,
    `${riskQuestionQuotePrefix(quote)}这一情况近来是在加重、持续，还是已经缓解？`,
    reason,
    "现病史",
    ["近来加重或出现新表现，请补充具体表现", "已经缓解，目前未再出现", FOLLOWUP_SKIP_SENTENCE],
  );
}

/**
 * 结构化生命体征四项（体温、脉搏、呼吸、血压）都已录入。此时问「生命体征」的题（targetField=vitalsDetail）问的是病历已有的内容。
 * 实测（2026-10-14）：病历文本里体征只有数值没有指标名（「生命体征：90」），模型问出「生命体征栏记录的 90 指的是哪一项」；
 * 文本保持原样（改它会让语义层的安全判断漂移，见 diagnosis-safety.trustedInputText），这里按结构化字段判。
 */
function structuredVitalsComplete(state?: QuestionFallbackCase): boolean {
  const vitals = state?.vitals;
  if (!vitals || typeof vitals !== "object") return false;
  const has = (keys: readonly string[]) => keys.some((key) => {
    const value = (vitals as Record<string, unknown>)[key];
    return (typeof value === "string" && value.trim().length > 0) || (typeof value === "number" && Number.isFinite(value));
  });
  return has(["T", "temperature", "temp"]) && has(["P", "pulse", "HR", "heartRate"]) &&
    has(["R", "respiration", "RR", "respiratoryRate"]) && has(["BP", "bp", "bloodPressure"]);
}

/** 路由用：本例此刻会出的急症筛查题（没有则 undefined）。 */
export function m02PossibleRiskQuestion(state?: QuestionFallbackCase): { category: string; question: string } | undefined {
  const risk = possibleRiskQuestion(state);
  return risk ? { category: risk.category, question: risk.question } : undefined;
}

function riskQuestionQuote(value: unknown): string {
  return typeof value === "string" ? value.replace(/[“”"\s]+/g, "").slice(0, 60) : "";
}

function questionBlock(index: number, question: string, reason: string, field: string, options: [string, string, string]): string {
  return [
    `**问题${index}：** ${question}`,
    `（追问理由：${reason}）`,
    `补录字段：${field}`,
    "可选项：",
    `A. ${options[0]}`,
    `B. ${options[1]}`,
    `C. ${options[2]}`,
  ].join("\n");
}

/**
 * 没有可问的教材辨证题时，问一条病历里还没写到的基本问诊项（寒热 / 口渴 / 大便 / 汗）。
 *
 * 2026-10-13：模型判断「不需要再问」而调用方的流程仍要一道题时，以前给的是「总体在加重、缓解还是反复波动」
 *（合成集 190 例里 12 例），对辨证没有用。这四项是区分寒热虚实的基本依据；每项只在病历完全没有提到时才问，
 * 四项都写了就返回 undefined，由后面的兜底接手。记录判据是闭集词形，只用来决定「问不问」，不参与任何安全判断。
 * 选项不带「或」（2026-10-19 r1019 复测：「口不渴，或只想喝少量热水」两次被评审判「选项含或、不能直接写进病历」）。
 */
const BASIC_INQUIRY_COLD_HEAT_QUESTION = "平时或这次发病以来，是怕冷还是怕热？";
const BASIC_INQUIRY_THIRST_QUESTION = "口渴吗？想喝凉的还是热的？";
type BasicInquiryAxis = {
  recorded: RegExp;
  question: string;
  /** 病程按小时/天计时的题干（只问这次发病以来，不问平时）。 */
  acuteQuestion: string;
  options: [string, string];
};
// 大便：拉肚子、拉稀、稀便、水样便、排便、拉屎、臭臭、奶瓣是同一项的口语写法（2026-10-19 r1019 第四轮：病历写着「拉肚子」
// 「3天没拉臭臭」「拉绿屎」仍被问大便情况）。
const STOOL_RECORDED = /大便|便秘|便溏|便干|便稀|腹泻|泄泻|下利|二便|拉肚子|拉稀|稀便|水样便|排便|未便|便便|(?:拉|绿|黄|稀|干)屎|臭臭|奶瓣|拉了/;
// 寒热：发烧、高烧、低烧与发热同义；寒战、发抖是怕冷的表现（2026-10-19，r1019：「发高烧39.6…烧的发抖」被问「怕冷还是怕热」，评审判重复）。
const COLD_HEAT_RECORDED = /怕冷|畏寒|恶寒|畏冷|形寒|怕热|恶热|发热|发烧|高烧|低烧|身热|烘热|潮热|烦热|手足心热|肢冷|不温|(?:手|脚|足)[^，,。；;]{0,3}(?:冰|凉)|喜暖|喜温|得温|得热|遇寒|遇冷|受凉|喜凉|喜冷|恶风|怕风|寒热|寒战|冷战|发抖|冰冷|冰凉|发冷/;
const BASIC_INQUIRY_AXES: ReadonlyArray<BasicInquiryAxis> = [
  {
    recorded: COLD_HEAT_RECORDED,
    question: BASIC_INQUIRY_COLD_HEAT_QUESTION,
    acuteQuestion: "这次发病以来，是怕冷还是怕热？",
    options: ["怕冷，喜暖，手脚偏凉", "怕热，喜凉"],
  },
  {
    recorded: /口渴|口干|咽干|不渴|喜饮|欲饮|饮水|饮冷|饮热|热饮|冷饮|口淡|口苦|口黏|口腻/,
    question: BASIC_INQUIRY_THIRST_QUESTION,
    acuteQuestion: BASIC_INQUIRY_THIRST_QUESTION,
    options: ["口干口渴，想喝凉的", "口不渴，想喝热的"],
  },
  {
    recorded: STOOL_RECORDED,
    question: "平时大便情况怎样？",
    acuteQuestion: "这次发病以来大便情况怎样？",
    options: ["大便干结，排便费力", "大便稀溏，不成形"],
  },
  {
    recorded: /汗/,
    question: "平时出汗情况怎样？",
    acuteQuestion: "这次发病以来出汗情况怎样？",
    options: ["白天稍一活动就出汗", "夜间睡着后出汗，醒来汗止"],
  },
];

/**
 * 未满 3 岁的婴幼儿（或年龄不详的儿童）用的基本问诊项（2026-10-19 r1019 第四轮，Claude 评审 B 集）。
 *
 * 寒热喜恶、口渴喜冷喜热是患者自己的感受：8 月龄、15 月龄、28 天的孩子被问「想喝凉的还是热的」「怕冷还是怕热」，
 * 评审 6 例判家长无从回答、选项写不进病历（B-IMCS21-train-10252189#12、10877829#5、dev-10347222#5、test-10334253#9、
 * train-10811814#9、10717789#11）；4 天、10 天的新生儿被问「平时大便情况怎样」——新生儿没有「平时」，母乳儿大便本就稀糊，
 * 胎黄要看的是大便颜色（10312916#7、dev-10192726#9）。
 * 改问家长看得到的：吃奶或进食、大便（新生儿问颜色：灰白如陶土是胆道梗阻的报警征象）、精神、手脚温凉、睡着后出汗。
 * 吃奶或进食在最前：喂养明显减少既是儿科望问的基本项，也是婴幼儿病情轻重的首要观察点。新生儿不问手脚温凉与出汗
 *（新生儿手脚偏凉、出汗少都很常见，答案不区分寒热虚实）。记录判据同上，只决定问不问。
 */
export type M02YoungChildBand = "neonate" | "infant" | "toddler" | "child_unknown_age";
type YoungChildAxis = { recorded: RegExp; skip?: readonly M02YoungChildBand[]; question: (band: M02YoungChildBand) => string; options: (band: M02YoungChildBand) => [string, string] };
const breastfeeding = (band: M02YoungChildBand) => band === "neonate" || band === "infant";
const YOUNG_CHILD_INQUIRY_AXES: ReadonlyArray<YoungChildAxis> = [
  {
    recorded: /吃奶|喂奶|奶量|拒奶|吐奶|溢奶|喂养|进食|食欲|胃口|纳差|纳呆|纳少|纳可|纳食|纳谷|吃饭|吃东西|不爱吃|不想吃|不肯吃|不吃|饮食/,
    question: (band) => breastfeeding(band) ? "这几天吃奶和平时比怎样？" : "这几天孩子吃东西和平时比怎样？",
    options: (band) => breastfeeding(band) ? ["吃奶明显比平时少", "吃奶和平时差不多"] : ["吃得明显比平时少", "吃得和平时差不多"],
  },
  {
    recorded: STOOL_RECORDED,
    question: (band) => band === "neonate" ? "大便是什么颜色？" : "这几天大便怎样？",
    options: (band) => band === "neonate" ? ["大便黄色", "大便颜色发白，像陶土"] : ["大便稀，次数比平时多", "大便干，排便费力"],
  },
  {
    recorded: /精神|萎靡|嗜睡|蔫|玩耍|爱玩|反应差|反应迟钝/,
    question: () => "这几天精神怎样？",
    options: () => ["精神差，总想睡、不爱动", "精神好，和平时一样"],
  },
  {
    recorded: COLD_HEAT_RECORDED,
    skip: ["neonate"],
    question: () => "摸孩子的手脚，是偏凉还是偏热？",
    options: () => ["手脚偏凉", "手心脚心偏热"],
  },
  {
    recorded: /汗/,
    skip: ["neonate"],
    question: () => "孩子睡着后出汗多吗？",
    options: () => ["睡着后头颈背部出汗多", "睡着后出汗不多"],
  },
];

/**
 * 患者年龄（天）。只认「N天/周/个月/岁」与病历里的「出生/生后 N 天」「新生儿」；给不出返回 undefined。
 * 用途：婴幼儿不问说不出的主观感受，也不问脉象（m02YoungChildBand）。
 */
export function m02PatientAgeDays(age: unknown, recordText = ""): number | undefined {
  const fromText = (text: string): number | undefined => {
    const match = /(\d+(?:\.\d+)?)\s*(天|日|周|个月|月|岁)/u.exec(text);
    if (!match) return undefined;
    const value = Number(match[1]);
    return match[2] === "岁" ? value * 365 : match[2] === "周" ? value * 7 : /月/u.test(match[2]) ? value * 30 : value;
  };
  if (typeof age === "number" && Number.isFinite(age)) return age * 365;
  if (typeof age === "string" && age.trim()) {
    if (/^\d+(?:\.\d+)?$/u.test(age.trim())) return Number(age.trim()) * 365;
    const parsed = fromText(age);
    if (parsed != null) return parsed;
  }
  // 「月子娃」「月子里的宝宝」是新生儿（2026-10-19 r1019 第四轮，B-IMCS21-dev-10354982#1）。
  if (/新生儿|月子(?:里的?)?(?:娃|宝宝|孩子|婴儿)/u.test(recordText)) return 14;
  const born = /(?:出生|生后|出生后)\s*(?:第)?\s*(\d{1,2})\s*(?:天|日)/u.exec(recordText);
  if (born) return Number(born[1]);
  // 叙述里紧贴着孩子称谓的月龄、日龄（「娃儿55天了」「50多天的宝宝」「宝宝八个月」不认——中文数字不在此列）：
  // 年龄栏为空时病历常这样写（同轮 B-IMCS21-train-10365137#10、test-10216174#9）。
  // 「生完孩子12天」说的是产妇产后天数，不是孩子的年龄（排除生、产一类动词后的称谓）。
  const childAge = /(?<![生产]完|[生产]了|[生产]下)(?:宝宝|宝贝|娃儿?|孩子|小孩|婴儿)\s*(?:才|已经|今天|现在)?\s*(\d{1,3})\s*多?\s*(天|周(?!岁)|个月)|(\d{1,3})\s*多?\s*(天|周(?!岁)|个月)(?:大)?的(?:宝宝|宝贝|娃|孩子|小孩|婴儿)/u.exec(recordText);
  if (childAge) {
    const value = Number(childAge[1] ?? childAge[3]);
    const unit = childAge[2] ?? childAge[4];
    return unit === "天" ? value : unit === "周" ? value * 7 : value * 30;
  }
  return undefined;
}

/**
 * 未满 3 岁的档位（新生儿 / 乳婴儿 / 幼儿），或年龄不详的儿童；3 岁及以上、成人、判不出是儿童时返回 undefined。
 * 数值年龄按儿童剂量档位表（pediatric-dose-rule，与安全门同一张表）定档；没有数值年龄时看病历里的婴幼儿档位词，
 * 只有「宝宝、孩子、患儿」这类不带年龄段的词时按年龄不详的儿童处理——家长看得到的问法对任何年龄的孩子都成立，
 * 主观感受题对说不清的孩子不成立（B-IMCS21-test-10148432#4「宝宝病毒感染反复高烧」被问想喝凉的还是热的）。
 */
export function m02YoungChildBand(ageDays: number | undefined, recordText = ""): M02YoungChildBand | undefined {
  const young = (stage: string | undefined): M02YoungChildBand | undefined =>
    stage === "neonate" || stage === "infant" || stage === "toddler" ? stage : undefined;
  if (ageDays != null) return young(pediatricDoseRuleForAgeYears(ageDays / 365)?.stage);
  const worded = pediatricDoseRuleForStageWords(recordText);
  if (worded) return young(worded.stage);
  // 「娃、宝贝」是家长对孩子的称呼，儿童定性词表里没有（只用于这里的问法选择，不进剂量与安全判断）。
  return PEDIATRIC_STRUCTURED_WORD_PATTERN.test(recordText) || /娃|宝贝/u.test(recordText) ? "child_unknown_age" : undefined;
}

/**
 * 病程按小时、天计，且没有按周、月、年计的病程或「反复、平时」一类的长期说法：基本问诊题只问「这次发病以来」。
 * 「平时或这次发病以来」把体质和本次病情混在一问里，急性吐泻的回答含糊（2026-10-19 r1019 第四轮，B-MedDG-train-dialog4866#1）。
 * 判不出时保持原题干。只决定题干措辞。
 */
// 「一天上拉3/4次」是频次不是病程：天数后面几个字内跟着「次」的不算。
const ACUTE_COURSE = /(?:\d+|[一二两三四五六七八九十几半])\s*(?:个)?(?:小时|天|日)(?![^，,。；;]{0,6}次)|今天|今日|今早|今晨|昨天|昨日|昨晚|昨夜|前天|刚才|突然|突发/;
const LONG_COURSE = /(?:\d+|[一二两三四五六七八九十几半多])\s*(?:个)?(?:周|星期|月|年)|多年|反复|经常|常年|一直|长期|平时|平素|素来|慢性|有时|总是|老是|时常|常常|每天|每次|每到|一段时间|很长时间|又犯|从小/;
export function m02AcuteCourse(courseText: string): boolean {
  return ACUTE_COURSE.test(courseText) && !LONG_COURSE.test(courseText);
}

export function basicInquiryFallback(
  recordText: string,
  options: { ageDays?: number; courseText?: string } = {},
): string | undefined {
  const band = m02YoungChildBand(options.ageDays, recordText);
  if (band) {
    const axis = YOUNG_CHILD_INQUIRY_AXES.find((item) => !item.recorded.test(recordText) && !item.skip?.includes(band));
    return axis
      ? questionBlock(1, axis.question(band), "这一项家长能直接观察到，有助于判断病情轻重与寒热虚实，目前病历里没有写到。", "现病史",
        [...axis.options(band), "本次未取得该信息"])
      : undefined;
  }
  const acute = m02AcuteCourse(options.courseText ?? recordText);
  const axis = BASIC_INQUIRY_AXES.find((item) => !item.recorded.test(recordText));
  return axis
    ? questionBlock(1, acute ? axis.acuteQuestion : axis.question, "这一项有助于区分寒热虚实，目前病历里没有写到。", "现病史", [...axis.options, "本次未取得该信息"])
    : undefined;
}

/**
 * 病历已经把寒热、口渴、大便、汗出都写到、模型也没有要问的题时的最后一道题（2026-10-14）。
 *
 * 此前这种情况退到主诉类别预置的题——那是模型输出不可用时的安全兜底，问的往往正是病历已经写明的内容
 *（关节红肿热痛、发热 37.9℃ 的病例被问「是否伴明确外伤、发热或局部红肿热」；急性咳喘 3 天被问「是否与夜间、运动、过敏暴露有关」）。
 * 病历确已足够时，如实的做法是不追问（decision=proceed，见 m02ProceedWhenSettled）；调用方的流程仍要一道题时，
 * 问一句不预设内容的开放题——「除了上面这些，还有没有别的不舒服」。门诊交流研究里，这样问能让患者说出原本没提的问题。
 */
export function agendaQuestionFallback(): string {
  return questionBlock(
    1,
    "除病历已记录的情况外，患者还有没有其他不适需要一并处理？",
    "病历已写明主要症状与寒热、饮食二便等情况；确认没有遗漏的不适后即可辨证。",
    "现病史",
    ["还有其他不适，请补充具体表现", "没有其他不适", "本次未取得该信息"],
  );
}

/** 病历已经写了病情变化（反复、时消时现、加重、缓解…）——再问「总体在加重还是缓解」就是复述病历。 */
const COURSE_TREND_RECORDED = /反复|时消时现|时作时止|时发时止|时轻时重|时好时坏|逐渐加重|加重|减轻|缓解|好转|如故|波动/;

function genericModelFailureFallback(state: QuestionFallbackCase): string {
  // 2026-10-17（甲方标准病历 9）：病历写着「时消时现…药效过后仍反复出现」，这道题照样问「总体在加重、缓解还是反复波动」，
  // 题干还原样嵌着主诉「皮肤瘙痒伴风团2+天」。病历已写病情变化时改问开放的「还有没有其他不适」；题干不再抄主诉。
  const recordText = [
    state.chiefComplaint,
    ...Object.values(state.hisRecord?.fields || {}),
    ...Object.values(state.symptoms || {}),
  ].filter((value): value is string => typeof value === "string").join("；");
  if (COURSE_TREND_RECORDED.test(recordText)) return agendaQuestionFallback();
  return questionBlock(
    1,
    "与刚出现时相比，目前主要不适总体在加重、缓解还是反复波动？",
    "症状变化趋势通常会改变当前处置优先级和下一步鉴别方向。",
    "现病史",
    [
      "近期明显加重或出现新表现，请补充具体变化",
      "目前总体稳定、反复波动或有所缓解",
      "本次未取得该信息",
    ],
  );
}

type ComplaintFallbackProfile = {
  pattern: RegExp;
  questions: Array<{
    question: string;
    reason: string;
    options: [string, string, string];
  }>;
};

// When the model question plan is malformed, retain one clinically useful M02 opportunity instead
// of asking the same generic trajectory question for every patient. These are complaint-family
// decision axes, not diagnoses: every positive branch asks the clinician to record the actual
// finding, every negative branch preserves explicit polarity, and unknown always remains valid.
// Keeping the catalog here also means new complaint families can be regression-tested without
// changing provider prompts or teaching the parser patient-specific strings.
const COMPLAINT_FALLBACK_PROFILES: readonly ComplaintFallbackProfile[] = [
  {
    pattern: /(?:腹泻|稀便|拉肚子|便溏|大便稀|稀稀|(?:吃|饭)[^。；\n]{0,18}(?:跑厕所|上厕所))/,
    questions: [
      {
        question: "本次稀便是否出现血便或黑便、发热、夜间拉醒、持续呕吐，或口渴明显但尿量减少？",
        reason: "这些表现可能改变当前处置优先级，并区分需尽快检查的情形；未确认前不预设风险。",
        options: ["存在上述任一表现，请补充具体表现", "经询问均未出现上述表现", "本次未取得该信息"],
      },
      {
        question: "起病前是否有外出旅行、可疑饮食或生水暴露，或家人同事出现类似稀便？",
        reason: "暴露和聚集线索有助于区分感染性与其他常见原因，并确定是否需要粪便或流行病学检查。",
        options: ["存在上述任一暴露或同时发病线索，请补充具体情况", "经询问均无上述暴露和同时发病线索", "本次未取得该信息"],
      },
    ],
  },
  {
    pattern: /(?:便秘|排便(?:困难|费劲|不畅)|大便[^。；\n]{0,12}(?:解不出来|拉不出来|干结|颗粒))/,
    questions: [
      {
        question: "便秘期间是否出现便血或黑便、持续呕吐、停止排气、明显消瘦，或腹痛迅速加重？",
        reason: "这些表现可能改变处置优先级，并影响是否先行检查而非继续常规调理。",
        options: ["存在上述任一表现，请补充具体表现", "经询问均未出现上述表现", "本次未取得该信息"],
      },
      {
        question: "近期饮水、活动和排便药使用情况是否有明显变化？",
        reason: "可改变的生活方式和药物因素会改变便秘的原因排序与用药安全边界。",
        options: ["存在饮水少、活动少或排便药变化，请补充具体情况", "经询问饮水、活动和排便药均无明显变化", "本次未取得该信息"],
      },
    ],
  },
  {
    pattern: /(?:反酸|烧心|嗳气|吞咽|餐后|饭后)[^。；\n]{0,20}(?:胀|烧|酸|堵)|(?:上腹|胃|肚子上边)[^。；\n]{0,10}胀/,
    questions: [
      {
        question: "是否出现吞咽困难或进行性卡顿、呕血或黑便、持续呕吐或不明原因体重下降？",
        reason: "这些警示线索会改变上消化道症状的检查和处置优先级。",
        options: ["存在上述任一表现，请补充具体表现", "经询问均未出现上述表现", "本次未取得该信息"],
      },
      {
        question: "症状与进食、平卧、夜宵或辛辣食物是否有稳定关系？",
        reason: "明确诱因和时相有助于区分常见的反流、消化不良和其他上消化道原因。",
        options: ["与进食、平卧、夜宵或辛辣食物存在明显关系，请补充具体规律", "经询问与上述因素均无明显关系", "本次未取得该信息"],
      },
    ],
  },
  {
    pattern: /(?:咳嗽|干咳|咳痰|喉咙痒|嗓子痒|喘鸣|气短|气促|呼吸困难|懋醒)/,
    questions: [
      {
        question: "是否出现静息也喘、说话受限、口唇发紫、咯血、胸痛或持续高热？",
        reason: "这些表现可能改变呼吸道问题的即时处置优先级和检查顺序。",
        options: ["存在上述任一表现，请补充具体表现", "经询问均未出现上述表现", "本次未取得该信息"],
      },
      {
        question: "症状是否与夜间、运动、过敏暴露或某种药物有明显关系？",
        reason: "诱因与缓解规律会改变咳嗽、喘鸣的原因排序和后续检查方向。",
        options: ["与夜间、运动、过敏暴露或药物存在明显关系，请补充具体情况", "经询问与上述因素均无明显关系", "本次未取得该信息"],
      },
    ],
  },
  {
    pattern: /(?:腰|颈|脖子|肩|膝|关节)[^。；\n]{0,14}(?:疼|痛|酸|僵|麻|抬不高)/,
    questions: [
      {
        question: "本次疼痛是否伴明确外伤、发热或局部红肿热，或出现肢体无力、大小便异常？",
        reason: "外伤、感染和神经功能受损线索会改变肌骨疼痛的检查和转诊优先级。",
        options: ["存在上述任一表现，请补充具体表现", "经询问均未出现上述表现", "本次未取得该信息"],
      },
      {
        question: "疼痛与哪些动作、体位或负重最相关，休息或活动后如何变化？",
        reason: "功能受限和诱发缓解规律有助于区分常见肌骨原因并确定查体重点。",
        options: ["有明确的动作、体位或负重规律，请补充具体情况", "经询问与动作、体位和负重均无明显关系", "本次未取得该信息"],
      },
    ],
  },
  {
    pattern: /(?:头晕|眩晕|屋子转|天旋地转)/,
    questions: [
      {
        question: "眩晕时是否出现说话不清、复视、单侧肢体无力、持续无法行走或突发剧烈头痛？",
        reason: "急性神经功能线索会改变眩晕的即时处置和转诊优先级。",
        options: ["存在上述任一表现，请补充具体表现", "经询问均未出现上述表现", "本次未取得该信息"],
      },
      {
        question: "每次眩晕持续多久，是否由翻身、起床或转头诱发，并伴耳鸣或听力变化？",
        reason: "持续时间、体位触发和听觉表现是区分常见眩晕原因的高信息量轴。",
        options: ["有明确的持续时间、体位诱发或听觉变化，请补充具体情况", "经询问无明显体位诱发和听觉变化", "本次未取得该信息"],
      },
    ],
  },
  {
    pattern: /(?:失眠|入睡困难|睡不着|睡不好|多梦易醒|夜醒)/,
    questions: [
      {
        question: "每周大约几晚受影响，第二天的精力、注意力或工作生活是否明显受损？",
        reason: "发生频率和白天功能影响会改变睡眠问题的严重度判断与后续评估方向。",
        options: ["频繁发生且白天功能明显受损，请补充具体情况", "发生较少或白天功能未明显受损", "本次未取得该信息"],
      },
      {
        question: "睡眠时是否有大声打鼾、被目击呼吸暂停，或近期使用安眠药、酒精助眠？",
        reason: "睡眠呼吸线索和助眠物质会改变鉴别诊断及用药安全边界。",
        options: ["存在打鼾呼吸暂停或助眠药物酒精使用，请补充具体情况", "经询问均无上述表现和使用情况", "本次未取得该信息"],
      },
    ],
  },
];

function complaintFamilyFallback(currentComplaint: string): string | undefined {
  const profile = COMPLAINT_FALLBACK_PROFILES.find((item) => item.pattern.test(currentComplaint));
  if (!profile) return undefined;
  return profile.questions.slice(0, 2).map((item, index) => questionBlock(
    index + 1,
    item.question,
    item.reason,
    "现病史",
    item.options,
  )).join("\n\n");
}

/**
 * 安全闸门已判急危重时的那一道题（2026-10-14）。
 *
 * 急症已经由病历本身成立，再问什么都不改变处置——此前这类病例问的是另一个类目的筛查题（疑似脑膜炎问「口角歪斜、单侧肢体无力」，
 * 主动脉夹层问卒中表现）、辨证题（重度脱水休克问「大便性状与气味」）或基本问诊（失血性休克问「怕冷还是怕热」）。
 * 调用方的流程仍要一道题，就问对急症处置有用的那一件事：是否已经安排急诊评估或转诊。题干先说明是哪一条急危重情况
 *（取闸门第一条红旗的前半句），医生不必翻到后面的安全提示才知道在说什么。选项只记录处置状态，不构成任何临床事实，
 * 也不是解除红旗的通道（解除仍只走 emergency-clearance）。CDSS_M02_PROCEED_WHEN_SETTLED=true 时这类病例直接不追问。
 */
export function redFlagDispositionQuestion(redFlags: readonly string[]): string {
  const first = (redFlags.find((item) => typeof item === "string" && item.trim()) || "").trim();
  const headline = first.split(/，(?:需|请|即使|原文依据)|；|。/)[0].trim().slice(0, 80);
  return questionBlock(
    1,
    `${headline ? `${headline}。` : "病历所述情况属急危重表现。"}请先按急症处置；目前是否已安排急诊评估或转诊？`,
    "急危重情况应先处置，其余诊疗建议在风险解除后再用。",
    "现病史",
    ["已安排急诊评估或转诊", "尚未安排，正在现场评估", FOLLOWUP_SKIP_SENTENCE],
  );
}

/** 「本轮无需追问」的信封（decision=proceed、题目为空）；只在 m02ProceedWhenSettled() 打开时由路由使用。 */
export function m02ProceedPlanContent(rationale: string): string {
  const plan: M02Plan = { schemaVersion: "tcm-cdss-m02-plan-v1", decision: "proceed", rationale, questions: [] };
  return JSON.stringify({ m02Plan: plan });
}

/** Used only when the provider fails or omits a grounded semantic safety concern. */
export function buildCaseAwareQuestionFallback(
  state: QuestionFallbackCase,
  /**
   * settled：模型已经判断「不需要再问」、只是调用方的流程仍要一道题时用。此时先问病历没写到的基本问诊项，
   * 而不是主诉类别预置的危险征象筛查题——后者是模型输出不可用时的安全兜底，普通病例上医生直接跳过
   *（2026-10-13 独立评审：心悸、咳嗽病例的追问是「是否出现静息也喘、口唇发紫、咯血…」）。
   */
  options: { textbookQuestion?: boolean; settled?: boolean } = {},
): string {
  const risk = possibleRiskQuestion(state);
  if (!risk) {
    // 闸门会列为「需优先评估」的事实层线索在前（m02PriorityEvaluationQuestion，2026-10-19）：辨证题、基本问诊题都排在它后面。
    const priority = m02PriorityEvaluationQuestion(state);
    if (priority) return priority;
    const recordText = fallbackRecordText(state);
    const ageDays = fallbackAgeDays(state, recordText);
    const presentHistory = [state.hisRecord?.fields?.xianbingshi, state.symptoms?.presentHistory]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
    // 服务端自有的题优先是一道辨证题（2026-10-13）：教材里与本例最相近的两个证型，问能把它们分开的那条事实。
    // 此前这里是按主诉类别预置的西医鉴别方向题或「总体在加重还是缓解」，医生多半直接跳过。
    // 年龄按天折算后传入（「8个月」不是数字，此前传 undefined，婴儿取的是成人教材的行），性别一并传入（男性不取妇科）。
    const discriminating = options.textbookQuestion === false ? undefined : textbookDiscriminatingQuestion({
      chiefComplaint: state.chiefComplaint || state.hisRecord?.fields?.zhushu,
      presentHistory,
      tongue: state.hisRecord?.fields?.tcmTongue || state.tongue,
      pulse: state.hisRecord?.fields?.tcmPulse || state.pulse,
      sex: state.patient?.sex || state.hisRecord?.fields?.sex,
      ageYears: ageDays != null ? ageDays / 365 : undefined,
    });
    // 只用「舌脉缺失时问舌脉」这一种教材题。另一种（「除病历已记录的表现外，还伴有哪一组」）靠字面重合判断
    // 「病历有没有写过」，病历用口语写（头晕眼花、记性变差）而教材用术语（头晕目眩、健忘）时判不出来，
    // 选项就成了病历已写明的症状——独立评审 29 例里 7 例如此（2026-10-13）。
    // 未满 3 岁（或年龄不详的儿童）不问脉象：三岁以下小儿以指纹代脉，家长答不出（2026-10-19 r1019 第四轮，
    // B-IMCS21-train-10172804#10、10354911#9、10322698#2、10366425#12、10324846#5 五例评审判不合格）。
    const pulseUnsuitable = Boolean(m02YoungChildBand(ageDays, recordText));
    if (discriminating && (discriminating.field === "舌象" || (discriminating.field === "脉象" && !pulseUnsuitable))) {
      return questionBlock(1, discriminating.question, discriminating.reason, discriminating.field,
        [discriminating.optionA, discriminating.optionB, "本次未取得该信息"]);
    }
    const courseText = [state.chiefComplaint, state.hisRecord?.fields?.zhushu, presentHistory]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("；");
    if (options.settled && options.textbookQuestion !== false) {
      return basicInquiryFallback(recordText, { ageDays, courseText }) || agendaQuestionFallback();
    }
    const currentComplaint = [
      state.chiefComplaint,
      state.hisRecord?.fields?.zhushu,
      state.hisRecord?.fields?.xianbingshi,
    ].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("；");
    if (/(?:头痛|头疼|脑袋.{0,12}(?:痛|疼|胀|紧箍|发紧)|头部.{0,8}(?:痛|疼|胀|发紧))/.test(currentComplaint)) {
      return [
        questionBlock(
          1,
          "目前或本次头痛发作时，是否出现突发最剧烈头痛、发热伴颈强、说话不清或单侧肢体无力？",
          "这些表现可能改变即时处置优先级，用于判断是否需要优先急诊评估；未确认前不预设风险等级。",
          "现病史",
          [
            "存在上述任一表现，请补充具体表现",
            "经询问均未出现上述表现",
            "本次未取得该信息",
          ],
        ),
        questionBlock(
          2,
          "头痛发作时是否伴有恶心、呕吐、畏光或畏声？",
          "伴随表现有助于区分常见头痛类型并确定后续检查方向；未确认前不预设诊断。",
          "现病史",
          [
            "伴有上述任一表现，请补充具体表现",
            "经询问均不伴上述表现",
            "本次未取得该信息",
          ],
        ),
      ].join("\n\n");
    }
    const familyFallback = complaintFamilyFallback(currentComplaint);
    if (familyFallback) return familyFallback;
    // 主诉类别没有预置题时，先问病历里没写到的基本问诊项；四项都写了才退到病情变化题。
    if (options.textbookQuestion !== false) {
      const basic = basicInquiryFallback(recordText, { ageDays, courseText });
      if (basic) return basic;
    }
    return genericModelFailureFallback(state);
  }
  // 理由写明「急诊或优先处置」：结构化信封按理由与题干把它归到 triage 分支（此前理由里没有这类词，筛查题被标成 differential，
  // 2026-10-19 r1019 第四轮评审 B-IMCS21 儿童危重筛查题）。
  return questionBlock(
    1,
    risk.question,
    "这一线索可能需要急诊或优先处置，需先由医生核实。",
    "现病史",
    [risk.positive, risk.negative, FOLLOWUP_SKIP_SENTENCE],
  );
}

function questionMatches(content: string): RegExpMatchArray[] {
  const pattern = /(?:^|\n)(\s*\*{0,2}问题\d+[：:][\s\S]*?)(?=\n\s*\*{0,2}问题\d+[：:]|$)/g;
  return Array.from(content.matchAll(pattern));
}

function comparable(value: string): string {
  return value.normalize("NFKC").replace(/[\s，。；、：:,.!?！？()（）\[\]【】_*_-]+/g, "");
}

const GENERIC_OPTION_WORDS = new Set(["存在异常", "没有异常", "无异常", "有症状", "无症状", "是", "否", "正常", "异常"]);

/**
 * 「病历里已经有这个答案了」的取材范围。
 *
 * 原实现直接拿整份病历做逐字包含，于是两类相反的事实被当成同一件事（2026-08-10 实测）：
 *  · 主语错位：病历「家族史：患者母亲有糖尿病」，模型问「患者**本人**既往是否诊断过糖尿病？」
 *    → 判「已知」删题。母亲有和本人有是相反的临床结论。
 *  · 极性错位：病历「否认胸痛、无黑便」，模型问「近一周静息时是否出现过胸痛并向左肩放射？」
 *    → 判「已知」删题，删除理由写「答案已在病历中明确记录」——与病历原意正好相反。
 *
 * 两条约束都不是新判断，是复用已有的东西：
 *  · 极性走 clinical-polarity 的 affirmed scope（否认/未见/无 的分句被剥掉，找不到就不算已知）；
 *  · 主语按**病历分段**排除家族史——那是带标签的字段边界，不是语义推断。
 */
const FAMILY_HISTORY_SECTION = /(?:家族史|父亲|母亲|哥哥|姐姐|弟弟|妹妹|外公|外婆|爷爷|奶奶)[^\n。；;]*/g;

/**
 * 病历字段标签。它们是**结构**不是临床内容，但会挡住极性判定：
 * 实测 affirmedClinicalText("现病史：否认胸痛") 原样保留该句——
 * 「现病史:」这个前缀让「否认」不再位于分句起始，否定判据够不着。
 * 取材时先剥标签，再做极性过滤。
 */
const RECORD_FIELD_LABEL = /(?:^|\n)\s*(?:主诉|现病史|既往史|个人史|婚育史|月经史|过敏史|用药史|查体|辅助检查|专科检查|舌象|脉象)\s*[：:]/g;

function alreadyKnownSourceText(sourceText: string): string {
  const withoutFamilyHistory = String(sourceText || "").replace(FAMILY_HISTORY_SECTION, "");
  const withoutLabels = withoutFamilyHistory.replace(RECORD_FIELD_LABEL, "\n");
  return affirmedClinicalText(withoutLabels, "affirmed") || "";
}

function optionAlreadyKnown(option: M02PlanOption, sourceText: string): boolean {
  if (option.kind !== "clinical_fact" || option.requiresDetail) return false;
  const source = comparable(alreadyKnownSourceText(sourceText));
  if (!source) return false;
  const candidates = [option.recordValue, option.answer, option.label]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => comparable(value)
      .replace(/^(?:经询问|患者|目前|当前|本次|已经|已确认|表现为|存在|出现)/, ""))
    .filter((value) => value.length >= 2 && !GENERIC_OPTION_WORDS.has(value));
  return candidates.some((candidate) => source.includes(candidate));
}

type KnownClinicalAxis = "trajectory" | "duration" | "frequency" | "severity" | "headache_quality";

const AXIS_QUESTION_PATTERNS: Record<KnownClinicalAxis, RegExp> = {
  trajectory: /(?:与.{0,24}(?:刚出现|起初|开始时|以前|之前).{0,24}(?:相比|比起)|(?:总体|变化趋势|病情趋势).{0,18}(?:加重|恶化|缓解|好转|稳定|反复|波动)|(?:加重|恶化).{0,12}(?:还是|或).{0,12}(?:缓解|好转|稳定|反复|波动))/,
  duration: /(?:多久|多长时间|什么时候开始|何时开始|起病时间|持续了|病程)/,
  frequency: /(?:多久一次|多久发作一次|每(?:天|日|周|月)几次|一(?:天|日|周|月)几次|发作频率|出现频率|发作次数)/,
  severity: /(?:疼痛评分|几分疼|程度如何|多严重|轻度.{0,6}中度.{0,6}重度|是轻、中还是重)/,
  headache_quality: /(?:(?:头痛|头部|脑袋).{0,16}(?:性质|什么样|哪一种|哪种|跳痛|搏动|胀痛|紧箍|刺痛)|(?:性质|什么样|哪一种|哪种).{0,12}(?:头痛|头部|脑袋))/,
};

const AXIS_SOURCE_PATTERNS: Record<KnownClinicalAxis, RegExp> = {
  trajectory: /(?:越来越(?:明显|严重|重|频繁|厉害|差)|(?:逐渐|渐渐|日渐|慢慢|逐步).{0,8}(?:加重|恶化|变重|缓解|好转|减轻|恢复)|(?:持续|进行性|不断).{0,5}(?:加重|恶化)|(?:时好时坏|反复波动|反反复复)|(?:总体|目前|近期).{0,8}(?:稳定|好转|缓解|减轻)|(?:与)?(?:以前|之前|开始时?|刚出现时?|起初)相比.{0,10}(?:加重|变重|恶化|好转|缓解|减轻)|(?:比|较).{0,12}(?:以前|之前|开始|起初).{0,10}(?:加重|变重|恶化|好转|缓解|减轻)|(?:没有|无).{0,5}(?:明显)?变化)/,
  duration: /(?:(?:近|已经|持续|反复|约|有)?(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半数几]+)(?:个)?(?:小时|天|日|周|星期|月|年)|今天|昨天|昨晚|前天|上周|上个月|去年)/,
  frequency: /(?:(?:每|一)(?:天|日|周|星期|月).{0,8}(?:\d+|[一二两三四五六七八九十数几]+)次|(?:\d+|[一二两三四五六七八九十数几]+)(?:天|日|周|星期|月)一次|每隔.{0,8}一次|频繁|偶尔|间断发作)/,
  severity: /(?:轻微|微痛|隐痛|剧烈|剧痛|难以忍受|严重|重度|(?:[0-9]|10)分(?:疼)?)/,
  headache_quality: /(?:一跳一跳|跳痛|搏动性|像.{0,5}紧箍|紧箍|箍紧|胀紧|胀痛|针刺样|刺痛|钝痛|隐痛)/,
};

/**
 * Remove only high-confidence repeats of a clinical axis that is already explicit in the record.
 * This intentionally does not infer a negative from missing data and does not collapse a
 * trigger-specific question (for example, meal-related worsening) into an overall trajectory.
 * Broader paraphrases are left to the generator prompt; there is no model reviewer (removed 2026-09-25).
 */
/**
 * 轴向证据的取材范围：**只看本次病程**。
 *
 * 原实现拿整份病历与问题做 5 个轴的笛卡尔 some()，两组正则之间没有任何症状/部位/时间尺度的
 * 共同锚点。实测三例（2026-08-10）：
 *  · 「既往史：高血压病史10年」里的时长词，压掉了「每次眩晕大约持续多久？」——
 *    既往病程与本次发作时长不是一回事；
 *  · 「既往有胃部隐痛史」里的「隐痛」，压掉了「本次胸闷发作时程度如何？」；
 *  · 腹部「胀痛」压掉了「本次头痛是哪一种性质？」——头痛性质轴的源模式不含部位限定。
 * 既往史/家族史属于**另一个时间轴与另一个主语**，不能用来证明本次病程已被记录。
 */
const PAST_OR_FAMILY_HISTORY_SECTION = /(?:^|\n)\s*(?:既往史|家族史|个人史|婚育史|手术史|外伤史)\s*[：:][^\n]*/g;

function currentIllnessScopeText(sourceText: string): string {
  return String(sourceText || "")
    .replace(PAST_OR_FAMILY_HISTORY_SECTION, "\n")
    // 行内写法（「既往有胃部隐痛史」）没有字段冒号，按句读切掉该分句。
    .replace(/[^\n。；;，,]*既往[^\n。；;，,]*/g, "");
}

function questionAxisAlreadyKnown(question: M02PlanQuestion, sourceText: string): boolean {
  if (!sourceText.trim()) return false;
  const questionText = [
    question.question,
    question.reason,
    question.expectedDecisionImpact,
    ...question.options.map((option) => `${option.answer}。${option.recordValue || ""}`),
  ].join("；");
  const currentScope = currentIllnessScopeText(sourceText);
  return (Object.keys(AXIS_QUESTION_PATTERNS) as KnownClinicalAxis[]).some((axis) =>
    AXIS_QUESTION_PATTERNS[axis].test(questionText) && AXIS_SOURCE_PATTERNS[axis].test(currentScope));
}

function questionAlreadyAnswered(question: M02PlanQuestion, sourceText: string): boolean {
  return questionAxisAlreadyKnown(question, sourceText)
    || question.options.some((option) => optionAlreadyKnown(option, sourceText));
}

export function renderStructuredM02Plan(plan: M02Plan): string {
  if (plan.decision === "proceed" || plan.questions.length === 0) {
    return "当前无需追加追问，按现有信息进入辨病辨证。";
  }
  const questions = plan.questions.map((question, index) => [
    `**问题${index + 1}：** ${question.question}`,
    `（追问理由：${question.reason}）`,
    `补录字段：${question.targetField}`,
    "可选项：",
    ...question.options.map((option, optionIndex) => `${String.fromCharCode(65 + optionIndex)}. ${option.answer}`),
  ].join("\n")).join("\n\n");
  const degradedNotice = /模型结构化追问计划不可用/.test(plan.rationale)
    ? "⚠️ 本轮追问已降级：模型问题计划未通过结构校验，以下为与当前主诉匹配的安全追问；医生可直接补充更相关的患者事实后继续。"
    : "";
  return [degradedNotice, questions].filter(Boolean).join("\n\n");
}

/**
 * The provider plans the questions; this final guard only removes a question when one of its
 * concrete answers is already present verbatim in the trusted clinical source. It then renders the
 * same structured plan back to visible text so the card and the signed payload cannot diverge.
 */
/**
 * 没有值得问的题时，是否如实返回 decision=proceed（接口文档 §4.3 一直有这个取值）。
 *
 * 默认关闭：生产留存里调用方收到的 26 次追问结果全部是 ask，它们处理 proceed 的那条路从未走过，
 * 贸然返回空题目可能让对方面板停在一个空的追问页。关闭时仍然一轮只问一题，且该题由服务端保证存在。
 * 调用方确认能处理后，`CDSS_M02_PROCEED_WHEN_SETTLED=true` 打开，无需重新构建。
 */
/**
 * 病历是否足以不再追问（2026-10-18）：舌象与脉象都记录了，或寒热、口渴、二便、汗这四项基本问诊里至少记录了三项。
 * 逐模块验收的问诊集（IMCS-21 儿科在线问诊）里，只有「刚发烧、今天流鼻涕」的病历模型也返回 proceed，独立评审判「不足以辨证、
 * 不应停止追问」（330 例里约 1/4 的不合格）。判据复用基本问诊兜底题的同一组「已记录」判据（BASIC_INQUIRY_AXES）。
 */
export function m02RecordSufficientForProceed(recordText: string): boolean {
  const text = String(recordText || "");
  const tongue = /舌[^，,。；;]{0,6}(?:红|淡|暗|紫|胖|瘦|苔|边|尖|嫩)|苔[^，,。；;]{0,4}(?:白|黄|腻|薄|厚|少|剥|润|燥)/u.test(text);
  const pulse = /脉[^，,。；;]{0,3}(?:浮|沉|迟|数|滑|涩|弦|细|弱|紧|缓|洪|濡|结|代|促|平|虚|实|微)/u.test(text);
  const basics = BASIC_INQUIRY_AXES.filter((axis) => axis.recorded.test(text)).length;
  return (tongue && pulse) || basics >= 3;
}

/** 允许如实返回「无需追问」：开关打开，且（给了病历时）病历已足以不再追问。红旗病例的处置题不看病历充分度，见路由。 */
export function m02ProceedWhenSettled(recordText?: string): boolean {
  if (process.env.CDSS_M02_PROCEED_WHEN_SETTLED !== "true") return false;
  return recordText === undefined || m02RecordSufficientForProceed(recordText);
}

export function enforceM02UnansweredAxes(
  content: string,
  sourceText: string,
  fallbackContent = "",
  state?: QuestionFallbackCase,
): string {
  const normalizeEnvelope = (raw: string) => {
    const start = raw.indexOf(QUESTION_SENTINEL_START);
    const end = start >= 0 ? raw.indexOf(QUESTION_SENTINEL_END, start) : -1;
    if (start < 0 || end < 0) return null;
    try {
      const envelope = JSON.parse(raw.slice(start + QUESTION_SENTINEL_START.length, end).trim()) as {
        m02Plan?: unknown;
      };
      const plan = parseM02Plan(envelope.m02Plan, sourceText);
      return plan ? { plan } : null;
    } catch {
      return null;
    }
  };

  const primary = normalizeEnvelope(content);
  const fallback = fallbackContent ? normalizeEnvelope(ensureQuestionStructuredEnvelope(fallbackContent, sourceText)) : null;
  const source = primary || fallback;
  if (!source) return content;
  let questions = source.plan.questions.filter((question) =>
    !questionAlreadyAnswered(question, sourceText) && !(question.targetField === "vitalsDetail" && structuredVitalsComplete(state)));
  const groundedRisk = possibleRiskQuestion(state);
  // 模型自己写的澄清题已经覆盖「其他急危重线索」时用模型那一道，不再前置笼统的复核题。
  const modelOwnedRisk = groundedRisk?.category === "other_critical" ||
    Boolean(groundedRisk && state?.m02ModelOwnedRiskCategories?.includes(groundedRisk.category));
  const modelCoversOpenRisk = Boolean(groundedRisk) && modelOwnedRisk && source !== fallback &&
    questions.some((question) => questionCoversGroundedRisk(question, groundedRisk as PossibleRiskQuestion, state));
  const prependRisk = Boolean(groundedRisk && fallback?.plan.questions[0] && !modelCoversOpenRisk);
  if (groundedRisk && prependRisk && fallback?.plan.questions[0]) {
    // A grounded risk owns one canonical, exhaustive triage axis. Replace every provider variant
    // on that axis instead of prepending a second wording of the same urgent decision branch.
    const riskQuestion = { ...fallback.plan.questions[0], id: "q1" };
    questions = [riskQuestion, ...questions.filter((question) => !questionCoversGroundedRisk(question, groundedRisk, state))];
  } else if (groundedRisk && modelCoversOpenRisk) {
    questions = [
      ...questions.filter((question) => questionCoversGroundedRisk(question, groundedRisk, state)),
      ...questions.filter((question) => !questionCoversGroundedRisk(question, groundedRisk, state)),
    ];
  }
  // 一轮只问一题（2026-10-13，甲方 10.12 测评「追问是必选项吗」；生产 26 轮追问被跳过 21 轮）：急症澄清题之外
  // 只留一题，优先留能区分证型的那一题，西医鉴别方向的题排在最后。
  const BRANCH_RANK: Record<string, number> = { syndrome: 0, treatment_safety: 1, triage: 2, differential: 3 };
  const riskLead = prependRisk || modelCoversOpenRisk ? questions.slice(0, 1) : [];
  // 模型出的题按分支排序取一题；服务端自有的题（主诉类别兜底）保持它自己的先后——第一题是该类主诉的安全轴。
  const others = source === fallback || !fallbackContent
    ? questions.slice(riskLead.length)
    : questions.slice(riskLead.length)
      .map((question, index) => ({ question, index }))
      .sort((left, right) =>
        (BRANCH_RANK[left.question.decisionBranch] ?? 9) - (BRANCH_RANK[right.question.decisionBranch] ?? 9) || left.index - right.index)
      .map((entry) => entry.question);
  // 一轮只有一题（2026-10-14）：此前急症澄清题之外还带一题，一轮两题（242 例里 5 例），独立评审记为「数量不克制」。
  // 有急症澄清题时只问它；没有时问模型排在最前的那一题。
  questions = riskLead.length > 0 ? riskLead : others.slice(0, 1);
  // 没有合格的题：允许如实返回「无需追问」时就返回 proceed；否则给一条服务端自有的题，保持调用方现有的一问一答流程。
  if (questions.length === 0 && fallback && source !== fallback && !m02ProceedWhenSettled(sourceText)) {
    questions = fallback.plan.questions.filter((question) => !questionAlreadyAnswered(question, sourceText)).slice(0, 1);
  }
  const normalizedQuestions = questions.slice(0, 1).map((question, index) => ({ ...question, id: `q${index + 1}` }));
  const plan: M02Plan = normalizedQuestions.length > 0
    ? { ...source.plan, decision: "ask", questions: normalizedQuestions }
    : { ...source.plan, decision: "proceed", rationale: "当前候选追问的答案已在病历中明确记录，无需重复询问。", questions: [] };
  return [
    renderStructuredM02Plan(plan),
    "",
    QUESTION_SENTINEL_START,
    JSON.stringify({ m02Plan: plan }),
    QUESTION_SENTINEL_END,
  ].join("\n");
}

/**
 * M02 结构化输出里的 `completeness` 是对外接口字段（接口文档 §4.3），由服务端写入，模型不再打分。
 * 取值是各阶段路由共用的确定性操作完整度（diagnosis-safety.deriveOperationalCompleteness——
 * withSafetyGate 写进 caseState 的同一份）。此前由模型自评：客户端解析后立即被确定性值覆盖、
 * 各路由也从不读它，只在对外信封里原样透出（2026-09-25 改）。
 * 只替换哨兵之间的 JSON，可见 Markdown 逐字不动；没有合法信封时原样返回。
 */
export function withM02Completeness(content: string, completeness: Completeness): string {
  const start = content.indexOf(QUESTION_SENTINEL_START);
  const end = start >= 0 ? content.indexOf(QUESTION_SENTINEL_END, start) : -1;
  if (start < 0 || end < 0) return content;
  const envelope = extractQuestionEnvelope(content) as { m02Plan?: unknown } | null;
  if (!envelope || typeof envelope !== "object" || !envelope.m02Plan || typeof envelope.m02Plan !== "object") return content;
  const { level, redFlag, infoGain, managementImpact, answerability } = completeness;
  return [
    content.slice(0, start + QUESTION_SENTINEL_START.length),
    JSON.stringify({ completeness: { level, redFlag, infoGain, managementImpact, answerability }, m02Plan: envelope.m02Plan }),
    content.slice(end),
  ].join("\n");
}

/**
 * 题干把舌象与脉象并在一问（「舌象与脉象更接近下列哪一组？」，选项「舌红苔黄腻，脉弦滑数」）：改成只问一项（2026-10-19）。
 * r1019 验收集 B 里这类题 3/3 被评审判「两件事并问」，单问点核对对同一题干时判时不判（选项不同结论不同）。
 * 拆法（构词式，舌、脉是有限的两个诊察项）：每个选项在「脉」字处切成舌、脉两半；病历没写舌象且两半舌象互斥
 *（tongueOptionsMutuallyExclusive）就只问舌象，否则病历没写脉象且两半脉象互斥（pulseOptionsMutuallyExclusive）就只问脉象，
 * 都不行就删题（走与确定性删题同一条收口）。返回改写后的内容与要删的题号。
 */
const TONGUE_RECORDED = /舌(?:质|体|象)?\s*[:：]?\s*(?:淡|红|暗|黯|紫|胖|瘦|嫩|绛|青)|苔(?:薄|厚|白|黄|腻|少|剥|滑|燥|润)/u;
const PULSE_RECORDED = /脉(?:象)?\s*[:：]?\s*(?:浮|沉|迟|数|细|弦|滑|涩|虚|实|缓|紧|濡|弱|洪|微|结|代|促|芤|伏|弦)/u;
function splitTongueAndPulse(text: string): { tongue: string; pulse: string } | undefined {
  const match = /(^|[，,、；;\s])脉/u.exec(text);
  if (!match) return undefined;
  const at = match.index + match[1].length;
  const tongue = text.slice(0, at).replace(/[，,、；;\s]+$/u, "").trim();
  const pulse = text.slice(at).replace(/[。；;，,\s]+$/u, "").trim();
  return /[舌苔]/u.test(tongue) && pulse ? { tongue, pulse } : undefined;
}
/**
 * 只问舌象或只问脉象的题（模型写的、服务端教材题都一样）：选项两两互斥才出（2026-10-19，甲方病历 7 第 1 次生成：
 * 「舌苔更接近下列哪一种？」选项「舌红，苔黄」对「舌红，苔薄黄」——苔黄包含薄黄，两个选项还都预设了舌红，独立评审判不合格）。
 * 判据与教材题同一份（tongueOptionsMutuallyExclusive / pulseOptionsMutuallyExclusive）：不互斥就删题，走与确定性删题同一条收口
 *（病历够辨证时 proceed，否则出服务端的单问点题）。互斥时，各选项都写着的同一小句（「舌红」）去掉——那是题目替医生预设的、
 * 并没有问；题干按剩下的内容改成问舌苔、舌质或舌象。返回 "remove"、改写后的题，或原题。
 */
const TONGUE_BODY_CLAUSE = /舌(?:质|体)?(?:尖|边)?(?:淡红|淡白|淡|红绛|绛|红|紫暗|青紫|紫|暗|黯)/u;
function tongueAspectOf(clauses: readonly string[]): "coating" | "body" | "mixed" {
  const coating = clauses.some((clause) => /苔/u.test(clause));
  const body = clauses.some((clause) => TONGUE_BODY_CLAUSE.test(clause) && !/苔/u.test(clause));
  return coating && !body ? "coating" : body && !coating ? "body" : "mixed";
}
const optionClauses = (value: string) => value.split(/[，,、；;\s]+/u).map((clause) => clause.trim()).filter(Boolean);
function singleTongueOrPulseQuestion(question: M02PlanQuestion): M02PlanQuestion | "remove" {
  const clinical = question.options.filter((option) => option.kind === "clinical_fact");
  const values = clinical.map((option) => (option.recordValue || option.answer || option.label || "").trim());
  if (values.length < 2) return question;
  const pairwise = (list: readonly string[], exclusive: (a: string, b: string) => boolean) =>
    list.every((value, index) => list.slice(index + 1).every((other) => exclusive(value, other)));
  if (values.every((value) => /脉/u.test(value) && !/[舌苔]/u.test(value))) {
    return pairwise(values.map(withoutFingerVeinClause), pulseOptionsMutuallyExclusive) ? question : "remove";
  }
  if (!values.every((value) => /[舌苔]/u.test(value) && !/脉/u.test(value))) return question;
  if (!pairwise(values, tongueOptionsMutuallyExclusive)) return "remove";
  const clauseLists = values.map(optionClauses);
  const shared = clauseLists[0].filter((clause) => clauseLists.every((list) => list.includes(clause)));
  const remaining = clauseLists.map((list) => list.filter((clause) => !shared.includes(clause)));
  const strip = shared.length > 0 && remaining.every((list) => list.length > 0);
  const aspect = tongueAspectOf((strip ? remaining : clauseLists).flat());
  const stemAspect = /舌质|舌色|舌体/u.test(question.question) && !/苔|舌象/u.test(question.question) ? "body"
    : /苔/u.test(question.question) && !/舌象|舌质|舌色|舌体/u.test(question.question) ? "coating" : "mixed";
  if (!strip && (stemAspect === "mixed" || stemAspect === aspect)) return question;
  const stem = aspect === "coating" ? "本例的舌苔更接近下面哪一种？" : aspect === "body" ? "本例的舌质更接近下面哪一种？" : "本例的舌象更接近下面哪一种？";
  const rewrite = (value: string | undefined) => {
    if (!value || !strip) return value;
    const kept = optionClauses(value).filter((clause) => !shared.includes(clause));
    return kept.length > 0 ? kept.join("，") : value;
  };
  return {
    ...question,
    question: stem,
    targetField: "tcmTongue" as const,
    options: question.options.map((option) => option.kind !== "clinical_fact" ? option : {
      ...option,
      label: rewrite(option.label) || option.label,
      answer: rewrite(option.answer) || option.answer,
      ...(option.recordValue ? { recordValue: rewrite(option.recordValue) } : {}),
    }),
  };
}

export function splitTonguePulseQuestions(
  content: string,
  sourceText: string,
  state?: { tongue?: string; pulse?: string; hisRecord?: { fields?: { tcmTongue?: string; tcmPulse?: string } } },
): { content: string; removeIds: string[] } {
  const plan = parseM02PlanFromContent(content);
  if (!plan || plan.decision !== "ask") return { content, removeIds: [] };
  const tongueRecorded = Boolean((state?.tongue || state?.hisRecord?.fields?.tcmTongue || "").trim()) || TONGUE_RECORDED.test(sourceText);
  const pulseRecorded = Boolean((state?.pulse || state?.hisRecord?.fields?.tcmPulse || "").trim()) || PULSE_RECORDED.test(sourceText);
  const removeIds: string[] = [];
  let changed = false;
  const questions = plan.questions.map((question) => {
    if (!/舌/u.test(question.question) || !/脉/u.test(question.question)) {
      const single = singleTongueOrPulseQuestion(question);
      if (single === "remove") removeIds.push(question.id);
      else if (single !== question) {
        changed = true;
        return single;
      }
      return question;
    }
    const clinical = question.options.filter((option) => option.kind === "clinical_fact");
    const halves = clinical.map((option) => splitTongueAndPulse(option.recordValue || option.answer));
    if (clinical.length !== 2 || halves.some((half) => !half)) {
      removeIds.push(question.id);
      return question;
    }
    const [first, second] = halves as { tongue: string; pulse: string }[];
    const field = !tongueRecorded && tongueOptionsMutuallyExclusive(first.tongue, second.tongue)
      ? "tongue"
      : !pulseRecorded && pulseOptionsMutuallyExclusive(first.pulse, second.pulse) ? "pulse" : undefined;
    if (!field) {
      removeIds.push(question.id);
      return question;
    }
    changed = true;
    const values = field === "tongue" ? [first.tongue, second.tongue] : [withoutFingerVeinClause(first.pulse), withoutFingerVeinClause(second.pulse)];
    let index = 0;
    return {
      ...question,
      question: field === "tongue" ? "本例的舌象更接近下面哪一种？" : "本例的脉象更接近下面哪一种？",
      targetField: field === "tongue" ? "tcmTongue" as const : "tcmPulse" as const,
      options: question.options.map((option) => {
        if (option.kind !== "clinical_fact") return option;
        const value = values[index++];
        return { ...option, label: value, answer: value, ...(option.recordValue ? { recordValue: value } : {}) };
      }),
    };
  });
  if (!changed) return { content, removeIds };
  const nextPlan: M02Plan = { ...plan, questions };
  return {
    content: [
      renderStructuredM02Plan(nextPlan),
      "",
      QUESTION_SENTINEL_START,
      JSON.stringify({ m02Plan: nextPlan }),
      QUESTION_SENTINEL_END,
    ].join("\n"),
    removeIds,
  };
}

export function removeM02PlanQuestions(content: string, questionIds: string[], rationale: string): string {
  const start = content.indexOf(QUESTION_SENTINEL_START);
  const end = start >= 0 ? content.indexOf(QUESTION_SENTINEL_END, start) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const envelope = JSON.parse(content.slice(start + QUESTION_SENTINEL_START.length, end).trim()) as {
      m02Plan?: unknown;
    };
    const plan = parseM02Plan(envelope.m02Plan);
    if (!plan) return content;
    const removed = new Set(questionIds);
    const questions = plan.questions.filter((question) => !removed.has(question.id));
    const nextPlan: M02Plan = questions.length > 0
      ? { ...plan, questions, rationale: rationale.trim().slice(0, 400) || plan.rationale }
      : {
          ...plan,
          decision: "proceed",
          questions: [],
          rationale: rationale.trim().slice(0, 400) || "候选问题均已由病历回答或不满足单选互斥要求，按现有信息继续辨病辨证。",
        };
    return [
      renderStructuredM02Plan(nextPlan),
      "",
      QUESTION_SENTINEL_START,
      JSON.stringify({ m02Plan: nextPlan }),
      QUESTION_SENTINEL_END,
    ].join("\n");
  } catch {
    return content;
  }
}

/**
 * Detect high-confidence leading, non-actionable, or temporally contradictory rationales here. A
 * non-empty explanation such as "用于了解情况" still fails the clinician-facing contract because
 * it does not say which decision the answer can change. Likewise, an episodic question cannot be
 * explained as checking the patient's current state (and vice versa). The final wording always
 * comes from a server-owned template, so generated prose can neither diagnose the patient nor leak a
 * prescription into the question card.
 */
export function m02QuestionRationaleNeedsNeutralization(question: M02PlanQuestion): boolean {
  const rationale = `${question.reason}\n${question.expectedDecisionImpact}`;
  const temporalMismatch = (
    HISTORICAL_OR_EPISODIC_M02_QUESTION.test(question.question)
    && CURRENT_STATE_ONLY_M02_RATIONALE.test(rationale)
  ) || (
    CURRENT_STATE_M02_QUESTION.test(question.question)
    && HISTORICAL_STATE_ONLY_M02_RATIONALE.test(rationale)
  );
  return LEADING_M02_RATIONALE.test(rationale)
    || temporalMismatch
    || question.reason.length < 8
    || !ACTIONABLE_M02_RATIONALE.test(question.reason);
}

export function neutralizeM02PlanQuestionRationales(content: string, questionIds?: string[]): string {
  const start = content.indexOf(QUESTION_SENTINEL_START);
  const end = start >= 0 ? content.indexOf(QUESTION_SENTINEL_END, start) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const envelope = JSON.parse(content.slice(start + QUESTION_SENTINEL_START.length, end).trim()) as {
      m02Plan?: unknown;
    };
    const plan = parseM02Plan(envelope.m02Plan);
    if (!plan) return content;
    const requested = questionIds ? new Set(questionIds) : null;
    let changed = false;
    const questions = plan.questions.map((question) => {
      const shouldRewrite = requested ? requested.has(question.id) : m02QuestionRationaleNeedsNeutralization(question);
      if (!shouldRewrite) return question;
      const neutral = NEUTRAL_M02_RATIONALE[question.decisionBranch];
      if (question.reason === neutral.reason && question.expectedDecisionImpact === neutral.expectedDecisionImpact) return question;
      changed = true;
      return { ...question, ...neutral };
    });
    if (!changed) return content;
    const nextPlan: M02Plan = { ...plan, questions };
    return [
      renderStructuredM02Plan(nextPlan),
      "",
      QUESTION_SENTINEL_START,
      JSON.stringify({ m02Plan: nextPlan }),
      QUESTION_SENTINEL_END,
    ].join("\n");
  } catch {
    return content;
  }
}

function isNegativeOption(value: string): boolean {
  return /^(?:经.{0,8})?(?:未见|没有|否认|均未|不伴|不存在|无)/.test(value.normalize("NFKC").trim());
}

export function isCompoundAffirmativeQuestionOption(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || UNKNOWN_OPTION.test(normalized) || isNegativeOption(normalized)) return false;
  return /(?:中的一项|其中(?:一项|一种)|任一(?:项|种)?|上述(?:情况|表现|症状|异常)|存在.{0,40}(?:或|、).{0,40}(?:表现|异常|情况))/.test(normalized);
}

export function isGenericDetailOnlyQuestionOption(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  return !isCompoundAffirmativeQuestionOption(normalized) && GENERIC_DETAIL_ONLY_OPTION.test(normalized);
}

function normalizeCompoundPositiveOptions(block: string): string {
  return block.replace(/(^\s*[A-B][.、：:]\s*)([^\n]+)/gim, (line, prefix: string, option: string) => {
    if (!isCompoundAffirmativeQuestionOption(option) || /请补充具体|填写实际|记录具体/.test(option)) return line;
    return `${prefix}${option.replace(/[。；;，,\s]+$/, "")}，请补充具体表现`;
  });
}

function parseOptions(block: string): Array<{ label: string; text: string }> {
  return Array.from(block.matchAll(/(?:^|\n)\s*([A-C])[.、：:]\s*([^\n]+)/gi), (match) => ({
    label: match[1].toUpperCase(),
    text: match[2].trim(),
  }));
}

function isAnswerableQuestionBlock(block: string): boolean {
  if (LOW_VALUE_QUESTION.test(block)) return false;
  const options = parseOptions(block);
  // 3 个为模型原始输出，4 个为追加「其他」后的形态；标签必须仍是连续的 A/B/C[/D]。
  if ((options.length !== 3 && options.length !== 4) ||
    options.some((option, index) => option.label !== ["A", "B", "C", "D"][index])) return false;
  if (options.filter((option) => UNKNOWN_OPTION.test(option.text)).length !== 1) return false;
  const known = options.filter((option) => !UNKNOWN_OPTION.test(option.text));
  if (known.length !== 2) return false;
  if (known.some((option) => isGenericDetailOnlyQuestionOption(option.text))) return false;
  const normalized = known.map((option) => comparable(option.text));
  if (normalized.some((value) => !value) || new Set(normalized).size !== 2) return false;
  if (normalized[0].length >= 3 && normalized[1].includes(normalized[0])) return false;
  if (normalized[1].length >= 3 && normalized[0].includes(normalized[1])) return false;
  return true;
}

function questionTitle(block: string): string {
  return block.match(/问题\d+[：:]\s*\*{0,2}([^\n]+)/)?.[1]?.trim() || block.split("\n")[0] || block;
}

function characterBigrams(value: string): Set<string> {
  const text = comparable(value);
  const result = new Set<string>();
  if (text.length < 2) {
    if (text) result.add(text);
    return result;
  }
  for (let index = 0; index < text.length - 1; index += 1) result.add(text.slice(index, index + 2));
  return result;
}

function questionSimilarity(left: string, right: string): number {
  const a = characterBigrams(questionTitle(left));
  const b = characterBigrams(questionTitle(right));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / Math.max(1, a.size + b.size - intersection);
}

function sameQuestion(left: string, right: string): boolean {
  return comparable(questionTitle(left)) === comparable(questionTitle(right)) || questionSimilarity(left, right) >= 0.72;
}

function asksGroundedRisk(block: string, fallback: string): boolean {
  return questionSimilarity(block, fallback) >= 0.34;
}

const RISK_AXIS_PATTERNS: Record<string, RegExp> = {
  cardiac: /胸痛|胸口压迫|向肩臂放射|心前区痛/,
  syncope: /意识丧失|失去意识|晕厥|跌倒|不能回应/,
  neuro: /说话不清|口角歪斜|单侧肢体无力|意识改变|剧烈头痛/,
  gi_bleed: /黑便|鲜血便|便血|呕血/,
  bleeding: /咯血|阴道.{0,4}流血|出血不止|仍在出血/,
  acute_abdomen: /腹痛|肚子.{0,6}痛|绞痛|反跳痛|腹部僵硬|停止排气排便|肠梗阻|急腹症/,
  respiratory: /静息.{0,4}喘|不能平卧|说话受限|口唇发紫|呼吸困难/,
  sepsis: /高热|低体温|寒战|意识变差|血压下降|脓毒|体温过高或过低|皮肤发花/,
  mental_crisis: /自伤|轻生|伤害他人|自杀/,
  shock: /四肢湿冷|站立不稳|尿量.{0,4}减少|循环灌注|休克/,
  anaphylaxis: /喉头|舌唇肿胀|声音嘶哑|喘憋|全身风团|过敏反应/,
  obstetric: /妊娠|孕期|阴道.{0,4}流血|胎动异常|子痫/,
  pediatric_critical: /患儿|儿童|发绀|拒绝饮水|拒奶|精神反应.{0,4}差/,
  poisoning: /接触|摄入|误服|中毒|可疑暴露|剂量/,
  metabolic: /血糖|深大呼吸|代谢/,
  other_critical: /生命体征|意识|呼吸状态|异常.{0,4}发生/,
};

function questionCoversGroundedRisk(question: M02PlanQuestion, risk: PossibleRiskQuestion, state?: QuestionFallbackCase): boolean {
  // 「其他急危重线索」没有固定的筛查内容：模型按该线索写的澄清题（triage / treatment_safety 分支）就是这道题本身，
  // 比「请复核该异常是否正在发生」具体（抗凝中的深静脉血栓病史 → 「原血栓侧有无新发肿胀、疼痛」）。
  // 病历已逐项否认其中几项的类目同理（2026-10-19）：模型只问未否认的那几项，比整张清单准。
  const modelOwned = risk.category === "other_critical" || Boolean(state?.m02ModelOwnedRiskCategories?.includes(risk.category));
  if (modelOwned && (question.decisionBranch === "triage" || question.decisionBranch === "treatment_safety")) return true;
  const text = `${question.question}；${question.reason}；${question.expectedDecisionImpact}`;
  return asksGroundedRisk(question.question, risk.question) || Boolean(RISK_AXIS_PATTERNS[risk.category]?.test(text));
}

/**
 * LLM owns clinical question planning and ranking. This layer only enforces the
 * interaction contract, prevents duplicates, caps one round, and restores a
 * grounded semantic-risk question when the provider omitted it.
 */
export function ensureSingleRoundQuestionContract(content: string, fallbackContent = "", state?: QuestionFallbackCase): string {
  const markerIndex = content.indexOf(QUESTION_SENTINEL_START);
  const visible = (markerIndex >= 0 ? content.slice(0, markerIndex) : content).trimEnd();
  const providerBlocks = questionMatches(visible).map((match) => normalizeCompoundPositiveOptions(match[1].trim()));
  const fallbackBlocks = questionMatches(fallbackContent).map((match) => normalizeCompoundPositiveOptions(match[1].trim()));
  const validProviderBlocks = providerBlocks.filter(isAnswerableQuestionBlock);
  const selected: string[] = [];
  const add = (block: string) => {
    if (!block || selected.some((item) => sameQuestion(item, block)) || !isAnswerableQuestionBlock(block)) return;
    selected.push(block);
  };

  const risk = possibleRiskQuestion(state);
  const riskFallback = risk ? fallbackBlocks[0] : undefined;
  if (riskFallback && !validProviderBlocks.some((block) => asksGroundedRisk(block, riskFallback))) add(riskFallback);
  for (const block of validProviderBlocks) {
    if (selected.length >= 2) break;
    add(block);
  }
  if (selected.length === 0) add(fallbackBlocks[0] || genericModelFailureFallback(state || {}));

  const firstIndex = questionMatches(visible)[0]?.index || 0;
  const preamble = providerBlocks.length > 0 ? visible.slice(0, firstIndex).trim() : "";
  const repairedBlocks = selected.slice(0, 2).map((block, index) => block.replace(/问题\d+[：:]/, `问题${index + 1}：`));
  const repaired = [preamble, ...repairedBlocks].filter(Boolean).join("\n\n");
  return markerIndex >= 0 ? `${repaired}\n\n${content.slice(markerIndex)}` : repaired;
}

/** Keep the M02 workflow envelope parseable without inventing patient facts. */
export function ensureQuestionStructuredEnvelope(content: string, sourceText = "", fallbackContent = ""): string {
  const start = content.indexOf(QUESTION_SENTINEL_START);
  const end = start >= 0 ? content.indexOf(QUESTION_SENTINEL_END, start) : -1;
  const renderEnvelope = (plan: M02Plan) => [
    renderStructuredM02Plan(plan),
    "",
    QUESTION_SENTINEL_START,
    JSON.stringify({ m02Plan: plan }),
    QUESTION_SENTINEL_END,
  ].join("\n");
  const parseEnvelope = (value: unknown): string | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const plan = parseM02Plan((value as { m02Plan?: unknown }).m02Plan, sourceText);
    return plan ? renderEnvelope(plan) : null;
  };

  // New providers return one JSON object. Legacy sentinel output remains accepted, but in both
  // cases the clinician-facing card is rendered from that same validated plan so the two surfaces
  // can never silently disagree.
  try {
    const normalized = parseEnvelope(JSON.parse(content.trim()));
    if (normalized) return normalized;
  } catch {
    // Try the legacy envelope and then the visible compatibility parser below.
  }
  if (start >= 0 && end >= 0 && !content.slice(end + QUESTION_SENTINEL_END.length).trim()) {
    try {
      const normalized = parseEnvelope(JSON.parse(content.slice(start + QUESTION_SENTINEL_START.length, end).trim()));
      if (normalized) return normalized;
    } catch {
      // Replace malformed provider data below.
    }
  }
  const visible = (start >= 0 ? content.slice(0, start) : content).trimEnd();
  const targetFieldMap: Record<string, M02TargetField> = {
    "现病史": "xianbingshi",
    "既往史": "jiwangshi",
    "过敏史": "allergyHistory",
    "用药史": "medicationHistory",
    "生命体征": "vitalsDetail",
    "面象": "tcmFace",
    "舌象": "tcmTongue",
    "脉象": "tcmPulse",
    "问诊补充": "tcmDetail",
    "辅助检查": "fuzhuJiancha",
  };
  const visibleQuestions = questionMatches(visible)
    .map((match) => normalizeCompoundPositiveOptions(match[1].trim()))
    .filter(isAnswerableQuestionBlock)
    .slice(0, 2)
    .map((block, index): M02PlanQuestion | null => {
      const question = boundedText(questionTitle(block), 240);
      const reason = boundedText(block.match(/追问理由[：:]([^）\n]+)/)?.[1], 300);
      const fieldLabel = block.match(/补录字段[：:]\s*([^\n]+)/)?.[1]?.trim() || "";
      const targetField = targetFieldMap[fieldLabel] || (M02_TARGET_FIELD_SET.has(fieldLabel) ? fieldLabel as M02TargetField : undefined);
      const options = parseOptions(block);
      if (!question || !reason || !targetField || (options.length !== 3 && options.length !== 4)) return null;
      const decisionBranch: M02DecisionBranch = /(急诊|急症|危重|红旗|立即处置|优先处置)/.test(`${question}${reason}`)
        ? "triage"
        : /(用药|过敏|妊娠|哺乳|禁忌|安全)/.test(`${question}${reason}`)
          ? "treatment_safety"
          : /(?:舌|脉|寒热|汗|二便|证候|病机)/.test(`${question}${reason}`)
            ? "syndrome"
            : "differential";
      return {
        id: `q${index + 1}`,
        question,
        reason,
        targetField,
        decisionBranch,
        expectedDecisionImpact: reason,
        informationGain: 0.7,
        sourceEvidence: [],
        options: options.map((option, optionIndex) => {
          const unknown = UNKNOWN_OPTION.test(option.text);
          // 服务端追加的「其他」在往返回来时必须被认回 other，而不是当成第三个 clinical_fact——
          // parseM02Plan 要求 clinical_fact 恰好两个，认错会让整份计划在往返后判空。
          const other = !unknown && OTHER_OPTION.test(option.text);
          const requiresDetail = !unknown && /(?:补充|填写|记录)具体/.test(option.text);
          return {
            id: unknown ? "unknown" : other ? "other" : String.fromCharCode(97 + optionIndex),
            label: boundedText(option.text, 80) || option.label,
            answer: option.text,
            kind: unknown ? "unknown" as const : other ? "other" as const : "clinical_fact" as const,
            ...(other
              ? { requiresDetail: true }
              : requiresDetail ? { requiresDetail: true } : !unknown ? { recordValue: option.text } : {}),
          };
        }),
      };
    })
    .filter((question): question is M02PlanQuestion => Boolean(question));
  if (visibleQuestions.length > 0) {
    return renderEnvelope({
      schemaVersion: "tcm-cdss-m02-plan-v1",
      decision: "ask",
      rationale: "保留模型已生成且满足交互约束的高信息增益问题；结构化输出由同一问题确定性重建。",
      questions: visibleQuestions,
    });
  }
  if (fallbackContent.trim() && fallbackContent !== content) {
    // A malformed provider envelope must fall through to the complaint-aware route fallback, not
    // to a second generic plan created inside this parser. Reparse the server-owned visible blocks
    // through the same contract, then mark their provenance so telemetry and the clinician both
    // see that degradation occurred.
    const normalizedFallback = ensureQuestionStructuredEnvelope(fallbackContent, sourceText);
    const fallbackEnvelope = extractQuestionEnvelope(normalizedFallback) as { m02Plan?: unknown } | null;
    const fallbackPlan = parseM02Plan(fallbackEnvelope?.m02Plan, sourceText);
    if (fallbackPlan) {
      return renderEnvelope({
        ...fallbackPlan,
        rationale: "模型结构化追问计划不可用，改为与当前主诉类别匹配的高信息量安全追问。",
      });
    }
  }
  const fallback = {
    m02Plan: {
      schemaVersion: "tcm-cdss-m02-plan-v1",
      decision: "ask",
      rationale: "模型结构化追问计划不可用，改为核实最可能改变下一步判断的症状变化趋势。",
      questions: [{
        id: "q1",
        question: "与刚出现时相比，目前主要不适总体在加重、缓解，还是反复波动？",
        reason: "症状变化趋势会改变当前处置优先级和首要鉴别方向。",
        targetField: "xianbingshi",
        decisionBranch: "differential",
        expectedDecisionImpact: "帮助区分进展性问题与稳定或改善中的常见问题。",
        informationGain: 0.7,
        sourceEvidence: [],
        options: [
          { id: "worse", label: "近期明显加重", answer: "近期明显加重或出现新表现", kind: "clinical_fact", requiresDetail: true },
          { id: "stable", label: "稳定或缓解", answer: "目前总体稳定、反复波动或有所缓解", kind: "clinical_fact", recordValue: "目前总体稳定、反复波动或有所缓解" },
          { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
        ],
      }],
    },
  };
  return renderEnvelope(fallback.m02Plan as M02Plan);
}
