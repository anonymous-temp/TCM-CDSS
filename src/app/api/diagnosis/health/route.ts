import { getDiagnosisProviderStatus, probeClinicalReviewModels, probeTongueVisionModel } from "@/lib/diagnosis-api";
import { getEvimedEvidenceStatus, getEvimedGuideStatus, probeExternalEvidenceSources } from "@/lib/evimed-guide";
import { getTcmKnowledgeStatus } from "@/lib/tcm-knowledge";
import { getFormulaCatalogStatus } from "@/lib/tcm-formula-provenance";
import { getRxAuditStatus, probeRxAuditTransport } from "@/lib/rxaudit";
import { reasoningContractSigningConfigured } from "@/lib/reasoning-contract-signature";
import { getTcmTreatmentProjectStatus } from "@/lib/tcm-treatment-capabilities.server";
import {
  clinicalFactsAttestationSigningConfigured,
  getClinicalFactsModelPlan,
  isClinicalFactsBackstopEnabled,
  probeClinicalFactsModels,
} from "@/lib/clinical-facts-runtime";
import { getCdssStageTelemetrySnapshot } from "@/lib/cdss-stage-telemetry";
import { cdssRateLimitIdentityConfigured } from "@/lib/cdss-auth";
import {
  getControlledTerminologyNormalizationStatus,
  probeControlledTerminologyModel,
} from "@/lib/controlled-semantic-normalization.server";
import { getSyndromeHypothesisRerankStatus } from "@/lib/syndrome-hypothesis-rerank.server";
import { healthDiagnosticsRequested, publicHealthView } from "@/lib/health-public-view";

