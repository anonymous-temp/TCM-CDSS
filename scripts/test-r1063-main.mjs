// 第四十六轮（2026-11-15）主会话：红旗、复诊计划、病历读法、出血未排除时的方药。工作包 B/C/D 各有自己的套件。
//  1. 成人生命体征合起来的不稳定（NEWS2 ≥7；休克指数 ≥1 伴失血/失液/灌注不足）作确定性红旗，理由写实际读数；
//     DKA 两项标准 + 意识改变或深快呼吸；高血糖解释的体重下降不是上消化道警示；哮喘发作的胸闷不按急性冠脉综合征；
//     急性眩晕伴站立行走困难、行走偏斜；全身乏力句里的「走路发飘」不是局灶体征；SpO₂ 下标写法。
//  2. 红旗复诊第一步分「立即」「当天」两档；换第一步时去掉前一阶段按别的对象写的那句；病历已有的表现不当将来的警示条件；
//     主诉按月经周期出现的病按周期复诊。
//  3. 病历读法：以小便、大便、面色作主语的小句不是否认列举的裸词；改写否认时保留时间范围与范围外的项；黄疸同组写法。
//  4. 出血未排除（雷击样头痛、未做影像的卒中样表现、循环不稳伴阴道出血）时活血化瘀药不入方。
// 每条断言都有反证（~/runlogs/r1018/work/r1063/cp/main.py）。
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

const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const closure = await jiti.import("../src/lib/analysis-element-closure.ts");
const basisAuthoring = await jiti.import("../src/lib/western-basis-authoring.server.ts");

const state = (chiefComplaint, history, extra = {}) => types.normalizeCaseStateInput({
  id: `r1063-${Math.random().toString(36).slice(2)}`,
  chiefComplaint,
  patient: { sex: extra.sex || "男", age: extra.age ?? 40 },
  symptoms: { 现病史: history, ...(extra.symptoms || {}) },
  vitals: extra.vitals || {},
  tongue: extra.tongue || "",
  pulse: extra.pulse || "",
});
const flags = (input) => safety.detectProgrammaticRedFlags(input);
const has = (list, pattern) => list.some((flag) => pattern.test(flag));

await check("1.1 哮喘重度发作：SpO₂90%、R30、P124 报生命体征红旗并写读数；已知哮喘、喘鸣时胸闷不报急性冠脉综合征", () => {
  const asthma = state("喘息、胸闷加重6小时", "接触猫毛后喘鸣和呼气费力，讲话需间歇停顿。", {
    sex: "女", age: 33, vitals: { T: "36.8", P: "124", R: "30", BP: "132/82" },
    symptoms: { 既往史: "支气管哮喘10年", 辅助检查: "指脉氧SpO₂90%（室内空气）" },
  });
  const list = flags(asthma);
  assert.ok(has(list, /^生命体征提示病情危重（呼吸30次\/分、血氧90%、心率124次\/分，按 NEWS2 计 8 分）/u), JSON.stringify(list));
  assert.ok(!has(list, /急性冠脉综合征|急性心血管事件/u), JSON.stringify(list));
  assert.equal(safety.currentVitalMeasurements(asthma).spo2, 90, "「指脉氧SpO₂90%」读得出");
  assert.equal(safety.bronchospasmChestTightness(asthma), true);
  const noAsthma = state("胸闷加重6小时", "胸闷、喘息，呼吸费力。", { age: 58, vitals: { P: "96", R: "20", BP: "150/90" } });
  assert.equal(safety.bronchospasmChestTightness(noAsthma), false, "对照：没有哮喘/慢阻肺病史的胸闷照旧按心血管评估");
  assert.ok(has(flags(noAsthma), /急性冠脉综合征|急性心血管事件/u), "对照：仍报心血管红旗");
  const withPain = state("喘息、胸闷伴胸痛6小时", "喘鸣，胸闷，胸骨后疼痛。", { age: 50, symptoms: { 既往史: "支气管哮喘10年" } });
  assert.equal(safety.bronchospasmChestTightness(withPain), false, "对照：有胸痛时不适用");
  const deniedAsthma = state("胸闷、喘息6小时", "胸闷，喘息。", { age: 50, symptoms: { 既往史: "否认哮喘病史" } });
  assert.equal(safety.bronchospasmChestTightness(deniedAsthma), false, "对照：否认哮喘不算");
});

