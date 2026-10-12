import { readCustomerBoundCaseStateRequest } from "@/lib/diagnosis-request";
import type { CaseState } from "@/lib/diagnosis-types";
import {
  buildLocalHighRiskHerbPairSection,
  buildPrescriptionInputAdvisories,
  buildPrescriptionInputAdvisorySection,
  buildRetainedPrescriptionRiskSection,
  prescriptionSubmissionIssue,
  resolvePrescriptionCandidateIndex,
} from "@/lib/local-prescription-checks";
import { RXAUDIT_DISABLED_REASON, skippedRxAuditCorrelation } from "@/lib/rxaudit-status";
import { buildDeterministicRiskFollowupPayload, clinicalGroundingText, deriveSafetyLocked, isNonDosePrescriptionText, withSafetyGate } from "@/lib/diagnosis-safety";
import { withPostPrescriptionWarningObservation } from "@/lib/warning-display-receipt.server";
import { authorFollowupForCase } from "@/lib/m05-followup-authoring.server";
import { diagnoseReasoningFromState, prescribeReasoningFromState } from "@/lib/diagnosis-parse";
import { m04SafetyContractIssue } from "@/lib/diagnosis-stage-contract";
import { editedPrescriptionSemanticIssue } from "@/lib/prescription-revision";
import { pediatricDoseRuleFromGroundingText } from "@/lib/pediatric-dose-rule";
import { clinicalDeliveryAdvisoryFromIssue, clinicalDeliveryAdvisorySection, collectClinicalDeliveryAdvisories, deduplicateClinicalDeliveryAdvisories } from "@/lib/clinical-delivery-advisory";
import { issuePrescriptionRevisionAttestation, verifyPrescriptionRevisionAttestation } from "@/lib/prescription-revision-attestation.server";
import { computePrescriptionVersionHash } from "@/lib/prescription-version";
import { verifyDiagnoseReasoningSignature, verifyPrescribeReasoningSignature } from "@/lib/reasoning-contract-signature";
import { maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { isKnownTcmHerbName } from "@/lib/tcm-knowledge";
import { hasHisWorkbenchEditShape } from "@/lib/his-prescription-validation";
import { contractProvenanceAdvisory, recordContractProvenance, type ContractProvenanceIssue } from "@/lib/contract-provenance";

/** 编辑前的合同签名与复核标记只对应编辑前的版本；医生编辑版审方前移除。 */
function stripPreEditContractMetadata(caseState: CaseState): CaseState {
  const strip = (reasoning: CaseState["reasoningPrescribe"]) => {
    if (!reasoning || reasoning.stage !== "prescribe") return reasoning;
    const rest = { ...reasoning };
    delete rest.clinicalReview;
    delete rest.contractSignature;
    delete rest.contractSignatureVersion;
    return rest;
  };
  return {
    ...caseState,
    reasoningPrescribe: strip(caseState.reasoningPrescribe),
    reasoningV2: caseState.reasoningV2?.stage === "prescribe" ? strip(caseState.reasoningV2) : caseState.reasoningV2,
  };
}

export async function POST(req: Request) {
  const parsed = await readCustomerBoundCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;
  // 签名/凭据核验只标注、不拦截（owner 2026-10-12；contract-provenance.ts）。核验不通过时照常
  // 对回传的药味做本地确定性核对并给出来源提示；只有未核验内容不会因此获得新的服务端凭据。
  const initialDiagnoseReasoning = diagnoseReasoningFromState(parsed.caseState);
  const initialPrescribed = prescribeReasoningFromState(parsed.caseState);
  const workbenchRevision = parsed.caseState.prescriptionRevision?.source === "herb_workbench";
  const provenanceIssues: ContractProvenanceIssue[] = [];
  if (workbenchRevision && !verifyDiagnoseReasoningSignature(initialDiagnoseReasoning, parsed.caseState)) {
    provenanceIssues.push("m03_unverified");
  }
  if (!workbenchRevision && initialPrescribed && !verifyPrescribeReasoningSignature(initialPrescribed, parsed.caseState)) {
    provenanceIssues.push("m04_unverified");
  }
  // 医生编辑版是新的产物，编辑前的 M04 复核标记与合同签名对它既不是证明、也不能被本路由的 HMAC
  // 沿用成「已复核」来源。原先整份 422；现在剥掉这些旧字段后照常审方。
  let reviewState = parsed.caseState;
  if (workbenchRevision && (
    initialPrescribed?.clinicalReview != null ||
    initialPrescribed?.contractSignature != null ||
    initialPrescribed?.contractSignatureVersion != null
  )) {
    reviewState = stripPreEditContractMetadata(parsed.caseState);
    provenanceIssues.push("workbench_pre_edit_metadata_removed");
  }
  // 没有结构化药味、只有处方文本：与 assess / his-scheme 同一口径，文本不进入核对（原先 409）。
  const legacyPrescription = typeof parsed.caseState.prescription === "string" ? parsed.caseState.prescription.trim() : "";
  if (!workbenchRevision && !initialPrescribed && legacyPrescription && !isNonDosePrescriptionText(legacyPrescription)) {
    reviewState = { ...reviewState, prescription: "" };
    provenanceIssues.push("unstructured_prescription_ignored");
  }
  const caseState = withSafetyGate(await maybeAttachClinicalFactsBackstop(reviewState, undefined, req.signal));
  const diagnoseReasoning = diagnoseReasoningFromState(caseState);
  const prescribed = prescribeReasoningFromState(caseState);
  const explicitCandidateIndex = caseState.prescriptionRevision?.candidateIndex;
  const resolvedCandidateIndex = explicitCandidateIndex ?? resolvePrescriptionCandidateIndex(caseState);
  const candidateIndex = resolvedCandidateIndex ?? 0;
  const selectedCandidate = prescribed?.formula?.candidates[candidateIndex];
  const herbHash = prescribed ? await computePrescriptionVersionHash(prescribed, candidateIndex, caseState) : "";
  const semanticIssue = caseState.prescriptionRevision?.source === "herb_workbench"
    ? editedPrescriptionSemanticIssue(prescribed, candidateIndex, diagnoseReasoning, clinicalGroundingText(caseState))
    : undefined;
  // 形态不是规范医生编辑版：照常完成安全核对与随访，但不签发可写回版本的审方凭据（原先整份 422）。
  const editShapeUnattested = caseState.prescriptionRevision?.source === "herb_workbench" && !hasHisWorkbenchEditShape(caseState, prescribed);
  if (editShapeUnattested) provenanceIssues.push("workbench_edit_shape_unattested");
  if (caseState.prescriptionRevision?.source === "herb_workbench" && (!selectedCandidate || selectedCandidate.herbs.length === 0 || !herbHash)) {
    return Response.json({
      error: "所选候选方不存在或没有结构化药味，未提交自动审方。",
      code: "invalid_candidate_index",
      section: "## 合理用药审方\n**审方服务状态**：所选候选方不存在或没有结构化药味，未提交自动审方。\n**处置建议**：请重新选择有效候选方。",
      risks: [],
      audit: { source: "local_input_validation", safetyLocked: deriveSafetyLocked(caseState), degraded: false, reason: "invalid_candidate_index", needManualReview: true, herbHash: "", auditedAt: new Date().toISOString() },
    }, { status: 422 });
  }
  let clinicalAdvisories = selectedCandidate
    ? collectClinicalDeliveryAdvisories(selectedCandidate, diagnoseReasoning, clinicalGroundingText(caseState), [semanticIssue], candidateIndex)
    : [];
  if (caseState.prescriptionRevision?.source === "herb_workbench" && selectedCandidate && prescribed) {
    const selectedReasoning = {
      ...prescribed,
      formula: prescribed.formula ? { ...prescribed.formula, candidates: [selectedCandidate] } : null,
    };
    // The revision attests which edited version was reviewed, not an absence of clinical risk.
    // Findings accompany the exact version so the physician can continue reviewing the report.
    const floorIssue = m04SafetyContractIssue(selectedReasoning, diagnoseReasoning, {
      isKnownHerbName: isKnownTcmHerbName,
      trustedWorkbenchEdit: true,
      auditedClinicalRisksAreAdvisory: false,
      clinicalContext: clinicalGroundingText(caseState),
      waiveTherapyCoverageAnnotated: true,
    });
    if (floorIssue && !clinicalAdvisories.some((advisory) => advisory.code === floorIssue)) {
      clinicalAdvisories.push(clinicalDeliveryAdvisoryFromIssue(floorIssue, selectedCandidate, candidateIndex, pediatricDoseRuleFromGroundingText(clinicalGroundingText(caseState))));
    }
  }
  const submissionIssue = prescriptionSubmissionIssue(caseState, resolvedCandidateIndex);
  if (submissionIssue && selectedCandidate) {
    clinicalAdvisories.push(clinicalDeliveryAdvisoryFromIssue(submissionIssue, selectedCandidate, candidateIndex, pediatricDoseRuleFromGroundingText(clinicalGroundingText(caseState))));
  }
  if (provenanceIssues.length > 0) {
    recordContractProvenance("post-prescription-risk", provenanceIssues);
    clinicalAdvisories.push(...provenanceIssues.map((issue) => contractProvenanceAdvisory(issue, candidateIndex)));
  }
  clinicalAdvisories = deduplicateClinicalDeliveryAdvisories(clinicalAdvisories);
  const inputAdvisories = buildPrescriptionInputAdvisories(caseState, resolvedCandidateIndex);
  const auditedAt = new Date().toISOString();

  // 合理用药审方已删除（owner 2026-09-25）。本路由只做本地确定性核对并为当前精确版本签发
  // 「未送审」收据；对外字段（source:"skipped"、auditResult:"NOT_SUBMITTED"、presentationDisabled…）
  // 是原显式停用档的逐字节输出，集成方与签名收据都依赖它们。
  // Preserve genuine risk for this exact version. Client placeholders or changed hashes cannot
  // supply prior authority; the original HMAC remains the evidence, not a new audit result.
  const prior = caseState.prescriptionRevision;
  const retainedPrior = prior && (prior.auditResult === "BLOCK" || prior.highestRiskLevel === "CRITICAL") &&
    verifyPrescriptionRevisionAttestation(caseState, parsed.customer, herbHash) ? prior : undefined;
  const localHighRiskSection = buildLocalHighRiskHerbPairSection(caseState, resolvedCandidateIndex);
  const section = [
    clinicalDeliveryAdvisorySection(clinicalAdvisories),
    localHighRiskSection,
    buildPrescriptionInputAdvisorySection(inputAdvisories),
    buildRetainedPrescriptionRiskSection(retainedPrior),
  ].filter(Boolean).join("\n\n");
  const safetyLocked = deriveSafetyLocked(caseState);
  const assessed = withSafetyGate({ ...caseState, riskAssessment: section, safetyLocked });
  const followup = buildDeterministicRiskFollowupPayload(assessed,
    await authorFollowupForCase(assessed, diagnoseReasoning, selectedCandidate, req.signal));
  const revision: NonNullable<typeof caseState.prescriptionRevision> = retainedPrior || {
    source: "herb_workbench", candidateIndex, herbHash, auditedAt,
    auditResult: "NOT_SUBMITTED", auditAvailable: false, degraded: false,
    auditReason: RXAUDIT_DISABLED_REASON, needManualReview: inputAdvisories.length > 0 || clinicalAdvisories.length > 0 || Boolean(localHighRiskSection),
  };
  const attestation = retainedPrior || !workbenchRevision || editShapeUnattested ? undefined
    : issuePrescriptionRevisionAttestation(caseState, parsed.customer, revision);
  if (workbenchRevision && !retainedPrior && !editShapeUnattested && !attestation) {
    return Response.json({ error: "工作台处方版本签发不可用，未建立可写回凭据，请稍后重试。", code: "workbench_revision_attestation_unavailable" }, { status: 503 });
  }
  return Response.json(await withPostPrescriptionWarningObservation({
    section, warnings: clinicalAdvisories, followup: followup.markdown,
    followupTimeline: followup.timelineItems, risks: [],
    audit: {
      ...revision, ...attestation,
      source: "skipped", reason: RXAUDIT_DISABLED_REASON, presentationDisabled: true, retainedPriorAudit: Boolean(retainedPrior),
      safetyLocked, inputAdvisories, prescriptionHash: herbHash,
      correlation: skippedRxAuditCorrelation({ candidateIndex, prescriptionHash: herbHash, auditedAt }),
    },
  }, {
    requestState: parsed.caseState, producerState: caseState, customer: parsed.customer,
    sourceRepresentation: (parsed.body as { caseState?: unknown }).caseState,
    sectionProjection: { markdown: section, currentRiskMarkdown: section }, followupProjection: followup,
    audit: undefined, auditSkipped: true, advisories: clinicalAdvisories,
  }));
}
