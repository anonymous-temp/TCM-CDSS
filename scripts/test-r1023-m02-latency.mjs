// 10/20 第十一轮 D（M02 提速）：事实抽取改流式，M02 在红旗段写完时即比对事实指纹，不再等整份写完。
//
// 背景：生产遥测里 M02 的关键路径是事实抽取（qwen3.8-max，约 50 token/s，输出 154–675 token 对应 3.7–14.2s）；
// 出题本身约 3.3s 且与抽取并行。抽取模型按 disposition → redFlags → affirmedSymptoms → encounterScope 的顺序写（30/30），
// 闸门与 M02 只读前两段。30 份病历实测红旗段写完中位 3.4s / P90 5.2s，整份 5.4s / 7.6s。
//
//   1 earlyClinicalFactsFromPartial：红旗数组闭合、其后接 affirmedSymptoms/encounterScope、disposition 在前时才给结论；
//     给出的 redFlags/disposition 与整份写完后解析+落地的结果逐项相同，M02 指纹与闸门是否急危重也相同。
//     对照：红旗段没写完、disposition 写在后面、有一条红旗引文落不了地（整份会走引用修复轮）都不给。
//   2 运行时：发起抽取时红旗段写完回调一次，签名、来源指纹与整份同一装配；整份结果照旧返回（含后两段）。
//   3 流式传输：同一组参数加 stream，逐段回调「到目前为止的全文」，用量照旧记账；不给回调时仍是非流式。
//   4 question 路由：与早到结论竞速、抽取不绑本请求的中止信号（后续阶段共用）、先发结果的指纹判据不变。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { answerNonModelRequest } from "./lib/local-model-endpoint.mjs";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const check = async (name, run) => {
  cases += 1;
  await run();
  console.log(`  ok ${name}`);
};

process.env.REASONING_CONTRACT_SIGNING_KEY ||= "r1023-m02-latency-signing-key-0123456789";

const facts = await jiti.import("../src/lib/clinical-facts.ts");
const runtime = await jiti.import("../src/lib/clinical-facts-runtime.ts");
const contract = await jiti.import("../src/lib/m02-question-contract.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");

const baseCase = {
  id: "r1023-m02",
  chiefComplaint: "胸痛伴大汗1小时",
  patient: { sex: "女", age: 52 },
  symptoms: { 现病史: "1小时前突发胸骨后压榨样疼痛，伴大汗，无发热。", 既往史: "既往高血压病史。" },
  tongue: "舌暗红，苔薄白",
  pulse: "脉弦",
  vitals: {},
  conversation: [],
  phase: "question",
  questionRounds: 0,
  maxQuestionRounds: 1,
};
const sourceText = safety.trustedInputText(safety.sanitizeCaseStateForModel(baseCase));
const urgentOutput = JSON.stringify({
  disposition: {
    setting: "emergency",
    mustNotMiss: [{ condition: "急性冠脉综合征", plausibility: "likely", evidenceQuotes: ["突发胸骨后压榨样疼痛"] }],
    rationale: "急性胸痛伴大汗，需立即急诊排除急性冠脉综合征",
  },
  redFlags: [
    { category: "cardiac", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "time_sensitive_cardiovascular_event", quote: "突发胸骨后压榨样疼痛" },
    { category: "sepsis", subject: "patient", status: "negative", urgency: "routine", triageBasis: "routine_care", quote: "无发热" },
  ],
  affirmedSymptoms: [{ term: "胸痛", quote: "胸骨后压榨样疼痛" }, { term: "大汗", quote: "伴大汗" }],
  encounterScope: { status: "active_current_target", quote: "胸痛伴大汗1小时" },
});
const calmOutput = JSON.stringify({
  disposition: { setting: "outpatient_ok", mustNotMiss: [], rationale: "无时间敏感危险" },
  redFlags: [],
  affirmedSymptoms: [{ term: "胸痛", quote: "胸骨后压榨样疼痛" }],
  encounterScope: { status: "active_current_target", quote: "胸痛伴大汗1小时" },
});

function finalFacts(raw) {
  return { ...facts.groundClinicalFacts(facts.parseClinicalFacts(raw), sourceText), reviewStatus: "single_pass" };
}
function firstEarly(raw) {
  for (let end = 1; end <= raw.length; end += 1) {
    const early = facts.earlyClinicalFactsFromPartial(raw.slice(0, end), sourceText);
    if (early) return { early, end };
  }
  return undefined;
}

