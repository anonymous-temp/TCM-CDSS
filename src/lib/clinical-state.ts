export type ClinicalStateStatus = "positive" | "possible" | "negative" | "historical" | "unknown";

export type ClinicalStateResult = {
  status: ClinicalStateStatus;
  evidence?: string;
};

export const UNKNOWN_CLINICAL_TEXT_PATTERN = /(?:未提及|未说明|未采集|未观察|未测|暂不清楚|不清楚|未知|不详|待确认|待核实|未核实|尚未核实|需补充|需确认|无法判断|无法识别|图片质量不足|\bnull\b|\bundefined\b)/i;

export function containsUnknownClinicalCue(value: unknown): boolean {
  if (value == null) return true;
  return UNKNOWN_CLINICAL_TEXT_PATTERN.test(typeof value === "string" ? value : String(value));
}

const CONCRETE_CLINICAL_FACT_PATTERN = new RegExp([
  "舌(?:质)?(?:淡|红|绛|紫|暗|胖|瘦|嫩|老|裂|有齿痕|齿痕|边红|尖红)",
  "苔(?:薄|厚|白|黄|腻|燥|润|剥|少|无)",
  "脉(?:浮|沉|迟|数|滑|涩|弦|细|弱|濡|缓|紧|实|虚|微|洪|结|代|促){1,4}",
  "(?:体温|T|血压|BP|脉搏|心率|P|呼吸|R|血氧|SpO2)?\\s*\\d+(?:\\.\\d+)?\\s*(?:℃|次/分|次每分|mmHg|%|mg|毫克|g|克|mL|毫升)",
  "(?:现服|正在服用|正在使用|用药为|口服|静滴|肌注)[^，。；;\\n]{1,30}",
  "(?:对[^，。；;\\n]{1,24}过敏|(?:药物|食物|青霉素|头孢|磺胺)[^，。；;\\n]{0,12}过敏)",
  "(?:否认|无|没有|不伴|伴有|出现|主诉|自觉|诉)[^，。；;\\n]{1,24}(?:胸痛|胸闷|心悸|晕厥|头痛|发热|咳嗽|气促|呼吸困难|腹痛|恶心|呕吐|失眠|入睡困难|盗汗|潮热|口苦|口渴|便秘|腹泻)",
  "(?:(?:突发|持续|反复|进行性|外伤后|今晨|今日|排|近\\d+(?:小时|天|周|月))[^，。；;\\n]{0,10})?(?:出血不止|持续出血|呕血|黑便|黑色便|柏油样便|便血|咯血|晕厥|黑矇|意识丧失|胸痛|胸闷|气促|呼吸困难|剧烈头痛|肢体无力|腹痛|腹胀|寒战|高热)(?:[^，。；;\\n]{0,12}(?:不止|加重|未缓解|\\d+(?:分钟|小时|天|周|月|mL|毫升)))?",
  "(?:检查|检验|化验|心电图|肌钙蛋白|肝功能|肾功能|甲功|血常规)[^，。；;\\n]{0,30}(?:正常|异常|阴性|阳性|升高|降低|未见异常)",
].join("|"), "i");
const CONCRETE_TONGUE_PATTERN = /舌(?:质)?(?:淡|红|绛|紫|暗|胖|瘦|嫩|老|裂|有齿痕|齿痕|边红|尖红)|苔(?:薄|厚|白|黄|腻|燥|润|剥|少|无)/;
const CONCRETE_PULSE_PATTERN = /(?:^|[，,；;\s])(?:脉)?(?:浮|沉|迟|数|滑|涩|弦|细|弱|濡|缓|紧|实|虚|微|洪|结|代|促){1,4}(?=$|[，,；;\s])/;

function hasConcreteClinicalFactAlongsideUnknown(text: string): boolean {
  return text
    .split(/[，,。；;\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) => !containsUnknownClinicalCue(clause) && CONCRETE_CLINICAL_FACT_PATTERN.test(clause));
}

export function isUnknownClinicalText(value: unknown): boolean {
  if (value == null) return true;
  const text = typeof value === "string" ? value.trim() : String(value).trim();
  if (!text) return true;
  if (!containsUnknownClinicalCue(text)) return false;
  // Explanations such as "图片模糊" or "患者说不清" are not findings. A mixed value
  // becomes known only when it also contains a concrete, independently usable fact.
  return !hasConcreteClinicalFactAlongsideUnknown(text);
}

