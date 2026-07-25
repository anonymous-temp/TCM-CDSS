import { callDiagnosisStream } from "@/lib/diagnosis-api";
import { appendEvidenceContext, buildCdssEvidenceContext, buildEvidenceOutputTransform } from "@/lib/cdss-evidence-context";
import { normalizeCaseTextForFormulaRecall } from "@/lib/formula-recall-normalization.server";
import { assistedNegationClauses } from "@/lib/polarity-negation-assist.server";
import { buildDiagnosePrompt } from "@/lib/diagnosis-prompts";
import { readCaseStateRequest } from "@/lib/diagnosis-request";
import { buildDiagnoseContractSignatureContext, signDiagnoseReasoning } from "@/lib/reasoning-contract-signature";
import { authoritativePatientAgeYears, buildSafetyLimitedDiagnosis, buildSafetyLimitedDiagnosisReasoning, clinicalGroundingText, markdownNdjsonResponse, renderSafetyLimitedDiagnosisContract, sanitizeCaseStateForModel, sanitizeUngroundedRedFlagNegations, withSafetyGate } from "@/lib/diagnosis-safety";
import { hasValidClinicalFactsAttestation, maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { retrieveTcmFormulaIndicationCandidates } from "@/lib/tcm-formula-indications";

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
      reasons: [`当前记录仅含既往、已缓解或稳定背景（原文：“${encounterScope.quote}”），未明确本次活动性诊疗目标，不据此推演当前剂量处方。`],
    }));
  }
  if (gated.completeness.level !== "C" && gated.questionRounds < 1) {
    return markdownNdjsonResponse(signedLimitedDiagnosis({
      status: "needs_information",
      allowDiagnosis: true,
      allowDosePrescription: false,
      action: "complete_before_prescription",
      missingItems: gated.safetyGate?.missingItems || ["与当前主诉相关的现病史和四诊信息"],
      missingItemCodes: gated.safetyGate?.missingItemCodes,
      redFlags: [],
      advisories: gated.safetyGate?.advisories,
      reasons: ["当前尚未完成首轮重点追问；请优先补充能改变诊断、辨证或处置的关键信息。若患者确实无法补充，完成本轮追问后仍可基于现有信息进行有限推理。"],
    }));
  }

  const safeState = sanitizeCaseStateForModel(gated);
  // 口语主诉在受控主治语料里匹配不到术语时（"睡不着觉""腰杆子疼"），先用轻量模型改写成标准中医
  // 术语作为检索查询。只影响候选召回，不进入病历事实、不呈现给医生；不可用时静默降级为纯确定性召回。
  // 两个增补层互不依赖，并发跑；任一不可用都静默退回确定性行为。
  const [formulaRecallHint, assistedNegations] = await Promise.all([
    normalizeCaseTextForFormulaRecall(safeState),
    assistedNegationClauses(safeState),
  ]);
  const evidenceContext = await buildCdssEvidenceContext(safeState, "diagnose", formulaRecallHint, assistedNegations);
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
    missingItems: ["本次辨病辨证结果完整性"],
    redFlags: [],
    reasons: ["本次辨病辨证结果未通过完整性与临床一致性复核，本轮不生成剂量级候选。"],
  };
  return callDiagnosisStream(prompt, "deepseek", undefined, "markdown", {
    requestSignal: req.signal,
    truncateFallback: signedLimitedDiagnosis(truncatedGate),
    authoritativeTruncateFallback: true,
    structuredStage: "diagnose",
    // Structured retries and independent review are external model calls. Keep their grounding
    // context on the same deidentified DTO as the primary generation request.
    structuredClinicalContext: clinicalGroundingText(safeState),
    structuredPatientAge: authoritativePatientAgeYears(gated),
    structuredAllowedM03FormulaNames: retrieveTcmFormulaIndicationCandidates(safeState)
      .filter((item) => item.prescriptionLockEligible)
      .map((item) => item.name),
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
