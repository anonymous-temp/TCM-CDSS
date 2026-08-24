import { existsSync, readFileSync, writeFileSync } from "node:fs";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3012").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const TIMEOUT_MS = Number(process.env.LIVE_MODEL_TIMEOUT_MS || 300_000);
const REQUIRE_RXAUDIT = process.env.REQUIRE_RXAUDIT === "1";
const M03_CACHE_PATH = process.env.LIVE_MODEL_M03_CACHE || "";
const M04_RAW_PATH = process.env.LIVE_MODEL_M04_RAW || "";
const REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";
const CUSTOMER_EVIDENCE_PLACEHOLDER = /\|\s*(?:待检索|证据不足)\s*\||(?:方剂出处|证据依据|来源依据|证据来源|资料收载来源)\s*[：:][^\n]{0,30}(?:待检索|证据不足)/;

function assert(condition, message, details) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

async function post(path, body) {
  return (await postTimed(path, body)).text;
}

async function postTimed(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    assert(response.body, `${path} returned an empty response body`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let pending = "";
    let firstFrameMs = null;
    let previousFrameAt = null;
    let maxInterFrameMs = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const at = Date.now();
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        if (firstFrameMs == null) firstFrameMs = at - startedAt;
        if (previousFrameAt != null) maxInterFrameMs = Math.max(maxInterFrameMs, at - previousFrameAt);
        previousFrameAt = at;
      }
    }
    text += decoder.decode();
    assert(response.ok, `${path} returned ${response.status}`, text.slice(0, 600));
    return { text, firstFrameMs, maxInterFrameMs };
  } finally {
    clearTimeout(timeout);
  }
}

function consumeNdjson(raw, { requireReplacement = false } = {}) {
  const frames = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      frames.push(JSON.parse(line));
    } catch {
      throw new Error(`invalid NDJSON frame: ${line.slice(0, 120)}`);
    }
  }
  const errorFrame = frames.find((frame) => typeof frame?.error === "string");
  assert(!errorFrame, "model stream returned an error frame", errorFrame);
  const endIndexes = frames.flatMap((frame, index) => frame?.content === "[END]" ? [index] : []);
  assert(endIndexes.length === 1, "stream must contain exactly one END frame", { endCount: endIndexes.length });
  assert(endIndexes[0] === frames.length - 1, "stream emitted frames after END", { endIndex: endIndexes[0], frameCount: frames.length });
  const joined = frames
    .filter((frame) => typeof frame?.content === "string" && frame.content !== "[END]")
    .map((frame) => frame.content)
    .join("");
  const marker = joined.lastIndexOf(REPLACE_MARKER);
  const content = (marker >= 0 ? joined.slice(marker + REPLACE_MARKER.length) : joined).trim();
  assert(!content.includes("[TRUNCATED]"), "authoritative stream is truncated");
  if (requireReplacement) assert(marker >= 0, "buffered clinical stage omitted authoritative replacement frame");
  return {
    content,
    contentFrames: frames.filter((frame) => typeof frame?.content === "string").length,
    heartbeatFrames: frames.filter((frame) => frame?.type === "heartbeat").length,
    usedAuthoritativeReplacement: marker >= 0,
  };
}

function extractReasoning(content, expectedStage) {
  const startMarker = "<!-- DIAGNOSIS_JSON_START -->";
  const endMarker = "<!-- DIAGNOSIS_JSON_END -->";
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  assert(start >= 0 && end > start, `${expectedStage} missing complete structured sentinel`, content.slice(-1000));
  assert(!content.slice(end + endMarker.length).trim(), `${expectedStage} has trailing content after END`);
  const reasoning = JSON.parse(content.slice(start + startMarker.length, end).trim());
  assert(reasoning?.schemaVersion === "tcm-cdss-reasoning-v2", `${expectedStage} schema mismatch`, reasoning?.schemaVersion);
  assert(reasoning?.stage === expectedStage, `${expectedStage} stage mismatch`, reasoning?.stage);
  return reasoning;
}

function visibleClinicalContent(content) {
  return content.split("<!-- DIAGNOSIS_JSON_START -->")[0];
}

