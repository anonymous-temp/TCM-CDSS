// 10/19 第五轮·注意事项（2026-10-19）：Claude 评审 21b9bef 的 M 集，J（注意事项）325/358，不合格 33 条里服务端可修的十类，一类一修。
//
// 每条断言都带对照，并跑过反证（把改动撤掉后必须变红；记录见 ~/runlogs/r1018/work/r1019/counterproofs.txt，前缀 5/precautions/）。
//
//   1 在用药的时间线：现病史按时间点分段，换掉的旧方案不列、最后一段接着用的算在用（TCM-SD-463912、480964、440006、478843、488395）
//   2 在用药列不全：动词后置「格列齐特1粒 bid口服降糖」、「接受」、「1片bid」、只写药类的激素与免疫抑制剂、逐个药核点名（0544、0530、453850、BEST4SDT-174）
//   3 抗凝/抗血小板（或支架、房颤、深静脉血栓）＋活血药：出血观察一条（MTCMB-7、42、62）
//   4 饮酒：「未戒酒」不是戒了，「每天6瓶啤酒」是饮酒；饮食一条写到了不等于写到戒酒（MTCMB-21）
//   5 哺乳期药按知识库档位逐味写，禁用、慎用分开（BEST4SDT-65）
//   6 残句：一小句几味药各说各的煎法（「桃仁打碎、五灵脂包煎」）、删了主语留下的「须经炮制…」、「煎药时请按此处理」（482280、MTCMB-59）
//   7 注意事项叫避开的成份或一类药，正是推荐的中成药：不推荐那味药（0299 一类、0431）
//   8 糖尿病：控糖与监测血糖一条，饮食段不推荐红枣、蜂蜜（453850、0141、BEST4SDT-250）
//   9 写给患者的医护流程话：「备血」「须经医生与药师复核后使用」「请医生确认」（433219、MTCMB-41、466542）
//  10 同一页说两遍「把在用的药告诉医生」（MTCMB-6 等）
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

const types = await jiti.import("../src/lib/diagnosis-types.ts");
const polarity = await jiti.import("../src/lib/clinical-polarity.ts");
const precautions = await jiti.import("../src/lib/required-precautions.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");

const stateOf = (presentHistory, extra = {}) => types.normalizeCaseStateInput({
  id: "r5p", chiefComplaint: "x", patient: { sex: "男", age: 58 }, symptoms: { presentHistory }, conversation: [], ...extra,
});
const itemsOf = (record, extra = {}, prior = null) => precautions.requiredPrecautionsForCase(stateOf(record, extra), prior);
const currentOf = (record, extra) => itemsOf(record, extra).find((item) => item.kind === "current_medications");
const rx = (lines, herbs = [{ name: "陈皮", role: "君", function: "理气健脾", dose: "10g" }], extra = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
  formula: { candidates: [{ name: "x", formulaAnalysis: "x", herbs, decoction: { method: "水煎服，分2次饭后温服" } }], patentAndWestern: extra.patentAndWestern || [] },
  nonPharma: { precautions: lines, diet: extra.diet || "", acupointCare: null, tcmTreatments: [] },
});
const project = (reasoning, options) => surface.projectDeliveredReasoning(reasoning, options);

// ───── 1 在用药的时间线 ─────
const TIMELINE_463912 = "患者2018年8月出现双下肢水肿，予甲泼尼龙40mg口服qd+缬沙坦40mg口服qd+贝前列素钠40ugtid。2018年11月患者至我科就诊，予他克莫司1mg口服bid，出院后患者甲强龙20mg口服（逐渐减量至2019.2.18停用），他克莫司1mg口服bid，洛丁新1片qd。2020-4-1患者复查尿蛋白定量3.6g，予他克莫司加量为早2片晚1片，奥美沙坦1片bid，3天前患者头晕恶心。";
await check("1.1 住院病历按年份写了几轮用药：后一段重申方案（接着用他克莫司）时，之前出现、此后再没提到的药算换掉了（缬沙坦、贝前列素钠、洛丁新）；最后一段接着用的算正在用（他克莫司、奥美沙坦，即便写的是「予」）", () => {
  const status = polarity.medicationTimelineStatuses(TIMELINE_463912, ["缬沙坦", "贝前列素钠", "洛丁新", "他克莫司", "奥美沙坦"]);
  assert.equal(status.get("缬沙坦"), "superseded");
  assert.equal(status.get("贝前列素钠"), "superseded");
  assert.equal(status.get("洛丁新"), "superseded");
  assert.equal(status.get("他克莫司"), "current");
  assert.equal(status.get("奥美沙坦"), "current");
  const item = currentOf(TIMELINE_463912);
  assert.deepEqual(item?.names, ["他克莫司", "奥美沙坦"]);
  assert.ok(!item.given, JSON.stringify(item));
  // 对照：没有时间点的长期用药（两种慢病各一种药）都不算换掉。
  const chronic = polarity.medicationTimelineStatuses("高血压病史10年，长期口服氨氯地平；2型糖尿病5年，口服二甲双胍。", ["氨氯地平", "二甲双胍"]);
  assert.ok(![...chronic.values()].includes("superseded"), JSON.stringify([...chronic]));
});

