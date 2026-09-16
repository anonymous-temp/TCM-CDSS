import { getPublicTextModelStatus, runTextModelHealthCheck } from "@/lib/text-model";
import { getCdssAuthenticatedRateLimitKey } from "@/lib/cdss-auth";
import { getDiagnosisProviderStatus } from "@/lib/diagnosis-api";
import { getRxAuditStatus } from "@/lib/rxaudit";

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
  if (!check) {
    const diagnosis = getDiagnosisProviderStatus();
    return Response.json({
      module: "text-model",
      status: getPublicTextModelStatus(),
      diagnosis,
      audit: getRxAuditStatus(),
      liveCheck: "append ?check=1 to call the configured provider",
    });
  }

  const rateLimited = await healthRateLimited(req);
  if (rateLimited) return rateLimited;

  // 模型复核环节已移除（2026-09-16）：实调只验证主模型能返回最终内容。
  const result = await runTextModelHealthCheck();
  return Response.json({
    module: "text-model",
    liveCheck: result,
  }, { status: result.ok ? 200 : 502 });
}
