import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { callDiagnosisStream, getDiagnosisProviderStatus, isTongueVisionConfigured,
  isTongueVisionEnabled, probeTongueVisionModel } = await jiti.import("../src/lib/diagnosis-api.ts");
const envKeys = ["AI_TEXT_PROVIDER", "AI_PROVIDER", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
  "BAILIAN_QWEN_API_KEY", "BAILIAN_QWEN_MODEL", "BAILIAN_QWEN_BASE_URL", "DASHSCOPE_API_KEY", "QWEN_API_KEY",
  "GLM_API_KEY", "GLM_VISION_ENABLED", "GLM_VISION_MODEL", "GLM_VISION_THINKING_ENABLED",
  "TONGUE_VISION_PROVIDER", "CDSS_TEXT_MODEL_ALLOWED_HOSTS", "CDSS_DEEPSEEK_ALLOWED_HOSTS"];
let savedEnv;
let savedFetch;
let requests;
let fixtureSequence = 0;
const tongue = "data:image/png;base64,synthetic-no-patient-image";
const prompt = "只描述本合成舌象图片中可见的特征，不作诊断。";
const validFrames = 'data: {"choices":[{"delta":{"content":"合成舌象特征"}}]}\n\ndata: [DONE]\n\n';
function primary() {
  process.env.TONGUE_VISION_PROVIDER = "primary";
}
function record(input, init) {
  requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(init.body), signal: init.signal });
}
function mockStream(raw = validFrames) {
  globalThis.fetch = async (input, init) => {
    record(input, init);
    return new Response(raw, { headers: { "content-type": "text/event-stream" } });
  };
}
async function stream(options = {}) {
  const response = await callDiagnosisStream(prompt, "glm", { tongue }, "markdown", options);
  const raw = await response.text();
  return { response, raw, frames: raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}
function assertNoSuccessEnd(frames) {
  assert.ok(frames.some((frame) => frame.error), "invalid stream must contain an explicit error");
  assert.ok(!frames.some((frame) => frame.content === "[END]"), "failed stream cannot claim successful completion");
}
beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  savedFetch = globalThis.fetch;
  for (const key of envKeys) delete process.env[key];
  fixtureSequence += 1;
  Object.assign(process.env, {
    AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: `synthetic-primary-${fixtureSequence}`,
    OPENAI_BASE_URL: "https://api.deepseek.com", OPENAI_MODEL: "deepseek-flash",
    GLM_API_KEY: `synthetic-glm-${fixtureSequence}`,
  });
  requests = [];
  globalThis.fetch = async () => { throw new Error("unexpected external request"); };
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("default GLM preserves the image prompt and NDJSON content/END", async () => {
  mockStream();
  const result = await stream();
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.frames.filter((frame) => frame.content), [{ content: "合成舌象特征" }, { content: "[END]" }]);
  assert.equal(requests[0].url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(requests[0].headers.get("authorization"), `Bearer ${process.env.GLM_API_KEY}`);
  assert.equal(requests[0].body.model, "glm-5v-turbo");
  assert.deepEqual(requests[0].body.messages, [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: tongue } }] }]);
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
});

for (const keepGlmKey of [false, true]) {
  test(`primary vision uses DeepSeek identity with GLM key ${keepGlmKey ? "present" : "absent"}`, async () => {
    primary();
    if (!keepGlmKey) delete process.env.GLM_API_KEY;
    process.env.GLM_VISION_THINKING_ENABLED = "true";
    mockStream();
    assert.equal(isTongueVisionConfigured(), true);
    const result = await stream();
    assert.equal(result.response.status, 200);
    assert.ok(result.frames.some((frame) => frame.content === "[END]"));
    assert.equal(requests[0].url, "https://api.deepseek.com/chat/completions");
    assert.equal(requests[0].headers.get("authorization"), `Bearer ${process.env.OPENAI_API_KEY}`);
    assert.equal(requests[0].body.model, "deepseek-flash");
    assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
    assert.equal(requests[0].body.reasoning_effort, "low");
    assert.equal(requests[0].body.messages[0].content[1].image_url.url, tongue);
    const status = getDiagnosisProviderStatus().tongueVision;
    assert.equal(status.provider, "DeepSeek");
    assert.equal(status.model, "deepseek-flash");
    assert.equal(status.configured, true);
    assert.doesNotMatch(JSON.stringify(status), /synthetic-|apiKey|endpoint|baseUrl/);
  });
}

