// 10/19 第三轮：辅助中药饮片板块（药味表、方义、加减、煎服）独立评审余项与 10/18 模块验收补充项（2026-10-19）。
//
// 本地 12 轮甲方 10×3 与留出 32 例、M/X 验收集（2eb0a40）的评审不通过项，逐类修。每条断言都有反证：把对应改动撤掉
//（或换成对照输入）后必须变红；反证记录见提交说明。回放数字（748 份处方：M-r19b、X-r19b、local12-c10、local12-held）写在各函数注释里。
//
//   1 方义里的药名不是药味表的写法（病历 6「鹿胶珠、龟胶珠」对药味表鹿角胶、龟甲胶）：身份解析得出时改成药味表写法，
//     方义核对（小模型报疑＋确定性核实）因此能对上「鹿角胶…退虚热」
//   2 方义把调和药性说成煎法的作用（病历 6「以胶类烊化、菟丝子包煎调和药性」）
//   3 数量词「二者/三者/四者」与点到的药数不符（病历 7「四者」只有三味）
//   4 方义开头一句对原方的增删说法不实（病历 9「去煅石膏，加知母以清热生津」、X-G-1104 消渴方「去葛根」）
//   5 随证加减的药与病历记录的情况相抵（病历 3「加熟地黄」对「食欲下降、大便稀溏」）
//   6 加减条件只说睡不好、证与病不涉心神时，教材本证列明的安神加减也不列（S132、S158）
//   7 药味表上没有出处的特殊煎法（S054 肉豆蔻「后下」）
//   8 药味表角色与方义不一（病历 2 茯苓、酸枣仁），君药不动
//   9 知识库功用错条（枇杷叶「清热解暑」X-G-0811、蒺藜「益气化痰」、天竺黄「祛风除湿」）与解暑一类
//  10 原方里系统不编制用量的味没有列入时，方义补一句说明（乌头汤加减无川乌，RobustSDT-single_0443、X-G-1718）
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
const { herbFunctionClaimUnsupportedPhrases } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const review = await jiti.import("../src/lib/formula-analysis-review.ts");
const decoction = await jiti.import("../src/lib/herb-decoction-rules.ts");
const textbookIdentity = await jiti.import("../src/lib/herb-textbook-identity.ts");
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");
const { herbClaimReferenceText } = await jiti.import("../src/lib/m04-formula-analysis-claim-check.server.ts");
const hooks = compiler.m04CompilerTestHooks;

const TEXTBOOK = "中医补充数据/灵丹GitHub/TCM Educational Materials.txt";
const textbookLines = existsSync(TEXTBOOK) ? readFileSync(TEXTBOOK, "utf8").split("\n") : undefined;

const priorFor = (diseaseName, primarySyndrome) => ReasoningV2Schema.parse({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: diseaseName, primarySyndrome, overallPathogenesis: "脾胃虚寒，中焦失运", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "胃脘隐痛，喜温喜按", syndromeEvidence: "胃脘隐痛，喜温喜按", pathogenesis: "脾胃虚寒，中焦失运", therapyDirection: "温中健脾" }] },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "温中健脾，和胃止痛", subTherapies: [{ therapy: "温中健脾", targetPathogenesis: "脾胃虚寒", priority: "主要" }] },
  formula: { candidates: [], patentAndWestern: [], modifications: [] },
});
const prior = priorFor("测评胃病", "测评虚寒证");
const herb = (name, role, extra = {}) => ({
  name, dose: "10g", role, targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "", processing: null, isToxic: false,
  decoctionRequirement: null, ...extra,
});
const candidateOf = (name, herbs, formulaAnalysis) => ({
  name, applicable: "", notApplicable: "", herbs, formulaAnalysis,
  decoction: { doseCount: "7剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，煎服", followUpNode: "7日复诊" },
});

