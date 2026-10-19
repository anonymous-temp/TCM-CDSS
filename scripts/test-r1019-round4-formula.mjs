// 10/19 第四轮（2026-10-19）：Claude 评审 M 集（360 例）与 H 集报出的处方类服务端缺陷——方名、出处、方义、药味功效栏、加减，一类一修。
//
// 每条断言都带对照（不该变的输入保持不变），并跑过反证（撤掉改动后变红，记录在 ~/runlogs/r1018/work/r1019/counterproofs.txt「4/formula/…」）。
//
//   1 名实相符：方名承载药不在处方里时不再以该方命名（乌头汤无川乌、沙参麦冬汤无沙参、天王补心丹合朱砂安神丸无朱砂）；
//     教材改名只认辨证阶段推荐方向里的那张方（尿浊「知柏地黄丸」实为鹿茸补涩丸）
//   2 方义开头与最终方名同一判据（成方/自拟方/「本方为以X加减」）
//   3 方义残句：「。。」、没有主语的后半句、只点角色不说作用、病历断言小句、修复轮「方向未成立」、流程括注、开头多一个「为」、
//     删段后前后粘连（「为君茯苓皮」）
//   4 方义里错误的「去/加」：去的药其实在方中（川芎、白蜜即蜂蜜、甘草）、去原方之某药性（保和丸）、同名异方的加药说法（四七汤）
//   5 方义药名按药味表写（朱茯神→茯神、煅石决明→石决明…）
//   6 药味功效栏：「调和诸药」只属调和药；括注与近义重复；方向词补「升举清阳」「通阳」「清解郁热」「通利大便」
//   7 加减：理由里无依据的功效、完全重复的行、教材「非…不能」不当条件
//   8 出处：国家经典名方目录优先（化肝煎《景岳全书》）、同方另一剂型（十全大补丸借十全大补汤）、同名异方（四七汤、大七气汤）、
//     不给剂量页合方出处不丢方名
//   9 原方扣除药味的说明写成临床说法
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

const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const review = await jiti.import("../src/lib/formula-analysis-review.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const { m04CompilerTestHooks: hooks } = await jiti.import("../src/lib/m04-proposal-compiler.ts");

const herbRow = (name, role = "佐", fn = "") => ({ name, role, function: fn, dose: "10g" });
const prescribeOf = ({ name, herbs, analysis = "", source = "", formulaNames, overview = {}, modifications = [] }) => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  overview,
  formula: {
    candidates: [{
      name,
      formulaNames: formulaNames ?? [],
      constructionType: (formulaNames ?? []).length > 1 ? "combined" : (formulaNames ?? []).length === 1 ? "single_base" : "self_devised",
      baseFormulas: (formulaNames ?? []).map((formula) => ({ name: formula, source: "《x》" })),
      herbs: herbs.map((item) => (typeof item === "string" ? herbRow(item) : item)),
      formulaAnalysis: analysis,
      formulaSource: { evidenceLevel: "kb_entry", source, confidence: "中" },
    }],
    patentAndWestern: [],
    modifications,
  },
  nonPharma: {},
});
const project = (reasoning) => surface.projectDeliveredReasoning(reasoning);
const candidateAfter = (reasoning) => project(reasoning).formula.candidates[0];
const kb = (name) => `${knowledge.herbFunctionKnowledgeForDisplay(name)}；${knowledge.getTcmHerbFunctionText(name)}`;

// ───── 1 名实相符 ─────
await check("1.1 方名承载药：沙参麦冬汤缺沙参、乌头汤缺川乌、知柏地黄丸缺知母黄柏判缺；北沙参、制川乌算有；安全定性药（天王补心丹的朱砂、薏苡仁汤的川乌）与冲服药（大承气汤芒硝、黄芪建中汤饴糖）不算（对照）", () => {
  assert.deepEqual(provenance.formulaNameIdentityHerbsMissing("沙参麦冬汤", ["麦冬", "玉竹", "天花粉", "桑叶", "白扁豆", "甘草"]), ["沙参"]);
  assert.deepEqual(provenance.formulaNameIdentityHerbsMissing("沙参麦冬汤", ["北沙参", "麦冬", "玉竹"]), []);
  assert.deepEqual(provenance.formulaNameIdentityHerbsMissing("乌头汤", ["麻黄", "桂枝", "黄芪", "白芍", "炙甘草"]), ["川乌"]);
  assert.deepEqual(provenance.formulaNameIdentityHerbsMissing("乌头汤", ["制川乌", "麻黄", "黄芪", "白芍", "炙甘草"]), []);
  assert.deepEqual(provenance.formulaNameIdentityHerbsMissing("知柏地黄丸", ["熟地黄", "山茱萸", "山药", "茯苓"]).sort(), ["知母", "黄柏"].sort());
  assert.deepEqual(provenance.formulaNameIdentityHerbsMissing("知柏地黄丸", ["熟地黄", "山茱萸", "山药", "茯苓", "知母", "黄柏"]), []);
  // 对照
  assert.deepEqual(provenance.formulaNameIdentityHerbsMissing("天王补心丹", ["地黄", "麦冬", "天冬", "玄参", "丹参"]), []);
  assert.deepEqual(provenance.formulaNameIdentityHerbsMissing("薏苡仁汤", ["薏苡仁", "麻黄", "当归", "桂枝", "苍术"]), []);
  assert.deepEqual(provenance.formulaNameIdentityHerbsMissing("大承气汤", ["大黄", "厚朴", "枳实"]), []);
  assert.deepEqual(provenance.formulaNameIdentityHerbsMissing("黄芪建中汤", ["黄芪", "桂枝", "白芍", "炙甘草", "生姜", "大枣"]), []);
  assert.deepEqual(provenance.formulaNameComponents("百合固金汤加减"), ["百合固金汤"], "方名里的「合」不是合方");
  assert.deepEqual(provenance.formulaNameComponents("天王补心丹合朱砂安神丸加减"), ["天王补心丹", "朱砂安神丸"]);
});

