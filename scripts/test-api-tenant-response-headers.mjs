import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

process.env.CDSS_API_TOKEN = "test-api-isolation-token-at-least-32-characters";
process.env.CDSS_REQUIRE_API_AUTH = "true";
process.env.CDSS_API_CLIENT_ID = "his-integrator";
process.env.CDSS_API_CUSTOMER_IDS = "hospital-A,hospital-B";
process.env.CDSS_DRUG_INVENTORY_PATH = mkdtempSync(join(tmpdir(), "cdss-api-isolation-"));

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { proxy } = jiti("../src/proxy.ts");
const inventoryRoute = await jiti.import("../src/app/api/drug-inventory/route.ts");

function proxyRequest(path) {
  return new NextRequest(`https://cdss.example${path}`, {
    headers: { "x-cdss-api-token": process.env.CDSS_API_TOKEN },
  });
}

const proxied = await proxy(proxyRequest("/api/diagnosis/health"));
assert.equal(proxied.headers.get("cache-control"), "private, no-store");
const vary = (proxied.headers.get("vary") || "").toLowerCase();
for (const header of ["x-cdss-customer-id", "x-cdss-api-token", "authorization"]) {
  assert.match(vary, new RegExp(`(?:^|,\\s*)${header}(?:,|$)`), `Vary 缺少 ${header}`);
}

const customerRequest = new Request("https://cdss.example/api/drug-inventory", {
  headers: { "x-cdss-customer-id": "hospital-A" },
});
const emptyInventory = await inventoryRoute.GET(customerRequest);
assert.equal(emptyInventory.status, 200);
assert.equal(emptyInventory.headers.get("x-cdss-customer-id"), "hospital-A");

const imported = await inventoryRoute.POST(new Request("https://cdss.example/api/drug-inventory", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-cdss-customer-id": "hospital-A",
  },
  body: JSON.stringify({ items: [{ name: "黄芪", kind: "herb", available: true }] }),
}));
assert.equal(imported.status, 200);
assert.equal(imported.headers.get("x-cdss-customer-id"), "hospital-A");

const forbidden = await inventoryRoute.GET(new Request("https://cdss.example/api/drug-inventory", {
  headers: { "x-cdss-customer-id": "hospital-C" },
}));
assert.equal(forbidden.status, 403);
assert.equal(forbidden.headers.get("x-cdss-customer-id"), null,
  "未授权响应不得回显攻击者提供的客户标识");

console.log(JSON.stringify({ suite: "api-tenant-response-headers", headers: 5, failures: 0 }));
