/**
 * 治法表述的**确定性归一**（L2 规则层）。
 *
 * 目标不是「把自然语言穷举完」——那做不到，本轮已经反复证明。目标是把**同一条治法的
 * 不同写法折叠到同一个受控条目上**，让判定结果不再随模型每次的措辞漂移。
 *
 * 归档语料实测（1531 份，治法字段去重 1139 条子句）：
 *   · GB/T 16751.3 精确/别名命中           60.2% 出现次数
 *   · 本层规则再折叠 79 种写法 / +597 次   → 约 69%
 *   · 与 20 条概念正则并集                  94.1%
 * 更要紧的一个数：同一病例多次重跑，**治法文字 100% 不同、概念集合 83% 不同**。
 * 本层直接打击的是由此产生的跨表述失配（isM04TherapyMatchAligned 实测 32.7%）。
 *
 * ⚠ 第一版用**自由子串包含**做后缀剥离，被实测打掉：
 *     除湿通络止痛 → 活血止痛（张冠李戴）
 *     健脾燥湿     → 辛香运脾（丢了 damp_resolve）
 * 子串包含本身就是语义漂移源。因此本层一律 **前缀锚定 + 后缀白名单**，
 * 剥离后必须仍能查到受控条目才采纳，否则原样返回。
 */

/** 繁简/异体：治法用字里真实出现过的那些，不做通用繁简转换（那需要整表，且会误伤药名）。 */
/**
 * 繁简/异体折叠：只收**治法用字里真实出现过**的对，不做通用繁简转换——
 * 通用转换需要整表，且会误伤药名（后→後、姜→薑 之类在方剂名里是有区别的）。
 * 表是按 GB/T 16751.3 与归档语料里实际出现的繁体字逐个对出来的。
 */
const VARIANT_CHARS: ReadonlyMap<string, string> = new Map(Object.entries({
  瀉: "泻", 熱: "热", 濕: "湿", 氣: "气", 腎: "肾", 風: "风", 補: "补", 養: "养",
  溫: "温", 絡: "络", 經: "经", 鬱: "郁", 結: "结", 嘔: "呕", 陰: "阴", 陽: "阳",
  虛: "虚", 實: "实", 積: "积", 滯: "滞", 瘀: "瘀", 痺: "痹", 攣: "挛", 嚨: "咙",
  澀: "涩", 斂: "敛", 鎮: "镇", 驚: "惊", 癇: "痫", 竅: "窍", 濁: "浊", 瀝: "沥",
  癥: "症", 瘕: "瘕", 脹: "胀", 悶: "闷", 嗽: "嗽", 喘: "喘", 帶: "带", 崩: "崩",
  護: "护", 導: "导", 開: "开", 閉: "闭", 通: "通", 潤: "润", 燥: "燥", 醒: "醒",
}));

/** 语气前缀：只表达「顺带/应当」，不改变治法本体。 */
const LEADING_MODIFIER = /^(?:兼以|佐以|并以|辅以|治宜|治以|宜以|兼|佐|辅|并|当|须|应|拟|宜|以)/;
/** 语气后缀：同上。 */
const TRAILING_MODIFIER = /(?:为主|为要|为法|为治|之法|而治|为先|为宜|治疗|法)$/;



const PUNCT = /[。．.，,、；;：:！!？?（）()【】\[\]「」『』\s]/g;

function foldVariants(value: string): string {
  let out = "";
  for (const char of value) out += VARIANT_CHARS.get(char) ?? char;
  return out;
}

/** 规范化到比较用形态：NFKC + 去标点 + 繁简折叠。 */
export function normalizeTherapyPhrase(value: unknown): string {
  return foldVariants(String(value ?? "").normalize("NFKC")).replace(PUNCT, "").trim();
}

/**
 * 四字治法的**词序颠倒**：ABCD → CDAB。
 * 中医治法里两个动宾短语的先后常随口语颠倒，且颠倒后语义不变——
 * 实测语料：化痰祛湿↔燥湿化痰(71)、益气健脾↔补益脾气(53)、养阴清热↔清热养阴(18)、
 * 止咳化痰↔化痰止咳(11)、降逆和胃↔和胃降逆(6)、寒热平调↔平调寒热。
 * **只对恰好 4 个汉字的子句做**：更长的短语颠倒后未必等价。
 */