await check("1.2 交付面：「乌头汤加减」而方中无川乌 → 自拟方（formulaNames/baseFormulas 清空、self_devised、出处自拟方），方义开头「本方为自拟方，参照乌头汤化裁」；再投影一次不变；方中有制川乌时不改（对照）", () => {
  const herbs = [herbRow("麻黄", "君", "散寒通痹"), herbRow("桂枝", "臣", "温经通脉"), herbRow("黄芪", "臣", "益气固表"), herbRow("白芍", "佐", "柔筋缓急"), herbRow("炙甘草", "使", "调和诸药")];
  const input = prescribeOf({ name: "乌头汤加减", herbs, formulaNames: ["乌头汤"], source: "乌头汤：《金匮要略》",
    analysis: "本方以乌头汤为基础加减。麻黄辛温为君，散寒开腠以通痹阻；桂枝、黄芪为臣；白芍为佐；炙甘草为使，调和诸药。" });
  const once = project(input);
  const out = once.formula.candidates[0];
  assert.equal(out.name, "自拟方");
  assert.deepEqual(out.formulaNames, []);
  assert.deepEqual(out.baseFormulas, []);
  assert.equal(out.constructionType, "self_devised");
  assert.equal(out.formulaSource.source, "自拟方");
  assert.match(out.formulaAnalysis, /^本方为自拟方，参照乌头汤化裁。/);
  assert.deepEqual(project(once), once, "幂等");
  const control = candidateAfter(prescribeOf({ name: "乌头汤加减", herbs: [herbRow("制川乌", "君", "祛风除湿"), ...herbs.slice(1)], formulaNames: ["乌头汤"], source: "乌头汤：《金匮要略》",
    analysis: "本方以乌头汤为基础加减。制川乌为君，温经止痛。" }));
  assert.equal(control.name, "乌头汤加减");
  assert.equal(control.formulaSource.source, "乌头汤：《金匮要略》");
});

await check("1.3 合方只去名实不符的那一张：天王补心丹合朱砂安神丸而方中无朱砂 → 天王补心丹加减，出处只留天王补心丹的", () => {
  const out = candidateAfter(prescribeOf({ name: "天王补心丹合朱砂安神丸加减", herbs: ["地黄", "麦冬", "天冬", "玄参", "丹参", "黄连", "当归"],
    formulaNames: ["天王补心丹", "朱砂安神丸"], source: "天王补心丹：《校注妇人良方》；朱砂安神丸：《内外伤辨惑论》",
    analysis: "本方以天王补心丹合朱砂安神丸为基础加减。地黄、麦冬为君，滋阴养血。" }));
  assert.equal(out.name, "天王补心丹加减");
  assert.deepEqual(out.formulaNames, ["天王补心丹"]);
  assert.equal(out.constructionType, "single_base");
  assert.equal(out.formulaSource.source, "天王补心丹：《校注妇人良方》");
  assert.match(out.formulaAnalysis, /^本方以天王补心丹为基础加减。/);
});

await check("1.4 教材改名只认推荐方向里的那张方（M 集 RobustSDT-single_0280）：尿浊·肾虚不固证推荐鹿茸补涩丸，处方温肾固涩、无知母黄柏 → 鹿茸补涩丸加减；方中有知母黄柏、方名本是知柏地黄丸加减时不动（对照）", () => {
  const overview = { tcmDiseaseName: "尿浊", primarySyndrome: "肾虚不固证", recommendedFormulaDirection: "鹿茸补涩丸加减" };
  const herbs = ["鹿茸", "菟丝子", "熟地黄", "山茱萸", "补骨脂", "桑螵蛸", "肉桂", "附子", "茯苓", "莲子", "五味子", "山药", "甘草"];
  const out = candidateAfter(prescribeOf({ name: "知柏地黄丸加减", herbs, overview, source: "知柏地黄丸：《医宗金鉴》",
    analysis: "本方以知柏地黄丸为基础加减。鹿茸温肾固摄、菟丝子补肾固精共为君。" }));
  assert.equal(out.name, "鹿茸补涩丸加减");
  assert.match(out.formulaSource.source, /^鹿茸补涩丸：/);
  assert.match(out.formulaAnalysis, /^本方以鹿茸补涩丸为基础加减。/);
  const control = candidateAfter(prescribeOf({ name: "知柏地黄丸加减", herbs: [...herbs, "知母", "黄柏"], overview, source: "知柏地黄丸：《医宗金鉴》",
    analysis: "本方以知柏地黄丸为基础加减。知母、黄柏为君。" }));
  assert.equal(control.name, "知柏地黄丸加减");
  assert.equal(control.formulaSource.source, "知柏地黄丸：《医宗金鉴》");
});

