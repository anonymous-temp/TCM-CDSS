import { normalizeReasoningV2, reasoningV2SchemaIssueCode, type ClinicalReasoningResultV2, type ClinicalReviewAttestation } from "./diagnosis-types";
import { clinicalReviewPayloadHash, hasBoundClinicalReviewAttestation, sha256CanonicalForContract } from "./clinical-review-binding";
import { m04SafetyContractIssue } from "./diagnosis-stage-contract";
import { enrichReasoning, formulaCompilationContractIssue } from "./tcm-formula-provenance";
import { isKnownTcmHerbName } from "./tcm-knowledge";
import { sanitizeGeneratedSuggestionPreviewText } from "./diagnosis-stream-safety";
import { NON_DOSE_PRESCRIPTION_MARKER } from "./diagnosis-safety";

export type M04DeliveryCheckpoint = Readonly<{
  content: string;
  reasoning: ClinicalReasoningResultV2;
  payloadHash: string;
  generatorModel?: string;
  acceptanceScope?: ClinicalReviewAttestation["acceptanceScope"];
  review?: { status: "accepted" | "repair" | "unavailable"; issueCode?: string; reason?: string };
  attestation?: ClinicalReviewAttestation;
  signedContent?: string;
}>;

/** Keep completed evidence ahead of pending/failed work; equal-strength completed candidates advance. */
export function preferM04DeliveryCheckpoint(previous: M04DeliveryCheckpoint | undefined, next: M04DeliveryCheckpoint | undefined) {
  // A newer completed objection to these exact bytes supersedes an older approval. An unrelated
  // candidate cannot do so, and a transport outage cannot invent a new clinical decision.
  if (previous?.payloadHash === next?.payloadHash && next?.review && next.review.status !== "unavailable") return next;
  const rank = (value: M04DeliveryCheckpoint | undefined) => !value ? -1 : value.signedContent ? 3
    : value.review?.status === "accepted" ? 2 : value.review?.status === "repair" ? 1 : 0;
  return rank(previous) > rank(next) ? previous : next;
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

/** Called only for completed, normalized candidates; raw stream previews never enter this store. */
export function retainM04DeliveryCheckpoint(
  previous: M04DeliveryCheckpoint | undefined,
  input: {
    content: string;
    reasoning: ClinicalReasoningResultV2;
    priorReasoning?: ClinicalReasoningResultV2;
    clinicalContext?: string;
    generatorModel?: string;
    acceptanceScope?: ClinicalReviewAttestation["acceptanceScope"];
  },
): M04DeliveryCheckpoint | undefined {
  if (reasoningV2SchemaIssueCode(input.reasoning)) return previous;
  const reasoning = normalizeReasoningV2(input.reasoning);
  const payloadHash = clinicalReviewPayloadHash(reasoning);
  if (!reasoning || reasoning.stage !== "prescribe" || !payloadHash) return previous;
  const enriched = enrichReasoning(reasoning).reasoning;
  if (m04SafetyContractIssue(enriched, input.priorReasoning, isKnownTcmHerbName, false, false, input.clinicalContext || "", true) ||
      formulaCompilationContractIssue(enriched, input.priorReasoning, false, reasoning.formula?.candidates?.[0]?.identityDeclassified === true)) return previous;
  const start = input.content.lastIndexOf("<!-- DIAGNOSIS_JSON_START -->");
  const end = input.content.indexOf("<!-- DIAGNOSIS_JSON_END -->", start);
  if (start < 0 || end < 0) return previous;
  try {
    if (clinicalReviewPayloadHash(JSON.parse(input.content.slice(start + "<!-- DIAGNOSIS_JSON_START -->".length, end))) !== payloadHash) return previous;
  } catch { return previous; }
  // Never replace a completed attested result with a pending or malformed repair. For the same
  // payload preserve its review disposition, even if a later phase checks it again.
  if (previous?.signedContent || previous?.payloadHash === payloadHash) return previous;
  return immutable(structuredClone({ content: input.content, reasoning, payloadHash,
    generatorModel: input.generatorModel, acceptanceScope: input.acceptanceScope }));
}

/** Review and signature belong to the exact candidate hash, never the latest global review flag. */
export function bindM04DeliveryReview(
  checkpoint: M04DeliveryCheckpoint | undefined,
  reasoning: ClinicalReasoningResultV2,
  review: NonNullable<M04DeliveryCheckpoint["review"]>,
  attestation?: ClinicalReviewAttestation,
  signedContent?: string,
): M04DeliveryCheckpoint | undefined {
  if (!checkpoint || checkpoint.payloadHash !== clinicalReviewPayloadHash(reasoning)) return checkpoint;
  if (review.status === "unavailable" && checkpoint.review && checkpoint.review.status !== "unavailable") return checkpoint;
  const bound = attestation?.status === "accepted" &&
    hasBoundClinicalReviewAttestation({ ...checkpoint.reasoning, clinicalReview: attestation });
  let matchingSignedContent: string | undefined;
  if (bound && signedContent) {
    const start = signedContent.lastIndexOf("<!-- DIAGNOSIS_JSON_START -->");
    const end = signedContent.indexOf("<!-- DIAGNOSIS_JSON_END -->", start);
    try {
      const signed = start >= 0 && end >= 0 && normalizeReasoningV2(JSON.parse(
        signedContent.slice(start + "<!-- DIAGNOSIS_JSON_START -->".length, end),
      ));
      if (signed && signed.clinicalReview?.status === "accepted" &&
          signed.contractSignature?.startsWith("hmac-sha256:") &&
          sha256CanonicalForContract(signed.clinicalReview) === sha256CanonicalForContract(attestation) &&
          clinicalReviewPayloadHash(signed) === checkpoint.payloadHash && hasBoundClinicalReviewAttestation(signed)) {
        matchingSignedContent = signedContent;
      }
    } catch { /* Mismatched or incomplete signed bytes remain a non-dose candidate. */ }
  }
  return immutable(structuredClone({ ...checkpoint,
    review,
    attestation: bound ? attestation : undefined, signedContent: matchingSignedContent }));
}

function factText(value: unknown): string {
  if (typeof value !== "string") return "";
  // Source facts include measured concentrations, bleeding volumes and historical medication.
  // Escaping controls presentation only; none of those quantities is a new dosing suggestion.
  return value.replace(/\s+/g, " ").trim()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&");
}

function text(value: unknown): string {
  return factText(typeof value === "string" ? sanitizeGeneratedSuggestionPreviewText(value) : value);
}

const REVIEW_ISSUES: Record<string, string> = {
  dose_rationale_concern: "候选剂量强度与本例病情的相称性仍需核对",
  patient_context_mismatch: "候选方案依赖的患者前提仍需核对",
  herb_plan_mismatch: "药味与本例病机、治法的对应仍有保留意见",
  formula_composition_mismatch: "所引方名与实际组成的对应仍有保留意见",
};

/** A read-only non-dose projection, or the exact already-signed completed candidate. */
export function renderM04DeliveryCheckpoint(
  checkpoint: M04DeliveryCheckpoint | undefined,
  priorReasoning: ClinicalReasoningResultV2 | undefined,
  reason: "deadline" | "interrupted" | "upstream_unavailable" | "contract_rejected",
): string {
  if (checkpoint?.signedContent && checkpoint.attestation?.status === "accepted") return checkpoint.signedContent;
  const prior = priorReasoning;
  const lines = [NON_DOSE_PRESCRIPTION_MARKER, ...(prior ? ["## 已完成的辨病辨证"] : []), ...[
    prior?.westernDiagnosis?.primary?.name,
    prior?.overview?.primarySyndrome,
    prior?.overview?.overallPathogenesis,
    prior?.therapy?.overallPrinciple,
    prior?.therapy?.overallMethod,
  ].filter(Boolean).map(text)];
  for (const node of prior?.pathogenesis?.chain || []) {
    lines.push(`- ${factText(node.patientFact)}；${text(node.pathogenesis)}；${text(node.therapyDirection)}`);
  }
  if (!checkpoint) {
    const retainedState = prior ? "已完成的辨病辨证与治法保留，" : "本次没有可用的已签名辨病辨证，";
    lines.push("", "## 候选方药生成状态", reason === "deadline"
      ? `本阶段超过时限，尚未形成通过校验的个体化方药候选。${retainedState}暂不提供药味、剂量或用法。`
      : reason === "upstream_unavailable"
        ? `模型服务暂时不可用，本次尚未形成通过校验的个体化方药候选。${retainedState}暂不提供药味、剂量或用法。`
      : `本次尚未形成通过校验的个体化方药候选。${retainedState}暂不提供药味、剂量或用法。`);
    return lines.join("\n\n");
  }
  const review = checkpoint.review;
  const status = review?.status === "repair"
    ? `本次已生成候选，复核提出的意见尚未解决：${REVIEW_ISSUES[review.issueCode || ""] || "临床方案仍需核对"}。`
    : review?.status === "accepted"
      ? "本次候选已完成临床复核，交付合同尚未完成。"
    : reason === "deadline" || review?.reason === "deadline"
      ? "本次已生成候选，复核未完成或超过时限。"
      : "本次已生成候选，复核未完成。";
  lines.push("", "## 本次候选方药（非剂量，供医生审阅）", status,
    "以下为本次已通过确定性校验的药味与方义，不代表处方已获批准；本页不提供剂量、给药方法或疗程。");
  for (const candidate of checkpoint.reasoning.formula?.candidates || []) {
    lines.push(`候选方：${text(candidate.name)}`);
    for (const herb of candidate.herbs) lines.push(`- ${text(herb.name)}（${text(herb.role)}）：${text(herb.function)}`);
    lines.push(text(candidate.formulaAnalysis), text(candidate.applicable), text(candidate.notApplicable));
  }
  const care = checkpoint.reasoning.nonPharma;
  if (care) lines.push("", "## 已生成的健康调护建议", ...[care.diet, care.lifestyle, care.emotion, ...care.precautions].filter(Boolean).map(text));
  return lines.filter((line) => line !== "").join("\n\n");
}
