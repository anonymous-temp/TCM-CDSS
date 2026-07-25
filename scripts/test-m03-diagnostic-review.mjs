import assert from "node:assert/strict";
import { createJiti } from "jiti";

import {
  boundedM03DiagnosticRepairGuidance,
  buildM03DiagnosticReviewAdjudicationPrompt,
  buildM03DiagnosticReviewPayload,
  buildM03DiagnosticReviewPrompt,
  canRebindM03DiagnosticReview,
  m03DiagnosticReviewDiffPaths,
  m03DiagnosticRepairGuidanceCodes,
  m03DiagnosticReviewSemanticHash,
  m03DiagnosticReviewNeedsAdjudication,
  m03GroundingHasCurrentPositiveFacts,
  m03PathogenesisSummaryIsExactProjection,
  m03TcmRepairMode,
  matchesM03QuarantineShape,
  parseM03DiagnosticReview,
  preflightM03DiagnosticReview,
} from "../src/lib/m03-diagnostic-review.ts";
import { canRebindM04ClinicalReview, m04ClinicalReviewDiffPaths } from "../src/lib/m04-clinical-review.ts";

const evidence = { evidenceLevel: "model_inference", source: "本例四诊资料", confidence: "中" };
const reviewed = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "不寐",
    primarySyndrome: "心脾两虚证",
    primarySyndromeBasis: ["心悸健忘", "纳差便溏"],
    tcmDiagnosticRationale: "心悸健忘与纳差便溏并见，结合舌淡脉细弱，支持心脾两虚、心神失养。",
    tcmDifferentials: [],
    secondarySyndromes: [],
    overallPathogenesis: "脾气亏虚，心血失养",
    overallTherapy: "健脾益气，养血安神",
    recommendedFormulaDirection: "归脾汤加减",
    recommendedFormulaNames: ["归脾汤"],
    formulaSelectionMode: "single",
    evidence,
  },
  westernDiagnosis: {
    primary: {
      name: "失眠症状",
      status: "考虑",
      confidence: "中",
      supportingFacts: ["入睡困难、多梦易醒3个月"],
      clinicalRationale: "入睡困难、多梦易醒3个月支持失眠症状方向，但尚未取得日间功能受损情况，暂不升级为正式失眠障碍诊断。",
      limitations: ["未完成睡眠量表"],
      suggestedChecks: [],
      evidence,
    },
    differentials: [],
  },
  pathogenesis: {
    summary: "心脾两虚，心神失养",
    locationDifferentiation: { items: ["心", "脾"], evidence },
    natureDifferentiation: { items: ["气虚", "血虚"], evidence },
    chain: [{
      nodeId: "P1",
      patientFact: "心悸健忘、纳差便溏",
      syndromeEvidence: "舌淡，脉细弱",
      pathogenesis: "脾气亏虚，心血失养",
      therapyDirection: "健脾益气，养血安神",
      evidence,
    }],
    uncertainties: [],
  },
  therapy: {
    overallPrinciple: "虚则补之，标本兼顾",
    overallMethod: "健脾益气，养血安神",
    subTherapies: [
      { therapy: "健脾益气", targetPathogenesis: "脾气亏虚", priority: "主要" },
      { therapy: "养血安神", targetPathogenesis: "心血失养", priority: "兼顾" },
    ],
  },
  management: { followupSafetyNet: "若入睡困难持续2周不缓解或明显加重，及时复诊评估。" },
};

const provenanceOnly = structuredClone(reviewed);
provenanceOnly.overview.evidence = { ...evidence, source: "经服务端证据白名单核验" };
provenanceOnly.pathogenesis.chain[0].evidence = { ...evidence, confidence: "高" };
provenanceOnly.contractSignature = "hmac-sha256:placeholder";
provenanceOnly.clinicalReview = { status: "accepted", reviewedPayloadHash: "sha256:placeholder" };
provenanceOnly.formula = null;
provenanceOnly.nonPharma = null;

assert.deepEqual(buildM03DiagnosticReviewPayload(provenanceOnly), buildM03DiagnosticReviewPayload(reviewed));
assert.equal(m03DiagnosticReviewSemanticHash(provenanceOnly), m03DiagnosticReviewSemanticHash(reviewed));
assert.equal(canRebindM03DiagnosticReview(reviewed, provenanceOnly), true);
assert.deepEqual(m03DiagnosticReviewDiffPaths(reviewed, provenanceOnly), []);

for (const mutate of [
  (value) => { value.westernDiagnosis.primary.supportingFacts = ["无来源的新事实"]; },
  (value) => { value.overview.primarySyndrome = "痰热扰心证"; },
  (value) => { value.pathogenesis.chain[0].therapyDirection = "清热化痰"; },
  (value) => { value.overview.recommendedFormulaNames = ["黄连温胆汤"]; },
]) {
  const changed = structuredClone(reviewed);
  mutate(changed);
  assert.equal(canRebindM03DiagnosticReview(reviewed, changed), false);
  assert.ok(m03DiagnosticReviewDiffPaths(reviewed, changed).length > 0);
}
const groundedDifferentialReduction = structuredClone(reviewed);
groundedDifferentialReduction.westernDiagnosis.differentials = [{
  name: "焦虑相关睡眠障碍",
  reason: "当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。",
  nextCheck: "评估情绪与睡眠关系",
}];
const reviewedBeforeGrounding = structuredClone(groundedDifferentialReduction);
reviewedBeforeGrounding.westernDiagnosis.differentials[0].reason = "近期压力增加，需鉴别焦虑相关睡眠障碍";
assert.equal(canRebindM03DiagnosticReview(reviewedBeforeGrounding, groundedDifferentialReduction), true, "a server-owned conservative differential-reason reduction does not redraw an unchanged M03 review");
assert.deepEqual(m03DiagnosticReviewDiffPaths(reviewedBeforeGrounding, groundedDifferentialReduction), ["m03Review.westernDiagnosis.differentials[0].reason"]);
const unsafeDifferentialRewrite = structuredClone(groundedDifferentialReduction);
unsafeDifferentialRewrite.westernDiagnosis.differentials[0].reason = "已确诊焦虑障碍导致本次失眠";
assert.equal(canRebindM03DiagnosticReview(reviewedBeforeGrounding, unsafeDifferentialRewrite), false, "an arbitrary differential rationale change still requires a new review");

