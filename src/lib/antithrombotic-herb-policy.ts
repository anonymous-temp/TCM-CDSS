import policy from "../data/tcm-antithrombotic-herb-avoid.json";
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";
import { getTcmHerbFunctionCategories } from "./tcm-knowledge";

/** D2 的有限闭集；仅增强抗凝/增加出血方向禁用，减弱方向交给 INR 注意事项。 */
export function antithromboticHerbAvoid(herbName: string): boolean {
  const categories = getTcmHerbFunctionCategories(herbName);
  if ([policy.category, ...((policy as { extraCategories?: string[] }).extraCategories || [])].some((category) => categories.includes(category))) return true;
  const identity = (name: string) => resolveGovernedTcmHerbIdentity(name).canonicalName || name.trim();
  const herb = identity(herbName);
  return policy.entries.some((entry) => entry.basisType !== "textbook_category" && entry.direction === "increase_bleeding" &&
    [entry.name, ...entry.aliases].some((name) => identity(name) === herb));
}

export function antithromboticAntagonistHerbNames(): string[] {
  return [...new Set(policy.entries.filter((entry) => entry.direction === "decrease_anticoagulation")
    .flatMap((entry) => [entry.name, ...entry.aliases]))];
}
