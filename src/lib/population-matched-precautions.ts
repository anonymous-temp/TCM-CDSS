import type { CaseState } from "./diagnosis-types";
import { medicationPopulationAudience } from "./diagnosis-safety";

/** 整句筛除不属于本例人群的提示；已知哺乳的具体提示由必写项提供，不在句内替换人群。 */
export function populationMatchedPrecautions(lines: readonly string[], state?: CaseState): string[] {
  if (!state) return [...lines];
  const audience = medicationPopulationAudience(state);
  return lines.filter((line) => {
    if (!audience.pregnancy && /孕|妊娠/u.test(line)) return false;
    if (!audience.lactation && /哺乳/u.test(line)) return false;
    if (audience.lactation && !audience.pregnancy && /[如若][^。；;]{0,16}(?:哺乳|喂奶)/u.test(line)) return false;
    return true;
  });
}
