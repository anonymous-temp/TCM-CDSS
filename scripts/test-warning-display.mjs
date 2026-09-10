import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";
import ts from "typescript";

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

function pageFunction(name, dependencies, prefix = "") {
  const source = readFileSync(new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(found, `the actual page must wire ${name}`);
  const compiled = ts.transpileModule(found, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(dependencies), `${prefix}\n${compiled}\nreturn ${name};`)(...Object.values(dependencies));
}

test("page export confirmation cannot export a changed case after asynchronous fingerprinting", async () => {
  const state = makeCase();
  const { resolveWarningDisplayProfile } = await jiti.import("../src/lib/warning-display-observation.ts");
  const { warningDisplayMaterial } = await jiti.import("../src/lib/warning-display-binding.ts");
  const profile = resolveWarningDisplayProfile(state);
  const calls = [];
  let current = true;
  let finish;
  const pendingExport = { ...profile, materialKey: warningDisplayMaterial(state), isCurrent: () => current };
  const confirm = pageFunction("confirmReportExport", {
    caseState: state, pendingReportExport: pendingExport, pendingReportExportRef: { current: pendingExport },
    reportExportAcknowledged: true, reportExportReason: "已阅读", installedWarningObservation: undefined,
    warningObservationRef: { current: undefined }, warningDisplayMaterial, resolveWarningDisplayProfile,
    currentPageWarningObservation: () => undefined,
    captureWarningPageGuard: () => () => current,
    reportExportFingerprint: () => new Promise((resolve) => { finish = resolve; }),
    persistState: (s) => calls.push(s), downloadReport: (s) => calls.push(s),
    setPendingReportExport: () => {}, setReportExportAcknowledged: () => {}, setReportExportReason: () => {},
  });
  const pending = confirm();
  current = false;
  finish("fingerprint");
  await pending;
  assert.equal(calls.length, 0, "an old confirmation must neither install nor export another clinical state");
});

test("actual workspace save attaches only installed matching metadata and guards encryption races", async () => {
  const { state, receipt } = await fixtureReceipt();
  const { prepareWarningObservation } = await jiti.import("../src/lib/warning-display-observation.ts");
  const storage = await jiti.import("../src/lib/warning-display-storage.ts");
  const { sanitizeCaseStateForBrowserPersistence } = await jiti.import("../src/lib/browser-case-persistence.ts");
  const installed = await prepareWarningObservation({ receipt, requestState: state, finalState: state, isCurrent: () => true });
  const writes = [];
  const sent = [];
  let finish;
  let current = true;
  const save = pageFunction("saveWorkspaceSnapshot", {
    BROWSER_CASE_PERSISTENCE_ENABLED: true, WORKSPACE_STORAGE_KEY: "workspace", window: { localStorage: { setItem: (...args) => writes.push(args) } },
    workspaceSnapshotBinding: () => "offline-binding", sanitizeCaseStateForBrowserPersistence,
    sanitizeRecordDraftForBrowserPersistence: (draft) => draft, scrubPersistentPhiText: (text) => text,
    sanitizeQuestionSelectionsForBrowserPersistence: (selections) => selections,
    matchingWarningStorageReceipt: storage.matchingWarningStorageReceipt, withWarningStorageReceipt: storage.withWarningStorageReceipt,
    apiUrl: (url) => url, isEncryptedSnapshotEnvelope: () => true,
    fetchJsonWithTimeout: (_url, options) => { sent.push(JSON.parse(options.body)); return new Promise((resolve) => { finish = resolve; }); },
  }, "let workspaceSaveSequence = 0;");
  const payload = { caseState: state, recordDraft: { patientName: "" }, input: "", selectedQuestionOptions: {}, __tcmWarningDisplayReceipt: { forged: true } };
  const pending = save(payload, installed, () => current);
  for (let index = 0; !finish && index < 30; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(finish);
  assert.deepEqual(sent[0].payload.__tcmWarningDisplayReceipt, receipt, "only the separately installed receipt reaches encryption");
  current = false;
  finish({ response: { ok: true }, body: { ok: true, envelope: { updatedAt: "today" } } });
  assert.equal(await pending, null);
  assert.equal(writes.length, 0);
});

test("page M05, badge, workbench and restore use shared receipt boundaries", () => {
  const source = readFileSync(new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url), "utf8");
  assert.match(source, /collectWarningProfile:\s*true/);
  assert.match(source, /prepareWarningObservation\(/);
  assert.match(source, /generatedRisk\.warningObservation/);
  assert.match(source, /body\?\.warningObservation/);
  assert.match(source, /body\.verifiedWarningObservation/);
  assert.match(source, /preserveUnchangedHisSnapshot\(caseState,/);
  assert.match(source, /resolveWarningDisplayProfile\(caseState,/);
  assert.doesNotMatch(source, /const warningProfile = deriveCaseWarningProfile\(caseState\)/);
});

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

test("wire normalization omits undefined fields while keeping explicit capability restrictions distinct", async () => {
  const { warningDisplayMaterial } = await jiti.import("../src/lib/warning-display-binding.ts");
  const state = makeCase();
  const parsedWire = normalizeCaseStateInput(JSON.parse(JSON.stringify(state)));
  assert.equal(warningDisplayMaterial(state, customer.customerId), warningDisplayMaterial(parsedWire, customer.customerId));
  assert.notEqual(warningDisplayMaterial({ ...state, clinicTreatmentCapabilities: [] }, customer.customerId), warningDisplayMaterial(state, customer.customerId));
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
  const { sanitizeCaseStateForBrowserPersistence } = await jiti.import("../src/lib/browser-case-persistence.ts");
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
  const restored = restoreWarningDisplayCase(JSON.parse(JSON.stringify(sanitizeCaseStateForBrowserPersistence(finalState))));
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
  const changing = clone(finalState);
  const duringEdit = prepareWarningObservation({ receipt, requestState, finalState: changing, customerId: customer.customerId, isCurrent: () => true });
  changing.chiefComplaint += "同病例编辑";
  assert.equal(await duringEdit, undefined);
  assert.equal(await prepareWarningObservation({ receipt, requestState, finalState, customerId: "other-customer", isCurrent: () => true }), undefined);
});

test("unchanged workbench draft reconstruction does not manufacture a timestamp-only material edit", async () => {
  const { preserveUnchangedHisSnapshot } = await jiti.import("../src/lib/followup-display-state.ts");
  const { warningDisplayMaterial } = await jiti.import("../src/lib/warning-display-binding.ts");
  const state = { ...makeCase(), hisRecord: { schemaVersion: "tcm-cdss-his-v1", source: "tcm-cdss-his", caseId: "warning-case", updatedAt: "2026-09-10T10:00:00Z", fields: { zhushu: "神疲乏力" }, rawText: "神疲乏力", tongueImageUploaded: false } };
  const rebuilt = { ...state, hisRecord: { ...state.hisRecord, updatedAt: "2026-09-10T11:00:00Z" } };
  assert.equal(warningDisplayMaterial(preserveUnchangedHisSnapshot(state, rebuilt), customer.customerId), warningDisplayMaterial(state, customer.customerId));
  for (const mutate of [
    (s) => { s.hisRecord.fields.zhushu += "新增"; }, (s) => { s.hisRecord.rawText += "新增"; },
    (s) => { s.hisRecord.tongueImageUploaded = true; }, (s) => { s.patient.occupation = "教师"; },
  ]) {
    const changed = clone(rebuilt); mutate(changed);
    const preserved = preserveUnchangedHisSnapshot(state, changed);
    assert.equal(preserved.hisRecord.updatedAt, rebuilt.hisRecord.updatedAt);
    assert.notEqual(warningDisplayMaterial(preserved, customer.customerId), warningDisplayMaterial(state, customer.customerId));
  }
});

async function fixtureReceipt() {
  const { createWarningDisplayReceipt } = await jiti.import("../src/lib/warning-display-receipt.server.ts");
  const state = makeCase();
  return { state, receipt: await createWarningDisplayReceipt({ producer: "assess", requestState: state, finalState: state, customer,
    owned: { riskAssessment: { markdown: state.riskAssessment, currentRiskMarkdown: "" } } }) };
}

test("only opted-in outer warning frames survive a complete unambiguous stream", async () => {
  const { consumeMarkdownStreamWithMetadata } = await jiti.import("../src/lib/diagnosis-engine.ts");
  const { state, receipt } = await fixtureReceipt();
  const frame = { type: "warning_profile", observation: receipt };
  const content = { content: state.riskAssessment };
  const end = { content: "[END]" };
  const response = (frames) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frames.map((item) => JSON.stringify(item)).join("\n") + "\n"));
    controller.close();
  } }));
  const result = await consumeMarkdownStreamWithMetadata(response([content, frame, end]), () => {}, { collectWarningProfile: true });
  assert.deepEqual(result.warningObservation, receipt);
  for (const frames of [
    [content, frame, frame, end], [content, frame, end, frame],
    [content, { ...frame, observation: { ...receipt, version: "unknown" } }, end],
    [{ content: `${state.riskAssessment}\n${JSON.stringify(frame)}` }, end],
    [content, { ...frame, content: "metadata mixed with prose" }, end],
    [content, { ...frame, content: "<<<CDSS_STREAM_FINAL>>>replacement" }, end],
  ]) {
    const output = await consumeMarkdownStreamWithMetadata(response(frames), () => {}, { collectWarningProfile: true });
    assert.equal(output.warningObservation, undefined);
    assert.equal(output.content, frames.filter((item) => !item.type && item.content !== "[END]").map((item) => item.content).join(""));
  }
  assert.equal((await consumeMarkdownStreamWithMetadata(response([content, frame, end]), () => {})).warningObservation, undefined);
  const longContent = { content: "既有临床内容。".repeat(50) };
  for (const frames of [[longContent, frame], [longContent, frame, { error: "上游错误" }, end]]) {
    const output = await consumeMarkdownStreamWithMetadata(response(frames), () => {}, { collectWarningProfile: true, allowPartial: true });
    assert.equal(output.warningObservation, undefined);
    assert.ok(output.content.includes(longContent.content));
  }
});

