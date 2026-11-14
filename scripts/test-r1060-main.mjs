// 第四十四轮（2026-11-14）：甲方澄清「病机数据、复诊计划、中成药推荐按接口原始数据核对」之后，按接口数据收口没改完的类。
//  1. 随证加减只给本例眼下已有表现的加减：备用「若…」加减甲方页面默认勾选、没有让医生确认的地方，评审按患者实际病情判
//    （11.05 病历10「若带下量多而清稀、小腹发凉，加艾叶」）。编译、补写、交付面同一判据（presentModificationCondition）。
//  2. 西医依据一句里既说「诊断已确立」又说「尚缺检查确认」（11.05 病历5 复测）：既往已确诊的写「既往已确诊X，本次未复查Y」，
//    否则写「考虑X」；依据里引用病历没有的检查（「结合血象」）去掉。
//  3. 红旗病例的证候把握度说明与待核实项里「并记录排除或处置依据」「风险解除前本方不能正式采纳」这类流程话换成临床写法。
//  4. 证候层：病位、病性两轴都已定、舌脉齐全时，模型写的「有界」按已确定交付，理由挪进待核实栏。
//  5. 待核实栏里自己说「已明」「已排除」的条目不留；证素核对的不确定项写成「本例未见X的辨证要点…成组出现」（舌脉净化不改要点原文）。
//  6. 中成药：说明书「尚不明确」占位不进风险说明；使用边界取说明书疗程句、与汤剂关系按定位写，不再交付空串。
//  7. 辅助检查里贴着别人的报告（「6岁女童」「38岁男性」贴进 30 岁男性的辅助检查）：不当本人年龄冲突、照常给剂量，给医生提示。
//  8. 复诊：孕期提示不写「腹痛加重」（无腹痛者）；急诊表现不写「如出现突然出现」。
//  9. 真心痛：教材「伴有汗出」，「大汗」算危候表现（11/12 病历16 辨成虚脱·正虚阳脱证）。
// 每条断言都有反证（~/runlogs/r1018/work/r1060/cp/）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
let failures = 0;
const check = async (name, run) => {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};
const readSource = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const claims = await jiti.import("../src/lib/recorded-test-claims.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const pool = await jiti.import("../src/lib/instruction-record-pool.ts");
const basis = await jiti.import("../src/lib/western-basis-authoring.server.ts");
const trueHeart = await jiti.import("../src/lib/true-heart-pain.ts");
const history = await jiti.import("../src/lib/history-stated-textbook-disease.ts");

// ───── 1 随证加减只给本例已有的表现 ─────
const RECORD1 = "患者恶寒重，发热轻，无汗，头痛连及项背，咳嗽较剧，咳白稀痰，纳差，大便偏干。无口渴，无咽痛。";
await check("1.1 presentModificationCondition：病历另用程度词写着同一症状（恶寒重之于若恶寒甚、咳嗽较剧之于若咳嗽甚）算已见；「加重」不算程度；否认的、没有的不算", () => {
  const present = (trigger, record = RECORD1) => compiler.presentModificationCondition(trigger, record)?.trigger;
  assert.equal(present("若恶寒甚"), "本例已见恶寒重");
  assert.equal(present("若咳嗽较甚"), "本例已见咳嗽较剧");
  assert.equal(present("若恶寒甚", "恶寒，发热，无汗。"), undefined, "只写了恶寒、没有程度：仍是将来的变化");
  assert.equal(present("若恶寒甚", "恶寒加重2天，发热。"), undefined, "「加重」是病情变化，不是程度");
  assert.equal(present("若口渴"), undefined, "病历否认");
  assert.equal(present("若咽痛"), undefined, "病历否认");
  assert.equal(present("若胁痛"), undefined, "病历没有");
  assert.equal(present("若纳差"), "本例已见纳差");
});

await check("1.2 presentModificationCondition：整句逐字是病历原话（含「及」）照原话写，不切成两段；「本例已见X」再判一次幂等", () => {
  assert.equal(compiler.presentModificationCondition("头痛连及项背", RECORD1)?.trigger, "本例已见头痛连及项背");
  assert.equal(compiler.presentModificationCondition("本例已见头痛连及项背", RECORD1)?.trigger, "本例已见头痛连及项背");
  assert.equal(compiler.presentModificationCondition("饭后胃脘胀满", "近一月饭后胃脘胀满，嗳气。")?.trigger, "本例已见饭后胃脘胀满");
});

await check("1.3 modificationRowPresentNow：病历原话触发（不带若）是已见；「若X」看病历；缺省不交付备用加减，CDSS_STANDBY_MODIFICATIONS=true 时照旧交付", () => {
  assert.equal(compiler.modificationRowPresentNow("大便偏干", RECORD1), true);
  assert.equal(compiler.modificationRowPresentNow("若大便偏干", RECORD1), true);
  assert.equal(compiler.modificationRowPresentNow("若带下量多而清稀、小腹发凉", "带下量多色白质稀3月，腰酸。"), false);
  assert.equal(compiler.standbyModificationsDelivered(), false);
  process.env.CDSS_STANDBY_MODIFICATIONS = "true";
  try {
    assert.equal(compiler.standbyModificationsDelivered(), true);
  } finally {
    delete process.env.CDSS_STANDBY_MODIFICATIONS;
  }
});

const RECORD_DAIXIA = "带下量多、色白质稀3月，伴腰酸、神疲乏力，纳少便溏。舌淡，苔白，脉缓弱。";
function deliveredFormula(modifications) {
  return {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    overview: { tcmDiseaseName: "带下过多", primarySyndrome: "脾虚证", primarySyndromeBasis: ["带下量多、色白质稀"] },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "带下量多、色白质稀", pathogenesis: "脾虚湿注" }] },
    formula: { candidates: [], modifications },
  };
}
await check("1.4 交付面：备用加减（若带下量多而清稀、小腹发凉，加艾叶）不交付；条件病历已有的改写成「本例已见」；病历原话触发照留；幂等", () => {
  const rows = [
    { trigger: "若带下量多而清稀、小腹发凉", action: "加", herbName: "艾叶", reason: "温经散寒" },
    { trigger: "若便溏", action: "加", herbName: "炒白扁豆", reason: "健脾化湿" },
    { trigger: "腰酸", action: "加", herbName: "续断", reason: "补肝肾" },
  ];
  const out = surface.projectDeliveredReasoning(deliveredFormula(rows), { recordText: RECORD_DAIXIA });
  const triggers = out.formula.modifications.map((row) => row.trigger);
  assert.deepEqual(triggers, ["本例已见便溏", "腰酸"]);
  const again = surface.projectDeliveredReasoning(out, { recordText: RECORD_DAIXIA });
  assert.deepEqual(again.formula.modifications.map((row) => row.trigger), triggers);
  process.env.CDSS_STANDBY_MODIFICATIONS = "true";
  try {
    const legacy = surface.projectDeliveredReasoning(deliveredFormula(rows), { recordText: RECORD_DAIXIA });
    assert.equal(legacy.formula.modifications.length, 3, "回退开关：备用加减照旧交付");
  } finally {
    delete process.env.CDSS_STANDBY_MODIFICATIONS;
  }
  const noRecord = surface.projectDeliveredReasoning(deliveredFormula(rows), {});
  assert.equal(noRecord.formula.modifications.length, 3, "拿不到病历原文时不删");
});

