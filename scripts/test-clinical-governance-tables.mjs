import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const readJson = (name) => JSON.parse(readFileSync(new URL(`../src/data/${name}`, import.meta.url), "utf8"));
const sha256 = (name) => createHash("sha256")
  .update(readFileSync(new URL(`../src/data/${name}`, import.meta.url)))
  .digest("hex");

const manifest = readJson("clinical-governance-table-manifest.json");
assert.equal(manifest.schemaVersion, "clinical-governance-table-manifest-v1");
assert.deepEqual(manifest.tables.map((item) => item.id), ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12"]);
for (const table of manifest.tables) {
  assert.equal(table.sha256, sha256(table.file), `${table.id} manifest hash drift`);
  assert.ok(table.recordCount > 0, `${table.id} must not be empty`);
}
assert.equal(manifest.sourceRegistry.sha256, sha256(manifest.sourceRegistry.file), "source registry manifest hash drift");
assert.equal(manifest.auxiliaryIndexes.length, 1);
assert.equal(manifest.auxiliaryIndexes[0].sha256, sha256(manifest.auxiliaryIndexes[0].file), "T8 retrieval index manifest hash drift");

const syndrome = readJson("tcm-syndrome-lexicon.json");
const nature = readJson("tcm-nature-lexicon.json");
const location = readJson("tcm-location-lexicon.json");
const principles = readJson("tcm-treatment-principle-lexicon.json");
const diagnostics = readJson("diagnostics-context-lexicon.json");
const redflags = readJson("redflag-triage-lexicon.json");
const jargon = readJson("engineering-jargon-lexicon.json");
const formulas = readJson("tcm-formula-governed-catalog.json");
const formulaRetrievalConcepts = readJson("tcm-formula-retrieval-concepts.json");
const formulaRetrievalIndex = readJson("tcm-formula-retrieval-index.json");
const highFrequencyFormulaRelations = readJson("tcm-high-frequency-syndrome-formula-relations.source.json");
const herbs = readJson("tcm-herb-identity-catalog.json");
const requiredFields = readJson("clinical-required-field-matrix.json");
const outputContracts = readJson("clinical-output-contract-registry.json");
const nondrugTreatments = readJson("tcm-nondrug-treatment-evidence-catalog.json");
const sourceRegistry = readJson("clinical-governance-source-registry.json");

const governedPayloads = new Map([
  ["T1", syndrome], ["T2", nature], ["T3", location], ["T4", principles],
  ["T5", diagnostics], ["T6", redflags], ["T7", jargon], ["T8", formulas],
  ["T9", herbs], ["T10", requiredFields], ["T11", outputContracts], ["T12", nondrugTreatments],
]);
const recordCount = (id, payload) => {
  if (Array.isArray(payload.entries)) {
    return payload.entries.length + (["T1", "T4"].includes(id) ? (payload.clinicalExtensions || []).length : 0);
  }
  if (id === "T5") return payload.groups.length;
  if (id === "T6") return payload.categoryRules.length;
  throw new Error(`${id} has no governed record collection`);
};
for (const table of manifest.tables) {
  assert.equal(recordCount(table.id, governedPayloads.get(table.id)), table.recordCount, `${table.id} record count drift`);
}

const unique = (items, label) => {
  assert.equal(new Set(items).size, items.length, `${label} contains duplicates`);
};
for (const [label, payload] of [["syndrome", syndrome], ["nature", nature], ["location", location], ["principle", principles]]) {
  unique(payload.entries.map((item) => item.id), `${label} ids`);
  unique(payload.entries.map((item) => item.canonical), `${label} canonical terms`);
}
assert.equal(syndrome.summary.standardTermCount, 2060);
assert.equal(syndrome.summary.clinicalExtensionCount, 1);
assert.equal(syndrome.clinicalExtensions[0].canonical, "肝火扰心");
assert.equal(principles.summary.standardTermCount, 1276);
assert.equal(principles.summary.clinicalExtensionCount, 3);
assert.ok(syndrome.entries.every((item) => item.sourceRefs.includes("SRC-GBT-16751-2-2021")));
assert.ok(principles.entries.every((item) => item.sourceRefs.includes("SRC-GBT-16751-3-2023")));
assert.ok(syndrome.entries.filter((item) => item.definitionSha256).every((item) => /^[a-f0-9]{64}$/.test(item.definitionSha256)));
assert.ok(principles.entries.filter((item) => item.definitionSha256).every((item) => /^[a-f0-9]{64}$/.test(item.definitionSha256)));
const natureIds = new Set(nature.entries.map((item) => item.id));
const locationIds = new Set(location.entries.map((item) => item.id));
for (const item of syndrome.entries) {
  item.natures.forEach((id) => assert.ok(natureIds.has(id), `${item.id} unknown nature ${id}`));
  item.locations.forEach((id) => assert.ok(locationIds.has(id), `${item.id} unknown location ${id}`));
}

const combined = principles.entries.find((item) => item.canonical === "标本兼治");
assert.equal(combined?.permitsPrioritization, true, "标本兼顾 may still document clinical priority with rationale");
assert.ok(combined?.aliases.includes("标本兼顾"));
assert.ok(principles.entries.find((item) => item.canonical === "正治法")?.aliases.includes("正治"));
assert.ok(principles.entries.find((item) => item.canonical === "反治法")?.aliases.includes("反治"));
assert.ok(principles.entries.find((item) => item.canonical === "急则治标")?.aliases.includes("治标"));
assert.ok(principles.entries.find((item) => item.canonical === "缓则治本")?.aliases.includes("治本"));
assert.deepEqual(principles.clinicalExtensions.map((item) => item.canonical), ["三因制宜", "治病求本", "同病异治"]);
const abdominalExam = diagnostics.groups.find((item) => item.id === "tcm_abdominal_examination");
assert.equal(abdominalExam?.tcmReasoningPolicy, "allowed_when_case_bound_and_relevant", "腹诊 must not become a blanket forbidden term");
assert.equal(redflags.governance.hardGateAuthority, "deterministic_rule_or_validated_vital_threshold");
assert.equal(redflags.governance.semanticModelRole, "grounded_additive_detection_and_clarification");
assert.ok(jargon.entries.some((item) => item.terms.includes("程序化")));
assert.ok(jargon.entries.some((item) => item.terms.includes("信息不足，需补齐")));
assert.ok(jargon.entries.some((item) => item.terms.includes("剂量级")));
assert.ok(diagnostics.groups.find((item) => item.id === "modern_laboratory")?.terms.includes("TSH"));
assert.ok(diagnostics.groups.find((item) => item.id === "modern_imaging")?.terms.includes("B超"));
assert.ok(redflags.dimensions.acuteOnset.includes("急性"));
assert.ok(redflags.dimensions.severe.includes("刀割样"));
assert.ok(redflags.categoryRules.find((item) => item.id === "acute_abdomen")?.symptoms.includes("胃部疼痛"));
assert.equal(nature.entries.find((item) => item.canonical === "内风")?.aliases.includes("动风"), true);
assert.equal(nature.entries.some((item) => item.canonical === "虫积"), true);
for (const term of ["太阳", "阳明", "少阳", "太阴", "少阴", "厥阴", "冲任"]) {
  assert.equal(location.entries.some((item) => item.canonical === term), true, `T3 missing ${term}`);
}

// 与 curated 关系表同样的「只增不减」约定：目录与各项资格数会随治理推进增长，
// 用下限而非等值断言——等值字面量每次补一条主治/标签都要手改，改的人往往只改一处
// （本文件与 manifest 曾出现 319/320 不一致，测试红了两天）。下限才守得住真正的不变量：
// 覆盖面不得倒退。
const FORMULA_CATALOG_FLOOR = 1800;
const FORMULA_ELIGIBLE_FLOOR = 1795;
const FORMULA_DOSE_ELIGIBLE_FLOOR = 899;
assert.ok(formulas.summary.governedFormulaCount >= FORMULA_CATALOG_FLOOR,
  `受控方剂数不得低于 ${FORMULA_CATALOG_FLOOR}，实际 ${formulas.summary.governedFormulaCount}`);
assert.ok(formulas.summary.identityLockEligibleCount >= FORMULA_ELIGIBLE_FLOOR,
  `身份锁可用方剂数不得低于 ${FORMULA_ELIGIBLE_FLOOR}，实际 ${formulas.summary.identityLockEligibleCount}`);
assert.ok(formulas.summary.prescriptionLockEligibleCount >= FORMULA_ELIGIBLE_FLOOR,
  `处方锁可用方剂数不得低于 ${FORMULA_ELIGIBLE_FLOOR}，实际 ${formulas.summary.prescriptionLockEligibleCount}`);
assert.ok(formulas.summary.doseCompilationEligibleCount >= FORMULA_DOSE_ELIGIBLE_FLOOR,
  `剂量可编译方剂数不得低于 ${FORMULA_DOSE_ELIGIBLE_FLOOR}，实际 ${formulas.summary.doseCompilationEligibleCount}`);
// The curated T8 relation table is expected to grow. Assert the invariants that actually protect
// recall — every curated row resolves AND stays reachable through the runtime resolver, and the
// table never shrinks below the committed floor — instead of a literal that has to be edited on
// every coverage addition. A reported count that exceeds runtime reachability is the exact
// overstatement this guard exists to catch.
const HIGH_FREQUENCY_SYNDROME_FLOOR = 77;
for (const summary of [formulas.summary, formulaRetrievalIndex.summary]) {
  assert.ok(summary.highFrequencySyndromeTargetCount >= HIGH_FREQUENCY_SYNDROME_FLOOR);
  assert.equal(summary.highFrequencySyndromeSourceResolvedCount, summary.highFrequencySyndromeTargetCount);
  assert.equal(summary.highFrequencySyndromeRuntimeReachableCount, summary.highFrequencySyndromeTargetCount);
  assert.equal(summary.highFrequencySyndromeCoveredCount, summary.highFrequencySyndromeRuntimeReachableCount);
}
assert.ok(formulas.summary.curatedSyndromeFormulaRelationCount >= HIGH_FREQUENCY_SYNDROME_FLOOR);

// ─── 证型标签裁定表必须逐条落地，且对全部 sourceClass 生效 ───
// 这道断言存在的原因：tcm-verified-formula-supplements.json 的 curatedSyndromeTags 只喂
// verified_reference_catalog 一类。若把裁定结果走那条通道，经典名方与地方标准方会被**静默丢弃**
// （首批 241 条里有 101 条属于这两类）。丢标签不会报错，只会让这些方永远锁不住——正是最难发现的那种失效。
const syndromeTagAdjudications = readJson("tcm-formula-syndrome-tag-adjudications.source.json");
assert.equal(syndromeTagAdjudications.schemaVersion, "tcm-formula-syndrome-tag-adjudications-v1");
const governedFormulaByName = new Map(formulas.entries.map((entry) => [entry.name, entry]));
const syndromeCanonicalById = new Map(
  [...syndrome.entries, ...(syndrome.clinicalExtensions || [])].map((entry) => [entry.id, entry.canonical]),
);
const adjudicatedSourceClasses = new Set();
for (const row of syndromeTagAdjudications.entries) {
  const entry = governedFormulaByName.get(row.name);
  assert.ok(entry, `裁定的方剂必须存在于受控目录：${row.name}`);
  adjudicatedSourceClasses.add(entry.sourceClass);
  for (const tagId of row.syndromeTagIds) {
    assert.ok(syndromeCanonicalById.has(tagId), `裁定标签必须是受控证候 id：${row.name}->${tagId}`);
    assert.ok(entry.curatedSyndromeTags.includes(tagId), `裁定标签未落地到目录：${row.name}->${tagId}`);
    assert.ok(entry.syndromeTags.includes(tagId), `裁定标签未进入运行时 syndromeTags：${row.name}->${tagId}`);
  }
  // 有标签 ⇒ 可被身份锁锁定，这是裁定的全部意义所在。
  assert.ok(entry.identityLockEligible, `裁定过的方剂必须可被身份锁锁定：${row.name}`);
}
assert.deepEqual(
  [...adjudicatedSourceClasses].sort(),
  ["official_classic_catalog", "official_local_formula_standard", "verified_reference_catalog"],
  "裁定通道必须对三类来源都生效，缺任何一类都说明通道退化回了 verified-only",
);
assert.equal(
  formulaRetrievalIndex.curatedRelationSource.sha256,
  sha256(formulaRetrievalIndex.curatedRelationSource.file),
  "T8 high-frequency relation source drift",
);
assert.ok(manifest.buildSummary.formulaDoseCompilationEligible >= FORMULA_DOSE_ELIGIBLE_FLOOR,
  `manifest 与目录必须同源同口径，且不得低于 ${FORMULA_DOSE_ELIGIBLE_FLOOR}`);
assert.equal(manifest.buildSummary.formulaDoseCompilationEligible, formulas.summary.doseCompilationEligibleCount,
  "manifest 与目录的剂量可编译数必须一致——两处各持一份字面量正是此前 319/320 长期不一致的原因");
assert.ok(formulas.summary.symptomTaggedFormulaCount >= 250);
assert.ok(formulas.summary.diseaseTaggedFormulaCount >= 80);
assert.ok(formulas.summary.syndromeTaggedFormulaCount >= 250);
assert.equal(formulas.reviewQueue.length, 0);
assert.equal(formulas.evidenceAdjudications.length, 8);
assert.equal(formulas.summary.disposedSameNameVariantCount, 113);
assert.equal(formulaRetrievalIndex.sourceCatalog.sha256, sha256(formulaRetrievalIndex.sourceCatalog.file), "T8 retrieval index source catalog drift");
assert.equal(formulaRetrievalIndex.conceptSource.sha256, sha256(formulaRetrievalIndex.conceptSource.file), "T8 retrieval concept source drift");
const retrievalFormulaIds = new Set(formulas.entries.filter((item) => item.retrievalEligible).map((item) => item.id));
const retrievalConceptIds = new Set(formulaRetrievalConcepts.entries.map((item) => item.id));
for (const [indexName, index] of Object.entries(formulaRetrievalIndex.indexes)) {
  for (const [key, formulaIds] of Object.entries(index)) {
    if (indexName === "conceptToFormulaIds") assert.ok(retrievalConceptIds.has(key), `unknown T8 retrieval concept ${key}`);
    unique(formulaIds, `${indexName}.${key}`);
    formulaIds.forEach((id) => assert.ok(retrievalFormulaIds.has(id), `${indexName}.${key} stale formula ${id}`));
  }
}
assert.equal("aliasToFormulaIds" in formulaRetrievalIndex.indexes, false, "unused alias index must not be shipped");
assert.equal(formulaRetrievalIndex.summary.formulaCount, retrievalFormulaIds.size);
for (const item of formulas.evidenceAdjudications) {
  assert.equal(item.governanceStatus, "evidence_identity_adjudicated");
  assert.equal(item.retrievalEligible, false, `${item.name} adjudication record must not duplicate the runtime entry`);
  assert.equal(item.identityLockEligible, true);
  assert.equal(item.prescriptionLockEligible, true);
  assert.equal(item.requiresPatientSpecificDoseCompilation, true);
  assert.equal(item.requiresPostPrescriptionAudit, true);
  assert.ok(item.standardBaseline.standardCode, `${item.name} must have a governed standard baseline`);
  assert.ok(item.variants.length > 0, `${item.name} must retain all same-name source variants`);
  assert.ok(item.variants.every((variant) => variant.runtimeEligible === false && variant.disposition), `${item.name} variants must all be disposed`);
}
assert.equal(formulas.evidenceAdjudications.find((item) => item.name === "龙胆泻肝汤")?.variants.length, 25);
assert.equal(formulas.entries.find((item) => item.name === "桂枝汤")?.governanceStatus, "official_local_standard_identity_verified");
assert.equal(formulas.entries.find((item) => item.name === "桂枝汤")?.identityLockEligible, true);
for (const name of ["龙胆泻肝汤", "丹栀逍遥散", "天麻钩藤饮", "六味地黄丸", "桂枝汤", "银翘散", "补中益气汤"]) {
  assert.equal(formulas.entries.find((item) => item.name === name)?.identityLockEligible, true, `${name} identity must be lockable`);
}
const formulaNamesAndAliases = new Set(formulas.entries.flatMap((item) => [item.name, ...(item.aliases || [])]));
for (const name of ["二陈汤", "四君子汤", "四物汤", "小柴胡汤", "血府逐瘀汤", "柴胡疏肝散", "参苓白术散", "藿香正气散", "天王补心丹", "左金丸", "越鞠丸", "八正散", "导赤散", "白头翁汤", "甘麦大枣汤", "麻杏石甘汤", "白虎汤", "安宫牛黄丸", "紫雪丹", "至宝丹", "加味逍遥散"]) {
  assert.equal(formulaNamesAndAliases.has(name), true, `T8 missing high-frequency formula ${name}`);
}
unique(formulas.entries.map((item) => item.id), "T8 runtime ids");
unique(formulas.entries.map((item) => item.name), "T8 runtime names");
const normalizedFormulaIdentity = (value) => value.normalize("NFKC")
  .replace(/[（(]?\s*《[^》]{2,80}》\s*[）)]?/g, "")
  .replace(/[\s·•，,。；;：:（）()【】\[\]“”"']/g, "")
  .replace(/(?:加减方?|化裁方?|加味方?)$/g, "")
  .trim();
unique(formulas.entries.map((item) => normalizedFormulaIdentity(item.name)), "T8 normalized runtime identities");
assert.equal(formulas.entries.find((item) => item.name === "丹栀逍遥散")?.aliases.includes("加味逍遥散"), true);
assert.equal(formulas.entries.some((item) => item.name.includes("审视瑶函") && item.name.includes("加味逍遥散")), true);
assert.equal(herbs.source.rowCount, 6708);
assert.ok(herbs.summary.standardNameCount >= 620);
assert.ok(herbs.summary.ambiguousInputCount > 0, "ambiguous aliases must remain explicit");
assert.ok((herbs.summary.resolutionStatusCounts.unique_mapping_requires_review || 0) < 10);
assert.ok(herbs.summary.resolutionStatusCounts.unique_source_backed > 4500);
assert.deepEqual(herbs.resolutionIndex["丁香"], { canonicalName: "丁香", status: "exact_standard_name", autoResolvable: true });
assert.equal(herbs.resolutionIndex["百条根"].status, "ambiguous", "multi-target alias must fail closed");
for (const name of ["生地黄", "生地", "酒黄芩", "酒当归", "盐车前子", "生甘草", "生黄芪", "山栀", "炒山栀", "白芥子", "元参", "桂心", "藿香叶", "干姜片", "生姜皮"]) {
  assert.equal(herbs.resolutionIndex[name]?.autoResolvable, true, `T9 missing auto-resolvable common input ${name}`);
}
assert.equal(herbs.resolutionIndex["芍药"].status, "ambiguous");
assert.ok(herbs.reviewQueue.every((item) => item.serviceLevel.triageBusinessDays === 1 && item.serviceLevel.adjudicationBusinessDays === 5));

assert.equal(requiredFields.entries.length, 16);
assert.deepEqual(requiredFields.governance.universalMinimum, ["chief_complaint", "sex"]);
assert.equal(requiredFields.entries.find((item) => item.id === "sex")?.stagePolicy.collect, "required");
assert.equal(requiredFields.entries.find((item) => item.id === "allergy_history")?.unknownPolicy, "unknown_never_no_allergy");
assert.deepEqual(requiredFields.governance.implementationDrift, []);
assert.equal(outputContracts.entries.length, 18);
assert.equal(outputContracts.summary.internalContractCount, 2);
assert.equal(outputContracts.summary.visibleContractCount, 16);
assert.equal(outputContracts.surfaces.length, 7);
assert.deepEqual(outputContracts.limitedStateCopy.requiredParts, ["knownFacts", "unavailableConclusion", "nextAction"]);
assert.ok(outputContracts.entries.some((item) => item.id === "red-flag-warning"));
assert.ok(outputContracts.entries.some((item) => item.id === "health-education"));
assert.ok(outputContracts.entries.filter((item) => item.visibility === "internal_only").every((item) => item.unknownPolicy === "never_render_to_clinical_user"));
assert.ok(outputContracts.entries.filter((item) => item.visibility === "visible").every((item) => item.rendererId), "every visible output contract must bind a renderer");
const diagnosisClientSource = readFileSync(new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url), "utf8");
for (const item of outputContracts.entries.filter((entry) => entry.visibility === "visible")) {
  assert.match(diagnosisClientSource, new RegExp(item.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${item.id} has no UI contract binding`);
  assert.match(diagnosisClientSource, new RegExp(item.rendererId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${item.rendererId} has no UI implementation`);
}
assert.equal(nondrugTreatments.entries.length, 22);
assert.equal(nondrugTreatments.summary.executableProjectCount, 0);
assert.ok(nondrugTreatments.summary.planTemplateCount >= 25);
assert.ok(nondrugTreatments.summary.parameterizedProjectCount >= 12);
assert.ok(nondrugTreatments.summary.governedFrequencyProjectCount >= 10);
assert.equal(nondrugTreatments.summary.explicitDispositionProjectCount, 22);
assert.ok(nondrugTreatments.summary.sourceTemplateProjectCount >= 12);
// A template whose indicationTag its project does not declare is filtered out by
// dominantIndicationTag() and can never reach a doctor — silent zero coverage, not a template.
assert.deepEqual(
  nondrugTreatments.entries.flatMap((item) =>
    item.planTemplates
      .filter((template) => !item.indicationTags.includes(template.indicationTag))
      .map((template) => `${item.projectCode}:${template.id}`)),
  [],
);
assert.ok(nondrugTreatments.entries.every((item) => item.executable === false));
assert.ok(nondrugTreatments.entries.every((item) => item.clinicianReviewRequired));
assert.ok(nondrugTreatments.entries.every((item) => Boolean(item.coverageDisposition)));
assert.ok(nondrugTreatments.entries.filter((item) => item.containsMedication).every((item) => item.requiresMedicationAudit));
// 食疗/意疗 have no anatomical site and no fixed course; demanding either would force fabricated
// parameters. Every other modality must still carry site, governed frequency and source.
const siteFreeTreatmentModalities = new Set(["diet_therapy", "mind_therapy"]);
assert.ok(nondrugTreatments.entries.flatMap((item) =>
  item.planTemplates.map((template) => ({ projectCode: item.projectCode, ...template }))).every((template) =>
  template.scheduleSuggestion.length > 0 &&
  template.sourceRefs.length > 0 &&
  (siteFreeTreatmentModalities.has(template.projectCode)
    ? template.sitesOrPoints.length === 0
    : template.sitesOrPoints.length > 0 && template.parameterCompleteness.includes("frequency"))));
assert.equal(nondrugTreatments.entries.find((item) => item.projectCode === "acupuncture")?.planTemplates.length, 8);

unique(sourceRegistry.entries.map((item) => item.id), "source registry ids");
const sourceIds = new Set(sourceRegistry.entries.map((item) => item.id));
const assertSourceRefs = (refs, label) => refs.forEach((ref) => assert.ok(sourceIds.has(ref), `${label} unknown source ${ref}`));
const collectSourceRefs = (value, refs = new Set()) => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSourceRefs(item, refs));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "sourceRef" && typeof item === "string" && item.startsWith("SRC-")) refs.add(item);
      else if ((key === "sourceRefs" || key === "protocolSourceRefs") && Array.isArray(item)) {
        item.filter((ref) => typeof ref === "string" && ref.startsWith("SRC-")).forEach((ref) => refs.add(ref));
      } else collectSourceRefs(item, refs);
    }
  }
  return refs;
};
for (const [id, payload] of governedPayloads) assertSourceRefs([...collectSourceRefs(payload)], id);
assertSourceRefs(requiredFields.governance.sourceRefs, "required fields");
assertSourceRefs(outputContracts.governance.sourceRefs, "output contracts");
for (const item of nondrugTreatments.entries) assertSourceRefs(item.protocolSourceRefs, item.projectCode);
for (const item of formulas.evidenceAdjudications) assertSourceRefs([item.standardBaseline.sourceRef], item.name);

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const governance = await jiti.import("../src/lib/clinical-governance-tables.ts");
assert.equal(governance.canonicalTcmSyndromeTerm("心脾两虚证")?.canonical, "心脾两虚");
assert.equal(governance.canonicalTcmSyndromeTerm("肝火扰心")?.canonical, "肝火扰心");
assert.equal(governance.resolveTcmSyndromeTerm("风寒袭肺").status, "canonical", "canonical term must win over alias collision");
assert.equal(governance.resolveTcmSyndromeTerm("痰湿壅肺").status, "ambiguous", "multi-target syndrome alias must fail closed");
for (const [syndromeName, syndromeId, formulaName] of [
  ["风寒犯肺", "wind_cold_binding_lung", "麻黄汤"],
  ["痰热阻肺", "phlegm_heat_obstructing_lung", "清金化痰汤"],
  ["心火炽盛", "heart_fire_hyperactivity", "导赤散"],
]) {
  assert.equal(governance.canonicalTcmSyndromeTerm(syndromeName)?.id, syndromeId);
  const formulaId = formulas.entries.find((item) => item.name === formulaName)?.id;
  assert.ok(formulaId, `${formulaName} must exist in T8`);
  assert.ok(
    formulaRetrievalIndex.indexes.syndromeToFormulaIds[syndromeId]?.includes(formulaId),
    `${syndromeName}->${formulaName} must use the runtime canonical syndrome ID`,
  );
}
assert.equal(governance.governedTcmTermLabelById("heart_spleen_deficiency"), "心脾两虚");
assert.equal(governance.canonicalTcmNatureTerm("气郁")?.canonical, "气滞");
assert.equal(governance.canonicalTcmLocationTerm("胃脘")?.canonical, "胃");
assert.equal(governance.treatmentPrinciplesInText("标本兼顾，清肝安神")[0]?.canonical, "标本兼治");
for (const term of ["正治", "反治", "治标", "治本", "三因制宜", "治病求本", "同病异治"]) {
  assert.equal(governance.treatmentPrinciplesInText(term).length > 0, true, `T4 missing anchor ${term}`);
}
assert.equal(governance.diagnosticContextsInText("缺乏腹部按诊")[0]?.id, "tcm_abdominal_examination");
assert.equal(governance.tcmDiagnosticDependencyContexts("腹诊见脘腹柔软，无压痛").length, 0, "case-bound 腹诊 is legitimate TCM reasoning");
assert.equal(governance.tcmDiagnosticDependencyContexts("仅因缺乏腹部按诊，故不能辨证")[0]?.id, "tcm_abdominal_examination", "only a forbidden dependency frame is rejected");
assert.equal(governance.westernLabelContainsTcmSyndrome("慢性咳嗽（风燥伤肺证）"), true, "T1 must govern Western-label syndrome pollution beyond a short hard-coded list");
assert.equal(governance.governedTreatmentPrinciplesInText("因人制宜，扶正祛邪").length >= 1, true);
const treatmentPrinciplePromptContext = governance.governedTreatmentPrinciplePromptContext();
for (const term of ["正治法", "反治法", "标本兼治", "扶正祛邪", "三因制宜", "治病求本", "同病异治"]) {
  assert.match(treatmentPrinciplePromptContext, new RegExp(term), `T4 prompt context missing ${term}`);
}
assert.match(treatmentPrinciplePromptContext, /标本兼治[\s\S]*至少分别覆盖本与标两个不同目标/);
assert.equal(governance.engineeringJargonInText("程序化安全门控").length, 2);
assert.equal(governance.clinicalRequiredFieldLabel("allergy_history", "fallback"), "过敏史");
assert.equal(governance.clinicalFieldRequiresExplicitPrescriptionState("allergy_history"), true);
assert.equal(governance.CLINICAL_GOVERNANCE_TABLES.requiredFieldPolicy.entries.length, 16);
assert.equal(governance.CLINICAL_GOVERNANCE_TABLES.outputContract.entries.length, 18);
assert.equal(governance.CLINICAL_GOVERNANCE_TABLES.nondrugTreatment.entries.length, 22);

