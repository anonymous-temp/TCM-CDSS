// 10/20 第八轮 WP-C（M04 方义 / 加减 / 出处），2026-10-19 晚。X 集第七轮（r19g、r19h）与留出集 Claude/qwen 评审报出的服务端缺陷。
//
// 每条断言都带对照（不该变的输入不变）；反证记录见 ~/runlogs/r1018/work/r1019/counterproofs.txt，前缀 8/formula。
//
//   1 方义残句：删外来药只剩共有的说明（X-G-2496「镇惊收敛、五味子…」）；含错说法的一段连「并」一起删，剩「阴阳」（X-G-2843）；
//     「，：」（X-G-0382）；末句把功效清单再抄一遍（X-G-1706 / 2326 / 2810）
//   2 方义药名多「片」（黄芩片 / 酒黄连片 / 鹿茸片，X-G-0811 / 1737 / 2146 / 0679 / 0629）
//   3 功效栏占位语「…需医生结合方义复核」：用方义里讲这味药的半句，没有就留空（X-G-2326 冬瓜子）
//   4 加减条件截成「若临床」（X-G-0020）：教材泛称条件在载入时去掉，交付面兜底
//   5 出处栏写「《中医内科学》…代表方」（X-G-0679 / 0629）：只写教材书名
//   6 方义总括句里方中没有一味药支持的功效（X-G-2810 通腑泄热、X-G-2616 宁心安神、X-C-0186 平喘…）
//   7 病历已有的症状被写成「若…」（X-G-0570 / 0617 / 0307）：交付面改写成「本例已见X」；提示词要求
//   8 留出 S132 加减为空（教材只列睡眠一条，被编译器挡掉、又挡住模型自己的条件式加减）、S145 四妙散合宣痹汤缺苍术（目录只有四妙丸）

import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

Object.assign(process.env, { CDSS_SMALL_TASK_MEMO: "false" });
for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "BAILIAN_QWEN_API_KEY", "CONTROLLED_TERMINOLOGY_MODEL"]) delete process.env[key];

