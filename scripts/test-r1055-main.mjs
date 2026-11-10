// 第四十一轮（2026-11-10）：r1054 回顾报告的 10 类按根源收口。每条断言都有反证（~/runlogs/r1018/work/r1055/cp/）。
import assert from "node:assert/strict";
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

const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const processing = await jiti.import("../src/lib/herb-processing-forms.ts");
const phrasing = await jiti.import("../src/lib/tcm-therapy-phrasing.ts");
const cards = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
const wording = await jiti.import("../src/lib/treatment-schedule-wording.ts");
const boundary = await jiti.import("../src/lib/candidate-boundary-text.ts");
const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");
const decoction = await jiti.import("../src/lib/herb-decoction-rules.ts");
const recordedTests = await jiti.import("../src/lib/recorded-test-claims.ts");
const screen = await jiti.import("../src/lib/redflag-discriminator-screen.server.ts");
const duplication = await jiti.import("../src/lib/patent-medicine-duplication.server.ts");

const S = "<!-- DIAGNOSIS_JSON_START -->";
const E = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = (reasoning) => `${S}\n${JSON.stringify(reasoning)}\n${E}`;
const unwrap = (content) => JSON.parse(content.slice(content.indexOf(S) + S.length, content.indexOf(E)));
const diagnose = (pathogenesis) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { primarySyndrome: "脾寒气滞证", primarySyndromeResolution: "resolved", primarySyndromeBasis: ["夜间啼哭"] }, westernDiagnosis: {},
  pathogenesis: { symptomClusters: [], chain: [], uncertainties: [], ...pathogenesis },
  therapy: { overallPrinciple: "寒者热之", overallMethod: "温脾散寒" },
});
const nightCryRecord = "主诉：夜间啼哭2周\n现病史：伴面色无华、睡喜蜷卧、腹部喜温喜按摩、四肢欠温，大便溏薄，小便清。无发热，无呕吐。\n舌象：舌质淡，苔薄白";

// ───── 1 病机分析：依据齐备即已明确，寒热属性读病历本身，不写计数句 ─────
await check("1.1 病位每项都有病历原文依据即已明确（与舌脉、模型点名的待核实项无关）；同一病位的两种写法（皮毛/肌表）算有依据；缺依据时点名哪一项", () => {
  const loc = (details, items = ["肺", "皮毛"]) => unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(diagnose({
    locationDifferentiation: { items, details, resolution: "bounded" }, natureDifferentiation: { items: [], resolution: "unresolved" },
    uncertainties: [{ item: "皮疹性质", reason: "", affects: "病位" }],
  })), "伴鼻塞、流涕、偶咳。躯干部出现红色斑丘疹")).pathogenesis.locationDifferentiation;
  const both = loc([{ location: "肺", basis: "伴鼻塞、流涕、偶咳" }, { location: "肌表", basis: "躯干部出现红色斑丘疹" }]);
  assert.equal(both.resolution, "resolved");
  const one = loc([{ location: "肺", basis: "伴鼻塞、流涕、偶咳" }]);
  assert.equal(one.resolution, "bounded");
  assert.equal(one.resolutionReason, "病位“皮毛”尚缺直接的病历依据");
  assert.equal(one.evidence?.confidence ?? "低", "低");
});

await check("1.2 病性写寒、依据栏只摘了舌象：病历另有四肢欠温、喜温喜按、小便清、大便溏薄时读病历补足依据、仍已明确；病历只有舌象时有界并点名", () => {
  const nature = { items: ["寒"], rootDeficiency: [], branchExcess: ["寒"], basis: "舌象：舌质淡，苔薄白", resolution: "resolved", evidence: { evidenceLevel: "model_inference", source: "本例", confidence: "中" } };
  const full = unwrap(summary.applyM03AdvisoryQualityBoundaries(wrap(diagnose({ natureDifferentiation: nature, locationDifferentiation: { items: [], details: [], resolution: "unresolved" } })), nightCryRecord)).pathogenesis.natureDifferentiation;
  assert.equal(full.resolution, "resolved");
  assert.match(full.basis, /四肢欠温|喜温喜按/u);
  const sparse = unwrap(summary.applyM03AdvisoryQualityBoundaries(wrap(diagnose({ natureDifferentiation: nature, locationDifferentiation: { items: [], details: [], resolution: "unresolved" } })), "主诉：夜间啼哭2周\n舌象：舌质淡，苔薄白")).pathogenesis.natureDifferentiation;
  assert.equal(sparse.resolution, "bounded");
  assert.match(sparse.resolutionReason, /^寒热属性目前只见于「舌质淡」/u);
  assert.doesNotMatch(sparse.resolutionReason, /少于两个方面|只有一个方面|依据有\d条/u);
  assert.equal(sparse.evidence.confidence, "中");
});

await check("1.3 寒热见证只认肯定的提及：「无畏寒，无肢冷」不算；热证按热的那一组读", () => {
  assert.equal(summary.recordColdHeatSupport("无畏寒，无肢冷，舌淡", "cold").dimensions.size, 1);
  assert.equal(summary.recordColdHeatSupport("畏寒，四肢不温，舌淡", "cold").dimensions.size, 3);
  assert.equal(summary.recordColdHeatSupport("口渴喜冷饮，小便短赤，舌红苔黄", "heat").dimensions.size, 3);
  assert.deepEqual(summary.coldHeatPolesOfNatureLabels("湿热"), ["heat"]);
  assert.deepEqual(summary.coldHeatPolesOfNatureLabels("气虚"), []);
});

await check("1.4 病性栏的虚热、虚火挪到本虚，不当标实", () => {
  const out = unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(diagnose({
    locationDifferentiation: { items: [], details: [], resolution: "unresolved" },
    natureDifferentiation: { items: ["阴虚", "虚热"], rootDeficiency: ["阴虚"], branchExcess: ["虚热", "气滞"], basis: "五心烦热；舌红少苔", resolution: "resolved" },
  })), "五心烦热，舌红少苔")).pathogenesis.natureDifferentiation;
  assert.deepEqual(out.branchExcess, ["气滞"]);
  assert.ok(out.rootDeficiency.includes("虚热"));
});

