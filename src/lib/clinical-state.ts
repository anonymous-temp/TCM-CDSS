import { inspectionLexiconPattern } from "./tcm-inspection-lexicon";

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

/**
 * 脉象词表的**唯一**来源。此前同一份词表在 6 处各抄了一遍（clinical-state 两处、clinical-entry、
 * diagnosis-safety、diagnosis-stage-contract 两处、DiagnosisClient），并且已经开始分叉：
 * clinical-entry 收了完整的二十八脉，其余五处只有 18 个，散、芤、革、牢、伏、动、长、短全缺。
 * 同一个「这是不是一条脉象记录」的判断，在不同环节会给出不同答案。
 */
export const PULSE_QUALITY_PATTERN_SOURCE =
  "浮|沉|迟|数|滑|涩|弦|细|弱|濡|缓|紧|实|虚|微|洪|结|代|促|散|芤|革|牢|伏|动|长|短|疾";
/**
 * 脉力与节律限定词。它们几乎总是跟在脉象之后（脉细弦无力、脉沉细无力、脉弱无力），
 * 但不属于脉象本身，所以必须单独成组。
 */
export const PULSE_FORCE_PATTERN_SOURCE = "无力|有力|少力|不整|不齐";
/**
 * 「脉」字前出现这些字时，「X脉」是**脉管/方名/治法**的构词，不是脉象断言（构词式闭集守卫，只列字，不列病例）：
 * 经脉、血脉、络脉、筋脉、冲脉/任脉/督脉/带脉（奇经）、阴维脉/阳维脉/阴跷脉/阳跷脉、动脉、静脉、
 * 生脉（散/饮）、通脉（四逆汤）、复脉（汤）。后面碰巧跟着脉名字（散/实/虚/弱/紧/长/短…）时，
 * 「温通经脉散寒」「血脉实」里的「脉散」「脉实」不是散脉、实脉——识别面与改写面必须认同一批词，所以只此一处。
 * 来源：2026-10-19 留出例 S079（方义「肉桂温通经脉散寒」被净化器改成「肉桂温通经脉象待核实寒」），与 10/13 的「生脉散」同类。
 * 刻意不收「心/肝/脾/肺/肾」：「肝脉弦」「心脉洪」是《内经》脏腑脉位的真脉象断言。
 */
export const PULSE_VESSEL_NOUN_PREFIX_CLASS = "生动静经络筋冲任督带通复维跷";
/** 「失血脉微欲绝」「吐血脉数」的「血」是出血，后面的脉是真脉象断言：血字前是出血动词/名词时不按脉管构词放过。 */
const PULSE_BLEEDING_BEFORE_XUE_CLASS = "失亡出吐咯衄便尿崩漏下呕";
/**
 * 放在「脉」（或以「脉」起头的脉象词）之前的反向断言：脉前是脉管构词（上面的字集，或不跟在出血词后的「血」）就不匹配。
 * 诊断净化的改写面与叙述式脉象的识别面共用这一份。
 */
export const PULSE_VESSEL_NOUN_LOOKBEHIND_SOURCE =
  `(?<![${PULSE_VESSEL_NOUN_PREFIX_CLASS}])(?<!(?<![${PULSE_BLEEDING_BEFORE_XUE_CLASS}])血)`;

