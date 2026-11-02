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

await check("4.1 方义的药名带上药味表炮制栏的字", () => {
  const herbs = [{ name: "白扁豆", processing: "炒" }, { name: "苦杏仁", processing: "燀" }, { name: "枳壳", processing: "麸炒" }, { name: "黄连", processing: "切片" }, { name: "甘草", processing: null }];
  assert.equal(review.withProcessingFromTable("白扁豆健脾，苦杏仁降气，枳壳行气，黄连清热，甘草调和。", herbs), "炒白扁豆健脾，燀苦杏仁降气，麸炒枳壳行气，黄连清热，甘草调和。");
});
await check("4.3 数量词：「故加丹参…，川芎…，郁金…，三药」按三味算", () => {
  const out = review.reviewAuthoredFormulaAnalysis("本方以生脉散为基础加减。人参大补心气为君；麦冬养阴为臣，五味子收敛为佐。心气推动无力，故加丹参活血化瘀，川芎行气活血，郁金行气解郁，三药共为臣佐，使气旺而血行，全方补气而不滞，行血而不伤正。", ["人参", "麦冬", "五味子", "丹参", "川芎", "郁金"]);
  assert.match(out.text, /三药共为臣佐/, out.text);
});
await check("4.2 已带炮制字不叠、重复调用不变", () => {
  const herbs = [{ name: "白扁豆", processing: "炒" }];
  assert.equal(review.withProcessingFromTable("炒白扁豆健脾", herbs), "炒白扁豆健脾");
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
  assert.equal(contract.modificationRowDirectionIssue("大黄", "泻下通便", "身体酸困", prior), undefined, "词表对不上不算错");
  assert.ok(contract.modificationRowDirectionIssue("大黄", "泻下通便", "若大便不通", prior), "条件句严格");
  const warm = { ...prior, therapy: { overallMethod: "温阳散寒" }, pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "寒凝", therapyDirection: "温阳散寒", patientFact: "身体酸困" }] } };
  assert.ok(contract.modificationRowDirectionIssue("黄连", "清热燥湿", "身体酸困", warm), "与治法相反的照拦");
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

await check("6.2 《方剂学》方解自己写调和诸药的留下", () => {
  const herbs = [{ name: "沙参" }, { name: "麦冬" }, { name: "地黄" }, { name: "玉竹" }, { name: "冰糖" }];
  const base = { stage: "prescribe", overview: {}, formula: { candidates: [{ name: "益胃汤", herbs, formulaAnalysis: "麦冬、地黄养阴为君，沙参、玉竹为臣，冰糖为使，濡养肺胃、调和诸药。" }] } };
  const out = surface.projectDeliveredReasoning(base);
  assert.match(out.formula.candidates[0].formulaAnalysis, /调和诸药/, out.formula.candidates[0].formulaAnalysis);
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
});

