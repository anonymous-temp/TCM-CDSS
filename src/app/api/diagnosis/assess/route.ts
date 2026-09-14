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
  applyRxAuditInputAdvisories,
  buildAuditInputAdvisories,
  buildAuditInputAdvisorySection,
  buildLingxiRiskSection,
  buildLingxiWarningProjection,
  ownedAuditWarningInputs,
  buildLocalHighRiskHerbPairSection,
  buildRetainedRxAuditRiskSection,
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
  let clinicalAdvisorySection = "";
  let clinicalAdvisories: ClinicalDeliveryAdvisory[] = [];
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
  } else if (!initialPrescribed) {
    // ── diagnose-only M05（owner 决策 2026-09-14，镜像 his-scheme 既有规则）──────────────
    //
    // 剂量轴被独立硬边界收回、或候选未通过全部合同时，M04 交付的是服务端非剂量页：
    // 有药味与方义、没有 sentinel、没有签名。此前这里统一 409，直接调接口的集成方拿不到
    // 随访与安全总评——「不给剂量」再一次被实现成「什么都不给」（2026-09-11 只读归因第五节
    // 点名的「资格混用」）。规则与 his-scheme 完全一致：
    //   · 必须有**有效签名的 M03**（边界前移到 M03，没有就 409）；
    //   · 手写/未签名的处方 Markdown 不得跨界：审方层会解析 prescription 文本，所以这种
    //     形态返回 422 missing_structured_prescription（与 HIS 同码），不进入评估；
    //   · 其余（空处方或服务端非剂量页）剥掉全部处方字段后 diagnose-only 评估：审方按既有
    //     fail-closed 逻辑（candidate_missing）转人工，随访由签名 M03 撰写，模型仍不写风险结论。
    // 非剂量页标记本身可伪造，但被剥掉的处方文本从不进入任何消费方，伪造只能换来一份
    // 不含处方的评估——单测用「带标记 + 藏药味表」反证过：药名不得出现在结果里。
    if (!verifyDiagnoseReasoningSignature(initialDiagnoseReasoning, parsed.caseState)) {
      return Response.json({
        error: "辨病辨证结果签名已失效，请重新生成后再评估。",
        code: "invalid_m03_signature",
      }, { status: 409 });
    }
    const legacyPrescription = typeof parsed.caseState.prescription === "string" ? parsed.caseState.prescription.trim() : "";
    if (legacyPrescription && !isNonDosePrescriptionText(legacyPrescription)) {
      return Response.json({
        error: "缺少有效的结构化候选处方；未签名的处方文本不进入合理用药审方与随访评估，请重新生成候选方药后再评估。",
        code: "missing_structured_prescription",
      }, { status: 422 });
    }
  } else if (!verifyPrescribeReasoningSignature(initialPrescribed, parsed.caseState)) {
    return Response.json({
      error: "当前候选处方缺少与本病例及辨证结果绑定的有效签名，或签名后内容已变更；请重新生成候选方药后再评估。",
      code: "invalid_m04_signature",
    }, { status: 409 });
  }
  // diagnose-only 时剥掉全部处方字段：审方（rxaudit 会解析 prescription Markdown）、
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
  const candidateIndex = explicitCandidateIndex ?? resolveRxAuditCandidateIndex(gated);
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
  const { medicationExtraction, providerAudit } = await runBoundedRxAudit(gated, candidateIndex, req.signal);
  const inputAdvisories = buildAuditInputAdvisories(gated, candidateIndex, medicationExtraction);
  const inputAdvisorySection = buildAuditInputAdvisorySection(inputAdvisories);

  // M05 owns the single server-side audit call for the normal M03->M04->M05 chain. Client-supplied
  // audit-looking Markdown is never trusted, but every audit outcome is advisory rather than blocking.
  if (providerAudit.source === "unavailable") console.warn("[tcm-cdss:rxaudit] M05 advisory audit unavailable", { reason: providerAudit.reason });
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
  const retainedRiskSection = providerAudit.source === "skipped" ? buildRetainedRxAuditRiskSection(gated.prescriptionRevision) : "";
  const providerRisk = providerAudit.source === "skipped" ? "" : effectiveAudit
    ? buildLingxiRiskSection(effectiveAudit, patientSex)
    : buildUnavailableRxAuditSection(providerAudit.ok ? "rxaudit_incomplete" : providerAudit.reason);
  const postPrescriptionRisk = (showRxAudit
    ? [
        buildRxAuditScopeSection(gated, candidateIndex, providerAudit.ok ? providerAudit.submissionScope : undefined),
        providerAudit.ok ? "" : localHighRiskSection,
        inputAdvisorySection,
        providerRisk,
      ]
    : [localHighRiskSection, retainedRiskSection, buildAuditInputAdvisorySection(inputAdvisories, true)]
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
  const followup = buildDeterministicRiskFollowupProjection(assessed, authoredFollowup);
  const currentAuditText = effectiveAudit ? buildLingxiWarningProjection(effectiveAudit, patientSex).currentRiskMarkdown : providerRisk;
  const postRiskProjection = {
    markdown: postPrescriptionRisk,
    currentRiskMarkdown: (showRxAudit
      ? [buildRxAuditScopeSection(gated, candidateIndex, providerAudit.ok ? providerAudit.submissionScope : undefined),
          providerAudit.ok ? "" : localHighRiskSection, inputAdvisorySection, currentAuditText]
      : [localHighRiskSection, retainedRiskSection, buildAuditInputAdvisorySection(inputAdvisories, true), currentAuditText]
    ).filter(Boolean).join("\n\n"),
  };
  const clinicalProjection = mapWarningText(joinedWarningProjections([postRiskProjection, followup]),
    (text) => sanitizeUngroundedRedFlagNegations(text, gated));
  const rawProjection = joinedWarningProjections([auditStatusMarker, correlationMarker, clinicalAdvisorySection, clinicalProjection]);
  // The browser can reproduce only its submitted state plus the final wire result. Fresh server
  // enrichment remains an independent floor; it must not silently alter request/display hashes.
  const final = finalizeM05DisplayResult(parsed.caseState, rawProjection, parsed.customer.customerId);
  const observation = await createWarningDisplayReceipt({ producer: "assess", requestState: parsed.caseState,
    sourceRepresentation: (parsed.body as { caseState?: unknown }).caseState,
    finalState: final.state, customer: parsed.customer, advisories: clinicalAdvisories,
    owned: { riskAssessment: final.projection, audit: ownedAuditWarningInputs(providerAudit, effectiveAudit),
      auditSkipped: providerAudit.source === "skipped",
      floor: deriveStructuredCaseWarningFloor(providerAudit.source === "skipped" ? caseWarningStateWithoutSkippedAudit(gated) : gated) },
  });
  recordCdssStageTelemetry({
    stage: "assess",
    outcome: "success",
    durationMs: Date.now() - startedAt,
    auditReached: providerAudit.source !== "skipped" && (providerAudit.ok || !isRxAuditSubmissionIssueReason(providerAudit.reason)),
    reasonCode: providerAudit.ok ? "audit_available" : `audit_${providerAudit.reason}`,
  });
  return markdownNdjsonResponse(rawProjection.markdown, observation);
}
