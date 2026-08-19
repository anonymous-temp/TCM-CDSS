import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalizeForContractHash, clinicalReviewPayloadHash as clinicalReviewPayloadHashImpl, sha256CanonicalForContract } from "./clinical-review-binding";
import {
  normalizeCaseStateInput,
  normalizeReasoningV2,
  type CaseState,
  type ClinicalReasoningResultV2,
} from "./diagnosis-types";
import { sanitizeCaseStateForBrowserPersistence } from "./diagnosis-engine";

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";
export const DIAGNOSE_CONTRACT_SIGNATURE_VERSION = "tcm-cdss-m03-signature-v4" as const;
// v2：M04 nonPharma 的 monitoring(metric/timing/trigger) 三元组已替换为自由文本 precautions。
// 签名覆盖整个 normalize 后对象，字段集变化会让在途快照（浏览器 localStorage / 加密快照里已存在的
// prescribe reasoning）HMAC 不符。显式升版本号，让失效表现为可解释的「合同版本不匹配」而不是
// 难以定位的签名不符；两种情况都仍然 fail-closed 转人工复核，安全语义不变。
// M03 侧无此风险：M03 提示词模板固定输出 "nonPharma": null，签名载荷不变，
// DIAGNOSE_CONTRACT_SIGNATURE_VERSION 无需变动。
export const PRESCRIBE_CONTRACT_SIGNATURE_VERSION = "tcm-cdss-m04-signature-v2" as const;

export type DiagnoseContractSignatureContext = Readonly<{
  contractVersion: typeof DIAGNOSE_CONTRACT_SIGNATURE_VERSION;
  caseId: string;
  encounterId: string;
  customerId?: string;
  clinicalInputHash: `sha256:${string}`;
}>;

export type PrescribeContractSignatureContext = Readonly<{
  contractVersion: typeof PRESCRIBE_CONTRACT_SIGNATURE_VERSION;
  caseId: string;
  encounterId: string;
  customerId?: string;
  clinicalInputHash: `sha256:${string}`;
  diagnoseContractHash: `sha256:${string}`;
}>;

function signingKey(): string {
  return process.env.REASONING_CONTRACT_SIGNING_KEY || "";
}

export function reasoningContractSigningConfigured(): boolean {
  return signingKey().length >= 32;
}

// 规范化/哈希绑定实现迁至 clinical-review-binding.ts(无 server-only,读取侧可安全 import);
// 此处 re-export 保持既有引用不变。HMAC 规范化注释与不变量随实现一起迁移。
const canonicalize = canonicalizeForContractHash;
const sha256Canonical = sha256CanonicalForContract;
export { clinicalReviewPayloadHash, hasBoundClinicalReviewAttestation } from "./clinical-review-binding";
import { hasBoundClinicalReviewAttestation as hasBoundClinicalReviewAttestationImpl } from "./clinical-review-binding";

function bindClinicalReviewAttestation(reasoning: ClinicalReasoningResultV2): ClinicalReasoningResultV2 {
  const reviewedPayloadHash = clinicalReviewPayloadHashImpl(reasoning);
  if (!reviewedPayloadHash) throw new Error("Cannot bind clinical review to an invalid reasoning contract");
  return {
    ...reasoning,
    clinicalReview: {
      ...(reasoning.clinicalReview || { status: "unavailable" as const }),
      reviewedPayloadHash,
    },
  };
}

function clinicalInputSnapshot(caseState: CaseState): unknown {
  const hisFields = caseState.hisRecord
    ? Object.fromEntries(Object.entries(caseState.hisRecord.fields).filter(([key]) => key !== "patientName"))
    : undefined;
  const faceCapture = caseState.faceCapture
    ? Object.fromEntries(Object.entries(caseState.faceCapture).filter(([key]) => key !== "updatedAt"))
    : undefined;

  return {
    patient: {
      sex: caseState.patient.sex,
      age: caseState.patient.age,
      occupation: caseState.patient.occupation,
    },
    chiefComplaint: caseState.chiefComplaint,
    symptoms: caseState.symptoms,
    tongue: caseState.tongue,
    pulse: caseState.pulse,
    faceNote: caseState.faceNote,
    tongueImageDesc: caseState.tongueImageDesc,
    tongueDx: caseState.tongueDx,
    faceCapture,
    vitals: caseState.vitals,
    pastHistory: caseState.pastHistory,
    medicationHistory: caseState.medicationHistory,
    allergyHistory: caseState.allergyHistory,
    tcmLineagePreference: caseState.tcmLineagePreference,
    hisRecord: caseState.hisRecord
      ? {
          schemaVersion: caseState.hisRecord.schemaVersion,
          source: caseState.hisRecord.source,
          tongueImageUploaded: caseState.hisRecord.tongueImageUploaded,
          fields: hisFields,
          rawText: caseState.hisRecord.rawText,
        }
      : undefined,
    // Only clinician/user supplied statements are clinical input. Assistant questions, derived
    // completeness, phase, retry counters and soft-gate choices are workflow state and may change
    // during an idempotent M04 retry without changing the facts M03 was signed against.
    conversation: caseState.conversation.filter((message) => message.role === "user"),
  };
}

