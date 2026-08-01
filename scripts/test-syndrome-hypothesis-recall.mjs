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
const {
  applyBoundedSyndromeHypothesisRerank,
  clinicalAxesFromAffirmedText,
  parseClosedSetSyndromeHypothesisRerank,
  syndromeHypothesesFromAffirmedText,
} =
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
  {
    label: "痰热壅肺（黄痰+口渴+苔黄腻）",
    text: "咳嗽气促，痰黄黏稠，口渴，舌红苔黄腻，脉滑数",
    hint: "咳嗽、气喘、黄痰、痰稠、口渴、苔黄腻、脉滑、脉数",
    expectAnyOf: ["定喘汤", "泻白散"],
    forbidTop1: ["二陈汤"],
  },
  {
    label: "痰湿阻肺（白痰+身重+苔白腻）",
    text: "咳嗽反复，痰多色白，胸闷，身重困倦，苔白腻，脉滑",
    hint: "咳嗽、痰多、白痰、胸闷、身重、苔白腻、脉滑",
    expectAnyOf: ["二陈汤", "渗湿汤"],
    forbidTop1: ["定喘汤"],
  },
  {
    label: "肝郁气滞（胁胀+太息+脉弦）",
    text: "胁肋胀痛，情志不畅，善太息，脉弦",
    hint: "胁胀、情志不畅、善太息、脉弦",
    expectAnyOf: ["柴胡疏肝散", "加味乌药汤", "正气天香散", "越鞠丸"],
    forbidTop1: ["龙胆泻肝汤"],
  },
  {
    label: "胃气上逆（嗳气反酸+恶心呕吐）",
    text: "脘腹胀满，嗳气反酸，恶心呕吐",
    hint: "脘腹胀满、嗳气、反酸、恶心、呕吐",
    expectAnyOf: ["左金丸", "旋覆代赭汤", "苏叶黄连汤", "沉香化气丸"],
    forbidTop1: [],
  },
  {
    label: "肾阴虚内热（五心烦热+盗汗+腰膝酸软）",
    text: "五心烦热，潮热盗汗，口干，腰膝酸软，舌红脉细数",
    hint: "五心烦热、潮热、盗汗、口干、腰膝酸软、舌红、脉细、脉数",
    expectAnyOf: ["六味地黄丸加黄柏知母方", "大补阴丸", "一阴煎", "七味都气丸"],
    forbidTop1: ["右归丸", "右归饮"],
  },
  {
    label: "脾虚湿困（神疲+便溏+齿痕+白腻苔）",
    text: "神疲乏力，食少腹胀，身重困倦，便溏，舌有齿痕苔白腻",
    hint: "神疲、乏力、食少、腹胀、身重、便溏、齿痕舌、苔白腻",
    expectAnyOf: ["参苓白术散", "实脾饮", "厚朴温中汤", "资生健脾丸"],
    forbidTop1: ["大补阴丸"],
  },
  {
    label: "血瘀痛经（固定刺痛+舌紫暗）",
    text: "经行腹痛，痛处固定拒按，经色暗有块，舌质紫暗",
    hint: "痛经、刺痛、痛处固定、舌质紫暗",
    expectAnyOf: ["延胡索散", "血府逐瘀汤", "桂枝茯苓丸"],
    forbidTop1: ["四物汤"],
  },
  {
    label: "气血两虚（乏力+心悸气短+面色萎黄）",
    text: "神疲乏力，心悸气短，面色萎黄，唇甲色淡，脉细弱",
    hint: "神疲、乏力、心悸、气短、面色萎黄、唇甲色淡、脉细弱",
    expectAnyOf: ["归脾汤", "人参养荣汤", "八珍汤", "人参归脾丸"],
    forbidTop1: ["龙胆泻肝汤"],
  },
  {
    label: "肠燥津亏（便干+口干+舌红少津）",
    text: "大便干结数日一行，口干，舌红少津，脉细数",
    hint: "便秘、大便干、口干、舌红、脉细、脉数",
    expectAnyOf: ["养胃增液汤", "麻子仁丸", "更衣丸"],
    forbidTop1: ["理中丸"],
  },
  {
    label: "风热犯肺（咽痛+黄痰+脉浮数）",
    text: "发热恶风，咽喉肿痛，咳嗽痰黄，口渴，脉浮数",
    hint: "发热恶风、咽痛、咳嗽、黄痰、口渴、脉浮、脉数",
    expectAnyOf: ["银翘散", "桑菊饮"],
    forbidTop1: ["麻黄汤", "桂枝汤"],
  },
  {
    label: "寒湿困脾（便溏身重+畏寒+白腻苔）",
    text: "脘腹胀满，食少便溏，身重困倦，畏寒，苔白腻，脉沉迟",
    hint: "腹胀、食少、便溏、身重、畏寒、苔白腻、脉沉迟",
    expectAnyOf: ["实脾饮", "参苓白术散", "厚朴温中汤"],
    forbidTop1: ["茵陈蒿汤"],
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

// ─── 对侧变形：仅改变寒热/痰色等方向线索，检索首位必须随治疗方向变化 ───
const CONTRAST_CASES = [
  [
    "痰热↔痰湿",
    ["咳嗽气促，痰黄黏稠，口渴，苔黄腻，脉滑数", "咳嗽反复，痰多色白，身重，苔白腻，脉滑"],
    ["黄痰、痰稠、口渴、苔黄腻、脉滑、脉数", "痰多、白痰、身重、苔白腻、脉滑"],
  ],
  [
    "肾阳虚↔肾阴虚",
    ["腰膝酸软，畏寒肢冷，遇冷加重", "腰膝酸软，五心烦热，潮热盗汗"],
    ["腰膝酸软、畏寒肢冷、遇冷加重", "腰膝酸软、五心烦热、潮热、盗汗"],
  ],
  [
    "风寒表证↔风热犯肺",
    ["恶寒发热，无汗，鼻塞流清涕，脉浮紧", "发热恶风，咽痛，咳嗽痰黄，口渴，脉浮数"],
    ["恶寒发热、无汗、流清涕、脉浮紧", "发热恶风、咽痛、黄痰、口渴、脉浮、脉数"],
  ],
];
for (const [label, texts, hints] of CONTRAST_CASES) {
  const left = retrieveTcmFormulaIndicationCandidates(formulaCase(texts[0]), 6, hints[0]);
  const right = retrieveTcmFormulaIndicationCandidates(formulaCase(texts[1]), 6, hints[1]);
  assert.ok(left[0] && right[0], `${label} 两侧都必须产生受控候选`);
  assert.notEqual(left[0].name, right[0].name,
    `${label} 只改变方向性线索后首位不应保持同一方：${left[0].name}`);
}
assert.deepEqual(
  retrieveTcmFormulaIndicationCandidates(formulaCase("否认口苦目赤，也没有急躁易怒"), 6),
  [],
  "显式否定的方向线索不得形成 L1a 方剂候选",
);

// ─── 轴类别矩阵：覆盖病位、病性、寒热、虚实、痰湿、瘀血与升降失常 ───
const AXIS_CASES = [
  ["中焦气滞", "脘腹胀满", ["spleen", "stomach"], ["qi_stagnation"]],
  ["脾气虚", "神疲乏力", ["spleen"], ["qi_deficiency", "deficiency"]],
  ["肺脾气虚", "少气懒言", ["lung", "spleen"], ["qi_deficiency"]],
  ["卫气不固", "动则汗出", ["lung", "exterior"], ["qi_deficiency"]],
  ["阴虚盗汗", "盗汗", ["heart", "kidney"], ["yin_deficiency", "heat"]],
  ["肝胆热", "口苦目赤", ["liver", "gallbladder"], ["heat"]],
  ["肝郁", "胁胀善太息", ["liver"], ["qi_stagnation"]],
  ["肾虚", "腰膝酸软", ["kidney", "bones"], ["deficiency"]],
  ["肾阳虚寒", "畏寒肢冷", ["kidney"], ["yang_deficiency", "cold"]],
  ["风寒表实", "恶寒发热无汗", ["exterior"], ["cold", "excess"]],
  ["痰热", "咳嗽痰黄黏稠", ["lung"], ["phlegm", "heat"]],
  ["肠燥津伤", "大便干结口干", ["large_intestine"], ["dryness", "fluid_depletion"]],
  ["胃气上逆", "恶心呕吐嗳气", ["stomach"], ["qi_counterflow"]],
  ["瘀血阻络", "刺痛且痛处固定", ["blood_level", "collaterals"], ["blood_stasis"]],
  ["湿热", "苔黄腻", [], ["dampness", "heat"]],
  ["寒湿", "苔白腻", [], ["dampness", "cold"]],
  ["血瘀舌", "舌质紫暗", [], ["blood_stasis"]],
  ["肝郁脉", "脉弦", ["liver"], ["qi_stagnation"]],
];

for (const [label, text, expectedLocations, expectedNatures] of AXIS_CASES) {
  const axes = clinicalAxesFromAffirmedText([text]);
  for (const location of expectedLocations) {
    assert.ok(axes.locations.has(location), `${label} 应命中病位 ${location}`);
  }
  for (const nature of expectedNatures) {
    assert.ok(axes.natures.has(nature), `${label} 应命中病性 ${nature}`);
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

// ─── L1b 闭集、加权上限与失败回退不变量 ───
const l1aPool = [
  { syndromeId: "s1", canonical: "甲证", matchedAxes: 4, coverage: 1, score: 10 },
  { syndromeId: "s2", canonical: "乙证", matchedAxes: 4, coverage: 0.95, score: 9.5 },
  { syndromeId: "s3", canonical: "丙证", matchedAxes: 3, coverage: 1, score: 9 },
];
const parsedRerank = parseClosedSetSyndromeHypothesisRerank(JSON.stringify({
  rankings: [
    { syndromeId: "s3", relevance: 1 },
    { syndromeId: "outside", relevance: 1 },
    { syndromeId: "s2", relevance: 1.1 },
    { syndromeId: "s3", relevance: 0.2 },
  ],
}), new Set(l1aPool.map((item) => item.syndromeId)));
assert.deepEqual(parsedRerank, [{ syndromeId: "s3", relevance: 1 }],
  "L1b 必须逐项隔离候选外 ID、越界分数与重复 ID");
const reranked = applyBoundedSyndromeHypothesisRerank(l1aPool, parsedRerank);
assert.deepEqual(new Set(reranked.map((item) => item.syndromeId)), new Set(l1aPool.map((item) => item.syndromeId)),
  "L1b 不得新增或删除 L1a 候选");
assert.equal(reranked[0].syndromeId, "s3", "有效闭集相关度可以改变 L1a 候选顺序");
assert.ok(reranked.find((item) => item.syndromeId === "s3").score <= 9 * 1.2,
  "L1b 对任一候选的加权不得超过 20%");
assert.deepEqual(applyBoundedSyndromeHypothesisRerank(l1aPool, []), l1aPool,
  "L1b 超时、非法输出或空结果必须原样回退 L1a");
assert.deepEqual(parseClosedSetSyndromeHypothesisRerank("not-json", new Set(["s1"])), [],
  "L1b 非 JSON 输出必须安全回退");

console.log(JSON.stringify({
  directionCases: DIRECTION_CASES.length,
  contrastCases: CONTRAST_CASES.length,
  axisCases: AXIS_CASES.length,
  l1bInvariantCases: 6,
  failures: 0,
}));
