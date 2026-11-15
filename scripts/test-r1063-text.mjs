// 第四十六轮工作包 D（知识与文字类）：出处、「原方」说法、药味功效、中成药、流派、外治、中医鉴别、西医病名细节、中医病名。
// 条目来自第四十五轮逐字复核（~/runlogs/r1018/work/r1063/fin2-errors-by-item.json 的 A/C/E/F/J/K/O/P/Q 项）。
// 每条断言都有反证（~/runlogs/r1018/work/r1063/cp/text.py）。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
let failures = 0;
const ONLY = process.env.R1063_ONLY ? new Set(process.env.R1063_ONLY.split(",")) : undefined;
const check = async (name, run) => {
  if (ONLY && !ONLY.has(name.split(" ")[0])) return;
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const original = await jiti.import("../src/lib/formula-original-composition.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const patent = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
const nondrug = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
const capabilities = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
const authoring = await jiti.import("../src/lib/home-acupoint-authoring.server.ts");
const homeCare = await jiti.import("../src/lib/home-acupoint-care.server.ts");
const differential = await jiti.import("../src/lib/tcm-disease-differential-normalization.ts");
const western = await jiti.import("../src/lib/western-name-evidence-check.server.ts");
const alignment = await jiti.import("../src/lib/western-rationale-alignment.ts");
const criteria = await jiti.import("../src/lib/western-diagnostic-criteria.server.ts");
const terminology = await jiti.import("../src/lib/clinical-terminology.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");

const H = (names) => names.map((name) => (typeof name === "string" ? { name } : name));
const project = (reasoning, options) => surface.projectDeliveredReasoning(reasoning, options);
const prescribe = (candidate, extra = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
  overview: { tcmDiseaseName: "", primarySyndrome: "" },
  formula: { candidates: [{ name: "", herbs: [], formulaSource: { evidenceLevel: "kb_entry", source: "", confidence: "中" }, formulaAnalysis: "", decoction: { method: "水煎服" }, ...candidate }], patentAndWestern: [], modifications: [] },
  ...extra,
});

// 1. 出处：处方覆盖教材所引原书的原方组成时，出处用那本原书；现有出处已是教材写过的书时不动。
await check("1.1 一贯煎署《续名医类案》（《方剂学》）并注明国家目录所据《医方絜度》；桃红四物汤署《医垒元戎》（n09、C046）", () => {
  const yiguan = provenance.resolveFormulaSources("一贯煎", H(["生地黄", "枸杞子", "当归", "北沙参", "麦冬", "川楝子"]))[0]?.source || "";
  assert.match(yiguan, /^《续名医类案》/);
  assert.match(yiguan, /国家古代经典名方目录据《医方絜度》/);
  assert.match(provenance.textbookCitedOriginalSource("桃红四物汤", ["桃仁", "红花", "当归", "川芎", "地黄", "酒白芍", "骨碎补", "甘草"], "《妇科冰鉴》") || "", /^《医垒元戎》/);
});
await check("1.2 合方里的小半夏加茯苓汤署《金匮要略》，不署后出的《卫生宝鉴·补遗》（n13）", () => {
  const sources = provenance.resolveFormulaSources("苓桂术甘汤合小半夏加茯苓汤加减", H(["茯苓", "桂枝", "土炒白术", "姜半夏", "生姜", "炙甘草"])).map((item) => item.source);
  assert.deepEqual(sources, ["《金匮要略》", "《金匮要略》"]);
});
await check("1.3 对照：温胆汤带茯苓仍《三因》、不带茯苓仍《备急千金要方》（两本都是教材写过的，第十三轮取法不变）；处方不覆盖原方组成时不换", () => {
  assert.match(provenance.resolveFormulaSources("温胆汤加减", H(["半夏", "竹茹", "枳实", "陈皮", "甘草", "茯苓"]))[0]?.source || "", /三因/);
  assert.match(provenance.resolveFormulaSources("温胆汤加减", H(["半夏", "竹茹", "枳实", "陈皮", "甘草", "生姜"]))[0]?.source || "", /备急千金要方/);
  assert.equal(provenance.textbookCitedOriginalSource("桃红四物汤", ["桃仁", "当归", "川芎", "地黄", "白芍"], "《妇科冰鉴》"), undefined, "少了红花不覆盖原方");
  assert.equal(provenance.textbookCitedOriginalSource("一贯煎", ["生地黄", "枸杞子", "当归", "北沙参", "麦冬", "川楝子"], "《续名医类案》"), undefined, "已是教材的书不动");
  assert.equal(provenance.textbookCitedOriginalSource("一贯煎", ["生地黄", "枸杞子", "当归", "北沙参", "麦冬", "川楝子"], "《柳洲医话》"), undefined, "教材证型行写过的书（内科胁痛一贯煎《柳洲医话》）也不动");
});
await check("1.4 交付面：出处栏与 baseFormulas 同一取法（模型写成自拟方后由目录补的出处也换）", () => {
  const out = project(prescribe({ name: "桃红四物汤加减", herbs: H(["桃仁", "红花", "当归", "川芎", "地黄", "酒白芍", "骨碎补", "甘草"]),
    formulaSource: { evidenceLevel: "model_inference", source: "桃红四物汤：《妇科冰鉴》", confidence: "中" },
    baseFormulas: [{ name: "桃红四物汤", source: "《妇科冰鉴》" }] }));
  const candidate = out.formula.candidates[0];
  assert.match(candidate.formulaSource.source, /^桃红四物汤：《医垒元戎》/);
  assert.match(candidate.baseFormulas[0].source, /^《医垒元戎》/);
  assert.deepEqual(project(out), out, "幂等");
});
await check("1.5 《方剂学》出处表：正方、附方、原名又名都按行号摘到", () => {
  const table = JSON.parse(fs.readFileSync("src/data/tcm-fangjixue-formula-citations.json", "utf8")).formulas;
  assert.equal(table["一贯煎"].book, "续名医类案");
  assert.equal(table["桃红四物汤"].book, "医垒元戎");
  assert.equal(table["金匮肾气丸"].book, "金匮要略");
  assert.deepEqual(original.textbookCitedFormulaBooks("一贯煎")[0], "续名医类案");
});

// 2. 「原方」说法只说能核实的事。
await check("2.1 生熟地黄是两味药：金匮肾气丸原方干地黄，处方熟地黄不是原方（n38）；处方生地黄仍是", () => {
  const rest = ["山药", "山茱萸", "泽泻", "牡丹皮", "茯苓", "桂枝", "制附子"];
  assert.equal(surface.candidateIsOriginalFormula("金匮肾气丸", H(["熟地黄", ...rest])), false);
  assert.equal(surface.candidateIsOriginalFormula("金匮肾气丸", H(["生地黄", ...rest])), true);
});
await check("2.2 原方写明、本方未照用的炮制、药用部位、药引如实列出（八正散、凉血地黄汤、参苓白术散）", () => {
  assert.deepEqual(surface.originalFormulaDeliveryNotes("八正散", H(["车前子", "瞿麦", "萹蓄", "滑石", "栀子", "炙甘草", "木通", "大黄"])), ["大黄煨用", "以灯心草为引"]);
  const liangxue = surface.originalFormulaDeliveryNotes("凉血地黄汤", H(["当归", "生地黄", "赤芍", "黄连", "枳壳", "黄芩", "槐角", "地榆", "荆芥炭", "升麻", "天花粉", "甘草"]));
  assert.ok(liangxue.includes("当归用归尾") && liangxue.includes("黄芩、槐角、地榆炒炭"), liangxue.join("；"));
  assert.ok(surface.originalFormulaDeliveryNotes("参苓白术散", H(["莲子", "薏苡仁", "砂仁", "桔梗", "白扁豆", "茯苓", "人参", "炙甘草", "白术", "山药"])).includes("以大枣为引"));
});
await check("2.3 交付面：开头改说「本方药味同X原方（原方…，本方未照用）」，幂等；对照：丸散制备的焙炒（柴胡疏肝散陈皮醋、枳壳麸炒）不写", () => {
  const out = project(prescribe({ name: "八正散", herbs: H(["车前子", "瞿麦", "萹蓄", "滑石", "栀子", "炙甘草", "木通", "大黄"]), formulaAnalysis: "本方以八正散为基础加减。滑石、木通为君。" }));
  assert.equal(out.formula.candidates[0].formulaAnalysis, "本方药味同八正散原方（原方大黄煨用，以灯心草为引，本方未照用）。滑石、木通为君。");
  assert.deepEqual(project(out), out);
  const chaihu = project(prescribe({ name: "柴胡疏肝散", herbs: H(["柴胡", "陈皮", "川芎", "香附", "枳壳", "白芍", "甘草"]), formulaAnalysis: "本方用柴胡疏肝散原方。柴胡为君。" }));
  assert.equal(chaihu.formula.candidates[0].formulaAnalysis, "本方用柴胡疏肝散原方。柴胡为君。");
});
await check("2.4 用法里的药引：姜枣以外的煎药药引也写（银翘散鲜苇根汤煎、参苓白术散枣汤调下）；用法已写到的不重复；做丸的辅料不劝煎时加", () => {
  const yinqiao = H(["连翘", "金银花", "桔梗", "薄荷", "淡竹叶", "甘草", "荆芥穗", "淡豆豉", "牛蒡子"]);
  assert.equal(surface.omittedGuideHerbNote("银翘散", yinqiao), "原方以芦根为引，煎时可酌加");
  assert.equal(surface.omittedGuideHerbNote("银翘散", yinqiao, {}, "", "鲜芦根煎汤代水"), undefined);
  assert.equal(surface.omittedGuideHerbNote("参苓白术散", H(["莲子", "薏苡仁", "砂仁", "桔梗", "白扁豆", "茯苓", "人参", "炙甘草", "白术", "山药"]), {}, "", "酸枣仁用前捣碎"), "原方以大枣为引，煎时可酌加");
  assert.doesNotMatch(surface.omittedGuideHerbNote("大补阴丸", H(["熟地黄", "龟甲", "黄柏", "知母"])) || "", /猪脊髓/);
});

// 3. 药味功效：知识库错条按《中药学》剔除；新增息风、疏散风热两类方向核对。
await check("3.1 知识库错条剔除：白果无清热解毒、仙茅无补气与清热解毒、白薇无滋阴补肾与健脾益气（C003、n21、C007）", () => {
  assert.doesNotMatch(knowledge.getTcmHerbFunctionText("白果"), /清热解毒/);
  assert.doesNotMatch(knowledge.getTcmHerbFunctionText("仙茅"), /补气|清热解毒/);
  assert.doesNotMatch(knowledge.getTcmHerbFunctionText("白薇"), /滋阴补肾|健脾益气/);
  assert.match(knowledge.getTcmHerbFunctionText("白薇"), /清热凉血/, "对照：真功效保留");
});
await check("3.2 辛夷「疏散风热」、鹿角「息虚风」无依据；对照：薄荷疏散风热、天麻平肝息风、蝉蜕息风止痉（教材有）照留", () => {
  assert.ok(contract.herbFunctionClaimUnsupportedPhrases("辛夷疏散风热、宣通鼻窍", knowledge.herbFunctionKnowledgeForDisplay("辛夷")).includes("疏散风热"));
  assert.ok(contract.herbFunctionClaimUnsupportedPhrases("助息虚风", knowledge.herbFunctionKnowledgeForDisplay("鹿角")).length > 0);
  assert.deepEqual(contract.herbFunctionClaimUnsupportedPhrases("疏散风热", knowledge.herbFunctionKnowledgeForDisplay("薄荷")), []);
  assert.deepEqual(contract.herbFunctionClaimUnsupportedPhrases("平肝息风", knowledge.herbFunctionKnowledgeForDisplay("天麻")), []);
  assert.deepEqual(contract.herbFunctionClaimUnsupportedPhrases("息风止痉", knowledge.herbFunctionKnowledgeForDisplay("蝉蜕")), []);
});
await check("3.3 交付面：去掉无依据的词后剩下的半句也要有依据（白薇「健脾益气」不剩「健脾」）；加减理由同一判据", () => {
  const out = project(prescribe({ name: "自拟方", herbs: [{ name: "白薇", role: "臣", function: "清热凉血，滋阴补肾，健脾益气" }] },
    { formula: { candidates: [{ name: "自拟方", herbs: [{ name: "白薇", role: "臣", function: "清热凉血，滋阴补肾，健脾益气" }], formulaSource: { source: "自拟方" }, formulaAnalysis: "", decoction: { method: "水煎服" } }], patentAndWestern: [],
      modifications: [{ trigger: "流涕", action: "加", herbName: "辛夷", doseOrHandling: "6g", reason: "辛夷疏散风热、宣通鼻窍，减轻流涕。" }] } }));
  assert.equal(out.formula.candidates[0].herbs[0].function, "清热凉血");
  assert.equal(out.formula.modifications[0].reason, "宣通鼻窍，减轻流涕。");
});

// 4. 中成药。
await check("4.1 外用药的关系栏按给药途径写，不说「服用」、不套口服间隔；对照：口服药照旧", () => {
  const out = project(prescribe({ name: "自拟方" }, { formula: { candidates: [], modifications: [], patentAndWestern: [
    { type: "中成药", name: "丹皮酚软膏", route: "外用，涂敷患处", positioning: "短期对症", relationship: "" },
    { type: "中成药", name: "复方斯亚旦生发油", route: "外用", positioning: "联合治疗", relationship: "" },
    { type: "中成药", name: "参苓白术颗粒", route: "开水冲服", positioning: "联合治疗", relationship: "" },
    { type: "中成药", name: "复方珍珠口疮颗粒", route: "口服，开水溶解后分次含于口中、漱口后缓慢咽下", positioning: "短期对症", relationship: "" },
  ] } }));
  const [ointment, oil, oral, rinse] = out.formula.patentAndWestern;
  assert.equal(ointment.relationship, "症状明显时短期外用，症状缓解即停");
  assert.doesNotMatch(oil.relationship, /服用|间隔/);
  assert.equal(oral.relationship, "可与本方汤剂同期服用，两者间隔约1小时");
  assert.equal(rinse.relationship, "症状明显时短期服用，症状缓解即停", "说明书写口服的按内服写，含漱是服法的一步");
});
await check("4.2 含乙醇的药酒不给服降糖药的糖尿病患者（C045）；对照：无此记录、或不含乙醇的不排", () => {
  const wine = { name: "三两半药酒", usage: "口服。一次30～60毫升，一日3次。", precaution: "本品含乙醇（酒精）20％～25％" };
  assert.equal(patent.alcoholPreparationContraindicatedFor(wine, ["既往史：2型糖尿病，口服二甲双胍"]), "antidiabetic");
  assert.equal(patent.alcoholPreparationContraindicatedFor(wine, ["双膝疼痛"]), undefined);
  assert.equal(patent.alcoholPreparationContraindicatedFor({ name: "独活寄生丸", usage: "口服", precaution: "" }, ["口服二甲双胍"]), undefined);
  assert.match(fs.readFileSync("src/lib/local-patent-medicine-candidates.ts", "utf8"), /\.filter\(\(entry\) => !alcoholPreparationContraindicatedFor\(entry, facts\)\)/, "检索层用这一条排除");
});
await check("4.3 说明书写的是口疮、本例是鹅口疮：一长一短两个病，不算说到本例的病（m24）；对照：本例就是口疮时照算", () => {
  const label = "燥湿，生肌止痛。用于心脾湿热证口疮（复发性口腔溃疡），症见口疮，周围红肿。";
  assert.equal(patent.patentMedicineCoversMainProblem(label, { chiefComplaint: "口腔白屑3天", tcmDiseaseName: "鹅口疮", westernName: "鹅口疮", syndromes: ["心脾积热证"] }), false);
  assert.equal(patent.patentMedicineCoversMainProblem(label, { chiefComplaint: "口腔溃疡3天", tcmDiseaseName: "口疮", westernName: "复发性口腔溃疡", syndromes: ["心脾积热证"] }), true);
  assert.equal(patent.patentMedicineCoversMainProblem("清热解毒。用于小儿鹅口疮，口腔白屑。", { chiefComplaint: "口腔溃疡3天", tcmDiseaseName: "口疮", westernName: "复发性口腔溃疡", syndromes: ["心脾积热证"] }), false, "反过来：说明书写鹅口疮，本例是口疮");
});

// 5. 流派：部分适用要有该派实际改变的决定。
const lineageCase = (formula) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
  overview: { tcmDiseaseName: "痹证", primarySyndrome: "肝肾两虚证", tcmDiagnosticRationale: "温补学派看脾肾命门与阴阳互根，本例怕冷、舌淡胖属脾肾阳虚，与温养补虚方向相符，以下按常规辨证处理。" },
  lineageAdaptation: { lineageCode: "warm-tonify", label: "温补学派思路", applicable: "partial", applicabilityReason: "怕冷、舌淡胖苔白示脾肾阳虚寒湿，与温养补虚方向部分相符", influencedDecisions: [] },
  formula: { candidates: [{ name: formula, formulaNames: [formula.replace(/加减$/u, "")], herbs: H(LINEAGE_HERBS[formula.replace(/加减$/u, "")]), formulaSource: { source: "" }, formulaAnalysis: "", decoction: { method: "" } }], patentAndWestern: [], modifications: [] },
});
const LINEAGE_HERBS = {
  独活寄生汤: ["独活", "桑寄生", "杜仲", "牛膝", "细辛", "秦艽", "茯苓", "肉桂", "防风", "川芎", "人参", "甘草", "当归", "白芍", "熟地黄"],
  右归丸: ["熟地黄", "山药", "山茱萸", "枸杞子", "菟丝子", "鹿角胶", "杜仲", "肉桂", "当归", "制附子"],
};
await check("5.1 流派「部分相符」是模型的判断，交付面不按方名改判不适用、理由与辨证末句原样（总指挥撤回：按方名改判后理由与分析自相矛盾，重跑复核 C036、C043 判错）", () => {
  const input = lineageCase("独活寄生汤加减");
  const out = project(input);
  assert.equal(out.lineageAdaptation.applicable, "partial");
  assert.equal(out.lineageAdaptation.applicabilityReason, input.lineageAdaptation.applicabilityReason);
  assert.deepEqual(project(out), out);
});
await check("5.1b 对照：辨证末句是按该派视角分析、没说按常规辨证时，方名不在归属表里也照旧部分适用（第四十六轮复核 C089 丹溪治气郁、C079 经方太阴虚寒）", () => {
  const input = lineageCase("独活寄生汤加减");
  input.overview.tcmDiagnosticRationale = "温补学派看脾肾命门与阴阳互根，本例怕冷、舌淡胖属脾肾阳虚，宜温养脾肾。";
  assert.equal(project(input).lineageAdaptation.applicable, "partial");
});
await check("5.2 对照：选的是该派的方（右归丸属温补）照旧部分适用", () => {
  assert.equal(provenance.formulaNamesCarryLineage(["右归丸"], "warm-tonify"), true);
  assert.equal(project(lineageCase("右归丸加减")).lineageAdaptation.applicable, "partial");
});

