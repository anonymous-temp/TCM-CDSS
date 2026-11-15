// R1064：自由方义/句内修补断言保留为显式回滚测试；新默认由 test-r1064-m04wire 覆盖，安全断言不变。
process.env.CDSS_M04_FINAL_CONTENT = "false";
// 第四十五轮（2026-11-14）：甲方 100 例首次逐字复核（144 份，256 条「错」）之后按类收口。方案在 ~/runlogs/r1018/work/r1061/PLAN.md。
//  0. 止血：加减条件不是症状（病名、既往史、病历说明）；待核实项理由重复项目；病位共用一句原文被判无依据；寒热见证的修饰字写法；
//     病性本虚、标实两栏为空；「病历未记录本次血常规结果」（检查名当栏名剥掉）；脱证与名中证素；高危基础情况与「用药史」一栏；
//     外治卡的转载、文号、网站名与㨰字缺失；「未诉」改写读不通；交付前读通检查；依据说没确立而病名写确诊；血虚的成组判据；出处写教材。
//  1. 辨证分析与结论对齐（m03-analysis-alignment.server.ts）：确定性判据查对不上的地方，模型按定了的结论重写分析几段，服务端核对后才换。
//  2. 在孕时药典孕妇慎用药不作君臣；低血糖不写「少吃甜食」；停经 N 周按孕周；外感证不套内伤针刺分套；成方药味功效按方解。
// 每条断言都有反证（~/runlogs/r1018/work/r1062/cp/）。
import assert from "node:assert/strict";
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