const CONCRETE_CLINICAL_FACT_PATTERN = new RegExp([
  "舌(?:质)?(?:淡|红|绛|紫|暗|胖|瘦|嫩|老|裂|有齿痕|齿痕|边红|尖红)",
  "苔(?:薄|厚|白|黄|腻|燥|润|剥|少|无)",
  `脉(?:${PULSE_QUALITY_PATTERN_SOURCE}){1,4}(?:${PULSE_FORCE_PATTERN_SOURCE})?`,
  "(?:体温|T|血压|BP|脉搏|心率|P|呼吸|R|血氧|SpO2)?\\s*\\d+(?:\\.\\d+)?\\s*(?:℃|次/分|次每分|mmHg|%|mg|毫克|g|克|mL|毫升)",
  "(?:现服|正在服用|正在使用|用药为|口服|静滴|肌注)[^，。；;\\n]{1,30}",
  "(?:对[^，。；;\\n]{1,24}过敏|(?:药物|食物|青霉素|头孢|磺胺)[^，。；;\\n]{0,12}过敏)",
  "(?:否认|无|没有|不伴|伴有|出现|主诉|自觉|诉)[^，。；;\\n]{1,24}(?:胸痛|胸闷|心悸|晕厥|头痛|发热|咳嗽|气促|呼吸困难|腹痛|恶心|呕吐|失眠|入睡困难|盗汗|潮热|口苦|口渴|便秘|腹泻)",
  "(?:(?:突发|持续|反复|进行性|外伤后|今晨|今日|排|近\\d+(?:小时|天|周|月))[^，。；;\\n]{0,10})?(?:出血不止|持续出血|呕血|黑便|黑色便|柏油样便|便血|咯血|晕厥|黑矇|意识丧失|胸痛|胸闷|气促|呼吸困难|剧烈头痛|肢体无力|腹痛|腹胀|寒战|高热)(?:[^，。；;\\n]{0,12}(?:不止|加重|未缓解|\\d+(?:分钟|小时|天|周|月|mL|毫升)))?",
  "(?:检查|检验|化验|心电图|肌钙蛋白|肝功能|肾功能|甲功|血常规)[^，。；;\\n]{0,30}(?:正常|异常|阴性|阳性|升高|降低|未见异常)",
].join("|"), "i");
const CONCRETE_TONGUE_PATTERN = new RegExp([
  "舌(?:质|体)?(?:色)?(?:淡|红|绛|紫|暗|胖|瘦|嫩|老|裂|边红|尖红)",
  "舌(?:边|缘|两边)?(?:可见|见|有|呈|伴)?(?:轻度?|明显)?(?:齿痕|齿印)",
  "(?:齿痕|齿印)(?:舌|明显|可见)?",
  "苔(?:薄|厚|白|黄|腻|燥|润|剥|少|无)",
].join("|"));
const CONCRETE_PULSE_PATTERN = new RegExp(
  `(?:^|[，,。；;：:\\s])(?:(?:脉象|脉来|脉)(?:为|见|呈|偏)?\\s*)?(?:${PULSE_QUALITY_PATTERN_SOURCE})(?:脉)?(?:(?:而|兼|且|和|与|、|\\/|\\s)*(?:${PULSE_QUALITY_PATTERN_SOURCE})(?:脉)?){0,3}` +
  // 右边界要求整段必须在标点或结尾处收住。少了这一组，「脉细弦无力」这种最常见的写法里，
  // 多写出来的「无力」反而让整个脉象判为**未记录**——信息越全，接地越差，方向是反的。
  // 实测后果：医生录入「脉细弦无力」，输出里回给他「脉象待核实」，辨证依据写成
  // 「月经量少推迟、脉象待核实为血虚」。
  `(?:(?:而|且|、|\\s)*(?:${PULSE_FORCE_PATTERN_SOURCE}))?(?=$|[，,。；;\\s])`,
);

/**
 * 叙述式脉象（2026-10-19 Claude 评审 M 集）：「左手脉象弦硬」「双手脉搏细而紧绷」「脉搏跳动微弱」
 * 「诊查显示脉象浮滑有力」「脉平和」「六脉微弱沉细」「所有脉搏都无法触及」。上面的形态学正则要求脉名紧贴标点、
 * 收在标点上，这些写法一条也认不出；净化器于是把病历里写着的脉象改成「脉象待核实」，辨证依据里留下
 * 「右手脉象待核实绷有力」「脉象待核实难触」这种残句（M 集 360 例中 27 例）。
 * 按小句认：有脉的锚词（脉象/脉搏/脉来/左右手脉/寸关尺/脉+脉名），有脉象描述（脉名或脉力、可触与否），
 * 先去掉生命体征写法（脉率、脉搏频率、N次/分）再看，血管名（静脉/动脉/脉络…）不算。
 */
const NARRATIVE_PULSE_HEAD = new RegExp(
  `(?<!淋)${PULSE_VESSEL_NOUN_LOOKBEHIND_SOURCE}(?:脉象|脉搏|脉来|脉形|脉势|[左右双两六][手侧部]?脉|[寸关尺][部脉]|脉(?=(?:${PULSE_QUALITY_PATTERN_SOURCE})|平和|和缓))`,
  "u",
);
const NARRATIVE_PULSE_VITAL = /脉(?:搏)?(?:跳动)?(?:频率|率|次数)[^，,。；;\n]*|\d+(?:\.\d+)?\s*(?:次|bpm)[^，,。；;\n]{0,4}/gu;
const NARRATIVE_PULSE_DESCRIPTOR = new RegExp(
  `(?:${PULSE_QUALITY_PATTERN_SOURCE.replace("|动", "")})|${PULSE_FORCE_PATTERN_SOURCE}|紧绷|平和|和缓|难触|难以触及|触不到|摸不到|摸不着|无法触及|不可触及|如丝|欲绝|充实|坚硬`,
  "u",
);
const NARRATIVE_PULSE_NOT_INSPECTION = /[静动络血经淋]脉|脉(?:管|压|冲|络)|静脉曲张/u;
const NARRATIVE_PULSE_UNAVAILABLE = /待核实|待确认|待补充|未采集|未查|未诊|未做|未提供|未记录|未见记录|无记录|未描述|未知|不详|不清楚|无法判断|无法评估|暂缺/u;

function lastNarrativePulseIndex(text: string): number {
  let last = -1;
  let offset = 0;
  for (const raw of text.split(/[，,。；;\n]/u)) {
    const index = offset;
    offset += raw.length + 1;
    if (NARRATIVE_PULSE_NOT_INSPECTION.test(raw) || NARRATIVE_PULSE_UNAVAILABLE.test(raw)) continue;
    const clause = raw.replace(NARRATIVE_PULSE_VITAL, "");
    const head = clause.match(NARRATIVE_PULSE_HEAD);
    if (!head || head.index === undefined) continue;
    if (NARRATIVE_PULSE_DESCRIPTOR.test(clause.slice(head.index + 1))) last = index;
  }
  return last;
}

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

