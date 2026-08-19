import { CUSTOMER_ID_HEADER, parseCustomerId } from "./customer-id";

export const CDSS_UI_COOKIE = "tcm_cdss_ui_access";
export const CDSS_UI_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12;
export const CDSS_CUSTOMER_COOKIE = "tcm_cdss_customer_context";
export const CDSS_CUSTOMER_COOKIE_MAX_AGE_SECONDS = CDSS_UI_COOKIE_MAX_AGE_SECONDS;
export const CDSS_RATE_LIMIT_COOKIE = "tcm_cdss_rate_limit_client";
export const CDSS_RATE_LIMIT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12;

export type CdssRateLimitIdentity = Readonly<{
  key: string;
  cookieToSet?: string;
}>;

export function getCdssAccessToken(): string {
  return process.env.CDSS_API_TOKEN || "";
}

export function getCdssBasePath(): string {
  const value = (process.env.NEXT_PUBLIC_BASE_PATH || "").trim();
  if (!value || value === "/") return "";
  if (!value.startsWith("/") || value.endsWith("/") || value.includes("\\")) return "";
  return value;
}

export function getCdssCookiePath(): string {
  return getCdssBasePath() || "/";
}

export function isCdssAuthRequired(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  if (process.env.CDSS_REQUIRE_API_AUTH === "false") return false;
  return (
    process.env.CDSS_REQUIRE_API_AUTH === "true" ||
    Boolean(getCdssAccessToken())
  );
}

async function hmacHex(payload: string, token: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`tcm-cdss-ui:${token}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function stableIdentityHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function requestCookie(req: Request, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`))?.[1] || "";
}

async function cdssRateLimitCookieValue(token = getCdssAccessToken(), now = Date.now()): Promise<string> {
  const expiresAt = Math.floor(now / 1000) + CDSS_RATE_LIMIT_COOKIE_MAX_AGE_SECONDS;
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = Array.from(nonceBytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const payload = `client.v1.${expiresAt}.${nonce}`;
  return `v1.${expiresAt}.${nonce}.${await hmacHex(payload, token)}`;
}

async function isValidCdssRateLimitCookie(value: string, token = getCdssAccessToken(), now = Date.now()): Promise<boolean> {
  const match = value.match(/^v1\.(\d{10})\.([a-f0-9]{32})\.([a-f0-9]{64})$/);
  if (!match || token.length < 16) return false;
  const expiresAt = Number(match[1]);
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds || expiresAt > nowSeconds + CDSS_RATE_LIMIT_COOKIE_MAX_AGE_SECONDS + 60) return false;
  return sameSecret(match[3], await hmacHex(`client.v1.${expiresAt}.${match[2]}`, token));
}

