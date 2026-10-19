// 10/19 第五轮（2026-10-19）：Claude 评审 21b9bef 的 M 集 360 例，G（辅助中药饮片）257/360 不合格清单里服务端造成、
// 或服务端能确定性兜住的处方类缺陷，一类一修。
//
// 每条断言都带对照（不该变的输入保持不变），并跑过反证（撤掉改动后变红，记录在 ~/runlogs/r1018/work/r1019/counterproofs.txt「5/formula/…」）。
//
//   1 方义残句「本方未用。」：编译补的「原方中的X毒性较大，本方未用。」在处方被剥成自拟方时随「原方→本方案」变成
//     「本方案中的朱砂粉…」，方外药核对删掉这个分句只剩残句（MTCMB-73、MTCMB-82、RobustSDT-0034、X-H-0426、H-tri-3366）
//   2 方义里不实的「去/加」：去原方之某药性而原方俱在（0646 补中益气汤「去原方之升散有余」）、点名去的药仍在方中且说法超出
//     交付面 16 字的窗口（MTCMB-81 益母草）、方名剂型在编译目录里查不到时借同方另一剂型的组成（418 十全大补丸「加黄芪」）
//   3 功效写错：功效栏补「聪耳」「润目」「燥湿」「化痰」「化湿」与正相反的「固摄」、升举药「引药下行」几类（仅展示，不进准入）；
//     方义里与参考功效方向正相反的说法确定性报出、走第二道核对后删（牛膝「兼固摄小便」、吴茱萸「兼清郁热」、升麻「引药下行」）；
//     「吴茱萸散寒」里的「吴茱萸散」不当方名（吴茱萸在方义里点得到）
//   4 名实不符：核心药（至少两味）一味都不在处方里的方不再以它命名（涤痰汤无半夏、天南星，MTCMB-59、X-G-1785）；
//     名录各版本组成的覆盖率（formulaNameCatalogCoverage，给交付面改回教材代表方时核编译目录没收的方：化坚二陈丸，TCMChat-test-482）
//   5 出处：名录写法多一个产地、品质字（川萆薢、尖槟榔、黑元参）对不上教材组成，教材代表方的出处写成了教材
//     （程氏萆薢分清饮《医学心悟》RobustSDT-single_0541、止痛如神汤《外科启玄》TCM-SD-421902）
//   7 煎法：水牛角按药典「宜先煎3小时以上」（RobustSDT-single_0232 写成「先煎20–30分钟」）；组的编号不变
//   9 同一标准规范身份的药味行在归一化时合并（RobustSDT-single_0329 香苏散合良附丸两行香附，三轮都被 superRefine 拒掉、整页无候选）
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

const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const { m04CompilerTestHooks: hooks, compileM04Proposal } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");

const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const review = await jiti.import("../src/lib/formula-analysis-review.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const noteModule = await jiti.import("../src/lib/formula-withheld-ingredient-note.ts");

// 与第四轮处方套件同一形态的最小开方结果（交付面投影用）。
const herbRow = (name, role = "佐", fn = "") => ({ name, role, function: fn, dose: "10g" });
const prescribeOf = ({ name, herbs, analysis = "", source = "", formulaNames, overview = {}, modifications = [], decoctionMethod }) => ({
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
      ...(decoctionMethod ? { decoction: { method: decoctionMethod } } : {}),
    }],
    patentAndWestern: [],
    modifications,
  },
  nonPharma: {},
});
const candidateAfter = (reasoning) => surface.projectDeliveredReasoning(reasoning).formula.candidates[0];

