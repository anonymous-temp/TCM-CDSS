import { readCustomerBoundCaseStateRequest } from "@/lib/diagnosis-request";
import {
  buildDeterministicRiskFollowupProjection,
  clinicalGroundingText,
  deriveSafetyLocked,
  isNonDosePrescriptionText,
  markdownNdjsonResponse,
  sanitizeUngroundedRedFlagNegations,
  withSafetyGate,
} from "@/lib/diagnosis-safety";
import {
  buildLocalHighRiskHerbPairSection,
  buildPrescriptionInputAdvisories,
  buildPrescriptionInputAdvisorySection,
  buildRetainedPrescriptionRiskSection,
  resolvePrescriptionCandidateIndex,
} from "@/lib/local-prescription-checks";
import { RXAUDIT_DISABLED_STATUS_MARKER, skippedRxAuditCorrelation, skippedRxAuditCorrelationMarker } from "@/lib/rxaudit-status";
import { maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { authorFollowupForCase } from "@/lib/m05-followup-authoring.server";
import { diagnoseReasoningFromState, prescribeReasoningFromState } from "@/lib/diagnosis-parse";
import { computePrescriptionVersionHash } from "@/lib/prescription-version";
import { joinedWarningProjections, mapWarningText } from "@/lib/warning-text-projection";
import { finalizeM05DisplayResult } from "@/lib/followup-display-state";
import { createWarningDisplayReceipt } from "@/lib/warning-display-receipt.server";
import { deriveStructuredCaseWarningFloor } from "@/lib/clinical-warning-tier";
import type { ClinicalDeliveryAdvisory } from "@/lib/clinical-delivery-advisory";
import { editedPrescriptionSemanticIssue } from "@/lib/prescription-revision";
import { collectClinicalDeliveryAdvisories, clinicalDeliveryAdvisorySection } from "@/lib/clinical-delivery-advisory";
import { verifyDiagnoseReasoningSignature, verifyPrescribeReasoningSignature } from "@/lib/reasoning-contract-signature";
import { recordCdssStageTelemetry } from "@/lib/cdss-stage-telemetry";
import { isTrustedHisWorkbenchEdit } from "@/lib/his-prescription-validation";
import { caseWarningStateWithoutSkippedAudit } from "@/lib/clinical-warning-projection.server";
import { contractProvenanceAdvisory, recordContractProvenance, type ContractProvenanceIssue } from "@/lib/contract-provenance";
import { withClinicalResponseArchive } from "@/lib/request-archive.server";

async function handlePost(req: Request) {
  const startedAt = Date.now();
  const parsed = await readCustomerBoundCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;
  // 签名/凭据核验只标注、不拦截（owner 2026-10-12；contract-provenance.ts）。核验不通过时按回传内容
  // 继续评估，结果里附来源提示；安全核对对实际回传的药味重跑，不依赖签名。
  const initialDiagnoseReasoning = diagnoseReasoningFromState(parsed.caseState);
  const initialPrescribed = prescribeReasoningFromState(parsed.caseState);
  const workbenchRevision = parsed.caseState.prescriptionRevision?.source === "herb_workbench";
  let clinicalAdvisorySection = "";
  let clinicalAdvisories: ClinicalDeliveryAdvisory[] = [];
  const provenanceIssues: ContractProvenanceIssue[] = [];
  if (workbenchRevision) {
    if (!verifyDiagnoseReasoningSignature(initialDiagnoseReasoning, parsed.caseState)) provenanceIssues.push("m03_unverified");
    const workbenchCandidateIndex = parsed.caseState.prescriptionRevision?.candidateIndex ?? 0;
    const workbenchHerbHash = initialPrescribed
      ? await computePrescriptionVersionHash(initialPrescribed, workbenchCandidateIndex, parsed.caseState)
      : "";
    if (!isTrustedHisWorkbenchEdit(parsed.caseState, initialPrescribed, {
      clientId: parsed.customer.clientId,
      customerId: parsed.customer.customerId,
      herbHash: workbenchHerbHash,
    })) provenanceIssues.push("workbench_revision_unattested");
  } else if (!initialPrescribed) {
    // ── diagnose-only M05（owner 决策 2026-09-14，镜像 his-scheme 既有规则）──────────────
    // M04 缺席或是服务端非剂量页时，剥掉全部处方字段后做 diagnose-only 评估：只出本地确定性内容，
    // 随访由 M03 撰写，模型仍不写风险结论。M03 本身缺席时没有可评估的诊疗结论（这不是签名问题），
    // 仍返回 409。
    if (!initialDiagnoseReasoning) {
      return Response.json({
        error: "缺少辨病辨证结果（reasoningDiagnose），请先完成辨病辨证后再评估。",
        code: "invalid_m03_signature",
      }, { status: 409 });
    }
    if (!verifyDiagnoseReasoningSignature(initialDiagnoseReasoning, parsed.caseState)) provenanceIssues.push("m03_unverified");
    // 手写/未签名的处方 Markdown 没有结构化药味，无法逐味核对：不再 422，剥掉后按 diagnose-only
    // 评估并提示。被剥掉的处方文本从不进入任何消费方（单测用「带标记 + 藏药味表」反证过）。
    const legacyPrescription = typeof parsed.caseState.prescription === "string" ? parsed.caseState.prescription.trim() : "";
    if (legacyPrescription && !isNonDosePrescriptionText(legacyPrescription)) provenanceIssues.push("unstructured_prescription_ignored");
  } else if (!verifyPrescribeReasoningSignature(initialPrescribed, parsed.caseState)) {
    provenanceIssues.push("m04_unverified");
  }
  // diagnose-only 时剥掉全部处方字段：本地处方核对（无结构化候选时会解析 prescription Markdown）、
  // 警示地板与随访都只能看到签名 M03。
  const evaluatedCaseState = !workbenchRevision && !initialPrescribed
    ? {
        ...parsed.caseState,
        prescription: "",
        reasoningPrescribe: undefined,
        reasoningV2: initialDiagnoseReasoning ?? undefined,
        prescriptionRevision: undefined,
      }
    : parsed.caseState;
  const caseState = await maybeAttachClinicalFactsBackstop(evaluatedCaseState, undefined, req.signal);
  const gated = withSafetyGate(caseState);
  const diagnoseReasoning = diagnoseReasoningFromState(gated);
  const prescribed = prescribeReasoningFromState(gated);
  const explicitCandidateIndex = gated.prescriptionRevision?.candidateIndex;
  const candidateIndex = explicitCandidateIndex ?? resolvePrescriptionCandidateIndex(gated);
  const selectedCandidate = candidateIndex == null ? undefined : prescribed?.formula?.candidates[candidateIndex];
  if (workbenchRevision && (!selectedCandidate || selectedCandidate.herbs.length === 0)) {
    return Response.json({
      error: "所选候选方不存在或没有结构化药味，未进入评估。",
      code: "invalid_candidate_index",
    }, { status: 422 });
  }
  if (workbenchRevision) {
    const semanticIssue = editedPrescriptionSemanticIssue(
      prescribed,
      candidateIndex ?? 0,
      diagnoseReasoning,
      clinicalGroundingText(gated),
    );
    if (selectedCandidate) {
      clinicalAdvisories = collectClinicalDeliveryAdvisories(selectedCandidate, diagnoseReasoning, clinicalGroundingText(gated), [semanticIssue], candidateIndex ?? 0);
      clinicalAdvisorySection = clinicalDeliveryAdvisorySection(clinicalAdvisories);
    }
  }
  if (provenanceIssues.length > 0) {
    recordContractProvenance("assess", provenanceIssues);
    clinicalAdvisories = [
      ...clinicalAdvisories,
      ...provenanceIssues.map((issue) => contractProvenanceAdvisory(issue, candidateIndex ?? 0)),
    ];
    clinicalAdvisorySection = clinicalDeliveryAdvisorySection(clinicalAdvisories);
  }
  // 合理用药审方已删除（owner 2026-09-25）；报告里只出本地确定性内容：配伍预检（十八反/十九畏）、
  // 已证明的严重风险版本、处方信息待核对。这三段与原「审方展示关闭」档逐字相同。
  const localHighRiskSection = buildLocalHighRiskHerbPairSection(gated, candidateIndex);
  const retainedRiskSection = buildRetainedPrescriptionRiskSection(gated.prescriptionRevision);
  const inputAdvisorySection = buildPrescriptionInputAdvisorySection(buildPrescriptionInputAdvisories(gated, candidateIndex));
  const postPrescriptionRisk = [localHighRiskSection, retainedRiskSection, inputAdvisorySection].filter(Boolean).join("\n\n");
  const prescriptionHash = prescribed && candidateIndex != null
    ? await computePrescriptionVersionHash(prescribed, candidateIndex, gated)
    : "";
  const correlationMarker = skippedRxAuditCorrelationMarker(skippedRxAuditCorrelation({ candidateIndex, prescriptionHash }));
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
  const followup = buildDeterministicRiskFollowupProjection(assessed, authoredFollowup);
  const postRiskProjection = { markdown: postPrescriptionRisk, currentRiskMarkdown: postPrescriptionRisk };
  // 接地净化只作用于处方后审文本。随访管理方案通篇是写给患者的前瞻性内容（何时复诊、
  // 出现什么提前来），对它做「当前病历断言」净化会把「有无新出现发热」「无新发恶寒发热，
  // 视为有效」改写成「病历已记录否认发热」——2026-09-28 线上实测，且 his-scheme 与
  // post-prescription-risk 两个出口本就不净化随访，于是同一段随访页面与 HIS 各是一个样。
  // 模型撰写的随访字段已在 m05-followup-authoring 校验层拒收病历状态句，这里不再改写。
  const clinicalProjection = joinedWarningProjections([
    mapWarningText(postRiskProjection, (text) => sanitizeUngroundedRedFlagNegations(text, gated)),
    followup,
  ]);
  const rawProjection = joinedWarningProjections([RXAUDIT_DISABLED_STATUS_MARKER, correlationMarker, clinicalAdvisorySection, clinicalProjection]);
  // The browser can reproduce only its submitted state plus the final wire result. Fresh server
  // enrichment remains an independent floor; it must not silently alter request/display hashes.
  const final = finalizeM05DisplayResult(parsed.caseState, rawProjection, parsed.customer.customerId);
  const observation = await createWarningDisplayReceipt({ producer: "assess", requestState: parsed.caseState,
    sourceRepresentation: (parsed.body as { caseState?: unknown }).caseState,
    finalState: final.state, customer: parsed.customer, advisories: clinicalAdvisories,
    owned: { riskAssessment: final.projection, auditSkipped: true,
      floor: deriveStructuredCaseWarningFloor(caseWarningStateWithoutSkippedAudit(gated)) },
  });
  recordCdssStageTelemetry({
    stage: "assess",
    outcome: "success",
    durationMs: Date.now() - startedAt,
    // 遥测口径沿用停用档的取值，账本按它统计（审方从未被调用）。
    auditReached: false,
    reasonCode: "audit_rxaudit_disabled",
  });
  return markdownNdjsonResponse(rawProjection.markdown, observation);
}

// 临床请求与响应都加密留存（用户 2026-10-26 D3），见 request-archive.server.ts。
export const POST = withClinicalResponseArchive(handlePost);
