import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
assert.notEqual((await inventory.drugInventorySnapshot("hospital-A")).inventoryVersion, (await inventory.drugInventorySnapshot("hospital-B")).inventoryVersion);
assert.doesNotMatch(JSON.stringify(await inventory.drugInventorySnapshot("hospital-B")), /A-1/);

console.log(JSON.stringify({ suite: "multitenant-drug-inventory", customers: 2, failures: 0 }));
