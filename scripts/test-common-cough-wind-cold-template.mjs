// 普通咳嗽·风寒袭肺证的**精确证型模板闸门**（中医师 2026-08-11 裁定稿）。
//
// 甲方线上实测：风寒咳嗽给出承灵、孔最、肩中俞，缺列缺、风池。排查后根因两层，
// 都不是排序能解决的：①「流清涕」先命中 upper_airway 抢在 respiratory 前；
// ② 目录里根本没有「普通风寒咳嗽」模板，只有流感专用与感染恢复期两条。
//
// 中医师裁定对我方设想做了一处修正——**列缺进主穴，风池只作条件加穴**：
// 支持风池的是北京市卫健委健康科普，属政府健康指导，不足以确立它为所有风寒咳嗽的固定主穴。
//
// 本套件钉住裁定里点名的 7 条回归，再加三条结构性判据：
//   · 闸门只允许声明在针刺项目内（裁定：「仅限针刺项目内部」）；
//   · 频次不得照搬流感专项方案的「每日1次、每次30分钟」（裁定点名）；
//   · **当前**处于 pending_clinician_review ⇒ 模板不启用、本例保持评估态
//     （中医师原话「签字前保持评估态是正确的」），但待签字的取穴必须如实呈现、不得静默。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const {
  getTcmTreatmentProjectDefinition,
  precisePlanTemplateGateMatches,
  governedTcmTreatmentPrecisePlanTemplate,
  governedTcmTreatmentConditionalPoints,
  tcmTreatmentPointProvenance,
  tcmRefinementAdjudication,
  tcmSourceAuthorityTier,
} = await import("../src/lib/tcm-treatment-projects.ts");

const failures = [];
const check = (name, fn) => {
  try {
    fn();
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
  }
};

const acupuncture = getTcmTreatmentProjectDefinition("acupuncture");
const template = (acupuncture?.planTemplates || []).find((item) => item.id === "acupuncture-common-cough-wind-cold");

check("模板已入目录，主穴与风寒加穴逐条照录 2021 咳嗽共识", () => {
  assert.ok(template, "acupuncture-common-cough-wind-cold 不在针刺目录里");
  assert.deepEqual(
    [...template.sitesOrPoints],
    ["肺俞", "中府", "列缺", "太渊", "风门", "合谷"],
    "主穴（肺俞、中府、列缺、太渊）+ 风寒加穴（风门、合谷）必须逐条落库",
  );
  // 裁定「不纳入固定穴」。孔最正是关键词召回靠「热病无汗」在风寒例里选中的那个。
  for (const excluded of ["孔最", "承灵", "肩中俞"]) {
    assert.ok(!template.sitesOrPoints.includes(excluded), `${excluded} 不得进入固定穴`);
  }
  assert.ok(template.sourceRefs.includes("SRC-TCM-COUGH-CONSENSUS-2021"), "主穴来源必须挂 2021 咳嗽共识");
  assert.equal(
    tcmSourceAuthorityTier("SRC-TCM-COUGH-CONSENSUS-2021"),
    "professional_society_consensus",
    "专家共识不得冒充学会标准",
  );
});

check("风池是条件加穴而非主穴，且来源如实挂在政府健康指导上", () => {
  assert.ok(!template.sitesOrPoints.includes("风池"), "风池不得进入固定主穴（裁定明确修正）");
  const conditional = (template.conditionalPoints || []).find((item) => item.point === "风池");
  assert.ok(conditional, "风池必须登记为条件加穴");
  assert.deepEqual(
    [...conditional.sourceRefs],
    ["SRC-BEIJING-HEALTH-COUGH-GUIDANCE-2024"],
    "风池的出处是北京市卫健委健康科普，不能挂到 2021 共识的主穴行上",
  );
});

// ── 裁定点名的 7 条回归 ──────────────────────────────────────────────────
const WIND_COLD_SIGNED = "风寒袭肺，肺气失宣；治以疏风散寒、宣肺止咳";
const gateHits = (currentFacts, signed) => precisePlanTemplateGateMatches(template, currentFacts, signed);

check("① 风寒咳嗽 + 鼻塞流清涕：命中，且必须含列缺、风门、合谷、风池", () => {
  const facts = "咳嗽5天，痰白稀，恶寒无汗，鼻塞流清涕";
  assert.ok(gateHits(facts, WIND_COLD_SIGNED), "两把钥匙都对上却没命中");
  const conditional = governedTcmTreatmentConditionalPoints(template, facts).map((item) => item.point);
  const points = [...template.sitesOrPoints, ...conditional];
  for (const required of ["列缺", "风门", "合谷", "风池"]) {
    assert.ok(points.includes(required), `本例应含 ${required}，实际：${points.join("、")}`);
  }
});