await check("1.5 教材改名的两道判据各自单独成立：① 只认推荐方向里的方——推荐鹿茸补涩丸、处方却是知柏地黄丸组成时不改名成知柏地黄丸；② 方名承载药不在方中的教材方不算覆盖——咳嗽·肺阴亏虚证推荐沙参麦冬汤、方中无沙参时不改名（再投影一次不变）", () => {
  const urine = { tcmDiseaseName: "尿浊", primarySyndrome: "肾虚不固证", recommendedFormulaDirection: "鹿茸补涩丸加减" };
  const yin = candidateAfter(prescribeOf({ name: "自拟方", herbs: ["熟地黄", "山茱萸", "山药", "茯苓", "泽泻", "牡丹皮", "知母", "黄柏"], overview: urine,
    analysis: "本方为自拟方。知母、黄柏为君。" }));
  assert.equal(yin.name, "自拟方");
  const cough = { tcmDiseaseName: "咳嗽", primarySyndrome: "肺阴亏虚证", recommendedFormulaDirection: "沙参麦冬汤加减" };
  const input = prescribeOf({ name: "自拟方", herbs: ["麦冬", "玉竹", "天花粉", "桑叶", "白扁豆", "甘草"], overview: cough, analysis: "本方为自拟方。麦冬、玉竹为君。" });
  const once = project(input);
  assert.equal(once.formula.candidates[0].name, "自拟方");
  assert.deepEqual(project(once), once, "幂等");
  // 对照：方中有北沙参时照常改回教材代表方。
  const withGlehnia = candidateAfter(prescribeOf({ name: "自拟方", herbs: ["北沙参", "麦冬", "玉竹", "天花粉", "桑叶", "白扁豆", "甘草"], overview: cough, analysis: "本方为自拟方。麦冬、玉竹为君。" }));
  assert.equal(withGlehnia.name, "沙参麦冬汤加减");
});

// ───── 2 方义开头与方名同一判据 ─────
await check("2.1 方名是成方而开头说自拟 → 以该方为基础；方名是自拟方而开头说以某方为基础 → 自拟方，参照该方化裁；「本方为以虎潜丸加减」→「本方以虎潜丸为基础加减」", () => {
  const open = (analysis, name) => review.withOpeningMatchingFormulaName(analysis, name).text;
  assert.equal(open("本方为自拟方，以清热解毒、凉血透疹为法。金银花、连翘为君。", "清宫汤加减"), "本方以清宫汤为基础加减，以清热解毒、凉血透疹为法。金银花、连翘为君。");
  assert.equal(open("本方以牵正散为基础加减。白附子、僵蚕为君。", "自拟方"), "本方为自拟方，参照牵正散化裁。白附子、僵蚕为君。");
  assert.equal(open("本方为以虎潜丸加减，以补益肝肾为法。", "虎潜丸加减"), "本方以虎潜丸为基础加减，以补益肝肾为法。");
  assert.equal(open("本方以知柏地黄丸为基础加减。鹿茸为君。", "鹿茸补涩丸加减"), "本方以鹿茸补涩丸为基础加减。鹿茸为君。");
  // 对照：一致的、不是这几种开头的、点到的不是方名的、方名不像方名的，都不动。
  for (const [analysis, name] of [
    ["本方以虎潜丸为基础加减，以补益肝肾为法。", "虎潜丸加减"],
    ["本方为自拟方，以健脾为法。", "自拟方"],
    ["方中黄芪为君。", "补中益气汤加减"],
    ["本方以补气活血为法加减。", "补阳还五汤加减"],
    ["本方以左归丸为基础加减。熟地黄为君。", "x"],
  ]) assert.equal(open(analysis, name), analysis, `${name}｜${analysis}`);
});

await check("2.2 交付面：教材改名时方义开头不再成「本方为以X加减」（H 集 10322 等）；投影后开头与方名一致", () => {
  const overview = { tcmDiseaseName: "尿浊", primarySyndrome: "肾虚不固证", recommendedFormulaDirection: "鹿茸补涩丸加减" };
  const out = candidateAfter(prescribeOf({ name: "本例辨证组方", herbs: ["鹿茸", "菟丝子", "桑螵蛸", "补骨脂", "肉桂", "附子", "茯苓", "莲子", "五味子", "山药"], overview,
    analysis: "本方为自拟方，按肾阳不足、封藏失职之机化裁。鹿茸为君。" }));
  assert.equal(out.name, "鹿茸补涩丸加减");
  assert.match(out.formulaAnalysis, /^本方以鹿茸补涩丸为基础加减，按肾阳不足/);
  assert.doesNotMatch(out.formulaAnalysis, /本方为以/);
});

// ───── 3 方义残句 ─────
await check("3.1 删掉以外来药开头的整句不再留「。。」（M/H 集 20 余例）；删的是句中一个小句时照常只留一个句号（对照）", () => {
  const herbs = ["地黄", "麦冬", "天冬", "玄参", "黄连", "甘草"];
  const a = review.reviewAuthoredFormulaAnalysis("本方以天王补心丹合朱砂安神丸为基础加减。朱砂重镇安神。地黄、麦冬为君，滋阴养血；天冬、玄参为臣，黄连清心；甘草为使，调和诸药。", herbs).text;
  assert.equal(a, "本方以天王补心丹合朱砂安神丸为基础加减。地黄、麦冬为君，滋阴养血；天冬、玄参为臣，黄连清心；甘草为使，调和诸药。");
  const b = review.reviewAuthoredFormulaAnalysis("本方以天王补心丹为基础加减。地黄、麦冬为君，滋阴养血；天冬、玄参为臣，黄连清心；甘草为使，调和诸药。龙骨、牡蛎镇惊，使神安。全方滋阴清火。", herbs).text;
  assert.doesNotMatch(b, /。。/);
  assert.match(b, /调和诸药。全方滋阴清火。$/);
  // 对照：删的是句中小句
  const c = review.reviewAuthoredFormulaAnalysis("地黄、麦冬为君，滋阴养血；朱砂镇心安神；天冬、玄参为臣，黄连清心；甘草为使，调和诸药。", herbs).text;
  assert.equal(c, "地黄、麦冬为君，滋阴养血；天冬、玄参为臣，黄连清心；甘草为使，调和诸药。");
  // 交付面兜住缓存里已有的「。。」
  const projected = candidateAfter(prescribeOf({ name: "自拟方", herbs, analysis: "本方为自拟方。地黄、麦冬为君，滋阴养血；甘草为使，调和诸药。。" }));
  assert.equal(projected.formulaAnalysis, "本方为自拟方。地黄、麦冬为君，滋阴养血；甘草为使，调和诸药。");
});

