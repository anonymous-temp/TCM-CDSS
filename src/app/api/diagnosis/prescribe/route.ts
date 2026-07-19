import { callDiagnosisStream } from "@/lib/diagnosis-api";
import { appendEvidenceContext, buildCdssEvidenceContext, buildEvidenceOutputTransform } from "@/lib/cdss-evidence-context";
import { buildPrescribePrompt } from "@/lib/diagnosis-prompts";
import { diagnoseReasoningFromState, parseReasoningV2 } from "@/lib/diagnosis-parse";
import { readCaseStateRequest } from "@/lib/diagnosis-request";
import { authoritativePatientAgeYears, buildSafetyLimitedPrescription, clinicalGroundingText, derivePrescriptionPermission, markdownNdjsonResponse, sanitizeCaseStateForModel, sanitizeUngroundedRedFlagNegations, withSafetyGate } from "@/lib/diagnosis-safety";
import { enrichPrescriptionProvenance, formulaCompilationContractIssue } from "@/lib/tcm-formula-provenance";
import { synchronizeVisibleClinicalSummary } from "@/lib/diagnosis-visible-summary";
import { applyTcmTreatmentCapabilityPriority } from "@/lib/tcm-treatment-capabilities.server";
import { isStableM03Reasoning, m04SemanticIssue, transparentFormulaTherapyIssue } from "@/lib/diagnosis-stage-contract";
import { isKnownTcmHerbName } from "@/lib/tcm-knowledge";
import { enforceReviewedPrescriptionOutput } from "@/lib/prescription-output-safety";
import type { SafetyGate } from "@/lib/diagnosis-types";
import { buildPrescribeContractSignatureContext, verifyDiagnoseReasoningSignature } from "@/lib/reasoning-contract-signature";
import { hasUnconfirmedUnclearEncounterScope, maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";

export async function POST(req: Request) {
  const parsed = await readCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;
  const signedPriorReasoning = diagnoseReasoningFromState(parsed.caseState);
  if (!signedPriorReasoning || !verifyDiagnoseReasoningSignature(signedPriorReasoning, parsed.caseState)) {
    return Response.json({ error: "辨病辨证结果缺少有效签名，请重新生成辨病辨证后再进入候选方药。" }, { status: 409 });
  }
  // A signed M03 with no syndrome resolution and no pathogenesis chain is a server-owned limited
  // contract. It can never authorize dose generation, so close M04 before any external model call.
  if (signedPriorReasoning.overview.primarySyndromeResolution === "unresolved" &&
      signedPriorReasoning.pathogenesis.chain.length === 0) {
    const emergencyLimited = /急危重|急症/.test(signedPriorReasoning.westernDiagnosis.primary.name) ||
      /呼叫120|转急诊/.test(signedPriorReasoning.management?.redFlagLoop || "");
    // The signed limited M03 keeps the concrete red-flag findings in supportingFacts; the primary
    // name is only the generic "急危重症风险待排除" placeholder and must not replace them.
    const emergencyRedFlags = signedPriorReasoning.westernDiagnosis.primary.supportingFacts.length > 0
      ? signedPriorReasoning.westernDiagnosis.primary.supportingFacts
      : [signedPriorReasoning.westernDiagnosis.primary.name];
    return markdownNdjsonResponse(buildSafetyLimitedPrescription({
      status: emergencyLimited ? "red_flag" : "needs_information",
      allowDiagnosis: true,
      allowDosePrescription: false,
      action: emergencyLimited ? "refer_or_emergency" : "complete_before_prescription",
      missingItems: signedPriorReasoning.management?.mustCollect || [],
      redFlags: emergencyLimited ? emergencyRedFlags : [],
      reasons: [
        signedPriorReasoning.overview.primarySyndromeResolutionReason || "M03未形成可采纳的当前证候与病机链。",
        ...(signedPriorReasoning.management?.redFlagLoop ? [signedPriorReasoning.management.redFlagLoop] : []),
      ],
    }));
  }
  // A deterministic hard red flag already imposes the strongest prescription boundary. Avoid an
  // unnecessary semantic-model round trip before signature verification and the non-dose response.
  const deterministicGate = withSafetyGate(parsed.caseState);
  const caseState = deterministicGate.safetyGate?.status === "red_flag"
    ? parsed.caseState
    : await maybeAttachClinicalFactsBackstop(parsed.caseState, undefined, req.signal);
  const gated = withSafetyGate(caseState);
  const permission = derivePrescriptionPermission(gated);
  const limitedInformation = gated.completeness.level !== "C" || gated.safetyGate?.status !== "ready" || permission.candidateMode === "limited_dose";
  // Red flags do not stop the clinical workflow, but they are a server-owned hard boundary for
  // concrete doses. M03 and M05 remain available; M04 returns an explicit non-dose result.
  if (permission.candidateMode === "non_dose_only" || permission.candidateMode === "blocked") {
    const gate: SafetyGate = {
      status: gated.safetyGate?.status || "needs_information",
      allowDiagnosis: true,
      allowDosePrescription: false,
      action: gated.safetyGate?.status === "red_flag" ? "refer_or_emergency" : "complete_before_prescription",
      missingItems: Array.from(new Set([...(gated.safetyGate?.missingItems || []), ...permission.reasons])),
      redFlags: gated.safetyGate?.redFlags || [],
      reasons: ["当前病例可继续完成辨病辨证、调护和非药物治疗建议，但不生成具体剂量。"],
    };
    return markdownNdjsonResponse(buildSafetyLimitedPrescription(gate));
  }
  // An attested "unclear" encounter scope means the reviewed semantic pre-check could not prove
  // whether this visit has an active treatment target. Dose generation must not proceed silently;
  // it requires a follow-up answer (which changes the record and forces re-extraction) or an
  // explicit doctor confirmation bound to the current clinical-facts fingerprint.
  if (hasUnconfirmedUnclearEncounterScope(gated)) {
    const gate: SafetyGate = {
      status: "needs_information",
      allowDiagnosis: true,
      allowDosePrescription: false,
      action: "complete_before_prescription",
      missingItems: ["本次当前活动性治疗目标确认"],
      redFlags: [],
      reasons: ["语义预检无法判断本次就诊是否存在当前活动性治疗目标；需医生通过追问回答补充病情，或显式确认本次就诊的治疗目标后，才能生成具体剂量。"],
    };
    return markdownNdjsonResponse(buildSafetyLimitedPrescription(gate));
  }
  // M03 的结构化合同是阶段间的唯一辨证充分度依据。可见正文中的鉴别或管理建议（例如
  // “完善甲功后再评估”）不能反向否定一份已包含主证、病机链和治法的有效结构化辨证。
  if (!isStableM03Reasoning(signedPriorReasoning, clinicalGroundingText(gated))) {
    const gate: SafetyGate = {
      status: "needs_information",
      allowDiagnosis: false,
      allowDosePrescription: false,
      action: "complete_before_prescription",
      missingItems: ["M03辨病辨证结果"],
      redFlags: [],
      reasons: ["缺少有效的西医诊断、中医证候与病机关联结果，不能直接生成剂量级候选处方。"],
    };
    return markdownNdjsonResponse(buildSafetyLimitedPrescription(gate));
  }
  if (signedPriorReasoning.clinicalReview?.status !== "accepted") {
    const gate: SafetyGate = {
      status: "needs_information",
      allowDiagnosis: true,
      allowDosePrescription: false,
      action: "complete_before_prescription",
      missingItems: ["辨证语义复核"],
      redFlags: [],
      reasons: ["本轮辨证语义复核未完成；辨证内容可供医生继续审阅，具体剂量待复核服务恢复后重新生成。"],
    };
    return markdownNdjsonResponse(buildSafetyLimitedPrescription(gate));
  }

  const trustedGated = { ...gated, reasoningDiagnose: signedPriorReasoning };
  const safeState = sanitizeCaseStateForModel(trustedGated);
  const evidenceContext = await buildCdssEvidenceContext(safeState, "prescribe");
  let prompt = appendEvidenceContext(buildPrescribePrompt(safeState), evidenceContext);
  const informationNotice = limitedInformation
    ? [
        "## 信息完整性边界",
        `本候选方药仅依据已经提供的信息生成；正式采纳前需确认：${permission.reasons.join("、") || gated.safetyGate?.missingItems.join("、") || "部分病历信息"}。这些未知项不影响医生审阅候选方案，但不会被视为已核实事实。`,
      ].join("\n")
    : "";
  if (limitedInformation) {
    prompt += `\n\n【有限信息候选】当前待复核：${permission.reasons.join("、") || gated.safetyGate?.missingItems.join("、") || "部分病历信息"}。请基于已知证候、病机和治法生成医生审阅用候选方案，并把相关未知项或阳性风险写入适用边界；不得臆造患者事实，也不得仅因缺项或风险提示拒绝生成。`;
  }
  const truncationGate: SafetyGate = {
    status: "needs_information",
    allowDiagnosis: true,
    allowDosePrescription: false,
    action: "complete_before_prescription",
    missingItems: ["模型处方输出完整性"],
    redFlags: [],
    reasons: ["模型处方输出被截断或结构化结果未闭合，服务端已阻断半截处方文本。"],
  };
  const evidenceOutputTransform = buildEvidenceOutputTransform(
    evidenceContext,
    (content) => sanitizeUngroundedRedFlagNegations(enforceReviewedPrescriptionOutput(content), safeState),
  );
  return callDiagnosisStream(prompt, "deepseek", undefined, "markdown", {
    requestSignal: req.signal,
    truncateFallback: buildSafetyLimitedPrescription(truncationGate),
    structuredStage: "prescribe",
    // M04 repair/review must never receive raw HIS identifiers.
    structuredClinicalContext: clinicalGroundingText(safeState),
    structuredReviewEvidenceContext: evidenceContext,
    structuredPatientAge: authoritativePatientAgeYears(gated),
    structuredPriorReasoning: signedPriorReasoning,
    prescribeSignatureContext: buildPrescribeContractSignatureContext(trustedGated),
    // 先校验并清理模型引用，再由服务端用本地方剂库写入可信原典；否则本地补入的
    // 经典出处会被模型证据白名单误判为未核验来源。
    outputTransform: (content) => {
      const sanitized = applyTcmTreatmentCapabilityPriority(evidenceOutputTransform(content), safeState, signedPriorReasoning);
      // Deterministic safety fallbacks intentionally contain no structured M04 sentinel. They have
      // already been generated by the server and must not be reinterpreted as a malformed model
      // prescription, otherwise the original rejection is hidden behind a misleading contract error.
      if (!sanitized.includes("<!-- DIAGNOSIS_JSON_START -->")) return sanitized;
      const enriched = enrichPrescriptionProvenance(sanitized);
      const reasoning = parseReasoningV2(enriched);
      // The stream layer has already exhausted formula-composition repair before allowing a
      // transparent self-devised fallback. Keep that safe fallback usable here while all other
      // formula drift, dose, regimen and clinical-grounding failures remain blocking contracts.
      const declassificationTherapyIssue = reasoning?.formula?.candidates?.[0]?.identityDeclassified
        ? transparentFormulaTherapyIssue(reasoning, signedPriorReasoning)
        : undefined;
      const issue = formulaCompilationContractIssue(reasoning, signedPriorReasoning, false, true) || declassificationTherapyIssue || m04SemanticIssue(
        reasoning,
        "",
        signedPriorReasoning,
        isKnownTcmHerbName,
        true,
        true,
        false,
        true,
      );
      if (issue) {
        console.warn("[tcm-cdss:contract] finalized M04 rejected", {
          issue,
          stage: "prescribe",
        });
        throw new Error(`finalized_prescription_${issue}`);
      }
      const synchronized = synchronizeVisibleClinicalSummary(enriched, "prescribe");
      return [informationNotice, synchronized].filter(Boolean).join("\n\n");
    },
  });
}
