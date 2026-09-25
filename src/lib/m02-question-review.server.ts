import {
  enforceM02UnansweredAxes,
  ensureQuestionStructuredEnvelope,
  m02QuestionRationaleNeedsNeutralization,
  neutralizeM02PlanQuestionRationales,
  parseM02PlanFromContent,
  removeM02PlanQuestions,
} from "./m02-question-contract";

type M02PlanQuestion = NonNullable<ReturnType<typeof parseM02PlanFromContent>>["questions"][number];

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

function deterministicallyRemovable(question: M02PlanQuestion, clinicalSource: string): boolean {
  const clinicalOptions = question.options.filter((option) => option.kind === "clinical_fact");
  if (isUnrelatedReproductiveStatusQuestion(question.question, clinicalSource)) {
    return true;
  }
  // Two independent positive findings are not a single-choice branch: both can be true at once.
  // Categorical alternatives (cold/hot, watery/formed, etc.) are kept.
  if (clinicalOptions.length === 2 && clinicalOptions.every((option) => startsAsIndependentPositive(option.answer))) {
    return true;
  }
  const clinicalAnswers = clinicalOptions.map((option) => option.answer);
  if (binaryPresenceOptionsNotExclusive(question.question, clinicalAnswers) || optionAnswersOverlap(clinicalAnswers)) {
    return true;
  }
  // "Dry cough" is already the answer to a sputum-presence question. Asking for sputum colour or
  // texture again cannot add information unless the record later documents sputum production.
  return /(?:干咳|无痰)/.test(clinicalSource) && /(?:有没有|是否|有无).{0,16}痰|咳嗽.{0,12}痰/.test(question.question);
}

function redundantAcuteAbdomenQuestionIds(questions: readonly M02PlanQuestion[]): string[] {
  const triage = questions.find((question) => {
    const acuteMarkers = question.question.match(/突然|剧烈|加重|反跳痛|僵硬|持续呕吐|停止排气排便/g) || [];
    return /腹痛|肚子.{0,6}痛/.test(question.question) && acuteMarkers.length >= 2;
  });
  if (!triage) return [];
  return questions.flatMap((question) =>
    question.id !== triage.id &&
    /腹痛|肚子.{0,6}痛|绞痛|持续性疼痛/.test(`${question.question}；${question.reason}；${question.expectedDecisionImpact}`)
      ? [question.id]
      : []);
}

const DETERMINISTIC_REMOVAL_RATIONALE = "确定性复核已移除病历已回答或不满足单选互斥要求的候选问题。";

/**
 * M02 出题的确定性收口：删掉病历已答过、A/B 不互斥、无关妊娠占位、急腹症重复的问题，
 * 把诱导性/空泛/时间范围矛盾的追问理由换成服务端中性模板；计划被删空时给一条服务端自有的
 * 主诉类别兜底题，保证医生仍有同一次 M02 机会。
 *
 * 2026-09-25 起这是唯一的收口，不再调模型复核。此前复核模型与出题同为 deepseek-flash
 * （同模型自评——与 2026-09-16 删掉的 M03/M04 复核同一形态）；实验 E1（34 例、同一份出题原文
 * 两臂对比）：模型复核臂删题 13、改理由 37，纯确定性臂删题 14、改理由 39，分歧双向、无一方系统性
 * 更好，而复核在 4.5s 的 M02 上多花 p50 1.16s。本函数即当时「复核不可用」分支，逐字保留。
 */
export function reviewM02QuestionPlan(
  content: string,
  clinicalSource: string,
  fallbackContent = "",
): string {
  const initialPlan = parseM02PlanFromContent(content);
  if (!initialPlan || initialPlan.decision !== "ask" || initialPlan.questions.length === 0) return content;
  const removalIds = [
    ...initialPlan.questions
      .filter((question) => deterministicallyRemovable(question, clinicalSource))
      .map((question) => question.id),
    ...redundantAcuteAbdomenQuestionIds(initialPlan.questions),
  ];
  const guardedContent = removalIds.length > 0
    ? removeM02PlanQuestions(content, removalIds, DETERMINISTIC_REMOVAL_RATIONALE)
    : content;
  const plan = parseM02PlanFromContent(guardedContent);
  if (!plan || plan.decision !== "ask" || plan.questions.length === 0) {
    // 计划被删空：路由总会提供一条服务端自有的主诉类别兜底题，保留同一次 M02 机会，
    // 而不是把「候选题都不合格」悄悄变成「无需追问」。兜底题同样过已答轴守卫。
    return plan?.decision === "proceed" && fallbackContent.trim()
      ? enforceM02UnansweredAxes(
          ensureQuestionStructuredEnvelope(fallbackContent, clinicalSource),
          clinicalSource,
        )
      : guardedContent;
  }
  const leadingIds = plan.questions
    .filter(m02QuestionRationaleNeedsNeutralization)
    .map((question) => question.id);
  return leadingIds.length > 0
    ? neutralizeM02PlanQuestionRationales(guardedContent, leadingIds)
    : guardedContent;
}
