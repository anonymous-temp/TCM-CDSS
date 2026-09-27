// 提速第四批（2026-09-27）钉住的性质：
//  ① M02 事实抽取与出题并行：m02ClinicalFactsFootprint 相同 ⇒ 出题提示词、兜底追问逐字相同（先发结果可采用的充要依据）；
//     question 路由确实按指纹决定采用/丢弃先发结果。
//  ② EviMed 检索缓存：同键并发只发一次、成功才缓存、失败不缓存、调用方中止不掐断共享请求、开关可关。
//  ③ 小任务缓存 memoizedSmallTask：同键合流、只缓存 cacheable、调用方中止返回降级值。
//  ④ tapFinalStageContent：字节原样透传，[END] 时交出最后一个替换标记之后的终稿。
//  ⑤ 路由接线：M02 预取 M03 输入、M03 签名后预取 M04 输入、M04 外部证据软等待。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` },
});
const failures = [];
const check = (name, fn) => { try { fn(); } catch (error) { failures.push({ name, message: error.message }); } };
const checkAsync = async (name, fn) => { try { await fn(); } catch (error) { failures.push({ name, message: error.message }); } };

// ── ① M02 指纹 ────────────────────────────────────────────────────────────────
const { m02ClinicalFactsFootprint, buildCaseAwareQuestionFallback } = await jiti.import("../src/lib/m02-question-contract.ts");
const { buildQuestionPrompt } = await jiti.import("../src/lib/diagnosis-prompts.ts");
const baseCase = {
  id: "t", patient: { sex: "女", age: 45 }, chiefComplaint: "头晕反复2周", symptoms: { presentHistory: "头晕反复2周，劳累后加重" },
  conversation: [], questionRounds: 0, maxQuestionRounds: 1, phase: "question", completeness: { level: "B" },
};
const flag = (status, urgency, category = "stroke") => ({ category, subject: "patient", status, urgency, quote: "头晕" });
const factVariants = [
  [],
  [flag("negative", "routine")],
  [flag("historical", "routine")],
  [flag("positive", "emergency")],
  [flag("possible", "routine")],
  [flag("negative", "urgent")],
  [flag("historical", "clarify")],
];
check("footprint equality implies identical prompt and fallback", () => {
  const factFree = { ...baseCase, clinicalFacts: undefined };
  for (const redFlags of factVariants) {
    const withFacts = { ...baseCase, clinicalFacts: { redFlags } };
    const same = m02ClinicalFactsFootprint(withFacts) === m02ClinicalFactsFootprint(factFree);
    const samePrompt = buildQuestionPrompt(withFacts) === buildQuestionPrompt(factFree);
    const sameFallback = buildCaseAwareQuestionFallback(withFacts) === buildCaseAwareQuestionFallback(factFree);
    if (same) {
      assert.ok(samePrompt, `footprint equal but prompt differs for ${JSON.stringify(redFlags)}`);
      assert.ok(sameFallback, `footprint equal but fallback differs for ${JSON.stringify(redFlags)}`);
    }
  }
  // 有意义的事实必须让指纹不同（否则先发结果会漏掉它）。
  for (const redFlags of [[flag("positive", "emergency")], [flag("possible", "routine")], [flag("negative", "urgent")], [flag("historical", "clarify")]]) {
    assert.notEqual(m02ClinicalFactsFootprint({ ...baseCase, clinicalFacts: { redFlags } }), m02ClinicalFactsFootprint(factFree),
      `facts that M02 reads must change the footprint: ${JSON.stringify(redFlags)}`);
  }
  // 纯阴性/既往常规事实不改变 M02 的任何输入：先发结果必须可用（这是提速的来源）。
  assert.equal(m02ClinicalFactsFootprint({ ...baseCase, clinicalFacts: { redFlags: [flag("negative", "routine")] } }), m02ClinicalFactsFootprint(factFree));
});
check("question route speculates on the fact-free case and gates adoption on the footprint", () => {
  const route = readFileSync("src/app/api/diagnosis/question/route.ts", "utf8");
  assert.match(route, /m02ClinicalFactsFootprint\(caseState\) === m02ClinicalFactsFootprint\(factFreeState\)/);
  assert.match(route, /questionStageResponse\(\s*factFreeState/);
  assert.match(route, /discardSpeculative\(\);\s*return questionStageResponse\(caseState, req\.signal\)/);
  assert.match(route, /prefetchDiagnoseInputs\(parsed\.caseState\)/, "M02 must prefetch M03 pre-model inputs");
});

// ── ② EviMed 检索缓存 ─────────────────────────────────────────────────────────
process.env.EVIMED_GUIDE_API_KEY = "test-only-placeholder";
const evimed = await jiti.import("../src/lib/evimed-guide.ts");
const previousFetch = globalThis.fetch;
const okBody = (title) => new Response(JSON.stringify({ code: 200, data: { list: [{ title, url: "https://example.test/a", publisher: "测试", year: "2024" }] } }), { headers: { "content-type": "application/json" } });
await checkAsync("evidence fetch dedups concurrent same-key requests and caches successes", async () => {
  evimed.resetExternalEvidenceCacheForTests();
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; await new Promise((r) => setTimeout(r, 30)); return okBody("头痛诊疗指南"); };
  const [a, b] = await Promise.all([evimed.fetchExternalEvidence("guide", "头痛 指南"), evimed.fetchExternalEvidence("guide", "头痛 指南")]);
  assert.equal(calls, 1, "concurrent same-key requests must share one upstream call");
  assert.equal(a.reason, b.reason);
  await evimed.fetchExternalEvidence("guide", "头痛 指南");
  assert.equal(calls, 1, "a cached success must not call upstream again");
  await evimed.fetchExternalEvidence("guide", "咳嗽 指南");
  assert.equal(calls, 2, "a different query is a different key");
});
await checkAsync("evidence fetch never caches failures", async () => {
  evimed.resetExternalEvidenceCacheForTests();
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}", { status: 400 }); };
  const first = await evimed.fetchExternalEvidence("guide", "眩晕 指南");
  assert.equal(first.ok, false);
  await evimed.fetchExternalEvidence("guide", "眩晕 指南");
  assert.equal(calls, 2, "a failed result must be retried, not served from cache");
});
await checkAsync("caller abort returns cancelled without killing the shared request", async () => {
  evimed.resetExternalEvidenceCacheForTests();
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; await new Promise((r) => setTimeout(r, 60)); return okBody("失眠诊疗指南"); };
  const controller = new AbortController();
  const aborted = evimed.fetchExternalEvidence("guide", "失眠 指南", { signal: controller.signal });
  const shared = evimed.fetchExternalEvidence("guide", "失眠 指南");
  controller.abort();
  assert.equal((await aborted).message, "request_cancelled");
  assert.equal((await shared).ok, true, "the other waiter still gets the upstream result");
  assert.equal(calls, 1);
});
await checkAsync("CDSS_EVIDENCE_FETCH_CACHE=false disables the cache", async () => {
  evimed.resetExternalEvidenceCacheForTests();
  process.env.CDSS_EVIDENCE_FETCH_CACHE = "false";
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return okBody("胃痛诊疗指南"); };
  await evimed.fetchExternalEvidence("guide", "胃痛 指南");
  await evimed.fetchExternalEvidence("guide", "胃痛 指南");
  assert.equal(calls, 2);
  delete process.env.CDSS_EVIDENCE_FETCH_CACHE;
});
globalThis.fetch = previousFetch;

