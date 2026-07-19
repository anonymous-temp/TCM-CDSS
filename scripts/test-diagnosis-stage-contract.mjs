import assert from "node:assert/strict";

const { canonicalTcmHerbIdentity, describeM03WesternSupportConflict, isCompleteM04Reasoning, isM04TherapyMatchAligned, isStableM03Reasoning, isUnstableM03CoreText, m03SemanticIssue, m04SemanticIssue, patientFactSourceQuote, stableM03SyndromeLabel, transparentFormulaTherapyIssue } = await import("../src/lib/diagnosis-stage-contract.ts");
const { getM03TherapyLock } = await import("../src/lib/m03-therapy-lock.ts");
const { advanceM04RepairState, canAcceptTransparentFormulaFallback, initialM04RepairState } = await import("../src/lib/m04-repair-policy.ts");
const { editedPrescriptionSemanticIssue } = await import("../src/lib/prescription-revision.ts");
const { decoctionRuleSatisfied, requiredDecoctionRequirement } = await import("../src/lib/herb-decoction-rules.ts");
const { applyDeterministicCandidateTherapyMatch, applyDeterministicDecoctionMethod, applyDeterministicFollowUpNode, applyDeterministicFormulaAnalysis, applyDeterministicHerbDecoctionRequirements, applyDeterministicHerbFunctions, applyDeterministicHerbPrescriptionRoles, applyDeterministicHerbTargets, declassifyUnsupportedM03WesternPrimary, groundStructuredPatientFacts, normalizeDiagnoseConfidenceAndLabels, sanitizeOptionalPathogenesisClassifications, synchronizeVisibleClinicalSummary } = await import("../src/lib/diagnosis-visible-summary.ts");
const { buildTcmHerbPairAdvisory, buildTcmKnowledgeContext, findTcmHerbPairIncompatibilities, getTcmHerbDoseLimit, getTcmHerbFunctionText, isKnownTcmHerbName } = await import("../src/lib/tcm-knowledge.ts");
const { buildPrescribePrompt } = await import("../src/lib/diagnosis-prompts.ts");
const { normalizeModelNullableText, normalizePrescriptionRole } = await import("../src/lib/diagnosis-types.ts");
const { compileM04JsonObjectContent, compileM04Proposal, m04ProposalIssueCode } = await import("../src/lib/m04-proposal-compiler.ts");
const { sanitizeDiagnoseStreamingDraft } = await import("../src/lib/diagnosis-stream-safety.ts");
const { buildM04ClinicalReviewPayload, buildM04ClinicalReviewPrompt, canRebindM04ClinicalReview, m04ClinicalReviewSemanticHash, parseM04ClinicalReview } = await import("../src/lib/m04-clinical-review.ts");

assert.equal(requiredDecoctionRequirement("大黄"), "禁止久煎");
assert.equal(decoctionRuleSatisfied("大黄", "久煎"), false);
assert.equal(decoctionRuleSatisfied("大黄", "不宜久煎"), true);
assert.equal(decoctionRuleSatisfied("人参", "另煎"), true);
assert.equal(decoctionRuleSatisfied("人参", "另炖"), true);
assert.equal(decoctionRuleSatisfied("人参", "冲服"), false);
assert.equal(stableM03SyndromeLabel("风邪袭肺证，肺气虚尚待进一步辨证"), "风邪袭肺证");
assert.equal(stableM03SyndromeLabel("证候尚待确认"), undefined);
assert.match(requiredDecoctionRequirement("朱砂") || "", /禁止同煎/);
assert.equal(decoctionRuleSatisfied("朱砂", "常规同煎"), false);
assert.equal(decoctionRuleSatisfied("朱砂", "不入煎剂，研末冲服"), true);
assert.match(requiredDecoctionRequirement("芒硝") || "", /禁止同煎/);
assert.equal(decoctionRuleSatisfied("芒硝", "烊化后兑服，不与群药同煎"), true);
assert.match(requiredDecoctionRequirement("雷丸") || "", /禁止同煎/);
assert.equal(requiredDecoctionRequirement("甘草"), undefined);
assert.match(requiredDecoctionRequirement("苦杏仁") || "", /后下/);
assert.match(requiredDecoctionRequirement("苦杏仁") || "", /捣碎/);
assert.match(requiredDecoctionRequirement("荆芥") || "", /后下/);
assert.match(requiredDecoctionRequirement("枇杷叶") || "", /包煎/);
assert.match(requiredDecoctionRequirement("菟丝子") || "", /包煎/);
for (const [herb, method] of [
  ["砂仁", /后下/], ["荆芥", /后下/], ["紫苏叶", /后下/], ["薄荷", /后下/],
  ["石膏", /先煎/], ["鱼腥草", /后下/], ["苦杏仁", /后下/], ["木香", /后下/],
  ["莱菔子", /包煎/], ["车前子", /包煎/], ["滑石", /包煎/], ["龙骨", /先煎/],
  ["牡蛎", /先煎/], ["龟甲", /先煎/], ["鳖甲", /先煎/], ["鹿茸", /另煎|冲服/],
]) {
  assert.match(requiredDecoctionRequirement(herb) || "", method, `${herb} must keep the method required by the live Lingxi common-herb calibration`);
}
assert.match(requiredDecoctionRequirement("龙骨") || "", /先煎/);
assert.match(getTcmHerbFunctionText("煅龙骨"), /重镇安神药/);
assert.match(getTcmHerbFunctionText("麦冬"), /补阴药/);
assert.match(getTcmHerbFunctionText("人参"), /大补元气.*补脾益肺/);
assert.doesNotMatch(getTcmHerbFunctionText("人参"), /痛经|痈肿|驻颜/);
assert.ok(getTcmHerbFunctionText("人参").length <= 100, "doctor-facing herb functions must stay concise");
assert.deepEqual(getTcmHerbDoseLimit("茯神"), { min: 10, max: 15, basis: "茯神为带松根的茯苓部位，用量按茯苓现有知识边界复核", sourceType: "dose" });
assert.deepEqual(getTcmHerbDoseLimit("黄耆"), getTcmHerbDoseLimit("黄芪"), "formula-catalog and modern 黄芪 spellings must share one dose boundary");
assert.equal(canonicalTcmHerbIdentity("黄耆"), canonicalTcmHerbIdentity("黄芪"), "historical spellings share one prescription identity");
assert.equal(canonicalTcmHerbIdentity("元胡"), canonicalTcmHerbIdentity("延胡索"), "knowledge-source parenthetical aliases share one prescription identity");
assert.equal(canonicalTcmHerbIdentity("炙甘草"), canonicalTcmHerbIdentity("甘草"), "a processed name without an independent knowledge row remains the same prescription source identity");
assert.notEqual(canonicalTcmHerbIdentity("生地黄"), canonicalTcmHerbIdentity("熟地黄"), "independent knowledge rows must not be over-collapsed as processing aliases");
assert.equal(isKnownTcmHerbName("延胡索"), true, "parenthetical aliases in the knowledge source must resolve to the canonical herb row");
assert.deepEqual({ min: getTcmHerbDoseLimit("延胡索")?.min, max: getTcmHerbDoseLimit("延胡索")?.max }, { min: 3, max: 10 });
assert.equal(isKnownTcmHerbName("元胡"), true);
assert.equal(isKnownTcmHerbName("丹皮"), true);
assert.deepEqual({ min: getTcmHerbDoseLimit("板蓝根")?.min, max: getTcmHerbDoseLimit("板蓝根")?.max }, { min: 9, max: 15 }, "per-herb decoction records take precedence over a wider convenience table");
assert.deepEqual({ min: getTcmHerbDoseLimit("何首乌")?.min, max: getTcmHerbDoseLimit("何首乌")?.max }, { min: 3, max: 6 }, "dose-source conflicts resolve to the governed per-herb decoction record");
for (const [herb, min, max] of [
  ["石斛", 6, 12],
  ["青礞石", 3, 6],
  ["金礞石", 3, 6],
  ["满山红", 25, 50],
  ["槟榔", 3, 10],
]) {
  const limit = getTcmHerbDoseLimit(herb);
  assert.deepEqual({ min: limit?.min, max: limit?.max }, { min, max }, `${herb} keeps an explicit conservative primary range instead of collapsing to null`);
  assert.equal(limit?.sourceConflict, true, `${herb} exposes its divergent route/indication range for governance and audit tracing`);
  assert.ok(limit?.alternatives?.length > 0, `${herb} retains the conflicting route/indication ranges and their source metadata`);
}
assert.equal(isKnownTcmHerbName("夜交藤"), true);
assert.deepEqual(getTcmHerbDoseLimit("夜交藤")?.max, 15);
const doseLimitedKnowledge = buildTcmKnowledgeContext({ patient: {}, chiefComplaint: "失眠", conversation: [] }, "prescribe");
assert.match(doseLimitedKnowledge, /候选处方剂量限定名单/);
assert.match(doseLimitedKnowledge, /茯神10-15g.*夜交藤9-15g/);
assert.match(doseLimitedKnowledge, /槟榔3-10g[^；]*存在分用途剂量差异/, "M04 receives a professional dose-source conflict boundary before generation");
assert.match(doseLimitedKnowledge, /模型生成前置配伍核验索引/);
assert.equal(findTcmHerbPairIncompatibilities(["乌头", "半夏"]).length, 1, "structured herb-pair knowledge identifies a high-risk incompatibility before the real audit");
assert.equal(findTcmHerbPairIncompatibilities(["酸枣仁", "川芎"]).length, 0);
assert.match(buildTcmHerbPairAdvisory(["半夏", "乌头"]), /乌头—半夏.*重点复核.*不阻断诊疗流程/s);
assert.equal(buildTcmHerbPairAdvisory(["酸枣仁", "川芎"]), "");
const prescribePrompt = buildPrescribePrompt({ patient: {}, chiefComplaint: "失眠", conversation: [] });
assert.match(prescribePrompt, /"modifications"/, "M04 proposal must expose the bounded IF-THEN modification channel");
assert.match(prescribePrompt, /targetRef.*P1/, "every modification must reference an M03 pathogenesis node");
assert.doesNotMatch(prescribePrompt, /## 加减方案/);
assert.match(prescribePrompt, /tcm-cdss-m04-proposal-v1/);
assert.match(prescribePrompt, /模型只提交需要临床生成的最小提案/);
assert.match(prescribePrompt, /decoction 必须是单个对象.*doseCount 字符串.*不得省略/s, "M04 generator receives the exact executable regimen contract before any repair");
assert.match(prescribePrompt, /恰有 1–2 味君药[\s\S]*targetRef=P1/, "M04 generation defines emperor cardinality and binds every emperor to P1 before any repair");
const stable = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    primarySyndrome: "心肝血虚证",
    overallPathogenesis: "血不养心，心神失舍",
    recommendedFormulaDirection: "酸枣仁汤加减",
    recommendedFormulaNames: ["酸枣仁汤"],
    formulaSelectionMode: "single",
  },
  westernDiagnosis: {
    primary: {
      name: "慢性失眠障碍倾向",
      status: "考虑",
      confidence: "中",
      supportingFacts: ["入睡困难"],
      limitations: ["尚需结合日间功能受损情况"],
      suggestedChecks: [],
      evidence: { evidenceLevel: "model_inference", source: "基于本例已提供病史", confidence: "中" },
    },
    differentials: [],
  },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "入睡困难", syndromeEvidence: "舌淡脉细", pathogenesis: "心血不足", therapyDirection: "养血安神", pathogenesisType: "主因", biaoBen: "本虚" }] },
  therapy: { overallPrinciple: "养血安神，疏肝解郁" },
};

