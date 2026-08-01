/**
 * Invariant: 同证异名在特征层确定性等同；极性与脏腑边界一票否决；稀疏/混合极性条目 fail-closed。
 *
 * 问题的类：GB/T 16751.2 给临床同一个证收了多个独立条目（心虚胆怯/心胆气虚、肝气犯胃/肝胃不和、
 * 胃火上炎/胃火炽盛…）。模型写其一、方剂目录标其二，id 对不上 ⇒ 方永远锁不住。逐对补别名不可
 * 扩展——10 例病历撞 5 对，1 万例会撞几百对。
 *
 * 根源解法：等同建立在词表自带的国标结构化特征上（病位×病性，非文本相似度），新增条目自动纳入。
 * 本文件锁四个面：真同义打通、危险边界拒绝、fail-closed 参与门槛、检索层端到端一致。
 * 负例清单每一条都来自实测抓到的误并（宽松版曾把 风邪外袭 同时并向风寒/风热两侧）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canonicalTcmSyndromeTerm,
  equivalentGovernedSyndromeIds,
  governedSyndromeEquivalenceStats,
  governedSyndromeFeatureMatch,
  matchCompatibleGovernedSyndromeIds,
} from "../src/lib/clinical-governance-tables.ts";
import { retrieveTcmFormulaCandidatesForReasoning } from "../src/lib/tcm-formula-indications.ts";

const id = (name) => canonicalTcmSyndromeTerm(name)?.id;
const match = (a, b) => governedSyndromeFeatureMatch(id(a), id(b));

// ── 1) 实测撞上的同证异名必须等同，且对称 ────────────────────────────────────
const MUST_MATCH = [
  ["心虚胆怯证", "心胆气虚证"],
  ["肝气犯胃证", "肝胃不和证"],
  ["胃火上炎证", "胃火炽盛证"],
  ["肾阴虚证", "肾阴不足证"],
  ["肾阴虚证", "肾阴亏虚证"],
  ["心火炽盛证", "心火上炎证"],
  ["脾气虚证", "脾气不足证"],
];
for (const [a, b] of MUST_MATCH) {
  assert.ok(id(a) && id(b), `${a}/${b} 必须都能归一到治理 id`);
  assert.ok(match(a, b), `同证异名必须等同：${a} ↔ ${b}`);
  assert.equal(match(a, b), match(b, a), `等同必须对称：${a} ↔ ${b}`);
}

// ── 2) 危险边界必须拒绝（每条都对应一类真实的临床错误）─────────────────────────
const MUST_NOT_MATCH = [
  ["肾阴虚证", "肾阳虚证", "阴虚阳虚相反，合并即温阳方用于阴虚"],
  ["心气虚证", "心血虚证", "气血两虚不同治"],
  ["胃火炽盛证", "胃阴虚证", "实热虚热不同治"],
  ["脾气虚证", "脾阳虚证", "气虚阳虚有温阳之别"],
  ["肝火炽盛证", "肝阴虚证", "实火与阴虚火旺不同治"],
  ["风寒束表证", "风寒束肺证", "表证与脏腑证是两个临床判断，交给医生（deferredFormulaSelection）"],
  ["表寒证", "里寒证", "表里病位不同"],
  ["风寒袭肺证", "风热犯肺证", "名称极性否决兜住特征抽取丢维（实测两者特征都只剩 wind）"],
  ["太阳中风证", "太阳伤寒证", "有汗无汗之别，特征层不载，六经证整体退出自动等同"],
  ["肝旺脾虚证", "肝脾两虚证", "混合极性名称的极性按脏腑分配，特征包表达不了，fail-closed"],
];
for (const [a, b, why] of MUST_NOT_MATCH) {
  assert.ok(!match(a, b), `必须不等同（${why}）：${a} ↔ ${b}`);
}

// ── 3) fail-closed 参与门槛 ─────────────────────────────────────────────────
assert.equal(governedSyndromeFeatureMatch(undefined, id("肾阴虚证")), false);
assert.equal(governedSyndromeFeatureMatch("不存在的ID", id("肾阴虚证")), false);
assert.deepEqual(equivalentGovernedSyndromeIds("不存在的ID"), []);
// 同 id 恒真（等同层不得破坏原有精确匹配语义）。
assert.ok(governedSyndromeFeatureMatch(id("肾阴虚证"), id("肾阴虚证")));

// ── 4) 全表健康度：等同必须对称、规模有界 ────────────────────────────────────
const stats = governedSyndromeEquivalenceStats();
assert.ok(stats.profiled >= 1000, `参与条目 ${stats.profiled} 异常偏少——特征字段可能没接上`);
assert.ok(stats.idsWithEquivalents >= 100, `有等价者 ${stats.idsWithEquivalents} 异常偏少——展开可能失效`);
assert.ok(
  stats.idsWithEquivalents <= stats.profiled * 0.6,
  `有等价者占比 ${(stats.idsWithEquivalents / stats.profiled * 100).toFixed(0)}% 过高——等同口径可能又被放宽（宽松包含判定曾把 781 个邻域并成一片）`,
);
// 展开的每个成员都要能反向匹配回种子（无单向吸收）。
for (const seed of ["心胆气虚证", "肝胃不和证", "胃火炽盛证"]) {
  const seedId = id(seed);
  for (const member of matchCompatibleGovernedSyndromeIds(seedId)) {
    assert.ok(governedSyndromeFeatureMatch(member, seedId), `${seed} 的相容集成员 ${member} 必须能反向匹配`);
  }
}

// ── 5) 端到端：古典名与规范名必须检索出同一批可锁定方 ────────────────────────
const reasoningFor = (syndrome, therapy) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: {
    primarySyndrome: syndrome, primarySyndromeResolution: "bounded", primarySyndromeBasis: ["示例"],
    overallPathogenesis: "示例病机", overallTherapy: therapy,
    recommendedFormulaNames: [], formulaSelectionMode: "self_devised", secondarySyndromes: [],
  },
  westernDiagnosis: { primary: { name: "示例", supportingFacts: [] }, differentials: [] },
  pathogenesis: {
    summary: "示例",
    chain: [{ nodeId: "P1", patientFact: "示例", syndromeEvidence: "示例", pathogenesis: "示例", therapyDirection: therapy }],
    locationDifferentiation: { items: [], details: [] },
    natureDifferentiation: { items: [], rootDeficiency: [], branchExcess: [] },
    uncertainties: [],
  },
  therapy: { overallPrinciple: "治病求本", overallMethod: therapy, subTherapies: [{ therapy, targetPathogenesis: "示例", priority: "主要" }] },
});
const lockable = (syndrome, therapy) => retrieveTcmFormulaCandidatesForReasoning(reasoningFor(syndrome, therapy), 60)
  .filter((entry) => entry.identityLockEligible && entry.positiveSufficiency)
  .map((entry) => entry.name)
  .sort();
for (const [classical, canonical, therapy] of [
  ["心虚胆怯证", "心胆气虚证", "益气镇惊，安神定志"],
  ["肝气犯胃证", "肝胃不和证", "疏肝理气，和胃止痛"],
  ["胃火上炎证", "胃火炽盛证", "清胃泻火"],
]) {
  const a = lockable(classical, therapy);
  const b = lockable(canonical, therapy);
  assert.ok(a.length > 0, `${classical} 必须检索出可锁定方`);
  assert.deepEqual(a, b, `同证异名的可锁定集合必须一致：${classical} vs ${canonical}`);
}
// 反向端到端：阴虚证不得因等同层召回温阳方。
const yinLockable = lockable("肾阴虚证", "滋补肾阴");
assert.ok(yinLockable.length > 0, "肾阴虚必须有可锁定方");
assert.ok(!yinLockable.includes("金匮肾气丸") && !yinLockable.includes("右归丸"),
  "肾阴虚的可锁定集不得混入温阳方——等同层不得跨越阴阳边界");

console.log(JSON.stringify({
  suite: "syndrome-equivalence",
  mustMatch: MUST_MATCH.length,
  mustNotMatch: MUST_NOT_MATCH.length,
  ...stats,
  failures: 0,
}, null, 2));

// ─── 表↔肺卫外感风证 match-tier 相容 + 泛证参与门槛 ─────────────────────────────
// 类①（欠召回）：外感主证签「表」、方剂标签挂「肺」（肺主皮毛），麻黄汤对教科书级风寒束表
// 永远锁不住。相容仅进方剂召回/匹配，不进等价类，签名证候原样保留。
// 类②（过匹配）：八纲单轴与病因类目词的示例性释义画像与具体证候撞车（表寒 ≙ 风寒束表 同像），
// 麻杏石甘汤（表寒+里热复合主治）曾对纯风寒束表拿到「精确关系」。
{
  const { formulaMatchSyndromeCompatible } = await import("../src/lib/clinical-governance-tables.ts");
  const id = (label) => canonicalTcmSyndromeTerm(label)?.id;
  const mustCompat = [
    ["风寒束表证", "风寒犯肺证"],
    ["风寒束表证", "风寒袭肺证"],
    ["风热犯表证", "风热犯肺证"],
  ];
  for (const [left, right] of mustCompat) {
    assert.equal(formulaMatchSyndromeCompatible(id(left), id(right)), true, `方剂匹配层必须相容：${left} ↔ ${right}`);
    assert.equal(formulaMatchSyndromeCompatible(id(right), id(left)), true, `相容必须对称：${right} ↔ ${left}`);
  }
  const mustNotCompat = [
    ["风寒束表证", "风热犯肺证", "寒热极性对立"],
    ["风热犯表证", "风寒犯肺证", "寒热极性对立"],
    ["风寒束表证", "风寒闭肺证", "闭肺已入里，无表位"],
    ["太阳中风证", "风寒犯肺证", "六经证有汗无汗之辨不在特征层，麻黄汤证/桂枝汤证不得自动互通"],
    ["风寒束表证", "肺经风热证", "无表位且极性对立"],
  ];
  for (const [left, right, why] of mustNotCompat) {
    assert.equal(formulaMatchSyndromeCompatible(id(left), id(right)), false, `方剂匹配层不得相容（${why}）：${left} ↮ ${right}`);
  }
  // 相容不进等价类：风寒束表的等价近邻不得包含任何肺侧条目。
  const surfaceEquivalents = equivalentGovernedSyndromeIds(id("风寒束表证"));
  for (const other of ["风寒犯肺证", "风寒袭肺证"]) {
    assert.equal(surfaceEquivalents.includes(id(other)), false, `等价类必须保持表≠肺卫：风寒束表 ≢ ${other}`);
  }
  // 泛证参与门槛：八纲单轴（表寒/里热）与病因类目词（风邪/寒邪）不参与特征匹配；
  // 同 id 精确匹配保留；脏腑官窍类伞形真证候（肝胃不和）绝不能被一刀切扫出。
  for (const generic of ["表寒证", "里热证", "风邪", "寒邪"]) {
    const genericId = id(generic);
    if (!genericId) continue;
    assert.equal(governedSyndromeFeatureMatch(genericId, id("风寒束表证")), false, `泛证不得按画像冒充具体证候：${generic} ↮ 风寒束表`);
    assert.equal(governedSyndromeFeatureMatch(genericId, genericId), true, `泛证同 id 精确匹配必须保留：${generic}`);
  }
  assert.equal(governedSyndromeFeatureMatch(id("肝气犯胃证"), id("肝胃不和证")), true, "伞形真证候必须留在特征层：肝气犯胃 ↔ 肝胃不和");
  // 端到端：风寒束表证下麻黄汤获得正当性、麻杏石甘汤不得再获正当性。
  const reasoning = {
    overview: { primarySyndrome: "风寒束表证", overallPathogenesis: "风寒外束，卫阳被遏", tcmDifferentials: [] },
    pathogenesis: { summary: "风寒束表", chain: [{ pathogenesis: "风寒束表", therapyDirection: "辛温解表" }], natureDifferentiation: { items: ["风", "寒"] }, locationDifferentiation: { items: ["表"] } },
    therapy: { overallPrinciple: "辛温解表，宣肺平喘", subTherapies: [] },
  };
  const pool = retrieveTcmFormulaCandidatesForReasoning(reasoning, 60);
  const mahuang = pool.find((entry) => entry.name === "麻黄汤");
  assert.ok(mahuang?.positiveSufficiency, "风寒束表证下麻黄汤必须进入候选池并获得主证正向充分性（表↔肺卫相容）");
  const maxing = pool.find((entry) => entry.name === "麻黄杏子甘草石膏汤" || entry.name === "麻杏石甘汤");
  assert.equal(Boolean(maxing?.positiveSufficiency), false, "麻杏石甘汤（表寒+里热复合主治，辛凉）不得对纯风寒束表获得正向充分性");
}

// ─── 主证候表述噪声不得击穿方剂身份锁 ─────────────────────────────────────────
// 类问题：模型在信息不全时把主证候写成**描述性短语**而非规范证候名。实测公开医案
// 「眩晕-痰热上扰」得到「头晕（症状层）伴痰湿内阻倾向」——病机段写得完全正确（痰湿内蕴、
// 湿郁化热），但主证候整串与首段都归不上，方剂身份锁全链失效、只能出自拟方。
// 括号注释与「倾向/趋势」尾缀不携带证候语义；首段不是证候表述时应继续用后续段。
{
  const mk = (syndrome) => ({
    overview: { primarySyndrome: syndrome, overallPathogenesis: "痰湿内蕴中焦，清阳不升", tcmDifferentials: [] },
    pathogenesis: {
      summary: syndrome,
      chain: [{ pathogenesis: "痰湿内蕴", therapyDirection: "化痰祛湿" }],
      natureDifferentiation: { items: ["痰", "湿"] },
      locationDifferentiation: { items: ["脾"] },
    },
    therapy: { overallPrinciple: "化痰祛湿，健脾和胃", subTherapies: [] },
  });
  const lockable = (syndrome) => retrieveTcmFormulaCandidatesForReasoning(mk(syndrome), 5)
    .filter((entry) => entry.positiveSufficiency).length > 0;
  for (const syndrome of [
    "头晕（症状层）伴痰湿内阻倾向",
    "痰湿内阻证",
    "痰湿内阻倾向",
    "肝阳上亢，痰浊内阻证",
  ]) {
    assert.ok(lockable(syndrome), `主证候「${syndrome}」必须能归一并取得可锁候选，否则整例退化为自拟方`);
  }
  // 首段优先不得被破坏：首段是有效证候时，锁的必须是首段对应的方向，兼证不得反客为主。
  const compound = retrieveTcmFormulaCandidatesForReasoning({
    overview: { primarySyndrome: "心脾两虚兼血瘀", overallPathogenesis: "心脾两虚，气血不足", tcmDifferentials: [] },
    pathogenesis: {
      summary: "心脾两虚",
      chain: [{ pathogenesis: "心脾两虚", therapyDirection: "补益心脾" }],
      natureDifferentiation: { items: ["气虚", "血虚"] },
      locationDifferentiation: { items: ["心", "脾"] },
    },
    therapy: { overallPrinciple: "补益心脾，养血安神", subTherapies: [] },
  }, 8).filter((entry) => entry.positiveSufficiency).map((entry) => entry.name);
  assert.ok(compound.length > 0, "复合证候首段必须仍可锁定");
  // 纯症状词不得凭空归一出证候——噪声剥离只清理修饰成分，不制造证候。
  for (const notSyndrome of ["头晕", "头晕（症状层）", "乏力倾向"]) {
    assert.equal(lockable(notSyndrome), false, `「${notSyndrome}」不含证候表述，不得归一出可锁候选`);
  }
}

// ─── 剂量豁免层启用后：受控方全部可编译 ─────────────────────────────────────
// 甲方 2026-08-01 决策：缺法定数值边界的成分不再阻断出方，改为标注核验级别 + 医师定量 +
// 灵犀审方兜底。此前 1352/2915 的方一旦被锁定就只能返回非剂量结果。
// 这里只钉住「不要倒退」：目录侧可编译数不得跌回豁免前水位。
{
  const catalog = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-governed-catalog.json", import.meta.url), "utf8"));
  const eligible = catalog.entries.filter((entry) => entry.doseCompilationEligible === true).length;
  const retrievable = catalog.entries.filter((entry) => entry.retrievalEligible === true).length;
  // 数据缺口类已豁免，监管轴（管制毒性/法律禁用动物药）仍阻断，因此可编译率不会到 100%。
  // 门槛设在 0.75：豁免前是 0.54（1563/2915），豁免后约 0.82；跌回 0.75 以下说明豁免链路被破坏。
  assert.ok(eligible / retrievable >= 0.75,
    `豁免层启用后可编译率不得低于 75%（当前 ${eligible}/${retrievable}）——回落说明豁免链路被破坏`);
}