// ───── 1 方义药名对齐药味表 ─────
const CASE6_R3 = "本方以左归丸为基础加减，纯补无泻，专走肾阴精亏一路。熟地黄为君，直填肾阴精之亏，使腰府筋脉得养；麸炒山药、山萸肉固肾益精，枸杞子润燥生津，三味为臣，既助君药补阴，又分治口燥咽干之虚热上灼；盐菟丝子、酒川牛膝补肾强腰、引药下行，鹿胶珠温养精血以助阴精化生，龟胶珠滋阴潜阳而清虚热，共为佐药，使补而不滞、阴阳相济；全方无使药，以胶类烊化、菟丝子包煎调和药性。诸药合用，共奏滋补肾阴、濡养筋脉、生津止痛之功，与治法相合。";
const CASE6_HERBS = ["熟地黄", "山药", "山茱萸", "枸杞子", "菟丝子", "川牛膝", "鹿角胶", "龟甲胶"];
check("1.1 病历 6：方义里的鹿胶珠、龟胶珠、山萸肉改成药味表的鹿角胶、龟甲胶、山茱萸（身份解析得出、药味表有这一味）", () => {
  const aligned = review.withMentionsAlignedToTableNames(CASE6_R3, CASE6_HERBS);
  assert.equal(aligned.changed, true);
  assert.match(aligned.text, /鹿角胶温养精血/);
  assert.match(aligned.text, /龟甲胶滋阴潜阳/);
  assert.match(aligned.text, /山茱萸固肾益精/);
  assert.doesNotMatch(aligned.text, /鹿胶珠|龟胶珠|山萸肉/);
});
check("1.2 对照：未复核的中等置信别名不对齐（玉屏风散的「屏风」不改成防风）；生地黄与药味表熟地黄是两味，不改", () => {
  const screen = "本方取玉屏风之意，黄芪益气固表为君，白术健脾为臣，防风走表祛风为佐。";
  assert.equal(review.withMentionsAlignedToTableNames(screen, ["黄芪", "白术", "防风"]).text, screen);
  const rehmannia = "生地黄清热凉血为君，当归养血为臣。";
  assert.equal(review.withMentionsAlignedToTableNames(rehmannia, ["熟地黄", "当归"]).text, rehmannia);
});
check("1.3 对齐之后方义核对对得上鹿角胶：报疑「退虚热」（教材鹿角胶不给）在同段角色说法点名的那一处去掉，龟甲胶那半句留下", () => {
  const text = review.withMentionsAlignedToTableNames(
    "本方以左归丸为基础加减。熟地黄为君，填精益髓；山药、山茱萸、枸杞子为臣；鹿胶珠、龟胶珠为佐，血肉有情之品滋阴填精，兼退虚热以对口燥咽干；菟丝子、川牛膝补肾强腰。",
    CASE6_HERBS,
  ).text;
  assert.match(text, /鹿角胶、龟甲胶为佐/);
  const result = review.removeVerifiedHerbClaims(text, CASE6_HERBS, [
    { herb: "鹿角胶", clause: "血肉有情之品滋阴填精，兼退虚热以对口燥咽干", claim: "退虚热" },
  ], herbClaimReferenceText);
  assert.equal(result.removals.length, 1, JSON.stringify(result));
  assert.doesNotMatch(result.text, /鹿角胶[^；。]*退虚热/);
  assert.match(result.text, /龟甲胶/);
});

// ───── 2 煎法不调和药性 ─────
check("2.1 病历 6：「全方无使药，以胶类烊化、菟丝子包煎调和药性」整段去掉；炙甘草调和药性、生姜大枣调和营卫照留（对照）", () => {
  const result = review.withoutDecoctionMethodHarmonizingClaims(CASE6_R3);
  assert.equal(result.changed, true);
  assert.doesNotMatch(result.text, /包煎调和药性|无使药/);
  assert.match(result.text, /共为佐药，使补而不滞、阴阳相济。诸药合用/);
  for (const control of ["炙甘草益气和中、调和药性为使。", "生姜、大枣调和营卫为使。"]) {
    assert.equal(review.withoutDecoctionMethodHarmonizingClaims(control).changed, false, control);
  }
});

// ───── 3 数量词重数 ─────
check("3.1 病历 7：「生地黄、牡丹皮…，当归身…，四者」只点到三味，改成「三者」；四味时不动（对照）", () => {
  const text = "升麻清热解毒并载药上行，石膏、知母清胃泻火；生地黄、牡丹皮凉血消肿，当归身养血和血以防苦寒伤阴，四者共奏凉血止痛；大黄泻热通腑。";
  const herbs = ["黄连", "升麻", "生地黄", "牡丹皮", "当归", "大黄", "石膏", "知母"];
  const result = review.withRecountedHerbCountWords(text, herbs);
  assert.equal(result.changed, true);
  assert.match(result.text, /当归身养血和血以防苦寒伤阴，三者共奏/);
  const four = "生地黄、牡丹皮凉血消肿，当归身养血和血，赤芍散瘀，四者共奏凉血止痛。";
  assert.equal(review.withRecountedHerbCountWords(four, [...herbs, "赤芍"]).changed, false);
});

