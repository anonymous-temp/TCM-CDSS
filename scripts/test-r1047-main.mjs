// 第三十五轮（2026-11-02）：上一轮审计里剩下的「程序把对的内容改坏」逐类收口。量法与材料见 ~/runlogs/r1018/work/r1047。
// 每条断言都有反证（~/runlogs/r1018/work/r1047/cp/）。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const check = async (name, run) => {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const claim = await jiti.import("../src/lib/m03-patient-claim-check.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const western = await jiti.import("../src/lib/western-name-evidence-check.server.ts");
const review = await jiti.import("../src/lib/formula-analysis-review.ts");
const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const commentaryModule = await jiti.import("../src/lib/formula-textbook-commentary.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const phrasing = await jiti.import("../src/lib/tcm-therapy-phrasing.ts");
const modSafety = await jiti.import("../src/lib/m04-modification-safety.ts");

const COUGH = "患者2月来反复咳嗽，晨起尤甚，痰多色白黏腻易咯，胸闷脘痞，纳差。";
const state = (text) => ({ chiefComplaint: "咳嗽2月", patient: { sex: "男", age: 62 }, symptoms: { 现病史: text }, conversation: [] });
const sanitize = (text, record = COUGH) => safety.sanitizeUngroundedRedFlagNegations(text, state(record));

await check("1.1 否认列表里病历没写到的项按原样全留（词表外的也留、次序不变）", () => {
  const out = sanitize("无喘息气促、胸部膨满，与肺胀相区分。");
  assert.match(out, /病历尚未确认喘息气促是否存在；病历尚未确认胸部膨满是否存在/);
  assert.match(out, /与肺胀相区分/);
  assert.match(sanitize("无慢性咳喘、胸满气促史，与肺胀相区分。"), /慢性咳喘是否存在；病历尚未确认胸满气促史是否存在/);
  assert.equal(surface.clinicalWordingForSyntheticPhrases(sanitize("无咯血、潮热、消瘦，与肺痨相区分。")), "未诉咯血、潮热、消瘦，与肺痨相区分。", "顺序不变");
});
await check("1.2 病历肯定写着的项不算没写到：只删它，其余项留下", () => {
  const out = sanitize("无胸闷、胸部膨满，与肺胀相区分。");
  assert.doesNotMatch(out, /胸闷[^，。]*是否存在/);
  assert.match(out, /胸部膨满是否存在/);
  const other = sanitize("无胸闷、胸部膨满，与肺胀相区分。", "患者胸部膨满3年，咳嗽。");
  assert.doesNotMatch(other, /胸部膨满是否存在/, "词表外的项病历肯定写着，也不算没写到");
});
await check("1.3 否认词前面的肯定内容不随否认一起丢", () => {
  const out = sanitize("痰多胸闷，无发热，为痰湿", "痰多胸闷，发热，舌苔白腻。");
  assert.match(out, /痰多胸闷/);
  assert.match(sanitize("痛处固定无发热"), /痛处固定，/);
  assert.match(sanitize("咽痛发热、无胸闷而口渴，为风热", "咽痛发热，胸闷，口渴。"), /^咽痛发热，为风热/);
});
await check("1.4 否认词前是部位时并入第一项；是主语时不带", () => {
  assert.match(sanitize("胸部无胸痛"), /胸部胸痛是否存在/);
  assert.match(sanitize("本例无恶寒发热"), /^病历尚未确认恶寒发热是否存在/);
});

await check("2.1 没写到的阴性说法改写成未诉，不删", () => {
  const rec = "患者胃脘胀满半年，纳差。";
  assert.equal(claim.negativeClaimAsNotReported("无喘息气促", rec), "未诉喘息气促");
  assert.equal(claim.negativeClaimAsNotReported("进食无阻塞", rec), "未诉进食阻塞");
  assert.equal(claim.negativeClaimAsNotReported("望无胀形", rec), "未诉胀形");
  assert.equal(claim.negativeClaimAsNotReported("腹不胀大", rec), "未诉腹胀大");
  assert.equal(claim.negativeClaimAsNotReported("与呼吸无关", rec), "未诉与呼吸相关");
  assert.equal(claim.negativeClaimAsNotReported("本例无咯血", rec), "本例未诉咯血");
  assert.equal(claim.negativeClaimAsNotReported("大便无脓血、无里急后重", rec), "未诉大便脓血、里急后重");
  assert.equal(claim.negativeClaimAsNotReported("其痛不在胸膺、不引肩背", rec), "未诉其痛在胸膺、引肩背");
});
await check("2.2 病历肯定写着的、肯定说法、写不成词形的不改写", () => {
  assert.equal(claim.negativeClaimAsNotReported("无胃脘胀满", "患者胃脘胀满半年。"), undefined);
  assert.equal(claim.negativeClaimAsNotReported("右侧疼痛", "患者胃痛。"), undefined);
  assert.equal(claim.negativeClaimAsNotReported("无矢气全无", "患者胃痛。"), undefined);
  assert.equal(claim.negativeClaimAsNotReported("按之无形", "患者胃痛。"), undefined);
  assert.equal(claim.negativeClaimAsNotReported("病势轻浅不传变", "患者胃痛。"), undefined, "前半是判断，不是一个部位或动作");
});
await check("2.3 落到字段上：阴性改写，肯定照删", () => {
  const root = { overview: { tcmDiseaseRationale: "以心下痞为主症，望无胀形，痛如针刺，故归胃痞。" } };
  assert.equal(claim.applyPatientClaimRemovals(root, "tcm", [{ field: "tcmDiseaseRationale", span: "望无胀形" }, { field: "tcmDiseaseRationale", span: "痛如针刺" }], "胃脘痞满半年。"), 2);
  assert.equal(root.overview.tcmDiseaseRationale, "以心下痞为主症，未诉胀形，故归胃痞。");
});

await check("2.4 写别的病的「无X」不改未诉", () => {
  const rec = "背部红肿灼痛，顶部有脓头。";
  assert.match(visible.unrecordedNegativesAsNotReported("其疮头单一，与痈初起光软无头相区分。", rec), /光软无头/);
  assert.match(visible.unrecordedNegativesAsNotReported("故归淋证；与癃闭之尿少无尿痛相区分。", rec), /尿少无尿痛/);
  assert.match(visible.unrecordedNegativesAsNotReported("口僻无半身不遂，痿证无口舌歪斜，可与之区分。", rec), /痿证无口舌歪斜/);
  assert.match(visible.unrecordedNegativesAsNotReported("归入胃痞；本例无咯血，无潮热。", rec), /本例未诉咯血/);
});

await check("3.1 服务端规范的症状名交付写待查", () => {
  assert.equal(surface.deliveredWesternDiagnosisName("乏力症状"), "乏力待查");
  assert.equal(surface.deliveredWesternDiagnosisName("咳嗽咳痰症状"), "咳嗽咳痰待查");
  assert.equal(surface.deliveredWesternDiagnosisName("功能性消化不良"), "功能性消化不良");
});
await check("3.2 病历写着的既往诊断不下调", () => {
  const rec = "既往史：慢性浅表性胃炎病史3年，否认消化性溃疡及手术史。";
  assert.equal(western.recordStatesWesternDiagnosis("慢性胃炎", rec), true);
  assert.equal(western.recordStatesWesternDiagnosis("慢性胃炎待查", rec), true);
  assert.equal(western.recordStatesWesternDiagnosis("消化性溃疡", rec), false, "否认的不算");
  assert.equal(western.recordStatesWesternDiagnosis("慢性胃炎", "可疑慢性胃炎，待胃镜。"), false, "可疑不算");
  assert.equal(western.recordStatesWesternDiagnosis("慢性胃炎", "母亲慢性胃炎病史。"), false, "别人的不算");
  assert.equal(western.recordStatesWesternDiagnosis("慢性胃炎", "慢性咳嗽，胃炎。"), false, "跨小句不算");
  const correction = JSON.stringify({ verdict: "inconsistent", type: "D", quote: "慢性浅表性胃炎病史3年", reason: "无胃镜结果，未记录病理", supportedName: "慢性胃炎待查" });
  assert.equal(western.parseWesternNameCorrection(correction, rec, "慢性胃炎"), undefined);
});

await check("3.3 ICD 上一级不算同义写法；改名后推理说明不留半截「的」；降级留模型的依据", async () => {
  const standard = await jiti.import("../src/lib/western-name-standard.server.ts");
  assert.equal(standard.icdNameDropsQualifier("支气管哮喘急性发作", "支气管哮喘"), true);
  assert.equal(standard.icdNameDropsQualifier("高血压病", "高血压"), false, "只差一字的是同义写法");
  assert.equal(standard.icdNameDropsQualifier("眩晕综合征", "前庭功能紊乱"), false);
  assert.equal(western.rationaleAlignedWithRenamedPrimary("长期胀痛，符合紧张型头痛的慢性病程与部位特点；需排除贫血。", "紧张型头痛", "D"), "长期胀痛，考虑紧张型头痛可能，慢性病程与部位特点；需排除贫血。");
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", westernDiagnosis: { primary: { name: "慢性支气管炎", clinicalRationale: "咳嗽半年，符合慢性支气管炎。", supportingFacts: [], limitations: [], suggestedChecks: [] }, differentials: [] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
  const out = visible.declassifyUnsupportedM03WesternPrimary(content, "主诉：咳嗽半年。");
  assert.match(out, /考虑慢性支气管炎可能/);
  assert.doesNotMatch(out, /病程阈值/);
});

await check("3.4 慢性X病程不够但病历写着X：写X；病历没写时仍退到症状", () => {
  const content = (name) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", westernDiagnosis: { primary: { name, clinicalRationale: "符合慢性支气管炎。", supportingFacts: [], limitations: [], suggestedChecks: [] }, differentials: [] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
  const named = visible.declassifyUnmetFormalM03WesternPrimary(content("慢性支气管炎"), "主诉：咳嗽半年。查胸片示支气管炎。");
  assert.match(named, /"name": "支气管炎"/);
  const symptom = visible.declassifyUnmetFormalM03WesternPrimary(content("慢性支气管炎"), "主诉：咳嗽半年。");
  assert.match(symptom, /"name": "咳嗽症状"/);
});

await check("3.5 病历写着病本身：带分期的名字不下调；上一级待查去掉待查；带病程限定的不按主诉改", () => {
  const rec = "主诉：反复咳喘6年。曾诊断为“支气管哮喘”。糖尿病十余年。";
  assert.equal(western.recordStatesWesternDiagnosis("支气管哮喘急性发作", rec), true);
  const d = (name, supportedName) => JSON.stringify({ verdict: "inconsistent", type: "D", quote: "糖尿病十余年", reason: "周围神经病变未记录肌电图", supportedName, missingTest: "肌电图" });
  assert.equal(western.parseWesternNameCorrection(d("x", "糖尿病待查"), rec, "2型糖尿病伴周围神经病变")?.supportedName, "糖尿病");
  assert.equal(western.parseWesternNameCorrection(d("x", "上腹胀满待查"), `上腹胀满，${rec}`, "功能性消化不良")?.supportedName, "上腹胀满待查", "症状上一级不去待查");
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", westernDiagnosis: { primary: { name: "慢性腹泻待查" }, differentials: [] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
  assert.doesNotMatch(visible.normalizeDiagnoseConfidenceAndLabels(content, "主诉：腹痛腹泻半年。"), /腹痛症状/);
});

await check("4.0 三字方名前面是助词时不是方名；方名承载药不在方里不还原；炮制字加别名照写", () => {
  assert.equal(provenance.governedFormulaClaimRanges("桂枝温通阳气、助化痰饮").length, 0);
  assert.equal(provenance.governedFormulaClaimRanges("本方取化痰饮之意").length, 1, "别的位置仍是方名");
  const base = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: { recommendedFormulaNames: ["乌头汤"] }, formula: { candidates: [{ name: "自拟方", declassifiedFromFormulaNames: ["乌头汤"], herbs: ["桂枝", "白芍", "黄芪", "当归", "细辛", "炙甘草"].map((name) => ({ name })), formulaAnalysis: "本方为自拟方。桂枝为君。" }] } };
  assert.equal(surface.projectDeliveredReasoning(base).formula.candidates[0].name, "自拟方");
  const rows = compiler.normalizeModificationsForTest([{ actionType: "add", targetRef: "P1", reason: "固精缩尿", trigger: "若夜尿频多", herbName: "盐益智仁" }], { stage: "diagnose", overview: { tcmDiseaseName: "腰痛", primarySyndrome: "肾虚证" }, pathogenesis: { chain: [{ nodeId: "P1" }] } });
  assert.equal(rows[0]?.herbName, "盐益智仁", JSON.stringify(rows));
});