const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const fit = await jiti.import("../src/lib/m04-modification-fit.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const required = await jiti.import("../src/lib/required-precautions.server.ts");
const requiredShared = await jiti.import("../src/lib/required-precautions.ts");
const element = await jiti.import("../src/lib/m03-element-support.server.ts");
const secondary = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
const claims = await jiti.import("../src/lib/recorded-test-claims.ts");
const basis = await jiti.import("../src/lib/western-basis-authoring.server.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const alignment = await jiti.import("../src/lib/m03-analysis-alignment.server.ts");
const plan = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
const fixes = await jiti.import("../src/lib/nondrug-text-fixes.ts");
const claimCheck = await jiti.import("../src/lib/m03-patient-claim-check.server.ts");
const polarity = await jiti.import("../src/lib/clinical-polarity.ts");

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = (value) => `正文\n${START}\n${JSON.stringify(value)}\n${END}`;
const unwrap = (content) => JSON.parse(content.slice(content.indexOf(START) + START.length, content.indexOf(END)).trim());

await check("1.1 加减条件是病名、分期、病历说明或就诊经过时不算表现；症状照常", () => {
  for (const trigger of ["本例已见未接受检查", "家属与本人对症状持续时间描述不同", "本例已见慢性肾病3期", "本例已见2型糖尿病控制一般", "病人拒绝进一步说明近期饮食与药物"]) {
    assert.equal(compiler.modificationTriggerIsNormalState(trigger), true, trigger);
  }
  for (const trigger of ["本例已见咽痛", "腰膝酸软", "失眠多梦", "大便偏干", "本例已见头胀"]) {
    assert.equal(compiler.modificationTriggerIsNormalState(trigger), false, trigger);
  }
});

await check("1.2 既往史、个人史一栏不当「本例已见」的依据；现病史里写到的照算", () => {
  const record = "乏力2周\n现病史：近来食量下降，夜尿增多\n既往史：慢性肾病3期、焦虑症病史\n个人史：常熬夜";
  const facts = compiler.modificationPresenceFactsFor(record, null);
  assert.ok(!facts.includes("慢性肾病3期"), "既往史一行不进");
  assert.ok(!facts.includes("熬夜"), "个人史一行不进");
  assert.ok(facts.includes("夜尿增多"), "现病史照进");
  assert.equal(compiler.presentModificationCondition("若熬夜", facts), undefined);
  assert.ok(compiler.presentModificationCondition("若夜尿增多", facts), "现病史里的表现仍算已见");
});

await check("1.3 加减核对的「不是症状体征」提名交给另一家复核", () => {
  const rows = [{ action: "加", trigger: "本例已见熬夜", herbName: "枸杞子" }];
  assert.equal(fit.modificationFindingQualifies({ line: 0, verdict: "not_finding", quote: "" }, rows, "常熬夜"), true);
  assert.equal(fit.modificationFindingQualifies({ line: 1, verdict: "not_finding", quote: "" }, rows, "常熬夜"), false, "行号越界不算");
});

await check("1.4 补写的加减不为顺带的睡眠差加安神药", () => {
  const prior = { stage: "diagnose", overview: { tcmDiseaseName: "头痛", primarySyndrome: "血虚头痛", primarySyndromeBasis: [] }, therapy: { overallMethod: "养血疏风止痛" }, pathogenesis: { chain: [] } };
  const caseState = types.normalizeCaseStateInput({ id: "r1062-sleep", chiefComplaint: "头痛2月", patient: { sex: "女", age: 30 }, symptoms: { 现病史: "产后头痛，伴头晕、神疲乏力，食欲下降，睡眠差，大便稀溏" } });
  const row = (trigger, herbName, reason) => compiler.topUpModificationRow({ trigger, herbName, dose: "9g", reason }, { prior, caseState, candidateHerbNames: ["当归", "川芎"], existingTriggers: [] });
  assert.equal(row("睡眠差", "酸枣仁", "养心安神，改善睡眠"), undefined);
  assert.ok(row("食欲下降", "陈皮", "理气健脾开胃"), "对照：纳差加陈皮照留");
});

await check("2.1 待核实项理由开头重复项目的那一段去掉", () => {
  const pathogenesis = { uncertainties: [
    { item: "缺食欲、二便与寒热记录", reason: "缺食欲、二便与寒热记录，脾虚程度待定", affects: "证候" },
    { item: "急危重风险尚未排除", reason: "急危重风险未排除，请先完成急诊或转诊评估；以下辨证供医生参考。", affects: "全部" },
    { item: "舌象", reason: "舌象未记录", affects: "寒热" },
    { item: "腹痛性质", reason: "腹痛性质", affects: "虚实" },
  ] };
  surface.withoutReasonEchoingItem(pathogenesis);
  assert.equal(pathogenesis.uncertainties[0].reason, "脾虚程度待定");
  assert.equal(pathogenesis.uncertainties[1].reason, "请先完成急诊或转诊评估；以下辨证供医生参考。");
  assert.equal(pathogenesis.uncertainties[2].reason, "舌象未记录", "项目太短不动");
  assert.equal(pathogenesis.uncertainties[3].reason, "尚待核实", "整句与项目相同时写尚待核实");
});

const locationContent = (location, primarySyndrome = "风热犯肺证") => wrap({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { primarySyndrome, primarySyndromeResolution: "resolved", primarySyndromeBasis: ["咳嗽伴咽痛3天"], secondarySyndromes: [] },
  pathogenesis: { locationDifferentiation: location, natureDifferentiation: { items: [], rootDeficiency: [], branchExcess: [], basis: "", resolution: "unresolved" }, chain: [], uncertainties: [] },
});
const record3 = "咳嗽伴咽痛3天，左腰腹绞痛伴血尿，超声左肾积水轻度，尿频";

await check("3.1 几个病位共用同一句原文照样算有依据", () => {
  const out = unwrap(summary.sanitizeOptionalPathogenesisClassifications(locationContent({ items: ["肺", "咽喉"], details: [{ location: "肺", basis: "咳嗽伴咽痛3天" }, { location: "咽喉", basis: "咳嗽伴咽痛3天" }], resolution: "bounded" }), record3));
  assert.equal(out.pathogenesis.locationDifferentiation.resolution, "resolved");
  assert.equal(out.pathogenesis.locationDifferentiation.details.length, 2);
});

await check("3.2 三焦随所含脏腑有依据；证名外又没依据的病位不列", () => {
  const out = unwrap(summary.sanitizeOptionalPathogenesisClassifications(locationContent({ items: ["肾", "下焦"], details: [{ location: "肾", basis: "超声左肾积水轻度" }], resolution: "bounded" }, "湿热下注证"), record3));
  assert.equal(out.pathogenesis.locationDifferentiation.resolution, "resolved", "下焦随肾");
  const pruned = unwrap(summary.sanitizeOptionalPathogenesisClassifications(locationContent({ items: ["肺", "大肠"], details: [{ location: "肺", basis: "咳嗽伴咽痛3天" }], resolution: "bounded" }), record3));
  assert.deepEqual(pruned.pathogenesis.locationDifferentiation.items, ["肺"]);
  assert.equal(pruned.pathogenesis.locationDifferentiation.resolution, "resolved");
  const named = unwrap(summary.sanitizeOptionalPathogenesisClassifications(locationContent({ items: ["肺", "肾"], details: [{ location: "肺", basis: "咳嗽伴咽痛3天" }], resolution: "bounded" }, "肺肾气虚证"), record3));
  assert.equal(named.pathogenesis.locationDifferentiation.resolution, "bounded", "证名里的病位没依据仍是有界");
});

await check("4.1 寒热见证：舌干红、苔薄黄、脉急、口唇干都认；舌淡红不算热", () => {
  const support = summary.recordColdHeatSupport("高热39.5℃；舌干红，苔少；脉急；口唇干", "heat");
  assert.ok(support.dimensions.size >= 3, [...support.dimensions].join("、"));
  assert.ok(summary.recordColdHeatSupport("舌红，苔薄黄", "heat").dimensions.has("舌"));
  assert.ok(summary.recordColdHeatSupport("舌干红，苔少", "heat").dimensions.has("舌"), "舌干红单独认作舌象热");
  assert.ok(summary.recordColdHeatSupport("脉急", "heat").dimensions.has("脉"), "脉急认作数脉");
  assert.equal(summary.recordColdHeatSupport("舌淡红，苔薄白", "heat").dimensions.size, 0);
  assert.equal(summary.recordHasTongueAndPulse("舌干红，苔少；脉急"), true);
});

await check("5.1 病性条目归本虚还是标实", () => {
  assert.equal(summary.natureItemDeficiencyOrExcess("气滞"), "branch");
  assert.equal(summary.natureItemDeficiencyOrExcess("外感风邪"), "branch");
  assert.equal(summary.natureItemDeficiencyOrExcess("血瘀"), "branch");
  assert.equal(summary.natureItemDeficiencyOrExcess("气虚"), "root");
  assert.equal(summary.natureItemDeficiencyOrExcess("气脱"), "root");
  assert.equal(summary.natureItemDeficiencyOrExcess("阴阳失调"), undefined);
});

await check("5.2 病性栏两栏都没放的条目按词表归栏", () => {
  const content = wrap({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { primarySyndrome: "肝郁气滞证", primarySyndromeBasis: [] },
    pathogenesis: { natureDifferentiation: { items: ["气滞"], rootDeficiency: [], branchExcess: [], basis: "脐周间断腹痛2个月", resolution: "resolved" }, chain: [], uncertainties: [] } });
  const out = unwrap(summary.sanitizeOptionalPathogenesisClassifications(content, "脐周间断腹痛2个月"));
  assert.deepEqual(out.pathogenesis.natureDifferentiation.branchExcess, ["气滞"]);
});

await check("5.3 正常所见、否认的表现不作病位病性的依据", () => {
  assert.equal(summary.withoutNormalFindingSegments("舌淡红，苔薄白；脉弦"), "脉弦");
  assert.equal(summary.withoutNormalFindingSegments("呼吸目前平稳"), "");
  assert.equal(summary.withoutNormalFindingSegments("无明显咳嗽"), "");
  assert.equal(summary.withoutNormalFindingSegments("舌淡红，苔黄腻"), "舌淡红，苔黄腻", "一段里有异常表现就整段留着");
  assert.equal(summary.withoutNormalFindingSegments("纳可，眠可；大便溏薄"), "大便溏薄");
});

await check("6.1 检查名本身作栏名时（「血常规：白细胞…」）照录原文，不写「病历未记录本次血常规结果」", () => {
  const notice = safety.recordedExamResultNotice("辅助检查：胸片未见异常\n血常规：白细胞7.8×10^9/L，中性粒细胞68%", "血常规");
  assert.ok(notice.startsWith("病历记录"), notice);
  assert.ok(notice.includes("血常规"), notice);
  assert.equal(safety.recordedExamResultNotice("辅助检查：胸片未见异常", "血常规"), "病历未记录本次血常规结果");
});

await check("7.1 脱证名涵盖同类虚性证素（心阳欲脱涵盖阳虚、气脱涵盖气虚）", () => {
  assert.ok(element.entailedDeficiencies(["心阳欲脱证"]).has("阳虚"));
  assert.ok(element.entailedDeficiencies(["气脱证"]).has("气虚"));
  assert.ok(!element.entailedDeficiencies(["痰热壅肺证"]).has("气虚"), "实证不涵盖");
});

const c100 = types.normalizeCaseStateInput({
  id: "r1062-c100", chiefComplaint: "乏力、食欲下降两周", patient: { sex: "男", age: 91 },
  symptoms: { 现病史: "食量下降，体重减轻；近一周尿量偏少", 既往史: "心衰、慢性肾病4期", 用药史: "地高辛、呋塞米、华法林、安眠药，具体剂量待核实", 辅助检查: "肌酐320μmol/L，血钾5.6mmol/L" },
  vitals: { T: "36.2", P: "58", R: "19", BP: "98/60" },
});

await check("8.1 「用药史」一栏的药名进现用药一条；肾功能不全、心衰、血钾、地高辛各有一条", () => {
  const items = required.requiredPrecautionsForCase(safety.withSafetyGate(c100), null);
  const current = items.find((item) => item.kind === "current_medications");
  assert.ok(current && ["地高辛", "呋塞米", "华法林"].every((name) => current.names.some((listed) => listed.includes(name))), JSON.stringify(current));
  const highRisk = items.find((item) => item.kind === "high_risk_condition");
  assert.ok(highRisk, "有高危基础情况一条");
  for (const condition of ["renal", "heart_failure", "hyperkalemia", "digoxin"]) assert.ok(highRisk.conditions.includes(condition), condition);
  const control = required.requiredPrecautionsForCase(safety.withSafetyGate(types.normalizeCaseStateInput({ id: "r1062-ctl", chiefComplaint: "咽痛2天", patient: { sex: "男", age: 30 }, symptoms: { 现病史: "咽痛2天" } })), null);
  assert.ok(!control.some((item) => item.kind === "high_risk_condition"), "对照：没有高危情况");
});

await check("8.3 「用药史」一栏的非药名与用药频次不进药名", () => {
  const state = (history) => types.normalizeCaseStateInput({ id: "r1062-med", chiefComplaint: "心悸", patient: { sex: "男", age: 40 }, symptoms: { 现病史: "心悸1月", 用药史: history } });
  assert.deepEqual(safety.recordedMedicationHistoryList(state("未服药")), []);
  assert.deepEqual(safety.recordedMedicationHistoryList(state("复合维生素偶服")), ["复合维生素"]);
  assert.deepEqual(safety.recordedMedicationHistoryList(state("氨氯地平5mg每日1次、阿司匹林")), ["氨氯地平", "阿司匹林"]);
  assert.deepEqual(safety.recordedMedicationHistoryList(state("阿托伐他汀已停用半年")), [], "写了停用的不算在用");
});

await check("8.4 证素核对的待核实项不对男性、老人列滑胎、带下、月经", () => {
  const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { primarySyndrome: "脾气虚证" },
    pathogenesis: { uncertainties: [{ item: "是否兼肾气不固", reason: "本例虽见夜尿多，未见肾气不固的辨证要点（腰膝酸软、小便频数清长、滑精、滑胎、带下量多清稀与肾气虚症状共见）成组出现", affects: "治法" }] } };
  const male = surface.projectDeliveredReasoning(reasoning, { herbBoundaryAudience: { reproductive: false, ageYears: 63 } });
  const reason = male.pathogenesis.uncertainties[0].reason;
  assert.ok(!/滑胎|带下/u.test(reason), reason);
  assert.ok(reason.includes("滑精"), reason);
  const female = surface.projectDeliveredReasoning(reasoning, { herbBoundaryAudience: { reproductive: true, ageYears: 30 } });
  assert.ok(female.pathogenesis.uncertainties[0].reason.includes("滑胎"), "对照：育龄女性照列");
});

await check("8.2 高危情况逐项核：写到肾功能复查才算肾那一项", () => {
  const item = { kind: "high_risk_condition", conditions: ["renal", "digoxin"] };
  assert.deepEqual(requiredShared.highRiskConditionsMissing(item, ["服药期间定期复查肾功能"]), ["digoxin"]);
  assert.deepEqual(requiredShared.highRiskConditionsMissing(item, ["饮食宜清淡"]), ["renal", "digoxin"], "没写到时两项都缺");
  assert.deepEqual(requiredShared.highRiskConditionsMissing(item, ["定期复查肾功能", "地高辛与中药同服须医生核定"]), []);
  assert.ok(requiredShared.highRiskConditionLine(item, ["digoxin"]).includes("地高辛"));
});

await check("9.1 卡片来源说明只留机构与篇名；㨰法缺字补回", () => {
  assert.equal(plan.webSourceLabel("国家中医药管理局（国中医药医政医管便函〔2015〕61号）", "胃疡等19个病种中医护理方案（试行）"), "国家中医药管理局《胃疡等19个病种中医护理方案（试行）》");
  assert.equal(surface.cardSourceNoteCleaned("隔日1 次（甘肃省中医院张玉琴医生在好大夫在线转载《荨麻疹（瘾疹）中医治疗专家共识》）"), "隔日1 次（《荨麻疹（瘾疹）中医治疗专家共识》）");
  assert.equal(surface.cardSourceNoteCleaned("每日2～3次（国家中医药管理局（国中医药医政医管便函〔2013〕59号）《中风等13个病种中医护理方案（试行）》）"), "每日2～3次（国家中医药管理局《中风等13个病种中医护理方案（试行）》）");
  assert.equal(surface.cardSourceNoteCleaned("每日1次，每次30min（湖南省中医药管理局《流感方案》）"), "每日1次，每次30min（湖南省中医药管理局《流感方案》）", "正常来源不动");
  assert.equal(fixes.textbookOcrFixed("在项、肩、上背部施以法，约2分钟"), "在项、肩、上背部施以滚法，约2分钟");
  assert.equal(fixes.textbookOcrFixed("先在其腰臀部及患肢施法5分钟"), "先在其腰臀部及患肢施滚法5分钟");
  assert.equal(fixes.textbookOcrFixed("另一手施法及揉法于肩臂部"), "另一手施滚法及揉法于肩臂部");
});

await check("10.1 「无」改「未诉」读不通时不改：无痛性、非无、无然", () => {
  const record = "右乳肿块1月";
  assert.equal(summary.unrecordedNegativesAsNotReported("乳岩：无痛性乳房肿块需排除恶性", record), "乳岩：无痛性乳房肿块需排除恶性");
  assert.equal(summary.unrecordedNegativesAsNotReported("本例与之不同，非无性交而遗", record), "本例与之不同，非无性交而遗");
  assert.equal(summary.unrecordedNegativesAsNotReported("本例无发热", record), "本例未诉发热", "对照：普通的无X照改");
});

await check("10.2 交付前读通检查", () => {
  assert.equal(surface.readabilityCleaned("本例无局灶无力，未诉未诉言语不利"), "本例无局灶无力，未诉言语不利");
  assert.equal(surface.readabilityCleaned("本方为自拟方，参照本方与本方之意，去其活血破血之品。"), "本方为自拟方，去其活血破血之品。");
  assert.equal(surface.readabilityCleaned("故取方证而不取教材行"), "故取方证而不取教材证型");
  assert.equal(surface.readabilityCleaned("咳嗽；；痰多，，。"), "咳嗽；痰多。");
  assert.equal(surface.readabilityCleaned("本方用银翘散原方。"), "本方用银翘散原方。", "对照不动");
});

await check("10.3 「目前无脓毒症等红旗」「按已锁定病机与治法辨证组方」换成临床说法", () => {
  assert.equal(surface.clinicalWordingForSyntheticPhrases("目前无脓毒症等红旗；若出现呼吸困难须立即急诊评估。"), "目前无脓毒症等危急征象；若出现呼吸困难须立即急诊评估。");
  assert.equal(surface.clinicalWordingForSyntheticPhrases("按已锁定病机与治法辨证组方"), "按本例病机与治法自拟组方");
  assert.equal(surface.clinicalWordingForSyntheticPhrases("呼吸系统红旗需优先排查"), "呼吸系统红旗需优先排查", "对照：器官系统红旗不动");
});

const westernContent = (name, rationale) => JSON.stringify({ westernDiagnosis: { primary: { name, status: "考虑", clinicalRationale: rationale, supportingFacts: [rationale] }, candidates: [{ name, likelihood: "中", keyEvidence: [], againstEvidence: [] }], differentials: [] } });

await check("11.1 依据说没确立、病名写确诊时病名改「X待查」", () => {
  assert.equal(basis.basisSaysNameNotEstablished("运动中突发剧烈头痛，考虑蛛网膜下腔出血可能，尚缺头颅CT平扫及腰穿脑脊液分析确认", "蛛网膜下腔出血"), true);
  assert.equal(basis.basisSaysNameNotEstablished("咽痛、发热，符合急性扁桃体炎；尚缺血常规明确病原", "急性扁桃体炎"), false, "缺的是病原这一层不算");
  assert.equal(basis.basisSaysNameNotEstablished("咳嗽咳痰，符合急性支气管炎，需排除肺炎", "急性支气管炎"), false);
  const renamed = JSON.parse(basis.withNameMatchingBasisCertainty(westernContent("急性化脓性关节炎", "单关节红肿热痛伴寒战高热，考虑急性化脓性关节炎可能；关节液未查"), "膝关节红肿热痛"));
  assert.equal(renamed.westernDiagnosis.primary.name, "急性化脓性关节炎待查");
  const kept = JSON.parse(basis.withNameMatchingBasisCertainty(westernContent("急性支气管炎", "咳嗽咳痰，符合急性支气管炎"), "咳嗽3天"));
  assert.equal(kept.westernDiagnosis.primary.name, "急性支气管炎");
});

await check("11.2 依据自相矛盾（既说可凭临床诊断又说考虑X可能）：病名不改，去掉「考虑X可能」；缺的是病原这一层不算未确立", () => {
  const text = "本例为急性起病的左侧胁肋部疼痛伴簇集性水疱，沿皮节分布，考虑带状疱疹可能，临床可诊断带状疱疹，尚缺病毒学检查确认病原，需排除单纯疱疹。";
  assert.equal(basis.basisSaysNameNotEstablished(text, "带状疱疹"), false);
  const out = JSON.parse(basis.withNameMatchingBasisCertainty(westernContent("带状疱疹", text), "左胁痛5天，簇集水疱"));
  assert.equal(out.westernDiagnosis.primary.name, "带状疱疹");
  assert.ok(!out.westernDiagnosis.primary.clinicalRationale.includes("考虑带状疱疹可能"), out.westernDiagnosis.primary.clinicalRationale);
  assert.equal(basis.basisSaysNameNotEstablished("咽痛发热，符合急性扁桃体炎，尚缺血常规确认病原", "急性扁桃体炎"), false, "确认病原是下一层");
});

await check("19.1 推测里的「癌」不是病史；主动控制饮食减下的体重不是不明原因（门禁）", () => {
  assert.equal(safety.withoutSpeculativeCancerClauses("便后滴鲜血3天，母亲说可能是肠癌，他很紧张。"), "便后滴鲜血3天，，他很紧张。");
  assert.equal(safety.withoutSpeculativeCancerClauses("胃癌术后2年，近1月上腹胀痛。"), "胃癌术后2年，近1月上腹胀痛。", "对照：本人病史不动");
});

await check("12.1 「诊断已确立；但…尚需专科评估确认」撤去确立断言并定稿为待查", () => {
  const out = claims.westernBasisWithoutEstablishmentContradiction("帕金森病诊断已确立；但未接受神经科专科检查，尚需专科评估确认", "帕金森病", "动作迟缓、静止性震颤1年");
  // r1064 F1：旧断言已实跑失败；不在原句里换词，依据留缺项，病名由同一判据定为待查。
  assert.doesNotMatch(out, /诊断已确立/u);
  assert.match(out, /尚需专科评估确认/u);
  const settled = claims.settleWesternDiagnosisBasis("帕金森病", out, "动作迟缓、静止性震颤1年");
  assert.equal(settled.name, "帕金森病待查");
});

await check("13.1 血虚：要点与主证共有的一条连同特异表现够三条算成组；血红蛋白偏低算一条", () => {
  const entry = { name: "血虚证", specific: ["面色淡白", "睑色淡白", "唇色淡白", "舌色淡白", "脉细"], categoryEntries: [], category: null, keyPointsText: "面、睑、唇、舌色淡白，脉细等为主要表现。", manifestations: ["面色淡白", "舌淡苔白"] };
  const matches = [{ item: "面色淡白", quote: "面色略白" }, { item: "脉细", quote: "脉细" }, { item: "舌色淡白", quote: "舌淡" }];
  const record = "乏力2月，面色略白，舌淡，脉细";
  const verdict = secondary.evaluateCriteriaMatches(entry, matches, { recordText: record, primaryTerms: ["舌淡"] });
  assert.equal(verdict.verdict, "pass");
  const two = secondary.evaluateCriteriaMatches(entry, matches.slice(0, 2), { recordText: record, primaryTerms: ["舌淡"] });
  assert.equal(two.verdict, "fail", "对照：只有两条且无化验");
  const lab = secondary.evaluateCriteriaMatches(entry, matches.slice(0, 2), { recordText: `${record}，血红蛋白96g/L`, primaryTerms: ["舌淡"] });
  assert.equal(lab.verdict, "pass", "血红蛋白偏低算一条");
});

await check("14.1 出处写成教材的换原书或「现代经验方」", () => {
  assert.equal(provenance.deliveredFormulaSource("参附龙牡救逆汤", "《中医儿科学》"), "《中医方剂临床手册》");
  assert.equal(provenance.deliveredFormulaSource("宁血汤", "《中医眼科学》"), "现代经验方");
  assert.equal(provenance.deliveredFormulaSource("银翘散", "《温病条辨》"), "《温病条辨》");
});

await check("15.1 在孕时药典孕妇慎用药不作君臣；佐使照用；未孕不受此限", () => {
  const pregnant = "患者性别：女\n患者年龄：28岁\n孕12周，腰酸咽痛";
  assert.match(contract.m04GenerationSpecialPopulationIssue([{ name: "牛膝", role: "臣" }], pregnant) || "", /pregnancy/u);
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "牛膝", role: "佐" }], pregnant), undefined);
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "牛膝", role: "臣" }], "患者性别：男\n患者年龄：40岁\n腰痛1月"), undefined);
});

