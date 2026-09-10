import "server-only";
import { normalizeCaseStateInput, type CaseState } from "./diagnosis-types";
import { sanitizeCaseStateForBrowserPersistence } from "./browser-case-persistence";
import { stableWarningJson, warningDisplayMaterial, type WarningDisplayReceipt } from "./warning-display-binding";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

// These are actual writes by the shared completion reducers, including equal-value writes.
// Never restore pre-completion source bytes onto a newly produced clinical field.
const COMPLETED_FIELDS = new Set(["customerId", "phase", "riskAssessment", "followupTimeline", "auditAdvisory",
  "completeness", "safetyGate", "safetyLocked", "skipDifferentiationGate", "previousResult"]);
const WORKBENCH_FIELDS = new Set([...COMPLETED_FIELDS, "prescription", "reasoningPrescribe", "reasoningV2", "prescriptionRevision", "lastError"]);

function removeAbsentClocks(value: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of ["hisRecord", "faceCapture"]) {
    const raw = object(source[key]);
    const target = object(value[key]);
    if (raw && target && (raw.updatedAt === undefined || raw.updatedAt === "")) delete target.updatedAt;
  }
}

function correspondingArrays(normalized: unknown, source: unknown): boolean {
  if (Array.isArray(normalized) && Array.isArray(source)) {
    return normalized.length === source.length && normalized.every((item, index) => correspondingArrays(item, source[index]));
  }
  const target = object(normalized);
  const raw = object(source);
  return !target || !raw || Object.keys(target).every((key) => correspondingArrays(target[key], raw[key]));
}

/** Binding strings only. No returned representation is passed to a clinical reducer or classifier. */
export function warningSourceBindingMaterials(input: {
  producer: WarningDisplayReceipt["producer"]; source: unknown;
  requestState: CaseState; finalState: CaseState; storedState: CaseState; customerId: string;
}): { request: string; live: string; stored: string } | undefined {
  const source = object(input.source);
  if (!source) return undefined;
  const normalized = normalizeCaseStateInput(source);
  if (!normalized || !correspondingArrays(normalized, source)) return undefined;
  const authorized = JSON.parse(stableWarningJson(input.requestState)) as Record<string, unknown>;
  const comparable = JSON.parse(stableWarningJson(normalized)) as Record<string, unknown>;
  if (normalized.customerId && normalized.customerId !== input.customerId) return undefined;
  comparable.customerId = input.customerId;
  removeAbsentClocks(comparable, source);
  removeAbsentClocks(authorized, source);
  // Validation occurs after tenant facts and emergency-clearance stripping. Reintroducing either
  // field, or filtering/reordering a source array, therefore cannot obtain a display receipt.
  if (stableWarningJson(comparable) !== stableWarningJson(authorized)) return undefined;
  const request = warningDisplayMaterial(source as unknown as CaseState, input.customerId);
  const requestMaterial = JSON.parse(request) as Record<string, unknown>;
  const liveMaterial = JSON.parse(warningDisplayMaterial(input.finalState, input.customerId)) as Record<string, unknown>;
  const owned = input.producer === "assess" ? COMPLETED_FIELDS : WORKBENCH_FIELDS;
  for (const key of Object.keys(liveMaterial)) {
    if (!owned.has(key) && key in requestMaterial) liveMaterial[key] = requestMaterial[key];
  }
  // This boundary only redacts and parses representation data. Safety/restoration decisions below
  // come from the separately computed, authoritative storedState supplied by the producer.
  const sanitized = sanitizeCaseStateForBrowserPersistence(liveMaterial as unknown as CaseState);
  const normalizedStored = normalizeCaseStateInput(JSON.parse(stableWarningJson(sanitized)));
  if (!normalizedStored) return undefined;
  const retainedStored = JSON.parse(warningDisplayMaterial(normalizedStored, input.customerId)) as Record<string, unknown>;
  removeAbsentClocks(retainedStored, sanitized as unknown as Record<string, unknown>);
  const storedMaterial = JSON.parse(warningDisplayMaterial(input.storedState, input.customerId)) as Record<string, unknown>;
  for (const key of Object.keys(storedMaterial)) {
    if (!owned.has(key) && key in retainedStored) storedMaterial[key] = retainedStored[key];
  }
  return { request, live: stableWarningJson(liveMaterial), stored: stableWarningJson(storedMaterial) };
}