// ───── 1 方义残句「本方未用。」 ─────
await check("1.1 处方被剥成自拟方（天王补心丹合朱砂安神丸而组成核不上）：编译补的「原方中的朱砂粉毒性较大，本方未用。」整句去掉，不再变成「本方案中的朱砂粉…」再被方外药核对剪成残句「本方未用。」；仍是天王补心丹加减（single_base）时这句照留（对照）；写法与识别同一处（再补一次可被认出）", () => {
  const herbs = ["人参", "生地黄", "麦冬", "天冬", "玄参", "黄连", "丹参", "酸枣仁", "柏子仁", "远志", "茯苓", "桔梗", "五味子", "当归", "炙甘草"]
    .map((name) => ({ name, dose: "10g", role: "佐", function: "养心" }));
  const enriched = (name) => {
    const analysis = `本方以${name.replace(/加减$/u, "")}为基础加减。${noteModule.withheldBaseIngredientNote(["朱砂粉"], true)}人参大补心气、生地黄滋阴养血，二味为君；炙甘草为使调和诸药。`;
    const reasoning = { stage: "prescribe", formula: { candidates: [{ name, formulaNames: [], herbs, formulaAnalysis: analysis, therapyMatch: "滋阴养心", applicable: "", notApplicable: "" }], patentAndWestern: [], modifications: [] } };
    const out = provenance.enrichReasoning(reasoning).reasoning.formula.candidates[0];
    return { out, final: review.reviewAuthoredFormulaAnalysis(out.formulaAnalysis, herbs.map((herb) => herb.name)).text };
  };
  const stripped = enriched("天王补心丹合朱砂安神丸加减");
  assert.equal(stripped.out.constructionType, "self_devised");
  assert.doesNotMatch(stripped.final, /本方未用|朱砂|本方案中的/u);
  assert.match(stripped.final, /人参大补心气/u);
  const kept = enriched("天王补心丹加减");
  assert.equal(kept.out.constructionType, "single_base");
  assert.match(kept.final, /原方中的朱砂粉毒性较大，本方未用。/u);
  // 写法与识别同一处：编译器补的这句（两种写法）都能被认出。
  for (const note of [noteModule.withheldBaseIngredientNote(["制川乌"], true), noteModule.withheldBaseIngredientNote(["麝香", "朱砂"], false)]) {
    assert.equal(noteModule.withoutWithheldBaseIngredientNote(`本方以乌头汤为基础加减。${note}麻黄为君。`), "本方以乌头汤为基础加减。麻黄为君。");
  }
  assert.equal(hooks.withWithheldBaseIngredientNote("本方以乌头汤为基础加减。麻黄辛温为君。", ["乌头汤"], ["麻黄", "桂枝", "白芍", "黄芪", "炙甘草"]),
    `本方以乌头汤为基础加减。${noteModule.withheldBaseIngredientNote(["制川乌"], true)}麻黄辛温为君。`);
});

// ───── 2 方义里不实的「去/加」 ─────
const edits = (name, herbs, analysis) => review.withoutFalseBaseFormulaEdits(analysis, provenance.formulaEditClaimBaseIngredients(name), herbs, provenance.formulaNameVariantIngredients(name)).text;
const BUZHONG = ["黄芪", "人参", "白术", "炙甘草", "陈皮", "当归", "升麻", "柴胡", "木香"];

await check("2.1 「去原方之升散有余而增木香理气」而补中益气汤八味俱在（RobustSDT-single_0646）：去药说法去掉、加药半句留下；方中真没有升麻时照留；「去瘀生新」是治法不是删药、不点原方的不动（对照）", () => {
  assert.equal(edits("补中益气汤", BUZHONG, "本方以补中益气汤为基础加减，去原方之升散有余而增木香理气。黄芪为君。"), "本方以补中益气汤为基础加减，增木香理气。黄芪为君。");
  assert.equal(edits("保和丸", ["山楂", "六神曲", "半夏", "茯苓", "陈皮", "连翘", "莱菔子"], "本方以保和丸为基础加减，去其峻消之性而加山楂以助消食。山楂为君。"),
    "本方以保和丸为基础加减。山楂为君。", "留下的加药半句再按加药说法核：山楂本在保和丸里");
  for (const [name, herbs, text] of [
    ["补中益气汤", BUZHONG.filter((herb) => herb !== "升麻"), "本方以补中益气汤为基础加减，去原方之升散有余而增木香理气。黄芪为君。"],
    ["桃红四物汤", ["桃仁", "红花", "当归", "川芎", "白芍", "熟地黄"], "本方以桃红四物汤为基础加减，去瘀生新，桃仁、红花为君。"],
  ]) assert.equal(edits(name, herbs, text), text);
});

