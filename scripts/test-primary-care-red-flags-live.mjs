import assert from "node:assert/strict";
import { PRIMARY_CARE_POLARITY_CONTRASTS, PRIMARY_CARE_SPARSE_50 } from "./fixtures/primary-care-sparse-50.mjs";

const BASE_URL = (process.env.BASE_URL || process.env.TCM_CDSS_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || process.env.TCM_CDSS_API_TOKEN || "";
const RED_FLAG_TIMEOUT_MS = Number(process.env.RED_FLAG_TIMEOUT_MS || 30_000);
if (!Number.isFinite(RED_FLAG_TIMEOUT_MS) || RED_FLAG_TIMEOUT_MS < 100 || RED_FLAG_TIMEOUT_MS > 120_000) {
  throw new Error("RED_FLAG_TIMEOUT_MS must be between 100 and 120000 milliseconds");
}

function stateFromText(id, text, patient = { age: 45, sex: "未说明" }) {
  return {
    id,
    phase: "collect",
    patient,
    chiefComplaint: text,
    symptoms: { presentHistory: text },
    tongue: "",
    pulse: "",
    vitals: {},
    pastHistory: "",
    medicationHistory: "",
    allergyHistory: "",
    completeness: { level: "C", redFlag: 0.8, infoGain: 0.8, managementImpact: 0.8, answerability: 0.8 },
    questionRounds: 0,
    maxQuestionRounds: 1,
    conversation: [{ role: "user", content: text }],
  };
}

async function semanticGate(state) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RED_FLAG_TIMEOUT_MS);
  let response;
  let raw;
  try {
    response = await fetch(`${BASE_URL}/api/diagnosis/red-flags`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}),
      },
      body: JSON.stringify({ caseState: state }),
      signal: controller.signal,
    });
    raw = await response.text();
  } catch (error) {
    if (controller.signal.aborted) assert.fail(`${state.id}: red-flag API timed out after ${RED_FLAG_TIMEOUT_MS}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(response.status, 200, `${state.id}: red-flag API HTTP ${response.status}: ${raw.slice(0, 500)}`);
  const result = JSON.parse(raw);
  assert.equal(result.available, true, `${state.id}: semantic red-flag layer unavailable`);
  assert.equal(result.semanticStatus, "checked", `${state.id}: semantic red-flag layer not checked`);
  return { ...state, clinicalFacts: result.clinicalFacts, safetyGate: result.safetyGate };
}

const reports = [];
for (const contrast of PRIMARY_CARE_POLARITY_CONTRASTS) {
  const gated = await semanticGate(stateFromText(`primary50_${contrast.id}`, contrast.text));
  const findings = gated.clinicalFacts?.redFlags || [];
  const categoryFindings = findings.filter((item) => item.category === contrast.expected.category);
  const expectedStatus = categoryFindings.some((item) => contrast.expected.allowedStatuses.includes(item.status)) ||
    (contrast.expected.allowAbsent === true && categoryFindings.length === 0);
  const ok = expectedStatus &&
    !categoryFindings.some((item) => item.status === "positive") && gated.safetyGate?.status !== "red_flag";
  reports.push({ id: contrast.id, fictional: true, ok, gateStatus: gated.safetyGate?.status, findings: categoryFindings });
}

const delayed = PRIMARY_CARE_SPARSE_50.find((item) => item.id === "RF05");
const initialText = `${delayed.chief}；${delayed.initial}`;
const initial = await semanticGate(stateFromText("primary50_RF05_initial", initialText, { age: delayed.age, sex: delayed.sex }));
const answeredText = `${initialText}；${delayed.answer}`;
const answered = await semanticGate(stateFromText("primary50_RF05_answered", answeredText, { age: delayed.age, sex: delayed.sex }));
const answeredCategories = (answered.clinicalFacts?.redFlags || []).filter((item) => item.status === "positive" && item.urgency === "emergency").map((item) => item.category);
reports.push({
  id: "RF05-delayed-red-flag",
  fictional: true,
  ok: initial.safetyGate?.status !== "red_flag" && answered.safetyGate?.status === "red_flag" && answeredCategories.includes("acute_abdomen"),
  initialStatus: initial.safetyGate?.status,
  answeredStatus: answered.safetyGate?.status,
  answeredCategories,
});

const passed = reports.filter((report) => report.ok).length;
const failed = reports.length - passed;
console.log(JSON.stringify({ fictional: true, checks: reports.length, passed, failed, reports }, null, 2));
process.exit(failed > 0 ? 1 : 0);
