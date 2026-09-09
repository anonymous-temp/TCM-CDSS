import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

// Entirely synthetic traffic; never read runtime credentials or contact a provider.
Object.assign(process.env, {
  AI_TEXT_PROVIDER: "bailian-qwen", BAILIAN_QWEN_API_KEY: "test-only",
  BAILIAN_QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  BAILIAN_QWEN_MODEL: "qwen3.7-plus", PRIMARY_PRESCRIBE_MODEL: "qwen3.7-plus",
  PRIMARY_PRESCRIBE_REPAIR_MODEL: "qwen3.8-max", STRUCTURED_QUALITY_REPAIR_ROUNDS: "0",
  M04_ORCHESTRATION_DEADLINE_MS: "60000", REASONING_CONTRACT_SIGNING_KEY: "synthetic-signing-key-at-least-32-characters",
});
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { callDiagnosisStream } = await jiti.import("../src/lib/diagnosis-api.ts");
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");
const { canAcceptTransparentFormulaFallback } = await jiti.import("../src/lib/m04-repair-policy.ts");
const { retainM04DeliveryCheckpoint, bindM04DeliveryReview, preferM04DeliveryCheckpoint, renderM04DeliveryCheckpoint } = await jiti.import("../src/lib/m04-delivery-checkpoint.ts");
const { compileM04Proposal } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const { clinicalReviewPayloadHash, hasBoundClinicalReviewAttestation } = await jiti.import("../src/lib/clinical-review-binding.ts");
const { applyPrescribeContractSignature } = await jiti.import("../src/lib/reasoning-contract-signature.ts");
const { isNonDosePrescriptionText } = await jiti.import("../src/lib/diagnosis-safety.ts");
const prior = ReasoningV2Schema.parse({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { primarySyndrome: "脾胃虚弱证", overallPathogenesis: "脾胃虚弱，运化无力", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [
    { nodeId: "P1", patientFact: "食少倦怠", syndromeEvidence: "食少倦怠", pathogenesis: "脾胃虚弱，运化无力", therapyDirection: "健脾益气" },
    { nodeId: "P2", patientFact: "大便溏薄", syndromeEvidence: "大便溏薄", pathogenesis: "脾虚湿盛", therapyDirection: "健脾化湿" },
  ] },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "健脾益气，化湿和中", subTherapies: [{ therapy: "健脾益气", targetPathogenesis: "脾胃虚弱", priority: "主要" }] },
  formula: { candidates: [], patentAndWestern: [], modifications: [] },
});
const proposal = {
  candidate: { name: "本例辨证组方", applicable: "食少倦怠与便溏并见。", notApplicable: "便溏加重或出现腹痛时评估。",
    herbs: [
      { name: "党参", dose: "12g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "补脾益气，改善食少倦怠" },
      { name: "白术", dose: "10g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾燥湿，兼顾便溏" },
      { name: "茯苓", dose: "12g", role: "佐", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾渗湿" },
      { name: "炙甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "补脾和胃" },
    ].map((herb) => ({ ...herb, processing: null, isToxic: false, decoctionRequirement: null })),
    formulaAnalysis: "党参补脾益气以改善食少倦怠，白术燥湿、茯苓渗湿兼顾便溏，炙甘草补脾和胃。",
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，煎服", followUpNode: "5日复诊" },
  }, patentAndWestern: [], modifications: [],
  nonPharma: { diet: "早餐可用山药小米粥，少量多餐。", lifestyle: "规律作息。", emotion: "调畅情志。", precautions: ["观察食欲与便溏变化。"], tcmTreatments: [] },
};
const encoder = new TextEncoder();
const sse = (value) => new Response(new ReadableStream({ start(controller) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
  controller.close();
} }), { headers: { "content-type": "text/event-stream" } });
const accepted = { status: "accepted", issueCode: "none", repairFocus: "none" };
const completion = (value) => Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }] });
const signatureContext = { contractVersion: "tcm-cdss-m04-signature-v3", caseId: "synthetic", encounterId: "synthetic",
  clinicalInputHash: `sha256:${"a".repeat(64)}`, diagnoseContractHash: `sha256:${"b".repeat(64)}` };
