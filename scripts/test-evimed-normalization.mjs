import assert from "node:assert/strict";
import { createJiti } from "jiti";

process.env.EVIMED_API_KEY = "shared-guide-key";
process.env.EVIMED_INSTRUCTION_API_URL = "";
process.env.EVIMED_LITERATURE_API_URL = "";
process.env.EVIMED_INSTRUCTION_API_KEY = "";
process.env.EVIMED_LITERATURE_API_KEY = "";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { buildEvidenceQuery, getEvimedEvidenceStatus, normalizeExternalEvidenceResponse } = await jiti.import("../src/lib/evimed-guide.ts");

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
    nmpa: [{ genericNames: "阿司匹林片", enterpriseName: "示例药企", approvalNumber: "国药准字H12345678", indication: "用于符合适应证的患者", pdfUrl: "https://example.org/aspirin.pdf" }],
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

const literature = normalizeExternalEvidenceResponse("literature", searchResponse);
assert.equal(literature.length, 2);
assert.ok(literature.some((item) => item.identifier === "DOI:10.1234/example.2024.1"));
assert.ok(literature.every((item) => item.title !== "Guide not part of literature bucket"));

const query = buildEvidenceQuery({
  patient: {},
  chiefComplaint: "本例张三近3日头晕",
  symptoms: { presentHistory: "头晕伴恶心", patientId: "SECRET-7788", rawMetadata: "MRN#A-12345678" },
  conversation: [],
}, "diagnose", "guide");
assert.match(query, /头晕|头晕伴恶心/);
assert.doesNotMatch(query, /张三|SECRET-7788|A-12345678/);

console.log(JSON.stringify({ cases: 14, failures: 0 }));