/** 某个正则在文本里最后一次命中的下标；没命中返回 -1。 */
function lastMatchIndex(text: string, pattern: RegExp): number {
  const global = pattern.flags.includes("g") ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  return Array.from(text.matchAll(global)).at(-1)?.index ?? -1;
}

/**
 * 望闻切诊**字段槽**语义：这一栏医生填了没有（2026-08-26 拆谓词）。
 *
 * 与 isUnknownClinicalFieldText 的分工——那一个回答的是「在一段自由文本里能不能认出舌脉」，
 * 净化器靠它做编造防御，必须严格（形态学正则 ∪ 受控词表）。而门禁、充实度、M01 抽取问的是
 * 另一个问题：**这一栏有没有内容**。字段本身就是锚点，标准脉名映射在这里毫无必要。
 *
 * 合成一个谓词的实测后果（TCM-BEST4SDT / TCM-SD 外部基准）：医生把脉象写成转述式
 * （「左手脉象细长而紧张」「脉搏紧绷且振幅大」「脉跳得又快又硬」），后台判脉象未采集 →
 * 缺项 pulse_unknown → 完整度压到 B → 辨证被降级成「症状级工作判断」。写得越细越判不出来。
 *
 * 判据：按小句切分；「未取得」声明句（待核实/未查/不详/见附图…，或带 舌/脉/面 标签的同类
 * 表述）不算内容；其余小句去掉栏目标签后还剩下汉字即算内容。已记录 = 最后一条内容句出现在
 * 最后一条「未取得」声明之后——「舌淡红苔薄白，舌象待核实」仍判未记录（后写的声明推翻先前
 * 内容），与旧口径一致。
 */
const INSPECTION_FIELD_LABEL: Record<"tongue" | "pulse" | "face", RegExp> = {
  tongue: /舌象|舌质|舌体|舌苔|舌下|舌面|舌|苔象|苔/gu,
  pulse: /脉象|脉搏|脉来|脉率|脉|切诊/gu,
  face: /面象|面色|神色|面/gu,
};
// 「未取得」表述闭集：只收**可用性**语义的词，不收临床所见。
// 「无苔」「少苔」「无异常」都是阳性所见，绝不能进这个集合。
const INSPECTION_UNAVAILABLE_PHRASE =
  /待核实|待确认|待补充|待完善|未采集|未查|未做|未行|未提供|未记录|未见记录|无记录|未描述|未观察|未测|未评估|未知|不详|不清楚|无法判断|无法评估|暂缺|暂无记录|见附图|见图片|详见|同上/u;
const PURE_UNAVAILABLE_CLAUSE = /^(?:无|没有|未|不明|缺)$/u;
/** 该小句是否带本栏锚字。锚字是「这句在讲舌/脉/面」的构词式证据。 */
const ANCHORED_CLAUSE: Record<"tongue" | "pulse" | "face", RegExp> = {
  tongue: /[舌苔]/u,
  pulse: /脉/u,
  face: /面|神色/u,
};
/** 锚字的非望诊用法：给药途径、血管名等，不能据此认定该栏已记录。 */
const NON_INSPECTION_ANCHOR_USE: Record<"tongue" | "pulse" | "face", RegExp> = {
  tongue: /舌下(?:含服|给药|滴丸|片)/u,
  pulse: /[静动络血经淋]脉|脉(?:管|压|冲|络)|静脉曲张/u,
  face: /面积|面对|方面|面临/u,
};

export function isUnrecordedInspectionFieldValue(
  value: unknown,
  field: "tongue" | "pulse" | "face",
): boolean {
  const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  if (!text) return true;
  const labelPattern = INSPECTION_FIELD_LABEL[field];
  let lastUnavailable = -1;
  let lastSubstantive = -1;
  let offset = 0;
  for (const raw of text.split(/[，,。；;\n]/u)) {
    const clause = raw.trim();
    const index = offset;
    offset += raw.length + 1;
    if (!clause) continue;
    if (INSPECTION_UNAVAILABLE_PHRASE.test(clause) || PURE_UNAVAILABLE_CLAUSE.test(clause)) {
      lastUnavailable = index;
      continue;
    }
    // 这一句必须**确实在讲这一栏**才算所见。只看「去掉标签后还有字」不行：舌象栏里
    // 夹着「现服阿司匹林100mg每日一次」这种跨栏污染时会被当成舌象记录（钉子见
    // test-clinical-grounding 的 crossFieldUnknownTongue）。两条通路取并集：
    //   · 句中带该栏锚字（舌/苔、脉、面）——转述式写法走这条；
    //   · 或被自由文本识别面认出（形态学 ∪ 受控词表）——「边有齿印」「浮紧脉」走这条。
    const anchored = ANCHORED_CLAUSE[field].test(clause) && !NON_INSPECTION_ANCHOR_USE[field].test(clause);
    const residual = clause
      .replace(new RegExp(labelPattern.source, "gu"), "")
      .replace(/[：:、（）()\s]+/gu, "")
      .replace(/^(?:为|见|呈|偏|示|是)+/u, "");
    const substantive = (anchored && /[\u4e00-\u9fa5]/u.test(residual)) ||
      !isUnknownClinicalFieldText(clause, field);
    if (substantive) lastSubstantive = index;
  }
  return lastSubstantive < 0 || lastUnavailable > lastSubstantive;
}

