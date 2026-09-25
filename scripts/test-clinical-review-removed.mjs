/**
 * M03/M04 模型复核环节删除（owner 裁定 2026-09-16；编排遗留于 2026-09-25 清除）。
 *
 * 线上实测（2026-09-15 容器）：107 次复核全部是与生成方同一模型（deepseek-flash）、reasoning=low、
 * 中位 1.4s 的请求，90 次判 repair / 15 次通过 / 2 次不可用；M03 侧 43 次意见全部被服务端降成
 * 有界建议（24/25 签名态 unavailable）；M04 侧 19 轮修复里 17 轮由它触发（162s、22.5 万 prompt token），
 * 15/35 次把 contractIssues=[]、safetyFindingCount=0 的候选扣成非剂量，同一病例重试 14 次逐次相同。
 * 结论：无可证明的正收益，可测量的效果全是负的。
 *
 * 本套件只钉**行为**（不钉「某个函数名不在源码里」这类墓碑断言）：
 *  1. 签名载荷里的 clinicalReview 是逐字固定的常量 attestation（对外契约：字段、取值、键序）；
 *  2. M03 与 M04 编排都只有生成调用、没有任何复核请求；产出照常签名，attestation 为常量且哈希绑定；
 *  3. 交付连续性路径：已签名 + 哈希绑定即已完成；剂量轴收回时仍不返回剂量页（安全底线不动）；
 *  4. 医生可见的进度文案不再暗示「正在独立复核」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

Object.assign(process.env, {
  AI_TEXT_PROVIDER: "bailian-qwen", BAILIAN_QWEN_API_KEY: "test-only",
  BAILIAN_QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  BAILIAN_QWEN_MODEL: "qwen3.7-plus", PRIMARY_PRESCRIBE_MODEL: "qwen3.7-plus",
  PRIMARY_PRESCRIBE_REPAIR_MODEL: "qwen3.8-max", PRIMARY_DIAGNOSE_MODEL: "qwen3.8-flash",
  CONTROLLED_TERMINOLOGY_NORMALIZATION: "false",
  M04_ORCHESTRATION_DEADLINE_MS: "60000", REASONING_CONTRACT_SIGNING_KEY: "synthetic-signing-key-at-least-32-characters",
});
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { callDiagnosisStream } = await jiti.import("../src/lib/diagnosis-api.ts");
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");
const { retainM04DeliveryCheckpoint, bindM04DeliveryAttestation, renderM04DeliveryCheckpoint, m04DeliveryCheckpointIsClean } =
  await jiti.import("../src/lib/m04-delivery-checkpoint.ts");
const { clinicalReviewNotPerformedAttestation, clinicalReviewPayloadHash, hasBoundClinicalReviewAttestation } =
  await jiti.import("../src/lib/clinical-review-binding.ts");
const { applyPrescribeContractSignature } = await jiti.import("../src/lib/reasoning-contract-signature.ts");
const { isNonDosePrescriptionText, limitedDiagnosisReasonCopy } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { stageProgressHeartbeatStatus } = await jiti.import("../src/lib/diagnosis-stream-protocol.ts");

const prior = ReasoningV2Schema.parse({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { primarySyndrome: "脾胃虚弱证", overallPathogenesis: "脾胃虚弱，运化无力", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [
    { nodeId: "P1", patientFact: "食少倦怠", syndromeEvidence: "食少倦怠", pathogenesis: "脾胃虚弱，运化无力", therapyDirection: "健脾益气" },
    { nodeId: "P2", patientFact: "大便溏薄", syndromeEvidence: "大便溏薄", pathogenesis: "脾虚湿盛", therapyDirection: "健脾化湿" },
  ] },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "健脾益气，化湿和中", subTherapies: [{ therapy: "健脾益气", targetPathogenesis: "脾胃虚弱", priority: "主要" }] },
  formula: { candidates: [], patentAndWestern: [], modifications: [] },
});
const proposal = {
  candidate: { name: "本例辨证组方", applicable: "食少倦怠与便溏并见。", notApplicable: "便溏加重或出现腹痛时评估。",
    herbs: [
      { name: "党参", dose: "12g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "补脾益气，改善食少倦怠" },
      { name: "白术", dose: "10g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾燥湿，兼顾便溏" },
      { name: "茯苓", dose: "12g", role: "佐", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾渗湿" },
      { name: "炙甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "补脾和胃" },
    ].map((herb) => ({ ...herb, processing: null, isToxic: false, decoctionRequirement: null })),
    formulaAnalysis: "党参补脾益气以改善食少倦怠，白术燥湿、茯苓渗湿兼顾便溏，炙甘草补脾和胃。",
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，煎服", followUpNode: "5日复诊" },
  }, patentAndWestern: [], modifications: [],
  nonPharma: { diet: "早餐可用山药小米粥，少量多餐。", lifestyle: "规律作息。", emotion: "调畅情志。", precautions: ["观察食欲与便溏变化。"], tcmTreatments: [] },
};
const encoder = new TextEncoder();
const sse = (value) => new Response(new ReadableStream({ start(controller) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
  controller.close();
} }), { headers: { "content-type": "text/event-stream" } });
const signatureContext = { contractVersion: "tcm-cdss-m04-signature-v3", caseId: "synthetic", encounterId: "synthetic",
  clinicalInputHash: `sha256:${"a".repeat(64)}`, diagnoseContractHash: `sha256:${"b".repeat(64)}` };
const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = (reasoning) => `${START}\n${JSON.stringify(reasoning)}\n${END}`;
const sentinelPayload = (content) => {
  const start = content.lastIndexOf(START);
  const end = content.indexOf(END, start);
  assert.ok(start >= 0 && end > start, "剂量页必须带结构化 sentinel");
  return JSON.parse(content.slice(start + START.length, end));
};

/** 对外契约：常量 attestation 的字段、取值与键序（签名覆盖的是序列化字节）。 */
const expectedAttestation = (reasoning) => JSON.stringify({
  status: "unavailable", unavailableReason: "not_configured", attemptCount: 0, durationMs: 0,
  reviewedPayloadHash: clinicalReviewPayloadHash(reasoning),
});

