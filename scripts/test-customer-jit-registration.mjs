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
    // 这里必须是**合法非空**载荷：本用例钉的是「合法首提交完成登记」，
    // 空 items 属于载荷不合法，按 PROV-08 判据根本不允许走到登记（见文末 PROV 块）。
    body: JSON.stringify({ source: "jit-route-regression", items: [{ name: "黄芪", kind: "herb", available: true }] }),
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
  assert.equal((await inventoryAfterAuditFailure.json()).itemCount, 1,
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
  // 轮转参数用完即还原：留着 1024 会让后续所有用例（含本文件因故重跑时的第二遍）
  // 在被污染的轮转阈值下执行——实测它能把 mkdtemp 根目录整个改名成 .1。
  delete process.env.CDSS_TENANT_AUDIT_MAX_BYTES;
  delete process.env.CDSS_TENANT_AUDIT_ARCHIVE_FILES;

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

  // ── PROV-08：载荷不合法的首次请求不得产生半激活租户（先校验、后登记） ──────────────
  //
  // 甲方 2026-08-24 验收实测：未知客户缺 items 的首次 POST 返回 400 invalid_inventory_items
  // 后，该客户 GET 却返回 200 inventoryLoaded=false——失败请求仍完成了登记激活。
  // 判据：一切**仅凭请求体即可判定**的 4xx/413 都必须发生在 JIT 登记之前；
  // 被拒后同客户必须仍是 403 customer_forbidden，注册表中不得出现该客户。
  process.env.CDSS_CUSTOMER_JIT_MAX_CUSTOMERS = "6";

  const prov08Post = (body, idempotencyKey = "prov08-import-001", customerId = "hospital-prov08") =>
    inventoryRoute.POST(new Request("http://localhost/api/drug-inventory", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cdss-customer-id": customerId,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    }));

  const prov08MissingItems = await prov08Post({ source: "prov08" });
  assert.equal(prov08MissingItems.status, 400);
  assert.equal((await prov08MissingItems.json()).code, "invalid_inventory_items");
  assert.equal(authorizeCustomerId("hospital-prov08", true).ok, false,
    "载荷不合法的首次库存请求不得登记客户（PROV-08）");
  const prov08Get = await inventoryRoute.GET(new Request("http://localhost/api/drug-inventory", {
    headers: { "x-cdss-customer-id": "hospital-prov08" },
  }));
  assert.equal(prov08Get.status, 403,
    "失败首提交之后同客户 GET 必须仍是 403，而不是半激活的 200 inventoryLoaded=false");
  const prov08Registry = JSON.parse(await readFile(process.env.CDSS_CUSTOMER_REGISTRY_PATH, "utf8"));
  assert.equal(prov08Registry.customers.some((customer) => customer.customerId === "hospital-prov08"), false,
    "被拒的首提交不得在注册表留下任何状态的残留条目");

  // 空 items 同属载荷不合法：旧行为是 200 + 零条目库存落盘（整院药味被推成缺货/unknown）。
  const prov08EmptyItems = await prov08Post({ source: "prov08", items: [] });
  assert.equal(prov08EmptyItems.status, 400);
  assert.equal((await prov08EmptyItems.json()).code, "invalid_inventory_items");
  assert.equal(authorizeCustomerId("hospital-prov08", true).ok, false);

  // 条目级错误整批拒绝并回报 rejectedEntries，绝不静默丢弃：
  // 缺 name / kind 非枚举（"中成药" 悄悄当 herb）/ available 非布尔（1 悄悄当 false）
  // 都会直接改变临床可得性。4 条中 3 条非法。
  const prov08BadEntries = await prov08Post({
    source: "prov08",
    items: [
      { name: "黄芪", kind: "herb", available: true },
      { kind: "herb", available: true },
      { name: "藿香正气水", kind: "中成药" },
      { name: "对乙酰氨基酚", kind: "western", available: 1 },
    ],
  });
  assert.equal(prov08BadEntries.status, 400);
  const prov08BadEntriesBody = await prov08BadEntries.json();
  assert.equal(prov08BadEntriesBody.code, "invalid_inventory_items");
  assert.equal(prov08BadEntriesBody.rejectedEntries?.length, 3,
    "条目级校验必须逐条回报被拒条目，而不是静默跳过");
  assert.equal(prov08BadEntriesBody.rejectedEntries?.some((entry) => entry.index === 1), true,
    "缺 name 的条目必须按原始序号回报");
  assert.equal(prov08BadEntriesBody.rejectedEntryCount, 3);
  assert.equal(authorizeCustomerId("hospital-prov08", true).ok, false);

  // 分片参数非法同属载荷内在错误，同样必须先于登记。
  const prov08BadPart = await prov08Post(
    { items: [{ name: "黄芪" }], part: { importId: "prov08-part-000001", index: 0, total: 0 } },
    "prov08-badpart-001",
    "hospital-badpart",
  );
  assert.equal(prov08BadPart.status, 400);
  assert.equal((await prov08BadPart.json()).code, "invalid_import_part_total");
  assert.equal(authorizeCustomerId("hospital-badpart", true).ok, false);

  // 载荷合法后，同一客户同一幂等键正常登记；JIT 登记成功的库存响应必须带 customerRegistered。
  const prov08Valid = await prov08Post({ source: "prov08", items: [{ name: "黄芪", kind: "herb", available: true }] });
  assert.equal(prov08Valid.status, 200, `合法首提交必须登记并落库: ${await prov08Valid.clone().text()}`);
  const prov08ValidBody = await prov08Valid.json();
  assert.equal(prov08ValidBody.customerRegistered, true,
    "JIT 首次登记成功的库存响应必须带 customerRegistered（PROV 计划字段）");
  assert.equal(prov08ValidBody.itemCount, 1);
  const prov08Second = await prov08Post({ source: "prov08", items: [{ name: "当归", kind: "herb", available: true }] });
  assert.equal(prov08Second.status, 200);
  assert.equal("customerRegistered" in (await prov08Second.json()), false,
    "已登记客户的后续导入不得再带 customerRegistered");

  // register 路由响应必须带 PROV 计划要求的 customerRegistered 字段（created 保留兼容）。
  const regField = await registerRoute.POST(new Request("http://localhost/api/customers/register", {
    method: "POST",
    headers: { "x-cdss-customer-id": "hospital-reg-field", "idempotency-key": "reg-field-001" },
  }));
  assert.equal(regField.status, 201);
  const regFieldBody = await regField.json();
  assert.equal(regFieldBody.created, true);
  assert.equal(regFieldBody.customerRegistered, true);
  const regReplay = await registerRoute.POST(new Request("http://localhost/api/customers/register", {
    method: "POST",
    headers: { "x-cdss-customer-id": "hospital-reg-field", "idempotency-key": "reg-field-001" },
  }));
  assert.equal(regReplay.status, 200);
  const regReplayBody = await regReplay.json();
  assert.equal(regReplayBody.created, false);
  assert.equal(regReplayBody.customerRegistered, false);

  console.log(JSON.stringify({ suite: "customer-jit-registration", cases: 67, failures: 0 }));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
