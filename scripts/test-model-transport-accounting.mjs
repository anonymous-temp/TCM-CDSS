import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
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
