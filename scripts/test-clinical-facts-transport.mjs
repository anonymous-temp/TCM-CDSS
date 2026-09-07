import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
// Expose the existing private transport for this test only; its production body is unchanged.
// This lets the test exercise each real phase without inventing clinical extraction responses.
const runtimePath = fileURLToPath(new URL("../src/lib/clinical-facts-runtime.ts", import.meta.url));
const runtimeSource = readFileSync(runtimePath, "utf8");
assert.ok(runtimeSource.includes("async function callFactsPhaseModel("));
const { callFactsPhaseModel } = jiti.evalModule(runtimeSource.replace("async function callFactsPhaseModel(", "export async function callFactsPhaseModel("), { filename: runtimePath });

async function fixture(mode, run) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    calls += 1;
    if (calls === 1 && mode === "socket") { req.socket.destroy(); return; }
    res.writeHead(calls === 1 ? 503 : 200, { "Content-Type": "application/json", "retry-after-ms": "1" });
    res.end(JSON.stringify(calls === 1
      ? { error: { message: "synthetic-private-upstream-message" } }
      : { choices: [{ message: { content: "synthetic success" } }], usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const overrides = { AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "synthetic-secret-never-log", OPENAI_MODEL: "deepseek-v4-flash", OPENAI_BASE_URL: baseUrl, CDSS_TEXT_MODEL_ALLOWED_HOSTS: "127.0.0.1", NODE_ENV: "test" };
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const logs = [];
  const original = console.info;
  console.info = (...args) => logs.push(args);
  try {
    await run({ provider: "openai-compatible", model: "deepseek-v4-flash", apiKey: overrides.OPENAI_API_KEY, endpoint: `${baseUrl}/chat/completions`, configured: true, source: "primary" }, () => calls, logs);
    const serialized = JSON.stringify(logs);
    for (const secret of ["synthetic-secret-never-log", "synthetic-private-prompt", "synthetic-private-upstream-message"]) assert.ok(!serialized.includes(secret));
  } finally {
    console.info = original;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const phase of ["extract", "review", "repair", "adjudicate"]) {
  for (const mode of ["503", "socket"]) {
    test(`${phase} preserves its retry owner on ${mode}`, async () => {
      await fixture(mode, async (config, count, logs) => {
        const call = () => callFactsPhaseModel(config, "synthetic-private-prompt", "synthetic-private-prompt", undefined, phase);
        if (phase === "extract" || phase === "review") {
          await assert.rejects(call());
          assert.equal(count(), 1, "application owner gets one physical attempt per invocation");
          assert.equal(await call(), "synthetic success");
          assert.equal(logs.length, 2, "application recovery remains separately observable");
        } else {
          assert.equal(await call(), "synthetic success", "single-shot clinical phases keep SDK transport recovery");
          assert.equal(logs.length, 1, "SDK recovery belongs to one logical call");
        }
        assert.equal(count(), 2);
        assert.equal(logs.reduce((sum, args) => sum + args.at(-1).physicalAttempts, 0), 2);
      });
    });
  }
}

for (const mode of ["503", "socket"]) {
  test(`independent endpoint records ${mode} failure without response usage or PHI`, async () => {
    await fixture(mode, async (config, count, logs) => {
      await assert.rejects(callFactsPhaseModel({ ...config, source: "independent_review" }, "synthetic-private-prompt", "synthetic-private-prompt", undefined, "review"));
      assert.equal(count(), 1);
      assert.equal(logs.length, 1, "failed raw fetch must not disappear from ledger");
      assert.equal(logs[0].at(-1).outcome, "error");
      assert.equal(logs[0].at(-1).physicalAttempts, 1);
      assert.equal(logs[0].at(-1).usageAvailable, false);
    });
  });
}
