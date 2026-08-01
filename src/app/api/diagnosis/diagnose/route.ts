import { callDiagnosisStream } from "@/lib/diagnosis-api";
import { appendEvidenceContext, buildCdssEvidenceContext, buildEvidenceOutputTransform } from "@/lib/cdss-evidence-context";
import { normalizeCaseTextForFormulaRecall } from "@/lib/formula-recall-normalization.server";
import { assistedNegationClauses } from "@/lib/polarity-negation-assist.server";
import { buildDiagnosePrompt } from "@/lib/diagnosis-prompts";
import { readCaseStateRequest } from "@/lib/diagnosis-request";
import { buildDiagnoseContractSignatureContext, signDiagnoseReasoning } from "@/lib/reasoning-contract-signature";
import { authoritativePatientAgeYears, buildSafetyAdvisoryBanner, buildSafetyLimitedDiagnosis, buildSafetyLimitedDiagnosisReasoning, clinicalGroundingText, gateDispositionIsAdvisory, markdownNdjsonResponse, renderSafetyLimitedDiagnosisContract, sanitizeCaseStateForModel, sanitizeUngroundedRedFlagNegations, withSafetyGate } from "@/lib/diagnosis-safety";
import { hasValidClinicalFactsAttestation, maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { rerankSyndromeHypothesesForFormulaRecall } from "@/lib/syndrome-hypothesis-rerank.server";

export async function POST(req: Request) {
  const parsed = await readCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;
  // Deterministic hard red flags must reach emergency guidance without waiting on a semantic model.
  // For all remaining cases, the additive semantic fact layer stays enabled and can identify
  // colloquial risks that are not covered by the conservative deterministic lower bound.
  const deterministicGate = withSafetyGate(parsed.caseState);
  const caseState = deterministicGate.safetyGate?.status === "red_flag"
    ? parsed.caseState
    : await maybeAttachClinicalFactsBackstop(parsed.caseState, undefined, req.signal);
  const gated = withSafetyGate(caseState);
  const redFlagAnalysis = gated.safetyGate?.status === "red_flag";
  const limitedInformation = gated.completeness.level !== "C" || gated.safetyGate?.status !== "ready";
  const hasChiefComplaint = Boolean((gated.chiefComplaint || gated.hisRecord?.fields?.zhushu || "").trim());
  if (!hasChiefComplaint) {
    return markdownNdjsonResponse(buildSafetyLimitedDiagnosis(gated, gated.safetyGate!));
  }

  const signedLimitedDiagnosis = (gate: NonNullable<typeof gated.safetyGate>) => renderSafetyLimitedDiagnosisContract(
    gated,
    gate,
    signDiagnoseReasoning(
      buildSafetyLimitedDiagnosisReasoning(gated, gate),
      buildDiagnoseContractSignatureContext(gated),
    ),
  );
  // 红旗处置（甲方决策：不阻断临床流程）。检测照常，advise 模式下不再用「安全有限合同」
  // 顶替整份辨证——那一页对医生的价值是零，红旗本身反而淹没在降级文案里。改为：完整跑
  // M03，可见正文置顶确定性安全警示横幅，红旗同步写进提示词让 management 优先急诊指引。
  // CDSS_GATE_DISPOSITION=block 可切回旧拦截行为。
  if (redFlagAnalysis && !gateDispositionIsAdvisory()) {
    return markdownNdjsonResponse(signedLimitedDiagnosis(gated.safetyGate!));
  }
  const encounterScope = gated.clinicalFacts?.encounterScope;
  const historicalOnlyEncounter = encounterScope?.status === "historical_or_stable_only" &&
    encounterScope.reviewAgreement === "agreed" &&
    hasValidClinicalFactsAttestation(gated.clinicalFacts);
  if (historicalOnlyEncounter && !gateDispositionIsAdvisory()) {
    return markdownNdjsonResponse(signedLimitedDiagnosis({
      status: "needs_information",
      allowDiagnosis: true,
      allowDosePrescription: false,
      action: "complete_before_prescription",
      missingItems: ["本次当前活动性治疗目标"],
      redFlags: [],
      reasons: [`当前记录仅含既往、已缓解或稳定背景（原文：“${encounterScope.quote}”），未明确本次活动性诊疗目标，不据此推演当前剂量处方。`],
    }));
  }
  // 需求1「追问不阻断流程」：此处原有一道门——completeness 未达 C 且未做过首轮追问时，
  // 直接返回降级的 needs_information 有限诊断，把医生赶回 M02。已移除。
  //
  // 移除是安全的，因为它是**流程门**而不是安全控制：
  //   · 剂量级放行由 M04 独立把守（prescribe/route.ts 自己检查 completeness.level !== "C"
  //     与 safetyGate.status !== "ready"），删掉这道门不会让稀疏病例拿到剂量级处方；
  //   · 红旗与生命体征危急值由 withSafetyGate 独立判定，与追问轮次无关；
  //   · M03 提示词本身就写着「该等级只用于表达置信范围，不是流程门槛」「只要有主诉，
  //     就必须基于已知信息给出西医诊断倾向、非空的中医工作病名与证候」——路由的这道门
  //     与提示词的这条要求长期自相矛盾，删除后两侧口径才一致。
  // 追问因此变成可选的增强：医生随时可以补充信息并重跑推理，而不是被拦在门外。

  const safeState = sanitizeCaseStateForModel(gated);
  // 口语主诉在受控主治语料里匹配不到术语时（"睡不着觉""腰杆子疼"），先用轻量模型改写成标准中医
  // 术语作为检索查询。只影响候选召回，不进入病历事实、不呈现给医生；不可用时静默降级为纯确定性召回。
  // 证据检索只依赖病历本身，与下面两个语义增补层没有数据依赖，因此在最前面就发出去，
  // 让它与增补层、证候重排全程重叠。此前它被排在第二批、白等第一批跑完——实测前置层
  // 占 M03 端到端 4~15s，这一条重排把 EviMed 的往返基本藏进了其余前置工作里。
  // 失败不阻断：catch 回退到空证据上下文，与既有降级语义一致。
  const evidenceContextPromise = buildCdssEvidenceContext(safeState, "diagnose").catch(() => "");
  // 两个增补层互不依赖，并发跑；任一不可用都静默退回确定性行为。
  const [formulaRecallHint, assistedNegations] = await Promise.all([
    normalizeCaseTextForFormulaRecall(safeState, req.signal),
    assistedNegationClauses(safeState, req.signal),
  ]);
  // L1b 只在 L1a 的受控证候 ID 闭集内做最多 +20% 的召回重排；失败、超时或非法输出均返回空集，
  // 下游严格保持 L1a 原顺序。它不写病历、不做诊断、不绕过方名身份锁。
  const [syndromeHypothesisRerank, evidenceContext] = await Promise.all([
    rerankSyndromeHypothesesForFormulaRecall(safeState, assistedNegations, req.signal),
    evidenceContextPromise,
  ]);
  let prompt = appendEvidenceContext(
    buildDiagnosePrompt(
      safeState,
      { formulaRecallHint, assistedNegations, syndromeHypothesisRerank },
    ),
    evidenceContext,
  );
  if (limitedInformation) {
    prompt += "\n\n【有限信息推理】请使用患者已经提供的信息完成辨病辨证；降低相应结论置信度，并把真正影响判断的未知项写入 uncertainties。不得因年龄、性别、生命体征、舌脉、过敏史或当前用药未提供而拒绝输出 M03，也不得臆造缺失事实。";
  }
  if (redFlagAnalysis) {
    prompt += `\n\n【急危重线索并存】服务器确定性判定本例存在红旗：${(gated.safetyGate?.redFlags || []).join("；") || "见安全提示"}。请照常完成辨病辨证；在 management 中把急诊/转诊评估列为第一优先级并给出具体处置指引，不得因红旗拒绝输出辨证结论，也不得淡化红旗。`;
  }
  if (historicalOnlyEncounter) {
    prompt += `\n\n【就诊目标以既往背景为主】语义预检确认本次记录主要为既往、已缓解或稳定背景（原文：“${encounterScope.quote}”）。请照常完成辨证分析，并在 uncertainties 与 management.mustCollect 中显式提示“本次活动性诊疗目标需医生确认”。`;
  }
  // Attested "unclear" scope does not short-circuit M03; the model keeps reasoning but must make
  // the unconfirmed visit target explicit so the downstream dose gate stays evidence-bound.
  if (encounterScope?.status === "unclear" && hasValidClinicalFactsAttestation(gated.clinicalFacts)) {
    prompt += "\n\n【就诊目标待确认】语义预检无法确定本次就诊是否存在当前活动性治疗目标。请在 uncertainties 与 management.mustCollect 中显式记录“本次就诊目标需医生确认”，不得据此臆造当前治疗目标或直接给出剂量级结论。";
  }
  const truncatedGate = {
    status: "needs_information" as const,
    allowDiagnosis: false,
    allowDosePrescription: false,
    action: "complete_before_prescription" as const,
    missingItems: ["本次辨病辨证结果完整性"],
    redFlags: [],
    reasons: ["本次辨病辨证结果未通过完整性与临床一致性复核，本轮不生成剂量级候选。"],
  };
  return callDiagnosisStream(prompt, "deepseek", undefined, "markdown", {
    requestSignal: req.signal,
    truncateFallback: signedLimitedDiagnosis(truncatedGate),
    authoritativeTruncateFallback: true,
    structuredStage: "diagnose",
    // Structured retries and independent review are external model calls. Keep their grounding
    // context on the same deidentified DTO as the primary generation request.
    structuredClinicalContext: clinicalGroundingText(safeState),
    structuredPatientAge: authoritativePatientAgeYears(gated),
    // 这里不再预算「生成前短名单」：enforceRetrievedM03FormulaSelection 明确 `void` 掉了它
    // （方名锁定只认签名证候的 positiveSufficiency，症状召回证明不了充分性）。原先这一行是一次
    // 完整的 1796 方目录扫描 + 滑窗索引匹配，结果全程未被使用，且入参与真正喂给模型的短名单
    // 不同口径（不带 recallHint），读代码时会误以为「模型只能从检索短名单里选」。
    // Evidence is isolated from the patient-fact grounding channel so literature text can never
    // satisfy a missing patient fact during contract validation.
    structuredReviewEvidenceContext: evidenceContext,
    diagnoseSignatureContext: buildDiagnoseContractSignatureContext(gated),
    outputTransform: buildEvidenceOutputTransform(
      evidenceContext,
      (content) => {
        const sanitized = sanitizeUngroundedRedFlagNegations(content, safeState);
        // 警示横幅在最终可见正文最前（sentinel 与签名载荷不受影响）：红旗/既往背景等
        // 确定性判定必须比任何模型内容先被医生看到。
        const banner = buildSafetyAdvisoryBanner(
          redFlagAnalysis ? gated.safetyGate : undefined,
          historicalOnlyEncounter
            ? [`本次记录以既往、已缓解或稳定背景为主（原文：“${encounterScope?.quote || ""}”），本次活动性诊疗目标需医生确认。`]
            : [],
        );
        return banner ? `${banner}${sanitized}` : sanitized;
      },
    ),
  });
}
