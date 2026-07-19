import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";
import { PRIMARY_CARE_SPARSE_50 } from "./fixtures/primary-care-sparse-50.mjs";
import {
  RED_FLAG_CATEGORY_VOCABULARY,
  buildSemanticM02Answer,
  evaluateM03CriticalClinicalAssertions,
  evaluateM04CandidateContract,
  evaluateRedFlagCategoryOracle,
  evaluateSemanticM02AnswerCoverage,
  evaluateStagedRedFlagCategoryOracle,
  parseQuestionBlocks,
  permissionAllowsDoseCandidate,
} from "./lib/primary-care-sparse-50-contracts.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { derivePrescriptionPermission, withSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");

describe("red-flag category-set oracle", () => {
  it("partitions every known category into required, allowed, or forbidden", () => {
    for (const testCase of PRIMARY_CARE_SPARSE_50) {
      const oracle = testCase.redFlagOracle;
      const required = new Set(oracle.required);
      const allowed = new Set(oracle.allowed);
      const forbidden = new Set(oracle.forbidden);
      assert.equal([...required].some((item) => allowed.has(item) || forbidden.has(item)), false, testCase.id);
      assert.equal([...allowed].some((item) => forbidden.has(item)), false, testCase.id);
      assert.deepEqual(new Set([...required, ...allowed, ...forbidden]), new Set(RED_FLAG_CATEGORY_VOCABULARY), testCase.id);
    }
  });

  it("requires mandatory categories, tolerates declared alternatives, and rejects extras", () => {
    const oracle = { required: ["gi_bleed"], allowed: ["shock"], forbidden: RED_FLAG_CATEGORY_VOCABULARY.filter((item) => !["gi_bleed", "shock"].includes(item)) };
    assert.equal(evaluateRedFlagCategoryOracle(["gi_bleed"], oracle).ok, true);
    assert.equal(evaluateRedFlagCategoryOracle(["gi_bleed", "shock"], oracle).ok, true);
    assert.match(evaluateRedFlagCategoryOracle(["shock"], oracle).errors.join(";"), /required_missing/);
    assert.match(evaluateRedFlagCategoryOracle(["gi_bleed", "cardiac"], oracle).errors.join(";"), /forbidden_present|unexpected_present/);
    assert.match(evaluateRedFlagCategoryOracle([], { required: [], allowed: [], forbidden: [] }).errors.join(";"), /oracle_unclassified/);
  });

  it("uses the positive oracle only at its declared stage", () => {
    const delayed = PRIMARY_CARE_SPARSE_50.find((item) => item.id === "RF05");
    assert.equal(evaluateStagedRedFlagCategoryOracle(delayed, "initial", []).ok, true);
    assert.equal(evaluateStagedRedFlagCategoryOracle(delayed, "initial", ["acute_abdomen"]).ok, false);
    assert.equal(evaluateStagedRedFlagCategoryOracle(delayed, "after_m02", ["acute_abdomen"]).ok, true);
  });
});

describe("M02 answer relevance gate", () => {
  const testCase = PRIMARY_CARE_SPARSE_50.find((item) => item.id === "D01");
  const content = [
    "问题1：黑便、呕血或体重下降目前有吗？",
    "追问理由：这些表现会改变是否急诊及后续检查。",
    "A. 有黑便、呕血或体重下降",
    "B. 均没有",
    "C. 暂不清楚",
    "",
    "问题2：腹胀与进食的时间关系如何？",
    "追问理由：时间关系有助于区分常见病因。",
    "A. 饭后半小时明显并有早饱",
    "B. 与进食无明显关系",
    "C. 暂不清楚",
  ].join("\n");
  const blocks = parseQuestionBlocks(content);

  it("rejects empty, unrelated, and partially covering simulated replies", () => {
    assert.match(evaluateSemanticM02AnswerCoverage(testCase, blocks, "").errors.join(";"), /answer_empty/);
    assert.match(evaluateSemanticM02AnswerCoverage(testCase, blocks, "今天天气不错").errors.join(";"), /answer_irrelevant/);
    assert.equal(evaluateSemanticM02AnswerCoverage(testCase, blocks, "饭后半小时最明显，吃一点就饱，大便偏稀").ok, false);
  });

  it("accepts only a grounded reply covering every asked fixture axis", () => {
    const answer = buildSemanticM02Answer(testCase, blocks);
    const evaluated = evaluateSemanticM02AnswerCoverage(testCase, blocks, answer);
    assert.equal(evaluated.ok, true, evaluated.errors.join(";"));
    assert.equal(evaluated.answeredAxisCount, 2);
  });
});

