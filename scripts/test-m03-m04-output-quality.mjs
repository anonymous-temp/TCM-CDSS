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
// 2026-10-13 改口径（甲方 10.12 测评 3.1）：治则只写国标治则术语（GB/T 16751.3 治则类），由已定的证名与治法推出，
// 不再读 natureDifferentiation.items（模型在实证里顺手列一个「脾虚」就成了扶正祛邪），也不再保留「治病求本」等总纲。
{
  const m03 = (syndrome, method, principle) => ({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    overview: { primarySyndrome: syndrome },
    pathogenesis: { summary: "", chain: [], natureDifferentiation: { items: [], rootDeficiency: [], branchExcess: [] } },
    therapy: { overallPrinciple: principle, overallMethod: method, subTherapies: [] },
  });
  const principleOf = (syndrome, method, principle = "暂不锁定剂量级治法") =>
    unwrap(summary.applyDeterministicTreatmentPrinciple(wrap(m03(syndrome, method, principle))))?.therapy?.overallPrinciple || "";

  const both = principleOf("脾虚湿盛证", "健脾益气，渗湿止泻");
  if (/暂不锁定|由服务端生成/.test(both)) failures.push({ case: "标本俱见", why: `治则仍是占位串: ${both}` });
  if (both !== "扶正祛邪") failures.push({ case: "标本俱见", why: `虚实夹杂应为扶正祛邪,实际 ${both}` });

  const deficient = principleOf("脾气虚证", "健脾益气");
  if (deficient !== "虚则补之") failures.push({ case: "纯虚", why: `应为虚则补之,实际 ${deficient}` });

  const excess = principleOf("湿热蕴结证", "清热利湿");
  if (excess !== "热者寒之") failures.push({ case: "纯实", why: `热证应为热者寒之,实际 ${excess}` });

  const stagnation = principleOf("肝气犯胃证", "疏肝理气，和胃止痛");
  if (stagnation !== "实则泻之") failures.push({ case: "气滞实证", why: `应为实则泻之,实际 ${stagnation}` });

  // 证名与治法都推不出虚实寒热时不得留工程占位串,也不凭空下补泻:用最中性的国标治则
  const unknown = principleOf("", "");
  if (/暂不锁定剂量级治法/.test(unknown)) failures.push({ case: "病性未定", why: "仍是工程占位串" });
  if (/扶正|祛邪|补之|泻之|热之|寒之/.test(unknown)) failures.push({ case: "病性未定", why: `不得凭空给出补泻寒热: ${unknown}` });

  // 模型另写的与虚实寒热无关的国标治则（急则治标）保留为第二条;括号与治法内容一律不进治则
  const authored = principleOf("脾气虚证", "健脾益气", "急则治标");
  if (authored !== "虚则补之，急则治标") failures.push({ case: "模型已写治则", why: `应为「虚则补之，急则治标」,实际 ${authored}` });
  const bracketed = principleOf("胃火上炎证", "清胃泻火，凉血止痛", "实则泻之（清泻胃火） 兼以通腑导热");
  if (/[（(]|通腑|兼以/.test(bracketed)) failures.push({ case: "括号与治法内容", why: `治则不得带括号或治法内容: ${bracketed}` });
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
