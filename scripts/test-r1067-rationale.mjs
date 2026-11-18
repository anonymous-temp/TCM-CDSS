import assert from "node:assert/strict";
import { createJiti } from "jiti";

process.env.AI_TEXT_PROVIDER = "deepseek";
process.env.OPENAI_API_KEY = "test-only";
process.env.OPENAI_BASE_URL = "https://api.deepseek.com/v1";
process.env.PRIMARY_DIAGNOSE_MODEL = "deepseek-flash";
process.env.REASONING_CONTRACT_SIGNING_KEY = "test-only-r1067-rationale-signing-key";
process.env.CDSS_MODEL_CALL_MEMO = "false";
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
const { buildFinalRationaleContext, bindRationaleQuote } = await lib("m03-final-rationale-context.server");
const { validateRationalePair, withFinalRationalePair } = await lib("m03-final-rationale-validation.server");
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
  const { records, chief, tongue, pulse, conclusion, lineage } = snapshot;
  const q = Object.create(null);
  const add = (quote, term = quote, line = records.find((entry) => entry[1].includes(quote))?.[0]) => {
    assert.ok(line, `缺合成引文 ${quote}`);
    const id = `q${Object.keys(q).length + 1}`;
    q[id] = [line, quote, term];
    return id;
  };
  const tagged = (id) => `{{${id}}}`;
  const quote = chief[0].term;
  const first = add(quote, quote, chief[0].line);
  const second = add("时有心悸", "心悸");
  const t = tongue.map((item) => add(item.term, item.term, item.line));
  const p = pulse.map((item) => add(item.term, item.term, item.line));
  const mechanism = "心血亏虚则神失所养";
  const tMeaning = "血少失于充养";
  const pMeaning = "脉道充盈欠足";
  const s = {
    s: "ok", q, d: [[first, null, "睡眠起始受阻"]], g: [[0, [first, second], mechanism, ["血虚"]]],
    t: t.length ? ["s", t, tMeaning, 0] : ["u"], p: p.length ? ["s", p, pMeaning, 0] : ["u"], u: [], l: null, b: [],
    x: `${tagged(first)}，睡眠起始受阻，归于${conclusion.disease}。`,
    y: `${tagged(first)}，伴${tagged(second)}，${mechanism}，合参属${conclusion.names[0]}。` +
      (t.length ? `${t.map(tagged).join("、")}与${tMeaning}相应。` : "舌象未记录。") +
      (p.length ? `${p.map(tagged).join("、")}示${pMeaning}。` : "脉象未记录。"),
  };
  if (conclusion.resolution === "bounded") {
    s.b = [["四诊", "分证资料", "支持有限"]];
    s.y += "现据所述辨证，分证资料支持有限。";
  }
  if (lineage) {
    const line = `扶阳学派看${tagged(second)}，辨其与所定证的相应处。`;
    s.l = [lineage.code, [second], line];
    s.y += line;
  }
  return s;
}
function assertRejected(reply, ctx, code) {
  const checked = validateRationalePair(reply, ctx);
  assert.equal(checked.ok, false, JSON.stringify(checked));
  assert.ok(checked.reasons.some((r) => r.code === code), JSON.stringify(checked));
}

const qid = (ctx, text, predicate = () => true) => ctx.lines.find((entry) => entry.text.includes(text) && predicate(entry))?.id;
const parsed = (content) => JSON.parse(content.match(/<!-- DIAGNOSIS_JSON_START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END -->/u)[1]);

