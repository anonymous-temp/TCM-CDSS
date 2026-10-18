// 10/18 逐模块验收（M 360 / X 110 / 甲方 10×3）辅助中药饮片板块的余项（2026-10-19）。
//
// 评审不通过的 102 例里，扣掉「跟着 M03 证型走」的 57 例，剩下的大半是服务端与知识库的缺陷。每一节对应其中一类；
// 每条断言都有反证（把改动撤掉或换成对照输入后必须变红，反证记录见提交说明）。
//
//   1 知识库功用文本里混入的错条（黄连「舒肝和胃」、黄柏「滋阴清热」、佩兰「理气活血」、商陆「清热凉血」、鹿角胶「补中益气」…）
//     —— 药味表的服务端兜底、交付面去伪的参照都读这一份，错条本身就是「药物功效写错」的来源
//   2 身份目录别名错链：椒目（花椒的种子，苦寒利水）被归成花椒；水半夏（犁头尖属）被归成半夏
//   3 随证加减：触发条件与病历相抵（「若泛酸」对「无反酸烧心」）、或本例不可能出现（81 岁女性「若…遗精腰酸」）的不列
//   4 方义：阴阳互求说反（左归丸写「阴中求阳」）、引经方向写反（桔梗「载药下行」）、修复提示语混进方义、自言自语；
//     服务端删药之后方义按剩下的药再审一遍
//   5 教材按偏颇分列两段治法（尿浊·肾虚不固证「偏肾阴虚者…；偏阳虚者…」）时按已签名的病性选一段
//   6 鲜汁、乳类（藕汁、牛乳）兑服、不入煎
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const check = (name, run) => {
  cases += 1;
  try {
    const result = run();
    if (result && typeof result.then === "function") throw new Error("用例体不得是 async：异常会被吞掉");
  } catch (error) {
    process.exitCode = 1;
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
};

const kb = await jiti.import("../src/lib/tcm-knowledge.ts");
const { resolveGovernedTcmHerbIdentity } = await jiti.import("../src/lib/tcm-herb-identity.ts");
const { herbFunctionClaimUnsupportedPhrases } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const review = await jiti.import("../src/lib/formula-analysis-review.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const decoction = await jiti.import("../src/lib/herb-decoction-rules.ts");
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");

const TEXTBOOK = "中医补充数据/灵丹GitHub/TCM Educational Materials.txt";
const textbookLines = existsSync(TEXTBOOK) ? readFileSync(TEXTBOOK, "utf8").split("\n") : undefined;

// ───── 1 知识库功用错条 ─────
const corrections = JSON.parse(readFileSync("src/data/tcm-herb-function-corrections.source.json", "utf8"));
check("1.1 黄连、黄柏、佩兰、商陆、鹿角胶、何首乌的功用文本不再带教材不给的条目，教材原有的功效照留", () => {
  const text = (herb) => kb.getTcmHerbFunctionText(herb);
  assert.doesNotMatch(text("黄连"), /舒肝和胃/);
  assert.match(text("黄连"), /清热燥湿/);
  assert.doesNotMatch(text("黄柏"), /滋阴清热/);
  assert.match(text("黄柏"), /清热燥湿/);
  assert.doesNotMatch(text("佩兰"), /理气活血|生津止渴/);
  assert.match(text("佩兰"), /化湿/);
  assert.doesNotMatch(text("商陆"), /清热凉血|散风热/);
  assert.doesNotMatch(text("鹿角胶"), /补中益气|安胎/);
  assert.match(text("鹿角胶"), /温补肝肾/);
  assert.doesNotMatch(text("何首乌"), /大补元气|益气力/);
  assert.doesNotMatch(text("皂角刺"), /祛痰开窍/);
});
check("1.2 盐黄柏（滋阴降火宜盐炙用）保留「滋阴清热」：剔除按原名先查，炮制品单列的豁免挡住按规范名回落", () => {
  assert.match(kb.getTcmHerbFunctionText("盐黄柏"), /滋阴清热/);
});
check("1.3 服务端兜底的功效栏不再从知识库对出「舒肝和胃」（验收集 M 三例黄连标「舒肝和胃」都出自这里）", () => {
  const shown = kb.getTcmHerbFunctionDisplayText("黄连", "佐", "郁火上炎，恶心烦闷", "泻热导滞，润肠通便，兼清郁火和胃");
  assert.doesNotMatch(shown, /舒肝/, shown);
});
check("1.4 交付面去伪的参照随之收紧：模型写黄柏「滋阴清热」、佩兰「理气活血」会被认出无依据；知母「滋阴」照旧有依据（对照）", () => {
  assert.ok(herbFunctionClaimUnsupportedPhrases("清热燥湿，滋阴清热", kb.herbFunctionKnowledgeForDisplay("黄柏")).includes("滋阴"));
  assert.ok(herbFunctionClaimUnsupportedPhrases("化湿和中，理气活血", kb.herbFunctionKnowledgeForDisplay("佩兰")).includes("活血"));
  assert.deepEqual(herbFunctionClaimUnsupportedPhrases("清热泻火，滋阴润燥", kb.herbFunctionKnowledgeForDisplay("知母")), []);
});
// 本轮新加的行：原文必须逐字在所引那一行。此前的三行（黑芝麻、益智、青蒿）所引行号与语料差 1–2 行，只要求原文在所引行附近。
const ROWS_2026_10_19 = ["黄连", "黄柏", "盐黄柏", "佩兰", "商陆", "鹿角胶", "鹿角", "鹿角霜", "鹿茸", "何首乌", "白茅根", "百合", "天冬", "石斛",
  "肉苁蓉", "巴戟天", "淫羊藿", "高良姜", "银柴胡", "茜草", "侧柏叶", "皂角刺", "白前", "决明子"];
check("1.5 每一条剔除都附教材原文与行号，原文逐字在本地教材语料里（本轮新加的行逐字在所引那一行；本机没有语料时只核对格式）", () => {
  for (const name of ROWS_2026_10_19) assert.ok(corrections.herbs[name], `${name} 未登记`);
  for (const [herb, entry] of Object.entries(corrections.herbs)) {
    assert.ok(Array.isArray(entry.unsupported), herb);
    assert.ok(Array.isArray(entry.evidence) && entry.evidence.length > 0, `${herb} 缺出处`);
    for (const item of entry.evidence) {
      assert.ok(Number.isInteger(item.line) && item.text, `${herb} 出处缺行号或原文`);
      if (!textbookLines) continue;
      const window = ROWS_2026_10_19.includes(herb) ? [item.line - 1] : [-3, -2, -1, 0, 1, 2, 3].map((delta) => item.line - 1 + delta);
      assert.ok(window.some((index) => (textbookLines[index] || "").includes(item.text)), `${herb} L${item.line} 原文对不上`);
    }
  }
});

// ───── 2 身份目录别名错链 ─────
const catalog = JSON.parse(readFileSync("src/data/tcm-formula-governed-catalog.json", "utf8"));
check("2.1 椒目是独立的一味：不再归成花椒；功效取教材「利水消肿，降气平喘」，分类不是温里药；药典未收载，由医师定量", () => {
  assert.equal(resolveGovernedTcmHerbIdentity("椒目").canonicalName, "椒目");
  assert.equal(kb.isKnownTcmHerbName("椒目"), true);
  const text = kb.getTcmHerbFunctionText("椒目");
  assert.match(text, /利水消肿，降气平喘/);
  assert.doesNotMatch(text, /温中|温里/);
  assert.deepEqual(kb.getTcmHerbFunctionCategories("椒目").filter((item) => /温里/.test(item)), []);
  assert.equal(kb.getTcmHerbDoseLimit("椒目")?.max === 6 && kb.getTcmHerbDoseLimit("椒目")?.basis?.includes("药典"), false, "不得再套花椒 3–6g 的药典边界");
  assert.equal(kb.isClinicianDoseHerb("椒目"), true);
  assert.match(kb.getTcmHerbFunctionText("花椒"), /温中/, "对照：花椒本身不变");
});
check("2.2 疏凿饮子、己椒苈黄丸的椒目在目录里链到椒目本身，仍可编译剂量（椒目登记在医师定量表）", () => {
  for (const name of ["疏凿饮子", "己椒苈黄丸"]) {
    const entry = catalog.entries.find((item) => item.name === name && item.ingredientLinks.some((link) => link.rawName === "椒目"));
    assert.ok(entry, name);
    assert.equal(entry.ingredientLinks.find((link) => link.rawName === "椒目").canonicalName, "椒目", name);
    assert.equal(entry.doseCompilationEligible, true, name);
  }
});
check("2.3 水半夏（鞭檐犁头尖的块茎）不再自动落成半夏；九节菖蒲照旧归石菖蒲（教材：古代本草「石菖蒲亦称九节菖蒲」，古方用名成立）", () => {
  const water = resolveGovernedTcmHerbIdentity("水半夏");
  assert.equal(water.canonicalName, undefined);
  assert.notEqual(kb.getTcmHerbDoseLimit("水半夏")?.min, 3, "不得套半夏的药典剂量");
  assert.equal(resolveGovernedTcmHerbIdentity("九节菖蒲").canonicalName, "石菖蒲");
});

// ───── 3 随证加减 ─────
check("3.1 触发条件里的症状病历明确否认：全部否认才算（泛酸对「无反酸烧心」、痒对「无痛痒感」）", () => {
  const record = "胃脘隐痛3年。无恶心呕吐，无反酸烧心，无口干口苦。";
  assert.equal(compiler.modificationConditionContradictsRecord("若泛酸", record), true);
  assert.equal(compiler.modificationConditionContradictsRecord("若痒甚", "全身散在红色丘疹1周，无痛痒感。"), true);
  assert.equal(compiler.modificationConditionContradictsRecord("若呕吐频作", "头晕伴肢体乏力，无明显头痛，无恶心呕吐。"), true);
});
check("3.2 对照：病历别处肯定写到的、条件里另有未被否认的症状、病历没提的、病机说法，都不判相抵", () => {
  assert.equal(compiler.modificationConditionContradictsRecord("若恶心明显", "食后烧心、恶心，喜冷食。既往：头晕时无恶心呕吐。"), false, "病历别处肯定写到恶心");
  assert.equal(compiler.modificationConditionContradictsRecord("若心悸、气短、乏力明显", "无心悸，乏力气短，纳可。"), false, "只有心悸被否认");
  assert.equal(compiler.modificationConditionContradictsRecord("若脾气亏虚，甚或脏器下垂", "腰痛1年，饮食尚可，二便调。"), false);
  assert.equal(compiler.modificationConditionContradictsRecord("若热偏重，口苦反酸明显", "偶发口干口苦，无发热。"), false);
  assert.equal(compiler.modificationConditionContradictsRecord("若泛酸", "胃脘隐痛，时有反酸。"), false);
});
check("3.3 本例不可能出现的症状：遗精给女性、经带给男性或已绝经者不列；性别不明、育龄女性照列（对照）", () => {
  const state = (sex, age, presentHistory = "胸闷心慌1月。") => ({ patient: { sex, age }, chiefComplaint: "胸闷心慌", symptoms: { presentHistory }, conversation: [] });
  assert.equal(compiler.modificationConditionOutsidePopulation("若肾阴亏虚，虚火妄动，遗精腰酸", state("女", 81)), true);
  assert.equal(compiler.modificationConditionOutsidePopulation("若经行量多或经漏淋沥不止", state("女", 45, "既往月经规则，现绝经4年。")), true);
  assert.equal(compiler.modificationConditionOutsidePopulation("若带下量多", state("男", 40)), true);
  assert.equal(compiler.modificationConditionOutsidePopulation("若遗精腰酸", state("男", 40)), false);
  assert.equal(compiler.modificationConditionOutsidePopulation("若经行腹痛", state("女", 32, "月经后期量少半年。")), false);
  assert.equal(compiler.modificationConditionOutsidePopulation("若遗精腰酸", state("", 40)), false);
});

const priorFor = (diseaseName, primarySyndrome) => ReasoningV2Schema.parse({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: diseaseName, primarySyndrome, overallPathogenesis: "脾胃虚寒，中焦失运", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "胃脘隐痛，喜温喜按", syndromeEvidence: "胃脘隐痛，喜温喜按", pathogenesis: "脾胃虚寒，中焦失运", therapyDirection: "温中健脾" }] },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "温中健脾，和胃止痛", subTherapies: [{ therapy: "温中健脾", targetPathogenesis: "脾胃虚寒", priority: "主要" }] },
  formula: { candidates: [], patentAndWestern: [], modifications: [] },
});
// 病名、证名不在教材表里：条件式加减（「若…」）在这里是合格的触发，下面只看本节新加的两条判据。
const prior = priorFor("测评胃病", "测评虚寒证");
const compile = (caseState) => compiler.compileM04Proposal({
  candidate: {
    name: "自拟方", applicable: "胃脘隐痛喜温。", notApplicable: "实热证不用。",
    herbs: [
      { name: "党参", dose: "12g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "健脾益气" },
      { name: "白术", dose: "10g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "健脾燥湿" },
      { name: "茯苓", dose: "10g", role: "佐", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "健脾渗湿" },
      { name: "炙甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "调和诸药" },
    ].map((herb) => ({ ...herb, processing: null, isToxic: false, decoctionRequirement: null })),
    formulaAnalysis: "党参健脾益气为君，白术健脾燥湿为臣，茯苓健脾渗湿为佐，炙甘草调和诸药为使。",
    decoction: { doseCount: "7剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，煎服", followUpNode: "7日复诊" },
  },
  patentAndWestern: [],
  modifications: [
    { trigger: "若泛酸", targetRef: "P1", actionType: "add", herbName: "海螵蛸", dose: "10g", reason: "制酸止痛" },
    { trigger: "若遗精腰酸", targetRef: "P1", actionType: "add", herbName: "芡实", dose: "10g", reason: "益肾固精" },
    { trigger: "若脘腹胀满", targetRef: "P1", actionType: "add", herbName: "陈皮", dose: "6g", reason: "理气和胃" },
  ],
  nonPharma: { diet: "宜温热易消化饮食，忌生冷。", lifestyle: "规律作息。", emotion: "调畅情志。", precautions: [], tcmTreatments: [] },
}, prior, caseState);
const base = { id: "r1019-mod", phase: "prescribe", conversation: [], diagnosis: "", prescription: "", riskAssessment: "", maxQuestionRounds: 1, chiefComplaint: "胃脘隐痛3年" };
check("3.4 编译器：81 岁女性、病历「无反酸烧心」时，「若泛酸」「若遗精腰酸」两条不列并记明原因；「若脘腹胀满」照列", () => {
  const formula = compile({ ...base, patient: { sex: "女", age: 81 }, symptoms: { presentHistory: "胃脘隐痛3年，喜温喜按。无恶心呕吐，无反酸烧心。" } }).formula;
  assert.deepEqual(formula.modifications.map((item) => item.herbName), ["陈皮"]);
  const codes = formula.modificationReview.droppedReasons.map((item) => item.code);
  assert.ok(codes.includes("trigger_contradicts_record"), JSON.stringify(codes));
  assert.ok(codes.includes("trigger_outside_population"), JSON.stringify(codes));
});
check("3.5 对照：40 岁男性、病历「时有反酸」时三条都照列", () => {
  const formula = compile({ ...base, patient: { sex: "男", age: 40 }, symptoms: { presentHistory: "胃脘隐痛3年，喜温喜按，时有反酸。" } }).formula;
  assert.deepEqual(formula.modifications.map((item) => item.herbName).sort(), ["海螵蛸", "芡实", "陈皮"].sort());
});

// ───── 4 方义 ─────
const reviewed = (text, herbs) => review.reviewAuthoredFormulaAnalysis(text, herbs);
check("4.1 左归丸写成「阴中求阳」改回教材「阳中求阴」；右归丸「阴中求阳」不动；同时点到左归丸与右归丸的不判（对照）", () => {
  const left = reviewed("本方以左归丸为基础加减。熟地黄为君，山药、山茱萸、枸杞子为臣，鹿角胶、龟甲胶为佐。全方补而不泻、阴中求阳，共奏滋补肾阴之效。", ["熟地黄", "山药", "山茱萸", "枸杞子", "鹿角胶", "龟甲胶"]);
  assert.match(left.text, /阳中求阴/);
  assert.doesNotMatch(left.text, /阴中求阳/);
  const right = reviewed("本方以右归丸为基础加减。附子、肉桂为君，熟地黄、山茱萸为臣，取阴中求阳之意。", ["附子", "肉桂", "熟地黄", "山茱萸"]);
  assert.match(right.text, /阴中求阳/);
  const both = reviewed("本方取左归丸、右归丸之意加减。熟地黄、附子为君，山茱萸为臣，阴中求阳。", ["熟地黄", "附子", "山茱萸"]);
  assert.match(both.text, /阴中求阳/);
});
check("4.2 桔梗「载药下行」改成「载药上行」；牛膝「引血下行」、桔梗「载药上行」原样（对照）", () => {
  const wrong = reviewed("本方为自拟方。大血藤、败酱草为君，清热解毒；蒲公英、紫花地丁为臣；桔梗为使，载药下行、调和诸药。全方清利与化瘀并行。", ["大血藤", "败酱草", "蒲公英", "紫花地丁", "桔梗"]);
  assert.match(wrong.text, /桔梗为使，载药上行/);
  const right = reviewed("本方以血府逐瘀汤为基础加减。桃仁、红花为君；牛膝活血引血下行，桔梗载药上行，一升一降；甘草调和诸药。", ["桃仁", "红花", "牛膝", "桔梗", "甘草"]);
  assert.match(right.text, /牛膝活血引血下行，桔梗载药上行/);
  assert.ok(!right.adjustments.includes("guide_direction_corrected"));
});
check("4.3 修复提示语混进方义（「因本例签名治法与患者事实均未成立温阳方向，故不保留该药」）只删这半句；临床理由「去肉桂之温燥」不动（对照）", () => {
  const leaked = reviewed("本方以六味地黄丸为基础加减。熟地黄滋肾填精为君；山茱萸、山药为臣。去肉桂，因本例签名治法与患者事实均未成立温阳方向，故不保留该药。全方滋阴降火。", ["熟地黄", "山茱萸", "山药"]);
  assert.doesNotMatch(leaked.text, /签名|成立|不保留/);
  assert.match(leaked.text, /去肉桂。全方/);
  const plain = reviewed("本方以十全大补丸为基础加减，去肉桂之温燥，加黄芪以增补气生血之力。黄芪、熟地黄为君；人参、白术为臣。", ["黄芪", "熟地黄", "人参", "白术"]);
  assert.match(plain.text, /去肉桂之温燥/);
  const clinical = reviewed("本方以六味地黄丸为基础加减。熟地黄滋肾填精为君；山茱萸、山药为臣。去肉桂，因本例阴虚内热，故不保留。全方滋阴降火。", ["熟地黄", "山茱萸", "山药"]);
  assert.match(clinical.text, /因本例阴虚内热，故不保留/, "临床理由写成「因…故不保留」的不删");
});
check("4.4 自言自语：「加黄芪未入而以黄芪固表」整句不留，「去僵蚕未加」只留「去僵蚕」；讲煎法的「未入煎」不动（对照）", () => {
  const talk = reviewed("本方以七福饮为基础加减，加黄芪未入而以黄芪固表。人参大补心气、熟地黄滋阴养血，二味共为君药；黄芪、白术益气固表。", ["人参", "熟地黄", "黄芪", "白术"]);
  assert.doesNotMatch(talk.text, /未入/);
  assert.match(talk.text, /^本方以七福饮为基础加减。人参/);
  const removed = reviewed("本方以普济消毒饮为基础加减，去僵蚕未加，专治温毒。黄芩、黄连清热解毒为君；连翘、牛蒡子为臣。", ["黄芩", "黄连", "连翘", "牛蒡子"]);
  assert.match(removed.text, /去僵蚕，专治温毒/);
  const route = reviewed("本方以大承气汤为基础加减，大黄为君，后下；另加芒硝溶服而未入煎，以存峻下之性；厚朴、枳实为臣。", ["大黄", "芒硝", "厚朴", "枳实"]);
  assert.match(route.text, /另加芒硝溶服而未入煎/);
});
check("4.5 服务端删掉薤白之后，方义里讲薤白的地方随之去掉；薤白仍在方中时原样（对照）", () => {
  const analysis = "本方以涤痰汤为基础加减。瓜蒌、薤白为君，一宽胸涤痰、一通阳散结；枳实为臣，破气宽胸；茯苓健脾渗湿以绝生痰之源，竹茹清化痰热，共为佐；甘草调和诸药为使。";
  assert.doesNotMatch(review.formulaAnalysisAfterHerbRemoval(analysis, ["瓜蒌", "枳实", "茯苓", "竹茹", "甘草"]), /薤白/);
  assert.match(review.formulaAnalysisAfterHerbRemoval(analysis, ["瓜蒌", "薤白", "枳实", "茯苓", "竹茹", "甘草"]), /瓜蒌、薤白为君/);
});

// ───── 5 教材分两段的治法 ─────
const urinePrior = (natureItems) => ReasoningV2Schema.parse({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "尿浊", primarySyndrome: "肾虚不固证", overallPathogenesis: "肾虚封藏失职，精微下泄", recommendedFormulaDirection: "知柏地黄丸加减", recommendedFormulaNames: [], formulaSelectionMode: "none" },
  pathogenesis: {
    chain: [{ nodeId: "P1", patientFact: "尿浊如脂膏3月", syndromeEvidence: "尿浊如脂膏3月", pathogenesis: "肾虚封藏失职，精微下泄", therapyDirection: "补肾固摄" }],
    natureDifferentiation: { items: natureItems },
  },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "补肾固摄，分清泌浊", subTherapies: [{ therapy: "补肾固摄", targetPathogenesis: "肾虚不固", priority: "主要" }] },
  formula: { candidates: [], patentAndWestern: [], modifications: [] },
});
check("5.1 病性「阳虚」：治法取「温肾固摄」一段，方取鹿茸补涩丸；不再把两段原文照抄进治法栏", () => {
  const out = provenance.withDeterministicFormulaReferences(urinePrior(["阳虚"]));
  assert.equal(out.therapy.overallMethod, "温肾固摄");
  assert.match(out.overview.recommendedFormulaDirection, /鹿茸补涩丸/);
});
check("5.2 病性「阴虚」：取「滋阴益肾」与知柏地黄丸；病性两段都对不上（气虚、湿热）时不锚定治法、方向照旧（对照）", () => {
  const yin = provenance.withDeterministicFormulaReferences(urinePrior(["阴虚"]));
  assert.equal(yin.therapy.overallMethod, "滋阴益肾");
  assert.match(yin.overview.recommendedFormulaDirection, /知柏地黄丸/);
  const neither = provenance.withDeterministicFormulaReferences(urinePrior(["气虚", "湿热"]));
  assert.equal(neither.therapy.overallMethod, "补肾固摄，分清泌浊");
  assert.doesNotMatch(neither.therapy.overallMethod, /偏/);
});
check("5.3 对照：普通一段治法的教材行照旧锚定原文（感冒·风寒束表证）", () => {
  const cold = ReasoningV2Schema.parse({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: "感冒", primarySyndrome: "风寒束表证", overallPathogenesis: "风寒束表，肺气失宣", recommendedFormulaDirection: "荆防败毒散加减", recommendedFormulaNames: [], formulaSelectionMode: "none" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "恶寒重发热轻", syndromeEvidence: "恶寒重发热轻", pathogenesis: "风寒束表", therapyDirection: "辛温解表" }] },
    therapy: { overallPrinciple: "实则泻之", overallMethod: "疏风散寒", subTherapies: [{ therapy: "辛温解表", targetPathogenesis: "风寒束表", priority: "主要" }] },
    formula: { candidates: [], patentAndWestern: [], modifications: [] },
  });
  assert.match(provenance.withDeterministicFormulaReferences(cold).therapy.overallMethod, /辛温解表/);
});

