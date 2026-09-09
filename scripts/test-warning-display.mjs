import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";

Object.assign(process.env, {
  REASONING_CONTRACT_SIGNING_KEY: "warning-display-offline-signing-key-at-least-32-characters",
  CDSS_API_CLIENT_ID: "warning-client", CDSS_API_CUSTOMER_IDS: "warning-customer,other-customer",
  CDSS_DEFAULT_CUSTOMER_ID: "warning-customer", CDSS_CUSTOMER_ID: "warning-customer",
  RXAI_AUDIT_ENABLED: "false", CDSS_CLINICAL_FACTS_BACKSTOP: "false",
});
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const customer = { clientId: "warning-client", customerId: "warning-customer" };
const makeCase = () => normalizeCaseStateInput({ id: "warning-case", customerId: customer.customerId, phase: "done",
  patient: { name: "张测试", sex: "男", age: 40, occupation: "软件工程师" },
  chiefComplaint: "神疲乏力2月", symptoms: { presentHistory: "神疲乏力2月，活动后加重" },
  tongue: "舌淡苔白", pulse: "脉细弱", pastHistory: "否认重大疾病", allergyHistory: "否认药物过敏", medicationHistory: "否认当前用药",
  vitals: { T: "36.5℃", P: "75", R: "18", BP: "120/80", SpO2: "99%" },
  diagnosis: "诊断建议：气虚证", prescription: "中药处方尚待医生评估", riskAssessment: "## 生活管理\n严禁过度劳累。",
});
const clone = structuredClone;

test("warning material is deterministic, preserves clinical bytes and binds every material edit", async () => {
  const { stableWarningJson, warningDisplayMaterial, warningDisplayHash } = await jiti.import("../src/lib/warning-display-binding.ts");
  const state = makeCase();
  assert.equal(stableWarningJson({ z: 1, a: { y: 2, a: 3 }, empty: undefined }), '{"a":{"a":3,"y":2},"z":1}');
  const material = warningDisplayMaterial(state, customer.customerId);
  assert.equal(await warningDisplayHash(material), `sha256:${createHash("sha256").update(material).digest("hex")}`);
  assert.equal(warningDisplayMaterial({ ...state, updatedAt: "later", previousResult: { riskAssessment: "old", capturedAt: "today" }, warningAcknowledgement: { reason: "ack" } }, customer.customerId), material);
  for (const mutate of [
    (s) => { s.chiefComplaint += "新增"; }, (s) => { s.symptoms.presentHistory += "变化"; },
    (s) => { s.riskAssessment += " "; }, (s) => { s.prescription += "\n新药"; },
    (s) => { s.patient.occupation = "教师"; }, (s) => { s.patient.age += 1; },
    (s) => { s.phase = "assess"; }, (s) => { s.safetyLocked = true; },
    (s) => { s.followupTimeline = [{ time: "明日", action: "复诊", indicators: ["症状"], triggers: ["加重"] }]; },
    (s) => { s.prescriptionRevision = { source: "herb_workbench", candidateIndex: 0, herbHash: "changed", auditedAt: "2026-09-10T08:00:00Z", auditResult: "BLOCK", highestRiskLevel: "CRITICAL" }; },
  ]) {
    const changed = clone(state); mutate(changed);
    assert.notEqual(warningDisplayMaterial(changed, customer.customerId), material);
  }
  assert.throws(() => warningDisplayMaterial(state, "other-customer"));
});

test("the shared M05 reducer retains old current audit, clears completed state and preserves display parity", async () => {
  const { applyCompletedM05DisplayResult, replaceRiskAssessmentFollowup } = await jiti.import("../src/lib/followup-display-state.ts");
  const { buildRxAuditStatusMarker } = await jiti.import("../src/lib/rxaudit-status.ts");
  const previous = { ...makeCase(), phase: "assess", skipDifferentiationGate: true, riskAssessment: "## 合理用药审方\n本例禁止使用。\n## 生活管理\n旧建议" };
  const content = `${buildRxAuditStatusMarker({ available: true })}\n## 生活管理\n严禁过度劳累。`;
  const state = applyCompletedM05DisplayResult(previous, { content, followupTimeline: [] }, customer.customerId);
  assert.equal(state.phase, "done");
  assert.equal(state.skipDifferentiationGate, undefined);
  assert.equal(state.auditAdvisory.available, true);
  assert.match(state.riskAssessment, /本例禁止使用/);
  assert.doesNotMatch(state.riskAssessment, /旧建议/);
  assert.equal(state.riskAssessment, replaceRiskAssessmentFollowup(previous.riskAssessment, "## 生活管理\n严禁过度劳累。"));
  assert.throws(() => applyCompletedM05DisplayResult(previous, { content, followupTimeline: [] }, "other-customer"));
});

