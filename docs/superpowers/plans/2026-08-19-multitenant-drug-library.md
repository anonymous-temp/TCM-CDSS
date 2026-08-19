# Multitenant Drug Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a stable customer identifier across clinical and drug-related requests and isolate every customer's drug library, cache, staged imports, candidate availability, HIS output, snapshots, and rate limits.

**Architecture:** Resolve one authoritative `CustomerContext` from `x-cdss-customer-id` or a signed browser customer cookie. Bind it to `CaseState` and signatures. Store each inventory under a hashed tenant file and thread the context explicitly through every consumer.

**Tech Stack:** Next.js 16 proxy/App Router, TypeScript 5 strict, zod 4, AES/HMAC Web Crypto, JSON files on the existing Docker persistent volume.

---

### Task 1: Define and validate customer context

**Files:**
- Create: `src/lib/customer-context.ts`
- Modify: `src/lib/diagnosis-types.ts`
- Create: `scripts/test-customer-context.mjs`
- Modify: `scripts/run-deterministic-regression.mjs`

- [ ] **Step 1: Write RED tests**

```js
assert.equal(parseCustomerId("hospital-A_01"), "hospital-A_01");
assert.equal(parseCustomerId("../../other"), undefined);
assert.equal((await requireCustomerContext(requestWithoutHeader)).response.status, 400);
assert.equal((await requireCustomerContext(requestWithMismatch)).response.status, 409);
```

- [ ] **Step 2: Run RED**

Run: `jiti scripts/test-customer-context.mjs`

Expected: FAIL because customer context does not exist.

- [ ] **Step 3: Implement the resolver**

```ts
export type CustomerContext = { customerId: string; customerHash: string; source: "header" | "cookie" };
export function parseCustomerId(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{6,64}$/.test(text) ? text : undefined;
}
```

`requireCustomerContext(req, caseState?)` reads the header first, otherwise a signed browser cookie, and compares it with `caseState.customerId`.

- [ ] **Step 4: Add `CaseState.customerId` and normalize it**

Reject malformed values; do not generate a default. Add the customer ID to both M03 and M04 signature contexts.

- [ ] **Step 5: Run GREEN and commit**

Run: `jiti scripts/test-customer-context.mjs && npm run test:reasoning-signature && npm run typecheck`

```bash
git add src/lib/customer-context.ts src/lib/diagnosis-types.ts scripts/test-customer-context.mjs scripts/run-deterministic-regression.mjs
git commit -m "feat: bind clinical requests to customer context"
```

### Task 2: Bind browser login and proxy identity to the customer

**Files:**
- Modify: `src/lib/cdss-auth.ts`
- Modify: `src/app/api/auth/access/route.ts`
- Modify: `src/app/login/page.tsx`
- Modify: `src/proxy.ts`
- Create: `scripts/test-customer-auth-binding.mjs`

- [ ] **Step 1: Write RED tests**

```js
const login = await POST(loginRequest({ token: VALID_TOKEN, customerId: "hospital-A" }));
assert.match(login.headers.get("set-cookie"), /tcm_cdss_customer_context=/);
assert.notEqual(await customerCookieValue("hospital-A"), await customerCookieValue("hospital-B"));
```

- [ ] **Step 2: Run RED**

Run: `jiti scripts/test-customer-auth-binding.mjs`

Expected: FAIL because login only accepts the token.

- [ ] **Step 3: Add signed customer cookie support**

Create `CDSS_CUSTOMER_COOKIE`, HMAC-sign `customerId + expiry + nonce` with `CDSS_API_TOKEN`, and validate it in constant time. The login form requires customer ID and token; changing customer requires a new login.

- [ ] **Step 4: Scope authenticated rate limits**

Return `tenant:${tokenHash}:${customerHash}` for API header clients and `session:${cookieHash}:${customerHash}` for browser sessions.

- [ ] **Step 5: Run GREEN and commit**

Run: `jiti scripts/test-customer-auth-binding.mjs && npm run test:model-rate-limit && npm run test:snapshot-auth-binding`

```bash
git add src/lib/cdss-auth.ts src/app/api/auth/access/route.ts src/app/login/page.tsx src/proxy.ts scripts/test-customer-auth-binding.mjs
git commit -m "feat: bind browser auth and rate limits to customer"
```

### Task 3: Isolate inventory storage, caches, and staged imports

**Files:**
- Modify: `src/lib/drug-inventory.server.ts`
- Modify: `src/app/api/drug-inventory/route.ts`
- Rewrite: `scripts/test-drug-inventory.mjs`

- [ ] **Step 1: Add RED cross-customer tests**

