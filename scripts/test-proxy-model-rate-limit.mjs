import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

process.env.CDSS_REQUIRE_API_AUTH = "true";
process.env.CDSS_API_TOKEN = "test-tenant-token-at-least-32-characters";
process.env.CDSS_MODEL_RATE_LIMIT_PER_10_MIN = "10";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { proxy } = jiti("../src/proxy.ts");
const { cdssRateLimitIdentityConfigured, cdssRequestOrigin, getCdssRateLimitIdentity } = jiti("../src/lib/cdss-auth.ts");

function request(path, token = process.env.CDSS_API_TOKEN) {
  return new NextRequest(`https://cdss.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cdss-api-token": token,
    },
  });
}

for (let index = 0; index < 10; index += 1) {
  const response = await proxy(request("/api/diagnosis/diagnose"));
  assert.notEqual(response.status, 429, `tenant request ${index + 1} remains within its budget`);
}
const limited = await proxy(request("/api/diagnosis/prescribe"));
assert.equal(limited.status, 429);
assert.ok(Number(limited.headers.get("retry-after")) > 0);
assert.equal(limited.headers.get("x-ratelimit-limit"), "10");
assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");

const cheapRoute = await proxy(request("/api/diagnosis/his-scheme"));
assert.notEqual(cheapRoute.status, 429, "non-model API calls are not consumed by the model budget");

const unauthorized = await proxy(request("/api/diagnosis/diagnose", "wrong-token-that-is-long-enough"));
assert.equal(unauthorized.status, 401, "rate limiting never substitutes for authentication");

const firstDirect = await getCdssRateLimitIdentity(new Request("https://cdss.example/login", {
  headers: { "user-agent": "browser-a", "accept-language": "zh-CN" },
}));
assert.match(firstDirect.key, /^bootstrap:/);
assert.match(firstDirect.cookieToSet || "", /^v1\./);
const sameBrowser = await getCdssRateLimitIdentity(new Request("https://cdss.example/login", {
  headers: { cookie: `tcm_cdss_rate_limit_client=${firstDirect.cookieToSet}` },
}));
assert.match(sameBrowser.key, /^browser:/);

process.env.CDSS_TRUST_PROXY_HEADERS = "true";
assert.equal(cdssRateLimitIdentityConfigured(), true);
const internalUrl = "http://127.0.0.1:3000/api/diagnosis/health";
assert.equal(cdssRequestOrigin(new Request(internalUrl, {
  headers: { "x-forwarded-proto": "https", "x-forwarded-host": "attacker@example.com" },
})), "http://127.0.0.1:3000", "forwarded host userinfo is rejected");
assert.equal(cdssRequestOrigin(new Request(internalUrl, {
  headers: { "x-forwarded-proto": "https", "x-forwarded-host": "cdss.example" },
})), "https://cdss.example", "valid proxy authority is accepted");

console.log(JSON.stringify({ cases: 20, failures: 0 }));
