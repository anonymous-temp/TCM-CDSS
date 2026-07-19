// src/lib/diagnosis-parse.ts
import type { CaseState, ClinicalReasoningResultV2, Completeness } from "./diagnosis-types";
import { CompletenessSchema, normalizeReasoningV2 } from "./diagnosis-types";

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

/**
 * Extract structured JSON embedded in streaming Markdown via sentinel markers.
 * Returns null if markers not found or JSON is malformed.
 */
export function extractDiagnosisJSON(content: string): Record<string, unknown> | null {
  const startIdx = content.indexOf(START_MARKER);
  if (startIdx === -1 || content.indexOf(START_MARKER, startIdx + START_MARKER.length) !== -1) return null;
  const endIdx = content.indexOf(END_MARKER, startIdx);
  if (endIdx === -1 || content.indexOf(END_MARKER, endIdx + END_MARKER.length) !== -1) return null;
  if (content.slice(endIdx + END_MARKER.length).trim()) return null;
  const jsonStr = content.slice(startIdx + START_MARKER.length, endIdx).trim();
  try {
    return JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Strip sentinel markers, the "第三部分：结构化JSON" heading, and embedded JSON
 * from content before display.
 * Preserves any content that appears after the END_MARKER (e.g. safety disclaimers).
 */
export function stripDiagnosisJSON(content: string): string {
  let result = content;
  // Strip EVERY sentinel block, not just the first — a duplicated/echoed block must never leak raw
  // HTML-comment-wrapped JSON into the doctor-facing text.
  let startIdx = result.indexOf(START_MARKER);
  while (startIdx !== -1) {
    const endIdx = result.indexOf(END_MARKER, startIdx);
    if (endIdx === -1) {
      // Unterminated (truncated) block — drop everything from the marker onward.
      result = result.slice(0, startIdx);
      break;
    }
    result = result.slice(0, startIdx) + result.slice(endIdx + END_MARKER.length);
    startIdx = result.indexOf(START_MARKER);
  }
  result = result.replace(/\*{0,2}【第三部分[：:].*?】\*{0,2}\s*$/m, "");
  result = result.replace(/^.*(?:结构化JSON|结构化数据|DIAGNOSIS_JSON).*$/gm, "");
  return result.trimEnd();
}

/**
 * Determine completeness level from 4-dimensional scores.
 * Frontend-computed rule overrides any LLM-provided level.
 *
 * C (充分): all dims >= 0.6 AND redFlag >= 0.7 (redFlag has a higher bar — 0.7 — because
 *   missing a red flag is more dangerous than missing other information)
 * A (严重不足): any dim < 0.3
 * B (部分充分): otherwise (includes cases where redFlag is 0.3–0.69, which forces another round)
 */
export function determineCompletenessLevel(
  scores: Pick<Completeness, "redFlag" | "infoGain" | "managementImpact" | "answerability">
): "A" | "B" | "C" {
  const { redFlag, infoGain, managementImpact, answerability } = scores;
  if (redFlag >= 0.7 && infoGain >= 0.6 && managementImpact >= 0.6 && answerability >= 0.6) return "C";
  if (redFlag < 0.3 || infoGain < 0.3 || managementImpact < 0.3 || answerability < 0.3) return "A";
  return "B";
}

/**
 * Parse and validate completeness data from extracted JSON.
 * Recomputes level using frontend hard-coded rules.
 * Returns null if data is invalid.
 */
export function parseCompleteness(data: Record<string, unknown>): Completeness | null {
  const raw = data.completeness;
  if (!raw || typeof raw !== "object") return null;
  const parsed = CompletenessSchema.safeParse(raw);
  if (!parsed.success) return null;
  const scores = parsed.data;
  // Override LLM level with frontend-computed level
  return {
    ...scores,
    level: determineCompletenessLevel(scores),
  };
}

export function parseReasoningV2(content: string | Record<string, unknown> | null | undefined) {
  const data = typeof content === "string" ? extractDiagnosisJSON(content) : content;
  if (!data) return null;
  return normalizeReasoningV2(data);
}

export function diagnoseReasoningFromState(state: Pick<CaseState, "reasoningDiagnose" | "reasoningV2">): ClinicalReasoningResultV2 | undefined {
  return state.reasoningDiagnose || (state.reasoningV2?.stage === "diagnose" ? state.reasoningV2 : undefined);
}

export function prescribeReasoningFromState(state: Pick<CaseState, "reasoningPrescribe" | "reasoningV2">): ClinicalReasoningResultV2 | undefined {
  return state.reasoningPrescribe || (state.reasoningV2?.stage === "prescribe" ? state.reasoningV2 : undefined);
}

export function mergeReasoningStages(
  diagnose: ClinicalReasoningResultV2 | null | undefined,
  prescribe: ClinicalReasoningResultV2 | null | undefined,
): ClinicalReasoningResultV2 | undefined {
  if (!diagnose && !prescribe) return undefined;
  if (!prescribe) return diagnose || undefined;
  if (!diagnose) return prescribe;

  return {
    ...diagnose,
    stage: prescribe.stage === "prescribe" ? "prescribe" : diagnose.stage,
    overview: diagnose.overview,
    pathogenesis: diagnose.pathogenesis,
    therapy: diagnose.therapy,
    formula: prescribe.formula ?? diagnose.formula,
    nonPharma: prescribe.nonPharma ?? diagnose.nonPharma,
    lineageAdaptation: prescribe.lineageAdaptation ?? diagnose.lineageAdaptation,
    management: prescribe.management ?? diagnose.management,
    completeness: diagnose.completeness || prescribe.completeness,
  };
}