await check("1.2 写明「调整治疗方案/改服/仅口服」算换方案（阿尔茨海默病安理申→卡巴拉汀；类风湿「仅口服甲氨蝶呤+硫酸羟氯喹」后再次予益赛普）；同一小句先写停哪个药的按停药算，不把别的药一起换掉（对照：利伐沙班照列）", () => {
  const ad = polarity.medicationTimelineStatuses("2010年于北京就诊，给予口服安理申治疗。2012年底调整治疗方案，改服重酒石酸卡巴拉汀胶囊，并加用盐酸美金刚片。", ["安理申", "重酒石酸卡巴拉汀胶囊", "盐酸美金刚片"]);
  assert.equal(ad.get("安理申"), "superseded");
  assert.notEqual(ad.get("盐酸美金刚片"), "superseded");
  const ra = "2017年9月予艾拉莫德+雷公藤多苷+益赛普治疗，2018年11月改为甲氨蝶呤+艾拉莫德+益赛普治疗，出院后患者未规律服药，仅口服甲氨蝶呤+硫酸羟氯喹抗类风湿治疗，今年6月再次予益赛普抗类风湿治疗。";
  const status = polarity.medicationTimelineStatuses(ra, ["艾拉莫德", "雷公藤多苷", "益赛普", "甲氨蝶呤", "硫酸羟氯喹"]);
  assert.equal(status.get("雷公藤多苷"), "superseded");
  assert.equal(status.get("艾拉莫德"), "superseded");
  for (const name of ["益赛普", "甲氨蝶呤", "硫酸羟氯喹"]) assert.notEqual(status.get(name), "superseded", name);
  const rituximab = polarity.medicationTimelineStatuses("2018年7月服用复方a-酮酸片、利伐沙班；2018-8-22予强的松30mg+环磷酰胺治疗，2月前停用环磷酰胺，改用利妥昔单抗100mg。", ["利伐沙班", "复方a-酮酸片", "利妥昔单抗"]);
  assert.notEqual(rituximab.get("利伐沙班"), "superseded");
});

await check("1.3 同一种写法的时间点相隔一年以上、此后再没提到的药算换掉（32年前的乙双吗啉）；那几小句写着「间断/长期」的请患者说明是否还在用（阿维A）；公历年份与「N月前」混写时不按间隔判（对照）", () => {
  const text = "患者32年前双小腿出现红斑丘疹，予乙双吗啉口服数月后皮损相对稳定，曾多次就诊，间断口服阿维A胶囊。2月前全身新起较多红斑丘疹，复方甘草酸苷片口服后症状稍减轻。";
  const status = polarity.medicationTimelineStatuses(text, ["乙双吗啉", "阿维A胶囊", "复方甘草酸苷片"]);
  assert.equal(status.get("乙双吗啉"), "superseded");
  assert.equal(status.get("阿维A胶囊"), "ask");
  assert.notEqual(status.get("复方甘草酸苷片"), "superseded");
  const mixed = polarity.medicationTimelineStatuses("2018年7月服用利伐沙班。2月前予利妥昔单抗。", ["利伐沙班", "利妥昔单抗"]);
  assert.notEqual(mixed.get("利伐沙班"), "superseded");
});

await check("1.4 「…无明显效果，未再重视」：藏药不算正在外用；写着外用、好转的照列（对照）", () => {
  assert.equal(polarity.medicationStopped("2020年4月右手关节肿痛，自行外用“藏药五毒”无明显效果，未再重视。", "藏药五毒"), true);
  assert.equal(polarity.medicationStopped("近1周外用“藏药五毒”，症状好转。", "藏药五毒"), false);
});

await check("1.5 这次发病里「外院曾予蒙脱石散、易蒙停等药物治疗，症状未能缓解，遂来就诊」：请患者说明是否还在用；「既往曾接受醋酸泼尼松…治疗」照旧不列（对照）", () => {
  const recent = currentOf("2019年7月18日完成末次化疗。化疗结束后出现腹泻，外院曾予蒙脱石散、易蒙停等药物治疗，症状未能缓解，遂来就诊。");
  assert.deepEqual(recent?.names, ["蒙脱石散", "易蒙停"]);
  assert.deepEqual(recent?.given, ["蒙脱石散", "易蒙停"]);
  assert.equal(polarity.medicationOnlyPastMentions("经输液治疗后症状缓解。既往曾接受醋酸泼尼松（8 片/次，隔日一次，口服）治疗。", "醋酸泼尼松"), "past");
  assert.equal(currentOf("经输液治疗后症状缓解。既往曾接受醋酸泼尼松（8 片/次，隔日一次，口服）治疗。"), undefined);
});