const PRIOR = {
  stage: "diagnose",
  overview: { tcmDiseaseName: "带下过多", primarySyndrome: "脾虚证", primarySyndromeBasis: ["带下量多、色白质稀"], secondarySyndromes: [] },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "带下量多、色白质稀", pathogenesis: "脾气虚弱，运化失职，湿浊下注", therapyDirection: "健脾益气，升阳除湿" }] },
  therapy: { overallMethod: "健脾益气，升阳除湿" },
  westernDiagnosis: { primary: { name: "阴道炎待查", supportingFacts: [] } },
};
const CASE_DAIXIA = { chiefComplaint: "带下量多3月", patient: { age: 42, sex: "女" }, symptoms: { 现病史: RECORD_DAIXIA } };
await check("1.5 补写的加减：条件是病历已有的表现时交付「本例已见X」、依据是病历原句、针对写该表现本身的病机；条件病历没有（若…）时不补", () => {
  const ok = compiler.topUpModificationRow(
    { trigger: "纳少便溏", herbName: "炒白扁豆", dose: "15g", reason: "健脾化湿止泻", symptomPathogenesis: "脾虚湿盛，清浊不分" },
    { prior: PRIOR, caseState: CASE_DAIXIA, candidateHerbNames: ["白术", "山药", "人参"], existingTriggers: [] },
  );
  assert.ok(ok, "病历已有的表现应能补");
  assert.equal(ok.trigger, "本例已见纳少便溏");
  assert.match(ok.evidence.source, /^患者原文：/u);
  assert.equal(ok.targetPathogenesis, "脾虚湿盛，清浊不分");
  const standby = compiler.topUpModificationRow(
    { trigger: "若小腹发凉", herbName: "艾叶", dose: "6g", reason: "温经散寒" },
    { prior: PRIOR, caseState: CASE_DAIXIA, candidateHerbNames: ["白术", "山药", "人参"], existingTriggers: [] },
  );
  assert.equal(standby, undefined, "备用条件不补");
  const repeat = compiler.topUpModificationRow(
    { trigger: "纳少便溏", herbName: "炒白扁豆", dose: "15g", reason: "健脾化湿止泻" },
    { prior: PRIOR, caseState: CASE_DAIXIA, candidateHerbNames: ["白术", "山药", "人参"], existingTriggers: ["本例已见纳少便溏"] },
  );
  assert.equal(repeat, undefined, "已有的条件不重复补");
});

