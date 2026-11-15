import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { identifyKnownFormulaNames, lineageDecisionsMatchingDirection } from "./tcm-formula-provenance";
import { isLineageLensSentence } from "./tcm-lineages";

/** 辨证依据与 influencedDecisions 用同一个已治理判据；只删整句，不替模型编造未用经方的理由。 */
export function lineageWordingMatchingDirection<T extends ClinicalReasoningResultV2>(reasoning: T): T {
  const deliveredName = reasoning.stage === "prescribe" ? reasoning.formula?.candidates?.[0]?.name : undefined;
  const direction = String(deliveredName || reasoning.overview?.recommendedFormulaDirection || "");
  if (!direction) return reasoning;
  const accepts = (detail: string, delivered = direction) => {
    const probe = { ...reasoning, lineageAdaptation: { ...reasoning.lineageAdaptation,
      influencedDecisions: [{ aspect: "辨证视角", detail }] } } as T;
    return lineageDecisionsMatchingDirection(probe, delivered).lineageAdaptation?.influencedDecisions?.length === 1;
  };
  const matches = (detail: string) => accepts(detail) || detail.split(/[，,。；;]/u).every((clause) => {
    // 「未用A、B类方」的并列项继承第一个项的未采用限定，只用于核对，不改写交付句。
    const [first, ...rest] = clause.split("、");
    if (!rest.length) return accepts(clause);
    const firstName = identifyKnownFormulaNames(first)[0];
    if (!firstName || !accepts(first, "") || !accepts(first)) return accepts(clause);
    const lead = first.slice(0, first.indexOf(firstName));
    return rest.every((part) => identifyKnownFormulaNames(part).some((name) => part.trim().startsWith(name)) && accepts(lead + part));
  });
  const adaptation = reasoning.lineageAdaptation;
  const matched = adaptation && Array.isArray(adaptation.influencedDecisions)
    ? { ...reasoning, lineageAdaptation: { ...adaptation, influencedDecisions: adaptation.influencedDecisions.filter((item) => matches(item.detail)) } } as T : reasoning;
  const rationale = matched.overview?.tcmDiagnosticRationale;
  if (!rationale) return matched;
  const sentences = rationale.split(/(?<=。)/u);
  const kept = sentences.filter((sentence) => {
    if (!sentence.split(/(?<=[；;])/u).some(isLineageLensSentence)) return true;
    return matches(sentence);
  });
  return kept.length === sentences.length ? matched : { ...matched, overview: { ...matched.overview, tcmDiagnosticRationale: kept.join("").trim() } };
}
