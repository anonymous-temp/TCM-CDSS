import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { migrateInventoryToCustomer } = await import("./migrate-drug-inventory-to-customer.mjs");
const work = mkdtempSync(join(tmpdir(), "cdss-inventory-migration-"));
const source = join(work, "drug-inventory.json");
const root = join(work, "drug-inventory");
const file = { inventoryVersion: "v1", items: [{ name: "黄芪", kind: "herb", available: true }] };
writeFileSync(source, JSON.stringify(file));

await assert.rejects(() => migrateInventoryToCustomer({ source, root, customerId: "bad/id" }), /invalid customer id/);
const result = await migrateInventoryToCustomer({ source, root, customerId: "hospital-A" });
assert.equal(existsSync(`${source}.pre-tenant-backup`), true);
assert.deepEqual(JSON.parse(readFileSync(result.target, "utf8")), file);
await assert.rejects(() => migrateInventoryToCustomer({ source, root, customerId: "hospital-A" }), /target already exists/);

console.log(JSON.stringify({ suite: "inventory-customer-migration", failures: 0 }));