// ───── 4 原方增删说法 ─────
check("4.1 病历 9：消风散「去煅石膏，加知母以清热生津」——原方是石膏、知母本在原方：改成「去石膏」，加知母那一小句不留", () => {
  const herbs = ["荆芥", "防风", "蝉蜕", "牛蒡子", "苦参", "苍术", "当归", "地黄", "知母", "木通", "甘草", "白鲜皮"].map((name, index) => herb(name, index < 2 ? "君" : index < 6 ? "臣" : "佐"));
  const analysis = "本方以消风散为基础加减，去煅石膏，加知母以清热生津。荆芥、防风辛散透表，共为君药；蝉蜕、牛蒡子助君疏散风热，苦参、苍术燥湿止痒为臣；当归、地黄养血活血，知母清热，木通利湿，白鲜皮止痒为佐；甘草调和诸药为使。";
  const out = hooks.withAnalysisConsistentCandidate(candidateOf("消风散加减", herbs, analysis), prior);
  assert.match(out.formulaAnalysis, /^本方以消风散为基础加减，去石膏。荆芥/);
});
check("4.2 X-G-1104：消渴方原方没有葛根，「去葛根」不留；对照：名录里消风散有的版本用白芷，「去白芷」照留；煎服引药（生姜）名录常不列，「去生姜」照留", () => {
  const herbs = ["黄连", "天花粉", "生地黄", "麦冬", "芦根", "藕汁"].map((name, index) => herb(name, index < 2 ? "君" : "佐"));
  const analysis = "本方以消渴方为基础加减，去葛根，加麦冬、芦根。黄连苦寒直折肺中燥热，天花粉甘寒生津止渴，二药共为君药；生地黄、麦冬养阴为臣。";
  const out = hooks.withAnalysisConsistentCandidate(candidateOf("消渴方加减", herbs, analysis), prior);
  assert.match(out.formulaAnalysis, /^本方以消渴方为基础加减，加麦冬、芦根。/);
  const vehicle = "本方以消渴方为基础加减，去生姜。黄连苦寒为君。";
  assert.match(hooks.withAnalysisConsistentCandidate(candidateOf("消渴方加减", herbs, vehicle), prior).formulaAnalysis, /^本方以消渴方为基础加减，去生姜。/);
  const wind = ["荆芥", "防风", "当归", "地黄", "苦参", "苍术", "蝉蜕", "木通", "知母", "石膏", "甘草", "牛蒡子", "白鲜皮"].map((name, index) => herb(name, index < 2 ? "君" : "臣"));
  const variant = "本方以消风散为基础加减，去白芷，加白鲜皮。荆芥、防风为君。";
  assert.match(hooks.withAnalysisConsistentCandidate(candidateOf("消风散加减", wind, variant), prior).formulaAnalysis, /^本方以消风散为基础加减，去白芷，加白鲜皮。/);
});