export function buildDiagnoseContractSignatureContext(caseState: CaseState): DiagnoseContractSignatureContext {
  if (!caseState.id?.trim()) throw new Error("Cannot sign M03 without a current case ID");
  const normalized = normalizeCaseStateInput(caseState);
  if (!normalized) throw new Error("Cannot sign M03 with an invalid clinical input snapshot");
  const caseId = normalized.id.trim();
  const encounterId = (normalized.hisRecord?.caseId || caseId).trim();
  if (!caseId || !encounterId) throw new Error("Cannot sign M03 without current case and encounter IDs");
  // Browser recovery deliberately removes explicit identity data from free clinical text. Hash the
  // same deterministic de-identified representation so a pure PHI-redaction round trip does not
  // invalidate M03, while case/encounter IDs remain independently bound by the HMAC payload.
  const deidentified = sanitizeCaseStateForBrowserPersistence(normalized);
  const clinicalInputHash = `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(clinicalInputSnapshot(deidentified))))
    .digest("hex")}` as const;
  return {
    contractVersion: DIAGNOSE_CONTRACT_SIGNATURE_VERSION,
    caseId,
    encounterId,
    ...(normalized.customerId ? { customerId: normalized.customerId } : {}),
    clinicalInputHash,
  };
}

export function buildPrescribeContractSignatureContext(caseState: CaseState): PrescribeContractSignatureContext {
  const diagnose = normalizeReasoningV2(
    caseState.reasoningDiagnose || (caseState.reasoningV2?.stage === "diagnose" ? caseState.reasoningV2 : undefined),
  );
  if (!diagnose || !verifyDiagnoseReasoningSignature(diagnose, caseState)) {
    throw new Error("Cannot sign M04 without a valid current M03 contract");
  }
  const diagnoseContext = buildDiagnoseContractSignatureContext(caseState);
  return {
    contractVersion: PRESCRIBE_CONTRACT_SIGNATURE_VERSION,
    caseId: diagnoseContext.caseId,
    encounterId: diagnoseContext.encounterId,
    ...(diagnoseContext.customerId ? { customerId: diagnoseContext.customerId } : {}),
    clinicalInputHash: diagnoseContext.clinicalInputHash,
    diagnoseContractHash: sha256Canonical({
      reasoning: diagnose,
      diagnoseSignature: diagnose.contractSignature,
    }),
  };
}

function validContext(context: DiagnoseContractSignatureContext): boolean {
  return context.contractVersion === DIAGNOSE_CONTRACT_SIGNATURE_VERSION &&
    context.caseId.trim().length > 0 &&
    context.encounterId.trim().length > 0 &&
    /^sha256:[a-f0-9]{64}$/.test(context.clinicalInputHash);
}

function validPrescribeContext(context: PrescribeContractSignatureContext): boolean {
  return context.contractVersion === PRESCRIBE_CONTRACT_SIGNATURE_VERSION &&
    context.caseId.trim().length > 0 &&
    context.encounterId.trim().length > 0 &&
    /^sha256:[a-f0-9]{64}$/.test(context.clinicalInputHash) &&
    /^sha256:[a-f0-9]{64}$/.test(context.diagnoseContractHash);
}

function contractPayload(
  reasoning: ClinicalReasoningResultV2,
  context: DiagnoseContractSignatureContext,
): unknown {
  return {
    contractVersion: context.contractVersion,
    binding: {
      caseId: context.caseId,
      encounterId: context.encounterId,
      clinicalInputHash: context.clinicalInputHash,
    },
    // Sign the complete Zod-normalized M03 contract. This intentionally includes fields that M04
    // does not currently read so a future consumer cannot turn a previously unsigned field into a
    // trust-boundary bypass without rotating the contract version.
    reasoning,
  };
}

function signatureFor(
  reasoning: ClinicalReasoningResultV2,
  context: DiagnoseContractSignatureContext,
): string | undefined {
  const key = signingKey();
  if (key.length < 32 || reasoning.stage !== "diagnose" || !validContext(context)) return undefined;
  const payload = JSON.stringify(canonicalize(contractPayload(reasoning, context)));
  return `hmac-sha256:${createHmac("sha256", key).update(payload).digest("hex")}`;
}

export function signDiagnoseReasoning(
  reasoning: ClinicalReasoningResultV2,
  context: DiagnoseContractSignatureContext,
): ClinicalReasoningResultV2 {
  const normalized = normalizeReasoningV2(reasoning);
  if (!normalized || normalized.stage !== "diagnose") {
    throw new Error("Cannot sign an invalid M03 reasoning contract");
  }
  const versioned = bindClinicalReviewAttestation({
    ...normalized,
    contractSignatureVersion: DIAGNOSE_CONTRACT_SIGNATURE_VERSION,
    contractSignature: undefined,
  });
  const contractSignature = signatureFor(versioned, context);
  if (!contractSignature) throw new Error("REASONING_CONTRACT_SIGNING_KEY is not configured");
  return { ...versioned, contractSignature };
}

