import { NextResponse, type NextRequest } from "next/server";
import {
  bearerToken,
  CDSS_RATE_LIMIT_COOKIE,
  CDSS_RATE_LIMIT_COOKIE_MAX_AGE_SECONDS,
  CDSS_UI_COOKIE,
  CDSS_UI_COOKIE_MAX_AGE_SECONDS,
  cdssUiCookieValue,
  cdssRequestOrigin,
  getCdssAuthenticatedRateLimitKey,
  getCdssAccessToken,
  getCdssBasePath,
  getCdssCookiePath,
  getCdssRateLimitIdentity,
  isCdssAuthRequired,
  isHttpsRequest,
  isValidCdssUiCookieValue,
  sameSecret,
} from "@/lib/cdss-auth";

const APP_BASE_PATH = getCdssBasePath();
const API_AUTH_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const API_AUTH_RATE_LIMIT_LOCK_MS = 10 * 60 * 1000;
const MAX_API_AUTH_FAILURES = 20;
const MODEL_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const MODEL_RATE_LIMIT_MIN = 10;
const MODEL_RATE_LIMIT_MAX = 2_000;
const MODEL_RATE_LIMIT_REQUESTS = (() => {
  const raw = process.env.CDSS_MODEL_RATE_LIMIT_PER_10_MIN;
  const value = Number(raw ?? 60);
  // 无法解析（未设置、空串、非数字）才用默认值 60；能解析但超范围的**钳到边界**，不回落默认。
  // 原实现对超范围值也回落 60：本仓 .env.local 写的 100000 因此一直静默变成 60——
  // 配置方明确要一个高限值，却拿到全局最低值，与意图完全相反，而且没有任何提示。
  // 实测后果：黄金基线 386 次调用被打出 237 个 429，看上去像产品回归，根因只是这个静默回落。
  if (!Number.isFinite(value)) return 60;
  return Math.round(Math.min(MODEL_RATE_LIMIT_MAX, Math.max(MODEL_RATE_LIMIT_MIN, value)));
})();
// 判据是「这条路由会不会发起外部模型调用」，不是「它的主输出是否由模型生成」。
// assess / red-flags / post-prescription-risk 的主输出确实是确定性的，但三者都先走
// maybeAttachClinicalFactsBackstop（临床事实回补层），指纹未命中缓存时会发生 extract+review
// (+adjudicate) 多次模型调用；post-prescription-risk 还会外呼灵犀审方。
// 把它们移出白名单等于对这部分模型开销完全不限流——限流的目的是护住上游配额与成本，
// 与「输出是否确定性」无关。
const MODEL_API_PATHS = new Set([
  "/api/diagnosis/collect",
  "/api/diagnosis/question",
  "/api/diagnosis/question/interpret",
  "/api/diagnosis/diagnose",
  "/api/diagnosis/prescribe",
  "/api/diagnosis/assess",
  "/api/diagnosis/red-flags",
  "/api/diagnosis/post-prescription-risk",
  "/api/diagnosis/his-scheme",
]);

type ApiAuthAttemptBucket = {
  failures: number;
  resetAt: number;
  lockedUntil?: number;
};

const apiAuthAttempts = new Map<string, ApiAuthAttemptBucket>();
const modelUsage = new Map<string, { requests: number; resetAt: number }>();

function appPath(path: string): string {
  return `${APP_BASE_PATH}${path}`;
}

function appUrl(path: string, req: NextRequest): URL {
  return new URL(appPath(path), req.url);
}

function pathWithoutBasePath(pathname: string): string {
  if (!APP_BASE_PATH) return pathname;
  if (pathname === APP_BASE_PATH) return "/";
  return pathname.startsWith(`${APP_BASE_PATH}/`)
    ? pathname.slice(APP_BASE_PATH.length)
    : pathname;
}

function isApiRequest(req: NextRequest): boolean {
  return pathWithoutBasePath(req.nextUrl.pathname).startsWith("/api/");
}

