import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createJiti } from "jiti";

const envNames = ["EVIDENCE_RERANK_ENABLED", "BAILIAN_QWEN_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY", "BAILIAN_QWEN_BASE_URL", "BAILIAN_QWEN_MODEL", "CDSS_TEXT_MODEL_ALLOWED_HOSTS", "EVIMED_GUIDE_API_KEY", "EVIMED_INSTRUCTION_API_KEY", "EVIMED_LITERATURE_API_KEY", "EVIMED_INSTRUCTION_API_URL", "EVIMED_LITERATURE_API_URL"];
const savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const savedFetch = globalThis.fetch;
process.env.EVIMED_GUIDE_API_KEY = "test-evidence-key";
process.env.EVIMED_INSTRUCTION_API_KEY = "test-evidence-key";
process.env.EVIMED_LITERATURE_API_KEY = "test-evidence-key";
process.env.EVIMED_INSTRUCTION_API_URL = "https://www.evimed.com/test/instruction";
process.env.EVIMED_LITERATURE_API_URL = "https://www.evimed.com/test/literature";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { buildGuideEvidenceContext, buildExternalEvidenceContext } = await jiti.import("../src/lib/evimed-guide.ts");
const rerank = async (...args) => (await jiti.import("../src/lib/evidence-rerank.ts")).rerankEvidenceDocuments(...args);
const endpoint = "https://dashscope.aliyuncs.com/compatible-api/v1/reranks";
const docs = Object.freeze(["First guideline", "Second guideline", "Third guideline"]);
const state = { patient: { name: "张三" }, chiefComplaint: "张三咳嗽", symptoms: { presentHistory: "反复咳嗽，电话13812345678" }, conversation: [] };
const candidates = Array.from({ length: 8 }, (_, index) => ({ title: `候选指南${index + 1}`, publisher: "示例学会", year: "2024", summary: `原文摘要${index + 1}`, url: `https://example.org/guide/${index + 1}` }));
const json = data => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
const rankedResponse = (order = [2, 0, 1]) => json({ results: order.map((index, rank) => ({ index, relevance_score: 1 - rank / order.length })), usage: { total_tokens: 66 }, id: "opaque-provider-id" });
const evidenceResponse = () => json({ code: 200, data: { list: candidates } });
async function settlesSoon(promise, maxMs = 1000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("bounded operation did not settle")), maxMs); })]); }
  finally { clearTimeout(timer); }
}
beforeEach(() => {
  process.env.EVIDENCE_RERANK_ENABLED = "true";
  process.env.BAILIAN_QWEN_API_KEY = "test-only-rerank-key";
  process.env.DASHSCOPE_API_KEY = "";
  process.env.QWEN_API_KEY = "";
  process.env.BAILIAN_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
  process.env.BAILIAN_QWEN_MODEL = "qwen3.7-plus";
  process.env.CDSS_TEXT_MODEL_ALLOWED_HOSTS = "";
  globalThis.fetch = async () => { throw new Error("test must mock its transport"); };
});
after(() => {
  globalThis.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test("guide rerank promotes a later candidate into top five with original ID and unchanged source text", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (url !== endpoint) return evidenceResponse();
    calls.push(JSON.parse(init.body));
    return rankedResponse([6, 0, 1, 2, 3, 4, 5, 7]);
  };
  const context = await buildGuideEvidenceContext(state, "diagnose");
  const evidenceLines = context.split("\n").filter(line => line.startsWith("[EVID-"));
  assert.equal(evidenceLines.length, 5);
  assert.equal(evidenceLines[0], "[EVID-GUIDE-007] 候选指南7（示例学会，2024）：原文摘要7 URL:https://example.org/guide/7");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].documents.length, 8);
  assert.doesNotMatch(JSON.stringify(calls), /张三|13812345678|patient|conversation/);
  assert.deepEqual(candidates.map(item => item.title), Array.from({ length: 8 }, (_, index) => `候选指南${index + 1}`));
});

test("disabled, unconfigured and failed rerank preserve byte-identical existing context and top five", async () => {
  let rerankCalls = 0;
  globalThis.fetch = async url => { if (url !== endpoint) return evidenceResponse(); rerankCalls++; return new Response("provider failure", { status: 429 }); };
  process.env.EVIDENCE_RERANK_ENABLED = "false";
  const original = await buildGuideEvidenceContext(state, "diagnose");
  assert.equal(rerankCalls, 0);
  process.env.EVIDENCE_RERANK_ENABLED = "true";
  process.env.BAILIAN_QWEN_API_KEY = "";
  assert.equal(await buildGuideEvidenceContext(state, "diagnose"), original);
  assert.equal(rerankCalls, 0);
  process.env.BAILIAN_QWEN_API_KEY = "test-only-rerank-key";
  assert.equal(await buildGuideEvidenceContext(state, "diagnose"), original);
  assert.equal(rerankCalls, 1);
  assert.match(original, /EVID-GUIDE-005/);
  assert.doesNotMatch(original, /EVID-GUIDE-006/);
});