test("常量 attestation：字段、取值与键序逐字固定，且哈希绑定到这份载荷", () => {
  const attestation = clinicalReviewNotPerformedAttestation(prior);
  assert.equal(JSON.stringify(attestation), expectedAttestation(prior));
  assert.match(attestation.reviewedPayloadHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(hasBoundClinicalReviewAttestation({ ...prior, clinicalReview: attestation }), true);
  const other = structuredClone(prior);
  other.overview.primarySyndrome = "脾虚湿盛证";
  assert.equal(hasBoundClinicalReviewAttestation({ ...other, clinicalReview: attestation }), false,
    "attestation 只绑定它计算时的那份载荷");
});

async function runM04() {
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const abort = new AbortController();
  const requests = [];
  const telemetry = [];
  try {
    console.info = (label, event) => {
      if (label === "[tcm-cdss:telemetry] stage_result") telemetry.push(event);
      originalInfo(label, event);
    };
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      assert.ok(requests.length < 4, "模型调用次数失控");
      return sse(proposal);
    };
    const response = await callDiagnosisStream("synthetic no-reviewer fixture", "deepseek", undefined, "markdown", {
      structuredStage: "prescribe", structuredPriorReasoning: prior,
      structuredClinicalContext: "成人；食少倦怠；大便溏薄", requestSignal: abort.signal,
      structuredOrchestrationStartedAt: Date.now(),
      truncateFallback: "GENERIC_KB_FALLBACK", deadlineFallback: "GENERIC_DEADLINE_FALLBACK",
      prescribeSignatureContext: signatureContext,
    });
    const wire = await response.text();
    const frames = wire.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const finals = frames.filter((frame) => frame.content?.startsWith("<<<CDSS_STREAM_FINAL>>>"));
    return { requests, finals, content: finals.at(-1)?.content || "", telemetry: telemetry.at(-1) };
  } finally { abort.abort(); globalThis.fetch = originalFetch; console.info = originalInfo; }
}