check("② 风寒咳嗽但无鼻窍/头项症状：含列缺、风门、合谷，不强制风池", () => {
  const facts = "咳嗽3天，痰白稀，恶寒无汗，无鼻部不适";
  assert.ok(gateHits(facts, WIND_COLD_SIGNED), "无鼻窍症状不应影响模板本身是否命中");
  const conditional = governedTcmTreatmentConditionalPoints(template, facts).map((item) => item.point);
  assert.deepEqual(conditional, [], `无鼻窍/头项症状时不应加风池，实际加了：${conditional.join("、")}`);
  for (const required of ["列缺", "风门", "合谷"]) {
    assert.ok(template.sitesOrPoints.includes(required), `本例应含 ${required}`);
  }
});

check("③ 单纯鼻炎无咳嗽：不得命中本模板", () => {
  assert.ok(
    !gateHits("鼻塞流清涕，喷嚏频作，无咳嗽", "风寒袭肺"),
    "没有当前咳嗽事实却命中了咳嗽模板——「流清涕」只能决定加不加风池，不能把整例带进来",
  );
});

check("否定极性：「无咳嗽」「否认咳嗽」不得被当成有咳嗽", () => {
  for (const negated of ["鼻塞流清涕，无咳嗽", "否认咳嗽咳痰", "未见咳嗽", "无明显咳嗽"]) {
    assert.ok(!gateHits(negated, WIND_COLD_SIGNED), `「${negated}」不应命中`);
  }
  // 反向护栏同样重要：上一短句的否定词不能算到下一个词头上，否则真阳性被判成阴性。
  assert.ok(gateHits("恶寒无汗，咳嗽痰白稀", WIND_COLD_SIGNED), "「无汗」属上一短句，不应把「咳嗽」判为否定");
  const conditional = governedTcmTreatmentConditionalPoints(template, "咳嗽，无鼻塞，无头痛").map((item) => item.point);
  assert.deepEqual(conditional, [], "「无鼻塞」「无头痛」不应触发条件加穴风池");
});

check("④ 流感：只走流感专用模板，本模板不得命中", () => {
  assert.ok(
    !gateHits("流行性感冒，咳嗽，恶寒重发热轻", "风寒束表，风寒袭肺"),
    "流感必须排除——套用普通咳嗽模板等于扩大既有专项方案的适应证",
  );
  const influenza = (acupuncture?.planTemplates || []).find((item) => item.id === "acupuncture-influenza-hunan-2025");
  assert.ok(influenza, "流感专用模板必须仍在目录里");
  assert.ok(!influenza.preciseSyndromeGate, "流感模板不应被顺手加上闸门——它的适应证判据未变");
});

check("⑤ 感染恢复期：只走恢复期模板，本模板不得命中", () => {
  assert.ok(
    !gateHits("感染恢复期，仍有咳嗽，气短乏力", "肺脾气虚，余邪未尽；风寒袭肺"),
    "恢复期必须排除——病程阶段不同，取穴与操作方向都不同",
  );
});

check("⑥ 风热咳嗽：不得命中风寒模板", () => {
  assert.ok(
    !gateHits("咳嗽，痰黄黏稠，咽痛口渴", "风热犯肺，肺失清肃"),
    "风热证不得命中风寒模板",
  );
});

check("⑦ 否认咳嗽 / 仅有既往咳嗽：不得命中", () => {
  // 「当前事实」由 treatmentCurrentFacts 产出：已做阳性化（否认句不留痕）且不含既往史。
  // 这里直接以两种输入形态验证闸门本身：空当前事实、以及只有既往描述的当前事实。
  assert.ok(!gateHits("", WIND_COLD_SIGNED), "当前事实为空（如否认咳嗽被阳性化剥离）时不得命中");
  assert.ok(
    !gateHits("恶寒无汗，鼻塞流清涕", WIND_COLD_SIGNED),
    "当前事实里没有咳嗽（既往咳嗽不进当前事实）时不得命中",
  );
});

// ── 结构性判据 ──────────────────────────────────────────────────────────
check("闸门只允许声明在针刺项目内（裁定：仅限针刺项目内部）", () => {
  const offenders = [];
  for (const code of ["moxibustion", "tuina", "cupping", "guasha", "acupoint_application", "auricular",
    "diet_therapy", "mind_therapy", "qigong_daoyin", "thread_embedding", "bloodletting"]) {
    const definition = getTcmTreatmentProjectDefinition(code);
    for (const item of definition?.planTemplates || []) {
      if (item.preciseSyndromeGate || (item.conditionalPoints || []).length > 0) offenders.push(`${code}:${item.id}`);
    }
  }
  assert.deepEqual(offenders, [], `精确闸门/条件加穴越出针刺项目：${offenders.join("、")}`);
});

