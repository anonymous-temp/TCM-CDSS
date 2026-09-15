// 库存导入的写入幂等（POST /api/drug-inventory）。
//
// 立这道闸的直接原因（甲方 2026-09-15 实测）：同一个 Idempotency-Key 连发两次、第二次载荷不同，
// 两次都返回 200，**第二次把第一次导入的库存整批覆盖了**。根因是这个请求头此前只交给
// requireCustomerContext 用于未登记客户的 JIT 登记；客户一旦已登记，shouldProvision 为假，
// 幂等键连格式都不再校验，请求直接落到 importDrugInventory 的整批替换上。
//
// 危害不是「少了一次去重」：被覆盖掉的药味不会退回 unknown，而是变成 out_of_stock——
// 院内明明有麻黄，系统却告诉医生缺货并给替代候选。缺数据不得改变链路行为，
// 而一次重复提交把「有货」讲成「缺货」，比导入失败严重得多。
//
// 本套件的每条断言都以**审计账本里的实际写入次数**为准，不以时间戳/版本号为准：
// inventoryVersion 由内容派生，同内容重导也会得到同一个版本号，用它判「是否重放」会静默空转。
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const work = await mkdtemp(join(tmpdir(), "cdss-inventory-idempotency-"));
process.env.CDSS_API_TOKEN = "inventory-idempotency-token-at-least-32-chars";
process.env.CDSS_API_CLIENT_ID = "his-integrator";
process.env.CDSS_API_CUSTOMER_IDS = "hospital-idem,hospital-other";
// JIT 必须开着，IDEM-03c 才是真反证：关掉的话未知客户本来就 403，测不出「缺键有没有留下租户」。
process.env.CDSS_CUSTOMER_JIT_ENABLED = "true";
process.env.CDSS_CUSTOMER_REGISTRY_PATH = join(work, "customer-registry.json");
process.env.CDSS_TENANT_AUDIT_PATH = join(work, "tenant-audit.ndjson");
process.env.CDSS_DRUG_INVENTORY_PATH = join(work, "drug-inventory");

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const route = await jiti.import("../src/app/api/drug-inventory/route.ts");
const inv = await jiti.import("../src/lib/drug-inventory.server.ts");
const idem = await jiti.import("../src/lib/inventory-idempotency.server.ts");
const { queryTenantAuditEvents, tenantAuditCustomerHash } = await jiti.import("../src/lib/tenant-audit.server.ts");

const CUSTOMER = "hospital-idem";
const OTHER = "hospital-other";
const failures = [];
async function run(name, fn) {
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

const post = (body, { key, customer = CUSTOMER } = {}) =>
  route.POST(new Request("http://localhost/api/drug-inventory", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cdss-customer-id": customer,
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(body),
  }));

const snapshot = async (customer = CUSTOMER) => {
  inv.resetDrugInventoryCacheForTests();
  return (await route.GET(new Request("http://localhost/api/drug-inventory", {
    headers: { "x-cdss-customer-id": customer },
  }))).json();
};

const auditCodes = async (customer = CUSTOMER) =>
  (await queryTenantAuditEvents("his-integrator", tenantAuditCustomerHash("his-integrator", customer), 500))
    .map((event) => event.code);
const countCode = (codes, code) => codes.filter((item) => item === code).length;

const STOCK_A = { source: "HIS-A", items: [
  { name: "麻黄", kind: "herb", available: true, goodsId: "A-1" },
  { name: "黄芪", kind: "herb", available: true, goodsId: "A-2" },
] };
const STOCK_B = { source: "HIS-B", items: [{ name: "当归", kind: "herb", available: true, goodsId: "B-1" }] };

await run("IDEM-01 同键同体重放首次响应，且不再写第二次库存", async () => {
  const key = "inventory-import-20260915-001";
  const first = await post(STOCK_A, { key });
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.itemCount, 2);
  assert.equal(first.headers.get("idempotent-replay"), null, "首次写入不得标成重放");

  const startedBefore = countCode(await auditCodes(), "inventory_import_started");
  const replay = await post(STOCK_A, { key });
  const replayBody = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("idempotent-replay"), "true", "重放必须显式告知调用方");
  assert.deepEqual(replayBody, firstBody, "重放响应体必须与首次逐字节相同（含 importedAt）");

  const codes = await auditCodes();
  assert.equal(countCode(codes, "inventory_import_started"), startedBefore,
    "重放不得再触发一次写入——账本里不能多出 inventory_import_started");
  assert.equal(countCode(codes, "inventory_import_replayed") >= 1, true,
    "重放必须在租户账本里留痕，否则运维看不出这次是去重");
});