await check("4.0b 方义里抄来的「本例辨证组方」写自拟方", () => {
  const base = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {}, formula: { candidates: [{ name: "天王补心丹加减", herbs: [{ name: "地黄" }, { name: "麦冬" }], formulaAnalysis: "本方参照天王补心丹加减，故去辰砂，改以本例辨证组方。地黄为君。麦冬为臣。" }] } };
  assert.doesNotMatch(surface.projectDeliveredReasoning(base).formula.candidates[0].formulaAnalysis, /本例辨证组方/);
});

await check("4.0c 模型写滑石包煎时药味表写滑石粉；写先煎或没写煎法的不动", () => {
  const prior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseName: "淋证", primarySyndrome: "膀胱湿热证", primarySyndromeBasis: ["尿频尿急"], recommendedFormulaNames: [] }, pathogenesis: { chain: [{ nodeId: "P1", patientFact: "尿频尿急", pathogenesis: "湿热下注", therapyDirection: "清热利湿" }] }, therapy: { overallMethod: "清热利湿通淋", overallPrinciple: "实则泻之" }, westernDiagnosis: { primary: { name: "尿路感染", supportingFacts: ["尿频尿急"] }, differentials: [] } };
  const herb = (name, role, extra = {}) => ({ name, dose: "12g", role, targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "清热利湿", processing: null, decoctionRequirement: null, ...extra });
  const proposal = (hua) => ({ candidate: { name: "自拟方", applicable: "湿热。", notApplicable: "虚寒者不宜。", herbs: [herb("车前子", "君"), herb("瞿麦", "臣"), herb("萹蓄", "臣"), hua, { ...herb("甘草", "使"), targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "调和诸药" }], formulaAnalysis: "车前子清热利湿为君，瞿麦、萹蓄为臣，滑石利尿通淋为佐，甘草为使。", decoction: { doseCount: "7剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日1剂，水煎分两次温服", followUpNode: "服完7剂复诊" } }, patentAndWestern: [], modifications: [], nonPharma: { diet: "饮食清淡。", lifestyle: "规律作息。", emotion: "保持心情舒畅。", tcmTreatments: [], precautions: ["多饮水。"] } });
  const names = (hua) => compiler.compileM04Proposal(proposal(hua), prior).formula.candidates[0].herbs.map((row) => row.name);
  assert.ok(names(herb("滑石", "佐", { decoctionRequirement: "包煎" })).includes("滑石粉"));
  assert.ok(names(herb("滑石", "佐", { decoctionRequirement: "先煎" })).includes("滑石"));
});

