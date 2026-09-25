/**
 * M03 结构化编排的确定性回归（2026-09-25 自 test:m03-clinical-review 拆出）。
 *
 * 原套件同时钉着模型复核器（m03-diagnostic-review.ts / m04-clinical-review.ts）的提示词、解析、
 * 修复引导、隔离形态与重绑定逻辑——复核环节已于 2026-09-16 删除、模块于 2026-09-25 删除，那部分
 * 断言随之删除。这里保留的全部是**仍在生产路径上**的行为：
 *  - 并行两半的中医半单独修复路由与保留半合同（shouldRepairM03TcmHalfOnly / m03PreservedParallelHalfIssue）；
 *  - 修复轮模型/推理力度选择、预算感知的传输重试门、编排总时限谓词与兜底原因码；
 *  - 定稿变换（负向红旗清洗 + 证据治理、受治理病名鉴别补全）的幂等性——签名前定稿是不动点；
 *  - 整条 M03 编排：单发与并行两半、西医半错位 JSON 修复、DeepSeek 首轮的严格 schema 兜底，
 *    且全程零复核请求、签名照常。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import { m03PreservedParallelHalfIssue } from "../src/lib/diagnosis-stage-contract.ts";

const evidence = { evidenceLevel: "model_inference", source: "本例四诊资料", confidence: "中" };
const m03Candidate = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "不寐",
    primarySyndrome: "心脾两虚证",
    primarySyndromeBasis: ["心悸健忘", "纳差便溏"],
    // 需求3：辨病与辨证各自成段。
    tcmDiseaseRationale: "以入睡困难、多梦易醒为主症，病程3个月，符合不寐范畴，与郁病、心悸相区分。",
    tcmDiagnosticRationale: "心悸健忘与纳差便溏并见，结合舌淡脉细弱，支持心脾两虚、心神失养。",
    tcmDifferentials: [],
    // 病名级鉴别（2026-08-04 起为 T2 不变式）：签名病名在 GB/T 15657 层级编码中存在相邻病名时
    // 必须给出，且填的必须是病名而不是证型。与上面的 tcmDifferentials（证型鉴别）是两层。
    tcmDiseaseDifferentials: [
      { diseaseName: "多寐病", reason: "同属睡眠病症但方向相反，需先分辨主症", distinguishingPoints: "本例为入睡困难与多梦易醒，非日间嗜睡", nextCheck: null },
    ],
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

const m03ClinicalContext = "心悸健忘、纳差便溏；舌淡，脉细弱；入睡困难、多梦易醒3个月";

/**
 * 最终 M03 临床决策的指纹：overview / westernDiagnosis / pathogenesis / therapy 四块，去掉 evidence
 * 出处字段、键排序后取 sha256。与已删除的 m03-diagnostic-review.ts 里 m03DiagnosticReviewSemanticHash
 * 的投影逐字相同，因此下方钉住的历史哈希值不变。
 */