export function isUnknownClinicalFieldText(
  value: unknown,
  field: "tongue" | "pulse" | "medication" | "allergy" | "generic",
): boolean {
  if (field === "generic") return isUnknownClinicalText(value);
  const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  if (!text) return true;
  if (field === "tongue" || field === "pulse") {
    const concrete = field === "tongue" ? CONCRETE_TONGUE_PATTERN : CONCRETE_PULSE_PATTERN;
    const unknown = field === "tongue"
      ? /舌象[^。；;\n]{0,16}(?:待核实|待确认|未知|无法判断|未采集)/g
      : /脉象[^。；;\n]{0,16}(?:待核实|待确认|未知|无法判断|未采集)/g;
    const concreteGlobal = new RegExp(concrete.source, "g");
    const lastConcrete = Array.from(text.matchAll(concreteGlobal)).at(-1)?.index ?? -1;
    const lastUnknown = Array.from(text.matchAll(unknown)).at(-1)?.index ?? -1;
    return lastConcrete < 0 || lastUnknown > lastConcrete;
  }
  if (field === "medication") return !/(?:现服|正在服用|正在使用|用药为|口服|静滴|肌注|否认[^。；;\n]{0,16}(?:用药|服药)|无[^。；;\n]{0,12}(?:用药|服药))/.test(text);
  return !/(?:对[^。；;\n]{1,24}过敏|(?:药物|食物|青霉素|头孢|磺胺)[^。；;\n]{0,12}过敏|否认[^。；;\n]{0,16}过敏|无[^。；;\n]{0,12}过敏)/.test(text);
}

type ClinicalStateCandidate = {
  status: ClinicalStateStatus;
  evidence: string;
  index: number;
  historicalContext: boolean;
};

function makeGlobalRegex(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function clauseBefore(text: string, index: number): string {
  const start = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("，", index - 1),
    text.lastIndexOf(",", index - 1),
    text.lastIndexOf("\n", index - 1),
  ) + 1;
  return text.slice(start, index);
}

function hasCurrentMarker(text: string): boolean {
  return /(当前|目前|现在|现|本次|此次|今日|今天)/.test(text);
}

function hasHistoricalMarker(text: string): boolean {
  return /(既往|曾经|既往史|孕产史|妊娠史|怀孕史|产史)/.test(text);
}

function isExplicitCurrentGestation(matchText: string): boolean {
  return /(?:已妊娠|妊娠中|怀孕中|已经怀孕|确认怀孕|孕\d+(?:\+?)(?:周|月)?|(?:妊娠|怀孕)\d+(?:\+?)(?:周|月)|孕(?:早|中|晚)期|妊娠(?:早|中|晚)期)/.test(matchText);
}

function isHistoricalContext(text: string, index: number, matchText: string): boolean {
  const before = clauseBefore(text, index);
  const after = text.slice(index + matchText.length, index + matchText.length + 8);
  if (/^产\d/.test(after)) return true;
  // A section label such as "既往史：" describes where the fact was entered, not necessarily
  // the temporality of every fact in that field. Explicit gestational-age/current-pregnancy
  // grammar is stronger evidence than the surrounding field label (for example
  // "既往史：高血压；妊娠8周"). Only a marker immediately governing the pregnancy phrase may
  // turn it into historical context.
  if (isExplicitCurrentGestation(matchText)) {
    if (/^(?:后)?(?:自然)?(?:流产|终止妊娠|引产|分娩|已结束)/.test(after)) return true;
    if (hasCurrentMarker(before)) return false;
    if (/既往史[：:]$/.test(before)) return false;
    return /(?:既往|曾经|妊娠史|怀孕史)[^。；;,，\n]{0,6}$/.test(before);
  }
  return hasHistoricalMarker(before) && !hasCurrentMarker(before);
}

function isNegatedPositiveContext(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 10), index);
  return /(否认|无|没有|未|非|不在|停止|已停止)$/.test(before);
}