await check("4.1 方义的药名带上药味表炮制栏的字", () => {
  const herbs = [{ name: "白扁豆", processing: "炒" }, { name: "苦杏仁", processing: "燀" }, { name: "枳壳", processing: "麸炒" }, { name: "黄连", processing: "切片" }, { name: "甘草", processing: null }];
  assert.equal(review.withProcessingFromTable("白扁豆健脾，苦杏仁降气，枳壳行气，黄连清热，甘草调和。", herbs), "炒白扁豆健脾，燀苦杏仁降气，麸炒枳壳行气，黄连清热，甘草调和。");
});
await check("4.3 数量词：「故加丹参…，川芎…，郁金…，三药」按三味算", () => {
  const out = review.reviewAuthoredFormulaAnalysis("本方以生脉散为基础加减。人参大补心气为君；麦冬养阴为臣，五味子收敛为佐。心气推动无力，故加丹参活血化瘀，川芎行气活血，郁金行气解郁，三药共为臣佐，使气旺而血行，全方补气而不滞，行血而不伤正。", ["人参", "麦冬", "五味子", "丹参", "川芎", "郁金"]);
  assert.match(out.text, /三药共为臣佐/, out.text);
});
await check("4.2 已带炮制字不叠；交付面接上了（重复投影不变）", () => {
  const herbs = [{ name: "白扁豆", processing: "炒" }];
  assert.equal(review.withProcessingFromTable("炒白扁豆健脾", herbs), "炒白扁豆健脾");
  const base = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {}, formula: { candidates: [{ name: "参苓白术散", herbs: [{ name: "人参" }, { name: "白扁豆", processing: "炒" }, { name: "枳壳", processing: "麸炒" }], formulaAnalysis: "人参补气为君，炒白扁豆健脾为臣，枳壳行气为佐。" }] } };
  const once = surface.projectDeliveredReasoning(base);
  assert.match(once.formula.candidates[0].formulaAnalysis, /炒白扁豆健脾/);
  assert.match(once.formula.candidates[0].formulaAnalysis, /麸炒枳壳行气/);
  assert.equal(surface.projectDeliveredReasoning(once).formula.candidates[0].formulaAnalysis, once.formula.candidates[0].formulaAnalysis);
});

await check("5.1 同源药只有一味在原方时留原方那一味", () => {
  const content = (herbs) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "prescribe", formula: { candidates: [{ name: "黄芪建中汤加减", herbs: herbs.map(([name, role]) => ({ name, role })), formulaAnalysis: "黄芪为君。" }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
  const out = modSafety.dropSafetyConflictingM04CandidateHerbs(content([["黄芪", "君"], ["桂枝", "臣"], ["白芍", "臣"], ["干姜", "佐"], ["生姜", "佐"], ["大枣", "佐"], ["饴糖", "佐"], ["炙甘草", "使"]]), "胃痛1年。");
  assert.match(out, /"name": "生姜"/);
  assert.doesNotMatch(out, /"name": "干姜"/);
});

await check("7.1 治法：说法不同对象相同的补益项算重复；切碎的两字项并回；同字头后半不重写", () => {
  assert.equal(phrasing.withoutRedundantTherapyPhrases("平肝潜阳，清火息风，滋养肝肾，补益肝肾"), "平肝潜阳，清火息风，滋养肝肾");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("滋养肝肾，疏肝解郁"), "滋养肝肾，疏肝解郁");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("调和营卫，益气，益气扶正"), "调和营卫，益气扶正");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("补气健脾，消痞止痛，健脾益气"), "补气健脾，消痞止痛");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("清热，益气，生津，止渴，清热通便"), "清热益气通便，生津止渴");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("宣肺散寒，止咳平喘，温化寒痰，温化寒饮"), "宣肺散寒，止咳平喘，温化寒痰饮");
});

