import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";
import { buildAuditPositiveControlState } from "./lib/primary-care-audit-positive-controls.mjs";

Object.assign(process.env, {
  RXAI_AUDIT_ENABLED: "false", RXAI_QUERY_ENABLED: "true", CDSS_SHOW_RX_AUDIT_SECTION: "true",
  RXAI_AUDIT_BASE_URL: "https://audit.example.invalid", RXAI_AUDIT_TOKEN: "offline-fixture-token",
  CDSS_CLINICAL_FACTS_BACKSTOP: "false", CDSS_M05_FOLLOWUP_AUTHORING: "false",
  REASONING_CONTRACT_SIGNING_KEY: "explicit-disable-offline-signing-key-at-least-32-characters",
});
for (const key of ["OPENAI_API_KEY", "BAILIAN_QWEN_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY", "EVIMED_API_KEY"]) delete process.env[key];
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const audit = await jiti.import("../src/lib/rxaudit.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const signatures = await jiti.import("../src/lib/reasoning-contract-signature.ts");
const { POST: assess } = await jiti.import("../src/app/api/diagnosis/assess/route.ts");
const { POST: postRisk } = await jiti.import("../src/app/api/diagnosis/post-prescription-risk/route.ts");
const { POST: hisScheme } = await jiti.import("../src/app/api/diagnosis/his-scheme/route.ts");
const { GET: health } = await jiti.import("../src/app/api/diagnosis/health/route.ts");
const { deriveStructuredCaseWarningFloor } = await jiti.import("../src/lib/clinical-warning-tier.ts");

function caseFor({ medicationHistory = "否认当前用药", herbs = [{ name: "黄芪", dose: "15g" }, { name: "酸枣仁", dose: "15g" }] } = {}) {
  const control = { id: "explicit-skip", patient: { sex: "男", age: 46 }, chiefComplaint: "入睡困难三个月", diagnosis: "失眠障碍", syndrome: "心脾两虚证", pastHistory: "否认重要慢病", allergyHistory: "否认药物过敏", medicationHistory, herbs };
  const state = normalizeCaseStateInput({ ...buildAuditPositiveControlState(control), customerId: "test-hospital", phase: "done", vitals: { T: "36.5", P: "75", R: "18", BP: "120/80", SpO2: "99%" } });
  const m03 = { ...structuredClone(state.reasoningPrescribe), stage: "diagnose", formula: null, nonPharma: null, clinicalReview: undefined,
    overview: { ...state.reasoningPrescribe.overview, recommendedFormulaNames: [], formulaSelectionMode: "self_devised" } };
  state.reasoningDiagnose = signatures.signDiagnoseReasoning(m03, signatures.buildDiagnoseContractSignatureContext(state));
  const m04 = structuredClone(state.reasoningPrescribe);
  state.reasoningPrescribe = signatures.signPrescribeReasoning(m04, signatures.buildPrescribeContractSignatureContext(state));
  state.reasoningV2 = state.reasoningPrescribe;
  return state;
}
function request(path, caseState) { return new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", "x-cdss-customer-id": "test-hospital" }, body: JSON.stringify({ caseState }) }); }
async function withoutNetwork(fn) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("offline test prohibits external calls"); };
  try { await fn(); assert.equal(calls, 0, "explicit skip must invoke neither audit, medication extraction nor compatibility service"); }
  finally { globalThis.fetch = original; }
}

test("only raw false selects a server-owned skipped state, even without sidecar configuration", async () => {
  const prior = process.env.RXAI_AUDIT_BASE_URL;
  try {
  delete process.env.RXAI_AUDIT_BASE_URL;
  assert.equal(audit.getRxAuditConfig().explicitlyDisabled, true);
  assert.equal(audit.getRxAuditStatus().disabledReason, "rxaudit_disabled");
  assert.equal(audit.rxAuditPresentationEnabled(), false);
  process.env.RXAI_AUDIT_ENABLED = "";
  assert.equal(audit.getRxAuditConfig().explicitlyDisabled, false);
  assert.equal(audit.getRxAuditStatus().disabledReason, "rxaudit_not_configured");
  } finally { process.env.RXAI_AUDIT_ENABLED = "false"; process.env.RXAI_AUDIT_BASE_URL = prior; }
});

