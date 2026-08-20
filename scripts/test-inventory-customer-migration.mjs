import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const { migrateInventoryToCustomer } = await import("./migrate-drug-inventory-to-customer.mjs");
const work = mkdtempSync(join(tmpdir(), "cdss-inventory-migration-"));
const source = join(work, "drug-inventory.json");
const root = join(work, "drug-inventory");
const file = { inventoryVersion: "v1", items: [{ name: "黄芪", kind: "herb", available: true }] };
writeFileSync(source, JSON.stringify(file));

await assert.rejects(() => migrateInventoryToCustomer({ source, root, customerId: "bad/id" }), /invalid customer id/);
const result = await migrateInventoryToCustomer({ source, root, customerId: "hospital-A" });
assert.equal(existsSync(`${source}.pre-tenant-backup`), true);
assert.deepEqual(JSON.parse(readFileSync(source, "utf8")), file, "迁移不得改写旧源文件");
assert.deepEqual(JSON.parse(readFileSync(`${source}.pre-tenant-backup`, "utf8")), file, "备份必须逐字保留旧库存");
const migrated = JSON.parse(readFileSync(result.target, "utf8"));
assert.equal(migrated.schemaVersion, "tcm-cdss-drug-inventory-v2");
assert.equal(migrated.customerId, "hospital-A");
assert.equal(migrated.itemCount, 1);
assert.deepEqual(migrated.items, file.items);
assert.notEqual(migrated.inventoryVersion, file.inventoryVersion, "v2 版本必须绑定客户身份并重新计算");
await assert.rejects(() => migrateInventoryToCustomer({ source, root, customerId: "hospital-A" }), /target already exists/);

const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
assert.equal(
  packageJson.scripts?.["migrate:drug-inventory-customer"],
  "node scripts/migrate-drug-inventory-to-customer.mjs",
  "库存迁移必须有正式 npm 命令入口",
);

const cliWork = mkdtempSync(join(tmpdir(), "cdss-inventory-migration-cli-"));
const cliSource = join(cliWork, "legacy-inventory.json");
const cliRoot = join(cliWork, "customer-inventory");
writeFileSync(cliSource, JSON.stringify(file));
const cliArgs = [
  "scripts/migrate-drug-inventory-to-customer.mjs",
  "--source", cliSource,
  "--root", cliRoot,
  "--customer-id", "hospital-CLI",
];
const cliFirst = spawnSync(process.execPath, cliArgs, { cwd: process.cwd(), encoding: "utf8" });
assert.equal(cliFirst.status, 0, cliFirst.stderr);
const cliResult = JSON.parse(cliFirst.stdout);
assert.equal(existsSync(cliResult.target), true);
const cliSecond = spawnSync(process.execPath, cliArgs, { cwd: process.cwd(), encoding: "utf8" });
assert.notEqual(cliSecond.status, 0, "重复迁移不得覆盖已存在的客户目标文件");
assert.match(cliSecond.stderr, /target already exists/);

console.log(JSON.stringify({ suite: "inventory-customer-migration", failures: 0 }));
