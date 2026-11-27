import { establishedHistoryText } from "./western-encounter-primary";
import { westernCriteriaEntry } from "./western-criteria-table";
import { recordCourseBelowThreshold, recordCourseDays } from "./western-record-course";
import certaintyPolicy from "../data/western-certainty-policy.source.json";
import testNameGroupsJson from "../data/clinical-test-name-groups.source.json" with { type: "json" };
import textConsistency from "../data/diagnosis-text-consistency.source.json" with { type: "json" };
import { westernDiagnosisAbbreviations } from "./western-diagnosis-aliases";
import { recordMentionPolarityAt } from "./diagnosis-safety";
import { settleWesternRecurrenceQualifier } from "./western-recurrence-qualifier";
import westernNamePreferred from "../data/western-name-preferred.source.json" with { type: "json" };
import establishmentWords from "../data/western-establishment-check.source.json" with { type: "json" };

/**
 * 西医依据里说「尚缺/未查 X 检查」、而病历已经写了 X 的结果（第四十一轮，r1054 回顾 n12：病历「肌酸激酶正常，甲状腺功能正常，
 * 肌电图未见明显异常」，依据仍写「尚缺肌酶、肌电图、甲状腺功能等系统检查，需完善以明确病因」）。
 * 只删与病历矛盾的那几项；全删空时这一小句不留，紧跟的「需完善以明确…」一并不留。不新增任何检查或结论。
 * 检查名的同项写法见 clinical-test-name-groups.source.json（有限闭集）。
 */
const GROUPS: readonly (readonly string[])[] = (testNameGroupsJson as { groups: string[][] }).groups;
const MISSING_CLAIM = /^(\s*(?:但|然而)?)(尚缺|缺少|尚未完善|未完善|尚未行|尚未做|未查|未行|未做|未复查|本次未复查|需完善|尚需完善|需)([^，,。；;]{2,80})$/u;
/** 列举之后的「等系统检查」「以明确病因」这段尾巴（不属于检查名）。 */
const CLAIM_TAIL = /(?:等)?(?:系统|相关|进一步)?(?:检查|结果|化验|评估)[^，,。；;]*$|等[^，,。；;]*$/u;
const PENDING_IN_CLAUSE = /未(?:复)?查|未做|未行|未完善|待查|待完善|拟查|建议(?:查|行|做)|尚缺|需完善/u;

function groupFor(item: string, exact = false): readonly string[] | undefined {
  const name = item.trim().replace(/^(?:血清|检查)/u, "").replace(/(?:检查|结果|确认|确诊)+$/u, "");
  if (!name) return undefined;
  return GROUPS.find((group) => group.some((alias) => alias.toLowerCase() === name.toLowerCase())) || (exact ? undefined :
    GROUPS.find((group) => group.some((alias) => alias.length >= 2 && (name.includes(alias) || alias.includes(name)) && Math.min(alias.length, name.length) >= 2)));
}

function recordHasResult(recordText: string, group: readonly string[], currentOnly = false): boolean {
  const text = String(recordText || "").normalize("NFKC");
  const lower = text.toLowerCase();
  // 超声写作“B超：胆总管…”时，器官限定在检查结果内；不拿别的部位的B超抵胆道检查。
  if (group.includes("胆道影像学") && /(?:B超|超声)[：:]?[^。；;\n]{0,35}胆(?:总管|管|道)/u.test(text) &&
      !/(?:未查|拟查|建议)[^。；;\n]{0,8}(?:B超|超声)/u.test(text)) return true;
  return group.some((alias) => {
    const needle = alias.toLowerCase();
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
      // 拉丁缩写要整词（「CK」不算「CKD」里的）。
      if (/^[a-z]/iu.test(alias) && (/[a-z]/iu.test(text[at - 1] || "") || /[a-z]/iu.test(text[at + alias.length] || ""))) continue;
      if (recordMentionPolarityAt(text, at) !== "affirmed") continue;
      const left = Math.max(...["，", ",", "。", "；", ";", "\n"].map((mark) => text.lastIndexOf(mark, at - 1))) + 1;
      const rights = ["，", ",", "。", "；", ";", "\n"].map((mark) => text.indexOf(mark, at)).filter((index) => index >= 0);
      const clause = text.slice(left, rights.length > 0 ? Math.min(...rights) : text.length);
      if (PENDING_IN_CLAUSE.test(clause) || certaintyPolicy.pendingTestMarkers.some((marker) => clause.includes(marker))) continue;
      if (currentOnly && (/既往|曾查|去年|年前/u.test(clause) ||
          [...clause.matchAll(/(?:19|20)\d{2}(?=年|[-/])/gu)].some((match) => Number(match[0]) < new Date().getUTCFullYear()))) continue;
      return true;
    }
    return false;
  });
}

/** 病历里已有这一项检查（按同项写法表认）的肯定、非待查记载（第四十二轮：西医确立程度核对据此不问已查过的病）。 */
export function recordHasTestResultFor(testName: string, recordText: string): boolean {
  const group = groupFor(testName);
  return Boolean(group && recordHasResult(recordText, group));
}

