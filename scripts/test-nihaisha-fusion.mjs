import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";
import { formulaMentionHits } from "./lib/formula-mention-hits.mjs";

const jiti = createJiti(import.meta.url, {
  alias: { "@": `${process.cwd()}/src` },
});
const {
  buildM02ClassicDiscriminationContext,
  buildM03SevenStageContext,
  compositionLogicForFormulaNames,
  firstFormulaContraindicationIssue,
  formulaContraindicationIssues,
  formulaDiscriminationPaths,
  rankedDifferentiationRules,
  SIX_HEALTH_FOLLOWUP_DIMENSIONS,
  textualModificationsForFormulaNames,
} = await jiti.import("../src/lib/tcm-classic-inference.ts");
const {
  buildM04ClassicSafetyContext,
  classicEvidenceForFormulaNames,
} = await jiti.import("../src/lib/tcm-classic-context.server.ts");
const {
  buildForcedIncompleteRiskFollowup,
  detectProgrammaticRedFlags,
  evaluateSafetyGate,
} = await jiti.import("../src/lib/diagnosis-safety.ts");
const { buildQuestionPrompt, buildDiagnosePrompt, buildPrescribePrompt } =
  await jiti.import("../src/lib/diagnosis-prompts.ts");

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const manifest = json("../src/data/nihaisha-fusion-manifest.json");
const aliases = json("../src/data/tcm-formula-aliases.json");
const graph = json("../src/data/tcm-formula-discrimination-graph.json");
const differentiation = json("../src/data/tcm-differentiation-rules.json");
const compositionRules = json("../src/data/tcm-formula-composition-rules.json");
const contraindicationRules = json("../src/data/tcm-contraindication-rules.json");
const textualModificationRules = json("../src/data/tcm-textual-modification-rules.json");
const caseCorpus = json("../src/data/tcm-classic-case-eval-corpus.json");
const runtimeEvidenceText = readFileSync(new URL("../src/data/tcm-classic-formula-evidence.json", import.meta.url), "utf8");
const safeEvidenceText = readFileSync(new URL("../src/data/tcm-classic-text-evidence.jsonl", import.meta.url), "utf8");
const quarantineEvidenceText = readFileSync(new URL("../src/data/tcm-classic-text-evidence-quarantine.jsonl", import.meta.url), "utf8");
const safeEvidenceRows = safeEvidenceText.trim().split("\n").map((line) => JSON.parse(line));
const quarantineEvidenceRows = quarantineEvidenceText.trim().split("\n").map((line) => JSON.parse(line));
const governedCatalog = json("../src/data/tcm-formula-governed-catalog.json");
const golden = json("./fixtures/nihaisha-formula-golden.json");
const governedCatalogRaw = readFileSync(new URL("../src/data/tcm-formula-governed-catalog.json", import.meta.url));
const governedCatalogSource = manifest.sources.find((item) =>
  item.path === "src/data/tcm-formula-governed-catalog.json");

assert.equal(manifest.evidence.inputCards, 10_538, "all PDF evidence cards must be mapped");
assert.equal(governedCatalogSource?.records, governedCatalog.entries.length, "fusion manifest catalog count must match the current governed catalog");
assert.equal(governedCatalogSource?.sha256, sha256(governedCatalogRaw), "fusion assets must be rebuilt when the governed catalog changes");
assert.equal(manifest.evidence.mappedCards, manifest.evidence.inputCards, "record-level governance cannot drop a page card");
assert.equal(safeEvidenceRows.length + quarantineEvidenceRows.length, manifest.evidence.mappedRecords);
assert.ok(manifest.evidence.mappedRecords > manifest.evidence.inputCards, "page cards must be split into record-level evidence");
const safeCardIds = new Set(safeEvidenceRows.map((row) => row.sourceCardId));
const quarantineCardIds = new Set(quarantineEvidenceRows.map((row) => row.sourceCardId));
assert.equal(new Set([...safeCardIds, ...quarantineCardIds]).size, 10_538, "record partitions must cover every source card");
assert.ok(
  [...safeCardIds].some((cardId) => quarantineCardIds.has(cardId)),
  "mixed pages must preserve safe records while quarantining only the unsafe records",
);
assert.ok(manifest.evidence.mixedSafetySourceCards > 0);
assert.ok(manifest.evidence.shanghanCoverageOf398 >= 0.8, "combined Shanghan anchors must meet the 80% acceptance threshold");
assert.ok(manifest.evidence.shanghanCoverageOf398 <= 0.86, "Shanghan coverage must not be inflated by page or lecture numbering");
assert.equal(manifest.evidence.jinguiAnchorPolicy, "chapter_paragraph_only");
assert.ok(manifest.evidence.runtimeFormulaCount >= 40, "runtime safe evidence must cover the first formula tranche");
assert.equal(manifest.evidence.runtimeRetrievalPolicy, "full_record_scan_no_prebuilt_index");
assert.equal(manifest.evidence.runtimeScannableRecords, safeEvidenceRows.length);
assert.equal(manifest.caseCorpus.records, 364, "T16 must import every distinct structured case block actually present in both source families");
assert.ok(manifest.caseCorpus.replayEligibleRecords >= 30, "T16 must retain a material offline replay pool");
assert.equal(manifest.caseCorpus.runtimeRetrievalAllowed, false, "experience cases must never enter runtime retrieval");
for (const [name, output] of Object.entries(manifest.outputs)) {
  const content = readFileSync(new URL(`../src/data/${name}`, import.meta.url));
  assert.equal(sha256(content), output.sha256, `generated asset hash drift: ${name}`);
}

