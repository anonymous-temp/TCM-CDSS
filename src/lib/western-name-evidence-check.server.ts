import "server-only";

import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";
import { westernLabelContainsTcmSyndrome } from "./clinical-governance-tables";
import { westernCriteriaEntry, westernCriteriaPromptValue, westernCriteriaReference, westernNameWithoutCourseOrSideQualifier } from "./western-diagnostic-criteria.server";
import { resolveIcd10Diagnosis } from "./icd10-diagnosis-coding.server";
import { quoteGroundedInText } from "./verbatim-quote";

/**
 * 参考西医诊断名与病历已记录内容的一致性核对（2026-10-14）。
 *
 * 要解决的是这一类：病名与病历已经写明的内容直接矛盾，或说得过头——家属明确说夜间无打鼾憋气，诊断写睡眠呼吸暂停低通气综合征；
 * 月经周期规律、只有一次 AMH 偏低，写早发性卵巢功能不全；能进食、尿量正常、酮体阴性，写妊娠剧吐；肛门镜见痔核脱出，写直肠脱垂。
 * 独立评审里西医诊断不通过的病例属于这一类。
 *
 * 为什么不改生成侧：上一轮在西医半提示词里加过「下病名前先对照检查结果」，三例复跑不变；本轮试过让模型在病名之前先写一栏
 *「检查结果→意义」，模型对检查的解读是对的，病名照旧，而且首轮结构违规从 0/190 升到 30/40（漏写鉴别、依据写成对象）。
 * 相关研究的结论是一致的：模型「知道标准」不等于「用上标准」，要它定位自己的错很难，把具体位置指给它之后改起来却很准；
 * 泛化的复核模型会过度挑错（本项目 9/16 删掉的复核环节 84% 打回）。所以这里只问一件窄事、只在三种情形下成立，
 * 并且要交出病历原文片段，服务端逐字核对后才采信。
 *
 * 离线实测（已落盘的 252 例辨证结果）：合成 190 例标出 9–10 例（两次运行一致 9 例），其中 7 例确属矛盾或说过头、1 例为误报
 *（静息心电图 T 波低平被当成不支持冠心病）；甲方既往 52 例与标准 10 例标出 0 例。单次约 0.8 秒，与中医半并行。
 *
 * 第四种情形 D（2026-10-17，owner 定的口径「没有关键检查时写上一级病名」）：名称比病历能支撑的更具体——按公认标准须靠某项
 * 检查（缺铁性贫血要铁代谢、甲减要甲功、慢性胃炎要胃镜、PCOS 要鹿特丹两项）或病程门槛（功能性消化不良/肠易激/功能性便秘起病满
 * 6 个月）才成立，而病历两样都没有。上一版明文规定「没做检查不算矛盾」，留出集评审西医诊断 72% 不通过的主体正是这一类（缺铁性贫血
 * 只有血红蛋白、病程两周写功能性消化不良、超声激素都正常写 PCOS）。离线实测（已落盘 272 份辨证结果，两次运行）：合成 190 例标出
 * 29–30 例、既往 52 例 16–17 例、甲方标准 10 例 × 3 次 5–6 次，两次运行各集合只差 1 例；逐条读过，多数属实，存疑的都是降一级的
 * 温和改名（失血性贫血→贫血）。第一版提示词把病程两年的功能性消化不良也判不够、把有反酸的胃食管反流病和产后贫血判过度具体、并把
 * 雷击样头痛的蛛网膜下腔出血改成「待查」，所以提示词写明了时间门槛与临床可诊断的病，红旗病例另由服务端整条不用 D（见 redFlag）。
 *
 * 边界：
 *  · 只改病名这一项：采信后 primary.name 换成核对给出的名称（更宽一层、更轻一层，或「症状＋待查」），原病名留在候选与鉴别里；
 *  · 不产生新的患者事实，不参与任何安全判断；病名之后的编码、术语归一、签名照常走既有链路；
 *  · 超时、未配置、输出非法、引文不在病历里、给出的名称不合规，一律不采信（保持模型原样）；
 *  · temperature 0，按请求内容缓存，同一份病历得到同一结论。
 * 开关：CDSS_WESTERN_NAME_EVIDENCE_CHECK=false 关闭。
 * 2026-10-20 起核对并行做两次、两次一致才改名（agreedWesternNameCorrection；CDSS_WESTERN_NAME_CHECK_AGREEMENT=false 恢复单次）。
 */
const TIMEOUT_MS = (() => {
  const value = Number(process.env.WESTERN_NAME_EVIDENCE_CHECK_TIMEOUT_MS || 5_000);
  return Number.isFinite(value) && value >= 2_000 && value <= 12_000 ? Math.round(value) : 5_000;
})();
const MAX_RECORD_CHARS = 2_400;

function enabled(): boolean {
  return process.env.CDSS_WESTERN_NAME_EVIDENCE_CHECK !== "false";
}

const compact = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");

export type WesternNameCorrection = {
  supportedName: string;
  quote: string;
  reason: string;
  type: "A" | "B" | "C" | "D";
  /** 核对模型判断原诊断名属急危重症（只在为真时出现）。红旗病例上据此不把急危重病名改成别的写法（见 alignWesternNameWithRecord）。 */
  currentIsEmergency?: true;
  /** 改成的名称是西医半自己列在候选或鉴别里的病（只在为真时出现）。 */
  adoptedFromList?: true;
  /** D 类：核对给出的缺失检查或病程（只在合规时出现），写进原病名那条鉴别的「建议核实」。 */
  missingTest?: string;
  /**
   * D 类、缺的是病程（只在为真时出现）：unmet 病历记录的病程没满门槛；far_below 不到门槛的四分之一（5 天对 6 个月），这时原病名
   * 不再留在候选与鉴别里——急性起病几天的便秘列「功能性便秘」作鉴别，复核判不切实际（2026-10-19 留出例 S055、甲方病历 4）。
   */
  course?: "unmet" | "far_below";
  /** 缺的是病程时原病名那条鉴别的「建议核实」：表里该病可以开出的检查或记录（按患者年龄取成人或未满18岁那一项）。 */
  courseNextCheck?: string;
};

// 核对给出的名称只能是一个干净的病名：不带括号、并列与推测语气（标点与语气词是写法检查）；中医证候字样由合同的同一判据
// westernLabelContainsTcmSyndrome（西医主诊断不得带证候）判定，不在这里另写一张词表。
// 「主要症状＋待查」是提示词旧版里的格式说明，模型曾逐字照抄成病名（验收集 X-D-4595、X-D-4660）：带格式词的名称不采信。
const INVALID_SUPPORTED_NAME_FORM = /[（）()\/、，,；;：:？?＋+]|或|可能|疑似|待排|主要症状/;

/** 名称是不是一个干净的病名（不带括号、并列、推测语气、证候字样）。西医主诊断的闭集重选（western-primary-reselect）用同一判据。 */
export function isCleanWesternDiagnosisName(name: string): boolean {
  const value = name.trim();
  return value.replace(/待查$/u, "").length >= 2 && value.length <= 30 && !INVALID_SUPPORTED_NAME_FORM.test(value) &&
    !westernLabelContainsTcmSyndrome(value) && !/证$/.test(value) && /[一-龥]/.test(value);
}

/** 西医半自己列出的候选与鉴别病名（不含主诊断本身），给核对与闭集重选当名单。 */
export function listedWesternDiagnosisNames(western: unknown): string[] {
  const root = record(western);
  const primaryName = typeof record(root?.primary)?.name === "string" ? String(record(root?.primary)?.name).trim() : "";
  const names = [...(Array.isArray(root?.candidates) ? root.candidates : []), ...(Array.isArray(root?.differentials) ? root.differentials : [])]
    .map((item) => (typeof record(item)?.name === "string" ? String(record(item)?.name).trim() : ""))
    .filter((item) => item && compact(item) !== compact(primaryName));
  return [...new Set(names)].slice(0, 12);
}

/** 原名去掉核对给出的上一级之后仍包含它（「神经源性休克」⊃「休克」、「大量心包积液」⊃「心包积液」）：说的还是同一类病。 */
/** 短名的每个字按顺序出现在长名里（「急性扁桃体炎」之于「急性化脓性扁桃体炎」）。 */
function isCharacterSubsequence(short: string, long: string): boolean {
  if (!short || short.length >= long.length) return false;
  let at = 0;
  for (const char of long) if (char === short[at]) at += 1;
  return at === short.length;
}

