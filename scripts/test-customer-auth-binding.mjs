import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

process.env.CDSS_API_TOKEN = "test-shared-delivery-token-at-least-32-characters";
process.env.CDSS_REQUIRE_API_AUTH = "true";
process.env.CDSS_API_CLIENT_ID = "his-integrator";
process.env.CDSS_API_CUSTOMER_IDS = "hospital-A,hospital-B";
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const {
  CDSS_CUSTOMER_COOKIE,
  cdssCustomerCookieValue,
  customerIdFromCdssCustomerCookieValue,
} = await jiti.import("../src/lib/cdss-auth.ts");
const { POST } = await jiti.import("../src/app/api/auth/access/route.ts");

const a = await cdssCustomerCookieValue("hospital-A");
const b = await cdssCustomerCookieValue("hospital-B");
assert.notEqual(a, b);
assert.equal(await customerIdFromCdssCustomerCookieValue(a), "hospital-A");
assert.equal(await customerIdFromCdssCustomerCookieValue(`${a}tampered`), undefined);

const login = await POST(new Request("http://localhost/api/auth/access", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: process.env.CDSS_API_TOKEN, customerId: "hospital-A" }),
}));
assert.equal(login.status, 200);
assert.match(login.headers.get("set-cookie") || "", new RegExp(`${CDSS_CUSTOMER_COOKIE}=`));
assert.equal((await login.json()).customerId, "hospital-A");

const invalid = await POST(new Request("http://localhost/api/auth/access", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: process.env.CDSS_API_TOKEN, customerId: "../../other" }),
}));
assert.equal(invalid.status, 400);
const invalidBody = await invalid.json();
assert.equal(invalidBody.code, "invalid_customer_id");
assert.deepEqual(invalidBody.customerOptions, ["hospital-A", "hospital-B"]);
assert.match(invalid.headers.get("cache-control") || "", /private/i);
assert.match(invalid.headers.get("cache-control") || "", /no-store/i);

const forbidden = await POST(new Request("http://localhost/api/auth/access", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: process.env.CDSS_API_TOKEN, customerId: "hospital-C" }),
}));
assert.equal(forbidden.status, 403);
const forbiddenBody = await forbidden.json();
assert.equal(forbiddenBody.code, "customer_forbidden");
assert.deepEqual(forbiddenBody.customerOptions, ["hospital-A", "hospital-B"]);
assert.doesNotMatch(forbidden.headers.get("set-cookie") || "", new RegExp(`${CDSS_CUSTOMER_COOKIE}=`));

const wrongToken = await POST(new Request("http://localhost/api/auth/access", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "wrong-token-with-enough-characters", customerId: "1" }),
}));
assert.equal(wrongToken.status, 401);
const wrongTokenBody = await wrongToken.json();
assert.equal(wrongTokenBody.code, undefined);
assert.equal(wrongTokenBody.customerOptions, undefined,
  "错误口令绝不得枚举已授权客户");

const loginPageSource = readFileSync("src/app/login/page.tsx", "utf8");
assert.match(loginPageSource, /customerOptions/,
  "登录页必须消费口令验证后的客户选项");
assert.match(loginPageSource, /<select[\s\S]*已授权客户/,
  "多个已授权客户必须由用户显式选择，不得按配置顺序猜租户");

console.log(JSON.stringify({ suite: "customer-auth-binding", cases: 10, failures: 0 }));
