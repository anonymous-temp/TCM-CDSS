# 固定 Token 多租户授权与隔离加固实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不更换既定 CDSS API Token、不引入租户平台的前提下，把同一 Token 的客户访问范围收敛到部署白名单，并补齐库存归属、并发、缓存、响应隔离和发布健康闸门。

**Architecture:** 新增纯配置驱动的 `customer-authorization.ts` 作为唯一客户授权边界，现有 `customer-context.ts`、登录和限流只消费其判定。库存继续使用当前按客户哈希分文件方案，但文件升级为带 `schemaVersion/customerId` 的 v2，并在进程内增加有界缓存和细粒度串行锁。所有 API 仍由 Next.js 16 `src/proxy.ts` 统一鉴权和加隔离响应头，路由本身继续做资源级客户授权。

**Tech Stack:** Next.js 16 Proxy/App Router、TypeScript 5 strict、Node.js `node:assert`/jiti 测试、JSON 文件库存、Docker Compose。

---

## 文件结构

- 新建 `src/lib/customer-authorization.ts`：解析并验证客户白名单、客户端标识和默认客户，返回不泄露客户列表的状态与授权判定。
- 修改 `src/lib/customer-context.ts`：把格式合法的客户来源绑定到授权白名单，并在可信上下文中加入 `clientId`。
- 修改 `src/lib/cdss-auth.ts`：模型限流只为已授权客户建立独立桶，未授权客户共享拒绝桶。
- 修改 `src/app/api/auth/access/route.ts`：签发客户 Cookie 前执行与临床路由相同的授权判定。
- 修改 `src/lib/drug-inventory.server.ts`：库存 v2 身份、读取归属校验、有界缓存、客户/分片锁和随机临时文件。
- 修改 `src/app/api/drug-inventory/route.ts`：成功响应返回经验证的客户响应头。
- 修改 `scripts/migrate-drug-inventory-to-customer.mjs`：显式把旧库存包装为 v2 后写入指定客户目录。
- 新建 `src/lib/api-route-classification.ts`：维护全局路由与客户路由的完整分类。
- 修改 `src/proxy.ts`：为 API 响应统一添加 `private, no-store` 与租户鉴权 `Vary`。
- 修改 `src/app/api/diagnosis/health/route.ts`：strict readiness 纳入客户授权配置，但不返回白名单内容。
- 修改现有多租户测试并新增客户授权/响应隔离测试；更新 `package.json`、`.env.example`、`docker-compose.yml`、部署手册和对外接口文档。

### Task 1: 客户授权配置解析与 fail-closed 判定

**Files:**
- Create: `src/lib/customer-authorization.ts`
- Create: `scripts/test-customer-authorization.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写客户授权配置的失败测试**

测试必须覆盖：A/B 在白名单内、C 返回统一 403；缺配置、非法 clientId、空项、重复项、超过 1000 项、默认客户不在白名单均不就绪；状态对象不得包含客户列表。

```js
process.env.CDSS_API_CLIENT_ID = "his-integrator";
process.env.CDSS_API_CUSTOMER_IDS = "hospital-A,hospital-B";
assert.deepEqual(authorizeCustomerId("hospital-A", true), {
  ok: true,
  clientId: "his-integrator",
  customerId: "hospital-A",
});
assert.deepEqual(authorizeCustomerId("hospital-C", true), {
  ok: false,
  status: 403,
  code: "customer_forbidden",
});
assert.equal(JSON.stringify(getCustomerAuthorizationStatus()).includes("hospital-A"), false);
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node scripts/test-customer-authorization.mjs`

Expected: FAIL，原因是 `src/lib/customer-authorization.ts` 不存在。

- [ ] **Step 3: 提交 RED 检查点**

```bash
git add scripts/test-customer-authorization.mjs package.json
git commit -m "test: add customer authorization config contract"
```

- [ ] **Step 4: 实现最小授权模块**

```ts
export type CustomerAuthorizationStatus = Readonly<{
  configured: boolean;
  valid: boolean;
  clientConfigured: boolean;
  customerCount: number;
  ready: boolean;
}>;

export type CustomerAuthorizationDecision =
  | { ok: true; clientId: string; customerId: string }
  | { ok: false; status: 403; code: "customer_forbidden" }
  | { ok: false; status: 503; code: "customer_authorization_not_configured" };