assert.equal(isStableM03Reasoning(stable), true);
for (const name of ["功能性/感染性肠炎恢复期", "功能性腹泻或感染性腹泻", "胃炎、胃食管反流病待鉴别"]) {
  const ambiguousWesternPrimary = {
    ...stable,
    westernDiagnosis: {
      ...stable.westernDiagnosis,
      primary: { ...stable.westernDiagnosis.primary, name },
    },
  };
  assert.equal(m03SemanticIssue(ambiguousWesternPrimary, "稀便半个月"), "western_primary_ambiguous", `${name} must be repaired by the semantic model into one primary diagnosis and differentials`);
  assert.equal(isStableM03Reasoning(ambiguousWesternPrimary), false);
  const normalizedContent = normalizeDiagnoseConfidenceAndLabels(
    `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(ambiguousWesternPrimary)}\n<!-- DIAGNOSIS_JSON_END -->`,
    "稀便半个月",
  );
  const normalizedReasoning = JSON.parse(normalizedContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  assert.equal(normalizedReasoning.westernDiagnosis.primary.name, name, `${name} must remain intact for model repair instead of being split by punctuation`);
  assert.equal(m03SemanticIssue(normalizedReasoning, "稀便半个月"), "western_primary_ambiguous");
}
const backgroundHypertensionPrimary = {
  ...stable,
  westernDiagnosis: {
    ...stable.westernDiagnosis,
    primary: { ...stable.westernDiagnosis.primary, name: "高血压", supportingFacts: ["高血压病史"] },
  },
};
assert.equal(
  m03SemanticIssue(backgroundHypertensionPrimary, '入睡困难；舌淡脉细；口渴乏力、双足麻木3个月\n{"presentHistory":"2型糖尿病10年，高血压；HbA1c 8.4%"}\n{"BP":"120/78mmHg"}'),
  "western_support_historical_only",
  "a stable historical comorbidity without current activity cannot become the primary diagnosis support",
);
assert.equal(m03SemanticIssue({
  ...stable,
  westernDiagnosis: { ...stable.westernDiagnosis, primary: { ...stable.westernDiagnosis.primary, supportingFacts: ["舌淡脉细"] } },
}, "入睡困难；舌淡脉细"), "western_support_tcm_pollution", "TCM findings cannot be used as western-diagnosis supporting facts");
assert.equal(m03SemanticIssue({
  ...stable,
  westernDiagnosis: { ...stable.westernDiagnosis, primary: { ...stable.westernDiagnosis.primary, supportingFacts: ["42岁", "血压118/76mmHg", "体温36.6℃"] } },
}, "42岁；入睡困难；血压118/76mmHg；体温36.6℃"), "western_support_demographic_padding", "demographics and generic normal vitals cannot pad western-diagnosis evidence");
assert.equal(m03SemanticIssue({
  ...stable,
  westernDiagnosis: { ...stable.westernDiagnosis, primary: { ...stable.westernDiagnosis.primary, supportingFacts: ["入睡困难", "42岁"] } },
}, "42岁；入睡困难"), "western_support_demographic_padding", "a real clinical fact cannot hide demographic padding in western-diagnosis evidence");
const westernSupportPolarityConflict = {
  ...stable,
  westernDiagnosis: { ...stable.westernDiagnosis, primary: { ...stable.westernDiagnosis.primary, supportingFacts: ["夜间反复呼吸暂停"] } },
};
assert.equal(m03SemanticIssue(westernSupportPolarityConflict, "入睡困难；否认呼吸暂停"), "western_support_polarity_mismatch", "western supporting facts must share the source polarity boundary");
assert.match(
  describeM03WesternSupportConflict(westernSupportPolarityConflict, "入睡困难；否认呼吸暂停") || "",
  /supportingFacts.*夜间反复呼吸暂停.*否认.*呼吸暂停.*不得把阴性事实反写成阳性/,
  "the repair prompt must name the exact western-support polarity conflict without weakening rejection",
);
const mixedPolarityWesternSupport = {
  ...stable,
  westernDiagnosis: { ...stable.westernDiagnosis, primary: { ...stable.westernDiagnosis.primary, supportingFacts: ["夜间出汗伴入睡困难1个月"] } },
};
const mixedPolarityWesternContext = [
  "夜间出汗伴入睡困难1个月",
  JSON.stringify({
    patientName: "测试患者",
    tcmDetail: "无发热、咳嗽、消瘦或心悸，盗汗以入睡后为主，醒后可缓解",
    tcmTongue: "舌淡脉细",
  }),
  "医生/患者：患者躺下后长时间无法入睡，无多梦、心慌",
].join("\n");
assert.equal(describeM03WesternSupportConflict(mixedPolarityWesternSupport, mixedPolarityWesternContext), undefined, "an unrelated negated symptom must not poison affirmed western supporting facts in the same chart");
assert.equal(m03SemanticIssue(mixedPolarityWesternSupport, mixedPolarityWesternContext), undefined, "a mixed-polarity chart remains valid when each supporting concept preserves its own polarity");
const groundedMixedPolarityWesternSupportContent = groundStructuredPatientFacts(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(mixedPolarityWesternSupport)}\n<!-- DIAGNOSIS_JSON_END -->`,
  mixedPolarityWesternContext,
);
const groundedMixedPolarityWesternSupport = JSON.parse(
  groundedMixedPolarityWesternSupportContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.ok(groundedMixedPolarityWesternSupport.westernDiagnosis.primary.supportingFacts.some((fact) => /夜间出汗|入睡困难|盗汗/.test(fact)));
assert.ok(groundedMixedPolarityWesternSupport.westernDiagnosis.primary.supportingFacts.every((fact) => !/测试患者|舌淡|脉细/.test(fact)), "serialized demographics and TCM findings must never be projected into western supporting facts");
assert.equal(
  m03SemanticIssue(groundedMixedPolarityWesternSupport, mixedPolarityWesternContext),
  undefined,
  "deterministic western-fact grounding must not reintroduce a polarity conflict after a model repair",
);
const overstatedWesternContent = groundedMixedPolarityWesternSupportContent.replace(
  '"name": "慢性失眠障碍倾向"',
  '"name": "慢性失眠障碍"',
);
const declassifiedWesternContent = declassifyUnsupportedM03WesternPrimary(overstatedWesternContent, mixedPolarityWesternContext);
const declassifiedWestern = JSON.parse(
  declassifiedWesternContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.equal(declassifiedWestern.westernDiagnosis.primary.name, "夜间出汗伴入睡困难症状", "a reviewer-rejected disease label is demoted to the chart's symptom-level chief complaint");
assert.equal(declassifiedWestern.westernDiagnosis.primary.status, "证据有限");
assert.equal(declassifiedWestern.westernDiagnosis.primary.confidence, "低");
assert.ok(declassifiedWestern.westernDiagnosis.differentials.some((item) => item.name === "慢性失眠障碍"), "the rejected concrete disease remains visible as a differential instead of being silently discarded");
assert.equal(m03SemanticIssue(declassifiedWestern, mixedPolarityWesternContext), undefined, "safe diagnostic declassification must still pass every deterministic M03 contract before re-review");
const paraphrasedSparseChainContent = groundStructuredPatientFacts(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({
    ...mixedPolarityWesternSupport,
    pathogenesis: {
      chain: [{
        nodeId: "P1",
        patientFact: "睡中汗出并影响睡眠",
        syndromeEvidence: "睡中汗出并影响睡眠",
        pathogenesis: "汗液调节与睡眠功能受扰",
        therapyDirection: "调护睡眠功能，改善汗液调节",
      }],
    },
    therapy: { overallPrinciple: "调护睡眠功能，改善汗液调节" },
  })}\n<!-- DIAGNOSIS_JSON_END -->`,
  mixedPolarityWesternContext,
);
const paraphrasedSparseChain = JSON.parse(
  paraphrasedSparseChainContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.equal(paraphrasedSparseChain.pathogenesis.chain.length, 1, "a neutral functional sparse-case mechanism is rebound instead of erased when only its patient-fact paraphrase is ungrounded");
assert.equal(paraphrasedSparseChain.pathogenesis.chain[0].patientFact, "夜间出汗伴入睡困难1个月");
assert.equal(paraphrasedSparseChain.pathogenesis.chain[0].syndromeEvidence, "夜间出汗伴入睡困难1个月");
assert.equal(m03SemanticIssue(paraphrasedSparseChain, mixedPolarityWesternContext), undefined, "the rebound chain still has to satisfy the complete deterministic M03 contract before independent review");
assert.equal(isStableM03Reasoning({ ...stable, formula: { candidates: [] } }), false, "M03 must keep formula null");
assert.equal(isStableM03Reasoning({ ...stable, therapy: { overallPrinciple: "养血安神；酸枣仁15g、丹参10g，每日1剂，水煎服" } }), false, "M03 must reject dose-level treatment instructions before signing");
for (const instruction of ["养血安神，酸枣仁十五克", "养血安神，酸枣仁（炒）15g", "养血安神，酸枣仁15～20g"]) {
  assert.equal(isStableM03Reasoning({ ...stable, therapy: { overallPrinciple: instruction } }), false, `M03 must reject normalized dose instruction: ${instruction}`);
}
for (const instruction of ["酸枣仁（炒制后）各15～20g", "酸枣仁各15g", "酸枣仁约15g", "酸枣仁用量15g", "酸枣仁１５g", "酸枣仁七点五克", "酸枣仁三钱", "酸枣仁一两", "每日一剂", "连服三剂"]) {
  assert.equal(isStableM03Reasoning({ ...stable, therapy: { overallPrinciple: `养血安神；${instruction}` } }), false, `M03 must reject dose variant: ${instruction}`);
}
for (const instruction of ["酸枣仁用量约15g", "酸枣仁（炒）每味约15g", "酸枣仁15±5g", "酸枣仁十余克", "每日半剂", "一剂分三次服"]) {
  assert.equal(isStableM03Reasoning({ ...stable, therapy: { overallPrinciple: `养血安神；${instruction}` } }), false, `M03 must reject compound dose variant: ${instruction}`);
}
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ ...stable.pathogenesis.chain[0], patientFact: "既往服甘草10g" }] },
}, "既往服甘草10g，入睡困难；舌淡脉细"), true, "a grounded historical medication dose may remain a patient fact without becoming an M03 instruction");
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "舌淡红苔薄白", syndromeEvidence: "舌淡红苔薄白支持血虚", pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
}, "患者舌淡红苔薄白"), false);
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "入睡困难", syndromeEvidence: "入睡困难支持血虚", pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
}, "患者入睡困难，舌淡红苔薄白"), true);
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "入睡困难", syndromeEvidence: "心悸、健忘、纳差、便溏支持心脾两虚", pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
}, "患者入睡困难；伴心悸健忘；食欲欠佳；大便溏薄"), true);
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "入睡困难", syndromeEvidence: "心悸、盗汗支持心脾两虚", pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
}, "患者入睡困难；伴心悸健忘；否认盗汗"), false);
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "入睡困难", syndromeEvidence: "耳鸣支持心脾两虚", pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
}, "患者入睡困难；伴心悸健忘"), false);
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "晨起神疲、纳差便溏", syndromeEvidence: "神疲纳差支持气血不足", pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
}, "晨起疲乏；食欲欠佳；大便溏薄"), true);
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "夜间易醒，白天疲乏", syndromeEvidence: "睡眠不佳、疲乏支持心神失养", pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
}, "最近老睡不好，夜里容易醒，白天有点累，大概两个月"), true, "colloquial tiredness grounds the same positive fatigue concept");
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "心悸伴耳鸣", syndromeEvidence: "心悸耳鸣支持血虚", pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
}, "患者仅记录心悸"), false);
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "否认打鼾、呼吸暂停及日间嗜睡", syndromeEvidence: "睡眠呼吸暂停线索阴性", pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
}, "患者否认明显打鼾、目击呼吸暂停及日间嗜睡"), true);
assert.equal(isStableM03Reasoning(stable, "", "**证候诊断**：痰热扰心证\n**核心病机**：血不养心，心神失舍\n**总治法**：养血安神，疏肝解郁"), true);
assert.equal(isStableM03Reasoning(stable, "", "**证候诊断**：心肝血虚证\n**核心病机**：血不养心，心神失舍\n**总治法**：养血安神，疏肝解郁"), true);
const boundedResolution = {
  ...stable,
  overview: {
    ...stable.overview,
    primarySyndromeResolution: "bounded",
    primarySyndromeBasis: [],
    primarySyndromeResolutionReason: "舌脉未提供，当前为有限资料下的工作判断",
  },
  pathogenesis: {
    ...stable.pathogenesis,
    locationDifferentiation: {
      items: ["心"],
      details: [],
      resolution: "bounded",
      resolutionReason: "病位为有限资料下的工作归纳",
    },
    natureDifferentiation: {
      items: ["血虚"],
      rootDeficiency: ["血虚"],
      branchExcess: [],
      basis: "",
      resolution: "bounded",
      resolutionReason: "病性为有限资料下的工作归纳",
    },
  },
};
assert.equal(isStableM03Reasoning(boundedResolution), true, "bounded clinical reasoning must continue without a keyword gate");
assert.equal(m03SemanticIssue({
  ...boundedResolution,
  overview: { ...boundedResolution.overview, primarySyndromeResolutionReason: "" },
}), "primary_syndrome_resolution_reason_missing");
assert.equal(m03SemanticIssue({
  ...boundedResolution,
  pathogenesis: {
    ...boundedResolution.pathogenesis,
    locationDifferentiation: { items: ["心"], resolution: "unresolved", resolutionReason: "当前资料不足以定位病位" },
  },
}), "location_unresolved_with_items");
assert.equal(m03SemanticIssue({
  ...boundedResolution,
  pathogenesis: {
    ...boundedResolution.pathogenesis,
    natureDifferentiation: { items: [], rootDeficiency: [], branchExcess: [], basis: "", resolution: "unresolved", resolutionReason: "当前资料不足以归纳病性" },
  },
}), undefined, "an explicitly unresolved optional nature remains valid and does not block M03");
const resolvedResolution = {
  ...boundedResolution,
  overview: {
    ...boundedResolution.overview,
    primarySyndromeResolution: "resolved",
    primarySyndromeBasis: ["入睡困难"],
    primarySyndromeResolutionReason: undefined,
  },
  pathogenesis: {
    ...boundedResolution.pathogenesis,
    locationDifferentiation: {
      items: ["心"],
      details: [{ location: "心", basis: "入睡困难" }],
      resolution: "resolved",
    },
    natureDifferentiation: {
      items: ["血虚"],
      rootDeficiency: ["血虚"],
      branchExcess: [],
      basis: "舌淡脉细",
      resolution: "resolved",
    },
  },
};
assert.equal(isStableM03Reasoning(resolvedResolution, "入睡困难；舌淡脉细"), true);
assert.equal(m03SemanticIssue({
  ...resolvedResolution,
  overview: { ...resolvedResolution.overview, primarySyndromeBasis: ["患者从未说过的症状"] },
}, "入睡困难；舌淡脉细"), "primary_syndrome_basis_ungrounded");
assert.equal(m03SemanticIssue({
  ...resolvedResolution,
  pathogenesis: {
    ...resolvedResolution.pathogenesis,
    natureDifferentiation: { ...resolvedResolution.pathogenesis.natureDifferentiation, basis: "患者从未说过的症状" },
  },
}, "入睡困难；舌淡脉细"), "nature_resolved_basis_ungrounded");
assert.equal(isUnstableM03CoreText("本例信息仍不足，暂不能形成稳定证候"), true);
assert.equal(isUnstableM03CoreText("气滞血瘀，心脉痹阻；信息有限需结合检查复核"), false);
assert.equal(isStableM03Reasoning({ ...stable, pathogenesis: { chain: [] } }), false);
assert.equal(isStableM03Reasoning({ ...stable, stage: "prescribe" }), false);
assert.equal(isStableM03Reasoning(undefined), false);
const heatReasoning = {
  ...stable,
  overview: { primarySyndrome: "肝郁化火证", overallPathogenesis: "肝郁化火，上扰心神" },
  therapy: { overallPrinciple: "疏肝清热，宁心安神" },
  pathogenesis: { chain: [{ patientFact: "烦躁失眠", syndromeEvidence: "烦躁失眠、口苦、舌红苔黄、脉数支持热象", pathogenesis: "肝郁化火", therapyDirection: "清肝泻火" }] },
};
assert.equal(isStableM03Reasoning(heatReasoning, "舌淡苔白，脉缓，口不渴，无明显热象"), false);
assert.equal(isStableM03Reasoning(heatReasoning, "烦躁失眠，口苦，舌红苔黄，脉数"), true);
assert.equal(isStableM03Reasoning(heatReasoning, "烦躁失眠，否认口苦、盗汗、潮热，舌淡苔白，脉缓"), false);

