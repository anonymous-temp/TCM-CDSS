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
  "test:local-patent-medicines",
  "test:patent-medicine-ranking",
  "test:upstream-guards",
  "test:authoritative-his",
  "test:formula-provenance",
  "test:classic-evidence-bundling",
  "test:syndrome-equivalence",
  "test:syndrome-hypothesis",
  "test:customer-dose-parity",
  "test:primary-care-50-safety",
  "test:snapshot-auth-binding",
  "test:lineage-governance",
  "test:tcm-treatments",
  "test:acupoint-evidence",
  "test:modern-case-corpus",
  "test:disease-lexicon",
  "test:runtime-data-presence",
  "test:pregnancy-recall",
  "test:warm-disease-rules",
  "test:customer-evidence",
  "test:stage-contract",
  "test:m03-parallel-merge",
  "test:repair-guidance",
  "test:therapy-vocabulary",
  "test:stage-outcome",
  "test:formula-selection-symmetry",
  "test:herb-name-resolution",
  "test:herb-breadth-surface",
  "test:m04-dose-index",
  "test:m04-safety-contract",
  "test:guard-symmetry",
  "test:rejection-tiers",
  "test:stream-safety",
  "test:stream-modules",
  "test:recorded-fact-visibility",
  "test:clinical-grounding",
  "test:inspection-lexicon",
  "test:clinical-entry",
  "test:clinical-terminology",
  "test:controlled-semantic-normalization",
  "test:clinical-governance-tables",
  "test:clinical-polarity",
  "test:m03-entry",
  "test:m02-contract",
  "test:m02-nonblocking",
  "test:m02-answer-interpreter",
  "test:prescription-permission",
  "test:primary-care-50-contracts",
  "test:diagnosis-display",
  "test:icd10-coding",
  "test:reasoning-signature",
  "test:model-rate-limit",
  "test:evidence-display",
  "test:stage-telemetry",
  "test:m03-clinical-review",
  "test:nihaisha-fusion",
  "test:nihaisha-replay",
  "test:prompt-injection",
];

const startedAt = Date.now();
// Defense-in-depth: suites must pin their own audit config. Scrub inherited RXAI_AUDIT_* shell
// overrides (e.g. a small RXAI_AUDIT_TOTAL_TIMEOUT_MS) so they cannot leak into child processes.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("RXAI_AUDIT_")),
);
for (const [index, script] of scripts.entries()) {
  console.error(`[deterministic] ${index + 1}/${scripts.length} ${script}`);
  const result = spawnSync("npm", ["run", script], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(JSON.stringify({ script, status: result.status, signal: result.signal }));
    process.exit(result.status || 1);
  }
}

console.log(JSON.stringify({ suites: scripts.length, failures: 0, elapsedMs: Date.now() - startedAt }, null, 2));
