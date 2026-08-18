import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { canonicalTcmHerbIdentity, describeM03WesternSupportConflict, highImpactHerbDirectionIssue, isCompleteM04Reasoning, isM04TherapyMatchAligned, isStableM03Reasoning, isUnstableM03CoreText, isWesternSupportingFactPolarityAligned, m03ChainNodeDiagnostics, m03DoseLevelInstructionFindings, m03SafetyContractIssue, m03SemanticIssue, m03WesternClinicalRationaleIssue, m04GenerationSpecialPopulationIssue, m04SemanticIssue, patientFactSourceQuote, uncoveredPrimaryTherapyDirections, priorDocumentedFactConcepts, stableM03SyndromeLabel, transparentFormulaTherapyIssue } = await import("../src/lib/diagnosis-stage-contract.ts");
const { getM03TherapyLock } = await import("../src/lib/m03-therapy-lock.ts");
const { advanceM04RepairState, canAcceptTransparentFormulaFallback, initialM04RepairState } = await import("../src/lib/m04-repair-policy.ts");
const { editedPrescriptionSemanticIssue } = await import("../src/lib/prescription-revision.ts");
const { decoctionRuleSatisfied, requiredDecoctionRequirement } = await import("../src/lib/herb-decoction-rules.ts");
const { alignNormalizedM03TcmDiagnosticRationale, alignNormalizedM03WesternClinicalRationale, applyDeterministicCandidateTherapyMatch, applyDeterministicDecoctionMethod, applyDeterministicFollowUpNode, applyDeterministicFormulaAnalysis, applyDeterministicHerbDecoctionRequirements, applyDeterministicHerbFunctions, applyDeterministicHerbPrescriptionRoles, applyDeterministicHerbTargets, applyM03AdvisoryQualityBoundaries, applyM03ProjectionOnlyReviewRepair, declassifyAmbiguousM03WesternPrimary, declassifyUnmetFormalM03WesternPrimary, declassifyUnsupportedM03WesternPrimary, groundStructuredPatientFacts, normalizeDiagnoseConfidenceAndLabels, normalizeM03PathogenesisSummaryProjection, normalizeM03TcmRationaleEvidenceBoundary, normalizeM03WesternDifferentials, sanitizeOptionalPathogenesisClassifications, synchronizeVisibleClinicalSummary } = await import("../src/lib/diagnosis-visible-summary.ts");
const { buildTcmHerbPairAdvisory, buildTcmKnowledgeContext, findTcmHerbPairIncompatibilities, getTcmHerbDoseLimit, getTcmHerbFunctionText, getTcmHerbGenerationSafetyProfile, isKnownTcmHerbName } = await import("../src/lib/tcm-knowledge.ts");
const { enrichReasoning } = await import("../src/lib/tcm-formula-provenance.ts");
const { buildPrescribePrompt } = await import("../src/lib/diagnosis-prompts.ts");
const { normalizeModelNullableText, normalizePrescriptionRole } = await import("../src/lib/diagnosis-types.ts");
const { compileM04JsonObjectContent, compileM04Proposal, m04ProposalIssueCode } = await import("../src/lib/m04-proposal-compiler.ts");
const { sanitizeDiagnoseStreamingDraft } = await import("../src/lib/diagnosis-stream-safety.ts");
const { buildM04ClinicalReviewPayload, buildM04ClinicalReviewPrompt, canRebindM04ClinicalReview, m04ClinicalReviewSemanticHash, parseM04ClinicalReview } = await import("../src/lib/m04-clinical-review.ts");
const { applyActionableFollowupSafetyNetContract, isActionableFollowupSafetyNet } = await import("../src/lib/followup-safety-net.ts");
const { sanitizeUngroundedRedFlagNegations } = await import("../src/lib/diagnosis-safety.ts");
const { rejectionTier } = await import("../src/lib/diagnosis-rejection-tiers.ts");

// 2026-08-11：大黄补入受治理 oneOf 煎法（审方原话「应先煎、后下或冲服」）。此前本地只有
// 否定式约束「禁止久煎」，出方时一个字都标不出来，只能等审方回头提——M05「可预防问题」的最后一条。
// oneOf 保留了用途相关性（取泻下须后下、欲缓下可同煎），不替医师做单值选择；
// 「禁止久煎」这条否定约束一字未动，仍然独立生效。
assert.equal(requiredDecoctionRequirement("大黄"), "后下或先煎或冲服、禁止久煎");
assert.equal(decoctionRuleSatisfied("大黄", "久煎"), false);
assert.equal(decoctionRuleSatisfied("大黄", "后下"), true);
assert.equal(decoctionRuleSatisfied("大黄", "冲服"), true);
// 只写否定约束、不给任何投料时机 ⇒ 未标注，由 applyDeterministicHerbDecoctionRequirements 补齐。
assert.equal(decoctionRuleSatisfied("大黄", "不宜久煎"), false);
assert.equal(decoctionRuleSatisfied("大黄", "后下；不宜久煎"), true);
assert.equal(decoctionRuleSatisfied("人参", "另煎"), true);
assert.equal(decoctionRuleSatisfied("人参", "另炖"), true);
assert.equal(decoctionRuleSatisfied("人参", "冲服"), false);
assert.equal(stableM03SyndromeLabel("风邪袭肺证，肺气虚尚待进一步辨证"), "风邪袭肺证");
assert.equal(stableM03SyndromeLabel("证候尚待确认"), undefined);
assert.equal(
  isUnstableM03CoreText("头痛如裹、肢体困重、胸闷纳呆，无明显寒热倾向"),
  false,
  "无明显 describes a charted negative discriminator and must not be truncated as 无明/结论不明确",
);
assert.equal(
  isUnstableM03CoreText("当前证候尚未明确"),
  true,
  "an actually unresolved conclusion remains unstable",
);
for (const pathogenesis of [
  "湿邪困阻中焦，清阳不升",
  "湿邪阻遏清阳，蒙蔽清窍",
  "湿困脾胃，清窍不利",
]) {
  assert.deepEqual(
    m03ChainNodeDiagnostics({
      pathogenesis: {
        chain: [{
          patientFact: "头痛如裹",
          syndromeEvidence: "苔白腻脉濡",
          pathogenesis,
          therapyDirection: "健脾祛湿，升清通窍",
        }],
      },
    }),
    [{ patientFactStable: true, syndromeEvidenceStable: true, pathogenesisAnchored: true, therapyAnchored: true }],
    `${pathogenesis} is a governed damp-obstruction pathogenesis rather than an empty chain`,
  );
}
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
  ["莱菔子", /包煎/], ["紫苏子", /包煎/], ["车前子", /包煎/], ["滑石", /包煎/], ["龙骨", /先煎/],
  ["牡蛎", /先煎/], ["龟甲", /先煎/], ["鳖甲", /先煎/], ["鹿茸", /另煎|冲服/],
]) {
  assert.match(requiredDecoctionRequirement(herb) || "", method, `${herb} must keep the method required by the live Lingxi common-herb calibration`);
}
assert.match(requiredDecoctionRequirement("龙骨") || "", /先煎/);
assert.match(getTcmHerbFunctionText("煅龙骨"), /重镇安神药/);
assert.match(getTcmHerbFunctionText("麦冬"), /养阴生津.*润肺清心/);
assert.match(getTcmHerbFunctionText("生地黄"), /清热凉血.*养阴生津/);
assert.match(getTcmHerbFunctionText("柴胡"), /疏肝解郁/, "柴胡's governed pharmacopoeia direction is shared by validation and clinical review");
assert.deepEqual(
  { min: getTcmHerbDoseLimit("生地黄")?.min, max: getTcmHerbDoseLimit("生地黄")?.max },
  { min: 10, max: 15 },
  "生地黄 must use its own pharmacopoeia decoction range, not the fresh-rehmannia 12-30g range in the shared 地黄 row",
);
assert.match(getTcmHerbFunctionText("人参"), /大补元气.*补脾益肺/);
assert.doesNotMatch(getTcmHerbFunctionText("人参"), /痛经|痈肿|驻颜/);
assert.ok(getTcmHerbFunctionText("人参").length <= 100, "doctor-facing herb functions must stay concise");
assert.deepEqual(getTcmHerbDoseLimit("茯神"), { min: 10, max: 15, basis: "茯神为带松根的茯苓部位，用量按茯苓现有知识边界复核", sourceType: "dose" });
assert.deepEqual(getTcmHerbDoseLimit("黄耆"), getTcmHerbDoseLimit("黄芪"), "formula-catalog and modern 黄芪 spellings must share one dose boundary");
assert.equal(canonicalTcmHerbIdentity("黄耆"), canonicalTcmHerbIdentity("黄芪"), "historical spellings share one prescription identity");
assert.equal(canonicalTcmHerbIdentity("元胡"), canonicalTcmHerbIdentity("延胡索"), "knowledge-source parenthetical aliases share one prescription identity");
assert.equal(canonicalTcmHerbIdentity("炙甘草"), "炙甘草", "T9 exact standard names retain their own governed prescription identity");
assert.notEqual(canonicalTcmHerbIdentity("炙甘草"), canonicalTcmHerbIdentity("甘草"), "an independently governed processed drug must not be silently collapsed to its raw-drug identity");
assert.equal(
  patientFactSourceQuote("夜间干咳、咽痒", "感冒好了还一直干咳，嗓子痒\n差不多三周，晚上明显"),
  "感冒好了还一直干咳，嗓子痒",
  "verb-style cough wording must rebind a reordered model fact to the exact chart sentence instead of emptying M03",
);
assert.notEqual(canonicalTcmHerbIdentity("生地黄"), canonicalTcmHerbIdentity("熟地黄"), "independent knowledge rows must not be over-collapsed as processing aliases");
assert.equal(canonicalTcmHerbIdentity("生地黄"), "生地黄", "生地黄 is a governed independent prescription identity, not generic 地黄 processing text");
assert.equal(isKnownTcmHerbName("延胡索"), true, "parenthetical aliases in the knowledge source must resolve to the canonical herb row");
assert.deepEqual({ min: getTcmHerbDoseLimit("延胡索")?.min, max: getTcmHerbDoseLimit("延胡索")?.max }, { min: 3, max: 10 });
assert.equal(isKnownTcmHerbName("元胡"), true);
assert.equal(isKnownTcmHerbName("丹皮"), true);
assert.deepEqual({ min: getTcmHerbDoseLimit("板蓝根")?.min, max: getTcmHerbDoseLimit("板蓝根")?.max }, { min: 15, max: 15 }, "overlapping pharmacopoeia and clinic ranges use their conservative intersection");
assert.deepEqual({ min: getTcmHerbDoseLimit("莱菔子")?.min, max: getTcmHerbDoseLimit("莱菔子")?.max }, { min: 6, max: 10 }, "M04 prevents a predictable downstream institutional-dose warning by intersecting overlapping governed ranges");
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
assert.equal(getTcmHerbGenerationSafetyProfile("朱砂").isToxic, true);
assert.ok(getTcmHerbGenerationSafetyProfile("朱砂").populationRules.some((rule) =>
  rule.population === "肝功能不全" && rule.severity === "HIGH"));
assert.equal(
  m04GenerationSpecialPopulationIssue([{ name: "朱砂" }], "既往史：肝功能不全"),
  "herb_0_special_population_high_risk_hepatic_impairment",
);
assert.equal(m04GenerationSpecialPopulationIssue([{ name: "朱砂" }], "既往史：否认肝功能不全"), undefined);
const prescribePrompt = buildPrescribePrompt({ patient: {}, chiefComplaint: "失眠", conversation: [] });
assert.match(prescribePrompt, /"modifications"/, "M04 proposal must expose the bounded IF-THEN modification channel");
assert.match(prescribePrompt, /targetRef.*P1/, "every modification must reference an M03 pathogenesis node");
assert.doesNotMatch(prescribePrompt, /## 加减方案/);
assert.match(prescribePrompt, /tcm-cdss-m04-proposal-v1/);
assert.match(prescribePrompt, /模型只提交需要临床生成的最小提案/);
assert.match(
  prescribePrompt,
  /decoction 必须是单个对象.*doseCount.*dosesPerDay.*administrationTimesPerDay.*不得省略/s,
  "M04 generator receives all three controlled regimen dimensions before any repair",
);
assert.match(prescribePrompt, /恰有 1–2 味君药[\s\S]*targetRef=P1/, "M04 generation defines emperor cardinality and binds every emperor to P1 before any repair");
const stable = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "不寐",
    primarySyndrome: "心肝血虚证",
    // 需求3：辨病与辨证各自给出推理。辨病回答「为什么归入不寐」，辨证回答「为什么是心肝血虚」。
    tcmDiseaseRationale: "以入睡困难与睡眠维持障碍为主症、病程逾月且非情志抑郁为主导，故归入不寐范畴，与郁病、心悸相区分。",
    tcmDiagnosticRationale: "入睡困难结合舌淡脉细，支持心肝血虚、心神失养的工作判断。",
    tcmDifferentials: [],
    // 病名级鉴别（2026-08-04 起为 T2 不变式）：签名病名在受治理病名词表中存在相邻病名时必须给出。
    // 不寐病 A04.01.13 的相邻病名按编码邻近度取到的是神劳病/多寐病/百合病这一簇。
    tcmDiseaseDifferentials: [
      { diseaseName: "多寐病", reason: "同属睡眠病症但方向相反，需先分辨主症", distinguishingPoints: "本例为入睡困难与睡眠维持障碍，非日间嗜睡", nextCheck: null },
    ],
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
      clinicalRationale: "持续入睡困难支持失眠症状方向，但日间功能受损尚未核实，暂不升级为确定诊断。",
      limitations: ["尚需结合日间功能受损情况"],
      suggestedChecks: [],
      evidence: { evidenceLevel: "model_inference", source: "基于本例已提供病史", confidence: "中" },
    },
    differentials: [],
  },
  pathogenesis: {
    locationDifferentiation: { items: ["心", "肝"], resolution: "bounded", resolutionReason: "病位由当前证候和病机链归纳" },
    chain: [{ nodeId: "P1", patientFact: "入睡困难", syndromeEvidence: "舌淡脉细", pathogenesis: "心血不足", therapyDirection: "养血安神", pathogenesisType: "主因", biaoBen: "本虚" }],
  },
  therapy: {
    overallPrinciple: "扶正祛邪",
    overallMethod: "养血安神，疏肝解郁",
    // 总治法里的每个治法方向都必须有病例绑定（分治方向或病机节点治法方向）。
    // 疏肝解郁此前只出现在 overallMethod，正是 therapy_method_direction_unbound 要拦的形态。
    subTherapies: [
      { therapy: "养血安神", targetPathogenesis: "心血不足", priority: "主要" },
      { therapy: "疏肝解郁", targetPathogenesis: "肝血不足，疏泄不利", priority: "次要" },
    ],
  },
  management: { followupSafetyNet: "若失眠持续两周无改善或明显加重，请及时复诊" },
};