const groundedPathogenesisClassification = {
  ...stable,
  pathogenesis: {
    ...stable.pathogenesis,
    locationDifferentiation: {
      items: ["心"],
      details: [{ location: "心", basis: "入睡困难" }],
    },
    natureDifferentiation: {
      items: ["心血不足"],
      rootDeficiency: ["心血不足"],
      branchExcess: [],
      basis: "舌淡，脉细",
    },
    symptomClusters: [{ symptoms: ["入睡困难", "舌淡", "脉细"], mechanism: "心血不足，心神失养" }],
  },
};
assert.equal(
  m03SemanticIssue({
    ...groundedPathogenesisClassification,
    pathogenesis: {
      ...groundedPathogenesisClassification.pathogenesis,
      locationDifferentiation: { items: [], details: [] },
    },
  }, "入睡困难；舌淡；脉细"),
  undefined,
  "an empty optional disease-location classification must not invalidate a complete core M03",
);
assert.equal(
  m03SemanticIssue({
    ...groundedPathogenesisClassification,
    pathogenesis: {
      ...groundedPathogenesisClassification.pathogenesis,
      natureDifferentiation: { items: [], rootDeficiency: [], branchExcess: [], basis: "" },
    },
  }, "入睡困难；舌淡；脉细"),
  undefined,
  "an empty optional disease-nature classification must not invalidate a complete core M03",
);
assert.equal(
  isStableM03Reasoning(groundedPathogenesisClassification, "入睡困难；舌淡；脉细"),
  true,
  `grounded pathogenesis classification must remain valid: ${m03SemanticIssue(groundedPathogenesisClassification, "入睡困难；舌淡；脉细")}`,
);
const semanticallyGroundedNatureClassification = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "心脾两虚证", overallPathogenesis: "脾气虚弱，心血不足" },
  pathogenesis: {
    chain: [{ ...stable.pathogenesis.chain[0], syndromeEvidence: "纳差、神疲、心悸支持心脾两虚", pathogenesis: "脾气虚弱，心血不足" }],
    natureDifferentiation: { items: ["气血两虚"], rootDeficiency: ["气血两虚"], branchExcess: [], basis: "纳差、神疲、心悸" },
  },
  therapy: { overallPrinciple: "健脾益气，养血安神" },
};
assert.equal(
  isStableM03Reasoning(semanticallyGroundedNatureClassification, "纳差；神疲；心悸；入睡困难"),
  true,
  `a clinically equivalent root-deficiency summary must match its component chain concepts: ${m03SemanticIssue(semanticallyGroundedNatureClassification, "纳差；神疲；心悸；入睡困难")}`,
);
const ungroundedLocationClassification = {
  ...groundedPathogenesisClassification,
  pathogenesis: {
    ...groundedPathogenesisClassification.pathogenesis,
    locationDifferentiation: { items: ["肾"], details: [{ location: "肾", basis: "入睡困难" }] },
  },
};
assert.equal(
  m03SemanticIssue(ungroundedLocationClassification, "入睡困难；舌淡；脉细"),
  undefined,
  "disease-location semantics are reviewed by the independent clinical model instead of a finite organ keyword rule",
);
const ungroundedNatureClassification = {
  ...groundedPathogenesisClassification,
  pathogenesis: {
    ...groundedPathogenesisClassification.pathogenesis,
    natureDifferentiation: { items: ["痰热"], rootDeficiency: [], branchExcess: ["痰热"], basis: "入睡困难" },
  },
};
assert.equal(
  m03SemanticIssue(ungroundedNatureClassification, "入睡困难；舌淡；脉细"),
  undefined,
  "disease-nature semantics are reviewed by the independent clinical model instead of a finite syndrome keyword rule",
);
const ungroundedSymptomCluster = {
  ...groundedPathogenesisClassification,
  pathogenesis: {
    ...groundedPathogenesisClassification.pathogenesis,
    symptomClusters: [{ symptoms: ["心悸"], mechanism: "心血不足，心神失养" }],
  },
};
assert.equal(
  m03SemanticIssue(ungroundedSymptomCluster, "入睡困难；舌淡；脉细"),
  undefined,
  "optional symptom clusters are sanitized independently and do not own the M03 workflow gate",
);
const optionalClassificationContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({
  ...groundedPathogenesisClassification,
  pathogenesis: {
    ...groundedPathogenesisClassification.pathogenesis,
    locationDifferentiation: {
      items: ["心", "肾"],
      details: [
        { location: "心", basis: "入睡困难 → 心神失养，病位在心" },
        { location: "肾", basis: "入睡困难 → 肾精亏虚，病位在肾" },
      ],
    },
    natureDifferentiation: {
      items: ["心血不足", "痰热"],
      rootDeficiency: ["心血不足"],
      branchExcess: ["痰热"],
      basis: "舌淡、脉细 → 支持心血不足，病性属血虚",
    },
    symptomClusters: [
      { symptoms: ["入睡困难", "入睡困难", "舌淡", "脉细"], mechanism: "心血不足" },
      { symptoms: ["心悸"], mechanism: "痰热扰心" },
    ],
  },
})}\n<!-- DIAGNOSIS_JSON_END -->`;
const sanitizedOptionalClassificationContent = sanitizeOptionalPathogenesisClassifications(optionalClassificationContent, "入睡困难；舌淡；脉细");
const sanitizedOptionalClassification = JSON.parse(sanitizedOptionalClassificationContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.deepEqual(sanitizedOptionalClassification.pathogenesis.locationDifferentiation.items, ["心", "肾"]);
assert.deepEqual(sanitizedOptionalClassification.pathogenesis.locationDifferentiation.details, []);
assert.equal(sanitizedOptionalClassification.pathogenesis.locationDifferentiation.resolution, "bounded");
assert.deepEqual(sanitizedOptionalClassification.pathogenesis.natureDifferentiation.items, ["心血不足", "痰热"]);
assert.deepEqual(sanitizedOptionalClassification.pathogenesis.natureDifferentiation.branchExcess, ["痰热"]);
assert.equal(sanitizedOptionalClassification.pathogenesis.natureDifferentiation.resolution, "bounded");
assert.equal(sanitizedOptionalClassification.pathogenesis.symptomClusters.length, 1);
assert.deepEqual(
  sanitizedOptionalClassification.pathogenesis.symptomClusters[0].symptoms,
  ["入睡困难", "舌淡", "脉细"],
  "grounded symptoms are deduplicated within each mechanism cluster before display and signing",
);
assert.equal(
  isStableM03Reasoning(sanitizedOptionalClassification, "入睡困难；舌淡；脉细"),
  true,
  "semantic classifications remain visible with an explicit bounded state while ungrounded patient quotes are removed",
);
const middleJiaoClassificationContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({
  ...groundedPathogenesisClassification,
  overview: { ...groundedPathogenesisClassification.overview, overallPathogenesis: "脾失健运，湿困中焦" },
  pathogenesis: {
    ...groundedPathogenesisClassification.pathogenesis,
    chain: [{ ...groundedPathogenesisClassification.pathogenesis.chain[0], pathogenesis: "脾失健运，湿困中焦" }],
    locationDifferentiation: { items: ["脾", "中焦"], details: [{ location: "中焦", basis: "纳差 → 脾失健运，湿困中焦" }] },
  },
})}\n<!-- DIAGNOSIS_JSON_END -->`;
const middleJiaoClassification = JSON.parse(
  sanitizeOptionalPathogenesisClassifications(middleJiaoClassificationContent, "纳差；入睡困难；舌淡；脉细")
    .split("<!-- DIAGNOSIS_JSON_START -->")[1]
    .split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.deepEqual(middleJiaoClassification.pathogenesis.locationDifferentiation.items, ["脾", "中焦"]);
assert.deepEqual(middleJiaoClassification.pathogenesis.locationDifferentiation.details, [{ location: "中焦", basis: "纳差" }]);

const duplicatedLocationBasisContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({
  ...groundedPathogenesisClassification,
  pathogenesis: {
    ...groundedPathogenesisClassification.pathogenesis,
    chain: [{ ...groundedPathogenesisClassification.pathogenesis.chain[0], pathogenesis: "心脾两虚，心血不足，气血不足" }],
    locationDifferentiation: {
      items: ["心", "脾"],
      details: [
        { location: "心", basis: "入睡困难、日间疲劳 → 心脾两虚，病位在心脾" },
        { location: "脾", basis: "入睡困难、日间疲劳 → 心脾两虚，病位在心脾" },
      ],
    },
  },
})}\n<!-- DIAGNOSIS_JSON_END -->`;
const duplicatedLocationBasis = JSON.parse(
  sanitizeOptionalPathogenesisClassifications(duplicatedLocationBasisContent, "入睡困难；日间疲劳；舌淡；脉细")
    .split("<!-- DIAGNOSIS_JSON_START -->")[1]
    .split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.deepEqual(duplicatedLocationBasis.pathogenesis.locationDifferentiation.details, [], "one copied basis must not be repeated across several disease locations");

const unsafeM03Draft = "## 辨病辨证\n拟予黄芪15g，每日1剂，水煎服。\n<!-- DIAGNOSIS_JSON_START -->\n{\"patientFact\":\"既往服用阿司匹林100mg\"}\n<!-- DIAGNOSIS_JSON_END -->";
const safeM03Draft = sanitizeDiagnoseStreamingDraft(unsafeM03Draft);
assert.doesNotMatch(safeM03Draft.split("<!-- DIAGNOSIS_JSON_START -->")[0], /15g|每日1剂|水煎服/);
assert.match(safeM03Draft, /剂量信息待候选方药阶段核验/);
assert.match(safeM03Draft, /既往服用阿司匹林100mg/, "structured M03 contract must remain byte-stable for signature validation");
const safeCourseDraft = sanitizeDiagnoseStreamingDraft("建议连服3剂后复诊；拟服用7天；共5剂。症状已持续3天。");
assert.doesNotMatch(safeCourseDraft, /连服3剂|服用7天|共5剂/);
assert.match(safeCourseDraft, /症状已持续3天/, "clinical duration is not a prescription course and must remain visible");
const mixedPolarityContext = "问诊补充：无发热、咳嗽、消瘦或心悸，盗汗以入睡后为主，醒后可缓解；主诉：入睡困难1个月";
const mixedPolarityQuote = patientFactSourceQuote("盗汗、入睡困难", mixedPolarityContext);
assert.ok(mixedPolarityQuote, "affirmed symptoms remain groundable when the same source sentence also contains negated symptoms");
assert.ok(patientFactSourceQuote(mixedPolarityQuote, mixedPolarityContext), "a mixed-polarity source quote remains idempotently groundable");

const acuteChestStasisReasoning = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "胸痹心脉痹阻证", overallPathogenesis: "气虚无力推动血脉，瘀阻心脉" },
  pathogenesis: {
    ...stable.pathogenesis,
    chain: [{ patientFact: "胸骨后压榨样疼痛，向左肩放射", syndromeEvidence: "剧烈胸痛支持心脉痹阻", pathogenesis: "心脉瘀阻，不通则痛", therapyDirection: "益气活血，通脉止痛" }],
  },
  therapy: { ...stable.therapy, overallPrinciple: "益气活血，通脉止痛" },
};
assert.equal(
  isStableM03Reasoning(acuteChestStasisReasoning, "突发胸骨后压榨样疼痛1小时，向左肩放射，伴大汗、气促"),
  true,
  `an acute fixed pressure-like radiating chest pain fact may ground a bounded blood-stasis mechanism without inventing tongue or pulse findings: ${m03SemanticIssue(acuteChestStasisReasoning, "突发胸骨后压榨样疼痛1小时，向左肩放射，伴大汗、气促")}`,
);

const colloquialNightSweatReasoning = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "阴虚内热证", overallPathogenesis: "阴液不足，虚热内扰" },
  pathogenesis: {
    ...stable.pathogenesis,
    chain: [{ patientFact: "夜里总出汗", syndromeEvidence: "盗汗支持阴虚", pathogenesis: "阴液不足，虚热内扰", therapyDirection: "滋阴清热" }],
  },
  therapy: { ...stable.therapy, overallPrinciple: "滋阴清热" },
};
assert.equal(
  isStableM03Reasoning(colloquialNightSweatReasoning, "患者夜里总出汗，睡着后出汗，醒来就停；睡不好约一个月"),
  true,
  "colloquial nocturnal sweating must ground the canonical 盗汗 concept without forcing a model retry",
);
const nightSweatYinReasoning = {
  ...stable,
  overview: { primarySyndrome: "阴虚神扰证", overallPathogenesis: "阴虚失养，心神不宁" },
  therapy: { overallPrinciple: "滋阴养心，宁心安神" },
  pathogenesis: { chain: [{ patientFact: "夜里总出汗", syndromeEvidence: "夜间汗出伴睡眠不佳支持阴液不足倾向", pathogenesis: "阴虚失养", therapyDirection: "滋阴养心" }] },
};
assert.equal(isStableM03Reasoning(nightSweatYinReasoning, "夜里总出汗，睡不好，大概一个月"), true);
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "患者有口苦、盗汗、头痛", syndromeEvidence: "口苦盗汗支持热象", pathogenesis: "肝郁化火", therapyDirection: "清肝泻火" }] },
  overview: { primarySyndrome: "肝郁化火证", overallPathogenesis: "肝郁化火，上扰心神" },
  therapy: { overallPrinciple: "疏肝清热" },
}, "患者失眠，无口苦、盗汗、头痛"), false);
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "患者头痛", syndromeEvidence: "头痛支持气机不畅", pathogenesis: "气滞", therapyDirection: "行气" }] },
}, "患者头晕，明确无头痛"), false);
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "患者胸痛", syndromeEvidence: "胸痛支持气滞", pathogenesis: "气滞", therapyDirection: "行气" }] },
}, "患者胸闷，明确无胸痛"), false);
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "患者乏力、食欲不振", syndromeEvidence: "乏力食少支持气虚", pathogenesis: "气虚", therapyDirection: "益气" }] },
}, "患者仅诉入睡困难"), false);
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "工作压力后失眠加重", syndromeEvidence: "入睡困难支持心神不宁", pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
}, "近半年工作压力增大后睡眠逐渐变差"), true);
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "配偶去世后持续悲伤", syndromeEvidence: "情志不遂支持肝郁", pathogenesis: "肝郁气滞", therapyDirection: "疏肝解郁" }] },
}, "患者仅诉入睡困难"), false);

// === Grounding concept canonicalization (objective values + anatomical/synonym equivalence) ===
const chainWithFact = (patientFact, syndromeEvidence = "舌淡脉细") => ({
  ...stable,
  pathogenesis: { chain: [{ patientFact, syndromeEvidence, pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
});
// (a) a measured temperature ≥37.2℃ affirms the 发热 concept even without a literal 发热 clause
for (const temperature of ["体温37.2℃", "体温37.5℃", "T 38.1℃"]) {
  assert.equal(m03SemanticIssue(chainWithFact("发热"), `入睡困难；舌淡脉细；${temperature}`), undefined, `a measured fever-range temperature affirms the 发热 concept (${temperature})`);
}
assert.equal(m03SemanticIssue(chainWithFact("发烧"), "入睡困难；舌淡脉细；体温38.2℃"), undefined, "colloquial 发烧 canonicalizes to the same fever concept as the measured temperature");
// an in-range temperature with no fever statement still rejects an affirmed 发热 (fail-closed)
assert.equal(m03SemanticIssue(chainWithFact("发热"), "入睡困难；舌淡脉细；体温36.5℃"), "patient_fact_ungrounded_0_0_polarity", "an in-range temperature without any fever statement still rejects an affirmed 发热");
assert.equal(m03SemanticIssue(chainWithFact("无发热"), "入睡困难；舌淡脉细；体温36.5℃"), undefined, "an in-range measured temperature grounds a negated 发热 fact");
assert.equal(m03SemanticIssue(chainWithFact("无发热"), "入睡困难；舌淡脉细；体温38.2℃"), "patient_fact_ungrounded_0_0_polarity", "a negated 发热 fact conflicts with a fever-range measured temperature");
assert.equal(m03SemanticIssue(chainWithFact("无发热"), "发热3天；舌淡脉细；体温36.5℃"), "patient_fact_ungrounded_0_0_polarity", "a normal current reading does not erase a charted fever history");
// (b) anatomical/synonym equivalence inside the abdominal-pain group
assert.equal(m03SemanticIssue(chainWithFact("腹痛"), "上腹隐痛3天；舌淡脉细；入睡困难"), undefined, "腹痛 canonicalizes to the chart's 上腹隐痛");
assert.equal(m03SemanticIssue(chainWithFact("上腹隐痛"), "腹痛3天；舌淡脉细；入睡困难"), undefined, "上腹隐痛 canonicalizes to the chart's 腹痛");
assert.equal(m03SemanticIssue(chainWithFact("胃脘痛"), "腹痛3天；舌淡脉细；入睡困难"), undefined, "胃脘痛 canonicalizes to the chart's 腹痛");
// (c) unknown concepts keep the literal fail-closed requirement
assert.equal(m03SemanticIssue(chainWithFact("皮疹瘙痒"), "入睡困难；舌淡脉细"), "patient_fact_ungrounded_0_0_literal", "unknown concepts still literal-reject without record support");
assert.equal(m03SemanticIssue(chainWithFact("皮疹瘙痒3天"), "皮疹瘙痒3天；舌淡脉细"), undefined, "unknown concepts still ground on literal record support");
// (d) polarity mismatch still rejects, including concepts matched only via the canonical surface
assert.equal(m03SemanticIssue(chainWithFact("发热"), "入睡困难；舌淡脉细；否认发热"), "patient_fact_ungrounded_0_0_polarity", "an explicit denial still rejects an affirmed 发热");
assert.equal(m03SemanticIssue(chainWithFact("腹痛"), "入睡困难；舌淡脉细；否认腹痛"), "patient_fact_ungrounded_0_0_polarity", "an explicit denial still rejects an affirmed 腹痛");
assert.equal(m03SemanticIssue(chainWithFact("寒战"), "入睡困难；舌淡脉细；无寒战，体温36.5℃"), "patient_fact_ungrounded_0_0_polarity", "an affirmed 寒战 cannot be grounded by a record that denies it");
assert.equal(m03SemanticIssue(chainWithFact("无寒战"), "入睡困难；舌淡脉细；无寒战，体温36.5℃"), undefined, "a negated 寒战 matches the record's explicit denial");
// canonical grounding rebinds chain nodes to the chart source clause instead of silently dropping them
const abdominalCanonicalContext = "上腹隐痛3天，舌淡红苔薄白；入睡困难";
const abdominalCanonical = JSON.parse(
  groundStructuredPatientFacts(
    `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(chainWithFact("腹痛", "舌淡红苔薄白"))}\n<!-- DIAGNOSIS_JSON_END -->`,
    abdominalCanonicalContext,
  ).split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.equal(abdominalCanonical.pathogenesis.chain.length, 1, "a canonical abdominal-pain match keeps the chain node instead of dropping it");
assert.match(abdominalCanonical.pathogenesis.chain[0].patientFact, /上腹隐痛/, "the chain node rebinds to the chart's source clause");
assert.equal(m03SemanticIssue(abdominalCanonical, abdominalCanonicalContext), undefined, "the canonically grounded chain passes the full M03 contract");
const feverObjectiveContext = "体温38.2℃；舌淡红苔薄白；入睡困难";
const feverObjective = JSON.parse(
  groundStructuredPatientFacts(
    `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(chainWithFact("发热", "舌淡红苔薄白"))}\n<!-- DIAGNOSIS_JSON_END -->`,
    feverObjectiveContext,
  ).split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.equal(feverObjective.pathogenesis.chain.length, 1, "objective temperature affirmation keeps the fever chain node");
assert.match(feverObjective.pathogenesis.chain[0].patientFact, /38\.2/, "the fever node rebinds to the measured-temperature source clause");
assert.equal(m03SemanticIssue(feverObjective, feverObjectiveContext), undefined, "the objectively grounded fever chain passes the full M03 contract");

// === Western-support de-pollution ===
const westernSupportOf = (supportingFacts) => ({
  ...stable,
  westernDiagnosis: { ...stable.westernDiagnosis, primary: { ...stable.westernDiagnosis.primary, supportingFacts } },
});
const stableSupportContext = "入睡困难；舌淡脉细";
// (e) normal-range vitals in labeled/serialized/combined forms are padding, not diagnostic support
for (const padding of ["生命体征：120/80", "生命体征：BP 120/80mmHg，T 36.6℃，P 76次/分，R 16次/分，SpO2 98%", "血压120/80", "血压 118/76mmHg", "体温36.6℃", "T 36.6℃", "心率76次/分", "呼吸16次/分", "SpO2 98%", "血氧 99%"]) {
  assert.equal(m03SemanticIssue(westernSupportOf([padding]), stableSupportContext), "western_support_normal_vital_padding", `${padding} is normal-range vital padding, not diagnostic support`);
}
assert.equal(m03SemanticIssue(westernSupportOf(["舌淡红，苔薄白"]), stableSupportContext), "western_support_tcm_pollution", "tongue-only descriptions stay TCM pollution");
assert.equal(m03SemanticIssue(westernSupportOf(["脉沉细"]), stableSupportContext), "western_support_tcm_pollution", "pulse-only descriptions stay TCM pollution");
for (const demographic of ["男性，45岁，职员", "45岁男性", "职业：教师", "女性", "退休职工"]) {
  assert.equal(m03SemanticIssue(westernSupportOf([demographic]), stableSupportContext), "western_support_demographic_padding", `${demographic} is demographic padding, not diagnostic support`);
}
for (const history of ["2型糖尿病10年", "高血压5年余", "高血压病史"]) {
  assert.equal(m03SemanticIssue(westernSupportOf([history]), stableSupportContext), "western_support_historical_only", `${history} is background history without a current episode`);
}
// abnormal vitals and current positive findings remain valid support
for (const finding of ["BP 200/120mmHg", "血压 200/120mmHg", "SpO2 90%", "体温39.1℃", "心率130次/分", "呼吸26次/分"]) {
  assert.equal(m03SemanticIssue(westernSupportOf([finding]), stableSupportContext), undefined, `${finding} is abnormal and remains valid diagnostic support`);
}
assert.equal(m03SemanticIssue(westernSupportOf(["高血压病史", "入睡困难"]), stableSupportContext), undefined, "a current positive finding beside background history remains valid support");
// (f) excluded items cannot bypass the historical_only gate
assert.equal(m03SemanticIssue(westernSupportOf(["生命体征：120/80", "高血压病史"]), stableSupportContext), "western_support_normal_vital_padding", "normal vitals cannot masquerade as current evidence beside historical facts");
assert.equal(m03SemanticIssue(westernSupportOf(["2型糖尿病10年", "男性，45岁"]), stableSupportContext), "western_support_demographic_padding", "demographics cannot masquerade as current evidence beside historical facts");
assert.equal(m03SemanticIssue(westernSupportOf(["舌淡红", "高血压病史"]), stableSupportContext), "western_support_tcm_pollution", "tongue findings cannot masquerade as current evidence beside historical facts");
assert.equal(m03SemanticIssue(westernSupportOf(["2型糖尿病10年", "高血压病史"]), stableSupportContext), "western_support_historical_only", "a multi-year background entry cannot bypass the historical_only gate");

const m04 = {
  stage: "prescribe",
  overview: { primarySyndrome: stable.overview.primarySyndrome, overallPathogenesis: stable.overview.overallPathogenesis },
  therapy: { overallPrinciple: stable.therapy.overallPrinciple },
  formula: {
    candidates: [{
      name: "酸枣仁汤加减",
      formulaNames: ["酸枣仁汤"],
      therapyMatch: "养血安神，兼以疏肝解郁",
      herbs: [
        { name: "酸枣仁", dose: "15g", role: "君", prescriptionRole: "养心安神", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "心血不足", function: "养心安神", decoctionRequirement: "捣碎后同煎" },
        { name: "川芎", dose: "6g", role: "臣", prescriptionRole: "调畅血脉", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "心血不足", function: "活血行气" },
      ],
      decoction: { doseCount: "5剂", method: "每日1剂，冷水浸泡30分钟，煎煮2次，合并药液约400mL，早晚分服", course: "5日", followUpNode: "5日复诊" },
    }],
    modifications: [],
  },
  nonPharma: {
    diet: "晚餐清淡，避免睡前浓茶咖啡",
    lifestyle: "固定作息并减少睡前屏幕刺激",
    emotion: "记录情绪波动并配合放松训练",
    acupointCare: "可按揉神门、内关",
    monitoring: [{ metric: "入睡时间与夜醒次数", timing: "每日记录", trigger: "连续加重或出现明显日间功能受损时复诊" }],
  },
};
const genericTonicAsEmperor = structuredClone(m04);
genericTonicAsEmperor.formula.candidates[0].constructionType = "self_devised";
genericTonicAsEmperor.formula.candidates[0].formulaNames = [];
genericTonicAsEmperor.formula.candidates[0].herbs[0] = {
  ...genericTonicAsEmperor.formula.candidates[0].herbs[0],
  name: "山药",
  function: "补脾养胃，生津益肺，补肾涩精",
  prescriptionRole: "补脾益气",
};
assert.match(
  m04SemanticIssue(genericTonicAsEmperor, "", stable) || "",
  /emperor_therapy_mismatch/,
  "a generic tonic cannot become emperor when its governed actions do not directly cover the P1 therapy",
);
const secondaryNodeEmperor = structuredClone(m04);
secondaryNodeEmperor.formula.candidates[0].herbs[0].targetRef = "P2";
secondaryNodeEmperor.formula.candidates[0].herbs[0].targetPathogenesis = "肝郁气滞";
const stableWithSecondaryNode = {
  ...stable,
  pathogenesis: {
    chain: [
      ...stable.pathogenesis.chain,
      { nodeId: "P2", patientFact: "情志波动后加重", syndromeEvidence: "情志相关", pathogenesis: "肝郁气滞", therapyDirection: "疏肝解郁", pathogenesisType: "次因", biaoBen: "标实" },
    ],
  },
};
assert.match(
  m04SemanticIssue(secondaryNodeEmperor, "", stableWithSecondaryNode) || "",
  /emperor_not_primary/,
  "every emperor herb must directly target the P1 core pathogenesis node",
);
const missingEmperor = structuredClone(m04);
missingEmperor.formula.candidates[0].herbs[0].role = "臣";
assert.match(m04SemanticIssue(missingEmperor, "", stable) || "", /emperor_missing/);
const highImpactModification = {
  ...m04,
  formula: {
    ...m04.formula,
    modifications: [{
      trigger: "复诊时仍畏寒",
      targetPathogenesis: "心血不足",
      action: "加附子",
      reason: "温阳散寒",
      riskNote: "采用前需重新审方",
    }],
  },
};
assert.match(
  m04SemanticIssue(highImpactModification, "", stable) || "",
  /modification_0_herb_0_unsupported_high_impact_yang_warm/,
  "conditional modifications must pass the same high-impact direction governance as current herb rows",
);
const defaultMethod = m04.formula.candidates[0].decoction.method;
const visiblePrescription = (acidDose = "15g", chuanxiongDose = "6g", method = defaultMethod) => [
  `**煎服法**：${method}`,
  "| 序号 | 药名 | 炮制/规格 | 剂量 | 君臣佐使 |",
  "|---|---|---|---|---|",
  `| 1 | 酸枣仁 | 捣碎后同煎 | ${acidDose} | 君 |`,
  `| 2 | 川芎 | 饮片 | ${chuanxiongDose} | 臣 |`,
].join("\n");
assert.equal(isCompleteM04Reasoning(m04, visiblePrescription()), true);
const windLungPrior = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "风邪恋肺证" },
  pathogenesis: { chain: [{ ...stable.pathogenesis.chain[0], therapyDirection: "疏散风邪，宣通肺气" }] },
  therapy: { overallPrinciple: "疏风宣肺" },
};
for (const therapyMatch of ["疏散风邪，宣通肺气", "祛风解表，宣畅肺气"]) {
  const synonymousWindLungM04 = {
    ...m04,
    overview: { ...m04.overview, primarySyndrome: windLungPrior.overview.primarySyndrome },
    therapy: { ...windLungPrior.therapy },
    formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], therapyMatch }] },
  };
  assert.equal(
    m04SemanticIssue(synonymousWindLungM04, visiblePrescription(), windLungPrior),
    undefined,
    `wind-lung synonymous therapy must align with the locked M03 direction: ${therapyMatch}`,
  );
}
const unrelatedWindLungM04 = {
  ...m04,
  overview: { ...m04.overview, primarySyndrome: windLungPrior.overview.primarySyndrome },
  therapy: { ...windLungPrior.therapy },
  formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], therapyMatch: "健脾益气" }] },
};
assert.equal(
  m04SemanticIssue(unrelatedWindLungM04, visiblePrescription(), windLungPrior),
  "candidate_0_therapy_unaligned",
  "an unrelated therapy must not align merely because both values are valid TCM treatment text",
);
const coldLungPrior = {
  ...windLungPrior,
  pathogenesis: { chain: [{ ...windLungPrior.pathogenesis.chain[0], therapyDirection: "温肺散寒，宣肺止咳" }] },
  therapy: { overallPrinciple: "温肺散寒，宣肺止咳" },
};
const oppositeColdLungM04 = {
  ...unrelatedWindLungM04,
  therapy: { ...coldLungPrior.therapy },
  formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], therapyMatch: "清热宣肺，止咳平喘" }] },
};
assert.equal(
  m04SemanticIssue(oppositeColdLungM04, visiblePrescription(), coldLungPrior),
  "candidate_0_therapy_unaligned",
  "shared lung symptom therapy must not hide a heat-versus-warming polarity conflict",
);
const warmExteriorPrior = {
  ...coldLungPrior,
  pathogenesis: { chain: [{ ...coldLungPrior.pathogenesis.chain[0], therapyDirection: "辛温解表，宣肺止咳" }] },
  therapy: { overallPrinciple: "辛温解表，宣肺止咳" },
};
const oppositeExteriorM04 = {
  ...oppositeColdLungM04,
  therapy: { ...warmExteriorPrior.therapy },
  formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], therapyMatch: "辛凉解表，宣肺止咳" }] },
};
assert.equal(
  m04SemanticIssue(oppositeExteriorM04, visiblePrescription(), warmExteriorPrior),
  "candidate_0_therapy_unaligned",
  "辛温与辛凉的寒热相反不能因同为解表宣肺而通过",
);
const unsupportedExtraTherapyM04 = {
  ...m04,
  formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], therapyMatch: "养血安神，止咳平喘" }] },
};
assert.equal(
  m04SemanticIssue(unsupportedExtraTherapyM04, visiblePrescription(), stable),
  "candidate_0_therapy_unaligned",
  "候选治法新增的止咳平喘必须得到M03治法节点支持",
);
for (const unsupportedTherapy of ["养血安神，疏肝解郁，开窍醒神", "养血安神，疏肝解郁，软坚散结"]) {
  const unsupportedSpecializedTherapy = {
    ...m04,
    formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], therapyMatch: unsupportedTherapy }] },
  };
  assert.equal(
    m04SemanticIssue(unsupportedSpecializedTherapy, visiblePrescription(), stable),
    "candidate_0_therapy_unaligned",
    `候选新增专门治法必须由M03显式支持: ${unsupportedTherapy}`,
  );
}
const advisoryRangeM04 = {
  ...m04,
  formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], herbs: [
    { ...m04.formula.candidates[0].herbs[0], dose: "30g" },
    m04.formula.candidates[0].herbs[1],
  ] }] },
};
assert.match(m04SemanticIssue(advisoryRangeM04, visiblePrescription("30g", "6g")) || "", /dose_outside_conservative_range/, "model-generated doses above the local conservative range must be repaired before display");
assert.equal(m04SemanticIssue(advisoryRangeM04, visiblePrescription("30g", "6g"), stable, isKnownTcmHerbName, false, false, true), undefined, "a doctor workbench edit above the historical range remains advisory and reaches the real audit");
const yinDeficiencyPrior = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "胃阴不足证", overallPathogenesis: "胃阴亏虚，虚热内生" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "口干", syndromeEvidence: "口干", pathogenesis: "胃阴亏虚，虚热内生", therapyDirection: "滋阴清热，益胃生津" }] },
  therapy: { overallPrinciple: "滋阴清热，益胃生津" },
};
const alternateGovernedDoseM04 = {
  ...m04,
  overview: { ...m04.overview, primarySyndrome: "胃阴不足证", overallPathogenesis: "胃阴亏虚，虚热内生" },
  pathogenesis: yinDeficiencyPrior.pathogenesis,
  therapy: yinDeficiencyPrior.therapy,
  formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], therapyMatch: "滋阴清热，益胃生津", herbs: [
    { ...m04.formula.candidates[0].herbs[0], name: "石斛", dose: "15g", targetPathogenesis: "胃阴亏虚，虚热内生", function: getTcmHerbFunctionText("石斛"), prescriptionRole: "滋阴益胃" },
  ] }] },
};
assert.equal(m04SemanticIssue(alternateGovernedDoseM04, "", yinDeficiencyPrior), undefined, "a dose inside a governed alternative source range must not be rejected by the primary historical range alone");
const belowRangeM04 = {
  ...m04,
  formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], herbs: [
    { ...m04.formula.candidates[0].herbs[0], dose: "1g" },
    m04.formula.candidates[0].herbs[1],
  ] }] },
};
assert.match(m04SemanticIssue(belowRangeM04, visiblePrescription("1g", "6g"), stable) || "", /dose_outside_conservative_range/, "model-generated doses below the governed decoction range must be repaired before display");
const grossDoseM04 = {
  ...m04,
  formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], herbs: [
    { ...m04.formula.candidates[0].herbs[0], dose: "100g" },
    m04.formula.candidates[0].herbs[1],
  ] }] },
};
assert.match(m04SemanticIssue(grossDoseM04, visiblePrescription("100g", "6g")) || "", /dose_sanity_ceiling/, "a grossly abnormal dose still fails the structural safety ceiling");
const incompatiblePairM04 = {
  ...m04,
  formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], herbs: [
    { ...m04.formula.candidates[0].herbs[0], name: "乌头", dose: "3g", function: getTcmHerbFunctionText("乌头") },
    { ...m04.formula.candidates[0].herbs[1], name: "半夏", dose: "6g", function: getTcmHerbFunctionText("半夏") },
  ] }] },
};
assert.match(m04SemanticIssue(incompatiblePairM04, "", stable) || "", /high_risk_pair_incompatibility/, "model-generated high-risk herb pairs are repaired before customer display");
const canonicalFunctionM04 = {
  ...m04,
  formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], herbs: [
    m04.formula.candidates[0].herbs[0],
    { ...m04.formula.candidates[0].herbs[1], name: "麦冬", dose: "10g", function: getTcmHerbFunctionText("麦冬") },
  ] }] },
};
assert.equal(isCompleteM04Reasoning(canonicalFunctionM04, "", stable), true, m04SemanticIssue(canonicalFunctionM04, "", stable));
assert.equal(isCompleteM04Reasoning({
  ...m04,
  formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], herbs: [
    { ...m04.formula.candidates[0].herbs[0], name: "附子", dose: "500g", function: "温阳散寒", decoctionRequirement: "先煎、久煎" },
    m04.formula.candidates[0].herbs[1],
  ] }] },
}), false);
assert.equal(isCompleteM04Reasoning({
  ...m04,
  formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], herbs: [
    { ...m04.formula.candidates[0].herbs[0], name: "大黄", dose: "6g", function: "养血安神", decoctionRequirement: "不宜久煎" },
    m04.formula.candidates[0].herbs[1],
  ] }] },
}), false);
assert.equal(isCompleteM04Reasoning({
  ...m04,
  formula: { ...m04.formula, modifications: [{ action: "口苦时加黄芩", doseOrHandling: null, reason: "可用9g" }] },
}), false);
assert.equal(isCompleteM04Reasoning(m04, `**不适用条件**：不宜用于痰热实证，禁止自行加量\n${visiblePrescription()}`), true);
assert.equal(isCompleteM04Reasoning(m04, visiblePrescription("15克", "6克")), true);
assert.equal(isCompleteM04Reasoning(m04, visiblePrescription("15.0克", "6.0克")), true);
for (const method of [
  "1剂/日，清水浸泡约30分钟，煎取2次，合并药液400毫升，分2次温服",
  "日1剂，浸泡30min，二煎，取药液约400mL，每日2次温服",
  "每天1剂，冷水浸泡30分钟，煎煮2次，合并药液约400ml，早晚服",
  "每日一剂，浸泡半小时，煎煮两次，合并药液约四百毫升，早晚各温服一次",
]) {
  assert.equal(isCompleteM04Reasoning({ ...m04, formula: { candidates: [{ ...m04.formula.candidates[0], decoction: { ...m04.formula.candidates[0].decoction, method } }] } }, visiblePrescription("15g", "6g", method)), true, method);
}
assert.equal(isCompleteM04Reasoning(m04, visiblePrescription("5g", "6g")), false);
assert.equal(isCompleteM04Reasoning(m04, visiblePrescription("6g", "15g")), false);
assert.equal(isCompleteM04Reasoning(m04, `**煎服法**：${defaultMethod}\n| 序号 | 药名 | 剂量 |\n|---|---|---|\n| 1 | 酸枣仁 | 15g |\n| 2 | 川芎 |  |`), false);
assert.equal(isCompleteM04Reasoning({ ...m04, formula: { candidates: [{ ...m04.formula.candidates[0], herbs: [{ ...m04.formula.candidates[0].herbs[0], dose: "0g" }, m04.formula.candidates[0].herbs[1]] }] } }), false);
assert.equal(isCompleteM04Reasoning({ ...m04, formula: { candidates: [{ ...m04.formula.candidates[0], herbs: [{ ...m04.formula.candidates[0].herbs[0], dose: "999999g" }, m04.formula.candidates[0].herbs[1]] }] } }), false);
assert.equal(isCompleteM04Reasoning({ stage: "prescribe", formula: null }), false);
assert.equal(isCompleteM04Reasoning({ ...m04, formula: { candidates: [{ ...m04.formula.candidates[0], herbs: [{ name: "酸枣仁", dose: null }] }] } }), false);
assert.equal(isCompleteM04Reasoning(m04, `**煎服法**：${defaultMethod}\n| 序号 | 药名 | 剂量 |\n|---|---|---|\n| 1 | 酸枣仁 | 15g |`), false);
assert.equal(isCompleteM04Reasoning({ ...m04, formula: { candidates: [{ ...m04.formula.candidates[0], decoction: { ...m04.formula.candidates[0].decoction, doseCount: null } }] } }), false);
assert.equal(isCompleteM04Reasoning({ ...m04, formula: { candidates: [{ ...m04.formula.candidates[0], decoction: { ...m04.formula.candidates[0].decoction, method: "每日1剂，冷水浸泡，煎煮2次，合并药液400mL，早晚分服" } }] } }), false);
assert.equal(isCompleteM04Reasoning({ ...m04, formula: { candidates: [{ ...m04.formula.candidates[0], decoction: { ...m04.formula.candidates[0].decoction, method: "每日1剂，冷水浸泡30分钟，水煎服，早晚分服" } }] } }), false);
for (const method of [
  "不应每日1剂、无需浸泡30分钟、禁止煎2次、不得合并药液400mL、不可早晚分服",
  "每日1剂，浸泡0分钟，煎煮0次，合并药液0mL，分0次温服",
  "每日1剂，冷水浸泡30分钟，煎煮2次，每次加水400mL，早晚分服",
]) {
  assert.equal(isCompleteM04Reasoning({ ...m04, formula: { candidates: [{ ...m04.formula.candidates[0], decoction: { ...m04.formula.candidates[0].decoction, method } }] } }, visiblePrescription("15g", "6g", method)), false, method);
}
assert.equal(isCompleteM04Reasoning({ ...m04, formula: { candidates: [{ ...m04.formula.candidates[0], decoction: { ...m04.formula.candidates[0].decoction, course: "待确认", followUpNode: "待核实" } }] } }, visiblePrescription()), false);
assert.equal(isCompleteM04Reasoning({ ...m04, formula: { candidates: [{ ...m04.formula.candidates[0], herbs: [{ ...m04.formula.candidates[0].herbs[0], decoctionRequirement: null }, m04.formula.candidates[0].herbs[1]] }] } }), false);
assert.equal(isCompleteM04Reasoning(m04, visiblePrescription(), stable), true);
const namedDirectionPrior = {
  ...stable,
  overview: { ...stable.overview, recommendedFormulaDirection: "归脾汤加减方向", recommendedFormulaNames: ["归脾汤"], formulaSelectionMode: "single" },
};
const namedDirectionM04 = {
  ...m04,
  overview: { ...m04.overview, recommendedFormulaDirection: "归脾汤加减方向" },
  formula: { ...m04.formula, candidates: [{
    ...m04.formula.candidates[0],
    name: "归脾汤加减",
    formulaNames: ["归脾汤"],
    herbs: [
      m04.formula.candidates[0].herbs[0],
      { ...m04.formula.candidates[0].herbs[1], name: "当归", dose: "10g", prescriptionRole: "养血和营", function: getTcmHerbFunctionText("当归"), decoctionRequirement: undefined },
    ],
  }] },
};
assert.equal(isCompleteM04Reasoning(namedDirectionM04, "", namedDirectionPrior), true, m04SemanticIssue(namedDirectionM04, "", namedDirectionPrior));
assert.equal(isCompleteM04Reasoning({ ...namedDirectionM04, formula: { ...namedDirectionM04.formula, candidates: [{ ...namedDirectionM04.formula.candidates[0], name: "酸枣仁汤加减" }] } }, "", namedDirectionPrior), false);
assert.equal(isCompleteM04Reasoning({ ...namedDirectionM04, formula: { ...namedDirectionM04.formula, candidates: [{ ...namedDirectionM04.formula.candidates[0], name: "归脾汤合酸枣仁汤加减", formulaNames: ["归脾汤", "酸枣仁汤"] }] } }, "", namedDirectionPrior), false);
const naturalDirectionPrior = { ...namedDirectionPrior, overview: { ...namedDirectionPrior.overview, recommendedFormulaDirection: "推荐以归脾汤加减为主" } };
assert.equal(isCompleteM04Reasoning(namedDirectionM04, "", naturalDirectionPrior), true, m04SemanticIssue(namedDirectionM04, "", naturalDirectionPrior));
const governedDirectionPrior = {
  ...naturalDirectionPrior,
  overview: {
    ...naturalDirectionPrior.overview,
    recommendedFormulaNames: ["归脾汤"],
    formulaSelectionMode: "single",
  },
};
const governedDirectionM04 = {
  ...namedDirectionM04,
  formula: {
    ...namedDirectionM04.formula,
    candidates: [{ ...namedDirectionM04.formula.candidates[0], formulaNames: ["归脾汤"] }],
  },
};
assert.equal(isCompleteM04Reasoning(governedDirectionM04, "", governedDirectionPrior), true, m04SemanticIssue(governedDirectionM04, "", governedDirectionPrior));
const noFormulaLockedPrior = { ...stable, overview: { ...stable.overview, recommendedFormulaDirection: "按病机组方", recommendedFormulaNames: [], formulaSelectionMode: "none" } };
assert.equal(isCompleteM04Reasoning(namedDirectionM04, "", noFormulaLockedPrior), false, "formulaSelectionMode=none must not silently authorize a named classic formula");
const selfDevisedM04 = { ...namedDirectionM04, formula: { ...namedDirectionM04.formula, candidates: [{ ...namedDirectionM04.formula.candidates[0], name: "本例辨证组方", formulaNames: [] }] } };
assert.equal(isCompleteM04Reasoning(selfDevisedM04, "", noFormulaLockedPrior), true, m04SemanticIssue(selfDevisedM04, "", noFormulaLockedPrior));
assert.equal(isCompleteM04Reasoning({
  ...governedDirectionM04,
  formula: { ...governedDirectionM04.formula, candidates: [{ ...governedDirectionM04.formula.candidates[0], name: "酸枣仁汤加减" }] },
}, "", governedDirectionPrior), false, "display text cannot contradict its governed formula reference");
assert.equal(isCompleteM04Reasoning({
  ...governedDirectionM04,
  formula: { ...governedDirectionM04.formula, candidates: [{ ...governedDirectionM04.formula.candidates[0], formulaNames: ["归脾汤", "酸枣仁汤"], name: "归脾汤合酸枣仁汤加减" }] },
}, "", governedDirectionPrior), false, "a single governed formula cannot expand into a combined formula");
const alternativeDirectionPrior = { ...namedDirectionPrior, overview: { ...namedDirectionPrior.overview, recommendedFormulaDirection: "归脾汤或酸枣仁汤酌选", recommendedFormulaNames: ["归脾汤", "酸枣仁汤"], formulaSelectionMode: "alternatives" } };
assert.equal(isCompleteM04Reasoning(namedDirectionM04, "", alternativeDirectionPrior), true, m04SemanticIssue(namedDirectionM04, "", alternativeDirectionPrior));
assert.equal(isCompleteM04Reasoning({ ...namedDirectionM04, formula: { ...namedDirectionM04.formula, candidates: [{ ...namedDirectionM04.formula.candidates[0], name: "归脾汤合酸枣仁汤加减", formulaNames: ["归脾汤", "酸枣仁汤"] }] } }, "", alternativeDirectionPrior), false);
const unselectedAlternativeHerbM04 = {
  ...namedDirectionM04,
  formula: { ...namedDirectionM04.formula, candidates: [{
    ...namedDirectionM04.formula.candidates[0],
    formulaNames: ["归脾汤"],
    herbs: [
      ...namedDirectionM04.formula.candidates[0].herbs,
      { ...m04.formula.candidates[0].herbs[1], targetPathogenesis: stable.pathogenesis.chain[0].pathogenesis },
    ],
  }] },
};
assert.match(
  m04SemanticIssue(unselectedAlternativeHerbM04, "", alternativeDirectionPrior) || "",
  /unsupported_high_impact_blood_move/,
  "a herb from an unselected alternative formula cannot borrow that formula's baseline exception",
);
const governedAlternativePrior = {
  ...alternativeDirectionPrior,
  overview: { ...alternativeDirectionPrior.overview, recommendedFormulaNames: ["归脾汤", "酸枣仁汤"], formulaSelectionMode: "alternatives" },
};
assert.equal(isCompleteM04Reasoning(governedDirectionM04, "", governedAlternativePrior), true);
assert.equal(isCompleteM04Reasoning({
  ...governedDirectionM04,
  formula: { ...governedDirectionM04.formula, candidates: [{ ...governedDirectionM04.formula.candidates[0], formulaNames: ["归脾汤", "酸枣仁汤"], name: "归脾汤合酸枣仁汤加减" }] },
}, "", governedAlternativePrior), false, "alternative directions allow exactly one governed formula");
const doctorEditedNamedDirection = {
  ...namedDirectionM04,
  formula: { ...namedDirectionM04.formula, candidates: [{ ...namedDirectionM04.formula.candidates[0], name: "本例辨证组方（医生编辑版）", constructionType: "self_devised", modificationStatus: "modified" }] },
};
assert.equal(isCompleteM04Reasoning(doctorEditedNamedDirection, "", namedDirectionPrior), false);
assert.equal(m04SemanticIssue(doctorEditedNamedDirection, "", namedDirectionPrior, undefined, false, false, true), undefined);
const doctorEditedToxicDose = {
  ...doctorEditedNamedDirection,
  formula: { ...doctorEditedNamedDirection.formula, candidates: [{
    ...doctorEditedNamedDirection.formula.candidates[0],
    herbs: doctorEditedNamedDirection.formula.candidates[0].herbs.map((herb, index) => index === 0
      ? { ...herb, name: "半夏", dose: "10g", function: getTcmHerbFunctionText("半夏"), decoctionRequirement: undefined }
      : herb),
  }] },
};
assert.equal(
  m04SemanticIssue(doctorEditedToxicDose, "", namedDirectionPrior, undefined, false, false, true),
  undefined,
  "a plausible doctor-edited toxic-herb dose reaches the real advisory audit instead of being blocked by the historical model range",
);
const spleenDeficiencyPrior = {
  ...stable,
  overview: { primarySyndrome: "心脾两虚证", overallPathogenesis: "脾气虚弱，心血不足，心神失养", recommendedFormulaDirection: "酸枣仁汤加减", recommendedFormulaNames: ["酸枣仁汤"], formulaSelectionMode: "single" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "心悸健忘、纳差便溏", syndromeEvidence: "心悸健忘、纳差便溏支持心脾两虚", pathogenesis: "脾气虚弱，心血不足", therapyDirection: "健脾益气，养血安神" }] },
  therapy: { overallPrinciple: "健脾益气，养血安神" },
};
const spleenDeficiencyM04 = {
  ...m04,
  overview: { ...spleenDeficiencyPrior.overview },
  therapy: { ...spleenDeficiencyPrior.therapy },
  formula: { candidates: [{ ...m04.formula.candidates[0], therapyMatch: "健脾益气，养血安神", herbs: [
    { ...m04.formula.candidates[0].herbs[0], targetPathogenesis: "脾气虚弱，心血不足" },
    { ...m04.formula.candidates[0].herbs[1], targetPathogenesis: "脾气虚弱，心血不足" },
  ] }], modifications: [] },
};
assert.equal(isCompleteM04Reasoning(spleenDeficiencyM04, visiblePrescription(), spleenDeficiencyPrior), true, m04SemanticIssue(spleenDeficiencyM04, visiblePrescription(), spleenDeficiencyPrior));
const tonicStructuralPrior = {
  ...spleenDeficiencyPrior,
  overview: { ...spleenDeficiencyPrior.overview, recommendedFormulaDirection: "归脾汤合参苓白术散加减", recommendedFormulaNames: ["归脾汤", "参苓白术散"], formulaSelectionMode: "combined" },
  pathogenesis: { chain: [{ ...spleenDeficiencyPrior.pathogenesis.chain[0], nodeId: "P1" }] },
};
const tonicStructuralM04 = {
  ...spleenDeficiencyM04,
  formula: { ...spleenDeficiencyM04.formula, candidates: [{
    ...spleenDeficiencyM04.formula.candidates[0],
    name: "归脾汤合参苓白术散加减",
    formulaNames: ["归脾汤", "参苓白术散"],
    herbs: [
      { ...spleenDeficiencyM04.formula.candidates[0].herbs[0], targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: tonicStructuralPrior.pathogenesis.chain[0].pathogenesis },
      { ...spleenDeficiencyM04.formula.candidates[0].herbs[1], name: "木香", role: "佐", dose: "6g", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "middle_jiao_support", targetPathogenesis: "模型自由文本应被覆盖", function: getTcmHerbFunctionText("木香") },
    ],
  }] },
};
const legacyFreeTextTargetM04 = {
  ...spleenDeficiencyM04,
  formula: { ...spleenDeficiencyM04.formula, candidates: [{
    ...spleenDeficiencyM04.formula.candidates[0],
    herbs: spleenDeficiencyM04.formula.candidates[0].herbs.map((herb, index) => index === 0
      ? { ...herb, targetKind: undefined, targetRef: undefined, structureRole: undefined, targetPathogenesis: "脾气虚弱兼胆火上扰" }
      : herb),
  }] },
};
assert.match(m04SemanticIssue(legacyFreeTextTargetM04, "", spleenDeficiencyPrior) || "", /target_ref_missing/);
assert.match(m04SemanticIssue(tonicStructuralM04, "", tonicStructuralPrior) || "", /structure_target_mismatch/);
const tonicStructuralContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(tonicStructuralM04)}\n<!-- DIAGNOSIS_JSON_END -->`;
const groundedTonicStructuralContent = applyDeterministicHerbDecoctionRequirements(applyDeterministicHerbTargets(tonicStructuralContent, tonicStructuralPrior));
const groundedTonicStructuralM04 = JSON.parse(groundedTonicStructuralContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0].trim());
assert.equal(groundedTonicStructuralM04.formula.candidates[0].herbs[1].targetPathogenesis, "顾护中焦，防补药滋腻");
assert.equal(isCompleteM04Reasoning(groundedTonicStructuralM04, "", tonicStructuralPrior), true, m04SemanticIssue(groundedTonicStructuralM04, "", tonicStructuralPrior));
const tonicMessengerM04 = {
  ...tonicStructuralM04,
  formula: { ...tonicStructuralM04.formula, candidates: [{ ...tonicStructuralM04.formula.candidates[0], herbs: [
    tonicStructuralM04.formula.candidates[0].herbs[0],
    { ...tonicStructuralM04.formula.candidates[0].herbs[1], name: "桔梗", role: "使", dose: "6g", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "guide", targetPathogenesis: "宣肺利气", function: getTcmHerbFunctionText("桔梗") },
  ] }] },
};
const tonicMessengerContent = applyDeterministicHerbTargets(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(tonicMessengerM04)}\n<!-- DIAGNOSIS_JSON_END -->`, tonicStructuralPrior);
const groundedTonicMessengerM04 = JSON.parse(tonicMessengerContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0].trim());
assert.equal(groundedTonicMessengerM04.formula.candidates[0].herbs[1].targetPathogenesis, "引经载药，调和诸药");
assert.equal(isCompleteM04Reasoning(groundedTonicMessengerM04, "", tonicStructuralPrior), true, m04SemanticIssue(groundedTonicMessengerM04, "", tonicStructuralPrior));
const nodeReferencedM04 = {
  ...tonicStructuralM04,
  formula: { ...tonicStructuralM04.formula, candidates: [{ ...tonicStructuralM04.formula.candidates[0], herbs: [
    { ...tonicStructuralM04.formula.candidates[0].herbs[0], targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "模型不得决定此文本" },
    tonicStructuralM04.formula.candidates[0].herbs[1],
  ] }] },
};
const groundedNodeContent = applyDeterministicHerbDecoctionRequirements(applyDeterministicHerbTargets(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(nodeReferencedM04)}\n<!-- DIAGNOSIS_JSON_END -->`, tonicStructuralPrior));
const groundedNodeM04 = JSON.parse(groundedNodeContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0].trim());
assert.equal(groundedNodeM04.formula.candidates[0].herbs[0].targetPathogenesis, tonicStructuralPrior.pathogenesis.chain[0].pathogenesis);
assert.equal(isCompleteM04Reasoning(groundedNodeM04, "", tonicStructuralPrior), true, m04SemanticIssue(groundedNodeM04, "", tonicStructuralPrior));
assert.match(m04SemanticIssue({ ...groundedNodeM04, formula: { ...groundedNodeM04.formula, candidates: [{ ...groundedNodeM04.formula.candidates[0], herbs: [{ ...groundedNodeM04.formula.candidates[0].herbs[0], targetRef: "P9" }, groundedNodeM04.formula.candidates[0].herbs[1]] }] } }, "", tonicStructuralPrior) || "", /target_ref_invalid/);
const groundedM03IdContent = groundStructuredPatientFacts(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(stable)}\n<!-- DIAGNOSIS_JSON_END -->`, "患者入睡困难");
assert.match(groundedM03IdContent, /"nodeId":\s*"P1"/);
const tonicStructuralMonarch = {
  ...tonicStructuralM04,
  formula: { ...tonicStructuralM04.formula, candidates: [{ ...tonicStructuralM04.formula.candidates[0], herbs: [
    tonicStructuralM04.formula.candidates[0].herbs[0],
    { ...tonicStructuralM04.formula.candidates[0].herbs[1], role: "君" },
  ] }] },
};
assert.equal(applyDeterministicHerbTargets(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(tonicStructuralMonarch)}\n<!-- DIAGNOSIS_JSON_END -->`, tonicStructuralPrior).includes("模型自由文本应被覆盖"), true);
const syndromeTherapySupportedPrior = {
  ...spleenDeficiencyPrior,
  overview: { ...spleenDeficiencyPrior.overview, primarySyndrome: "心脾两虚证", overallPathogenesis: "心血不足，心神失养" },
  pathogenesis: { chain: [{ ...spleenDeficiencyPrior.pathogenesis.chain[0], pathogenesis: "心血不足，心神失养" }] },
  therapy: { overallPrinciple: "健脾益气，养血安神" },
};
const syndromeTherapySupportedM04 = {
  ...spleenDeficiencyM04,
  overview: { ...syndromeTherapySupportedPrior.overview },
  therapy: { ...syndromeTherapySupportedPrior.therapy },
  formula: { ...spleenDeficiencyM04.formula, candidates: [{
    ...spleenDeficiencyM04.formula.candidates[0],
    herbs: spleenDeficiencyM04.formula.candidates[0].herbs.map((herb) => ({ ...herb, targetPathogenesis: "心血不足，心神失养" })),
  }] },
};
assert.equal(isCompleteM04Reasoning(syndromeTherapySupportedM04, "", syndromeTherapySupportedPrior), true, m04SemanticIssue(syndromeTherapySupportedM04, "", syndromeTherapySupportedPrior));
assert.equal(editedPrescriptionSemanticIssue(spleenDeficiencyM04, 0, spleenDeficiencyPrior), undefined);
const invalidWorkbenchM04 = {
  ...spleenDeficiencyM04,
  formula: { ...spleenDeficiencyM04.formula, candidates: [{ ...spleenDeficiencyM04.formula.candidates[0], herbs: [{
    ...spleenDeficiencyM04.formula.candidates[0].herbs[0],
    name: "不存在药",
    dose: "499g",
    targetPathogenesis: "痰热内扰",
    function: "美容养颜",
  }] }] },
};
assert.match(editedPrescriptionSemanticIssue(invalidWorkbenchM04, 0, spleenDeficiencyPrior) || "", /unknown|dose|pathogenesis|function|target_ref/);
const duplicateWorkbenchM04 = {
  ...spleenDeficiencyM04,
  formula: { ...spleenDeficiencyM04.formula, candidates: [{ ...spleenDeficiencyM04.formula.candidates[0], herbs: [
    spleenDeficiencyM04.formula.candidates[0].herbs[0],
    { ...spleenDeficiencyM04.formula.candidates[0].herbs[0] },
  ] }] },
};
assert.equal(editedPrescriptionSemanticIssue(duplicateWorkbenchM04, 0, spleenDeficiencyPrior), "duplicate_herb");
for (const [leftName, rightName] of [["黄芪", "黄耆"], ["甘草", "炙甘草"], ["延胡索", "元胡"]]) {
  const identityDuplicateWorkbench = {
    ...spleenDeficiencyM04,
    formula: { ...spleenDeficiencyM04.formula, candidates: [{ ...spleenDeficiencyM04.formula.candidates[0], herbs: [
      { ...spleenDeficiencyM04.formula.candidates[0].herbs[0], name: leftName },
      { ...spleenDeficiencyM04.formula.candidates[0].herbs[0], name: rightName },
    ] }] },
  };
  assert.equal(editedPrescriptionSemanticIssue(identityDuplicateWorkbench, 0, spleenDeficiencyPrior), "duplicate_herb", `${leftName}/${rightName} cannot bypass workbench duplicate validation`);
  assert.equal(m04SemanticIssue(identityDuplicateWorkbench, "", spleenDeficiencyPrior), "candidate_0_duplicate_herb", `${leftName}/${rightName} cannot bypass the signed M04 contract`);
}
const spleenTransportPrior = {
  ...spleenDeficiencyPrior,
  overview: { ...spleenDeficiencyPrior.overview, overallPathogenesis: "脾运不健，心血不足，心神失养" },
  pathogenesis: { chain: [{ ...spleenDeficiencyPrior.pathogenesis.chain[0], pathogenesis: "脾运不健，心血不足" }] },
};
const spleenTransportM04 = {
  ...spleenDeficiencyM04,
  overview: { ...spleenTransportPrior.overview },
  formula: { ...spleenDeficiencyM04.formula, candidates: [{
    ...spleenDeficiencyM04.formula.candidates[0],
    herbs: spleenDeficiencyM04.formula.candidates[0].herbs.map((herb) => ({ ...herb, targetPathogenesis: "脾运不健，心血不足" })),
  }] },
};
assert.equal(isCompleteM04Reasoning(spleenTransportM04, visiblePrescription(), spleenTransportPrior), true, m04SemanticIssue(spleenTransportM04, visiblePrescription(), spleenTransportPrior));
assert.equal(isCompleteM04Reasoning({
  ...spleenDeficiencyM04,
  formula: { ...spleenDeficiencyM04.formula, candidates: [{ ...spleenDeficiencyM04.formula.candidates[0], herbs: [
    { ...spleenDeficiencyM04.formula.candidates[0].herbs[0], role: "君", targetPathogenesis: "健脾益气，养心安神" },
    { ...spleenDeficiencyM04.formula.candidates[0].herbs[1], targetPathogenesis: "气血生化乏源" },
  ] }] },
}, visiblePrescription(), spleenDeficiencyPrior), false);
assert.equal(isCompleteM04Reasoning({
  ...spleenDeficiencyM04,
  formula: { ...spleenDeficiencyM04.formula, candidates: [{ ...spleenDeficiencyM04.formula.candidates[0], herbs: [
    spleenDeficiencyM04.formula.candidates[0].herbs[0],
    { ...spleenDeficiencyM04.formula.candidates[0].herbs[1], role: "使", targetPathogenesis: "调和诸药，顾护中焦" },
  ] }] },
}, visiblePrescription(), spleenDeficiencyPrior), false);
assert.equal(isCompleteM04Reasoning({
  ...spleenDeficiencyM04,
  formula: { ...spleenDeficiencyM04.formula, candidates: [{ ...spleenDeficiencyM04.formula.candidates[0], herbs: [
    spleenDeficiencyM04.formula.candidates[0].herbs[0],
    { ...spleenDeficiencyM04.formula.candidates[0].herbs[1], role: "佐", targetPathogenesis: "防补药滋腻" },
  ] }] },
}, visiblePrescription(), spleenDeficiencyPrior), false);
assert.equal(isCompleteM04Reasoning({
  ...spleenDeficiencyM04,
  formula: { ...spleenDeficiencyM04.formula, candidates: [{ ...spleenDeficiencyM04.formula.candidates[0], herbs: [
    { ...spleenDeficiencyM04.formula.candidates[0].herbs[0], role: "君", targetPathogenesis: "防补药滋腻" },
    { ...spleenDeficiencyM04.formula.candidates[0].herbs[1], targetPathogenesis: "气血生化乏源" },
  ] }] },
}, visiblePrescription(), spleenDeficiencyPrior), false);
assert.equal(isCompleteM04Reasoning({
  ...spleenDeficiencyM04,
  formula: { ...spleenDeficiencyM04.formula, candidates: [{ ...spleenDeficiencyM04.formula.candidates[0], herbs: [
    { ...spleenDeficiencyM04.formula.candidates[0].herbs[0], role: "君", targetPathogenesis: "调和诸药" },
    spleenDeficiencyM04.formula.candidates[0].herbs[1],
  ] }] },
}, visiblePrescription(), spleenDeficiencyPrior), false);
assert.equal(isCompleteM04Reasoning({
  ...spleenDeficiencyM04,
  formula: { ...spleenDeficiencyM04.formula, candidates: [{ ...spleenDeficiencyM04.formula.candidates[0], herbs: [
    { ...spleenDeficiencyM04.formula.candidates[0].herbs[0], targetPathogenesis: "痰热内扰" },
    spleenDeficiencyM04.formula.candidates[0].herbs[1],
  ] }] },
}, visiblePrescription(), spleenDeficiencyPrior), false);
assert.equal(isCompleteM04Reasoning({
  ...spleenDeficiencyM04,
  formula: { ...spleenDeficiencyM04.formula, candidates: [{ ...spleenDeficiencyM04.formula.candidates[0], herbs: [
    { ...spleenDeficiencyM04.formula.candidates[0].herbs[0], targetPathogenesis: "脾气亏虚兼痰热内扰" },
    spleenDeficiencyM04.formula.candidates[0].herbs[1],
  ] }] },
}, "", spleenDeficiencyPrior), false);
const lexicalPrior = {
  ...spleenDeficiencyPrior,
  overview: { ...spleenDeficiencyPrior.overview, overallPathogenesis: "脾气虚弱，气血生化乏源，心神失养" },
  pathogenesis: { chain: [{ ...spleenDeficiencyPrior.pathogenesis.chain[0], pathogenesis: "气血生化乏源" }] },
};
const lexicalM04 = {
  ...spleenDeficiencyM04,
  overview: { ...lexicalPrior.overview },
  formula: { ...spleenDeficiencyM04.formula, candidates: [{ ...spleenDeficiencyM04.formula.candidates[0], herbs: [
    { ...spleenDeficiencyM04.formula.candidates[0].herbs[0], targetPathogenesis: "气血生化乏源" },
    { ...spleenDeficiencyM04.formula.candidates[0].herbs[1], targetPathogenesis: "气血生化乏源" },
  ] }] },
};
assert.equal(isCompleteM04Reasoning(lexicalM04, "", lexicalPrior), true, m04SemanticIssue(lexicalM04, "", lexicalPrior));
assert.equal(isCompleteM04Reasoning({ ...lexicalM04, formula: { ...lexicalM04.formula, candidates: [{ ...lexicalM04.formula.candidates[0], herbs: [
  { ...lexicalM04.formula.candidates[0].herbs[0], targetPathogenesis: "气血生化乏源兼痰热内扰" },
  lexicalM04.formula.candidates[0].herbs[1],
] }] } }, "", lexicalPrior), false);
assert.equal(isCompleteM04Reasoning({
  ...spleenDeficiencyM04,
  formula: { ...spleenDeficiencyM04.formula, candidates: [{ ...spleenDeficiencyM04.formula.candidates[0], herbs: [
    { ...spleenDeficiencyM04.formula.candidates[0].herbs[0], name: "黄芪", dose: "15g", function: "改善视力美容养颜" },
    spleenDeficiencyM04.formula.candidates[0].herbs[1],
  ] }] },
}, "", spleenDeficiencyPrior), false);
assert.equal(isCompleteM04Reasoning(m04, `**总体病机**：痰热扰心\n**总治法**：清热化痰\n${visiblePrescription()}`, stable), true);
assert.equal(isCompleteM04Reasoning(m04, `**总体病机**：血不养心，心神失舍\n**总治法**：养血安神，疏肝解郁\n${visiblePrescription()}`, stable), true);
assert.equal(isCompleteM04Reasoning({ ...m04, overview: { ...m04.overview, primarySyndrome: "痰热扰心证" } }, visiblePrescription(), stable), false);
assert.equal(isCompleteM04Reasoning({ ...m04, overview: { ...m04.overview, overallPathogenesis: "痰热内扰，心神不宁" } }, visiblePrescription(), stable), false);
assert.equal(isCompleteM04Reasoning({ ...m04, therapy: { overallPrinciple: "清热化痰，宁心安神" } }, visiblePrescription(), stable), false);
assert.equal(isCompleteM04Reasoning({ ...m04, formula: { ...m04.formula, modifications: [{ action: "减黄芪" }] } }, visiblePrescription()), false);
assert.equal(isCompleteM04Reasoning({ ...m04, formula: { ...m04.formula, modifications: [{ action: "减川芎" }] } }, visiblePrescription()), false);
assert.equal(isCompleteM04Reasoning({ ...m04, formula: { ...m04.formula, modifications: [{ action: "加黄芩", doseOrHandling: "9g" }] } }, visiblePrescription()), false);
assert.equal(isCompleteM04Reasoning({ ...m04, formula: { ...m04.formula, modifications: [{ action: "加黄芩", doseOrHandling: null }] } }, visiblePrescription()), false);
assert.equal(isCompleteM04Reasoning({ ...m04, formula: { ...m04.formula, modifications: [{ action: "考虑阿司匹林肠溶片", doseOrHandling: null }] } }, visiblePrescription()), false);
assert.equal(isCompleteM04Reasoning({ ...m04, formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], decoction: { ...m04.formula.candidates[0].decoction, followUpNode: "14日复诊" } }] } }, visiblePrescription()), false);

