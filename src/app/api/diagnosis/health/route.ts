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

export async function GET(req: Request) {
  const strictProbe = new URL(req.url).searchParams.get("strict") === "1";
  const providers = getDiagnosisProviderStatus();
  const externalEvidence = getEvimedEvidenceStatus();
  const [externalEvidenceProbe, clinicalReviewProbe, clinicalFactsModelProbe, tongueVisionProbe, rxAuditProbe] = strictProbe
    ? await Promise.all([
      probeExternalEvidenceSources(),
      probeClinicalReviewModels(),
      probeClinicalFactsModels(),
      probeTongueVisionModel(),
      probeRxAuditTransport(),
    ])
    : [undefined, undefined, undefined, undefined, undefined];
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
    clinicalFactsModelPlan.independentReview && clinicalFactsModelPlan.independentAdjudication;
  const clinicalFactsModelsAvailable = !strictProbe || clinicalFactsModelProbe?.ok === true;
  const clinicalFactsReady = clinicalFactsEnabled && clinicalFactsSigningConfigured &&
    clinicalFactsModelPlanReady && clinicalFactsModelsAvailable;
  const rateLimitIdentityReady = cdssRateLimitIdentityConfigured();
  const evidenceMissing = externalEvidence.sources
    .filter((source) => source.requiredForRelease && !source.configured)
    .map((source) => `evidence_${source.kind}_not_configured`);
  const evidenceUnavailable = externalEvidenceProbe?.sources
    .filter((source) => source.requiredForRelease && !source.ok)
    .map((source) => `evidence_${source.kind}_${source.reason}${source.upstreamStatus ? `_http_${source.upstreamStatus}` : ""}`) || [];
  const clinicalReviewConfigured = providers.clinicalReviewModel.configured && providers.clinicalReviewModel.independentFromPrimary;
  const clinicalReviewAvailable = !strictProbe || clinicalReviewProbe?.ok === true;
  const tongueVisionRequired = providers.tongueVision.configured;
  const tongueVisionAvailable = !strictProbe || !tongueVisionRequired || tongueVisionProbe?.ok === true;
  const degradedReasons = [
    ...(!providers.primaryModel.configured ? ["primary_model_not_configured"] : []),
    ...(!clinicalReviewConfigured ? ["independent_clinical_reviewer_not_configured"] : []),
    ...(strictProbe && !clinicalReviewAvailable ? ["independent_clinical_reviewer_unavailable"] : []),
    ...(strictProbe && tongueVisionRequired && !tongueVisionAvailable ? [`tongue_vision_${tongueVisionProbe?.reason || "unavailable"}`] : []),
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
    ...(!clinicalFactsModelPlan.independentReview ? ["clinical_facts_reviewer_not_independent"] : []),
    ...(!clinicalFactsModelPlan.independentAdjudication ? ["clinical_facts_adjudicator_not_independent"] : []),
    ...(strictProbe && !clinicalFactsModelsAvailable ? ["clinical_facts_model_chain_unavailable"] : []),
    ...(!tcmTreatmentProjects.configurationValid ? [`tcm_treatment_capabilities_${tcmTreatmentProjects.reason || "invalid"}`] : []),
    ...(!rateLimitIdentityReady ? ["trusted_proxy_rate_limit_identity_not_configured"] : []),
  ];
  // RxAudit remains advisory for an individual clinical decision, but a release advertised as the
  // complete M01-M05 product is not healthy when its configured audit sidecar is unreachable.
  const strictReady = providers.primaryModel.configured && clinicalReviewConfigured && clinicalReviewAvailable && tongueVisionAvailable && evidenceMissing.length === 0 && evidenceUnavailable.length === 0 && rxAuditReady && snapshotPersistenceReady && reasoningSigningReady && clinicalFactsReady && tcmTreatmentConfigurationSafe && rateLimitIdentityReady;

  const body = {
    module: "tcm-cdss",
    releaseId: process.env.CDSS_RELEASE_ID?.trim() || "development",
    flow: ["M01采集", "M02追问门控", "M03辨病辨证", "M04候选方药", "M05风险随访"],
    ready: providers.primaryModel.configured,
    strictReady,
    degradedReasons,
    providers,
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
  };
  return Response.json(body, { status: strictProbe && !strictReady ? 503 : 200 });
}
