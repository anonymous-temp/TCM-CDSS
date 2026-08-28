export type RxAuditStreamStatus = {
  available: boolean;
  reason?: "no_prescription_items" | "service_unavailable";
  /**
   * 合理用药审方是**独立交付的接口与产品页面**（owner 裁定 2026-08-28）。它单独交付时，
   * CDSS 侧不再重复呈现任何三方审方内容——既不出审方结论，也不出「自动审方未完成」这类
   * 以审方为主语的状态。这与「审方不可用」是两回事：不可用要提示医生别把沉默当无风险，
   * 而这里审方压根不属于本产品面，提示它反而是噪声。两者必须能被下游区分，故单列一档。
   *
   * 边界：本开关只管**呈现**。本地确定性检测（十八反十九畏、药典剂量边界、特殊人群）
   * 与 M05 确定性安全总评都不受它影响，照常生成、照常展示。
   */
  presentationDisabled?: boolean;
};

const STATUS_MARKER = /<!--\s*TCM_CDSS_RXAUDIT_STATUS:([A-Z_]+)(?::([A-Z_]+))?\s*-->/i;

export function buildRxAuditStatusMarker(status: RxAuditStreamStatus): string {
  if (status.presentationDisabled) return "<!-- TCM_CDSS_RXAUDIT_STATUS:DISABLED -->";
  if (status.available) return "<!-- TCM_CDSS_RXAUDIT_STATUS:AVAILABLE -->";
  const reason = status.reason === "no_prescription_items" ? "NO_PRESCRIPTION_ITEMS" : "SERVICE_UNAVAILABLE";
  return `<!-- TCM_CDSS_RXAUDIT_STATUS:UNAVAILABLE:${reason} -->`;
}

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