let delivered;
test("M04 只有一次生成调用，且直接签出剂量页（attestation 固定 unavailable/not_configured 并哈希绑定）", async () => {
  delivered = await runM04();
  assert.equal(delivered.requests.length, 1, `模型复核环节已删除：整个 M04 编排只能有一次生成调用，实际 ${delivered.requests.length}`);
  assert.equal(delivered.finals.length, 1);
  const content = delivered.content;
  assert.match(content, /党参/);
  assert.match(content, /12g/, "剂量必须照常显示——复核状态不再决定剂量页");
  assert.equal(isNonDosePrescriptionText(content), false, "不得再落到非剂量投影");
  assert.match(content, /"contractSignature":\s*"hmac-sha256:/, "必须是已签名的剂量页");
  const reasoning = sentinelPayload(content);
  assert.equal(JSON.stringify(reasoning.clinicalReview), expectedAttestation(reasoning), "attestation 必须是常量且绑定这份载荷");
  assert.equal(hasBoundClinicalReviewAttestation(reasoning), true, "attestation 必须哈希绑定到这份载荷（签名契约不变）");
  // owner 2026-09-25：页面顶端的「临床复核状态」行连同其信道标记一并删除。
  assert.doesNotMatch(content, /CDSS_REVIEW_STATUS|临床复核状态|模型复核/, "页面不得再出现关于已删除模型复核的状态行");
  assert.doesNotMatch(content, /独立处方复核|复核未完成|服务繁忙或超时/, "不得再暗示复核器存在或没跑完");
  assert.equal(delivered.telemetry?.outcome, "success", JSON.stringify(delivered.telemetry));
});

const m03Evidence = { evidenceLevel: "model_inference", source: "本例四诊资料", confidence: "中" };
const m03Fixture = {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: {
    tcmDiseaseName: "不寐", primarySyndrome: "心脾两虚证", primarySyndromeBasis: ["心悸健忘", "纳差便溏"],
    tcmDiseaseRationale: "以入睡困难、多梦易醒为主症，病程3个月，符合不寐范畴，与郁病、心悸相区分。",
    tcmDiagnosticRationale: "心悸健忘与纳差便溏并见，结合舌淡脉细弱，支持心脾两虚、心神失养。",
    tcmDifferentials: [],
    tcmDiseaseDifferentials: [{ diseaseName: "多寐病", reason: "同属睡眠病症但方向相反，需先分辨主症", distinguishingPoints: "本例为入睡困难与多梦易醒，非日间嗜睡", nextCheck: null }],
    secondarySyndromes: [], overallPathogenesis: "脾气亏虚，心血失养", overallTherapy: "健脾益气，养血安神",
    recommendedFormulaDirection: "归脾汤加减", recommendedFormulaNames: ["归脾汤"], formulaSelectionMode: "single", evidence: m03Evidence,
  },
  westernDiagnosis: {
    primary: { name: "失眠症状", status: "考虑", confidence: "中", supportingFacts: ["入睡困难、多梦易醒3个月"],
      clinicalRationale: "入睡困难、多梦易醒3个月支持失眠症状方向，但尚未取得日间功能受损情况，暂不升级为正式失眠障碍诊断。",
      limitations: ["未完成睡眠量表"], suggestedChecks: [], evidence: m03Evidence },
    differentials: [],
  },
  pathogenesis: {
    summary: "心脾两虚，心神失养",
    locationDifferentiation: { items: ["心", "脾"], evidence: m03Evidence },
    natureDifferentiation: { items: ["气虚", "血虚"], evidence: m03Evidence },
    chain: [{ nodeId: "P1", patientFact: "心悸健忘、纳差便溏", syndromeEvidence: "舌淡，脉细弱", pathogenesis: "脾气亏虚，心血失养", therapyDirection: "健脾益气，养血安神", evidence: m03Evidence }],
    uncertainties: [],
  },
  therapy: { overallPrinciple: "虚则补之，标本兼顾", overallMethod: "健脾益气，养血安神",
    subTherapies: [{ therapy: "健脾益气", targetPathogenesis: "脾气亏虚", priority: "主要" }, { therapy: "养血安神", targetPathogenesis: "心血失养", priority: "兼顾" }] },
  management: { followupSafetyNet: "若入睡困难持续2周不缓解或明显加重，及时复诊评估。" },
};

test("M03 编排只有一次生成调用、没有任何复核请求；签名照常，attestation 为常量并哈希绑定", async () => {
  const originalFetch = globalThis.fetch;
  const abort = new AbortController();
  const requests = [];
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      assert.ok(requests.length < 4, "模型调用次数失控");
      return sse(m03Fixture);
    };
    const response = await callDiagnosisStream("synthetic no-reviewer M03 fixture", "deepseek", undefined, "markdown", {
      structuredStage: "diagnose", requestSignal: abort.signal, structuredOrchestrationStartedAt: Date.now(),
      structuredClinicalContext: "心悸健忘、纳差便溏；舌淡，脉细弱；入睡困难、多梦易醒3个月",
      structuredAllowedM03FormulaNames: ["归脾汤"], truncateFallback: "SYNTHETIC_FALLBACK",
      diagnoseSignatureContext: { contractVersion: "tcm-cdss-m03-signature-v5", caseId: "synthetic-m03", encounterId: "synthetic-m03",
        clinicalInputHash: `sha256:${"c".repeat(64)}` },
    });
    const frames = (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const content = frames.filter((frame) => frame.content?.startsWith("<<<CDSS_STREAM_FINAL>>>")).at(-1)?.content || "";
    assert.equal(requests.length, 1, `模型复核环节已删除：M03 只能有一次生成调用，实际 ${requests.length}`);
    assert.ok(requests.every((request) => request.stream === true), "不得有任何非流式（复核/裁决）请求");
    const reasoning = sentinelPayload(content);
    assert.match(reasoning.contractSignature || "", /^hmac-sha256:/, "M03 照常签名");
    assert.equal(JSON.stringify(reasoning.clinicalReview), expectedAttestation(reasoning), "attestation 必须是常量且绑定这份载荷");
    assert.equal(hasBoundClinicalReviewAttestation(reasoning), true);
    assert.doesNotMatch(content, /CDSS_REVIEW_STATUS|临床复核状态|模型复核/, "页面不得再出现关于已删除模型复核的状态行");
  } finally { abort.abort(); globalThis.fetch = originalFetch; }
});

