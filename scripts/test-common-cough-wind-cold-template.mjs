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
//   · 终审状态决定启不启用：2026-08-11 中医师**已签字**（approved）⇒ 模板启用，
//     且因为闸门准入条件本身就含"已签名证型"，它算作按本例证型的患者级方案；
//     未登记进台账的闸门模板一律按未终审处理——不启用，但不静默。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const {
  getTcmTreatmentProjectDefinition,
  governedTcmTreatmentPlanTemplateForTags,
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
// 闸门第四个参数是年龄：裁定适用范围是成人，取不到年龄一律不启用（见 minAgeYears）。
const ADULT = 42;
const gateHits = (currentFacts, signed, age = ADULT) =>
  precisePlanTemplateGateMatches(template, currentFacts, signed, age);

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

// ── 2026-08-11 对抗性复核确认的闸门缺陷（纯判据侧）──────────────────────────
check("复核：适用范围「成人」必须落成闸门判据，年龄缺失取保守侧", () => {
  assert.equal(template.preciseSyndromeGate.minAgeYears, 18, "裁定写「成人」，闸门必须有年龄下限");
  const facts = "咳嗽5天，痰白稀，恶寒无汗";
  assert.ok(gateHits(facts, WIND_COLD_SIGNED, 42), "成人应命中");
  // 直接调真实函数，避开 helper 的默认值——「年龄缺失」这一档正是要测没有默认值时的行为。
  for (const age of [0.67, 4, 17, undefined, NaN, "42"]) {
    assert.ok(
      !precisePlanTemplateGateMatches(template, facts, WIND_COLD_SIGNED, age),
      `年龄=${age} 不应命中（拿不到年龄就不能证明是成人）`,
    );
  }
});

check("复核：鉴别语与病机演变不得当作已签名结论", () => {
  const facts = "咳嗽5天，痰白稀";
  for (const signed of [
    "肺气虚证；与风寒袭肺不同",
    "痰湿蕴肺证；本证与风寒袭肺证鉴别要点在于痰多黏腻",
    "痰湿蕴肺证；初起风寒袭肺，日久聚湿生痰",
    "痰热壅肺证；风寒袭肺入里化热",
    "排除风寒袭肺",
    "非风寒袭肺",
  ]) {
    assert.ok(!gateHits(facts, signed), `「${signed}」不应开闸`);
  }
  assert.ok(gateHits(facts, "风寒袭肺证"), "结论性证候名必须照常开闸");
});

check("复核：否定跟在词后面也算否定（抗原阴性）", () => {
  const selected = governedTcmTreatmentPlanTemplateForTags(
    "acupuncture",
    "咳嗽5天，痰白清稀，恶寒无汗。甲型流感病毒抗原阴性。",
    ["respiratory"],
  );
  assert.notEqual(selected?.id, "acupuncture-influenza-hunan-2025", "一个阴性结果不得换来流感专项方案");
});

check("复核：条件加穴不得被现病史里的既往描述带出", () => {
  const conditional = governedTcmTreatmentConditionalPoints(
    template,
    "咳嗽5天，痰白清稀，恶寒无汗，无鼻塞流涕；既往有偏头痛史",
  ).map((item) => item.point);
  assert.deepEqual(conditional, [], `既往偏头痛史触发了条件加穴：${conditional.join("、")}`);
});

check("复核：主穴等级按**取穴依据**算，不继承纯操作规范的国标", () => {
  const provenance = tcmTreatmentPointProvenance(template, undefined, []);
  for (const entry of provenance) {
    assert.equal(
      entry.authorityTier,
      "professional_society_consensus",
      `${entry.point} 报了 ${entry.authorityTier}——GB/T 针刺操作规范规定的是怎么扎，一个穴位都没规定`,
    );
  }
  // 整条方案的最高等级仍可含操作规范（安全边界确实由它背书），这两者是不同的问题。
  assert.ok(template.sourceRefs.includes("SRC-SAMR-ACUPUNCTURE-OPS"), "操作规范仍应挂在模板来源上");
});

