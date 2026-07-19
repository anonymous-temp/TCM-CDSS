import { buildHisAiSchemePayload } from "@/lib/his-scheme";
import { readCaseStateRequest } from "@/lib/diagnosis-request";
import {
  applyRxAuditInputAdvisories,
  buildAuditInputAdvisories,
  buildAuditInputAdvisorySection,
  buildLingxiRiskSection,
  buildLocalHighRiskHerbPairSection,
  buildRxAuditCorrelationMetadata,
  buildUnavailableRxAuditSection,
  mergeLocalHighRiskHerbPairIssues,
  normalizeAuditOutcomeForPatient,
  runBoundedRxAudit,
} from "@/lib/rxaudit";
import { buildDeterministicRiskFollowup, buildForcedIncompleteRiskFollowup, derivePrescriptionPermission, deriveSafetyLocked, sanitizeCaseStateForModel, withSafetyGate } from "@/lib/diagnosis-safety";
import { prescribeReasoningFromState } from "@/lib/diagnosis-parse";
import { validateHisPrescriptionForWriteBack } from "@/lib/his-prescription-validation";
import { computePrescriptionVersionHash } from "@/lib/prescription-version";
import { buildCdssEvidenceContext } from "@/lib/cdss-evidence-context";
import { buildEvidenceScope } from "@/lib/evidence-source-validation";
import { createHash } from "node:crypto";
import { maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";

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

export async function POST(req: Request) {
  const parsed = await readCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;
  const caseState = withSafetyGate(await maybeAttachClinicalFactsBackstop(parsed.caseState, undefined, req.signal));
  const prescribed = prescribeReasoningFromState(caseState);
  const permission = derivePrescriptionPermission(caseState);
  if (permission.candidateMode === "non_dose_only" || permission.candidateMode === "blocked") {
    const diagnoseOnlyReasoning = caseState.reasoningDiagnose || (caseState.reasoningV2?.stage === "diagnose" ? caseState.reasoningV2 : undefined);
    const doseSuppressedState = {
      ...caseState,
      prescription: "",
      reasoningPrescribe: undefined,
      reasoningV2: diagnoseOnlyReasoning,
      prescriptionRevision: undefined,
    };
    return Response.json(buildHisAiSchemePayload(doseSuppressedState, await evidenceScopeForCase(caseState)));
  }

  if (!prescribed && !caseState.prescriptionRevision && !caseState.prescription?.trim()) {
    return Response.json(buildHisAiSchemePayload({ ...caseState, prescriptionRevision: undefined }, await evidenceScopeForCase(caseState)));
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
      buildLocalHighRiskHerbPairSection(caseState, candidateIndex),
      inputAdvisorySection,
      buildUnavailableRxAuditSection(providerAudit.reason),
    ].filter(Boolean).join("\n\n");
    const assessed = withSafetyGate({ ...caseState, riskAssessment: auditSection, safetyLocked: deriveSafetyLocked(caseState) });
    const forcedIncomplete = caseState.skipDifferentiationGate === true && (assessed.completeness.level !== "C" || assessed.safetyGate?.status !== "ready");
    const followup = forcedIncomplete ? buildForcedIncompleteRiskFollowup(assessed) : buildDeterministicRiskFollowup(assessed);
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
      ...buildHisAiSchemePayload(advisoryState, await evidenceScopeForCase(caseState)),
      auditCorrelation: correlation,
    });
  }

  const patientSex = caseState.hisRecord?.fields.sex || caseState.patient.sex;
  const mergedAudit = mergeLocalHighRiskHerbPairIssues(caseState, candidateIndex, providerAudit);
  const effectiveAudit = applyRxAuditInputAdvisories(
    normalizeAuditOutcomeForPatient(mergedAudit, patientSex),
    inputAdvisories,
  );
  const auditSection = [inputAdvisorySection, buildLingxiRiskSection(effectiveAudit, patientSex)].filter(Boolean).join("\n\n");
  const assessed = withSafetyGate({ ...caseState, riskAssessment: auditSection, safetyLocked: deriveSafetyLocked(caseState) });
  const forcedIncomplete = caseState.skipDifferentiationGate === true && (assessed.completeness.level !== "C" || assessed.safetyGate?.status !== "ready");
  const followup = forcedIncomplete ? buildForcedIncompleteRiskFollowup(assessed) : buildDeterministicRiskFollowup(assessed);
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
    ...buildHisAiSchemePayload(auditedState, await evidenceScopeForCase(caseState)),
    auditCorrelation: correlation,
  });
}