test("logical END cancels a kept-open connection without waiting for EOF or idle timeout", async () => {
  const { consumeMarkdownStreamWithMetadata } = await jiti.import("../src/lib/diagnosis-engine.ts");
  const { state, receipt } = await fixtureReceipt();
  let cancelled = false;
  const abort = new AbortController();
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode([
      { content: state.riskAssessment }, { type: "warning_profile", observation: receipt }, { content: "[END]" },
    ].map(JSON.stringify).join("\n") + "\n"));
  }, cancel() { cancelled = true; } }));
  const pending = consumeMarkdownStreamWithMetadata(response, () => {}, { collectWarningProfile: true, idleTimeoutMs: 200, abortSignal: abort.signal });
  const winner = await Promise.race([pending.then(() => "complete"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 30))]);
  if (winner !== "complete") abort.abort();
  await pending.catch(() => undefined);
  assert.equal(winner, "complete");
  assert.equal(cancelled, true);
});

test("a mixed metadata frame cannot swallow a genuine upstream error", async () => {
  const { consumeMarkdownStreamWithMetadata } = await jiti.import("../src/lib/diagnosis-engine.ts");
  const { state, receipt } = await fixtureReceipt();
  const response = new Response([
    { content: state.riskAssessment }, { type: "warning_profile", observation: receipt, error: "actual upstream failure" }, { content: "[END]" },
  ].map(JSON.stringify).join("\n") + "\n");
  await assert.rejects(consumeMarkdownStreamWithMetadata(response, () => {}, { collectWarningProfile: true }), /actual upstream failure/);
});