const formulaIndications = await jiti.import("../src/lib/tcm-formula-indications.ts");
assert.ok(highFrequencyFormulaRelations.entries.length >= HIGH_FREQUENCY_SYNDROME_FLOOR);
for (const relation of highFrequencyFormulaRelations.entries) {
  const primary = relation.formulas.find((item) => (item.fit || "primary") === "primary") || relation.formulas[0];
  const therapy = primary.therapyTerms.join("，");
  const candidates = formulaIndications.retrieveTcmFormulaCandidatesForReasoning({
    overview: {
      primarySyndrome: relation.syndrome,
      overallPathogenesis: relation.syndrome,
      tcmDifferentials: [],
    },
    pathogenesis: {
      summary: relation.syndrome,
      locationDifferentiation: { items: [] },
      natureDifferentiation: { items: [] },
      chain: [{
        patientFact: relation.syndrome,
        syndromeEvidence: relation.syndrome,
        pathogenesis: relation.syndrome,
        therapyDirection: therapy,
      }],
    },
    therapy: {
      overallPrinciple: therapy,
      overallMethod: therapy,
      subTherapies: [],
    },
  }, 500);
  const recalled = candidates.find((item) => item.name === primary.name);
  assert.ok(recalled, `${relation.syndrome} must recall ${primary.name} through the runtime API`);
  assert.equal(recalled.positiveSufficiency, true, `${relation.syndrome}->${primary.name} must pass positive sufficiency`);
}

