import { maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { readCustomerBoundCaseStateRequest } from "@/lib/diagnosis-request";
import { derivePrescriptionPermission, evaluateSafetyGate, hasDeterministicCriticalVitalRedFlag, withSafetyGate } from "@/lib/diagnosis-safety";

function prescriptionPermissionView(state: ReturnType<typeof withSafetyGate>) {
  const permission = derivePrescriptionPermission(state);
  return {
    candidateMode: permission.candidateMode,
    formalAdoption: permission.formalAdoption,
  };
}

export async function POST(req: Request) {
  const parsed = await readCustomerBoundCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;

  const startedAt = Date.now();
  const deterministic = withSafetyGate(parsed.caseState);
  const deterministicGate = deterministic.safetyGate || evaluateSafetyGate(parsed.caseState);
  if (deterministicGate.status === "red_flag" && hasDeterministicCriticalVitalRedFlag(parsed.caseState)) {
    return Response.json({
      available: true,
      semanticStatus: "skipped_deterministic_critical_vital",
      clinicalFacts: parsed.caseState.clinicalFacts || null,
      safetyGate: deterministicGate,
      operationalCompleteness: deterministic.completeness,
      prescriptionPermission: prescriptionPermissionView(deterministic),
      latencyMs: Date.now() - startedAt,
    });
  }
  const enriched = await maybeAttachClinicalFactsBackstop(parsed.caseState, undefined, req.signal);
  const gated = withSafetyGate(enriched);
  return Response.json({
    available: enriched.clinicalFacts?.semanticStatus === "checked" &&
      enriched.clinicalFacts.reviewStatus === "checked" &&
      Boolean(enriched.clinicalFacts.attestation),
    semanticStatus: enriched.clinicalFacts?.semanticStatus || "unavailable",
    clinicalFacts: enriched.clinicalFacts || null,
    safetyGate: gated.safetyGate,
    operationalCompleteness: gated.completeness,
    prescriptionPermission: prescriptionPermissionView(gated),
    latencyMs: Date.now() - startedAt,
  });
}
