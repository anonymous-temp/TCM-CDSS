import assert from "node:assert/strict";
import { createJiti } from "jiti";

process.env.AI_TEXT_PROVIDER = "openai";
process.env.OPENAI_API_KEY = "";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const {
  buildLocalPatentMedicineContext,
  retrieveLocalPatentMedicineCandidates,
} = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
const {
  buildEvidenceScope,
  medicineEvidenceBindingValid,
} = await jiti.import("../src/lib/evidence-source-validation.ts");
const { planEvidenceBoundMedicineCandidates } = await jiti.import("../src/lib/medicine-candidate-planner.server.ts");

function caseState(chiefComplaint, symptoms = {}) {
  return {
    patient: {},
    chiefComplaint,
    symptoms,
    conversation: [],
  };
}

const insomnia = caseState("入睡困难伴多梦1个月", { presentHistory: "每晚入睡需2小时，夜醒2次" });
const candidates = retrieveLocalPatentMedicineCandidates(insomnia, 6);
assert.ok(candidates.length > 0, "a current positive indication must retrieve local label candidates");
assert.ok(candidates.every((candidate) => candidate.matchedConcepts.includes("失眠")));
assert.ok(candidates.every((candidate) => /^sha256:[a-f0-9]{64}$/.test(candidate.fingerprint)));

const context = buildLocalPatentMedicineContext(insomnia, 6);
const first = candidates[0];
const scope = buildEvidenceScope(context);
assert.equal(
  medicineEvidenceBindingValid(first.id, first.fingerprint, first.name, "失眠", first.specification, scope),
  true,
  "the exact local label ID, fingerprint, medicine name, specification and indication must bind",
);
assert.equal(
  medicineEvidenceBindingValid(first.id, first.fingerprint, "伪造药名", "失眠", first.specification, scope),
  false,
  "a valid local fingerprint cannot be borrowed by another medicine",
);

const denied = caseState("体检咨询", { presentHistory: "否认失眠、头痛、咳嗽、发热、腹痛、腹泻及便秘" });
assert.equal(
  retrieveLocalPatentMedicineCandidates(denied, 6).length,
  0,
  "negated symptoms must not retrieve a medicine candidate",
);

const sparse = caseState("乏力");
assert.ok(
  retrieveLocalPatentMedicineCandidates(sparse, 6).length > 0,
  "a single positive symptom may retrieve bounded label candidates instead of being discarded by an arbitrary score threshold",
);
const syndromeOnly = {
  ...caseState("复诊调理"),
  reasoningDiagnose: {
    overview: { primarySyndrome: "心脾两虚证", primarySyndromeBasis: ["心悸", "多梦"] },
    westernDiagnosis: { primary: { name: "失眠障碍", supportingFacts: ["多梦"] } },
  },
};
const syndromeCandidates = retrieveLocalPatentMedicineCandidates(syndromeOnly, 10);
assert.ok(
  syndromeCandidates.some((candidate) => candidate.matchedConcepts.includes("心脾两虚")),
  "syndrome alignment must be indexed and ranked as a primary medicine-candidate signal",
);

const deterministicPlan = await planEvidenceBoundMedicineCandidates(insomnia);
assert.ok(deterministicPlan.candidates.length > 0, "a strong local instruction match must survive planner unavailability");
assert.ok(deterministicPlan.candidates.every((candidate) =>
  candidate.type === "中成药" &&
  candidate.evidenceId.startsWith("LOCAL-INST-") &&
  candidate.singleDose == null &&
  candidate.frequency == null &&
  candidate.course == null), "the server-owned fallback may expose evidence-bound candidates but must never invent an executable regimen");

const deniedPlan = await planEvidenceBoundMedicineCandidates(denied);
assert.equal(deniedPlan.candidates.length, 0, "negated indications must remain empty even when the planner is unavailable");

console.log(JSON.stringify({ cases: 12, failures: 0, retrieved: candidates.length }));