assert.deepEqual(parseM03DiagnosticReview('{"status":"accepted","issueCode":"none"}'), {
  status: "accepted",
  issueCode: "none",
});
assert.deepEqual(parseM03DiagnosticReview('{"status":"repair","issueCode":"supporting_fact_mismatch"}'), {
  status: "repair",
  issueCode: "supporting_fact_mismatch",
});
assert.deepEqual(parseM03DiagnosticReview('{"status":"repair","issueCode":"tcm_reasoning_unsupported","repairInstruction":"pathogenesis.chain[0] 使用了病历未支持的痰热方向，请删除并按现有阳性事实降级。"}'), {
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "pathogenesis.chain[0] 使用了病历未支持的痰热方向，请删除并按现有阳性事实降级。",
});
const boundedTcmGuidance = boundedM03DiagnosticRepairGuidance({
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "清空病机链并补入阴虚火旺",
});
assert.match(boundedTcmGuidance, /硬性删减/);
assert.match(boundedTcmGuidance, /阴虚、阳虚、气虚、血虚/);
assert.match(boundedTcmGuidance, /语义隔离模式/);
assert.doesNotMatch(boundedTcmGuidance, /清空病机链并补入阴虚火旺/);
const emptyReviewed = structuredClone(reviewed);
emptyReviewed.pathogenesis.chain = [];
const reviewedClinicalContext = "心悸健忘、纳差便溏；舌淡，脉细弱；入睡困难、多梦易醒3个月";
assert.deepEqual(preflightM03DiagnosticReview(emptyReviewed, reviewedClinicalContext), {
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "deterministic_contract:chain_empty",
});
assert.equal(preflightM03DiagnosticReview(reviewed, reviewedClinicalContext), undefined);
assert.equal(boundedM03DiagnosticRepairGuidance({
  status: "repair",
  issueCode: "formula_indication_mismatch",
  repairInstruction: "移除缺少方证依据的命名方",
}), "移除缺少方证依据的命名方");
assert.deepEqual(m03DiagnosticRepairGuidanceCodes({
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "病机链只是重复主诉，阴虚与营卫失和均无充分支持；请勿清空病位病性。",
}), ["empty_or_unresolved", "symptom_restatement", "chain_not_closed", "yin_deficiency_overreach", "ying_wei_overreach"]);
assert.equal(parseM03DiagnosticReview('{"status":"accepted","issueCode":"invented"}').status, "unavailable");

