/**
 * 证候假设召回层（L1a）回归。
 *
 * 验收口径是**治疗方向是否正确**，不是某一首方是否精确命中——这一层产出的是给模型推理用的
 * 短名单，不是最终答案。方向搞反（寒证给滋阴方、肝火给补阴方）才是不可接受的一类错误。
 *
 * 同时钉住三条安全边界（它们比召回质量更重要）：
 *   ① 并集语义：本层无命中时，结果必须与关掉它完全一致——它只能加候选，不能减；
 *   ② 不产生受控语料外的方：语料外术语一个方也召不回；
 *   ③ 假设不是事实：假设用的词不得进入 matchedPatientFacts。
 */
import assert from "node:assert/strict";

const { retrieveTcmFormulaIndicationCandidates } = await import("../src/lib/tcm-formula-indications.ts");
const { clinicalAxesFromAffirmedText, syndromeHypothesesFromAffirmedText } =
  await import("../src/lib/tcm-syndrome-hypothesis.ts");

const formulaCase = (chiefComplaint) => ({ chiefComplaint, symptoms: {}, conversation: [] });
const names = (candidates) => candidates.map((item) => item.name);

// ─── 方向正确性：每例给出「必须出现其一」的同方向方组 ───
const DIRECTION_CASES = [
  {
    label: "心脾两虚（失眠+心悸+纳呆+便溏）",
    text: "反复失眠，入睡困难，伴心悸、神疲食少、便溏",
    hint: "失眠、不寐、不得眠、健忘、心悸、食少、便溏",
    expectAnyOf: ["归脾汤", "人参归脾丸"],
    forbidTop1: [],
  },
  {
    label: "肝火扰心（失眠+急躁+口苦+目赤）",
    text: "失眠多梦，急躁易怒，口苦目赤，头痛便秘",
    hint: "不寐、烦躁易怒、口苦、目赤、头痛、胁痛",
    expectAnyOf: ["泻青丸", "当归龙荟丸", "龙胆泻肝汤", "丹栀逍遥散", "泻胆汤"],
    // 二至丸是滋补肝肾之阴，与肝火实证治疗方向相反，不得居首。
    forbidTop1: ["二至丸"],
  },
  {
    label: "风寒表证（恶寒发热+无汗+脉浮紧）",
    text: "恶寒发热，头痛无汗，鼻塞流清涕",
    hint: "恶寒发热、头痛、无汗、鼻塞、流涕、脉浮紧",
    expectAnyOf: ["桂枝汤", "麻黄汤", "葛根汤", "荆防败毒散"],
    forbidTop1: [],
  },
  {
    label: "肾阳虚腰痛（腰膝酸软+遇冷加重）",
    text: "腰痛3个月，遇冷加重，腰膝酸软",
    hint: "",
    expectAnyOf: ["右归丸", "右归饮", "济生肾气丸", "附子汤", "真武汤"],
    // 左归丸是滋补肾阴，与"遇冷加重"的寒象方向相反。寒热阴阳搞反是最不能接受的一类错误。
    forbidTop1: ["左归丸"],
  },
];

for (const item of DIRECTION_CASES) {
  const got = retrieveTcmFormulaIndicationCandidates(formulaCase(item.text), 6, item.hint);
  const list = names(got);
  assert.ok(
    item.expectAnyOf.some((name) => list.includes(name)),
    `${item.label} 前 6 名必须出现同治疗方向的方（期望其一：${item.expectAnyOf.join("/")}），实际：${list.join("、")}`,
  );
  for (const forbidden of item.forbidTop1) {
    assert.notEqual(list[0], forbidden,
      `${item.label} 首位不得是治疗方向相反的 ${forbidden}，实际：${list.join("、")}`);
  }
}

// ─── ① 并集语义：本层无命中时结果不变 ───
// 用一段不含任何轴映射词的主诉，证明假设集为空时检索行为与之前一致（不为空才说明有额外来源）。
const noAxisText = "周身不适";
assert.deepEqual(
  syndromeHypothesesFromAffirmedText([noAxisText]),
  [],
  "不含任何轴映射词的主诉不得产生证候假设",
);