await check("2.2 点名去掉的药仍在方中（MTCMB-81「去原方中偏于活血利水之益母草用量从轻以避出血之虞」，交付面只看 16 字以内漏过）：整小句去掉；真去了益母草时、换药「去原方熟地之滋腻，以生地黄易之」时照留（对照）", () => {
  const herbs = ["天麻", "钩藤", "石决明", "栀子", "黄芩", "牛膝", "杜仲", "桑寄生", "首乌藤", "茯神", "益母草"];
  assert.equal(edits("天麻钩藤饮", herbs, "本方以天麻钩藤饮为基础加减，去原方中偏于活血利水之益母草用量从轻以避出血之虞。天麻、钩藤为君。"), "本方以天麻钩藤饮为基础加减。天麻、钩藤为君。");
  const removed = "本方以天麻钩藤饮为基础加减，去原方中偏于活血利水之益母草以避出血之虞。天麻、钩藤为君。";
  assert.equal(edits("天麻钩藤饮", herbs.filter((herb) => herb !== "益母草"), removed), removed);
  const swap = "本方以桃红四物汤为基础加减，去原方熟地之滋腻，以生地黄易之。桃仁、红花为君。";
  assert.equal(edits("桃红四物汤", ["桃仁", "红花", "当归", "川芎", "白芍", "熟地黄", "生地黄"], swap), swap, "下一小句是换药说法");
});

await check("2.3 方名剂型在编译目录里查不到（十全大补丸；目录只有《局方》十全大补汤）：借同方另一剂型的组成、只留名录里这个方名下也有的味，「加黄芪、大枣」去掉黄芪（TCMChat-test-418）；本就查得到的方不借（对照：补中益气汤照旧）；同名另一剂型的组成不当本方组成（名录里十全大补丸没有大枣，「加大枣」照留）", () => {
  const base = provenance.formulaEditClaimBaseIngredients("十全大补丸");
  assert.ok(base.includes("黄芪") && base.includes("肉桂"), JSON.stringify(base));
  assert.ok(!base.includes("大枣"), "名录里十全大补丸各版本都没有大枣");
  assert.deepEqual(provenance.formulaEditClaimBaseIngredients("补中益气汤"), provenance.formulaCompilationReferences(["补中益气汤"])[0].ingredients);
  const herbs = ["黄芪", "熟地黄", "人参", "白术", "当归", "白芍", "茯苓", "川芎", "炙甘草", "大枣"];
  assert.equal(edits("十全大补丸", herbs, "本方以十全大补丸为基础加减，去肉桂之温燥，加黄芪、大枣以增补气生血之力。黄芪、熟地黄为君。"),
    "本方以十全大补丸为基础加减，去肉桂之温燥，加大枣以增补气生血之力。黄芪、熟地黄为君。");
});

// ───── 3 功效写错 ─────
const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");
const claimCheck = await jiti.import("../src/lib/m04-formula-analysis-claim-check.server.ts");
const unsupportedFn = (name, fn) => contract.herbFunctionClaimUnsupportedPhrases(fn, knowledge.herbFunctionKnowledgeForDisplay(name));

await check("3.1 功效栏：酸枣仁「聪耳」、桑白皮「润目」、黄芩「化痰」、白术「助运化痰」的化痰、人参「助运化湿」的化湿、牛膝「固摄小便」、升麻「引药下行」判无依据；远志「通窍聪耳」（库里开窍）、广藿香「芳香化湿」（库里化浊）、桑白皮「化痰止咳」（化痰止咳平喘药）、黄芪「益气固摄」（库里固表）、鹿茸「温肾固摄」（库里没有通利）、白术「健脾燥湿」照认（对照）", () => {
  assert.deepEqual(unsupportedFn("酸枣仁", "养心补肝，安神聪耳"), ["聪耳"]);
  assert.deepEqual(unsupportedFn("桑白皮", "清肺泻热，润目止痛"), ["润目"]);
  assert.deepEqual(unsupportedFn("黄芩", "清肺泻火，化痰止咳"), ["化痰"]);
  assert.deepEqual(unsupportedFn("白术", "健脾燥湿，助运化痰"), ["化痰"]);
  assert.deepEqual(unsupportedFn("人参", "健脾益气，助运化湿"), ["化湿"]);
  assert.deepEqual(unsupportedFn("牛膝", "引热下行，固摄小便"), ["固摄"]);
  assert.deepEqual(unsupportedFn("升麻", "升举阳气，引药下行"), ["引药下行"]);
  for (const [name, fn] of [["远志", "安神益智，通窍聪耳"], ["广藿香", "芳香化湿，和中止呕"], ["桑白皮", "泻肺平喘，化痰止咳"], ["黄芪", "补气升阳，益气固摄"],
    ["鹿茸", "温肾助阳，温肾固摄"], ["白术", "健脾燥湿，益气止汗"], ["牛膝", "引血下行，补肝肾"], ["桔梗", "宣肺利咽，载药上行"]]) {
    assert.deepEqual(unsupportedFn(name, fn), [], `${name}｜${fn}`);
  }
});

