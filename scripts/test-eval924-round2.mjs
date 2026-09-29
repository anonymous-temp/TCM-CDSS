// 甲方 9.24 + 9.27 测评整改·第二轮（2026-09-29）：owner 指示——没有中医师/药师可签字，所有「待终审」「占位」
// 全部用联网/教材核对过的数据替换；能让模型写的不用门禁挡；HIS 30 秒等待内出结果。
//
//   1 方义栏占位句：核对词典 + 模型宽松档，不再显示「需医生结合方义复核」
//   2 M04 修复轮起点截止：过了截止点不再开新一轮修复（HIS 30 秒等待）
//   3 已核对为无依据的功用条目被剔除（炙甘草不带生甘草的清热解毒）
//   4 待终审台账：教材方案/居家穴位/流派归属改为联网核对后 approved；核对不过的仍 pending
//
// 每条断言都带反证。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

const failures = [];
let checks = 0;
const check = async (name, fn) => {
  checks += 1;
  try { await fn(); } catch (error) { failures.push({ name, message: String(error?.message || error).slice(0, 700) }); }
};

const contract = jiti("../src/lib/diagnosis-stage-contract.ts");
const api = jiti("../src/lib/diagnosis-api.ts");
const knowledge = jiti("../src/lib/tcm-knowledge.ts");
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

await check("1.1 宽松档：使药泽泻写「引药下行，导浊阴下泄」严格档判无依据、宽松档受理（生产 0070 的占位句来源）", () => {
  const text = "引药下行，导浊阴下泄";
  assert.equal(contract.herbFunctionMatchesKnowledge("泽泻", text, "使", ""), false, "严格档仍要触发修复轮");
  assert.equal(contract.herbFunctionMatchesKnowledge("泽泻", text, "使", "", true), true, "宽松档受理模型的方义");
});

await check("1.2 反证：宽松档不放宽安全判据——疗效吹嘘词、未佐证的高影响方向、毒性药不提毒性都仍被拒", () => {
  assert.equal(contract.herbFunctionMatchesKnowledge("泽泻", "延年益寿，引药下行", "使", "", true), false, "吹嘘词");
  assert.equal(contract.herbFunctionMatchesKnowledge("泽泻", "活血化瘀，通络止痛", "佐", "", true), false, "泽泻库内无活血方向");
  assert.equal(contract.herbFunctionMatchesKnowledge("附子", "补火助阳，散寒止痛", "臣", "", true), false, "有毒药必须提毒性/慎用");
  assert.equal(contract.herbFunctionMatchesKnowledge("附子", "补火助阳，散寒止痛，有毒需先煎", "臣", "", true), true, "对照：提了毒性则通过");
});

await check("1.3 HIS 写回走宽松档：合同 trustedWorkbenchEdit 分支把第五参数传成 lenient（与 finalize 同口径，否则 HIS 导出会驳回 finalize 受理的方义）", () => {
  const stage = source("src/lib/diagnosis-stage-contract.ts");
  assert.match(stage, /herbFunctionMatchesKnowledge\(herb\.name\.trim\(\), herb\.function\.trim\(\), String\(herb\.role \|\| ""\), String\(herb\.targetPathogenesis \|\| ""\), trustedWorkbenchEdit\)/);
  const summary = source("src/lib/diagnosis-visible-summary.ts");
  assert.match(summary, /opts\?\.fillRolePlaceholder && modelFunction && herbFunctionMatchesKnowledge\([\s\S]{0,160}true,\s*\)\) continue;/, "finalize 先保留合格的模型方义");
});

await check("2.1 M04 修复轮起点截止：默认 20 秒；20 秒前不触发、20 秒起触发", () => {
  assert.equal(api.M04_REPAIR_START_CUTOFF_MS, 20_000);
  assert.equal(api.m04RepairStartCutoffReached(1_000, 1_000 + 19_999), false);
  assert.equal(api.m04RepairStartCutoffReached(1_000, 1_000 + 20_000), true);
});