export function swappedTherapyPhrase(value: string): string | undefined {
  const text = normalizeTherapyPhrase(value);
  if (!/^[一-龥]{4}$/.test(text)) return undefined;
  return text.slice(2) + text.slice(0, 2);
}

/**
 * 逐层剥出候选查名，**由近及远**：原文 → 去语气词 → 去疗效后缀 → 词序颠倒。
 * 调用方按顺序拿去查受控表，命中即停；**全都查不到时必须用原文**，不得擅自采纳剥离结果。
 */
export function therapyPhraseLookupForms(value: unknown): string[] {
  const base = normalizeTherapyPhrase(value);
  if (!base) return [];
  const forms: string[] = [base];
  const push = (candidate: string | undefined): void => {
    const text = (candidate || "").trim();
    // 剥到单字就不再是治法了（「补」「清」无方向）；两字仍可能是受控治法
    //（理气/燥湿/化痰/补气 都在 GB/T 16751.3 里），因此下限取 2。
    if (text.length >= 2 && !forms.includes(text)) forms.push(text);
  };

  let stripped = base;
  for (let guard = 0; guard < 3; guard += 1) {
    const next = stripped.replace(LEADING_MODIFIER, "").replace(TRAILING_MODIFIER, "").trim();
    if (!next || next === stripped) break;
    stripped = next;
    push(stripped);
  }

  for (const form of [...forms]) push(swappedTherapyPhrase(form));
  return forms;
}

/**
 * 按「由近及远、命中即停」解析治法子句。**调用方一律用这个函数，不要自己遍历候选。**
 *
 * 规则只有一条：**原文能命中就用原文**，只有零命中才逐级降级到剥离/颠倒形态。
 * 反过来（谁命中多用谁）会引入漂移——实测「健脾燥湿」原文命中「燥湿」，
 * 若因颠倒形态命中数更多而改用「燥湿健脾」，会连带引入「辛香运脾」，
 * 那是另一条治法。归一的目的是**折叠同义写法**，不是扩大召回。
 *
 * @param lookup 受控表查询函数（如 governedTreatmentPrinciplesInText）
 */
export function resolveTherapyPhrase<T>(
  value: unknown,
  lookup: (text: string) => readonly T[],
): { form: string; matches: readonly T[]; normalized: boolean } {
  const forms = therapyPhraseLookupForms(value);
  if (forms.length === 0) return { form: "", matches: [], normalized: false };
  for (const [index, form] of forms.entries()) {
    const matches = lookup(form);
    if (matches.length > 0) return { form, matches, normalized: index > 0 };
  }
  // 尾部疗效目标词（「和胃降逆**止呕**」的止呕、「活血通络**止痛**」的止痛）。
  // **不写词表**：判据是「剥掉这两三个字之后，剩下的能不能命中受治理表」——
  // 能命中就说明剩余部分本身是一条受控治法，被剥掉的是目的而非治法本体。
  // 这样既不需要手写「止痛/止呕/退黄…」清单（那是又一张会漏的临床词表，
  // test:clinical-vocabulary 明令禁止），也天然随受治理表一起演进。
  const base = forms[0];
  for (const tailLength of [2, 3]) {
    if (base.length < tailLength + 2) continue;
    const head = base.slice(0, base.length - tailLength);
    const matches = lookup(head);
    if (matches.length > 0) return { form: head, matches, normalized: true };
  }
  return { form: base, matches: [], normalized: false };
}

/**
 * 忌口随证（2026-10-19，注意事项规则项「服法与忌口」）：与 M04 提示词第 1 条同一口径——寒证忌生冷，热证忌辛辣温燥，
 * 痰湿证忌肥甘黏腻，食积忌过饱。只读已签名的证名、兼证与治法拼成的一段文字。
 */
