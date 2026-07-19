import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: true,
  alias: { "@": `${process.cwd()}/src` },
});
const {
  abortDiagnosisRun,
  hasRecordedMeasuredVitals,
  hasExecutableM03Diagnosis,
  hasExplicitNonDosePrescriptionResult,
  getStepStatus,
  buildCompleteReport,
  buildDecisionSummary,
  differentiationScoreCaption,
  enrichEvidenceReferenceForDisplay,
  errorRequiresM03Refresh,
  maxQuestionRoundNotice,
  parseQuestionItems,
  prescriptionRiskLabel,
  nextRunningStageClock,
  requiresLimitedCandidateReview,
  resolveToggleChipPanelPosition,
  resolvePrescriptionDisplay,
  resolveSufficiencyDisplay,
  runningStageElapsedSeconds,
  scrubReportPhi,
  stageErrorDisplay,
  WORKBENCH_REFRESH_WARNING,
} = await jiti.import("../src/app/diagnosis/DiagnosisClient.tsx");

const offsetViewportPosition = resolveToggleChipPanelPosition(
  { top: 720, bottom: 752, right: 600 },
  { width: 360, height: 500, offsetLeft: 80, offsetTop: 300 },
  240,
);
assert.deepEqual(
  offsetViewportPosition,
  { top: 474, left: 108, width: 320, maxHeight: 402 },
  "floating observation menus must stay inside a scrolled and offset visual viewport",
);

const collectClock = nextRunningStageClock(null, "collect", 1_000);
assert.equal(runningStageElapsedSeconds(collectClock, "collect", 6_900), 5);
assert.equal(nextRunningStageClock(collectClock, "collect", 7_000), collectClock, "the same stage must retain its start time");
const diagnoseClock = nextRunningStageClock(collectClock, "diagnose", 7_000);
assert.equal(runningStageElapsedSeconds(diagnoseClock, "diagnose", 7_900), 0, "elapsed time must restart when M01-M05 advances to a new stage");
assert.equal(runningStageElapsedSeconds(collectClock, "diagnose", 7_900), 0, "a stale stage clock must never leak cumulative time into the next stage");

const cancellableRun = new AbortController();
assert.equal(abortDiagnosisRun(cancellableRun), true);
assert.equal(cancellableRun.signal.aborted, true, "cancelling a long diagnosis run must abort its active request chain");
assert.equal(abortDiagnosisRun(cancellableRun), false, "cancelling an already aborted run must be idempotent");

assert.equal(hasExplicitNonDosePrescriptionResult({ prescription: "当前不展示剂量级候选方药。" }), true);
assert.equal(hasExplicitNonDosePrescriptionResult({ prescription: "当前不展示剂量级候选方药。" }, true), false);
assert.equal(hasExplicitNonDosePrescriptionResult({ prescription: "归脾汤加减，酸枣仁15g。" }), false);
const { buildCaseAwareQuestionFallback, ensureQuestionStructuredEnvelope, ensureSingleRoundQuestionContract } = await jiti.import("../src/lib/m02-question-contract.ts");
const { isStableM03Reasoning } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const {
  buildDiagnosePrompt,
  buildPrescribePrompt,
} = await jiti.import("../src/lib/diagnosis-prompts.ts");
const {
  sanitizeCaseStateForBrowserPersistence,
  scrubPersistentPhiText,
} = await jiti.import("../src/lib/diagnosis-engine.ts");
const {
  applyDeterministicCandidateTherapyMatch,
  groundStructuredPatientFacts,
  normalizeDiagnoseConfidenceAndLabels,
} = await jiti.import("../src/lib/diagnosis-visible-summary.ts");