await check("2.2 截止点接在两处修复轮入口，且首轮失败后的严格兜底/同模型重抽不受限（拿不到任何输出时的唯一出路）", () => {
  const text = source("src/lib/diagnosis-api.ts");
  assert.match(text, /!m04OrchestrationDeadlineGate\(\) &&\s*!m04RepairStartCutoffGate\(\)/, "整份重试入口");
  assert.match(text, /targetedM04Retry && \(m04OrchestrationDeadlineGate\(\) \|\| m04RepairStartCutoffGate\(\)\)/, "定向修复入口");
  const fallbackStart = text.indexOf("const sameModelRedraw = ");
  const fallbackEnd = text.indexOf("structured_strict_fallback", fallbackStart);
  assert.ok(fallbackStart > 0 && fallbackEnd > fallbackStart);
  assert.doesNotMatch(text.slice(fallbackStart, fallbackEnd), /m04RepairStartCutoffGate/, "严格兜底段不得被截止点拦住");
});

// ── 3 核对词典 ────────────────────────────────────────────────────────────────
await check("3.1 炙甘草：药典只给「补脾和胃、益气复脉」，生甘草的清热解毒/祛痰止咳被剔除；使药功用栏取「益气和中，调和诸药」", () => {
  const text = knowledge.getTcmHerbFunctionText("炙甘草");
  assert.doesNotMatch(text, /清热解毒|祛痰止咳/, "属生甘草的功效不能挂在炙甘草名下");
  // 核对功用只进方义栏的展示与选词，不进功用文本本身（否则会连带改变君药准入的高影响方向判据）
  assert.ok(knowledge.verifiedHerbFunctionEntry("炙甘草").functions.includes("补脾和胃"));
  assert.ok(knowledge.verifiedHerbFunctionEntry("炙甘草").functions.includes("益气复脉"));
  assert.equal(knowledge.getTcmHerbFunctionDisplayText("炙甘草", "使", "", ""), "益气和中，调和诸药");
  // 反证：生甘草仍带清热解毒（词典按名字区分炮制品，没有把剔除扩散到生品）
  assert.match(knowledge.getTcmHerbFunctionText("甘草"), /清热解毒/);
});

await check("3.2 不再出占位句：库里有功效但对不上本方治法的药味，取核对词典给的入方作用；真正未收录的药才保留占位", () => {
  const placeholder = /需医生结合方义复核/;
  for (const [herb, role] of [["泽泻", "使"], ["牡丹皮", "佐"], ["荆芥", "臣"], ["苦杏仁", "佐"], ["白芍", "佐"], ["厚朴", "臣"]]) {
    const text = knowledge.getTcmHerbFunctionDisplayText(herb, role, "", "完全无关的治法词", true);
    assert.doesNotMatch(text, placeholder, `${herb}（${role}）`);
    assert.ok(text.length >= 2, `${herb} 功用栏为空`);
  }
  // 反证：一个知识库根本没有的药味仍走占位句（不编造）
  assert.match(knowledge.getTcmHerbFunctionDisplayText("并无此药", "臣", "", "", true), placeholder);
});

await check("3.3 词典只追加/剔除：剔除项不含分类标签与给药途径文字，毒性风险画像不受影响", () => {
  // 毒性/给药途径的安全语义走风险画像与煎法规则，不在功用文本里；词典不得改动它们。
  assert.match(knowledge.getTcmHerbRiskProfile("朱砂"), /TOXIC_REGULATORY/);
  assert.match(knowledge.getTcmHerbRiskProfile("附子"), /TOXIC_REGULATORY/);
  assert.match(knowledge.getTcmHerbFunctionText("朱砂"), /安神/, "追加后的功用文本仍含原有正文");
  const dictionary = JSON.parse(readFileSync(new URL("../src/data/tcm-herb-verified-functions.json", import.meta.url), "utf8")).herbs;
  const categoryLabels = new Set(Object.values(JSON.parse(readFileSync(new URL("../src/data/tcm-herb-function-categories.json", import.meta.url), "utf8")).categories).flat());
  for (const [name, entry] of Object.entries(dictionary)) {
    for (const clause of entry.unsupported) {
      assert.doesNotMatch(clause, /先煎|后下|包煎|另煎|冲服|研末|不入汤剂/, `${name} 的剔除项「${clause}」不得是给药途径文字`);
      assert.ok(!categoryLabels.has(clause), `${name} 的剔除项「${clause}」是章节分类标签（分类标签不在此处理）`);
    }
    assert.ok(entry.evidence.length > 0, `${name} 没有引文`);
  }
  assert.ok(Object.keys(dictionary).length >= 250, "词典规模");
});