for (const [label, overrides] of [
  ["missing primary key", { OPENAI_API_KEY: "" }],
  ["legacy text-only model", { OPENAI_MODEL: "deepseek-v4-flash" }],
  ["Qwen provider", { AI_TEXT_PROVIDER: "bailian-qwen", BAILIAN_QWEN_API_KEY: "synthetic-qwen" }],
  ["unknown text provider", { AI_TEXT_PROVIDER: "unapproved" }],
  ["unknown vision selector", { TONGUE_VISION_PROVIDER: "unapproved" }],
  ["unapproved host", { OPENAI_BASE_URL: "https://unapproved.example/v1" }],
  ["insecure host", { OPENAI_BASE_URL: "http://api.deepseek.com" }],
  ["local HTTP even when text explicitly allows it", { OPENAI_BASE_URL: "http://localhost:9999", CDSS_TEXT_MODEL_ALLOWED_HOSTS: "localhost" }],
]) {
  test(`${label} fails closed without falling back to a configured GLM key`, async () => {
    primary();
    Object.assign(process.env, overrides);
    mockStream();
    assert.equal(isTongueVisionConfigured(), false);
    const result = await stream();
    assert.equal(result.response.status, 500);
    assert.match(result.raw, /error/);
    assert.doesNotMatch(result.raw, /synthetic-/);
    const probe = await probeTongueVisionModel();
    assert.equal(probe.configured, false);
    assert.equal(probe.ok, false);
    assert.equal(requests.length, 0);
  });
}

test("the legacy off flag disables primary vision and does not call either provider", async () => {
  primary();
  process.env.GLM_VISION_ENABLED = "false";
  mockStream();
  assert.equal(isTongueVisionEnabled(), false);
  assert.equal(isTongueVisionConfigured(), false);
  assert.equal((await stream()).response.status, 503);
  const probe = await probeTongueVisionModel();
  assert.equal(probe.ok, true);
  assert.equal(probe.reason, "disabled");
  assert.equal(requests.length, 0);
});

test("text-only calls remain rejected with the selected provider label", async () => {
  primary();
  const response = await callDiagnosisStream(prompt, "glm");
  assert.equal(response.status, 400);
  const raw = await response.text();
  assert.match(raw, /DeepSeek/);
  assert.doesNotMatch(raw, /GLM/);
});

