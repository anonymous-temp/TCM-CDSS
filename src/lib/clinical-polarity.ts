/**
 * 「无」的**非否定用法**：无法/无从/无以 是情态，无需/无须 是建议，无论/无非 是连词。
 * 与上面那张体征表不同，这是一个**封闭的语法类**（现代汉语里「无+虚词」就这几个），
 * 枚举它是安全的，不属于「穷举自然语言」。
 * 实测代价：`无法完全否认呕血` 原本判 negative——「排除不了呕血」被读成「已否认呕血」，
 * 红旗直接被抹掉。这是本次审计里方向最危险的一条。
 */
import { classifyBlanketAnswer, endsWithBlanketQuantifiedNegation, stripBlanketQuantifierPrefix } from "./clinical-vocabulary";

const NON_NEGATING_WU_MODAL = /^无(?:法|从|以|需|须|论|非)/;

export type ClinicalClausePolarity = "affirmed" | "negative" | "uncertain";
export type ClinicalEventTemporalScope = "current" | "historical" | "historical_resolved";

// 时相引语白名单（2026-08-11 对抗性复核）：原表只收了「患者/病人/既往/目前/当前/现阶段/本次」，
// 于是「**发病以来**无明显发热及咳嗽」「**近期**无明显咳嗽」整条判 affirmed——
// 病历白纸黑字写着「无…咳嗽」，下游却当成有咳嗽。补的是**同一语法类**里漏掉的成员
// （病程时相引语），不是放宽否定判据本身：这些词后面跟的仍必须是原有的否定动词表。
// 体格检查的否定动词（2026-09-26 公开语料实测漏判）。书面病历的查体段不写「无反跳痛」，
// 写「全腹未触及压痛反跳痛」「未扪及肌紧张」「病理反射未引出」——原否定动词表只收了
// 未见/未发现/未患 这一支，于是每份外科病历都有的这句**阴性**体征被判成阳性反跳痛，
// 直接弹急腹症红旗（CMB-Clin「案例分析-痈」实测：颈部痈，因查体句误报急腹症）；
// 「四肢肌力正常，未触及抽搐」同理弹神经系统急症。
// 触诊/叩诊/听诊/引出是封闭的查体动词类，枚举安全（冻结令「有限闭集」例外）。
// 刻意不收裸「未及」：「未及时就诊，胸痛持续加重」会被整条判成否定，方向最危险。
// 这一份被 diagnosis-safety.ts 的 NEGATION_PATTERN 共用——同一判据只写一处。
export const CLINICAL_EXAM_NEGATION_VERB_SOURCE = String.raw`未(?:触及|扪及|查及|叩及|闻及|触得|扪得|测及|引出)|不存在`;

/**
 * 「病历缺这一项」与「这一项要鉴别、要排除」的说法（2026-10-19，M03 本例说法核对）：未诉、未记录、未提及、未查、尚缺、待查、
 * 需核实、需排除、需与…鉴别、不详……这类话是在说病历里没有什么或下一步要查什么，不是在说患者有什么——核对「本例说法有无病历依据」时，
 * 片段所在分句里带这类字的，一律不当作没有依据的本例说法删掉（m03-patient-claim-check.server.ts）。封闭的语法类（缺失/待核实/鉴别意图标记），不是临床词表。
 */
export const RECORD_GAP_MARKER = /未(?:诉|述|记录|记|提及|提到|写明?|查|行|做|见|明确?)|尚(?:未|缺|待|需|不明)|待(?:查|核实?|排|补)|需(?:要)?(?:先)?(?:与|核实|排除|警惕|结合|进一步|鉴别|考虑)|不详|不明确/u;

/** RECORD_GAP_MARKER 里「这一项要鉴别、要排除、要核实」那一半：写在句末时管整个分句（「乏力、抽筋、月经紊乱需排除甲减」）。 */
export const RECORD_CONSIDERATION_MARKER = /需(?:要)?(?:先)?(?:与|核实|排除|警惕|结合|进一步|鉴别|考虑)|待(?:查|核实?|排)/u;

/** 紧跟时间、次数、年龄单位的中文数字（「五天」「十二个月」「三次」）；M03 本例说法核对比较「五天」与「5天」时用。封闭的计量构词。 */
export const CHINESE_NUMERAL_BEFORE_UNIT = /([一二两三四五六七八九十]{1,3})(?=个?(?:天|日|周|月|年|次|小时|岁|分钟))/gu;

/** 句首的「有/伴/伴有/见/可见/出现」：说法本身只是「有某表现」（「有胸痛」）。封闭的存在动词类。 */
export const EXISTENCE_LEAD_IN = /^(?:伴有|伴|有|可见|见|出现)/u;

/** 项末接上半句的连接词（并、且、伴、而、及、和、与），可带一个程度词（明显、较、稍、偶有…）。封闭的连词类。 */
export const CLAUSE_LINKER_TAIL = /[并且伴而及和与](?:明显|较为|较|稍|偶有|时有|有)?$/u;

/**
 * 指本例患者的主语（本例、患者、患儿、该患者、此例、该例）。M03 本例说法核对用它分开「别的病的表现，本例……」这种对照句的两半：
 * 主语出现在片段之后、片段之前没有时，片段写的是对照的那个病（m03-patient-claim-check.server.ts）。封闭的指称语法类，不是临床词表。
 */
export const PATIENT_SELF_REFERENCE = /本例|该例|此例|该患者|患者|患儿/u;

// 「当时/此时/发病时/起病时」开头的否认（「当时无腹痛、水肿、发热及关节痛」）同样是否认：此前前缀不认「当时」，
// 关节痛被读成阳性，治疗卡写「针对本例关节」（2026-10-19 验收主集 RobustSDT-single_0532）。
const NEGATIVE_PREFIX = new RegExp(String.raw`^(?:(?:患者|病人|本人|既往|目前|当前|现阶段|本次|近期|近日|入院以来|就诊以来|发病以来|病程中|病程以来|随访以来|既往史|过敏史|用药史|当时|此时|彼时|发病时|起病时|就诊时|入院时)\s*[：:]?\s*)?(?:${CLINICAL_EXAM_NEGATION_VERB_SOURCE}|否认|不是(?!很|太|特别|十分|非常|明显|严重|剧烈|轻|重|持续|一直)|并非(?!很|太|特别|十分|非常|明显|严重|剧烈|轻|重|持续|一直)|不曾|没有|并无|未见|未发现|未提示|未诊断|未患|未(?:服用|使用|口服|应用)|暂(?:不|未)(?:服用|使用|口服|应用|吃)|没(?:有)?(?:服用|使用|吃)|从未|无(?!菌性|痛性|症状性|创性|脉性|意识性)|暂无(?:明确)?|已排除|已除外)`);
// Colloquial history commonly uses the aspect marker “过” instead of a formal “否认/未见”,
// for example “没吐过血” or “没有晕厥过”. Requiring the aspect marker keeps this boundary
// narrow enough that affirmative negative-form symptoms such as “没精神/没力气/没胃口” remain
// symptoms rather than being silently discarded as denials.
const COLLOQUIAL_PAST_EVENT_NEGATION = /^(?:(?:患者|病人|本人|既往|目前|当前|现阶段|本次|近期|近日|入院以来|就诊以来|发病以来|病程中)\s*[：:]?\s*)?(?:没|没有)[^，,。；;\n]{1,32}过[^，,。；;\n]{0,16}$/;
const BARE_NO_HISTORY = /^无(?!菌性|痛性|症状性|创性|脉性|意识性)[^。；;\n]{0,48}(?:病史|过敏史|用药史|功能不全|功能异常|异常|过敏|用药|服药)$/;
// 「X阴性」「X（-）」「X(-)」是检查/系统回顾里的标准否定记法（呕血(-)，黑便(-)）；
// 此前只认「检查阴性」整词，于是「呕血阴性」「呕血（-）」判 affirmed。构词式守卫，闭集。
const NEGATIVE_SUFFIX = /(?:已排除|已除外|检查阴性|阴性|[（(]\s*[-−－—]\s*[)）]|未见(?:明显)?异常|未发现(?:明显)?异常|不支持|不考虑)$/;
const POSTFIX_NEGATIVE = /(?:病史|过敏史|用药史|功能不全|功能异常|过敏|用药|服药)\s*[：:]?\s*(?:无|否认|没有|并无|未见|未发现|未患)$/;
// 事件型后缀否定（2026-09-08 实测漏判）：「呕血并未出现」「晕厥一次也未发生」「肢体无力也未见」
// 「意识丧失并未发生」在安全门里早已按否定处理，极性层却判 affirmed，于是可见摘要/西医依据表
// 把它们当阳性事实。动词限定在**出现类**（出现/发生/发作/再发/复发/见）——「咳嗽并未缓解」是
// 症状仍在，必须继续判 affirmed，因此缓解/好转/消失/控制类不在此列。构词式守卫，闭集。
const POSTFIX_EVENT_NEGATION = /(?:(?:并未|未曾|尚未|从未|从来没有?|从来未|一次也(?:没有|未|没)|也未|也没有?|也无|并无|并没有?)(?:出现|发生|发作|再发|复发|见到?|有)?|(?:未|没有|没)(?:出现|发生|发作|再发|复发|见到?))$/;
const UNCERTAIN_CUE = /(?:待排(?:除)?|待查|待明确|待核实|可能|疑似|不能排除|无法排除|尚不明确|不详|未知|未提供|未采集|未询问|说不清)/;
// 转折词。原来漏了「唯/惟/仅/只是/只有」，于是「未见明显异常，唯血压偏高」里的
// 阳性部分被前半句的否定整条吞掉——阳性事实静默消失，比多报一条危险。
const DISCOURSE_PREFIX = /^(?:但|但是|然而|不过|而|另有|同时|唯|惟|仅|只是|只有|其中)\s*/;
const AFFIRMED_ASSERTION_PREFIX = /^(?:(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:小时|天|日|周|月|年)前\s*)?(?:既往|当前|目前|现阶段|本次|今日|今天|今晨|今早|昨夜|昨晚|昨日|近来|近期)?\s*(?:有|是|转为|突发|新发|出现|发生|排出|患有|确诊|诊断为|现服|正在服用|开始服用|开始口服|开始使用|新启用|新开|启用|加用|改用|服用|使用|口服|应用|对)/;
const AFFIRMED_PREDICATE = /(?:不是|并非)(?:很|太|特别|十分|非常|明显|严重|剧烈|轻|重|持续|一直)|(?:持续|反复|仍有|仍感|依然|存在|加重|恶化|发作|出现|发生|阳性|异常|过敏|服用|口服|使用)|以[^，,。；;\n]{1,16}为主|偏高|偏低|升高|增高|降低|下降|增多|减少|减轻|加剧|(?:已|约)?\s*(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半数几多]+)\s*(?:分钟|分|小时|天|日|周|月|年|次|回|阵|口|度|℃|mL|ml|毫升|g|kg|mmHg)/;

function normalizedClinicalText(value: string): string {
  return value.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
}

const HISTORICAL_TEMPORAL_CUE_SOURCE = String.raw`(?:既往|曾经|曾有|此前|过去|当时|小时候|幼时|儿时|童年|年幼时|上次|入院时|术前|治疗前|发作时|一度|昨日|昨天|前天|上周|上月|去年|前年|多年前|(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:年|个月|月|周|天|日)前|(?<!现)病史)`;
// 当前时间框架的指示词。2026-09-26 前只认「本次/今天/目前…」，于是「既往体健，这次胸痛伴大汗」
// 「去年诊断冠心病，近两天胸闷持续加重」「3天前开始胸痛」里的当前事件被前面的既往锚点吞掉
// （安全门判 ready、给剂量）。补的是同一闭集里漏掉的成员，不是新判据：
// 这次/此次/这回/此番 与「本次」同义；刻下/现症见 是病历里的当前症状起首语；
// 近日/近来/近期/近N天/这两天、N小时前/N分钟前 是近期时段；「N天前开始/起」是起病时间，
// 与「N天前」同一起点位置，lastHistorical > lastCurrent 不成立，按当前事件处理。
// 刻意不收单字「现」：它在「出现/发现/表现」里，会把每个「出现」都当成当前锚点。
const CURRENT_TEMPORAL_CUE_SOURCE = String.raw`(?:本次|本轮|这次|此次|这回|此番|这一次|当前|目前|现在|当下|如今|眼下|刻下|刻诊|现症见?|今日|今天|今晨|今早|刚刚|刚才|方才|近日|近来|近期|近(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:天|日|周|个月|月)|这(?:两|几|数)天|(?:\d+|[一二两三四五六七八九十半数几]+)\s*(?:天|日|周|个月|月)前(?:开始|起)|(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半数几]+)\s*(?:个)?(?:小时|分钟)前|昨日起|昨日(?:起|开始)|昨天(?:起|开始)|昨夜开始|昨晚开始|新发|再发|复发|又发|又有)`;

