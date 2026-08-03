import assert from "node:assert/strict";
import fs from "node:fs";
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
  buildEmergencyPresentation,
  automaticSignatureRecoveryState,
  buildDecisionSummary,
  buildVitalsLine,
  generationStatus,
  normalizePresentHistoryText,
  prioritizeTcmEvidenceForDisplay,
  prioritizeWesternEvidenceForDisplay,
  differentiationScoreCaption,
  enrichEvidenceReferenceForDisplay,
  errorRequiresM03Refresh,
  errorRequiresM04Refresh,
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
  stripTcmDiseaseNameForCustomer,
  stripWesternAnalysisForCustomer,
  WORKBENCH_REFRESH_WARNING,
} = await jiti.import("../src/app/diagnosis/DiagnosisClient.tsx");
assert.equal(
  stripTcmDiseaseNameForCustomer([
    "## 中医病名与证候诊断",
    "**中医病名**：咳嗽病",
    "**证型**：风寒袭肺",
    "",
    "## 病机分析",
    "风寒束表，肺气失宣。",
  ].join("\n")),
  [
    "## 中医证候诊断",
    "**证型**：风寒袭肺",
    "",
    "## 病机分析",
    "风寒束表，肺气失宣。",
  ].join("\n"),
  "customer-visible diagnosis output must omit the TCM disease-name row while preserving syndrome and pathogenesis",
);
assert.equal(
  stripTcmDiseaseNameForCustomer("| 中医病名 | 咳嗽病 |\n| 证型 | 风寒袭肺 |"),
  "| 证型 | 风寒袭肺 |",
  "table-shaped TCM disease-name rows must also be removed from customer-visible exports",
);
assert.equal(
  stripWesternAnalysisForCustomer([
    "## 西医诊断倾向与鉴别",
    "**诊断倾向**：头痛症状",
    "**支持依据**：头痛5天",
    "**临床分析**：当前缺少病因学检查。",
    "**限制与反证**：病因尚不明确。",
    "**建议检查**：结合查体评估。",
    "",
    "### 鉴别方向",
    "- **偏头痛**：需进一步鉴别。",
    "",
    "## 中医诊断概览",
    "**证型**：湿浊中阻证",
  ].join("\n")),
  [
    "## 西医诊断倾向",
    "**诊断倾向**：头痛症状",
    "**支持依据**：头痛5天",
    "",
    "## 中医诊断概览",
    "**证型**：湿浊中阻证",
  ].join("\n"),
  "legacy snapshots and exported reports must keep the concise Western conclusion while removing model analysis prose",
);
assert.deepEqual(
  prioritizeTcmEvidenceForDisplay(
    ["咳嗽3天"],
    ["咳嗽3天", "咳白稀痰", "流清涕", "无汗", "舌淡苔薄白", "脉浮紧"],
    "咳嗽3天。",
    5,
  ),
  ["舌淡苔薄白", "咳白稀痰", "流清涕", "脉浮紧", "无汗"],
  "a generic complaint must not displace discriminating four-examination evidence in the clinician-facing basis",
);
assert.deepEqual(
  prioritizeTcmEvidenceForDisplay(["入睡困难2周"], [], "入睡困难2周", 3),
  ["入睡困难2周"],
  "a sparse case keeps its grounded complaint when no stronger signed M03 evidence exists",
);
assert.deepEqual(
  prioritizeTcmEvidenceForDisplay(["纳眠可，二便正常", "无汗"], ["咳白稀痰"], "咳嗽3天", 5),
  ["咳白稀痰", "无汗"],
  "normal appetite, sleep and stool text cannot pad the TCM diagnosis-basis chips",
);
assert.deepEqual(
  prioritizeWesternEvidenceForDisplay(["咳嗽3天", "纳眠可，二便正常", "咳嗽3天"]),
  ["咳嗽3天"],
  "western diagnosis-basis chips remove normal padding and duplicates",
);
// 处置改「提示不拦截」（甲方 2026-08-01 决策）：红旗病例照常生成候选方药，文案必须如实
// 说明「照常生成 + 置顶警示 + 采纳前先完成急诊评估」，不得再宣称"不生成"。
assert.deepEqual(
  generationStatus("prescribe", true),
  {
    title: "正在生成候选方药与风险处置建议",
    desc: "本例存在急危重风险提示：候选方药照常生成并置顶安全警示，采纳前请先完成急诊/转诊评估。",
  },
  "a red-flag prescribe stage must state that candidates are generated with a safety advisory",
);
assert.equal(
  buildVitalsLine({ vitalsT: "36.5℃", vitalsP: "74次/分", vitalsR: "18次/分", vitalsBP: "118/72mmHg" }),
  "T 36.5℃，P 74次/分，R 18次/分，BP 118/72mmHg",
  "unit-bearing manual inputs must render idempotently in the workbench and exported report",
);
assert.equal(normalizePresentHistoryText("现病史：现病史补充：淋雨后咳嗽3天"), "淋雨后咳嗽3天");
assert.equal(normalizePresentHistoryText("病史补充：突发头痛伴呕吐"), "突发头痛伴呕吐");
assert.equal(
  buildVitalsLine({ vitalsT: "36.5", vitalsP: "74", vitalsR: "18", vitalsBP: "118/72" }),
  "T 36.5℃，P 74次/分，R 18次/分，BP 118/72mmHg",
  "unitless manual inputs must receive one canonical display unit",
);
const {
  buildMedicineCandidateEmptyState,
  buildTieredSuggestedChecks,
  herbCaseMeaning,
  resolveAuditReviewPresentation,
  safeDietAdviceForDisplay,
} = await jiti.import("../src/lib/result-display-policy.ts");