function createCase() {
  const fields = {
    zhushu: "入睡困难、多梦易醒3个月",
    sex: "男",
    age: "46岁",
    xianbingshi: "入睡常需1小时，多梦易醒，醒后再睡困难，晨起疲乏，伴心悸健忘、食欲欠佳、便溏。否认胸痛、晕厥、呼吸困难、发热、明显口苦口渴、潮热盗汗。否认明显打鼾、目击呼吸暂停、日间嗜睡及高血压病史。",
    jiwangshi: "否认甲状腺疾病、严重心脑血管疾病及精神疾病史。否认自伤、自杀及伤人想法。",
    guomin: "否认药物及食物过敏",
    yongyaoshi: "否认当前用药及保健品",
    vitalsT: "36.6℃",
    vitalsP: "74次/分",
    vitalsR: "17次/分",
    vitalsBP: "118/72mmHg",
    tcmTongue: "舌淡，边有齿痕，苔薄白",
    tcmPulse: "脉细弱",
    tcmDetail: "面色少华，神清；纳差便溏，无恶心呕吐；小便正常。",
    tcmLineagePreference: "补土派",
  };
  const rawText = Object.values(fields).join("。 ");
  return {
    id: `live_quality_${Date.now()}`,
    phase: "diagnose",
    patient: { sex: "男", age: 46 },
    chiefComplaint: fields.zhushu,
    symptoms: {
      sleep: "入睡困难，多梦易醒，醒后再睡困难",
      general: "晨起疲乏，心悸健忘，纳差便溏",
    },
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
      caseId: `live_quality_${Date.now()}`,
      updatedAt: new Date().toISOString(),
      tongueImageUploaded: false,
      fields,
      rawText,
    },
    completeness: { level: "C", redFlag: 0.1, infoGain: 0.9, managementImpact: 0.9, answerability: 0.9 },
    questionRounds: 1,
    maxQuestionRounds: 1,
    conversation: [],
    diagnosis: "",
    prescription: "",
    riskAssessment: "",
  };
}

const startedAt = Date.now();
let caseState = createCase();
let cachedM03;
if (M03_CACHE_PATH && existsSync(M03_CACHE_PATH)) {
  const cache = JSON.parse(readFileSync(M03_CACHE_PATH, "utf8"));
  assert(
    cache?.schemaVersion === "tcm-cdss-live-m03-cache-v1" &&
      cache.caseState?.id &&
      typeof cache.raw === "string",
    "M03 cache must bind the raw signed response to its original case state",
  );
  caseState = cache.caseState;
  cachedM03 = cache.raw;
}

// Mirror the browser workflow: obtain the signed semantic safety facts once, then carry them
// through M03/M04/M05. Omitting this step made every direct stage request rerun the three-model
// facts chain and incorrectly attributed preflight time to model-stage first-frame latency.
const redFlagResponse = await fetch(`${BASE_URL}/api/diagnosis/red-flags`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
  body: JSON.stringify({ caseState }),
});
const redFlagRaw = await redFlagResponse.text();
assert(redFlagResponse.ok, `clinical-facts preflight returned ${redFlagResponse.status}`, redFlagRaw.slice(0, 400));
const redFlagBody = JSON.parse(redFlagRaw);
assert(redFlagBody?.available === true && redFlagBody?.clinicalFacts?.attestation, "clinical-facts preflight did not return a signed reusable result", redFlagBody);
caseState = { ...caseState, clinicalFacts: redFlagBody.clinicalFacts };

const m03Timed = cachedM03
  ? { text: cachedM03, firstFrameMs: null, maxInterFrameMs: null }
  : await postTimed("/api/diagnosis/diagnose", { caseState });
const m03Raw = m03Timed.text;
if (M03_CACHE_PATH && !cachedM03) {
  writeFileSync(M03_CACHE_PATH, JSON.stringify({
    schemaVersion: "tcm-cdss-live-m03-cache-v1",
    caseState,
    raw: m03Raw,
  }), { mode: 0o600 });
}
const m03Stream = consumeNdjson(m03Raw, { requireReplacement: true });
const m03 = extractReasoning(m03Stream.content, "diagnose");
assert(/^hmac-sha256:[a-f0-9]{64}$/.test(m03.contractSignature || ""), "M03 lacks a server contract signature");
assert(m03.contractSignatureVersion === "tcm-cdss-m03-signature-v5", "M03 signature contract version is stale", m03.contractSignatureVersion);
assert(m03.overview?.primarySyndrome && m03.overview?.overallPathogenesis && m03.overview?.overallTherapy, "M03 lacks syndrome/pathogenesis/therapy anchors", m03.overview);
assert(Array.isArray(m03.pathogenesis?.chain) && m03.pathogenesis.chain.length > 0, "M03 lacks a pathogenesis chain");
assert(m03.pathogenesis.chain.every((node, index) => node.nodeId === `P${index + 1}`), "M03 pathogenesis nodes lack deterministic identifiers", m03.pathogenesis.chain);
assert(Array.isArray(m03.overview?.recommendedFormulaNames), "M03 lacks governed formula references", m03.overview);
assert(["single", "combined", "alternatives", "self_devised", "none"].includes(m03.overview?.formulaSelectionMode), "M03 formula selection mode is not governed", m03.overview);
assert(m03.overview.recommendedFormulaNames.length > 0 || ["self_devised", "none"].includes(m03.overview.formulaSelectionMode), "M03 formula names and selection mode disagree", m03.overview);
assert(!CUSTOMER_EVIDENCE_PLACEHOLDER.test(visibleClinicalContent(m03Stream.content)), "M03 customer-visible text exposes an evidence placeholder");
assert(!/Playwright|structured V2 probe|回归测试/.test(m03Stream.content), "M03 exposes automation text");
assert(m03Stream.heartbeatFrames > 0, "M03 emitted no heartbeat during reasoning");
assert(m03Stream.usedAuthoritativeReplacement, "M03 did not publish one authoritative buffered result", m03Stream);
if (m03Timed.firstFrameMs != null) assert(m03Timed.firstFrameMs < 15_000, "M03 first liveness frame exceeded 15s", m03Timed);
if (m03Timed.maxInterFrameMs != null) assert(m03Timed.maxInterFrameMs < 15_000, "M03 inter-frame liveness gap exceeded 15s", m03Timed);
console.error(`[live-model] M03 accepted in ${Date.now() - startedAt}ms: ${m03.overview.primarySyndrome}`);

