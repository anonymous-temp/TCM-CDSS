import { createJiti } from "jiti";
import { M05_PRESCRIPTION_MUTATION_CONTROLS } from "./fixtures/primary-care-sparse-50.mjs";
import { buildAuditPositiveControlState } from "./lib/primary-care-audit-positive-controls.mjs";
import { evaluateAuditInputQualityControl, evaluateAuditPositiveControl } from "./lib/primary-care-sparse-50-contracts.mjs";

const BASE_URL = (process.env.BASE_URL || process.env.TCM_CDSS_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || process.env.TCM_CDSS_API_TOKEN || "";
const CONTROL_FILTER = new Set((process.env.M05_CONTROL_IDS || "").split(",").map((item) => item.trim()).filter(Boolean));
const selectedControls = M05_PRESCRIPTION_MUTATION_CONTROLS.filter((control) => CONTROL_FILTER.size === 0 || CONTROL_FILTER.has(control.id));
const unknownControlIds = [...CONTROL_FILTER].filter((id) => !M05_PRESCRIPTION_MUTATION_CONTROLS.some((control) => control.id === id));
if (selectedControls.length === 0 || unknownControlIds.length > 0) {
  throw new Error(`M05_CONTROL_IDS must select known controls; unknown=${unknownControlIds.join(",") || "none"}`);
}

const jiti = createJiti(import.meta.url);
const signingJiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const { normalizeReasoningV2 } = jiti("../src/lib/diagnosis-types.ts");
const {
  buildDiagnoseContractSignatureContext,
  buildPrescribeContractSignatureContext,
  signDiagnoseReasoning,
  signPrescribeReasoning,
} = await signingJiti.import("../src/lib/reasoning-contract-signature.ts");

function signedControlState(control) {
  // This is a privileged fictional provider-control fixture, not a simulated clinician edit.
  // Sign the deliberately mutated M04 contract locally so each provider rule can be exercised in
  // isolation. The normal workbench correctly rejects duplicate rows before audit and is covered by
  // its own route regression; routing this fixture through that path would test the wrong boundary.
  const unsignedState = buildAuditPositiveControlState(control);
  const unsignedPrescribe = normalizeReasoningV2(unsignedState.reasoningPrescribe);
  const unsignedDiagnose = normalizeReasoningV2({
    ...unsignedPrescribe,
    stage: "diagnose",
    formula: null,
    nonPharma: null,
    clinicalReview: { status: "unavailable" },
    contractSignatureVersion: undefined,
    contractSignature: undefined,
  });
  if (!unsignedPrescribe || !unsignedDiagnose) throw new Error(`${control.id}: unable to construct signed audit control`);
  const signedDiagnose = signDiagnoseReasoning(unsignedDiagnose, buildDiagnoseContractSignatureContext(unsignedState));
  const diagnoseBoundState = { ...unsignedState, reasoningDiagnose: signedDiagnose };
  const signedPrescribe = signPrescribeReasoning(
    unsignedPrescribe,
    buildPrescribeContractSignatureContext(diagnoseBoundState),
  );
  return {
    ...diagnoseBoundState,
    reasoningPrescribe: signedPrescribe,
    reasoningV2: signedPrescribe,
  };
}

const reports = [];
for (const control of selectedControls) {
  const controlState = signedControlState(control);
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
