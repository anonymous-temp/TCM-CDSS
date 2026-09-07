import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { dosePassesSafetySanityCeiling, doseWithinConservativeModelLimit, m04GenerationSpecialPopulationIssue, normalizeComparableDose, ordinaryHistoricalDoseDeviation, unsupportedHighImpactHerbFindings } from "./diagnosis-stage-contract";
import { decoctionRuleForHerb, decoctionRuleSatisfied } from "./herb-decoction-rules";
import { findTcmHerbPairIncompatibilities, getTcmHerbDoseLimit, isKnownTcmHerbName } from "./tcm-knowledge";
import { hasIncompleteEditedHerb } from "./prescription-revision";

type Candidate = NonNullable<ClinicalReasoningResultV2["formula"]>["candidates"][number];

/** Server findings travel alongside the report; they do not rewrite its clinical content. */
export type ClinicalDeliveryAdvisory = Readonly<{
  code: string;
  relatedCodes?: string[];
  candidateIndex: number;
  herbIndex?: number;
  herbName?: string;
  message: string;
  suggestedAction: string;
}>;

const COPY: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/dose_reference_deviation/, "本次候选剂量偏离本地历史参考范围，尚未经医生确认。", "请医生核对本次用量；如决定采用超常规用量，应注明理由并由医生签名确认。AI结果签名不代表医嘱或用量批准。"],
  [/emperor_(?:not_primary|therapy_mismatch)/, "君药的角色标注或功效与主要病机的对应仍需确认。", "请结合主症与治法核对君药选择、君臣佐使分工和病机归属，再决定是否调整相关药味。"],
  [/high_risk_pair|incompatib/, "处方中有需注意的药味配伍组合。", "请结合配伍提示与本次用药目的决定是否调整相关药味。"],
  [/unsupported_high_impact|direction/, "药味功用方向与本例治法的对应存在疑问，可能涉及方向不一致。", "请结合主症、四诊及该药在本方中的实际作用决定是否保留或调整。"],
  [/special_population|contraindication|pregnan|liver|renal/, "患者背景与相关药味的适用范围存在需要注意的情况。", "请结合患者实际情况、药品资料和替代方案判断本次用药。"],
  [/dose|course|administration|daily|regimen/, "药量或服法与当前资料中的参考范围不一致。", "请确认具体药量、剂数、每日服用次数与疗程，并在处方中修改需要调整的部分。"],
  [/duplicate/, "当前处方存在重复药味。", "请合并重复项并确认本次总药量。"],
  [/unknown|identity/, "部分药味或方剂信息尚未在当前资料中完整对应。", "请对照药名、炮制品或原始出处补充确认。"],
  [/function|therapy|pathogenesis|target|structure/, "药味作用、病机归属或治法说明存在需要补充的地方。", "请结合本例主症调整相关药味说明，其他诊疗内容可以继续查看和编辑。"],
  [/decoction|route|processing/, "炮制或煎服方式有需要注意的差异。", "请对照具体药味要求确认本次处理方式。"],
  [/formula|composition|reference/, "候选组成与所标方名或当前方剂资料不完全对应。", "请结合实际组成确认原方、加减方或辨证组方的表述。"],
];

function displayText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>]/g, "").trim().slice(0, 120);
}

export function clinicalDeliveryAdvisoryFromIssue(
  issue: string,
  candidate: Candidate,
  candidateIndex = 0,
): ClinicalDeliveryAdvisory {
  // Modification indexes refer to conditional suggestions, not the candidate's actual herbs.
  const indexedHerb = issue.startsWith("modification_") ? null : issue.match(/(?:^|_)herb_(\d+)(?:_|$)/);
  const herbIndex = indexedHerb ? Number(indexedHerb[1]) : undefined;
  const herbName = herbIndex == null ? undefined : candidate.herbs[herbIndex]?.name;
  const copy = COPY.find(([pattern]) => pattern.test(issue));
  const doseLimit = herbName && /dose/.test(issue) ? getTcmHerbDoseLimit(herbName) : undefined;
  const doseDetail = doseLimit?.min != null && doseLimit.max != null
    ? `当前药量 ${displayText(candidate.herbs[herbIndex!].dose || "未提供")}；历史参考 ${doseLimit.min}–${doseLimit.max}g。${/dose_reference_deviation/.test(issue) && doseLimit.basis ? `来源：${displayText(doseLimit.basis)}。` : ""}`
    : "";
  return {
    code: issue,
    candidateIndex,
    ...(herbName ? { herbIndex, herbName: displayText(herbName) } : {}),
    message: `${herbName ? `${displayText(herbName)}：` : ""}${copy?.[1] || "本次处方有一项需要医生结合病例确认的内容。"}${doseDetail}`,
    suggestedAction: copy?.[2] || "请结合候选药味与患者资料进行判断，已有诊疗内容可继续查看和编辑。",
  };
}