function namesSameDiseaseFamily(broader: string, current: string): boolean {
  const core = compact(broader.replace(/待查$/u, ""));
  return core.length >= 2 && core !== compact(current) && compact(current).includes(core);
}

/**
 * 病程（天）：病历主诉里写的时长，取最长的一段（「反复咳嗽10年，加重3天」按 10 年）。认「天/日/周/星期/个月/月/年/小时」，
 * 「半月」「两个多月」「1年余」「1+年」「十余年」「数月」；「余/多/+」与「数/几」给出下限与上限（下限用来判「已满门槛」，上限用来判
 *「远不到门槛」，两头都只在确定时成立）。主诉没写时长时返回 undefined——不从现病史里猜（「10年前行阑尾切除术」会把病程拉长）。
 * 2026-10-19 独立评审：留出例 S077 主诉「食少、乏力1年余」，核对仍判「病程未满6个月」，交付「乏力」并在鉴别里写「随访至病程满6个月」。
 */
const COURSE_SPAN = /(半|数|几|\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})\s*(\+|余|多)?\s*(个)?\s*(\+|余|多)?\s*(小时|星期|年|月|周|天|日)(\+|余|多)?/gu;
const COURSE_UNIT_DAYS: Record<string, number> = { 小时: 1 / 24, 星期: 7, 年: 365, 月: 30, 周: 7, 天: 1, 日: 1 };
const CHINESE_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function courseNumber(token: string): number | undefined {
  if (/^\d+(?:\.\d+)?$/u.test(token)) return Number(token);
  if (CHINESE_DIGITS[token]) return CHINESE_DIGITS[token];
  const tens = token.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u);
  if (tens) return (tens[1] ? CHINESE_DIGITS[tens[1]] : 1) * 10 + (tens[2] ? CHINESE_DIGITS[tens[2]] : 0);
  return undefined;
}

type CourseSpan = { lower: number; upper: number; index: number; length: number };

function courseSpans(text: string): CourseSpan[] {
  const spans: CourseSpan[] = [];
  for (const match of text.normalize("NFKC").matchAll(COURSE_SPAN)) {
    const [whole, amount, before, , middle, unit, after] = match;
    const days = COURSE_UNIT_DAYS[unit];
    if (!days) continue;
    // 「每3天1次」「3天一行」是频次，不是病程。
    const tail = text.normalize("NFKC").slice((match.index || 0) + whole.length, (match.index || 0) + whole.length + 2);
    if (/^(?:1|一)次|^一行/u.test(tail)) continue;
    const approx = Boolean(before || middle || after);
    let lower: number;
    let upper: number;
    if (amount === "半") {
      lower = upper = 0.5 * days;
    } else if (amount === "数" || amount === "几") {
      lower = 2 * days;
      upper = 9 * days;
    } else {
      const value = courseNumber(amount);
      if (value == null || value <= 0) continue;
      lower = value * days;
      upper = approx ? (value >= 10 && value % 10 === 0 ? value + 10 : value + 1) * days : lower;
    }
    spans.push({ lower, upper, index: match.index || 0, length: whole.length });
  }
  return spans;
}

/** 病历主诉那一行：带「主诉」标签的行，否则第一行（甲方传参形状里第一行就是主诉）；太长的不是主诉。 */
function chiefComplaintLine(recordText: string): string {
  const lines = recordText.split(/\n+/u).map((line) => line.trim()).filter(Boolean);
  const labelled = lines.find((line) => /^主诉\s*[:：]/u.test(line));
  const line = labelled ? labelled.replace(/^主诉\s*[:：]\s*/u, "") : lines[0] || "";
  return line.length <= 60 ? line : "";
}

export function recordCourseDays(recordText: string): { lower: number; upper: number } | undefined {
  const spans = courseSpans(chiefComplaintLine(recordText));
  if (spans.length === 0) return undefined;
  return { lower: Math.max(...spans.map((span) => span.lower)), upper: Math.max(...spans.map((span) => span.upper)) };
}

/** 核对理由里写的门槛（「需持续超6个月」「未达成人6个月门槛」）；理由里说病历病程的（「病程仅5天」）不算。 */
function courseThresholdFromReason(reason: string): number | undefined {
  const text = reason.normalize("NFKC");
  const thresholds = courseSpans(text).filter((span) => {
    const before = text.slice(Math.max(0, span.index - 3), span.index);
    const after = text.slice(span.index + span.length, span.index + span.length + 2);
    // 「近3个月」「每年发病持续3个月」是罗马标准的近期窗口与慢支的逐年口径，不是起病至今的门槛。
    if (/每[年月周天日]|近/u.test(text.slice(Math.max(0, span.index - 6), span.index))) return false;
    return /(?:满|超|过|至少|达|持续|大于|>|≥|逾)$/u.test(before) || /^(?:以上|门槛)/u.test(after);
  });
  return thresholds.length > 0 ? Math.max(...thresholds.map((span) => span.lower)) : undefined;
}

/** 本例适用的病程门槛（天）：表里的结构化门槛按年龄取成人或未满18岁；表里没有时用核对理由里写的门槛。 */
function courseThresholdForPatient(currentName: string, reason: string, patientAge?: number): { days?: number; nextCheck?: string } {
  const entry = westernCriteriaEntry(currentName);
  const table = entry?.courseThresholdDays;
  const child = typeof patientAge === "number" && Number.isFinite(patientAge) && patientAge < 18;
  const fromTable = child ? table?.under18 ?? table?.adult : table?.adult;
  return {
    days: fromTable ?? courseThresholdFromReason(reason),
    nextCheck: (child ? entry?.courseNextCheckUnder18 : undefined) || entry?.courseNextCheck,
  };
}

// 理由里说的是缺检查（而不只是病程）时，病程够了也不能说核对错了：「76岁起病，尚缺结肠镜」照常采信。
const MISSING_TEST_WORDS = /检查|检测|化验|测定|镜|活检|病理|影像|超声|CT|MRI|X线|抗体|试验|测试|血清|铁蛋白|结果|报告|量表/iu;
const REASON_ONLY_MISSING = /缺|未记录|未查|未做|未行|尚无|无[^，,；;。]{0,12}(?:结果|报告|检查|证据|依据)/u;
const REASON_RECORDED_CONTRARY = /阴性|正常|未见|不支持|指向|不符|规律|相反|仅为|只够|仅达|达不到|不足以|低于|高于/u;
const COURSE_WORDS = /病程|门槛|时长|持续|\d\s*个?(?:月|年|周|天)|[一二两三四五六七八九十半]\s*个?(?:月|年|周|天)/u;

/**
 * 名称停在单个症状上（乏力、头痛、关节痛…）：ICD-10 R 章，或少数在别的章里的症状码（关节痛 M25.5、背痛/腰痛/颈痛 M54、肢体痛
 * M79.6、便秘 K59.0、腹泻 A09.9、便血 K92.2、耳鸣 H93.1）。查不到编码时去掉开头的「多/双/单/左/右」再查一次（「多关节痛」）。
 * 核对给的上一级写成这种名称时补「待查」（2026-10-19 留出例 S077 交付「乏力」，复核：主诊断只写症状且未写待查）。
 */
const SYMPTOM_CODE_OUTSIDE_R = /^(?:M25\.5|M54|M79\.6|K59\.0|A09\.9|K92\.2|H93\.1)/u;
export function symptomLevelWesternName(name: string): boolean {
  const core = name.trim().replace(/待查$/u, "");
  if (core.length < 2) return false;
  const code = resolveIcd10Diagnosis(core)?.code || resolveIcd10Diagnosis(core.replace(/^[多双单左右]{1,2}/u, ""))?.code || "";
  return /^R/iu.test(code) || SYMPTOM_CODE_OUTSIDE_R.test(code);
}

/**
 * D 类的前置核对结果是否否决这次改名：meetsCriteria 明确为 true；或 decisive 是病历里逐字存在的一段（≥4 字）而 meetsCriteria 没有
 * 明确写 false。meetsCriteria 为 false 时 decisive 只是「有一点依据但不够」，不否决。
 */
export function decisiveFindingVetoesD(decisive: unknown, meetsCriteria: unknown, recordText: string): boolean {
  if (meetsCriteria === true) return true;
  if (meetsCriteria === false) return false;
  const quoted = typeof decisive === "string" ? compact(decisive) : "";
  return quoted.length >= 4 && compact(recordText).includes(quoted);
}

