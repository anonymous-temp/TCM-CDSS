import { createHash } from "node:crypto";
import { normalizeReasoningV2 } from "./diagnosis-types";

/**
 * 临床复核 attestation 的载荷哈希绑定(不含任何签名密钥,与 server-only 的签名模块分离):
 * his-scheme 等读取侧只需要"这份 attestation 是否绑定当前载荷",不需要也不应该拿到签名能力。
 * 规范化序列化与 reasoning-contract-signature 保持逐字节一致(它 import 本模块)。
 */
export function canonicalizeForContractHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForContractHash);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "contractSignature")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, canonicalizeForContractHash(item)]));
}

export function sha256CanonicalForContract(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalizeForContractHash(value))).digest("hex")}`;
}

export function clinicalReviewPayloadHash(reasoning: unknown): `sha256:${string}` | undefined {
  const normalized = normalizeReasoningV2(reasoning);
  if (!normalized) return undefined;
  return sha256CanonicalForContract({
    ...normalized,
    contractSignatureVersion: undefined,
    contractSignature: undefined,
    clinicalReview: undefined,
  });
}

export function hasBoundClinicalReviewAttestation(reasoning: unknown): boolean {
  const normalized = normalizeReasoningV2(reasoning);
  const attestation = normalized?.clinicalReview;
  const expected = clinicalReviewPayloadHash(normalized);
  if (!normalized || !attestation || !expected || attestation.reviewedPayloadHash !== expected) return false;
  if (attestation.status === "accepted") {
    return Boolean(attestation.provider?.trim() && attestation.model?.trim() && attestation.source);
  }
  return attestation.status === "unavailable";
}
