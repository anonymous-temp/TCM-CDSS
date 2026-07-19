import assert from "node:assert/strict";

import { buildM03DiagnosticReviewPrompt, parseM03DiagnosticReview, preflightM03DiagnosticReview } from "../src/lib/m03-diagnostic-review.ts";

const apiKey = (process.env.OPENAI_API_KEY || "").trim();
const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const runtimeReviewerModel = (
  process.env.PRIMARY_CLINICAL_REVIEW_MODEL ||
  process.env.OPENAI_MODEL ||
  "deepseek-v4-flash"
).trim();
const comparisonModel = (process.env.PRIMARY_DIAGNOSE_MODEL || "deepseek-v4-pro").trim();
const timeoutMs = Number(process.env.LIVE_CLINICAL_REVIEW_TIMEOUT_MS || 35_000);
assert.ok(apiKey, "OPENAI_API_KEY is required for the live M03 reviewer calibration");

const clinicalContext = [
  "夜间出汗伴入睡困难1个月",
  "问诊补充：无发热、咳嗽、消瘦或心悸，盗汗以入睡后为主，醒后可缓解",
  "患者回答：患者躺下后长时间无法入睡，无多梦、心慌",
].join("\n");

const westernDiagnosis = {
  primary: {
    name: "夜间出汗伴入睡困难症状",
    status: "证据有限",
    confidence: "低",
    supportingFacts: ["夜间出汗伴入睡困难1个月", "盗汗以入睡后为主，醒后可缓解"],
    limitations: ["现有资料不足以满足具体疾病的完整诊断标准"],
    suggestedChecks: ["结合病程、查体及必要检查鉴别继发性原因"],
  },
  differentials: [],
};

const boundedReasoning = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    primarySyndrome: "营卫失和、心神受扰证",
    primarySyndromeResolution: "bounded",
    primarySyndromeBasis: ["夜间出汗伴入睡困难1个月"],
    primarySyndromeResolutionReason: "当前仅有汗出与睡眠事实，寒热虚实及舌脉仍待四诊复核",
    secondarySyndromes: [],
    overallPathogenesis: "营卫失和，心神受扰",
    overallTherapy: "调和营卫，宁心安神",
    recommendedFormulaDirection: "围绕调和营卫、宁心安神进行本例辨证组方",
    recommendedFormulaNames: [],
    formulaSelectionMode: "self_devised",
  },
  westernDiagnosis,
  pathogenesis: {
    summary: "营卫失和，汗出不调；睡眠受扰，心神不宁",
    locationDifferentiation: {
      items: ["心"],
      details: [],
      resolution: "bounded",
      resolutionReason: "病位仅为有限资料下的功能性归纳",
    },
    natureDifferentiation: {
      items: ["功能失和"],
      rootDeficiency: [],
      branchExcess: [],
      basis: "",
      resolution: "bounded",
      resolutionReason: "现有事实不足以锁定寒热虚实",
    },
    chain: [{
      nodeId: "P1",
      patientFact: "夜间出汗伴入睡困难1个月",
      syndromeEvidence: "夜间出汗伴入睡困难1个月",
      pathogenesis: "营卫失和，心神受扰",
      therapyDirection: "调和营卫，宁心安神",
    }],
    uncertainties: [{
      item: "寒热虚实与舌脉",
      reason: "本轮未提供舌脉及足够寒热虚实证据",
      affects: "影响进一步证型与命名方选择",
    }],
  },
  therapy: { overallPrinciple: "调和营卫，宁心安神", subTherapies: [] },
  formula: null,
};

const overstatedReasoning = structuredClone(boundedReasoning);
overstatedReasoning.overview.primarySyndrome = "阴虚火旺证";
overstatedReasoning.overview.overallPathogenesis = "阴虚生内热，虚火扰心";
overstatedReasoning.overview.overallTherapy = "滋阴降火，宁心安神";
overstatedReasoning.overview.recommendedFormulaDirection = "知柏地黄丸加减";
overstatedReasoning.overview.recommendedFormulaNames = ["知柏地黄丸"];
overstatedReasoning.overview.formulaSelectionMode = "single";
overstatedReasoning.pathogenesis.summary = "阴虚火旺，虚火扰心";
overstatedReasoning.pathogenesis.natureDifferentiation = {
  items: ["阴虚火旺"], rootDeficiency: ["阴虚"], branchExcess: ["虚火"], basis: "盗汗", resolution: "resolved",
};
overstatedReasoning.pathogenesis.chain[0].pathogenesis = "阴虚生内热，虚火扰心";
overstatedReasoning.pathogenesis.chain[0].therapyDirection = "滋阴降火，宁心安神";
overstatedReasoning.therapy.overallPrinciple = "滋阴降火，宁心安神";

const emptyReasoning = structuredClone(boundedReasoning);
emptyReasoning.overview.primarySyndrome = "汗证兼不寐";
emptyReasoning.overview.overallPathogenesis = "症状信息有限";
emptyReasoning.overview.overallTherapy = "待进一步辨证";
emptyReasoning.pathogenesis.chain = [];
emptyReasoning.pathogenesis.locationDifferentiation = { items: [], details: [], resolution: "unresolved", resolutionReason: "资料不足" };
emptyReasoning.pathogenesis.natureDifferentiation = { items: [], rootDeficiency: [], branchExcess: [], basis: "", resolution: "unresolved", resolutionReason: "资料不足" };
emptyReasoning.therapy.overallPrinciple = "待进一步辨证";

const controls = [
  { id: "overstated_negative", reasoning: overstatedReasoning, expected: "repair" },
  { id: "bounded_positive", reasoning: boundedReasoning, expected: "accepted" },
  { id: "empty_negative", reasoning: emptyReasoning, expected: "repair" },
];

async function review(model, control) {
  const preflight = preflightM03DiagnosticReview(control.reasoning, clinicalContext);
  if (preflight) {
    return {
      model,
      id: control.id,
      expected: control.expected,
      durationMs: 0,
      review: preflight,
      reviewerLayer: "deterministic_preflight",
    };
  }
  const prompt = buildM03DiagnosticReviewPrompt(clinicalContext, control.reasoning, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你是独立临床诊断标准复核器，只输出约定 JSON。不得编造患者事实。" },
          { role: "user", content: prompt },
        ],
        stream: false,
        max_tokens: 800,
        temperature: 0,
        response_format: { type: "json_object" },
        reasoning_effort: "low",
        thinking: { type: "disabled" },
      }),
      signal: controller.signal,
    });
    assert.equal(response.ok, true, `${model}/${control.id} reviewer returned HTTP ${response.status}`);
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content || "";
    return {
      model,
      id: control.id,
      expected: control.expected,
      durationMs: Date.now() - startedAt,
      review: parseM03DiagnosticReview(content),
      reviewerLayer: "llm_semantic_review",
    };
  } finally {
    clearTimeout(timeout);
  }
}

const models = [...new Set([runtimeReviewerModel, comparisonModel])];
const results = [];
for (const model of models) {
  for (const control of controls) results.push(await review(model, control));
}

const runtimeResults = results.filter((result) => result.model === runtimeReviewerModel);
const failures = runtimeResults.filter((result) => result.review.status !== result.expected);
console.log(JSON.stringify({ runtimeReviewerModel, comparisonModel, results, failures: failures.length }, null, 2));
assert.equal(failures.length, 0, `runtime M03 reviewer failed controls: ${failures.map((item) => `${item.id}:${item.review.status}`).join(",")}`);
