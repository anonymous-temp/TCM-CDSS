import { callDiagnosisStream } from "@/lib/diagnosis-api";
import { appendEvidenceContext, buildCdssEvidenceContext, buildEvidenceOutputTransform } from "@/lib/cdss-evidence-context";
import { buildDiagnosePrompt } from "@/lib/diagnosis-prompts";
import { readCaseStateRequest } from "@/lib/diagnosis-request";
import { buildDiagnoseContractSignatureContext, signDiagnoseReasoning } from "@/lib/reasoning-contract-signature";
import { buildSafetyLimitedDiagnosis, buildSafetyLimitedDiagnosisReasoning, clinicalGroundingText, markdownNdjsonResponse, renderSafetyLimitedDiagnosisContract, sanitizeCaseStateForModel, sanitizeUngroundedRedFlagNegations, withSafetyGate } from "@/lib/diagnosis-safety";
import { hasValidClinicalFactsAttestation, maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";

export async function POST(req: Request) {
  const parsed = await readCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;
  // Deterministic hard red flags must reach emergency guidance without waiting on a semantic model.
  // For all remaining cases, the additive semantic fact layer stays enabled and can identify
  // colloquial risks that are not covered by the conservative deterministic lower bound.
  const deterministicGate = withSafetyGate(parsed.caseState);
  const caseState = deterministicGate.safetyGate?.status === "red_flag"
    ? parsed.caseState
    : await maybeAttachClinicalFactsBackstop(parsed.caseState, undefined, req.signal);
  const gated = withSafetyGate(caseState);
  const redFlagAnalysis = gated.safetyGate?.status === "red_flag";
  const limitedInformation = gated.completeness.level !== "C" || gated.safetyGate?.status !== "ready";
  const hasChiefComplaint = Boolean((gated.chiefComplaint || gated.hisRecord?.fields?.zhushu || "").trim());
  if (!hasChiefComplaint) {
    return markdownNdjsonResponse(buildSafetyLimitedDiagnosis(gated, gated.safetyGate!));
  }

  const signedLimitedDiagnosis = (gate: NonNullable<typeof gated.safetyGate>) => renderSafetyLimitedDiagnosisContract(
    gated,
    gate,
    signDiagnoseReasoning(
      buildSafetyLimitedDiagnosisReasoning(gated, gate),
      buildDiagnoseContractSignatureContext(gated),
    ),
  );
  // Once a server-owned hard red flag is established, forcing the model to invent a complete TCM
  // pathogenesis chain is both clinically inappropriate and slow. Close M03 immediately with a
  // signed, explicitly unresolved contract; M04 can then deterministically return the non-dose path.
  if (redFlagAnalysis) {
    return markdownNdjsonResponse(signedLimitedDiagnosis(gated.safetyGate!));
  }
  const encounterScope = gated.clinicalFacts?.encounterScope;
  const historicalOnlyEncounter = encounterScope?.status === "historical_or_stable_only" &&
    encounterScope.reviewAgreement === "agreed" &&
    hasValidClinicalFactsAttestation(gated.clinicalFacts);
  if (historicalOnlyEncounter) {
    return markdownNdjsonResponse(signedLimitedDiagnosis({
      status: "needs_information",
      allowDiagnosis: true,
      allowDosePrescription: false,
      action: "complete_before_prescription",
      missingItems: ["本次当前活动性治疗目标"],
      redFlags: [],
      reasons: [`独立语义预检一致判断当前记录仅含既往、已缓解或稳定背景（原文：“${encounterScope.quote}”）；不得据此推演当前剂量处方。`],
    }));
  }

  const safeState = sanitizeCaseStateForModel(gated);
  const evidenceContext = await buildCdssEvidenceContext(safeState, "diagnose");
  let prompt = appendEvidenceContext(buildDiagnosePrompt(safeState), evidenceContext);
  if (limitedInformation) {
    prompt += "\n\n【有限信息推理】请使用患者已经提供的信息完成辨病辨证；降低相应结论置信度，并把真正影响判断的未知项写入 uncertainties。不得因年龄、性别、生命体征、舌脉、过敏史或当前用药未提供而拒绝输出 M03，也不得臆造缺失事实。";
  }
  // Attested "unclear" scope does not short-circuit M03; the model keeps reasoning but must make
  // the unconfirmed visit target explicit so the downstream dose gate stays evidence-bound.
  if (encounterScope?.status === "unclear" && hasValidClinicalFactsAttestation(gated.clinicalFacts)) {
    prompt += "\n\n【就诊目标待确认】语义预检无法确定本次就诊是否存在当前活动性治疗目标。请在 uncertainties 与 management.mustCollect 中显式记录“本次就诊目标需医生确认”，不得据此臆造当前治疗目标或直接给出剂量级结论。";
  }
  const truncatedGate = {
    status: "needs_information" as const,
    allowDiagnosis: false,
    allowDosePrescription: false,
    action: "complete_before_prescription" as const,
    missingItems: ["模型辨证输出完整性"],
    redFlags: [],
    reasons: ["M03 辨证输出被截断、结构化结果未闭合或语义复核未通过，系统已转为签名有限结果。"],
  };
  return callDiagnosisStream(prompt, "deepseek", undefined, "markdown", {
    requestSignal: req.signal,
    truncateFallback: signedLimitedDiagnosis(truncatedGate),
    authoritativeTruncateFallback: true,
    structuredStage: "diagnose",
    // Structured retries and independent review are external model calls. Keep their grounding
    // context on the same deidentified DTO as the primary generation request.
    structuredClinicalContext: clinicalGroundingText(safeState),
    // Evidence is isolated from the patient-fact grounding channel so literature text can never
    // satisfy a missing patient fact during contract validation.
    structuredReviewEvidenceContext: evidenceContext,
    diagnoseSignatureContext: buildDiagnoseContractSignatureContext(gated),
    outputTransform: buildEvidenceOutputTransform(
      evidenceContext,
      (content) => sanitizeUngroundedRedFlagNegations(content, safeState),
    ),
  });
}
