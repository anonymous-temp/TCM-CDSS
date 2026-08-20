import assert from "node:assert/strict";
import { createJiti } from "jiti";

process.env.CDSS_API_TOKEN = "test-customer-context-token-at-least-32-characters";
process.env.CDSS_API_CLIENT_ID = "his-integrator";
process.env.CDSS_API_CUSTOMER_IDS = "hospital-A_01,hospital-B_02,hospital-default";
delete process.env.CDSS_DEFAULT_CUSTOMER_ID;

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { parseCustomerId } = await jiti.import("../src/lib/customer-id.ts");
const { requireCustomerContext } = await jiti.import("../src/lib/customer-context.ts");
const { CDSS_CUSTOMER_COOKIE, cdssCustomerCookieValue } = await jiti.import("../src/lib/cdss-auth.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");

assert.equal(parseCustomerId("hospital-A_01"), "hospital-A_01");
for (const invalid of ["", "abc", "../../other", "hospital A", "医院A", "a".repeat(65)]) {
  assert.equal(parseCustomerId(invalid), undefined, `invalid customer id accepted: ${invalid}`);
}

const missing = await requireCustomerContext(new Request("http://localhost/api/diagnosis/prescribe"));
assert.equal(missing.ok, false);
assert.equal(missing.response.status, 400);
assert.equal((await missing.response.json()).code, "customer_id_required");

process.env.CDSS_DEFAULT_CUSTOMER_ID = "hospital-default";
const defaulted = await requireCustomerContext(new Request("http://localhost/api/diagnosis/prescribe"));
assert.equal(defaulted.ok, true, "过渡期无头部调用方应绑定到显式配置的默认客户");
assert.equal(defaulted.context.customerId, "hospital-default");
assert.equal(defaulted.context.source, "default");
process.env.CDSS_DEFAULT_CUSTOMER_ID = "bad/default";
const invalidDefault = await requireCustomerContext(new Request("http://localhost/api/diagnosis/prescribe"));
assert.equal(invalidDefault.ok, false);
assert.equal(invalidDefault.response.status, 503, "非法默认客户配置不得放行请求");
assert.equal((await invalidDefault.response.json()).code, "customer_authorization_not_configured");
delete process.env.CDSS_DEFAULT_CUSTOMER_ID;

const request = new Request("http://localhost/api/diagnosis/prescribe", {
  headers: { "x-cdss-customer-id": "hospital-A_01" },
});
const valid = await requireCustomerContext(request);
assert.equal(valid.ok, true);
assert.equal(valid.context.customerId, "hospital-A_01");
assert.match(valid.context.customerHash, /^[a-f0-9]{32}$/);
assert.equal(valid.context.clientId, "his-integrator");

const forbidden = await requireCustomerContext(new Request("http://localhost/api/diagnosis/prescribe", {
  headers: { "x-cdss-customer-id": "hospital-C_03" },
}));
assert.equal(forbidden.ok, false);
assert.equal(forbidden.response.status, 403);
assert.equal((await forbidden.response.json()).code, "customer_forbidden");

const mismatch = await requireCustomerContext(request, { customerId: "hospital-B_02" });
assert.equal(mismatch.ok, false);
assert.equal(mismatch.response.status, 409);
assert.equal((await mismatch.response.json()).code, "customer_context_mismatch");

const customerACookie = await cdssCustomerCookieValue("hospital-A_01");
const conflictingIdentitySources = await requireCustomerContext(new Request("http://localhost/api/diagnosis/prescribe", {
  headers: {
    "x-cdss-customer-id": "hospital-B_02",
    cookie: `${CDSS_CUSTOMER_COOKIE}=${customerACookie}`,
  },
}));
assert.equal(conflictingIdentitySources.ok, false, "已签名客户 cookie 不得被另一个请求头静默覆盖");
assert.equal(conflictingIdentitySources.response.status, 409);
assert.equal((await conflictingIdentitySources.response.json()).code, "customer_context_mismatch");

const normalized = normalizeCaseStateInput({
  id: "tenant-case",
  customerId: "hospital-A_01",
  phase: "idle",
  patient: {},
  chiefComplaint: "反酸",
  symptoms: {},
  conversation: [],
});
assert.equal(normalized?.customerId, "hospital-A_01");

console.log(JSON.stringify({ suite: "customer-context", invalid: 6, failures: 0 }));