export function isUnknownClinicalFieldText(
  value: unknown,
  field: "tongue" | "pulse" | "face" | "medication" | "allergy" | "generic",
): boolean {
  if (field === "generic") return isUnknownClinicalText(value);
  const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  if (!text) return true;
  if (field === "tongue" || field === "pulse" || field === "face") {
    // 具体性判定取「形态学正则 ∪ 受控词表」。两者缺一不可：
    // - 形态学正则认自由输入（医生自己敲的「舌淡红苔薄白」「脉细弦无力」）；
    // - 受控词表认页面点选值。该词表里的「舌体颤动」「络脉青紫」「苔白如积粉」「平脉」等
    //   在形态学正则里全无对应，只按正则判会把医生点过的词判成未采集，再被输出净化器
    //   改写成「舌象待核实」。实测 80 词里原本 28 词命中这个陷阱。
    // 词表是补充不是白名单：自由文本不受限，两者取并集。
    const morphology = field === "tongue"
      ? CONCRETE_TONGUE_PATTERN
      : field === "pulse" ? CONCRETE_PULSE_PATTERN : undefined;
    const unknownLabel = field === "tongue" ? "舌象" : field === "pulse" ? "脉象" : "面象";
    const unknown = new RegExp(`${unknownLabel}[^。；;\\n]{0,16}(?:待核实|待确认|未知|无法判断|未采集)`, "g");
    const lastConcrete = Math.max(
      morphology ? lastMatchIndex(text, morphology) : -1,
      field === "pulse" ? lastNarrativePulseIndex(text) : -1,
      // 脉象词表（脉浮/脉虚/脉紧…）前是脉管构词时不是脉象（筋脉紧急、经脉虚弱）：识别面与净化器的改写面同一个守卫。
      lastMatchIndex(text, field === "pulse"
        ? new RegExp(`${PULSE_VESSEL_NOUN_LOOKBEHIND_SOURCE}(?:${inspectionLexiconPattern("pulse").source})`)
        : inspectionLexiconPattern(field)),
      // 「面色正常」「舌象正常」「脉象正常」是医生最常点的那一项，属于阳性的「已查且正常」，
      // 不是「未采集」。词表里的正常项写的是专业表述（红黄隐隐／淡红舌，薄白苔／平脉），
      // 口语写法必须一并认下，否则最省事的那条录入路径反而判不出来。
      lastMatchIndex(text, new RegExp(`${unknownLabel}(?:未见(?:明显)?异常|正常|无异常)|(?:面色|舌象|脉象)正常`)),
    );
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
  return /(?:已妊娠|妊娠中|怀孕中|已经怀孕|确认怀孕|孕\d+(?:\+?)(?:周|月)?|(?:妊娠|怀孕)\d+(?:\+?)(?:周|月|天|日)|孕(?:早|中|晚)期|妊娠(?:早|中|晚)期)/.test(matchText);
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
    // 「孕32周出生」「孕38周顺产」「孕36周早产」说的是一次出生/分娩（儿科病历的出生史、产妇的既往孕产），不是当前妊娠
    //（2026-10-24 甲方 100 例 C077：3 岁女童「早产儿，孕32周出生」被判妊娠阳性，整方不给剂量、要求 3 天内去产科）。
    if (/^(?:\+?\d+\s*(?:周|天|日)?)?(?:天|日)?(?:时)?(?:后)?(?:自然)?(?:流产|终止妊娠|引产|分娩|已结束|出生|早产|娩出|产下|剖宫产|剖腹产|顺产|生产|产出)/.test(after)) return true;
    if (hasCurrentMarker(before)) return false;
    if (/既往史[：:]$/.test(before)) return false;
    return /(?:既往|曾经|妊娠史|怀孕史)[^。；;,，\n]{0,6}$/.test(before);
  }
  return hasHistoricalMarker(before) && !hasCurrentMarker(before);
}