export async function cdssUiCookieValue(token = getCdssAccessToken(), now = Date.now()): Promise<string> {
  const expiresAt = Math.floor(now / 1000) + CDSS_UI_COOKIE_MAX_AGE_SECONDS;
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = Array.from(nonceBytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const payload = `v2.${expiresAt}.${nonce}`;
  return `${payload}.${await hmacHex(payload, token)}`;
}

export async function cdssCustomerCookieValue(
  customerIdInput: string,
  token = getCdssAccessToken(),
  now = Date.now(),
): Promise<string> {
  const customerId = parseCustomerId(customerIdInput);
  if (!customerId || token.length < 16) throw new Error("Cannot create customer cookie without valid customer context");
  const expiresAt = Math.floor(now / 1000) + CDSS_CUSTOMER_COOKIE_MAX_AGE_SECONDS;
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = Array.from(nonceBytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const payload = `customer.v1.${expiresAt}.${customerId}.${nonce}`;
  return `v1.${expiresAt}.${customerId}.${nonce}.${await hmacHex(payload, token)}`;
}

export async function customerIdFromCdssCustomerCookieValue(
  value: string,
  token = getCdssAccessToken(),
  now = Date.now(),
): Promise<string | undefined> {
  const match = value.match(/^v1\.(\d{10})\.([A-Za-z0-9_-]{6,64})\.([a-f0-9]{32})\.([a-f0-9]{64})$/);
  if (!match || token.length < 16) return undefined;
  const expiresAt = Number(match[1]);
  const nowSeconds = Math.floor(now / 1000);
  const customerId = parseCustomerId(match[2]);
  if (!customerId || !Number.isFinite(expiresAt) || expiresAt <= nowSeconds ||
      expiresAt > nowSeconds + CDSS_CUSTOMER_COOKIE_MAX_AGE_SECONDS + 60) return undefined;
  const expected = await hmacHex(`customer.v1.${expiresAt}.${customerId}.${match[3]}`, token);
  return sameSecret(match[4], expected) ? customerId : undefined;
}

export async function customerIdFromCdssRequestCookie(req: Request): Promise<string | undefined> {
  const value = requestCookie(req, CDSS_CUSTOMER_COOKIE);
  return value ? customerIdFromCdssCustomerCookieValue(value) : undefined;
}

export async function isValidCdssUiCookieValue(
  value: string,
  token = getCdssAccessToken(),
  now = Date.now(),
): Promise<boolean> {
  const match = value.match(/^(v1)\.(\d{10})\.([a-f0-9]{64})$/) ||
    value.match(/^(v2)\.(\d{10})\.([a-f0-9]{32})\.([a-f0-9]{64})$/);
  if (!match || !token) return false;
  const version = match[1];
  const expiresAt = Number(match[2]);
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds || expiresAt > nowSeconds + CDSS_UI_COOKIE_MAX_AGE_SECONDS + 60) return false;
  const payload = version === "v2" ? `v2.${expiresAt}.${match[3]}` : `v1.${expiresAt}`;
  const signature = version === "v2" ? match[4] : match[3];
  return sameSecret(signature, await hmacHex(payload, token));
}

export function sameSecret(input: string, expected: string): boolean {
  if (!input || !expected) return false;
  const inputBytes = new TextEncoder().encode(input);
  const expectedBytes = new TextEncoder().encode(expected);
  const length = Math.max(inputBytes.length, expectedBytes.length);
  let diff = inputBytes.length ^ expectedBytes.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (inputBytes[index] || 0) ^ (expectedBytes[index] || 0);
  }
  return diff === 0;
}