// ───── 6 鲜汁、乳类 ─────
check("6.1 藕汁、牛乳兑入药液服、不入煎；不写成「不入汤剂」（那会被合同读成须从方中删除）", () => {
  for (const name of ["藕汁", "牛乳", "生姜汁"]) {
    const rule = decoction.decoctionRuleForHerb(name);
    assert.deepEqual(rule?.required, ["兑服"], name);
    assert.deepEqual(rule?.prohibited, [], name);
    assert.equal(decoction.specialDecoctionPhrase(name), `${name}兑入药液服（不入煎）`);
  }
});
check("6.2 对照：同名饮片照旧按饮片（藕节、生姜不兑服）；冲服的药仍写「冲服（不入煎）」", () => {
  assert.notDeepEqual(decoction.decoctionRuleForHerb("藕节")?.required, ["兑服"]);
  assert.equal(decoction.specialDecoctionPhrase("生姜"), "");
  assert.match(decoction.specialDecoctionPhrase("三七", "研末冲服"), /冲服（不入煎）/);
});

// ───── 7 方义药物功效核对（小模型报疑 + 确定性核实，只有第二道能删字） ─────
// 夹具文字取自 10/18 交付的方义原文（甲方标准病历 10、6；验收集 M、X）。小模型的输出用桩，第二道用运行时的参考功效。
Object.assign(process.env, {
  AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://api.deepseek.com",
  OPENAI_MODEL: "deepseek-flash", CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash", CDSS_SMALL_TASK_MEMO: "false",
});
const claimCheck = await jiti.import("../src/lib/m04-formula-analysis-claim-check.server.ts");
const ref = claimCheck.herbClaimReferenceText;
const verify = (analysis, herbs, claims) => review.removeVerifiedHerbClaims(analysis, herbs, claims, ref);
const CASE10_R3 = "本方以清经散为基础加减。牡丹皮、地骨皮同为君药，直清冲任伏热、凉血以制经血妄行，针对热迫血行这一中心环节；黄柏苦寒清下焦、泄肝火，青蒿后下清透虚热并生津除烦，二药为臣，分治热扰肝胆与津伤；白芍养血敛阴、柔肝缓急，大熟地滋阴养血以补热灼所伤之阴，共为佐药，使清热而不伤正；白茯苓健脾渗湿、顾护中焦，防寒凉滋腻碍胃，为使药。全方清、滋、渗并用，共奏清热凉血调经、止血之功。";
const CASE10_HERBS = ["牡丹皮", "地骨皮", "黄柏", "青蒿", "白芍", "熟地黄", "茯苓"];
const CASE6_R1 = "本方以左归丸为基础加减，纯补无泻，专走肾阴。熟地黄为君，直补肾阴、填精益髓，使腰府筋脉得养；麸炒山药、山萸肉、枸杞子三味为臣，一补脾固肾、一收敛固涩、一益精明目，共助君药厚积阴精；盐菟丝子、酒川牛膝佐助补肾强腰、引药下行，使药力直达腰府；鹿胶珠、龟胶珠为血肉有情之品，滋阴养血兼退虚热，正对阴液不能上承、虚热内生之兼机。全方补而不泻、阳中求阴，共奏滋补肾阴、濡养筋脉之效。";
const CASE6_HERBS = ["熟地黄", "山药", "山茱萸", "枸杞子", "菟丝子", "川牛膝", "鹿角胶", "龟甲胶"];
check("7.1 甲方病历 10：青蒿「生津」、黄柏「泄肝火」只删那一小段，清透虚热、清下焦照留", () => {
  const out = verify(CASE10_R3, CASE10_HERBS, [
    { herb: "黄柏", clause: "黄柏苦寒清下焦、泄肝火", claim: "泄肝火" },
    { herb: "青蒿", clause: "青蒿后下清透虚热并生津除烦", claim: "生津" },
  ]);
  assert.deepEqual(out.removals.map((item) => item.action), ["piece", "piece"], JSON.stringify(out.rejected));
  assert.match(out.text, /黄柏苦寒清下焦，青蒿后下清透虚热，二药为臣/);
  assert.doesNotMatch(out.text, /泄肝火|生津除烦/);
});
check("7.2 甲方病历 6：鹿胶珠、龟胶珠并列，「退虚热」二胶都不具备——删「兼退虚热」；黑芝麻、川木通「润燥通腑」只有黑芝麻有——只去掉川木通", () => {
  const six = verify(CASE6_R1, CASE6_HERBS, [{ herb: "鹿胶珠", clause: "鹿胶珠、龟胶珠为血肉有情之品，滋阴养血兼退虚热", claim: "退虚热" }]);
  assert.match(six.text, /鹿胶珠、龟胶珠为血肉有情之品，滋阴养血，正对/);
  const analysis = "本方以消风散合当归饮子为基础加减。当归、生地黄养血润燥，共为君药；防风、荆芥疏风止痒，为臣；黑芝麻、川木通润燥通腑，兼顾燥热内灼、肠道失润；甘草调和诸药。全方祛风清热与养血润燥并行。";
  const out = verify(analysis, ["当归", "生地黄", "防风", "荆芥", "黑芝麻", "川木通", "甘草"], [{ herb: "川木通", clause: "黑芝麻、川木通润燥通腑", claim: "润燥通腑" }]);
  assert.deepEqual(out.removals.map((item) => item.action), ["herb_name"]);
  assert.match(out.text, /黑芝麻润燥通腑/);
});
check("7.3 对照：参考功效支持（知母「生津」）、几味药合说（「共奏化瘀止血之功」）、分说（「一…、一…」）、这味药也有其中一项（川芎「养血滋阴、行血上荣」）、君臣名单、片段里没有这味药的写法（「龟胶」）、片段不逐字——都不删", () => {
  const cases = [
    ["本方以消风散为基础。荆芥、防风为君；苦参清热止痒，知母清热生津，为臣；甘草调和诸药。全方疏风清热。", ["荆芥", "防风", "苦参", "知母", "甘草"], { herb: "知母", clause: "知母清热生津", claim: "生津" }, "reference_supports_claim"],
    ["本方以十灰散为基础。三七化瘀止血为君，与白及、仙鹤草共奏化瘀止血之功，为臣；甘草调和诸药为使。全方止血而不留瘀。", ["三七", "白及", "仙鹤草", "甘草"], { herb: "仙鹤草", clause: "与白及、仙鹤草共奏化瘀止血之功", claim: "化瘀" }, undefined],
    ["本方以泻白散为基础。桑白皮、黄芩为君，一泻肺中伏火、一清肝经郁热；地骨皮为臣；甘草为使。全方清泻肺热。", ["桑白皮", "黄芩", "地骨皮", "甘草"], { herb: "桑白皮", clause: "桑白皮、黄芩为君，一泻肺中伏火、一清肝经郁热", claim: "清肝经郁热" }, "distributive_clause"],
    ["本方以当归饮子为基础加减。当归、生地黄为君；知母、白芍、川芎、何首乌养血滋阴、行血上荣，兼顾血燥；甘草调和诸药。全方养血润燥。", ["当归", "生地黄", "知母", "白芍", "川芎", "何首乌", "甘草"], { herb: "川芎", clause: "知母、白芍、川芎、何首乌养血滋阴、行血上荣", claim: "养血滋阴" }, "partially_supported_group"],
    ["本方以麦门冬汤为基础加减。麦冬、桂枝为君，养阴润肺；半夏、人参为臣；甘草为使。全方养阴降逆。", ["麦冬", "桂枝", "半夏", "人参", "甘草"], { herb: "桂枝", clause: "麦冬、桂枝为君，养阴润肺", claim: "养阴" }, "role_list"],
    ["本方以左归丸为基础加减。熟地黄为君；山药、山茱萸为臣；鹿胶珠、龟胶珠为血肉有情之品，龟胶偏滋阴退虚热，鹿胶偏温养精血。全方补而不泻。", ["熟地黄", "山药", "山茱萸", "鹿角胶", "龟甲胶"], { herb: "龟甲胶", clause: "龟胶偏滋阴退虚热", claim: "退虚热" }, "herb_not_named_in_clause"],
    [CASE10_R3, CASE10_HERBS, { herb: "青蒿", clause: "青蒿后下清透虚热兼生津", claim: "生津" }, "not_verbatim"],
  ];
  for (const [analysis, herbs, claim, reason] of cases) {
    const out = verify(analysis, herbs, [claim]);
    assert.equal(out.removals.length, 0, `${claim.herb}「${claim.claim}」不得删：${JSON.stringify(out.removals)}`);
    assert.equal(out.text, analysis);
    if (reason) assert.equal(out.rejected[0]?.reason, reason, JSON.stringify(out.rejected));
  }
});
check("7.4 删完方义不再讲本方（短于 24 字或点到的本方药味不够）时一处都不改", () => {
  const analysis = "火麻仁润养脾胃以顾气阴两伤，甘草调和诸药为使。";
  const out = verify(analysis, ["火麻仁", "甘草"], [{ herb: "火麻仁", clause: "火麻仁润养脾胃以顾气阴两伤", claim: "润养脾胃" }]);
  assert.equal(out.text, analysis);
  assert.equal(out.removals.length, 0);
});
check("7.5 模型输出的结构核对：非 JSON、缺字段、超过 6 条都不放进第二道", () => {
  assert.deepEqual(claimCheck.parseFormulaAnalysisClaims("不是JSON"), []);
  assert.deepEqual(claimCheck.parseFormulaAnalysisClaims(JSON.stringify({ claims: [{ herb: "青蒿", clause: "" , claim: "生津" }] })), []);
  const many = Array.from({ length: 9 }, (_, index) => ({ herb: "青蒿", clause: `片段${index}`, claim: "生津" }));
  assert.equal(claimCheck.parseFormulaAnalysisClaims(JSON.stringify({ claims: many })).length, 6);
});