console.log("1 红旗段写完即给结论，且与整份结论相同");
await check("1.1 红旗数组闭合、紧接 affirmedSymptoms 时才给，之前一律不给", async () => {
  for (const raw of [urgentOutput, calmOutput]) {
    const hit = firstEarly(raw);
    assert.ok(hit, "整份输出里一定有红旗段写完的时刻");
    assert.equal(raw.slice(0, hit.end).endsWith('"affirmedSymptoms":'), true, `在 affirmedSymptoms 键写出时给出（${raw.slice(hit.end - 30, hit.end)}）`);
    assert.ok(hit.end < raw.indexOf('"encounterScope"'), "早于后两段写完");
  }
});
await check("1.2 早到的 redFlags 与 disposition 与整份写完后逐项相同", async () => {
  for (const raw of [urgentOutput, calmOutput]) {
    const { early } = firstEarly(raw);
    const final = finalFacts(raw);
    assert.deepEqual(early.redFlags, final.redFlags);
    assert.deepEqual(early.disposition, final.disposition);
    assert.equal(early.reviewStatus, "single_pass");
    assert.deepEqual(early.affirmedSymptoms, [], "后两段不带");
    assert.equal(early.encounterScope, undefined);
  }
});
await check("1.3 M02 的事实指纹与闸门是否急危重：早到与整份相同", async () => {
  for (const raw of [urgentOutput, calmOutput]) {
    const { early } = firstEarly(raw);
    const final = finalFacts(raw);
    const withFacts = (value) => ({ ...baseCase, clinicalFacts: value });
    assert.equal(contract.m02ClinicalFactsFootprint(withFacts(early)), contract.m02ClinicalFactsFootprint(withFacts(final)));
  }
});
await check("1.4 对照：disposition 写在红旗后面、红旗段未闭合、红旗引文落不了地 —— 都不给", async () => {
  const reordered = JSON.stringify({
    redFlags: JSON.parse(urgentOutput).redFlags,
    disposition: JSON.parse(urgentOutput).disposition,
    affirmedSymptoms: [],
    encounterScope: JSON.parse(urgentOutput).encounterScope,
  });
  assert.equal(firstEarly(reordered), undefined, "disposition 在后：早到的那段看不到它");
  const unclosed = urgentOutput.slice(0, urgentOutput.indexOf('"affirmedSymptoms"') - 2);
  assert.equal(facts.earlyClinicalFactsFromPartial(unclosed, sourceText), undefined);
  const ungrounded = urgentOutput.replace('"quote":"突发胸骨后压榨样疼痛"', '"quote":"胸口像压了块石头"');
  assert.ok(facts.parseClinicalFacts(ungrounded).redFlags.length > facts.groundClinicalFacts(facts.parseClinicalFacts(ungrounded), sourceText).redFlags.length, "夹具：这条确实落不了地");
  assert.equal(firstEarly(ungrounded), undefined, "整份会走引用修复轮，结论可能变化");
});

console.log("2 运行时：发起抽取时回调一次，同一装配");
const streamingCall = (raw) => async (_system, _user, _signal, phase, onPartial) => {
  if (phase === "extract" && onPartial) {
    for (let end = 8; end < raw.length; end += 8) onPartial(raw.slice(0, end));
    onPartial(raw);
  }
  return raw;
};
await check("2.1 早到回调恰好一次，签名齐全，红旗与整份相同；整份照旧带后两段", async () => {
  const seen = [];
  const final = await runtime.maybeAttachClinicalFactsBackstop({ ...baseCase, customerId: undefined }, streamingCall(urgentOutput), undefined, {
    onEarlyRedFlags: (state) => seen.push(state),
  });
  assert.equal(seen.length, 1);
  const early = seen[0].clinicalFacts;
  assert.equal(early.semanticStatus, "checked");
  assert.match(early.attestation || "", /^hmac-sha256:/, "早到的那份与整份同样签名");
  assert.equal(early.sourceFingerprint, final.clinicalFacts.sourceFingerprint);
  assert.deepEqual(early.redFlags, final.clinicalFacts.redFlags);
  assert.deepEqual(early.disposition, final.clinicalFacts.disposition);
  assert.ok((final.clinicalFacts.affirmedSymptoms || []).length > 0, "整份带 affirmedSymptoms");
  assert.equal(final.clinicalFacts.encounterScope?.status, "active_current_target");
  assert.equal(
    safety.evaluateSafetyGate(seen[0]).status === "red_flag",
    safety.evaluateSafetyGate(final).status === "red_flag",
    "闸门是否急危重：早到与整份相同",
  );
  assert.equal(contract.m02ClinicalFactsFootprint(seen[0]), contract.m02ClinicalFactsFootprint(final));
});
await check("2.2 对照：抽取函数不回传分段（如修复相位、或调用方没要早到结论）时不回调", async () => {
  const seen = [];
  await runtime.maybeAttachClinicalFactsBackstop(baseCase, async () => urgentOutput, undefined, { onEarlyRedFlags: (state) => seen.push(state) });
  assert.equal(seen.length, 0);
  const plain = await runtime.maybeAttachClinicalFactsBackstop(baseCase, streamingCall(urgentOutput));
  assert.equal(plain.clinicalFacts.semanticStatus, "checked", "不要早到结论时照旧");
});