// ─── Reviewer prompt ↔ repair policy consistency (single sparse-case shape) ───
// The reviewer prompt must document exactly one bounded neutral shape and accept it ONLY for
// genuinely sparse cases; when current positive findings beyond the chief complaint exist it must
// reject neutral-degraded output. The previously unconditional wording let the reviewer both
// accept and reject the only shape the server repair policy can produce, flipping across runs.
const reviewPrompt = buildM03DiagnosticReviewPrompt("主诉：入睡困难、多梦易醒3个月。", reviewed, "");
const sparseAcceptIdx = reviewPrompt.indexOf("除主诉外没有其他当前阳性发现");
const factsRejectIdx = reviewPrompt.indexOf("主诉之外仍有当前阳性事实");
const boundedDiseaseMechanismIdx = reviewPrompt.indexOf("当额外事实只是主症的次数");
assert.ok(sparseAcceptIdx !== -1, "prompt must document the sparse-case acceptance branch");
assert.match(reviewPrompt, /服务端事实极性分类：情形一/);
assert.match(reviewPrompt, /就必须 accepted/);
assert.match(reviewPrompt, /不得再以“只有主诉”/);
assert.match(reviewPrompt, /胃失和降、气机不畅/);
assert.ok(reviewPrompt.includes("症状层的工作证候"), "prompt must name the bounded symptom-specific primary-syndrome shape");
assert.match(reviewPrompt, /不得使用‘功能失调候’‘调护功能’这类跨病例套话/);
assert.match(reviewPrompt, /病位与病性按治理表正交编码/);
assert.match(reviewPrompt, /M03统一临床推理权威合同/);
assert.match(reviewPrompt, /L2 证候归纳层/);
assert.match(reviewPrompt, /病机词和治法词是临床解释，不要求逐字出现在患者原话中/);
assert.match(reviewPrompt, /两个及以上相互独立的阳性事实维度/);
assert.match(reviewPrompt, /不得要求改成非标准复合项‘脾气虚’‘心血虚’/);
assert.match(reviewPrompt, /当前阳性事实覆盖审计/);
assert.match(reviewPrompt, /病机总结投影一致性审计/);
assert.match(reviewPrompt, /pathogenesis_summary_drift/);
assert.match(reviewPrompt, /按顺序用分号连接的文本完全一致.*不得返回 pathogenesis_summary_drift/, "the reviewer must not reject the server-owned chain projection as a second reasoning surface");
assert.match(reviewPrompt, /活动后气喘、夜间症状、体重变化、出血、神经功能改变/);
assert.match(reviewPrompt, /单有夜间憋醒不能诊断阻塞性睡眠呼吸暂停/);
assert.match(reviewPrompt, /支气管哮喘作为 primary/);
assert.match(reviewPrompt, /应使用与主导症状精确一致的症状级工作诊断/);
assert.match(reviewPrompt, /只记录喘鸣、胸口呼呼响而未明确气不够用时应写喘息症状/);
assert.match(reviewPrompt, /不得改写成劳力性呼吸困难或气短/);
assert.match(reviewPrompt, /不得让次要伴随症状抢占 primary/);
assert.match(reviewPrompt, /大便解不出来、排便费劲或数日一次为核心时，应使用便秘症状/);
assert.match(reviewPrompt, /呼吸—心源性交叉鉴别审计/);
assert.match(reviewPrompt, /differentials 必须覆盖呼吸系统、心功能不全和冠心病\/心肌缺血等心源性方向/);
assert.match(reviewPrompt, /不得重复同一诊断/);
assert.match(reviewPrompt, /缺少客观依据时绝不能把心衰或冠心病写成 primary 或确诊/);
assert.match(reviewPrompt, /中老年新发或进行性排便习惯改变做患者特异的报警征象审计/);
assert.match(reviewPrompt, /不能再用‘若年龄>40岁\/50岁’这种未实例化的假设句/);
assert.match(reviewPrompt, /本例已满足的年龄与病程条件/);
assert.match(reviewPrompt, /positive_fact_omission/);
assert.match(reviewPrompt, /不能归入主证的事实放入 uncertainties/);
assert.match(reviewPrompt, /uncertainty_state_mismatch/);
assert.match(reviewPrompt, /该症状已在病历中明确记录/);
assert.ok(factsRejectIdx !== -1, "prompt must document the facts-present rejection branch");
assert.ok(boundedDiseaseMechanismIdx > factsRejectIdx, "active-case depth must distinguish syndrome evidence from same-complaint frequency and course facts");
assert.match(reviewPrompt, /最浅层基础功能病机不属于‘症状复述’/);
assert.match(reviewPrompt, /一律返回 tcm_reasoning_unsupported/);
assert.match(reviewPrompt, /没有情绪相关加重.*肝气郁结.*必须返回 tcm_reasoning_unsupported/, "the reviewer must reject unsupported causal TCM attribution instead of accepting it as low-confidence prose");
assert.deepEqual(m03DiagnosticRepairGuidanceCodes({
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "pathogenesis.chain 写入肝气郁结，但病历未提供情志诱因或其他直接依据，请删除。",
}), ["chain_not_closed", "etiology_overreach"]);
const positiveFactOmissionReview = {
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "positive_fact_omission：活动后气喘这一当前阳性事实未纳入 primarySyndromeBasis、pathogenesis.chain 或 uncertainties。",
};
assert.deepEqual(m03DiagnosticRepairGuidanceCodes(positiveFactOmissionReview), ["positive_fact_omission"]);
assert.equal(m03TcmRepairMode(positiveFactOmissionReview, true), "fact_anchored");
assert.match(boundedM03DiagnosticRepairGuidance(positiveFactOmissionReview, { hasCurrentPositiveFacts: true }), /覆盖修复/);
assert.match(boundedM03DiagnosticRepairGuidance(positiveFactOmissionReview, { hasCurrentPositiveFacts: true }), /每项至少进入 westernDiagnosis 依据\/鉴别、primarySyndromeBasis、pathogenesis\.chain\.patientFact 或 uncertainties 之一/);
assert.doesNotMatch(boundedM03DiagnosticRepairGuidance(positiveFactOmissionReview, { hasCurrentPositiveFacts: true }), /活动后气喘/, "reviewer prose and patient facts stay outside server-owned repair guidance");
const summaryDriftReview = {
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "pathogenesis_summary_drift：总结额外引入正气略虚，只修正 pathogenesis.summary。",
};
assert.deepEqual(m03DiagnosticRepairGuidanceCodes(summaryDriftReview), ["pathogenesis_summary_drift"]);
const summaryDriftGuidance = boundedM03DiagnosticRepairGuidance(summaryDriftReview, { hasCurrentPositiveFacts: true });
assert.match(summaryDriftGuidance, /只修正 pathogenesis\.summary/);
assert.match(summaryDriftGuidance, /保持已通过校验的西医诊断、中医主证/);
assert.doesNotMatch(summaryDriftGuidance, /正气略虚/, "reviewer prose and unsupported conclusions stay outside server-owned repair guidance");
const summaryAndCoreDriftReview = {
  ...summaryDriftReview,
  repairInstruction: "pathogenesis_summary_drift：总结额外引入新病性；blood_stasis_overreach：血瘀结论超出阳性事实，请删除。",
};
assert.deepEqual(
  m03DiagnosticRepairGuidanceCodes(summaryAndCoreDriftReview),
  ["pathogenesis_summary_drift", "blood_stasis_overreach"],
);
const summaryAndCoreDriftGuidance = boundedM03DiagnosticRepairGuidance(summaryAndCoreDriftReview, { hasCurrentPositiveFacts: true });
assert.match(summaryAndCoreDriftGuidance, /硬性删减/);
assert.match(summaryAndCoreDriftGuidance, /主诉之外仍有当前阳性事实/);
assert.doesNotMatch(summaryAndCoreDriftGuidance, /只修正 pathogenesis\.summary/, "summary drift must not hide simultaneous authoritative-core overreach");
assert.match(boundedM03DiagnosticRepairGuidance({
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "肝气郁结缺少情志诱因支持",
}), /未经患者事实直接支持的病因、诱因和传变路径/);

// ─── matchesM03QuarantineShape: code-level mirror of the quarantine shape ───
const quarantineCandidate = structuredClone(reviewed);
quarantineCandidate.overview.primarySyndrome = "不寐低置信度工作证候";
quarantineCandidate.overview.primarySyndromeResolution = "bounded";
quarantineCandidate.overview.overallPathogenesis = "睡眠节律受扰";
quarantineCandidate.overview.overallTherapy = "改善睡眠节律";
quarantineCandidate.overview.recommendedFormulaDirection = "围绕睡眠节律的辨证组方方向";
quarantineCandidate.overview.recommendedFormulaNames = [];
quarantineCandidate.overview.formulaSelectionMode = "self_devised";
quarantineCandidate.pathogenesis.locationDifferentiation = { items: [], resolution: "unresolved", resolutionReason: "无阳性事实支持具体脏腑归属" };
quarantineCandidate.pathogenesis.natureDifferentiation = { items: [], resolution: "unresolved", resolutionReason: "寒热虚实证据不足" };
quarantineCandidate.pathogenesis.summary = "入睡过程受扰，睡眠节律不稳";
quarantineCandidate.pathogenesis.chain = [{
  nodeId: "P1",
  patientFact: "入睡困难、多梦易醒3个月",
  syndromeEvidence: "入睡困难、多梦易醒3个月",
  pathogenesis: "睡眠节律受扰",
  therapyDirection: "改善睡眠节律",
  evidence,
}];
quarantineCandidate.therapy = { overallPrinciple: "改善入睡过程", overallMethod: "调护睡眠节律", subTherapies: [] };
assert.equal(matchesM03QuarantineShape(quarantineCandidate), true);
const emptyItemsBounded = structuredClone(quarantineCandidate);
emptyItemsBounded.pathogenesis.locationDifferentiation = { items: [], resolution: "bounded" };
assert.equal(matchesM03QuarantineShape(emptyItemsBounded), true);
// The fact-anchored fixture is not a quarantine candidate.
assert.equal(matchesM03QuarantineShape(reviewed), false);
for (const mutate of [
  (value) => { value.overview.recommendedFormulaNames = ["归脾汤"]; },
  (value) => { value.pathogenesis.chain[0].pathogenesis = "阴虚火旺，扰动心神"; },
  (value) => { value.pathogenesis.chain[0].therapyDirection = "清热化痰"; },
  (value) => { value.pathogenesis.locationDifferentiation = { items: ["心", "脾"], evidence }; },
  (value) => { value.pathogenesis.chain = []; },
  (value) => { value.overview.primarySyndrome = "阴虚火旺证"; },
  (value) => { value.overview.overallPathogenesis = "阴虚火旺，扰动心神"; },
  (value) => { value.pathogenesis.summary = "阴虚导致失眠"; },
  (value) => { value.pathogenesis.natureDifferentiation = { items: [], rootDeficiency: ["阴虚"], resolution: "unresolved" }; },
  (value) => { value.therapy.overallPrinciple = "滋阴清热"; },
  (value) => { value.therapy.subTherapies = [{ therapy: "养血安神", targetPathogenesis: "血虚" }]; },
]) {
  const changed = structuredClone(quarantineCandidate);
  mutate(changed);
  assert.equal(matchesM03QuarantineShape(changed), false);
}
assert.equal(matchesM03QuarantineShape(null), false);
assert.equal(matchesM03QuarantineShape({}), false);