test("rerank-only query preserves recorded population and treatment context with PHI removed", async () => {
  const queries = [], upstreamQueries = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url !== endpoint) { upstreamQueries.push(body.query); return evidenceResponse(); }
    queries.push(body.query);
    return rankedResponse([0, 1, 2, 3, 4, 5, 6, 7]);
  };
  const adult = { ...state, patient: { name: "张三", age: 45, sex: "男" }, chiefComplaint: "咳嗽", symptoms: { presentHistory: "张三近期咳嗽，否认化疗史，电话13812345678" } };
  await buildGuideEvidenceContext(adult, "diagnose");
  const pediatric = { ...adult, patient: { name: "张三", age: 7, sex: "女" }, symptoms: { presentHistory: "张三近期咳嗽，正在化疗" } };
  await buildGuideEvidenceContext(pediatric, "diagnose");
  await buildGuideEvidenceContext({ ...adult, patient: { name: "张三" }, symptoms: { presentHistory: "近期咳嗽，用药史未知" } }, "diagnose");
  assert.match(queries[0], /45.*男|男.*45/);
  assert.match(queries[0], /否认化疗史/);
  assert.match(queries[1], /7.*女|女.*7/);
  assert.match(queries[1], /正在化疗/);
  assert.match(queries[2], /用药史未知/);
  assert.doesNotMatch(queries[2], /否认化疗|无化疗|未化疗/);
  assert.ok(upstreamQueries.some(query => query.startsWith("咳嗽 诊断 指南")), "existing priority search remains unchanged");
  assert.doesNotMatch(JSON.stringify(queries), /张三|13812345678/);
  assert.ok(queries.every(query => query.length <= 768));
});

test("clinical nouns survive raw-field sanitization without a label-based privacy exemption", async () => {
  const { buildEvidenceRerankQuery } = await jiti.import("../src/lib/evimed-guide.ts");
  for (const text of ["全身出现块状皮疹", "周身出现疼痛", "皮肤出现瘙痒", "黄疸出现于巩膜"]) {
    const query = buildEvidenceRerankQuery({ patient: {}, chiefComplaint: text, symptoms: { presentHistory: text } }, "诊断指南");
    assert.ok(query.includes(text));
  }
  const query = buildEvidenceRerankQuery({ patient: {}, chiefComplaint: "张三昨夜失眠", symptoms: {} }, "诊断指南");
  assert.doesNotMatch(query, /张三/, "adding clinical labels must not exempt otherwise detected identities");
});

test("field and transport budgets never cut away trailing negation or uncertainty", async () => {
  const { buildEvidenceRerankQuery } = await jiti.import("../src/lib/evimed-guide.ts");
  for (const suffix of ["化疗史不详", "正在化疗一说已被否认"]) {
    const history = `${"记录。".repeat(99)}${suffix}`;
    const query = buildEvidenceRerankQuery({ patient: {}, chiefComplaint: "头晕", symptoms: { presentHistory: history } }, "诊断指南");
    assert.ok(!query.includes("化疗") || query.includes(suffix), "do not retain a positive-looking clipped clause");
  }
  let calls = 0;
  globalThis.fetch = async () => { calls++; return rankedResponse(); };
  const result = await rerank("甲".repeat(680) + "正在化疗一说已被否认", docs);
  assert.equal(result.status, "disabled", "one oversized sentence has no complete fragment to rank");
  assert.equal(calls, 0);
});

test("rerank only touches selected guide and literature pools, never instructions", async () => {
  const pools = [];
  globalThis.fetch = async (url, init) => {
    if (url === endpoint) { const body = JSON.parse(init.body); pools.push(body.documents); return rankedResponse(body.documents.map((_, index) => index).reverse()); }
    if (String(url).endsWith("/instruction")) return json({ code: 200, data: { list: [{ title: "说明书药品甲", publisher: "药厂", year: "2024" }, { title: "说明书药品乙", publisher: "药厂", year: "2024" }] } });
    if (String(url).endsWith("/literature")) return json({ code: 200, data: { paper: [{ title: "临床文献甲", journal: "期刊", year: "2024" }, { title: "临床文献乙", journal: "期刊", year: "2024" }] } });
    return evidenceResponse();
  };
  const context = await buildExternalEvidenceContext(state, "prescribe");
  assert.equal(pools.length, 2);
  assert.ok(pools.some(pool => pool.some(text => text.includes("临床文献"))));
  assert.ok(pools.every(pool => pool.every(text => !text.includes("说明书药品"))));
  assert.ok(context.indexOf("[EVID-INST-001]") < context.indexOf("[EVID-INST-002]"));
  assert.ok(context.indexOf("[EVID-PAPER-002]") < context.indexOf("[EVID-PAPER-001]"));
});

