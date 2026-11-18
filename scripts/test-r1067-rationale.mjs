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
const { buildFinalRationaleContext, bindRationaleQuote, recordedRationaleSitePain } = await lib("m03-final-rationale-context.server");
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
  const { records, chief, tongue, pulse, conclusion, lineage } = snapshot;
  const q = Object.create(null);
  const add = (quote, term, line = records.find((entry) => entry[1].includes(quote))?.[0]) => {
    assert.ok(line, `缺合成引文 ${quote}`);
    const id = `q${Object.keys(q).length + 1}`;
    q[id] = term ? [line, quote, term] : [line, quote];
    return id;
  };
  const tagged = (id) => `{{${id}}}`;
  const quote = chief[0].term;
  const first = add(quote, undefined, chief[0].line);
  const second = add("时有心悸", "心悸");
  const t = tongue.map((item) => add(item.term, undefined, item.line));
  const p = pulse.map((item) => add(item.term, undefined, item.line));
  const mechanism = "心血亏虚则神失所养";
  const tMeaning = "血少失于充养";
  const pMeaning = "脉道充盈欠足";
  const s = {
    s: "ok", q, d: [first], g: [[[first, second], mechanism, conclusion.names[0]]],
    t: t.length ? ["s", t, tMeaning] : ["u"], p: p.length ? ["s", p, pMeaning] : ["u"], u: [], l: null, b: [],
    x: `${tagged(first)}，睡眠起始受阻，归于${conclusion.disease}。`,
    y: `${tagged(first)}，伴${tagged(second)}，${mechanism}，合参属${conclusion.names[0]}。` +
      (t.length ? `${t.map(tagged).join("、")}与${tMeaning}相应。` : "舌象未记录。") +
      (p.length ? `${p.map(tagged).join("、")}示${pMeaning}。` : "脉象未记录。"),
  };
  if (conclusion.resolution === "bounded") {
    s.b = ["补问入睡后的情形"];
    s.y += "现据所述辨证，夜间睡眠详况尚缺。";
  }
  if (lineage) {
    const line = `扶阳学派看${tagged(second)}，辨其与所定证的相应处。`;
    s.l = line;
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
    if (request.messages[0].content === FINAL_RATIONALE_SYSTEM) {
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
  assert.ok(bind("腹痛", "腹痛"), "同处有肯否时只绑定唯一的肯定现症");
  assert.equal(bind("头晕", "头晕"), undefined);
});
await check("04", "教材仅论通则，裸部位、数值或伴随主症退修", () => {
  const ctx = context();
  const reply = outline(ctx.input);
  const supported = { ...reply, x: "多寐病通常以日间乏力为伴。{{q1}}，睡眠起始受阻，归于不寐。" };
  assert.equal(validateRationalePair(supported, ctx).ok, true, JSON.stringify(validateRationalePair(supported, ctx)));
  assertRejected({ ...reply, x: "本例已见咳嗽，" + reply.x }, ctx, "text_unquoted_finding");
  assertRejected({ ...reply, x: "持续18周，" + reply.x }, ctx, "text_unquoted_finding");
  assertRejected({ ...reply, x: "{{q1}}，属不寐。" }, ctx, "disease_reasoning");
  assert.ok(validateRationalePair({ ...reply, x: reply.x.replace("归于不寐", "心血亏虚而属不寐") }, ctx).ok);
  assertRejected({ ...reply, x: reply.x.replace("归于不寐", "心血虚证而属不寐") }, ctx, "disease_element");
  assertRejected({ ...reply, x: reply.x + "本例无皮损。" }, ctx, "text_unquoted_finding");
  assertRejected({ ...reply, x: reply.x + "可见皮损但病程尚缺。" }, ctx, "text_unquoted_finding");
  assertRejected({ ...reply, x: reply.x.replace("不寐", "睡眠病") }, ctx, "disease_name");
  assertRejected({ ...reply, x: reply.x.replace("{{q1}}", "{{q2}}") }, ctx, "disease_chief");
  const subtype = context(input(), root({ tcmDiseaseName: "不寐（分型）" }));
  assertRejected(reply, subtype, "disease_name");
  assert.ok(validateRationalePair(outline(subtype.input), subtype).ok);
});
await check("05", "舌质苔和复合脉逐项，单字脉可用，脉搏指纹分列", () => {
  const ctx = context();
  const reply = outline(ctx.input);
  assert.equal(validateRationalePair(reply, ctx).ok, true, JSON.stringify(validateRationalePair(reply, ctx)));
  const cut = structuredClone(reply);
  cut.y = cut.y.replace("、{{q4}}", "");
  assertRejected(cut, ctx, "inspection_components");
  const single = context(input({ pulse: "弦" }));
  assert.equal(single.input.pulse[0].term, "弦");
  const sparse = context(input({ pulse: "", tongue: "", vitals: { P: "80" }, symptoms: { presentHistory: "时有心悸。小儿指纹淡红。" } }));
  assert.equal(sparse.input.pulse.length, 0);
  assert.ok(sparse.input.important.some((finding) => finding.term === "小儿指纹淡红"));
  const normal = context(input({ tongue: "舌淡红苔薄白", pulse: "平脉" }));
  const neutral = outline(normal.input);
  assertRejected(neutral, normal, "inspection_normal");
  assert.equal(validateRationalePair(neutral, normal, { revision: true }).softAccepted, true);
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
    changed.y = changed.y.replace(changed.g[0][1], mechanism);
    const result = validateRationalePair(changed, ctx);
    assert.ok(!result.ok && result.reasons.some((item) => item.code === "foreign_element" && mechanism.includes(item.phrase)));
  }
  assertRejected({ ...reply, y: reply.y + "另属气血两虚证。" }, ctx, "foreign_syndrome");
  assertRejected({ ...reply, y: reply.y + "另辨为气血两虚。" }, ctx, "foreign_syndrome");
  assertRejected({ ...reply, y: reply.y + "兼见心血虚证。" }, ctx, "syndrome_name");
});
await check("07", "提纲证据与成文相扣，拒无引文查体和只列正常舌脉", () => {
  const ctx = context();
  const reply = outline(ctx.input);
  assert.ok(validateRationalePair({ ...reply, y: reply.y.replace(reply.g[0][1], "心神少养，难安于夜") }, ctx).ok);
  assert.ok(validateRationalePair({ ...reply, y: reply.y.replace("伴{{q2}}，", "") }, ctx).ok);
  const missingGroup = structuredClone(reply);
  missingGroup.g.push([["q99"], "心血亏虚", "心血虚证"]);
  assertRejected(missingGroup, ctx, "group_reference");
  const restated = structuredClone(reply);
  restated.g[0][1] = "心悸，心神失养";
  assertRejected(restated, ctx, "group_repeated_finding");
  assert.equal(validateRationalePair(restated, ctx, { revision: true }).softAccepted, true);
  assertRejected({ ...reply, y: "{{q1}}、{{q2}}，属心血虚证。" + reply.y.split("。").slice(1).join("。") }, ctx, "group_reasoning");
  assertRejected({ ...reply, y: reply.y.replace("{{q2}}", "{{q2}}".repeat(6)) }, ctx, "group_reasoning");
  const wrongFirst = structuredClone(reply);
  wrongFirst.g[0][0] = ["q2"];
  assertRejected(wrongFirst, ctx, "chief_group");
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
  assertRejected({ ...reply, x: reply.x + "睡眠受阻所以归在此病。".repeat(8) }, ctx, "text_length");
  assertRejected({ ...reply, y: reply.y + "所见与主证相应。".repeat(38) }, ctx, "text_length");
  const selected = context(input({ tcmLineagePreference: "support-yang" }));
  const lens = outline(selected.input);
  assert.ok(validateRationalePair(lens, selected).ok, JSON.stringify(validateRationalePair(lens, selected)));
  assertRejected(lens, ctx, "lineage_unsolicited");
  const wrong = structuredClone(lens);
  wrong.l = wrong.l.replace("辨其与所定证的相应处", "选用四逆汤");
  assertRejected(wrong, selected, "lineage_formula");
});
await check("10", "bounded 写明缺项，证据空缺与有限结果只留底稿", async () => {
  const ctx = context(input({ tongue: "", pulse: "" }), root({ primarySyndromeResolution: "bounded" }));
  const reply = outline(ctx.input);
  assert.ok(validateRationalePair(reply, ctx).ok, JSON.stringify(validateRationalePair(reply, ctx)));
  assert.ok(validateRationalePair({ ...reply, b: [] }, ctx).ok);
  assertRejected({ ...reply, y: reply.y.replace("舌象未记录。脉象未记录。现据所述辨证，夜间睡眠详况尚缺。", "现据所述辨证。") }, ctx, "bounded_limit");
  assertRejected({ ...reply, s: "evidence_gap" }, ctx, "evidence_gap");
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
  const revision = bad.calls[1].revise.find((item) => item.code === "group_reasoning");
  assert.equal(revision.field, "y");
  assert.match(revision.instruction, /六个汉字/u);
  assert.match(revision.phrase, /\{\{q1\}\}/u);
  assert.deepEqual(bad.events[0].reasons.find((item) => item.code === revision.code), { code: revision.code, field: "y" });
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

await check("14", "新版与实见变体归一，带标签和同处重复引文可用", () => {
  const ctx = context(input({ tongue: "正常舌象：淡红舌，薄白苔", faceNote: "正常面色：红黄隐隐，明润含蓄",
    tcmLineagePreference: "support-yang" }));
  const reply = outline(ctx.input);
  const row = ctx.lines.find(({ text }) => text.startsWith("正常舌象："));
  const face = ctx.lines.find(({ text }) => text.startsWith("正常面色："));
  assert.equal(bindRationaleQuote(ctx, [face.id, face.text]).text, "红黄隐隐，明润含蓄");
  const tongueRefs = reply.t[1];
  reply.q[tongueRefs[0]] = [row.id, row.text, null, null];
  reply.y = reply.y.replace(tongueRefs.map((id) => `{{${id}}}`).join("、"), `{{${tongueRefs[0]}}}`)
    .replace(reply.t[2], "平和，无明确分证价值");
  reply.t = ["n", [tongueRefs[0]], "舌象平和"];
  const modern = validateRationalePair(reply, ctx);
  assert.ok(modern.ok, JSON.stringify(modern));
  assert.match(modern.pair.tcmDiagnosticRationale, /淡红舌，薄白苔/u);
  assert.doesNotMatch(modern.pair.tcmDiagnosticRationale, /正常舌象：/u);

  const variant = structuredClone(reply);
  variant.t = [[...variant.t, null]];
  variant.p = null;
  variant.q.q11 = variant.q.q2;
  variant.q.q12 = ["r999", "无关的弃用摘录"];
  variant.g = [[1, ["q1", "q11"], "不要求逐字复现的病机", "心血虚证", ["S99"]]];
  variant.d = [["q11", "D99", "不在成文的说明"]];
  variant.l = ["support-yang", ["q11"], reply.l];
  variant.b = [["四诊", "无需逐字写入", "支持有限"]];
  variant.u = [];
  variant.extra = "忽略多余键";
  const normalized = parseRationaleOutline(variant);
  assert.ok(normalized.outline);
  assert.deepEqual(normalized.outline.t, reply.t);
  assert.equal(normalized.outline.p, null);
  assert.deepEqual(normalized.outline.d, ["q11"]);
  assert.deepEqual(normalized.outline.g, [[["q1", "q11"], "不要求逐字复现的病机", "心血虚证"]]);
  assert.deepEqual(normalized.outline.u, []);
  assert.equal(normalized.outline.l, variant.l[2]);
  assert.deepEqual(normalized.outline.b, ["无需逐字写入"]);
  assert.deepEqual(validateRationalePair(variant, ctx), modern);
  assertRejected({ ...reply, x: reply.x.replace("{{q1}}", "{{q99}}") }, ctx, "quote_reference");
  assertRejected({ ...reply, q: { ...reply.q, q1: ["r999", "入睡困难"] } }, ctx, "quote_occurrence");
});

await check("15", "主兼顺序、两处不同兼证引文和有界披露各自验收", () => {
  const ctx = context(input(), root({ secondarySyndromes: ["气虚证"] }));
  const reply = outline(ctx.input);
  reply.y += "{{q2}}、{{q5}}，这些所见合参为气虚证。";
  reply.g.push([["q2", "q5"], "推动乏力", "气虚证"]);
  assert.ok(validateRationalePair(reply, ctx).ok, JSON.stringify(validateRationalePair(reply, ctx)));
  const overlap = structuredClone(reply);
  overlap.q.q11 = overlap.q.q2;
  overlap.g[1][0] = ["q2", "q11"];
  assertRejected(overlap, ctx, "secondary_support");
  assert.equal(validateRationalePair(overlap, ctx, { revision: true }).softAccepted, true);
  assertRejected({ ...reply, g: reply.g.slice(0, 1) }, ctx, "secondary_support");
  assertRejected({ ...reply, y: "兼气虚证。" + reply.y }, ctx, "syndrome_name");
  const compactConclusion = { ...reply, y: reply.y.replace("合参属心血虚证", "主证为心血虚证兼气虚证") };
  assert.ok(validateRationalePair(compactConclusion, ctx).ok, JSON.stringify(validateRationalePair(compactConclusion, ctx)));
  assertRejected({ ...compactConclusion, y: compactConclusion.y + "气虚证为主证。" }, ctx, "syndrome_name");
  assertRejected({ ...reply, y: reply.y + "心血虚证尚待核实。" }, ctx, "syndrome_retracted");
  assertRejected({ ...reply, x: reply.x.replace("归于", "暂按") }, ctx, "disease_retracted");

  const selected = context(input({ tcmLineagePreference: "support-yang" }));
  const lens = outline(selected.input);
  assertRejected({ ...lens, l: null }, selected, "lineage_last");
  assertRejected({ ...lens, y: lens.y + lens.l }, selected, "lineage_embedded");
  assertRejected({ ...lens, l: lens.l.replace("扶阳", "温病") }, selected, "lineage_subject");
  assert.ok(validateRationalePair({ ...lens, l: lens.l.replace("扶阳学派看", "按扶阳思路，参看") }, selected).ok);
  assertRejected({ ...lens, l: lens.l.replace("辨其与所定证的相应处", "治当清热解毒") }, selected, "lineage_method");

  const ordinary = context();
  const valid = outline(ordinary.input);
  assertRejected({ ...valid, x: valid.x + "部位在右胸。" }, ordinary, "text_record_boundary");
  assertRejected({ ...valid, x: valid.x + "起病急。" }, ordinary, "text_record_boundary");
  assertRejected({ ...valid, y: valid.y + "另有重度乏力。" }, ordinary, "text_unquoted_finding");
  assertRejected({ ...valid, y: valid.y + "病历没有心悸。" }, ordinary, "text_record_boundary");
  assertRejected({ ...valid, y: valid.y + "本证之所见（）。" }, ordinary, "m04_carryover_drift");
  assert.ok(validateRationalePair({ ...valid, y: valid.y.replace("{{q5}}示", "{{q5}}，脉细弱，示") }, ordinary).ok);
});

await check("16", "本次起病与病程吻合，单列以前发作或否认仍不能引用", () => {
  const symptoms = { presentHistory: "两月前出现腹部隐痛，伴嗳气。曾有咳嗽。无腹泻，查体可见皮疹。无呕吐，黑便。否认胸痛、气短。不痒不痛。" };
  const current = context(input({ chiefComplaint: "腹痛2个月", symptoms }), root({ tcmDiseaseName: "腹痛" }));
  const quote = (ctx, text) => bindRationaleQuote(ctx, [qid(ctx, text), text]);
  assert.ok(quote(current, "伴嗳气"));
  assert.ok(quote(current, "查体可见皮疹"));
  for (const finding of ["曾有咳嗽", "黑便", "气短", "不痒不痛"]) assert.equal(quote(current, finding), undefined, finding);
  const anotherEpisode = context(input({ symptoms }));
  assert.equal(quote(anotherEpisode, "伴嗳气"), undefined);
  const unrelated = context(input({ chiefComplaint: "咳嗽2个月", symptoms }), root({ tcmDiseaseName: "咳嗽" }));
  assert.equal(quote(unrelated, "伴嗳气"), undefined);
  const hairLoss = (chiefComplaint) => context(input({ chiefComplaint, symptoms: { presentHistory: "十天前梳头发现耳后有小片脱发区，不痒不痛。" } }),
    root({ tcmDiseaseName: "油风" }));
  assert.ok(quote(hairLoss("耳后片状脱发十天"), "耳后有小片脱发区"));
  assert.equal(quote(hairLoss("耳后片状脱发十天"), "不痒不痛"), undefined);
  assert.equal(quote(hairLoss("耳后片状脱发三天"), "耳后有小片脱发区"), undefined);
  assert.ok(recordedRationaleSitePain(current, "腹部疼痛"));
  assert.equal(recordedRationaleSitePain(current, "腰部疼痛"), false);
  const deniedPain = context(input({ symptoms: { presentHistory: "否认胃脘隐痛。" } }));
  assert.equal(recordedRationaleSitePain(deniedPain, "胃脘疼痛"), false);

  const relief = (history) => context(input({ chiefComplaint: "腹痛2个月", symptoms: { presentHistory: history } }), root({ tcmDiseaseName: "腹痛" }));
  assert.ok(quote(relief("两月前出现腹痛，餐后加重，休息后稍缓解。"), "餐后加重"));
  assert.equal(quote(relief("两月前出现腹痛，餐后加重，现已完全缓解。"), "餐后加重"), undefined);
  const reporter = context(input({ symptoms: { presentHistory: "近三天睡眠颠倒、认不清亲属，母亲本人咳嗽。" } }));
  assert.ok(quote(reporter, "近三天睡眠颠倒、认不清亲属"));
  assert.equal(quote(reporter, "母亲本人咳嗽"), undefined);
  const witness = context(input({ symptoms: { presentHistory: "今早突然眼前发黑，没来得及站稳就跌倒，老伴说喊她不应，片刻后自行醒来。" } }));
  assert.ok(quote(witness, "喊她不应，片刻后自行醒来"));
});

await check("17", "首稿软拒退修，末稿软采纳并计码，硬拒仍回底稿", async () => {
  const state = input(), ctx = context(state);
  const propose = async (hardOnRetry) => {
    const events = [];
    let calls = 0;
    const author = createFinalRationaleAuthor({ state, scope: "test", mode: "on", signal: new AbortController().signal,
      deadline: () => Date.now() + 20_000, observe: (event) => events.push(event),
      transport: async (messages) => {
        const request = JSON.parse(messages[1].content);
        const draft = outline(request);
        draft.y += "所见由肝阴亏虚所致。";
        if (++calls === 2) {
          assert.ok(request.revise.some((reason) => reason.code === "foreign_element"));
          if (hardOnRetry) draft.y += "定稿证素不归入。";
        }
        return draft;
      } });
    const proposal = await author.propose(ctx.root);
    author.finish(proposal ? "new" : "old", Boolean(proposal));
    assert.equal(calls, 2);
    return { proposal, event: events[0] };
  };
  const soft = await propose(false);
  assert.ok(soft.proposal);
  assert.equal(soft.event.softAccepted, true);
  assert.ok(soft.event.softReasons.some((entry) => entry.code === "foreign_element" && !("phrase" in entry)));
  const hard = await propose(true);
  assert.equal(hard.proposal, undefined);
  assert.equal(hard.event.softAccepted, false);
});
await check("18", "服务端拼 u 和 l，保留已定结论，严格验流派独立段和引文", () => {
  const state = input({ tcmLineagePreference: "support-yang", symptoms: { presentHistory: "时有心悸。睡中易醒。偶有耳鸣。伴鼻塞。" } });
  const ctx = context(state);
  const draft = outline(ctx.input);
  draft.q.q11 = [qid(ctx, "偶有耳鸣"), "偶有耳鸣"];
  draft.q.q12 = [qid(ctx, "伴鼻塞"), "伴鼻塞"];
  draft.u = [[["q11", "q12"], "暂无解释"]];
  const accepted = validateRationalePair(draft, ctx);
  assert.ok(accepted.ok, JSON.stringify(accepted));
  assert.match(accepted.pair.tcmDiagnosticRationale, /另有偶有耳鸣、伴鼻塞，本证难以概括，是否另有兼夹尚待核实。扶阳学派/u);
  assertRejected({ ...draft, y: draft.y + "{{q11}}，定稿证素不归入。" }, ctx, "text_internal");
  assertRejected({ ...draft, y: draft.y + "{{q11}}，也是临床另有所见。" }, ctx, "text_internal");
  assertRejected({ ...draft, y: draft.y.replace("{{q5}}", "{{r3}}") }, ctx, "quote_line_number");
  assertRejected({ ...draft, l: "扶阳学派看本例时有心悸，仍应合参诸证。" }, ctx, "lineage_unquoted_finding");
  assertRejected({ ...draft, l: "扶阳学派看{{q99}}，仍应合参诸证。" }, ctx, "quote_reference");
  assertRejected({ ...draft, l: draft.l + "此处仍需结合所见。" }, ctx, "lineage_last");
  assertRejected({ ...draft, l: "扶阳学派看{{q2}}，心血虚证尚待核实。" }, ctx, "syndrome_retracted");
  assertRejected({ ...draft, l: "扶阳学派看{{q2}}，仍与定稿治法相合。" }, ctx, "text_internal");
  const incompatible = { ...ctx, input: { ...ctx.input, lineage: { ...ctx.input.lineage, adaptation: { applicable: "not-applicable" } } } };
  assertRejected(draft, incompatible, "lineage_applicability");
  const negative = { ...draft, l: "扶阳学派看{{q2}}，证据与此派眼目不合，故不宜用扶阳法。" };
  assert.ok(validateRationalePair(negative, incompatible).ok);
  const legacy = { ...draft, y: draft.y + "{{q11}}、{{q12}}难以归入定稿证素。" + draft.l };
  assert.deepEqual(validateRationalePair(legacy, ctx, { legacyLayout: true }), accepted);
  const rowId = draft.q.q11[0];
  const lineAside = `{{${rowId}}}，偶有耳鸣、伴鼻塞属证素范围外的表现。`;
  const rowLayout = { ...draft, y: draft.y + lineAside + draft.l, u: [[rowId, "偶有耳鸣、伴鼻塞属证素范围外的表现"]] };
  assert.deepEqual(validateRationalePair(rowLayout, ctx, { legacyLayout: true }), accepted);
  assertRejected(rowLayout, ctx, "quote_line_number");
  const misquoted = { ...rowLayout, u: [[rowId, "偶有耳鸣、伴腹痛属证素范围外的表现"]] };
  assert.equal(validateRationalePair(misquoted, ctx, { legacyLayout: true }).ok, false);
});
await check("19", "长引文截到唯一表现，重复摘同一处只交付一次", () => {
  const state = input({ symptoms: { presentHistory: "时有心悸，平时每天午饭后散步半个小时并在家中照顾家人，晚饭过后常与家人一起在公园走很久，睡中易醒。" } });
  const ctx = context(state);
  const long = "时有心悸，平时每天午饭后散步半个小时并在家中照顾家人，晚饭过后常与家人一起在公园走很久，睡中易醒";
  const line = qid(ctx, long);
  assert.equal(bindRationaleQuote(ctx, [line, long, "心悸"]).text, "时有心悸");
  assert.equal(bindRationaleQuote(ctx, [line, long, "腹痛"]), undefined);
  assert.equal(bindRationaleQuote(ctx, [line, long.replace("午饭", "早饭"), "心悸"]), undefined);
  const draft = outline(ctx.input);
  draft.q.q11 = draft.q.q5;
  const accepted = validateRationalePair({ ...draft, y: draft.y.replace("{{q5}}示", "{{q5}}，{{q11}}，脉细弱，示") }, ctx);
  assert.ok(accepted.ok, JSON.stringify(accepted));
  assert.equal(accepted.pair.tcmDiagnosticRationale.split("脉细弱").length, 2);
});

await check("20", "教材典型舌苔可作支持，确认相邻摘录只记软拒", () => {
  const wind = context(input({ tongue: "苔薄白", pulse: "脉浮紧" }),
    root({ tcmDiseaseName: "感冒", primarySyndrome: "风寒束表证" }));
  const typed = validateRationalePair(outline(wind.input), wind);
  assert.ok(!typed.reasons?.some(({ code, field }) => code === "inspection_normal" && field === "t"), JSON.stringify(typed));

  const state = input({ tongue: "", symptoms: { presentHistory: "时有心悸。睡中易醒。苔薄白，头晕。" } });
  const ctx = context(state);
  const row = ctx.lines.find(({ text }) => text.includes("苔薄白，头晕"));
  ctx.input.important.push({ line: row.id, term: "头晕", at: row.text.indexOf("头晕") });
  const draft = outline(ctx.input);
  const [id] = draft.t[1];
  draft.q[id] = [row.id, "苔薄白，头晕"];
  draft.y = draft.y.replace(draft.t[2], "平和而不具区分力");
  draft.t = ["n", [id], "平和"];
  assertRejected(draft, ctx, "inspection_adjacent_excerpt");
  const revised = validateRationalePair(draft, ctx, { revision: true });
  assert.ok(revised.ok && revised.softAccepted, JSON.stringify(revised));
});

console.log(JSON.stringify({ checks, failures }));
if (failures) process.exitCode = 1;
