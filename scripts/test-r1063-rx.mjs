// 第四十六轮工作包 C（rx，2026-11-15）：随证加减、同药重复、注意事项的服务端成因，按第四十五轮逐字复核的 O/J/X/N/R 项收口。
//  1. 加减：补写的行与编译、开方核对同一个方向判据（「本例已见X」认不出是病历表现，补写被严格方向核对拦下）；补写可写舌脉与主症加强；
//     正常所见不作条件；偶见纳差不加消食药；红旗依据的征象不作条件；清阳不升不加平肝息风药；教材【使用注意】忌/不宜的哺乳、月经过多、
//     多汗、便秘与便溏（加药按便溏一项）；同一味药不同炮制不重复；算不出用量的不列；「调整」不在方中的药不留。
//  2. 注意事项：同一件事的两条只留一条、残句不留、食物不进药物清单、红旗在用药一句不写「不要自行停用」、引起过敏的药不算在用药；
//     备孕而停经伴腹痛出血的不写「月经逾期先验孕」；病历否认糖尿病而本次查出高血糖不写「您有糖尿病」；在用药与病情相抵（二甲双胍与 eGFR<30、
//     非甾体抗炎药与阿司匹林诱发哮喘）、华法林与中药（说明书 INR 监测、人参减弱）；高钾的饮食；「少食甜黏」又推荐蜂蜜、「少喝汤水」又推荐炖汤。
//  3. 可疑妊娠时药典孕妇慎用药不作君臣（总指挥补充：与第四十五轮在孕同一口径）。
// 每条断言都有反证（~/runlogs/r1018/work/r1063/cp/rx.py）。
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
const caution = await jiti.import("../src/lib/herb-record-caution.ts");
const fit = await jiti.import("../src/lib/m04-modification-fit.server.ts");
const safety = await jiti.import("../src/lib/m04-modification-safety.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const required = await jiti.import("../src/lib/required-precautions.server.ts");
const requiredShared = await jiti.import("../src/lib/required-precautions.ts");
const polarity = await jiti.import("../src/lib/clinical-polarity.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const gate = await jiti.import("../src/lib/diagnosis-safety.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = (value) => `正文\n${START}\n${JSON.stringify(value)}\n${END}`;
const unwrap = (content) => JSON.parse(content.slice(content.indexOf(START) + START.length, content.indexOf(END)).trim());

// 眩晕·痰湿中阻（new45-n07 的写法）：补写的「胸闷：加瓜蒌」「白天困倦嗜睡：加石菖蒲」此前在补写这一步被严格方向核对拦下。
const PRIOR_DIZZY = {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "眩晕", primarySyndrome: "痰湿中阻证", primarySyndromeBasis: ["头晕、头重如裹", "苔白腻"], recommendedFormulaNames: [], formulaSelectionMode: "self_devised", recommendedFormulaDirection: "半夏白术天麻汤加减" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "头晕，自觉头重如裹、昏沉不清", pathogenesis: "痰湿中阻，清阳不升", therapyDirection: "化痰祛湿" }] },
  therapy: { overallMethod: "化痰祛湿，健脾和胃", overallPrinciple: "实则泻之" },
  westernDiagnosis: { primary: { name: "头晕待查", supportingFacts: ["伴胸闷、恶心欲吐，痰多色白质黏", "白天困倦嗜睡"] }, differentials: [] },
};
const DIZZY_CASE = types.normalizeCaseStateInput({ chiefComplaint: "头晕、头重如裹1周", patient: { age: 56, sex: "男" }, symptoms: { 现病史: "头晕，自觉头重如裹、昏沉不清，伴胸闷、恶心欲吐，痰多色白质黏，纳呆，白天困倦嗜睡。" }, tongue: "舌胖大，苔白腻", pulse: "脉弦滑" });
const DIZZY_HERBS = ["姜半夏", "天麻", "白术", "茯苓", "橘红", "甘草"];

await check("1.1 补写的现有表现加减与编译、开方核对同一个方向判据：「本例已见X」按病历表现认，理由不带高影响方向的只拦相反方向（恶心欲吐加竹茹「和胃降逆」、困倦嗜睡加石菖蒲「化湿豁痰」照收）", () => {
  const top = (trigger, herbName, dose, reason) => compiler.topUpModificationRow({ trigger, herbName, dose, reason, symptomPathogenesis: "痰湿阻滞" }, { prior: PRIOR_DIZZY, caseState: DIZZY_CASE, candidateHerbNames: DIZZY_HERBS, existingTriggers: [] });
  const zhuru = top("恶心欲吐", "竹茹", "10g", "和胃降逆");
  assert.ok(zhuru, "恶心欲吐加竹茹应收");
  assert.equal(zhuru.trigger, "本例已见恶心欲吐", "交付写法照旧（第四十四轮）");
  assert.ok(top("白天困倦嗜睡", "石菖蒲", "10g", "化湿豁痰"), "困倦嗜睡加石菖蒲应收");
  // 开方安全底线认「本例已见X」是病历表现（normalizedModificationTrigger 去掉前缀），补写的行原样过底线。
  assert.equal(contract.finalModificationTriggerGrounded("本例已见恶心欲吐", PRIOR_DIZZY), true);
  assert.equal(contract.m04ModificationSafetyIssue(zhuru, 0, PRIOR_DIZZY, () => true), undefined);
  // 理由自己写了没成立的高影响方向（开窍醒神）照旧拦；方中已有的药照旧不收。
  assert.equal(top("白天困倦嗜睡", "石菖蒲", "10g", "化湿和胃，醒神"), undefined);
  assert.equal(top("胸闷", "茯苓", "10g", "健脾渗湿"), undefined);
});