/** 模型输出 → 可采信的改名（否则 undefined）。引文必须逐字在病历里；名称必须合规且与原名不同。 */
export function parseWesternNameCorrection(
  content: unknown,
  recordText: string,
  currentName: string,
  options: { listedNames?: readonly string[]; patientAge?: number } = {},
): WesternNameCorrection | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { verdict, type, quote, reason, supportedName, emergencyName, missingTest, decisive, meetsCriteria } = parsed as Record<string, unknown>;
  if (verdict !== "inconsistent" || (type !== "A" && type !== "B" && type !== "C" && type !== "D")) return undefined;
  // D 类（缺确诊依据）的否决：核对自己指出了病历里一项已够得上名称程度的客观依据（meetsCriteria 为 true，或交出逐字在病历里的 decisive
  // 而没有说它不够），就是自相矛盾——拿不准保持原样（2026-10-19 第九轮，D 集 23 例把有造影/活检/典型体征的病名换成「X待查」）。
  // 只管 D：A–C 说的是病历已记录的内容与病名相反，decisive 与之无关。
  if (type === "D" && decisiveFindingVetoesD(decisive, meetsCriteria, recordText)) return undefined;
  const name = typeof supportedName === "string" ? supportedName.trim() : "";
  const quoted = typeof quote === "string" ? quote.trim() : "";
  const why = typeof reason === "string" ? reason.trim().replace(/[。；;]+$/u, "") : "";
  if (name.replace(/待查$/u, "").length < 2 || name.length > 30 || INVALID_SUPPORTED_NAME_FORM.test(name) || westernLabelContainsTcmSyndrome(name) || /证$/.test(name) || !/[一-龥]/.test(name)) return undefined;
  if (compact(name) === compact(currentName)) return undefined;
  // D 类（缺确诊检查或病程）指不出更宽一层的病名、只能写「症状待查」时，留住原来的首要考虑、写成「原病名待查」（2026-10-18）。
  // 改成症状会把首要考虑挤进鉴别：验收集 X-D-4595 多发性骨髓瘤→「腰痛待查」、X-D-4660 先天性甲减→「便秘待查」、
  // X-D-2054 慢性胰腺炎→「腹胀」。病历里「肺癌待查」「结核待查」本来就是这么写的：点出首要考虑，同时说明未确诊。
  const current = currentName.trim();
  // 靠病程门槛定义的病（功能性消化不良要 6 个月）没到病程时，「原病名待查」仍是越级：甲方病历 4 半个月写成「功能性消化不良待查」，
  // 复核判越过罗马 IV（2026-10-18）。这类沿用核对给的上一级或症状名，只给「缺确诊检查」的病留住首要考虑。
  const courseDefined = Boolean(westernCriteriaEntry(current)?.durationThreshold) || /病程|个月|周|时长|持续时间/u.test(why);
  // A、B 类：病历记录的检查所见本身指向西医半自己列出的另一个病（活检见钉突→膜性肾病、超声「落雪状」→葡萄胎、扩容后中心静脉压高→
  // 心源性休克）时，直接改成那个病（2026-10-19）。此前只许写「症状待查」，验收集 11 次 A–C 改名 11 次评审不通过，多数是核对
  // 指出了原名不对、却交出「肾病综合征待查」「妊娠待查」这种更差的名称。只认名单里逐字有的病名：不产生西医半没有提出过的诊断。
  const adoptedFromList = (type === "A" || type === "B") && !/待查$/u.test(name) &&
    (options.listedNames || []).some((item) => compact(item) === compact(name));
  // D 类核对给的是原名的上一级（「大量心包积液」→「心包积液待查」、「低钾性周期性麻痹」→「周期性麻痹待查」）时用它，不再换回
  //「原病名待查」——那会把说过头的那部分又带回来（验收集 X-D-1053、X-D-4969，2026-10-19）。
  // 表里按临床表现即可诊断、没有必需检查的病（紧张型头痛、反应性关节炎）判 D，缺的是特征或前驱病史，不是确诊检查：首要考虑本身没有依据，
  // 不留「原病名待查」（2026-10-19 留出例 S079 交付「反应性关节炎待查」，病历没有前驱肠道或泌尿生殖道感染，复核不通过）。
  const currentEntry = westernCriteriaEntry(current);
  const testDefined = !currentEntry || currentEntry.requiredTests.length > 0;
  const keepHypothesis = type === "D" && /待查$/u.test(name) && !/待查$/u.test(current) && !courseDefined && testDefined &&
    !namesSameDiseaseFamily(name, current) &&
    current.length >= 2 && current.length <= 24 && !INVALID_SUPPORTED_NAME_FORM.test(current);
  // A、B 类给的上一级只是去掉了病程限定或侧别（「急性尿潴留」→「尿潴留待查」）时，上一级本身有依据，不再挂「待查」（验收集 X-D-0204）。
  const qualifierOnly = (type === "A" || type === "B") && /待查$/u.test(name) &&
    westernNameWithoutCourseOrSideQualifier(current) === name.replace(/待查$/u, "");
  const named = keepHypothesis ? `${current}待查` : qualifierOnly ? name.replace(/待查$/u, "") : name;
  // 停在单个症状上的名称一律带「待查」（「乏力」→「乏力待查」）；只去掉病程限定或侧别的上一级（「尿潴留」）本身有依据，不加。
  const bareSymptom = !qualifierOnly && !/待查$/u.test(named) && symptomLevelWesternName(named);
  const symptomSupported = bareSymptom ? `${named}待查` : named;
  // D 类说的是「缺确诊所需的检查或病程」，给出的名称只能是同一个病往宽处说：原名去掉限定（脊髓型颈椎病→颈椎病、
  // 急性化脓性扁桃体炎→急性扁桃体炎，按字序是原名的子序列）、症状层名称，或病历自己写着的说法（主诉「牙痛3天」→牙痛）。
  // 核对把另一个病当成「上一级」交回时（附睾结核→附睾炎、甲状腺癌骨转移→甲状腺瘤、肾包虫病→肾囊肿、糖尿病→消渴病、
  // 慢性非萎缩性胃炎→功能性消化不良；2026-10-19 第九轮终测 D 集），换名就成了另一个没有依据的诊断：改写「原病名待查」，
  // 留住首要考虑——与 keepHypothesis 同一口径。只管不带「待查」的名称；带「待查」的照上面的规则。
  const supportedCore = compact(symptomSupported.replace(/待查$/u, ""));
  const supported = type === "D" && !/待查$/u.test(symptomSupported) &&
    !isCharacterSubsequence(supportedCore, compact(current)) && !symptomLevelWesternName(supportedCore) &&
    !compact(recordText).includes(supportedCore) && current.length >= 2 && !INVALID_SUPPORTED_NAME_FORM.test(current)
    ? `${current}待查`
    : symptomSupported;
  if (!quoteGroundedInText(quoted, recordText)) return undefined;
  if (why.length < 4 || why.length > 60) return undefined;
  // D 类的理由必须说缺什么；理由本身说门槛「已满足/符合」而没说缺哪样时，是核对自相矛盾，不采信（2026-10-19 本机探针：9岁患儿
  // 「儿童功能性便秘需病程满1个月，病历仅3个月已满足；…符合」仍判 D，交付成「便秘待查」）。
  if (type === "D" && /已满足|已达到?|符合/u.test(why) && !/未满|未达|不足|尚缺|缺|未行|未做|没有|未查|未记录/u.test(why)) return undefined;
  // A–C 说的是病历已记录的内容与病名相反或只够较轻一层。理由只说缺哪项检查或结果（「病历无抗酸染色等病原学结果」）、没有任何已记录的
  // 相反所见时，是把 D 标成了 A：不采信（2026-10-19 离线回放验收集 X-D-2062：肺门淋巴结肿大＋结核菌素强阳性的原发型肺结核，被以 A 类
  // 改成「胸闷待查」「结节病」）。
  if (type !== "D" && REASON_ONLY_MISSING.test(why) && !REASON_RECORDED_CONTRARY.test(why)) return undefined;
  // D 类说的只是病程不够，而病历主诉记录的病程已经够上门槛：核对说反了，不采信（2026-10-19 留出例 S077 主诉「1年余」被判未满6个月）。
  // 病程不明（主诉没写时长）或门槛不明时照常采信。理由里同时说缺检查的（「76岁起病，尚缺结肠镜」）不按病程论。
  let course: WesternNameCorrection["course"];
  let courseNextCheck: string | undefined;
  if (type === "D" && COURSE_WORDS.test(why) && !MISSING_TEST_WORDS.test(why)) {
    const threshold = courseThresholdForPatient(current, why, options.patientAge);
    const recorded = recordCourseDays(recordText);
    if (threshold.days != null && recorded && recorded.lower >= threshold.days) return undefined;
    if (threshold.days != null) course = recorded && recorded.upper < threshold.days / 4 ? "far_below" : "unmet";
    courseNextCheck = threshold.nextCheck;
  }
  return {
    supportedName: supported, quote: quoted, reason: why, type,
    ...(emergencyName === true ? { currentIsEmergency: true as const } : {}),
    ...(adoptedFromList && !bareSymptom ? { adoptedFromList: true as const } : {}),
    ...(type === "D" && typeof missingTest === "string" && isCleanMissingTest(missingTest) ? { missingTest: missingTest.trim() } : {}),
    ...(course ? { course } : {}),
    ...(course && courseNextCheck ? { courseNextCheck } : {}),
  };
}

