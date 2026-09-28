// 提速第五批（2026-09-27）钉住的性质：
//  ① M04 → M05 预取：M04 签名完成时按 M05 将收到的病例形状预跑随访作文；随后真实调用 assess 路由，
//     无论是前端写回的形状还是外部接口直调的形状（处方正文带 JSON 块），作文模型全程只被调一次，
//     且 M05 输出里用的就是这份作文。预取与路由任何一步不同形 ⇒ 缓存未命中 ⇒ 这里调两次 ⇒ 红。
//  ② 请求体压缩：Content-Encoding: gzip / deflate 与未压缩逐字等价；未知编码 415；损坏/截断 400；
//     解压后超限与传输超限（无限个空 gzip 成员）都 413。
//  ③ 接线：M04 路由 tap 终稿触发 M05 预取；前端对大请求体 gzip，并在 415/400 时原样重发。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateSync, gzipSync } from "node:zlib";
import { createJiti } from "jiti";
import { buildAuditPositiveControlState } from "./lib/primary-care-audit-positive-controls.mjs";

Object.assign(process.env, {
  AI_TEXT_PROVIDER: "openai-compatible",
  OPENAI_API_KEY: "test-only-placeholder",
  OPENAI_BASE_URL: "https://api.deepseek.com",
  OPENAI_MODEL: "deepseek-flash",
  CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash",
  CDSS_CLINICAL_FACTS_BACKSTOP: "true",
  REASONING_CONTRACT_SIGNING_KEY: "m05-prefetch-offline-signing-key-at-least-32-characters",
});
delete process.env.M05_FOLLOWUP_AUTHORING;
delete process.env.CDSS_M05_PREFETCH;
for (const key of ["BAILIAN_QWEN_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY", "EVIMED_API_KEY", "EVIMED_GUIDE_API_KEY", "EVIMED_EVIDENCE_API_KEY"]) delete process.env[key];