function isNegatedPositiveContext(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 10), index);
  if (/(否认|无|没有|未|非|不在|停止|已停止)$/.test(before)) return true;
  // 一个否定词可以统领并列的生理状态：「无妊娠、哺乳或备孕可能」。旧实现只看命中词
  // 前 10 字是否**紧邻**否定词，于是末尾「备孕可能」被单独收成 possible，并按“最后陈述获胜”
  // 覆盖前面的 negative。这里只允许妊娠/哺乳/备孕同轴词和并列连接符出现在否定词与命中词之间；
  // 「无腹痛，计划妊娠」等跨轴或另起分句的真正阳性不受影响。
  const clause = clauseBefore(text, index);
  return /(?:否认|无|没有|未)(?:(?:妊娠|怀孕|哺乳|备孕|妊娠计划|生育计划)[、和与或及/]*)*$/.test(clause);
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
  // 换行是病历字段/段落的边界，先化成句号再去空白（2026-10-13）。此前直接去掉全部空白，
  // 各条规则里写的 [^。；\n] 句内窗口对换行形同虚设：「工具避孕\n13岁初潮」读成「孕13」（妊娠 13 周），
  // 婚育史后面紧跟月经史/日期的病历被整份收回剂量（合成集 190 例里 5 例，全部是妇科常规病历）。
  const normalized = (text || "").replace(/[\r\n]+/g, "。").replace(/[^\S\r\n]+/g, "").replace(/。{2,}/g, "。");
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

/**
 * 「妊娠可能（性）」后面跟着「尚待核实／未排除／不详」这一类写法时，是把妊娠状态记成未知，不是可疑妊娠。
 * 「妊娠可能已排除」是否认（negative 侧收），也不按可疑读。
 * 闭集词形守卫（开放语言冻结的例外：有限闭集 + 词形）；只用于 assessPregnancyState 的 possible 四条。
 */
const PREGNANCY_STATUS_PENDING_TAIL = "(?!性?(?:尚|仍|还|暂|目前)?(?:(?:待|未|需|无法)(?:核实|确认|明确|排除|知|详|清楚|采集|询问|问|确定|评估|检查)|不详|不明|不清)|性?(?:已经?|经|均|明确){1,2}(?:否认|被?排除))";