await check("1.2 休克指数≥1 伴吐泻、出血、灌注不足报红旗并写见到的表现；只有心动过速、没有失血失液记录的不报", () => {
  const diarrhea = state("腹泻伴呕吐2天", "水样便每日8次，呕吐4次，近8小时尿量明显减少。", { vitals: { T: "37.8", P: "116", R: "23", BP: "94/62" } });
  const reason = safety.vitalInstabilityRedFlag(diarrhea, safety.trustedInputText(diarrhea));
  assert.match(reason || "", /^心率116次\/分、血压94\/62mmHg（休克指数1\.2）伴[^，]*水样便/u);
  const menses = state("经期延长伴经量明显增多2个月", "本次出血第9天，近1小时换透1片大号卫生巾，今天头晕心悸。", { sex: "女", age: 43, vitals: { P: "106", BP: "98/60" } });
  assert.match(safety.vitalInstabilityRedFlag(menses, safety.trustedInputText(menses)) || "", /经量明显增多/u);
  const anxious = state("心慌1天", "紧张时心慌，休息可缓解。", { age: 25, vitals: { P: "104", R: "18", BP: "100/70" } });
  assert.equal(safety.vitalInstabilityRedFlag(anxious, safety.trustedInputText(anxious)), undefined, "对照：休克指数≥1 但没有失血失液或灌注不足");
  const mild = state("腹泻1天", "稀便3次。", { vitals: { P: "92", BP: "118/76" } });
  assert.equal(safety.vitalInstabilityRedFlag(mild, safety.trustedInputText(mild)), undefined, "对照：休克指数<1");
});

await check("1.3 「大便每日1～2次，色黑发亮」分写的黑便认得出；否认、颜色正常不算；循环不稳时理由写黑便、不写神经系统急症", () => {
  assert.equal(safety.hasSeparatedMelenaDescription("追问近3天大便每日1～2次，色黑发亮、质软成形。"), true);
  assert.equal(safety.hasSeparatedMelenaDescription("大便每日1次，色黄成形。"), false, "对照：颜色正常");
  assert.equal(safety.hasSeparatedMelenaDescription("大便每日1次，无色黑。"), false, "对照：否认");
  const melena = state("乏力、头晕3天，加重1天", "患者近3天自觉全身乏力，走路发飘，蹲下站起时眼前发黑，伴心慌、出冷汗。追问近3天大便每日1～2次，色黑发亮、质软成形。",
    { age: 61, vitals: { T: "36.4", P: "108", R: "20", BP: "98/60" }, symptoms: { 体格检查: "面色苍白，四肢末梢偏凉" } });
  const list = flags(melena);
  assert.ok(has(list, /休克指数1\.1）伴黑便/u), JSON.stringify(list));
  assert.ok(!has(list, /意识或神经功能异常/u), JSON.stringify(list));
});

await check("1.4 NEWS2 不到 7 分、未满 16 岁、在孕的不按这条报", () => {
  const febrile = state("发热2天", "发热，咳嗽。", { vitals: { T: "38.5", P: "105", R: "22", BP: "120/80" } });
  assert.equal(safety.vitalInstabilityRedFlag(febrile, safety.trustedInputText(febrile)), undefined, "NEWS2 4 分");
  const child = state("发热2天", "发热，咳嗽，精神差。", { age: 10, vitals: { T: "39.2", P: "135", R: "32", BP: "95/60" } });
  assert.equal(safety.vitalInstabilityRedFlag(child, safety.trustedInputText(child)), undefined, "儿童走 NG143");
  const pregnant = state("孕30周，发热2天", "妊娠30周，发热，咳嗽。", { sex: "女", age: 28, vitals: { T: "39.2", P: "125", R: "26", BP: "96/60" } });
  assert.equal(safety.vitalInstabilityRedFlag(pregnant, safety.trustedInputText(pregnant)), undefined, "妊娠另有规则");
  const septic = state("发热乏力2天", "发热，乏力，嗜睡。", { vitals: { T: "38.7", P: "122", R: "25", BP: "90/58" } });
  assert.match(safety.vitalInstabilityRedFlag(septic, safety.trustedInputText(septic)) || "", /^生命体征提示病情危重/u, "对照：≥7 分照报");
});

