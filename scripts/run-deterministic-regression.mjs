import { spawnSync } from "node:child_process";

const scripts = [
  "test:rxaudit-contract",
  "test:rxaudit-payload",
  "test:rxaudit-routes",
  "test:safety-pediatric",
  "test:safety-mutations",
  "test:clinical-facts",
  "test:evidence-sentinel",
  "test:evimed-normalization",
  "test:upstream-guards",
  "test:authoritative-his",
  "test:formula-provenance",
  "test:lineage-governance",
  "test:tcm-treatments",
  "test:customer-evidence",
  "test:stage-contract",
  "test:stream-safety",
  "test:clinical-grounding",
  "test:clinical-entry",
  "test:clinical-terminology",
  "test:clinical-polarity",
  "test:m03-entry",
  "test:m02-contract",
  "test:m02-answer-interpreter",
  "test:prescription-permission",
  "test:primary-care-50-contracts",
  "test:diagnosis-display",
  "test:reasoning-signature",
  "test:model-rate-limit",
  "test:evidence-display",
  "test:stage-telemetry",
  "test:m03-clinical-review",
  "test:prompt-injection",
];

const startedAt = Date.now();
for (const [index, script] of scripts.entries()) {
  console.error(`[deterministic] ${index + 1}/${scripts.length} ${script}`);
  const result = spawnSync("npm", ["run", script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(JSON.stringify({ script, status: result.status, signal: result.signal }));
    process.exit(result.status || 1);
  }
}

console.log(JSON.stringify({ suites: scripts.length, failures: 0, elapsedMs: Date.now() - startedAt }, null, 2));
