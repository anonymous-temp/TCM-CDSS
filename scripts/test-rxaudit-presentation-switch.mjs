/**
 * 审方是独立交付的接口与产品页面（owner 裁定 2026-08-28）；CDSS 默认不重复呈现三方审方内容。
 * 2026-09-25 起外部审方整体删除，呈现开关（CDSS_SHOW_RX_AUDIT_SECTION）随之删除，
 * 「关闭档」成为唯一档：M05 流恒带 DISABLED 标记，下面几条要求照旧成立。
 *
 * 原先这是**呈现**开关，不是检测开关。本套件要同时钉住两面：
 *   · 关闭时：报告/HIS/页面不出现任何以三方审方为主语的内容（结论、范围、输入待核对、
 *     以及「自动审方未完成」这类状态）；
 *   · 关闭时：本地确定性检测照出且**照进 HIS**。这一条是本次改动最容易漏的地方，
 *     实测过三个坑：
 *       ① M05 里那段本地高危药对原本挂在 `providerAudit.ok ? "" : ...` 上——那个条件的原意是
 *          「审方没给结论时用本地兜底」，展示关闭后若沿用，审方正常返回的病例一条本地提示都没有；
 *       ② 段名「生成前配伍预检提示」此前不在任何 sectionTitleGroup 里，his-scheme 的 section()
 *          只认二级标题精确匹配，不登记就被整段丢掉，HIS 侧配伍内容归零；
 *       ③ HIS 的 deterministicRisk 在取不到审方段时会回落成「本次未获得自动审方结果」，
 *          既把三方审方重新写回交付面，又与事实相反（审方照常调用，只是不在本产品呈现）。
 *   · 「展示关闭」与「审方不可用」对医生的含义完全相反，必须能被下游区分：不区分就会在
 *     每一例上把 M05 标成受限并报「审方服务暂不可用」。
 */
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const { RXAUDIT_DISABLED_STATUS_MARKER, parseRxAuditStatusMarker, stripRxAuditStatusMarker } =
  await jiti.import("../src/lib/rxaudit-status.ts");
const { resolveAuditReviewPresentation } = await jiti.import("../src/lib/result-display-policy.ts");
const { sectionTitleGroup } = await jiti.import("../src/lib/cdss-vocab.ts");
const { section } = await jiti.import("../src/lib/his-scheme.ts");

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; console.log(`  ✓ ${label}`); };

// ── 1. 状态契约：三档必须互相可分
check("DISABLED 与 UNAVAILABLE 是两档，不可互相折叠", () => {
  // 服务端只再产出 DISABLED；另外两档来自旧会话里已落盘的流文本，解析必须保持。
  const disabled = RXAUDIT_DISABLED_STATUS_MARKER;
  const unavailable = "<!-- TCM_CDSS_RXAUDIT_STATUS:UNAVAILABLE:SERVICE_UNAVAILABLE -->";
  const available = "<!-- TCM_CDSS_RXAUDIT_STATUS:AVAILABLE -->";
  assert.notEqual(disabled, unavailable);
  assert.deepEqual(parseRxAuditStatusMarker(disabled), { available: false, presentationDisabled: true });
  assert.deepEqual(parseRxAuditStatusMarker(unavailable), { available: false, reason: "service_unavailable" });
  assert.deepEqual(parseRxAuditStatusMarker(available), { available: true });
  assert.equal(stripRxAuditStatusMarker(`${disabled}\n## 生成前配伍预检提示`), "## 生成前配伍预检提示");
});
check("既有两档解析逐字不变（不得借本次改动改口径）", () => {
  assert.deepEqual(
    parseRxAuditStatusMarker("<!-- TCM_CDSS_RXAUDIT_STATUS:UNAVAILABLE:NO_PRESCRIPTION_ITEMS -->"),
    { available: false, reason: "no_prescription_items" },
  );
});