test("storage metadata is separate, matched to actual restored payload and cannot be laundered by encryption", async () => {
  const { withWarningStorageReceipt, matchingWarningStorageReceipt } = await jiti.import("../src/lib/warning-display-storage.ts");
  const { prepareWarningObservation } = await jiti.import("../src/lib/warning-display-observation.ts");
  const { verifyStoredWarningObservation } = await jiti.import("../src/lib/warning-display-receipt.server.ts");
  const { sanitizeCaseStateForBrowserPersistence } = await jiti.import("../src/lib/browser-case-persistence.ts");
  const { state, receipt } = await fixtureReceipt();
  const installed = await prepareWarningObservation({ receipt, requestState: state, finalState: state, customerId: customer.customerId, isCurrent: () => true });
  const payload = { schemaVersion: "tcm-cdss-workspace-v1", caseState: sanitizeCaseStateForBrowserPersistence(state), workbenchDraft: null };
  const matching = await matchingWarningStorageReceipt(payload, state, installed, () => true);
  assert.ok(matching);
  const wrapped = withWarningStorageReceipt({ ...payload, __tcmWarningDisplayReceipt: "untrusted old value" }, matching);
  assert.deepEqual(wrapped.__tcmWarningDisplayReceipt, receipt);
  assert.equal(Object.hasOwn(withWarningStorageReceipt(wrapped), "__tcmWarningDisplayReceipt"), false);
  assert.ok(await verifyStoredWarningObservation(wrapped, customer));
  assert.equal(await verifyStoredWarningObservation({ ...wrapped, __tcmWarningDisplayReceipt: { ...receipt, mac: `hmac-sha256:${"a".repeat(64)}` } }, customer), undefined);
  for (const candidate of [ [wrapped], { nested: wrapped }, { ...wrapped, runningPhase: "assess" }, { ...wrapped, workbenchDraft: { caseId: state.id } } ]) {
    assert.equal(await verifyStoredWarningObservation(candidate, customer), undefined);
  }
  assert.equal(await matchingWarningStorageReceipt({ ...payload, caseState: { ...payload.caseState, riskAssessment: "changed" } }, state, installed, () => true), undefined);
  let current = true;
  const pending = matchingWarningStorageReceipt(payload, state, installed, () => current);
  current = false;
  assert.equal(await pending, undefined);
});