async function runWire({ first = proposal, reviewer = accepted, remainingMs = 2000, abortAfterReview = false,
  priorReasoning = prior, respond, outputTransform } = {}) {
  const originalFetch = globalThis.fetch;
  const abort = new AbortController();
  const requests = [];
  let lateResolve;
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (requests.length === 1) return sse(first);
      assert.ok(requests.length < 9, "automatic calls must remain bounded");
      if (abortAfterReview) queueMicrotask(() => abort.abort());
      const next = respond ? respond(requests.length, body) : reviewer;
      if (next === "stall") return new Promise((resolve) => { lateResolve = () => resolve(completion(accepted)); });
      return completion(next);
    };
    const response = await callDiagnosisStream("synthetic continuity fixture", "deepseek", undefined, "markdown", {
      structuredStage: "prescribe", structuredPriorReasoning: priorReasoning,
      structuredClinicalContext: "成人；食少倦怠；大便溏薄", requestSignal: abort.signal,
      structuredOrchestrationStartedAt: Date.now() - 60000 + remainingMs,
      truncateFallback: "GENERIC_KB_FALLBACK", deadlineFallback: "GENERIC_DEADLINE_FALLBACK",
      prescribeSignatureContext: signatureContext,
      outputTransform,
    });
    const wire = await response.text();
    const frames = wire.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const finals = frames.filter((frame) => frame.content?.startsWith("<<<CDSS_STREAM_FINAL>>>"));
    lateResolve?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { frames, finals, requests, content: finals.at(-1)?.content || "" };
  } finally { lateResolve?.(); abort.abort(); globalThis.fetch = originalFetch; }
}
function assertNonDose(content) {
  assert.ok(isNonDosePrescriptionText(content), "client must recognize and retain the non-dose result");
  assert.doesNotMatch(content, /DIAGNOSIS_JSON_START|contractSignature|12g|10g|6g|5剂|GENERIC_|重新生成|请重试/);
}
function withDietQualityFinding(content) {
  const start = content.indexOf("<!-- DIAGNOSIS_JSON_START -->");
  const end = content.indexOf("<!-- DIAGNOSIS_JSON_END -->");
  if (start < 0 || end < 0) return content;
  const reasoning = JSON.parse(content.slice(start + "<!-- DIAGNOSIS_JSON_START -->".length, end));
  reasoning.nonPharma.diet = "清淡饮食";
  return `${content.slice(0, start)}${wrap(reasoning)}`;
}

test("explicit zero quality budget qualifies the same safe candidate for identity declassification", () => {
  const input = { completedRepairAttempts: 0, qualityRepairExhaustedForCandidate: true,
    strictFormulaIssue: "formula_reference_declassified", requestAborted: false };
  assert.equal(canAcceptTransparentFormulaFallback(input), true);
  assert.equal(canAcceptTransparentFormulaFallback({ ...input, therapyIssue: "herb_0_dose" }), false);
  assert.equal(canAcceptTransparentFormulaFallback({ ...input, requestAborted: true }), false);
});

test("validated individualized candidate survives a stalled reviewer and late resolution", async () => {
  const result = await runWire({ reviewer: "stall" });
  assert.equal(result.requests.length, 2, "checkpoint must not add model calls");
  assert.equal(result.frames.filter((frame) => frame.content === "[END]").length, 1);
  assert.equal(result.finals.length, 1, "late provider must not emit another result");
  assert.match(result.content, /党参/);
  assert.match(result.content, /食少倦怠/);
  assert.match(result.content, /便溏/);
  assert.match(result.content, /复核未完成|复核.*超过时限/);
  assertNonDose(result.content);
});

test("no valid M04 retains trusted M03 facts and explicitly reports no individualized candidate", async () => {
  const result = await runWire({ first: { candidate: { herbs: [] } } });
  assert.match(result.content, /脾胃虚弱证/);
  assert.match(result.content, /食少倦怠/);
  assert.match(result.content, /健脾益气/);
  assert.match(result.content, /尚未.*个体化|未.*个体化/);
  assert.ok(isNonDosePrescriptionText(result.content));
  assert.doesNotMatch(result.content, /党参|GENERIC_|DIAGNOSIS_JSON_START|重新生成|请重试/);
});

test("client cancellation never sends a recovered candidate", async () => {
  const startedAt = Date.now();
  const result = await runWire({ reviewer: "stall", abortAfterReview: true, remainingMs: 2000 });
  assert.equal(result.finals.length, 0);
  assert.equal(result.requests.length, 2);
  assert.ok(Date.now() - startedAt < 1000, "client cancellation must close independently of a stalled reviewer");
});

