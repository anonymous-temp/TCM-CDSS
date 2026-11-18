import assert from "node:assert/strict";
import { createJiti } from "jiti";

process.env.AI_TEXT_PROVIDER = "deepseek";
process.env.OPENAI_API_KEY = "test-only";
process.env.OPENAI_BASE_URL = "https://api.deepseek.com/v1";
process.env.PRIMARY_DIAGNOSE_MODEL = "deepseek-flash";
process.env.REASONING_CONTRACT_SIGNING_KEY = "test-only-r1067-rationale-signing-key";
process.env.CDSS_MODEL_CALL_MEMO = "false";
process.env.CDSS_SMALL_TASK_MEMO = "false";
process.env.CDSS_DELIVERY_GATES = "off";
process.env.CDSS_CLINICAL_FACTS_BACKSTOP = "false";
process.env.CDSS_DEFAULT_CUSTOMER_ID = "r1067-test";
process.env.CDSS_API_CLIENT_ID = "r1067-test-client";
process.env.CDSS_API_CUSTOMER_IDS = "r1067-test";
process.env.CDSS_REQUIRE_API_AUTH = "false";
process.env.CDSS_API_TOKEN = "";
process.env.CDSS_REQUEST_ARCHIVE = "false";
process.env.CDSS_STAGE_RESULT_REUSE = "false";
globalThis.fetch = async () => { throw new Error("Unexpected network request outside the test transport"); };

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const lib = (name) => jiti.import(`../src/lib/${name}.ts`);
const { normalizeCaseStateInput } = await lib("diagnosis-types");
const { clinicalGroundingText } = await lib("diagnosis-safety");
const { buildFinalRationaleContext, hasCurrentRationaleQuote } = await lib("m03-final-rationale-context.server");
const { parsePatientClaimRemovals } = await lib("m03-patient-claim-check.server");
const { validateRationalePair, withFinalRationalePair } = await lib("m03-final-rationale-validation.server");
const { FINAL_RATIONALE_SYSTEM, parseRationaleOutline } = await lib("m03-final-rationale-outline.server");
const { createFinalRationaleAuthor } = await lib("m03-final-rationale.server");
const { callDiagnosisStream } = await lib("diagnosis-api");
const { buildDiagnoseContractSignatureContext, verifyDiagnoseReasoningSignature } = await lib("reasoning-contract-signature");
const { prescribeWorkingPriorReasoning } = await lib("prescribe-working-reasoning");
const { stageRequestFingerprint, coalesceStageResponse } = await lib("stage-result-coalescing.server");
const { enforceM04PriorStageOwnership } = await lib("diagnosis-structured-repair");
const { projectDeliveredReasoning } = await lib("delivered-surface");
const { buildHisAiSchemePayload } = await lib("his-scheme");
const { buildPrescribePrompt } = await lib("diagnosis-prompts");
const { POST } = await jiti.import("../src/app/api/diagnosis/diagnose/route.ts");

let checks = 0;
let failures = 0;
async function check(id, title, run) {
  if (process.env.R1067_ONLY && process.env.R1067_ONLY !== id) return;
  checks++;
  try {
    await run();
    console.log(`✓ ${id} ${title}`);
  } catch (error) {
    failures++;
    console.error(`✗ ${id} ${title}\n${error.stack}`);
  }
}

const evidence = { evidenceLevel: "model_inference", source: "本例四诊资料", confidence: "中" };
const input = (changes = {}) => normalizeCaseStateInput({
  id: "synthetic-rationale",
  patient: { age: 32, sex: "女" },
  chiefComplaint: "入睡困难",
  symptoms: { presentHistory: "时有心悸。睡中易醒。" },
  tongue: "舌淡白，苔薄白",
  pulse: "脉细弱",
  ...changes,
});
const root = (changes = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: {
    tcmDiseaseName: "不寐", primarySyndrome: "心血虚证", primarySyndromeResolution: "resolved",
    secondarySyndromes: [], primarySyndromeBasis: ["时有心悸", "舌淡白", "脉细弱"],
    tcmDiseaseRationale: "入睡困难，睡中易醒，属不寐。",
    tcmDiagnosticRationale: "心悸与舌淡脉细合参，心血不足而心神失养，属心血虚证。",
    tcmDifferentials: [{ syndrome: "心肾不交证", reason: "同属不寐的鉴别", distinguishingPoints: "心血失养与心肾不交须区别", typicalManifestation: "", nextCheck: null }], tcmDiseaseDifferentials: [
      { diseaseName: "多寐病", reason: "同属睡眠病症，需区分主症", distinguishingPoints: "主诉为入睡困难", nextCheck: null },
    ],
    overallPathogenesis: "心血亏虚，心神失养", overallTherapy: "养血安神",
    recommendedFormulaDirection: "安神定志", recommendedFormulaNames: [], evidence, ...changes,
  },
  westernDiagnosis: { primary: {
    name: "失眠症状", status: "考虑", confidence: "中", supportingFacts: ["入睡困难"], clinicalRationale: "入睡困难伴睡中易醒，考虑失眠症状。", limitations: [], suggestedChecks: [], evidence,
  }, differentials: [] },
  pathogenesis: {
    summary: "心血亏虚，心神失养",
    locationDifferentiation: { items: ["心"], details: [{ location: "心", basis: "时有心悸" }], resolution: "resolved", evidence },
    natureDifferentiation: { items: ["血虚"], resolution: "resolved", evidence },
    chain: [{ nodeId: "P1", patientFact: "时有心悸", syndromeEvidence: "舌淡白，脉细弱", pathogenesis: "心血亏虚则心神失养", therapyDirection: "养血安神", evidence }],
    uncertainties: [{ item: "出血情况", reason: "尚待问诊", affects: "血虚程度" }],
  },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "养血安神", subTherapies: [{ therapy: "养血安神", targetPathogenesis: "心血亏虚", priority: "主要" }] },
  management: { followupSafetyNet: "如症状持续或加重及时复诊。" },
});
const context = (state = input(), reasoning = root(), scope = "test-tenant") => {
  const snapshot = buildFinalRationaleContext(reasoning, state, scope);
  assert.ok(snapshot, "合成病例符合作者入口");
  return snapshot;
};
function outline(snapshot) {
  const { chief, tongue, pulse, conclusion, lineage } = snapshot;
  const symptom = chief[0].term;
  const tongueText = tongue.map(({ term }) => term).join("、");
  const pulseText = pulse.map(({ term }) => term).join("、");
  return {
    s: "ok", d: [symptom], g: [[[symptom, "时有心悸"], "心血亏虚则神失所养", conclusion.names[0]]],
    t: tongue.length ? ["s", tongueText, "舌质与血少相应"] : ["u"],
    p: pulse.length ? ["s", pulseText, "脉道充盈欠足"] : ["u"],
    l: lineage ? "扶阳学派看时有心悸，须合舌脉辨其相应处。" : null,
    x: `${symptom}，睡中又容易醒，入睡与续睡均受扰，归于${conclusion.disease}。`,
    y: `${symptom}，是心神失于濡养，到了夜间难以安定；睡中易醒，也与心神失养相应。时有心悸，为心血不足，心脉失于濡养。` +
      "心血不足，既不能充养心脉，也不能使神志入夜得安。" +
      (tongue.length ? `${tongueText}，舌质与血少相应。` : "舌象未记录。") +
      (pulse.length ? `${pulseText}，提示脉道充盈不足。` : "脉象未记录。") +
      `合参本次睡眠和心悸所见，故属${conclusion.names[0]}。`,
  };
}
function assertRejected(reply, ctx, code) {
  const checked = validateRationalePair(reply, ctx);
  assert.equal(checked.ok, false, JSON.stringify(checked));
  assert.ok(checked.reasons.some((r) => r.code === code), JSON.stringify(checked));
}

