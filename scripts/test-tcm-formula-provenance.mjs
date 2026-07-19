import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  applyDeterministicFormulaReferences,
  enrichPrescriptionProvenance,
  executableFormulaCompilationReferences,
  formulaCompilationContractIssue,
  formulaCompilationReferences,
  identifyKnownFormulaNames,
  resolveFormulaSources,
} = await import("../src/lib/tcm-formula-provenance.ts");

const herbs = (...names) => names.map((name) => ({ name }));
const formulaCatalog = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-sources.json", import.meta.url), "utf8"));

for (const [name, entry] of Object.entries(formulaCatalog.officialClassicFormulas)) {
  const resolved = resolveFormulaSources(name, herbs(...entry.ingredients));
  assert.equal(resolved[0]?.source, entry.source, `official classic must resolve against its own governed composition: ${name}`);
}

for (const phrase of [
  "建议优先采用归脾汤",
  "推荐方为归脾汤",
  "可考虑归脾汤",
  "拟归脾汤",
  "推荐以归脾汤加减为主",
]) {
  assert.deepEqual(identifyKnownFormulaNames(phrase), ["归脾汤"], `natural-language direction must resolve by catalog: ${phrase}`);
}
assert.deepEqual(identifyKnownFormulaNames("归脾汤合参苓白术散加减"), ["归脾汤", "参苓白术散"]);
assert.deepEqual(identifyKnownFormulaNames("归脾汤或酸枣仁汤酌选"), ["归脾汤", "酸枣仁汤"]);
assert.deepEqual(identifyKnownFormulaNames("自拟归脾安神方"), [], "self-devised labels must not inherit a classic identity by substring");
assert.deepEqual(identifyKnownFormulaNames("首选归脾汤加减，若疗效欠佳再自拟安神方"), ["归脾汤"], "a later self-devised fallback must not erase the governed first choice");
assert.deepEqual(identifyKnownFormulaNames("不建议使用归脾汤，改按病机辨证组方"), [], "a negated classic must not become the governed formula");
assert.deepEqual(identifyKnownFormulaNames("禁用四逆汤，建议急诊评估"), [], "a prohibited classic must not become the governed formula");
assert.deepEqual(identifyKnownFormulaNames("归脾汤仅作鉴别，建议使用酸枣仁汤"), ["酸枣仁汤"], "an identification-only formula must not override the positively recommended formula");
assert.deepEqual(identifyKnownFormulaNames("禁用归脾汤，改用酸枣仁汤"), ["酸枣仁汤"], "formula polarity must follow the positive branch after a switch");
for (const phrase of ["严禁使用归脾汤，改用酸枣仁汤", "不得使用归脾汤，改予酸枣仁汤", "不可采用归脾汤，首选酸枣仁汤", "禁忌使用归脾汤，建议采用酸枣仁汤"]) {
  assert.deepEqual(identifyKnownFormulaNames(phrase), ["酸枣仁汤"], `prohibited formula must never become a governed candidate: ${phrase}`);
}
for (const phrase of ["归脾汤为本例禁忌，改用酸枣仁汤", "归脾汤应避免使用，改用酸枣仁汤", "本例不予选用归脾汤，改用酸枣仁汤", "归脾汤不应继续使用，改用酸枣仁汤", "归脾汤属于禁忌方，改用酸枣仁汤"]) {
  assert.deepEqual(identifyKnownFormulaNames(phrase), ["酸枣仁汤"], `postposed prohibition must control formula polarity: ${phrase}`);
}
for (const phrase of ["归脾汤在本例为禁忌，改用酸枣仁汤", "归脾汤对该患者属于禁忌，改用酸枣仁汤", "归脾汤存在使用禁忌，改用酸枣仁汤", "归脾汤当前不予使用，改用酸枣仁汤", "归脾汤暂停使用，改用酸枣仁汤", "归脾汤，本例禁用；改用酸枣仁汤"]) {
  assert.deepEqual(identifyKnownFormulaNames(phrase), ["酸枣仁汤"], `contextual postposed prohibition must control polarity: ${phrase}`);
}
for (const phrase of ["补汤药调理", "采用膏药外敷", "红油样分泌物", "考虑食疗炒面"]) {
  assert.deepEqual(identifyKnownFormulaNames(phrase), [], `short common-noun catalog entry must not become a formula identity: ${phrase}`);
}
assert.deepEqual(identifyKnownFormulaNames("白散"), [], "an unverified two-character local name must not be auto-attributed");
const guipiCompilation = formulaCompilationReferences(["归脾汤"]);
assert.equal(guipiCompilation.length, 1, "a governed M03 formula must provide one deterministic M04 compilation anchor");
assert.equal(guipiCompilation[0].formulaName, "归脾汤");
assert.match(guipiCompilation[0].source, /济生/);
assert.ok(["人参", "黄芪", "白术", "茯苓"].every((name) => guipiCompilation[0].ingredients.includes(name)), "归脾汤 compilation anchor must preserve its canonical core tonic composition");
assert.equal(guipiCompilation[0].minimumPreservedIngredientCount, 7, "归脾汤 compilation anchor must expose the same 80% preservation threshold enforced after generation");
assert.ok(guipiCompilation[0].requiredIngredients.includes("白术"), "归脾汤 compilation anchor must expose its identity anchor to the model repair contract");
const xiaoyaoCompilation = formulaCompilationReferences(["逍遥散"]);
assert.equal(xiaoyaoCompilation.length, 1, "a governed 逍遥散 must resolve to one controlled 局方 baseline");
assert.match(xiaoyaoCompilation[0].source, /局方.*卷九/);
assert.ok(["柴胡", "白芍", "当归", "白术"].every((name) => xiaoyaoCompilation[0].ingredients.includes(name)));
assert.deepEqual(formulaCompilationReferences(["不存在方"]), [], "unknown names must never acquire a fabricated compilation anchor");
assert.deepEqual(formulaCompilationReferences(["四物汤"]), [], "a multi-composition local name without official or verified governance must not choose the first workbook row as a compilation anchor");
const dangguiLiuhuangCompilation = executableFormulaCompilationReferences(["当归六黄汤"]);
assert.equal(dangguiLiuhuangCompilation.length, 1, "当归六黄汤 must be executable after historical relative-dose text is removed from the herb identity");
assert.ok(dangguiLiuhuangCompilation[0].ingredients.includes("黄芪"));
assert.ok(!dangguiLiuhuangCompilation[0].ingredients.some((name) => /加一倍|如鸡子大/.test(name)));
const canonicalGancao = identifyKnownFormulaNames("甘草汤");
assert.deepEqual(canonicalGancao, ["甘草汤"]);
assert.deepEqual(identifyKnownFormulaNames(canonicalGancao[0]), canonicalGancao, "formula canonicalization must be idempotent");