const ownRef = claimCheck.herbOwnFunctionReferenceText;
const groupRef = claimCheck.herbClaimReferenceText;
const contradictionPass = (analysis, herbs) => review.removeVerifiedHerbClaims(analysis, herbs, review.contradictedHerbClaims(analysis, herbs, ownRef, groupRef), ownRef).text;

await check("3.2 方义里与这味药参考功效方向正相反的说法（不靠小模型）：牛膝「兼固摄小便」（RobustSDT-single_0141，库里利尿通淋）、吴茱萸「兼清郁热」（0542，库里散寒温中）、升麻「引药下行」（TCM-SD-447767，库里升举阳气）删掉那一小段，其余照留", () => {
  const yunu = "本方以玉女煎为基础加减。石膏为君，清胃泻火、除烦止渴，直折胃热炽盛之势；知母、麦冬为臣，一助石膏清热，一养阴生津，使热去而津复；熟地黄为佐，滋阴养血以顾护阴液，牛膝引热下行、导热从小便而出，兼固摄小便，黄连、栀子清泄胃火、制约消谷易饥，共为佐药。全方清胃泻火与养阴增液并行。";
  assert.equal(contradictionPass(yunu, ["石膏", "知母", "麦冬", "熟地黄", "牛膝", "黄连", "栀子", "甘草"]), yunu.replace("，兼固摄小便", ""));
  const wenpi = "本方以温脾汤合吴茱萸汤加减。附子、干姜为君，温补脾肾、化气行水；人参益气健脾、大黄泻下降浊共为臣，一补一通，吴茱萸散寒降逆兼清郁热，应湿郁化热、络脉不畅；茯苓健脾渗湿，共为佐；甘草调和诸药为使。全方温补与降浊并行。";
  assert.equal(contradictionPass(wenpi, ["附子", "干姜", "人参", "大黄", "吴茱萸", "茯苓", "甘草"]), wenpi.replace("兼清郁热", ""));
  const liangxue = "本方以凉血地黄汤为基础加减。生地黄、当归为君，生地黄清热凉血、润燥生津；枳壳、天花粉为佐，枳壳理气宽中、行滞消胀，天花粉清热生津、润燥，荆芥、升麻为使，疏风升清、引药下行。甘草调和诸药、缓急止痛。";
  assert.equal(contradictionPass(liangxue, ["生地黄", "当归", "枳壳", "天花粉", "荆芥", "升麻", "甘草"]), liangxue.replace("、引药下行", ""));
});

await check("3.3 不报的（对照）：同列有一味说得通（「栀子、黄连、连翘、桔梗为佐，…兼导热下行」，BEST4SDT-44）、角色之后讲几味合起来的作用（「人参益气生津，共为佐，既助清热润燥」，0090）、说用意（「茯苓猪苓渗利下焦以助泄浊固摄」，0535）、固冲一类（「川续断补益肝肾、固摄冲任」，X-G-2360）、牛膝「引血下行」本就对", () => {
  for (const [text, herbs] of [
    ["栀子、黄连、连翘、桔梗为佐，清热解毒、利咽散结，兼导热下行，桔梗并载药上行；甘草为使。", ["栀子", "黄连", "连翘", "桔梗", "甘草"]],
    ["知母清热生津、火麻仁润肠通腑，人参益气生津，共为佐，既助清热润燥，又通肠泄热以除便结；炙甘草调和诸药为使。", ["知母", "火麻仁", "人参", "炙甘草"]],
    ["苍术、白术、茯苓、猪苓为臣，苍术白术健脾助运以治湿困脾运，茯苓猪苓渗利下焦以助泄浊固摄；泽泻为佐。", ["苍术", "白术", "茯苓", "猪苓", "泽泻"]],
    ["山药、川续断补益肝肾、固摄冲任，黄柏清下焦虚热，共为佐，标本兼顾；生甘草调和诸药为使。", ["山药", "川续断", "黄柏", "生甘草"]],
    ["熟地黄滋阴养血，牛膝引血下行、补益肝肾，共为佐。", ["熟地黄", "牛膝"]],
    // 角色之后讲的是同为佐药的几味合起来（左金丸一类：黄连清热、吴茱萸散寒，合起来清泻肝火）。
    ["黄连清热燥湿，吴茱萸散寒止痛，共为佐，清热泻火以和胃。", ["黄连", "吴茱萸"]],
  ]) assert.deepEqual(review.contradictedHerbClaims(text, herbs, ownRef, groupRef), [], text);
});

