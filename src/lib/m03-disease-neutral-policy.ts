import source from "../data/tcm-syndrome-name-policy.source.json" with { type: "json" };
import { resolveNationalStandardTcmSyndromeTerm, resolveTcmSyndromeTerm } from "./clinical-governance-tables";
import { sanitizeFreeTextForModel } from "./diagnosis-safety";
import { diseaseEvidenceGroups } from "./m03-disease-evidence";

type Candidate = { name: string; standardRef: string; groups: string[][] };
type DiseasePolicy = { sourceRef: { book: string; line: number; quote: string }; candidates: Candidate[] };
const policies: Record<string, DiseasePolicy> = source.diseaseNeutralPolicy;

export const diseaseNeutralPolicyEnabled = () => process.env.CDSS_M03_DISEASE_NEUTRAL_POLICY !== "false";

export function diseaseNeutralPolicy(disease: string): DiseasePolicy | undefined {
  return diseaseNeutralPolicyEnabled() ? policies[disease.trim().split(/[（(]/u)[0]] : undefined;
}

function matchingCandidates(policy: DiseasePolicy, record: string): Candidate[] {
  return policy.candidates.filter((candidate) =>
    resolveNationalStandardTcmSyndromeTerm(candidate.name)?.standardTerm === candidate.name &&
    resolveTcmSyndromeTerm(candidate.name).entry?.termClass === "clinical_term" &&
    Boolean(diseaseEvidenceGroups(record, candidate.groups)));
}

export function supportedDiseaseNeutralName(disease: string, record: string, reportMissing = false): string | undefined {
  const policy = diseaseNeutralPolicy(disease);
  if (!policy) {
    if (reportMissing && diseaseNeutralPolicyEnabled()) console.info("[tcm-cdss:telemetry] m03_disease_neutral_policy", { reason: "disease_not_covered" });
    return undefined;
  }
  const fitting = matchingCandidates(policy, record);
  if (fitting.length === 1) return fitting[0].name;
  if (reportMissing) console.info("[tcm-cdss:telemetry] m03_disease_neutral_policy", { reason: fitting.length ? "ambiguous" : "no_supported_candidate" });
}

export function diseaseNeutralCategoryName(name: string): boolean {
  return source.categoryNames.some((category) => category.replace(/证$/u, "") === name.trim().replace(/证$/u, ""));
}

export function diseaseNeutralPrompt(diseases: readonly string[], record: string): string {
  if (!diseaseNeutralPolicyEnabled()) return "";
  const lines = [...new Set(diseases)].flatMap((disease) => {
    const policy = diseaseNeutralPolicy(disease);
    if (!policy) return [];
    const supported = matchingCandidates(policy, record);
    const { book, line, quote } = policy.sourceRef;
    return [`- ${disease}｜《${book}》${line}「${quote.split("。")[0]}。」｜本例条件已印证的具体候选：${supported.map((item) => `${item.name}（${sanitizeFreeTextForModel(diseaseEvidenceGroups(record, item.groups)!.join("、"))}）`).join("；") || "无"}`];
  });
  if (!lines.length) return "";
  return ["\n【本病基本病机与中性证名】", ...lines].join("\n");
}