assert.equal(
  resolveAuditReviewPresentation({ available: true }, "未见明确风险提示"),
  null,
  "a successful audit without a concrete risk must not occupy a report section",
);
assert.equal(
  resolveAuditReviewPresentation({ available: true }, "未见明确风险提示。结果仅供参考，仍需医生或药师复核。"),
  null,
  "a generic clinician-review disclaimer must not turn a no-risk audit into a visible warning",
);
assert.deepEqual(
  resolveAuditReviewPresentation({ available: true }, "| 问题ID | 提示强度 | 风险说明 |\n|---|---|---|\n| R1 | 强提示 | 甘草与甘遂配伍禁忌 |"),
  {
    kind: "risk",
    title: "合理用药审查 · 发现风险提示",
    subtitle: "按审查问题 ID 逐条复核",
  },
  "a concrete medication risk must remain visible under the customer-facing audit name",
);
assert.deepEqual(
  resolveAuditReviewPresentation({ available: false }, ""),
  {
    kind: "unavailable",
    title: "合理用药审查 · 本次未完成",
    subtitle: "当前结果不能视为已完成合理用药审查",
  },
  "an unavailable audit must remain visible and fail closed",
);

const sparseMedicineEmptyState = buildMedicineCandidateEmptyState({
  patient: {},
  symptoms: {},
  chiefComplaint: "头疼睡不着觉",
});
assert.match(sparseMedicineEmptyState.explanation, /不会为了填满栏目生成具体药名/);
assert.match(sparseMedicineEmptyState.action, /年龄\/生理状态/);
assert.match(sparseMedicineEmptyState.action, /生命体征/);
assert.match(sparseMedicineEmptyState.action, /过敏史/);
assert.match(sparseMedicineEmptyState.action, /当前用药/);
assert.match(
  herbCaseMeaning({
    function: "活血祛瘀，润肠通便",
    prescriptionRole: "君药：活血化瘀，通络止痛",
  }),
  /活血祛瘀，润肠通便；君药：活血化瘀，通络止痛/,
  "the workbench must show herb-specific knowledge together with its case-specific role",
);

const sparseHeadacheChecks = buildTieredSuggestedChecks({
  patient: {},
  chiefComplaint: "头疼睡不着觉",
  symptoms: {},
  safetyGate: { status: "ready" },
}, ["头颅CT或MRI平扫+增强", "经颅多普勒", "血常规、肝肾功能"]);
assert.match(sparseHeadacheChecks.join("；"), /先补充病程.*生命体征.*神经系统查体/);
assert.match(sparseHeadacheChecks.join("；"), /补充问诊或神经系统查体出现相应指征/);
assert.doesNotMatch(sparseHeadacheChecks.join("；"), /CT|MRI|经颅多普勒/, "sparse non-red-flag cases must not present a routine advanced-imaging shopping list");
assert.match(sparseHeadacheChecks.join("；"), /血常规、肝肾功能/, "grounded non-advanced checks survive sparse-case tiering");
assert.deepEqual(
  buildTieredSuggestedChecks({ safetyGate: { status: "red_flag" } }, ["立即急诊头颅CT"]),
  ["立即急诊头颅CT"],
  "red-flag pathways must preserve urgent clinician-directed testing",
);
assert.deepEqual(
  buildTieredSuggestedChecks(
    { patient: { age: 45 }, symptoms: { presentHistory: "头痛3天" }, vitals: { bloodPressure: "126/78" }, safetyGate: { status: "ready" } },
    ["复测血压并记录头痛变化；判断把握度低"],
  ),
  ["复测血压并记录头痛变化"],
  "boilerplate removal must preserve the clinically useful part of the same line",
);
assert.equal(
  safeDietAdviceForDisplay("多食活血化瘀之品如山楂、黑木耳", { allergyHistory: "", medicationHistory: "" }),
  "保持规律、均衡饮食和充足饮水；不要把食疗替代诊疗或药物。存在基础病、过敏或正在用药时，具体饮食调整请由接诊医生结合实际情况确认。",
  "food must not be presented as a disease-modifying treatment when patient facts are incomplete",
);
assert.equal(
  safeDietAdviceForDisplay("三餐规律，避免空腹和过量饮酒", {}),
  "三餐规律，避免空腹和过量饮酒",
  "ordinary low-risk lifestyle advice should remain intact",
);

