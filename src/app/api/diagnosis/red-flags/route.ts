import { clinicalFactsReviewSettled } from "@/lib/clinical-facts";
import { deliveredClinicalFactsForApiCaller } from "@/lib/delivered-clinical-facts";
import { maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { readCustomerBoundCaseStateRequest } from "@/lib/diagnosis-request";
import { derivePrescriptionPermission, evaluateSafetyGate, hasDeterministicCriticalVitalRedFlag, withSafetyGate } from "@/lib/diagnosis-safety";
import { precomputeAnsweredPath } from "@/lib/no-answer-precompute.server";
import { prefetchDiagnoseInputs } from "@/lib/stage-prefetch.server";
import { withClinicalResponseArchive } from "@/lib/request-archive.server";

/**
 * 接口文档 §4.7 出参表里的顶层 `redFlags` / `advisories`：与 `safetyGate.redFlags` / `safetyGate.advisories` 同一份内容。
 * 文档自 2026-08-07 起列着这两个字段，响应里一直没有；甲方按「命中红旗项」去找 `redFlags`，取到的是
 * `clinicalFacts.redFlags`（语义复核的工作记录，连病历里明确否认的风险也记一条），否认「疫区旅居史」就亮了红色横幅
 *（2026-10-29 甲方同一病例两次请求，`safetyGate` 逐字相同）。
 */
function documentedRedFlagFields(gate: { redFlags?: string[]; advisories?: string[] } | undefined) {
  return { redFlags: gate?.redFlags || [], advisories: gate?.advisories || [] };
}

function prescriptionPermissionView(state: ReturnType<typeof withSafetyGate>) {
  const permission = derivePrescriptionPermission(state);
  return {
    candidateMode: permission.candidateMode,
    formalAdoption: permission.formalAdoption,
  };
}

/** 带令牌头的是接口调用方，页面只带登录 cookie（页面要回传带签名的完整事实，见 delivered-clinical-facts.ts）。 */
function isApiCaller(req: Request): boolean {
  return Boolean(req.headers.get("x-cdss-api-token")) || /^Bearer\s/i.test(req.headers.get("authorization") || "");
}

async function handlePost(req: Request) {
  const parsed = await readCustomerBoundCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;

  const startedAt = Date.now();
  // 答题期预热（2026-09-28）：页面在医生选齐追问答案后，用与提交时逐字相同的病例先调本路由，
  // 事实层随之进缓存；带 prefetch=diagnose 时再预取 M03 两半开跑前的四样输入（EviMed、方名召回改写、
  // 否定增补、证候重排）。提交后的 red-flags 与 M03 因此都是缓存命中。只写缓存，不改变本路由的响应。
  if (new URL(req.url).searchParams.get("prefetch") === "diagnose") prefetchDiagnoseInputs(parsed.caseState);
  // 作答后的病例：调用方接下来就是辨证与开方，这里先经回环算起来，稍后的请求并入（no-answer-precompute.server.ts）。
  // 页面的答题期预热（prefetch=diagnose）不触发：那时医生还可能改答案。
  else precomputeAnsweredPath(req, parsed.caseState);
  const deterministic = withSafetyGate(parsed.caseState);
  const deterministicGate = deterministic.safetyGate || evaluateSafetyGate(parsed.caseState);
  if (deterministicGate.status === "red_flag" && hasDeterministicCriticalVitalRedFlag(parsed.caseState)) {
    return Response.json({
      available: true,
      semanticStatus: "skipped_deterministic_critical_vital",
      ...documentedRedFlagFields(deterministicGate),
      clinicalFacts: isApiCaller(req)
        ? deliveredClinicalFactsForApiCaller(parsed.caseState.clinicalFacts, deterministicGate)
        : parsed.caseState.clinicalFacts || null,
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
    ...documentedRedFlagFields(gated.safetyGate),
    clinicalFacts: isApiCaller(req)
      ? deliveredClinicalFactsForApiCaller(enriched.clinicalFacts, gated.safetyGate)
      : enriched.clinicalFacts || null,
    safetyGate: gated.safetyGate,
    operationalCompleteness: gated.completeness,
    prescriptionPermission: prescriptionPermissionView(gated),
    latencyMs: Date.now() - startedAt,
  });
}

// 临床请求与响应都加密留存（用户 2026-10-26 D3），见 request-archive.server.ts。
export const POST = withClinicalResponseArchive(handlePost);