// 7.6 整条链：带哨兵的 M04 内容进、出（小模型用 fetch 桩）。异步部分先跑完，下面同步断言。
const completion = (payload) => new Response(JSON.stringify({
  id: "t", object: "chat.completion", model: "deepseek-flash",
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { headers: { "content-type": "application/json" } });
const wrapM04 = (analysis) => `前文\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
  formula: { candidates: [{ name: "清经散加减", herbs: CASE10_HERBS.map((name) => ({ name })), formulaAnalysis: analysis }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
const analysisOf = (content) => JSON.parse(content.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]).formula.candidates[0].formulaAnalysis;
const realFetch = globalThis.fetch;
let fetchCalls = 0;
const transformed = {};
try {
  globalThis.fetch = async () => { fetchCalls += 1; return completion({ claims: [{ herb: "青蒿", clause: "青蒿后下清透虚热并生津除烦", claim: "生津", reason: "青蒿无生津之功" }] }); };
  transformed.flagged = await claimCheck.checkFormulaAnalysisClaimsInContent(wrapM04(CASE10_R3));
  transformed.flaggedCalls = fetchCalls;
  globalThis.fetch = async () => { fetchCalls += 1; return completion({ claims: [] }); };
  transformed.clean = await claimCheck.checkFormulaAnalysisClaimsInContent(wrapM04(CASE10_R3));
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error("upstream down"); };
  transformed.failing = await claimCheck.checkFormulaAnalysisClaimsInContent(wrapM04(CASE10_R3));
  process.env.CDSS_M04_FORMULA_ANALYSIS_CLAIM_CHECK = "false";
  const before = fetchCalls;
  transformed.disabled = await claimCheck.checkFormulaAnalysisClaimsInContent(wrapM04(CASE10_R3));
  transformed.disabledCalls = fetchCalls - before;
} finally {
  globalThis.fetch = realFetch;
  delete process.env.CDSS_M04_FORMULA_ANALYSIS_CLAIM_CHECK;
}
check("7.6 内容进出：小模型报青蒿「生津」→ 只改方义这一处、其余字节不动；报空、上游出错、开关关闭（不发请求）都逐字节原样返回", () => {
  assert.equal(transformed.flaggedCalls, 1);
  assert.match(analysisOf(transformed.flagged), /青蒿后下清透虚热，二药为臣/);
  assert.match(analysisOf(transformed.flagged), /黄柏苦寒清下焦、泄肝火/, "模型没报的不动");
  assert.ok(transformed.flagged.startsWith("前文\n"));
  assert.equal(transformed.clean, wrapM04(CASE10_R3));
  assert.equal(transformed.failing, wrapM04(CASE10_R3));
  assert.equal(transformed.disabled, wrapM04(CASE10_R3));
  assert.equal(transformed.disabledCalls, 0);
});
check("7.7 接线：开方路由把核对注入 m04CandidateTransform；流层在首轮与两处修复轮的 finalize 之后各调一次，失败隔离只有一份", () => {
  const api = readFileSync("src/lib/diagnosis-api.ts", "utf8");
  const route = readFileSync("src/app/api/diagnosis/prescribe/route.ts", "utf8");
  assert.match(route, /m04CandidateTransform: \(content, transformSignal\) => checkFormulaAnalysisClaimsInContent\(content, transformSignal\)/);
  const calls = [...api.matchAll(/(\w+) = await transformM04Candidate\(\1\);/g)].map((match) => match[1]);
  assert.equal(new Set(calls).size, 3, JSON.stringify(calls));
  assert.deepEqual(new Set(calls), new Set(["authoritativeContent", "resolvedRetryContent", "secondResolved"]));
  for (const name of calls) {
    assert.match(api, new RegExp(`${name} = finalizeM04CandidateContent\\(${name}\\);\\n\\s*${name} = await transformM04Candidate\\(${name}\\);`), `${name}：须紧跟 finalize`);
  }
  assert.equal((api.match(/const transformM04Candidate = async/g) || []).length, 1);
  assert.match(api, /const transformM04Candidate = async[\s\S]{0,400}catch \{\n\s*return content;/);
});
check("7.8 参考数据：《中药学》功效与《方剂学》方解生成产物条数够、附药带所附正药；本机有语料时功效行逐字对得上", () => {
  const data = JSON.parse(readFileSync("src/data/tcm-herb-textbook-references.json", "utf8"));
  assert.ok(Object.keys(data.herbs).length >= 450);
  assert.ok(Object.keys(data.formulaCommentaries).length >= 200);
  assert.equal(data.herbs["龟甲胶"].parent, "龟甲");
  if (textbookLines) {
    for (const name of ["青蒿", "黄柏", "鹿角胶", "椒目"]) assert.ok(textbookLines[data.herbs[name].line - 1].includes(data.herbs[name].function.replace(/。$/u, "")), name);
  }
});

check("7.9 参考功效只取《方剂学》方解里这味药自己的作用：几味并列（「鹿角胶、菟丝子温润之品补阳益阴」）、合说（「两药相配，滋阴清热」「配入补阴方中」）不算——于是鹿角胶「滋阴」、青蒿「滋阴」无依据；教材明写的照算（白芍「利小便」）", () => {
  const deer = ref("鹿角胶");
  assert.match(deer, /鹿角胶补益精血，温壮肾阳/);
  assert.doesNotMatch(deer, /补阳益阴|补阴方中/);
  assert.deepEqual(review.unsupportedHerbClaimConcepts("滋阴", deer), ["yin_nourish"]);
  assert.doesNotMatch(ref("青蒿"), /滋阴清热/);
  assert.deepEqual(review.unsupportedHerbClaimConcepts("利水", ref("白芍")), []);
});

console.log(JSON.stringify({ suite: "r1019-herbs", cases, failures: process.exitCode ? "see above" : 0 }));
