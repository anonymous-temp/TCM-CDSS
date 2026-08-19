import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const CUSTOMER_ID = process.env.CDSS_CUSTOMER_ID || "";
const OUT = process.env.OUT || "artifacts/811-evidence/reflux-treatment/live-api-result.json";
if (!TOKEN) throw new Error("CDSS_API_TOKEN required");
if (!CUSTOMER_ID) throw new Error("CDSS_CUSTOMER_ID required");

const caseState = {
  id: `reflux-treatment-${Date.now()}`,
  customerId: CUSTOMER_ID,
  phase: "diagnose",
  patient: { sex: "女", age: 78 },
  chiefComplaint: "反酸、嗳气反复1年余",
  symptoms: {
    presentHistory: "1年多前因饮食不规律出现反酸、嗳气，餐后及进食辛辣油腻后明显，近1年反复发作，每次约10分钟，伴胃脘隐痛、食欲下降。否认吞咽困难、呕血、黑便及不明原因体重下降。",
  },
  faceNote: "面色萎黄",
  tongue: "舌淡，苔白腻",
  pulse: "脉细缓",
  pastHistory: "高血压病史10年，目前血压稳定；已绝经28年，无妊娠、哺乳或备孕可能。",
  allergyHistory: "否认食物及药物过敏史。",
  medicationHistory: "现服苯磺酸氨氯地平片，未使用其他药物。",
  conversation: [],
  questionRounds: 1,
  maxQuestionRounds: 1,
  diagnosis: "",
  prescription: "",
  riskAssessment: "",
};

function consume(raw) {
  let content = "";
  let error = "";
  let sawEnd = false;
  for (const line of raw.split("\n").filter(Boolean)) {
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    if (typeof frame.error === "string") error = frame.error;
    if (frame.content === "[END]") { sawEnd = true; continue; }
    if (typeof frame.content !== "string") continue;
    content = frame.content.startsWith("<<<CDSS_STREAM_FINAL>>>")
      ? frame.content.slice("<<<CDSS_STREAM_FINAL>>>".length)
      : content + frame.content;
  }
  return { content, error, sawEnd };
}

function reasoningOf(content) {
  const startMark = "<!-- DIAGNOSIS_JSON_START -->";
  const endMark = "<!-- DIAGNOSIS_JSON_END -->";
  const start = content.lastIndexOf(startMark);
  const end = start >= 0 ? content.indexOf(endMark, start) : -1;
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(content.slice(start + startMark.length, end).trim()); } catch { return null; }
}

async function call(stage, state) {
  const startedAt = Date.now();
  const response = await fetch(`${BASE_URL}/api/diagnosis/${stage}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cdss-api-token": TOKEN,
      "x-cdss-customer-id": CUSTOMER_ID,
    },
    body: JSON.stringify({ caseState: state }),
    signal: AbortSignal.timeout(220_000),
  });
  const raw = await response.text();
  const stream = consume(raw);
  return { status: response.status, ms: Date.now() - startedAt, ...stream, reasoning: reasoningOf(stream.content) };
}

const m03 = await call("diagnose", caseState);
const m04 = m03.reasoning
  ? await call("prescribe", {
      ...caseState,
      phase: "prescribe",
      diagnosis: m03.content,
      reasoningDiagnose: m03.reasoning,
      reasoningV2: m03.reasoning,
    })
  : { status: 0, ms: 0, content: "", error: "M03 reasoning missing", sawEnd: false, reasoning: null };

const failures = [];
const check = (name, condition, detail = "") => {
  if (!condition) failures.push({ name, detail });
};
check("M03 HTTP/END/contract", m03.status === 200 && m03.sawEnd && m03.reasoning, `status=${m03.status} error=${m03.error}`);
check("反流工作诊断带 R12", m03.reasoning?.westernDiagnosis?.primary?.coding?.code?.startsWith("R12"), JSON.stringify(m03.reasoning?.westernDiagnosis?.primary));
check("M04 HTTP/END/contract", m04.status === 200 && m04.sawEnd && m04.reasoning, `status=${m04.status} error=${m04.error}`);
check("M04 形成中医非药物项目", (m04.reasoning?.nonPharma?.tcmTreatments || []).length > 0, JSON.stringify(m04.reasoning?.nonPharma));

const result = {
  suite: "reflux-treatment-evidence",
  baseUrl: BASE_URL,
  timingsMs: { m03: m03.ms, m04: m04.ms, total: m03.ms + m04.ms },
  statuses: { m03: m03.status, m04: m04.status },
  failures,
  outputs: { m03: m03.reasoning, m04: m04.reasoning },
  visible: { m03: m03.content, m04: m04.content },
};
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ suite: result.suite, timingsMs: result.timingsMs, statuses: result.statuses, failures }, null, 2));
if (failures.length > 0) process.exit(1);
