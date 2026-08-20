import { NextResponse } from "next/server";
import {
  CDSS_UI_COOKIE,
  CDSS_UI_COOKIE_MAX_AGE_SECONDS,
  cdssUiCookieValue,
  CDSS_CUSTOMER_COOKIE,
  CDSS_CUSTOMER_COOKIE_MAX_AGE_SECONDS,
  cdssCustomerCookieValue,
  CDSS_RATE_LIMIT_COOKIE,
  CDSS_RATE_LIMIT_COOKIE_MAX_AGE_SECONDS,
  getCdssAccessToken,
  getCdssCookiePath,
  getCdssRateLimitIdentity,
  isCdssAuthRequired,
  isHttpsRequest,
  sameSecret,
} from "@/lib/cdss-auth";
import { readJsonBodyWithLimit } from "@/lib/http-guard";
import { parseCustomerId } from "@/lib/customer-id";
import { authorizeCustomerId } from "@/lib/customer-authorization";

export const dynamic = "force-dynamic";

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_LOCK_MS = 10 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 8;
const MAX_LOGIN_BODY_BYTES = 4096;
const MAX_LOGIN_TOKEN_CHARS = 512;

type LoginAttemptBucket = {
  failures: number;
  resetAt: number;
  lockedUntil?: number;
};

const loginAttempts = new Map<string, LoginAttemptBucket>();

function getAttemptBucket(key: string, now: number): LoginAttemptBucket {
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    const next = { failures: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    loginAttempts.set(key, next);
    return next;
  }
  return current;
}

function retryAfterSeconds(bucket: LoginAttemptBucket, now: number): number {
  return Math.max(1, Math.ceil(((bucket.lockedUntil || bucket.resetAt) - now) / 1000));
}

function rateLimitResponse(bucket: LoginAttemptBucket, now: number): NextResponse {
  return NextResponse.json(
    { ok: false, error: "访问尝试过多，请稍后再试" },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds(bucket, now)) },
    },
  );
}

function recordFailedAttempt(key: string, now: number): LoginAttemptBucket {
  const bucket = getAttemptBucket(key, now);
  bucket.failures += 1;
  if (bucket.failures >= MAX_FAILED_ATTEMPTS) {
    bucket.lockedUntil = now + RATE_LIMIT_LOCK_MS;
  }
  loginAttempts.set(key, bucket);
  return bucket;
}

export async function POST(req: Request) {
  if (!isCdssAuthRequired()) {
    return NextResponse.json({ ok: true, authRequired: false });
  }

  const expectedToken = getCdssAccessToken();
  if (!expectedToken) {
    return NextResponse.json(
      { ok: false, error: "CDSS_API_TOKEN is not configured" },
      { status: 503 },
    );
  }

  const identity = await getCdssRateLimitIdentity(req);
  const finalize = (response: NextResponse): NextResponse => {
    if (identity.cookieToSet) {
      response.cookies.set(CDSS_RATE_LIMIT_COOKIE, identity.cookieToSet, {
        httpOnly: true,
        sameSite: "lax",
        secure: isHttpsRequest(req),
        path: getCdssCookiePath(),
        maxAge: CDSS_RATE_LIMIT_COOKIE_MAX_AGE_SECONDS,
      });
    }
    return response;
  };
  const key = identity.key;
  const now = Date.now();
  const bucket = getAttemptBucket(key, now);
  if (bucket.lockedUntil && bucket.lockedUntil > now) {
    return finalize(rateLimitResponse(bucket, now));
  }

  const parsed = await readJsonBodyWithLimit(req, MAX_LOGIN_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body && typeof parsed.body === "object" ? parsed.body as { token?: unknown; customerId?: unknown } : {};
  const token = typeof body?.token === "string" ? body.token.trim().slice(0, MAX_LOGIN_TOKEN_CHARS) : "";
  if (!sameSecret(token, expectedToken)) {
    const nextBucket = recordFailedAttempt(key, now);
    if (nextBucket.lockedUntil && nextBucket.lockedUntil > now) {
      return finalize(rateLimitResponse(nextBucket, now));
    }
    return finalize(NextResponse.json({ ok: false, error: "访问口令不正确" }, { status: 401 }));
  }

  const customerId = parseCustomerId(body.customerId);
  if (!customerId) {
    return finalize(NextResponse.json(
      { ok: false, error: "客户标识格式不正确", code: "invalid_customer_id" },
      { status: 400 },
    ));
  }
  const customerAuthorization = authorizeCustomerId(customerId, true);
  if (!customerAuthorization.ok) {
    return finalize(NextResponse.json(
      {
        ok: false,
        error: customerAuthorization.code === "customer_forbidden"
          ? "客户标识未获授权"
          : "客户授权配置未就绪",
        code: customerAuthorization.code,
      },
      { status: customerAuthorization.status },
    ));
  }

  loginAttempts.delete(key);
  const response = NextResponse.json({ ok: true, customerId: customerAuthorization.customerId });
  response.cookies.set(CDSS_UI_COOKIE, await cdssUiCookieValue(expectedToken), {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttpsRequest(req),
    path: getCdssCookiePath(),
    maxAge: CDSS_UI_COOKIE_MAX_AGE_SECONDS,
  });
  response.cookies.set(CDSS_CUSTOMER_COOKIE, await cdssCustomerCookieValue(customerAuthorization.customerId, expectedToken), {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttpsRequest(req),
    path: getCdssCookiePath(),
    maxAge: CDSS_CUSTOMER_COOKIE_MAX_AGE_SECONDS,
  });
  return finalize(response);
}
