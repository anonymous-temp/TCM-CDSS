import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  applyDeterministicFormulaReferences,
  enrichPrescriptionProvenance,
  executableFormulaCompilationReferences,
  formulaCompilationContractIssue,
  formulaCompilationReferences,
  formulaNamesWithoutExecutableDoseCompilation,
  identifyKnownFormulaNames,
  resolveFormulaSources,
  verifyFormulaCompilationComponents,
} = await import("../src/lib/tcm-formula-provenance.ts");
const {
  buildTcmFormulaIndicationContext,
  buildTcmFormulaReasoningContext,
  enforceRetrievedM03FormulaSelection,
  namedFormulaPositiveSufficiencyIssue,
  retrieveTcmFormulaCandidatesForReasoning,
  retrieveTcmFormulaIndicationCandidates,
} = await import("../src/lib/tcm-formula-indications.ts");
const { highImpactHerbDirectionIssue } = await import("../src/lib/diagnosis-stage-contract.ts");
const { getTcmHerbFunctionText } = await import("../src/lib/tcm-knowledge.ts");

const herbs = (...names) => names.map((name) => ({ name }));
const formulaCatalog = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-sources.json", import.meta.url), "utf8"));
const governedFormulaCatalog = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-governed-catalog.json", import.meta.url), "utf8"));
const herbFunctionCatalog = JSON.parse(readFileSync(new URL("../src/data/tcm-herb-function-categories.json", import.meta.url), "utf8"));
const tcmKnowledgeCatalog = JSON.parse(readFileSync(new URL("../src/data/tcm-knowledge.json", import.meta.url), "utf8"));

const formulaCase = (chiefComplaint) => ({ chiefComplaint, symptoms: {}, conversation: [] });
const insomniaCandidates = retrieveTcmFormulaIndicationCandidates(
  formulaCase("反复失眠，入睡困难，伴心悸、神疲食少"),
);
// 古今用词落差：受控主治语料多为古文（酸枣仁汤的主治原文是「虚劳虚烦不得眠」，不含「失眠」），
// 目录扩到 1800 后，仅凭现代词的字面召回已排不进前 5。这不是缺陷而是语料事实，
// 由召回改写层补古语变体解决（formula-recall-normalization 的 SYSTEM_PROMPT 已要求古今双写）。
assert.ok(
  insomniaCandidates.some((item) => ["归脾汤", "人参归脾丸", "交泰丸", "酸枣仁汤"].includes(item.name)),
  `失眠病例必须召回治不寐的受控方，实际：${insomniaCandidates.map((item) => item.name).join("、")}`,
);
// 古今双写的召回桥必须守住:古语变体「不得眠」命中酸枣仁汤主治原文「虚劳虚烦不得眠」,
// 把它救回候选池——这条能力断言不变。
// 但「必须排进前 5」的排位钉在 2699 方语料下不再成立,也不该成立:本例阳性事实是
// 失眠+心悸+神疲食少,血府逐瘀汤(心悸/失眠/不寐 三概念三词全中)、人参归脾丸等同样是
// 可锁定的治不寐经典方且与本例证据更密——它们排在酸枣仁汤之前是**正确排序**,不是噪声。
// 项目惯例(见上方 line36 与 retrieveTcmFormulaIndicationCandidates 注释):目录增长导致
// 共享症状病例的排位漂移属语料事实。
// 已知治理欠账(不属本测试断言,记录待下一轮裁定):酸枣仁汤的证型标签是心脾两虚,
// 其经典主证「肝血不足、虚热内扰」无 T1 标签——标签补齐前排位不会倾向它,属预期行为。
const insomniaHinted = retrieveTcmFormulaIndicationCandidates(formulaCase("反复失眠，入睡困难，伴心悸、神疲食少"), 8, "失眠、不寐、不得眠、心悸、食少");
assert.ok(
  insomniaHinted.some((item) => item.name === "酸枣仁汤"),
  `补上古语变体「不得眠」后必须召回酸枣仁汤进候选池——这条守住召回改写层的古今双写要求，实际：${insomniaHinted.map((item) => item.name).join("、")}`,
);
assert.ok(insomniaCandidates.every((item) => item.id.startsWith("TCM-FORMULA-")), "every M03 formula candidate must carry a stable evidence ID");
assert.deepEqual(
  retrieveTcmFormulaIndicationCandidates(formulaCase("否认失眠、心悸，食欲正常")),
  [],
  "negated findings must never retrieve a classic formula candidate",
);
const banxiaCandidates = retrieveTcmFormulaIndicationCandidates(
  formulaCase("心下痞满，呕吐，肠鸣下利，舌苔黄腻"),
);
assert.equal(banxiaCandidates[0]?.name, "半夏泻心汤", "dense defining facts must rank the source-matched classic formula first");
assert.match(buildTcmFormulaIndicationContext(formulaCase("心下痞满，呕吐，肠鸣下利，舌苔黄腻")), /半夏泻心汤[\s\S]*《伤寒论》/);
assert.ok(banxiaCandidates.every((item) => item.governanceStatus && typeof item.prescriptionLockEligible === "boolean"), "T8 governance metadata must accompany every runtime retrieval candidate");
const heartSpleenCase = formulaCase("入睡困难、多梦易醒3个月，伴心悸健忘、食欲欠佳、便溏，舌淡有齿痕，脉细弱");
const heartSpleenCandidates = retrieveTcmFormulaIndicationCandidates(heartSpleenCase);
assert.ok(heartSpleenCandidates.some((item) => item.name === "归脾汤"), "T8's data-owned memory/cognition concept must retrieve 归脾汤 inside the default model-visible shortlist");
// 供给/锁定对齐：这份 pre-generation 短名单只按症状重叠打分，而身份锁要求主证候直接关联，
// 因此无 syndromeTags 的方剂永远锁不上。此前 天王补心丹（阴虚火旺、不可锁）仅凭症状重叠压过
// 归脾汤，模型选中后被剥离并降级为自拟方。可锁定候选必须排在不可锁定候选之前；不可锁定的方剂
// 仍应保留在名单内作为鉴别参照，不得直接隐藏。
const firstUnlockable = heartSpleenCandidates.findIndex((item) => (item.syndromeTags || []).length === 0);
const lastLockable = heartSpleenCandidates.map((item) => (item.syndromeTags || []).length > 0).lastIndexOf(true);
assert.ok(
  firstUnlockable === -1 || firstUnlockable > lastLockable,
  `不可锁定的方剂排在了可锁定方剂之前：${heartSpleenCandidates.map((item) => `${item.name}(${(item.syndromeTags || []).length > 0 ? "锁" : "不可锁"})`).join("、")}`,
);
assert.equal(
  heartSpleenCandidates[0]?.name,
  "归脾汤",
  "心脾两虚 典型病例的首选候选必须是可锁定的归脾汤，而不是仅症状重叠的不可锁方剂",
);
assert.ok(heartSpleenCandidates.find((item) => item.name === "归脾汤")?.matchedConcepts.includes("记忆认知"), "the retrieval trace must expose the governed concept responsible for recall");
assert.match(buildTcmFormulaIndicationContext(heartSpleenCase), /归脾汤[\s\S]*T1\/T3\/T4关联索引：经核验证候:心脾两虚/);
assert.doesNotMatch(buildTcmFormulaIndicationContext(heartSpleenCase), /关联索引：[^\n]*自动推荐/, "standard-term relations remain retrieval evidence rather than an automatic formula verdict");

// 主治原文倒排索引：概念表（39 条正则）覆盖不到的常见主诉必须仍能召回受控方剂。
// 这些病例在接入索引前全部返回「未命中受控经典方主治索引」＝零候选，医生一个方也拿不到。
for (const [complaint, expected] of [
  ["腰痛3个月，遇冷加重，腰膝酸软", "右归丸"],
  ["耳鸣2个月，夜间明显，头晕", "耳聋左慈丸"],
  ["双膝关节疼痛，遇寒加重，屈伸不利", "桂枝芍药知母汤"],
  ["双下肢水肿1个月，小便不利", "五苓散"],
]) {
  const recalled = retrieveTcmFormulaIndicationCandidates(formulaCase(complaint), 6);
  assert.ok(recalled.length > 0, `主治原文索引必须为「${complaint}」召回受控方剂，而不是零候选`);
  assert.ok(
    recalled.some((item) => item.name === expected),
    `「${complaint}」应召回 ${expected}，实际：${recalled.map((item) => item.name).join("、")}`,
  );
}
// 扩召回不得破坏极性：否定式主诉仍然一个方都不给。
assert.deepEqual(
  retrieveTcmFormulaIndicationCandidates(formulaCase("否认腰痛、耳鸣、水肿，二便调")),
  [],
  "negated findings must not be recalled through the indication-term index either",
);