// ── 4 目录出处与组成订正（联网原文核对） ─────────────────────────────────────────
const catalog = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-governed-catalog.json", import.meta.url), "utf8")).entries;
const entry = (name, source) => catalog.find((item) => item.name === name && (!source || item.source.includes(source)));
await check("4.1 用户点名的四首：六君子汤出《医学正传》；柴胡加龙骨牡蛎汤出《伤寒论》且补桂枝/牡蛎/黄芩；右归饮不再是左归饮的六味；防风通圣散补大黄/芒硝、去党参/黄芪", () => {
  assert.match(entry("六君子汤").source, /医学正传/);
  const chaihu = entry("柴胡加龙骨牡蛎汤");
  assert.match(chaihu.source, /伤寒论/);
  for (const herb of ["桂枝", "牡蛎", "黄芩"]) assert.ok(chaihu.ingredients.includes(herb), `柴胡加龙骨牡蛎汤缺 ${herb}`);
  assert.ok(!chaihu.ingredients.includes("铅丹"), "铅丹有毒，不收进可开具饮片组成");
  const youguiyin = entry("右归饮");
  for (const herb of ["杜仲", "肉桂"]) assert.ok(youguiyin.ingredients.includes(herb), `右归饮缺 ${herb}`);
  assert.ok(youguiyin.ingredients.some((herb) => /附/.test(herb)), "右归饮缺附子");
  assert.ok(!youguiyin.ingredients.includes("茯苓"), "茯苓属左归饮");
  const tongsheng = entry("防风通圣散");
  for (const herb of ["大黄", "芒硝"]) assert.ok(tongsheng.ingredients.includes(herb), `防风通圣散缺 ${herb}`);
  for (const herb of ["党参", "黄芪"]) assert.ok(!tongsheng.ingredients.includes(herb), `防风通圣散不应含 ${herb}`);
  assert.match(tongsheng.source, /黄帝素问宣明论方/);
});

await check("4.2 同名异方另立条目、不覆盖：温经汤（《金匮要略》十二味）与《妇人大全良方》九味版并存", () => {
  const jingui = catalog.find((item) => item.name.startsWith("温经汤〔《金匮要略》"));
  assert.ok(jingui, "缺《金匮要略》温经汤");
  assert.equal(jingui.ingredients.length, 12);
  for (const herb of ["吴茱萸", "半夏", "阿胶", "麦冬"]) assert.ok(jingui.ingredients.includes(herb));
  const dafang = entry("温经汤", "妇人大全良方");
  assert.ok(dafang && dafang.ingredients.length === 9, "原《妇人大全良方》版不得被覆盖");
});

await check("4.3 国家《古代经典名方目录》条目的出处栏不改（平胃散、泰山磐石散：教材出处更早只作备注）；书名笔误/简称已订正", () => {
  assert.match(entry("平胃散").source, /太平惠民和剂局方/);
  assert.match(entry("泰山磐石散").source, /景岳全书/);
  assert.match(entry("苏合香丸").source, /太平惠民和剂局方/, "「太民惠民和剂局方」笔误");
  assert.doesNotMatch(entry("左归饮").source, /^景岳$/);
  assert.match(entry("葛花解酲汤").source, /内外伤辨惑论/);
  assert.match(entry("逍遥散").source, /局方.*卷九|卷九/, "卷次不能在改书名时丢掉");
});