await check("3.2 删掉外来药的小句后，紧跟的没有主语的半句一并删（「助当归安其心神」「又制黄连苦寒伤胃」，M 集 BEST4SDT-279、RobustSDT-0641）；下一小句以本方药开头时照留（对照）", () => {
  const herbs = ["白术", "当归", "川芎", "甘草", "茯苓", "黄连"];
  const a = review.reviewAuthoredFormulaAnalysis("本方以加味四物汤为基础加减，当归、川芎为臣；白术健脾助运，针对大便时溏；酸枣仁养心安神，助当归安其心神；甘草为使，调和诸药。茯苓渗湿。", herbs).text;
  assert.doesNotMatch(a, /助当归安其心神/);
  assert.match(a, /针对大便时溏；甘草为使/);
  const b = review.reviewAuthoredFormulaAnalysis("本方为自拟方。当归、川芎为臣，养血活血；干姜辛温，又制黄连苦寒伤胃；茯苓渗湿，甘草为使，调和诸药。白术健脾。", herbs).text;
  assert.doesNotMatch(b, /又制黄连/);
  // 对照
  const c = review.reviewAuthoredFormulaAnalysis("本方为自拟方。当归、川芎为臣，养血活血；干姜辛温，黄连清热燥湿；茯苓渗湿，甘草为使，调和诸药。白术健脾。", herbs).text;
  assert.match(c, /黄连清热燥湿/);
});

await check("3.3 方义只点了角色的药补上药味表里它的功效（「牛膝为佐。」「黄芪、当归为君，川芎…为臣」）；后面接着说它自己作用的、角色后有说明的不补（对照）", () => {
  const herbs = [herbRow("桂枝", "佐", "温通经脉"), herbRow("牛膝", "佐", "补肝肾，强筋骨"), herbRow("炙甘草", "使", "调和诸药"),
    herbRow("黄芪", "君", "补气升阳"), herbRow("当归", "君", "补血活血"), herbRow("川芎", "臣", "活血行气"), herbRow("甘草", "使", "调和诸药")];
  const fill = (text) => review.withRoleOnlyHerbsExplained(text, herbs).text;
  assert.equal(fill("桂枝为佐，温通经脉；牛膝为佐。炙甘草为使，调和诸药。"), "桂枝为佐，温通经脉；牛膝为佐，补肝肾、强筋骨。炙甘草为使，调和诸药。");
  assert.equal(fill("黄芪、当归为君，川芎为臣，活血行气。"), "黄芪、当归为君，黄芪补气升阳，当归补血活血，川芎为臣，活血行气。");
  assert.equal(fill("牛膝为佐，甘草为使，调和诸药。"), "牛膝为佐，补肝肾、强筋骨，甘草为使，调和诸药。");
  for (const text of ["黄芪、当归为君，黄芪补气，当归养血。", "牛膝为佐，引血下行。", "黄芪为君，与当归相须。"]) assert.equal(fill(text), text);
});

await check("3.4 方义里阴性净化器写的病历断言小句去掉（M 集 MTCMB-42「…升阳行血，有胸闷；」）；没有这种句式时不动（对照）", () => {
  assert.equal(review.withoutChartAssertionClauses("人参、黄芪为君，大补心气、升阳行血，病历已记录胸闷阳性；桃仁为臣。").text, "人参、黄芪为君，大补心气、升阳行血；桃仁为臣。");
  assert.equal(review.withoutChartAssertionClauses("人参、黄芪为君，大补心气，病历尚未确认心悸是否存在。桃仁为臣。").text, "人参、黄芪为君，大补心气。桃仁为臣。");
  const plain = "人参、黄芪为君，大补心气，兼顾胸闷；桃仁为臣。";
  assert.equal(review.withoutChartAssertionClauses(plain).text, plain);
  // 交付面：在换成「有X」之前去掉
  const out = candidateAfter(prescribeOf({ name: "自拟方", herbs: ["人参", "黄芪", "桃仁"], analysis: "本方为自拟方。人参、黄芪为君，大补心气、升阳行血，病历已记录胸闷阳性；桃仁为臣，活血。" }));
  assert.doesNotMatch(out.formulaAnalysis, /有胸闷|病历/);
});

await check("3.5 修复轮理由「…方向未成立」整句去掉（M 集 BEST4SDT-250）；流程括注「（毒性管制药，…经审方复核）」去掉（BEST4SDT-205）；「，为黄连片、胆南星为君」去掉多的「为」（H 集 X-H-0047）；对照照留", () => {
  const herbs = ["黄芪", "山药", "枸杞子", "党参", "白术", "茯苓", "甘草"];
  const a = review.reviewAuthoredFormulaAnalysis("本方为自拟方。黄芪、山药为君，补气健脾。枸杞子为臣，滋补肝肾。党参为佐，白术、茯苓健脾渗湿。甘草为使调和诸药。去菟丝子，因本例无寒热偏象可据，其温阳方向未成立。全方补气与填精并行。", herbs).text;
  assert.doesNotMatch(a, /未成立|菟丝子/);
  assert.match(a, /甘草为使调和诸药。全方补气与填精并行。$/);
  assert.equal(review.withoutProcessParentheticals("本方为自拟方，参照乌头汤化裁，去制川乌（毒性管制药，用量由医师单独确定并经审方复核），加桂枝。").text,
    "本方为自拟方，参照乌头汤化裁，去制川乌，加桂枝。");
  assert.equal(review.withoutProcessParentheticals("龟甲（先煎）滋阴潜阳。").text, "龟甲（先煎）滋阴潜阳。", "对照：不是流程话的括注照留");
  assert.equal(review.withoutStrayLeadingRoleVerb("本方以黄连解毒汤合定痫丸加减，为黄连片、胆南星为君，清心化痰。").text, "本方以黄连解毒汤合定痫丸加减，黄连片、胆南星为君，清心化痰。");
  assert.equal(review.withoutStrayLeadingRoleVerb("本方以银翘散为基础加减，为治风热犯肺之辛凉平剂。金银花为君。").text, "本方以银翘散为基础加减，为治风热犯肺之辛凉平剂。金银花为君。", "对照：「为」后不是药名");
});

