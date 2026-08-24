import { callDiagnosisStream, primaryTextMaxPromptChars } from "@/lib/diagnosis-api";
import { appendEvidenceContext, buildCdssEvidenceContext, buildEvidenceOutputTransform } from "@/lib/cdss-evidence-context";
import { assistedPolarityDecisions } from "@/lib/polarity-negation-assist.server";
import { buildPrescribePrompt } from "@/lib/diagnosis-prompts";
import { diagnoseReasoningFromState, parseReasoningV2 } from "@/lib/diagnosis-parse";
import { readCustomerBoundCaseStateRequest } from "@/lib/diagnosis-request";
import { authoritativePatientAgeYears, buildSafetyAdvisoryBanner, buildSafetyLimitedPrescription, clinicalGroundingText, derivePrescriptionPermission, gateDispositionIsAdvisory, markdownNdjsonResponse, mergePrescriptionReviewItems, sanitizeCaseStateForModel, sanitizeUngroundedRedFlagNegations, withSafetyGate } from "@/lib/diagnosis-safety";
import { applyRestoredGovernedFormulaIdentity, formulaCompilationContractIssue, formulaNamesWithoutExecutableDoseCompilation } from "@/lib/tcm-formula-provenance";
import { enrichPrescriptionProvenance } from "@/lib/tcm-formula-provenance.server";
import { applyDeterministicHerbFunctions, synchronizeVisibleClinicalSummary } from "@/lib/diagnosis-visible-summary";
import { applyTcmTreatmentCapabilityPriority } from "@/lib/tcm-treatment-capabilities.server";
import { m03SafetyContractIssue, m04SafetyContractIssue, m04SemanticIssue, transparentFormulaTherapyIssue } from "@/lib/diagnosis-stage-contract";
import { isM04FinalizerDeferredLabelIssue, isSafetyRejection, qualityAnnotationCopy, shouldAcceptWithQualityAnnotation } from "@/lib/diagnosis-rejection-tiers";
import { isKnownTcmHerbName } from "@/lib/tcm-knowledge";
import { enforceReviewedPrescriptionOutput } from "@/lib/prescription-output-safety";
import type { SafetyGate } from "@/lib/diagnosis-types";
import { buildPrescribeContractSignatureContext, verifyDiagnoseReasoningSignature } from "@/lib/reasoning-contract-signature";
import { CLINICAL_FACTS_SIGNED_CHAIN_CACHE_TTL_MS, hasUnconfirmedUnclearEncounterScope, maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { planEvidenceBoundMedicineCandidates } from "@/lib/medicine-candidate-planner.server";
import { buildDrugInventoryPromptContext } from "@/lib/drug-inventory.server";
import { m04TherapyIssueQualityAnnotation } from "@/lib/m04-repair-policy";
import { m04AttemptKey } from "@/lib/m04-retry-policy";
import { buildDeterministicFormulaReferenceFallback } from "@/lib/m04-deterministic-fallback";
import { compactEvidenceContextForPrompt } from "@/lib/prompt-budget";
import { declassifyAndDropOpposingM04CandidateHerbs } from "@/lib/m04-modification-safety";

/** 把驳回码里的 `herb_<下标>` 还原成药名，仅用于服务端日志定位。 */
function rejectedHerbName(issue: string, reasoning: ReturnType<typeof parseReasoningV2>): string | undefined {
  const index = Number(issue.match(/herb_(\d+)/)?.[1]);
  if (!Number.isInteger(index)) return undefined;
  const herb = reasoning?.formula?.candidates?.[0]?.herbs?.[index];
  const name = typeof herb?.name === "string" ? herb.name.trim() : "";
  return name || undefined;
}

export async function POST(req: Request) {
  // The browser gives the complete request 210s. Start the server's 180s M04 orchestration clock
  // before clinical-fact/evidence preparation so the stream can still deliver its fail-closed
  // fallback inside that browser margin instead of being cut off as an HTTP 0 abort.
  const orchestrationStartedAt = Date.now();
  const parsed = await readCustomerBoundCaseStateRequest(req);
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
    }, "m03_unstable"));
  }
  // A deterministic hard red flag already imposes the strongest prescription boundary. Avoid an
  // unnecessary semantic-model round trip before signature verification and the non-dose response.
  const deterministicGate = withSafetyGate(parsed.caseState);
  const caseState = deterministicGate.safetyGate?.status === "red_flag"
    ? parsed.caseState
    // The M03 signature above binds this exact record. Reusing its signed semantic pre-check for
    // the bounded M03→M04 chain avoids turning an unchanged 150s-old empty result into two fresh
    // model calls just because M03 itself legitimately consumed the 180s orchestration budget.
    : await maybeAttachClinicalFactsBackstop(parsed.caseState, undefined, req.signal, {
        cacheTtlOverrideMs: CLINICAL_FACTS_SIGNED_CHAIN_CACHE_TTL_MS,
      });
  const gated = withSafetyGate(caseState);
  const permission = derivePrescriptionPermission(gated);
  const limitedInformation = gated.completeness.level !== "C" || gated.safetyGate?.status !== "ready" || permission.candidateMode === "limited_dose";
  // advise 只改变“已检出红旗”的呈现方式，不能覆盖处方权限层的 non_dose_only / blocked。
  // 后两者包含儿科体重缺失、妊娠状态未核实、语义筛查不可用等独立硬边界；若因有主诉就
  // 放行剂量，会把 fail-closed 权限降成一条可见提示。此处始终返回非剂量建议。
  const advisoryDisposition = gateDispositionIsAdvisory();
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
    const hasChiefForCode = Boolean((gated.chiefComplaint || gated.hisRecord?.fields?.zhushu || "").trim());
    return markdownNdjsonResponse(buildSafetyLimitedPrescription(
      gate,
      hasChiefForCode ? (gate.status === "red_flag" ? "safety_gate_blocked" : "completeness_below_c") : "missing_chief_complaint",
    ));
  }
  // 横幅触发不能挂在 candidateMode 上：advisory 档下红旗已返回 full_dose（这正是「不拦截」
  // 的实现），若仍以 non_dose_only 为条件，红旗病例的 M04 反而成了唯一没有警示的输出。
  // 直接读安全门状态——它是检测层的原始信号，与处置档位无关。
  const advisorySafetyNotes = advisoryDisposition &&
    gated.safetyGate?.status === "red_flag"
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
    return markdownNdjsonResponse(buildSafetyLimitedPrescription(gate, "completeness_below_c"));
  }
  // M03 的结构化合同是阶段间的唯一辨证充分度依据。可见正文中的鉴别或管理建议（例如
  // “完善甲功后再评估”）不能反向否定一份已包含主证、病机链和治法的有效结构化辨证。
  // 必须注入 isSafetyRejection 谓词——辨证侧带批注受理时豁免的 T2 码（链节点措辞/接地字面/
  // 随访表述），在这里用无谓词严格口径复检会把**完全正常的签名 M03**再判死，M04 直接拒绝
  // 出方（实测 28 例新病历中 3 例：证型病机俱全却收到「缺少有效的西医诊断」0 味页）。
  // 这是「一处受理、他处复判」同一结构分叉的又一处；受理与复检必须同口径。
  // 判据算出的是**具体哪一条合同不满足**，此前只当布尔用：不进日志、不进原因码，
  // 医生看到的永远是同一句「缺少有效的西医诊断…」，服务端也无从归因。
  // 与本仓 finalized M03 rejected 只报文档质量码、不报管事的安全码是同一种毛病
  // （2026-08-16 已修那一处，这一处是同族第二处）。现在把码打出来。
  const priorM03SafetyIssue = m03SafetyContractIssue(
    signedPriorReasoning, clinicalGroundingText(gated), isSafetyRejection);
  if (priorM03SafetyIssue) {
    console.warn("[tcm-cdss:model] M04 refused: signed M03 failed safety contract recheck", {
      stage: "prescribe",
      issue: priorM03SafetyIssue,
    });
    const gate: SafetyGate = {
      status: "needs_information",
      allowDiagnosis: false,
      allowDosePrescription: false,
      action: "complete_before_prescription",
      missingItems: ["M03辨病辨证结果"],
      redFlags: [],
      reasons: ["缺少有效的西医诊断、中医证候与病机关联结果，不能直接生成剂量级候选处方。"],
    };
    return markdownNdjsonResponse(buildSafetyLimitedPrescription(gate, "m03_unstable"));
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
    return markdownNdjsonResponse(buildSafetyLimitedPrescription(gate, "formula_dose_boundary_unavailable"));
  }

  const trustedGated = { ...gated, reasoningDiagnose: signedPriorReasoning };
  const safeState = sanitizeCaseStateForModel(trustedGated);
  const structuredClinicalContext = [
    clinicalGroundingText(safeState),
    safeState.patient.sex ? `患者性别：${safeState.patient.sex}` : "",
    safeState.patient.age != null ? `患者年龄：${safeState.patient.age}岁` : "",
  ].filter(Boolean).join("\n");
  // 口语否定增补：**必须传 req.signal**。此前漏传，医生中断请求后它仍会空转满 6s
  // 才自己超时——diagnose 路由（:83）一直是传的，两条路径写法不同源。
  //
  // 并行结构与 diagnose 对齐：assistedNegations 只被 buildLocalPatentMedicineContext 消费，
  // 而 EviMed 那条慢腿不依赖它。原写法把两者串成一条 then 链，等于让 EviMed 白等 6s。
  const assistedNegationsPromise = assistedPolarityDecisions(safeState, req.signal);
  const [medicinePlan, baseEvidenceContext, inventoryContext] = await Promise.all([
    planEvidenceBoundMedicineCandidates(safeState, parsed.customer.customerId, req.signal),
    assistedNegationsPromise.then((assistedNegations) =>
      buildCdssEvidenceContext(safeState, "prescribe", assistedNegations)),
    // 院内库存可得性（甲方 2026-08-05 入站药品同步）。未导入库存时返回空串，
    // 提示词与导入前逐字节相同——可得性不是安全控制，缺数据不得改变链路行为。
    buildDrugInventoryPromptContext(parsed.customer.customerId),
  ]);
  const evidenceContext = [baseEvidenceContext, medicinePlan.evidenceContext].filter(Boolean).join("\n\n");
  const basePrompt = buildPrescribePrompt(safeState);
  const promptSuffixes = inventoryContext ? [inventoryContext] : [];
  const reviewItems = mergePrescriptionReviewItems(permission.reasons, gated.safetyGate?.missingItems);
  const reviewItemsText = reviewItems.join("、") || "部分病历信息";
  const informationNotice = limitedInformation
    ? [
        "## 信息完整性边界",
        `本候选方药仅依据已经提供的信息生成；正式采纳前需确认：${reviewItemsText}。这些未知项不影响医生审阅候选方案，但不会被视为已核实事实。`,
      ].join("\n")
    : "";
  if (limitedInformation) {
    promptSuffixes.push(`【有限信息候选】当前待复核：${reviewItemsText}。请基于已知证候、病机和治法生成医生审阅用候选方案，并把相关未知项或阳性风险写入适用边界；不得臆造患者事实，也不得仅因缺项或风险提示拒绝生成。`);
  }
  if (signedPriorReasoning.clinicalReview?.status !== "accepted") {
    promptSuffixes.push("【辨证复核状态】M03 独立复核本轮未完成，但其结构、病历接地、极性与安全边界已通过确定性核验。可继续生成有界候选；必须在适用边界中提示复核状态，不得把未完成复核写成已经通过，也不得因此拒绝生成。");
  }
  if (advisorySafetyNotes.length > 0) {
    promptSuffixes.push(`【急危重线索并存】服务器确定性判定本例存在未解除的安全提示：${advisorySafetyNotes.join("；")}。请照常生成剂量级候选方药；在用药风险提示中把急诊/转诊评估列为第一优先级，剂量取保守区间下段，不得因安全提示拒绝生成，也不得淡化提示。`);
  }
  if (hasUnconfirmedUnclearEncounterScope(gated) && advisoryDisposition) {
    promptSuffixes.push("【就诊目标待确认】语义预检无法确定本次就诊是否存在当前活动性治疗目标。请照常生成候选，并在适用边界中显式提示“本次就诊目标需医生确认后方可采纳”。");
  }
  if (noExecutableFormulaPath && advisoryDisposition) {
    promptSuffixes.push(`【方名剂量基准缺失】推荐方 ${unavailableFormulaNames.join("、")} 在本地标准剂量资料中暂无可执行的逐味剂量基准。请按已锁定证候与治法自拟组方（constructionType=self_devised，不得沿用该方名身份），方名方向已另行保留给医生参考。`);
  }
  const promptSuffix = promptSuffixes.map((value) => `\n\n${value}`).join("");
  const emptyEvidencePromptLength = appendEvidenceContext(basePrompt, "").length + promptSuffix.length;
  const evidenceBudget = Math.max(0, primaryTextMaxPromptChars() - emptyEvidencePromptLength);
  const boundedEvidence = compactEvidenceContextForPrompt(evidenceContext, evidenceBudget);
  const prompt = appendEvidenceContext(basePrompt, boundedEvidence.text) + promptSuffix;
  if (boundedEvidence.truncated) {
    console.warn("[tcm-cdss:prescribe] evidence context compacted to fit prompt budget", {
      basePromptChars: basePrompt.length,
      evidenceContextChars: evidenceContext.length,
      retainedEvidenceChars: boundedEvidence.text.length,
      omittedEvidenceChars: boundedEvidence.omittedChars,
      inventoryContextChars: inventoryContext.length,
      promptChars: prompt.length,
      maxPromptChars: primaryTextMaxPromptChars(),
    });
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
  const upstreamUnavailableGate: SafetyGate = {
    status: "needs_information",
    allowDiagnosis: true,
    allowDosePrescription: false,
    action: "complete_before_prescription",
    missingItems: ["模型服务恢复后重新生成候选方药"],
    redFlags: [],
    reasons: ["模型推理服务暂时不可用（上游错误、限流或超时），本轮未完成候选方药生成。这不是处方合同或病历信息不足；已录入内容与辨病辨证结论无需修改，请稍后重新生成。"],
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
    boundedEvidence.text,
    (content) => {
      const sanitized = sanitizeUngroundedRedFlagNegations(enforceReviewedPrescriptionOutput(content), safeState);
      return advisoryBanner ? `${advisoryBanner}${sanitized}` : sanitized;
    },
    safeState,
  );
  return callDiagnosisStream(prompt, "deepseek", undefined, "markdown", {
    requestSignal: req.signal,
    upstreamUnavailableFallback: buildSafetyLimitedPrescription(
      upstreamUnavailableGate,
      "upstream_model_unavailable",
    ),
    structuredOrchestrationStartedAt: orchestrationStartedAt,
    // 模型输出彻底不可回收时：M03 已锁定可编译方 → 确定性渲染「基准组成+药典区间」参考页
    // （不经模型、非剂量、医师定量），医生不再拿到空白页；未锁方/不可编译 → 原安全有限文案。
    truncateFallback: buildDeterministicFormulaReferenceFallback(gated, signedPriorReasoning)
      ?? buildSafetyLimitedPrescription(truncationGate, "m04_truncated_no_candidate"),
    structuredStage: "prescribe",
    structuredQueueKey: parsed.customer.customerHash,
    // M04 repair/review must never receive raw HIS identifiers.
    structuredClinicalContext,
    structuredReviewEvidenceContext: boundedEvidence.text,
    structuredPatientAge: authoritativePatientAgeYears(gated),
    structuredCaseState: safeState,
    structuredMedicineCandidates: medicinePlan.candidates,
    structuredPriorReasoning: signedPriorReasoning,
    prescribeSignatureContext: buildPrescribeContractSignatureContext(trustedGated),
    // 医生点「重新生成候选方药」时前端原样重发同一份 caseState 与同一份已签名 M03，
    // 服务端据此认出这是同一次尝试的第 N 轮（见 m04-retry-policy 的生产实证：不认它时，
    // 第二次返回与第一次逐字节相同的失败页，恢复动作形同虚设）。
    m04AttemptKey: m04AttemptKey({
      caseId: gated.id,
      m03ContractSignature: signedPriorReasoning?.contractSignature,
    }),
    // 先校验并清理模型引用，再由服务端用本地方剂库写入可信原典；否则本地补入的
    // 经典出处会被模型证据白名单误判为未核验来源。
    outputTransform: (content) => {
      const sanitized = applyTcmTreatmentCapabilityPriority(evidenceOutputTransform(content), safeState, signedPriorReasoning);
      // Deterministic safety fallbacks intentionally contain no structured M04 sentinel. They have
      // already been generated by the server and must not be reinterpreted as a malformed model
      // prescription, otherwise the original rejection is hidden behind a misleading contract error.
      if (!sanitized.includes("<!-- DIAGNOSIS_JSON_START -->")) return sanitized;
      const enriched = enrichPrescriptionProvenance(sanitized, clinicalGroundingText(safeState));
      // 药味功用/身份在 enrichPrescriptionProvenance 之后才完整。流层更早执行的 deletion-only
      // 剔除看不到这些新增知识，额外坏味会一直潜伏到最终 T1 合同才把整方清空。对同一最终字节
      // 再做一次只减不增的剔除：唯一君药、经典方基准或删除后结构不成立时函数原样返回，随后
      // 现有安全合同继续 fail-closed；成功剔除时独立复核、审方与签名都消费剔除后的候选。
      const directionPruned = declassifyAndDropOpposingM04CandidateHerbs(enriched, signedPriorReasoning);
      const reasoning = parseReasoningV2(directionPruned);
      // The stream layer has already exhausted formula-composition repair before allowing a
      // transparent self-devised fallback. Keep that safe fallback usable here while all other
      // formula drift, dose, regimen and clinical-grounding failures remain blocking contracts.
      // 降级候选（identityDeclassified）在流层已按「安全底线合同 + 带批注受理」验收过；
      // 路由终审必须用**同一口径**复验，否则这里的全量质量口径会把刚受理的候选再判死——
      // 这是同一结构性问题的第 5 处复发点（finalized_prescription_transparent_therapy_*）。
      // 无论是否降级，最终出口都用同一 T1 口径；差别只在方名身份合同是否允许透明降级。
      const declassifiedAccepted = Boolean(reasoning?.formula?.candidates?.[0]?.identityDeclassified);
      const declassificationTherapyIssue = declassifiedAccepted
        ? transparentFormulaTherapyIssue(reasoning, signedPriorReasoning, true)
        : undefined;
      // 最终出口必须每次先完整重跑 T1 安全底线。之前只在全量语义合同“已经有 issue”
      // 的分支内才算 safetyIssue；若全量口径把审方风险当作 advisory，十八反会返回
      // undefined 并绕过整个安全分支。安全底线不能依赖另一个质量问题先触发。
      const detectedSafetyIssue = m04SafetyContractIssue(
        reasoning,
        signedPriorReasoning,
        isKnownTcmHerbName,
        false,
        false,
        clinicalGroundingText(safeState),
        // 对所有候选统一按「词表能力边界可批注、真实方向对立仍阻断」口径重跑 T1。
        // 该参数不会豁免寒热对立；它只移除 unsupportedHighImpactHerbIssue 的 vocab 分支。
        true,
      ) || "";
      // 核心结构化编排器仍会在初次生成与修复轮严格驳回君药标签不一致；outputTransform 同时
      // 也是修复耗尽后终审，不能在核心已按质量项受理后再次把同一码升级成剂量安全 T1。
      // 真正的药物安全码不匹配本谓词，继续逐字硬拦。
      const safetyIssue = isM04FinalizerDeferredLabelIssue(detectedSafetyIssue) ? "" : detectedSafetyIssue;
      const issue = safetyIssue || formulaCompilationContractIssue(reasoning, signedPriorReasoning, false, true) || declassificationTherapyIssue || m04SemanticIssue(
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
      // ⑤ 方义占位句的**唯一**补写点：修复机会到这里已经全部用尽（流层的修复轮、
      // fixpoint 早退、编排时限都在上游走完了），此刻仍然对不上 KB 的药味才补角色兜底句，
      // 保证医生看到的不是空栏。放在 issue 计算之后，是为了不让服务端造的合法值再一次
      // 把 candidate_*_herb_*_function 这条修复通路堵死（那正是本条缺陷的形状）。
      const finalized = applyDeterministicHerbFunctions(directionPruned, { fillRolePlaceholder: true });
      // 方名身份恢复必须发生在**重建可见正文之前**（2026-08-11）。
      //
      // 恢复此前只挂在流层签名前的最后一公里，那时可见正文早已按恢复**之前**的载荷渲染完毕，
      // 而它只改 sentinel JSON、不碰正文。结果是同一份响应两个答案：医生页面「本例辨证组方 /
      // 自拟方」，签名载荷与 HIS 方案「四君子汤加减 / single_base」。50 例实测 34/39 例页面
      // 显示自拟方，其中 10 例载荷里是标准经方——甲方读页面，量出来的方名可追溯率因此长期偏低。
      //
      // 位置在合同判定（issue）**之后**：恢复不参与放行判定，判定看的仍是模型原样输出，
      // 不会因为服务端补了方名而让一张本该被驳回的处方通过。流层最后一公里的那次恢复保留
      // 不动（幂等：已带 formulaNames 的候选原样返回），继续为不走本路由的分支兜底。
      const identityRestored = applyRestoredGovernedFormulaIdentity(finalized, signedPriorReasoning);
      const synchronized = synchronizeVisibleClinicalSummary(
        identityRestored,
        "prescribe",
        clinicalGroundingText(safeState),
        safeState,
      );
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
        // ── 质量类问题一律不阻断（甲方 2026-08-08 定口径）────────────────────────
        //
        // 判据只剩一条：**底线合同（T1）干不干净**。safetyIssue 非空 = 逐味药典剂量越界 /
        // 十八反十九畏 / 特殊人群禁忌 / 管制毒性——这些继续硬拦，医生拿到的是明确的安全拒绝。
        // safetyIssue 为空时，剩下的全是「本系统没能自动核验」类（治法词表覆盖率、
        // 君药功效方向、病机节点覆盖、方名可追溯…），**它们一律不再让医生一无所获**。
        //
        // 为什么这条口径成立：这类码指向的是我方词表能力边界，不是这张方有临床错误。
        // 全量归档重放（922 组）逐例还原过第一大驳回族 emperor_therapy_mismatch 的 8 个真实病例，
        // 没有一例是临床用错君药——全部是知识库缺功用文本、治法写法未收词、双君方配伍才成立。
        // 而每一味的剂量边界、配伍禁忌、特殊人群门禁、寒热极性对立在这道门之外**独立执行**，
        // 灵犀审方还会再过一遍。把「我们没读懂」变成「医生一无所获」，是拿产品可用性
        // 为我方的词表缺口买单。
        const qualityOnly = !safetyIssue;
        if (!annotation && !qualityOnly) {
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
        // synchronizeVisibleClinicalSummary 从结构化载荷重建可见正文，标题前的警示横幅
        // 不在载荷里、会被重建丢掉——这里显式补回，横幅必须活到最终输出。
        // 批注**不再呈现给医生**（甲方 2026-08-08 定口径 4）：
        // 「君药方向未自动核验」这类是后台细节，医生并不知道系统内部怎么算的，
        // 把它印在处方页顶端只会制造无从处置的疑虑。安全类横幅（CDSS_SAFETY_ADVISORY）
        // 与信息提示（informationNotice）不受影响，那两类是医生需要行动的内容。
        // 受理事实仍写进服务端日志与遥测，可追溯，只是不上屏。
        return [
          advisoryBanner && !synchronized.includes("CDSS_SAFETY_ADVISORY") ? advisoryBanner.trimEnd() : "",
          informationNotice,
          synchronized,
        ].filter(Boolean).join("\n\n");
      }
      return [
        advisoryBanner && !synchronized.includes("CDSS_SAFETY_ADVISORY") ? advisoryBanner.trimEnd() : "",
        informationNotice,
        synchronized,
      ].filter(Boolean).join("\n\n");
    },
  });
}