await check("1.6 提示词：开方要求只写本例已有表现的加减、trigger 写病历原话不带「若」；补写提示词同一口径；回退开关保留旧补写提示词", () => {
  const prompts = readSource("../src/lib/diagnosis-prompts.ts");
  assert.match(prompts, /\*\*不写备用加减\*\*/u);
  assert.match(prompts, /trigger 逐字写病历里这个表现的原话（2–12 字，不带“若”/u);
  assert.doesNotMatch(prompts, /有【教材加减】时 modifications 不得为空/u);
  const fit = readSource("../src/lib/m04-modification-fit.server.ts");
  assert.match(fit, /不写「若…」这种以后才可能出现的备用条件/u);
  assert.match(fit, /standbyModificationsDelivered\(\) \? STANDBY_TOP_UP_SYSTEM : TOP_UP_SYSTEM/u);
});

const PRIOR_HEADACHE = {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "头痛", primarySyndrome: "痰浊头痛", primarySyndromeBasis: ["头痛昏蒙，胸脘满闷", "呕恶痰涎"], recommendedFormulaNames: [], formulaSelectionMode: "self_devised", recommendedFormulaDirection: "半夏白术天麻汤加减" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "头痛昏蒙，胸脘满闷，呕恶痰涎", pathogenesis: "脾失健运，痰浊中阻，上蒙清窍", therapyDirection: "健脾燥湿，化痰降逆" }] },
  therapy: { overallMethod: "健脾燥湿，化痰降逆", overallPrinciple: "实则泻之" },
  westernDiagnosis: { primary: { name: "头痛", supportingFacts: ["头痛昏蒙"] }, differentials: [] },
};
const headacheHerb = (name, dose, role) => ({ name, dose, role, targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "燥湿化痰", processing: null, isToxic: false, decoctionRequirement: null });
const headacheProposal = (modifications) => ({
  candidate: {
    name: "半夏白术天麻汤加减", applicable: "痰浊头痛。", notApplicable: "阴虚阳亢者不宜。",
    herbs: [headacheHerb("法半夏", "9g", "君"), headacheHerb("天麻", "10g", "君"), headacheHerb("白术", "12g", "臣"), headacheHerb("茯苓", "12g", "臣"), headacheHerb("陈皮", "6g", "佐"),
      { ...headacheHerb("甘草", "3g", "使"), targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "调和诸药" }],
    formulaAnalysis: "本方以半夏白术天麻汤为基础加减。法半夏燥湿化痰、天麻平肝息风共为君，白术、茯苓健脾祛湿为臣，陈皮理气化痰为佐，甘草调和诸药为使。",
    decoction: { doseCount: "7剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日1剂，水煎分两次温服", followUpNode: "服完7剂复诊" },
  },
  patentAndWestern: [], modifications,
  nonPharma: { diet: "饮食清淡，少食肥甘。", lifestyle: "规律作息。", emotion: "保持心情舒畅。", tcmTreatments: [], precautions: ["若头痛突然加剧，须及时就医。"] },
});
const HEADACHE_CASE = { chiefComplaint: "头痛昏蒙2周", patient: { age: 45, sex: "男" }, symptoms: { 现病史: "头痛昏蒙2周，胸脘满闷，呕恶痰涎，纳呆。舌胖大，苔白腻，脉滑。" } };
await check("1.7 编译：模型写的备用加减（若见口苦、苔黄腻→黄连）不列、记「备用加减」原因；病历已有的表现（纳呆）照列；教材条目只补条件本例已有的；回退开关下备用加减照列", () => {
  const rows = [
    { trigger: "若见口苦，大便不畅，舌苔黄腻，脉滑数", targetRef: "P1", actionType: "add", herbName: "黄连", dose: "3g", reason: "清热燥湿", symptomPathogenesis: "痰浊化热" },
    { trigger: "纳呆", targetRef: "P1", actionType: "add", herbName: "焦神曲", dose: "10g", reason: "消食和胃", symptomPathogenesis: "痰湿困脾，运化失职" },
  ];
  const out = compiler.compileM04Proposal(headacheProposal(rows), PRIOR_HEADACHE, HEADACHE_CASE);
  const delivered = out.formula.modifications;
  assert.ok(delivered.length >= 1);
  assert.ok(delivered.every((row) => !/^\s*若/u.test(row.trigger) || compiler.presentModificationCondition(row.trigger, HEADACHE_CASE.symptoms.现病史)), "只交付本例已有表现的加减");
  assert.ok(!delivered.some((row) => row.herbName === "黄连"));
  assert.ok(delivered.some((row) => /神曲/u.test(row.herbName)));
  assert.ok((out.formula.modificationReview?.droppedReasons || []).some((item) => item.code === "trigger_not_present"));
  process.env.CDSS_STANDBY_MODIFICATIONS = "true";
  try {
    const legacy = compiler.compileM04Proposal(headacheProposal(rows), PRIOR_HEADACHE, HEADACHE_CASE);
    assert.ok(legacy.formula.modifications.some((row) => /^\s*若/u.test(row.trigger)), "回退口径：教材备用加减照列");
  } finally {
    delete process.env.CDSS_STANDBY_MODIFICATIONS;
  }
});

