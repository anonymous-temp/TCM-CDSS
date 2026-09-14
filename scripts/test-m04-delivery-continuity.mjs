import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

// Entirely synthetic traffic; never read runtime credentials or contact a provider.
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
const { canAcceptTransparentFormulaFallback } = await jiti.import("../src/lib/m04-repair-policy.ts");
const { isSafetyClinicalDeliveryAdvisory } = await jiti.import("../src/lib/clinical-delivery-advisory.ts");
const { retainM04DeliveryCheckpoint, bindM04DeliveryReview, preferM04DeliveryCheckpoint, renderM04DeliveryCheckpoint,
  m04DeliveryCheckpointIsClean, m04DeliveryCheckpointSafetyFindingCount, m04DeliveryCheckpointFeedbackCodes } = await jiti.import("../src/lib/m04-delivery-checkpoint.ts");
const { compileM04Proposal } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const { clinicalReviewPayloadHash, hasBoundClinicalReviewAttestation } = await jiti.import("../src/lib/clinical-review-binding.ts");
const { applyPrescribeContractSignature } = await jiti.import("../src/lib/reasoning-contract-signature.ts");
const { isNonDosePrescriptionText } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { parseReasoningV2 } = await jiti.import("../src/lib/diagnosis-parse.ts");
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
const accepted = { status: "accepted", issueCode: "none", repairFocus: "none" };
const completion = (value) => Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }] });
const signatureContext = { contractVersion: "tcm-cdss-m04-signature-v3", caseId: "synthetic", encounterId: "synthetic",
  clinicalInputHash: `sha256:${"a".repeat(64)}`, diagnoseContractHash: `sha256:${"b".repeat(64)}` };
async function runWire({ first = proposal, reviewer = accepted, remainingMs = 2000, abortAfterReview = false,
  priorReasoning = prior, respond, outputTransform } = {}) {
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const abort = new AbortController();
  const requests = [];
  const telemetry = [];
  let lateResolve;
  try {
    console.info = (label, event) => {
      if (label === "[tcm-cdss:telemetry] stage_result") telemetry.push(event);
      originalInfo(label, event);
    };
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (requests.length === 1) return sse(first);
      assert.ok(requests.length < 9, "automatic calls must remain bounded");
      if (abortAfterReview) queueMicrotask(() => abort.abort());
      const next = respond ? respond(requests.length, body) : reviewer;
      if (next === "stall") return new Promise((resolve) => { lateResolve = () => resolve(completion(accepted)); });
      if (next instanceof Response) return next;
      return completion(next);
    };
    const response = await callDiagnosisStream("synthetic continuity fixture", "deepseek", undefined, "markdown", {
      structuredStage: "prescribe", structuredPriorReasoning: priorReasoning,
      structuredClinicalContext: "成人；食少倦怠；大便溏薄", requestSignal: abort.signal,
      structuredOrchestrationStartedAt: Date.now() - 60000 + remainingMs,
      truncateFallback: "GENERIC_KB_FALLBACK", deadlineFallback: "GENERIC_DEADLINE_FALLBACK",
      prescribeSignatureContext: signatureContext,
      outputTransform,
    });
    const wire = await response.text();
    const frames = wire.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const finals = frames.filter((frame) => frame.content?.startsWith("<<<CDSS_STREAM_FINAL>>>"));
    lateResolve?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { frames, finals, requests, telemetry: telemetry.at(-1), content: finals.at(-1)?.content || "" };
  } finally { lateResolve?.(); abort.abort(); globalThis.fetch = originalFetch; console.info = originalInfo; }
}
function assertNonDose(content) {
  assert.ok(isNonDosePrescriptionText(content), "client must recognize and retain the non-dose result");
  assert.doesNotMatch(content, /DIAGNOSIS_JSON_START|contractSignature|12g|10g|6g|5剂|GENERIC_|重新生成|请重试/);
}
function withDietQualityFinding(content) {
  const start = content.indexOf("<!-- DIAGNOSIS_JSON_START -->");
  const end = content.indexOf("<!-- DIAGNOSIS_JSON_END -->");
  if (start < 0 || end < 0) return content;
  const reasoning = JSON.parse(content.slice(start + "<!-- DIAGNOSIS_JSON_START -->".length, end));
  reasoning.nonPharma.diet = "清淡饮食";
  return `${content.slice(0, start)}${wrap(reasoning)}`;
}