const outputAuthority = await jiti.import("../src/lib/clinical-output-authority.ts");
assert.deepEqual(outputAuthority.clinicalOutputRendererCoverageIssues(), []);
const rawVisible = '程序化安全门控通过，API返回。\n<!-- DIAGNOSIS_JSON_START -->\n{"note":"API必须保持原样"}\n<!-- DIAGNOSIS_JSON_END -->';
const governedVisible = outputAuthority.sanitizeAuthoritativeClinicalOutput(rawVisible);
assert.deepEqual(outputAuthority.visibleClinicalOutputGovernanceIssues(governedVisible), []);
assert.match(governedVisible, /按当前风险筛查规则/);
assert.match(governedVisible, /系统内部处理/);
assert.match(governedVisible, /{"note":"API必须保持原样"}/, "T7 must never mutate the signed structured block");
assert.equal(outputAuthority.sanitizeAuthoritativeClinicalOutput(governedVisible), governedVisible, "T7 visible normalization must be idempotent");
assert.equal(
  outputAuthority.sanitizeAuthoritativeClinicalOutput("门控心肌灌注显像用于评估心肌灌注。"),
  "门控心肌灌注显像用于评估心肌灌注。",
  "T7 must not corrupt a legitimate gated myocardial perfusion imaging term",
);
assert.doesNotMatch(
  outputAuthority.sanitizeAuthoritativeClinicalOutput("门控未通过，信息不足无法判断。"),
  /门控未通过|信息不足无法判断/,
  "T7 must still normalize engineering gate status and non-actionable insufficient-information copy",
);
assert.deepEqual(
  outputAuthority.visibleClinicalOutputGovernanceIssues("门控心肌灌注显像"),
  [],
  "legitimate clinical imaging terminology must not be reported as engineering jargon",
);
assert.equal(
  outputAuthority.sanitizeAuthoritativeClinicalOutput("本证与兼证之间的病机关联明确。"),
  "本证与兼证之间的病机关联明确。",
  "T7 must not rewrite a legitimate clinical pathogenesis relationship",
);
assert.doesNotMatch(
  outputAuthority.sanitizeAuthoritativeClinicalOutput("病机关联字段校验失败。"),
  /病机关联字段/,
  "T7 must still normalize the same phrase in an explicit engineering-field context",
);
assert.equal(outputAuthority.clinicalOutputLabel("M04-patent-western", "fallback"), "中成药/西药候选");
assert.equal(outputAuthority.visibleClinicalOutputContractsForStage("prescribe").some((item) => item.id === "M04-formula"), true);
assert.equal(outputAuthority.clinicalOutputSurface("red_flag_escalation")?.sectionOrder[0], "red-flag-warning");
assert.match(outputAuthority.buildThreePartLimitedStateCopy({
  knownFacts: "已记录主诉",
  unavailableConclusion: "具体用量建议",
  reason: "性别生理风险分层未明确",
  nextAction: "补充后重新评估",
}), /当前已确认[\s\S]*当前尚不能形成[\s\S]*下一步/);
assert.match(outputAuthority.buildThreePartLimitedStateCopyForSurface("limited_clinical_scheme", {
  knownFacts: "已记录主诉",
  unavailableConclusion: "完整诊疗方案",
  reason: "尚有关键事实待核实",
  nextAction: "补充后重新评估",
}), /当前已确认[\s\S]*当前尚不能形成[\s\S]*下一步/);
assert.throws(
  () => outputAuthority.buildThreePartLimitedStateCopyForSurface("comprehensive_clinical_scheme", {
    knownFacts: "已记录主诉",
    unavailableConclusion: "完整诊疗方案",
    reason: "尚有关键事实待核实",
    nextAction: "补充后重新评估",
  }),
  /does not authorize limited-state copy/,
);