export function dietRestrictionForSyndromeText(syndromeText: string): string {
  const parts: string[] = [];
  // 「阳气虚衰证」「阳气不足」也是阳虚（2026-10-19 留出集 S188：低体温、手脚冰凉，忌口落到了兜底的「清淡、少食辛辣油腻」）。
  if (/寒|阳虚|阳衰|火衰|阳气(?:虚|不足|衰)/u.test(syndromeText)) parts.push("忌食生冷寒凉");
  // 不写「少饮酒」（2026-10-19 甲方复评：与「须戒酒」「忌酒」同屏相抵，也写给了不饮酒的人）；饮酒的戒酒由调用方按病历另加。
  if (/热|火(?!衰)|阴虚/u.test(syndromeText)) parts.push("忌食辛辣温燥");
  if (/湿|痰|饮/u.test(syndromeText)) parts.push("少食肥甘厚腻与甜黏之品");
  if (/食积|食滞|积滞|伤食/u.test(syndromeText)) parts.push("饮食有节、不宜过饱");
  return parts.length > 0 ? parts.join("，") : "饮食宜清淡、易消化，少食辛辣油腻";
}

/**
 * 病历写的发病诱因食物（2026-10-19，留出集 S128「进食大量海鲜并饮啤酒后…全身风团」、S145 痛风「进食海鲜、饮啤酒，当夜…剧痛」：
 * 注意事项都没叫患者避开它）。只认「进食/食用/吃/饮/喝 + 食物（有限闭集） + 后」或「食物 + 后出现/诱发/加重」，否认句不算。
 */
const TRIGGER_FOOD = /海鲜|鱼虾|虾蟹|虾|蟹|贝类|啤酒|白酒|烈酒|酒|火锅|烧烤|辛辣|羊肉|牛肉|芒果|花生|牛奶|冷饮|生冷|油腻/gu;
export function recordedTriggerFoods(text: string): string[] {
  const foods: string[] = [];
  const spans: string[] = [];
  for (const sentence of text.normalize("NFKC").split(/[。；;\n]+/u)) {
    if (/否认|无[^，,。；;]{0,4}(?:进食|饮)/u.test(sentence)) continue;
    // 食物要落在「进食…后」或「…后出现/诱发/加重」这一段里：「口干喜冷饮」「饮不解渴」不是诱因。
    for (const match of sentence.matchAll(/(?:进食|食用|吃了?|饮用?|喝了?|过食|嗜食)([^，,。；;]{0,14}?)后/gu)) spans.push(match[1]);
    for (const match of sentence.matchAll(/([^，,。；;]{1,12})后[^，,。；;]{0,6}(?:出现|发作|诱发|加重|起病)/gu)) spans.push(match[1]);
    // 「进食海鲜、饮啤酒，当夜…剧痛」：进食之后紧接着一个时间接续词。
    for (const match of sentence.matchAll(/((?:进食|食用|吃了?|饮用?|喝了?)[^。；;]{0,16}?)[，,]\s*(?:当夜|当晚|当天|次日|随即|随后|旋即)/gu)) spans.push(match[1]);
  }
  for (const span of spans) {
    for (const match of span.matchAll(TRIGGER_FOOD)) {
      const food = match[0] === "酒" && foods.some((item) => item.endsWith("酒")) ? "" : match[0];
      if (food && !foods.includes(food) && !foods.some((item) => item.includes(food))) foods.push(food);
    }
  }
  return foods.slice(0, 4);
}

/**
 * 辨证依据或总病机里，用主证没有覆盖的病机解释某组表现的分句（2026-10-19 验收主集 C 模块：74 例不合格里 29 例是
 * 「辨证依据自述兼有X / 为X之兼象 / 化热 / 气阴两伤，兼证栏却写无」）。只认肯定说法：否认、鉴别、暂不支持的分句不算。
 * 闭集：病机词（不足/亏虚/两伤/化热/湿热/气滞/瘀阻…）与兼夹标记词；是否被主证覆盖按病性字比对（气血阴阳、寒热湿痰瘀滞郁饮）。
 */