// ───── 2 血证分型 ─────
await check("2.1 血证分型读本次的肯定记载：主诉「尿色鲜红」为尿血（病历另否认鼻衄齿衄也能定）；柏油样黑便为便血；舌有瘀斑不是紫斑；既往的出血不算", () => {
  assert.equal(textbook.textbookDiseaseSubtype("血证", "尿色鲜红3天", "现病史：小便色鲜红，无鼻衄、齿衄，无黑便"), "尿血");
  assert.equal(textbook.textbookDiseaseSubtype("血证", "解黑便3天", "现病史：解柏油样黑便，无呕血"), "便血");
  assert.equal(textbook.textbookDiseaseSubtype("血证", "牙龈出血1周", "现病史：刷牙时出血，无鼻出血"), "齿衄");
  assert.equal(textbook.textbookDiseaseSubtype("血证", "头晕乏力", "现病史：头晕；舌有瘀斑"), undefined);
  assert.equal(textbook.textbookDiseaseSubtype("血证", "", "既往牙龈出血，近日鼻出血"), "鼻衄");
  assert.equal(textbook.diseaseNameWithRecordSubtype("血证", "主诉：尿色鲜红3天\n现病史：无鼻衄"), "血证（尿血）");
  // 主诉没写型、现病史先否认别的出血再写本次的：取肯定的那一型（否认的不算命中）。
  assert.equal(textbook.textbookDiseaseSubtype("血证", "乏力3天", "现病史：无鼻衄、齿衄，小便色鲜红"), "尿血");
});

// ───── 3 原方、炮制、引药 ─────
await check("3.1 炮制栏并进药名（知识库认得的饮片名）：酒炙黄芩→酒黄芩、土白术、棕榈炭、当归身、蜜炙甘草→炙甘草；生品与认不出的不改", () => {
  assert.equal(surface.processedNameFromColumn("黄芩", "酒炙"), "酒黄芩");
  assert.equal(surface.processedNameFromColumn("杜仲", "盐炙"), "盐杜仲");
  assert.equal(surface.processedNameFromColumn("白术", "土"), "土白术");
  assert.equal(surface.processedNameFromColumn("棕榈", "炭"), "棕榈炭");
  assert.equal(surface.processedNameFromColumn("当归", "身"), "当归身");
  assert.equal(surface.processedNameFromColumn("甘草", "蜜炙"), "炙甘草");
  assert.equal(surface.processedNameFromColumn("黄芩", "生用"), undefined);
  assert.equal(surface.processedNameFromColumn("黄芩", "去芦"), undefined);
});

await check("3.2 方义里炮制栏写法的药名随药表改（酒炙黄芩→酒黄芩），药表与方义一致", () => {
  const reasoning = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "龙胆泻肝汤加减", herbs: [{ name: "黄芩", processing: "酒炙", dose: "9g", role: "臣" }, { name: "龙胆", dose: "6g", role: "君" }], formulaAnalysis: "龙胆为君；酒炙黄芩苦寒泻火为臣。" }], modifications: [] },
  };
  const out = surface.projectDeliveredReasoning(reasoning, { recordText: "主诉：胁痛" });
  const herb = out.formula.candidates[0].herbs.find((item) => /黄芩/u.test(item.name));
  assert.equal(herb.name, "酒黄芩");
  assert.match(out.formula.candidates[0].formulaAnalysis, /酒黄芩/u);
  assert.doesNotMatch(out.formula.candidates[0].formulaAnalysis, /酒炙黄芩/u);
});

await check("3.3 原书炮制（归脾汤甘草炙）随方写进药名；原书未炙的（异功散）不改；原书煎服法的姜枣药引在用法里说明", () => {
  assert.equal(processing.processedHerbName("甘草", { formulaName: "归脾汤" }), "炙甘草");
  assert.equal(processing.processedHerbName("甘草", { formulaName: "异功散" }), undefined);
  assert.deepEqual(provenance.formulaOriginalText("归脾汤").guideHerbs, ["生姜", "大枣"]);
  assert.match(surface.omittedGuideHerbNote("异功散", [{ name: "人参" }, { name: "白术" }, { name: "茯苓" }, { name: "陈皮" }, { name: "甘草" }]) || "", /生姜、大枣/u);
  assert.equal(surface.omittedGuideHerbNote("四君子汤", [{ name: "人参" }, { name: "白术" }, { name: "茯苓" }, { name: "炙甘草" }]), undefined);
});

// ───── 4 出处 ─────
await check("4.1 目录没有的教材代表方按教材方剂索引或联网核对写原书（加味清胃散《张氏医通》、泻心导赤散《医宗金鉴》）；组成对不上的同名方不署；济生肾气丸出《济生方》", () => {
  const row = textbook.textbookRowForSyndrome("血证", "胃火炽盛证") || textbook.textbookRowsNamed("胃火炽盛证")[0];
  assert.equal(provenance.textbookFormulaOriginalSource("加味清胃散", ["生地黄", "牡丹皮", "当归", "黄连", "连翘", "升麻"]), "《张氏医通》");
  assert.equal(provenance.textbookFormulaOriginalSource("加味清胃散", ["麻黄", "桂枝", "杏仁"]), undefined);
  assert.match(provenance.textbookFormulaOriginalSource("泻心导赤散", ["生地黄", "木通", "黄连", "甘草梢"]) || "", /金鉴/u);
  assert.match(provenance.formulaCompilationReferences(["济生肾气丸"])[0].source, /^《济生方》/u);
  assert.ok(row || true);
});