export function withoutMissingClaimsForRecordedTests(text: string, recordText: string): string {
  const source = String(text || "");
  if (!source || !recordText || !/尚缺|缺少|未完善|未查|未行|未做|未复查|需|尚未/u.test(source)) return source;
  const parts = source.split(/([，,。；;])/u);
  const out: string[] = [];
  let dropNextFollowUp = false;
  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index] ?? "";
    const separator = parts[index + 1] ?? "";
    if (dropNextFollowUp && /^\s*(?:需完善|以明确|完善后|明确病因)/u.test(clause)) {
      dropNextFollowUp = false;
      if (out.length > 0 && separator) out[out.length - 1] = out[out.length - 1].replace(/[，,；;]$/u, separator);
      continue;
    }
    dropNextFollowUp = false;
    const match = MISSING_CLAIM.exec(clause);
    if (!match) {
      out.push(clause + separator);
      continue;
    }
    const [, lead, verb, rest] = match;
    // “需排除/需复查”是鉴别或复查计划，不是缺少已有检查。只有纯检查名的“需X确认”可在已有结果时撤去。
    if (verb === "需" && (!/确认[。\s]*$/u.test(rest) || /排除|复查|见|或|捕捉|发作|结合|评估/u.test(rest))) {
      out.push(clause + separator);
      continue;
    }
    // 内嵌括号含逗号时不逐半句裁剪，避免“但尚缺骨赘等）”一类残句。
    if (/[（(）)]/u.test(rest)) { out.push(clause + separator); continue; }
    const tailMatch = CLAIM_TAIL.exec(rest);
    const object = tailMatch ? rest.slice(0, tailMatch.index) : rest;
    const tail = tailMatch ? tailMatch[0] : "";
    const items = object.split(/、|及|和|与/u).map((item) => item.trim()).filter(Boolean);
    const kept = items.filter((item) => {
      // 完整检查名比较：具体分级/滴度、其它部位的影像，不是同一个检查结果。
      const testName = item.replace(/(?:等|检查|结果|确认)+$/u, "");
      const group = testNameGroupsJson.missingClaimAliases.find((aliases) => aliases.includes(testName)) || groupFor(testName, true);
      return !group || !recordHasResult(recordText, group, verb.includes("复查"));
    });
    if (kept.length === items.length) {
      out.push(clause + separator);
      continue;
    }
    if (kept.length === 0) {
      dropNextFollowUp = true;
      // 删掉的小句后面是句号时，把句号挪给前一小句。
      if (/[。；;]/u.test(separator) && out.length > 0) out[out.length - 1] = out[out.length - 1].replace(/[，,]$/u, separator);
      continue;
    }
    out.push(`${lead}${verb}${kept.join("、")}${tail}${separator}`);
  }
  const joined = out.join("").replace(/^[，,；;。\s]+/u, "").replace(/[，,；;]{2,}/gu, "，").replace(/[，,；;]+。/gu, "。");
  return joined.trim() || source;
}

/**
 * 病历肯定写着这个诊断（原词，或更具体的写法：「慢性浅表性胃炎」写着「慢性胃炎」），不是否认、不是别人的（家族史）、也不是「可疑/待排」。
 * 只用同一小句里按字序出现、中间至多隔 4 字的写法，「慢性咳嗽，胃炎」不算。（第四十四轮从 western-name-evidence-check.server 移到这里：
 * 交付面改写依据句也要用同一判据，交付面会进浏览器包，不能引 server-only 模块。）
 */
const UNCERTAIN_NEAR_DIAGNOSIS = /可疑|疑似|待排|待查|可能|\?|？|除外|排除/u;
export function recordStatesWesternDiagnosis(name: string, recordText: string): boolean {
  // 分期、并发症写在后面的按病本身看（支气管哮喘急性发作：病历写着支气管哮喘），第三十五轮 W03。
  const core = name.trim().replace(/待查$/u, "").normalize("NFKC").replace(/(?:急性发作|急性加重|慢性迁延期|伴[\u4e00-\u9fff]+|合并[\u4e00-\u9fff]+)$/u, "");
  if (core.length < 3) return false;
  const source = recordText.normalize("NFKC");
  const pattern = new RegExp([...core].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^，,。；;：:、\\n]{0,4}"), "gu");
  for (const match of source.matchAll(pattern)) {
    const at = match.index ?? 0;
    const clauseStart = Math.max(...["，", ",", "。", "；", ";", "\n"].map((mark) => source.lastIndexOf(mark, at - 1))) + 1;
    const clauseEnds = ["，", ",", "。", "；", ";", "\n"].map((mark) => source.indexOf(mark, at + match[0].length)).filter((index) => index >= 0);
    const clause = source.slice(clauseStart, clauseEnds.length > 0 ? Math.min(...clauseEnds) : source.length);
    if (UNCERTAIN_NEAR_DIAGNOSIS.test(clause)) continue;
    if (recordMentionPolarityAt(source, at) === "affirmed") return true;
  }
  return false;
}