assert.equal(isStableM03Reasoning(stable), true);
assert.equal(m03SemanticIssue({
  ...stable,
  management: { followupSafetyNet: "病历已记录头痛阳性。" },
}), "followup_safety_net_not_actionable", "a symptom restatement is not an actionable follow-up safety net");
assert.equal(m03SemanticIssue({
  ...stable,
  management: { followupSafetyNet: "若症状持续不缓解或明显加重，请及时复诊；突发意识改变时立即急诊评估。" },
}), undefined, "a trigger plus a concrete care action satisfies the follow-up safety-net contract");
const westernTcmPollution = structuredClone(stable);
westernTcmPollution.westernDiagnosis.primary.name = "慢性咳嗽（痰湿型）";
assert.equal(m03SemanticIssue(westernTcmPollution), "western_primary_tcm_pollution", "Western labels must never carry a TCM pattern suffix");
const missingWesternRationale = structuredClone(stable);
missingWesternRationale.westernDiagnosis.primary.clinicalRationale = "入睡困难";
assert.equal(m03SemanticIssue(missingWesternRationale), "western_clinical_rationale_missing", "a fact restatement is not diagnostic reasoning");
const weakWesternDifferential = structuredClone(stable);
weakWesternDifferential.westernDiagnosis.differentials = [{ name: "焦虑相关睡眠障碍", reason: "压力大", nextCheck: "核实情绪" }];
assert.equal(m03SemanticIssue(weakWesternDifferential), "western_differential_analysis_missing", "a Western differential needs an actual distinguishing point");
const ambiguousWesternDifferential = structuredClone(stable);
ambiguousWesternDifferential.westernDiagnosis.differentials = [{
  name: "良性阵发性位置性眩晕或前庭性偏头痛",
  reason: "头晕需鉴别前庭来源",
  distinguishingPoints: "发作时长、位置诱发与偏头痛特征不同",
  nextCheck: "分别核实位置诱发和偏头痛伴随症状",
}];
assert.equal(
  m03SemanticIssue(ambiguousWesternDifferential),
  "western_differential_ambiguous",
  "multiple diseases must be split into separate differential rows instead of being joined with 或",
);
const missingTcmDifferential = structuredClone(stable);
missingTcmDifferential.overview.primarySyndromeResolution = "resolved";
missingTcmDifferential.overview.primarySyndromeBasis = ["入睡困难", "舌淡脉细"];
assert.equal(m03SemanticIssue(missingTcmDifferential), "discrimination_missing", "a resolved multi-fact TCM pattern must expose a TCM differential");
const testDependentTcmRationale = structuredClone(stable);
testDependentTcmRationale.overview.tcmDiagnosticRationale = "结合当前症状考虑心肝血虚，但缺乏MRI检查因此无法辨证。";
assert.equal(m03SemanticIssue(testDependentTcmRationale), "tcm_reasoning_diagnostic_dependency", "missing modern tests cannot be used as the reason TCM differentiation fails");
const legitimateModernDifferentialBoundary = structuredClone(stable);
legitimateModernDifferentialBoundary.overview.tcmDifferentials = [{
  syndrome: "肝郁化火证",
  reason: "同可见入睡困难，需要结合寒热和情志特征鉴别",
  distinguishingPoints: "本例舌淡脉细而无口苦急躁，更支持血虚",
  nextCheck: "尚无头颅MRI，必要时完善影像以排除继发性头痛；中医证候仍以当前四诊为据",
}];
assert.notEqual(
  m03SemanticIssue(legitimateModernDifferentialBoundary),
  "tcm_reasoning_diagnostic_dependency",
  "a missing modern examination used only as a Western differential boundary must not invalidate a stable TCM result",
);
// TCM-native reasoning connectors (辨为/合参/病机/归纳/综合) must satisfy the rationale pre-filter —
// a textbook derivation like "四诊合参…病机为…辨为…证" is real reasoning, not a missing rationale.
// Anti-restatement stays enforced downstream, so widening the connector cannot pass a bare name.
const tcmNativeConnectorRationale = structuredClone(stable);
tcmNativeConnectorRationale.overview.tcmDiagnosticRationale = "四诊合参，入睡困难、心悸健忘、纳差便溏、面色少华、脉细弱，病机为脾虚失运、心血不足，辨为心脾两虚证。";
assert.notEqual(m03SemanticIssue(tcmNativeConnectorRationale), "tcm_diagnostic_rationale_missing", "TCM-native reasoning verbs must satisfy the rationale connector pre-filter");
const bareSyndromeNameRationale = structuredClone(stable);
bareSyndromeNameRationale.overview.tcmDiagnosticRationale = "辨为心脾两虚证。";
assert.equal(m03SemanticIssue(bareSyndromeNameRationale), "tcm_diagnostic_rationale_restatement", "a bare syndrome-name rationale with a connector is still caught as restatement downstream");
// 需求3：诊断分三段，各自给出推理——西医诊断（含 ICD-10 关联）、中医辨病、中医辨证。
// 辨病与辨证此前共用 tcmDiagnosticRationale 一个字段，病名归属的理由被证型推理挤掉：
// 医生看到「不寐」却读不到为什么把这组表现归入不寐而不是郁病或心悸。
{
  const missingDiseaseRationale = structuredClone(stable);
  delete missingDiseaseRationale.overview.tcmDiseaseRationale;
  assert.equal(
    m03SemanticIssue(missingDiseaseRationale),
    "tcm_disease_rationale_missing",
    "有中医病名就必须给出辨病推理——它与辨证是两个判断",
  );
  assert.equal(
    rejectionTier("m03_tcm_disease_rationale_missing"),
    "T2",
    "缺一段辨病推理不影响辨证结论可用性，应带批注受理而不是驳回整份 M03",
  );
  // 只有症状层工作病名、尚未形成传统病名时不强求（tcmDiseaseName 为空即不校验）。
  const symptomLevelDisease = structuredClone(stable);
  symptomLevelDisease.overview.tcmDiseaseName = "";
  delete symptomLevelDisease.overview.tcmDiseaseRationale;
  assert.notEqual(
    m03SemanticIssue(symptomLevelDisease),
    "tcm_disease_rationale_missing",
    "没有形成中医病名时不要求辨病推理",
  );
  // 提示词侧的分工断言放在 test-diagnosis-display-consistency.mjs——那里已有构造好的 M03 提示词夹具。
}
const mechanismAsNature = structuredClone(stable);
mechanismAsNature.pathogenesis.natureDifferentiation = { items: ["胃失和降"], evidence: { evidenceLevel: "model_inference", source: "本例四诊资料", confidence: "中" } };
assert.equal(m03SemanticIssue(mechanismAsNature), "nature_item_is_mechanism", "disease nature and mechanism must not be conflated");
const concreteMethodAsPrinciple = structuredClone(stable);
concreteMethodAsPrinciple.therapy = { overallPrinciple: "疏肝清热，安神和胃", overallMethod: "疏肝清热，安神和胃", subTherapies: [] };
assert.equal(m03SemanticIssue(concreteMethodAsPrinciple), "therapy_principle_invalid", "a concrete method cannot occupy the treatment-principle field");
const validPrincipleAndMethod = structuredClone(stable);
validPrincipleAndMethod.therapy = {
  overallPrinciple: "因人制宜，扶正祛邪",
  overallMethod: "养血安神，疏肝解郁",
  subTherapies: [
    { therapy: "养血安神", targetPathogenesis: "心血不足", priority: "主要" },
    { therapy: "疏肝解郁", targetPathogenesis: "肝血不足，疏泄不利", priority: "次要" },
  ],
};
assert.equal(m03SemanticIssue(validPrincipleAndMethod), undefined, "a treatment principle and its concrete method remain distinct");
const singleNodeSingleMethod = structuredClone(stable);
singleNodeSingleMethod.therapy = {
  overallPrinciple: "扶正祛邪",
  overallMethod: "养血安神",
  subTherapies: [{ therapy: "养血安神", targetPathogenesis: "心血不足", priority: "主要" }],
};
assert.equal(m03SemanticIssue(singleNodeSingleMethod), undefined, "a single-node plan may use its sole therapy as the complete overall method");
const mismatchedRootManifestationPrinciple = structuredClone(singleNodeSingleMethod);
mismatchedRootManifestationPrinciple.therapy.overallPrinciple = "标本兼治";
assert.equal(
  m03SemanticIssue(mismatchedRootManifestationPrinciple),
  "treatment_principle_target_mismatch",
  "标本兼治 must be rejected unless sub-therapies cover distinct root and manifestation targets",
);
const restatedOverallPathogenesis = structuredClone(stable);
restatedOverallPathogenesis.overview.overallPathogenesis = "入睡困难";
assert.equal(
  m03SemanticIssue(restatedOverallPathogenesis),
  "overall_pathogenesis_restates_facts",
  "overall pathogenesis must add a mechanism instead of copying a chart fact",
);
const duplicatedPathogenesisNodes = structuredClone(stable);
duplicatedPathogenesisNodes.pathogenesis.chain.push({
  nodeId: "P2",
  patientFact: "舌淡脉细",
  syndromeEvidence: "舌淡脉细",
  pathogenesis: "心血不足",
  therapyDirection: "疏肝解郁",
  pathogenesisType: "兼夹",
});
duplicatedPathogenesisNodes.therapy.subTherapies.push({
  therapy: "疏肝解郁",
  targetPathogenesis: "肝血不足",
  priority: "兼顾",
});
assert.equal(
  m03SemanticIssue(duplicatedPathogenesisNodes),
  "pathogenesis_nodes_duplicated",
  "different M03 nodes must not repeat one pathogenesis sentence",
);
const duplicatedTherapyDirections = structuredClone(duplicatedPathogenesisNodes);
duplicatedTherapyDirections.pathogenesis.chain[1].pathogenesis = "肝血不足";
duplicatedTherapyDirections.pathogenesis.chain[1].therapyDirection = "养血安神";
assert.equal(
  m03SemanticIssue(duplicatedTherapyDirections),
  "pathogenesis_therapy_directions_duplicated",
  "different M03 nodes must not repeat one therapy direction",
);
const validTermsBeyondComponentTaxonomy = structuredClone(stable);
validTermsBeyondComponentTaxonomy.pathogenesis.locationDifferentiation = {
  items: ["咽喉"],
  details: [],
  resolution: "bounded",
  resolutionReason: "咽部不适提示咽喉病位",
};
validTermsBeyondComponentTaxonomy.pathogenesis.natureDifferentiation = {
  items: ["寒湿"],
  rootDeficiency: [],
  branchExcess: ["寒湿"],
  basis: "遇冷加重，苔白腻",
  resolution: "bounded",
  resolutionReason: "寒湿为当前工作归纳",
};
assert.equal(m03SemanticIssue(validTermsBeyondComponentTaxonomy), undefined, "T2/T3 component-table misses remain reviewable instead of collapsing the full M03 result");
const multiNodeUndecomposedMethod = structuredClone(stable);
multiNodeUndecomposedMethod.pathogenesis.chain.push({
  nodeId: "P2",
  patientFact: "情志不畅",
  syndromeEvidence: "脉弦",
  pathogenesis: "肝气郁结",
  therapyDirection: "疏肝解郁",
  pathogenesisType: "兼夹",
  biaoBen: "标实",
});
multiNodeUndecomposedMethod.therapy = {
  overallPrinciple: "扶正祛邪",
  overallMethod: "养血安神，疏肝解郁",
  subTherapies: [
    { therapy: "养血安神，疏肝解郁", targetPathogenesis: "心血不足", priority: "主要" },
    { therapy: "疏肝解郁", targetPathogenesis: "肝气郁结", priority: "兼顾" },
  ],
};
assert.equal(m03SemanticIssue(multiNodeUndecomposedMethod), "sub_therapy_repeats_overall_method", "a multi-node plan must decompose its combined overall method into distinct sub-therapies");
const missingFollowupContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ ...stable, management: null })}\n<!-- DIAGNOSIS_JSON_END -->`;
const completedFollowupContent = applyActionableFollowupSafetyNetContract(missingFollowupContent);
const completedFollowupReasoning = JSON.parse(completedFollowupContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(isActionableFollowupSafetyNet(completedFollowupReasoning.management.followupSafetyNet), true, "the server supplies a bounded actionable safety net before review");
assert.equal(applyActionableFollowupSafetyNetContract(completedFollowupContent), completedFollowupContent, "the server-owned safety-net normalization is byte-idempotent");
for (const name of ["功能性/感染性肠炎恢复期", "功能性腹泻或感染性腹泻", "胃炎、胃食管反流病待鉴别", "劳力性呼吸困难待查：睡眠呼吸障碍？心功能不全？", "劳力性呼吸困难待查：睡眠呼吸障碍可能", "喘息症状（支气管哮喘可能）"]) {
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
const ambiguousRespiratoryReasoning = structuredClone(stable);
ambiguousRespiratoryReasoning.westernDiagnosis.primary.name = "劳力性呼吸困难待查：睡眠呼吸障碍？心功能不全？";
ambiguousRespiratoryReasoning.westernDiagnosis.primary.supportingFacts = ["一跑快了就胸口呼呼响，晚上有时憋醒"];
const ambiguousRespiratoryContext = "主诉：一跑快了就胸口呼呼响，晚上有时憋醒\n现病史：近一个月发作3次";
const declassifiedAmbiguousRespiratoryContent = declassifyAmbiguousM03WesternPrimary(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(ambiguousRespiratoryReasoning)}\n<!-- DIAGNOSIS_JSON_END -->`,
  ambiguousRespiratoryContext,
);
const declassifiedAmbiguousRespiratory = JSON.parse(declassifiedAmbiguousRespiratoryContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(declassifiedAmbiguousRespiratory.westernDiagnosis.primary.name, "喘息症状", "a multi-diagnosis respiratory primary is deterministically collapsed to the chart-grounded symptom level");
assert.equal(declassifiedAmbiguousRespiratory.westernDiagnosis.primary.status, "证据有限");
assert.ok(declassifiedAmbiguousRespiratory.westernDiagnosis.differentials.some((item) => item.name.includes("睡眠呼吸障碍")), "the original alternatives remain visible for independent review");
assert.equal(declassifyAmbiguousM03WesternPrimary(declassifiedAmbiguousRespiratoryContent, ambiguousRespiratoryContext), declassifiedAmbiguousRespiratoryContent, "ambiguous-primary declassification is byte-idempotent");
const impreciseRespiratorySymptom = structuredClone(declassifiedAmbiguousRespiratory);
impreciseRespiratorySymptom.westernDiagnosis.primary.name = "劳力性呼吸困难待查";
const normalizedWheezeContent = normalizeDiagnoseConfidenceAndLabels(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(impreciseRespiratorySymptom)}\n<!-- DIAGNOSIS_JSON_END -->`,
  ambiguousRespiratoryContext,
);
const normalizedWheeze = JSON.parse(normalizedWheezeContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(normalizedWheeze.westernDiagnosis.primary.name, "喘息症状", "charted wheeze cannot be relabelled as dyspnea merely because both share a respiratory differential");
assert.equal(normalizeDiagnoseConfidenceAndLabels(normalizedWheezeContent, ambiguousRespiratoryContext), normalizedWheezeContent, "dominant-symptom normalization is byte-idempotent");
const documentedDyspnea = structuredClone(impreciseRespiratorySymptom);
const documentedDyspneaContent = normalizeDiagnoseConfidenceAndLabels(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(documentedDyspnea)}\n<!-- DIAGNOSIS_JSON_END -->`,
  "主诉：快走后气短，感觉气不够用",
);
assert.match(documentedDyspneaContent, /"name": "气短症状"/, "documented dyspnea retains the governed dyspnea symptom category");
for (const constipationComplaint of [
  "大便老解不出来，四五天一次，肚子还胀",
  "排便很费劲，三四天才解一次，伴有腹胀",
  "好几天不上厕所，便干成颗粒，肚子胀",
  "大便排不出来已经五天，腹部发胀",
]) {
  const misplacedSecondarySymptom = structuredClone(impreciseRespiratorySymptom);
  misplacedSecondarySymptom.westernDiagnosis.primary.name = "腹胀症状";
  const normalizedConstipationContent = normalizeDiagnoseConfidenceAndLabels(
    `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(misplacedSecondarySymptom)}\n<!-- DIAGNOSIS_JSON_END -->`,
    `主诉：${constipationComplaint}`,
  );
  assert.match(normalizedConstipationContent, /"name": "便秘症状"/, `${constipationComplaint} keeps constipation, not secondary bloating, as the symptom-level primary`);
  assert.equal(normalizeDiagnoseConfidenceAndLabels(normalizedConstipationContent, `主诉：${constipationComplaint}`), normalizedConstipationContent);
}
const respiratoryDiseaseLabel = structuredClone(impreciseRespiratorySymptom);
respiratoryDiseaseLabel.westernDiagnosis.primary.name = "支气管哮喘待查";
const respiratoryDiseaseContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(respiratoryDiseaseLabel)}\n<!-- DIAGNOSIS_JSON_END -->`;
assert.equal(normalizeDiagnoseConfidenceAndLabels(respiratoryDiseaseContent, ambiguousRespiratoryContext), respiratoryDiseaseContent, "symptom terminology normalization never rewrites a disease label before formal-criteria review");
const cardiopulmonaryReasoning = structuredClone(declassifiedAmbiguousRespiratory);
cardiopulmonaryReasoning.westernDiagnosis.differentials = [
  { name: "劳力性呼吸困难待查：考虑心源性可能，需排除阻塞性睡眠呼吸暂停", reason: "夜间憋醒需鉴别", nextCheck: "评估心血管危险因素" },
  { name: "阻塞性睡眠呼吸暂停", reason: "睡眠呼吸障碍需鉴别", nextCheck: "完善睡眠监测" },
  { name: "支气管哮喘", reason: "活动后喘鸣需鉴别", nextCheck: "完善肺功能检查" },
];
cardiopulmonaryReasoning.management = { followupSafetyNet: "若静息呼吸困难或胸痛，应立即急诊评估。" };
const missingTcmDisease = structuredClone(cardiopulmonaryReasoning);
delete missingTcmDisease.overview.tcmDiseaseName;
assert.equal(
  m03SemanticIssue(missingTcmDisease, ambiguousRespiratoryContext),
  m03SemanticIssue(cardiopulmonaryReasoning, ambiguousRespiratoryContext),
  "中医病名是可选内部字段；删除它不得改变 M03 合同结果或阻断中医证候与病机展示",
);
const cardiopulmonaryContent = normalizeM03WesternDifferentials(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(cardiopulmonaryReasoning)}\n<!-- DIAGNOSIS_JSON_END -->`,
  ambiguousRespiratoryContext,
);
const cardiopulmonaryProjection = JSON.parse(cardiopulmonaryContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(cardiopulmonaryProjection.westernDiagnosis.differentials.filter((item) => item.name === "阻塞性睡眠呼吸暂停").length, 1, "final M03 normalization merges duplicate differential diagnoses");
assert.match(cardiopulmonaryProjection.westernDiagnosis.differentials.find((item) => item.name === "阻塞性睡眠呼吸暂停").nextCheck, /评估心血管危险因素.*完善睡眠监测/, "semantic de-duplication preserves distinct checks from wrapped and standalone rows");
assert.ok(cardiopulmonaryProjection.westernDiagnosis.differentials.some((item) => item.name === "心功能不全"), "exertional plus nocturnal breathlessness keeps heart failure in the differential");
assert.ok(cardiopulmonaryProjection.westernDiagnosis.differentials.some((item) => item.name === "冠心病"), "exertional plus nocturnal breathlessness keeps coronary disease in the differential");
assert.match(cardiopulmonaryProjection.management.followupSafetyNet, /劳力性呼吸不适或夜间憋醒持续、加重时，应尽快复诊排除心功能不全等心源性原因/);
assert.match(cardiopulmonaryProjection.management.followupSafetyNet, /不能平卧.*立即急诊评估/);
assert.equal(normalizeM03WesternDifferentials(cardiopulmonaryContent, ambiguousRespiratoryContext), cardiopulmonaryContent, "cardiopulmonary differential and safety-net normalization is byte-idempotent");
const projectionOnlyCandidate = structuredClone(cardiopulmonaryProjection);
projectionOnlyCandidate.pathogenesis.summary = "肺气不利，痰湿阻肺";
projectionOnlyCandidate.pathogenesis.locationDifferentiation = {
  items: ["肺"],
  details: [{ location: "肺", basis: "一跑快了就胸口呼呼响" }],
  resolution: "bounded",
  resolutionReason: "有限资料下的病位归纳",
  evidence: { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" },
};
const projectionOnlyContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(projectionOnlyCandidate)}\n<!-- DIAGNOSIS_JSON_END -->`;
const unlabeledRespiratoryHistoryCandidate = structuredClone(projectionOnlyCandidate);
unlabeledRespiratoryHistoryCandidate.westernDiagnosis.primary.supportingFacts = ["抽烟好多年，早上老咳一口白痰"];
const unlabeledRespiratoryHistoryContent = groundStructuredPatientFacts(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(unlabeledRespiratoryHistoryCandidate)}\n<!-- DIAGNOSIS_JSON_END -->`,
  "抽烟好多年，早上老咳一口白痰\n这半年比以前多一点，走两层楼会喘。",
);
const unlabeledRespiratoryHistory = JSON.parse(unlabeledRespiratoryHistoryContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.ok(unlabeledRespiratoryHistory.westernDiagnosis.primary.supportingFacts.some((fact) => /走两层楼会喘/.test(fact)), "an unlabeled current-history sentence remains available to western diagnosis and risk review");
assert.ok(unlabeledRespiratoryHistory.westernDiagnosis.primary.supportingFacts.every((fact) => !/舌|脉/.test(fact)), "unlabeled TCM observations never become western supporting facts");
for (const driftedSummary of [
  "肺气不利，兼见气血不足",
  "肺气不利，痰湿与瘀血互结",
  "肺气不利，阴虚内热",
]) {
  const drifted = structuredClone(projectionOnlyCandidate);
  drifted.pathogenesis.summary = driftedSummary;
  const driftedContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(drifted)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const normalizedContent = normalizeM03PathogenesisSummaryProjection(driftedContent);
  const normalizedReasoning = JSON.parse(normalizedContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  assert.equal(normalizedReasoning.pathogenesis.summary, normalizedReasoning.pathogenesis.chain.map((node) => node.pathogenesis).join("；"), "all duplicate-summary disease-nature drift is projected from the grounded chain before validation");
  assert.equal(normalizeM03PathogenesisSummaryProjection(normalizedContent), normalizedContent, "summary projection is byte-idempotent");
}
const projectionWithoutCore = structuredClone(projectionOnlyCandidate);
projectionWithoutCore.overview.overallPathogenesis = "";
const projectionWithoutCoreContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(projectionWithoutCore)}\n<!-- DIAGNOSIS_JSON_END -->`;
assert.equal(normalizeM03PathogenesisSummaryProjection(projectionWithoutCoreContent), projectionWithoutCoreContent, "a missing authoritative core is never synthesized from the duplicate summary");
const repairedProjectionContent = applyM03ProjectionOnlyReviewRepair(projectionOnlyContent, ["pathogenesis_summary_drift", "location_unsupported"]);
const repairedProjection = JSON.parse(repairedProjectionContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(repairedProjection.pathogenesis.summary, repairedProjection.pathogenesis.chain.map((node) => node.pathogenesis).join("；"), "summary-only drift is reduced to already-established grounded chain conclusions");
assert.deepEqual(repairedProjection.pathogenesis.locationDifferentiation.items, [], "unsupported optional location is declassified instead of regenerating the whole diagnosis");
assert.equal(repairedProjection.pathogenesis.locationDifferentiation.resolution, "unresolved");
assert.equal(applyM03ProjectionOnlyReviewRepair(repairedProjectionContent, ["pathogenesis_summary_drift", "location_unsupported"]), repairedProjectionContent, "projection-only repair is byte-idempotent");
assert.equal(applyM03ProjectionOnlyReviewRepair(projectionOnlyContent, ["pathogenesis_summary_drift", "chain_not_closed"]), projectionOnlyContent, "any non-projection issue stays on the model repair or fail-closed path");
const genericExamGapCandidate = structuredClone(projectionOnlyCandidate);
genericExamGapCandidate.overview.tcmDiagnosticRationale = "尚无腹部触诊，因此中医辨证依据不足。";
genericExamGapCandidate.overview.primarySyndromeResolution = "bounded";
genericExamGapCandidate.overview.primarySyndromeResolutionReason = "缺少腹诊，需进一步确认。";
genericExamGapCandidate.pathogenesis.locationDifferentiation.resolutionReason = "未做腹部触诊，病位待定。";
genericExamGapCandidate.pathogenesis.natureDifferentiation ||= { items: [], rootDeficiency: [], branchExcess: [], resolution: "unresolved" };
genericExamGapCandidate.pathogenesis.natureDifferentiation.resolutionReason = "缺乏实验室检查，病性待定。";
const genericExamGapContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(genericExamGapCandidate)}\n<!-- DIAGNOSIS_JSON_END -->`;
const boundedExamGapContent = normalizeM03TcmRationaleEvidenceBoundary(genericExamGapContent);
const boundedExamGapReasoning = JSON.parse(boundedExamGapContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.doesNotMatch(JSON.stringify({
  rationale: boundedExamGapReasoning.overview.tcmDiagnosticRationale,
  syndromeReason: boundedExamGapReasoning.overview.primarySyndromeResolutionReason,
  locationReason: boundedExamGapReasoning.pathogenesis.locationDifferentiation.resolutionReason,
  natureReason: boundedExamGapReasoning.pathogenesis.natureDifferentiation.resolutionReason,
}), /腹诊|腹部触诊|实验室检查/, "generic exam and modern-test gaps never become the stated basis of TCM reasoning");
assert.match(boundedExamGapReasoning.overview.tcmDiagnosticRationale, /结合.*中医工作病名考虑.*主证候倾向/);
assert.equal(normalizeM03TcmRationaleEvidenceBoundary(boundedExamGapContent), boundedExamGapContent, "TCM rationale evidence-boundary normalization is byte-idempotent");
const duplicateDifferentialContract = structuredClone(cardiopulmonaryReasoning);
assert.equal(m03SemanticIssue(duplicateDifferentialContract, ambiguousRespiratoryContext), "western_differential_duplicate", "the final M03 contract rejects semantic duplicate differentials even if a future transform bypasses normalization");
for (const nonTriggerContext of [
  "主诉：晚上偶尔憋醒，活动耐量正常",
  "主诉：活动后气短；否认夜间憋醒、不能平卧及端坐呼吸",
  "主诉：否认活动后气短、胸闷；否认夜间憋醒",
]) {
  const nonTriggerContent = normalizeM03WesternDifferentials(
    `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(cardiopulmonaryReasoning)}\n<!-- DIAGNOSIS_JSON_END -->`,
    nonTriggerContext,
  );
  const nonTriggerProjection = JSON.parse(nonTriggerContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  assert.equal(nonTriggerProjection.westernDiagnosis.differentials.some((item) => item.name === "心功能不全"), false, "one-sided or negated cardiopulmonary clues do not create a heart-failure differential");
  assert.equal(nonTriggerProjection.westernDiagnosis.differentials.some((item) => item.name === "冠心病"), false, "one-sided or negated cardiopulmonary clues do not create a coronary differential");
}
const olderNewConstipation = structuredClone(stable);
olderNewConstipation.westernDiagnosis.primary.name = "功能性便秘";
olderNewConstipation.westernDiagnosis.primary.supportingFacts = ["大便老解不出来，四五天一次，肚子还胀", "最近三个月越来越明显"];
olderNewConstipation.westernDiagnosis.primary.suggestedChecks = ["若年龄>50岁新发便秘，建议结肠镜检查"];
olderNewConstipation.westernDiagnosis.differentials = [];
olderNewConstipation.management = { followupSafetyNet: "若便秘明显加重或出现便血，请及时复诊。" };
const olderNewConstipationContext = "主诉：大便老解不出来，四五天一次，肚子还胀\n现病史：最近三个月越来越明显";
const olderNewConstipationContent = normalizeM03WesternDifferentials(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(olderNewConstipation)}\n<!-- DIAGNOSIS_JSON_END -->`,
  olderNewConstipationContext,
  56,
);
const olderNewConstipationProjection = JSON.parse(olderNewConstipationContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.ok(olderNewConstipationProjection.westernDiagnosis.primary.suggestedChecks.some((item) => /患者年龄为56岁.*消化专科评估.*结肠镜检查/.test(item)), "documented older age plus recent progressive constipation becomes a patient-specific colonoscopy assessment, not a hypothetical age condition");
assert.ok(olderNewConstipationProjection.westernDiagnosis.differentials.some((item) => item.name === "结直肠器质性病变"), "older recent-onset constipation keeps colorectal organic disease in the differential");
assert.match(olderNewConstipationProjection.management.followupSafetyNet, /本例为56岁且近期出现或进行性加重排便习惯改变/);
assert.match(olderNewConstipationProjection.management.followupSafetyNet, /该年龄与病程组合本身即需尽快完成消化专科评估/);
assert.match(olderNewConstipationProjection.management.followupSafetyNet, /便血、消瘦等其他报警征象应另行核实/);
assert.doesNotMatch(olderNewConstipationProjection.management.followupSafetyNet, /暂无便血|暂无消瘦/);
assert.equal(normalizeM03WesternDifferentials(olderNewConstipationContent, olderNewConstipationContext, 56), olderNewConstipationContent, "older new-constipation management normalization is byte-idempotent");
const sanitizedOlderNewConstipationContent = sanitizeUngroundedRedFlagNegations(olderNewConstipationContent, {
  id: "older-new-constipation",
  phase: "diagnose",
  patient: { age: 56, sex: "女" },
  chiefComplaint: "大便老解不出来，四五天一次，肚子还胀",
  symptoms: { presentHistory: "最近三个月越来越明显" },
  completeness: { level: "B", redFlag: 0.8, infoGain: 0.5, managementImpact: 0.5, answerability: 0.6 },
  questionRounds: 1,
  maxQuestionRounds: 1,
  conversation: [],
});
assert.match(sanitizedOlderNewConstipationContent, /该年龄与病程组合本身即需尽快完成消化专科评估/);
assert.equal((sanitizedOlderNewConstipationContent.match(/便血、消瘦等其他报警征象应另行核实/g) || []).length, 1, "the negated-history sanitizer preserves the patient-specific age safety net without duplicating unknown alarm features");
for (const [age, context] of [
  [35, olderNewConstipationContext],
  [56, "主诉：便秘十余年，病情稳定，无近期变化"],
]) {
  const nonTriggerContent = normalizeM03WesternDifferentials(
    `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(olderNewConstipation)}\n<!-- DIAGNOSIS_JSON_END -->`,
    context,
    age,
  );
  const nonTriggerProjection = JSON.parse(nonTriggerContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  assert.equal(nonTriggerProjection.westernDiagnosis.primary.suggestedChecks.some((item) => /患者年龄为/.test(item)), false, "younger or long-stable constipation does not receive the older new-onset management augmentation");
  assert.equal(nonTriggerProjection.westernDiagnosis.differentials.some((item) => item.name === "结直肠器质性病变"), false);
}
for (const [chief, expectedName] of [
  ["这两个月一吃完饭肚子上边就胀，老打嗝", "餐后上腹胀症状"],
  ["最近吃点东西就想跑厕所，大便稀", "腹泻症状"],
]) {
  const digestiveAmbiguous = structuredClone(stable);
  digestiveAmbiguous.westernDiagnosis.primary.name = "功能性消化不良或其他胃肠疾病";
  digestiveAmbiguous.westernDiagnosis.primary.supportingFacts = [chief];
  const content = declassifyAmbiguousM03WesternPrimary(
    `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(digestiveAmbiguous)}\n<!-- DIAGNOSIS_JSON_END -->`,
    `主诉：${chief}`,
  );
  const parsed = JSON.parse(content.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  assert.equal(parsed.westernDiagnosis.primary.name, expectedName, `colloquial digestive complaints normalize to ${expectedName} instead of a sentence plus “症状”`);
}
const diarrheaReasoning = (name, patientFact) => ({
  ...stable,
  overview: {
    ...stable.overview,
    primarySyndromeBasis: [patientFact],
    tcmDiagnosticRationale: `${patientFact}结合脾失健运病机，支持湿邪下注的证候判断。`,
  },
  westernDiagnosis: {
    ...stable.westernDiagnosis,
    primary: {
      ...stable.westernDiagnosis.primary,
      name,
      supportingFacts: [patientFact],
      clinicalRationale: `${patientFact}支持腹泻症状方向，但感染性或药物性病因尚未核实。`,
    },
  },
  pathogenesis: {
    locationDifferentiation: { items: ["脾"], resolution: "bounded", resolutionReason: "病位由当前病机链归纳" },
    chain: [{
      nodeId: "P1",
      patientFact,
      syndromeEvidence: patientFact,
      pathogenesis: "脾失健运，水湿下注",
      therapyDirection: "健脾化湿止泻",
    }],
  },
});
assert.equal(
  m03SemanticIssue(diarrheaReasoning("慢性腹泻（功能性腹泻可能）", "稀便半个月"), "稀便半个月"),
  "western_primary_ambiguous",
  "a disease possibility cannot be hidden inside a symptom-level primary label",
);
assert.equal(
  m03SemanticIssue(diarrheaReasoning("功能性腹泻", "拉肚子两周"), "拉肚子两周"),
  "western_primary_duration_mismatch",
  "Chinese-number duration variants share the same temporal boundary",
);
assert.equal(
  m03SemanticIssue(diarrheaReasoning("腹泻（病因待查）", "稀便半个月"), "稀便半个月"),
  undefined,
  "a symptom-level working diagnosis remains available for the same short course",
);
const shortCourseDiarrheaContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(diarrheaReasoning("功能性腹泻", "最近吃点东西就想跑厕所，稀稀的有半个月"))}\n<!-- DIAGNOSIS_JSON_END -->`;
const shortCourseDiarrheaDeclassified = declassifyUnmetFormalM03WesternPrimary(
  shortCourseDiarrheaContent,
  "主诉：最近吃点东西就想跑厕所，稀稀的有半个月\n现病史：一天大概三四次。",
);
const shortCourseDiarrheaParsed = JSON.parse(shortCourseDiarrheaDeclassified.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(shortCourseDiarrheaParsed.westernDiagnosis.primary.name, "腹泻症状", "short-course diarrhoea is deterministically declassified before repair/review");
assert.equal(shortCourseDiarrheaParsed.westernDiagnosis.primary.confidence, "低");
assert.ok(shortCourseDiarrheaParsed.westernDiagnosis.differentials.some((item) => item.name === "功能性腹泻"), "the over-specific label remains visible as a differential instead of being silently erased");
assert.equal(
  declassifyUnmetFormalM03WesternPrimary(
    `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(diarrheaReasoning("慢性腹泻", "稀便两个月"))}\n<!-- DIAGNOSIS_JSON_END -->`,
    "主诉：稀便两个月",
  ).includes('"name":"慢性腹泻"'),
  true,
  "a qualifying explicit duration is not declassified",
);
const nonstandardWorkingLabelContent = normalizeDiagnoseConfidenceAndLabels(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(diarrheaReasoning("腹泻待因", "稀便半个月"))}\n<!-- DIAGNOSIS_JSON_END -->`,
  "稀便半个月",
);
const normalizedWorkingLabel = JSON.parse(nonstandardWorkingLabelContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(normalizedWorkingLabel.westernDiagnosis.primary.name, "腹泻（病因待查）", "nonstandard terminal 待因 is canonicalized at the Western-label boundary");
assert.equal(
  m03SemanticIssue(diarrheaReasoning("慢性腹泻", "稀便两个月"), "稀便两个月"),
  undefined,
  "the duration guard does not reject a chronic label when a qualifying current course is explicit",
);
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
const sharedDenialTerms = [
  "意识异常", "意识障碍", "抽搐", "咯血", "便血", "呕血",
  "黄疸", "肢体无力", "失语", "紫绀", "颈项强直", "呼吸困难",
];
const sharedDenialContext = `入睡困难；舌淡脉细；无${sharedDenialTerms.join("、")}`;
for (const term of sharedDenialTerms) {
  const western = structuredClone(stable);
  western.westernDiagnosis.primary.supportingFacts = [term];
  assert.equal(
    m03SemanticIssue(western, sharedDenialContext),
    "western_support_polarity_mismatch",
    `共享否定枚举中的 ${term} 不得进入 western supportingFacts 阳性依据`,
  );

  const syndromeBasis = structuredClone(stable);
  syndromeBasis.overview.primarySyndromeBasis = [term];
  assert.equal(
    m03SemanticIssue(syndromeBasis, sharedDenialContext),
    "primary_syndrome_basis_polarity",
    `共享否定枚举中的 ${term} 不得进入 primarySyndromeBasis 阳性依据`,
  );

  const symptomCluster = structuredClone(stable);
  symptomCluster.pathogenesis.symptomClusters = [{ symptoms: [term], mechanism: "心神失养" }];
  assert.equal(
    m03SemanticIssue(symptomCluster, sharedDenialContext),
    "symptom_cluster_polarity",
    `共享否定枚举中的 ${term} 不得进入 symptomClusters 阳性依据`,
  );

  const chain = structuredClone(stable);
  chain.pathogenesis.chain[0].patientFact = term;
  assert.match(
    m03SemanticIssue(chain, sharedDenialContext) || "",
    /^patient_fact_ungrounded_0_0_polarity$/,
    `共享否定枚举中的 ${term} 不得进入病机链 patientFact 阳性依据`,
  );
}
const intensifiedCough = structuredClone(stable);
intensifiedCough.westernDiagnosis.primary.supportingFacts = ["咳嗽剧烈"];
intensifiedCough.westernDiagnosis.primary.clinicalRationale =
  "咳嗽剧烈及3天病程支持急性咳嗽症状方向，但尚缺病原学信息，因此暂不采用具体病因标签。";
assert.equal(
  m03SemanticIssue(intensifiedCough, "入睡困难；咳嗽声重3天；舌淡脉细"),
  "clinical_wording_intensity_mismatch",
  "医生可见分析不得把病历的咳嗽声重升级成咳嗽剧烈",
);
const objectiveFeverDrift = structuredClone(stable);
objectiveFeverDrift.westernDiagnosis.primary.supportingFacts = ["恶寒发热"];
objectiveFeverDrift.westernDiagnosis.primary.clinicalRationale =
  "病历已记录发热并有3天病程，支持急性感染性症状方向，但尚缺病原学信息，因此暂不采用具体病因标签。";
assert.equal(
  m03SemanticIssue(objectiveFeverDrift, "入睡困难；自诉恶寒发热；体温37℃；舌淡脉细"),
  "clinical_wording_subjective_objective_mismatch",
  "当前测温正常时不得把患者自诉发热改写为已测得客观发热",
);
objectiveFeverDrift.westernDiagnosis.primary.clinicalRationale =
  "患者自诉恶寒发热、当前测温未升高，病程模式支持急性感染性症状方向，但尚缺病原学信息，因此暂不采用具体病因标签。";
assert.notEqual(
  m03SemanticIssue(objectiveFeverDrift, "入睡困难；自诉恶寒发热；体温37℃；舌淡脉细"),
  "clinical_wording_subjective_objective_mismatch",
  "同时区分主观发热史和当前正常测温的表述应保留",
);
const missingSweatingDiscriminator = structuredClone(stable);
missingSweatingDiscriminator.overview.primarySyndromeBasis = ["咳白稀痰", "流清涕", "无汗"];
missingSweatingDiscriminator.pathogenesis.chain[0].patientFact = "咳白稀痰";
missingSweatingDiscriminator.pathogenesis.chain[0].syndromeEvidence = "流清涕";
assert.equal(
  m03SemanticIssue(missingSweatingDiscriminator, "入睡困难；咳白稀痰；流清涕；无汗；舌淡脉细"),
  "chain_key_discriminator_missing",
  "主证已使用无汗区分表虚表实时，病机链不得漏掉这一关键鉴别点",
);
missingSweatingDiscriminator.pathogenesis.chain[0].syndromeEvidence = "流清涕、无汗";
assert.notEqual(
  m03SemanticIssue(missingSweatingDiscriminator, "入睡困难；咳白稀痰；流清涕；无汗；舌淡脉细"),
  "chain_key_discriminator_missing",
  "病机链逐字承接无汗后应通过关键鉴别点绑定检查",
);
const incidentalNightSweat = structuredClone(stable);
incidentalNightSweat.overview.primarySyndromeBasis = ["干咳", "舌红少苔", "偶有盗汗"];
incidentalNightSweat.pathogenesis.chain[0].patientFact = "干咳";
incidentalNightSweat.pathogenesis.chain[0].syndromeEvidence = "舌红少苔";
assert.notEqual(
  m03SemanticIssue(incidentalNightSweat, "干咳；舌红少苔；偶有盗汗"),
  "chain_key_discriminator_missing",
  "伴随盗汗不应被一律提升为主链分水岭；其重要性由整体病机与独立临床复核判断",
);
const mixedPolarityWesternSupport = {
  ...stable,
  westernDiagnosis: {
    ...stable.westernDiagnosis,
    primary: {
      ...stable.westernDiagnosis.primary,
      supportingFacts: ["夜间出汗伴入睡困难1个月"],
      clinicalRationale: "夜间出汗伴入睡困难1个月支持失眠症状方向，但日间功能受损尚未核实。",
    },
  },
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
const joinedChartFactsContext = "主诉：晚上躺下老反酸，嗓子也有点烧\n现病史：断断续续一个多月。";
const joinedChartFactsReasoning = {
  ...stable,
  westernDiagnosis: {
    ...stable.westernDiagnosis,
    primary: {
      ...stable.westernDiagnosis.primary,
      supportingFacts: ["晚上躺下老反酸，嗓子也有点烧，断断续续一个多月"],
    },
  },
  pathogenesis: {
    ...stable.pathogenesis,
    chain: [{
      ...stable.pathogenesis.chain[0],
      patientFact: "晚上躺下老反酸，嗓子也有点烧，断断续续一个多月",
      syndromeEvidence: "晚上躺下老反酸，嗓子也有点烧，断断续续一个多月",
    }],
  },
};
const groundedJoinedChartFactsContent = groundStructuredPatientFacts(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(joinedChartFactsReasoning)}\n<!-- DIAGNOSIS_JSON_END -->`,
  joinedChartFactsContext,
);
const groundedJoinedChartFacts = JSON.parse(groundedJoinedChartFactsContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.doesNotMatch(
  groundedJoinedChartFacts.westernDiagnosis.primary.supportingFacts.join("\n"),
  /嗓子也有点烧，断断续续一个多月/,
  "provider-joined chart clauses cannot survive as a fabricated verbatim source quote",
);
assert.ok(
  groundedJoinedChartFacts.westernDiagnosis.primary.supportingFacts.every((fact) => joinedChartFactsContext.includes(patientFactSourceQuote(fact, joinedChartFactsContext) || "__ungrounded__")),
  "every projected Western supporting fact resolves to an exact source substring after clause splitting",
);
assert.ok(joinedChartFactsContext.includes(groundedJoinedChartFacts.pathogenesis.chain[0].patientFact), "a joined pathogenesis fact is rebound to one exact chart sentence");
const colloquialNegativeTransportContext = [
  "这两个月一吃完饭肚子上边就胀，老打嗝",
  "基层接诊初始记录：这两个月一吃完饭肚子上边就胀，老打嗝；没吐过血，别的说不清。",
  "本轮追问补充：本次未取得该信息",
].join("\n");
const colloquialNegativeTransportReasoning = structuredClone(stable);
colloquialNegativeTransportReasoning.westernDiagnosis.primary.supportingFacts = [
  "这两个月一吃完饭肚子上边就胀,老打嗝；没吐过血",
];
colloquialNegativeTransportReasoning.pathogenesis.chain[0].patientFact = "这两个月一吃完饭肚子上边就胀,老打嗝";
colloquialNegativeTransportReasoning.pathogenesis.chain[0].syndromeEvidence = "这两个月一吃完饭肚子上边就胀,老打嗝";
const groundedColloquialNegativeContent = groundStructuredPatientFacts(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(colloquialNegativeTransportReasoning)}\n<!-- DIAGNOSIS_JSON_END -->`,
  colloquialNegativeTransportContext,
);
const groundedColloquialNegative = JSON.parse(
  groundedColloquialNegativeContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
const colloquialNegativeFacts = groundedColloquialNegative.westernDiagnosis.primary.supportingFacts;
assert.ok(colloquialNegativeFacts.includes("这两个月一吃完饭肚子上边就胀，老打嗝"), "the exact positive source sentence survives transport-prefix and punctuation normalization");
assert.ok(colloquialNegativeFacts.every((fact) => colloquialNegativeTransportContext.includes(fact)), "every projected fact remains an exact raw chart substring");
assert.ok(colloquialNegativeFacts.every((fact) => !/没吐过血|别的说不清/.test(fact)), "colloquial denials and unknown follow-up text never enter positive evidence");
assert.ok(colloquialNegativeFacts.every((fact) => !fact.includes(",")), "NFKC punctuation must not be presented as a verbatim source quote");
assert.equal(colloquialNegativeFacts.filter((fact) => /肚子上边就胀|老打嗝/.test(fact)).length, 1, "a complete exact chart sentence subsumes redundant provider-split fragments");
const overstatedWesternContent = groundedMixedPolarityWesternSupportContent.replace(
  '"name": "慢性失眠障碍倾向"',
  '"name": "慢性失眠障碍"',
);
const declassifiedWesternContent = declassifyUnsupportedM03WesternPrimary(overstatedWesternContent, mixedPolarityWesternContext);
const declassifiedWestern = JSON.parse(
  declassifiedWesternContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.equal(declassifiedWestern.westernDiagnosis.primary.name, "睡眠障碍症状", "a reviewer-rejected disease label is demoted to a governed symptom-level label derived from the chart");
assert.equal(declassifiedWestern.westernDiagnosis.primary.status, "证据有限");
assert.equal(declassifiedWestern.westernDiagnosis.primary.confidence, "低");
assert.deepEqual(
  declassifiedWestern.westernDiagnosis.primary.supportingFacts,
  ["夜间出汗伴入睡困难1个月"],
  "declassification keeps only the chart-grounded chief symptom instead of carrying disputed padding into re-review",
);
const regroundedDeclassifiedWestern = JSON.parse(
  groundStructuredPatientFacts(declassifiedWesternContent, mixedPolarityWesternContext)
    .split("<!-- DIAGNOSIS_JSON_START -->")[1]
    .split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.deepEqual(
  regroundedDeclassifiedWestern.westernDiagnosis.primary.supportingFacts,
  ["夜间出汗伴入睡困难1个月"],
  "final grounding preserves the deterministic symptom downgrade instead of restoring normal vitals, denials, or unrelated chart padding",
);
assert.ok(declassifiedWestern.westernDiagnosis.differentials.some((item) => item.name === "慢性失眠障碍"), "the rejected concrete disease remains visible as a differential instead of being silently discarded");
assert.equal(m03SemanticIssue(declassifiedWestern, mixedPolarityWesternContext), undefined, "safe diagnostic declassification must still pass every deterministic M03 contract before re-review");
const respiratoryFormalReasoning = structuredClone(stable);
respiratoryFormalReasoning.westernDiagnosis.primary.name = "慢性支气管炎";
respiratoryFormalReasoning.westernDiagnosis.primary.supportingFacts = ["抽烟好多年，早上老咳一口白痰", "走两层楼会喘"];
respiratoryFormalReasoning.westernDiagnosis.primary.suggestedChecks = ["肺功能检查"];
const respiratorySparseContext = "主诉：抽烟好多年，早上老咳一口白痰\n现病史：这半年比以前多一点，走两层楼会喘";
const respiratoryFormalContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(respiratoryFormalReasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
const respiratoryDeclassifiedContent = declassifyUnmetFormalM03WesternPrimary(respiratoryFormalContent, respiratorySparseContext);
const respiratoryDeclassified = JSON.parse(respiratoryDeclassifiedContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(respiratoryDeclassified.westernDiagnosis.primary.name, "咳嗽咳痰症状", "chronic bronchitis cannot remain primary when the record lacks its minimum documented course criteria");
assert.ok(respiratoryDeclassified.westernDiagnosis.differentials.some((item) => item.name === "慢性支气管炎"));
assert.equal(
  declassifyUnmetFormalM03WesternPrimary(respiratoryFormalContent, `${respiratorySparseContext}\n既往史：已确诊慢性支气管炎5年`),
  respiratoryFormalContent,
  "an established diagnosis is not declassified",
);
assert.equal(
  declassifyUnmetFormalM03WesternPrimary(respiratoryFormalContent, `${respiratorySparseContext}\n咳嗽咳痰连续2年，每年持续3个月以上`),
  respiratoryFormalContent,
  "explicitly documented chronic-bronchitis course criteria preserve the formal label",
);
const copdFormalReasoning = structuredClone(respiratoryFormalReasoning);
copdFormalReasoning.westernDiagnosis.primary.name = "慢性阻塞性肺疾病";
const copdFormalContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(copdFormalReasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
assert.match(declassifyUnmetFormalM03WesternPrimary(copdFormalContent, respiratorySparseContext), /咳嗽咳痰症状/);
assert.equal(
  declassifyUnmetFormalM03WesternPrimary(copdFormalContent, `${respiratorySparseContext}\n肺功能：FEV1/FVC 低于 0.7，提示持续气流受限`),
  copdFormalContent,
  "documented obstructive spirometry preserves the COPD label",
);
const sleepBreathingReasoning = structuredClone(respiratoryFormalReasoning);
sleepBreathingReasoning.westernDiagnosis.primary.name = "阻塞性睡眠呼吸暂停";
sleepBreathingReasoning.westernDiagnosis.primary.supportingFacts = ["一跑快了就胸口呼呼响，晚上有时憋醒"];
sleepBreathingReasoning.westernDiagnosis.primary.suggestedChecks = ["多导睡眠监测"];
const sleepBreathingContext = "主诉：一跑快了就胸口呼呼响，晚上有时憋醒\n现病史：近一个月发作3次";
const sleepBreathingContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(sleepBreathingReasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
const sleepBreathingDeclassifiedContent = declassifyUnmetFormalM03WesternPrimary(sleepBreathingContent, sleepBreathingContext);
const sleepBreathingDeclassified = JSON.parse(sleepBreathingDeclassifiedContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(sleepBreathingDeclassified.westernDiagnosis.primary.name, "喘息症状", "night awakening plus exertional wheeze cannot become a formal OSA diagnosis without established or objective evidence");
assert.ok(sleepBreathingDeclassified.westernDiagnosis.differentials.some((item) => item.name === "阻塞性睡眠呼吸暂停"));
assert.doesNotMatch(sleepBreathingDeclassified.westernDiagnosis.primary.name, /(?:或|待鉴别|[?？/／、])/, "the symptom-level respiratory primary remains a single usable diagnosis label");
assert.equal(
  declassifyUnmetFormalM03WesternPrimary(sleepBreathingContent, `${sleepBreathingContext}\n既往史：已确诊阻塞性睡眠呼吸暂停`),
  sleepBreathingContent,
  "an established OSA diagnosis is preserved",
);
assert.equal(
  declassifyUnmetFormalM03WesternPrimary(sleepBreathingContent, `${sleepBreathingContext}\n多导睡眠监测提示阻塞性睡眠呼吸暂停，AHI 18次/小时`),
  sleepBreathingContent,
  "objective sleep-study evidence preserves the OSA label",
);
const negatedOsaHistoryContent = declassifyUnmetFormalM03WesternPrimary(
  sleepBreathingContent,
  `${sleepBreathingContext}\n否认既往确诊阻塞性睡眠呼吸暂停`,
);
const negatedOsaHistory = JSON.parse(negatedOsaHistoryContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(negatedOsaHistory.westernDiagnosis.primary.name, "喘息症状", "a negated prior OSA diagnosis never satisfies the formal-label guard");
assert.match(
  declassifyUnmetFormalM03WesternPrimary(sleepBreathingContent, `${sleepBreathingContext}\n睡眠呼吸监测：AHI 2次/小时`),
  /\"喘息症状\"/,
  "a sub-threshold AHI does not preserve an OSA label",
);
const asthmaReasoning = structuredClone(sleepBreathingReasoning);
asthmaReasoning.westernDiagnosis.primary.name = "支气管哮喘";
const asthmaContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(asthmaReasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
assert.match(declassifyUnmetFormalM03WesternPrimary(asthmaContent, sleepBreathingContext), /\"喘息症状\"/);
assert.equal(
  declassifyUnmetFormalM03WesternPrimary(asthmaContent, `${sleepBreathingContext}\n肺功能支气管舒张试验阳性，提示可逆性气流受限`),
  asthmaContent,
  "objective reversible airflow evidence preserves an asthma label",
);
assert.equal(
  declassifyUnmetFormalM03WesternPrimary(asthmaContent, `${sleepBreathingContext}\n吸入沙丁胺醇后喘鸣明显缓解`),
  asthmaContent,
  "a documented bronchodilator response preserves an asthma label",
);
// ── guard 只管「这个病本身」，不管名字里碰巧带这两个字的别的病 ────────────────
//
// label 原先是裸子串（/(?:支气管)?哮喘/），凡名字含「哮喘」的病都被按支气管哮喘的判据审。
// 实测降级方向是**不安全**的那一侧，且随后 applyDeterministicIcd10Coding 会按症状名编码：
//   · 心源性哮喘（急性左心衰）——按舒张剂反应去审，本身就是错的病；
//   · 哮喘持续状态——「吸入沙丁胺醇无缓解」恰是它的定义性特征，病情越重越必然被降级；
//   · 咳嗽变异性哮喘——另一诊断实体，判据是激发试验而非舒张剂反应。
// 认不出的病名一律**不受管**，交独立临床复核（它本就负责本表以外的全部疾病）。
for (const [otherDisease, otherContext] of [
  ["心源性哮喘", "现病史：夜间不能平卧，端坐呼吸，咳粉红色泡沫痰，双下肢水肿\n既往史：冠心病、心肌梗死5年"],
  ["哮喘持续状态", "现病史：反复喘息发作，本次持续6小时，吸入沙丁胺醇无缓解，不能平卧讲话"],
  ["咳嗽变异性哮喘", "现病史：夜间及晨起干咳为主，无喘息，无痰"],
]) {
  const other = structuredClone(asthmaReasoning);
  other.westernDiagnosis.primary.name = otherDisease;
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(other)}\n<!-- DIAGNOSIS_JSON_END -->`;
  assert.equal(
    declassifyUnmetFormalM03WesternPrimary(content, otherContext), content,
    `${otherDisease} is a different disease and must not be judged by the bronchial-asthma criteria`,
  );
}
// 分期后缀只说「哪一期」，剥掉后仍是同一个病 ⇒ 继续受管。
{
  const staged = structuredClone(asthmaReasoning);
  staged.westernDiagnosis.primary.name = "支气管哮喘（急性发作期）";
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(staged)}\n<!-- DIAGNOSIS_JSON_END -->`;
  assert.match(
    declassifyUnmetFormalM03WesternPrimary(content, sleepBreathingContext), /喘息症状/,
    "a stage suffix does not exempt the same disease from its formal criteria",
  );
}
// ── 「既往已确诊」判据与语序无关,不靠枚举引导词 ────────────────────────────
//
// 原判据是 (?:既往史|既往确诊|既往诊断|已确诊|明确诊断|曾诊断为) + 病名前 40 字以内,
// 逐条 guard 各写一份。中文病历写法是开放集合,越照着真实病历写越会被判成"没有既往诊断":
for (const establishedPhrasing of [
  "现病史：外院确诊支气管哮喘3年，间断吸入布地奈德",
  "现病史：某三甲医院诊断为支气管哮喘",
  "现病史：长期规律吸入布地奈德福莫特罗控制哮喘",
  "既往史：哮喘病史5年",
]) {
  assert.equal(
    declassifyUnmetFormalM03WesternPrimary(asthmaContent, `${sleepBreathingContext}\n${establishedPhrasing}`),
    asthmaContent,
    `an established diagnosis written as "${establishedPhrasing}" preserves the formal label`,
  );
}
// 反向:放宽不得放过「正在考虑」与「已否认」两类。
assert.match(
  declassifyUnmetFormalM03WesternPrimary(asthmaContent, `${sleepBreathingContext}\n现病史：本次考虑支气管哮喘，需完善肺功能诊断`),
  /喘息症状/,
  "a diagnosis under consideration is not an established diagnosis",
);
assert.match(
  declassifyUnmetFormalM03WesternPrimary(asthmaContent, `${sleepBreathingContext}\n现病史：否认既往确诊哮喘，未行肺功能`),
  /喘息症状/,
  "a negated prior diagnosis behind a field label never satisfies the guard",
);
const paraphrasedSparseChainContent = groundStructuredPatientFacts(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({
    ...mixedPolarityWesternSupport,
    pathogenesis: {
      locationDifferentiation: { items: ["心"], resolution: "bounded", resolutionReason: "病位由当前不寐证候归纳" },
      chain: [{
        nodeId: "P1",
        patientFact: "睡中汗出并影响睡眠",
        syndromeEvidence: "睡中汗出并影响睡眠",
        pathogenesis: "汗液调节与睡眠功能受扰",
        therapyDirection: "调护睡眠功能，改善汗液调节",
      }],
    },
    therapy: {
      overallPrinciple: "治病求本，标本兼顾",
      overallMethod: "改善汗液调节，调护睡眠功能",
      subTherapies: [{ therapy: "改善汗液调节", targetPathogenesis: "汗液调节与睡眠功能受扰", priority: "主要" }],
    },
  })}\n<!-- DIAGNOSIS_JSON_END -->`,
  mixedPolarityWesternContext,
);
const paraphrasedSparseChain = JSON.parse(
  paraphrasedSparseChainContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.equal(
  paraphrasedSparseChain.pathogenesis.chain.length,
  0,
  "an ungrounded paraphrase must enter repair instead of copying one chart quote into both patientFact and syndromeEvidence",
);
assert.equal(isStableM03Reasoning({ ...stable, formula: { candidates: [] } }), false, "M03 must keep formula null");
assert.equal(isStableM03Reasoning({ ...stable, therapy: { overallPrinciple: "养血安神；酸枣仁15g、丹参10g，每日1剂，水煎服" } }), false, "M03 must reject dose-level treatment instructions before signing");
assert.deepEqual(
  m03DoseLevelInstructionFindings({
    therapy: { overallPrinciple: "养血安神；酸枣仁15g，每日1剂" },
    pathogenesis: { chain: [{ patientFact: "既往服甘草10g" }] },
  }),
  [
    { path: "$.therapy.overallPrinciple", kind: "herb_dose" },
    { path: "$.therapy.overallPrinciple", kind: "regimen" },
  ],
  "dose diagnostics expose only schema paths and violation kinds while preserving the patientFact exception",
);
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
  // 主症仍由该节点的 syndromeEvidence 承接：病机链必须有节点承接主诉主症
  // （therapy_chief_symptom_unaddressed）。本例要断言的是"用药史剂量可以留在 patientFact"，
  // 不是"整条链可以不谈主症"。
  pathogenesis: { chain: [{ ...stable.pathogenesis.chain[0], patientFact: "既往服甘草10g", syndromeEvidence: "入睡困难" }] },
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
assert.equal(m03SemanticIssue({
  ...stable,
  overview: {
    ...stable.overview,
    tcmDiagnosticRationale: "晨起神疲结合纳差、便溏，提示气血濡养不足并影响心神。",
  },
  pathogenesis: { chain: [{ patientFact: "晨起疲乏、食欲欠佳、大便溏薄", syndromeEvidence: "疲乏、食欲欠佳、大便溏薄", pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
}, "晨起疲乏；食欲欠佳；大便溏薄"), undefined);
assert.equal(m03SemanticIssue({
  ...stable,
  overview: {
    ...stable.overview,
    tcmDiagnosticRationale: "夜间易醒结合白天疲乏，提示睡眠失养并影响日间功能。",
  },
  pathogenesis: { chain: [{ patientFact: "夜间易醒，白天疲乏", syndromeEvidence: "夜间易醒、白天疲乏", pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
}, "最近睡眠不佳，夜间易醒，白天疲乏，大概两个月"), undefined, "each structured evidence phrase must remain directly grounded in the chart");
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "心悸伴耳鸣", syndromeEvidence: "心悸耳鸣支持血虚", pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
}, "患者仅记录心悸"), false);
assert.equal(isStableM03Reasoning({
  ...stable,
  pathogenesis: { chain: [{ patientFact: "否认打鼾、呼吸暂停及日间嗜睡", syndromeEvidence: "睡眠呼吸暂停线索阴性", pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
}, "患者否认明显打鼾、目击呼吸暂停及日间嗜睡"), false, "阴性排除项可以限定鉴别，但不能单独推出中医证候");
assert.equal(isStableM03Reasoning(stable, "", "**证候诊断**：痰热扰心证\n**核心病机**：血不养心，心神失舍\n**总治法**：养血安神，疏肝解郁"), true);
assert.equal(isStableM03Reasoning(stable, "", "**证候诊断**：心肝血虚证\n**核心病机**：血不养心，心神失舍\n**总治法**：养血安神，疏肝解郁"), true);
const boundedResolution = {
  ...stable,
  overview: {
    ...stable.overview,
    primarySyndromeResolution: "bounded",
    primarySyndromeBasis: [],
    primarySyndromeResolutionReason: "舌脉未提供，当前无法形成有区分度的相邻证候鉴别",
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
assert.equal(isStableM03Reasoning(boundedResolution), true, "bounded clinical reasoning may continue when the missing differential has an explicit structured reason");
const summaryNatureDrift = structuredClone(boundedResolution);
summaryNatureDrift.pathogenesis.summary = "病性为风邪，虚实夹杂（余邪未净，正气略虚）";
summaryNatureDrift.pathogenesis.natureDifferentiation = {
  items: ["风邪"],
  rootDeficiency: [],
  branchExcess: ["风邪"],
  basis: "",
  resolution: "bounded",
  resolutionReason: "病性为有限资料下的工作归纳",
};
assert.equal(
  m03SemanticIssue(summaryNatureDrift),
  "pathogenesis_summary_qi_deficiency_drift",
  "pathogenesis.summary must not silently introduce qi deficiency absent from every authoritative core field",
);
const summaryNatureAligned = structuredClone(summaryNatureDrift);
summaryNatureAligned.overview.overallPathogenesis = "余邪未净，正气略虚";
summaryNatureAligned.pathogenesis.natureDifferentiation.items = ["风邪", "气虚"];
summaryNatureAligned.pathogenesis.natureDifferentiation.rootDeficiency = ["气虚"];
assert.equal(m03SemanticIssue(summaryNatureAligned), undefined, "a summary may retain a disease-nature conclusion already established by the core reasoning");
const summaryNatureUncertain = structuredClone(summaryNatureDrift);
summaryNatureUncertain.pathogenesis.summary = "当前资料不足以判断是否气虚";
assert.equal(m03SemanticIssue(summaryNatureUncertain), undefined, "an explicitly uncertain summary clause is not converted into an asserted disease nature");
assert.equal(m03SemanticIssue({
  ...boundedResolution,
  overview: { ...boundedResolution.overview, primarySyndrome: "头部跳痛伴畏光（证候待定）" },
}), "primary_syndrome_unstable", "a bounded primary syndrome must not sign a pending placeholder as its clinical identity");
assert.equal(m03SemanticIssue({
  ...boundedResolution,
  overview: { ...boundedResolution.overview, primarySyndrome: "头痛（病位在头，病性待定）" },
}), "primary_syndrome_unstable", "a disease-name prefix must not hide a pending primary-syndrome placeholder");
assert.equal(m03SemanticIssue({
  ...boundedResolution,
  overview: { ...boundedResolution.overview, primarySyndrome: "头部搏动性疼痛伴畏光（证候待辨）" },
}), "primary_syndrome_unstable", "short-form pending words such as 待辨 must not bypass the primary-syndrome contract");
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
    tcmDifferentials: [{
      syndrome: "心肾不交证",
      reason: "同可见入睡困难，需与当前心血不足方向鉴别",
      distinguishingPoints: "本例舌淡脉细而未见心肾不交的虚火表现",
      nextCheck: "复核潮热盗汗与腰膝酸软",
    }],
  },
  pathogenesis: {
    ...boundedResolution.pathogenesis,
    locationDifferentiation: {
      items: ["心"],
      details: [{ location: "心", basis: "入睡困难；舌淡脉细" }],
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
const singleEvidenceLocation = structuredClone(resolvedResolution);
singleEvidenceLocation.pathogenesis.locationDifferentiation.details = [{ location: "心", basis: "入睡困难" }];
assert.equal(
  m03SemanticIssue(singleEvidenceLocation, "入睡困难；舌淡脉细"),
  "single_evidence_location",
  "resolved disease location requires at least two independent four-diagnostic dimensions",
);
const singleDimensionNature = structuredClone(resolvedResolution);
singleDimensionNature.pathogenesis.natureDifferentiation = {
  items: ["热"],
  rootDeficiency: [],
  branchExcess: ["热"],
  basis: "舌红",
  resolution: "resolved",
};
assert.equal(
  m03SemanticIssue(singleDimensionNature),
  "nature_dimension_insufficient",
  "a resolved cold/heat conclusion requires at least two independent observation dimensions",
);
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

assert.equal(m03SemanticIssue({
  ...boundedResolution,
  pathogenesis: {
    ...boundedResolution.pathogenesis,
    uncertainties: [{
      item: "既往史、用药史",
      reason: "该症状已在病历中明确记录；后续仅需评估严重度",
      affects: "影响诊断与治疗安全性",
    }],
  },
}, "主诉：大便难解；最近三个月加重"), "uncertainty_state_mismatch", "a vague recorded-state claim must not convert absent histories into known facts");
assert.equal(m03SemanticIssue({
  ...boundedResolution,
  pathogenesis: {
    ...boundedResolution.pathogenesis,
    uncertainties: [{
      item: "当前用药与具体剂量",
      reason: "当前用药已明确记录，但具体剂量未提供",
      affects: "影响相互作用与剂量安全复核",
    }],
  },
}, "主诉：入睡困难；舌脉未提供"), "uncertainty_state_mismatch", "an absent governed field cannot be described as documented");
assert.equal(m03SemanticIssue({
  ...boundedResolution,
  pathogenesis: {
    ...boundedResolution.pathogenesis,
    uncertainties: [{
      item: "过敏反应详情",
      reason: "青霉素过敏已在病历中明确记录，但具体反应类型未提供",
      affects: "影响用药风险复核",
    }],
  },
}, "主诉：入睡困难；舌淡脉细；过敏史：青霉素过敏，反应类型不详"), undefined, "a documented fact may retain a narrower explicitly unknown attribute");

assert.equal(m03SemanticIssue({
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "不寐功能失调候", overallPathogenesis: "睡眠功能受扰" },
  pathogenesis: { chain: [{ patientFact: "入睡困难", syndromeEvidence: "入睡困难", pathogenesis: "睡眠功能受扰", therapyDirection: "调护功能" }] },
}), "generic_tcm_template", "跨病例的功能失调候/调护功能套话必须在结构合同层拒绝");
assert.equal(m03SemanticIssue({
  ...stable,
  overview: { ...stable.overview, primarySyndromeResolutionReason: "本次主诉及伴随症状变化。" },
}), "explanation_placeholder", "无信息量的解释占位句必须在独立复核和签名前被拒绝");

for (const [label, context, westernName, westernFact, diseaseFact, inferredSyndrome] of [
  ["高血压不能自动推出眩晕", "高血压10年；本次血压160/100mmHg；否认头晕", "高血压控制欠佳", "本次血压160/100mmHg", "高血压10年", "眩晕·肝阳上亢证"],
  ["房颤不能自动推出心气虚", "心电图提示心房颤动；否认心悸、乏力、气短", "心房颤动", "心电图提示心房颤动", "心房颤动", "心气虚证"],
  ["湿疹标签不能自动推出湿热", "湿疹复诊；未记录当前瘙痒、渗出或舌脉", "湿疹", "湿疹复诊", "湿疹", "湿热蕴肤证"],
  ["类风湿标签不能自动推出痹证", "类风湿关节炎复诊；未记录当前关节肿痛或舌脉", "类风湿关节炎", "类风湿关节炎复诊", "类风湿关节炎", "风湿痹阻证"],
  ["SLE标签不能自动推出阴虚", "系统性红斑狼疮复诊；未记录当前阳性症状或舌脉", "系统性红斑狼疮", "系统性红斑狼疮复诊", "系统性红斑狼疮", "阴虚内热证"],
]) {
  const issue = m03SemanticIssue({
    ...stable,
    overview: { ...stable.overview, primarySyndrome: inferredSyndrome, primarySyndromeBasis: [diseaseFact] },
    westernDiagnosis: { ...stable.westernDiagnosis, primary: { ...stable.westernDiagnosis.primary, name: westernName, supportingFacts: [westernFact] } },
    pathogenesis: { chain: [{ patientFact: diseaseFact, syndromeEvidence: diseaseFact, pathogenesis: inferredSyndrome, therapyDirection: "辨证调治" }] },
  }, context);
  assert.notEqual(issue, undefined, label);
}
assert.equal(isUnstableM03CoreText("本例信息仍不足，暂不能形成稳定证候"), true);
assert.equal(isUnstableM03CoreText("气滞血瘀，心脉痹阻；信息有限需结合检查复核"), false);
assert.equal(isStableM03Reasoning({ ...stable, pathogenesis: { chain: [] } }), false);
assert.equal(isStableM03Reasoning({ ...stable, stage: "prescribe" }), false);
assert.equal(isStableM03Reasoning(undefined), false);
const heatReasoning = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "肝郁化火证", overallPathogenesis: "肝郁化火，上扰心神" },
  therapy: {
    overallPrinciple: "正治",
    overallMethod: "疏肝清热，宁心安神",
    subTherapies: [{ therapy: "清肝泻火", targetPathogenesis: "肝郁化火", priority: "主要" }],
  },
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
      items: ["血虚"],
      rootDeficiency: ["血虚"],
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
  "location_classification_missing",
  "an explicitly named governed disease location must not disappear from the location classification",
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
    natureDifferentiation: { items: ["气虚", "血虚"], rootDeficiency: ["气虚", "血虚"], branchExcess: [], basis: "纳差、神疲、心悸" },
  },
  therapy: {
    overallPrinciple: "扶正祛邪",
    overallMethod: "健脾益气，养血安神",
    subTherapies: [{ therapy: "健脾益气", targetPathogenesis: "脾气虚弱", priority: "主要" }],
  },
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
    natureDifferentiation: { items: ["痰", "热"], rootDeficiency: [], branchExcess: ["痰", "热"], basis: "入睡困难" },
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
  overview: {
    ...groundedPathogenesisClassification.overview,
    tcmDifferentials: [{
      syndrome: "心肾不交证",
      reason: "同可见睡眠异常，需与当前心血不足方向鉴别",
      distinguishingPoints: "本例舌淡脉细而未见虚火上扰表现",
      nextCheck: "复核潮热盗汗与腰膝酸软",
    }],
  },
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
      items: ["血虚", "痰", "热"],
      rootDeficiency: ["血虚"],
      branchExcess: ["痰", "热"],
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
assert.deepEqual(sanitizedOptionalClassification.pathogenesis.natureDifferentiation.items, ["血虚", "痰", "热"]);
assert.deepEqual(sanitizedOptionalClassification.pathogenesis.natureDifferentiation.branchExcess, ["痰", "热"]);
assert.equal(sanitizedOptionalClassification.pathogenesis.natureDifferentiation.resolution, "bounded");
assert.equal(sanitizedOptionalClassification.pathogenesis.symptomClusters.length, 1);
assert.deepEqual(
  sanitizedOptionalClassification.pathogenesis.symptomClusters[0].symptoms,
  ["入睡困难", "舌淡", "脉细"],
  "grounded symptoms are deduplicated within each mechanism cluster before display and signing",
);
const mixedPolarityTcmBasisSource = JSON.parse(
  optionalClassificationContent
    .split("<!-- DIAGNOSIS_JSON_START -->")[1]
    .split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
mixedPolarityTcmBasisSource.overview.primarySyndromeBasis = [
  "入睡困难",
  "否认心悸和善太息",
  "舌淡",
  "脉细",
];
const mixedPolarityTcmBasisContent =
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(mixedPolarityTcmBasisSource)}\n<!-- DIAGNOSIS_JSON_END -->`;
const mixedPolarityTcmBasis = JSON.parse(
  sanitizeOptionalPathogenesisClassifications(
    mixedPolarityTcmBasisContent,
    "入睡困难；否认心悸和善太息；舌淡；脉细",
  )
    .split("<!-- DIAGNOSIS_JSON_START -->")[1]
    .split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.deepEqual(
  mixedPolarityTcmBasis.overview.primarySyndromeBasis,
  ["入睡困难", "舌淡", "脉细"],
  "negated chart clauses remain differential exclusions and never become positive primary-syndrome evidence",
);
assert.equal(
  isStableM03Reasoning(sanitizedOptionalClassification, "入睡困难；舌淡；脉细"),
  true,
  `semantic classifications remain visible with an explicit bounded state while ungrounded patient quotes are removed: ${m03SemanticIssue(sanitizedOptionalClassification, "入睡困难；舌淡；脉细")}`,
);

const advisoryQualitySource = structuredClone(stable);
advisoryQualitySource.westernDiagnosis.primary.supportingFacts = ["体温37℃", "入睡困难"];
advisoryQualitySource.overview.primarySyndromeResolution = "resolved";
advisoryQualitySource.overview.primarySyndromeBasis = [];
advisoryQualitySource.pathogenesis.natureDifferentiation = {
  items: ["热"],
  rootDeficiency: [],
  branchExcess: ["热"],
  basis: "舌红",
  resolution: "resolved",
  evidence: { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" },
};
advisoryQualitySource.therapy.subTherapies = [];
const advisoryQualityContent = applyM03AdvisoryQualityBoundaries(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(advisoryQualitySource)}\n<!-- DIAGNOSIS_JSON_END -->`,
  "主诉：入睡困难；体温37℃；舌红；脉细",
);
const advisoryQuality = JSON.parse(
  advisoryQualityContent
    .split("<!-- DIAGNOSIS_JSON_START -->")[1]
    .split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
// 需求3：诊断出三个——西医诊断（含 ICD-10）、中医辨病、中医辨证候。中医病名因此必须活着
// 到达客户端；归一化阶段一度把它 delete 掉，界面上「辨病」那一行就永远不出现。
assert.equal(advisoryQuality.overview.tcmDiseaseName, "不寐", "中医病名必须写入客户可见 M03 结构（需求3 的三段诊断之一）");
assert.deepEqual(
  advisoryQuality.westernDiagnosis.primary.supportingFacts,
  ["入睡困难"],
  "正常生命体征从西医支持依据局部删除，不得连带清空中医辨证",
);
assert.equal(advisoryQuality.overview.primarySyndromeResolution, "bounded", "证候依据不足时 resolved 必须局部降为 bounded");
assert.equal(advisoryQuality.pathogenesis.natureDifferentiation.resolution, "bounded", "单一寒热证据维度必须局部降为 bounded");
assert.equal(advisoryQuality.therapy.subTherapies.length, 1, "分治表从既有病机链做无新增结论的确定性投影");
assert.equal(advisoryQuality.pathogenesis.chain[0].pathogenesis, stable.pathogenesis.chain[0].pathogenesis, "质量降级不得改写既有病机");
assert.ok(
  advisoryQuality.pathogenesis.uncertainties.some((item) => /质量边界/.test(item.item)),
  "质量边界必须对用户透明，不得静默吞掉问题",
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
assert.match(safeM03Draft, /（剂量以审定处方为准）/);
assert.doesNotMatch(safeM03Draft, /待候选方药阶段核验/, "掩码必须在替换处直接产出医生可读措辞：客户端与确定性路由都不经过 scrubInternalVocabularyFromVisibleText");

// 掩码只针对“数量+剂量单位”的可执行用法；频次词、给药途径词本身是普通临床用语，
// 命中它们并吞掉后续 40 字会删掉临床发现，在 markdown 表格里还会吃掉 | 分隔符导致列塌陷。
for (const clinicalProse of [
  "患者每日腹泻3次，睡前焦虑明显。",
  "饭量减少，饭后脘腹胀。",
  "建议完善口服葡萄糖耐量试验（OGTT）以明确诊断。",
  "既往口服二甲双胍史。",
  "夜间盗汗，睡前多梦易醒。",
  "大便每日2次，质稀。",
  "外用药膏后皮疹减轻。",
  "| 心脾两虚 | 每日乏力 | 健脾养心 | 气血生化乏源 |",
]) {
  assert.equal(sanitizeDiagnoseStreamingDraft(clinicalProse), clinicalProse, `临床叙述不得被剂量掩码改写：${clinicalProse}`);
}
for (const regimen of ["黄芪15g", "每日1剂", "每日一剂", "水煎服", "冲服", "口服3片", "连服3剂", "共5剂", "疗程为14天", "每晚2粒"]) {
  assert.notEqual(sanitizeDiagnoseStreamingDraft(regimen), regimen, `可执行用法必须被掩码：${regimen}`);
}
assert.match(safeM03Draft, /既往服用阿司匹林100mg/, "structured M03 contract must remain byte-stable for signature validation");
const safeCourseDraft = sanitizeDiagnoseStreamingDraft("建议连服3剂后复诊；拟服用7天；共5剂。症状已持续3天。");
assert.doesNotMatch(safeCourseDraft, /连服3剂|服用7天|共5剂/);
assert.match(safeCourseDraft, /症状已持续3天/, "clinical duration is not a prescription course and must remain visible");
const mixedPolarityContext = "问诊补充：无发热、咳嗽、消瘦或心悸，盗汗以入睡后为主，醒后可缓解；主诉：入睡困难1个月";
const mixedPolarityQuote = patientFactSourceQuote("盗汗、入睡困难", mixedPolarityContext);
assert.ok(mixedPolarityQuote, "affirmed symptoms remain groundable when the same source sentence also contains negated symptoms");
assert.ok(patientFactSourceQuote(mixedPolarityQuote, mixedPolarityContext), "a mixed-polarity source quote remains idempotently groundable");
assert.match(
  patientFactSourceQuote("入睡困难", "躺床上脑子停不下来，得一两个小时才睡着") || "",
  /一两个小时才睡着/,
  "quantified colloquial sleep latency must ground the canonical sleep-onset concept",
);

const acuteChestStasisReasoning = {
  ...stable,
  overview: {
    ...stable.overview,
    primarySyndrome: "胸痹心脉痹阻证",
    tcmDiagnosticRationale: "胸骨后压榨样疼痛并向左肩放射，提示心脉痹阻、不通则痛。",
    overallPathogenesis: "气虚无力推动血脉，瘀阻心脉",
  },
  pathogenesis: {
    ...stable.pathogenesis,
    chain: [{ patientFact: "胸骨后压榨样疼痛，向左肩放射", syndromeEvidence: "胸骨后压榨样疼痛，向左肩放射", pathogenesis: "心脉瘀阻，不通则痛", therapyDirection: "益气活血，通脉止痛" }],
  },
  therapy: { ...stable.therapy, overallPrinciple: "急则治标", overallMethod: "益气活血，通脉止痛" },
};
assert.equal(
  isStableM03Reasoning(acuteChestStasisReasoning, "突发胸骨后压榨样疼痛1小时，向左肩放射，伴大汗、气促"),
  true,
  `an acute fixed pressure-like radiating chest pain fact may ground a bounded blood-stasis mechanism without inventing tongue or pulse findings: ${m03SemanticIssue(acuteChestStasisReasoning, "突发胸骨后压榨样疼痛1小时，向左肩放射，伴大汗、气促")}`,
);

const colloquialNightSweatReasoning = {
  ...stable,
  overview: {
    ...stable.overview,
    primarySyndrome: "阴虚内热证",
    tcmDiagnosticRationale: "夜间反复汗出且睡中加重，提示阴液不足、虚热内扰。",
    overallPathogenesis: "阴液不足，虚热内扰",
  },
  pathogenesis: {
    ...stable.pathogenesis,
    chain: [{ patientFact: "夜里总出汗", syndromeEvidence: "夜里总出汗", pathogenesis: "阴液不足，虚热内扰", therapyDirection: "滋阴清热" }],
  },
  therapy: { ...stable.therapy, overallPrinciple: "因人制宜", overallMethod: "滋阴清热" },
};
assert.equal(
  isStableM03Reasoning(colloquialNightSweatReasoning, "患者夜里总出汗，睡着后出汗，醒来就停；睡不好约一个月"),
  true,
  `colloquial nocturnal sweating must ground the canonical 盗汗 concept without forcing a model retry: ${m03SemanticIssue(colloquialNightSweatReasoning, "患者夜里总出汗，睡着后出汗，醒来就停；睡不好约一个月")}`,
);
const nightSweatYinReasoning = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "阴虚神扰证", overallPathogenesis: "阴虚失养，心神不宁" },
  therapy: {
    overallPrinciple: "因人制宜，扶正祛邪",
    overallMethod: "滋阴养心，宁心安神",
    subTherapies: [{ therapy: "滋阴养心", targetPathogenesis: "阴虚失养", priority: "主要" }],
  },
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
for (const colloquialAbdominalPain of ["来月经第一天肚子疼得蜷着", "小肚子一阵一阵地痛", "肚脐周围隐隐疼"]) {
  assert.equal(m03SemanticIssue(chainWithFact("腹痛"), `${colloquialAbdominalPain}；舌淡脉细`), undefined, `${colloquialAbdominalPain} canonicalizes to 腹痛`);
}
assert.equal(m03SemanticIssue(chainWithFact("腹痛"), "肚子一点也不疼；舌淡脉细"), "patient_fact_ungrounded_0_0_polarity", "a colloquial abdominal-pain denial cannot ground an affirmed 腹痛");
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
  const abnormalVitalSupport = westernSupportOf([finding]);
  abnormalVitalSupport.westernDiagnosis.primary.name = "生命体征异常待评估";
  abnormalVitalSupport.westernDiagnosis.primary.clinicalRationale = `${finding}提示当前生命体征异常，但具体病因仍需结合现场复测核实。`;
  assert.equal(m03SemanticIssue(abnormalVitalSupport, `${finding}；${stableSupportContext}`), undefined, `${finding} is abnormal and remains valid diagnostic support`);
}
assert.equal(m03SemanticIssue(westernSupportOf(["高血压病史", "入睡困难"]), stableSupportContext), undefined, "a current positive finding beside background history remains valid support");
// (f) excluded items cannot bypass the historical_only gate
assert.equal(m03SemanticIssue(westernSupportOf(["生命体征：120/80", "高血压病史"]), stableSupportContext), "western_support_normal_vital_padding", "normal vitals cannot masquerade as current evidence beside historical facts");
assert.equal(m03SemanticIssue(westernSupportOf(["2型糖尿病10年", "男性，45岁"]), stableSupportContext), "western_support_demographic_padding", "demographics cannot masquerade as current evidence beside historical facts");
assert.equal(m03SemanticIssue(westernSupportOf(["舌淡红", "高血压病史"]), stableSupportContext), "western_support_tcm_pollution", "tongue findings cannot masquerade as current evidence beside historical facts");
assert.equal(m03SemanticIssue(westernSupportOf(["2型糖尿病10年", "高血压病史"]), stableSupportContext), "western_support_historical_only", "a multi-year background entry cannot bypass the historical_only gate");

// Post-grounding rationale alignment repairs the whole transform-induced mismatch class without
// restoring filtered padding or inventing a more specific diagnosis.
const rationaleMismatch = structuredClone(stable);
rationaleMismatch.westernDiagnosis.primary.name = "失眠症状";
rationaleMismatch.westernDiagnosis.primary.supportingFacts = ["入睡困难"];
rationaleMismatch.westernDiagnosis.primary.clinicalRationale =
  "生命体征平稳支持当前工作诊断，但具体病因仍需鉴别。";
assert.equal(
  m03WesternClinicalRationaleIssue(rationaleMismatch),
  "western_clinical_rationale_restatement",
  "a rationale tied to a filtered fact is rejected against the surviving support",
);
const rationaleMismatchContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(rationaleMismatch)}\n<!-- DIAGNOSIS_JSON_END -->`;
const alignedRationaleContent = alignNormalizedM03WesternClinicalRationale(rationaleMismatchContent);
const alignedRationale = JSON.parse(
  alignedRationaleContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
assert.match(alignedRationale.westernDiagnosis.primary.clinicalRationale, /入睡困难.*失眠症状.*具体病因/, "the replacement uses only the retained fact, selected label, and bounded uncertainty");
assert.doesNotMatch(alignedRationale.westernDiagnosis.primary.clinicalRationale, /生命体征/, "filtered normal-vital padding cannot re-enter through the rationale");
assert.equal(m03WesternClinicalRationaleIssue(alignedRationale), undefined, "the bounded rationale passes the same focused validator used by finalization");
assert.equal(m03SemanticIssue(alignedRationale, stableSupportContext), undefined, "the aligned candidate passes the complete M03 contract");

const tcmRationaleMismatch = structuredClone(alignedRationale);
tcmRationaleMismatch.overview.tcmDiagnosticRationale = tcmRationaleMismatch.pathogenesis.chain[0].patientFact;
assert.equal(
  m03SemanticIssue(tcmRationaleMismatch, stableSupportContext),
  "tcm_diagnostic_rationale_missing",
  "a bare TCM fact is not an inference rationale",
);
const alignedTcmRationaleContent = alignNormalizedM03TcmDiagnosticRationale(
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(tcmRationaleMismatch)}\n<!-- DIAGNOSIS_JSON_END -->`,
);
const alignedTcmRationale = JSON.parse(
  alignedTcmRationaleContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0],
);
// 甲方评测(2026-08-03)「辨证推理无实际内容」后模板升级为「四诊要点 → 病位病性 → 病机 → 证型」
// 推理句：病机在前、证型收尾，且仍只做投影(两者都必须来自载荷既有字段)。
assert.match(
  alignedTcmRationale.overview.tcmDiagnosticRationale,
  new RegExp(`${alignedTcmRationale.overview.overallPathogenesis}[\\s\\S]*${alignedTcmRationale.overview.primarySyndrome}`),
  "the TCM rationale projects only the retained pathogenesis and syndrome",
);
assert.match(
  alignedTcmRationale.overview.tcmDiagnosticRationale,
  /四诊要点|提示病位在/,
  "重建的辨证推理必须织入四诊要点/病位线索，不得退回『结合其表现模式』式空话",
);
assert.doesNotMatch(alignedTcmRationale.overview.tcmDiagnosticRationale, /结合其表现模式/);
assert.equal(
  m03SemanticIssue(alignedTcmRationale, stableSupportContext),
  undefined,
  "the deterministic TCM explanation passes the same complete M03 contract",
);

const validRationaleContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(stable)}\n<!-- DIAGNOSIS_JSON_END -->`;
assert.equal(alignNormalizedM03WesternClinicalRationale(validRationaleContent), validRationaleContent, "a valid provider rationale is byte-preserved");

const noGroundedFactRationale = structuredClone(rationaleMismatch);
noGroundedFactRationale.westernDiagnosis.primary.supportingFacts = [];
const noGroundedFactContent = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(noGroundedFactRationale)}\n<!-- DIAGNOSIS_JSON_END -->`;
assert.equal(alignNormalizedM03WesternClinicalRationale(noGroundedFactContent), noGroundedFactContent, "missing support remains fail-closed instead of synthesizing evidence");

// === Denial-transport rewrite keeps negation scope (release-e2e DZ01 residual) ===
const dizzinessDenialContext = "头晕反复3天；起身或转头时明显，每次持续数分钟，休息后缓解，无晕厥、胸痛或呼吸困难；舌淡白；脉细；面色少华；近期有黑便、月经量过多或外伤出血史";
const dizzinessChain = {
  ...stable,
  overview: {
    ...stable.overview,
    tcmDiagnosticRationale: "头晕结合舌淡白、脉细，提示气血亏虚、清窍失养。",
  },
  pathogenesis: { chain: [{ patientFact: "头晕反复3天", syndromeEvidence: "舌淡白脉细", pathogenesis: "气血亏虚，清窍失养", therapyDirection: "益气养血" }] },
};
const dizzinessWesternSupport = (supportingFacts) => ({
  ...dizzinessChain,
  westernDiagnosis: {
    ...stable.westernDiagnosis,
    primary: {
      ...stable.westernDiagnosis.primary,
      name: "头晕症状",
      supportingFacts,
      clinicalRationale: "头晕反复3天支持当前头晕症状方向，但晕厥、胸痛及呼吸困难已否认，具体病因仍需鉴别。",
    },
  },
});
// The customer-output sanitizer transports the charted denial into a normalized sentence. Its
// negation scope must survive the 、 boundary, otherwise every later enumerated term reads affirmed
// and finalization burns the whole diagnosis. Generic filler is intentionally no longer appended.
assert.equal(m03SemanticIssue(dizzinessWesternSupport([
  "头晕反复3天",
  "起身或转头时明显，每次持续数分钟，休息后缓解",
  "近期有黑便、月经量过多或外伤出血史",
  "面象：面色少华",
  "病历已记录否认胸痛、呼吸困难",
]), dizzinessDenialContext), undefined, "the deterministic denial-transport rewrite keeps negation scope over the whole enumeration");
assert.equal(isWesternSupportingFactPolarityAligned("病历已记录否认胸痛、呼吸困难", dizzinessDenialContext), true, "every enumerated term inside 病历已记录否认… stays negated");
assert.equal(isWesternSupportingFactPolarityAligned("无晕厥、胸痛或呼吸困难", dizzinessDenialContext), true, "a charted rule-out enumeration stays negated without the transport prefix");
const headacheWithQualifiedRuleOutContext = "主诉：头疼头晕，睡不着觉\n现病史：头疼头晕、入睡困难2个月，多梦易醒，晨起疲乏；否认突发最剧烈头痛、复视、言语不清、肢体无力、喷射性呕吐。\n舌淡，脉细";
assert.equal(
  isWesternSupportingFactPolarityAligned("头疼头晕，睡不着觉", headacheWithQualifiedRuleOutContext),
  true,
  "an affirmed general symptom remains valid support when the chart separately denies only its dangerous subtype",
);
assert.equal(
  isWesternSupportingFactPolarityAligned("头痛", "否认头痛、头晕及复视"),
  false,
  "a denied-only symptom still cannot become affirmative Western support",
);
const headacheWithQualifiedRuleOut = structuredClone(stable);
// 主诉含头疼：病位辨证必须包含主症所在部位（location_chief_symptom_anchor_missing），
// 病机链也必须有节点承接主症（therapy_chief_symptom_unaddressed）。兼及的心、肝照常保留。
// 本例断言的是极性边界，不是病位/主症锚，补齐二者以免两类检查互相遮蔽。
headacheWithQualifiedRuleOut.pathogenesis.locationDifferentiation.items = ["脑", "心", "肝"];
headacheWithQualifiedRuleOut.pathogenesis.chain[0].patientFact = "头疼头晕、入睡困难2个月";
headacheWithQualifiedRuleOut.westernDiagnosis.primary.name = "头痛症状";
headacheWithQualifiedRuleOut.westernDiagnosis.primary.supportingFacts = ["头疼头晕，睡不着觉"];
headacheWithQualifiedRuleOut.westernDiagnosis.primary.clinicalRationale =
  "头疼头晕，睡不着觉支持将“头痛症状”作为当前工作诊断；但现有资料尚不足以确定具体病因，因此暂不采用更具体的病因标签。";
assert.equal(
  m03SemanticIssue(headacheWithQualifiedRuleOut, headacheWithQualifiedRuleOutContext),
  undefined,
  "the full M03 contract separates affirmative symptom support from qualified red-flag rule-out context",
);
// negated rule-out facts are routed as rule-out context, never as a polarity violation
assert.equal(m03SemanticIssue(dizzinessWesternSupport(["头晕反复3天", "无晕厥、胸痛或呼吸困难"]), dizzinessDenialContext), undefined, "a negated rule-out fact rides along as rule-out context");
assert.equal(m03SemanticIssue(dizzinessWesternSupport(["无晕厥、胸痛或呼吸困难"]), dizzinessDenialContext), "western_support_historical_only", "negated rule-out facts alone cannot satisfy the current-fact gate");
// an affirmed term the chart denies — synthetic or model-written — still rejects
assert.equal(m03SemanticIssue(dizzinessWesternSupport(["头晕反复3天", "呼吸困难"]), dizzinessDenialContext), "western_support_polarity_mismatch", "an affirmed term the chart explicitly denies still rejects");
assert.equal(m03SemanticIssue(dizzinessWesternSupport(["头晕反复3天", "病历已记录胸痛阳性"]), dizzinessDenialContext), "western_support_polarity_mismatch", "a synthetic affirmed statement about a chart-denied term still rejects");

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
      decoction: {
        doseCount: "5剂",
        dosesPerDay: 1,
        administrationTimesPerDay: 2,
        method: "每日1剂，冷水浸泡30分钟，煎煮2次，合并药液约400mL，每日分2次服",
        course: "5日",
        followUpNode: "5日复诊",
      },
    }],
    modifications: [],
  },
  nonPharma: {
    diet: "晚餐清淡，避免睡前浓茶咖啡",
    lifestyle: "固定作息并减少睡前屏幕刺激",
    emotion: "记录情绪波动并配合放松训练",
    acupointCare: "可按揉神门、内关",
    precautions: ["服药期间忌浓茶、咖啡与酒", "入睡困难若连续加重或出现明显日间功能受损，提前复诊"],
  },
};
const liverImpairmentRiskM04 = structuredClone(m04);
liverImpairmentRiskM04.formula.candidates[0].herbs[0] = {
  ...liverImpairmentRiskM04.formula.candidates[0].herbs[0],
  name: "朱砂",
  dose: "1g",
  function: getTcmHerbFunctionText("朱砂"),
  isToxic: true,
  decoctionRequirement: "不入煎剂，研末冲服",
};
assert.match(
  m04SemanticIssue(liverImpairmentRiskM04, "", stable, isKnownTcmHerbName, false, false, false, false, "患者肝功能不全") || "",
  /special_population_high_risk_hepatic_impairment/,
  "M04 must reject an active HIGH special-population rule before signing or post-prescription audit",
);
assert.doesNotMatch(
  m04SemanticIssue(liverImpairmentRiskM04, "", stable, isKnownTcmHerbName, false, false, false, false, "患者否认肝功能不全") || "",
  /special_population_high_risk/,
  "a negated special-population history must not become a generation-time contraindication",
);
const toxicMetadataM04 = structuredClone(m04);
Object.assign(toxicMetadataM04.formula.candidates[0], {
  formulaAnalysis: "围绕已锁定病机配伍。",
  applicable: "适用于本例证候病机。",
  notApplicable: "证候变化时不适用。",
});
toxicMetadataM04.formula.candidates[0].herbs[0] = {
  ...toxicMetadataM04.formula.candidates[0].herbs[0],
  name: "半夏",
  dose: "6g",
  function: getTcmHerbFunctionText("半夏"),
  decoctionRequirement: undefined,
};
const enrichedToxicMetadata = enrichReasoning(toxicMetadataM04).reasoning.formula.candidates[0];
assert.equal(enrichedToxicMetadata.herbs[0].isToxic, true);
assert.match(enrichedToxicMetadata.notApplicable, /逐味生成前安全边界.*半夏.*毒性/);
const generationSafetyPrompt = buildPrescribePrompt({
  patient: { sex: "女", age: 46 },
  chiefComplaint: "入睡困难",
  conversation: [],
  reasoningDiagnose: stable,
  reasoningV2: stable,
});
assert.match(generationSafetyPrompt, /生成前逐味安全边界/);
assert.match(generationSafetyPrompt, /毒性=/);
assert.match(generationSafetyPrompt, /孕期\/妊娠=(?:LOW|MEDIUM|HIGH)/);
const ordinaryTreatmentWithoutPositioning = structuredClone(m04);
const nonActionableDiet = structuredClone(m04);
nonActionableDiet.nonPharma.diet = "饮食清淡，避免辛辣油腻。";
assert.equal(
  m04SemanticIssue(nonActionableDiet, "", stable),
  "non_pharma_diet_not_actionable",
  "M04 diet 缺少具体普通食物/餐食示例时必须进入有限修复，不能靠呈现层静默隐藏",
);
const actionableDiet = structuredClone(m04);
actionableDiet.nonPharma.diet = "少量多餐，餐后3小时内不平卧；可用山药小米粥，每周3次。";
assert.notEqual(
  m04SemanticIssue(actionableDiet, "", stable),
  "non_pharma_diet_not_actionable",
  "具体饮食行为与餐食示例齐全时不得误驳回",
);
ordinaryTreatmentWithoutPositioning.nonPharma.tcmTreatments = [{
  projectCode: "acupuncture",
  targetRef: "P1",
  targetPathogenesis: "心血不足",
  protocolStatus: "governed_patient_specific_plan",
  treatmentContent: "围绕睡眠与情志症状进行辨证选穴，作为改善睡眠的辅助项目。",
  suggestedSitesOrPoints: ["印堂(EX-HN3)", "神门(HT7)", "内关(PC6)"],
  scheduleSuggestion: "可先按每周2次、连续2周评估症状变化。",
  techniqueBoundary: "具体选穴和操作参数须由现场医师查体后确定。",
  protocolSource: "项目级受控临床路径；穴位采用WHO标准命名。",
  operatorRequirement: "由具备相应资质的中医执业人员操作",
  requiredChecks: ["出血倾向与局部感染"],
  availability: "clinic_available",
  riskLevel: "moderate",
  recommendationMode: "clinician_assessment",
  executable: false,
  clinicianReviewRequired: true,
}];
assert.equal(
  m04SemanticIssue(ordinaryTreatmentWithoutPositioning, "", stable),
  undefined,
  "an ordinary onsite project remains valid after the non-distinguishing assessment-positioning field is omitted",
);
const assessmentOnlyTreatment = structuredClone(ordinaryTreatmentWithoutPositioning);
assessmentOnlyTreatment.nonPharma.tcmTreatments[0] = {
  ...assessmentOnlyTreatment.nonPharma.tcmTreatments[0],
  protocolStatus: "assessment_only_no_patient_specific_protocol",
  protocolGap: "当前目录缺少与该项目及本例适应证对应的受控操作方案。",
  suggestedSitesOrPoints: [],
  scheduleSuggestion: "",
};
assert.equal(
  m04SemanticIssue(assessmentOnlyTreatment, "", stable),
  undefined,
  "an assessment-only project remains valid only when patient-specific parameters are absent and the gap is explicit",
);
// 甲方评测(2026-08-03) 9.1 对齐：assessment_only 允许携带服务端聚合的**通用穴位参考**
// (呈现层标注「通用参考,未按本例适应证核定」),不再作为驳回条件——此前编译器发穴位、
// 合同禁穴位的自相矛盾把整方打死(模式二复发)。评估态的安全边界收敛为两条:
// 不得携带患者级频次/疗程,必须写明 protocolGap。
const genericPointsTreatment = structuredClone(assessmentOnlyTreatment);
genericPointsTreatment.nonPharma.tcmTreatments[0].suggestedSitesOrPoints = ["内关(通用参考)", "神门(通用参考)"];
assert.equal(
  m04SemanticIssue(genericPointsTreatment, "", stable),
  undefined,
  "assessment-only 允许服务端通用穴位参考,不得因此驳回整方",
);
const shellTreatment = structuredClone(assessmentOnlyTreatment);
shellTreatment.nonPharma.tcmTreatments[0].scheduleSuggestion = "每日1次，连做7日";
assert.match(
  m04SemanticIssue(shellTreatment, "", stable) || "",
  /assessment_parameters/,
  "assessment-only 携带患者级频次/疗程必须驳回",
);
// nonPharma.monitoring(metric/timing/trigger) 及其 5 个驳回码
// (monitoring_N_incomplete/_metric_semantics/_trigger_semantics/_duplicate/_metric_ungrounded)
// 已被自由文本 precautions 取代。原断言锁的是「条件句写进 metric 必须驳回整份 M04」——
// 那正是要消除的失败模式：一个建议性字段的措辞瑕疵不该作废一张已通过剂量、十八反、
// 特殊人群与审方的处方。现在改由编译层 zod 约束形状、畸形条目逐条丢弃。
//
// 因此这里锁住相反的不变量：注意事项无论写成什么样，都不得产生驳回码。
// 若日后有人在合同层给 precautions 加校验，这条会立刻失败。
const oddPrecautions = structuredClone(ordinaryTreatmentWithoutPositioning);
oddPrecautions.nonPharma.precautions = ["若入睡困难加重则复诊", "服药期间忌辛辣"];
assert.equal(
  m04SemanticIssue(oddPrecautions, "", stable),
  undefined,
  "注意事项是零驳回码的自由文本：措辞瑕疵不得作废整份 M04",
);
// 原本此处还有三条断言，分别锁 monitoring_0_trigger_semantics / _duplicate / _metric_ungrounded。
// 它们与上一条同源：都要求「一条建议性随访行的措辞或依据不合格 ⇒ 驳回整份 M04」。
// 该字段已移除，这三条随之失效。取代它们的不变量已在上面用 precautions 表达（零驳回码），
// 而「无依据的条目被剔除而不是被展示给医生」这一条移到编译层验证（见本文件后半段
// compileM04Proposal 的注意事项隔离用例）——那才是它现在真正生效的位置。
const blankTreatmentPositioning = structuredClone(ordinaryTreatmentWithoutPositioning);
blankTreatmentPositioning.nonPharma.tcmTreatments[0].assessmentPositioning = "   ";
assert.match(
  m04SemanticIssue(blankTreatmentPositioning, "", stable) || "",
  /non_pharma_treatment_0_positioning/,
  "a supplied positioning boundary must be meaningful rather than blank",
);
const genericTonicAsEmperor = structuredClone(m04);
genericTonicAsEmperor.formula.candidates[0].constructionType = "self_devised";
genericTonicAsEmperor.formula.candidates[0].formulaNames = [];
genericTonicAsEmperor.formula.candidates[0].herbs[0] = {
  ...genericTonicAsEmperor.formula.candidates[0].herbs[0],
  name: "山药",
  function: "补脾养胃，生津益肺，补肾涩精",
  prescriptionRole: "补脾益气",
};
genericTonicAsEmperor.formula.candidates[0].herbs[1] = {
  ...genericTonicAsEmperor.formula.candidates[0].herbs[1],
  name: "茯神",
  dose: "12g",
  function: "宁心安神",
  prescriptionRole: "宁心安神",
};
assert.match(
  m04SemanticIssue(genericTonicAsEmperor, "", {
    ...stable,
    overview: {
      ...stable.overview,
      recommendedFormulaDirection: "按已锁定病机与治法辨证组方",
      recommendedFormulaNames: [],
      formulaSelectionMode: "self_devised",
    },
  }) || "",
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

// === Emperor/therapy vocabulary alignment: KB function-text synonym families must map onto the
// same therapy concepts as the M03 therapy language (one therapy-herb mapping, fail-closed kept) ===
const qiStagnationPrior = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "脾胃气滞证", overallPathogenesis: "脾胃气滞，脘腹胀满", recommendedFormulaDirection: "行气除满", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "胃脘胀满", syndromeEvidence: "胃脘胀满", pathogenesis: "脾胃气滞", therapyDirection: "行气除满" }] },
  therapy: { overallPrinciple: "行气除满" },
};
const qiStagnationM04 = structuredClone(m04);
qiStagnationM04.overview = { primarySyndrome: "脾胃气滞证", overallPathogenesis: "脾胃气滞，脘腹胀满" };
qiStagnationM04.therapy = { overallPrinciple: "行气除满" };
qiStagnationM04.formula.candidates[0].name = "辨证组方";
qiStagnationM04.formula.candidates[0].formulaNames = [];
qiStagnationM04.formula.candidates[0].constructionType = "self_devised";
qiStagnationM04.formula.candidates[0].therapyMatch = "行气除满";
qiStagnationM04.formula.candidates[0].herbs = [
  { name: "厚朴", dose: "9g", role: "君", prescriptionRole: "下气除满", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "脾胃气滞", function: "下气，温中", decoctionRequirement: "" },
  { name: "陈皮", dose: "6g", role: "臣", prescriptionRole: "理气健脾", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "脾胃气滞", function: "理气健脾", decoctionRequirement: "" },
];
assert.equal(
  m04SemanticIssue(qiStagnationM04, "", qiStagnationPrior),
  undefined,
  "KB 下气/除满 synonyms map onto the same qi_regulate concept as the M03 行气除满 therapy",
);
const windHeatPrior = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "风热犯表证", overallPathogenesis: "风热犯表，肺卫失和", recommendedFormulaDirection: "疏风解表", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "流涕咽痛", syndromeEvidence: "流涕咽痛", pathogenesis: "风热犯表", therapyDirection: "疏风解表" }] },
  therapy: { overallPrinciple: "疏风解表" },
};
const windHeatM04 = structuredClone(m04);
windHeatM04.overview = { primarySyndrome: "风热犯表证", overallPathogenesis: "风热犯表，肺卫失和" };
windHeatM04.therapy = { overallPrinciple: "疏风解表" };
windHeatM04.formula.candidates[0].name = "辨证组方";
windHeatM04.formula.candidates[0].formulaNames = [];
windHeatM04.formula.candidates[0].constructionType = "self_devised";
windHeatM04.formula.candidates[0].therapyMatch = "疏风解表";
windHeatM04.formula.candidates[0].herbs = [
  { name: "金银花", dose: "10g", role: "君", prescriptionRole: "清热解毒，凉散风热", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "风热犯表", function: "清热解毒", decoctionRequirement: "" },
  { name: "薄荷", dose: "6g", role: "臣", prescriptionRole: "发散风热", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "风热犯表", function: "解表，发散风热", decoctionRequirement: "后下" },
];
const windHeatIssue = m04SemanticIssue(windHeatM04, "", windHeatPrior) || "";
assert.doesNotMatch(windHeatIssue, /emperor_therapy_mismatch/, "KB 凉散风热 must map onto exterior_release at the emperor layer");
assert.equal(
  windHeatIssue,
  "",
  "with 咽痛 documented in the chain anchor, the classic wind-heat emperor's heat_clear direction is supported by the record",
);
const windHeatNoHeatPrior = {
  ...windHeatPrior,
  pathogenesis: { chain: [{ ...windHeatPrior.pathogenesis.chain[0], patientFact: "流涕", syndromeEvidence: "流涕" }] },
};
const windHeatNoHeatIssue = m04SemanticIssue(windHeatM04, "", windHeatNoHeatPrior) || "";
assert.match(windHeatNoHeatIssue, /unsupported_high_impact_heat_clear/, "without any documented heat fact the heat direction stays governed by the separate high-impact layer");
const windHeatClearPrior = {
  ...windHeatPrior,
  pathogenesis: { chain: [{ ...windHeatPrior.pathogenesis.chain[0], therapyDirection: "疏风解表，清热解毒" }] },
  therapy: { overallPrinciple: "疏风解表，清热解毒" },
};
const windHeatClearM04 = structuredClone(windHeatM04);
windHeatClearM04.therapy = { overallPrinciple: "疏风解表，清热解毒" };
windHeatClearM04.formula.candidates[0].therapyMatch = "疏风解表，清热解毒";
assert.equal(
  m04SemanticIssue(windHeatClearM04, "", windHeatClearPrior),
  undefined,
  "with the heat direction present in the M03 therapy, the classic wind-heat emperor passes the full contract",
);
const stasisPrior = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "瘀血阻络证", overallPathogenesis: "瘀血阻络", recommendedFormulaDirection: "活血化瘀", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "刺痛固定", syndromeEvidence: "刺痛固定", pathogenesis: "瘀血阻络", therapyDirection: "活血化瘀" }] },
  therapy: { overallPrinciple: "活血化瘀" },
};
const stasisM04 = structuredClone(m04);
stasisM04.overview = { primarySyndrome: "瘀血阻络证", overallPathogenesis: "瘀血阻络" };
stasisM04.therapy = { overallPrinciple: "活血化瘀" };
stasisM04.formula.candidates[0].name = "辨证组方";
stasisM04.formula.candidates[0].formulaNames = [];
stasisM04.formula.candidates[0].constructionType = "self_devised";
stasisM04.formula.candidates[0].therapyMatch = "活血化瘀";
stasisM04.formula.candidates[0].herbs = [
  { name: "黄芪", dose: "15g", role: "君", prescriptionRole: "补气升阳", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "瘀血阻络", function: "补气升阳", decoctionRequirement: "" },
  { name: "陈皮", dose: "6g", role: "臣", prescriptionRole: "理气健脾", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "瘀血阻络", function: "理气健脾", decoctionRequirement: "" },
];
assert.match(
  m04SemanticIssue(stasisM04, "", stasisPrior) || "",
  /emperor_therapy_mismatch/,
  "a qi tonic with no blood-moving action still fails the emperor alignment (fail-closed kept)",
);

