import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

process.env.CDSS_DRUG_INVENTORY_PATH = mkdtempSync(join(tmpdir(), "cdss-tenant-inventory-"));
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const inventory = await jiti.import("../src/lib/drug-inventory.server.ts");

await inventory.importDrugInventory("hospital-A", { items: [{ name: "麻黄", kind: "herb", available: true, goodsId: "A-1" }] });
await inventory.importDrugInventory("hospital-B", { items: [{ name: "麻黄", kind: "herb", available: false, goodsId: "B-1" }] });

inventory.resetDrugInventoryCacheForTests();
const a = await inventory.herbAvailabilityView("hospital-A");
const b = await inventory.herbAvailabilityView("hospital-B");
assert.equal(a.statusOf("麻黄"), "in_stock");
assert.equal(b.statusOf("麻黄"), "out_of_stock");
assert.notEqual(inventory.drugInventoryPath("hospital-A"), inventory.drugInventoryPath("hospital-B"));
const snapshotA = await inventory.drugInventorySnapshot("hospital-A");
const snapshotB = await inventory.drugInventorySnapshot("hospital-B");
assert.equal(snapshotA.schemaVersion, "tcm-cdss-drug-inventory-v2");
assert.equal(snapshotA.customerId, "hospital-A");
assert.equal(snapshotB.customerId, "hospital-B");
assert.notEqual(snapshotA.inventoryVersion, snapshotB.inventoryVersion);
assert.doesNotMatch(JSON.stringify(await inventory.drugInventorySnapshot("hospital-B")), /A-1/);

const rawA = JSON.parse(readFileSync(inventory.drugInventoryPath("hospital-A"), "utf8"));
assert.equal(rawA.schemaVersion, "tcm-cdss-drug-inventory-v2");
assert.equal(rawA.customerId, "hospital-A");

const identicalItems = [{ name: "黄芪", kind: "herb", available: true, goodsId: "SAME-1" }];
await inventory.importDrugInventory("hospital-C", { items: identicalItems });
await inventory.importDrugInventory("hospital-D", { items: identicalItems });
assert.notEqual(
  (await inventory.drugInventorySnapshot("hospital-C")).inventoryVersion,
  (await inventory.drugInventorySnapshot("hospital-D")).inventoryVersion,
  "相同库存内容也必须因客户身份不同而产生不同版本",
);

copyFileSync(inventory.drugInventoryPath("hospital-A"), inventory.drugInventoryPath("hospital-B"));
inventory.resetDrugInventoryCacheForTests("hospital-B");
assert.equal(
  await inventory.drugInventorySnapshot("hospital-B"),
  null,
  "A 的库存文件错放到 B 路径时必须被归属校验隔离",
);

console.log(JSON.stringify({ suite: "multitenant-drug-inventory", customers: 4, failures: 0 }));