function collectMatches(
  text: string,
  patterns: RegExp[],
  status: ClinicalStateStatus,
): ClinicalStateCandidate[] {
  const candidates: ClinicalStateCandidate[] = [];
  for (const pattern of patterns) {
    const regex = makeGlobalRegex(pattern);
    for (const match of text.matchAll(regex)) {
      const index = match.index ?? -1;
      if (index < 0 || !match[0]) continue;
      if ((status === "positive" || status === "possible") && isNegatedPositiveContext(text, index)) continue;
      candidates.push({
        status,
        evidence: match[0],
        index,
        historicalContext: status === "historical" || isHistoricalContext(text, index, match[0]),
      });
    }
  }
  return candidates;
}

function assessState(
  text: string,
  patterns: {
    positive: RegExp[];
    possible: RegExp[];
    negative: RegExp[];
    historical: RegExp[];
  },
): ClinicalStateResult {
  const normalized = (text || "").replace(/\s+/g, "");
  if (!normalized) return { status: "unknown" };

  const candidates = [
    ...collectMatches(normalized, patterns.negative, "negative"),
    ...collectMatches(normalized, patterns.positive, "positive"),
    ...collectMatches(normalized, patterns.possible, "possible"),
    ...collectMatches(normalized, patterns.historical, "historical"),
  ].sort((a, b) => a.index - b.index);

  const currentCandidates = candidates.filter((item) => !item.historicalContext);
  // "Latest current statement wins." An explicit positive like "孕24周" is protected from a later
  // generic negation not by overriding order here (which would wrongly beat a true later negation such
  // as "已停止哺乳"), but by the tightened negative patterns below — e.g. "无妊娠期高血压" no longer
  // matches as a pregnancy denial, so the positive remains the only candidate.
  const latestCurrent = currentCandidates[currentCandidates.length - 1];
  if (latestCurrent) return { status: latestCurrent.status, evidence: latestCurrent.evidence };

  const latestHistorical = candidates[candidates.length - 1];
  if (latestHistorical) return { status: "historical", evidence: latestHistorical.evidence };

  return { status: "unknown" };
}

export function assessPregnancyState(text: string): ClinicalStateResult {
  return assessState(text, {
    positive: [
      /已妊娠/,
      /妊娠中/,
      /怀孕中/,
      /已经怀孕/,
      /确认怀孕/,
      /孕\d+(?:\+?)(?:周|月)?/,
      /(?:妊娠|怀孕)\d+(?:\+?)(?:周|月)/,
      /孕(?:早|中|晚)期/,
      /妊娠(?:早|中|晚)期/,
      /(?:尿|血|β-?)?HCG阳性/i,
      /(?:尿|血)?(?:妊娠|早孕)试验阳性/,
      // ─── 口语与病历常见写法 ───
      // 上面那批全是书面正式写法。实测「患者女，28岁，孕妇，感冒3天」「怀孕了，最近咳得厉害」
      // 「妊娠期」「有身孕」全部判 unknown——而「孕妇」恰恰是门诊病历里最常见的记法。
      // 后果不是少个标签：hasPositivePregnancyOrLactationRisk 是**剂量级处方的闸门**
      // （diagnosis-safety.ts:3133 命中即锁"需补齐或复核"），判不出就等于孕妇直接拿到剂量级处方。
      //
      // 补阳性写法是并集语义：只会多落闸，不会少落闸，方向上安全。
      // 否定与既往侧已有 未孕/未怀孕/否认妊娠/HCG阴性/孕N产N 等把关，不会被这批盖过。
      // 逐条都带排除，避免把"备孕/不孕/避孕/孕前咨询/妊娠期高血压(并发症名)"读成当前妊娠：
      /孕妇/,
      /怀孕了/,
      /已怀孕/,
      /怀上了?/,
      /有身孕/,
      /身怀六甲/,
      /怀着(?:孩子|宝宝|胎儿?)/,
      /宫内(?:早)?孕/,
      /(?:现|正)在?怀孕/,
      // 「妊娠期高血压/糖尿病」是并发症名而非当前妊娠陈述，「妊娠期保健」同理，逐个排除。
      /妊娠期(?!高血压|糖尿|合并|并发|保健|营养|用药|禁忌)/,
      // 「孕期」同理；「孕前」是备孕，归 assessConceptionState 管，不在这里。
      /孕期(?!前|保健|营养|用药|禁忌|检查)/,
      /(?:待|临)产/,
    ],
    possible: [
      /妊娠可能/,
      /怀孕可能/,
      /可能妊娠/,
      /可能怀孕/,
      /疑似妊娠/,
      /疑似怀孕/,
      /不能排除妊娠/,
      /不能排除怀孕/,
      /未避孕[^。；\n]{0,16}(?:妊娠|怀孕|月经推迟|停经|可能)/,
      /(?:月经推迟|停经)[^。；\n]{0,16}(?:妊娠|怀孕|可能|待查)/,
      /停经\d+(?:\+?)(?:周|天|月|个月)/,
    ],
    negative: [
      // Negative lookahead stops complication/symptom phrases ("无妊娠期高血压", "否认妊娠剧吐",
      // "无早孕反应") from being read as a denial of pregnancy itself.
      /否认[^。；\n]{0,16}(?:妊娠|怀孕)(?!期|反应|糖尿|高血压|剧吐|呕吐|纹|斑|合并|并发|期间|物)/,
      /无[^。；\n]{0,12}(?:妊娠|怀孕)(?!期|反应|糖尿|高血压|剧吐|呕吐|纹|斑|合并|并发|期间|物)/,
      /没有[^。；\n]{0,12}(?:妊娠|怀孕)(?!期|反应|糖尿|高血压|剧吐|呕吐|纹|斑|合并|并发|期间|物)/,
      /未妊娠/,
      /未怀孕/,
      /未孕/,
      /妊娠试验阴性/,
      /尿妊娠阴性/,
      /(?:尿|血|β-?)?HCG阴性/i,
    ],
    historical: [
      /既往孕\d+产\d+/,
      /既往[^。；\n]{0,16}(?:妊娠|怀孕|孕产史)/,
      /曾经[^。；\n]{0,16}(?:妊娠|怀孕)/,
      /孕产史/,
      /孕\d+产\d+/,
    ],
  });
}