const diagnosisClientSource = fs.readFileSync(new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url), "utf8");
assert.doesNotMatch(diagnosisClientSource, /cdss-section-generation-basis|本次生成依据/, "generic generation-basis boilerplate must be removed from the report");
assert.doesNotMatch(diagnosisClientSource, /Lingxi 建议性复核/, "the report must use the customer-facing reasonable-medication-review name");
assert.doesNotMatch(diagnosisClientSource, /判断把握度/, "the clinician UI must show rationale and limitations instead of a low-confidence badge");
assert.doesNotMatch(
  diagnosisClientSource,
  /证候锚点[：:]|从服务端中药知识库|和服务端中药知识库|闭集|受控|锚点|title="[^"]*(?:安全门控|红旗门控|服务端)/,
  "the clinician UI must use clinical wording instead of exposing pipeline vocabulary",
);
assert.doesNotMatch(
  diagnosisClientSource,
  /病名：\{reasoning\.overview\.tcmDiseaseName\}|标准证候名建议|标准编码建议|onConfirmTerminologyMapping|handleConfirmTerminologyMapping/,
  "the advisory UI must not display a TCM disease-name row or expose a clinician terminology-confirmation workflow",
);
assert.match(
  diagnosisClientSource,
  /data-testid="non-dose-prescription-result"[\s\S]{0,1400}summary\.currentConclusionSection/,
  "the non-dose panel must render the server-owned current conclusion instead of a generic shell",
);
assert.match(
  diagnosisClientSource,
  /data-testid="tcm-differential-boundary"[\s\S]{0,240}tcmDifferentialBoundary/,
  "a bounded TCM differential explanation must be visible when no differential row can be formed",
);
assert.doesNotMatch(diagnosisClientSource, /rendererId="lineage-section"|testId="tcm-lineage"/, "lineage adaptation and preference controls are internal-only");
assert.doesNotMatch(diagnosisClientSource, />西医诊断分析</, "the clinician report must not render the Western analysis panel");
assert.doesNotMatch(
  diagnosisClientSource,
  />未采用经典方说明<|>逐味核验<|modification-review-omissions/,
  "internal formula-selection explanations and verification counters must not be rendered",
);
assert.match(diagnosisClientSource, /data-testid="self-devised-formula-badge"[\s\S]{0,240}自拟方/, "self-devised candidates need one concise visible badge");

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
// 上面三条断言用的是手写短语，服务端改写降级正文后它们仍然通过，生产上却把每一次安全降级
// 都误判成“候选方药生成失败”。判定必须对着真实生成物断言，否则同类漂移会再次静默复发。
const {
  buildDeterministicRiskFollowupPayload,
  buildSafetyLimitedPrescription: buildNonDoseForDisplayCheck,
} = await jiti.import("../src/lib/diagnosis-safety.ts");
const generatedNonDosePrescription = buildNonDoseForDisplayCheck({
  status: "needs_information",
  allowDiagnosis: true,
  allowDosePrescription: false,
  action: "complete_before_prescription",
  missingItems: ["本次当前活动性治疗目标确认"],
  redFlags: [],
  reasons: ["语义预检无法判断本次就诊是否存在当前活动性治疗目标。"],
});
assert.equal(
  hasExplicitNonDosePrescriptionResult({ prescription: generatedNonDosePrescription }),
  true,
  "服务端安全降级处方必须被展示层识别为非剂量结果，而不是生成失败",
);
const journeyFollowup = buildDeterministicRiskFollowupPayload({
  patient: { age: 24, sex: "男" },
  chiefComplaint: "头痛5天",
  symptoms: {},
  conversation: [],
  safetyGate: { status: "ready", allowDiagnosis: true, allowDosePrescription: true, redFlags: [], reasons: [], missingItems: [] },
  reasoningPrescribe: {
    stage: "prescribe",
    westernDiagnosis: { primary: { supportingFacts: ["头痛5天"] } },
    overview: { primarySyndromeBasis: ["肢体困重", "胸闷纳呆"] },
    formula: {
      candidates: [{
        herbs: [{ name: "藿香", dose: "9g" }],
        decoction: { followUpNode: "完成5剂（5日）后复诊" },
      }],
    },
    nonPharma: {
      precautions: ["服药期间清淡饮食", "头痛加重或出现视物模糊、呕吐时立即就医"],
    },
  },
});
// 原先此处还断言时间轴含一行 time=「每日记录」，它来自 nonPharma.monitoring[].timing。
// 该字段（连同它在合同层的 5 个驳回码）已按需求10 移除：一条建议性随访行的措辞瑕疵不该作废
// 整份 M04。M05 随访时间轴本身**没有**被删——它由服务端确定性生成，下面两条断言就是它的证据。
// 注意区分两个「时间轴」：被删的是健康调护区里模型填写的监测三元组，保留的是 M05 这条确定性随访轴。
assert.ok(journeyFollowup.timelineItems.some((item) => /首次复诊/.test(item.action)));
assert.ok(journeyFollowup.timelineItems.some((item) => /治疗期间随时/.test(item.time)));
assert.ok(journeyFollowup.timelineItems.length >= 2, "M05 确定性随访时间轴必须继续给出可执行行");
assert.doesNotMatch(JSON.stringify(journeyFollowup.timelineItems), /采纳候选前|完成针对性安全复核/);
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
  sanitizeOptionalPathogenesisClassifications,
  scrubInternalVocabularyFromVisibleText,
  westernDiagnosisLabelForDisplay,
} = await jiti.import("../src/lib/diagnosis-visible-summary.ts");

