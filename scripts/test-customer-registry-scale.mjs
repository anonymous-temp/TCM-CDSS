// 客户登记表的规模（2026-09-28）。
//
// 当天甲方一次接入 1,926 家诊所：配置上限 100，1,821 家 429；代码另有写死的硬顶 1,000，
// 且登记表条目超过 1,000 时整表判损坏——全部客户一起 403。同时每个接口请求的鉴权都要
// readFileSync + 整表解析 2～4 次，2 万家时实测每次鉴权卡住事件循环 67ms。
// 甲方客户一万多家，生产配 20,000。本套件钉住：
//   ① 超过旧硬顶的登记表照常可用；② 配额可配到 20,000 且照常在登记时执行；
//   ③ 鉴权走缓存（2 万家 2,000 次鉴权须远低于逐次解析的耗时）；
//   ④ 原地改写登记表后缓存立即失效；⑤ 登录页客户下拉在客户过多时不再整表下发。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const work = await mkdtemp(join(tmpdir(), "tcm-cdss-registry-scale-"));
process.env.CDSS_API_TOKEN = "test-registry-scale-token-at-least-32-characters";
process.env.CDSS_REQUIRE_API_AUTH = "true";
process.env.CDSS_API_CLIENT_ID = "his-integrator";
process.env.CDSS_API_CUSTOMER_IDS = "hospital-a,hospital-b";
process.env.CDSS_CUSTOMER_JIT_ENABLED = "true";
process.env.CDSS_CUSTOMER_REGISTRY_PATH = join(work, "customer-registry.json");
process.env.CDSS_TENANT_AUDIT_PATH = join(work, "tenant-audit.ndjson");
process.env.CDSS_DRUG_INVENTORY_PATH = join(work, "drug-inventory");

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });

const now = new Date().toISOString();
const customerId = (index) => `c${String(index).padStart(7, "0")}`;
const entry = (index, status = "active") => ({
  clientId: "his-integrator",
  customerId: customerId(index),
  status,
  createdAt: now,
  updatedAt: now,
  idempotencyKeyHash: createHash("sha256").update(`scale-key-${index}`).digest("hex"),
  authorizationSource: "jit",
});
async function writeRegistryFile(customers) {
  await writeFile(process.env.CDSS_CUSTOMER_REGISTRY_PATH,
    `${JSON.stringify({ schemaVersion: "tcm-cdss-customer-registry-v1", customers })}\n`);
}

