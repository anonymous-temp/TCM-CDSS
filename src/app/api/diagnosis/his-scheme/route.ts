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
import {
  isLimitedM03NotPrescribable,
  isTrustedHisWorkbenchEdit,
  validateHisPrescriptionForWriteBack,
} from "@/lib/his-prescription-validation";
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
import {
  verifyDiagnoseReasoningSignature,
  verifyPrescribeReasoningSignature,
} from "@/lib/reasoning-contract-signature";

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
  // A supplied prescription must at least carry a current tenant-bound M03 chain. Validate that
  // root immediately, before clinical-fact extraction, evidence retrieval or RxAudit can make an
  // upstream call. A present M04 signature is also checked here; an unsigned draft may still be
  // projected as diagnose-only for unresolved encounters, but an invalid/cross-tenant signed M04
  // is an explicit replay signal and must be rejected before any upstream work.
  let preflightCaseState = parsed.caseState;
  const initialPrescribed = prescribeReasoningFromState(preflightCaseState);
  const initialDiagnose = diagnoseReasoningFromState(preflightCaseState);
  if (initialDiagnose && !verifyDiagnoseReasoningSignature(initialDiagnose, preflightCaseState)) {
    return Response.json({
      error: "当前辨病辨证结果已失效，请重新生成后再生成 HIS 方案。",
      code: "invalid_m03_signature",
    }, { status: 409 });
  }
  if (initialPrescribed) {
    if (!verifyDiagnoseReasoningSignature(initialDiagnose, preflightCaseState)) {
      return Response.json({
        error: "当前辨病辨证结果已失效，请重新生成后再生成 HIS 方案。",
        code: "invalid_m03_signature",
      }, { status: 409 });
    }
    if (isLimitedM03NotPrescribable(initialDiagnose)) {
      return Response.json({
        error: "本次辨病辨证仅形成有限结果，尚未形成可采纳的证候与病机链，不能生成剂量级 HIS 方案；请补充会影响辨证或用药的患者信息后重新分析。",
        code: "limited_m03_not_prescribable",
      }, { status: 409 });
    }
    const trustedWorkbenchEdit = isTrustedHisWorkbenchEdit(preflightCaseState, initialPrescribed);
    if (!trustedWorkbenchEdit && !verifyPrescribeReasoningSignature(initialPrescribed, preflightCaseState)) {
      // An unsigned draft may only survive as diagnose-only output when a deterministic gate has
      // already disabled dosing. Strip every prescription projection before evidence/facts work;
      // signed-but-invalid material is always an explicit integrity/replay failure.
      const permission = derivePrescriptionPermission(withSafetyGate(preflightCaseState));
      const doseAlreadySuppressed = permission.candidateMode === "non_dose_only" ||
        permission.candidateMode === "blocked" || hasUnconfirmedUnclearEncounterScope(preflightCaseState);
      if (initialPrescribed.contractSignature || !doseAlreadySuppressed) {
        return Response.json({
          error: "当前候选处方签名已失效，请重新生成后再生成 HIS 方案。",
          code: "invalid_m04_signature",
        }, { status: 409 });
      }
      preflightCaseState = {
        ...preflightCaseState,
        prescription: "",
        reasoningPrescribe: undefined,
        reasoningV2: initialDiagnose,
        prescriptionRevision: undefined,
      };
    }
  }
  const hasLegacyPrescription = typeof preflightCaseState.prescription === "string" &&
    preflightCaseState.prescription.trim().length > 0;
  if (!initialPrescribed && (hasLegacyPrescription || preflightCaseState.prescriptionRevision)) {
    return Response.json({
      error: "缺少有效的结构化候选处方，已拒绝生成可写回 HIS 的方案。",
      code: "missing_structured_prescription",
    }, { status: 422 });
  }
  // Evidence retrieval is independent of the semantic red-flag projection. Run it concurrently so
  // the HIS boundary cannot serially consume the full clinical-facts budget and then the full
  // EviMed budget, which previously exceeded the endpoint's 30s integration SLO under a long batch.
  const evidenceScopePromise = evidenceScopeForCase(preflightCaseState)
    .catch(() => buildEvidenceScope(""));
  const caseState = withSafetyGate(await maybeAttachClinicalFactsBackstop(preflightCaseState, undefined, req.signal));
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
