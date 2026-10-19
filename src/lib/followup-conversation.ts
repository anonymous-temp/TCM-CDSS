/**
 * 追问问答在 conversation 里的形状（2026-10-13，甲方真实传参）。
 *
 * 接口调用方把整份病历放在 symptoms 与顶层字段里，conversation 只装追问环节的内容：
 *   · 作答：一条 assistant（题干）+ 一条 user（所选选项原文）；
 *   · 跳过：只有一条 user，内容是固定句「本次未能确认，请继续现场评估」。
 * 此前安全闸门与事实层把「conversation 里有 user 消息」一律当成「医生在对话里口述了整份病历」，
 * 于是只要追问有一条回答或一次跳过，symptoms 里的病历正文就整体出局：现病史写明的呕血黑便不报红旗，
 * 孕周、抗凝药照常给出带剂量处方，性别/舌/脉/过敏史全变成未提供（生产 12/12 例）。
 *
 * 本模块是「一条 user 消息是什么」的唯一口径：
 *   · 跳过句不是病历内容，在请求入口就剔除（连同它前面那道没人回答的题）；
 *   · 紧跟在 assistant 题干后面的 user 消息是「追问回答」，是对病历的补充，不能顶替病历；
 *   · 其余 user 消息才是「对话里口述的主叙述」（旧式对话调用方），沿用原口径。
 * 跳过句是有限闭集，按整句匹配；不做开放语言判断。
 */

export const FOLLOWUP_SKIP_SENTENCE = "本次未能确认，请继续现场评估";

const FOLLOWUP_SKIP_SENTENCES = new Set(
  [
    FOLLOWUP_SKIP_SENTENCE,
    "本次未能确认",
    "跳过",
    "跳过追问",
    "跳过本轮追问",
    "暂不回答",
    "暂不作答",
  ].map(compactFollowupText),
);

