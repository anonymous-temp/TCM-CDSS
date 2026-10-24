// 10/24 第十八轮（流派选择与使用 + 基层病历测试暴露的类）。
//
//   1 流派选方：医生选了流派、模型按流派选了该派的方时，目录主治证候与已签名证候相容也算对证（治法用词对不上不再把方改回教材代表方），
//     保留时治法按这首方的功效改写；有兼证、不限定流派、模型判不适用、方与证候不相容时照旧。
//   2 流派适配说明与交付方一致：点名了没有交付的方（且不是在说不套用它）的那一条去掉。
//   3 经方思路下经方方证候选的采用规则：有条文特征症、区分点不相反就采用方证。
//   4 病历自述矛盾的引文保留原文全角标点。
//   6 交付方名：三味及以下的小方须全味在方中才沿用方名（左金丸只剩黄连不再叫左金丸加减）。
//   7 西医诊断标准要点表：补急性胰腺炎、急性胆囊炎、急性心肌梗死、急性肺栓塞、蛛网膜下腔出血（基层病例未做化验影像就下的急症诊断）。
//   8 哺乳已结束的写法（哺乳期过后/已过/结束、断奶后、停止哺乳）判否认，不再按哺乳阳性收回剂量（基层病例 A062）。
//   9 补充行「小便不禁」（《针灸治疗学》尿失禁节证候 + T/CACM 1553—2023 方药）：成人漏尿不再落到阴挺。
//   5 中成药：说明书适应证明写实热/实火/实证/实寒的，纯虚证不推荐（润肠丸「用于实热津亏便秘」配阴虚秘）。