await check("3.4 「吴茱萸散寒降逆」里的「吴茱萸散」是药名加动词，不当方名挡掉（与出处层 formulaNameIsVerbPhrase 同一判据）；「以吴茱萸散为基础」照旧是方名（对照）；小模型报来的「固摄」「载药下行」落进概念组（此前 claim_outside_concept_groups 一律不删）", () => {
  assert.deepEqual(review.formulaAnalysisHerbMentions("吴茱萸散寒降逆兼清郁热").map((item) => item.token), ["吴茱萸"]);
  assert.deepEqual(review.formulaAnalysisHerbMentions("本方以吴茱萸散为基础加减").map((item) => item.token), []);
  assert.deepEqual(review.unsupportedHerbClaimConcepts("固摄", groupRef("牛膝")), ["astringe"]);
  assert.deepEqual(review.unsupportedHerbClaimConcepts("载药下行", ownRef("桔梗")), ["guide_down"]);
  // 确定性那一路也报得出（桔梗库里是载药上行，方向正相反）。
  assert.deepEqual(review.contradictedHerbClaims("桔梗宣肺利咽，载药下行；甘草调和诸药。", ["桔梗", "甘草"], ownRef, groupRef).map((item) => item.claim), ["载药下行"]);
  assert.deepEqual(review.unsupportedHerbClaimConcepts("固摄", groupRef("黄芪")), [], "对照：黄芪固表");
  assert.deepEqual(review.unsupportedHerbClaimConcepts("引血下行", groupRef("牛膝")), [], "对照：牛膝引血下行");
});

// ───── 4 名实不符 ─────
await check("4.1 涤痰汤加减而半夏、天南星都不在（MTCMB-59；服务端按痰热剔掉温燥药后方名还留着）：核心药全缺，交付方名改自拟方；有胆南星或法半夏任一味照旧（对照）；核心药只一味的天王补心丹缺朱砂不改（对照，同第四轮 1.1）；小青龙汤缺半夏、细辛、麻黄同理", () => {
  const base = ["瓜蒌", "枳实", "茯苓", "竹茹", "石菖蒲", "人参", "生姜", "甘草"];
  assert.deepEqual(provenance.formulaNameIdentityHerbsMissing("涤痰汤", base).sort(), ["半夏", "天南星"].sort());
  assert.equal(provenance.formulaNameWithIdentityHerbsPresent("涤痰汤加减", base)?.name, "自拟方");
  for (const extra of ["胆南星", "法半夏", "制天南星"]) assert.deepEqual(provenance.formulaNameIdentityHerbsMissing("涤痰汤", [...base, extra]), [], extra);
  assert.deepEqual(provenance.formulaNameIdentityHerbsMissing("天王补心丹", ["地黄", "麦冬", "天冬", "玄参", "丹参", "当归", "人参"]), []);
  assert.deepEqual(provenance.formulaNameIdentityHerbsMissing("小青龙汤", ["桂枝", "白芍", "干姜", "五味子", "甘草"]).sort(), ["半夏", "细辛", "麻黄"].sort());
  assert.deepEqual(provenance.formulaNameIdentityHerbsMissing("小青龙汤", ["麻黄", "桂枝", "白芍", "干姜", "五味子", "甘草"]), [], "对照：有麻黄就不是全缺");
  // 交付面（formulaNameWithIdentityHerbsPresent 已接在交付方名上）：方义开头随方名改成自拟方。
  const out = candidateAfter(prescribeOf({ name: "涤痰汤加减", herbs: base, formulaNames: ["涤痰汤"], source: "涤痰汤：《奇效良方》",
    analysis: "本方以涤痰汤为基础加减。瓜蒌为君，宽胸涤痰。" }));
  assert.equal(out.name, "自拟方");
  assert.match(out.formulaAnalysis, /^本方为自拟方，参照涤痰汤化裁。/u);
});