function m03ClinicalDecisionHash(reasoning) {
  const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
  const withoutEvidence = (value) => Array.isArray(value) ? value.map(withoutEvidence)
    : isRecord(value) ? Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => key !== "evidence" && item !== undefined)
      .map(([key, item]) => [key, withoutEvidence(item)]))
    : value;
  const canonicalize = (value) => Array.isArray(value) ? value.map(canonicalize)
    : isRecord(value) ? Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalize(item)]))
    : value;
  const projection = withoutEvidence({
    overview: reasoning?.overview,
    westernDiagnosis: reasoning?.westernDiagnosis,
    pathogenesis: reasoning?.pathogenesis,
    therapy: reasoning?.therapy,
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(projection))).digest("hex")}`;
}

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
const { callDiagnosisStream, modelForStructuredRepair, shouldRepairM03TcmHalfOnly, shouldRetryStructuredRepairTransport } = await jiti.import("../src/lib/diagnosis-api.ts");
assert.equal(m03PreservedParallelHalfIssue(m03Candidate, m03ClinicalContext), undefined,
  "the owner-scoped validator accepts a complete Western/management half independently of the TCM chain");
assert.equal(shouldRepairM03TcmHalfOnly("diagnose", "m03_chain_empty", true, true), true,
  "a chain-only hard-contract gap regenerates only the TCM half when parallel ownership is available");
assert.equal(shouldRepairM03TcmHalfOnly("diagnose", "m03_chain_empty", false, true), false,
  "single-shot deployments retain the existing full M03 repair fallback");
assert.equal(shouldRepairM03TcmHalfOnly("prescribe", "m03_chain_empty", true, true), false,
  "M04 never takes the M03 TCM-half route");
assert.equal(shouldRepairM03TcmHalfOnly("diagnose", "m03_western_support_empty", true, true), false,
  "a Western-half contract gap must never be routed to the TCM-only repair");
const chainAndWesternGap = structuredClone(m03Candidate);
chainAndWesternGap.pathogenesis.chain = [];
chainAndWesternGap.westernDiagnosis.primary.supportingFacts = [];
assert.equal(m03PreservedParallelHalfIssue(chainAndWesternGap, m03ClinicalContext), "western_support_empty",
  "the preserved-half validator exposes a Western gap hidden behind the full contract's earlier chain_empty result");
assert.equal(shouldRepairM03TcmHalfOnly("diagnose", "m03_chain_empty", true, false), false,
  "chain_empty plus any preserved-half gap must use the existing full M03 repair");
const repairModelEnv = {
  diagnose: process.env.PRIMARY_DIAGNOSE_MODEL,
  prescribe: process.env.PRIMARY_PRESCRIBE_MODEL,
  diagnoseRepair: process.env.PRIMARY_DIAGNOSE_REPAIR_MODEL,
};
try {
  process.env.PRIMARY_DIAGNOSE_MODEL = "deepseek-v4-pro";
  process.env.PRIMARY_PRESCRIBE_MODEL = "deepseek-v4-pro";
  delete process.env.PRIMARY_DIAGNOSE_REPAIR_MODEL;
  assert.equal(modelForStructuredRepair("deepseek-v4-pro", "diagnose"), "deepseek-v4-pro", "M03 fact-regeneration repair defaults to the diagnostic reasoning model");
  process.env.PRIMARY_DIAGNOSE_REPAIR_MODEL = "deepseek-v4-pro";
  assert.equal(modelForStructuredRepair("deepseek-v4-pro", "diagnose"), "deepseek-v4-pro", "an explicit M03 repair model override remains authoritative");
  delete process.env.PRIMARY_DIAGNOSE_REPAIR_MODEL;
} finally {
  for (const [key, value] of [
    ["PRIMARY_DIAGNOSE_MODEL", repairModelEnv.diagnose],
    ["PRIMARY_PRESCRIBE_MODEL", repairModelEnv.prescribe],
    ["PRIMARY_DIAGNOSE_REPAIR_MODEL", repairModelEnv.diagnoseRepair],
  ]) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}
assert.equal(shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_network_error" }, 40_000, undefined, 10_000), true);
assert.equal(shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_http_error", status: 503 }, 40_000, undefined, 10_000), true);
assert.equal(shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_http_error", status: 401 }, 40_000, undefined, 10_000), false);
assert.equal(shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_network_error" }, 19_999, undefined, 10_000), false, "less than ten seconds cannot start a second repair draw");

// ── 预算感知重试（2026-08-27，生产 174s 长尾的根因）────────────────────────────
// 实测时间线（TCM-BEST4SDT tcmbest_157，M03 总耗时 173,951ms）：
//   27s 首轮生成 → 候选被驳回 chain_key_discriminator_missing
//   → 修复轮跑满 90s 超时（STRUCTURED_RETRY_TOTAL_TIMEOUT_MS）
//   → 判为「瞬时故障」再试一次，此时只剩 63s 却要跑一轮需要 90s 的轮次
//   → 必然撞 180s 编排时限 → 整轮作废降级成空结果。
// 根因是重试门只问「剩余是否 ≥10s」，从不问「够不够跑完一轮」。
// 修法：估计值取**刚才那一轮的实际耗时**（同提示词同模型，重试耗时大致相同），
// 并留出 finalize/复核/签名储备；估不出来时用保守下限。
// 超时（retry_timeout_or_cancelled）尤其要按此判——重试同一份提示词大概率再次超时。
assert.equal(
  shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_timeout_or_cancelled" }, 63_000, undefined, 0, 90_000),
  false,
  "a 90s round that just timed out must not be retried with only 63s left",
);
assert.equal(
  shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_timeout_or_cancelled" }, 130_000, undefined, 0, 90_000),
  true,
  "the same retry is allowed when the remaining budget covers another full round plus finalize reserve",
);
// 快速失败（JSON 不合法，2s 就回来了）不该被 90s 的悲观估计挡住：估计值用观测值，
// 但设下限，防止「2s 失败 → 估 2s → 剩 20s 也敢开轮」这种反向误判。
assert.equal(
  shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_invalid_json" }, 60_000, undefined, 0, 2_000),
  true,
  "a fast failure retries while the budget is ample",
);
assert.equal(
  shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_invalid_json" }, 25_000, undefined, 0, 2_000),
  false,
  "a fast failure still needs room for a full round plus finalize reserve",
);
assert.equal(
  shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_invalid_json" }, 55_000, undefined, 0, 2_000),
  true,
  "with a full round plus reserve available the fast failure retries",
);
// 反证：非瞬时故障（401）无论预算多充足都不重试；已中断同理。
assert.equal(
  shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_http_error", status: 401 }, 300_000, undefined, 0, 1_000),
  false,
  "a non-transient failure is never retried regardless of budget",
);
// 兼容：不传观测耗时时维持原判据（≥10s），不因新增参数收紧既有行为——
// 生产路径只有 retryCompletePrimaryResponseWithTransientRecovery 一个调用点，
// 而它总是带上刚跑完那一轮的实际耗时。
assert.equal(
  shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_network_error" }, 30_000, undefined, 0),
  true,
  "legacy call sites without an observation keep the original ten-second rule",
);
// 快失败也不能把估计拉到 2s：上游恢复后要跑的是一轮完整生成（下限 30s + 储备 20s）。
assert.equal(
  shouldRetryStructuredRepairTransport({ ok: false, reason: "retry_invalid_json" }, 45_000, undefined, 0, 2_000),
  false,
  "a fast failure is still estimated at a full round, not at its own two seconds",
);
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

// ─── (b) M03 orchestration deadline: config, predicate, reason-code selection ───
const {
  M03_ORCHESTRATION_DEADLINE_MS,
  m03OrchestrationDeadlineExpired,
  m03SignedLimitedFallbackReasonCode,
  reasoningEffortForStructuredRepair,
} = await jiti.import("../src/lib/diagnosis-api.ts");
assert.equal(M03_ORCHESTRATION_DEADLINE_MS, 180_000);
const deadlineStart = 1_000_000;
assert.equal(m03OrchestrationDeadlineExpired(deadlineStart, deadlineStart + M03_ORCHESTRATION_DEADLINE_MS - 1), false);
assert.equal(m03OrchestrationDeadlineExpired(deadlineStart, deadlineStart + M03_ORCHESTRATION_DEADLINE_MS), true);
// Default 180s + one in-flight repair (≤120s absolute clamp) must bound worst-case M03 to 300s.
assert.ok(M03_ORCHESTRATION_DEADLINE_MS + 120_000 <= 300_000);
assert.equal(m03SignedLimitedFallbackReasonCode({ deadlineExceeded: true }), "signed_limited_fallback_deadline");
assert.equal(m03SignedLimitedFallbackReasonCode({ deadlineExceeded: false }), "signed_limited_fallback");
assert.equal(reasoningEffortForStructuredRepair("diagnose"), "low", "bounded M03 repair avoids a second full diagnostic reasoning budget");
assert.equal(reasoningEffortForStructuredRepair("prescribe"), "medium", "M04 multi-invariant reconstruction keeps medium repair effort");
const originalPrescribeRepairEffort = process.env.PRIMARY_PRESCRIBE_REPAIR_REASONING_EFFORT;
process.env.PRIMARY_PRESCRIBE_REPAIR_REASONING_EFFORT = "high";
assert.equal(reasoningEffortForStructuredRepair("prescribe"), "high", "M04 repair effort must be deploy-time configurable");
process.env.PRIMARY_PRESCRIBE_REPAIR_REASONING_EFFORT = "unsupported";
assert.equal(reasoningEffortForStructuredRepair("prescribe"), "medium", "invalid M04 repair effort must fail to the documented safe default");
if (originalPrescribeRepairEffort == null) delete process.env.PRIMARY_PRESCRIBE_REPAIR_REASONING_EFFORT;
else process.env.PRIMARY_PRESCRIBE_REPAIR_REASONING_EFFORT = originalPrescribeRepairEffort;

// ─── (c) Finalization idempotence ───
// The diagnose output transform (ungrounded-negation sanitizer + evidence scrubber) rewrites JSON
// string fields (e.g. 舌/脉 → 待核实 when unrecorded). It must be idempotent so that applying it
// before attestation makes the emission-time finalization a no-op: the signed payload is never
// silently mutated after its attestation hash was bound.
const { sanitizeUngroundedRedFlagNegations } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { buildEvidenceOutputTransform } = await jiti.import("../src/lib/cdss-evidence-context.ts");
const driftCaseState = {
  patient: { age: "", sex: "" },
  conversation: [],
  chiefComplaint: "上呼吸道感染，体温37.2℃无寒战",
};
const driftReasoning = structuredClone(m03Candidate);
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
// the first — which is what the emission-time attestation rebind compares.
assert.equal(finalizedThrice, finalizedTwice);
const parseSentinelReasoning = (content) => JSON.parse(
  content.slice(
    content.indexOf("<!-- DIAGNOSIS_JSON_START -->") + "<!-- DIAGNOSIS_JSON_START -->".length,
    content.indexOf("<!-- DIAGNOSIS_JSON_END -->"),
  ).trim(),
);
const { applyGovernedM03DiseaseDifferentialBoundary } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const governedDifferentialState = {
  completeness: { level: "C" },
  safetyGate: { status: "ready" },
};
const emptyDiseaseDifferentialReasoning = structuredClone(m03Candidate);
emptyDiseaseDifferentialReasoning.overview.tcmDiseaseDifferentials = [];
const emptyDiseaseDifferentialContent = `## 辨病辨证\n\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(emptyDiseaseDifferentialReasoning, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
const completedDiseaseDifferentialContent = applyGovernedM03DiseaseDifferentialBoundary(
  emptyDiseaseDifferentialContent,
  governedDifferentialState,
);
const completedDiseaseDifferentialReasoning = parseSentinelReasoning(completedDiseaseDifferentialContent);
assert.ok(completedDiseaseDifferentialReasoning.overview.tcmDiseaseDifferentials.length > 0);
const idempotentDiseaseDifferentialContent = applyGovernedM03DiseaseDifferentialBoundary(
  completedDiseaseDifferentialContent,
  governedDifferentialState,
);
const idempotentDiseaseDifferentialReasoning = parseSentinelReasoning(idempotentDiseaseDifferentialContent);
assert.equal(idempotentDiseaseDifferentialContent, completedDiseaseDifferentialContent);
assert.deepEqual(idempotentDiseaseDifferentialReasoning, completedDiseaseDifferentialReasoning,
  "the governed disease-differential completion must be an emission-time semantic fixed point");