await check("1.2 补写提示：可写舌苔舌质脉象与主诉主症的加强；主症加强的药取教材本证的药与点到主症的教材加减", () => {
  const herbs = fit.mainSymptomStrengtheningHerbs({ ...PRIOR_DIZZY, overview: { ...PRIOR_DIZZY.overview, tcmDiseaseName: "眩晕", primarySyndrome: "痰湿中阻证" } }, "头晕、头重如裹1周", DIZZY_HERBS);
  assert.ok(Array.isArray(herbs));
  assert.ok(herbs.length > 0, "教材眩晕·痰湿中阻证应有可选药");
  assert.ok(!herbs.some((name) => DIZZY_HERBS.includes(name)), "不含方中已有的药");
});

await check("1.3 正常所见不作加减条件（面色红润、舌淡红苔薄白、脉平）；「不寐」「面色萎黄」「苔白腻」照常", () => {
  for (const trigger of ["面色红润", "本例已见面色红润", "舌淡红，苔薄白", "脉平"]) assert.equal(compiler.modificationTriggerIsNormalState(trigger), true, trigger);
  for (const trigger of ["不寐", "面色萎黄", "苔白腻", "脉弦", "大便偏溏"]) assert.equal(compiler.modificationTriggerIsNormalState(trigger), false, trigger);
});

const PRIOR_HEAT = { stage: "diagnose", overview: { primarySyndrome: "热毒内盛证", tcmDiseaseName: "淋证", secondarySyndromes: [] }, therapy: { overallMethod: "清热解毒，利湿通淋" }, pathogenesis: { chain: [{ pathogenesis: "湿热毒邪蕴结下焦" }] } };
await check("1.4 偶见纳差不加消食药：热毒、胃热证的纳差加焦山楂不收；脾失健运、食积证照收；主诉就是纳差照收；非消食药不在此列", () => {
  assert.equal(compiler.incidentalAppetiteDigestiveModification({ trigger: "本例已见食欲下降", herbName: "焦山楂" }, PRIOR_HEAT, "尿频尿痛伴意识改变3天"), true);
  assert.equal(compiler.incidentalAppetiteDigestiveModification({ trigger: "纳差", herbName: "焦山楂" }, { ...PRIOR_HEAT, overview: { primarySyndrome: "胃热炽盛证", tcmDiseaseName: "牙痛" }, therapy: { overallMethod: "清胃泻火" } }, "牙痛3天"), true, "11.05 病历8");
  assert.equal(compiler.incidentalAppetiteDigestiveModification({ trigger: "纳呆", herbName: "焦神曲" }, { overview: { primarySyndrome: "痰浊头痛", tcmDiseaseName: "头痛" }, pathogenesis: { chain: [{ pathogenesis: "脾失健运，痰浊中阻，上蒙清窍" }] } }, "头痛昏蒙2周"), false, "脾失健运");
  assert.equal(compiler.incidentalAppetiteDigestiveModification({ trigger: "纳差", herbName: "焦山楂" }, { overview: { primarySyndrome: "食滞胃肠证", tcmDiseaseName: "胃痛" } }, "胃脘胀痛2天"), false, "食积");
  assert.equal(compiler.incidentalAppetiteDigestiveModification({ trigger: "纳差", herbName: "焦山楂" }, PRIOR_HEAT, "纳差1月"), false, "主诉就是纳差");
  assert.equal(compiler.incidentalAppetiteDigestiveModification({ trigger: "纳差", herbName: "砂仁" }, PRIOR_HEAT, "尿频3天"), false, "化湿药不在此列");
  assert.equal(compiler.incidentalAppetiteDigestiveModification({ trigger: "纳差、腹胀", herbName: "焦山楂" }, PRIOR_HEAT, "尿频3天"), false, "条件里另有腹胀");
  // 补写同一判据。
  const prior = { ...PRIOR_DIZZY, overview: { ...PRIOR_DIZZY.overview, primarySyndrome: "热毒内盛证", tcmDiseaseName: "丹毒" }, therapy: { overallMethod: "清热解毒" }, pathogenesis: { chain: [{ nodeId: "P1", patientFact: "皮肤红肿热痛", pathogenesis: "热毒蕴结肌肤", therapyDirection: "清热解毒" }] } };
  const record = types.normalizeCaseStateInput({ chiefComplaint: "右小腿红肿热痛2天", patient: { age: 60, sex: "男" }, symptoms: { 现病史: "右小腿红肿热痛2天，发热，纳差。" } });
  assert.equal(compiler.topUpModificationRow({ trigger: "纳差", herbName: "焦山楂", dose: "10g", reason: "消食开胃" }, { prior, caseState: record, candidateHerbNames: ["金银花"], existingTriggers: [] }), undefined);
});

