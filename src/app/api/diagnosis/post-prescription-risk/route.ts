import { readCustomerBoundCaseStateRequest } from "@/lib/diagnosis-request";
import {
  applyRxAuditInputAdvisories,
  buildAuditInputAdvisories,
  buildAuditInputAdvisorySection,
  buildLingxiRiskSection,
  buildLocalHighRiskHerbPairSection,
  buildRxAuditScopeSection,
  buildRxAuditCorrelationMetadata,
  buildUnavailableRxAuditSection,
  mergeLocalHighRiskHerbPairIssues,
  normalizeAuditOutcomeForPatient,
  resolveRxAuditCandidateIndex,
  runBoundedRxAudit,
  rxAuditSubmissionIssue,
} from "@/lib/rxaudit";
import { buildDeterministicRiskFollowupPayload, clinicalGroundingText, deriveSafetyLocked, withSafetyGate } from "@/lib/diagnosis-safety";
import { authorFollowupForCase } from "@/lib/m05-followup-authoring.server";
import { diagnoseReasoningFromState, prescribeReasoningFromState } from "@/lib/diagnosis-parse";
import { m04SafetyContractIssue } from "@/lib/diagnosis-stage-contract";
import { editedPrescriptionSemanticIssue } from "@/lib/prescription-revision";
import { clinicalDeliveryAdvisoryFromIssue, clinicalDeliveryAdvisorySection, collectClinicalDeliveryAdvisories, deduplicateClinicalDeliveryAdvisories } from "@/lib/clinical-delivery-advisory";
import { issuePrescriptionRevisionAttestation } from "@/lib/prescription-revision-attestation.server";
import { computePrescriptionVersionHash } from "@/lib/prescription-version";
import { verifyDiagnoseReasoningSignature, verifyPrescribeReasoningSignature } from "@/lib/reasoning-contract-signature";
import { maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { isKnownTcmHerbName } from "@/lib/tcm-knowledge";
import { hasHisWorkbenchEditShape } from "@/lib/his-prescription-validation";

export async function POST(req: Request) {
  const parsed = await readCustomerBoundCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;
  // Reject stale/cross-tenant contracts before semantic backstop or RxAudit can make an upstream
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
      error: "医生编辑后的处方仍携带编辑前的模型复核或合同签名，请从当前药味表重新生成待审版本。",
      code: "stale_workbench_contract_metadata",
      section: "## 合理用药审方\n**提交前校验**：编辑前的模型复核与合同签名不适用于当前药味版本。\n**处置建议**：请从药味工作台重新提交，系统将对当前精确版本重新执行安全校验与审方。",
      risks: [],
    }, { status: 422 });
  }
  const caseState = withSafetyGate(await maybeAttachClinicalFactsBackstop(parsed.caseState, undefined, req.signal));
  const diagnoseReasoning = diagnoseReasoningFromState(caseState);
  const prescribed = prescribeReasoningFromState(caseState);
  const explicitCandidateIndex = caseState.prescriptionRevision?.candidateIndex;
  const resolvedCandidateIndex = explicitCandidateIndex ?? resolveRxAuditCandidateIndex(caseState);
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
    const floorIssue = m04SafetyContractIssue(
      selectedReasoning,
      diagnoseReasoning,
      isKnownTcmHerbName,
      true,
      false,
      clinicalGroundingText(caseState),
      true,
    );
    if (floorIssue && !clinicalAdvisories.some((advisory) => advisory.code === floorIssue)) {
      clinicalAdvisories.push(clinicalDeliveryAdvisoryFromIssue(floorIssue, selectedCandidate, candidateIndex));
    }
  }
  const submissionIssue = rxAuditSubmissionIssue(caseState, resolvedCandidateIndex);
  if (submissionIssue && selectedCandidate) {
    clinicalAdvisories.push(clinicalDeliveryAdvisoryFromIssue(submissionIssue, selectedCandidate, candidateIndex));
  }
  // runBoundedRxAudit reports unprocessable audit inputs without making an upstream call.
  // Keep its manual-review result visible with the clinical report.
  clinicalAdvisories = deduplicateClinicalDeliveryAdvisories(clinicalAdvisories);
  const { medicationExtraction, providerAudit } = await runBoundedRxAudit(caseState, resolvedCandidateIndex, req.signal);
  const inputAdvisories = buildAuditInputAdvisories(caseState, resolvedCandidateIndex, medicationExtraction);
  const auditedAt = new Date().toISOString();

  if (providerAudit.ok) {
    const mergedAudit = mergeLocalHighRiskHerbPairIssues(caseState, resolvedCandidateIndex, providerAudit);
    const safetyLocked = deriveSafetyLocked(caseState);
    const patientSex = caseState.hisRecord?.fields.sex || caseState.patient.sex;
    const normalizedAudit = applyRxAuditInputAdvisories(
      normalizeAuditOutcomeForPatient(mergedAudit, patientSex),
      inputAdvisories,
    );
    const effectiveAudit: typeof normalizedAudit = clinicalAdvisories.length > 0 ? {
      ...normalizedAudit,
      auditResult: normalizedAudit.auditResult === "BLOCK" ? "BLOCK" : "MANUAL_REVIEW",
      highestRiskLevel: normalizedAudit.highestRiskLevel === "CRITICAL" ? "CRITICAL" : "HIGH",
      needManualReview: true,
    } : normalizedAudit;
    const inputAdvisorySection = buildAuditInputAdvisorySection(inputAdvisories);
    const section = [
      clinicalDeliveryAdvisorySection(clinicalAdvisories),
      buildRxAuditScopeSection(caseState, resolvedCandidateIndex),
      inputAdvisorySection,
      buildLingxiRiskSection(effectiveAudit, patientSex),
    ].filter(Boolean).join("\n\n");
    const assessed = withSafetyGate({ ...caseState, riskAssessment: section, safetyLocked });
    const followup = buildDeterministicRiskFollowupPayload(
      assessed,
      await authorFollowupForCase(assessed, diagnoseReasoning, selectedCandidate, req.signal),
    );
    const correlation = buildRxAuditCorrelationMetadata({
      providerOutcome: providerAudit,
      effectiveOutcome: effectiveAudit,
      candidateIndex,
      prescriptionHash: herbHash,
      auditedAt,
    });
    const revisionAttestation = workbenchRevision
      ? issuePrescriptionRevisionAttestation(caseState, parsed.customer, {
          source: "herb_workbench",
          candidateIndex,
          herbHash,
          auditedAt,
          auditResult: effectiveAudit.auditResult,
          highestRiskLevel: effectiveAudit.highestRiskLevel,
          auditAvailable: providerAudit.degraded !== true,
          degraded: providerAudit.degraded === true,
          degradeReason: providerAudit.degradeReason,
          needManualReview: effectiveAudit.needManualReview === true,
          auditId: providerAudit.auditId,
          traceId: providerAudit.traceId,
        })
      : undefined;
    if (workbenchRevision && !revisionAttestation) {
      return Response.json({
        error: "工作台处方版本签发不可用，未建立可写回凭据，请稍后重试。",
        code: "workbench_revision_attestation_unavailable",
      }, { status: 503 });
    }
    return Response.json({
      section,
      warnings: clinicalAdvisories,
      followup: followup.markdown,
      followupTimeline: followup.timelineItems,
      risks: [],
      audit: {
        source: "lingxi",
        safetyLocked,
        auditResult: effectiveAudit.auditResult,
        highestRiskLevel: effectiveAudit.highestRiskLevel,
        needManualReview: effectiveAudit.needManualReview,
        degraded: providerAudit.degraded,
        degradeReason: providerAudit.degradeReason,
        issues: effectiveAudit.issues,
        inputAdvisories,
        medicationSemantics: {
          source: medicationExtraction.source,
          needsManualReview: medicationExtraction.needsManualReview,
          currentMedicationCount: medicationExtraction.events.filter((event) => event.status === "current" && event.confidence >= 0.7).length,
        },
        providerAuditResult: providerAudit.auditResult,
        providerHighestRiskLevel: providerAudit.highestRiskLevel,
        effectiveAuditResult: effectiveAudit.auditResult,
        effectiveHighestRiskLevel: effectiveAudit.highestRiskLevel,
        auditId: providerAudit.auditId,
        traceId: providerAudit.traceId,
        candidateIndex,
        herbHash,
        prescriptionHash: herbHash,
        auditedAt,
        correlation,
        ...revisionAttestation,
      },
    });
  }

  console.warn("[tcm-cdss:rxaudit] post-prescription advisory audit unavailable", { reason: providerAudit.reason });
  const section = [
    clinicalDeliveryAdvisorySection(clinicalAdvisories),
    buildRxAuditScopeSection(caseState, resolvedCandidateIndex),
    buildLocalHighRiskHerbPairSection(caseState, resolvedCandidateIndex),
    buildAuditInputAdvisorySection(inputAdvisories),
    buildUnavailableRxAuditSection(providerAudit.reason),
  ].filter(Boolean).join("\n\n");
  const safetyLocked = deriveSafetyLocked(caseState);
  const assessed = withSafetyGate({ ...caseState, riskAssessment: section, safetyLocked });
  const followup = buildDeterministicRiskFollowupPayload(
    assessed,
    await authorFollowupForCase(assessed, diagnoseReasoning, selectedCandidate, req.signal),
  );
  const correlation = buildRxAuditCorrelationMetadata({
    providerOutcome: providerAudit,
    candidateIndex,
    prescriptionHash: herbHash,
    auditedAt,
  });
  const revisionAttestation = workbenchRevision
    ? issuePrescriptionRevisionAttestation(caseState, parsed.customer, {
        source: "herb_workbench",
        candidateIndex,
        herbHash,
        auditedAt,
        auditResult: "MANUAL_REVIEW",
        highestRiskLevel: "HIGH",
        auditAvailable: false,
        degraded: true,
        degradeReason: providerAudit.reason,
        needManualReview: true,
        auditReason: providerAudit.reason,
      })
    : undefined;
  if (workbenchRevision && !revisionAttestation) {
    return Response.json({
      error: "工作台处方版本签发不可用，未建立可写回凭据，请稍后重试。",
      code: "workbench_revision_attestation_unavailable",
    }, { status: 503 });
  }
  return Response.json({
    section,
    warnings: clinicalAdvisories,
    followup: followup.markdown,
    followupTimeline: followup.timelineItems,
    risks: [],
    audit: {
      source: "lingxi_unavailable",
      safetyLocked,
      degraded: true,
      reason: providerAudit.reason,
      degradeReason: providerAudit.reason,
      auditResult: "MANUAL_REVIEW",
      highestRiskLevel: "HIGH",
      needManualReview: true,
      inputAdvisories,
      medicationSemantics: {
        source: medicationExtraction.source,
        needsManualReview: medicationExtraction.needsManualReview,
        currentMedicationCount: medicationExtraction.events.filter((event) => event.status === "current" && event.confidence >= 0.7).length,
      },
      candidateIndex,
      herbHash,
      prescriptionHash: herbHash,
      auditedAt,
      effectiveAuditResult: "MANUAL_REVIEW",
      effectiveHighestRiskLevel: "HIGH",
      correlation,
      ...revisionAttestation,
    },
  });
}