test("owned audit grades do not arise from summary formatting and never downgrade prior structured blockers", async () => {
  const { adviceText, joinWarningText } = await jiti.import("../src/lib/warning-text-projection.ts");
  const { deriveOwnedCaseWarningProfile } = await jiti.import("../src/lib/clinical-warning-projection.server.ts");
  const state = makeCase();
  const projection = joinWarningText([adviceText("最高风险等级：中风险\n当前无确定性强提示\n严禁过度劳累。")]);
  for (const [highestRiskLevel, expected] of [["MEDIUM", "L1"], ["HIGH", "L3"], ["CRITICAL", "L4"]]) {
    const current = { ...state, riskAssessment: projection.markdown };
    const owned = { riskAssessment: projection, audit: { auditResult: "MANUAL_REVIEW", highestRiskLevel, auditAvailable: true } };
    assert.equal(deriveOwnedCaseWarningProfile(current, owned).level, expected);
    const blocked = { ...current, prescriptionRevision: { source: "herb_workbench", candidateIndex: 0, herbHash: "older", auditedAt: "2026-09-10", auditResult: "BLOCK", highestRiskLevel: "CRITICAL", attestation: "older-attested" } };
    assert.equal(deriveOwnedCaseWarningProfile(blocked, owned).level, "L4");
  }
});

test("presentation-disabled metadata is not an actual audit outage in an owned or installed view", async () => {
  const { deriveOwnedCaseWarningProfile } = await jiti.import("../src/lib/clinical-warning-projection.server.ts");
  const { createWarningDisplayReceipt } = await jiti.import("../src/lib/warning-display-receipt.server.ts");
  const { prepareWarningObservation, resolveWarningDisplayProfile } = await jiti.import("../src/lib/warning-display-observation.ts");
  const state = { ...makeCase(), auditAdvisory: { available: false, presentationDisabled: true } };
  const owned = { riskAssessment: { markdown: state.riskAssessment, currentRiskMarkdown: "" }, audit: { auditResult: "PASS", highestRiskLevel: "LOW", auditAvailable: true, needManualReview: false } };
  assert.equal(deriveOwnedCaseWarningProfile(state, owned).level, "L0");
  const receipt = await createWarningDisplayReceipt({ producer: "assess", requestState: state, finalState: state, customer, owned });
  const installed = await prepareWarningObservation({ receipt, requestState: state, finalState: state, customerId: customer.customerId, isCurrent: () => true });
  assert.ok(installed);
  assert.equal(resolveWarningDisplayProfile(state, installed).level, "L0");
  assert.notEqual(deriveOwnedCaseWarningProfile(state, { ...owned, audit: { ...owned.audit, auditAvailable: false, auditResult: "MANUAL_REVIEW", highestRiskLevel: "HIGH" } }).level, "L0");
  const previousUnavailable = { ...state, prescriptionRevision: { source: "herb_workbench", candidateIndex: 0, herbHash: "old", auditedAt: "2026-09-10", auditAvailable: false, auditResult: "REMIND", highestRiskLevel: "MEDIUM" } };
  assert.equal(deriveOwnedCaseWarningProfile(previousUnavailable, owned).level, "L2");
});

