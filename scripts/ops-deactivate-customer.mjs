#!/usr/bin/env node
// 注销已登记客户（P1-5 运维通路）。**零依赖**：只用 node 内置模块，可在生产服务器 host
// 或容器里裸 node 执行（那里没有 node_modules/jiti，import 应用源码的脚本跑不起来）。
//
// 用法:
//   CDSS_API_CLIENT_ID=<clientId> \
//   CDSS_CUSTOMER_REGISTRY_PATH=/path/to/customer-registry.json \
//   [CDSS_TENANT_AUDIT_PATH=/path/to/tenant-audit.ndjson] \
//   node scripts/ops-deactivate-customer.mjs <customerId> [<customerId>...]
//
// 语义与 src/lib/customer-registry.server.ts 的 deactivateCustomerForClient 一致：
// 吊销即时生效（授权读取器只认 active）、幂等键绑定保留（原键重登记=停用恢复）、
// 配额立即释放。audit 追加行的 customerHash 口径与 tenant-audit.server.ts 的
// tenantAuditCustomerHash 逐字一致（sha256(`${clientId}\0${customerId}`).hex.slice(0,32)）——
// test-customer-jit-registration.mjs 用 queryTenantAuditEvents 反查该行来钉住两处不漂移。
//
// 安全边界：任何无法识别的 schema/status 一律拒绝写入（宁可失败也不写出一份
// 部署中代码解析不了的注册表——parseRegistry 遇到未知取值会把整个注册表判 unavailable，
// 那是全客户 503）。写入走 tmp+rename 原子替换。
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REGISTRY_SCHEMA_VERSION = "tcm-cdss-customer-registry-v1";
const KNOWN_STATUSES = new Set(["provisioning", "active", "failed", "deactivated"]);

const clientId = (process.env.CDSS_API_CLIENT_ID || "").trim();
const registryPath = resolve((process.env.CDSS_CUSTOMER_REGISTRY_PATH || "").trim() || "artifacts/runtime/customer-registry.json");
const auditPath = (process.env.CDSS_TENANT_AUDIT_PATH || "").trim();
const targets = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);

if (!clientId || targets.length === 0) {
  console.error("usage: CDSS_API_CLIENT_ID=<clientId> CDSS_CUSTOMER_REGISTRY_PATH=<file> node scripts/ops-deactivate-customer.mjs <customerId>...");
  process.exit(2);
}

let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, "utf8"));
} catch (error) {
  console.error(`cannot read registry at ${registryPath}: ${error?.message || error}`);
  process.exit(1);
}
if (registry?.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(registry.customers)) {
  console.error("unrecognized registry schema; refusing to write");
  process.exit(1);
}
for (const customer of registry.customers) {
  if (!customer || typeof customer !== "object" || !KNOWN_STATUSES.has(customer.status)) {
    console.error(`registry contains an entry this tool does not understand (status=${customer?.status}); refusing to write`);
    process.exit(1);
  }
}

const now = new Date().toISOString();
const results = [];
for (const customerId of targets) {
  const entry = registry.customers.find((item) => item.clientId === clientId && item.customerId === customerId);
  if (!entry) {
    results.push({ customerId, result: "not_found" });
    continue;
  }
  if (entry.status === "deactivated") {
    results.push({ customerId, result: "already_deactivated" });
    continue;
  }
  entry.status = "deactivated";
  entry.updatedAt = now;
  results.push({ customerId, result: "deactivated" });
}

const changed = results.filter((item) => item.result === "deactivated");
if (changed.length > 0) {
  const temporary = `${registryPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, registryPath);
  if (auditPath) {
    for (const item of changed) {
      const customerHash = createHash("sha256").update(`${clientId}\u0000${item.customerId}`).digest("hex").slice(0, 32);
      appendFileSync(
        resolve(auditPath),
        `${JSON.stringify({ timestamp: now, event: "customer_registration", clientId, customerHash, outcome: "accepted", code: "deactivated_by_ops" })}\n`,
        { mode: 0o600 },
      );
    }
  }
}

console.log(JSON.stringify({ registryPath, auditRecorded: Boolean(auditPath) && changed.length > 0, results }, null, 2));
process.exit(results.some((item) => item.result === "not_found") ? 3 : 0);
