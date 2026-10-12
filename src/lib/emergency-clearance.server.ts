import { createHmac, timingSafeEqual } from "node:crypto";
import type { CaseState } from "./diagnosis-types";
import { authorizeCustomerId } from "./customer-authorization";
import {
  evaluateSafetyGate,
  redFlagClearanceFingerprint,
  sanitizeFreeTextForExternalClinicalService,
} from "./diagnosis-safety";
import {
  activeEmergencyClearanceFindingsFromGate,
  EMERGENCY_CLEARANCE_DISPOSITIONS,
  emergencyClearanceContractIssue,
  emergencyClearanceIssueMessage,
  inspectEmergencyClearanceAttestations,
  type EmergencyClearanceActiveFinding,
  type EmergencyClearanceAttestationProblem,
  type EmergencyClearanceFindingAttestation,
} from "./emergency-clearance-contract";

/**
 * v3：在 v2 的逐条处置留痕（findings）基础上，签名域新增已授权
 * clientId + customerId，阻断跨租户重放。
 *
 * 版本号必须随之抬升——旧载荷没有完整的租户与内容绑定，若沿用同一版本号，老凭证会
 * 继续通过签名校验，而**签发端**新增的租户边界就被绕开了。
 * 抬版本 = 老凭证一律验签不过 = 回到「不解除」，与本处 fail-closed 方向一致。
 */
export const EMERGENCY_CLEARANCE_SIGNATURE_VERSION = "tcm-cdss-emergency-clearance-v3" as const;

function signingKey(): string {
  return process.env.REASONING_CONTRACT_SIGNING_KEY?.trim() || "";
}

function signaturePayload(
  caseState: Pick<CaseState, "id" | "customerId">,
  clearance: Omit<NonNullable<CaseState["emergencyClearance"]>, "contractSignature">,
): string {
  const tenantBinding = caseState.customerId
    ? authorizeCustomerId(caseState.customerId, false)
    : undefined;
  if (caseState.customerId && !tenantBinding?.ok) {
    throw new Error("Cannot bind emergency clearance to an unauthorized customer");
  }
  return JSON.stringify({
    version: EMERGENCY_CLEARANCE_SIGNATURE_VERSION,
    caseId: caseState.id,
    ...(tenantBinding?.ok
      ? { customerId: tenantBinding.customerId, clientId: tenantBinding.clientId }
      : {}),
    redFlagFingerprint: clearance.redFlagFingerprint,
    confirmedAt: clearance.confirmedAt,
    assessmentSummary: clearance.assessmentSummary,
    // 逐条留痕进签名域：否则拿到一份合法凭证后可以把 findings 改成任意内容再送回来，
    // 而下游（安全门重验、HIS 留痕）读的正是这张表。
    findings: clearance.findings.map((item) => ({
      ruleId: item.ruleId,
      message: item.message,
      disposition: item.disposition,
      basis: item.basis,
    })),
  });
}

function signPayload(payload: string): string | undefined {
  const key = signingKey();
  if (key.length < 32) return undefined;
  return `hmac-sha256:${createHmac("sha256", key).update(payload).digest("hex")}`;
}

