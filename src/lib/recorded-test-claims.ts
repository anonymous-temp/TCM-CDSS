import testNameGroupsJson from "../data/clinical-test-name-groups.source.json" with { type: "json" };
import { recordMentionPolarityAt } from "./diagnosis-safety";

/**
 * 西医依据里说「尚缺/未查 X 检查」、而病历已经写了 X 的结果（第四十一轮，r1054 回顾 n12：病历「肌酸激酶正常，甲状腺功能正常，
 * 肌电图未见明显异常」，依据仍写「尚缺肌酶、肌电图、甲状腺功能等系统检查，需完善以明确病因」）。
 * 只删与病历矛盾的那几项；全删空时这一小句不留，紧跟的「需完善以明确…」一并不留。不新增任何检查或结论。
 * 检查名的同项写法见 clinical-test-name-groups.source.json（有限闭集）。
 */
const GROUPS: readonly (readonly string[])[] = (testNameGroupsJson as { groups: string[][] }).groups;
const MISSING_CLAIM = /^(\s*)(尚缺|缺少|尚未完善|未完善|尚未行|尚未做|未查|未行|未做|需完善|尚需完善)([^，,。；;]{2,80})$/u;
/** 列举之后的「等系统检查」「以明确病因」这段尾巴（不属于检查名）。 */
const CLAIM_TAIL = /(?:等)?(?:系统|相关|进一步)?(?:检查|结果|化验|评估)[^，,。；;]*$|等[^，,。；;]*$/u;
const PENDING_IN_CLAUSE = /未查|未做|未行|未完善|待查|待完善|拟查|建议(?:查|行|做)|尚缺|需完善/u;

function groupFor(item: string): readonly string[] | undefined {
  const name = item.trim().replace(/^(?:血清|血|检查)/u, (prefix) => (prefix === "血" ? prefix : ""));
  if (!name) return undefined;
  return GROUPS.find((group) => group.some((alias) => alias.toLowerCase() === name.toLowerCase())) ||
    GROUPS.find((group) => group.some((alias) => alias.length >= 2 && (name.includes(alias) || alias.includes(name)) && Math.min(alias.length, name.length) >= 2));
}

function recordHasResult(recordText: string, group: readonly string[]): boolean {
  const text = String(recordText || "").normalize("NFKC");
  const lower = text.toLowerCase();
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
  if (!source || !recordText || !/尚缺|缺少|未完善|未查|未行|未做|需完善|尚未/u.test(source)) return source;
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
    const tailMatch = CLAIM_TAIL.exec(rest);
    const object = tailMatch ? rest.slice(0, tailMatch.index) : rest;
    const tail = tailMatch ? tailMatch[0] : "";
    const items = object.split(/、|及|和|与/u).map((item) => item.trim()).filter(Boolean);
    const kept = items.filter((item) => {
      const group = groupFor(item.replace(/(?:等|检查|结果)$/u, ""));
      return !group || !recordHasResult(recordText, group);
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

/** 依据句里说「X诊断已确立/成立/明确」的那一段（诊断名在前可有可无）。 */
const ESTABLISHED_PHRASE = /(?:诊断)(?:已|可)?(?:确立|成立|明确)/u;
/** 依据句里说「尚缺Y…确认/确诊」：缺的是确诊这个病名所需的检查（不是病因、部位、病原、分型、程度这类下一层）。 */
const MISSING_FOR_CONFIRMATION = /(但)?(?:尚缺|缺少|尚未行|尚未做|未行|未做)([^，,。；;]{1,40}?)(?:以|来|进一步|等)?(?:确认|确诊|明确诊断)/u;
const MISSING_FOR_SUBLEVEL = /病因|部位|病原|分型|程度|分级|分期|并发|出血点|性质/u;

/**
 * 西医依据一句话里既说诊断已确立、又说尚缺检查确认（第四十四轮，甲方 11.05 复测 05-1：「慢性浅表性胃炎诊断已确立；但尚缺胃镜及幽门螺杆菌检测确认」）。
 * 前后两半互相否定，读的人不知道到底确诊没有。按病历改成一种说法：
 *  · 病历写着既往已确诊这个病（recordStatesWesternDiagnosis）：「既往已确诊X」，缺的检查写成「本次未复查Y」——既往史与本次确诊分开说；
 *  · 否则：「诊断已确立」改成「考虑X」，缺的检查照写（它就是还没确诊）。
 * 缺的是病因、部位、病原这类下一层的（「鼻出血诊断成立；尚缺鼻内镜明确出血部位」）不算矛盾，不动。没有矛盾时原样返回。
 */
export function westernBasisWithoutEstablishmentContradiction(text: string, name: string, recordText: string): string {
  if (typeof text !== "string" || !text) return text;
  const missing = MISSING_FOR_CONFIRMATION.exec(text);
  if (!missing || MISSING_FOR_SUBLEVEL.test(missing[2])) return text;
  const established = ESTABLISHED_PHRASE.exec(text);
  if (!established || established.index > missing.index) return text;
  const core = String(name || "").trim().replace(/待查$/u, "");
  const before = text.slice(0, established.index);
  const named = core && before.endsWith(core);
  const head = named ? before.slice(0, before.length - core.length) : before;
  // 「既往已确诊」只说病历写明是以往诊断过的（「慢性浅表性胃炎病史2年」「既往胃镜示…」），主诉里的症状名（「经期腹泻2月」）不算。
  const history = core.length >= 2 && recordStatesWesternDiagnosis(core, recordText) &&
    String(recordText || "").normalize("NFKC").split(/[。；;\n]+/u).some((sentence) => sentence.includes(core.slice(0, 3)) && /病史|既往|已确诊|确诊为|诊断为|曾诊断|曾在[^，,]{0,10}诊断|镜示|镜检查示/u.test(sentence));
  const subject = core || "本诊断";
  const replacedEstablished = `${head}${history ? `既往已确诊${subject}` : `考虑${subject}`}`;
  let rest = text.slice(established.index + established[0].length);
  const missingInRest = MISSING_FOR_CONFIRMATION.exec(rest);
  if (missingInRest) {
    const tests = missingInRest[2].replace(/^(?:进行|完善)/u, "").trim();
    rest = `${rest.slice(0, missingInRest.index)}${history ? `本次未复查${tests}` : `尚缺${tests}确认`}${rest.slice(missingInRest.index + missingInRest[0].length)}`;
  }
  return `${replacedEstablished}${rest}`.replace(/；；/gu, "；");
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