const sparseM03WithoutChain = [
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    overview: { overallPathogenesis: "胃失和降，气机不畅", overallTherapy: "理气和胃" },
    therapy: { overallPrinciple: "调畅气机", overallMethod: "理气和胃" },
    pathogenesis: { chain: [] },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n");
const sparseM03Json = JSON.parse(sparseM03WithoutChain.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.deepEqual(sparseM03Json.pathogenesis.chain, [], "an empty model pathogenesis chain must remain empty instead of being synthesized from the chief complaint");
assert.equal(isStableM03Reasoning(sparseM03Json), false, "the M03 contract must reject an empty pathogenesis chain");
const groundedDigestiveFactsContent = groundStructuredPatientFacts([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    stage: "diagnose",
    westernDiagnosis: { primary: { name: "功能性消化不良", supportingFacts: ["饭后上腹胀满"] } },
    pathogenesis: { chain: [] },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"), '主诉：饭后上腹胀满、嗳气3个月\n{"presentHistory":"进食后加重，伴早饱纳差、大便偏溏；无呕血黑便"}');
const groundedDigestiveFacts = JSON.parse(groundedDigestiveFactsContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.match(JSON.stringify(groundedDigestiveFacts.westernDiagnosis.primary.supportingFacts), /大便偏溏/, "recorded branch-changing digestive facts must survive M03 grounding");
const lateSymptomFieldContent = groundStructuredPatientFacts([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    stage: "diagnose",
    westernDiagnosis: { primary: { name: "功能性消化不良", supportingFacts: ["饭后腹胀"] } },
    pathogenesis: { chain: [] },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"), '主诉：饭后腹胀\n{"presentHistory":"病程三个月；进食后加重；伴早饱；偶有嗳气；纳差；大便偏溏；无黑便呕血"}\n舌淡胖\n脉缓弱\n神志清楚');
const lateSymptomFieldJson = JSON.parse(lateSymptomFieldContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.match(JSON.stringify(lateSymptomFieldJson.westernDiagnosis.primary.supportingFacts), /大便偏溏/, "an authoritative symptom field is retained as a whole instead of losing late clauses to an arbitrary fact cap");
const jsonArtifactGroundingContent = groundStructuredPatientFacts([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    stage: "diagnose",
    westernDiagnosis: { primary: { name: "功能性消化不良", supportingFacts: ["大便偏溏"] } },
    pathogenesis: { chain: [] },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"), '{"presentHistory":"进食后腹胀，大便偏溏；无黑便"}');
const jsonArtifactGroundingJson = JSON.parse(jsonArtifactGroundingContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.doesNotMatch(JSON.stringify(jsonArtifactGroundingJson.westernDiagnosis.primary.supportingFacts), /\\?"presentHistory\\?"/, "serialized CaseState keys must never leak into clinician-facing supporting facts");

const therapyLockedM04 = applyDeterministicCandidateTherapyMatch(
  '<!-- DIAGNOSIS_JSON_START -->\n{"stage":"prescribe","formula":{"candidates":[{"therapyMatch":"补益心脾"}]}}\n<!-- DIAGNOSIS_JSON_END -->',
  {
    therapy: { overallPrinciple: "虚则补之", overallMethod: "健脾益气，养心安神" },
    pathogenesis: { chain: [{ therapyDirection: "健脾益气" }, { therapyDirection: "养心安神" }] },
  },
);
const therapyLockedM04Json = JSON.parse(therapyLockedM04.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(therapyLockedM04Json.formula.candidates[0].therapyMatch, "健脾益气，养心安神", "M04 must inherit the signed M03 treatment method instead of regenerating a synonym");

const plainProviderQuestion = [
  "请问您平时怕冷还是怕热？或者手脚有没有特别凉或热的感觉？",
  "（追问理由：寒热偏好可改变中医证候权重和甲状腺鉴别方向。）",
  "补录字段：问诊补充",
  "可选项：",
  "A. 患者诉怕冷，手脚发凉，喜温喜热饮",
  "B. 患者诉怕热，手心足心发热，喜凉饮",
  "C. 暂不清楚/无明显感觉",
].join("\n");
const parsedPlainQuestion = parseQuestionItems(plainProviderQuestion);
assert.equal(parsedPlainQuestion.length, 1, "a provider may omit Markdown bolding without bypassing the M02 stop");
assert.equal(parsedPlainQuestion[0].options.length, 3);
assert.deepEqual(parsedPlainQuestion[0].fields, ["问诊补充"], "the per-question autofill target must survive parsing for free-text answers");
const normalizedRounds = normalizeCaseStateInput({ questionRounds: 9, maxQuestionRounds: 9 });
assert.equal(normalizedRounds.questionRounds, 1, "restored state must never exceed the single M02 round contract");
const sparseFallback = buildCaseAwareQuestionFallback({ chiefComplaint: "夜间盗汗、睡不好一个月", symptoms: {} });
const sparseQuestionState = { chiefComplaint: "夜间盗汗、睡不好一个月", symptoms: {} };
const repairedSingleQuestion = ensureSingleRoundQuestionContract("**问题1：** 这次不适持续多久？\n（追问理由：病程影响鉴别。）\n补录字段：现病史\n可选项：\nA. 一周内\nB. 一月以上\nC. 本次未取得该信息", sparseFallback, sparseQuestionState);
assert.equal(parseQuestionItems(repairedSingleQuestion).length, 1, "one valid model question remains one; the contract must not invent filler");
assert.match(repairedSingleQuestion, /这次不适持续多久/);
assert.match(sparseFallback, /加重、缓解还是反复波动/, "provider failure uses one generic clinical fallback rather than a disease keyword template");

const tonguePulseCollection = parseQuestionItems([
  "**问题1：** 本次是否已经取得舌象和脉象实况？",
  "（追问理由：舌脉可提高证候与病机判断把握度，但本次未取得也可以继续。）",
  "补录字段：舌象/脉象",
  "可选项：",
  "A. 已取得舌象和脉象，请在‘其他’记录实况",
  "B. 仅取得其中一项，请在‘其他’记录实况",
  "C. 本次未取得该信息",
].join("\n"))
  .find((item) => /舌象和脉象/.test(item.question));
assert.ok(tonguePulseCollection, "an optional tongue/pulse collection question must remain parseable when the model ranks it into the top two");
assert.equal(tonguePulseCollection.options[0]?.requiresDetail, true, "choosing 'already collected' must require the actual observation");
assert.equal(tonguePulseCollection.options[0]?.patch, undefined, "a workflow label must never be written into tongue or pulse fields as a clinical fact");
const modelRankedQuestions = [
  "**问题1：** 您吃完饭后是马上腹胀，还是过一会儿才明显？\n（追问理由：时间关系有助于判断诱因。）\n补录字段：现病史\n可选项：\nA. 马上\nB. 过一会儿\nC. 本次未取得该信息",
  "**问题2：** 按压腹部后感觉如何？\n（追问理由：缓解方式有助于辨证。）\n补录字段：现病史\n可选项：\nA. 舒服些\nB. 更难受\nC. 本次未取得该信息",
].join("\n\n");
const preservedModelRanking = ensureSingleRoundQuestionContract(modelRankedQuestions, sparseFallback, sparseQuestionState);
assert.equal(parseQuestionItems(preservedModelRanking).length, 2);
assert.ok(preservedModelRanking.indexOf("马上腹胀") < preservedModelRanking.indexOf("按压腹部"), "the model owns clinical ranking when both questions satisfy the interaction contract");

const fiveQuestions = Array.from({ length: 5 }, (_, index) => `**问题${index + 1}：** 第${index + 1}个问题？\n（追问理由：测试。）\n补录字段：问诊补充\n可选项：\nA. 是\nB. 否\nC. 本次未取得该信息`).join("\n\n");
assert.equal(parseQuestionItems(ensureSingleRoundQuestionContract(fiveQuestions)).length, 2, "the one-round contract must cap provider output to two branch-changing questions");
const repairedEmptyQuestion = ensureSingleRoundQuestionContract("本次未输出可解析问题。", sparseFallback);
const fallbackItems = parseQuestionItems(repairedEmptyQuestion);
assert.equal(fallbackItems.length, 1, "provider formatting failure yields one safe generic question and does not recreate a keyword expert system");
assert.match(fallbackItems[0].question, /加重、缓解还是反复波动/);
assert.doesNotMatch(repairedEmptyQuestion, /证候归纳|病机关联|安全边界|确定性安全门控/);
const missingQuestionEnvelope = ensureQuestionStructuredEnvelope(repairedEmptyQuestion);
assert.match(missingQuestionEnvelope, /DIAGNOSIS_JSON_START/);
assert.match(missingQuestionEnvelope, /"completeness":\{"level":"B"/);
const malformedQuestionEnvelope = ensureQuestionStructuredEnvelope(`${repairedEmptyQuestion}\n\n<!-- DIAGNOSIS_JSON_START -->\n{bad json}\n<!-- DIAGNOSIS_JSON_END -->`);
assert.equal((malformedQuestionEnvelope.match(/DIAGNOSIS_JSON_START/g) || []).length, 1, "a malformed provider envelope is replaced instead of leaving M02 retry-only");
const lowValueQuestions = [
  "**问题1：** 患者最喜欢什么颜色？\n（追问理由：了解个人偏好。）\n补录字段：问诊补充\n可选项：\nA. 红色\nB. 蓝色\nC. 本次未取得该信息",
  "**问题2：** 患者从事什么职业？\n（追问理由：完善个人资料。）\n补录字段：问诊补充\n可选项：\nA. 办公室工作\nB. 体力工作\nC. 本次未取得该信息",
].join("\n\n");
const repairedLowValue = ensureSingleRoundQuestionContract(lowValueQuestions, sparseFallback, sparseQuestionState);
assert.equal(parseQuestionItems(repairedLowValue).length, 1);
assert.doesNotMatch(repairedLowValue, /喜欢什么颜色|从事什么职业/);
assert.match(repairedLowValue, /加重、缓解还是反复波动/);

const duplicateCourseQuestions = [
  "**问题1：** 这次不适持续多久？\n（追问理由：病程影响判断。）\n补录字段：现病史\n可选项：\nA. 一周内\nB. 一月以上\nC. 本次未取得该信息",
  "**问题2：** 症状是什么时候起病的？\n（追问理由：起病时间影响判断。）\n补录字段：现病史\n可选项：\nA. 近期突然出现\nB. 已反复较久\nC. 本次未取得该信息",
].join("\n\n");
const repairedDuplicates = ensureSingleRoundQuestionContract(duplicateCourseQuestions, sparseFallback, sparseQuestionState);
assert.ok(parseQuestionItems(repairedDuplicates).length <= 2);

const multiQuestionWithNestedReason = [
  "**问题1：** 夜间汗出是在睡着后出现，醒后会缓解吗？",
  "（追问理由：夜间汗出（俗称盗汗）会改变阴虚与营卫不和的证候权重。）",
  "补录字段：问诊补充",
  "可选项：",
  "A. 睡着后汗出，醒后缓解",
  "B. 白天活动时也容易汗出",
  "C. 本轮暂无法确认",
  "",
  "**问题2：** 近一个月是否伴发热、咳嗽或体重下降？",
  "（追问理由：用于区分单纯睡眠问题与感染等现代医学鉴别方向。）",
  "补录字段：现病史",
  "可选项：",
  "A. 均无",
  "B. 有其中一项",
  "C. 本轮暂无法确认",
].join("\n");
const parsedMultiQuestion = parseQuestionItems(multiQuestionWithNestedReason);
assert.equal(parsedMultiQuestion.length, 2, "one M02 round must preserve multiple independent questions");
assert.equal(parsedMultiQuestion[0].question, "夜间汗出是在睡着后出现，醒后会缓解吗？");
assert.match(parsedMultiQuestion[0].reason, /俗称盗汗.*证候权重/);
assert.doesNotMatch(parsedMultiQuestion[0].question, /追问理由|俗称盗汗/);

const inlineReasonQuestion = [
  "**问题1：** 孩子是否出现呼吸费力或口唇发紫？（追问理由：用于识别儿童呼吸窘迫红旗。）",
  "补录字段：现病史",
  "可选项：",
  "A. 有上述表现",
  "B. 经询问未见上述表现",
  "C. 本次未取得该信息",
].join("\n");
const parsedInlineReasonQuestion = parseQuestionItems(inlineReasonQuestion);
assert.equal(parsedInlineReasonQuestion[0].question, "孩子是否出现呼吸费力或口唇发紫？", "an inline reason must not leak into the visible question");
assert.equal(parsedInlineReasonQuestion[0].reason, "用于识别儿童呼吸窘迫红旗。", "an inline reason remains available in the dedicated reason row");

const promptConversationFixture = {
  id: "prompt-conversation-fixture",
  patient: {},
  chiefComplaint: "夜里总出汗，睡不好，大概一个月",
  symptoms: {},
  tongue: "",
  pulse: "",
  faceNote: "",
  vitals: {},
  conversation: [
    { role: "user", content: "主诉：夜里总出汗，睡不好，大概一个月" },
    { role: "assistant", content: plainProviderQuestion },
    { role: "user", content: "问题1：暂不清楚/无明显感觉" },
  ],
  completeness: { level: "A", redFlag: 0.2, infoGain: 0.2, managementImpact: 0.2, answerability: 0.2 },
  questionRounds: 1,
  maxQuestionRounds: 1,
};
for (const prompt of [buildDiagnosePrompt(promptConversationFixture), buildPrescribePrompt(promptConversationFixture)]) {
  assert.ok(prompt.includes("问题1：暂不清楚/无明显感觉"), "the submitted patient answer must remain in downstream model context");
  assert.ok(!prompt.includes("患者诉怕冷，手脚发凉，喜温喜热饮"), "unanswered AI options must never enter downstream clinical facts");
}

const stableM03 = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  contractSignatureVersion: "tcm-cdss-m03-signature-v4",
  contractSignature: `hmac-sha256:${"a".repeat(64)}`,
  overview: { primarySyndrome: "心肝血虚证", overallPathogenesis: "血不养心，心神失舍" },
  westernDiagnosis: {
    primary: {
      name: "失眠障碍倾向",
      supportingFacts: ["入睡困难"],
      evidence: { evidenceLevel: "model_inference", source: "基于本例已提供症状" },
    },
  },
  pathogenesis: { chain: [{ patientFact: "入睡困难", syndromeEvidence: "舌淡脉细", pathogenesis: "心血不足", therapyDirection: "养血安神" }] },
  therapy: { overallPrinciple: "养血安神，疏肝解郁" },
};

for (const clinicalText of ["黄芪", "捣碎后同煎", "健脾益气", "完成5剂后复诊"]) {
  assert.equal(
    scrubPersistentPhiText(clinicalText),
    clinicalText,
    `clinical content must not be mistaken for a patient name: ${clinicalText}`,
  );
}
assert.doesNotMatch(scrubPersistentPhiText("张三昨夜失眠"), /张三/);
assert.doesNotMatch(scrubPersistentPhiText("患者王小明今日来诊"), /王小明/);
const scrubbedExport = scrubReportPhi(
  "姓名：王小明；年龄95岁；出生日期：1930-02-03；职业：大学教授；主诉失眠。",
  { patient: { name: "王小明" }, hisRecord: { fields: { patientName: "王小明" } } },
);
assert.doesNotMatch(scrubbedExport, /王小明|95岁|1930|大学教授/);
assert.match(scrubbedExport, /90岁以上/);
const rareOccupationCase = normalizeCaseStateInput({
  chiefComplaint: "失眠",
  patient: { sex: "男", age: 42, occupation: "大学教授" },
});
const completeScrubbedExport = scrubReportPhi(buildCompleteReport(rareOccupationCase), rareOccupationCase);
assert.doesNotMatch(completeScrubbedExport, /occupation|大学教授/, "the real report builder never exports a rare occupation quasi-identifier");

const stableM04 = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  contractSignature: `hmac-sha256:${"b".repeat(64)}`,
  overview: { primarySyndrome: "脾气虚证", overallPathogenesis: "脾气不足，运化失健" },
  pathogenesis: stableM03.pathogenesis,
  therapy: { overallPrinciple: "健脾益气" },
  formula: {
    candidates: [{
      name: "本例辨证组方",
      herbs: [
        { name: "黄芪", dose: "15g", decoctionRequirement: "无特殊煎服要求" },
        { name: "酸枣仁", dose: "15g", decoctionRequirement: "捣碎后同煎" },
      ],
    }],
    modifications: [],
  },
};
const persistenceFixture = {
  id: "display-persistence-fixture",
  phase: "done",
  patient: { name: "张三", sex: "男", age: 42, occupation: "教师" },
  chiefComplaint: "张三昨夜失眠",
  symptoms: { detail: "患者张三今日来诊，乏力纳差" },
  completeness: { level: "C", redFlag: 0, infoGain: 1, managementImpact: 1, answerability: 1 },
  questionRounds: 1,
  maxQuestionRounds: 1,
  conversation: [
    { role: "user", content: "患者张三今日来诊" },
    { role: "assistant", content: "治法考虑健脾益气，完成5剂后复诊" },
  ],
  diagnosis: "## 治法\n健脾益气",
  prescription: "黄芪 15g；酸枣仁 15g，捣碎后同煎",
  riskAssessment: "## 随访管理方案\n完成5剂后复诊",
  reasoningDiagnose: {
    ...stableM03,
    therapy: { overallPrinciple: "健脾益气" },
  },
  reasoningPrescribe: stableM04,
  reasoningV2: stableM04,
};
const persistedBeforeRefresh = sanitizeCaseStateForBrowserPersistence(persistenceFixture);
const restoredAfterRefresh = sanitizeCaseStateForBrowserPersistence(structuredClone(persistedBeforeRefresh));
assert.equal(restoredAfterRefresh.patient.name, undefined);
assert.doesNotMatch(restoredAfterRefresh.chiefComplaint, /张三/);
assert.doesNotMatch(restoredAfterRefresh.symptoms.detail, /张三/);
assert.deepEqual(restoredAfterRefresh.reasoningDiagnose, persistedBeforeRefresh.reasoningDiagnose);
assert.deepEqual(restoredAfterRefresh.reasoningPrescribe, persistedBeforeRefresh.reasoningPrescribe);
assert.deepEqual(restoredAfterRefresh.reasoningV2, persistedBeforeRefresh.reasoningV2);
assert.equal(restoredAfterRefresh.diagnosis, persistedBeforeRefresh.diagnosis);
assert.equal(restoredAfterRefresh.prescription, persistedBeforeRefresh.prescription);
assert.equal(restoredAfterRefresh.riskAssessment, persistedBeforeRefresh.riskAssessment);
assert.equal(restoredAfterRefresh.reasoningPrescribe.formula.candidates[0].herbs[0].name, "黄芪");
assert.equal(restoredAfterRefresh.reasoningPrescribe.formula.candidates[0].herbs[1].decoctionRequirement, "捣碎后同煎");
assert.equal(restoredAfterRefresh.reasoningDiagnose.therapy.overallPrinciple, "健脾益气");
assert.match(restoredAfterRefresh.riskAssessment, /完成5剂后复诊/);

const doneRoundNotice = maxQuestionRoundNotice({ questionRounds: 3, maxQuestionRounds: 3, phase: "done" });
assert.equal(doneRoundNotice, "", "completed cases should not retain a question-round warning");
const doneScoreCaption = differentiationScoreCaption({ phase: "done" }, "可初步辨证");
assert.match(doneScoreCaption, /本轮评估已完成/);
assert.doesNotMatch(doneScoreCaption, /停留在追问|不自动进入 M04/);
const unavailableAudit = prescriptionRiskLabel("none", false);
assert.equal(unavailableAudit.tone, "yellow");
assert.match(unavailableAudit.label, /未完成.*仅提示/);
assert.doesNotMatch(unavailableAudit.label, /未见强提示/);
assert.equal(prescriptionRiskLabel("strong", false).tone, "red", "known strong risk must remain authoritative when automatic audit is unavailable");
assert.match(WORKBENCH_REFRESH_WARNING, /刷新或关闭页面会丢失/);
const managementNarrative = "## 中医辨证结论\n完整候选方案\n## 下一步管理\n建议完善甲功后再评估。";
assert.equal(hasExecutableM03Diagnosis({ diagnosis: managementNarrative, reasoningDiagnose: stableM03 }), true, "governed M03 must not be overturned by management prose");
assert.equal(hasExecutableM03Diagnosis({ diagnosis: managementNarrative, reasoningDiagnose: { ...stableM03, contractSignatureVersion: undefined } }), false, "pre-v2 signed browser snapshots must regenerate M03 instead of failing later at M04");
assert.equal(hasExecutableM03Diagnosis({ diagnosis: managementNarrative.replace("完整候选方案", "辨证结论"), reasoningDiagnose: undefined }), false, "legacy text fallback remains conservative");
const phaseSteps = [
  { phase: "collect", label: "M01 采集" }, { phase: "question", label: "M02 追问" },
  { phase: "diagnose", label: "M03 辨证" }, { phase: "prescribe", label: "M04 方药" },
  { phase: "assess", label: "M05 随访" },
];
for (const failedPhase of ["question", "diagnose", "prescribe", "assess"]) {
  const failedIndex = phaseSteps.findIndex((step) => step.phase === failedPhase);
  const state = { phase: "error", lastError: { phase: failedPhase, message: "test" } };
  assert.deepEqual(
    phaseSteps.map((step) => getStepStatus(state, step)),
    phaseSteps.map((_, index) => index < failedIndex ? "done" : index === failedIndex ? "error" : "blocked"),
    "a failed/cancelled stage must stop downstream steps as blocked(未执行), never as pending/spinning",
  );
}
const prescribeFailureDisplay = stageErrorDisplay({ phase: "prescribe", message: "候选方药生成失败 (422)" });
assert.equal(prescribeFailureDisplay.stepLabel, "候选方药");
assert.equal(prescribeFailureDisplay.retryText, "重新生成候选方药");
assert.deepEqual(prescribeFailureDisplay.downstreamLabels, ["审方随访"], "the failed M04 panel must name M05 as not executed");
const diagnoseFailureDisplay = stageErrorDisplay({ phase: "diagnose", message: "辨病辨证本次未完整生成" });
assert.equal(diagnoseFailureDisplay.retryText, "重新生成辨病辨证");
assert.deepEqual(diagnoseFailureDisplay.downstreamLabels, ["候选方药", "审方随访"]);
const assessFailureDisplay = stageErrorDisplay({ phase: "assess", message: "推理已取消" });
assert.equal(assessFailureDisplay.retryText, "重新生成审方与随访");
assert.deepEqual(assessFailureDisplay.downstreamLabels, [], "M05 is terminal: no downstream stages to mark as not executed");
const questionFailureDisplay = stageErrorDisplay({ phase: "question", message: "推理已取消" });
assert.equal(questionFailureDisplay.retryText, "重试本阶段");
assert.deepEqual(questionFailureDisplay.downstreamLabels, ["辨病辨证", "候选方药", "审方随访"]);
const redFlagAssessFailure = {
  phase: "error",
  lastError: { phase: "assess", message: "M05暂未完成" },
  safetyGate: { status: "red_flag", redFlags: ["急性胸痛"], missingItems: [] },
  prescription: undefined,
};
assert.equal(getStepStatus(redFlagAssessFailure, phaseSteps[3]), "skipped", "red-flag risk-only flow must label M04 as skipped instead of completed");

const completedWithOptionalGaps = {
  phase: "done",
  safetyGate: { status: "needs_information", missingItems: ["未录入实测生命体征"] },
  diagnosis: "已完成辨病辨证",
  prescription: "已生成候选方药",
  riskAssessment: "已完成审方随访",
};
assert.equal(
  getStepStatus(completedWithOptionalGaps, phaseSteps[1]),
  "done",
  "completed flow must not paint M02 as a warning solely because optional facts remain",
);
assert.equal(errorRequiresM03Refresh({ phase: "prescribe", message: "M03 合同签名失效，请重新生成M03" }), true);
assert.equal(errorRequiresM03Refresh({ phase: "assess", message: "reasoning contract signature mismatch" }), true);
assert.equal(errorRequiresM03Refresh({ phase: "prescribe", message: "模型请求超时" }), false);

const complete = {
  score: 100,
  label: "辨证充分",
  tone: "green",
  desc: "主诉、舌脉、证候和病机链已能支撑候选方案推理。",
};

assert.equal(hasRecordedMeasuredVitals(), false);
assert.equal(hasRecordedMeasuredVitals({ detail: "一般情况可" }), false);
assert.equal(hasRecordedMeasuredVitals({ temperature: "待核实", bloodPressure: "未测量" }), false);
assert.equal(hasRecordedMeasuredVitals({ pulse: "78" }), true);
assert.equal(hasRecordedMeasuredVitals({ bloodPressure: "120/80" }), true);
assert.equal(requiresLimitedCandidateReview(true, false, "可初步辨证"), true);
assert.equal(requiresLimitedCandidateReview(true, true, "辨证充分"), true);
assert.equal(requiresLimitedCandidateReview(true, false, "辨证充分"), false);
assert.equal(requiresLimitedCandidateReview(false, true, "可初步辨证"), false);

const missingVitals = resolveSufficiencyDisplay(complete, {
  hasMeasuredVitals: false,
  requiresLimitedReview: false,
});
assert.equal(missingVitals.score, 99);
assert.equal(missingVitals.label, "需现场复核");
assert.equal(missingVitals.tone, "yellow");
assert.match(missingVitals.desc, /未录入实测生命体征，开方前需现场复核/);
assert.match(missingVitals.desc, /非高风险病例不因此阻断剂量级候选生成/);

assert.deepEqual(resolveSufficiencyDisplay(complete, {
  hasMeasuredVitals: true,
  requiresLimitedReview: false,
}), complete);

const skippedSoftQuestions = resolveSufficiencyDisplay(complete, {
  hasMeasuredVitals: true,
  requiresLimitedReview: true,
});
assert.equal(skippedSoftQuestions.score, 69);
assert.equal(skippedSoftQuestions.label, "当前依据较少");
assert.equal(skippedSoftQuestions.tone, "yellow");
assert.match(skippedSoftQuestions.desc, /仅依据已记录内容进行分析/);

const skippedWithoutVitals = resolveSufficiencyDisplay(complete, {
  hasMeasuredVitals: false,
  requiresLimitedReview: true,
});
assert.equal(skippedWithoutVitals.score, 69);
assert.equal(skippedWithoutVitals.label, "当前依据较少");
assert.equal(skippedWithoutVitals.tone, "yellow");
assert.match(skippedWithoutVitals.desc, /仅依据已记录内容进行分析/);
assert.match(skippedWithoutVitals.desc, /未录入实测生命体征，开方前需现场复核/);

const limitedCandidate = resolvePrescriptionDisplay(true, {
  hasMeasuredVitals: true,
  requiresLimitedReview: true,
});
assert.equal(limitedCandidate.label, "已生成");
assert.equal(limitedCandidate.tone, "yellow");
assert.match(limitedCandidate.desc, /当前依据覆盖有限/);

const missingVitalsCandidate = resolvePrescriptionDisplay(true, {
  hasMeasuredVitals: false,
  requiresLimitedReview: false,
});
assert.equal(missingVitalsCandidate.label, "已生成");
assert.equal(missingVitalsCandidate.tone, "yellow");
assert.match(missingVitalsCandidate.desc, /未录入实测生命体征，开方前需现场复核/);

assert.match(resolvePrescriptionDisplay(true, {
  hasMeasuredVitals: false,
  requiresLimitedReview: true,
}).desc, /未录入实测生命体征，开方前需现场复核/);

assert.equal(resolvePrescriptionDisplay(true, {
  hasMeasuredVitals: true,
  requiresLimitedReview: false,
}).tone, "green");
assert.equal(resolvePrescriptionDisplay(false, {
  hasMeasuredVitals: false,
  requiresLimitedReview: false,
}).tone, "gray");
const generatingCandidate = resolvePrescriptionDisplay(false, {
  hasMeasuredVitals: false,
  requiresLimitedReview: false,
}, true);
assert.equal(generatingCandidate.label, "生成与校验中");
assert.match(generatingCandidate.desc, /药味、剂量、病机对应、煎法和出处核验完成后/);

const lowConfidenceM03 = [
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    stage: "diagnose",
    overview: { primarySyndrome: "肺阴虚证", overallPathogenesis: "肺阴不足", overallTherapy: "养阴润肺", recommendedFormulaDirection: "养阴润肺", evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } },
    westernDiagnosis: { primary: { name: "病历记录头痛阳性；病历记录否认头痛", status: "考虑", confidence: "中", supportingFacts: [], limitations: [], suggestedChecks: [], evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } }, differentials: [] },
    pathogenesis: { chain: [{ nodeId: "P8", patientFact: "脑梗死后右侧肢体乏力3个月", syndromeEvidence: "肢体无力", pathogenesis: "肺阴不足", therapyDirection: "养阴润肺" }], uncertainties: [] },
    therapy: { overallPrinciple: "虚则补之", subTherapies: [] },
    formula: null,
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n");
const lowConfidenceContext = "主诉：脑梗死后右侧肢体无力3个月，要求康复调理\n现病史：出院后病情稳定";
const groundedM03 = groundStructuredPatientFacts(lowConfidenceM03, lowConfidenceContext);
const normalizedM03 = normalizeDiagnoseConfidenceAndLabels(groundedM03, lowConfidenceContext);
const normalizedM03Json = JSON.parse(normalizedM03.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.match(normalizedM03Json.westernDiagnosis.primary.supportingFacts.join("；"), /病情稳定/);
assert.equal(normalizedM03Json.westernDiagnosis.primary.name, "病历记录头痛阳性；病历记录否认头痛", "deterministic grounding must not replace a clinical diagnosis with a keyword-derived label");
assert.equal(normalizedM03Json.westernDiagnosis.primary.confidence, "低", "an ungrounded western diagnosis must lose confidence before independent model review");
assert.equal(normalizedM03Json.overview.evidence.confidence, "中", "the grounding pass must not fabricate a TCM confidence decision");
assert.deepEqual(normalizedM03Json.pathogenesis.uncertainties, [], "the grounding pass must not synthesize clinical uncertainties that the model did not return");
assert.equal(normalizedM03Json.pathogenesis.chain.length, 1, "a fuzzy provider wording may survive only after being replaced by the exact chart quote");
assert.equal(normalizedM03Json.pathogenesis.chain[0].patientFact, "主诉：脑梗死后右侧肢体无力3个月，要求康复调理");
assert.equal(normalizedM03Json.pathogenesis.chain[0].syndromeEvidence, "主诉：脑梗死后右侧肢体无力3个月，要求康复调理");
assert.equal(isStableM03Reasoning(normalizedM03Json, lowConfidenceContext), true, "the deterministic boundary validates structure and source grounding; semantic support is owned by the independent clinical model review before signing");

const allUngroundedChain = lowConfidenceM03
  .replace("脑梗死后右侧肢体乏力3个月", "纳差便溏、神疲乏力")
  .replace("肺阴虚证", "脾气虚证")
  .replaceAll("肺阴不足", "脾气虚弱")
  .replaceAll("养阴润肺", "健脾益气");
const neutralSalvage = groundStructuredPatientFacts(allUngroundedChain, "主诉：入睡困难2周\n现病史：食欲正常，大便成形，否认乏力");
const neutralSalvageJson = JSON.parse(neutralSalvage.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(neutralSalvageJson.pathogenesis.chain.length, 0);
assert.equal(isStableM03Reasoning(neutralSalvageJson, "主诉：入睡困难2周\n现病史：食欲正常，大便成形，否认乏力"), false, "an entirely ungrounded chain must be retried, not signed as executable neutral reasoning");
const genericSyndrome = JSON.parse(JSON.stringify(stableM03));
genericSyndrome.overview.primarySyndrome = "脏腑失和证";
assert.equal(isStableM03Reasoning(genericSyndrome, "主诉：入睡困难"), false, "a non-diagnostic generic syndrome must not cross the M03 signature boundary");

const mixedQualityChain = JSON.parse(groundedM03.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
mixedQualityChain.pathogenesis.chain.push({
  nodeId: "P9",
  patientFact: "主诉：脑梗死后右侧肢体无力3个月，要求康复调理",
  syndromeEvidence: "待确认",
  pathogenesis: "待确认",
  therapyDirection: "需复核",
});
const prunedMixedChain = groundStructuredPatientFacts(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(mixedQualityChain)}\n<!-- DIAGNOSIS_JSON_END -->`, lowConfidenceContext);
const prunedMixedChainJson = JSON.parse(prunedMixedChain.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(prunedMixedChainJson.pathogenesis.chain.length, 1);
assert.equal(prunedMixedChainJson.pathogenesis.chain[0].nodeId, "P1");

for (const rawName of [
  "考虑失眠障碍，建议结合睡眠量表进一步评估",
  "患者反复入睡困难，倾向失眠障碍",
]) {
  const content = normalizedM03.replace(normalizedM03Json.westernDiagnosis.primary.name, rawName);
  const normalized = normalizeDiagnoseConfidenceAndLabels(content, lowConfidenceContext);
  const parsed = JSON.parse(normalized.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  assert.equal(parsed.westernDiagnosis.primary.name, rawName, "deterministic normalization must not make a clinical semantic decision from prose patterns");
  assert.equal(parsed.westernDiagnosis.primary.confidence, "低");
}

const fabricatedWesternFact = lowConfidenceM03
  .replace("病历记录头痛阳性；病历记录否认头痛", "失眠障碍")
  .replace('"supportingFacts":[]', '"supportingFacts":["持续高热"]')
  .replace("脑梗死后右侧肢体乏力3个月", "入睡困难2周");
const groundedWesternFact = groundStructuredPatientFacts(
  fabricatedWesternFact,
  "主诉：入睡困难2周\n现病史：无发热、无胸痛、无气促，SpO2 98%",
);
const groundedWesternFactJson = JSON.parse(groundedWesternFact.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.doesNotMatch(groundedWesternFactJson.westernDiagnosis.primary.supportingFacts.join("；"), /持续高热/);
assert.match(groundedWesternFactJson.westernDiagnosis.primary.supportingFacts.join("；"), /入睡困难2周/);
assert.match(groundedWesternFactJson.westernDiagnosis.primary.supportingFacts.join("；"), /SpO2 98%/);

const digestiveContextGrounding = groundStructuredPatientFacts(
  fabricatedWesternFact.replace("入睡困难2周", "饭后上腹胀满3个月"),
  [
    "饭后上腹胀满3个月",
    JSON.stringify({ presentHistory: "进食后加重，伴早饱纳差、大便偏溏；无呕血、黑便。", tcmDetail: "" }),
    "舌淡胖有齿痕，苔白腻",
    "脉缓弱",
  ].join("\n"),
);
const digestiveContextGroundingJson = JSON.parse(digestiveContextGrounding.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.match(
  digestiveContextGroundingJson.westernDiagnosis.primary.supportingFacts.join("；"),
  /大便偏溏/,
  "structured symptom values supplied by the clinician must remain visible in M03 supporting facts",
);

const shortSyndromeLabel = normalizedM03.replace('"primarySyndrome": "肺阴虚证"', '"primarySyndrome": "风邪犯肺"');
const normalizedShortSyndrome = normalizeDiagnoseConfidenceAndLabels(shortSyndromeLabel, "主诉：感冒后干咳4周\n现病史：咽痒少痰");
const normalizedShortSyndromeJson = JSON.parse(normalizedShortSyndrome.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(normalizedShortSyndromeJson.overview.primarySyndrome, "风邪犯肺", "the server must not rewrite a model diagnosis merely to append a lexical suffix");

const m05Summary = buildDecisionSummary({
  diagnosis: "",
  prescription: "",
  riskAssessment: [
    "## 处方安全总评",
    "**最高提示强度**：一般提示",
    "## 转诊评估",
    "**转诊建议**：按主诉评估",
    "## 随访管理方案",
    "**首次复诊时间**：5日复诊",
    "## 随访时间轴",
    "| 时间点 | 医生/患者动作 | 观察指标 | 触发处置 |",
    "|---|---|---|---|",
    "| 5日 | 复诊 | 主诉 | 加重时复评 |",
    "## 红旗预警（患者须知）",
    "出现胸痛立即就医。",
  ].join("\n"),
});
assert.match(m05Summary.riskSummarySection, /一般提示/);
assert.match(m05Summary.referralSection, /按主诉评估/);
assert.match(m05Summary.followupSection, /5日复诊/);
assert.match(m05Summary.followupTimelineSection, /触发处置/);
assert.match(m05Summary.redFlagPatientSection, /胸痛立即就医/);

// P2-7 证据展示契约：URL/DOI/文献ID/检索时间只来自证据载荷本身；缺失时 UI 明示“来源未提供链接”，
// 检索时间留空，绝不在渲染层伪造。
const evidenceRefWithDoi = enrichEvidenceReferenceForDisplay({
  raw: "[EVID-LIT-1] 失眠障碍诊疗共识 DOI:10.3760/cma.j.cn112137-20240101-00001 2024",
  title: "[EVID-LIT-1] 失眠障碍诊疗共识 DOI:10.3760/cma.j.cn112137-20240101-00001 2024",
  sourceType: "研究文献",
  publicationDate: "2024",
  relevance: "支持当前西医诊断倾向或鉴别边界",
});
assert.equal(evidenceRefWithDoi.doi, "10.3760/cma.j.cn112137-20240101-00001");
assert.equal(evidenceRefWithDoi.literatureId, undefined, "DOI present ⇒ no duplicate literature id line");
const evidenceRefWithPmid = enrichEvidenceReferenceForDisplay({
  raw: "[EVID-LIT-2] Insomnia consensus PMID 38063870 2023",
  title: "[EVID-LIT-2] Insomnia consensus PMID 38063870 2023",
  sourceType: "研究文献",
  publicationDate: "2023",
  relevance: "支持用药边界",
});
assert.equal(evidenceRefWithPmid.doi, undefined);
assert.equal(evidenceRefWithPmid.literatureId, "PMID 38063870");
const evidenceRefSparse = enrichEvidenceReferenceForDisplay({
  raw: "[EVID-GUIDE-1] 指南；《金匮要略》",
  title: "[EVID-GUIDE-1] 指南；《金匮要略》",
  sourceType: "指南/共识",
  relevance: "支持候选方身份、组方依据或药味来源",
});
assert.deepEqual(evidenceRefSparse, {}, "upstream payload without url/DOI/检索时间 must stay sparse — the UI renders 来源未提供链接 instead of fabricating");
const evidenceRefRetrieved = enrichEvidenceReferenceForDisplay({
  raw: "[EVID-INST-1] 国家药监局说明书 检索：2026-07-19",
  title: "[EVID-INST-1] 国家药监局说明书 检索：2026-07-19",
  sourceType: "药品说明书/监管资料",
  relevance: "支持该药品的适应证、用法边界或风险提示",
  retrievedAt: "2026-07-19",
});
assert.equal(evidenceRefRetrieved.retrievedAt, "2026-07-19", "检索时间来自证据载荷/元数据，不是渲染当天日期");
const evidenceRefRetrievedFromRaw = enrichEvidenceReferenceForDisplay({
  raw: "[EVID-INST-2] 某说明书 检索时间：2026-07-18",
  title: "[EVID-INST-2] 某说明书 检索时间：2026-07-18",
  sourceType: "药品说明书/监管资料",
  relevance: "支持用药边界",
});
assert.equal(evidenceRefRetrievedFromRaw.retrievedAt, "2026-07-18");
const evidenceRefTrailingPunct = enrichEvidenceReferenceForDisplay({
  raw: "指南 https://example.org/a DOI:10.1000/xyz123。",
  title: "指南",
  sourceType: "指南/共识",
  relevance: "支持当前西医诊断倾向或鉴别边界",
});
assert.equal(evidenceRefTrailingPunct.doi, "10.1000/xyz123", "DOI extraction trims trailing CJK punctuation");

// ─── PHI quasi-identifier audit probes (2026-07-19), browser snapshot path ───
// The snapshot scrubber (scrubPersistentPhiText) shares src/lib/phi-sanitizer.ts with model egress;
// these lock the snapshot-side behavior, including idempotence across re-saves.
for (const [phiProbe, phiForbidden, phiKept] of [
  ["患者住在幸福路12号院3栋502，咳嗽3日", /幸福路|12号院|3栋|502/, /咳嗽3日/],
  ["长期居于建设路7号楼2单元301室，近一周失眠", /建设路|7号楼|2单元|301/, /近一周失眠/],
  ["患者家住朝阳区望京西园四区，近一周失眠", /望京西园|四区/, /近一周失眠/],
  ["任职于市博物馆，近3日失眠", /市博物馆/, /近3日失眠/],
  ["就诊时间：2026年7月18日14:35；主诉失眠", /2026年7月18日|14:35/, /主诉失眠/],
  ["2026-07-18 14:35 突发胸痛", /2026-07-18|14:35/, /突发胸痛/],
  ["2026-07-18 突发胸痛", /2026-07-18/, /突发胸痛/],
]) {
  const phiScrubbed = scrubPersistentPhiText(phiProbe);
  assert.doesNotMatch(phiScrubbed, phiForbidden, `snapshot path must scrub quasi-identifiers: ${phiProbe}`);
  assert.match(phiScrubbed, phiKept, `snapshot path must keep clinical text: ${phiProbe}`);
  assert.equal(scrubPersistentPhiText(phiScrubbed), phiScrubbed, `snapshot scrubbing must be idempotent: ${phiProbe}`);
}
assert.equal(scrubPersistentPhiText("查体：腹部四区均可及压痛"), "查体：腹部四区均可及压痛", "腹部四区 is clinical text, not an address");
assert.equal(scrubPersistentPhiText("双方就产业园区合作达成协议"), "双方就产业园区合作达成协议", "产业园区 without a residence anchor is not an address");
assert.match(scrubPersistentPhiText("2026年3月发病，反复咳嗽"), /2026年3月/, "year-month onset text must stay intact on the snapshot path");
const phiSnapshotFixture = {
  id: "phi-snapshot-fixture",
  phase: "done",
  patient: { name: "张三", sex: "男", age: 42 },
  chiefComplaint: "反复失眠三个月",
  hisRecord: {
    source: "manual",
    encounterId: "phi",
    rawText: "患者家住朝阳区望京西园四区，2026-07-18 14:35 突发胸痛后缓解。",
    fields: { zhushu: "反复失眠三个月" },
    collectedAt: new Date(0).toISOString(),
    tongueImageUploaded: false,
  },
  conversation: [{ role: "user", content: "任职于市博物馆，近3日失眠" }],
  completeness: { level: "C", redFlag: 0, infoGain: 1, managementImpact: 1, answerability: 1 },
  questionRounds: 1,
  maxQuestionRounds: 1,
};
const phiPersistedOnce = sanitizeCaseStateForBrowserPersistence(phiSnapshotFixture);
const phiPersistedTwice = sanitizeCaseStateForBrowserPersistence(structuredClone(phiPersistedOnce));
assert.doesNotMatch(phiPersistedOnce.hisRecord.rawText, /望京西园|2026-07-18|14:35/, "snapshot rawText must scrub the buried address and timestamp");
assert.match(phiPersistedOnce.hisRecord.rawText, /突发胸痛/, "snapshot rawText must keep the clinical event");
assert.doesNotMatch(phiPersistedOnce.conversation[0].content, /市博物馆/, "snapshot conversation must generalize the anchored employer");
assert.deepEqual(phiPersistedTwice, phiPersistedOnce, "snapshot persistence must be hash-stable across re-saves");

console.log(JSON.stringify({ cases: 129, failures: 0 }));