await check("5.2 教材配对带出来的药方中已有时不占行；属名算方中那味；模型自己写的照按加重", () => {
  const prior = { stage: "diagnose", overview: { tcmDiseaseName: "感冒", primarySyndrome: "风寒束表证", recommendedFormulaNames: [] }, pathogenesis: { chain: [{ nodeId: "P1" }] } };
  const row = textbook.textbookRowForSyndrome("感冒", "风寒束表证");
  const index = row.modifications.findIndex((item) => item.herbs.includes("麻黄") && item.herbs.includes("桂枝"));
  const base = { actionType: "add", targetRef: "P1", reason: "桂枝辛温解表", textbookEntry: `E${index + 1}` };
  const hooks = compiler.m04CompilerTestHooks;
  const names = new Set(["麻黄", "荆芥"].map((name) => compiler.modificationHerbIdentity(name)));
  const byId = new Map([[compiler.modificationHerbIdentity("麻黄"), "麻黄"], [compiler.modificationHerbIdentity("荆芥"), "荆芥"]]);
  const partnerInFormula = hooks.normalizeModifications([{ ...base, trigger: "若恶寒甚", herbName: "桂枝" }], prior, names, byId);
  assert.deepEqual(partnerInFormula.items.map((item) => item.herbName), ["桂枝"]);
  assert.equal(partnerInFormula.submittedCount, 1);
  const own = hooks.normalizeModifications([{ actionType: "add", targetRef: "P1", reason: "加强发汗", trigger: "若恶寒甚", herbName: "麻黄" }], prior, names, byId);
  assert.equal(own.items[0].actionType, "adjust", "模型自己写的按加重");
  const none = hooks.normalizeModifications([{ ...base, trigger: "若恶寒甚", herbName: "桂枝" }], prior);
  assert.equal(none.items.length, 2, "方中没有时两味都列");
});
await check("5.1b 管制药材是唯一的君药：拿出，第一味臣药升君；没有臣药时不拿", () => {
  const content = (herbs) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "prescribe", formula: { candidates: [{ name: "自拟方", herbs: herbs.map(([name, role]) => ({ name, role, prescriptionRole: `${role}药：平肝` })), formulaAnalysis: "羚羊角为君。" }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
  const out = modSafety.dropSafetyConflictingM04CandidateHerbs(content([["羚羊角", "君"], ["钩藤", "臣"], ["桑叶", "臣"], ["菊花", "佐"], ["甘草", "使"]]), "目痛4小时。");
  const parsed = JSON.parse(out.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  const herbs = parsed.formula.candidates[0].herbs;
  assert.equal(herbs.some((herb) => herb.name === "羚羊角"), false);
  assert.equal(herbs.find((herb) => herb.name === "钩藤").role, "君");
  assert.equal(herbs.find((herb) => herb.name === "钩藤").prescriptionRole, "君药：平肝");
  assert.equal(herbs.find((herb) => herb.name === "桑叶").role, "臣");
  assert.match(parsed.formula.candidates[0].notApplicable, /羚羊角/);
  const keep = modSafety.dropSafetyConflictingM04CandidateHerbs(content([["羚羊角", "君"], ["菊花", "佐"], ["桑叶", "佐"], ["甘草", "使"]]), "目痛4小时。");
  assert.match(keep, /羚羊角/);
});
await check("5.2b 同用的那一味没留下时，带出来的行也不留", () => {
  const rows = [{ herbName: "炙麻黄", reason: "与紫苏子同用，针对气喘" }, { herbName: "茯苓", reason: "健脾" }];
  assert.deepEqual(compiler.withoutOrphanPartnerRows(rows, ["党参"]).map((row) => row.herbName), ["茯苓"]);
  assert.equal(compiler.withoutOrphanPartnerRows(rows, ["紫苏子"]).length, 2);
  assert.equal(compiler.withoutOrphanPartnerRows([...rows, { herbName: "紫苏子", reason: "降气" }]).length, 3);
});
await check("5.2c 针对病历已记录表现的加减行只拦方向相反的；条件句照旧严格", async () => {
  const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
  const prior = { stage: "diagnose", overview: { tcmDiseaseName: "水肿", primarySyndrome: "水湿浸渍证", primarySyndromeBasis: ["身体酸困"] }, therapy: { overallMethod: "运脾化湿，通阳利水" }, westernDiagnosis: { primary: { supportingFacts: [] } }, pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "水湿内停", therapyDirection: "运脾化湿", patientFact: "身体酸困" }] } };
  assert.equal(contract.modificationRowDirectionIssue("薏苡仁", "渗湿除痹", "身体酸困", prior), undefined, "理由不带高影响方向，药的别的功效不算");
  assert.ok(contract.highImpactHerbDirectionIssue("大黄", "润肠", prior), "夹具：严格判据对这味药确实命中");
  assert.equal(contract.modificationRowDirectionIssue("大黄", "润肠", "身体酸困", prior), undefined, "记录行：理由不带方向时放行");
  assert.ok(contract.modificationRowDirectionIssue("大黄", "泻下通便", "身体酸困", prior), "理由自己写了泻下，治法没有：拦");
  const warm = { ...prior, therapy: { overallMethod: "温阳散寒" }, pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "寒凝", therapyDirection: "温阳散寒", patientFact: "身体酸困" }] } };
  assert.ok(contract.modificationRowDirectionIssue("黄连", "清热燥湿", "身体酸困", warm), "与治法相反的照拦");
});
await check("5.2d 没写若的症状补若按条件句走；便干是通便方向的条件", async () => {
  const prior = { stage: "diagnose", overview: { tcmDiseaseName: "眩晕", primarySyndrome: "痰湿中阻证", primarySyndromeBasis: [] }, westernDiagnosis: { primary: { supportingFacts: [] } }, pathogenesis: { chain: [{ nodeId: "P1", patientFact: "头晕" }] } };
  const rows = compiler.normalizeModificationsForTest([{ actionType: "add", targetRef: "P1", reason: "润肠通便", trigger: "大便偏干", herbName: "瓜蒌" }], prior);
  assert.equal(rows[0]?.trigger, "若大便偏干", JSON.stringify(rows));
  const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
  assert.equal(contract.conditionDeclaresHighImpactDirection("若便干难解", "herb_0_unsupported_high_impact_purge"), true);
  assert.equal(contract.conditionDeclaresHighImpactDirection("若恶风明显", "herb_0_unsupported_high_impact_yang_warm"), true);
});
await check("5.2e 模型自写行「管不到这个症」要两次提名都这么说", async () => {
  const fs = await import("node:fs");
  assert.match(fs.readFileSync("src/lib/m04-modification-fit.server.ts", "utf8"), /needsBothSamples: \(finding\) => finding\.verdict === "misfit"/);
  assert.match(fs.readFileSync("src/lib/cross-model-small-task.server.ts", "utf8"), /options\.needsBothSamples\?\.\(proposal\)/);
});
await check("5.2f 条件句的本症病机照抄节点时写兼见；自己写的、记录行不动", () => {
  const clean = (value, fallback) => value || fallback;
  const node = { pathogenesis: "肺气亏虚，卫表不固，外邪屡犯" };
  assert.equal(compiler.modificationTargetPathogenesis({ trigger: "若大便稀溏加重", targetRef: "P1", reason: "x", symptomPathogenesis: "肺气亏虚，卫外不固，腠理疏松" }, node, clean), "兼见大便稀溏加重");
  assert.equal(compiler.modificationTargetPathogenesis({ trigger: "若大便稀溏加重", targetRef: "P1", reason: "x", symptomPathogenesis: "脾阳不足，运化失司" }, node, clean), "脾阳不足，运化失司");
  assert.equal(compiler.modificationTargetPathogenesis({ trigger: "乏力气短", targetRef: "P1", reason: "x", symptomPathogenesis: "肺气亏虚，卫外不固" }, node, clean), "肺气亏虚，卫外不固");
});
await check("5.3 超过行数时病历写着的症状先留", () => {
  const prior = { stage: "diagnose", overview: { tcmDiseaseName: "胃痞", primarySyndrome: "胃气不和证", primarySyndromeBasis: ["大便干结"] }, westernDiagnosis: { primary: { supportingFacts: ["大便干结"] } }, pathogenesis: { chain: [{ nodeId: "P1", patientFact: "大便干结", syndromeEvidence: "大便干结" }] } };
  const add = (trigger, herbName) => ({ actionType: "add", targetRef: "P1", reason: "理由写够", trigger, herbName });
  const rows = compiler.normalizeModificationsForTest([add("若反酸", "海螵蛸"), add("若食积", "山楂"), add("若便溏", "白术"), add("若寒甚", "丁香"), add("大便干结", "火麻仁")], prior);
  assert.ok(rows.some((row) => row.herbName === "火麻仁"), JSON.stringify(rows.map((row) => row.trigger)));
});