test("explicit zero quality budget qualifies the same safe candidate for identity declassification", () => {
  const input = { completedRepairAttempts: 0, qualityRepairExhaustedForCandidate: true,
    strictFormulaIssue: "formula_reference_declassified", requestAborted: false };
  assert.equal(canAcceptTransparentFormulaFallback(input), true);
  assert.equal(canAcceptTransparentFormulaFallback({ ...input, therapyIssue: "herb_0_dose" }), false);
  assert.equal(canAcceptTransparentFormulaFallback({ ...input, requestAborted: true }), false);
});

test("validated individualized candidate survives a stalled reviewer and late resolution", async () => {
  const result = await runWire({ reviewer: "stall" });
  assert.equal(result.requests.length, 2, "checkpoint must not add model calls");
  assert.equal(result.frames.filter((frame) => frame.content === "[END]").length, 1);
  assert.equal(result.finals.length, 1, "late provider must not emit another result");
  assert.match(result.content, /党参/);
  assert.match(result.content, /食少倦怠/);
  assert.match(result.content, /便溏/);
  assert.match(result.content, /复核未完成|复核.*超过时限/);
  assertNonDose(result.content);
});

test("no valid M04 retains trusted M03 facts and explicitly reports no individualized candidate", async () => {
  const result = await runWire({ first: { candidate: { herbs: [] } } });
  assert.match(result.content, /脾胃虚弱证/);
  assert.match(result.content, /食少倦怠/);
  assert.match(result.content, /健脾益气/);
  assert.match(result.content, /尚未.*个体化|未.*个体化/);
  assert.ok(isNonDosePrescriptionText(result.content));
  assert.doesNotMatch(result.content, /党参|GENERIC_|DIAGNOSIS_JSON_START|重新生成|请重试/);
});

test("client cancellation never sends a recovered candidate", async () => {
  const startedAt = Date.now();
  const result = await runWire({ reviewer: "stall", abortAfterReview: true, remainingMs: 2000 });
  assert.equal(result.finals.length, 0);
  assert.equal(result.requests.length, 2);
  assert.ok(Date.now() - startedAt < 1000, "client cancellation must close independently of a stalled reviewer");
});