await check("1.5 DKA 两项标准加意识改变或深快呼吸报红旗；只有两项标准走 24 小时通道；高血糖解释的体重下降不是上消化道警示", () => {
  const severe = state("恶心、呕吐伴腹痛2天", "近1个月口渴多饮，夜尿多，体重下降约6kg。今日反应比平时迟钝，躺着时呼吸又深又快。",
    { age: 24, vitals: { P: "112", R: "28", BP: "98/62" }, symptoms: { 体格检查: "嗜睡，呼吸深快", 辅助检查: "门诊指尖血糖26.8mmol/L；尿常规：酮体3+" } });
  const list = flags(severe);
  assert.ok(has(list, /^高血糖伴酮体升高（已达糖尿病酮症酸中毒的血糖与酮体标准）并见/u), JSON.stringify(list));
  assert.ok(!has(list, /上消化道警示征象/u), JSON.stringify(list));
  const mild = state("口渴多饮1月", "口渴多饮，体重下降约6kg，恶心。", { age: 40, vitals: { P: "88", R: "18", BP: "122/80" }, symptoms: { 辅助检查: "随机血糖21.0mmol/L；尿酮2+" } });
  assert.deepEqual(safety.severeKetoacidosisSigns(mild, safety.trustedInputText(mild)), [], "两项标准但无意识改变、无深快呼吸");
  const unexplained = state("消瘦伴恶心1月", "近1月体重下降约6kg，恶心，上腹隐痛。", { age: 58 });
  assert.ok(has(flags(unexplained), /上消化道警示征象（不明原因体重下降）/u), "对照：没有高血糖解释时照报");
});

await check("1.6 突发眩晕伴站立困难、行走偏斜报后循环卒中红旗；起身时头晕扶墙站稳不报；全身乏力句里的走路发飘不是局灶体征", () => {
  const vertigo = state("旋转性眩晕伴呕吐4小时", "突然出现持续剧烈眩晕，站立困难，伴行走偏斜。", { sex: "女", age: 66, symptoms: { 既往史: "高血压、房颤", 用药史: "利伐沙班" } });
  assert.ok(has(flags(vertigo), /^突发眩晕伴站立行走困难或复视等失衡表现，需立即排除后循环卒中/u), JSON.stringify(flags(vertigo)));
  assert.equal(safety.hasAcutePosteriorCirculationCombination("今晨上厕所起身时头晕明显，扶墙才站稳。"), false, "对照：体位性头晕");
  const weak = state("乏力3天", "患者近3天自觉全身乏力，走路发飘。", { age: 61 });
  assert.ok(!has(flags(weak), /神经系统急症/u), JSON.stringify(flags(weak)));
  const diplopia = state("头晕3天", "近3天看东西重影，走路发飘。", { age: 61 });
  assert.ok(has(flags(diplopia), /神经系统急症/u), "对照：复视同句的走路发飘照报");
});

await check("2.1 红旗复诊第一步：正在进行的急危重写「立即」，只有上消化道警示等写「当天」", () => {
  assert.equal(safety.redFlagNeedsImmediateCare(["上消化道警示征象（不明原因体重下降）已出现，需优先安排内镜或影像评估以排除梗阻、复发与占位，再评估处方"]), false);
  assert.equal(safety.redFlagNeedsImmediateCare(["胸痛/胸闷伴大汗、放射痛或气促，需排除急性心血管事件"]), true);
  assert.equal(safety.redFlagNeedsImmediateCare(["上消化道警示征象（吞咽或进食梗阻）已出现，需优先安排内镜或影像评估以排除梗阻、复发与占位，再评估处方", "现有资料提示需立即急诊评估（需排除：急性心肌梗死）"]), true);
  const first = safety.priorityEvaluationFirstStep({ focus: "急危重情况", window: "immediately", pathway: "red_flag_clearance" }, { doses: 5, days: 5 });
  assert.equal(first, "请立即到医院急诊就诊（病情危急时拨打120），先排除急危重情况；医生确认可以服药后，服完5剂药（约5天后）再复诊。");
  assert.equal(safety.priorityEvaluationFollowUpNode({ focus: "急危重情况", window: "immediately", pathway: "red_flag_clearance" }, "完成5剂（5日）后复诊"),
    "先立即到医院急诊完成评估；医生确认可以服药后，完成5剂（5日）后复诊");
  assert.match(safety.priorityEvaluationFirstStep({ focus: "急危重情况", window: "today", pathway: "red_flag_clearance" }), /^请在当天到医院急诊或专科就诊/u, "对照：当天档原句");
  const acs = state("胸痛2小时", "胸骨后压榨性闷痛2小时，伴大汗，含服硝酸甘油无效。", { age: 62 });
  assert.equal(safety.doseRestrictionFollowupTarget(acs)?.window, "immediately");
});

