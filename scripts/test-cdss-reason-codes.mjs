import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: true, alias: { "@": `${process.cwd()}/src` } });
const { CDSS_DEGRADE_REASON_CODES, cdssReasonCodeMarker, extractCdssReasonCode, reasonCodeRequiresM03Rerun } =
  await jiti.import("../src/lib/cdss-reason-codes.ts");
const { buildSafetyLimitedPrescription } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { prescribeRetryRequiresM03Rerun } = await jiti.import("../src/app/diagnosis/DiagnosisClient.tsx");

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
  assert.match(api, /retry_network_error", "retry_timeout_or_cancelled", "retry_http_error"/, "传输类失败码必须完整");
  assert.ok((api.match(/noteRepairOutcome\(/g) || []).length >= 4,
    "全部修复轮调用点都要记录结果(4处)");
  assert.doesNotMatch(api, /\{ content: opts\.truncateFallback \|\| "", ok:/,
    "降级页选择必须经 upstreamAwareTruncateFallback,不得直接用 truncateFallback");
  const route = fs.readFileSync(new URL("../src/app/api/diagnosis/diagnose/route.ts", import.meta.url), "utf8");
  assert.match(route, /upstreamUnavailableFallback:/, "路由必须提供专用降级页");
  assert.match(route, /这不是病历信息不足/, "文案必须显式澄清不是病历问题");
});

console.log(JSON.stringify({ cases, failures }));
if (failures > 0) process.exit(1);
