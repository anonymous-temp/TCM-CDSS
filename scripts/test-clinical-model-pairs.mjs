import assert from "node:assert/strict";
import { runClinicalModelPairs } from "./lib/clinical-model-pairs.mjs";

const calls = [];
const fixture = { label: "synthetic", synthetic: true, state: { id: "fixture", symptoms: { presentHistory: "合成病例" } } };
const call = async (arm, route, state) => {
  calls.push({ arm, route, state: structuredClone(state) });
  if (route === "red-flags") return { json: { safetyGate: {}, operationalCompleteness: {}, clinicalFacts: {} }, measurement: { outcome: "delivered" } };
  if (route === "diagnose") return { content: `diagnosis-${arm}`, reasoning: { contractSignature: `unit-test-${arm}`, overview: { primarySyndrome: arm } }, measurement: { outcome: "delivered" } };
  return { content: "处方", reasoning: { contractSignature: "unit-test-prescription", formula: { candidates: [{ name: "合成候选", herbs: [{ name: "茯苓", dose: "10g", function: "合成测试" }] }] } }, measurement: { outcome: "delivered" } };
};
const report = await runClinicalModelPairs({ fixtures: [fixture], call });
assert.equal(report.results.length, 1);
const prescriptions = calls.filter(x => x.route === "prescribe");
assert.equal(prescriptions.length, 2);
assert.deepEqual(prescriptions[0].state, prescriptions[1].state, "M04 comparison must freeze the same actual M03 input");
assert.equal(prescriptions[0].state.reasoningDiagnose.overview.primarySyndrome, "baseline");
assert.equal(fixture.state.reasoningDiagnose, undefined, "caller fixture must remain unchanged");
assert.ok(!JSON.stringify(report).includes("unit-test-"), "signatures never enter the report");

const failed = await runClinicalModelPairs({ fixtures: [fixture], call: async () => ({ measurement: { outcome: "request_failed" } }) });
assert.equal(failed.results[0].outcome, "incomplete");
assert.equal(failed.results[0].notReached, "diagnose");
await assert.rejects(runClinicalModelPairs({ fixtures: [{ ...fixture, synthetic: false }], call }));
console.log(JSON.stringify({ suite: "clinical-model-pairs", checks: 9, failures: 0 }));