const MECHANISM_PHRASE = /(?:心|肝|脾|肺|肾|胃|胆|肠|膀胱|胞宫|冲任)?(?:气阴|气血|阴液|阴血|精血|气|血|阴|阳|津|精)(?:不足|亏虚|亏损|两伤|两虚|耗伤|不固)|化热|化火|湿热|痰热|痰湿|湿浊|寒湿|水湿|水饮|痰饮|血瘀|瘀血|瘀阻|瘀滞|气滞|气郁|肝郁|肝气不舒|兼象|之兼|兼见|兼及|同病|夹杂|夹有|兼夹|为兼|属兼/u;
// 「为兼夹之象」「胃肠症状属兼夹」「下元不足为兼」也是自称兼夹（2026-10-19 Claude 评审 M 集 0516、0501、test-65、BEST4SDT-6：兼证栏仍是无）。
const SECONDARY_MECHANISM_MARKER = /兼象|之兼|兼见|兼及|同病|夹杂|夹有|兼夹|为兼|属兼/u;
const MECHANISM_MARKER_ONLY = new RegExp(`^(?:${SECONDARY_MECHANISM_MARKER.source})$`, "u");
/** 分句自称兼夹（「为肝气不舒之兼象」「心脾同病」）。 */
export function declaresSecondaryMechanism(clause: string): boolean {
  return SECONDARY_MECHANISM_MARKER.test(clause);
}
// 「无力」「无华」是体征词，不是否认（「双尺重按无力示下元不足为兼」，BEST4SDT-6）；「是否兼夹…尚待补充」「暂难细辨」是存疑，不是断言。
const MECHANISM_NOT_ASSERTED = /非|无(?!力|华|神|泽|根)|未|不另|不作|不立|不支持|不归|不属|不取|暂不|尚不|暂难|尚待|是否|待定|待查|孰|排除|鉴别|相别|相区分|而非|不足以|尚欠/u;
const NATURE_KEY: Readonly<Record<string, string>> = { 气: "气", 血: "血", 阴: "阴", 阳: "阳", 津: "阴", 精: "精", 热: "热", 火: "热", 湿: "湿", 痰: "痰", 寒: "寒", 瘀: "瘀", 滞: "滞", 郁: "郁", 饮: "饮", 水: "湿" };
const natureKeys = (value: string) => new Set([...value].map((char) => NATURE_KEY[char]).filter(Boolean));
export function mechanismClaimsUncoveredBy(primarySyndrome: string, ...values: string[]): string[] {
  const covered = natureKeys(primarySyndrome);
  return values.flatMap((value) => String(value || "").split(/[，,。；;]/u)).map((clause) => clause.trim()).filter((clause) => {
    // 「属兼夹而非主证」「兼夹表邪未净」是在断言兼夹（非主证＝是兼证；未净＝仍在），这几处「非/未」不算否认（BEST4SDT-194、MTCMB-41）。
    if (!clause || MECHANISM_NOT_ASSERTED.test(clause.replace(/而?非主证|未净|未尽|未除|未清/gu, ""))) return false;
    const phrase = clause.match(MECHANISM_PHRASE)?.[0];
    if (!phrase) return false;
    if (MECHANISM_MARKER_ONLY.test(phrase)) return true;
    return [...natureKeys(phrase)].some((key) => !covered.has(key));
  });
}

// 「兼/夹 + 病性」的兼夹说法（m03-secondary-syndrome-consistency 的触发判据）。病性收尾也认「不足/不固/失养/不和/上亢」：
//「兼有肺气不足」此前漏判，辨证依据写了兼夹、兼证栏却是空的（2026-10-19 验收主集 RobustSDT-single_0467/0311）。
const SECONDARY_PATTERN_CLAIM = /(?<![无未不非没])[兼夹](?![顾治以备职])[有见杂]?[一-鿿]{0,8}?(?:[虚亏湿痰瘀热寒郁滞风燥火饮浊积]|不足|不固|失养|不和|上亢)/u;
/**
 * 依据里「不另立兼证」一类的分句（「痰湿尚未成独立证候，暂作兼夹因素处理」「主证可释」）。兼证核对补上兼证之后，这些分句与兼证栏相抵，
 * 要一并去掉（2026-10-19 Claude 评审 M 集 MTCMB-21、MTCMB-90）。
 */
