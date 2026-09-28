import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

// M04 首轮 DeepSeek 输出 JSON 不合法时的两条提速（2026-09-28）：
//  ① 根对象被多写的一个 `}` 提前闭合（本机 65 例基线唯一一次语法错即此形状）→ 删掉那个括号，字符串一字不改，
//     仍须通过同一份严格 schema 校验；
//  ② 其余不合规 → 同模型升温重抽与 Qwen 严格兜底并发，先通过同一套校验者胜出、另一路立即取消。
// 全部是合成流量：不读运行时密钥、不连任何供应商。
Object.assign(process.env, {
  AI_TEXT_PROVIDER: "bailian-qwen", BAILIAN_QWEN_API_KEY: "test-only",
  BAILIAN_QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  BAILIAN_QWEN_MODEL: "qwen3.8-flash",
  OPENAI_API_KEY: "test-only-deepseek", OPENAI_BASE_URL: "https://api.deepseek.com",
  PRIMARY_PRESCRIBE_MODEL: "deepseek-flash", PRIMARY_STRUCTURED_FALLBACK_MODEL: "qwen3.8-flash",
  PRIMARY_PRESCRIBE_REPAIR_MODEL: "deepseek-flash",
  M04_ORCHESTRATION_DEADLINE_MS: "120000", REASONING_CONTRACT_SIGNING_KEY: "synthetic-signing-key-at-least-32-characters",
});
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { callDiagnosisStream } = await jiti.import("../src/lib/diagnosis-api.ts");
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");
const { checkNonStrictStructuredContent, removePrematureRootClosers } = await jiti.import("../src/lib/model-response-format.ts");

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
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2 },
  }, patentAndWestern: [], modifications: [],
  nonPharma: { diet: "早餐可用山药小米粥，少量多餐。", lifestyle: "规律作息。", emotion: "调畅情志。", precautions: ["观察食欲与便溏变化。"], tcmTreatments: [] },
};
const valid = JSON.stringify(proposal);
// 线上/本机实测形状：nonPharma 之后多一个 `}`，随后 `,"referenceCaseUse":{…}}` 变成根之后的多余内容。
const prematureRootClose = `${valid},"referenceCaseUse":{"adoptedCaseIds":[],"note":"三例医案证候不符，未采用。"}}`;
// 删括号修不了的语法错：字符串里未转义的引号。
const brokenQuote = valid.replace("补脾益气，改善食少倦怠", "补脾益气，\"改善\"食少倦怠");

const encoder = new TextEncoder();
const sse = (text) => new Response(new ReadableStream({ start(controller) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
  controller.close();
} }), { headers: { "content-type": "text/event-stream" } });
const completion = (text) => Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }] });
const signatureContext = { contractVersion: "tcm-cdss-m04-signature-v3", caseId: "synthetic", encounterId: "synthetic",
  clinicalInputHash: `sha256:${"a".repeat(64)}`, diagnoseContractHash: `sha256:${"b".repeat(64)}` };

