import { readCaseStateRequest } from "@/lib/diagnosis-request";
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
import { buildDeterministicRiskFollowupPayload, deriveFirstReviewTiming, deriveSafetyLocked, withSafetyGate } from "@/lib/diagnosis-safety";
import { authorFollowupClinicalContent } from "@/lib/m05-followup-authoring.server";
import { diagnoseReasoningFromState, prescribeReasoningFromState } from "@/lib/diagnosis-parse";
import { editedPrescriptionIssueMessage, editedPrescriptionSemanticIssue, hasIncompleteEditedHerb } from "@/lib/prescription-revision";
import { computePrescriptionVersionHash } from "@/lib/prescription-version";
import { verifyDiagnoseReasoningSignature, verifyPrescribeReasoningSignature } from "@/lib/reasoning-contract-signature";
import { maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";

/**
 * M05 临床内容在**这条路由上也要由模型撰写**。
 *
 * 【为什么】assess 路由已经改成模型撰写，但本路由从不调 authorFollowupClinicalContent，
 * 拿到的 followup.markdown 是拼串模板。客户端在药味工作台改方复审后，
 * 把 body.followup 存进 acceptedRevision.followupSection，再用
 * replaceRiskAssessmentFollowup 写回整段——医生第一次拿到的模型版
 * 复诊评估重点 / 疗效评价标准 / 生活管理 / 六维裁剪，被模板整段盖掉。
 * 也就是说：**改一味药，M05 就退回改造前的样子**。
 *
 * 失败一律回落：不可用/超时/校验不过返回 null，逐字使用原模板（与 assess 侧同一套兜底）。
 */
async function authoredFollowupFor(
  assessed: Parameters<typeof buildDeterministicRiskFollowupPayload>[0],
  diagnoseReasoning: ReturnType<typeof diagnoseReasoningFromState>,
  selectedCandidate: { herbs?: Array<{ name?: string }> } | undefined,
  signal: AbortSignal | undefined,
) {
  return authorFollowupClinicalContent(assessed, {
    syndrome: diagnoseReasoning?.overview?.primarySyndrome,
    pathogenesis: diagnoseReasoning?.pathogenesis?.summary,
    therapy: [diagnoseReasoning?.therapy?.overallPrinciple, diagnoseReasoning?.therapy?.overallMethod]
      .filter(Boolean).join("；"),
    herbs: (selectedCandidate?.herbs || []).map((herb) => herb.name).filter((name): name is string => Boolean(name)),
    // 与 assess 侧同一个值：时间轴第一条必须与正文「首次复诊时间」同源。
    firstReviewTiming: deriveFirstReviewTiming(assessed, false),
  }, signal);
}

export async function POST(req: Request) {
  const parsed = await readCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;
  const caseState = withSafetyGate(await maybeAttachClinicalFactsBackstop(parsed.caseState, undefined, req.signal));
  const diagnoseReasoning = diagnoseReasoningFromState(caseState);
  if (caseState.prescriptionRevision?.source === "herb_workbench" && !verifyDiagnoseReasoningSignature(diagnoseReasoning, caseState)) {
    return Response.json({
      error: "辨病辨证结果签名已失效，请重新生成辨证后再调整药味。",
      code: "invalid_m03_signature",
    }, { status: 409 });
  }
  const prescribed = prescribeReasoningFromState(caseState);
  if (caseState.prescriptionRevision?.source !== "herb_workbench" && !verifyPrescribeReasoningSignature(prescribed, caseState)) {
    return Response.json({
      error: "当前候选处方缺少与本病例及辨证结果绑定的有效签名，或签名后内容已变更；请重新生成候选方药后再审方。",
      code: "invalid_m04_signature",
    }, { status: 409 });
  }
  const explicitCandidateIndex = caseState.prescriptionRevision?.candidateIndex;
  const resolvedCandidateIndex = explicitCandidateIndex ?? resolveRxAuditCandidateIndex(caseState);
  const candidateIndex = resolvedCandidateIndex ?? 0;
  const selectedCandidate = prescribed?.formula?.candidates[candidateIndex];
  const herbHash = prescribed ? await computePrescriptionVersionHash(prescribed, candidateIndex, caseState) : "";
  const invalidHerbs = selectedCandidate?.herbs.filter(hasIncompleteEditedHerb) || [];
  const semanticIssue = caseState.prescriptionRevision?.source === "herb_workbench"
    ? editedPrescriptionSemanticIssue(prescribed, candidateIndex, diagnoseReasoning)
    : undefined;
  if (caseState.prescriptionRevision?.source === "herb_workbench" && (!selectedCandidate || selectedCandidate.herbs.length === 0 || !herbHash)) {
    return Response.json({
      error: "所选候选方不存在或没有结构化药味，未提交自动审方。",
      code: "invalid_candidate_index",
      section: "## 合理用药审方\n**审方服务状态**：所选候选方不存在或没有结构化药味，未提交自动审方。\n**处置建议**：请重新选择有效候选方。",
      risks: [],
      audit: { source: "local_input_validation", safetyLocked: deriveSafetyLocked(caseState), degraded: false, reason: "invalid_candidate_index", needManualReview: true, herbHash: "", auditedAt: new Date().toISOString() },
    }, { status: 422 });
  }
  if (caseState.prescriptionRevision?.source === "herb_workbench" && invalidHerbs.length > 0) {
    return Response.json({
      error: "药味名称、单一正数剂量（g/克/mg/毫克）、对应病机或功用不完整，未提交自动审方。",
      code: "invalid_structured_herb",
      section: "## 合理用药审方\n**审方服务状态**：药味名称、单一正数剂量（g/克/mg/毫克）、对应病机或功用不完整，未提交自动审方。\n**处置建议**：请先修正结构化药味表。",
      risks: [],
      audit: {
        source: "local_input_validation",
        safetyLocked: deriveSafetyLocked(caseState),
        degraded: false,
        reason: "invalid_structured_herb",
        needManualReview: true,
        herbHash,
        auditedAt: new Date().toISOString(),
      },
    }, { status: 422 });
  }
  if (caseState.prescriptionRevision?.source === "herb_workbench" && semanticIssue) {
    const issueMessage = editedPrescriptionIssueMessage(semanticIssue);
    return Response.json({
      error: issueMessage,
      code: `invalid_edited_prescription_${semanticIssue}`,
      issue: semanticIssue,
      section: `## 合理用药审方\n**提交前校验**：${issueMessage}\n**处置建议**：当前版本未提交自动审方，请修正结构化药味后重试。`,
      risks: [],
      audit: {
        source: "local_input_validation",
        safetyLocked: deriveSafetyLocked(caseState),
        degraded: false,
        reason: `invalid_edited_prescription_${semanticIssue}`,
        needManualReview: true,
        herbHash,
        auditedAt: new Date().toISOString(),
      },
    }, { status: 422 });
  }
  const submissionIssue = rxAuditSubmissionIssue(caseState, resolvedCandidateIndex);
  if (submissionIssue) {
    const inputAdvisories = buildAuditInputAdvisories(caseState, resolvedCandidateIndex);
    const message = submissionIssue === "regimen_incomplete"
      ? "当前处方缺少可核验的给药频次、疗程或复诊节点，未提交自动审方。"
      : submissionIssue === "herb_dose_incomplete"
        ? "当前处方存在无法解析的单味剂量，未提交自动审方。"
        : "当前处方没有可审查的结构化药味，未提交自动审方。";
    return Response.json({
      error: message,
      code: `rxaudit_${submissionIssue}`,
      section: `## 合理用药审方\n**提交前校验**：${message}\n**处置建议**：请补齐处方结构后重新审方；本次未调用外部审方接口。`,
      risks: [],
      audit: {
        source: "local_input_validation",
        safetyLocked: deriveSafetyLocked(caseState),
        degraded: false,
        reason: submissionIssue,
        needManualReview: true,
        inputAdvisories,
        herbHash,
        auditedAt: new Date().toISOString(),
      },
    }, { status: 422 });
  }
  const { medicationExtraction, providerAudit } = await runBoundedRxAudit(caseState, resolvedCandidateIndex, req.signal);
  const inputAdvisories = buildAuditInputAdvisories(caseState, resolvedCandidateIndex, medicationExtraction);
  const auditedAt = new Date().toISOString();

  if (providerAudit.ok) {
    const mergedAudit = mergeLocalHighRiskHerbPairIssues(caseState, resolvedCandidateIndex, providerAudit);
    const safetyLocked = deriveSafetyLocked(caseState);
    const patientSex = caseState.hisRecord?.fields.sex || caseState.patient.sex;
    const effectiveAudit = applyRxAuditInputAdvisories(
      normalizeAuditOutcomeForPatient(mergedAudit, patientSex),
      inputAdvisories,
    );
    const inputAdvisorySection = buildAuditInputAdvisorySection(inputAdvisories);
    const section = [
      buildRxAuditScopeSection(caseState, resolvedCandidateIndex),
      inputAdvisorySection,
      buildLingxiRiskSection(effectiveAudit, patientSex),
    ].filter(Boolean).join("\n\n");
    const assessed = withSafetyGate({ ...caseState, riskAssessment: section, safetyLocked });
    const followup = buildDeterministicRiskFollowupPayload(
      assessed,
      await authoredFollowupFor(assessed, diagnoseReasoning, selectedCandidate, req.signal),
    );
    const correlation = buildRxAuditCorrelationMetadata({
      providerOutcome: providerAudit,
      effectiveOutcome: effectiveAudit,
      candidateIndex,
      prescriptionHash: herbHash,
      auditedAt,
    });
    return Response.json({
      section,
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
      },
    });
  }

  console.warn("[tcm-cdss:rxaudit] post-prescription advisory audit unavailable", { reason: providerAudit.reason });
  const section = [
    buildRxAuditScopeSection(caseState, resolvedCandidateIndex),
    buildLocalHighRiskHerbPairSection(caseState, resolvedCandidateIndex),
    buildAuditInputAdvisorySection(inputAdvisories),
    buildUnavailableRxAuditSection(providerAudit.reason),
  ].filter(Boolean).join("\n\n");
  const safetyLocked = deriveSafetyLocked(caseState);
  const assessed = withSafetyGate({ ...caseState, riskAssessment: section, safetyLocked });
  const followup = buildDeterministicRiskFollowupPayload(
    assessed,
    await authoredFollowupFor(assessed, diagnoseReasoning, selectedCandidate, req.signal),
  );
  const correlation = buildRxAuditCorrelationMetadata({
    providerOutcome: providerAudit,
    candidateIndex,
    prescriptionHash: herbHash,
    auditedAt,
  });
  return Response.json({
    section,
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
    },
  });
}