await check("5.4 君药超过两味：《方剂学》方解自己这样列的不算写错，别的照旧", () => {
  const commentary = commentaryModule;
  assert.equal(commentary.textbookNamesTheseAsEmperors("参苓白术散加减", ["人参", "白术", "茯苓"]), true);
  assert.equal(commentary.textbookNamesTheseAsEmperors("消风散", ["荆芥", "防风", "蝉蜕", "牛蒡子"]), true);
  assert.equal(commentary.textbookNamesTheseAsEmperors("参苓白术散", ["人参", "白术", "山药"]), false);
  assert.equal(commentary.textbookNamesTheseAsEmperors("自拟方", ["人参", "白术", "茯苓"]), false);
});
await check("5.5 方向未成立且不对立的终审码换成 T2；方向对立、别的码不换", async () => {
  const api = await jiti.import("../src/lib/diagnosis-api.ts");
  const prior = { stage: "diagnose", overview: { primarySyndrome: "外感风邪证", recommendedFormulaNames: [] }, therapy: { overallMethod: "疏风解表" }, pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "风邪外袭", therapyDirection: "疏风解表" }] } };
  const content = (herb) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ formula: { candidates: [{ formulaNames: [], herbs: [herb] }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
  const chuanxiong = { name: "川芎", role: "君", function: "祛风止痛", prescriptionRole: "君药：疏风解表", targetPathogenesis: "风邪外袭" };
  assert.equal(api.vocabularyOnlyHighImpactReason("m04_candidate_0_herb_0_unsupported_high_impact_blood_move", content(chuanxiong), prior), "m04_candidate_0_herb_0_therapy_vocabulary_unverified_blood_move");
  assert.equal(api.vocabularyOnlyHighImpactReason("m04_candidate_0_herb_0_dose", content(chuanxiong), prior), undefined);
  assert.equal(api.vocabularyOnlyHighImpactReason("m04_candidate_0_herb_5_unsupported_high_impact_blood_move", content(chuanxiong), prior), undefined, "查不到这味不换");
});

await check("5.6 睡眠心神的表现不止顺带一句时不算顺带", async () => {
  const sleep = await jiti.import("../src/lib/incidental-sleep-modification.ts");
  assert.equal(sleep.mindSymptomsProminentInRecord("胃痛3天，睡眠差。"), false);
  assert.equal(sleep.mindSymptomsProminentInRecord("腰酸，失眠多梦，心悸怔忡。"), true);
  assert.equal(sleep.mindSymptomsProminentInRecord("胃痛。", "失眠2月"), true);
  assert.equal(sleep.mindSymptomsProminentInRecord("无失眠，无心悸。"), false);
});

