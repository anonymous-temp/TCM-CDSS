/**
 * 「字段槽里有没有记录舌/脉」与「自由文本里能不能认出舌脉」是两个不同的问题。
 *
 * 2026-08-26 外部基准实测（TCM-BEST4SDT 8 例、TCM-SD 若干例）：医生把脉象写成转述式
 * （「左手脉象细长而紧张」「脉搏紧绷且振幅大」「脉跳得又快又硬」）时，后台判**脉象未采集**
 * → 缺项 pulse_unknown → 完整度压到 B → 辨证被降级成「症状级工作判断」。
 * 根因不是词表漏词，而是**一个谓词在回答两个问题**：门禁问的是「这一栏医生填了没有」，
 * 它却按「写法是不是标准脉名」作答。标准脉名映射对第二个问题（净化器要在一段自由文本里
 * 找出被编造的舌脉）是必需的，对第一个问题毫无必要——字段本身就是锚点。
 *
 * 于是拆成两个谓词：
 *   · isUnrecordedInspectionFieldValue —— 字段槽语义：非空且不是「未取得」声明即算已记录；
 *   · isUnknownClinicalFieldText —— 自由文本识别，保持形态学∪受控词表的严格口径（净化器用）。
 * 「后写的未取得声明推翻先前内容」这一既有语义（舌淡红…，舌象待核实 ⇒ 未记录）两边都保留。
 */
import assert from "node:assert/strict";
import { isUnknownClinicalFieldText, isUnrecordedInspectionFieldValue } from "../src/lib/clinical-state.ts";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const { hasObtainedPulseFinding, hasObtainedTongueFinding, evaluateSafetyGate, sanitizeUngroundedRedFlagNegations } = await jiti.import("../src/lib/diagnosis-safety.ts");

const failures = [];
const check = (name, fn) => { try { fn(); } catch (error) { failures.push({ name, message: error?.message || String(error) }); } };

// ── 字段槽语义：转述式脉象/舌象必须算已记录 ────────────────────────────────────
check("转述式脉象算已记录", () => {
  for (const value of [
    "左手脉象细长而紧张，右手脉象滑利",
    "脉搏紧绷且振幅大",
    "脉跳得又快又硬",
    "脉来一息六至偏快",
    "脉弦",
    "脉细弦无力",
    "细弦",
  ]) {
    assert.equal(isUnrecordedInspectionFieldValue(value, "pulse"), false, `脉象字段「${value}」应算已记录`);
  }
});
check("转述式舌象算已记录", () => {
  for (const value of [
    "舌苔厚腻微黄",
    "舌头胖大边上有牙印",
    "舌面裂纹明显、颜色偏暗",
    "舌淡红，苔薄白",
    "淡红舌薄白苔",
  ]) {
    assert.equal(isUnrecordedInspectionFieldValue(value, "tongue"), false, `舌象字段「${value}」应算已记录`);
  }
});

// ── 反证：真正的「未取得」仍必须判未记录 ──────────────────────────────────────
check("未取得声明仍判未记录", () => {
  for (const [value, field] of [
    ["", "pulse"], ["   ", "pulse"], ["脉象", "pulse"], ["舌", "tongue"], ["苔", "tongue"],
    ["脉象待核实", "pulse"], ["舌象待核实", "tongue"], ["未查", "pulse"], ["未做", "pulse"],
    ["不详", "pulse"], ["未提供", "tongue"], ["无法判断", "tongue"], ["脉象未采集", "pulse"],
    ["舌象未知", "tongue"], ["见附图", "tongue"], ["暂缺", "pulse"],
  ]) {
    assert.equal(isUnrecordedInspectionFieldValue(value, field), true, `「${value}」应判未记录`);
  }
});
// 跨栏污染：栏位里夹着别栏内容（用药/主诉）不算本栏已记录——这条钉子来自
// test-clinical-grounding 的 crossFieldUnknownTongue，本次实现一度把它判反。
check("跨栏污染不算本栏已记录", () => {
  assert.equal(isUnrecordedInspectionFieldValue("舌象待核实，现服阿司匹林100mg每日一次", "tongue"), true);
  assert.equal(isUnrecordedInspectionFieldValue("脉象待核实，患者诉睡眠差", "pulse"), true);
  assert.equal(isUnrecordedInspectionFieldValue("现服阿司匹林100mg每日一次", "tongue"), true,
    "纯别栏内容没有本栏锚字，不能顶替本栏记录");
  // 锚字的非望诊用法同样不算：舌下含服是给药途径，静脉曲张不是脉象。
  assert.equal(isUnrecordedInspectionFieldValue("舌下含服速效救心丸后缓解", "tongue"), true);
  assert.equal(isUnrecordedInspectionFieldValue("双下肢静脉曲张", "pulse"), true);
  // 但先污染、后补录本栏内容 ⇒ 已记录。
  assert.equal(isUnrecordedInspectionFieldValue("舌象待核实，现服阿司匹林；补录舌淡红苔薄白", "tongue"), false);
});
check("后写的未取得声明推翻先前内容", () => {
  assert.equal(isUnrecordedInspectionFieldValue("舌淡红苔薄白，舌象待核实", "tongue"), true);
  assert.equal(isUnrecordedInspectionFieldValue("脉弦；脉象待核实", "pulse"), true);
  // 反向顺序：先声明未取得、后补录具体内容 ⇒ 已记录。
  assert.equal(isUnrecordedInspectionFieldValue("舌象待核实，补录：舌淡红苔薄白", "tongue"), false);
});