/**
 * 近期起病句式：「N天/日/周前（受凉后/无明显诱因/无意中…）出现/发生/发病/起病/发作/感到/感觉/自觉」。
 * 它与「N天前开始/起」是同一个起病时间表达，但**只给事实层原文落地核验用**（见 clinicalEventTemporalScopeAt
 * 的 groundingQuote 选项），安全门的时间判定不收：2026-09-28 用灵丹医案语料 27,329 句实测，把它并进
 * CURRENT 闭集会让 255 句的门禁结论改变（「6个月前受凉后出现发热，最高41℃」「9个月前出现胸闷气促」
 * 都被抬成急症红旗），那是另一个需要单独裁定的安全口径。事实层不同：模型已经判定该条为当前阳性，
 * 这里只核验引用不是既往叙述；此前「4天前出现发热，最高38.5℃」「1周前出现肢体无力，最重时不能站立」
 * 被判既往而丢弃，再多跑一轮 6–10s 的引用修复（本机 65 例 8 次修复里 5 次是这一类）。
 * 月、年不收：「3个月前出现阴道出血」「1年前开始出现胸闷」是否仍在进行，由修复轮交给模型重判。
 * 「半月/半个月」是两周，与「周」同档收（CMB-Clin 45 例里「约半月前劳累后出现发热不适，自测体温
 * 最高39.5℃」因此多一轮修复，修复后结论不变）。
 */
const RECENT_ONSET_TEMPORAL_CUE_SOURCE = String.raw`(?:(?:\d+|[一二两三四五六七八九十半数几]+)\s*(?:天|日|周)|半个?月)前[^，,。；;\n]{0,12}?(?:出现|发生|发病|起病|发作|感到|感觉|自觉)`;

/**
 * 封闭背景句：本身是一句完整的基线概括——「既往体健」「既往史无特殊」「否认高血压、糖尿病病史」
 * 「此前从未有过类似情况」。
 * 它的时间锚点只管自己这一逗号分句，不能越过逗号把后面的当前主诉一起算成既往。
 * 2026-09-26 实测：「患者既往体健，2小时前无明显诱因出现胸痛，伴大汗」「既往体健，呕血2次，
 * 黑便1天，头晕乏力」在安全门上 ready、给剂量；「否认高血压病史，血压190/125mmHg，头痛」连当前
 * 血压读数都被「病史」吞成既往。把逗号换成句号就正确报红旗。
 *
 * 只认闭集结尾（体健/健康/无特殊/否认或无…史/从未…类似情况），这是构词式守卫。否定式病史没有
 * 可供后文展开的既往内容，所以可以截断；刻意不收肯定式「…病史」：
 * 医案语料 27,329 句实测，「…史」后面接的常是那段病史的细节——「3年前有2次人流史，术后流血
 * 持续了十多天」「高血压病史2年，最高血压220/110mmHg」「根据既往史，2岁时曾发生过一次热惊厥」，
 * 截断会把这些既往细节抬成当前急症。「…病史，近期/N天前开始/这次…」由上面的当前锚点覆盖；
 * 没有任何时间词的「既往有高血压病史，胸痛2小时伴大汗」仍归语义层（字面上与既往细节分不开）。
 * 开放的叙事链「3年前劳累后出现胸痛，伴大汗，经治疗缓解」同理不在此列。
 */
const CLOSED_BACKGROUND_CLAUSE = /^\s*(?:患者|病人|患儿|本人)?\s*[^，,]{0,24}?(?:体健|身体健康|体质尚可|无特殊|无殊|(?:无|否认|没有|未见)[^，,]{0,16}?(?:史|病)|(?:从未|未曾|没有|无)[^，,]{0,8}(?:类似|这种|此类|同样)[^，,]{0,6}(?:情况|症状|发作|表现))\s*$/;

function maskClosedBackgroundClauses(before: string): string {
  const segments = before.split(/([，,])/);
  // 最后一段是事件自己所在的分句：它的锚点照常生效。
  for (let index = 0; index < segments.length - 1; index += 2) {
    if (CLOSED_BACKGROUND_CLAUSE.test(segments[index])) segments[index] = " ".repeat(segments[index].length);
  }
  return segments.join("");
}

function lastMatchIndex(value: string, source: string): number {
  let last = -1;
  for (const match of value.matchAll(new RegExp(source, "g"))) last = match.index ?? last;
  return last;
}

function hasAffirmedCurrentRecurrence(value: string): boolean {
  for (const match of value.matchAll(new RegExp(`${CURRENT_TEMPORAL_CUE_SOURCE}[^。；;\\n]{0,14}(?:再次|再度|又)?(?:再发|复发|发作|出现|发生)`, "g"))) {
    if (!/(?:无|未|否认|没有)[^。；;\n]{0,6}(?:再发|复发|发作|出现|发生)/.test(match[0])) return true;
  }
  if (/(?:持续至今|至今仍|目前仍|当前仍|现在仍|仍在持续|尚未缓解|仍未缓解|没有缓解|无缓解)/.test(value)) return true;
  return false;
}

/**
 * Classifies the patient event at `index` without letting a historical cue leak across a hard clause.
 * `eventLength` lets callers recognize postfix forms such as “胸痛发生在上周”.
 */
export function clinicalEventTemporalScopeAt(
  value: string,
  index: number,
  eventLength = 0,
  options: {
    /**
     * 事实层原文落地核验专用（clinical-facts.isCurrentQuoteOccurrence）：事件是模型给出的整段引用。
     * 引用自带的时间词（「近两天来出现血尿」的「近两天」）参与判定，并额外承认近期起病句式
     * （RECENT_ONSET_TEMPORAL_CUE_SOURCE）。安全门不传，行为不变。
     */
    groundingQuote?: boolean;
  } = {},
): ClinicalEventTemporalScope {
  const normalized = value.normalize("NFKC").replace(/\r\n?/g, "\n");
  const safeIndex = Math.max(0, Math.min(index, normalized.length));
  const hardStart = Math.max(
    normalized.lastIndexOf("。", safeIndex - 1),
    normalized.lastIndexOf("；", safeIndex - 1),
    normalized.lastIndexOf(";", safeIndex - 1),
    normalized.lastIndexOf("\n", safeIndex - 1),
  ) + 1;
  const endCandidates = ["。", "；", ";", "\n"]
    .map((mark) => normalized.indexOf(mark, safeIndex + Math.max(0, eventLength)))
    .filter((position) => position >= 0);
  const hardEnd = endCandidates.length > 0 ? Math.min(...endCandidates) : normalized.length;
  const before = normalized.slice(hardStart, safeIndex);
  // 引用自带的文字只用来找「当前/近期」线索（「近两天来出现血尿」的「近两天」），不参与找既往锚点：
  // 引用里的词会碰巧含既往锚点字面——「晕过去了」含「过去」，并进来会把当前晕厥判成既往（open-language-classes 钉住）。
  const currentSearchText = options.groundingQuote
    ? before + normalized.slice(safeIndex, Math.min(hardEnd, safeIndex + Math.max(0, eventLength)))
    : before;
  const afterEvent = normalized.slice(Math.min(hardEnd, safeIndex + Math.max(0, eventLength)), hardEnd);

  const lastHistorical = lastMatchIndex(maskClosedBackgroundClauses(before), HISTORICAL_TEMPORAL_CUE_SOURCE);
  const lastCurrent = Math.max(
    lastMatchIndex(currentSearchText, CURRENT_TEMPORAL_CUE_SOURCE),
    options.groundingQuote ? lastMatchIndex(currentSearchText, RECENT_ONSET_TEMPORAL_CUE_SOURCE) : -1,
  );
  const postfixHistorical = new RegExp(
    `^(?:\\s*(?:发生|发作|出现|起病|开始)?\\s*(?:于|在|是)?\\s*)${HISTORICAL_TEMPORAL_CUE_SOURCE}`,
  ).test(afterEvent);
  const historical = lastHistorical > lastCurrent || postfixHistorical;
  if (!historical) return "current";

  if (hasAffirmedCurrentRecurrence(afterEvent)) return "current";

  const resolved =
    /(?:(?:之后|以后|随后|后来)|(?:(?:经[^，,。；;\n]{0,12})?(?:治疗|处理|休息|用药|吸氧)后))?\s*(?:现已|目前已|当前已|已经|已)?\s*(?:完全|明显|基本|逐渐|自行)?\s*(?:缓解|消失|好转|改善|恢复|稳定|痊愈)/.test(afterEvent) ||
    /(?:无再发|未再发|没有再发|不再发作|未再出现)/.test(afterEvent) ||
    /(?:目前|当前|现在|今日|今天|现)[^。；;\n]{0,20}(?:否认|无|没有|未见|无再发|未再发|未出现|无不适)/.test(afterEvent) ||
    /(?:本次|当前|现在|今日|今天|复测|复查|再测)[^。；;\n]{0,28}(?:复测|复查|测得|测量|结果|为)?[^。；;\n]{0,12}\d/.test(afterEvent);
  return resolved ? "historical_resolved" : "historical";
}

/**
 * 病历字段标签。它不是临床断言的一部分，但会把断言从分句开头顶开——
 * NEGATIVE_PREFIX / AFFIRMED_ASSERTION_PREFIX 都锚在 `^`，于是看不到紧随标签之后的「否认/无」。
 *
 * 实测（tmp-probe/probe-fieldlabel-polarity.mjs，改之前）：
 *   「否认胸痛」            → negative，正确
 *   「现病史：否认胸痛」     → **affirmed**，并作为阳性事实原样返回
 *   「现病史：无黑便」       → **affirmed**
 *   「个人史：无吸烟饮酒史」  → **affirmed**
 *   「既往史：否认高血压病史」 → negative（碰巧被 POSTFIX_NEGATIVE 的「病史…否认」尾式接住）
 * 也就是说：一个**被否认**的症状，只要前面带字段标签，就会变成阳性事实。方向是不安全的那一侧
 * ——它会进入方剂召回的 positiveCaseFacts、进入 M03 的既往诊断判定、进入可见的支持依据。
 * 之所以一直没暴露，是因为「既往史：否认…病史」这种最常见的写法恰好被尾式判据接住了。
 *
 * 处理方式与 DISCOURSE_PREFIX 完全一致：**只在判定极性前剥掉，不改变返回给调用方的原文**
 * （调用方要的是病历里的逐字子串）。
 */
export const SECTION_LABEL_PREFIX = /^(?:主诉|现病史|既往史|个人史|家族史|婚育史|月经史|生育史|手术史|外伤史|输血史|过敏史|用药史|药物过敏史|查体|体格检查|专科检查|辅助检查|实验室检查|影像学检查|现症|刻下|刻诊)\s*[：:]\s*/;

/** 剥掉病历字段标签，只留临床断言本身。判据一处，极性层与调用方共用。 */
export function stripClinicalSectionLabel(clause: string): string {
  return clause.replace(/^\s+/, "").replace(SECTION_LABEL_PREFIX, "").trim();
}

export function clinicalClausePolarity(value: string): ClinicalClausePolarity {
  const clause = normalizedClinicalText(value)
    .replace(SECTION_LABEL_PREFIX, "")
    .replace(DISCOURSE_PREFIX, "")
    .trim();
  if (!clause) return "uncertain";
  // 「无法/无从/无需/无论」是情态与连词，不是否认。「无法完全否认呕血」= 可能有呕血。
  if (NON_NEGATING_WU_MODAL.test(clause)) {
    return UNCERTAIN_CUE.test(clause) || /否认|排除|除外/.test(clause) ? "uncertain" : "affirmed";
  }
  // 总括量词否定（均无/皆无/都没有…）：整句、前缀、后缀三种形态，词表只在 clinical-vocabulary 一处。
  if (classifyBlanketAnswer(clause) === "negation" || endsWithBlanketQuantifiedNegation(clause)) return "negative";
  // 「也没有急躁易怒」「亦无发热」：句首的「也/亦/还/且」不挡否认词（2026-10-19：否认改为不跨逗号继承后，「否认口苦目赤，也没有急躁易怒」
  // 的后半句要靠它自己的否认词判阴性）。
  const quantifierStripped = stripBlanketQuantifierPrefix(clause).replace(/^(?:也|亦|还|且)\s*(?=(?:没有|没|无|未|不|否认))/u, "");
  // 「不发热」「不吸烟」「不咳」：句首「不」接这一小组症状或嗜好时是否认（有限闭集）。「不寐」「不思饮食」「不耐寒」「不适」是阳性症状名，不在其列。
  if (/^不(?:发热|发烧|恶寒|畏寒|怕冷|咳|喘|痛|疼|痒|肿|渴|吸烟|抽烟|饮酒|喝酒|出汗|汗出|头痛|头晕|呕|吐|腹泻|泄泻|便血|黑便)/u.test(quantifierStripped)) return "negative";
  if (NEGATIVE_PREFIX.test(quantifierStripped) || COLLOQUIAL_PAST_EVENT_NEGATION.test(quantifierStripped) || BARE_NO_HISTORY.test(quantifierStripped) || NEGATIVE_SUFFIX.test(clause) || POSTFIX_NEGATIVE.test(clause) || POSTFIX_EVENT_NEGATION.test(clause)) return "negative";
  if (classifyBlanketAnswer(clause) === "unknown") return "uncertain";
  if (UNCERTAIN_CUE.test(clause)) return "uncertain";
  return "affirmed";
}

/**
 * Returns affirmed text as exact substrings of the supplied clinical source. This companion to
 * `affirmedClinicalText` deliberately preserves the caller's punctuation and wording, so patient
 * evidence can be projected into signed/visible contracts without presenting a normalized or
 * provider-joined reconstruction as a verbatim chart quote.
 */