await check("6.2 《方剂学》方解自己写调和诸药的留下；别的方照删", () => {
  const herbs = [{ name: "沙参" }, { name: "麦冬" }, { name: "地黄" }, { name: "玉竹" }, { name: "冰糖" }];
  const make = (name) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {}, formula: { candidates: [{ name, herbs, formulaAnalysis: "麦冬、地黄养阴为君，沙参、玉竹为臣，冰糖为使，濡养肺胃、调和诸药。" }] } });
  assert.match(surface.projectDeliveredReasoning(make("益胃汤")).formula.candidates[0].formulaAnalysis, /调和诸药/);
  assert.doesNotMatch(surface.projectDeliveredReasoning(make("沙参麦冬汤")).formula.candidates[0].formulaAnalysis, /调和诸药/);
});

await check("7.2 核对模型原写的治法项：先摘病历再下结论", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("src/lib/m03-method-coverage.server.ts", "utf8");
  assert.match(source, /先在 why 里摘病历/);
});

await check("6.1 判断词收尾的半截分句去掉", () => {
  assert.equal(surface.withoutDanglingPredicateClauses("舌红苔黄腻，二者成组提示；口干为热。"), "舌红苔黄腻；口干为热。");
  assert.equal(surface.withoutDanglingPredicateClauses("脉弦细，舌脉所示如此。"), "脉弦细，舌脉所示如此。");
  assert.equal(surface.withoutDanglingPredicateClauses("证属肝郁，故。"), "证属肝郁。");
  assert.equal(surface.withoutDanglingPredicateClauses("舌脉所示，属肝郁。"), "舌脉所示，属肝郁。", "「所示」不是判断词收尾");
  const base = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseName: "胃痛", primarySyndrome: "肝气犯胃证", tcmDiagnosticRationale: "胃胀、脉弦，二者成组提示；属肝气犯胃。", tcmDiseaseRationale: "以胃痛为主症。" }, westernDiagnosis: { primary: { name: "胃炎", supportingFacts: [], limitations: [], suggestedChecks: [] }, differentials: [] }, therapy: { overallMethod: "疏肝和胃" }, pathogenesis: { chain: [] } };
  assert.equal(surface.projectDeliveredReasoning(base).overview.tcmDiagnosticRationale, "胃胀、脉弦；属肝气犯胃。");
});


// 甲方全部病历验收（f1）审计里剩下的服务端缺陷。
const stage = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const priorOf = (primary, method) => ({ overview: { primarySyndrome: primary, overallTherapy: method, tcmDiseaseName: "腹痛" }, therapy: { overallMethod: method }, pathogenesis: { chain: [] } });

await check("8.1 中性证名不改成模型没写的寒热虚", () => {
  assert.equal(textbook.textbookNearestRow("感冒", "风邪外袭证", "疏风散邪，通窍止痛", "流涕，鼻塞，头痛"), undefined);
  assert.equal(textbook.textbookNearestRow("不寐", "心神不宁证", "宁心安神，养血调肝", "失眠多梦，心悸"), undefined);
  assert.equal(textbook.textbookNearestRow("感冒", "风寒表证", "辛温解表，宣肺散寒", "恶寒重，发热轻，无汗，鼻塞流清涕")?.syndromeName, "风寒束表证", "写了寒的照旧归一");
  assert.equal(textbook.textbookNearestRow("阳痿", "肾阳不足证", "温肾壮阳", "阳事不举，腰膝酸软，畏寒肢冷")?.syndromeName, "命门火衰证", "火衰是阳衰，不算多下了热");
});

await check("8.2 条件句加减只拦与治法相反的", () => {
  const liver = priorOf("肝气犯胃证", "疏肝解郁，理气止痛");
  assert.equal(stage.modificationRowDirectionIssue("延胡索", "活血行气止痛", "若胃痛较甚", liver), undefined);
  const cold = priorOf("风寒束表证", "辛温解表，宣肺散寒");
  assert.match(stage.modificationRowDirectionIssue("黄芩", "清热燥湿", "若咽痛明显", cold) || "", /heat_clear/);
  assert.ok(stage.modificationRowDirectionIssue("延胡索", "活血行气止痛", "胃痛较甚", liver), "不是条件句、又写了高影响方向的照判");
});

await check("8.3 半夏、旋覆花的温化寒痰不算温里，附子照判", () => {
  const heat = priorOf("中焦气滞证", "理气和中，降逆止呕，清热止痛");
  assert.equal(stage.m04HerbOpposingDirectionIssue({ name: "姜半夏", function: "降逆止呕" }, heat), undefined);
  assert.equal(stage.m04HerbOpposingDirectionIssue({ name: "旋覆花", function: "降逆止呕" }, heat), undefined);
  assert.match(stage.m04HerbOpposingDirectionIssue({ name: "附子", function: "回阳救逆" }, heat) || "", /yang_warm/);
});

await check("8.4 固定说法的「无」不是否认", () => {
  const record = "便血，乏力，舌淡。";
  for (const text of ["脾虚气弱、统摄无权而血溢肠腑", "气血生化无源，故乏力", "心神无主，故惊悸", "筋脉无养，故拘急"]) {
    assert.equal(visible.unrecordedNegativesAsNotReported(text, record), text);
  }
  assert.equal(visible.unrecordedNegativesAsNotReported("无主诉以外的不适，无恶寒", record), "未诉主诉以外的不适，未诉恶寒", "无主诉不是固定说法");
  assert.equal(safety.maskNonNegatingWuWords("统摄无权，便血").includes("无"), false);
  assert.equal(safety.maskNonNegatingWuWords("无便血").includes("无"), true);
});

await check("8.5 「提示…无X」是判断，不改成未诉，也不算编造的病人事实", () => {
  assert.equal(phrasing.negativeClaimItems("提示里无实热壅盛与阴伤之象"), undefined);
  assert.ok(phrasing.negativeClaimItems("大便无脓血"), "病人的阴性说法照旧拆");
  const root = { overview: { tcmDiagnosticRationale: "二便如常，提示里无实热壅盛之象，病位在上。" } };
  claim.applyPatientClaimRemovals(root, "tcm", [{ field: "tcmDiagnosticRationale", span: "提示里无实热壅盛之象" }], "二便如常");
  assert.match(root.overview.tcmDiagnosticRationale, /提示里无实热壅盛之象/);
});

