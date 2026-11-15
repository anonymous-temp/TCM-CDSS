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
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
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
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const claimCheck = await jiti.import("../src/lib/m03-patient-claim-check.server.ts");
const secondary = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
const capabilities = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
const terminology = await jiti.import("../src/lib/clinical-terminology.ts");

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

// 6.2（部分适用按方名改判不适用）已撤回：改判后理由与分析自相矛盾，见 7.9。

await check("6.3 「无」后面的对象自己带否定或检查结论时不改写成「未诉…」（「喉镜未见新生物」）；普通阴性照改（对照）", () => {
  assert.equal(summary.unrecordedNegativesAsNotReported("无喉镜未见新生物", "喉镜：双侧声带小结，未见新生物"), "无喉镜未见新生物");
  assert.equal(summary.unrecordedNegativesAsNotReported("本例无口苦", "头晕2天"), "本例未诉口苦", "对照");
});

await check("6.4 已断奶不写哺乳提示；已知哺乳不写假设人群提示", () => {
  const precautions = ["方中当归、川芎活血，如已怀孕或备孕请先告知医生。", "如正在哺乳请先告知医生。", "饭后温服。"];
  const weaned = state("腰痛2周", "腰部酸痛。", { sex: "女", age: 35, symptoms: { 婚育史: "已婚，育1子，已断奶2年" } });
  const out = compiler.casePrecautionsForTest ? compiler.casePrecautionsForTest(precautions, weaned) : null;
  if (out) {
    assert.ok(!out.some((line) => /正在哺乳/u.test(line)), JSON.stringify(out));
    const nursing = state("腰痛2周", "腰部酸痛。", { sex: "女", age: 30, symptoms: { 婚育史: "产后3月，母乳喂养" } });
    // 第四十七轮F3：病历已知哺乳，不再保留「如正在哺乳」；交付时必写项另给直接哺乳提示。
    assert.ok(!compiler.casePrecautionsForTest(precautions, nursing).some((line) => /如正在哺乳|怀孕|备孕/u.test(line)), "已知人群不假设");
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

// ───── 7. 重跑复核（review-r46b）找到的服务端成因 ─────
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
const HEADACHE_CASE = { chiefComplaint: "头痛昏蒙2周", patient: { age: 45, sex: "男" }, symptoms: { 现病史: "头痛昏蒙2周，胸脘满闷，呕恶痰涎，纳呆，口苦。舌胖大，苔白腻，脉弦滑。" } };

await check("7.1 加减条件只有舌象或脉象（「本例已见脉弦」「脉象：沉迟」「苔白腻」）不作加减，编译与补写同一判据；舌脉与症状写在同一条、或症状里带「舌痛」照收（对照）", () => {
  assert.equal(compiler.modificationTriggerTonguePulseOnly("本例已见脉弦"), "pulse");
  assert.equal(compiler.modificationTriggerTonguePulseOnly("脉象：沉迟"), "pulse");
  assert.equal(compiler.modificationTriggerTonguePulseOnly("弦脉"), "pulse");
  assert.equal(compiler.modificationTriggerTonguePulseOnly("苔白腻"), "tongue");
  assert.equal(compiler.modificationTriggerTonguePulseOnly("舌暗、脉涩"), "tongue");
  assert.equal(compiler.modificationTriggerTonguePulseOnly("口苦、苔黄"), undefined, "对照：舌脉与症状同一条");
  assert.equal(compiler.modificationTriggerTonguePulseOnly("舌痛"), undefined, "对照：舌痛是症状");
  const rows = [
    { trigger: "脉弦滑", targetRef: "P1", actionType: "add", herbName: "青皮", dose: "6g", reason: "疏肝理气", symptomPathogenesis: "肝气不舒" },
    { trigger: "苔白腻", targetRef: "P1", actionType: "add", herbName: "苍术", dose: "10g", reason: "燥湿健脾", symptomPathogenesis: "湿浊中阻" },
    { trigger: "纳呆", targetRef: "P1", actionType: "add", herbName: "焦神曲", dose: "10g", reason: "消食和胃", symptomPathogenesis: "痰湿困脾" },
  ];
  // 舌脉写进了辨证依据（病历事实可回溯），这一行才走到条件核对这一步。
  const priorWithTonguePulse = { ...PRIOR_HEADACHE, overview: { ...PRIOR_HEADACHE.overview, primarySyndromeBasis: [...PRIOR_HEADACHE.overview.primarySyndromeBasis, "苔白腻", "脉弦滑"] } };
  const out = compiler.compileM04Proposal(headacheProposal(rows), priorWithTonguePulse, HEADACHE_CASE);
  const delivered = out.formula.modifications;
  assert.ok((out.formula.modificationReview?.droppedReasons || []).some((item) => item.code === "trigger_not_symptom"), JSON.stringify(out.formula.modificationReview));
  assert.ok(!delivered.some((row) => row.herbName === "青皮"), JSON.stringify(delivered));
  assert.ok(!delivered.some((row) => row.herbName === "苍术"), "模型写的单舌象条件同样不收");
  assert.ok(delivered.some((row) => /神曲/u.test(row.herbName)), "对照：症状条件照收");
  const top = (trigger) => compiler.topUpModificationRow({ trigger, herbName: "厚朴", dose: "10g", reason: "行气宽中，燥湿除满", symptomPathogenesis: "痰湿阻滞气机" },
    { prior: PRIOR_HEADACHE, caseState: types.normalizeCaseStateInput(HEADACHE_CASE), candidateHerbNames: ["法半夏", "天麻", "白术", "茯苓", "陈皮", "甘草"], existingTriggers: [] });
  assert.equal(top("脉弦滑"), undefined, "补写：单写脉象不收");
  assert.ok(top("胸脘满闷"), "补写对照：症状照收");
});

await check("7.2 补写的加减行与编译同一份提示：76 岁慢性肾病加细辛写肾功能不全、老年人慎用；病历只记月经量多时加三七只写「月经期」，不写「出血倾向/月经期/抗凝状态」", () => {
  const ckd = types.normalizeCaseStateInput({ chiefComplaint: "心悸伴头晕1周", patient: { age: 76, sex: "男" }, symptoms: { 现病史: "心悸，头晕，畏寒肢冷，面色苍白。", 既往史: "慢性肾病" }, tongue: "舌淡", pulse: "沉迟" });
  const prior = { ...PRIOR_HEADACHE, overview: { ...PRIOR_HEADACHE.overview, tcmDiseaseName: "心悸", primarySyndrome: "心阳不振证" }, pathogenesis: { chain: [{ nodeId: "P1", patientFact: "心悸，畏寒肢冷", pathogenesis: "心阳不振", therapyDirection: "温补心阳" }] }, therapy: { overallMethod: "温补心阳，安神定悸", overallPrinciple: "虚则补之" } };
  const row = compiler.topUpModificationRow({ trigger: "畏寒肢冷", herbName: "细辛", dose: "3g", reason: "温通心阳", symptomPathogenesis: "阳虚失温" },
    { prior, caseState: ckd, candidateHerbNames: ["桂枝", "炙甘草", "龙骨", "牡蛎"], existingTriggers: [] });
  assert.ok(row, "这一行应收");
  assert.match(row.riskNote, /肾功能不全/u, row.riskNote);
  assert.match(row.riskNote, /老年人/u, row.riskNote);
  const menses = contract.recordedPopulationCautions("三七", "患者年龄：35岁\n患者性别：女\n现病史：月经量多，经期延长，血块多");
  assert.deepEqual(menses, ["月经期"], JSON.stringify(menses));
  const warfarin = contract.recordedPopulationCautions("三七", "患者年龄：60岁\n患者性别：男\n用药史：华法林3mg每日1次");
  assert.deepEqual(warfarin, ["抗凝状态"], "对照：服华法林写抗凝状态");
});

await check("7.3 删掉一句的头一个分句后，只剩没有归属词的短续句（「温煦失职」）一并去掉；带「故属」的续句、以病位开头的续句照留（对照）", () => {
  assert.equal(secondary.withoutClauses("双膝痛，故属痛痹；为脾肾阳虚，温煦失职；苔白、步行缓慢。", ["为脾肾阳虚"]), "双膝痛，故属痛痹；苔白、步行缓慢。");
  assert.equal(secondary.withoutClauses("双膝痛；为脾肾阳虚，故属痛痹。", ["为脾肾阳虚"]), "双膝痛；故属痛痹。", "对照：带归属词");
  assert.equal(secondary.withoutClauses("口渴；为胃热炽盛，病位在胃与肾；乏力。", ["为胃热炽盛"]), "口渴；病位在胃与肾；乏力。", "对照：病位句");
});

await check("7.4 病名改成教材节名时新名含旧名（耳鸣 → 耳鸣耳聋）只换指病名的位置，「双耳鸣响」不变；新名不含旧名（头风病 → 头痛）照旧全换（对照）", () => {
  assert.equal(provenance.renamedDiseaseMentions("以双耳鸣响为主症，属耳鸣范畴。", "耳鸣", "耳鸣耳聋"), "以双耳鸣响为主症，属耳鸣耳聋范畴。");
  assert.equal(provenance.renamedDiseaseMentions("头风病以头痛为主，属头风病。", "头风病", "头痛"), "头痛以头痛为主，属头痛。", "对照");
});

await check("7.5 方义里提示词的「方向已成立」那一小句去掉，别的小句照留", () => {
  const out = surface.withoutInternalCompositionTalk("三七、蒲黄化瘀止血；改以方向已成立之活血通络药味充实层次；甘草为使，调和诸药。");
  assert.ok(!/方向已成立/u.test(out), out);
  assert.match(out, /三七、蒲黄化瘀止血/u);
  assert.match(out, /甘草为使/u);
});

await check("7.6 「未诉」改写的三种坏形：鉴别列举里一项自带否定（「本例无发热、切口无渗液」）不改；描述被鉴别病的列举（另一项写「有…」）不改；「推之无固定」只标到「无固定」时删整项、不写「推之未诉固定」", () => {
  const rec50 = "现病史：术后切口已愈合，屈膝受限，无发热渗液及小腿新发肿痛。";
  const reasoning = { stage: "diagnose", overview: {}, westernDiagnosis: { primary: { name: "膝关节置换术后", supportingFacts: [] }, differentials: [{ name: "假体周围感染", reason: "需排除", distinguishingPoints: "本例无发热、切口无渗液；但未查炎症指标" }] } };
  const content = `正文\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const out = summary.groundDifferentialNegativeAssertions(content, rec50);
  const json = JSON.parse(out.slice(out.indexOf("<!-- DIAGNOSIS_JSON_START -->") + 29, out.indexOf("<!-- DIAGNOSIS_JSON_END -->")));
  const points = json.westernDiagnosis.differentials[0].distinguishingPoints;
  assert.ok(!/病历未记录切口无渗液|未诉切口无渗液/u.test(points), points);
  const rec88 = "主诉：双手颤抖2年。现病史：静止时右手明显颤抖。";
  assert.equal(summary.unrecordedNegativesAsNotReported("起病较对称、无典型静止性震颤、有明确用药史", rec88, { differential: true }), "起病较对称、无典型静止性震颤、有明确用药史");
  assert.equal(summary.unrecordedNegativesAsNotReported("本例无口苦、有头晕", "头晕2天", { differential: true }), "本例未诉口苦、有头晕", "对照：本例主语照改");
  const root = { overview: { tcmDiagnosticRationale: "左乳无痛性结节、推之无固定，为气机不畅、痰凝乳络，故属肝气郁结证。" } };
  claimCheck.applyPatientClaimRemovals(root, "tcm", [{ field: "tcmDiagnosticRationale", span: "无固定" }], "现病史：左乳无痛性结节1月。");
  assert.ok(!/未诉固定|推之/u.test(root.overview.tcmDiagnosticRationale), root.overview.tcmDiagnosticRationale);
  assert.match(root.overview.tcmDiagnosticRationale, /左乳无痛性结节/u);
});

await check("7.7 依据写「疑诊X」「考虑X…待查」「X诊断依据不足」、或下一句以「但尚缺…确认」接着说时，病名按待查；说临床可诊断的不算（对照）", () => {
  assert.equal(basisAuthoring.basisSaysNameNotEstablished("有下肢静脉血栓史，临床高度疑诊急性肺血栓栓塞症。但尚缺肺动脉影像学检查，需行CTPA确认。", "急性肺血栓栓塞症"), true);
  assert.equal(basisAuthoring.basisSaysNameNotEstablished("家属目击呼吸暂停，考虑阻塞性睡眠呼吸暂停低通气综合征待查；尚缺多导睡眠监测。", "阻塞性睡眠呼吸暂停"), true);
  assert.equal(basisAuthoring.basisSaysNameNotEstablished("双耳嗡鸣半年。目前耳鸣诊断依据不足，尚缺纯音测听。", "耳鸣"), true);
  assert.equal(basisAuthoring.basisSaysNameNotEstablished("突发胸痛气促，咯血，有下肢静脉血栓史，考虑急性肺血栓栓塞症。但尚缺CTPA，需该检查确认。", "急性肺血栓栓塞症"), true, "下一句接着说缺什么");
  assert.equal(basisAuthoring.basisSaysNameNotEstablished("咳嗽有痰，临床可诊断急性支气管炎。但尚缺胸片排除肺炎。", "急性支气管炎"), false, "对照");
  assert.equal(basisAuthoring.basisSaysNameNotEstablished("腹痛转移至右下腹，麦氏点压痛，符合急性阑尾炎。尚需血常规评估严重程度。", "急性阑尾炎"), false, "对照：缺的是严重程度");
});

await check("7.8 正在服抗凝药的、65 岁以上骨质疏松的不给推拿卡（拔罐、刮痧同样不给抗凝者）；居家按揉不受这两条约束；不服抗凝药、年轻骨质疏松照给（对照）", () => {
  const prior = { ...PRIOR_HEADACHE, overview: { ...PRIOR_HEADACHE.overview, tcmDiseaseName: "不寐", primarySyndrome: "心脾两虚证" } };
  const elder = { chiefComplaint: "夜间频醒1月", patient: { age: 82, sex: "女" }, symptoms: { 现病史: "睡眠浅，走路不稳。", 既往史: "慢性肾病、骨质疏松、房颤", 用药史: "地西泮、利伐沙班" } };
  const s = types.normalizeCaseStateInput(elder);
  assert.ok(capabilities.tcmTreatmentProjectExclusionReason("tuina", prior, s), "抗凝老人不推拿");
  assert.ok(capabilities.tcmTreatmentProjectExclusionReason("cupping", prior, s), "抗凝不拔罐");
  assert.equal(capabilities.tcmTreatmentProjectExclusionReason("tuina", prior, s, { homeCare: true }), undefined, "居家按揉照给");
  const osteo = types.normalizeCaseStateInput({ ...elder, symptoms: { ...elder.symptoms, 用药史: "地西泮" } });
  assert.ok(capabilities.tcmTreatmentProjectExclusionReason("tuina", prior, osteo), "老年骨质疏松不推拿");
  assert.equal(capabilities.tcmTreatmentProjectExclusionReason("acupuncture", prior, osteo), undefined, "对照：针刺不受影响");
  const young = types.normalizeCaseStateInput({ chiefComplaint: "失眠1月", patient: { age: 50, sex: "女" }, symptoms: { 现病史: "入睡难。", 既往史: "骨质疏松" } });
  assert.equal(capabilities.tcmTreatmentProjectExclusionReason("tuina", prior, young), undefined, "对照：50 岁");
  const stopped = types.normalizeCaseStateInput({ ...elder, patient: { age: 60, sex: "女" }, symptoms: { 现病史: "睡眠浅。", 用药史: "利伐沙班已停用半年" } });
  assert.equal(capabilities.tcmTreatmentProjectExclusionReason("tuina", prior, stopped), undefined, "对照：已停药");
});

await check("7.9 流派「部分相符」是模型的判断，交付面不再按方名改判「不适用」（第四十六轮重跑复核：改判后理由与分析自相矛盾、留下「脾肾；但…」残句）", () => {
  const reasoning = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: "郁证", primarySyndrome: "肝气郁结证", tcmDiagnosticRationale: "情志不舒、胸胁胀满为肝气郁结。丹溪看气血痰郁，本例以气郁为主，与解郁方向部分相符，以下按常规辨证处理。", recommendedFormulaNames: ["柴胡疏肝散"], recommendedFormulaDirection: "柴胡疏肝散加减" },
    lineageAdaptation: { lineageCode: "nourish-yin-danxi", label: "滋阴/丹溪思路", applicable: "partial", applicabilityReason: "丹溪重气血痰郁，本例以气郁为主；但未见阴虚火旺", influencedDecisions: [] },
    pathogenesis: { chain: [] }, therapy: { overallMethod: "疏肝解郁" }, westernDiagnosis: { primary: { name: "焦虑状态" }, differentials: [] },
  };
  const out = surface.projectDeliveredReasoning(reasoning);
  assert.equal(out.lineageAdaptation.applicable, "partial");
  assert.equal(out.lineageAdaptation.applicabilityReason, "丹溪重气血痰郁，本例以气郁为主；但未见阴虚火旺");
});

await check("7.10 查体动作后接「未诉」（「推之未诉固定」）读不通、也没有依据：交付时这一项去掉；「按压痛」「未诉口苦」照留（对照）", () => {
  assert.equal(surface.readabilityCleaned("左乳无痛性结节、推之未诉固定，为气机不畅。"), "左乳无痛性结节，为气机不畅。");
  assert.equal(surface.readabilityCleaned("推之未诉固定、质软，为痰凝。"), "质软，为痰凝。");
  assert.equal(surface.readabilityCleaned("右下腹按压痛，未诉口苦。"), "右下腹按压痛，未诉口苦。", "对照");
});

await check("7.11 西医主诊断按受控写法归一时保留「待查」（「阻塞性睡眠呼吸暂停低通气综合征待查」→「阻塞性睡眠呼吸暂停待查」）；不带待查的照旧归一（对照）", () => {
  const base = (name) => ({ overview: { tcmDiseaseName: "多寐" }, westernDiagnosis: { primary: { name }, differentials: [] }, pathogenesis: {}, therapy: {} });
  assert.equal(terminology.withCanonicalClinicalTerminology(base("阻塞性睡眠呼吸暂停低通气综合征待查")).westernDiagnosis.primary.name, "阻塞性睡眠呼吸暂停待查");
  assert.equal(terminology.withCanonicalClinicalTerminology(base("阻塞性睡眠呼吸暂停低通气综合征")).westernDiagnosis.primary.name, "阻塞性睡眠呼吸暂停", "对照");
});

await check("7.12 慢性肾脏病分期改写不动讲分期标准的句子（「尚未达到慢性肾脏病5期eGFR<15的标准」）；说本例分期的照改（对照）", () => {
  assert.equal(surface.regradedCkdStageText("eGFR 17，尚未达到慢性肾脏病5期eGFR<15的标准", "4"), "eGFR 17，尚未达到慢性肾脏病5期eGFR<15的标准");
  assert.equal(surface.regradedCkdStageText("CKD5期（eGFR<15）为透析指征", "4"), "CKD5期（eGFR<15）为透析指征");
  assert.equal(surface.regradedCkdStageText("eGFR 17，尚未达到慢性肾脏病5期标准", "4"), "eGFR 17，尚未达到慢性肾脏病5期标准", "只有前面的「达到」");
  assert.equal(surface.regradedCkdStageText("考虑慢性肾脏病5期，需复查", "4"), "考虑慢性肾脏病4期，需复查", "对照");
});

await check("7.13 方义里改药名为加字的写法（当归 → 当归尾）时，文中已写成「当归尾」的不再加字；裸写的「当归」照改（对照）", async () => {
  const forms = await jiti.import("../src/lib/herb-processing-forms.ts");
  const renames = new Map([["当归", "当归尾"]]);
  assert.equal(forms.withProcessedHerbMentions("当归尾活血通络而不伤血，助当归尾活血祛瘀", renames), "当归尾活血通络而不伤血，助当归尾活血祛瘀");
  assert.equal(forms.withProcessedHerbMentions("当归活血通络", renames), "当归尾活血通络", "对照");
});

await check("7.14 辨证依据里单独成段的病机残句（「。温煦失司；」）去掉；有内容的短句照留（对照）", () => {
  assert.equal(surface.withoutOrphanMechanismFragments("提示非湿热下注。温煦失司；舌脉未记录，暂按肾气不足考虑。"), "提示非湿热下注。舌脉未记录，暂按肾气不足考虑。");
  assert.equal(surface.withoutOrphanMechanismFragments("病位在肾；舌脉未记录；故属肾气不足证。"), "病位在肾；舌脉未记录；故属肾气不足证。", "对照");
});

await check("7.15 鉴别列举里的测得体温不改写成「未诉体温…」；病历测得体温都在界值以下时模型的「无发热」照留，不改「尚未确认」；测得过发热的不算（对照）", () => {
  const st = types.normalizeCaseStateInput({ chiefComplaint: "右膝疼痛2周", patient: { sex: "女", age: 66 }, symptoms: { 现病史: "右膝疼痛，上下楼加重。" }, vitals: { T: "36.4", P: "76", R: "18", BP: "130/80" } });
  const kept = safety.sanitizeUngroundedRedFlagNegations("无关节红肿、皮温正常，无发热（体温36.4℃）", st);
  assert.match(kept, /无发热/u, kept);
  assert.doesNotMatch(kept, /尚未确认发热/u, kept);
  const febrile = types.normalizeCaseStateInput({ chiefComplaint: "右膝红肿2天", patient: { sex: "女", age: 66 }, symptoms: { 现病史: "右膝红肿，体温最高38.6℃。" }, vitals: { T: "36.8" } });
  assert.doesNotMatch(safety.sanitizeUngroundedRedFlagNegations("无发热", febrile), /^无发热$/u, "对照：测得过 38.6℃");
  assert.equal(safety.measuredTemperatureDocumentsNoFever("体温 36.4℃", "发热"), true);
  assert.equal(safety.measuredTemperatureDocumentsNoFever("现病史：右膝疼痛", "发热"), false, "对照：没有测得体温");
});

await check("7.16 「无停经史」对病历「本次月经未按时来潮」：算写到过停经，不改成「未诉停经史」", () => {
  assert.equal(summary.unrecordedNegativesAsNotReported("多发生于月经周期后半段，无停经史，hCG阴性", "现病史：本次月经未按时来潮，下腹痛半天。"), "多发生于月经周期后半段，无停经史，hCG阴性");
  assert.equal(summary.unrecordedNegativesAsNotReported("本例无停经史", "现病史：下腹痛半天。"), "本例未诉停经史", "对照：病历没写");
});

await check("7.17 没选流派时辨证依据里模型自写的「从…学派…看」一句去掉；选了流派时本派的眼目句照留（对照）", () => {
  const base = (rationale, lineageAdaptation = null) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseName: "泄泻", primarySyndrome: "脾虚证", tcmDiagnosticRationale: rationale }, lineageAdaptation, pathogenesis: { chain: [] }, therapy: { overallMethod: "健脾益气" } });
  const text = "久泻乏力为脾气虚弱。从李东垣脾胃学派升阳益气思路看，此属脾虚气陷。";
  assert.equal(provenance.withoutForeignLineageLensSentence(base(text), "unrestricted").overview.tcmDiagnosticRationale, "久泻乏力为脾气虚弱。");
  const own = "久泻乏力为脾气虚弱。温补学派看脾肾命门，本例脾虚为主。";
  assert.equal(provenance.withoutForeignLineageLensSentence(base(own, { applicable: "partial" }), "warm-tonify").overview.tcmDiagnosticRationale, own, "对照：选了温补");
  assert.equal(provenance.withoutForeignLineageLensSentence({ ...base(text), stage: "prescribe" }, "unrestricted").overview.tcmDiagnosticRationale, text, "对照：开方阶段不动");
});

await check("7.18 「考虑X待查可能」「符合X待查」交付成「考虑X可能」；「考虑X可能」照留（对照）", () => {
  assert.equal(surface.readabilityCleaned("咳嗽2周，考虑急性支气管炎待查可能。"), "咳嗽2周，考虑急性支气管炎可能。");
  assert.equal(surface.readabilityCleaned("夜间憋醒，符合阻塞性睡眠呼吸暂停待查的表现。"), "夜间憋醒，考虑阻塞性睡眠呼吸暂停可能。");
  assert.equal(surface.readabilityCleaned("考虑急性支气管炎可能。"), "考虑急性支气管炎可能。", "对照");
});

await check("7.19 吸入剂不写「正在服用的」；「器使用方法未核实」这类说明不当药名", async () => {
  const polarity = await jiti.import("../src/lib/clinical-polarity.ts");
  assert.equal(polarity.cleanedMedicationNameCandidate("器使用方法未核实"), "");
  assert.notEqual(polarity.cleanedMedicationNameCandidate("布地奈德吸入剂"), "", "对照：药名照认");
  const line = surface.requiredPrecautionLineForTest({ kind: "current_medications", names: ["吸入性糖皮质激素", "孟鲁司特钠片"] });
  assert.match(line, /正在使用的吸入性糖皮质激素/u, line);
  assert.match(line, /正在服用的孟鲁司特钠片/u, line);
  assert.doesNotMatch(line, /正在服用的[^；]*吸入/u, line);
});

await check("7.20 M03 提示：流派部分相符时写取了什么、不写「按常规辨证处理」；不相符时照写", () => {
  const prompts = jiti.import ? null : null; void prompts;
  const text = require("node:fs").readFileSync("src/lib/diagnosis-prompts.ts", "utf8");
  assert.match(text, /部分相符时（lineageAdaptation\.applicable 为 partial）[^；]*不写“按常规辨证处理”/u);
  assert.match(text, /不相符时（not-applicable）写这一派要看什么、本例缺什么，再说以下按常规辨证处理/u);
});

await check("7.21 证候「有界」理由挪进待核实时，说的几项前面已逐项列过的不再加（「缺寒热喜恶、二便饮食，证候边界待定」）；没列过的照加、套话理由换成说影响什么（对照）", () => {
  const recordText = "现病史：肩痛3月，活动受限。\n舌象：舌淡红，苔薄白\n脉象：弦";
  const base = (reason, uncertainties) => ({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: "漏肩风", primarySyndrome: "气滞血瘀证", primarySyndromeResolution: "bounded", primarySyndromeResolutionReason: reason, primarySyndromeBasis: ["肩痛3月"], evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "低" } },
    pathogenesis: {
      locationDifferentiation: { items: ["肩"], resolution: "resolved", details: [] },
      natureDifferentiation: { items: ["气滞", "血瘀"], resolution: "resolved", details: [] },
      chain: [{ nodeId: "P1", patientFact: "肩痛3月", pathogenesis: "气滞血瘀", therapyDirection: "行气活血" }],
      uncertainties,
    },
    therapy: { overallMethod: "行气活血，通络止痛" }, westernDiagnosis: { primary: { name: "肩周炎" }, differentials: [] },
  });
  const listed = [{ item: "寒热喜恶", reason: "病历未记录，尚待核实" }, { item: "二便饮食情况", reason: "未记录，尚待核实" }];
  const out = surface.projectDeliveredReasoning(base("缺寒热喜恶、二便饮食，证候边界待定", listed), { recordText });
  assert.equal(out.pathogenesis.uncertainties.length, 2, JSON.stringify(out.pathogenesis.uncertainties));
  const fresh = surface.projectDeliveredReasoning(base("晨僵时长未记录，证候边界待定", []), { recordText });
  const added = fresh.pathogenesis.uncertainties.find((row) => /晨僵/u.test(row.item));
  assert.ok(added, JSON.stringify(fresh.pathogenesis.uncertainties));
  assert.doesNotMatch(added.reason, /证候边界/u, added.reason);
});

if (failures > 0) console.error(`\n${failures} check(s) failed`);
else console.log("\nAll r1063 main checks passed");
