/**
 * 审方是独立交付的接口与产品页面（owner 裁定 2026-08-28）；CDSS 默认不重复呈现三方审方内容。
 *
 * 这是**呈现**开关，不是检测开关。本套件要同时钉住两面：
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
const { buildRxAuditStatusMarker, parseRxAuditStatusMarker, stripRxAuditStatusMarker } =
  await jiti.import("../src/lib/rxaudit-status.ts");
const { resolveAuditReviewPresentation } = await jiti.import("../src/lib/result-display-policy.ts");
const { sectionTitleGroup } = await jiti.import("../src/lib/cdss-vocab.ts");
const { section } = await jiti.import("../src/lib/his-scheme.ts");

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; console.log(`  ✓ ${label}`); };

// ── 1. 状态契约：三档必须互相可分
check("DISABLED 与 UNAVAILABLE 是两档，不可互相折叠", () => {
  const disabled = buildRxAuditStatusMarker({ available: false, presentationDisabled: true });
  const unavailable = buildRxAuditStatusMarker({ available: false, reason: "service_unavailable" });
  const available = buildRxAuditStatusMarker({ available: true });
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

// ── 4. 接线：开关是单一权威，且只管呈现
const { readFileSync } = await import("node:fs");
const assess = readFileSync(new URL("../src/app/api/diagnosis/assess/route.ts", import.meta.url), "utf8");
const rxaudit = readFileSync(new URL("../src/lib/rxaudit.ts", import.meta.url), "utf8");
const his = readFileSync(new URL("../src/lib/his-scheme.ts", import.meta.url), "utf8");

check("开关只有一处定义，读 env 的地方也只有一处", () => {
  assert.equal((rxaudit.match(/export function rxAuditPresentationEnabled/g) || []).length, 1);
  const envReads = (rxaudit.match(/CDSS_SHOW_RX_AUDIT_SECTION/g) || []).length
    + (assess.match(/CDSS_SHOW_RX_AUDIT_SECTION/g) || []).length
    + (his.match(/CDSS_SHOW_RX_AUDIT_SECTION/g) || []).length;
  assert.equal(envReads, 1, `env 名散落成 ${envReads} 处，两处会分叉`);
});
check("本地高危药对不再挂在 providerAudit.ok 上", () => {
  assert.ok(!/const localUnavailableRisk = providerAudit\.ok \? "" : buildLocalHighRiskHerbPairSection/.test(assess),
    "仍沿用旧条件：审方正常返回的病例将看不到任何本地配伍提示");
  assert.ok(/const localHighRiskSection = buildLocalHighRiskHerbPairSection\(/.test(assess),
    "本地配伍段未被无条件计算");
  const disabledBranch = assess.slice(assess.indexOf("const postPrescriptionRisk"), assess.indexOf("const auditStatusMarker"));
  assert.ok(disabledBranch.length > 0 && disabledBranch.length < 900, `分支边界切过头（${disabledBranch.length}）`);
  // 关闭档的数组字面量单独取出来判，别让「少了本地段」和「多了审方内容」共用一条断言——
  // 否则往数组里多塞一个审方项时，先炸的是前一条，后一条永远空转。
  const disabledArray = disabledBranch.slice(disabledBranch.lastIndexOf(": ["));
  assert.ok(disabledArray.startsWith(": [") && disabledArray.includes("]"), "未取到关闭档数组字面量");
  const disabledItems = disabledArray.slice(3, disabledArray.indexOf("]"));
  assert.ok(disabledItems.includes("localHighRiskSection"), "关闭档未保留本地配伍段");
  // 病历质量提示（现用药无法可靠结构化 / 候选缺剂量）不是三方审方结论，关闭档必须保留，
  // 且要用审方中性口径。2026-08-28 首版把它一并撤掉了，被 test:rxaudit-routes 抓出来。
  assert.ok(/buildAuditInputAdvisorySection\(inputAdvisories, true\)/.test(disabledItems),
    "关闭档丢掉了病历质量提示：把「现用药不明」这类未知当成了无风险");
  for (const audited of ["buildRxAuditScopeSection", "providerRisk"]) {
    assert.equal(disabledItems.includes(audited), false, `关闭档仍拼入了三方审方内容：${audited}`);
  }
});
check("HIS 不再回落成「本次未获得自动审方结果」", () => {
  assert.ok(/rxAuditPresentationEnabled\(\) \? missingMedicationAuditSection\(\)/.test(his),
    "HIS 的审方回落未受开关门控");
});

// ── 5. 病历质量提示:两档都必须出，只是口径不同
const { buildAuditInputAdvisorySection } = await jiti.import("../src/lib/rxaudit.ts");
check("病历质量提示两档都出，关闭档不再让医生去「重新审方」", () => {
  const advisories = [{ code: "medication_semantics_incomplete", itemNo: 0, drugName: "现用药", message: "现用药时间线或指代未能可靠结构化，联用风险需结合原始用药史人工核对" }];
  const audited = buildAuditInputAdvisorySection(advisories);
  const neutral = buildAuditInputAdvisorySection(advisories, true);
  for (const text of [audited, neutral]) {
    assert.match(text, /处方信息待核对/);
    assert.match(text, /现用药时间线或指代未能可靠结构化/, "病历质量事实本身在任一档都不得删改");
  }
  assert.match(audited, /重新审方/);
  assert.doesNotMatch(neutral, /审方/, `关闭档口径仍提到审方：${neutral}`);
  assert.match(neutral, /不得视为已排除/, "关闭档必须仍然明说「未核实 ≠ 无风险」");
});
check("病历质量段已登记，HIS 侧拿得到", () => {
  const titles = sectionTitleGroup("recordQualityRisk");
  assert.ok(titles.includes("处方信息待核对"), `未登记：${JSON.stringify(titles)}`);
  const extracted = section("## 处方信息待核对\n- 现用药不详。\n\n## 随访管理方案\n一周后复诊。", titles);
  assert.match(extracted, /现用药不详/);
  assert.doesNotMatch(extracted, /随访管理方案/, "段落边界越界");
});

console.log(`\n审方呈现开关：${checks} 项断言全部通过`);