test("交付连续性：已签名 + 哈希绑定即已完成，不再要求 accepted；剂量轴收回时仍不返回剂量页", () => {
  assert.ok(delivered, "依赖上一条的产出");
  const signedReasoning = sentinelPayload(delivered.content);
  const bare = { ...signedReasoning };
  delete bare.clinicalReview; delete bare.contractSignature; delete bare.contractSignatureVersion;
  const checkpoint = retainM04DeliveryCheckpoint(undefined, {
    content: wrap(bare), reasoning: bare, priorReasoning: prior, clinicalContext: "成人；食少倦怠；大便溏薄",
  });
  assert.ok(checkpoint, "通过合同的候选必须被保留");
  assert.equal(m04DeliveryCheckpointIsClean(checkpoint), true, JSON.stringify(checkpoint.contractIssues));
  const attestation = clinicalReviewNotPerformedAttestation(bare);
  const signed = applyPrescribeContractSignature(wrap({ ...bare, clinicalReview: attestation }), signatureContext);
  const bound = bindM04DeliveryAttestation(checkpoint, bare, attestation, signed);
  assert.equal(bound.signedContent, signed, "签名 + 哈希绑定的候选必须被绑定为已完成");
  assert.equal(renderM04DeliveryCheckpoint(bound, prior, "deadline"), signed, "时限到期时交付已签名剂量页");
  assert.equal(renderM04DeliveryCheckpoint(bound, prior, "contract_rejected"), signed);
  const withheld = renderM04DeliveryCheckpoint(bound, prior, "dose_withheld", ["已记录妊娠、哺乳或备孕阳性/可疑状态"]);
  assert.notEqual(withheld, signed, "剂量轴收回是独立硬边界，删复核不得放松它");
  assert.ok(isNonDosePrescriptionText(withheld));
  assert.doesNotMatch(withheld, /12g|10g|6g|5剂/);
  const mismatch = bindM04DeliveryAttestation(checkpoint, bare, attestation, "WRONG_SIGNED_BYTES");
  assert.equal(mismatch.signedContent, undefined, "不匹配的签名字节仍不得被当成已完成");
});

test("医生可见文案：有限结果页、非剂量候选页与进度行都不再提已删除的模型复核", () => {
  for (const code of ["not_attempted_no_valid_draft", "not_attempted_upstream_down", "deadline"]) {
    const copy = limitedDiagnosisReasonCopy(code);
    assert.doesNotMatch(`${copy.reason}${copy.limitation}${copy.nextAction}`, /独立临床复核|复核否决|模型复核|复核提出|复核未/, code);
  }
  const bare = { ...sentinelPayload(delivered.content) };
  delete bare.clinicalReview; delete bare.contractSignature; delete bare.contractSignatureVersion;
  const checkpoint = retainM04DeliveryCheckpoint(undefined, {
    content: wrap(bare), reasoning: bare, priorReasoning: prior, clinicalContext: "成人；食少倦怠；大便溏薄",
  });
  for (const reason of ["deadline", "contract_rejected", "interrupted", "upstream_unavailable"]) {
    const page = renderM04DeliveryCheckpoint(checkpoint, prior, reason);
    assert.match(page, /本次已生成候选/, reason);
    assert.doesNotMatch(page, /复核未完成|复核提出|已完成临床复核|独立复核/, `${reason}: ${page.slice(0, 200)}`);
  }
  for (const structuredStage of ["prescribe", "diagnose", undefined]) {
    const text = stageProgressHeartbeatStatus({ phase: "review", structuredStage, contentChars: 1, reasoningChars: 0, repairRound: 0 });
    assert.doesNotMatch(text, /独立复核/, text);
    // 修订轮由确定性校验触发，心跳不得再说「按复核意见」（2026-09-25）。
    const repair = stageProgressHeartbeatStatus({ phase: "repair", structuredStage, contentChars: 1, reasoningChars: 0, repairRound: 2 });
    assert.doesNotMatch(repair, /复核/, repair);
    assert.match(repair, /按校验结果第 2 轮修订定稿/, repair);
  }
});