const RED_FLAG_CASE = { safetyGate: { status: "red_flag", redFlags: ["现有资料提示需立即急诊评估（需排除：急性脑血管事件），原文依据：“突发右侧肢体麻木伴言语含糊”"] } };
await check("1.5 红旗病例里作为急危重依据的征象不作加减条件（少尿、拒食、喷射性呕吐、红旗原文里的症状）；非红旗与非急症表现照常", () => {
  assert.equal(compiler.modificationTriggerIsEmergencySign("尿量明显减少", RED_FLAG_CASE), true);
  assert.equal(compiler.modificationTriggerIsEmergencySign("本例已见拒食", RED_FLAG_CASE), true);
  assert.equal(compiler.modificationTriggerIsEmergencySign("肢体麻木", RED_FLAG_CASE), true, "红旗原文里的症状");
  assert.equal(compiler.modificationTriggerIsEmergencySign("颈部发硬", RED_FLAG_CASE), true, "脑膜刺激征（new40-m40）");
  assert.equal(compiler.modificationTriggerIsEmergencySign("言语含糊不清", { safetyGate: { status: "red_flag", redFlags: ["需立即急诊评估。原文依据：“呼之可应”；另见：言语含糊"] } }), true, "红旗「另见」里的症状");
  assert.equal(compiler.modificationTriggerIsEmergencySign("咽痛", RED_FLAG_CASE), false);
  assert.equal(compiler.modificationTriggerIsEmergencySign("尿量明显减少", { safetyGate: { status: "needs_information", redFlags: [] } }), false, "非红旗");
  // 编译与补写共用的判据：红旗病例补写「尿量减少：加淡竹叶」不收。
  const record = types.normalizeCaseStateInput({ chiefComplaint: "头晕、头重如裹1周", patient: { age: 56, sex: "男" }, symptoms: { 现病史: "头晕，头重如裹，胸闷，尿量减少。" } });
  const redRecord = { ...record, safetyGate: { status: "red_flag", redFlags: ["循环灌注不足"] } };
  const row = { trigger: "尿量减少", herbName: "车前子", dose: "10g", reason: "利水渗湿", symptomPathogenesis: "气化不利" };
  assert.equal(compiler.topUpModificationRow(row, { prior: PRIOR_DIZZY, caseState: redRecord, candidateHerbNames: DIZZY_HERBS, existingTriggers: [] }), undefined);
  assert.ok(compiler.topUpModificationRow(row, { prior: PRIOR_DIZZY, caseState: record, candidateHerbNames: DIZZY_HERBS, existingTriggers: [] }), "非红旗照收");
});

await check("1.6 清阳不升、中气下陷之证不加平抑肝阳的潜降药（石决明、代赭石）；肝阳上亢照加；天麻（《中药学》治眩晕不论虚实）、牡蛎（收敛固涩）、补气药不在此列", () => {
  assert.equal(compiler.modificationHerbOpposesAscending("石决明", "清阳不升证"), true);
  assert.equal(compiler.modificationHerbOpposesAscending("代赭石", "中气下陷证"), true);
  assert.equal(compiler.modificationHerbOpposesAscending("石决明", "肝阳上亢证"), false);
  assert.equal(compiler.modificationHerbOpposesAscending("天麻", "清阳不升证"), false);
  assert.equal(compiler.modificationHerbOpposesAscending("牡蛎", "中气下陷证"), false);
  assert.equal(compiler.modificationHerbOpposesAscending("黄芪", "清阳不升证"), false);
});