export function getCustomerAuthorizationStatus(): CustomerAuthorizationStatus;
export function authorizeCustomerId(customerId: string, required: boolean): CustomerAuthorizationDecision;
```

实现必须保持客户 ID 大小写敏感，拒绝空项/重复项/非法项/超过 1000 项；非生产且鉴权关闭时只允许本地兼容，生产或鉴权开启时缺配置返回 503。

- [ ] **Step 5: 运行测试并确认 GREEN**

Run: `npm run test:customer-authorization`

Expected: PASS，输出 `failures: 0`。

- [ ] **Step 6: 提交 GREEN 检查点**

```bash
git add src/lib/customer-authorization.ts
git commit -m "feat: authorize fixed token customer scope"
```

### Task 2: 客户上下文、登录与限流统一授权

**Files:**
- Modify: `src/lib/customer-context.ts`
- Modify: `src/app/api/auth/access/route.ts`
- Modify: `src/lib/cdss-auth.ts`
- Modify: `scripts/test-customer-context.mjs`
- Modify: `scripts/test-customer-auth-binding.mjs`
- Modify: `scripts/test-proxy-model-rate-limit.mjs`

- [ ] **Step 1: 扩展失败测试**

```js
process.env.CDSS_API_CLIENT_ID = "his-integrator";
process.env.CDSS_API_CUSTOMER_IDS = "hospital-A_01,hospital-B_02,hospital-default";
const allowed = await requireCustomerContext(requestFor("hospital-A_01"));
assert.equal(allowed.ok, true);
assert.equal(allowed.context.clientId, "his-integrator");
const denied = await requireCustomerContext(requestFor("hospital-C_03"));
assert.equal(denied.response.status, 403);
assert.equal((await denied.response.json()).code, "customer_forbidden");
```

登录测试增加 `hospital-C`：状态 403、`code=customer_forbidden`、无 `tcm_cdss_customer_context` Cookie。限流测试证明 A/B 分桶、两个不同未授权客户使用同一个拒绝桶标识。

- [ ] **Step 2: 运行三套测试并确认 RED**

Run: `npm run test:customer-context && npm run test:customer-auth-binding && npm run test:model-rate-limit`

Expected: 至少一项因 C 仍被接受或 `clientId` 缺失而 FAIL。

- [ ] **Step 3: 提交 RED 检查点**

```bash
git add scripts/test-customer-context.mjs scripts/test-customer-auth-binding.mjs scripts/test-proxy-model-rate-limit.mjs
git commit -m "test: reproduce unauthorized customer access"
```

- [ ] **Step 4: 将共享判定接入三个入口**

`CustomerContext` 改为：

```ts
export type CustomerContext = Readonly<{
  clientId: string;
  customerId: string;
  customerHash: string;
  source: "header" | "cookie" | "default";
}>;
```

`requireCustomerContext()` 在来源冲突和格式校验后调用 `authorizeCustomerId()`；登录路由在创建 Cookie 前调用同一函数；`getCdssAuthenticatedRateLimitKey()` 只对授权客户使用客户哈希，未授权或配置异常统一使用固定拒绝范围，不能由任意请求头制造无限限流桶。

- [ ] **Step 5: 运行测试并确认 GREEN**

Run: `npm run test:customer-authorization && npm run test:customer-context && npm run test:customer-auth-binding && npm run test:model-rate-limit`

Expected: 全部 PASS。

- [ ] **Step 6: 提交 GREEN 检查点**

```bash
git add src/lib/customer-context.ts src/app/api/auth/access/route.ts src/lib/cdss-auth.ts
git commit -m "feat: enforce customer allowlist across auth boundaries"
```

### Task 3: 库存 v2 身份与显式迁移

**Files:**
- Modify: `src/lib/drug-inventory.server.ts`
- Modify: `scripts/migrate-drug-inventory-to-customer.mjs`
- Modify: `scripts/test-multitenant-drug-inventory.mjs`
- Modify: `scripts/test-inventory-customer-migration.mjs`

- [ ] **Step 1: 写库存归属失败测试**

```js
assert.equal(snapshotA.schemaVersion, "tcm-cdss-drug-inventory-v2");
assert.equal(snapshotA.customerId, "hospital-A");
await copyFile(inventory.drugInventoryPath("hospital-A"), inventory.drugInventoryPath("hospital-B"));
inventory.resetDrugInventoryCacheForTests("hospital-B");
assert.equal(await inventory.drugInventorySnapshot("hospital-B"), null);
```

再用完全相同条目导入 A/B，断言 `inventoryVersion` 不同；迁移测试断言目标 JSON 已写入 v2 `schemaVersion/customerId`，源文件与备份内容不变。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npm run test:multitenant-drug-inventory && npm run test:inventory-customer-migration`

Expected: FAIL，当前库存没有 v2 身份且错放文件仍会被读取。

- [ ] **Step 3: 提交 RED 检查点**

```bash
git add scripts/test-multitenant-drug-inventory.mjs scripts/test-inventory-customer-migration.mjs
git commit -m "test: reproduce inventory ownership confusion"
```

- [ ] **Step 4: 实现库存 v2 与迁移包装**

