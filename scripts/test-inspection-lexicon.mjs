/**
 * Invariant: 甲方望诊字典里的每一个词，页面能点、后台能认、净化器能管——三处出自同一份数据。
 *
 * 这三件事此前由三份**各自手写**的清单分别决定，且已经双向分叉：
 *   - 页面点选项：DiagnosisClient 的 FACE/PULSE/TONGUE_PRESETS 常量
 *   - 后台识别面：clinical-state.ts 的形态学正则
 *   - 输出净化面：diagnosis-safety.ts 里把无据舌脉改写成「待核实」的正则
 *
 * 分叉的后果分两个方向，都很难解释：
 *   - 识别面漏词 ⇒ 医生在页面上点了「舌体颤动」，后台判舌象**未记录**，输出再改写成「舌象待核实」。
 *     实测甲方字典 83 个可点条目里，后台原本认不出 28 个。
 *   - 净化面漏词 ⇒ 病历里根本没有舌象、模型编出「络脉青紫」，净化器认不出来，无据舌象直接进结论。
 *
 * 所以词表被编译成生成物（scripts/build-tcm-inspection-lexicon.mjs → src/data/tcm-inspection-lexicon.json），
 * 三处共用。本文件锁住「共用」这件事本身：字典加一个词，三处必须同时生效，否则这里失败。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isUnknownClinicalFieldText } from "../src/lib/clinical-state.ts";
import {
  TCM_INSPECTION_LEXICON_META,
  inspectionLexiconGroups,
  inspectionLexiconNormal,
  isControlledInspectionTerm,
  matchedInspectionTerms,
} from "../src/lib/tcm-inspection-lexicon.ts";
import { sanitizeUngroundedRedFlagNegations } from "../src/lib/diagnosis-safety.ts";

const artifact = JSON.parse(
  readFileSync(new URL("../src/data/tcm-inspection-lexicon.json", import.meta.url), "utf8"),
);
assert.equal(artifact.schemaVersion, "tcm-inspection-lexicon-v1");
assert.ok(artifact.sourceSha256?.length === 64, "生成物必须记录源文件哈希，否则无法判断词表是否过期");

// ── 1) 每个词条都必须被后台识别为「已记录」 ──────────────────────────────────
const everyTerm = [];
for (const axis of artifact.axes) {
  const terms = [axis.normal, ...axis.groups.flatMap((group) => group.terms)];
  assert.ok(terms.length > 0, `${axis.axis} 词条为空`);
  for (const term of terms) {
    everyTerm.push([axis.field, term]);
    assert.ok(
      !isUnknownClinicalFieldText(term, axis.field),
      `字典词条「${term}」（${axis.axis}）未被后台识别——医生点得到、系统当没录`,
    );
  }
}
assert.ok(everyTerm.length >= 80, `词条数 ${everyTerm.length} 明显偏少，生成器可能只解析出部分分组`);

// ── 2) 页面点选项就是词表本身，顺序与分组一致 ────────────────────────────────
for (const axis of artifact.axes) {
  const groups = inspectionLexiconGroups(axis.field);
  assert.deepEqual(
    groups.map((group) => group.name), axis.groups.map((group) => group.name),
    `${axis.axis} 的点选分组与词表不一致——页面清单又被手写了一份`,
  );
  for (const [index, group] of groups.entries()) {
    assert.deepEqual(group.terms, axis.groups[index].terms, `${axis.axis}/${group.name} 词条与词表不一致`);
  }
  assert.equal(inspectionLexiconNormal(axis.field), axis.normal);
}
// 分叉最容易从「页面少一组」开始。舌态与舌下络脉此前整组缺失，单独钉死。
const tongueGroupNames = inspectionLexiconGroups("tongue").map((group) => group.name);
for (const name of ["舌色", "舌形", "舌态", "苔质", "苔色", "舌下络脉"]) {
  assert.ok(tongueGroupNames.includes(name), `舌象缺少分组「${name}」`);
}

// ── 3) 医生手敲的自由文本仍然要认（词表是补充，不是白名单）──────────────────
const FREE_TEXT = [
  ["舌淡红，苔薄白", "tongue"], ["舌淡红苔薄白", "tongue"], ["舌质淡，苔薄白", "tongue"],
  ["舌红少苔", "tongue"], ["舌红，苔黄燥", "tongue"], ["舌体胖大有齿痕，苔白腻", "tongue"],
  ["舌淡胖，边有齿印", "tongue"], ["舌下络脉青紫曲张", "tongue"],
  ["脉浮紧", "pulse"], ["脉细弦", "pulse"], ["脉细弱", "pulse"], ["脉虚弱", "pulse"],
  ["脉细弦无力", "pulse"], ["脉沉细无力", "pulse"], ["脉弦滑数", "pulse"],
  ["面色少华，神疲", "face"], ["面色正常。", "face"],
];
for (const [text, field] of FREE_TEXT) {
  assert.ok(
    !isUnknownClinicalFieldText(text, field),
    `自由输入「${text}」必须被识别——词表不能把手敲的写法挤掉`,
  );
}

// ── 4) 真·未采集仍须判为未记录，否则这道门形同虚设 ──────────────────────────
for (const [text, field] of [
  ["-", "tongue"], ["", "tongue"], ["舌象待核实", "tongue"], ["舌象未采集", "tongue"],
  ["脉象待核实", "pulse"], ["未查", "pulse"], ["面象待核实", "face"],
]) {
  assert.ok(
    isUnknownClinicalFieldText(text, field),
    `「${text}」没有具体望诊内容，必须仍判为未记录`,
  );
}
// 先具体、后待核实，以后者为准（原有的就近语义不得被词表破坏）。
assert.ok(isUnknownClinicalFieldText("舌体颤动；复诊时舌象待核实", "tongue"));

// ── 5) 识别面与净化面必须认同一批词 ─────────────────────────────────────────
// 病历里没有舌象/脉象时，模型写出的词表内舌脉必须被改写成「待核实」，否则无据结论直接外泄。
const noInspection = {
  id: "t", phase: "diagnose", patient: { sex: "女", age: 30 },
  chiefComplaint: "头晕1周", symptoms: {}, tongue: "", pulse: "", faceNote: "",
  vitals: {}, pastHistory: "", medicationHistory: "", allergyHistory: "",
  conversation: [{ role: "user", content: "头晕1周，没测过舌脉。" }],
  diagnosis: "", prescription: "", riskAssessment: "",
};
for (const [fabricated, expected] of [
  ["舌体颤动", "舌象待核实"], ["络脉青紫", "舌象待核实"], ["苔白如积粉", "舌象待核实"],
  ["黄白苔", "舌象待核实"], ["苔剥落", "舌象待核实"], ["平脉", "脉象待核实"],
]) {
  const sanitized = sanitizeUngroundedRedFlagNegations(fabricated, noInspection);
  assert.ok(
    !sanitized.includes(fabricated),
    `病历无望诊记录时，模型编造的「${fabricated}」必须被净化，实得 ${JSON.stringify(sanitized)}`,
  );
  assert.ok(sanitized.includes(expected), `「${fabricated}」应被改写为${expected}，实得 ${JSON.stringify(sanitized)}`);
}
// 反向：病历里确有该舌象时不得被改写。
const withInspection = { ...noInspection, tongue: "舌体颤动，苔薄白" };
assert.equal(
  sanitizeUngroundedRedFlagNegations("舌体颤动", withInspection), "舌体颤动",
  "病历已记录的舌象不得被改写成待核实",
);

// ── 6) 词条精确回读与命中报告 ───────────────────────────────────────────────
assert.ok(isControlledInspectionTerm("舌体颤动", "tongue"));
assert.ok(!isControlledInspectionTerm("舌体颤动一下", "tongue"), "精确回读不做包含匹配");
// 命中报告做包含匹配：「苔薄白」命中词表里的「苔薄」（苔质），但不命中「苔白」（苔色）——
// 后者要求「苔」紧跟「白」，而这里中间隔着「薄」。这正是包含匹配该有的粒度，
// 不要为了凑出苔色而改成分字匹配，那会让「苔薄白」同时报出一堆不存在的苔色。
assert.deepEqual(
  matchedInspectionTerms("舌淡红，苔薄白，络脉青紫", "tongue").sort(),
  ["舌淡红", "苔薄", "络脉青紫"].sort(),
);
assert.deepEqual(matchedInspectionTerms("", "tongue"), []);
assert.deepEqual(matchedInspectionTerms("腹软无压痛", "tongue"), [], "无关文本不得命中望诊词条");

console.log(JSON.stringify({
  suite: "inspection-lexicon",
  schemaVersion: TCM_INSPECTION_LEXICON_META.schemaVersion,
  termsChecked: everyTerm.length,
  freeTextChecked: FREE_TEXT.length,
  failures: 0,
}, null, 2));