```js
await importDrugInventory("hospital-A", { items: [{ name: "麻黄", available: true }] });
await importDrugInventory("hospital-B", { items: [{ name: "麻黄", available: false }] });
assert.equal((await herbAvailabilityView("hospital-A")).statusOf("麻黄"), "in_stock");
assert.equal((await herbAvailabilityView("hospital-B")).statusOf("麻黄"), "out_of_stock");
assert.notEqual(drugInventoryPath("hospital-A"), drugInventoryPath("hospital-B"));
```

- [ ] **Step 2: Run RED**

Run: `npm run test:drug-inventory`

Expected: FAIL because all calls share one file/cache.

- [ ] **Step 3: Refactor every inventory API to require `customerId`**

```ts
export function drugInventoryPath(customerId: string): string;
export async function importDrugInventory(customerId: string, input: DrugInventoryImportInput): Promise<DrugInventoryImportResult>;
export async function herbAvailabilityView(customerId: string): Promise<HerbAvailabilityView>;
```

Use `createHash("sha256").update(customerId).digest("hex").slice(0, 32)` as the filename. Replace `cache/cacheLoaded` with a map keyed by customer ID. Namespace staged imports by the same hash.

- [ ] **Step 4: Require customer context in the route**

Resolve customer context before reading/writing the inventory. Return `customerId` only when it is already the caller's validated identifier; log only `customerHash`.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm run test:drug-inventory && npm run test:customer-review-20260810`

```bash
git add src/lib/drug-inventory.server.ts src/app/api/drug-inventory/route.ts scripts/test-drug-inventory.mjs
git commit -m "feat: isolate drug inventory by customer"
```

### Task 4: Make medicine candidates customer-library aware

**Files:**
- Modify: `src/lib/drug-inventory.server.ts`
- Modify: `src/lib/medicine-candidate-planner.server.ts`
- Modify: `src/app/api/diagnosis/prescribe/route.ts`
- Create: `scripts/test-customer-medicine-candidates.mjs`

- [ ] **Step 1: Write RED candidate-isolation tests**

```js
const a = await planEvidenceBoundMedicineCandidates(caseStateA, "hospital-A");
const b = await planEvidenceBoundMedicineCandidates(caseStateB, "hospital-B");
assert.ok(a.candidates.some(x => x.name === "养脾散"));
assert.ok(!b.candidates.some(x => x.name === "养脾散"));
assert.ok(!JSON.stringify(b).includes("A-GOODS-ID"));
```

- [ ] **Step 2: Run RED**

Run: `jiti scripts/test-customer-medicine-candidates.mjs`

Expected: FAIL because the planner reads the global catalog only.

- [ ] **Step 3: Extend inventory kinds and identity mapping**

Allow `kind: "herb" | "patent" | "western"`. Add `medicineAvailability(customerId, name, kind)` and `availableMedicineIdentity` so candidate evidence stays global but availability/product identity comes only from the current customer library.

- [ ] **Step 4: Thread customer ID into M04 before any model call**

```ts
const customer = await requireCustomerContext(req, parsed.caseState);
if (!customer.ok) return customer.response;
const [medicinePlan, inventoryContext] = await Promise.all([
  planEvidenceBoundMedicineCandidates(safeState, customer.context.customerId, req.signal),
  buildDrugInventoryPromptContext(customer.context.customerId),
]);
```

- [ ] **Step 5: Run GREEN and commit**

Run: `jiti scripts/test-customer-medicine-candidates.mjs && npm run test:local-patent-medicines && npm run test:stage-contract`

```bash
git add src/lib/drug-inventory.server.ts src/lib/medicine-candidate-planner.server.ts src/app/api/diagnosis/prescribe/route.ts scripts/test-customer-medicine-candidates.mjs
git commit -m "feat: constrain medicine candidates to customer library"
```

### Task 5: Propagate customer context across clinical, snapshot, HIS, and audit routes

**Files:**
- Modify: `src/lib/diagnosis-request.ts`
- Modify: `src/app/api/diagnosis/collect/route.ts`
- Modify: `src/app/api/diagnosis/question/route.ts`
- Modify: `src/app/api/diagnosis/question/interpret/route.ts`
- Modify: `src/app/api/diagnosis/diagnose/route.ts`
- Modify: `src/app/api/diagnosis/prescribe/route.ts`
- Modify: `src/app/api/diagnosis/assess/route.ts`
- Modify: `src/app/api/diagnosis/post-prescription-risk/route.ts`
- Modify: `src/app/api/diagnosis/his-scheme/route.ts`
- Modify: `src/app/api/diagnosis/snapshot/route.ts`
- Modify: `src/lib/rxaudit.ts`
- Create: `scripts/test-customer-route-propagation.mjs`

- [ ] **Step 1: Write RED route tests**