// === KB category-only records map onto concepts (补阴/补血), and documented heat facts support
// heat_clear high-impact usage (舌红苔薄黄 in the signed payload) without weakening other gates ===
const qiYinPrior = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "气阴两虚证", overallPathogenesis: "气阴两虚，津液不布", primarySyndromeBasis: ["口干乏力", "舌红少津少苔"], recommendedFormulaDirection: "益气养阴", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "口干乏力", syndromeEvidence: "口干乏力", pathogenesis: "气阴两虚", therapyDirection: "益气养阴" }] },
  therapy: { overallPrinciple: "益气养阴，生津止渴" },
};
const qiYinM04 = structuredClone(m04);
qiYinM04.overview = { primarySyndrome: "气阴两虚证", overallPathogenesis: "气阴两虚，津液不布" };
qiYinM04.therapy = { overallPrinciple: "益气养阴，生津止渴" };
qiYinM04.formula.candidates[0].name = "辨证组方";
qiYinM04.formula.candidates[0].formulaNames = [];
qiYinM04.formula.candidates[0].constructionType = "self_devised";
qiYinM04.formula.candidates[0].therapyMatch = "益气养阴，生津止渴";
qiYinM04.formula.candidates[0].herbs = [
  { name: "麦冬", dose: "10g", role: "君", prescriptionRole: "养阴生津", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "气阴两虚", function: getTcmHerbFunctionText("麦冬"), decoctionRequirement: "" },
  { name: "太子参", dose: "10g", role: "臣", prescriptionRole: "益气生津", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "气阴两虚", function: "益气健脾，益气生津，大补元气，补气，补肺；补气药；补虚药", decoctionRequirement: "" },
];
assert.equal(
  m04SemanticIssue(qiYinM04, "", qiYinPrior),
  undefined,
  "KB category-only 养阴 records (麦冬: 补虚药/补阴药) must map onto yin_nourish so the canonical emperor the shortlist recommends is not rejected as knowledge_missing",
);
const liverYangPrior = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "肝阳上亢证", overallPathogenesis: "肝阳上亢，扰动清窍", primarySyndromeBasis: ["头晕头胀", "项背强", "舌红苔薄黄"], recommendedFormulaDirection: "平肝潜阳", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "头晕头胀", syndromeEvidence: "头晕头胀", pathogenesis: "肝阳上亢，扰动清窍", therapyDirection: "平肝潜阳" }] },
  therapy: { overallPrinciple: "平肝潜阳" },
};
const liverYangM04 = structuredClone(m04);
liverYangM04.overview = { primarySyndrome: "肝阳上亢证", overallPathogenesis: "肝阳上亢，扰动清窍" };
liverYangM04.therapy = { overallPrinciple: "平肝潜阳" };
liverYangM04.formula.candidates[0].name = "辨证组方";
liverYangM04.formula.candidates[0].formulaNames = [];
liverYangM04.formula.candidates[0].constructionType = "self_devised";
liverYangM04.formula.candidates[0].therapyMatch = "平肝潜阳";
liverYangM04.formula.candidates[0].herbs = [
  { name: "天麻", dose: "10g", role: "君", prescriptionRole: "平肝息风", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "肝阳上亢，扰动清窍", function: "平肝息风药；息风止痉药", decoctionRequirement: "" },
  { name: "黄芩", dose: "6g", role: "佐", prescriptionRole: "清肝泻火", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "肝阳上亢，扰动清窍", function: "清热燥湿，泻火解毒，止血，安胎，利小肠；清热燥湿药；清热药", decoctionRequirement: "" },
];
assert.equal(
  m04SemanticIssue(liverYangM04, "", liverYangPrior),
  undefined,
  "documented heat facts in the signed payload (舌红苔薄黄) support a heat_clear high-impact herb tied to them even when the therapy text says only 平肝潜阳",
);
const liverYangNoHeatPrior = {
  ...liverYangPrior,
  overview: { ...liverYangPrior.overview, primarySyndromeBasis: ["头晕头胀", "项背强"] },
};
assert.match(
  m04SemanticIssue(liverYangM04, "", liverYangNoHeatPrior) || "",
  /herb_1_unsupported_high_impact_heat_clear/,
  "without documented heat facts the same 黄芩 row still rejects (heat_clear stays high-impact)",
);
const liverYangBloodM04 = structuredClone(liverYangM04);
liverYangBloodM04.formula.candidates[0].herbs[1] = {
  name: "川芎", dose: "6g", role: "佐", prescriptionRole: "活血行气", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "肝阳上亢，扰动清窍", function: "祛风止痛，活血止痛，活血行气，补肝，补血；活血化瘀药；活血止痛药", decoctionRequirement: "",
};
assert.match(
  m04SemanticIssue(liverYangBloodM04, "", liverYangPrior) || "",
  /herb_1_unsupported_high_impact_blood_move/,
  "the documented-facts support channel is heat_clear-only; other high-impact directions still require therapy-text support",
);

