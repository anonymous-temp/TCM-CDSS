/**
 * 备孕/未避孕的剂量口径（owner 2026-10-14 决定）。
 *
 * 此前「已记录妊娠、哺乳或备孕阳性/可疑状态」是一条独立硬边界：备孕、未避孕（含「未避孕1年未孕」的不孕症就诊）一律不给剂量。
 * 调研（~/runlogs/fix1014/research/D-tcm-rules.md §5）：药典的禁忌字样针对孕妇；《中医妇科学》不孕症一章与 2023 年《女性不孕症
 * 中西医结合诊疗指南》给这些患者开的都是有剂量的汤剂，含药典孕妇慎用的桂枝、牡丹皮、桃仁、红花、附子、肉桂。
 * 现口径：备孕/未避孕而妊娠、哺乳都不是阳性或可疑 ⇒ 照常给剂量；药典 2020 孕妇禁用/忌用的 37 味不进方（合同驱动修复、
 * 加减里直接剔除），慎用的 60 味逐味标注。妊娠、哺乳阳性或可疑（含停经、月经逾期）仍不给剂量。
 *
 * 此前没有任何一条断言钉着旧口径（改口径时全部套件照绿），这里两头都钉。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { withSafetyGate, derivePrescriptionPermission, hardDoseSafetyBoundaryReasons } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { conceptionWithoutPregnancyOrLactation } = await jiti.import("../src/lib/clinical-state.ts");
const policy = await jiti.import("../src/lib/conception-herb-policy.ts");
const { m04GenerationSpecialPopulationIssue } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const { compileM04Proposal } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");

let cases = 0;
const check = (name, run) => {
  cases += 1;
  try {
    const result = run();
    if (result && typeof result.then === "function") throw new Error("用例体不得是 async：异常会被吞掉");
  } catch (error) {
    process.exitCode = 1;
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
};

// ───── 1 数据 ─────
const labels = JSON.parse(readFileSync(path.join(repoRoot, "src/data/tcm-chp-pregnancy-herb-labels.source.json"), "utf8"));
check("1.1 药典 2020 孕妇禁用/忌用 37、慎用 60；两表不交叉；禁用表与医药导报 2023 统计的 37 味逐一相同", () => {
  assert.equal(labels.prohibited.length, 37);
  assert.equal(labels.caution.length, 60);
  const names = (rows) => rows.flatMap((row) => [row.name, ...(row.aliases || [])]);
  const prohibited = new Set(names(labels.prohibited));
  assert.deepEqual(names(labels.caution).filter((name) => prohibited.has(name)), []);
  assert.deepEqual(labels.prohibited.map((row) => row.name).sort(), [
    "三棱", "莪术", "土鳖虫", "水蛭", "全蝎", "蜈蚣", "斑蝥", "阿魏", "麝香", "两头尖", "商陆",
    "千金子", "千金子霜", "巴豆", "巴豆霜", "牵牛子", "甘遂", "京大戟", "芫花",
    "川乌", "草乌", "马钱子", "马钱子粉", "雄黄", "朱砂", "红粉", "轻粉",
    "闹羊花", "丁公藤", "天仙子", "洋金花", "猪牙皂", "黑种草子", "干漆", "罂粟壳", "大皂角", "天山雪莲",
  ].sort());
  for (const row of [...labels.prohibited, ...labels.caution]) assert.match(row.wording, /孕妇/, `${row.name} 的药典原文须写到孕妇`);
});
check("1.2 药名对应：制川乌是慎用、川乌/生川乌是禁用；醋三棱按三棱；酒大黄、附片按大黄、附子；半夏、川芎不在表内", () => {
  const level = (name) => policy.chpPregnancyLabel(name)?.level;
  assert.equal(level("制川乌"), "caution");
  assert.equal(level("川乌"), "prohibited");
  assert.equal(level("生川乌"), "prohibited");
  assert.equal(level("醋三棱"), "prohibited");
  assert.equal(level("酒大黄"), "caution");
  assert.equal(level("附片"), "caution");
  assert.equal(level("桃仁"), "caution");
  assert.equal(level("半夏"), undefined, "药典 2020 半夏条没有孕妇字样");
  assert.equal(level("川芎"), undefined, "药典 2020 川芎条没有孕妇字样");
});

check("1.3 药典【炮制】项的饮片与病历常见写法登记在所属品种下：醋芫花、炙甘遂按禁用，生薏苡仁、炒枳壳、盐牛膝按慎用（代码里不另写炮制前缀词表）", () => {
  const level = (name) => policy.chpPregnancyLabel(name)?.level;
  for (const name of ["醋芫花", "炙甘遂", "醋京大戟", "醋商陆", "炒牵牛子", "烫水蛭"]) assert.equal(level(name), "prohibited", name);
  for (const name of ["生薏苡仁", "炒枳壳", "麸炒枳实", "盐牛膝", "醋乳香", "燀桃仁", "蒲黄炭", "煅赭石"]) assert.equal(level(name), "caution", name);
  assert.doesNotMatch(readFileSync(path.join(repoRoot, "src/lib/conception-herb-policy.ts"), "utf8"), /\/\^\(\?:[^/]*炒/, "不另写炮制前缀正则");
});

// ───── 2 剂量授权 ─────
const SPARSE = { id: "conception-dose", phase: "prescribe", conversation: [], diagnosis: "", prescription: "", riskAssessment: "", maxQuestionRounds: 1 };
const COMPLETE = {
  tongue: "舌淡红苔薄白", pulse: "脉细", vitals: { T: "36.5℃", P: "72次/分", R: "16次/分", BP: "112/70mmHg" },
  pastHistory: "既往体健。", allergyHistory: "否认药物过敏。", medicationHistory: "近期未服药。",
};
const woman = (present, extra = {}) => ({ ...SPARSE, ...COMPLETE, questionRounds: 1, patient: { sex: "女", age: 31 },
  chiefComplaint: "月经量少半年", symptoms: { presentHistory: present }, ...extra });
const MATERNAL_REASON = "已记录妊娠、哺乳或备孕阳性/可疑状态";
const CONCEPTION = {
  备孕: woman("月经量少半年，色淡，经期2天。末次月经10天前。现备孕3个月。"),
  未避孕未孕: woman("月经量少半年，色淡。婚后未避孕1年未孕，末次月经12天前。"),
  计划妊娠: woman("月经量少半年，色淡，腰酸。有生育计划，末次月经8天前。"),
};
const HARD = {
  妊娠: woman("停经8周，B超提示宫内早孕。近来腰酸。"),
  哺乳: woman("产后4月，哺乳期，月经尚未恢复，腰酸乏力。"),
  备孕合并停经: woman("备孕半年，现月经推迟12天，自述可能怀孕。"),
};
check("2.1 备孕、未避孕、有生育计划：不再收回剂量，也不再是独立硬边界", () => {
  for (const [label, raw] of Object.entries(CONCEPTION)) {
    const state = withSafetyGate(raw);
    assert.notEqual(state.safetyGate.status, "red_flag", `夹具前提：${label} 无红旗`);
    const permission = derivePrescriptionPermission(state);
    assert.notEqual(permission.candidateMode, "non_dose_only", `${label}：${JSON.stringify(permission)}`);
    assert.ok(!permission.reasons.includes(MATERNAL_REASON), `${label}：理由里不得再有孕哺备孕硬边界`);
    assert.ok(!hardDoseSafetyBoundaryReasons(state).includes(MATERNAL_REASON), `${label}：M05 同一判据`);
  }
});
check("2.2 对照：妊娠、哺乳、备孕合并停经（可能已妊娠）仍按孕哺边界处理——剂量一致化（D4）后给剂量、采纳前须医生确认，原因写孕哺", () => {
  for (const [label, raw] of Object.entries(HARD)) {
    const state = withSafetyGate(raw);
    const permission = derivePrescriptionPermission(state);
    assert.equal(permission.candidateMode, "limited_dose", `${label}：${JSON.stringify(permission)}`);
    assert.equal(permission.formalAdoption, "eligible_after_doctor_confirmation", label);
    assert.ok(permission.reasons.includes(MATERNAL_REASON), label);
    assert.equal(conceptionWithoutPregnancyOrLactation(raw.symptoms.presentHistory), false, `${label} 不属于备孕档`);
  }
});

// ───── 3 M04 合同 ─────
const conceptionContext = "患者性别：女\n月经量少半年，色淡。现备孕3个月，末次月经10天前。";
// M04 的人群匹配按字面词认妊娠（妊娠/怀孕/孕妇/孕期），「停经8周，宫内早孕」它认不出——这是既有的口径分叉（安全闸门读受治理的
// 妊娠判据），妊娠病例本来就不给剂量，这里不扩大改动，对照用它认得的写法。
const pregnancyContext = "患者性别：女\n妊娠8周，B超提示宫内早孕，腰酸。";
check("3.1 备孕档：药典孕妇禁用的三棱驱动修复；药典只列为慎用的桃仁、红花、附子照用（知识库把它们记成孕期 HIGH，不得照它拦）", () => {
  assert.equal(m04GenerationSpecialPopulationIssue([{ name: "当归" }, { name: "三棱" }], conceptionContext), "herb_1_special_population_high_risk_pregnancy");
  assert.equal(m04GenerationSpecialPopulationIssue([{ name: "当归" }, { name: "桃仁" }, { name: "红花" }, { name: "附子" }], conceptionContext), undefined);
});
check("3.2 对照：已确认妊娠的仍按知识库孕期 HIGH 规则拦桃仁", () => {
  assert.match(m04GenerationSpecialPopulationIssue([{ name: "当归" }, { name: "桃仁" }], pregnancyContext) || "", /special_population_high_risk_pregnancy/);
});

// ───── 4 编译器 ─────
const prior = ReasoningV2Schema.parse({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "月经过少", primarySyndrome: "血瘀证", overallPathogenesis: "瘀血内停，冲任阻滞", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "月经量少，色暗有块", syndromeEvidence: "月经量少，色暗有块", pathogenesis: "瘀血内停，冲任阻滞", therapyDirection: "活血化瘀调经" }] },
  therapy: { overallPrinciple: "实则泻之", overallMethod: "活血化瘀，养血调经", subTherapies: [{ therapy: "活血化瘀", targetPathogenesis: "瘀血内停", priority: "主要" }] },
  formula: { candidates: [], patentAndWestern: [], modifications: [] },
});
const compile = (caseState) => compileM04Proposal({
  candidate: {
    name: "自拟方", applicable: "月经量少色暗。", notApplicable: "出血量多时停用。",
    herbs: [
      { name: "当归", dose: "10g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "养血活血调经" },
      { name: "桃仁", dose: "9g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "活血祛瘀" },
      { name: "川芎", dose: "6g", role: "佐", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "活血行气" },
      { name: "炙甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "调和诸药" },
    ].map((herb) => ({ ...herb, processing: null, isToxic: false, decoctionRequirement: null })),
    formulaAnalysis: "当归养血活血为君，桃仁活血祛瘀为臣，川芎活血行气为佐，炙甘草调和诸药为使。",
    decoction: { doseCount: "7剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，煎服", followUpNode: "7日复诊" },
  },
  patentAndWestern: [],
  modifications: [
    { trigger: "色暗有块", targetRef: "P1", actionType: "add", herbName: "三棱", dose: "6g", reason: "破血行气" },
    { trigger: "色暗有块", targetRef: "P1", actionType: "add", herbName: "益母草", dose: "15g", reason: "活血调经" },
  ],
  nonPharma: { diet: "宜温热易消化饮食，经期忌生冷。", lifestyle: "规律作息。", emotion: "调畅情志。", precautions: [], tcmTreatments: [] },
}, prior, caseState);
const conceptionCase = { ...CONCEPTION.备孕, symptoms: { presentHistory: "月经量少半年，色暗有块。现备孕3个月，末次月经10天前。" } };
const plainCase = { ...CONCEPTION.备孕, symptoms: { presentHistory: "月经量少半年，色暗有块。现否认妊娠，无备孕计划，已避孕。" } };
check("4.1 备孕档：方中孕妇慎用药（桃仁）在该味核对说明里写明药典原文与「使用前确认未妊娠」；川芎（药典无孕妇字样）不写", () => {
  const herbs = compile(conceptionCase).formula.candidates[0].herbs;
  const note = (name) => (herbs.find((herb) => herb.name === name)?.verificationReasons || []).join("｜");
  assert.match(note("桃仁"), /药典2020「孕妇慎用。」本例备孕\/未避孕，使用前请确认未妊娠/, note("桃仁"));
  assert.doesNotMatch(note("川芎"), /备孕/);
  assert.doesNotMatch(note("当归"), /备孕/);
});
check("4.2 备孕档：加减里加药典孕妇禁用的三棱整条不列，加慎用的益母草照列并在说明里写明；非备孕病例两条都照列（对照）", () => {
  const formula = compile(conceptionCase).formula;
  assert.deepEqual(formula.modifications.map((item) => item.herbName), ["益母草"]);
  assert.match(formula.modifications[0].riskNote, /孕妇慎用/);
  assert.ok(formula.modificationReview.droppedReasons.some((item) => item.code === "special_population_conflict"));
  const control = compile(plainCase).formula;
  assert.ok(control.modifications.some((item) => item.herbName === "三棱"), JSON.stringify(control.modifications.map((item) => item.herbName)));
  assert.doesNotMatch((control.candidates[0].herbs.find((herb) => herb.name === "桃仁")?.verificationReasons || []).join(""), /备孕/);
});

// ───── 5 提示词 ─────
check("5.1 M04 提示词：备孕档列出药典孕妇禁用饮片并要求慎用药写明（与合同、编译器同一判据）", () => {
  const route = readFileSync(path.join(repoRoot, "src/app/api/diagnosis/prescribe/route.ts"), "utf8");
  // 2026-10-24 第十七轮：备孕档与「妊娠状态未记录」档共用 chpPregnancyHerbTier（conception-herb-policy），路由按档写两段提示。
  assert.match(route, /const pregnancyHerbTier = chpPregnancyHerbTier\(groundingText\);/);
  assert.match(route, /if \(pregnancyHerbTier === "conception"\) \{\s*promptSuffixes\.push\(`【备孕\/未避孕】/);
  assert.equal(policy.chpPregnancyHerbTier("患者年龄：30岁\n患者性别：女\n未避孕1年未孕"), "conception");
  assert.match(route, /chpPregnancyProhibitedHerbNames\(\)\.join\("、"\)/);
  assert.equal(policy.chpPregnancyProhibitedHerbNames().length, 37);
});

console.log(JSON.stringify({ suite: "conception-dose-policy", cases, failures: process.exitCode ? "see above" : 0 }));
