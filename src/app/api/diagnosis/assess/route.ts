import { readCustomerBoundCaseStateRequest } from "@/lib/diagnosis-request";
import {
  buildDeterministicRiskFollowup,
  clinicalGroundingText,
  deriveSafetyLocked,
  markdownNdjsonResponse,
  sanitizeUngroundedRedFlagNegations,
  withSafetyGate,
} from "@/lib/diagnosis-safety";
import {
  applyRxAuditInputAdvisories,
  buildAuditInputAdvisories,
  buildAuditInputAdvisorySection,
  buildLingxiRiskSection,
  buildLocalHighRiskHerbPairSection,
  buildRxAuditScopeSection,
  rxAuditPresentationEnabled,
  resolveProviderCompatibilityFindings,
  buildRxAuditCorrelationMarker,
  buildRxAuditCorrelationMetadata,
  buildUnavailableRxAuditSection,
  isRxAuditSubmissionIssueReason,
  mergeLocalHighRiskHerbPairIssues,
  normalizeAuditOutcomeForPatient,
  resolveRxAuditCandidateIndex,
  runBoundedRxAudit,
} from "@/lib/rxaudit";
import { buildRxAuditStatusMarker } from "@/lib/rxaudit-status";
import { maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { authorFollowupForCase } from "@/lib/m05-followup-authoring.server";
import { diagnoseReasoningFromState, prescribeReasoningFromState } from "@/lib/diagnosis-parse";
import { computePrescriptionVersionHash } from "@/lib/prescription-version";
import { editedPrescriptionIssueMessage, editedPrescriptionSemanticIssue, hasIncompleteEditedHerb } from "@/lib/prescription-revision";
import { verifyDiagnoseReasoningSignature, verifyPrescribeReasoningSignature } from "@/lib/reasoning-contract-signature";
import { recordCdssStageTelemetry } from "@/lib/cdss-stage-telemetry";
import { isTrustedHisWorkbenchEdit } from "@/lib/his-prescription-validation";

export async function POST(req: Request) {
  const startedAt = Date.now();
  const parsed = await readCustomerBoundCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;
  // Signature verification is the first trust-boundary operation after tenant binding. In
  // particular, a cross-tenant replay must return 409 before semantic fact extraction or any other
  // paid upstream call. Clinical facts are not part of the signed clinical-input snapshot, so the
  // later additive backstop cannot change this decision.
  const initialDiagnoseReasoning = diagnoseReasoningFromState(parsed.caseState);
  const initialPrescribed = prescribeReasoningFromState(parsed.caseState);
  const workbenchRevision = parsed.caseState.prescriptionRevision?.source === "herb_workbench";
  if (workbenchRevision) {
    if (!verifyDiagnoseReasoningSignature(initialDiagnoseReasoning, parsed.caseState)) {
      return Response.json({
        error: "辨病辨证结果签名已失效，请重新生成后再评估。",
        code: "invalid_m03_signature",
      }, { status: 409 });
    }
    const workbenchCandidateIndex = parsed.caseState.prescriptionRevision?.candidateIndex ?? 0;
    const workbenchHerbHash = initialPrescribed
      ? await computePrescriptionVersionHash(initialPrescribed, workbenchCandidateIndex, parsed.caseState)
      : "";
    if (!isTrustedHisWorkbenchEdit(parsed.caseState, initialPrescribed, {
      clientId: parsed.customer.clientId,
      customerId: parsed.customer.customerId,
      herbHash: workbenchHerbHash,
    })) {
      return Response.json({
        error: "当前医生编辑版缺少与本病例、租户及精确处方版本绑定的有效审方凭据，请重新审方。",
        code: "invalid_workbench_revision_attestation",
      }, { status: 409 });
    }
  } else if (!verifyPrescribeReasoningSignature(initialPrescribed, parsed.caseState)) {
    return Response.json({
      error: "当前候选处方缺少与本病例及辨证结果绑定的有效签名，或签名后内容已变更；请重新生成候选方药后再评估。",
      code: "invalid_m04_signature",
    }, { status: 409 });
  }
  const caseState = await maybeAttachClinicalFactsBackstop(parsed.caseState, undefined, req.signal);
  const gated = withSafetyGate(caseState);
  const diagnoseReasoning = diagnoseReasoningFromState(gated);
  const prescribed = prescribeReasoningFromState(gated);
  const explicitCandidateIndex = gated.prescriptionRevision?.candidateIndex;
  const candidateIndex = explicitCandidateIndex ?? resolveRxAuditCandidateIndex(gated);
  const selectedCandidate = candidateIndex == null ? undefined : prescribed?.formula?.candidates[candidateIndex];
  if (workbenchRevision && (!selectedCandidate || selectedCandidate.herbs.length === 0)) {
    return Response.json({
      error: "所选候选方不存在或没有结构化药味，未进入评估。",
      code: "invalid_candidate_index",
    }, { status: 422 });
  }
  if (workbenchRevision && selectedCandidate?.herbs.some(hasIncompleteEditedHerb)) {
    return Response.json({
      error: "药味名称、单一正数剂量（g/克/mg/毫克）、对应病机或功用不完整，未进入评估。",
      code: "invalid_structured_herb",
    }, { status: 422 });
  }
  if (workbenchRevision) {
    const semanticIssue = editedPrescriptionSemanticIssue(
      prescribed,
      candidateIndex ?? 0,
      diagnoseReasoning,
      clinicalGroundingText(gated),
    );
    if (semanticIssue) {
      return Response.json({
        error: editedPrescriptionIssueMessage(semanticIssue),
        code: `invalid_edited_prescription_${semanticIssue}`,
        issue: semanticIssue,
      }, { status: 422 });
    }
  }
  const { medicationExtraction, providerAudit } = await runBoundedRxAudit(gated, candidateIndex, req.signal);
  const inputAdvisories = buildAuditInputAdvisories(gated, candidateIndex, medicationExtraction);
  const inputAdvisorySection = buildAuditInputAdvisorySection(inputAdvisories);

  // M05 owns the single server-side audit call for the normal M03->M04->M05 chain. Client-supplied
  // audit-looking Markdown is never trusted, but every audit outcome is advisory rather than blocking.
  if (!providerAudit.ok) console.warn("[tcm-cdss:rxaudit] M05 advisory audit unavailable", { reason: providerAudit.reason });
  // 配伍查询与主审方独立：主审方成功时并入 effectiveAudit，不可因展示开关丢失；
  // 主审方不可用时则仍由本地配伍段呈现。两条路径共用 providerCompatibilityIssues 去重。
  const providerCompatibility = await resolveProviderCompatibilityFindings(gated, candidateIndex, req.signal);
  const mergedAudit = providerAudit.ok
    ? mergeLocalHighRiskHerbPairIssues(gated, candidateIndex, providerAudit, providerCompatibility)
    : providerAudit;
  const patientSex = gated.hisRecord?.fields.sex || gated.patient.sex;
  const effectiveAudit = mergedAudit.ok
    ? applyRxAuditInputAdvisories(normalizeAuditOutcomeForPatient(mergedAudit, patientSex), inputAdvisories)
    : undefined;
  // 审方展示被关闭时（本客户默认档）：报告里不出现任何以三方审方为主语的内容——
  // 结论、范围说明、输入待核对、以及「自动审方未完成」。但**本地确定性配伍预检必须照出**，
  // 而且不能再挂在 providerAudit.ok 上：那个条件原本的含义是「审方没给结论时用本地兜底」，
  // 展示关闭后若沿用它，审方正常返回的病例反而一条本地提示都看不到。
  const showRxAudit = rxAuditPresentationEnabled();
  // 配伍禁忌属本地安全内容：两档都出，且不受审方是否可用影响。供应商条目只加不减地追加。
  const localHighRiskSection = buildLocalHighRiskHerbPairSection(gated, candidateIndex, providerCompatibility);
  const providerRisk = effectiveAudit
    ? buildLingxiRiskSection(effectiveAudit, patientSex)
    : buildUnavailableRxAuditSection(providerAudit.ok ? "rxaudit_incomplete" : providerAudit.reason);
  const postPrescriptionRisk = (showRxAudit
    ? [
        buildRxAuditScopeSection(gated, candidateIndex),
        providerAudit.ok ? "" : localHighRiskSection,
        inputAdvisorySection,
        providerRisk,
      ]
    : [localHighRiskSection, buildAuditInputAdvisorySection(inputAdvisories, true)]
  ).filter(Boolean).join("\n\n");
  const auditStatusMarker = buildRxAuditStatusMarker(!showRxAudit
    ? { available: false, presentationDisabled: true }
    : providerAudit.ok && !providerAudit.degraded
      ? { available: true }
      : {
          available: false,
          reason: !providerAudit.ok && (providerAudit.reason === "no_prescription_items" || isRxAuditSubmissionIssueReason(providerAudit.reason))
            ? "no_prescription_items"
            : "service_unavailable",
        });
  const prescriptionHash = prescribed && candidateIndex != null
    ? await computePrescriptionVersionHash(prescribed, candidateIndex, gated)
    : "";
  const correlationMarker = buildRxAuditCorrelationMarker(buildRxAuditCorrelationMetadata({
    providerOutcome: providerAudit,
    effectiveOutcome: effectiveAudit,
    candidateIndex,
    prescriptionHash,
  }));
  const safetyLocked = deriveSafetyLocked(gated);
  const assessed = withSafetyGate({
    ...gated,
    riskAssessment: postPrescriptionRisk,
    safetyLocked,
  });
  // M05 的临床内容由模型按本例证候撰写；安全总评仍是确定性的（见 buildDeterministicRiskFollowupPayload）。
  // 不可用/超时/校验不过一律返回 null，逐字回落原模板——这一步只增不减。
  const authoredFollowup = await authorFollowupForCase(
    assessed,
    diagnoseReasoning,
    selectedCandidate,
    req.signal,
  );
  const followup = buildDeterministicRiskFollowup(assessed, authoredFollowup);
  recordCdssStageTelemetry({
    stage: "assess",
    outcome: "success",
    durationMs: Date.now() - startedAt,
    auditReached: providerAudit.ok || !isRxAuditSubmissionIssueReason(providerAudit.reason),
    reasonCode: providerAudit.ok ? "audit_available" : `audit_${providerAudit.reason}`,
  });
  return markdownNdjsonResponse([
    auditStatusMarker,
    correlationMarker,
    sanitizeUngroundedRedFlagNegations([postPrescriptionRisk, followup].join("\n\n"), gated),
  ].join("\n\n"));
}