await run("IDEM-02 同键不同体 409，且线上库存一个字节都不动", async () => {
  const key = "inventory-import-20260915-001";
  const before = await snapshot();
  const conflict = await post(STOCK_B, { key });
  const body = await conflict.json();
  assert.equal(conflict.status, 409);
  assert.equal(body.code, "idempotency_conflict");

  const after = await snapshot();
  assert.equal(after.itemCount, 2, "冲突请求不得改动库存条目数");
  assert.equal(after.inventoryVersion, before.inventoryVersion, "冲突请求不得产生新版本");
  // 危害的本体：被覆盖的药味不会退回 unknown，而是被讲成缺货。
  inv.resetDrugInventoryCacheForTests();
  assert.equal((await inv.herbAvailabilityView(CUSTOMER)).statusOf("麻黄"), "in_stock",
    "院内有货的药味不得因一次重复提交变成缺货");
  assert.equal(countCode(await auditCodes(), "idempotency_conflict") >= 1, true);
});

await run("IDEM-03 不带幂等键一律 400，且库存一个字节不动（owner 2026-09-15 裁定必填）", async () => {
  const before = await snapshot();
  const rejected = await post(STOCK_B);
  assert.equal(rejected.status, 400, "缺幂等键必须当场拒绝，不能因为客户已登记就放行");
  assert.equal((await rejected.json()).code, "idempotency_key_required");
  const after = await snapshot();
  assert.equal(after.itemCount, before.itemCount, "被拒的请求不得改动库存");
  assert.equal(after.inventoryVersion, before.inventoryVersion);
});

await run("IDEM-03b 缺键的判定先于请求体解析：载荷同时非法时仍报缺键", async () => {
  // 钉住校验位置。放在载荷校验之后的话，这一发会返回 invalid_inventory_items——
  // 那说明 8MB 载荷已经被读完才拒，也说明两条路径的先后关系漂了。
  const rejected = await post({ source: "x", items: "not-an-array" });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, "idempotency_key_required",
    "缺键必须先于载荷内在错误被判定");
});

await run("IDEM-03c 缺键不留任何租户副作用：未知客户不得被 JIT 登记", async () => {
  // 与 PROV-08 同向：失败的首提交不得留下已激活租户。缺键若排在 requireCustomerContext
  // 之后，这一发会把 hospital-idem-ghost 登记出来。
  const ghost = "hospital-idem-ghost";
  const rejected = await post(STOCK_A, { customer: ghost });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, "idempotency_key_required");
  const registry = JSON.parse(await readFile(process.env.CDSS_CUSTOMER_REGISTRY_PATH, "utf8").catch(() => '{"customers":[]}'));
  assert.equal((registry.customers || []).some((item) => item.customerId === ghost), false,
    "缺键被拒的请求不得在注册表留下任何状态的条目");
});

await run("IDEM-04 并发同键同体只写一次，两个响应一致", async () => {
  const key = "inventory-import-20260915-concurrent";
  const payload = { source: "HIS-C", items: [{ name: "白术", kind: "herb", available: true, goodsId: "C-1" }] };
  const startedBefore = countCode(await auditCodes(), "inventory_import_started");
  const [left, right] = await Promise.all([post(payload, { key }), post(payload, { key })]);
  const [leftBody, rightBody] = await Promise.all([left.json(), right.json()]);
  assert.equal(left.status, 200);
  assert.equal(right.status, 200);
  assert.deepEqual(leftBody, rightBody, "并发重复提交必须收到同一份结果");
  assert.equal(countCode(await auditCodes(), "inventory_import_started"), startedBefore + 1,
    "并发两发只能落一次写入");
  const replayed = [left, right].filter((response) => response.headers.get("idempotent-replay") === "true");
  assert.equal(replayed.length, 1, "并发两发里必须恰有一发被判为重放");
});