export function affirmedClinicalSourceClauses(value: string | null | undefined): string[] {
  const source = value?.replace(/\r\n?/g, "\n").trim() || "";
  if (!source) return [];

  const parts = source.split(/([，,、。；;\n]+)/);
  const clauses: string[] = [];
  let inheritedPolarity: ClinicalClausePolarity | undefined;
  let inheritedFromDenial = false;
  let previousWasAffirmed = false;

  for (let index = 0; index < parts.length; index += 2) {
    const separator = index === 0 ? "" : parts[index - 1];
    const hardBoundary = index === 0 || /[。；;\n]/.test(separator);
    // 「无…」开头的否认只在顿号列举里继承（「无恶心、呕吐」），逗号处重置（2026-10-19）。此前「无胸闷、心慌，偶咳嗽，腰痛、腿疼，
    // 纳可，小便热」里逗号后的阳性项全被当成否认丢掉，「无异常气味，舌淡苔白，脉弦滑」连舌脉也丢了：教材改名的证据、加减触发、
    // 兼证核对都读不到。「否认…」开头的仍可延续到逗号后光秃的症状（「否认胸痛，腹痛」是同一串否认）；有独立谓词的照常算阳性。
    if (hardBoundary || (/[，,]/.test(separator) && !inheritedFromDenial)) inheritedPolarity = undefined;

    const rawClause = parts[index].trim();
    if (!rawClause) {
      previousWasAffirmed = false;
      continue;
    }
    const discourseMatch = rawClause.match(DISCOURSE_PREFIX);
    const clause = rawClause.replace(DISCOURSE_PREFIX, "").trim();
    if (!clause) continue;

    const explicitPolarity = clinicalClausePolarity(clause);
    let polarity = explicitPolarity;
    if (!hardBoundary && explicitPolarity === "affirmed" && inheritedPolarity &&
        !hasIndependentAffirmedAssertion(clause, Boolean(discourseMatch))) {
      polarity = inheritedPolarity;
    }

    if (polarity === "affirmed") {
      if (!hardBoundary && previousWasAffirmed && clauses.length > 0) {
        clauses[clauses.length - 1] += `${separator}${clause}`;
      } else {
        clauses.push(clause);
      }
    }
    inheritedPolarity = polarity;
    if (explicitPolarity === "negative") inheritedFromDenial = /^否认/u.test(clause);
    else if (polarity !== "negative") inheritedFromDenial = false;
    previousWasAffirmed = polarity === "affirmed";
  }

  return [...new Set(clauses)];
}

/**
 * 一条病历事实是否**整条**都是否定（可作「排除依据」）。
 *
 * 2026-09-08 用真函数复现：classifyWesternDiagnosticEvidence 与 documentedExclusionFacts 各自
 * 用「整句极性」或「句内出现否认/无」判排除依据，于是「否认腹痛，呕血1次」（黄金基线用例
 * negated-abdominal-then-hematemesis 的原文）整条进了「排除依据」——安全门在同一句里抬出
 * 消化道出血优先评估，西医依据表却把它展示成「已排除」。判据只放这一处：按子句极性（含
 * 逗号继承与独立断言识别）判定，任一子句为阳性即不是排除依据；没有任何否定子句也不是。
 */
export function isWhollyNegatedClinicalFact(value: string | null | undefined): boolean {
  const source = value?.replace(/\r\n?/g, "\n").trim() || "";
  if (!source) return false;
  if (affirmedClinicalSourceClauses(source).length > 0) return false;
  return source
    .split(/[，,、。；;\n]+/)
    .map((clause) => clause.replace(DISCOURSE_PREFIX, "").trim())
    .filter(Boolean)
    .some((clause) => clinicalClausePolarity(clause) === "negative");
}

function hasIndependentAffirmedAssertion(clause: string, hasDiscourseBoundary: boolean): boolean {
  return hasDiscourseBoundary || AFFIRMED_ASSERTION_PREFIX.test(clause) || AFFIRMED_PREDICATE.test(clause);
}

/**
 * Which clause polarities a caller wants back.
 *
 * `affirmed` (the default) suits recall-style callers: retrieving a formula from a hedged "可能有
 * 心衰" would be over-reach. It is the WRONG default for contraindication and audit callers, where
 * dropping an uncertain comorbidity silently removes the very fact that would have raised a
 * warning. Those callers must opt into `affirmed_or_uncertain` so an unresolved finding fails
 * safe (included) instead of failing silent (dropped alongside explicit negatives).
 *
 * `negative` is never returned by either policy — an explicit denial must not become a positive
 * fact anywhere.
 */
export type ClinicalPolarityScope = "affirmed" | "affirmed_or_uncertain";

function polarityInScope(polarity: ClinicalClausePolarity, scope: ClinicalPolarityScope): boolean {
  return polarity === "affirmed" || (scope === "affirmed_or_uncertain" && polarity === "uncertain");
}

/**
 * 由语义否定增补层（polarity-negation-assist.server）判定为否定的分句原文集合。
 *
 * 确定性正则覆盖不到口语否定——实测「胸口不疼」「早就不疼了」「哪有什么胸痛」「胸痛这个倒是没有」
 * 全部被判为阳性。口语否定与口语症状一样穷举不完，因此这一步交给模型，但只允许它把阳性降为否定，
 * 不允许反向。
 *
 * ★ 只作用于 scope === "affirmed" ★
 * 这不是实现细节，是安全边界。两类消费者的失败方向相反：
 *   - affirmed（检索/依据/grounding）：把否定当阳性会伪造依据，补上否定更严格。
 *   - affirmed_or_uncertain（审方 rxaudit / 方剂禁忌）：这些调用点故意保留未消解的表述，
 *     以免漏掉本该触发的警告；在这里补否定 = 少一条警告，方向恰好相反。
 * 因此增补集在 affirmed_or_uncertain 下被完全忽略。
 */
/**
 * 双向语义极性裁决（2026-08-10）。原来只有否定方向一个 Set，现在两个方向各一个。
 *
 * 为什么需要阳性方向：中医里「无汗」「不渴」「不恶寒」是**证候的定义性指征**，不是
 * 「没有该症状」。实测风寒表实的教科书主诉「恶寒发热，无汗，头痛，身痛，脉浮紧」，
 * 召回侧只拿到 3 条事实——无汗、头痛、身痛全被剥掉；而「无汗」恰恰是表实证区别于
 * 桂枝汤证的眼目。头痛/身痛是被「无汗」的否定作用域顺着逗号带走的。
 *
 * 为什么不能用规则解决：同一个「无汗」，在四诊主诉里是阳性体征，在系统回顾式否认
 * （「无汗出、无心悸、无胸闷」）里是真否定。**规则层没有能区分两者的信号**，
 * 而把患者的否认读成阳性体征比原缺陷更危险——这条判断本仓库早有定论
 * （见 clinical-vocabulary.ts 的 affirmativeNegationFormsIn 注释）。所以交给模型，
 * 但把它关进受治理闭集：只有含 tcm-affirmative-negation-forms.json 里那 68 条词的分句
 * 才进候选，模型只能返回候选序号、不能引入任何新文本。
 *
 * 副作用是正向的：分句被判阳性后 inheritedPolarity 随之变阳性，
 * 后续的「头痛」「身痛」不再继承否定——一处裁决同时修好被误删的词与被带走的下文。
 */
export type AssistedPolarityDecisions = {
  /** 确定性层判阳性、实为口语否定的分句。 */
  negated: ReadonlySet<string>;
  /** 确定性层判否定、实为阴性形式阳性体征的分句（受治理闭集内）。 */
  affirmed: ReadonlySet<string>;
};

/** 兼容旧形态：单个 Set 等价于「只有否定方向」。 */
export type AssistedNegationClauses = ReadonlySet<string> | AssistedPolarityDecisions;

function assistedDirections(value?: AssistedNegationClauses): {
  negated?: ReadonlySet<string>;
  affirmed?: ReadonlySet<string>;
} {
  if (!value) return {};
  if (value instanceof Set) return { negated: value as ReadonlySet<string> };
  const decisions = value as AssistedPolarityDecisions;
  return { negated: decisions.negated, affirmed: decisions.affirmed };
}

export function affirmedClinicalText(
  value: string | null | undefined,
  scope: ClinicalPolarityScope = "affirmed",
  assistedNegations?: AssistedNegationClauses,
): string | undefined {
  const assisted = assistedDirections(assistedNegations);
  const normalized = value ? normalizedClinicalText(value) : "";
  if (!normalized) return undefined;

  const parts = normalized.split(/([，,、。；;\n]+)/);
  const clauses: string[] = [];
  let inheritedPolarity: ClinicalClausePolarity | undefined;
  let inheritedFromDenial = false;
  let previousWasAffirmed = false;

  for (let index = 0; index < parts.length; index += 2) {
    const separator = index === 0 ? "" : parts[index - 1];
    const hardBoundary = index === 0 || /[。；;\n]/.test(separator);
    // 「无…」开头的否认只在顿号列举里继承（「无恶心、呕吐」），逗号处重置（2026-10-19）。此前「无胸闷、心慌，偶咳嗽，腰痛、腿疼，
    // 纳可，小便热」里逗号后的阳性项全被当成否认丢掉，「无异常气味，舌淡苔白，脉弦滑」连舌脉也丢了：教材改名的证据、加减触发、
    // 兼证核对都读不到。「否认…」开头的仍可延续到逗号后光秃的症状（「否认胸痛，腹痛」是同一串否认）；有独立谓词的照常算阳性。
    if (hardBoundary || (/[，,]/.test(separator) && !inheritedFromDenial)) inheritedPolarity = undefined;

    const rawClause = parts[index].trim();
    if (!rawClause) {
      previousWasAffirmed = false;
      continue;
    }
    const discourseMatch = rawClause.match(DISCOURSE_PREFIX);
    const clause = rawClause.replace(DISCOURSE_PREFIX, "").trim();
    if (!clause) continue;

    const explicitPolarity = clinicalClausePolarity(clause);
    let polarity = explicitPolarity;
    if (!hardBoundary && explicitPolarity === "affirmed" && inheritedPolarity &&
        !hasIndependentAffirmedAssertion(clause, Boolean(discourseMatch))) {
      polarity = inheritedPolarity;
    }
    // 语义否定增补：只在证据类 scope 下、确定性层未判为否定时生效。
    if (scope === "affirmed" && explicitPolarity !== "negative" && assisted.negated?.has(clause)) {
      polarity = "negative";
    }
    // 语义阳性增补：只在证据类 scope 下生效。候选池在 polarity-negation-assist.server.ts
    // 里已被限定为「含受治理阴性形式阳性体征词」的分句，模型只能在其中挑选。
    // 与否定方向一样，**绝不作用于 affirmed_or_uncertain**——审方/方剂禁忌那一侧
    // 故意保留未消解表述以免漏警告，在那里把否定改成阳性等于凭空造出一条用药依据。
    if (scope === "affirmed" && assisted.affirmed?.has(clause)) {
      polarity = "affirmed";
    }

    if (polarityInScope(polarity, scope)) {
      if (!hardBoundary && previousWasAffirmed && clauses.length > 0) {
        clauses[clauses.length - 1] += `${separator}${clause}`;
      } else {
        clauses.push(clause);
      }
    }
    inheritedPolarity = polarity;
    if (explicitPolarity === "negative") inheritedFromDenial = /^否认/u.test(clause);
    else if (polarity !== "negative") inheritedFromDenial = false;
    previousWasAffirmed = polarityInScope(polarity, scope);
  }

  const uniqueClauses = [...new Set(clauses)];
  return uniqueClauses.length > 0 ? uniqueClauses.join("；") : undefined;
}

type ActiveMedicationEvent = { identity: string; text: string };