await check("2.2 开方页换第一步时去掉辨证页按别的评估对象写的那一句，抗凝的复查凝血嘱咐留一遍", () => {
  const previous = "请在3天内带上正在服用的抗凝或抗血小板药，请开这些药的医生评估与中药合用的出血风险，医生同意合用后再按医生安排服药与复诊。服药后1周内复查凝血指标（服华法林者查INR）；如出现牙龈或鼻腔出血、皮肤瘀斑、黑便或尿色发红，请立即就医。若膝关节疼痛突然加重，请提前复诊。";
  const after = "服药后1周内复查凝血指标（服华法林者查INR）；如出现牙龈或鼻腔出血、皮肤瘀斑、黑便或尿色发红，请立即就医。";
  const out = surface.followupWhenPriorityEvaluation(previous, { focus: "华法林与三七丹参泡酒联用致出血风险", window: "within_48h", afterStep: after }, { doses: 7, days: 7 });
  assert.ok(out.startsWith("请在48小时内到相关专科就诊"), out);
  assert.ok(!out.includes("请在3天内"), out);
  assert.equal(out.split("复查凝血指标").length - 1, 1, out);
  assert.ok(out.includes("若膝关节疼痛突然加重"), "模型写的其余嘱咐照留");
  // 合并评估对象：服华法林（抗凝通道 3 天）又达到 DKA 两项标准（24 小时通道）——第一步按 24 小时写，复查凝血的嘱咐带上。
  const merged = safety.priorityEvaluationFollowupTarget(state("口渴多饮1月", "口渴多饮，乏力。", {
    age: 60, vitals: { P: "88", R: "18", BP: "130/80" }, symptoms: { 用药史: "华法林3mg每日1次", 辅助检查: "随机血糖21.0mmol/L；尿酮2+" },
  }));
  assert.equal(merged?.window, "within_24h");
  assert.match(safety.priorityEvaluationFirstStep(merged, { doses: 7, days: 7 }), /^请在24小时内[^。]*。服药后1周内复查凝血指标/u);
});

await check("2.3 病历已肯定记载的表现不当将来的警示条件写；整组都删光时这一句不留；未记载的照留", () => {
  const record = "患者年龄：35岁\n患者性别：男\n腹泻伴呕吐2天\n食用隔夜海鲜后水样便每日8次，呕吐4次，近8小时尿量明显减少。";
  assert.equal(surface.withoutRecordedFutureConditions("请服完本次的药后复诊。若出现精神差、四肢发凉、尿量明显减少，请立即就医。", record), "请服完本次的药后复诊。若出现精神差、四肢发凉，请立即就医。");
  assert.equal(surface.withoutRecordedFutureConditions("若出现尿量明显减少，请立即就医。下次复诊带化验单。", record), "下次复诊带化验单。");
  assert.equal(surface.withoutRecordedFutureConditions("若出现高热不退，请立即就医。", record), "若出现高热不退，请立即就医。", "对照");
});

await check("2.4 主诉是按月经周期出现的表现时按周期复诊（病名为癥瘕也一样）", () => {
  const record = "患者年龄：42岁\n患者性别：女\n发现子宫肌瘤2年，经期腹痛加重半年\n近半年经期小腹胀痛。";
  assert.match(surface.followupWithMenstrualCycle("请在服完7剂药后（约7天后）复诊。", "癥瘕", record), /按月经周期观察/u);
  assert.equal(surface.followupWithMenstrualCycle("请在服完7剂药后（约7天后）复诊。", "癥瘕", "患者年龄：42岁\n患者性别：女\n腹部包块2年\n"), "请在服完7剂药后（约7天后）复诊。", "对照");
});

