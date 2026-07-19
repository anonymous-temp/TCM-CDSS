import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const TIMEOUT_MS = Number(process.env.LIVE_MODEL_TIMEOUT_MS || 300_000);
const REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";

function assert(condition, message, details) {
  if (condition) return;
  const error = new Error(message);
  if (details !== undefined) error.details = details;
  throw error;
}

function consumeNdjson(raw) {
  let content = "";
  let heartbeats = 0;
  for (const line of raw.split("\n").filter(Boolean)) {
    const frame = JSON.parse(line);
    if (frame.type === "heartbeat") heartbeats += 1;
    if (typeof frame.content !== "string" || frame.content === "[END]") continue;
    if (frame.content.startsWith(REPLACE_MARKER)) content = frame.content.slice(REPLACE_MARKER.length);
    else content += frame.content;
  }
  assert(!content.includes("[TRUNCATED]"), "named-formula M04 stream was truncated");
  return { content, heartbeats };
}

function extractReasoning(content) {
  const start = content.lastIndexOf("<!-- DIAGNOSIS_JSON_START -->");
  const end = start >= 0 ? content.indexOf("<!-- DIAGNOSIS_JSON_END -->", start) : -1;
  assert(start >= 0 && end > start, "named-formula M04 omitted its structured contract", content.slice(-1000));
  return JSON.parse(content.slice(start + "<!-- DIAGNOSIS_JSON_START -->".length, end).trim());
}

const stamp = Date.now();
const id = `live_named_formula_${stamp}`;
const fields = {
  zhushu: "入睡困难、多梦易醒3个月",
  sex: "男",
  age: "46岁",
  xianbingshi: "入睡较慢，多梦易醒，醒后难再睡，晨起疲乏，伴心悸健忘、食欲欠佳、便溏。否认胸痛、晕厥、呼吸困难、发热。否认明显打鼾、目击呼吸暂停、日间嗜睡及高血压病史。",
  jiwangshi: "否认严重心脑血管疾病及精神疾病史。",
  guomin: "否认药物及食物过敏",
  yongyaoshi: "否认当前用药及保健品",
  vitalsT: "36.6℃",
  vitalsP: "74次/分",
  vitalsR: "17次/分",
  vitalsBP: "118/72mmHg",
  tcmTongue: "舌淡，边有齿痕，苔薄白",
  tcmPulse: "脉细弱",
  tcmDetail: "面色少华，神清；纳差便溏。",
  tcmLineagePreference: "补土派",
};
let caseState = normalizeCaseStateInput({
  id,
  phase: "diagnose",
  patient: { sex: "男", age: 46 },
  chiefComplaint: fields.zhushu,
  symptoms: { sleep: "入睡困难，多梦易醒", general: "晨起疲乏，心悸健忘，纳差便溏" },
  tongue: fields.tcmTongue,
  pulse: fields.tcmPulse,
  faceNote: "面色少华，神清",
  vitals: { T: fields.vitalsT, P: fields.vitalsP, R: fields.vitalsR, BP: fields.vitalsBP },
  pastHistory: fields.jiwangshi,
  medicationHistory: fields.yongyaoshi,
  allergyHistory: fields.guomin,
  tcmLineagePreference: fields.tcmLineagePreference,
  hisRecord: {
    schemaVersion: "tcm-cdss-his-v1",
    source: "tcm-cdss-his",
    caseId: id,
    updatedAt: new Date().toISOString(),
    tongueImageUploaded: false,
    fields,
    rawText: Object.values(fields).join("。 "),
  },
  completeness: { level: "C", redFlag: 0.1, infoGain: 0.9, managementImpact: 0.9, answerability: 0.9 },
  questionRounds: 1,
  maxQuestionRounds: 1,
  conversation: [],
  diagnosis: "",
  prescription: "",
  riskAssessment: "",
});
assert(caseState, "unable to normalize named-formula live case");
// Mirror the browser chain before signing the M03 fixture. The safety contract includes the
// server-attested clinical-facts projection; signing a pre-preflight state creates a stale but
// superficially valid fixture that the prescribe route must reject with 409.
const redFlagResponse = await fetch(`${BASE_URL}/api/diagnosis/red-flags`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
  body: JSON.stringify({ caseState }),
});
const redFlagRaw = await redFlagResponse.text();
assert(redFlagResponse.ok, `named-formula clinical-facts preflight returned ${redFlagResponse.status}`, redFlagRaw.slice(0, 500));
const redFlagBody = JSON.parse(redFlagRaw);
assert(redFlagBody?.available === true && redFlagBody?.clinicalFacts?.attestation, "named-formula preflight omitted its signed clinical facts", redFlagBody);
caseState = normalizeCaseStateInput({ ...caseState, clinicalFacts: redFlagBody.clinicalFacts });
assert(caseState, "unable to normalize named-formula case after clinical-facts preflight");
// A live test must obtain the M03 signature from the running service. Directly signing a fixture
// couples the test process to the server's secret and either produces false 409 failures or forces
// the test to possess production signing material.
const diagnoseController = new AbortController();
const diagnoseTimeout = setTimeout(() => diagnoseController.abort(), TIMEOUT_MS);
let diagnoseResponse;
let diagnoseRaw;
try {
  diagnoseResponse = await fetch(`${BASE_URL}/api/diagnosis/diagnose`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
    body: JSON.stringify({ caseState: { ...caseState, phase: "diagnose" } }),
    signal: diagnoseController.signal,
  });
  diagnoseRaw = await diagnoseResponse.text();
} finally {
  clearTimeout(diagnoseTimeout);
}
assert(diagnoseResponse.ok, `named-formula M03 returned ${diagnoseResponse.status}`, diagnoseRaw.slice(0, 500));
const diagnoseStream = consumeNdjson(diagnoseRaw);
const m03 = extractReasoning(diagnoseStream.content);
assert(m03.stage === "diagnose", "named-formula M03 returned the wrong stage", m03.stage);
assert(/^hmac-sha256:[a-f0-9]{64}$/.test(m03.contractSignature || ""), "named-formula M03 omitted its service signature");
assert(m03.clinicalReview?.status === "accepted", "named-formula M03 did not pass independent semantic review", m03.clinicalReview);
assert(m03.overview?.recommendedFormulaNames?.includes("归脾汤"), "named-formula M03 did not govern the expected 归脾汤 direction", m03.overview);