for (const row of safeEvidenceRows) {
  if (row.module === "jingui") {
    assert.notEqual(row.anchorLevel, "tiaowen", "Jingui must never fabricate numbered clauses");
  }
}
assert.doesNotMatch(
  runtimeEvidenceText,
  /童子尿|人尿|生硫磺|服硫磺|生附子.{0,30}(?:使用|用到|剂量|钱|克|煎|服)|拒绝.{0,12}(?:急诊|手术|化疗|放疗)|自行.{0,8}(?:服|用|煎|灸|针)/,
  "quarantined actionable content must not leak into runtime evidence",
);
assert.ok(quarantineEvidenceText.trim().length > 0, "quarantine partition must be material, not a no-op");
assert.equal(caseCorpus.cases.length, 364);
assert.equal(caseCorpus.runtimeRetrievalAllowed, false);
assert.ok(caseCorpus.cases.filter((item) => item.replayEligible).length >= 30);
const knownMislabeledReplay = caseCorpus.cases.find((item) => item.caseId === "T16-06_other-54");
assert.equal(knownMislabeledReplay?.replayEligible, false, "known formula-label drift must stay excluded through generator rebuilds");
assert.match(knownMislabeledReplay?.dataQualityNote || "", /临床方向矛盾/);
assert.equal(caseCorpus.sourceClaimAudit.claimedCaseCount, 849);
assert.equal(caseCorpus.sourceClaimAudit.importedDistinctStructuredBlocks, 364);
assert.equal(caseCorpus.sourceClaimAudit.status, "source_material_below_claimed_target");
assert.ok(caseCorpus.cases.every((item) =>
  !("summary" in item) && !("excerpt" in item) && !("dose" in item) && item.tier === "experience"),
"T16 must contain governed evaluation fields only, without raw narrative, dose or runtime advice");
assert.ok(caseCorpus.cases.filter((item) => item.replayEligible)
  .every((item) =>
    item.expectedFormulaNames.length > 0 &&
    item.replayInput.startsWith("已记录患者事实：") &&
    !/(疫苗|生附子|硫磺|刺血|放血|童子尿|人尿|拒绝.{0,16}(?:急诊|手术|化疗|放疗)|\d+\s*(?:克|g|钱|两))/i.test(item.replayInput)));

assert.deepEqual(
  formulaMentionHits("麻黄汤证，不应重复标成黄汤", ["麻黄汤", "黄汤"]),
  ["麻黄汤"],
  "a short catalog name contained in a longer formula must not become a second evidence hit",
);
assert.deepEqual(
  formulaMentionHits("痰饮内停，尚未形成方剂结论", ["痰饮"]),
  [],
  "two-character syndrome/formula homonyms are too ambiguous for free-text substring extraction",
);
assert.deepEqual(
  formulaMentionHits("先议半夏汤，后与甘遂半夏汤鉴别", ["半夏汤", "甘遂半夏汤"]),
  ["甘遂半夏汤", "半夏汤"],
  "a separately stated shorter formula remains visible beside the longer formula",
);

