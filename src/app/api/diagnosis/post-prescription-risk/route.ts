import { readCustomerBoundCaseStateRequest } from "@/lib/diagnosis-request";
import {
  buildLocalHighRiskHerbPairSection,
  buildPrescriptionInputAdvisories,
  buildPrescriptionInputAdvisorySection,
  buildRetainedPrescriptionRiskSection,
  prescriptionSubmissionIssue,
  resolvePrescriptionCandidateIndex,
} from "@/lib/local-prescription-checks";
import { RXAUDIT_DISABLED_REASON, skippedRxAuditCorrelation } from "@/lib/rxaudit-status";
import { buildDeterministicRiskFollowupPayload, clinicalGroundingText, deriveSafetyLocked, withSafetyGate } from "@/lib/diagnosis-safety";
import { withPostPrescriptionWarningObservation } from "@/lib/warning-display-receipt.server";
import { authorFollowupForCase } from "@/lib/m05-followup-authoring.server";
import { diagnoseReasoningFromState, prescribeReasoningFromState } from "@/lib/diagnosis-parse";
import { m04SafetyContractIssue } from "@/lib/diagnosis-stage-contract";
import { editedPrescriptionSemanticIssue } from "@/lib/prescription-revision";
import { clinicalDeliveryAdvisoryFromIssue, clinicalDeliveryAdvisorySection, collectClinicalDeliveryAdvisories, deduplicateClinicalDeliveryAdvisories } from "@/lib/clinical-delivery-advisory";
import { issuePrescriptionRevisionAttestation, verifyPrescriptionRevisionAttestation } from "@/lib/prescription-revision-attestation.server";
import { computePrescriptionVersionHash } from "@/lib/prescription-version";
import { verifyDiagnoseReasoningSignature, verifyPrescribeReasoningSignature } from "@/lib/reasoning-contract-signature";
import { maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { isKnownTcmHerbName } from "@/lib/tcm-knowledge";
import { hasHisWorkbenchEditShape } from "@/lib/his-prescription-validation";

export async function POST(req: Request) {
  const parsed = await readCustomerBoundCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;
  // Reject stale/cross-tenant contracts before the semantic backstop can make an upstream
  // request. The additive facts layer does not participate in the clinical contract signature.
  const initialDiagnoseReasoning = diagnoseReasoningFromState(parsed.caseState);
  const initialPrescribed = prescribeReasoningFromState(parsed.caseState);
  const workbenchRevision = parsed.caseState.prescriptionRevision?.source === "herb_workbench";
  if (workbenchRevision && !verifyDiagnoseReasoningSignature(initialDiagnoseReasoning, parsed.caseState)) {
    return Response.json({
      error: "辨病辨证结果签名已失效，请重新生成辨证后再调整药味。",
      code: "invalid_m03_signature",
    }, { status: 409 });
  }
  if (!workbenchRevision && !verifyPrescribeReasoningSignature(initialPrescribed, parsed.caseState)) {
    return Response.json({
      error: "当前候选处方缺少与本病例及辨证结果绑定的有效签名，或签名后内容已变更；请重新生成候选方药后再审方。",
      code: "invalid_m04_signature",
    }, { status: 409 });
  }
  // A workbench edit is a new artifact. The pre-edit M04 review/signature is neither proof for the
  // edited herbs nor trusted client input. Reject it at the sole revision-attestation issuer so a
  // caller cannot forge a public reviewedPayloadHash and have this route HMAC-sign that provenance.
  if (workbenchRevision && (
    initialPrescribed?.clinicalReview != null ||
    initialPrescribed?.contractSignature != null ||
    initialPrescribed?.contractSignatureVersion != null
  )) {
    return Response.json({
      error: "医生编辑后的处方仍携带编辑前的合同签名，请从当前药味表重新生成待审版本。",
      code: "stale_workbench_contract_metadata",
      section: "## 合理用药审方\n**提交前校验**：编辑前的合同签名不适用于当前药味版本。\n**处置建议**：请从药味工作台重新提交，系统将对当前精确版本重新执行安全校验与审方。",
      risks: [],
    }, { status: 422 });
  }
  const caseState = withSafetyGate(await maybeAttachClinicalFactsBackstop(parsed.caseState, undefined, req.signal));
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
  if (caseState.prescriptionRevision?.source === "herb_workbench" && !hasHisWorkbenchEditShape(caseState, prescribed)) {
    return Response.json({
      error: "当前内容不是由药味工作台形成的规范医生编辑版，未建立可写回版本。",
      code: "invalid_workbench_edit_shape",
      section: "## 合理用药审方\n**提交前校验**：当前内容不是规范医生编辑版。\n**处置建议**：请从药味工作台重新编辑并审方。",
      risks: [],
      audit: {
        source: "local_input_validation",
        safetyLocked: deriveSafetyLocked(caseState),
        degraded: false,
        reason: "invalid_workbench_edit_shape",
        needManualReview: true,
        herbHash,
        auditedAt: new Date().toISOString(),
      },
    }, { status: 422 });
  }
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
      clinicalAdvisories.push(clinicalDeliveryAdvisoryFromIssue(floorIssue, selectedCandidate, candidateIndex));
    }
  }
  const submissionIssue = prescriptionSubmissionIssue(caseState, resolvedCandidateIndex);
  if (submissionIssue && selectedCandidate) {
    clinicalAdvisories.push(clinicalDeliveryAdvisoryFromIssue(submissionIssue, selectedCandidate, candidateIndex));
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
  const attestation = retainedPrior || !workbenchRevision ? undefined
    : issuePrescriptionRevisionAttestation(caseState, parsed.customer, revision);
  if (workbenchRevision && !retainedPrior && !attestation) {
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