const LACTATING = "患者年龄：26岁\n患者性别：女\n5周前足月顺产，现母乳喂养。左乳胀痛，纳谷不馨，大便干结。";
await check("1.7 加药的教材强注意（忌服/不宜/禁用）：哺乳期不加麦芽、月经量多不加牡丹皮、表虚多汗不加薄荷；风热汗出照用薄荷；便溏加熟地黄按便溏一项判（方中药味仍要食少）", () => {
  assert.ok(caution.herbStrongRecordCautionConflict("麦芽", LACTATING, "肝胃郁热证"), "哺乳加麦芽");
  assert.equal(caution.herbStrongRecordCautionConflict("麦芽", "患者年龄：26岁\n患者性别：女\n纳谷不馨，大便干结。", "肝胃郁热证"), undefined, "不在哺乳期");
  assert.ok(caution.herbStrongRecordCautionConflict("牡丹皮", "近3个月月经量明显增多，色淡红。", "气虚证"), "月经过多加牡丹皮");
  assert.ok(caution.herbStrongRecordCautionConflict("薄荷", "动则汗出，汗多，乏力。", "肺卫气虚证"), "气虚多汗");
  assert.equal(caution.herbStrongRecordCautionConflict("薄荷", "发热，多汗，咽痛。", "风热犯表证"), undefined, "风热多汗：限定词体虚要求证候有虚");
  assert.ok(caution.herbStrongRecordCautionConflict("补骨脂", "大便干结，三日一行。", "肾阳虚证"), "便秘");
  assert.equal(caution.herbStrongRecordCautionConflict("浮小麦", "稍动则自汗，乏力。", "气虚发热证"), undefined, "气虚自汗用浮小麦（限定词表邪要求表证）");
  assert.ok(caution.herbStrongRecordCautionConflict("浮小麦", "发热恶风，汗多。", "风热犯表证"), "表证汗出忌浮小麦");
  const loose = "经后头晕乏力明显，纳食一般，大便偏溏、每日1-2次。";
  assert.ok(caution.herbRecordCautionConflict("熟地黄", loose, "气虚证", { addition: true }), "加药：便溏一项即可");
  assert.equal(caution.herbRecordCautionConflict("熟地黄", loose, "气虚证"), undefined, "方中药味：食少便溏要两项");
  // 编译、补写共用 modificationAddBlock：哺乳期补写「纳谷不馨：加麦芽」不收。
  const prior = { ...PRIOR_DIZZY, overview: { ...PRIOR_DIZZY.overview, primarySyndrome: "肝胃郁热证", tcmDiseaseName: "乳痈" }, therapy: { overallMethod: "疏肝清胃，通乳消肿" }, pathogenesis: { chain: [{ nodeId: "P1", patientFact: "左乳胀痛", pathogenesis: "肝郁胃热，乳络阻滞", therapyDirection: "疏肝清胃" }] }, westernDiagnosis: { primary: { name: "急性乳腺炎", supportingFacts: ["纳谷不馨"] } } };
  const record = types.normalizeCaseStateInput({ chiefComplaint: "哺乳期左乳肿痛2天", patient: { age: 26, sex: "女" }, symptoms: { 现病史: "5周前足月顺产，现母乳喂养。左乳胀痛，纳谷不馨。", 婚育史: "孕1产1，现哺乳期" } });
  assert.equal(compiler.topUpModificationRow({ trigger: "纳谷不馨", herbName: "麦芽", dose: "12g", reason: "健脾开胃" }, { prior, caseState: record, candidateHerbNames: ["蒲公英", "柴胡"], existingTriggers: [] }), undefined);
  // 只有强注意这一条拦的：肾阳虚证大便干结，补写「腰膝冷痛：加补骨脂」不收（补骨脂「阴虚火旺、大便秘结者忌服」）；大便正常时照收（对照）。
  const kidney = { ...PRIOR_DIZZY, overview: { ...PRIOR_DIZZY.overview, primarySyndrome: "肾阳虚证", tcmDiseaseName: "腰痛", primarySyndromeBasis: ["腰膝冷痛", "畏寒肢冷"] }, therapy: { overallMethod: "温补肾阳" }, pathogenesis: { chain: [{ nodeId: "P1", patientFact: "腰膝冷痛，畏寒肢冷", pathogenesis: "肾阳不足，腰府失煦", therapyDirection: "温补肾阳" }] }, westernDiagnosis: { primary: { name: "腰痛", supportingFacts: ["腰膝冷痛", "畏寒肢冷"] } } };
  const constipated = types.normalizeCaseStateInput({ chiefComplaint: "腰痛半年", patient: { age: 60, sex: "男" }, symptoms: { 现病史: "腰膝冷痛，畏寒肢冷，大便干结，三日一行。" } });
  const regular = types.normalizeCaseStateInput({ chiefComplaint: "腰痛半年", patient: { age: 60, sex: "男" }, symptoms: { 现病史: "腰膝冷痛，畏寒肢冷，大便调。" } });
  const buguzhi = { trigger: "腰膝冷痛", herbName: "补骨脂", dose: "9g", reason: "温肾助阳", symptomPathogenesis: "肾阳不足" };
  assert.equal(compiler.topUpModificationRow(buguzhi, { prior: kidney, caseState: constipated, candidateHerbNames: ["附子", "肉桂", "熟地黄"], existingTriggers: [] }), undefined, "便秘忌补骨脂");
  assert.ok(compiler.topUpModificationRow(buguzhi, { prior: kidney, caseState: regular, candidateHerbNames: ["附子", "肉桂", "熟地黄"], existingTriggers: [] }), "大便调照收");
});

await check("1.8 同一味药不同炮制算同一味：甘草与炙甘草、黄芪与炙黄芪、法半夏与姜半夏；生地黄与熟地黄、赤芍与白芍不算；加减不重复加、方中有甘草不再加炙甘草", () => {
  assert.equal(compiler.sameDrugDifferentProcessing("甘草", "炙甘草"), true);
  assert.equal(compiler.sameDrugDifferentProcessing("黄芪", "炙黄芪"), true);
  assert.equal(compiler.sameDrugDifferentProcessing("法半夏", "姜半夏"), true);
  assert.equal(compiler.sameDrugDifferentProcessing("生地黄", "熟地黄"), false);
  assert.equal(compiler.sameDrugDifferentProcessing("赤芍", "白芍"), false);
  assert.equal(compiler.sameDrugDifferentProcessing("甘草", "甘草"), false);
  const rows = compiler.withoutRepeatedAddedHerbs([{ trigger: "心悸", action: "加", herbName: "炙甘草" }, { trigger: "乏力", action: "加", herbName: "甘草" }, { trigger: "口干", action: "加", herbName: "麦冬" }]);
  assert.deepEqual(rows.map((row) => row.herbName), ["炙甘草", "麦冬"]);
  assert.equal(compiler.topUpModificationRow({ trigger: "胸闷", herbName: "炙甘草", dose: "6g", reason: "益气复脉" }, { prior: PRIOR_DIZZY, caseState: DIZZY_CASE, candidateHerbNames: DIZZY_HERBS, existingTriggers: [] }), undefined, "方中已有甘草");
});