export function assessLactationState(text: string): ClinicalStateResult {
  return assessState(text, {
    positive: [
      /正在哺乳/,
      /哺乳期/,
      /仍在哺乳/,
      /未停止哺乳/,
      /母乳喂养/,
    ],
    possible: [
      /可能哺乳/,
      /疑似哺乳/,
      /不能排除哺乳/,
      /产后[^。；\n]{0,12}(?:是否)?哺乳(?:不详|未知|待确认)?/,
    ],
    negative: [
      /否认[^。；\n]{0,12}哺乳/,
      /无[^。；\n]{0,12}哺乳/,
      /没有[^。；\n]{0,12}哺乳/,
      /未在哺乳/,
      /不在哺乳/,
      /非哺乳期/,
      /已停止哺乳/,
    ],
    historical: [
      /既往[^。；\n]{0,16}哺乳/,
      /曾经[^。；\n]{0,16}哺乳/,
    ],
  });
}

export function assessConceptionState(text: string): ClinicalStateResult {
  return assessState(text, {
    positive: [
      /正在备孕/,
      /备孕中/,
      /计划妊娠/,
      /有备孕计划/,
      /有生育计划/,
      /近期妊娠计划/,
    ],
    possible: [
      /未避孕/,
      /备孕可能/,
      /可能备孕/,
      /不能排除备孕/,
      /生育计划待确认/,
    ],
    negative: [
      /否认[^。；\n]{0,16}(?:备孕|妊娠计划|生育计划)/,
      /无[^。；\n]{0,16}(?:备孕|妊娠计划|生育计划)/,
      /没有[^。；\n]{0,16}(?:备孕|妊娠计划|生育计划)/,
      /近期无妊娠计划/,
      /无备孕计划/,
    ],
    historical: [
      /既往[^。；\n]{0,16}(?:备孕|妊娠计划|生育计划)/,
      /曾经[^。；\n]{0,16}(?:备孕|妊娠计划|生育计划)/,
    ],
  });
}

export function isKnownClinicalState(state: ClinicalStateResult): boolean {
  return state.status === "positive" || state.status === "possible" || state.status === "negative";
}

export function isPositiveOrPossibleClinicalState(state: ClinicalStateResult): boolean {
  return state.status === "positive" || state.status === "possible";
}