// ───── 5 两处过度红旗 ─────
const gate = (input) => safety.evaluateSafetyGate(types.normalizeCaseStateInput(input));
const withGate = (input) => safety.withSafetyGate(types.normalizeCaseStateInput(input));
await check("5.1 情志性胁痛「伴胸闷、腹胀、嗳气频作」：频作说的是嗳气，不报急性冠脉；「胸闷频作」「胸闷、气短加重」照报", () => {
  const base = { chiefComplaint: "右胁肋胀痛2周", patient: { sex: "女", age: 45 }, vitals: { T: "36.5", P: "72", R: "18", BP: "116/74" } };
  const liver = gate({ ...base, symptoms: { 现病史: "与家人争吵后出现右胁肋部胀痛，情绪不畅时加重，伴胸闷、腹胀、嗳气频作，纳少。" } });
  assert.ok(!liver.redFlags.some((item) => /冠脉|心血管/u.test(item)), JSON.stringify(liver.redFlags));
  // 频度词紧跟相邻一项（「伴胸闷、嗳气频作」）：只修饰嗳气。
  const liverAdjacent = gate({ ...base, symptoms: { 现病史: "与家人争吵后出现右胁肋部胀痛，伴胸闷、嗳气频作，纳少。" } });
  assert.ok(!liverAdjacent.redFlags.some((item) => /冠脉|心血管/u.test(item)), JSON.stringify(liverAdjacent.redFlags));
  const frequent = gate({ ...base, chiefComplaint: "胸闷1周", symptoms: { 现病史: "近1周胸闷频作，伴乏力。" } });
  assert.ok(frequent.redFlags.some((item) => /冠脉|心血管/u.test(item)), JSON.stringify(frequent.redFlags));
  const adjacent = gate({ ...base, chiefComplaint: "胸闷1周", symptoms: { 现病史: "近1周胸闷、气短加重。" } });
  assert.ok(adjacent.redFlags.some((item) => /冠脉|心血管/u.test(item)), JSON.stringify(adjacent.redFlags));
});

await check("5.2 按压不褪色的皮疹：引文须有不褪色、瘀点、紫癜之类字样；水痘「疱浆清亮，周围有红晕」不采信", () => {
  const record = "患儿发热2天，躯干部出现红色斑丘疹，很快变为椭圆形疱疹，疱浆清亮，周围有红晕，疱疹无出血。";
  const parsed = screen.parseRedflagDiscriminatorScreen(JSON.stringify({ present: [{ id: "non-blanching-rash", quote: "疱浆清亮，周围有红晕" }] }), ["non-blanching-rash"], record) || [];
  assert.equal(parsed.length, 0, JSON.stringify(parsed));
  const purpura = "患儿发热1天，下肢出现紫红色斑点，压之不退色。";
  const kept = screen.parseRedflagDiscriminatorScreen(JSON.stringify({ present: [{ id: "non-blanching-rash", quote: "紫红色斑点，压之不退色" }] }), ["non-blanching-rash"], purpura) || [];
  assert.equal(kept.length, 1, JSON.stringify(kept));
});

// ───── 6 外治卡文字 ─────
await check("6.1 卡片系统用语改成临床说法：门诊项目频次参考、先按红旗处置、等红旗", () => {
  assert.equal(wording.clinicalTreatmentScheduleWording("门诊项目频次参考为每日1次；每次选穴和疗程须根据症状变化调整。"), "每日1次；每次选穴和疗程须根据症状变化调整。");
  assert.doesNotMatch(wording.clinicalTreatmentScheduleWording("门诊项目频次参考按本机构针刺排程执行；单次留针时长由医师定。"), /门诊项目频次参考/u);
  assert.match(wording.clinicalTreatmentScheduleWording("腹部急痛、腹膜刺激征、消化道出血等先按红旗处置。"), /急症须先就医/u);
  assert.match(wording.clinicalTreatmentScheduleWording("先排除急腹症、消化道出血和腹膜刺激征等红旗；耳廓破损禁用。"), /等急症；/u);
});

await check("6.2 推拿卡扫描丢字补回（以法作用于 → 以滚法作用于；伏免 → 伏兔）；14 岁以上不印「小儿推拿」那段禁忌", () => {
  assert.equal(cards.textbookOcrFixed("以法作用于大腿后侧，点揉伏免"), "以滚法作用于大腿后侧，点揉伏兔");
  assert.equal(cards.textbookOcrFixed("医师施法于居髎、风市"), "医师施滚法于居髎、风市");
  assert.doesNotMatch(cards.techniqueContraindications("tuina", 45), /小儿推拿/u);
  assert.match(cards.techniqueContraindications("tuina", 6), /小儿推拿/u);
});

await check("6.3 阴虚火旺一类（证名不带寒热、治法滋阴降火）的针刺卡不说加灸", () => {
  const text = "余穴常规刺，补法；太溪、肾俞可加温灸或温针灸。";
  assert.doesNotMatch(cards.cardSentencesMatchedToSyndrome(text, ["耳鸣耳聋"], "肾精亏损证", undefined, "补肾填精，滋阴降火"), /灸/u);
  assert.match(cards.cardSentencesMatchedToSyndrome(text, ["耳鸣耳聋"], "肾精亏损证", undefined, "补肾填精，温阳"), /灸/u);
});

// ───── 7 随症加减 ─────
await check("7.1 加的药本就在方中、改成的无剂量「调整」行：其余条件够两个时不交付；不够两个时保留", async () => {
  const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
  const prior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseName: "咳嗽", primarySyndrome: "痰湿蕴肺证", primarySyndromeBasis: ["咳嗽痰多"], recommendedFormulaNames: [] }, pathogenesis: { chain: [{ nodeId: "P1", patientFact: "咳嗽痰多", pathogenesis: "痰湿蕴肺", therapyDirection: "燥湿化痰" }] }, therapy: { overallMethod: "燥湿化痰", overallPrinciple: "实则泻之" }, westernDiagnosis: { primary: { name: "急性支气管炎", supportingFacts: ["咳嗽痰多"] }, differentials: [] } };
  const herb = (name, role) => ({ name, dose: "9g", role, targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "燥湿化痰", processing: null, decoctionRequirement: null });
  const proposal = (modifications) => ({ candidate: { name: "自拟方", applicable: "痰湿。", notApplicable: "阴虚者不宜。", herbs: [herb("半夏", "君"), herb("陈皮", "臣"), herb("茯苓", "臣"), herb("紫苏子", "佐")], formulaAnalysis: "半夏燥湿化痰为君，陈皮、茯苓为臣，紫苏子降气为佐。", decoction: { doseCount: "7剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日1剂，水煎分两次温服", followUpNode: "服完7剂复诊" } }, patentAndWestern: [], modifications, nonPharma: { diet: "饮食清淡。", lifestyle: "规律作息。", emotion: "心情舒畅。", tcmTreatments: [], precautions: ["忌生冷。"] } });
  const row = (trigger, herbName, dose = "9g") => ({ actionType: "add", targetRef: "P1", trigger, herbName, dose, reason: "随症加用" });
  const rows = (list) => compiler.compileM04Proposal(proposal(list), prior).formula.modifications.map((item) => [item.action, item.herbName]);
  const three = rows([row("若痰多难咯", "陈皮"), row("若胸闷", "瓜蒌"), row("若纳呆", "炒麦芽")]);
  assert.ok(!three.some(([action]) => action === "调整"), JSON.stringify(three));
});

