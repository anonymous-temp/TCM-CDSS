import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { parseCustomerId } = await jiti.import("../src/lib/customer-id.ts");
const { requireCustomerContext } = await jiti.import("../src/lib/customer-context.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");

assert.equal(parseCustomerId("hospital-A_01"), "hospital-A_01");
for (const invalid of ["", "abc", "../../other", "hospital A", "医院A", "a".repeat(65)]) {
  assert.equal(parseCustomerId(invalid), undefined, `invalid customer id accepted: ${invalid}`);
}

const missing = await requireCustomerContext(new Request("http://localhost/api/diagnosis/prescribe"));
assert.equal(missing.ok, false);
assert.equal(missing.response.status, 400);
assert.equal((await missing.response.json()).code, "customer_id_required");

const request = new Request("http://localhost/api/diagnosis/prescribe", {
  headers: { "x-cdss-customer-id": "hospital-A_01" },
});
const valid = await requireCustomerContext(request);
assert.equal(valid.ok, true);
assert.equal(valid.context.customerId, "hospital-A_01");
assert.match(valid.context.customerHash, /^[a-f0-9]{32}$/);

const mismatch = await requireCustomerContext(request, { customerId: "hospital-B_02" });
assert.equal(mismatch.ok, false);
assert.equal(mismatch.response.status, 409);
assert.equal((await mismatch.response.json()).code, "customer_context_mismatch");

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