await check("1.9 方中药味两种炮制同列（炙甘草与甘草）：定稿只留地位高的一味并写明；生地黄与熟地黄同列不动", () => {
  const herb = (name, role, dose = "6g") => ({ name, dose, role, function: "补气", targetKind: "pathogenesis_node", targetRef: "P1" });
  const content = wrap({ overview: { primarySyndrome: "气虚证" }, formula: { candidates: [{ name: "自拟方", herbs: [herb("人参", "君"), herb("黄芪", "臣", "15g"), herb("炙甘草", "臣"), herb("白术", "佐", "10g"), herb("甘草", "使", "3g")], formulaAnalysis: "人参为君，黄芪、炙甘草为臣，白术为佐，甘草调和诸药。" }], modifications: [] } });
  const out = unwrap(safety.dropSafetyConflictingM04CandidateHerbs(content, "患者年龄：73岁\n乏力，出汗。"));
  const names = out.formula.candidates[0].herbs.map((item) => item.name);
  assert.ok(names.includes("炙甘草") && !names.includes("甘草"), names.join("、"));
  assert.match(out.formula.candidates[0].notApplicable, /同一味药的不同炮制品/u);
  const keep = wrap({ overview: { primarySyndrome: "阴虚证" }, formula: { candidates: [{ name: "自拟方", herbs: [herb("生地黄", "君", "15g"), herb("熟地黄", "臣", "15g"), herb("麦冬", "佐", "10g"), herb("甘草", "使", "3g")] }], modifications: [] } });
  assert.equal(safety.dropSafetyConflictingM04CandidateHerbs(keep, "患者年龄：50岁\n口干。"), keep);
});

await check("1.10 「调整」「减」的药不在最终药味里时这一行不留（定稿与交付面同一判据）；在方中的、同一味药另一炮制在方中的照留", () => {
  const rows = [
    { trigger: "反酸", action: "调整", herbName: "瓦楞子" },
    { trigger: "乏力", action: "调整", herbName: "炙甘草" },
    { trigger: "口干", action: "加", herbName: "麦冬" },
  ];
  const kept = compiler.withoutModificationsOnAbsentHerbs(rows, ["白术", "甘草", "陈皮"]);
  assert.deepEqual(kept.map((row) => row.herbName), ["炙甘草", "麦冬"]);
  const content = wrap({ formula: { candidates: [{ name: "自拟方", herbs: [{ name: "白术" }, { name: "甘草" }, { name: "陈皮" }] }], modifications: rows }, nonPharma: { precautions: ["饭后温服。"] } });
  const out = unwrap(safety.withoutPrecautionsNamingAbsentHerbs(content));
  assert.deepEqual(out.formula.modifications.map((row) => row.herbName), ["炙甘草", "麦冬"]);
});

await check("1.11 方义里同一味药紧挨着写两遍（「去桃仁、燀桃仁」）只留一个；不同的药照列", () => {
  assert.equal(surface.withoutSameDrugRepeatsInLists("本方参照解毒活血汤加减，因患者哺乳，去桃仁、燀桃仁，以牡丹皮易之。"), "本方参照解毒活血汤加减，因患者哺乳，去桃仁，以牡丹皮易之。");
  assert.equal(surface.withoutSameDrugRepeatsInLists("黄芪、炙黄芪为君，补气升阳。"), "黄芪为君，补气升阳。");
  assert.equal(surface.withoutSameDrugRepeatsInLists("人参、白术、茯苓补气健脾。"), "人参、白术、茯苓补气健脾。");
  assert.equal(surface.withoutSameDrugRepeatsInLists("生地黄、熟地黄滋阴养血。"), "生地黄、熟地黄滋阴养血。");
});

// ── 注意事项 ─────────────────────────────────────────────────────────────
await check("2.1 同一件事的两条只留一条（低血糖规则句与模型句、同一药带去就医两句）；只差一个症状、不同的药、方中不同毒药的两条不并；模型写了低血糖处置不点「低血糖」也算写到", () => {
  const rule = "本次是低血糖发作，请按医嘱调整降糖药、按时进餐、随身带糖果；出现心慌、出汗、手抖、头晕时立即吃含糖食物并测血糖，神志不清时立即急诊。";
  const model = "请按医嘱调整降糖药、按时进餐、随身带糖果，出现心慌出汗手抖头晕时立即吃含糖食物并测血糖，神志不清立即急诊。";
  assert.deepEqual(surface.withoutNearDuplicatePrecautions([rule, "饮食清淡。", model], []), [rule, "饮食清淡。"]);
  const ruleLine = "请把正在使用的格列本脲连同药盒带去就医，告诉医生最近一次用药的时间；是否继续使用由医生决定。";
  const modelLine = "请把格列本脲连同药盒带去就医，告诉医生最近一次用药时间，是否继续使用由医生决定。";
  assert.deepEqual(surface.withoutNearDuplicatePrecautions([ruleLine, modelLine], ["格列本脲"]), [ruleLine]);
  const unnamed = "请把正在用的药连同药盒带去就医。";
  const namedLine = "请把正在用的格列本脲连同药盒带去就医。";
  assert.deepEqual(surface.withoutNearDuplicatePrecautions([unnamed, namedLine], ["格列本脲"]), [namedLine], "留点到药名的那条");
  const rash = "服药期间如出现皮疹，请及时告知医生。";
  const diarrhea = "服药期间如出现腹泻，请及时告知医生。";
  assert.deepEqual(surface.withoutNearDuplicatePrecautions([rash, diarrhea], []), [rash, diarrhea], "只差一个症状，不并");
  const own = "您已自服板蓝根颗粒，服本方期间是否继续服用由医生决定。";
  const other = "您已自服麝香通心滴丸，服本方期间是否继续服用由医生决定。";
  assert.deepEqual(surface.withoutNearDuplicatePrecautions([own, other], []), [own, other], "不同的药，不并");
  const a = "方中附子在药典中标注有毒，须按医生开的剂量和煎法服用，不可自行加量或久服。";
  const b = "方中细辛在药典中标注有毒，须按医生开的剂量和煎法服用，不可自行加量或久服。";
  assert.deepEqual(surface.withoutNearDuplicatePrecautions([a, b], ["附子", "细辛"]), [a, b]);
  const covered = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "生脉散", herbs: [{ name: "人参", role: "君" }] }], modifications: [] }, nonPharma: { precautions: [model] } },
    { requiredPrecautions: [{ kind: "diabetes_glucose", confirmed: true, hypoglycemia: true }] });
  assert.deepEqual(covered.nonPharma.precautions, [model], "模型写到了，不补规则句");
});