/** Collect independent findings: one duplicated row must not hide another row's dose or preparation. */
export function collectClinicalDeliveryAdvisories(
  candidate: Candidate,
  prior: ClinicalReasoningResultV2 | undefined,
  clinicalContext: string,
  extraIssues: readonly (string | undefined)[] = [],
  candidateIndex = 0,
): ClinicalDeliveryAdvisory[] {
  const issues = new Set(extraIssues.filter((issue): issue is string => Boolean(issue)));
  for (const [index, herb] of candidate.herbs.entries()) {
    const prefix = `candidate_0_herb_${index}_`;
    const dose = herb.dose || "";
    if (hasIncompleteEditedHerb(herb)) issues.add(`${prefix}explanation_or_value_incomplete`);
    if (!isKnownTcmHerbName(herb.name)) issues.add(`${prefix}unknown`);
    if (!normalizeComparableDose(dose)) issues.add(`${prefix}dose`);
    if (!dosePassesSafetySanityCeiling(herb.name, dose)) issues.add(`${prefix}dose_sanity_ceiling`);
    if (!doseWithinConservativeModelLimit(herb.name, dose, candidate.decoction.method)) {
      issues.add(`${prefix}${ordinaryHistoricalDoseDeviation(herb, candidate.decoction.method) ? "dose_reference_deviation" : "dose_outside_conservative_range"}`);
    }
    if (decoctionRuleForHerb(herb.name)?.prohibited.includes("同煎")) issues.add(`${prefix}route_not_decoction`);
    if (!decoctionRuleSatisfied(herb.name, herb.decoctionRequirement || "")) issues.add(`${prefix}decoction_missing_required`);
    const populationIssue = m04GenerationSpecialPopulationIssue([herb], clinicalContext);
    if (populationIssue) issues.add(`${prefix}${populationIssue}`);
  }
  if (findTcmHerbPairIncompatibilities(candidate.herbs.map((herb) => herb.name)).length > 0) {
    issues.add("candidate_0_high_risk_pair_incompatibility");
  }
  for (const finding of unsupportedHighImpactHerbFindings(candidate.herbs, prior, true, candidate.formulaNames || [], true)) {
    issues.add(`candidate_0_herb_${finding.index}_unsupported_high_impact_${finding.concepts.join("_")}`);
  }
  return deduplicateClinicalDeliveryAdvisories([...issues].map((issue) =>
    clinicalDeliveryAdvisoryFromIssue(issue, candidate, candidateIndex)));
}

export function deduplicateClinicalDeliveryAdvisories(advisories: readonly ClinicalDeliveryAdvisory[]): ClinicalDeliveryAdvisory[] {
  const grouped = new Map<string, ClinicalDeliveryAdvisory>();
  for (const advisory of advisories) {
    const key = `${advisory.candidateIndex}\0${advisory.herbIndex ?? "all"}\0${advisory.message}\0${advisory.suggestedAction}`;
    const previous = grouped.get(key);
    grouped.set(key, previous ? {
      ...previous,
      relatedCodes: [...new Set([...(previous.relatedCodes || [previous.code]), ...(advisory.relatedCodes || [advisory.code])])],
    } : advisory);
  }
  return [...grouped.values()];
}

export function clinicalDeliveryAdvisorySection(advisories: readonly ClinicalDeliveryAdvisory[]): string {
  if (advisories.length === 0) return "";
  const inline = (text: string) => text.replace(/[\r\n]/g, " ").replace(/([\\`*_{}\[\]()#+.!|>])/g, "\\$1");
  return [
    "## 处方补充提示",
    ...advisories.map((advisory) => `- ${inline(advisory.message)}${inline(advisory.suggestedAction)}`),
  ].join("\n");
}
