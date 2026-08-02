import { callDiagnosisStream } from "@/lib/diagnosis-api";
import { appendEvidenceContext, buildCdssEvidenceContext, buildEvidenceOutputTransform } from "@/lib/cdss-evidence-context";
import { assistedNegationClauses } from "@/lib/polarity-negation-assist.server";
import { buildPrescribePrompt } from "@/lib/diagnosis-prompts";
import { diagnoseReasoningFromState, parseReasoningV2 } from "@/lib/diagnosis-parse";
import { readCaseStateRequest } from "@/lib/diagnosis-request";
import { authoritativePatientAgeYears, buildSafetyAdvisoryBanner, buildSafetyLimitedPrescription, clinicalGroundingText, derivePrescriptionPermission, gateDispositionIsAdvisory, markdownNdjsonResponse, sanitizeCaseStateForModel, sanitizeUngroundedRedFlagNegations, withSafetyGate } from "@/lib/diagnosis-safety";
import { formulaCompilationContractIssue, formulaNamesWithoutExecutableDoseCompilation } from "@/lib/tcm-formula-provenance";
import { enrichPrescriptionProvenance } from "@/lib/tcm-formula-provenance.server";
import { synchronizeVisibleClinicalSummary } from "@/lib/diagnosis-visible-summary";
import { applyTcmTreatmentCapabilityPriority } from "@/lib/tcm-treatment-capabilities.server";
import { m03SafetyContractIssue, m04SafetyContractIssue, m04SemanticIssue, transparentFormulaTherapyIssue } from "@/lib/diagnosis-stage-contract";
import { qualityAnnotationCopy, shouldAcceptWithQualityAnnotation } from "@/lib/diagnosis-rejection-tiers";
import { isKnownTcmHerbName } from "@/lib/tcm-knowledge";
import { enforceReviewedPrescriptionOutput } from "@/lib/prescription-output-safety";
import type { SafetyGate } from "@/lib/diagnosis-types";
import { buildPrescribeContractSignatureContext, verifyDiagnoseReasoningSignature } from "@/lib/reasoning-contract-signature";
import { hasUnconfirmedUnclearEncounterScope, maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { planEvidenceBoundMedicineCandidates } from "@/lib/medicine-candidate-planner.server";
import { m04TherapyIssueQualityAnnotation } from "@/lib/m04-repair-policy";

/** 把驳回码里的 `herb_<下标>` 还原成药名，仅用于服务端日志定位。 */
function rejectedHerbName(issue: string, reasoning: ReturnType<typeof parseReasoningV2>): string | undefined {
  const index = Number(issue.match(/herb_(\d+)/)?.[1]);
  if (!Number.isInteger(index)) return undefined;
  const herb = reasoning?.formula?.candidates?.[0]?.herbs?.[index];
  const name = typeof herb?.name === "string" ? herb.name.trim() : "";
  return name || undefined;
}

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
  // 红旗/完整度处置（甲方决策：不阻断临床流程）。检测照常；advise 模式下 M04 照常生成
  // 剂量级候选，可见正文置顶确定性安全警示横幅（红旗内容 + 审方提示），红旗同步写进提示词
  // 让用药风险段优先急诊指引。缺主诉（permission=blocked 且无主诉）仍然拦——没有主诉连
  // 辨证对象都不存在，不属于「有结果可给」的范畴。CDSS_GATE_DISPOSITION=block 切回旧行为。
  const advisoryDisposition = gateDispositionIsAdvisory();
  if (
    (permission.candidateMode === "non_dose_only" || permission.candidateMode === "blocked") &&
    (!advisoryDisposition || !(gated.chiefComplaint || gated.hisRecord?.fields?.zhushu || "").trim())
  ) {
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
  // 横幅触发不能挂在 candidateMode 上：advisory 档下红旗已返回 full_dose（这正是「不拦截」
  // 的实现），若仍以 non_dose_only 为条件，红旗病例的 M04 反而成了唯一没有警示的输出。
  // 直接读安全门状态——它是检测层的原始信号，与处置档位无关。
  const advisorySafetyNotes = advisoryDisposition &&
    (gated.safetyGate?.status === "red_flag" || permission.candidateMode === "non_dose_only" || permission.candidateMode === "blocked")
    ? (permission.reasons.length > 0 ? permission.reasons : ["当前病例存在未解除的安全或信息完整性提示"])
    : [];
  // An attested "unclear" encounter scope means the reviewed semantic pre-check could not prove
  // whether this visit has an active treatment target. advise 模式下不再拦截：照常生成，
  // 警示横幅与提示词都明示「本次就诊目标需医生确认」，确认动作交给医生而不是流程。
  if (hasUnconfirmedUnclearEncounterScope(gated) && !advisoryDisposition) {
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
  if (m03SafetyContractIssue(signedPriorReasoning, clinicalGroundingText(gated))) {
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
  const governedFormulaNames = signedPriorReasoning.overview.recommendedFormulaNames || [];
  const unavailableFormulaNames = formulaNamesWithoutExecutableDoseCompilation(governedFormulaNames);
  const formulaMode = signedPriorReasoning.overview.formulaSelectionMode || "none";
  const noExecutableFormulaPath = governedFormulaNames.length > 0 && (
    formulaMode === "alternatives"
      ? unavailableFormulaNames.length === governedFormulaNames.length
      : unavailableFormulaNames.length > 0
  );
  // advise 模式下锁定方缺剂量基准不再作废本次生成：转自拟组方路径（提示词明示不得沿用
  // 该方名身份），方名方向保留给医生参考。block 模式维持旧行为。
  if (noExecutableFormulaPath && !advisoryDisposition) {
    const gate: SafetyGate = {
      status: "needs_information",
      allowDiagnosis: true,
      allowDosePrescription: false,
      action: "complete_before_prescription",
      missingItems: unavailableFormulaNames.map((name) => `${name}的完整药味身份或数值型内服剂量边界`),
      redFlags: [],
      reasons: [
        `已形成${governedFormulaNames.join("、")}的方证方向，但其治理组成尚不能逐味完成具体用量核验；保留方名方向供医生审阅，不生成半张处方或猜测缺失剂量。`,
      ],
    };
    return markdownNdjsonResponse(buildSafetyLimitedPrescription(gate));
  }

  const trustedGated = { ...gated, reasoningDiagnose: signedPriorReasoning };
  const safeState = sanitizeCaseStateForModel(trustedGated);
  const structuredClinicalContext = [
    clinicalGroundingText(safeState),
    safeState.patient.sex ? `患者性别：${safeState.patient.sex}` : "",
    safeState.patient.age != null ? `患者年龄：${safeState.patient.age}岁` : "",
  ].filter(Boolean).join("\n");
  const [medicinePlan, baseEvidenceContext] = await Promise.all([
    planEvidenceBoundMedicineCandidates(safeState, req.signal),
    assistedNegationClauses(safeState).then((assistedNegations) =>
      buildCdssEvidenceContext(safeState, "prescribe", assistedNegations)),
  ]);
  const evidenceContext = [baseEvidenceContext, medicinePlan.evidenceContext].filter(Boolean).join("\n\n");
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
  if (signedPriorReasoning.clinicalReview?.status !== "accepted") {
    prompt += "\n\n【辨证复核状态】M03 独立复核本轮未完成，但其结构、病历接地、极性与安全边界已通过确定性核验。可继续生成有界候选；必须在适用边界中提示复核状态，不得把未完成复核写成已经通过，也不得因此拒绝生成。";
  }
  if (advisorySafetyNotes.length > 0) {
    prompt += `\n\n【急危重线索并存】服务器确定性判定本例存在未解除的安全提示：${advisorySafetyNotes.join("；")}。请照常生成剂量级候选方药；在用药风险提示中把急诊/转诊评估列为第一优先级，剂量取保守区间下段，不得因安全提示拒绝生成，也不得淡化提示。`;
  }
  if (hasUnconfirmedUnclearEncounterScope(gated) && advisoryDisposition) {
    prompt += "\n\n【就诊目标待确认】语义预检无法确定本次就诊是否存在当前活动性治疗目标。请照常生成候选，并在适用边界中显式提示“本次就诊目标需医生确认后方可采纳”。";
  }
  if (noExecutableFormulaPath && advisoryDisposition) {
    prompt += `\n\n【方名剂量基准缺失】推荐方 ${unavailableFormulaNames.join("、")} 在本地受治理知识库暂无可执行的逐味剂量基准。请按已锁定证候与治法自拟组方（constructionType=self_devised，不得沿用该方名身份），方名方向已另行保留给医生参考。`;
  }
  const truncationGate: SafetyGate = {
    status: "needs_information",
    allowDiagnosis: true,
    allowDosePrescription: false,
    action: "complete_before_prescription",
    missingItems: ["模型处方输出完整性及结构化合同"],
    redFlags: [],
    reasons: ["模型处方输出被截断、结构化结果未闭合或未通过处方合同校验，服务端已阻断不可采纳的药味与剂量。"],
  };
  const advisoryBanner = buildSafetyAdvisoryBanner(
    advisorySafetyNotes.length > 0 ? gated.safetyGate : undefined,
    [
      ...(advisorySafetyNotes.length > 0 && !(gated.safetyGate?.redFlags || []).length ? advisorySafetyNotes : []),
      ...(hasUnconfirmedUnclearEncounterScope(gated) && advisoryDisposition
        ? ["本次就诊是否存在当前活动性治疗目标未确认，请医生确认后再采纳。"] : []),
      ...(noExecutableFormulaPath && advisoryDisposition
        ? [`推荐方 ${unavailableFormulaNames.join("、")} 暂无可执行剂量基准，本次候选为辨证自拟组方，方名方向供参考。`] : []),
    ],
  );
  const evidenceOutputTransform = buildEvidenceOutputTransform(
    evidenceContext,
    (content) => {
      const sanitized = sanitizeUngroundedRedFlagNegations(enforceReviewedPrescriptionOutput(content), safeState);
      return advisoryBanner ? `${advisoryBanner}${sanitized}` : sanitized;
    },
    safeState,
  );
  return callDiagnosisStream(prompt, "deepseek", undefined, "markdown", {
    requestSignal: req.signal,
    truncateFallback: buildSafetyLimitedPrescription(truncationGate),
    structuredStage: "prescribe",
    // M04 repair/review must never receive raw HIS identifiers.
    structuredClinicalContext,
    structuredReviewEvidenceContext: evidenceContext,
    structuredPatientAge: authoritativePatientAgeYears(gated),
    structuredCaseState: safeState,
    structuredMedicineCandidates: medicinePlan.candidates,
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
      const enriched = enrichPrescriptionProvenance(sanitized, clinicalGroundingText(safeState));
      const reasoning = parseReasoningV2(enriched);
      // The stream layer has already exhausted formula-composition repair before allowing a
      // transparent self-devised fallback. Keep that safe fallback usable here while all other
      // formula drift, dose, regimen and clinical-grounding failures remain blocking contracts.
      // 降级候选（identityDeclassified）在流层已按「安全底线合同 + 带批注受理」验收过；
      // 路由终审必须用**同一口径**复验，否则这里的全量质量口径会把刚受理的候选再判死——
      // 这是同一结构性问题的第 5 处复发点（finalized_prescription_transparent_therapy_*）。
      // 非降级候选保持全量口径不变。
      const declassifiedAccepted = Boolean(reasoning?.formula?.candidates?.[0]?.identityDeclassified);
      const declassificationTherapyIssue = declassifiedAccepted
        ? transparentFormulaTherapyIssue(reasoning, signedPriorReasoning, true)
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
        clinicalGroundingText(safeState),
        declassifiedAccepted,
      );
      const synchronized = synchronizeVisibleClinicalSummary(enriched, "prescribe");
      if (issue) {
        // Tier-2/3 带批注受理。在此之前，M04 的 60+ 个原因码一律等价于最高危级别：一条建议性
        // 中医治疗项目卡片的字段缺失，与附子超量一样会作废整张已通过剂量、十八反十九畏、
        // 特殊人群与审方的处方，医生拿到的是一页拒绝说明。
        //
        // 受理的前提是重跑 m04SafetyContractIssue，而不是只看这个拒绝码——这一步不能省：
        // m04SemanticIssue 命中第一个问题就短路返回，而它的检查顺序**不反映临床严重度**
        // （nonPharma.tcmTreatments 的 15 个字段检查排在剂量、配伍禁忌与特殊人群之前）。
        // 拿到一个 T2 码只证明排在它前面的检查通过了，后面的 T1 检查根本没有执行。
        // shouldAcceptWithQualityAnnotation 在 safetyIssue 缺省时判为不可受理，双重 fail-closed。
        const safetyIssue = m04SafetyContractIssue(
          reasoning,
          signedPriorReasoning,
          isKnownTcmHerbName,
          false,
          false,
          clinicalGroundingText(safeState),
          declassifiedAccepted,
        ) || "";
        const rejectionReason = `m04_${issue}`;
        const annotation = (shouldAcceptWithQualityAnnotation({
          rejectionReason,
          safetyIssue,
          visibleDraftLength: synchronized.trim().length,
          // 处方正文含药味表与煎服法，远长于 M03 叙述；沿用 80 字下限等于不设限。
          minimumDraftLength: 200,
        })
          ? qualityAnnotationCopy(rejectionReason)
          : undefined)
          // 降级候选的治法覆盖/词表族批注：与流层受理策略同源（m04-repair-policy 唯一权威）。
          // 前提同样是底线合同干净（safetyIssue 为空）——批注永远不放行 T1。
          ?? (declassifiedAccepted && !safetyIssue ? m04TherapyIssueQualityAnnotation(rejectionReason) : undefined);
        if (!annotation) {
          console.warn("[tcm-cdss:contract] finalized M04 rejected", {
            issue,
            safetyIssue: safetyIssue || undefined,
            stage: "prescribe",
            // 原因码里的 herb_2 是**下标**，日志里没有药名，线上根本无法定位是哪味药被驳回——
            // 而 herb_*_unsupported_high_impact_* 恰恰是最高频的驳回族。补上该下标对应的药名
            // （药名不是 PHI），把「无法形成处方」从不可诊断变成可诊断。
            offendingHerb: rejectedHerbName(issue, reasoning),
          });
          throw new Error(`finalized_prescription_${issue}`);
        }
        console.warn("[tcm-cdss:contract] finalized M04 accepted with quality annotation", {
          issue,
          stage: "prescribe",
        });
        return [informationNotice, `> ${annotation}`, synchronized].filter(Boolean).join("\n\n");
      }
      return [informationNotice, synchronized].filter(Boolean).join("\n\n");
    },
  });
}