const alignedReasoning = (overrides = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "心悸", primarySyndrome: "痰火扰心证", secondarySyndromes: [], tcmDiagnosticRationale: "阵发心悸、手抖为热扰心神；舌红、脉弦数为阳热内盛，支持肝火扰心。", overallPathogenesis: "热扰心神" },
  pathogenesis: { natureDifferentiation: { items: ["内热"], rootDeficiency: [], branchExcess: ["内热"], basis: "舌红", resolution: "resolved" }, chain: [], uncertainties: [] },
  therapy: { overallMethod: "清热化痰，宁心安神" },
  ...overrides,
});
const alignRecord = "阵发心悸1月，手抖，咯黄痰，痰黏，舌红，苔黄腻，脉弦数";

await check("16.1 分析与结论对不上：证名的痰不在病性、依据落到别的证", () => {
  const issues = alignment.analysisMisalignments(alignedReasoning(), alignRecord).map((issue) => issue.code);
  assert.ok(issues.includes("syndrome_element_missing"), issues.join(","));
  assert.ok(issues.includes("rationale_other_syndrome"), issues.join(","));
  const consistent = alignedReasoning({
    overview: { tcmDiseaseName: "心悸", primarySyndrome: "痰火扰心证", secondarySyndromes: [], tcmDiagnosticRationale: "心悸、咯黄痰、苔黄腻为痰火扰心之象，故属痰火扰心证。", overallPathogenesis: "痰火扰心" },
    pathogenesis: { natureDifferentiation: { items: ["痰", "热"], rootDeficiency: [], branchExcess: ["痰", "热"], basis: "咯黄痰；苔黄腻", resolution: "resolved" }, chain: [], uncertainties: [] },
  });
  assert.deepEqual(alignment.analysisMisalignments(consistent, alignRecord), [], "对照：对得上");
});

