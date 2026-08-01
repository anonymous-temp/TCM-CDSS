type QuestionFallbackCase = {
  patient?: { age?: number | string };
  chiefComplaint?: string;
  symptoms?: Record<string, unknown>;
  tongue?: string;
  pulse?: string;
  clinicalFacts?: { redFlags?: Array<{ category?: string; status?: string; urgency?: string; quote?: string }> };
  hisRecord?: { fields?: { age?: string; zhushu?: string; xianbingshi?: string; tcmDetail?: string; tcmTongue?: string; tcmPulse?: string } };
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
  for (const rawQuestion of root.questions) {
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

    if (!Array.isArray(item.sourceEvidence) || item.sourceEvidence.length > 4) return null;
    const sourceEvidence = item.sourceEvidence.map((entry) => groundedM02Evidence(entry, sourceText));
    if (sourceEvidence.some((entry) => !entry)) return null;

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
    questions.push({
      id,
      question,
      reason,
      targetField,
      decisionBranch,
      expectedDecisionImpact,
      informationGain,
      sourceEvidence: sourceEvidence as string[],
      options,
    });
  }
  return { schemaVersion: "tcm-cdss-m02-plan-v1", decision: root.decision, rationale, questions };
}

export function parseM02PlanFromContent(content: string): M02Plan | null {
  const envelope = extractQuestionEnvelope(content);
  if (!envelope || typeof envelope !== "object") return null;
  return parseM02Plan((envelope as { m02Plan?: unknown }).m02Plan);
}

// These phrases are used only after the semantic red-flag model has emitted a
// grounded category. They are a safety fallback, not a symptom classifier.
const POSSIBLE_RISK_QUESTIONS: Record<string, Omit<PossibleRiskQuestion, "category">> = {
  cardiac: { question: "目前是否正在出现胸痛、胸口压迫感，并伴冷汗、气促、恶心或向肩臂放射？", positive: "存在上述任一情况，请补充具体表现", negative: "经询问目前未见上述胸部不适和伴随表现" },
  syncope: { question: "本次是否确实发生过完全失去意识、跌倒，或呼叫后短时间不能回应？", positive: "确实发生过上述任一情况，请补充具体表现", negative: "经询问未发生意识丧失或跌倒" },
  neuro: { question: "目前是否出现突然说话不清、口角歪斜、单侧肢体无力、意识改变或突发剧烈头痛？", positive: "存在上述任一情况，请补充具体表现", negative: "经询问未见上述急性神经功能异常" },
  gi_bleed: { question: "本次是否确实出现柏油样黑便、鲜血便或呕血？", positive: "存在上述任一情况，请补充具体表现", negative: "经询问未见黑便、鲜血便或呕血" },
  bleeding: { question: "目前是否仍有咯血、阴道大量流血、外伤出血或其他出血不止？", positive: "存在上述任一情况，请补充具体表现", negative: "经询问未见正在发生或难以止住的出血" },
  acute_abdomen: { question: "腹痛是否突然加重或剧烈，并伴反跳痛、腹部僵硬、持续呕吐或停止排气排便？", positive: "存在上述任一情况，请补充具体表现", negative: "经询问未见急剧加重、剧痛或腹膜刺激征" },
  respiratory: { question: "目前是否静息也喘、不能平卧、说话受限、口唇发紫或呼吸迅速加重？", positive: "存在上述任一情况，请补充具体表现", negative: "经询问未见上述呼吸困难或缺氧表现" },
  sepsis: { question: "目前是否高热或低体温伴寒战、意识变差、呼吸急促或血压下降？", positive: "存在上述任一情况，请补充具体表现", negative: "经询问未见体温异常伴全身状态恶化" },
  mental_crisis: { question: "患者目前是否有明确自伤、轻生或伤害他人的想法、计划或已实施行为？", positive: "存在上述任一情况，请补充具体表现", negative: "经直接询问未见上述想法、计划或行为" },
  shock: { question: "目前是否出现四肢湿冷、意识变差、站立不稳、尿量显著减少或血压明显下降？", positive: "存在上述任一情况，请补充具体表现", negative: "经询问未见上述循环灌注不足表现" },
  anaphylaxis: { question: "接触可疑食物或药物后，是否出现喉头或舌唇肿胀、声音嘶哑、喘憋、全身风团或头晕？", positive: "存在上述任一情况，请补充具体表现", negative: "经询问未见气道、呼吸或循环受累表现" },
  obstetric: { question: "妊娠期或可能妊娠时，是否出现一侧剧烈腹痛、大量阴道流血、晕厥、抽搐或胎动异常？", positive: "存在上述任一情况，请补充具体表现", negative: "经询问未见上述妊娠相关急症表现" },
  pediatric_critical: { question: "患儿是否出现精神反应明显变差、抽搐、发绀、呼吸费力、拒绝饮水或尿量显著减少？", positive: "存在上述任一情况，请补充具体表现", negative: "经询问未见上述儿童全身危重表现" },
  poisoning: { question: "请核实可能接触或摄入的物质、时间和大致剂量；目前是否有意识、呼吸、抽搐或持续呕吐异常？", positive: "存在可疑暴露或上述任一异常，请补充具体表现", negative: "经核实无可疑暴露，且未见意识、呼吸或抽搐异常" },
  metabolic: { question: "目前是否有血糖明显异常，并伴意识改变、抽搐、深大呼吸或持续呕吐？", positive: "存在上述任一情况，请补充具体表现", negative: "经测量未见严重血糖异常或相应全身表现" },
  other_critical: { question: "请复核该异常是否正在发生，并补充起病时间、严重程度、生命体征和意识呼吸状态。", positive: "异常仍在发生，请补充具体表现", negative: "经复核异常未在发生，且无生命体征、意识或呼吸改变" },
};