await check("8.6 「发热而无口渴」不断成「发热而，」，概括句不进列举", () => {
  const out = safety.sanitizeUngroundedRedFlagNegations("本例发热而无口渴、面赤等实热之象，属表寒。", { patient: {}, chiefComplaint: "发热", symptoms: "发热，脉浮紧。", conversation: [] });
  assert.doesNotMatch(out, /而，/);
  assert.doesNotMatch(out, /实热之象是否存在/);
  assert.match(out, /属表寒/);
});

await check("8.7 治法里同一个目的只写一次", () => {
  assert.equal(phrasing.withoutRedundantTherapyPhrases("清热凉血调经，固冲调经"), "清热凉血，固冲调经");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("清热凉血调经，疏肝理气"), "清热凉血调经，疏肝理气", "没有同目的的项不动");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("补气，回阳，醒神，醒神，宁心"), "补气回阳，醒神宁心");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("补气，回阳，醒神，醒神宁心"), "补气回阳，醒神宁心", "两字项连写不越过这一段");
});

await check("8.8 土、煨也是炮制：入药味表留在炮制栏，方义跟着写", () => {
  assert.match(review.withProcessingFromTable("以白术为君，肉豆蔻温脾。", [{ name: "白术", processing: "土" }, { name: "肉豆蔻", processing: "煨" }]), /土白术[\s\S]*煨肉豆蔻/);
  const draft = compiler.normalizeM04DraftCandidate({ herbs: [{ name: "土白术", dose: "10g", role: "君" }, { name: "煨肉豆蔻", dose: "6g", role: "臣" }, { name: "土茯苓", dose: "15g", role: "佐" }] });
  assert.deepEqual(draft.herbs.map((herb) => [herb.name, herb.processing || null]), [["白术", "土"], ["肉豆蔻", "煨"], ["土茯苓", null]]);
});

await check("8.9 成人反复感冒的主诉写主诉本身", () => {
  const record = "主诉：反复感冒1年\n现病史：反复感冒，易疲乏，自汗。";
  assert.equal(western.deterministicWesternNameCorrection("反复上呼吸道感染", record, 78)?.supportedName, "反复感冒待查");
  assert.equal(western.deterministicWesternNameCorrection("反复上呼吸道感染", "主诉：反复上呼吸道感染1年余\n现病史：气短乏力。", 66)?.supportedName, "反复感冒待查");
  assert.equal(western.deterministicWesternNameCorrection("反复上呼吸道感染", "主诉：乏力1年\n现病史：既往常感冒，乏力。", 78)?.supportedName, "乏力待查");
});

await check("8.10 肯定写着的项不跟着前面的「不X」改成未诉", () => {
  assert.equal(phrasing.negativeClaimItems("本例发热不恶寒、口渴汗出、舌红苔黄腻"), undefined);
  assert.deepEqual(phrasing.negativeClaimItems("无恶寒、发热")?.items, ["恶寒", "发热"], "无 打头的裸项照旧接着否认");
  const root = { overview: { tcmDiagnosticRationale: "本例发热不恶寒、口渴汗出、舌红苔黄腻，属气分。" } };
  claim.applyPatientClaimRemovals(root, "tcm", [{ field: "tcmDiagnosticRationale", span: "本例发热不恶寒、口渴汗出、舌红苔黄腻" }], "发热，口渴汗出，舌红苔黄腻。");
  assert.match(root.overview.tcmDiagnosticRationale, /舌红苔黄腻/);
});

await check("8.11 心悸不算顺带的睡眠差", async () => {
  const sleep = await jiti.import("../src/lib/incidental-sleep-modification.ts");
  assert.equal(sleep.mindSymptomsProminentInRecord("乏力，心悸，手抖。"), true);
  assert.equal(sleep.mindSymptomsProminentInRecord("乏力，否认心悸。"), false);
});

await check("8.12 医嘱不当治法项", async () => {
  const coverage = await jiti.import("../src/lib/m03-method-coverage.server.ts");
  const base = { method: "解表散邪", recordText: "食海鲜后风团，瘙痒明显，过敏史明确。", chiefComplaint: "风团" };
  assert.equal(coverage.methodItemQualifies({ item: "忌口避敏", quotes: ["食海鲜后风团", "过敏史明确"] }, base), false);
  assert.equal(coverage.methodItemQualifies({ item: "祛风止痒", quotes: ["风团", "瘙痒明显"] }, base), true);
});

await check("8.13 连写重复、悬空的顿号与悬空的药味角色去掉", () => {
  assert.equal(surface.withoutDanglingPredicateClauses("自述正常，但化验单显示高血糖；但化验单显示高血糖，提示不一致。"), "自述正常，但化验单显示高血糖，提示不一致。");
  assert.equal(surface.withoutDanglingPredicateClauses("舌红示热毒偏盛、。口唇肿胀。"), "舌红示热毒偏盛。口唇肿胀。");
  const made = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {}, formula: { candidates: [{ name: "自拟方", herbs: [{ name: "黄连", role: "君" }, { name: "白芍", role: "佐" }], formulaAnalysis: "黄连为君，清热；白芍柔肝为佐；为佐制之品。全方清热。" }] } };
  assert.doesNotMatch(surface.projectDeliveredReasoning(made).formula.candidates[0].formulaAnalysis, /为佐制之品/);
});

await check("8.14 每项自带否认词的列举，病历也否认的项照录", () => {
  const state = { patient: {}, chiefComplaint: "双膝红肿", symptoms: "无发热寒战，无皮疹，无晨僵，无肢体无力，无言语障碍。", conversation: [] };
  const out = safety.sanitizeUngroundedRedFlagNegations("夜间加重；无发热寒战、无皮疹、无晨僵，提示非痹。", state);
  assert.match(out, /晨僵/);
  assert.match(out, /皮疹/);
  const out2 = safety.sanitizeUngroundedRedFlagNegations("神志清楚、无肢体无力、无言语障碍，提示未及神明。", state);
  assert.match(out2, /言语障碍/);
  assert.match(out2, /肢体无力/);
  assert.doesNotMatch(out2, /尚未确认肢体无力/);
  const out3 = safety.sanitizeUngroundedRedFlagNegations("无发热寒战、无皮疹、无晨僵，提示非痹。", { ...state, symptoms: "无发热寒战，无晨僵。" });
  assert.match(out3, /否认[^；]*晨僵/);
  assert.match(out3, /尚未确认皮疹/);
});

