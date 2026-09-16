/**
 * M03/M04 模型复核环节删除（owner 裁定 2026-09-16）。
 *
 * 线上实测（2026-09-15 容器）：107 次复核全部是与生成方同一模型（deepseek-flash）、reasoning=low、
 * 中位 1.4s 的请求，90 次判 repair / 15 次通过 / 2 次不可用；M03 侧 43 次意见全部被服务端降成
 * 有界建议（24/25 签名态 unavailable）；M04 侧 19 轮修复里 17 轮由它触发（162s、22.5 万 prompt token），
 * 15/35 次把 contractIssues=[]、safetyFindingCount=0 的候选扣成非剂量，同一病例重试 14 次逐次相同；
 * 健康探针另打 214 次/天。仓库里没有任何一份「有/无复核」对照。结论：无可证明的正收益，可测量的
 * 效果全是负的。
 *
 * 本套件钉住四件事（每条都跑过反证，见 STATUS 2026-09-16）：
 *  1. 整个 M04 编排只有一次生成调用——没有复核调用；产出的是**已签名的剂量页**，
 *     attestation 固定 unavailable/not_configured 且哈希绑定（签名契约不变）；
 *  2. 交付连续性路径：已签名候选按「签名 + 哈希绑定」视为已完成，不再要求 accepted；
 *     剂量轴收回时仍不返回剂量页（安全底线不动）；
 *  3. 执行层（请求体、候选链、探针、非剂量门）在源码里不存在；健康检查不再依赖复核器；
 *  4. 医生可见文案不再暗示「配一下就有复核」或「正在独立复核」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

Object.assign(process.env, {
  AI_TEXT_PROVIDER: "bailian-qwen", BAILIAN_QWEN_API_KEY: "test-only",
  BAILIAN_QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  BAILIAN_QWEN_MODEL: "qwen3.7-plus", PRIMARY_PRESCRIBE_MODEL: "qwen3.7-plus",
  PRIMARY_PRESCRIBE_REPAIR_MODEL: "qwen3.8-max", STRUCTURED_QUALITY_REPAIR_ROUNDS: "0",
  M04_ORCHESTRATION_DEADLINE_MS: "60000", REASONING_CONTRACT_SIGNING_KEY: "synthetic-signing-key-at-least-32-characters",
});
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { callDiagnosisStream } = await jiti.import("../src/lib/diagnosis-api.ts");
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");
const { retainM04DeliveryCheckpoint, bindM04DeliveryReview, renderM04DeliveryCheckpoint, m04DeliveryCheckpointIsClean } =
  await jiti.import("../src/lib/m04-delivery-checkpoint.ts");
const { clinicalReviewPayloadHash, hasBoundClinicalReviewAttestation } = await jiti.import("../src/lib/clinical-review-binding.ts");
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
  assert.equal(reasoning.clinicalReview?.status, "unavailable");
  assert.equal(reasoning.clinicalReview?.unavailableReason, "not_configured");
  assert.equal(reasoning.clinicalReview?.attemptCount, 0, "没有复核尝试");
  assert.equal(hasBoundClinicalReviewAttestation(reasoning), true, "attestation 必须哈希绑定到这份载荷（签名契约不变）");
  assert.match(content, /<!-- CDSS_REVIEW_STATUS -->/, "复核状态独立信道标记保留，前端分流不变");
  assert.match(content, /本版本不设模型复核环节/);
  assert.doesNotMatch(content, /独立处方复核|复核未完成|服务繁忙或超时/, "不得再暗示复核器存在或没跑完");
  assert.equal(delivered.telemetry?.outcome, "success", JSON.stringify(delivered.telemetry));
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
  const attestation = { status: "unavailable", unavailableReason: "not_configured", attemptCount: 0, durationMs: 0,
    reviewedPayloadHash: clinicalReviewPayloadHash(bare) };
  const signed = applyPrescribeContractSignature(wrap({ ...bare, clinicalReview: attestation }), signatureContext);
  const bound = bindM04DeliveryReview(checkpoint, bare, { status: "unavailable", reason: "not_configured" }, attestation, signed);
  assert.equal(bound.signedContent, signed, "签名 + 哈希绑定的候选必须被绑定为已完成");
  assert.equal(renderM04DeliveryCheckpoint(bound, prior, "deadline"), signed, "时限到期时交付已签名剂量页");
  assert.equal(renderM04DeliveryCheckpoint(bound, prior, "contract_rejected"), signed);
  const withheld = renderM04DeliveryCheckpoint(bound, prior, "dose_withheld", ["已记录妊娠、哺乳或备孕阳性/可疑状态"]);
  assert.notEqual(withheld, signed, "剂量轴收回是独立硬边界，删复核不得放松它");
  assert.ok(isNonDosePrescriptionText(withheld));
  assert.doesNotMatch(withheld, /12g|10g|6g|5剂/);
  const mismatch = bindM04DeliveryReview(checkpoint, bare, { status: "unavailable", reason: "not_configured" }, attestation, "WRONG_SIGNED_BYTES");
  assert.equal(mismatch.signedContent, undefined, "不匹配的签名字节仍不得被当成已完成");
});

test("执行层在源码里不存在；健康检查与 HIS 不再依赖复核器", () => {
  const api = readFileSync("src/lib/diagnosis-api.ts", "utf8");
  for (const gone of ["runIndependentClinicalReview", "probeClinicalReviewModels", "clinicalReviewModelCandidates",
    "buildClinicalReviewRequestBody", "clinicalReviewUnavailableFallback", "m04ClinicalReviewRequiresNonDoseFallback",
    "PRIMARY_CLINICAL_REVIEW", "structuredReviewRequestFields"]) {
    assert.ok(!api.includes(gone), `${gone} 回到 diagnosis-api.ts 了`);
  }
  for (const entry of ["async function reviewM03DiagnosticCriteria(", "async function reviewM04ClinicalPlan("]) {
    const start = api.indexOf(entry);
    const end = api.indexOf("\n}\n", start);
    assert.ok(start > 0 && end > start && end - start < 2_000, `${entry} 切片越界，断言会空转`);
    const body = api.slice(start, end);
    assert.ok(body.includes("clinicalReviewNotPerformed"), `${entry} 必须是不发请求的桩`);
    assert.ok(!/\bfetch\(|createTextModelClient|chat\.completions/.test(body), `${entry} 里不得有模型调用`);
  }
  const health = readFileSync("src/app/api/diagnosis/health/route.ts", "utf8");
  assert.ok(!/independent_clinical_reviewer|probeClinicalReviewModels|clinicalReviewProbe/.test(health), "严格健康检查不得再依赖复核器");
  const modelHealth = readFileSync("src/app/api/model-health/route.ts", "utf8");
  assert.ok(!modelHealth.includes("probeClinicalReviewModels"));
  const his = readFileSync("src/lib/his-scheme.ts", "utf8");
  assert.match(his, /if \(!attestation \|\| attestation\.status !== "accepted"\) return null;/, "HIS 不得把未复核写成「二次复核」");
  assert.ok(!readFileSync("src/lib/m04-clinical-review.ts", "utf8").includes("m04ClinicalReviewRequiresNonDoseFallback"));
  for (const file of [".env.example", "docker-compose.yml"]) {
    assert.ok(!readFileSync(file, "utf8").includes("PRIMARY_CLINICAL_REVIEW"), `${file} 仍带已删的复核变量`);
  }
});

test("医生可见文案：不再暗示「配一下就有复核」或「正在独立复核」", () => {
  const copy = limitedDiagnosisReasonCopy("not_configured");
  assert.match(copy.reason, /本版本不设模型复核环节/);
  assert.doesNotMatch(`${copy.reason}${copy.limitation}${copy.nextAction}`, /配置|系统管理员/);
  for (const structuredStage of ["prescribe", "diagnose", undefined]) {
    const text = stageProgressHeartbeatStatus({ phase: "review", structuredStage, contentChars: 1, reasoningChars: 0, repairRound: 0 });
    assert.doesNotMatch(text, /独立复核/, text);
  }
});