// ── ③ 小任务缓存 ─────────────────────────────────────────────────────────────
const memo = await jiti.import("../src/lib/small-task-memo.server.ts");
await checkAsync("memoizedSmallTask merges concurrent calls and caches only cacheable results", async () => {
  memo.resetSmallTaskMemoForTests();
  let runs = 0;
  const compute = async () => { runs += 1; await new Promise((r) => setTimeout(r, 20)); return { value: "术语", cacheable: true }; };
  const [x, y] = await Promise.all([memo.memoizedSmallTask("ns", "k", compute, ""), memo.memoizedSmallTask("ns", "k", compute, "")]);
  assert.equal(x, "术语"); assert.equal(y, "术语"); assert.equal(runs, 1);
  await memo.memoizedSmallTask("ns", "k", compute, "");
  assert.equal(runs, 1, "cached");
  let failingRuns = 0;
  const degraded = async () => { failingRuns += 1; return { value: "", cacheable: false }; };
  await memo.memoizedSmallTask("ns", "k2", degraded, "");
  await memo.memoizedSmallTask("ns", "k2", degraded, "");
  assert.equal(failingRuns, 2, "degraded values must not be cached");
  const controller = new AbortController();
  const slow = async () => { await new Promise((r) => setTimeout(r, 50)); return { value: "晚到", cacheable: true }; };
  const pending = memo.memoizedSmallTask("ns", "k3", slow, "降级", controller.signal);
  controller.abort();
  assert.equal(await pending, "降级", "an aborted caller gets the fallback");
  assert.equal(await memo.memoizedSmallTask("ns", "k3", slow, "降级"), "晚到", "the shared computation still completes and is cached");
});
check("recall normalization and syndrome rerank go through the memo", () => {
  for (const file of ["src/lib/formula-recall-normalization.server.ts", "src/lib/syndrome-hypothesis-rerank.server.ts"]) {
    assert.match(readFileSync(file, "utf8"), /memoizedSmallTask(?:<[^>]*>)?\(/, `${file} must use memoizedSmallTask`);
  }
});

// ── ④ 流透传 ────────────────────────────────────────────────────────────────
const { tapFinalStageContent } = await jiti.import("../src/lib/stage-prefetch.server.ts");
await checkAsync("tapFinalStageContent passes bytes through and reports the final replaced content", async () => {
  const frames = [
    { content: "草稿……" }, { content: "<<<CDSS_STREAM_FINAL>>>终稿第一段" }, { content: "，终稿第二段" }, { content: "[END]" },
  ];
  const raw = frames.map((frame) => `${JSON.stringify(frame)}\n`).join("");
  const encoder = new TextEncoder();
  const bytes = encoder.encode(raw);
  const source = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 17)); controller.enqueue(bytes.slice(17)); controller.close(); } });
  let finalContent;
  const tapped = tapFinalStageContent(new Response(source, { status: 200 }), (content) => { finalContent = content; });
  assert.equal(await tapped.text(), raw, "bytes must be forwarded unchanged");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(finalContent, "终稿第一段，终稿第二段");
});