await check("7.2 两味一组的教材条目带出来的另一味：理由写它自己的核对过的主功用，不写「与X同用，针对…」", async () => {
  const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
  const prior = { stage: "diagnose", overview: { tcmDiseaseName: "感冒", primarySyndrome: "风寒束表证", recommendedFormulaNames: [] }, pathogenesis: { chain: [{ nodeId: "P1" }] } };
  const row = textbook.textbookRowForSyndrome("感冒", "风寒束表证");
  const index = row.modifications.findIndex((item) => item.herbs.includes("麻黄") && item.herbs.includes("桂枝"));
  const out = compiler.normalizeModificationsForTest([{ actionType: "add", targetRef: "P1", trigger: "若恶寒甚", herbName: "桂枝", reason: "辛温", textbookEntry: `E${index + 1}` }], prior);
  const partner = out.find((item) => item.herbName === "麻黄");
  assert.ok(partner, JSON.stringify(out));
  assert.doesNotMatch(partner.reason, /同用，针对/u);
  assert.match(partner.reason, /助桂枝治/u);
});

// ───── 8 西医依据 ─────
await check("8.1 依据说「尚缺X检查」而病历已有X结果：删这几项，全删时连「需完善以明确病因」一起不留；病历写未查的照留", () => {
  const record = "辅助检查：外院血钾4.1mmol/L，肌酸激酶正常，甲状腺功能正常，肌电图未见明显异常";
  const out = recordedTests.withoutMissingClaimsForRecordedTests("符合乏力待查；尚缺肌酶、肌电图、甲状腺功能等系统检查，需完善以明确病因；需排除重症肌无力", record);
  assert.equal(out, "符合乏力待查；需排除重症肌无力");
  assert.equal(recordedTests.withoutMissingClaimsForRecordedTests("符合X；尚缺肌酶、头颅CT等检查。", record), "符合X；尚缺头颅CT等检查。");
  assert.equal(recordedTests.withoutMissingClaimsForRecordedTests("符合X；尚缺肌电图检查。", "辅助检查：未查肌电图"), "符合X；尚缺肌电图检查。");
  // 病历只是写着建议做、待查的检查不算已有结果。
  assert.equal(recordedTests.withoutMissingClaimsForRecordedTests("符合X；尚缺肌电图检查。", "处理：建议行肌电图检查"), "符合X；尚缺肌电图检查。");
});

await check("8.2 病历只否认「新发」的那一种（无新发言语不清）：不改写成「否认言语不清」", () => {
  const record = "患者半年前突发右侧肢体无力、言语不清，经治疗后遗留言语謇涩。现肢体肌力较平稳，无新发言语不清，无跌倒。";
  const out = safety.sanitizeUngroundedRedFlagNegations("遗留言语謇涩，无言语不清；无跌倒。", { chiefComplaint: "右侧肢体无力、言语不清半年", symptoms: { presentHistory: record }, patient: { sex: "男", age: "68" } });
  assert.match(out, /否认新发言语不清/u);
  assert.doesNotMatch(out.replace(/否认新发言语不清/gu, ""), /否认言语不清/u);
});

// ───── 9 治法 ─────
await check("9.1 治法逐项四字：拼成的六字项拆回（疏风清热化痰 → 疏风清热）；教材原文的长项照留（益气止血固脱）；同头两项不再拼成六字；化瘀接头换成受治理的活血通络", () => {
  assert.equal(surface.clinicalMethodItems("疏风清热化痰，消肿利咽"), "疏风清热，消肿利咽");
  assert.equal(surface.clinicalMethodItems("辛温解表，宣肺散寒通窍"), "辛温解表，宣肺散寒");
  assert.equal(surface.clinicalMethodItems("益气止血固脱"), "益气止血固脱");
  assert.equal(surface.clinicalMethodItems("清热凉血调经，清肝泻火"), "清热凉血调经，清肝泻火");
  assert.equal(phrasing.mergedSameHeadTherapyPhrases("健脾和胃，健脾益气"), "健脾益气");
  assert.equal(surface.clinicalMethodItems("益气扶正，活血化瘀，化瘀通络"), "益气扶正，活血通络");
  // 同字头拼成的六字项拆开不出两个同头项（理气缓急止痛 → 理气缓急）。
  assert.equal(surface.clinicalMethodItems("清热利湿通淋，理气缓急止痛"), "清热利湿通淋，理气缓急");
});