await check("4.4 药名归一到原文所指：三妙丸/四妙丸/独活寄生汤的牛膝与川牛膝不互换；清燥救肺汤胡麻仁→黑芝麻（不是亚麻子）", () => {
  assert.ok(entry("三妙丸").ingredients.includes("川牛膝"));
  assert.ok(entry("独活寄生汤").ingredients.includes("牛膝") && !entry("独活寄生汤").ingredients.includes("川牛膝"));
  assert.ok(entry("四妙丸").ingredients.includes("苍术") && !entry("四妙丸").ingredients.includes("知母"));
  const link = entry("清燥救肺汤").ingredientLinks.find((item) => item.rawName === "胡麻仁");
  assert.equal(link.canonicalName, "黑芝麻");
});

await check("4.5 解析错误的「药名」已清除：射干麻黄汤「一法」、牵正散「并生用」不再是药味", () => {
  assert.ok(!entry("射干麻黄汤").ingredients.includes("一法"));
  assert.ok(!entry("牵正散").ingredients.includes("并生用"));
});

// ── 5 待终审台账改为联网核对 ─────────────────────────────────────────────────────
await check("5.1 流派取向：核对通过的记 evidence_approved 并产生展示加分；核对不过的 evidence_rejected 零影响（反证）", async () => {
  const affinity = await jiti.import("../src/lib/tcm-formula-lineage-affinity.ts");
  const source = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-lineage-affinity.source.json", import.meta.url), "utf8"));
  assert.ok(source.bookRules.every((rule) => rule.adjudicationStatus === "evidence_approved"));
  const approved = source.formulaAdjudications.find((row) => row.status === "evidence_approved");
  const rejected = source.formulaAdjudications.find((row) => row.status === "evidence_rejected");
  assert.ok(approved && rejected);
  assert.equal(affinity.lineageAffinityForFormula(approved.formulaName, approved.source).adjudicated, true, `${approved.formulaName} 应生效`);
  assert.equal(affinity.lineageAffinityForFormula(rejected.formulaName, rejected.source).adjudicated, false, `${rejected.formulaName} 不得生效`);
});

await check("5.2 教材配穴不再挂待终审：来源标注 approved、无「尚未逐条终审」话术", () => {
  const text = source("src/lib/tcm-treatment-capabilities.server.ts");
  assert.doesNotMatch(text, /本机构中医师尚未逐条终审/);
  assert.match(text, /adjudicationStatus: "approved" as const,\s*conflictNote: null,/);
});

// ── 6 非剂量页的结构化副本（HIS 不再只看到「暂未生成」） ─────────────────────────────
const checkpointModule = jiti("../src/lib/m04-delivery-checkpoint.ts");
const visibleSummary = jiti("../src/lib/diagnosis-visible-summary.ts");
const syntheticCheckpoint = {
  content: "", payloadHash: "h",
  reasoning: {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{
      name: "银翘散加减", formulaAnalysis: "金银花、连翘辛凉透表，共为君药。", applicable: "风热犯表", notApplicable: "风寒表实",
      herbs: [
        { name: "金银花", role: "君", function: "清热解毒，疏散风热", targetPathogenesis: "风热袭表", dose: "15g" },
        { name: "甘草", role: "使", function: "调和诸药，每日 6g", targetPathogenesis: "调和" },
      ],
    }], patentAndWestern: [], modifications: [] },
  },
};
const readBlock = (page) => {
  const match = /<!-- CDSS_NON_DOSE_CANDIDATE_JSON:([\s\S]*?) -->/.exec(page);
  return match ? JSON.parse(match[1]) : null;
};