// === Concept-free declared intents (harmonizer 使药) must not expose secondary function-text
// high-impact actions for category-covered herbs; category-empty herbs keep the full expansion ===
const spleenQiPrior = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "脾胃虚弱证", overallPathogenesis: "脾胃虚弱，中焦气机不畅", primarySyndromeBasis: ["慢性胃炎5年", "轻度上腹隐痛"], recommendedFormulaDirection: "健脾益气", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [
    { nodeId: "P1", patientFact: "慢性胃炎5年", syndromeEvidence: "慢性胃炎5年", pathogenesis: "脾胃虚弱", therapyDirection: "健脾益气" },
    { nodeId: "P2", patientFact: "轻度上腹隐痛", syndromeEvidence: "轻度上腹隐痛", pathogenesis: "中焦气机不畅", therapyDirection: "理气和胃" },
  ] },
  therapy: { overallPrinciple: "健脾益气，和胃止痛" },
};
const spleenQiM04 = structuredClone(m04);
spleenQiM04.overview = { primarySyndrome: "脾胃虚弱证", overallPathogenesis: "脾胃虚弱，中焦气机不畅" };
spleenQiM04.therapy = { overallPrinciple: "健脾益气，和胃止痛" };
spleenQiM04.formula.candidates[0].name = "辨证组方";
spleenQiM04.formula.candidates[0].formulaNames = [];
spleenQiM04.formula.candidates[0].constructionType = "self_devised";
spleenQiM04.formula.candidates[0].therapyMatch = "健脾益气，和胃止痛";
spleenQiM04.formula.candidates[0].herbs = [
  { name: "党参", dose: "12g", role: "君", prescriptionRole: "健脾益气", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "脾胃虚弱", function: "补中益气，生津，补血，清肺，健脾；补气药；补虚药", decoctionRequirement: "" },
  { name: "白术", dose: "10g", role: "君", prescriptionRole: "健脾益气", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "脾胃虚弱", function: "健脾益气，燥湿利水，止汗，安胎；补气药；补虚药", decoctionRequirement: "" },
  { name: "茯苓", dose: "15g", role: "臣", prescriptionRole: "利水渗湿，健脾", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "脾胃虚弱", function: "利水渗湿，健脾，宁心安神；利水消肿药；利水渗湿药", decoctionRequirement: "" },
  { name: "陈皮", dose: "6g", role: "臣", prescriptionRole: "理气健脾", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, targetPathogenesis: "中焦气机不畅", function: "理气健脾，燥湿化痰，解鱼腥毒，调中，消痰；理气药", decoctionRequirement: "" },
  { name: "木香", dose: "6g", role: "佐", prescriptionRole: "行气止痛", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", targetPathogenesis: "调和诸药，协调药性", function: "行气止痛，健脾消食；理气药", decoctionRequirement: "后下" },
  { name: "炙甘草", dose: "3g", role: "使", prescriptionRole: "调和诸药", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", targetPathogenesis: "调和诸药，协调药性", function: "补脾益气，清热解毒，祛痰止咳，缓急止痛，调和诸药；补气药；补虚药", decoctionRequirement: "" },
];
assert.equal(
  m04SemanticIssue(spleenQiM04, "", spleenQiPrior),
  undefined,
  "a concept-free harmonizer intent (调和诸药) must not expose 甘草's secondary 清热解毒 function-text action as unsupported high-impact",
);
const freeTextIntentEscapeM04 = structuredClone(spleenQiM04);
freeTextIntentEscapeM04.formula.candidates[0].herbs[5] = {
  name: "翻白草", dose: "6g", role: "使", prescriptionRole: "调和诸药", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", targetPathogenesis: "调和诸药，协调药性", function: "清热解毒，凉血止血，凉血止痢，消肿，祛风湿", decoctionRequirement: "",
};
assert.match(
  m04SemanticIssue(freeTextIntentEscapeM04, "", spleenQiPrior) || "",
  /herb_5_unsupported_high_impact_heat_clear/,
  "a category-empty herb with concept-free intent keeps the full conservative expansion (no harmonizer escape hatch)",
);

// === Digestive/cardiac therapy-direction vocabulary: 化寒湿 tokenization, 泄热, 气血运行 ===
const coldDampPrior = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "寒湿困脾证", overallPathogenesis: "寒湿困脾", primarySyndromeBasis: ["腹泻腹痛2天", "舌淡苔白腻"], recommendedFormulaDirection: "温化寒湿", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "腹泻腹痛2天", syndromeEvidence: "腹泻腹痛2天", pathogenesis: "寒湿困脾", therapyDirection: "温化寒湿，健脾止泻" }] },
  therapy: { overallPrinciple: "温化寒湿，健脾止泻" },
};
const coldDampM04 = structuredClone(m04);
coldDampM04.overview = { primarySyndrome: "寒湿困脾证", overallPathogenesis: "寒湿困脾" };
coldDampM04.therapy = { overallPrinciple: "温化寒湿，健脾止泻" };
coldDampM04.formula.candidates[0].name = "辨证组方";
coldDampM04.formula.candidates[0].formulaNames = [];
coldDampM04.formula.candidates[0].constructionType = "self_devised";
coldDampM04.formula.candidates[0].therapyMatch = "温化寒湿，健脾止泻";
coldDampM04.formula.candidates[0].herbs = [
  { name: "苍术", dose: "9g", role: "君", prescriptionRole: "温化寒湿", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "寒湿困脾", function: "化湿药", decoctionRequirement: "" },
  { name: "厚朴", dose: "6g", role: "臣", prescriptionRole: "下气除满", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "寒湿困脾", function: "消痰下气，温中，止痛，温胃，益气；化湿药", decoctionRequirement: "" },
];
assert.equal(
  m04SemanticIssue(coldDampM04, "", coldDampPrior),
  undefined,
  "温化寒湿 must tokenize to damp_resolve for the canonical 苍术 emperor (化 and 湿 are separated by 寒)",
);
// Opposing-polarity invariant: concept-free harmonizer declarations (甘草 调和诸药) must not
// expose secondary function-text actions; concept-bearing secondary declarations (乌药 理气止痛
// hiding 温肾散寒) still reject against the locked therapy polarity.
const coldDampGanCaoM04 = structuredClone(coldDampM04);
coldDampGanCaoM04.formula.candidates[0].herbs.push(
  { name: "甘草", dose: "3g", role: "使", prescriptionRole: "调和诸药", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", targetPathogenesis: "调和诸药，协调药性", function: "补脾益气，清热解毒，祛痰止咳，缓急止痛，调和诸药；补气药；补虚药", decoctionRequirement: "" },
);
assert.equal(
  m04SemanticIssue(coldDampGanCaoM04, "", coldDampPrior),
  undefined,
  "a concept-free harmonizer 甘草 in a warm-direction formula must not be opposed for its secondary 清热解毒 catalog action",
);
const liverStomachHeatPrior = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "肝胃郁热证", overallPathogenesis: "肝胃郁热", primarySyndromeBasis: ["反酸烧心1月", "舌红苔薄黄"], recommendedFormulaDirection: "疏肝泄热", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "反酸烧心1月", syndromeEvidence: "反酸烧心1月", pathogenesis: "肝胃郁热", therapyDirection: "疏肝泄热，和胃降逆" }] },
  therapy: { overallPrinciple: "疏肝泄热，和胃降逆" },
};
const liverStomachHeatM04 = structuredClone(m04);
liverStomachHeatM04.overview = { primarySyndrome: "肝胃郁热证", overallPathogenesis: "肝胃郁热" };
liverStomachHeatM04.therapy = { overallPrinciple: "疏肝泄热，和胃降逆" };
liverStomachHeatM04.formula.candidates[0].name = "辨证组方";
liverStomachHeatM04.formula.candidates[0].formulaNames = [];
liverStomachHeatM04.formula.candidates[0].constructionType = "self_devised";
liverStomachHeatM04.formula.candidates[0].therapyMatch = "疏肝泄热，和胃降逆";
liverStomachHeatM04.formula.candidates[0].herbs = [
  { name: "黄连", dose: "5g", role: "君", prescriptionRole: "清热燥湿", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "肝胃郁热", function: "清热燥湿，泻火解毒，舒肝和胃，止呕；清热燥湿药；清热药", decoctionRequirement: "" },
  { name: "柴胡", dose: "6g", role: "臣", prescriptionRole: "疏肝解郁", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "肝胃郁热", function: "发散风热药；解表药", decoctionRequirement: "" },
];
assert.equal(
  m04SemanticIssue(liverStomachHeatM04, "", liverStomachHeatPrior),
  undefined,
  "泄热 must map to heat_clear so a 黄连 emperor for 肝胃郁热 intersects the primary therapy concepts",
);
const chestBiPrior = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "胸痹·功能失调候", overallPathogenesis: "胸膺脉气失调", primarySyndromeBasis: ["劳力性胸痛2年"], recommendedFormulaDirection: "调畅胸膺脉气", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "劳力性胸痛2年", syndromeEvidence: "劳力性胸痛2年", pathogenesis: "胸膺脉气失调", therapyDirection: "调畅胸膺脉气，助益气血运行" }] },
  therapy: { overallPrinciple: "调畅胸膺脉气，助益气血运行" },
};
const chestBiM04 = structuredClone(m04);
chestBiM04.overview = { primarySyndrome: "胸痹·功能失调候", overallPathogenesis: "胸膺脉气失调" };
chestBiM04.therapy = { overallPrinciple: "调畅胸膺脉气，助益气血运行" };
chestBiM04.formula.candidates[0].name = "辨证组方";
chestBiM04.formula.candidates[0].formulaNames = [];
chestBiM04.formula.candidates[0].constructionType = "self_devised";
chestBiM04.formula.candidates[0].therapyMatch = "调畅胸膺脉气，助益气血运行";
chestBiM04.formula.candidates[0].herbs = [
  { name: "丹参", dose: "12g", role: "君", prescriptionRole: "活血通经", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "胸膺脉气失调", function: "活血调经，化瘀止痛，活血散瘀，活血通经，祛瘀止痛；活血化瘀药；活血止痛药", decoctionRequirement: "" },
  { name: "川芎", dose: "6g", role: "臣", prescriptionRole: "活血行气", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "胸膺脉气失调", function: "祛风止痛，活血止痛，活血行气，补肝，补血；活血化瘀药；活血止痛药", decoctionRequirement: "" },
];
assert.equal(
  m04SemanticIssue(chestBiM04, "", chestBiPrior),
  undefined,
  "助益气血运行 must map to blood_move so the canonical 丹参 emperor for 胸痹 intersects",
);
const chestBiWrongEmperorM04 = structuredClone(chestBiM04);
chestBiWrongEmperorM04.formula.candidates[0].herbs[0] = {
  name: "葛根", dose: "12g", role: "君", prescriptionRole: "解肌", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "胸膺脉气失调", function: "发散风热药；解表药", decoctionRequirement: "",
};
assert.match(
  m04SemanticIssue(chestBiWrongEmperorM04, "", chestBiPrior) || "",
  /emperor_therapy_mismatch/,
  "an exterior-release emperor with no qi/blood-moving action still fails the 胸痹 emperor alignment (fail-closed kept)",
);
const launderingM04 = structuredClone(liverStomachHeatM04);
launderingM04.formula.candidates[0].herbs.push(
  { name: "乌药", dose: "6g", role: "佐", prescriptionRole: "理气止痛", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "肝胃郁热", function: "行气止痛，祛风止痛，理气止痛，温肾散寒，温中散寒；理气药", decoctionRequirement: "" },
);
assert.match(
  m04SemanticIssue(launderingM04, "", liverStomachHeatPrior) || "",
  /herb_2_unsupported_high_impact_yang_warm/,
  "a concept-bearing secondary declaration still cannot hide an opposing high-impact action (乌药 温肾散寒 vs 泄热)",
);
const leftGoldPrior = structuredClone(liverStomachHeatPrior);
leftGoldPrior.overview.recommendedFormulaNames = ["左金丸"];
leftGoldPrior.overview.formulaSelectionMode = "single";
leftGoldPrior.overview.recommendedFormulaDirection = "左金丸";
const leftGoldM04 = structuredClone(liverStomachHeatM04);
leftGoldM04.formula.candidates[0].name = "左金丸加减";
leftGoldM04.formula.candidates[0].formulaNames = ["左金丸"];
leftGoldM04.formula.candidates[0].constructionType = "classic";
leftGoldM04.formula.candidates[0].herbs = [
  { name: "黄连", dose: "5g", role: "君", prescriptionRole: "清泻肝火", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "肝胃郁热", function: getTcmHerbFunctionText("黄连"), decoctionRequirement: "" },
  { name: "吴茱萸", dose: "2g", role: "佐", prescriptionRole: "反佐制约苦寒并和胃降逆", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "temper", targetPathogenesis: "制约峻烈，缓和药性", function: getTcmHerbFunctionText("吴茱萸"), decoctionRequirement: "" },
];
assert.equal(
  m04SemanticIssue(leftGoldM04, "", leftGoldPrior),
  undefined,
  "the governed 左金丸 baseline must admit its verified 黄连-吴茱萸 counter-assistance structure",
);
const ungovernedCounterAssistance = structuredClone(leftGoldM04);
ungovernedCounterAssistance.formula.candidates[0].name = "本例辨证组方";
ungovernedCounterAssistance.formula.candidates[0].formulaNames = [];
ungovernedCounterAssistance.formula.candidates[0].constructionType = "self_devised";
assert.equal(
  m04SemanticIssue(ungovernedCounterAssistance, "", liverStomachHeatPrior),
  undefined,
  "a self-devised prescription may use the controlled 黄连-吴茱萸 counter-assistance structure when context, roles, targets, and doses all match",
);
const freeTextCounterAssistanceBypass = structuredClone(ungovernedCounterAssistance);
freeTextCounterAssistanceBypass.formula.candidates[0].herbs[1] = {
  ...freeTextCounterAssistanceBypass.formula.candidates[0].herbs[1],
  dose: "3g",
  role: "君",
  targetKind: "pathogenesis_node",
  targetRef: "P1",
  structureRole: null,
  targetPathogenesis: "肝胃郁热",
};
assert.match(
  m04SemanticIssue(freeTextCounterAssistanceBypass, "", liverStomachHeatPrior) || "",
  /unsupported_high_impact_yang_warm/,
  "free-text 反佐 cannot bypass polarity governance without the controlled secondary role, structure target, and dose boundary",
);
const wrongContextCounterAssistance = structuredClone(m04);
wrongContextCounterAssistance.formula.candidates[0].name = "本例辨证组方";
wrongContextCounterAssistance.formula.candidates[0].formulaNames = [];
wrongContextCounterAssistance.formula.candidates[0].constructionType = "self_devised";
wrongContextCounterAssistance.formula.candidates[0].herbs = structuredClone(ungovernedCounterAssistance.formula.candidates[0].herbs);
assert.notEqual(
  m04SemanticIssue(wrongContextCounterAssistance, "", stable),
  undefined,
  "the same pair cannot activate counter-assistance governance outside the signed liver-stomach heat context",
);