const canonicalAlias = (value) => aliases.entries.find((entry) =>
  entry.canonical === value || entry.aliases.includes(value))?.canonical;
assert.equal(canonicalAlias("麻杏石甘汤"), "麻杏甘石汤");
assert.equal(canonicalAlias("葛根芩连汤"), "葛根黄芩黄连汤");
assert.ok(classicEvidenceForFormulaNames(["葛根芩连汤"]).length > 0, "alias must resolve before classic evidence lookup");
assert.equal(classicEvidenceForFormulaNames(["桂枝汤"]).length, 12, "T15 runtime lookup must scan the full record table, not the old three-row compact sample");
assert.match(compositionLogicForFormulaNames(["桂枝汤"])[0]?.summary || "", /调和营卫/);
assert.equal(differentiation.systematicReviewDimensions.length, 10, "T13 must keep all ten systematic-review dimensions");
assert.equal(differentiation.pulsePatterns.length, 16, "T13 must include 8 simple and 8 combined pulse patterns");
assert.equal(differentiation.tonguePatterns.length, 11, "T13 must include 5 simple and 6 combined tongue patterns");
assert.equal(differentiation.tonguePulseConflictRules.length, 5, "T13 must preserve all five tongue/pulse conflict cases");
assert.equal(differentiation.coldHeatEvidenceDimensions.length, 8);
assert.equal(differentiation.sixChannelFormulaRules.length, 8);
assert.equal(differentiation.combinedDiseaseRules.length, 11);
assert.equal(differentiation.treatmentOrderRules.length, 4);
assert.ok(differentiation.rules.length >= 35, "T13 question rules must be generated from all governed source tables");
assert.match(differentiation.tonguePulseConflictPolicy.runtimePolicy, /两者均降为待复核证据/);
assert.ok(graph.nodes.length >= 55, "T14 must contain the full formula-pattern node tranche");
assert.ok(graph.edges.length >= 45, "T14 must not regress to a hand-written sample edge list");
assert.ok(Object.values(manifest.clinicalRuleCoverage).every((item) => item.passed), "generated clinical-rule coverage gate must pass");
assert.equal(
  manifest.reviewQueue.filter((item) => item.type === "unconnected_formula_node").length,
  0,
  "all runtime formula nodes must have at least one governed discrimination edge",
);
assert.equal(
  manifest.reviewQueue.filter((item) => item.type === "source_case_count_gap").length,
  1,
  "the missing source cases must remain an explicit provenance gap instead of being fabricated",
);
assert.ok(compositionRules.entries.length >= 35, "T14 composition logic must cover the governed formula-node tranche");
assert.ok(contraindicationRules.rules.length >= 10, "T14 contraindication matrix must not remain a four-row sample");

const sweatRules = rankedDifferentiationRules("发热恶寒，无汗，脉紧");
assert.equal(sweatRules[0]?.id, "T13-SOLAR-SWEAT");
assert.match(sweatRules[0]?.question || "", /有汗还是无汗/);
assert.ok(formulaDiscriminationPaths(["桂枝汤"])[0]?.againstFormula === "麻黄汤");
assert.equal(
  formulaDiscriminationPaths(["桂枝汤"], "患者汗出、恶风、脉缓")[0]?.status,
  "confirmed",
  "M04 discrimination path must consume affirmed patient facts",
);
assert.equal(
  formulaDiscriminationPaths(["桂枝汤"], "患者无汗、体痛、脉紧")[0]?.status,
  "absent",
  "opposing-side facts must be visible instead of always returning unknown",
);
assert.ok(graph.edges.some((edge) =>
  edge.from === "桂枝汤" && edge.to === "麻黄汤" && /有汗\/无汗/.test(edge.discriminator)));
for (const testCase of golden.cases) {
  assert.ok(graph.edges.some((edge) =>
    testCase.relevant.includes(edge.from) && testCase.forbidden.includes(edge.to) ||
    testCase.relevant.includes(edge.to) && testCase.forbidden.includes(edge.from)),
  `golden relevant/forbidden pair must be represented in graph: ${testCase.id}`);
}

