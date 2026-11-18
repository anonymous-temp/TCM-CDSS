import { clinicalEventTemporalScopeAt } from "./clinical-polarity";
import { recordMentionPolarityAt } from "./diagnosis-safety";

export const diseaseRefinementEnabled = () => process.env.CDSS_M03_DISEASE_REFINEMENT !== "false";

export function diseaseRuleEnabled(id: string): boolean {
  return !(process.env.CDSS_M03_DISEASE_DISABLED_RULES || "").split(",").map((value) => value.trim()).includes(id);
}

export function diseaseRecordChief(record: string): string {
  return /主诉[：:]\s*([^\n]+)/u.exec(record)?.[1] ||
    record.split("\n").find((line) => line.trim() && !/^患者(?:年龄|性别)[:：]/u.test(line)) || "";
}

export function diseaseRecordAge(record: string): number | undefined {
  const age = /(?:^|\n)(?:患者)?年龄[：:]\s*(\d+(?:\.\d+)?)\s*岁/u.exec(record)?.[1];
  return age === undefined ? undefined : Number(age);
}

export function diseaseEvidenceIndex(record: string, form: string, currentOnly = true): number | undefined {
  const haystack = record.toUpperCase();
  const needle = form.toUpperCase();
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
    if (/^[A-Z]+$/u.test(needle) && (/[A-Z0-9]/u.test(haystack[at - 1] || "") || /[A-Z0-9]/u.test(haystack[at + needle.length] || ""))) continue;
    if (recordMentionPolarityAt(record, at + form.length - 1) !== "affirmed") continue;
    if (currentOnly && clinicalEventTemporalScopeAt(record, at, form.length) !== "current") continue;
    return at;
  }
}

export function diseaseEvidenceTerm(record: string, form: string, currentOnly = true): string | undefined {
  const at = diseaseEvidenceIndex(record, form, currentOnly);
  return at === undefined ? undefined : record.slice(at, at + form.length);
}

export function diseaseEvidenceGroups(record: string, groups: readonly (readonly string[])[], currentOnly = true): string[] | undefined {
  const evidence = groups.map((group) => group.map((form) => diseaseEvidenceTerm(record, form, currentOnly)).find(Boolean));
  return evidence.every((term): term is string => Boolean(term)) ? evidence : undefined;
}

/**
 * 主诉的主段：第一个「伴/伴有/兼/兼有/合并」或括号之前的部分（构词式闭集）。「发热2天，伴腹胀、纳差」→「发热2天，」；
 *「感冒后发热2周（伴自幼遗尿）」→「感冒后发热2周」；没有这些连接时是整条主诉。
 * 病名须解释就诊原因（m03-visit-reason-check）、西医病名就诊原因核对与这里共用这一处（第三十八轮前那两处各写一份）。
 */
export function chiefComplaintLeadSegment(chiefComplaint: string): string {
  const text = chiefComplaint.normalize("NFKC").replace(/\s+/gu, "");
  const at = text.search(/[（(伴兼]|合并/u);
  return at > 0 ? text.slice(0, at) : text;
}