// ─── authoritativeTruncateFallback stage guard (programmer-error hard fail) ───
// Force a deterministic unconfigured provider so the legitimate diagnose path returns its normal
// config error instead of touching the network; the guard itself throws before any config check.
process.env.OPENAI_API_KEY = "";
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const { callDiagnosisStream, clinicalReviewModelCandidates, clinicalReviewRetryPlan, modelForStructuredRepair, shouldRegenerateM03ClinicalRepair, shouldRetryStructuredRepairTransport } = await jiti.import("../src/lib/diagnosis-api.ts");
assert.deepEqual(clinicalReviewRetryPlan(0, 30_000, 35_000), { attemptCount: 0, chainBudgetMs: 35_000 });
assert.deepEqual(clinicalReviewRetryPlan(2, 30_000, 35_000), { attemptCount: 2, chainBudgetMs: 35_000 });
assert.deepEqual(clinicalReviewRetryPlan(1, 30_000, 35_000), { attemptCount: 2, chainBudgetMs: 50_000 }, "one independent reviewer gets one bounded transient retry");
assert.deepEqual(clinicalReviewRetryPlan(1, 45_000, 35_000), { attemptCount: 2, chainBudgetMs: 60_000 }, "retry budget remains bounded even with the maximum per-attempt timeout");
assert.equal(shouldRegenerateM03ClinicalRepair("diagnose", "m03_tcm_reasoning_semantic_review", "独立复核的受控定位标签：phlegm_damp_overreach"), true, "TCM semantic overreach is regenerated from patient facts instead of editing the biased candidate");
assert.equal(shouldRegenerateM03ClinicalRepair("diagnose", "m03_primary_diagnosis_semantic_review", "独立复核的受控定位标签"), false, "western label repair retains its field-targeted path");
assert.equal(shouldRegenerateM03ClinicalRepair("prescribe", "m03_tcm_reasoning_semantic_review", "独立复核的受控定位标签"), false, "M04 repair behavior is unchanged");

const reviewModelEnv = {
  diagnose: process.env.PRIMARY_DIAGNOSE_MODEL,
  prescribe: process.env.PRIMARY_PRESCRIBE_MODEL,
  preferred: process.env.PRIMARY_CLINICAL_REVIEW_MODEL,
  diagnoseRepair: process.env.PRIMARY_DIAGNOSE_REPAIR_MODEL,
  diagnoseFallback: process.env.PRIMARY_DIAGNOSE_REVIEW_FALLBACK_MODEL,
  prescribeFallback: process.env.PRIMARY_PRESCRIBE_REVIEW_FALLBACK_MODEL,
};
try {
  process.env.PRIMARY_DIAGNOSE_MODEL = "deepseek-v4-pro";
  process.env.PRIMARY_PRESCRIBE_MODEL = "deepseek-v4-pro";
  process.env.PRIMARY_CLINICAL_REVIEW_MODEL = "deepseek-v4-pro";
  process.env.PRIMARY_DIAGNOSE_REVIEW_FALLBACK_MODEL = "deepseek-v4-pro";
  delete process.env.PRIMARY_DIAGNOSE_REPAIR_MODEL;
  assert.equal(modelForStructuredRepair("deepseek-v4-pro", "diagnose"), "deepseek-v4-pro", "M03 fact-regeneration repair defaults to the diagnostic reasoning model");
  process.env.PRIMARY_DIAGNOSE_REPAIR_MODEL = "deepseek-v4-pro";
  assert.equal(modelForStructuredRepair("deepseek-v4-pro", "diagnose"), "deepseek-v4-pro", "an explicit M03 repair model override remains authoritative");
  delete process.env.PRIMARY_DIAGNOSE_REPAIR_MODEL;
  // Reproduce the production topology: every textual phase is pinned to V4 Pro. Review remains
  // a fresh review-only request, while metadata honestly records that it is not cross-model.
  process.env.PRIMARY_PRESCRIBE_REVIEW_FALLBACK_MODEL = "deepseek-v4-pro";
  const primary = {
    provider: "openai-compatible",
    model: "deepseek-v4-pro",
    apiKey: "test-key",
    baseUrl: "https://model.example.test/v1",
    configured: true,
  };
  assert.deepEqual(
    clinicalReviewModelCandidates("diagnose", primary, "deepseek-v4-pro").map((candidate) => ({
      model: candidate.model,
      independentInvocation: candidate.independentInvocation,
      independentFromGenerator: candidate.independentFromGenerator,
    })),
    [{ model: "deepseek-v4-pro", independentInvocation: true, independentFromGenerator: false }],
    "an all-Pro deployment keeps a separate auditable review invocation without claiming cross-model independence",
  );
  assert.deepEqual(
    clinicalReviewModelCandidates("prescribe", primary, "deepseek-v4-pro").map((candidate) => candidate.model),
    ["deepseek-v4-pro"],
    "M04 generation, repair and independent review all stay pinned to V4 Pro",
  );
} finally {
  for (const [key, value] of [
    ["PRIMARY_DIAGNOSE_MODEL", reviewModelEnv.diagnose],
    ["PRIMARY_PRESCRIBE_MODEL", reviewModelEnv.prescribe],
    ["PRIMARY_CLINICAL_REVIEW_MODEL", reviewModelEnv.preferred],
    ["PRIMARY_DIAGNOSE_REPAIR_MODEL", reviewModelEnv.diagnoseRepair],
    ["PRIMARY_DIAGNOSE_REVIEW_FALLBACK_MODEL", reviewModelEnv.diagnoseFallback],
    ["PRIMARY_PRESCRIBE_REVIEW_FALLBACK_MODEL", reviewModelEnv.prescribeFallback],
  ]) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}