console.log("3 流式传输");
const runtimePath = fileURLToPath(new URL("../src/lib/clinical-facts-runtime.ts", import.meta.url));
const runtimeSource = readFileSync(runtimePath, "utf8");
const { callFactsPhaseModel } = jiti.evalModule(runtimeSource.replace("async function callFactsPhaseModel(", "export async function callFactsPhaseModel("), { filename: runtimePath });
async function streamFixture(run) {
  const bodies = [];
  const server = createServer(async (req, res) => {
    if (await answerNonModelRequest(req, res)) return;
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    bodies.push(body);
    if (!body.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: calmOutput } }], usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (let at = 0; at < calmOutput.length; at += 20) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: calmOutput.slice(at, at + 20) } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const overrides = { AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "synthetic-key", OPENAI_MODEL: "deepseek-flash", OPENAI_BASE_URL: baseUrl, CDSS_TEXT_MODEL_ALLOWED_HOSTS: "127.0.0.1", NODE_ENV: "test" };
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const logs = [];
  const original = console.info;
  console.info = (...args) => logs.push(args);
  try {
    await run({ provider: "openai-compatible", model: "deepseek-flash", apiKey: overrides.OPENAI_API_KEY, endpoint: `${baseUrl}/chat/completions`, configured: true }, bodies, logs);
  } finally {
    console.info = original;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise((resolve) => server.close(resolve));
  }
}
await check("3.1 给回调时流式请求，逐段回调到目前为止的全文，整份内容与用量照旧", async () => {
  await streamFixture(async (config, bodies, logs) => {
    const partials = [];
    const content = await callFactsPhaseModel(config, "sys", "user", undefined, "extract", (partial) => partials.push(partial));
    assert.equal(content, calmOutput);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].stream, true);
    assert.equal(bodies[0].temperature, 0, "同一组参数");
    assert.deepEqual(bodies[0].response_format, { type: "json_object" });
    assert.ok(partials.length > 3);
    assert.ok(partials.every((partial, index) => index === 0 || partial.startsWith(partials[index - 1])), "回调的是逐步增长的全文");
    assert.equal(partials.at(-1), calmOutput);
    const usage = JSON.stringify(logs);
    assert.match(usage, /completionTokens.{0,4}5/, `流式也记用量：${usage.slice(0, 300)}`);
  });
});
await check("3.2 对照：不给回调时非流式（修复相位、其他路由的抽取不变）", async () => {
  await streamFixture(async (config, bodies) => {
    const content = await callFactsPhaseModel(config, "sys", "user", undefined, "extract");
    assert.equal(content, calmOutput);
    assert.equal(bodies[0].stream, undefined);
  });
});
await check("3.3 只有抽取相位把回调交给传输层", async () => {
  assert.match(runtimeSource, /callFactsPhaseModel\(extractor, system, user, signal, phase, phase === "extract" \? onPartial : undefined\)/);
});

console.log("4 question 路由");
const route = readFileSync(new URL("../src/app/api/diagnosis/question/route.ts", import.meta.url), "utf8");
await check("4.1 与早到结论竞速，指纹判据不变", async () => {
  assert.match(route, /onEarlyRedFlags: process\.env\.CDSS_M02_EARLY_FACTS === "false" \? undefined : \(state\) => resolveEarlyFacts\(state\)/);
  assert.match(route, /caseState = await Promise\.race\(\[factsReady, earlyFacts\.then\(/);
  assert.match(route, /m02ClinicalFactsFootprint\(caseState\) === m02ClinicalFactsFootprint\(factFreeState\)/);
});
await check("4.2 抽取不绑本请求的中止信号；后台结果的拒绝被接住", async () => {
  assert.match(route, /maybeAttachClinicalFactsBackstop\(parsed\.caseState, undefined, undefined, \{/);
  assert.match(route, /factsReady\.catch\(\(\) => undefined\)/);
});

console.log(`\nr1023 M02 latency: ${cases} checks passed`);