describe("M03 hard clinical assertions without an exact western-answer oracle", () => {
  const testCase = {
    canonical: {
      westernPrimaryCompatible: [/功能性消化不良/],
      westernPrimaryForbidden: [/胃癌/],
      tcmDiseaseAllowed: [/痞满/],
      tcmDiseaseForbidden: [/泄泻/],
      primarySyndromeAllowed: [/脾虚气滞/],
      primarySyndromeForbidden: [/湿热中阻/],
    },
    pathogenesisExpectations: {
      locationsAllowed: [/脾/, /胃/],
      locationsForbidden: [/肾/],
      naturesAllowed: [/虚/, /气滞/],
      naturesForbidden: [/实热/],
      mechanismsAllowed: [/脾虚.*胃失和降/],
      mechanismsForbidden: [/肾阳虚/],
      therapiesAllowed: [/健脾.*和胃/],
      therapiesForbidden: [/温补肾阳/],
      nodePairs: [{ mechanism: /胃失和降/, therapy: /和胃|降逆/ }],
    },
  };
  const diagnose = {
    westernDiagnosis: { primary: { name: "上腹胀待查" } },
    overview: {
      tcmDiseaseName: "痞满",
      primarySyndrome: "脾虚气滞证",
      overallPathogenesis: "脾虚运化失健，胃失和降",
    },
    pathogenesis: {
      summary: "脾虚胃失和降",
      locationDifferentiation: { items: ["脾", "胃"] },
      natureDifferentiation: { items: ["本虚", "气滞"] },
      chain: [{ patientFact: "饭后腹胀", syndromeEvidence: "舌淡胖", pathogenesis: "胃失和降", therapyDirection: "和胃降逆" }],
    },
    therapy: { overallPrinciple: "健脾和胃，理气消痞" },
  };

  it("keeps a conservative non-example western diagnosis as an advisory while hard-failing forbidden overdiagnosis", () => {
    const conservative = evaluateM03CriticalClinicalAssertions(diagnose, testCase);
    assert.equal(conservative.ok, true, conservative.errors.join(";"));
    assert.match(conservative.advisories.join(";"), /western_primary_outside_compatible_examples/);
    const overdiagnosed = structuredClone(diagnose);
    overdiagnosed.westernDiagnosis.primary.name = "胃癌";
    assert.equal(evaluateM03CriticalClinicalAssertions(overdiagnosed, testCase).ok, false);
  });

  it("hard-fails a key disease-pattern or mechanism-therapy contradiction", () => {
    const wrongPattern = structuredClone(diagnose);
    wrongPattern.overview.primarySyndrome = "湿热中阻证";
    assert.equal(evaluateM03CriticalClinicalAssertions(wrongPattern, testCase).ok, false);
    const wrongTherapy = structuredClone(diagnose);
    wrongTherapy.pathogenesis.chain[0].therapyDirection = "温补肾阳";
    assert.equal(evaluateM03CriticalClinicalAssertions(wrongTherapy, testCase).ok, false);
  });
});

describe("production permission and construction-specific herb counts", () => {
  const herb = (name) => ({
    name,
    dose: "6g",
    role: "臣",
    prescriptionRole: "对应病机",
    targetKind: "pathogenesis_node",
    targetRef: "P1",
    targetPathogenesis: "脾虚",
    function: "健脾",
  });
  const candidate = (constructionType, herbCount) => ({
    name: constructionType === "self_devised" || constructionType === "single_herb" ? "本例辨证组方" : "测试基础方",
    constructionType,
    formulaSource: constructionType === "self_devised" || constructionType === "single_herb"
      ? { evidenceLevel: "model_inference", source: "基于本例辨证组方" }
      : { evidenceLevel: "classic_text", source: "《虚构测试方源》" },
    therapyMatch: "健脾",
    formulaAnalysis: "药味共同对应本例病机",
    applicable: "辨证一致时供医生复核",
    notApplicable: "证候变化时不适用",
    herbs: Array.from({ length: herbCount }, (_, index) => herb(`测试药${index + 1}`)),
    decoction: { doseCount: "1剂", method: "水煎", course: "1日", followUpNode: "次日复核" },
  });
  const options = {
    doseLimit: () => ({ min: 1, max: 30 }),
    pairIssues: () => [],
    pathogenesisChain: [{ nodeId: "P1", pathogenesis: "脾虚" }],
  };
  const evaluates = (constructionType, count) => evaluateM04CandidateContract(
    { formula: { candidates: [candidate(constructionType, count)] } },
    {},
    options,
  );

  it("applies different composition cardinality to each construction type", () => {
    assert.equal(evaluates("single_herb", 1).ok, true);
    assert.equal(evaluates("single_herb", 2).ok, false);
    assert.equal(evaluates("single_base", 1).ok, true);
    assert.equal(evaluates("combined", 1).ok, false);
    assert.equal(evaluates("combined", 2).ok, true);
    assert.equal(evaluates("self_devised", 3).ok, false);
    assert.equal(evaluates("self_devised", 4).ok, true);
    assert.equal(evaluates("unknown", 4).ok, false);
  });

  it("maps only real full/limited production permissions to dose-bearing candidates", () => {
    assert.equal(permissionAllowsDoseCandidate({ candidateMode: "full_dose" }), true);
    assert.equal(permissionAllowsDoseCandidate({ candidateMode: "limited_dose" }), true);
    assert.equal(permissionAllowsDoseCandidate({ candidateMode: "non_dose_only" }), false);
    assert.equal(permissionAllowsDoseCandidate({ candidateMode: "blocked" }), false);

    const fixture = PRIMARY_CARE_SPARSE_50.find((item) => item.id === "G04");
    const state = withSafetyGate({
      id: "fictional-permission-g04",
      phase: "prescribe",
      patient: { age: fixture.age, sex: fixture.sex },
      chiefComplaint: fixture.chief,
      symptoms: { presentHistory: `${fixture.initial}；${fixture.answer}`, tcmDetail: fixture.answer },
      tongue: "舌红苔黄腻",
      pulse: "",
      vitals: {},
      pastHistory: "",
      medicationHistory: "",
      allergyHistory: "",
      conversation: [],
      questionRounds: 1,
      maxQuestionRounds: 1,
    });
    const permission = derivePrescriptionPermission(state);
    assert.equal(permission.candidateMode, "limited_dose");
    assert.equal(permissionAllowsDoseCandidate(permission), true, "unknown pregnancy is a limited-dose review state, not a fabricated non-dose fixture override");
  });
});