const tamperedM03 = JSON.parse(JSON.stringify(m03));
tamperedM03.overview.recommendedFormulaNames = ["酸枣仁汤"];
const tamperResponse = await fetch(`${BASE_URL}/api/diagnosis/prescribe`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
  body: JSON.stringify({ caseState: { ...caseState, phase: "prescribe", diagnosis: m03Stream.content, reasoningDiagnose: tamperedM03, reasoningV2: tamperedM03 } }),
});
assert(tamperResponse.status === 409, "tampered browser M03 must be rejected before model invocation", { status: tamperResponse.status, text: (await tamperResponse.text()).slice(0, 300) });

const replayCaseId = `${caseState.id}_replay`;
const replayResponse = await fetch(`${BASE_URL}/api/diagnosis/prescribe`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
  body: JSON.stringify({
    caseState: {
      ...caseState,
      id: replayCaseId,
      phase: "prescribe",
      diagnosis: m03Stream.content,
      reasoningDiagnose: m03,
      reasoningV2: m03,
      hisRecord: caseState.hisRecord ? { ...caseState.hisRecord, caseId: replayCaseId } : undefined,
    },
  }),
});
assert(replayResponse.status === 409, "signed M03 replayed under another case must be rejected before model invocation", { status: replayResponse.status, text: (await replayResponse.text()).slice(0, 300) });

const m04State = {
  ...caseState,
  phase: "prescribe",
  diagnosis: m03Stream.content,
  reasoningDiagnose: m03,
  reasoningV2: m03,
};
const m04StartedAt = Date.now();
const m04Timed = await postTimed("/api/diagnosis/prescribe", { caseState: m04State });
const m04Raw = m04Timed.text;
const m04ElapsedMs = Date.now() - m04StartedAt;
if (M04_RAW_PATH) writeFileSync(M04_RAW_PATH, m04Raw, { mode: 0o600 });
const m04Stream = consumeNdjson(m04Raw, { requireReplacement: true });
const m04 = extractReasoning(m04Stream.content, "prescribe");
assert(m04.overview?.primarySyndrome === m03.overview.primarySyndrome, "M04 changed the M03 primary syndrome", { m03: m03.overview, m04: m04.overview });
assert(m04.overview?.overallPathogenesis === m03.overview.overallPathogenesis, "M04 changed the M03 pathogenesis", { m03: m03.overview, m04: m04.overview });
assert(m04.overview?.overallTherapy === m03.overview.overallTherapy, "M04 changed the M03 therapy", { m03: m03.overview, m04: m04.overview });
assert(Array.isArray(m04.formula?.candidates) && m04.formula.candidates.length === 1, "M04 must return exactly one candidate", m04.formula?.candidates?.length);
const candidate = m04.formula.candidates[0];
assert(Array.isArray(candidate.formulaNames), "M04 candidate lacks governed formula references", candidate);
const expectedFormulaNames = m03.overview.formulaSelectionMode === "none"
  ? true
  : m03.overview.formulaSelectionMode === "alternatives"
  ? candidate.formulaNames.length === 1 && m03.overview.recommendedFormulaNames.includes(candidate.formulaNames[0])
  : candidate.formulaNames.length === m03.overview.recommendedFormulaNames.length && m03.overview.recommendedFormulaNames.every((name) => candidate.formulaNames.includes(name));