await check("2.5 紧挨着重复的同一小句只留一个（「未发现感染灶，未发现感染灶，未发现感染灶」）；不同分隔、不足 3 字的不动", () => {
  assert.equal(surface.readabilityCleaned("均正常，未发现感染灶，未发现感染灶，未发现感染灶"), "均正常，未发现感染灶");
  assert.equal(surface.readabilityCleaned("平卧呛咳，病历记录心电图：窦性心律，病历记录心电图：窦性心律，正常心电图。"), "平卧呛咳，病历记录心电图：窦性心律，正常心电图。");
  assert.equal(surface.readabilityCleaned("咳嗽，咳嗽有痰。"), "咳嗽，咳嗽有痰。", "对照");
});

await check("3.1 以小便、大便作主语的小句不是否认列举的裸词（「无黏液脓血，小便清长」）", () => {
  const notice = safety.commaContinuedDenialReadingNotice({ chiefComplaint: "夜啼1周", symptoms: { 现病史: "大便溏薄、每日3次，无黏液脓血，小便清长。无发热，无呕吐。" } });
  assert.ok(!notice.includes("小便清长"), notice);
  const bare = safety.commaContinuedDenialReadingNotice({ chiefComplaint: "腹泻2天", symptoms: { 现病史: "无腹痛，发热，呕吐，于乡卫生院输液。" } });
  assert.ok(bare.includes("发热"), "对照：真正的裸词照旧提示");
});

await check("3.2 改写否认时保留时间范围（病历先写既往发作、后写近期没有）；否认范围外、自己说能做到的项照留", () => {
  const epilepsy = state("癫痫8年，乏力纳差便溏2月", "患者8年前起反复出现发作性意识丧失、四肢抽搐，近14个月未再发作。无抽搐、意识丧失及愣神发作，无头痛、呕吐。", { age: 28 });
  assert.equal(safety.sanitizeUngroundedRedFlagNegations("长期规律服丙戊酸钠，近2月无意识丧失及愣神发作", epilepsy), "长期规律服丙戊酸钠，近2月无意识丧失及愣神发作");
  const edema = state("双下肢水肿2周", "孕28周，双下肢凹陷性水肿。无头痛、视物模糊，无上腹痛，夜间可平卧。", { sex: "女", age: 30 });
  const out = safety.sanitizeUngroundedRedFlagNegations("无胸闷气促、夜间可平卧，支持妊娠期生理性水肿", edema);
  assert.ok(out.includes("夜间可平卧") && !/尚未确认夜间可平卧|否认[^。]*夜间可平卧/u.test(out), out);
});

await check("3.3 黄疸与巩膜黄染同组：「无进行性黄疸」对病历「进行性巩膜黄染」不改成「未诉」，而是删掉这条与病历相反的否认", () => {
  const ctx = "患者年龄：60岁\n患者性别：男\n皮肤巩膜黄染2周\n进行性巩膜黄染，伴皮肤瘙痒，尿色深黄，无腹痛。";
  assert.ok(!summary.unrecordedNegativesAsNotReported("胰头占位性病变：无进行性黄疸。", ctx).includes("未诉进行性黄疸"));
  assert.equal(summary.withoutDenialsOfRecordedFindings("胰头占位性病变：无腹痛，无进行性黄疸，可资鉴别。", ctx), "胰头占位性病变：无腹痛，可资鉴别。");
  assert.equal(summary.recordAffirmsDeniedFinding("患者年龄：60岁\n腹痛1周\n无巩膜黄染。", "进行性黄疸"), false, "对照：病历否认黄染");
});