test("zero quality budget plus classic identity drift delivers on the first request", async () => {
  const locked = structuredClone(prior);
  locked.overview.recommendedFormulaNames = ["六君子汤"];
  locked.overview.formulaSelectionMode = "single";
  const first = structuredClone(proposal);
  first.candidate.name = "六君子汤";
  first.nonPharma.diet = "清淡饮食";
  const result = await runWire({ first, priorReasoning: locked, outputTransform: withDietQualityFinding });
  assert.equal(result.requests.length, 2, "zero-budget identity disposition must not require a manual second request");
  assert.match(result.content, /党参/);
  assert.match(result.content, /contractSignature/);
  const reasoning = JSON.parse(result.content.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  assert.equal(reasoning.formula.candidates[0].identityDeclassified, true);
  assert.ok(hasBoundClinicalReviewAttestation(reasoning));
});

test("first T2 cannot mask a later T1: automatic repair retains its bounded opportunity", async () => {
  const first = structuredClone(proposal);
  first.nonPharma.diet = "清淡饮食";
  first.candidate.herbs[0].dose = "501g";
  const result = await runWire({ first, remainingMs: 50000, respond: (number) => number === 2 ? proposal : accepted,
    outputTransform: withDietQualityFinding });
  assert.ok(result.requests.length >= 3 && result.requests.length <= 4, "must repair actual unsafe dose, then review");
  assert.match(JSON.stringify(result.requests[1].messages), /dose|剂量/);
  assert.match(result.content, /contractSignature/);
  assert.doesNotMatch(result.content, /501g/);
});

test("a malformed repair does not erase the earlier valid candidate or its review objection", async () => {
  const rejected = { status: "repair", issueCode: "dose_rationale_concern", repairFocus: "dose_strength", candidateIndex: 0, implicatedHerbs: ["党参"] };
  const result = await runWire({ remainingMs: 50000, respond: (number) => number === 2 ? rejected : { candidate: { herbs: [] } } });
  assert.ok(result.requests.length >= 3 && result.requests.length <= 6);
  assert.match(result.content, /党参/);
  assert.match(result.content, /食少倦怠/);
  assert.match(result.content, /剂量强度/);
  assert.doesNotMatch(result.content, /超过时限/);
  assertNonDose(result.content);
});

test("a reviewer objection stays visible when its adjudication stalls", async () => {
  const rejected = { status: "repair", issueCode: "herb_plan_mismatch", repairFocus: "emperor_role", candidateIndex: 0, implicatedHerbs: ["党参"] };
  const result = await runWire({ respond: (number) => number === 2 ? rejected : "stall" });
  assert.equal(result.requests.length, 3);
  assert.match(result.content, /保留意见|意见尚未解决/);
  assertNonDose(result.content);
});

const wrap = (reasoning) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
function checkpointInput() {
  const reasoning = compileM04Proposal(proposal, prior);
  return { reasoning, content: wrap(reasoning), priorReasoning: prior, clinicalContext: "食少倦怠；大便溏薄", generatorModel: "synthetic" };
}
test("checkpoint owns immutable validated bytes and rejects malformed, unsafe and mismatched replacements", () => {
  const input = checkpointInput();
  const checkpoint = retainM04DeliveryCheckpoint(undefined, input);
  assert.ok(checkpoint);
  input.reasoning.formula.candidates[0].herbs[0].name = "不应覆盖";
  assert.equal(checkpoint.reasoning.formula.candidates[0].herbs[0].name, "党参");
  assert.throws(() => { checkpoint.reasoning.formula.candidates[0].herbs.length = 0; }, TypeError);
  for (const change of [
    (value) => { value.reasoning.formula.candidates = []; },
    (value) => { value.reasoning.formula.candidates[0].herbs[0].dose = "501g"; },
    (value) => { value.content = "incomplete"; },
  ]) {
    const bad = checkpointInput(); change(bad);
    assert.equal(retainM04DeliveryCheckpoint(checkpoint, bad), checkpoint);
  }
});
// ── 「保留任何合法候选」：合同不过不再等于 0 味（owner 决策 2026-09-13）──────────────
// 2026-09-11 只读归因第四类 13 例：流中已有 7–11 味药、finishReason=stop、未触及总时限，
// 最终一味药都没留下，医生拿到「本次尚未形成通过校验的个体化方药候选」。
// 现在：候选照常保留 + 问题条目随结果交付 + 永不签名 + 择优时排在干净候选之后。
function unsafeCheckpointInput(mutate) {
  const unsafe = structuredClone(proposal);
  mutate(unsafe);
  const reasoning = compileM04Proposal(unsafe, prior);
  return { reasoning, content: wrap(reasoning), priorReasoning: prior, clinicalContext: "食少倦怠；大便溏薄", generatorModel: "synthetic" };
}
test("a candidate that fails a deterministic contract is retained with findings, never signed", () => {
  for (const [label, mutate, expectCode] of [
    ["药典剂量越界", (value) => { value.candidate.herbs[0].dose = "500g"; }, /dose/],
    ["十八反", (value) => {
      value.candidate.herbs.push({ name: "海藻", dose: "10g", role: "佐", targetKind: "pathogenesis_node",
        targetRef: "P2", structureRole: null, function: "消痰软坚", processing: null, isToxic: false, decoctionRequirement: null });
    }, /incompatib/],
  ]) {
    const input = unsafeCheckpointInput(mutate);
    const checkpoint = retainM04DeliveryCheckpoint(undefined, input);
    assert.ok(checkpoint, `${label}: 候选必须被保留`);
    assert.equal(m04DeliveryCheckpointIsClean(checkpoint), false, `${label}: 必须标记为未通过合同`);
    assert.ok((checkpoint.contractIssues || []).length > 0, `${label}: 合同码必须落账`);
    assert.ok(m04DeliveryCheckpointFeedbackCodes(checkpoint).some((code) => expectCode.test(code)),
      `${label}: 回喂码必须包含真实问题`);
    assert.ok(m04DeliveryCheckpointSafetyFindingCount(checkpoint) > 0, `${label}: T1 计数必须非零`);
    const rendered = renderM04DeliveryCheckpoint(checkpoint, prior, "contract_rejected");
    assert.match(rendered, /党参/, `${label}: 药味必须对医生可见`);
    assert.match(rendered, /## 处方补充提示/, `${label}: 问题提示必须随结果交付`);
    assert.match(rendered, /尚未通过全部确定性校验/, `${label}: 不得冒充已通过校验`);
    assertNonDose(rendered);
    // 签名/背书通道对脏候选必须关闭——保留内容不等于「已复核通过」。
    const attestation = { status: "accepted", reviewedPayloadHash: clinicalReviewPayloadHash(input.reasoning),
      provider: "bailian-qwen", model: "qwen3.7-plus", source: "preferred" };
    const signed = applyPrescribeContractSignature(wrap({ ...input.reasoning, clinicalReview: attestation }), signatureContext);
    const bound = bindM04DeliveryReview(checkpoint, input.reasoning, accepted, attestation, signed);
    assert.equal(bound.signedContent, undefined, `${label}: 脏候选不得携带签名字节`);
    assert.equal(bound.attestation, undefined, `${label}: 脏候选不得绑定复核背书`);
    assertNonDose(renderM04DeliveryCheckpoint(bound, prior, "contract_rejected"));
    // 择优：干净候选永远胜过脏候选，与到达顺序无关。
    const clean = retainM04DeliveryCheckpoint(undefined, checkpointInput());
    assert.equal(preferM04DeliveryCheckpoint(clean, checkpoint), clean, `${label}: 脏候选不得顶掉干净候选`);
    assert.equal(preferM04DeliveryCheckpoint(checkpoint, clean), clean, `${label}: 干净候选后到也应胜出`);
  }
});
test("a route projection that rewrites the payload still retains the candidate", () => {
  // 2026-09-14 上线后首次实测（caseRef 223e2dd8b3d1）：候选已被路由终审投影改写
  //（确定性补写药味 function / 恢复受治理方名 / 归一化回写 sentinel），而调用方传进来的
  // reasoning 是投影**前**那份；旧的哈希一致性守卫直接 return previous，候选被静默丢弃，
  // 终审复核一翻成 repair 就落到 contract_rejected_no_valid_candidate、0 味。
  const input = checkpointInput();
  const projected = structuredClone(input.reasoning);
  projected.formula.candidates[0].herbs[0].function = "补脾益气（服务端补写）";
  // 正文按路由终审的真实形态重建：横幅 + 提示 + 重排版 sentinel。
  const content = `⚠️ 安全警示\n\n## 信息完整性边界\n提示\n\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(projected, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const checkpoint = retainM04DeliveryCheckpoint(undefined, { ...input, content });
  assert.ok(checkpoint, "投影改写载荷不得导致候选被丢弃");
  // content 与 reasoning 必须仍然同源——取的是 sentinel 那一份，不是调用方那份。
  assert.equal(checkpoint.payloadHash, clinicalReviewPayloadHash(projected));
  assert.equal(checkpoint.reasoning.formula.candidates[0].herbs[0].function, "补脾益气（服务端补写）");
  assert.match(renderM04DeliveryCheckpoint(checkpoint, prior, "contract_rejected"), /党参/);
  // 边界不放宽：sentinel 本身不是合法 prescribe 载荷时仍然丢弃。
  for (const bad of [
    `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe" })}\n<!-- DIAGNOSIS_JSON_END -->`,
    `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ ...projected, stage: "diagnose" })}\n<!-- DIAGNOSIS_JSON_END -->`,
    "<!-- DIAGNOSIS_JSON_START -->\n{not json\n<!-- DIAGNOSIS_JSON_END -->",
    "完全没有 sentinel 的正文",
  ]) {
    assert.equal(retainM04DeliveryCheckpoint(undefined, { ...input, content: bad }), undefined, "非法 sentinel 仍然丢弃");
  }
});
test("delivery ranking: signed > clean > fewer T1 > review status > fewer soft findings", () => {
  // 择优排序的**优先级**必须逐级钉住。preferM04DeliveryCheckpoint 只读
  // payloadHash / signedContent / contractIssues / findings / review，所以这里直接构造
  // 最小快照，把每一级单独隔离出来——用真实候选构造反而会让多级同时相等，测不出顺序。
  let seq = 0;
  const T1 = { code: "candidate_0_high_risk_pair_incompatibility", candidateIndex: 0, message: "m", suggestedAction: "a" };
  const T2 = { code: "candidate_0_herb_0_dose_reference_deviation", candidateIndex: 0, message: "m", suggestedAction: "a" };
  assert.equal(isSafetyClinicalDeliveryAdvisory(T1), true, "前提：T1 判据认得配伍禁忌");
  assert.equal(isSafetyClinicalDeliveryAdvisory(T2), false, "前提：剂量参考偏离是软性项");
  const mk = (over = {}) => ({ content: "c", reasoning: {}, payloadHash: `h${seq += 1}`, ...over });
  const beats = (winner, loser, why) => {
    assert.equal(preferM04DeliveryCheckpoint(winner, loser), winner, `${why}（先到）`);
    assert.equal(preferM04DeliveryCheckpoint(loser, winner), winner, `${why}（后到）`);
  };
  // ① 已签名优先于「问题更少但没签名」——否则医生会从剂量页掉回非剂量页。
  beats(mk({ signedContent: "signed", review: { status: "accepted" }, findings: [T2, T2] }),
        mk({ findings: [] }), "已签名剂量页不得被未签名候选挤掉");
  // ② 合同干净优先于带合同码，即便后者复核已通过。
  beats(mk({ findings: [] }),
        mk({ contractIssues: ["candidate_0_high_risk_pair_incompatibility"], findings: [T1], review: { status: "accepted" } }),
        "干净候选优先于带合同码候选");
  // ③ 同为带合同码时，T1 少者优先。
  beats(mk({ contractIssues: ["a"], findings: [T1] }),
        mk({ contractIssues: ["a", "b"], findings: [T1, T1] }), "T1 少者优先");
  // ④ 前三级相同的情况下才看复核状态。
  beats(mk({ findings: [], review: { status: "accepted" } }), mk({ findings: [] }), "复核 accepted 优先于未跑");
  // ⑤ 复核状态也相同时，软性问题少者优先。
  beats(mk({ findings: [], review: { status: "accepted" } }),
        mk({ findings: [T2, T2], review: { status: "accepted" } }), "软性问题少者优先");
  // 既有规则不变：同一份字节的更新复核结论直接生效。
  const bytes = mk({ review: { status: "accepted" } });
  const objection = { ...bytes, review: { status: "repair", issueCode: "dose_rationale_concern" } };
  assert.equal(preferM04DeliveryCheckpoint(bytes, objection), objection, "同一载荷的新复核结论直接生效");
});
test("dose withheld keeps the candidate visible and never emits the signed dose page", () => {
  const input = checkpointInput();
  const checkpoint = retainM04DeliveryCheckpoint(undefined, input);
  const attestation = { status: "accepted", reviewedPayloadHash: clinicalReviewPayloadHash(input.reasoning),
    provider: "bailian-qwen", model: "qwen3.7-plus", source: "preferred" };
  const signed = applyPrescribeContractSignature(wrap({ ...input.reasoning, clinicalReview: attestation }), signatureContext);
  const reviewed = bindM04DeliveryReview(checkpoint, input.reasoning, accepted, attestation, signed);
  assert.equal(renderM04DeliveryCheckpoint(reviewed, prior, "deadline"), signed, "其余原因下已签名剂量页照常交付");
  const withheld = renderM04DeliveryCheckpoint(reviewed, prior, "dose_withheld", ["儿童病例当前未配置可验证的个体化剂量规则"]);
  assert.notEqual(withheld, signed, "剂量轴收回时不得返回已签名剂量页");
  assertNonDose(withheld);
  assert.match(withheld, /党参/, "药味照常可见");
  assert.match(withheld, /儿童病例当前未配置可验证的个体化剂量规则/, "必须说明为什么不显示用量");
  const none = renderM04DeliveryCheckpoint(undefined, prior, "dose_withheld", ["已记录妊娠、哺乳或备孕阳性/可疑状态"]);
  assert.match(none, /已记录妊娠、哺乳或备孕阳性/, "无候选时同样要说明剂量轴原因");
});
test("only an exact completed attestation and signed payload can restore dose-level output", () => {
  const input = checkpointInput();
  const checkpoint = retainM04DeliveryCheckpoint(undefined, input);
  const attestation = { status: "accepted", reviewedPayloadHash: clinicalReviewPayloadHash(input.reasoning),
    provider: "bailian-qwen", model: "qwen3.7-plus", source: "preferred" };
  const signed = applyPrescribeContractSignature(wrap({ ...input.reasoning, clinicalReview: attestation }), signatureContext);
  const reviewed = bindM04DeliveryReview(checkpoint, input.reasoning, accepted, attestation, signed);
  assert.equal(renderM04DeliveryCheckpoint(reviewed, prior, "deadline"), signed);
  const unavailable = bindM04DeliveryReview(reviewed, input.reasoning, { status: "unavailable", reason: "deadline" });
  assert.equal(renderM04DeliveryCheckpoint(unavailable, prior, "deadline"), signed,
    "an unavailable repeat cannot erase an actually completed attestation");
  const newlyRejected = bindM04DeliveryReview(reviewed, input.reasoning, { status: "repair", issueCode: "dose_rationale_concern" });
  const newestEvidence = preferM04DeliveryCheckpoint(reviewed, newlyRejected);
  assert.match(renderM04DeliveryCheckpoint(newestEvidence, prior, "deadline"), /剂量强度/);
  assertNonDose(renderM04DeliveryCheckpoint(newestEvidence, prior, "deadline"));
  const later = checkpointInput(); later.reasoning.formula.candidates[0].formulaAnalysis += " 本例兼顾便溏。"; later.content = wrap(later.reasoning);
  assert.equal(retainM04DeliveryCheckpoint(reviewed, later), reviewed, "a pending later candidate cannot replace an attested result");
  assert.equal(bindM04DeliveryReview(checkpoint, later.reasoning, accepted, attestation, signed), checkpoint);
  const mismatch = bindM04DeliveryReview(checkpoint, input.reasoning, accepted, attestation, "WRONG_SIGNED_RESULT");
  assertNonDose(renderM04DeliveryCheckpoint(mismatch, prior, "deadline"));
  assert.doesNotMatch(renderM04DeliveryCheckpoint(mismatch, prior, "deadline"), /WRONG_SIGNED_RESULT/);
});

