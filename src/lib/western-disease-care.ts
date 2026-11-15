import careData from "../data/western-disease-care.source.json";
import policy from "../data/western-evidence-policy.source.json";

export type DiseaseCareItem = {
  kind: "disease_care";
  id: string;
  disease: string;
  careKind: string;
  sentence: string;
  timeWindow: string;
  conflictsWith: string[];
};
type CareRow = { disease: string; aliases: string[]; items: Array<{ id: string; kind: string; text: string; timeWindow: string; conflictsWith: string[]; disabledReason?: string }> };
const rows = careData.entries as CareRow[];
const restriction = new RegExp(policy.conflictRestrictionPattern, "u");
const compact = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");

/** 只读最终西医病名，不从鉴别、病史或中医病名推断。并发病逐个匹配，长病名优先。 */
export function diseaseCareItemsForName(name: string, urgent = false): DiseaseCareItem[] {
  const pending = /待[查排]$/u.test(name);
  const components = compact(name).replace(/待[查排]$/u, "").split(new RegExp(policy.careDiagnosisSeparators, "u"));
  const matched = rows.filter((row) => [row.disease, ...row.aliases].some((alias) => components.some((part) => part === alias ||
    // 分期是已定病名的修饰，不能把任意包含关系当别名。
    new RegExp(`^${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[1-5]期$`, "iu").test(part))));
  return matched.flatMap((row) => row.items.filter((item) => !item.disabledReason &&
    (!pending || !["medication_safety", "followup"].includes(item.kind)) &&
    // 急诊优先；不把恢复期运动或日常饮食搬进急症处置页。
    (!urgent || row.disease === "低血糖" || row.disease === "高钾血症"))
    .map((item) => ({ kind: "disease_care" as const, id: item.id, disease: row.disease, careKind: item.kind, sentence: item.text, timeWindow: item.timeWindow, conflictsWith: item.conflictsWith })));
}

/** 逐项核对完整动作；不以提到病名或一个宽泛关键词视为完成。 */
export function diseaseCareItemCovered(item: DiseaseCareItem, lines: readonly string[]): boolean {
  return lines.some((line) => compact(line).includes(compact(item.sentence).replace(/[。；;]$/u, "")));
}

/** 受治理 conflictsWith 是有限闭集。整句删除；限制性建议（避免/忌…）保留。 */
export function withoutDiseaseCareConflicts(text: string, items: readonly DiseaseCareItem[]): string {
  return text.split(/(?<=[。；;\n])/u).filter((sentence) => !items.some((item) => item.conflictsWith.some((conflict) => {
    for (let at = sentence.indexOf(conflict); at >= 0; at = sentence.indexOf(conflict, at + conflict.length)) {
      const clause = sentence.slice(0, at).split(/[，,]/u).at(-1) || "";
      // 「不要少吃甜食」等否定冲突句可留，原始冲突的「不监测」本身仍应删除。
      if (!restriction.test(clause)) return true;
    }
    return false;
  }))).join("").trim();
}