await check("4.2 名录覆盖率：化坚二陈丸名录各版本是陈皮、半夏、茯苓、甘草、僵蚕、黄连一类，TCMChat-test-482 的处方（黄连、山慈菇、白花蛇舌草…）只覆盖到三分之一；整方照抄时为 1、加味四物汤教材组成为 1、名录没有的方名为 undefined（对照）", () => {
  const h482 = ["黄连", "山慈菇", "白花蛇舌草", "半枝莲", "丹参", "川芎", "当归", "土鳖虫", "玄参", "连翘", "甘草"];
  assert.ok(provenance.formulaNameCatalogCoverage("化坚二陈丸", h482) < 0.5);
  assert.equal(provenance.formulaNameCatalogCoverage("化坚二陈丸", ["陈皮", "半夏", "茯苓", "甘草", "僵蚕", "黄连"]), 1);
  assert.equal(provenance.formulaNameCatalogCoverage("加味四物汤", ["白芍", "当归", "生地黄", "川芎", "菊花", "蔓荆子", "黄芩", "甘草"]), 1);
  assert.equal(provenance.formulaNameCatalogCoverage("某某不存在汤", h482), undefined);
});

// ───── 5 出处 ─────
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
await check("5.1 教材代表方的原书：程氏萆薢分清饮（名录《医学心悟》写川萆薢）、止痛如神汤（《外科启玄》写尖槟榔）与教材组成逐味相同，出处取原书而不是教材；胡黄连不当黄连、四七汤仍写教材（同名异方，第四轮 4.3）、银翘散照旧（对照）", () => {
  const source = (disease, syndrome, name) => {
    const row = textbook.textbookRowForSyndrome(disease, syndrome);
    const comp = (row?.compositionByFormula?.find((item) => item.formula === name)?.herbs) || row?.composition || [];
    return provenance.textbookFormulaOriginalSource(name, comp, { compositionIsUnion: (row?.formulas.length || 0) > 1 && !(row?.compositionByFormula?.length) });
  };
  assert.match(String(source("尿浊", "湿热下注证", "程氏萆薢分清饮")), /医学心悟/u);
  assert.match(String(source("内痔", "气滞血瘀证", "止痛如神汤")), /外科启玄/u);
  assert.equal(source("呕吐", "肝气犯胃证", "四七汤"), undefined);
  assert.match(String(source("风热赤眼", "风重于热证", "银翘散")), /温病条辨/u);
  // 产地字只认闭集：胡黄连、土茯苓是另一味，不与黄连、茯苓相同。
  assert.match(String(provenance.catalogSourceForExactComposition("程氏萆薢分清饮", ["萆薢", "黄柏", "车前子", "石菖蒲", "茯苓", "白术", "莲子心", "丹参"])), /医学心悟/u);
  assert.equal(provenance.catalogSourceForExactComposition("程氏萆薢分清饮", ["萆薢", "黄柏", "车前子", "石菖蒲", "土茯苓", "白术", "莲子心", "丹参"]), undefined);
  // 交付面：出处栏原是教材时换成原书（交付面已调用 textbookFormulaOriginalSource，不需另改）。
  const out = candidateAfter(prescribeOf({ name: "程氏萆薢分清饮加减", herbs: ["萆薢", "黄柏", "车前子", "茯苓", "白术", "石菖蒲", "莲子心", "丹参", "川牛膝"],
    overview: { tcmDiseaseName: "尿浊", primarySyndrome: "湿热下注证", recommendedFormulaDirection: "程氏萆薢分清饮加减" },
    source: "程氏萆薢分清饮：《中医内科学》尿浊·湿热下注证代表方", analysis: "本方以程氏萆薢分清饮为基础加减。萆薢、黄柏为君。" }));
  assert.match(out.formulaSource.source, /^程氏萆薢分清饮：《医学心悟》/u);
});

