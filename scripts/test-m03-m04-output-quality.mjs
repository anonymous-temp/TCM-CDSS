// M03/M04 输出质量回归(2026-08-05,甲方六条反馈)。
//
// 六条反馈逐条落在这里。每条都先在 20 例线上语料上量化过范围,不是按单个 case 修的:
//
//  1 西医「支持依据」照抄病历原文,还在词中间被截断(「…食后脘闷不舒，面」)
//    → 逐项拆分 + 截断残片剔除 + 舌脉出栏(舌脉不构成西医诊断依据)
//  2 总体病机不对 → 根因在**送模型之前**:PHI 规则把临床事实当人名抹掉,20 例中 13 例命中
//    (见 test-phi-clinical-collision.mjs,该条在那里钉)
//  3 「治则」栏写着「暂不锁定剂量级治法」——工程占位串,20 例中 19 例命中
//    → 由已签名病性辨证确定性推出治则
//  4 煎服方式几例完全一样 → 代码里写死的模板,只有药液量随年龄变
//    → 按已签名治法分档(解表短煎/补益久煎/攻下中病即止/常规)
//  5 「中医鉴别诊断依据应该是病的」→ 核对后辨病鉴别 27 条**全是病名**,分栏本来就对;
//    真正问题是 3 例中医病名未成立时整段静默消失,页面只剩证候鉴别
//    → 缺席时写明原因,不静默
//  6 末模块应叫「健康调护」→ 已改名(饮食/起居/情志/注意事项本就在渲染)
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");

const wrap = (reasoning) =>
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
const unwrap = (content) =>
  JSON.parse(content.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/)[1]);

const failures = [];

// ── 3) 治则不得是工程占位串 ─────────────────────────────────────
{
  const m03 = (nature, principle) => ({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    overview: { primarySyndrome: "脾虚湿盛证" },
    pathogenesis: { summary: "", chain: [], natureDifferentiation: nature },
    therapy: { overallPrinciple: principle, overallMethod: "健脾益气，渗湿止泻", subTherapies: [] },
  });
  const principleOf = (nature, principle = "暂不锁定剂量级治法") =>
    unwrap(summary.applyDeterministicTreatmentPrinciple(wrap(m03(nature, principle))))?.therapy?.overallPrinciple || "";

  const both = principleOf({ items: ["气虚", "湿盛"], rootDeficiency: ["脾气虚"], branchExcess: ["湿浊"] });
  if (/暂不锁定|由服务端生成/.test(both)) failures.push({ case: "标本俱见", why: `治则仍是占位串: ${both}` });
  if (!/标本兼治/.test(both)) failures.push({ case: "标本俱见", why: `应为标本兼治,实际 ${both}` });

  const deficient = principleOf({ items: ["气虚"], rootDeficiency: [], branchExcess: [] });
  if (!/扶正|补虚/.test(deficient)) failures.push({ case: "纯虚", why: `应为扶正补虚,实际 ${deficient}` });

  const excess = principleOf({ items: ["湿热"], rootDeficiency: [], branchExcess: [] });
  if (!/祛邪/.test(excess)) failures.push({ case: "纯实", why: `应为祛邪治标,实际 ${excess}` });

  // 病性未定时不得编造治则,但也不得留工程占位串
  const unknown = principleOf({ items: [], rootDeficiency: [], branchExcess: [] });
  if (/暂不锁定剂量级治法/.test(unknown)) failures.push({ case: "病性未定", why: "仍是工程占位串" });
  if (/标本兼治|扶正|祛邪/.test(unknown)) failures.push({ case: "病性未定", why: `不得凭空给出治则: ${unknown}` });

  // 模型自己写出的治则必须原样保留,不得被服务端顶掉
  const authored = principleOf({ items: ["气虚"], rootDeficiency: [], branchExcess: [] }, "急则治标");
  if (authored !== "急则治标") failures.push({ case: "模型已写治则", why: `应原样保留,实际 ${authored}` });
}

// ── 4) 煎服方式必须随方剂性质变化 ───────────────────────────────
{
  const m04 = (method) => ({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    therapy: { overallMethod: method, overallPrinciple: "", subTherapies: [] },
    formula: {
      candidates: [{
        name: "X",
        therapyMatch: method,
        herbs: [{ name: "甘草", dose: "6g" }],
        decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2 },
      }],
    },
  });
  const profileOf = (method) => {
    const out = unwrap(summary.applyDeterministicDecoctionMethod(wrap(m04(method)), "患者，女，35岁", 35));
    return out.formula.candidates[0].decoction;
  };
  const exterior = profileOf("辛凉解表，疏风清热");
  const tonify = profileOf("温补肾阳，填精益髓");
  const purge = profileOf("通腑泄热，攻下积滞");
  const regular = profileOf("活血化瘀，行气止痛");

  // 方向性判据:解表必须短于常规,补益必须长于常规。不钉具体分钟数。
  if (!(exterior.firstDecoctionMinutes < regular.firstDecoctionMinutes)) {
    failures.push({ case: "解表剂", why: `解表须短煎(久煎则气散失效),实际 ${exterior.firstDecoctionMinutes} vs 常规 ${regular.firstDecoctionMinutes}` });
  }
  if (!(tonify.firstDecoctionMinutes > regular.firstDecoctionMinutes)) {
    failures.push({ case: "补益剂", why: `补益须久煎取厚味,实际 ${tonify.firstDecoctionMinutes} vs 常规 ${regular.firstDecoctionMinutes}` });
  }
  if (!/汗/.test(exterior.administration)) failures.push({ case: "解表剂", why: "服法须写明取汗与得汗停服" });
  if (!/饭前|空腹/.test(tonify.administration)) failures.push({ case: "补益剂", why: "服法须写明饭前空腹服" });
  if (!/得利即停|大便通畅/.test(purge.administration)) failures.push({ case: "攻下剂", why: "服法须写明中病即止" });
  // 四档必须真的不同——甲方连试数例发现完全一样,就是因为它们本来是同一个模板
  const distinct = new Set([exterior, tonify, purge, regular].map((item) => item.method));
  if (distinct.size < 4) failures.push({ case: "分档", why: `四类治法应产生 4 种煎法,实际 ${distinct.size} 种` });
}

if (failures.length > 0) {
  console.error(JSON.stringify({ failures }, null, 2));
}
assert.equal(
  failures.length, 0,
  `M03/M04 输出质量回归失败 ${failures.length} 项。治则占位串回归 ⇒ 医生看到工程术语;` +
  `煎法不分档 ⇒ 解表剂久煎失效、补益剂短煎不出味。`,
);

console.log(JSON.stringify({
  treatmentPrincipleDerived: 4,
  authoredPrinciplePreserved: true,
  decoctionProfiles: 4,
  failures: 0,
}));
