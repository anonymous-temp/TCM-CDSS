// 10/19 第五轮（2026-10-19）：Claude 评审 21b9bef 验收主集 M（治则治法栏 282/360）后的三类服务端缺陷，一类一修。
//
// 每条断言都带对照（不该变的输入保持不变），并跑过反证：把改动撤掉后必须变红（记录见 ~/runlogs/r1018/work/r1019/counterproofs.txt，前缀 5/therapy）。
//
//   1 教材治法锚定把与病历冲突的对症项写进治法栏：内痔·湿热下注证「清热利湿止血」而病历「无便血」（TCM-SD-434125/468043、TCMChat-test-300），
//     乳岩·气血两亏证「宁心安神」而无心悸失眠（TCM-SD-438290），厥证·实证「开窍」而神清（TCM-SD-466542），风热疮「疏风清热止痒」而「无痛痒感」
//    （TCM-BEST4SDT-284），眩晕·气血亏虚证「调养心脾」而食纳可、夜寐安（TCMChat-test-343）。逐项核对，病历没有对应表现的项不锚定。
//   2 中医鉴别名归一把国标别名改成同时是 ICD-10 病名的正名：肥胖的教材鉴别「黄胖」成了「钩虫病」（TCM-SD-488343）；同类 69 个别名。
//   3 妊娠相关红旗的复诊提示没有孕期急症表现（TCM-BEST4SDT-61：孕八月痰喘，只写了呼吸症状）。
import assert from "node:assert/strict";
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
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const normalization = await jiti.import("../src/lib/tcm-disease-differential-normalization.ts");
const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");

const m03 = (disease, syndrome, method, { locations = [], secondary = [] } = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { tcmDiseaseName: disease, primarySyndrome: syndrome, secondarySyndromes: secondary, recommendedFormulaDirection: "" },
  therapy: { overallPrinciple: "", overallMethod: method },
  pathogenesis: { chain: [], locationDifferentiation: { items: locations } },
});
const method = (reasoning, record) => provenance.withDeterministicFormulaReferences(reasoning, record).therapy.overallMethod;

// ───── 1 教材治法的对症项 ─────
const HEMORRHOID_NO_BLEEDING = "刻下：肛内肿物脱出伴肿缘疼痛，坐卧不宁，行走不利。大便日行1次，质软，排出畅，无便血，无粘液便。舌红，苔黄，脉滑数。";
await check("1.1 内痔·湿热下注证：病历「无便血」时治法锚成「清热利湿」，不带「止血」；病历写便血时照用教材原文（对照）；不给病历时与此前相同（对照）", () => {
  assert.equal(method(m03("内痔", "湿热下注证", "清热利湿，消肿止痛"), HEMORRHOID_NO_BLEEDING), "清热利湿，消肿止痛");
  assert.doesNotMatch(method(m03("内痔", "湿热下注证", "清热利湿"), HEMORRHOID_NO_BLEEDING), /止血/);
  assert.equal(method(m03("内痔", "湿热下注证", "清热利湿"), "便后滴血，血色鲜红，肛内肿物脱出。"), "清热利湿止血");
  assert.equal(method(m03("内痔", "湿热下注证", "清热利湿")), "清热利湿止血");
});

await check("1.2 乳岩·气血两亏证：无心悸失眠时不锚「宁心安神」，模型写的「和络止痛」有疼痛记录照接；记录了夜寐不安时照锚（对照）", () => {
  const record = "左乳癌术后化疗后，自觉左侧胸壁手术伤口隐痛，偶有头顶针刺样疼痛，无头痛、头晕，无恶心、呕吐，食纳欠佳，大小便无异常。";
  assert.equal(method(m03("乳岩", "气血两亏证", "补益气血，和络止痛"), record), "补益气血，和络止痛");
  assert.equal(method(m03("乳岩", "气血两亏证", "补益气血，和络止痛"), `${record}近来夜寐不安。`), "补益气血，宁心安神，和络止痛");
});