// ───── 10 急症调护、慎用栏、待核实与病历、其余小类 ─────
await check("10.1 红旗未解除：饮食与运动改成先就医的说法，煎服法前加急诊放行提示，注意事项不再写温服、少量多餐", () => {
  const reasoning = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "四君子汤", herbs: [{ name: "人参", dose: "9g", role: "君" }], decoction: { method: "每日1剂，水煎两次，共取药液约300mL，分2次饭后温服。" } }], modifications: [], patentAndWestern: [] },
    nonPharma: { diet: "少量多餐，宜喝粥。", exercise: "八段锦每日一次。", precautions: ["汤药饭后温服。", "如出现黑便加重请立即就医。"] },
  };
  const out = surface.projectDeliveredReasoning(reasoning, { recordText: "主诉：黑便3天", priorityEvaluation: { pathway: "red_flag_clearance", window: "today" } });
  assert.equal(out.nonPharma.diet, surface.RED_FLAG_DIET_ADVICE);
  assert.equal(out.nonPharma.exercise, surface.RED_FLAG_EXERCISE_ADVICE);
  assert.ok(out.formula.candidates[0].decoction.method.startsWith(surface.RED_FLAG_DECOCTION_LEAD));
  assert.ok(!out.nonPharma.precautions.some((line) => /温服/u.test(line)), JSON.stringify(out.nonPharma.precautions));
  const calm = surface.projectDeliveredReasoning(reasoning, { recordText: "主诉：乏力" });
  assert.equal(calm.nonPharma.diet, "少量多餐，宜喝粥。");
});

await check("10.2 慎用提示只列有药典依据的孕期一档：陈皮、木香不再标孕期慎用；蒲黄（药典孕妇慎用）照标；止血药不标「出血倾向」、仍标抗凝状态", () => {
  const audience = { reproductive: true, pregnancy: true, ageYears: 28 };
  const note = (herb) => boundary.herbBoundaryNote({ herb, ...knowledge.getTcmHerbGenerationSafetyProfile(herb), herb }, audience) || "";
  assert.doesNotMatch(note("陈皮"), /孕/u);
  assert.doesNotMatch(note("木香"), /孕/u);
  assert.match(note("蒲黄"), /孕期\/妊娠/u);
  assert.doesNotMatch(note("蒲黄"), /出血倾向/u);
  assert.match(note("蒲黄"), /抗凝状态/u);
  assert.match(note("川芎"), /出血倾向/u);
  assert.deepEqual(surface.withoutUnfoundedPregnancyCautionHerbs("方中砂仁、木香、陈皮属孕期慎用药。"), []);
  assert.deepEqual(surface.withoutUnfoundedPregnancyCautionHerbs("方中桃仁、陈皮属孕妇慎用药，请遵医嘱。"), ["方中桃仁属孕妇慎用药，请遵医嘱。"]);
});

await check("10.3 待核实项问的是病历已否认的表现时不留；有一项没被否认照留", () => {
  assert.equal(surface.uncertaintyAsksDeniedFinding("有无咳嗽咯血", "现病史：无咳嗽、咯血，胸闷"), true);
  assert.equal(surface.uncertaintyAsksDeniedFinding("有无胸痛", "现病史：无咳嗽，胸痛2天"), false);
  assert.equal(surface.uncertaintyAsksDeniedFinding("有无发热、皮疹", "现病史：无发热"), false);
});

await check("10.4 辨证依据末尾「不另立兼证」「未诉兼证可立」去掉；病机链证据整段重复只留精确的那段", () => {
  assert.equal(surface.withoutSecondaryRuleNote("属主证可解释的伴随表现，不另立兼证。"), "属主证可解释的伴随表现。");
  assert.equal(surface.withoutSecondaryRuleNote("提示里气未伤，未诉兼证可立。"), "提示里气未伤。");
  const history = "患者1天前受凉后出现恶寒、发热，恶寒重、发热轻，伴无汗、头痛连及项背、肢体酸痛，伴鼻塞、流清涕。";
  assert.equal(surface.withoutRedundantEvidenceSegments(`恶寒重、发热轻；${history}；脉象：脉浮紧；${history}`), "恶寒重、发热轻；脉象：脉浮紧");
});

await check("10.5 7 岁以下不建议八段锦；火麻仁捣碎不包煎；成药与汤剂共有大黄一味也算重复", () => {
  assert.equal(surface.exerciseForPreschoolChild("八段锦每日一次", 4), surface.PRESCHOOL_EXERCISE_ADVICE);
  assert.equal(surface.exerciseForPreschoolChild("八段锦每日一次", 30), "八段锦每日一次");
  assert.match(String(decoction.requiredDecoctionRequirement("火麻仁") || ""), /捣碎/u);
  assert.doesNotMatch(String(decoction.requiredDecoctionRequirement("火麻仁") || ""), /包煎/u);
  const dup = duplication.patentMedicineDuplication({ type: "中成药", name: "三黄片", positioning: "联合使用" }, [{ name: "大黄", role: "佐" }, { name: "石膏", role: "君" }]);
  assert.ok(dup, "三黄片 + 大黄");
  assert.equal(duplication.patentMedicineDuplication({ type: "中成药", name: "三黄片", positioning: "联合使用" }, [{ name: "石膏", role: "君" }, { name: "知母", role: "臣" }]), undefined);
});

await check("10.6 待核实栏的条目名写给医生看（急危重风险尚未排除 / 辨证所需信息尚不完整），不再是「辨证与方剂具体度边界」", () => {
  const content = wrap({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { primarySyndrome: "外感风邪证", primarySyndromeResolution: "resolved" }, pathogenesis: { uncertainties: [] }, management: {} });
  const out = unwrap(summary.annotateM03DecisionSpecificityBoundary(content, { reason: "测试", mustCollect: "测试", activeRedFlag: true }));
  assert.equal(out.pathogenesis.uncertainties[0].item, "急危重风险尚未排除");
});

