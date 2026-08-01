import assert from "node:assert/strict";

import { buildM04ClinicalReviewPrompt, parseM04ClinicalReview } from "../src/lib/m04-clinical-review.ts";

const apiKey = (process.env.OPENAI_API_KEY || "").trim();
const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const model = (process.env.PRIMARY_DIAGNOSE_MODEL || "deepseek-v4-flash").trim();
const timeoutMs = Number(process.env.LIVE_CLINICAL_REVIEW_TIMEOUT_MS || 35_000);
assert.ok(apiKey, "OPENAI_API_KEY is required for the live independent-review regression");

const prior = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    primarySyndrome: "心脾两虚证",
    primarySyndromeBasis: ["入睡困难、多梦易醒3个月", "心悸健忘、食欲欠佳、便溏", "舌淡有齿痕、脉细弱"],
    overallPathogenesis: "心脾两虚，气血生化不足，心神失养",
    overallTherapy: "补益心脾，养血安神",
    recommendedFormulaNames: ["归脾汤"],
    formulaSelectionMode: "single",
  },
  westernDiagnosis: { primary: { name: "慢性失眠障碍", status: "考虑", supportingFacts: ["入睡困难、多梦易醒3个月"], limitations: ["尚未完成量表评估"] } },
  pathogenesis: {
    summary: "脾虚气血生化乏源，心血不足，心神失养",
    chain: [{ nodeId: "P1", patientFact: "入睡困难、多梦易醒3个月", pathogenesis: "心脾两虚，心神失养", therapyDirection: "补益心脾，养血安神" }],
    uncertainties: [{ item: "甲状腺功能", reason: "尚未检查", affects: "需排除器质性失眠原因" }],
  },
  therapy: { overallPrinciple: "补益心脾，养血安神", overallMethod: "益气养血，健脾安神", subTherapies: [] },
  management: { mustCollect: ["睡眠量表、甲状腺功能"], followupSafetyNet: "症状加重及时复诊" },
};

const herbs = [
  ["人参", "9g", "君"], ["黄芪", "15g", "君"], ["白术", "9g", "臣"], ["茯神", "12g", "臣"],
  ["当归", "9g", "臣"], ["龙眼肉", "12g", "佐"], ["酸枣仁", "15g", "佐"], ["远志", "6g", "佐"],
  ["木香", "6g", "佐"], ["炙甘草", "6g", "使"], ["生姜", "6g", "使"], ["大枣", "9g", "使"],
].map(([name, dose, role]) => ({
  name,
  processing: null,
  dose,
  role,
  prescriptionRole: `${role}药，服务心脾两虚、心神失养的核心治法`,
  targetKind: "pathogenesis_node",
  targetRef: "P1",
  targetPathogenesis: "心脾两虚，心神失养",
  function: "按归脾汤方义协同益气养血、健脾安神",
  decoctionRequirement: null,
}));

const candidate = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  overview: prior.overview,
  formula: {
    candidates: [{
      name: "归脾汤加减",
      formulaNames: ["归脾汤"],
      constructionType: "single_base",
      modificationStatus: "canonical",
      baseFormulas: [{ name: "归脾汤", source: "《济生》卷四", matchedIngredientCount: 12, totalIngredientCount: 12 }],
      therapyMatch: "补益心脾，养血安神",
      applicable: "心脾两虚，心神失养",
      notApplicable: "实热、痰火等证候需另行辨证",
      herbs,
      formulaAnalysis: "人参、黄芪为君以益气健脾；白术、茯神、当归为臣以健脾养血；酸枣仁、龙眼肉、远志宁心安神；木香理气醒脾，姜枣甘草调和。",
      decoction: { doseCount: "5剂", method: "每日1剂，水煎早晚分服", course: "5日", followUpNode: "完成5剂后复诊" },
    }],
    patentAndWestern: [],
    modifications: [{ trigger: "复诊仍心悸明显时", targetPathogenesis: "心血不足，心神失养", action: "由医生评估后调整安神药组", doseOrHandling: null, reason: "按复诊事实再决定", riskNote: "调整后重新审方" }],
  },
};

const prompt = buildM04ClinicalReviewPrompt(
  "46岁男性；入睡困难、多梦易醒3个月；伴心悸健忘、纳差便溏；舌淡有齿痕、苔薄白，脉细弱；否认当前用药、过敏、胸痛、晕厥及自伤想法。",
  prior,
  candidate,
);
assert.ok(prompt.length < 20_000, `clinical review prompt exceeded the bounded projection: ${prompt.length}`);

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
        { role: "system", content: "你是独立中药候选处方临床复核器，只输出约定 JSON。不得编造患者事实。" },
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
  assert.equal(response.ok, true, `clinical reviewer returned HTTP ${response.status}`);
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content || "";
  const review = parseM04ClinicalReview(content);
  assert.notEqual(review.status, "unavailable", `clinical reviewer violated the decision contract: ${content.slice(0, 300)}`);
  console.log(JSON.stringify({ model, promptChars: prompt.length, durationMs: Date.now() - startedAt, review, failures: 0 }, null, 2));
} finally {
  clearTimeout(timeout);
}