await check("2.2 残句不留（只有条件「服药期间如出现胃脘不适。」、「方中柴胡、香附等行气之品，请告知医生。」）；带处理办法的条件句照留", () => {
  assert.equal(surface.isDanglingPrecaution("服药期间如出现胃脘不适。"), true);
  assert.equal(surface.isDanglingPrecaution("方中柴胡、香附等行气之品，请告知医生。"), true);
  assert.equal(surface.isDanglingPrecaution("如出现皮疹请停药并就医。"), false);
  assert.equal(surface.isDanglingPrecaution("服药期间如出现胃脘不适，可改为饭后服用。"), false);
  assert.equal(surface.isDanglingPrecaution("方中附子有毒，须先煎，请勿自行加量。"), false);
});

await check("2.3 药物清单里的食物与自制食疗去掉（猪血、梨水）；饮食段说的食物不动", () => {
  assert.equal(surface.withoutFoodsInMedicationList("请把猪血、网购补铁剂、阿司匹林肠溶片连同药盒带去就医。"), "请把网购补铁剂、阿司匹林肠溶片连同药盒带去就医。");
  assert.equal(surface.withoutFoodsInMedicationList("少吃红枣、桂圆。"), "少吃红枣、桂圆。");
});

const careState = (symptoms, extra = {}) => gate.withSafetyGate(types.normalizeCaseStateInput({ chiefComplaint: extra.chiefComplaint || "乏力1月", patient: extra.patient || { age: 60, sex: "男" }, symptoms, ...(extra.vitals ? { vitals: extra.vitals } : {}) }));
await check("2.4 本次引起过敏的药不算在用药（不写「是否继续由医生决定」）；红旗在用药一句不写「不要自行加用或停用」", () => {
  const state = careState({ 现病史: "咽痛发热3天，规律服用头孢呋辛酯片，服头孢呋辛酯片后出现皮疹瘙痒，目前仍在服用。" }, { chiefComplaint: "咽痛3天", patient: { age: 30, sex: "女" } });
  const items = required.requiredPrecautionsForCase(state, null);
  const current = items.find((item) => item.kind === "current_medications");
  assert.ok(!current || !current.names.some((name) => /头孢呋辛/u.test(name)), JSON.stringify(current));
  assert.ok(items.some((item) => item.kind === "drug_allergy"));
  // 对照：没有过敏记录时照算在用药。
  const plain = required.requiredPrecautionsForCase(careState({ 现病史: "咽痛发热3天，规律服用头孢呋辛酯片，目前仍在服用。" }, { chiefComplaint: "咽痛3天", patient: { age: 30, sex: "女" } }), null);
  assert.ok(plain.find((item) => item.kind === "current_medications")?.names.some((name) => /头孢呋辛/u.test(name)), JSON.stringify(plain));
  const line = surface.withoutNearDuplicatePrecautions([], []);
  assert.deepEqual(line, []);
  const projected = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "银翘散", herbs: [{ name: "金银花", role: "君" }] }], modifications: [] }, nonPharma: { precautions: [] } },
    { requiredPrecautions: [{ kind: "current_medications", names: ["布洛芬"], urgent: true }] });
  const urgent = projected.nonPharma.precautions.find((text) => /布洛芬/u.test(text));
  assert.ok(urgent && !/不要自行(?:加用或)?停用/u.test(urgent), urgent);
});

await check("2.5 药名清理：剂型后紧跟的用途截掉（布洛芬混悬液退热→布洛芬混悬液）；「自己网购的补铁口服液」去掉来源说法、不在「口服」处截断；「小儿退热颗粒」不动", () => {
  assert.equal(polarity.cleanedMedicationNameCandidate("布洛芬混悬液退热"), "布洛芬混悬液");
  assert.equal(polarity.cleanedMedicationNameCandidate("自己网购的补铁口服液"), "补铁口服液");
  assert.equal(polarity.cleanedMedicationNameCandidate("小儿退热颗粒"), "小儿退热颗粒");
  assert.equal(polarity.cleanedMedicationNameCandidate("点止咳糖浆"), "止咳糖浆");
  assert.equal(polarity.cleanedMedicationNameCandidate("点舌丸"), "点舌丸");
  // 写明没有吃的药（「担心影响胎儿未服」）不算在用药（new45-n18）；吃了的照算。
  assert.equal(polarity.medicationNotTaken("婆婆建议“咳嗽要吃点止咳糖浆”，患者担心影响胎儿未服。", "止咳糖浆"), true);
  assert.equal(polarity.medicationNotTaken("自服止咳糖浆3天，咳嗽未减。", "止咳糖浆"), false);
});

