import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

export function prescriptionVersionPayload(reasoning: ClinicalReasoningResultV2, candidateIndex: number, state?: CaseState): string {
  const candidate = reasoning.formula?.candidates[candidateIndex];
  if (!candidate) return "";
  return JSON.stringify(canonicalize({
    schemaVersion: state ? "tcm-cdss-prescription-audit-version-v2" : "tcm-cdss-prescription-version-v1",
    candidateIndex,
    candidate,
    modifications: reasoning.formula?.modifications || [],
    ...(state ? {
      auditContext: {
        caseId: state.id,
        patient: state.patient,
        chiefComplaint: state.chiefComplaint,
        diagnosis: state.diagnosis,
        diagnosisOverview: state.reasoningDiagnose?.overview,
        pastHistory: state.pastHistory,
        medicationHistory: state.medicationHistory,
        allergyHistory: state.allergyHistory,
        tongue: state.tongue,
        pulse: state.pulse,
        hisFields: state.hisRecord?.fields,
      },
    } : {}),
  }));
}

export async function computePrescriptionVersionHash(
  reasoning: ClinicalReasoningResultV2,
  candidateIndex: number,
  state?: CaseState,
): Promise<string> {
  const payload = prescriptionVersionPayload(reasoning, candidateIndex, state);
  if (!payload) return "";
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return `sha256-${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