// 6. 外治。
await check("6.1 未评估的乳房肿块：居家按揉的候选池与体质段落都不取膻中、期门（C069）；对照：没有时照取", () => {
  const breast = [...capabilities.BREAST_REGION_POINTS];
  const pool = authoring.homeAcupointCandidatePool({ pregnancyUnresolved: false, excludedPoints: breast }).map((point) => point.name);
  assert.ok(!pool.includes("膻中") && !pool.includes("期门") && pool.includes("太冲"));
  assert.ok(authoring.homeAcupointCandidatePool({ pregnancyUnresolved: false }).some((point) => point.name === "期门"));
  const prior = { overview: { tcmDiseaseName: "乳癖", primarySyndrome: "气滞血瘀证", primarySyndromeResolution: "resolved", secondarySyndromes: [] },
    pathogenesis: { natureDifferentiation: { items: ["血瘀"] } }, therapy: { overallPrinciple: "实则泻之", overallMethod: "活血化瘀" },
    westernDiagnosis: { primary: { name: "乳腺肿块待查" } } };
  const context = { prior, safetyGate: { status: "ready", redFlags: [], allowDosePrescription: true, candidateMode: "full_dose" }, ageYears: 40 };
  const plain = homeCare.compileHomeAcupointCare(context) || "";
  assert.match(plain, /期门/, "夹具前提：血瘀质段落取期门");
  assert.doesNotMatch(homeCare.compileHomeAcupointCare({ ...context, excludedPoints: breast }) || "", /期门|膻中/);
  const caseState = { patient: { sex: "女", age: 46 }, chiefComplaint: "发现左乳肿块2月", symptoms: { 现病史: "2月前自扪及左乳外上象限肿块，无痛，未做乳腺超声" }, conversation: [],
    safetyGate: context.safetyGate };
  const excluded = capabilities.homeCareBreastRegionExclusion(caseState);
  assert.ok(excluded.includes("期门") && excluded.includes("膻中"), JSON.stringify(excluded));
  assert.deepEqual(capabilities.homeCareBreastRegionExclusion({ ...caseState, chiefComplaint: "胃脘胀痛2周", symptoms: { 现病史: "胃脘胀痛" } }), [], "对照：没有乳房肿块");
  const src = fs.readFileSync("src/lib/tcm-treatment-capabilities.server.ts", "utf8");
  assert.equal((src.match(/excludedPoints: homeCareBreastRegionExclusion\(caseState\)/gu) || []).length, 2, "模型选穴与体质段落两处都传");
});
await check("6.2 病性栏是阴虚、虚热时卡上不说灸（rt-381760 肾精亏损证，病性阴虚、虚热内扰）；对照：病性有阳虚的不动", () => {
  assert.equal(nondrug.natureItemsForbidMoxibustion(["阴虚", "精亏", "虚热内扰"]), true);
  assert.equal(nondrug.natureItemsForbidMoxibustion(["阳虚", "阴虚"]), false);
  const text = "主穴取太溪、肾俞、听宫、翳风。太溪、肾俞可加温灸或温针灸。";
  assert.doesNotMatch(nondrug.cardSentencesMatchedToSyndrome(text, ["耳鸣耳聋"], "肾精亏损证", undefined, "补肾填精，滋耳复聪", ["阴虚", "虚热内扰"]), /灸/);
  assert.match(nondrug.cardSentencesMatchedToSyndrome(text, ["耳鸣耳聋"], "肾精亏损证", undefined, "补肾填精，滋耳复聪", []), /温灸/);
  assert.match(fs.readFileSync("src/lib/tcm-treatment-capabilities.server.ts", "utf8"), /cardSentencesMatchedToSyndrome\(value, diseaseNamesForCard, signedSyndromeText, course, prior\.therapy\?\.overallMethod \|\| "", signedNatureItems\)/, "项目卡同一道过病性栏");
});
await check("6.3 针刺卡只有「阿是穴、循经远端穴（按疼痛部位选择）」不可操作，不交付（n19）；对照：只写阿是穴的灸、拔罐卡与点名穴的卡照出", () => {
  assert.equal(capabilities.treatmentCardUndeliverable({ projectCode: "acupuncture", suggestedSitesOrPoints: ["局部阿是穴（查体确认）", "循经远端穴（按疼痛部位选择）"] }), true);
  assert.equal(capabilities.treatmentCardUndeliverable({ projectCode: "moxibustion", suggestedSitesOrPoints: ["阿是穴"] }), false);
  assert.equal(capabilities.treatmentCardUndeliverable({ projectCode: "acupuncture", suggestedSitesOrPoints: ["阿是穴", "足三里"] }), false);
  assert.equal(capabilities.treatmentCardUndeliverable({ projectCode: "acupuncture" }), false, "没有穴位栏不报错");
});
await check("6.4 痹病按部位取穴：主诉点了部位只按主诉取（足跟痛不取膝、腰的穴，n35）；对照：主诉没有部位时照旧按全部现症", () => {
  const input = (chiefComplaint) => ({ projectCode: "acupuncture", diseaseNames: ["痹证"], westernNames: [], signedSyndromeText: "肝肾两虚证", chiefComplaint,
    currentFacts: `${chiefComplaint}；伴腰膝酸软，晨起足跟疼痛加重`, patientAgeYears: 63 });
  const heel = nondrug.textbookTreatmentPlan(input("左足跟疼痛4月"));
  assert.ok(heel, "夹具前提：痹病有教材针刺方案");
  const points = heel.points.map((point) => point.name);
  assert.ok(!points.includes("膝眼") && !points.includes("腰阳关") && points.includes("昆仑"), points.join("、"));
  const vague = nondrug.textbookTreatmentPlan(input("关节疼痛4月")).points.map((point) => point.name);
  assert.ok(vague.includes("膝眼"), vague.join("、"));
});
await check("6.5 3 岁以内正看急性病时不给按月龄的健康保健段落（C079 伤食泻四神聪）", () => {
  const src = fs.readFileSync("src/lib/tcm-treatment-capabilities.server.ts", "utf8");
  assert.match(src, /ageYears <= 3 && caseCourse\(\[prior\.westernDiagnosis\?\.primary\?\.name \|\| ""\], String\(caseState\.chiefComplaint \|\| ""\)\) === "acute"\) return null;/);
  assert.equal(nondrug.caseCourse([], "稀便3次伴腹胀1天"), "acute");
});