const herbIdentity = await jiti.import("../src/lib/tcm-herb-identity.ts");
assert.equal(herbIdentity.resolveGovernedTcmHerbIdentity("杏仁").canonicalName, "苦杏仁");
assert.deepEqual(herbIdentity.resolveGovernedTcmHerbIdentity("百条根"), {
  inputName: "百条根",
  status: "ambiguous",
  candidates: ["一枝黄花", "威灵仙", "百部"],
});
assert.equal(herbIdentity.resolveGovernedTcmHerbIdentity("干姜片").canonicalName, "干姜");
assert.equal(herbIdentity.resolveGovernedTcmHerbIdentity("茯神").doseCanonicalName, "茯苓");
assert.equal(herbIdentity.resolveGovernedTcmHerbIdentity("芍药").status, "ambiguous");

const requiredFieldRuntime = await jiti.import("../src/lib/clinical-required-fields.ts");
assert.equal(requiredFieldRuntime.validateCollectRequiredFields(undefined).ok, false);
assert.equal(requiredFieldRuntime.validateCollectRequiredFields("其他或未明确").ok, true);
assert.equal(requiredFieldRuntime.patientSexAllowsDoseLevelSuggestion("其他或未明确"), false);
assert.equal(requiredFieldRuntime.patientSexAllowsDoseLevelSuggestion("女"), true);

