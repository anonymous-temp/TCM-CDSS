import { buildHisAiSchemePayload } from "@/lib/his-scheme";
import { readCustomerBoundCaseStateRequest } from "@/lib/diagnosis-request";
import {
  buildLocalHighRiskHerbPairSection,
  buildPrescriptionInputAdvisories,
  buildPrescriptionInputAdvisorySection,
  buildRetainedPrescriptionRiskSection,
} from "@/lib/local-prescription-checks";
import { RXAUDIT_DISABLED_REASON, skippedRxAuditCorrelation } from "@/lib/rxaudit-status";
import { buildDeterministicRiskFollowupProjection, buildForcedIncompleteRiskFollowup, derivePrescriptionPermission, deriveSafetyLocked, sanitizeCaseStateForModel, withSafetyGate } from "@/lib/diagnosis-safety";
import { joinedWarningProjections, joinWarningText } from "@/lib/warning-text-projection";
import { diagnoseReasoningFromState, prescribeReasoningFromState } from "@/lib/diagnosis-parse";
import {
  isLimitedM03NotPrescribable,
  isTrustedHisWorkbenchEdit,
  validateHisPrescriptionForWriteBack,
} from "@/lib/his-prescription-validation";
import { computePrescriptionVersionHash } from "@/lib/prescription-version";
import { verifyPrescriptionRevisionAttestation } from "@/lib/prescription-revision-attestation.server";
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
import { contractProvenanceAdvisory, recordContractProvenance, withoutUnverifiedPrescribeReview, type ContractProvenanceIssue } from "@/lib/contract-provenance";
import {
  verifyDiagnoseReasoningSignature,
  verifyPrescribeReasoningSignature,
} from "@/lib/reasoning-contract-signature";
import { withClinicalResponseArchive } from "@/lib/request-archive.server";

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
  // 中成药/西药同样标院内状态（2026-09-28）：院内没有的照常保留，只标「库存外用药」。
  const availability = await drugAvailabilityProjection(
    payload.prescriptions.structuredHerbs,
    customerId,
    payload.prescriptions.patentMedicines,
  );
  // 契约版本投影必须是出参的**最后一步**：折叠 protocolStatus 之后就再也读不到规范三态，
  // 因此先把规范值取出来交给投影函数（见 his-scheme-contract-version 的说明）。
  return projectHisSchemeForContractVersion(
    { ...payload, ...availability },
    contractVersion,
    canonicalTcmProjectProtocolStatuses(payload),
  );
}