// ───── 5 加减的药与病历记录相抵 ─────
const base = { id: "r1019-r3", phase: "prescribe", conversation: [], diagnosis: "", prescription: "", riskAssessment: "", maxQuestionRounds: 1, chiefComplaint: "头痛3月" };
const compileWithModifications = (modifications, presentHistory, compilePrior = prior) => compiler.compileM04Proposal({
  candidate: {
    name: "自拟方", applicable: "头痛隐隐。", notApplicable: "实热证不用。",
    herbs: [
      herb("当归", "君", { function: "补血活血" }),
      herb("白芍", "臣", { function: "养血柔肝" }),
      herb("川芎", "佐", { function: "活血行气" }),
      { ...herb("炙甘草", "使", { function: "调和诸药" }), targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize" },
    ],
    formulaAnalysis: "当归补血活血为君，白芍养血柔肝为臣，川芎活血行气为佐，炙甘草调和诸药为使。",
    decoction: { doseCount: "7剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，煎服", followUpNode: "7日复诊" },
  },
  patentAndWestern: [],
  modifications,
  nonPharma: { diet: "宜清淡易消化饮食。", lifestyle: "规律作息。", emotion: "调畅情志。", precautions: [], tcmTreatments: [] },
}, compilePrior, { ...base, patient: { sex: "女", age: 45 }, symptoms: { presentHistory } });
check("5.1 病历 3：「若头晕耳鸣、虚烦少寐、腰膝酸软：加熟地黄」对病历「食欲下降、大便稀溏」（教材熟地黄「食少便溏者忌服」）不列并记明原因；病历没有便溏时照列（对照）", () => {
  const modification = { trigger: "若头晕耳鸣、虚烦少寐、腰膝酸软", targetRef: "P1", actionType: "add", herbName: "熟地黄", dose: "12g", reason: "滋阴养血，填精益髓" };
  const held = compileWithModifications([modification], "头痛隐隐3月，劳累后加重，食欲下降，大便稀溏。").formula;
  assert.deepEqual(held.modifications.map((item) => item.herbName), []);
  assert.ok(held.modificationReview.droppedReasons.some((item) => item.code === "record_caution_conflict"), JSON.stringify(held.modificationReview));
  const kept = compileWithModifications([modification], "头痛隐隐3月，劳累后加重，纳可，二便调。").formula;
  assert.deepEqual(kept.modifications.map((item) => item.herbName), ["熟地黄"]);
});

// ───── 6 只说睡不好的加减 ─────
check("6.1 S132、S158：条件只说睡不好、证与病不涉心神、加的是安神药或理由写安神——教材本证列明的也不列", () => {
  assert.equal(compiler.incidentalSleepTriggerModification({ trigger: "若瘙痒不能入眠", herbName: "珍珠母", reason: "重镇安神止痒，助缓夜间瘙痒" }, priorFor("湿疮", "血虚风燥证")), true);
  assert.equal(compiler.incidentalSleepTriggerModification({ trigger: "若烦躁、夜啼难眠", herbName: "蝉蜕", reason: "清心除烦，安神定惊" }, priorFor("积滞", "食积化热证")), true);
  assert.equal(compiler.incidentalSleepTriggerModification({ trigger: "若失眠多梦明显", herbName: "酸枣仁", reason: "养心安神" }, priorFor("带下过多", "阴虚夹湿热证")), true);
});
check("6.2 对照：条件里另有成组表现（血虚头痛「头晕耳鸣、虚烦少寐、腰膝酸软」加五味子、眩晕「心悸怔忡，少寐健忘」加柏子仁、颤证「阴虚火旺…躁动失眠」加知母）、遗尿「寐深难以唤醒」加石菖蒲、神志病（多动障碍「夜寐不安」）、加的不是为了睡觉——都照列", () => {
  assert.equal(compiler.incidentalSleepTriggerModification({ trigger: "若头晕耳鸣、虚烦少寐、腰膝酸软", herbName: "五味子", reason: "滋养阴血，宁心安神以助眠" }, priorFor("头痛", "血虚头痛证")), false);
  assert.equal(compiler.incidentalSleepTriggerModification({ trigger: "若兼见心悸怔忡，少寐健忘", herbName: "柏子仁", reason: "养心安神" }, priorFor("眩晕", "气血亏虚证")), false);
  assert.equal(compiler.incidentalSleepTriggerModification({ trigger: "若阴虚火旺，兼见五心烦热、躁动失眠", herbName: "知母", reason: "滋阴降火，除烦安神" }, priorFor("颤证", "髓海不足证")), false);
  assert.equal(compiler.incidentalSleepTriggerModification({ trigger: "若寐深难以唤醒", herbName: "石菖蒲", reason: "开窍醒神" }, priorFor("遗尿", "肾气不足证")), false);
  assert.equal(compiler.incidentalSleepTriggerModification({ trigger: "若夜寐不安", herbName: "酸枣仁", reason: "养心安神" }, priorFor("注意力缺陷多动障碍", "肝肾阴虚证")), false);
  assert.equal(compiler.incidentalSleepTriggerModification({ trigger: "若瘙痒夜间尤甚，影响入睡", herbName: "牡丹皮", reason: "凉血止痒" }, priorFor("风瘙痒", "风热血热证")), false);
});
const eczemaPrior = ReasoningV2Schema.parse({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "湿疮", primarySyndrome: "血虚风燥证", overallPathogenesis: "血虚风燥，肌肤失养", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "皮损粗糙肥厚", syndromeEvidence: "皮损粗糙肥厚", pathogenesis: "血虚风燥", therapyDirection: "养血润肤，祛风止痒" }] },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "养血润肤，祛风止痒", subTherapies: [{ therapy: "养血润肤", targetPathogenesis: "血虚风燥", priority: "主要" }] },
  formula: { candidates: [], patentAndWestern: [], modifications: [] },
});
check("6.3 编译器：教材本证加减（湿疮·血虚风燥证「瘙痒不能入眠者，加珍珠母」）照样不列，记 incidental_sedative；病历现有表现触发的「皮损粗糙肥厚：加制何首乌」照列（对照；本机有语料时原文逐字核对）", () => {
  const formula = compileWithModifications([
    { trigger: "若瘙痒不能入眠", targetRef: "P1", actionType: "add", herbName: "珍珠母", dose: "15g", reason: "重镇安神止痒" },
    { trigger: "皮损粗糙肥厚", targetRef: "P1", actionType: "add", herbName: "制何首乌", dose: "10g", reason: "养血润燥" },
  ], "皮损粗糙肥厚3年，瘙痒剧烈，夜间常因瘙痒抓挠而醒。", eczemaPrior).formula;
  assert.deepEqual(formula.modifications.map((item) => item.herbName), ["制何首乌"]);
  assert.ok(formula.modificationReview.droppedReasons.some((item) => item.code === "incidental_sedative"), JSON.stringify(formula.modificationReview));
  if (textbookLines) assert.match(textbookLines[207558], /瘙痒不能入眠者，加珍珠母/);
});