await check("16.2 虚证名而本虚为空、待核实问证名已有的要素都算对不上", () => {
  const collapse = alignedReasoning({
    overview: { tcmDiseaseName: "真心痛", primarySyndrome: "心阳欲脱证", secondarySyndromes: [], tcmDiagnosticRationale: "胸痛大汗、肢冷脉微为心阳欲脱，故属心阳欲脱证。", overallPathogenesis: "心阳欲脱" },
    pathogenesis: { natureDifferentiation: { items: ["寒凝"], rootDeficiency: [], branchExcess: ["寒凝"], basis: "肢冷", resolution: "resolved" }, chain: [], uncertainties: [{ item: "是否兼心阳虚", reason: "待核实", affects: "治法" }] },
  });
  const codes = alignment.analysisMisalignments(collapse, "胸痛2小时，大汗，肢冷，脉微").map((issue) => issue.code);
  assert.ok(codes.includes("deficiency_without_root"), codes.join(","));
  assert.ok(codes.includes("uncertainty_asks_named_element"), codes.join(","));
});

await check("16.3 重写稿逐项核对：对得上才换；有别的证名、依据不在病历里的不换", () => {
  const good = { rationale: "阵发心悸、手抖为热扰心神，咯黄痰、痰黏、苔黄腻为痰热内蕴，舌红、脉弦数为火热之象，痰火上扰心神，故属痰火扰心证。", natureItems: ["痰", "热"], rootDeficiency: [], branchExcess: ["痰", "热"], natureBasis: "咯黄痰；苔黄腻；舌红", overallPathogenesis: "痰火内扰，心神不宁", uncertainties: [] };
  const accepted = alignment.acceptedAlignmentRewrite(alignedReasoning(), good, alignRecord);
  assert.ok(accepted, "合格的重写稿换上");
  assert.deepEqual(accepted.pathogenesis.natureDifferentiation.items, ["痰", "热"]);
  assert.equal(alignment.acceptedAlignmentRewrite(alignedReasoning(), { ...good, rationale: `${good.rationale}亦可见肝火扰心证。` }, alignRecord), undefined, "写到别的证名不换");
  assert.equal(alignment.acceptedAlignmentRewrite(alignedReasoning(), { ...good, natureBasis: "痰多色黄如脓" }, alignRecord), undefined, "依据不在病历里不换");
  const rejection = { reason: "" };
  assert.equal(alignment.acceptedAlignmentRewrite(alignedReasoning(), { ...good, natureItems: ["痰", "热", "血瘀"], branchExcess: ["痰", "热", "血瘀"] }, alignRecord, rejection), undefined, "病性多出证名没有的要素不换");
  assert.equal(rejection.reason, "nature_outside_conclusion", "在逐项核对这一步就拦下");
  const basisRejection = { reason: "" };
  alignment.acceptedAlignmentRewrite(alignedReasoning(), { ...good, natureBasis: "痰多色黄如脓" }, alignRecord, basisRejection);
  assert.equal(basisRejection.reason, "basis_not_verbatim");
});