await check("2.6 备孕而本次月经已逾期：不写「备孕期间…如月经逾期请先验孕」，写「月经已逾期、服药前先验孕」；红旗（疑异位妊娠破裂）时两句都不写；单纯备孕照写", () => {
  const acute = careState({ 现病史: "平素月经规律，末次月经2026-09-28，本次月经未按时来潮。2天前阴道少量出血，今晨突然右下腹撕扯样疼痛。", 婚育史: "已婚，G2P0，目前未避孕" }, { chiefComplaint: "下腹痛半天，阴道少量出血2天", patient: { age: 29, sex: "女" } });
  const acuteItems = required.requiredPrecautionsForCase(acute, null).map((item) => item.kind);
  assert.ok(!acuteItems.includes("conception_pregnancy_check"), acuteItems.join(","));
  const redFlagItems = required.requiredPrecautionsForCase({ ...acute, safetyGate: { ...acute.safetyGate, status: "red_flag" } }, null).map((item) => item.kind);
  assert.ok(!redFlagItems.includes("conception_pregnancy_check") && !redFlagItems.includes("menses_overdue_pregnancy_check"), redFlagItems.join(","));
  const overdue = careState({ 现病史: "反复头痛1月，本次月经未按时来潮。", 婚育史: "已婚，目前未避孕" }, { chiefComplaint: "头痛1月", patient: { age: 29, sex: "女" } });
  assert.ok(required.requiredPrecautionsForCase(overdue, null).some((item) => item.kind === "menses_overdue_pregnancy_check"));
  const plain = careState({ 现病史: "反复头痛1月。", 婚育史: "已婚，目前备孕" }, { chiefComplaint: "头痛1月", patient: { age: 29, sex: "女" } });
  assert.ok(required.requiredPrecautionsForCase(plain, null).some((item) => item.kind === "conception_pregnancy_check"));
});

await check("2.7 病历否认糖尿病、本次查出血糖明显升高：不写「您有糖尿病，继续控制血糖」，写尽快明确诊断；已知糖尿病照旧", () => {
  const prior = { westernDiagnosis: { primary: { name: "糖尿病酮症酸中毒" } }, overview: { tcmDiseaseName: "消渴" } };
  const fresh = careState({ 现病史: "恶心呕吐2天，口渴多饮1月。", 既往史: "既往体健，否认糖尿病、高血压病史。", 辅助检查: "指尖血糖26.8mmol/L" }, { chiefComplaint: "恶心、呕吐2天", patient: { age: 24, sex: "男" } });
  const item = required.requiredPrecautionsForCase(fresh, prior).find((entry) => entry.kind === "diabetes_glucose");
  assert.ok(item?.newlyFound, JSON.stringify(item));
  const projected = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "玉女煎", herbs: [{ name: "石膏", role: "君" }] }], modifications: [] }, nonPharma: { precautions: [] } }, { requiredPrecautions: [item] });
  const line = projected.nonPharma.precautions.find((text) => /血糖/u.test(text));
  assert.ok(line && !/您有糖尿病|继续控制血糖/u.test(line) && /明确诊断/u.test(line), line);
  const known = careState({ 现病史: "口渴多饮。", 既往史: "2型糖尿病5年。" }, { chiefComplaint: "口渴1月" });
  assert.ok(!required.requiredPrecautionsForCase(known, prior).find((entry) => entry.kind === "diabetes_glucose")?.newlyFound);
});

await check("2.8 在用药与病情相抵：eGFR 17 仍服二甲双胍、阿司匹林诱发喘息又自服双氯芬酸，各写一条，且这几味不再进「是否继续由医生决定」；eGFR 正常不写", () => {
  const renal = careState({ 现病史: "双下肢浮肿1月。", 既往史: "慢性肾脏病4期。现用药：二甲双胍片0.5g每日2次（一直在吃），硝苯地平控释片30mg每日1次。", 辅助检查: "eGFR 17ml/(min·1.73m²)" }, { chiefComplaint: "双下肢浮肿1月", patient: { age: 78, sex: "男" } });
  const items = required.requiredPrecautionsForCase(renal, null);
  const metformin = items.find((item) => item.kind === "drug_condition_caution" && /二甲双胍/u.test(item.drug));
  assert.ok(metformin && /eGFR 17/u.test(metformin.sentence), JSON.stringify(items.map((item) => item.kind)));
  const current = items.find((item) => item.kind === "current_medications");
  assert.ok(!current?.names.some((name) => /二甲双胍/u.test(name)), JSON.stringify(current));
  const nsaid = required.drugConditionCautions(["双氯芬酸"], "既往高尿酸血症，慢性肾病3期。", ["阿司匹林诱发喘息"]);
  assert.equal(nsaid[0]?.ruleId, "nsaid_after_aspirin_asthma");
  assert.match(nsaid[0].sentence, /喘息/u);
  assert.equal(required.drugConditionCautions(["双氯芬酸"], "既往高尿酸血症，慢性肾病3期。", [])[0]?.ruleId, "nsaid_ckd");
  assert.deepEqual(required.drugConditionCautions(["二甲双胍片"], "eGFR 88。", []), []);
  assert.equal(required.recordedEgfr("eGFR 17ml/(min·1.73m²)，另一次 eGFR：25"), 17);
});

