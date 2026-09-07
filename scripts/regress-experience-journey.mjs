/** Synthetic experience replay. Measures outcomes; adds no runtime clinical gate. */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { measureExperienceResponse } from "./lib/experience-stream-measurement.mjs";

const base = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const customer = process.env.CDSS_CUSTOMER_ID || "";
if (!customer || !process.env.CDSS_API_TOKEN) throw new Error("Configured CDSS_API_TOKEN and CDSS_CUSTOMER_ID are required");
const headers = { "Content-Type": "application/json", "x-cdss-customer-id": customer, "x-cdss-api-token": process.env.CDSS_API_TOKEN };
const cases = [
  { label: "产后头痛伴心悸失眠", age: 28, chiefComplaint: "产后2月余，头痛反复发作1月", history: "产后2月余，近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠、面色少华。否认突发最剧烈头痛、胸痛、呼吸困难、晕厥及意识障碍。", tongue: "舌淡苔薄白", pulse: "脉细弱" },
  { label: "风寒咳嗽伴鼻塞头痛", age: 36, chiefComplaint: "咳嗽、鼻塞3天", history: "受凉后咳嗽3天，痰稀白，鼻塞流清涕，恶寒无汗，伴头痛、肩背酸痛。口不渴，食欲尚可，二便正常。否认高热、胸痛、呼吸困难、咯血、意识异常。", tongue: "舌淡红，苔薄白", pulse: "脉浮紧" },
  { label: "反酸伴嗳气便干", age: 36, chiefComplaint: "反酸烧心反复2周", history: "近2周反酸烧心反复，餐后较明显，伴嗳气及胃脘胀满，偶有口苦，大便偏干，2日一次。食欲尚可。否认吞咽困难、呕血、黑便、体重下降、持续胸痛、剧烈腹痛。", tongue: "舌红，苔薄黄", pulse: "脉弦略数" },
];

async function call(route, body) {
  const started = performance.now();
  try {
    const response = await fetch(`${base}/api/diagnosis/${route}`, {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(230_000),
    });
    const streamed = ["collect", "question", "diagnose", "prescribe", "assess"].includes(route);
    const observation = await measureExperienceResponse(response, { startedAt: started, streamed });
    const raw = observation.raw;
    let json;
    try { json = JSON.parse(raw); } catch { /* NDJSON is parsed below. */ }
    const { content = "", ended = false, streamError = false } = observation;
    let reasoning;
    for (const match of content.matchAll(/<!-- DIAGNOSIS_JSON_START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END -->/g)) {
      try { const value = JSON.parse(match[1]); if (value.stage) reasoning = value; } catch { /* Report no structured output. */ }
    }
    const jsonShape = route === "red-flags" ? Boolean(json?.safetyGate)
      : route === "his-scheme" ? Boolean(json?.diagnoses && json?.prescriptions)
        : route === "post-prescription-risk" ? Boolean(json?.audit && typeof json.section === "string")
          : Boolean(json && typeof json === "object");
    const delivered = response.ok && (streamed ? ended && !streamError && Boolean(content) : jsonShape);
    return { json, content, reasoning, measurement: {
      route, status: response.status, durationMs: observation.durationMs,
      outcome: delivered ? "delivered" : "incomplete",
      ...(streamed ? { ended, streamError, firstByteMs: observation.firstByteMs, firstContentMs: observation.firstContentMs,
        firstUsefulMs: observation.firstUsefulMs, moduleDraftCount: observation.moduleDraftCount } : { jsonShape }),
      ...(typeof json?.code === "string" ? { code: json.code.replace(/[^a-z0-9_]/gi, "_").slice(0, 160) } : {}),
    } };
  } catch {
    return { measurement: { route, status: "request_failed", outcome: "request_failed", durationMs: Math.round(performance.now() - started) } };
  }
}

