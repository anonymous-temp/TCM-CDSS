/** Real full-stage A/B against two already configured candidate servers. Never changes settings. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { experienceCases, experienceCaseState } from "./lib/experience-fixtures.mjs";
import { measureExperienceResponse } from "./lib/experience-stream-measurement.mjs";
import { runClinicalModelPairs, pairModelIdentity } from "./lib/clinical-model-pairs.mjs";

const customer = process.env.CDSS_CUSTOMER_ID;
const token = process.env.CDSS_API_TOKEN;
if (!customer || !token) throw new Error("Inject existing customer identity and API token; no env files are read");
const targets = Object.fromEntries(["baseline", "alternative"].map(arm => {
  const value = process.env[`PAIR_${arm.toUpperCase()}_URL`];
  if (!value) throw new Error("Both PAIR_BASELINE_URL and PAIR_ALTERNATIVE_URL are required");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Use HTTP endpoint without embedded credentials, query or fragment");
  return [arm, value.replace(/\/$/, "")];
}));
const headers = { "Content-Type": "application/json", "x-cdss-api-token": token, "x-cdss-customer-id": customer };

const identities = {};
for (const arm of ["baseline", "alternative"]) {
  const response = await fetch(`${targets[arm]}/api/diagnosis/health?diagnostics=1`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Candidate ${arm} health unavailable`);
  const health = await response.json();
  identities[arm] = pairModelIdentity(health);
}

const call = async (arm, route, state) => {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${targets[arm]}/api/diagnosis/${route}`, {
      method: "POST", headers, body: JSON.stringify({ caseState: state }), signal: AbortSignal.timeout(230_000),
    });
    const observation = await measureExperienceResponse(response, { startedAt, streamed: route !== "red-flags" });
    let json;
    try { json = JSON.parse(observation.raw); } catch { /* Structured stages use NDJSON. */ }
    let reasoning;
    for (const match of (observation.content || "").matchAll(/<!-- DIAGNOSIS_JSON_START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END -->/g)) {
      try { const parsed = JSON.parse(match[1]); if (parsed.stage) reasoning = parsed; } catch { /* Report missing structured output. */ }
    }
    const delivered = response.ok && (route === "red-flags" ? Boolean(json?.safetyGate) : observation.ended && !observation.streamError && Boolean(reasoning));
    return { json, reasoning, content: observation.content, measurement: {
      status: response.status, outcome: delivered ? "delivered" : "incomplete", durationMs: observation.durationMs,
      firstContentMs: observation.firstContentMs ?? null, firstUsefulMs: observation.firstUsefulMs ?? null,
      firstModuleMs: observation.firstModuleMs ?? null, clinicalDraftCount: observation.clinicalDraftCount ?? 0,
    } };
  } catch {
    return { measurement: { status: "request_failed", outcome: "request_failed", durationMs: Math.round(performance.now() - startedAt) } };
  }
};

const count = Number(process.env.PAIR_CASES || 3);
if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error("PAIR_CASES must be 1–3");
const report = await runClinicalModelPairs({
  fixtures: experienceCases.slice(0, count).map(fixture => ({ label: fixture.label, synthetic: true, state: experienceCaseState(fixture, customer) })),
  call, onProgress: event => console.log(JSON.stringify(event)),
});
const output = { checkedAt: new Date().toISOString(), identities,
  comparisonIdentityVerified: Object.values(identities).every(identity => identity.modelIdentityAvailable), ...report };
if (process.env.PAIR_OUTPUT) {
  await mkdir(dirname(process.env.PAIR_OUTPUT), { recursive: true });
  await writeFile(process.env.PAIR_OUTPUT, JSON.stringify(output, null, 2));
}
console.log(JSON.stringify({ event: "complete", ...output }));
if (report.results.some(result => result.outcome !== "delivered")) process.exitCode = 1;
