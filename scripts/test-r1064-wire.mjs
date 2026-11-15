// R47 I1: final delivery barriers, budgets, cache identity and real NDJSON two-pass wiring.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";
import { fixture, fakeIO } from "./fixtures/m03-tcm-two-pass/synthetic.mjs";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const { deliveryGatePolicy } = await jiti.import("../src/lib/delivery-gate-policy.ts");
const gates = await jiti.import("../src/lib/delivery-gates.server.ts");
const final = await jiti.import("../src/lib/delivery-final-content.server.ts");
const { createRewriteLedger } = await jiti.import("../src/lib/delivery-rewrite-ledger.ts");
const { buildTrustedRecordIndex } = await jiti.import("../src/lib/delivery-trusted-record.server.ts");
const { r1064GenerationIdentity } = await jiti.import("../src/lib/r1064-generation-identity.server.ts");
const outcome = await jiti.import("../src/lib/stage-generation-outcome.server.ts");
const state = { id: "synthetic-wire", phase: "diagnose", patient: { sex: "女", age: 44 }, chiefComplaint: "食少腹胀两周", symptoms: { 现病史: "近日纳少，饭后腹胀，每日便溏，神疲乏力。" }, tongue: "舌淡红苔薄白" };
const record = buildTrustedRecordIndex(state);
const identities = [{ family: "deepseek", model: "deepseek-v4-flash", endpointHost: "api.deepseek.com" }, { family: "qwen", model: "qwen3.8-flash", endpointHost: "dashscope.aliyuncs.com" }];
const policy = (extra = {}) => deliveryGatePolicy({ CDSS_DELIVERY_GATES: "true", CDSS_REWRITE_INTEGRITY: "false", CDSS_FINAL_PATIENT_FACTS: "true", CDSS_DELIVERY_INVARIANTS: "false", ...extra });
const reply = (request, kind = "not_patient_fact") => {
  const result = { verdicts: request.units.map(unit => ({ occurrenceId: unit.occurrenceId, outputQuote: unit.text, outputStart: 0, outputEnd: unit.text.length, verdict: kind, recordEvidence: [], searchedSourcePaths: record.sources.map(row => row.sourcePath), reason: "synthetic" })) };
  const column = request.messages.map(row => { try { return JSON.parse(row.content); } catch { return {}; } }).find(row => row.integrity);
  if (column) result.integrity = column.integrity.map(unit => ({ sentenceId: unit.sentenceId, fluent: true, onlyExpectedDelta: true, span: null, reason: "synthetic" }));
  return { identities, results: [result, structuredClone(result)] };
};
const run = (candidate, extra = {}, io = {}) => gates.runDeliveryGates({ candidate, caseState: state, policy: policy(), signal: new AbortController().signal, absoluteDeadline: Date.now() + 1000, ...extra }, { review: async req => reply(req), ...io });
let checks = 0, failures = 0;
async function check(id, title, fn) {
  if (process.env.R1064_WIRE_CHECK && process.env.R1064_WIRE_CHECK !== id) return;
  checks++;
  try { await fn(); console.log(`✓ ${id} ${title}`); } catch (error) { failures++; console.error(`✗ ${id} ${title}\n${error.stack || error}`); }
}
await check("W01", "总开关关闭逐字返回、零模型；shadow不能变成删除许可", async () => {
  const candidate = { stage: "diagnose", structured: { note: "患者发热。" } }; let calls = 0;
  const out = await run(candidate, { policy: { ...policy(), mode: "off" } }, { review: async () => { calls++; throw Error(); } });
  assert.deepEqual(out.candidate, candidate); assert.equal(calls, 0);
  assert.equal(deliveryGatePolicy({}).mode, "enforce");
  assert.equal(policy({ CDSS_DELIVERY_GATES: "shadow" }).facts, "shadow");
  const shadow = await run(candidate, { policy: policy({ CDSS_DELIVERY_GATES: "shadow" }) }, { review: async req => reply(req, "unsupported") });
  assert.deepEqual(shadow.candidate, candidate);
});
await check("W02", "完整性搭载同一事实批次；两种整句删除合并、引用不能复活", async () => {
  const ledger = createRewriteLedger({ stage: "diagnose", requestId: "synthetic" });
  ledger.text({ ruleId: "synthetic", ruleVersion: "1", expected: { kind: "presentation" } }, { path: "/diagnose/note" }, "患者发热。", "患者发热（）。");
  let calls = 0, sawColumn = false;
  const out = await run({ stage: "diagnose", structured: { note: "患者发热（）。" } }, { events: ledger.events, policy: policy({ CDSS_REWRITE_INTEGRITY: "true" }) }, { review: async req => { calls++; sawColumn ||= req.messages.some(row => row.content.includes('"integrity"')); return reply(req, "unsupported"); } });
  assert.equal(calls, 1); assert.ok(sawColumn); assert.equal(out.candidate.structured.note, ""); assert.ok(out.accepted); assert.equal(out.reusable, false);
});
await check("W03", "混合安全范围与本例引文保护；被阻止的删除不能伪装通过", async () => {
  const candidate = { stage: "prescribe", structured: { management: { followupSafetyNet: "本例发热。" }, patientFact: "近日纳少" } };
  const locks = gates.protectedDeliveryRanges(candidate, ["/structured/management/followupSafetyNet"]);
  const out = await run(candidate, { protectedRanges: locks }, { review: async req => reply(req, "unsupported") });
  assert.deepEqual(out.candidate, candidate); assert.equal(out.accepted, false); assert.equal(out.reusable, false);
});
await check("W04", "unknown与中止不缓存、不越过共同900ms时钟", async () => {
  const started = Date.now();
  const out = await run({ stage: "diagnose", structured: { note: "本例发热。" } }, { policy: policy({ CDSS_DELIVERY_GATE_TIMEOUT_MS: "15" }) }, { review: () => new Promise(() => {}) });
  assert.equal(out.passed, false); assert.equal(out.reusable, false); assert.ok(Date.now() - started < 600);
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const stopped = await run({ stage: "diagnose", structured: { note: "文字" } }, { signal: controller.signal }, { review: async req => { calls++; return reply(req); } });
  assert.equal(calls, 0); assert.equal(stopped.passed, false);
});
await check("W05", "限域修复只一次、拒绝越权、差异须追加；R11永远不进执行计划", async () => {
  const candidate = { stage: "diagnose", structured: { overview: { primarySyndrome: "脾气虚证", tcmDiseaseDifferentials: [{ diseaseName: "甲病" }], tcmDifferentials: [{ syndrome: "甲证" }, { syndrome: "乙证" }] }, westernDiagnosis: { differentials: [{ name: "甲" }, { name: "乙" }] } } };
  let calls = 0;
  const out = await run(candidate, { policy: policy({ CDSS_FINAL_PATIENT_FACTS: "false", CDSS_DELIVERY_INVARIANTS: "true" }), repairAvailable: true }, { repair: async snapshot => { calls++; snapshot.m03.overview.primarySyndrome = "篡改证"; snapshot.m03.overview.tcmDiseaseDifferentials.push({ diseaseName: "乙病" }); return snapshot; } });
  assert.equal(calls, 1); assert.equal(out.candidate.structured.overview.primarySyndrome, "脾气虚证"); assert.equal(out.accepted, false);
  const r = await jiti.import("../src/lib/delivery-gate-repair.ts");
  assert.equal(r.findingsToDeliveryRepairRequests([{ ruleId: "R11", mode: "enforce", status: "violation", repairOwner: "analysis", path: "/m03/overview/primarySyndrome" }], { m03: candidate.structured }, "enforce").requests.length, 0);
});
await check("W06", "删句之后渲染器不能补回；恢复内容必须拒绝", async () => {
  const candidate = { stage: "diagnose", structured: { note: "患者发热。" } };
  const out = await run(candidate, {}, { review: async req => reply(req, "unsupported"), render: () => candidate });
  assert.equal(out.accepted, false);
});
const barrierOptions = (extra = {}) => ({ stage: "diagnose", caseState: state, signal: new AbortController().signal, deadline: () => Date.now() + 2000,
  policy: policy(), prepare: value => value, render: value => value, accept: () => true, sign: value => value,
  fallback: () => "固定有限页", io: { review: async req => reply(req) }, ...extra });
