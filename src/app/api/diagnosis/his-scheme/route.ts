import { buildHisAiSchemePayload } from "@/lib/his-scheme";
import { readCustomerBoundCaseStateRequest } from "@/lib/diagnosis-request";
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
  runBoundedRxAudit,
} from "@/lib/rxaudit";
import { buildDeterministicRiskFollowup, buildForcedIncompleteRiskFollowup, derivePrescriptionPermission, deriveSafetyLocked, sanitizeCaseStateForModel, withSafetyGate } from "@/lib/diagnosis-safety";
import { diagnoseReasoningFromState, prescribeReasoningFromState } from "@/lib/diagnosis-parse";
import { validateHisPrescriptionForWriteBack } from "@/lib/his-prescription-validation";
import { computePrescriptionVersionHash } from "@/lib/prescription-version";
import { buildCdssEvidenceContext } from "@/lib/cdss-evidence-context";
import { buildEvidenceScope } from "@/lib/evidence-source-validation";
import { createHash } from "node:crypto";
import { hasUnconfirmedUnclearEncounterScope, maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { drugAvailabilityProjection } from "@/lib/drug-inventory.server";
import {
  canonicalTcmProjectProtocolStatuses,
  hisSchemeContractVersionFromRequest,
  projectHisSchemeForContractVersion,
  type HisSchemeContractVersion,
} from "@/lib/his-scheme-contract-version";
import { authorFollowupForCase } from "@/lib/m05-followup-authoring.server";

const EVIDENCE_SCOPE_TTL_MS = 60_000;
const evidenceScopeCache = new Map<string, { expiresAt: number; scope: ReturnType<typeof buildEvidenceScope> }>();

async function evidenceScopeForCase(caseState: Parameters<typeof sanitizeCaseStateForModel>[0]) {
  const deidentified = sanitizeCaseStateForModel(caseState);
  const key = createHash("sha256").update(JSON.stringify(deidentified)).digest("hex");
  const now = Date.now();
  const cached = evidenceScopeCache.get(key);
  if (cached && cached.expiresAt > now) return cached.scope;
  const scope = buildEvidenceScope(await buildCdssEvidenceContext(deidentified, "prescribe"));
  evidenceScopeCache.set(key, { expiresAt: now + EVIDENCE_SCOPE_TTL_MS, scope });
  if (evidenceScopeCache.size > 64) {
    for (const [cacheKey, entry] of evidenceScopeCache) {
      if (entry.expiresAt <= now || evidenceScopeCache.size > 64) evidenceScopeCache.delete(cacheKey);
    }
  }
  return scope;
}

/**
 * 给 HIS 方案附加院内库存可得性（甲方 2026-08-05 入站药品同步）。
 *
 * 只在**投影边界**附加，不进 buildHisAiSchemePayload 的签名域：库存每天变，
 * 若进了临床合同，昨天签发的方案今天就会验签失败。处方内容逐字不变，只多出标注与替代候选。
 */
async function withDrugAvailability(
  payload: Awaited<ReturnType<typeof buildHisAiSchemePayload>>,
  contractVersion: HisSchemeContractVersion,
  customerId: string,
) {
  const availability = await drugAvailabilityProjection(payload.prescriptions.structuredHerbs, customerId);
  // 契约版本投影必须是出参的**最后一步**：折叠 protocolStatus 之后就再也读不到规范三态，
  // 因此先把规范值取出来交给投影函数（见 his-scheme-contract-version 的说明）。
  return projectHisSchemeForContractVersion(
    { ...payload, ...availability },
    contractVersion,
    canonicalTcmProjectProtocolStatuses(payload),
  );
}

export async function POST(req: Request) {
  const parsed = await readCustomerBoundCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;
  const contractVersion = hisSchemeContractVersionFromRequest(req, parsed.body);
  // Evidence retrieval is independent of the semantic red-flag projection. Run it concurrently so
  // the HIS boundary cannot serially consume the full clinical-facts budget and then the full
  // EviMed budget, which previously exceeded the endpoint's 30s integration SLO under a long batch.
  const evidenceScopePromise = evidenceScopeForCase(parsed.caseState)
    .catch(() => buildEvidenceScope(""));
  const caseState = withSafetyGate(await maybeAttachClinicalFactsBackstop(parsed.caseState, undefined, req.signal));
  const diagnoseReasoning = diagnoseReasoningFromState(caseState);
  const prescribed = prescribeReasoningFromState(caseState);
  const permission = derivePrescriptionPermission(caseState);
  // An attested "unclear" encounter scope without a doctor confirmation bound to the current
  // record fingerprint must never emit a dose-carrying HIS payload; keep the diagnose-only scheme.
  if (permission.candidateMode === "non_dose_only" || permission.candidateMode === "blocked" || hasUnconfirmedUnclearEncounterScope(caseState)) {
    const diagnoseOnlyReasoning = caseState.reasoningDiagnose || (caseState.reasoningV2?.stage === "diagnose" ? caseState.reasoningV2 : undefined);
    const doseSuppressedState = {
      ...caseState,
      prescription: "",
      reasoningPrescribe: undefined,
      reasoningV2: diagnoseOnlyReasoning,
      prescriptionRevision: undefined,
    };
    return Response.json(await withDrugAvailability(buildHisAiSchemePayload(doseSuppressedState, await evidenceScopePromise), contractVersion, parsed.customer.customerId));
  }

  if (!prescribed && !caseState.prescriptionRevision && !caseState.prescription?.trim()) {
    return Response.json(await withDrugAvailability(buildHisAiSchemePayload({ ...caseState, prescriptionRevision: undefined }, await evidenceScopePromise), contractVersion, parsed.customer.customerId));
  }

  const validation = validateHisPrescriptionForWriteBack(caseState);
  if (!validation.ok) {
    return Response.json({
      error: validation.message,
      code: validation.code,
      issue: validation.issue,
    }, { status: validation.status });
  }
  const { candidateIndex } = validation;
  const selectedCandidate = validation.prescribed.formula?.candidates[candidateIndex];
  const herbHash = await computePrescriptionVersionHash(validation.prescribed, candidateIndex, caseState);
  if (!herbHash) {
    return Response.json({
      error: "无法建立结构化处方版本，已拒绝生成 HIS 方案。",
      code: "invalid_candidate_index",
    }, { status: 422 });
  }
  // HIS is a server trust boundary. Re-audit the exact normalized structured herbs so the warning shown
  // to the doctor is trustworthy; the audit outcome itself is advisory and never becomes a hard lock.
  const { medicationExtraction, providerAudit } = await runBoundedRxAudit(caseState, candidateIndex, req.signal);
  const inputAdvisories = buildAuditInputAdvisories(caseState, candidateIndex, medicationExtraction);
  const inputAdvisorySection = buildAuditInputAdvisorySection(inputAdvisories);
  const auditedAt = new Date().toISOString();
  if (!providerAudit.ok) {
    console.warn("[tcm-cdss:rxaudit] HIS advisory audit unavailable", { reason: providerAudit.reason });
    const auditSection = [
      buildRxAuditScopeSection(caseState, candidateIndex),
      buildLocalHighRiskHerbPairSection(caseState, candidateIndex),
      inputAdvisorySection,
      buildUnavailableRxAuditSection(providerAudit.reason),
    ].filter(Boolean).join("\n\n");
    const assessed = withSafetyGate({ ...caseState, riskAssessment: auditSection, safetyLocked: deriveSafetyLocked(caseState) });
    const forcedIncomplete = caseState.skipDifferentiationGate === true && (assessed.completeness.level !== "C" || assessed.safetyGate?.status !== "ready");
    const authoredFollowup = forcedIncomplete
      ? null
      : await authorFollowupForCase(assessed, diagnoseReasoning, selectedCandidate, req.signal);
    const followup = forcedIncomplete
      ? buildForcedIncompleteRiskFollowup(assessed)
      : buildDeterministicRiskFollowup(assessed, authoredFollowup);
    const advisoryState = {
      ...caseState,
      safetyLocked: deriveSafetyLocked(caseState),
      prescriptionRevision: herbHash ? {
        source: "herb_workbench" as const,
        candidateIndex,
        herbHash,
        auditedAt,
        auditResult: "MANUAL_REVIEW" as const,
        highestRiskLevel: "HIGH" as const,
        auditAvailable: false,
        degraded: true,
        degradeReason: providerAudit.reason,
        needManualReview: true,
        auditReason: providerAudit.reason,
      } : undefined,
      riskAssessment: [auditSection, followup].join("\n\n"),
    };
    const correlation = buildRxAuditCorrelationMetadata({
      providerOutcome: providerAudit,
      candidateIndex,
      prescriptionHash: herbHash,
      auditedAt,
    });
    return Response.json({
      ...(await withDrugAvailability(buildHisAiSchemePayload(advisoryState, await evidenceScopePromise), contractVersion, parsed.customer.customerId)),
      auditCorrelation: correlation,
    });
  }

  const patientSex = caseState.hisRecord?.fields.sex || caseState.patient.sex;
  const mergedAudit = mergeLocalHighRiskHerbPairIssues(caseState, candidateIndex, providerAudit);
  const effectiveAudit = applyRxAuditInputAdvisories(
    normalizeAuditOutcomeForPatient(mergedAudit, patientSex),
    inputAdvisories,
  );
  const auditSection = [
    buildRxAuditScopeSection(caseState, candidateIndex),
    inputAdvisorySection,
    buildLingxiRiskSection(effectiveAudit, patientSex),
  ].filter(Boolean).join("\n\n");
  const assessed = withSafetyGate({ ...caseState, riskAssessment: auditSection, safetyLocked: deriveSafetyLocked(caseState) });
  const forcedIncomplete = caseState.skipDifferentiationGate === true && (assessed.completeness.level !== "C" || assessed.safetyGate?.status !== "ready");
  const authoredFollowup = forcedIncomplete
    ? null
    : await authorFollowupForCase(assessed, diagnoseReasoning, selectedCandidate, req.signal);
  const followup = forcedIncomplete
    ? buildForcedIncompleteRiskFollowup(assessed)
    : buildDeterministicRiskFollowup(assessed, authoredFollowup);
  const auditedState = {
    ...caseState,
    riskAssessment: [auditSection, followup].join("\n\n"),
    safetyLocked: deriveSafetyLocked(caseState),
    prescriptionRevision: herbHash ? {
      source: "herb_workbench" as const,
      candidateIndex,
      herbHash,
      auditedAt,
      auditResult: effectiveAudit.auditResult,
      highestRiskLevel: effectiveAudit.highestRiskLevel,
      auditAvailable: !providerAudit.degraded,
      degraded: providerAudit.degraded,
      degradeReason: providerAudit.degradeReason,
      needManualReview: effectiveAudit.needManualReview,
      auditReason: providerAudit.degradeReason,
      auditId: providerAudit.auditId,
      traceId: providerAudit.traceId,
    } : undefined,
  };
  const correlation = buildRxAuditCorrelationMetadata({
    providerOutcome: providerAudit,
    effectiveOutcome: effectiveAudit,
    candidateIndex,
    prescriptionHash: herbHash,
    auditedAt,
  });
  return Response.json({
    ...(await withDrugAvailability(buildHisAiSchemePayload(auditedState, await evidenceScopePromise), contractVersion, parsed.customer.customerId)),
    auditCorrelation: correlation,
  });
}
