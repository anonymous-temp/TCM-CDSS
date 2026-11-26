import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { "@": root + "/src", "server-only": root + "/node_modules/next/dist/compiled/server-only/empty.js" } });
const { currentAntithromboticTherapyRecorded: active, evaluateSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const { buildRedflagDiscriminatorRequest, parseRedflagDiscriminatorScreen } = await jiti.import("../src/lib/redflag-discriminator-screen.server.ts");
const fixture = JSON.parse(fs.readFileSync("scripts/fixtures/open-language-classes/discharge-antithrombotic-use.json", "utf8"));
const record = (text) => normalizeCaseStateInput({ patient: { age: 40, sex: "女" }, chiefComplaint: "复诊", symptoms: { 现病史: text } });
const concepts = buildRedflagDiscriminatorRequest("复诊", { ageMonths: 480 }).concepts;
const parse = (source, id, quote, basisQuote) => parseRedflagDiscriminatorScreen(JSON.stringify({ present: [{ id, quote, basisQuote }] }), concepts, source);
for (const { subject, sibling } of fixture.parity.pairs) {
  assert.equal(active(subject), true, subject);
  assert.equal(active(sibling), true, sibling);
}
for (const text of fixture.controls.mustStayReady) assert.equal(active(text), false, text);

const id = "medication-anticoagulant";
const quote = "每晚照旧吃一颗利伐沙班";
const patient = record(quote);
const confirmed = parse(quote, id, quote);
assert.deepEqual(confirmed, [{ conceptId: id, quote }]);
patient.clinicalFacts = { redFlags: [], discriminatorScreen: { status: "checked", present: confirmed } };
assert.equal(active(patient), true);
for (const [source, evidence, classification] of [
  ["母亲" + quote, quote, id], ["曾" + quote, quote, id], [quote + "，已停药", quote, id],
  [quote, "利伐沙班", id], [quote, quote, "medication-antiplatelet"], ["气促", quote, id],
]) assert.deepEqual(parse(source, classification, evidence), [], source);

const bleeding = record("突发腹痛伴阴道少量流血，冷汗。");
bleeding.chiefComplaint = "腹痛伴阴道流血2小时";
bleeding.vitals = { BP: "90/56" };
const gate = evaluateSafetyGate(bleeding);
assert.ok(gate.redFlags.some((s) => s.includes("阴道少量流血") && s.includes("冷汗")));
assert.ok(gate.advisories.some((s) => s.includes("90/56") && s.includes("末梢灌注")));
const rr = record("呼吸45次/分");
rr.clinicalFacts = { reviewStatus: "checked", redFlags: [], disposition: { setting: "emergency", mustNotMiss: [{ condition: "婴幼儿严重呼吸窘迫或脓毒症", plausibility: "likely", evidenceQuotes: ["呼吸45次/分"] }] } };
assert.ok(evaluateSafetyGate(rr).redFlags.some((s) => s.includes("需排除：严重呼吸窘迫或脓毒症")));
const observed = record("口服铋剂后大便变黑，潜血阴性。");
observed.clinicalFacts = { reviewStatus: "checked", redFlags: [], disposition: { setting: "outpatient_ok", mustNotMiss: [], rationale: "用铋剂后排黑便，潜血阴性，考虑药物着色。" } };
const prior = evaluateSafetyGate(observed);
observed.clinicalFacts.discriminatorScreen = { status: "checked", present: parse("口服铋剂后大便变黑，潜血阴性。", "observe-stool-color", "大便变黑", "潜血阴性") };
const yellow = evaluateSafetyGate(observed);
assert.ok(yellow.advisories.some((s) => s.startsWith("观察：") && s.includes("大便变黑") && s.includes("柏油样便")));
assert.deepEqual([yellow.status, yellow.allowDosePrescription, yellow.redFlags], [prior.status, prior.allowDosePrescription, prior.redFlags]);
const anemia = record("月经量多半年。");
anemia.symptoms.exams = "血常规Hb 92g/L，血清铁蛋白6ng/mL";
anemia.clinicalFacts = { reviewStatus: "checked", redFlags: [], disposition: { setting: "outpatient_ok", mustNotMiss: [], rationale: "缺铁性贫血伴经量多，宜门诊随访。" } };
assert.ok(evaluateSafetyGate(anemia).advisories.some((s) => s.includes("Hb 92g/L、铁蛋白6ng/mL")));
const normal = { ...anemia, symptoms: { ...anemia.symptoms, exams: "血常规Hb 129g/L，血清铁蛋白65ng/mL" } };
assert.ok(!evaluateSafetyGate(normal).advisories.some((s) => s.startsWith("观察：")));
console.log("r1081 safety OK");
