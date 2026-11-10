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