const referencedDiagnose = applyDeterministicFormulaReferences([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    overview: { recommendedFormulaDirection: "归脾汤或酸枣仁汤酌选", recommendedFormulaNames: ["伪造方"], formulaSelectionMode: "combined" },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
const referencedDiagnoseJson = JSON.parse(referencedDiagnose.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.deepEqual(referencedDiagnoseJson.overview.recommendedFormulaNames, ["归脾汤", "酸枣仁汤"]);
assert.equal(referencedDiagnoseJson.overview.formulaSelectionMode, "alternatives");

const ambiguousNamedDirection = applyDeterministicFormulaReferences([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaDirection: "四物汤加减" } }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
const ambiguousNamedDirectionJson = JSON.parse(ambiguousNamedDirection.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.deepEqual(ambiguousNamedDirectionJson.overview.recommendedFormulaNames, []);
assert.equal(ambiguousNamedDirectionJson.overview.formulaSelectionMode, "self_devised");
assert.equal(ambiguousNamedDirectionJson.overview.recommendedFormulaDirection, "按已锁定病机与治法辨证组方");

const combinedWithUnrelatedOr = applyDeterministicFormulaReferences([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaDirection: "归脾汤合酸枣仁汤加减，或根据症状调整剂量" } }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
const combinedWithUnrelatedOrJson = JSON.parse(combinedWithUnrelatedOr.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(combinedWithUnrelatedOrJson.overview.formulaSelectionMode, "combined");

const trailingAlternative = applyDeterministicFormulaReferences([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaDirection: "归脾汤与酸枣仁汤酌情选用" } }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
const trailingAlternativeJson = JSON.parse(trailingAlternative.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(trailingAlternativeJson.overview.formulaSelectionMode, "alternatives");

const referencedPrescribe = applyDeterministicFormulaReferences([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    overview: {},
    formula: { candidates: [{ name: "建议采用归脾汤加减", formulaNames: ["伪造方"] }] },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
const referencedPrescribeJson = JSON.parse(referencedPrescribe.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.deepEqual(referencedPrescribeJson.formula.candidates[0].formulaNames, ["归脾汤"]);

const official = resolveFormulaSources(
  "旋覆代赭汤",
  herbs("旋覆花", "人参", "代赭石", "甘草", "半夏", "生姜", "大枣"),
);
assert.equal(official.length, 1);
assert.equal(official[0].source, "《伤寒论》");
assert.equal(official[0].origin, "official_classic_catalog");

assert.deepEqual(
  resolveFormulaSources("旋覆代赭汤", herbs("黄芪", "白术", "茯苓", "甘草")),
  [],
  "same-name, wrong-composition formula must not receive a classic source",
);
const modernGuipi = resolveFormulaSources(
  "归脾汤加减",
  herbs("人参", "黄芪", "白术", "龙眼肉", "酸枣仁", "茯苓", "木香", "甘草", "山药", "白扁豆"),
);
assert.equal(modernGuipi[0]?.formulaName, "归脾汤", "modern 黄芪 spelling plus a clinically explicit modification must retain the governed 归脾汤 identity");
assert.match(modernGuipi[0]?.source || "", /济生/);
const inferredModernGuipi = resolveFormulaSources(
  "归脾汤",
  herbs("白术", "茯苓", "黄芪", "龙眼肉", "酸枣仁", "人参", "木香", "甘草", "生姜", "大枣"),
);
assert.equal(inferredModernGuipi[0]?.formulaName, "归脾汤", "composition-preserving additions must infer a modified formula even when the model omits 加减 in the label");
const fushenModifiedGuipi = resolveFormulaSources(
  "归脾汤加减",
  herbs("人参", "白术", "黄耆", "龙眼肉", "酸枣仁", "茯神", "木香", "甘草", "山药", "夜交藤"),
);
assert.equal(fushenModifiedGuipi[0]?.formulaName, "归脾汤", "a clearly labeled 归脾汤 modification may retain provenance when the remaining governed identity floor and anchors are present");
assert.equal(fushenModifiedGuipi[0]?.exactComposition, false, "茯神 must never be treated as an exact 茯苓 composition match");
assert.deepEqual(
  resolveFormulaSources("自拟安神方", herbs("酸枣仁", "茯神", "夜交藤", "远志")),
  [],
  "explicit self-devised formulas must never be attributed by name",
);
const verifiedSuanzaoren = resolveFormulaSources(
  "酸枣仁汤加减",
  herbs("酸枣仁", "川芎", "知母", "茯苓", "甘草", "夜交藤", "合欢皮"),
);
assert.equal(verifiedSuanzaoren[0]?.source, "《金匮要略》");
assert.equal(verifiedSuanzaoren[0]?.origin, "verified_reference_catalog");
const modifiedSuanzaoren = resolveFormulaSources(
  "酸枣仁汤加减",
  herbs("酸枣仁", "川芎", "知母", "甘草", "夜交藤", "合欢皮", "白芍", "当归"),
);
assert.equal(modifiedSuanzaoren[0]?.source, "《金匮要略》", "a verified modified formula may omit one base herb while retaining at least 80% of its core");
const annotatedSuanzaoren = resolveFormulaSources(
  "酸枣仁汤加减（《金匮要略》）",
  herbs("酸枣仁", "川芎", "知母", "甘草", "夜交藤", "合欢皮"),
);
assert.equal(annotatedSuanzaoren[0]?.source, "《金匮要略》", "a model-added source annotation must not contaminate formula-name matching");
assert.deepEqual(
  resolveFormulaSources("酸枣仁汤", herbs("酸枣仁", "知母", "川芎", "甘草", "夜交藤")),
  [],
  "an unmodified classic formula name must not inherit the source when any core herb is missing",
);
assert.deepEqual(
  resolveFormulaSources("酸枣仁汤加减", herbs("酸枣仁", "知母", "甘草", "夜交藤", "合欢皮", "白芍", "当归", "远志")),
  [],
  "a named modified formula missing more than 20% of its verified core must not inherit the classic source",
);
const sameNameVariant = resolveFormulaSources(
  "酸枣仁汤",
  herbs("酸枣仁", "人参", "石膏", "赤茯苓", "知母", "甘草"),
);
assert.equal(sameNameVariant[0]?.source, "《圣济总录》卷三十二。");
assert.equal(sameNameVariant[0]?.origin, "local_formula_catalog");
assert.notEqual(sameNameVariant[0]?.source, "《金匮要略》", "a verified common formula must not overwrite a better same-name variant");
const verifiedXiangsha = resolveFormulaSources(
  "香砂六君子汤加减",
  herbs("人参", "白术", "茯苓", "炙甘草", "陈皮", "半夏", "砂仁", "木香", "生姜"),
);
assert.equal(verifiedXiangsha[0]?.source, "《古今名医方论》卷一引柯韵伯方。");
assert.equal(verifiedXiangsha[0]?.origin, "local_formula_catalog", "unsupported supplemental URL must not be promoted as a verified reference");
assert.deepEqual(
  resolveFormulaSources("香砂六君子汤加减", herbs("人参", "白术", "茯苓", "炙甘草", "陈皮")),
  [],
  "a partial formula missing 半夏、砂仁、木香 must not inherit the verified classic source",
);
const xiangshaKouchi = resolveFormulaSources(
  "香砂六君子汤",
  herbs("人参", "白术", "茯苓", "半夏", "陈皮", "藿香", "甘草", "宿砂仁"),
);
assert.equal(xiangshaKouchi[0]?.source, "《口齿类要》。", "an exact same-name local variant must outrank a less similar verified supplement");
const xiangshaMingyi = resolveFormulaSources(
  "香砂六君子汤",
  herbs("人参", "白术", "茯苓", "甘草", "陈皮", "半夏", "香附", "藿香", "砂仁"),
);
assert.equal(xiangshaMingyi[0]?.source, "《明医杂著》卷六。", "all same-name variants must participate in one global ranking");

const combined = resolveFormulaSources(
  "旋覆代赭汤合温胆汤加减",
  herbs("旋覆花", "人参", "代赭石", "甘草", "半夏", "生姜", "大枣", "竹茹", "枳实", "陈皮", "茯苓"),
);
assert.equal(combined.length, 2, "a combined formula must verify every named base formula");
assert.deepEqual(combined.map((item) => item.source), ["《伤寒论》", "《三因》卷九。"], "combined-formula provenance follows the closest composition, not catalog prestige alone");
assert.deepEqual(
  resolveFormulaSources(
    "旋覆代赭汤合温胆汤",
    herbs("旋覆花", "人参", "代赭石", "甘草", "半夏", "生姜", "竹茹", "陈皮", "茯苓"),
  ),
  [],
  "an unmodified combined formula must contain every base ingredient and no unexplained additions",
);
assert.deepEqual(
  resolveFormulaSources("旋覆代赭汤合温胆汤加减", herbs("旋覆花", "人参", "代赭石", "甘草")),
  [],
  "a partially matched combined formula must not be presented as verified",
);
assert.deepEqual(
  resolveFormulaSources("六半汤", herbs("芍药", "白芍药")),
  [],
  "two candidate aliases must not consume the same canonical ingredient twice",
);
assert.deepEqual(
  resolveFormulaSources("麻黄汤合不存在方", herbs("麻黄", "桂枝", "甘草", "杏仁")),
  [],
  "an unknown combined-formula segment must reject the whole provenance claim",
);
assert.deepEqual(
  resolveFormulaSources("麻黄汤", herbs("黄", "桂", "草", "杏")),
  [],
  "single-character substrings must not impersonate canonical herb names",
);
assert.deepEqual(
  resolveFormulaSources("清胃散", herbs("当归", "黄连", "熟地黄", "牡丹皮", "升麻")),
  [],
  "生地黄换为熟地黄属于药味变更，不能继承未标加减的经典出处",
);
assert.deepEqual(
  resolveFormulaSources("真武汤加减", herbs("茯苓", "芍药", "生姜", "白术")),
  [],
  "经典加减方缺少安全核心药附子时不得继承出处",
);
assert.deepEqual(
  resolveFormulaSources("半夏泻心汤加减", herbs("黄芩", "干姜", "人参", "甘草", "黄连", "大枣")),
  [],
  "经典加减方缺少方名核心药半夏时不得继承出处",
);
const lily = resolveFormulaSources("百合地黄汤", herbs("百合", "生地黄汁"));
assert.equal(lily[0]?.source, "《金匮要略》");
assert.deepEqual(
  resolveFormulaSources("百合地黄汤", herbs("生地黄汁")),
  [],
  "a formula missing 百合 must not match after quantity parsing",
);
const lilyCombined = resolveFormulaSources(
  "百合地黄汤合桃核承气汤",
  herbs("百合", "生地黄汁", "桃仁", "大黄", "桂枝", "甘草", "芒硝"),
);
assert.equal(lilyCombined.length, 2, "formula names containing 合 must survive combined-formula tokenization");
const juyuan = resolveFormulaSources("举元煎", herbs("人参", "黄芪", "炙甘草", "升麻", "白术"));
assert.equal(juyuan[0]?.source, "《景岳全书》", "wrapped herb names and quantity ranges must not corrupt official classics");

function reasoning(candidate) {
  return {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    formula: { candidates: [candidate], patentAndWestern: null, modifications: [] },
  };
}

function candidate(name, names) {
  return {
    name,
    positioning: "首选",
    formulaSource: { evidenceLevel: "insufficient", source: "内部证据缺口", confidence: "低" },
    therapyMatch: "测试",
    applicable: "测试",
    notApplicable: "测试",
    herbs: names.map((name) => ({
      name, processing: null, dose: "6g", role: "佐", prescriptionRole: "测试",
      targetPathogenesis: "测试", function: "测试",
      evidence: { evidenceLevel: "insufficient", source: "内部证据缺口", confidence: "低" },
    })),
    formulaAnalysis: "测试",
    decoction: { doseCount: "3剂", method: "水煎服", course: "3日", followUpNode: "3日复诊" },
  };
}

function render(value) {
  return [
    `### 候选处方1：${value.formula.candidates[0].name}`,
    "**方剂出处或依据**：证据不足/待检索",
    "<!-- DIAGNOSIS_JSON_START -->",
    JSON.stringify(value),
    "<!-- DIAGNOSIS_JSON_END -->",
  ].join("\n");
}

function parsedReasoning(content) {
  return JSON.parse(content.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
}

const enrichedOfficial = enrichPrescriptionProvenance(render(reasoning(candidate(
  "旋覆代赭汤加减",
  ["旋覆花", "人参", "代赭石", "甘草", "半夏", "生姜", "大枣"],
))));
assert.match(enrichedOfficial, /\*\*参考基础方及出处\*\*[：:]旋覆代赭汤：《伤寒论》/);
assert.doesNotMatch(enrichedOfficial, /证据不足|待检索/);
const officialJson = JSON.parse(enrichedOfficial.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(officialJson.formula.candidates[0].constructionType, "single_base");
assert.equal(officialJson.formula.candidates[0].formulaSource.confidence, "中");
assert.equal(officialJson.formula.candidates[0].baseFormulas[0].matchedIngredientCount, 7);
assert.equal(officialJson.formula.candidates[0].baseFormulas[0].totalIngredientCount, 7);

const inferredModifiedGuipi = enrichPrescriptionProvenance(render(reasoning(candidate(
  "归脾汤",
  ["白术", "茯苓", "黄芪", "龙眼肉", "酸枣仁", "人参", "木香", "甘草", "生姜", "大枣"],
))));
const inferredModifiedGuipiJson = JSON.parse(inferredModifiedGuipi.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(inferredModifiedGuipiJson.formula.candidates[0].name, "归脾汤加减", "server display must expose composition-inferred modification instead of calling a changed formula canonical");
assert.equal(inferredModifiedGuipiJson.formula.candidates[0].modificationStatus, "modified");
assert.deepEqual(inferredModifiedGuipiJson.formula.candidates[0].formulaNames, ["归脾汤"]);
const guipiPrior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaNames: ["归脾汤"], formulaSelectionMode: "single" } };
assert.equal(formulaCompilationContractIssue(inferredModifiedGuipiJson, guipiPrior), undefined, "the final formula must match the exact governed compilation baseline");
const preparedGuipi = resolveFormulaSources("归脾汤加减", [
  ...["白术", "茯苓", "黄芪", "龙眼肉", "人参", "木香"].map((name) => ({ name })),
  { name: "酸枣仁", processing: "捣碎" },
  { name: "甘草", processing: "炙" },
  { name: "远志" },
]);
assert.match(preparedGuipi[0]?.source || "", /《济生》/, "physical preparation such as crushing must not change the herb identity used for formula provenance");
assert.equal(preparedGuipi[0]?.matchedIngredientCount, 8, "a separately recorded processed candidate may inherit an unprocessed base-formula identity");
const processedSuanzaoren = resolveFormulaSources("酸枣仁汤", [
  { name: "酸枣仁", processing: "炒" },
  ...["知母", "茯苓", "川芎", "甘草"].map((name) => ({ name })),
]);
assert.match(processedSuanzaoren[0]?.source || "", /金匮要略/, "炒酸枣仁 keeps its dispensing identity while matching the source formula's 酸枣仁 base identity");
const declassifiedGuipi = structuredClone(inferredModifiedGuipiJson);
declassifiedGuipi.formula.candidates[0] = {
  ...declassifiedGuipi.formula.candidates[0],
  name: "本例辨证组方",
  formulaNames: [],
  constructionType: "self_devised",
  baseFormulas: [],
  formulaSource: {
    evidenceLevel: "model_inference",
    source: "本例证候、病机、治法与药味功效的结构化匹配（模型推断，需医生复核）",
    confidence: "中",
  },
};
assert.equal(formulaCompilationContractIssue(declassifiedGuipi, guipiPrior), undefined, "a composition that cannot inherit the M03 classic identity must remain usable after transparent self-devised declassification");
assert.equal(
  formulaCompilationContractIssue(declassifiedGuipi, guipiPrior, false, false),
  "formula_reference_declassified",
  "provider validation must request a governed-composition repair before accepting the transparent self-devised fallback",
);
const falselyNamedDeclassifiedGuipi = structuredClone(declassifiedGuipi);
falselyNamedDeclassifiedGuipi.formula.candidates[0].name = "归脾汤加减";
assert.match(formulaCompilationContractIssue(falselyNamedDeclassifiedGuipi, guipiPrior) || "", /formula_reference_selection_drift/, "a declassified composition must never retain a classic name or source");
const longchiReference = formulaCompilationReferences(["龙齿安神丹"])[0];
assert.ok(longchiReference && longchiReference.ingredients.length === 8 && longchiReference.minimumPreservedIngredientCount === 7, "local formula regression fixture must expose an 8-herb governed baseline with a 7-herb identity floor");
const longchiPrior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaNames: ["龙齿安神丹"], formulaSelectionMode: "single" } };
const compiledLongchi = (names) => parsedReasoning(enrichPrescriptionProvenance(render(reasoning(candidate("龙齿安神丹加减", names)))));
const assertSafelyDeclassified = (result, prior, message) => {
  const declassified = result.formula.candidates[0];
  assert.equal(declassified.name, "本例辨证组方", `${message}: display name`);
  assert.deepEqual(declassified.formulaNames, [], `${message}: classic identity`);
  assert.equal(declassified.formulaSource.evidenceLevel, "model_inference", `${message}: source level`);
  assert.equal(formulaCompilationContractIssue(result, prior), undefined, `${message}: usable candidate`);
};
const removableLongchiIngredient = longchiReference.ingredients.find((name) => !longchiReference.requiredIngredients.includes(name));
assert.ok(removableLongchiIngredient, "local formula fixture must have a non-anchor ingredient for the 80% acceptance boundary");
const longchiAt80 = compiledLongchi(longchiReference.ingredients.filter((name) => name !== removableLongchiIngredient));
assert.equal(formulaCompilationContractIssue(longchiAt80, longchiPrior), undefined, "a modified local formula at or above the 80% floor with every anchor must retain its governed identity");
const longchiWithReasonableAdditions = compiledLongchi([
  ...longchiReference.ingredients.filter((name) => name !== removableLongchiIngredient),
  "当归", "白术", "茯苓",
]);
assert.equal(formulaCompilationContractIssue(longchiWithReasonableAdditions, longchiPrior), undefined, "F1 may rank sources but must not reject a single modified formula that satisfies the authoritative 80% floor, anchors, and addition precision boundary");
const longchiBelow80 = compiledLongchi(longchiReference.ingredients.slice(0, 6));
assertSafelyDeclassified(longchiBelow80, longchiPrior, "a 75% local-formula match must not inherit the governed name or source");
const longchiWithoutAnchor = compiledLongchi(longchiReference.ingredients.filter((name) => !longchiReference.requiredIngredients.includes(name)));
assertSafelyDeclassified(longchiWithoutAnchor, longchiPrior, "a formula missing an identity anchor must be declassified even when its overall overlap is otherwise high");
const xuanfuReference = formulaCompilationReferences(["旋覆代赭汤"])[0];
assert.ok(xuanfuReference.requiredIngredients.includes("代赭石"), "raw-name anchor detection must preserve 代赭 as canonical 代赭石 in 旋覆代赭汤");
const xuanfuPrior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaNames: ["旋覆代赭汤"], formulaSelectionMode: "single" } };
const xuanfuWithoutAnchor = parsedReasoning(enrichPrescriptionProvenance(render(reasoning(candidate(
  "旋覆代赭汤加减",
  xuanfuReference.ingredients.filter((name) => name !== "代赭石"),
)))));
assertSafelyDeclassified(xuanfuWithoutAnchor, xuanfuPrior, "deleting canonical 代赭石 must remove the classic identity");
for (const formulaName of ["代赭扶脾汤", "加减代赭旋覆花汤", "增减旋覆代赭汤"]) {
  const reference = formulaCompilationReferences([formulaName])[0];
  assert.ok(reference?.requiredIngredients.includes("代赭石"), `${formulaName} must map the historical name token 代赭 to canonical anchor 代赭石 even when the source ingredient is already canonical`);
  const prior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaNames: [formulaName], formulaSelectionMode: "single" } };
  const withoutCanonicalAnchor = parsedReasoning(enrichPrescriptionProvenance(render(reasoning(candidate(
    `${formulaName}加减`,
    reference.ingredients.filter((name) => name !== "代赭石"),
  )))));
  assertSafelyDeclassified(withoutCanonicalAnchor, prior, `${formulaName} without 代赭石 must not inherit its governed identity or source`);
}
for (const [formulaName, expectedCanonicalAnchor] of [["三味黄耆丸", "黄芪"], ["加味茯神散", "茯神"]]) {
  const reference = formulaCompilationReferences([formulaName])[0];
  assert.ok(reference?.requiredIngredients.includes(expectedCanonicalAnchor), `${formulaName} must retain its alias-equivalent canonical name anchor ${expectedCanonicalAnchor}`);
}
const fushenReference = formulaCompilationReferences(["加味茯神散"])[0];
assert.ok(fushenReference.ingredients.includes("茯神") && !fushenReference.ingredients.includes("茯苓"), "茯神 and 茯苓 must remain distinct governed ingredients");
const fushenPrior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaNames: ["加味茯神散"], formulaSelectionMode: "single" } };
const fushenSubstitutedWithFuling = parsedReasoning(enrichPrescriptionProvenance(render(reasoning(candidate(
  "加味茯神散",
  fushenReference.ingredients.map((name) => name === "茯神" ? "茯苓" : name),
)))));
assertSafelyDeclassified(fushenSubstitutedWithFuling, fushenPrior, "茯苓 substitution must remove the 加味茯神散 identity");
assert.deepEqual(resolveFormulaSources("加味茯神散", herbs(...fushenReference.ingredients.map((name) => name === "茯神" ? "茯苓" : name))), [], "a formula missing 茯神 must not inherit 加味茯神散 provenance as an exact source composition");
const qingweiReference = formulaCompilationReferences(["清胃散"])[0];
assert.ok(qingweiReference.ingredients.includes("当归身") && !qingweiReference.ingredients.includes("当归"), "formula provenance must preserve medicinal-part identity for 当归身");
const qingweiPrior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaNames: ["清胃散"], formulaSelectionMode: "single" } };
const qingweiWholeDanggui = parsedReasoning(enrichPrescriptionProvenance(render(reasoning(candidate(
  "清胃散加减",
  qingweiReference.ingredients.map((name) => name === "当归身" ? "当归" : name),
)))));
assertSafelyDeclassified(qingweiWholeDanggui, qingweiPrior, "whole 当归 must not retain a formula governed by the 当归身 anchor");
assert.deepEqual(resolveFormulaSources("清胃散", herbs(...qingweiReference.ingredients.map((name) => name === "当归身" ? "当归" : name))), [], "a medicinal-part substitution must not inherit an exact classic formula source");
const sanjiaReference = formulaCompilationReferences(["三甲复脉汤"])[0];
assert.ok(sanjiaReference.ingredients.includes("炙甘草") && !sanjiaReference.ingredients.includes("甘草"), "formula provenance must preserve processing identity for 炙甘草");
assert.deepEqual(resolveFormulaSources("三甲复脉汤", herbs(...sanjiaReference.ingredients.map((name) => name === "炙甘草" ? "甘草" : name))), [], "an unlabelled processing substitution must not inherit an exact classic formula source");
const structuredSanjiaHerbs = sanjiaReference.ingredients.map((name) => name === "炙甘草" ? { name: "甘草", processing: "炙" } : { name });
assert.equal(resolveFormulaSources("三甲复脉汤", structuredSanjiaHerbs)[0]?.exactComposition, true, "structured 炙 processing must reconstruct the complete 炙甘草 identity");
const wuhuReference = formulaCompilationReferences(["五虎汤"])[0];
const wuhuWithProcessedGancao = wuhuReference.ingredients.map((name) => name === "甘草" ? { name: "甘草", processing: "炙" } : { name });
assert.equal(resolveFormulaSources("五虎汤加减", wuhuWithProcessedGancao)[0]?.exactComposition, false, "adding 炙 processing must not remain an exact 五虎汤 composition");
const qimiReference = formulaCompilationReferences(["七味活命饮"])[0];
assert.ok(qimiReference.ingredients.includes("生黄芪"), "token-wise historical alias normalization must preserve 生 processing while canonicalizing 黄耆 to 黄芪");
assert.equal(resolveFormulaSources("七味活命饮", herbs(...qimiReference.ingredients))[0]?.exactComposition, true, "canonical 生黄芪 must match a historical 生黄耆 source token exactly");
const renshenShuyuReference = formulaCompilationReferences(["人参薯蓣丸"])[0];
assert.equal(renshenShuyuReference.minimumPreservedIngredientCount, Math.ceil(renshenShuyuReference.ingredients.length * 0.8), "the public formula floor and post-generation validator must use the same canonical de-duplicated baseline");
const suanzaorenNamedGuipiComposition = parsedReasoning(enrichPrescriptionProvenance(render(reasoning(candidate(
  "酸枣仁汤加减",
  ["白术", "茯苓", "黄芪", "龙眼肉", "酸枣仁", "人参", "木香", "甘草"],
)))));
const suanzaorenPrior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaNames: ["酸枣仁汤"], formulaSelectionMode: "single" } };
assert.equal(formulaCompilationContractIssue(suanzaorenNamedGuipiComposition, suanzaorenPrior), "formula_compilation_composition_drift", "a same-name historical variant cannot replace the signed M03 compilation baseline");
const guipiBaseline = formulaCompilationReferences(["归脾汤"])[0];
const suanzaorenBaseline = formulaCompilationReferences(["酸枣仁汤"])[0];
const alternativeBaselinePrior = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { recommendedFormulaNames: ["归脾汤", "酸枣仁汤"], formulaSelectionMode: "alternatives" },
};
const selectedFormulaWithHerbs = (name, ingredientNames) => parsedReasoning(enrichPrescriptionProvenance(render(reasoning(candidate(`${name}加减`, ingredientNames)))));
assert.equal(formulaCompilationContractIssue(selectedFormulaWithHerbs("归脾汤", guipiBaseline.ingredients), alternativeBaselinePrior), undefined, "selected 归脾汤 accepts only its governed baseline");
assert.equal(formulaCompilationContractIssue(selectedFormulaWithHerbs("酸枣仁汤", suanzaorenBaseline.ingredients), alternativeBaselinePrior), undefined, "selected 酸枣仁汤 accepts only its governed baseline");
assert.equal(formulaCompilationContractIssue(selectedFormulaWithHerbs("酸枣仁汤", guipiBaseline.ingredients), alternativeBaselinePrior), "formula_compilation_composition_drift", "selected 酸枣仁汤 rejects the unselected 归脾汤 composition");
const guipiNamedSuanzaorenComposition = selectedFormulaWithHerbs("归脾汤", suanzaorenBaseline.ingredients);
assert.equal(guipiNamedSuanzaorenComposition.formula.candidates[0].name, "本例辨证组方", "a 归脾汤 label with 酸枣仁汤 composition is declassified before display");
assert.deepEqual(guipiNamedSuanzaorenComposition.formula.candidates[0].formulaNames, []);
assert.equal(formulaCompilationContractIssue(guipiNamedSuanzaorenComposition, alternativeBaselinePrior), undefined, "the declassified reverse mismatch remains usable without a false classic identity");
const weakShortVariantClaim = parsedReasoning(enrichPrescriptionProvenance(render(reasoning(candidate(
  "酸枣仁汤加减",
  ["酸枣仁", "腊茶", "黄芪", "龙眼肉", "木香", "远志", "夜交藤", "合欢皮"],
)))));
assertSafelyDeclassified(weakShortVariantClaim, suanzaorenPrior, "a short same-name variant must not lend its classic identity to a mostly unrelated larger composition");

