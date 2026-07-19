export type RxAuditStreamStatus = {
  available: boolean;
  reason?: "no_prescription_items" | "service_unavailable";
};

const STATUS_MARKER = /<!--\s*TCM_CDSS_RXAUDIT_STATUS:([A-Z_]+)(?::([A-Z_]+))?\s*-->/i;

export function buildRxAuditStatusMarker(status: RxAuditStreamStatus): string {
  if (status.available) return "<!-- TCM_CDSS_RXAUDIT_STATUS:AVAILABLE -->";
  const reason = status.reason === "no_prescription_items" ? "NO_PRESCRIPTION_ITEMS" : "SERVICE_UNAVAILABLE";
  return `<!-- TCM_CDSS_RXAUDIT_STATUS:UNAVAILABLE:${reason} -->`;
}

export function parseRxAuditStatusMarker(content: string): RxAuditStreamStatus | undefined {
  const match = content.match(STATUS_MARKER);
  if (!match) return undefined;
  if (match[1].toUpperCase() === "AVAILABLE") return { available: true };
  if (match[1].toUpperCase() !== "UNAVAILABLE") return undefined;
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