const jiti = createJiti(import.meta.url, {
  alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` },
});
const failures = [];
const check = (name, fn) => { try { fn(); } catch (error) { failures.push({ name, message: error.message }); } };
const checkAsync = async (name, fn) => { try { await fn(); } catch (error) { failures.push({ name, message: error.message }); } };

// ── ① M04 → M05 预取 ─────────────────────────────────────────────────────────
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const signatures = await jiti.import("../src/lib/reasoning-contract-signature.ts");
const { maybeAttachClinicalFactsBackstop } = await jiti.import("../src/lib/clinical-facts-runtime.ts");
const { buildAcceptedPrescriptionMarkdown } = await jiti.import("../src/lib/followup-display-state.ts");
const { diagnoseReasoningFromState, extractDiagnosisJSON, mergeReasoningStages, stripDiagnosisJSON } = await jiti.import("../src/lib/diagnosis-parse.ts");
const { applyDeterministicFollowUpNode } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const diagnosisSafety = await jiti.import("../src/lib/diagnosis-safety.ts");
const { deriveSafetyLocked, withSafetyGate } = diagnosisSafety;
const localChecks = await jiti.import("../src/lib/local-prescription-checks.ts");
const { resetAuthoredFollowupCache } = await jiti.import("../src/lib/m05-followup-authoring.server.ts");
const { prefetchAssessFollowupFromDraftCandidate, prefetchAssessFollowupFromSignedPrescribe } = await jiti.import("../src/lib/stage-prefetch.server.ts");
const { completedM04ProposalCandidate } = await jiti.import("../src/lib/diagnosis-stream-module-drafts.ts");
const { POST: assess } = await jiti.import("../src/app/api/diagnosis/assess/route.ts");

const AUTHORED_LIFESTYLE = "饮食宜清淡易消化，忌生冷油腻；作息规律，避免劳累，保持情志舒畅，适度散步以助运化。";
const authoredReply = {
  // 2026-09-28 起随访写给患者本人：「复评」等内部流程词会被作文校验拒收，桩回复按患者口吻写。
  reviewFocus: "复诊时医生会重点了解乏力和胃口的变化、大便是否成形，并查看舌象和脉象；请您服药期间留意这些变化。",
  efficacyCriteria: "乏力减轻、饭量恢复、大便成形且次数减少，说明治疗有效。",
  lifestyle: AUTHORED_LIFESTYLE,
  dimensions: ["饮食", "睡眠", "情志"],
  monitoringIndicators: ["乏力程度", "食欲与食量", "大便性状"],
  timeline: [],
};

const PLAIN_HERBS = [{ name: "黄芪", dose: "15g" }, { name: "茯苓", dose: "12g" }, { name: "白术", dose: "12g" }];
// 十八反：本地配伍预检段非空 ⇒ hasStrongPrescriptionRisk ⇒ 首次复诊时间改写——预取必须同样算出这一段。
const INCOMPATIBLE_HERBS = [{ name: "甘草", dose: "6g" }, { name: "海藻", dose: "10g" }, { name: "茯苓", dose: "12g" }];

async function signedM04Case(herbs = PLAIN_HERBS) {
  const control = { id: `m05-prefetch-${herbs.length}-${herbs[0].name}`, patient: { sex: "男", age: 46 }, chiefComplaint: "乏力纳差两月", diagnosis: "功能性消化不良", syndrome: "脾虚湿困证",
    pastHistory: "否认重要慢病", allergyHistory: "否认药物过敏", medicationHistory: "否认当前用药",
    herbs };
  const state = normalizeCaseStateInput({ ...buildAuditPositiveControlState(control), customerId: "test-hospital", phase: "prescribe",
    vitals: { T: "36.5", P: "75", R: "18", BP: "120/80", SpO2: "99%" } });
  const m03 = { ...structuredClone(state.reasoningPrescribe), stage: "diagnose", formula: null, nonPharma: null, clinicalReview: undefined,
    overview: { ...state.reasoningPrescribe.overview, recommendedFormulaNames: [], formulaSelectionMode: "self_devised" } };
  state.reasoningDiagnose = signatures.signDiagnoseReasoning(m03, signatures.buildDiagnoseContractSignatureContext(state));
  // 首次复诊时间与线上同源：服务端总是用 applyDeterministicFollowUpNode 按剂数重写 followUpNode
  //（回归夹具原写的「3日后复核」线上不会出现，签名前先按服务端口径归一）。
  const m04Unsigned = extractDiagnosisJSON(applyDeterministicFollowUpNode(
    `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(state.reasoningPrescribe)}\n<!-- DIAGNOSIS_JSON_END -->`));
  // M04 请求：客户端只带 M03 交接，不带处方。
  const requestState = await maybeAttachClinicalFactsBackstop(
    { ...state, prescription: "", reasoningPrescribe: undefined, reasoningV2: state.reasoningDiagnose },
    async () => JSON.stringify({ redFlags: [] }),
  );
  const signedM04 = signatures.signPrescribeReasoning(m04Unsigned, signatures.buildPrescribeContractSignatureContext(requestState));
  const markdown = buildAcceptedPrescriptionMarkdown(signedM04, 0);
  const finalContent = `${markdown}\n\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(signedM04)}\n<!-- DIAGNOSIS_JSON_END -->`;
  return { requestState, signedM04, finalContent };
}

function frontendM05State({ requestState, signedM04, finalContent }) {
  // 与 DiagnosisClient M04 完成后写回的状态同形。
  const current = withSafetyGate({
    ...requestState,
    prescription: stripDiagnosisJSON(finalContent).replace(/\[TRUNCATED\]/g, "").trim(),
    reasoningPrescribe: signedM04,
    reasoningV2: mergeReasoningStages(diagnoseReasoningFromState(requestState), signedM04) || requestState.reasoningV2,
    riskAssessment: undefined,
    followupTimeline: undefined,
    safetyLocked: false,
    phase: "assess",
  });
  return { ...current, safetyLocked: deriveSafetyLocked(current) };
}

function apiCallerM05State({ requestState, signedM04, finalContent }) {
  // 外部接口直调：处方正文原样回传（含 JSON 块），不带 reasoningV2/safetyLocked。
  return { ...requestState, phase: "assess", prescription: finalContent, reasoningPrescribe: signedM04 };
}

async function withCountingModel(fn) {
  const original = globalThis.fetch;
  const calls = { authoring: 0, other: 0 };
  globalThis.fetch = async (input, init) => {
    const text = typeof init?.body === "string" ? init.body : "";
    if (text.includes("随访方案的撰写者")) {
      calls.authoring += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "deepseek-flash",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(authoredReply) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { "content-type": "application/json" } });
    }
    calls.other += 1;
    throw new Error(`unexpected upstream call: ${String(input)}`);
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

async function assessMarkdown(caseState) {
  const response = await assess(new Request("http://localhost/api/diagnosis/assess", {
    method: "POST", headers: { "content-type": "application/json", "x-cdss-customer-id": "test-hospital" }, body: JSON.stringify({ caseState }),
  }));
  const raw = await response.text();
  assert.equal(response.status, 200, raw.slice(0, 400));
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((frame) => typeof frame.content === "string" ? frame.content : "").join("");
}

const fixture = await signedM04Case();
const incompatibleFixture = await signedM04Case(INCOMPATIBLE_HERBS);
check("the incompatible fixture really exercises the local risk section", () => {
  const { hasStrongPrescriptionRisk } = diagnosisSafety;
  const { buildLocalHighRiskHerbPairSection } = localChecks;
  const gated = withSafetyGate(frontendM05State(incompatibleFixture));
  const section = buildLocalHighRiskHerbPairSection(gated, 0);
  assert.match(section, /海藻|十八反/, "fixture must produce a local incompatibility section");
  assert.equal(hasStrongPrescriptionRisk({ ...gated, riskAssessment: section }), true);
});
for (const [fixtureLabel, currentFixture] of [["plain", fixture], ["十八反", incompatibleFixture]]) {
  for (const [label, shape] of [["frontend", frontendM05State], ["api-caller", apiCallerM05State]]) {
    await checkAsync(`M04→M05 prefetch is consumed by the ${label} M05 request, ${fixtureLabel} (one authoring call in total)`, async () => withCountingModel(async (calls) => {
      resetAuthoredFollowupCache();
      await prefetchAssessFollowupFromSignedPrescribe(currentFixture.requestState, currentFixture.finalContent);
      assert.equal(calls.authoring, 1, "prefetch must author the follow-up once");
      const markdown = await assessMarkdown(shape(currentFixture));
      assert.equal(calls.authoring, 1, `the ${label} M05 request must hit the prefetched authoring (prefetch and route inputs diverged)`);
      assert.equal(calls.other, 0, "no other upstream call is expected (facts come from the attested cache)");
      assert.ok(markdown.includes(AUTHORED_LIFESTYLE), "M05 output must use the prefetched authored follow-up");
    }));
  }
}
await checkAsync("without the prefetch, M05 authors on its own (the counter is not trivially 1)", async () => withCountingModel(async (calls) => {
  resetAuthoredFollowupCache();
  await assessMarkdown(frontendM05State(fixture));
  assert.equal(calls.authoring, 1);
  resetAuthoredFollowupCache();
  await assessMarkdown(frontendM05State(fixture));
  assert.equal(calls.authoring, 2, "a cold cache must call the model again");
}));
await checkAsync("prefetch is skipped for unsigned/non-dose M04 content and by the kill switch", async () => withCountingModel(async (calls) => {
  resetAuthoredFollowupCache();
  await prefetchAssessFollowupFromSignedPrescribe(fixture.requestState, stripDiagnosisJSON(fixture.finalContent));
  const unsigned = { ...fixture.signedM04, contractSignature: undefined };
  await prefetchAssessFollowupFromSignedPrescribe(fixture.requestState,
    `${stripDiagnosisJSON(fixture.finalContent)}\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(unsigned)}\n<!-- DIAGNOSIS_JSON_END -->`);
  process.env.CDSS_M05_PREFETCH = "false";
  await prefetchAssessFollowupFromSignedPrescribe(fixture.requestState, fixture.finalContent);
  delete process.env.CDSS_M05_PREFETCH;
  assert.equal(calls.authoring, 0);
}));

// ── ①b M04 首轮流候选方闭合 → M05 作文预热（2026-09-28）──────────────────────
// 首轮 JSON 里 candidate 在全文约一半处闭合；那一刻的药味与剂数就是终稿的（未修复时本机 24/26 逐字相同）。
function draftCandidateFrom(signedM04, overrides = {}) {
  const candidate = signedM04.formula.candidates[0];
  return {
    name: candidate.name,
    herbs: candidate.herbs.map((herb) => ({ name: herb.name, dose: herb.dose, role: herb.role, function: herb.function })),
    decoction: { doseCount: candidate.decoction.doseCount, dosesPerDay: candidate.decoction.dosesPerDay, administrationTimesPerDay: candidate.decoction.administrationTimesPerDay },
    ...overrides,
  };
}
check("the draft extractor returns the candidate only once it has closed in the stream", () => {
  const candidate = draftCandidateFrom(fixture.signedM04);
  const full = JSON.stringify({ candidate, patentAndWestern: [], modifications: [], nonPharma: { diet: "清淡" } });
  const closeAt = full.indexOf(',"patentAndWestern"');
  assert.equal(completedM04ProposalCandidate(full.slice(0, closeAt - 3)), undefined, "an open candidate is not reported");
  assert.deepEqual(completedM04ProposalCandidate(full.slice(0, closeAt + 5))?.herbs.map((herb) => herb.name), candidate.herbs.map((herb) => herb.name));
});
for (const [fixtureLabel, currentFixture] of [["plain", fixture], ["十八反", incompatibleFixture]]) {
  for (const [label, shape] of [["frontend", frontendM05State], ["api-caller", apiCallerM05State]]) {
    await checkAsync(`M04 draft candidate prefetch is consumed by the ${label} M05 request, ${fixtureLabel} (one authoring call in total)`, async () => withCountingModel(async (calls) => {
      resetAuthoredFollowupCache();
      await prefetchAssessFollowupFromDraftCandidate(currentFixture.requestState, draftCandidateFrom(currentFixture.signedM04));
      assert.equal(calls.authoring, 1, "the draft prefetch must author once");
      await prefetchAssessFollowupFromSignedPrescribe(currentFixture.requestState, currentFixture.finalContent);
      assert.equal(calls.authoring, 1, "the signed prefetch at M04 end must reuse the draft's authoring (same model input)");
      const markdown = await assessMarkdown(shape(currentFixture));
      assert.equal(calls.authoring, 1, `the ${label} M05 request must hit the draft-prefetched authoring`);
      assert.ok(markdown.includes(AUTHORED_LIFESTYLE));
    }));
  }
}
// 本机 65 例：预取落空 21 例里 16 例只差药名规范化（炒白扁豆→白扁豆、黄连片→黄连、山栀→栀子），
// 草稿必须先过终稿编译的同一段归一，否则作文缓存键对不上。
await checkAsync("a draft written with processed/alias herb names still hits: it is normalized like the final M04", async () => withCountingModel(async (calls) => {
  resetAuthoredFollowupCache();
  const spelled = draftCandidateFrom(fixture.signedM04);
  const variants = { 黄芪: "蜜炙黄芪", 茯苓: "云苓", 白术: "麸炒白术" };
  spelled.herbs = spelled.herbs.map((herb) => ({ ...herb, name: variants[herb.name] || herb.name }));
  assert.ok(spelled.herbs.some((herb) => Object.values(variants).includes(herb.name)), "the fixture must actually carry a variant spelling");
  await prefetchAssessFollowupFromDraftCandidate(fixture.requestState, spelled);
  assert.equal(calls.authoring, 1);
  await assessMarkdown(frontendM05State(fixture));
  assert.equal(calls.authoring, 1, "the M05 request must hit the draft-prefetched authoring despite the raw spelling");
}));
await checkAsync("a draft that the final M04 changed is a harmless miss: M05 authors for the final herbs", async () => withCountingModel(async (calls) => {
  resetAuthoredFollowupCache();
  const drifted = draftCandidateFrom(fixture.signedM04);
  drifted.herbs = [...drifted.herbs, { name: "陈皮", dose: "6g", role: "佐", function: "理气健脾" }];
  await prefetchAssessFollowupFromDraftCandidate(fixture.requestState, drifted);
  assert.equal(calls.authoring, 1);
  const markdown = await assessMarkdown(frontendM05State(fixture));
  assert.equal(calls.authoring, 2, "a different herb list is a different model input, so M05 authors again");
  assert.ok(markdown.includes(AUTHORED_LIFESTYLE));
}));
await checkAsync("the draft prefetch honours both kill switches and needs a signed M03", async () => withCountingModel(async (calls) => {
  resetAuthoredFollowupCache();
  process.env.CDSS_M05_DRAFT_PREFETCH = "false";
  await prefetchAssessFollowupFromDraftCandidate(fixture.requestState, draftCandidateFrom(fixture.signedM04));
  delete process.env.CDSS_M05_DRAFT_PREFETCH;
  process.env.CDSS_M05_PREFETCH = "false";
  await prefetchAssessFollowupFromDraftCandidate(fixture.requestState, draftCandidateFrom(fixture.signedM04));
  delete process.env.CDSS_M05_PREFETCH;
  await prefetchAssessFollowupFromDraftCandidate({ ...fixture.requestState, reasoningDiagnose: undefined, reasoningV2: undefined }, draftCandidateFrom(fixture.signedM04));
  assert.equal(calls.authoring, 0);
}));
check("the prescribe route wires the draft callback and the stream fires it once, on the first pass only", () => {
  const prescribe = readFileSync(new URL("../src/app/api/diagnosis/prescribe/route.ts", import.meta.url), "utf8");
  assert.match(prescribe, /onInitialM04Candidate: \(candidate\) => \{\s*void prefetchAssessFollowupFromDraftCandidate\(parsed\.caseState, candidate\);/);
  const api = readFileSync(new URL("../src/lib/diagnosis-api.ts", import.meta.url), "utf8");
  assert.match(api, /opts\.onInitialM04Candidate && !initialM04CandidateReported && structuredRetryCount === 0/);
});

// ── ② 请求体压缩 ─────────────────────────────────────────────────────────────
const { readJsonBodyWithLimit } = await jiti.import("../src/lib/http-guard.ts");
const LIMIT = 64 * 1024;
const json = JSON.stringify({ caseState: { note: "脾虚湿困".repeat(2000) } });
const bodyRequest = (bytes, encoding, streamed = false) => new Request("http://localhost/", {
  method: "POST",
  headers: encoding ? { "content-encoding": encoding } : {},
  body: streamed ? new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) : bytes,
  ...(streamed ? { duplex: "half" } : {}),
});
const read = (request) => readJsonBodyWithLimit(request, LIMIT);
await checkAsync("gzip and deflate bodies parse to the same JSON as an uncompressed body", async () => {
  const plain = await read(bodyRequest(Buffer.from(json)));
  assert.equal(plain.ok, true);
  for (const [encoding, bytes] of [["gzip", gzipSync(json)], [" GZIP ", gzipSync(json)], ["deflate", deflateSync(json)], ["identity", Buffer.from(json)]]) {
    const result = await read(bodyRequest(bytes, encoding));
    assert.equal(result.ok, true, `${encoding} must parse`);
    assert.deepEqual(result.body, plain.body, `${encoding} must be byte-equivalent after decoding`);
  }
});
await checkAsync("unknown encodings, corrupt and oversized compressed bodies are rejected", async () => {
  const status = async (request) => { const result = await read(request); return result.ok ? 200 : result.response.status; };
  assert.equal(await status(bodyRequest(Buffer.from(json), "br")), 415);
  assert.equal(await status(bodyRequest(Buffer.from("not gzip"), "gzip")), 400);
  const gz = gzipSync(json);
  assert.equal(await status(bodyRequest(gz.subarray(0, gz.length - 20), "gzip")), 400, "a truncated stream is not a valid body");
  assert.equal(await status(bodyRequest(gzipSync("{broken"), "gzip")), 400);
  assert.equal(await status(bodyRequest(gzipSync(Buffer.alloc(10 * 1024 * 1024, 32)), "gzip", true)), 413, "decompressed size is capped");
  const emptyMember = gzipSync(Buffer.alloc(0));
  assert.equal(await status(bodyRequest(Buffer.concat(Array.from({ length: 4000 }, () => emptyMember)), "gzip", true)), 413,
    "transferred size is capped even when the decompressed body stays tiny");
});

// ── ③ 接线 ───────────────────────────────────────────────────────────────────
check("M04 route taps its final stream for the M05 prefetch", () => {
  const prescribe = readFileSync("src/app/api/diagnosis/prescribe/route.ts", "utf8");
  assert.match(prescribe, /const response = await callDiagnosisStream\(prompt, "deepseek"/);
  assert.match(prescribe, /return tapFinalStageContent\(response, \(finalContent\) => \{\s*void prefetchAssessFollowupFromSignedPrescribe\(parsed\.caseState, finalContent\);/);
});
check("frontend gzips large stage request bodies and falls back to the plain body", () => {
  const client = readFileSync("src/app/diagnosis/DiagnosisClient.tsx", "utf8");
  const fetchHelper = client.slice(client.indexOf("async function fetchWithTimeout("), client.indexOf("async function fetchJsonWithTimeout<"));
  assert.ok(fetchHelper.length > 0 && fetchHelper.length < 2500, `fetchWithTimeout slice out of bounds (${fetchHelper.length})`);
  assert.match(fetchHelper, /await gzipRequestInit\(init\)/);
  assert.match(fetchHelper, /response\.status !== 415 && response\.status !== 400/);
  assert.match(fetchHelper, /await fetch\(input, \{ \.\.\.init, signal: controller\.signal \}\)/, "fallback must resend the original body");
  assert.match(client, /headers\.set\("Content-Encoding", "gzip"\)/);
});

// 2026-09-28 甲方：随访写进病历、交给患者。模型写出病历状态句或内部流程词时整段拒收、回落模板；
// 急症表现逐条校验，混进来的记录状态句只丢那一条。
await checkAsync("M05 authoring rejects record-status / clinician-workflow wording and keeps valid urgent signs", async () => {
  const { authorFollowupClinicalContent } = await jiti.import("../src/lib/m05-followup-authoring.server.ts");
  const original = globalThis.fetch;
  const replyWith = (content) => async () => new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "deepseek-flash",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { "content-type": "application/json" } });
  const state = normalizeCaseStateInput({ id: "m05-patient-voice", chiefComplaint: "咳嗽5天", patient: { sex: "男", age: 30 } });
  const input = { syndrome: "风寒束肺证", herbs: ["麻黄", "杏仁"] };
  try {
    for (const reviewFocus of [
      "病历已记录咳嗽阳性；病历已记录否认发热，复诊时再看。",
      "重点复评咳嗽的消长与舌脉变化，据此决定是否调整候选方案。",
    ]) {
      resetAuthoredFollowupCache();
      globalThis.fetch = replyWith({ ...authoredReply, reviewFocus });
      assert.equal(await authorFollowupClinicalContent(state, input), null, `应整段拒收：${reviewFocus}`);
    }
    resetAuthoredFollowupCache();
    globalThis.fetch = replyWith({ ...authoredReply, urgentSigns: ["高热不退", "气喘明显", "病历尚未确认咯血是否存在"] });
    const authored = await authorFollowupClinicalContent(state, input);
    assert.ok(authored, "患者口吻的回复应被采纳");
    assert.deepEqual(authored.urgentSigns, ["高热不退", "气喘明显"]);
  } finally {
    globalThis.fetch = original;
    resetAuthoredFollowupCache();
  }
});

console.log(JSON.stringify({ suite: "m05-prefetch-request-compression", failures }, null, 1));
if (failures.length) process.exit(1);
