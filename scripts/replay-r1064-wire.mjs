// Read-only saved-output replay. No model calls; no corpus text is copied into fixtures.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const f = await jiti.import("../src/lib/delivery-final-content.server.ts");
const { runDeliveryGates } = await jiti.import("../src/lib/delivery-gates.server.ts");
const { clinicalGroundingText } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { deliveryGatePolicy } = await jiti.import("../src/lib/delivery-gate-policy.ts");
const { deliveryHash } = await jiti.import("../src/lib/delivery-trusted-record.server.ts");
const root = "/home/coder/runlogs/r1018/work/r1063/out";
const files = readdirSync(root).filter(name => name.endsWith("-r46c")).flatMap(dir => readdirSync(join(root, dir)).filter(name => name.endsWith(".r1.json")).map(name => join(root, dir, name)));
const changes = [], counts = {}, changedPaths = {}, durations = [];
function diff(a, b, path = "") {
  if (deliveryHash(a) === deliveryHash(b)) return [];
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return [{ path, before: a, after: b }];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => diff(a[key], b[key], `${path}/${key}`));
}
let stages = 0, gateChanges = 0;
for (const file of files) {
  const value = JSON.parse(readFileSync(file, "utf8")), state = value.input, context = clinicalGroundingText(state);
  for (const stage of ["diagnose", "prescribe"]) {
    if (typeof value[stage]?.content !== "string") continue;
    stages++;
    const before = f.splitDeliveryContent(value[stage].content, stage).candidate;
    const prepared = f.prepareFinalDeliveryContent(value[stage].content);
    const after = f.splitDeliveryContent(prepared, stage).candidate;
    const delta = diff(before, after);
    if (delta.length) { changes.push({ file: basename(file), set: file.split("/").at(-2), stage, delta }); for (const d of delta) changedPaths[d.path] = (changedPaths[d.path] || 0) + 1; }
    const checked = await runDeliveryGates({ candidate: after, caseState: state, priorM03: value.diagnose?.structured,
      policy: deliveryGatePolicy({}), signal: new AbortController().signal, absoluteDeadline: Date.now() + 900 }, { review: async () => undefined });
    gateChanges += Number(checked.changed); durations.push(checked.durationMs);
    for (const finding of checked.findings) { const key = `${finding.ruleId}:${finding.status}`; counts[key] = (counts[key] || 0) + 1; }
  }
}
durations.sort((a,b) => a-b);
const report = { files: files.length, stages, projectedChangedStages: changes.length, gateChangedStages: gateChanges, changedPaths, findings: counts,
  localNoModelMs: { median: durations[Math.floor(durations.length / 2)], max: durations.at(-1) },
  note: "Saved outputs compared against the actual final projection and default shadow gates; unavailable models stay unknown. This is not live A/B or an accuracy/latency claim.", changes };
writeFileSync("/var/tmp/r1064-wire-replay.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, changes: undefined }, null, 2));