/**
 * D 类原病名那条鉴别的区分要点：核对理由里说缺哪项检查的「无/未记录/未见…」都换成「尚缺」——说的是缺这份资料，不是否认症状；
 * 留着「无」会被鉴别净化当成对本例的否认，再改成「未诉…」（2026-10-17 病历 7 只处理了句首；10/19 留出例 S058「76岁起病，无结肠镜结果排除
 * 器质性病变」交付成「未诉结肠镜结果…」）。只换紧跟着检查类字样的那一处。
 */
function missingTestReasonText(reason: string): string {
  return reason
    .replace(/^(?:病历)?(?:未记录|未见|无|缺少|缺乏|没有)/u, "尚缺")
    .replace(/(^|[，,；;、])(?:病历)?(?:未记录|未见|无|缺少|缺乏|没有|未行|未做|未查)(?=[^，,。；;]{0,12}(?:结果|检查|报告|镜|影像|化验|测定|检测|病理|活检|测试|试验))/gu, "$1尚缺");
}

/** 核对给的缺失检查名：短、不带括号与推测语气、有汉字或字母。 */
function isCleanMissingTest(value: string): boolean {
  const text = value.trim();
  // 「随访至病程满6个月」不是可以开出的检查（2026-10-19 独立评审：甲方病历 4 三次生成、留出例 S055 都是这一句）：不采信，改用表里的
  // courseNextCheck（见 westernDifferentialNextCheck）。
  if (/随访|病程|观察|等待|满\s*[\d一二两三四五六七八九十半]+\s*个?[年月周天]/u.test(text)) return false;
  return text.length >= 2 && text.length <= 24 && !INVALID_SUPPORTED_NAME_FORM.test(text.replace(/、/gu, "")) && /[一-龥A-Za-z]/.test(text);
}

/**
 * D 类原病名那条鉴别的「建议核实」：写缺的那项检查本身（2026-10-19：留出集 32 例里 8 例、甲方标准病历 30 次里 6 次是「完善确诊所需检查」）。
 * 先用核对针对本例给出的缺失项；没有时，诊断标准要点表里该病只有一项必需检查（去掉括注；带适用条件的长句不算）就用它——表里列了
 * 好几项时说不准缺的是哪一项（缺铁性贫血表里第一项是病人已经有的血红蛋白），不替核对挑；都没有才用通用句。
 */
export function westernDifferentialNextCheck(previousName: string, correction: WesternNameCorrection): string {
  // 缺的是病程：写表里该病确诊前可以开出的那一项（功能性消化不良「胃镜」、功能性便秘「排便日记，有报警征象时结肠镜」），优先于核对
  // 自己写的缺失项——那一项随生成而变，也不分成人儿童（留出例 S158 6 岁患儿曾得到「胃镜」）。
  if (correction.course && correction.courseNextCheck) return correction.courseNextCheck;
  if (correction.missingTest) return correction.missingTest;
  const entry = westernCriteriaEntry(previousName);
  const tableTests = (entry?.requiredTests || [])
    .map((item) => item.replace(/[（(][^（）()]*[）)]/gu, "").trim())
    .filter((item) => item.length >= 2 && item.length <= 24 && !/[时需者；;]/u.test(item));
  if (tableTests.length === 1) return tableTests[0];
  // 按特征计数或前驱病史成立的病（紧张型头痛、反应性关节炎）：头痛日记、追问前驱感染（2026-10-19 留出例 S079 曾是通用句）。
  return entry?.clinicalNextCheck || "完善确诊所需检查";
}

type Json = Record<string, unknown>;

/** 传参里的年龄（数字或「43岁」「8个月」）→ 岁；读不出时 undefined（按成人门槛）。 */
function patientAgeYears(age: unknown): number | undefined {
  if (typeof age === "number") return Number.isFinite(age) && age >= 0 && age <= 120 ? age : undefined;
  const text = typeof age === "string" ? age.normalize("NFKC").trim() : "";
  const months = text.match(/^(\d+(?:\.\d+)?)\s*个?月/u);
  if (months) return Number(months[1]) / 12;
  const years = text.match(/^(\d+(?:\.\d+)?)\s*(?:岁)?$/u);
  return years && Number(years[1]) <= 120 ? Number(years[1]) : undefined;
}
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;

/**
 * 患者性别不可能有的西医病名（2026-10-19 独立评审：男性病例的西医鉴别里出现妇产科病名，女性病例出现前列腺类病名）。
 * 闭集标记：妇产科（妊娠、产后、子宫、卵巢、月经、绝经…）只对男性排除；前列腺、睾丸、附睾等男性生殖器官只对女性排除。
 * 乳腺病两性都有，不在其中；病名自己写明「男性/女性」的（男性更年期综合征）按所写；新生儿的胎粪类病与性别无关。性别不明时不判。
 */
const FEMALE_ONLY_WESTERN_NAME = /妊娠|孕|产后|产褥|流产|(?<!新生儿)胎(?!粪|记)|羊水|子宫|宫颈|宫腔|卵巢|输卵管|附件炎|盆腔炎|阴道|外阴|前庭大腺|月经|经期|经前|痛经|闭经|绝经|更年期|带下|子痫|滋养细胞/u;
const MALE_ONLY_WESTERN_NAME = /前列腺|睾丸|附睾|精索|阴囊|阴茎|包皮|龟头|精囊|勃起|早泄|遗精|精液|少精|弱精|无精|隐睾|鞘膜积液/u;

function patientSexOf(value: unknown): "男" | "女" | undefined {
  const raw = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (/女/u.test(raw) || /^(?:f|female|woman)$/iu.test(raw)) return "女";
  if (/男/u.test(raw) || /^(?:m|male|man)$/iu.test(raw)) return "男";
  return undefined;
}

export function westernNameOutsidePatientSex(name: string, sex: unknown): boolean {
  const patientSex = patientSexOf(sex);
  const text = name.normalize("NFKC");
  if (patientSex === "男") return FEMALE_ONLY_WESTERN_NAME.test(text) && !/男/u.test(text);
  if (patientSex === "女") return MALE_ONLY_WESTERN_NAME.test(text) && !/女/u.test(text);
  return false;
}

/** 西医半的候选与鉴别里去掉患者性别不可能有的病名；主诊断不动。解析不了或没有可去的原样返回。 */
export function withoutSexIncompatibleWesternNames(westernContent: string, sex: unknown): string {
  if (!patientSexOf(sex)) return westernContent;
  let parsed: unknown;
  try { parsed = JSON.parse(westernContent); } catch { return westernContent; }
  const western = record(record(parsed)?.westernDiagnosis);
  if (!western) return westernContent;
  let removed = 0;
  for (const key of ["candidates", "differentials"] as const) {
    const list = western[key];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((item) => {
      const name = typeof record(item)?.name === "string" ? String(record(item)?.name) : "";
      return !(name && westernNameOutsidePatientSex(name, sex));
    });
    removed += list.length - kept.length;
    western[key] = kept;
  }
  if (removed === 0) return westernContent;
  console.info("[tcm-cdss:telemetry] western_sex_incompatible_names_removed", { removed });
  return JSON.stringify(parsed);
}

/**
 * 把采信的改名写进西医半的输出：主诊断换名，原病名留在候选（A–C 标明不支持它的那句病历原文）与鉴别（核对给出的理由）里。
 * 只动这三处；解析不了或没有主诊断时原样返回。
 */
/**
 * 改了病名后，推理说明里仍把原病名当结论的说法一并改（2026-10-22 第十五轮）。
 * 病名核对只改 primary.name，推理说明照旧写「符合缺铁性贫血」「支持绝经后骨质疏松症」，页面「西医诊断：贫血 / 推理说明：…符合缺铁性贫血」
 * 自相矛盾（已存输出里被改名的 74 例中 28 例）。D 类（缺确诊所需的检查或病程）改成「考虑X可能」，与「X待查」和鉴别里的「尚未取得确诊所需的检查」一致；
 * 其余几类（病历与原病名相反、说重了）改成「需与X鉴别」。只改「符合/支持/指向/诊断为/考虑为/明确为/确诊为X」与「暂按X考虑」这几种断言式，有限闭集。
 */
