import constraints from "../data/rx-case-constraints.source.json";
import { recordedFindingReading } from "./diagnosis-safety";
import { assessPregnancyState, isPositiveOrPossibleClinicalState } from "./clinical-state";

/** Only explicit label stop/contraindication instructions and affirmed current patient findings. */
export function medicineLabelConflictsWithCase(label: { riskNote?: unknown; contraindication?: unknown; precaution?: unknown; indication?: unknown; functionIndication?: unknown }, caseText: string): boolean {
  if (!caseText) return false;
  const current = caseText.split("\n").filter((line) => !constraints.nonCurrentFindingFields.includes(line.match(/^\s*([^:：]+)[:：]/u)?.[1].trim() || "")).join("\n");
  const warning = [label.riskNote, label.contraindication, label.precaution].filter((value) => typeof value === "string").join("；");
  // 病历记录在孕或可疑妊娠：说明书写孕妇禁用、忌用、慎用的中成药不推荐（第五十一轮，甲方 100 例 C097 孕 12 周推荐了说明书孕妇慎用的成药且未提示；
  // 与饮片「已记录妊娠不用药典孕妇慎用药」同一口径）。
  if (/(?:孕妇|妊娠期妇女|妊娠期|怀孕)[^。；;\n]{0,4}(?:禁用|忌用|慎用|忌服|慎服)/u.test(warning) && isPositiveOrPossibleClinicalState(assessPregnancyState(caseText))) return true;
  for (const clause of warning.split(/[。；;\n]/u)) {
    if (!/停[药用服]|禁用/u.test(clause)) continue;
    // Conditional adverse-event lists are bound to the stop instruction, not unrelated neighboring warnings.
    if (!constraints.stopConditionCues.some((cue) => clause.includes(cue))) continue;
    for (const group of constraints.stopSymptoms) if (group.some((term) => clause.includes(term)) && group.some((term) => recordedFindingReading(current, term) === "affirmed")) return true;
  }
  const indication = String(label.indication || label.functionIndication || "");
  // Exclusive labelled ulcer indications cannot be supported by an explicitly ulcer-negative record.
  if (constraints.ulcerIndicationTerms.some((term) => indication.includes(term)) && !constraints.broaderGastricIndications.some((term) => indication.includes(term)) && recordedFindingReading(current, "溃疡") === "denied") return true;
  return false;
}

/**
 * 不作为门诊候选的药（确定性收口，与提示同一规则）：注射剂与生物制剂；病历里已经写着患者正在使用的药。
 * 「已在用」按药名主干（去掉盐类前缀与剂型）是否出现在病历的既往史、用药史、现病史里判断；主干不足 3 个字的不判，免得误删。
 */
export function medicineCandidateExcludedForCase(name: string, caseText: string): "injection" | "already_in_use" | undefined {
  const cleaned = name.normalize("NFKC").replace(/\s+/g, "");
  if (/注射|针剂|单抗|输液/.test(cleaned)) return "injection";
  const core = cleaned.replace(/(?:缓释|控释|肠溶)?(?:片|胶囊|颗粒|丸|口服液|注射液|喷雾剂|滴丸|糖浆|散|膏)$/g, "").replace(/^(?:盐酸|硫酸|磷酸|枸橼酸|马来酸|苯磺酸|酒石酸|富马酸|琥珀酸|醋酸)/, "");
  if (core.length >= 3 && caseText.normalize("NFKC").replace(/\s+/g, "").includes(core)) return "already_in_use";
  return undefined;
}
