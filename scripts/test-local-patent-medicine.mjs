import assert from "node:assert/strict";
import { createJiti } from "jiti";

process.env.AI_TEXT_PROVIDER = "openai";
process.env.OPENAI_API_KEY = "";
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
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
const { findLocalPatentMedicineEntry } = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
const { parseMedicationLabelUsage } = await jiti.import("../src/lib/medication-label-usage.ts");
assert.ok(deterministicPlan.candidates.every((candidate) => {
  const entry = findLocalPatentMedicineEntry(candidate.name);
  const expected = parseMedicationLabelUsage(entry?.usage || "");
  return candidate.type === "中成药" &&
    candidate.evidenceId.startsWith("LOCAL-INST-") &&
    candidate.singleDose === (expected.singleDose || null) &&
    candidate.frequency === (expected.frequency || null) &&
    candidate.route === (expected.route || null) &&
    candidate.course === (expected.course || null);
}), "server-owned candidates must expose only usage fields parsed from the same bound label entry");

const deniedPlan = await planEvidenceBoundMedicineCandidates(denied);
assert.equal(deniedPlan.candidates.length, 0, "negated indications must remain empty even when the planner is unavailable");

console.log(JSON.stringify({ cases: 12, failures: 0, retrieved: candidates.length }));

// CONST-01 体质前提门(甲方评测 8.1)：说明书以气虚/阴虚等体质为前提的成药,病例无该前提证据时
// 不得入选;有证据时保留。模式与证据判定是确定性文本谓词,不做推断。
{
  const { constitutionPrerequisiteMismatch } = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
  assert.equal(
    constitutionPrerequisiteMismatch("益气解表，散风祛湿。用于气虚感冒，恶寒发热", "恶寒发热，恶寒重发热轻，无汗；风寒束表证；辛温解表"),
    "气虚",
    "风寒表实证无气虚证据时,益气解表类成药必须被体质前提门排除",
  );
  assert.equal(
    constitutionPrerequisiteMismatch("益气解表，散风祛湿。用于气虚感冒", "神疲乏力，气短懒言；气虚感冒；益气解表"),
    undefined,
    "病例确有气虚证据时不拦",
  );
  assert.equal(
    constitutionPrerequisiteMismatch("疏风解表，清热解毒。用于风热感冒", "恶寒发热；风寒束表证"),
    undefined,
    "无体质前提的说明书不进此门(风热/风寒错配由既有概念匹配与医生复核处理)",
  );
}
