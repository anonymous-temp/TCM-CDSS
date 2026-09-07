import assert from "node:assert/strict";
import { runModelRoutingAb, syntheticRoutingCases } from "./regress-model-routing-ab.mjs";

const seen = [];
const rows = await runModelRoutingAb({
  cases: syntheticRoutingCases,
  invoke: async (request) => {
    seen.push(request);
    return { choices: [{ message: { content: JSON.stringify({ summary: "synthetic advice", uncertainty: [], advice: ["follow up"] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
  },
});
assert.equal(rows.length, 4);
assert.equal(seen[0].prompt, seen[1].prompt);
assert.deepEqual(seen[0].schema, seen[1].schema);
assert.notEqual(seen[0].model, seen[1].model);
assert.ok(rows.every((row) => row.shapeValid && row.usageAvailable && row.tokens.totalTokens === 15));
assert.ok(rows.every((row) => row.clinicalQuality === "not_evaluated"));
const errors = await runModelRoutingAb({ cases: syntheticRoutingCases, invoke: async () => { throw new Error("secret-payload-never-log"); } });
assert.equal(errors.length, 4);
assert.ok(errors.every((row) => row.outcome === "error" && row.usageAvailable === false));
assert.ok(!JSON.stringify(errors).includes("secret-payload-never-log"));
await assert.rejects(runModelRoutingAb({ cases: [{ ...syntheticRoutingCases[0], synthetic: false }], invoke: async () => ({}) }), /synthetic/);
console.log("routing A/B harness: paired inputs, explicit missing usage, private error handling and synthetic-only boundary passed");
