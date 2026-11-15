// 第四十七轮（2026-11-15）主会话：PLAN 阶段 0 的安全层三项（工作包 herb/mods/dx 与三道总闸各有自己的套件）。
//  1. 「颅内出血未排除、活血化瘀药不入方」只认脑部表现：马尾综合征的会阴麻木、双下肢无力不算（第四十六轮复核 C042）。
//  2. 红旗是低血糖时，饮食句写立即进糖（不与「立即吃含糖食物」相反，C032）。
//  3. 血证分型读「大便…色黑发亮」一类写法（new45-n03 交付成「血证」）。
// 每条断言都有反证（~/runlogs/r1018/work/r1064/cp/main.py）。
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
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");

let serial = 0;
const state = (chiefComplaint, history, extra = {}) => types.normalizeCaseStateInput({
  id: `r1064-${(serial += 1)}`,
  chiefComplaint,
  patient: { sex: extra.sex || "男", age: extra.age ?? 40 },
  symptoms: { 现病史: history, ...(extra.symptoms || {}) },
  vitals: extra.vitals || {},
  tongue: extra.tongue || "",
  pulse: extra.pulse || "",
});
const flags = (input) => safety.detectProgrammaticRedFlags(input);

await check("1.1 马尾综合征（腰痛、会阴麻木、双下肢无力、排尿困难）报神经急症红旗，但不算颅内出血未排除，活血化瘀药照常可用", () => {
  const cauda = state("腰痛3天，双下肢无力1天", "3天前搬重物后腰痛，昨日开始会阴部麻木，今日两下肢无力加重、步行困难，尿意不明显且排尿困难。", { age: 45 });
  const list = flags(cauda);
  assert.ok(list.some((flag) => /神经系统急症/u.test(flag)), JSON.stringify(list));
  const text = safety.trustedInputText(cauda);
  assert.equal(safety.cerebralNeurologicSignPresent(text), false);
  assert.equal(safety.intracranialHemorrhageNotExcluded(text, list), false);
  assert.equal(contract.herbBarredForCase("川芎", safety.clinicalGroundingText(cauda)), false);
});

await check("1.2 对照：单侧肢体无力伴言语不清、雷击样头痛、意识改变仍算颅内出血未排除；影像已排除出血的不算", () => {
  const stroke = state("右侧肢体无力2小时", "今日突然右侧肢体无力，言语不清。", { age: 70, symptoms: { 辅助检查: "未行头颅影像检查" } });
  assert.equal(safety.intracranialHemorrhageNotExcluded(safety.trustedInputText(stroke), flags(stroke)), true);
  const limbOnly = state("左下肢无力半天", "今晨起突然左下肢无力，行走拖步。", { age: 68, symptoms: { 辅助检查: "未做" } });
  assert.equal(safety.cerebralNeurologicSignPresent(safety.trustedInputText(limbOnly)), true, "单侧下肢急性无力也是脑部表现");
  const sah = state("突发剧烈头痛2小时", "运动中突然发生生平最严重头痛，伴呕吐。", { sex: "女", age: 45 });
  assert.equal(safety.intracranialHemorrhageNotExcluded(safety.trustedInputText(sah), flags(sah)), true);
  assert.equal(safety.cerebralNeurologicSignPresent("今日突然四肢无力，言语不清，口角歪斜"), true, "「无力」的「无」不把逗号后的言语不清读成否认");
  const imaged = state("右侧肢体无力2小时", "今日突然右侧肢体无力，言语不清。", { age: 71, symptoms: { 辅助检查: "头颅CT示左侧基底节区腔隙性脑梗死，未见出血" } });
  assert.equal(safety.intracranialHemorrhageNotExcluded(safety.trustedInputText(imaged), flags(imaged)), false);
});

await check("1.3 双下肢无力伴鞍区麻木不算脑部表现；否认的单侧无力也不算", () => {
  assert.equal(safety.cerebralNeurologicSignPresent("腰痛伴鞍区麻木，双下肢无力2天，大小便失禁"), false);
  assert.equal(safety.cerebralNeurologicSignPresent("头晕1天，无左侧肢体无力，无言语不清"), false);
});

const redFlagPrescription = () => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  nonPharma: { diet: "饮食清淡，少量多餐。", exercise: "适当散步。", precautions: ["饭后温服。", "如出现心慌出汗立即吃含糖食物。"] },
});
await check("2.1 红旗是低血糖（血糖 2.4）时饮食写立即进糖与复测，不写「就医前饮食遵急诊医生安排」", () => {
  const record = "主诉：心慌、出汗、手抖1小时\n现病史：服格列本脲后出现心慌、出汗、手抖，指尖血糖2.4mmol/L。";
  const projected = surface.projectDeliveredReasoning(redFlagPrescription(), { doseWithheld: "red_flag", recordText: record });
  assert.equal(projected.nonPharma.diet, surface.RED_FLAG_HYPOGLYCEMIA_DIET_ADVICE);
  assert.ok(/立即吃含糖食物/u.test(projected.nonPharma.diet) && !/遵急诊医生安排/u.test(projected.nonPharma.diet));
});
await check("2.2 对照：别的红旗仍写先急诊；血糖正常的糖尿病病历不算低血糖", () => {
  const record = "主诉：胸痛2小时\n现病史：突发胸骨后压榨样疼痛2小时，伴大汗。既往糖尿病，空腹血糖6.2mmol/L。";
  const projected = surface.projectDeliveredReasoning(redFlagPrescription(), { doseWithheld: "red_flag", recordText: record });
  assert.equal(projected.nonPharma.diet, surface.RED_FLAG_DIET_ADVICE);
});

await check("3.1 血证按「大便…色黑发亮」定为便血型；主语不是大便的不算", () => {
  const record = "主诉：乏力、头晕3天\n现病史：近3天大便每日1～2次，色黑发亮、质软成形，伴心慌、出冷汗。无呕血。";
  assert.equal(textbook.diseaseNameWithRecordSubtype("血证", record), "血证（便血）");
  assert.equal(textbook.diseaseNameWithRecordSubtype("血证", "主诉：乏力\n现病史：面部皮肤色黑发亮，无出血。"), "血证");
});
await check("3.2 新补的便血写法（大便发黑）；否认的不算", () => {
  assert.equal(textbook.diseaseNameWithRecordSubtype("血证", "主诉：乏力1周\n现病史：近1周大便发黑，伴头晕。"), "血证（便血）");
  assert.equal(textbook.diseaseNameWithRecordSubtype("血证", "主诉：鼻出血2天\n现病史：鼻出血2天，无大便发黑。"), "血证（鼻衄）");
});