test("non-dose projection preserves measured and historical patient facts while masking proposed doses", () => {
  const input = checkpointInput();
  input.reasoning.formula.candidates[0].herbs[0].function = "补脾益气，拟用党参12g";
  input.content = wrap(input.reasoning);
  const checkpoint = retainM04DeliveryCheckpoint(undefined, input);
  assert.ok(checkpoint);
  const factualPrior = structuredClone(prior);
  const facts = ["血红蛋白58 g/L", "呕血约300mL", "既往口服二甲双胍500mg", "过敏史未提及"];
  factualPrior.pathogenesis.chain = facts.map((patientFact) => ({ ...prior.pathogenesis.chain[0], patientFact }));
  for (const candidate of [undefined, checkpoint]) {
    const output = renderM04DeliveryCheckpoint(candidate, factualPrior, "deadline");
    for (const fact of facts) assert.ok(output.includes(fact), `source fact must remain exact: ${fact}`);
    assert.doesNotMatch(output, /党参12g|无过敏史|否认过敏/);
    assert.ok(isNonDosePrescriptionText(output));
  }
  const unavailable = renderM04DeliveryCheckpoint(undefined, undefined, "deadline");
  assert.doesNotMatch(unavailable, /已完成的辨病辨证/);
  assert.match(unavailable, /没有可用.*辨病辨证/);
});