export function assessPregnancyState(text: string): ClinicalStateResult {
  return assessState(text, {
    positive: [
      /已妊娠/,
      /妊娠中/,
      /怀孕中/,
      /已经怀孕/,
      /确认怀孕/,
      // 词形守卫（2026-10-13）：「避孕/不孕/备孕/未孕/助孕/试孕/促孕 + 数字」是另一个词后面跟时长，
      // 「孕N岁/年/次/胎」也不是孕周。此前「不孕3年」「工具避孕3年」「备孕3个月」「上环避孕10年」
      // 一律读成当前妊娠，不孕症与避孕中的患者被收回剂量。
      /(?<![避不备未助试促如似若怀])孕\d+(?!\d*(?:岁|年|次|胎))(?:\+?)(?:周|月)?/,
      // 「妊娠8个月」「怀孕六个月」「孕七月」（2026-10-19 Claude 评审 A 集 A-non-0023：「妊娠8个月」一条也没认出，给了剂量）。
      // 「妊娠5个半月」「怀孕3个多月」「妊娠二十余周」（2026-10-19 X 集 X-G-2961/2831：「个半月」认不出，孕妇拿到剂量）。
      // 「妊娠已 6 个月」「怀孕约 20 周」（2026-10-20 第十轮 S 集 S-pregnancy-009：空白去掉后中间还有「已」，认不出，孕 6 月给了剂量）。
      /(?<![如似若])(?:妊娠|怀孕)(?:已经|已|约|近|有)?(?:\d+|[一二两三四五六七八九十]+)(?:\+?)(?:余|多)?(?:周|个?(?:半|多)?月)/,
      // 「现又妊娠32天」「怀孕40余天」（2026-10-24 语料回放：X2-G-2368 习惯性流产再孕 32 天判成未知，可给剂量）。
      // 「前次妊娠40天自然流产」这类既往孕产由 isHistoricalContext 的「后接流产/引产」判既往。
      /(?<![次胎前如似若])(?:妊娠|怀孕)(?:已经|已|约|近|有)?(?:\d+|[一二两三四五六七八九十]+)(?:\+?)(?:余|多)?(?:天|日)/,
      // 妊娠病名本身说的就是孕妇（《中医妇科学》妊娠病：妊娠恶阻、妊娠腹痛、胎漏、胎动不安…；「先兆流产」同理）。
      // 语料回放：「妊娠腹痛已经持续了一个月」「妊娠后已经持续呕吐了20天」判成未知，孕妇可给剂量。「否认妊娠呕吐」由否定语境排除，
      //「既往先兆流产史」由既往标记判既往；「妊娠水肿后遗下肢肿胀15年」「妊娠呕吐史」是既往孕产，不收（语料回放 corpus-16667）。
      /妊娠(?:腹痛|恶阻|剧吐|呕吐|咳嗽|肿胀|水肿|眩晕|心烦|贫血|失音|身痒|感冒|便秘|小便淋痛|小便不通|下血)(?!后遗|史|病史)/,
      /胎漏|胎动不安|胎萎不长|先兆流产/,
      // 「彩超提示单胎妊娠」「宫内妊娠」：影像结论写的是本次妊娠。
      /(?:单胎|双胎|多胎|宫内)妊娠/,
      /(?<![避不备未助试促如似若])孕(?:[一二两三四五六七八九十]+)(?:余|多)?(?:个)?(?:半|多)?(?:周|月)/,
      /孕(?:早|中|晚)期/,
      /妊娠(?:早|中|晚)期/,
      /(?:尿|血|β-?)?HCG阳性/i,
      // 检验结果写成「HCG（+）」「尿妊娠试验(+)」「早孕试验：弱阳性」（2026-10-20 第十轮 S 集 S-pregnancy-008：
      // 「停经40天时查HCG（+）」认不出，早孕给了剂量）。闭集：检验名 + 可选冒号 + 加号或阳性；阴性写法见 negative。
      /(?:尿|血|β-?)?(?:HCG|妊娠试验|早孕试验)[:：]?(?:[（(][+＋]+[)）]|[+＋]+|弱阳性)/i,
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
      // 「早孕」独立成词就是妊娠早期；只排除检验名与症状名。
      // 缺它的后果实测可见：BP 170/112 + 剧烈头痛，主诉写「孕妇」有重度子痫前期红旗，
      // 写「早孕」则零红旗（diagnosis-safety.ts 的产科语境判据现已收敛到本谓词）。
      // 「早孕试验阴性」由下方 negative 侧的 妊娠试验阴性 / HCG阴性 覆盖，不会被这条盖过。
      /早孕(?!试验|检测|试纸|反应|期?保健)/,
      // 「此次妊娠后觉小腹胀痛」「怀孕以来呕吐频作」「怀孕后出现…」（2026-10-19，≥300 条验收 X-G-2366/X-E-0766：
      // 判成妊娠状态未知、照常给了含川芎香附的剂量方）。写的是本次妊娠里的起病经过，与「妊娠8周」同义。
      // 词形守卫：前面是「次/胎/前」的是既往孕产（「前次妊娠后流产」「第一胎怀孕后」「2年前怀孕后」），不收。
      /(?:此次|本次|这次|目前|现)(?:妊娠|怀孕)(?:后|以来|期间|中)/,
      /(?<![次胎前])(?:妊娠|怀孕)以来/,
      /(?<![次胎前])(?:妊娠|怀孕)后(?:已经?)?(?:即|就|便|开始|出现|觉|感|自觉|渐|常|一直|持续|反复|频繁)/,
    ],
    possible: [
      // 「妊娠可能性尚待核实」「怀孕可能待确认」「可能妊娠未排除」说的是**妊娠状态还没问清**，不是可疑妊娠
      //（2026-10-24 甲方页面实测：失眠病历「末次月经及妊娠可能性尚待核实」被判可疑妊娠，整方不给剂量、
      // 3 天内转产科、出现「已记录妊娠…阳性/可疑状态」）。未知按未知处理：缺项照常追问（pregnancy_unknown）。
      // 词形守卫：后面紧跟「（性）+（尚/仍/还/暂/目前）+ 待/未/需/无法 + 核实/确认/明确/排除/知/详/清楚/采集/询问/确定」或「不详/不明/不清」。
      // 「不能排除妊娠」「妊娠可能性不能排除」是医生下的判断，不在此列，仍按可疑。
      new RegExp(`妊娠可能${PREGNANCY_STATUS_PENDING_TAIL}`),
      new RegExp(`怀孕可能${PREGNANCY_STATUS_PENDING_TAIL}`),
      new RegExp(`可能妊娠${PREGNANCY_STATUS_PENDING_TAIL}`),
      new RegExp(`可能怀孕${PREGNANCY_STATUS_PENDING_TAIL}`),
      /疑似妊娠/,
      /疑似怀孕/,
      /不能排除妊娠/,
      /不能排除怀孕/,
      /未避孕[^。；\n]{0,16}(?:妊娠|怀孕|月经推迟|停经|可能)/,
      /(?:月经推迟|停经)[^。；\n]{0,16}(?:妊娠|怀孕|可能|待查)/,
      // 闭经/停经是需要核实妊娠状态的症状，不等于“可疑妊娠阳性”。若仅凭时长就判
      // possible，闭经、多囊、泌乳素升高等门诊病例会被全部硬降级。必须再有验孕证据。
      /(?:月经推迟|停经)\d+(?:\+?)(?:周|天|月|个月)[^。；\n]{0,24}(?:验孕棒|早孕试纸)[^。；\n]{0,8}(?:两条杠|阳性)/,
      /(?:验孕棒|早孕试纸)[^。；\n]{0,8}(?:两条杠|阳性)/,
    ],
    negative: [
      // Negative lookahead stops complication/symptom phrases ("无妊娠期高血压", "否认妊娠剧吐",
      // "无早孕反应") from being read as a denial of pregnancy itself.
      // 否定词与「妊娠」之间不跨逗号（2026-10-24 语料回放：「也没有阴道流血，属于妊娠腹痛」读成否认妊娠）。
      // 病名后缀（腹痛、恶阻…）同样不是对妊娠本身的否认：「否认妊娠恶阻」。
      /否认[^。；;，,\n]{0,16}(?:妊娠|怀孕)(?!期|反应|糖尿|高血压|剧吐|呕吐|纹|斑|合并|并发|期间|物|腹痛|恶阻|咳嗽|肿胀|水肿|眩晕|心烦|贫血|下血)/,
      /无[^。；;，,\n]{0,12}(?:妊娠|怀孕)(?!期|反应|糖尿|高血压|剧吐|呕吐|纹|斑|合并|并发|期间|物|腹痛|恶阻|咳嗽|肿胀|水肿|眩晕|心烦|贫血|下血)/,
      /没有[^。；;，,\n]{0,12}(?:妊娠|怀孕)(?!期|反应|糖尿|高血压|剧吐|呕吐|纹|斑|合并|并发|期间|物|腹痛|恶阻|咳嗽|肿胀|水肿|眩晕|心烦|贫血|下血)/,
      /未妊娠/,
      /未怀孕/,
      /未孕/,
      // 否认后置：「妊娠状态明确否认」「怀孕已排除」「妊娠可能已排除」（2026-10-24 甲方 100 例 C069：判成未知，又追问一遍妊娠）。
      // 中间只许「已/经/均/明确」这几个字：「妊娠可能性尚未排除」「不能排除」「待排除」都不是否认。
      /(?:妊娠|怀孕)(?:状态|情况|可能性?)?(?:已经?|经|均|明确){0,2}(?:否认|被?排除)/,
      /妊娠试验阴性/,
      /尿妊娠阴性/,
      /(?:尿|血|β-?)?HCG阴性/i,
      /(?:尿|血|β-?)?(?:HCG|妊娠试验|早孕试验)[:：]?[（(][-－−][)）]/i,
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
      // 「…脉细弦，哺乳中」「现哺乳」（2026-10-20 第十轮 S 集 S-lactation-007：认不出，哺乳期类风湿患者差点拿到剂量）。
      /哺乳中/,
      /现(?:在)?哺乳/,
      /仍在哺乳/,
      /未停止哺乳/,
      /母乳喂养/,
      // 产后缺乳病案通常不写“哺乳期”，而写当前泌乳与喂养事实。它们同样会直接
      // 影响剂量级处方权限，不能因为病历用了产科常用写法就漏过特殊人群门禁。
      // 限定在产后同一分句内，避免把一般乳房/泌乳检查或既往史误读成当前哺乳。
      /(?:产后|剖宫产术后|分娩后)[^。；\n]{0,64}(?:泌乳(?:畅|中)|乳汁(?:分泌|量)(?:少|不足|正常|增多)?|乳量(?:少|不足|正常)|混合喂养)/,
      // 产后缺乳与乳汁淤积的病案（2026-10-20 第十轮 S 集：「产后缺乳15天」「产后10日，乳汁稀少」「需挤出乳汁再喂养」
      // 「产后2月…。查双乳…乳汁量少」都判成未知，哺乳期产妇给了剂量）。乳汁正在分泌却少、稀、排不畅，本身就是哺乳期——
      // 不必与「产后」同句；病理性溢乳（溢乳、乳头溢液、泌乳素）不是这些写法，不收。
      // 「患儿自幼缺乳」说的是患者幼时没吃上母乳，不是哺乳（语料回放 1 例）。
      /(?<!自幼|幼时|从小|婴儿期)缺乳/,
      /乳汁(?:量)?(?:稀少|少|不足|欠?通畅|不畅|淤积|郁积|排出不畅|难出|点滴不出)/,
      // 「还能喂奶吗」「能不能喂奶」是问能否继续哺乳，归下方 possible，不在这里收。
      /(?:挤出|吸出)乳汁|吸奶|(?<![能可否以])喂奶(?![粉吗么嘛])/,
    ],
    possible: [
      /可能哺乳/,
      /疑似哺乳/,
      /不能排除哺乳/,
      /产后[^。；\n]{0,12}(?:是否)?哺乳(?:不详|未知|待确认)?/,
      // 「妈妈拉肚子还能哺乳吗」「吃药了还能喂奶吗」：问能否继续哺乳，说明正在哺乳（2026-10-19 Claude 评审 B 集 MedDG-164#3）。
      /(?:还|仍)(?:能|可以)(?:继续)?(?:哺乳|喂奶|母乳喂养|喂母乳)(?:吗|么|嘛)?/,
      /(?:能不能|可不可以|能否)(?:继续)?(?:哺乳|喂奶|母乳喂养|喂母乳)/,
    ],
    negative: [
      /否认[^。；\n]{0,12}哺乳/,
      /无[^。；\n]{0,12}哺乳/,
      /没有[^。；\n]{0,12}哺乳/,
      /未在哺乳/,
      /不在哺乳/,
      /非哺乳期/,
      /已停止哺乳/,
      // 病历里最常见的简写（「现否认妊娠，未哺乳」）。「未停止哺乳」是阳性，字面不同，不受影响。
      /未哺乳/,
      /不哺乳/,
      /已断奶/,
      // 从未生育（「孕0产0」「G0P0」「未育」）就不在哺乳（2026-10-19 留出集 S102：孕0产0、未避孕1年未孕，注意事项仍问「如正在哺乳」）。
      // 产次写 0 才算；「孕1产0」（流产）不收，「孕0」后面跟别的产次也不收。
      /孕\s*0\s*产\s*0|G\s*0\s*P\s*0|未生育|未曾生育|未育(?!龄)/i,
    ],
    historical: [
      /既往[^。；\n]{0,16}哺乳/,
      /曾经[^。；\n]{0,16}哺乳/,
    ],
  });
}