export function bearerToken(value: string | null): string {
  if (!value) return "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

export function cdssClientKey(req: Request): string {
  if (process.env.CDSS_TRUST_PROXY_HEADERS !== "true") return "untrusted-direct";
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  if (process.env.CDSS_TRUST_CF_CONNECTING_IP === "true") {
    const cfConnectingIp = req.headers.get("cf-connecting-ip")?.trim();
    if (cfConnectingIp) return cfConnectingIp;
  }
  const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (process.env.CDSS_TRUST_X_FORWARDED_FOR === "true" &&
      process.env.CDSS_ALLOW_X_FORWARDED_FOR_CLIENT_KEY === "true" && forwardedFor) return forwardedFor;
  return "trusted-proxy-unknown";
}

/**
 * Rate-limit identity for unauthenticated requests. A trusted reverse proxy supplies the network
 * identity in production. Direct/local browser traffic gets a short-lived, server-signed random
 * identity; a deterministic bootstrap key still bounds clients that discard response cookies.
 */
export async function getCdssRateLimitIdentity(req: Request): Promise<CdssRateLimitIdentity> {
  if (process.env.CDSS_TRUST_PROXY_HEADERS === "true") {
    return { key: `network:${cdssClientKey(req)}` };
  }
  const existing = requestCookie(req, CDSS_RATE_LIMIT_COOKIE);
  if (existing && await isValidCdssRateLimitCookie(existing)) {
    return { key: `browser:${await stableIdentityHash(existing)}` };
  }
  const bootstrapFingerprint = [
    new URL(req.url).origin,
    req.headers.get("user-agent") || "no-user-agent",
    req.headers.get("accept-language") || "no-language",
    req.headers.get("sec-ch-ua") || "no-client-hints",
    req.headers.get("sec-ch-ua-platform") || "no-platform",
  ].join("\n");
  return {
    key: `bootstrap:${await stableIdentityHash(bootstrapFingerprint)}`,
    ...(getCdssAccessToken().length >= 16
      ? { cookieToSet: await cdssRateLimitCookieValue() }
      : {}),
  };
}

/** Authenticated resource budgets are scoped to a UI session or API tenant, never a shared IP. */
export async function getCdssAuthenticatedRateLimitKey(req: Request): Promise<string> {
  const expected = getCdssAccessToken();
  const supplied = req.headers.get("x-cdss-api-token") || bearerToken(req.headers.get("authorization"));
  const customerId = parseCustomerId(req.headers.get(CUSTOMER_ID_HEADER)) || await customerIdFromCdssRequestCookie(req);
  const customerScope = customerId ? await stableIdentityHash(customerId) : "customer-missing";
  if (sameSecret(supplied, expected)) return `tenant:${await stableIdentityHash(supplied)}:${customerScope}`;
  const uiCookie = requestCookie(req, CDSS_UI_COOKIE);
  if (uiCookie && await isValidCdssUiCookieValue(uiCookie, expected)) {
    return `session:${await stableIdentityHash(uiCookie)}:${customerScope}`;
  }
  return (await getCdssRateLimitIdentity(req)).key;
}

/** Public production is release-ready only when the edge supplies a non-spoofable client identity. */
export function cdssRateLimitIdentityConfigured(): boolean {
  return process.env.CDSS_TRUST_PROXY_HEADERS === "true";
}

function firstForwardedValue(value: string | null): string {
  return value?.split(",")[0]?.trim() || "";
}

function requestUrlOrigin(req: Request): string {
  return new URL(req.url).origin;
}

function isLoopbackHost(req: Request): boolean {
  const hostname = new URL(req.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function cdssRequestOrigin(req: Request): string {
  if (process.env.CDSS_TRUST_PROXY_HEADERS !== "true") return requestUrlOrigin(req);
  const forwardedProto = firstForwardedValue(req.headers.get("x-forwarded-proto"));
  const proto = forwardedProto || new URL(req.url).protocol.replace(/:$/, "");
  if (proto !== "http" && proto !== "https") return requestUrlOrigin(req);

  const forwardedHost = firstForwardedValue(req.headers.get("x-forwarded-host"));
  const host = forwardedHost || req.headers.get("host")?.trim() || "";
  // A forwarded host is an authority only: never accept URL userinfo, paths, queries or fragments.
  if (!host || /[\s/\\@?#]/.test(host)) return requestUrlOrigin(req);

  try {
    const parsed = new URL(`${proto}://${host}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return requestUrlOrigin(req);
    }
    return parsed.origin;
  } catch {
    return requestUrlOrigin(req);
  }
}

export function isHttpsRequest(req: Request): boolean {
  if (process.env.CDSS_SECURE_COOKIE === "true") return true;
  if (process.env.CDSS_SECURE_COOKIE === "false") return false;
  // Only trust a forwarded-proto header when explicitly behind a trusted proxy (same gate as the
  // login rate-limit IP trust) — otherwise a client-supplied header must not influence the cookie
  // Secure flag. In the documented production topology CDSS_TRUST_PROXY_HEADERS=true.
  if (process.env.CDSS_TRUST_PROXY_HEADERS === "true" || isLoopbackHost(req)) {
    return firstForwardedValue(req.headers.get("x-forwarded-proto")) === "https";
  }
  return new URL(req.url).protocol === "https:" && !req.headers.has("x-forwarded-proto");
}
