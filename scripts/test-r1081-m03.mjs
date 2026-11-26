import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { "@": root + "/src", "server-only": root + "/node_modules/next/dist/compiled/server-only/empty.js" } });
const { synchronizeVisibleClinicalSummary, nationalTreatmentPrinciple } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const { compositeSyndromeRename } = await jiti.import("../src/lib/delivered-surface.ts");
const { applyFinalReviewPatch } = await jiti.import("../src/lib/final-consistency-review.server.ts");
const { patientClaimFields } = await jiti.import("../src/lib/m03-patient-claim-check.server.ts");
const { buildDiagnosePrompt } = await jiti.import("../src/lib/diagnosis-prompts.ts");
const { createInitialCaseState } = await jiti.import("../src/lib/diagnosis-types.ts");

const draft = () => ({
  overview: { primarySyndrome: "心肺气虚证", tcmDiagnosticRationale: "病位在心脾，气血两虚。", overallPathogenesis: "气血亏虚",
    tcmDifferentials: [{ reason: "本例头晕", distinguishingPoints: "本例气短", typicalManifestation: "一般表现", nextCheck: "查体" }] },
  therapy: { overallMethod: "补气养心" },
  pathogenesis: { natureDifferentiation: { resolution: "resolved", items: ["气虚"], rootDeficiency: ["气虚"], branchExcess: [] },
    locationDifferentiation: { resolution: "resolved" }, uncertainties: [], chain: [{ nodeId: "P1", syndromeEvidence: "舌淡" }] },
});
const patch = (d, field, value, context) => applyFinalReviewPatch("diagnose", d, { [field]: value }, new Set([field]), context);
const d = draft();
assert.equal(compositeSyndromeRename(d, "面色萎黄，爪甲色淡，气短乏力")?.to, "气血两虚证");
assert.equal(compositeSyndromeRename(draft(), "爪甲色淡"), undefined);
d.pathogenesis.natureDifferentiation.branchExcess = ["血瘀"];
// 治则只跟交付的证名走，不读病性分栏（总指挥整合时撤回按分栏推导：实链回放里肝气犯胃证、寒凝血瘀证、风热外袭证都被写成扶正祛邪）。
// 证名是气血两虚证，标实栏里另有「血瘀」也仍是虚则补之；按分栏推导时这里会变成扶正祛邪（反证）。
assert.equal(nationalTreatmentPrinciple("虚则补之", d), "虚则补之");
assert.deepEqual(patientClaimFields(d, "tcm").map(x => x.id).sort(), ["overallPathogenesis", "tcmDiagnosticRationale", ...["reason","distinguishingPoints","typicalManifestation","nextCheck"].map(k => "tcmDifferentials[0]." + k)].sort());
assert.deepEqual(patch(d, "治法", "益气养血，健脾益气，活血通络，养心安神").applied, []);
const node = { 表现: "乏力", 病机: "气虚", 治法方向: "补气", 证据: "两足水肿" };
assert.deepEqual(patch(d, "病机链", [node], { recordText: "神疲乏力，舌淡" }).applied, []);
const question = "腹痛按压后有无变化？";
const rows = [{ 项目: "腹痛按压后的变化", 原因: "按后痛势影响虚实判断", 影响: "病性", 题干: question }];
const control = draft();
assert.deepEqual(patch(control, "待核实", rows, {}).applied, []);
assert.deepEqual(control, draft());
patch(d, "待核实", rows, { unconfirmedFollowupQuestions: [question] });
assert.equal(d.pathogenesis.natureDifferentiation.resolution, "bounded");
assert.equal(d.pathogenesis.locationDifferentiation.resolution, "resolved");
assert.equal(d.pathogenesis.uncertainties[0].item, rows[0].项目);
const state = createInitialCaseState();
assert.equal(buildDiagnosePrompt(state), buildDiagnosePrompt({ ...state, unconfirmedFollowupQuestions: [] }));
assert.ok(buildDiagnosePrompt({ ...state, unconfirmedFollowupQuestions: [question] }).includes(question));

const { qualifyDeficiencyTemperature } = await jiti.import("../src/lib/nature-column-classification.ts");
const { completeSignedTextbookMethod } = await jiti.import("../src/lib/m03-textbook-method.ts");
const { fillMissingChainEvidence } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const { reconcileSecondarySyndromes } = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
const heat = { items: ["阴虚", "火热"], rootDeficiency: ["阴虚"], branchExcess: ["火热"] };
const mixed = structuredClone(heat);
qualifyDeficiencyTemperature(heat, "阴虚火旺证", "虚火内扰");
qualifyDeficiencyTemperature(mixed, "肾阴虚证、胃火炽盛证", "虚火内扰");
assert.deepEqual(heat.branchExcess, []);
assert.deepEqual(mixed.branchExcess, ["火热"]);
const methodInput = { tcmDiseaseName: "痹证", primarySyndrome: "着痹", recommendedFormulaNames: ["薏苡仁汤"] };
const method = "除湿通络，健脾和中";
assert.equal(completeSignedTextbookMethod(method, methodInput, "关节酸重，遇寒加重"), "除湿通络，祛风散寒，健脾和中");
assert.equal(completeSignedTextbookMethod(method, { ...methodInput, recommendedFormulaNames: [] }, "关节酸重，遇寒加重"), method);
const path = { chain: [{ patientFact: "气短、神疲", syndromeEvidence: "" }],
  symptomClusters: [{ symptoms: ["气短", "神疲", "自汗"], mechanism: "气虚" }] };
fillMissingChainEvidence(path, "气短、神疲，劳则自汗。");
assert.equal(path.chain[0].syndromeEvidence, "自汗");
const candidate = draft();
candidate.overview.primarySyndrome = "肝郁血热证";
candidate.overview.secondarySyndromes = ["心火亢盛证"];
const verify = async () => ({ verdict: "pass", strict: false, distinct: 2, specific: 0, category: 2, listed: 0 });
const checked = await reconcileSecondarySyndromes(JSON.stringify(candidate), { recordText: "心烦、小便黄" }, undefined, verify, true);
assert.deepEqual(JSON.parse(checked).overview.secondarySyndromes, []);
const rendered = JSON.parse(readFileSync("scripts/fixtures/chief-complaint-primacy/prod-20260804-postpartum-headache.m03.json", "utf8"));
for (const [name, display, code] of [
  ["鼻出血待查", "鼻出血", "R04.000"], // e05-08
  ["慢性萎缩性胃炎伴幽门螺杆菌感染", "慢性萎缩性胃炎", "K29.4"],
]) {
  Object.assign(rendered.westernDiagnosis.primary, { name, coding: { system: "ICD-10", code, display, source: "ICD-10" } });
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(rendered)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const line = synchronizeVisibleClinicalSummary(content, "diagnose").split("\n").find(value => value.startsWith("**诊断倾向**："));
  assert.equal(line, "**诊断倾向**：" + rendered.westernDiagnosis.primary.name);
}
console.log("m03 consistency checks passed");
