import { clinicalFactsReviewSettled } from "@/lib/clinical-facts";
import { maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { readCustomerBoundCaseStateRequest } from "@/lib/diagnosis-request";
import { derivePrescriptionPermission, evaluateSafetyGate, hasDeterministicCriticalVitalRedFlag, withSafetyGate } from "@/lib/diagnosis-safety";
import { prefetchDiagnoseInputs } from "@/lib/stage-prefetch.server";

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
  // 答题期预热（2026-09-28）：页面在医生选齐追问答案后，用与提交时逐字相同的病例先调本路由，
  // 事实层随之进缓存；带 prefetch=diagnose 时再预取 M03 两半开跑前的四样输入（EviMed、方名召回改写、
  // 否定增补、证候重排）。提交后的 red-flags 与 M03 因此都是缓存命中。只写缓存，不改变本路由的响应。
  if (new URL(req.url).searchParams.get("prefetch") === "diagnose") prefetchDiagnoseInputs(parsed.caseState);
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
      clinicalFactsReviewSettled(enriched.clinicalFacts.reviewStatus) &&
      Boolean(enriched.clinicalFacts.attestation),
    semanticStatus: enriched.clinicalFacts?.semanticStatus || "unavailable",
    clinicalFacts: enriched.clinicalFacts || null,
    safetyGate: gated.safetyGate,
    operationalCompleteness: gated.completeness,
    prescriptionPermission: prescriptionPermissionView(gated),
    latencyMs: Date.now() - startedAt,
  });
}