/** 多年血压升高且正在降压治疗的记录，不再要求首次诊断的三次测压。闭集，仅决定文字确定度。 */
export function recordStatesTreatedHypertension(name: string, recordText: string): boolean {
  const rule = textConsistency.treatedHypertension;
  const core = name.replace(/待[查排]$/u, "");
  if (!rule.names.includes(core)) return false;
  const source = String(recordText || "").normalize("NFKC");
  const history = rule.recordNames.some((term) => {
    const at = source.indexOf(term);
    return at >= 0 && recordMentionPolarityAt(source, at) === "affirmed" && /\d+\s*年/u.test(source.slice(at, at + term.length + 12));
  });
  return history && source.split(/[。；;\n]/u).some((line) => (/用药史|现用药|正在(?:使用|服用)|长期(?:使用|服用)/u.test(line) || /\d+(?:\.\d+)?\s*(?:mg|毫克|片|粒)/iu.test(line)) &&
    rule.medicines.some((medicine) => {
      const at = line.indexOf(medicine);
      const clause = line.slice(Math.max(line.lastIndexOf("，", at), line.lastIndexOf(",", at)) + 1).split(/[，,]/u)[0];
      return at >= 0 && recordMentionPolarityAt(line, at) === "affirmed" && !rule.pastMedicationMarkers.some((marker) => clause.includes(marker));
    }));
}

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const SUBLEVEL = /病因|部位|病原|分型|程度|分级|分期|并发|出血点|性质/u;
const CONFIRMATION_GAP = /(?:尚缺|缺少|尚需|仍需|有待|尚未行|尚未做|未查|需[^，。；;]{0,28}(?:方可|才能|方能))[^，。；;]*(?:确认|确诊|确立|明确诊断)|(?:方可|才能|方能)(?:确诊|确立|诊断)|需[^，。；;]{1,30}(?:确认|确诊|明确诊断)/u;
const CLINICAL_ESTABLISHMENT = /可(?:以)?临床诊断|临床(?:即)?可(?:以)?诊断|可凭临床诊断|临床诊断(?:成立|明确)|符合[^，。；;]{0,12}诊断标准/u;

/** 依据自己明确说还不能确立这个病名；病因/分型检查与病名本身分开。 */
export function basisSaysNameNotEstablished(basis: string, name: string): boolean {
  const core = name.normalize("NFKC").replace(/\s+/gu, "").replace(/(?:待[查排]|可能)$/u, "");
  if (core.length < 2 || !basis) return false;
  const source = basis.normalize("NFKC");
  const escaped = escapePattern(core);
  if (new RegExp(`${escaped}[^。；;]{0,8}?(?:尚未确立|尚不能确立|尚不能诊断|不能确诊|尚未明确诊断|诊断未确立|诊断依据不足)|(?:尚未确立|尚不能确立|尚不能诊断)[^。；;]{0,6}${escaped}|后(?:方可|才能)诊断${escaped}`, "u").test(source)) return true;
  // 「分型」不能遮住同句的「方能确立X」（ACS、DKA）。
  if (new RegExp(`(?:方可|才能|方能)(?:确诊|确立|诊断)${escaped}`, "u").test(source)) return true;
  if (new RegExp(`${escaped}(?:诊断)?尚缺[^，,。；;]{0,12}(?:评估|检查)[^，,。；;]{0,6}排除`, "u").test(source)) return true;
  // 「诊断药物性皮炎尚缺停药后皮疹消退观察及药物激发试验」（第五十九轮 r1077 P023：病名写确诊、依据句却说诊断它还缺东西）。
  // 只认「诊断＋病名＋尚缺」「病名＋的诊断＋尚缺」两种直说诊断本身缺依据的写法；缺的是病因、分型、部位这类下位信息的不算。
  const diagnosisLacks = new RegExp(`(?:诊断${escaped}|${escaped}的诊断)(?:尚|仍|还)缺([^，,。；;]{0,30})`, "u").exec(source);
  if (diagnosisLacks && !SUBLEVEL.test(diagnosisLacks[1])) return true;
  const gaps = source.split(/[。；;]/u).filter((clause) => CONFIRMATION_GAP.test(clause) && !SUBLEVEL.test(clause));
  if (gaps.length > 0) return true;
  if (CLINICAL_ESTABLISHMENT.test(source)) return false;
  return new RegExp(`考虑${escaped}(?:的)?可能|可能为${escaped}|${escaped}(?:的)?可能(?:性)?(?:大|较大)?[，；。]|(?:疑诊|拟诊|疑为|怀疑)${escaped}|${escaped}[^，。；;]{0,12}待(?:查|排)`, "u").test(source);
}

/** 儿童反复呼吸道感染标准不适用于成人的推测病名。 */
export function pediatricOnlyWesternName(name: string): boolean {
  return /^反复(?:上|下)?呼吸道感染/u.test(name.trim().replace(/待查$/u, ""));
}

