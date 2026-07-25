import { highImpactHerbDirectionIssue } from "./diagnosis-stage-contract";
import type { ClinicalReasoningResultV2 } from "./diagnosis-types";

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";
const MODIFICATION_ADDITION = /(?:^|时|则|可|建议)(?:加入|加用|新增|加)([\u4e00-\u9fa5]{1,8})/;

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Conditional modifications are optional decision support, not part of the current audited dose
 * candidate. The proposal compiler already drops an `add` row whose herb introduces a high-impact
 * direction absent from signed M03. Providers can nevertheless return a legacy full reasoning-v2
 * envelope, so apply the same invariant to every completed M04 envelope before review/signing.
 *
 * Only the unsupported optional row is removed. The candidate prescription and every other field
 * remain unchanged and still pass the complete M04 contract, independent review and external audit.
 */
export function dropUnsupportedM04ModificationDirections(
  content: string,
  prior: ClinicalReasoningResultV2 | null | undefined,
): string {
  if (!prior || prior.stage !== "diagnose") return content;
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    const formula = recordValue(reasoning.formula);
    const modifications = formula?.modifications;
    if (!formula || !Array.isArray(modifications) || modifications.length === 0) return content;
    const retained = modifications.filter((value) => {
      const modification = recordValue(value);
      if (!modification) return true;
      const action = typeof modification.action === "string" ? modification.action.trim().replace(/\s/g, "") : "";
      const addition = action.match(MODIFICATION_ADDITION);
      if (!addition) return true;
      const declaredDirection = [modification.reason, modification.targetPathogenesis]
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        .join("；");
      return !highImpactHerbDirectionIssue(addition[1], declaredDirection, prior);
    });
    if (retained.length === modifications.length) return content;
    formula.modifications = retained;
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}
