const CUSTOMER_DISPLAY_PLACEHOLDER = /(?:证据不足|待检索|待核验|检索失败|未配置|内部证据缺口|EVIDENCE_GAP)|^(?:暂未|尚未|仍未|未)(?:生成|形成|明确|获得|提供|记录|提及|完成)|^(?:待|需|需要)(?:生成|确认|补充|核实|核验|复核|完善|询问|评估)(?:相关|具体|本项|信息|资料|内容)?[。.]?$/;
const M03_SIGNATURE = /^hmac-sha256:[a-f0-9]{64}$/;

type SignedM03Like = {
  schemaVersion?: unknown;
  stage?: unknown;
  contractSignatureVersion?: unknown;
  contractSignature?: unknown;
  formula?: unknown;
};

/** UI-only placeholder filter. Server-side diagnosis contracts remain authoritative. */
export function isDisplayableClinicalText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !CUSTOMER_DISPLAY_PLACEHOLDER.test(value.trim());
}

/**
 * Lightweight client gate for reusing a server-signed M03 result.
 * This only recognizes the signed envelope; the server verifies the HMAC and clinical semantics.
 */
export function hasExecutableSignedM03(reasoning: SignedM03Like | null | undefined): boolean {
  return reasoning?.schemaVersion === "tcm-cdss-reasoning-v2" &&
    reasoning.stage === "diagnose" &&
    reasoning.formula == null &&
    reasoning.contractSignatureVersion === "tcm-cdss-m03-signature-v4" &&
    typeof reasoning.contractSignature === "string" &&
    M03_SIGNATURE.test(reasoning.contractSignature);
}
