import assert from "node:assert/strict";
import { createJiti } from "jiti";

const previousFetch = globalThis.fetch;
const previousKey = process.env.EVIMED_GUIDE_API_KEY;
process.env.EVIMED_GUIDE_API_KEY = "test-only-placeholder";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { buildEvidenceFallbackQueries, buildEvidenceQuery, buildGuideEvidenceContext, fetchExternalEvidence } = await jiti.import("../src/lib/evimed-guide.ts");
const state = { patient: {}, chiefComplaint: "咳嗽", symptoms: { presentHistory: "胃食管反流病史，近期反酸。" } };
const failures = [];
let checks = 0;
async function check(name, fn) { checks++; try { await fn(); } catch (error) { failures.push({ name, message: error.message }); } }
const response = (title) => new Response(JSON.stringify({ code: 200, data: { list: title ? [{ title, year: "2024" }] : [] } }), { headers: { "content-type": "application/json" } });
try {
  await check("chief complaint problems precede incidental history topics", () => {
    assert.ok(buildEvidenceFallbackQueries(state, "diagnose", "guide")[0].startsWith("咳嗽 "));
  });
  await check("diagnostic queries start together, dedupe and select by stable clinical priority", async () => {
    const calls = [];
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const longQuery = buildEvidenceQuery(state, "diagnose", "guide");
    globalThis.fetch = async (_url, options) => {
      const query = JSON.parse(options.body).query;
      calls.push(query);
      if (query === longQuery) await pending;
      return response(query.startsWith("咳嗽 ") ? "主诉咳嗽指南" : "其他方向指南");
    };
    const run = buildGuideEvidenceContext(state, "diagnose");
    await new Promise((resolve) => setImmediate(resolve));
    const startedConcurrently = calls.length >= 2;
    release();
    const context = await run;
    assert.ok(startedConcurrently, "problem searches waited for full narrative response");
    assert.equal(new Set(calls).size, calls.length);
    assert.ok(context.includes("主诉咳嗽指南"));
    assert.ok(!context.includes("其他方向指南"));
  });
  await check("no problem hits preserve long-query evidence, and total no-hit stays empty", async () => {
    const longQuery = buildEvidenceQuery(state, "diagnose", "guide");
    globalThis.fetch = async (_url, options) => response(JSON.parse(options.body).query === longQuery ? "长查询有效指南" : "");
    assert.ok((await buildGuideEvidenceContext(state, "diagnose")).includes("长查询有效指南"));
    globalThis.fetch = async () => response("");
    assert.equal(await buildGuideEvidenceContext(state, "diagnose"), "");
  });
  await check("a useful primary result does not wait for unused long-query work", async () => {
    const longQuery = buildEvidenceQuery(state, "diagnose", "guide");
    let release, cancelled = false;
    globalThis.fetch = async (_url, options) => {
      const query = JSON.parse(options.body).query;
      if (query !== longQuery) return response(query.startsWith("咳嗽 ") ? "主诉咳嗽指南" : "其他方向指南");
      return new Promise((resolve, reject) => {
        release = () => resolve(response("长查询补充"));
        options.signal.addEventListener("abort", () => { cancelled = true; reject(new DOMException("cancelled", "AbortError")); }, { once: true });
      });
    };
    let timer;
    try {
      const context = await Promise.race([buildGuideEvidenceContext(state, "diagnose"), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("primary result waited for unused work")), 150); })]);
      assert.ok(context.includes("主诉咳嗽指南"));
      assert.equal(cancelled, true);
    } finally { clearTimeout(timer); release?.(); }
  });
  await check("an already cancelled evidence request makes no provider call", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return response("不应请求"); };
    const controller = new AbortController(); controller.abort();
    await fetchExternalEvidence("guide", "咳嗽 指南", { signal: controller.signal });
    assert.equal(calls, 0);
  });
} finally {
  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.EVIMED_GUIDE_API_KEY;
  else process.env.EVIMED_GUIDE_API_KEY = previousKey;
}
console.log(JSON.stringify({ checks, failures }, null, 2));
if (failures.length) process.exitCode = 1;