// ───── 7 没有出处的特殊煎法 ─────
check("7.1 S054 肉豆蔻「后下」：药典规则与教材【用量用法】（「煎服，3～10g。内服须煨制去油用」）都不给，去掉；豆蔻后下、龙骨先煎、阿胶烊化照留（对照）", () => {
  assert.equal(decoction.withoutUnsupportedDecoctionLabels("肉豆蔻", "后下"), "");
  assert.equal(decoction.withoutUnsupportedDecoctionLabels("豆蔻", "后下"), "后下");
  assert.equal(decoction.withoutUnsupportedDecoctionLabels("龙骨", "先煎"), "先煎");
  assert.equal(decoction.withoutUnsupportedDecoctionLabels("阿胶", "烊化"), "烊化");
  assert.equal(decoction.withoutUnsupportedDecoctionLabels("肉豆蔻", "后下、不宜久煎"), "不宜久煎");
  // 煎服行按药味取特殊煎法（specialDecoctionOrderIndex）同过这一道：药味表照抄了「后下」也不会排进后下；豆蔻照排（对照）。
  assert.equal(decoction.specialDecoctionPhrase("肉豆蔻", "后下"), "");
  assert.notEqual(decoction.specialDecoctionPhrase("豆蔻", "后下"), "");
  const usage = textbookIdentity.textbookHerbUsage("肉豆蔻");
  assert.match(usage?.text || "", /煎服，3～10g/);
  if (textbookLines && usage?.line) assert.ok(textbookLines[usage.line - 1].includes("煎服，3～10g"), textbookLines[usage.line - 1]);
});
check("7.2 编译器：药味表的肉豆蔻「后下」去掉后，煎服行不再把它排进后下（两处同一份）", () => {
  const herbs = [herb("补骨脂", "君"), herb("肉豆蔻", "臣", { decoctionRequirement: "后下" }), herb("吴茱萸", "佐"), herb("五味子", "佐")];
  const out = hooks.withAnalysisConsistentCandidate(candidateOf("四神丸加减", herbs, "补骨脂温肾暖脾为君，肉豆蔻温中涩肠为臣，吴茱萸、五味子为佐。"), prior);
  assert.equal(out.herbs.find((item) => item.name === "肉豆蔻").decoctionRequirement, undefined);
  assert.equal(decoction.specialDecoctionPhrase("肉豆蔻", out.herbs.find((item) => item.name === "肉豆蔻").decoctionRequirement || ""), "");
});