// 甲方评测(2026-08-03)：医生可见标签使用临床惯用的「病因待查」,不再用自造的「症状性工作诊断」。
assert.equal(westernDiagnosisLabelForDisplay("头痛症状"), "头痛（病因待查）");
assert.equal(westernDiagnosisLabelForDisplay("偏头痛"), "偏头痛", "established disease labels must not be rewritten as symptom-level diagnoses");

assert.equal(
  scrubInternalVocabularyFromVisibleText("## 西医诊断\n**判断把握度**：低\n临床分析：现有病程尚需结合查体鉴别。"),
  "## 西医诊断\n\n临床分析：现有病程尚需结合查体鉴别。",
  "streaming drafts must omit confidence labels while preserving the clinically useful rationale",
);
assert.equal(
  scrubInternalVocabularyFromVisibleText("流派偏好：经方思路；证候锚点：恶寒；红旗门控优先；药味由服务端中药知识库生成。"),
  "流派偏好：经方思路；证候依据：恶寒；风险筛查规则优先；药味由中药知识库生成。",
  "all streamed clinician-facing surfaces must scrub the whole internal-vocabulary class",
);

const sourceLevelResolutionBoundary = sanitizeOptionalPathogenesisClassifications([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    stage: "diagnose",
    overview: {
      primarySyndrome: "心脾两虚证",
      primarySyndromeResolution: "resolved",
      primarySyndromeBasis: ["模型改写的非逐字依据"],
    },
    pathogenesis: {
      locationDifferentiation: {
        items: ["心"],
        details: [{ location: "心", basis: "模型改写的非逐字依据" }],
        resolution: "resolved",
      },
      natureDifferentiation: {
        items: ["虚"],
        rootDeficiency: [],
        branchExcess: [],
        basis: "模型改写的非逐字依据",
        resolution: "resolved",
      },
    },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"), "患者入睡困难3个月，多梦易醒，舌淡，脉细。");
const sourceLevelResolutionJson = JSON.parse(
  sourceLevelResolutionBoundary.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0].trim(),
);
assert.doesNotMatch(sourceLevelResolutionBoundary, /有限资料下的工作判断|有限资料下的工作归纳/);
assert.match(sourceLevelResolutionJson.overview.primarySyndromeResolutionReason, /心脾两虚证.*0条.*可逐字回溯/);
assert.match(sourceLevelResolutionJson.pathogenesis.locationDifferentiation.resolutionReason, /病位“心”.*0条.*可逐字回溯/);
assert.match(sourceLevelResolutionJson.pathogenesis.natureDifferentiation.resolutionReason, /病性“虚”.*缺少.*可逐字回溯/);

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

const deduplicatedDifferentialsContent = groundStructuredPatientFacts([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    stage: "diagnose",
    westernDiagnosis: {
      primary: { name: "活动后喘鸣症状", supportingFacts: ["活动后喘鸣"] },
      differentials: [
        { name: "劳力性呼吸困难待查：考虑心源性可能，需排除阻塞性睡眠呼吸暂停", reason: "夜间憋醒", nextCheck: "睡眠呼吸监测" },
        { name: " 阻塞性睡眠呼吸暂停 ", reason: "需结合打鼾史", nextCheck: "Epworth嗜睡量表" },
        { name: "支气管哮喘", reason: "活动后喘鸣", nextCheck: "肺功能检查" },
      ],
    },
    pathogenesis: { chain: [] },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"), "主诉：活动后喘鸣，晚上有时憋醒");
const deduplicatedDifferentials = JSON.parse(deduplicatedDifferentialsContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]).westernDiagnosis.differentials;
assert.deepEqual(deduplicatedDifferentials.map((item) => item.name), ["阻塞性睡眠呼吸暂停", "支气管哮喘"], "M03 must remove duplicate differential labels as a class");
assert.match(deduplicatedDifferentials[0].nextCheck, /睡眠呼吸监测.*Epworth嗜睡量表/, "deduplication must preserve distinct follow-up checks");
const twiceGroundedDifferentialsContent = groundStructuredPatientFacts(
  deduplicatedDifferentialsContent,
  "主诉：活动后喘鸣，晚上有时憋醒",
);
const twiceGroundedDifferentials = JSON.parse(twiceGroundedDifferentialsContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]).westernDiagnosis.differentials;
assert.deepEqual(twiceGroundedDifferentials, deduplicatedDifferentials, "M03 differential grounding must be idempotent so finalization cannot trigger a second stochastic clinical review");

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
assert.match(sparseFallback, /每周大约几晚|白天功能/,
  "provider failure uses a complaint-family decision axis instead of one cross-disease trajectory template");
assert.match(sparseFallback, /打鼾|呼吸暂停|安眠药/);
assert.doesNotMatch(sparseFallback, /阴虚|心火|心脾两虚|酸枣仁汤/, "the complaint-family fallback must not pre-commit diagnosis, syndrome, or formula");

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
assert.equal(fallbackItems.length, 1, "the low-level compatibility helper retains one bounded fallback block");
assert.match(fallbackItems[0].question, /每周大约几晚|白天/);
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
assert.match(repairedLowValue, /每周大约几晚|白天/);

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
const sparseDiagnosePrompt = buildDiagnosePrompt(promptConversationFixture);
assert.match(sparseDiagnosePrompt, /items=\[\].*resolution=unresolved/, "M03 generation resolves unsupported location and nature explicitly instead of inventing fields");
assert.match(sparseDiagnosePrompt, /overview\.tcmDiseaseName 不得留空/, "M03 generation always returns a patient-facing TCM working disease name");
// 需求3：诊断分三段，辨病与辨证各自给出推理。两段的分工必须在提示词里被分别定义——
// 它们此前共用 tcmDiagnosticRationale，模型无从知道哪段写病名归属、哪段写证型推理。
assert.match(sparseDiagnosePrompt, /tcmDiseaseRationale[\s\S]{0,60}辨病/, "提示词必须说明 tcmDiseaseRationale 承担辨病");
assert.match(sparseDiagnosePrompt, /tcmDiagnosticRationale[\s\S]{0,60}辨证/, "提示词必须说明 tcmDiagnosticRationale 承担辨证");
assert.match(sparseDiagnosePrompt, /相邻病名/, "辨病推理必须写出与哪个相邻病名区分，否则又会退回成证型推理的复述");
assert.match(sparseDiagnosePrompt, /ICD-10/, "西医诊断段必须说明服务端另行关联 ICD-10");
assert.match(sparseDiagnosePrompt, /阳性事实→核心推理/, "M03 generation performs the same evidence projection required by its independent reviewer");
assert.match(sparseDiagnosePrompt, /不得自动补出痰湿、寒热、血瘀、阴虚、阳虚、气虚、血虚/, "sparse M03 generation blocks the recurring unsupported nature classes before review");
assert.match(sparseDiagnosePrompt, /pathogenesis\.summary 只能归纳/, "M03 summary is constrained to a projection of already-supported core reasoning");
assert.match(sparseDiagnosePrompt, /不得逐项串联或复制 supportingFacts/, "M03 prompt forbids the live failure mode where Western rationale merely re-punctuates the fact list");
assert.match(sparseDiagnosePrompt, /病程\/表现模式 → 当前工作诊断 → 尚缺哪类病因判别信息/, "M03 prompt gives a concrete non-restatement reasoning sequence");
assert.match(sparseDiagnosePrompt, /没有具体病因候选时写“具体病因”而不得臆造疾病/, "M03 prompt keeps the rationale repair from inventing an etiologic diagnosis");

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
const warningAcknowledgementCase = normalizeCaseStateInput({
  ...rareOccupationCase,
  warningAcknowledgement: {
    warningLevel: "L3",
    acknowledgedAt: "2026-07-27T10:00:00.000Z",
    reportFingerprint: `sha256-${"a".repeat(64)}`,
    reason: "已完成人工复核，仅导出风险报告",
    exportMode: "non_dose_risk_report",
  },
});
assert.equal(warningAcknowledgementCase.warningAcknowledgement?.warningLevel, "L3");
assert.equal(warningAcknowledgementCase.warningAcknowledgement?.exportMode, "non_dose_risk_report");
const completeScrubbedExport = scrubReportPhi(buildCompleteReport(rareOccupationCase), rareOccupationCase);
assert.doesNotMatch(completeScrubbedExport, /occupation|大学教授/, "the real report builder never exports a rare occupation quasi-identifier");
const nonDoseRiskExport = buildCompleteReport({
  ...rareOccupationCase,
  safetyGate: {
    status: "red_flag",
    allowDiagnosis: false,
    allowDosePrescription: false,
    action: "refer_or_emergency",
    redFlags: ["持续胸痛伴大汗"],
    reasons: ["优先急诊评估"],
    missingItems: [],
  },
  diagnosis: "## 红旗排查\n持续胸痛伴大汗，建议急诊评估。",
  prescription: "## 中药饮片处方\n黄芪 15g",
});
// 处置改「提示不拦截」：红旗导出**保留**候选方药段（服务端本来就带警示生成了它），
// 警示以最高级别呈现在报告里；把结果从导出里删掉等于前端替医生把工作成果藏起来。
assert.match(nonDoseRiskExport, /持续胸痛伴大汗/, "red-flag exports must surface the red-flag facts");
assert.match(nonDoseRiskExport, /黄芪 15g/, "advisory red-flag exports keep the generated prescription content");
const thunderclapPresentation = buildEmergencyPresentation({
  ...rareOccupationCase,
  chiefComplaint: "突发人生最剧烈头痛伴恶心呕吐",
  safetyGate: {
    status: "red_flag",
    allowDiagnosis: true,
    allowDosePrescription: false,
    action: "refer_or_emergency",
    redFlags: ["突发最剧烈头痛伴恶心呕吐，需先排除急性神经系统事件"],
    redFlagFindings: [{
      ruleId: "acute-neurologic-event",
      severity: "emergency",
      sourceQuote: "突发人生最剧烈头痛伴恶心呕吐",
      ruleExplanation: "需排查急性神经血管事件",
      message: "突发最剧烈头痛伴恶心呕吐",
    }],
    reasons: ["优先急诊评估"],
    missingItems: ["生命体征"],
  },
});
assert.equal(thunderclapPresentation.pageTitle, "急诊转诊建议");
assert.match(thunderclapPresentation.eventTitle, /雷击样头痛/);
assert.ok(thunderclapPresentation.evidenceChips.some((item) => /最剧烈头痛/.test(item)));
assert.ok(thunderclapPresentation.evidenceChips.includes("恶心"));
assert.ok(thunderclapPresentation.evidenceChips.includes("呕吐"));
assert.match(diagnosisClientSource, /!isActiveRedFlag && \(/, "ordinary completion banner must be suppressed on emergency referral pages");
assert.match(diagnosisClientSource, /data-testid="confirm-emergency-clearance"/);
assert.match(diagnosisClientSource, /下载转诊建议与依据/);
const governedCustomerReport = buildCompleteReport({
  ...rareOccupationCase,
  diagnosis: "## 西医诊断\n程序化安全门控已通过；stage-contract 与 sentinel 正常。",
  prescription: "## 候选方药\n剂量级候选方药已形成。",
});
assert.doesNotMatch(
  governedCustomerReport,
  /程序化安全门控|stage-contract|sentinel|剂量级/,
  "page and exported-report surfaces must consume T7's governed doctor-facing vocabulary",
);
assert.match(governedCustomerReport, /风险筛查规则|输出结构校验|包含具体用量的处方建议/);

const legacyAnalysisReport = buildCompleteReport({
  ...rareOccupationCase,
  tcmLineagePreference: "jingfang",
  diagnosis: [
    "## 西医诊断倾向与鉴别",
    "**诊断倾向**：头痛症状",
    "**支持依据**：头痛5天",
    "**临床分析**：现有资料不足以明确病因。",
    "### 鉴别方向",
    "- 偏头痛：需进一步鉴别。",
    "## 中医诊断概览",
    "**证型**：湿浊中阻证",
  ].join("\n"),
});
assert.match(legacyAnalysisReport, /诊断倾向.*头痛症状/);
assert.match(legacyAnalysisReport, /支持依据.*头痛5天/);
assert.doesNotMatch(legacyAnalysisReport, /诊疗思路偏好|临床分析|鉴别方向|偏头痛/, "exports must not revive removed lineage or Western-analysis prose from old snapshots");
const legacyFormulaProcessReport = buildCompleteReport({
  ...rareOccupationCase,
  prescription: [
    "## 本例辨证组方",
    "**未采用经典方说明**：受控目录未覆盖本例病机，故自拟。",
    "**逐味核验**：L3：1，L0：6",
    "## 加减建议核查说明",
    "另有 1 条加减建议未展示：方向冲突。",
  ].join("\n"),
  riskAssessment: "| 采纳候选前 | 完成针对性安全复核 | 过敏史 | 复核后调整 |",
}, {
  warningProfile: { level: "L1", label: "常规复核", executable: true, reasons: [] },
});
assert.doesNotMatch(
  legacyFormulaProcessReport,
  /未采用经典方说明|逐味核验|加减建议核查说明|加减建议未展示|采纳候选前|完成针对性安全复核/,
  "exports must scrub deprecated model-process and hidden-item notices from old snapshots",
);

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
assert.equal(
  prescriptionRiskLabel("info").label,
  "待补充信息后再评估",
  "doctor-facing risk copy must state the next action instead of using the generic '信息不足' label",
);
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
assert.equal(prescribeFailureDisplay.warningLevel, "L2", "ordinary stage failures are recoverable warnings, not red safety incidents");
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
assert.equal(errorRequiresM03Refresh({ phase: "assess", message: "辨病辨证结果签名已失效，请重新生成后再评估。" }), true);
assert.equal(errorRequiresM03Refresh({ phase: "prescribe", message: "模型请求超时" }), false);
assert.equal(errorRequiresM04Refresh({ phase: "assess", message: "当前候选处方缺少有效签名，请重新生成候选方药后再评估。" }), true);
assert.equal(errorRequiresM04Refresh({ phase: "assess", message: "推理已取消" }), false);
assert.equal(
  stageErrorDisplay({ phase: "assess", message: "当前候选处方缺少有效签名，请重新生成候选方药后再评估。" }).retryText,
  "重新生成候选方药并继续",
);
const automaticM04Recovery = automaticSignatureRecoveryState(
  {
    ...rareOccupationCase,
    phase: "assess",
    diagnosis: "已签名辨病辨证",
    prescription: "旧候选处方",
    riskAssessment: "旧审方结果",
    reasoningDiagnose: stableM03,
    reasoningPrescribe: { ...stableM03, stage: "prescribe" },
  },
  { phase: "assess", message: "当前候选处方缺少有效签名，请重新生成候选方药后再评估。" },
);
assert.equal(automaticM04Recovery?.phase, "prescribe");
assert.equal(automaticM04Recovery?.diagnosis, "已签名辨病辨证");
assert.equal(automaticM04Recovery?.prescription, undefined);
assert.equal(automaticM04Recovery?.reasoningDiagnose, stableM03);
assert.equal(automaticM04Recovery?.reasoningPrescribe, undefined);
assert.equal(
  stageErrorDisplay({ phase: "assess", message: "检测到伪造的处方签名" }).warningLevel,
  "L3",
  "integrity/security failures remain red high-risk warnings",
);

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
assert.match(missingVitals.desc, /非高风险病例不因此阻断候选处方生成/);

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
    overview: { tcmDiseaseName: "中风", primarySyndrome: "肺阴虚证", tcmDiagnosticRationale: "肢体乏力结合病程支持当前中医工作判断，具体证候仍需独立复核。", tcmDifferentials: [], overallPathogenesis: "肺阴不足", overallTherapy: "养阴润肺", recommendedFormulaDirection: "养阴润肺", evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } },
    westernDiagnosis: { primary: { name: "病历记录头痛阳性；病历记录否认头痛", status: "考虑", confidence: "中", supportingFacts: [], clinicalRationale: "现有病程支持症状级工作判断，但具体诊断标签仍需独立复核。", limitations: [], suggestedChecks: [], evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } }, differentials: [] },
    pathogenesis: { locationDifferentiation: { items: ["肺"], resolution: "bounded", resolutionReason: "病位由当前病机归纳" }, chain: [{ nodeId: "P8", patientFact: "脑梗死后右侧肢体乏力3个月", syndromeEvidence: "肢体无力", pathogenesis: "肺阴不足", therapyDirection: "养阴润肺" }], uncertainties: [] },
    therapy: { overallPrinciple: "虚则补之", overallMethod: "益气养阴，兼顾通络", subTherapies: [{ therapy: "养阴润肺", targetPathogenesis: "肺阴不足", priority: "主要" }] },
    management: { followupSafetyNet: "若肢体乏力明显加重或出现新发言语不清、口角歪斜，立即急诊评估。" },
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
assert.equal(normalizedM03Json.pathogenesis.chain[0].patientFact, "脑梗死后右侧肢体无力3个月，要求康复调理", "患者事实保留原文内容但移除表单传输标签，避免参考依据只是在重复字段名");
assert.equal(normalizedM03Json.pathogenesis.chain[0].syndromeEvidence, "肢体无力", "evidence remains a distinct grounded observation instead of being overwritten by patientFact");
assert.equal(isStableM03Reasoning(normalizedM03Json, lowConfidenceContext), false, "grounded observations alone cannot sign an unsupported mechanism and treatment chain");

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
const legacyFollowupSummary = buildDecisionSummary({
  followupTimeline: [
    { time: "采纳候选前", action: "完成针对性安全复核", indicators: ["过敏史"], triggers: ["必要时调整"] },
    { time: "5日后", action: "完成首次复诊与疗效复评", indicators: ["头痛程度"], triggers: ["加重时提前复诊"] },
  ],
});
assert.deepEqual(legacyFollowupSummary.followupTimelineItems, [{
  time: "5日后",
  action: "完成首次复诊与疗效复评",
  indicators: ["头痛程度"],
  triggers: ["加重时提前复诊"],
}]);

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