// ───── 7 煎法 ─────
const decoctionRules = await jiti.import("../src/lib/herb-decoction-rules.ts");
const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
await check("7.1 水牛角先煎 3 小时以上（《中国药典》2020「宜先煎3小时以上」，RobustSDT-single_0232 清热地黄汤写成「先煎20–30分钟」）：单味、与龙骨同组都单独写在前；龙骨、石决明照旧 20–30 分钟，组的编号不变（金礞石仍是第 1 组）（对照）；最终煎服行同样", () => {
  assert.equal(decoctionRules.specialDecoctionPhrase("水牛角"), "水牛角先煎3小时以上");
  assert.equal(decoctionRules.specialDecoctionPhrase("石决明"), "石决明先煎20–30分钟");
  assert.equal(decoctionRules.SPECIAL_DECOCTION_ORDER[decoctionRules.specialDecoctionOrderIndex("水牛角")].phrase("龙骨、水牛角、牡蛎"), "水牛角先煎3小时以上，龙骨、牡蛎先煎20–30分钟");
  assert.equal(decoctionRules.specialDecoctionOrderIndex("金礞石"), 1);
  assert.equal(decoctionRules.specialDecoctionOrderIndex("水牛角"), decoctionRules.specialDecoctionOrderIndex("龙骨"));
  const START = "<!-- DIAGNOSIS_JSON_START -->";
  const END = "<!-- DIAGNOSIS_JSON_END -->";
  const herb = (name, decoctionRequirement = null) => ({ name, dose: "15g", role: "佐", targetKind: "pathogenesis_node", targetRef: "P1", function: "清热凉血", decoctionRequirement });
  const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", therapy: { overallPrinciple: "热者寒之", overallMethod: "清热凉血", subTherapies: [] },
    formula: { candidates: [{ name: "清热地黄汤加减", herbs: [herb("水牛角", "先煎"), herb("生地黄"), herb("赤芍"), herb("牡丹皮"), herb("生石膏", "先煎")],
      decoction: { doseCount: "5剂", method: "水煎服", course: "5日", dosesPerDay: 1, administrationTimesPerDay: 2 } }], modifications: [] } };
  const content = visible.applyDeterministicDecoctionMethod(`${START}\n${JSON.stringify(reasoning)}\n${END}`, "", 45);
  const method = JSON.parse(content.slice(content.lastIndexOf(START) + START.length, content.indexOf(END)).trim()).formula.candidates[0].decoction.method;
  assert.match(method, /水牛角先煎3小时以上/u);
  assert.match(method, /生石膏先煎20–30分钟/u);
  assert.doesNotMatch(method, /水牛角[^，]*先煎20/u);
});

// ───── 9 同一身份的药味行合并 ─────
const row = (name, dose, role, targetRef = "P1", fn = "理气") => ({
  name, dose, role, function: fn, processing: null, isToxic: false, decoctionRequirement: null,
  ...(targetRef === "FORMULA_STRUCTURE"
    ? { targetKind: "formula_structure", targetRef, structureRole: "harmonize" }
    : { targetKind: "pathogenesis_node", targetRef, structureRole: null }),
});

await check("9.1 同一身份（canonicalTcmHerbIdentity 实测：醋香附→香附、生甘草→甘草、苏叶→紫苏叶）的两行并成一行：名称、位置、功效取第一行，剂量取大，角色取高（角色来自后一行时病机指向随之），有毒标记取或；生地黄/熟地黄、甘草/炙甘草、白芍/赤芍各是一味不并（对照）", () => {
  // 先把对照的前提钉住：这几组在身份函数里确实分立或确实同一。
  assert.equal(contract.canonicalTcmHerbIdentity("醋香附"), "香附");
  assert.equal(contract.canonicalTcmHerbIdentity("生甘草"), "甘草");
  assert.equal(contract.canonicalTcmHerbIdentity("苏叶"), "紫苏叶");
  assert.notEqual(contract.canonicalTcmHerbIdentity("生地黄"), contract.canonicalTcmHerbIdentity("熟地黄"));
  assert.notEqual(contract.canonicalTcmHerbIdentity("炙甘草"), contract.canonicalTcmHerbIdentity("甘草"));
  assert.notEqual(contract.canonicalTcmHerbIdentity("白芍"), contract.canonicalTcmHerbIdentity("赤芍"));
  const merged = hooks.mergeSameIdentityHerbRows([
    row("香附", "6g", "臣", "P2", "疏肝理气"), row("高良姜", "9g", "君"), row("紫苏叶", "9g", "臣"),
    { ...row("醋香附", "10g", "君", "P1", "行气止痛"), isToxic: true }, row("苏叶", "6g", "佐"),
  ]);
  assert.deepEqual(merged.map((herb) => herb.name), ["香附", "高良姜", "紫苏叶"]);
  assert.equal(merged[0].dose, "10g");
  assert.equal(merged[0].role, "君");
  assert.equal(merged[0].targetRef, "P1", "角色取自后一行时病机指向随之");
  assert.equal(merged[0].function, "疏肝理气", "功效取第一行");
  assert.equal(merged[0].isToxic, true);
  assert.equal(merged[2].dose, "9g", "后一行剂量小时取第一行的");
  assert.equal(merged[2].role, "臣");
  // 对照：分立的几味原样不动（同一个数组对象返回）。
  const distinct = [row("生地黄", "15g", "君"), row("熟地黄", "15g", "君"), row("甘草", "6g", "使", "FORMULA_STRUCTURE"), row("炙甘草", "6g", "佐"), row("白芍", "10g", "臣"), row("赤芍", "10g", "臣")];
  assert.equal(hooks.mergeSameIdentityHerbRows(distinct), distinct);
  // 剂量读不出克数时保留第一行的。
  assert.equal(hooks.mergeSameIdentityHerbRows([row("香附", "适量", "臣"), row("香附", "12g", "佐")])[0].dose, "适量");
  assert.equal(hooks.mergeSameIdentityHerbRows([row("甘草", "6g", "使", "FORMULA_STRUCTURE"), row("生甘草", "3g", "佐")]).length, 1);
});