test("formal same-domain API uses bounded strings and full top_n, preserving immutable input", async () => {
  let call;
  globalThis.fetch = async (url, init) => { call = { url, init, body: JSON.parse(init.body) }; return rankedResponse(); };
  const result = await rerank("Clinical query", docs);
  assert.equal(result.status, "ranked");
  assert.deepEqual(result.order, [2, 0, 1]);
  assert.equal(result.model, "qwen3-rerank");
  assert.deepEqual(result.usage, { totalTokens: 66 });
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
  assert.equal(call.url, endpoint);
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.cache, "no-store");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.Authorization, "Bearer test-only-rerank-key");
  assert.deepEqual(Object.keys(call.body).sort(), ["documents", "instruct", "model", "query", "top_n"]);
  assert.equal(call.body.top_n, docs.length);
  assert.match(call.body.instruct, /relevan|applicab/i);
  assert.deepEqual(docs, ["First guideline", "Second guideline", "Third guideline"]);
  const longDocs = Object.freeze(["完整说明。".repeat(2000), "适用范围。".repeat(2000)]);
  globalThis.fetch = async (_url, init) => { const body = JSON.parse(init.body); assert.ok(Buffer.byteLength(body.query) <= 2048); assert.ok(body.documents.every(text => Buffer.byteLength(text) <= 4096)); return rankedResponse([1, 0]); };
  assert.equal((await rerank("完整问题。".repeat(2000), longDocs)).status, "ranked");
  assert.equal(longDocs[0].length, 10000);
});

test("feature defaults off, small pools and already-cancelled work never fetch", async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return rankedResponse(); };
  delete process.env.EVIDENCE_RERANK_ENABLED;
  assert.equal((await rerank("query", docs)).status, "disabled");
  process.env.EVIDENCE_RERANK_ENABLED = "true";
  for (const pool of [[], ["Only document"]]) { const result = await rerank("query", pool); assert.equal(result.status, "disabled"); assert.deepEqual(result.order, pool.map((_, index) => index)); }
  const controller = new AbortController(); controller.abort();
  assert.equal((await rerank("query", docs, { signal: controller.signal })).status, "cancelled");
  assert.equal(calls, 0);
});

test("missing Bailian credentials, custom hosts and unsafe URL authority never receive keys", async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return rankedResponse(); };
  process.env.BAILIAN_QWEN_API_KEY = "";
  assert.equal((await rerank("query", docs)).status, "not_configured");
  process.env.BAILIAN_QWEN_API_KEY = "test-only-rerank-key";
  process.env.CDSS_TEXT_MODEL_ALLOWED_HOSTS = "example.org";
  for (const base of ["https://example.org/v1", "https://user:password@dashscope.aliyuncs.com/v1", "http://dashscope.aliyuncs.com/v1", "https://dashscope.aliyuncs.com:444/v1"]) {
    process.env.BAILIAN_QWEN_BASE_URL = base;
    assert.equal((await rerank("query", docs)).status, "not_configured");
  }
  assert.equal(calls, 0);
});

test("in-flight parent cancellation settles even when fetch ignores AbortSignal", async () => {
  const controller = new AbortController(); let started;
  const ready = new Promise(resolve => { started = resolve; });
  let signal;
  globalThis.fetch = async (_url, init) => { signal = init.signal; started(); return new Promise(() => {}); };
  const pending = rerank("query", docs, { signal: controller.signal });
  await ready; controller.abort();
  const result = await settlesSoon(pending);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.order, [0, 1, 2]);
  assert.equal(signal.aborted, true);
});

