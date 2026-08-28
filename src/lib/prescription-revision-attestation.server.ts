import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { CustomerContext } from "./customer-context";
import type { CaseState } from "./diagnosis-types";

export const WORKBENCH_REVISION_ATTESTATION_VERSION = "tcm-cdss-workbench-revision-v1" as const;

type PrescriptionRevision = NonNullable<CaseState["prescriptionRevision"]>;
type AttestedRevisionFields = Omit<PrescriptionRevision, "attestationVersion" | "attestation">;

function signingKey(): string {
  return process.env.REASONING_CONTRACT_SIGNING_KEY?.trim() || "";
}

function attestationPayload(
  caseState: Pick<CaseState, "id" | "hisRecord" | "customerId">,
  customer: Pick<CustomerContext, "clientId" | "customerId">,
  revision: AttestedRevisionFields,
): string {
  const caseId = caseState.id?.trim();
  const encounterId = (caseState.hisRecord?.caseId || caseId || "").trim();
  if (!caseId || !encounterId || caseState.customerId !== customer.customerId) {
    throw new Error("Cannot attest a workbench revision without the current tenant, case and encounter binding");
  }
  if (!Number.isSafeInteger(revision.candidateIndex) || revision.candidateIndex < 0) {
    throw new Error("Cannot attest an invalid workbench candidate index");
  }
  if (!/^sha256-[a-f0-9]{64}$/i.test(revision.herbHash) || !Number.isFinite(Date.parse(revision.auditedAt))) {
    throw new Error("Cannot attest an invalid workbench prescription version");
  }
  return JSON.stringify({
    version: WORKBENCH_REVISION_ATTESTATION_VERSION,
    clientId: customer.clientId,
    customerId: customer.customerId,
    caseId,
    encounterId,
    revision: {
      source: revision.source,
      candidateIndex: revision.candidateIndex,
      herbHash: revision.herbHash,
      // 浏览器持久化会按现有隐私策略把时间降到日期；签名同样只绑定日期，避免安全凭据
      // 在合法脱敏恢复后失效。病例、就诊、租户和完整处方 hash 仍提供精确防重放边界。
      auditedOn: new Date(revision.auditedAt).toISOString().slice(0, 10),
      auditResult: revision.auditResult,
      highestRiskLevel: revision.highestRiskLevel,
      auditAvailable: revision.auditAvailable,
      degraded: revision.degraded,
      degradeReason: revision.degradeReason,
      needManualReview: revision.needManualReview,
      auditReason: revision.auditReason,
      // provider auditId/traceId 按既有持久化策略不会进入浏览器快照，不能成为签名域。
    },
  });
}

function signPayload(payload: string): string | undefined {
  const key = signingKey();
  if (key.length < 32) return undefined;
  return `hmac-sha256:${createHmac("sha256", key).update(payload).digest("hex")}`;
}

export function issuePrescriptionRevisionAttestation(
  caseState: Pick<CaseState, "id" | "hisRecord" | "customerId">,
  customer: Pick<CustomerContext, "clientId" | "customerId">,
  revision: AttestedRevisionFields,
): Pick<PrescriptionRevision, "attestationVersion" | "attestation"> | undefined {
  let attestation: string | undefined;
  try {
    attestation = signPayload(attestationPayload(caseState, customer, revision));
  } catch {
    return undefined;
  }
  return attestation
    ? { attestationVersion: WORKBENCH_REVISION_ATTESTATION_VERSION, attestation }
    : undefined;
}

export function verifyPrescriptionRevisionAttestation(
  caseState: Pick<CaseState, "id" | "hisRecord" | "customerId" | "prescriptionRevision">,
  customer: Pick<CustomerContext, "clientId" | "customerId">,
  currentHerbHash: string,
): boolean {
  const currentRevision = caseState.prescriptionRevision;
  if (!currentRevision || currentRevision.attestationVersion !== WORKBENCH_REVISION_ATTESTATION_VERSION) return false;
  if (currentRevision.herbHash !== currentHerbHash || !/^hmac-sha256:[a-f0-9]{64}$/i.test(currentRevision.attestation || "")) {
    return false;
  }
  const { attestationVersion: _version, attestation: actual, ...unsignedRevision } = currentRevision;
  void _version;
  let expected: string | undefined;
  try {
    expected = signPayload(attestationPayload(caseState, customer, unsignedRevision));
  } catch {
    return false;
  }
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