await check("W07", "最后投影先于核对、签名在后；同字节checkpoint不重复核对", async () => {
  let reviewed, calls = 0, signs = 0;
  const input = final.joinDeliveryContent({ stage: "diagnose", structured: { note: "旧文字" }, visibleText: "" }, "reasoning");
  const barrier = final.createFinalDeliveryBarrier(barrierOptions({ prepare: value => value.replace("旧文字", "最终文字"),
    io: { review: async req => { reviewed = req.candidate; calls++; return reply(req); } },
    sign: value => { signs++; assert.equal(reviewed.structured.note, "最终文字"); return value; } }));
  const a = await barrier.run(input), b = await barrier.run(a);
  assert.equal(a, b); assert.equal(calls, 1); assert.equal(signs, 1);
  const tamper = final.createFinalDeliveryBarrier(barrierOptions({ sign: value => value.replace("旧文字", "签后篡改") }));
  await assert.rejects(tamper.run(input), /delivery_changed_after_gate/);
  await assert.rejects(barrier.run(input + input), /delivery_multiple_payloads/);
});
await check("W08", "非剂量页也核对，失败走有限页审计且整次生成不可复用", async () => {
  const marker = final.joinDeliveryContent({ stage: "prescribe", structured: { note: "本例发热。", safetyGate: { note: "非剂量页" } }, visibleText: "非剂量页" }, "non_dose");
  let calls = 0; const status = { reusable: true };
  await outcome.withStageGenerationOutcome(status, async () => {
    const barrier = final.createFinalDeliveryBarrier(barrierOptions({ stage: "prescribe", io: { review: async req => { calls++; return reply(req, "unsupported"); } } }));
    assert.equal(await barrier.run(marker), "固定有限页");
  });
  assert.ok(calls >= 2); assert.equal(status.reusable, false);
});
await check("W09", "策略和治理版本进入生成指纹，降级不进入阶段缓存", async () => {
  const base = r1064GenerationIdentity({});
  for (const key of ["CDSS_M03_TCM_TWO_PASS", "CDSS_M03_TCM_NARRATIVE_REWRITE", "CDSS_M03_TCM_CHECK_PREFETCH", "CDSS_DELIVERY_GATES", "CDSS_FINAL_PATIENT_FACTS", "CDSS_REWRITE_INTEGRITY", "CDSS_DELIVERY_INVARIANTS", "CDSS_DELIVERY_GATE_INCREMENTAL"]) {
    // 两道靠模型的交付核对第四十七轮终测后缺省关，换成非缺省值 shadow 才是「改了开关」。
    const changed = key === "CDSS_M03_TCM_TWO_PASS" ? "true" : key === "CDSS_FINAL_PATIENT_FACTS" || key === "CDSS_REWRITE_INTEGRITY" ? "shadow" : "false";
    assert.notEqual(r1064GenerationIdentity({ [key]: changed }), base, key);
  }
  const source = readFileSync("src/lib/stage-result-coalescing.server.ts", "utf8");
  assert.match(source, /r1064GenerationIdentity\(\)/); assert.match(source, /entry\.cacheable = generationOutcome\.reusable &&/);
});
await check("W10", "两步各自schema与strict fallback同任务；共用deadline和abort", async () => {
  const runtime = await jiti.import("../src/lib/m03-tcm-runtime.server.ts");
  const format = await jiti.import("../src/lib/model-response-format.ts");
  const d = fixture();
  for (const task of ["m03_tcm_conclusion", "m03_tcm_narrative"]) {
    const seen = [], deadline = Date.now() + 500;
    const complete = runtime.createM03TcmTaskCompletion("primary", async (request, model) => { seen.push({ task: request.task, model, deadline: request.absoluteDeadline }); return model === "primary" ? { ok: false } : { ok: true, finishReason: "stop", content: JSON.stringify(task.endsWith("conclusion") ? d.proposal : d.narrative) }; }, () => "strict");
    await complete({ task, prompt: "synthetic", schema: format.providerJsonSchemaForTask(task), maxTokens: 1000, signal: new AbortController().signal, absoluteDeadline: deadline });
    assert.deepEqual(seen, [{ task, model: "primary", deadline }, { task, model: "strict", deadline }]);
    assert.equal(format.providerJsonSchemaForTask(task).additionalProperties, false);
    assert.equal(format.strictToolSystemInstruction(task), "");
  }
});
// Production stream probes use only an entirely synthetic case and fake model transport.
async function streamProbe({ enabled = true, unusable = false, cancel = false, gatesEnabled = false } = {}) {
  const api = await jiti.import("../src/lib/diagnosis-api.ts");
  const types = await jiti.import("../src/lib/diagnosis-types.ts");
  const signatures = await jiti.import("../src/lib/reasoning-contract-signature.ts");
  const d = fixture(), io = fakeIO(d); if (unusable) d.proposal.primary = "原始提案秘密";
  const western = types.normalizeReasoningV2({ stage: "diagnose" });
  const env = { CDSS_M03_TCM_TWO_PASS: String(enabled), CDSS_DELIVERY_GATES: String(gatesEnabled), CDSS_MODEL_CALL_MEMO: "false", AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "synthetic-wire-key", OPENAI_BASE_URL: "https://api.deepseek.com", OPENAI_MODEL: "deepseek-v4-flash", PRIMARY_DIAGNOSE_MODEL: "deepseek-v4-flash", CONTROLLED_TERMINOLOGY_NORMALIZATION: "false", REASONING_CONTRACT_SIGNING_KEY: "synthetic-wire-contract-key-0000000000", PRIMARY_STRUCTURED_FALLBACK_MODEL: "none" };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])), fetch = globalThis.fetch;
  let legacyCalls = 0, legacyOverview = 0; const startedAt = Date.now() - 1000; const abort = new AbortController();
  try {
    Object.assign(process.env, env);
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init?.body || await _url.text());
      if (request.stream) { legacyCalls++; return new Response('data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }); }
      return Response.json({ choices: [{ message: { content: JSON.stringify({ westernDiagnosis: western.westernDiagnosis, management: western.management }) }, finish_reason: "stop" }] });
    };
    if (cancel) abort.abort();
    const response = await api.callDiagnosisStream("synthetic wire", "deepseek", undefined, "markdown", {
      structuredStage: "diagnose", structuredOrchestrationStartedAt: startedAt, onInitialM03Overview: () => { legacyOverview++; }, structuredCaseState: state, structuredClinicalContext: record.sources.map(row => row.text).join("\n"), requestSignal: abort.signal,
      m03ParallelHalfPrompts: { western: "synthetic western", tcm: "synthetic tcm" }, m03TcmTwoPass: { context: d.ctx, io }, truncateFallback: "有限页", upstreamUnavailableFallback: "上游不可用",
      m03TcmHalfTransform: () => { throw Error("legacy half transform must not run"); },
      diagnoseSignatureContext: signatures.buildDiagnoseContractSignatureContext(state),
    });
    const frames = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    const raw = frames.map(row => row.content || "").join("").match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/);
    const signed = raw ? JSON.parse(raw[1]) : undefined;
    return { frames, io, legacyCalls, legacyOverview, startedAt, signed, validSignature: signatures.verifyDiagnoseReasoningSignature(signed, state) };
  } finally { globalThis.fetch = fetch; for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
await check("W11", "真实两步流：无旧中医请求、无提案泄漏、最终签名、END一次", async () => {
  const { frames, io, legacyCalls, legacyOverview, startedAt, validSignature } = await streamProbe();
  assert.equal(validSignature, true); assert.equal(legacyOverview, 0);
  assert.ok(io.calls.every(call => call.absoluteDeadline <= startedAt + 180_500));
  assert.equal(legacyCalls, 0); assert.deepEqual(io.calls.map(row => row.task), ["m03_tcm_conclusion", "m03_tcm_narrative"]);
  assert.equal(frames.filter(row => row.content === "[END]").length, 1);
  assert.ok(!frames.some(row => row.error));
  const text = frames.map(row => row.content || "").join("");
  assert.doesNotMatch(text, /quotePool|conclusionHash|quoteIds/);
  assert.match(text, /contractSignature/); assert.match(text, /脾气虚证/);
});
await check("W12", "失败提案只到有限出口；false回旧流、取消END恰一次", async () => {
  const bad = await streamProbe({ unusable: true });
  assert.match(bad.frames.map(row => row.content).join(""), /有限页/); assert.doesNotMatch(JSON.stringify(bad.frames), /原始提案秘密/);
  const old = await streamProbe({ enabled: false }); assert.equal(old.io.calls.length, 0); assert.ok(old.legacyCalls > 0);
  const cancelled = await streamProbe({ cancel: true }); assert.equal(cancelled.io.calls.length, 0); assert.equal(cancelled.frames.filter(row => row.content === "[END]").length, 1);
});
await check("W13", "早签checkpoint和所有替换出口等待总闸，M04预取只认最终签名", () => {
  const source = readFileSync("src/lib/diagnosis-api.ts", "utf8");
  const route = readFileSync("src/app/api/diagnosis/diagnose/route.ts", "utf8");
  assert.match(source, /await finalDelivery\.run\(checkpointContent\)/);
  assert.match(source, /finalDeliveryPending = finalDelivery\.run\(content\.slice\(STREAM_REPLACE_MARKER\.length\)\)/);
  assert.match(source, /if \(finalDeliveryPending\) \{ closeRequested = true; return; \}/);
  assert.match(route, /prefetchPrescribeInputsFromSignedDiagnose/);
  assert.match(source, /withRewriteLedger\(/);
});
await check("W14", "总闸入口不得重复交付投影，受保护药名和原句保持逐字", () => {
  const input = final.joinDeliveryContent({ stage: "prescribe", structured: { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    overview: { primarySyndrome: "合成证" }, formula: { candidates: [{ name: "合成方", herbs: [{ name: "棕榈炭", dose: "6g", processing: "炭" }], formulaAnalysis: "棕榈炭入方。" }] } }, visibleText: "合成药名棕榈炭。" }, "reasoning");
  const prepared = final.prepareFinalDeliveryContent(input);
  assert.ok(prepared.includes("棕榈炭")); assert.ok(!prepared.includes("炭炭"));
  assert.equal(final.prepareFinalDeliveryContent(prepared), prepared);
});
await check("W15", "默认总闸接入真实流仍签最终载荷；影子检查不改临床字段", async () => {
  const legacy = await streamProbe(), checked = await streamProbe({ gatesEnabled: true });
  assert.ok(checked.validSignature); assert.deepEqual(checked.signed, legacy.signed);
  assert.equal(checked.frames.filter(row => row.content === "[END]").length, 1);
});
await check("W16", "异步降级不缓存；关闭阶段复用时模型记忆同样失效", async () => {
  const cache = await jiti.import("../src/lib/stage-result-coalescing.server.ts");
  const memo = await jiti.import("../src/lib/model-call-memo.server.ts");
  const saved = { reuse: process.env.CDSS_STAGE_RESULT_REUSE, memo: process.env.CDSS_MODEL_CALL_MEMO, store: process.env.CDSS_STAGE_RESULT_STORE_PATH };
  try {
    process.env.CDSS_STAGE_RESULT_REUSE = "true"; process.env.CDSS_STAGE_RESULT_STORE_PATH = ""; process.env.CDSS_MODEL_CALL_MEMO = "true";
    cache.resetStageResultCacheForTests(); let calls = 0;
    const request = { stage: "diagnose", key: "r1064-wire-synthetic", cacheable: () => true, compute: async () => {
      calls++;
      return new Response(new ReadableStream({ async start(controller) {
        await Promise.resolve(); outcome.markStageGenerationNonReusable();
        controller.enqueue(new TextEncoder().encode('{"content":"synthetic"}\n{"content":"[END]"}\n')); controller.close();
      } }));
    } };
    await (await cache.coalesceStageResponse(request)).text(); await (await cache.coalesceStageResponse(request)).text(); assert.equal(calls, 2);
    memo.runWithModelCallMemo({}, () => { outcome.markStageGenerationNonReusable(); assert.equal(memo.currentModelCallMemoScope().forgotten, true); });
  } finally {
    for (const [key, value] of [["CDSS_STAGE_RESULT_REUSE", saved.reuse], ["CDSS_MODEL_CALL_MEMO", saved.memo], ["CDSS_STAGE_RESULT_STORE_PATH", saved.store]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    cache.resetStageResultCacheForTests(); memo.resetModelCallMemoForTests();
  }
});
await check("W17", "不变量质量失败不升级T1；保留旧安全受理权但不得记pass或缓存", async () => {
  const candidate = { stage: "diagnose", structured: { overview: { primarySyndrome: "脾气虚证", tcmDiseaseDifferentials: [], tcmDifferentials: [] } } };
  const options = { policy: policy({ CDSS_FINAL_PATIENT_FACTS: "false", CDSS_DELIVERY_INVARIANTS: "true" }) };
  const retained = await run(candidate, options, { accept: () => true });
  assert.equal(retained.accepted, true); assert.equal(retained.passed, false); assert.equal(retained.reusable, false);
  assert.ok(retained.findings.some(row => row.ruleId === "R09")); assert.deepEqual(retained.candidate, candidate);
  const unsafe = await run(candidate, options, { accept: () => false }); assert.equal(unsafe.accepted, false);
});
console.log(JSON.stringify({ checks, failures }));
if (failures) process.exit(1);