await check("1.3 厥证·实证：发作无意识丧失、神志清楚时不锚「开窍」；突然昏倒、不省人事时照锚（对照）", () => {
  const record = "今晨突然出现双下肢无力，跌坐地上，持续约数秒钟，很快恢复，发作过程中无意识丧失，无肢体抽搐。入院时神志清楚，记忆力下降明显。";
  assert.equal(method(m03("厥证", "实证", "顺气解郁"), record), "顺气，解郁");
  assert.equal(method(m03("厥证", "实证", "顺气解郁"), "与人争吵后突然昏倒，不省人事，四肢厥冷，片刻自醒。"), "开窍，顺气，解郁");
});

await check("1.4 风热疮·风热蕴肤证：「无痛痒感」时「疏风清热止痒」只锚「疏风清热」；瘙痒明显时照锚（对照）", () => {
  const record = "全身散在红色丘疹1周，患处皮肤明显潮红，无痛痒感。口干口渴，大便干燥。";
  assert.equal(method(m03("风热疮", "风热蕴肤证", "疏风清热，凉血消斑"), record), "疏风清热");
  assert.equal(method(m03("风热疮", "风热蕴肤证", "疏风清热"), "全身散在红色斑片1周，瘙痒明显。"), "疏风清热止痒");
});

await check("1.5 眩晕·气血亏虚证「调养心脾」：食纳可、夜寐安，病位只写清窍时不锚；病历有心悸少寐、或病位写到脾时照锚（对照）", () => {
  const record = "头晕10天，行走不稳，精神欠佳，颈部及腰背部疼痛不适，食纳可，夜寐安，二便畅。";
  assert.equal(method(m03("眩晕", "气血亏虚证", "补益气血", { locations: ["清窍", "经脉"] }), record), "补益气血");
  assert.equal(method(m03("眩晕", "气血亏虚证", "补益气血", { locations: ["清窍"] }), "头晕10天，心悸少寐，神疲乏力。"), "补益气血，调养心脾");
  assert.equal(method(m03("眩晕", "气血亏虚证", "补益气血", { locations: ["脾", "清窍"] }), record), "补益气血，调养心脾");
});

await check("1.6 整行都是对症项（虚劳·心血虚证「养血宁心」）而病历没有心悸失眠时不锚定，保留模型写的治法；记录了心悸失眠时照锚（对照）", () => {
  const record = "乏力半年，面色不华，月经量少色淡，纳可，二便调。";
  assert.equal(method(m03("虚劳", "心血虚证", "养血补虚，益气健脾"), record), "养血补虚，益气健脾");
  assert.equal(method(m03("虚劳", "心血虚证", "养血补虚"), "乏力半年，心悸怔忡，失眠多梦。"), "养血宁心");
});

await check("1.7 接上的模型那一句同一口径：病历写明「无胸痛」时不接「通脉止痛」，有胸痛时照接（对照）；上一轮未核对时锚进去的「…止血」不会被当成模型的句子接回来", () => {
  assert.equal(method(m03("心悸", "瘀阻心脉证", "活血化瘀，通脉止痛"), "阵发性心慌、胸闷3天，无胸痛及放射痛，舌质紫暗有瘀斑。"), "活血化瘀，理气通络");
  assert.equal(method(m03("心悸", "瘀阻心脉证", "活血化瘀，通脉止痛"), "阵发性心慌3天，伴心前区刺痛。"), "活血化瘀，理气通络，通脉止痛");
  const unchecked = provenance.withDeterministicFormulaReferences(m03("内痔", "湿热下注证", "清热利湿"));
  assert.equal(unchecked.therapy.overallMethod, "清热利湿止血");
  const checked = provenance.withDeterministicFormulaReferences(unchecked, HEMORRHOID_NO_BLEEDING);
  assert.equal(checked.therapy.overallMethod, "清热利湿");
  assert.equal(checked.overview.overallTherapy, "清热利湿");
  assert.equal(provenance.withDeterministicFormulaReferences(checked, HEMORRHOID_NO_BLEEDING).therapy.overallMethod, "清热利湿");
});