check("频次不得照搬流感专项方案", () => {
  const influenza = (acupuncture?.planTemplates || []).find((item) => item.id === "acupuncture-influenza-hunan-2025");
  assert.notEqual(template.scheduleSuggestion, influenza.scheduleSuggestion, "排程与流感方案逐字相同");
  assert.ok(!/每日\s*1\s*次[，,].*30\s*分钟/.test(template.scheduleSuggestion), "不得写死流感方案的每日1次/每次30分钟");
  assert.ok(/本机构|排程/.test(template.scheduleSuggestion), "应指向本机构项目排程参考");
  assert.ok(/留针|疗程/.test(template.scheduleSuggestion), "留针时长与疗程必须交回现场医师");
});

check("当前未签字 ⇒ 模板不启用、保持评估态，但待签字取穴如实呈现", () => {
  const adjudication = tcmRefinementAdjudication("common-cough-wind-cold-template");
  assert.equal(
    adjudication.adjudicationStatus,
    "pending_clinician_review",
    "中医师尚未签字，台账不得标 approved——签字是数据侧一行的事，不能由实现代劳",
  );
  const resolved = governedTcmTreatmentPrecisePlanTemplate(
    "acupuncture",
    "咳嗽5天，痰白稀，恶寒无汗，鼻塞流清涕",
    WIND_COLD_SIGNED,
  );
  assert.equal(resolved.template, undefined, "未签字却把模板启用成了患者级方案");
  assert.ok(resolved.deferred, "未签字也不能静默——必须把待签字的那条挂出来");
  assert.equal(resolved.deferred.template.id, "acupuncture-common-cough-wind-cold");
  assert.ok(
    resolved.deferred.adjudication.conflictNote?.includes("尚未完成中医师签字终审"),
    "待签字说明必须讲清为什么没用它",
  );
});

check("逐穴溯源：风池单列为 conditional_point，不与主穴同源同级", () => {
  const conditional = governedTcmTreatmentConditionalPoints(template, "咳嗽，鼻塞流清涕");
  const provenance = tcmTreatmentPointProvenance(template, undefined, conditional);
  const fengchi = provenance.find((entry) => entry.point === "风池");
  assert.ok(fengchi, "风池必须有自己的溯源记录");
  assert.equal(fengchi.role, "conditional_point");
  assert.deepEqual(fengchi.sourceRefs, ["SRC-BEIJING-HEALTH-COUGH-GUIDANCE-2024"]);
  const lieque = provenance.find((entry) => entry.point === "列缺");
  assert.equal(lieque.role, "base_point", "列缺是固定主穴（裁定修正的正是这一条）");
  // 列缺的等级取本模板全部来源里的最高档。SAMR 针刺操作规范（国家标准）也在其中，
  // 因此这里是 regulatory_primary——**这是既有口径**，不是本条特有：全仓针刺模板的主穴
  // 都把操作规范一并算进了取穴权威。判据只钉住"列缺的来源里确有 2021 共识"，
  // 不在本轮顺手改动全局等级算法（那会移动每一条既有模板的值，另案处理）。
  assert.ok(lieque.sourceRefs.includes("SRC-TCM-COUGH-CONSENSUS-2021"), "列缺必须能追到 2021 共识");
  assert.ok(
    ["regulatory_primary", "professional_society_consensus"].includes(lieque.authorityTier),
    `列缺等级异常：${lieque.authorityTier}`,
  );
  // 同一个穴不得出现两条记录（一次主穴一次条件加穴）。
  const seen = provenance.map((entry) => entry.point);
  assert.equal(new Set(seen).size, seen.length, `逐穴溯源出现重复：${seen.join("、")}`);
});

// ── 未签字期间：评估态的候选穴位次序也应受益，但**一个穴都不许新增** ──────────
// 甲方看到的症状是「承灵、孔最、肩中俞」。模板签字前不启用，评估态仍由关键词召回出穴；
// 但召回按「症状词命中个数」排序，正是那个排法让承灵压过列缺、让「热病无汗」的孔最
// 进了风寒例。用已命中双钥匙闸门的待签字模板给**本来就够格**的穴排先后，严格优于它，
// 且不构成"启用未签字模板"——不新增穴、不给频次疗程、protocolStatus 仍是评估态。
const { selectAcupointsForCaseTerms } = await import("../src/lib/tcm-acupoints.ts");