test("one producer HMAC binds distinct live and restored views; invalid metadata is only omitted", async () => {
  const { createWarningDisplayReceipt, verifyWarningDisplayReceipt } = await jiti.import("../src/lib/warning-display-receipt.server.ts");
  const { restoreWarningDisplayCase } = await jiti.import("../src/lib/followup-display-state.ts");
  const { parseWarningDisplayReceipt } = await jiti.import("../src/lib/warning-display-binding.ts");
  const requestState = makeCase();
  const finalState = makeCase();
  const owned = { riskAssessment: { markdown: finalState.riskAssessment, currentRiskMarkdown: "" } };
  const receipt = await createWarningDisplayReceipt({ producer: "assess", requestState, finalState, customer, owned });
  assert.ok(receipt);
  assert.equal(receipt.mac.length, 76);
  assert.notEqual(receipt.live.materialHash, receipt.stored.materialHash, "occupation and name redaction change the stored target");
  assert.notEqual(receipt.live.profile.level, "L4");
  assert.equal(await verifyWarningDisplayReceipt(receipt, customer, finalState, "live"), true);
  const restored = restoreWarningDisplayCase(finalState);
  assert.equal(await verifyWarningDisplayReceipt(receipt, customer, restored, "stored"), true);
  for (const changed of [
    { ...receipt, mac: `hmac-sha256:${"a".repeat(64)}` },
    { ...receipt, customerId: "other-customer" },
    { ...receipt, caseId: "other-case" },
    { ...receipt, live: { ...receipt.live, profile: { ...receipt.live.profile, reasons: ["edited"] } } },
  ]) assert.equal(await verifyWarningDisplayReceipt(changed, customer, finalState, "live"), false);
  assert.equal(await verifyWarningDisplayReceipt(receipt, customer, { ...restored, riskAssessment: `${restored.riskAssessment}\n本例禁止使用。` }, "stored"), false);
  for (const changed of [
    { ...receipt, projectionVersion: "unknown" }, { ...receipt, producer: "model" },
    { ...receipt, live: { ...receipt.live, profile: { ...receipt.live.profile, level: "L4", executable: true } } },
    { ...receipt, stored: { ...receipt.stored, materialHash: "hash" } },
  ]) assert.equal(parseWarningDisplayReceipt(changed), undefined);
});

test("outer-only display observation installation is atomic and expires synchronously on edits", async () => {
  const { createWarningDisplayReceipt } = await jiti.import("../src/lib/warning-display-receipt.server.ts");
  const { prepareWarningObservation, resolveWarningDisplayProfile } = await jiti.import("../src/lib/warning-display-observation.ts");
  const requestState = makeCase();
  const finalState = makeCase();
  const receipt = await createWarningDisplayReceipt({ producer: "assess", requestState, finalState, customer,
    owned: { riskAssessment: { markdown: finalState.riskAssessment, currentRiskMarkdown: "" } } });
  const installed = await prepareWarningObservation({ receipt, requestState, finalState, customerId: customer.customerId, isCurrent: () => true });
  assert.ok(installed);
  assert.notEqual(resolveWarningDisplayProfile(finalState, installed).level, "L4");
  assert.equal(resolveWarningDisplayProfile({ ...finalState, riskAssessment: `${finalState.riskAssessment}\n本例禁止使用。` }, installed).level, "L4");
  let current = true;
  const pending = prepareWarningObservation({ receipt, requestState, finalState, customerId: customer.customerId, isCurrent: () => current });
  current = false;
  assert.equal(await pending, undefined);
  assert.equal(await prepareWarningObservation({ receipt, requestState, finalState, customerId: "other-customer", isCurrent: () => true }), undefined);
});