await check("4.1 出血未排除时活血化瘀药不入方：雷击样头痛（理由点名蛛网膜下腔出血）、未做影像的卒中样表现；影像已见梗死的不算", () => {
  const sah = state("突发剧烈头痛2小时", "运动中突然发生生平最严重头痛，伴呕吐、颈部僵硬。", { sex: "女", age: 45, symptoms: { 辅助检查: "未进行头颅CT" } });
  assert.ok(has(flags(sah), /需优先排除蛛网膜下腔出血等神经系统急症/u), JSON.stringify(flags(sah)));
  const sahText = safety.clinicalGroundingText(sah);
  assert.equal(contract.herbBarredForCase("牛膝", sahText), true);
  assert.equal(safety.activeBleedingWording(sahText, flags(sah)), "to_exclude", "措辞是「出血尚未排除」");
  const stroke = state("右侧肢体无力2小时", "今日突然右侧肢体无力，言语不清。", { age: 70, symptoms: { 辅助检查: "未行头颅影像检查" } });
  assert.equal(safety.intracranialHemorrhageNotExcluded(safety.trustedInputText(stroke), flags(stroke)), true);
  assert.equal(contract.herbBarredForCase("川芎", safety.clinicalGroundingText(stroke)), true);
  const imaged = state("右侧肢体无力2小时", "今日突然右侧肢体无力，言语不清。", { age: 71, symptoms: { 辅助检查: "头颅CT示左侧基底节区腔隙性脑梗死，未见出血" } });
  assert.equal(safety.intracranialHemorrhageNotExcluded(safety.trustedInputText(imaged), flags(imaged)), false, "对照：影像已排除出血");
});

await check("4.2 循环不稳伴阴道少量出血（疑异位妊娠破裂）：红旗写出出血，活血化瘀药不入方", () => {
  const ectopic = state("下腹痛半天，阴道少量出血2天", "本次月经未按时来潮，2天前出现阴道少量出血，今晨突然右下腹撕扯样疼痛，伴头晕、心慌、出冷汗。",
    { sex: "女", age: 30, vitals: { P: "112", BP: "92/58" }, symptoms: { 体格检查: "四肢湿冷" } });
  const list = flags(ectopic);
  assert.ok(has(list, /伴阴道少量出血/u), JSON.stringify(list));
  assert.equal(safety.hasActiveBleedingRedFlag(list), true);
  assert.equal(contract.herbBarredForCase("川芎", safety.clinicalGroundingText(ectopic)), true);
});

await check("5.1 加减条件是舌脉的紧凑写法（「脉弦」）而病历按字段写（「脉象：弦」）时也算本例已见；别的脉、病历没记的不算", () => {
  const facts = "头痛3个月\n舌象：舌淡红，苔薄白\n脉象：弦\n面象：神清，颈肩紧张";
  assert.deepEqual(compiler.presentModificationCondition("脉弦", facts), { trigger: "本例已见脉弦", quote: "脉象：弦" });
  assert.equal(compiler.presentModificationCondition("脉滑", facts), undefined, "对照：病历是弦脉");
  assert.equal(compiler.presentModificationCondition("苔黄腻", facts), undefined, "对照：病历苔薄白");
});

await check("6.1 舌脉表现照病历字段写法也认（「脉象：弦」「脉沉弦」「弦脉」算脉弦；「舌淡红」不算舌淡）", () => {
  assert.equal(closure.textHasSign("脉象：弦", "脉弦"), true);
  assert.equal(closure.textHasSign("脉沉弦", "脉弦"), true);
  assert.equal(closure.textHasSign("弦脉", "脉弦"), true);
  assert.equal(closure.textHasSign("舌苔：黄腻", "苔黄"), true);
  assert.equal(closure.textHasSign("脉细", "脉弦"), false, "对照");
  assert.equal(closure.textHasSign("舌象：舌淡红，苔薄白", "舌淡"), false, "对照：淡红舌是正常舌象");
  assert.deepEqual(closure.recordSignQuotes("头痛\n脉象：弦\n舌淡红", ["脉弦"]), ["脉象：弦"]);
});

await check("6.2 流派「部分适用」只在辨证末句已说按常规辨证时才改判不适用，理由不写「不在该派用方之列」", () => {
  const base = (rationale) => ({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    overview: { tcmDiseaseName: "郁证", primarySyndrome: "肝气郁结证", tcmDiagnosticRationale: rationale },
    lineageAdaptation: { lineageCode: "warm-tonify", label: "温补学派思路", applicable: "partial", applicabilityReason: "本例部分相合", influencedDecisions: [] },
    formula: { candidates: [{ name: "柴胡疏肝散", formulaNames: ["柴胡疏肝散"], herbs: [{ name: "柴胡", dose: "10g", role: "君" }], formulaSource: { source: "" }, formulaAnalysis: "", decoction: { method: "水煎服" } }] },
  });
  const kept = surface.projectDeliveredReasoning(base("温补学派看脾肾命门，本例气郁为主，宜疏肝。"));
  assert.equal(kept.lineageAdaptation.applicable, "partial");
  const changed = surface.projectDeliveredReasoning(base("温补学派看脾肾命门，本例未见命门火衰实据，以下按常规辨证处理。"));
  assert.equal(changed.lineageAdaptation.applicable, "not-applicable");
  assert.doesNotMatch(changed.lineageAdaptation.applicabilityReason, /用方之列/u);
});