test("probe uses the same selected identity and tuning as the actual stream", async () => {
  primary();
  mockStream();
  await stream();
  globalThis.fetch = async (input, init) => {
    record(input, init);
    return Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
  };
  const probe = await probeTongueVisionModel();
  assert.equal(probe.ok, true);
  assert.equal(probe.provider, "DeepSeek");
  assert.equal(probe.model, "deepseek-flash");
  assert.equal(requests.length, 2);
  for (const field of ["url"]) assert.equal(requests[1][field], requests[0][field]);
  assert.equal(requests[1].headers.get("authorization"), requests[0].headers.get("authorization"));
  for (const field of ["model", "thinking", "reasoning_effort"]) assert.deepEqual(requests[1].body[field], requests[0].body[field]);
  assert.match(requests[1].body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.doesNotMatch(JSON.stringify(probe), /synthetic-|apiKey|endpoint/);
  assert.equal((await probeTongueVisionModel()).cached, true);
  assert.equal(requests.length, 2);
});

for (const [label, payload] of [
  ["empty choices", { choices: [] }],
  ["empty message", { choices: [{ message: { content: " " } }] }],
  ["reasoning only", { choices: [{ message: { reasoning_content: "thinking" } }] }],
  ["non-string content", { choices: [{ message: { content: { text: "OK" } } }] }],
  ["malformed JSON", "invalid-json"],
]) {
  test(`probe rejects ${label}`, async () => {
    primary();
    globalThis.fetch = async () => typeof payload === "string" ? new Response(payload) : Response.json(payload);
    const probe = await probeTongueVisionModel();
    assert.equal(probe.ok, false);
    assert.notEqual(probe.reason, "ok");
  });
}

test("probe cache and in-flight sharing remain bound to provider, model, key and tuning", async () => {
  let resolveGlm;
  globalThis.fetch = async (input, init) => {
    record(input, init);
    if (String(input).includes("bigmodel")) await new Promise((resolve) => { resolveGlm = resolve; });
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  };
  const glmRun = probeTongueVisionModel();
  await new Promise((resolve) => setImmediate(resolve));
  primary();
  const primaryRun = probeTongueVisionModel();
  await new Promise((resolve) => setImmediate(resolve));
  resolveGlm();
  const [glmResult, primaryResult] = await Promise.all([glmRun, primaryRun]);
  assert.equal(requests.length, 2, "different provider requests cannot share an in-flight probe");
  assert.equal(glmResult.provider, "GLM vision");
  assert.equal(primaryResult.provider, "DeepSeek");
  process.env.OPENAI_API_KEY = "synthetic-rotated-key";
  assert.equal((await probeTongueVisionModel()).cached, false);
  process.env.TONGUE_VISION_PROVIDER = "glm";
  globalThis.fetch = async (input, init) => { record(input, init); return Response.json({ choices: [{ message: { content: "OK" } }] }); };
  process.env.GLM_VISION_MODEL = "glm-custom-vision";
  await probeTongueVisionModel();
  assert.equal(requests.at(-1).body.model, "glm-custom-vision");
  process.env.GLM_VISION_THINKING_ENABLED = "true";
  assert.equal((await probeTongueVisionModel()).cached, false);
});

for (const [label, raw] of [
  ["empty final content", 'data: {"choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n'],
  ["reasoning only", 'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\ndata: [DONE]\n\n'],
  ["malformed chunk", 'data: broken\n\ndata: [DONE]\n\n'],
  ["invalid content shape", 'data: {"choices":[{"delta":{"content":{"text":"not a string"}}}]}\n\ndata: [DONE]\n\n'],
  ["missing provider DONE", 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'],
]) {
  test(`selected primary stream rejects ${label}`, async () => {
    primary();
    mockStream(raw);
    const result = await stream();
    assertNoSuccessEnd(result.frames);
    assert.doesNotMatch(result.raw, /GLM/);
  });
}

test("provider rejection reports the selected provider without retrying a different provider", async () => {
  primary();
  globalThis.fetch = async (input, init) => { record(input, init); return new Response("synthetic-provider-secret", { status: 401 }); };
  const result = await stream();
  assertNoSuccessEnd(result.frames);
  assert.match(result.raw, /DeepSeek.*暂时不可用/);
  assert.doesNotMatch(result.raw, /GLM|synthetic-provider-secret/);
  assert.equal(requests.length, 1);
});

test("request abort propagates to the selected provider and never produces success END", async () => {
  primary();
  globalThis.fetch = async (input, init) => {
    record(input, init);
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  };
  const controller = new AbortController();
  const response = await callDiagnosisStream(prompt, "glm", { tongue }, "markdown", { requestSignal: controller.signal });
  controller.abort();
  const raw = await response.text();
  assert.equal(requests[0].signal.aborted, true);
  assertNoSuccessEnd(raw.trim().split("\n").map((line) => JSON.parse(line)));
});

test("downstream cancellation aborts the selected upstream stream", async () => {
  primary();
  let bodyCancelled = false;
  globalThis.fetch = async (input, init) => {
    record(input, init);
    return new Response(new ReadableStream({
      cancel() { bodyCancelled = true; },
    }));
  };
  const response = await callDiagnosisStream(prompt, "glm", { tongue });
  await new Promise((resolve) => setImmediate(resolve));
  await response.body.cancel();
  assert.equal(bodyCancelled, true, "after headers arrive, cancellation must release the active upstream response body");
});

test("the probe deadline interrupts a stalled body after response headers", async (t) => {
  primary();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let bodyController;
  globalThis.fetch = async (input, init) => {
    record(input, init);
    return new Response(new ReadableStream({
      start(ctrl) {
        bodyController = ctrl;
        init.signal.addEventListener("abort", () => ctrl.error(new DOMException("Aborted", "AbortError")), { once: true });
      },
    }));
  };
  const running = probeTongueVisionModel();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(12_000);
  const result = await Promise.race([running, new Promise((resolve) => setImmediate(() => resolve(null)))]);
  if (result === null) {
    bodyController.close();
    await running;
  }
  assert.ok(result, "the 12 s deadline must terminate body consumption, not only the connection attempt");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.equal(requests[0].signal.aborted, true);
});