// 7. 中医鉴别。
await check("7.1 本病所属的那一类、合称、两个病连写不作鉴别：紫癜不列血证（n25）、耳聋不列耳鸣耳聋（C057）、「子宫内膜异位症与子宫腺肌病」（n22）；对照：时行感冒照留", () => {
  assert.equal(differential.resolveTcmDiseaseDifferentialName("血证", "紫癜").action, "drop");
  assert.equal(differential.resolveTcmDiseaseDifferentialName("耳鸣耳聋", "耳聋").action, "drop");
  assert.equal(differential.resolveTcmDiseaseDifferentialName("子宫内膜异位症与子宫腺肌病", "癥瘕").action, "drop");
  assert.equal(differential.resolveTcmDiseaseDifferentialName("时行感冒", "感冒").action, "keep");
  assert.notEqual(differential.resolveTcmDiseaseDifferentialName("胃痛", "腹痛").action, "drop");
});

// 8. 西医病名细节。
await check("8.1 慢性肾脏病分期按本次 eGFR 改（17 → 4 期，n40），名、依据各栏同一口径；对照：eGFR 12 仍 5 期、写透析的不动", () => {
  assert.equal(surface.recordCkdStage("现eGFR 17ml/(min·1.73m²)，肌酐286μmol/L", 78), "4");
  assert.equal(surface.recordCkdStage("现eGFR 12", 78), "5");
  assert.equal(surface.recordCkdStage("eGFR 12，规律血液透析", 78), undefined);
  const out = project({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: {}, westernDiagnosis: {
    primary: { name: "慢性肾脏病5期伴高钾血症", clinicalRationale: "现eGFR 17，符合CKD5期", supportingFacts: [], limitations: [], suggestedChecks: [] }, candidates: [], differentials: [] } },
    { recordText: "既往糖尿病肾病。现eGFR 17ml/(min·1.73m²)，血钾5.7mmol/L", herbBoundaryAudience: { reproductive: false, ageYears: 78 } });
  assert.equal(out.westernDiagnosis.primary.name, "慢性肾脏病4期伴高钾血症");
  assert.match(out.westernDiagnosis.primary.clinicalRationale, /CKD4期/);
});
await check("8.2 按病程改名：去掉「慢性」只剩笼统器官名时写「慢性X待查」（C036 肾脏病）；依据里「按病程归为慢性X」随新病名改（C052）", () => {
  assert.equal(western.deterministicWesternNameCorrection("慢性肾脏病", "主诉：双下肢水肿1个月", 69)?.supportedName, "慢性肾脏病待查");
  assert.equal(western.deterministicWesternNameCorrection("慢性荨麻疹", "主诉：反复风团瘙痒2周", 36)?.supportedName, "急性荨麻疹");
  assert.equal(alignment.rationaleAlignedWithCourseRename("符合荨麻疹特征；病程已达2周，按病程归为慢性荨麻疹，需核实诱因", "慢性荨麻疹", "急性荨麻疹", "病程未满6周"),
    "符合荨麻疹特征；病程已达2周，按病程（未满6周）属急性荨麻疹，需核实诱因");
  const correction = western.deterministicWesternNameCorrection("慢性荨麻疹", "主诉：反复风团瘙痒2周", 36);
  const applied = JSON.parse(western.applyWesternNameCorrection(JSON.stringify({ westernDiagnosis: { primary: { name: "慢性荨麻疹", clinicalRationale: "病程已达2周，按病程归为慢性荨麻疹" }, candidates: [], differentials: [] } }), correction));
  assert.equal(applied.westernDiagnosis.primary.clinicalRationale, "病程已达2周，按病程（未满6周）属急性荨麻疹");
});
await check("8.3 儿童写「功能性腹痛」按罗马IV儿童 2 个月门槛查得到；不给成人门槛（C073）", () => {
  const entry = criteria.westernCriteriaEntry("功能性腹痛");
  assert.equal(entry?.courseThresholdDays?.under18, 60);
  assert.equal(entry?.courseThresholdDays?.adult, undefined);
  assert.match(entry?.durationThreshold || "", /2个月/);
});