// ───── 8 角色对齐 ─────
const CASE2_R1 = "本方以安神定志丸为基础加减。人参大补心气，煅龙齿镇惊安神，二药共为君药，直对心气不足、胆气怯弱、神不守舍之核心，使惊惕得定、心悸得宁；茯神宁心安神，制远志安神，酸枣仁养心助寐，三药为臣，承接心神失养、夜寐多梦易醒之层，使神有所归；茯苓健脾渗湿，石菖蒲化湿开胃，佐助中焦运化，以解精神不振、食欲下降之兼；炙甘草调和诸药，缓龙齿重镇之性。全方补气镇惊与养心安神并行，兼顾脾运，共奏镇惊定志、养心安神之效。";
check("8.1 病历 2：药味表「茯苓…臣」「酸枣仁…佐」随方义改成佐、臣；其余各味不动", () => {
  const herbs = [herb("人参", "君"), herb("龙齿", "君"), herb("茯神", "臣"), herb("茯苓", "臣"), herb("远志", "臣"), herb("石菖蒲", "佐"), herb("酸枣仁", "佐"),
    { ...herb("炙甘草", "使"), targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize" }];
  const out = hooks.withAnalysisConsistentCandidate(candidateOf("安神定志丸加减", herbs, CASE2_R1), priorFor("心悸", "心虚胆怯证"));
  const roles = Object.fromEntries(out.herbs.map((item) => [item.name, item.role]));
  assert.deepEqual(roles, { 人参: "君", 龙齿: "君", 茯神: "臣", 茯苓: "佐", 远志: "臣", 石菖蒲: "佐", 酸枣仁: "臣", 炙甘草: "使" });
});
check("8.2 对照：牵涉君药的不一致不改（S145 黄柏 表君、方义为臣）；方内结构类的药不改成臣", () => {
  const herbs = [herb("黄柏", "君"), herb("苍术", "臣"), herb("薏苡仁", "臣"), herb("牛膝", "佐")];
  const text = "防己清热利湿为君；黄柏、苍术、薏苡仁清热燥湿为臣；牛膝引药下行为佐。";
  assert.equal(hooks.withAnalysisConsistentCandidate(candidateOf("自拟方", herbs, text), prior).herbs[0].role, "君");
  const structure = [herb("柴胡", "君"), herb("白芍", "臣"), { ...herb("桔梗", "使"), targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "guide" }];
  const guided = hooks.withAnalysisConsistentCandidate(candidateOf("自拟方", structure, "柴胡疏肝为君；白芍、桔梗共为臣。"), prior);
  assert.equal(guided.herbs[2].role, "使");
  assert.equal(guided.herbs[1].role, "臣");
});

// ───── 9 知识库功用错条与解暑一类 ─────
check("9.1 枇杷叶不再带「清热解暑」、蒺藜不再带「益气化痰」、天竺黄不再带「祛风除湿」；教材给的功效照留", () => {
  assert.doesNotMatch(kb.getTcmHerbFunctionText("枇杷叶"), /清热解暑/);
  assert.match(kb.getTcmHerbFunctionText("枇杷叶"), /清肺止咳/);
  assert.doesNotMatch(kb.getTcmHerbFunctionText("蒺藜"), /益气化痰/);
  assert.doesNotMatch(kb.getTcmHerbFunctionText("炒蒺藜"), /益气化痰/);
  assert.match(kb.getTcmHerbFunctionText("蒺藜"), /祛风明目/);
  assert.doesNotMatch(kb.getTcmHerbFunctionText("天竺黄"), /祛风除湿/);
  assert.match(kb.getTcmHerbFunctionText("天竺黄"), /清热豁痰/);
});
check("9.2 X-G-0811：药味表枇杷叶「清热解暑」认出两处无依据（清热、解暑）；滑石、青蒿、佩兰的解暑库里有，不认（对照）", () => {
  assert.deepEqual(herbFunctionClaimUnsupportedPhrases("清热解暑", kb.herbFunctionKnowledgeForDisplay("枇杷叶")).sort(), ["清热", "解暑"].sort());
  assert.deepEqual(herbFunctionClaimUnsupportedPhrases("利水渗湿，清热解暑", kb.herbFunctionKnowledgeForDisplay("滑石")), []);
  assert.deepEqual(herbFunctionClaimUnsupportedPhrases("清热解暑", kb.herbFunctionKnowledgeForDisplay("青蒿")), []);
  assert.deepEqual(herbFunctionClaimUnsupportedPhrases("化湿和中，解暑化湿", kb.herbFunctionKnowledgeForDisplay("佩兰")), []);
});
check("9.3 新加的三条剔除各附教材【功效】原文，逐字在所引那一行（本机没有语料时只核对格式）", () => {
  const corrections = JSON.parse(readFileSync("src/data/tcm-herb-function-corrections.source.json", "utf8")).herbs;
  for (const [name, functionText] of [["枇杷叶", "清肺止咳，降逆止呕"], ["蒺藜", "平肝解郁，活血祛风，明目，止痒"], ["天竺黄", "清热豁痰，清心定惊"]]) {
    const entry = corrections[name];
    assert.ok(entry && entry.unsupported.length > 0 && entry.evidence.length > 0, name);
    for (const evidence of entry.evidence) {
      assert.ok(evidence.text.includes(functionText), `${name}: ${evidence.text}`);
      if (textbookLines) assert.equal(textbookLines[evidence.line - 1].trim(), evidence.text, `${name} 第 ${evidence.line} 行`);
    }
  }
});

// ───── 10 原方里不编制用量的味 ─────
check("10.1 乌头汤加减（方中无川乌）：方义开头一句后补「原方中的制川乌本次未列入药味表，是否使用及用量由医师单独确定」；朱砂安神丸同样补朱砂（方名里的字不算提到）", () => {
  const herbs = ["麻黄", "桂枝", "白芍", "黄芪", "苍术", "牛膝", "炙甘草"];
  const analysis = "本方以乌头汤为基础加减。麻黄辛温开腠、散寒通痹为君；桂枝助其温经通阳，白芍柔筋缓急；黄芪益气行血。";
  const noted = hooks.withWithheldBaseIngredientNote(analysis, ["乌头汤"], herbs);
  assert.equal(noted, "本方以乌头汤为基础加减。原方中的制川乌本次未列入药味表，是否使用及用量由医师单独确定。麻黄辛温开腠、散寒通痹为君；桂枝助其温经通阳，白芍柔筋缓急；黄芪益气行血。");
  const out = hooks.withAnalysisConsistentCandidate(candidateOf("乌头汤加减", herbs.map((name, index) => herb(name, index === 0 ? "君" : "臣")), analysis), prior);
  assert.match(out.formulaAnalysis, /原方中的制川乌本次未列入药味表/);
  // 方名里的字不算提到了（「以朱砂安神丸为基础」没有说朱砂）。
  const cinnabar = hooks.withWithheldBaseIngredientNote("本方以朱砂安神丸为基础加减。黄连清心泻火为君，地黄、当归滋阴养血为臣。", ["朱砂安神丸"], ["黄连", "地黄", "当归", "炙甘草", "酸枣仁"]);
  assert.match(cinnabar, /^本方以朱砂安神丸为基础加减。原方中的朱砂粉本次未列入药味表/);
});
check("10.2 对照：方义已说了这味（「去川乌」）、同味别种写法在方中（消风散方中有石膏、沙参麦冬汤方中有北沙参）、可编制组成不过半（「…合十枣汤」方中只有大枣）——都不补", () => {
  assert.equal(hooks.withWithheldBaseIngredientNote("本方以乌头汤为基础，去川乌之峻。麻黄为君。", ["乌头汤"], ["麻黄", "白芍", "黄芪", "炙甘草"]), "本方以乌头汤为基础，去川乌之峻。麻黄为君。");
  const wind = ["荆芥", "防风", "当归", "地黄", "苦参", "苍术", "蝉蜕", "木通", "知母", "石膏", "甘草", "牛蒡子"];
  assert.equal(hooks.withWithheldBaseIngredientNote("本方以消风散为基础加减。荆芥、防风为君。", ["消风散"], wind), "本方以消风散为基础加减。荆芥、防风为君。");
  const glehnia = ["北沙参", "麦冬", "玉竹", "桑叶", "天花粉", "白扁豆", "甘草"];
  assert.equal(hooks.withWithheldBaseIngredientNote("本方以沙参麦冬汤为基础加减。麦冬、玉竹为君。", ["沙参麦冬汤"], glehnia), "本方以沙参麦冬汤为基础加减。麦冬、玉竹为君。", "原方「沙参」不分南北，方中北沙参即是");
  const fluid = ["葶苈子", "瓜蒌子", "桑白皮", "紫苏子", "法半夏", "茯苓", "生姜", "大枣"];
  assert.equal(hooks.withWithheldBaseIngredientNote("本方以椒目瓜蒌汤合十枣汤为基础加减。葶苈子为君。", ["椒目瓜蒌汤", "十枣汤"], fluid), "本方以椒目瓜蒌汤合十枣汤为基础加减。葶苈子为君。");
});

console.log(JSON.stringify({ suite: "r1019-herbs-r3", cases, failures: process.exitCode ? "see above" : 0 }));