await check("17.1 本次低血糖不写「少吃甜食」那一句", () => {
  assert.equal(required.currentHypoglycemiaRecorded("指尖血糖2.4mmol/L，意识模糊"), true);
  assert.equal(required.currentHypoglycemiaRecorded("空腹血糖6.1mmol/L"), false);
  assert.equal(required.currentHypoglycemiaRecorded("否认低血糖发作"), false);
});

await check("18.1 停经 N 周、孕早期按孕周读", () => {
  assert.equal(safety.recordedGestationalWeeks("停经6周，右下腹痛"), 6);
  assert.equal(safety.recordedGestationalWeeks("停经45天"), 6);
  assert.equal(safety.recordedGestationalWeeks("孕34周"), 34, "对照：原有写法");
  assert.equal(safety.recordedGestationalWeeks("未避孕5个月未能怀孕"), undefined);
  assert.equal(safety.recordedGestationalWeeks("停经6个月，小腹坠痛"), undefined, "停经 20 周以上多是闭经，不当孕周");
});

// ───── 20 第四十五轮终审复核（200 份，r1062/review-fin2）抓到的本轮回归与同类 ─────
await check("20.1 「用药史」一栏切出的项要认得出是药才进注意事项：西药通用名、带剂型、药类说法；用法碎片、写着用过未用的不收", () => {
  const listed = (history) => {
    const state = types.normalizeCaseStateInput({ id: "r1062-hist", chiefComplaint: "心悸", patient: { sex: "男", age: 40 }, symptoms: { 现病史: "心悸1月", 用药史: history } });
    return required.requiredPrecautionsForCase(safety.withSafetyGate(state), null).find((item) => item.kind === "current_medications")?.names || [];
  };
  assert.deepEqual(listed("长期吸入噻托溴铵，偶漏用"), ["噻托溴铵"]);
  assert.deepEqual(listed("呋塞米、比索洛尔，近一周漏服"), ["呋塞米", "比索洛尔"]);
  assert.deepEqual(listed("别嘌醇近期不规律；自行服双氯芬酸"), ["别嘌醇", "双氯芬酸"]);
  assert.ok(!listed("自行购买安眠药，名称剂量不明").some((name) => /名称|剂量/u.test(name)), "「名称」不是药名（「安眠药」这类泛称本来就不按药名列）");
  assert.deepEqual(listed("吸入性糖皮质激素，家长称经常忘"), ["吸入性糖皮质激素"]);
  assert.deepEqual(listed("一袋混合药片，处方和剂量不详"), [], "说不出是什么药");
  assert.deepEqual(listed("服过复方感冒药，名称不详"), [], "用过的不算在用");
  assert.deepEqual(listed("用过布洛芬"), [], "认得出的药名、写的是用过：不算在用");
  assert.deepEqual(listed("布洛芬"), ["布洛芬"], "对照");
  assert.deepEqual(listed("尚未用抗菌药"), []);
  const { candidate } = polarity.medicationHistoryItemCandidate("今日已自行加用数次");
  assert.ok(!polarity.MEDICATION_HISTORY_CLASS_WORD.test(candidate), candidate);
});