assert.equal(shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_network_error" }, 40_000, undefined, 10_000), true);
assert.equal(shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_http_error", status: 503 }, 40_000, undefined, 10_000), true);
assert.equal(shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_http_error", status: 401 }, 40_000, undefined, 10_000), false);
assert.equal(shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_network_error" }, 19_999, undefined, 10_000), false, "less than ten seconds cannot start a second repair draw");
const abortedRepair = new AbortController();
abortedRepair.abort();
assert.equal(shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_network_error" }, 40_000, abortedRepair.signal, 10_000), false);
await assert.rejects(
  callDiagnosisStream("p", "deepseek", undefined, "markdown", {
    truncateFallback: "x",
    authoritativeTruncateFallback: true,
    structuredStage: "prescribe",
  }),
  /authoritativeTruncateFallback requires structuredStage/,
);
await assert.rejects(
  callDiagnosisStream("p", "deepseek", undefined, "markdown", {
    truncateFallback: "x",
    authoritativeTruncateFallback: true,
  }),
  /authoritativeTruncateFallback requires structuredStage/,
);
const diagnoseGuardPassThrough = await callDiagnosisStream("p", "deepseek", undefined, "markdown", {
  truncateFallback: "x",
  authoritativeTruncateFallback: true,
  structuredStage: "diagnose",
});
assert.ok(diagnoseGuardPassThrough instanceof Response);
assert.equal(diagnoseGuardPassThrough.status, 500);

// ─── (a) Active-case repair guidance: fact-anchored, non-quarantine ───
// For under-depth rejections on cases WITH current positive findings beyond the chief complaint,
// the reviewer demands a fact-anchored syndrome, so the server repair policy must NOT inject
// quarantine guidance there; it must demand a minimal fact-anchored syndrome while keeping the
// overreach bans. Overreach rejections keep the quarantine policy even on active cases.
const tcmReview = {
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "主证候只是主诉的机械改写，病机链未形成闭环，请围绕现有阳性事实重建。",
};
const activeGuidance = boundedM03DiagnosticRepairGuidance(tcmReview, { hasCurrentPositiveFacts: true });
assert.doesNotMatch(activeGuidance, /语义隔离模式/);
assert.match(activeGuidance, /禁止退回到症状复述或疾病标签改写/);
assert.match(activeGuidance, /额外事实只是主症的次数、时程、性状或诱发规律/);
assert.match(activeGuidance, /tcmDiseaseName 所定义的最浅层基础功能病机/);
assert.match(activeGuidance, /primarySyndromeBasis 逐字引用患者原文/);
assert.match(activeGuidance, /阴虚、阳虚、气虚、血虚/);
assert.match(activeGuidance, /不得补造未出现的事实/);
assert.match(activeGuidance, /self_devised/);
const sparseGuidance = boundedM03DiagnosticRepairGuidance(tcmReview, { hasCurrentPositiveFacts: false });
assert.match(sparseGuidance, /语义隔离模式/);
assert.match(sparseGuidance, /症状层、低置信度的临床工作表述/);
assert.match(sparseGuidance, /不得出现‘功能失调候’‘调护功能’/);
assert.equal(boundedM03DiagnosticRepairGuidance(tcmReview), sparseGuidance);

// ─── Depth-calibrated repair-mode selection (m03TcmRepairMode) ───
// Sparse overreach takes quarantine. Active cases retain the same hard deletion list but must use
// their additional positive facts to avoid a symptom-only rewrite that the reviewer will reject.
const overreachReview = {
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "病机链引入肝气郁结超出阳性事实，舌脉不支持气滞，不推荐命名方。",
};
assert.equal(m03TcmRepairMode(overreachReview, true), "fact_anchored");
assert.match(boundedM03DiagnosticRepairGuidance(overreachReview, { hasCurrentPositiveFacts: true }), /主诉之外仍有当前阳性事实/);
assert.equal(m03TcmRepairMode(overreachReview, false), "quarantine");
assert.equal(m03TcmRepairMode(tcmReview, true), "fact_anchored");
assert.equal(m03TcmRepairMode(tcmReview, false), "quarantine");
assert.equal(m03TcmRepairMode({ status: "repair", issueCode: "tcm_reasoning_unsupported", repairInstruction: "请删除没有依据的内容。" }, true), "fact_anchored");
assert.equal(m03TcmRepairMode({ status: "repair", issueCode: "tcm_reasoning_unsupported" }, false), "quarantine");
assert.equal(m03TcmRepairMode({ status: "repair", issueCode: "supporting_fact_mismatch", repairInstruction: "x" }, true), "quarantine");
// The reviewer prompt must calibrate depth to what the facts support (情形二 depth rule).
assert.match(reviewPrompt, /要求的深度以事实实际支持的层级为限/);
assert.match(reviewPrompt, /现有事实不足以支持具体病性时允许保持 unresolved/);
assert.match(reviewPrompt, /超出当前阳性患者事实支持的寒热虚实、气血津液、痰湿瘀/);
// Contradictory records of the same observation are unreliable in BOTH directions: they support
// no attribution and are not fabrication grounds; depth is judged from the consistent remainder.
assert.match(reviewPrompt, /直接矛盾的多条记录/);
assert.match(reviewPrompt, /按不可靠证据处理/);
assert.match(reviewPrompt, /不能据此认定候选‘编造事实’/);
assert.match(reviewPrompt, /辨证深度只由其余一致的阳性事实判定/);
assert.match(reviewPrompt, /绝不能由你或候选挑选某一条作为事实采信/);
// Verdict discipline: an acceptable candidate must be accepted, never repair-with-accept-prose.
assert.match(reviewPrompt, /绝不允许用 repair 表达‘应接受、请重新检查’/);
// supportingFacts complaints must use supporting_fact_mismatch, not tcm_reasoning_unsupported.
assert.match(reviewPrompt, /只能使用 supporting_fact_mismatch，不得并入 tcm_reasoning_unsupported/);
// Guidance-code hygiene: "病机链非空" must not produce a chain_not_closed code.
assert.deepEqual(
  m03DiagnosticRepairGuidanceCodes({
    status: "repair",
    issueCode: "tcm_reasoning_unsupported",
    repairInstruction: "病机链非空，故不触发硬性完整性拒绝；supportingFacts 中引用了矛盾舌脉，需删除。",
  }),
  [],
);
assert.deepEqual(
  m03DiagnosticRepairGuidanceCodes({
    status: "repair",
    issueCode: "tcm_reasoning_unsupported",
    repairInstruction: "病机链只是重复主诉，未形成闭环。",
  }),
  ["symptom_restatement", "chain_not_closed"],
);
const underDepthReview = {
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "病位病性未决，病机链未形成闭环。",
};
assert.equal(m03DiagnosticReviewNeedsAdjudication(underDepthReview), true);
assert.equal(m03DiagnosticReviewNeedsAdjudication({
  ...underDepthReview,
  repairInstruction: "病机链引入气血两虚，且未形成闭环。",
}), true, "an overreach verdict receives one independent adjudication instead of being accepted or repaired from one stochastic judgement");
assert.equal(m03DiagnosticReviewNeedsAdjudication({
  status: "repair",
  issueCode: "supporting_fact_mismatch",
  repairInstruction: "依据与原文不符。",
}), false);
const adjudicationPrompt = buildM03DiagnosticReviewAdjudicationPrompt(
  "最近吃点东西就想跑厕所，稀稀的有半个月",
  reviewed,
  "",
  underDepthReview,
);
assert.match(adjudicationPrompt, /不得再把上述必填字段误判为空/);
assert.match(adjudicationPrompt, /items=\[\] 且 resolution=unresolved/);
assert.match(adjudicationPrompt, /仍含无患者事实组合支持的具体病位、病性、证型/);
assert.match(adjudicationPrompt, /不得把 L0 的逐字要求错误施加到 L2-L3/);
assert.match(adjudicationPrompt, /不能仅做字符串比对/);

// ─── 情形一-only quarantine injection: deterministic sparse/active signal ───
assert.equal(m03GroundingHasCurrentPositiveFacts(""), false);
assert.equal(m03GroundingHasCurrentPositiveFacts("汗出较多3天。"), false);
assert.equal(m03GroundingHasCurrentPositiveFacts("汗出较多3天。\n汗出较多3天。"), false);
assert.equal(m03GroundingHasCurrentPositiveFacts("汗出较多3天。\n既往史：高血压10年，规律服药"), false);
assert.equal(m03GroundingHasCurrentPositiveFacts("汗出较多3天。\n舌象：未记录\n脉象：未记录"), false);
assert.equal(m03GroundingHasCurrentPositiveFacts("汗出较多3天。\n过敏史：无"), false);
for (const unknownFollowup of [
  "本轮追问补充：本次未取得该信息",
  "问诊补充：本次未能确认，请继续现场评估",
  "患者回答：说不清",
]) {
  assert.equal(
    m03GroundingHasCurrentPositiveFacts(`来月经第一天肚子疼得蜷着，热水袋捂着好点\n基层接诊初始记录：来月经第一天肚子疼得蜷着，热水袋捂着好点；这样有一年多。\n${unknownFollowup}`),
    false,
    `${unknownFollowup} is an unanswered M02 boundary, not a new positive TCM anchor`,
  );
}
assert.equal(
  m03GroundingHasCurrentPositiveFacts([
    "这两个月一吃完饭肚子上边就胀，老打嗝",
    "症状.presentHistory：没吐过血，别的说不清。",
    "患者/医生已确认补充：基层接诊初始记录：这两个月一吃完饭肚子上边就胀，老打嗝；没吐过血，别的说不清。",
    "患者/医生已确认补充：本轮追问补充：我不清楚，你按现在这些先分析吧",
  ].join("\n")),
  false,
  "negated GI bleeding plus an unknown answer and a workflow request must stay in sparse mode",
);
assert.equal(
  m03GroundingHasCurrentPositiveFacts("咳嗽3天。\n现病史：没咳过血，其他不知道"),
  false,
  "colloquial negated events must not become positive TCM anchors",
);
assert.equal(
  m03GroundingHasCurrentPositiveFacts("入睡困难2个月。\n现病史：第二天没精神"),
  true,
  "negative-form symptom idioms remain clinically positive findings",
);
assert.equal(
  m03GroundingHasCurrentPositiveFacts("上腹胀2个月。\n本轮追问补充：饭后半小时最明显"),
  true,
  "an answered timing characteristic remains an additional current positive fact",
);
assert.equal(m03GroundingHasCurrentPositiveFacts("上呼吸道感染，体温37.2℃无寒战\n现病史：感冒2天，流涕咽痛，体温最高37.2℃"), true);
assert.match(
  buildM03DiagnosticReviewPrompt("咳嗽3天。\n现病史：夜间咳嗽加重", reviewed, ""),
  /服务端事实极性分类：情形二/,
  "the reviewer receives the same deterministic sparse/active classification as repair orchestration",
);
assert.equal(m03GroundingHasCurrentPositiveFacts("咳嗽3天。\n舌象：舌淡红，苔薄白"), true);
assert.equal(m03GroundingHasCurrentPositiveFacts("咳嗽3天。\n生命体征：体温 37.2℃"), true);
assert.equal(
  m03GroundingHasCurrentPositiveFacts("躺床上脑子停不下来，得一两个小时才睡着。\n现病史：有两个多月，第二天没精神。"),
  true,
  "sleep difficulty plus documented next-day impairment is an active case, not a chief-only sparse case",
);

// ─── (b) M03 orchestration deadline: config, predicate, reason-code selection ───
const {
  M03_ORCHESTRATION_DEADLINE_MS,
  m03OrchestrationDeadlineExpired,
  m03ReviewerProjectionContradiction,
  m03SignedLimitedFallbackReasonCode,
  reasoningEffortForStructuredRepair,
} = await jiti.import("../src/lib/diagnosis-api.ts");
assert.equal(M03_ORCHESTRATION_DEADLINE_MS, 120_000);
const exactProjectionReasoning = structuredClone(reviewed);
exactProjectionReasoning.pathogenesis.summary = exactProjectionReasoning.pathogenesis.chain.map((node) => node.pathogenesis).join("；");
const falseSummaryReview = {
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "pathogenesis_summary_drift：总结与病机链不一致。",
};
assert.equal(m03PathogenesisSummaryIsExactProjection(exactProjectionReasoning), true);
assert.equal(m03ReviewerProjectionContradiction(falseSummaryReview, exactProjectionReasoning), true, "an exact server projection cannot consume a full diagnosis regeneration round");
assert.match(buildM03DiagnosticReviewPrompt("入睡困难3个月", exactProjectionReasoning, ""), /本轮禁止返回 pathogenesis_summary_drift/);
const realSummaryDrift = structuredClone(exactProjectionReasoning);
realSummaryDrift.pathogenesis.summary = "额外引入未支持的病性";
assert.equal(m03PathogenesisSummaryIsExactProjection(realSummaryDrift), false);
assert.equal(m03ReviewerProjectionContradiction(falseSummaryReview, realSummaryDrift), false, "real summary drift remains repairable and is never suppressed");
assert.equal(m03ReviewerProjectionContradiction({ ...falseSummaryReview, repairInstruction: "病机链引入气虚，需删除。" }, exactProjectionReasoning), false, "a core clinical overreach is never mistaken for a projection-only contradiction");
const deadlineStart = 1_000_000;
assert.equal(m03OrchestrationDeadlineExpired(deadlineStart, deadlineStart + M03_ORCHESTRATION_DEADLINE_MS - 1), false);
assert.equal(m03OrchestrationDeadlineExpired(deadlineStart, deadlineStart + M03_ORCHESTRATION_DEADLINE_MS), true);
// Default 120s + one in-flight repair (≤120s absolute clamp) must bound worst-case M03 under 300s.
assert.ok(M03_ORCHESTRATION_DEADLINE_MS + 120_000 < 300_000);
assert.equal(m03SignedLimitedFallbackReasonCode({ deadlineExceeded: true, quarantineLoopEarlyExit: false }), "signed_limited_fallback_deadline");
assert.equal(m03SignedLimitedFallbackReasonCode({ deadlineExceeded: true, quarantineLoopEarlyExit: true }), "signed_limited_fallback_deadline");
assert.equal(m03SignedLimitedFallbackReasonCode({ deadlineExceeded: false, quarantineLoopEarlyExit: true }), "signed_limited_fallback_quarantine_loop");
assert.equal(m03SignedLimitedFallbackReasonCode({ deadlineExceeded: false, quarantineLoopEarlyExit: false }), "signed_limited_fallback");
assert.equal(reasoningEffortForStructuredRepair("diagnose"), "low", "bounded M03 repair avoids a second full diagnostic reasoning budget");
assert.equal(reasoningEffortForStructuredRepair("prescribe"), "medium", "M04 multi-invariant reconstruction keeps medium repair effort");

// ─── (c) Finalization idempotence w.r.t. already-reviewed decisions ───
// The diagnose output transform (ungrounded-negation sanitizer + evidence scrubber) rewrites JSON
// string fields (e.g. 舌/脉 → 待核实 when unrecorded). It must be idempotent so that applying it
// BEFORE the independent review makes the post-review finalization a byte-level no-op: an accepted
// review is never followed by silent clinical mutation plus a second stochastic re-review.
const { sanitizeUngroundedRedFlagNegations } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { buildEvidenceOutputTransform } = await jiti.import("../src/lib/cdss-evidence-context.ts");
const driftCaseState = {
  patient: { age: "", sex: "" },
  conversation: [],
  chiefComplaint: "上呼吸道感染，体温37.2℃无寒战",
};
const driftReasoning = structuredClone(reviewed);
driftReasoning.pathogenesis.summary = "舌淡苔薄白，脉细；外感表证，肺卫失和";
driftReasoning.pathogenesis.locationDifferentiation = { items: [], resolution: "unresolved", resolutionReason: "当前资料不足以定位病位" };
driftReasoning.pathogenesis.natureDifferentiation = { items: [], resolution: "unresolved", resolutionReason: "当前资料不足以归纳病性" };
const driftContent = `## 辨病辨证\n\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(driftReasoning, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
const finalizationTransform = buildEvidenceOutputTransform("", (content) => sanitizeUngroundedRedFlagNegations(content, driftCaseState));
const finalizedOnce = finalizationTransform(driftContent);
const finalizedTwice = finalizationTransform(finalizedOnce);
const finalizedThrice = finalizationTransform(finalizedTwice);
assert.notEqual(finalizedOnce, driftContent);
// The placeholder restore can append one trailing newline on the first application; the transform
// reaches a byte-level fixed point from the second pass onward and is semantically idempotent from
// the first — which is what the post-review rebind hash compares.
assert.equal(finalizedThrice, finalizedTwice);
const parseSentinelReasoning = (content) => JSON.parse(
  content.slice(
    content.indexOf("<!-- DIAGNOSIS_JSON_START -->") + "<!-- DIAGNOSIS_JSON_START -->".length,
    content.indexOf("<!-- DIAGNOSIS_JSON_END -->"),
  ).trim(),
);
assert.equal(
  canRebindM03DiagnosticReview(parseSentinelReasoning(finalizedOnce), parseSentinelReasoning(finalizedTwice)),
  true,
);
assert.deepEqual(
  m03DiagnosticReviewDiffPaths(parseSentinelReasoning(finalizedOnce), parseSentinelReasoning(finalizedTwice)),
  [],
);

// ─── Problem 2 (i): history-heavy but currently positive profiles are ACTIVE, not sparse ───
// A stable historical condition recorded first must not flip the case into the sparse quarantine
// mode when later lines carry current positive findings.
assert.equal(
  m03GroundingHasCurrentPositiveFacts("头晕头胀2月。\n既往史：高血压8年，规律服药，血压稳定。\n现病史：近2月晨起头晕头胀，项背强。\n舌象：舌红苔薄黄\n脉象：脉弦"),
  true,
);
assert.equal(
  m03GroundingHasCurrentPositiveFacts("头晕头胀2月。\n既往史：高血压8年，规律服药，血压稳定。"),
  false,
);
assert.equal(
  m03GroundingHasCurrentPositiveFacts("头晕头胀2月。\n用药史：氨氯地平5mg qd。\n过敏史：无"),
  false,
);

// ─── Problem 2 (ii): identical-guidance early exit only after a REVIEWED rejection ───
// A repair round that died in the deterministic resolver never had its clinical strategy judged;
// the same guidance must still get one more full draw. Only a reviewer-rejected round with
// byte-identical recomputed guidance is a proven re-draw.
assert.doesNotMatch(activeGuidance, /分类数组全部置空/, "active guidance must not force unresolved classifications when facts support resolving them");
assert.match(activeGuidance, /只填写有直接原文依据的分类/);
const {
  M04_ORCHESTRATION_DEADLINE_MS,
  m04OrchestrationDeadlineExpired,
  m04TruncatedFallbackReasonCode,
  shouldSkipM03RepairForIdenticalGuidance,
} = await jiti.import("../src/lib/diagnosis-api.ts");
assert.equal(shouldSkipM03RepairForIdenticalGuidance({ reviewBasedRejection: true, guidanceToInject: "G", lastInjectedGuidance: "G" }), true);
assert.equal(shouldSkipM03RepairForIdenticalGuidance({ reviewBasedRejection: false, guidanceToInject: "G", lastInjectedGuidance: "G" }), false, "a resolver-rejected repair keeps its retry budget");
assert.equal(shouldSkipM03RepairForIdenticalGuidance({ reviewBasedRejection: true, guidanceToInject: "G2", lastInjectedGuidance: "G" }), false);
assert.equal(shouldSkipM03RepairForIdenticalGuidance({ reviewBasedRejection: true, guidanceToInject: "", lastInjectedGuidance: "" }), false);

// ─── (b) M04 orchestration deadline: config, predicate, reason-code selection ───
assert.equal(M04_ORCHESTRATION_DEADLINE_MS, 120_000);
const m04DeadlineStart = 2_000_000;
assert.equal(m04OrchestrationDeadlineExpired(m04DeadlineStart, m04DeadlineStart + M04_ORCHESTRATION_DEADLINE_MS - 1), false);
assert.equal(m04OrchestrationDeadlineExpired(m04DeadlineStart, m04DeadlineStart + M04_ORCHESTRATION_DEADLINE_MS), true);
assert.ok(M04_ORCHESTRATION_DEADLINE_MS + 120_000 < 300_000, "default + one in-flight repair must bound worst-case M04 under 300s");
assert.equal(m04TruncatedFallbackReasonCode({ deadlineExceeded: true, repairLoopEarlyExit: false }), "final_contract_rejected_deadline");
assert.equal(m04TruncatedFallbackReasonCode({ deadlineExceeded: true, repairLoopEarlyExit: true }), "final_contract_rejected_deadline");
assert.equal(m04TruncatedFallbackReasonCode({ deadlineExceeded: false, repairLoopEarlyExit: true }), "final_contract_rejected_repair_loop");
assert.equal(m04TruncatedFallbackReasonCode({ deadlineExceeded: false, repairLoopEarlyExit: false }), "final_contract_rejected");

// ─── (a) M04 finalization idempotence: evidence placeholder hiding must not mutate reviewed rows ───
// Reproduction of the live drift: hideCustomerEvidencePlaceholders strips （证据不足/待检索）-style
// placeholders INSIDE the sentinel JSON. Applied only at finalization (after the review snapshot)
// it rewrites modifications[].trigger/reason and forces a second stochastic re-review; applied
// before the review it is absorbed into the reviewed bytes and the rebind holds.
const m04DriftPrior = {
  overview: { primarySyndrome: "风热犯表证" },
  pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "风热犯表", therapyDirection: "疏风解表" }] },
  therapy: { overallPrinciple: "疏风解表" },
};
const m04DriftReasoning = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  formula: {
    candidates: [{
      name: "辨证组方",
      formulaNames: [],
      herbs: [{ name: "金银花", dose: "10g", role: "君" }],
      decoction: { doseCount: "3剂", course: "3日" },
    }],
    modifications: [
      { trigger: "复诊时仍畏寒", targetPathogenesis: "风热犯表", action: "加紫苏叶", reason: "兼散风寒", riskNote: "需重新审方" },
      { trigger: "复诊时咽痛加重（证据不足/待检索）", targetPathogenesis: "风热犯表", action: "加牛蒡子", reason: "利咽（待检索）", riskNote: "需重新审方" },
    ],
  },
};
const m04DriftContent = `## 候选方药\n\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(m04DriftReasoning, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
const m04FinalizationTransform = buildEvidenceOutputTransform("", undefined);
const m04FinalizedOnce = m04FinalizationTransform(m04DriftContent);
const m04FinalizedTwice = m04FinalizationTransform(m04FinalizedOnce);
assert.notEqual(m04FinalizedOnce, m04DriftContent, "the transform does rewrite modification rows on first application (the live drift)");
assert.equal(
  canRebindM04ClinicalReview(m04DriftPrior, parseSentinelReasoning(m04DriftContent), parseSentinelReasoning(m04FinalizedOnce)),
  false,
  "proof: post-review-only application breaks the reviewed-payload rebind",
);
assert.equal(m04FinalizedTwice, m04FinalizedOnce);
assert.equal(
  canRebindM04ClinicalReview(m04DriftPrior, parseSentinelReasoning(m04FinalizedOnce), parseSentinelReasoning(m04FinalizedTwice)),
  true,
  "applied before the review, finalization becomes a semantic no-op and the rebind holds",
);
assert.deepEqual(
  m04ClinicalReviewDiffPaths(m04DriftPrior, parseSentinelReasoning(m04FinalizedOnce), parseSentinelReasoning(m04FinalizedTwice)),
  [],
);

console.log(JSON.stringify({ cases: 105, failures: 0 }));