const jiti = createJiti(import.meta.url, {
  alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` },
});

let cases = 0;
const check = async (name, run) => {
  cases += 1;
  try {
    await run();
  } catch (error) {
    process.exitCode = 1;
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
};

const rev = await jiti.import("../src/lib/formula-analysis-review.ts");
const cc = await jiti.import("../src/lib/m04-formula-analysis-claim-check.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const tb = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const comp = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const safety = await jiti.import("../src/lib/m04-modification-safety.ts");
const hrc = await jiti.import("../src/lib/herb-record-caution.ts");

const F = JSON.parse(fs.readFileSync(new URL("./fixtures/r1020/formula-cases.json", import.meta.url), "utf8"));
const MARK_START = "<!-- DIAGNOSIS_JSON_START -->";
const MARK_END = "<!-- DIAGNOSIS_JSON_END -->";
const TABLE_RAW = JSON.parse(fs.readFileSync(new URL("../src/data/tcm-textbook-syndrome-formula-table.json", import.meta.url), "utf8"));

// ───── 1 方义残句 ─────
const SELF_DEVISED_HERBS = ["太子参", "白术", "白芍", "茯苓", "浮小麦", "五味子", "山药", "炙甘草"];
await check("1.1 X-G-2496：两味外来药共有的说明「镇惊收敛」随它们一起去掉，不粘在下一味本方药前面；带「佐以」引子的同样", () => {
  const plain = rev.reviewAuthoredFormulaAnalysis(
    "本方为自拟方，以健脾益气、扶土抑木为法。太子参、白术为君，健脾益气；白芍、茯苓为臣，柔肝宁心，浮小麦益气固表止汗；煅龙骨、煅牡蛎镇惊收敛、五味子敛阴固涩、山药补脾益肾强筋骨，为佐助君药固本；炙甘草为使调和诸药。",
    SELF_DEVISED_HERBS);
  assert.deepEqual(plain.foreignHerbs, ["煅龙骨", "煅牡蛎"]);
  assert.ok(!plain.text.includes("镇惊收敛"), plain.text);
  assert.match(plain.text, /五味子敛阴固涩、山药补脾益肾强筋骨，为佐助君药固本/);
  const lead = rev.reviewAuthoredFormulaAnalysis(
    "太子参、白术为君，健脾益气；白芍、茯苓为臣，柔肝宁心；佐以煅龙骨、煅牡蛎镇惊收敛、五味子敛阴固涩、山药补脾益肾，助君药固本；炙甘草为使调和诸药，浮小麦益气固表止汗。",
    SELF_DEVISED_HERBS);
  assert.ok(!lead.text.includes("镇惊收敛") && !lead.text.includes("佐以"), lead.text);
  assert.match(lead.text, /五味子敛阴固涩、山药补脾益肾，助君药固本/);
});
await check("1.1a 对照：外来药组是分句里最后一小段（五味子敛阴固涩、煅龙骨、煅牡蛎镇惊收敛，）：旧分支整小段去掉，不留悬空的顿号", () => {
  const out = rev.reviewAuthoredFormulaAnalysis(
    "太子参、白术为君，健脾益气；白芍、茯苓为臣，柔肝宁心；山药补脾益肾、五味子敛阴固涩、煅龙骨、煅牡蛎镇惊收敛，助君药固本；炙甘草为使调和诸药，浮小麦益气固表止汗。", SELF_DEVISED_HERBS);
  assert.ok(!out.text.includes("镇惊收敛") && !out.text.includes("煅龙骨"), out.text);
  assert.match(out.text, /山药补脾益肾、五味子敛阴固涩，助君药固本/);
});
await check("1.1b 对照：外来药与本方药共用一段说明（五味子、煅龙骨镇惊收敛）仍只去外来药名；全是本方药的并列不动；外来药带自己的说明、前一小段不是药名（旧分支）照旧", () => {
  const mixed = rev.reviewAuthoredFormulaAnalysis(
    "太子参、白术为君，健脾益气；白芍、茯苓为臣，柔肝宁心；五味子、煅龙骨镇惊收敛，山药补脾益肾，助君药固本；炙甘草为使调和诸药，浮小麦益气固表止汗。", SELF_DEVISED_HERBS);
  assert.match(mixed.text, /五味子镇惊收敛，山药补脾益肾/);
  const own = rev.reviewAuthoredFormulaAnalysis(
    "太子参、白术为君，健脾益气；白芍、茯苓为臣，柔肝宁心；五味子、山药敛阴固涩、补脾益肾，助君药固本；炙甘草为使调和诸药，浮小麦益气固表止汗。", SELF_DEVISED_HERBS);
  assert.match(own.text, /五味子、山药敛阴固涩、补脾益肾/);
  assert.deepEqual(own.foreignHerbs, []);
});

const ZUOGUI_HERBS = ["熟地黄", "山药", "山茱萸", "枸杞子", "菟丝子", "川牛膝", "鹿角胶", "龟甲胶", "甘草"];
const ZUOGUI_BASE = "本方以左归丸为基础加减，纯补无泻。熟地黄为君，滋阴填精益髓；山药、山茱萸、枸杞子为臣，补脾固肾、补益肝肾；菟丝子、川牛膝为佐，补肾益精、强健腰膝；鹿角胶、龟甲胶为佐，龟胶滋阴潜阳、鹿胶温补精血，";
await check("1.2 X-G-2843：「阴阳兼活血」里含错说法的一段连「兼」一起删后不剩没有谓语的「阴阳」；非对举名词（温阳并益阴）照旧只删「并益阴」", () => {
  const pair = rev.removeVerifiedHerbClaims(`${ZUOGUI_BASE}阴阳兼活血、宁心神，使阴得阳助而源泉不竭。甘草为使，调和诸药。`, ZUOGUI_HERBS,
    [{ herb: "鹿角胶", clause: "阴阳兼活血", claim: "活血" }], cc.herbClaimReferenceText);
  assert.equal(pair.removals.length, 1);
  assert.ok(!/阴阳(?=[、，,])/u.test(pair.text) && !pair.text.includes("阴阳"), pair.text);
  assert.match(pair.text, /鹿胶温补精血、宁心神，使阴得阳助/);
  const control = rev.removeVerifiedHerbClaims(`${ZUOGUI_BASE}温阳并益阴、宁心神，使阴得阳助而源泉不竭。甘草为使，调和诸药。`, ZUOGUI_HERBS,
    [{ herb: "鹿角胶", clause: "温阳并益阴", claim: "益阴" }], cc.herbClaimReferenceText);
  assert.match(control.text, /鹿胶温补精血，温阳、宁心神/);
});

await check("1.3 X-G-0382：逗号后紧跟冒号只留冒号，冒号后紧跟标点去冒号；正常的「X：Y」不动；交付面再投影不变", () => {
  assert.equal(rev.tidyPunctuation("本方以温脾汤加减，：附子大辛大热，温里散寒，大黄苦寒泻下攻积。"), "本方以温脾汤加减：附子大辛大热，温里散寒，大黄苦寒泻下攻积。");
  assert.equal(rev.tidyPunctuation("本方药物：附子温里，大黄泻下：，甘草调和。"), "本方药物：附子温里，大黄泻下，甘草调和。");
  assert.equal(rev.tidyPunctuation("附子大辛大热，温里散寒。"), "附子大辛大热，温里散寒。");
  const fixture = structuredClone(F.g0679.prescribe);
  fixture.formula.candidates[0].formulaAnalysis = "本方以加味逍遥散加减，：柴胡疏肝解郁，栀子、牡丹皮清热，当归、白芍养血，白术、茯苓健脾，薄荷疏散，甘草调和。";
  const once = surface.projectDeliveredReasoning(fixture);
  assert.ok(!/[，,][：:]/u.test(once.formula.candidates[0].formulaAnalysis), once.formula.candidates[0].formulaAnalysis);
  assert.deepEqual(surface.projectDeliveredReasoning(once), once);
});

await check("1.4 X-G-1706 / 2810：末句「与X之治法相合」的X全在前半句写过时去掉；点了前面没写过的功效、或不列功效的照旧", () => {
  assert.equal(rev.withoutRepeatedEffectEcho("本方以沙参麦冬汤为基础加减。诸药合用，养阴清热、润肺止咳，与养阴清热、润肺止咳之治法相合。").text,
    "本方以沙参麦冬汤为基础加减。诸药合用，养阴清热、润肺止咳。");
  assert.equal(rev.withoutRepeatedEffectEcho("全方共奏行气活血、通腑泄热之功，与行气活血、通腑泄热之法相合。").text, "全方共奏行气活血、通腑泄热之功。");
  const keep = "全方共奏养阴清热之功，与滋阴润燥、止咳之治法相合。";
  assert.equal(rev.withoutRepeatedEffectEcho(keep).text, keep);
  assert.equal(rev.withoutRepeatedEffectEcho("诸药合用，与治法相合。").changed, false);
  const review = rev.reviewAuthoredFormulaAnalysis("本方以沙参麦冬汤为基础加减，以北沙参、麦冬为君，养阴润肺；玉竹为臣，养阴润燥；天花粉为臣，清热生津；桑叶为佐，清肺润燥；白扁豆为佐，健脾和中；甘草为使，调和诸药。诸药合用，养阴清热、润肺止咳，与养阴清热、润肺止咳之治法相合。",
    ["北沙参", "麦冬", "玉竹", "天花粉", "桑叶", "白扁豆", "甘草"]);
  assert.ok(review.adjustments.includes("effect_echo_removed"));
  assert.ok(!review.text.includes("之治法相合"), review.text);
});

// ───── 2 片 ─────
await check("2.1 药味表写「黄芩」「黄连」「鹿茸」，方义写「黄芩片」「酒黄连片」「鹿茸片」→ 按药味表写；药味表自己就是「黄芩片」、方义写药名加部位（当归身）、片作别的词里的字不改", () => {
  const out = rev.withMentionsAlignedToTableNames("本方以辛夷清肺饮为基础加减。黄芩片、石膏清肺胃；酒黄连片为君，鹿茸片温补。", ["黄芩", "石膏", "黄连", "鹿茸"]);
  assert.equal(out.text, "本方以辛夷清肺饮为基础加减。黄芩、石膏清肺胃；黄连为君，鹿茸温补。");
  assert.equal(rev.withMentionsAlignedToTableNames("黄芩片清肺热。", ["黄芩片", "石膏"]).changed, false, "药味表就是黄芩片：不改");
  assert.equal(rev.withMentionsAlignedToTableNames("当归身补血，黄芩清热。", ["当归", "黄芩"]).text, "当归身补血，黄芩清热。", "当归身是部位，不改");
  assert.equal(rev.withMentionsAlignedToTableNames("黄柏片清热。", ["黄芩", "石膏"]).changed, false, "药味表里没有黄柏：不动");
});
await check("2.2 夹具 X-G-0811（r19g 方义「黄芩片、石膏…」）：投影后方义里没有「片」，药名同药味表；再投影不变", () => {
  const raw = F.g0811.prescribe.formula.candidates[0].formulaAnalysis;
  assert.match(raw, /黄芩片/);
  const projected = surface.projectDeliveredReasoning(F.g0811.prescribe);
  const analysis = projected.formula.candidates[0].formulaAnalysis;
  assert.ok(!/[黄芩连茸]片/u.test(analysis), analysis);
  assert.match(analysis, /黄芩、石膏/);
  assert.deepEqual(surface.projectDeliveredReasoning(projected), projected);
});
await check("2.3 编译时的方义审阅同样改（reviewAuthoredFormulaAnalysis），不只交付面", () => {
  const review = rev.reviewAuthoredFormulaAnalysis("本方以黄连解毒汤合三妙丸加减。黄连片、黄芩片为君，苦寒清热；黄柏、栀子为臣，泻火解毒；苍术、川牛膝为佐，燥湿；薏苡仁渗湿。",
    ["黄连", "黄芩", "黄柏", "栀子", "苍术", "川牛膝", "薏苡仁"]);
  assert.ok(review.adjustments.includes("herb_mention_aligned_to_table"));
  assert.ok(!review.text.includes("片"), review.text);
});

// ───── 3 功效栏占位语 ─────
const PLACEHOLDER = "佐药，本方中的具体配伍作用需医生结合方义复核";
await check("3.1 herbFunctionFromFormulaAnalysis：这味药在分句里单独作主语时取它的说明（去掉角色），最多两项；并列主语、分说、药名不在方义里的取不到", () => {
  const analysis = "本方以大黄牡丹汤为基础加减。大黄泻热通肠、活血散瘀，牡丹皮清热凉血，二药为君；冬瓜子为佐，清热利湿、消痈排脓，厚朴、木香为佐，行气燥湿、降逆除满；甘草为使，调和诸药。";
  assert.equal(rev.herbFunctionFromFormulaAnalysis(analysis, "冬瓜子"), "清热利湿，消痈排脓");
  assert.equal(rev.herbFunctionFromFormulaAnalysis(analysis, "大黄"), "泻热通肠，活血散瘀");
  assert.equal(rev.herbFunctionFromFormulaAnalysis(analysis, "厚朴"), "", "并列主语（厚朴、木香）不取");
  assert.equal(rev.herbFunctionFromFormulaAnalysis(analysis, "桃仁"), "", "方义没点到");
  assert.equal(rev.herbFunctionFromFormulaAnalysis("牡丹皮、桃仁为臣，一清血分郁热，一助活血祛瘀。", "桃仁"), "");
});
const placeholderCase = (herbName, role, analysis) => {
  const payload = structuredClone(F.g0679.prescribe);
  const candidate = payload.formula.candidates[0];
  candidate.herbs[candidate.herbs.length - 2] = { ...candidate.herbs[candidate.herbs.length - 2], name: herbName, role, function: PLACEHOLDER };
  candidate.formulaAnalysis = analysis;
  return surface.projectDeliveredReasoning(payload).formula.candidates[0].herbs[candidate.herbs.length - 2].function;
};
await check("3.2 交付面：知识库、核对词典都没有功效的药（冬瓜子）占位句换成方义里的半句；方义也没有时留空；任何情况下不印「需医生结合方义复核」", () => {
  const withClause = placeholderCase("冬瓜子", "佐", "本方以加味逍遥散为基础加减。柴胡为君，疏肝解郁；冬瓜子为佐，清热利湿、消痈排脓，栀子、牡丹皮为臣，清热凉血；当归、白芍养血柔肝；白术、茯苓健脾；薄荷疏散郁热；甘草为使，调和诸药。");
  assert.equal(withClause, "清热利湿，消痈排脓");
  const without = placeholderCase("冬瓜子", "佐", "本方以加味逍遥散为基础加减。柴胡为君，疏肝解郁；栀子、牡丹皮为臣，清热凉血；当归、白芍养血柔肝；白术、茯苓健脾；薄荷疏散郁热；甘草为使，调和诸药。");
  assert.equal(without, "");
  for (const value of [withClause, without]) assert.ok(!/复核/u.test(value));
});
await check("3.2b 对照：知识库有功效的药（薄荷）占位句仍换成知识库功效，不取方义的话；已有真功效的不动；再投影不变", () => {
  const kb = placeholderCase("薄荷", "佐", "本方以加味逍遥散为基础加减。柴胡为君，疏肝解郁；薄荷为佐，疏肝透邪如神、百病皆除，栀子、牡丹皮为臣，清热凉血；当归、白芍养血柔肝；白术、茯苓健脾；甘草为使，调和诸药。");
  assert.ok(kb.length > 0 && !/如神|百病/u.test(kb), kb);
  const payload = structuredClone(F.g0679.prescribe);
  const before = payload.formula.candidates[0].herbs.map((herb) => herb.function);
  const projected = surface.projectDeliveredReasoning(payload);
  assert.equal(projected.formula.candidates[0].herbs.length, before.length);
  assert.deepEqual(surface.projectDeliveredReasoning(projected), projected);
});
await check("3.3 不给剂量页同样（nonDosePage 投影）：冬瓜子功效栏留空而不是占位句", () => {
  const payload = structuredClone(F.g0679.prescribe);
  const candidate = payload.formula.candidates[0];
  candidate.herbs[2] = { ...candidate.herbs[2], name: "冬瓜子", role: "佐", function: PLACEHOLDER };
  const projected = surface.projectDeliveredReasoning(payload, { nonDosePage: true });
  assert.ok(!JSON.stringify(projected.formula).includes("需医生结合方义复核"));
});

// ───── 4 加减条件「若临床」 ─────
await check("4.1 痢疾·休息痢：教材「临床可加槟榔、木香、枳实」不是一种变化，载入时去掉：行没有教材加减、提示词不列「若临床」、textbookModificationMatch 不认；模型的条件式加减路径打开", () => {
  const row = tb.textbookRowForSyndrome("痢疾", "休息痢");
  assert.ok(row);
  assert.deepEqual(row.modifications, []);
  assert.ok(!tb.buildTextbookFormulaContext("痢疾", "休息痢").includes("若临床"));
  assert.equal(tb.textbookModificationMatch("痢疾", "休息痢", "若临床"), undefined);
  assert.equal(tb.conditionalModificationWithoutTextbook("痢疾", "休息痢", "若脓血便较多", ["人参", "白术"]), true);
  assert.equal(tb.conditionalModificationWithoutTextbook("痢疾", "休息痢", "若临床", ["人参", "白术"]), true, "条件式路径本身不管这一条（泛称由下面的交付面兜底）");
});
await check("4.1b 全表扫描：原表里条件是泛称的 34 条，载入后一条不剩；其余行的教材加减条数不变（对照：感冒·风寒束表证 6 条）", () => {
  const generic = [];
  for (const raw of TABLE_RAW.rows) {
    for (const item of raw.modifications || []) {
      if (tb.TEXTBOOK_GENERIC_CONDITION.test(String(item.condition || "").replace(/^(?:若|如果|如)/u, "").trim())) generic.push({ disease: raw.disease, syndrome: raw.syndromeName || raw.syndrome });
    }
  }
  assert.equal(generic.length, 34);
  for (const item of generic) {
    const row = tb.textbookRowForSyndrome(item.disease, item.syndrome);
    if (!row) continue;
    assert.ok(row.modifications.every((mod) => !tb.TEXTBOOK_GENERIC_CONDITION.test(mod.condition.replace(/^(?:若|如果|如)/u, "").trim())), `${item.disease}·${item.syndrome}`);
  }
  assert.equal(tb.textbookRowForSyndrome("感冒", "风寒束表证").modifications.length, 6);
});
await check("4.2 交付面兜底：已缓存或模型写出的「若临床」加减不留（夹具 X-G-0020 的 3 条）；有具体症状的条件（若脓血便）照留", () => {
  const raw = F.g0020.prescribe;
  assert.deepEqual(raw.formula.modifications.map((m) => m.trigger), ["若临床", "若临床", "若临床"]);
  const projected = surface.projectDeliveredReasoning(raw);
  assert.deepEqual(projected.formula.modifications, []);
  const mixed = structuredClone(raw);
  mixed.formula.modifications[1] = { ...mixed.formula.modifications[1], trigger: "若脓血便较多" };
  const out = surface.projectDeliveredReasoning(mixed);
  assert.deepEqual(out.formula.modifications.map((m) => m.trigger), ["若脓血便较多"]);
});

// ───── 5 出处栏 ─────
await check("5.1 教材代表方、目录没有逐味相同的原书时，出处只写教材书名：夹具 X-G-0679「加味逍遥散：《中医内科学》内伤发热·气郁发热证代表方」→「加味逍遥散：《中医内科学》」；再投影不变", () => {
  assert.match(F.g0679.prescribe.formula.candidates[0].formulaSource.source, /代表方/);
  const projected = surface.projectDeliveredReasoning(F.g0679.prescribe);
  assert.equal(projected.formula.candidates[0].formulaSource.source, "加味逍遥散：《中医内科学》");
  assert.deepEqual(surface.projectDeliveredReasoning(projected).formula.candidates[0].formulaSource, projected.formula.candidates[0].formulaSource);
});
await check("5.2 对照：目录有原书的方（辛夷清肺饮《外科正宗》卷四）出处不动；组成不过半（不按这首方写出处）时旧写法也不碰", () => {
  assert.equal(surface.projectDeliveredReasoning(F.g0811.prescribe).formula.candidates[0].formulaSource.source, "辛夷清肺饮：《外科正宗》卷四");
  const other = structuredClone(F.g0679.prescribe);
  other.formula.candidates[0].herbs = other.formula.candidates[0].herbs.filter((herb) => ["甘草", "薄荷"].includes(herb.name));
  other.formula.candidates[0].herbs.push({ ...F.g0679.prescribe.formula.candidates[0].herbs[0], name: "川芎", role: "臣" });
  const out = surface.projectDeliveredReasoning(other).formula.candidates[0].formulaSource.source;
  assert.match(out, /代表方/, "组成不过半：不按这首方改出处");
});

// ───── 6 总括句里方中没有药支持的功效 ─────
const referenceFor = cc.herbOwnFunctionReferenceText;
const PU_JI = ["黄芩", "黄连", "连翘", "板蓝根", "玄参", "牛蒡子", "桔梗", "马勃", "薄荷", "柴胡", "升麻", "陈皮", "甘草"];
await check("6.1 X-G-2810：方中无大黄芒硝，「共奏清热解毒、利咽消肿、通腑泄热之效」去掉通腑泄热，其余项原样；X-G-2616「全方以疏肝解郁、宁心安神为主」去宁心安神", () => {
  const out = rev.withoutUnsupportedSummaryEffects("本方以普济消毒饮为基础加减。黄芩、黄连为君，苦寒直折上焦热毒；连翘、板蓝根为臣，清热解毒。全方清上彻下，共奏清热解毒、利咽消肿、通腑泄热之效。", PU_JI, referenceFor);
  assert.deepEqual(out.removed, ["通腑泄热"]);
  assert.match(out.text, /共奏清热解毒、利咽消肿之效。$/);
  const mu = rev.withoutUnsupportedSummaryEffects("本方以木香顺气散为基础加减。全方以疏肝解郁、宁心安神为主，兼调畅气机、理气和血，与治法相合。",
    ["木香", "香附", "枳壳", "青皮", "陈皮", "厚朴", "苍术", "砂仁", "槟榔", "炙甘草"], referenceFor);
  assert.deepEqual(mu.removed, ["宁心安神"]);
  assert.match(mu.text, /全方以疏肝解郁为主，兼调畅气机/);
});
await check("6.1b 对照：方中有大黄（通腑）时通腑泄热保留；方中有酸枣仁时宁心安神保留；一项不剩时整个总括分句去掉；句首没有逗号时不动", () => {
  const withRhubarb = rev.withoutUnsupportedSummaryEffects("全方共奏清热解毒、通腑泄热之效。", [...PU_JI, "大黄"], referenceFor);
  assert.deepEqual(withRhubarb.removed, []);
  const sleep = rev.withoutUnsupportedSummaryEffects("全方以疏肝解郁、宁心安神为主。", ["柴胡", "香附", "白芍", "酸枣仁", "合欢皮", "陈皮", "炙甘草"], referenceFor);
  assert.deepEqual(sleep.removed, []);
  const none = rev.withoutUnsupportedSummaryEffects("本方以普济消毒饮为基础加减。黄芩、黄连为君；全方清上彻下，共奏通腑泄热之效。", PU_JI, referenceFor);
  assert.deepEqual(none.removed, ["通腑泄热"]);
  assert.equal(none.text, "本方以普济消毒饮为基础加减。黄芩、黄连为君；全方清上彻下。");
  const lead = rev.withoutUnsupportedSummaryEffects("共奏通腑泄热之效。", PU_JI, referenceFor);
  assert.deepEqual(lead.removed, [], "句首没有逗号：整句没了，不动");
  assert.equal(lead.text, "共奏通腑泄热之效。");
});
await check("6.1c 句末的「，兼X以Y。」同样判（X-G-1206 枇杷清肺饮「兼清热生津以润肠通便」方中无润肠药）；X-G-2964 银翘散「共奏疏风清热、息风镇惊、宣肺止咳之效」去息风镇惊；对照：方中有火麻仁时不删", () => {
  const pi = ["枇杷叶", "桑白皮", "黄连", "黄柏", "人参", "甘草"];
  const text = "全方共奏疏风清肺、解毒消疹之功，兼清热生津以润肠通便。";
  const out = rev.withoutUnsupportedSummaryEffects(text, pi, referenceFor);
  assert.deepEqual(out.removed, ["润肠通便"]);
  assert.equal(out.text, "全方共奏疏风清肺、解毒消疹之功，兼清热生津。");
  assert.deepEqual(rev.withoutUnsupportedSummaryEffects(text, [...pi, "火麻仁"], referenceFor).removed, []);
  const yin = rev.withoutUnsupportedSummaryEffects("全方轻清上行，共奏疏风清热、息风镇惊、宣肺止咳之效。", ["金银花", "连翘", "薄荷", "荆芥", "牛蒡子", "桔梗", "淡豆豉", "淡竹叶", "甘草"], referenceFor);
  assert.deepEqual(yin.removed, ["息风镇惊"]);
  assert.equal(yin.text, "全方轻清上行，共奏疏风清热、宣肺止咳之效。");
  assert.deepEqual(rev.withoutUnsupportedSummaryEffects("全方轻清上行，共奏疏风清热、息风镇惊、宣肺止咳之效。", ["金银花", "连翘", "薄荷", "钩藤", "牛蒡子", "桔梗", "淡竹叶", "甘草"], referenceFor).removed, [], "方中有钩藤（息风）：不删");
});
await check("6.2 概念组限定：清热利湿止带（止带不是收涩）、乌头汤式「祛风除湿」、补气补血这类宽泛说法不判（即使方中没有对应药）", () => {
  const dai = rev.withoutUnsupportedSummaryEffects("全方共奏清热解毒、利湿止带之效。", ["金银花", "蒲公英", "野菊花", "紫花地丁", "黄柏", "牡丹皮", "生地黄", "车前子", "甘草"], referenceFor);
  assert.deepEqual(dai.removed, []);
  const wu = rev.withoutUnsupportedSummaryEffects("全方共奏温经散寒、祛风除湿、活血消肿之效。", ["麻黄", "桂枝", "黄芪", "白芍", "当归", "川芎", "炙甘草"], referenceFor);
  assert.deepEqual(wu.removed, []);
  const tonic = rev.withoutUnsupportedSummaryEffects("全方共奏补气养血、健脾益肾之效。", ["黄连", "黄芩", "黄柏", "栀子", "甘草"], referenceFor);
  assert.deepEqual(tonic.removed, []);
});
await check("6.3 接线：checkFormulaAnalysisClaimsInContent 对已编译内容里的方义去掉无支持的总括功效（不依赖小模型，未配置模型时也起作用）；没有可删时逐字节原样", async () => {
  const build = (analysis, herbs) => `前言\n${MARK_START}\n${JSON.stringify({ stage: "prescribe", formula: { candidates: [{ name: "普济消毒饮加减", formulaAnalysis: analysis, herbs: herbs.map((name) => ({ name })) }] } }, null, 2)}\n${MARK_END}\n尾`;
  const analysis = "本方以普济消毒饮为基础加减。黄芩、黄连为君，苦寒直折上焦热毒；连翘、板蓝根为臣，清热解毒。全方清上彻下，共奏清热解毒、利咽消肿、通腑泄热之效。";
  const out = await cc.checkFormulaAnalysisClaimsInContent(build(analysis, PU_JI));
  const parsed = JSON.parse(out.slice(out.indexOf(MARK_START) + MARK_START.length, out.indexOf(MARK_END)).trim());
  assert.ok(!parsed.formula.candidates[0].formulaAnalysis.includes("通腑泄热"));
  assert.match(parsed.formula.candidates[0].formulaAnalysis, /共奏清热解毒、利咽消肿之效/);
  const clean = build("本方以普济消毒饮为基础加减。黄芩、黄连为君；连翘、板蓝根为臣，共奏清热解毒、利咽消肿之效。", PU_JI);
  assert.equal(await cc.checkFormulaAnalysisClaimsInContent(clean), clean);
});

// ───── 7 病历已有的症状被写成「若…」 ─────
const RECORD7 = "患者3年来双小腿伸侧皮疹反复发作。夜间常因瘙痒抓挠而醒。无渗液，无发热。突发抽搐，大便秘结，患处肿势明显。";
await check("7.1 modificationConditionAlreadyPresent：现症改写成「本例已见X」（否定的、带程度而病历只写了症状的、病机说法不改）", () => {
  const present = (trigger) => comp.modificationConditionAlreadyPresent(trigger, RECORD7)?.trigger;
  assert.equal(present("若抽搐"), "本例已见抽搐");
  assert.equal(present("若大便秘结"), "本例已见大便秘结");
  assert.equal(present("若抽搐、大便秘结"), "本例已见抽搐、大便秘结");
  assert.equal(present("若肿势明显"), "本例已见肿势明显", "病历逐字写着带程度的说法");
  assert.equal(present("若伴抽搐"), "本例已见抽搐");
  assert.equal(present("若夜间瘙痒甚"), undefined, "带程度词、病历只写了症状本身：是「加重」，仍是条件");
  assert.equal(present("若渗液"), undefined, "病历否认");
  assert.equal(present("若发热"), undefined, "病历否认");
  assert.equal(present("若肾阴亏虚"), undefined, "病机说法病历不会逐字写到");
  assert.equal(present("若抽搐、渗液"), undefined, "一项不是现症，整条仍是条件");
  assert.equal(present("若便闭"), undefined, "病历没写便闭（同义写法不另立词表）");
  assert.equal(comp.modificationConditionAlreadyPresent("若抽搐", "")?.trigger, undefined);
  assert.equal(comp.modificationConditionAlreadyPresent("若胃脘胀痛而便闭", "前日因食过饱后胃脘胀痛，现胃脘痛而便闭。")?.trigger, "本例已见胃脘胀痛、便闭", "「而」连着两个现症");
  assert.equal(comp.modificationConditionAlreadyPresent("若胃脘胀痛而便闭", "前日因食过饱后胃脘胀痛，现无便闭。")?.trigger, undefined, "其中一个现症病历否认：整条仍是条件");
});
await check("7.2 交付面：夹具 X-G-0617「若胃脘胀痛而便闭：加大黄」，病历原文给出时改写成「本例已见…」且依据换成病历原句；条件仍是「若」的（若呃逆较甚）不动；再投影不变", () => {
  const payload = structuredClone(F.g0617.prescribe);
  payload.formula.modifications[1].trigger = "若胃脘痛而便闭";
  payload.formula.modifications[1].evidence = { evidenceLevel: "model_inference", source: comp.MODEL_CONDITIONAL_MODIFICATION_EVIDENCE_SOURCE, confidence: "中" };
  const projected = surface.projectDeliveredReasoning(payload, { recordText: F.g0617.input.symptoms["现病史"] });
  assert.deepEqual(projected.formula.modifications.map((m) => m.trigger), ["若脘腹胀甚", "本例已见胃脘痛、便闭", "若呃逆较甚"]);
  assert.match(projected.formula.modifications[1].evidence.source, /^患者原文：/);
  assert.match(projected.formula.modifications[1].evidence.source, /便闭/);
  assert.deepEqual(surface.projectDeliveredReasoning(projected, { recordText: F.g0617.input.symptoms["现病史"] }), projected);
  const noRecord = surface.projectDeliveredReasoning(payload);
  assert.equal(noRecord.formula.modifications[1].trigger, "若胃脘痛而便闭", "没有病历原文、辨证阶段的引文也没写到时不改");
});
await check("7.2b 对照：教材条件（带程度的「若恶寒甚」）而病历只写恶寒时不改；教材加减的依据（《…》）不被换成患者原文", () => {
  const payload = structuredClone(F.g0679.prescribe);
  payload.formula.modifications[0].trigger = "若热象较甚";
  const projected = surface.projectDeliveredReasoning(payload, { recordText: "低热，热势常随情绪波动而起伏，精神抑郁。" });
  assert.equal(projected.formula.modifications[0].trigger, "若热象较甚");
  const textbook = structuredClone(F.g0679.prescribe);
  textbook.formula.modifications[0].trigger = "若精神抑郁";
  textbook.formula.modifications[0].evidence = { evidenceLevel: "model_inference", source: "《中医内科学》内伤发热·气郁发热加减：若精神抑郁者加香附", confidence: "中" };
  const out = surface.projectDeliveredReasoning(textbook, { recordText: "低热，热势常随情绪波动而起伏，精神抑郁。" });
  assert.equal(out.formula.modifications[0].trigger, "本例已见精神抑郁");
  assert.match(out.formula.modifications[0].evidence.source, /^《中医内科学》/);
});
await check("7.3 M04 提示词：病历已记录的症状不写成「若……」，要么并入主方、要么 trigger 逐字写已记录表现（不带若）；教材条件只写尚未出现的变化", () => {
  const source = fs.readFileSync(new URL("../src/lib/diagnosis-prompts.ts", import.meta.url), "utf8");
  const start = source.indexOf("- modifications 是给接诊医生的");
  const end = source.indexOf("- 判断合格兼症的方法", start);
  assert.ok(start > 0 && end > start);
  const bullet = source.slice(start, end);
  assert.match(bullet, /病历已经记录的症状不写成“若……”/);
  assert.match(bullet, /直接放进主方 candidate\.herbs/);
  assert.match(bullet, /trigger 逐字写病历已记录的表现、不带“若”/);
  assert.match(bullet, /本例眼下还没有出现、之后可能出现的变化/);
  assert.ok(!bullet.includes("本例可能出现或已经出现的变化"));
});

// ───── 8 留出 S132 / S145 ─────
await check("8.1 S132 湿疮·血虚风燥证：教材唯一的加减是「瘙痒不能入眠：珍珠母、夜交藤、酸枣仁」，被「睡眠差随主病而来」规则不列；提示词不再列它、模型自己的条件式加减（若皮损渗液）可以写", () => {
  const row = tb.textbookRowForSyndrome("湿疮", "血虚风燥证");
  assert.equal(row.modifications.length, 1);
  assert.deepEqual(tb.usableTextbookModifications(row), []);
  assert.ok(!tb.buildTextbookFormulaContext("湿疮", "血虚风燥证").includes("【教材加减】"));
  assert.equal(tb.conditionalModificationWithoutTextbook("湿疮", "血虚风燥证", "若皮损渗液", ["当归", "生地黄"]), true);
});
await check("8.1b 对照：条目里有不是安神药的（血证·肾虚火旺证心烦失眠加黄连）、证名病名涉心神（不寐·心脾两虚证）、有别的条目（积滞·食积化热）的行，教材加减原样可用；模型条件式路径对「教材有可用加减」仍关闭", () => {
  for (const [disease, syndrome, expected] of [["血证", "肾虚火旺证", 1], ["不寐", "心脾两虚证", 4], ["积滞", "食积化热证", 8], ["感冒", "风寒束表证", 6]]) {
    const row = tb.textbookRowForSyndrome(disease, syndrome);
    assert.equal(tb.usableTextbookModifications(row).length, expected, `${disease}·${syndrome}`);
  }
  assert.equal(tb.conditionalModificationWithoutTextbook("感冒", "风寒束表证", "若咳嗽痰黄", ["荆芥", "防风"]), false);
  assert.ok(tb.buildTextbookFormulaContext("感冒", "风寒束表证").includes("若恶寒甚，加麻黄、桂枝"));
});

await check("8.2 S145 痛风·湿热阻痹「四妙散合宣痹汤」：目录没有四妙散（只有同组成的四妙丸），textbookBaseIngredients 按剂型互换取目录组成补进来（含苍术）；已有分方组成与目录有名的方不受影响", () => {
  const row = tb.textbookRowForSyndrome("痛风", "湿热阻痹");
  const base = hrc.textbookBaseIngredients(row, ["四妙散"]);
  for (const herb of ["苍术", "黄柏", "牛膝", "薏苡仁", "防己"]) assert.ok(base.includes(herb), `${herb} in ${base.join("、")}`);
  const sense = tb.textbookRowForSyndrome("感冒", "风寒束表证");
  assert.deepEqual(hrc.textbookBaseIngredients(sense, ["荆防败毒散"]), [...sense.composition]);
});
await check("8.3 S145：教材代表方四妙散的药（苍术）不被当作方向对立的加味剔除；真正的方外对立药（附子）照剔；合同的豁免与剔除同一口径", () => {
  const prior = { ...structuredClone(F.s145.prescribe), stage: "diagnose" };
  const herb = (name, role, fn) => ({ name, role, function: fn, prescriptionRole: `${role}药：清热除湿`, targetKind: "pathogenesis_node", targetRef: "P1", targetPathogenesis: "湿热下注，痹阻足部经络" });
  const candidate = structuredClone(F.s145.prescribe.formula.candidates[0]);
  candidate.herbs = [herb("黄柏", "君", "清热燥湿，泻火解毒"), herb("苍术", "臣", "燥湿健脾，祛风散寒")];
  candidate.herbs.push(herb("薏苡仁", "臣", "利水渗湿，健脾，除痹"), herb("牛膝", "臣", "逐瘀通经，补肝肾，强筋骨"), herb("滑石", "臣", "利尿通淋，清热解暑"), herb("栀子", "佐", "泻火除烦，清热利湿"), herb("甘草", "使", "调和诸药"));
  const content = (herbs) => `${MARK_START}\n${JSON.stringify({ ...F.s145.prescribe, formula: { ...F.s145.prescribe.formula, candidates: [{ ...candidate, herbs }] } })}\n${MARK_END}`;
  const names = (text) => JSON.parse(text.slice(text.indexOf(MARK_START) + MARK_START.length, text.indexOf(MARK_END)).trim()).formula.candidates[0].herbs.map((h) => h.name);
  const kept = safety.dropUnsupportedM04CandidateHerbs(content(candidate.herbs), prior);
  assert.ok(names(kept).includes("苍术"), names(kept).join("、"));
  const withAconite = [...candidate.herbs, herb("附子", "佐", "回阳救逆，补火助阳，散寒止痛")];
  const pruned = safety.dropUnsupportedM04CandidateHerbs(content(withAconite), prior);
  assert.ok(!names(pruned).includes("附子") && names(pruned).includes("苍术"), names(pruned).join("、"));
  assert.equal(contract.m04HerbOpposingDirectionIssue(herb("苍术", "臣", "燥湿健脾，祛风散寒"), prior, true, []), undefined);
});
await check("8.4 S145：开方阶段方名只写了「宣痹汤加减」、辨证阶段推荐方向是「四妙散合宣痹汤加减」且两张方处方组成都过半时，方名用辨证阶段的；出处两张都列；方义开头同步", () => {
  const projected = surface.projectDeliveredReasoning(F.s145.prescribe);
  const candidate = projected.formula.candidates[0];
  assert.equal(candidate.name, "四妙散合宣痹汤加减");
  assert.equal(candidate.formulaSource.source, "四妙散：《中医外科学》；宣痹汤：《温病条辨》");
  assert.match(candidate.formulaAnalysis, /^本方以四妙散合宣痹汤为基础加减/);
  assert.deepEqual(surface.projectDeliveredReasoning(projected), projected);
});
await check("8.4b 对照：只有宣痹汤的药在处方里（四妙散的药一味不剩）时方名不动；M03 推荐方向只写宣痹汤时不动", () => {
  const onlyOne = structuredClone(F.s145.prescribe);
  onlyOne.formula.candidates[0].herbs = onlyOne.formula.candidates[0].herbs.filter((herb) => !["黄柏", "薏苡仁", "牛膝"].includes(herb.name));
  assert.equal(surface.projectDeliveredReasoning(onlyOne).formula.candidates[0].name, "宣痹汤加减");
  const single = structuredClone(F.s145.prescribe);
  single.overview.recommendedFormulaDirection = "宣痹汤加减";
  assert.equal(surface.projectDeliveredReasoning(single).formula.candidates[0].name, "宣痹汤加减");
});

console.log(JSON.stringify({ suite: "r1020-formula", cases, failures: process.exitCode ? "see above" : 0 }));
