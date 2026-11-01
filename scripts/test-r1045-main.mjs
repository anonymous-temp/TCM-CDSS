// 第三十三轮（2026-11-01）：规则根源整改。量法见 ~/runlogs/r1018/work/r1045（模型原始输出 → 交付逐处对比、教材自检）。
// 1. 方义：未复核的别名不当药名、前面贴着实词的不算点名、属名认本方药、「制」作动词不去掉。教材方解自检进闸门（只许降）。
// 2. 治法：对着将要交付的治法核对覆盖，补的项带过教材锚定，至多两项。
// 3. 加减：按编号取教材条目；至少两个不同的条件；模型自写的行不再因为教材有条目就丢；借别的病的行要同类证、过方向核对；同源药不加。
// 4. 兼证：判据表外的证名按脏腑取最贴切的条目、按证素合成、用教材行；病名不算兼证。
// 5. 病历自己写的旧处方照引不算开方；写了加减而组成就是原方时去掉加减。
// 每条断言都有反证（~/runlogs/r1018/work/r1045/cp/）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

const check = async (name, run) => {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const analysis = await jiti.import("../src/lib/formula-analysis-review.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const secondary = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
const method = await jiti.import("../src/lib/m03-method-coverage.server.ts");
const fit = await jiti.import("../src/lib/m04-modification-fit.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");

const review = (text, herbs) => analysis.reviewAuthoredFormulaAnalysis(text, herbs);

// ── 1. 方义 ──────────────────────────────────────────────
await check("1.1 普通词不是药：活血通经、能消水肿、以制水邪、宁神益智一字不动", () => {
  assert.match(review("当归活血通经，川芎行气止痛，为君。白术健脾益气，助运化湿，为臣。", ["当归", "川芎", "白术"]).text, /活血通经/u);
  const water = review("茯苓利水渗湿，能消水肿，为君。桂枝温阳化气，以制水邪，为臣。甘草调和诸药，为使。", ["茯苓", "桂枝", "甘草"]);
  assert.match(water.text, /能消水肿/u);
  assert.match(water.text, /以制水邪/u);
  assert.match(review("黄芪补气为君。远志宁神益智，为佐。当归养血为臣。", ["黄芪", "远志", "当归"]).text, /宁神益智/u);
  assert.deepEqual(review("牛膝活血通络，共奏补益肝肾、活血通络之效，为君。当归养血为臣。", ["牛膝", "当归"]).foreignHerbs, []);
});
await check("1.2 可靠性判定：数据集别名不算；药典名、人工裁定的别名、属名算；炮制字头去掉后要还是名字", () => {
  for (const word of ["血通", "能消", "重药", "旁通", "去水", "根皮", "制水", "生用"]) assert.equal(analysis.herbWordReliableInFreeText(word), false, word);
  for (const word of ["黄连", "丹皮", "芍药", "炒白术", "益智"]) assert.equal(analysis.herbWordReliableInFreeText(word), true, word);
});
await check("1.3 位置：前面贴着实词的不算点名；句首、连接用字后的算", () => {
  assert.equal(analysis.mentionInHerbPosition("远志宁神益智", 4), false);
  assert.equal(analysis.mentionInHerbPosition("黄连清热", 0), true);
  assert.equal(analysis.mentionInHerbPosition("佐以黄连清热", 2), true);
  assert.equal(analysis.mentionInHerbPosition("方中、黄连", 3), true);
});
await check("1.4 属名认本方药：药味表白芍，方义写芍药，整句保留", () => {
  const out = review("方中柴胡疏肝解郁为君。芍药敛阴柔肝为臣，与柴胡合用。枳实理气为佐。甘草调和诸药为使。", ["柴胡", "白芍", "枳实", "甘草"]);
  assert.deepEqual(out.foreignHerbs, []);
  assert.match(out.text, /柔肝为臣/u);
});
await check("1.5 真正的方外药仍然删（方义点了药味表没有的药）", () => {
  const out = review("方中柴胡疏肝为君。黄连清热燥湿为佐。白芍柔肝为臣。甘草调和诸药为使。", ["柴胡", "白芍", "甘草"]);
  assert.deepEqual(out.foreignHerbs, ["黄连"]);
  assert.doesNotMatch(out.text, /黄连/u);
});
await check("1.6 「制」是动词时不去掉；炮制写法照旧对齐药味表", () => {
  assert.match(analysis.withMentionsAlignedToTableNames("生姜散结和胃并制半夏之毒。", ["半夏", "生姜"]).text, /并制半夏之毒/u);
  assert.match(analysis.withMentionsAlignedToTableNames("炒白术健脾为君。", ["白术"]).text, /^白术健脾/u);
});
await check("1.7 教材方解自检（只许降）：方解原文 × 这张方的组成，被判方外药的不超过 29 首，且没有普通词", () => {
  const refs = JSON.parse(readFileSync("src/data/tcm-herb-textbook-references.json", "utf8"));
  const table = JSON.parse(readFileSync("src/data/tcm-textbook-syndrome-formula-table.json", "utf8"));
  const composition = new Map();
  for (const row of table.rows) for (const item of row.compositionByFormula || []) {
    if (item.herbs?.length) composition.set(item.formula, new Set([...(composition.get(item.formula) || []), ...item.herbs]));
  }
  let flagged = 0;
  const words = new Set();
  for (const [name, entry] of Object.entries(refs.formulaCommentaries || {})) {
    if (!entry.commentary || !composition.has(name)) continue;
    const herbs = new Set(composition.get(name));
    for (const reference of provenance.formulaCompilationReferences([name])) for (const herb of reference.ingredients || []) herbs.add(herb);
    const body = entry.commentary.replace(/(本方(?:原载|原名|出自|始见|系|是)|后世)[\s\S]*$/u, "").slice(0, 420);
    const out = review(body, [...herbs].map((herb) => contract.canonicalTcmHerbIdentity(herb) || herb));
    if (out.foreignHerbs.length > 0) flagged += 1;
    for (const word of out.foreignHerbs) words.add(word);
  }
  assert.ok(flagged <= 29, `flagged ${flagged}`);
  for (const word of ["血通", "能消", "制水", "生用", "炒用", "明白", "旁通", "宽肠", "去水", "重药", "朱丹", "根皮"]) assert.equal(words.has(word), false, word);
});

// ── 2. 治法 ──────────────────────────────────────────────
await check("2.1 提名合格：2–6 字、将要交付的治法没写、一条逐字摘录就够；不再要求方中药味字面有这个词", () => {
  const context = { method: "疏风散寒，宣肺止咳", recordText: "咳嗽，痰多色白质稀，泛吐酸水" };
  assert.equal(method.methodItemQualifies({ item: "化痰", quotes: ["痰多色白质稀"] }, context), true);
  assert.equal(method.methodItemQualifies({ item: "温化寒饮", quotes: ["痰多色白质稀"] }, context), true);
  assert.equal(method.methodItemQualifies({ item: "宣肺止咳", quotes: ["痰多色白质稀"] }, context), false);
  assert.equal(method.methodItemQualifies({ item: "化痰", quotes: ["胸闷气短"] }, context), false);
  assert.equal(method.methodItemQualifies({ item: "这一项治法写得太长了不行", quotes: ["痰多色白质稀"] }, context), false);
  assert.equal(method.methodItemQualifies({ item: "制酸降逆", quotes: [], fromModel: true }, context), true, "模型原写的项不要摘录，由复核判");
});
await check("2.2 对着将要交付的治法问：有教材行时问教材治法，模型原写的项单独复核", async () => {
  const original = process.env.CDSS_M03_METHOD_COVERAGE;
  process.env.CDSS_M03_METHOD_COVERAGE = "true";
  const source = readFileSync("src/lib/m03-method-coverage.server.ts", "utf8");
  assert.match(source, /return \(row && textbookAnchorableMethod\(row\.therapy\)\) \|\| modelMethod/u);
  assert.match(source, /const method = methodToDeliver\(text\(overview\.tcmDiseaseName\), syndrome, modelMethod\)/u);
  // 第三十四轮：提名不看模型的治法（证名写出来就能先发），模型原写的项单独问。
  assert.match(source, /JSON\.stringify\(\{ syndrome, method, record:/u);
  process.env.CDSS_M03_METHOD_COVERAGE = original;
});
await check("2.2b 待复核的项：模型原写而教材没有的排前面；method 外的 coveredBy 算没人管；method 里的不算", () => {
  const out = method.methodCoverageCandidates([
    { item: "", quotes: ["泛吐酸水"], coveredBy: "制酸降逆" },
    { item: "", quotes: ["胃痛"], coveredBy: "和胃止痛" },
    { item: "健脾止泻", quotes: ["便溏"] },
  ], "温中健脾，和胃止痛", "温中健脾，和胃止痛，制酸降逆，通络");
  assert.deepEqual(out.map((item) => item.item), ["制酸降逆", "通络", "制酸降逆", "健脾止泻"]);
  assert.equal(out[0].fromModel, true);
});
await check("2.2c 治法核对：两次提名都有的项复核没通过时换另一家再问（删行的核对不这样）", () => {
  assert.match(readFileSync("src/lib/m03-method-coverage.server.ts", "utf8"), /recheckAgreed: true/u);
  assert.doesNotMatch(readFileSync("src/lib/m04-modification-fit.server.ts", "utf8"), /recheckAgreed/u);
  const shared = readFileSync("src/lib/cross-model-small-task.server.ts", "utf8");
  assert.match(shared, /verdict !== true && options\.recheckAgreed && inFirst\.has\(key\) && inSecond\.has\(key\)/u);
});
await check("2.2d 已被说到的不再补：两字一节都在治法里算说到；锚定时逐项判", () => {
  assert.equal(provenance.methodItemAlreadyCovered("调经止血", "清热凉血调经，止血"), true);
  assert.equal(provenance.methodItemAlreadyCovered("凉血止血", "清热凉血调经，止血"), true);
  assert.equal(provenance.methodItemAlreadyCovered("化痰", "疏风散寒，宣肺止咳"), false);
  assert.equal(provenance.methodItemAlreadyCovered("制酸降逆", "温中健脾，和胃止痛"), false);
  assert.equal(method.methodItemQualifies({ item: "调经止血", quotes: [], fromModel: true }, { method: "清热凉血调经，止血", recordText: "" }), false);
  const base = {
    stage: "diagnose",
    overview: { tcmDiseaseName: "咳嗽", primarySyndrome: "风寒袭肺证", overallTherapy: "x", recommendedFormulaDirection: "三拗汤合止嗽散加减", secondarySyndromes: [] },
    pathogenesis: { chain: [], locationDifferentiation: { items: ["肺"] } },
    therapy: { overallMethod: "x", verifiedMethodItem: "止咳化痰，化痰止咳" },
  };
  const out = provenance.withDeterministicFormulaReferences(base, "咳嗽痰多");
  assert.equal((out.therapy.overallMethod.match(/化痰/gu) || []).length, 1, out.therapy.overallMethod);
});
await check("2.3 补的几项都带过教材锚定；重复的不接；并行结果也接几项", () => {
  const base = {
    stage: "diagnose",
    overview: { tcmDiseaseName: "咳嗽", primarySyndrome: "风寒袭肺证", overallTherapy: "疏风散寒，宣肺止咳，化痰", recommendedFormulaDirection: "三拗汤合止嗽散加减", secondarySyndromes: [] },
    pathogenesis: { chain: [], locationDifferentiation: { items: ["肺"] } },
    therapy: { overallMethod: "疏风散寒，宣肺止咳，化痰", verifiedMethodItem: "化痰，降气平喘" },
  };
  const out = provenance.withDeterministicFormulaReferences(base, "咳嗽痰多，气喘");
  assert.match(out.therapy.overallMethod, /化痰/u);
  assert.match(out.therapy.overallMethod, /降气平喘/u);
  assert.equal((out.therapy.overallMethod.match(/化痰/gu) || []).length, 1);
  const none = provenance.withDeterministicFormulaReferences({ ...base, therapy: { overallMethod: "疏风散寒，宣肺止咳，化痰" } }, "咳嗽");
  assert.doesNotMatch(none.therapy.overallMethod, /化痰/u);
  const merged = JSON.parse(method.withVerifiedMethodItemFrom(JSON.stringify({ therapy: { overallMethod: "宣肺止咳，化痰" }, overview: {} }), JSON.stringify({ therapy: { verifiedMethodItem: "化痰，降气平喘" }, overview: {} })));
  assert.equal(merged.therapy.overallMethod, "宣肺止咳，化痰，降气平喘");
});

// ── 3. 加减 ──────────────────────────────────────────────
await check("3.1 条目编号：提示词带号、过滤不改号；按号取条件", () => {
  const row = textbook.textbookRowForSyndrome("胃痛", "脾胃虚寒证");
  const prompt = textbook.buildTextbookFormulaContext("胃痛", "脾胃虚寒证", { recordText: "" });
  assert.match(prompt, /E1 若/u);
  const entry = textbook.textbookEntryById("胃痛", "脾胃虚寒证", [], "E2");
  assert.equal(entry.condition, row.modifications[1].condition);
  assert.equal(textbook.textbookEntryById("胃痛", "脾胃虚寒证", [], "E99"), undefined);
  assert.equal(textbook.textbookEntryById("胃痛", "脾胃虚寒证", [], "2"), undefined);
});
await check("3.2 不同条件数：同一条件两味药算一条，写法差「若」和标点不算不同", () => {
  assert.equal(compiler.distinctModificationConditions([{ trigger: "若潮热甚" }, { trigger: "若潮热甚" }]), 1);
  assert.equal(compiler.distinctModificationConditions([{ trigger: "若潮热甚" }, { trigger: "潮热甚。" }, { trigger: "若便秘" }]), 2);
});
await check("3.2b 选了两味一组的条目：另一味带上且不重复；后面还能补别的条件", () => {
  const prior = {
    stage: "diagnose", schemaVersion: "tcm-cdss-reasoning-v2",
    overview: { tcmDiseaseName: "痛经", primarySyndrome: "寒凝血瘀证", recommendedFormulaNames: [] },
    pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "寒凝血瘀", therapyDirection: "温经散寒" }] },
    westernDiagnosis: { primary: {} }, therapy: { overallMethod: "温经散寒，化瘀止痛" },
  };
  const row = (herbName) => ({ textbookEntry: "E1", trigger: "若小腹冷痛较甚", targetRef: "P1", actionType: "add", herbName, reason: "温经止痛" });
  const seen = compiler.normalizeModificationsForTest([row("艾叶"), row("吴茱萸")], prior);
  assert.deepEqual(seen.map((item) => item.herbName), ["艾叶", "吴茱萸"]);
  const one = compiler.normalizeModificationsForTest([row("艾叶")], prior);
  assert.deepEqual(one.map((item) => item.herbName).sort(), ["吴茱萸", "艾叶"].sort(), "只写一味时带上另一味");
});
await check("3.3 模型自写的条件句：教材有条目也合格；形状不对的仍然不行", () => {
  assert.equal(textbook.conditionalModificationWithoutTextbook("若腰膝酸软"), true);
  assert.equal(textbook.conditionalModificationWithoutTextbook("若舌红脉数"), false);
  assert.equal(textbook.conditionalModificationWithoutTextbook("复诊时症状变化"), false);
  const prior = { stage: "diagnose", overview: { tcmDiseaseName: "胃痛", primarySyndrome: "脾胃虚寒证" }, pathogenesis: { chain: [] }, westernDiagnosis: { primary: {} } };
  assert.equal(contract.finalModificationTriggerGrounded("若腰膝酸软", prior), true);
});
await check("3.4 借别的病的行：证要同类（共有两字以上）；烧伤·火毒伤津证不借给气阴两伤证；同病优先；剂型不同算同方", () => {
  assert.equal(textbook.textbookRowForFormula("外感发热", ["白虎加人参汤"], "气阴两伤证")?.disease === "烧伤", false);
  const same = textbook.textbookRowForFormula("不寐", ["归脾汤"], "心脾两虚证");
  assert.equal(same?.disease, "不寐");
  assert.ok(textbook.textbookRowForFormula("不寐", ["归脾丸"], "心脾两虚证"));
  assert.equal(textbook.textbookRowForFormula("虚劳", ["逍遥散"], "肺脾两虚证"), undefined);
  assert.equal(textbook.textbookRowForFormula("痹证", ["当归四逆汤"], "血虚寒凝证")?.disease === "硬肿症", false, "儿科的行不借给成人内科病");
  assert.ok(textbook.textbookRowForFormula("虚劳", ["归脾汤"], "心脾气血两虚证"));
  assert.equal(textbook.textbookRowForFormula("虚劳", ["归脾汤"], "心脾气血两虚证", { sameDiseaseOnly: true }), undefined);
});
await check("3.5 借来的行不算本证教材条目（要过方向核对）", () => {
  const row = textbook.textbookRowForFormula("虚劳", ["归脾汤"], "心脾气血两虚证");
  assert.ok(row && row.disease !== "虚劳");
  const entry = row.modifications.find((item) => item.herbs.length > 0 && item.condition.length >= 2);
  const prior = { overview: { tcmDiseaseName: "虚劳", primarySyndrome: "心脾气血两虚证", recommendedFormulaNames: ["归脾汤"] } };
  const match = textbook.textbookModificationMatch("虚劳", "心脾气血两虚证", `若${entry.condition}`, entry.herbs[0], contract.sameHerbIdentity, ["归脾汤"]);
  assert.equal(match?.crossDisease, true);
  assert.equal(contract.isTextbookConditionalModification(`若${entry.condition}`, entry.herbs[0], prior), false);
});
await check("3.6 教材条目比药名：附子不是白附子（给了身份判定就不按字面包含）", () => {
  const row = textbook.textbookRowForSyndrome("胃痛", "脾胃虚寒证");
  const entry = row.modifications.find((item) => item.herbs.length > 0);
  assert.ok(textbook.textbookModificationMatch("胃痛", "脾胃虚寒证", `若${entry.condition}`, entry.herbs[0], contract.sameHerbIdentity));
  const fake = textbook.textbookModificationMatch("胃痛", "脾胃虚寒证", `若${entry.condition}`, `白${entry.herbs[0]}`, contract.sameHerbIdentity);
  assert.equal(fake, undefined);
});
await check("3.7 舌脉读法：「舌痛」挡不住后面的舌淡；静脉曲张不是脉象", () => {
  assert.equal(textbook.modificationConditionTonguePulseConflict("若舌红少苔", "舌痛。舌淡苔白"), true);
  assert.equal(textbook.modificationConditionTonguePulseConflict("若脉数", "下肢静脉曲张"), false);
});
await check("3.8 核对提名：说相反的要有病历摘录；教材行只判条件；只看「加」的行", () => {
  const rows = [
    { action: "加", herbName: "黄连", trigger: "若口苦", evidence: { evidenceLevel: "kb_entry" } },
    { action: "加", herbName: "白芍", trigger: "若头晕", evidence: { evidenceLevel: "model_inference" } },
    { action: "减", herbName: "黄芪", trigger: "若腹胀", evidence: { evidenceLevel: "model_inference" } },
  ];
  const record = "大便干结，口不苦";
  assert.equal(fit.modificationFindingQualifies({ line: 0, verdict: "contradicts", quote: "口不苦" }, rows, record), true);
  assert.equal(fit.modificationFindingQualifies({ line: 0, verdict: "contradicts", quote: "舌红" }, rows, record), false);
  assert.equal(fit.modificationFindingQualifies({ line: 0, verdict: "misfit", quote: "" }, rows, record), false);
  assert.equal(fit.modificationFindingQualifies({ line: 1, verdict: "misfit", quote: "" }, rows, record), true);
  assert.equal(fit.modificationFindingQualifies({ line: 2, verdict: "misfit", quote: "" }, rows, record), false);
  assert.equal(fit.modificationFindingQualifies({ line: 9, verdict: "misfit", quote: "" }, rows, record), false);
  const borrowed = [{ action: "加", herbName: "鸡血藤", trigger: "若硬肿甚", evidence: { evidenceLevel: "kb_entry", source: "《中医儿科学》硬肿症·寒凝血涩证加减：硬肿甚，加鸡血藤" } }];
  assert.equal(fit.modificationFindingQualifies({ line: 0, verdict: "misfit", quote: "" }, borrowed, record, "痹证"), true, "借别的病的行连药一起判");
  assert.equal(fit.modificationFindingQualifies({ line: 0, verdict: "misfit", quote: "" }, borrowed, record, "硬肿症"), false, "本病的教材条目只判条件");
});

// ── 4. 兼证 ──────────────────────────────────────────────
await check("4.1 按脏腑取最贴切的条目：痰热郁肺→痰热壅肺证；肺胃热盛→肺热炽盛证+胃热炽盛证", () => {
  assert.deepEqual(secondary.compoundCriteriaEntries("痰热郁肺证").map((entry) => entry.name), ["痰热壅肺证"]);
  assert.deepEqual(secondary.compoundCriteriaEntries("肺胃热盛证").map((entry) => entry.name), ["肺热炽盛证", "胃热炽盛证"]);
});
await check("4.2 按证素合成：气阴两虚、痰瘀互结、寒凝血瘀要每个证素都有证据；单证素取它自己", () => {
  assert.deepEqual(secondary.elementCompositeCriteriaEntry("气阴两虚证").components, ["气虚证", "阴虚证"]);
  assert.deepEqual(secondary.elementCompositeCriteriaEntry("痰瘀互结证").components, ["血瘀证", "痰证"]);
  assert.deepEqual(secondary.elementCompositeCriteriaEntry("寒凝血瘀证").components, ["血瘀证", "寒证"]);
  assert.equal(secondary.elementCompositeCriteriaEntry("血虚证").name, "血虚证");
});
await check("4.2b 独立表现 4 条以上且对上一条要点算成组；只对上 3 条或一条要点都没有的不算", () => {
  const entry = secondary.diagnosticsCriteriaFor("血瘀证");
  const record = "胁下刺痛，痛处固定不移，夜间痛甚，月经色紫暗，夹有血块，面色黧黑。";
  const context = { recordText: record, primaryTerms: [] };
  const match = (item, quote) => ({ item, quote });
  const six = [match("疼痛", "胁下刺痛"), match("固定不移", "痛处固定不移"), match("在夜间痛甚", "夜间痛甚"), match("色紫暗", "月经色紫暗"), match("夹有血块", "夹有血块"), match("瘀血色脉征主要有面色黧黑", "面色黧黑")];
  assert.equal(secondary.evaluateCriteriaMatches(entry, six, context).verdict, "pass");
  assert.equal(secondary.evaluateCriteriaMatches(entry, six.slice(0, 3), context).verdict, "fail");
  assert.equal(secondary.evaluateCriteriaMatches(entry, six.slice(1, 6), context).verdict, "fail", "一条要点都没对上");
});
await check("4.3 病名不算兼证；带「证」字的照常", () => {
  assert.equal(secondary.secondaryStructurallyInvalid("阴虚秘", "月经先期"), "not_a_syndrome");
  assert.equal(secondary.secondaryStructurallyInvalid("脾胃虚寒证", "肾阳虚证"), undefined);
});

// ── 5. 其他 ──────────────────────────────────────────────
await check("5.1 病历自己写的旧处方照引不算开方；病历没写的仍算", () => {
  const record = "炙甘草6克，炮姜6克，每日1剂，水煎服。";
  assert.deepEqual(contract.m03DoseLevelInstructionFindings({ facts: ["既往予方：每日1剂，水煎服"] }, "", "$", record).filter((item) => item.kind === "regimen"), []);
  assert.equal(contract.m03DoseLevelInstructionFindings({ facts: ["建议每日1剂"] }, "", "$", "咳嗽三天").filter((item) => item.kind === "regimen").length, 1);
});
await check("5.3 用法里的「酸枣仁」不算已经写了姜枣：归脾汤照样写原方的姜枣引", () => {
  const source = readFileSync("src/lib/delivered-surface.ts", "utf8");
  assert.match(source, /!\/\(\?:生姜\|煨姜\|大枣\|姜枣\|姜、枣\|红枣\)\/u\.test\(candidateDecoction\.method\)/u);
  assert.equal(surface.omittedGuideHerbNote("归脾汤", ["黄芪", "人参", "白术", "当归", "酸枣仁"].map((name) => ({ name }))), "原方以生姜、大枣为引，煎时可酌加");
});
await check("5.4 合方里目录查不到、教材单列了组成的方照样算：二陈平胃散合三子养亲汤不会只剩三子养亲汤", () => {
  const row = textbook.textbookRowForSyndrome("咳嗽", "痰湿蕴肺证");
  const prescribe = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    overview: { tcmDiseaseName: "咳嗽", primarySyndrome: "痰湿蕴肺证", recommendedFormulaDirection: "二陈平胃散合三子养亲汤加减" },
    formula: { candidates: [{ name: "三子养亲汤加减", formulaAnalysis: "本方以三子养亲汤为基础加减。法半夏为君。", herbs: row.composition.map((name) => ({ name, dose: "9g" })) }], modifications: [] },
    nonPharma: { precautions: [] },
  };
  assert.equal(surface.projectDeliveredReasoning(prescribe).formula.candidates[0].name, "二陈平胃散合三子养亲汤加减");
});
await check("5.2 写了加减、组成就是原方：判得出原方；组成有增减的不判", () => {
  const reference = provenance.formulaCompilationReferences(["四君子汤"])[0];
  assert.ok(reference?.ingredients?.length);
  const herbs = reference.ingredients.map((name) => ({ name: name.replace(/[（(][^）)]*[）)]/gu, "") }));
  assert.equal(surface.candidateIsOriginalFormula("四君子汤", herbs), true);
  assert.equal(surface.candidateIsOriginalFormula("四君子汤", [...herbs, { name: "黄芪" }]), false);
});
