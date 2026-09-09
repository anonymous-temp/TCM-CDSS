import type { CaseState } from "./diagnosis-types";
import { deriveCaseWarningProfile, deriveStructuredCaseWarningFloor, warningLevelRank, type ClinicalWarningProfile } from "./clinical-warning-tier";
import { parseWarningDisplayReceipt, warningDisplayHash, warningDisplayMaterial, type WarningDisplayReceipt } from "./warning-display-binding";

/** Transient page/cache data only. Neither this nor the material string belongs in CaseState. */
export type InstalledWarningObservation = { receipt: WarningDisplayReceipt; view: "live" | "stored"; materialKey: string };

export async function prepareWarningObservation(input: {
  receipt: unknown; requestState?: CaseState; finalState: CaseState; customerId?: string;
  view?: "live" | "stored"; isCurrent: () => boolean;
}): Promise<InstalledWarningObservation | undefined> {
  try {
    if (!input.isCurrent()) return undefined;
    const receipt = parseWarningDisplayReceipt(input.receipt);
    const view = input.view || "live";
    if (!receipt || (input.customerId && receipt.customerId !== input.customerId) ||
      receipt.caseId !== input.finalState.id || receipt.encounterId !== (input.finalState.hisRecord?.caseId || input.finalState.id) ||
      input.finalState.phase !== "done" || input.finalState.lastError) return undefined;
    const materialKey = warningDisplayMaterial(input.finalState, receipt.customerId);
    if (view === "live") {
      if (!input.requestState || receipt.requestHash !== await warningDisplayHash(warningDisplayMaterial(input.requestState, receipt.customerId))) return undefined;
      if (!input.isCurrent()) return undefined;
    }
    if (receipt[view].materialHash !== await warningDisplayHash(materialKey) || !input.isCurrent() ||
      materialKey !== warningDisplayMaterial(input.finalState, receipt.customerId)) return undefined;
    return { receipt, view, materialKey };
  } catch { return undefined; }
}

export function matchingWarningObservation(state: CaseState, installed?: InstalledWarningObservation | null): InstalledWarningObservation | undefined {
  try {
    return installed && installed.materialKey === warningDisplayMaterial(state, installed.receipt.customerId) ? installed : undefined;
  } catch { return undefined; }
}

export function resolveWarningDisplayProfile(state: CaseState, installed?: InstalledWarningObservation | null): ClinicalWarningProfile {
  const matched = matchingWarningObservation(state, installed);
  if (!matched) return deriveCaseWarningProfile(state);
  const profile = matched.receipt[matched.view].profile;
  const floor = deriveStructuredCaseWarningFloor(state);
  return warningLevelRank(floor.level) > warningLevelRank(profile.level) || (!floor.executable && profile.executable) ? floor : profile;
}