```ts
const DRUG_INVENTORY_SCHEMA_VERSION = "tcm-cdss-drug-inventory-v2" as const;
type InventoryFile = DrugInventorySnapshot & {
  schemaVersion: typeof DRUG_INVENTORY_SCHEMA_VERSION;
  customerId: string;
  items: DrugInventoryItem[];
};
```

新版本摘要必须包含 `schemaVersion`、`customerId` 和规范化条目；读取时先检查 schema 与文件客户，错配时仅记录 `customerHash` 和枚举原因后返回 `null`。迁移脚本解析旧 JSON、重算计数并写 v2，禁止运行时自动复制旧文件。

- [ ] **Step 5: 运行测试并确认 GREEN**

Run: `npm run test:multitenant-drug-inventory && npm run test:inventory-customer-migration`

Expected: 全部 PASS。

- [ ] **Step 6: 提交 GREEN 检查点**

```bash
git add src/lib/drug-inventory.server.ts scripts/migrate-drug-inventory-to-customer.mjs
git commit -m "feat: bind inventory files to customer identity"
```

### Task 4: 库存并发与缓存边界

**Files:**
- Modify: `src/lib/drug-inventory.server.ts`
- Create: `scripts/test-drug-inventory-concurrency.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写并发和容量失败测试**

```js
await Promise.all([
  inventory.importDrugInventory("hospital-A", { items: first, part: { importId: "same-import", index: 0, total: 2 } }),
  inventory.importDrugInventory("hospital-A", { items: second, part: { importId: "same-import", index: 1, total: 2 } }),
]);
assert.equal((await inventory.drugInventorySnapshot("hospital-A")).itemCount, 2);
for (let index = 0; index < 501; index += 1) {
  await inventory.herbAvailabilityView(`tenant-${String(index).padStart(6, "0")}`);
}
assert.equal(inventory.drugInventoryCacheSizeForTests() <= 500, true);
```

测试还需并发导入 A/B 相同 importId 并断言互不等待/串写；通过替换 `randomUUID` 无法直接注入时，检查源码临时文件不再只用 PID。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node scripts/test-drug-inventory-concurrency.mjs`

Expected: FAIL，当前并发分片可能丢片或缓存大小达到 501。

- [ ] **Step 3: 提交 RED 检查点**

```bash
git add scripts/test-drug-inventory-concurrency.mjs package.json
git commit -m "test: reproduce inventory concurrency and cache growth"
```

- [ ] **Step 4: 实现最小锁、淘汰和随机临时文件**

客户整批提交使用 `Map<string, Promise<void>>` 串行；分片读改写使用 `(customerId, importId)` 键串行；不同客户不共享锁。缓存条目记录 `lastAccessedAt`，空闲 30 分钟失效，容量超过 500 时淘汰最久未访问项。库存与分片临时文件统一使用 `randomUUID()`，失败后清理自身临时文件。

- [ ] **Step 5: 运行测试并确认 GREEN**

Run: `npm run test:drug-inventory-concurrency && npm run test:multitenant-drug-inventory`

Expected: 全部 PASS。

- [ ] **Step 6: 提交 GREEN 检查点**

```bash
git add src/lib/drug-inventory.server.ts
git commit -m "fix: serialize inventory writes and bound tenant cache"
```

### Task 5: API 响应隔离与路由完整性