await run("IDEM-05 分片整批替换：同一个键的各片各自去重，不误判冲突", async () => {
  const key = "inventory-import-20260915-parts";
  const importId = "IMPORT-20260915-A";
  const part0 = { source: "HIS-P", part: { importId, index: 0, total: 2 },
    items: [{ name: "茯苓", kind: "herb", available: true, goodsId: "P-1" }] };
  const part1 = { source: "HIS-P", part: { importId, index: 1, total: 2 },
    items: [{ name: "甘草", kind: "herb", available: true, goodsId: "P-2" }] };

  const staged = await post(part0, { key });
  assert.equal(staged.status, 202, "第一片只暂存");
  const stagedAgain = await post(part0, { key });
  assert.equal(stagedAgain.status, 202, "重发同一片仍是暂存，不得判冲突");

  const committed = await post(part1, { key });
  assert.equal(committed.status, 200, "同一个键传第二片必须照常提交，不得被判 409");
  const after = await snapshot();
  assert.equal(after.itemCount, 2, "集齐分片后做一次整批替换");

  // 提交那一片重发 ⇒ 重放已提交结果，而不是把单独一片当成新的一次导入。
  const replay = await post(part1, { key });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("idempotent-replay"), "true");
  assert.equal((await snapshot()).itemCount, 2, "重放不得改动已提交的库存");

  // 把用过的键复用到**另一次**导入，必须在第一片就 409，而不是把几片都暂存完再报。
  // 曾给记录身份加过 part:<index> 作用域，那样这一片会被判成「另一条记录」照常暂存，
  // 冲突拖到最后一片才暴露——本条就是那个设计的反证。
  const reusedKeyNewImport = await post({ source: "HIS-P2",
    part: { importId: "IMPORT-20260915-A2", index: 0, total: 2 },
    items: [{ name: "生姜", kind: "herb", available: true, goodsId: "P-9" }] }, { key });
  assert.equal(reusedKeyNewImport.status, 409, "键复用到另一次导入必须在第一片就 409");
  assert.equal((await reusedKeyNewImport.json()).code, "idempotency_conflict");
});

await run("IDEM-06 幂等键格式非法一律 400，绝不静默当成没给", async () => {
  const before = await snapshot();
  const rejected = await post(STOCK_B, { key: "short" });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, "idempotency_key_required");
  const after = await snapshot();
  assert.equal(after.inventoryVersion, before.inventoryVersion, "被拒的请求不得写入库存");
});

await run("IDEM-07 未落盘的失败不占键：同键改正载荷后可继续", async () => {
  const key = "inventory-import-20260915-recover";
  const importId = "IMPORT-20260915-B";
  const staged = await post({ part: { importId, index: 0, total: 2 },
    items: [{ name: "陈皮", kind: "herb", available: true, goodsId: "R-1" }] }, { key: "inventory-import-seed-b" });
  assert.equal(staged.status, 202);
  const conflictTotal = await post({ part: { importId, index: 1, total: 3 },
    items: [{ name: "半夏", kind: "herb", available: true, goodsId: "R-2" }] }, { key });
  assert.equal(conflictTotal.status, 409);
  assert.equal((await conflictTotal.json()).code, "import_part_total_conflict",
    "这是分片总数冲突，不是幂等冲突");
  const corrected = await post({ part: { importId, index: 1, total: 2 },
    items: [{ name: "半夏", kind: "herb", available: true, goodsId: "R-2" }] }, { key });
  assert.equal(corrected.status, 200, "失败的写入不得占用幂等键——改正后同键必须能继续");
});

await run("IDEM-08 幂等记录按客户隔离，同一个键在别的客户下不冲突", async () => {
  const key = "inventory-import-20260915-shared-key";
  const mine = await post(STOCK_A, { key });
  assert.equal(mine.status, 200);
  const theirs = await post(STOCK_B, { key, customer: OTHER });
  assert.equal(theirs.status, 200, "同一个键在另一个客户下是另一条记录，不得判冲突");
  assert.equal((await snapshot(OTHER)).itemCount, 1);
  assert.notEqual((await snapshot()).itemCount, 1, "跨客户不得互相覆盖");

  // 隔离不能只靠「各客户各写一个文件」这一层：记录身份本身也必须带客户维度，
  // 否则日后把记录合并到一张表里就会跨租户串号，而文件分开时这一点完全测不出来。
  const mineHashes = (await idem.inventoryIdempotencyRecordsForTests(CUSTOMER)).map((item) => item.recordHash);
  const theirHashes = (await idem.inventoryIdempotencyRecordsForTests(OTHER)).map((item) => item.recordHash);
  assert.equal(theirHashes.length > 0, true);
  assert.equal(theirHashes.some((hash) => mineHashes.includes(hash)), false,
    "同一个幂等键在两个客户下必须得到不同的记录身份");
});

