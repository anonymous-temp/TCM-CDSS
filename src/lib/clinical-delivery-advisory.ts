import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { pediatricDoseCeilingG, pediatricDoseRuleFromGroundingText, type PediatricDoseRule } from "./pediatric-dose-rule";
import { dosePassesSafetySanityCeiling, doseWithinConservativeModelLimit, m04GenerationSpecialPopulationIssue, normalizeComparableDose, ordinaryHistoricalDoseDeviation, unsupportedHighImpactHerbFindings } from "./diagnosis-stage-contract";
import { decoctionRuleForHerb, decoctionRuleSatisfied } from "./herb-decoction-rules";
import { findTcmHerbPairIncompatibilities, getTcmHerbDoseLimit, isKnownTcmHerbName } from "./tcm-knowledge";
import { hasIncompleteEditedHerb } from "./prescription-revision";
import { rejectionTier } from "./diagnosis-rejection-tiers";

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

/** Delivery findings originate in M04; bare codes must use its governed tier table. */
export function isSafetyClinicalDeliveryAdvisory(advisory: ClinicalDeliveryAdvisory): boolean {
  return [advisory.code, ...(advisory.relatedCodes || [])].some((value) => {
    const code = value.trim();
    return rejectionTier(code.startsWith("m03_") || code.startsWith("m04_") ? code : `m04_${code}`) === "T1";
  });
}

// 每条是「哪里需要核对」+「请医生做什么」，写给医生看（2026-10-14 改写：此前是「药味作用、病机归属或治法说明存在需要补充的地方」
//「候选组成与所标方名或当前方剂资料不完全对应」「尚未在当前资料中完整对应」这类说系统自己的话，独立评审记为工程用语）。
const COPY: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/therapy_vocabulary_unverified/, "该药有多种功用，本方取哪一种来配合本例治法尚不明确。", "请结合本例病机确认其用意。"],
  [/dose_reference_deviation/, "本次用量超出常用参考范围。", "请核对用量；确需超常规用量时请注明理由并由医生签名确认。"],
  [/emperor_(?:not_primary|therapy_mismatch)/, "君药的选择或其功效与主要病机的对应需要确认。", "请结合主症与治法核对君药及君臣佐使分工。"],
  [/high_risk_pair|incompatib/, "处方中有需注意的配伍组合。", "请结合配伍禁忌决定是否调整相关药味。"],
  [/unsupported_high_impact|direction/, "该药的作用方向与本例治法不一致。", "请结合主症、舌脉及其在方中的用意决定去留。"],
  [/special_population|contraindication|pregnan|liver|renal/, "该药对本例患者的情况（年龄、妊娠哺乳、基础病等）有慎用或禁用提示。", "请结合患者实际情况决定是否使用或更换。"],
  [/dose|course|administration|daily|regimen/, "用量或服法与常用参考不一致。", "请确认用量、剂数、每日服药次数与疗程。"],
  [/duplicate/, "处方中有重复药味。", "请合并重复项并确认总量。"],
  [/unknown|identity/, "该药名或方名未能与药典及常用名对应。", "请核对药名、炮制品写法或出处。"],
  [/function|therapy|pathogenesis|target|structure/, "该药的功效说明与本例病机的对应不够清楚。", "请核对该药在本方中的用意，其余内容不受影响。"],
  [/decoction|route|processing/, "该药的炮制或煎服要求需要注意。", "请对照该药的特殊煎法确认。"],
  [/formula|composition|reference/, "所标方名与实际药味组成不完全一致。", "请确认是原方、加减方还是自拟方。"],
];

function displayText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>]/g, "").trim().slice(0, 120);
}