**Files:**
- Create: `src/lib/api-route-classification.ts`
- Modify: `src/proxy.ts`
- Modify: `src/app/api/drug-inventory/route.ts`
- Modify: `scripts/test-customer-route-propagation.mjs`
- Create: `scripts/test-api-tenant-response-headers.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写未分类路由与响应头失败测试**

路由测试枚举 `src/app/api/**/route.ts`，断言它与全局/租户清单的并集完全一致且无交集；租户路由源码必须引用客户上下文入口。

```js
const response = await proxy(authenticatedNextRequest("/api/diagnosis/health"));
assert.equal(response.headers.get("cache-control"), "private, no-store");
assert.match(response.headers.get("vary") || "", /x-cdss-customer-id/i);
assert.match(response.headers.get("vary") || "", /authorization/i);
const inventoryResponse = await inventoryGET(requestFor("hospital-A"));
assert.equal(inventoryResponse.headers.get("x-cdss-customer-id"), "hospital-A");
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npm run test:customer-route-propagation && node scripts/test-api-tenant-response-headers.mjs`

Expected: FAIL，当前清单不枚举所有路由且响应缺少统一隔离头。

- [ ] **Step 3: 提交 RED 检查点**

```bash
git add src/lib/api-route-classification.ts scripts/test-customer-route-propagation.mjs scripts/test-api-tenant-response-headers.mjs package.json
git commit -m "test: add API tenant isolation surface contract"
```

- [ ] **Step 4: 实现响应头和分类清单**

`proxy` 只给客户端设置三个明确响应头，不复制请求头：`Cache-Control: private, no-store`，以及合并后的 `Vary: x-cdss-customer-id, x-cdss-api-token, authorization`。库存成功响应使用经授权的 `customer.context.customerId` 设置响应头；400/403/409/503 不回显原始客户头。

- [ ] **Step 5: 运行测试并确认 GREEN**

Run: `npm run test:customer-route-propagation && npm run test:api-tenant-response-headers && npm run test:model-rate-limit`

Expected: 全部 PASS。

- [ ] **Step 6: 提交 GREEN 检查点**

```bash
git add src/lib/api-route-classification.ts src/proxy.ts src/app/api/drug-inventory/route.ts
git commit -m "feat: harden tenant API response isolation"
```

### Task 6: strict health、生产配置与对外文档

**Files:**
- Modify: `src/app/api/diagnosis/health/route.ts`
- Modify: `scripts/test-health-public-view.mjs`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `docs/部署运行手册-20260713.md`
- Modify: `docs/中医CDSS-对外接口文档.md`

- [ ] **Step 1: 写健康状态失败测试**

```js
const status = getCustomerAuthorizationStatus();
assert.deepEqual(Object.keys(status).sort(), [
  "clientConfigured", "configured", "customerCount", "ready", "valid",
]);
assert.equal(JSON.stringify(status).includes("hospital-A"), false);
```

健康路由源码测试断言 `strictReady` 包含 `customerAuthorization.ready`，配置缺失的降级原因是 `customer_authorization_not_configured`。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npm run test:health-public-view && npm run test:customer-authorization`

Expected: FAIL，health 尚未消费客户授权状态。

- [ ] **Step 3: 提交 RED 检查点**

```bash
git add scripts/test-health-public-view.mjs
git commit -m "test: require customer authorization in strict health"
```

- [ ] **Step 4: 接入健康闸门和部署配置**

`.env.example` 和 Compose 增加：

```dotenv
CDSS_API_CLIENT_ID=his-integrator
CDSS_API_CUSTOMER_IDS=hospital-A,hospital-B
```

Compose 使用 `:?` 强制生产声明。部署手册明确：既定 `CDSS_API_TOKEN` 升级时原值复用且不得打印；只有首次部署才生成。对外文档增加 403/503 合同、白名单语义、库存客户响应头，并为库存 curl 补齐客户头。

- [ ] **Step 5: 运行文档与健康测试并确认 GREEN**

Run: `npm run test:health-public-view && npm run test:customer-authorization && npm run test:delivery-doc-freshness`

Expected: 全部 PASS。

- [ ] **Step 6: 提交 GREEN 检查点**

```bash
git add src/app/api/diagnosis/health/route.ts .env.example docker-compose.yml docs/部署运行手册-20260713.md docs/中医CDSS-对外接口文档.md
git commit -m "docs: publish fixed token customer authorization contract"
```

### Task 7: 安全审查与发布总闸

**Files:**
- Modify only if verification finds a defect in files already listed above.

- [ ] **Step 1: 运行定向多租户套件**

Run:

```bash
npm run test:customer-authorization
npm run test:customer-context
npm run test:customer-auth-binding
npm run test:multitenant-drug-inventory
npm run test:drug-inventory-concurrency
npm run test:customer-route-propagation
npm run test:api-tenant-response-headers
npm run test:inventory-customer-migration
npm run test:customer-medicine-candidates
npm run test:snapshot-auth-binding
npm run test:reasoning-signature
npm run test:model-rate-limit
npm run test:health-public-view
```

Expected: 全部 PASS，无跳过项。

- [ ] **Step 2: 做安全检查**

Run:

```bash
git diff --check origin/main...HEAD
rg -n "sk-[A-Za-z0-9._-]{16,}|CDSS_API_TOKEN=.*[^>]$" --glob '!package-lock.json' --glob '!docs/superpowers/**' .
npm audit --omit=dev
```

Expected: 无硬编码 Token/API key、无空白错误；依赖审计无 high/critical 漏洞，若 registry 返回已知不可修项则如实记录而不自动升级主框架。

- [ ] **Step 3: 运行项目发布闸门**

Run: `npm run verify:release`

Expected: typecheck、lint、普通/clean-env 确定性回归和 build 全部 PASS。

- [ ] **Step 4: 检查提交与工作区**

Run:

```bash
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: 仅保留用户已有的未跟踪 `.superpowers/`，本功能所有源码/测试/文档均已提交到 `codex/multitenant-authorization`。

- [ ] **Step 5: 推送功能分支**

Run: `git push -u origin codex/multitenant-authorization`

Expected: 远端分支更新成功；不直接部署生产，不修改 `main`，等待最终合并/部署授权。