await check("1.8 触发条件写的是正常或一般情况（饮食睡眠一般、纳可、二便调）不作加减；部位加症状（肢体麻木）在病历同一句里才算已见、写回原词", () => {
  for (const t of ["饮食睡眠一般", "纳可", "二便调", "精神尚可"]) assert.equal(compiler.modificationTriggerIsNormalState(t), true, t);
  for (const t of ["纳差", "饮食减少", "睡眠差", "大便溏薄"]) assert.equal(compiler.modificationTriggerIsNormalState(t), false, t);
  const rows = [{ trigger: "饮食睡眠一般", targetRef: "P1", actionType: "add", herbName: "焦神曲", dose: "10g", reason: "消食和胃" }];
  const record = { ...HEADACHE_CASE, symptoms: { 现病史: `${HEADACHE_CASE.symptoms.现病史}饮食睡眠一般。` } };
  const out = compiler.compileM04Proposal(headacheProposal(rows), PRIOR_HEADACHE, record);
  assert.ok(!out.formula.modifications.some((row) => row.trigger === "饮食睡眠一般"));
  assert.ok((out.formula.modificationReview?.droppedReasons || []).some((item) => item.code === "trigger_not_symptom"));
  assert.equal(compiler.modificationConditionAlreadyPresent("若肢体麻木", "左侧肢体乏力麻木6月。")?.trigger, "本例已见肢体麻木");
  assert.equal(compiler.modificationConditionAlreadyPresent("若肢体麻木", "左侧肢体乏力6月。手指麻木。"), undefined, "部位与症状不在同一句：不是这个表现");
  assert.equal(compiler.modificationConditionAlreadyPresent("若纳呆腹胀", "食欲不振、食后腹胀。")?.trigger, "本例已见纳呆、腹胀", "两个症状照旧分开写");
});

await check("1.10 同一味药只加一次：两行都加瓜蒌子时留第一行；加不同的药、调整行不动", () => {
  const rows = [
    { trigger: "咳嗽、咳黄黏痰", action: "加", herbName: "瓜蒌子" },
    { trigger: "咳嗽、咳黄黏痰", action: "加", herbName: "苦杏仁" },
    { trigger: "大便偏干", action: "加", herbName: "瓜蒌子" },
    { trigger: "口干", action: "调整", herbName: "芦根" },
  ];
  assert.deepEqual(compiler.withoutRepeatedAddedHerbs(rows).map((row) => `${row.trigger}|${row.herbName}`), ["咳嗽、咳黄黏痰|瓜蒌子", "咳嗽、咳黄黏痰|苦杏仁", "口干|芦根"]);
  const out = surface.projectDeliveredReasoning(deliveredFormula([
    { trigger: "便溏", action: "加", herbName: "炒白扁豆", reason: "健脾" },
    { trigger: "腰酸", action: "加", herbName: "白扁豆", reason: "重复" },
  ]), { recordText: RECORD_DAIXIA });
  assert.equal(out.formula.modifications.length, 1);
});

await check("1.9 证素核对按交付时的合称证名判涵盖：教材单证（心血不足证）将换成心脾两虚证时，「心气亏虚」不当名外证素", async () => {
  const element = await jiti.import("../src/lib/m03-element-support.server.ts");
  const root = {
    overview: { tcmDiseaseName: "心悸", primarySyndrome: "心血不足证", secondarySyndromes: [], tcmDiagnosticRationale: "心悸阵发、气短乏力为心气不足；失眠健忘、面色少华为血不养心。", overallPathogenesis: "心气亏虚则鼓动无力而心悸气短，劳则更甚；脾气不足则运化失职。" },
    pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "心气亏虚，鼓动无力，心失所养" }, { nodeId: "P2", pathogenesis: "脾气不足，运化失职" }], natureDifferentiation: { items: ["气虚", "血虚"] } },
  };
  assert.ok(element.elementCheckUnits(root).some((unit) => unit.type === "气虚"), "换名前：心气虚、脾气虚是名外证素");
  assert.ok(!element.elementCheckUnits(root, ["心脾两虚证"]).some((unit) => unit.type === "气虚"), "按合称判：心脾两虚涵盖心、脾气虚");
  assert.match(readSource("../src/lib/m03-element-support.server.ts"), /const renamed = compositeSyndromeRename\(structuredClone\(root\), context\.recordText\);\n  const alsoNamed = renamed \? \[renamed\.to\] : \[\];/u);
});

