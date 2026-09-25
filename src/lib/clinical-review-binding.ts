import { createHash } from "node:crypto";
import { normalizeReasoningV2, type ClinicalReviewAttestation } from "./diagnosis-types";

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

/**
 * 签名载荷里 `clinicalReview` 的**唯一**取值（模型复核环节已于 2026-09-16 移除，owner 裁定）。
 *
 * 对外契约保持不变：status=unavailable / unavailableReason=not_configured / attemptCount=0 /
 * durationMs=0，reviewedPayloadHash 绑定到这份载荷——hasBoundClinicalReviewAttestation 本就接受
 * unavailable，签名、HIS 与交付连续性都读同一个谓词。键的顺序与移除前的 attestation 逐字相同
 * （签名覆盖的是序列化字节）。
 */
export function clinicalReviewNotPerformedAttestation(reasoning: unknown): ClinicalReviewAttestation {
  const reviewedPayloadHash = clinicalReviewPayloadHash(reasoning);
  return {
    status: "unavailable",
    unavailableReason: "not_configured",
    attemptCount: 0,
    durationMs: 0,
    ...(reviewedPayloadHash ? { reviewedPayloadHash } : {}),
  };
}