await check("1.6 同一句写了停药时只跳到停药那一小句为止，之后的照取（「后患者自停益赛普…遂予艾拉莫德+雷公藤多苷+益赛普」）；停药在句末的整句照旧不取（对照）", () => {
  const names = (text) => polarity.recordedMedicationMentions(text).names;
  assert.ok(names("曾予益赛普治疗，效果可，后患者自停益赛普，今年7月份至我科住院，遂予艾拉莫德+雷公藤多苷+益赛普治疗").includes("艾拉莫德"));
  assert.deepEqual(names("确诊后口服吉非替尼，其后因不能耐受自行停用该药"), []);
});

await check("1.7 只在住院静滴里出现的药（「分别予地塞米松，青霉素静滴3天治疗后症状明显改善」）请患者说明是否还在用；写停药的那一小句（「予以停用阿帕替尼」）不算重申方案，卡瑞丽珠单抗不算换掉；「调整治疗方案为雷公藤多甙片+来氟米特」换掉之前的艾拉莫德+甲氨蝶呤（对照：口服的照列为在用）", () => {
  const iv = polarity.medicationTimelineStatuses("2019年12月2日予甲泼尼龙8mgtid口服。2020年1月3日复诊，分别予地塞米松，青霉素静滴3天治疗后症状明显改善。", ["甲泼尼龙", "地塞米松", "青霉素"]);
  assert.equal(iv.get("地塞米松"), "ask");
  assert.equal(iv.get("青霉素"), "ask");
  const oral = polarity.medicationTimelineStatuses("2020年1月3日复诊，予地塞米松片口服，症状明显改善。", ["地塞米松片"]);
  assert.equal(oral.get("地塞米松片"), "latest");
  const cancer = polarity.medicationTimelineStatuses("2020-06-03予卡瑞丽珠单抗静脉应用+阿帕替尼0.25g qd po。2020-07-04患者再次口服靶向药物出现血压升高，予以停用阿帕替尼。近1月来自服盐酸羟考酮10mg qd。", ["卡瑞丽珠单抗", "阿帕替尼", "盐酸羟考酮"]);
  assert.notEqual(cancer.get("卡瑞丽珠单抗"), "superseded");
  const ra = "10月前予以云克、雷公藤多苷片、艾拉莫德治疗，8月前予改用艾拉莫德+甲氨蝶呤治疗，仍无好转，其后再次调整治疗方案为雷公藤多甙片+来氟米特。2月前再次加用雷公藤多甙片。";
  assert.ok(polarity.recordedMedicationMentions(ra).names.includes("来氟米特"));
  const status = polarity.medicationTimelineStatuses(ra, ["艾拉莫德", "甲氨蝶呤", "来氟米特"]);
  assert.equal(status.get("甲氨蝶呤"), "superseded");
  assert.notEqual(status.get("来氟米特"), "superseded");
});

// ───── 2 在用药列不全 ─────
await check("2.1 动词在药名后面（「格列齐特1粒 bid口服降糖」「复方甘草酸苷片口服后症状稍减轻」）取前面的药名，前面紧挨着的「以二甲双胍1粒 bid」一并取；「患者口服后」不算（对照）", () => {
  const names = (text) => polarity.recordedMedicationMentions(text).names;
  assert.deepEqual(names("外院诊为2型糖尿病，近3月来以二甲双胍1粒 bid，格列齐特1粒 bid口服降糖，监测血糖控制不佳。"), ["二甲双胍", "格列齐特"]);
  assert.deepEqual(names("2月前全身新起红斑，复方甘草酸苷片口服后症状稍减轻。"), ["复方甘草酸苷片"]);
  assert.deepEqual(names("患者口服后症状缓解。"), []);
  // 「予对乙酰氨基酚片口服好转」：「好转」不是药名（M 集 TCMChat-test-478）。
  assert.deepEqual(currentOf("昨日下午发热，体温38.0℃，予对乙酰氨基酚片口服好转。")?.names, ["对乙酰氨基酚片"]);
});

await check("2.2 「接受」也是给药（「既往接受氨氯地平、缬沙坦、阿托伐他汀钙片及利尿药对症治疗」，按用过的请患者说明是否还在用）；「为接受进一步治疗」「接受PCI治疗」不是药（对照）", () => {
  const item = currentOf("既往接受氨氯地平、缬沙坦、阿托伐他汀钙片及利尿药对症治疗，水肿虽有所减轻，但仍感气短乏力。");
  assert.deepEqual(item?.names, ["氨氯地平", "缬沙坦", "阿托伐他汀钙片"]);
  assert.deepEqual(item?.given, ["氨氯地平", "缬沙坦", "阿托伐他汀钙片"]);
  assert.deepEqual(polarity.recordedMedicationMentions("为接受进一步治疗，在外院门诊就诊。").names, []);
  assert.deepEqual(polarity.recordedMedicationMentions("1年前接受PCI治疗。").names, []);
});

await check("2.3 「奥美沙坦1片bid」接在用药列举后面也取到（汉字单位后紧跟用法缩写）；「每日2片」不是药名（对照）", () => {
  const names = polarity.recordedMedicationMentions("予他克莫司加量为早2片晚1片，奥美沙坦1片bid，3天前头晕。").names;
  assert.ok(names.includes("奥美沙坦"), JSON.stringify(names));
  assert.ok(!polarity.recordedMedicationMentions("予他克莫司1mg，每日2片。").names.some((name) => /每日/u.test(name)));
});

