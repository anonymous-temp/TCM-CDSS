/** Roles are assigned by producers, never by model/request JSON. Display bytes stay untouched. */
export type AdviceText = Readonly<{ kind: "advice"; text: string }>;
export type WarningTextProjection = Readonly<{ markdown: string; currentRiskMarkdown: string }>;
export type OwnedCaseWarningProjection = Readonly<{
  prescription?: WarningTextProjection;
  riskAssessment?: WarningTextProjection;
  audit?: Readonly<{
    auditResult: "PASS" | "REMIND" | "MANUAL_REVIEW" | "BLOCK";
    highestRiskLevel: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    auditAvailable: boolean;
    needManualReview?: boolean;
  }>;
  /** Private server producer fact. No CaseState field may select this projection. */
  auditSkipped?: boolean;
  /** Fresh enriched server facts can strengthen the profile without entering client material. */
  floor?: import("./clinical-warning-tier").ClinicalWarningProfile;
}>;

export function adviceText(text: string): AdviceText { return { kind: "advice", text }; }

export function joinWarningText(parts: readonly (string | AdviceText)[]): WarningTextProjection {
  return {
    markdown: parts.map((part) => typeof part === "string" ? part : part.text).join("\n"),
    currentRiskMarkdown: parts.map((part) => typeof part === "string" ? part : "").join("\n"),
  };
}

export function mapWarningText(projection: WarningTextProjection, transform: (text: string) => string): WarningTextProjection {
  return { markdown: transform(projection.markdown), currentRiskMarkdown: transform(projection.currentRiskMarkdown) };
}

export function joinedWarningProjections(parts: readonly (string | WarningTextProjection)[], separator = "\n\n"): WarningTextProjection {
  return {
    markdown: parts.map((part) => typeof part === "string" ? part : part.markdown).join(separator),
    currentRiskMarkdown: parts.map((part) => typeof part === "string" ? part : part.currentRiskMarkdown).join(separator),
  };
}

export function matchedWarningText(display: string | undefined, projection?: WarningTextProjection): string {
  return projection?.markdown === (display || "") ? projection.currentRiskMarkdown : display || "";
}