await run("IDEM-09 落盘只存键的摘要，不存原始键", async () => {
  const key = "inventory-import-20260915-secret-key";
  await post(STOCK_A, { key });
  const raw = await readFile(`${inv.drugInventoryPath(CUSTOMER)}.idempotency.json`, "utf8");
  assert.equal(raw.includes(key), false, "幂等记录不得落原始键（与客户登记表只存 hash 一致）");
  const records = await idem.inventoryIdempotencyRecordsForTests(CUSTOMER);
  assert.equal(records.every((item) => /^[a-f0-9]{64}$/.test(item.recordHash)), true);
});

await run("IDEM-10 过期记录不再重放，按正常写入执行", async () => {
  const key = "inventory-import-20260915-expiring";
  const first = await post(STOCK_A, { key });
  assert.equal(first.status, 200);
  const path = `${inv.drugInventoryPath(CUSTOMER)}.idempotency.json`;
  const file = JSON.parse(await readFile(path, "utf8"));
  const expired = new Date(Date.now() - idem.INVENTORY_IDEMPOTENCY_TTL_MS - 60_000).toISOString();
  file.records = file.records.map((item) => ({ ...item, createdAt: expired }));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, JSON.stringify(file), "utf8");

  const startedBefore = countCode(await auditCodes(), "inventory_import_started");
  const afterTtl = await post(STOCK_B, { key });
  assert.equal(afterTtl.status, 200, "记录过期后同键不同体不再判冲突");
  assert.equal(countCode(await auditCodes(), "inventory_import_started"), startedBefore + 1,
    "过期后必须真的执行一次写入");
});

await run("IDEM-12 记录文件损坏时 fail-open：照常导入，绝不因此拒绝一次合法写入", async () => {
  const key = "inventory-import-20260915-corrupt";
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${inv.drugInventoryPath(CUSTOMER)}.idempotency.json`, "{ 这不是 JSON", "utf8");
  const startedBefore = countCode(await auditCodes(), "inventory_import_started");
  const response = await post(STOCK_A, { key });
  assert.equal(response.status, 200,
    "幂等记录是写入去重、不是安全控制；记录读不出来时必须退回到照常执行一次");
  assert.equal(countCode(await auditCodes(), "inventory_import_started"), startedBefore + 1);
  // 损坏的文件必须被下一次写入覆盖成合法记录，而不是永远读不出来。
  const records = await idem.inventoryIdempotencyRecordsForTests(CUSTOMER);
  assert.equal(records.length >= 1, true, "损坏后的第一次写入必须重建出可用记录");
  const replay = await post(STOCK_A, { key });
  assert.equal(replay.headers.get("idempotent-replay"), "true", "重建后的记录必须真的能用于重放");
});

await run("IDEM-11 指纹与键序无关，但与取值有关", async () => {
  const ordered = idem.inventoryRequestFingerprint({ source: "HIS", items: [{ name: "麻黄", kind: "herb" }] });
  const reordered = idem.inventoryRequestFingerprint({ items: [{ kind: "herb", name: "麻黄" }], source: "HIS" });
  assert.equal(ordered, reordered, "同一请求换个序列化顺序不得被判成不同请求");
  const changed = idem.inventoryRequestFingerprint({ source: "HIS", items: [{ name: "麻黄", kind: "herb", goodsId: "X" }] });
  assert.notEqual(ordered, changed, "载荷有任何取值差异都必须是不同指纹");
});

// 本套件全部用例体都是 async：跑器必须真的接得住异步断言错误，否则整套会静默变绿。
// 这不是形式主义——test-cdss-reason-codes 就栽过一次，同步 check 把 async 用例体的错吞了。
await run("IDEM-GUARD 跑器必须接住异步断言错误", async () => {
  const before = failures.length;
  await run("probe", async () => { assert.equal(1, 2, "故意失败"); });
  assert.equal(failures.length, before + 1, "异步用例体的失败必须被记到 failures 里");
  failures.splice(before, 1);
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "inventory-import-idempotency", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "inventory-import-idempotency", cases: 15, failures: 0 }));