async function handlePost(req: Request) {
  const parsed = await readCustomerBoundCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;
  const contractVersion = hisSchemeContractVersionFromRequest(req, parsed.body);
  // 签名/凭据核验只标注、不拦截（owner 2026-10-12；contract-provenance.ts）。核验不通过时按回传内容
  // 生成方案，`warnings[]` 附来源提示；处方的剂量边界、配伍禁忌、特殊人群核对对回传药味照常重跑。
  let preflightCaseState = parsed.caseState;
  const provenanceIssues: ContractProvenanceIssue[] = [];
  const initialPrescribed = prescribeReasoningFromState(preflightCaseState);
  const initialDiagnose = diagnoseReasoningFromState(preflightCaseState);
  if (initialDiagnose && !verifyDiagnoseReasoningSignature(initialDiagnose, preflightCaseState)) {
    provenanceIssues.push("m03_unverified");
  }
  if (initialPrescribed) {
    // 带处方却没有 M03：没有可写回的诊断结论（内容缺失，不是签名问题），仍拒绝。
    if (!initialDiagnose) {
      return Response.json({
        error: "缺少辨病辨证结果（reasoningDiagnose），请先完成辨病辨证后再生成 HIS 方案。",
        code: "invalid_m03_signature",
      }, { status: 409 });
    }
    if (isLimitedM03NotPrescribable(initialDiagnose)) {
      return Response.json({
        error: "本次辨病辨证仅形成有限结果，尚未形成可采纳的证候与病机链，不能生成剂量级 HIS 方案；请补充会影响辨证或用药的患者信息后重新分析。",
        code: "limited_m03_not_prescribable",
      }, { status: 409 });
    }
    const preflightWorkbenchIndex = preflightCaseState.prescriptionRevision?.candidateIndex ?? 0;
    const preflightWorkbenchHash = initialPrescribed && preflightCaseState.prescriptionRevision?.source === "herb_workbench"
      ? await computePrescriptionVersionHash(initialPrescribed, preflightWorkbenchIndex, preflightCaseState)
      : "";
    const trustedWorkbenchEdit = isTrustedHisWorkbenchEdit(preflightCaseState, initialPrescribed, {
      clientId: parsed.customer.clientId,
      customerId: parsed.customer.customerId,
      herbHash: preflightWorkbenchHash,
    });
    if (!trustedWorkbenchEdit && !verifyPrescribeReasoningSignature(initialPrescribed, preflightCaseState)) {
      provenanceIssues.push(preflightCaseState.prescriptionRevision?.source === "herb_workbench"
        ? "workbench_revision_unattested"
        : "m04_unverified");
    }
  }
  const hasLegacyPrescription = typeof preflightCaseState.prescription === "string" &&
    preflightCaseState.prescription.trim().length > 0;
  if (!initialPrescribed && (hasLegacyPrescription || preflightCaseState.prescriptionRevision)) {
    // 没有结构化药味的处方文本无法逐味核对，不进入写回方案：剥掉后按诊断生成方案并提示（原先 422）。
    provenanceIssues.push("unstructured_prescription_ignored");
    preflightCaseState = { ...preflightCaseState, prescription: "", prescriptionRevision: undefined };
  }
  if (provenanceIssues.includes("m04_unverified") || provenanceIssues.includes("workbench_revision_unattested")) {
    preflightCaseState = withoutUnverifiedPrescribeReview(preflightCaseState);
  }
  recordContractProvenance("his-scheme", provenanceIssues);
  const provenanceAdvisories = provenanceIssues.map((issue) => contractProvenanceAdvisory(issue, preflightCaseState.prescriptionRevision?.candidateIndex ?? 0));
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
    return Response.json(await withDrugAvailability(buildHisAiSchemePayload(doseSuppressedState, await evidenceScopePromise, provenanceAdvisories), contractVersion, parsed.customer.customerId));
  }

  if (!prescribed && !caseState.prescriptionRevision && !caseState.prescription?.trim()) {
    return Response.json(await withDrugAvailability(buildHisAiSchemePayload({ ...caseState, prescriptionRevision: undefined }, await evidenceScopePromise, provenanceAdvisories), contractVersion, parsed.customer.customerId));
  }

  const requestedCandidateIndex = caseState.prescriptionRevision?.candidateIndex ?? 0;
  const currentHerbHash = prescribed
    ? await computePrescriptionVersionHash(prescribed, requestedCandidateIndex, caseState)
    : "";
  const validation = validateHisPrescriptionForWriteBack(caseState, {
    clientId: parsed.customer.clientId,
    customerId: parsed.customer.customerId,
    herbHash: currentHerbHash,
  });
  if (!validation.ok) {
    return Response.json({
      error: validation.message,
      code: validation.code,
      issue: validation.issue,
    }, { status: validation.status });
  }
  const { candidateIndex } = validation;
  const selectedCandidate = validation.prescribed.formula?.candidates[candidateIndex];
  const herbHash = currentHerbHash;
  if (!herbHash) {
    return Response.json({
      error: "无法建立结构化处方版本，已拒绝生成 HIS 方案。",
      code: "invalid_candidate_index",
    }, { status: 422 });
  }
  // HIS is a server trust boundary. Re-run the local deterministic checks on the exact normalized
  // structured herbs; the findings are advisory and never become a hard lock. 合理用药审方已删除
  // （owner 2026-09-25），修订收据恒为「未送审」，字段取值与原显式停用档逐字节一致。
  const inputAdvisories = buildPrescriptionInputAdvisories(caseState, candidateIndex);
  const auditedAt = new Date().toISOString();
  // A valid M04 contract authenticates its clinical candidate, not caller-supplied audit
  // metadata. Retain only separately attested skip/critical history for this exact version;
  // otherwise describe the server's current selection without issuing doctor-edit authority.
  const priorRevision = caseState.prescriptionRevision;
  const retainedRevision = priorRevision &&
    (priorRevision.auditResult === "NOT_SUBMITTED" || priorRevision.auditResult === "BLOCK" || priorRevision.highestRiskLevel === "CRITICAL") &&
    verifyPrescriptionRevisionAttestation(caseState, parsed.customer, herbHash)
    ? priorRevision : undefined;
  const auditCaseState = { ...caseState, prescriptionRevision: retainedRevision || {
    source: "herb_workbench" as const, candidateIndex, herbHash, auditedAt,
    auditResult: "NOT_SUBMITTED" as const, auditAvailable: false, degraded: false,
    auditReason: RXAUDIT_DISABLED_REASON,
  } };
  const auditSection = [
    buildLocalHighRiskHerbPairSection(auditCaseState, candidateIndex),
    buildRetainedPrescriptionRiskSection(retainedRevision),
    buildPrescriptionInputAdvisorySection(inputAdvisories),
  ].filter(Boolean).join("\n\n");
  const assessed = withSafetyGate({ ...auditCaseState, riskAssessment: auditSection, safetyLocked: deriveSafetyLocked(auditCaseState) });
  const forcedIncomplete = caseState.skipDifferentiationGate === true && (assessed.completeness.level !== "C" || assessed.safetyGate?.status !== "ready");
  const authoredFollowup = forcedIncomplete
    ? null
    : await authorFollowupForCase(assessed, diagnoseReasoning, selectedCandidate, req.signal);
  const followup = forcedIncomplete
    ? joinWarningText([buildForcedIncompleteRiskFollowup(assessed)])
    : buildDeterministicRiskFollowupProjection(assessed, authoredFollowup);
  const riskProjection = joinedWarningProjections([auditSection, followup]);
  const advisoryState = {
    ...auditCaseState,
    safetyLocked: deriveSafetyLocked(auditCaseState),
    riskAssessment: riskProjection.markdown,
  };
  return Response.json({
    ...(await withDrugAvailability(buildHisAiSchemePayload(advisoryState, await evidenceScopePromise, [...validation.advisories, ...provenanceAdvisories], { riskAssessment: riskProjection, auditSkipped: true }), contractVersion, parsed.customer.customerId)),
    auditCorrelation: skippedRxAuditCorrelation({ candidateIndex, prescriptionHash: herbHash, auditedAt }),
  });
}

// 临床请求与响应都加密留存（用户 2026-10-26 D3），见 request-archive.server.ts。
export const POST = withClinicalResponseArchive(handlePost);