export async function GET(req: Request) {
  const strictProbe = new URL(req.url).searchParams.get("strict") === "1";
  const providers = getDiagnosisProviderStatus();
  const externalEvidence = getEvimedEvidenceStatus();
  const [externalEvidenceProbe, clinicalReviewProbe, clinicalFactsModelProbe, tongueVisionProbe, rxAuditProbe, controlledTerminologyProbe] = strictProbe
    ? await Promise.all([
      probeExternalEvidenceSources(),
      probeClinicalReviewModels(),
      probeClinicalFactsModels(),
      probeTongueVisionModel(),
      probeRxAuditTransport(),
      probeControlledTerminologyModel(),
    ])
    : [undefined, undefined, undefined, undefined, undefined, undefined];
  const rxAudit = getRxAuditStatus();
  const rxAuditReady = rxAudit.enabled && (!strictProbe || rxAuditProbe?.ok === true);
  const tcmTreatmentProjects = getTcmTreatmentProjectStatus();
  const tcmTreatmentConfigurationSafe = tcmTreatmentProjects.configurationValid || tcmTreatmentProjects.reason === "not_configured";
  const browserPersistenceEnabled = process.env.NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE !== "false";
  const snapshotEncryptionConfigured = (process.env.CASE_SNAPSHOT_ENCRYPTION_KEY || "").length >= 16;
  const snapshotPersistenceReady = !browserPersistenceEnabled || snapshotEncryptionConfigured;
  const reasoningSigningReady = reasoningContractSigningConfigured();
  const clinicalFactsEnabled = isClinicalFactsBackstopEnabled();
  const clinicalFactsSigningConfigured = clinicalFactsAttestationSigningConfigured();
  const clinicalFactsModelPlan = getClinicalFactsModelPlan();
  const clinicalFactsModelPlanReady = clinicalFactsModelPlan.extractor.configured &&
    clinicalFactsModelPlan.reviewer.configured && clinicalFactsModelPlan.adjudicator.configured &&
    clinicalFactsModelPlan.separateInvocationReview && clinicalFactsModelPlan.separateInvocationAdjudication;
  const clinicalFactsModelsAvailable = !strictProbe || clinicalFactsModelProbe?.ok === true;
  const clinicalFactsReady = clinicalFactsEnabled && clinicalFactsSigningConfigured &&
    clinicalFactsModelPlanReady && clinicalFactsModelsAvailable;
  const rateLimitIdentityReady = cdssRateLimitIdentityConfigured();
  const controlledTerminology = getControlledTerminologyNormalizationStatus();
  const controlledTerminologyReady = controlledTerminology.enabled &&
    controlledTerminology.model.configured &&
    (!strictProbe || controlledTerminologyProbe?.ok === true);
  const syndromeHypothesisRerank = getSyndromeHypothesisRerankStatus();
  const syndromeHypothesisRerankReady = syndromeHypothesisRerank.enabled &&
    syndromeHypothesisRerank.configured &&
    (!strictProbe || controlledTerminologyProbe?.ok === true);
  const evidenceMissing = externalEvidence.sources
    .filter((source) => source.requiredForRelease && !source.configured)
    .map((source) => `evidence_${source.kind}_not_configured`);
  const evidenceUnavailable = externalEvidenceProbe?.sources
    .filter((source) => source.requiredForRelease && !source.ok)
    .map((source) => `evidence_${source.kind}_${source.reason}${source.upstreamStatus ? `_http_${source.upstreamStatus}` : ""}`) || [];
  // A deployment may intentionally pin generation and review to the same approved model. Readiness
  // requires a separate review-only invocation; cross-model identity remains reported as a stronger
  // optional property instead of being misrepresented as the only form of independent review.
  const clinicalReviewConfigured = providers.clinicalReviewModel.configured && providers.clinicalReviewModel.independentInvocation;
  const clinicalReviewAvailable = !strictProbe || clinicalReviewProbe?.ok === true;
  const tongueVisionRequired = providers.tongueVision.enabled;
  const tongueVisionAvailable = !tongueVisionRequired || (
    providers.tongueVision.configured &&
    (!strictProbe || tongueVisionProbe?.ok === true)
  );
  const degradedReasons = [
    ...(!providers.primaryModel.configured ? ["primary_model_not_configured"] : []),
    ...(!clinicalReviewConfigured ? ["independent_clinical_reviewer_not_configured"] : []),
    ...(strictProbe && !clinicalReviewAvailable ? ["independent_clinical_reviewer_unavailable"] : []),
    ...(tongueVisionRequired && !providers.tongueVision.configured ? ["tongue_vision_api_key_not_configured"] : []),
    ...(strictProbe && tongueVisionRequired && providers.tongueVision.configured && !tongueVisionAvailable
      ? [`tongue_vision_${tongueVisionProbe?.reason || "unavailable"}`]
      : []),
    ...evidenceMissing,
    ...evidenceUnavailable,
    ...(!rxAudit.enabled ? [rxAudit.disabledReason || "rxaudit_disabled"] : []),
    ...(strictProbe && rxAudit.enabled && !rxAuditProbe?.ok
      ? [`rxaudit_${rxAuditProbe?.reason || "unavailable"}`]
      : []),
    ...(!snapshotPersistenceReady ? ["snapshot_encryption_key_not_configured"] : []),
    ...(!reasoningSigningReady ? ["reasoning_contract_signing_key_not_configured"] : []),
    ...(!clinicalFactsEnabled ? ["clinical_facts_backstop_disabled"] : []),
    ...(!clinicalFactsSigningConfigured ? ["clinical_facts_attestation_key_not_configured"] : []),
    ...(!clinicalFactsModelPlan.extractor.configured ? ["clinical_facts_extractor_not_configured"] : []),
    ...(!clinicalFactsModelPlan.reviewer.configured ? ["clinical_facts_reviewer_not_configured"] : []),
    ...(!clinicalFactsModelPlan.adjudicator.configured ? ["clinical_facts_adjudicator_not_configured"] : []),
    ...(!clinicalFactsModelPlan.separateInvocationReview ? ["clinical_facts_reviewer_not_separate_invocation"] : []),
    ...(!clinicalFactsModelPlan.separateInvocationAdjudication ? ["clinical_facts_adjudicator_not_separate_invocation"] : []),
    ...(strictProbe && !clinicalFactsModelsAvailable ? ["clinical_facts_model_chain_unavailable"] : []),
    ...(!tcmTreatmentProjects.configurationValid ? [`tcm_treatment_capabilities_${tcmTreatmentProjects.reason || "invalid"}`] : []),
    ...(!rateLimitIdentityReady ? ["trusted_proxy_rate_limit_identity_not_configured"] : []),
    ...(!controlledTerminology.enabled ? ["controlled_terminology_normalization_disabled"] : []),
    ...(!controlledTerminology.model.configured ? ["controlled_terminology_model_not_configured"] : []),
    ...(strictProbe && controlledTerminology.enabled && !controlledTerminologyProbe?.ok
      ? [`controlled_terminology_${controlledTerminologyProbe?.reason || "unavailable"}`]
      : []),
    ...(!syndromeHypothesisRerank.enabled ? ["syndrome_hypothesis_rerank_disabled"] : []),
    ...(!syndromeHypothesisRerank.configured ? ["syndrome_hypothesis_rerank_model_not_configured"] : []),
  ];
  // RxAudit remains advisory for an individual clinical decision, but a release advertised as the
  // complete M01-M05 product is not healthy when its configured audit sidecar is unreachable.
  const strictReady = providers.primaryModel.configured && clinicalReviewConfigured && clinicalReviewAvailable && tongueVisionAvailable && evidenceMissing.length === 0 && evidenceUnavailable.length === 0 && rxAuditReady && snapshotPersistenceReady && reasoningSigningReady && clinicalFactsReady && tcmTreatmentConfigurationSafe && rateLimitIdentityReady && controlledTerminologyReady && syndromeHypothesisRerankReady;

  const body = {
    module: "tcm-cdss",
    releaseId: process.env.CDSS_RELEASE_ID?.trim() || "development",
    // 构建溯源(2026-08-04)。甲方评测第 10 条:「本地 52/52 回归全绿,但线上行为与本地相反,
    // 说明目前无法证明"测试过的源码"就是"线上运行的镜像"」——这不是一条并列缺陷,而是元缺陷:
    // 无法证明镜像一致时,前面每一条「已修复」都成了无法验证的断言,于是出现「改了还是老样子」,
    // 而真正的分歧可能在部署链路而非源码。
    //
    // 构建期把 git commit 与关键源码摘要打进镜像,此处回显,部署后立刻比对:对不上就不算部署成功。
    // 值缺失时显式返回 "unknown"(而不是省略字段),这样"没打进去"和"打进去了"是可区分的两种状态。
    build: {
      commit: process.env.CDSS_BUILD_COMMIT?.trim() || "unknown",
      sourceDigest: process.env.CDSS_BUILD_SOURCE_DIGEST?.trim() || "unknown",
      builtAt: process.env.CDSS_BUILD_TIMESTAMP?.trim() || "unknown",
    },
    flow: ["M01采集", "M02追问门控", "M03辨病辨证", "M04候选方药", "M05风险随访"],
    ready: providers.primaryModel.configured,
    strictReady,
    degradedReasons,
    providers,
    syndromeHypothesisRerank,
    ...(tongueVisionProbe ? { tongueVisionProbe } : {}),
    ...(clinicalReviewProbe ? { clinicalReviewProbe } : {}),
    knowledge: getTcmKnowledgeStatus(),
    formulaKnowledge: getFormulaCatalogStatus(),
    tcmTreatmentProjects,
    guideEvidence: getEvimedGuideStatus(),
    externalEvidence,
    ...(externalEvidenceProbe ? { externalEvidenceProbe } : {}),
    rxAudit,
    ...(rxAuditProbe ? { rxAuditProbe } : {}),
    snapshotPersistence: {
      enabled: browserPersistenceEnabled,
      encryptionConfigured: snapshotEncryptionConfigured,
      ready: snapshotPersistenceReady,
    },
    reasoningContract: {
      signingConfigured: reasoningSigningReady,
      ready: reasoningSigningReady,
    },
    clinicalFacts: {
      enabled: clinicalFactsEnabled,
      signingConfigured: clinicalFactsSigningConfigured,
      modelPlan: {
        extractor: {
          provider: clinicalFactsModelPlan.extractor.provider,
          model: clinicalFactsModelPlan.extractor.model,
          configured: clinicalFactsModelPlan.extractor.configured,
        },
        reviewer: {
          provider: clinicalFactsModelPlan.reviewer.provider,
          model: clinicalFactsModelPlan.reviewer.model,
          configured: clinicalFactsModelPlan.reviewer.configured,
        },
        adjudicator: {
          provider: clinicalFactsModelPlan.adjudicator.provider,
          model: clinicalFactsModelPlan.adjudicator.model,
          configured: clinicalFactsModelPlan.adjudicator.configured,
        },
        independentReview: clinicalFactsModelPlan.independentReview,
        independentAdjudication: clinicalFactsModelPlan.independentAdjudication,
        separateInvocationReview: clinicalFactsModelPlan.separateInvocationReview,
        separateInvocationAdjudication: clinicalFactsModelPlan.separateInvocationAdjudication,
        reductionsAllowed: clinicalFactsModelPlan.reductionsAllowed,
        ready: clinicalFactsModelPlanReady,
      },
      ...(clinicalFactsModelProbe ? { modelProbe: clinicalFactsModelProbe } : {}),
      ready: clinicalFactsReady,
    },
    stageTelemetry: getCdssStageTelemetrySnapshot(),
    rateLimitIdentity: {
      trustedProxyConfigured: rateLimitIdentityReady,
      modelBudgetScope: "authenticated_session_or_api_tenant",
      ready: rateLimitIdentityReady,
    },
    controlledTerminology: {
      ...controlledTerminology,
      ...(controlledTerminologyProbe ? { probe: controlledTerminologyProbe } : {}),
      ready: controlledTerminologyReady,
    },
  };
  // 对外只给收窄视图；完整视图需同时满足 ?diagnostics=1 与 CDSS_HEALTH_DIAGNOSTICS=true。
  // no-store：健康体含发布态与探针结论，不应被任何中间缓存留存或跨调用方复用。
  return Response.json(healthDiagnosticsRequested(req) ? body : publicHealthView(body), {
    status: strictProbe && !strictReady ? 503 : 200,
    headers: { "Cache-Control": "no-store, private" },
  });
}