const repetitions = Math.max(1, Math.min(20, Number(process.env.M04_REPETITIONS || 1)));
const results = [];
for (let attempt = 1; attempt <= repetitions; attempt += 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const requestStartedAt = Date.now();
  let response;
  let raw;
  try {
    response = await fetch(`${BASE_URL}/api/diagnosis/prescribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
      body: JSON.stringify({ caseState: { ...caseState, phase: "prescribe", diagnosis: diagnoseStream.content, reasoningDiagnose: m03, reasoningV2: m03 } }),
      signal: controller.signal,
    });
    raw = await response.text();
  } finally {
    clearTimeout(timeout);
  }
  const elapsedMs = Date.now() - requestStartedAt;
  assert(response.ok, `named-formula M04 attempt ${attempt} returned ${response.status}`, raw.slice(0, 500));
  const stream = consumeNdjson(raw);
  const m04 = extractReasoning(stream.content);
  const candidate = m04.formula?.candidates?.[0];
  assert(candidate, `named-formula M04 attempt ${attempt} returned no candidate`);
  assert(candidate.formulaNames?.includes("归脾汤"), `M04 attempt ${attempt} drifted away from governed 归脾汤`, candidate);
  assert(Array.isArray(candidate.herbs) && candidate.herbs.length >= 4, `M04 attempt ${attempt} returned too few structured herbs`, candidate.herbs);
  assert(/济生/.test(candidate.formulaSource?.source || ""), `M04 attempt ${attempt} did not resolve governed 归脾汤 source`, candidate.formulaSource);
  assert(elapsedMs < 15_000 || stream.heartbeats > 0, `named-formula M04 attempt ${attempt} emitted no heartbeat during a long request`, { elapsedMs });
  results.push({ attempt, formula: candidate.name, herbs: candidate.herbs.length, source: candidate.formulaSource.source, elapsedMs, heartbeats: stream.heartbeats });
  console.error(`[named-formula] attempt ${attempt}/${repetitions} accepted in ${elapsedMs}ms with ${candidate.herbs.length} herbs`);
}
console.log(JSON.stringify({ repetitions, results, failures: 0 }, null, 2));