// ── 2. 呈现层：关闭档不出审方卡片，不可用档照旧出
check("展示关闭时不渲染审方卡片", () => {
  assert.equal(resolveAuditReviewPresentation({ available: false, presentationDisabled: true }, "任意内容"), null);
});
check("真·审方不可用仍必须显著提示（不得被本次改动顺带静音）", () => {
  const presentation = resolveAuditReviewPresentation({ available: false }, "");
  assert.equal(presentation?.kind, "unavailable");
  assert.match(presentation?.title || "", /未完成/);
});

// ── 3. 本地确定性段必须能被 HIS 抓到（关闭档下它是 HIS 唯一的配伍来源）
check("「生成前配伍预检提示」已登记且能被 his-scheme 的 section() 抓出", () => {
  const titles = sectionTitleGroup("compatibilityRisk");
  assert.ok(titles.includes("生成前配伍预检提示"), `未登记：${JSON.stringify(titles)}`);
  const risk = "## 生成前配伍预检提示\n- **甘草 × 海藻**：命中十八反。\n\n## 随访管理方案\n一周后复诊。";
  const extracted = section(risk, titles);
  assert.match(extracted, /甘草/);
  assert.doesNotMatch(extracted, /随访管理方案/, "段落边界越界，抓进了下一段");
});

// ── 4. 接线：开关已删除，关闭档是唯一档
const { readFileSync } = await import("node:fs");
const assess = readFileSync(new URL("../src/app/api/diagnosis/assess/route.ts", import.meta.url), "utf8");
const his = readFileSync(new URL("../src/lib/his-scheme.ts", import.meta.url), "utf8");

check("M05 流恒带 DISABLED 标记，报告只拼本地段", () => {
  assert.match(assess, /joinedWarningProjections\(\[RXAUDIT_DISABLED_STATUS_MARKER, /);
  const report = assess.slice(assess.indexOf("const postPrescriptionRisk"), assess.indexOf("const prescriptionHash"));
  assert.ok(report.length > 0 && report.length < 400, `报告拼接边界切过头（${report.length}）`);
  assert.match(report, /\[localHighRiskSection, retainedRiskSection, inputAdvisorySection\]/, "报告必须仍含本地配伍段、已证明严重风险段与病历质量段");
  for (const audited of ["buildRxAuditScopeSection", "providerRisk", "buildLingxiRiskSection", "buildUnavailableRxAuditSection"]) {
    assert.equal(assess.includes(audited), false, `M05 仍拼入了三方审方内容：${audited}`);
  }
});
check("HIS 不再回落成「本次未获得自动审方结果」，开关 env 名不再出现", () => {
  assert.equal(his.includes("missingMedicationAuditSection"), false);
  assert.equal(his.includes("本次未获得自动审方结果"), false);
  for (const source of [assess, his]) assert.equal(source.includes("CDSS_SHOW_RX_AUDIT_SECTION"), false);
});

// ── 5. 病历质量提示：唯一档用中性口径
const { buildPrescriptionInputAdvisorySection } = await jiti.import("../src/lib/local-prescription-checks.ts");
check("病历质量提示照出，且不再让医生去「重新审方」", () => {
  const advisories = [{ code: "medication_semantics_incomplete", itemNo: 0, drugName: "现用药", message: "现用药信息明确不详或尚未核实，联用风险必须结合原文人工核对" }];
  const neutral = buildPrescriptionInputAdvisorySection(advisories);
  assert.match(neutral, /处方信息待核对/);
  assert.match(neutral, /现用药信息明确不详或尚未核实/, "病历质量事实本身不得删改");
  assert.doesNotMatch(neutral, /审方/, `口径仍提到审方：${neutral}`);
  assert.match(neutral, /不得视为已排除/, "必须仍然明说「未核实 ≠ 无风险」");
});
check("病历质量段已登记，HIS 侧拿得到", () => {
  const titles = sectionTitleGroup("recordQualityRisk");
  assert.ok(titles.includes("处方信息待核对"), `未登记：${JSON.stringify(titles)}`);
  const extracted = section("## 处方信息待核对\n- 现用药不详。\n\n## 随访管理方案\n一周后复诊。", titles);
  assert.match(extracted, /现用药不详/);
  assert.doesNotMatch(extracted, /随访管理方案/, "段落边界越界");
});

console.log(`\n审方呈现开关：${checks} 项断言全部通过`);
