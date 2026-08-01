const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const TIMEOUT_MS = Number(process.env.LIVE_MODEL_TIMEOUT_MS || 300_000);
const REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";
const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

function invariant(condition, message, detail = "") {
  if (condition) return;
  const error = new Error(message);
  error.detail = detail;
  throw error;
}

function consumeNdjson(raw) {
  let content = "";
  let heartbeats = 0;
  let timelineItems = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    const frame = JSON.parse(line);
    if (frame.type === "heartbeat") heartbeats += 1;
    if (frame.type === "followup_timeline" && Array.isArray(frame.timelineItems)) {
      timelineItems = frame.timelineItems;
    }
    if (typeof frame.content !== "string" || frame.content === "[END]") continue;
    content = frame.content.startsWith(REPLACE_MARKER)
      ? frame.content.slice(REPLACE_MARKER.length)
      : content + frame.content;
  }
  invariant(!content.includes("[TRUNCATED]"), "stream was truncated");
  return { content, heartbeats, timelineItems };
}

function extractReasoning(content, stage) {
  const start = content.lastIndexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start) : -1;
  invariant(start >= 0 && end > start, `${stage} omitted its structured contract`, content.slice(-1000));
  const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim());
  invariant(reasoning.stage === stage, `${stage} returned the wrong structured stage`, reasoning.stage);
  return reasoning;
}