function withApiIsolationHeaders(req: NextRequest, response: NextResponse): NextResponse {
  if (!isApiRequest(req)) return response;
  response.headers.set("Cache-Control", "private, no-store");
  const vary = new Map<string, string>();
  for (const name of (response.headers.get("Vary") || "").split(",")) {
    const normalized = name.trim();
    if (normalized) vary.set(normalized.toLowerCase(), normalized);
  }
  for (const name of ["x-cdss-customer-id", "x-cdss-api-token", "authorization"]) {
    vary.set(name, name);
  }
  response.headers.set("Vary", [...vary.values()].join(", "));
  return response;
}

function isAuthAccessRequest(req: NextRequest): boolean {
  return pathWithoutBasePath(req.nextUrl.pathname) === "/api/auth/access";
}

function isModelInvocationRequest(req: NextRequest): boolean {
  return req.method.toUpperCase() === "POST" && MODEL_API_PATHS.has(pathWithoutBasePath(req.nextUrl.pathname));
}

function attachRateLimitClientCookie(response: NextResponse, value: string | undefined, req: NextRequest): NextResponse {
  if (!value) return response;
  response.cookies.set(CDSS_RATE_LIMIT_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttpsRequest(req),
    path: getCdssCookiePath(),
    maxAge: CDSS_RATE_LIMIT_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}

async function modelRateLimitResponse(
  req: NextRequest,
): Promise<NextResponse | null> {
  if (!isModelInvocationRequest(req)) return null;
  const now = Date.now();
  if (modelUsage.size > 5_000) {
    for (const [key, bucket] of modelUsage) if (bucket.resetAt <= now) modelUsage.delete(key);
  }
  const key = await getCdssAuthenticatedRateLimitKey(req);
  const current = modelUsage.get(key);
  const bucket = !current || current.resetAt <= now
    ? { requests: 0, resetAt: now + MODEL_RATE_LIMIT_WINDOW_MS }
    : current;
  if (bucket.requests >= MODEL_RATE_LIMIT_REQUESTS) {
    return NextResponse.json(
      { error: "Model invocation rate limit exceeded for this session or API tenant" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))),
          "X-RateLimit-Limit": String(MODEL_RATE_LIMIT_REQUESTS),
          "X-RateLimit-Remaining": "0",
        },
      },
    );
  }
  bucket.requests += 1;
  modelUsage.set(key, bucket);
  return null;
}

function isMutatingRequest(req: NextRequest): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(req.method.toUpperCase());
}

function isSameRequestOrigin(req: NextRequest, suppliedOrigin: string): boolean {
  const expected = cdssRequestOrigin(req);
  if (suppliedOrigin === expected) return true;
  try {
    const supplied = new URL(suppliedOrigin);
    const target = new URL(expected);
    const loopback = (hostname: string) => ["localhost", "127.0.0.1", "::1"].includes(hostname);
    return loopback(supplied.hostname) && loopback(target.hostname) && supplied.protocol === target.protocol && supplied.port === target.port;
  } catch {
    return false;
  }
}

function apiCookieCsrfResponse(req: NextRequest): NextResponse | null {
  if (!isMutatingRequest(req)) return null;
  const origin = req.headers.get("origin")?.trim() || "";
  if (origin && !isSameRequestOrigin(req, origin)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const fetchSite = req.headers.get("sec-fetch-site")?.trim().toLowerCase() || "";
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!origin && !fetchSite) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const contentType = req.headers.get("content-type")?.toLowerCase() || "";
  if (contentType && !contentType.includes("application/json") && !contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Unsupported Media Type" }, { status: 415 });
  }
  return null;
}

async function hasValidUiCookie(req: NextRequest): Promise<boolean> {
  const uiCookie = req.cookies.get(CDSS_UI_COOKIE)?.value || "";
  return Boolean(uiCookie && await isValidCdssUiCookieValue(uiCookie));
}

function suppliedToken(req: NextRequest): string {
  return req.headers.get("x-cdss-api-token") ||
    bearerToken(req.headers.get("authorization"));
}

function getApiAuthAttemptBucket(key: string, now: number): ApiAuthAttemptBucket {
  const current = apiAuthAttempts.get(key);
  if (!current || current.resetAt <= now) {
    const next = { failures: 0, resetAt: now + API_AUTH_RATE_LIMIT_WINDOW_MS };
    apiAuthAttempts.set(key, next);
    return next;
  }
  return current;
}