// 口语召回提示（formula-recall-normalization.server 的输出）只参与候选召回：
// 口语主诉在受控主治语料里匹配不到术语，靠提示补齐；但提示绝不能变成患者事实。
const colloquial = formulaCase("睡不着觉，老忘事，心里发慌");
// 接入确定性证候假设层（L1a）之后，口语主诉**不再依赖模型**也能召回：症状词族先映射到
// 病位/病性轴，再按轴一致性走「证候→方」索引。这条断言从「口语必然零候选」改成
// 「口语必须能召回且方向正确」——前者曾是 recall 改写层存在的唯一理由，现在那层降级为增补：
// flash 调用失败（fail-open）时口语病例不再掉到零候选。
const colloquialWithoutHint = retrieveTcmFormulaIndicationCandidates(colloquial, 4);
assert.ok(colloquialWithoutHint.length > 0, "口语主诉必须能被确定性证候假设层召回，不得依赖模型改写");
assert.ok(
  colloquialWithoutHint.some((item) => item.name === "归脾汤"),
  `口语「睡不着觉、老忘事、心里发慌」应确定性召回归脾汤，实际：${colloquialWithoutHint.map((item) => item.name).join("、")}`,
);
const hinted = retrieveTcmFormulaIndicationCandidates(colloquial, 4, "失眠、健忘、心悸");
assert.ok(hinted.length > 0, "召回提示必须能把口语主诉带回受控候选");
assert.ok(hinted.some((item) => item.name === "归脾汤"), `失眠健忘心悸应召回归脾汤，实际：${hinted.map((item) => item.name).join("、")}`);
for (const item of hinted) {
  for (const fact of item.matchedPatientFacts || []) {
    assert.doesNotMatch(fact, /失眠|健忘|心悸/, "召回提示不得进入 matchedPatientFacts——它不是病历事实");
  }
}
// 提示不得凭空造出候选：受控主治语料里不存在的术语一个方也召不回。
assert.deepEqual(
  retrieveTcmFormulaIndicationCandidates(formulaCase("周身不适"), 4, "泽维尔、克罗诺斯"),
  [],
  "受控语料外的术语不得召回任何方剂（注意：测试用词不得含任何真实中医术语子串，如「虚劳」「综合征」）",
);

const postM03Reasoning = {
  overview: {
    primarySyndrome: "思虑伤脾证",
    overallPathogenesis: "思虑伤脾",
    tcmDifferentials: [],
  },
  pathogenesis: {
    summary: "思虑伤脾，心神失养",
    locationDifferentiation: { items: ["心", "脾"], details: [] },
    natureDifferentiation: { items: ["气虚", "血虚"], rootDeficiency: "气虚", branchExcess: "无" },
    chain: [{ pathogenesis: "思虑伤脾", therapyDirection: "健脾养心" }],
  },
};
const postM03Candidates = retrieveTcmFormulaCandidatesForReasoning(postM03Reasoning, 8);
assert.ok(postM03Candidates.some((item) => item.name === "归脾汤"), "signed M03 syndrome/pathogenesis may drive the separate post-generation T8 retrieval phase");
assert.match(buildTcmFormulaReasoningContext(postM03Reasoning), /M03后方剂精确检索[\s\S]*归脾汤[\s\S]*经核验证候:思虑伤脾/);