function assertConsumerReceivesSignedCandidate(result, dose) {
  // These are the actual consumer acceptance inputs: the transport marker can override a perfectly
  // parseable signed sentinel, so parsing alone is insufficient to demonstrate usable delivery.
  const transportIncomplete = result.content.includes("[TRUNCATED]") ||
    !result.content.includes("<!-- DIAGNOSIS_JSON_START -->") || !result.content.includes("<!-- DIAGNOSIS_JSON_END -->");
  const nonDose = isNonDosePrescriptionText(result.content);
  const reasoning = transportIncomplete ? undefined : parseReasoningV2(result.content);
  assert.equal(transportIncomplete, false, "preserved signed candidate must not become a manual-retry result");
  assert.equal(nonDose, false, "completed signed recovery must not be relabeled non-dose");
  assert.ok(reasoning?.contractSignature && hasBoundClinicalReviewAttestation(reasoning));
  assert.equal(reasoning.formula.candidates[0].herbs[0].dose, dose);
  assert.equal(reasoning.clinicalReview.status, "accepted");
  assert.equal(result.frames.filter((frame) => frame.content === "[END]").length, 1);
  assert.equal(result.finals.length, 1);
  assert.equal(result.telemetry.reviewStatus, "accepted", "delivery telemetry must refer to the recovered candidate");
  assert.ok(["success", "repaired"].includes(result.telemetry.outcome));
  assert.match(result.telemetry.reasonCode, /preserved_attested_candidate/);
}