// ───── 2 西医依据 ─────
const REC5 = "上腹部胀满、纳差2月，餐后加重。既往史：慢性浅表性胃炎病史2年。否认消化性溃疡史。";
await check("2.1 依据一句里既说诊断已确立又说尚缺检查确认：既往已确诊的写「既往已确诊X」「本次未复查Y」，否则写「考虑X」；缺的是病因部位那一层的不动", () => {
  assert.equal(
    claims.westernBasisWithoutEstablishmentContradiction("既往有慢性浅表性胃炎病史2年，慢性浅表性胃炎诊断已确立；但尚缺胃镜及幽门螺杆菌检测确认，需排除消化性溃疡。", "慢性浅表性胃炎", REC5),
    "既往有慢性浅表性胃炎病史2年，既往已确诊慢性浅表性胃炎；本次未复查胃镜及幽门螺杆菌检测，需排除消化性溃疡。",
  );
  assert.equal(
    claims.westernBasisWithoutEstablishmentContradiction("经期腹泻2月，经期腹泻诊断成立；但尚缺粪常规检查确认，需排除肠炎。", "经期腹泻", "经期腹泻2月"),
    "经期腹泻2月，考虑经期腹泻；尚缺粪常规检查确认，需排除肠炎。",
    "主诉里的症状名不是既往确诊",
  );
  const sublevel = "反复鼻出血3天，鼻出血诊断成立；尚缺鼻内镜等检查明确出血部位及病因，需排除血液系统疾病。";
  assert.equal(claims.westernBasisWithoutEstablishmentContradiction(sublevel, "鼻出血", "反复鼻出血3天"), sublevel);
  const sublevelConfirm = "反复鼻出血3天，鼻出血诊断成立；尚缺鼻内镜检查确认出血部位，需排除血液系统疾病。";
  assert.equal(claims.westernBasisWithoutEstablishmentContradiction(sublevelConfirm, "鼻出血", "反复鼻出血3天"), sublevelConfirm, "缺的检查是为了确认部位：不算矛盾");
  const clean = "上腹胀满2月，考虑慢性胃炎；尚缺胃镜确认。";
  assert.equal(claims.westernBasisWithoutEstablishmentContradiction(clean, "慢性胃炎待查", REC5), clean);
});

await check("2.2 依据里引用病历没有的检查（结合血象、血常规示…）去掉；病历有这项结果时不动", () => {
  const rec = "咽痛流涕发热2天，咽部充血。";
  assert.equal(claims.withoutUnrecordedTestCitations("咽痛发热2天，结合血象及查体，符合急性上呼吸道感染。", rec), "咽痛发热2天，结合查体，符合急性上呼吸道感染。");
  assert.equal(claims.withoutUnrecordedTestCitations("咽痛发热2天，结合血象，符合急性上呼吸道感染。", rec), "咽痛发热2天，符合急性上呼吸道感染。");
  assert.equal(claims.withoutUnrecordedTestCitations("发热咳嗽3天，血常规示白细胞升高，考虑急性支气管炎。", "发热咳嗽3天"), "发热咳嗽3天，考虑急性支气管炎。");
  const kept = "发热咳嗽3天，血常规示白细胞升高，考虑急性支气管炎。";
  assert.equal(claims.withoutUnrecordedTestCitations(kept, "发热咳嗽3天。血常规：WBC 12.5×10^9/L"), kept);
});

await check("2.3 依据写作核对：同时写「诊断已确立」与「尚缺…确认」、或写「未记录」的成句不采用", () => {
  const context = { name: "慢性浅表性胃炎", recordText: REC5, criteria: undefined };
  const proposal = (text) => ({ summary: "", criteria: [{ point: "上腹胀满", quote: "上腹部胀满" }], negatives: [], established: "yes", level: "既往已确诊，本次未复查胃镜", exclude: [], text });
  assert.equal(basis.westernBasisIssue(proposal("中年男性上腹部胀满、纳差2月，餐后加重，慢性浅表性胃炎诊断已确立；但尚缺胃镜复查确认，既往已确诊，本次未复查胃镜。"), context), "text_contradicts_establishment");
  assert.equal(basis.westernBasisIssue(proposal("中年男性上腹部胀满、纳差2月，餐后加重，阴性所见未记录，慢性浅表性胃炎既往已确诊，本次未复查胃镜。"), context), "text_meta");
});

// ───── 3 红旗边界句 ─────
await check("3.1 红旗病例的把握度说明、待核实项、红旗处置三处的流程话换成临床写法，锚点「急危重风险未排除」不变；幂等", () => {
  const a = "急危重风险未排除：以下辨证、病机与治法结论供医生参考，请先完成急诊或转诊评估并记录排除或处置依据；风险解除前本方不能正式采纳。\n\n舌脉未记录";
  const out = surface.clinicalWordingForSyntheticPhrases(a);
  assert.equal(out, "急危重风险未排除，请先完成急诊或转诊评估；以下辨证供医生参考。\n\n舌脉未记录");
  assert.equal(surface.clinicalWordingForSyntheticPhrases(out), out);
  assert.equal(
    surface.clinicalWordingForSyntheticPhrases("急危重风险未排除：请优先完成急诊或转诊评估并记录排除或处置依据；以下辨证与治法结论供医生参考，正式采纳须在风险处置之后。"),
    "急危重风险未排除，请优先完成急诊或转诊评估；以下辨证与治法供医生参考。",
  );
  assert.equal(surface.clinicalWordingForSyntheticPhrases("本次辨证、病机与治法结论供医生参考；正式采纳需先完成上述事项。"), "辨证与治法待急诊评估后再确认。");
});