const results = [];
for (const fixture of cases.slice(0, Math.max(1, Math.min(3, Number(process.env.EXPERIENCE_CASES || 3))))) {
  const started = performance.now();
  let state = {
    id: `experience-${randomUUID()}`, customerId: customer, phase: "collect",
    patient: { sex: "女", age: fixture.age }, chiefComplaint: fixture.chiefComplaint,
    symptoms: { presentHistory: fixture.history }, tongue: fixture.tongue, pulse: fixture.pulse,
    conversation: [], questionRounds: 0, maxQuestionRounds: 2,
    vitals: { T: "36.8℃", P: "78次/分", R: "18次/分", BP: "112/72mmHg", SpO2: "98%" },
    pastHistory: "否认高血压、糖尿病及肝肾疾病。否认妊娠、哺乳及备孕。否认打鼾、睡眠呼吸暂停、日间嗜睡。",
    medicationHistory: "目前无任何现用药。", allergyHistory: "否认药物及食物过敏史。",
  };
  const result = { label: fixture.label, synthetic: true, stages: [], modifications: [], warnings: [] };
  results.push(result);
  console.log(JSON.stringify({ event: "start", label: fixture.label }));
  const collected = await call("collect", { userInput: `${fixture.chiefComplaint}。${fixture.history}`, patientSex: "女" });
  result.stages.push(collected.measurement);
  const preflight = await call("red-flags", { caseState: state });
  result.stages.push(preflight.measurement);
  if (preflight.json) state = { ...state, clinicalFacts: preflight.json.clinicalFacts, completeness: preflight.json.operationalCompleteness, safetyGate: preflight.json.safetyGate };
  if (process.env.EXPERIENCE_QUESTION === "1") {
    const question = await call("question", { caseState: { ...state, phase: "question" } });
    result.stages.push(question.measurement);
    // The doctor may continue without answering; no invented answers enter the synthetic case.
  }
  const diagnose = await call("diagnose", { caseState: state });
  result.stages.push({ ...diagnose.measurement, signed: Boolean(diagnose.reasoning?.contractSignature) });
  console.log(JSON.stringify({ event: "diagnose", label: fixture.label, ...result.stages.at(-1) }));
  if (!diagnose.reasoning?.contractSignature) { result.notReached = "prescribe"; continue; }
  state = { ...state, diagnosis: diagnose.content, reasoningDiagnose: diagnose.reasoning, phase: "prescribe" };
  const prescribe = await call("prescribe", { caseState: state });
  result.stages.push({ ...prescribe.measurement, signed: Boolean(prescribe.reasoning?.contractSignature), herbCount: prescribe.reasoning?.formula?.candidates?.[0]?.herbs?.length || 0 });
  result.modifications = (prescribe.reasoning?.formula?.modifications || []).map(({ action, herbName }) => ({ action, herbName }));
  console.log(JSON.stringify({ event: "prescribe", label: fixture.label, ...result.stages.at(-1), modifications: result.modifications }));
  if (!prescribe.reasoning?.contractSignature) { result.notReached = "post-prescription-risk"; continue; }
  state = { ...state, prescription: prescribe.content, reasoningPrescribe: prescribe.reasoning, phase: "assess" };
  const audit = await call("post-prescription-risk", { caseState: state });
  result.stages.push(audit.measurement);
  const assess = await call("assess", { caseState: state });
  result.stages.push(assess.measurement);
  state = { ...state, riskAssessment: assess.content || "", phase: "done" };
  const his = await call("his-scheme", { caseState: state });
  result.stages.push(his.measurement);
  result.hisModifications = (his.json?.prescriptions?.modifications || []).map(({ action, herbName }) => ({ action, herbName }));
  result.warnings = (his.json?.warnings || []).map(({ code, herbName, message }) => ({ code, herbName, message }));
  result.totalDurationMs = Math.round(performance.now() - started);
  console.log(JSON.stringify({ event: "case_result", ...result }));
}
const report = { checkedAt: new Date().toISOString(), scope: "synthetic_http_journey", results };
if (process.env.EXPERIENCE_OUTPUT) {
  await mkdir(dirname(process.env.EXPERIENCE_OUTPUT), { recursive: true });
  await writeFile(process.env.EXPERIENCE_OUTPUT, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ event: "complete", ...report }));
if (results.some((result) => result.notReached || result.stages.some((stage) => stage.outcome !== "delivered"))) process.exitCode = 1;