test("zero quality budget plus classic identity drift delivers on the first request", async () => {
  const locked = structuredClone(prior);
  locked.overview.recommendedFormulaNames = ["六君子汤"];
  locked.overview.formulaSelectionMode = "single";
  const first = structuredClone(proposal);
  first.candidate.name = "六君子汤";
  first.nonPharma.diet = "清淡饮食";
  const result = await runWire({ first, priorReasoning: locked, outputTransform: withDietQualityFinding });
  assert.equal(result.requests.length, 2, "zero-budget identity disposition must not require a manual second request");
  assert.match(result.content, /党参/);
  assert.match(result.content, /contractSignature/);
  const reasoning = JSON.parse(result.content.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  assert.equal(reasoning.formula.candidates[0].identityDeclassified, true);
  assert.ok(hasBoundClinicalReviewAttestation(reasoning));
});

test("first T2 cannot mask a later T1: automatic repair retains its bounded opportunity", async () => {
  const first = structuredClone(proposal);
  first.nonPharma.diet = "清淡饮食";
  first.candidate.herbs[0].dose = "501g";
  const result = await runWire({ first, remainingMs: 50000, respond: (number) => number === 2 ? proposal : accepted,
    outputTransform: withDietQualityFinding });
  assert.ok(result.requests.length >= 3 && result.requests.length <= 4, "must repair actual unsafe dose, then review");
  assert.match(JSON.stringify(result.requests[1].messages), /dose|剂量/);
  assert.match(result.content, /contractSignature/);
  assert.doesNotMatch(result.content, /501g/);
});

test("a malformed repair does not erase the earlier valid candidate or its review objection", async () => {
  const rejected = { status: "repair", issueCode: "dose_rationale_concern", repairFocus: "dose_strength", candidateIndex: 0, implicatedHerbs: ["党参"] };
  const result = await runWire({ remainingMs: 50000, respond: (number) => number === 2 ? rejected : { candidate: { herbs: [] } } });
  assert.ok(result.requests.length >= 3 && result.requests.length <= 6);
  assert.match(result.content, /党参/);
  assert.match(result.content, /食少倦怠/);
  assert.match(result.content, /剂量强度/);
  assert.doesNotMatch(result.content, /超过时限/);
  assertNonDose(result.content);
});

test("a reviewer objection stays visible when its adjudication stalls", async () => {
  const rejected = { status: "repair", issueCode: "herb_plan_mismatch", repairFocus: "emperor_role", candidateIndex: 0, implicatedHerbs: ["党参"] };
  const result = await runWire({ respond: (number) => number === 2 ? rejected : "stall" });
  assert.equal(result.requests.length, 3);
  assert.match(result.content, /保留意见|意见尚未解决/);
  assertNonDose(result.content);
});

const wrap = (reasoning) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
function checkpointInput() {
  const reasoning = compileM04Proposal(proposal, prior);
  return { reasoning, content: wrap(reasoning), priorReasoning: prior, clinicalContext: "食少倦怠；大便溏薄", generatorModel: "synthetic" };
}
test("checkpoint owns immutable validated bytes and rejects malformed, unsafe and mismatched replacements", () => {
  const input = checkpointInput();
  const checkpoint = retainM04DeliveryCheckpoint(undefined, input);
  assert.ok(checkpoint);
  input.reasoning.formula.candidates[0].herbs[0].name = "不应覆盖";
  assert.equal(checkpoint.reasoning.formula.candidates[0].herbs[0].name, "党参");
  assert.throws(() => { checkpoint.reasoning.formula.candidates[0].herbs.length = 0; }, TypeError);
  for (const change of [
    (value) => { value.reasoning.formula.candidates = []; },
    (value) => { value.reasoning.formula.candidates[0].herbs[0].dose = "501g"; },
    (value) => { value.content = "incomplete"; },
  ]) {
    const bad = checkpointInput(); change(bad);
    assert.equal(retainM04DeliveryCheckpoint(checkpoint, bad), checkpoint);
  }
});
test("only an exact completed attestation and signed payload can restore dose-level output", () => {
  const input = checkpointInput();
  const checkpoint = retainM04DeliveryCheckpoint(undefined, input);
  const attestation = { status: "accepted", reviewedPayloadHash: clinicalReviewPayloadHash(input.reasoning),
    provider: "bailian-qwen", model: "qwen3.7-plus", source: "preferred" };
  const signed = applyPrescribeContractSignature(wrap({ ...input.reasoning, clinicalReview: attestation }), signatureContext);
  const reviewed = bindM04DeliveryReview(checkpoint, input.reasoning, accepted, attestation, signed);
  assert.equal(renderM04DeliveryCheckpoint(reviewed, prior, "deadline"), signed);
  const unavailable = bindM04DeliveryReview(reviewed, input.reasoning, { status: "unavailable", reason: "deadline" });
  assert.equal(renderM04DeliveryCheckpoint(unavailable, prior, "deadline"), signed,
    "an unavailable repeat cannot erase an actually completed attestation");
  const newlyRejected = bindM04DeliveryReview(reviewed, input.reasoning, { status: "repair", issueCode: "dose_rationale_concern" });
  const newestEvidence = preferM04DeliveryCheckpoint(reviewed, newlyRejected);
  assert.match(renderM04DeliveryCheckpoint(newestEvidence, prior, "deadline"), /剂量强度/);
  assertNonDose(renderM04DeliveryCheckpoint(newestEvidence, prior, "deadline"));
  const later = checkpointInput(); later.reasoning.formula.candidates[0].formulaAnalysis += " 本例兼顾便溏。"; later.content = wrap(later.reasoning);
  assert.equal(retainM04DeliveryCheckpoint(reviewed, later), reviewed, "a pending later candidate cannot replace an attested result");
  assert.equal(bindM04DeliveryReview(checkpoint, later.reasoning, accepted, attestation, signed), checkpoint);
  const mismatch = bindM04DeliveryReview(checkpoint, input.reasoning, accepted, attestation, "WRONG_SIGNED_RESULT");
  assertNonDose(renderM04DeliveryCheckpoint(mismatch, prior, "deadline"));
  assert.doesNotMatch(renderM04DeliveryCheckpoint(mismatch, prior, "deadline"), /WRONG_SIGNED_RESULT/);
});