await check("2.4 只写药类的激素、免疫抑制剂（「经予免疫抑制剂及激素治疗后」）按药类列，补的那句写「不要自行停用或减量」；「因拒绝激素治疗」「查性激素六项」不算（对照）", () => {
  assert.deepEqual(polarity.recordedSystemicTherapyClasses("当地医院经予免疫抑制剂及激素治疗后，肉眼血尿改善不明显。"), ["免疫抑制剂", "激素"]);
  assert.deepEqual(polarity.recordedSystemicTherapyClasses("因拒绝激素治疗，遂来门诊。"), []);
  assert.deepEqual(polarity.recordedSystemicTherapyClasses("予查性激素六项未见异常。"), []);
  const item = currentOf("当地医院经予免疫抑制剂及激素治疗后，肉眼血尿改善不明显。");
  assert.deepEqual(item?.noSelfStop, ["免疫抑制剂", "激素"]);
  const line = project(rx(["饮食清淡。"]), { requiredPrecautions: [item] }).nonPharma.precautions[0];
  assert.match(line, /病历记录用过的免疫抑制剂、激素，请告知医生现在是否还在用/);
  assert.match(line, /不要自行停用或减量/);
  // 已点到药名、只缺「不要自行停用」时只补那一句。
  const short = project(rx(["正在服用的他克莫司请告知医生。"]), { requiredPrecautions: [{ kind: "current_medications", names: ["他克莫司"], noSelfStop: ["他克莫司"] }] }).nonPharma.precautions;
  assert.deepEqual(short, ["他克莫司不要自行停用或减量，是否调整由医生决定。", "正在服用的他克莫司请告知医生。"]);
  const plain = project(rx(["正在服用的氨氯地平请告知医生。"]), { requiredPrecautions: [{ kind: "current_medications", names: ["氨氯地平"] }] }).nonPharma.precautions;
  assert.deepEqual(plain, ["正在服用的氨氯地平请告知医生。"]);
});

await check("2.5 自行停药没写药名时取前面三小句里写到的药（「予来氟米特、艾拉莫德、白芍总苷胶囊治疗，症状好转，出院后患者未规律服药，后自行停药」）；停了又用上的不算（对照）", () => {
  const stopped = polarity.selfDiscontinuedMedication("诊断类风湿关节炎，予来氟米特、艾拉莫德、白芍总苷胶囊治疗，症状好转，出院后患者未规律服药，后自行停药，10天前关节肿痛加重。");
  assert.deepEqual(stopped, { condition: undefined, names: ["来氟米特", "艾拉莫德", "白芍总苷胶囊"] });
  assert.equal(polarity.selfDiscontinuedMedication("益赛普治疗效果可，后患者自停益赛普，今年7月份至我科住院，遂予艾拉莫德+益赛普治疗，病情明显改善。"), undefined);
  assert.deepEqual(polarity.selfDiscontinuedMedication("高血压病史8年，1个月前自行停药"), { condition: "高血压", names: [] });
});

await check("2.6 在用药逐个核点名：模型只在出血那句里提到阿司匹林，补一句点其余的药（不再把阿司匹林重说）；「如正在服用其他药物请告知医生」不算点名；都点到了不补（对照）", () => {
  const item = { kind: "current_medications", names: ["阿司匹林", "二甲双胍", "可定"] };
  const lines = project(rx(["服阿司匹林期间注意有无牙龈出血。", "如正在服用其他药物，请告知医生。"]), { requiredPrecautions: [item] }).nonPharma.precautions;
  assert.match(lines[0], /^正在服用的二甲双胍、可定请告知医生/);
  assert.doesNotMatch(lines[0], /阿司匹林/);
  const covered = project(rx(["正在服用的阿司匹林、二甲双胍、可定请告知医生，与中药间隔1小时服用。"]), { requiredPrecautions: [item] }).nonPharma.precautions;
  assert.equal(covered.length, 1);
});

await check("2.7 「即使服用上述安眠药物也仍无法入睡」算再提到一次前面轮替服用的那串安眠药：列为正在用（BEST4SDT-174）；没有「上述」时只是「曾…轮替服用」，请患者说明是否还在用；「既往曾服用」的不列（对照）", () => {
  const head = "入睡困难3年，曾多次就诊外院诊断为睡眠障碍，3年期间轮替服用“艾司唑仑、氯硝西泮”等助眠药物但疗效欠佳。";
  const recalled = currentOf(`${head}近1个月以来入睡困难加剧，即使服用上述安眠药物也仍无法入睡。`);
  assert.deepEqual(recalled?.names, ["艾司唑仑", "氯硝西泮"]);
  assert.ok(!recalled.given, JSON.stringify(recalled));
  assert.deepEqual(currentOf(head)?.given, ["艾司唑仑", "氯硝西泮"]);
  assert.equal(currentOf("入睡困难3年，既往曾服用艾司唑仑、氯硝西泮，疗效欠佳。"), undefined);
});