test("final sanitation and stream cleanup precede the same reducer on server and browser", async () => {
  const { finalizeM05DisplayResult, applyCompletedM05DisplayResult } = await jiti.import("../src/lib/followup-display-state.ts");
  const { joinWarningText, adviceText } = await jiti.import("../src/lib/warning-text-projection.ts");
  const { markdownNdjsonResponse } = await jiti.import("../src/lib/diagnosis-safety.ts");
  const { consumeMarkdownStreamWithMetadata } = await jiti.import("../src/lib/diagnosis-engine.ts");
  const previous = { ...makeCase(), phase: "assess", riskAssessment: "## 合理用药审方\n旧版当前患者风险：禁止使用。\n## 生活管理\n旧调护" };
  const projection = joinWarningText(["## 生活管理", adviceText("严禁过度劳累。"), "", adviceText("是否需要其他信息？")]);
  const final = finalizeM05DisplayResult(previous, projection, customer.customerId);
  const consumed = await consumeMarkdownStreamWithMetadata(markdownNdjsonResponse(projection.markdown), () => {});
  assert.deepEqual(final.state, applyCompletedM05DisplayResult(previous, consumed, customer.customerId));
  assert.equal(final.content, consumed.content);
  assert.match(final.projection.currentRiskMarkdown, /旧版当前患者风险：禁止使用/);
  assert.doesNotMatch(final.projection.currentRiskMarkdown, /严禁过度劳累|旧调护/);
});

test("snapshot decrypt verifies receipts without changing arbitrary payload or AES compatibility", async () => {
  Object.assign(process.env, { CASE_SNAPSHOT_ENCRYPTION_KEY: "snapshot-warning-offline-encryption-key", CDSS_API_TOKEN: "warning-offline-access-token-32-chars", CDSS_REQUIRE_API_AUTH: "true" });
  const { POST } = await jiti.import("../src/app/api/diagnosis/snapshot/route.ts");
  const { withWarningStorageReceipt } = await jiti.import("../src/lib/warning-display-storage.ts");
  const { sanitizeCaseStateForBrowserPersistence } = await jiti.import("../src/lib/browser-case-persistence.ts");
  const { state, receipt } = await fixtureReceipt();
  const request = (body) => new Request("http://localhost/api/diagnosis/snapshot", { method: "POST", headers: { "content-type": "application/json", "x-cdss-api-token": process.env.CDSS_API_TOKEN }, body: JSON.stringify({ ...body, binding: "b".repeat(64) }) });
  const wrapped = withWarningStorageReceipt({ schemaVersion: "tcm-cdss-workspace-v1", caseState: sanitizeCaseStateForBrowserPersistence(state), workbenchDraft: null }, receipt);
  for (const payload of [wrapped, [wrapped], { nested: wrapped }, { arbitrary: [1, "two"] }, null]) {
    const encrypted = await (await POST(request({ action: "encrypt", payload }))).json();
    assert.equal(encrypted.ok, true);
    assert.equal(encrypted.verifiedWarningObservation, undefined);
    for (const version of ["tcm-cdss-encrypted-snapshot-v2", "tcm-cdss-encrypted-snapshot-v1"]) {
      const result = await (await POST(request({ action: "decrypt", envelope: { ...encrypted.envelope, schemaVersion: version } }))).json();
      assert.equal(result.ok, true);
      assert.deepEqual(result.payload, JSON.parse(JSON.stringify(payload)));
      assert.equal(Boolean(result.verifiedWarningObservation), payload === wrapped);
    }
  }
  const forged = { ...wrapped, __tcmWarningDisplayReceipt: { ...receipt, mac: `hmac-sha256:${"0".repeat(64)}` } };
  const encrypted = await (await POST(request({ action: "encrypt", payload: forged }))).json();
  const result = await (await POST(request({ action: "decrypt", envelope: encrypted.envelope }))).json();
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, JSON.parse(JSON.stringify(forged)));
  assert.equal(result.verifiedWarningObservation, undefined);
});