check("复核：条件加穴的触发说明必须写在不被 V1 折叠的字段上", () => {
  const conditional = governedTcmTreatmentConditionalPoints(template, "咳嗽，鼻塞流清涕");
  const fengchi = tcmTreatmentPointProvenance(template, undefined, conditional)
    .find((entry) => entry.point === "风池");
  assert.ok(fengchi.conflictNote, "V1 折叠后 role 已说不清它是什么，说明必须另有落点");
  assert.ok(/条件加穴/.test(fengchi.conflictNote), `说明未讲清是条件加穴：${fengchi.conflictNote}`);
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

check("已签字 ⇒ 模板启用，且算作按本例证型的患者级方案", () => {
  const adjudication = tcmRefinementAdjudication("common-cough-wind-cold-template");
  assert.equal(
    adjudication.adjudicationStatus,
    "approved",
    "中医师 2026-08-11 已签字终审；台账必须如实登记",
  );
  assert.equal(adjudication.conflictNote, null, "已签字条目不应再挂待终审说明");
  const resolved = governedTcmTreatmentPrecisePlanTemplate(
    "acupuncture",
    "咳嗽5天，痰白稀，恶寒无汗，鼻塞流清涕",
    WIND_COLD_SIGNED,
    ADULT,
  );
  assert.ok(resolved.template, "已签字却没启用模板");
  assert.equal(resolved.template.id, "acupuncture-common-cough-wind-cold");
  assert.equal(resolved.deferred, undefined, "已启用就不该再挂待签字说明");
});

// 「个体化方案」在本仓库的定义是三件事同时成立：病种事实 + 本例已签名证型 + 该条已终审。
// 精确闸门把这三件事写成了模板的准入条件，所以走它进来的模板天然满足定义。
// 这条判据钉的是**呈现口径**：不加它，本模板因为没有 syndromeRefinements 会被判成
// 「命中病种模板但未按证型加减」，还会写「请按寒热虚实增减」——而它恰恰是最贴证型的一条。
check("闸门选中的模板不得被说成「尚未按本例证型加减」", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/lib/tcm-treatment-capabilities.server.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    /const syndromeTailored = Boolean\(refinement\) \|\| syndromeGatedTemplate/.test(source),
    "syndromeTailored 必须把闸门选中的模板也算进去",
  );
  for (const field of ["protocolStatus: syndromeTailored", "tailoringStatus: syndromeTailored", "protocolGap: syndromeTailored"]) {
    assert.ok(source.includes(field), `${field} 仍在按 refinement 单独判定——三者必须同一个判据`);
  }
});

