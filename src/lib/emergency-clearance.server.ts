import { createHmac, timingSafeEqual } from "node:crypto";
import type { CaseState } from "./diagnosis-types";
import {
  evaluateSafetyGate,
  redFlagClearanceFingerprint,
  sanitizeFreeTextForExternalClinicalService,
} from "./diagnosis-safety";

export const EMERGENCY_CLEARANCE_SIGNATURE_VERSION = "tcm-cdss-emergency-clearance-v1" as const;

function signingKey(): string {
  return process.env.REASONING_CONTRACT_SIGNING_KEY?.trim() || "";
}

function signaturePayload(
  caseState: Pick<CaseState, "id">,
  clearance: Omit<NonNullable<CaseState["emergencyClearance"]>, "contractSignature">,
): string {
  return JSON.stringify({
    version: EMERGENCY_CLEARANCE_SIGNATURE_VERSION,
    caseId: caseState.id,
    redFlagFingerprint: clearance.redFlagFingerprint,
    confirmedAt: clearance.confirmedAt,
    assessmentSummary: clearance.assessmentSummary,
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
  const expected = signPayload(signaturePayload(caseState, {
    redFlagFingerprint: clearance.redFlagFingerprint,
    confirmedAt: clearance.confirmedAt,
    assessmentSummary: clearance.assessmentSummary,
  }));
  if (!expected) return false;
  const actualBytes = Buffer.from(clearance.contractSignature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function stripInvalidEmergencyClearance(caseState: CaseState): CaseState {
  if (!caseState.emergencyClearance || verifyEmergencyClearance(caseState)) return caseState;
  return { ...caseState, emergencyClearance: undefined };
}

export function issueEmergencyClearance(
  caseState: CaseState,
  assessmentSummary: string,
):
  | { ok: true; clearance: NonNullable<CaseState["emergencyClearance"]> }
  | { ok: false; status: number; code: string; error: string } {
  const unsignedState = { ...caseState, emergencyClearance: undefined };
  const gate = evaluateSafetyGate(unsignedState);
  if (gate.status !== "red_flag") {
    return {
      ok: false,
      status: 409,
      code: "no_active_emergency_finding",
      error: "当前病历没有可绑定的急危重症红旗，未生成排查确认。",
    };
  }
  const explicitNames = [caseState.patient.name, caseState.hisRecord?.fields.patientName]
    .filter((value): value is string => Boolean(value?.trim()));
  const sanitizedSummary = sanitizeFreeTextForExternalClinicalService(assessmentSummary, explicitNames)
    .trim()
    .slice(0, 1_000);
  if (sanitizedSummary.length < 12) {
    return {
      ok: false,
      status: 400,
      code: "emergency_assessment_too_short",
      error: "请记录至少 12 个字的现场评估或急诊排查结果。",
    };
  }
  const unsignedClearance = {
    redFlagFingerprint: redFlagClearanceFingerprint(gate),
    confirmedAt: new Date().toISOString(),
    assessmentSummary: sanitizedSummary,
  };
  const contractSignature = signPayload(signaturePayload(caseState, unsignedClearance));
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