async function runWire({ first, redraw, strict, env = {} }) {
  const originalFetch = globalThis.fetch;
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const requests = [];
  try {
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const record = { url: String(url), model: body.model, stream: Boolean(body.stream), temperature: body.temperature,
        responseFormat: body.response_format?.type, aborted: false };
      requests.push(record);
      init.signal?.addEventListener("abort", () => { record.aborted = true; }, { once: true });
      if (requests.length === 1) return sse(first);
      const plan = body.model === "qwen3.8-flash" ? strict : redraw;
      if (plan === "stall") {
        return await new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      if (typeof plan === "object" && plan?.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
        return completion(plan.text);
      }
      return completion(plan);
    };
    const response = await callDiagnosisStream("synthetic json fallback fixture", "deepseek", undefined, "markdown", {
      structuredStage: "prescribe", structuredPriorReasoning: prior,
      structuredClinicalContext: "成人；食少倦怠；大便溏薄",
      truncateFallback: "GENERIC_KB_FALLBACK", deadlineFallback: "GENERIC_DEADLINE_FALLBACK",
      prescribeSignatureContext: signatureContext,
    });
    const wire = await response.text();
    const finals = wire.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((frame) => frame.content?.startsWith("<<<CDSS_STREAM_FINAL>>>"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { requests, content: finals.at(-1)?.content || "" };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("premature root close: only the extra closer is removed, string content untouched, schema still enforced", () => {
  assert.throws(() => JSON.parse(prematureRootClose));
  const merged = removePrematureRootClosers(prematureRootClose);
  assert.ok(merged, "the recorded shape must be recoverable");
  const value = JSON.parse(merged);
  assert.deepEqual(Object.keys(value), ["candidate", "patentAndWestern", "modifications", "nonPharma", "referenceCaseUse"]);
  assert.deepEqual({ ...value, referenceCaseUse: undefined }, { ...proposal, referenceCaseUse: undefined },
    "every clinical field survives byte-for-byte");
  const checked = checkNonStrictStructuredContent("m04_proposal", prematureRootClose);
  assert.deepEqual(checked.violations, []);
  assert.deepEqual(checked.repairs, ["premature_root_close"]);

  // Braces and commas inside strings are data, not structure.
  assert.equal(removePrematureRootClosers('{"a":"x},\\"y"}'), undefined, "valid JSON needs no repair");
  assert.equal(JSON.parse(removePrematureRootClosers('{"a":{"b":"}},"}},"c":1}')).c, 1);
  // Text after the root that is not `,"key"` is not this shape.
  assert.equal(removePrematureRootClosers('{"a":1} trailing'), undefined);
  assert.equal(removePrematureRootClosers('{"a":1}}'), undefined, "an unmatched closer is not repaired");
  assert.equal(removePrematureRootClosers('{"a":1},"b":2},"c":3},"d":4}'), undefined, "at most two removals");

  // An inner layer closed early leaves its keys stranded at the root: that is misnesting, never stripped.
  const displaced = `{"candidate":${JSON.stringify(proposal.candidate).replace(/,"formulaAnalysis".*$/, "")}},"formulaAnalysis":"x","decoction":${JSON.stringify(proposal.candidate.decoction)}},"patentAndWestern":[],"modifications":[],"nonPharma":${JSON.stringify(proposal.nonPharma)}}`;
  const displacedCheck = checkNonStrictStructuredContent("m04_proposal", displaced);
  assert.ok(displacedCheck.violations.length > 0, "keys pushed to the root by the repair must be reported, not stripped");
  // 只剩「错位到根上的可选键」这一条违规时，最能看出守卫：没有它，formulaAnalysis 会被当成多余键静默剥掉。
  const { formulaAnalysis, ...candidateWithoutAnalysis } = proposal.candidate;
  const optionalDisplaced = `{"candidate":${JSON.stringify(candidateWithoutAnalysis)}},"formulaAnalysis":${JSON.stringify(formulaAnalysis)}},"patentAndWestern":[],"modifications":[],"nonPharma":${JSON.stringify(proposal.nonPharma)}}`;
  const optionalCheck = checkNonStrictStructuredContent("m04_proposal", optionalDisplaced);
  assert.deepEqual(optionalCheck.violations, [{ path: "/", keyword: "additionalProperties:formulaAnalysis" }],
    "an optional key displaced to the root by the repair is reported as misnesting");
  assert.ok(!optionalCheck.repairs.some((item) => item.startsWith("stripped_unknown_key")), "…and never silently stripped");
});

test("premature root close is repaired in-stream: no fallback call at all", async () => {
  const result = await runWire({ first: prematureRootClose, redraw: valid, strict: valid });
  assert.equal(result.requests.length, 1, "the recorded syntax error no longer costs a regeneration");
  assert.match(result.content, /党参/);
});

test("other syntax errors race a same-model redraw against the strict fallback; the first valid one wins", async () => {
  const result = await runWire({ first: brokenQuote, redraw: valid, strict: "stall" });
  const redraw = result.requests.find((item) => item.model === "deepseek-flash" && !item.stream);
  const strict = result.requests.find((item) => item.model === "qwen3.8-flash");
  assert.ok(redraw, "a same-model redraw is sent");
  assert.ok(strict, "the strict fallback is sent concurrently, not after the redraw");
  assert.equal(redraw.temperature, 0.3, "the redraw leaves the temperature-0 lottery ticket");
  assert.equal(redraw.responseFormat, "json_object");
  assert.equal(strict.aborted, true, "the losing strict request is cancelled");
  assert.match(result.content, /党参/);
});

test("a redraw that is still invalid never wins; the strict fallback does", async () => {
  const result = await runWire({ first: brokenQuote, redraw: brokenQuote, strict: { delayMs: 30, text: valid } });
  assert.equal(result.requests.filter((item) => !item.stream).length, 2);
  assert.equal(result.requests.find((item) => item.model === "qwen3.8-flash").aborted, false);
  assert.match(result.content, /党参/);
});

test("CDSS_M04_SAME_MODEL_REDRAW=false restores the strict-fallback-only path", async () => {
  const result = await runWire({ first: brokenQuote, redraw: valid, strict: valid, env: { CDSS_M04_SAME_MODEL_REDRAW: "false" } });
  const fallbacks = result.requests.filter((item) => !item.stream);
  assert.deepEqual(fallbacks.map((item) => item.model), ["qwen3.8-flash"]);
  assert.match(result.content, /党参/);
});
