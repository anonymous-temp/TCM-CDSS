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