const SECONDARY_DENIAL_CLAUSE = /不另立|不单立|不另列|未成独立|尚未成独立|暂作兼夹|主证(?:即|已|足以)?可(?:以)?(?:解)?释|主证可概/u;
export function deniesSeparateSecondaryPattern(clause: string): boolean {
  return SECONDARY_DENIAL_CLAUSE.test(clause);
}

/** 病历事实核对里写成否定或无关的说法（「腹不胀大」「非时聚时散」「与咳唾呼吸无关」），见 m03-patient-claim-check。 */
const NEGATIVE_FORM_CLAIM = /不|非|无关|未见|未有|无/u;
export function negativeFormClaim(span: string): boolean {
  return NEGATIVE_FORM_CLAIM.test(span);
}

export function claimsSecondaryPattern(clause: string): boolean {
  return SECONDARY_PATTERN_CLAIM.test(clause);
}

/**
 * 治法里意思重复的短语只留一个（2026-10-19 Claude 评审 M/H 集「清利湿热，清热利湿」「平肝潜阳，和胃化湿，通络止痛，化湿和胃」
 * 「息风化痰，活血通络，熄风化痰止痛」）：教材治法与模型按本例补的半句拼在一起时常见。按字面判：一个短语的字（熄=息）全都出现在
 * 另一个不短于它的短语里，就是重复，去掉它；字相同时留先出现的。两个四字短语只差第一个字的（「和血通络」「活血通络」）也算重复。
 */
export function withoutRedundantTherapyPhrases(method: string): string {
  const text = String(method || "");
  const parts = text.split(/([，,、；;])/u);
  const phrases = parts.filter((_, index) => index % 2 === 0);
  const chars = (phrase: string) => new Set([...phrase.replace(/熄/gu, "息").replace(/[^\u4e00-\u9fff]/gu, "")]);
  const sets = phrases.map(chars);
  // 两个四字治法只差第一个字（「和血通络，活血通络」「补气养血，益气养血」）：意思相同，留前一个（2026-10-19 Claude 评审 M 集 SD-451922 判冗杂）。
  const nearSynonym = (left: string, right: string) => left.length === 4 && right.length === 4 && left !== right && left.slice(1) === right.slice(1);
  const drop = phrases.map((phrase, index) => {
    if (phrases.some((other, at) => at < index && nearSynonym(other.trim(), phrase.trim()))) return true;
    const own = sets[index];
    if (own.size < 3) return false;
    return phrases.some((other, at) => at !== index && sets[at].size >= own.size && (sets[at].size > own.size || at < index) &&
      [...own].every((character) => sets[at].has(character)));
  });
  if (!drop.some(Boolean)) return mergedSameHeadTherapyPhrases(text);
  const kept: string[] = [];
  phrases.forEach((phrase, index) => {
    if (drop[index]) return;
    if (kept.length > 0) kept.push(parts[index * 2 - 1] || "，");
    kept.push(phrase);
  });
  return mergedSameHeadTherapyPhrases(kept.join("").replace(/^[，,、；;]+/u, ""));
}

/**
 * 同一个两字动宾开头的两项四字治法合成一项（2026-10-21 第十二轮；验收 M 集 21/360 例「健脾和胃，健脾益气」「活血通窍，活血化瘀」
 * 「养阴生津，养阴润肺」）：留第一项的位置，写成「开头两字 + 两个后半」，合成后最多六字。后半是「止痛、和胃、安神…」这类说目的的放后，
 * 其余（益气、化瘀、解毒、生津…）按原顺序在前——「健脾益气和胃」「活血化瘀通窍」「清热解毒生津」。三项及以上同头的不合（太长）。
 */