// ───── 3 抗凝、抗血小板与活血药 ─────
await check("3.1 正在用阿司匹林等（与安全门同一份药名）或病历写着支架术后、房颤、深静脉血栓：出一项出血观察；否认房颤、只有家族史的不出（对照）", () => {
  const drug = itemsOf("冠心病多年，平素服用阿司匹林肠溶片0.1 qd。").find((item) => item.kind === "antithrombotic_bleeding");
  assert.deepEqual(drug, { kind: "antithrombotic_bleeding", drugs: ["阿司匹林肠溶片"] });
  const stent = itemsOf("3月前行冠状动脉造影，遂于OM植入1枚支架，昨日胸闷加重。").find((item) => item.kind === "antithrombotic_bleeding");
  assert.deepEqual(stent, { kind: "antithrombotic_bleeding", drugs: [], indication: "冠脉支架植入" });
  assert.ok(!itemsOf("胸闷1周，否认房颤病史。").some((item) => item.kind === "antithrombotic_bleeding"));
  assert.ok(!itemsOf("胸闷1周。", { symptoms: { presentHistory: "胸闷1周。", 家族史: "父亲有房颤病史。" } }).some((item) => item.kind === "antithrombotic_bleeding"));
});

await check("3.2 方中有知识库标注抗凝状态慎用的活血药（桃仁、丹参…）时补出血观察一句，点名药与在用的抗栓药；方中没有这类药不补；模型写了「如出现牙龈出血…请及时告知医生」不补（对照）", () => {
  const item = { kind: "antithrombotic_bleeding", drugs: ["阿司匹林"] };
  const herbs = [{ name: "桃仁", role: "君", function: "活血祛瘀", dose: "10g" }, { name: "丹参", role: "臣", function: "活血", dose: "10g" }];
  const lines = project(rx(["饮食清淡。"], herbs), { requiredPrecautions: [item] }).nonPharma.precautions;
  assert.match(lines[0], /^方中桃仁、丹参有活血作用，与正在使用的阿司匹林同用可能增加出血风险/);
  assert.deepEqual(project(rx(["饮食清淡。"]), { requiredPrecautions: [item] }).nonPharma.precautions, ["饮食清淡。"]);
  assert.deepEqual(project(rx(["服药期间如出现牙龈出血、皮下瘀斑，请及时告知医生。"], herbs), { requiredPrecautions: [item] }).nonPharma.precautions.length, 1);
  const indication = project(rx(["饮食清淡。"], herbs), { requiredPrecautions: [{ kind: "antithrombotic_bleeding", drugs: [], indication: "冠脉支架植入" }] }).nonPharma.precautions[0];
  assert.match(indication, /^您有冠脉支架植入病史，如正在服用抗凝或抗血小板药/);
});

// ───── 4 饮酒 ─────
await check("4.1 「饮酒30年…平均5两／日，未戒酒」「以饮用啤酒为主，平均6瓶／日」是在饮酒；「已戒酒2年余」「无烟酒嗜好」「建议戒酒」不改判（对照）", () => {
  assert.equal(polarity.recordsAlcoholUse("饮酒30年，以饮用白酒为主，平均5两／日，未戒酒，已经减量"), true);
  assert.equal(polarity.recordsAlcoholUse("嗜酒史饮酒20余年，以饮用啤酒为主，平均6瓶／日，未戒酒"), true);
  assert.equal(polarity.recordsAlcoholUse("每天6瓶啤酒"), true);
  assert.equal(polarity.recordsAlcoholUse("嗜酒史间断饮酒10余年，已戒酒2年余"), false);
  assert.equal(polarity.recordsAlcoholUse("无烟酒嗜好"), false);
  assert.equal(polarity.recordsAlcoholUse("饮酒20年，医生建议戒酒，仍每日饮白酒2两"), true);
});

await check("4.2 饮酒的病人只写了「忌辛辣」不算写到戒酒，补「服药期间请戒酒」；已写「忌烟酒」不补（对照）", () => {
  const item = { kind: "administration_and_diet", diet: "忌食辛辣温燥，戒酒", administration: true, alcohol: true };
  const lines = project(rx(["本方饭后温服，忌食辛辣温燥。"]), { requiredPrecautions: [item] }).nonPharma.precautions;
  assert.equal(lines[0], "服药期间请戒酒。");
  assert.deepEqual(project(rx(["本方饭后温服，忌辛辣及烟酒。"]), { requiredPrecautions: [item] }).nonPharma.precautions, ["本方饭后温服，忌辛辣及烟酒。"]);
  assert.equal(itemsOf("饮酒30年，平均5两／日，未戒酒。", {}, { overview: { primarySyndrome: "肝阳上亢证" } }).find((entry) => entry.kind === "administration_and_diet")?.alcohol, true);
});

