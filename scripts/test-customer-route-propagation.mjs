import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const customerBoundRoutes = [
  "src/app/api/diagnosis/collect/route.ts",
  "src/app/api/diagnosis/question/route.ts",
  "src/app/api/diagnosis/question/interpret/route.ts",
  "src/app/api/diagnosis/diagnose/route.ts",
  "src/app/api/diagnosis/prescribe/route.ts",
  "src/app/api/diagnosis/assess/route.ts",
  "src/app/api/diagnosis/post-prescription-risk/route.ts",
  "src/app/api/diagnosis/red-flags/route.ts",
  "src/app/api/diagnosis/his-scheme/route.ts",
  "src/app/api/diagnosis/emergency-clearance/route.ts",
  "src/app/api/diagnosis/terminology/confirm/route.ts",
  "src/app/api/diagnosis/snapshot/route.ts",
];
for (const file of customerBoundRoutes) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  assert.match(source, /requireCustomerContext|readCustomerBoundCaseStateRequest/, `${file} 未绑定客户上下文`);
}

const requestSource = readFileSync(new URL("../src/lib/diagnosis-request.ts", import.meta.url), "utf8");
assert.match(requestSource, /export async function readCustomerBoundCaseStateRequest/);
assert.match(requestSource, /caseState\.customerId\s*=\s*customer\.context\.customerId/);

console.log(JSON.stringify({ suite: "customer-route-propagation", routes: customerBoundRoutes.length, failures: 0 }));
