import { getPublicTextModelStatus, runTextModelFamilyHealthChecks } from "@/lib/text-model";
import { getCdssAuthenticatedRateLimitKey } from "@/lib/cdss-auth";
import { configuredStageTextModels, getDiagnosisProviderStatus } from "@/lib/diagnosis-api";
import { getClinicalFactsModelPlan } from "@/lib/clinical-facts-runtime";
import { healthDiagnosticsRequested, publicHealthView } from "@/lib/health-public-view";

const HEALTH_CHECK_WINDOW_MS = 10 * 60 * 1000;
const HEALTH_CHECK_MAX_ATTEMPTS = 6;

type HealthBucket = {
  count: number;
  resetAt: number;
};

const healthBuckets = new Map<string, HealthBucket>();

async function healthRateLimited(req: Request): Promise<Response | null> {
  const now = Date.now();
  const key = await getCdssAuthenticatedRateLimitKey(req);
  const current = healthBuckets.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + HEALTH_CHECK_WINDOW_MS }
    : current;
  bucket.count += 1;
  healthBuckets.set(key, bucket);
  if (bucket.count <= HEALTH_CHECK_MAX_ATTEMPTS) return null;
  return Response.json(
    { error: "model health check rate limited" },
    {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))) },
    },
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const check = url.searchParams.get("check") === "1";
  // 与 /api/diagnosis/health 同一条收口规则：模型/厂商身份、调参与上游原文只在
  // ?diagnostics=1 且 CDSS_HEALTH_DIAGNOSTICS=true 时给出（2026-09-25，此前这里原样回传）。
  const view = <T,>(body: T): T => healthDiagnosticsRequested(req) ? body : publicHealthView(body);
  if (!check) {
    const diagnosis = getDiagnosisProviderStatus();
    return Response.json(view({
      module: "text-model",
      status: getPublicTextModelStatus(),
      diagnosis,
      liveCheck: "append ?check=1 to call the configured provider",
    }));
  }

  const rateLimited = await healthRateLimited(req);
  if (rateLimited) return rateLimited;

  // 每个不同的模型家族/端点实调一次（并行）；整体 ok 要求每一家都返回最终内容。
  const result = await runTextModelFamilyHealthChecks([
    ...configuredStageTextModels(),
    { role: "clinical_facts", model: getClinicalFactsModelPlan().extractor.model },
  ]);
  return Response.json(view({
    module: "text-model",
    liveCheck: result,
  }), { status: result.ok ? 200 : 502 });
}