await check("3.2 「无力」不是否认线索：「心气亏虚则鼓动无力而心悸气短」不因病历有心悸而被当作否认删掉；真否认照改", () => {
  const state = { chiefComplaint: "心悸、气短、乏力3月", patient: { age: 45, sex: "女" }, symptoms: { 现病史: "心悸阵发，劳累后加重，气短乏力，神疲懒言。" }, tongue: "舌质淡，苔薄白", pulse: "脉细弱" };
  const kept = "心气亏虚则鼓动无力而心悸气短，心血不足则心神失养。";
  assert.equal(safety.sanitizeUngroundedRedFlagNegations(kept, state), kept);
  assert.doesNotMatch(safety.sanitizeUngroundedRedFlagNegations("无心悸，属心悸病。", state), /无心悸/u);
});

// ───── 4 证候层把握度 ─────
const RECORD4 = "双膝疼痛、屈伸不利2年，腰膝酸软，畏寒。舌淡，苔白，脉沉细弱。";
function diagnose4(reason, extra = {}) {
  return {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    overview: { tcmDiseaseName: "痹证", primarySyndrome: "肝肾两虚证", primarySyndromeResolution: "bounded", primarySyndromeResolutionReason: reason, evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "低" }, ...extra },
    pathogenesis: {
      locationDifferentiation: { resolution: "resolved", items: ["肝", "肾"] },
      natureDifferentiation: { resolution: "resolved", items: ["虚"] },
      chain: [{ nodeId: "P1", patientFact: "腰膝酸软", pathogenesis: "肝肾亏虚，筋骨失养" }],
      uncertainties: [],
    },
    westernDiagnosis: { primary: { name: "膝骨关节炎", clinicalRationale: "老年双膝疼痛2年，考虑膝骨关节炎。" } },
    therapy: {},
  };
}
await check("4.1 证候层：病位、病性两轴已定、舌脉齐全时，模型写的「有界」按已确定交付、置信度「中」，理由进待核实栏；缺舌脉、红旗、轴未定时照旧", () => {
  const out = surface.projectDeliveredReasoning(diagnose4("关节肿胀、晨僵时长未记录，寒热虚实细节待复诊"), { recordText: RECORD4 });
  assert.equal(out.overview.primarySyndromeResolution, "resolved");
  assert.equal(out.overview.primarySyndromeResolutionReason, undefined);
  assert.equal(out.overview.evidence.confidence, "中");
  assert.ok(out.pathogenesis.uncertainties.some((row) => row.reason === "关节肿胀、晨僵时长未记录，寒热虚实细节待复诊"));
  const noPulse = surface.projectDeliveredReasoning(diagnose4("关节肿胀未记录"), { recordText: "双膝疼痛2年，舌淡，苔白。" });
  assert.equal(noPulse.overview.primarySyndromeResolution, "bounded");
  const redFlag = surface.projectDeliveredReasoning(diagnose4("急危重风险未排除：以下辨证、病机与治法结论供医生参考，请先完成急诊或转诊评估并记录排除或处置依据；风险解除前本方不能正式采纳。"), { recordText: RECORD4 });
  assert.equal(redFlag.overview.primarySyndromeResolution, "bounded");
  const axis = diagnose4("寒热待定");
  axis.pathogenesis.natureDifferentiation.resolution = "bounded";
  assert.equal(surface.projectDeliveredReasoning(axis, { recordText: RECORD4 }).overview.primarySyndromeResolution, "bounded");
});

// ───── 5 待核实栏 ─────
await check("5.1 待核实项自己说已经定了（已明、已排除）的不留；仍有待核实说法的照留", () => {
  assert.equal(surface.uncertaintyAlreadySettled({ item: "有汗无汗已明", reason: "已记录无汗，表实可定" }), true);
  assert.equal(surface.uncertaintyAlreadySettled({ item: "是否兼血瘀", reason: "舌暗已明，但刺痛是否夜甚待问" }), false);
  assert.equal(surface.uncertaintyAlreadySettled({ item: "寒热", reason: "寒热喜恶未记录" }), false);
  assert.equal(surface.uncertaintyAlreadySettled({ item: "症状明显程度", reason: "已明显减轻" }), false, "「已明显」不是「已明」");
});