function compactFollowupText(value: string): string {
  return value.normalize("NFKC").replace(/[\s，,。.!！?？；;：:、“”"'‘’]+/g, "");
}

export function isFollowupSkipMessage(content: string | undefined): boolean {
  const compact = compactFollowupText(content || "");
  return compact.length > 0 && FOLLOWUP_SKIP_SENTENCES.has(compact);
}

export interface ConversationMessageLike {
  role: "user" | "assistant";
  content: string;
}

export interface FollowupAnswer {
  question: string;
  answer: string;
}

export interface FollowupConversationView {
  /** 不跟在题干后面的 user 消息：对话里口述的主叙述。 */
  primaryNarrative: string[];
  /** 题干 + 回答。 */
  answers: FollowupAnswer[];
  /** 出现过跳过句。 */
  skipped: boolean;
}

export function followupConversationView(conversation: readonly ConversationMessageLike[] | undefined): FollowupConversationView {
  const view: FollowupConversationView = { primaryNarrative: [], answers: [], skipped: false };
  const messages = conversation || [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const content = (message.content || "").trim();
    if (!content) continue;
    if (isFollowupSkipMessage(content)) {
      view.skipped = true;
      continue;
    }
    const previous = index > 0 ? messages[index - 1] : undefined;
    if (previous?.role === "assistant" && previous.content.trim()) {
      view.answers.push({ question: previous.content.trim(), answer: content });
    } else {
      view.primaryNarrative.push(content);
    }
  }
  return view;
}

/** 请求入口用：剔除跳过句，以及紧挨在它前面、因此没有回答的那道题。 */
export function stripFollowupSkipMessages<T extends ConversationMessageLike>(conversation: readonly T[]): { conversation: T[]; skipped: boolean } {
  const kept: T[] = [];
  let skipped = false;
  for (const message of conversation) {
    if (message.role === "user" && isFollowupSkipMessage(message.content)) {
      skipped = true;
      if (kept.length > 0 && kept[kept.length - 1].role === "assistant") kept.pop();
      continue;
    }
    kept.push(message);
  }
  return { conversation: kept, skipped };
}

/**
 * 病历式 symptoms 的中文键 → 系统读取的规范槽位。接口文档 §3.3.1 约定 symptoms 给对象时按键原样保留，
 * 文档示例用的就是「现病史」；而完整度、过敏史/用药史是否已记录、妊娠筛查等判定读的是 presentHistory 与
 * 顶层 pastHistory / allergyHistory / medicationHistory。两边对不上时，甲方每份病历都被判成
 * 「现病史、过敏史未提供」。键名是有限闭集。
 */
export const RECORD_SYMPTOM_KEY_SLOTS: Readonly<Record<string, "presentHistory" | "pastHistory" | "allergyHistory" | "medicationHistory" | "exams" | "tongue" | "pulse" | "chiefComplaint">> = {
  现病史: "presentHistory",
  既往史: "pastHistory",
  既往病史: "pastHistory",
  过敏史: "allergyHistory",
  药物过敏史: "allergyHistory",
  用药史: "medicationHistory",
  现用药: "medicationHistory",
  当前用药: "medicationHistory",
  目前用药: "medicationHistory",
  辅助检查: "exams",
  舌象: "tongue",
  舌诊: "tongue",
  脉象: "pulse",
  脉诊: "pulse",
  主诉: "chiefComplaint",
};

/** 病历式 symptoms 里记经带胎产的中文键名（接口字段名；没有规范槽位，原样留在 symptoms 里）。 */
export const REPRODUCTIVE_RECORD_KEYS: readonly string[] = ["月经史", "婚育史", "月经婚育史", "月经及婚育史", "经带胎产史", "孕产史"];

export interface RiskScreeningQuestion {
  question: string;
  positive: string;
  negative: string;
}

/**
 * 事实层认为某类急症「可能」时，追问换成的服务端急症筛查题。阳性选项是一句泛指（「存在上述任一情况，
 * 请补充具体表现」），离开题干就没有内容：调用方把所选选项原样回传时，只看回答读不出阳性。
 * confirmedRiskScreeningCategories 按「题干 + 所选阳性选项」成对识别，交给安全闸门按已确认的急症表现处理。
 */
export const POSSIBLE_RISK_QUESTIONS: Readonly<Record<string, RiskScreeningQuestion>> = {
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
  // 只问一件事：是否仍在发生（2026-10-19 r1019 第四轮，Claude 评审 B-MedDG-train-dialog1533#3：旧题干「请复核该异常是否正在发生，
  // 并补充起病时间、严重程度、生命体征和意识呼吸状态」一题问五件事，起病时间病历已写；选项「经复核异常未在发生」是流程语）。
  // 题干前总带病历原话（riskQuestionQuotePrefix），「这一情况」有所指。旧题干仍可识别，见 LEGACY_RISK_QUESTIONS。
  other_critical: { question: "目前这一情况是否仍在发生？", positive: "目前仍在发生，请补充具体表现", negative: "目前已缓解，未再出现" },
};

export type RiskQuestionVariant = "infant" | "youngChild" | "male" | "anchored";

/**
 * 同一类目按人群或病历写法换用的题干（2026-10-19 r1019 第四轮，Claude 评审 B 集）。阳性选项沿用类目自己的，
 * 闸门按「题干 + 阳性选项」识别作答时与类目固定题干同等对待（RISK_QUESTION_BY_TEXT 收全部写法）。
 *  · infant：未满 1 岁（含新生儿）不会「拒绝饮水」，看的是吃奶（B-IMCS21-test-10454205#4 3 天新生儿、10694833#9）；
 *  · youngChild：未满 3 岁，寒战、血压下降家长无从观察，看精神、呼吸与皮肤（B-IMCS21-train-10700122#1 5 月龄）；
 *  · male：男性没有阴道出血（B-MedDG-train-dialog1722#12 46 岁男性便血）；
 *  · anchored：题干前带病历原话、出血部位就在引文里时，只问是否仍在出血及循环表现，不再列咯血、阴道流血、外伤出血这些
 *    与本例无关的部位（8156#3、1722#12 便血被问「咯血、阴道大量流血、外伤出血」）。
 */
export const RISK_QUESTION_VARIANTS: Readonly<Record<string, Readonly<Partial<Record<RiskQuestionVariant, { question: string; negative?: string }>>>>> = {
  pediatric_critical: {
    infant: { question: "患儿是否出现精神反应明显变差、抽搐、发绀、呼吸费力、吃奶明显减少甚至拒奶，或尿量显著减少？" },
  },
  sepsis: {
    youngChild: { question: "患儿目前是否体温过高或过低，并伴精神很差（嗜睡、难以唤醒）、呼吸急促或皮肤发花？", negative: "经询问未见体温异常伴精神、呼吸或皮肤改变" },
  },
  bleeding: {
    male: { question: "目前是否仍有咯血、外伤出血或其他出血不止？" },
    anchored: { question: "目前是否仍在出血不止，或伴头晕、心慌、出冷汗？", negative: "经询问出血已止，且无头晕、心慌、出冷汗" },
  },
};

/** 某类目某种写法的筛查题（没有该写法时返回类目固定题）。 */
export function riskScreeningQuestionFor(category: string, variant?: RiskQuestionVariant): RiskScreeningQuestion | undefined {
  const base = POSSIBLE_RISK_QUESTIONS[category];
  if (!base) return undefined;
  const alternative = variant ? RISK_QUESTION_VARIANTS[category]?.[variant] : undefined;
  return alternative ? { ...base, question: alternative.question, negative: alternative.negative ?? base.negative } : base;
}

/**
 * 已不再出、但调用方回传的对话里可能还带着的旧题干（只用于识别作答；2026-10-19 起不再出题）。
 * 题干与阳性选项照旧逐字成对识别。
 */
const LEGACY_RISK_QUESTIONS: Readonly<Record<string, readonly RiskScreeningQuestion[]>> = {
  other_critical: [{ question: "请复核该异常是否正在发生，并补充起病时间、严重程度、生命体征和意识呼吸状态。", positive: "异常仍在发生，请补充具体表现", negative: "经复核异常未在发生，且无生命体征、意识或呼吸改变" }],
};

/**
 * 「其他急危重线索」的筛查题在题干前带一段病历原话（「病历记录“…”。请复核该异常是否正在发生…」），让「该异常」有所指。
 * 识别作答时先去掉这段引文，剩下的才是与类目一一对应的固定题干。
 */
export function riskQuestionQuotePrefix(quote: string): string {
  return `病历记录“${quote}”。`;
}
const RISK_QUESTION_QUOTE_PREFIX = /^病历记录“[^”]{1,80}”。/;
export function stripRiskQuestionQuotePrefix(question: string): string {
  return question.replace(RISK_QUESTION_QUOTE_PREFIX, "");
}

const RISK_QUESTION_BY_TEXT = new Map<string, { category: string } & RiskScreeningQuestion>([
  ...Object.entries(POSSIBLE_RISK_QUESTIONS).map(([category, item]) => [compactFollowupText(item.question), { category, ...item }] as const),
  ...Object.entries(RISK_QUESTION_VARIANTS).flatMap(([category, variants]) => Object.keys(variants).map((variant) => {
    const item = riskScreeningQuestionFor(category, variant as RiskQuestionVariant) as RiskScreeningQuestion;
    return [compactFollowupText(item.question), { category, ...item }] as const;
  })),
  ...Object.entries(LEGACY_RISK_QUESTIONS).flatMap(([category, items]) =>
    items.map((item) => [compactFollowupText(item.question), { category, ...item }] as const)),
]);

/** 医生对服务端急症筛查题选了阳性选项的类目（题干与选项都必须逐字对上）。 */
export function confirmedRiskScreeningCategories(conversation: readonly ConversationMessageLike[] | undefined): Array<{ category: string; question: string }> {
  const confirmed: Array<{ category: string; question: string }> = [];
  for (const item of followupConversationView(conversation).answers) {
    const risk = RISK_QUESTION_BY_TEXT.get(compactFollowupText(stripRiskQuestionQuotePrefix(item.question.trim())));
    if (!risk) continue;
    if (compactFollowupText(item.answer) !== compactFollowupText(risk.positive)) continue;
    if (!confirmed.some((entry) => entry.category === risk.category)) confirmed.push({ category: risk.category, question: risk.question });
  }
  return confirmed;
}
