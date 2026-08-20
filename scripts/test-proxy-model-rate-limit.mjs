import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

process.env.CDSS_REQUIRE_API_AUTH = "true";
process.env.CDSS_API_TOKEN = "test-tenant-token-at-least-32-characters";
process.env.CDSS_MODEL_RATE_LIMIT_PER_10_MIN = "10";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { proxy } = jiti("../src/proxy.ts");
const { cdssRateLimitIdentityConfigured, cdssRequestOrigin, getCdssRateLimitIdentity } = jiti("../src/lib/cdss-auth.ts");

function request(path, token = process.env.CDSS_API_TOKEN, customerId = "hospital-A_01") {
  return new NextRequest(`https://cdss.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cdss-api-token": token,
      "x-cdss-customer-id": customerId,
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

const otherCustomerFirstRequest = await proxy(request(
  "/api/diagnosis/diagnose",
  process.env.CDSS_API_TOKEN,
  "hospital-B_02",
));
assert.notEqual(otherCustomerFirstRequest.status, 429, "客户 A 耗尽模型预算不得连坐客户 B 的首个请求");

// 判据是**调用链会不会发起模型调用**，不是「主输出是否确定性」。这四条路由的主输出都确定性，
// 但都先走 maybeAttachClinicalFactsBackstop（assess:31 / red-flags:21 /
// post-prescription-risk:27 / his-scheme:52），指纹未命中缓存即产生模型调用，必须计入预算。
for (const path of [
  "/api/diagnosis/assess",
  "/api/diagnosis/red-flags",
  "/api/diagnosis/post-prescription-risk",
  "/api/diagnosis/his-scheme",
]) {
  const modelInvokingRoute = await proxy(request(path));
  assert.equal(
    modelInvokingRoute.status,
    429,
    `${path} 会经临床事实回补层发起模型调用，必须计入限流预算`,
  );
}

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

// ─── 限流配置：超范围钳到边界，不得静默回落默认值 ───
// 原实现对任何超范围值都回落 60。本仓 .env.local 写的 100000 因此一直静默变成 60——
// 配置方明确要一个高限值却拿到全局最低值，与意图完全相反且无任何提示；
// 实测把黄金基线 386 次调用打出 237 个 429，看上去像产品回归，根因只是这个静默回落。
const proxySource = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");
assert.match(proxySource, /Math\.min\(MODEL_RATE_LIMIT_MAX, Math\.max\(MODEL_RATE_LIMIT_MIN, value\)\)/,
  "超范围的限流配置必须钳到边界，而不是回落默认值");
assert.doesNotMatch(proxySource, /value >= 10 && value <= 2_000 \? Math\.round\(value\) : 60/,
  "不得恢复「超范围即回落 60」的旧写法");

console.log(JSON.stringify({ cases: 23, failures: 0 }));
