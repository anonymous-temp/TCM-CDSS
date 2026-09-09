import "server-only";
import type { CaseState } from "./diagnosis-types";
import { prescribeReasoningFromState, stripDiagnosisJSON } from "./diagnosis-parse";
import { sectionTitleGroup } from "./cdss-vocab";
import { deriveCaseWarningProfile, type ClinicalWarningProfile } from "./clinical-warning-tier";
import { prescribeWarningTextProjection } from "./diagnosis-visible-summary";
import { medicineCandidateRow } from "./medicine-rendering";
import { localLabelRiskProjection } from "./medicine-reference-projection.server";
import { matchedWarningText, type OwnedCaseWarningProjection, type WarningTextProjection } from "./warning-text-projection";
import { isSafetyClinicalDeliveryAdvisory, type ClinicalDeliveryAdvisory } from "./clinical-delivery-advisory";

/** Only a server producer calls this after validating the current clinical artifact. No request
 * property, display receipt or model-authored role can supply this internal projection. */
export function projectPrescriptionWarningText(state: CaseState): WarningTextProjection {
  const markdown = state.prescription || "";
  const prescribed = prescribeReasoningFromState(state);
  const visible = stripDiagnosisJSON(markdown);
  const canonical = prescribed ? [state, null].map((context) =>
    prescribeWarningTextProjection(prescribed as unknown as Record<string, unknown>, context)) : [];
  const matched = canonical.find((item) => item.markdown.trim() === visible.trim());
  const current = matched ? matched.currentRiskMarkdown : visible;
  const consumedRows = new Set<number>();
  const rows = new Map((prescribed?.formula?.patentAndWestern || []).flatMap((item, index) => {
    const risk = localLabelRiskProjection(item);
    return risk == null ? [] : [state, undefined].map((context) => [medicineCandidateRow(item, context),
      { index, projected: medicineCandidateRow(item, context, risk) }] as const);
  }));
  let medicineDomain = false;
  const currentRiskMarkdown = current.split(/\r?\n/).map((line) => {
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) medicineDomain = heading[1] === "##" && sectionTitleGroup("westernOrPatent").includes(heading[2]);
    const row = rows.get(line);
    if (medicineDomain && row && !consumedRows.has(row.index)) {
      consumedRows.add(row.index);
      return row.projected;
    }
    return line;
  }).join("\n");
  return { markdown, currentRiskMarkdown };
}

export function deriveOwnedCaseWarningProfile(
  state: CaseState,
  owned?: OwnedCaseWarningProjection,
  advisories: readonly ClinicalDeliveryAdvisory[] = [],
): ClinicalWarningProfile {
  const profile = deriveCaseWarningProfile({
    ...state,
    prescription: owned?.prescription
      ? matchedWarningText(state.prescription, owned.prescription)
      : projectPrescriptionWarningText(state).currentRiskMarkdown,
    riskAssessment: matchedWarningText(state.riskAssessment, owned?.riskAssessment),
  });
  const safety = advisories.filter(isSafetyClinicalDeliveryAdvisory);
  return safety.length === 0 ? profile : {
    level: "L4", label: "确定性阻断", action: "non_executable", executable: false,
    reasons: [...new Set([...profile.reasons, ...safety.map((item) => item.message)])].slice(0, 8),
  };
}
