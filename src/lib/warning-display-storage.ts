import type { CaseState, Phase } from "./diagnosis-types";
import { restoreWarningDisplayCase } from "./followup-display-state";
import { matchingWarningObservation, type InstalledWarningObservation } from "./warning-display-observation";
import { parseWarningDisplayReceipt, stableWarningJson, warningDisplayHash, warningDisplayMaterial, type WarningDisplayReceipt } from "./warning-display-binding";

export const WARNING_STORAGE_RECEIPT_KEY = "__tcmWarningDisplayReceipt";
const row = (value: unknown): Record<string, unknown> | undefined => value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Only two explicit payload shapes qualify; arbitrary encrypted JSON remains arbitrary JSON. */
export function storedWarningCase(payload: unknown): CaseState | undefined {
  // Autosave supplies an in-memory object, decrypt supplies its JSON-wire equivalent. They must
  // have the same absent/explicit-field semantics before the existing restoration parser runs.
  const object = row(payload == null ? payload : JSON.parse(stableWarningJson(payload)));
  if (!object) return undefined;
  const workspace = object.schemaVersion === "tcm-cdss-workspace-v1";
  if (workspace && object.workbenchDraft) return undefined;
  const candidate = row(workspace ? object.caseState : object);
  if (!candidate || typeof candidate.id !== "string" || !candidate.id || !row(candidate.patient) || typeof candidate.phase !== "string") return undefined;
  const restored = restoreWarningDisplayCase(candidate, workspace ? object.runningPhase as Phase | undefined : undefined);
  return restored?.phase === "done" && !restored.lastError ? restored : undefined;
}

export function withWarningStorageReceipt(payload: Record<string, unknown>, matchingReceipt?: WarningDisplayReceipt): Record<string, unknown> {
  const { [WARNING_STORAGE_RECEIPT_KEY]: discarded, ...core } = payload;
  void discarded;
  const receipt = parseWarningDisplayReceipt(matchingReceipt);
  return receipt ? { ...core, [WARNING_STORAGE_RECEIPT_KEY]: receipt } : core;
}

export async function matchingWarningStorageReceipt(payload: unknown, liveState: CaseState, installed: InstalledWarningObservation | null | undefined, isCurrent: () => boolean): Promise<WarningDisplayReceipt | undefined> {
  try {
    if (!isCurrent()) return undefined;
    const matching = matchingWarningObservation(liveState, installed);
    const restored = storedWarningCase(payload);
    if (!matching || !restored) return undefined;
    const material = warningDisplayMaterial(restored, matching.receipt.customerId);
    const hash = await warningDisplayHash(material);
    if (!isCurrent() || !matchingWarningObservation(liveState, matching) || hash !== matching.receipt.stored.materialHash ||
      material !== warningDisplayMaterial(storedWarningCase(payload)!, matching.receipt.customerId)) return undefined;
    return matching.receipt;
  } catch { return undefined; }
}
