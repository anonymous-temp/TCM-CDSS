export type RxAuditResultCode = "PASS" | "REMIND" | "MANUAL_REVIEW" | "BLOCK";
export type RxAuditRiskLevel = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

const RX_AUDIT_RESULTS = new Set<RxAuditResultCode>(["PASS", "REMIND", "MANUAL_REVIEW", "BLOCK"]);
const RX_AUDIT_RISK_LEVELS = new Set<RxAuditRiskLevel>(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const RX_AUDIT_RISK_ORDER: Record<RxAuditRiskLevel, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function normalizedEnumText(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function normalizeAuditResult(value: unknown): RxAuditResultCode {
  const normalized = normalizedEnumText(value);
  return RX_AUDIT_RESULTS.has(normalized as RxAuditResultCode)
    ? normalized as RxAuditResultCode
    : "MANUAL_REVIEW";
}

export function normalizeRiskLevel(value: unknown, fallback: RxAuditRiskLevel = "HIGH"): RxAuditRiskLevel {
  const normalized = normalizedEnumText(value);
  return RX_AUDIT_RISK_LEVELS.has(normalized as RxAuditRiskLevel)
    ? normalized as RxAuditRiskLevel
    : fallback;
}

function highestRiskLevel(...levels: RxAuditRiskLevel[]): RxAuditRiskLevel {
  return levels.reduce((highest, current) =>
    RX_AUDIT_RISK_ORDER[current] > RX_AUDIT_RISK_ORDER[highest] ? current : highest
  , "INFO");
}

export function normalizeLingxiDecision(input: {
  auditResult: unknown;
  highestRiskLevel: unknown;
  issueRiskLevels?: unknown[];
  issueCount?: number;
  needManualReview?: unknown;
}): {
  auditResult: RxAuditResultCode;
  highestRiskLevel: RxAuditRiskLevel;
  needManualReview: boolean;
} {
  const rawAuditResult = normalizedEnumText(input.auditResult);
  const rawHighestRisk = normalizedEnumText(input.highestRiskLevel);
  const resultEnumValid = RX_AUDIT_RESULTS.has(rawAuditResult as RxAuditResultCode);
  const riskEnumValid = RX_AUDIT_RISK_LEVELS.has(rawHighestRisk as RxAuditRiskLevel);
  const normalizedResult = normalizeAuditResult(rawAuditResult);
  const issueRisk = (input.issueRiskLevels || []).reduce<RxAuditRiskLevel>(
    (highest, risk) => highestRiskLevel(highest, normalizeRiskLevel(risk, "HIGH")),
    "INFO",
  );
  const normalizedHighestRisk = highestRiskLevel(normalizeRiskLevel(rawHighestRisk, "HIGH"), issueRisk);
  const contradictoryPass = normalizedResult === "PASS" && (
    (input.issueCount || 0) > 0 || !["INFO", "LOW"].includes(normalizedHighestRisk)
  );
  // This is a safety-significant provider field. A type drift such as "true", 1, or an
  // object is not equivalent to false; preserve the warning by failing closed.
  const manualReviewFlagInvalid = input.needManualReview !== undefined && typeof input.needManualReview !== "boolean";
  const forceManualReview =
    !resultEnumValid ||
    !riskEnumValid ||
    contradictoryPass ||
    manualReviewFlagInvalid ||
    normalizedResult === "MANUAL_REVIEW" ||
    input.needManualReview === true;

  return {
    auditResult: forceManualReview ? "MANUAL_REVIEW" : normalizedResult,
    highestRiskLevel: normalizedHighestRisk,
    needManualReview: forceManualReview,
  };
}