assert(expectedFormulaNames, "M04 governed formula references drifted from M03", { m03: m03.overview, m04: candidate.formulaNames });
assert(Array.isArray(candidate.herbs) && candidate.herbs.length >= 4, "M04 candidate has too few structured herbs", candidate.herbs?.length);
assert(candidate.herbs.every((herb) => herb?.name && /^\d+(?:\.\d+)?(?:g|mg|ml)$/.test(herb?.dose || "")), "M04 contains a missing or non-executable herb dose", candidate.herbs);
assert(candidate.herbs.every((herb) => typeof herb.function === "string" && herb.function.length > 0 && herb.function.length <= 80), "M04 herb functions are missing or unbounded", candidate.herbs);
assert(candidate.herbs.every((herb) => !/美容|养颜|驻颜|减肥|抗癌|延年益寿|包治|根治|痛经|痈肿|壮阳/.test(herb.function)), "M04 herb functions contain noisy or inappropriate indications", candidate.herbs);
const pathogenesisRefs = new Set(m03.pathogenesis.chain.map((node) => node.nodeId));
const structureRoles = new Set(["middle_jiao_support", "harmonize", "guide", "temper"]);
assert(candidate.herbs.every((herb) =>
  (herb.targetKind === "pathogenesis_node" && pathogenesisRefs.has(herb.targetRef) && herb.structureRole == null) ||
  (herb.targetKind === "formula_structure" && herb.targetRef === "FORMULA_STRUCTURE" && structureRoles.has(herb.structureRole) && ["佐", "使"].includes(herb.role)),
), "M04 herb target references are not governed", candidate.herbs);
assert(!CUSTOMER_EVIDENCE_PLACEHOLDER.test(visibleClinicalContent(m04Stream.content)), "M04 customer-visible text exposes an evidence placeholder");
assert(!/Playwright|structured V2 probe|回归测试/.test(m04Stream.content), "M04 exposes automation text");
assert(m04ElapsedMs < 15_000 || m04Stream.heartbeatFrames > 0, "M04 emitted no heartbeat during long-running safe buffered reasoning", { m04ElapsedMs });
assert(m04Timed.firstFrameMs != null && m04Timed.firstFrameMs < 15_000, "M04 first liveness frame exceeded 15s", m04Timed);
assert(m04Timed.maxInterFrameMs < 15_000, "M04 inter-frame liveness gap exceeded 15s", m04Timed);
const formulaSource = candidate.formulaSource?.source || "";
assert(!formulaSource || !/待检索|证据不足|未知来源|内部证据缺口/.test(formulaSource), "M04 exposes an unprofessional formula source placeholder", formulaSource);
assert(/合并药液约500mL/.test(candidate.decoction?.method || ""), "adult M04 decoction method must use the deterministic adult volume", candidate.decoction);
console.error(`[live-model] M04 accepted in ${Date.now() - startedAt}ms: ${candidate.name}`);

const m05State = {
  ...m04State,
  phase: "assess",
  prescription: m04Stream.content,
  reasoningPrescribe: m04,
  reasoningV2: m04,
};
const m05Raw = await post("/api/diagnosis/assess", { caseState: m05State });
const m05Stream = consumeNdjson(m05Raw);
assert(/##\s*处方安全总评/.test(m05Stream.content), "M05 lacks prescription safety summary", m05Stream.content.slice(0, 800));
assert(/##\s*随访时间轴/.test(m05Stream.content), "M05 lacks follow-up timeline", m05Stream.content.slice(-1000));
assert(!/证据或依据/.test(m05Stream.content), "M05 regressed the removed evidence/category column");
const auditUnavailable = /TCM_CDSS_RXAUDIT_STATUS:UNAVAILABLE|候选方药结构尚未达到自动审方接口要求|本次未完成自动用药复核|M05 未完成灵犀处方后审方|审方服务状态[^\n]*未取得完整的自动用药复核结果/.test(m05Stream.content);
if (REQUIRE_RXAUDIT) assert(!auditUnavailable, "M05 automatic audit is unavailable in required mode");

console.log(JSON.stringify({
  baseUrl: BASE_URL,
  elapsedMs: Date.now() - startedAt,
  m03: {
    syndrome: m03.overview.primarySyndrome,
    pathogenesisNodes: m03.pathogenesis.chain.length,
    formulaNames: m03.overview.recommendedFormulaNames,
    formulaSelectionMode: m03.overview.formulaSelectionMode,
    contentFrames: m03Stream.contentFrames,
    heartbeatFrames: m03Stream.heartbeatFrames,
    authoritativeReplacement: m03Stream.usedAuthoritativeReplacement,
  },
  m04: {
    formula: candidate.name,
    herbCount: candidate.herbs.length,
    formulaNames: candidate.formulaNames,
    source: formulaSource || "hidden_when_unverified",
    contentFrames: m04Stream.contentFrames,
    heartbeatFrames: m04Stream.heartbeatFrames,
    authoritativeReplacement: m04Stream.usedAuthoritativeReplacement,
  },
  m05: { followup: true, auditAvailable: !auditUnavailable },
  failures: 0,
}, null, 2));