function hypothesisFitsPatient(name: string, recordText: string): boolean {
  const ageText = /年龄[：:]?\s*(\d+)岁/u.exec(recordText)?.[1];
  const age = ageText ? Number(ageText) : undefined;
  if (age !== undefined && age >= 18 && pediatricOnlyWesternName(name)) return false;
  const days = westernCriteriaEntry(name)?.courseThresholdDays;
  if (!days) return true;
  const minimum = age !== undefined && age < 18 ? days.under18 ?? days.adult : days.adult;
  const course = recordCourseDays(recordText);
  return !minimum || !course || !recordCourseBelowThreshold(course, minimum) || recordStatesWesternDiagnosis(name, recordText);
}

const COURSE_GAP_PREFIX = "病程未满";

export function westernCriteriaCertainty(name: string, recordText: string, known = false): { pending: boolean; missing: string[]; courseMet?: boolean; clinicalOnly?: boolean; regionalImagingRecorded?: boolean } | undefined {
  const entry = westernCriteriaEntry(name);
  if (!entry) return undefined;
  if (known) return { pending: false, missing: [] };
  const age = /(?:年龄[：:]?\s*|患者[^\n]{0,12}?)(\d+)岁/u.exec(recordText);
  const child = age && Number(age[1]) < 18;
  const threshold = child ? entry.courseThresholdDays?.under18 ?? entry.courseThresholdDays?.adult : entry.courseThresholdDays?.adult;
  const course = recordCourseDays(recordText);
  const missing: string[] = [];
  // 病程门槛按月写（「病程未满6个月」），不写「尚缺病程满180天的记录」——复核员判机械句（第四十八轮 n16）。
  if (threshold && (!course || course.lower < threshold)) missing.push(`${COURSE_GAP_PREFIX}${Math.round(threshold / 30)}个月`);
  const imaging = (certaintyPolicy.regionalImaging as Record<string, string[]>)[entry.name];
  const regionalImagingRecorded = imaging && recordHasResult(recordText, imaging);
  // 检查存在仅消除“尚缺检查”。要用这条规则支持病名，还须是同一份报告对该病的肯定记载。
  const imagingSupportsName = !imaging || recordText.split(/[。；;\n]/u).some(report =>
    recordHasResult(report, imaging) && recordStatesWesternDiagnosis(entry.name, report));
  if (imaging && !regionalImagingRecorded) missing.push(imaging[0]);
  if (!imaging && !entry.clinicallyDiagnosable) {
    const groups = (certaintyPolicy.testGroups as Record<string, string[][]>)[entry.name];
    if (groups) {
      for (const group of groups) if (!group.some((test) => recordHasTestResultFor(test, recordText))) missing.push(group[0]);
    } else {
      // 要点表的 requiredTests 多是整句说明（「已有可靠COPD诊断记录；初次确认需肺功能…」「既往脑梗死明确诊断记录/影像依据…」），
      // 只认其中能按同项写法表精确认出的检查名；一项都认不出时表不下结论，沿用现行判据（第四十八轮：整句当缺项把
      // 既往确诊的脑梗死后遗症、乙肝肝硬化改成待查，又按整句模糊匹配把只有一项主要表现的风湿热的待查去掉）。
      // 16 字以内的条目是检查名（「头颅CT平扫」「腰穿脑脊液分析」），更长的是说明句，整条不用。
      const tests = [...new Set(entry.requiredTests.filter((test) => test.trim().length <= 16)
        .flatMap((test) => test.replace(/[（(][^）)]*[）)]/gu, "").split(/[、，,/或及和]/u))
        .map((test) => test.trim()).filter((test) => test.length >= 2 && groupFor(test)))];
      if (!tests.length) {
        if (!threshold) return undefined;
      } else if (!tests.some((test) => recordHasTestResultFor(test, recordText))) {
        missing.push(tests[0]);
      }
    }
  }
  const low = certaintyPolicy.lowGlucoseConfirmation;
  if (entry.name === low.name && ![...recordText.normalize("NFKC").matchAll(new RegExp(low.pattern, "giu"))].some((match) => Number(match[1]) < low.below)) missing.push(low.missing);
  // 可凭临床诊断、又没有病程门槛的病：要点表本身不给结论（clinicalOnly），由依据句自己的表态定（见 settleWesternDiagnosisBasis）。
  const clinicalOnly = entry.clinicallyDiagnosable && !threshold && missing.length === 0;
  return { pending: missing.length > 0 || !imagingSupportsName, missing, regionalImagingRecorded, ...(threshold ? { courseMet: Boolean(course && course.lower >= threshold) } : {}), ...(clinicalOnly ? { clinicalOnly } : {}) };
}