test("skip metadata never invents a provider result or unavailable-medication finding", async () => withoutNetwork(async () => {
  const run = await audit.runBoundedRxAudit(caseFor(), 0);
  assert.equal(run.providerAudit.source, "skipped");
  assert.equal(run.providerAudit.ok, false);
  assert.equal(run.medicationExtraction.needsManualReview, false);
  assert.deepEqual(audit.buildAuditInputAdvisories(caseFor(), 0, run.medicationExtraction), []);
  assert.equal(audit.ownedAuditWarningInputs(run.providerAudit), undefined);
  const correlation = audit.buildRxAuditCorrelationMetadata({ providerOutcome: run.providerAudit });
  assert.equal(correlation.providerAvailable, false);
  assert.equal(correlation.providerReason, "rxaudit_disabled");
  assert.equal(correlation.effectiveAuditResult, undefined);
  assert.equal(correlation.effectiveHighestRiskLevel, undefined);
  assert.equal(correlation.needManualReview, undefined);
}));

test("three clinical routes deliver local content with honest skip semantics", async () => withoutNetwork(async () => {
  for (const [path, handler] of [["assess", assess], ["post-prescription-risk", postRisk], ["his-scheme", hisScheme]]) {
    const response = await handler(request(`/api/diagnosis/${path}`, caseFor()));
    const body = await response.text();
    assert.equal(response.status, 200, `${path}: ${body.slice(0, 400)}`);
    assert.doesNotMatch(body, /medication_semantics_unavailable|lingxi_unavailable|自动审方未完成|审方服务暂不可用/, path);
    if (path === "assess") {
      assert.match(body, /TCM_CDSS_RXAUDIT_STATUS:DISABLED/);
    } else {
      const json = JSON.parse(body);
      if (path === "post-prescription-risk") {
        assert.equal(json.audit.source, "skipped");
        assert.equal(json.audit.auditResult, "NOT_SUBMITTED");
        assert.equal(json.audit.highestRiskLevel, undefined);
        assert.equal(json.audit.needManualReview, false);
      } else assert.equal(json.auditStatus, "not_submitted");
    }
  }
}));

test("local medication uncertainty, dose validation and contraindicated pairs survive skip", async () => withoutNetwork(async () => {
  for (const variant of [{ medicationHistory: "现用药不详", expected: /现用药信息明确不详|用药.*不详/ },
    { herbs: [{ name: "黄芪", dose: "" }], expected: /黄芪.*未标注|剂量/ },
    { herbs: [{ name: "甘草", dose: "6g" }, { name: "海藻", dose: "9g" }], expected: /十八反|甘草.*海藻/ }]) {
    const state = caseFor(variant);
    const run = await audit.runBoundedRxAudit(state, 0);
    assert.equal(run.providerAudit.source, "skipped");
    const findings = audit.buildAuditInputAdvisorySection(audit.buildAuditInputAdvisories(state, 0, run.medicationExtraction), true) + audit.buildLocalHighRiskHerbPairSection(state, 0);
    assert.match(findings, variant.expected);
    if (variant.herbs?.[0].name === "甘草") assert.equal(deriveStructuredCaseWarningFloor(state).level, "L4");
    const response = await postRisk(request("/api/diagnosis/post-prescription-risk", state));
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.match(body, variant.expected);
  }
}));

test("existing critical revision remains a floor when external service is skipped", () => {
  const state = caseFor();
  state.prescriptionRevision = { source: "herb_workbench", candidateIndex: 0, herbHash: "previous-version", auditedAt: new Date().toISOString(), auditResult: "BLOCK", highestRiskLevel: "CRITICAL", auditAvailable: true };
  assert.equal(deriveStructuredCaseWarningFloor(state).level, "L4");
});

test("health treats explicit disable as optional skip and absent config as degraded", async () => {
  const read = async () => (await health(new Request("http://localhost/api/diagnosis/health?diagnostics=1"))).json();
  const disabled = await read();
  assert.equal(disabled.rxAudit.enabled, false);
  assert.equal(disabled.rxAudit.explicitlyDisabled, true);
  assert.ok(!disabled.degradedReasons.some((reason) => /rxaudit/.test(reason)));
  delete process.env.RXAI_AUDIT_ENABLED;
  const unconfigured = await read();
  assert.equal(unconfigured.rxAudit.explicitlyDisabled, false);
  assert.ok(unconfigured.degradedReasons.some((reason) => /rxaudit/.test(reason)));
  process.env.RXAI_AUDIT_ENABLED = "false";
});
