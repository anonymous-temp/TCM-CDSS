import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";

globalThis.fetch = async () => { throw new Error("latency fixture is offline"); };
const jiti = createJiti(import.meta.url, { alias: {
  "@": process.cwd() + "/src", "server-only": process.cwd() + "/node_modules/next/dist/compiled/server-only/empty.js",
} });
const { completeTcmOverview } = await jiti.import("../src/lib/stage-finalize-schedule.ts");
const { prepareParallelM04Candidate } = await jiti.import("../src/lib/m04-final-delivery.server.ts");
const { withModificationsFrom } = await jiti.import("../src/lib/m04-modification-fit.server.ts");
const { finalizeM04Content } = await jiti.import("../src/lib/m04-final-content.server.ts");
const { scheduledTreatmentCardReview, prescriptionReviewCacheSuffix } = await jiti.import("../src/lib/m04-final-content-policy.ts");
const { selectFinalHerbFunctions } = await jiti.import("../src/lib/final-consistency-review.server.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const fixture = JSON.parse(readFileSync(new URL("./fixtures/r1064-m04/synthetic.json", import.meta.url)));
const state = normalizeCaseStateInput({ chiefComplaint: fixture.chiefComplaint, patient: { age: 45, sex: "男" }, symptoms: { 现病史: fixture.record } });
const prior = { stage: "diagnose", overview: { tcmDiseaseName: "眩晕", primarySyndrome: "痰湿中阻证", tcmDiagnosticRationale: "原依据" }, therapy: { overallMethod: "化痰祛湿" } };
const rx = { stage: "prescribe", overview: prior.overview, therapy: prior.therapy,
  formula: { candidates: ["A", "B"].map(id => ({ id, name: "自拟方", constructionType: "self_devised", formulaAnalysis: id,
    herbs: fixture.herbs.map((name, i) => ({ name, dose: "9g", role: i ? "臣" : "君", function: "", targetRef: "P1" })) })),
    modifications: [], patentAndWestern: [{ name: "既有" }] }, nonPharma: { precautions: [] } };
const start = "<!-- DIAGNOSIS_JSON_START -->", end = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = value => "开头" + start + "\n" + JSON.stringify(value, null, 2) + "\n" + end + "结尾";
const edit = (text, update) => {
  const value = JSON.parse(text.slice(text.indexOf(start) + start.length, text.indexOf(end)));
  update(value);
  return wrap(value);
};
const timed = async task => {
  const begin = performance.now(), value = await task();
  return { ms: performance.now() - begin, value };
};
const compare = (label, serial, parallel) => {
  assert.deepEqual(parallel.value, serial.value, label + " complete payload");
  assert.ok(serial.ms - parallel.ms > 80, label + " overlap " + JSON.stringify([serial.ms, parallel.ms]));
  console.log(label, Math.round(serial.ms), Math.round(parallel.ms), "ms");
};
const check = async (id, test) => {
  if (!process.env.LATENCY_CHECK || process.env.LATENCY_CHECK === id) await test();
};

await check("overview", async () => {
  const run = async parallel => {
    process.env.CDSS_STAGE_PARALLEL_FINALIZE = String(parallel);
    const write = (key, value) => async content => {
      await delay(230);
      const root = JSON.parse(content);
      root.overview[key] = value;
      return JSON.stringify(root);
    };
    return completeTcmOverview(JSON.stringify(prior), write("tcmDiagnosticRationale", "依据补全"), write("tcmDifferentials", ["鉴别"]));
  };
  compare("M03", await timed(() => run(false)), await timed(() => run(true)));
});
await check("collision", async () => {
  delete process.env.CDSS_STAGE_PARALLEL_FINALIZE;
  const append = suffix => async text => {
    const root = JSON.parse(text);
    root.overview.tcmDiagnosticRationale += suffix;
    return JSON.stringify(root);
  };
  const result = await completeTcmOverview(JSON.stringify(prior), append("甲"), append("乙"));
  assert.equal(JSON.parse(result).overview.tcmDiagnosticRationale, "原依据甲乙");
});
await check("topup", async () => {
  const content = wrap(rx);
  const analysis = async () => { await delay(250); return edit(content, r => { r.formula.candidates[0].formulaAnalysis = "核定"; }); };
  const fit = async () => edit(content, r => { r.formula.modifications = [{ trigger: "胸闷" }]; });
  const topUp = async draft => {
    await delay(230);
    return edit(draft, r => { r.formula.modifications.push({ trigger: "恶心" }); r.formula.patentAndWestern = []; r.nonPharma.precautions.push("保留慎用说明"); });
  };
  const serial = await timed(async () => {
    const [checked, fitted] = await Promise.all([analysis(), fit()]);
    return topUp(withModificationsFrom(checked, fitted));
  });
  const parallel = await timed(() => prepareParallelM04Candidate(content, { checkAnalysis: analysis, fit, topUp, author: async () => undefined }));
  compare("M04 top-up", serial, parallel);
});
await check("candidate", async () => {
  const run = async parallel => {
    const payloads = [];
    const result = await finalizeM04Content(rx, { caseState: state, prior, record: fixture.record,
      env: { CDSS_M04_FINAL_ANALYSIS: "on", CDSS_STAGE_PARALLEL_FINALIZE: String(parallel) } }, {
      call: async (_task, payload) => { payloads.push(payload); await delay(250); return { fingerprint: payload.snapshot.fingerprint, sentences: [] }; },
    });
    return { result, payloads };
  };
  await run(true); // Warm textbook indexes before timing either arm.
  compare("M04 candidates", await timed(() => run(false)), await timed(() => run(true)));
});
await check("switches", async () => {
  for (const flag of ["CDSS_M04_FUNCTION_CHOICE", "CDSS_TREATMENT_CARD_REVIEW"]) {
    let calls = 0;
    const ask = async () => { calls++; };
    const run = flag === "CDSS_M04_FUNCTION_CHOICE" ? () => selectFinalHerbFunctions(rx, {}, undefined, ask) : () => scheduledTreatmentCardReview(ask);
    delete process.env[flag];
    const enabledVersion = prescriptionReviewCacheSuffix();
    await run();
    const beforeDisable = calls;
    process.env[flag] = "false";
    const disabled = await run();
    assert.deepEqual([beforeDisable, calls - beforeDisable, disabled, enabledVersion === prescriptionReviewCacheSuffix()],
      [1, 0, flag === "CDSS_M04_FUNCTION_CHOICE" ? new Map() : undefined, false], flag);
    delete process.env[flag];
  }
});
await check("delivery", async () => {
  // Reuse the suites' offline HTTP transports and real signature/terminal entry
  // points. Their case filters skip unrelated assertions during fixture import.
  process.env.R1067_ONLY = "fixture-only";
  const m03 = await import("./test-r1067-rationale.mjs");
  const paired = async run => {
    process.env.CDSS_STAGE_PARALLEL_FINALIZE = "false";
    const serial = await run();
    delete process.env.CDSS_STAGE_PARALLEL_FINALIZE;
    assert.deepEqual(await run(), serial, "signed delivery and request payloads");
  };
  await paired(async () => {
    const { content, calls, claimRequests } = await m03.wire({ parallel: true, route: true });
    return { content, calls, claimRequests: claimRequests.map(request => JSON.stringify(request)).sort() };
  });
  process.env.M04WIRE_CHECK = "fixture-only";
  const m04 = await import("./test-r1064-m04wire.mjs");
  await paired(async () => {
    const { text, requests } = await m04.wire();
    return { text, requests: requests.map(body => JSON.stringify(body)).sort() };
  });
});
await check("rx-collision", async () => {
  const content = wrap(rx);
  const checked = edit(content, r => { r.formula.candidates[0].formulaAnalysis += "甲"; });
  const revise = async draft => edit(draft, r => { r.formula.candidates[0].formulaAnalysis += "乙"; });
  const composed = await prepareParallelM04Candidate(content, {
    checkAnalysis: async () => checked, author: async () => undefined, fit: async () => content, topUp: revise,
  });
  assert.equal(composed, await revise(checked), "if both edit analysis, top-up reads the checked paragraph");
});