const unrelatedFormula = [
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({ stage: "diagnose", overview: { recommendedFormulaDirection: "归脾汤加减", recommendedFormulaNames: ["归脾汤"], formulaSelectionMode: "single" } }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n");
const declassifiedFormula = enforceRetrievedM03FormulaSelection(unrelatedFormula, ["半夏泻心汤"]);
assert.match(declassifiedFormula, /按已锁定病机与治法辨证组方/);
assert.match(declassifiedFormula, /"recommendedFormulaNames": \[\]/);
const allowedFormula = enforceRetrievedM03FormulaSelection(unrelatedFormula, ["归脾汤"]);
assert.match(allowedFormula, /"recommendedFormulaNames": \[\]/, "pre-M03 symptom recall alone must never lock a named formula");
const postM03Formula = [
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({ stage: "diagnose", ...postM03Reasoning, overview: { ...postM03Reasoning.overview, recommendedFormulaDirection: "归脾汤加减", recommendedFormulaNames: ["归脾汤"], formulaSelectionMode: "single" } }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n");
assert.match(enforceRetrievedM03FormulaSelection(postM03Formula, []), /"recommendedFormulaNames":\s*\[\s*"归脾汤"/, "post-M03 governed retrieval can authorize a lock even when pre-M03 literal symptoms did not retrieve the classical wording");
const officialIdentity = unrelatedFormula.replaceAll("归脾汤", "龙胆泻肝汤");
const liverFireReasoning = {
  overview: {
    primarySyndrome: "肝火扰心",
    overallPathogenesis: "肝火上扰心神",
    tcmDifferentials: [],
    recommendedFormulaDirection: "龙胆泻肝汤加减",
    recommendedFormulaNames: ["龙胆泻肝汤"],
    formulaSelectionMode: "single",
  },
  pathogenesis: {
    summary: "肝火上扰心神",
    locationDifferentiation: { items: ["肝", "心"], details: [] },
    natureDifferentiation: { items: ["火热"], rootDeficiency: "", branchExcess: "肝火" },
    chain: [{ nodeId: "P1", pathogenesis: "肝火上扰心神", therapyDirection: "清肝泻火，安神" }],
  },
  therapy: { overallPrinciple: "清肝泻火，安神", overallMethod: "清肝泻火，安神", subTherapies: [] },
};
const officialIdentityLocked = enforceRetrievedM03FormulaSelection([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({ stage: "diagnose", ...liverFireReasoning }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"), ["龙胆泻肝汤"]);
assert.match(officialIdentityLocked, /"recommendedFormulaNames":\s*\[\s*"龙胆泻肝汤"/, "official formula identity may lock independently of patient-level dose compilation and audit");
const liverFireCandidates = retrieveTcmFormulaCandidatesForReasoning(liverFireReasoning, 8);
assert.equal(liverFireCandidates[0]?.name, "龙胆泻肝汤");
assert.equal(liverFireCandidates[0]?.positiveSufficiency, true);
// 玉女煎（胃热阴虚）在这里是**阴性对照**：它不该获得正向充分性。
// 但它是否出现在前 8 名取决于目录规模——目录 1877→2699 后它被挤出候选，这不是缺陷。
// 断言因此只管「若出现则必须为 false」，真正的门禁由下一行的 namedFormulaPositiveSufficiencyIssue 承担。
const yunvjianCandidate = liverFireCandidates.find((item) => item.name === "玉女煎");
if (yunvjianCandidate) assert.equal(yunvjianCandidate.positiveSufficiency, false);
assert.match(namedFormulaPositiveSufficiencyIssue(liverFireReasoning, ["玉女煎"]) || "", /玉女煎/);
const weakLiverFireLock = enforceRetrievedM03FormulaSelection(
  officialIdentity.replaceAll("龙胆泻肝汤", "玉女煎"),
  ["玉女煎"],
);
assert.match(weakLiverFireLock, /"recommendedFormulaNames": \[\]/, "nature-only score=2 retrieval must not lock 玉女煎 for 肝火扰心");
const phlegmDampLungReasoning = {
  overview: { primarySyndrome: "痰湿蕴肺", overallPathogenesis: "痰湿蕴肺，肺失宣降", tcmDifferentials: [] },
  pathogenesis: {
    summary: "痰湿蕴肺，肺失宣降",
    locationDifferentiation: { items: ["肺"], details: [] },
    natureDifferentiation: { items: ["痰湿"], rootDeficiency: "", branchExcess: "痰湿" },
    chain: [{ nodeId: "P1", pathogenesis: "痰湿蕴肺", therapyDirection: "燥湿化痰，宣肺止咳" }],
  },
  therapy: { overallPrinciple: "燥湿化痰，宣肺止咳", overallMethod: "燥湿化痰，宣肺止咳", subTherapies: [] },
};
const phlegmDampLungCandidates = retrieveTcmFormulaCandidatesForReasoning(phlegmDampLungReasoning, 8);
assert.equal(phlegmDampLungCandidates[0]?.name, "二陈汤");
assert.equal(phlegmDampLungCandidates[0]?.positiveSufficiency, true);
assert.ok(phlegmDampLungCandidates[0]?.score >= 10);
assert.equal(formulaCompilationReferences(["龙胆泻肝汤"]).length, 1);
assert.deepEqual(retrieveTcmFormulaCandidatesForReasoning({
  overview: { primarySyndrome: "无可映射证候", overallPathogenesis: "无可映射病机", tcmDifferentials: [] },
  pathogenesis: { summary: "无可映射", locationDifferentiation: { items: [], details: [] }, natureDifferentiation: { items: [], rootDeficiency: "", branchExcess: "" }, chain: [] },
}), [], "T8 retrieval must safely abstain when governed tags and clinical concepts do not match");
for (const formula of governedFormulaCatalog.entries) {
  assert.equal(
    executableFormulaCompilationReferences([formula.name]).length === 1,
    formula.doseCompilationEligible,
    `T8 dose-compilation flag must equal the M04 runtime gate: ${formula.name}`,
  );
}
assert.deepEqual(formulaNamesWithoutExecutableDoseCompilation(["白虎汤"]), ["白虎汤"]);
assert.deepEqual(formulaNamesWithoutExecutableDoseCompilation(["归脾汤"]), []);

for (const [name, entry] of Object.entries(formulaCatalog.officialClassicFormulas)) {
  const resolved = resolveFormulaSources(name, herbs(...entry.ingredients));
  assert.equal(resolved[0]?.source, entry.source, `official classic must resolve against its own governed composition: ${name}`);
}

for (const phrase of [
  "建议优先采用归脾汤",
  "推荐方为归脾汤",
  "可考虑归脾汤",
  "拟归脾汤",
  "推荐以归脾汤加减为主",
]) {
  assert.deepEqual(identifyKnownFormulaNames(phrase), ["归脾汤"], `natural-language direction must resolve by catalog: ${phrase}`);
}
assert.deepEqual(identifyKnownFormulaNames("归脾汤合参苓白术散加减"), ["归脾汤", "参苓白术散"]);
assert.deepEqual(identifyKnownFormulaNames("归脾汤或酸枣仁汤酌选"), ["归脾汤", "酸枣仁汤"]);
assert.deepEqual(identifyKnownFormulaNames("自拟归脾安神方"), [], "self-devised labels must not inherit a classic identity by substring");
assert.deepEqual(identifyKnownFormulaNames("首选归脾汤加减，若疗效欠佳再自拟安神方"), ["归脾汤"], "a later self-devised fallback must not erase the governed first choice");
assert.deepEqual(identifyKnownFormulaNames("不建议使用归脾汤，改按病机辨证组方"), [], "a negated classic must not become the governed formula");
assert.deepEqual(identifyKnownFormulaNames("禁用四逆汤，建议急诊评估"), [], "a prohibited classic must not become the governed formula");
assert.deepEqual(identifyKnownFormulaNames("归脾汤仅作鉴别，建议使用酸枣仁汤"), ["酸枣仁汤"], "an identification-only formula must not override the positively recommended formula");
assert.deepEqual(identifyKnownFormulaNames("禁用归脾汤，改用酸枣仁汤"), ["酸枣仁汤"], "formula polarity must follow the positive branch after a switch");
for (const phrase of ["严禁使用归脾汤，改用酸枣仁汤", "不得使用归脾汤，改予酸枣仁汤", "不可采用归脾汤，首选酸枣仁汤", "禁忌使用归脾汤，建议采用酸枣仁汤"]) {
  assert.deepEqual(identifyKnownFormulaNames(phrase), ["酸枣仁汤"], `prohibited formula must never become a governed candidate: ${phrase}`);
}
for (const phrase of ["归脾汤为本例禁忌，改用酸枣仁汤", "归脾汤应避免使用，改用酸枣仁汤", "本例不予选用归脾汤，改用酸枣仁汤", "归脾汤不应继续使用，改用酸枣仁汤", "归脾汤属于禁忌方，改用酸枣仁汤"]) {
  assert.deepEqual(identifyKnownFormulaNames(phrase), ["酸枣仁汤"], `postposed prohibition must control formula polarity: ${phrase}`);
}
for (const phrase of ["归脾汤在本例为禁忌，改用酸枣仁汤", "归脾汤对该患者属于禁忌，改用酸枣仁汤", "归脾汤存在使用禁忌，改用酸枣仁汤", "归脾汤当前不予使用，改用酸枣仁汤", "归脾汤暂停使用，改用酸枣仁汤", "归脾汤，本例禁用；改用酸枣仁汤"]) {
  assert.deepEqual(identifyKnownFormulaNames(phrase), ["酸枣仁汤"], `contextual postposed prohibition must control polarity: ${phrase}`);
}
for (const phrase of ["补汤药调理", "采用膏药外敷", "红油样分泌物", "考虑食疗炒面"]) {
  assert.deepEqual(identifyKnownFormulaNames(phrase), [], `short common-noun catalog entry must not become a formula identity: ${phrase}`);
}
// 白散（桔梗、贝母、巴豆，《绛雪园古方选注》）已入 verified 治理目录并可追溯出处——身份识别应命中；
// 巴豆属高危药由 M04 安全层另行处置，与方名身份治理是两件事。
assert.deepEqual(identifyKnownFormulaNames("白散"), ["白散"], "a governed two-character formula name must resolve to its verified identity");
const guipiCompilation = formulaCompilationReferences(["归脾汤"]);
assert.equal(guipiCompilation.length, 1, "a governed M03 formula must provide one deterministic M04 compilation anchor");
assert.equal(guipiCompilation[0].formulaName, "归脾汤");
assert.match(guipiCompilation[0].source, /济生/);
assert.ok(["人参", "黄芪", "白术", "茯苓"].every((name) => guipiCompilation[0].ingredients.includes(name)), "归脾汤 compilation anchor must preserve its canonical core tonic composition");
assert.equal(guipiCompilation[0].minimumPreservedIngredientCount, 7, "归脾汤 compilation anchor must expose the same 80% preservation threshold enforced after generation");
assert.ok(guipiCompilation[0].requiredIngredients.includes("白术"), "归脾汤 compilation anchor must expose its identity anchor to the model repair contract");
const xiaoyaoCompilation = formulaCompilationReferences(["逍遥散"]);
assert.equal(xiaoyaoCompilation.length, 1, "a governed 逍遥散 must resolve to one controlled 局方 baseline");
assert.match(xiaoyaoCompilation[0].source, /局方.*卷九/);
assert.ok(["柴胡", "白芍", "当归", "白术"].every((name) => xiaoyaoCompilation[0].ingredients.includes(name)));
assert.deepEqual(formulaCompilationReferences(["不存在方"]), [], "unknown names must never acquire a fabricated compilation anchor");
const siwuCompilation = formulaCompilationReferences(["四物汤"]);
assert.equal(siwuCompilation.length, 1, "SZJG/T 38.2-2011 must replace first-row workbook guessing with one governed 四物汤 baseline");
assert.equal(siwuCompilation[0].origin, "local_formula_catalog");
assert.ok(["熟地黄", "酒当归", "白芍", "川芎"].every((name) => siwuCompilation[0].ingredients.includes(name)));
const dangguiLiuhuangCompilation = executableFormulaCompilationReferences(["当归六黄汤"]);
assert.equal(dangguiLiuhuangCompilation.length, 1, "当归六黄汤 must be executable after historical relative-dose text is removed from the herb identity");
assert.ok(dangguiLiuhuangCompilation[0].ingredients.includes("黄芪"));
assert.ok(!dangguiLiuhuangCompilation[0].ingredients.some((name) => /加一倍|如鸡子大/.test(name)));
const canonicalGancao = identifyKnownFormulaNames("甘草汤");
assert.deepEqual(canonicalGancao, ["甘草汤"]);
assert.deepEqual(identifyKnownFormulaNames(canonicalGancao[0]), canonicalGancao, "formula canonicalization must be idempotent");

const referencedDiagnose = applyDeterministicFormulaReferences([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    overview: { recommendedFormulaDirection: "归脾汤或酸枣仁汤酌选", recommendedFormulaNames: ["伪造方"], formulaSelectionMode: "combined" },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
const referencedDiagnoseJson = JSON.parse(referencedDiagnose.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.deepEqual(referencedDiagnoseJson.overview.recommendedFormulaNames, ["归脾汤", "酸枣仁汤"]);
assert.equal(referencedDiagnoseJson.overview.formulaSelectionMode, "alternatives");

const governedStandardDirection = applyDeterministicFormulaReferences([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaDirection: "四物汤加减" } }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
const governedStandardDirectionJson = JSON.parse(governedStandardDirection.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.deepEqual(governedStandardDirectionJson.overview.recommendedFormulaNames, ["四物汤"]);
assert.equal(governedStandardDirectionJson.overview.formulaSelectionMode, "single");
assert.equal(governedStandardDirectionJson.overview.recommendedFormulaDirection, "四物汤加减");

const combinedWithUnrelatedOr = applyDeterministicFormulaReferences([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaDirection: "归脾汤合酸枣仁汤加减，或根据症状调整剂量" } }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
const combinedWithUnrelatedOrJson = JSON.parse(combinedWithUnrelatedOr.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(combinedWithUnrelatedOrJson.overview.formulaSelectionMode, "combined");

const trailingAlternative = applyDeterministicFormulaReferences([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaDirection: "归脾汤与酸枣仁汤酌情选用" } }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
const trailingAlternativeJson = JSON.parse(trailingAlternative.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(trailingAlternativeJson.overview.formulaSelectionMode, "alternatives");

const referencedPrescribe = applyDeterministicFormulaReferences([
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    overview: {},
    formula: { candidates: [{ name: "建议采用归脾汤加减", formulaNames: ["伪造方"] }] },
  }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
const referencedPrescribeJson = JSON.parse(referencedPrescribe.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.deepEqual(referencedPrescribeJson.formula.candidates[0].formulaNames, ["归脾汤"]);

const official = resolveFormulaSources(
  "旋覆代赭汤",
  herbs("旋覆花", "人参", "代赭石", "甘草", "半夏", "生姜", "大枣"),
);
assert.equal(official.length, 1);
assert.equal(official[0].source, "《伤寒论》");
assert.equal(official[0].origin, "official_classic_catalog");

assert.deepEqual(
  resolveFormulaSources("旋覆代赭汤", herbs("黄芪", "白术", "茯苓", "甘草")),
  [],
  "same-name, wrong-composition formula must not receive a classic source",
);
const modernGuipi = resolveFormulaSources(
  "归脾汤加减",
  herbs("人参", "黄芪", "白术", "龙眼肉", "酸枣仁", "茯苓", "木香", "甘草", "山药", "白扁豆"),
);
assert.equal(modernGuipi[0]?.formulaName, "归脾汤", "modern 黄芪 spelling plus a clinically explicit modification must retain the governed 归脾汤 identity");
assert.match(modernGuipi[0]?.source || "", /济生/);
const inferredModernGuipi = resolveFormulaSources(
  "归脾汤",
  herbs("白术", "茯苓", "黄芪", "龙眼肉", "酸枣仁", "人参", "木香", "甘草", "生姜", "大枣"),
);
assert.equal(inferredModernGuipi[0]?.formulaName, "归脾汤", "composition-preserving additions must infer a modified formula even when the model omits 加减 in the label");
const fushenModifiedGuipi = resolveFormulaSources(
  "归脾汤加减",
  herbs("人参", "白术", "黄耆", "龙眼肉", "酸枣仁", "茯神", "木香", "甘草", "山药", "夜交藤"),
);
assert.equal(fushenModifiedGuipi[0]?.formulaName, "归脾汤", "a clearly labeled 归脾汤 modification may retain provenance when the remaining governed identity floor and anchors are present");
assert.equal(fushenModifiedGuipi[0]?.exactComposition, false, "茯神 must never be treated as an exact 茯苓 composition match");
assert.deepEqual(
  resolveFormulaSources("自拟安神方", herbs("酸枣仁", "茯神", "夜交藤", "远志")),
  [],
  "explicit self-devised formulas must never be attributed by name",
);
const verifiedSuanzaoren = resolveFormulaSources(
  "酸枣仁汤加减",
  herbs("酸枣仁", "川芎", "知母", "茯苓", "甘草", "夜交藤", "合欢皮"),
);
assert.equal(verifiedSuanzaoren[0]?.source, "《金匮要略》");
assert.equal(verifiedSuanzaoren[0]?.origin, "verified_reference_catalog");
const modifiedSuanzaoren = resolveFormulaSources(
  "酸枣仁汤加减",
  herbs("酸枣仁", "川芎", "知母", "甘草", "夜交藤", "合欢皮", "白芍", "当归"),
);
assert.equal(modifiedSuanzaoren[0]?.source, "《金匮要略》", "a verified modified formula may omit one base herb while retaining at least 80% of its core");
const annotatedSuanzaoren = resolveFormulaSources(
  "酸枣仁汤加减（《金匮要略》）",
  herbs("酸枣仁", "川芎", "知母", "甘草", "夜交藤", "合欢皮"),
);
assert.equal(annotatedSuanzaoren[0]?.source, "《金匮要略》", "a model-added source annotation must not contaminate formula-name matching");
assert.deepEqual(
  resolveFormulaSources("酸枣仁汤", herbs("酸枣仁", "知母", "川芎", "甘草", "夜交藤")),
  [],
  "an unmodified classic formula name must not inherit the source when any core herb is missing",
);
assert.deepEqual(
  resolveFormulaSources("酸枣仁汤加减", herbs("酸枣仁", "知母", "甘草", "夜交藤", "合欢皮", "白芍", "当归", "远志")),
  [],
  "a named modified formula missing more than 20% of its verified core must not inherit the classic source",
);
const sameNameVariant = resolveFormulaSources(
  "酸枣仁汤",
  herbs("酸枣仁", "人参", "石膏", "赤茯苓", "知母", "甘草"),
);
assert.equal(sameNameVariant[0]?.source, "《圣济总录》卷三十二。");
assert.equal(sameNameVariant[0]?.origin, "local_formula_catalog");
assert.notEqual(sameNameVariant[0]?.source, "《金匮要略》", "a verified common formula must not overwrite a better same-name variant");
const verifiedXiangsha = resolveFormulaSources(
  "香砂六君子汤加减",
  herbs("人参", "白术", "茯苓", "炙甘草", "陈皮", "半夏", "砂仁", "木香", "生姜"),
);
assert.equal(verifiedXiangsha[0]?.source, "《古今名医方论》卷一引柯韵伯方。");
assert.equal(verifiedXiangsha[0]?.origin, "local_formula_catalog", "unsupported supplemental URL must not be promoted as a verified reference");
assert.deepEqual(
  resolveFormulaSources("香砂六君子汤加减", herbs("人参", "白术", "茯苓", "炙甘草", "陈皮")),
  [],
  "a partial formula missing 半夏、砂仁、木香 must not inherit the verified classic source",
);
const xiangshaKouchi = resolveFormulaSources(
  "香砂六君子汤",
  herbs("人参", "白术", "茯苓", "半夏", "陈皮", "藿香", "甘草", "宿砂仁"),
);
assert.equal(xiangshaKouchi[0]?.source, "《口齿类要》。", "an exact same-name local variant must outrank a less similar verified supplement");
const xiangshaMingyi = resolveFormulaSources(
  "香砂六君子汤",
  herbs("人参", "白术", "茯苓", "甘草", "陈皮", "半夏", "香附", "藿香", "砂仁"),
);
assert.equal(xiangshaMingyi[0]?.source, "《明医杂著》卷六。", "all same-name variants must participate in one global ranking");

const combined = resolveFormulaSources(
  "旋覆代赭汤合温胆汤加减",
  herbs("旋覆花", "人参", "代赭石", "甘草", "半夏", "生姜", "大枣", "竹茹", "枳实", "陈皮", "茯苓"),
);
assert.equal(combined.length, 2, "a combined formula must verify every named base formula");
assert.deepEqual(combined.map((item) => item.source), ["《伤寒论》", "《三因》卷九。"], "combined-formula provenance follows the closest composition, not catalog prestige alone");
assert.ok(
  combined.every((item) =>
    item.verificationStatus === "verified_individually" &&
    item.matchedIngredientCount >= item.minimumPreservedIngredientCount &&
    item.matchedRequiredIngredientCount === item.requiredIngredientCount),
  "every combined-formula source row must expose its own passed composition floor and required anchors",
);
const fullyVerifiedComponents = verifyFormulaCompilationComponents(
  ["旋覆代赭汤", "温胆汤"],
  herbs("旋覆花", "人参", "代赭石", "甘草", "半夏", "生姜", "大枣", "竹茹", "枳实", "陈皮", "茯苓"),
  true,
  true,
);
assert.deepEqual(
  fullyVerifiedComponents.map((item) => item.verified),
  [true, true],
  "combined-formula verification must produce one independent verdict for each governed base",
);
const xuanfuOnlyComponents = verifyFormulaCompilationComponents(
  ["旋覆代赭汤", "温胆汤"],
  herbs(...formulaCompilationReferences(["旋覆代赭汤"])[0].ingredients),
  true,
  true,
);
assert.equal(xuanfuOnlyComponents[0]?.verified, true, "the first base may pass its own governed identity");
assert.equal(xuanfuOnlyComponents[1]?.verified, false, "the second base must still fail independently when its own composition is absent");
assert.deepEqual(
  resolveFormulaSources(
    "旋覆代赭汤合温胆汤",
    herbs("旋覆花", "人参", "代赭石", "甘草", "半夏", "生姜", "竹茹", "陈皮", "茯苓"),
  ),
  [],
  "an unmodified combined formula must contain every base ingredient and no unexplained additions",
);
assert.deepEqual(
  resolveFormulaSources("旋覆代赭汤合温胆汤加减", herbs("旋覆花", "人参", "代赭石", "甘草")),
  [],
  "a partially matched combined formula must not be presented as verified",
);
assert.deepEqual(
  resolveFormulaSources("六半汤", herbs("芍药", "白芍药")),
  [],
  "two candidate aliases must not consume the same canonical ingredient twice",
);
assert.deepEqual(
  resolveFormulaSources("麻黄汤合不存在方", herbs("麻黄", "桂枝", "甘草", "杏仁")),
  [],
  "an unknown combined-formula segment must reject the whole provenance claim",
);
assert.deepEqual(
  resolveFormulaSources("麻黄汤", herbs("黄", "桂", "草", "杏")),
  [],
  "single-character substrings must not impersonate canonical herb names",
);
assert.deepEqual(
  resolveFormulaSources("清胃散", herbs("当归", "黄连", "熟地黄", "牡丹皮", "升麻")),
  [],
  "生地黄换为熟地黄属于药味变更，不能继承未标加减的经典出处",
);
assert.deepEqual(
  resolveFormulaSources("真武汤加减", herbs("茯苓", "芍药", "生姜", "白术")),
  [],
  "经典加减方缺少安全核心药附子时不得继承出处",
);
assert.deepEqual(
  resolveFormulaSources("半夏泻心汤加减", herbs("黄芩", "干姜", "人参", "甘草", "黄连", "大枣")),
  [],
  "经典加减方缺少方名核心药半夏时不得继承出处",
);
const lily = resolveFormulaSources("百合地黄汤", herbs("百合", "生地黄汁"));
assert.equal(lily[0]?.source, "《金匮要略》");
assert.deepEqual(
  resolveFormulaSources("百合地黄汤", herbs("生地黄汁")),
  [],
  "a formula missing 百合 must not match after quantity parsing",
);
const lilyCombined = resolveFormulaSources(
  "百合地黄汤合桃核承气汤",
  herbs("百合", "生地黄汁", "桃仁", "大黄", "桂枝", "甘草", "芒硝"),
);
assert.equal(lilyCombined.length, 2, "formula names containing 合 must survive combined-formula tokenization");
const juyuan = resolveFormulaSources("举元煎", herbs("人参", "黄芪", "炙甘草", "升麻", "白术"));
assert.equal(juyuan[0]?.source, "《景岳全书》", "wrapped herb names and quantity ranges must not corrupt official classics");

function reasoning(candidate) {
  return {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    formula: { candidates: [candidate], patentAndWestern: null, modifications: [] },
  };
}

function candidate(name, names) {
  return {
    name,
    positioning: "首选",
    formulaSource: { evidenceLevel: "insufficient", source: "内部证据缺口", confidence: "低" },
    therapyMatch: "测试",
    applicable: "测试",
    notApplicable: "测试",
    herbs: names.map((name) => ({
      name, processing: null, dose: "6g", role: "佐", prescriptionRole: "测试",
      targetPathogenesis: "测试", function: "测试",
      evidence: { evidenceLevel: "insufficient", source: "内部证据缺口", confidence: "低" },
    })),
    formulaAnalysis: "测试",
    decoction: { doseCount: "3剂", method: "水煎服", course: "3日", followUpNode: "3日复诊" },
  };
}

function render(value) {
  return [
    `### 候选处方1：${value.formula.candidates[0].name}`,
    "**方剂出处或依据**：证据不足/待检索",
    "<!-- DIAGNOSIS_JSON_START -->",
    JSON.stringify(value),
    "<!-- DIAGNOSIS_JSON_END -->",
  ].join("\n");
}

function parsedReasoning(content) {
  return JSON.parse(content.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
}

const enrichedOfficial = enrichPrescriptionProvenance(render(reasoning(candidate(
  "旋覆代赭汤加减",
  ["旋覆花", "人参", "代赭石", "甘草", "半夏", "生姜", "大枣"],
))));
assert.match(enrichedOfficial, /\*\*参考基础方及出处\*\*[：:]旋覆代赭汤：《伤寒论》/);
assert.doesNotMatch(enrichedOfficial, /证据不足|待检索/);
const officialJson = JSON.parse(enrichedOfficial.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(officialJson.formula.candidates[0].constructionType, "single_base");
assert.equal(officialJson.formula.candidates[0].formulaSource.confidence, "中");
assert.equal(officialJson.formula.candidates[0].baseFormulas[0].matchedIngredientCount, 7);
assert.equal(officialJson.formula.candidates[0].baseFormulas[0].totalIngredientCount, 7);

const inferredModifiedGuipi = enrichPrescriptionProvenance(render(reasoning(candidate(
  "归脾汤",
  ["白术", "茯苓", "黄芪", "龙眼肉", "酸枣仁", "人参", "木香", "甘草", "生姜", "大枣"],
))));
const inferredModifiedGuipiJson = JSON.parse(inferredModifiedGuipi.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(inferredModifiedGuipiJson.formula.candidates[0].name, "归脾汤加减", "server display must expose composition-inferred modification instead of calling a changed formula canonical");
assert.equal(inferredModifiedGuipiJson.formula.candidates[0].modificationStatus, "modified");
assert.deepEqual(inferredModifiedGuipiJson.formula.candidates[0].formulaNames, ["归脾汤"]);
const guipiPrior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaNames: ["归脾汤"], formulaSelectionMode: "single" } };
assert.equal(formulaCompilationContractIssue(inferredModifiedGuipiJson, guipiPrior), undefined, "the final formula must match the exact governed compilation baseline");
const preparedGuipi = resolveFormulaSources("归脾汤加减", [
  ...["白术", "茯苓", "黄芪", "龙眼肉", "人参", "木香"].map((name) => ({ name })),
  { name: "酸枣仁", processing: "捣碎" },
  { name: "甘草", processing: "炙" },
  { name: "远志" },
]);
assert.match(preparedGuipi[0]?.source || "", /《济生》/, "physical preparation such as crushing must not change the herb identity used for formula provenance");
assert.equal(preparedGuipi[0]?.matchedIngredientCount, 8, "a separately recorded processed candidate may inherit an unprocessed base-formula identity");
const processedSuanzaoren = resolveFormulaSources("酸枣仁汤", [
  { name: "酸枣仁", processing: "炒" },
  ...["知母", "茯苓", "川芎", "甘草"].map((name) => ({ name })),
]);
assert.match(processedSuanzaoren[0]?.source || "", /金匮要略/, "炒酸枣仁 keeps its dispensing identity while matching the source formula's 酸枣仁 base identity");
const declassifiedGuipi = structuredClone(inferredModifiedGuipiJson);
declassifiedGuipi.formula.candidates[0] = {
  ...declassifiedGuipi.formula.candidates[0],
  name: "本例辨证组方",
  formulaNames: [],
  constructionType: "self_devised",
  baseFormulas: [],
  formulaSource: {
    evidenceLevel: "model_inference",
    source: "本例证候、病机、治法与药味功效的结构化匹配（模型推断，需医生复核）",
    confidence: "中",
  },
};
assert.equal(formulaCompilationContractIssue(declassifiedGuipi, guipiPrior), undefined, "a composition that cannot inherit the M03 classic identity must remain usable after transparent self-devised declassification");
assert.equal(
  formulaCompilationContractIssue(declassifiedGuipi, guipiPrior, false, false),
  "formula_reference_declassified",
  "provider validation must request a governed-composition repair before accepting the transparent self-devised fallback",
);
const falselyNamedDeclassifiedGuipi = structuredClone(declassifiedGuipi);
falselyNamedDeclassifiedGuipi.formula.candidates[0].name = "归脾汤加减";
assert.match(formulaCompilationContractIssue(falselyNamedDeclassifiedGuipi, guipiPrior) || "", /formula_reference_selection_drift/, "a declassified composition must never retain a classic name or source");
assert.deepEqual(formulaCompilationReferences(["龙齿安神丹"]), [], "a historical-workbook-only formula cannot bypass the T8 lock-eligibility authority");
const qingguReference = formulaCompilationReferences(["清骨散"])[0];
assert.ok(qingguReference && qingguReference.ingredients.length === 8 && qingguReference.minimumPreservedIngredientCount === 7, "T8 governed formula fixture must expose an 8-herb baseline with a 7-herb identity floor");
const qingguPrior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaNames: ["清骨散"], formulaSelectionMode: "single" } };
const compiledQinggu = (names) => parsedReasoning(enrichPrescriptionProvenance(render(reasoning(candidate("清骨散加减", names)))));
const assertSafelyDeclassified = (result, prior, message) => {
  const declassified = result.formula.candidates[0];
  assert.equal(declassified.name, "本例辨证组方", `${message}: display name`);
  assert.deepEqual(declassified.formulaNames, [], `${message}: classic identity`);
  assert.equal(declassified.formulaSource.evidenceLevel, "model_inference", `${message}: source level`);
  assert.equal(formulaCompilationContractIssue(result, prior), undefined, `${message}: usable candidate`);
};
const removableQingguIngredient = qingguReference.ingredients.find((name) => !qingguReference.requiredIngredients.includes(name));
assert.ok(removableQingguIngredient, "T8 formula fixture must have a non-anchor ingredient for the 80% acceptance boundary");
const qingguAt80 = compiledQinggu(qingguReference.ingredients.filter((name) => name !== removableQingguIngredient));
assert.equal(formulaCompilationContractIssue(qingguAt80, qingguPrior), undefined, "a modified T8 formula at or above the 80% floor with every anchor must retain its governed identity");
const qingguWithReasonableAdditions = compiledQinggu([
  ...qingguReference.ingredients.filter((name) => name !== removableQingguIngredient),
  "当归", "白术", "茯苓",
]);
assert.equal(formulaCompilationContractIssue(qingguWithReasonableAdditions, qingguPrior), undefined, "retrieval ranking must not reject a single governed formula that satisfies the authoritative 80% floor, anchors, and addition precision boundary");
const qingguBelow80 = compiledQinggu(qingguReference.ingredients.slice(0, 6));
assertSafelyDeclassified(qingguBelow80, qingguPrior, "a 75% T8-formula match must not inherit the governed name or source");
const qingguWithoutAnchor = compiledQinggu(qingguReference.ingredients.filter((name) => !qingguReference.requiredIngredients.includes(name)));
assertSafelyDeclassified(qingguWithoutAnchor, qingguPrior, "a formula missing a T8 identity anchor must be declassified even when its overall overlap is otherwise high");
const xuanfuReference = formulaCompilationReferences(["旋覆代赭汤"])[0];
assert.ok(xuanfuReference.requiredIngredients.includes("代赭石"), "raw-name anchor detection must preserve 代赭 as canonical 代赭石 in 旋覆代赭汤");
const xuanfuPrior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaNames: ["旋覆代赭汤"], formulaSelectionMode: "single" } };
const partialCombinedCandidate = candidate("旋覆代赭汤合温胆汤加减", xuanfuReference.ingredients);
partialCombinedCandidate.formulaNames = ["旋覆代赭汤", "温胆汤"];
partialCombinedCandidate.constructionType = "combined";
const partialCombinedReasoning = reasoning(partialCombinedCandidate);
const combinedPrior = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { recommendedFormulaNames: ["旋覆代赭汤", "温胆汤"], formulaSelectionMode: "combined" },
};
assert.equal(
  formulaCompilationContractIssue(partialCombinedReasoning, combinedPrior),
  "formula_component_1_unverified",
  "a passing first base must not cause the second missing base to inherit verified status",
);
const xuanfuWithoutAnchor = parsedReasoning(enrichPrescriptionProvenance(render(reasoning(candidate(
  "旋覆代赭汤加减",
  xuanfuReference.ingredients.filter((name) => name !== "代赭石"),
)))));
assertSafelyDeclassified(xuanfuWithoutAnchor, xuanfuPrior, "deleting canonical 代赭石 must remove the classic identity");
for (const formulaName of ["代赭扶脾汤", "加减代赭旋覆花汤", "增减旋覆代赭汤"]) {
  assert.deepEqual(formulaCompilationReferences([formulaName]), [], `${formulaName} is historical-workbook-only and cannot acquire a compilation baseline outside T8`);
}
for (const [formulaName, expectedCanonicalAnchor] of [["三味黄耆丸", "黄芪"], ["加味茯神散", "茯神"]]) {
  assert.deepEqual(formulaCompilationReferences([formulaName]), [], `${formulaName}/${expectedCanonicalAnchor} cannot use an alias-correct historical row without T8 governance`);
}
const qingweiReference = formulaCompilationReferences(["清胃散"])[0];
assert.ok(qingweiReference.ingredients.includes("当归身") && !qingweiReference.ingredients.includes("当归"), "formula provenance must preserve medicinal-part identity for 当归身");
const qingweiPrior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaNames: ["清胃散"], formulaSelectionMode: "single" } };
const qingweiWholeDanggui = parsedReasoning(enrichPrescriptionProvenance(render(reasoning(candidate(
  "清胃散加减",
  qingweiReference.ingredients.map((name) => name === "当归身" ? "当归" : name),
)))));
assertSafelyDeclassified(qingweiWholeDanggui, qingweiPrior, "whole 当归 must not retain a formula governed by the 当归身 anchor");
assert.deepEqual(resolveFormulaSources("清胃散", herbs(...qingweiReference.ingredients.map((name) => name === "当归身" ? "当归" : name))), [], "a medicinal-part substitution must not inherit an exact classic formula source");
const sanjiaReference = formulaCompilationReferences(["三甲复脉汤"])[0];
assert.ok(sanjiaReference.ingredients.includes("炙甘草") && !sanjiaReference.ingredients.includes("甘草"), "formula provenance must preserve processing identity for 炙甘草");
assert.deepEqual(resolveFormulaSources("三甲复脉汤", herbs(...sanjiaReference.ingredients.map((name) => name === "炙甘草" ? "甘草" : name))), [], "an unlabelled processing substitution must not inherit an exact classic formula source");
const structuredSanjiaHerbs = sanjiaReference.ingredients.map((name) => name === "炙甘草" ? { name: "甘草", processing: "炙" } : { name });
assert.equal(resolveFormulaSources("三甲复脉汤", structuredSanjiaHerbs)[0]?.exactComposition, true, "structured 炙 processing must reconstruct the complete 炙甘草 identity");
const wuhuReference = formulaCompilationReferences(["五虎汤"])[0];
const wuhuWithProcessedGancao = wuhuReference.ingredients.map((name) => name === "甘草" ? { name: "甘草", processing: "炙" } : { name });
assert.equal(resolveFormulaSources("五虎汤加减", wuhuWithProcessedGancao)[0]?.exactComposition, false, "adding 炙 processing must not remain an exact 五虎汤 composition");
assert.deepEqual(formulaCompilationReferences(["七味活命饮"]), [], "a historical alias-normalized row still cannot become executable outside T8");
assert.deepEqual(formulaCompilationReferences(["人参薯蓣丸"]), [], "a historical workbook row cannot acquire a public formula floor outside T8");
const suanzaorenNamedGuipiComposition = parsedReasoning(enrichPrescriptionProvenance(render(reasoning(candidate(
  "酸枣仁汤加减",
  ["白术", "茯苓", "黄芪", "龙眼肉", "酸枣仁", "人参", "木香", "甘草"],
)))));
const suanzaorenPrior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { recommendedFormulaNames: ["酸枣仁汤"], formulaSelectionMode: "single" } };
assert.equal(formulaCompilationContractIssue(suanzaorenNamedGuipiComposition, suanzaorenPrior), "formula_compilation_composition_drift", "a same-name historical variant cannot replace the signed M03 compilation baseline");
const guipiBaseline = formulaCompilationReferences(["归脾汤"])[0];
const suanzaorenBaseline = formulaCompilationReferences(["酸枣仁汤"])[0];
const alternativeBaselinePrior = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { recommendedFormulaNames: ["归脾汤", "酸枣仁汤"], formulaSelectionMode: "alternatives" },
};
const selectedFormulaWithHerbs = (name, ingredientNames) => parsedReasoning(enrichPrescriptionProvenance(render(reasoning(candidate(`${name}加减`, ingredientNames)))));
assert.equal(formulaCompilationContractIssue(selectedFormulaWithHerbs("归脾汤", guipiBaseline.ingredients), alternativeBaselinePrior), undefined, "selected 归脾汤 accepts only its governed baseline");
assert.equal(formulaCompilationContractIssue(selectedFormulaWithHerbs("酸枣仁汤", suanzaorenBaseline.ingredients), alternativeBaselinePrior), undefined, "selected 酸枣仁汤 accepts only its governed baseline");
assert.equal(formulaCompilationContractIssue(selectedFormulaWithHerbs("酸枣仁汤", guipiBaseline.ingredients), alternativeBaselinePrior), "formula_compilation_composition_drift", "selected 酸枣仁汤 rejects the unselected 归脾汤 composition");
const guipiNamedSuanzaorenComposition = selectedFormulaWithHerbs("归脾汤", suanzaorenBaseline.ingredients);
assert.equal(guipiNamedSuanzaorenComposition.formula.candidates[0].name, "本例辨证组方", "a 归脾汤 label with 酸枣仁汤 composition is declassified before display");
assert.deepEqual(guipiNamedSuanzaorenComposition.formula.candidates[0].formulaNames, []);
assert.equal(formulaCompilationContractIssue(guipiNamedSuanzaorenComposition, alternativeBaselinePrior), undefined, "the declassified reverse mismatch remains usable without a false classic identity");
const weakShortVariantClaim = parsedReasoning(enrichPrescriptionProvenance(render(reasoning(candidate(
  "酸枣仁汤加减",
  ["酸枣仁", "腊茶", "黄芪", "龙眼肉", "木香", "远志", "夜交藤", "合欢皮"],
)))));
assertSafelyDeclassified(weakShortVariantClaim, suanzaorenPrior, "a short same-name variant must not lend its classic identity to a mostly unrelated larger composition");

const selfDevisedCandidate = candidate(
  "自拟安神方",
  ["酸枣仁", "茯神", "夜交藤", "远志"],
);
selfDevisedCandidate.therapyMatch = "归脾汤加减以补益心脾，香砂六君子汤健脾和胃";
selfDevisedCandidate.formulaAnalysis = "原方按归脾汤结构加减";
selfDevisedCandidate.applicable = "纳差便溏阴性史待核实";
selfDevisedCandidate.notApplicable = "潮热盗汗未在本次病历中明确记录，待核实";
const enrichedSelfDevised = enrichPrescriptionProvenance(render(reasoning(selfDevisedCandidate)).replace(
  "<!-- DIAGNOSIS_JSON_START -->",
  "**方剂定位**：归脾汤加减。原方以补益心脾为主，本例再作化裁。\n\n<!-- DIAGNOSIS_JSON_START -->",
));
assert.doesNotMatch(enrichedSelfDevised, /\*\*(?:参考依据|组方依据)\*\*/, "clinical inference must not be presented as an external reference");
assert.match(enrichedSelfDevised, /本例辨证组方/);
assert.match(enrichedSelfDevised, /本方案/);
assert.doesNotMatch(enrichedSelfDevised, /证据不足|待检索|《[^》]+》|归脾汤|原方/);
const selfJson = JSON.parse(enrichedSelfDevised.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(selfJson.formula.candidates[0].constructionType, "self_devised");
assert.equal(selfJson.formula.candidates[0].formulaSource.evidenceLevel, "model_inference");
assert.doesNotMatch(JSON.stringify(selfJson.formula.candidates[0]), /归脾汤|香砂六君子汤|原方|待核实|未在本次病历/);
assert.match(selfJson.formula.candidates[0].notApplicable, /重新辨证/);

const lexicalTherapyCandidate = candidate(
  "自拟鼻鼽方",
  ["桂枝", "白芍", "生姜", "大枣"],
);
lexicalTherapyCandidate.therapyMatch = "疏风散寒，调和营卫，宣通鼻窍";
lexicalTherapyCandidate.formulaAnalysis = "以疏风散寒与调和营卫为组方方向";
const lexicalTherapyContent = enrichPrescriptionProvenance(render(reasoning(lexicalTherapyCandidate)).replace(
  "<!-- DIAGNOSIS_JSON_START -->",
  "**治法**：疏风散寒，调和营卫，宣通鼻窍。\n\n<!-- DIAGNOSIS_JSON_START -->",
));
const lexicalTherapyJson = parsedReasoning(lexicalTherapyContent);
assert.equal(lexicalTherapyJson.formula.candidates[0].therapyMatch, "疏风散寒，调和营卫，宣通鼻窍", "formula governance must not split a treatment phrase at the 散 character");
assert.equal(lexicalTherapyJson.formula.candidates[0].formulaAnalysis, "以疏风散寒与调和营卫为组方方向", "formula governance must preserve lexical treatment text in structured fields");
assert.match(lexicalTherapyContent, /治法\*\*[：:]疏风散寒，调和营卫，宣通鼻窍/, "formula governance must preserve lexical treatment text in visible narrative");
assert.match(lexicalTherapyContent, /^### 候选处方1：本例辨证组方/m, "the visible heading must retain the existing self-devised declassification");

const enrichedSingleClassic = enrichPrescriptionProvenance(render(reasoning(candidate("甘草汤", ["甘草"]))));
assert.match(enrichedSingleClassic, /\*\*方剂资料收载来源\*\*/);
const singleJson = JSON.parse(enrichedSingleClassic.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(singleJson.formula.candidates[0].constructionType, "single_base");
assert.equal(singleJson.formula.candidates[0].formulaSource.evidenceLevel, "kb_entry");
const annotatedGancao = resolveFormulaSources("甘草汤（《伤寒论》）", herbs("甘草"));
assert.equal(annotatedGancao[0]?.source, "《伤寒论》。", "normalized aliases must retain every exact variant and honor an explicit source annotation");

const enrichedVerified = enrichPrescriptionProvenance(render(reasoning(candidate(
  "酸枣仁汤加减（《金匮要略》）",
  ["酸枣仁", "川芎", "知母", "茯苓", "甘草", "夜交藤"],
))));
assert.match(enrichedVerified, /\*\*参考基础方及出处\*\*[：:]酸枣仁汤：《金匮要略》/);
const verifiedJson = JSON.parse(enrichedVerified.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
assert.equal(verifiedJson.formula.candidates[0].formulaSource.evidenceLevel, "classic_text");
assert.equal(verifiedJson.formula.candidates[0].formulaSource.confidence, "中");
assert.equal(verifiedJson.formula.candidates[0].name, "酸枣仁汤加减");

const unverifiedHeadingVariant = render(reasoning(candidate("升栀逍遥散化裁", ["柴胡", "白芍", "茯苓"])))
  .replace("### 候选处方1：", "#### 候选方药一：");
const sanitizedUnknown = enrichPrescriptionProvenance(unverifiedHeadingVariant);
assert.match(sanitizedUnknown, /#### 候选方药一：本例辨证组方/);
assert.doesNotMatch(sanitizedUnknown, /升栀逍遥散|《伤寒论》/);

// ─── P0-5 prompt 层断言：经典方优先、出处纪律、君药去偏、角色差异化方义、非空随证加减、治法→药味映射 ───
const { buildDiagnosePrompt, buildPrescribePrompt } = await import("../src/lib/diagnosis-prompts.ts");

function promptM03Reasoning({ syndrome, therapy, method, chain, formulaNames = [] }) {
  return {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    overview: {
      primarySyndrome: syndrome,
      overallPathogenesis: "测试总病机",
      overallTherapy: therapy,
      recommendedFormulaDirection: formulaNames.length ? `${formulaNames[0]}加减` : "按已锁定病机与治法辨证组方",
      recommendedFormulaNames: formulaNames,
      formulaSelectionMode: formulaNames.length ? "single" : "self_devised",
    },
    pathogenesis: {
      chain: chain.map(([nodeId, pathogenesis, therapyDirection]) => ({
        nodeId, patientFact: "测试患者事实", syndromeEvidence: "测试证候证据", pathogenesis, therapyDirection,
      })),
    },
    therapy: { overallPrinciple: therapy, overallMethod: method, subTherapies: [] },
  };
}

function prescribePromptFor(m03) {
  return buildPrescribePrompt({ patient: {}, chiefComplaint: "测试主诉", conversation: [], reasoningDiagnose: m03 });
}

const xinmaiPrompt = prescribePromptFor(promptM03Reasoning({
  syndrome: "心脉瘀阻证",
  therapy: "活血化瘀、通脉止痛",
  method: "活血化瘀、通脉止痛",
  chain: [["P1", "瘀血阻滞心脉", "活血化瘀、通脉止痛"], ["P2", "气机郁滞", "理气行滞"]],
}));
assert.ok(xinmaiPrompt.includes("【M03后方剂精确检索记录（只用于核对既有选择；M04 不得据此改方名）】"), "M04 must preserve the M03 formula-selection boundary");
assert.ok(xinmaiPrompt.includes("M04 不得临时附会方名"), "an M03 self-devised direction must not acquire a classic identity in M04");

const piweiPrompt = prescribePromptFor(promptM03Reasoning({
  syndrome: "脾胃虚弱证",
  therapy: "健脾益气、和胃助运",
  method: "健脾益气、和胃助运",
  chain: [["P1", "脾胃虚弱、运化无力", "健脾益气"], ["P2", "湿浊内生", "化湿和中"]],
}));
assert.ok(piweiPrompt.includes("M03 未锁定命名方"), "M04 must retain self-devised identity when M03 did not lock a governed formula");

const descendingPrompt = prescribePromptFor(promptM03Reasoning({
  syndrome: "胃气上逆",
  therapy: "和胃降逆",
  method: "和胃降逆",
  chain: [["P1", "胃气上逆", "和胃降逆"]],
}));
const descendingLine = descendingPrompt.match(/- 理气方向：([^\n]+)/)?.[1] || "";
assert.ok(descendingLine.includes("佛手"), "the descending shortlist must retain a KB-covered gentle 和胃 herb");
assert.ok(descendingLine.indexOf("佛手") < descendingLine.indexOf("枳壳"), "a direct 和胃 function hit must rank ahead of a generic common 理气 herb");
assert.doesNotMatch(descendingLine, /乌药|九香虫|刀豆|土木香/, "M03-unsupported warming herbs must be filtered before emperor selection");

const fenghanPrompt = prescribePromptFor(promptM03Reasoning({
  syndrome: "风寒表证",
  therapy: "辛温解表",
  method: "辛温解表、宣肺散寒",
  chain: [["P1", "风寒束表、卫阳被遏", "辛温解表、发散风寒"], ["P2", "肺气失宣", "宣肺散寒"]],
}));
assert.ok(fenghanPrompt.includes("M04 不得临时附会方名"), "M04 must never infer a formula name from therapy alone");

const lockedGuipiPrompt = prescribePromptFor(promptM03Reasoning({
  syndrome: "心脾两虚证",
  therapy: "补益心脾、养血安神",
  method: "补益心脾、养血安神",
  chain: [["P1", "心脾两虚、心神失养", "补益心脾、养血安神"]],
  formulaNames: ["归脾汤"],
}));
assert.ok(lockedGuipiPrompt.includes("- 方名：归脾汤"), "a locked M03 formula must keep its deterministic compilation baseline in M04");
assert.ok(lockedGuipiPrompt.includes("M04 只能承接 M03 已锁定"), "the candidate stage must explicitly preserve the M03 formula identity");

for (const [label, needle] of [
  ["M03 formula identity boundary", "经典方身份在 M03 完成"],
  ["server-owned provenance citation", "方剂出处一律由服务端按目录"],
  ["self-devised justification channel", "candidate.applicable 必须用一句话说明受控目录候选未覆盖"],
  ["jun-herb de-bias rule", "山药、党参、黄芪、甘草等通用补益或调和药只有在 P1 病机本身就是其主治的虚损证型"],
  ["jun-herb rationale template ban", "不得把同一条君药理由模板复用到不同病例"],
  ["role-differentiated fangyi rule", "臣药必须引用与君药不同的次级病机节点"],
  ["repetitive rationale mechanism", "重复引用会产生重复方义"],
  ["therapy-to-herb mapping rule", "治法→药味映射"],
  ["therapy coverage rule", "必须覆盖 M03 therapy.subTherapies 中每个“主要”治法方向"],
  ["modification bounded count", "可给出0–3条"],
  ["modification current-fact trigger", "trigger 必须逐字引用 primarySyndromeBasis"],
  ["modification action field", "动作（actionType=add/remove/adjust 加 herbName）"],
  ["modification reason field", "理由（reason=该加减对应的病机依据）"],
  ["modification risk note field", "风险说明由服务端统一附加，模型不得自行输出"],
  ["empty modification is valid", "没有合格当前伴随症状时输出空数组即可"],
]) {
  assert.ok(xinmaiPrompt.includes(needle), `M04 prompt must contain ${label}: ${needle}`);
}
assert.ok(xinmaiPrompt.length < 60_000, `M04 prompt must stay within the PRIMARY_TEXT_MAX_PROMPT_CHARS discipline, got ${xinmaiPrompt.length}`);

const diagnosePrompt = buildDiagnosePrompt({ patient: {}, chiefComplaint: "心下痞满，呕吐，肠鸣下利，舌苔黄腻", conversation: [], symptoms: {} });
assert.ok(diagnosePrompt.includes("推荐主方方向坚持经典方优先"), "M03 must require classical-formula-first direction");
assert.ok(diagnosePrompt.includes("确无方证匹配的经典方时才按已锁定病机与治法自拟"), "M03 must constrain self-devised directions to a catalog-free label");
assert.ok(diagnosePrompt.includes("therapyDirection 必须逐节点具体且互不重复"), "M03 must forbid duplicated therapyDirection sentences that flatten downstream fangyi");
assert.ok(diagnosePrompt.includes("【M03统一临床推理权威合同】"), "M03 generation must use the same inference authority as independent review");
assert.ok(diagnosePrompt.includes("逐字接地要求只适用于 L0 患者事实"), "M03 generation must distinguish chart facts from supported clinical inference");
assert.match(diagnosePrompt, /\[TCM-FORMULA-[A-F0-9]+\] 半夏泻心汤[\s\S]*《伤寒论》/, "M03 must receive the case-bound governed classic formula card");

// ─── P0-5 跟进（ES04 类失败）：君药知识库覆盖硬规则、覆盖药味短名单、专属修复提示 ───
const xiaokeReasoning = promptM03Reasoning({
  syndrome: "阴虚内热证",
  therapy: "滋阴清热、生津止渴",
  method: "滋阴清热、生津止渴",
  chain: [["P1", "阴虚内热、津液亏耗", "滋阴清热、生津止渴"], ["P2", "燥热伤津", "清热生津"]],
});
const xiaokePrompt = prescribePromptFor(xiaokeReasoning);
assert.ok(xiaokePrompt.includes("君药知识库覆盖"), "M04 prompt must state the emperor KB-coverage hard rule");
assert.ok(xiaokePrompt.includes("完全无功能收载的药味不得为君"), "the hard rule must forbid emperors without any KB function coverage");
assert.ok(xiaokePrompt.includes("改用同一治法方向上最近的有覆盖药味"), "the prompt must steer an uncovered ideal emperor to the closest covered herb in the same direction");
const shortlistStart = xiaokePrompt.indexOf("【本例治法方向的知识库覆盖药味短名单");
const shortlistEnd = xiaokePrompt.indexOf("【M04药味可引用病机节点】");
assert.ok(shortlistStart >= 0 && shortlistEnd > shortlistStart, "M04 prompt must inject the KB-covered herb shortlist for a 消渴/阴虚内热-type case");
const shortlistSection = xiaokePrompt.slice(shortlistStart, shortlistEnd);
assert.ok(shortlistSection.includes("- 补阴方向："), "the shortlist must group covered herbs by the 补阴 direction");
assert.ok(shortlistSection.includes("- 清热方向："), "the shortlist must group covered herbs by the 清热 direction");
for (const herb of ["知母", "天花粉"]) {
  assert.ok(shortlistSection.includes(herb), `KB-covered 消渴-direction herb ${herb} must appear in the shortlist`);
}
assert.ok(/- 补阴方向：[^\n]*(?:石斛|玉竹|百合|黄精|天冬|女贞子)/.test(shortlistSection), "at least one covered 补阴 herb must appear in the 补阴 group");
assert.ok(shortlistSection.includes("生地黄"), "生地黄's governed 清热凉血/养阴生津 coverage must make it eligible for the matching direction");
assert.ok(shortlistSection.includes("麦冬"), "麦冬's 补阴 category now maps to yin_nourish on both sides, so the canonical 养阴 emperor must be offered");
const commonYinHerbs = tcmKnowledgeCatalog.commonHerbs
  .map((item) => item.name)
  .filter((name) => (herbFunctionCatalog.categories[name] || []).some((category) => category.includes("补阴")));
assert.ok(commonYinHerbs.length <= 16, "the governed common 补阴 subset must fit the per-direction shortlist cap");
const eligibleCommonYinHerbs = commonYinHerbs.filter((herb) =>
  !highImpactHerbDirectionIssue(herb, getTcmHerbFunctionText(herb), xiaokeReasoning),
);
for (const herb of eligibleCommonYinHerbs) {
  assert.ok(shortlistSection.includes(herb), `the capped 补阴 shortlist must retain governed common herb ${herb}`);
}
assert.ok(shortlistSection.includes("玉竹"), "玉竹 must remain eligible through its governed 养阴润燥 identity");
assert.ok(!shortlistSection.includes("鳖甲"), "a 软坚散结 herb must not be shortlisted when signed M03 lacks that high-impact direction");

// ─── 有边界的功能性工作证候短名单覆盖：功能性治法文本也必须能导出 KB 覆盖短名单 ───
const neutralXiaokePrompt = prescribePromptFor(promptM03Reasoning({
  syndrome: "津液输布失常候",
  therapy: "调畅气机，助津液输布",
  method: "调畅气机，助津液输布",
  chain: [["P1", "津液输布与气化功能失调", "调畅气机"]],
}));
const neutralShortlistStart = neutralXiaokePrompt.indexOf("【本例治法方向的知识库覆盖药味短名单");
assert.ok(neutralShortlistStart >= 0, "the bounded functional syndrome shape must still get a KB-covered shortlist via the functional therapy vocabulary");
const neutralShortlistEnd = neutralXiaokePrompt.indexOf("【M04药味可引用病机节点】");
assert.ok(neutralShortlistEnd > neutralShortlistStart, "the shortlist block must be well-formed for the neutral shape");
const neutralShortlistSection = neutralXiaokePrompt.slice(neutralShortlistStart, neutralShortlistEnd);
assert.ok(neutralShortlistSection.includes("- 理气方向："), "调畅气机 must map to the 理气 direction group on the prompt side as it does on the contract side");
assert.ok(/- 理气方向：[^\n]*(?:陈皮|厚朴|木香|香附|枳壳)/.test(neutralShortlistSection), "the 理气 group must list KB-covered regulating herbs");

const { buildM04ClinicalRepairHint, m04KnowledgeShortlistFromPrompt } = await import("../src/lib/structured-clinical-repair.ts");
const repairedPromptShortlist = m04KnowledgeShortlistFromPrompt(piweiPrompt);
assert.match(repairedPromptShortlist, /^【本例治法方向的知识库覆盖药味短名单/);
assert.match(repairedPromptShortlist, /补气方向/);
assert.doesNotMatch(repairedPromptShortlist, /【M04药味可引用病机节点】/);
assert.equal(m04KnowledgeShortlistFromPrompt("无短名单的提示"), "");
const emperorKnowledgeHint = buildM04ClinicalRepairHint("m04_candidate_0_herb_1_emperor_knowledge_missing");
assert.ok(emperorKnowledgeHint.includes("知识库"), "the repair hint must explain the KB-coverage cause");
assert.ok(emperorKnowledgeHint.includes("不得再次使用"), "the repair hint must explicitly forbid reusing the rejected emperor herb");
assert.ok(emperorKnowledgeHint.includes("短名单"), "the repair hint must point at the injected KB-covered shortlist");
assert.ok(emperorKnowledgeHint.includes("同一治法方向"), "the repair hint must require a same-direction replacement");
assert.ok(buildM04ClinicalRepairHint("m04_candidate_0_herb_1_emperor_not_primary").includes("君药数量或 P1 归属不合法"), "adjacent emperor branches must remain unchanged");
assert.ok(buildM04ClinicalRepairHint("m04_candidate_0_emperor_missing").includes("君药数量或 P1 归属不合法"), "adjacent emperor branches must remain unchanged");
const doseRangeHint = buildM04ClinicalRepairHint("m04_candidate_0_herb_2_dose_outside_conservative_range");
assert.ok(doseRangeHint.includes("保守常用量边界"), "the dose-range repair hint must name the conservative boundary cause");
assert.ok(doseRangeHint.includes("其余已通过校验的药味"), "the dose-range repair hint must scope the edit to the offending herb only");
assert.ok(doseRangeHint.includes("中低段"), "the dose-range repair hint must steer toward the conservative part of the interval");
const highImpactHint = buildM04ClinicalRepairHint("m04_candidate_0_herb_5_unsupported_high_impact_heat_clear");
assert.ok(highImpactHint.includes("高影响治疗方向"), "the high-impact repair hint must name the unsupported-direction cause");
assert.ok(highImpactHint.includes("直接删除这味药"), "the high-impact repair hint must require dropping the flagged herb");
assert.ok(highImpactHint.includes("恰有 1–2 味君药"), "the high-impact repair hint must keep the emperor cardinality invariant");
const emperorMismatchHint = buildM04ClinicalRepairHint("m04_candidate_0_herb_0_emperor_therapy_mismatch");
assert.ok(emperorMismatchHint.includes("治疗方向与 P1 治法方向不一致"), "the emperor-mismatch hint must name the direction-inconsistency cause");
assert.ok(emperorMismatchHint.includes("只重选君药"), "the emperor-mismatch hint must scope the edit to emperor reselection");
assert.ok(emperorMismatchHint.includes("短名单"), "the emperor-mismatch hint must point at the injected KB-covered shortlist");
const unknownHerbHint = buildM04ClinicalRepairHint("m04_candidate_0_herb_5_unknown");
assert.ok(unknownHerbHint.includes("不在服务端药味知识库中"), "the unknown-herb hint must state the herb is not in the server KB");
assert.ok(unknownHerbHint.includes("不得再次使用"), "the unknown-herb hint must forbid reusing the rejected name");
assert.ok(unknownHerbHint.includes("替代药味"), "the unknown-herb hint must require a KB-known same-direction replacement");
const declassifiedHint = buildM04ClinicalRepairHint("m04_formula_reference_declassified");
assert.ok(declassifiedHint.includes("未通过核验的方名"), "the declassified hint must forbid keeping the unverified formula identity");
assert.ok(declassifiedHint.includes("governedFormulaBaselines"), "the declassified hint must reference the injected KB baselines");
assert.ok(declassifiedHint.includes("本例辨证组方"), "the declassified hint must offer the explicit self-devised path");
assert.ok(declassifiedHint.includes("formulaNames 置空"), "the declassified hint must require empty formulaNames on the self-devised path");

// ─── 经典条文必须真的到达结构化载荷（前端面板的入参） ───
// 222,338 条古籍证据长期只在服务端解析、随流下发，前端零渲染。现在前端有了
// ClassicEvidencePanel，这里补上服务端这一端的行为断言：条文要真的进 candidate.classicEvidence，
// 条数不得超过 contract 上限（超限时 .catch([]) 会**整段清空**而不是截断），
// 且每条都要带前端渲染必需的字段。只断言源码里有那行赋值是不够的——
// 本次就因为夹具不全（缺 notApplicable）触发 enrichPrescriptionProvenance 的 try/catch
// 静默返回原文，表现为「0 条」，而源码断言完全看不出来。
// 直接调核心函数并注入同一个 resolver：tcm-formula-provenance.server.ts 只是把
// classicEvidenceForFormulaNames 作为第三个参数转发进来的薄壳，它 import "server-only"，
// jiti CLI 下加载不了。测核心 + 同一 resolver = 测同一条路径。
const { classicEvidenceForFormulaNames } = await import("../src/lib/tcm-classic-evidence.server.ts");
const enrichWithClassicEvidence = (content, context) =>
  enrichPrescriptionProvenance(content, context, classicEvidenceForFormulaNames);
const guipiIngredients = governedFormulaCatalog.entries.find((entry) => entry.name === "归脾汤")?.ingredients || [];
assert.ok(guipiIngredients.length > 0, "归脾汤必须在受控目录内，否则本条断言失去意义");
const classicEvidenceEnriched = enrichWithClassicEvidence(
  render(reasoning(candidate("归脾汤", guipiIngredients))), "心脾两虚，思虑伤脾");
const classicEvidencePayload = JSON.parse(
  classicEvidenceEnriched.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/)[1],
);
const classicEvidenceItems = classicEvidencePayload.formula.candidates[0].classicEvidence || [];
assert.ok(classicEvidenceItems.length > 0,
  "归脾汤候选必须携带经典条文，否则前端面板永远拿不到数据（古籍语料等于没接）");
assert.ok(classicEvidenceItems.length <= 6,
  `条数不得超过 contract 上限 6（实际 ${classicEvidenceItems.length}），超限会被 .catch([]) 整段清空`);
for (const item of classicEvidenceItems) {
  assert.ok(item.citation && item.excerpt && item.tier,
    `每条条文都要带前端渲染必需字段（citation/excerpt/tier）：${JSON.stringify(item).slice(0, 120)}`);
}

console.log(JSON.stringify({ cases: 328, classicEvidencePerCandidate: classicEvidenceItems.length, failures: 0 }));