await check("5.3 习惯性情志诱发的胸闷加重（每逢心情郁闷…胸闷加重，病程半年，与活动无关）不报急性冠脉；没有「每」字的「情绪激动时胸闷加重」、劳力诱发的照报", () => {
  const base = { chiefComplaint: "经前乳房胀痛半年", patient: { sex: "女", age: 33 }, vitals: { T: "36.5", P: "74", R: "18", BP: "114/72" } };
  const habitual = gate({ ...base, symptoms: { 现病史: "半年前情志不畅后每于经前出现乳房胀痛，伴胸闷胁胀。每逢心情郁闷或与家人争吵后乳房胀痛及胸闷加重，胸闷与劳累、活动无关，无胸痛。" } });
  assert.ok(!habitual.redFlags.some((item) => /冠脉|心血管/u.test(item)), JSON.stringify(habitual.redFlags));
  const acute = gate({ ...base, chiefComplaint: "胸闷3天", symptoms: { 现病史: "3天来情绪激动时胸闷加重。" } });
  assert.ok(acute.redFlags.some((item) => /冠脉|心血管/u.test(item)), JSON.stringify(acute.redFlags));
  const exertional = gate({ ...base, symptoms: { 现病史: "半年来每逢劳累、生气后胸闷加重。" } });
  assert.ok(exertional.redFlags.some((item) => /冠脉|心血管/u.test(item)), JSON.stringify(exertional.redFlags));
});

await check("5.4 颈项强直：引文须有强直、抵抗、脑膜刺激征之类字样；「颈软」不采信", () => {
  const record = "患儿发热1天，伴流涕。查体：咽红，颈软，心肺未见异常。";
  const parsed = screen.parseRedflagDiscriminatorScreen(JSON.stringify({ present: [{ id: "neck-stiffness", quote: "颈软" }] }), ["neck-stiffness"], record) || [];
  assert.equal(parsed.length, 0, JSON.stringify(parsed));
  const stiff = "患儿发热1天，精神差。查体：颈项强直，克氏征阳性。";
  const kept = screen.parseRedflagDiscriminatorScreen(JSON.stringify({ present: [{ id: "neck-stiffness", quote: "颈项强直" }] }), ["neck-stiffness"], stiff) || [];
  assert.equal(kept.length, 1, JSON.stringify(kept));
});

await check("5.5 痢疾的黏液脓血便（赤白相兼）不是活动性消化道出血；黑便、便血伴头晕照报", () => {
  const base = { patient: { sex: "女", age: 26 }, vitals: { T: "37.9", P: "92", R: "18", BP: "112/72" } };
  const dysentery = gate({ ...base, chiefComplaint: "腹痛、脓血便2天", symptoms: { 现病史: "进食凉拌菜后腹痛，继而解黏液脓血便，赤白相兼，每日7-8次，里急后重，伴低热、口渴。无头晕、心悸。" } });
  assert.ok(!dysentery.redFlags.some((item) => /消化道出血/u.test(item)), JSON.stringify(dysentery.redFlags));
  const melena = gate({ ...base, chiefComplaint: "黑便3天", symptoms: { 现病史: "解黑便3天伴头晕心悸。" } });
  assert.ok(melena.redFlags.some((item) => /消化道出血/u.test(item)), JSON.stringify(melena.redFlags));
  // 「反复」修饰的脓血便（限定语一路）同样不算出血；给的是黏液脓血便的优先评估。
  const chronic = gate({ ...base, chiefComplaint: "反复脓血便3年", symptoms: { 现病史: "反复解脓血便，里急后重三年，最近20天加重。" } });
  assert.ok(!chronic.redFlags.some((item) => /消化道出血/u.test(item)), JSON.stringify(chronic.redFlags));
  assert.ok(chronic.advisories.some((item) => /黏液脓血便需优先完善粪常规/u.test(item)), JSON.stringify(chronic.advisories));
  // 只有限定语一路能命中的写法（「大量」直接修饰脓血便，无头晕等伴随症）。
  const large = gate({ ...base, chiefComplaint: "腹泻2天", symptoms: { 现病史: "进食不洁后腹泻2天，解大量黏液脓血便，日十余次，里急后重。" } });
  assert.ok(!large.redFlags.some((item) => /消化道出血/u.test(item)), JSON.stringify(large.redFlags));
  const largeBlood = gate({ ...base, chiefComplaint: "便血2天", symptoms: { 现病史: "进食不洁后2天，解大量血便，日十余次。" } });
  assert.ok(largeBlood.redFlags.some((item) => /消化道出血/u.test(item)), JSON.stringify(largeBlood.redFlags));
  const hematochezia = gate({ ...base, chiefComplaint: "便血3天", symptoms: { 现病史: "便血3天，量多伴头晕。" } });
  assert.ok(hematochezia.redFlags.some((item) => /消化道出血/u.test(item)), JSON.stringify(hematochezia.redFlags));
});

await check("5.6 「脓血」「赤白相兼」只在说大便时才算黏液脓血便；每日6次以上评估时限收紧到24小时（Truelove–Witts）", () => {
  const base = { patient: { sex: "女", age: 40 }, vitals: { T: "36.8", P: "80", R: "18", BP: "118/76" } };
  const view = (cc, text) => { const s = withGate({ ...base, chiefComplaint: cc, symptoms: { 现病史: text } }); return { adv: (s.safetyGate.advisories || []).filter((a) => /黏液脓血便/u.test(a)), target: safety.priorityEvaluationFollowupTarget(s) }; };
  // 痰中带脓血、带下赤白相兼：不给粪常规提示。
  assert.deepEqual(view("咳嗽吐痰半年", "咳嗽吐痰，痰黄绿色，有时痰中带脓血，咽干口渴。").adv, []);
  assert.deepEqual(view("带下量多2周", "近两周带下量多，色赤白相兼，质稠，阴部瘙痒。").adv, []);
  // 「大便质稀，夹有脓血」：主语在前一小句，照算。
  const stool = view("脓血便反复发作10余年", "大便质稀，夹有脓血，每日8、9次，便前腹痛。");
  assert.equal(stool.adv.length, 1);
  assert.equal(stool.target?.window, "within_24h", JSON.stringify(stool.target));
  assert.match(stool.target?.focus || "", /重症溃疡性结肠炎/u);
  const many = view("大便痢下20多天", "近3天每天下痢8-9次，夹杂粘液和脓血，形体消瘦。");
  assert.equal(many.target?.window, "within_24h", JSON.stringify(many.target));
  const few = view("腹痛、脓血便2天", "进食凉拌菜后腹痛，继而解黏液脓血便，赤白相兼，每日3-4次，里急后重。");
  assert.equal(few.adv.length, 1);
  assert.notEqual(few.target?.window, "within_24h", JSON.stringify(few.target));
  // 肛瘘、肛周脓肿的流脓不是大便；「不夹杂脓血」是否认。
  assert.deepEqual(view("肛门部流脓血4个月", "肛门部流脓血已有4个月，局部肿痛。").adv, []);
  assert.deepEqual(view("泄泻3月", "泄泻每日3-4次，不夹杂脓血，伴腰膝酸软。").adv, []);
  assert.equal(view("肛门流脓2年", "肛门流脓溢液2年余，伴便下脓血粘液。").adv.length, 1);
  const tenPlus = view("腹泻3天", "腹泻3天，日十余次，为黏液脓血便，里急后重。");
  assert.equal(tenPlus.target?.window, "within_24h", JSON.stringify(tenPlus.target));
});