// ─── 经典条文出处必须真的渲染，且不得越界断言 ───
// 222,338 条古籍证据此前只在服务端被填进 candidate.classicEvidence 随流下发，
// 前端与 HIS 零渲染——医生只看到一行「经典方出处：《XX》」，拿不到任何可核验原文。
// 证据绑定系统里，看不到原文的「证据」等于没有证据。
assert.ok(diagnosisClientSource.includes("ClassicEvidencePanel"), "候选方卡必须渲染经典条文出处面板");
assert.match(diagnosisClientSource, /<ClassicEvidencePanel evidence=\{firstCandidate\.classicEvidence\}/,
  "面板必须消费 candidate.classicEvidence，而不是另造一份数据");
const panelStart = diagnosisClientSource.indexOf("function ClassicEvidencePanel(");
const panel = diagnosisClientSource.slice(panelStart, diagnosisClientSource.indexOf("function DecoctionInstructionsPanel"));
assert.ok(panel.includes("item.excerpt"), "必须渲染条文摘录——只给出处不给原文，医生无从核验");
assert.ok(panel.includes("不代表适用于本例"),
  "必须声明这些条文是按方名检索所得、不代表适用于本例，否则等于用出处冒充适应证依据");
assert.ok(panel.includes("以上方药味表与处方后审方为准"),
  "必须声明古代剂量不可直接换算，本例用量以药味表与审方为准");