// ───── 5 哺乳期药按知识库档位 ─────
await check("5.1 产后哺乳情况未记录：模型写「三棱、莪术、丁香、小茴香哺乳期须慎用」（三棱、莪术知识库为禁用、漏了川楝子）换成规则那句，禁用、慎用分开；档位都对的照留（对照）", () => {
  const herbs = ["三棱", "莪术", "川楝子", "丁香", "小茴香"].map((name) => ({ name, role: "臣", function: "x", dose: "6g" }));
  const wrong = project(rx(["患者一年内分娩，如正在哺乳请先告知医生；方中三棱、莪术、丁香、小茴香哺乳期须慎用。", "饭后温服。"], herbs), { requiredPrecautions: [{ kind: "postpartum_lactation" }] }).nonPharma.precautions;
  assert.equal(wrong[0], "产后如正在哺乳，请服药前告知医生（方中三棱、莪术、川楝子哺乳期禁用，丁香、小茴香哺乳期须慎用），由医生评估后再服。");
  assert.ok(!wrong.some((line) => /三棱、莪术、丁香、小茴香哺乳期须慎用/u.test(line)));
  const right = "如正在哺乳请先告知医生：方中三棱、莪术、川楝子哺乳期禁用，丁香、小茴香哺乳期慎用。";
  // 川楝子有小毒，另有有毒药一句补在最后；哺乳那句原样。
  assert.deepEqual(project(rx([right, "饭后温服。"], herbs), { requiredPrecautions: [{ kind: "postpartum_lactation" }] }).nonPharma.precautions.slice(0, 2), [right, "饭后温服。"]);
});

// ───── 6 残句 ─────
await check("6.1 一小句里几味药各说各的煎法（「方中桃仁打碎、五灵脂包煎，煎药时请按此处理。」）：桃仁不再被算成说了包煎，整句照留；真说错了的（桃仁包煎）连同「煎药时请按此处理」一起去掉（对照）", () => {
  const herbs = [{ name: "桃仁", role: "君", function: "活血", dose: "9g", decoctionRequirement: "打碎" }, { name: "五灵脂", role: "佐", function: "散瘀", dose: "8g", decoctionRequirement: "包煎" }];
  const ok = "方中桃仁打碎、五灵脂包煎，煎药时请按此处理。";
  assert.deepEqual(project(rx([ok, "饮食清淡。"], herbs)).nonPharma.precautions, [ok, "饮食清淡。"]);
  assert.deepEqual(project(rx(["方中桃仁包煎，煎药时请按此处理。", "饮食清淡。"], herbs)).nonPharma.precautions, ["饮食清淡。"]);
  // 同一条里还有别的话时，指回被删小句的「煎药时请按此处理」随它去掉，别的照留（单防线：整条残句的过滤管不到这里）。
  assert.deepEqual(project(rx(["方中桃仁包煎，煎药时请按此处理；服药期间忌生冷。"], herbs)).nonPharma.precautions, ["服药期间忌生冷。"]);
  // 顿号并列共用后面的煎法（「龙齿、牡蛎先煎」两味都先煎）。
  const shared = [{ name: "龙齿", role: "佐", function: "安神", dose: "15g", decoctionRequirement: "先煎" }, { name: "牡蛎", role: "佐", function: "安神", dose: "15g", decoctionRequirement: "先煎" }];
  assert.deepEqual(project(rx(["方中龙齿、牡蛎先煎30分钟。"], shared)).nonPharma.precautions, ["方中龙齿、牡蛎先煎30分钟。"]);
  assert.deepEqual(project(rx(["方中龙齿、牡蛎后下。", "饮食清淡。"], shared)).nonPharma.precautions, ["饮食清淡。"]);
});

await check("6.2 方中已没有的有毒药那一小句删掉时，后面没有主语、接着讲它的「须经炮制并按医嘱服用，不可自行加量或久服」一并删掉；句号后的另一句、讲方中有的药的照留（对照）", () => {
  const present = new Set(["瓜蒌", "枳实"]);
  assert.equal(compiler.precautionWithoutAbsentHerbs("方中制川乌有毒，须经炮制并按医嘱服用，不可自行加量或久服。", present), "");
  assert.equal(compiler.precautionWithoutAbsentHerbs("方中制川乌有毒，须经炮制并按医嘱服用。如出现口唇发麻请就医。", present), "如出现口唇发麻请就医。");
  assert.equal(compiler.precautionWithoutAbsentHerbs("方中瓜蒌润肠，须注意大便次数。", present), "方中瓜蒌润肠，须注意大便次数。");
  // 已经是残句的（前一步删掉了主语）交付面不留；「须按医嘱服用」这类没说炮制煎法的照留（对照）。
  assert.deepEqual(project(rx(["须经炮制并按医嘱服用，不可自行加量或久服。", "煎药时请按此处理。", "须按医嘱服用，不可自行加量。"])).nonPharma.precautions, ["须按医嘱服用，不可自行加量。"]);
});