assert.deepEqual(parseSentinelReasoning(finalizedTwice), parseSentinelReasoning(finalizedOnce),
  "the finalization transform is semantically idempotent from its first application");

const {
  M04_ORCHESTRATION_DEADLINE_MS,
  m04OrchestrationDeadlineExpired,
  m04TruncatedFallbackReasonCode,
} = await jiti.import("../src/lib/diagnosis-api.ts");

// ─── (b) M04 orchestration deadline: config, predicate, reason-code selection ───
assert.equal(M04_ORCHESTRATION_DEADLINE_MS, 180_000);
const m04DeadlineStart = 2_000_000;
assert.equal(m04OrchestrationDeadlineExpired(m04DeadlineStart, m04DeadlineStart + M04_ORCHESTRATION_DEADLINE_MS - 1), false);
assert.equal(m04OrchestrationDeadlineExpired(m04DeadlineStart, m04DeadlineStart + M04_ORCHESTRATION_DEADLINE_MS), true);
assert.ok(M04_ORCHESTRATION_DEADLINE_MS <= 180_000, "the absolute M04 timer must bound the complete orchestration at 180s");
assert.equal(m04TruncatedFallbackReasonCode({ deadlineExceeded: true, repairLoopEarlyExit: false }), "final_contract_rejected_deadline");
assert.equal(m04TruncatedFallbackReasonCode({ deadlineExceeded: true, repairLoopEarlyExit: true }), "final_contract_rejected_deadline");
assert.equal(m04TruncatedFallbackReasonCode({ deadlineExceeded: false, repairLoopEarlyExit: true }), "final_contract_rejected_repair_loop");
assert.equal(m04TruncatedFallbackReasonCode({ deadlineExceeded: false, repairLoopEarlyExit: false }), "final_contract_rejected");