await check("5.2 证素核对的不确定项：要点与「未见」同一小句（逗号换顿号），舌脉净化不把要点原文改成「脉象待核实」", () => {
  const src = readSource("../src/lib/m03-element-support.server.ts");
  assert.match(src, /本例未见\$\{label\}的辨证要点（\$\{keyPoints\}）成组出现/u);
  const reason = "本例未见血虚的辨证要点（面、睑、唇、舌色淡白、脉细）成组出现";
  const state = { chiefComplaint: "头晕乏力1月", patient: { age: 45, sex: "女" }, symptoms: { 现病史: "头晕乏力1月，纳差。" } };
  const sanitized = safety.sanitizeUngroundedRedFlagNegations(reason, state);
  assert.equal(sanitized, reason);
  // 反面：逗号分开、不在「未见」小句里的要点原文仍会被当作本例所见改写（这一条说明为什么要换顿号）。
  assert.match(safety.sanitizeUngroundedRedFlagNegations("血虚的辨证要点（面色淡白，脉细）尚未成组出现", state), /脉象待核实/u);
});

// ───── 6 中成药 ─────
await check("6.1 说明书「尚不明确」「未载明」占位不进风险说明；其余原文照留", () => {
  assert.equal(pool.withoutLabelPlaceholders("尚不明确。1、忌辛辣、生冷、油腻食物。2、感冒发热病人不宜服用。"), "1、忌辛辣、生冷、油腻食物。2、感冒发热病人不宜服用。");
  assert.equal(pool.withoutLabelPlaceholders("尚不明确"), "");
  assert.equal(pool.withoutLabelPlaceholders("未载明；孕妇慎用"), "孕妇慎用");
  assert.equal(pool.withoutLabelPlaceholders("阴虚阳亢患者禁服。1、忌辛辣。"), "阴虚阳亢患者禁服。1、忌辛辣。");
  assert.equal(pool.withoutLabelPlaceholders("孕妇禁用。暂无相关研究资料。"), "孕妇禁用。暂无相关研究资料。", "整段是一句话时不是占位");
});

await check("6.2 交付面：中成药的使用边界取说明书疗程句，与汤剂关系按定位写，风险说明去占位；没有疗程句时使用边界为空", () => {
  const reasoning = {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    overview: {},
    formula: {
      candidates: [],
      modifications: [],
      patentAndWestern: [
        { type: "中成药", name: "七生力片", positioning: "需医生评估", usageBoundary: "说明书用法字段已与本候选的说明书条目及指纹绑定。", relationship: "与中药饮片方案不默认联用", riskNote: "尚不明确。1、忌辛辣、生冷、油腻食物。6、服药2周症状无缓解，应去医院就诊。" },
        { type: "中成药", name: "某丸", positioning: "联合治疗", usageBoundary: "x", relationship: "x", riskNote: "孕妇慎用。" },
      ],
    },
  };
  const out = surface.projectDeliveredReasoning(reasoning, {});
  const [first, second] = out.formula.patentAndWestern;
  assert.equal(first.usageBoundary, "服药2周症状无缓解，应去医院就诊。");
  assert.equal(first.relationship, "是否与本方汤剂同用由医生评估");
  assert.doesNotMatch(first.riskNote, /尚不明确/u);
  assert.equal(second.usageBoundary, "");
  assert.equal(second.relationship, "可与本方汤剂同期服用，两者间隔约1小时");
});

// ───── 7 辅助检查里别人的报告 ─────
const FOREIGN = {
  chiefComplaint: "咳嗽、咳痰5天",
  patient: { age: 30, sex: "男" },
  symptoms: {
    现病史: "5天前受凉后咳嗽，咳白痰，无发热。",
    辅助检查: "报告解读：6岁女童血常规白细胞略高；38岁男性胸片未见异常。",
  },
};
await check("7.1 辅助检查里贴着别人的报告（6岁女童、38岁男性）：不算本人年龄冲突；闸门给提示；年龄与性别都相符的报告不提示", () => {
  assert.equal(safety.narrativePediatricAgeConflict(FOREIGN), undefined);
  assert.deepEqual(safety.auxiliaryReportForeignPersons(FOREIGN), ["6岁女童", "38岁男性"]);
  const gate = safety.evaluateSafetyGate(FOREIGN);
  assert.ok(!(gate.missingItemCodes || []).includes("age_conflict"), "不再报年龄冲突");
  assert.ok((gate.advisories || []).some((item) => /可能误贴了他人的报告/u.test(item)));
  assert.match(safety.auxiliaryReportForeignPersonNotice(FOREIGN), /【辅助检查核对】/u);
  const own = { ...FOREIGN, symptoms: { ...FOREIGN.symptoms, 辅助检查: "30岁男性胸片未见异常。" } };
  assert.deepEqual(safety.auxiliaryReportForeignPersons(own), []);
  const otherSex = { ...FOREIGN, symptoms: { ...FOREIGN.symptoms, 辅助检查: "报告解读：31岁女性甲状腺功能正常。" } };
  assert.deepEqual(safety.auxiliaryReportForeignPersons(otherSex), ["31岁女性"], "年龄相近、性别不同也算别人的报告");
  // 现病史里写着患儿年龄的成人登记仍是年龄冲突（只排除辅助检查一栏）。
  const narrative = { ...FOREIGN, symptoms: { 现病史: "患儿6岁，咳嗽5天。" } };
  assert.equal(safety.narrativePediatricAgeConflict(narrative), 6);
});