const PREFERRED_WESTERN_NAMES = (westernNamePreferred as { names: Record<string, string> }).names;
const isCharSubsequence = (short: string, long: string): boolean => {
  let at = 0;
  for (const ch of long) if (ch === short[at]) at += 1;
  return at === short.length;
};
/**
 * 依据句肯定的是另一个受治理病名（「符合妊娠期恶心呕吐…尚未达重度脱水标准」），病名却写成那个病没达到的诊断（「妊娠剧吐」）：
 * 病名改为依据肯定的病（第五十一轮；甲方 11/18 只展示西医主诊断名＋依据句，hold40 h31 即 11.05 病历11 同类在新病历复现）。
 * 只认要点表或规范写法表里有的病名；同一病的宽窄写法（糖尿病/2型糖尿病）、病名本身出现在依据里、病历写明既往已确诊的不改。
 */
export function basisAffirmedOtherDisease(name: string, basis: string, recordText = ""): string | undefined {
  const core = String(name || "").trim().replace(/(?:待[查排]|可能)$/u, "").normalize("NFKC");
  const source = String(basis || "").normalize("NFKC");
  if (core.length < 2 || !source || source.includes(core) || (recordText && recordStatesWesternDiagnosis(core, recordText))) return undefined;
  for (const match of source.matchAll(/符合([\u4e00-\u9fffA-Za-z0-9]{2,20}?)(?:的)?(?:典型)?(?:临床)?(?:表现|特征|特点|诊断标准|诊断)?(?=[，,。；;、（(]|$)/gu)) {
    const written = match[1];
    const preferred = PREFERRED_WESTERN_NAMES[written] || written;
    const governed = Boolean(PREFERRED_WESTERN_NAMES[written]) || Object.values(PREFERRED_WESTERN_NAMES).includes(written) || westernCriteriaEntry(written)?.name === written;
    if (!governed || preferred === core) continue;
    if (isCharSubsequence(preferred, core) || isCharSubsequence(core, preferred) || isCharSubsequence(written, core) || isCharSubsequence(core, written)) continue;
    return preferred;
  }
  return undefined;
}

function explicitlyDiagnosedInRecord(core: string, recordText: string): boolean {
  return [...recordText.matchAll(/[^。；;\n，,]+/gu)].some((match) => {
    const clause = match[0];
    const at = clause.indexOf(core);
    if (at < 0 || UNCERTAIN_NEAR_DIAGNOSIS.test(clause)) return false;
    const polarity = recordMentionPolarityAt(recordText, match.index + at);
    if (polarity !== "affirmed" && !(polarity === "negated" && /^(?:确诊为|诊断为|诊为)/u.test(clause) &&
        /排除[^，,。；;]+[，,]$/u.test(recordText.slice(0, match.index)) && recordMentionPolarityAt(clause, at) === "affirmed")) return false;
    return (/^既往史[：:]\s*$/u.test(clause.slice(0, at)) && !clause.slice(at + core.length).trim()) ||
      /^\s*(?:\d+(?:年|个月)前|既往|此前|曾|已)?(?:确诊为?|诊断为?|诊为)(?:[“"「]?|[^，。；]{1,50}、)$/u.test(clause.slice(0, at)) ||
      /^(?:、(?!否认|待查)[^、，,；;。]{2,24})*["”」』]?病史/u.test(clause.slice(at + core.length));
  });
}

/** 先定病名确定度，再以完整分句为单位舍弃互相冲突的断言；不把一个结论换词成另一个结论。 */
export function settleWesternDiagnosisBasis(name: string, basis: string, recordText: string): { name: string; basis: string } {
  const affirmed = basisAffirmedOtherDisease(name, basis, recordText);
  if (affirmed) return settleWesternDiagnosisBasis(affirmed, basis, recordText);
  const qualified = settleWesternRecurrenceQualifier(name, basis, recordText);
  if (qualified.name !== name) return qualified;
  const core = String(name || "").trim().replace(/(?:待[查排]|可能)$/u, "");
  if (!core) return { name, basis };
  const cleanedAsWritten = withoutMissingClaimsForRecordedTests(basis, recordText);
  const treated = recordStatesTreatedHypertension(core, recordText);
  // 原词写在主诉（如“经期腹泻2月”）只证明症状被记录；既往/明确诊断语境才可免去首次确诊要求。
  const aliases = [core, ...westernDiagnosisAbbreviations().filter((row) => row.fullName.replace(/症$/u, "") === core.replace(/症$/u, "")).map((row) => row.abbreviation),
    ...(textConsistency.treatedHypertension.names.includes(core) ? textConsistency.treatedHypertension.names : [])];
  const diagnosedContext = aliases.some((alias) => (alias.length >= 3 ? recordStatesWesternDiagnosis(alias, recordText) :
    recordStatesWesternDiagnosis(core, recordText.split(alias).join(core))) &&
    recordText.split(/[。；;\n]/u).some((sentence) => sentence.includes(alias.slice(0, 3)) &&
      /既往|病史|已确诊|确诊为|诊断为|曾诊断|镜示|镜检查示/u.test(sentence)));
  // 只凭同一分句里的本人确诊记录恢复表外病名；裸症状、家族史、
  // 下位分型和旧病的新发并发症均不能用病名的一部分举证。
  const components = core.split(/(?:合并|伴)/u);
  const explicitDiagnosis = explicitlyDiagnosedInRecord(core, recordText) || (components.length === 2 &&
    components.every(part => part.length >= 2 && explicitlyDiagnosedInRecord(part, recordText)));
  const known = explicitDiagnosis || diagnosedContext || treated || Boolean(establishedHistoryText(core, recordText));
  const criteria = westernCriteriaCertainty(core, recordText, known);
  // 可凭临床诊断的病（要点表注明、没有必需检查与病程门槛）：依据句里的「X待查」只是病名被改成待查以后带进去的回声
  //（第六十轮，r1077 样张 R046：「据此临床考虑急性上呼吸道感染待查；尚缺血象等检查佐证」，病名于是一直是「急性上呼吸道感染待查」）。
  // 回声不算依据句自己说未确立；依据另有明说未确立的写法（须先排除、诊断尚不能确立、暂按…）时照旧待查。
  const subtype = westernCriteriaEntry(core)?.durationLimitedSubtype;
  const correctlyScoped = subtype ? cleanedAsWritten.replace(
    new RegExp(`(?:尚未|未)(?:达到|满足)${escapePattern(core)}的病程标准[；;，,]?`, "gu"), "",
  ) : cleanedAsWritten;
  const cleaned = criteria?.clinicalOnly ? correctlyScoped.split(`${core}待查`).join(core) : correctlyScoped;
  // 第四十八轮配对盲评：可凭临床诊断的病，要点表把「待查」去掉时依据句却说「需先排除」「需专科检查确立诊断」「暂按此考虑」
  //（痛风伴脓毒症待排、重症肌无力未做抗体、慢性疲劳综合征等排除性诊断），复核员判西医确定程度错。这类病名跟着依据句自己的表态走，
  // 两头一致：依据说未确立就待查，依据说可临床诊断就不待查（上感待查而依据说「临床可以诊断」的另一类错同样消失）。
  // 依据句明说未确立（须先排除另一严重病、需专科检查确立诊断、暂按此考虑、写待查）时，表里任何一类病都不去掉待查——
  // 第二轮配对盲评：有病程门槛的焦虑障碍、慢性疲劳综合征病程够了就去掉待查，依据却写「故写症状名待查」「暂按此考虑」。
  // 排除性诊断的依据还要排除器质性疾病时，病名未确立（第五十一轮：「原发性痛经」依据写「尚需盆腔超声排除子宫内膜异位症…等器质性疾病」）。
  const exclusionName = [...establishmentWords.exclusionDiagnosisWords, ...((establishmentWords as { organicExclusionBasisNames?: string[] }).organicExclusionBasisNames || [])].some((word) => core.includes(word));
  const organicStillToExclude = exclusionName && /(?:尚需|仍需|还需|需|尚未|未)[^。；;]{0,24}排除[^。；;]{0,30}器质/u.test(cleaned);
  // 依据句自己说病程未到门槛（「病程1月未达2月门槛」），要点表又没有病程门槛可判（courseMet 未定）：病名跟依据句走（第五十五轮，11.05 病例12）。
  // 表里有门槛且已满足时，这类说法反过来按与病历不符删掉（下面 unmetCoursePattern 那条）。
  const courseUnmetByBasis = !subtype && criteria?.courseMet === undefined && new RegExp(certaintyPolicy.unmetCoursePattern, "u").test(cleaned);
  const explicitlyNotEstablished = !known && !treated && (new RegExp(certaintyPolicy.clinicalNotEstablishedPattern, "u").test(cleaned) || organicStillToExclude || courseUnmetByBasis);
  const pending = criteria && !criteria.clinicalOnly ? criteria.pending || Boolean(criteria.regionalImagingRecorded && /待[查排]$/u.test(name)) || explicitlyNotEstablished
    : criteria?.clinicalOnly ? explicitlyNotEstablished ||
      (!known && !treated && basisSaysNameNotEstablished(cleaned.split(/[。；;]/u).filter((part) => !CONFIRMATION_GAP.test(part)).join("。"), core))
      : (!explicitDiagnosis && !treated && (/待[查排]$/u.test(name) || (!known && (basisSaysNameNotEstablished(cleaned, core) || organicStillToExclude))));
  const escaped = escapePattern(core);
  // 第五十九轮（r1077 R006、P024、P020）：「便秘诊断可临床成立」「诊断寻常痤疮可临床确立」「可临床诊断结节性痒疹」同样是说诊断成立，
  // 病名带「待查」时这几种写法此前没被认出来，名与依据于是一个待查、一个成立。
  // 第六十二轮（实链 e1029-c07「中暑待查」，依据「依据高温暴露史与典型症状可临床诊断，尚需与热射病…鉴别」）：「可临床诊断」后面不带病名、
  // 直接到句读的写法同样是说成立；病名待查时这一小句照第五十九轮口径去掉。
  const established = new RegExp(`(?:${escaped})?诊断(?:${escaped})?(?:已|可)?(?:临床)?(?:确立|成立|明确)|据此临床诊断${escaped}|可(?:以)?临床诊断(?:为)?(?:${escaped}|(?=[，,。；;]|$))`, "u");
  const speculative = new RegExp(`考虑${escaped}(?:的)?可能|可能为${escaped}`, "u");
  const oppositeCourse = /^(急性|慢性)/u.exec(core);
  const oppositeName = oppositeCourse ? `${oppositeCourse[1] === "急性" ? "慢性" : "急性"}${core.slice(2)}` : "";
  const possibilities = [...cleaned.matchAll(/(?:考虑|可能为)([\u4e00-\u9fff]{2,24}?)(?:的?可能|[，,；;。])/gu)].map((match) => match[1]);
  const exclusionItems = (clause: string, cue: string) => clause.slice(clause.indexOf(cue) + cue.length).split(/[、及]/u).map((item) => item.replace(/等[^，。；;]*$/u, "").trim()).filter(Boolean);
  const stillToExclude = cleaned.split(/[，,。；;]/u).filter((clause) => /^\s*需排除/u.test(clause)).flatMap((clause) => exclusionItems(clause, "需排除"));
  // 再投影旧版依据时只撤本函数合成的整条缺项句；保留医生要求复查、查因的独立分句。
  const basisForDelivery = criteria?.regionalImagingRecorded
    ? cleaned.replace(new RegExp(`尚缺([^，。；]{1,30})，需核实后确认${escaped}。`, "gu"), (whole, test: string) =>
      ((certaintyPolicy.regionalImaging as Record<string, string[]>)[westernCriteriaEntry(core)?.name || ""] || []).some(alias => alias.includes(test)) ? "" : whole)
    : cleaned;
  const parts = basisForDelivery.split(/([，,。；;])/u);
  const out: string[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index];
    const separator = parts[index + 1] || "";
    if (!clause.trim()) continue;
    const hypothesis = /^考虑([^，。；]+?)(?:的)?可能$/u.exec(clause);
    if (hypothesis) {
      const names = hypothesis[1].split("、");
      const kept = names.filter(candidate => hypothesisFitsPatient(candidate, recordText));
      if (kept.length !== names.length) {
        if (kept.length) out.push(`考虑${kept.join("、")}可能${separator}`);
        continue;
      }
    }
    if (clause.includes(`${core}待查尚缺`)) {
      out.push(clause.replace(`${core}待查尚缺`, "尚缺") + separator);
      continue;
    }
    const gap = CONFIRMATION_GAP.test(clause) && !SUBLEVEL.test(clause);
    const assertsName = new RegExp(`^\\s*(?:符合|支持)${escaped}\\s*$`, "u").test(clause);
    const excludes = /^\s*需排除/u.test(clause) ? exclusionItems(clause, "需排除") : undefined;
    const keptExcludes = excludes?.filter((disease) => ![core, ...possibilities].includes(disease));
    // 「可排除」与「仍需排除」冲突时不输出排除结论，保留鉴别任务。
    const reversedExclusion = /可排除/u.test(clause) && exclusionItems(clause, "可排除").some((disease) => stillToExclude.includes(disease));
    if (known && !pending && new RegExp(`^(?:${escaped})?(?:的?诊断)?(?:${certaintyPolicy.clinicalNotEstablishedPattern})$`, "u").test(clause.trim())) continue;
    if (oppositeName && clause.includes(oppositeName) && /按|考虑|诊断|属/u.test(clause)) continue;
    if ((criteria?.courseMet && new RegExp(certaintyPolicy.unmetCoursePattern, "u").test(clause)) || reversedExclusion || (pending && (established.test(clause) || assertsName)) ||
        ((known || criteria) && !pending && (gap || basisSaysNameNotEstablished(clause, core))) || (!pending && speculative.test(clause) && (known || criteria || established.test(cleaned) || CLINICAL_ESTABLISHMENT.test(cleaned)))) continue;
    if (excludes && keptExcludes && keptExcludes.length < excludes.length) {
      if (keptExcludes.length > 0) out.push(`需排除${keptExcludes.join("、")}${separator}`);
      continue;
    }
    out.push(clause + separator);
  }
  if (criteria?.pending && criteria.missing.length > 0) {
    const courseGap = criteria.missing.filter((item) => item.startsWith(COURSE_GAP_PREFIX));
    const tests = criteria.missing.filter((item) => !item.startsWith(COURSE_GAP_PREFIX));
    const missingSentence = [
      ...courseGap.map((item) => `${item}，${core}需随访后确认。`),
      ...(tests.length ? [`尚缺${tests.slice(0, 2).join("、")}，需核实后确认${core}。`] : []),
    ].join("");
    // 文字跟着结论走；避免把旧的缺检查断言和确定的缺项并列。
    // 模型已写的「病程未满N个月」一句由定稿的缺项句代替，不并列重复。
    const unmetCourse = new RegExp(certaintyPolicy.unmetCoursePattern, "u");
    const retained = out.join("").split(/[。；;]/u).filter((part) => !CONFIRMATION_GAP.test(part) && !part.startsWith("尚缺") &&
      !(courseGap.length && unmetCourse.test(part)));
    out.splice(0, out.length, ...retained.filter(Boolean).map((part) => `${part}。`), missingSentence);
  }
  // 病历写明既往已确诊、病名因此不带待查时，依据按甲方 11.18 口径写成「既往已确诊X；…；本次未复查Y」（第六十二轮实链 e05-14：
  // 病名「膝骨关节炎」，依据却是「但缺乏影像学与关节查体记录，故尚需核实」，没提既往确诊，名与依据确定程度仍不一致）。
  // 只在病历同一分句明确记载了这个病名本身时改写（「慢性浅表性胃炎」病史不能写成「既往已确诊慢性胃炎」）。
  if (known && !pending && explicitDiagnosis && !/待[查排]$/u.test(name)) {
    const settled: string[] = [];
    for (const piece of out) {
      const clause = piece.replace(/[，,。；;]$/u, "");
      const separator = piece.slice(clause.length);
      // 「故尚需核实」「故置信度中等」这类收尾（后一种在交付面稍后会被换成前一种，这里两种都认）。
      if (/^(?:故|因此|所以)?(?:诊断)?(?:(?:尚|仍|还)?(?:需|待)(?:进一步)?(?:核实|确认|明确)(?:诊断)?|(?:诊断)?(?:置信度|把握度?|可信度)(?:为)?(?:中等|较低|偏低|不高|低|中))$/u.test(clause.trim())) continue;
      const lacking = /^但?(?:目前)?(?:缺乏|缺少|尚缺|尚无|未见|缺)(.{2,30}?)(?:的)?(?:记录|结果|依据|资料|证据|支撑|支持|佐证)?$/u.exec(clause.trim());
      settled.push(lacking ? `本次未复查${lacking[1]}${separator}` : piece);
    }
    if (settled.join("") && !/既往|病史|已确诊|曾诊断|确诊为/u.test(settled.join(""))) settled.unshift(`既往已确诊${core}；`);
    out.splice(0, out.length, ...settled);
  }
  return { name: criteria ? (pending ? `${core}待查` : core) : pending && !/待[查排]$/u.test(name) ? `${core}待查` : treated || explicitDiagnosis ? core : name,
    basis: out.join("").replace(/[，,；;]+。/gu, "。").replace(/^[，,。；;]+/u, "").replace(/[，,；;]+$/u, /。\s*$/u.test(basis) ? "。" : "").trim() };
}

/**
 * 西医依据一句话里既说诊断已确立、又说尚缺检查确认（第四十四轮，甲方 11.05 复测 05-1：「慢性浅表性胃炎诊断已确立；但尚缺胃镜及幽门螺杆菌检测确认」）。
 * 第四十七轮退役原来的句内换词：由 settleWesternDiagnosisBasis 先定确定度，再舍弃冲突的完整断言。
 * 本函数保留旧调用接口；病名与文字一起定稿的调用方直接用 settlement，不另外拼“既往确诊/本次未复查”。
 */
export function westernBasisWithoutEstablishmentContradiction(text: string, name: string, recordText: string): string {
  return settleWesternDiagnosisBasis(name, text, recordText).basis;
}

/**
 * 依据里把一项检查当作已有的依据（「结合血象」「胸片示…」），而病历里没有这项检查的结果（第四十四轮回看：上感依据写「结合血象」，病历未查血常规）。
 * 去掉这个说法：「结合X」整段去掉；「X示/X提示…」那一小句去掉。检查名按同项写法表认（有限闭集）；表里没有的检查名不动。没有命中时原样返回。
 */
export function withoutUnrecordedTestCitations(text: string, recordText: string): string {
  let source = String(text || "");
  if (!source || !recordText) return source;
  const aliases = [...new Set(GROUPS.flat())].filter((alias) => alias.length >= 2).sort((left, right) => right.length - left.length);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  for (const alias of aliases) {
    if (!source.includes(alias)) continue;
    const group = GROUPS.find((item) => item.includes(alias));
    if (!group || recordHasResult(recordText, group)) continue;
    // 「结合血象及查体」→「结合查体」；「结合查体及血象」→「结合查体」；只有「结合血象」时整段去掉。
    source = source.replace(new RegExp(`结合${escape(alias)}(?:结果|检查)?[、及和与]\\s*`, "gu"), "结合");
    source = source.replace(new RegExp(`(结合[^，,。；;]{1,12}?)[、及和与]${escape(alias)}(?:结果|检查)?`, "gu"), "$1");
    source = source.replace(new RegExp(`(?:并|且)?结合${escape(alias)}(?:结果|检查)?[，,]?`, "gu"), "");
    // 「血象示白细胞升高」「胸片提示…」这一小句。
    source = source.replace(new RegExp(`[，,；;]?\\s*[^，,。；;]*?${escape(alias)}(?:检查)?(?:结果)?(?:示|提示|显示)[^，,。；;]*`, "gu"), "");
  }
  return source.replace(/^[，,；;\s]+/u, "").replace(/[，,]{2,}/gu, "，").replace(/[，,；;]+。/gu, "。").trim() || String(text || "");
}