await check("3.6 方义说法删段时不把前后两段粘在一起（M 集 TCM-SD-463912「以羌活、茯苓皮为君茯苓皮…」）", () => {
  const herbs = ["羌活", "茯苓皮", "大腹皮", "泽泻"];
  const text = "本方以疏凿饮子为基础加减，以羌活、茯苓皮为君，羌活利水消肿，茯苓皮淡渗利水，直消肌肤浮肿；大腹皮、泽泻为臣，行气利水。全方分消水湿，共奏利水消肿之效。";
  const out = review.removeVerifiedHerbClaims(text, herbs, [{ herb: "羌活", clause: "羌活利水消肿", claim: "利水消肿" }], (herb) => knowledge.herbFunctionKnowledgeForDisplay(herb));
  assert.equal(out.removals.length, 1);
  assert.doesNotMatch(out.text, /为君茯苓皮/);
  assert.match(out.text, /以羌活、茯苓皮为君，茯苓皮淡渗利水/);
});

// ───── 4 方义里错误的「去/加」 ─────
await check("4.1 「去」的药其实在方中：去原方中辛温走窜之川芎减量（BEST4SDT-118）、去白蜜之冲服而取蜂蜜入煎（白蜜即蜂蜜，193）、去原方之甘草用量从简并加苍术（X-H-0456）——去掉不实的说法，加药半句留下；换药说法（「去原方熟地之滋腻，以生地黄易之」）照留（对照）", () => {
  const after = (name, herbs, analysis) => candidateAfter(prescribeOf({ name, herbs, analysis })).formulaAnalysis;
  assert.equal(after("补肝汤加减", ["当归", "白芍", "熟地黄", "酸枣仁", "川芎", "木瓜", "枸杞子", "炙甘草"], "本方以补肝汤为基础加减，去原方中辛温走窜之川芎减量、加枸杞子以增养肝明目之力。当归、白芍为君，养血柔肝。"),
    "本方以补肝汤为基础加减，加枸杞子以增养肝明目之力。当归、白芍为君，养血柔肝。");
  assert.equal(after("黄芪汤加减", ["黄芪", "火麻仁", "陈皮", "白术", "蜂蜜"], "本方以黄芪汤为基础加减，去白蜜之冲服而取蜂蜜入煎。黄芪为君，补气健脾。"),
    "本方以黄芪汤为基础加减。黄芪为君，补气健脾。");
  assert.equal(after("羌活胜湿汤加减", ["羌活", "独活", "防风", "藁本", "蔓荆子", "川芎", "苍术", "甘草"], "本方以羌活胜湿汤为基础加减，去原方之甘草用量从简并加苍术。羌活、独活为君。"),
    "本方以羌活胜湿汤为基础加减，加苍术。羌活、独活为君。");
  const swap = "本方以桃红四物汤为基础加减，去原方熟地之滋腻，以生地黄易之。桃仁、红花为君。";
  assert.equal(after("桃红四物汤加减", ["桃仁", "红花", "当归", "川芎", "白芍", "生地黄"], swap), swap);
});

await check("4.2 「去原方之峻消」而保和丸七味俱在（X-H-0331）：去掉，后面的加药照留；原方有的药真的没开时「去X」照留（对照）", () => {
  const herbs = ["山楂", "六神曲", "半夏", "茯苓", "陈皮", "连翘", "莱菔子", "芦根"];
  const out = candidateAfter(prescribeOf({ name: "保和丸加减", herbs, analysis: "本方以保和丸为基础加减，去原方之峻消，加芦根以顾津伤。山楂、六神曲为君。" })).formulaAnalysis;
  assert.equal(out, "本方以保和丸为基础加减，加芦根以顾津伤。山楂、六神曲为君。");
  // 同一小句里接着加药（「去原方之峻消而加芦根」）：加药那半句留下。
  assert.equal(candidateAfter(prescribeOf({ name: "保和丸加减", herbs, analysis: "本方以保和丸为基础加减，去原方之峻消而加芦根以顾津伤。山楂、六神曲为君。" })).formulaAnalysis,
    "本方以保和丸为基础加减，加芦根以顾津伤。山楂、六神曲为君。");
  const control = "本方以保和丸为基础加减，去连翘，加芦根以顾津伤。山楂、六神曲为君。";
  assert.equal(candidateAfter(prescribeOf({ name: "保和丸加减", herbs: herbs.filter((name) => name !== "连翘"), analysis: control })).formulaAnalysis, control);
});