export function rationaleAlignedWithRenamedPrimary(rationale: string, previous: string, type: WesternNameCorrection["type"]): string {
  if (!rationale || !previous || !rationale.includes(previous)) return rationale;
  const escaped = previous.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const replacement = type === "D" ? `考虑${previous}可能` : `需与${previous}鉴别`;
  return rationale
    .replace(new RegExp(`(?:符合|支持|指向|诊断为|考虑为|可诊断为|明确为|确诊为)\\s*${escaped}(?:的?(?:表现|诊断|特点|模式))?(?!可能)`, "gu"), replacement)
    .replace(new RegExp(`暂按\\s*${escaped}\\s*考虑`, "gu"), type === "D" ? `${previous}可能` : replacement);
}

export function applyWesternNameCorrection(westernContent: string, correction: WesternNameCorrection): string {
  let parsed: unknown;
  try { parsed = JSON.parse(westernContent); } catch { return westernContent; }
  const root = record(parsed);
  const western = record(root?.westernDiagnosis);
  const primary = record(western?.primary);
  const previous = typeof primary?.name === "string" ? primary.name.trim() : "";
  if (!root || !western || !primary || !previous) return westernContent;
  primary.name = correction.supportedName;
  if (typeof primary.clinicalRationale === "string") primary.clinicalRationale = rationaleAlignedWithRenamedPrimary(primary.clinicalRationale, previous, correction.type);
  // 「原病名待查」：首要考虑没有换，只是标明未确诊。候选首位改名即可，不再另列原病名，鉴别里也不重复它。
  const hypothesisKept = correction.supportedName === `${previous}待查`;
  // 病程远不到门槛（5 天对 6 个月）：原病名不再留在候选与鉴别里（见 WesternNameCorrection.course）。
  const dropPrevious = correction.course === "far_below";
  const candidates = Array.isArray(western.candidates) ? western.candidates.filter((item): item is Json => Boolean(record(item))) : [];
  if (candidates.length > 0) {
    const others = candidates.filter((item) => item.name !== previous && item.name !== correction.supportedName);
    const lead = candidates.find((item) => item.name === previous) || candidates[0];
    // 改成西医半自己列过的病时，首位用它自己那一条（带它自己的支持与反对依据），不把原病名的依据挪给它。
    const adopted = correction.adoptedFromList ? candidates.find((item) => item.name === correction.supportedName) : undefined;
    western.candidates = hypothesisKept ? [{ ...lead, name: correction.supportedName }, ...others].slice(0, 3) : [
      adopted ? { ...adopted } : { ...lead, name: correction.supportedName },
      // D 类没有与原病名相反的记录，只是还没有确诊它的检查或病程：不把引文（支撑上一级病名的那句）写成反对依据。
      ...(dropPrevious ? [] : [correction.type === "D"
        ? { name: previous, likelihood: "中", keyEvidence: [], againstEvidence: [] }
        : { name: previous, likelihood: "低", keyEvidence: [], againstEvidence: [correction.quote] }]),
      ...others,
    ].slice(0, 3);
  }
  const differentials = Array.isArray(western.differentials) ? western.differentials.filter((item): item is Json => Boolean(record(item))) : [];
  if (dropPrevious) {
    western.differentials = differentials.filter((item) => item.name !== previous && item.name !== correction.supportedName);
  } else if (!hypothesisKept && !differentials.some((item) => item.name === previous)) {
    western.differentials = [
      correction.type === "D"
        // 模型写的理由常以「无/未记录…检查」开头，放进鉴别要点后会被当成对患者的否认、再被改写成「病历未记录…（需问诊核实…）」
        //（2026-10-17 本地复测病历 7）。这里说的是缺哪项检查，开头换成「尚缺」。
        ? { name: previous, reason: "尚未取得确诊所需的检查或病程依据", distinguishingPoints: missingTestReasonText(correction.reason), nextCheck: westernDifferentialNextCheck(previous, correction) }
        : { name: previous, reason: "与病历记录不符", distinguishingPoints: correction.reason, nextCheck: "必要时完善相关检查" },
      ...differentials.filter((item) => item.name !== correction.supportedName),
    ].slice(0, 8);
  } else if (correction.adoptedFromList) {
    // 原病名已在鉴别里：只把升为主诊断的那个病从鉴别里拿掉。
    western.differentials = differentials.filter((item) => item.name !== correction.supportedName);
  }
  return JSON.stringify(root);
}

/**
 * 两次核对一致才采信（2026-10-20 第十轮 B3）。
 *
 * 为什么：第九轮代码对同一批病历跑两次，西医主诊断名不同 14/80；其中 4 例是病名核对这一次判 D、下一次不判（肺结核↔肺结核待查、
 * 急性肾盂肾炎↔尿路感染、梗阻性黄疸↔梗阻性黄疸待查、胃癌待查↔上消化道出血待查）。核对 temperature 0，但同一份病历在边界上的结论
 * 仍随生成摇摆，单次结论就决定要不要把病名降一级。做法照 m03-patient-claim-check：两次核对并行（第二次把输入的内容顺序整个颠倒，
 * 缓存键因此不同、也不是同一个提示的重放），两次都给出可采信的改名、类型相同、解析后的名称相同才改名；任一次不改、或两次不一致，保持模型原样。
 * 第一次的请求与此前逐字相同（缓存与离线回放可对照）；两次并行，不增加串行等待。
 * 开关：CDSS_WESTERN_NAME_CHECK_AGREEMENT=false 恢复单次。
 */
function agreementRequired(): boolean {
  return process.env.CDSS_WESTERN_NAME_CHECK_AGREEMENT !== "false";
}

export type WesternNameAgreement = "off" | "none" | "agreed" | "agreed_merged" | "one_only" | "type_differs" | "name_differs";

/**
 * D 类两次给的名称只是同一个病说到不同的宽度（「哮喘待查」与「支气管哮喘待查」、「骨质疏松待查」与「绝经后骨质疏松症待查」、
 * 「颈椎病」与「颈椎病待查」）：两次都认的是较宽、较弱的那一个——核心名取较短的（按字序是另一个的子序列），任一次带「待查」就带「待查」。
 * 取交集而不是取其中一次，结果与两次的先后无关。不是子序列关系的两个名称（「心包炎待查」与「心包积液待查」）仍算不一致。
 * 离线回放（157 例，两次一致的 56 例之外）：名称不同 11 例里 8 例属于这一种，其中一例是甲方口径保护例 S114（绝经后骨质疏松症→骨质疏松待查）；
 * 只比字面相等时，这类例子因为两次宽窄不同而整条丢掉降级。CDSS_WESTERN_NAME_CHECK_NAME_MERGE=false 恢复只比字面。
 */
export function weakerCommonWesternName(first: string, second: string): string | undefined {
  const coreOf = (name: string) => compact(name.replace(/待查$/u, ""));
  const a = coreOf(first);
  const b = coreOf(second);
  if (a.length < 2 || b.length < 2) return undefined;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter !== longer && !isCharacterSubsequence(shorter, longer)) return undefined;
  return /待查$/u.test(first) || /待查$/u.test(second) ? `${shorter}待查` : shorter;
}

/**
 * 两次核对的合并。类型相同、名称（紧凑比较）相同才算一致（D 类名称只是宽窄不同时取较弱的公共名称，见 weakerCommonWesternName），
 * 取第一次的引文、理由与缺失检查；其余字段取保守的一侧：
 * 任一次说原名属急危重症则按急危重症处理（红旗病例上因此不被改写）；病程远不到门槛只有两次都这么说才删原病名，否则按“未满”。
 */
