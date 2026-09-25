// 已删除的灵犀审方集成留在线上的**冻结词表**（owner 裁定 2026-09-25：审方永不启用）。
//
// 审方模块删掉了，但它在对外输出里的痕迹是契约的一部分：M05 流里的状态/相关性注释标记、
// post-prescription-risk 与 HIS 响应里的 auditCorrelation、工作台跳过收据的
// auditReason:"rxaudit_disabled"——外部集成方按对外接口文档读取这些取值，签名收据也绑定它们。
// 生产一直是显式停用档，下面的取值就是那一档逐字节的输出，不得改名或改值。

/** 跳过收据与相关性元数据里的固定原因码（diagnosis-types 的修订收据 schema 也按它校验）。 */
export const RXAUDIT_DISABLED_REASON = "rxaudit_disabled";

export type RxAuditStreamStatus = {
  available: boolean;
  reason?: "no_prescription_items" | "service_unavailable";
  /**
   * 审方不属于本产品面（先是 owner 裁定 2026-08-28 的独立交付，后于 2026-09-25 整体删除）。
   * 这与「审方不可用」是两回事：不可用要提示医生别把沉默当无风险，而这里审方压根不存在，
   * 提示它反而是噪声。服务端现在只产出这一档；AVAILABLE/UNAVAILABLE 的解析保留给旧会话里
   * 已落盘的流文本。
   */
  presentationDisabled?: boolean;
};

const STATUS_MARKER = /<!--\s*TCM_CDSS_RXAUDIT_STATUS:([A-Z_]+)(?::([A-Z_]+))?\s*-->/i;

/** M05 流首部的状态标记：审方不在本产品面。 */
export const RXAUDIT_DISABLED_STATUS_MARKER = "<!-- TCM_CDSS_RXAUDIT_STATUS:DISABLED -->";

export function parseRxAuditStatusMarker(content: string): RxAuditStreamStatus | undefined {
  const match = content.match(STATUS_MARKER);
  if (!match) return undefined;
  const state = match[1].toUpperCase();
  if (state === "DISABLED") return { available: false, presentationDisabled: true };
  if (state === "AVAILABLE") return { available: true };
  if (state !== "UNAVAILABLE") return undefined;
  return {
    available: false,
    reason: match[2]?.toUpperCase() === "NO_PRESCRIPTION_ITEMS"
      ? "no_prescription_items"
      : "service_unavailable",
  };
}

export function stripRxAuditStatusMarker(content: string): string {
  return content.replace(STATUS_MARKER, "").replace(/^\s+/, "");
}

/** 对外 auditCorrelation 的形状与键序（JSON 逐字节，勿重排）。 */
export type SkippedRxAuditCorrelation = {
  provider: "lingxi-rxaudit";
  providerAvailable: false;
  providerReason: typeof RXAUDIT_DISABLED_REASON;
  candidateIndex?: number;
  prescriptionHash?: string;
  auditedAt: string;
};

export function skippedRxAuditCorrelation(input: {
  candidateIndex?: number;
  prescriptionHash?: string;
  auditedAt?: string;
}): SkippedRxAuditCorrelation {
  return {
    provider: "lingxi-rxaudit",
    providerAvailable: false,
    providerReason: RXAUDIT_DISABLED_REASON,
    ...(input.candidateIndex != null ? { candidateIndex: input.candidateIndex } : {}),
    ...(input.prescriptionHash ? { prescriptionHash: input.prescriptionHash } : {}),
    auditedAt: input.auditedAt || new Date().toISOString(),
  };
}

/** M05 流里的相关性注释标记（与 HIS/改方接口的 auditCorrelation 同一份元数据）。 */
export function skippedRxAuditCorrelationMarker(correlation: SkippedRxAuditCorrelation): string {
  return `<!-- TCM_CDSS_RXAUDIT_CORRELATION:${encodeURIComponent(JSON.stringify(correlation))} -->`;
}