test("binding does not invent wall-clock defaults for absent optional display timestamps", async () => {
  const { warningDisplayMaterial } = await jiti.import("../src/lib/warning-display-binding.ts");
  const state = normalizeCaseStateInput({ ...makeCase(), hisRecord: { caseId: "warning-case", fields: { zhushu: "神疲乏力" } } });
  delete state.hisRecord.updatedAt;
  const first = warningDisplayMaterial(state, customer.customerId);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(warningDisplayMaterial(state, customer.customerId), first);
  const dated = clone(state);
  dated.hisRecord.updatedAt = "2026-09-10T12:30:00.000Z";
  assert.notEqual(warningDisplayMaterial(dated, customer.customerId), first);
  dated.hisRecord.updatedAt = "2026-09-11T12:30:00.000Z";
  assert.notEqual(warningDisplayMaterial(dated, customer.customerId), first);
});

test("the real M05 route binds the submitted state despite enrichment and controlled author advice", async () => {
  const signatures = await jiti.import("../src/lib/reasoning-contract-signature.ts");
  const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
  const { getTcmHerbFunctionText } = await jiti.import("../src/lib/tcm-knowledge.ts");
  const { synchronizeVisibleClinicalSummary } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  const { buildUnavailableRxAuditSection } = await jiti.import("../src/lib/rxaudit.ts");
  const { findLocalPatentMedicineEntry } = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
  const source = readFileSync(new URL("./regress-tcm-cdss.mjs", import.meta.url), "utf8");
  const helpers = source.slice(source.indexOf("function hisRecord("), source.indexOf("function expected("));
  const bindings = { ...signatures, ...safety, normalizeCaseStateInput, getTcmHerbFunctionText, synchronizeVisibleClinicalSummary,
    buildUnavailableRxAuditSection, findLocalPatentMedicineEntry, CDSS_CUSTOMER_ID: customer.customerId };
  const cases = new Function(...Object.keys(bindings), `${helpers}\nreturn buildHisProjectionRegressionCases();`)(...Object.values(bindings));
  const submitted = { ...cases[1].state, phase: "assess", riskAssessment: "" };
  const routeJiti = createJiti(import.meta.url, { moduleCache: false, alias: {
    "@/lib/clinical-facts-runtime": `${process.cwd()}/scripts/fixtures/warning-display-enrichment.mjs`,
    "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  } });
  const { POST } = await routeJiti.import("../src/app/api/diagnosis/assess/route.ts");
  const { consumeMarkdownStreamWithMetadata } = await jiti.import("../src/lib/diagnosis-engine.ts");
  const { applyCompletedM05DisplayResult } = await jiti.import("../src/lib/followup-display-state.ts");
  const { prepareWarningObservation, resolveWarningDisplayProfile } = await jiti.import("../src/lib/warning-display-observation.ts");
  const { warningDisplayMaterial, warningDisplayHash } = await jiti.import("../src/lib/warning-display-binding.ts");
  const settings = { RXAI_AUDIT_ENABLED: "true", RXAI_AUDIT_BASE_URL: "https://audit.example.invalid", RXAI_AUDIT_API_KEY: "offline-audit",
    RXAI_QUERY_ENABLED: "false", AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "offline-model", OPENAI_BASE_URL: "https://api.deepseek.com", OPENAI_MODEL: "deepseek-v4-flash", CONTROLLED_TERMINOLOGY_MODEL: "deepseek-v4-flash", M05_FOLLOWUP_AUTHORING: "true" };
  const savedEnv = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  Object.assign(process.env, settings);
  let authorCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const data = JSON.parse(options.body);
    if (data.operation === "PRESCRIPTION_AUDIT") return Response.json({ code: 200, data: { audit_result: "MANUAL_REVIEW", highest_risk_level: "MEDIUM", need_manual_review: true, issues: [] } });
    assert.ok(Array.isArray(data.messages), "only the expected offline author request is allowed");
    authorCalls += 1;
    const authored = { reviewFocus: "重点复评乏力与活动耐量变化，避免过早判定疗效。", efficacyCriteria: "对照首诊症状记录评估活动耐量和乏力变化。",
      lifestyle: "作息规律，适当散步以调养气血，但严禁过度劳累耗气。", dimensions: ["精力", "食欲", "大便"], monitoringIndicators: ["活动耐量", "乏力程度", "气短变化"], timeline: [] };
    return Response.json({ choices: [{ message: { content: JSON.stringify(authored) }, finish_reason: "stop" }] });
  };
  try {
    const response = await POST(new Request("http://localhost/api/diagnosis/assess", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseState: submitted }) }));
    assert.equal(response.status, 200);
    const result = await consumeMarkdownStreamWithMetadata(response, () => {}, { collectWarningProfile: true });
    assert.equal(authorCalls, 1);
    assert.match(result.content, /严禁过度劳累耗气/);
    assert.ok(result.warningObservation, "route-owned observation must be emitted");
    assert.equal(result.warningObservation.requestHash, await warningDisplayHash(warningDisplayMaterial(submitted, customer.customerId)));
    const completed = applyCompletedM05DisplayResult(submitted, result, customer.customerId);
    assert.equal(completed.clinicalFacts, submitted.clinicalFacts, "server-only enrichment is not part of the unseen client reducer state");
    const installed = await prepareWarningObservation({ receipt: result.warningObservation, requestState: submitted, finalState: completed, customerId: customer.customerId, isCurrent: () => true });
    assert.ok(installed, "actual final reducer output must match the producer observation");
    assert.notEqual(resolveWarningDisplayProfile(completed, installed).level, "L4");
    const { invalidatePrescriptionContractAfterEdit } = await jiti.import("../src/lib/prescription-revision.ts");
    const { computePrescriptionVersionHash } = await jiti.import("../src/lib/prescription-version.ts");
    const { applyAcceptedPrescriptionDisplayResult, revisionFromAudit } = await jiti.import("../src/lib/followup-display-state.ts");
    const revised = invalidatePrescriptionContractAfterEdit(clone(submitted.reasoningPrescribe));
    revised.formula.candidates[0].name += "（医生编辑版）";
    revised.formula.candidates[0].constructionType = "self_devised";
    revised.formula.candidates[0].modificationStatus = "modified";
    revised.formula.candidates[0].herbs[0].dose = "12g";
    const requestState = { ...completed, reasoningPrescribe: revised, reasoningV2: revised, safetyLocked: false };
    const herbHash = await computePrescriptionVersionHash(revised, 0, requestState);
    requestState.prescriptionRevision = { source: "herb_workbench", candidateIndex: 0, herbHash, auditedAt: "2026-09-10T12:00:00Z", auditResult: "MANUAL_REVIEW", highestRiskLevel: "HIGH", auditAvailable: false };
    const { POST: postRisk } = await routeJiti.import("../src/app/api/diagnosis/post-prescription-risk/route.ts");
    const reviewed = await postRisk(new Request("http://localhost/api/diagnosis/post-prescription-risk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseState: requestState }) }));
    const body = await reviewed.json();
    assert.equal(reviewed.status, 200, JSON.stringify(body));
    assert.equal(body.audit.herbHash, herbHash);
    assert.ok(body.warningObservation, "the workbench producer must emit its final display receipt");
    const accepted = { caseId: requestState.id, reasoning: revised, auditSection: body.section, followupSection: body.followup.trim(), followupTimeline: body.followupTimeline,
      serverSafetyLocked: safety.derivePrescriptionPermission(safety.withSafetyGate(completed)).formalAdoption === "blocked",
      revision: revisionFromAudit(body.audit, 0, herbHash, true) };
    const acceptedState = applyAcceptedPrescriptionDisplayResult(completed, accepted);
    assert.ok(await prepareWarningObservation({ receipt: body.warningObservation, requestState, finalState: acceptedState, customerId: customer.customerId, isCurrent: () => true }));
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(settings)) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  }
});
