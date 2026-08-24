import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const temporaryRoot = await mkdtemp(join(tmpdir(), "tcm-cdss-customer-jit-"));
process.env.CDSS_API_TOKEN = "test-jit-token-at-least-32-characters-long";
process.env.CDSS_API_CLIENT_ID = "his-integrator";
process.env.CDSS_API_CUSTOMER_IDS = "hospital-static";
process.env.CDSS_CUSTOMER_JIT_ENABLED = "true";
process.env.CDSS_CUSTOMER_JIT_MAX_CUSTOMERS = "4";
process.env.CDSS_CUSTOMER_REGISTRY_PATH = join(temporaryRoot, "customer-registry.json");
process.env.CDSS_TENANT_AUDIT_PATH = join(temporaryRoot, "tenant-audit.ndjson");
process.env.CDSS_DRUG_INVENTORY_PATH = join(temporaryRoot, "drug-inventory");

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });

try {
  const { requireCustomerContext } = await jiti.import("../src/lib/customer-context.ts");
  const { authorizeCustomerId, getCustomerAuthorizationStatus } = await jiti.import("../src/lib/customer-authorization.ts");
  const {
    recordTenantAuditEvent,
    queryTenantAuditEvents,
    tenantAuditCustomerHash,
  } = await jiti.import("../src/lib/tenant-audit.server.ts");
  const inventoryRoute = await jiti.import("../src/app/api/drug-inventory/route.ts");
  const registerRoute = await jiti.import("../src/app/api/customers/register/route.ts");

  const request = (customerId, idempotencyKey) => new Request("http://localhost/api/drug-inventory", {
    method: "POST",
    headers: {
      "x-cdss-customer-id": customerId,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
  });

  assert.deepEqual(authorizeCustomerId("hospital-new", true), {
    ok: false,
    status: 403,
    code: "customer_forbidden",
  });

  const missingKey = await requireCustomerContext(request("hospital-new"), undefined, {
    allowJitProvisioning: true,
  });
  assert.equal(missingKey.ok, false);
  assert.equal(missingKey.response.status, 400);
  assert.equal((await missingKey.response.json()).code, "idempotency_key_required");

  const created = await requireCustomerContext(request("hospital-new", "inventory-import-001"), undefined, {
    allowJitProvisioning: true,
    idempotencyKey: "inventory-import-001",
  });
  assert.equal(created.ok, true);
  assert.equal(created.context.provisioned, true);
  assert.deepEqual(authorizeCustomerId("hospital-new", true), {
    ok: true,
    clientId: "his-integrator",
    customerId: "hospital-new",
  });

  const replay = await requireCustomerContext(request("hospital-new", "inventory-import-001"), undefined, {
    allowJitProvisioning: true,
    idempotencyKey: "inventory-import-001",
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.context.provisioned, undefined);

  const explicitMissingKey = await registerRoute.POST(new Request("http://localhost/api/customers/register", {
    method: "POST",
    headers: { "x-cdss-customer-id": "hospital-new" },
  }));
  assert.equal(explicitMissingKey.status, 400,
    "explicit registration must enforce Idempotency-Key even for an active customer");
  assert.equal((await explicitMissingKey.json()).code, "idempotency_key_required");

  const explicitReplay = await registerRoute.POST(new Request("http://localhost/api/customers/register", {
    method: "POST",
    headers: {
      "x-cdss-customer-id": "hospital-new",
      "idempotency-key": "inventory-import-001",
    },
  }));
  assert.equal(explicitReplay.status, 200);
  assert.equal((await explicitReplay.json()).created, false);

  const explicitDifferentKey = await registerRoute.POST(new Request("http://localhost/api/customers/register", {
    method: "POST",
    headers: {
      "x-cdss-customer-id": "hospital-new",
      "idempotency-key": "inventory-import-different-002",
    },
  }));
  assert.equal(explicitDifferentKey.status, 409,
    "an active registration must not silently accept an unbound idempotency key");
  assert.equal((await explicitDifferentKey.json()).code, "idempotency_conflict");

  const staticRegistration = await registerRoute.POST(new Request("http://localhost/api/customers/register", {
    method: "POST",
    headers: {
      "x-cdss-customer-id": "hospital-static",
      "idempotency-key": "static-registration-001",
    },
  }));
  assert.equal(staticRegistration.status, 200);
  assert.equal((await staticRegistration.json()).created, false,
    "a statically authorized customer is already active and must not consume JIT quota twice");

  const conflict = await requireCustomerContext(request("hospital-other", "inventory-import-001"), undefined, {
    allowJitProvisioning: true,
    idempotencyKey: "inventory-import-001",
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.response.status, 409);
  assert.equal((await conflict.response.json()).code, "idempotency_conflict");

  const firstInventoryWrite = await inventoryRoute.POST(new Request("http://localhost/api/drug-inventory", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cdss-customer-id": "hospital-route",
      "idempotency-key": "inventory-route-first-write-001",
      "x-request-id": "patient-zhangsan-inpatient-123456",
    },
    body: JSON.stringify({ source: "jit-route-regression", items: [] }),
  }));
  assert.equal(firstInventoryWrite.status, 200,
    `first inventory POST must provision and persist a valid unknown customer: ${await firstInventoryWrite.text()}`);
  assert.equal(firstInventoryWrite.headers.get("x-cdss-customer-id"), "hospital-route");
  assert.equal(authorizeCustomerId("hospital-route", true).ok, true);
  const persistedRegistry = JSON.parse(await readFile(process.env.CDSS_CUSTOMER_REGISTRY_PATH, "utf8"));
  assert.equal(persistedRegistry.customers.every((customer) => customer.status === "active"), true,
    "successful registrations must finish the provisioning -> active transition");

  const auditPathBeforeInventoryFailure = process.env.CDSS_TENANT_AUDIT_PATH;
  process.env.CDSS_TENANT_AUDIT_PATH = temporaryRoot;
  try {
    const rejectedBeforeMutation = await inventoryRoute.POST(new Request("http://localhost/api/drug-inventory", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cdss-customer-id": "hospital-route",
      },
      body: JSON.stringify({
        source: "患者张三-住院号123456",
        items: [{ name: "黄芪", kind: "herb", available: true }],
      }),
    }));
    assert.equal(rejectedBeforeMutation.status, 503,
      "an unavailable audit sink must reject before inventory mutation");
    assert.equal((await rejectedBeforeMutation.json()).code, "tenant_audit_unavailable");
  } finally {
    process.env.CDSS_TENANT_AUDIT_PATH = auditPathBeforeInventoryFailure;
  }
  const inventoryAfterAuditFailure = await inventoryRoute.GET(new Request("http://localhost/api/drug-inventory", {
    headers: { "x-cdss-customer-id": "hospital-route" },
  }));
  assert.equal((await inventoryAfterAuditFailure.json()).itemCount, 0,
    "inventory must remain unchanged when the durable audit intent cannot be written");

  const workingAuditPath = process.env.CDSS_TENANT_AUDIT_PATH;
  process.env.CDSS_TENANT_AUDIT_PATH = temporaryRoot; // appendFile(directory) deterministically fails.
  try {
    const auditFailure = await requireCustomerContext(
      request("hospital-audit-fail", "inventory-audit-failure-001"),
      undefined,
      {
        allowJitProvisioning: true,
        idempotencyKey: "inventory-audit-failure-001",
      },
    );
    assert.equal(auditFailure.ok, false);
    assert.equal(auditFailure.response.status, 503);
    assert.equal((await auditFailure.response.json()).code, "tenant_audit_unavailable");
  } finally {
    process.env.CDSS_TENANT_AUDIT_PATH = workingAuditPath;
  }
  assert.equal(authorizeCustomerId("hospital-audit-fail", true).ok, false,
    "audit failure must leave the customer unauthorized");
  const failedRegistry = JSON.parse(await readFile(process.env.CDSS_CUSTOMER_REGISTRY_PATH, "utf8"));
  assert.equal(failedRegistry.customers.find((customer) => customer.customerId === "hospital-audit-fail")?.status, "failed");
  const failedDifferentKey = await requireCustomerContext(
    request("hospital-audit-fail", "inventory-audit-failure-002"),
    undefined,
    { allowJitProvisioning: true, idempotencyKey: "inventory-audit-failure-002" },
  );
  assert.equal(failedDifferentKey.ok, false);
  assert.equal(failedDifferentKey.response.status, 409,
    "failed/provisioning registrations must retain their original idempotency binding");
  const failedKeyCrossCustomer = await requireCustomerContext(
    request("hospital-audit-key-reuse", "inventory-audit-failure-001"),
    undefined,
    { allowJitProvisioning: true, idempotencyKey: "inventory-audit-failure-001" },
  );
  assert.equal(failedKeyCrossCustomer.ok, false);
  assert.equal(failedKeyCrossCustomer.response.status, 409,
    "a failed registration key must not become reusable by another customer");

  await recordTenantAuditEvent({
    event: "inventory_import",
    clientId: "his-integrator",
    customerHash: tenantAuditCustomerHash("his-integrator", "hospital-new"),
    outcome: "accepted",
    itemCount: 2,
    inventoryVersion: "v1",
  });
  await recordTenantAuditEvent({
    event: "inventory_import",
    clientId: "his-integrator",
    customerHash: tenantAuditCustomerHash("his-integrator", "hospital-static"),
    outcome: "accepted",
    itemCount: 99,
  });
  await recordTenantAuditEvent({
    event: "inventory_import",
    clientId: "other-integrator",
    customerHash: tenantAuditCustomerHash("his-integrator", "hospital-new"),
    outcome: "accepted",
    itemCount: 777,
  });
  const events = await queryTenantAuditEvents(
    "his-integrator",
    tenantAuditCustomerHash("his-integrator", "hospital-new"),
    20,
  );
  assert.equal(events.filter((event) => event.event === "customer_registration" && event.code === "created").length, 1);
  assert.equal(events.filter((event) => event.event === "customer_registration" && event.code === "already_active").length, 1);
  assert.equal(events.some((event) => event.event === "customer_registration" && event.code === "idempotency_key_required"), true);
  assert.equal(events.find((event) => event.event === "inventory_import")?.itemCount, 2);
  assert.equal(JSON.stringify(events).includes("hospital-static"), false);
  assert.equal(JSON.stringify(events).includes("患者张三"), false,
    "caller-controlled inventory source must never enter tenant audit events");
  assert.equal(events.some((event) => event.itemCount === 777), false,
    "audit queries must bind both clientId and customer hash");
  assert.equal(getCustomerAuthorizationStatus().customerCount, 3);
  const routeEvents = await queryTenantAuditEvents(
    "his-integrator",
    tenantAuditCustomerHash("his-integrator", "hospital-route"),
    20,
  );
  assert.equal(JSON.stringify(routeEvents).includes("patient-zhangsan-inpatient-123456"), false,
    "caller-controlled request IDs must be hashed before audit persistence");
  assert.equal(routeEvents.some((event) => /^[a-f0-9]{32}$/.test(event.requestIdHash || "")), true);
  assert.equal(routeEvents.some((event) => "requestId" in event), false);

  process.env.CDSS_TENANT_AUDIT_MAX_BYTES = "1024";
  process.env.CDSS_TENANT_AUDIT_ARCHIVE_FILES = "2";
  for (let index = 0; index < 30; index += 1) {
    await recordTenantAuditEvent({
      event: "inventory_read",
      clientId: "his-integrator",
      customerHash: tenantAuditCustomerHash("his-integrator", "hospital-new"),
      outcome: "accepted",
      operationId: `rotation-${String(index).padStart(3, "0")}`,
    });
  }
  assert.ok((await stat(`${process.env.CDSS_TENANT_AUDIT_PATH}.1`)).size <= 1_024,
    "tenant audit must rotate instead of growing without bound");
  const rotatedEvents = await queryTenantAuditEvents(
    "his-integrator",
    tenantAuditCustomerHash("his-integrator", "hospital-new"),
    100,
  );
  assert.equal(rotatedEvents[0]?.operationId, "rotation-029");

  const validRegistry = await readFile(process.env.CDSS_CUSTOMER_REGISTRY_PATH, "utf8");
  await writeFile(process.env.CDSS_CUSTOMER_REGISTRY_PATH, "{malformed", "utf8");
  assert.equal(getCustomerAuthorizationStatus().ready, false,
    "a malformed registry must make strict customer readiness fail closed");
  assert.deepEqual(authorizeCustomerId("hospital-new", true), {
    ok: false,
    status: 503,
    code: "customer_authorization_not_configured",
  });
  await writeFile(process.env.CDSS_CUSTOMER_REGISTRY_PATH, validRegistry, "utf8");

  console.log(JSON.stringify({ suite: "customer-jit-registration", cases: 39, failures: 0 }));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