/**
 * 病历记录了一年内的分娩（2026-10-17，甲方标准病历 3「2+月前…剖宫产术，术后产下1女」）。
 * 只认同一句里的分娩字样 + 不超过 12 个月的时间（N天/周/月前、产后N天/周/月）；写了几年前的、
 * 没有时间的都不算——哺乳提示只给刚生产的人。
 */
const CHILDBIRTH_WORD = /产后|剖宫产|顺产|分娩|生产后|产下|生下|坐月子|产褥/;
const CHINESE_SMALL_NUMBER: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };
export function recentChildbirthMentioned(text: string): boolean {
  return String(text || "").normalize("NFKC").split(/[。；;\n]+/).some((sentence) => {
    if (!CHILDBIRTH_WORD.test(sentence)) return false;
    for (const match of sentence.matchAll(/(\d+(?:\.\d+)?|[一二两三四五六七八九十半])\s*(?:个)?\s*(?:\+|余|多)?\s*(?:个)?\s*(天|日|周|星期|月|年)(?:余|多)?(?:前|后|来)?/g)) {
      const amount = /\d/.test(match[1]) ? Number(match[1]) : CHINESE_SMALL_NUMBER[match[1]] ?? NaN;
      if (!Number.isFinite(amount)) continue;
      const months = match[2] === "年" ? amount * 12 : match[2] === "月" ? amount : amount / 30;
      if (months <= 12) return true;
    }
    return false;
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
      // 「备孕」单独成词、或后接时长（备孕3个月/备孕半年）都是当前在备孕（2026-10-13）。
      // 此前只认「正在备孕/备孕中」；带时长的写法是靠妊娠规则把「孕3」误读成孕周才被拦住的，
      // 那条误读修掉后必须在这里接住。否定（无备孕计划/否认备孕）由 negative 侧与否定语境把关。
      /备孕/,
    ],
    possible: [
      /未避孕/,
      // 同一个意思的另外几种写法（闭集）：不避孕 / 解除避孕 / 停止避孕。
      /(?:不|解除|停止)避孕/,
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

/**
 * 备孕/未避孕这一档（owner 2026-10-14 决定）：病历记录了备孕或未避孕（阳性或可疑），而妊娠、哺乳都不是阳性或可疑。
 * 这一档照常给剂量，只是药典孕妇禁用的饮片不进方、孕妇慎用的逐味标注（conception-herb-policy）。
 * 妊娠或哺乳阳性/可疑时不属于这一档，仍按独立硬边界不给剂量；停经、月经逾期由妊娠判据判为可疑，同样不属于这一档。
 * 安全闸门、M04 合同与编译器读的都是这一个判据。
 */
/**
 * 病历本身说明已没有妊娠可能：绝经（含「绝经N年」「停经12个月以上」）、子宫切除（「子宫肌瘤切除/剔除」保留子宫，不算）、双侧卵巢切除；
 * 50 岁及以上写「已停经」也算（更年轻的「已停经」可能就是妊娠）。安全闸门的孕哺筛查（pregnancyScreenRequired）与
 * 药典孕妇禁用档（conception-herb-policy）读的是这一个判据。
 */
export function recordExcludesPregnancyPotential(text: string, ageYears?: number): boolean {
  return /(绝经|停经)\s*(?:已|约)?\s*(?:1[2-9]|[2-9]\d)\s*(?:个月|月)|绝经\s*(?:已|约)?\s*[1-9]\d*\s*年|绝经后|双侧卵巢切除|子宫全切(?:除)?|无子宫/.test(text) ||
    // 子宫已切除（含次全切、广泛子宫加双附件切除），或病历直接写「已绝经/月经已绝」（2026-10-19 Claude 评审 M 集）。
    /(?:全|广泛|次全)?子宫(?:加|及|和|\+|＋)?(?:双(?:侧)?附件)?(?:次全)?切除(?!前)/.test(text) ||
    /(?<![未围])(?:已|现已|业已|因)绝经|月经已绝|经水已绝|天癸已绝/.test(text) ||
    (ageYears != null && ageYears >= 50 && /(?:已|现已)停经/.test(text));
}

export function conceptionWithoutPregnancyOrLactation(text: string): boolean {
  return isPositiveOrPossibleClinicalState(assessConceptionState(text)) &&
    !isPositiveOrPossibleClinicalState(assessPregnancyState(text)) &&
    !isPositiveOrPossibleClinicalState(assessLactationState(text));
}
