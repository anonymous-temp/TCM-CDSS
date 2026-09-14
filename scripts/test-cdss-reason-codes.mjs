import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: true, alias: { "@": `${process.cwd()}/src` } });
const { CDSS_DEGRADE_REASON_CODES, cdssReasonCodeMarker, extractCdssReasonCode, reasonCodeRequiresM03Rerun } =
  await jiti.import("../src/lib/cdss-reason-codes.ts");
const { buildSafetyLimitedPrescription } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { prescribeRetryRequiresM03Rerun } = await jiti.import("../src/app/diagnosis/DiagnosisClient.tsx");
const { renderM04DeliveryCheckpoint, retainM04DeliveryCheckpoint } = await jiti.import("../src/lib/m04-delivery-checkpoint.ts");
const { compileM04Proposal } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");
const deliveryPrior = ReasoningV2Schema.parse({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { primarySyndrome: "脾胃虚弱证", overallPathogenesis: "脾胃虚弱，运化无力", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [
    { nodeId: "P1", patientFact: "食少倦怠", syndromeEvidence: "食少倦怠", pathogenesis: "脾胃虚弱，运化无力", therapyDirection: "健脾益气" },
    { nodeId: "P2", patientFact: "大便溏薄", syndromeEvidence: "大便溏薄", pathogenesis: "脾虚湿盛", therapyDirection: "健脾化湿" },
  ] },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "健脾益气，化湿和中", subTherapies: [{ therapy: "健脾益气", targetPathogenesis: "脾胃虚弱", priority: "主要" }] },
  formula: { candidates: [], patentAndWestern: [], modifications: [] },
});
const deliveryReasoning = compileM04Proposal({
  candidate: {
    name: "本例辨证组方", applicable: "食少倦怠与便溏并见。", notApplicable: "便溏加重或出现腹痛时评估。",
    herbs: [
      { name: "党参", dose: "12g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "补脾益气，改善食少倦怠" },
      { name: "白术", dose: "10g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾燥湿，兼顾便溏" },
      { name: "茯苓", dose: "12g", role: "佐", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾渗湿" },
      { name: "炙甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "补脾和胃" },
    ].map((herb) => ({ ...herb, processing: null, isToxic: false, decoctionRequirement: null })),
    formulaAnalysis: "党参补脾益气以改善食少倦怠，白术燥湿、茯苓渗湿兼顾便溏，炙甘草补脾和胃。",
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，煎服", followUpNode: "5日复诊" },
  },
  patentAndWestern: [], modifications: [],
  nonPharma: { diet: "早餐可用山药小米粥，少量多餐。", lifestyle: "规律作息。", emotion: "调畅情志。", precautions: ["观察食欲与便溏变化。"], tcmTreatments: [] },
}, deliveryPrior);
const deliveryCheckpoint = retainM04DeliveryCheckpoint(undefined, {
  reasoning: deliveryReasoning,
  content: `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(deliveryReasoning)}\n<!-- DIAGNOSIS_JSON_END -->`,
  priorReasoning: deliveryPrior, clinicalContext: "食少倦怠；大便溏薄", generatorModel: "synthetic",
});

let cases = 0; let failures = 0;
const check = (name, fn) => { cases += 1; try { fn(); } catch (e) { failures += 1; console.error("FAIL", name, e?.message); } };

// 码表往返: 每个码的标记都能被提取回原码
check("marker round-trip for every code", () => {
  for (const code of CDSS_DEGRADE_REASON_CODES) {
    assert.equal(extractCdssReasonCode(`前文\n${cdssReasonCodeMarker(code)}\n后文`), code);
  }
  assert.equal(extractCdssReasonCode("没有标记的文本"), undefined);
  assert.equal(extractCdssReasonCode("<!-- CDSS_REASON_CODE:not_in_table -->"), undefined, "表外码必须拒识");
});

// 降级页构造器嵌码
const gate = {
  status: "needs_information", allowDiagnosis: true, allowDosePrescription: false,
  action: "complete_before_prescription", missingItems: ["M03辨病辨证结果"], redFlags: [],
  reasons: ["缺少有效的西医诊断、中医证候与病机关联结果，不能直接生成剂量级候选处方。"],
};
check("buildSafetyLimitedPrescription 嵌入机器码且保留非剂量标记", () => {
  const page = buildSafetyLimitedPrescription(gate, "m03_unstable");
  assert.ok(page.includes("<!-- CDSS_NON_DOSE_PRESCRIPTION -->"));
  assert.equal(extractCdssReasonCode(page), "m03_unstable");
  const withoutCode = buildSafetyLimitedPrescription(gate);
  assert.equal(extractCdssReasonCode(withoutCode), undefined, "不传码时不嵌标记(兼容既有路径)");
});

// 分流语义: M03 级码 → 从辨证重跑; M04 级码 → 原地重试
check("reasonCodeRequiresM03Rerun 分流语义", () => {
  for (const code of ["m03_unstable", "m03_signature_missing", "semantic_review_unfinished", "completeness_below_c"]) {
    assert.equal(reasonCodeRequiresM03Rerun(code), true, code);
  }
  for (const code of ["m04_truncated_no_candidate", "deterministic_reference", "safety_gate_blocked", "formula_dose_boundary_unavailable"]) {
    assert.equal(reasonCodeRequiresM03Rerun(code), false, code);
  }
});

// 前端谓词: 码优先于文案正则; 文案改写不影响分流; 存量无码病例回退正则
check("前端按码分流,文案自由改写", () => {
  const page = buildSafetyLimitedPrescription(gate, "m03_unstable")
    .replace("缺少有效的西医诊断、中医证候与病机关联结果", "服务端换了一种全新说法");
  assert.equal(
    prescribeRetryRequiresM03Rerun({ lastError: undefined, prescription: page }),
    true,
    "文案整段改写后,码仍驱动 M03 级重跑",
  );
  const m04Page = buildSafetyLimitedPrescription(gate, "m04_truncated_no_candidate");
  assert.equal(
    prescribeRetryRequiresM03Rerun({ lastError: undefined, prescription: m04Page }),
    false,
    "M04 级码不得触发辨证级清场",
  );
  assert.equal(
    prescribeRetryRequiresM03Rerun({ lastError: undefined, prescription: "……辨证语义复核未完成……" }),
    true,
    "存量无码病例回退旧文案正则",
  );
});


// UPSTREAM-01 服务故障 ≠ 临床证据不足(2026-08-04 生产实测:上游非流式端点 503 期间
// 甲方10例有9例显示「当前证候依据不足」——把外部依赖故障说成了临床结论,医生会误以为
// 病历不充分而去补录。两者的处置完全不同:前者重试即可,后者重试无用。)
check("upstream_model_unavailable 码存在且不触发辨证级重跑", () => {
  assert.ok(CDSS_DEGRADE_REASON_CODES.includes("upstream_model_unavailable"));
  assert.equal(reasonCodeRequiresM03Rerun("upstream_model_unavailable"), false,
    "服务故障应原地重试,不必清场重跑辨证");
  assert.equal(extractCdssReasonCode(cdssReasonCodeMarker("upstream_model_unavailable")), "upstream_model_unavailable");
});
check("流层与路由的传输失败接线", () => {
  const api = fs.readFileSync(new URL("../src/lib/diagnosis-api.ts", import.meta.url), "utf8");
  assert.match(api, /upstreamUnavailableFallback\?: string;/, "opts 必须暴露专用降级页");
  assert.match(api, /const noteRepairOutcome = \(result:/, "必须记录修复轮失败性质");
  assert.match(api, /let initialGenerationFailedOnTransport = false;/, "必须单独记录首轮生成的传输失败");
  assert.match(api, /initialGenerationFailedOnTransport \|\| repairFailedOnTransport/,
    "上游感知降级页必须同时覆盖首轮与修复轮传输失败");
  assert.match(api, /result\.reason === "retry_network_error" \|\| result\.reason === "retry_empty_content"/,
    "网络失败与空响应必须进入上游不可用分类");
  assert.match(api, /result\.reason === "retry_http_error" && isRetryableProviderHttpStatus\(result\.status\)/,
    "HTTP 错误必须经可重试状态白名单，不得把 4xx 整类当成上游不可用");
  assert.doesNotMatch(api, /\["retry_network_error"[^\]]*"retry_budget_exhausted"/,
    "预算耗尽不得混入上游传输失败白名单");
  assert.ok((api.match(/noteRepairOutcome\(/g) || []).length >= 4,
    "全部修复轮调用点都要记录结果(4处)");
  assert.doesNotMatch(api, /\{ content: opts\.truncateFallback \|\| "", ok:/,
    "降级页选择必须经 upstreamAwareTruncateFallback,不得直接用 truncateFallback");
  assert.match(api, /const orchestrationDeadlineExceeded = m03DeadlineExceeded \|\| m04DeadlineExceeded;[\s\S]{0,260}const fallback = orchestrationDeadlineExceeded[\s\S]{0,180}upstreamAwareTruncateFallback\(\)/,
    "外层 provider catch 必须按 deadline > upstream > contract 选择签名页");
  const route = fs.readFileSync(new URL("../src/app/api/diagnosis/diagnose/route.ts", import.meta.url), "utf8");
  assert.match(route, /upstreamUnavailableFallback:/, "路由必须提供专用降级页");
  assert.match(route, /这不是病历信息不足/, "文案必须显式澄清不是病历问题");
});

// ── 交付连续性页的机器码（2026-09-13）──────────────────────────────────────────
// renderM04DeliveryCheckpoint 产出的这一整类非剂量页此前**不带任何 reasonCode**，
// 前端只能靠文案正则分流；而三种处置的恢复动作完全不同：保留候选可原地重试 M04，
// 剂量轴收回则原地重试必然同结果，必须先解除边界。
check("delivery continuity pages carry their own machine code", () => {
  for (const [reason, expected] of [
    ["contract_rejected", "m04_candidate_retained_non_dose"],
    ["deadline", "m04_truncated_no_candidate"],
    ["upstream_unavailable", "upstream_model_unavailable"],
    ["dose_withheld", "dose_authorization_withheld"],
  ]) {
    const withCandidate = renderM04DeliveryCheckpoint(deliveryCheckpoint, undefined, reason, ["占位原因"]);
    const withoutCandidate = renderM04DeliveryCheckpoint(undefined, undefined, reason, ["占位原因"]);
    assert.equal(extractCdssReasonCode(withCandidate),
      reason === "contract_rejected" || reason === "deadline" ? "m04_candidate_retained_non_dose" : expected,
      `保留候选时 ${reason} 的机器码`);
    assert.equal(extractCdssReasonCode(withoutCandidate),
      reason === "upstream_unavailable" ? "upstream_model_unavailable"
        : reason === "dose_withheld" ? "dose_authorization_withheld" : "m04_truncated_no_candidate",
      `无候选时 ${reason} 的机器码`);
  }
  // 这两个码都是 M04 级：重试不得被升级成从辨证重跑。
  for (const code of ["m04_candidate_retained_non_dose", "dose_authorization_withheld"]) {
    assert.equal(reasonCodeRequiresM03Rerun(code), false, `${code} 属 M04 级恢复`);
    assert.equal(prescribeRetryRequiresM03Rerun({ prescription: cdssReasonCodeMarker(code) }), false,
      `${code} 不得触发 M03 重跑`);
  }
});
console.log(JSON.stringify({ cases, failures }));
if (failures > 0) process.exit(1);