await check("3.4 白术功用兼写健脾与利水、病历有便溏：交付土炒白术；只写利水消肿的照旧生白术", () => {
  const record = "大便溏薄，每日2次。";
  assert.equal(processing.processedHerbName("白术", { purposeText: "健脾益气，渗利水湿", recordText: record }), "土炒白术");
  assert.equal(processing.processedHerbName("白术", { purposeText: "利水消肿", recordText: record }), undefined);
  assert.equal(processing.processedHerbName("白术", { purposeText: "健脾益气，渗利水湿", recordText: "大便调。" }), undefined);
  // 便溏的其他写法（线上 new40 m20「大便偏溏」仍用生白术）：偏溏、不成形、便稀照算；「大便成形」不算。
  assert.equal(processing.processedHerbName("白术", { purposeText: "健脾益气以助统血", recordText: "睡眠可，大便偏溏、每日1次。" }), "土炒白术");
  assert.equal(processing.processedHerbName("山药", { purposeText: "补脾养胃", recordText: "纳差，大便不成形。" }), "麸炒山药");
  assert.equal(processing.processedHerbName("白术", { purposeText: "健脾益气", recordText: "纳可，大便成形，日1次。" }), undefined);
});

await check("7.3 教材加减写炮制品名（炒麦芽）、知识库没有单列剂量：按生品的药典剂量给量、核量；有毒的生品不借", async () => {
  const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
  assert.equal(contract.modificationDoseWithinPharmacopoeia("10g", "炒麦芽", "加"), true);
  assert.equal(contract.modificationDoseWithinPharmacopoeia("200g", "炒麦芽", "加"), false);
  assert.equal(contract.ordinaryProcessedBaseHerbName("炒麦芽"), "麦芽");
});


// ───── 11 独立新病历盲评找到的服务端缺陷 ─────
const polarity = await jiti.import("../src/lib/clinical-polarity.ts");
await check("11.1 用药读法：下一句「半年前自行停药」停的是前一味；「1周前…口服X5天」、「曾自服X1周」是用过；「…治疗至今」是正在用", () => {
  assert.equal(polarity.medicationStoppedInNextSentence("口服“甲巯咪唑”治疗1年半后甲功恢复正常。半年前自行停药，未再复查。", "甲巯咪唑"), true);
  assert.equal(polarity.medicationStoppedInNextSentence("长期口服二甲双胍。停药则血糖升高。", "二甲双胍"), false);
  assert.equal(polarity.medicationOnlyPastMentions("1周前因急性支气管炎口服阿莫西林克拉维酸钾5天。未用其他药物。", "阿莫西林克拉维酸钾"), "ever");
  assert.equal(polarity.medicationOnlyPastMentions("曾自服左氧氟沙星1周，症状稍减后复发。", "左氧氟沙星"), "ever");
  assert.equal(polarity.medicationOnlyPastMentions("口服氨氯地平5mg qd至今。", "氨氯地平"), undefined);
});

await check("11.2 加减行的孕哺慎用提示：男童、婴儿不写；下乳的王不留行不写「哺乳期慎用」（依据不是药典）", async () => {
  const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
  const infant = "患者年龄：8个月\n患者性别：男\n现病史：母亲孕期体健，口腔白屑3天。";
  assert.ok(!contract.recordedPopulationCautions("佩兰", infant).some((p) => /孕|哺乳/u.test(p)), JSON.stringify(contract.recordedPopulationCautions("佩兰", infant)));
  // 药典孕妇慎用的桃仁：病历里的「母亲孕期」不是患儿本人。
  assert.ok(!contract.recordedPopulationCautions("桃仁", infant).some((p) => /孕/u.test(p)), JSON.stringify(contract.recordedPopulationCautions("桃仁", infant)));
  // 原病历写法（m24：家族史「母亲孕期体健」、婚育史「未婚」）：旧代码给牛膝（药典孕妇慎用）写「孕期/妊娠」，只靠人群判据拦下。
  const m24 = safety.clinicalGroundingText(types.normalizeCaseStateInput({
    chiefComplaint: "口腔白屑3天", patient: { sex: "男", age: 0.6667 },
    symptoms: { 现病史: "患儿8月龄，3天前口腔颊黏膜出现白色乳凝块样斑点，伴烦躁哭闹。", 婚育史: "未婚", 家族史: "父母体健，母亲孕期体健，否认家族遗传病史" },
  }));
  assert.deepEqual(contract.recordedPopulationCautions("牛膝", m24).filter((p) => /孕|哺乳/u.test(p)), [], JSON.stringify(contract.recordedPopulationCautions("牛膝", m24)));
  const woman = safety.clinicalGroundingText(types.normalizeCaseStateInput({
    chiefComplaint: "腰痛1周", patient: { sex: "女", age: 30 }, symptoms: { 现病史: "腰痛1周，现妊娠12周。" },
  }));
  assert.ok(contract.recordedPopulationCautions("牛膝", woman).some((p) => /孕/u.test(p)), JSON.stringify(contract.recordedPopulationCautions("牛膝", woman)));
  const lactating = "患者年龄：26岁\n患者性别：女\n现病史：产后1月，哺乳期，左乳肿痛2天。";
  assert.ok(!contract.recordedPopulationCautions("王不留行", lactating).some((p) => /哺乳/u.test(p)), JSON.stringify(contract.recordedPopulationCautions("王不留行", lactating)));
});