const serverOwnedM04 = {
  ...spleenDeficiencyM04,
  schemaVersion: "tcm-cdss-reasoning-v2",
  formula: { candidates: [{
    ...spleenDeficiencyM04.formula.candidates[0],
    herbs: [
      { ...spleenDeficiencyM04.formula.candidates[0].herbs[0], name: "人参", dose: "9g", prescriptionRole: "益气健脾", function: "大补元气，益气健脾", decoctionRequirement: null },
      spleenDeficiencyM04.formula.candidates[0].herbs[1],
    ],
    decoction: { ...spleenDeficiencyM04.formula.candidates[0].decoction, method: "水煎服", followUpNode: "待确认" },
  }], modifications: [] },
};
const serverOwnedVisible = [
  "**煎服法**：水煎服",
  "| 序号 | 药名 | 炮制/规格 | 剂量 | 君臣佐使 |",
  "|---|---|---|---|---|",
  "| 1 | 人参 | 饮片 | 9g | 君 |",
  "| 2 | 川芎 | 饮片 | 6g | 臣 |",
].join("\n");
assert.match(m04SemanticIssue(serverOwnedM04, serverOwnedVisible, spleenDeficiencyPrior, undefined, true, true) || "", /decoction_missing_required/);
assert.match(editedPrescriptionSemanticIssue(serverOwnedM04, 0, spleenDeficiencyPrior) || "", /decoction_missing_required/);
const serverOwnedContent = `${serverOwnedVisible}\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(serverOwnedM04)}\n<!-- DIAGNOSIS_JSON_END -->`;
const finalizedServerOwnedContent = synchronizeVisibleClinicalSummary(
  applyDeterministicFormulaAnalysis(applyDeterministicHerbDecoctionRequirements(applyDeterministicFollowUpNode(applyDeterministicDecoctionMethod(serverOwnedContent, "入睡困难3个月；年龄：46岁")))),
  "prescribe",
);
const finalizedServerOwnedM04 = JSON.parse(finalizedServerOwnedContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0].trim());
const finalizedServerOwnedVisible = finalizedServerOwnedContent.split("<!-- DIAGNOSIS_JSON_START -->")[0];
assert.equal(finalizedServerOwnedM04.formula.candidates[0].herbs[0].decoctionRequirement, "另煎或另炖");
assert.match(finalizedServerOwnedM04.formula.candidates[0].decoction.followUpNode, /完成5剂后复诊/);
assert.match(finalizedServerOwnedM04.formula.candidates[0].decoction.method, /约500mL/, "disease duration must not be misread as pediatric age");
assert.match(finalizedServerOwnedM04.formula.candidates[0].formulaAnalysis, /围绕.+展开组方/);
assert.match(finalizedServerOwnedM04.formula.candidates[0].formulaAnalysis, /主要治疗支点/);
const pediatricDecoctionContent = applyDeterministicDecoctionMethod(serverOwnedContent, "病程3个月；年龄：8岁");
const pediatricDecoction = JSON.parse(pediatricDecoctionContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.match(pediatricDecoction.formula.candidates[0].decoction.method, /约200mL/);
assert.equal(isCompleteM04Reasoning(finalizedServerOwnedM04, finalizedServerOwnedVisible, spleenDeficiencyPrior), true, m04SemanticIssue(finalizedServerOwnedM04, finalizedServerOwnedVisible, spleenDeficiencyPrior));
const validConditionalModification = {
  ...finalizedServerOwnedM04,
  formula: {
    ...finalizedServerOwnedM04.formula,
    modifications: [{
      trigger: "夜醒增多时",
      targetPathogenesis: "心脾两虚，神失所养",
      action: "加茯神",
      doseOrHandling: null,
      reason: "加强宁心安神",
      riskNote: "",
    }],
  },
};
assert.equal(m04SemanticIssue(validConditionalModification, finalizedServerOwnedVisible, spleenDeficiencyPrior, isKnownTcmHerbName, true, true), undefined, "dose-free conditional modifications do not need workflow copy in the customer-facing risk field");
for (const [doseCount, course, expected] of [
  ["5剂", "7日", "course_inconsistent"],
  ["5剂", "999年", "course"],
  ["5剂", "5g", "course"],
  ["31剂", "31日", "dose_count"],
]) {
  const invalidRegimen = {
    ...finalizedServerOwnedM04,
    formula: {
      ...finalizedServerOwnedM04.formula,
      candidates: [{
        ...finalizedServerOwnedM04.formula.candidates[0],
        decoction: { ...finalizedServerOwnedM04.formula.candidates[0].decoction, doseCount, course },
      }],
    },
  };
  assert.match(m04SemanticIssue(invalidRegimen, "", spleenDeficiencyPrior, isKnownTcmHerbName, true, true, true) || "", new RegExp(expected), `canonical M04 must reject ${doseCount}/${course}`);
  assert.match(editedPrescriptionSemanticIssue(invalidRegimen, 0, spleenDeficiencyPrior) || "", new RegExp(expected), `workbench round-trip must reject ${doseCount}/${course}`);
}

assert.equal(normalizeModelNullableText(["炒"]), "炒");
assert.equal(normalizeModelNullableText([]), null);
assert.equal(normalizeModelNullableText(["捣碎", "同煎"]), "捣碎、同煎");
const invalidProcessingObject = { value: "炒" };
assert.equal(normalizeModelNullableText(invalidProcessingObject), invalidProcessingObject, "objects stay invalid instead of being guessed");
assert.equal(normalizePrescriptionRole(["君"]), "君");
assert.equal(normalizePrescriptionRole("君药"), "君");
assert.equal(normalizePrescriptionRole("君药（养心安神）"), "君");
assert.equal(normalizePrescriptionRole("臣药-辅助健脾"), "臣");
assert.equal(normalizePrescriptionRole("臣兼佐"), "臣");
assert.equal(normalizePrescriptionRole("主要药"), "主要药", "free-text roles remain invalid");

const compiledProposal = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    therapyMatch: "养血安神",
    applicable: "心血不足",
    notApplicable: "证候变化时复核",
    herbs: [{ name: "酸枣仁", processing: ["炒"], dose: "15g", role: "君药", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, isToxic: false, decoctionRequirement: ["捣碎", "同煎"] }],
    formulaAnalysis: "酸枣仁养血安神",
    decoction: { doseCount: "5剂", method: "每日1剂，浸泡30分钟，煎煮2次，合并药液400mL，早晚分服", course: "5日", followUpNode: "完成5剂后复诊" },
  },
  patentAndWestern: [{
    type: "中成药",
    name: "示例中成药",
    specification: "每袋6g",
    singleDose: "6g",
    frequency: "每日2次",
    route: "口服",
    usageBoundary: "仅在适应证与本例诊断一致时考虑",
    course: "5日",
    positioning: "替代方案",
    correspondingProblem: "入睡困难",
    evidenceSource: "[EVID-INST-001] 药品说明书",
    relationship: "不与同成分制剂重复使用",
    riskNote: "复核过敏史和现用药",
  }],
  modifications: [{
    trigger: "夜醒明显增多时",
    targetRef: "P1",
    actionType: "add",
    herbName: "茯神",
    reason: "加强宁心安神",
  }],
  nonPharma: m04.nonPharma,
  overview: { primarySyndrome: "恶意覆盖" },
}, stable);
assert.equal(compiledProposal?.overview, stable.overview, "M04 proposal cannot overwrite signed M03 overview");
assert.equal(compiledProposal?.pathogenesis, stable.pathogenesis, "M04 proposal cannot overwrite signed M03 pathogenesis");
assert.equal(compiledProposal?.formula?.candidates[0].herbs[0].processing, "炒");
assert.equal(compiledProposal?.formula?.candidates[0].herbs[0].role, "君");
assert.equal(compiledProposal?.formula?.candidates[0].herbs[0].decoctionRequirement, "捣碎、同煎");
assert.equal(compiledProposal?.formula?.modifications[0].targetPathogenesis, "心血不足");
assert.equal(compiledProposal?.formula?.modifications[0].action, "加茯神");
assert.match(compiledProposal?.formula?.modifications[0].riskNote || "", /药味工作台.+重新审方/, "conditional modifications must explain how to operationalize and re-audit an actual change");
assert.equal(compiledProposal?.formula?.patentAndWestern[0].route, "口服");
const clinicalReviewPayload = buildM04ClinicalReviewPayload(
  { ...stable, contractSignature: "secret-signature", clinicalReview: { status: "accepted" }, irrelevantWorkflowBlob: "x".repeat(50_000) },
  { ...compiledProposal, contractSignature: "secret-signature", clinicalReview: { status: "accepted" }, irrelevantWorkflowBlob: "y".repeat(50_000) },
);
assert.equal(clinicalReviewPayload.prior.contractSignature, undefined, "review projection excludes signature and workflow metadata");
assert.equal(clinicalReviewPayload.candidate.contractSignature, undefined, "candidate review projection excludes final envelope metadata");
assert.equal(clinicalReviewPayload.candidate.formula.candidates[0].herbs[0].name, "酸枣仁", "review projection retains the clinically material herb plan");
assert.ok(buildM04ClinicalReviewPrompt("入睡困难", stable, compiledProposal).length < 20_000, "bounded clinical review prompt cannot be inflated by unrelated envelope fields");
assert.deepEqual(parseM04ClinicalReview("```json\n{\"status\":\"accepted\",\"issueCode\":\"none\"}\n```"), { status: "accepted", issueCode: "none" });
assert.deepEqual(parseM04ClinicalReview('{"status":"repair","issueCode":"dose_rationale_concern"}'), { status: "repair", issueCode: "dose_rationale_concern" });
assert.deepEqual(parseM04ClinicalReview('{"status":"pass","issueCode":"none"}'), { status: "unavailable", issueCode: "review_unavailable" }, "unknown reviewer statuses stay fail-closed");
const reviewSemanticHash = m04ClinicalReviewSemanticHash(stable, compiledProposal);
const serverFinalizedReviewPayload = structuredClone(compiledProposal);
serverFinalizedReviewPayload.formula.candidates[0].formulaSource = { evidenceLevel: "classic_source", source: "《太平惠民和剂局方》" };
serverFinalizedReviewPayload.formula.candidates[0].decoction.method = "服务端标准煎服法";
serverFinalizedReviewPayload.formula.candidates[0].decoction.followUpNode = "完成5剂后复诊";
assert.equal(m04ClinicalReviewSemanticHash(stable, serverFinalizedReviewPayload), reviewSemanticHash, "server-owned provenance and rendering do not trigger a second stochastic clinical review");
assert.equal(canRebindM04ClinicalReview(stable, compiledProposal, serverFinalizedReviewPayload), true);
const clinicallyChangedReviewPayload = structuredClone(compiledProposal);
clinicallyChangedReviewPayload.formula.candidates[0].herbs[0].dose = "9g";
assert.notEqual(m04ClinicalReviewSemanticHash(stable, clinicallyChangedReviewPayload), reviewSemanticHash, "a dose change always invalidates the clinical-review decision fingerprint");
assert.equal(canRebindM04ClinicalReview(stable, compiledProposal, clinicallyChangedReviewPayload), false, "a core clinical change cannot reuse the earlier review");
const planChangedReviewPayload = structuredClone(compiledProposal);
planChangedReviewPayload.formula.modifications = [];
assert.notEqual(m04ClinicalReviewSemanticHash(stable, planChangedReviewPayload), reviewSemanticHash, "a conditional modification change always invalidates the clinical-review decision fingerprint");
assert.equal(canRebindM04ClinicalReview(stable, compiledProposal, planChangedReviewPayload), true, "evidence governance may monotonically remove an optional branch without a second stochastic review");
const addedPlanReviewPayload = structuredClone(compiledProposal);
addedPlanReviewPayload.formula.modifications.push({ ...addedPlanReviewPayload.formula.modifications[0], trigger: "新增触发条件" });
assert.equal(canRebindM04ClinicalReview(stable, compiledProposal, addedPlanReviewPayload), false, "finalization cannot add an unreviewed optional branch");
assert.equal(compiledProposal?.formula?.patentAndWestern[0].evidence.evidenceLevel, "instruction");

