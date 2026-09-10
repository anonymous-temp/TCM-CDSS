import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createJiti } from "jiti";

// Exercise the real static harness without an HTTP server, env files or real credentials.
const syntheticEnv = {
  PATH: process.env.PATH,
  JITI_FS_CACHE: process.env.JITI_FS_CACHE || "false",
  STATIC_ONLY: "1", CDSS_IGNORE_LOCAL_ARTIFACTS: "1",
  REASONING_CONTRACT_SIGNING_KEY: "golden-frontend-offline-signing-key-at-least-32-characters",
  CDSS_API_CLIENT_ID: "golden-frontend-client", CDSS_API_CUSTOMER_IDS: "golden-frontend-customer",
  CDSS_DEFAULT_CUSTOMER_ID: "golden-frontend-customer", CDSS_CUSTOMER_ID: "golden-frontend-customer",
  RXAI_AUDIT_ENABLED: "false",
};
Object.assign(process.env, syntheticEnv);
const harnessUrl = new URL("./regress-tcm-cdss.mjs", import.meta.url);
const harness = readFileSync(harnessUrl, "utf8");
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const signature = await jiti.import("../src/lib/reasoning-contract-signature.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");
const display = await jiti.import("../src/lib/followup-display-state.ts");
const persistence = await jiti.import("../src/lib/browser-case-persistence.ts");
const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const rxaudit = await jiti.import("../src/lib/rxaudit.ts");
const bindings = { ...signature, ...safety, ...types, ...knowledge, ...visible, ...rxaudit,
  CDSS_CUSTOMER_ID: syntheticEnv.CDSS_CUSTOMER_ID };

function between(start, end) {
  const from = harness.indexOf(start);
  const to = harness.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `real harness boundaries: ${start} / ${end}`);
  return harness.slice(from, to);
}
const definitions = between("const collapse =", "async function request(")
  .replaceAll("import.meta.url", JSON.stringify(harnessUrl.href));
const fixtures = between("function hisRecord(", "function expected(");
const load = new Function(...Object.keys(bindings), "readFileSync", "regressionJiti", "assert",
  `${fixtures}\n${definitions}\nreturn runFrontendContractChecks;`);

async function execute({ displayOverrides = {}, persistenceOverrides = {}, mutatePage } = {}) {
  const failures = [];
  const read = (url, encoding) => {
    const content = readFileSync(url, encoding);
    return mutatePage && String(url).endsWith("DiagnosisClient.tsx") ? mutatePage(content) : content;
  };
  const imports = { import: async (specifier) => {
    if (specifier.endsWith("followup-display-state.ts")) return { ...display, ...displayOverrides };
    if (specifier.endsWith("browser-case-persistence.ts")) return { ...persistence, ...persistenceOverrides };
    return jiti.import(specifier);
  } };
  const run = load(...Object.values(bindings), read, imports, (ok, message) => { if (!ok) failures.push(message); });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Offline static contract test attempted a network request"); };
  try { await run(); } finally { globalThis.fetch = previousFetch; }
  return failures;
}

test("real static CLI awaits exported behavior assertions and finishes with zero failures", () => {
  assert.match(harness, /async function main\(\)\s*\{\s*await runFrontendContractChecks\(\);\s*if \(STATIC_ONLY\)/);
  const result = spawnSync(process.execPath, [fileURLToPath(harnessUrl)], { env: syntheticEnv, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { mode: "static", failures: 0 });
});

test("unmodified executed static assertions pass independently of live HTTP tests", async () => {
  assert.deepEqual(await execute(), []);
});

const mutations = [
  { name: "restore cannot trust an obsolete ready gate", message: "restored snapshots",
    displayOverrides: { restoreWarningDisplayCase: (state) => state } },
  { name: "one-time skip intent cannot survive persistence", message: "one-time skip intent",
    persistenceOverrides: { sanitizeCaseStateForBrowserPersistence: (state) => state } },
  { name: "interrupted stages remain retryable", message: "in-flight M01-M05",
    displayOverrides: { recoverInterruptedRun: (state) => state } },
  { name: "untraceable evidence cannot become a reference", message: "traceable external evidence",
    displayOverrides: { shouldRenderEvidenceStatus: () => true } },
  { name: "all provider severities survive version binding", message: "version-bound to their own audit",
    displayOverrides: { revisionFromAudit: (...args) => ({ ...display.revisionFromAudit(...args), highestRiskLevel: "INFO" }) } },
  { name: "edited prescription body becomes the restored source", message: "source for restore",
    displayOverrides: { applyAcceptedPrescriptionDisplayResult: (...args) => ({ ...display.applyAcceptedPrescriptionDisplayResult(...args), prescription: "旧处方" }) } },
  { name: "accepted deterministic follow-up cannot be dropped", message: "reuses its deterministic M05 follow-up",
    displayOverrides: { applyAcceptedPrescriptionDisplayResult: (...args) => ({ ...display.applyAcceptedPrescriptionDisplayResult(...args), followupTimeline: [] }) } },
  { name: "degraded/manual-review flags survive normalization", message: "degraded/manual-review audit status",
    displayOverrides: { revisionFromAudit: (...args) => ({ ...display.revisionFromAudit(...args), degraded: false, needManualReview: false }) } },
  { name: "a fresh edited request clears only the legacy lock", message: "clears legacy audit locks",
    mutatePage: (source) => source.replace(/(const warningRequestState: CaseState = \{[\s\S]*?)safetyLocked: false/, "$1safetyLocked: true") },
  { name: "NOT_SUBMITTED never receives a fabricated low-risk PASS", message: "degraded/manual-review audit status",
    displayOverrides: { revisionFromAudit: (...args) => {
      const revision = display.revisionFromAudit(...args);
      return revision.auditResult === "NOT_SUBMITTED" ? { ...revision, auditResult: "PASS", highestRiskLevel: "LOW" } : revision;
    } } },
  { name: "the encrypted snapshot must be saved before local adoption", message: "persists synchronously",
    mutatePage: (source) => source.replace("? await saveWorkspaceSnapshot({", "? saveWorkspaceSnapshot({") },
];
for (const mutation of mutations) test(`counterexample: ${mutation.name}`, async () => {
  const failures = await execute(mutation);
  assert.ok(failures.some((message) => message.includes(mutation.message)), JSON.stringify(failures));
});