await check("4.3 同名异方（RobustSDT-0061 四七汤）：教材四七汤（半夏、厚朴、茯苓、苏叶、姜、枣）而受治理条目是《局方》人参、官桂、半夏、甘草——「加紫苏叶、厚朴、生姜、大枣」不实去掉、「加佛手、香附」留；出处写教材不署《局方》；不是同名异方时教材组成里的加味不当原方（胁痛逍遥散「加香附」照留，对照）", () => {
  const overview = { tcmDiseaseName: "呕吐", primarySyndrome: "肝气犯胃证", recommendedFormulaDirection: "四七汤加减", recommendedFormulaNames: ["四七汤"] };
  const out = candidateAfter(prescribeOf({ name: "四七汤加减", herbs: ["半夏", "紫苏叶", "厚朴", "茯苓", "佛手", "香附", "生姜", "大枣"], overview,
    source: "四七汤：《太平惠民和剂局方》", analysis: "本方以四七汤为基础加减，加紫苏叶、厚朴、佛手、香附、生姜、大枣。半夏为君。" }));
  assert.equal(out.formulaAnalysis, "本方以四七汤为基础加减，加佛手、香附。半夏为君。");
  assert.equal(out.formulaSource.source, "四七汤：《中医内科学》呕吐·肝气犯胃证代表方");
  const xiaoyao = { tcmDiseaseName: "胁痛", primarySyndrome: "肝郁气滞证", recommendedFormulaDirection: "逍遥散加减", recommendedFormulaNames: ["逍遥散"] };
  const control = "本方以逍遥散为基础加减，去薄荷之辛散，加香附、陈皮以增理气。柴胡为君。";
  assert.equal(candidateAfter(prescribeOf({ name: "逍遥散加减", herbs: ["柴胡", "当归", "白芍", "白术", "茯苓", "炙甘草", "香附", "陈皮"], overview: xiaoyao,
    source: "逍遥散：《太平惠民和剂局方》", analysis: control })).formulaAnalysis, control);
});

// ───── 5 方义药名按药味表写 ─────
await check("5.1 方义写炮制/修治名而药味表是原名：朱茯神→茯神、煅石决明、姜天麻、盐杜仲、麸炒枳壳、酒黄芩、冬桑叶、生甘草；熟地黄对地黄、川牛膝对牛膝、当归身对当归不改（对照）", () => {
  const align = (text, table) => review.withMentionsAlignedToTableNames(text, table).text;
  assert.equal(align("天麻、钩藤为君；朱茯神宁心安神；冬桑叶清肝；生甘草调和。", ["天麻", "钩藤", "茯神", "桑叶", "甘草"]), "天麻、钩藤为君；茯神宁心安神；桑叶清肝；甘草调和。");
  assert.equal(align("姜天麻息风，煅石决明平肝，盐杜仲补肾，麸炒枳壳行气，酒黄芩清热。", ["天麻", "石决明", "杜仲", "枳壳", "黄芩"]), "天麻息风，石决明平肝，杜仲补肾，枳壳行气，黄芩清热。");
  const control = "熟地黄滋阴，当归身养血，川牛膝引血下行。";
  assert.equal(align(control, ["地黄", "当归", "牛膝"]), control);
});

// ───── 6 药味功效栏 ─────
await check("6.1 「调和诸药」只属调和药：茯神、五味子作使药写的「调和诸药」去掉；甘草、大枣、生姜照留；只剩这一条时不动（对照）", () => {
  const strip = (name, fn) => review.withoutUnsupportedHarmonizingClause(name, fn, kb(name));
  assert.equal(strip("茯神", "宁心安神，调和诸药"), "宁心安神");
  assert.equal(strip("五味子", "敛阴固涩，调和诸药"), "敛阴固涩");
  assert.equal(strip("甘草", "补脾益气，调和诸药"), "补脾益气，调和诸药");
  assert.equal(strip("大枣", "补中益气，调和药性"), "补中益气，调和药性");
  assert.equal(strip("生姜", "温中止呕，调和诸药"), "温中止呕，调和诸药");
  assert.equal(strip("茯神", "调和诸药"), "调和诸药");
  // 方义：主语不是调和药时去掉「调和诸药」；甘草作主语、「肝脾调和」「调和营卫」照留（对照）
  const herbs = ["茯神", "益母草", "五味子", "甘草", "牛膝", "生姜", "大枣", "防风", "首乌藤", "栀子", "牡丹皮"];
  const claims = (text) => review.withoutUnsupportedHarmonizingClaims(text, herbs, kb).text;
  assert.equal(claims("栀子清热；益母草引血下行、调和诸药为使。"), "栀子清热；益母草引血下行为使。");
  assert.equal(claims("首乌藤养心安神，茯神为使，宁心调和诸药。"), "首乌藤养心安神，茯神为使，宁心。");
  assert.equal(claims("牡丹皮为佐，五味子敛阴调和为使。"), "牡丹皮为佐，五味子敛阴为使。");
  for (const text of ["牛膝、甘草为使，调和诸药。", "生姜、大枣为使，调和营卫。", "防风升散调气、助肝脾调和，为佐。"]) assert.equal(claims(text), text);
});

await check("6.2 功效栏括注与近义重复：牛膝「引热(血)下行，且补肝肾(玉女煎)」、桔梗「载药上行(舟楫)」、石膏「清热泻火，清热降火」、栀子「清热解毒，清热利尿，清热利湿」、附子「散寒除湿，祛寒止痛，散寒止痛」、枳实「化痰，化痰散痞」；黄芩「清热燥湿，泻火解毒」等不动（对照）", () => {
  const concise = (text, max) => review.conciseHerbFunctionLabel(text, max);
  assert.equal(concise("引热(血)下行，且补肝肾(玉女煎)"), "引热下行，补肝肾");
  assert.equal(concise("载药上行(舟楫)"), "载药上行");
  assert.equal(concise("清热泻火，清热降火"), "清热泻火");
  assert.equal(concise("清热解毒，清热利尿，清热利湿"), "清热解毒，清热利尿");
  assert.equal(concise("散寒除湿，祛寒止痛，散寒止痛"), "散寒除湿，祛寒止痛");
  assert.equal(concise("化痰，化痰散痞"), "化痰散痞");
  assert.equal(concise("补中益气，补脾益气，养心安神", 2), "补中益气，养心安神");
  for (const text of ["清热燥湿，泻火解毒", "补肝肾，强筋骨", "活血调经，利尿消肿", "凉血止血，兼利小便"]) assert.equal(concise(text), text);
  // 交付面：功效栏整理与调和药两条一起过
  const out = candidateAfter(prescribeOf({ name: "自拟方", herbs: [herbRow("茯神", "使", "宁心安神，调和诸药"), herbRow("桔梗", "使", "载药上行(舟楫)"), herbRow("甘草", "使", "调和诸药")],
    analysis: "本方为自拟方。茯神宁心安神，桔梗载药上行，甘草调和诸药。" }));
  assert.deepEqual(out.herbs.map((herb) => herb.function), ["宁心安神", "载药上行", "调和诸药"]);
});