const auditInputFidelityProposal = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "温经活血自拟方",
    herbs: [
      { name: "郁金", processing: null, dose: "10g", role: "佐", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize" },
      { name: "香附", processing: null, dose: "8g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null },
    ],
    decoction: { doseCount: "5剂", course: "5日" },
  },
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(auditInputFidelityProposal?.formula?.candidates[0].herbs[0].dose, "10g", "the exact proposed dose reaches the external audit without a hidden pre-audit reduction");
assert.equal(auditInputFidelityProposal?.formula?.candidates[0].herbs[1].dose, "8g", "all other proposed doses remain unchanged before audit");
const duplicateHerbProposal = {
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "本例辨证组方",
    herbs: [
      { name: "酸枣仁", processing: null, dose: "10g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null },
      { name: " 酸枣仁 ", processing: "炒", dose: "5g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null },
    ],
    decoction: { doseCount: "5剂", course: "5日" },
  },
  nonPharma: m04.nonPharma,
};
assert.match(m04ProposalIssueCode(duplicateHerbProposal, stable) || "", /candidate_herbs_1_name/, "duplicate herb rows are rejected before compilation and audit");
assert.equal(compileM04Proposal(duplicateHerbProposal, stable), undefined, "duplicate herb rows can never become a signed prescription");
for (const [leftName, rightName] of [["黄芪", "黄耆"], ["甘草", "炙甘草"], ["延胡索", "元胡"]]) {
  const identityDuplicateProposal = {
    ...duplicateHerbProposal,
    candidate: {
      ...duplicateHerbProposal.candidate,
      herbs: duplicateHerbProposal.candidate.herbs.map((herb, index) => ({
        ...herb,
        name: index === 0 ? leftName : rightName,
        processing: index === 0 ? null : herb.processing,
      })),
    },
  };
  assert.match(m04ProposalIssueCode(identityDuplicateProposal, stable) || "", /candidate_herbs_1_name/, `${leftName}/${rightName} share one governed proposal identity`);
  assert.equal(compileM04Proposal(identityDuplicateProposal, stable), undefined, `${leftName}/${rightName} cannot reach audit as two rows and two doses`);
}
const independentlyCataloguedHerbsProposal = {
  ...duplicateHerbProposal,
  candidate: {
    ...duplicateHerbProposal.candidate,
    herbs: duplicateHerbProposal.candidate.herbs.map((herb, index) => ({
      ...herb,
      name: index === 0 ? "生地黄" : "熟地黄",
      processing: null,
    })),
  },
};
assert.equal(m04ProposalIssueCode(independentlyCataloguedHerbsProposal, stable), undefined, "distinct governed knowledge rows are not mistaken for one processed source identity");
const wrappedRegimenProposal = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "酸枣仁", processing: null, dose: "15g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null }],
    decoction: {
      doseCount: { value: 5, unit: "剂" },
      method: ["每日1剂，冷水浸泡30分钟，煎煮2次，合并药液约400mL，早晚分服"],
      course: { value: 5, unit: "日" },
      followUpNode: { value: "完成5剂后复诊" },
    },
  },
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(wrappedRegimenProposal?.formula?.candidates[0].decoction.method, "每日1剂，冷水浸泡30分钟，煎煮2次，合并药液约400mL，早晚分服");
assert.equal(wrappedRegimenProposal?.formula?.candidates[0].decoction.followUpNode, "完成5剂后复诊");
assert.equal(
  wrappedRegimenProposal?.formula?.candidates[0].herbs[0].targetPathogenesis,
  stable.pathogenesis.chain[0].pathogenesis,
  "the minimal M04 proposal must bind each herb to its real M03 pathogenesis node during compilation",
);
assert.match(
  wrappedRegimenProposal?.formula?.candidates[0].herbs[0].prescriptionRole || "",
  new RegExp(stable.pathogenesis.chain[0].therapyDirection),
  "the minimal M04 proposal must expose the actual per-prescription therapeutic intent",
);
assert.doesNotMatch(
  JSON.stringify(wrappedRegimenProposal?.formula?.candidates[0].herbs[0]),
  /由服务端生成/,
  "compiled herbs must never carry generated placeholders into the production enrichment chain",
);
const omittedOptionalRegimenProposal = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "酸枣仁", processing: null, dose: "15g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null }],
    decoction: { doseCount: "5剂", method: [], course: "5日", followUpNode: { value: "" } },
  },
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(omittedOptionalRegimenProposal?.formula?.candidates[0].decoction.method, "由服务端生成");
assert.equal(omittedOptionalRegimenProposal?.formula?.candidates[0].decoction.followUpNode, "由服务端生成");
const transparentTherapyPrior = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "心脾两虚证", overallPathogenesis: "心脾两虚，气血不足，心神失养" },
  therapy: { overallPrinciple: "健脾益气，养血安神" },
  pathogenesis: {
    chain: [
      { nodeId: "P1", patientFact: "纳差便溏", syndromeEvidence: "脾气虚", pathogenesis: "脾气虚弱", therapyDirection: "健脾益气" },
      { nodeId: "P2", patientFact: "心悸不寐", syndromeEvidence: "心血不足", pathogenesis: "心血不足，心神不宁", therapyDirection: "养血安神" },
    ],
  },
};
const transparentAligned = {
  stage: "prescribe",
  formula: { candidates: [{ herbs: [
    { name: "白术", targetKind: "pathogenesis_node" },
    { name: "黄芪", targetKind: "pathogenesis_node" },
    { name: "龙眼肉", targetKind: "pathogenesis_node" },
    { name: "酸枣仁", targetKind: "pathogenesis_node" },
  ] }] },
};
assert.equal(transparentFormulaTherapyIssue(transparentAligned, transparentTherapyPrior), undefined, "knowledge-backed herbs aligned to the locked treatment may be transparently declassified after repair exhaustion");
const transparentOpposed = {
  stage: "prescribe",
  formula: { candidates: [{ herbs: [
    { name: "大黄", targetKind: "pathogenesis_node" },
    { name: "黄连", targetKind: "pathogenesis_node" },
  ] }] },
};
assert.match(transparentFormulaTherapyIssue(transparentOpposed, transparentTherapyPrior) || "", /transparent_therapy_/, "provider target labels cannot make purgative/heat-clearing herbs support a tonic treatment");
for (const [herb, targetKind = "pathogenesis_node"] of [
  ["大黄"], ["黄连"], ["附子"],
  ["远志"], ["麝香"], ["冰片"], ["石菖蒲"], ["苏合香"], ["安息香"],
  ["牡蛎"], ["鳖甲"], ["昆布"], ["海藻"], ["瓦楞子"], ["海蛤壳"],
  ["大黄", "formula_structure"],
]) {
  const mixedCandidate = {
    ...transparentAligned,
    formula: { candidates: [{ herbs: [
      ...transparentAligned.formula.candidates[0].herbs,
      { name: herb, targetKind, targetRef: targetKind === "formula_structure" ? "FORMULA_STRUCTURE" : "P1", structureRole: targetKind === "formula_structure" ? "temper" : null },
    ] }] },
  };
  assert.match(transparentFormulaTherapyIssue(mixedCandidate, transparentTherapyPrior) || "", /unsupported_high_impact/, `${herb} cannot be diluted by aligned herbs or hidden behind a formula-structure role`);
}
const intendedAnshenPrior = {
  ...transparentTherapyPrior,
  therapy: { overallPrinciple: "宁心安神" },
  pathogenesis: { chain: [{ ...transparentTherapyPrior.pathogenesis.chain[1], therapyDirection: "宁心安神" }] },
};
assert.equal(transparentFormulaTherapyIssue({
  stage: "prescribe",
  formula: { candidates: [{ herbs: [
    { name: "酸枣仁", function: "养心安神", targetKind: "pathogenesis_node" },
    { name: "远志", function: "宁心安神", targetKind: "pathogenesis_node" },
  ] }] },
}, intendedAnshenPrior), undefined, "远志 used for its declared calming action must not be mislabeled as an unsupported orifice-opening direction");
const enrichedAnshenCandidate = {
  ...m04,
  overview: {
    ...m04.overview,
    primarySyndrome: intendedAnshenPrior.overview.primarySyndrome,
    overallPathogenesis: intendedAnshenPrior.overview.overallPathogenesis,
  },
  therapy: { overallPrinciple: "宁心安神" },
  formula: {
    ...m04.formula,
    candidates: [{
      ...m04.formula.candidates[0],
      therapyMatch: "宁心安神",
      herbs: [
        {
          ...m04.formula.candidates[0].herbs[0],
          targetRef: intendedAnshenPrior.pathogenesis.chain[0].nodeId,
          targetPathogenesis: intendedAnshenPrior.pathogenesis.chain[0].pathogenesis,
          function: "养心安神",
          prescriptionRole: "养心安神",
        },
        {
          ...m04.formula.candidates[0].herbs[0],
          name: "远志",
          dose: "6g",
          role: "臣",
          targetRef: intendedAnshenPrior.pathogenesis.chain[0].nodeId,
          targetPathogenesis: intendedAnshenPrior.pathogenesis.chain[0].pathogenesis,
          function: "宁心安神",
          prescriptionRole: "宁心安神",
          decoctionRequirement: null,
        },
      ],
    }],
  },
};
const enrichedAnshenContent = applyDeterministicHerbPrescriptionRoles(
  applyDeterministicHerbFunctions(
    `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(enrichedAnshenCandidate)}\n<!-- DIAGNOSIS_JSON_END -->`,
  ),
);
const enrichedAnshen = JSON.parse(enrichedAnshenContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.doesNotMatch(enrichedAnshen.formula.candidates[0].herbs[1].prescriptionRole, /知识库功用/, "knowledge display text must not be written back into the prescription-intent field");
assert.doesNotMatch(
  m04SemanticIssue(enrichedAnshen, "", intendedAnshenPrior) || "",
  /unsupported_high_impact_orifice_open/,
  "production enrichment must preserve 远志's case-specific calming intent",
);
const intendedPingganPrior = {
  ...transparentTherapyPrior,
  therapy: { overallPrinciple: "平肝潜阳" },
  pathogenesis: { chain: [{ ...transparentTherapyPrior.pathogenesis.chain[0], therapyDirection: "平肝潜阳" }] },
};
assert.equal(transparentFormulaTherapyIssue({
  stage: "prescribe",
  formula: { candidates: [{ herbs: [{ name: "牡蛎", function: "平肝潜阳", targetKind: "pathogenesis_node" }] }] },
}, intendedPingganPrior), undefined, "牡蛎 used for its declared calming-yang action must not be mislabeled as an unsupported mass-softening direction");
const heatQiPrior = {
  ...transparentTherapyPrior,
  overview: {
    ...transparentTherapyPrior.overview,
    formulaSelectionMode: "self_devised",
    recommendedFormulaNames: [],
    recommendedFormulaDirection: "清热理气",
  },
  therapy: { overallPrinciple: "疏肝理气，清热泻火" },
  pathogenesis: { chain: [{ ...transparentTherapyPrior.pathogenesis.chain[0], therapyDirection: "疏肝理气，清热泻火" }] },
};
assert.match(transparentFormulaTherapyIssue({
  stage: "prescribe",
  formula: { candidates: [{ herbs: [
    { name: "乌药", function: "温肾散寒，理气止痛", targetKind: "pathogenesis_node" },
    { name: "黄连", function: "清热泻火", targetKind: "pathogenesis_node" },
  ] }] },
}, heatQiPrior) || "", /unsupported_high_impact_yang_warm/, "the declared warming action of a multi-action herb must remain visible to polarity governance");
const compiledOpposingHerb = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "本例辨证组方",
    herbs: [{ name: "乌药", processing: null, dose: "6g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null }],
    decoction: { doseCount: "5剂", course: "5日" },
  },
  nonPharma: m04.nonPharma,
}, heatQiPrior);
assert.match(m04SemanticIssue(compiledOpposingHerb, "", heatQiPrior) || "", /formula_direction_drift|unsupported_high_impact_yang_warm/);
assert.match(
  transparentFormulaTherapyIssue(compiledOpposingHerb, heatQiPrior) || "",
  /unsupported_high_impact_yang_warm/,
  "a generated heat-clearing role cannot hide a herb whose governed knowledge has no matching intended action and retains a warming direction",
);
const hiddenOpposingModification = {
  ...compiledOpposingHerb,
  formula: {
    ...compiledOpposingHerb.formula,
    candidates: [{
      ...compiledOpposingHerb.formula.candidates[0],
      herbs: [{ name: "黄连", dose: "3g", role: "君", prescriptionRole: "清热泻火", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: heatQiPrior.pathogenesis.chain[0].pathogenesis, function: "清热泻火" }],
    }],
    modifications: [{
      trigger: "胀痛加重时",
      targetPathogenesis: heatQiPrior.pathogenesis.chain[0].pathogenesis,
      action: "加乌药",
      doseOrHandling: null,
      reason: "加强理气止痛",
      riskNote: "采用前需重新审方",
    }],
  },
};
assert.match(
  m04SemanticIssue(hiddenOpposingModification, "", heatQiPrior, undefined, true, true) || "",
  /modification_0_herb_0_unsupported_high_impact_yang_warm/,
  "a matching secondary action must not hide a conditional herb action that opposes the locked hot/cold direction",
);
const compiledConditionalProposal = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "本例辨证组方",
    herbs: [{ name: "黄连", processing: null, dose: "3g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null }],
    decoction: { doseCount: "5剂", course: "5日" },
  },
  patentAndWestern: [],
  modifications: [{ trigger: "胀痛加重时", targetRef: "P1", actionType: "add", herbName: "乌药", reason: "加强理气止痛" }],
  nonPharma: m04.nonPharma,
}, heatQiPrior);
assert.deepEqual(compiledConditionalProposal?.formula?.modifications, [], "an opposing optional modification is omitted without discarding the current prescription");
const wrappedScalarRegimenProposal = {
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "本例辨证组方",
    therapyMatch: "与锁定治法无关的模型自由文本",
    herbs: [{ name: "黄连", processing: null, dose: "3g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null }],
    decoction: { doseCount: { value: "5剂" }, course: { text: "5日" } },
  },
  patentAndWestern: [],
  modifications: [],
  nonPharma: {
    diet: "饮食清淡",
    lifestyle: "规律作息",
    emotion: "调畅情志",
    acupointCare: "模型越权内容",
    tcmTreatments: ["acupuncture", "tuina", "moxibustion", "cupping"].map((projectCode) => ({ projectCode, targetRef: "P1" })),
    monitoring: [{ metric: "症状", timing: "每日", trigger: "加重时复诊" }],
  },
};
assert.equal(m04ProposalIssueCode(wrappedScalarRegimenProposal, heatQiPrior), undefined, "scalar wrappers and extra optional project rows are normalized before schema validation");
const compiledWrappedRegimen = compileM04Proposal(wrappedScalarRegimenProposal, heatQiPrior);
assert.equal(compiledWrappedRegimen?.formula?.candidates?.[0]?.decoction?.doseCount, "5剂");
assert.equal(compiledWrappedRegimen?.formula?.candidates?.[0]?.therapyMatch, heatQiPrior.therapy.overallMethod || heatQiPrior.therapy.overallPrinciple, "M03 owns therapyMatch and prefers its concrete treatment method");
const conflictingLegacyMethodPrior = {
  ...heatQiPrior,
  therapy: { ...heatQiPrior.therapy, overallMethod: "与锁定治法冲突的旧字段" },
};
assert.deepEqual(
  getM03TherapyLock({
    therapy: { overallPrinciple: "虚则补之", overallMethod: "健脾益气，渗湿止泻" },
    pathogenesis: { chain: [{ therapyDirection: "健脾助运，渗湿止泻" }] },
  }),
  {
    candidateMatch: "健脾益气，渗湿止泻",
    validationContext: "健脾益气，渗湿止泻；虚则补之；健脾助运，渗湿止泻",
  },
  "compiler, canonicalizer and validator must share one concrete M03 therapy lock",
);
assert.deepEqual(
  getM03TherapyLock({
    therapy: { overallPrinciple: "养血安神", overallMethod: "待确认" },
    pathogenesis: { chain: [{ therapyDirection: "养血宁心" }] },
  }),
  {
    candidateMatch: "养血宁心",
    validationContext: "养血安神；养血宁心",
  },
  "an unresolved placeholder can never become the cross-stage M04 therapy lock",
);
assert.deepEqual(
  getM03TherapyLock({
    therapy: { overallPrinciple: "治法由后端知识库自动补全", overallMethod: "具体治法将在后续阶段给出" },
    pathogenesis: { chain: [{ therapyDirection: "健脾益气，养血安神" }] },
  }),
  {
    candidateMatch: "健脾益气，养血安神",
    validationContext: "健脾益气，养血安神",
  },
  "open production-placeholder variants cannot outrank an executable node therapy",
);
const legacyMethodLockedContent = applyDeterministicCandidateTherapyMatch(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(compiledWrappedRegimen)}\n<!-- DIAGNOSIS_JSON_END -->`,
  conflictingLegacyMethodPrior,
);
const legacyMethodLocked = JSON.parse(legacyMethodLockedContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(legacyMethodLocked.formula.candidates[0].therapyMatch, conflictingLegacyMethodPrior.therapy.overallMethod, "the signed M03 concrete treatment method owns M04 therapyMatch; the higher-level principle is only a fallback");
const classicalLiteralPrior = {
  ...heatQiPrior,
  therapy: { overallPrinciple: "治崇乎本，法贵有序" },
};
assert.equal(
  isM04TherapyMatchAligned(
    `${classicalLiteralPrior.therapy.overallPrinciple}；清解郁热；调畅气机`,
    classicalLiteralPrior.therapy.overallPrinciple,
  ),
  true,
  "an exact compiler-owned M03 therapy literal remains valid when node directions are appended to the lock",
);
assert.equal(
  isM04TherapyMatchAligned("清热泻火；调畅气机", "温阳散寒"),
  false,
  "a non-literal opposing therapy remains rejected",
);
assert.equal(
  isM04TherapyMatchAligned("治崇乎本，法贵有序；宁心安神", "治崇乎本"),
  false,
  "a short substring is not mistaken for an exact compiler-owned therapy clause",
);
assert.equal(compiledWrappedRegimen?.nonPharma?.acupointCare, null);
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 0, strictFormulaIssue: "formula_reference_declassified", requestAborted: false }), false);
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 1, strictFormulaIssue: "formula_reference_declassified", requestAborted: false }), true);
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 2, strictFormulaIssue: "formula_reference_declassified", therapyIssue: "transparent_therapy_coverage", requestAborted: false }), false);
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 2, strictFormulaIssue: "formula_reference_declassified", requestAborted: true }), false);
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 2, strictFormulaIssue: "formula_reference_declassified", requestAborted: false }), true);
let repairState = initialM04RepairState();
repairState = advanceM04RepairState(repairState, { ok: true, finishReason: "length" });
repairState = advanceM04RepairState(repairState, { ok: false, finishReason: null });
assert.deepEqual(repairState, { completedAttempts: 0, requestAborted: false }, "non-stop and failed provider repairs do not advance the state machine");
repairState = advanceM04RepairState(repairState, { ok: true, finishReason: "stop" });
assert.equal(repairState.completedAttempts, 1);
repairState = advanceM04RepairState(repairState, { ok: true, finishReason: "stop", requestAborted: true });
assert.deepEqual(repairState, { completedAttempts: 2, requestAborted: true });
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: repairState.completedAttempts, strictFormulaIssue: "formula_reference_declassified", requestAborted: repairState.requestAborted }), false, "a cancellation after the second response still prevents identity declassification");
const proposalJson = JSON.stringify({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "酸枣仁", processing: null, dose: "15g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null }],
    decoction: { doseCount: "5剂", course: "5日" },
  },
  nonPharma: m04.nonPharma,
});
assert.equal(compileM04JsonObjectContent(proposalJson, stable)?.stage, "prescribe");
const excessEmperorProposal = JSON.parse(proposalJson);
excessEmperorProposal.candidate.herbs = [
  { name: "酸枣仁", processing: null, dose: "15g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null },
  { name: "茯苓", processing: null, dose: "12g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null },
  { name: "远志", processing: null, dose: "6g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null },
];
const compiledExcessEmperor = compileM04JsonObjectContent(JSON.stringify(excessEmperorProposal), stable);
assert.equal(
  compiledExcessEmperor?.formula?.candidates[0].herbs.filter((herb) => herb.role === "君").length,
  2,
  "the proposal compiler demotes only excess emperor labels without changing medicines, doses or targets",
);
assert.deepEqual(
  compiledExcessEmperor?.formula?.candidates[0].herbs.map((herb) => [herb.name, herb.dose, herb.targetRef]),
  [["酸枣仁", "15g", "P1"], ["茯苓", "12g", "P1"], ["远志", "6g", "P1"]],
);
const invalidTargetProposal = JSON.parse(proposalJson);
invalidTargetProposal.candidate.herbs[0].targetRef = "P9";
const compiledInvalidTarget = compileM04JsonObjectContent(JSON.stringify(invalidTargetProposal), stable);
assert.equal(compiledInvalidTarget?.formula?.candidates[0].herbs[0].targetRef, "P9", "compiler must not silently retarget an invalid clinical reference");
assert.match(m04SemanticIssue(compiledInvalidTarget, "", stable) || "", /target_ref_invalid/);
const invalidTargetContent = applyDeterministicHerbTargets(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(compiledInvalidTarget)}\n<!-- DIAGNOSIS_JSON_END -->`,
  stable,
);
const invalidTargetAfterProductionTransform = JSON.parse(invalidTargetContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(invalidTargetAfterProductionTransform.formula.candidates[0].herbs[0].targetRef, "P9", "the production target transform must preserve an invalid reference for rejection instead of retargeting it");
assert.match(m04SemanticIssue(invalidTargetAfterProductionTransform, "", stable) || "", /target_ref_invalid/);
const annotatedHerbProposal = JSON.parse(proposalJson);
annotatedHerbProposal.candidate.herbs = [{ name: "苦杏仁(捣碎)", dose: "6g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null }];
const compiledAnnotatedHerb = compileM04JsonObjectContent(JSON.stringify(annotatedHerbProposal), stable);
assert.equal(compiledAnnotatedHerb?.formula?.candidates[0].herbs[0].name, "苦杏仁");
assert.equal(compiledAnnotatedHerb?.formula?.candidates[0].herbs[0].processing, "捣碎");
const annotatedHerbContent = applyDeterministicHerbDecoctionRequirements(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(compiledAnnotatedHerb)}\n<!-- DIAGNOSIS_JSON_END -->`);
const finalizedAnnotatedHerb = JSON.parse(annotatedHerbContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.match(finalizedAnnotatedHerb.formula.candidates[0].herbs[0].decoctionRequirement, /后下/);
for (const [variant, expectedName, expectedProcessing] of [
  ["酒炒白芍", "白芍", "酒炒"],
  ["艾叶炭", "艾叶", "炭"],
  ["焦山楂", "山楂", "焦"],
]) {
  const processedProposal = JSON.parse(proposalJson);
  processedProposal.candidate.herbs = [{ name: variant, dose: "6g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null }];
  const compiledProcessed = compileM04JsonObjectContent(JSON.stringify(processedProposal), stable);
  assert.equal(compiledProcessed?.formula?.candidates[0].herbs[0].name, expectedName, variant);
  assert.match(compiledProcessed?.formula?.candidates[0].herbs[0].processing || "", new RegExp(expectedProcessing), variant);
}
for (const variant of ["苦杏仁（捣碎、后下）", "苦杏仁（捣碎）后下", "苦杏仁(捣碎后同煎)"]) {
  const variantProposal = JSON.parse(proposalJson);
  variantProposal.candidate.herbs = [{ name: variant, dose: "6g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null }];
  const compiledVariant = compileM04JsonObjectContent(JSON.stringify(variantProposal), stable);
  assert.equal(compiledVariant?.formula?.candidates[0].herbs[0].name, "苦杏仁", variant);
  const finalizedVariantContent = applyDeterministicHerbDecoctionRequirements(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(compiledVariant)}\n<!-- DIAGNOSIS_JSON_END -->`);
  const finalizedVariant = JSON.parse(finalizedVariantContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  assert.match(finalizedVariant.formula.candidates[0].herbs[0].decoctionRequirement, /后下/, variant);
  assert.match(String(finalizedVariant.formula.candidates[0].herbs[0].processing || ""), /捣碎/, `${variant} keeps its processing instruction after canonicalization`);
}
const suffixOnlyProposal = JSON.parse(proposalJson);
suffixOnlyProposal.candidate.herbs = [{ name: "苦杏仁后下", dose: "6g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null }];
const compiledSuffixOnly = compileM04JsonObjectContent(JSON.stringify(suffixOnlyProposal), stable);
assert.equal(compiledSuffixOnly?.formula?.candidates[0].herbs[0].name, "苦杏仁");
assert.match(compiledSuffixOnly?.formula?.candidates[0].herbs[0].decoctionRequirement || "", /后下/);
for (const herbName of ["三七", "川贝母", "鹿茸"]) {
  const powderProposal = JSON.parse(proposalJson);
  powderProposal.candidate.herbs = [{ name: herbName, dose: "3g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null }];
  const compiledPowder = compileM04JsonObjectContent(JSON.stringify(powderProposal), stable);
  const powderContent = applyDeterministicHerbDecoctionRequirements(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(compiledPowder)}\n<!-- DIAGNOSIS_JSON_END -->`);
  const finalizedPowder = JSON.parse(powderContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  assert.match(
    finalizedPowder.formula.candidates[0].herbs[0].decoctionRequirement || "",
    /冲服|调服|研粉|研末|吞服|丸散/,
    `${herbName} must inherit the governed powder administration semantics from the knowledge code`,
  );
}
for (const herbName of ["朱砂", "芒硝", "雷丸"]) {
  const prohibited = { ...compiledAnnotatedHerb, formula: { candidates: [{ ...compiledAnnotatedHerb.formula.candidates[0], herbs: [{ ...compiledAnnotatedHerb.formula.candidates[0].herbs[0], name: herbName, decoctionRequirement: null }] }] } };
  const prohibitedContent = applyDeterministicHerbPrescriptionRoles(
    applyDeterministicHerbFunctions(
      applyDeterministicHerbDecoctionRequirements(
        applyDeterministicCandidateTherapyMatch(
          applyDeterministicHerbTargets(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(prohibited)}\n<!-- DIAGNOSIS_JSON_END -->`, stable),
          stable,
        ),
      ),
    ),
  );
  const prohibitedJson = JSON.parse(prohibitedContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  assert.match(prohibitedJson.formula.candidates[0].herbs[0].decoctionRequirement, /禁止同煎/, herbName);
  assert.match(
    m04SemanticIssue(prohibitedJson, "", undefined, undefined, true, true, true) || "",
    /route_not_decoction/,
    `${herbName} must remain non-executable as a decoction even when the customer-facing instruction is present`,
  );
}
assert.equal(compileM04JsonObjectContent(`${proposalJson}\n额外正文`, stable), undefined, "JSON-only M04 rejects trailing provider prose");
assert.equal(compileM04JsonObjectContent("[]", stable), undefined, "M04 JSON must be one object");
assert.equal(compileM04JsonObjectContent(JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose" }), stable), undefined, "a diagnose object cannot enter the M04 compatibility path");
assert.equal(compileM04JsonObjectContent(JSON.stringify({ ...stable, stage: "prescribe", overview: { ...stable.overview, primarySyndrome: "恶意覆盖" } }), stable), undefined, "M04 cannot submit a full V2 object that bypasses the server-owned compiler");
const wrappedProposal = {
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: [{
    name: { value: "被服务端锁定方名覆盖" },
    herbs: [{
      name: { value: "酸枣仁" },
      processing: { value: "炒" },
      dose: { value: 15, unit: "g" },
      role: { value: "君药" },
      targetKind: "pathogenesis_node",
      targetRef: "P1",
      structureRole: null,
    }],
    decoction: { doseCount: { value: 5, unit: "剂" }, course: { value: 5, unit: "日" } },
  }],
  nonPharma: m04.nonPharma,
};
const compiledWrappedProposal = compileM04Proposal(wrappedProposal, stable);
assert.equal(compiledWrappedProposal?.formula?.candidates[0].name, "酸枣仁汤加减", "trusted M03 formula direction owns the final M04 name");
assert.equal(compiledWrappedProposal?.formula?.candidates[0].herbs[0].name, "酸枣仁");
assert.equal(compiledWrappedProposal?.formula?.candidates[0].herbs[0].dose, "15g");
assert.equal(compiledWrappedProposal?.formula?.candidates[0].decoction.doseCount, "5剂");
for (const [doseCount, course] of [
  [5, 5],
  ["5", "5"],
  ["五剂", "五日"],
  [{ value: 5 }, { value: 5 }],
  [{ value: { amount: 5, unit: "剂" } }, { data: { number: "5" }, unitLabel: "日" }],
]) {
  const normalizedRegimen = compileM04Proposal({
    ...wrappedProposal,
    candidate: {
      ...wrappedProposal.candidate[0],
      decoction: { doseCount, course },
    },
  }, stable);
  assert.equal(normalizedRegimen?.formula?.candidates[0].decoction.doseCount, "5剂", JSON.stringify({ doseCount, course }));
  assert.equal(normalizedRegimen?.formula?.candidates[0].decoction.course, "5日", JSON.stringify({ doseCount, course }));
}
for (const decoction of [
  [{ doseCount: 5, course: 5 }],
  { value: { doseCount: { value: { number: 5 }, unitLabel: "剂" }, course: { value: 5, unit: "日" } } },
  JSON.stringify({ doseCount: "五剂", course: "五日" }),
]) {
  const normalizedRegimen = compileM04Proposal({
    ...wrappedProposal,
    candidate: { ...wrappedProposal.candidate[0], decoction },
  }, stable);
  assert.equal(normalizedRegimen?.formula?.candidates[0].decoction.doseCount, "5剂", JSON.stringify(decoction));
  assert.equal(normalizedRegimen?.formula?.candidates[0].decoction.course, "5日", JSON.stringify(decoction));
}
for (const course of ["五剂为一疗程", "疗程共五天", "服完后复诊", "连续服用五日", undefined]) {
  const normalizedRegimen = compileM04Proposal({
    ...wrappedProposal,
    candidate: {
      ...wrappedProposal.candidate[0],
      decoction: { doseCount: "5剂", ...(course == null ? {} : { course }) },
    },
  }, stable);
  assert.equal(normalizedRegimen?.formula?.candidates[0].decoction.course, "5日", JSON.stringify({ course }));
}
const normalizedModificationProposal = compileM04Proposal({
  ...wrappedProposal,
  modifications: [
    { trigger: "夜醒增多时", targetRef: { value: "P1" }, actionType: "添加", herbName: { value: "茯神" }, reason: "加强宁心安神" },
    { trigger: "无效可选行", targetRef: "P1", actionType: "自由发挥", herbName: "茯神", reason: "不得拖垮核心处方" },
    { trigger: "夜醒增多时", targetRef: "P1", actionType: "调整剂量", herbName: "酸枣仁", reason: "调整为20g后观察" },
    { trigger: "夜醒增多时", targetRef: "P1", actionType: "添加", herbName: "模型臆造草", reason: "未知药味必须丢弃" },
    { trigger: "夜醒增多时", targetRef: "P9", actionType: "添加", herbName: "远志", reason: "未知病机引用必须丢弃" },
    { trigger: "夜醒增多时", targetRef: "P1", actionType: "移除", herbName: "远志", reason: "不在当前处方的药味不能移除" },
  ],
}, stable);
assert.equal(normalizedModificationProposal?.formula?.modifications.length, 1, "controlled aliases normalize while malformed optional modifications are dropped");
assert.equal(normalizedModificationProposal?.formula?.modifications[0].action, "加茯神");
const nestedCandidateProposal = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    proposal: {
      name: "酸枣仁汤加减",
      herbs: [{ name: "酸枣仁", dose: "15g", role: "monarch", targetKind: "pathogenesis_node", targetRef: "P1" }],
      decoction: { doseCount: "5剂", course: "5日" },
    },
  },
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(nestedCandidateProposal?.formula?.candidates[0].herbs[0].role, "君", "single candidate wrappers and governed role aliases normalize deterministically");
const stringWrappedCandidate = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: JSON.stringify({
    name: "酸枣仁汤加减",
    herbs: [{ name: "酸枣仁", dose: "15g", role: "辅药", targetKind: "pathogenesis_node", targetRef: "P1" }],
    decoction: { doseCount: "5剂", course: "5日" },
  }),
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(stringWrappedCandidate?.formula?.candidates[0].herbs[0].role, "臣", "a single JSON object wrapper is accepted without accepting extra prose");
const pathogenesisStructureNoise = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidates: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "酸枣仁", dose: "15g", role: "君药（养心安神）", targetKind: "病机节点", targetRef: "P1", structureRole: "不适用" }],
    decoction: { doseCount: "5剂", course: "5日" },
  },
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(pathogenesisStructureNoise?.formula?.candidates[0].herbs[0].structureRole, null, "pathogenesis-node herbs deterministically discard inapplicable structure-role prose");
assert.equal(pathogenesisStructureNoise?.formula?.candidates[0].herbs[0].targetKind, "pathogenesis_node");
const explanatoryStructureRole = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "调和诸药（缓和药性）" }],
    decoction: { doseCount: "5剂", course: "5日" },
  },
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(explanatoryStructureRole?.formula?.candidates[0].herbs[0].structureRole, "harmonize", "explanatory suffixes must canonicalize to one controlled structure role");
const providerStructureRoleAlias = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "协调药势" }],
    decoction: { doseCount: "5剂", course: "5日" },
  },
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(providerStructureRoleAlias?.formula?.candidates[0].herbs[0].structureRole, "harmonize", "provider prose for a controlled formula role is normalized before schema validation");
const missingProviderStructureRole = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "承担方内结构作用" }],
    decoction: { doseCount: "5剂", course: "5日" },
  },
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(missingProviderStructureRole?.formula?.candidates[0].herbs[0].structureRole, "harmonize", "a non-clinical formula-structure row defaults to neutral harmonization instead of discarding the whole prescription");
const controlledWrapperProposal = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [
      { name: "酸枣仁", dose: "15g", role: "君", targetKind: "pathogenesis_node", targetRef: { nodeId: "P1" } },
      { name: "甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: { value: "FORMULA_STRUCTURE" }, structureRole: "调和" },
    ],
    decoction: { doseCount: { value: 5, unit: "剂" }, course: { value: 5, unit: "日" } },
  },
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(controlledWrapperProposal?.formula?.candidates[0].herbs[0].targetRef, "P1", "a unique nodeId wrapper is safely unwrapped without inventing a clinical target");
assert.equal(controlledWrapperProposal?.formula?.candidates[0].herbs[1].targetRef, "FORMULA_STRUCTURE", "the exact governed formula-structure reference remains valid");
const invalidStructureReference = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "P9", structureRole: "harmonize" }],
    decoction: { doseCount: "5剂", course: "5日" },
  },
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(invalidStructureReference?.formula?.candidates[0].herbs[0].targetRef, "P9", "an invalid formula-structure reference must not be silently rewritten");
assert.match(m04SemanticIssue(invalidStructureReference, "", stable) || "", /structure_ref_invalid/);
const normalizedStructureReferenceContent = applyDeterministicHerbTargets(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(invalidStructureReference)}\n<!-- DIAGNOSIS_JSON_END -->`,
  stable,
);
const normalizedStructureReference = JSON.parse(normalizedStructureReferenceContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(normalizedStructureReference.formula.candidates[0].herbs[0].targetRef, "FORMULA_STRUCTURE", "a controlled non-clinical structure role canonicalizes only its protocol constant");
assert.doesNotMatch(m04SemanticIssue(normalizedStructureReference, "", stable) || "", /structure_ref_invalid/);
const validNodeWrongKindContent = applyDeterministicHerbTargets(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(invalidStructureReference).replace('"targetRef":"P9"', '"targetRef":"P1"')}\n<!-- DIAGNOSIS_JSON_END -->`,
  stable,
);
const validNodeWrongKind = JSON.parse(validNodeWrongKindContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(validNodeWrongKind.formula.candidates[0].herbs[0].targetKind, "pathogenesis_node", "a valid clinical P-node is preserved while only the conflicting target kind is repaired");
assert.equal(validNodeWrongKind.formula.candidates[0].herbs[0].targetRef, "P1");
const missingStructureReference = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "甘草", dose: "6g", role: "使", targetKind: "formula_structure", structureRole: "harmonize" }],
    decoction: { doseCount: "5剂", course: "5日" },
  },
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(missingStructureReference?.formula?.candidates[0].herbs[0].targetRef, "FORMULA_STRUCTURE", "a missing non-clinical structure constant may be completed without retargeting a contradictory reference");
assert.equal(controlledWrapperProposal?.formula?.candidates[0].decoction.doseCount, "5剂", "structured dose counts normalize to the controlled display string");
assert.equal(controlledWrapperProposal?.formula?.candidates[0].decoction.course, "5日", "numeric course strings normalize to days");
assert.equal(compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "酸枣仁", dose: "15g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1" }],
    decoction: { doseCount: "5剂", course: { value: 5, unit: "g" } },
  },
  nonPharma: m04.nonPharma,
}, stable)?.formula?.candidates[0].decoction.course, "5日", "a redundant mass-like course value is discarded rather than becoming executable");
assert.equal(compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "酸枣仁", dose: "15g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1" }],
    decoction: { doseCount: "5剂", course: "7日" },
  },
  nonPharma: m04.nonPharma,
}, stable)?.formula?.candidates[0].decoction.course, "5日", "the server derives the once-daily course from the executable dose count");
assert.equal(compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "酸枣仁", dose: "15g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1" }],
  },
}, stable), undefined, "missing dose count and course remain repairable model omissions instead of becoming executable server defaults");
const topLevelCandidate = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  name: "酸枣仁汤加减",
  herbs: [{ name: "酸枣仁", dose: "15g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1" }],
  decoction: { doseCount: "5剂", course: "5日" },
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(topLevelCandidate?.formula?.candidates[0].name, "酸枣仁汤加减", "one unambiguous top-level candidate shape is canonicalized");
const wrappedAlternative = compileM04Proposal({
  ...wrappedProposal,
  candidate: [{ ...wrappedProposal.candidate[0], name: { value: "归脾汤加减" } }],
}, {
  ...stable,
  overview: {
    ...stable.overview,
    recommendedFormulaDirection: "酸枣仁汤或归脾汤酌选",
    recommendedFormulaNames: ["酸枣仁汤", "归脾汤"],
    formulaSelectionMode: "alternatives",
  },
});
assert.equal(wrappedAlternative?.formula?.candidates[0].name, "归脾汤加减", "alternative mode keeps the one explicitly selected governed formula");
const wrappedCombined = compileM04Proposal(wrappedProposal, {
  ...stable,
  overview: {
    ...stable.overview,
    recommendedFormulaDirection: "酸枣仁汤合归脾汤加减",
    recommendedFormulaNames: ["酸枣仁汤", "归脾汤"],
    formulaSelectionMode: "combined",
  },
});
assert.equal(wrappedCombined?.formula?.candidates[0].name, "酸枣仁汤合归脾汤加减", "combined mode keeps every governed base formula");
const wrappedSelfDevised = compileM04Proposal(wrappedProposal, {
  ...stable,
  overview: {
    ...stable.overview,
    recommendedFormulaDirection: "按已锁定病机与治法辨证组方",
    recommendedFormulaNames: [],
    formulaSelectionMode: "self_devised",
  },
});
assert.equal(wrappedSelfDevised?.formula?.candidates[0].name, "本例辨证组方", "uncompilable formula identities become an explicit self-devised candidate");
assert.equal(compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: [{ name: "甲方", herbs: proposalJson }, { name: "乙方", herbs: proposalJson }],
}, stable), undefined, "ambiguous multi-candidate proposals remain rejected");
assert.equal(compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: { name: "酸枣仁汤加减", herbs: [{ name: "酸枣仁", dose: 15, role: "君", targetKind: "pathogenesis_node", targetRef: "P1" }] },
}, stable), undefined, "numeric doses without an explicit unit remain rejected");
assert.equal(compileM04Proposal({
  schemaVersion: "tcm-cdss-reasoning-v2",
  candidate: wrappedProposal.candidate,
  overview: { primarySyndrome: "恶意覆盖" },
}, stable), undefined, "wrong-version full structures cannot use proposal normalization");
assert.equal(compileM04Proposal({ schemaVersion: "tcm-cdss-m04-proposal-v1", candidate: { herbs: [] } }, stable), undefined, "empty proposals remain rejected");
assert.match(m04ProposalIssueCode({ schemaVersion: "tcm-cdss-m04-proposal-v1", candidate: { herbs: [] } }) || "", /candidate_/);
const invalidNodeModificationProposal = compileM04Proposal({
  ...wrappedProposal,
  modifications: [{ trigger: "症状变化时", targetRef: "P9", actionType: "add", herbName: "茯神", reason: "宁心安神" }],
}, stable);
assert.ok(invalidNodeModificationProposal, "an invalid optional modification must not invalidate the core prescription");
assert.deepEqual(invalidNodeModificationProposal?.formula?.modifications, [], "optional modifications may only reference a governed M03 pathogenesis node");
const incompleteMedicineProposal = compileM04Proposal({
  ...wrappedProposal,
  patentAndWestern: [{
    type: "西药", name: "某药", specification: "10mg", singleDose: "10mg", frequency: "每日1次",
    route: "", usageBoundary: "符合适应证时", course: "5日", positioning: "短期对症",
    correspondingProblem: "失眠", evidenceSource: "[EVID-INST-001] 药品说明书", relationship: "替代",
    riskNote: "复核禁忌",
  }],
}, stable);
assert.deepEqual(incompleteMedicineProposal?.formula?.patentAndWestern, [], "incomplete western or patent medicine regimens must not reach the visible candidate list");
const invalidPositioningMedicineProposal = compileM04Proposal({
  ...wrappedProposal,
  patentAndWestern: [{
    type: "中成药", name: "某中成药", specification: "每袋6g", singleDose: "6g", frequency: "每日2次",
    route: "口服", usageBoundary: "符合适应证时", course: "5日", positioning: "辅助治疗",
    correspondingProblem: "疼痛", evidenceSource: "[EVID-INST-001] 药品说明书", relationship: "替代",
    riskNote: "复核禁忌",
  }],
}, stable);
assert.ok(invalidPositioningMedicineProposal, "one invalid optional medicine must not discard the validated herbal candidate");
assert.deepEqual(invalidPositioningMedicineProposal?.formula?.patentAndWestern, [], "contract-invalid optional medicine items are dropped individually");

console.log(JSON.stringify({ cases: 307, failures: 0 }));
