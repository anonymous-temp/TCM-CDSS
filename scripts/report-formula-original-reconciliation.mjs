// 受治理目录 × 原方组成表 对账报告：node scripts/report-formula-original-reconciliation.mjs [--json <file>]
import { createJiti } from "jiti";
import { writeFileSync } from "node:fs";
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { catalogOriginalReconciliation, governedCatalogOriginalDifferences } = await jiti.import("../src/lib/formula-original-reconciliation.ts");
const result = catalogOriginalReconciliation();
const all = governedCatalogOriginalDifferences();
const byClass = {};
for (const item of all) byClass[item.sourceClass] = (byClass[item.sourceClass] || 0) + 1;
console.log(JSON.stringify({ compared: result.compared, differences: all.length, byClass, accepted: result.accepted, unresolved: result.unresolved.length, staleAccepted: result.staleAccepted.length }));
const out = process.argv.indexOf("--json");
if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify({ differences: all, unresolved: result.unresolved, staleAccepted: result.staleAccepted }, null, 1));
else for (const item of result.unresolved.slice(0, 40)) console.log(`${item.name}${item.source}〔${item.sourceClass}/${item.tier}〕 目录多:${item.extraInCatalog.join("、") || "-"} 目录缺:${item.missingInCatalog.join("、") || "-"}`);