const selfDevisedCandidate = candidate(
  "自拟安神方",
  ["酸枣仁", "茯神", "夜交藤", "远志"],
);
selfDevisedCandidate.therapyMatch = "归脾汤加减以补益心脾，香砂六君子汤健脾和胃";
selfDevisedCandidate.formulaAnalysis = "原方按归脾汤结构加减";
selfDevisedCandidate.applicable = "纳差便溏阴性史待核实";
selfDevisedCandidate.notApplicable = "潮热盗汗未在本次病历中明确记录，待核实";
const enrichedSelfDevised = enrichPrescriptionProvenance(render(reasoning(selfDevisedCandidate)).replace(
  "<!-- DIAGNOSIS_JSON_START -->",
  "**方剂定位**：归脾汤加减。原方以补益心脾为主，本例再作化裁。\n\n<!-- DIAGNOSIS_JSON_START -->",
));
assert.doesNotMatch(enrichedSelfDevised, /\*\*(?:参考依据|组方依据)\*\*/, "clinical inference must not be presented as an external reference");
assert.match(enrichedSelfDevised, /本例辨证组方/);
assert.match(enrichedSelfDevised, /本方案/);
assert.doesNotMatch(enrichedSelfDevised, /证据不足|待检索|《[^》]+》|归脾汤|原方/);
const selfJson = JSON.parse(enrichedSelfDevised.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(selfJson.formula.candidates[0].constructionType, "self_devised");
assert.equal(selfJson.formula.candidates[0].formulaSource.evidenceLevel, "model_inference");
assert.doesNotMatch(JSON.stringify(selfJson.formula.candidates[0]), /归脾汤|香砂六君子汤|原方|待核实|未在本次病历/);
assert.match(selfJson.formula.candidates[0].notApplicable, /重新辨证/);

const enrichedSingleClassic = enrichPrescriptionProvenance(render(reasoning(candidate("甘草汤", ["甘草"]))));
assert.match(enrichedSingleClassic, /\*\*方剂资料收载来源\*\*/);
const singleJson = JSON.parse(enrichedSingleClassic.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(singleJson.formula.candidates[0].constructionType, "single_base");
assert.equal(singleJson.formula.candidates[0].formulaSource.evidenceLevel, "kb_entry");
const annotatedGancao = resolveFormulaSources("甘草汤（《伤寒论》）", herbs("甘草"));
assert.equal(annotatedGancao[0]?.source, "《伤寒论》。", "normalized aliases must retain every exact variant and honor an explicit source annotation");

const enrichedVerified = enrichPrescriptionProvenance(render(reasoning(candidate(
  "酸枣仁汤加减（《金匮要略》）",
  ["酸枣仁", "川芎", "知母", "茯苓", "甘草", "夜交藤"],
))));
assert.match(enrichedVerified, /\*\*参考基础方及出处\*\*[：:]酸枣仁汤：《金匮要略》/);
const verifiedJson = JSON.parse(enrichedVerified.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(verifiedJson.formula.candidates[0].formulaSource.evidenceLevel, "classic_text");
assert.equal(verifiedJson.formula.candidates[0].formulaSource.confidence, "中");
assert.equal(verifiedJson.formula.candidates[0].name, "酸枣仁汤加减");

const unverifiedHeadingVariant = render(reasoning(candidate("升栀逍遥散化裁", ["柴胡", "白芍", "茯苓"])))
  .replace("### 候选处方1：", "#### 候选方药一：");
const sanitizedUnknown = enrichPrescriptionProvenance(unverifiedHeadingVariant);
assert.match(sanitizedUnknown, /#### 候选方药一：本例辨证组方/);
assert.doesNotMatch(sanitizedUnknown, /升栀逍遥散|《伤寒论》/);

console.log(JSON.stringify({ cases: 263, failures: 0 }));