export function agreedWesternNameCorrection(
  first: WesternNameCorrection | undefined,
  second: WesternNameCorrection | undefined,
): { correction?: WesternNameCorrection; agreement: Exclude<WesternNameAgreement, "off"> } {
  if (!first && !second) return { agreement: "none" };
  if (!first || !second) return { agreement: "one_only" };
  if (first.type !== second.type) return { agreement: "type_differs" };
  let supportedName = first.supportedName;
  let merged = false;
  if (compact(first.supportedName) !== compact(second.supportedName)) {
    const weaker = first.type === "D" && process.env.CDSS_WESTERN_NAME_CHECK_NAME_MERGE !== "false"
      ? weakerCommonWesternName(first.supportedName, second.supportedName)
      : undefined;
    if (!weaker) return { agreement: "name_differs" };
    supportedName = weaker;
    merged = true;
  }
  const course: WesternNameCorrection["course"] = first.course === "far_below" && second.course === "far_below"
    ? "far_below"
    : first.course || second.course ? "unmet" : undefined;
  const courseNextCheck = first.courseNextCheck || second.courseNextCheck;
  const correction: WesternNameCorrection = { ...first, supportedName };
  delete correction.currentIsEmergency;
  delete correction.course;
  delete correction.courseNextCheck;
  if (first.currentIsEmergency || second.currentIsEmergency) correction.currentIsEmergency = true;
  if (course) correction.course = course;
  if (course && courseNextCheck) correction.courseNextCheck = courseNextCheck;
  return { agreement: merged ? "agreed_merged" : "agreed", correction };
}

export type WesternNameCheckOutcome = {
  correction?: WesternNameCorrection;
  first?: WesternNameCorrection;
  second?: WesternNameCorrection;
  agreement: WesternNameAgreement;
};

export async function westernNameCorrectionForRecord(
  input: { recordText: string; diagnosisName: string; patient?: { sex?: unknown; age?: unknown }; listedNames?: readonly string[] },
  signal?: AbortSignal,
): Promise<WesternNameCorrection | undefined> {
  return (await westernNameCheckOutcome(input, signal)).correction;
}