assert.match(panel, /<details/, "默认折叠：右栏宽度有限，条文是核验材料不是首屏结论");

console.log(JSON.stringify({ cases: 134, failures: 0 }));

// ─── 被剥离的方名选择必须告诉医生 ────────────────────────────────────────────
// 方名锁定要求签名证候与该方在治理目录中有直接关系，关系不成立就剥离——这一步是对的。
// 但剥离结果 deferredFormulaSelection 此前写进签名信封后三处都不渲染（界面、可见摘要、HIS），
// 医生只看到「本例辨证组方」，不知道模型选过方，更不知道为什么没采纳。
//
// 实测：恶寒重发热轻、无汗、脉浮紧、舌淡红苔薄白的教科书麻黄汤证，模型选的正是麻黄汤，
// 因「签名的是风寒束表证、麻黄汤目录标的是风寒束肺证」被剥离，显示为自拟方。
{
  const { synchronizeVisibleClinicalSummary } = await import("../src/lib/diagnosis-visible-summary.ts");
  const reasoning = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: {
      tcmDiseaseName: "感冒", primarySyndrome: "风寒束表证", primarySyndromeResolution: "bounded",
      primarySyndromeBasis: ["恶寒发热2天"], overallPathogenesis: "风寒外束，卫阳被郁",
      overallTherapy: "辛温解表", recommendedFormulaDirection: "按已锁定病机与治法辨证组方",
      recommendedFormulaNames: [], formulaSelectionMode: "self_devised", secondarySyndromes: [],
      deferredFormulaSelection: {
        direction: "麻黄汤加减", names: ["麻黄汤"], mode: "single",
        reason: "semantic_mapping_pending_clinician_confirmation",
      },
    },
    westernDiagnosis: { primary: { name: "急性上呼吸道感染", supportingFacts: ["恶寒发热2天"] }, differentials: [] },
    pathogenesis: {
      summary: "风寒外束",
      chain: [{ nodeId: "P1", patientFact: "恶寒发热2天", syndromeEvidence: "脉浮紧", pathogenesis: "风寒束表", therapyDirection: "辛温解表" }],
      uncertainties: [],
    },
    therapy: { overallPrinciple: "治病求本", overallMethod: "辛温解表", subTherapies: [] },
    management: { followupSafetyNet: "若出现高热不退或呼吸困难应立即就医。" },
  };
  const visible = synchronizeVisibleClinicalSummary(
    `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`,
    "diagnose",
  );
  assert.match(visible, /待确认方名/, "被剥离的方名必须出现在医生可见摘要里");
  assert.match(visible, /麻黄汤/, "必须逐字给出模型原本选的方名");
  assert.match(visible, /未予锁定|由医生/, "措辞必须说明它未被锁定、由医生判断，不能读成推荐");
  // 没有被剥离选择时不得凭空生成这一行。
  const withoutDeferred = structuredClone(reasoning);
  delete withoutDeferred.overview.deferredFormulaSelection;
  assert.doesNotMatch(
    synchronizeVisibleClinicalSummary(
      `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(withoutDeferred)}\n<!-- DIAGNOSIS_JSON_END -->`,
      "diagnose",
    ),
    /待确认方名/,
    "没有被剥离的选择时不得输出该行",
  );
}