await check("20.2 红旗病例待核实「急危重风险尚未排除」：理由去掉重复的开头（措辞替换之后再比）", () => {
  const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: {}, westernDiagnosis: {}, therapy: {},
    pathogenesis: { chain: [], uncertainties: [{ item: "急危重风险尚未排除", reason: "急危重风险未排除：以下辨证、病机与治法结论供医生参考，请先完成急诊或转诊评估并记录排除或处置依据；风险解除前本方不能正式采纳。", affects: "整体" }] } };
  const reason = surface.projectDeliveredReasoning(reasoning, {}).pathogenesis.uncertainties[0].reason;
  assert.ok(!/^急危重风险/u.test(reason), reason);
  const colon = { uncertainties: [{ item: "缺舌脉记录", reason: "缺舌脉记录：证型边界待四诊补充", affects: "证候" }] };
  surface.withoutReasonEchoingItem(colon);
  assert.equal(colon.uncertainties[0].reason, "证型边界待四诊补充", "冒号连着的重复开头也去掉");
  assert.match(reason, /急诊或转诊评估/u);
  assert.doesNotMatch(reason, /记录排除或处置依据|正式采纳/u, "先换成临床写法再去重复，不留系统流程话");
});

await check("20.3 「X的一般情况需医生核实」是内部提示：否认半句留下，这半句去掉", () => {
  assert.equal(surface.clinicalWordingForSyntheticPhrases("近半年症状平稳，否认新发言语不清，言语不清的一般情况需医生核实；否认跌倒"), "近半年症状平稳，否认新发言语不清；否认跌倒");
  assert.equal(surface.clinicalWordingForSyntheticPhrases("否认头痛；病历已记录，未诉上腹痛，腹痛的一般情况需医生核实"), "否认头痛；未诉上腹痛");
});