export async function westernNameCheckOutcome(
  input: { recordText: string; diagnosisName: string; patient?: { sex?: unknown; age?: unknown }; listedNames?: readonly string[] },
  signal?: AbortSignal,
): Promise<WesternNameCheckOutcome> {
  const none: WesternNameCheckOutcome = { agreement: agreementRequired() ? "none" : "off" };
  if (!enabled() || signal?.aborted) return none;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return none;
  const recordText = input.recordText.slice(0, MAX_RECORD_CHARS);
  const diagnosisName = input.diagnosisName.trim();
  // 已经停在症状层面的名称（「头痛待查」）没有可核对的病种。
  if (!recordText.trim() || diagnosisName.length < 2 || /待查$/.test(diagnosisName)) return none;
  const criteria = westernCriteriaPromptValue(await westernCriteriaReference(diagnosisName, signal).catch(() => undefined));
  const messages = [
    {
      role: "system" as const,
      content: [
        "你是病历与诊断名的一致性核对器，不负责重新诊断，也不评价诊断是否最优。",
        "任务：给你一份门诊病历和系统拟定的“参考西医诊断”名称。只判断一件事：病历里**已经记录**的内容，是否与这个诊断名直接矛盾，或不足以支撑这个名称说到的具体程度。",
        "判 inconsistent 仅限以下四种情况：",
        "A. 该病成立时本应阳性的检验/检查，病历已经做了并记录为阴性、正常或未见（如诊断为某种感染，病历记录的病原学检查未见病原体）；或病历记录的检查所见明确指向另一个病。",
        "B. 该诊断名有定义性的必备条件，而病历已记录的事实与之相反（如诊断要求闭经或月经稀发，病历写月经周期规律；诊断的核心表现病历明确写了没有）；或该病的诊断标准要求同时满足几项中的若干项，而病历已把其余各项记录为阴性或正常，满足的项数不够。",
        // 2026-10-19 Claude 评审 D 集：病历已有活检/影像/分级测量值时仍被降成上一级（鳞癌→不典型增生、二尖瓣重度反流→反流、
        // FSGS→慢性肾炎），痰脱落细胞学阴性被当成 A 把肺癌换成肺结核。C 与通则各补一句阈值与低敏感度检查。
        "C. 诊断名说的是较重的一层（“功能不全”“衰竭”“剧吐”“重度”等需要特定指标或程度才成立的名称），而病历记录的指标、程度只够得上较轻的一层。病历记录的测量值已经达到该程度的公认阈值时（如二尖瓣反流面积占左房45%，>40%即重度）不属于 C。",
        "D. 诊断名比病历能支撑的更具体：按公认诊断标准，这个名称必须依赖某项检查结果才能成立，或必须满足病程门槛，而病历里既没有记录这项检查的结果，已记录的病程也够不上门槛。典型的如：缺铁性贫血、巨幼细胞贫血等指明贫血类型的名称需要相应检查（只有血红蛋白只能说贫血）；多囊卵巢综合征需要鹿特丹标准三项中至少两项；甲状腺功能减退症、糖尿病等以化验定义的病需要相应化验结果；慢性胃炎、消化性溃疡需要胃镜；骨质疏松症需要双能X线骨密度（DXA）结果或脆性骨折史（X线片描述「骨质疏松」不够，写“骨质疏松待查”）；某种特定病原体感染需要病原学结果；功能性消化不良、肠易激综合征、功能性便秘的时间门槛：成人是起病至今满6个月——病程写满6个月（主诉里的“半年”“1年余”“1+年”“2年”都算）就满足，不要求病历另写“持续3个月”，也不要求做过胃镜；未满18岁的患者按罗马IV儿童标准，功能性便秘满1个月、功能性消化不良和肠易激综合征满2个月就满足，不得套用成人的6个月；没满门槛时 supportedName 写“消化不良待查”“便秘待查”这类上一级名称（不写成单个症状）；功能性便秘、肠易激综合征是排除性诊断：50岁及以上起病、或有报警征象（便血、黑便、消瘦、贫血、近期排便习惯改变）的，病历没有结肠镜结果就属 D（写“便秘待查”“腹痛待查”这类上一级名称）；肠易激综合征还必须有腹痛；牙病的分型名称（急性牙髓炎、慢性牙髓炎、急性根尖周炎、牙周脓肿、智齿冠周炎等）需要口腔专科检查（牙髓活力或冷热测试、叩诊、牙周探诊、X线）才能分型，病历没有口腔检查记录时只能写“牙痛”；病历记录了叩诊、松动度、牙周探诊、牙髓测试或X线所见中任何一项的，就是做过口腔检查，不适用 D。",
        // 2026-10-19 第九轮（D 集 113 例不合格里 23 例是核对把有依据的病名换成「X待查」）：核对只问「金标准检查有没有做」，造影、X线、
        // 活检里的特征性所见和临床诊断标准都被当成没有依据。先找依据再判：decisive 逐字引病历里对该病名最有诊断价值的一项客观依据，
        // meetsCriteria 判这一项连同其余记录是否已够得上名称所说的程度；够了不得判 D（服务端据 decisive 逐字核对后否决 D）。
        "D 的前置核对（判 D 之前先做）：先在病历里找对这个病名最有诊断价值的一项客观依据——特征性的影像、造影或超声所见，病理或活检所见，确诊性化验或化验组合，或公认诊断标准里能数够条目的典型体征与病史组合——逐字写进 decisive（只能是检查、化验、影像、病理的结果，或查体得到的阳性体征；患者自述的症状、病程、病史不算，没有就写空串，meetsCriteria 写 false）；再判断这一项连同病历其余记录，按公认诊断标准是否已经够得上**这个病名所说的具体程度**，写进 meetsCriteria（true/false）。诊断标准的全部条件都要数：病程门槛、排除性诊断所需的排除（50岁及以上起病或有报警征象须有结肠镜之类）、定义性表现，缺任何一项就是 false，这时才可以判 D。meetsCriteria 为 true 时不得判 D。criteria 是带出处的诊断要点表（有 source 字段）、clinicallyDiagnosable 为 false 且 requiredTests 不为空时，表是公认标准的当前版本：只有病历里已有 requiredTests 中某一项的结果（或表里写明的替代条件）时 meetsCriteria 才能为 true，典型表现和支持性化验（嗜酸性粒细胞、IgE、红细胞形态等）不能顶替。表里没有该病（criteria 为空或只是 searchExcerpts）时按下面的原则自己判断。诊断标准允许临床诊断的病，凭典型症状加特征体征、或典型表现加一项支持性影像或化验就成立（如瓣膜病和先天性心脏病凭典型杂音与胸片或心电图，血栓闭塞性脉管炎凭病史与肢体体征，风湿热凭主要表现加前驱咽峡炎，贲门失弛缓症凭食管造影所见）；criteria 或检索摘录里写“金标准是X”“X可确诊”，不等于没做X就不能下这个病名，只有诊断标准明文写“须…才能诊断”的检查、病历又没有时才属 D。D 只用于名称指明的病种、病原、分型、病因、程度，病历里确实没有任何一项支持它的客观依据的情形。",
        "以下情况一律判 consistent：门诊常见病按典型临床表现即可诊断、诊断标准本来不要求某项检查（如上呼吸道感染、急性支气管炎、急性胃肠炎、带状疱疹、荨麻疹、湿疹、偏头痛和紧张型头痛（criteria 给了 featureRule 时按它数特征）、失眠障碍、腰肌劳损、原发性痛经；有烧心或反酸、反流症状的胃食管反流病；有典型发作性胸痛的心绞痛或冠心病；有长期饮酒史并有肝脏影像或肝功能异常的酒精性肝病），这时没做检查不算问题；贫血按病历已记录的原因命名（产后贫血、失血性贫血、月经过多所致贫血）不算过度具体；名称是急危重症（如蛛网膜下腔出血、急性心肌梗死、主动脉夹层、异位妊娠、脑卒中、休克、化脓性脑膜炎、脓毒症）时不适用 D；检查只有非特异性改变、不能确诊也不能排除；结果正常但该病在此阶段结果本来就可以正常（如痛风急性发作期血尿酸可以正常、冠心病静息心电图可以正常）；病历里写明的既往确诊（如“高血压病史10年”“胃镜示慢性胃炎”）；病历已记录支持该诊断的关键化验或检查结果（如甲亢已有 T3、T4 升高），只是还缺另一项补充检查；病历写明已在医院做过相关检查、结果正常或未见异常的（如“心内科完善相关检查后未见明显异常”），即使没有逐项列出、未见报告原件，也按已有检查结果对待，不适用 D；病历已经记录了确诊这个病的病理或活检所见、特征性影像或造影所见、或分级所需的测量值（如活检见癌细胞与病理核分裂、关节造影示盘不可复、X线示骨吸收与牙周袋），不适用 D，也不得改成上一级或“待查”；阴性结果本身不能排除该病的检查（如痰脱落细胞学、单次培养、早期影像）记录为阴性，不属于 A；你只是觉得另一个诊断更可能。拿不准时判 consistent。",
        "判 inconsistent 时给出：missingTest（只用于 D：缺的那一项检查，写检查名称本身，不超过20字，如“血清铁蛋白”“结肠镜”“牙髓活力测试”；缺的是病程时写这个病确诊前可以开出的检查、量表或记录，如功能性消化不良写“胃镜”、功能性便秘写“排便日记”，不写“随访至病程满N个月”这类等待病程的说法），quote（A、B、C 写病历里与之矛盾的那句原文；D 写病历里支撑上一级病名的那句原文；逐字复制，不超过40字）、reason（一句话说明为什么不符或缺什么，≤30字）和 supportedName。supportedName 只能是下面两种之一：① 比原诊断更宽一层或更轻一层、现有记录已经够得上的规范病名（如“贫血”“月经稀发”“妊娠呕吐”“关节炎”“牙痛”，这些是病名，不加“待查”）；这一级只剩单个症状时写成症状加“待查”（如“乏力待查”“消化不良待查”）；D 类先看是不是只有名称里的某个限定（病原、分型、病因、梗阻性、程度、定位）没有依据——是，就去掉这个限定，写去掉后病历够得上的病名（如“肥厚型梗阻性心肌病”缺流出道压差，写“肥厚型心肌病”；“肺炎链球菌肺炎”无病原学，写“肺炎”），不加“待查”；原名是“病名伴症状”（如“支气管扩张伴咯血”）而缺的是病名的确诊依据时，写“病名待查”（“支气管扩张待查”），不退到症状；② 指不出这样的病名时：D 类写原诊断名加“待查”（如“多发性骨髓瘤待查”，表示首要考虑不变、尚未确诊）；A、B、C 类写病历里最主要的症状加“待查”（如“关节痛待查”“血尿待查”）。不得换成病历同样没有证实的另一个具体病种，不得写比原诊断更重的名称，不带括号和解释。",
        // 2026-10-19：A、B 类允许改成西医半自己列出的、病历检查所见已经指向的那个病（服务端只认名单里逐字有的名称）；
        // 「上一级」本身有依据时不挂「待查」；另报原名是否急危重症，红旗病例据此不把急危重病名改掉。
        "例外：A、B 类里，病历记录的检查所见本身就是另一个病的确诊依据或特征性表现（如活检、典型影像征象、确诊性化验），而这个病就在输入的 listedDiagnoses 里时，supportedName 直接写这个病（逐字照抄名单里的写法），quote 写那句检查所见。上一级病名本身已有记录支持时（如“急性尿潴留”的上一级“尿潴留”）不要再加“待查”。",
        "另给出 emergencyName：原诊断名属于需要立即处理的急危重症（如急性心肌梗死、急性胰腺炎、消化道穿孔、休克、异位妊娠、脑卒中、主动脉夹层、颅内血肿）时为 true，否则为 false。",
        // 2026-10-18：诊断标准要点来自受治理要点表或权威页面的检索摘要（western-diagnostic-criteria.server.ts），让情形 D 不再只靠上面手写的十几个病。
        "如果输入里给了 criteria（该诊断名的诊断标准要点，摘自诊疗手册、指南等权威来源）：clinicallyDiagnosable 为 true 的病按典型临床表现即可诊断，不适用 D；requiredTests 不为空时，病历里没有其中任何一项检查的结果、也不是病历写明的既往确诊，才符合 D；requiredTests 写了适用条件的（如“50岁及以上起病…时需结肠镜”），只在本例符合该条件时才要求这项检查；durationThreshold 写了病程门槛时按它判断病程够不够；definingFeatures 是定义性表现，病历已记录与之相反时属 B；有 featureRule 的（如紧张型头痛、偏头痛按国际头痛分类第3版数特征），病历记录到的特征不够它要求的项数时属 D；有 requiredHistory 的（如反应性关节炎起病前数周的腹泻或尿道炎），病历既没有记录这段病史、也没有它写的特征性表现时属 D；这两种 D 的 supportedName 写主要症状加“待查”（如“头痛待查”“关节痛待查”）。criteria 里是检索摘录（searchExcerpts）时，只把摘录里明确写出的必需检查或病程门槛当依据。criteria 与上面的通则冲突时以上面的通则为准（急危重症不用 D、病历写明的既往确诊不算）。没有 criteria 时按上面的通则判断。",
        "只输出 JSON，decisive 与 meetsCriteria 写在最前：{\"decisive\":\"…\",\"meetsCriteria\":true|false,\"verdict\":\"consistent|inconsistent\",\"type\":\"A|B|C|D|\",\"quote\":\"…\",\"reason\":\"…\",\"supportedName\":\"…\",\"missingTest\":\"…\",\"emergencyName\":true|false}",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        patient: { sex: input.patient?.sex ?? null, age: input.patient?.age ?? null },
        record: recordText,
        diagnosisName,
        ...(criteria ? { criteria } : {}),
        ...(input.listedNames && input.listedNames.length > 0 ? { listedDiagnoses: [...input.listedNames] } : {}),
      }),
    },
  ];
  const parseOptions = { listedNames: input.listedNames, patientAge: patientAgeYears(input.patient?.age) };
  const run = (requestMessages: typeof messages) =>
    westernNameCheckPass(requestMessages, config, recordText, diagnosisName, parseOptions, signal);
  if (!agreementRequired()) {
    const only = await run(messages);
    return { correction: only, first: only, agreement: "off" };
  }
  // 第二次：内容顺序整个颠倒（键序、鉴别名单顺序），说明不变。
  const reversedMessages = [
    messages[0],
    {
      role: "user" as const,
      content: JSON.stringify({
        ...(input.listedNames && input.listedNames.length > 0 ? { listedDiagnoses: [...input.listedNames].reverse() } : {}),
        ...(criteria ? { criteria } : {}),
        diagnosisName,
        record: recordText,
        patient: { age: input.patient?.age ?? null, sex: input.patient?.sex ?? null },
      }),
    },
  ];
  const [first, second] = await Promise.all([run(messages), run(reversedMessages)]);
  const { correction, agreement } = agreedWesternNameCorrection(first, second);
  return { correction, first, second, agreement };
}

async function westernNameCheckPass(
  messages: ReadonlyArray<{ role: "system"; content: string } | { role: "user"; content: string }>,
  config: ReturnType<typeof getControlledTerminologyModelConfig>,
  recordText: string,
  diagnosisName: string,
  parseOptions: { listedNames?: readonly string[]; patientAge?: number },
  signal?: AbortSignal,
): Promise<WesternNameCorrection | undefined> {
  return memoizedSmallTask<WesternNameCorrection | undefined>("western_name_evidence_check", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task: "western_name_evidence_check", stage: "diagnose", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 340,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages: [...messages],
      }, { signal: controller.signal }));
      const content = response.choices[0]?.message?.content;
      return { value: parseWesternNameCorrection(content, recordText, diagnosisName, parseOptions), cacheable: typeof content === "string" && content.trim().length > 0 };
    } catch {
      return { value: undefined, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, undefined, signal);
}