await check("6.3 「无」后面的对象自己带否定或检查结论时不改写成「未诉…」（「喉镜未见新生物」）；普通阴性照改（对照）", () => {
  assert.equal(summary.unrecordedNegativesAsNotReported("无喉镜未见新生物", "喉镜：双侧声带小结，未见新生物"), "无喉镜未见新生物");
  assert.equal(summary.unrecordedNegativesAsNotReported("本例无口苦", "头晕2天"), "本例未诉口苦", "对照");
});

await check("6.4 病历写明已断奶时注意事项不写「如正在哺乳请先告知医生」的假设小句；在哺乳的照留（对照）", () => {
  const precautions = ["方中当归、川芎活血，如已怀孕或备孕请先告知医生。", "如正在哺乳请先告知医生。", "饭后温服。"];
  const weaned = state("腰痛2周", "腰部酸痛。", { sex: "女", age: 35, symptoms: { 婚育史: "已婚，育1子，已断奶2年" } });
  const out = compiler.casePrecautionsForTest ? compiler.casePrecautionsForTest(precautions, weaned) : null;
  if (out) {
    assert.ok(!out.some((line) => /正在哺乳/u.test(line)), JSON.stringify(out));
    const nursing = state("腰痛2周", "腰部酸痛。", { sex: "女", age: 30, symptoms: { 婚育史: "产后3月，母乳喂养" } });
    assert.ok(compiler.casePrecautionsForTest(precautions, nursing).some((line) => /正在哺乳/u.test(line)), "对照");
  } else {
    throw new Error("casePrecautionsForTest 未导出");
  }
});

await check("6.5 加减行的人群提示不读过敏史、家族史：过敏史写阿司匹林不算「本例有抗凝状态的记录」；现用阿司匹林照写（对照）", () => {
  assert.deepEqual(contract.recordedPopulationCautions("鸡血藤", "患者年龄：60岁\n患者性别：男\n腰痛\n过敏史：阿司匹林诱发喘息"), []);
  assert.ok(contract.recordedPopulationCautions("鸡血藤", "患者年龄：60岁\n患者性别：男\n腰痛\n用药史：阿司匹林100mg每日1次").length > 0);
});

await check("6.6 删句后留下的「。，」收成句号", () => {
  assert.equal(surface.readabilityCleaned("故属风寒束表证。，本例脉浮。"), "故属风寒束表证。本例脉浮。");
});

await check("6.7 西医依据直说没确立（「诊断尚未确立」「…后方可诊断X」「尚缺规范评估排除…」「需…监测确认」）时病名按待查；只缺严重程度、或说可诊断的不算（对照）", () => {
  assert.equal(basisAuthoring.basisSaysNameNotEstablished("本次反复跌倒、入睡困难，失眠障碍诊断尚未确立。", "失眠障碍"), true);
  assert.equal(basisAuthoring.basisSaysNameNotEstablished("需排除器质性疾病后方可诊断神经性厌食症。", "神经性厌食症"), true);
  assert.equal(basisAuthoring.basisSaysNameNotEstablished("功能性腹痛诊断尚缺规范评估排除器质性疾病。", "功能性腹痛"), true);
  assert.equal(basisAuthoring.basisSaysNameNotEstablished("打鼾憋醒，阻塞性睡眠呼吸暂停需多导睡眠监测确认。", "阻塞性睡眠呼吸暂停"), true);
  assert.equal(basisAuthoring.basisSaysNameNotEstablished("临床可诊断支气管哮喘，尚缺肺功能确认严重程度。", "支气管哮喘"), false, "对照");
  assert.equal(basisAuthoring.basisSaysNameNotEstablished("符合急性上呼吸道感染。", "急性上呼吸道感染"), false, "对照");
});

if (failures > 0) console.error(`\n${failures} check(s) failed`);
else console.log("\nAll r1063 main checks passed");
