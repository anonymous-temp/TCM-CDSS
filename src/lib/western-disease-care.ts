import type { CaseState } from "./diagnosis-types";
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
type CareRow = { disease: string; aliases: string[]; items: Array<{ id: string; kind: string; text: string; timeWindow: string; conflictsWith: string[]; disabledReason?: string; requiresMaintenanceMedication?: string[] }> };
const rows = careData.entries as CareRow[];
export const conditionalCareSentences = new Set(rows.flatMap((row) => row.items.filter((item) => item.requiresMaintenanceMedication?.length).map((item) => item.text)));
const restriction = new RegExp(policy.conflictRestrictionPattern, "u");
const compact = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");

/** 红旗服务超时但独立判别项已核证，按有全身表现的皮肤感染安排当天面诊。 */
export function febrileSkinInfectionReview(state?: Partial<CaseState>, name?: unknown) {
  const screen = state?.clinicalFacts?.discriminatorScreen;
  if (state?.clinicalFacts?.semanticStatus !== "unavailable" || screen?.status !== "checked" || typeof name !== "string") return;
  const rule = careData.febrileSkinInfectionReview;
  const confirmed = new Set((screen.present || []).filter((row) => row.quote?.trim()).map((row) => String(row.conceptId)));
  if (rule.names.includes(name) && rule.requiredObservations.every((id) => confirmed.has(id))) {
    return { window: "within_24h" as const, focus: "感染扩展或全身并发症" };
  }
}

export function recipeContainsAlcohol(text: string): boolean {
  return careData.alcoholInDietRecipe.terms.some((term) => text.includes(term));
}

export function adultFollowupReferences(name: string, age?: number): string[] {
  if (age == null || age < 18) return [];
  const parts = compact(name).split(new RegExp(policy.careDiagnosisSeparators, "u")).map((part) => part.replace(/待[查排]$/u, ""));
  return careData.adultFollowupReferences.filter((row) => row.names.some((label) => parts.includes(label))).map((row) => row.text);
}

/** 只读最终西医病名，不从鉴别、病史或中医病名推断。并发病逐个匹配，长病名优先。 */
export function diseaseCareItemsForName(name: string, urgent = false, maintenance: readonly string[] = []): DiseaseCareItem[] {
  const pending = /待[查排]$/u.test(name);
  const components = compact(name).replace(/待[查排]$/u, "").split(new RegExp(policy.careDiagnosisSeparators, "u"));
  const matched = rows.filter((row) => [row.disease, ...row.aliases].some((alias) => components.some((part) => part === alias ||
    // 分期是已定病名的修饰，不能把任意包含关系当别名。
    new RegExp(`^${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[1-5]期$`, "iu").test(part))));
  return matched.flatMap((row) => row.items.filter((item) => !item.disabledReason &&
    (!item.requiresMaintenanceMedication || item.requiresMaintenanceMedication.some((drug) => maintenance.some((name) => name.includes(drug)))) &&
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