const treatmentProjects = await jiti.import("../src/lib/tcm-treatment-projects.ts");
const acupuncture = treatmentProjects.getTcmTreatmentProjectDefinition("acupuncture");
assert.equal(acupuncture?.protocolSourceRefs.includes("SRC-SAMR-ACUPUNCTURE-OPS"), true, "T12 protocol evidence must reach the runtime project registry");
assert.equal(acupuncture?.executable, false);
assert.equal(acupuncture?.governedParameterTemplateAvailable, true);
assert.equal(acupuncture?.governedFrequencyTemplateAvailable, true);
assert.equal(acupuncture?.clinicianReviewRequired, true);
assert.equal(treatmentProjects.governedTcmTreatmentPlanTemplate("acupuncture", "患者失眠不寐")?.sitesOrPoints.includes("神门"), true);
assert.equal(treatmentProjects.governedTcmTreatmentPlanTemplate("acupuncture", "普通腰痛")?.indicationTag, "musculoskeletal_pain");
assert.equal(treatmentProjects.governedTcmTreatmentPlanTemplate("acupuncture", "普通湿疹"), undefined);

console.log(JSON.stringify({ tables: 12, syndromeTerms: 2060, treatmentTerms: 1276, governedFormulas: formulas.entries.length, syndromeTagAdjudications: syndromeTagAdjudications.entries.length, herbNames: herbs.summary.standardNameCount, failures: 0 }));