export function clinicalDeliveryAdvisoryFromIssue(
  issue: string,
  candidate: Candidate,
  candidateIndex = 0,
  pediatric?: PediatricDoseRule,
): ClinicalDeliveryAdvisory {
  // Modification indexes refer to conditional suggestions, not the candidate's actual herbs.
  const indexedHerb = issue.startsWith("modification_") ? null : issue.match(/(?:^|_)herb_(\d+)(?:_|$)/);
  const herbIndex = indexedHerb ? Number(indexedHerb[1]) : undefined;
  const herbName = herbIndex == null ? undefined : candidate.herbs[herbIndex]?.name;
  const copy = COPY.find(([pattern]) => pattern.test(issue));
  const pairFindings = issue.endsWith("high_risk_pair_incompatibility")
    ? findTcmHerbPairIncompatibilities(candidate.herbs.map((herb) => herb.name))
    : [];
  const doseLimit = herbName && /dose/.test(issue) ? getTcmHerbDoseLimit(herbName) : undefined;
  const doseDetail = doseLimit?.min != null && doseLimit.max != null && pediatric
    ? `当前药量 ${displayText(candidate.herbs[herbIndex!].dose || "未提供")}；儿童折算上限 ${pediatricDoseCeilingG(doseLimit.max, pediatric, herbName)}g（成人历史参考 ${doseLimit.min}–${doseLimit.max}g × ${pediatric.fractionText}）。`
    : doseLimit?.min != null && doseLimit.max != null
    ? `当前药量 ${displayText(candidate.herbs[herbIndex!].dose || "未提供")}；历史参考 ${doseLimit.min}–${doseLimit.max}g。${/dose_reference_deviation/.test(issue) && doseLimit.basis ? `来源：${displayText(doseLimit.basis)}。` : ""}`
    : "";
  return {
    code: issue,
    candidateIndex,
    ...(herbName ? { herbIndex, herbName: displayText(herbName) } : {}),
    message: pairFindings.length > 0
      ? pairFindings.map((finding) => `${displayText(finding.leftDrug)}—${displayText(finding.rightDrug)}：属${displayText(finding.category)}；依据：${displayText(finding.basis)}。`).join(" ")
      : `${herbName ? `${displayText(herbName)}：` : ""}${copy?.[1] || "本方有一处需要医生结合病例确认。"}${doseDetail}`,
    suggestedAction: pairFindings.length > 0
      ? "本方含配伍禁忌，调整相关药味之前不得采纳或开出；其余诊疗内容不受影响。"
      : copy?.[2] || "请结合药味与患者情况判断。",
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
  const pediatricDose = pediatricDoseRuleFromGroundingText(clinicalContext);
  for (const [index, herb] of candidate.herbs.entries()) {
    const prefix = `candidate_0_herb_${index}_`;
    const dose = herb.dose || "";
    if (hasIncompleteEditedHerb(herb)) issues.add(`${prefix}explanation_or_value_incomplete`);
    if (!isKnownTcmHerbName(herb.name)) issues.add(`${prefix}unknown`);
    if (!normalizeComparableDose(dose)) issues.add(`${prefix}dose`);
    if (!dosePassesSafetySanityCeiling(herb.name, dose)) issues.add(`${prefix}dose_sanity_ceiling`);
    if (!doseWithinConservativeModelLimit(herb.name, dose, candidate.decoction.method, pediatricDose)) {
      issues.add(`${prefix}${ordinaryHistoricalDoseDeviation(herb, candidate.decoction.method, pediatricDose) ? "dose_reference_deviation" : "dose_outside_conservative_range"}`);
    }
    if (decoctionRuleForHerb(herb.name)?.prohibited.includes("同煎")) issues.add(`${prefix}route_not_decoction`);
    if (!decoctionRuleSatisfied(herb.name, herb.decoctionRequirement || "")) issues.add(`${prefix}decoction_missing_required`);
    const populationIssue = m04GenerationSpecialPopulationIssue([herb], clinicalContext);
    if (populationIssue) issues.add(`${prefix}${populationIssue}`);
  }
  if (findTcmHerbPairIncompatibilities(candidate.herbs.map((herb) => herb.name)).length > 0) {
    issues.add("candidate_0_high_risk_pair_incompatibility");
  }
  const opposing = unsupportedHighImpactHerbFindings(candidate.herbs, prior, true, candidate.formulaNames || [], true);
  for (const finding of opposing) {
    issues.add(`candidate_0_herb_${finding.index}_unsupported_high_impact_${finding.concepts.join("_")}`);
  }
  // Recompute both views against this exact candidate and M03. Acceptance metadata cannot waive
  // safety codes; independent opposing findings and all other related codes remain untouched.
  for (const finding of unsupportedHighImpactHerbFindings(candidate.herbs, prior, true, candidate.formulaNames || [], false)) {
    const safetyConcepts = opposing.find((item) => item.index === finding.index)?.concepts || [];
    const vocabularyOnly = finding.concepts.filter((concept) => !safetyConcepts.includes(concept));
    for (const concept of vocabularyOnly) issues.add(`candidate_0_herb_${finding.index}_therapy_vocabulary_unverified_${concept}`);
  }
  return deduplicateClinicalDeliveryAdvisories([...issues].map((issue) =>
    clinicalDeliveryAdvisoryFromIssue(issue, candidate, candidateIndex, pediatricDose)));
}

export function deduplicateClinicalDeliveryAdvisories(advisories: readonly ClinicalDeliveryAdvisory[]): ClinicalDeliveryAdvisory[] {
  const grouped = new Map<string, ClinicalDeliveryAdvisory>();
  for (const advisory of advisories) {
    const key = `${advisory.candidateIndex}\0${advisory.herbIndex ?? "all"}\0${advisory.message}\0${advisory.suggestedAction}`;
    const previous = grouped.get(key);
    grouped.set(key, previous ? {
      ...previous,
      relatedCodes: [...new Set([previous.code, ...(previous.relatedCodes || []), advisory.code, ...(advisory.relatedCodes || [])])],
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
