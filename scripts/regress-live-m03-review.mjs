import assert from "node:assert/strict";

import { buildM03DiagnosticReviewPrompt, parseM03DiagnosticReview, preflightM03DiagnosticReview } from "../src/lib/m03-diagnostic-review.ts";

const apiKey = (process.env.OPENAI_API_KEY || "").trim();
const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const runtimeReviewerModel = (
  process.env.PRIMARY_CLINICAL_REVIEW_MODEL ||
  process.env.OPENAI_MODEL ||
  "deepseek-v4-pro"
).trim();
const comparisonModel = (process.env.PRIMARY_DIAGNOSE_MODEL || "deepseek-v4-pro").trim();
const timeoutMs = Number(process.env.LIVE_CLINICAL_REVIEW_TIMEOUT_MS || 35_000);
assert.ok(apiKey, "OPENAI_API_KEY is required for the live M03 reviewer calibration");

const clinicalContext = [
  "入睡困难、多梦易醒3个月",
  "问诊补充：心悸健忘，纳差便溏，神疲乏力；无发热、胸痛、呼吸困难",
  "四诊：舌淡，脉细弱",
].join("\n");

const westernDiagnosis = {
  primary: {
    name: "失眠症状",
    status: "考虑",
    confidence: "中",
    supportingFacts: ["入睡困难、多梦易醒3个月"],
    clinicalRationale: "持续入睡困难并多梦易醒支持失眠症状方向；当前未提供日间功能损害和睡眠量表结果，因此不升级为更具体的睡眠障碍诊断。",
    limitations: ["未提供日间功能损害和睡眠量表结果"],
    suggestedChecks: ["评估日间功能和睡眠量表，必要时鉴别继发性原因"],
  },
  differentials: [],
};

const boundedReasoning = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "不寐",
    primarySyndrome: "心脾两虚证",
    primarySyndromeResolution: "bounded",
    primarySyndromeBasis: ["心悸健忘", "纳差便溏", "神疲乏力", "舌淡", "脉细弱"],
    primarySyndromeResolutionReason: "心悸健忘与纳差便溏并见，结合神疲、舌淡和脉细弱，支持心脾两虚。",
    tcmDiagnosticRationale: "心悸健忘提示心血失养，纳差便溏和神疲提示脾气亏虚；舌淡、脉细弱与气血亏虚方向一致，故辨为不寐之心脾两虚证。",
    secondarySyndromes: [],
    overallPathogenesis: "脾气亏虚，心血失养",
    overallTherapy: "健脾益气，养血安神",
    recommendedFormulaDirection: "归脾汤加减",
    recommendedFormulaNames: ["归脾汤"],
    formulaSelectionMode: "single",
  },
  westernDiagnosis,
  pathogenesis: {
    summary: "脾气亏虚，心血失养",
    locationDifferentiation: {
      items: ["心", "脾"],
      details: [],
      resolution: "bounded",
      resolutionReason: "心悸健忘与纳差便溏分别支持心、脾病位",
    },
    natureDifferentiation: {
      items: ["气虚", "血虚"],
      rootDeficiency: ["气虚", "血虚"],
      branchExcess: [],
      basis: "神疲乏力、舌淡、脉细弱",
      resolution: "bounded",
      resolutionReason: "神疲乏力支持气虚，舌淡脉细弱结合心悸健忘支持血虚",
    },
    chain: [{
      nodeId: "P1",
      patientFact: "心悸健忘、纳差便溏、神疲乏力",
      syndromeEvidence: "舌淡，脉细弱",
      pathogenesis: "脾气亏虚，心血失养",
      therapyDirection: "健脾益气，养血安神",
    }],
    uncertainties: [],
  },
  therapy: {
    overallPrinciple: "虚则补之，心脾同治",
    overallMethod: "健脾益气，养血安神",
    subTherapies: [{ therapy: "健脾益气", targetPathogenesis: "脾气亏虚", priority: "主要" }],
  },
  management: { followupSafetyNet: "若失眠持续2周未改善或出现胸痛、呼吸困难、意识异常，及时复诊或急诊评估。" },
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
