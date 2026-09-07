import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const { createTextModelClient } = jiti("../src/lib/text-model.ts");
const { observeModelTask, getCdssModelTaskTelemetrySnapshot } = jiti("../src/lib/cdss-model-task-telemetry.ts");

async function fixture(run, { succeedAfter = Infinity, onRequest } = {}) {
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain only: never log request data. */ }
    requests += 1;
    onRequest?.(requests);
    res.writeHead(requests > succeedAfter ? 200 : 503, { "Content-Type": "application/json", "retry-after-ms": "1" });
    res.end(JSON.stringify(requests > succeedAfter
      ? { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 } }
      : { error: { message: "synthetic unavailable" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = { apiKey: "synthetic-key-never-log", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "deepseek-v4-flash" };
  try { await run(config, () => requests); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
const body = { model: "deepseek-v4-flash", messages: [{ role: "user", content: "synthetic-private-prompt-never-log" }] };
const task = (name) => getCdssModelTaskTelemetrySnapshot().tasks[name];

test("SDK recovery counts every physical attempt, with no patient or credential logging", async () => {
  const logs = [];
  const original = console.info;
  console.info = (...args) => logs.push(args);
  try {
    await fixture(async (config, count) => {
      const client = createTextModelClient(config);
      await assert.rejects(observeModelTask({ task: "http_exhausted", model: config.model }, () => client.chat.completions.create(body)));
      assert.equal(count(), 3);
      assert.equal(task("http_exhausted").total, 1);
      assert.equal(task("http_exhausted").physicalAttemptsTotal, 3);
      assert.equal(task("http_exhausted").usageMissing, 1);
    });
    const serialized = JSON.stringify(logs);
    assert.ok(!serialized.includes(body.messages[0].content));
    assert.ok(!serialized.includes("synthetic-key-never-log"));
    const event = logs.find(([name]) => name.includes("telemetry"))?.[2] ?? logs.at(-1)?.[1];
    assert.equal(event.usageAvailable, false);
    assert.match(event.callId, /^[a-f0-9-]{36}$/);
  } finally { console.info = original; }
});

test("application owns retries without SDK multiplication", async () => {
  await fixture(async (config, count) => {
    const client = createTextModelClient(config, { retryOwner: "application" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(observeModelTask({ task: "http_application", model: config.model }, () => client.chat.completions.create(body)));
    }
    assert.equal(count(), 2);
    assert.equal(task("http_application").physicalAttemptsTotal, 2);
  });
});

test("callers without application recovery retain successful 503 recovery", async () => {
  await fixture(async (config, count) => {
    const result = await observeModelTask({ task: "http_recovered", model: config.model }, () => createTextModelClient(config).chat.completions.create(body));
    assert.equal(result.choices[0].message.content, "ok");
    assert.equal(count(), 2);
    assert.equal(task("http_recovered").physicalAttemptsTotal, 2);
    assert.equal(task("http_recovered").usageMissing, 0);
  }, { succeedAfter: 1 });
});

test("parent abort stops physical recovery calls", async () => {
  const controller = new AbortController();
  await fixture(async (config, count) => {
    await assert.rejects(observeModelTask({ task: "http_aborted", model: config.model }, () => createTextModelClient(config).chat.completions.create(body, { signal: controller.signal })));
    assert.equal(count(), 1);
    assert.equal(task("http_aborted").physicalAttemptsTotal, 1);
    assert.equal(task("http_aborted").outcomes.aborted, 1);
  }, { onRequest: () => controller.abort() });
});

test("missing usage does not lower known-usage means or pretend to be a free call", async () => {
  await observeModelTask({ task: "missing_usage", model: "synthetic" }, async () => ({ choices: [] }));
  await observeModelTask({ task: "missing_usage", model: "synthetic" }, async () => ({ usage: { prompt_tokens: 10, completion_tokens: 4 } }));
  assert.equal(task("missing_usage").usageMissing, 1);
  assert.equal(task("missing_usage").usageAvailable, 1);
  assert.equal(task("missing_usage").averagePromptTokens, 10);
  assert.equal(task("missing_usage").physicalAttemptsUnobservedCalls, 2);
});

test("explicit zero usage remains observable and differs from omitted usage", async () => {
  await observeModelTask({ task: "zero_usage", model: "synthetic" }, async () => ({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
  assert.equal(task("zero_usage").usageMissing, 0);
  assert.equal(task("zero_usage").usageAvailable, 1);
  assert.equal(task("zero_usage").averagePromptTokens, 0);
});

test("concurrent calls do not borrow each other's HTTP attempt counts", async () => {
  await Promise.all([
    fixture(async (config) => { await assert.rejects(observeModelTask({ task: "concurrent_three", model: config.model }, () => createTextModelClient(config).chat.completions.create(body))); }),
    fixture(async (config) => { await observeModelTask({ task: "concurrent_one", model: config.model }, () => createTextModelClient(config).chat.completions.create(body)); }, { succeedAfter: 0 }),
  ]);
  assert.equal(task("concurrent_three").physicalAttemptsTotal, 3);
  assert.equal(task("concurrent_one").physicalAttemptsTotal, 1);
});

test("terminology probe failures use their own task and have no hidden SDK retries", async () => {
  await fixture(async (config, count) => {
    const overrides = { AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: config.apiKey, OPENAI_MODEL: config.model, OPENAI_BASE_URL: config.baseUrl, CDSS_TEXT_MODEL_ALLOWED_HOSTS: "127.0.0.1", CONTROLLED_TERMINOLOGY_ENABLED: "true", NODE_ENV: "test" };
    const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    try {
      const { probeControlledTerminologyModel } = jiti("../src/lib/controlled-semantic-normalization.server.ts");
      const result = await probeControlledTerminologyModel();
      assert.equal(result.ok, false);
      assert.equal(count(), 2, "exactly the two consensus legs, no SDK retry multiplication");
      assert.equal(task("controlled_terminology_probe").physicalAttemptsTotal, 2);
      assert.equal(task("controlled_terminology"), undefined);
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
});