function possibleRiskQuestion(state?: QuestionFallbackCase): PossibleRiskQuestion | undefined {
  const candidates = (state?.clinicalFacts?.redFlags || [])
    .filter((item) => typeof item.category === "string" && (item.status === "possible" || item.urgency === "clarify" || item.urgency === "urgent"))
    .sort((left, right) => {
      const rank = (item: { status?: string; urgency?: string }) =>
        item.urgency === "urgent" ? 3 : item.urgency === "clarify" ? 2 : item.status === "possible" ? 1 : 0;
      return rank(right) - rank(left);
    });
  const category = candidates[0]?.category;
  const question = category ? POSSIBLE_RISK_QUESTIONS[category] : undefined;
  return category && question ? { category, ...question } : undefined;
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

function genericModelFailureFallback(state: QuestionFallbackCase): string {
  const chief = (state.chiefComplaint || state.hisRecord?.fields?.zhushu || "本次主要不适").trim();
  return questionBlock(
    1,
    `与刚出现时相比，“${chief.slice(0, 36)}”目前总体在加重、缓解还是反复波动？`,
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

/** Used only when the provider fails or omits a grounded semantic safety concern. */
export function buildCaseAwareQuestionFallback(state: QuestionFallbackCase): string {
  const risk = possibleRiskQuestion(state);
  if (!risk) {
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
    return genericModelFailureFallback(state);
  }
  return questionBlock(
    1,
    risk.question,
    "该已识别线索可能改变即时处置路径，需要先由医生核实其是否发生及发生时的具体情况。",
    "现病史",
    [risk.positive, risk.negative, "本次未能确认，请继续现场评估"],
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

function optionAlreadyKnown(option: M02PlanOption, sourceText: string): boolean {
  if (option.kind !== "clinical_fact" || option.requiresDetail) return false;
  const source = comparable(sourceText);
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
 * Broader paraphrases remain the independent semantic reviewer's responsibility.
 */
function questionAxisAlreadyKnown(question: M02PlanQuestion, sourceText: string): boolean {
  if (!sourceText.trim()) return false;
  const questionText = [
    question.question,
    question.reason,
    question.expectedDecisionImpact,
    ...question.options.map((option) => `${option.answer}。${option.recordValue || ""}`),
  ].join("；");
  return (Object.keys(AXIS_QUESTION_PATTERNS) as KnownClinicalAxis[]).some((axis) =>
    AXIS_QUESTION_PATTERNS[axis].test(questionText) && AXIS_SOURCE_PATTERNS[axis].test(sourceText));
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
        completeness?: unknown;
        m02Plan?: unknown;
      };
      const plan = parseM02Plan(envelope.m02Plan, sourceText);
      return plan && envelope.completeness && typeof envelope.completeness === "object"
        ? { completeness: envelope.completeness, plan }
        : null;
    } catch {
      return null;
    }
  };

  const primary = normalizeEnvelope(content);
  const fallback = fallbackContent ? normalizeEnvelope(ensureQuestionStructuredEnvelope(fallbackContent, sourceText)) : null;
  const source = primary || fallback;
  if (!source) return content;
  let questions = source.plan.questions.filter((question) => !questionAlreadyAnswered(question, sourceText));
  const groundedRisk = possibleRiskQuestion(state);
  if (groundedRisk && fallback?.plan.questions[0]) {
    // A grounded risk owns one canonical, exhaustive triage axis. Replace every provider variant
    // on that axis instead of prepending a second wording of the same urgent decision branch.
    const riskQuestion = { ...fallback.plan.questions[0], id: "q1" };
    questions = [riskQuestion, ...questions.filter((question) => !questionCoversGroundedRisk(question, groundedRisk))];
  }
  if (questions.length === 0 && source.plan.decision === "ask" && fallback && source !== fallback) {
    questions = fallback.plan.questions.filter((question) => !questionAlreadyAnswered(question, sourceText));
  }
  const normalizedQuestions = questions.slice(0, 2).map((question, index) => ({ ...question, id: `q${index + 1}` }));
  const plan: M02Plan = normalizedQuestions.length > 0
    ? { ...source.plan, decision: "ask", questions: normalizedQuestions }
    : { ...source.plan, decision: "proceed", rationale: "当前候选追问的答案已在病历中明确记录，无需重复询问。", questions: [] };
  return [
    renderStructuredM02Plan(plan),
    "",
    QUESTION_SENTINEL_START,
    JSON.stringify({ completeness: source.completeness, m02Plan: plan }),
    QUESTION_SENTINEL_END,
  ].join("\n");
}

export function removeM02PlanQuestions(content: string, questionIds: string[], rationale: string): string {
  const start = content.indexOf(QUESTION_SENTINEL_START);
  const end = start >= 0 ? content.indexOf(QUESTION_SENTINEL_END, start) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const envelope = JSON.parse(content.slice(start + QUESTION_SENTINEL_START.length, end).trim()) as {
      completeness?: unknown;
      m02Plan?: unknown;
    };
    const plan = parseM02Plan(envelope.m02Plan);
    if (!plan || !envelope.completeness || typeof envelope.completeness !== "object") return content;
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
      JSON.stringify({ completeness: envelope.completeness, m02Plan: nextPlan }),
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
 * explained as checking the patient's current state (and vice versa). Broader semantic cases are
 * classified by the independent M02 reviewer. The final wording always comes from a server-owned
 * template, so reviewer prose can neither diagnose the patient nor leak a prescription into the
 * question card.
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
      completeness?: unknown;
      m02Plan?: unknown;
    };
    const plan = parseM02Plan(envelope.m02Plan);
    if (!plan || !envelope.completeness || typeof envelope.completeness !== "object") return content;
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
      JSON.stringify({ completeness: envelope.completeness, m02Plan: nextPlan }),
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
  bleeding: /咯血|阴道.{0,4}流血|出血不止/,
  acute_abdomen: /腹痛|肚子.{0,6}痛|绞痛|反跳痛|腹部僵硬|停止排气排便|肠梗阻|急腹症/,
  respiratory: /静息.{0,4}喘|不能平卧|说话受限|口唇发紫|呼吸困难/,
  sepsis: /高热|低体温|寒战|意识变差|血压下降|脓毒/,
  mental_crisis: /自伤|轻生|伤害他人|自杀/,
  shock: /四肢湿冷|站立不稳|尿量.{0,4}减少|循环灌注|休克/,
  anaphylaxis: /喉头|舌唇肿胀|声音嘶哑|喘憋|全身风团|过敏反应/,
  obstetric: /妊娠|孕期|阴道.{0,4}流血|胎动异常|子痫/,
  pediatric_critical: /患儿|儿童|发绀|拒绝饮水|精神反应.{0,4}差/,
  poisoning: /接触|摄入|误服|中毒|可疑暴露|剂量/,
  metabolic: /血糖|深大呼吸|代谢/,
  other_critical: /生命体征|意识|呼吸状态|异常.{0,4}发生/,
};

function questionCoversGroundedRisk(question: M02PlanQuestion, risk: PossibleRiskQuestion): boolean {
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
  const renderEnvelope = (completeness: unknown, plan: M02Plan) => [
    renderStructuredM02Plan(plan),
    "",
    QUESTION_SENTINEL_START,
    JSON.stringify({ completeness, m02Plan: plan }),
    QUESTION_SENTINEL_END,
  ].join("\n");
  const parseEnvelope = (value: unknown): string | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const parsed = value as { completeness?: unknown; m02Plan?: unknown };
    const plan = parseM02Plan(parsed.m02Plan, sourceText);
    return parsed.completeness && typeof parsed.completeness === "object" && plan
      ? renderEnvelope(parsed.completeness, plan)
      : null;
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
    return renderEnvelope(
      { level: "B", redFlag: 0.6, infoGain: 0.6, managementImpact: 0.6, answerability: 0.6 },
      {
        schemaVersion: "tcm-cdss-m02-plan-v1",
        decision: "ask",
        rationale: "保留模型已生成且满足交互约束的高信息增益问题；结构化输出由同一问题确定性重建。",
        questions: visibleQuestions,
      },
    );
  }
  if (fallbackContent.trim() && fallbackContent !== content) {
    // A malformed provider envelope must fall through to the complaint-aware route fallback, not
    // to a second generic plan created inside this parser. Reparse the server-owned visible blocks
    // through the same contract, then mark their provenance so telemetry and the clinician both
    // see that degradation occurred.
    const normalizedFallback = ensureQuestionStructuredEnvelope(fallbackContent, sourceText);
    const fallbackEnvelope = extractQuestionEnvelope(normalizedFallback) as { completeness?: unknown; m02Plan?: unknown } | null;
    const fallbackPlan = parseM02Plan(fallbackEnvelope?.m02Plan, sourceText);
    if (fallbackEnvelope?.completeness && typeof fallbackEnvelope.completeness === "object" && fallbackPlan) {
      return renderEnvelope(fallbackEnvelope.completeness, {
        ...fallbackPlan,
        rationale: "模型结构化追问计划不可用，改为与当前主诉类别匹配的高信息量安全追问。",
      });
    }
  }
  const fallback = {
    completeness: { level: "B", redFlag: 0.6, infoGain: 0.4, managementImpact: 0.4, answerability: 0.4 },
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
  return renderEnvelope(fallback.completeness, fallback.m02Plan as M02Plan);
}