await check("6.3 功效方向词补全：当归「升举清阳」、广藿香「升清荣窍」、陈皮「通阳宣痹」、青皮「清解郁热」、川木通「通利大便」判无依据；桂枝「通阳化气」（库里助阳化气）、柴胡「升举阳气」照认（对照）", () => {
  const unsupported = (name, fn) => contract.herbFunctionClaimUnsupportedPhrases(fn, knowledge.herbFunctionKnowledgeForDisplay(name));
  assert.deepEqual(unsupported("当归", "养血活血，升举清阳"), ["升举清阳"]);
  assert.ok(unsupported("广藿香", "芳香化浊，升清荣窍").includes("升清"));
  assert.deepEqual(unsupported("陈皮", "理气健脾，通阳宣痹"), ["通阳"]);
  assert.deepEqual(unsupported("青皮", "疏肝破气，清解郁热"), ["清解郁热"]);
  assert.deepEqual(unsupported("川木通", "利尿通淋，通利大便"), ["通利大便"]);
  assert.deepEqual(unsupported("桂枝", "温经通脉，通阳化气"), []);
  assert.deepEqual(unsupported("柴胡", "疏肝解郁，升举阳气"), []);
});

await check("6.4 瓦楞子知识库功用里的「补气养血」剔除（M 集 TCM-SD-461334；教材【功效】消痰化瘀，软坚散结，制酸止痛）；软坚散结、制酸止痛照留（对照）", () => {
  const text = knowledge.getTcmHerbFunctionText("瓦楞子");
  assert.doesNotMatch(text, /补气养血/);
  assert.match(text, /软坚散结/);
  assert.match(text, /制酸止痛/);
  assert.deepEqual(contract.herbFunctionClaimUnsupportedPhrases("软坚散结，补气养血", knowledge.herbFunctionKnowledgeForDisplay("煅瓦楞子")).sort(), ["养血", "补气"].sort());
  assert.deepEqual(contract.herbFunctionClaimUnsupportedPhrases("软坚散结，补气养血", knowledge.herbFunctionKnowledgeForDisplay("黄芪")).filter((phrase) => phrase === "补气"), [], "对照：黄芪的补气照认");
});

// ───── 7 加减 ─────
await check("7.1 加减理由里这味药没有的功效从头尾去掉（北沙参「益气养阴，固表止汗」→「养阴」（「止汗」不是它的功效也不留），连翘「清热散结兼通肠腑」→「清热散结」）；讲与别的药关系的小句照留（对照）；条件与药都相同的行只留一条，条件同、药不同的照留（对照）", () => {
  const modifications = [
    { trigger: "若汗多气短", action: "加", herbName: "北沙参", doseOrHandling: "6g", reason: "益气养阴，固表止汗", riskNote: "" },
    { trigger: "若大便干结难下", action: "加", herbName: "连翘", doseOrHandling: "12g", reason: "清热散结兼通肠腑", riskNote: "" },
    { trigger: "若尿血", action: "加", herbName: "仙鹤草", doseOrHandling: "15g", reason: "收敛止血，助凉血", riskNote: "" },
    { trigger: "若脾气亏虚，甚或脏器下垂", action: "加", herbName: "黄芪", doseOrHandling: "15g", reason: "补气升阳", riskNote: "" },
    { trigger: "若脾气亏虚，甚或脏器下垂", action: "加", herbName: "黄芪", doseOrHandling: "15g", reason: "补气升阳", riskNote: "" },
    { trigger: "若脾气亏虚，甚或脏器下垂", action: "加", herbName: "党参", doseOrHandling: "10g", reason: "健脾益气", riskNote: "" },
  ];
  const out = project(prescribeOf({ name: "自拟方", herbs: ["黄芪"], analysis: "本方为自拟方。黄芪为君，补气升阳。", modifications })).formula.modifications;
  assert.equal(out.length, 5);
  assert.equal(out[0].reason, "养阴");
  assert.equal(out[1].reason, "清热散结");
  assert.equal(out[2].reason, "收敛止血，助凉血", "讲协助别的药的小句不按这味药的功效去");
  assert.deepEqual(out.slice(3).map((item) => item.herbName), ["黄芪", "党参"]);
});

await check("7.2 教材加减「通血络非虫蚁所不能」「化络瘀非天麻三七所不能」不当加减条件（M 集 TCM-SD-433619）；同一行其余加减照留（对照）", () => {
  const row = textbook.textbookRowForSyndrome("痴呆", "瘀阻脑络证");
  assert.ok(row, "教材行存在");
  assert.ok(!row.modifications.some((item) => /不能/u.test(item.condition)), JSON.stringify(row.modifications.map((item) => item.condition)));
  const other = textbook.textbookRowForSyndrome("瘿病", "痰结血瘀证");
  assert.ok(other.modifications.some((item) => /结块坚硬/u.test(item.condition)), "对照：别的加减照留");
});

