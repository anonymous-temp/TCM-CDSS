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

/**
 * 复核执行元信息 → attestation 上的**不可用原因码**。
 *
 * 单独导出成谓词，是因为这段逻辑此前根本不存在：diagnosis-api 的
 * ClinicalReviewExecutionMeta.reason 一直算着 not_configured / deadline / invalid_contract /
 * http_error / transport_error 五种失败，但 clinicalReviewAttestation() 只取 status 就返回，
 * **算出来即丢弃**——与同文件里 independentFromGenerator 曾经的毛病同形。
 *
 * 实测后果（TCMEval-SDT 194 例）：18 例 status=unavailable，均分 13.48%
 * 而 accepted 组 20.34%；attestation 里只有 status 与 reviewedPayloadHash，
 * 无法区分这 18 例是超时、上游报错、契约不合法还是压根没配置。
 * 「列为生产降级项」这句话没有原因码就无从下手，有限重试与跨提供方兜底也无从设计。
 *
 * 两条边界：
 *  · accepted / repair 不是失败，一律不产出原因码；
 *  · status=accepted 时即便带着 reason 也不产出——原因码只描述不可用。
 */
export type ClinicalReviewUnavailableReason =
  | "not_configured" | "deadline" | "invalid_contract" | "http_error" | "transport_error";

const UNAVAILABLE_REASONS = new Set<string>([
  "not_configured", "deadline", "invalid_contract", "http_error", "transport_error",
]);

export function clinicalReviewUnavailableReason(
  status: "accepted" | "unavailable",
  executionReason: string | undefined,
): ClinicalReviewUnavailableReason | undefined {
  if (status !== "unavailable") return undefined;
  if (!executionReason || !UNAVAILABLE_REASONS.has(executionReason)) return undefined;
  return executionReason as ClinicalReviewUnavailableReason;
}
