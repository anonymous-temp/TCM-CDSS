import assert from "node:assert/strict";
import { createJiti } from "jiti";

process.env.EVIMED_API_KEY = "shared-guide-key";
process.env.EVIMED_INSTRUCTION_API_URL = "";
process.env.EVIMED_LITERATURE_API_URL = "";
process.env.EVIMED_INSTRUCTION_API_KEY = "";
process.env.EVIMED_LITERATURE_API_KEY = "";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { buildEvidenceQuery, constrainExternalEvidenceResults, formatInstructionEvidenceRecord, getEvimedEvidenceStatus, normalizeExternalEvidenceResponse } = await jiti.import("../src/lib/evimed-guide.ts");
const { buildEvidenceScope, medicineEvidenceBindingValid, medicineProblemMatchesCase } = await jiti.import("../src/lib/evidence-source-validation.ts");

const status = getEvimedEvidenceStatus();
const guideStatus = status.sources.find((source) => source.kind === "guide");
const extensionStatuses = status.sources.filter((source) => source.kind !== "guide");
assert.equal(guideStatus?.configured, true, "the documented guide endpoint accepts the shared EviMed key");
assert.equal(guideStatus?.officiallyDocumented, true);
assert.equal(guideStatus?.requiredForRelease, true);
assert.ok(extensionStatuses.every((source) => !source.configured && !source.officiallyDocumented && source.requiredForRelease), "release-required live-verified sources must still require explicit endpoints and keys");

const instructionResponse = {
  code: 200,
  data: {
    nmpa: [{ genericNames: "阿司匹林片", enterpriseName: "示例药企", approvalNumber: "国药准字H12345678", specifications: "100mg", indication: "用于符合适应证的冠心病患者", contraindications: "活动性出血禁用", useInPregLact: "妊娠期慎用", pdfUrl: "https://example.org/aspirin.pdf" }],
    fda: [], ema: [], pmda: [],
  },
};
const searchResponse = {
  code: 200,
  data: {
    instructions: [{ genericNames: "阿司匹林片", enterpriseName: "示例药企", approvalNumber: "国药准字H12345678", indication: "用于符合适应证的患者", pdfUrl: "https://example.org/aspirin.pdf" }],
    paper: [{ title: "Aspirin clinical study", journal: "Example Journal", year: "2024", doi: "10.1234/example.2024.1", abstract: "study abstract" }],
    clinicalTrials: [{ officialTitle: "Aspirin clinical trial", organization: "Example Registry", year: "2025", url: "https://example.org/trial" }],
    guide: [{ title: "Guide not part of literature bucket", publisher: "Example", year: "2024" }],
  },
};

const instructions = normalizeExternalEvidenceResponse("instruction", instructionResponse);
assert.equal(instructions.length, 1);
assert.equal(instructions[0].title, "阿司匹林片");
assert.equal(instructions[0].sourceKind, "instruction");
assert.equal(instructions[0].medicineName, "阿司匹林片");
assert.equal(instructions[0].specification, "100mg");
assert.match(instructions[0].fingerprint || "", /^sha256:[a-f0-9]{64}$/);
const atomicInstructionRecord = formatInstructionEvidenceRecord({
  ...instructions[0],
  indication: "冠心病\n符合适应证者",
  contraindication: "活动性出血\r\n禁用",
}, "EVID-INST-001");
assert.doesNotMatch(atomicInstructionRecord, /[\r\n\u2028\u2029]/, "an instruction ID and every bound field must remain on one atomic evidence line");
assert.match(atomicInstructionRecord, /适应证：冠心病 符合适应证者/);
const medicineEvidenceContext = `[EVID-INST-001] 药名：阿司匹林片｜生产企业：示例药企｜规格：100mg｜适应证：用于符合适应证的冠心病患者｜禁忌/注意：活动性出血禁用｜特殊人群：妊娠期慎用｜条目指纹：${instructions[0].fingerprint}｜URL:https://example.org/aspirin.pdf`;
const medicineScope = buildEvidenceScope(medicineEvidenceContext);
assert.equal(medicineEvidenceBindingValid("EVID-INST-001", instructions[0].fingerprint, "阿司匹林片", "冠心病", "100mg", medicineScope), true);
assert.equal(medicineEvidenceBindingValid("EVID-INST-001", `sha256:${"0".repeat(64)}`, "阿司匹林片", "冠心病", "100mg", medicineScope), false, "a mismatched instruction fingerprint must fail closed");
assert.equal(medicineEvidenceBindingValid("EVID-INST-001", instructions[0].fingerprint, "华法林片", "冠心病", "100mg", medicineScope), false, "a medicine name cannot borrow another product's instruction ID");
assert.equal(medicineProblemMatchesCase("冠心病", "本次主诊断考虑冠心病，活动后胸痛"), true);
assert.equal(medicineProblemMatchesCase("冠心病", "本次主诉为湿疹伴瘙痒"), false);

const literature = normalizeExternalEvidenceResponse("literature", searchResponse);
assert.equal(literature.length, 2);
assert.ok(literature.some((item) => item.identifier === "DOI:10.1234/example.2024.1"));
assert.ok(literature.every((item) => item.title !== "Guide not part of literature bucket"));
const widenedLiterature = [
  ...literature,
  { sourceKind: "literature", title: "Old study", publisher: "Example", year: "2017" },
  { sourceKind: "literature", title: "Unknown-date study", publisher: "Example" },
];
const recentLiterature = constrainExternalEvidenceResults("literature", widenedLiterature, { count: 1, startYear: 2020 });
assert.equal(recentLiterature.length, 1, "client-owned count must be enforced when the upstream ignores it");
assert.equal(recentLiterature[0].year, "2024", "date-scoped retrieval must exclude old and undated records");
assert.equal(constrainExternalEvidenceResults("instruction", instructions, { count: 6, startYear: 2024 }).length, 1, "instruction retrieval must not invent a publication-date gate");

const query = buildEvidenceQuery({
  patient: {},
  chiefComplaint: "本例张三近3日头晕",
  symptoms: { presentHistory: "头晕伴恶心", patientId: "SECRET-7788", rawMetadata: "MRN#A-12345678" },
  conversation: [],
}, "diagnose", "guide");
assert.match(query, /头晕|头晕伴恶心/);
assert.doesNotMatch(query, /张三|SECRET-7788|A-12345678/);

console.log(JSON.stringify({ cases: 28, failures: 0 }));