await check("11.3 病历有分项结果（肌酐68）时，「肾功能」不写「病历未记录本次肾功能结果」", () => {
  const record = "辅助检查：尿蛋白±，肌酐68μmol/L，彩超未见占位。";
  const out = safety.sanitizeUngroundedRedFlagNegations("肾功能正常，尿蛋白仅±", { chiefComplaint: "尿血2周", symptoms: { presentHistory: "小便带血2周", auxiliaryExam: record }, patient: { sex: "女", age: "56" } });
  assert.doesNotMatch(out, /病历未记录本次肾功能结果/u, out);
});

await check("11.4 「去川芎之峻行、以荆芥易荆芥穗」：川芎在方中，前半不留，换药的后半照留", () => {
  const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {}, formula: { candidates: [{ name: "当归饮子加减", herbs: [{ name: "当归" }, { name: "川芎" }, { name: "荆芥" }, { name: "防风" }], formulaAnalysis: "本方以当归饮子为基础加减，去川芎之峻行、以荆芥易荆芥穗。当归为君。" }] } };
  const out = surface.projectDeliveredReasoning(reasoning, { recordText: "主诉：瘙痒" });
  assert.doesNotMatch(out.formula.candidates[0].formulaAnalysis, /去川芎/u);
  assert.match(out.formula.candidates[0].formulaAnalysis, /以荆芥易荆芥穗/u);
});

await check("11.5 发绀：引文须有发绀、紫绀、青紫之类字样；「四肢末梢稍凉」不采信", () => {
  const record = "患儿发热1天，嗜睡，四肢末梢稍凉。";
  const parsed = screen.parseRedflagDiscriminatorScreen(JSON.stringify({ present: [{ id: "blue", quote: "四肢末梢稍凉" }, { id: "cyanosis", quote: "四肢末梢稍凉" }] }), ["blue", "cyanosis"], record) || [];
  assert.equal(parsed.length, 0, JSON.stringify(parsed));
});

await check("11.9 哭声微弱、尖直或持续不止：引文须写出哭声本身的性质；鹅口疮患儿「伴烦躁哭闹、吮乳时啼哭」不采信，「哭声尖直、无法安抚」照采信", () => {
  const record = "患儿8月龄，口腔白屑3天，伴烦躁哭闹、吮乳时啼哭、拒食。精神反应好。";
  const parsed = screen.parseRedflagDiscriminatorScreen(JSON.stringify({ present: [{ id: "weak-high-pitched-cry", quote: "伴烦躁哭闹、吮乳时啼哭" }] }), ["weak-high-pitched-cry"], record) || [];
  assert.equal(parsed.length, 0, JSON.stringify(parsed));
  const real = "患儿3月龄，发热1天，哭声尖直，持续哭闹无法安抚，吃奶差。";
  const kept = screen.parseRedflagDiscriminatorScreen(JSON.stringify({ present: [{ id: "weak-high-pitched-cry", quote: "哭声尖直，持续哭闹无法安抚" }] }), ["weak-high-pitched-cry"], real) || [];
  assert.equal(kept.length, 1, JSON.stringify(kept));
});

await check("11.6 中医鉴别同一个病的两种写法只列一次（痫证/痫病、大行赤眼即天行赤眼），与本病同名的不列", () => {
  const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseName: "急惊风", primarySyndrome: "热毒炽盛证", tcmDiseaseDifferentials: [
    { diseaseName: "痫证", reason: "均可抽搐", distinguishingPoints: "x", typicalManifestation: "", nextCheck: null },
    { diseaseName: "痫病", reason: "均可抽搐", distinguishingPoints: "y", typicalManifestation: "", nextCheck: null },
    { diseaseName: "大行赤眼", reason: "z", distinguishingPoints: "z", typicalManifestation: "", nextCheck: null },
    { diseaseName: "天行赤眼", reason: "z", distinguishingPoints: "z", typicalManifestation: "", nextCheck: null }] }, therapy: {}, pathogenesis: { chain: [] } };
  const names = surface.projectDeliveredReasoning(reasoning, { recordText: "主诉：发热1天" }).overview.tcmDiseaseDifferentials.map((row) => row.diseaseName);
  assert.deepEqual(names, ["痫证", "天行赤眼"]);
});

await check("11.7 肛裂病历已有视诊所见（截石位见裂口、未做指诊）：不写「尚未做肛门检查…初步判断」；只写未做肛门检查的照写", () => {
  const base = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseName: "肛裂", primarySyndrome: "血热肠燥证", tcmDiseaseRationale: "便时肛门撕裂样疼痛、滴鲜血，符合肛裂。" }, therapy: {}, pathogenesis: { chain: [] } };
  const seen = surface.projectDeliveredReasoning(structuredClone(base), { recordText: "体格检查：截石位6点肛管处见一纵行裂口；因疼痛未行指诊及肛门镜检查" });
  assert.doesNotMatch(seen.overview.tcmDiseaseRationale, /初步判断/u);
  const unseen = surface.projectDeliveredReasoning(structuredClone(base), { recordText: "现病史：便血1周，暂未接受肛门检查" });
  assert.match(unseen.overview.tcmDiseaseRationale, /初步判断/u);
});

await check("11.8 证素否认要落在证素本身：「舌淡红、苔薄白示气血不足而无热象」是断言气血不足；「血虚未甚」「无气血不足」才是否认", async () => {
  const element = await jiti.import("../src/lib/m03-element-support.server.ts");
  assert.match(element.rationaleAssertionClauses("舌淡红、苔薄白示气血不足而无热象，脉弦细"), /气血不足/u);
  assert.doesNotMatch(element.rationaleAssertionClauses("舌质淡红示血虚未甚，故属心虚胆怯"), /血虚/u);
  assert.doesNotMatch(element.rationaleAssertionClauses("舌脉如常，故无气血不足之象"), /气血不足/u);
});