await check("1.8 分句内的局部否认不算记录：「双下肢无浮肿」不支持消肿、「白睛无黄染」不支持退黄；「右下肢红肿」「目黄身黄」照算（对照）", () => {
  const filter = (text, recordText) => textbook.therapyWithoutUnsupportedSymptomItems(text, { recordText, diseaseName: "某病", syndromeName: "某证" });
  assert.equal(filter("清热解毒，解毒消肿", "发热3天，双下肢无浮肿。"), "清热解毒");
  assert.equal(filter("清热解毒，解毒消肿", "发热3天，右下肢红肿热痛。"), "清热解毒，解毒消肿");
  assert.equal(filter("清热化湿，利湿退黄", "乏力纳差，白睛无黄染。"), "清热化湿");
  assert.equal(filter("清热化湿，利湿退黄", "乏力纳差，目黄身黄，小便黄。"), "清热化湿，利湿退黄");
});

await check("1.9 一项里有一个对症字样有依据就整项保留（「消肿止痛」有痛无肿）；本病就以该表现为主症时照留（瘾疹「润燥止痒」、不寐「养血安神」）；眼科「宁神开窍」指目窍不动（对照：同一句不在眼科时去掉）", () => {
  const filter = (text, recordText, extra = {}) => textbook.therapyWithoutUnsupportedSymptomItems(text, { recordText, ...extra });
  assert.equal(filter("活血化瘀，消肿止痛", "外伤后右髋部疼痛伴活动受限2天。", { diseaseName: "某病" }), "活血化瘀，消肿止痛");
  assert.equal(filter("养血祛风，润燥止痒", "皮肤风团反复发作，夜间加剧，口干。", { diseaseName: "瘾疹", syndromeName: "血虚风燥证" }), "养血祛风，润燥止痒");
  assert.equal(filter("养血祛风，润燥止痒", "皮肤风团反复发作，夜间加剧，口干。", { diseaseName: "风热疮", syndromeName: "血虚风燥证" }), "养血祛风");
  assert.equal(filter("补益心脾，养血安神", "入睡困难2月。", { diseaseName: "不寐", syndromeName: "心脾两虚证" }), "补益心脾，养血安神");
  const blind = "双眼视物模糊2个月，眼底检查视盘色淡。";
  assert.equal(filter("益气养血，宁神开窍", blind, { diseaseName: "青盲", syndromeName: "气血两虚证", bookKey: "yanke" }), "益气养血，宁神开窍");
  assert.equal(filter("益气养血，宁神开窍", blind, { diseaseName: "青盲", syndromeName: "气血两虚证", bookKey: "neike" }), "益气养血");
});

await check("1.10 没有对症字样的治法、没有任何项被去掉时逐字返回原文；「…者…」条件项不动", () => {
  const filter = (text) => textbook.therapyWithoutUnsupportedSymptomItems(text, { recordText: "无出血，无心悸失眠。", diseaseName: "某病" });
  assert.equal(filter("清热利湿、祛风活血"), "清热利湿、祛风活血");
  assert.equal(filter("胎热内盛者清热凉血止血"), "胎热内盛者清热凉血止血");
  assert.equal(filter("急以开窍醒神，继以益气固脱"), "继以益气固脱");
});

await check("1.11 X 集回放暴露的三处：「无汗、头重而痛」里的疼痛照算（无汗是阳性体征，不把否认继承到后面）；「宣肺开闭」的开闭是肺闭不是神志；月经先期「摄血调经」（量多是月经本身）照留——对照：疼痛真被否认时去掉", () => {
  const filter = (text, recordText, extra = {}) => textbook.therapyWithoutUnsupportedSymptomItems(text, { recordText, ...extra });
  assert.equal(filter("辛温解表，祛湿止痛", "症见恶寒、发热、无汗、头重而痛、肢体酸痛。", { diseaseName: "感冒" }), "辛温解表，祛湿止痛");
  assert.equal(filter("辛温解表，祛湿止痛", "症见恶寒、发热、无汗，无头痛，无身痛。", { diseaseName: "感冒" }), "辛温解表");
  // 顿号列举里的后项按它自己判（「无头痛、身痛」的身痛算写到）：宁可保留治法项（与此前相同），不去掉病历其实写了的那一项。
  assert.equal(filter("辛温解表，祛湿止痛", "症见恶寒、发热，无头痛、身痛。", { diseaseName: "感冒" }), "辛温解表，祛湿止痛");
  assert.equal(filter("清热解毒，宣肺开闭", "高热咳嗽气促3天，神志清楚。", { diseaseName: "麻疹" }), "清热解毒，宣肺开闭");
  assert.equal(filter("补脾益气，摄血调经", "月经提前9天，量多，色淡、质稀。", { diseaseName: "月经先期", syndromeName: "脾气虚证" }), "补脾益气，摄血调经");
  assert.equal(filter("疏肝理气，缓急止利", "胁肋胀闷，泄利下重。", { diseaseName: "胁痛" }), "疏肝理气，缓急止利");
});