await check("2.9 正在服华法林：写开始或停服本方时更频繁复查 INR；方中有人参时写它可能减弱华法林作用（说明书）", () => {
  const state = careState({ 现病史: "乏力、食欲下降两周。", 用药史: "地高辛、呋塞米、华法林" }, { chiefComplaint: "乏力、食欲下降两周", patient: { age: 91, sex: "男" } });
  const item = required.requiredPrecautionsForCase(state, null).find((entry) => entry.kind === "warfarin_herbal");
  assert.ok(item, "华法林一条");
  const projected = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "四君子汤", herbs: [{ name: "人参", role: "君" }, { name: "白术", role: "臣" }] }], modifications: [] }, nonPharma: { precautions: [] } }, { requiredPrecautions: [item] });
  const line = projected.nonPharma.precautions.find((text) => /华法林/u.test(text));
  assert.ok(line && /INR/u.test(line) && /人参可能减弱/u.test(line), line);
  const noGinseng = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "二陈汤", herbs: [{ name: "陈皮", role: "君" }] }], modifications: [] }, nonPharma: { precautions: [] } }, { requiredPrecautions: [item] });
  assert.ok(!/减弱/u.test(noGinseng.nonPharma.precautions.join("")));
  // 模型已写「复查INR」（不点药名）且方中没有人参类：不再补规则句；方中有人参而模型没说它减弱作用：补。
  const modelInr = "开始或停服本方期间请按医嘱更频繁复查INR，留意出血迹象。";
  const covered = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "二陈汤", herbs: [{ name: "陈皮", role: "君" }] }], modifications: [] }, nonPharma: { precautions: [modelInr] } }, { requiredPrecautions: [item] });
  assert.deepEqual(covered.nonPharma.precautions, [modelInr]);
  const ginseng = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "四君子汤", herbs: [{ name: "人参", role: "君" }] }], modifications: [] }, nonPharma: { precautions: [modelInr] } }, { requiredPrecautions: [item] });
  assert.ok(ginseng.nonPharma.precautions.some((line) => /人参可能减弱/u.test(line)), JSON.stringify(ginseng.nonPharma.precautions));
});

await check("2.10 血钾偏高：注意事项写少吃含钾高的食物，饮食段推荐的香蕉、土豆去掉；「少喝汤水」又推荐炖汤、「少食甜黏」又推荐蜂蜜，去掉推荐的那一半", () => {
  const item = { kind: "high_risk_condition", conditions: ["hyperkalemia", "hyperkalemia_diet"], potassium: "5.7mmol/L" };
  assert.match(requiredShared.highRiskConditionLine(item), /含钾高的食物/u);
  assert.deepEqual(requiredShared.highRiskConditionsMissing(item, ["请尽快复查血钾。"]), ["hyperkalemia_diet"]);
  const projected = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "真武汤", herbs: [{ name: "茯苓", role: "臣" }] }], modifications: [] },
    nonPharma: { diet: "饮食宜清淡，可常吃香蕉、山药粥；忌生冷。", precautions: [] } }, { requiredPrecautions: [item] });
  assert.ok(!/香蕉/u.test(projected.nonPharma.diet), projected.nonPharma.diet);
  const soup = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "真武汤", herbs: [{ name: "茯苓", role: "臣" }] }], modifications: [] },
    nonPharma: { diet: "饮食宜温热清淡，可选少量肉桂炖汤；忌生冷，少喝汤水。", precautions: [] } }, {});
  assert.ok(!/炖汤/u.test(soup.nonPharma.diet) && /少喝汤水/u.test(soup.nonPharma.diet), soup.nonPharma.diet);
  const sweet = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "二陈汤", herbs: [{ name: "陈皮", role: "君" }] }], modifications: [] },
    nonPharma: { diet: "少食肥甘厚腻与甜黏之品，可用橘红少许泡水代茶，或蜂蜜温水调服，佐餐清淡。", precautions: [] } }, {});
  assert.ok(!/蜂蜜/u.test(sweet.nonPharma.diet) && /橘红/u.test(sweet.nonPharma.diet), sweet.nonPharma.diet);
});

await check("3.1 可疑妊娠（不能排除妊娠）时药典孕妇慎用药不作君臣，与在孕同一判据；妊娠状态未记录的育龄女性不在此列（只避禁用药）", () => {
  const possible = "患者年龄：30岁\n患者性别：女\n不能排除妊娠，晨起恶心。";
  assert.match(contract.m04GenerationSpecialPopulationIssue([{ name: "枳壳", role: "臣" }], possible) || "", /pregnancy/u);
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "枳壳", role: "佐" }], possible), undefined, "佐使照用");
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "枳壳", role: "臣" }], "患者年龄：30岁\n患者性别：女\n晨起恶心，妊娠可能性尚待核实。"), undefined, "妊娠状态未记录");
});

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