// DECOCT-01 同类守卫：decoction 的数字字段(dosesPerDay/administrationTimesPerDay)不得被
// markdownCell 的字符串清洗吞成空位——那正是甲方生产实测的「每日  剂 / 每日分  次服」
// 空白模板残片(第二次复发,这次是数字被清洗层置空;re-render 会绕过 outputTransform 清洗,
// 必须在渲染源头保证)。数字缺失时整行省略,不产出空位。
{
  const { synchronizeVisibleClinicalSummary: syncForDecoction } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  const rxPayload = {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    overview: { primarySyndrome: "风寒束表证", primarySyndromeBasis: ["恶寒发热"], overallPathogenesis: "风寒束表", overallTherapy: "辛温解表", recommendedFormulaDirection: "桂枝汤加减", evidence: { evidenceLevel: "model_inference", source: "test" } },
    westernDiagnosis: { primary: { name: "上呼吸道感染", status: "考虑", confidence: "中", supportingFacts: ["恶寒发热2天"], limitations: [], suggestedChecks: [], evidence: { evidenceLevel: "model_inference", source: "test" } }, differentials: [] },
    pathogenesis: { summary: "风寒束表", locationDifferentiation: { items: ["肺"], resolution: "bounded", evidence: { evidenceLevel: "model_inference", source: "test" } }, natureDifferentiation: { items: ["寒"], resolution: "bounded", evidence: { evidenceLevel: "model_inference", source: "test" } }, chain: [], uncertainties: [] },
    therapy: { overallPrinciple: "扶正祛邪", overallMethod: "辛温解表", subTherapies: [] },
    formula: {
      candidates: [{
        name: "桂枝汤加减",
        herbs: [{ name: "桂枝", dose: "9g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1" }],
        decoction: { doseCount: "3剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日1剂，水煎分服", course: "3日", followUpNode: "完成3剂后复诊" },
      }],
    },
    nonPharma: null,
  };
  const wrap = (payload) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(payload)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const rendered = syncForDecoction(wrap(rxPayload), "prescribe");
  assert.match(rendered, /每日 1 剂 \/ 每日分 2 次服/, "数字剂数必须完整渲染");
  assert.doesNotMatch(rendered, /每日[\s　]*剂[\s　]*\//, "不得出现数字缺失的空白服法模板");
  const missingNumbers = structuredClone(rxPayload);
  delete missingNumbers.formula.candidates[0].decoction.dosesPerDay;
  const renderedMissing = syncForDecoction(wrap(missingNumbers), "prescribe");
  assert.doesNotMatch(renderedMissing, /每日剂数 \/ 分服次数/, "数字缺失时整行省略而不是渲染空位");
}