try {
  const { authorizeCustomerId, getCustomerAuthorizationStatus } = await jiti.import("../src/lib/customer-authorization.ts");
  const { registerCustomerForClient } = await jiti.import("../src/lib/customer-registry.server.ts");
  const { POST: login } = await jiti.import("../src/app/api/auth/access/route.ts");

  // ① 1,500 条（超过旧硬顶 1,000）：登记表照常可用，最后一家能通过鉴权。
  await writeRegistryFile(Array.from({ length: 1_500 }, (_, index) => entry(index)));
  const lastOf1500 = authorizeCustomerId(customerId(1_499), true);
  assert.equal(lastOf1500.ok, true,
    "登记表超过 1,000 条不得整表判损坏（旧实现：全部客户 customer_registry_unavailable → 403）");
  assert.equal(getCustomerAuthorizationStatus().ready, true);
  assert.equal(getCustomerAuthorizationStatus().customerCount, 1_502, "静态 2 家 + 登记 1,500 家");

  // ② 配额按「静态 + 已登记」计数：现有 1,502 家，配额 1,503 ⇒ 再登记一家成功、第二家 429。
  //    旧实现把配额钳在 1,000，第一家就 429。
  process.env.CDSS_CUSTOMER_JIT_MAX_CUSTOMERS = "1503";
  const first = await registerCustomerForClient({
    clientId: "his-integrator", customerId: "c-new-0001", idempotencyKey: "scale-new-0001", staticCustomerIds: ["hospital-a", "hospital-b"],
  });
  assert.equal(first.ok, true, `配额须可配到 1,000 以上：${first.ok ? "" : first.code}`);
  const second = await registerCustomerForClient({
    clientId: "his-integrator", customerId: "c-new-0002", idempotencyKey: "scale-new-0002", staticCustomerIds: ["hospital-a", "hospital-b"],
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, "customer_quota_exceeded", "配额照常在登记时执行");
  assert.equal(authorizeCustomerId("c-new-0001", true).ok, true, "刚登记的客户立即可用（写入后缓存回填）");
  assert.equal(authorizeCustomerId("c-new-0002", true).ok, false);

  // ③ 2 万家：2,000 次鉴权。逐次整表解析实测约 67ms/次（2,000 次 ≈ 134s）；走缓存应在 1.5s 内。
  await writeRegistryFile(Array.from({ length: 20_000 }, (_, index) => entry(index)));
  const started = performance.now();
  for (let index = 0; index < 2_000; index += 1) {
    assert.equal(authorizeCustomerId(customerId(19_999 - index), true).ok, true);
  }
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs < 1_500, `2 万家 2,000 次鉴权耗时 ${Math.round(elapsedMs)}ms，应走缓存`);

  // ④ 原地改写（不经本模块）：停用一家，下一次鉴权必须看到。
  const customers = Array.from({ length: 20_000 }, (_, index) => entry(index, index === 7 ? "deactivated" : "active"));
  await writeRegistryFile(customers);
  assert.equal(authorizeCustomerId(customerId(7), true).ok, false, "原地改写后缓存必须失效");
  assert.equal(authorizeCustomerId(customerId(8), true).ok, true);
  // 同样大小的原地改写也要看到（大小相同、修改时间不同）。内核文件时间戳按粗粒度时钟取值
  // （约 1–4ms 一跳），同一跳内的两次同尺寸原地改写修改时间相同；本模块自己的写入走 rename
  // 换 inode 不受影响，外部原地改写（运维手工）不会在几毫秒内连改两次——这里等 25ms 模拟真实间隔。
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  const swapped = customers.map((item, index) => index === 7 ? { ...item, status: "active" } : index === 9 ? { ...item, status: "failed" } : item);
  await writeRegistryFile(swapped);
  assert.equal(authorizeCustomerId(customerId(7), true).ok, true);
  assert.equal(authorizeCustomerId(customerId(9), true).ok, false);

  // 损坏的登记表仍整表不可用（fail-closed 不变）。
  await writeFile(process.env.CDSS_CUSTOMER_REGISTRY_PATH, "{not json");
  assert.equal(authorizeCustomerId(customerId(8), true).ok, false);
  assert.equal(getCustomerAuthorizationStatus().valid, false);

  // ⑤ 登录页：客户过多时不整表下发下拉选项，但仍提示口令正确。
  await writeRegistryFile(Array.from({ length: 300 }, (_, index) => entry(index)));
  const manyResponse = await login(new Request("http://localhost/api/auth/access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: process.env.CDSS_API_TOKEN }),
  }));
  const manyBody = await manyResponse.json();
  assert.equal(manyResponse.status, 400);
  assert.equal(manyBody.customerOptions, undefined, "302 家已授权客户时不得整表下发");
  assert.match(manyBody.error, /请填写客户标识/);
  await writeRegistryFile(Array.from({ length: 3 }, (_, index) => entry(index)));
  const fewBody = await (await login(new Request("http://localhost/api/auth/access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: process.env.CDSS_API_TOKEN }),
  }))).json();
  assert.deepEqual(fewBody.customerOptions, [customerId(0), customerId(1), customerId(2), "hospital-a", "hospital-b"]);

  console.log("customer registry scale OK: >1,000 entries, quota above 1,000, cached authorization, in-place invalidation, login options cap");
} finally {
  await rm(work, { recursive: true, force: true });
}