await check("6.1 剂量被独立硬边界收回时，非剂量页附带结构化副本：药味/角色/功用/方义齐全，adoptable=false，带原因码与收回理由", () => {
  const page = checkpointModule.renderM04DeliveryCheckpoint(syntheticCheckpoint, undefined, "dose_withheld", ["体温 40℃ 达极高热警戒值"]);
  const block = readBlock(page);
  assert.ok(block, "缺结构化副本");
  assert.equal(block.schemaVersion, "tcm-cdss-non-dose-candidate-v1");
  assert.equal(block.adoptable, false);
  assert.equal(block.reasonCode, "dose_authorization_withheld");
  assert.deepEqual(block.doseWithheldReasons, ["体温 40℃ 达极高热警戒值"]);
  assert.equal(block.candidates[0].name, "银翘散加减");
  assert.deepEqual(block.candidates[0].herbs.map((herb) => [herb.name, herb.role]), [["金银花", "君"], ["甘草", "使"]]);
  assert.match(block.candidates[0].formulaAnalysis, /君药/);
});

await check("6.2 反证：副本里没有剂量（键与值都没有）；模型写在功用里的用量被非剂量掩码去掉；注释不会被内容提前闭合", () => {
  const page = checkpointModule.renderM04DeliveryCheckpoint(syntheticCheckpoint, undefined, "dose_withheld", ["a --> b <script>"]);
  const block = readBlock(page);
  const text = JSON.stringify(block);
  assert.doesNotMatch(text, /"dose"|"decoction"|15g|6\s*g/, "副本不得带剂量");
  const commentBody = /<!-- CDSS_NON_DOSE_CANDIDATE_JSON:([\s\S]*?) -->/.exec(page)[1];
  assert.doesNotMatch(commentBody, /--|<|>/, "注释体内不得出现「--」「<」「>」（能提前闭合或破坏注释的字符）");
  assert.equal(block.doseWithheldReasons[0].includes("script"), true, "内容原样保留（只是被转义，不是丢弃）");
});

await check("6.3 擦洗器逐字放过该区块（camelCase 键名此前会被当成内部记号擦成空键）；区块外的内部记号照擦", () => {
  const page = checkpointModule.renderM04DeliveryCheckpoint(syntheticCheckpoint, undefined, "dose_withheld", []);
  const scrubbed = visibleSummary.scrubInternalVocabularyFromVisibleText(page);
  const block = readBlock(scrubbed);
  assert.ok(block && block.schemaVersion && block.reasonCode && Array.isArray(block.doseWithheldReasons), "键名不得被擦掉");
  assert.ok(Object.keys(block.candidates[0].herbs[0]).includes("targetPathogenesis"));
  const withLeak = visibleSummary.scrubInternalVocabularyFromVisibleText(`${page}\n\n正文里泄漏了 targetPathogenesis 与 m04_candidate_0_herb_1_function 这类记号`);
  assert.doesNotMatch(withLeak.slice(withLeak.indexOf("正文里泄漏了")), /targetPathogenesis|m04_candidate/, "区块外的记号照擦（区块保护没有变成豁免整页）");
});

await check("6.4 没有候选（deadline/上游不可用）时不产生副本——副本只在有可保留候选时出现", () => {
  const page = checkpointModule.renderM04DeliveryCheckpoint(undefined, undefined, "deadline", []);
  assert.equal(readBlock(page), null);
});

// ── 7 PHI 脱敏不得吃掉临床词形（M04 无饮片的又一个根因） ─────────────────────────────
// 2026-09-29 本机复现：M03 病机写「患者高龄，受凉后…」，送 M04 时关系前缀规则把「高龄」当成姓「高」+名「龄」抹成
// 「患者[姓名已脱敏]，」，M04 抄回被改写的病机，与已签名 M03 逐字不符 → pathogenesis_drift（T1）→ 整份候选收回，HIS 无饮片
// （tcm31 同病例 4 次里 3 次；生产 A 臂同样 0 味）。层归属：确定性脱敏层的词形误伤（不是模型、不是合同）。
const phi = jiti("../src/lib/phi-sanitizer.ts");
await check("7.1 关系/主语前缀 + 姓氏字开头的临床词形不再被当姓名抹掉（高龄、高血压…）；此前 3 处都被抹", () => {
  for (const text of ["患者高龄，受凉后风寒湿邪外袭，留着于双手近端指间关节", "本例高龄患者，舌淡红苔薄白", "患者高血压，服药规律", "家属诉患者老年起病"]) {
    assert.equal(phi.scrubSubjectPrefixedName(phi.scrubRelationPrefixedName(text)), text, `不应改写：${text}`);
  }
});

