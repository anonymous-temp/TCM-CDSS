import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { resolveAcupoint } from "./tcm-acupoints";

export type TreatmentReviewCard = NonNullable<ClinicalReasoningResultV2["nonPharma"]>["tcmTreatments"][number];
type Decision = { keep: boolean; choices: number[]; cautions: number[] };
const CAUTION_LIST = /禁忌：([^。]+)。/u;

export type TreatmentReview = Map<string, Decision>;

function pointOptions(point: string) {
  const names = point.split("（")[0].split("或");
  return names.length > 1 && names.every((name) => resolveAcupoint(name)?.name === name) ? names : [];
}

export function treatmentReviewInput(card: TreatmentReviewCard) {
  return {
    project: card.projectCode, target: card.targetPathogenesis, content: card.treatmentContent,
    sites: card.suggestedSitesOrPoints, schedule: card.scheduleSuggestion, boundary: card.techniqueBoundary,
    cautions: card.techniqueBoundary?.match(CAUTION_LIST)?.[1].split(/[；;]/u) || [],
    checks: card.requiredChecks,
    alternatives: card.suggestedSitesOrPoints.map(pointOptions).filter((options) => options.length),
  };
}

export function reviewedTreatmentCard<T extends TreatmentReviewCard>(card: T, review?: TreatmentReview): T | undefined {
  const decision = review?.get(JSON.stringify(treatmentReviewInput(card)));
  if (!decision) return card;
  if (!decision.keep) return;
  const boundary = card.techniqueBoundary?.replace(CAUTION_LIST, (_full, list: string) => {
    const kept = list.split(/[；;]/u).filter((_, index) => decision.cautions.includes(index));
    return kept.length ? `禁忌：${kept.join("；")}。` : "";
  });
  if (!decision.choices.length) return boundary === card.techniqueBoundary ? card : { ...card, techniqueBoundary: boundary };
  const selected = new Map<string, string>();
  let group = 0;
  const sites = card.suggestedSitesOrPoints.map((site) => {
    const options = pointOptions(site);
    if (!options.length) return site;
    const point = options[decision.choices[group++]];
    selected.set(site.split("（")[0], point);
    return `${point}（${resolveAcupoint(point)!.code}）`;
  });
  let treatmentContent = card.treatmentContent;
  for (const [label, point] of selected) treatmentContent = treatmentContent.replaceAll(label, point);
  return { ...card, treatmentContent, techniqueBoundary: boundary, suggestedSitesOrPoints: sites, pointProvenance: card.pointProvenance?.map((entry) =>
    ({ ...entry, point: selected.get(entry.point.split("（")[0]) ?? entry.point })) };
}