await check("20.4 「如胸痛加重或出现晕厥、气促，立即呼叫急救」是嘱咐：不改成「病历尚未确认…」；「患者出现晕厥…」照旧核", () => {
  const state = types.normalizeCaseStateInput({ id: "r1062-pros", chiefComplaint: "胸痛3天", patient: { sex: "男", age: 30 }, symptoms: { 现病史: "胸痛3天，焦虑" } });
  assert.equal(safety.sanitizeUngroundedRedFlagNegations("如胸痛加重或出现晕厥、气促，立即呼叫急救。", state), "如胸痛加重或出现晕厥、气促，立即呼叫急救。");
  assert.match(safety.sanitizeUngroundedRedFlagNegations("患者出现晕厥、气促，立即呼叫急救。", state), /尚未确认/u);
  assert.equal(safety.sanitizeUngroundedRedFlagNegations("如胸痛加重或出现晕厥、气促，本例须立即急诊。", state), "如胸痛加重或出现晕厥、气促，本例须立即急诊。", "句中带「本例」时整句嘱咐那条路不放行，靠「如…加重」起头认出");
});

await check("20.5 「无痛性」「无意中」不是否认：辨证核对与「无→未诉」改写都不改", () => {
  assert.equal(summary.unrecordedNegativesAsNotReported("理发时无意发现，病程2周", "头顶脱发2周，理发时发现"), "理发时无意发现，病程2周");
  const root = { westernDiagnosis: { differentials: [{ name: "乳腺癌", reason: "无痛性乳房肿块须排除恶性", distinguishingPoints: "无发热，须超声" }] } };
  const applied = claimCheck.applyPatientClaimRemovals(root, "western", [{ field: "differentials[0].reason", span: "无痛性乳房肿块" }, { field: "differentials[0].distinguishingPoints", span: "无发热" }], "左乳肿块1月");
  assert.equal(root.westernDiagnosis.differentials[0].reason, "无痛性乳房肿块须排除恶性");
  assert.equal(root.westernDiagnosis.differentials[0].distinguishingPoints, "未诉发热，须超声", "对照：真否认照旧改成未诉（证明走到了改写这一步）");
  assert.equal(applied, 1);
  assert.equal(safety.maskNonNegatingWuWords("无意识障碍").startsWith("无"), true, "对照：无意识照旧是否认");
  const S = "<!-- DIAGNOSIS_JSON_START -->", E = "<!-- DIAGNOSIS_JSON_END -->";
  const wrap = (reasoning) => `${S}\n${JSON.stringify(reasoning)}\n${E}`;
  const diff = (reason) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseDifferentials: [{ diseaseName: "乳岩", reason, distinguishingPoints: "" }] }, westernDiagnosis: { differentials: [] }, pathogenesis: {}, therapy: {} });
  const grounded = (reason) => { const out = summary.groundDifferentialNegativeAssertions(wrap(diff(reason)), "左乳无痛性结节1个月，洗澡时触及"); return JSON.parse(out.slice(out.indexOf(S) + S.length, out.indexOf(E))).overview.tcmDiseaseDifferentials[0].reason; };
  assert.equal(grounded("无痛性单发肿块需排除恶性"), "无痛性单发肿块需排除恶性", "鉴别核对也不把「无痛性」当否认");
  assert.match(grounded("无乳头溢液"), /病历未记录乳头溢液/u, "对照：病历没写过的真否认照旧提示核实");
});

