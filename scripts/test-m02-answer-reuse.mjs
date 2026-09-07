import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const { interpretM02Answer } = jiti("../src/lib/m02-answer-interpreter.server.ts");
const { ExactModelResultCache } = jiti("../src/lib/exact-model-result-cache.ts");
const bounded = new ExactModelResultCache(60_000, 2);
bounded.set("first", { value: 1 });
bounded.set("second", { value: 2 });
bounded.set("third", { value: 3 });
assert.equal(bounded.get("first"), undefined, "cache has a hard entry bound");
assert.deepEqual(bounded.get("second"), { value: 2 });
const expired = new ExactModelResultCache(0, 2);
expired.set("expired", { value: 1 });
assert.equal(expired.get("expired"), undefined, "expired results cannot be reused");
assert.notEqual(bounded.key("synthetic patient"), new ExactModelResultCache().key("synthetic patient"), "keys use process-local secrets");
const caseState = { id: "synthetic-case", customerId: "synthetic-customer", phase: "question", patient: { age: 40 }, chiefComplaint: "合成测试病例", symptoms: {}, conversation: [] };
const plan = { schemaVersion: "tcm-cdss-m02-plan-v1", decision: "ask", rationale: "合成用药史核实", questions: [{
  id: "q-medication", question: "现在使用哪些药物？", reason: "核实用药", targetField: "medicationHistory", decisionBranch: "treatment_safety", expectedDecisionImpact: "用药建议", informationGain: 0.9, sourceEvidence: [],
  options: [
    { id: "yes", label: "有", answer: "正在服药", kind: "clinical_fact", requiresDetail: true },
    { id: "no", label: "无", answer: "没有服药", kind: "clinical_fact", recordValue: "没有服药" },
    { id: "unknown", label: "不清楚", answer: "不清楚", kind: "unknown" },
  ],
}] };
let calls = 0;
let failed = false;
let resetOnce = false;
const server = createServer(async (req, res) => {
  for await (const chunk of req) { void chunk; /* synthetic request */ }
  calls += 1;
  if (resetOnce) { resetOnce = false; req.socket.destroy(); return; }
  res.writeHead(failed ? 503 : 200, { "Content-Type": "application/json", "retry-after-ms": "1" });
  res.end(JSON.stringify(failed ? { error: { message: "synthetic unavailable" } } : { choices: [{ message: { content: JSON.stringify({
    schemaVersion: "tcm-cdss-m02-answer-interpretation-v1", answers: [{ questionId: "q-medication", targetField: "medicationHistory", recordValue: "正在服药", groundedQuotes: ["正在服药"] }],
  }) } }] }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const overrides = { AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "synthetic-key", OPENAI_MODEL: "deepseek-v4-flash", OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, CDSS_TEXT_MODEL_ALLOWED_HOSTS: "127.0.0.1", NODE_ENV: "test" };
const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
Object.assign(process.env, overrides);
const input = { caseState, plan, doctorAnswer: "正在服药，药名还需要查一下。" };
try {
  const first = await interpretM02Answer(input);
  assert.equal(first.ok, true, JSON.stringify(first));
  first.answers[0].recordValue = "must-not-poison-cache";
  const repeated = await interpretM02Answer(structuredClone(input));
  assert.equal(repeated.answers[0].recordValue, "正在服药");
  assert.equal(calls, 1, "exact repeat reuses only validated interpretation");
  for (const changed of [
    { ...input, caseState: { ...caseState, id: "another-case" } },
    { ...input, caseState: { ...caseState, customerId: "another-customer" } },
    { ...input, caseState: { ...caseState, chiefComplaint: "changed context" } },
    { ...input, plan: { ...plan, rationale: "changed plan" } },
    { ...input, doctorAnswer: "正在服药，还需确认。" },
  ]) { assert.equal((await interpretM02Answer(changed)).ok, true); }
  assert.equal(calls, 6, "case, customer, context, plan and exact answer each invalidate reuse");
  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await interpretM02Answer({ ...input, requestSignal: aborted.signal });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.failure.code, "request_aborted");
  assert.equal(calls, 6);
  failed = true;
  const failingInput = { ...input, caseState: { ...caseState, id: "failing-case" } };
  const failure = await interpretM02Answer(failingInput);
  assert.equal(failure.failure.attempts, 2);
  assert.equal(calls, 8, "M02 application retry corresponds to exactly two HTTP attempts");
  failed = false;
  assert.equal((await interpretM02Answer(failingInput)).ok, true);
  assert.equal(calls, 9, "failed requests are never reused");
  resetOnce = true;
  const recoveredReset = await interpretM02Answer({ ...input, caseState: { ...caseState, id: "connection-reset-case" } });
  assert.equal(recoveredReset.ok, true, "application recovery also handles SDK connection errors");
  assert.equal(calls, 11, "one connection reset gets exactly one application recovery attempt");
  console.log("M02 exact-answer reuse: scope isolation, mutation isolation, abort and transient failure recovery passed");
} finally {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await new Promise((resolve) => server.close(resolve));
}
