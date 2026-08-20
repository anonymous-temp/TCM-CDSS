import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

process.env.CDSS_DRUG_INVENTORY_PATH = mkdtempSync(join(tmpdir(), "cdss-inventory-concurrency-"));
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const inventory = await jiti.import("../src/lib/drug-inventory.server.ts");

const sameCustomerWrites = await Promise.allSettled([
  inventory.importDrugInventory("hospital-A", {
    items: [{ name: "黄芪", kind: "herb", available: true, goodsId: "FULL-A" }],
  }),
  inventory.importDrugInventory("hospital-A", {
    items: [{ name: "当归", kind: "herb", available: true, goodsId: "FULL-B" }],
  }),
]);
assert.equal(sameCustomerWrites.every((result) => result.status === "fulfilled"), true,
  "同客户并发整批导入必须串行完成，不能争用同一个临时文件");
assert.equal((await inventory.drugInventorySnapshot("hospital-A")).itemCount, 1,
  "并发整批导入的最终状态必须是某一完整批次，不能混批");

const sameImportParts = await Promise.allSettled([
  inventory.importDrugInventory("hospital-B", {
    items: [{ name: "黄芪", kind: "herb", available: true, goodsId: "PART-0" }],
    part: { importId: "same-import", index: 0, total: 2 },
  }),
  inventory.importDrugInventory("hospital-B", {
    items: [{ name: "当归", kind: "herb", available: true, goodsId: "PART-1" }],
    part: { importId: "same-import", index: 1, total: 2 },
  }),
]);
assert.equal(sameImportParts.every((result) => result.status === "fulfilled"), true,
  "同客户同 importId 的分片读改写必须串行");
assert.equal((await inventory.drugInventorySnapshot("hospital-B")).itemCount, 2,
  "并发到达的两个分片不得丢失任意一片");

await Promise.all([
  inventory.importDrugInventory("hospital-C", {
    items: [{ name: "麻黄", kind: "herb", available: true, goodsId: "C-0" }],
    part: { importId: "shared-import", index: 0, total: 2 },
  }),
  inventory.importDrugInventory("hospital-D", {
    items: [{ name: "桂枝", kind: "herb", available: true, goodsId: "D-0" }],
    part: { importId: "shared-import", index: 0, total: 2 },
  }),
]);
await Promise.all([
  inventory.importDrugInventory("hospital-C", {
    items: [{ name: "杏仁", kind: "herb", available: true, goodsId: "C-1" }],
    part: { importId: "shared-import", index: 1, total: 2 },
  }),
  inventory.importDrugInventory("hospital-D", {
    items: [{ name: "白芍", kind: "herb", available: true, goodsId: "D-1" }],
    part: { importId: "shared-import", index: 1, total: 2 },
  }),
]);
assert.equal((await inventory.drugInventorySnapshot("hospital-C")).itemCount, 2);
assert.equal((await inventory.drugInventorySnapshot("hospital-D")).itemCount, 2);
assert.doesNotMatch(JSON.stringify(await inventory.drugInventorySnapshot("hospital-C")), /D-[01]/);
assert.doesNotMatch(JSON.stringify(await inventory.drugInventorySnapshot("hospital-D")), /C-[01]/);

inventory.resetDrugInventoryCacheForTests();
const realDateNow = Date.now;
let now = 1_800_000_000_000;
Date.now = () => now;
try {
  await inventory.herbAvailabilityView("tenant-anchor");
  now += inventory.DRUG_INVENTORY_CACHE_IDLE_TTL_MS + 1;
  await inventory.herbAvailabilityView("tenant-after-ttl");
  assert.equal(inventory.isDrugInventoryCustomerCachedForTests("tenant-anchor"), false,
    "空闲超过 30 分钟的客户缓存必须被淘汰");

  for (let index = 0; index < 501; index += 1) {
    await inventory.herbAvailabilityView(`tenant-${String(index).padStart(6, "0")}`);
  }
  assert.equal(inventory.drugInventoryCacheSizeForTests() <= 500, true,
    "客户缓存不得无限增长");
} finally {
  Date.now = realDateNow;
}

const source = readFileSync(new URL("../src/lib/drug-inventory.server.ts", import.meta.url), "utf8");
assert.match(source, /randomUUID\(\)/, "原子写入临时文件必须使用随机 UUID，不能只用进程 PID");

console.log(JSON.stringify({ suite: "drug-inventory-concurrency", customers: 505, failures: 0 }));
