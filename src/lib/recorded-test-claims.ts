import testNameGroupsJson from "../data/clinical-test-name-groups.source.json" with { type: "json" };
import textConsistency from "../data/diagnosis-text-consistency.source.json" with { type: "json" };
import westernAbbreviations from "../data/western-diagnosis-abbreviations.source.json" with { type: "json" };
import { recordMentionPolarityAt } from "./diagnosis-safety";

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
      if (PENDING_IN_CLAUSE.test(clause)) continue;
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
  return history && source.split(/[。；;\n]/u).some((line) => /用药史|现用药|正在(?:使用|服用)|长期(?:使用|服用)/u.test(line) &&
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
  if (new RegExp(`${escaped}[^。；;]{0,8}?(?:尚未确立|尚不能确立|尚不能诊断|不能确诊|尚未明确诊断|诊断依据不足)|(?:尚未确立|尚不能确立|尚不能诊断)[^。；;]{0,6}${escaped}|后(?:方可|才能)诊断${escaped}`, "u").test(source)) return true;
  // 「分型」不能遮住同句的「方能确立X」（ACS、DKA）。
  if (new RegExp(`(?:方可|才能|方能)(?:确诊|确立|诊断)${escaped}`, "u").test(source)) return true;
  if (new RegExp(`${escaped}(?:诊断)?尚缺[^，,。；;]{0,12}(?:评估|检查)[^，,。；;]{0,6}排除`, "u").test(source)) return true;
  const gaps = source.split(/[。；;]/u).filter((clause) => CONFIRMATION_GAP.test(clause) && !SUBLEVEL.test(clause));
  if (gaps.length > 0) return true;
  if (CLINICAL_ESTABLISHMENT.test(source)) return false;
  return new RegExp(`考虑${escaped}(?:的)?可能|可能为${escaped}|${escaped}(?:的)?可能(?:性)?(?:大|较大)?[，；。]|(?:疑诊|拟诊|疑为|怀疑)${escaped}|${escaped}[^，。；;]{0,12}待(?:查|排)`, "u").test(source);
}

/** 先定病名确定度，再以完整分句为单位舍弃互相冲突的断言；不把一个结论换词成另一个结论。 */
export function settleWesternDiagnosisBasis(name: string, basis: string, recordText: string): { name: string; basis: string } {
  const core = String(name || "").trim().replace(/(?:待[查排]|可能)$/u, "");
  if (!core || !basis) return { name, basis };
  const cleaned = withoutMissingClaimsForRecordedTests(basis, recordText);
  const treated = recordStatesTreatedHypertension(core, recordText);
  // 原词写在主诉（如“经期腹泻2月”）只证明症状被记录；既往/明确诊断语境才可免去首次确诊要求。
  const aliases = [core, ...westernAbbreviations.entries.filter((row) => row.fullName.replace(/症$/u, "") === core.replace(/症$/u, "")).map((row) => row.abbreviation),
    ...(textConsistency.treatedHypertension.names.includes(core) ? textConsistency.treatedHypertension.names : [])];
  const diagnosedContext = aliases.some((alias) => (alias.length >= 3 ? recordStatesWesternDiagnosis(alias, recordText) :
    recordStatesWesternDiagnosis(core, recordText.split(alias).join(core))) &&
    recordText.split(/[。；;\n]/u).some((sentence) => sentence.includes(alias.slice(0, 3)) &&
      /既往|病史|已确诊|确诊为|诊断为|曾诊断|镜示|镜检查示/u.test(sentence)));
  const known = diagnosedContext || treated;
  const pending = !treated && (/待[查排]$/u.test(name) || (!known && basisSaysNameNotEstablished(cleaned, core)));
  const escaped = escapePattern(core);
  const established = new RegExp(`(?:${escaped})?诊断(?:${escaped})?(?:已|可)?(?:确立|成立|明确)|据此临床诊断${escaped}`, "u");
  const speculative = new RegExp(`考虑${escaped}(?:的)?可能|可能为${escaped}`, "u");
  const oppositeCourse = /^(急性|慢性)/u.exec(core);
  const oppositeName = oppositeCourse ? `${oppositeCourse[1] === "急性" ? "慢性" : "急性"}${core.slice(2)}` : "";
  const possibilities = [...cleaned.matchAll(/(?:考虑|可能为)([\u4e00-\u9fff]{2,24}?)(?:的?可能|[，,；;。])/gu)].map((match) => match[1]);
  const exclusionItems = (clause: string, cue: string) => clause.slice(clause.indexOf(cue) + cue.length).split(/[、及]/u).map((item) => item.replace(/等[^，。；;]*$/u, "").trim()).filter(Boolean);
  const stillToExclude = cleaned.split(/[，,。；;]/u).filter((clause) => /^\s*需排除/u.test(clause)).flatMap((clause) => exclusionItems(clause, "需排除"));
  const parts = cleaned.split(/([，,。；;])/u);
  const out: string[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index];
    const separator = parts[index + 1] || "";
    if (!clause.trim()) continue;
    const gap = CONFIRMATION_GAP.test(clause) && !SUBLEVEL.test(clause);
    const excludes = /^\s*需排除/u.test(clause) ? exclusionItems(clause, "需排除") : undefined;
    const keptExcludes = excludes?.filter((disease) => ![core, ...possibilities].includes(disease));
    // 「可排除」与「仍需排除」冲突时不输出排除结论，保留鉴别任务。
    const reversedExclusion = /可排除/u.test(clause) && exclusionItems(clause, "可排除").some((disease) => stillToExclude.includes(disease));
    if (oppositeName && clause.includes(oppositeName) && /按|考虑|诊断|属/u.test(clause)) continue;
    if (reversedExclusion || (pending && established.test(clause)) ||
        (known && !pending && gap) || (!pending && speculative.test(clause) && (known || established.test(cleaned) || CLINICAL_ESTABLISHMENT.test(cleaned)))) continue;
    if (excludes && keptExcludes && keptExcludes.length < excludes.length) {
      if (keptExcludes.length > 0) out.push(`需排除${keptExcludes.join("、")}${separator}`);
      continue;
    }
    out.push(clause + separator);
  }
  return { name: pending && !/待[查排]$/u.test(name) ? `${core}待查` : treated ? core : name,
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