// === Colloquial herb names resolve through the governed alias registry to KB-known canonicals ===
for (const [alias, canonical] of [["杏仁", "苦杏仁"], ["元胡", "延胡索（元胡）"], ["双花", "金银花"], ["山栀", "栀子"], ["薏米", "薏苡仁"], ["枣仁", "酸枣仁"], ["枸杞", "枸杞子"]]) {
  assert.equal(canonicalTcmHerbIdentity(alias), canonical, `colloquial name ${alias} must resolve to ${canonical}`);
  assert.ok(isKnownTcmHerbName(canonicalTcmHerbIdentity(alias)), `the canonical for ${alias} must be KB-known so the repair hint can name it`);
}
assert.equal(canonicalTcmHerbIdentity("不存在药"), "不存在药", "an unregistered name must pass through unchanged (no invented canonical)");

// === Category-only KB records get their canonical pharmacopoeia direction via the governed
// supplement (柴胡: 疏肝解郁), and 调畅/调和…气血 maps to blood_move ===
const liverSpleenPrior = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "肝郁脾虚证", overallPathogenesis: "肝郁脾虚", primarySyndromeBasis: ["脘腹胀满半年", "压力大时明显"], recommendedFormulaDirection: "疏肝健脾", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [
    { nodeId: "P1", patientFact: "压力大时明显", syndromeEvidence: "压力大时明显", pathogenesis: "肝气郁结", therapyDirection: "疏肝解郁" },
    { nodeId: "P2", patientFact: "脘腹胀满半年", syndromeEvidence: "脘腹胀满半年", pathogenesis: "脾虚失运", therapyDirection: "健脾助运" },
  ] },
  therapy: { overallPrinciple: "因人制宜", overallMethod: "疏肝健脾" },
};
const liverSpleenM04 = structuredClone(m04);
liverSpleenM04.overview = { primarySyndrome: "肝郁脾虚证", overallPathogenesis: "肝郁脾虚" };
liverSpleenM04.therapy = { overallPrinciple: "因人制宜" };
liverSpleenM04.formula.candidates[0].name = "辨证组方";
liverSpleenM04.formula.candidates[0].formulaNames = [];
liverSpleenM04.formula.candidates[0].constructionType = "self_devised";
liverSpleenM04.formula.candidates[0].therapyMatch = "疏肝健脾";
liverSpleenM04.formula.candidates[0].herbs = [
  { name: "柴胡", dose: "6g", role: "君", prescriptionRole: "疏肝解郁", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "肝气郁结", function: "疏肝解郁", decoctionRequirement: "" },
  { name: "白术", dose: "10g", role: "臣", prescriptionRole: "健脾益气", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, targetPathogenesis: "脾虚失运", function: "健脾益气，燥湿利水，止汗，安胎；补气药；补虚药", decoctionRequirement: "" },
];
assert.equal(
  m04SemanticIssue(liverSpleenM04, "", liverSpleenPrior),
  undefined,
  "柴胡's generated category-only record must not invert its centrally governed 疏肝解郁 direction",
);
const headQiBloodPrior = {
  ...stable,
  overview: { ...stable.overview, primarySyndrome: "眩晕功能失调候", overallPathogenesis: "头部气血失调", primarySyndromeBasis: ["头晕头胀"], recommendedFormulaDirection: "调畅头部气血", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "头晕头胀", syndromeEvidence: "头晕头胀", pathogenesis: "头部气血失调", therapyDirection: "调畅头部气血，清利头目" }] },
  therapy: { overallPrinciple: "因人制宜", overallMethod: "调畅头部气血，安神定志" },
};
const headQiBloodM04 = structuredClone(m04);
headQiBloodM04.overview = { primarySyndrome: "眩晕功能失调候", overallPathogenesis: "头部气血失调" };
headQiBloodM04.therapy = { overallPrinciple: "因人制宜" };
headQiBloodM04.formula.candidates[0].name = "辨证组方";
headQiBloodM04.formula.candidates[0].formulaNames = [];
headQiBloodM04.formula.candidates[0].constructionType = "self_devised";
headQiBloodM04.formula.candidates[0].therapyMatch = "调畅头部气血，安神定志";
headQiBloodM04.formula.candidates[0].herbs = [
  { name: "川芎", dose: "10g", role: "君", prescriptionRole: "活血行气", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "头部气血失调", function: "祛风止痛，活血止痛，活血行气，补肝，补血；活血化瘀药；活血止痛药", decoctionRequirement: "" },
  { name: "酸枣仁", dose: "15g", role: "臣", prescriptionRole: "养心安神", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "头部气血失调", function: "养心补肝，宁心安神，敛汗生津；养心安神药；安神药", decoctionRequirement: "捣碎后同煎" },
];
assert.equal(
  m04SemanticIssue(headQiBloodM04, "", headQiBloodPrior),
  undefined,
  "调畅头部气血 must map to blood_move so a 川芎 emperor for the neutral 眩晕 shape intersects",
);
const headQiBloodWrongM04 = structuredClone(headQiBloodM04);
headQiBloodWrongM04.formula.candidates[0].herbs[0] = {
  name: "葛根", dose: "12g", role: "君", prescriptionRole: "解肌", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "头部气血失调", function: "发散风热药；解表药", decoctionRequirement: "",
};
assert.match(
  m04SemanticIssue(headQiBloodWrongM04, "", headQiBloodPrior) || "",
  /emperor_therapy_mismatch/,
  "an exterior-release emperor still fails the head qi-blood alignment (fail-closed kept)",
);
// ── 逐方向治法覆盖（甲方 2026-08-13 寒凝血瘀痛经）─────────────────────────────────
//
// 缺陷：M03 签名治法「温经散寒，活血化瘀，止痛」，主方当归/川芎/延胡索/白芍/甘草 全落在活血
// 一侧，承担寒凝主病机的温经散寒药一味没有（艾叶只在可选加减里）。既有覆盖判据是**比例阈值**
// （coveredRequired/coverageRequired < 0.5 才驳回），本例 2 条治法覆盖 1 条恰好 0.50 ⇒ 放行——
// 也就是「在治法里多写一条方中已经做到的活血化瘀，就把温经散寒缺药这件事稀释掉了」。
// 中医治法几乎总是 2–4 条并列，所以那道门在真实分布上几乎恒不触发。
//
// 方向集只取**已签名总治法**：逐节点 therapyDirection 由 m03NodeCoverageIssue 单独管，
// 且节点治法常含更细修饰语（实测「清利头目」被抽成 heat_clear，会把中性眩晕形态整类误报）。
{
  const coldStasisPrior = {
    ...stable,
    overview: { ...stable.overview, primarySyndrome: "寒凝血瘀证", overallPathogenesis: "寒凝胞宫，血行不畅",
      primarySyndromeBasis: ["经行冷痛，得热痛减"], recommendedFormulaDirection: "按已锁定病机与治法辨证组方",
      recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "经行冷痛", syndromeEvidence: "得热痛减",
      pathogenesis: "寒凝胞宫", therapyDirection: "温经散寒" }] },
    therapy: { overallPrinciple: "标本兼治", overallMethod: "温经散寒，活血化瘀，止痛" },
  };
  const bloodOnly = [
    { name: "当归", dose: "10g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1",
      function: "补血活血，调经止痛；补血药", targetPathogenesis: "寒凝胞宫", decoctionRequirement: "" },
    { name: "川芎", dose: "10g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P1",
      function: "活血行气，祛风止痛；活血化瘀药；活血止痛药", targetPathogenesis: "寒凝胞宫", decoctionRequirement: "" },
    { name: "延胡索", dose: "10g", role: "佐", targetKind: "pathogenesis_node", targetRef: "P1",
      function: "活血，行气，止痛；活血化瘀药；活血止痛药", targetPathogenesis: "寒凝胞宫", decoctionRequirement: "" },
  ];
  assert.deepEqual(
    uncoveredPrimaryTherapyDirections({ formula: { candidates: [{ herbs: bloodOnly }] } }, coldStasisPrior),
    ["yang_warm"],
    "治法写了温经散寒而方中无温里药时，必须逐方向报出——比例阈值会被并列的活血化瘀稀释掉",
  );
  // 补一味温里药即闭环。
  const withWarming = [...bloodOnly, { name: "艾叶", dose: "6g", role: "臣", targetKind: "pathogenesis_node",
    targetRef: "P1", function: "温经止血，散寒止痛；温里药", targetPathogenesis: "寒凝胞宫", decoctionRequirement: "" }];
  assert.deepEqual(
    uncoveredPrimaryTherapyDirections({ formula: { candidates: [{ herbs: withWarming }] } }, coldStasisPrior),
    [],
    "补入温里药后该方向必须判为已覆盖",
  );
  // 反向护栏一：总治法里没有高影响方向时整条不适用（不得对普通治法制造噪音）。
  assert.deepEqual(
    uncoveredPrimaryTherapyDirections({ formula: { candidates: [{ herbs: bloodOnly }] } },
      { ...coldStasisPrior, therapy: { overallPrinciple: "标本兼治", overallMethod: "健脾益气，调和营卫" } }),
    [],
    "总治法无高影响方向时不得报缺口",
  );
  // 走**接线**而不是只打谓词：只断言谓词的话，把 m04SemanticIssue 里那两行删掉也不会红
  // （第一版正是如此，负向自检发现的）。
  // 这里用源码级断言而不是端到端载荷：m04SemanticIssue 前面还有跨阶段锁定字段、君臣结构、
  // 治法对齐等十余道门，任何一道未满足都会先返回别的码，端到端夹具因此屡屡测不到本判据
  // ——那样的断言看着更"真"，实际是空转。源码断言守住的正是我真正在意的失败模式：接线被删。
  {
    const contractSource = readFileSync(new URL("../src/lib/diagnosis-stage-contract.ts", import.meta.url), "utf8");
    const t2Start = contractSource.indexOf("const coverageIssue = m03NodeCoverageIssue(reasoning, priorReasoning);");
    assert.ok(t2Start > 0, "找不到 T2 覆盖段——结构变了，本判据需要跟着搬家");
    const t2Block = contractSource.slice(t2Start, t2Start + 900);
    assert.match(
      t2Block,
      /uncoveredPrimaryTherapyDirections\(reasoning, priorReasoning\)/,
      "逐方向覆盖必须接在 m04SemanticIssue 的 T2 段内——只有谓词没有接线时医生仍看不到缺口",
    );
    assert.match(t2Block, /therapy_direction_uncovered_/, "接线必须发射 therapy_direction_uncovered_ 码族");
  }
  // 反向护栏二：分级必须是 T2，未登记的码默认 T1 会把它变成硬拦、整方 0 味。
  assert.equal(
    // 实际发射形态是 m04_<码>：T2 段返回裸码，调用方加 m04_ 前缀（与 pathogenesis_node_uncovered 同）。
    rejectionTier("m04_therapy_direction_uncovered_yang_warm"), "T2",
    "逐方向覆盖码必须登记为 T2；未登记默认 T1 会让它变成硬拦，与「质量问题标注、安全问题阻断」相悖",
  );
}

