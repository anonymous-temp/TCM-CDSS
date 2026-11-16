import policy from "../data/hypoglycemia-administration-policy.source.json";
import { affirmedCurrentMedicationText } from "./clinical-polarity";
import { currentHypoglycemiaRecorded } from "./required-precautions.server";

/** 仅约束文字中的服药时间，沿用既定低血糖判据和当前用药解析。 */
export function afterMealAdministrationRequired(recordText: string): boolean {
  if (currentHypoglycemiaRecorded(recordText)) return true;
  const personal = recordText.split("\n").filter((line) => !/^\s*家族史\s*[:：]/u.test(line)).join("\n");
  const active = affirmedCurrentMedicationText(personal) || "";
  return policy.medicines.some((name) => active.includes(name));
}

export function afterMealAdministration(text: string): string {
  return text.split(/([。；;])/u).map((clause) => {
    if (!new RegExp(policy.fastingTimePattern, "u").test(clause)) return clause;
    if (new RegExp(policy.avoidAdministrationPattern, "u").test(clause)) return "中药宜饭后温服";
    return clause.replace(new RegExp(policy.fastingTimePattern, "gu"), policy.afterMeal).replace(/饭后(?:饭后)+/gu, "饭后");
  }).join("");
}

/** 注意事项只同步中药服用时间，空腹测血糖和西药原用法不改。 */
export function afterMealPrecaution(text: string): string {
  return text.split(/([。；;，,])/u).map((clause) => {
    if (policy.medicines.some((name) => clause.includes(name))) return clause;
    return policy.herbalScopeTerms.some((term) => clause.includes(term)) || policy.administrationVerbs.some((verb) => clause.includes(verb)) ? afterMealAdministration(clause) : clause;
  }).join("");
}
