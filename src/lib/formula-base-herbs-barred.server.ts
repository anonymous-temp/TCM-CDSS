/**
 * 锁定方或教材代表方的组成里，本例不宜的药（第二十三轮，胎盘早剥：瘀血内停证锁定少腹逐瘀汤，君药延胡索、川芎是活血化瘀药，
 * 活动性出血时开方核对一定拦下，模型三轮照原方写，整页退成非剂量页）。
 *
 * 判据就是开方核对自己那一个（m04GenerationSpecialPopulationIssue：人群高风险、药典孕妇禁用档、儿童禁用、过敏原同源、
 * 活动性出血时的活血化瘀药），逐味问一遍。结果先告诉模型（去掉、改按辨证组方命名），合同同样受理这种透明降级
 *（formulaCompilationContractIssue 的 barredForCase）。第十七轮只做了「备孕/妊娠状态未记录 × 药典孕妇禁用」这一档，这里是同一件事的整类。
 */
import "server-only";
import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { m04GenerationSpecialPopulationIssue } from "./diagnosis-stage-contract";
import { specialPopulationConflictLabel } from "./m04-modification-safety";
import { formulaCompilationReferences } from "./tcm-formula-provenance";
import { textbookRowForSyndrome } from "./tcm-textbook-syndromes";

export type BarredBaseHerb = { herb: string; formula: string; reason: string };

export function formulaBaseHerbsBarredForCase(prior: ClinicalReasoningResultV2, clinicalContext: string): BarredBaseHerb[] {
  if (prior.stage !== "diagnose" || !clinicalContext.trim()) return [];
  const overview = prior.overview;
  const out: BarredBaseHerb[] = [];
  const seen = new Set<string>();
  const add = (herb: string, formula: string) => {
    const name = herb.trim();
    if (!name || seen.has(name)) return;
    const issue = m04GenerationSpecialPopulationIssue([{ name }], clinicalContext);
    if (!issue) return;
    seen.add(name);
    out.push({ herb: name, formula, reason: specialPopulationConflictLabel(issue) });
  };
  for (const reference of formulaCompilationReferences(overview.recommendedFormulaNames || [])) {
    for (const herb of reference.ingredients) add(herb, reference.formulaName);
  }
  const row = textbookRowForSyndrome(String(overview.tcmDiseaseName || ""), String(overview.primarySyndrome || ""));
  for (const herb of row?.composition || []) add(herb, (row?.formulas || [])[0] || "教材代表方");
  return out;
}