/**
 * 不需要模型就能判的两种名称与病历不符（2026-10-24 甲方 100 例）：
 *  · 「慢性X」（含「慢性X待查」）而病历病程没满表里该病的门槛：C052 风团 2 周写「慢性荨麻疹待查」（门槛 6 周）。
 *    表里有「急性X」就写它，没有就去掉「慢性」。「X待查」以前一律不核对，病程门槛因此从未生效。
 *  · 「新生儿X」而患儿已超过 28 天：C071 2 月龄写「新生儿败血症」。满 1 岁写「小儿X」，不满 1 岁写「婴儿X」。
 */
export function deterministicWesternNameCorrection(name: string, recordText: string, patientAge?: number): WesternNameCorrection | undefined {
  const trimmed = name.trim();
  const core = trimmed.replace(/待查$/u, "");
  if (/^慢性/u.test(core)) {
    const entry = westernCriteriaEntry(core);
    const child = typeof patientAge === "number" && Number.isFinite(patientAge) && patientAge < 18;
    const threshold = child ? entry?.courseThresholdDays?.under18 ?? entry?.courseThresholdDays?.adult : entry?.courseThresholdDays?.adult;
    const course = recordCourseDays(recordText);
    if (entry && threshold && course && course.upper < threshold) {
      const base = core.replace(/^慢性/u, "");
      const acute = `急性${base}`;
      const supportedName = westernCriteriaEntry(acute)?.name === acute ? acute : base;
      if (compact(supportedName) !== compact(trimmed)) {
        return {
          type: "D",
          supportedName,
          quote: chiefComplaintLine(recordText) || core,
          reason: `病程未满${threshold % 30 === 0 ? `${threshold / 30}个月` : threshold % 7 === 0 ? `${threshold / 7}周` : `${threshold}天`}`,
          course: course.upper < threshold / 4 ? "far_below" : "unmet",
          ...(entry.courseNextCheck ? { courseNextCheck: entry.courseNextCheck, missingTest: entry.courseNextCheck } : {}),
        };
      }
    }
  }
  if (/新生儿/u.test(trimmed) && typeof patientAge === "number" && Number.isFinite(patientAge) && patientAge > 28 / 365) {
    return {
      type: "B",
      supportedName: trimmed.replace(/新生儿/gu, patientAge >= 1 ? "小儿" : "婴儿"),
      quote: chiefComplaintLine(recordText) || trimmed,
      reason: "患儿已超出新生儿期（出生28天内）",
    };
  }
  return undefined;
}

/**
 * 西医半返回后的收口：核对病名，采信则改写西医半的输出；任何失败都原样返回。
 * redFlag：确定性闸门判了红旗时不用情形 D——急危重的病名（蛛网膜下腔出血、异位妊娠）在检查出来之前本来就该先按它处置，
 * 改成「待查」会把医生的注意力从必须排除的病上移开。A–C（病历已记录的内容与病名相反）照常，但原名属急危重症时见 heldOnRedFlag。过滤放在缓存之外，
 * 同一份病历的核对结果在红旗与非红旗请求之间共用缓存也不会串。
 */
export async function alignWesternNameWithRecord(
  westernContent: string,
  context: { recordText: string; patient?: { sex?: unknown; age?: unknown }; redFlag?: boolean },
  signal?: AbortSignal,
): Promise<string> {
  if (!enabled()) return westernContent;
  let name = "";
  let listedNames: string[] = [];
  try {
    const western = record(JSON.parse(westernContent))?.westernDiagnosis;
    name = String(record(record(western)?.primary)?.name || "").trim();
    listedNames = listedWesternDiagnosisNames(western);
  } catch {
    return westernContent;
  }
  if (!name) return westernContent;
  const ruled = deterministicWesternNameCorrection(name, context.recordText, patientAgeYears(context.patient?.age));
  if (ruled) {
    console.info("[tcm-cdss:telemetry] western_name_evidence_check", { applied: true, type: ruled.type, deterministic: true, currentName: name.slice(0, 30), supportedName: ruled.supportedName.slice(0, 30) });
    return applyWesternNameCorrection(westernContent, ruled);
  }
  // 「反应性关节炎待查」「紧张型头痛待查」：待查的是一个靠特征计数或前驱病史成立的病（要点表有 featureRule / requiredHistory），
  // 病历连这些都没有时「原病名待查」本身就说过头了（2026-10-19 留出例 S079，复核：病历无前驱泌尿生殖道或肠道感染史）。这类按去掉「待查」
  // 的病名核对；其余「X待查」照旧不核对。
  const pendingCore = name.replace(/待查$/u, "");
  const pendingEntry = pendingCore !== name ? westernCriteriaEntry(pendingCore) : undefined;
  const checkName = pendingEntry && (pendingEntry.featureRule || pendingEntry.requiredHistory) ? pendingCore : name;
  const outcome = await westernNameCheckOutcome({ recordText: context.recordText, diagnosisName: checkName, patient: context.patient, listedNames }, signal);
  const checked = outcome.correction;
  // 核对给回的就是原来的「X待查」：没有改动。
  const found = checked && compact(checked.supportedName) !== compact(name) ? checked : undefined;
  const correction = found && !(context.redFlag && heldOnRedFlag(found, checkName)) ? found : undefined;
  const passLabel = (item: WesternNameCorrection | undefined) => (item ? `${item.type}:${item.supportedName.slice(0, 30)}` : "-");
  console.info("[tcm-cdss:telemetry] western_name_evidence_check", {
    applied: Boolean(correction),
    type: found?.type,
    heldForRedFlag: Boolean(found && !correction),
    adoptedFromList: Boolean(found?.adoptedFromList),
    currentIsEmergency: Boolean(found?.currentIsEmergency),
    // 病名不是患者信息；记下来是为了能把改名归到病例上（10/19 分析验收集时只有类型码，归不了因）。
    currentName: name.slice(0, 30),
    supportedName: found ? found.supportedName.slice(0, 30) : undefined,
    // 两次核对的结论与是否一致（第十轮 B3）：统计一致率、看哪些边界病例两次不一致而未改名。
    agreement: outcome.agreement,
    firstPass: passLabel(outcome.first),
    secondPass: passLabel(outcome.second),
  });
  if (!correction) return westernContent;
  // 按去掉「待查」的病名核对时，原病名那条鉴别与候选写病名本身（「反应性关节炎」），不写「反应性关节炎待查」。
  return applyWesternNameCorrection(checkName === name ? westernContent : withPrimaryName(westernContent, checkName), correction);
}

function withPrimaryName(westernContent: string, primaryName: string): string {
  try {
    const parsed = JSON.parse(westernContent);
    const western = record(record(parsed)?.westernDiagnosis);
    const primary = record(western?.primary);
    if (!western || !primary) return westernContent;
    const before = primary.name;
    primary.name = primaryName;
    if (Array.isArray(western.candidates)) {
      western.candidates = western.candidates.map((item) => (record(item)?.name === before ? { ...record(item), name: primaryName } : item));
    }
    return JSON.stringify(parsed);
  } catch {
    return westernContent;
  }
}

/**
 * 红旗病例上不采信的改名：D 类一律不采信（见上）；A–C 类在原名属急危重症时，只允许改成西医半自己列过的病，或同一类病的上一级
 *（「神经源性休克」→「休克待查」）——不把急危重病名换成症状（2026-10-19，验收集 X-D-0529 急性胰腺炎凭「血淀粉酶<500」被改成「腹痛」，
 * 淀粉酶不高本来就排除不了胰腺炎）。
 */
function heldOnRedFlag(found: WesternNameCorrection, currentName: string): boolean {
  // 「原病名待查」只是标明未确诊、首要考虑不变（食管癌→食管癌待查），不会把注意力移开；原名不是急危重症时照常采信
  //（2026-10-24 甲方 100 例 C019：进行性吞咽困难红旗例，未做胃镜即交付「食管癌」）。
  if (found.type === "D") return Boolean(found.currentIsEmergency) || compact(found.supportedName) !== compact(`${currentName}待查`);
  return Boolean(found.currentIsEmergency) && !found.adoptedFromList && !namesSameDiseaseFamily(found.supportedName, currentName);
}
