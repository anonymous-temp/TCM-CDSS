import { M05_PRESCRIPTION_MUTATION_CONTROLS } from "./fixtures/primary-care-sparse-50.mjs";
import { buildAuditPositiveControlState } from "./lib/primary-care-audit-positive-controls.mjs";
import { evaluateAuditInputQualityControl, evaluateAuditPositiveControl } from "./lib/primary-care-sparse-50-contracts.mjs";

const BASE_URL = (process.env.BASE_URL || process.env.TCM_CDSS_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || process.env.TCM_CDSS_API_TOKEN || "";
const REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";

function extractSignedDiagnoseReasoning(raw) {
  let content = "";
  for (const line of raw.split("\n").filter(Boolean)) {
    try {
      const frame = JSON.parse(line);
      if (typeof frame.content === "string" && frame.content !== "[END]") content += frame.content;
    } catch {}
  }
  const marker = content.lastIndexOf(REPLACE_MARKER);
  if (marker >= 0) content = content.slice(marker + REPLACE_MARKER.length);
  const startMarker = "<!-- DIAGNOSIS_JSON_START -->";
  const endMarker = "<!-- DIAGNOSIS_JSON_END -->";
  const start = content.lastIndexOf(startMarker);
  const end = start >= 0 ? content.indexOf(endMarker, start + startMarker.length) : -1;
  if (start < 0 || end < 0) return null;
  try {
    const reasoning = JSON.parse(content.slice(start + startMarker.length, end).trim());
    return reasoning?.stage === "diagnose" && reasoning?.contractSignature ? reasoning : null;
  } catch {
    return null;
  }
}

async function signedControlState(control) {
  const unsigned = buildAuditPositiveControlState(control);
  const diagnoseState = { ...unsigned, phase: "diagnose" };
  delete diagnoseState.reasoningPrescribe;
  delete diagnoseState.reasoningV2;
  delete diagnoseState.prescriptionRevision;
  delete diagnoseState.prescription;
  const response = await fetch(`${BASE_URL}/api/diagnosis/diagnose`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
    body: JSON.stringify({ caseState: diagnoseState }),
  });
  const raw = await response.text();
  const signed = response.ok ? extractSignedDiagnoseReasoning(raw) : null;
  if (!signed) throw new Error(`${control.id}: unable to obtain a current signed M03 contract (HTTP ${response.status})`);
  return buildAuditPositiveControlState(control, signed);
}

const reports = [];
for (const control of M05_PRESCRIPTION_MUTATION_CONTROLS) {
  const controlState = await signedControlState(control);
  const response = await fetch(`${BASE_URL}/api/diagnosis/post-prescription-risk`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}),
    },
    body: JSON.stringify({ caseState: controlState }),
  });
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (!response.ok || !body?.audit) {
    reports.push({
      id: control.id,
      mutation: control.mutation,
      ok: false,
      errors: [`audit_api_invalid:http_${response.status}:${body?.audit?.reason || raw.slice(0, 200)}`],
    });
    continue;
  }
  const audit = body.audit;
  const evaluated = control.controlLayer === "input_quality"
    ? evaluateAuditInputQualityControl(control, audit)
    : evaluateAuditPositiveControl(control, audit);
  if (control.controlLayer === "input_quality") {
    const assessResponse = await fetch(`${BASE_URL}/api/diagnosis/assess`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}),
      },
      body: JSON.stringify({ caseState: controlState }),
    });
    const assessText = await assessResponse.text();
    if (!assessResponse.ok || !/处方信息待核对/.test(assessText) || !/未标注单次剂量/.test(assessText)) {
      evaluated.ok = false;
      evaluated.errors = [
        ...(evaluated.errors || []),
        `normal_m05_path_missing_input_advisory:http_${assessResponse.status}`,
      ];
    }
  }
  reports.push({
    id: control.id,
    mutation: control.mutation,
    fictional: true,
    ...evaluated,
    controlLayer: control.controlLayer,
    inputAdvisories: audit.inputAdvisories || [],
    issues: (audit.issues || []).map((issue) => ({
      issueId: issue.issueId,
      issueIdGenerated: issue.issueIdGenerated === true,
      issueType: issue.issueType,
      riskLevel: issue.riskLevel,
      title: issue.title,
      relatedItemNos: issue.relatedItemNos,
    })),
  });
}

const passed = reports.filter((report) => report.ok).length;
const failed = reports.length - passed;
console.log(JSON.stringify({ fictional: true, controls: reports.length, passed, failed, reports }, null, 2));
process.exit(failed > 0 ? 1 : 0);