const MEDICATION_STOP_EVENT = /(?:现已|目前已|当前已|已经|已)\s*(?:停止服用|停止|停用|停服|停药|停)(?!车|电|水)|(?:不再服用|未再服用|停止服用|停止|停用|停服|停药|停了)(?!车|电|水)/;
const NEGATED_MEDICATION_STOP_EVENT = /(?:(?:医生|医师|大夫|医嘱)\s*)?(?:(?:建议|推荐)\s*)?(?:(?:并未|并没有|没有|没|不曾|尚未|暂未|未|不|不要|不得|切勿|避免)\s*(?:(?:考虑|建议|推荐|需要|必要|应该|应当|应|宜|可|能|得)\s*)?|(?:不宜|不应|不建议|不推荐|无需|无须|不必|不可|不能|不得|切勿|避免|暂不考虑|没有必要|没必要)\s*)(?:立即|马上|轻易|擅自|自行|贸然|随意|随便|突然|骤然|骤)?\s*(?:停止服用|停止|停用|停服|停药|停)(?:过)?(?!车|电|水)/;
const MEDICATION_ACTIVE_CUE = /(?:目前|当前|现在|现|仍在|仍|继续|正在|长期|规律|持续|一直|至今|今日|今天|新启用|重新启用|重新服用|再次启用|再次服用|恢复服用|开始服用|开始口服|开始使用|新开|启用|加用|改用)?\s*(?:服用|服|口服|使用|在吃|吃|用)/;
const MEDICATION_RESTART_CUE = /(?:再|又|重新|再次|恢复)(?:开始)?(?:启用|服用|口服|使用|吃)|复服|续服|恢复吃|改回(?:服用|口服|使用|吃)|接着(?:服用|口服|使用|吃|服)|(?:新行|新)(?:启用|服用|口服|使用)/;
const MEDICATION_CURRENT_TRANSITION_CUE = /(?:目前|当前|现在|现服|正在|仍在|继续|续服|接着|一直|至今|迄今|新启用|重新启用|重新服用|再次启用|再次服用|复服|恢复(?:服用|口服|使用|吃)|改回(?:服用|口服|使用|吃)|开始服用|开始口服|开始使用|新开|启用|加用|改用)/;
const MEDICATION_CURRENT_CONTINUATION = /(?:至今|目前|当前|现在)[^。；;\n]{0,12}(?:未|没有|并未|尚未)?(?:停用|停服|停药)|(?:一直|持续|仍)[^。；;\n]{0,12}(?:服用|口服|使用)(?:至今)?/;
const MEDICATION_HISTORY_ONLY_PREFIX = /^(?:(?:在|于)\s*)?(?:(?:约|大约|大概)?(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半两]+|好几|十多|几十|几|多|数|若干)\s*(?:余|来|多)?\s*(?:小时|天|日|周|月|年)(?:余|来|多)?前|(?:19|20)\d{2}年|[零〇一二三四五六七八九]{4}年|(?:几|多|数|若干)年前|前几年|去年|前年|上世纪|小时候|儿童期|青少年时|青年时期|年轻时|大学期间|退休前|很久以前|早些年|早年|既往|曾经|曾|此前|之前|过去|原来|原先|以往|以前|从前|(?:服用过|服过|吃过|用过))/;
const MEDICATION_LIST_DECLARATION = /^(?:目前|当前|现在|现)?\s*(?:用药|服药|药物)(?:情况)?\s*(?:包括|有|为|是)?\s*[：:]?\s*/;
const MEDICATION_FIRST_REFERENT = /(?:前者|第一种|前一种|第一个|首种)/;
const MEDICATION_LAST_REFERENT = /(?:后者|第二种|后一种|第二个|末种)/;
const MEDICATION_ALL_REFERENT = /(?:两者|二者|均|都|全部|上述(?:药物|用药)?)/;
const MEDICATION_REFERENT = /^(?:前者|后者|第一种|第二种|前一种|后一种|第一个|第二个|首种|末种|两者|二者|均|都|全部|上述(?:药物|用药)?)$/;
const MEDICATION_REPLACEMENT_EVENT = /^(?:后|后来|之后|随后)?\s*(?:改用|换用|替换为|更换为)/;
const MEDICATION_CONTINUATION_ONLY = /^(?:(?:(?:每日|每天|每晚|每次|一日|每晨|每周|每月|早晚|晨起|睡前)\s*)?(?:各\s*)?(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半]+)\s*次(?:\s*(?:服用|口服|使用))?|(?:每周|每月|每隔(?:一|二|三|四|五|六|七|八|九|十|\d+)天)\s*(?:一|二|三|四|五|六|七|八|九|十|\d+)?\s*次|(?:每晨|晨起|睡前)(?:服用|口服|使用)?|(?:饭前|饭后|餐前|餐后|随餐|空腹|必要时|按需)(?:立即|同时|一起)?(?:服用|口服|使用)?)$/i;

export function medicationContinuationOnly(value: string): boolean {
  return MEDICATION_CONTINUATION_ONLY.test(normalizedClinicalText(value));
}

const MEDICATION_NAME_PREFIX = /^(?:(?:患者本人|患者|本人|医生|医师|大夫|医嘱|建议|推荐)\s*|(?:(?:当前用药|现用药|用药|既往用药|药物)(?:情况)?\s*(?:包括|有|为|是)?\s*[：:]?\s*)|(?:在|于|从|自)?\s*(?:约|大约|大概)?(?:\d+(?:\.\d+)?|[零〇一二三四五六七八九十百半两]+|好几|十多|几十|几|多|数|若干)\s*(?:余|来|多)?\s*(?:小时|天|日|周|月|年)(?:余|来|多)?前\s*|(?:在|于|从|自)?\s*(?:19|20)\d{2}年(?:开始|起)?\s*|(?:在|于|从|自)?\s*[零〇一二三四五六七八九]{4}年(?:开始|起)?\s*|(?:几|多|数|若干)年前\s*|前几年\s*|(?:去年|前年|上世纪|小时候|儿童期|青少年时|青年时期|年轻时|大学期间|退休前|很久以前|早些年|早年|既往|曾经|曾|此前|之前|过去|原来|原先|以往|以前|从前|目前|当前|现在|现|后来|之后|随后|后|仍在|仍|继续|续服|接着|正在|长期|规律|持续|一直在|一直|迄今|至今|今日|今天|新启用|重新开始服用|重新开始口服|重新启用|重新服用|再次启用|再次服用|复服|恢复服用|恢复口服|恢复使用|恢复吃|改回服用|改回口服|改回使用|改回吃|又开始服用|又开始口服|现又吃|再服用|再口服|开始服用|开始口服|开始使用|开始|新开|启用|加用|改用|换用|替换为|更换为)\s*|(?:服用过|服过|吃过|用过|服用|续服|服|口服|舌下含服|皮下注射|皮下|肌内注射|肌注|静脉注射|静脉滴注|静滴|注射|外用|吸入|鼻饲|直肠给药|使用|在吃|吃|用)\s*)/;

// 时间与就诊状语只说明用药事件的起点，不是药物身份。这是构词式闭集守卫：
// 既让「发病后未服药」落为明确阴性，也让「发病后服用布洛芬」仍能抽出真正药名。
const MEDICATION_CLINICAL_CONTEXT_PREFIX = /^(?:(?:本次|此次)?(?:发病|起病|症状出现|出现症状|不适出现)(?:后|以来|至今)|(?:本次|此次)?(?:就诊|入院|住院|来诊)(?:前|后|以来)|(?:近|最近)\s*(?:约|大约|大概)?\s*(?:\d+(?:\.\d+)?|[零〇一二三四五六七八九十百半两]+)\s*(?:小时|天|日|周|月|年)(?:以来|内)?|截至目前)\s*/;

/** Canonical drug-name extraction shared by current-medication filtering and audit payloads. */
export function medicationNameFromEventText(value: string): string {
  let candidate = normalizedClinicalText(value).replace(DISCOURSE_PREFIX, "").trim();
  let previous = "";
  while (candidate && candidate !== previous) {
    previous = candidate;
    candidate = candidate
      .replace(MEDICATION_CLINICAL_CONTEXT_PREFIX, "")
      .replace(MEDICATION_NAME_PREFIX, "")
      .trim();
  }
  candidate = candidate
    .replace(NEGATED_MEDICATION_STOP_EVENT, "")
    .replace(MEDICATION_STOP_EVENT, "")
    .replace(/\s*(?:(?:目前|当前|现在)?(?:均|都|仍)?(?:在)?(?:服用|口服|使用)(?:至今)?|至今(?:未|没有|尚未)?(?:停用|停服|停药))\s*$/, "")
    .trim();
  const doseStart = candidate.search(/\s*(?:(?:\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?)|(?:\d+(?:\.\d+)?\s*(?:-|~|至)\s*\d+(?:\.\d+)?)|\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万半]+)\s*(?:毫克|微克|毫升|国际单位|单位|mcg|μg|ug|mg|kg|mL|ml|IU|U|g|克|片|粒|丸|袋|支|喷|揿|滴)/i);
  if (doseStart > 0) candidate = candidate.slice(0, doseStart).trim();
  const result = candidate
    .replace(/\s*(?:每日|每天|每晚|每次|一日|早晚|晨起|睡前|必要时|按需|qd|bid|tid|q\d+h).*$/i, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return MEDICATION_REFERENT.test(result) ? "" : result;
}

/**
 * 剂型后缀与受控别名：药名身份归一的**唯一**来源。
 *
 * 这两张表原本在本文件与 rxaudit.ts 各写一份（连 controlledAliases 都逐字重复），
 * 且已分叉——rxaudit 那份缺「混悬滴剂」「胶囊剂」。实测（2026-08-17）该分叉是 fail-open：
 * 身份归一喂 verifyMedicationSemanticCoverage 的**同药状态冲突**判据，剥不掉后缀就被当成两个药，
 *   「现服阿莫西林胶囊，阿莫西林已停用」   → medication_status_conflict ✓
 *   「现服布洛芬混悬滴剂，布洛芬已停用」   → **静默通过** ✗
 * 后者是真实矛盾、本该转人工复核。混悬滴剂正是儿科布洛芬/对乙酰氨基酚的标准剂型。
 * 顺序有意义：长后缀必须排在短后缀之前（缓释胶囊 先于 胶囊），剥离循环跑到不动点为止。
 */
export const MEDICATION_DOSAGE_FORM_SUFFIXES = [
  "缓释胶囊", "肠溶胶囊", "软胶囊", "薄膜衣片", "糖衣片", "泡腾片", "口腔崩解片",
  "缓释片", "控释片", "肠溶片", "分散片", "咀嚼片", "舌下片", "混悬滴剂",
  "胶囊", "片剂", "颗粒剂", "胶囊剂", "片", "颗粒",
];

const MEDICATION_CONTROLLED_ALIASES: Record<string, string> = {
  盐酸二甲双胍: "二甲双胍",
  华法林钠: "华法林",
  华法令: "华法林",
  硫酸氢氯吡格雷: "氯吡格雷",
  枸橼酸西地那非: "西地那非",
};

/** 剥掉剂型后缀并落到受控别名。调用方各自负责大小写/NFKC 等前置归一。 */
export function canonicalMedicationIdentity(value: string): string {
  let identity = value;
  let previous = "";
  while (identity && identity !== previous) {
    previous = identity;
    const suffix = MEDICATION_DOSAGE_FORM_SUFFIXES.find(
      (item) => identity.endsWith(item) && identity.length > item.length + 1);
    if (suffix) identity = identity.slice(0, -suffix.length);
  }
  return MEDICATION_CONTROLLED_ALIASES[identity] || identity;
}

function medicationEventIdentity(value: string): string {
  return canonicalMedicationIdentity(
    medicationNameFromEventText(value).replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase());
}

function sameMedicationIdentity(left: string, right: string): boolean {
  return left === right;
}

/**
 * 病历里患者自己服用（或外用）过的药名（2026-10-17，甲方标准病历 7「自服“黄连上清丸”及“甲硝唑片”后疼痛略有缓解」）。
 * 只认「服药动作 + 药名」：动作前有否认（未服、否认服用）的小句不算；带引号的取引号里的名字，没有引号的取动作之后到
 *「后/等/治疗」或逗号为止、按「及/和/与/、/或」切开的各段。这里只抽字面上的名字，是不是药由调用方对着说明书目录核。
 */
/**
 * 按「、/及/和/与/或」拆药名列举。连词两边都得是能成名的段（各至少两个字）才拆：商品名里的「和」不是连词
 *（诺和龙、诺和锐、诺和灵——此前拆成「诺」「龙」，糖尿病人的胰岛素与降糖药一个也没取到，2026-10-19 M 集 TCMChat-495、TCM-SD-447858）。
 */
export function splitMedicationList(text: string): string[] {
  const pieces = String(text || "").split(/、|\/|\+|＋/u);
  return pieces.flatMap((piece) => {
    const out: string[] = [];
    let rest = piece;
    for (;;) {
      const hit = [...rest.matchAll(/以及|及|和|与|或/gu)].find((match) =>
        match.index != null && match.index >= 2 && rest.length - match.index - match[0].length >= 2);
      if (!hit || hit.index == null) break;
      out.push(rest.slice(0, hit.index));
      rest = rest.slice(hit.index + hit[0].length);
    }
    out.push(rest);
    return out;
  });
}