await check("20.6 方义里照抄的组方规则与剂量数据用语去掉：组成身份下限、精简佐使、本地剂量资料、「以合十味之限」", () => {
  assert.equal(surface.withoutInternalCompositionTalk("本方用养心汤加减。因组成身份下限需保留十一味，本方仅取十味，余一味以精简佐使处理。黄芪为君。"), "本方用养心汤加减。黄芪为君。");
  assert.equal(surface.withoutInternalCompositionTalk("本方为自拟方，因本方在本地标准剂量资料中暂无可执行的逐味剂量基准，故按本例病机另行组方。"), "本方为自拟方，故按本例病机另行组方。");
  assert.equal(surface.withoutInternalCompositionTalk("本方以舒筋活血汤为基础加减，去川牛膝、五加皮以合十味之限。"), "本方以舒筋活血汤为基础加减，去川牛膝、五加皮。");
  assert.equal(surface.withoutInternalCompositionTalk("黄芪补气固表为君。"), "黄芪补气固表为君。", "对照：没有这类话的不动");  const projected = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {}, westernDiagnosis: {}, pathogenesis: { chain: [], uncertainties: [] }, therapy: {},
    formula: { candidates: [{ name: "自拟方", herbs: [{ name: "黄芪", dose: "15g", role: "君" }, { name: "当归", dose: "10g", role: "臣" }], formulaAnalysis: "本方为自拟方，因本方在本地标准剂量资料中暂无可执行的逐味剂量基准，故按本例病机另行组方。黄芪为君，当归为臣。" }], modifications: [] }, nonPharma: {} }, {});
  assert.equal(projected.formula.candidates[0].formulaAnalysis, "本方为自拟方，故按本例病机另行组方。黄芪为君，当归为臣。", "交付投影里生效");
});

await check("20.7 跟药并列写的自行处理动作不是药名：「自服感冒药、发汗后」「自服奥美拉唑肠溶胶囊1粒及喝热水后」", () => {
  for (const name of ["发汗", "喝热水", "热水", "姜汤"]) assert.equal(polarity.cleanedMedicationNameCandidate(name), "", name);
  for (const name of ["奥美拉唑肠溶胶囊", "布洛芬", "藿香正气水"]) assert.equal(polarity.cleanedMedicationNameCandidate(name), name, `对照：${name}`);
});

if (failures > 0) console.error(`\n${failures} check(s) failed`);
else console.log("\nAll r1062 checks passed");
