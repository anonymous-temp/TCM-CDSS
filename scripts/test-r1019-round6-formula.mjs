// 10/19 第六轮（2026-10-19）：第五轮终测（718e1ea）Claude 评审又找到的两类处方缺陷，一类一修。
//
// 每条断言都带对照（不该变的输入保持不变），并跑过反证（撤掉改动后变红，记录在 ~/runlogs/r1018/work/r1019/counterproofs.txt「6/formula/…」）。
//
//   1 随证加减被服务端删光、交付为空（评分细则一票否决）：
//     · 加的药本就在方中（本地甲方病历 7 两次生成：清胃散的三条加减全因 action_conflicts_with_candidate 删光）→ 改写成「调整」行，
//       理由前写「加重X用量」，不带克数；
//     · 模型的加减全部剔除、本证教材行列有加减时，按教材条目确定性补 1–2 条（同一套加减判据，剂量取药典下限）。
//   2 方义删掉方外药名后的残句：「黄柏苦寒清热燥湿燥湿，共为君药」（留出例 S145）——重复词、只剩一味的「共为」。
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

const { compileM04Proposal } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const review = await jiti.import("../src/lib/formula-analysis-review.ts");

// ───── 1 随证加减 ─────
const priorOf = (disease, syndrome, pathogenesis, therapy) => ReasoningV2Schema.parse({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: disease, primarySyndrome: syndrome, overallPathogenesis: pathogenesis, recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "主症", syndromeEvidence: "主症", pathogenesis, therapyDirection: therapy }] },
  therapy: { overallPrinciple: "实则泻之", overallMethod: therapy, subTherapies: [{ therapy, targetPathogenesis: pathogenesis, priority: "主要" }] },
  formula: { candidates: [], patentAndWestern: [], modifications: [] },
});
const herbRow = (name, dose, role = "佐", fn = "清热") => ({
  name, dose, role, function: fn, processing: null, isToxic: false, decoctionRequirement: null,
  ...(role === "使" ? { targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize" } : { targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null }),
});
const proposalOf = (name, herbs, modifications = [], analysis = "") => ({
  candidate: {
    name, applicable: "", notApplicable: "", herbs,
    formulaAnalysis: analysis || `${herbs[0].name}为君。`,
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，水煎两次，共取药液约400mL，分2次温服", followUpNode: "5日复诊" },
  },
  patentAndWestern: [], modifications,
  nonPharma: { diet: "宜清淡，可食冬瓜汤。", lifestyle: "规律作息。", emotion: "调畅情志。", precautions: ["忌辛辣。"], tcmTreatments: [] },
});
const mod = (trigger, herbName, reason, actionType = "add", dose) => ({ trigger, targetRef: "P1", actionType, herbName, reason, ...(dose ? { dose } : {}) });

const QINGWEI = [herbRow("黄连", "6g", "君", "清胃泻火"), herbRow("升麻", "6g", "臣", "清热解毒"), herbRow("生地黄", "12g", "臣", "凉血滋阴"),
  herbRow("牡丹皮", "9g", "佐", "清热凉血"), herbRow("当归", "6g", "佐", "养血活血"), herbRow("大黄", "6g", "佐", "泻热通便"),
  herbRow("石膏", "20g", "佐", "清热泻火"), herbRow("知母", "9g", "佐", "清热泻火")];
const toothPrior = priorOf("牙痛", "胃火上炎证", "胃火炽盛，循经上炎", "清胃泻火");

await check("1.1 加的药本就在方中（本地甲方病历 7：清胃散，教材「若大便秘结，加大黄」「若口渴饮冷，加石膏、知母」，模型三条都因 action_conflicts_with_candidate 被删光）：改写成「调整」行、药名与方中那一行相同、不带克数、理由前写「加重X用量」，成方合同的加减核对过得了；减、调整方中没有的药照旧删（对照）", () => {
  const out = compileM04Proposal(proposalOf("清胃散加减", QINGWEI, [
    mod("若大便秘结", "大黄", "泻热通便，使胃火从下而泄", "add", "9g"),
    mod("若口渴饮冷", "石膏", "清胃泻火，生津止渴"),
    mod("若口渴饮冷", "白茅根", "清热生津", "remove"),
  ]), toothPrior);
  assert.ok(out, "编出候选");
  const rows = out.formula.modifications;
  assert.deepEqual(rows.map((row) => [row.action, row.herbName, row.doseOrHandling]), [["调整", "大黄", null], ["调整", "石膏", null]]);
  assert.match(rows[0].reason, /^加重大黄用量，泻热通便/u);
  assert.match(rows[1].reason, /^加重石膏用量，清胃泻火/u);
  assert.equal(out.formula.modificationReview.retainedCount, 2);
  const issue = contract.m04SemanticIssue(out, "", toothPrior, undefined, true, true) || "";
  assert.doesNotMatch(issue, /^modification_/u, issue);
  // 理由里已经说了加量的不再叠「加重」。
  const already = compileM04Proposal(proposalOf("清胃散加减", QINGWEI, [mod("若大便秘结", "大黄", "加大大黄用量以通腑泄热")]), toothPrior);
  assert.equal(already.formula.modifications[0].reason, "加大大黄用量以通腑泄热");
});

await check("1.2 模型的加减全部剔除、教材行列有加减时按教材条目补：呕吐·外邪犯胃证「若见壮热口渴，便秘尿赤，加黄芩」（留出例 S044）→ 一条，剂量取药典下限 3g，条件照教材写「若…」，出处是教材本证加减；模型自己的加减还在时不补（对照）；教材加减的药都在方中时保持为空（对照：清胃散教材两条的药都在方中）", () => {
  const prior = priorOf("呕吐", "外邪犯胃证", "外邪犯胃，胃失和降", "疏邪解表，化浊和中");
  const herbs = [herbRow("广藿香", "10g", "君", "芳香化浊"), herbRow("紫苏叶", "6g", "臣", "解表散寒"), herbRow("白芷", "6g", "臣", "解表散寒"),
    herbRow("半夏", "9g", "佐", "降逆止呕"), herbRow("陈皮", "6g", "佐", "理气和胃"), herbRow("茯苓", "10g", "佐", "健脾渗湿"),
    herbRow("厚朴", "6g", "佐", "行气化湿"), herbRow("大腹皮", "6g", "佐", "行气宽中"), herbRow("白术", "9g", "佐", "健脾燥湿"), herbRow("甘草", "3g", "使", "调和诸药")];
  const filled = compileM04Proposal(proposalOf("藿香正气散加减", herbs, [mod("若口中有臭味", "黄芩", "清热燥湿", "remove")]), prior);
  assert.ok(filled);
  const rows = filled.formula.modifications;
  assert.ok(rows.length >= 1 && rows.length <= 2, JSON.stringify(rows));
  assert.equal(rows[0].trigger, "若见壮热口渴，便秘尿赤");
  assert.deepEqual([rows[0].action, rows[0].herbName, rows[0].doseOrHandling], ["加", "黄芩", "3g"]);
  assert.match(rows[0].evidence.source, /^《中医内科学》呕吐·外邪犯胃证加减：/u);
  const issue = contract.m04SemanticIssue(filled, "", prior, undefined, true, true) || "";
  assert.doesNotMatch(issue, /^modification_/u, issue);
  // 对照：模型留下一条时补到两条（10/31 甲方 10.29 测评「仅生成1个不足」）；模型写的那条在前。
  const own = compileM04Proposal(proposalOf("藿香正气散加减", herbs, [mod("若见壮热口渴，便秘尿赤", "黄芩", "清热燥湿", "add", "6g")]), prior);
  assert.deepEqual(own.formula.modifications[0].herbName, "黄芩");
  assert.equal(own.formula.modifications.length, 2);
  // 对照：教材这一行的加减药都在方中（清胃散加大黄、石膏、知母），模型也没写——保持为空。
  assert.deepEqual(compileM04Proposal(proposalOf("清胃散加减", QINGWEI), toothPrior).formula.modifications, []);
});

await check("1.3 教材两味一组的加减（不寐·心脾两虚证「夜梦纷纭，时醒时寐，加肉桂、黄连」即交泰丸）一起补，不拆开只补一味；同组另一味已在方中时只补没有的那一味（对照）；教材的泛称（痢疾·休息痢「临床可加槟榔、木香、枳实」）不当条件（对照）", () => {
  const prior = priorOf("不寐", "心脾两虚证", "心脾两虚，心神失养", "补益心脾，养血安神");
  const base = [herbRow("黄芪", "15g", "君", "补气"), herbRow("人参", "6g", "君", "补气"), herbRow("白术", "9g", "臣", "健脾"), herbRow("当归", "9g", "臣", "养血"),
    herbRow("茯神", "10g", "佐", "宁心安神"), herbRow("酸枣仁", "12g", "佐", "养心安神"), herbRow("龙眼肉", "9g", "佐", "养血安神"), herbRow("远志", "6g", "佐", "安神"),
    herbRow("木香", "6g", "佐", "理气"), herbRow("熟地黄", "12g", "佐", "养血"), herbRow("白芍", "9g", "佐", "养血"), herbRow("阿胶", "6g", "佐", "养血"),
    herbRow("柏子仁", "9g", "佐", "安神"), herbRow("五味子", "6g", "佐", "宁心"), herbRow("首乌藤", "15g", "佐", "安神"), herbRow("合欢皮", "9g", "佐", "安神"), herbRow("甘草", "3g", "使", "调和诸药")];
  const both = compileM04Proposal(proposalOf("归脾汤加减", base), prior);
  assert.deepEqual(both.formula.modifications.map((row) => [row.trigger, row.herbName]), [["若夜梦纷纭，时醒时寐", "肉桂"], ["若夜梦纷纭，时醒时寐", "黄连"]]);
  const one = compileM04Proposal(proposalOf("归脾汤加减", [...base.slice(0, -1), herbRow("黄连", "3g", "佐", "清心"), base[base.length - 1]]), prior);
  assert.deepEqual(one.formula.modifications.map((row) => row.herbName), ["肉桂"]);
  const dysentery = priorOf("痢疾", "休息痢", "正虚邪恋，运化失健", "温中清肠，调气化滞");
  const lianli = [herbRow("人参", "6g", "君", "补气"), herbRow("白术", "9g", "臣", "健脾"), herbRow("干姜", "6g", "臣", "温中"), herbRow("黄连", "3g", "佐", "清肠"), herbRow("甘草", "3g", "使", "调和诸药")];
  assert.deepEqual(compileM04Proposal(proposalOf("连理汤加减", lianli), dysentery).formula.modifications, []);
});

// ───── 2 方义删掉方外药名后的残句 ─────
const XUANBI = ["黄柏", "薏苡仁", "防己", "滑石", "连翘", "栀子", "赤小豆", "牛膝", "威灵仙", "甘草"];
const TAIL = "薏苡仁、防己利湿除痹，滑石、连翘、栀子清热利湿泄浊，共为臣药；赤小豆利水解毒，牛膝活络，威灵仙通络宣痹，共为佐药；甘草为使调和诸药。";
const reviewed = (text, herbs = XUANBI) => review.reviewAuthoredFormulaAnalysis(text, herbs).text;

await check("2.1 方外药自成顿号一小段、带着自己的说明（留出例 S145「黄柏苦寒清热燥湿、苍术燥湿，共为君药」）：连同说明整小段去掉，不再剩「燥湿燥湿」；只剩一味时「共为君药」改「为君药」；前一小段只是药名（「黄柏、苍术二药共为君」）仍只去药名（对照，第四轮已有）；方外药在前（「苍术燥湿、黄柏苦寒清热」）同样整小段去掉", () => {
  const out = reviewed(`本方以宣痹汤为基础加减。黄柏苦寒清热燥湿、苍术燥湿，共为君药，直清下注足部之湿热浊邪；${TAIL}`);
  assert.match(out, /^本方以宣痹汤为基础加减。黄柏苦寒清热燥湿，为君药，直清下注足部之湿热浊邪；/u);
  assert.doesNotMatch(out, /燥湿燥湿|苍术|共为君/u);
  assert.match(out, /共为臣药/u, "对照：别的段「共为臣药」不动");
  assert.match(reviewed(`本方以宣痹汤为基础加减。黄柏、苍术二药共为君，清热燥湿；${TAIL}`), /^本方以宣痹汤为基础加减。黄柏为君，清热燥湿；/u);
  assert.match(reviewed(`本方以宣痹汤为基础加减。苍术燥湿、黄柏苦寒清热，共为君药；${TAIL}`), /^本方以宣痹汤为基础加减。黄柏苦寒清热，为君药；/u);
});

await check("2.2 对照：去掉方外药后还剩两味作主语时「共为」照留；「同为君」（常是「也是君药」）不动；只讲方外药的整个分句删掉时，后面定角色的「共为君药」留下并按剩下的一味改写（此前连它一起当成没有主语的半句删掉，黄柏没了角色）", () => {
  const herbs = [...XUANBI, "知母"];
  assert.match(reviewed(`本方以宣痹汤为基础加减。黄柏苦寒清热、知母滋阴润燥、苍术燥湿，共为君药；${TAIL}`, herbs), /黄柏苦寒清热、知母滋阴润燥，共为君药；/u);
  assert.match(reviewed(`本方以宣痹汤为基础加减。薏苡仁利湿为君；黄柏苦寒清热燥湿、苍术燥湿，同为君药；赤小豆利水解毒，牛膝活络，威灵仙通络宣痹，防己、滑石、连翘、栀子清热利湿，共为佐药；甘草为使调和诸药。`),
    /黄柏苦寒清热燥湿，同为君药；/u);
  assert.match(reviewed(`本方以宣痹汤为基础加减。黄柏苦寒清热，苍术燥湿，共为君药；${TAIL}`), /^本方以宣痹汤为基础加减。黄柏苦寒清热，为君药；/u);
});

await check("2.3 只去药名时，前后两段说明连成同一个词叠写（「黄柏清热燥湿与苍术燥湿」→「黄柏清热燥湿燥湿」）只留一个；不是去药名造成的叠字不动（对照：「轻轻」「滋阴养阴」）", () => {
  assert.match(reviewed(`本方以宣痹汤为基础加减。黄柏清热燥湿与苍术燥湿，为君药；${TAIL}`), /黄柏清热燥湿，为君药；/u);
  const control = `本方以宣痹汤为基础加减。黄柏清热燥湿，药性轻轻上浮，为君药；${TAIL}`;
  assert.equal(reviewed(control), control);
});

console.log(JSON.stringify({ suite: "r1019-round6-formula", cases, failures: process.exitCode ? "see above" : 0 }));