async function post(path, caseState) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}),
      },
      body: JSON.stringify({ caseState }),
      signal: controller.signal,
    });
    const raw = await response.text();
    invariant(response.ok, `${path} returned ${response.status}`, raw.slice(0, 1000));
    return { raw, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

const stamp = Date.now();
const id = `live_self_devised_${stamp}`;
const fields = {
  zhushu: "头痛5天",
  sex: "男",
  age: "24岁",
  xianbingshi: "5天前无明显诱因出现头痛，头痛如裹，肢体困重，胸闷纳呆，小便不利，大便黏腻不成形，睡眠欠佳。否认突发雷击样头痛、发热、口渴、面红目赤、急躁易怒、肢体麻木无力、言语不清和意识异常。",
  jiwangshi: "无特殊病史。",
  guomin: "否认药物、食物过敏。",
  yongyaoshi: "无用药史。",
  vitalsT: "",
  vitalsP: "",
  vitalsR: "",
  vitalsBP: "",
  tcmTongue: "舌质淡，苔白腻",
  tcmPulse: "脉濡",
  tcmDetail: "无明显寒热倾向，不欲饮。",
  tcmLineagePreference: "unrestricted",
};
let caseState = {
  id,
  phase: "diagnose",
  patient: { sex: "男", age: 24 },
  chiefComplaint: fields.zhushu,
  symptoms: {
    neurological: "头痛如裹",
    digestive: "胸闷纳呆、大便黏腻不成形",
    general: "肢体困重、小便不利、睡眠欠佳",
  },
  tongue: fields.tcmTongue,
  pulse: fields.tcmPulse,
  faceNote: "神清，面色正常",
  pastHistory: fields.jiwangshi,
  medicationHistory: fields.yongyaoshi,
  allergyHistory: fields.guomin,
  tcmLineagePreference: "unrestricted",
  hisRecord: {
    schemaVersion: "tcm-cdss-his-v1",
    source: "tcm-cdss-his",
    caseId: id,
    updatedAt: new Date().toISOString(),
    tongueImageUploaded: false,
    fields,
    rawText: Object.values(fields).filter(Boolean).join("。"),
  },
  completeness: { level: "C", redFlag: 0.9, infoGain: 0.9, managementImpact: 0.9, answerability: 0.9 },
  questionRounds: 1,
  maxQuestionRounds: 1,
  conversation: [],
  diagnosis: "",
  prescription: "",
  riskAssessment: "",
};

const preflight = await post("/api/diagnosis/red-flags", caseState);
const preflightBody = JSON.parse(preflight.raw);
invariant(preflightBody.available === true && preflightBody.clinicalFacts?.attestation, "preflight omitted signed clinical facts", preflightBody);
caseState = { ...caseState, clinicalFacts: preflightBody.clinicalFacts };

const diagnose = await post("/api/diagnosis/diagnose", { ...caseState, phase: "diagnose" });
const diagnoseStream = consumeNdjson(diagnose.raw);
const m03 = extractReasoning(diagnoseStream.content, "diagnose");
const visibleM03 = diagnoseStream.content.slice(0, diagnoseStream.content.lastIndexOf(START_MARKER));
invariant(m03.overview?.formulaSelectionMode === "self_devised", "M03 did not select the self-devised direction", m03.overview);
invariant((m03.overview?.recommendedFormulaNames || []).length === 0, "M03 retained a governed classic formula name", m03.overview);
invariant(/头痛（症状性工作诊断）/.test(visibleM03), "M03 did not render the symptom-level diagnosis clearly", visibleM03);
invariant(!/\*\*临床分析\*\*|### 鉴别方向/.test(visibleM03), "M03 exposed removed Western-analysis prose", visibleM03);

const prescribeState = {
  ...caseState,
  phase: "prescribe",
  diagnosis: diagnoseStream.content,
  reasoningDiagnose: m03,
  reasoningV2: m03,
};
const prescribe = await post("/api/diagnosis/prescribe", prescribeState);
const prescribeStream = consumeNdjson(prescribe.raw);
const m04 = extractReasoning(prescribeStream.content, "prescribe");
const candidate = m04.formula?.candidates?.[0];
const visibleM04 = prescribeStream.content.slice(0, prescribeStream.content.lastIndexOf(START_MARKER));
invariant(candidate?.constructionType === "self_devised", "M04 candidate is not deterministically classified as self-devised", candidate);
invariant((candidate?.formulaNames || []).length === 0, "self-devised M04 candidate retained a classic formula identity", candidate);
invariant(/\*\*方案类型\*\*：自拟方/.test(visibleM04), "self-devised badge marker is missing from the server-owned report", visibleM04);
invariant(
  !/未采用经典方说明|逐味核验|加减建议未展示|本次未形成同时满足/.test(visibleM04),
  "M04 exposed removed model-process prose",
  visibleM04,
);

const assessState = {
  ...prescribeState,
  phase: "assess",
  prescription: prescribeStream.content,
  reasoningPrescribe: m04,
  reasoningV2: m04,
};
const assess = await post("/api/diagnosis/assess", assessState);
const assessStream = consumeNdjson(assess.raw);
const timeline = assessStream.timelineItems;
invariant(timeline.some((item) => /首次复诊/.test(item.action)), "follow-up journey omitted the first-review node", timeline);
invariant(timeline.some((item) => /治疗期间随时/.test(item.time)), "follow-up journey omitted the early-reassessment node", timeline);
invariant(!/采纳候选前|完成针对性安全复核/.test(JSON.stringify(timeline)), "follow-up journey exposed the removed generic review node", timeline);

console.log(JSON.stringify({
  case: "damp_obstruction_headache",
  blankVitals: true,
  westernDiagnosis: m03.westernDiagnosis.primary.name,
  westernDiagnosisVisible: "头痛（症状性工作诊断）",
  tcmSyndrome: m03.overview.primarySyndrome,
  formulaSelectionMode: m03.overview.formulaSelectionMode,
  candidate: {
    name: candidate.name,
    constructionType: candidate.constructionType,
    herbs: candidate.herbs.length,
  },
  followupNodes: timeline.map((item) => ({ time: item.time, action: item.action })),
  timing: {
    preflightMs: preflight.elapsedMs,
    m03Ms: diagnose.elapsedMs,
    m04Ms: prescribe.elapsedMs,
    m05Ms: assess.elapsedMs,
  },
  heartbeats: {
    m03: diagnoseStream.heartbeats,
    m04: prescribeStream.heartbeats,
    m05: assessStream.heartbeats,
  },
  failures: 0,
}, null, 2));