function apiAuthRetryAfterSeconds(bucket: ApiAuthAttemptBucket, now: number): number {
  return Math.max(1, Math.ceil(((bucket.lockedUntil || bucket.resetAt) - now) / 1000));
}

function apiAuthRateLimitResponse(bucket: ApiAuthAttemptBucket, now: number): NextResponse {
  return NextResponse.json(
    { error: "Too many unauthorized API requests" },
    {
      status: 429,
      headers: { "Retry-After": String(apiAuthRetryAfterSeconds(bucket, now)) },
    },
  );
}

function recordApiAuthFailure(key: string, now: number): ApiAuthAttemptBucket {
  const bucket = getApiAuthAttemptBucket(key, now);
  bucket.failures += 1;
  if (bucket.failures >= MAX_API_AUTH_FAILURES) {
    bucket.lockedUntil = now + API_AUTH_RATE_LIMIT_LOCK_MS;
  }
  apiAuthAttempts.set(key, bucket);
  return bucket;
}

export async function proxy(req: NextRequest) {
  const finalizeApi = (response: NextResponse) => withApiIsolationHeaders(req, response);
  if (isAuthAccessRequest(req)) return finalizeApi(NextResponse.next());
  if (!isCdssAuthRequired()) return finalizeApi(NextResponse.next());
  const token = getCdssAccessToken();
  if (token.length < 16) {
    if (!isApiRequest(req)) {
      return NextResponse.redirect(appUrl("/login?error=not_configured", req));
    }
    return finalizeApi(NextResponse.json(
      { error: "CDSS_API_TOKEN must be configured with at least 16 characters before exposing API endpoints" },
      { status: 503 },
    ));
  }

  const tokenAuthenticated = sameSecret(suppliedToken(req), token);
  const uiAuthenticated = await hasValidUiCookie(req);

  if (!isApiRequest(req)) {
    if (!tokenAuthenticated && !uiAuthenticated) {
      const loginUrl = appUrl("/login", req);
      const originalUrl = new URL(req.url);
      loginUrl.searchParams.set("next", `${originalUrl.pathname}${originalUrl.search}`);
      return NextResponse.redirect(loginUrl);
    }

    const response = NextResponse.next();
    if (tokenAuthenticated && !uiAuthenticated) {
      response.cookies.set(CDSS_UI_COOKIE, await cdssUiCookieValue(token), {
        httpOnly: true,
        sameSite: "lax",
        secure: isHttpsRequest(req),
        path: getCdssCookiePath(),
        maxAge: CDSS_UI_COOKIE_MAX_AGE_SECONDS,
      });
    }
    return response;
  }

  if (!tokenAuthenticated && !uiAuthenticated) {
    const identity = await getCdssRateLimitIdentity(req);
    const key = identity.key;
    const now = Date.now();
    const bucket = getApiAuthAttemptBucket(key, now);
    if (bucket.lockedUntil && bucket.lockedUntil > now) {
      return finalizeApi(attachRateLimitClientCookie(apiAuthRateLimitResponse(bucket, now), identity.cookieToSet, req));
    }
    const nextBucket = recordApiAuthFailure(key, now);
    if (nextBucket.lockedUntil && nextBucket.lockedUntil > now) {
      return finalizeApi(attachRateLimitClientCookie(apiAuthRateLimitResponse(nextBucket, now), identity.cookieToSet, req));
    }
    return finalizeApi(attachRateLimitClientCookie(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      identity.cookieToSet,
      req,
    ));
  }

  if (!tokenAuthenticated && uiAuthenticated) {
    const csrfResponse = apiCookieCsrfResponse(req);
    if (csrfResponse) return finalizeApi(csrfResponse);
  }

  const modelLimited = await modelRateLimitResponse(req);
  if (modelLimited) return finalizeApi(modelLimited);

  return finalizeApi(NextResponse.next());
}

export const config = {
  matcher: ["/", "/diagnosis", "/api/:path*"],
};