```js
for (const route of [collect.POST, question.POST, interpret.POST, diagnose.POST, prescribe.POST, assess.POST, risk.POST, his.POST, snapshot.POST]) {
  providerCalls = 0;
  const response = await route(caseRequest({ customerHeader: undefined }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "customer_id_required");
  assert.equal(providerCalls, 0);
}
assert.equal(observedM04CustomerId, "hospital-A");
assert.equal(observedHisCustomerId, "hospital-A");
assert.equal(observedSnapshotCustomerId, "hospital-A");
assert.equal(observedAuditCustomerId, "hospital-A");
```

- [ ] **Step 2: Run RED**

Run: `jiti scripts/test-customer-route-propagation.mjs`

Expected: FAIL because routes do not resolve customer context.

- [ ] **Step 3: Add `readCustomerBoundCaseStateRequest`**

```ts
export async function readCustomerBoundCaseStateRequest(req: Request) {
  const parsed = await readCaseStateRequest(req);
  if (!parsed.ok) return parsed;
  const customer = await requireCustomerContext(req, parsed.caseState);
  if (!customer.ok) return customer;
  return { ...parsed, customer: customer.context };
}
```

Use it in every patient route. Bind snapshot AAD and reasoning signature context to `customerId`. Pass customer ID to `drugAvailabilityProjection` and to the audit tenant header.

- [ ] **Step 4: Run GREEN and commit**

Run: `jiti scripts/test-customer-route-propagation.mjs && npm run test:snapshot-auth-binding && npm run test:rxaudit-routes && npm run test:his-structured-projection`

```bash
git add src/lib/diagnosis-request.ts src/app/api/diagnosis src/lib/rxaudit.ts scripts/test-customer-route-propagation.mjs
git commit -m "feat: propagate customer context through clinical routes"
```

### Task 6: Migrate the existing production inventory explicitly

**Files:**
- Create: `scripts/migrate-drug-inventory-to-customer.mjs`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Create: `scripts/test-inventory-customer-migration.mjs`

- [ ] **Step 1: Write RED migration tests**

```js
assert.throws(() => runMigration([]), /--customer-id is required/);
runMigration(["--source", source, "--root", root, "--customer-id", "hospital-A"]);
assert.equal(existsSync(`${source}.pre-tenant-backup`), true);
assert.equal(readdirSync(root).filter((name) => name.endsWith(".json")).length, 1);
assert.deepEqual(JSON.parse(readFileSync(join(root, readdirSync(root)[0]), "utf8")).items, sourceItems);
```

- [ ] **Step 2: Run RED**

Run: `jiti scripts/test-inventory-customer-migration.mjs`

Expected: FAIL because the migration script does not exist.

- [ ] **Step 3: Implement one-time explicit migration**

```bash
node scripts/migrate-drug-inventory-to-customer.mjs \
  --source /app/runtime-data/drug-inventory.json \
  --root /app/runtime-data/drug-inventory \
  --customer-id "$CDSS_DEFAULT_CUSTOMER_ID"
```

The script exits nonzero when the source is missing, target exists, or customer ID is invalid. It never invents a default customer.

- [ ] **Step 4: Run GREEN and commit**

Run: `jiti scripts/test-inventory-customer-migration.mjs`

```bash
git add scripts/migrate-drug-inventory-to-customer.mjs scripts/test-inventory-customer-migration.mjs .env.example docker-compose.yml
git commit -m "feat: add explicit tenant inventory migration"
```

### Task 7: Update external API documentation and release tests

**Files:**
- Modify: `docs/中医CDSS-对外接口文档.md`
- Modify: `scripts/test-api-doc-field-parity.mjs`
- Modify: `scripts/regress-online-inventory.mjs`
- Modify: `scripts/regress-prod-auth-surface.mjs`

- [ ] **Step 1: Document the customer header on every sensitive interface**

Add `-H "x-cdss-customer-id: hospital-A"` to examples. Document 400/409 error codes, browser login `customerId`, inventory isolation, and the unchanged shared authentication token contract.

- [ ] **Step 2: Extend online A/B isolation regression**

Import opposite availability for two synthetic customers, query each snapshot, call M04/HIS for each, and assert no cross-customer goods IDs or availability values.

- [ ] **Step 3: Run focused tests**

Run: `npm run test:drug-inventory && npm run test:customer-review-20260810 && npm run test:rxaudit-routes && npm run test:model-rate-limit`

Expected: PASS.

- [ ] **Step 4: Run the release gate**

Run: `npm run verify:release`

Expected: all deterministic suites pass twice and Next production build succeeds.

- [ ] **Step 5: Commit**

```bash
git add docs/中医CDSS-对外接口文档.md scripts/test-api-doc-field-parity.mjs scripts/regress-online-inventory.mjs scripts/regress-prod-auth-surface.mjs
git commit -m "docs: publish multitenant customer contract"
```