// 未签字的行为同样必须钉住：签字是数据侧一行的事，可能随时新增下一条待签字模板。
// 用一条**未登记进台账**的合成模板验证——台账里没有的条目一律按未终审处理，这是既有约定。
check("未登记进台账的闸门模板：不启用、但不静默", () => {
  const synthetic = {
    ...template,
    id: "synthetic-unregistered-gate",
    preciseSyndromeGate: { ...template.preciseSyndromeGate, adjudicationId: "synthetic-never-registered" },
  };
  const adjudication = tcmRefinementAdjudication("synthetic-never-registered");
  assert.equal(adjudication.adjudicationStatus, "pending_clinician_review", "未登记条目必须按未终审处理");
  assert.ok(adjudication.conflictNote, "未终审必须给出说明，不能静默");
  // 闸门判据本身与终审状态无关：命中照旧成立，启不启用另说。
  assert.ok(
    precisePlanTemplateGateMatches(synthetic, "咳嗽5天，恶寒无汗", WIND_COLD_SIGNED, ADULT),
    "终审状态不应影响闸门的命中判据",
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

// ── 有待签字闸门模板时：评估态的候选穴位次序也应受益，但**一个穴都不许新增** ──────
// 本条模板已于 2026-08-11 签字启用，因此这条路径现在由**下一条**待签字模板复用；
// 判据仍按当时实测的形状钉住，因为它编码的是"重排不得新增穴"这条边界。
// 甲方看到的症状是「承灵、孔最、肩中俞」。模板签字前不启用，评估态仍由关键词召回出穴；
// 但召回按「症状词命中个数」排序，正是那个排法让承灵压过列缺、让「热病无汗」的孔最
// 进了风寒例。用已命中双钥匙闸门的待签字模板给**本来就够格**的穴排先后，严格优于它，
// 且不构成"启用未签字模板"——不新增穴、不给频次疗程、protocolStatus 仍是评估态。
const { selectAcupointsForCaseTerms } = await import("../src/lib/tcm-acupoints.ts");
const { TcmTreatmentRecommendationSchema: TCM_TREATMENT_ITEM_SCHEMA } = await import("../src/lib/diagnosis-types.ts");

check("待签字闸门模板存在时：重排只改次序、不新增穴（本条现由未来的待签字模板复用）", () => {
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

check("带闸门的模板不得从常规按病名通路被选出（后门）", () => {
  // 2026-08-11 端到端实测抓到的真缺陷：本模板同时也是一条普通 respiratory 模板、
  // matchAny 是「咳嗽/咳痰/干咳」，于是 governedTcmTreatmentPlanTemplateForTags
  // 可以不看证型就把它选出来——风热咳嗽与「仅有既往咳嗽」两例都因此拿到了风寒证取穴。
  // 闸门写了「必须同时命中已签名风寒袭肺」，却还留着一扇不看证型的后门。
  for (const text of [
    "咳嗽4天，痰黄黏稠，咽痛口渴",   // 风热
    "既往慢性咳嗽病史3年，本次鼻塞流清涕",  // 仅既往咳嗽
    "咳嗽",                          // 裸病名
  ]) {
    const selected = governedTcmTreatmentPlanTemplateForTags("acupuncture", text, ["respiratory"]);
    assert.notEqual(
      selected?.id,
      "acupuncture-common-cough-wind-cold",
      `常规通路绕过闸门选出了带闸门的模板：「${text}」`,
    );
  }
  // 反向护栏：同标签下**不带**闸门的模板仍然照常可选，不能把整个 respiratory 一起挡掉。
  const influenza = governedTcmTreatmentPlanTemplateForTags("acupuncture", "流行性感冒，恶寒重发热轻", ["respiratory"]);
  assert.equal(influenza?.id, "acupuncture-influenza-hunan-2025", "不带闸门的模板被误挡");
});

// ── 待签字/待终审只留后台结构化字段，医生端不得再解释治理过程 ──────────────────
check("待签字/待终审保留在 HIS，两个医生可见出口只用最小临床投影", () => {
  for (const [file, label] of [
    ["src/lib/diagnosis-visible-summary.ts", "服务端 Markdown"],
    ["src/app/diagnosis/DiagnosisClient.tsx", "医生页面"],
  ]) {
    const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
    assert.ok(source.includes("buildClinicianTreatmentProjects"), `${label} 没有使用医生端最小投影`);
  }
  const client = readFileSync(fileURLToPath(new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url)), "utf8");
  const treatmentStart = client.indexOf('id="cdss-section-tcm-treatment"');
  const treatmentEnd = client.indexOf("<SchemeSection", treatmentStart + 1);
  const treatmentSection = client.slice(treatmentStart, treatmentEnd);
  assert.ok(!/deferredGovernedTemplate|deferredSyndromeRefinement/.test(treatmentSection),
    "医生页面仍在展示待签字/待终审治理过程");

  // HIS 走结构化字段而不是医生端句子，钉的是字段有没有透传。
  const his = readFileSync(fileURLToPath(new URL("../src/lib/his-scheme.ts", import.meta.url)), "utf8");
  assert.ok(/deferredGovernedTemplate:\s*\{/.test(his), "HIS 投影没有透传 deferredGovernedTemplate");
});

check("deferredGovernedTemplate 写歪不得连坐整条诊疗项目", () => {
  // 「一个空字符串让整条项目消失」在本仓库复发过 6 次，形态完全相同、只换字段。
  // 新增字段一律 fail-soft，这条判据按**行为**判：注入一条非法的 deferredGovernedTemplate，
  // 断言该项目其余字段仍在，而不是整条被隔离掉。
  const project = {
    projectCode: "acupuncture",
    projectName: "针刺",
    availability: "clinic_available",
    riskLevel: "moderate",
    recommendationMode: "clinician_assessment",
    targetRef: "P1",
    targetPathogenesis: "风寒袭肺，肺气失宣",
    protocolStatus: "assessment_only_no_patient_specific_protocol",
    // 非法：deferredPoints 里混了空串，conflictNote 缺失
    deferredGovernedTemplate: { templateId: "x", indicationLabel: "y", deferredPoints: [""], conflictNote: "" },
    treatmentContent: "评估态",
    suggestedSitesOrPoints: ["列缺"],
    scheduleSuggestion: "按本机构排程",
    techniqueBoundary: "由现场医师复核",
    protocolSource: "SRC-TCM-COUGH-CONSENSUS-2021",
    operatorRequirement: "具备资质人员",
    requiredChecks: ["禁忌复核"],
    containsMedication: false,
    requiresMedicationAudit: false,
    executable: false,
    clinicianReviewRequired: true,
  };
  const parsed = TCM_TREATMENT_ITEM_SCHEMA.safeParse(project);
  assert.ok(parsed.success, `整条项目被非法的 deferredGovernedTemplate 连坐掉了：${parsed.error?.message || ""}`);
  assert.equal(parsed.data.deferredGovernedTemplate, undefined, "非法条目应被丢弃而不是原样保留");
  assert.deepEqual(parsed.data.suggestedSitesOrPoints, ["列缺"], "同条项目的其余字段必须原样保留");
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
