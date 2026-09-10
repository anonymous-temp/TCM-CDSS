import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CaseState } from "./diagnosis-types";
import type { CustomerContext } from "./customer-context";
import type { ClinicalDeliveryAdvisory } from "./clinical-delivery-advisory";
import { deriveOwnedCaseWarningProfile, projectPrescriptionWarningText } from "./clinical-warning-projection.server";
import { applyAcceptedPrescriptionDisplayResult, buildAcceptedPrescriptionWarningProjection, revisionFromAudit } from "./followup-display-state";
import { derivePrescriptionPermission, withSafetyGate } from "./diagnosis-safety";
import { deriveStructuredCaseWarningFloor } from "./clinical-warning-tier";
import { prescribeReasoningFromState } from "./diagnosis-parse";
import { sanitizeCaseStateForBrowserPersistence } from "./browser-case-persistence";
import { matchedWarningText, type OwnedCaseWarningProjection, type WarningTextProjection } from "./warning-text-projection";
import { storedWarningCase, WARNING_STORAGE_RECEIPT_KEY } from "./warning-display-storage";
import { warningSourceBindingMaterials } from "./warning-display-source-binding.server";
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
  sourceRepresentation?: unknown;
}): Promise<WarningDisplayReceipt | undefined> {
  try {
    const { finalState, requestState, customer, owned, advisories } = input;
    if (finalState.phase !== "done" || finalState.lastError || finalState.id !== requestState.id ||
      (finalState.hisRecord?.caseId || finalState.id) !== (requestState.hisRecord?.caseId || requestState.id)) return undefined;
    const storedState = storedWarningCase({ schemaVersion: "tcm-cdss-workspace-v1", caseState: sanitizeCaseStateForBrowserPersistence(finalState) });
    if (!storedState) return undefined;
    const binding = input.sourceRepresentation === undefined ? undefined : warningSourceBindingMaterials({
      producer: input.producer, source: input.sourceRepresentation, requestState, finalState, storedState, customerId: customer.customerId,
    });
    if (input.sourceRepresentation !== undefined && !binding) return undefined;
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
      requestHash: await warningDisplayHash(binding?.request ?? warningDisplayMaterial(requestState, customer.customerId)),
      live: { materialHash: await warningDisplayHash(binding?.live ?? warningDisplayMaterial(finalState, customer.customerId)), profile: boundedWarningProfile(deriveOwnedCaseWarningProfile(finalState, owned, advisories)) },
      stored: { materialHash: await warningDisplayHash(binding?.stored ?? warningDisplayMaterial(storedState, customer.customerId)), profile: boundedWarningProfile(deriveOwnedCaseWarningProfile(storedState, storedOwned, advisories)) },
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

export async function withPostPrescriptionWarningObservation<T extends {
  section: string; followup: string; followupTimeline: import("./diagnosis-types").StructuredFollowupTimelineItem[];
  audit: Record<string, unknown>;
}>(body: T, input: {
  requestState: CaseState; producerState: CaseState; customer: CustomerBinding;
  sourceRepresentation?: unknown;
  sectionProjection: WarningTextProjection; followupProjection: WarningTextProjection;
  audit: NonNullable<OwnedCaseWarningProjection["audit"]>; advisories: readonly ClinicalDeliveryAdvisory[];
}): Promise<T & { warningObservation?: WarningDisplayReceipt }> {
  try {
    const { requestState } = input;
    const reasoning = prescribeReasoningFromState(requestState);
    if (requestState.prescriptionRevision?.source !== "herb_workbench" || !reasoning || body.audit.attestationVersion !== "tcm-cdss-workbench-revision-v1") return body;
    const candidateIndex = requestState.prescriptionRevision.candidateIndex;
    const herbHash = typeof body.audit.herbHash === "string" ? body.audit.herbHash : "";
    const accepted = { caseId: requestState.id, reasoning, auditSection: body.section,
      followupSection: body.followup.trim(), followupTimeline: body.followupTimeline,
      serverSafetyLocked: derivePrescriptionPermission(withSafetyGate(requestState)).formalAdoption === "blocked",
      revision: revisionFromAudit(body.audit, candidateIndex, herbHash, true),
    };
    const finalState = applyAcceptedPrescriptionDisplayResult({ ...requestState, customerId: input.customer.customerId }, accepted);
    // The submitted workbench revision is only an unaudited placeholder. Carry fresh enriched
    // patient facts forward, but take revision severity/availability from this completed audit.
    const completedProducerState = applyAcceptedPrescriptionDisplayResult(input.producerState, accepted);
    const projectedState = applyAcceptedPrescriptionDisplayResult(requestState, { ...accepted,
      auditSection: matchedWarningText(body.section, input.sectionProjection),
      followupSection: matchedWarningText(body.followup, input.followupProjection).trim(),
    });
    const prescription = buildAcceptedPrescriptionWarningProjection(reasoning, candidateIndex, herbHash);
    const observation = await createWarningDisplayReceipt({ producer: "post-prescription-risk", requestState, finalState,
      sourceRepresentation: input.sourceRepresentation,
      customer: input.customer, advisories: input.advisories,
      owned: { prescription, riskAssessment: { markdown: finalState.riskAssessment || "", currentRiskMarkdown: projectedState.riskAssessment || "" },
        audit: input.audit, floor: deriveStructuredCaseWarningFloor(completedProducerState) },
    });
    return observation ? { ...body, warningObservation: observation } : body;
  } catch {
    console.warn("[tcm-cdss:warning-display] observation omitted", { reason: "post_projection_unavailable" });
    return body;
  }
}