// ── ⑤ 路由接线 ──────────────────────────────────────────────────────────────
check("M03 route taps the final stream for M04 prefetch; M04 uses the external-evidence soft deadline", () => {
  const diagnose = readFileSync("src/app/api/diagnosis/diagnose/route.ts", "utf8");
  const prefetchAt = diagnose.indexOf("prefetchDiagnoseInputs(parsed.caseState);");
  assert.ok(prefetchAt > 0 && prefetchAt < diagnose.indexOf("await maybeAttachClinicalFactsBackstop("),
    "M03 must start its pre-model prefetch before awaiting clinical facts (parallel, not serial)");
  assert.match(diagnose, /tapFinalStageContent\(response, \(finalContent\) =>\s*prefetchPrescribeInputsFromSignedDiagnose\(gated, finalContent, parsed\.customer\.customerId\)\)/);
  const prescribe = readFileSync("src/app/api/diagnosis/prescribe/route.ts", "utf8");
  assert.match(prescribe, /externalSoftDeadlineMs:/);
  assert.match(prescribe, /m04ExternalEvidenceSoftDeadlineMs\(\)/);
});
await checkAsync("M04 soft deadline default and kill switch", async () => {
  const { m04ExternalEvidenceSoftDeadlineMs } = await jiti.import("../src/lib/prompt-budget.ts");
  delete process.env.PRIMARY_PRESCRIBE_EXTERNAL_EVIDENCE_SOFT_DEADLINE_MS;
  assert.equal(m04ExternalEvidenceSoftDeadlineMs(), 2000);
  process.env.PRIMARY_PRESCRIBE_EXTERNAL_EVIDENCE_SOFT_DEADLINE_MS = "off";
  assert.equal(m04ExternalEvidenceSoftDeadlineMs(), undefined);
  delete process.env.PRIMARY_PRESCRIBE_EXTERNAL_EVIDENCE_SOFT_DEADLINE_MS;
});

console.log(JSON.stringify({ suite: "latency-prefetch-caches", failures }, null, 1));
if (failures.length) process.exit(1);