// 9. 中医病名：西医节名按教材写的中医归属交付；OCR 与断行的节名订正。
await check("9.1 西医节名交付中医病名：流行性腮腺炎→痄腮、流行性乙型脑炎→暑温、营养性缺铁性贫血→虚劳（m27、m40、m25）", () => {
  assert.equal(terminology.textbookSectionDeliveryName("流行性腮腺炎"), "痄腮");
  assert.equal(terminology.textbookSectionDeliveryName("流行性乙型脑炎"), "暑温");
  assert.equal(terminology.textbookSectionDeliveryName("营养性缺铁性贫血"), "虚劳");
  assert.equal(terminology.textbookSectionDeliveryName("性早熟"), "性早熟", "节内没写中医归属的照旧");
});
await check("9.2 节名订正：大行赤眼即天行赤眼（m38），「巴细胞升高」是猩红热一节断行；按虚劳查不到儿科贫血一节", () => {
  const names = JSON.parse(fs.readFileSync("src/data/tcm-textbook-disease-names.json", "utf8")).names;
  assert.ok(names.includes("天行赤眼") && !names.includes("大行赤眼") && !names.includes("巴细胞升高") && names.includes("猩红热"));
  assert.ok(textbook.textbookRowForSyndrome("天行赤眼", "疠气犯目证"), "天行赤眼一节的证型查得到");
  assert.ok(textbook.textbookRowForSyndrome("猩红热", "邪侵肺卫证") || textbook.textbookRowForSyndrome("猩红热", "邪侵肺卫"), "猩红热一节的证型查得到");
  assert.equal(textbook.textbookRowForFormula("虚劳", ["归脾汤"], "心脾气血两虚证", { sameDiseaseOnly: true }), undefined);
});

console.log(JSON.stringify({ suite: "r1063-text", failures }));