// ───── 7 注意事项与推荐药相抵 ─────
await check("7.1 注意事项「不宜再服含人参的滋补类中成药」，推荐的参苓白术散说明书成份含人参：不推荐它，注意事项照留；不含人参的照推荐（对照）", () => {
  const herbs = [{ name: "人参", role: "君", function: "补气", dose: "6g" }, { name: "白术", role: "臣", function: "健脾", dose: "10g" }];
  const line = "方中有人参，服本方期间不宜再服含人参的滋补类中成药。";
  const out = project(rx([line], herbs, { patentAndWestern: [{ type: "中成药", name: "参苓白术散" }, { type: "西药", name: "蒙脱石散" }] }));
  assert.deepEqual(out.formula.patentAndWestern.map((item) => item.name), ["蒙脱石散"]);
  assert.deepEqual(out.nonPharma.precautions, [line]);
  const kept = project(rx([line], herbs, { patentAndWestern: [{ type: "中成药", name: "灵芪加口服液" }] }));
  assert.deepEqual(kept.formula.patentAndWestern.map((item) => item.name), ["灵芪加口服液"]);
  assert.deepEqual(kept.nonPharma.precautions, [line]);
});

await check("7.2 「避免与通便类中成药重复使用」而推荐新复方芦荟胶囊（说明书：润肠通便；芦荟与方中大黄同为攻下药）：不推荐它，注意事项照留；方中没有同类药时仍按原口径去掉注意事项（对照，S058）", () => {
  const line = "如正在服用其他药物，请先告知医生，避免与通便类中成药重复使用。";
  const rec = [{ type: "中成药", name: "新复方芦荟胶囊", correspondingProblem: "失眠" }];
  const withRhubarb = project(rx([line], [{ name: "大黄", role: "臣", function: "泻热通便", dose: "6g" }, { name: "茵陈", role: "君", function: "利湿退黄", dose: "15g" }], { patentAndWestern: rec }));
  assert.deepEqual(withRhubarb.formula.patentAndWestern, []);
  assert.deepEqual(withRhubarb.nonPharma.precautions, [line]);
  const noStack = project(rx([line], [], { patentAndWestern: rec }));
  assert.deepEqual(noStack.formula.patentAndWestern.map((item) => item.name), ["新复方芦荟胶囊"]);
  assert.deepEqual(noStack.nonPharma.precautions, []);
  // 点了一个具体成药再说「等同类」的，说的是患者自己在用的那种：照留。
  const own = "服本方期间不要再服人参天麻药酒等同类祛风活血中成药。";
  assert.deepEqual(project(rx([own], [], { patentAndWestern: [{ type: "中成药", name: "关节风痛丸", indication: "祛风活血" }] })).nonPharma.precautions, [own]);
});

// ───── 8 糖尿病 ─────
await check("8.1 病历写着患者本人有糖尿病出控糖一项（确诊）；只有中医病名消渴或「糖尿病待查」时写尽早查血糖（未确诊）；家族史、否认的不出（对照）", () => {
  assert.deepEqual(itemsOf("2型糖尿病5年，口服二甲双胍，血糖控制欠佳。").find((item) => item.kind === "diabetes_glucose"), { kind: "diabetes_glucose", confirmed: true });
  assert.deepEqual(itemsOf("近3个月口渴多饮。", {}, { overview: { tcmDiseaseName: "消渴" }, westernDiagnosis: { primary: { name: "糖尿病待查" } } }).find((item) => item.kind === "diabetes_glucose"), { kind: "diabetes_glucose", confirmed: false });
  assert.ok(!itemsOf("头晕1周，否认糖尿病病史。").some((item) => item.kind === "diabetes_glucose"));
  assert.ok(!itemsOf("头晕1周。", { symptoms: { presentHistory: "头晕1周。", 家族史: "父亲患有糖尿病。" } }).some((item) => item.kind === "diabetes_glucose"));
});

await check("8.2 糖尿病：补控糖一句；饮食段里推荐的红枣、蜂蜜只去掉那一项或那一小句（连同后面「佐餐食用，每周一至二次」）；叫少吃甜食的照留；不是糖尿病的饮食不动（对照）", () => {
  const item = { kind: "diabetes_glucose", confirmed: true };
  const out = project(rx(["饭后温服。"], undefined, { diet: "饮食宜清淡易消化，少食辛辣油腻；可常吃山药炖鸡肉、红枣胡萝卜牛肉汤，少食甜腻糕点。" }), { requiredPrecautions: [item] });
  assert.equal(out.nonPharma.diet, "饮食宜清淡易消化，少食辛辣油腻；可常吃山药炖鸡肉，少食甜腻糕点。");
  assert.match(out.nonPharma.precautions[0], /^您有糖尿病，服药期间请按医嘱继续控制血糖、定期监测血糖/);
  const whole = project(rx(["饭后温服。"], undefined, { diet: "少食辛辣油腻；可用党参、红枣与鸡肉同炖，佐餐食用，每周一至二次。" }), { requiredPrecautions: [item] });
  assert.equal(whole.nonPharma.diet, "少食辛辣油腻。");
  const notDiabetic = project(rx(["饭后温服。"], undefined, { diet: "可用党参、红枣与鸡肉同炖。" }));
  assert.equal(notDiabetic.nonPharma.diet, "可用党参、红枣与鸡肉同炖。");
  const unconfirmed = project(rx(["饭后温服。"]), { requiredPrecautions: [{ kind: "diabetes_glucose", confirmed: false }] }).nonPharma.precautions[0];
  assert.match(unconfirmed, /^口渴多饮、尿多的情况请尽早到医院查空腹血糖/);
  assert.doesNotMatch(unconfirmed, /您有糖尿病/);
  assert.deepEqual(project(rx(["服药期间请继续监测血糖。"]), { requiredPrecautions: [item] }).nonPharma.precautions, ["服药期间请继续监测血糖。"]);
});

