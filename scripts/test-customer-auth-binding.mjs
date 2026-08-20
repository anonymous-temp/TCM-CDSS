import assert from "node:assert/strict";
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
assert.equal((await invalid.json()).code, "invalid_customer_id");

const forbidden = await POST(new Request("http://localhost/api/auth/access", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: process.env.CDSS_API_TOKEN, customerId: "hospital-C" }),
}));
assert.equal(forbidden.status, 403);
assert.equal((await forbidden.json()).code, "customer_forbidden");
assert.doesNotMatch(forbidden.headers.get("set-cookie") || "", new RegExp(`${CDSS_CUSTOMER_COOKIE}=`));

console.log(JSON.stringify({ suite: "customer-auth-binding", failures: 0 }));