// ───── 2 中医鉴别名不改成西医病名 ─────
await check("2.1 肥胖的教材鉴别「黄胖」保留原名（此前归一成国标正名「钩虫病」）；鉴别栏投影里原因与区分要点同样不被改写", () => {
  assert.deepEqual(normalization.resolveTcmDiseaseDifferentialName("黄胖", "肥胖"), { action: "keep", name: "黄胖" });
  assert.deepEqual(normalization.resolveTcmDiseaseDifferentialName("黄肿", "肥胖"), { action: "keep", name: "黄肿" });
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", overview: { tcmDiseaseName: "肥胖", tcmDiseaseDifferentials: [{ diseaseName: "黄胖", reason: "黄胖亦见面部肥胖", distinguishingPoints: "本例面色红润，未诉面色萎黄" }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
  const out = normalization.normalizeM03TcmDiseaseDifferentialNames(content);
  assert.doesNotMatch(out, /钩虫病/);
  assert.match(out, /黄胖亦见面部肥胖/);
});

await check("2.2 同类（国标正名是 ICD-10 病名、又不是教材节名）：寸白虫病、疠风、痘疮、暑痉、鼻痔、肉刺保留原名；正名是教材节名或原写法本是西医名的照旧归一（对照：肠澼→痢疾、荨麻疹→瘾疹、带状疱疹→蛇串疮、流感→时行感冒）", () => {
  for (const [name, current] of [["寸白虫病", "腹痛"], ["疠风", "瘾疹"], ["痘疮", "水痘"], ["暑痉", "感冒"], ["鼻痔", "鼻渊"], ["肉刺", "胼胝"]]) {
    assert.deepEqual(normalization.resolveTcmDiseaseDifferentialName(name, current), { action: "keep", name }, name);
  }
  assert.equal(normalization.resolveTcmDiseaseDifferentialName("肠澼", "泄泻").name, "痢疾");
  assert.equal(normalization.resolveTcmDiseaseDifferentialName("荨麻疹", "风瘙痒").name, "瘾疹");
  assert.equal(normalization.resolveTcmDiseaseDifferentialName("带状疱疹", "热疮").name, "蛇串疮");
  assert.equal(normalization.resolveTcmDiseaseDifferentialName("流感", "感冒").name, "时行感冒");
  assert.deepEqual(normalization.resolveTcmDiseaseDifferentialName("钩虫病", "肥胖"), { action: "keep", name: "钩虫病" });
  // 国标正名本身是中医病名（不是 ICD-10 病名）的别名照旧归一：疫疠→疫病、风瘟→风温病。
  assert.equal(normalization.resolveTcmDiseaseDifferentialName("疫疠", "感冒").name, "疫病");
  assert.equal(normalization.resolveTcmDiseaseDifferentialName("风瘟", "感冒").name, "风温病");
});