// ───── 9 医护流程话 ─────
await check("9.1 「并备血」去掉、「须经医生与药师复核后使用」换成「请遵医嘱服用」（不给剂量页换成「是否使用由医生面诊后决定」）、「请医生确认」换成「请先咨询医生」；不带这些话的照留（对照）", () => {
  const herbs = ["姜半夏", "制天南星", "法半夏", "细辛"].map((name) => ({ name, role: "臣", function: "化痰", dose: "6g" }));
  const out = project(rx([
    "当前黑便量增多，须立即急诊评估循环状态并备血、安排急诊内镜，不得延误。",
    "方中姜半夏、制天南星为化痰峻品，须经医生与药师复核后使用。",
    "方中法半夏孕期需慎用，服药前请医生确认。",
    "服药期间如出现皮疹，请及时告知医生。",
  ], herbs)).nonPharma.precautions.slice(0, 4);
  assert.deepEqual(out, [
    "当前黑便量增多，须立即急诊评估循环状态、安排急诊内镜，不得延误。",
    "方中姜半夏、制天南星为化痰峻品，请遵医嘱服用。",
    "方中法半夏孕期需慎用，服药前请先咨询医生。",
    "服药期间如出现皮疹，请及时告知医生。",
  ]);
  const nonDose = project(rx(["方中细辛用量宜轻，须由医生按现行药典与院内规则复核后使用。"], herbs), { nonDosePage: true }).nonPharma.precautions[0];
  assert.equal(nonDose, "方中细辛用量宜轻，是否使用由医生面诊后决定。");
});

// ───── 10 同一页说两遍 ─────
await check("10.1 规则补的「病历记录您自行用过药，请把正在用的药（药名和用法）告诉医生」与模型写的同一句只留一条；模型写了「请把正在使用的药物名称和用法告诉医生」就算写到、不再补；话题不同的两句都留（对照）", () => {
  const item = { kind: "unnamed_medication" };
  assert.deepEqual(project(rx(["请把正在使用的药物名称和用法告诉医生，避免与本方重复或相互影响。"]), { requiredPrecautions: [item] }).nonPharma.precautions,
    ["请把正在使用的药物名称和用法告诉医生，避免与本方重复或相互影响。"]);
  assert.deepEqual(project(rx(["病历记录您自行用过药，请把正在用的药（药名和用法）告诉医生，避免与本方重复或相互影响。", "请把您正在使用的药物名称和用法告诉医生，以免与本方重复或相互影响。"])).nonPharma.precautions,
    ["病历记录您自行用过药，请把正在用的药（药名和用法）告诉医生，避免与本方重复或相互影响。"]);
  const different = ["服药期间如出现皮疹，请及时告知医生。", "服药期间如出现腹泻，请及时告知医生。"];
  assert.deepEqual(project(rx(different)).nonPharma.precautions, different);
  // 点了不同药名、句式一样的两句不并。
  const named = ["正在服用的阿司匹林请告知医生，是否继续服用由医生决定。", "正在服用的二甲双胍请告知医生，是否继续服用由医生决定。"];
  assert.deepEqual(project(rx(named)).nonPharma.precautions, named);
});

// ───── 11 幂等与提示词 ─────
await check("11.1 补过之后再投影一次不变；提示词逐项写到新项目（出血观察、控糖、戒酒、不要自行停用）", () => {
  const items = [
    { kind: "current_medications", names: ["阿司匹林", "他克莫司"], noSelfStop: ["他克莫司"] },
    { kind: "antithrombotic_bleeding", drugs: ["阿司匹林"] },
    { kind: "diabetes_glucose", confirmed: true },
    { kind: "administration_and_diet", diet: "忌食辛辣，戒酒", administration: true, alcohol: true },
    { kind: "postpartum_lactation" },
  ];
  const herbs = ["桃仁", "三棱", "丁香"].map((name) => ({ name, role: "臣", function: "x", dose: "6g" }));
  const once = project(rx(["饮食清淡。"], herbs, { diet: "可用红枣煮粥。" }), { requiredPrecautions: items });
  const twice = project(structuredClone(once), { requiredPrecautions: items });
  assert.deepEqual(twice.nonPharma, once.nonPharma);
  const prompt = precautions.requiredPrecautionsPromptSection(items);
  for (const pattern of [/他克莫司不要自行停用或减量/, /同用可能增加出血/, /定期监测血糖/, /写明戒酒/]) assert.match(prompt, pattern);
});

console.log(JSON.stringify({ suite: "r1019-round5-precautions", cases, failures: process.exitCode ? "see above" : 0 }));