test("final review rejection of a changed dose delivers the exact older signed candidate without truncation", async () => {
  let firstReviewReturned = false;
  const result = await runWire({
    respond: (number) => {
      if (number === 2) { firstReviewReturned = true; return accepted; }
      return { status: "repair", issueCode: "dose_rationale_concern", repairFocus: "dose_strength", candidateIndex: 0, implicatedHerbs: ["党参"] };
    },
    outputTransform: (content) => {
      if (!firstReviewReturned || !content.includes("<!-- DIAGNOSIS_JSON_START -->")) return content;
      const reasoning = parseReasoningV2(content);
      reasoning.formula.candidates[0].herbs[0].dose = "13g";
      return wrap(reasoning);
    },
  });
  assert.equal(result.requests.length, 3);
  assertConsumerReceivesSignedCandidate(result, "12g");
});

test("a final presentation-transform exception recovers the completed signed candidate", async () => {
  let firstReviewReturned = false;
  const result = await runWire({
    respond: () => { firstReviewReturned = true; return accepted; },
    outputTransform: (content) => {
      if (firstReviewReturned) throw new Error("synthetic late presentation failure");
      return content;
    },
  });
  assert.equal(result.requests.length, 2);
  assertConsumerReceivesSignedCandidate(result, "12g");
  assert.doesNotMatch(result.content, /GENERIC_KB_FALLBACK/);
});

test("a failed automatic provider repair preserves upstream attribution in normal fallback", async () => {
  const first = structuredClone(proposal);
  first.candidate.herbs[0].dose = "501g";
  const result = await runWire({ first, remainingMs: 50000, respond: () => new Response("synthetic unavailable", { status: 503 }) });
  assert.ok(result.requests.length >= 2 && result.requests.length <= 3);
  assertNonDose(result.content);
  assert.match(result.content, /模型服务暂时不可用/);
  assert.match(result.content, /尚未形成.*个体化/);
  assert.equal(result.telemetry.reasonCode, "upstream_model_unavailable");
  assert.equal(result.telemetry.outcome, "fallback");
  assert.equal(result.frames.filter((frame) => frame.content === "[END]").length, 1);
});
