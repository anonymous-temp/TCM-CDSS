import assert from "node:assert/strict";
import { createJiti } from "jiti";

import {
  boundedM03DiagnosticRepairGuidance,
  buildM03DiagnosticReviewPayload,
  buildM03DiagnosticReviewPrompt,
  canRebindM03DiagnosticReview,
  m03DiagnosticReviewDiffPaths,
  m03DiagnosticRepairGuidanceCodes,
  m03DiagnosticReviewSemanticHash,
  m03GroundingHasCurrentPositiveFacts,
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
    primarySyndrome: "心脾两虚证",
    primarySyndromeBasis: ["心悸健忘", "纳差便溏"],
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
      limitations: ["未完成睡眠量表"],
      suggestedChecks: [],
      evidence,
    },
    differentials: [],
  },
  pathogenesis: {
    summary: "心脾两虚，心神失养",
    locationDifferentiation: { items: ["心", "脾"], evidence },
    natureDifferentiation: { items: ["气血两虚"], evidence },
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
  therapy: { overallPrinciple: "健脾益气，养血安神", subTherapies: [] },
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
const factsRejectIdx = reviewPrompt.indexOf("除主诉外还存在其他当前阳性发现");
const mechanicalRewriteIdx = reviewPrompt.indexOf("主证候不得只是主诉");
assert.ok(sparseAcceptIdx !== -1, "prompt must document the sparse-case acceptance branch");
assert.ok(reviewPrompt.includes("症状层中医病名+功能失调候"), "prompt must name the bounded neutral primary-syndrome shape");
assert.ok(factsRejectIdx !== -1, "prompt must document the facts-present rejection branch");
assert.ok(mechanicalRewriteIdx > factsRejectIdx, "the mechanical-restatement rejection must be conditioned on existing positive findings");
assert.match(reviewPrompt, /一律返回 tcm_reasoning_unsupported/);

// ─── matchesM03QuarantineShape: code-level mirror of the quarantine shape ───
const quarantineCandidate = structuredClone(reviewed);
quarantineCandidate.overview.primarySyndrome = "不寐功能失调候";
quarantineCandidate.overview.primarySyndromeResolution = "bounded";
quarantineCandidate.overview.overallPathogenesis = "睡眠功能受扰";
quarantineCandidate.overview.overallTherapy = "调护睡眠功能";
quarantineCandidate.overview.recommendedFormulaDirection = "调护睡眠功能的辨证组方方向";
quarantineCandidate.overview.recommendedFormulaNames = [];
quarantineCandidate.overview.formulaSelectionMode = "self_devised";
quarantineCandidate.pathogenesis.locationDifferentiation = { items: [], resolution: "unresolved", resolutionReason: "无阳性事实支持具体脏腑归属" };
quarantineCandidate.pathogenesis.natureDifferentiation = { items: [], resolution: "unresolved", resolutionReason: "寒热虚实证据不足" };
quarantineCandidate.pathogenesis.chain = [{
  nodeId: "P1",
  patientFact: "入睡困难、多梦易醒3个月",
  syndromeEvidence: "入睡困难、多梦易醒3个月",
  pathogenesis: "睡眠功能受扰",
  therapyDirection: "调护睡眠功能",
  evidence,
}];
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
const { callDiagnosisStream } = await jiti.import("../src/lib/diagnosis-api.ts");
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
assert.match(activeGuidance, /禁止退回到症状层‘病名\+功能失调候’的中性隔离形态/);
assert.match(activeGuidance, /primarySyndromeBasis 逐字引用患者原文/);
assert.match(activeGuidance, /阴虚、阳虚、气虚、血虚/);
assert.match(activeGuidance, /不得补造未出现的事实/);
assert.match(activeGuidance, /self_devised/);
const sparseGuidance = boundedM03DiagnosticRepairGuidance(tcmReview, { hasCurrentPositiveFacts: false });
assert.match(sparseGuidance, /语义隔离模式/);
assert.match(sparseGuidance, /功能失调候/);
assert.equal(boundedM03DiagnosticRepairGuidance(tcmReview), sparseGuidance);

// ─── Depth-calibrated repair-mode selection (m03TcmRepairMode) ───
// Overreach rejections take the quarantine policy even on active cases: unsupported attribution
// must be deleted, not re-attempted. Under-depth rejections take fact-anchored only with facts.
const overreachReview = {
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "病机链引入肝气郁结超出阳性事实，舌脉不支持气滞，不推荐命名方。",
};
assert.equal(m03TcmRepairMode(overreachReview, true), "quarantine");
assert.match(boundedM03DiagnosticRepairGuidance(overreachReview, { hasCurrentPositiveFacts: true }), /语义隔离模式/);
assert.equal(m03TcmRepairMode(tcmReview, true), "fact_anchored");
assert.equal(m03TcmRepairMode(tcmReview, false), "quarantine");
assert.equal(m03TcmRepairMode({ status: "repair", issueCode: "tcm_reasoning_unsupported", repairInstruction: "请删除没有依据的内容。" }, true), "fact_anchored");
assert.equal(m03TcmRepairMode({ status: "repair", issueCode: "tcm_reasoning_unsupported" }, false), "quarantine");
assert.equal(m03TcmRepairMode({ status: "repair", issueCode: "supporting_fact_mismatch", repairInstruction: "x" }, true), "quarantine");
// The reviewer prompt must calibrate depth to what the facts support (情形二 depth rule).
assert.match(reviewPrompt, /要求的深度以事实实际支持的层级为限/);
assert.match(reviewPrompt, /不足以支持任何具体病位病性归属/);
assert.match(reviewPrompt, /绝不能要求超出事实支持的脏腑、寒热虚实或气血津液归属/);
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

// ─── 情形一-only quarantine injection: deterministic sparse/active signal ───
assert.equal(m03GroundingHasCurrentPositiveFacts(""), false);
assert.equal(m03GroundingHasCurrentPositiveFacts("汗出较多3天。"), false);
assert.equal(m03GroundingHasCurrentPositiveFacts("汗出较多3天。\n汗出较多3天。"), false);
assert.equal(m03GroundingHasCurrentPositiveFacts("汗出较多3天。\n既往史：高血压10年，规律服药"), false);
assert.equal(m03GroundingHasCurrentPositiveFacts("汗出较多3天。\n舌象：未记录\n脉象：未记录"), false);
assert.equal(m03GroundingHasCurrentPositiveFacts("汗出较多3天。\n过敏史：无"), false);
assert.equal(m03GroundingHasCurrentPositiveFacts("上呼吸道感染，体温37.2℃无寒战\n现病史：感冒2天，流涕咽痛，体温最高37.2℃"), true);
assert.equal(m03GroundingHasCurrentPositiveFacts("咳嗽3天。\n舌象：舌淡红，苔薄白"), true);
assert.equal(m03GroundingHasCurrentPositiveFacts("咳嗽3天。\n生命体征：体温 37.2℃"), true);

// ─── (b) M03 orchestration deadline: config, predicate, reason-code selection ───
const {
  M03_ORCHESTRATION_DEADLINE_MS,
  m03OrchestrationDeadlineExpired,
  m03SignedLimitedFallbackReasonCode,
} = await jiti.import("../src/lib/diagnosis-api.ts");
assert.equal(M03_ORCHESTRATION_DEADLINE_MS, 120_000);
const deadlineStart = 1_000_000;
assert.equal(m03OrchestrationDeadlineExpired(deadlineStart, deadlineStart + M03_ORCHESTRATION_DEADLINE_MS - 1), false);
assert.equal(m03OrchestrationDeadlineExpired(deadlineStart, deadlineStart + M03_ORCHESTRATION_DEADLINE_MS), true);
// Default 120s + one in-flight repair (≤120s absolute clamp) must bound worst-case M03 under 300s.
assert.ok(M03_ORCHESTRATION_DEADLINE_MS + 120_000 < 300_000);
assert.equal(m03SignedLimitedFallbackReasonCode({ deadlineExceeded: true, quarantineLoopEarlyExit: false }), "signed_limited_fallback_deadline");
assert.equal(m03SignedLimitedFallbackReasonCode({ deadlineExceeded: true, quarantineLoopEarlyExit: true }), "signed_limited_fallback_deadline");
assert.equal(m03SignedLimitedFallbackReasonCode({ deadlineExceeded: false, quarantineLoopEarlyExit: true }), "signed_limited_fallback_quarantine_loop");
assert.equal(m03SignedLimitedFallbackReasonCode({ deadlineExceeded: false, quarantineLoopEarlyExit: false }), "signed_limited_fallback");

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