// ───── 8 出处 ─────
await check("8.1 教材代表方的原书：化肝煎取国家经典名方目录《景岳全书》（受治理条目是《成方切用》）；十全大补丸借同方汤剂《太平惠民和剂局方》；教材没列组成时照用目录出处（银翘散《温病条辨》）；药典成药条目不算原书（加味逍遥散）；同名异方（大七气汤）不认（对照：竹叶石膏汤《伤寒论》）", () => {
  const source = (disease, syndrome, name) => {
    const row = textbook.textbookRowForSyndrome(disease, syndrome);
    const comp = (row?.compositionByFormula?.find((item) => item.formula === name)?.herbs) || row?.composition || [];
    return provenance.textbookFormulaOriginalSource(name, comp, { compositionIsUnion: (row?.formulas.length || 0) > 1 && !(row?.compositionByFormula?.length) });
  };
  assert.match(source("胃痛", "肝胃郁热证", "化肝煎"), /景岳全书/);
  assert.match(source("癌病", "气血双亏证", "十全大补丸"), /太平惠民和剂局方/);
  assert.match(source("风热赤眼", "风重于热证", "银翘散"), /温病条辨/);
  assert.doesNotMatch(String(source("内伤发热", "气郁发热证", "加味逍遥散")), /药典/);
  assert.equal(source("积证", "气滞血阻证", "大七气汤"), undefined);
  const comp = textbook.textbookRowForSyndrome("积证", "气滞血阻证").composition;
  assert.equal(provenance.textbookFormulaGovernedEntryIsHomonym("大七气汤", comp), true);
  assert.equal(provenance.textbookFormulaGovernedEntryIsHomonym("银翘散", ["金银花", "连翘", "薄荷", "牛蒡子", "荆芥"]), false);
  assert.match(provenance.textbookFormulaOriginalSource("竹叶石膏汤", ["竹叶", "石膏", "半夏", "麦冬", "人参", "甘草", "粳米"]), /伤寒论/);
});

await check("8.2 不给剂量页合方出处每张方名都留（H 集 12291「《三因极一病证方论》；四神丸：《内科摘要》」）；单方去掉方名前缀（对照）", async () => {
  const checkpointModule = await jiti.import("../src/lib/m04-delivery-checkpoint.ts");
  const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");
  const { compileM04Proposal } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
  const prior = ReasoningV2Schema.parse({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "脾胃虚弱证", overallPathogenesis: "脾胃虚弱，运化无力", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "食少倦怠", syndromeEvidence: "食少倦怠", pathogenesis: "脾胃虚弱，运化无力", therapyDirection: "健脾益气" }] },
    therapy: { overallPrinciple: "虚则补之", overallMethod: "健脾益气", subTherapies: [{ therapy: "健脾益气", targetPathogenesis: "脾胃虚弱", priority: "主要" }] },
    formula: { candidates: [], patentAndWestern: [], modifications: [] },
  });
  const reasoning = compileM04Proposal({
    candidate: {
      name: "本例辨证组方", applicable: "", notApplicable: "",
      herbs: [
        { name: "党参", dose: "12g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "补脾益气" },
        { name: "白术", dose: "10g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "健脾燥湿" },
        { name: "茯苓", dose: "12g", role: "佐", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "健脾渗湿" },
      ].map((herb) => ({ ...herb, processing: null, isToxic: false, decoctionRequirement: null })),
      formulaAnalysis: "党参补脾益气为君，白术燥湿为臣，茯苓渗湿为佐。",
      decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，煎服", followUpNode: "5日复诊" },
    },
    patentAndWestern: [], modifications: [],
    nonPharma: { diet: "清淡饮食。", lifestyle: "规律作息。", emotion: "调畅情志。", precautions: ["观察食欲。"], tcmTreatments: [] },
  }, prior);
  assert.ok(reasoning, "编译出候选");
  const render = (source) => {
    const copy = structuredClone(reasoning);
    copy.formula.candidates[0].formulaSource = { evidenceLevel: "kb_entry", source, confidence: "中" };
    const checkpoint = checkpointModule.retainM04DeliveryCheckpoint(undefined, {
      reasoning: copy, content: `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(copy)}\n<!-- DIAGNOSIS_JSON_END -->`,
      priorReasoning: prior, clinicalContext: "食少倦怠", generatorModel: "synthetic",
    });
    return checkpointModule.renderM04DeliveryCheckpoint(checkpoint, prior, "dose_withheld", ["占位原因"]);
  };
  assert.match(render("附子理中汤：《三因极一病证方论》；四神丸：《内科摘要》"), /出处：附子理中汤：《三因极一病证方论》；四神丸：《内科摘要》/);
  assert.match(render("化肝煎：《景岳全书》"), /出处：《景岳全书》/);
});

// ───── 9 原方扣除药味的说明 ─────
await check("9.1 原方扣除的毒性药写成临床说法「原方中的制川乌毒性较大，本方未用。」（H 集 X-H-0425 判系统句）；方义已说到这味时不补（对照）", () => {
  const herbs = ["麻黄", "桂枝", "白芍", "黄芪", "苍术", "牛膝", "炙甘草"];
  const noted = hooks.withWithheldBaseIngredientNote("本方以乌头汤为基础加减。麻黄辛温开腠、散寒通痹为君。", ["乌头汤"], herbs);
  assert.equal(noted, "本方以乌头汤为基础加减。原方中的制川乌毒性较大，本方未用。麻黄辛温开腠、散寒通痹为君。");
  assert.doesNotMatch(noted, /药味表|单独确定/);
  const control = "本方以乌头汤为基础，去川乌之峻。麻黄为君。";
  assert.equal(hooks.withWithheldBaseIngredientNote(control, ["乌头汤"], herbs), control);
});

console.log(JSON.stringify({ suite: "r1019-round4-formula", cases, failures: process.exitCode ? "see above" : 0 }));
