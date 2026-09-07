/** Synthetic experience replay. Measures outcomes; adds no runtime clinical gate. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { measureExperienceResponse } from "./lib/experience-stream-measurement.mjs";
import { experienceCases as cases, experienceCaseState } from "./lib/experience-fixtures.mjs";
import { summarizeExperienceDoseStatus } from "./lib/experience-delivery-summary.mjs";

const base = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const customer = process.env.CDSS_CUSTOMER_ID || "";
if (!customer || !process.env.CDSS_API_TOKEN) throw new Error("Configured CDSS_API_TOKEN and CDSS_CUSTOMER_ID are required");
const headers = { "Content-Type": "application/json", "x-cdss-customer-id": customer, "x-cdss-api-token": process.env.CDSS_API_TOKEN };

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
        firstUsefulMs: observation.firstUsefulMs, firstModuleMs: observation.firstModuleMs,
        moduleDraftCount: observation.moduleDraftCount, clinicalDraftCount: observation.clinicalDraftCount } : { jsonShape }),
      ...(typeof json?.code === "string" ? { code: json.code.replace(/[^a-z0-9_]/gi, "_").slice(0, 160) } : {}),
    } };
  } catch {
    return { measurement: { route, status: "request_failed", outcome: "request_failed", durationMs: Math.round(performance.now() - started) } };
  }
}

const results = [];
for (const fixture of cases.slice(0, Math.max(1, Math.min(3, Number(process.env.EXPERIENCE_CASES || 3))))) {
  const started = performance.now();
  let state = experienceCaseState(fixture, customer);
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
  result.doseDelivery = summarizeExperienceDoseStatus(prescribe.reasoning);
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
  result.doseDelivery = summarizeExperienceDoseStatus(prescribe.reasoning, his.json);
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
