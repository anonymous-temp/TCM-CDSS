import { textbookRowForSyndrome } from "./tcm-textbook-syndromes";

/**
 * 脱证落在兼证栏时提为主证（2026-10-24 甲方 100 例 C053）。
 *
 * 过敏性休克（BP 78/46、脉微、汗出）一例写成「瘾疹·风热犯表证，兼阳气虚脱证」，选方消风散，评审判主次颠倒：
 * 脱证一旦出现就是当下的主要矛盾，急则治其标（《中西医结合外科学》休克的中医辨证论治：神陷气脱用独参汤加味益气固脱、
 * 阴损亡阳用参附汤回阳固脱；《针灸治疗学》急症·虚脱节）。提示词已要求脱证为主证，这里是兜底：
 * - 兼证里有脱证（亡阳、亡阴、气脱、血脱、阳气虚脱、阴阳离决、内闭外脱这类，闭集）而主证不是时，二者互换；
 *   主证已是脱证时不动证，只看下一条病名；
 * - 治法里固脱救逆一类的条目移到最前；
 * - 原病名在教材里没有这一证（瘾疹没有脱证分型）时，病名改为「虚脱」，原病名留在辨病依据里作为病因；
 *   原病名自有对应的证（教材里有的）时病名不动。
 * 只改字段的主次，不新写证候依据；之后的教材锚定按新的主证与病名照常进行。
 */
// 「脱肛」不是脱证（气虚脱肛、中气下陷而脱肛）。
const CRITICAL_SYNDROME = /(?:亡阳|亡阴|阳脱|阴脱|气脱|血脱|阳气虚脱|阳气暴脱|元气暴脱|元阳暴脱|阴阳离决|阴阳俱脱|内闭外脱|厥脱|虚脱)(?!肛)/u;
const RESCUE_THERAPY = /(?:固脱|救逆|回阳|救阴|益气固脱|敛阴固脱|开闭固脱)/u;

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

export function isCriticalSyndromeName(name: unknown): boolean {
  return typeof name === "string" && CRITICAL_SYNDROME.test(name);
}

/** 纯函数（供测试）：返回改写后的中医半 JSON 文本；不需要改时原样返回。 */
export function promoteCriticalSecondarySyndrome(tcmContent: string): string {
  let root: Json | undefined;
  try { root = record(JSON.parse(tcmContent)); } catch { return tcmContent; }
  const overview = record(root?.overview);
  if (!root || !overview) return tcmContent;
  const primary = typeof overview.primarySyndrome === "string" ? overview.primarySyndrome.trim() : "";
  const secondary = Array.isArray(overview.secondarySyndromes)
    ? overview.secondarySyndromes.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const criticalIndex = secondary.findIndex(isCriticalSyndromeName);
  if (!primary) return tcmContent;
  // 模型已按提示词把脱证写成主证时只看病名（2026-10-24 实测 C053 第二轮：瘾疹·气脱证，病名没跟上）。
  const alreadyPrimary = isCriticalSyndromeName(primary);
  if (!alreadyPrimary && criticalIndex < 0) return tcmContent;
  const critical = alreadyPrimary ? primary : secondary[criticalIndex].trim();
  if (!alreadyPrimary) {
    overview.primarySyndrome = critical;
    overview.secondarySyndromes = [primary, ...secondary.filter((_, index) => index !== criticalIndex)].slice(0, 2);
  }

  const therapy = record(root.therapy);
  if (therapy && typeof therapy.overallMethod === "string") {
    const items = therapy.overallMethod.split(/[，,；;、]/u).map((item) => item.trim()).filter(Boolean);
    const rescue = items.filter((item) => RESCUE_THERAPY.test(item));
    if (rescue.length > 0) therapy.overallMethod = [...rescue, ...items.filter((item) => !RESCUE_THERAPY.test(item))].join("，");
  }

  const disease = typeof overview.tcmDiseaseName === "string" ? overview.tcmDiseaseName.trim() : "";
  if (alreadyPrimary && (!disease || disease === "虚脱" || textbookRowForSyndrome(disease, critical))) return tcmContent;
  if (disease && disease !== "虚脱" && !textbookRowForSyndrome(disease, critical)) {
    overview.tcmDiseaseName = "虚脱";
    const rationale = typeof overview.tcmDiseaseRationale === "string" ? overview.tcmDiseaseRationale.trim().replace(/[。；;，,]$/u, "") : "";
    overview.tcmDiseaseRationale = `${rationale ? `${rationale}；` : ""}现已见${critical.replace(/证$/u, "")}之象，急则治其标，病名先按虚脱，${disease}为其起因，待脱证纠正后再论治。`;
  }
  return JSON.stringify(root);
}