const highImpactModification = {
  ...m04,
  formula: {
    ...m04.formula,
    modifications: [{
      trigger: "入睡困难",
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
  overview: { ...stable.overview, primarySyndrome: "风邪恋肺证", recommendedFormulaDirection: "辨证组方", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ ...stable.pathogenesis.chain[0], pathogenesis: "风邪恋肺", therapyDirection: "疏散风邪，宣通肺气" }] },
  therapy: { overallPrinciple: "疏风宣肺" },
};
const windLungCandidate = {
  ...m04.formula.candidates[0],
  name: "辨证组方",
  formulaNames: [],
  constructionType: "self_devised",
  herbs: [
    { name: "荆芥", dose: "6g", role: "君", prescriptionRole: "疏散风邪", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "风邪恋肺", function: getTcmHerbFunctionText("荆芥"), decoctionRequirement: "后下" },
    { name: "桔梗", dose: "6g", role: "臣", prescriptionRole: "宣通肺气", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "风邪恋肺", function: getTcmHerbFunctionText("桔梗"), decoctionRequirement: "" },
  ],
};
const windLungVisiblePrescription = [
  `**煎服法**：${defaultMethod}`,
  "| 序号 | 药名 | 炮制/规格 | 剂量 | 君臣佐使 |",
  "|---|---|---|---|---|",
  "| 1 | 荆芥 | 后下 | 6g | 君 |",
  "| 2 | 桔梗 | 饮片 | 6g | 臣 |",
].join("\n");
for (const therapyMatch of ["疏散风邪，宣通肺气", "祛风解表，宣畅肺气"]) {
  const synonymousWindLungM04 = {
    ...m04,
    overview: { ...m04.overview, primarySyndrome: windLungPrior.overview.primarySyndrome },
    therapy: { ...windLungPrior.therapy },
    formula: { ...m04.formula, candidates: [{ ...windLungCandidate, therapyMatch }] },
  };
  assert.equal(
    m04SemanticIssue(synonymousWindLungM04, windLungVisiblePrescription, windLungPrior),
    undefined,
    `wind-lung synonymous therapy must align with the locked M03 direction: ${therapyMatch}`,
  );
}
const unrelatedWindLungM04 = {
  ...m04,
  overview: { ...m04.overview, primarySyndrome: windLungPrior.overview.primarySyndrome },
  therapy: { ...windLungPrior.therapy },
  formula: { ...m04.formula, candidates: [{ ...windLungCandidate, therapyMatch: "健脾益气" }] },
};
assert.equal(
  m04SemanticIssue(unrelatedWindLungM04, windLungVisiblePrescription, windLungPrior),
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
  overview: { ...stable.overview, primarySyndrome: "胃阴不足证", overallPathogenesis: "胃阴亏虚，虚热内生", recommendedFormulaDirection: "辨证组方", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "口干", syndromeEvidence: "口干", pathogenesis: "胃阴亏虚，虚热内生", therapyDirection: "滋阴清热，益胃生津" }] },
  therapy: { overallPrinciple: "滋阴清热，益胃生津" },
};
const alternateGovernedDoseM04 = {
  ...m04,
  overview: { ...m04.overview, primarySyndrome: "胃阴不足证", overallPathogenesis: "胃阴亏虚，虚热内生" },
  pathogenesis: yinDeficiencyPrior.pathogenesis,
  therapy: yinDeficiencyPrior.therapy,
  formula: { ...m04.formula, candidates: [{ ...m04.formula.candidates[0], name: "辨证组方", formulaNames: [], constructionType: "self_devised", therapyMatch: "滋阴清热，益胃生津", herbs: [
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
  overview: { ...stable.overview, primarySyndrome: "心脾两虚证", overallPathogenesis: "脾气不足，心血失养", recommendedFormulaDirection: "归脾汤加减方向", recommendedFormulaNames: ["归脾汤"], formulaSelectionMode: "single" },
  pathogenesis: { chain: [{ ...stable.pathogenesis.chain[0], pathogenesis: "脾气不足，心血失养", therapyDirection: "益气养血，健脾安神" }] },
  therapy: { overallPrinciple: "益气养血，健脾安神" },
};
const namedDirectionM04 = {
  ...m04,
  overview: { ...m04.overview, primarySyndrome: "心脾两虚证", overallPathogenesis: "脾气不足，心血失养", recommendedFormulaDirection: "归脾汤加减方向" },
  therapy: { overallPrinciple: "益气养血，健脾安神" },
  formula: { ...m04.formula, candidates: [{
    ...m04.formula.candidates[0],
    name: "归脾汤加减",
    formulaNames: ["归脾汤"],
    therapyMatch: "益气养血，健脾安神",
    herbs: [
      { ...m04.formula.candidates[0].herbs[0], targetPathogenesis: "脾气不足，心血失养" },
      { ...m04.formula.candidates[0].herbs[1], name: "当归", dose: "10g", prescriptionRole: "养血和营", targetPathogenesis: "脾气不足，心血失养", function: getTcmHerbFunctionText("当归"), decoctionRequirement: undefined },
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
const noFormulaLockedPrior = { ...namedDirectionPrior, overview: { ...namedDirectionPrior.overview, recommendedFormulaDirection: "按病机组方", recommendedFormulaNames: [], formulaSelectionMode: "none" } };
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
      { ...m04.formula.candidates[0].herbs[1], targetPathogenesis: namedDirectionPrior.pathogenesis.chain[0].pathogenesis },
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
const groundedM03IdContent = groundStructuredPatientFacts(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(stable)}\n<!-- DIAGNOSIS_JSON_END -->`, "患者入睡困难；舌淡；脉细");
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
for (const [leftName, rightName] of [["黄芪", "黄耆"], ["延胡索", "元胡"]]) {
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
assert.match(finalizedServerOwnedM04.formula.candidates[0].decoction.followUpNode, /完成5剂（5日）后复诊/);
assert.match(finalizedServerOwnedM04.formula.candidates[0].decoction.method, /约500mL/, "disease duration must not be misread as pediatric age");
// 需求7：方义保持**逐味**粒度（每味药都要读得出它在这张方里干了什么）。
//
// 2026-08-04 甲方复测 7.1/7.2 后改为**按病机分组**呈现：病机作组标题只写一次，组内逐味只写
// 「药名（角色）：功用」。逐味粒度没有减少——角色括号本身就是关系、组标题本身就是「承接哪条
// 病机」；删掉的是每行尾巴上那句对每张方逐字相同的关系模板（「为本方治疗支点」
// 「同承接上述病机」），以及与药味表「对应病机」列重复的整句病机引用。
{
  const analysis = finalizedServerOwnedM04.formula.candidates[0].formulaAnalysis;
  assert.match(analysis, /^方中/, "方义必须以本方药味配伍的连续临床叙述起笔");
  assert.match(analysis, /人参.*为君/s, "君药必须写明在本方中的作用");
  assert.match(analysis, /川芎.*为臣/s, "臣药必须写明在本方中的作用");
  assert.doesNotMatch(analysis, /\*\*|(?:^|\n)\s*[-#]\s/m,
    "方义不得包含会在医生页面裸露的 Markdown 标题或列表符号");
  assert.doesNotMatch(analysis, /；[一-龥]{1,8}药[」；]/, "功用文本不得携带药类归类尾巴(检索索引不是医生要读的方义)");
  assert.doesNotMatch(analysis, /的[;；]|围绕「[^」]*的」/, "治法方向串必须剥掉受控词表的「…的」后缀与分号连接");
  for (const herb of finalizedServerOwnedM04.formula.candidates[0].herbs) {
    assert.match(analysis, new RegExp(herb.name), `${herb.name} 必须保留在方义自然段中`);
  }
  for (const boilerplate of ["为本方治疗支点", "同承接上述", "承接次级病机", "协同君药同治"]) {
    assert.ok(!analysis.includes(boilerplate),
      `「${boilerplate}」对每张方逐字相同、不携带本例信息，已移除（甲方 2026-08-04 第 7.2 条）`);
  }
  assert.doesNotMatch(analysis, /。，/, "formula analysis must not join terminal punctuation into malformed prose");
  assert.doesNotMatch(analysis, /各药组共同形成/, "结尾套话不携带可核对内容，已移除");
}
const pediatricDecoctionContent = applyDeterministicDecoctionMethod(serverOwnedContent, "病程3个月；年龄：8岁");
const pediatricDecoction = JSON.parse(pediatricDecoctionContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.match(pediatricDecoction.formula.candidates[0].decoction.method, /约200mL/);
assert.equal(isCompleteM04Reasoning(finalizedServerOwnedM04, finalizedServerOwnedVisible, spleenDeficiencyPrior), true, m04SemanticIssue(finalizedServerOwnedM04, finalizedServerOwnedVisible, spleenDeficiencyPrior));
const validConditionalModification = {
  ...finalizedServerOwnedM04,
  formula: {
    ...finalizedServerOwnedM04.formula,
    modifications: [{
      trigger: "心悸健忘、纳差便溏",
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

const compiledProposalInput = {
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    therapyMatch: "养血安神",
    applicable: "心血不足",
    notApplicable: "证候变化时复核",
    herbs: [{ name: "酸枣仁", processing: ["炒"], dose: "15g", role: "君药", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, isToxic: false, decoctionRequirement: ["捣碎", "同煎"] }],
    formulaAnalysis: "酸枣仁养血安神",
    decoction: {
      doseCount: "5剂",
      dosesPerDay: 1,
      administrationTimesPerDay: 2,
      method: "每日1剂，浸泡30分钟，煎煮2次，合并药液400mL，每日分2次服",
      course: "5日",
      followUpNode: "完成5剂后复诊",
    },
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
    evidenceId: "EVID-INST-001",
    evidenceFingerprint: `sha256:${"1".repeat(64)}`,
    evidenceSource: "[EVID-INST-001] 药品说明书",
    relationship: "不与同成分制剂重复使用",
    riskNote: "复核过敏史和现用药",
  }],
  modifications: [{
    trigger: "入睡困难",
    targetRef: "P1",
    actionType: "add",
    herbName: "茯神",
    reason: "加强宁心安神",
  }],
  nonPharma: m04.nonPharma,
  overview: { primarySyndrome: "恶意覆盖" },
};
// 中成药「对应问题」必须对着**病历**核，不能只对着说明书核（甲方 2026-08-10）。
// 实测缺陷：病人没有黄痰、明确否认咽痛，中成药那一行的「对应问题」却写着
// 「风热犯肺所致的咳嗽、咳黄痰、咽痛」——说明书主治被整段搬了过来。
// evidence-source-validation 只校验它是否落在说明书适应证段内，那一关它是过的。
{
  const chartedCase = {
    id: "patent-problem", phase: "prescribe", patient: { sex: "男", age: 30 },
    chiefComplaint: "入睡困难3月",
    symptoms: { present: "入睡困难，多梦易醒，神疲乏力。否认咽痛，无咳痰" },
    tongue: "舌淡苔白", pulse: "脉细弱", conversation: [], vitals: {},
  };
  const polluted = {
    ...compiledProposalInput,
    patentAndWestern: [{
      ...compiledProposalInput.patentAndWestern[0],
      correspondingProblem: "风热犯肺所致的咳嗽、咳黄痰、咽痛、入睡困难",
    }],
  };
  const compiled = compileM04Proposal(polluted, stable, chartedCase);
  const problem = compiled?.formula?.patentAndWestern?.[0]?.correspondingProblem || "";
  assert.ok(problem, "中成药候选必须仍然生成，不能因为清洗把整条候选丢掉");
  assert.ok(!problem.includes("咳黄痰"), `病历没有的「咳黄痰」不得作为对应问题：${problem}`);
  assert.ok(!problem.includes("咽痛"), `病历明确否认的「咽痛」不得作为对应问题：${problem}`);
  assert.ok(problem.includes("入睡困难"), `病历确有的问题必须保留：${problem}`);
  // 不传 caseState 时逐字不变——这一层只增不减。
  const withoutChart = compileM04Proposal(polluted, stable);
  assert.equal(
    withoutChart?.formula?.patentAndWestern?.[0]?.correspondingProblem,
    "风热犯肺所致的咳嗽、咳黄痰、咽痛、入睡困难",
    "无病历可核时保持原样，不猜",
  );
}
const compiledProposal = compileM04Proposal(compiledProposalInput, stable);
assert.equal(compiledProposal?.overview, stable.overview, "M04 proposal cannot overwrite signed M03 overview");
assert.equal(compiledProposal?.pathogenesis, stable.pathogenesis, "M04 proposal cannot overwrite signed M03 pathogenesis");
assert.equal(compiledProposal?.formula?.candidates[0].herbs[0].processing, "炒");
assert.equal(compiledProposal?.formula?.candidates[0].herbs[0].role, "君");
assert.equal(compiledProposal?.formula?.candidates[0].herbs[0].decoctionRequirement, "捣碎、同煎");
assert.equal(compiledProposal?.formula?.candidates[0].herbs[0].verificationTier, "verified", "M04 compiler must attach a deterministic per-herb verification tier");
assert.equal(compiledProposal?.formula?.candidates[0].herbs[0].doseSource, "governed_boundary", "verified herb doses identify the governed boundary source");
// 措辞 2026-08-12 去内部口径词（甲方：知识库不对用户展示）——判据仍是「说清为什么定到这一档」，
// 只是不再用「受治理剂量边界」这种内部说法。数值区间必须仍在，否则这条说明就空了。
assert.match(compiledProposal?.formula?.candidates[0].herbs[0].verificationReasons?.[0] || "", /标准区间完成规则校验/, "verification metadata must explain why the tier was assigned");
assert.match(compiledProposal?.formula?.candidates[0].herbs[0].verificationReasons?.[0] || "", /\d+-\d+g/, "核验说明必须带上具体剂量区间");
assert.equal(compiledProposal?.formula?.modifications[0].targetPathogenesis, "心血不足");
assert.equal(compiledProposal?.formula?.modifications[0].action, "加茯神");
assert.equal(compiledProposal?.formula?.modifications[0].triggerSource?.sourceQuote, "入睡困难");
assert.match(compiledProposal?.formula?.modifications[0].evidence.source || "", /患者事实.*入睡困难.*P1/);
assert.match(compiledProposal?.formula?.modifications[0].riskNote || "", /药味工作台.+重新审方/, "conditional modifications must explain how to operationalize and re-audit an actual change");
// 注意事项(precautions)取代了随访监测三元组，隔离策略不变且必须可验证：逐条丢行、绝不驳回整份。
// 这是「非承重字段不得拥有整份输出的一票否决权」在编译层的落点。
const dirtyPrecautionsProposalInput = structuredClone(compiledProposalInput);
dirtyPrecautionsProposalInput.nonPharma.precautions = [
  "短",                                   // 过短，丢弃
  "服药期间每次加服黄连6g",                  // 含剂量级文字：自由文本不得成为绕过药味工作台与审方的剂量通道
  "注意事项待补充",                          // 占位语
  "服药期间忌浓茶、咖啡与酒",                 // 合格，保留
  "服药期间忌浓茶、咖啡与酒。",               // 归一化后重复，丢弃
];
const cleanedPrecautionsProposal = compileM04Proposal(dirtyPrecautionsProposalInput, stable);
assert.ok(
  cleanedPrecautionsProposal,
  "malformed optional precaution rows must not reject the otherwise valid prescription",
);
const keptPrecautions = cleanedPrecautionsProposal?.nonPharma.precautions || [];
assert.ok(
  keptPrecautions.some((item) => /忌浓茶/.test(item)),
  "a well-formed precaution survives cleaning",
);
assert.equal(
  keptPrecautions.some((item) => /黄连6g/.test(item)),
  false,
  "a dose-bearing precaution is dropped: free text must not become a dose channel that bypasses the herb workbench and rx-audit",
);
assert.equal(
  keptPrecautions.some((item) => /待补充/.test(item)),
  false,
  "placeholder precautions are dropped rather than shown to the clinician",
);
assert.equal(
  keptPrecautions.filter((item) => /忌浓茶/.test(item)).length,
  1,
  "precautions are de-duplicated after punctuation normalization",
);
// 全部被丢光时必须有确定性兜底，否则这个可选字段会从「丢行」退化成「空字段」。
const allDroppedPrecautionsInput = structuredClone(compiledProposalInput);
allDroppedPrecautionsInput.nonPharma.precautions = ["短", "待补充"];
const fallbackPrecautionsProposal = compileM04Proposal(allDroppedPrecautionsInput, stable);
assert.ok(
  (fallbackPrecautionsProposal?.nonPharma.precautions || []).length > 0,
  "the server supplies deterministic precautions when every submitted row is dropped",
);
assert.equal(compiledProposal?.formula?.patentAndWestern[0].route, undefined, "instruction-bound medicine candidates remain non-dose when a complete regimen was not server-bound");
assert.equal(compiledProposal?.formula?.patentAndWestern[0].recommendationMode, "candidate_review");
assert.equal(compiledProposal?.formula?.patentAndWestern[0].evidenceId, "EVID-INST-001");
const clinicalReviewPayload = buildM04ClinicalReviewPayload(
  { ...stable, contractSignature: "secret-signature", clinicalReview: { status: "accepted" }, irrelevantWorkflowBlob: "x".repeat(50_000) },
  { ...compiledProposal, contractSignature: "secret-signature", clinicalReview: { status: "accepted" }, irrelevantWorkflowBlob: "y".repeat(50_000) },
);
assert.equal(clinicalReviewPayload.prior.contractSignature, undefined, "review projection excludes signature and workflow metadata");
assert.equal(clinicalReviewPayload.candidate.contractSignature, undefined, "candidate review projection excludes final envelope metadata");
assert.equal(clinicalReviewPayload.candidate.formula.candidates[0].herbs[0].name, "酸枣仁", "review projection retains the clinically material herb plan");
assert.equal(clinicalReviewPayload.candidate.formula.candidates[0].herbs[0].targetPathogenesis, compiledProposal.formula.candidates[0].herbs[0].targetPathogenesis, "review projection retains the server-grounded pathogenesis target used to judge the herb role");
assert.equal(clinicalReviewPayload.candidate.formula.candidates[0].herbs[0].function, compiledProposal.formula.candidates[0].herbs[0].function, "review projection retains the governed herb function used to judge the emperor role");
assert.equal(clinicalReviewPayload.candidate.formula.candidates[0].herbs[0].prescriptionRole, compiledProposal.formula.candidates[0].herbs[0].prescriptionRole, "review projection retains the deterministic role explanation required by the reviewer");
assert.equal(clinicalReviewPayload.candidate.formula.candidates[0].applicable, compiledProposal.formula.candidates[0].applicable, "review projection retains the self-devised formula rationale required by the reviewer");
const selfDevisedReviewReasoning = structuredClone(compiledProposal);
selfDevisedReviewReasoning.formula.candidates[0].constructionType = "self_devised";
selfDevisedReviewReasoning.formula.candidates[0].applicable = "受控目录中的命名方未完整覆盖当前主证与病机链，故辨证组方。";
const selfDevisedReviewPayload = buildM04ClinicalReviewPayload(stable, selfDevisedReviewReasoning);
assert.equal(selfDevisedReviewPayload.candidate.formula.candidates[0].constructionType, "self_devised", "reviewer can distinguish a transparent self-devised plan from a falsely renamed classic formula");
assert.match(selfDevisedReviewPayload.candidate.formula.candidates[0].applicable, /命名方未完整覆盖/, "reviewer receives the rationale it is required to assess");
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
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日" },
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
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日" },
  },
  nonPharma: m04.nonPharma,
};
assert.match(m04ProposalIssueCode(duplicateHerbProposal, stable) || "", /candidate_herbs_1_name/, "duplicate herb rows are rejected before compilation and audit");
assert.equal(compileM04Proposal(duplicateHerbProposal, stable), undefined, "duplicate herb rows can never become a signed prescription");
for (const [leftName, rightName] of [["黄芪", "黄耆"], ["延胡索", "元胡"]]) {
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
for (const [alias, canonical] of [["杏仁", "苦杏仁"], ["双花", "金银花"], ["薏米", "薏苡仁"], ["枣仁", "酸枣仁"]]) {
  const aliasProposal = {
    schemaVersion: "tcm-cdss-m04-proposal-v1",
    candidate: {
      name: "本例辨证组方",
      herbs: [{ name: alias, processing: null, dose: "6g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null }],
      decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日" },
    },
    nonPharma: m04.nonPharma,
  };
  assert.equal(compileM04Proposal(aliasProposal, stable)?.formula?.candidates[0].herbs[0].name, canonical, `${alias} must be canonicalized once at the proposal boundary`);
}
const wrappedRegimenProposal = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "酸枣仁", processing: null, dose: "15g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null }],
    decoction: {
      doseCount: { value: 5, unit: "剂" },
      dosesPerDay: 1,
      administrationTimesPerDay: 2,
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
    decoction: {
      doseCount: "5剂",
      dosesPerDay: 1,
      administrationTimesPerDay: 2,
      method: [],
      course: "5日",
      followUpNode: { value: "" },
    },
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
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日" },
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
      trigger: "纳差便溏",
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
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日" },
  },
  patentAndWestern: [],
  modifications: [{ trigger: "纳差便溏", targetRef: "P1", actionType: "add", herbName: "乌药", reason: "加强理气止痛" }],
  nonPharma: m04.nonPharma,
}, heatQiPrior);
assert.deepEqual(compiledConditionalProposal?.formula?.modifications, [], "an opposing optional modification is omitted without discarding the current prescription");
const wrappedScalarRegimenProposal = {
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "本例辨证组方",
    therapyMatch: "与锁定治法无关的模型自由文本",
    herbs: [{ name: "黄连", processing: null, dose: "3g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null }],
    decoction: {
      doseCount: { value: "5剂" },
      dosesPerDay: 1,
      administrationTimesPerDay: 2,
      course: { text: "5日" },
    },
  },
  patentAndWestern: [],
  modifications: [],
  nonPharma: {
    diet: "饮食清淡",
    lifestyle: "规律作息",
    emotion: "调畅情志",
    acupointCare: "模型越权内容",
    tcmTreatments: ["acupuncture", "tuina", "moxibustion", "cupping"].map((projectCode) => ({ projectCode, targetRef: "P1" })),
    precautions: ["服药期间清淡饮食，症状加重时提前复诊"],
  },
};
assert.equal(m04ProposalIssueCode(wrappedScalarRegimenProposal, heatQiPrior), undefined, "scalar wrappers and extra optional project rows are normalized before schema validation");
const compiledWrappedRegimen = compileM04Proposal(wrappedScalarRegimenProposal, heatQiPrior);
assert.equal(compiledWrappedRegimen?.formula?.candidates?.[0]?.decoction?.doseCount, "5剂");
assert.equal(compiledWrappedRegimen?.formula?.candidates?.[0]?.therapyMatch, heatQiPrior.therapy.overallMethod || heatQiPrior.therapy.overallPrinciple, "M03 owns therapyMatch and prefers its concrete treatment method");
const optionalNarrativeObjectProposal = {
  ...wrappedScalarRegimenProposal,
  candidate: {
    ...wrappedScalarRegimenProposal.candidate,
    therapyMatch: { treatment: "模型自由文本", basis: "模型自由文本" },
    applicable: { condition: "模型自由文本", reason: "模型自由文本" },
    notApplicable: { condition: "模型自由文本", reason: "模型自由文本" },
    formulaAnalysis: { principle: "模型自由文本", composition: "模型自由文本" },
  },
};
assert.equal(
  m04ProposalIssueCode(optionalNarrativeObjectProposal, heatQiPrior),
  undefined,
  "malformed optional narrative objects are omitted instead of invalidating a dose-safe proposal",
);
const compiledOptionalNarrativeObject = compileM04Proposal(optionalNarrativeObjectProposal, heatQiPrior);
assert.equal(
  compiledOptionalNarrativeObject?.formula?.candidates?.[0]?.therapyMatch,
  heatQiPrior.therapy.overallMethod || heatQiPrior.therapy.overallPrinciple,
  "the signed M03 therapy lock replaces an ambiguous provider narrative object",
);
assert.match(
  compiledOptionalNarrativeObject?.formula?.candidates?.[0]?.notApplicable || "",
  /证候|病机|安全边界/,
  "the server supplies a governed not-applicable boundary after dropping an ambiguous optional object",
);
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
    validationContext: "健脾益气，渗湿止泻；健脾助运，渗湿止泻",
  },
  "compiler, canonicalizer and validator must share one concrete M03 therapy lock without treating a broad principle as herb-level evidence",
);
assert.deepEqual(
  getM03TherapyLock({
    therapy: { overallPrinciple: "养血安神", overallMethod: "待确认" },
    pathogenesis: { chain: [{ therapyDirection: "养血宁心" }] },
  }),
  {
    candidateMatch: "养血宁心",
    validationContext: "养血宁心",
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
const misplacedProposalSiblings = structuredClone(wrappedScalarRegimenProposal);
misplacedProposalSiblings.candidate.patentAndWestern = misplacedProposalSiblings.patentAndWestern;
misplacedProposalSiblings.candidate.modifications = misplacedProposalSiblings.modifications;
misplacedProposalSiblings.candidate.nonPharma = misplacedProposalSiblings.nonPharma;
delete misplacedProposalSiblings.patentAndWestern;
delete misplacedProposalSiblings.modifications;
delete misplacedProposalSiblings.nonPharma;
assert.equal(m04ProposalIssueCode(misplacedProposalSiblings, heatQiPrior), undefined, "unambiguous proposal-level siblings nested under candidate are lifted before full validation");
const compiledMisplacedProposalSiblings = compileM04Proposal(misplacedProposalSiblings, heatQiPrior);
assert.equal(compiledMisplacedProposalSiblings?.nonPharma?.acupointCare, null, "lifting misplaced siblings preserves server ownership of non-pharmacological fields");
assert.equal(compiledMisplacedProposalSiblings?.formula?.candidates?.[0]?.herbs?.[0]?.name, "黄连", "lifting misplaced siblings never changes the clinical herb plan");
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 0, strictFormulaIssue: "formula_reference_declassified", requestAborted: false }), false);
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 1, strictFormulaIssue: "formula_reference_declassified", requestAborted: false }), true);
// 治法覆盖率阈值（coverage/herb_support）按产品语义「安全问题阻断，质量问题标注」在修复
// 耗尽后带批注受理（实测网络医案 37/41 两例自汗因此 0 味）；结构缺失类（contract_missing）
// 仍然阻断——无从标注。
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 2, strictFormulaIssue: "formula_reference_declassified", therapyIssue: "transparent_therapy_coverage", requestAborted: false }), true);
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 2, strictFormulaIssue: "formula_reference_declassified", therapyIssue: "transparent_therapy_contract_missing", requestAborted: false }), false);
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 2, strictFormulaIssue: "formula_reference_declassified", requestAborted: true }), false);
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 2, strictFormulaIssue: "formula_reference_declassified", requestAborted: false }), true);
// 调用方在判定前已确定性剥离方剂身份并用剥离后的内容重跑严格合同，因此「无剩余方剂问题」
// （undefined）即代表以自拟方形态自证合格，必须可受理——否则模型保留方名时剩余缺陷叫
// composition_drift，同一件事（不能继承该经典身份）却让整方作废：实测麻黄汤 4 味小方被加到
// 9 味即 0 味出方，而方中每一味的剂量、配伍、君臣与病机引用都是通过的。
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 1, strictFormulaIssue: undefined, requestAborted: false }), true, "剥离身份后严格合同无剩余问题即可受理");
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 1, strictFormulaIssue: "", requestAborted: false }), true, "空字符串与 undefined 同义");
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 0, strictFormulaIssue: undefined, requestAborted: false }), false, "未完成定向修复轮不得直接降级");
// 治法覆盖率阈值改按「安全阻断，质量标注」：herb_support/coverage 是本系统词表上的
// 覆盖率，不是逐味安全事实（高影响方向门禁/剂量边界/配伍禁忌/特殊人群各自独立执行），
// 修复耗尽后带批注受理；结构缺失类照旧阻断。
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 1, strictFormulaIssue: undefined, therapyIssue: "transparent_therapy_herb_support", requestAborted: false }), true, "治法覆盖率阈值在修复耗尽后带批注受理");
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 1, strictFormulaIssue: undefined, therapyIssue: "transparent_therapy_unresolved", requestAborted: false }), false, "治法解析缺失（unresolved）不属于覆盖率阈值，照旧阻断");
// 剥离后仍存在的其他方剂身份问题（歧义/选择漂移/合方分项未核验）绝不因降级而放行。
for (const residual of ["formula_reference_ambiguous", "formula_reference_selection_drift", "formula_component_0_unverified", "formula_direction_drift", "formula_compilation_contract_missing"]) {
  assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 2, strictFormulaIssue: residual, requestAborted: false }), false, `剥离后仍报 ${residual} 时不得受理`);
}
// fixpoint 早退 / 编排超时 = 修复机会已被证明用尽，与「完成一轮修复」等价。
// 此前只认后者，于是 fixpoint 反而拿不到降级资格——而 fixpoint 的语义正是「再修也没用」。
// 实测：柴胡疏肝散 7/7 组成达标 + fixpoint 早退 → 无降级 → 0 味；同轮先完成过一轮修复的
// 麻黄汤/清胃散正常降级出方，差别只在到达方式。
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 0, repairExhausted: true, strictFormulaIssue: undefined, requestAborted: false }), true, "fixpoint/超时导致的修复耗尽必须与完成一轮修复等价");
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 0, repairExhausted: true, strictFormulaIssue: "formula_reference_declassified", requestAborted: false }), true, "修复耗尽 + 仅剩身份问题必须可降级");
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 0, repairExhausted: false, strictFormulaIssue: undefined, requestAborted: false }), false, "既未完成修复轮也未耗尽时不得降级——降级不是首轮捷径");
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 0, repairExhausted: true, strictFormulaIssue: undefined, therapyIssue: "transparent_therapy_coverage", requestAborted: false }), true, "修复耗尽后治法覆盖率阈值带批注受理（安全阻断，质量标注）");
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 0, repairExhausted: true, strictFormulaIssue: undefined, therapyIssue: "transparent_therapy_contract_missing", requestAborted: false }), false, "结构缺失类治法码照旧阻断——无从标注");
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 0, repairExhausted: true, strictFormulaIssue: "formula_reference_ambiguous", requestAborted: false }), false, "修复耗尽也不放行方名歧义");
assert.equal(canAcceptTransparentFormulaFallback({ completedRepairAttempts: 2, repairExhausted: true, strictFormulaIssue: undefined, requestAborted: true }), false, "请求已中止时一律不得降级");
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
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日" },
  },
  nonPharma: m04.nonPharma,
});
assert.equal(compileM04JsonObjectContent(proposalJson, stable)?.stage, "prescribe");
const trustedMedicine = {
  type: "西药",
  name: "右佐匹克隆",
  specification: "3mg",
  singleDose: null,
  frequency: null,
  route: null,
  usageBoundary: "仅供与接诊医生讨论，不构成处方、剂量或疗程医嘱。",
  course: null,
  positioning: "需医生评估",
  correspondingProblem: "失眠",
  evidenceId: "EVID-INST-101",
  evidenceFingerprint: `sha256:${"a".repeat(64)}`,
  relationship: "是否采用由医生决定。",
  riskNote: "核对说明书禁忌。",
};
const compiledWithTrustedMedicine = compileM04JsonObjectContent(proposalJson, stable, undefined, [trustedMedicine]);
assert.equal(compiledWithTrustedMedicine?.formula?.patentAndWestern[0]?.name, "右佐匹克隆", "the server-owned evidence plan survives a model proposal that omitted medicine candidates");
assert.equal(compiledWithTrustedMedicine?.formula?.patentAndWestern[0]?.recommendationMode, "discussion_only");
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
  // function 必须换成该药自己的 KB 功用：本用例钉的是「禁止同煎的药不得作为汤剂可执行」，
  // 而 m04SemanticIssue 命中第一个问题就短路返回。沿用上一味药的方义会让 function_ungrounded
  // 先触发，把本用例真正要钉的 route_not_decoction 挡在后面。
  //（换到这一步之前，服务端会在契约前把方义覆写成角色兜底句，掩盖了这一点——正是甲方 ⑤ 的形状。）
  const prohibited = { ...compiledAnnotatedHerb, formula: { candidates: [{ ...compiledAnnotatedHerb.formula.candidates[0], herbs: [{ ...compiledAnnotatedHerb.formula.candidates[0].herbs[0], name: herbName, function: getTcmHerbFunctionText(herbName).split(/[；;]/)[0], decoctionRequirement: null }] }] } };
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
    decoction: {
      doseCount: { value: 5, unit: "剂" },
      dosesPerDay: 1,
      administrationTimesPerDay: 2,
      course: { value: 5, unit: "日" },
    },
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
      decoction: { doseCount, dosesPerDay: 1, administrationTimesPerDay: 2, course },
    },
  }, stable);
  assert.equal(normalizedRegimen?.formula?.candidates[0].decoction.doseCount, "5剂", JSON.stringify({ doseCount, course }));
  assert.equal(normalizedRegimen?.formula?.candidates[0].decoction.course, "5日", JSON.stringify({ doseCount, course }));
}
for (const decoction of [
  [{ doseCount: 5, dosesPerDay: 1, administrationTimesPerDay: 2, course: 5 }],
  { value: { doseCount: { value: { number: 5 }, unitLabel: "剂" }, dosesPerDay: 1, administrationTimesPerDay: 2, course: { value: 5, unit: "日" } } },
  JSON.stringify({ doseCount: "五剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "五日" }),
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
      decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, ...(course == null ? {} : { course }) },
    },
  }, stable);
  assert.equal(normalizedRegimen?.formula?.candidates[0].decoction.course, "5日", JSON.stringify({ course }));
}
const normalizedModificationProposal = compileM04Proposal({
  ...wrappedProposal,
  modifications: [
    { trigger: "入睡困难", targetRef: { value: "P1" }, actionType: "添加", herbName: { value: "茯神" }, reason: "加强宁心安神" },
    { trigger: "无效可选行", targetRef: "P1", actionType: "自由发挥", herbName: "茯神", reason: "不得拖垮核心处方" },
    { trigger: "夜醒增多时", targetRef: "P1", actionType: "调整剂量", herbName: "酸枣仁", reason: "调整为20g后观察" },
    { trigger: "夜醒增多时", targetRef: "P1", actionType: "添加", herbName: "模型臆造草", reason: "未知药味必须丢弃" },
    { trigger: "夜醒增多时", targetRef: "P9", actionType: "添加", herbName: "远志", reason: "未知病机引用必须丢弃" },
    { trigger: "夜醒增多时", targetRef: "P1", actionType: "移除", herbName: "远志", reason: "不在当前处方的药味不能移除" },
  ],
}, stable);
assert.equal(normalizedModificationProposal?.formula?.modifications.length, 1, "controlled aliases normalize while malformed optional modifications are dropped");
assert.equal(normalizedModificationProposal?.formula?.modifications[0].action, "加茯神");
assert.ok((normalizedModificationProposal?.formula?.modificationReview?.droppedCount || 0) >= 1, "dropped optional modifications must be disclosed");
assert.match(normalizedModificationProposal?.formula?.modificationReview?.droppedReason || "", /未展示|缺少|不能回溯|未命中|冲突|剂量/);
const boundedModificationProposal = compileM04Proposal({
  ...wrappedProposal,
  modifications: ["茯神", "远志", "夜交藤", "合欢皮", "柏子仁"].map((herbName) => ({
    trigger: "入睡困难",
    targetRef: "P1",
    actionType: "add",
    herbName,
    reason: "加强宁心安神",
  })),
}, stable);
assert.equal(boundedModificationProposal?.formula?.modifications.length, 4, "conditional modifications remain bounded to four visible rows");
assert.equal(boundedModificationProposal?.formula?.modificationReview?.droppedCount, 1);
assert.match(boundedModificationProposal?.formula?.modificationReview?.droppedReason || "", /最多展示 4 条/);
const nestedCandidateProposal = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    proposal: {
      name: "酸枣仁汤加减",
      herbs: [{ name: "酸枣仁", dose: "15g", role: "monarch", targetKind: "pathogenesis_node", targetRef: "P1" }],
      decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日" },
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
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日" },
  }),
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(stringWrappedCandidate?.formula?.candidates[0].herbs[0].role, "臣", "a single JSON object wrapper is accepted without accepting extra prose");
const pathogenesisStructureNoise = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidates: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "酸枣仁", dose: "15g", role: "君药（养心安神）", targetKind: "病机节点", targetRef: "P1", structureRole: "不适用" }],
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日" },
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
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日" },
  },
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(explanatoryStructureRole?.formula?.candidates[0].herbs[0].structureRole, "harmonize", "explanatory suffixes must canonicalize to one controlled structure role");
const providerStructureRoleAlias = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "协调药势" }],
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日" },
  },
  nonPharma: m04.nonPharma,
}, stable);
assert.equal(providerStructureRoleAlias?.formula?.candidates[0].herbs[0].structureRole, "harmonize", "provider prose for a controlled formula role is normalized before schema validation");
const missingProviderStructureRole = compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "承担方内结构作用" }],
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日" },
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
    decoction: {
      doseCount: { value: 5, unit: "剂" },
      dosesPerDay: 1,
      administrationTimesPerDay: 2,
      course: { value: 5, unit: "日" },
    },
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
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日" },
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
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日" },
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
    decoction: {
      doseCount: "5剂",
      dosesPerDay: 1,
      administrationTimesPerDay: 2,
      course: { value: 5, unit: "g" },
    },
  },
  nonPharma: m04.nonPharma,
}, stable)?.formula?.candidates[0].decoction.course, "5日", "a redundant mass-like course value is discarded rather than becoming executable");
assert.equal(compileM04Proposal({
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "酸枣仁汤加减",
    herbs: [{ name: "酸枣仁", dose: "15g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1" }],
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "7日" },
  },
  nonPharma: m04.nonPharma,
}, stable)?.formula?.candidates[0].decoction.course, "5日", "the server derives the course from total doses and the submitted daily dose count");
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
  decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日" },
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
    correspondingProblem: "失眠", evidenceId: "EVID-INST-001", evidenceSource: "[EVID-INST-001] 药品说明书", relationship: "替代",
    riskNote: "复核禁忌",
  }],
}, stable);
assert.deepEqual(incompleteMedicineProposal?.formula?.patentAndWestern, [], "incomplete western or patent medicine regimens must not reach the visible candidate list");
const invalidPositioningMedicineProposal = compileM04Proposal({
  ...wrappedProposal,
  patentAndWestern: [{
    type: "中成药", name: "某中成药", specification: "每袋6g", singleDose: "6g", frequency: "每日2次",
    route: "口服", usageBoundary: "符合适应证时", course: "5日", positioning: "辅助治疗",
    correspondingProblem: "疼痛", evidenceId: "EVID-INST-001", evidenceFingerprint: `sha256:${"1".repeat(64)}`, evidenceSource: "[EVID-INST-001] 药品说明书", relationship: "替代",
    riskNote: "复核禁忌",
  }],
}, stable);
assert.ok(invalidPositioningMedicineProposal, "one invalid optional medicine must not discard the validated herbal candidate");
assert.deepEqual(invalidPositioningMedicineProposal?.formula?.patentAndWestern, [], "contract-invalid optional medicine items are dropped individually");

// ─── 药典炮制名必须继承母药的煎法要求 ───
// 煎法查表原本只有「手写别名表 + 前缀剥离」两条字面规则，覆盖不到药典正式炮制名：
// 「炮附片」的前缀「炮」不在剥离表里，「黑顺片」「朱砂粉」「燀苦杏仁」压根没有可剥离前缀，
// 于是整条煎法规则查不到——附子的**先煎、久煎**（乌头碱水解，煎法里最要紧的一条）直接丢失。
// 而炮附片/黑顺片正是药典正名、临床实际调配的形态。
// 此前没出事只因 isKnownTcmHerbName("炮附片")=false 让 M04 驳回整条候选，那是身份覆盖的
// 巧合而非安全规则；T9 身份表一扩（本轮 90→377）巧合就会失效。现兜底走 T9 受控归一。
for (const [processed, base] of [["炮附片", "附子"], ["黑顺片", "附子"], ["朱砂粉", "朱砂"], ["燀苦杏仁", "苦杏仁"]]) {
  assert.equal(
    requiredDecoctionRequirement(processed),
    requiredDecoctionRequirement(base),
    `炮制名 ${processed} 必须继承 ${base} 的煎法要求，否则 M04 会给出无煎法约束的剂量`,
  );
}
assert.match(requiredDecoctionRequirement("炮附片") || "", /先煎/, "附子类炮制名必须保留先煎要求");

// ─── 干品生地黄不得继承鲜地黄的剂量上限 ───
// 药典「地黄」条目一行里同时写着「鲜地黄 12～30g。生地黄 10～15g。」，解析只留了第一行，
// 因此仓库为生地黄硬编码了 10-15g 覆盖。但剂量归一走的是 doseCanonicalName（生地黄的剂量
// 条目挂在地黄下），于是 干地黄/细生地/大生地/怀生地 被一路归一成「地黄」，绕过该覆盖拿到
// 鲜品的 12-30g——上限翻倍。更糟的是两区间相交、sourceConflict 不置位，30g 一路判合规。
// 现改为先按身份正名（canonicalName=生地黄）查覆盖表。
for (const dried of ["生地黄", "生地", "干地黄", "细生地", "大生地", "怀生地"]) {
  const limit = getTcmHerbDoseLimit(dried);
  assert.equal(`${limit?.min}-${limit?.max}`, "10-15",
    `${dried} 是干品生地黄，药典 10-15g，不得继承鲜地黄 12-30g 的上限`);
}
const freshRehmannia = getTcmHerbDoseLimit("鲜生地");
assert.equal(`${freshRehmannia?.min}-${freshRehmannia?.max}`, "12-30",
  "鲜生地确系鲜品，应保留药典鲜地黄 12-30g，不可被干品覆盖误伤");

console.log(JSON.stringify({ cases: 382, failures: 0 }));

// ─── 病机/治法锚定词表的类覆盖（2026-07 甲方 10 例实测补上的三组缺口 + 对冲式二选一）───
// 实测：10 例中唯一的妇科病例四跑三塌，M03 反复 chain_incomplete。根因是锚定词表的**类缺口**：
//   ① 脏腑×火/热被写死成 心火|肝火 两个枚举——胃火炽盛、肺热壅盛整句锚不上；
//   ② 妇科/奇经病位（冲任/胞宫/血海）一个都没有——整个妇科的病机链被判未锚定；
//   ③ 动血/血分类（迫血妄行/热伏）缺失——血证通用病机语锚不上。
// 另有一类反向缺口：「可能为血热或肝火，需鉴别」是备选枚举不是结论，原逻辑把两个锚都算成
// 肯定结论、multiAnchor 反而给它加分。
{
  const { m03ChainNodeDiagnostics } = await import("../src/lib/diagnosis-stage-contract.ts");
  const nodeOf = (pathogenesis, therapyDirection) => m03ChainNodeDiagnostics({
    pathogenesis: { chain: [{ patientFact: "月经周期提前，经量多", syndromeEvidence: "舌红苔黄燥，脉滑", pathogenesis, therapyDirection }] },
  })[0];
  // 妇科/脏腑热/动血类病机必须锚定（每组一个代表 + 教科书写法）。
  for (const [pathogenesis, therapy] of [
    ["热扰冲任，迫血妄行", "清热凉血，固冲调经"],
    ["血分伏热，扰动血海", "清热凉血"],
    ["阳盛血热，冲任不固", "固冲摄血"],
    ["胃火炽盛，循经上攻", "清胃泻火"],
    ["肺热壅盛，肃降失司", "清肺化痰"],
    ["胆火上逆，枢机不利", "清胆和胃"],
  ]) {
    const node = nodeOf(pathogenesis, therapy);
    assert.ok(node.pathogenesisAnchored, `病机「${pathogenesis}」必须锚定——这一类此前把妇科整科拦在 M03 外`);
    assert.ok(node.therapyAnchored, `治法「${therapy}」必须锚定`);
  }
  // 占位与对冲式二选一必须仍拒。
  for (const pathogenesis of ["待进一步明确", "可能为血热或肝火，需鉴别", "血热或肝火", "病机不详"]) {
    assert.ok(!nodeOf(pathogenesis, "清热凉血").pathogenesisAnchored,
      `「${pathogenesis}」是占位或备选枚举，不得判为已锚定`);
  }
  // 对冲规则不误伤：单锚从句带「或」（病因层备选）不受影响。
  assert.ok(nodeOf("情志不遂或饮食不节，郁而化火", "疏肝泻火").pathogenesisAnchored,
    "病因层的或-备选（非锚词）不影响真锚「化火」");
  // ④ 动宾/主谓两种语序必须都收。实测（观测字段 pathogenesisUnanchored）：同一妇科病例的
  // P2「热扰心神，热盛伤津」整条落空——表里只有主谓序的「神扰」「津伤」，没有动宾序的
  // 「扰心神」「伤津」，chain_incomplete 三连塌、M03 归零。补的是两个族不是两个词。
  for (const [pathogenesis, therapy] of [
    ["热扰心神，热盛伤津", "清热凉血，养阴安神"],
    ["痰火扰神，心神不安", "清热化痰，宁心安神"],
    ["热盛伤津，肠燥便秘", "清热生津，润肠通便"],
    ["邪热耗气伤阴，气阴两伤", "益气养阴"],
    ["燥热灼津，肺失濡润", "清燥润肺"],
    ["温邪化燥，内扰营血", "清营凉血"],
  ]) {
    const node = nodeOf(pathogenesis, therapy);
    assert.ok(node.pathogenesisAnchored, `病机「${pathogenesis}」必须锚定——动宾语序此前整族缺失`);
    assert.ok(node.therapyAnchored, `治法「${therapy}」必须锚定`);
  }
  // 补动宾语序不得让空泛叙述蒙混过关：仍须命中真实病机词，纯症状/占位照旧拒。
  for (const pathogenesis of ["患者自诉近日不适", "情况较前变化", "需结合检查判断"]) {
    assert.ok(!nodeOf(pathogenesis, "清热凉血").pathogenesisAnchored,
      `「${pathogenesis}」无病机措辞，不得判为已锚定`);
  }
}

// ─── 锁定方 + 基于症状的加减（产品既定需求）与两条安全边界 ─────────────────────
// 类问题：高影响方向的成立依据此前只认 M03 治法文本（heat_clear 例外有事实通道）。
// 于是一味有明确症状指征的加味药被判「方向未成立」，连带整张方作废——实测感冒-风寒束表
// 锁麻黄汤：基准四味齐全、川芎冲的是已记录的「头身疼痛」，全方 0 味。
// 症状事实通道推广到全部高影响方向后，加减成立；对立方向否决与特异性收窄同时保住。
{
  const priorOf = (fact, therapy) => ({
    stage: "diagnose",
    overview: { primarySyndrome: "风寒束表证", recommendedFormulaNames: ["麻黄汤"], formulaSelectionMode: "single", primarySyndromeBasis: [fact] },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: fact, syndromeEvidence: "脉浮紧，苔薄白", pathogenesis: "风寒束表，卫阳被遏", therapyDirection: therapy }] },
    therapy: { overallPrinciple: therapy, overallMethod: therapy },
  });
  const windCold = priorOf("恶寒发热，无汗，头身疼痛明显", "辛温解表，宣肺平喘");
  assert.equal(highImpactHerbDirectionIssue("川芎", "祛风止痛", windCold), undefined,
    "已记录痛证支撑活血方向：锁定麻黄汤基础上按症状加川芎必须成立");
  assert.match(highImpactHerbDirectionIssue("川芎", "祛风止痛", priorOf("恶寒发热，无汗，咳嗽", "辛温解表，宣肺平喘")) || "",
    /unsupported_high_impact_blood_move/, "无痛证无瘀象时活血方向仍不成立——事实通道不是免检通道");
  assert.equal(highImpactHerbDirectionIssue("大黄", "泻下攻积", priorOf("大便干结，三日未解，腹胀满", "清热泻火")), undefined,
    "腑实事实支撑通下方向");
  // 对立方向一票否决不受事实通道影响。
  assert.match(highImpactHerbDirectionIssue("附子", "温阳散寒", priorOf("发热，口渴，舌红苔黄", "清热解毒")) || "",
    /unsupported_high_impact_yang_warm/, "清热证里的温阳药照旧驳回");
  assert.match(highImpactHerbDirectionIssue("黄连", "清热燥湿", priorOf("畏寒肢冷，脘腹冷痛", "温阳散寒")) || "",
    /unsupported_high_impact_heat_clear/, "温阳证里的清热药照旧驳回");
  // 特异性收窄：泛见舌脉不得支撑高影响方向。
  assert.match(highImpactHerbDirectionIssue("附子", "温阳散寒", priorOf("入睡困难，舌淡脉细", "养血安神")) || "",
    /unsupported_high_impact_yang_warm/, "舌淡脉细是血虚舌脉，不得支撑温阳方向");
  assert.match(highImpactHerbDirectionIssue("麝香", "开窍醒神", priorOf("失眠多梦，心神不宁", "养血安神")) || "",
    /unsupported_high_impact_orifice_open/, "失眠多梦属安神范畴，不得支撑开窍方向");
}

// ─── 固化否定式症状名不得传播否定作用域 ────────────────────────────────────────
// 「无汗」是伤寒表实的症状名本身，「无」是构词成分而非作用于后续列举的否定运算符。
// 实测：「恶寒发热，无汗，头身疼痛明显」中「头身疼痛」被重写成「无头身疼痛」，针对该痛证
// 加的川芎因此被判方向未成立；把「无汗」挪到句尾同一份病历就通过——语序敏感即缺陷证据。
{
  const priorWith = (fact) => ({
    stage: "diagnose",
    overview: { primarySyndrome: "风寒束表证", primarySyndromeBasis: [fact] },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: fact, syndromeEvidence: "脉浮紧", pathogenesis: "风寒束表", therapyDirection: "辛温解表" }] },
    therapy: { overallPrinciple: "辛温解表" },
  });
  for (const fact of ["恶寒发热，无汗，头身疼痛明显", "恶寒发热，头身疼痛明显，无汗", "头身疼痛明显"]) {
    assert.equal(highImpactHerbDirectionIssue("川芎", "祛风止痛", priorWith(fact)), undefined,
      `「${fact}」中的痛证必须被识别，不得因语序不同而结论相反`);
  }
  // 真否定仍必须生效：整句否认痛证时不得放行。
  assert.match(highImpactHerbDirectionIssue("川芎", "祛风止痛", priorWith("恶寒发热，否认头身疼痛")) || "",
    /unsupported_high_impact_blood_move/, "明确否认的症状不得支撑加味方向");
  assert.match(highImpactHerbDirectionIssue("川芎", "祛风止痛", priorWith("恶寒发热，无头身疼痛")) || "",
    /unsupported_high_impact_blood_move/, "「无+症状」形式的真否定仍按否定处理");
}

// ─── 硬安全合同必须尊重 isSafetyReason 谓词 ───────────────────────────────────
// 类问题：该参数曾被 `void` 掉，于是 tier 表判为非安全的码（chain_incomplete=T2）也被当作
// 硬安全项返回；而带批注受理要求 safetyIssue 为空 —— 两个判定源对同一码结论相反，
// 整条受理路径成为死代码（实测线上从未触发过一次），链节点措辞不稳的病例一律归零。
// 同时必须保证：跳过非安全码后**继续检查后续项**，否则靠前的非安全码会掩盖真正的安全项。
{
  const { isSafetyRejection } = await import("../src/lib/diagnosis-rejection-tiers.ts");
  const ctxStable = "入睡困难；舌淡脉细";
  assert.equal(m03SemanticIssue(stable, ctxStable, ""), undefined, "基线 fixture 必须是干净的，否则下面的断言测不到目标码");
  // 链节点措辞不稳 = chain_incomplete：语义层照报，硬安全层放行（可带批注受理）。
  const incomplete = JSON.parse(JSON.stringify(stable));
  incomplete.pathogenesis.chain[0].therapyDirection = "待进一步明确";
  assert.equal(m03SemanticIssue(incomplete, ctxStable, ""), "chain_incomplete", "语义层必须照常报出链不完整");
  assert.equal(m03SafetyContractIssue(incomplete, ctxStable, isSafetyRejection), undefined,
    "chain_incomplete 在 tier 表是 T2/非安全，硬安全合同注入谓词后必须放行，否则带批注受理是死代码");
  assert.equal(m03SafetyContractIssue(incomplete, ctxStable), "chain_incomplete",
    "不传谓词时保持既有严格行为，既有调用方不受影响");
  // 链为空 = chain_empty：T1，任何谓词下都必须拦。
  const empty = JSON.parse(JSON.stringify(stable));
  empty.pathogenesis.chain = [];
  assert.equal(m03SafetyContractIssue(empty, ctxStable, isSafetyRejection), "chain_empty",
    "chain_empty 是 T1 硬安全项，必须照旧拦截");
  // 关键不变量：非安全码不得掩盖它后面真正的安全项。
  const both = JSON.parse(JSON.stringify(stable));
  both.pathogenesis.chain[0].therapyDirection = "待进一步明确";
  both.pathogenesis.chain[0].patientFact = "夜间盗汗伴午后潮热";
  const bothIssue = m03SafetyContractIssue(both, ctxStable, isSafetyRejection);
  assert.ok(bothIssue && /ungrounded/.test(bothIssue),
    `跳过非安全码后必须继续检查并报出真正的安全项，实得 ${bothIssue}`);
}

// ─── 症状指征通道必须覆盖非高影响方向 ───────────────────────────────────────
// 本表原本只为高影响门禁而建（清热/温阳/活血/泻下/开窍/软坚），于是君臣支撑率那道门里，
// 一味按症状加的解表药/敛汗药永远算不出依据——既不在治法文本里，也没有事实通道可走。
// 实测 3 例自汗案（治法「益气固表，敛汗止汗」，方为玉屏风散合牡蛎散类）全部因此 0 味：
// 防风走表祛风，「背部常有恶寒感」「发热恶风」都已记录在案，却被判成不落在任何已成立方向上。
{
  const factCases = [
    ["背部常有恶寒感，汗出清冷", "exterior_release"],
    ["自汗已三年，稍动则汗出浸衣", "astringe"],
    ["入睡困难，多梦易醒，心悸", "calm_spirit"],
    ["咳嗽咳痰，气促作喘", "cough_relieve"],
    ["纳差腹胀，大便稀溏", "spleen_support"],
    ["神疲乏力，气短懒言", "qi_tonify"],
    ["胁胀嗳气，情志不畅", "qi_regulate"],
  ];
  for (const [factText, concept] of factCases) {
    const prior = {
      ...stable,
      pathogenesis: {
        ...stable.pathogenesis,
        chain: [{ ...stable.pathogenesis.chain[0], patientFact: factText }],
      },
    };
    const supported = priorDocumentedFactConcepts(prior);
    assert.ok(supported.has(concept),
      `已记录事实「${factText}」应当支撑 ${concept}，实际：${[...supported].join(",") || "(空)"}`);
  }
  // 反向：高影响方向的收窄口径不得被本次扩表放宽——恶寒是表证主症，不能支撑温里。
  const coldPrior = {
    ...stable,
    pathogenesis: {
      ...stable.pathogenesis,
      chain: [{ ...stable.pathogenesis.chain[0], patientFact: "发热恶寒，周身骨节疼痛" }],
    },
  };
  assert.ok(!priorDocumentedFactConcepts(coldPrior).has("yang_warm"),
    "恶寒是表证主症，对应治法是解表而非温里，不得支撑 yang_warm（附子类会被误放行）");
}

// ─── 绝对硬核黑名单 vs tier 分级：单一权威(内伤发热类归零的根修) ─────────────────
// 此前 m03SafetyContractIssue 内部有一套「可豁免白名单」只收 chain_incomplete，与 tier 表
// 分叉成两套权威：tier 判 T2 的 literal(副词重组)/followup_safety_net 在硬安全层仍被当安全项
// 返回 → 带批注受理的 safetyIssue 恒非空 → 受理死路径。实测终版 50 例的全部 4 次 M03 归零，
// 终结码全是 tier 表明说可受理的 T2 码(literal ×1 例、chain_incomplete ×3 例)。
// 现在绝对硬核是黑名单(结构缺失/剂量内容/极性相反/中性舌象/当前锚点缺失)，其余交 tier 谓词。
{
  const { isSafetyRejection } = await import("../src/lib/diagnosis-rejection-tiers.ts");
  const ctxStable = "入睡困难；舌淡脉细";
  // literal(副词重组)：谓词注入下必须放行——这是 case「小腹部发热」类连中 4 轮归零的码。
  const literal = JSON.parse(JSON.stringify(stable));
  literal.pathogenesis.chain[0].patientFact = "夜间入睡困难明显";   // 重组措辞，非原文逐字
  const literalCode = m03SemanticIssue(literal, ctxStable, "");
  if (literalCode && /_literal$/.test(literalCode)) {
    assert.equal(m03SafetyContractIssue(literal, ctxStable, isSafetyRejection), undefined,
      "literal(副词重组)在 tier 表是 T2，硬安全层不得再当安全项返回");
  }
  // followup_safety_net_not_actionable：管理段文档质量项，谓词注入下放行。
  const noNet = JSON.parse(JSON.stringify(stable));
  noNet.management = { ...(noNet.management || {}), followupSafetyNet: "" };
  const netIssue = m03SafetyContractIssue(noNet, ctxStable, isSafetyRejection);
  assert.ok(netIssue === undefined || !/followup_safety_net/.test(netIssue),
    `随访安全网表述不完整不得阻断辨证结论，实得 ${netIssue}`);
  // 极性相反：绝对硬核，任何谓词都不放。ctx 明确「无汗」，事实却断言「汗出」。
  const polar = JSON.parse(JSON.stringify(stable));
  const polarCtx = `${ctxStable}；否认盗汗`;
  polar.pathogenesis.chain[0].patientFact = "盗汗明显";
  const polarIssue = m03SafetyContractIssue(polar, polarCtx, isSafetyRejection);
  assert.ok(polarIssue && /_polarity$/.test(polarIssue),
    `与病历极性相反的断言必须被绝对硬核拦截，实得 ${polarIssue}`);
  // 恶意谓词(全部判非安全)也压不掉绝对硬核。
  const empty2 = JSON.parse(JSON.stringify(stable));
  empty2.pathogenesis.chain = [];
  assert.equal(m03SafetyContractIssue(empty2, ctxStable, () => false), "chain_empty",
    "绝对硬核黑名单不受谓词影响——chain_empty 在任何谓词下都拦");
}