assert.equal(firstFormulaContraindicationIssue(["麻黄汤"], "患者咽干，津液不足"), "T14-MAHUANG-SWEAT-DEPLETION");
assert.equal(firstFormulaContraindicationIssue(["麻黄汤"], "患者否认咽干，无汗出不止"), undefined);
assert.equal(firstFormulaContraindicationIssue(["大承气汤"], "患者腹部喜按，辨为虚寒"), "T14-PURGE-DEFICIENCY");
assert.equal(firstFormulaContraindicationIssue(["抵当汤"], "目前服用华法林，存在活动性出血"), "T14-BLOOD-BREAKING-BLEEDING");
assert.equal(firstFormulaContraindicationIssue(["栀子豉汤"], "患者大便溏薄"), undefined, "review-only rules must not become hard prescription blocks");
assert.equal(formulaContraindicationIssues(["栀子豉汤"], "患者大便溏薄")[0]?.severity, "review", "review-only rules remain visible for clinician review");
assert.match(
  buildM04ClassicSafetyContext(["麻黄汤"], "患者咽干，津液不足"),
  /禁忌阻断 T14-MAHUANG-SWEAT-DEPLETION/,
);
assert.equal(formulaContraindicationIssues(["桂枝汤"], "一般复诊").length, 0);
assert.equal(textualModificationRules.automaticPrescriptionMutationAllowed, false);
assert.ok(textualModificationRules.entries.length >= 51, "textual modification rules must include the governed high-frequency source tranche");
// Every targeted base formula must actually be covered; the target list is a growing coverage
// commitment, so assert the invariant and a floor rather than a literal that blocks additions.
assert.ok(textualModificationRules.summary.targetBaseFormulaCount >= 14);
assert.equal(
  textualModificationRules.summary.coveredBaseFormulaCount,
  textualModificationRules.summary.targetBaseFormulaCount,
);
assert.equal(textualModificationRules.summary.sourceAnchoredRuleCount, textualModificationRules.entries.length);
assert.ok(new Set(textualModificationRules.entries.map((item) => item.baseFormula)).size >= 14);
assert.ok(textualModificationRules.entries.filter((item) => item.baseFormula === "归脾汤").length >= 4);
assert.ok(textualModificationRules.entries.every((item) =>
  safeEvidenceRows.some((row) => row.evidenceId === item.sourceEvidenceId && row.safetyClass !== "quarantine") ||
  /^T15-STABLE-SHANGHAN-L\d+$/.test(item.sourceEvidenceId)));
assert.equal(
  textualModificationsForFormulaNames(["桂枝汤"], "患者项背强，汗出，恶风")[0]?.resultingFormula,
  "桂枝加葛根汤",
);
assert.equal(
  textualModificationsForFormulaNames(["桂枝汤"], "患者否认项背强，汗出情况不详，无恶风").length,
  0,
  "negated or unknown triggers must never activate a textual modification",
);
assert.equal(
  textualModificationsForFormulaNames(["归脾汤"], "患者久患血崩，面色萎黄，并有惊悸不寐")[0]?.ruleId,
  "T14-MOD-GUIPITANG-CHRONIC-BLEEDING",
);
assert.equal(
  textualModificationsForFormulaNames(["归脾汤"], "患者否认血崩，面色萎黄，但惊悸不寐").length,
  0,
  "negated trigger must not activate newly sourced Guipi modification rules",
);
assert.equal(
  textualModificationsForFormulaNames(["六君子汤"], "患者为肉食所伤")[0]?.addHerbs[0],
  "山楂",
);
assert.match(
  buildM04ClassicSafetyContext(["桂枝汤"], "患者项背强，汗出，恶风"),
  /条文加减候选 T14-MOD-GUIZHI-GEGEN.*禁止据此自动增删药味/,
);

const baseCase = (chiefComplaint) => ({
  id: "nihaisha-fusion-test",
  phase: "question",
  patient: {},
  chiefComplaint,
  symptoms: {},
  questionRounds: 0,
  maxQuestionRounds: 1,
  conversation: [],
});
const solarCase = baseCase("发热恶寒，无汗，全身疼痛");
assert.match(buildM02ClassicDiscriminationContext(solarCase), /T13-SOLAR-SWEAT/);
assert.match(buildM03SevenStageContext(solarCase), /七阶段辨证约束/);
assert.match(buildQuestionPrompt(solarCase), /经方鉴别追问图/);
assert.match(buildDiagnosePrompt(solarCase), /方证鉴别/);