await check("7.2 反证（隐私）：真姓名照旧被抹——姓氏 × 常见名 × 既有叙述句式，一个都不能漏", () => {
  const surnames = ["高", "王", "张", "李", "刘", "陈", "杨", "赵"];
  const givens = ["伟", "强", "明", "峰", "丽", "敏", "勇", "静", "军", "磊"];
  const lexemes = new Set(JSON.parse(readFileSync(new URL("../src/data/phi-clinical-lexemes.json", import.meta.url), "utf8")).terms);
  let checked = 0;
  for (const surname of surnames) for (const given of givens) {
    const name = `${surname}${given}`;
    assert.ok(!lexemes.has(name), `${name} 不应在临床词形闭集里（否则会豁免真姓名）`);
    for (const [template, scrub] of [
      [`家属${name}代述病情`, phi.scrubRelationPrefixedName],
      [`患者${name}，男，45岁`, phi.scrubRelationPrefixedName],
      [`本例${name}既往有高血压`, phi.scrubSubjectPrefixedName],
    ]) {
      assert.doesNotMatch(scrub(template), new RegExp(name), `姓名泄漏：${template}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 240);
});

await check("7.3 端到端：M03→M04 的病机文字经脱敏后逐字不变，pathogenesis_drift 不再被自己触发", () => {
  const pathogenesis = "患者高龄，受凉后风寒湿邪外袭，留着于双手近端指间关节筋骨，湿性重着黏滞，故关节肿胀晨僵";
  const scrubbed = phi.scrubSubjectPrefixedName(phi.scrubRelationPrefixedName(pathogenesis));
  assert.equal(scrubbed, pathogenesis);
});

const safetyModule = jiti("../src/lib/diagnosis-safety.ts");
await check("7.4 M03 真实输出里的同类误伤（宗筋失于充养、和络止头痛）不再被抹；同姓真姓名照旧被抹（反证）", () => {
  for (const text of ["宗筋失于充养，故见阴茎勃起不坚", "次要:和络止头痛，并进一步明确", "宗气不足，卫表失和"]) {
    assert.equal(safetyModule.sanitizeFreeTextForModel(text), text, `不应改写：${text}`);
  }
  for (const text of ["本例宗强诉头痛3天", "患者和平，男，45岁，头痛"]) {
    assert.doesNotMatch(safetyModule.sanitizeFreeTextForModel(text), /宗强|和平/, `姓名泄漏：${text}`);
  }
});

await check("8.1 强制工具调用的终态 tool_calls 视同 stop（否则被接受的工具重试结果在终态门口被拒，M03 落成「症状级工作判断」）；非权威终态原样保留", () => {
  assert.equal(api.strictToolFinishReason("tool_calls"), "stop");
  assert.equal(api.strictToolFinishReason("stop"), "stop");
  for (const raw of ["length", "content_filter", "function_call", null, undefined]) {
    assert.equal(api.strictToolFinishReason(raw), raw ?? null, `${raw} 不得被改写`);
  }
  assert.match(source("src/lib/diagnosis-api.ts"), /finishReason: strictToolFinishReason\(result\.choices\?\.\[0\]\?\.finish_reason \?\? null\)/, "工具重试的返回值必须过这道归一");
});

if (failures.length > 0) console.error(JSON.stringify({ failures }, null, 2));
assert.equal(failures.length, 0, `甲方测评整改第二轮回归失败 ${failures.length} 项`);
console.log(JSON.stringify({ checks, failures: 0 }));