await check("8.15 改名不替模型多下脏腑", () => {
  assert.equal(textbook.textbookNearestRow("腹痛", "中焦气滞证", "理气和胃，缓急止痛", "上腹痛3天，舌淡红，苔白，脉弦，面色一般，上腹痛3天，上腹痛3天", ["胃", "中焦"]), undefined);
  assert.equal(textbook.textbookNearestRow("胃痛", "肝气犯胃型", "疏肝解郁，理气和胃", "胃脘胀痛连胁，嗳气", ["肝", "胃"])?.syndromeName, "肝气犯胃证", "写了肝的照旧归一");
});

await check("8.16 医嘱流程不进治法栏", async () => {
  assert.equal(phrasing.withoutRedundantTherapyPhrases("疏风解表，止痒，忌口避敏"), "疏风解表，止痒");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("健脾益肾，评估发育"), "健脾益肾");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("完善检查"), "完善检查", "只有这一项时不清空");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("疏肝解郁，调摄作息"), "疏肝解郁");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("活血化瘀，调经止痛，调经止血"), "活血化瘀，调经止痛止血", "两个说目的的不共用字头");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("温化寒痰，温化寒饮"), "温化寒痰饮");
});

await check("8.17 ICD 同义不多下肿瘤判断、不换一个字", async () => {
  const standard = await jiti.import("../src/lib/western-name-standard.server.ts");
  assert.ok(!standard.icdSynonymCandidates("结膜良性肿物").some((name) => /瘤|癌/u.test(name)));
  assert.ok(!standard.icdSynonymCandidates("产褥期脓毒症").includes("产褥期脓毒病"));
});


await check("8.19 词里的不、无不算又一层否认", () => {
  assert.deepEqual(phrasing.negativeClaimItems("无半身不遂、口舌歪斜")?.items, ["半身不遂", "口舌歪斜"]);
  assert.deepEqual(phrasing.negativeClaimItems("无肢体无力")?.items, ["肢体无力"]);
  assert.equal(phrasing.negativeClaimItems("腹不不胀"), undefined);
  assert.equal(claim.negativeClaimAsNotReported("无半身不遂、口舌歪斜", "头痛3月。"), "未诉半身不遂、口舌歪斜");
});

await check("8.20 加减的教材编号写法不对不作废整张处方", () => {
  assert.equal(compiler.normalizeTextbookEntryId(3), "E3");
  assert.equal(compiler.normalizeTextbookEntryId("E2（选自【教材加减】时写该条编号，自写的行不写这个键）"), "E2");
  assert.equal(compiler.normalizeTextbookEntryId(null), undefined);
  assert.equal(compiler.normalizeTextbookEntryId("教材"), undefined);
  const shape = compiler.M04ProposalSchema.shape.modifications;
  const row = { trigger: "若咳嗽", targetRef: "P1", targetPathogenesis: "肺失宣肃", actionType: "add", herbName: "紫菀", reason: "润肺止咳" };
  for (const textbookEntry of [null, 3, "E2（选自【教材加减】时写该条编号）"]) {
    const parsed = shape.safeParse([{ ...row, textbookEntry }]);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues?.[0] || {}));
  }
});

await check("8.21 方名写着锁定方、未剥名时，这张方自己的药不算方向对立", async () => {
  const modSafety = await jiti.import("../src/lib/m04-modification-safety.ts");
  const prior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { primarySyndrome: "风寒咳嗽", tcmDiseaseName: "咳嗽", recommendedFormulaNames: ["杏苏散"], recommendedFormulaDirection: "杏苏散加减" }, therapy: { overallMethod: "疏风散寒，宣肃肺气" }, pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "风寒袭肺", therapyDirection: "疏风散寒，宣肃肺气" }] } };
  const herb = (name, role, fn) => ({ name, role, function: fn, targetKind: "pathogenesis_node", targetRef: "P1", prescriptionRole: `${role}药：疏风散寒` });
  const herbs = [herb("紫苏叶", "君", "辛温解表"), herb("苦杏仁", "君", "降气止咳"), herb("前胡", "臣", "疏风解表，降气化痰"), herb("生姜", "佐", "温胃散寒，降逆止呕"), herb("甘草", "使", "调和诸药")];
  const wrap = (candidate) => `<!-- DIAGNOSIS_JSON_START -->${JSON.stringify({ stage: "prescribe", formula: { candidates: [{ herbs, formulaAnalysis: "紫苏叶为君，前胡为臣，生姜为佐。", formulaNames: [], ...candidate }] } })}<!-- DIAGNOSIS_JSON_END -->`;
  const names = (content) => JSON.parse(content.slice(content.indexOf("-->") + 3, content.lastIndexOf("<!--"))).formula.candidates[0].herbs.map((item) => item.name);
  assert.deepEqual(names(modSafety.declassifyAndDropOpposingM04CandidateHerbs(wrap({ name: "杏苏散加减" }), prior)), herbs.map((item) => item.name));
  assert.ok(!names(modSafety.declassifyAndDropOpposingM04CandidateHerbs(wrap({ name: "杏苏散加减", constructionType: "self_devised", identityDeclassified: true }), prior)).includes("前胡"), "已剥名的照旧剔");
});

await check("8.22 使甘草调和诸药留着；别的药写调和诸药照删", () => {
  const herbs = ["陈皮", "甘草"];
  const know = (name) => name === "甘草" ? "补脾益气，调和诸药" : "理气健脾";
  assert.match(review.withoutUnsupportedHarmonizingClaims("陈皮佐以理气，使甘草调和诸药。", herbs, know).text, /使甘草调和诸药/);
  assert.doesNotMatch(review.withoutUnsupportedHarmonizingClaims("陈皮理气，调和诸药。", herbs, know).text, /调和诸药/);
});

await check("8.23 依据写「暂不作阳虚论」算排除", () => {
  assert.ok(phrasing.ruleOutCueIndex("畏寒肢冷不明显，暂不作阳虚论。") >= 0);
  assert.equal(phrasing.ruleOutCueIndex("畏寒肢冷，属阳虚。"), -1);
});