export function verifyDiagnoseReasoningSignature(
  reasoning: ClinicalReasoningResultV2 | null | undefined,
  currentCaseState: CaseState,
): boolean {
  const normalized = normalizeReasoningV2(reasoning);
  if (!normalized ||
    normalized.stage !== "diagnose" ||
    normalized.contractSignatureVersion !== DIAGNOSE_CONTRACT_SIGNATURE_VERSION ||
    typeof normalized.contractSignature !== "string" ||
    !hasBoundClinicalReviewAttestationImpl(normalized)) return false;
  let context: DiagnoseContractSignatureContext;
  try {
    context = buildDiagnoseContractSignatureContext(currentCaseState);
  } catch {
    return false;
  }
  const expected = signatureFor(normalized, context);
  if (!expected) return false;
  const actualBuffer = Buffer.from(normalized.contractSignature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function applyDiagnoseContractSignature(
  content: string,
  context: DiagnoseContractSignatureContext,
): string {
  const start = content.lastIndexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  const rawReasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as unknown;
  const reasoning = normalizeReasoningV2(rawReasoning);
  if (!reasoning || reasoning.stage !== "diagnose") {
    throw new Error("Cannot sign an invalid M03 reasoning contract");
  }
  // Sign the exact normalized shape that request parsing will later verify. Provider JSON may use
  // null for optional fields; Zod canonicalizes those to undefined, which would otherwise change
  // the HMAC payload after a browser round trip despite identical clinical meaning.
  const signed = signDiagnoseReasoning(reasoning, context);
  return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(signed, null, 2)}\n${content.slice(end)}`;
}

function prescribeSignatureFor(
  reasoning: ClinicalReasoningResultV2,
  context: PrescribeContractSignatureContext,
): string | undefined {
  const key = signingKey();
  if (key.length < 32 || reasoning.stage !== "prescribe" || !validPrescribeContext(context)) return undefined;
  const payload = JSON.stringify(canonicalize({
    contractVersion: context.contractVersion,
    binding: {
      caseId: context.caseId,
      encounterId: context.encounterId,
      clinicalInputHash: context.clinicalInputHash,
      diagnoseContractHash: context.diagnoseContractHash,
    },
    reasoning,
  }));
  return `hmac-sha256:${createHmac("sha256", key).update(payload).digest("hex")}`;
}

export function signPrescribeReasoning(
  reasoning: ClinicalReasoningResultV2,
  context: PrescribeContractSignatureContext,
): ClinicalReasoningResultV2 {
  const normalized = normalizeReasoningV2(reasoning);
  if (!normalized || normalized.stage !== "prescribe") {
    throw new Error("Cannot sign an invalid M04 reasoning contract");
  }
  const versioned = bindClinicalReviewAttestation({
    ...normalized,
    contractSignatureVersion: PRESCRIBE_CONTRACT_SIGNATURE_VERSION,
    contractSignature: undefined,
  });
  const contractSignature = prescribeSignatureFor(versioned, context);
  if (!contractSignature) throw new Error("REASONING_CONTRACT_SIGNING_KEY is not configured");
  return { ...versioned, contractSignature };
}

export function verifyPrescribeReasoningSignature(
  reasoning: ClinicalReasoningResultV2 | null | undefined,
  currentCaseState: CaseState,
): boolean {
  const normalized = normalizeReasoningV2(reasoning);
  if (!normalized ||
    normalized.stage !== "prescribe" ||
    normalized.contractSignatureVersion !== PRESCRIBE_CONTRACT_SIGNATURE_VERSION ||
    typeof normalized.contractSignature !== "string" ||
    !hasBoundClinicalReviewAttestationImpl(normalized)) return false;
  let context: PrescribeContractSignatureContext;
  try {
    context = buildPrescribeContractSignatureContext(currentCaseState);
  } catch {
    return false;
  }
  const expected = prescribeSignatureFor(normalized, context);
  if (!expected) return false;
  const actualBuffer = Buffer.from(normalized.contractSignature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function applyPrescribeContractSignature(
  content: string,
  context: PrescribeContractSignatureContext,
): string {
  const start = content.lastIndexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  const reasoning = normalizeReasoningV2(JSON.parse(content.slice(start + START_MARKER.length, end).trim()));
  if (!reasoning || reasoning.stage !== "prescribe") {
    throw new Error("Cannot sign an invalid M04 reasoning contract");
  }
  const signed = signPrescribeReasoning(reasoning, context);
  return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(signed, null, 2)}\n${content.slice(end)}`;
}