for (const reason of ["timeout", "cancelled"]) {
  test(`${reason} during hanging body settles and cancels reader`, async () => {
    const controller = new AbortController(); let cancelled = false; let bodyStarted;
    const ready = new Promise(resolve => { bodyStarted = resolve; });
    globalThis.fetch = async () => new Response(new ReadableStream({ pull() { bodyStarted(); return new Promise(() => {}); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } });
    const pending = rerank("query", docs, { timeoutMs: 100, signal: controller.signal });
    await ready;
    if (reason === "cancelled") controller.abort();
    const result = await settlesSoon(pending);
    assert.equal(result.status, reason);
    assert.deepEqual(result.order, [0, 1, 2]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, true);
  });
}

test("hard timeout settles a fetch adapter that ignores AbortSignal", async () => {
  globalThis.fetch = async () => new Promise(() => {});
  const result = await settlesSoon(rerank("query", docs, { timeoutMs: 100 }));
  assert.equal(result.status, "timeout");
  assert.deepEqual(result.order, [0, 1, 2]);
});

test("HTTP 429 and redirects make one request, cancel bodies and retain original order", async () => {
  for (const status of [429, 500, 302]) {
    let calls = 0, cancelled = false;
    globalThis.fetch = async (_url, init) => { calls++; assert.equal(init.redirect, "error"); return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { location: "https://example.org/exfiltrate" } }); };
    const result = await rerank("query", docs);
    assert.equal(result.status, "upstream_error");
    assert.deepEqual(result.order, [0, 1, 2]);
    assert.equal(calls, 1); assert.equal(cancelled, true);
  }
});

test("malformed, incomplete and invalid-score permutations never partially reorder", async () => {
  const valid = [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.4 }, { index: 2, relevance_score: 0.8 }];
  const payloads = [null, [], {}, { results: [] }, { results: valid.slice(0, 2) }, { results: [valid[0], valid[0], valid[2]] }, { results: [...valid, valid[0]] }, ...[-1, 3, 0.5, "1"].map(index => ({ results: [valid[0], { index, relevance_score: 0.4 }, valid[2]] })), ...[-0.1, 1.1, null, "0.5"].map(relevance_score => ({ results: [valid[0], { index: 1, relevance_score }, valid[2]] }))];
  for (const payload of payloads) {
    globalThis.fetch = async () => json(payload);
    const result = await rerank("query", docs);
    assert.equal(result.status, "invalid_response");
    assert.deepEqual(result.order, [0, 1, 2]);
  }
  for (const raw of ["not-json", '{"results":[{"index":0,"relevance_score":NaN}]}', '{"results":[{"index":0,"relevance_score":1e999},{"index":1,"relevance_score":0.2},{"index":2,"relevance_score":0.1}]}']) {
    globalThis.fetch = async () => new Response(raw);
    assert.equal((await rerank("query", docs)).status, "invalid_response");
  }
});

test("oversized responses with or without content-length are rejected and cancelled", async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(100000))); }, cancel() { cancelled = true; } }), { headers: declared ? { "content-length": "100000" } : {} });
    const result = await rerank("query", docs);
    assert.equal(result.status, "invalid_response");
    assert.deepEqual(result.order, [0, 1, 2]);
    assert.equal(cancelled, true);
  }
});

test("ties use original index and oversized input pools fall back without dropping candidates", async () => {
  globalThis.fetch = async () => json({ results: [2, 0, 1].map(index => ({ index, relevance_score: 0.5 })) });
  assert.deepEqual((await rerank("query", docs)).order, [0, 1, 2]);
  let calls = 0; globalThis.fetch = async () => { calls++; return rankedResponse(); };
  const pool = Array.from({ length: 33 }, (_, index) => `document ${index}`);
  assert.deepEqual((await rerank("query", pool)).order, pool.map((_, index) => index));
  assert.equal(calls, 0);
});

test("metadata and logs contain no query, documents, credential, provider ID or error body", async () => {
  const logs = [], originals = {};
  for (const method of ["log", "info", "warn", "error"]) { originals[method] = console[method]; console[method] = (...args) => logs.push(args); }
  try {
    globalThis.fetch = async () => rankedResponse();
    const success = await rerank("PRIVATE-QUERY", ["PRIVATE-DOC-A", "PRIVATE-DOC-B", "PRIVATE-DOC-C"]);
    globalThis.fetch = async () => { throw new Error("PRIVATE-PROVIDER-BODY"); };
    const failure = await rerank("PRIVATE-QUERY", docs);
    assert.equal(failure.status, "upstream_error");
    assert.doesNotMatch(JSON.stringify({ logs, success, failure }), /PRIVATE-|test-only-rerank-key|opaque-provider-id|First guideline/);
    assert.ok(logs.some(args => JSON.stringify(args).includes("evidence_rerank")), "small status/timing metadata should be observable");
  } finally { for (const [method, fn] of Object.entries(originals)) console[method] = fn; }
});
