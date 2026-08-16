import path from "node:path";
import { createJiti } from "jiti";
const repoRoot = "/home/coder/workspace/中医CDSS";
const jiti = createJiti(import.meta.url, { jsx:true, interopDefault:true, alias:{ "@": path.join(repoRoot,"src"), "server-only": path.join(repoRoot,"node_modules/next/dist/compiled/server-only/empty.js") }});
const m = await jiti.import("../src/lib/clinical-governance-tables.ts");
const fn = m.governedSyndromeNameAcceptable;
console.log("谓词存在:", typeof fn);
const NAMES = [
  "肝气郁结证","肝郁气滞证","气滞证","肝郁证",
  "阳明气分热盛证","气分热盛证","阳明经证","里热炽盛证","白虎汤证",
  "风寒束表证","瘀血阻络证","脾胃虚寒证","肝胃郁热证","肾阴亏虚证","湿热蕴结证",
];
for (const n of NAMES) {
  let r; try { r = fn(n); } catch (e) { r = "ERR:"+e.message; }
  console.log(`  ${String(JSON.stringify(r)).padEnd(48)} ${n}`);
}