const prescribedCase = {
  ...solarCase,
  phase: "prescribe",
  safetyGate: { status: "safe", allowDiagnosis: true, allowPrescription: true, allowDosePrescription: true, missingItems: [], reasons: [], redFlags: [] },
  reasoningDiagnose: {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    overview: {
      primarySyndrome: "太阳伤寒证",
      overallPathogenesis: "风寒束表，营卫失和",
      overallTherapy: "辛温解表",
      recommendedFormulaDirection: "麻黄汤",
      recommendedFormulaNames: ["麻黄汤"],
      formulaSelectionMode: "single",
      evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" },
    },
    pathogenesis: {
      summary: "风寒束表",
      locationDifferentiation: { items: ["表"], resolution: "resolved", evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } },
      natureDifferentiation: { items: ["寒"], resolution: "resolved", evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } },
      chain: [{ nodeId: "P1", patientFact: "发热恶寒，无汗，全身疼痛", syndromeEvidence: "无汗、恶寒、身痛", pathogenesis: "风寒束表", therapyDirection: "辛温解表", evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } }],
      uncertainties: [],
    },
    therapy: { overallPrinciple: "治病求本", overallMethod: "辛温解表", subTherapies: [] },
  },
};
assert.match(buildPrescribePrompt(prescribedCase), /受控方证鉴别、经典依据与禁忌矩阵/);

const currentCritical = detectProgrammaticRedFlags(baseCase("目前辨证记录为阴盛格阳，脉微欲绝"));
assert.ok(currentCritical.some((item) => /危重中医证候术语/.test(item)));
assert.ok(evaluateSafetyGate(baseCase("目前辨证记录为戴阳证")).status === "red_flag");
assert.ok(!detectProgrammaticRedFlags(baseCase("否认戴阳证，脉象不微")).some((item) => /危重中医证候术语/.test(item)));
assert.ok(!detectProgrammaticRedFlags(baseCase("既往曾记录阴盛格阳，治疗后已恢复")).some((item) => /危重中医证候术语/.test(item)));

assert.deepEqual(
  SIX_HEALTH_FOLLOWUP_DIMENSIONS.map((item) => item.dimension),
  ["睡眠", "食欲", "大便", "小便", "四肢温度", "精力"],
);
const followup = buildForcedIncompleteRiskFollowup(baseCase("复诊咨询"));
for (const dimension of SIX_HEALTH_FOLLOWUP_DIMENSIONS) assert.match(followup, new RegExp(dimension.dimension));

const firstTranche = [
  "桂枝汤", "麻黄汤", "葛根汤", "大青龙汤", "小柴胡汤", "柴胡桂枝汤", "白虎汤", "白虎加人参汤",
  "大承气汤", "麻杏甘石汤", "四逆汤", "真武汤", "附子汤", "乌梅丸", "当归四逆汤", "炙甘草汤",
  "黄连阿胶汤", "栀子豉汤", "五苓散", "猪苓汤", "葛根黄芩黄连汤", "半夏泻心汤", "小陷胸汤",
  "芍药甘草汤", "桂枝加葛根汤", "茯苓桂枝白术甘草汤", "肾气丸", "酸枣仁汤", "麦门冬汤", "温经汤",
  "黄土汤", "白头翁汤", "四逆散", "半夏厚朴汤", "甘麦大枣汤", "小建中汤", "黄芪建中汤",
  "桂枝茯苓丸", "大黄䗪虫丸", "射干麻黄汤", "越婢加半夏汤",
];
const governedNames = new Set(governedCatalog.entries
  .filter((entry) => entry.identityLockEligible && entry.prescriptionLockEligible)
  .map((entry) => canonicalAlias(entry.name) || entry.name));
assert.deepEqual(
  firstTranche.filter((name) => !governedNames.has(canonicalAlias(name) || name)),
  [],
  "first formula tranche must be lock-eligible",
);

console.log(JSON.stringify({
  cards: manifest.evidence.inputCards,
  shanghanCoverage: manifest.evidence.shanghanCoverageOf398,
  quarantined: manifest.evidence.quarantinedRecords,
  runtimeFormulas: manifest.evidence.runtimeFormulaCount,
  t16Cases: manifest.caseCorpus.records,
  t16ReplayEligible: manifest.caseCorpus.replayEligibleRecords,
  textualModificationRules: textualModificationRules.entries.length,
  goldenCases: golden.cases.length,
  status: "ok",
}, null, 2));