// ── 自由文本识别面不受影响（净化器的编造防御口径不动）──────────────────────
check("自由文本严格识别保持原口径", () => {
  assert.equal(isUnknownClinicalFieldText("脉弦", "pulse"), false, "标准脉名仍被自由文本面识别");
  assert.equal(isUnknownClinicalFieldText("脉细弦无力", "pulse"), false);
  assert.equal(isUnknownClinicalFieldText("舌淡红，苔薄白", "tongue"), false);
  // 病历里没有可识别舌脉时，净化器必须继续认定「无据」——这是编造防御，不能因本次放宽而失效。
  assert.equal(isUnknownClinicalFieldText("患者诉乏力，纳可，二便调", "pulse"), true);
  assert.equal(isUnknownClinicalFieldText("患者诉乏力，纳可，二便调", "tongue"), true);
  assert.equal(isUnknownClinicalFieldText("舌下含服速效救心丸后缓解", "tongue"), true,
    "「舌下含服」是给药途径，不是舌象记录");
});

// ── 门禁：转述式四诊不再产生 tongue_unknown / pulse_unknown ────────────────────
const baseCase = {
  id: "field-slot-gate",
  phase: "diagnose",
  patient: { sex: "女", age: 45 },
  chiefComplaint: "反复关节疼痛2年",
  symptoms: { presentHistory: "2年前起双膝关节疼痛，遇冷加重，活动后稍缓解。" },
  vitals: "",
  pastHistory: "既往体健。",
  medicationHistory: "否认长期服药。",
  allergyHistory: "否认药物及食物过敏史。",
  conversation: [],
  questionRounds: 1,
  maxQuestionRounds: 1,
  diagnosis: "",
  prescription: "",
  riskAssessment: "",
};
check("门禁对转述式四诊不再报未采集", () => {
  const gate = evaluateSafetyGate({
    ...baseCase,
    tongue: "舌头胖大边上有牙印",
    pulse: "脉跳得又快又硬",
  });
  assert.ok(!(gate.missingItemCodes || []).includes("tongue_unknown"), JSON.stringify(gate.missingItemCodes));
  assert.ok(!(gate.missingItemCodes || []).includes("pulse_unknown"), JSON.stringify(gate.missingItemCodes));
});
check("门禁对真正缺四诊仍报未采集", () => {
  const gate = evaluateSafetyGate({ ...baseCase, tongue: "", pulse: "脉象待核实" });
  assert.ok((gate.missingItemCodes || []).includes("tongue_unknown"), JSON.stringify(gate.missingItemCodes));
  assert.ok((gate.missingItemCodes || []).includes("pulse_unknown"), JSON.stringify(gate.missingItemCodes));
});
check("单一谓词：hasObtained* 与字段槽判据同答案", () => {
  const state = { ...baseCase, tongue: "舌面裂纹明显、颜色偏暗", pulse: "左手脉象细长而紧张" };
  assert.equal(hasObtainedTongueFinding(state), !isUnrecordedInspectionFieldValue(state.tongue, "tongue"));
  assert.equal(hasObtainedPulseFinding(state), !isUnrecordedInspectionFieldValue(state.pulse, "pulse"));
});

// ── 呈现面：识别面与门禁面必须同答案（本仓头号缺陷形状的第 N 次复发点）────────────
// 医生把脉象写成转述式时，门禁已判「已记录」；净化面若仍按自由文本严格口径判「无据」，
// 就会把模型据此写出的脉象改写成「脉象待核实」，页面上出现「已录入却说待核实」。
check("字段已记录转述式脉象时，净化器不再改写模型脉象", () => {
  const state = { ...baseCase, tongue: "舌头胖大边上有牙印", pulse: "脉跳得又快又硬" };
  const output = sanitizeUngroundedRedFlagNegations("辨证依据：脉弦数，舌淡红苔薄白。", state);
  assert.ok(!output.includes("脉象待核实"), `不应改写脉象：${output}`);
  assert.ok(!output.includes("舌象待核实"), `不应改写舌象：${output}`);
});
check("病历确无舌脉时，编造防御仍然生效", () => {
  const state = { ...baseCase, tongue: "", pulse: "" };
  const output = sanitizeUngroundedRedFlagNegations("辨证依据：脉弦数，舌淡红苔薄白。", state);
  assert.ok(output.includes("脉象待核实"), `无据脉象必须改写：${output}`);
  assert.ok(output.includes("舌象待核实"), `无据舌象必须改写：${output}`);
});
check("字段写着待核实时同样按无据处理", () => {
  const state = { ...baseCase, tongue: "舌象待核实", pulse: "脉象待核实" };
  const output = sanitizeUngroundedRedFlagNegations("辨证依据：脉弦数，舌淡红苔薄白。", state);
  assert.ok(output.includes("脉象待核实") && output.includes("舌象待核实"), output);
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "inspection-field-slot", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "inspection-field-slot", checks: 11, failures: 0 }));