const PURPOSE_TAIL = /^(?:助运|止痛|止咳|平喘|安神|宁神|通络|通窍|止血|止泻|止呕|通便|消肿|利咽|明目|调经|止带|止痒|和胃|和中|润肺|润肠|降逆|开窍|散结|定志|固表|止汗|缩尿)$/u;
export function mergedSameHeadTherapyPhrases(method: string): string {
  const parts = String(method || "").split(/([，,、；;])/u);
  const phrases = parts.filter((_, index) => index % 2 === 0).map((phrase) => phrase.trim());
  const used = new Set<number>();
  const merged = new Map<number, string>();
  phrases.forEach((phrase, index) => {
    if (used.has(index) || phrase.length !== 4 || !/^[\u4e00-\u9fff]{4}$/u.test(phrase)) return;
    const sameHead = phrases.filter((other) => other.length === 4 && other.slice(0, 2) === phrase.slice(0, 2));
    if (sameHead.length !== 2) return;
    const partners = phrases.flatMap((other, at) => at > index && !used.has(at) && other.length === 4 && other.slice(0, 2) === phrase.slice(0, 2) && other !== phrase ? [at] : []);
    if (partners.length !== 1) return;
    const tails = [phrase.slice(2), phrases[partners[0]].slice(2)];
    const ordered = [...tails.filter((tail) => !PURPOSE_TAIL.test(tail)), ...tails.filter((tail) => PURPOSE_TAIL.test(tail))];
    merged.set(index, `${phrase.slice(0, 2)}${ordered.join("")}`);
    used.add(partners[0]);
  });
  if (merged.size === 0) return method;
  const kept: string[] = [];
  phrases.forEach((phrase, index) => {
    if (used.has(index)) return;
    if (kept.length > 0) kept.push(parts[index * 2 - 1] || "，");
    kept.push(merged.get(index) ?? phrase);
  });
  return kept.join("").replace(/^[，,、；;]+/u, "");
}

/**
 * 撤下一个兼证时，治法里只为它而写的那几项（2026-10-21 第十二轮）。按证名里的脏腑与病性字找对应的治法用词：
 * 一项治法含兼证要素的用词、又不含主证任何要素的用词，才算只属于兼证；主证教材治法里原有的不算。拿不准的一律保留。
 */
const ELEMENT_METHOD_WORDS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/脾/u, /健脾|运脾|补脾|醒脾|实脾/u], [/胃/u, /和胃|养胃|益胃|清胃|温胃/u], [/肺/u, /宣肺|补肺|润肺|清肺|肃肺|敛肺/u],
  [/肾/u, /补肾|益肾|温肾|滋肾|固肾/u], [/肝/u, /疏肝|柔肝|养肝|平肝|清肝|泻肝/u], [/心/u, /养心|宁心|清心|补心/u],
  [/气虚|气不足|气亏/u, /益气|补气/u], [/血虚|血不足|血亏/u, /养血|补血/u], [/阴虚|阴亏|阴不足/u, /滋阴|养阴/u],
  [/阳虚|阳不足|阳衰/u, /温阳|助阳|补阳|温肾/u], [/气滞|气郁|郁滞/u, /理气|行气|疏肝|解郁/u], [/瘀/u, /活血|化瘀|祛瘀/u],
  [/痰/u, /化痰|祛痰|涤痰/u], [/湿/u, /化湿|燥湿|利湿|祛湿|渗湿|除湿/u], [/热|火/u, /清热|泻火|清火/u],
  [/寒/u, /散寒|温中|温经|祛寒/u], [/风/u, /祛风|疏风|息风/u], [/燥|津亏|津伤|津液/u, /生津|润燥/u], [/食/u, /消食|导滞/u],
];
export function therapyItemsOnlyFor(method: string, secondaryName: string, primaryName: string, primaryTextbookMethod = ""): string[] {
  const words = (name: string) => ELEMENT_METHOD_WORDS.filter(([element]) => element.test(name)).map(([, method]) => method);
  const secondaryWords = words(secondaryName);
  const primaryWords = words(primaryName);
  if (secondaryWords.length === 0) return [];
  return String(method || "").split(/[，,、；;]/u).map((item) => item.trim()).filter((item) =>
    item.length >= 2 &&
    secondaryWords.some((pattern) => pattern.test(item)) &&
    !primaryWords.some((pattern) => pattern.test(item)) &&
    !(primaryTextbookMethod && primaryTextbookMethod.includes(item)));
}