const parsed = (content) => JSON.parse(content.match(/<!-- DIAGNOSIS_JSON_START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END -->/u)[1]);

async function wire({ mode = "on", parallel = false, route = false, twoPass = false, gate = "off", author, align, state = input(), candidate = root(), timeout = 8000, claim } = {}) {
  process.env.CDSS_M03_FINAL_RATIONALE = mode;
  process.env.CDSS_DELIVERY_GATES = gate;
  process.env.M03_PARALLEL_GENERATION = String(parallel);
  process.env.CDSS_M03_TCM_TWO_PASS = String(twoPass);
  const previousFetch = globalThis.fetch;
  const previousLog = console.info;
  const events = [];
  console.info = (tag, value, ...args) => {
    if (tag === "[tcm-cdss:telemetry] m03_final_rationale") events.push(value);
    else if (process.env.R1067_DEBUG) previousLog(tag, value, ...args);
  };
  const calls = [];
  const claimRequests = [];
  const stream = (value) => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) } }] })}\n\n` +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { "Content-Type": "text/event-stream" } },
  );
  globalThis.fetch = async (_url, init) => {
    if (!init?.body || typeof init.body !== "string") return new Response(null, { status: 404 });
    const request = JSON.parse(init.body);
    if (!request.messages) return new Response(null, { status: 404 });
    const last = request.messages.at(-1).content;
    if (request.messages[0].content === FINAL_RATIONALE_SYSTEM) {
      assert.equal(request.model, "deepseek-flash");
      assert.equal(request.temperature, 0);
      assert.equal(request.max_tokens, 700);
      assert.equal(request.response_format.type, "json_object");
      assert.equal(request.thinking?.type, "disabled");
      const snapshot = JSON.parse(last);
      calls.push(snapshot);
      const reply = author ? await author(snapshot, undefined, calls.length) : outline(snapshot);
      if (reply instanceof Response) return reply;
      return Response.json({
        choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 800, completion_tokens: 300, total_tokens: 1100 },
      });
    }
    if (!request.stream && request.messages[0].content.startsWith("你是病历事实核对器")) {
      const payload = JSON.parse(last);
      const authored = payload.fields.some(({ text }) => text.includes("入睡与续睡均受扰"));
      if (authored) claimRequests.push(payload);
      const result = authored && claim ? claim(payload) : { claims: [] };
      if (result instanceof Response) return result;
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
    }
    if (!request.stream && request.messages[0].content.startsWith("你是病历核对员")) {
      const payload = JSON.parse(last);
      if (payload.claims.some(({ context }) => context.includes("入睡与续睡均受扰"))) claimRequests.push(payload);
      const result = { items: payload.claims.map(({ id }) => ({ id, verdict: "absent" })) };
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
    }
    if (!request.stream) {
      const result = /synthetic-western|并行分工·西医半/u.test(last) ? { westernDiagnosis: candidate.westernDiagnosis, management: candidate.management } : {};
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }] });
    }
    if (/synthetic-tcm|并行分工·中医半/u.test(last)) {
      const tcm = Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== "westernDiagnosis" && key !== "management"));
      return stream(tcm);
    }
    return stream(candidate);
  };
  try {
    const response = route ? await POST(new Request("http://localhost/api/diagnosis/diagnose", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caseState: state }),
    })) : await callDiagnosisStream("synthetic m03 rationale", "deepseek", undefined, "markdown", {
      structuredStage: "diagnose", truncateFallback: "SYNTHETIC_LIMITED", structuredCaseState: state, structuredClinicalContext: clinicalGroundingText(state),
      diagnoseSignatureContext: buildDiagnoseContractSignatureContext(state),
      m03ParallelHalfPrompts: parallel ? { western: "synthetic-western", tcm: "synthetic-tcm" } : undefined,
      m03AnalysisAlignment: align,
      m03FinalRationaleTimeoutMs: timeout,
      m03FinalRationaleTransport: async (messages, opts) => {
        opts.onNetworkAttempt();
        opts.onUsage({ promptTokens: 900, completionTokens: 300 });
        const request = JSON.parse(messages[1].content);
        calls.push(request);
        return author ? author(request, opts, calls.length) : outline(request);
      },
    });
    assert.equal(response.status, 200, response.ok ? "" : await response.text());
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const content = lines.findLast((frame) => frame.content?.includes("<!-- DIAGNOSIS_JSON_START -->"))?.content;
    assert.ok(content, "实际 M03 流须有终稿 " + JSON.stringify(lines.slice(-4)));
    return { content, reasoning: parsed(content), events, calls, claimRequests, state };
  } finally {
    globalThis.fetch = previousFetch;
    console.info = previousLog;
  }
}

await check("01", "实际合并定稿后换两段，上游判定照常", async () => {
  const old = await wire({ mode: "off", parallel: true });
  const final = await wire({ parallel: true });
  assert.equal(final.events[0].signed, true, JSON.stringify(final.events));
  assert.equal(final.calls.at(-1).conclusion.names[0], final.reasoning.overview.primarySyndrome);
  for (const key of ["tcmDiseaseName", "primarySyndrome", "secondarySyndromes", "overallTherapy", "recommendedFormulaDirection"]) {
    assert.deepEqual(final.reasoning.overview[key], old.reasoning.overview[key]);
  }
  assert.notEqual(final.reasoning.overview.tcmDiagnosticRationale, old.reasoning.overview.tcmDiagnosticRationale);
  const routed = await wire({ route: true, parallel: true });
  assert.equal(routed.events[0].signed, true, JSON.stringify(routed.events));
  assert.ok(routed.events[0].physicalCalls > 0 && routed.events[0].promptTokens > 0);
});
await check("02", "完整键隔离轴引文、病历、主兼名、流派、确定度；陈旧预取无需等待", async () => {
  const original = context().key;
  const variant = root();
  variant.pathogenesis.locationDifferentiation.details[0].basis = "时常心悸";
  const otherUnknown = structuredClone(variant);
  otherUnknown.pathogenesis.locationDifferentiation.details[0].basis = "曾觉心悸";
  assert.notEqual(context(input(), variant).key, context(input(), otherUnknown).key);
  assert.notEqual(context(input(), variant).key, original);
  assert.notEqual(context(input({ symptoms: { presentHistory: "偶有心悸" } })).key, original);
  assert.notEqual(context(input(), root({ primarySyndrome: "气血两虚证" })).key, original);
  assert.notEqual(context(input(), root({ secondarySyndromes: ["气虚证"] })).key, original);
  assert.notEqual(context(input(), root({ primarySyndromeResolution: "bounded" })).key, original);
  assert.notEqual(context(input({ tcmLineagePreference: "support-yang" })).key, original);
  assert.notEqual(context(input(), root(), "other-tenant").key, original);
  const controller = new AbortController();
  const events = [];
  let calls = 0;
  const runner = createFinalRationaleAuthor({ state: input(), scope: "test-tenant", mode: "on", signal: controller.signal, deadline: () => Date.now() + 1000, timeoutMs: 150,
    observe: (event) => events.push(event), claimCheck: async () => [], transport: (messages, opts) => {
      opts.onNetworkAttempt();
      calls++;
      if (calls === 1) return new Promise(() => {});
      return Promise.resolve(outline(JSON.parse(messages[1].content)));
    } });
  runner.prefetch(root);
  runner.prefetch(() => variant);
  await Promise.resolve();
  assert.ok(await runner.propose(variant));
  assert.equal(await runner.propose(variant), undefined);
  runner.finish("new", true);
  assert.deepEqual([events[0].prefetch, events[0].physicalCalls], ["stale", 2]);
  const hit = await wire();
  assert.equal(hit.events[0].prefetch, "hit", JSON.stringify(hit.events));
  assert.equal(hit.calls.length, 1);
});
await check("03", "逐处对回本人本次肯定所见，三分之一上界含等号", () => {
  const ctx = context(input({ symptoms: { presentHistory: "时有心悸。睡中易醒。否认腹痛、恶心。今日自觉腹痛。既往曾出现头痛。母亲本人咳嗽。是否便血不详。今日头晕，时有头晕。", tcmPulse: "脉象：弦" } }));
  for (const quote of ["今日自觉腹痛", "腹痛", "头晕", "时有心悸。", "脉弦"]) assert.ok(hasCurrentRationaleQuote(ctx, quote), quote);
  for (const quote of ["否认腹痛", "恶心", "头痛", "母亲本人咳嗽", "便血", "今日自觉腹痛便血"]) {
    assert.equal(hasCurrentRationaleQuote(ctx, quote), false, quote);
  }
  ctx.state.clinicalFacts = { redFlags: [{ status: "negative", quote: "否认腹痛、恶心" }] };
  assert.ok(hasCurrentRationaleQuote(ctx, "腹痛"), "只保护否认所在位置");
  const mixed = context(input({ symptoms: { presentHistory: "时有心悸，否认胸痛。睡中易醒。" } }));
  assert.equal(hasCurrentRationaleQuote(mixed, "时有心悸，否认胸痛"), false);
  const normal = context();
  const reply = outline(normal.input);
  assert.ok(validateRationalePair({ ...reply, d: ["未录词条"] }, normal).ok);
  assertRejected({ ...reply, d: ["未录词条", "另一无据词条"] }, normal, "quote_occurrence");
  const groups = structuredClone(reply);
  groups.g[0][0] = ["编造一", "编造二"];
  assertRejected(groups, normal, "quote_occurrence");
});
await check("04", "逐字保留病名分型，病段无证名，主症允许自然转述", () => {
  const ctx = context(input(), root({ tcmDiseaseName: "不寐（入睡型）" }));
  const reply = outline(ctx.input);
  assert.ok(validateRationalePair(reply, ctx).ok);
  assertRejected({ ...reply, x: reply.x.replace("（入睡型）", "") }, ctx, "disease_name");
  assertRejected({ ...reply, x: reply.x + "亦见心血虚证。" }, ctx, "disease_element");
  const sameMeaning = { ...reply, x: reply.x.replace("入睡困难", "难以入睡") };
  assert.ok(validateRationalePair(sameMeaning, ctx).ok);
  for (const field of ["x", "y"]) {
    assertRejected({ ...reply, [field]: field === "x" ? "近来常在夜间梦中惊醒，精神难得安稳，所患属不寐（入眠型）。" : reply.y.replace("入睡困难", "夜间梦多").replace("睡眠", "夜间") }, ctx, "chief_missing");
  }
});
await check("05", "舌质苔与脉各按成分覆盖，单字脉与缺测分别处理", () => {
  const ctx = context();
  const reply = outline(ctx.input);
  assert.ok(validateRationalePair({ ...reply, y: reply.y.replace("舌淡白、苔薄白", "舌淡白苔薄白").replace("脉细弱", "脉弱细") }, ctx).ok);
  assert.ok(validateRationalePair({ ...reply, y: reply.y.replace("脉细弱", "脉细") }, ctx).ok);
  assertRejected({ ...reply, y: reply.y.replace("舌淡白、苔薄白", "舌淡") }, ctx, "inspection_recorded");
  assertRejected({ ...reply, y: reply.y.replace("脉细弱，提示脉道充盈不足。", "合看心神仍难濡养。") }, ctx, "inspection_recorded");
  assertRejected({ ...reply, y: reply.y.replace("脉细弱", "脉象未记录") }, ctx, "inspection_recorded");
  const single = context(input({ pulse: "弦" }));
  assert.ok(validateRationalePair({ ...outline(single.input), y: reply.y.replace("脉细弱", "脉弦") }, single).ok);
  const absent = context(input({ tongue: "", pulse: "", vitals: { P: 80 }, symptoms: { presentHistory: "时有心悸。睡中易醒。指纹淡。" } }));
  assert.equal(absent.input.pulse.length, 0);
  const missing = outline(absent.input);
  assert.ok(validateRationalePair({ ...missing, y: missing.y.replace("舌象未记录。脉象未记录。", "舌象、脉象未记录。") }, absent).ok);
  assertRejected({ ...missing, y: missing.y.replace("脉象未记录。", "") }, absent, "inspection_missing_disclosure");
});
await check("06", "主兼证原名与顺序，越名不采纳", () => {
  const ctx = context(input(), root({ secondarySyndromes: ["气虚证"] }));
  const reply = outline(ctx.input);
  const accepted = { ...reply, y: reply.y.replace("故属心血虚证。", "故属心血虚证，兼气虚证。") };
  assert.ok(validateRationalePair(accepted, ctx).ok);
  assertRejected({ ...accepted, y: reply.y }, ctx, "syndrome_name");
  assertRejected({ ...accepted, y: accepted.y.replace("属心血虚证，兼气虚证", "属气虚证，兼心血虚证") }, ctx, "syndrome_name");
  assertRejected({ ...accepted, y: accepted.y.replace("属心血虚证，兼气虚证", "兼心血虚证，主证为气虚证") }, ctx, "syndrome_name");
  assertRejected({ ...accepted, y: accepted.y + "另属气血两虚证。" }, ctx, "foreign_syndrome");
  assertRejected({ ...accepted, y: accepted.y + "另辨为气血两虚。" }, ctx, "foreign_syndrome");
  const overlap = context(input(), root({ primarySyndrome: "心气虚证", secondarySyndromes: ["气虚证"] }));
  const drafted = outline(overlap.input);
  assertRejected(drafted, overlap, "syndrome_name");
  assert.ok(validateRationalePair({ ...drafted, y: drafted.y.replace("故属心气虚证。", "故属心气虚证，兼气虚证。") },
    overlap, { revision: true }).ok);

});
await check("07", "新提纲及 JSON 形状，成文改写接受", () => {
  const ctx = context();
  const reply = outline(ctx.input);
  assert.ok(parseRationaleOutline(JSON.stringify(reply)).outline);
  assertRejected("{", ctx, "invalid_json");
  assertRejected({ ...reply, y: undefined }, ctx, "outline_shape");
  assertRejected({ ...reply, t: ["s", ["舌淡白"], "血少"] }, ctx, "outline_shape");
  assertRejected({ ...reply, q: {} }, ctx, "outline_shape");
  assertRejected({ ...reply, y: reply.y + "{{q1}}。" }, ctx, "text_fragment");
});

await check("08", "只去同一属性已答疑问，混合保留余项，保留程度既往和急症", () => {
  const sample = root();
  const row = (item, affects = "辨证") => ({ item, reason: "尚需核实", affects });
  sample.pathogenesis.uncertainties = [row("有无心悸"), row("有无心悸、胸闷"), row("心悸程度"), row("既往有无心悸"), row("有无心悸", "急诊处置")];
  const ctx = context(input(), sample);
  const checked = validateRationalePair(outline(ctx.input), ctx);
  assert.ok(checked.ok, JSON.stringify(checked));
  const next = withFinalRationalePair(sample, checked.pair, ctx);
  assert.deepEqual(next.pathogenesis.uncertainties.map((r) => r.item), ["有无胸闷", "心悸程度", "既往有无心悸", "有无心悸"]);
  assert.deepEqual(withFinalRationalePair(next, checked.pair, ctx), next);
});
await check("09", "标签、工程字、残尾、长度退修；流派句不由模型写", () => {
  const ctx = context();
  const reply = outline(ctx.input);
  assertRejected({ ...reply, x: "不寐。" }, ctx, "text_length");
  assertRejected({ ...reply, y: reply.y + "故为。" }, ctx, "text_fragment");
  assertRejected({ ...reply, y: reply.y + "本次模型输出。" }, ctx, "text_engineering");
  assertRejected({ ...reply, x: reply.x + "睡眠受阻所以归在此病。".repeat(12) }, ctx, "text_length");
  assertRejected({ ...reply, y: reply.y + "所见与主证相应。".repeat(38) }, ctx, "text_length");
  // 第五十轮 v6：未选流派时模型即使写了 l 也不采用、不因此拒稿（流派句只沿用旧稿里已核对过的那一句）。
  const stray = validateRationalePair({ ...reply, l: "扶阳学派由本例心悸主张选用四逆汤。" }, ctx);
  assert.ok(stray.ok, JSON.stringify(stray));
  assert.ok(!stray.pair.tcmDiagnosticRationale.includes("扶阳"));
});
await check("10", "bounded 写明缺项，证据空缺与有限结果只留底稿", async () => {
  const ctx = context(input({ tongue: "", pulse: "" }), root({ primarySyndromeResolution: "bounded" }));
  const reply = outline(ctx.input);
  assert.ok(validateRationalePair(reply, ctx).ok, JSON.stringify(validateRationalePair(reply, ctx)));

  assertRejected({ ...reply, s: "evidence_gap" }, ctx, "evidence_gap");
  assert.equal(buildFinalRationaleContext(root({ primarySyndromeResolution: "unresolved" }), input(), ""), undefined);
  const old = await wire({ mode: "off" });
  const gap = await wire({ author: (request) => ({ ...outline(request), s: "evidence_gap" }) });
  assert.equal(gap.content, old.content);
  assert.equal(gap.calls.length, 1);
});
await check("11", "父取消、异常和两次拒稿整体回退，带拒因且最多两次", async () => {
  const old = await wire({ mode: "off" });
  // 缺省不退修（第五十轮时延取舍）：首稿硬拒只调用一次、整体回退。
  const single = await wire({ author: (request) => ({ ...outline(request), y: outline(request).y + "故为。" }) });
  assert.deepEqual(single.content, old.content);
  assert.equal(single.calls.length, 1);
  process.env.CDSS_M03_FINAL_RATIONALE_RETRY = "true";
  const bad = await wire({ author: (request) => ({ ...outline(request), y: outline(request).y + "故为。" }) });
  assert.deepEqual(bad.content, old.content);
  assert.equal(bad.calls.length, 2);
  const revision = bad.calls[1].revise.find((item) => item.code === "text_fragment");
  assert.equal(revision.field, "y");
  assert.match(revision.instruction, /完整句/u);
  assert.deepEqual(bad.events[0].reasons.find((item) => item.code === revision.code), { code: revision.code, field: "y" });
  assert.equal(bad.events[0].physicalCalls, 2);
  const recovered = await wire({ author: (request, _opts, call) => call === 1 ? "{" : outline(request) });
  assert.equal(recovered.events[0].signed, true, JSON.stringify(recovered.events));
  assert.equal(recovered.events[0].retried, true);
  delete process.env.CDSS_M03_FINAL_RATIONALE_RETRY;
  const transportError = await wire({ author: () => { throw new Error("synthetic failure"); } });
  assert.equal(transportError.content, old.content);
  const unavailable = await wire({ route: true, parallel: true, author: () => new Response(null, { status: 503 }) });
  assert.equal(unavailable.events[0].physicalCalls, 1);
  assert.equal(unavailable.events[0].signed, false);
  assert.ok(unavailable.reasoning.contractSignature);
  const controller = new AbortController();
  let child;
  const runner = createFinalRationaleAuthor({ state: input(), scope: "test", mode: "on", signal: controller.signal, deadline: () => Date.now() + 1000, timeoutMs: 100,
    observe: () => {}, transport: async (_messages, { signal }) => { child = signal; return new Promise(() => {}); } });
  runner.prefetch(root);
  const pending = runner.propose(root());
  await Promise.resolve();
  controller.abort();
  assert.equal(child.aborted, true);
  assert.equal(await pending, undefined);
  runner.finish("none");
});
await check("11b", "交付哈希按 JSON 视图比较：显式 undefined 键不算差异（真链路曾因此把通过验收的两段退回）", async () => {
  const { finalRationaleDeliveryHash } = await jiti.import("../src/lib/m03-final-rationale.server");
  const base = root();
  const withUndefined = { ...base, westernDiagnosis: { ...base.westernDiagnosis, primary: { ...base.westernDiagnosis?.primary, guidelineReferences: undefined } } };
  assert.equal(finalRationaleDeliveryHash(withUndefined), finalRationaleDeliveryHash(JSON.parse(JSON.stringify(withUndefined))));
  const changed = { ...base, overview: { ...base.overview, tcmDiagnosticRationale: `${base.overview.tcmDiagnosticRationale}改` } };
  assert.notEqual(finalRationaleDeliveryHash(changed), finalRationaleDeliveryHash(base));
});
await check("12", "off 字节一致，新字节渲染并签名，处方工作副本继承", async () => {
  const off = await wire({ mode: "off", author: () => assert.fail("off called author") });
  const unknown = await wire({ mode: "unknown" });
  assert.equal(off.content, unknown.content);
  assert.equal(off.calls.length, 0);
  const on = await wire();
  const { reasoning, content, state } = on;
  assert.equal(on.events[0].signed, true, JSON.stringify(on.events));
  assert.ok(verifyDiagnoseReasoningSignature(reasoning, state));
  const changed = structuredClone(reasoning);
  changed.overview.tcmDiseaseRationale += "改";
  assert.equal(verifyDiagnoseReasoningSignature(changed, state), false);
  const visible = content.split("<!-- DIAGNOSIS_JSON_START -->")[0];
  const working = prescribeWorkingPriorReasoning(state, reasoning);
  const his = buildHisAiSchemePayload({ ...state, reasoningDiagnose: reasoning });
  const prompt = buildPrescribePrompt({ ...state, reasoningDiagnose: working });
  for (const key of ["tcmDiseaseRationale", "tcmDiagnosticRationale"]) {
    assert.ok(visible.includes(reasoning.overview[key]), visible);
    assert.equal(working.overview[key], reasoning.overview[key]);
    assert.ok(prompt.includes(reasoning.overview[key]));
    assert.equal(his.diagnoses.tcmDetail[key], reasoning.overview[key]);
  }
  const prescribe = parsed(enforceM04PriorStageOwnership(
    `<!-- DIAGNOSIS_JSON_START -->${JSON.stringify({ ...reasoning, stage: "prescribe" })}<!-- DIAGNOSIS_JSON_END -->`, reasoning));
  const projected = projectDeliveredReasoning(prescribe, { caseState: state, recordText: clinicalGroundingText(state) });
  assert.equal(projected.overview.tcmDiagnosticRationale, reasoning.overview.tcmDiagnosticRationale);
  const experiment = await wire({ route: true, parallel: true, twoPass: true });
  assert.equal(experiment.events[0].skip, "two_pass", JSON.stringify(experiment.events));
  assert.equal(experiment.calls.length, 0);
  const gated = await wire({ gate: "enforce" });
  assert.equal(gated.events[0].signed, true, JSON.stringify(gated.events));
  assert.ok(verifyDiagnoseReasoningSignature(gated.reasoning, gated.state));
});
await check("13", "真实流 200 但全超时功能验收为红；shadow、off、缓存另计", async () => {
  const forceTimeout = process.env.R1067_FORCE_TIMEOUT === "1";
  const accepted = await wire(forceTimeout ? { timeout: 5, author: () => new Promise(() => {}) } : {});
  const timeout = await wire({ timeout: 5, author: () => new Promise(() => {}) });
  const shadow = await wire({ mode: "shadow" });
  const off = await wire({ mode: "off" });
  const rate = (samples) => {
    const applicable = samples.flatMap(({ events }) => events).filter((item) => item.eligible && item.mode === "on");
    assert.ok(applicable.length, "需要适用样本");
    return applicable.filter((item) => item.signed).length / applicable.length;
  };
  assert.equal(rate([accepted]), 1, "功能验收：M03 200，适用样本的最终签入率为 0");
  assert.equal(rate([timeout]), 0);
  assert.throws(() => assert.ok(rate([timeout]) >= 0.85));
  assert.equal(timeout.content, off.content);
  assert.equal(timeout.events[0].reasons[0].code, "fallback_timeout");
  assert.equal(shadow.events[0].verified, true);
  assert.equal(shadow.events[0].signed, false);
  assert.equal(shadow.content, off.content);
  assert.throws(() => rate([off, shadow]), /需要适用样本/);
  const state = input();
  process.env.CDSS_MODEL_CALL_MEMO = "true";
  process.env.CDSS_MODEL_CALL_MEMO_PATH = "";
  process.env.CASE_SNAPSHOT_ENCRYPTION_KEY = "";
  const first = await wire({ route: true, parallel: true });
  const replayed = await wire({ route: true, parallel: true });
  const physical = (sample) => sample.events[0].physicalCalls;
  assert.deepEqual([physical(first), physical(replayed)], [1, 0]);
  assert.equal(replayed.events[0].signed, true);
  assert.equal(replayed.reasoning.overview.tcmDiagnosticRationale, first.reasoning.overview.tcmDiagnosticRationale);
  process.env.CDSS_MODEL_CALL_MEMO = "false";
  process.env.CDSS_STAGE_RESULT_REUSE = "true";
  process.env.CDSS_M03_FINAL_RATIONALE = "off";
  const keyOff = stageRequestFingerprint("diagnose", {}, state);
  process.env.CDSS_M03_FINAL_RATIONALE = "on";
  assert.notEqual(stageRequestFingerprint("diagnose", {}, state), keyOff);
  const key = stageRequestFingerprint("diagnose", {}, { fixture: "r1067-unique-cache" });
  let computed = 0;
  const options = {
    stage: "diagnose", key, cacheable: () => true,
    compute: async () => {
      computed++;
      return new Response('{"content":"已签字节"}\n{"content":"[END]"}\n', { headers: { "Content-Type": "application/x-ndjson" } });
    },
  };
  const original = await (await coalesceStageResponse(options)).text();
  const replay = await coalesceStageResponse(options);
  assert.equal(await replay.text(), original);
  assert.equal(replay.headers.get("x-cdss-stage-result"), "reused");
  assert.equal(computed, 1);
});

await check("14", "已定名的撤回与对内措辞退修，保留 M04 漂移探针", () => {
  const ctx = context();
  const reply = outline(ctx.input);
  assertRejected({ ...reply, x: reply.x.replace("归于不寐", "暂按不寐") }, ctx, "disease_retracted");
  assertRejected({ ...reply, y: reply.y.replace("故属心血虚证", "心血虚证尚待核实") }, ctx, "syndrome_retracted");
  assertRejected({ ...reply, y: reply.y + "不具区分力。" }, ctx, "text_internal");
  assertRejected({ ...reply, x: reply.x.replace("睡中又容易醒", "睡中又容易醒，睡中又容易醒") }, ctx, "m04_carryover_drift");
  assertRejected({ ...reply, y: reply.y.replace("时有心悸", "时有心悸，时有心悸") }, ctx, "m04_carryover_drift");
});
await check("15", "选了流派：沿用旧稿里已核对的视角句，模型写的 l 不用；y、x 里不得另有视角句", () => {
  const selected = context(input({ tcmLineagePreference: "support-yang" }));
  const lens = outline(selected.input);
  const verdict = validateRationalePair({ ...lens, l: "扶阳学派据此治以行气活血。" }, selected);
  assert.ok(verdict.ok, JSON.stringify(verdict));
  const delivered = verdict.pair.tcmDiagnosticRationale;
  assert.ok(delivered.startsWith(lens.y));
  assert.ok(!delivered.includes("行气活血"), "模型写的流派句不进成文");
  const tail = delivered.slice(lens.y.length);
  assert.ok(tail === "" || String(selected.root.overview.tcmDiagnosticRationale).includes(tail.replace(/。$/u, "")), "接上的只能是旧稿里的视角句");
  if (typeof lens.l === "string" && lens.l) {
    assertRejected({ ...lens, y: lens.y + lens.l }, selected, "lineage_embedded");
    assertRejected({ ...lens, x: lens.x + lens.l }, selected, "lineage_disease");
  }
});
await check("16", "本次起病与病程吻合，单列以前发作或否认仍不能引用", () => {
  const symptoms = { presentHistory: "两月前出现腹部隐痛，伴嗳气。曾有咳嗽。无腹泻，查体可见皮疹。无呕吐，黑便。否认胸痛、气短。不痒不痛。" };
  const current = context(input({ chiefComplaint: "腹痛2个月", symptoms }), root({ tcmDiseaseName: "腹痛" }));
  const quote = hasCurrentRationaleQuote;
  assert.ok(quote(current, "伴嗳气"));
  assert.ok(quote(current, "查体可见皮疹"));
  for (const finding of ["曾有咳嗽", "黑便", "气短", "不痒不痛"]) assert.equal(quote(current, finding), false, finding);
  const anotherEpisode = context(input({ symptoms }));
  assert.equal(quote(anotherEpisode, "伴嗳气"), false);
  const unrelated = context(input({ chiefComplaint: "咳嗽2个月", symptoms }), root({ tcmDiseaseName: "咳嗽" }));
  assert.equal(quote(unrelated, "伴嗳气"), false);
  const hairLoss = (chiefComplaint) => context(input({ chiefComplaint, symptoms: { presentHistory: "十天前梳头发现耳后有小片脱发区，不痒不痛。" } }),
    root({ tcmDiseaseName: "油风" }));
  assert.ok(quote(hairLoss("耳后片状脱发十天"), "耳后有小片脱发区"));
  assert.equal(quote(hairLoss("耳后片状脱发十天"), "不痒不痛"), false);
  assert.equal(quote(hairLoss("耳后片状脱发三天"), "耳后有小片脱发区"), false);
  const relief = (history) => context(input({ chiefComplaint: "腹痛2个月", symptoms: { presentHistory: history } }), root({ tcmDiseaseName: "腹痛" }));
  assert.ok(quote(relief("两月前出现腹痛，餐后加重，休息后稍缓解。"), "餐后加重"));
  assert.equal(quote(relief("两月前出现腹痛，餐后加重，现已完全缓解。"), "餐后加重"), false);
  const reporter = context(input({ symptoms: { presentHistory: "近三天睡眠颠倒、认不清亲属，母亲本人咳嗽。" } }));
  assert.ok(quote(reporter, "近三天睡眠颠倒、认不清亲属"));
  assert.equal(quote(reporter, "母亲本人咳嗽"), false);
  const witness = context(input({ symptoms: { presentHistory: "今早突然眼前发黑，没来得及站稳就跌倒，老伴说喊她不应，片刻后自行醒来。" } }));
  assert.ok(quote(witness, "喊她不应，片刻后自行醒来"));
});

await check("17", "证素越界是软规则：首稿即采纳并计码，不为它退修；硬拒退修一次仍不过则回底稿", async () => {
  const state = input(), ctx = context(state);
  const groupDraft = outline(ctx.input);
  groupDraft.g[0][1] = "所见由肝阴亏虚所致";
  const groupVerdict = validateRationalePair(groupDraft, ctx);
  assert.ok(groupVerdict.ok && groupVerdict.softAccepted && groupVerdict.reasons.some(({ code, field }) => code === "foreign_element" && field === "g"));
  const propose = async (hard) => {
    const events = [];
    let calls = 0;
    const author = createFinalRationaleAuthor({ state, scope: "test", mode: "on", signal: new AbortController().signal,
      deadline: () => Date.now() + 20_000, observe: (event) => events.push(event), claimCheck: async () => [],
      transport: async (messages) => {
        const request = JSON.parse(messages[1].content);
        const draft = outline(request);
        draft.y += "所见由肝阴亏虚所致。";
        calls += 1;
        if (hard) draft.y += "定稿证素不归入。";
        if (calls === 2) assert.ok(request.revise.some((reason) => reason.code === "text_internal"));
        return draft;
      } });
    const proposal = await author.propose(ctx.root);
    author.finish(proposal ? "new" : "old", Boolean(proposal));
    return { proposal, event: events[0], calls };
  };
  const soft = await propose(false);
  assert.ok(soft.proposal);
  assert.equal(soft.calls, 1, "软规则不触发退修");
  assert.equal(soft.event.softAccepted, true);
  assert.ok(soft.event.softReasons.some((entry) => entry.code === "foreign_element" && !("phrase" in entry)));
  const hard = await propose(true);
  assert.equal(hard.calls, 1, "缺省不退修：首稿硬拒即回底稿");
  assert.equal(hard.proposal, undefined);
  assert.equal(hard.event.softAccepted, false);
  process.env.CDSS_M03_FINAL_RATIONALE_RETRY = "true";
  try {
    const retried = await propose(true);
    assert.equal(retried.calls, 2, "开关打开时带拒因退修一次");
    assert.equal(retried.proposal, undefined);
  } finally { delete process.env.CDSS_M03_FINAL_RATIONALE_RETRY; }
});
await check("18", "只核两段，编造表现作最小删除，病历仅否认的字面可删", async () => {
  const field = "tcmDiseaseRationale";
  const span = "双手颤动";
  const state = input({ symptoms: { presentHistory: "时有心悸。睡中易醒。否认双手颤动。" } });
  const reply = (request) => ({ ...outline(request), x: outline(request).x.replace("入睡与续睡均受扰", `${span}，入睡与续睡均受扰`) });
  const result = await wire({ route: true, parallel: true, state, author: reply, claim: () => ({ claims: [{ field, span }] }) });
  const event = result.events[0];
  assert.equal(event.signed, true, JSON.stringify(event));
  assert.deepEqual([event.claimCheck, event.claimCalls, event.claimRemovals], ["checked", 3, 1]);
  assert.ok(result.claimRequests.filter(({ fields }) => fields).length === 2);
  for (const { fields } of result.claimRequests.filter(({ fields }) => fields)) {
    assert.deepEqual(fields.map(({ id }) => id).sort(), ["tcmDiagnosticRationale", "tcmDiseaseRationale"]);
  }
  assert.equal(result.reasoning.overview[field], outline(result.calls.at(-1)).x);
  assert.deepEqual(parsePatientClaimRemovals(JSON.stringify({ claims: [{ field, span }] }),
    [{ id: field, text: span }], "查体见双手颤动。"), []);
  assert.deepEqual(parsePatientClaimRemovals(JSON.stringify({ claims: [{ field, span }] }),
    [{ id: field, text: span }], "否认双手颤动。"), [{ field, span }]);
});
await check("19", "删除后失去舌脉或证名、低于字数时，两段一起退回", async () => {
  const ctx = context();
  const reply = outline(ctx.input);
  const propose = async (field, span, raw = reply) => {
    const events = [];
    const runner = createFinalRationaleAuthor({ state: ctx.state, scope: "test", mode: "on", signal: new AbortController().signal,
      deadline: () => Date.now() + 1000, timeoutMs: 80, observe: (event) => events.push(event),
      transport: async () => raw,
      claimCheck: async () => [{ field, span }],
    });
    const result = await runner.propose(ctx.root);
    runner.finish(result ? "new" : "old", Boolean(result));
    assert.equal(result, undefined);
    assert.equal(events[0].claimRemovals, 1);
    assert.equal(events[0].requests, 1);
    return events[0].reasons;
  };
  for (const [span, code] of [["脉细弱", "inspection_recorded"], ["心血虚证", "syndrome_name"]]) {
    assert.ok((await propose("tcmDiagnosticRationale", span)).some((reason) => reason.code === code));
  }
  const short = { ...reply, x: "入睡困难反复发生且睡中多醒，睡眠始终受扰，归于不寐。" };
  assert.ok((await propose("tcmDiseaseRationale", "睡眠始终受扰", short)).some((reason) => reason.code === "text_length"));
  assert.ok((await propose("tcmDiseaseRationale", "入睡困难反复发生", short)).some((reason) => reason.code === "claim_check_shortened"));
});
await check("20", "事实模型失败或超时仍正常签入，并区分不可用和零删除", async () => {
  const failure = await wire({ route: true, parallel: true, claim: () => new Response(null, { status: 503 }) });
  const event = failure.events[0];
  assert.equal(event.signed, true, JSON.stringify(event));
  assert.deepEqual([event.claimCheck, event.claimCalls, event.claimRemovals], ["unavailable", 2, 0]);
  const ctx = context();
  const events = [];
  const deadline = Date.now() + 330;
  let lateReply = false;
  let timer;
  const runner = createFinalRationaleAuthor({ state: ctx.state, scope: "test", mode: "on", signal: new AbortController().signal,
    deadline: () => deadline, timeoutMs: 20, observe: (item) => events.push(item),
    transport: async () => outline(ctx.input), claimCheck: async (_content, _record, _signal, attempted) => {
      attempted();
      return new Promise((resolve) => {
        timer = setTimeout(() => { lateReply = true; resolve([]); }, 700);
      });
    } });
  const proposal = await runner.propose(ctx.root);
  clearTimeout(timer);
  assert.ok(proposal);
  assert.equal(lateReply, false);
  runner.finish("new", true);
  assert.deepEqual([events[0].claimCheck, events[0].claimCalls], ["unavailable", 1]);
  const good = await wire();
  assert.deepEqual([good.events[0].claimCheck, good.events[0].claimCalls, good.events[0].claimRemovals], ["checked", 2, 0]);
});

console.log(JSON.stringify({ checks, failures }));
if (failures) process.exitCode = 1;