export function verifyEmergencyClearance(
  caseState: CaseState,
  clearance = caseState.emergencyClearance,
): clearance is NonNullable<CaseState["emergencyClearance"]> {
  if (!clearance || !/^hmac-sha256:[a-f0-9]{64}$/i.test(clearance.contractSignature)) return false;
  if (!Array.isArray(clearance.findings) || clearance.findings.length === 0) return false;
  let expected: string | undefined;
  try {
    expected = signPayload(signaturePayload(caseState, {
      redFlagFingerprint: clearance.redFlagFingerprint,
      confirmedAt: clearance.confirmedAt,
      assessmentSummary: clearance.assessmentSummary,
      findings: clearance.findings,
    }));
  } catch {
    return false;
  }
  if (!expected) return false;
  const actualBytes = Buffer.from(clearance.contractSignature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function stripInvalidEmergencyClearance(caseState: CaseState): CaseState {
  if (!caseState.emergencyClearance || verifyEmergencyClearance(caseState)) return caseState;
  return { ...caseState, emergencyClearance: undefined };
}

/** 当前安全门里等待逐条处置的红旗（投影逻辑与表单、安全门重验同源）。 */
export function activeEmergencyClearanceFindings(caseState: CaseState) {
  const gate = evaluateSafetyGate({ ...caseState, emergencyClearance: undefined });
  return gate.status === "red_flag" ? activeEmergencyClearanceFindingsFromGate(gate) : [];
}

/** 400 时一并下发：调用方据此一次改对，而不是逐条试错（2026-10-12 线上 13 次失败的教训）。 */
export type EmergencyClearanceRejectionDetails = {
  activeFindings: EmergencyClearanceActiveFinding[];
  allowedDispositions: Array<{ value: string; label: string; basisHint: string }>;
  problems: EmergencyClearanceAttestationProblem[];
};

export function issueEmergencyClearance(
  caseState: CaseState,
  assessmentSummary: string,
  findings: unknown,
):
  | { ok: true; clearance: NonNullable<CaseState["emergencyClearance"]> }
  | { ok: true; clearance: null; notRequired: true; message: string }
  | { ok: false; status: number; code: string; error: string; details?: EmergencyClearanceRejectionDetails } {
  const unsignedState = { ...caseState, emergencyClearance: undefined };
  const gate = evaluateSafetyGate(unsignedState);
  if (gate.status !== "red_flag") {
    // 当前病历本就没有需要解除的红旗：无需排查确认，流程照常继续。原先返回 409，
    // 甲方 10/8 第一次调用就撞上（对一个没有红旗的病例调了本接口）。
    return {
      ok: true,
      clearance: null,
      notRequired: true,
      message: "当前病历没有需要解除的急危重症红旗，无需排查确认，可直接继续后续流程。",
    };
  }
  const explicitNames = [caseState.patient.name, caseState.hisRecord?.fields.patientName]
    .filter((value): value is string => Boolean(value?.trim()));
  const sanitizedSummary = sanitizeFreeTextForExternalClinicalService(assessmentSummary, explicitNames)
    .trim()
    .slice(0, 1_000);
  // 逐条留痕同样要过 PHI 脱敏：它会进病例留痕、可见正文与 HIS 方案。
  const activeFindings = activeEmergencyClearanceFindings(caseState);
  const inspected = inspectEmergencyClearanceAttestations(findings, activeFindings);
  const normalizedFindings = inspected.attestations?.map((item) => ({
    ...item,
    basis: sanitizeFreeTextForExternalClinicalService(item.basis, explicitNames).trim().slice(0, 500),
  }));
  const contractIssue = emergencyClearanceContractIssue({
    activeFindings,
    attestations: normalizedFindings,
    assessmentSummary: sanitizedSummary,
  });
  if (contractIssue) {
    const problems = contractIssue === "attestations_missing" ? inspected.problems : [];
    return {
      ok: false,
      status: 400,
      code: `emergency_clearance_${contractIssue}`,
      // 提交了 findings 但有条目不合规时，不再笼统地说「未提交」，而是逐处指出。
      error: problems.length > 0 && problems[0].index >= 0
        ? `处置记录有 ${problems.length} 处不合规：${problems.slice(0, 4).map((item) => `第 ${item.index + 1} 条 ${item.field}：${item.reason}`).join("；")}`
        : emergencyClearanceIssueMessage(contractIssue),
      details: {
        activeFindings: activeFindings.map((finding) => ({ ruleId: finding.ruleId, message: finding.message })),
        allowedDispositions: EMERGENCY_CLEARANCE_DISPOSITIONS.map((item) => ({ value: item.value, label: item.label, basisHint: item.basisHint })),
        problems,
      },
    };
  }
  const unsignedClearance = {
    redFlagFingerprint: redFlagClearanceFingerprint(gate),
    confirmedAt: new Date().toISOString(),
    assessmentSummary: sanitizedSummary,
    findings: normalizedFindings as EmergencyClearanceFindingAttestation[],
  };
  let contractSignature: string | undefined;
  try {
    contractSignature = signPayload(signaturePayload(caseState, unsignedClearance));
  } catch {
    contractSignature = undefined;
  }
  if (!contractSignature) {
    return {
      ok: false,
      status: 503,
      code: "emergency_clearance_signing_unavailable",
      error: "急症排查确认签名未配置，当前不能恢复常规诊疗。",
    };
  }
  return {
    ok: true,
    clearance: { ...unsignedClearance, contractSignature },
  };
}
