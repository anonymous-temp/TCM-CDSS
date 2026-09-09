import type { CaseState } from "./diagnosis-types";
import { normalizeCaseStateInput } from "./diagnosis-types";
import { warningLevelClinicianLabel, type ClinicalWarningProfile } from "./clinical-warning-tier";

export const WARNING_DISPLAY_VERSION = "tcm-warning-display-receipt-v1" as const;
export const WARNING_PROJECTION_VERSION = "warning-projection-v1" as const;
export type WarningDigest = `sha256:${string}`;
export type WarningDisplayView = { materialHash: WarningDigest; profile: ClinicalWarningProfile };
export type WarningDisplayReceipt = {
  version: typeof WARNING_DISPLAY_VERSION;
  projectionVersion: typeof WARNING_PROJECTION_VERSION;
  producer: "assess" | "post-prescription-risk";
  clientId: string; customerId: string; caseId: string; encounterId: string;
  requestHash: WarningDigest;
  live: WarningDisplayView; stored: WarningDisplayView;
  mac: `hmac-sha256:${string}`;
};
export type VerifiedWarningObservation = { view: "stored"; receipt: WarningDisplayReceipt };

export function stableWarningJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (!item || typeof item !== "object") return item;
    const row = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(row).sort().filter((key) => row[key] !== undefined)
      .map((key) => [key, canonical(row[key])]));
  };
  return JSON.stringify(canonical(value));
}

// Normalize shape with the shared parser but retain text bytes at every retained clinical path.
// In particular, a trailing edit to a report must invalidate the previous display observation.
function retainedText(normalized: unknown, original: unknown): unknown {
  if (typeof normalized === "string" && typeof original === "string") return original;
  if (Array.isArray(normalized)) return normalized.map((item, index) => retainedText(item, Array.isArray(original) ? original[index] : undefined));
  if (!normalized || typeof normalized !== "object") return normalized;
  const raw = original && typeof original === "object" && !Array.isArray(original) ? original as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key, retainedText(value, raw[key])]));
}

export function warningDisplayMaterial(value: CaseState, resolvedCustomerId?: string): string {
  const state = normalizeCaseStateInput(value);
  if (!state) throw new Error("warning_state_invalid");
  if (state.customerId && resolvedCustomerId && state.customerId !== resolvedCustomerId) throw new Error("warning_customer_mismatch");
  const material = retainedText(state, value) as Record<string, unknown>;
  material.customerId = resolvedCustomerId || state.customerId;
  for (const key of ["updatedAt", "savedAt", "warningAcknowledgement", "previousResult"]) delete material[key];
  // The complete clinical artifacts, including signatures and additional signed fields, bind as-is.
  for (const key of ["reasoningDiagnose", "reasoningPrescribe", "reasoningV2"] as const) {
    if (value[key]) material[key] = value[key];
  }
  return stableWarningJson(material);
}

export async function warningDisplayHash(material: string): Promise<WarningDigest> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const exactKeys = (row: Record<string, unknown>, keys: string[]) => Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
const digest = (value: unknown): value is WarningDigest => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);

export function boundedWarningProfile(profile: ClinicalWarningProfile): ClinicalWarningProfile {
  return { ...profile, reasons: profile.reasons.slice(0, 8).map((reason) => reason.slice(0, 600)) };
}

function parseProfile(value: unknown): ClinicalWarningProfile | undefined {
  const row = record(value);
  if (!row || !exactKeys(row, ["level", "label", "action", "executable", "reasons"]) ||
    !["L0", "L1", "L2", "L3", "L4"].includes(String(row.level)) || typeof row.executable !== "boolean" ||
    !Array.isArray(row.reasons) || row.reasons.length < 1 || row.reasons.length > 8 ||
    !row.reasons.every((reason) => typeof reason === "string" && reason.length > 0 && reason.length <= 600)) return undefined;
  const level = row.level as ClinicalWarningProfile["level"];
  const expectedAction = !row.executable || level === "L4" ? "non_executable" : level === "L3" ? "reason_required" : level === "L2" ? "acknowledge" : "display_only";
  if (row.label !== warningLevelClinicianLabel(level) || row.action !== expectedAction || (level === "L4" && row.executable)) return undefined;
  return { level, label: row.label, action: expectedAction, executable: row.executable, reasons: [...row.reasons] };
}

export function parseWarningDisplayReceipt(value: unknown): WarningDisplayReceipt | undefined {
  const row = record(value);
  if (!row || !exactKeys(row, ["version", "projectionVersion", "producer", "clientId", "customerId", "caseId", "encounterId", "requestHash", "live", "stored", "mac"]) ||
    row.version !== WARNING_DISPLAY_VERSION || row.projectionVersion !== WARNING_PROJECTION_VERSION ||
    (row.producer !== "assess" && row.producer !== "post-prescription-risk") ||
    ![row.clientId, row.customerId, row.caseId, row.encounterId].every(identifier) || !digest(row.requestHash) ||
    typeof row.mac !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/.test(row.mac)) return undefined;
  const view = (value: unknown): WarningDisplayView | undefined => {
    const data = record(value);
    const profile = parseProfile(data?.profile);
    return data && exactKeys(data, ["materialHash", "profile"]) && digest(data.materialHash) && profile ? { materialHash: data.materialHash, profile } : undefined;
  };
  const live = view(row.live), stored = view(row.stored);
  return live && stored ? { version: WARNING_DISPLAY_VERSION, projectionVersion: WARNING_PROJECTION_VERSION, producer: row.producer,
    clientId: row.clientId as string, customerId: row.customerId as string, caseId: row.caseId as string, encounterId: row.encounterId as string,
    requestHash: row.requestHash, live, stored, mac: row.mac as WarningDisplayReceipt["mac"] } : undefined;
}