async function wire({ mode = "on", parallel = false, route = false, twoPass = false, gate = "off", author, align, state = input(), candidate = root(), timeout = 8000 } = {}) {
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
    if (request.messages[0].content.includes("常见病例350 tokens内")) {
      assert.equal(request.model, "deepseek-flash");
      assert.equal(request.temperature, 0);
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
    return { content, reasoning: parsed(content), events, calls, state };
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
    observe: (event) => events.push(event), transport: (messages, opts) => {
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
await check("03", "逐处辨本人、当前、未问及和否认，禁止拼接", () => {
  const ctx = context(input({ symptoms: { presentHistory: "否认腹痛、恶心。今日自觉腹痛。既往曾出现头痛。母亲本人咳嗽。是否便血不详。今日头晕，时有头晕。" } }));
  const bind = (quote, term) => bindRationaleQuote(ctx, [qid(ctx, quote) || qid(ctx, "否认腹痛"), quote, term]);
  assert.ok(bind("今日自觉腹痛", "腹痛"));
  for (const [quote, term] of [["否认腹痛", "腹痛"], ["恶心", "恶心"], ["既往曾出现头痛", "头痛"], ["母亲本人咳嗽", "咳嗽"], ["是否便血不详", "便血"], ["今日自觉腹痛便血", "腹痛"]]) {
    assert.equal(bind(quote, term), undefined, quote);
  }
  assert.equal(bind("腹痛", "腹痛"), undefined);
  assert.equal(bind("头晕", "头晕"), undefined);
});
await check("04", "教材仅论通则，裸部位、数值或伴随主症退修", () => {
  const ctx = context();
  const reply = outline(ctx.input);
  const supported = { ...reply, x: "多寐病通常以日间乏力为伴。{{q1}}，睡眠起始受阻，归于不寐。" };
  assert.equal(validateRationalePair(supported, ctx).ok, true, JSON.stringify(validateRationalePair(supported, ctx)));
  assertRejected({ ...reply, x: "本例已见嗜睡，" + reply.x }, ctx, "text_unquoted_finding");
  assertRejected({ ...reply, x: "持续18周，" + reply.x }, ctx, "text_unquoted_finding");
  const point = structuredClone(reply);
  point.d[0][1] = "D99";
  assertRejected(point, ctx, "disease_reasoning");
});
await check("05", "舌质苔和复合脉逐项，单字脉可用，脉搏指纹分列", () => {
  const ctx = context();
  const reply = outline(ctx.input);
  assert.equal(validateRationalePair(reply, ctx).ok, true, JSON.stringify(validateRationalePair(reply, ctx)));
  const cut = structuredClone(reply);
  cut.t[1].pop();
  assertRejected(cut, ctx, "inspection_components");
  const single = context(input({ pulse: "弦" }));
  assert.equal(single.input.pulse[0].term, "弦");
  const sparse = context(input({ pulse: "", tongue: "", vitals: { P: "80" }, symptoms: { presentHistory: "时有心悸。小儿指纹淡红。" } }));
  assert.equal(sparse.input.pulse.length, 0);
  assert.ok(sparse.input.important.some((finding) => finding.term === "小儿指纹淡红"));
  const normal = context(input({ tongue: "舌淡红苔薄白", pulse: "平脉" }));
  const neutral = outline(normal.input);
  assertRejected(neutral, normal, "inspection_normal");
  for (const axis of ["t", "p"]) {
    neutral.y = neutral.y.replace(neutral[axis][2], "不具区分力");
    neutral[axis] = ["n", neutral[axis][1], "不具区分力"];
  }
  assert.ok(validateRationalePair(neutral, normal).ok, JSON.stringify(validateRationalePair(neutral, normal)));
  assertRejected({ ...outline(sparse.input), y: outline(sparse.input).y.replace("脉象未记录。", "") }, sparse, "inspection_missing_disclosure");
});
await check("06", "证素与器官收敛，外证名和主兼倒置退修", () => {
  const ctx = context();
  const reply = outline(ctx.input);
  for (const mechanism of ["肝血亏虚则神失所养", "心阴亏虚则神失所养"]) {
    const changed = structuredClone(reply);
    changed.y = changed.y.replace(changed.g[0][2], mechanism);
    changed.g[0][2] = mechanism;
    assertRejected(changed, ctx, "foreign_element");
  }
  assertRejected({ ...reply, y: reply.y + "另属气血两虚证。" }, ctx, "syndrome_name");
  assertRejected({ ...reply, y: reply.y + "另辨为气血两虚。" }, ctx, "syndrome_name");
  assertRejected({ ...reply, y: reply.y + "兼见心血虚证。" }, ctx, "syndrome_name");
});
await check("07", "提纲证据与成文相扣，拒无引文查体和只列正常舌脉", () => {
  const ctx = context();
  const reply = outline(ctx.input);
  assertRejected({ ...reply, y: reply.y.replace(reply.g[0][2], "心失所养") }, ctx, "group_prose_link");
  assertRejected({ ...reply, y: reply.y + "另见双肺湿啰音。" }, ctx, "text_unquoted_finding");
  assertRejected({ ...reply, y: reply.y.replace(reply.p[2], "参考") }, ctx, "inspection_meaning");
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
await check("09", "流派仅末句且方向一致，标签、工程字、残尾、长度退修", () => {
  const ctx = context();
  const reply = outline(ctx.input);
  assertRejected({ ...reply, x: "不寐。" }, ctx, "text_length");
  assertRejected({ ...reply, y: reply.y + "故为。" }, ctx, "text_fragment");
  assertRejected({ ...reply, y: reply.y + "本次模型输出。" }, ctx, "text_engineering");
  const selected = context(input({ tcmLineagePreference: "support-yang" }));
  const lens = outline(selected.input);
  assert.ok(validateRationalePair(lens, selected).ok, JSON.stringify(validateRationalePair(lens, selected)));
  assertRejected(lens, ctx, "lineage_unsolicited");
  const wrong = structuredClone(lens);
  wrong.l[2] = wrong.l[2].replace("辨其与所定证的相应处", "选用四逆汤");
  wrong.y = wrong.y.replace(lens.l[2], wrong.l[2]);
  assertRejected(wrong, selected, "lineage_formula");
});
await check("10", "bounded 写明缺项，证据空缺与有限结果只留底稿", async () => {
  const ctx = context(input({ tongue: "", pulse: "" }), root({ primarySyndromeResolution: "bounded" }));
  const reply = outline(ctx.input);
  assert.ok(validateRationalePair(reply, ctx).ok, JSON.stringify(validateRationalePair(reply, ctx)));
  assertRejected({ ...reply, b: [] }, ctx, "bounded_limit");
  assertRejected({ ...reply, s: "evidence_gap" }, ctx, "evidence_gap");
  const cold = root({ tcmDiseaseName: "腹痛", primarySyndrome: "寒凝证", primarySyndromeResolution: "bounded" });
  const abdominal = context(input({ chiefComplaint: "遇冷便腹痛", symptoms: { presentHistory: "得温痛减" }, tongue: "", pulse: "" }), cold);
  const abdominalReply = {
    s: "ok", q: { q1: [qid(abdominal, "遇冷便腹痛"), "遇冷便腹痛", "腹痛"], q2: [qid(abdominal, "得温痛减"), "得温痛减", "得温痛减"] },
    d: [["q1", null, "所苦在腹"]], g: [[0, ["q1", "q2"], "寒凝使经脉收引", ["cold"]]],
    t: ["u"], p: ["u"], u: [], l: null, b: [["四诊", "舌脉", "佐证有限"]],
    x: "{{q1}}，所苦在腹，归于腹痛。",
    y: "{{q1}}、{{q2}}，寒凝使经脉收引，与寒凝证相合。舌脉均未记录，分证佐证有限。",
  };
  assert.ok(validateRationalePair(abdominalReply, abdominal).ok, JSON.stringify(validateRationalePair(abdominalReply, abdominal)));
  const justPain = context(input({ chiefComplaint: "腹痛一天", symptoms: {}, tongue: "", pulse: "" }), cold);
  const unsupported = structuredClone(abdominalReply);
  unsupported.q = { q1: [qid(justPain, "腹痛"), "腹痛", "腹痛"], q2: [qid(justPain, "一天"), "一天", "一天"] };
  assertRejected(unsupported, justPain, "syndrome_evidence_gap");
  assert.equal(buildFinalRationaleContext(root({ primarySyndromeResolution: "unresolved" }), input(), ""), undefined);
  const old = await wire({ mode: "off" });
  const gap = await wire({ author: (request) => ({ ...outline(request), s: "evidence_gap" }) });
  assert.equal(gap.content, old.content);
  assert.equal(gap.calls.length, 1);
});
await check("11", "父取消、异常和两次拒稿整体回退，带拒因且最多两次", async () => {
  const old = await wire({ mode: "off" });
  const bad = await wire({ author: (request) => ({ ...outline(request), y: "{{q1}}{{q2}}{{q3}}{{q4}}{{q5}}" }) });
  assert.deepEqual(bad.content, old.content);
  assert.equal(bad.calls.length, 2);
  assert.ok(bad.calls[1].revise.some((item) => item.field === "y"));
  assert.equal(bad.events[0].physicalCalls, 2);
  const recovered = await wire({ author: (request, _opts, call) => call === 1 ? "{" : outline(request) });
  assert.equal(recovered.events[0].signed, true, JSON.stringify(recovered.events));
  assert.equal(recovered.events[0].retried, true);
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

console.log(JSON.stringify({ checks, failures }));
if (failures) process.exitCode = 1;
