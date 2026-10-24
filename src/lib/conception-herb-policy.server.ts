import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { chpPregnancyLabel } from "./conception-herb-policy";
import { formulaCompilationReferences } from "./tcm-formula-provenance";
import { textbookRowForSyndrome } from "./tcm-textbook-syndromes";

export { chpPregnancyHerbTier, chpPregnancyProhibitedHerbNames } from "./conception-herb-policy";

/**
 * M03 锁定方与教材代表方的组成里，药典孕妇禁用/忌用的药（2026-10-24 探针：35 岁、妊娠状态未记录的癥瘕·气滞血瘀，
 * 教材代表方香棱丸以三棱、莪术为君；不事先告诉模型，三轮修复都照原方写三棱，整页退成非剂量）。
 * 只在 chpPregnancyHerbTier 有档时由开方路由读：告诉模型去掉这几味、改按辨证组方命名（合同同样受理，见 formulaCompilationContractIssue）。
 */
export function formulaBaseHerbsBarredInPregnancy(prior: ClinicalReasoningResultV2): Array<{ herb: string; formula: string }> {
  if (prior.stage !== "diagnose") return [];
  const overview = prior.overview;
  const out: Array<{ herb: string; formula: string }> = [];
  const seen = new Set<string>();
  const add = (herb: string, formula: string) => {
    if (chpPregnancyLabel(herb)?.level !== "prohibited" || seen.has(herb)) return;
    seen.add(herb);
    out.push({ herb, formula });
  };
  for (const reference of formulaCompilationReferences(overview.recommendedFormulaNames || [])) {
    for (const herb of reference.ingredients) add(herb, reference.formulaName);
  }
  const row = textbookRowForSyndrome(String(overview.tcmDiseaseName || ""), String(overview.primarySyndrome || ""));
  for (const herb of row?.composition || []) add(herb, (row?.formulas || [])[0] || "教材代表方");
  return out;
}
