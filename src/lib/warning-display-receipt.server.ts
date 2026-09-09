import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CaseState } from "./diagnosis-types";
import type { CustomerContext } from "./customer-context";
import type { ClinicalDeliveryAdvisory } from "./clinical-delivery-advisory";
import { deriveOwnedCaseWarningProfile, projectPrescriptionWarningText } from "./clinical-warning-projection.server";
import { restoreWarningDisplayCase } from "./followup-display-state";
import { sanitizeCaseStateForBrowserPersistence } from "./browser-case-persistence";
import { matchedWarningText, type OwnedCaseWarningProjection } from "./warning-text-projection";
import { storedWarningCase, WARNING_STORAGE_RECEIPT_KEY } from "./warning-display-storage";
import { boundedWarningProfile, parseWarningDisplayReceipt, stableWarningJson, warningDisplayHash, warningDisplayMaterial,
  WARNING_DISPLAY_VERSION, WARNING_PROJECTION_VERSION, type WarningDisplayReceipt } from "./warning-display-binding";

type CustomerBinding = Pick<CustomerContext, "clientId" | "customerId">;
const DOMAIN = "tcm-cdss-warning-display-receipt-v1\0";
function receiptMac(unsigned: Omit<WarningDisplayReceipt, "mac">): WarningDisplayReceipt["mac"] | undefined {
  const key = process.env.REASONING_CONTRACT_SIGNING_KEY?.trim() || "";
  return key.length < 32 ? undefined : `hmac-sha256:${createHmac("sha256", key).update(DOMAIN).update(stableWarningJson(unsigned)).digest("hex")}`;
}

/** Called only with the producer's final reducer output and internal provenance, never in encrypt. */
export async function createWarningDisplayReceipt(input: {
  producer: WarningDisplayReceipt["producer"]; requestState: CaseState; finalState: CaseState; customer: CustomerBinding;
  owned?: OwnedCaseWarningProjection; advisories?: readonly ClinicalDeliveryAdvisory[];
}): Promise<WarningDisplayReceipt | undefined> {
  try {
    const { finalState, requestState, customer, owned, advisories } = input;
    if (finalState.phase !== "done" || finalState.lastError || finalState.id !== requestState.id ||
      (finalState.hisRecord?.caseId || finalState.id) !== (requestState.hisRecord?.caseId || requestState.id)) return undefined;
    const storedState = storedWarningCase({ schemaVersion: "tcm-cdss-workspace-v1", caseState: sanitizeCaseStateForBrowserPersistence(finalState) });
    if (!storedState) return undefined;
    const projectedState = { ...finalState,
      prescription: matchedWarningText(finalState.prescription, owned?.prescription || projectPrescriptionWarningText(finalState)),
      riskAssessment: matchedWarningText(finalState.riskAssessment, owned?.riskAssessment),
    };
    const storedProjected = storedWarningCase({ schemaVersion: "tcm-cdss-workspace-v1", caseState: sanitizeCaseStateForBrowserPersistence(projectedState) });
    if (!storedProjected) return undefined;
    const storedOwned: OwnedCaseWarningProjection = { ...owned,
      prescription: { markdown: storedState.prescription || "", currentRiskMarkdown: storedProjected.prescription || "" },
      riskAssessment: { markdown: storedState.riskAssessment || "", currentRiskMarkdown: storedProjected.riskAssessment || "" },
    };
    const unsigned: Omit<WarningDisplayReceipt, "mac"> = {
      version: WARNING_DISPLAY_VERSION, projectionVersion: WARNING_PROJECTION_VERSION, producer: input.producer,
      clientId: customer.clientId, customerId: customer.customerId, caseId: finalState.id, encounterId: finalState.hisRecord?.caseId || finalState.id,
      requestHash: await warningDisplayHash(warningDisplayMaterial(requestState, customer.customerId)),
      live: { materialHash: await warningDisplayHash(warningDisplayMaterial(finalState, customer.customerId)), profile: boundedWarningProfile(deriveOwnedCaseWarningProfile(finalState, owned, advisories)) },
      stored: { materialHash: await warningDisplayHash(warningDisplayMaterial(storedState, customer.customerId)), profile: boundedWarningProfile(deriveOwnedCaseWarningProfile(storedState, storedOwned, advisories)) },
    };
    const mac = receiptMac(unsigned);
    return mac ? parseWarningDisplayReceipt({ ...unsigned, mac }) : undefined;
  } catch {
    console.warn("[tcm-cdss:warning-display] observation omitted", { reason: "binding_unavailable" });
    return undefined;
  }
}

export async function verifyWarningDisplayReceipt(value: unknown, customer: CustomerBinding, state: CaseState, view: "live" | "stored"): Promise<boolean> {
  try {
    const receipt = parseWarningDisplayReceipt(value);
    if (!receipt || receipt.clientId !== customer.clientId || receipt.customerId !== customer.customerId ||
      receipt.caseId !== state.id || receipt.encounterId !== (state.hisRecord?.caseId || state.id)) return false;
    const { mac, ...unsigned } = receipt;
    const expected = receiptMac(unsigned);
    if (!expected || expected.length !== mac.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
    return receipt[view].materialHash === await warningDisplayHash(warningDisplayMaterial(state, customer.customerId));
  } catch { return false; }
}

export async function verifyStoredWarningObservation(payload: unknown, customer: CustomerBinding): Promise<{ view: "stored"; receipt: WarningDisplayReceipt } | undefined> {
  const state = storedWarningCase(payload);
  const receipt = payload && typeof payload === "object" && !Array.isArray(payload)
    ? parseWarningDisplayReceipt((payload as Record<string, unknown>)[WARNING_STORAGE_RECEIPT_KEY]) : undefined;
  return state && receipt && await verifyWarningDisplayReceipt(receipt, customer, state, "stored") ? { view: "stored", receipt } : undefined;
}
