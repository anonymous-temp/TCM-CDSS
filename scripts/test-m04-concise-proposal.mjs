import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { responseFormatForTask } = await jiti.import("../src/lib/model-response-format.ts");
const { compileM04Proposal, compileM04JsonObjectContent, M04ProposalSchema } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const { getM03TherapyLock } = await jiti.import("../src/lib/m03-therapy-lock.ts");
const { buildPrescribePrompt } = await jiti.import("../src/lib/diagnosis-prompts.ts");
const { m04ZeroProviderRepairQualityAnnotation } = await jiti.import("../src/lib/m04-repair-policy.ts");

const prior = {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { primarySyndrome: "脾胃虚弱证", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [
    { nodeId: "P1", patientFact: "食少倦怠", pathogenesis: "脾胃虚弱，运化无力", therapyDirection: "健脾益气" },
    { nodeId: "P2", patientFact: "大便溏薄", pathogenesis: "脾虚湿盛", therapyDirection: "健脾化湿" },
  ] },
  therapy: { overallMethod: "健脾益气，化湿和中", overallPrinciple: "虚则补之" },
};
const legacy = {
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "本例辨证组方", therapyMatch: "模型复写的治法不应覆盖M03",
    applicable: "食少倦怠与便溏并见，健脾益气同时兼顾化湿。",
    notApplicable: "便溏加重或出现腹痛时重新评估。",
    herbs: [
      { name: "党参", dose: "12g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "补脾益气，改善食少倦怠" },
      { name: "白术", dose: "10g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾燥湿，兼顾便溏" },
      { name: "茯苓", dose: "12g", role: "佐", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾渗湿" },
      { name: "炙甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "补脾和胃" },
    ].map((herb) => ({ ...herb, processing: null, isToxic: false, decoctionRequirement: null })),
    formulaAnalysis: "党参为君补脾益气以改善食少倦怠，白术为臣健脾燥湿以助运化，茯苓为佐渗湿兼顾便溏，炙甘草为使补脾和胃、协调诸药。",
    decoction: { doseCount: "6剂", dosesPerDay: 2, administrationTimesPerDay: 2, course: "3日", method: "每日两剂分两次温服", followUpNode: "服完三日复诊，便溏加重提前复诊" },
  },
  patentAndWestern: [], modifications: [],
  modificationReview: { submittedCount: 0, retainedCount: 0, droppedCount: 0, droppedReason: null, droppedReasons: [] },
  nonPharma: { diet: "早餐可用山药小米粥，少量多餐。", lifestyle: "规律作息，餐后适量散步。", emotion: "保持心情舒畅。", acupointCare: null, tcmTreatments: [], precautions: ["每日观察食欲与便溏变化，若持续加重请提前复诊。"] },
};
const compact = structuredClone(legacy);
delete compact.schemaVersion;
delete compact.modificationReview;
delete compact.candidate.therapyMatch;
delete compact.candidate.decoction.course;
delete compact.nonPharma.acupointCare;

const schema = responseFormatForTask("qwen3.7-plus", "m04_proposal").json_schema.schema;
const resolve = (node) => node?.$ref ? schema.$defs[node.$ref.split("/").at(-1)] : node;
const candidateSchema = resolve(schema.properties.candidate);
const decoctionSchema = resolve(candidateSchema.properties.decoction);
const nonPharmaSchema = resolve(schema.properties.nonPharma);

test("provider omits only authoritative server fields while retaining clinical fields", () => {
  for (const [node, omitted] of [[schema, ["schemaVersion", "modificationReview"]], [candidateSchema, ["therapyMatch"]], [decoctionSchema, ["course"]], [nonPharmaSchema, ["acupointCare"]]]) {
    for (const key of omitted) {
      assert.equal(Object.hasOwn(node.properties, key), false, `${key} must not cost provider output tokens`);
      assert.equal(node.required.includes(key), false);
    }
  }
  for (const key of ["name", "applicable", "notApplicable", "herbs", "formulaAnalysis", "decoction"]) assert.ok(candidateSchema.properties[key]);
  const herb = resolve(candidateSchema.properties.herbs.items);
  for (const key of ["name", "dose", "role", "targetKind", "targetRef", "structureRole", "function", "isToxic", "decoctionRequirement"]) assert.ok(herb.properties[key]);
});

test("compact and full legacy proposal produce identical canonical clinical output", () => {
  const full = compileM04Proposal(legacy, prior);
  const short = compileM04JsonObjectContent(JSON.stringify(compact), prior);
  assert.ok(full);
  assert.deepEqual(short, full);
  assert.equal(short.schemaVersion, "tcm-cdss-reasoning-v2");
  assert.equal(short.formula.candidates[0].therapyMatch, getM03TherapyLock(prior).candidateMatch);
  assert.equal(short.formula.candidates[0].decoction.course, "3日");
  assert.equal(short.nonPharma.acupointCare, null);
  assert.equal(M04ProposalSchema.safeParse(legacy).success, true, "legacy shared parsing contract remains available");
});

test("individual herb functions, whole-formula explanation and clinical boundaries survive", () => {
  const result = compileM04Proposal(compact, prior).formula.candidates[0];
  for (const key of ["formulaAnalysis", "applicable", "notApplicable"]) assert.equal(result[key], legacy.candidate[key]);
  for (const [index, herb] of result.herbs.entries()) {
    for (const key of ["name", "dose", "role", "targetRef", "function"]) assert.equal(herb[key], legacy.candidate.herbs[index][key]);
    assert.doesNotMatch(herb.function, /由服务端生成/);
  }
  assert.equal(result.decoction.method, legacy.candidate.decoction.method);
  assert.equal(result.decoction.followUpNode, legacy.candidate.decoction.followUpNode);
});

test("legacy conservative toxicity flag and server modification accounting retain their behavior", () => {
  const flagged = structuredClone(compact);
  flagged.candidate.herbs[0].isToxic = true;
  flagged.modificationReview = { ...legacy.modificationReview, submittedCount: 20, retainedCount: 20 };
  const result = compileM04Proposal(flagged, prior);
  assert.equal(result.formula.candidates[0].herbs[0].isToxic, true);
  assert.equal(result.formula.modificationReview.submittedCount, 0, "provider cannot invent server review counts");
});

test("optional warnings remain advice and malformed warning rows cannot discard the candidate", () => {
  const warned = structuredClone(compact);
  warned.nonPharma.precautions.push({ metric: "食欲" }, "自行加用10g党参");
  const result = compileM04Proposal(warned, prior);
  assert.ok(result);
  assert.equal(result.nonPharma.precautions.includes(compact.nonPharma.precautions[0]), true);
  assert.deepEqual(result.formula.candidates[0].herbs, compileM04Proposal(compact, prior).formula.candidates[0].herbs);
  assert.match(m04ZeroProviderRepairQualityAnnotation({ status: "repair", issueCode: "herb_plan_mismatch", repairFocus: "emperor_role" }), /君药/);
});

test("M04 prompt assigns one clinical purpose per explanation without requesting owned fields", () => {
  const prompt = buildPrescribePrompt({ patient: {}, chiefComplaint: "食少倦怠", conversation: [] });
  assert.doesNotMatch(prompt, /"schemaVersion"\s*:\s*"tcm-cdss-m04-proposal-v1"/);
  assert.match(prompt, /单一信息源/);
  assert.match(prompt, /不在多个字段重复/);
  assert.match(prompt, /formulaAnalysis/);
  assert.match(prompt, /10–30 字/);
  assert.equal(prompt.includes("药味功用、方义、适用边界或证据字段；这些全部由服务端生成"), false,
    "prompt must not forbid the individualized clinical explanations the provider schema retains");
});

test("compact fixture reports measurable wire reduction without shrinking clinical prose", () => {
  const fullChars = JSON.stringify(legacy).length;
  const compactChars = JSON.stringify(compact).length;
  assert.ok(compactChars < fullChars);
  console.log(JSON.stringify({ suite: "m04-concise-proposal", fixtureOutputChars: { full: fullChars, compact: compactChars, saved: fullChars - compactChars }, providerSchemaChars: JSON.stringify(schema).length }));
});
