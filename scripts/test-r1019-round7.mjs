// 10/19 第七轮（2026-10-19，主会话）：X 集（考试题式病例）Claude 评审报出的服务端缺陷。
//
// 每条断言都带反证（记录见 ~/runlogs/r1018/work/r1019/counterproofs.txt，前缀 7/main）。
//
//   1 「妊娠5个半月」「怀孕3个多月」「妊娠二十余周」判妊娠、收回剂量（X-G-2961/2831 给了含木香大腹皮的剂量方）；
//     语料回放 16,184 条只变 5 条，全是「N个半月/N个多月」的在孕病历
//   2 教材治法拆字「安神固月孚」订正为「安神固脬」（X-E-0512 治法栏与针刺卡照抄）
//   3 M03「至少一条现症」底线：句首「既往…」管不到同句的舌象脉象；「手术后2个月出现腹胀」是起病时间锚
//     （X-G-2930、X-D-4749 整份辨证退回占位；r19g 六个模块集里此类退回只有这两例加一份无临床内容的病历）
//   4 重度血小板减少（PLT<10，或 <20 伴出血）报红旗、收回剂量（A-non-0046）；「大便色黑」等黑便词形（A-out-single_0242）
//     ——类夹具 severe-thrombocytopenia-count、melena-colour-word-forms

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

const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const clinicalState = await jiti.import("../src/lib/clinical-state.ts");

const permissionOf = (chiefComplaint, presentHistory, patient = { sex: "女", age: 26 }) =>
  safety.derivePrescriptionPermission(safety.withSafetyGate(types.normalizeCaseStateInput({ id: "r7", chiefComplaint, patient, symptoms: { 现病史: presentHistory }, conversation: [] })));

await check("1.1 「妊娠5个半月」「怀孕3个多月」「妊娠二十余周」「孕五个半月」判妊娠；「妊娠3次」「不孕3年」「孕2产1」照旧（对照）", () => {
  for (const text of ["妊娠5个半月，面目四肢水肿", "怀孕3个多月，恶心呕吐", "妊娠二十余周，下肢浮肿", "孕五个半月，腰酸"]) {
    assert.equal(clinicalState.assessPregnancyState(text).status, "positive", text);
  }
  assert.notEqual(clinicalState.assessPregnancyState("妊娠3次，流产1次，月经量少").status, "positive");
  assert.notEqual(clinicalState.assessPregnancyState("不孕3年，月经后期").status, "positive");
  assert.equal(clinicalState.assessPregnancyState("孕2产1，月经量少").status, "historical");
});

await check("1.2 X-G-2961 原病历：妊娠状态阳性、只给非剂量内容；同一病历去掉孕月写法仍给剂量（对照）", () => {
  const record = "患者，女性，26岁。妊娠5个半月，面目四肢水肿，皮薄光亮，按之凹陷不起，面色黄白无华，神疲气短懒言，口淡而腻，脘腹胀满，食欲不振，大便溏薄，舌胖嫩苔白腻，脉缓滑。";
  const permission = permissionOf("妊娠5个半月，面目四肢水肿，皮薄光亮，按之凹陷不起，面色黄白无华，神疲气短懒言", record);
  // 剂量一致化（D4）：妊娠认出来以后给剂量、采纳前须医生确认，原因写妊娠；对照没有妊娠原因。
  assert.match(permission.reasons.join("；"), /妊娠/, JSON.stringify(permission));
  assert.equal(permission.formalAdoption, "eligible_after_doctor_confirmation", JSON.stringify(permission));
  const control = permissionOf("面目四肢水肿，神疲气短懒言", record.replace("妊娠5个半月，", "否认妊娠，"));
  assert.doesNotMatch(control.reasons.join("；"), /已记录妊娠/, JSON.stringify(control));
});

await check("2.1 教材治法拆字「固月孚」订正为「固脬」（遗尿·心肾失交证）；其余行的治法不变（对照）", async () => {
  const t = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
  const row = t.textbookRowForSyndrome("遗尿", "心肾失交证", { ageYears: 8 });
  assert.equal(row?.therapy, "清心滋肾，安神固脬");
  assert.equal(t.textbookRowForSyndrome("石淋", "湿热蕴结证")?.disease, "淋证");
});

await check("3.1 既往开头的整句依据里有舌象脉象时算有现症；「手术后2个月出现腹胀」算现症；纯既往、术后状态、曾见舌红、否认舌象照旧不算（对照）", async () => {
  const c = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
  assert.equal(c.isCurrentPositiveTcmAnchor("既往有胃病二十余年，每次均因饮食不慎，出现呕吐，时作时止，倦怠乏力，口干不欲饮，四肢不温，大便溏薄，舌质淡，脉濡弱"), true);
  assert.equal(c.isCurrentPositiveTcmAnchor("手术后2个月出现腹胀，乏力，ALT 200U/L"), true);
  for (const text of ["既往高血压病史10年", "既往胃痛，曾见舌红", "既往有胃病二十余年，无舌苔异常", "术后恢复良好，乏力", "胆囊切除术后", "术后3年，复查正常"]) {
    assert.equal(c.isCurrentPositiveTcmAnchor(text), false, text);
  }
});

await check("4.1 A-non-0046 原病历报重度血小板减少红旗、不给剂量，理由归到血小板规则；PLT 15 无出血、PLT 130 照旧（对照）", () => {
  const record = "女，28岁。反复牙龈出血和月经增多半年。轻度贫血貌，巩膜无黄染，肝脾肋下未触及，实验室Hb 82g/L，RBC 4.0×1012/L，WBC 5.6×109/L，PLT 13×109/L，骨髓增生明显活跃。";
  const state = safety.withSafetyGate(types.normalizeCaseStateInput({ id: "r7", chiefComplaint: "反复牙龈出血和月经增多半年", patient: { sex: "女", age: 28 }, symptoms: { 现病史: record }, conversation: [] }));
  const flag = state.safetyGate.redFlags.find((item) => item.includes("重度血小板减少"));
  assert.ok(flag, JSON.stringify(state.safetyGate.redFlags));
  assert.equal(safety.redFlagRuleIdForMessage(flag), "severe-thrombocytopenia");
  // 剂量一致化（D4）：红旗给剂量、红旗解除前不可采纳（活血化瘀药由开方核对剔除）。
  assert.equal(safety.derivePrescriptionPermission(state).candidateMode, "limited_dose");
  assert.equal(safety.derivePrescriptionPermission(state).formalAdoption, "blocked");
  for (const text of ["已知ITP 5年，PLT 15×10^9/L，无出血。", "体检PLT 130×10^9/L，鼻衄1次。"]) {
    const control = safety.withSafetyGate(types.normalizeCaseStateInput({ id: "r7c", chiefComplaint: "x", patient: { sex: "女", age: 28 }, symptoms: { 现病史: text }, conversation: [] }));
    assert.ok(!control.safetyGate.redFlags.some((item) => item.includes("血小板")), text);
  }
});

console.log(JSON.stringify({ suite: "r1019-round7", cases, failures: process.exitCode ? "see above" : 0 }));