await check("9.2 编译：合方两首都有香附、模型列了两行（RobustSDT-single_0329 香苏散合良附丸）——此前 superRefine 判 custom_candidate_herbs_N_name 整份拒，现在编出一张方、香附一行；分立两味（干姜与高良姜各一行）照旧各一行（对照）", () => {
  const prior = ReasoningV2Schema.parse({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "寒邪客胃证", overallPathogenesis: "寒邪客胃，气机阻滞", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "胃脘冷痛", syndromeEvidence: "胃脘冷痛，得温痛减", pathogenesis: "寒邪客胃，气机阻滞", therapyDirection: "温胃散寒，行气止痛" }] },
    therapy: { overallPrinciple: "实则泻之", overallMethod: "温胃散寒，行气止痛", subTherapies: [{ therapy: "温胃散寒，行气止痛", targetPathogenesis: "寒邪客胃", priority: "主要" }] },
    formula: { candidates: [], patentAndWestern: [], modifications: [] },
  });
  const proposal = (herbs) => ({
    candidate: {
      name: "本例辨证组方", applicable: "", notApplicable: "", herbs,
      formulaAnalysis: "高良姜温胃散寒为君，香附行气止痛为臣，紫苏叶、陈皮理气和胃为佐，甘草调和诸药为使。",
      decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，水煎两次，共取药液约400mL，分2次温服", followUpNode: "5日复诊" },
    },
    patentAndWestern: [], modifications: [],
    nonPharma: { diet: "宜温热清淡，可食生姜红糖水。", lifestyle: "注意胃脘保暖。", emotion: "调畅情志。", precautions: ["忌生冷。"], tcmTreatments: [] },
  });
  const herbs = [
    row("高良姜", "9g", "君", "P1", "温胃散寒"), row("香附", "6g", "臣", "P1", "行气止痛"), row("紫苏叶", "9g", "佐", "P1", "理气宽中"),
    row("陈皮", "9g", "佐", "P1", "理气和胃"), row("醋香附", "9g", "佐", "P1", "疏肝理气"), row("甘草", "6g", "使", "FORMULA_STRUCTURE", "调和诸药"),
  ];
  const compiled = compileM04Proposal(proposal(herbs), prior);
  assert.ok(compiled, "编出候选");
  const names = compiled.formula.candidates[0].herbs.map((herb) => herb.name);
  assert.deepEqual(names.filter((name) => name === "香附"), ["香附"]);
  // 剂量取两行中大的（9g；药典香附 6–10g，编译器之后照常按上限核）。
  assert.equal(compiled.formula.candidates[0].herbs.find((herb) => herb.name === "香附").dose, "9g");
  // 对照：身份不同的两味（高良姜、干姜）编出来各一行。
  const distinct = compileM04Proposal(proposal([...herbs.slice(0, 4), row("干姜", "6g", "佐", "P1", "温中散寒"), herbs[5]]), prior);
  assert.ok(distinct);
  assert.deepEqual(distinct.formula.candidates[0].herbs.map((herb) => herb.name).filter((name) => /姜/u.test(name)), ["高良姜", "干姜"]);
});

console.log(JSON.stringify({ suite: "r1019-round5-formula", cases, failures: process.exitCode ? "see above" : 0 }));