check("未签字期间：重排只改次序、不新增穴，且甲方实测的三个穴不再进前 5", () => {
  const terms = ["咳嗽", "恶寒", "无汗", "鼻塞", "流涕"];
  const pool = selectAcupointsForCaseTerms(terms, 16);
  const governed = new Set(template.sitesOrPoints);
  const ranked = [...pool].map((item, index) => ({ item, index }))
    .sort((left, right) =>
      (governed.has(left.item.entry.name) ? 0 : 1) - (governed.has(right.item.entry.name) ? 0 : 1)
      || left.index - right.index)
    .map((entry) => entry.item).slice(0, 5);
  const names = ranked.map((item) => item.entry.name);

  // ① 不新增：重排后的每一个穴都必须来自原召回池（判据是"够格"而不是"模板里有"）。
  const poolNames = new Set(pool.map((item) => item.entry.name));
  for (const name of names) assert.ok(poolNames.has(name), `${name} 不在关键词召回池里——重排新增了穴`);
  assert.equal(new Set(names).size, names.length, "重排后出现重复穴");

  // ② 甲方线上实测点名的三个穴不再进前 5。
  for (const reported of ["承灵", "孔最", "肩中俞"]) {
    assert.ok(!names.includes(reported), `${reported} 仍在前 5：${names.join("、")}`);
  }
  // ③ 共识主穴里凡是够格的都应排上来。
  for (const expected of ["列缺", "太渊", "肺俞"]) {
    assert.ok(names.includes(expected), `${expected} 应进入前 5，实际：${names.join("、")}`);
  }
});

// ── 「待签字」这件事必须三个出口都到得了 ────────────────────────────────
// 待终审的证型配穴此前只铺到医生页面与 HIS，服务端 Markdown 一句没有——
// 又是本仓库那个反复出现的形状。加第三态时一并收口，并在这里钉死。
const {
  deferredGovernedTemplateCopy,
  deferredSyndromeRefinementCopy,
} = await import("../src/lib/diagnosis-visible-summary.ts");

check("待签字/待终审的说明有唯一投影，且三个出口都在用", () => {
  const copy = deferredGovernedTemplateCopy({
    indicationLabel: "普通咳嗽·风寒袭肺证/风寒束肺证",
    deferredPoints: ["肺俞", "中府", "列缺", "太渊", "风门", "合谷", "风池"],
    conflictNote: "尚未完成中医师签字终审。",
  });
  assert.ok(copy.includes("普通咳嗽·风寒袭肺证"), "必须说清是哪个病种模板在等签字");
  assert.ok(copy.includes("列缺") && copy.includes("风池"), "待签字的取穴必须逐条列出，不能只说一句「有待终审项」");
  assert.ok(/评估态/.test(copy), "必须说清本轮仍按评估态呈现——否则医生会以为这些穴已经是受治理方案");
  assert.equal(deferredGovernedTemplateCopy(undefined), "", "没有待签字项时不得凭空印一句");
  assert.ok(deferredSyndromeRefinementCopy({ syndromeLabel: "风寒袭肺", deferredPoints: ["风门"], conflictNote: "x" })
    .includes("未予应用"), "证型配穴那一句的语义不得被本轮改动带偏");

  const outlets = [
    ["src/lib/diagnosis-visible-summary.ts", "服务端 Markdown"],
    ["src/app/diagnosis/DiagnosisClient.tsx", "医生页面"],
  ];
  for (const [file, label] of outlets) {
    const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
    for (const fn of ["deferredGovernedTemplateCopy", "deferredSyndromeRefinementCopy"]) {
      assert.ok(source.includes(fn), `${label} 没有使用共享投影 ${fn}`);
    }
  }
  // HIS 走结构化字段而不是句子，钉的是"字段有没有透传"。
  const his = readFileSync(fileURLToPath(new URL("../src/lib/his-scheme.ts", import.meta.url)), "utf8");
  assert.ok(/deferredGovernedTemplate:\s*\{/.test(his), "HIS 投影没有透传 deferredGovernedTemplate");
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "common-cough-wind-cold-template", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  suite: "common-cough-wind-cold-template",
  basePoints: template.sitesOrPoints.length,
  conditionalPoints: (template.conditionalPoints || []).length,
  adjudication: tcmRefinementAdjudication("common-cough-wind-cold-template").adjudicationStatus,
  failures: 0,
}));