// ─── (a) M04 finalization idempotence: evidence placeholder hiding reaches a fixed point ───
// hideCustomerEvidencePlaceholders strips （证据不足/待检索）-style placeholders INSIDE the sentinel
// JSON. It rewrites modifications[].trigger/reason on first application; it must be a byte-level
// fixed point from then on, so the attestation bound before emission only needs a hash rebind.
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
assert.equal(m04FinalizedTwice, m04FinalizedOnce, "the M04 finalization transform is a byte-level fixed point after one application");

// A route sanitizer can clear an explanatory field after preparation. Its deterministic final
// projection must already be settled before signing, with exactly one generation draw.
// 2026-09-16 起没有模型复核环节：这里同时钉住 M03 编排零复核/裁决请求、attestation 固定
// unavailable/not_configured、签名照常、复核状态行改为「本版本不设模型复核环节」。
const settledEnv = {
  AI_TEXT_PROVIDER: "openai-compatible",
  OPENAI_API_KEY: "test-only-m03-settled",
  OPENAI_BASE_URL: "https://api.deepseek.com",
  OPENAI_MODEL: "deepseek-v4-flash",
  PRIMARY_DIAGNOSE_MODEL: "deepseek-v4-flash",
  CONTROLLED_TERMINOLOGY_NORMALIZATION: "false",
  REASONING_CONTRACT_SIGNING_KEY: "synthetic-m03-settled-key-0000000000000000",
};
const savedSettledEnv = Object.fromEntries(Object.keys(settledEnv).map((key) => [key, process.env[key]]));
const savedSettledFetch = globalThis.fetch;
const savedSettledInfo = console.info;
const settledLogs = [];
let settledGenerationCalls = 0;
let settledNonStreamCalls = 0;
let settledSigned;
try {
  Object.assign(process.env, settledEnv);
  console.info = (...args) => { settledLogs.push(args); };
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.stream) {
      settledGenerationCalls += 1;
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(m03Candidate) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    settledNonStreamCalls += 1;
    return Response.json({ choices: [{ message: { content: '{"status":"accepted","issueCode":"none"}' }, finish_reason: "stop" }] });
  };
  const response = await callDiagnosisStream("synthetic settled M03", "deepseek", undefined, "markdown", {
    structuredStage: "diagnose",
    structuredClinicalContext: m03ClinicalContext,
    structuredAllowedM03FormulaNames: ["归脾汤"],
    truncateFallback: "SYNTHETIC_FALLBACK",
    diagnoseSignatureContext: {
      contractVersion: "tcm-cdss-m03-signature-v5",
      caseId: "synthetic-settled",
      encounterId: "synthetic-settled-encounter",
      clinicalInputHash: `sha256:${"a".repeat(64)}`,
    },
    outputTransform: (content) => content.replace(
      /<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/g,
      (_match, json) => {
        const value = JSON.parse(json);
        value.overview.tcmDiagnosticRationale = "";
        return `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(value)}\n<!-- DIAGNOSIS_JSON_END -->`;
      },
    ),
  });
  const text = await response.text();
  const frames = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(frames.filter((frame) => frame.error), [], "the mock stream must finish without an error");
  assert.equal(frames.at(-1).content, "[END]");
  const output = frames.filter((frame) => typeof frame.content === "string").map((frame) => frame.content).join("");
  assert.equal(settledGenerationCalls, 1, "exactly one generation draw");
  assert.equal(settledNonStreamCalls, 0, "模型复核环节已删除：M03 编排不得再发任何非流式（复核/裁决）请求");
  const signed = parseSentinelReasoning(output);
  settledSigned = signed;
  assert.equal(m03ClinicalDecisionHash(signed), "sha256:e65b691a013a531b473c38bf7fef9bf45fc40c77b0913b4b26cf786cdf70fce4", "the settled projection must preserve the pre-fix final clinical payload");
  assert.ok(signed.contractSignature, "the settled output must still be signed");
  assert.equal(signed.clinicalReview.status, "unavailable");
  assert.equal(signed.clinicalReview.unavailableReason, "not_configured");
  assert.equal(settledLogs.filter(([name]) => name === "[tcm-cdss:timing] clinical_review").length, 0, "no clinical_review telemetry without a reviewer");
  assert.match(output, /本版本不设模型复核环节/);
} finally {
  globalThis.fetch = savedSettledFetch;
  console.info = savedSettledInfo;
  for (const [key, value] of Object.entries(savedSettledEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

// ─── M03 并行西医半：线上 DeepSeek 交回括号错位的「像 JSON」（2026-09-19）──────────────
//
// 甲方 9/17–9/18 实测：西医诊断一栏恒为「当前未形成可复核的西医工作诊断」。根因不在临床
// 判断：西医半（非流式、json_object）实测 9/9 次采样都是顶层被提前闭合后又接着写
// `,"management":…}` 的非法 JSON，合并层解析失败后整段静默丢弃，签名载荷落默认占位。
// 这里钉整条编排：同一份临床内容，经并行路径交回错位文本，签名结果里的西医诊断必须与
// 单发路径（上面的 settled 用例）完全一致；救不回来时重试一次西医半，仍失败才落占位。
const tcmHalfOnly = Object.fromEntries(Object.entries(m03Candidate)
  .filter(([key]) => !["westernDiagnosis", "management"].includes(key)));
const misnestedWesternHalf = `{"westernDiagnosis":${JSON.stringify({
  ...m03Candidate.westernDiagnosis,
  primary: Object.fromEntries(Object.entries(m03Candidate.westernDiagnosis.primary).filter(([key]) => key !== "suggestedChecks")),
})},"suggestedChecks":["睡眠日记（连续1-2周）"]},"management":${JSON.stringify(m03Candidate.management)}}`;
assert.throws(() => JSON.parse(misnestedWesternHalf), SyntaxError, "fixture 必须是线上那种顶层提前闭合的非法 JSON");
const cleanWesternHalf = JSON.stringify({ westernDiagnosis: m03Candidate.westernDiagnosis, management: m03Candidate.management });
const truncatedWesternHalf = `{"westernDiagnosis":{"primary":{"name":"失眠症状","status":"考虑","supportingFacts":["入睡困难`;
const runParallelM03 = async (westernReplies) => {
  const savedEnv = Object.fromEntries(Object.keys(settledEnv).map((key) => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  const savedInfo = console.info;
  const savedWarn = console.warn;
  const logs = [];
  const replies = [...westernReplies];
  let streamCalls = 0;
  let westernCalls = 0;
  try {
    Object.assign(process.env, settledEnv);
    console.info = (...args) => { logs.push(args); };
    console.warn = (...args) => { logs.push(args); };
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.stream) {
        streamCalls += 1;
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(tcmHalfOnly) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      westernCalls += 1;
      return Response.json({ choices: [{ message: { content: replies.shift() ?? "" }, finish_reason: "stop" }] });
    };
    const response = await callDiagnosisStream("synthetic parallel M03", "deepseek", undefined, "markdown", {
      structuredStage: "diagnose",
      structuredClinicalContext: m03ClinicalContext,
      structuredAllowedM03FormulaNames: ["归脾汤"],
      truncateFallback: "SYNTHETIC_FALLBACK",
      m03ParallelHalfPrompts: { western: "synthetic western half", tcm: "synthetic tcm half" },
      diagnoseSignatureContext: {
        contractVersion: "tcm-cdss-m03-signature-v5",
        caseId: "synthetic-parallel",
        encounterId: "synthetic-parallel-encounter",
        clinicalInputHash: `sha256:${"b".repeat(64)}`,
      },
    });
    const frames = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(frames.filter((frame) => frame.error), [], "the mock stream must finish without an error");
    const output = frames.filter((frame) => typeof frame.content === "string").map((frame) => frame.content).join("");
    const halves = logs.find(([name]) => name === "[tcm-cdss:timing] m03_parallel_halves")?.[1];
    return { signed: parseSentinelReasoning(output), halves, streamCalls, westernCalls };
  } finally {
    globalThis.fetch = savedFetch;
    console.info = savedInfo;
    console.warn = savedWarn;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
};
const { westernDiagnosisLabelForDisplay } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
assert.ok(settledSigned?.westernDiagnosis?.primary?.name, "单发基线必须先跑出西医诊断");
{
  const run = await runParallelM03([misnestedWesternHalf]);
  assert.equal(run.streamCalls, 1);
  assert.equal(run.westernCalls, 1, "可修复的错位文本不需要重试");
  assert.ok(run.signed.contractSignature, "并行路径照常签名");
  assert.equal(run.signed.westernDiagnosis.primary.name, settledSigned.westernDiagnosis.primary.name,
    "错位 JSON 修复后，签名里的西医诊断必须与单发路径一致，而不是默认占位");
  assert.notEqual(westernDiagnosisLabelForDisplay(run.signed.westernDiagnosis.primary.name), "当前未形成可复核的西医工作诊断");
  assert.ok(run.signed.westernDiagnosis.primary.suggestedChecks.includes("睡眠日记（连续1-2周）"),
    "写到顶层的 suggestedChecks 必须归位到 westernDiagnosis.primary");
  assert.equal(run.signed.management.followupSafetyNet, settledSigned.management.followupSafetyNet);
  assert.equal(run.halves?.westernHalfOk, true);
  assert.equal(run.halves?.westernHalfParse, "recovered", "遥测必须如实记下这次是修复后才可用");
  assert.equal(run.halves?.westernHalfRelocated, 1);
}
{
  const run = await runParallelM03([truncatedWesternHalf, cleanWesternHalf]);
  assert.equal(run.westernCalls, 2, "救不回来的西医半按可重试失败再请求一次");
  assert.equal(run.signed.westernDiagnosis.primary.name, settledSigned.westernDiagnosis.primary.name);
  assert.equal(run.halves?.westernHalfParse, "clean");
}
{
  const run = await runParallelM03([truncatedWesternHalf, truncatedWesternHalf]);
  assert.equal(run.westernCalls, 2, "只重试一次");
  assert.ok(run.signed.contractSignature, "西医半两次都不可用时中医结果照常签名交付");
  assert.equal(run.signed.westernDiagnosis.primary.name, "症状性诊断，病因待临床鉴别",
    "确实拿不到西医半时才落默认占位（页面显示「当前未形成可复核的西医工作诊断」）");
  assert.equal(run.halves?.westernHalfOk, false);
  assert.equal(run.halves?.westernHalfReason, "unparseable_content");
  assert.equal(run.halves?.westernHalfParse, "absent");
}

// ─── DeepSeek 首轮 + 严格兜底（2026-09-24，提速第三批）─────────────────────────────────────
//
// M03 两半改跑 deepseek-flash（json_object）。9/11–9/19 的教训：json_object 只保证「像 JSON」，
// 形状不对时 zod 的 .catch 静默换成缺省值，页面少一块、日志里什么都没有。这里钉三件事：
//  1. DeepSeek 输出不合严格 schema → 用严格兜底模型（百炼端点、json_schema）对同一份提示词重生成，
//     且**签名的是兜底内容**（与「DeepSeek 直接给出合规内容」时签出的结果逐字段相同）；
//  2. 合规时一次兜底请求都不发；
//  3. 西医半把 supportingFactKinds 写成字符串（线上 9/9 次的形状）→ 同样改由严格模型重生成。
const tcmCompliantHalf = structuredClone(tcmHalfOnly);
tcmCompliantHalf.overview.tcmDifferentials = [{
  syndrome: "心肾不交证",
  reason: "同见入睡困难、多梦易醒，需与心脾两虚鉴别",
  distinguishingPoints: "本例纳差便溏、舌淡脉细弱，未见五心烦热、舌红少苔",
  typicalManifestation: "",
  nextCheck: null,
}];
tcmCompliantHalf.pathogenesis.locationDifferentiation.details = [
  { location: "心", basis: "心悸健忘、入睡困难、多梦易醒" },
  { location: "脾", basis: "纳差便溏" },
];
tcmCompliantHalf.pathogenesis.uncertainties = [{ item: "月经与出血情况", reason: "病历未记录", affects: "血虚程度判断" }];
tcmCompliantHalf.therapy.subTherapies = tcmCompliantHalf.therapy.subTherapies.map((item, index) => ({ ...item, priority: index === 0 ? "主要" : "次要" }));
const deepseekWesternWithStringKinds = JSON.stringify({
  westernDiagnosis: {
    ...m03Candidate.westernDiagnosis,
    primary: { ...m03Candidate.westernDiagnosis.primary, supportingFactKinds: m03Candidate.westernDiagnosis.primary.supportingFacts.map(() => "symptom") },
  },
  management: m03Candidate.management,
});
const deepseekFirstEnv = {
  ...settledEnv,
  AI_TEXT_PROVIDER: "bailian-qwen",
  BAILIAN_QWEN_API_KEY: "test-only-qwen-fallback",
  BAILIAN_QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  BAILIAN_QWEN_MODEL: "qwen3.8-flash",
  OPENAI_MODEL: "deepseek-flash",
  PRIMARY_DIAGNOSE_MODEL: "deepseek-flash",
  PRIMARY_STRUCTURED_FALLBACK_MODEL: "qwen3.8-flash",
  CDSS_TEXT_MODEL_ALLOWED_HOSTS: "",
  CDSS_DEEPSEEK_ALLOWED_HOSTS: "",
};
const runDeepseekFirstParallelM03 = async ({ tcmStream, deepseekWestern, qwenReplies, tcmStreamCutOff = false }) => {
  const savedEnv = Object.fromEntries(Object.keys(deepseekFirstEnv).map((key) => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  const savedInfo = console.info;
  const savedWarn = console.warn;
  const logs = [];
  const requests = [];
  const westernQueue = [...deepseekWestern];
  try {
    Object.assign(process.env, deepseekFirstEnv);
    console.info = (...args) => { logs.push(args); };
    console.warn = (...args) => { logs.push(args); };
    globalThis.fetch = async (url, init) => {
      const request = JSON.parse(init.body);
      const host = new URL(String(url)).hostname;
      const task = request.response_format?.json_schema?.name;
      requests.push({ host, model: request.model, stream: Boolean(request.stream), format: request.response_format?.type, task,
        auth: init.headers.Authorization, schemaInPrompt: /【输出 JSON Schema/.test(request.messages[0].content) });
      if (host === "api.deepseek.com" && request.stream) {
        if (tcmStreamCutOff) {
          // 上游在半截处正常关闭连接、没有 [DONE]：线上「流提前 EOF」的形状。
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: tcmStream.slice(0, 200) }, finish_reason: null }] })}\n\n`, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: tcmStream }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (host === "api.deepseek.com") return Response.json({ choices: [{ message: { content: westernQueue.shift() ?? "" }, finish_reason: "stop" }] });
      return Response.json({ choices: [{ message: { content: qwenReplies[task] ?? "" }, finish_reason: "stop" }] });
    };
    const response = await callDiagnosisStream("synthetic DeepSeek-first M03", "deepseek", undefined, "markdown", {
      structuredStage: "diagnose",
      structuredClinicalContext: m03ClinicalContext,
      structuredAllowedM03FormulaNames: ["归脾汤"],
      truncateFallback: "SYNTHETIC_FALLBACK",
      m03ParallelHalfPrompts: { western: "synthetic western half", tcm: "synthetic tcm half" },
      diagnoseSignatureContext: {
        contractVersion: "tcm-cdss-m03-signature-v5",
        caseId: "synthetic-deepseek-first",
        encounterId: "synthetic-deepseek-first-encounter",
        clinicalInputHash: `sha256:${"c".repeat(64)}`,
      },
    });
    const frames = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(frames.filter((frame) => frame.error), [], "the mock stream must finish without an error");
    const output = frames.filter((frame) => typeof frame.content === "string").map((frame) => frame.content).join("");
    return { signed: parseSentinelReasoning(output), requests, logs };
  } finally {
    globalThis.fetch = savedFetch;
    console.info = savedInfo;
    console.warn = savedWarn;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
};
const clinicalProjection = (signed) => JSON.stringify({ overview: signed.overview, pathogenesis: signed.pathogenesis, therapy: signed.therapy, westernDiagnosis: signed.westernDiagnosis });
{
  const direct = await runDeepseekFirstParallelM03({ tcmStream: JSON.stringify(tcmCompliantHalf), deepseekWestern: [cleanWesternHalf], qwenReplies: {} });
  assert.ok(direct.signed.contractSignature, "DeepSeek 合规输出直接签名");
  assert.deepEqual(direct.requests.map((item) => `${item.host}|${item.stream}`).sort(), ["api.deepseek.com|false", "api.deepseek.com|true"],
    "合规时只有 DeepSeek 两半各一次请求，不发任何兜底请求");
  assert.ok(direct.requests.every((item) => item.model === "deepseek-flash" && item.format === "json_object" && item.auth === "Bearer test-only-m03-settled"),
    "DeepSeek 两半必须带着 DeepSeek 的模型名与密钥，json_object");
  assert.ok(direct.requests.every((item) => item.schemaInPrompt), "M03 两半给 DeepSeek 的系统消息必须附严格 schema");

  const replaced = await runDeepseekFirstParallelM03({
    tcmStream: JSON.stringify(tcmHalfOnly),
    deepseekWestern: [cleanWesternHalf],
    qwenReplies: { m03_tcm: JSON.stringify(tcmCompliantHalf) },
  });
  const fallbackRequests = replaced.requests.filter((item) => item.host === "dashscope.aliyuncs.com");
  assert.equal(fallbackRequests.length, 1, "中医半不合 schema → 恰好一次严格兜底");
  assert.equal(fallbackRequests[0].model, "qwen3.8-flash");
  assert.equal(fallbackRequests[0].task, "m03_tcm");
  assert.equal(fallbackRequests[0].format, "json_schema", "兜底走严格 schema，由解码器保证形状");
  assert.equal(fallbackRequests[0].auth, "Bearer test-only-qwen-fallback");
  assert.equal(fallbackRequests[0].schemaInPrompt, false, "严格模型不重复附 schema");
  assert.ok(replaced.signed.contractSignature);
  assert.equal(clinicalProjection(replaced.signed), clinicalProjection(direct.signed),
    "签名的必须是兜底内容：与 DeepSeek 直接给出同一份合规内容时逐字段相同");
  const fallbackLog = replaced.logs.find(([name]) => name === "[tcm-cdss:timing] structured_strict_fallback")?.[1];
  assert.equal(fallbackLog?.outcome, "replaced");
  const violationLog = replaced.logs.find(([name]) => name === "[tcm-cdss:model] non-strict structured output violates provider schema")?.[1];
  assert.match(violationLog?.violations || "", /priority enum/, "遥测只记路径与关键字");
  assert.doesNotMatch(JSON.stringify(violationLog), /心悸|纳差/, "违规遥测不得回显病历内容");

  const western = await runDeepseekFirstParallelM03({
    tcmStream: JSON.stringify(tcmCompliantHalf),
    deepseekWestern: [deepseekWesternWithStringKinds],
    qwenReplies: { m03_western: cleanWesternHalf },
  });
  const westernFallback = western.requests.filter((item) => item.host === "dashscope.aliyuncs.com");
  assert.deepEqual(westernFallback.map((item) => item.task), ["m03_western"], "西医半依据分类写成字符串 → 改由严格模型重生成西医半");
  assert.equal(clinicalProjection(western.signed), clinicalProjection(direct.signed),
    "依据分栏不得被 zod 缺省值静默顶替");

  const cutOff = await runDeepseekFirstParallelM03({
    tcmStream: JSON.stringify(tcmCompliantHalf),
    tcmStreamCutOff: true,
    deepseekWestern: [cleanWesternHalf],
    qwenReplies: { m03_tcm: JSON.stringify(tcmCompliantHalf) },
  });
  assert.deepEqual(cutOff.requests.filter((item) => item.host === "dashscope.aliyuncs.com").map((item) => item.task), ["m03_tcm"],
    "DeepSeek 中医半流中途断 → 严格兜底重生成，而不是落「服务暂时不可用」页");
  assert.ok(cutOff.signed?.contractSignature, "兜底成功后照常签名");
  assert.equal(clinicalProjection(cutOff.signed), clinicalProjection(direct.signed));
}

console.log(JSON.stringify({ cases: 129, failures: 0 }));
