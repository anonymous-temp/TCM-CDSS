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
async function runWire({ first = proposal, reviewer = accepted, remainingMs = 2000, abortAfterReview = false } = {}) {
  const originalFetch = globalThis.fetch;
  const abort = new AbortController();
  const requests = [];
  let lateResolve;
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (requests.length === 1) return sse(first);
      if (abortAfterReview) queueMicrotask(() => abort.abort());
      if (reviewer === "stall") return new Promise((resolve) => { lateResolve = () => resolve(completion(accepted)); });
      return completion(reviewer);
    };
    const response = await callDiagnosisStream("synthetic continuity fixture", "deepseek", undefined, "markdown", {
      structuredStage: "prescribe", structuredPriorReasoning: prior,
      structuredClinicalContext: "成人；食少倦怠；大便溏薄", requestSignal: abort.signal,
      structuredOrchestrationStartedAt: Date.now() - 60000 + remainingMs,
      truncateFallback: "GENERIC_KB_FALLBACK", deadlineFallback: "GENERIC_DEADLINE_FALLBACK",
      prescribeSignatureContext: { caseId: "synthetic", clinicalContextHash: "synthetic" },
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
  assert.doesNotMatch(content, /DIAGNOSIS_JSON_START|contractSignature|12g|10g|6g|5剂|GENERIC_|重新生成|请重试/);
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
  assert.doesNotMatch(result.content, /党参|GENERIC_|DIAGNOSIS_JSON_START|重新生成|请重试/);
});

test("client cancellation never sends a recovered candidate", async () => {
  const result = await runWire({ reviewer: "stall", abortAfterReview: true, remainingMs: 500 });
  assert.equal(result.finals.length, 0);
  assert.equal(result.requests.length, 2);
});