import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const check = async (name, run) => {
  cases += 1;
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const indications = await jiti.import("../src/lib/tcm-formula-indications.ts");
const jingfang = await jiti.import("../src/lib/jingfang-patterns.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const patent = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
const criteria = await jiti.import("../src/lib/western-diagnostic-criteria.server.ts");
const clinicalState = await jiti.import("../src/lib/clinical-state.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");

const c001 = JSON.parse(fs.readFileSync("scripts/fixtures/r1030-c001-diagnose.json", "utf8"));
const withChoice = ({ formula, therapy = "辛温解表，宣肺散寒，通窍止痒", applicable = "applicable", secondary = [], decisions } = {}) => {
  const reasoning = structuredClone(c001);
  delete reasoning._note;
  reasoning.overview.recommendedFormulaDirection = `${formula}加减`;
  reasoning.overview.secondarySyndromes = secondary;
  reasoning.therapy.overallMethod = therapy;
  reasoning.overview.overallTherapy = therapy;
  reasoning.lineageAdaptation = {
    ...reasoning.lineageAdaptation,
    applicable,
    ...(decisions ? { influencedDecisions: decisions } : {}),
  };
  return reasoning;
};

// ── 1 流派选方 ──
await check("1.1 目录主治证候相容：桂枝汤对风寒束表证相容，对风热犯表证、四逆汤对风寒束表证不相容", () => {
  const signed = (syndrome) => ({ overview: { primarySyndrome: syndrome, primarySyndromeResolution: "bounded" } });
  assert.deepEqual([...indications.lineageFormulaSyndromeSupportedNames(signed("风寒束表证"), ["桂枝汤"])], ["桂枝汤"]);
  assert.equal(indications.lineageFormulaSyndromeSupportedNames(signed("风热犯表证"), ["桂枝汤"]).size, 0);
  assert.equal(indications.lineageFormulaSyndromeSupportedNames(signed("风寒束表证"), ["四逆汤"]).size, 0);
  assert.equal(indications.lineageFormulaSyndromeSupportedNames(signed("风寒束表证"), ["银翘散"]).size, 0);
  assert.equal(indications.lineageFormulaSyndromeSupportedNames({ overview: { primarySyndrome: "风寒束表证", primarySyndromeResolution: "unresolved" } }, ["桂枝汤"]).size, 0);
  assert.deepEqual(indications.lockableFormulaCatalogFunctions("桂枝汤"), ["解肌发表", "调和营卫"]);
});

await check("1.2 经方思路、模型写桂枝汤而治法照抄教材行：保留桂枝汤，治法改按桂枝汤功效写并接上对症一句", () => {
  const out = provenance.withDeterministicFormulaReferences(withChoice({ formula: "桂枝汤", therapy: "辛温解表，宣肺散寒，通窍止痒" }), undefined, "classical-formula");
  assert.equal(out.overview.recommendedFormulaDirection, "桂枝汤加减");
  assert.deepEqual(out.overview.recommendedFormulaNames, ["桂枝汤"]);
  assert.equal(out.therapy.overallMethod, "解肌发表，调和营卫，通窍止痒");
  assert.equal(out.overview.overallTherapy, "解肌发表，调和营卫，通窍止痒");
  // 幂等：再锚定一次不变。
  const again = provenance.withDeterministicFormulaReferences(out, undefined, "classical-formula");
  assert.equal(again.overview.recommendedFormulaDirection, "桂枝汤加减");
  assert.equal(again.therapy.overallMethod, "解肌发表，调和营卫，通窍止痒");
});

await check("1.3 模型治法已按方写时保留模型治法", () => {
  const out = provenance.withDeterministicFormulaReferences(withChoice({ formula: "桂枝汤", therapy: "解肌发表，调和营卫，宣肺通窍" }), undefined, "classical-formula");
  assert.equal(out.overview.recommendedFormulaDirection, "桂枝汤加减");
  assert.equal(out.therapy.overallMethod, "解肌发表，调和营卫，宣肺通窍");
});

await check("1.4 不限定流派 / 模型判不适用 / 非所选流派的方 / 与证候不相容的派内方 / 有兼证：改回教材代表方", () => {
  const base = { formula: "桂枝汤" };
  for (const [label, reasoning, lineage] of [
    ["不限定", withChoice(base), "unrestricted"],
    ["不适用", withChoice({ ...base, applicable: "not-applicable" }), "classical-formula"],
    ["温病思路选桂枝汤", withChoice(base), "warm-disease"],
    ["经方思路选四逆汤", withChoice({ formula: "四逆汤" }), "classical-formula"],
    ["有兼证", withChoice({ ...base, secondary: ["肺气虚证"] }), "classical-formula"],
  ]) {
    const out = provenance.withDeterministicFormulaReferences(reasoning, undefined, lineage);
    assert.equal(out.overview.recommendedFormulaDirection, "荆防败毒散加减", label);
  }
});

// ── 2 流派适配说明与交付方一致 ──
await check("2.1 改回教材方后，「选桂枝汤」那一条去掉；「麻黄汤…不符，暂不套用」「未套用葛根汤」保留", () => {
  const decisions = [
    { aspect: "方源选择", detail: "按经方方证相应选桂枝汤加减" },
    { aspect: "辨证视角", detail: "先辨六经表证，再核对方证眼目" },
    { aspect: "方源选择", detail: "麻黄汤等方证眼目不符，暂不套用" },
    { aspect: "方源选择", detail: "未套用葛根汤，改以疏风散寒为主" },
  ];
  const out = provenance.withDeterministicFormulaReferences(withChoice({ formula: "桂枝汤", applicable: "not-applicable", decisions }), undefined, "classical-formula");
  assert.equal(out.overview.recommendedFormulaDirection, "荆防败毒散加减");
  assert.deepEqual(out.lineageAdaptation.influencedDecisions.map((item) => item.detail), [
    "先辨六经表证，再核对方证眼目", "麻黄汤等方证眼目不符，暂不套用", "未套用葛根汤，改以疏风散寒为主",
  ]);
  assert.equal(out.lineageAdaptation.applicable, "not-applicable");
});

await check("2.2 交付的就是说明里的方时不动", () => {
  const decisions = [{ aspect: "方源选择", detail: "按经方方证相应选桂枝汤加减" }];
  const out = provenance.withDeterministicFormulaReferences(withChoice({ formula: "桂枝汤", decisions }), undefined, "classical-formula");
  assert.deepEqual(out.lineageAdaptation.influencedDecisions.map((item) => item.detail), ["按经方方证相应选桂枝汤加减"]);
});

// ── 3 经方思路下的方证采用规则 ──
await check("3.1 经方方证候选：只有经方思路多一条「采用方证」的规则；没有候选时仍为空串", () => {
  const pick = { patternName: "桂枝汤证", evidence: [{ quote: "汗出恶风", symptom: "汗出", approximate: false }, { quote: "脉浮缓", symptom: "脉浮缓", approximate: false }] };
  assert.ok(jingfang.jingfangPatternByName("桂枝汤证"), "方证表里应有桂枝汤证");
  const classical = jingfang.buildJingfangCandidateContext([pick], "classical-formula");
  const plain = jingfang.buildJingfangCandidateContext([pick], "unrestricted");
  assert.match(classical, /医生选定了经方思路/);
  assert.doesNotMatch(plain, /医生选定了经方思路/);
  assert.match(plain, /采用规则/);
  assert.equal(jingfang.buildJingfangCandidateContext([], "classical-formula"), "");
});

// ── 4 病历自述矛盾引文 ──
await check("4.1 自述矛盾引文保留全角逗号", () => {
  const quote = surface.recordedAccountConflict("现病史：患者口述腹痛“昨晚才开始”，又称三天前就因疼痛请假，时间线互相矛盾；无呕血。");
  assert.equal(quote, "患者口述腹痛“昨晚才开始”，又称三天前就因疼痛请假，时间线互相矛盾");
  assert.equal(surface.recordedAccountConflict("家属与本人对症状持续时间描述不同"), "家属与本人对症状持续时间描述不同");
});

// ── 5 中成药虚实方向 ──
await check("5.1 适应证写明实热的中成药：纯虚证（阴虚秘、气虚秘）判相反；热秘、阴虚火旺（虚实夹杂）、只看功能短句时不判", () => {
  const indication = "润肠通便。用于实热津亏便秘。";
  const conflict = (names, method, withIndication = true) => patent.patentMedicineDirectionConflict({
    clause: patent.medicineFunctionClause(indication), herbs: [], ...(withIndication ? { indication } : {}),
  }, { names, method });
  assert.equal(conflict("阴虚秘", "滋阴增液，润肠通便"), "excess_indication_for_deficiency");
  assert.equal(conflict("气虚秘", "益气润肠"), "excess_indication_for_deficiency");
  assert.equal(conflict("热秘", "泻热导滞，润肠通便"), undefined);
  assert.equal(conflict("阴虚火旺证", "滋阴降火"), undefined);
  assert.equal(conflict("阴虚秘", "滋阴增液，润肠通便", false), undefined);
  assert.equal(patent.patentMedicineDirectionConflict({ clause: "润肠通便", herbs: [], indication: "润肠通便。用于肠燥便秘。" }, { names: "阴虚秘", method: "滋阴增液" }), undefined);
});

// ── 6 小方方名 ──
await check("6.1 处方只有黄连、无吴茱萸：交付层不再把自拟方改名为「左金丸加减」；补上吴茱萸则沿用方名", () => {
  const fixture = JSON.parse(fs.readFileSync("scripts/fixtures/r1030-c018-prescribe.json", "utf8"));
  delete fixture._note;
  const asSelfDevised = (herbNames) => {
    const reasoning = structuredClone(fixture);
    const candidate = reasoning.formula.candidates[0];
    candidate.name = "本例辨证组方";
    candidate.formulaNames = [];
    candidate.formulaSource = { ...candidate.formulaSource, source: "自拟方" };
    candidate.herbs = herbNames.map((name) => ({ ...(candidate.herbs.find((herb) => herb.name === name) || candidate.herbs[0]), name }));
    return reasoning;
  };
  const without = surface.projectDeliveredReasoning(asSelfDevised(["黄连", "黄芩", "栀子", "海螵蛸", "陈皮", "佛手", "枳壳", "竹茹", "甘草"]));
  assert.doesNotMatch(without.formula.candidates[0].name, /左金丸/);
  const withBoth = surface.projectDeliveredReasoning(asSelfDevised(["黄连", "吴茱萸", "海螵蛸", "陈皮", "佛手", "甘草"]));
  assert.match(withBoth.formula.candidates[0].name, /^左金丸/);
});

// ── 7 西医急症诊断要点 ──
await check("7.1 急症诊断要点行：不可只凭临床表现诊断、列出确诊所需检查、带权威来源与逐字原文，且已人工核对", () => {
  const expected = {
    急性胰腺炎: /脂肪酶或淀粉酶/, 急性胆囊炎: /超声/, 急性心肌梗死: /肌钙蛋白/, 急性肺栓塞: /CTPA|肺动脉造影/, 蛛网膜下腔出血: /CT/,
  };
  for (const [name, test] of Object.entries(expected)) {
    const entry = criteria.westernCriteriaEntry(name);
    assert.ok(entry, `${name} 缺行`);
    assert.equal(entry.clinicallyDiagnosable, false, name);
    assert.ok(entry.requiredTests.some((item) => test.test(item)), `${name} 必需检查`);
    assert.ok(/^https?:\/\//.test(entry.url) && entry.quote.length > 20 && entry.reviewedAt === "2026-10-24", `${name} 来源/复核`);
  }
  // 急性胰腺炎三项占二：影像也是可确诊的检查（只列酶学会把做了 CT 的病例当缺检查）。
  assert.ok(criteria.westernCriteriaEntry("急性胰腺炎").requiredTests.some((item) => /CT|超声|MRI/.test(item)));
});

// ── 8 哺乳已结束 ──
await check("8.1 哺乳期过后/已过/结束、断奶后、停止哺乳 → 否认；未断奶、未停止哺乳、哺乳期间、目前哺乳期 → 阳性", () => {
  for (const text of ["产后哺乳期过后来月经痛经，量少，连续半年", "婚育史：产后，哺乳期已过", "哺乳期结束半年", "断奶后月经量少", "停止哺乳3个月"]) {
    assert.equal(clinicalState.assessLactationState(text).status, "negative", text);
  }
  for (const text of ["未断奶，哺乳中", "未停止哺乳", "哺乳期间口服布洛芬", "目前哺乳期", "产后4月，哺乳期", "哺乳期乳腺炎"]) {
    assert.equal(clinicalState.assessLactationState(text).status, "positive", text);
  }
  // 「尚未断奶已开始添加辅食」：未断奶不是否认（词形守卫）。
  assert.notEqual(clinicalState.assessLactationState("宝宝5个月，尚未断奶已开始添加辅食").status, "negative");
});

// ── 9 小便不禁 ──
await check("9.1 漏尿主诉召回小便不禁；两证的治法与代表方；针刺教材尿失禁节认「小便不禁」", () => {
  const candidates = textbook.textbookCandidatesForCase({ chiefComplaint: "运动、咳嗽时漏尿1年余", presentHistory: "咳嗽、运动后漏尿，身重体胖", sex: "女", ageYears: 48 });
  assert.ok(candidates.some((item) => item.disease === "小便不禁"), candidates.map((item) => item.disease).join("、"));
  const spleenLung = textbook.textbookRowForSyndrome("小便不禁", "脾肺气虚证");
  assert.deepEqual(spleenLung?.formulas, ["补中益气汤", "缩泉丸"]);
  assert.equal(spleenLung?.therapy, "补中益气，升提固摄");
  assert.deepEqual(textbook.textbookRowForSyndrome("小便不禁", "肾气不固证")?.formulas, ["金匮肾气丸"]);
  const protocols = JSON.parse(fs.readFileSync("src/data/tcm-nondrug-textbook-protocols.json", "utf8"));
  assert.ok(protocols.acupuncture.find((item) => item.disease === "尿失禁")?.aliases.includes("小便不禁"));
});

console.log(`\n${cases} checks`);
