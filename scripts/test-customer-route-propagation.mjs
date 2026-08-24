import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { GLOBAL_API_ROUTES, CUSTOMER_BOUND_API_ROUTES } = await jiti.import("../src/lib/api-route-classification.ts");

function routeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [relative(process.cwd(), path)] : [];
  });
}

const globalRoutes = [...GLOBAL_API_ROUTES];
const customerBoundRoutes = [...CUSTOMER_BOUND_API_ROUTES];
const overlap = globalRoutes.filter((file) => customerBoundRoutes.includes(file));
assert.deepEqual(overlap, [], "API 路由不得同时被归类为全局与客户绑定");
assert.deepEqual(
  [...new Set([...globalRoutes, ...customerBoundRoutes])].sort(),
  routeFiles(join(process.cwd(), "src/app/api")).sort(),
  "新增 API 路由必须显式归入全局或客户绑定清单",
);

for (const file of customerBoundRoutes) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  assert.match(source, /requireCustomerContext|readCustomerBoundCaseStateRequest/, `${file} 未绑定客户上下文`);
}

const requestSource = readFileSync(new URL("../src/lib/diagnosis-request.ts", import.meta.url), "utf8");
assert.match(requestSource, /export async function readCustomerBoundCaseStateRequest/);
assert.match(requestSource, /customerId:\s*customer\.context\.customerId/);
assert.match(requestSource, /clinicalFactsTenantBindingMatches\([\s\S]*customer\.context\.customerId/,
  "tenant-bound clinical-facts attestations must be checked after authenticated customer binding");

console.log(JSON.stringify({
  suite: "customer-route-propagation",
  routes: customerBoundRoutes.length,
  globalRoutes: globalRoutes.length,
  failures: 0,
}));