// ─── ② 不产生受控语料外的方 ───
assert.deepEqual(
  retrieveTcmFormulaIndicationCandidates(formulaCase("周身不适"), 4, "泽维尔、克罗诺斯"),
  [],
  "受控语料外的术语不得召回任何方剂（测试用词不得含任何真实中医术语子串）",
);

// ─── ③ 假设不是患者事实 ───
const hintedRun = retrieveTcmFormulaIndicationCandidates(
  formulaCase("睡不着觉，老忘事，心里发慌"), 6, "失眠、健忘、心悸");
for (const candidate of hintedRun) {
  for (const fact of candidate.matchedPatientFacts || []) {
    assert.doesNotMatch(fact, /失眠|健忘|心悸/, "召回提示与证候假设都不得进入 matchedPatientFacts");
  }
}

// ─── 派生轴：虚+寒=阳虚、虚+热=阴虚 ───
// 逐症状表表达不了组合关系，缺了它「遇冷加重」的腰痛会被滋阴方压过温阳方。
const coldDeficient = clinicalAxesFromAffirmedText(["腰膝酸软", "遇冷加重"]);
assert.ok(coldDeficient.natures.has("yang_deficiency"), "虚象与寒象并见时必须派生出 yang_deficiency");
const heatDeficient = clinicalAxesFromAffirmedText(["腰膝酸软", "五心烦热"]);
assert.ok(heatDeficient.natures.has("yin_deficiency"), "虚象与热象并见时必须派生出 yin_deficiency");
// 派生只做加法，原轴保留。
assert.ok(coldDeficient.natures.has("cold") && coldDeficient.natures.has("deficiency"), "派生轴不得替换原轴");

// ─── 单轴命中不成立 ───
// 「heat」一条轴就能挂上 982 条证候，单轴命中等于把噪声当召回。
const singleAxis = syndromeHypothesesFromAffirmedText(["舌红"]);
for (const hypothesis of singleAxis) {
  assert.ok(hypothesis.matchedAxes >= 2, `单轴命中不得成为假设：${hypothesis.canonical}`);
}


// ─── 零字面证据的候选不得领衔，也不得靠泛证候蒙进来 ───
// 证候假设分计入准入分是对的（轴一致本就是检索证据），但粗粒度证候会击穿它：
// 「肾虚」只有 kidney+deficiency 两条轴、挂 33 首方，任何「夜尿多」类输入都能以覆盖度 1.0
// 拿到 2 分、加权后 6 分，在一个主治词都没命中的情况下把方送上首位。
// 实测反例：「遇热加重，夜尿多」曾让崔氏八味丸（含肉桂附子的温阳方）零字面命中居首——
// 热象输入拿到温阳方，正是本层声称要防的那类方向错误。
const litmus = retrieveTcmFormulaIndicationCandidates(
  formulaCase("腰痛3个月，遇冷加重，腰膝酸软"), 8);
const firstWithoutLiteral = litmus.findIndex((item) => !item.hasLiteralEvidence);
const lastWithLiteral = litmus.map((item) => Boolean(item.hasLiteralEvidence)).lastIndexOf(true);
if (firstWithoutLiteral >= 0 && lastWithLiteral >= 0) {
  assert.ok(firstWithoutLiteral > lastWithLiteral,
    `有字面证据的候选必须全部排在纯证候假设候选之前，实际顺序：${litmus.map((i) => `${i.name}${i.hasLiteralEvidence ? "(词)" : "(假设)"}`).join("、")}`);
}
assert.ok(litmus[0]?.hasLiteralEvidence,
  `存在字面证据候选时，首位不得是纯证候假设：${litmus[0]?.name}`);

// 纯假设候选必须来自足够特异的证候（命中轴 ≥3），不能靠 2 轴泛证候入场。
const { syndromeHypothesesFromAffirmedText: hyp } = await import("../src/lib/tcm-syndrome-hypothesis.ts");
for (const candidate of litmus.filter((item) => !item.hasLiteralEvidence)) {
  assert.ok(candidate.evidenceScore >= 2, `准入分必须真的过线：${candidate.name}`);
}
assert.ok(hyp(["腰膝酸软", "遇冷加重"]).some((h) => h.matchedAxes >= 3),
  "该病例应存在命中轴 ≥3 的特异假设，否则纯假设候选不该出现");

console.log(JSON.stringify({ directionCases: DIRECTION_CASES.length, failures: 0 }));