const SELF_MEDICATION_VERB = /(?:自行|自己|自购|在家)?(?:自服|服用|口服|吃|含服|外用|涂抹|服)/;
const SELF_MEDICATION_NEGATION = /(?:未|否认|没有|无|不曾|从未|未曾)[^，,。；;\n]{0,4}$/;
export function selfTakenMedicationMentions(text: string | null | undefined): string[] {
  const names: string[] = [];
  for (const clause of String(text || "").normalize("NFKC").split(/[，,。；;\n]+/)) {
    const verb = clause.match(SELF_MEDICATION_VERB);
    if (!verb || verb.index == null) continue;
    if (SELF_MEDICATION_NEGATION.test(clause.slice(0, verb.index))) continue;
    const rest = clause.slice(verb.index + verb[0].length);
    const quoted = [...rest.matchAll(/[“"「《]([^”"」》]{2,20})[”"」》]/g)].map((match) => match[1]);
    const parts = quoted.length > 0
      ? quoted
      : splitMedicationList(rest.split(/(?:后|等|治疗|以后|之后|无效|效果)/)[0] || "");
    for (const part of parts) {
      const name = part.replace(/^(?:了|过|用|药物|中成药|西药)/, "").replace(/\s+/g, "").replace(/\d.*$/, "").trim();
      if (name.length >= 2 && name.length <= 20 && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * 病历里写到的用药（2026-10-19，≥300 条验收注意事项一栏最大的一类：卡托普利、倍博特、拜新同、舒利迭、替米沙坦、
 * 左西替利嗪、「自用药物」……评审判「已自服药物没有相应一条」）。药名是开放的，给药动词是有限闭集：
 * 自服/现服/服用/口服/含服/吸入/外用/外涂/予(以)/给予/使用/应用/注射。动词后到「后/等/治疗/对症…」之前按顿号、及、和拆名。
 * 不收：否认/未用之后的（「未予重视」「未予治疗」）；同一句写了停用的；不像药名的（治疗方式、药物类别、「具体不详」）。
 * 只写了「自服药物」「自行服药」、没写药名的，单独标出（注意事项要提醒把在用的药告诉医生）。
 */
// 「接受」也是给药动词（「既往接受氨氯地平、缬沙坦、阿托伐他汀钙片及利尿药对症治疗」，M 集 RobustSDT-0544 在用西药一条没有）；只认中文药名（「接受PCI治疗」不算）。
// 「再次调整治疗方案为雷公藤多甙片+来氟米特」也是给药（M 集 TCM-SD-423906：现用的来氟米特取不到）。
const RECORDED_MEDICATION_VERB = /(?:自行|自己|自购|在家|长期|规律|平素|平时|目前|现在?)?(?:自服|自用|现服|服用|口服|含服|吸入|外用|外涂|涂抹|予以|给予|给与|予|静滴|注射|加用|改用|换用|接受|(?:调整|改)(?:治疗)?方案为|方案(?:调整|改)为)/u;
/** 动词后面跟的是检查（「给予头部CT示：…未见脑挫裂伤」）：不是在用药，这一小句不取药名（2026-10-19 验收主集 M-TCM-SD-439348）。 */
const RECORDED_EXAM_AFTER_VERB = /^[^，,。；;]{0,8}?(?:CT|MRI|X线|DR|彩超|超声|B超|造影|心电图|胃镜|肠镜|平扫|检查|化验|示[:：]?)/u;
const STOP_VERB = /停(?:用|服|药|止|掉|了)|已停|自停/u;
/** 下一句指回前一句的药说停了（「其后因不能耐受自行停用该药」）。 */
const STOPPED_PREVIOUS_MEDICATION = /(?:停用|停服|停)(?:该|此|上述)(?:药|药物)|(?:该|此|上述)(?:药|药物)[^，,。；;]{0,4}(?:已停|停用|停服)/u;
const RECORDED_MEDICATION_NEGATION = /(?:未|否认|没有|无|不曾|从未|未曾|拒绝)[^，,。；;\n]{0,3}$/u;
const RECORDED_MEDICATION_CUT = /(?:后|等|治疗|对症|以后|之后|无效|效果|控制|处理|缓解|改善|好转|口服|外用|静滴|输液|服用|至今|未见|现在|疼痛|一天|加量|减量|可达|达到|数剂(?=$)|[早晚](?=\d|$)|[（(?？:：]|\d|每[日天晚次]|qd|bid|tid|qn)/iu;
/** 截断词里表示「列举到此为止」的那些（用量数字、括注只截当前药名，后面的顿号项照收）。 */
const RECORDED_MEDICATION_LIST_END = /(?:后|等|治疗|对症|以后|之后|无效|效果|控制|处理|缓解|改善|好转|至今|未见|现在|疼痛|可达|达到)/u;
const NOT_A_MEDICATION_NAME = /治|疗|重视|进一步|规范|正规|特殊|系统|处理|休息|观察|手术|术$|理疗|针灸|推拿|输液|输血|营养|对症|消炎|止痛|化痰|止咳|止喘|平喘|降压|降糖|降脂|调脂|抗感染|抗凝|抗聚|溶栓|补液|具体|不详|不清|相关|上述|以上|药物|西药|中成药|中药|汤剂|汤药|膏方|验方|饮食|运动|检查|保守|^药$|^等$|查|示|诊断|就诊|收入|入院|监护|置入|放置|引流|切除|介入|支架|热敷|超声|常规|心电图|核磁|CT|静脉|症状|发作|破溃|帮助|剂量|热水器|中西|^液|^[抗调扩降抑护输]|^补[钾钙铁液]|引导|^(?:促进|增强|升高|保肾|利尿|改善|活血|清热|扶正)|法$/u;
// 「口服药物后血压降至正常，具体不详」「长期服用西药控制」也是没写药名的在用药（2026-10-19 M 集 MTCMB-20、RobustSDT-0512）。
const UNNAMED_SELF_MEDICATION = /(?:自服|自用|自行服用|自行服|自购)(?:了|过)?[^，,。；;\n]{0,6}药(?:物|品)?|(?:自行|自己)(?:服药|用药|吃药|买药)|服药(?:控制|治疗)|(?:口服|服用)(?:降压|降糖|降脂)?(?:西)?药(?:物)?(?=后|治疗|控制|$)/u;
/** 病历写着一直在服中药（「后患者一直口服中药治疗」）而没写方名：注意事项请患者把方子带给医生（验收主集 M-TCM-SD-486942）。 */
const ONGOING_UNNAMED_HERBAL = /(?:一直|长期|持续|规律|坚持|间断)(?:口服|服用|服)(?:中药|汤药|中草药)/u;

/**
 * 动词在药名后面、且后面跟的是用途或结果（「格列齐特1粒 bid口服降糖」「复方甘草酸苷片口服后症状稍减轻」）：药名取动词前面那一段——
 * 带剂型或带用量的才算（「患者口服后」不算）；同一句前面紧挨着、只写「（以）药名＋用量」的小句是同一串列举
 *（「近3月来以二甲双胍1粒 bid，格列齐特1粒 bid口服降糖」，2026-10-19 Claude 评审 M 集 TCM-SD-453850、TCM-SD-478843）。
 */
const POSTPOSED_ADMINISTRATION_VERB = /^(?:口服|服用|外用|外涂|吸入|含服)$/u;
const MEDICATION_DOSE_TAIL = /\s*\d+(?:\.\d+)?\s*(?:(?:mg|g|ug|μg|mcg|U|IU|ml)(?![a-z])|片|粒|丸|袋|支|单位|毫克|克)[^，,]*$/iu;
const MEDICATION_DOSE_AFTER_LEAD = /(?:以|用)\s*([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9-]{1,13}?)\s*\d+(?:\.\d+)?\s*(?:(?:mg|g|ug|μg|mcg|U|IU|ml)(?![a-z])|片|粒|丸|袋|支|单位|毫克|克)/iu;
const MEDICATION_DOSE_AT_START = /^\s*([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9-]{1,13}?)\s*\d+(?:\.\d+)?\s*(?:(?:mg|g|ug|μg|mcg|U|IU|ml)(?![a-z])|片|粒|丸|袋|支|单位|毫克|克)/iu;
function postposedVerbMedicationNames(clauses: readonly string[], index: number, verb: RegExpMatchArray): string[] {
  const core = verb[0].replace(/^(?:自行|自己|自购|在家|长期|规律|平素|平时|目前|现在?)/u, "");
  if (!POSTPOSED_ADMINISTRATION_VERB.test(core) || verb.index == null) return [];
  const lead = clauses[index].slice(0, verb.index).trim();
  const hasDose = MEDICATION_DOSE_TAIL.test(lead);
  const head = lead.replace(MEDICATION_DOSE_TAIL, "").replace(/^.*(?:以|用|予)(?=[\u4e00-\u9fffA-Za-z]{2,})/u, "");
  const hasForm = /(?:片|胶囊|颗粒|丸|散|口服液|合剂|糖浆|膏|贴|栓|滴剂|喷雾剂|气雾剂)$/u.test(head);
  const name = (hasDose || hasForm) ? cleanedMedicationNameCandidate(head) : "";
  if (!name || NOT_A_MEDICATION_NAME.test(name) || RECORDED_MEDICATION_NEGATION.test(lead.slice(0, Math.max(0, lead.indexOf(head))))) return [];
  const names = [name];
  for (let at = index - 1; at >= 0; at -= 1) {
    if (RECORDED_MEDICATION_VERB.test(clauses[at])) break;
    const hit = clauses[at].match(MEDICATION_DOSE_AFTER_LEAD) || clauses[at].match(MEDICATION_DOSE_AT_START);
    const earlier = hit ? cleanedMedicationNameCandidate(hit[1] || "") : "";
    if (!earlier || NOT_A_MEDICATION_NAME.test(earlier)) break;
    names.unshift(earlier);
  }
  return names;
}

export function recordedMedicationMentions(text: string | null | undefined): { names: string[]; given: string[]; unnamed: boolean; herbal: boolean } {
  const names: string[] = [];
  const given: string[] = [];
  let unnamed = false;
  let herbal = false;
  let previousSentenceNames: string[] = [];
  const source = String(text || "").normalize("NFKC");
  for (const sentence of source.split(/[。；;\n]+/u)) {
    // 下一句说「停用该药」：前一句取到的药都不算在用（2026-10-19 验收主集 M-TCM-SD-484941，吉非替尼）。
    if (STOPPED_PREVIOUS_MEDICATION.test(sentence)) {
      for (const name of previousSentenceNames) {
        names.splice(names.indexOf(name), 1);
        if (given.includes(name)) given.splice(given.indexOf(name), 1);
      }
    }
    const before = names.length;
    if (ONGOING_UNNAMED_HERBAL.test(sentence) && !/(?:未|否认|没有|无|不曾)[^，,。；;\n]{0,3}(?:一直|长期|口服|服用)/u.test(sentence)) herbal = true;
    // 同一句里写了停用（「其后因不能耐受自行停用该药」），这一句里停用那一小句及之前的药都不算在用。
    // 停要是动词：药名里的「停」（易蒙停）不算（验收主集 RobustSDT-single_0598，「外院曾予蒙脱石散、易蒙停」整句被当成已停）。
    // 只跳到停用那一小句为止，之后的照取（2026-10-19：住院病历整段只用逗号，「…后患者自停益赛普…今年7月…予艾拉莫德+雷公藤多苷+益赛普…
    // 再次予益赛普」整段被跳过，现用的益赛普取不到，M 集 TCM-SD-440006）。
    const sentenceClauses = sentence.split(/[，,]+/u);
    const lastStopClause = STOPPED_OR_PAST_MEDICATION.test(sentence)
      ? sentenceClauses.reduce((last, clause, index) => STOP_VERB.test(clause) ? index : last, -1) : -1;
    if (lastStopClause === sentenceClauses.length - 1) { previousSentenceNames = []; continue; }
    let listContinues = false;
    for (const [clauseIndex, clause] of sentenceClauses.entries()) {
      if (clauseIndex <= lastStopClause) continue;
      if (UNNAMED_SELF_MEDICATION.test(clause) && !/(?:未|否认|没有|无|不曾)[^，,。；;\n]{0,3}(?:自服|自用|自行|服药)/u.test(clause)) unnamed = true;
      // 用药列举用逗号接着写下去（「现规律服用依折麦布片一天1次，一次1片，阿司匹林100mg qd，可定5mg qn」）：
      // 紧跟在取到药名的小句后面、整句就是「药名＋用量」的，也是这一串里的药（2026-10-19 M 集 MTCMB-81）。
      const continued = listContinues && !RECORDED_MEDICATION_VERB.test(clause) ? clause.match(/^\s*([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9-]{1,13}?)\s*\d+(?:\.\d+)?\s*(?:(?:mg|g|ug|μg|mcg|U|IU|ml)(?![a-z])|片|粒|丸|袋|支|单位|毫克|克)/iu) : null;
      if (continued) {
        const name = continued[1].trim();
        // 用法里的「每日2片」「早1片」不是药名。
        if (!NOT_A_MEDICATION_NAME.test(name) && cleanedMedicationNameCandidate(name) && !names.includes(name)) names.push(name);
        continue;
      }
      if (listContinues && medicationContinuationOnly(clause)) continue;
      listContinues = false;
      const verb = clause.match(RECORDED_MEDICATION_VERB);
      if (!verb || verb.index == null) continue;
      if (RECORDED_MEDICATION_NEGATION.test(clause.slice(0, verb.index))) continue;
      const rest = clause.slice(verb.index + verb[0].length);
      if (RECORDED_EXAM_AFTER_VERB.test(rest)) continue;
      const clauseNamesBefore = names.length;
      // 动词后置（「盐酸左西替利嗪片口服」「强力湿痒膏外用」）：动词在句末时，药名在它前面。
      const before = !rest.trim() && /(?:口服|外用|外涂|吸入|含服)$/u.test(verb[0]) ? clause.slice(0, verb.index) : "";
      const quoted = [...rest.matchAll(/[“"「《]([^”"」》]{2,60})[”"」》]/gu)].map((match) => match[1]);
      const parts = splitMedicationList(quoted.length > 0 ? quoted.join("、") : before || rest);
      for (const part of parts) {
        // 列举到截断词（「后」「治疗」「（」…）为止：截断词之后的顿号项是别的内容（「予抗感染治疗后尿频、尿急」）。
        const cut = part.search(RECORDED_MEDICATION_CUT);
        const name = (cut >= 0 ? part.slice(0, cut) : part)
          .replace(/^.*(?:给予|给与|予以)/u, "")
          .replace(/^(?:长期|规律|平素|平时|自行|使用|应用|了|过|用|以|口服|服用|改用|换用|外擦|外搽|取|舌下含服|含)+/u, "")
          .replace(/[“”"「」《》)）]/gu, "").replace(/泵$/u, "").replace(/[可以的]$/u, "").replace(/\s+/gu, "").trim();
        const valid = name.length >= 2 && name.length <= 14 && !NOT_A_MEDICATION_NAME.test(name) &&
          (/接受/u.test(verb[0]) ? /^[\u4e00-\u9fff]{2,}/u.test(name) : /[\u4e00-\u9fff]{2,}|[A-Za-z]{3,}/u.test(name));
        // 前面已取到的药再出现（「予他克莫司加量为早2片晚1片，奥美沙坦1片bid」）也算这一串列举的开头，后面「药名＋用量」的小句照接（M 集 TCM-SD-463912）。
        if (valid) listContinues = true;
        if (valid && !names.includes(name)) {
          names.push(name);
          // 「予/给予」写的是医生给过的药，可能已经用完或停了：注意事项只请患者说明现在是否还在用。
          if (/予|接受/u.test(verb[0])) given.push(name);
        }
        if (cut >= 0 && RECORDED_MEDICATION_LIST_END.test(part.slice(cut, cut + 3))) break;
      }
      if (names.length === clauseNamesBefore) {
        for (const name of postposedVerbMedicationNames(sentenceClauses, clauseIndex, verb)) {
          if (!names.includes(name)) { names.push(name); listContinues = true; }
        }
      }
    }
    previousSentenceNames = names.slice(before);
  }
  return { names, given, unnamed: unnamed && names.length === 0, herbal: herbal && names.length === 0 };
}

/**
 * 病历里写了之后又停掉的药（「…口服吉非替尼治疗。其后因不能耐受自行停用该药。」）：药名所在句的下一句指回它说停了。
 * 注意事项「正在使用的药」一项按它排除——别的取名办法（正式给药词、剂型）各自看一句，看不到下一句。
 */
export function medicationStoppedInNextSentence(text: string, name: string): boolean {
  const sentences = String(text || "").normalize("NFKC").split(/[。；;\n]+/u);
  return sentences.some((sentence, index) => sentence.includes(name) && index + 1 < sentences.length &&
    STOPPED_PREVIOUS_MEDICATION.test(sentences[index + 1]) && !sentences.slice(index + 1).some((later) => later.includes(name)));
}

/**
 * 病历里这个药后来停了，或只在「曾…」的往事里出现过（2026-10-19 Claude 评审 M 集）：
 *  · 后面任一句在同一小句里写「停用/停服/停药/停止」这个药（「…后患者因持续血小板降低停用安罗替尼」隔了好几句；
 *    「予以停用阿帕替尼」），而再往后没有重新用上；
 *  · 写到它的每一句，它前面都是「曾接受/曾服用/既往曾…」，所在小句又没有「现/目前/仍/至今/一直/长期/规律/继续/正在」
 *   （「既往曾接受醋酸泼尼松（…口服）及α骨化醇片（…）治疗」——逗号把「曾」和后一个药隔开了，按小句看不到）。
 */
// 「曾换用/曾改用/曾试用」也是往事（H 集 H-tri-5786「曾换用齐拉西酮、丁二酸洛沙平、喹硫平等药物…疗效不明显」写成了正在服用，2026-10-19）。
const PAST_MEDICATION_CUE = /曾(?:经)?(?:接受|服用|口服|予|用|使用|应用|多次|间断|换用|改用|试用|加用)|既往曾/u;
const CURRENT_MEDICATION_CUE = /现|目前|仍|至今|一直|长期|规律|继续|正在|近期|近来/u;
const RESTART_MEDICATION_CUE = /加用|再次|重新|恢复|又(?:开始)?|继续/u;
/**
 * 紧跟在用药小句后面、说此后没再用的小句（「自行外用“藏药五毒”无明显效果，未再重视」，2026-10-19 Claude 评审 M 集 TCM-SD-488395：
 * 2020 年外用过一次的藏药写成了「正在外用」）。构词式闭集：未再/不再 + 用药、治疗或就诊的动词。
 */
const NOT_CONTINUED_AFTER = /^(?:后|此后|之后|遂)?(?:未再|不再)(?:使用|用药|服药|服用|外用|用|重视|诊治|就诊|治疗|复诊)/u;
function medicationMentionClauses(text: string, name: string) {
  // 按小句排成一列（病历常一整段只用逗号）：停用那一小句可能和用药那一小句在同一个长句里。
  const clauses = String(text || "").normalize("NFKC").split(/[。；;\n]+/u).flatMap((sentence, sentenceIndex) => {
    let offset = 0;
    return sentence.split(/[，,]+/u).map((clause) => {
      const before = sentence.slice(0, offset);
      offset += clause.length + 1;
      return { clause, before, sentenceIndex };
    });
  });
  return { clauses, mentions: clauses.map((item, index) => ({ ...item, index })).filter(({ clause }) => name && clause.includes(name)) };
}

/** 病历写着这个药后来停了（同一小句写停用而此后没有重新用上，或紧跟一小句「未再…」）。 */
export function medicationStopped(text: string, name: string): boolean {
  if (!name) return false;
  const { clauses, mentions } = medicationMentionClauses(text, name);
  if (mentions.length === 0) return false;
  const stoppedIn = (clause: string) => STOP_VERB.test(clause) && !/(?:未|没有|不曾|未曾|不|无|勿)(?:自行|擅自)?停/u.test(clause) && !RESTART_MEDICATION_CUE.test(clause);
  const lastStop = mentions.filter(({ clause }) => stoppedIn(clause)).at(-1);
  if (lastStop && !mentions.some(({ clause, index }) => index > lastStop.index && RESTART_MEDICATION_CUE.test(clause))) return true;
  const last = mentions.at(-1)!;
  const next = clauses[last.index + 1];
  return Boolean(next && next.sentenceIndex === last.sentenceIndex && NOT_CONTINUED_AFTER.test(next.clause.trim()));
}

/**
 * 写到这个药的每一句，它前面都是「曾…/既往曾…」、所在小句又没有「现/目前/仍…」：返回 "past"（带「既往」，过去的事）
 * 或 "ever"（只有「曾」：这次发病里用过、现在是否还在用不知道——「外院曾予蒙脱石散、易蒙停等药物治疗，症状未能缓解，遂来就诊」，
 * M 集 RobustSDT-0598 评审要求写是否续服）。不是只在往事里出现的返回 undefined。
 */
export function medicationOnlyPastMentions(text: string, name: string): "past" | "ever" | undefined {
  if (!name) return undefined;
  const { mentions } = medicationMentionClauses(text, name);
  if (mentions.length === 0) return undefined;
  const cues = mentions.map(({ clause, before }) => {
    const lead = before + clause.slice(0, clause.indexOf(name));
    return PAST_MEDICATION_CUE.test(lead) && !CURRENT_MEDICATION_CUE.test(clause) ? lead.match(PAST_MEDICATION_CUE)![0] : undefined;
  });
  if (cues.some((cue) => !cue)) return undefined;
  return cues.some((cue) => /既往/u.test(cue!)) || mentions.some(({ before }) => /既往(?:曾|接受)/u.test(before.slice(-12))) ? "past" : "ever";
}

export function medicationStoppedOrOnlyPast(text: string, name: string): boolean {
  return medicationStopped(text, name) || Boolean(medicationOnlyPastMentions(text, name));
}

/**
 * 现病史里用药的时间线（2026-10-19 Claude 评审 M 集注意事项一栏：住院病历按年份写了好几轮用药，「正在服用」列的是 2018 年换掉的缬沙坦、
 * 2009–2013 年的旧药，现用的奥美沙坦、益赛普反而漏了——TCM-SD-463912、480964、440006、478843）。
 * 小句开头的时间点（「2018年8月」「2020-4-1」「后于2017年5月」「10天前」「今年6月」「近3月来」，构词式闭集）把现病史分成几段，药名落在哪段就属哪段：
 *  · 后一段重申用药方案——与前一个有药的段有共同的药、且写到共同药的小句不是「再次/加用/联合」这类追加（「予他克莫司加量…，奥美沙坦1片bid」
 *    接着上一段的他克莫司），或写明「调整为/改为/改用/换用/更换/仅口服」（同一句先写了停哪个药的按停药算，不算换方案）——
 *    此前出现过、此后再没提到的药都算换掉了（"superseded"）；
 *  · 两段时间点是同一种写法（都是公历年份，或都是「N年前」）、相隔一年以上、此后再没提到的药，同样算换掉了；那几小句写着
 *   「长期/规律/一直/间断/坚持/维持…」的改为请患者说明现在是否还在用（"ask"）；
 *  · 落在最后一个有药的段里：这一段重申方案、或这个药前面的段也出现过的算正在用（"current"，即便写的是「予」）；否则 "latest"。
 *  「上述药物」一类说法算再提到一次前一个有药的段里的药。只管传入的这段文字（调用方传现病史；既往史里的长期用药不按它判）。
 */
export type MedicationTimelineStatus = "current" | "latest" | "ask" | "superseded";
const TIMELINE_ANCHOR = /^[^\d，,。；;]{0,6}?(?:于|在|至|自|从)?(?:约)?(?:((?:19|20)\d{2})(?:年|[-./](?=\d))(?:(\d{1,2})(?:月|[-./]|(?!\d)))?|(\d+(?:\.\d+)?|[一二两三四五六七八九十半]+)(?:余|多)?(?:个)?(年|月|周|天|日)(?:余|多)?(?:前|以前)|(今年|去年|前年)|近(?:\d+|[一二两三四五六七八九十半]+)?(?:余|多)?(?:个)?(?:年|月|周|天|日)(?:来|以来))/u;
const REGIMEN_REPLACEMENT = /调整为|改为|改用|改服|换用|换为|改成|更换|(?:调整|改)(?:治疗)?方案为|方案(?:调整|改)为|仅(?:口服|服用|用|予|使用)|只(?:口服|服用|用)/u;
const REGIMEN_ADDITION = /再次|加用|联合|另加|重新|恢复|又/u;
const RECALLED_MEDICATIONS = /(?:上述|以上)[一-鿿]{0,4}?(?:药物|药)/u;
const ONGOING_MEDICATION_CUE = /长期|规律|一直|间断|坚持|维持|持续|至今|仍|继续/u;
const INJECTION_ADMINISTRATION = /静滴|静脉滴注|静推|静注|肌注|肌内注射|输液/u;
function chineseCount(value: string): number {
  if (/^\d/u.test(value)) return Number(value);
  if (value === "半") return 0.5;
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (!value.includes("十")) return digits[value] ?? NaN;
  const [tens, ones] = value.split("十");
  return (tens ? digits[tens] ?? NaN : 1) * 10 + (ones ? digits[ones] ?? 0 : 0);
}
function timelineAnchor(clause: string): { kind: "abs" | "rel"; value: number } | undefined {
  const hit = clause.match(TIMELINE_ANCHOR);
  if (!hit) return undefined;
  if (hit[1]) return { kind: "abs", value: Number(hit[1]) + (hit[2] ? (Number(hit[2]) - 1) / 12 : 0) };
  if (hit[3] && hit[4]) {
    const count = chineseCount(hit[3]);
    const perYear: Record<string, number> = { 年: 1, 月: 12, 周: 52, 天: 365, 日: 365 };
    return Number.isFinite(count) ? { kind: "rel", value: count / perYear[hit[4]] } : undefined;
  }
  if (hit[5]) return { kind: "rel", value: hit[5] === "今年" ? 0 : hit[5] === "去年" ? 1 : 2 };
  return { kind: "rel", value: 0 };
}
export function medicationTimelineStatuses(text: string, names: readonly string[]): Map<string, MedicationTimelineStatus> {
  const result = new Map<string, MedicationTimelineStatus>();
  const source = String(text || "").normalize("NFKC");
  const wanted = [...new Set(names.filter((name) => name && source.includes(name)))];
  if (wanted.length === 0) return result;
  const clauses: Array<{ text: string; sentence: number; period: number }> = [];
  const anchors: Array<{ kind: "abs" | "rel"; value: number } | undefined> = [undefined];
  source.split(/[。；;\n]+/u).forEach((sentence, sentenceIndex) => {
    for (const raw of sentence.split(/[，,]+/u)) {
      const clause = raw.trim();
      if (!clause) continue;
      const anchor = timelineAnchor(clause);
      if (anchor) anchors.push(anchor);
      clauses.push({ text: clause, sentence: sentenceIndex, period: anchors.length - 1 });
    }
  });
  const mentions = new Map<string, number[]>(wanted.map((name) => [name, []]));
  clauses.forEach((clause, index) => {
    for (const name of wanted) if (clause.text.includes(name)) mentions.get(name)!.push(index);
  });
  // 「服用上述安眠药物也仍无法入睡」：算再提到一次前一个有药的段里的药（M 集 BEST4SDT-174）。
  clauses.forEach((clause, index) => {
    if (!RECALLED_MEDICATIONS.test(clause.text) || wanted.some((name) => clause.text.includes(name))) return;
    const earlier = wanted.flatMap((name) => mentions.get(name)!.filter((at) => at < index));
    if (earlier.length === 0) return;
    const period = clauses[Math.max(...earlier)].period;
    for (const name of wanted) {
      if (mentions.get(name)!.some((at) => at < index && clauses[at].period === period)) mentions.get(name)!.push(index);
    }
  });
  for (const list of mentions.values()) list.sort((left, right) => left - right);
  const periodsOf = (name: string) => new Set(mentions.get(name)!.map((at) => clauses[at].period));
  const medPeriods = [...new Set([...mentions.values()].flat().map((at) => clauses[at].period))].sort((left, right) => left - right);
  const superseded = new Set<string>();
  const supersedeBefore = (index: number) => {
    for (const name of wanted) {
      const list = mentions.get(name)!;
      if (list.length > 0 && list.every((at) => at < index)) superseded.add(name);
    }
  };
  const restating = new Set<number>();
  medPeriods.forEach((period, order) => {
    if (order === 0) return;
    const previous = medPeriods[order - 1];
    const shared = wanted.filter((name) => periodsOf(name).has(previous) && periodsOf(name).has(period));
    const firstIndex = clauses.findIndex((clause, index) => clause.period === period && wanted.some((name) => mentions.get(name)!.includes(index)));
    // 只看写了给药动词的小句（「现为求进一步益赛普治疗由门诊收入我科」只是提到，不是重申方案）。
    // 写停药的小句（「予以停用阿帕替尼」）也不是重申方案（M 集 TCMChat-test-482：卡瑞丽珠单抗因此被当成换掉了）。
    const regimenClauses = shared.flatMap((name) => mentions.get(name)!.filter((at) => clauses[at].period === period &&
      RECORDED_MEDICATION_VERB.test(clauses[at].text) && !STOP_VERB.test(clauses[at].text)));
    if (regimenClauses.length > 0 && !regimenClauses.every((at) => REGIMEN_ADDITION.test(clauses[at].text))) {
      restating.add(period);
      supersedeBefore(firstIndex);
    }
  });
  clauses.forEach((clause, index) => {
    if (!REGIMEN_REPLACEMENT.test(clause.text)) return;
    // 「停用环磷酰胺，改用利妥昔单抗」：同一小句或紧挨着的前一小句写了停哪个药，按停药算（隔得远的停药说的是别的事）。
    const stoppedFirst = clauses.some((other, at) => at <= index && at >= index - 1 && other.sentence === clause.sentence && STOP_VERB.test(other.text));
    if (stoppedFirst) return;
    restating.add(clause.period);
    supersedeBefore(index);
  });
  const latest = medPeriods.at(-1)!;
  const latestAnchor = anchors[latest];
  // 只在住院静滴、肌注里出现的药（「分别予地塞米松，青霉素静滴3天治疗后症状明显改善」，M 集 TCM-SD-482122）：用完即止，最多请患者说明是否还在用。
  const injectionOnly = (name: string) => mentions.get(name)!.every((at) => INJECTION_ADMINISTRATION.test(clauses[at].text) ||
    INJECTION_ADMINISTRATION.test(clauses[at + 1]?.sentence === clauses[at].sentence ? clauses[at + 1].text : ""));
  for (const name of wanted) {
    const list = mentions.get(name)!;
    if (superseded.has(name)) { result.set(name, "superseded"); continue; }
    const lastPeriod = clauses[list.at(-1)!].period;
    if (lastPeriod === latest) {
      result.set(name, injectionOnly(name) ? "ask" : restating.has(latest) || periodsOf(name).size >= 2 ? "current" : "latest");
      continue;
    }
    const anchor = anchors[lastPeriod];
    if (!anchor || !latestAnchor || anchor.kind !== latestAnchor.kind) continue;
    const gap = anchor.kind === "abs" ? latestAnchor.value - anchor.value : anchor.value - latestAnchor.value;
    if (gap < 1) continue;
    result.set(name, list.some((at) => ONGOING_MEDICATION_CUE.test(clauses[at].text)) ? "ask" : "superseded");
  }
  return result;
}

/** 病历肯定写着饮酒/** 病历肯定写着饮酒（「饮酒30年」「嗜酒」「每日饮白酒」）；「无烟酒嗜好」「否认饮酒」「已戒酒」不算。 */
// 逐小句判（2026-10-19 Claude 评审 M 集 MTCMB-21）：「饮酒30年，以饮用白酒为主，平均5两／日，未戒酒，已经减量」整句因含「戒酒」二字被当成已戒，
// 每日半斤白酒的患者注意事项没有戒酒一条；「每天6瓶啤酒」「白酒半斤」没有「饮」字也是饮酒（数量＋酒类，构词式）。
// 同一句另有「已戒酒/戒酒2年」才算戒了——「未戒酒/没有戒酒」不是。
const ALCOHOL_USE = /(?:饮|喝|嗜|酗)酒|饮(?:用)?[白啤黄红米]酒|[白啤黄红米]酒[^，,。；;]{0,8}(?:两|斤|瓶|杯|听|罐|碗|ml|毫升|克|g|L)|(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半])\s*(?:瓶|杯|听|罐|两|斤|碗)[^，,。；;]{0,2}[白啤黄红米]酒/u;
const ALCOHOL_DENIED_CLAUSE = /不饮|无饮酒|无烟酒|否认|从不(?:饮|喝)|不喝/u;
const ALCOHOL_QUIT = /(?<![未没不无嘱劝议])(?:已经?|现已)?戒(?:烟)?酒(?!史)|已戒/u;
export function recordsAlcoholUse(text: string): boolean {
  return affirmedClinicalSourceClauses(text).some((sentence) => {
    const clauses = sentence.split(/[，,]+/u);
    if (clauses.some((clause) => ALCOHOL_QUIT.test(clause) && !/(?:未|没有|没|不|无)(?:能)?戒/u.test(clause))) return false;
    return clauses.some((clause) => ALCOHOL_USE.test(clause) && !ALCOHOL_DENIED_CLAUSE.test(clause));
  });
}

/** 病历里写自行配制、泡酒、偏方土方服药的那一句（有限闭集的动作词）；否认、未曾的不算（2026-10-19 留出集 S190）。 */
const SELF_PREPARATION = /(?:自行|自己|自制|自配|自采|偏方|土方|民间)[^。；;\n]{0,16}(?:泡酒|泡服|煎服|煎水|研末|冲服|服用|饮用|外敷)|药酒/u;
const SELF_PREPARATION_DENIED = /(?:否认|未|没有|无)[^，,。；;]{0,4}(?:自行|自制|服用|饮用)/u;
export function selfPreparedMedicationSentence(sentence: string): boolean {
  return SELF_PREPARATION.test(sentence) && !SELF_PREPARATION_DENIED.test(sentence);
}

/**
 * 病历写着患者自己停了长期用药（「高血压病史8年，1个月前自行停药」「自行停服降糖药」）：返回同一句里的慢性病名与药名。
 * 否认、遵医嘱停药的不算（2026-10-19 留出集 S178：高血压急症患者一个月前自行停降压药，复诊计划与调护都没提规律服药）。
 */
const SELF_DISCONTINUED = /(?:自行|擅自|自己)(?:停(?:用|服|药)|减(?:量|药))|自停(?:药|服)?|(?:未|没有|不)(?:规律|按时|坚持)(?:服药|用药|服用)/u;
const SELF_DISCONTINUED_CONDITION = /高血压|糖尿病|冠心病|心房颤动|房颤|心力衰竭|心衰|甲状腺功能减退|甲减|甲状腺功能亢进|甲亢|癫痫|哮喘|慢阻肺|抑郁|精神分裂|高脂血症|痛风/u;
export function selfDiscontinuedMedication(text: string): { condition?: string; names: string[]; irregular?: true } | undefined {
  const source = String(text || "").normalize("NFKC");
  for (const sentence of source.split(/[。；;\n]+/u)) {
    // 一句里可能有好几处（住院病历整段只用逗号）：逐处看，只看这一处所在小句与它前面三小句（2026-10-19 M 集 TCM-SD-440006、488395）。
    for (const hit of sentence.matchAll(new RegExp(SELF_DISCONTINUED.source, "gu"))) {
      if (hit.index == null) continue;
      const clauseStart = Math.max(sentence.lastIndexOf("，", hit.index - 1), sentence.lastIndexOf(",", hit.index - 1)) + 1;
      const clauseEnd = sentence.slice(hit.index).search(/[，,]/u);
      const hitClause = sentence.slice(clauseStart, clauseEnd < 0 ? sentence.length : hit.index + clauseEnd);
      const before = sentence.slice(0, clauseStart).split(/[，,]/u).filter(Boolean);
      const window = [...before.slice(-3), hitClause].join("，");
      // 因不能耐受、不良反应、过敏或无效而停的不在此列：那是该由医生换药的情形，不能写「规律服用」（验收主集吉非替尼一例）。
      if (/否认|遵医嘱|医生(?:嘱|建议)|在医生指导下|耐受|副作用|不良反应|过敏|无效/u.test([before.at(-1) || "", hitClause].join("，"))) continue;
      // 停的药写在后面（「自停益赛普」）就取它；没写（「后自行停药」「未规律服药」）取前面三小句里写到的药。
      const object = cleanedMedicationNameCandidate(sentence.slice(hit.index + hit[0].length).split(/[，,]/u)[0] || "");
      // 引号里的也可能是诊断（「“频发房性早搏”，收入住院治疗」）：按药名候选收一道。
      const quotedNames = [...window.matchAll(/[“"「]([^”"」]{2,20})[”"」]/gu)].map((match) => cleanedMedicationNameCandidate(match[1]))
        .filter((name) => name && !NOT_A_MEDICATION_NAME.test(name));
      const names = object && !NOT_A_MEDICATION_NAME.test(object) ? [object]
        : quotedNames.length > 0 ? quotedNames
          : recordedMedicationMentions(before.slice(-3).join("，")).names.map((name) => cleanedMedicationNameCandidate(name)).filter((name) => name && !NOT_A_MEDICATION_NAME.test(name));
      // 后来又用上了的（「自停益赛普…今年7月…再次予益赛普」）不是现在的情况。
      const later = source.slice(source.indexOf(sentence) + (clauseEnd < 0 ? sentence.length : hit.index + clauseEnd));
      if (names.length > 0 && names.every((name) => later.includes(name))) continue;
      const generic = window.match(/降压药|降糖药|胰岛素|抗凝药|抗癫痫药|抗抑郁药/u)?.[0];
      const condition = window.match(SELF_DISCONTINUED_CONDITION)?.[0];
      // 只认能说清停的是治什么慢性病的药：附近写了慢性病、药名或药类。
      if (!condition && !generic && names.length === 0) continue;
      // 「不规律服用」不是停药（2026-10-19 M 集 MTCMB-87：「不规律服用“稳心颗粒”」被写成「您之前自行停用了…」）；
      // 后面紧接着又写了「自行停药」的按停药算。
      const irregular = /(?:未|没有|不)(?:规律|按时|坚持)/u.test(hit[0]) && !/(?:自行|擅自|自己)(?:停(?:用|服|药)|减(?:量|药))|自停/u.test(sentence.slice(hit.index, hit.index + 24));
      return { condition, names: generic && names.length === 0 ? [generic] : names.slice(0, 3), ...(irregular ? { irregular: true } : {}) };
    }
  }
  return undefined;
}

/**
 * 病历只写了药类、没写药名的激素与免疫抑制剂治疗（「经予免疫抑制剂及激素治疗后，肉眼血尿及尿蛋白改善不明显」，
 * 2026-10-19 Claude 评审 M 集 RobustSDT-0530：注意事项没提是否仍在用、不可自行停用）。闭集：激素、糖皮质激素、免疫抑制剂；
 * 要跟在给药动词之后；否认、拒绝的不算（「因拒绝激素治疗」），写了停用的那一句不算，性激素、甲状腺激素、「激素水平」不算。
 */
const SYSTEMIC_THERAPY_CLASS = /(?<![性腺长])(?:糖皮质)?激素(?!水平|检查|测定|六项|替代)|免疫抑制剂/gu;
export function recordedSystemicTherapyClasses(text: string | null | undefined): string[] {
  const found: string[] = [];
  for (const sentence of String(text || "").normalize("NFKC").split(/[。；;\n]+/u)) {
    if (STOP_VERB.test(sentence)) continue;
    for (const clause of sentence.split(/[，,]+/u)) {
      const verb = clause.match(/予以|给予|给与|予|接受|使用|应用|服用|口服|静滴/u);
      if (!verb || verb.index == null) continue;
      const lead = clause.slice(0, verb.index);
      if (RECORDED_MEDICATION_NEGATION.test(lead) || /拒绝|否认|未/u.test(lead)) continue;
      for (const match of clause.slice(verb.index + verb[0].length).matchAll(SYSTEMIC_THERAPY_CLASS)) {
        const label = match[0].includes("免疫") ? "免疫抑制剂" : "激素";
        if (!found.includes(label)) found.push(label);
      }
    }
  }
  return found;
}

/**
 * 病历写着的行动受限（拄拐、助行器、轮椅、卧床、行走困难、偏瘫…，闭集）：返回病历里的那个说法。运动保健要按它写
 *（2026-10-19 甲方标准病历 5：78 岁股骨骨折术后「现可拄拐缓慢行走」，运动写「以散步、八段锦为主」）。否认的不算。
 */
const MOBILITY_LIMITATION = /拄拐|扶拐|助行器|轮椅|卧床|长期卧床|行走不便|行动不便|行走困难|步行困难|跛行|偏瘫|截瘫|不能行走|不能下床|下肢无力/u;
export function recordedMobilityLimitation(text: string): string | undefined {
  for (const clause of affirmedClinicalSourceClauses(String(text || ""))) {
    const hit = clause.match(MOBILITY_LIMITATION);
    if (hit && hit.index != null && !/(?:否认|无|没有|未)[^，,。；;]{0,3}$/u.test(clause.slice(0, hit.index))) return hit[0];
  }
  return undefined;
}

const FORMAL_ADMINISTRATION_VERB = /(?:服用|口服|皮下注射|静脉注射|肌内注射|注射|吸入|含服)/u;
const STOPPED_OR_PAST_MEDICATION = /(?:曾|既往|此前|以前|已停|停用|停药|自行停|未再|不再)/u;
const GENERIC_MEDICATION_WORD = /^(?:中|西|汤|成|草)?药(?:物|品)?$|^中成药$|^降[压糖脂]药$/u;

/** 跟在正式给药词后面、当前在用的药名（只用于「正在服用的药」这一条注意事项）。 */
/**
 * 从病历里取出来的药名候选再收一道（2026-10-19 Claude 评审 M 集注意事项一栏）：取名的三条路各自切词，切出了
 *「控制」「依折麦布片一天」「α骨化醇片(」「西替利嗪片抗过敏)」「包括甲泼尼龙」「qd+缬沙坦」「bid抑制免疫」「数月」
 *「二甲双胍早」「安罗替尼抗血管生成」「靶向药物出现血压升高」，原样进了「正在服用的…请告知医生」。
 * 这里只做构词式的清理：去掉前面的引导词与用法缩写，在用量、括注、用途短语处截断，时间量词、药物类别、
 * 治疗方式不算药名。返回空串表示这不是一个药名。
 */
const MEDICATION_CANDIDATE_LEAD = /^(?:[+＋、，,\s]|qd|bid|tid|qid|qn|qod|prn|po|iv|ih|im|st|药物包括|用药包括|包括|药物有|药物为|药物|西药|中成药|中药|了|用|以|予|给与|给予|予以|口服|服用|使用|应用|加用|改用|继续|规律|长期|一直|现|自服|自行|(?:降(?:压|糖|脂)|抗(?:凝|血小板|生素|病毒|菌|过敏)|止痛|镇痛)药(?:物)?)+/iu;
const MEDICATION_CANDIDATE_TAIL = /(?<![A-Za-z])\d|[（(\[【“”"「」《》)）\]】?？:：]|[早晚中](?=$|\d)|一[天日次]|每[日天晚次周]|(?:qd|bid|tid|qid|qn|qod|prn|po|iv|ih|im)(?![a-z])|(?<=[\u4e00-\u9fffA-Za-z]{2})(?:抗(?:过敏|感染|血管|凝|血小板|病毒|炎|肿瘤|癫痫|抑郁|焦虑|心律|类风湿)|降(?:压|糖|脂|酶|尿酸)|控制|治疗|对症|保肝|护胃|抑制|调节|改善|预防|止(?:痛|咳|泻|吐|血)|出现|后|等|至今|效果|无效|无明显|好转|可缓解|未缓解|缓解|未见|不显|欠佳|可达|达到|外用|外涂|外敷|口服|吸入)/iu;
const NOT_MEDICATION_CANDIDATE = /^控制|^[\u4e00-\u9fff]{1,6}类|中成药|[哪何]|腧穴|穴位|不能|无法|酒精|^(?:止血|止泻|止吐|消炎|退热|退烧|感冒|安眠|镇静|助眠|促消化|升白|清热解表|消导破瘀|活血化瘀)(?:药物?|治疗)?$|^(?:外敷|外用)?(?:药膏|膏药|药水)$|^(?:[数几多半两一二三四五六七八九十百\d]+)(?:个)?(?:月|天|日|年|周|次|剂|疗程|小时)|^(?:靶向|激素|抗生素|抗菌|降压|降糖|降脂|止痛|镇痛|中西|保肝|护胃|营养|免疫)(?:药物?|治疗)?$|^(?:中|西|汤|成|草)?药(?:物|品)?$|病$|症$|炎$|早搏$|综合征$|衰竭$|不全$|状态$|^(?:好转|缓解|改善|减轻|加重|无效|有效|效可|效差|稍减轻|稍缓解)$/u;
export function cleanedMedicationNameCandidate(raw: string): string {
  let name = String(raw || "").normalize("NFKC").replace(/\s+/gu, "");
  let previous = "";
  while (name && name !== previous) {
    previous = name;
    name = name.replace(MEDICATION_CANDIDATE_LEAD, "");
  }
  // 「通络止痛类中成药」「降压类药物」：类别说法，截断之前就认（截断会剩下「通络」）。
  if (/^[\u4e00-\u9fff]{1,6}类(?:中成)?(?:药|制剂)/u.test(name)) return "";
  const cut = name.search(MEDICATION_CANDIDATE_TAIL);
  if (cut >= 0) name = name.slice(0, cut);
  name = name.replace(/[^\p{L}\p{N}-]+$/u, "").replace(/^[^\p{L}\p{N}]+/u, "");
  if (name.length < 2 || name.length > 14 || !/[\u4e00-\u9fff]{2,}|[A-Za-z]{3,}/u.test(name)) return "";
  // 带成品剂型的是具体药品（止咳糖浆、消炎利胆片），不按「止咳/消炎」这类治疗说法排除。
  if (/(?:片|胶囊|颗粒|丸|散|糖浆|口服液|注射液|贴|膏|水|酊|合剂|滴剂|喷雾剂|气雾剂|栓)$/u.test(name) && name.length >= 3 && !/[哪何]|不能|无法|酒精|^(?:外敷|外用)?(?:药膏|膏药|药水)$/u.test(name)) return name;
  if (NOT_A_MEDICATION_NAME.test(name) || NOT_MEDICATION_CANDIDATE.test(name) || GENERIC_MEDICATION_WORD.test(name)) return "";
  return name;
}

export function formallyAdministeredMedicationMentions(text: string): string[] {
  return String(text || "").normalize("NFKC").split(/[，,。；;\n]+/u).flatMap((clause) => {
    if (!FORMAL_ADMINISTRATION_VERB.test(clause) || STOPPED_OR_PAST_MEDICATION.test(clause)) return [];
    return selfTakenMedicationMentions(clause).filter((name) => !GENERIC_MEDICATION_WORD.test(name) && /[\u4e00-\u9fffA-Za-z]{2,}/u.test(name));
  });
}

export function affirmedCurrentMedicationText(value: string | null | undefined): string | undefined {
  const normalized = value
    ? normalizedClinicalText(value).replace(new RegExp(`后\\s*(?=${MEDICATION_RESTART_CUE.source})`, "g"), "，")
    : "";
  if (!normalized) return undefined;
  const activeEvents: ActiveMedicationEvent[] = [];
  let scopedEvents: ActiveMedicationEvent[] = [];
  let listContinuation = false;
  const upsert = (text: string): ActiveMedicationEvent | undefined => {
    const identity = medicationEventIdentity(text);
    if (!identity) return undefined;
    const existing = activeEvents.findIndex((event) => sameMedicationIdentity(event.identity, identity));
    if (existing >= 0) activeEvents.splice(existing, 1);
    const event = { identity, text };
    activeEvents.push(event);
    return event;
  };
  const removeScoped = (events: ActiveMedicationEvent[]) => {
    for (const event of events) {
      for (let index = activeEvents.length - 1; index >= 0; index -= 1) {
        if (sameMedicationIdentity(activeEvents[index].identity, event.identity)) activeEvents.splice(index, 1);
      }
    }
  };
  for (const sentence of normalized.split(/[。；;\n]+/).map((item) => item.trim()).filter(Boolean)) {
    const sentenceKeepsHistoricalMedicationCurrent = MEDICATION_CURRENT_CONTINUATION.test(sentence);
    const sentenceHasScopedEvent = /(?:前者|后者|两者|二者|均|都|全部|上述(?:药物|用药)?)[^。；;\n]{0,10}(?:停用|停服|停药|服用|口服|使用)/.test(sentence);
    // Keep the Chinese list delimiter inside a clause so "否认A、B" retains one negation scope.
    for (const rawClause of sentence.split(/[，,]+/).map((item) => item.trim()).filter(Boolean)) {
      const clause = rawClause.replace(DISCOURSE_PREFIX, "").trim();
      if (medicationContinuationOnly(clause)) {
        const previous = activeEvents.at(-1);
        if (previous) previous.text += `，${clause}`;
        continue;
      }

      const negatedStop = clause.match(NEGATED_MEDICATION_STOP_EVENT);
      if (negatedStop) {
        const refersToAll = MEDICATION_ALL_REFERENT.test(clause);
        const refersToLast = MEDICATION_LAST_REFERENT.test(clause);
        const refersToFirst = MEDICATION_FIRST_REFERENT.test(clause);
        const referred = refersToAll
          ? scopedEvents
          : refersToLast
            ? scopedEvents.slice(-1)
            : refersToFirst
              ? scopedEvents.slice(0, 1)
              : [];
        if (referred.length > 0) {
          for (const event of referred) upsert(event.text);
          continue;
        }
        const residual = clause.replace(negatedStop[0], "").replace(/^(?:从|至今|迄今|暂时|一直)\s*/, "").replace(/过\s*$/, "").trim();
        if (!medicationEventIdentity(residual)) continue;
        const activeClause = clause.replace(negatedStop[0], "仍在服用");
        const event = upsert(activeClause.replace(/^(?:从|暂时)\s*/, ""));
        if (event) scopedEvents = [event];
        continue;
      }

      const stop = clause.match(MEDICATION_STOP_EVENT);
      if (stop) {
        const refersToAll = MEDICATION_ALL_REFERENT.test(clause);
        const refersToLast = MEDICATION_LAST_REFERENT.test(clause);
        const refersToFirst = MEDICATION_FIRST_REFERENT.test(clause);
        const referred = refersToAll
          ? scopedEvents
          : refersToLast
            ? scopedEvents.slice(-1)
            : refersToFirst
              ? scopedEvents.slice(0, 1)
              : [];
        if (referred.length > 0) {
          removeScoped(referred);
          continue;
        }
        const residual = clause
        .replace(stop[0], "")
        .replace(/(?:\d+|[一二两三四五六七八九十半]+)\s*(?:天|日|周|月|年)前/g, "")
        .replace(/后\s*$/, "")
        .replace(/^(?:此前|之前|当时|现时|目前|当前|现在|后来|之后|随后|后|药物|用药)?\s*/, "")
        .replace(/了\s*$/, "")
        .trim();
        const stoppedIdentity = medicationEventIdentity(residual.replace(/^(?:前者|后者|第一种|第二种|前一种|后一种|两者|二者|均|都|全部)\s*/, ""));
        if (stoppedIdentity) {
          removeScoped([{ identity: stoppedIdentity, text: residual }]);
        } else {
          activeEvents.pop();
        }
        continue;
      }

      if (clinicalClausePolarity(clause) !== "affirmed") continue;
      if (
        MEDICATION_HISTORY_ONLY_PREFIX.test(clause) &&
        !MEDICATION_CURRENT_TRANSITION_CUE.test(clause) &&
        !sentenceKeepsHistoricalMedicationCurrent
      ) continue;

      const normalizedClause = clause.replace(/^(?:今日|今天)\s*(?=(?:重新(?:启用|服用)|再次(?:启用|服用)|新启用|新开|启用|加用|改用|恢复服用|开始(?:服用|口服|使用)))/, "");
      const declaresList = MEDICATION_LIST_DECLARATION.test(normalizedClause);
      const clauseHasActiveCue = MEDICATION_ACTIVE_CUE.test(normalizedClause) || MEDICATION_CURRENT_TRANSITION_CUE.test(normalizedClause);
      const allowBareMedication = declaresList || listContinuation || sentenceHasScopedEvent || clauseHasActiveCue;
      if (MEDICATION_REPLACEMENT_EVENT.test(normalizedClause)) {
        const previous = activeEvents.at(-1);
        if (previous) removeScoped([previous]);
      }
      const clauseEvents: ActiveMedicationEvent[] = [];
      for (const part of normalizedClause.split(/\s*(?:以及|及|与|和|、)\s*/).map((item) => item.trim()).filter(Boolean)) {
        const identity = medicationEventIdentity(part);
        if (!identity || !allowBareMedication && !MEDICATION_ACTIVE_CUE.test(part) && !/\d+(?:\.\d+)?\s*(?:mg|g|毫克|克|片|粒|丸|袋|支|IU|U|单位)/i.test(part)) continue;
        const event = upsert(part);
        if (event) clauseEvents.push(event);
      }
      if (clauseEvents.length > 0) scopedEvents = [...scopedEvents, ...clauseEvents];
      listContinuation = declaresList || (listContinuation && clauseEvents.length > 0);
    }
  }
  const unique = [...new Map(activeEvents.map((event) => [event.identity, event.text])).values()];
  return unique.length > 0 ? unique.join("；") : undefined;
}

/** 并列第一项里可能被后面各项共用的谓语：否定词与「在/为/属/见/有」（m03-patient-claim-check 删并列项时用）。 */
const LIST_HEAD_PREDICATE = /不在|不|无|未|没|非|在|为|属|见|有/u;
export function carriesListPredicate(item: string): boolean {
  return LIST_HEAD_PREDICATE.test(item);
}

/**
 * 病历写着本次月经逾期未至（闭集写法）：「末次月经…至今未至/未来/未潮」「月经推迟/延迟/逾期N天」「停经N天/周/个月」。
 * 「停经N年」「已停经」「绝经」不算（那是绝经）；否认的不算。
 */
const CURRENT_MENSES_OVERDUE = /末次月经[^。；;\n]{0,24}(?:至今|迄今|现|目前)(?:仍|尚)?(?:未至|未来|未潮|未行|未转|没来)|月经(?:推迟|延迟|延后|逾期|过期)(?:约)?(?:\d+|[一二两三四五六七八九十]+)?(?:天|日|周|个?月)?(?:未至|未来|未行)?|停经(?:约)?(?:\d+|[一二两三四五六七八九十]+)(?:天|日|周|个月|月)(?!余年)/u;
export function currentMensesOverdue(text: string): boolean {
  return affirmedClinicalSourceClauses(text).some((clause) => CURRENT_MENSES_OVERDUE.test(clause) && !/绝经|停经\s*(?:\d+|[一二两三四五六七八九十]+)\s*年|已停经/u.test(clause));
}

/**
 * 回指式鉴别尾句（m03-patient-claim-check 删掉被指的分句后，用它认出没有所指的尾句）：整条分句只有
 * 「（故/因此/所以）（与/同/和）二者/两者/上述各病 …区分/鉴别」。2026-10-19 X-C-0159：「…属产后小便淋痛；故与二者相区分。」
 */
export const ORPHAN_ANAPHORIC_TAIL = /^(?:故|因此|所以|从而|遂)?(?:与|同|和)?(?:二者|两者|此二者|上述各?病|以上各?病)[^，,；;。]{0,6}(?:区分|鉴别|区别)$/u;