// ───── 3 妊娠相关红旗的复诊提示 ─────
const OBSTETRIC_REASON = "现有表现提示妊娠相关急症可能，请立即完成产科急症评估";
const RESPIRATORY_REASON = "突发或快速加重呼吸困难/端坐呼吸，需优先评估呼吸循环急症";
const diagnoseContent = (followupSafetyNet) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { primarySyndrome: "痰热郁肺证", primarySyndromeResolution: "bounded" },
  management: { followupSafetyNet, mustCollect: [] },
})}\n<!-- DIAGNOSIS_JSON_END -->`;
const redFlagState = (presentHistory, redFlags) => ({
  ...types.normalizeCaseStateInput({ id: "r5", chiefComplaint: "x", patient: { sex: "女", age: 34 }, symptoms: { presentHistory }, conversation: [] }),
  completeness: { level: "B" },
  safetyGate: { status: "red_flag", redFlags, allowDiagnosis: true, allowDosePrescription: false, action: "refer_or_emergency", missingItems: [] },
});
const followupOf = (content) => JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1)).management.followupSafetyNet;
const MODEL_FOLLOWUP = "若出现呼吸困难加重、不能平卧、口唇发紫、胸痛或意识改变，请立即就医。";

await check("3.1 孕八月痰喘、红旗理由含产科急症：复诊提示补上腹痛、阴道流血、破水、胎动减少或异常（TCM-BEST4SDT-61），再投影一次不重复（幂等）", () => {
  const state = redFlagState("34岁孕妇妊娠逾八月，感染温病合并痰喘，昼夜无法平卧，呼吸带哮鸣且急促。", [RESPIRATORY_REASON, OBSTETRIC_REASON]);
  const once = visible.applyM03DecisionSpecificityPolicy(diagnoseContent(MODEL_FOLLOWUP), state);
  const text = followupOf(once);
  for (const sign of ["腹痛", "阴道流血", "破水", "胎动"]) assert.match(text, new RegExp(sign), sign);
  assert.match(text, /呼吸困难加重/);
  assert.equal(followupOf(visible.applyM03DecisionSpecificityPolicy(once, state)), text);
});

await check("3.2 对照：同一条产科理由出现在产后发热、非孕期阴道大出血时不补（没有胎动、破水可言）；孕妇但红旗与妊娠无关时也不补", () => {
  const postpartum = redFlagState("产后5天高热寒战，小腹疼痛拒按，恶露臭秽。", [OBSTETRIC_REASON]);
  assert.doesNotMatch(followupOf(visible.applyM03DecisionSpecificityPolicy(diagnoseContent(MODEL_FOLLOWUP), postpartum)), /胎动|破水/);
  const menorrhagia = redFlagState("月经紊乱半年，今日突然阴道大量出血，四肢湿冷。", [OBSTETRIC_REASON]);
  assert.doesNotMatch(followupOf(visible.applyM03DecisionSpecificityPolicy(diagnoseContent(MODEL_FOLLOWUP), menorrhagia)), /胎动|破水|产科急诊/);
  const pregnantRespiratory = redFlagState("孕妇妊娠30周，突发呼吸困难，不能平卧。", [RESPIRATORY_REASON]);
  assert.doesNotMatch(followupOf(visible.applyM03DecisionSpecificityPolicy(diagnoseContent(MODEL_FOLLOWUP), pregnantRespiratory)), /胎动|破水|产科急诊/);
});

await check("3.3 病历写明孕 20 周前只补腹痛与阴道流血（还没有可感知的胎动）；模型已写到的表现不重复", () => {
  const early = redFlagState("孕8周，腹痛伴阴道少量出血2小时，头晕。", [OBSTETRIC_REASON]);
  const text = followupOf(visible.applyM03DecisionSpecificityPolicy(diagnoseContent(MODEL_FOLLOWUP), early));
  assert.match(text, /腹痛、阴道流血，请立即到医院产科急诊就诊/);
  assert.doesNotMatch(text, /胎动|破水/);
  const written = "若出现高热持续不退、腹痛加重、阴道流血或流水、胎动异常，请立即就医。";
  const state = redFlagState("一位三十岁的怀孕六个月的妇女，高热不退且无汗。", [OBSTETRIC_REASON]);
  assert.doesNotMatch(followupOf(visible.applyM03DecisionSpecificityPolicy(diagnoseContent(written), state)), /产科急诊/);
  assert.equal(visible.withPregnancyWarningSigns("若出现腹痛加重，请立即就医。", "unspecified"),
    "若出现腹痛加重，请立即就医。\n\n怀孕期间如出现阴道流血、阴道流水（破水）、胎动减少或异常，请立即到医院产科急诊就诊。");
});

console.log(JSON.stringify({ suite: "r1019-round5-therapy", cases, failures: process.exitCode ? "see above" : 0 }));
