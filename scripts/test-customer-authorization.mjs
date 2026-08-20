import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const {
  authorizeCustomerId,
  getCustomerAuthorizationStatus,
} = await jiti.import("../src/lib/customer-authorization.ts");

function configure({ clientId, customerIds, defaultCustomerId } = {}) {
  if (clientId === undefined) delete process.env.CDSS_API_CLIENT_ID;
  else process.env.CDSS_API_CLIENT_ID = clientId;
  if (customerIds === undefined) delete process.env.CDSS_API_CUSTOMER_IDS;
  else process.env.CDSS_API_CUSTOMER_IDS = customerIds;
  if (defaultCustomerId === undefined) delete process.env.CDSS_DEFAULT_CUSTOMER_ID;
  else process.env.CDSS_DEFAULT_CUSTOMER_ID = defaultCustomerId;
}

configure({
  clientId: "his-integrator",
  customerIds: "hospital-A,hospital-B",
  defaultCustomerId: "hospital-A",
});
assert.deepEqual(getCustomerAuthorizationStatus(), {
  configured: true,
  valid: true,
  clientConfigured: true,
  customerCount: 2,
  ready: true,
});
assert.deepEqual(authorizeCustomerId("hospital-A", true), {
  ok: true,
  clientId: "his-integrator",
  customerId: "hospital-A",
});
assert.deepEqual(authorizeCustomerId("hospital-B", true), {
  ok: true,
  clientId: "his-integrator",
  customerId: "hospital-B",
});
assert.deepEqual(authorizeCustomerId("hospital-C", true), {
  ok: false,
  status: 403,
  code: "customer_forbidden",
});
assert.equal(JSON.stringify(getCustomerAuthorizationStatus()).includes("hospital-A"), false);

for (const customerIds of [
  "hospital-A,",
  ",hospital-A",
  "hospital-A,,hospital-B",
  "hospital-A,hospital-A",
  "hospital-A,../../other",
]) {
  configure({ clientId: "his-integrator", customerIds });
  const status = getCustomerAuthorizationStatus();
  assert.equal(status.configured, true, `配置存在却被误报缺失: ${customerIds}`);
  assert.equal(status.valid, false, `非法白名单被接受: ${customerIds}`);
  assert.equal(status.ready, false);
  assert.equal(status.customerCount, 0, "非法配置不得回报部分客户数");
  assert.deepEqual(authorizeCustomerId("hospital-A", true), {
    ok: false,
    status: 503,
    code: "customer_authorization_not_configured",
  });
}

configure({ clientId: "bad/client", customerIds: "hospital-A" });
assert.deepEqual(getCustomerAuthorizationStatus(), {
  configured: true,
  valid: true,
  clientConfigured: false,
  customerCount: 1,
  ready: false,
});

configure({ clientId: "his-integrator", customerIds: "hospital-A", defaultCustomerId: "hospital-B" });
assert.equal(getCustomerAuthorizationStatus().valid, false, "默认客户不在白名单却通过配置校验");
assert.equal(getCustomerAuthorizationStatus().ready, false);

configure({
  clientId: "his-integrator",
  customerIds: Array.from({ length: 1001 }, (_, index) => `tenant-${String(index).padStart(6, "0")}`).join(","),
});
assert.equal(getCustomerAuthorizationStatus().valid, false, "超过 1000 个客户的配置必须拒绝");
assert.equal(getCustomerAuthorizationStatus().customerCount, 0);

configure();
assert.deepEqual(getCustomerAuthorizationStatus(), {
  configured: false,
  valid: false,
  clientConfigured: false,
  customerCount: 0,
  ready: false,
});
assert.deepEqual(authorizeCustomerId("hospital-A", true), {
  ok: false,
  status: 503,
  code: "customer_authorization_not_configured",
});
assert.deepEqual(authorizeCustomerId("hospital-A", false), {
  ok: true,
  clientId: "local-development",
  customerId: "hospital-A",
});
assert.deepEqual(authorizeCustomerId("../../other", false), {
  ok: false,
  status: 403,
  code: "customer_forbidden",
});

console.log(JSON.stringify({ suite: "customer-authorization", configurations: 12, failures: 0 }));