await check("7.1b 规范化之后（辅助检查落在 symptoms.exams）同样认得出：甲方 11/11 原样请求不再报年龄冲突、照常给剂量", async () => {
  const types = await jiti.import("../src/lib/diagnosis-types.ts");
  const normalized = types.normalizeCaseStateInput(FOREIGN);
  assert.ok(normalized.symptoms?.exams, "夹具：规范化后辅助检查在 symptoms.exams");
  assert.deepEqual(safety.auxiliaryReportForeignPersons(normalized), ["6岁女童", "38岁男性"]);
  const gate = safety.evaluateSafetyGate(normalized);
  assert.ok(!(gate.missingItemCodes || []).includes("age_conflict"));
  assert.ok((gate.advisories || []).some((item) => /可能误贴了他人的报告/u.test(item)));
});

await check("7.2 路由：辨证与开方的提示词都带上【辅助检查核对】", () => {
  assert.match(readSource("../src/app/api/diagnosis/diagnose/route.ts"), /stageInstructions \+= auxiliaryReportForeignPersonNotice\(safeState\)/u);
  assert.match(readSource("../src/app/api/diagnosis/prescribe/route.ts"), /auxiliaryReportForeignPersonNotice\(safeState\)/u);
});

// ───── 8 复诊措辞 ─────
await check("8.1 孕期复评通道的提示写「如出现阴道流血或腹痛」（不预设已有腹痛）；急诊表现不写「如出现突然出现」", () => {
  const windows = JSON.parse(readSource("../src/data/priority-evaluation-windows.source.json"));
  assert.equal(windows.pathways?.pregnancy_review?.afterStep ?? Object.values(windows).find((value) => value && value.pregnancy_review)?.pregnancy_review?.afterStep, "如出现阴道流血或腹痛，请立即就医。");
  const src = readSource("../src/lib/diagnosis-safety.ts");
  assert.match(src, /item\.replace\(\/\^\(突然\)\?出现\/u, "\$1"\)/u);
});

// ───── 9 真心痛 ─────
await check("9.1 真心痛：胸骨后压榨性疼痛持续不缓解伴大汗、安全门有急性心血管红旗时排在最前；没有持续不缓解时不排", () => {
  const record = "患者2小时前休息时突发胸骨后压榨性疼痛，持续不缓解，向左肩及左臂放射，伴大汗、气短、恶心。";
  const redFlags = ["胸痛/胸闷伴大汗、放射痛或气促，需排除急性心血管事件"];
  assert.equal(trueHeart.trueHeartPainSignal(record, redFlags)?.collapse, "大汗");
  assert.equal(trueHeart.trueHeartPainSignal("胸骨后压榨性疼痛2小时，伴大汗、气短。", redFlags), undefined);
});

// ───── 10 既往确诊病与西医名 ─────
await check("10.1 既往确诊病提示段也约束西医名：写该病的本次发作，不写同部位的另一个病", () => {
  const notice = history.historyStatedDiseaseNotice([{ disease: "乳蛾", western: "慢性扁桃体炎", quote: "慢性扁桃体炎史2年", chiefSymptom: "咽痛" }]);
  assert.match(notice, /西医诊断同理：本次按「慢性扁桃体炎」的发作辨时，westernDiagnosis\.primary\.name 写该病的本次发作/u);
});

// ───── 11 病机链首节点出处 ─────
await check("11.1 交付证名是合称（心脾两虚证）、教材行是单证时，首节点不标那一行教材出处；证名相同的照标", () => {
  const make = (syndrome) => ({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    overview: { tcmDiseaseName: "心悸", primarySyndrome: syndrome, primarySyndromeResolution: "resolved" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "心悸", pathogenesis: "心血不足", evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } }], uncertainties: [] },
    westernDiagnosis: { primary: { name: "心悸待查" } },
    therapy: {},
  });
  const composite = surface.projectDeliveredReasoning(make("心脾两虚证"), { recordText: "心悸1月" });
  assert.notEqual(composite.pathogenesis.chain[0].evidence.evidenceLevel, "kb_entry");
  const same = surface.projectDeliveredReasoning(make("心血不足证"), { recordText: "心悸1月" });
  assert.equal(same.pathogenesis.chain[0].evidence.evidenceLevel, "kb_entry");
  assert.match(same.pathogenesis.chain[0].evidence.source, /心悸·心血不足证/u);
});

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
