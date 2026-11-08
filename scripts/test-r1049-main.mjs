// 第三十七轮（2026-11-08）：甲方 11.05 第三轮医学测评（17 份病历）里我们这边的问题，按类修。
// 每条断言都有反证（~/runlogs/r1018/work/r1049/cp/）。
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

const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const phrasing = await jiti.import("../src/lib/tcm-therapy-phrasing.ts");
const coverage = await jiti.import("../src/lib/m03-method-coverage.server.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const processing = await jiti.import("../src/lib/herb-processing-forms.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const fit = await jiti.import("../src/lib/m04-modification-fit.server.ts");
const westernCheck = await jiti.import("../src/lib/western-name-evidence-check.server.ts");
const westernStandard = await jiti.import("../src/lib/western-name-standard.server.ts");
const verbatim = await jiti.import("../src/lib/verbatim-quote.ts");
const review = await jiti.import("../src/lib/formula-analysis-review.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");

// ───── 1 病机分析块：引文按最小单位接地（17/17 不通过）─────
const record1 = [
  "主诉：恶寒、发热伴头痛、身痛1天",
  "现病史：患者1天前受凉后出现恶寒、发热，恶寒重、发热轻，伴无汗、头痛连及项背、肢体酸痛，伴鼻塞、流清涕、喷嚏、咽痒、咳嗽，咳白色稀痰。发病以来精神可，二便如常。",
  "舌象：舌淡红，苔薄白",
  "脉象：脉浮紧",
].join("\n");

await check("1.1 引文本身是病历原文时回填这一小段，不扩成主诉或整段现病史；否认处的原文不当肯定引文", () => {
  assert.equal(contract.patientFactSourceQuote("恶寒重、发热轻，伴无汗", record1), "恶寒重、发热轻，伴无汗");
  assert.equal(contract.patientFactSourceQuote("鼻塞、流清涕、喷嚏、咽痒、咳嗽", record1), "鼻塞、流清涕、喷嚏、咽痒、咳嗽");
  // 按句号/分号切开逐段对上：各段仍是原文（舌脉写法差异由对齐处理）。
  assert.equal(contract.patientFactSourceQuote("舌淡红，苔薄白；脉浮紧", record1), "舌淡红，苔薄白；脉浮紧");
  // 反证面：病历写「无腹痛」，引文「腹痛」不能按字面回填成肯定。
  assert.notEqual(contract.patientFactSourceQuote("腹痛", "现病史：患者无腹痛，大便如常。"), "腹痛");
});

await check("1.2 三条病位依据各自成立：病位、病性保持模型判的「已确定」，不降为「依据只有1条」与低置信", () => {
  const reasoning = {
    stage: "diagnose",
    overview: { primarySyndrome: "风寒束表证", primarySyndromeResolution: "resolved", primarySyndromeBasis: ["恶寒重、发热轻，伴无汗"] },
    pathogenesis: {
      locationDifferentiation: { items: ["肺", "卫表", "头项"], details: [
        { location: "肺", basis: "鼻塞、流清涕、喷嚏、咽痒、咳嗽" },
        { location: "卫表", basis: "恶寒重、发热轻，伴无汗" },
        { location: "头项", basis: "头痛连及项背、肢体酸痛" },
      ], resolution: "resolved", evidence: { evidenceLevel: "model_inference", source: "本例", confidence: "中" } },
      natureDifferentiation: { items: ["风寒", "表实"], rootDeficiency: [], branchExcess: ["风寒束表"], basis: "恶寒重、发热轻，伴无汗", resolution: "resolved", evidence: { evidenceLevel: "model_inference", source: "本例", confidence: "中" } },
      symptomClusters: [], chain: [],
    },
  };
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const out = JSON.parse(summary.sanitizeOptionalPathogenesisClassifications(content, record1).split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  const location = out.pathogenesis.locationDifferentiation;
  assert.equal(location.resolution, "resolved", JSON.stringify(location));
  assert.equal(location.details.length, 3);
  assert.equal(location.details[1].basis, "恶寒重、发热轻，伴无汗");
  assert.equal(location.evidence.confidence, "中");
  assert.equal(out.pathogenesis.natureDifferentiation.basis, "恶寒重、发热轻，伴无汗");
  // 两段原文的依据整条保留（不是只留第一段）。
  reasoning.pathogenesis.natureDifferentiation.basis = "恶寒重、发热轻，伴无汗；脉浮紧";
  const twoSegments = JSON.parse(summary.sanitizeOptionalPathogenesisClassifications(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`, record1).split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  assert.equal(twoSegments.pathogenesis.natureDifferentiation.basis, "恶寒重、发热轻，伴无汗；脉浮紧");
});

// ───── 2 治法：四字项、封顶三项、同族不重复 ─────
await check("2.1 交付治法：两字项不留、同族后补项去掉、总数不超过上限（教材项数大于三项时按教材）；同字头合写的五六字项不拆", () => {
  assert.equal(surface.clinicalMethodItems("辛温解表，宣肺散寒，通络止痛，化痰"), "辛温解表，宣肺散寒，通络止痛");
  assert.equal(surface.clinicalMethodItems("芳香化湿，解表散寒，止泻，温化寒湿"), "芳香化湿，解表散寒");
  assert.equal(surface.clinicalMethodItems("健脾益气助运，理气和胃"), "健脾益气助运，理气和胃");
  assert.equal(surface.clinicalMethodItems("辛凉解表，疏风清热，利咽止咳，清热化痰生津"), "辛凉解表，疏风清热，利咽止咳");
  assert.equal(surface.clinicalMethodItems("养血和络，补益肝肾，强壮筋骨，祛风宣痹", 4), "养血和络，补益肝肾，强壮筋骨，祛风宣痹");
  // 只有短项时原样（不删空）。
  assert.equal(surface.clinicalMethodItems("止咳"), "止咳");
});

await check("2.2 补写治法只收四字项；总项数与交付面同一上限", () => {
  assert.equal(phrasing.isStandardMethodItem("宣肺化痰"), true);
  assert.equal(phrasing.isStandardMethodItem("化痰"), false);
  assert.equal(phrasing.isStandardMethodItem("清热化痰生津"), false);
  assert.equal(coverage.methodItemQualifies({ item: "化痰", quotes: [], fromModel: true }, { method: "辛温解表", recordText: "" }), false);
  assert.equal(phrasing.DELIVERED_METHOD_ITEM_CAP, 3);
});

// ───── 3 红旗：后遗缺损的异体字 ─────
const strokeCase = (exam, present) => types.normalizeCaseStateInput({
  id: "r1049-15", chiefComplaint: "右侧肢体无力、言语不清半年", patient: { sex: "男", age: 70 },
  symptoms: { 现病史: present, 体格检查: exam },
  vitals: { T: "36.5", P: "78", R: "18", BP: "142/88" },
});
const residual = "患者半年前突发右侧肢体无力、言语不清，于外院诊断为“脑梗死”，经治疗后遗留右侧半身不遂、手足麻木、口眼歪斜及言语謇涩。现规律康复治疗中，无新发言语不清。";

await check("3.1 现病史写明脑梗遗留口眼歪斜、查体写「右侧口眼㖞斜」：同一缺损，不报新发卒中红旗；查体写今日新发时照报", () => {
  assert.deepEqual(safety.detectProgrammaticRedFlags(strokeCase("右侧口眼㖞斜", residual)), []);
  assert.deepEqual(safety.detectProgrammaticRedFlags(strokeCase("右侧口眼喎斜", residual)), []);
  // 反证面：没有遗留框架、今日突发时仍是红旗。
  assert.ok(safety.detectProgrammaticRedFlags(strokeCase("右侧口眼㖞斜", "今日晨起突发右侧口眼㖞斜、言语不清2小时。")).length > 0);
});

// ───── 4 红旗未解除：治则、成药 ─────
await check("4.1 红旗未解除时治则先写急则治标；标本兼治不留；没有红旗不动", () => {
  assert.equal(surface.principleWhenRedFlag("标本兼治", true), "急则治标");
  assert.equal(surface.principleWhenRedFlag("虚则补之", true), "急则治标，虚则补之");
  assert.equal(surface.principleWhenRedFlag("虚则补之，急则治标", true), "急则治标，虚则补之");
  assert.equal(surface.principleWhenRedFlag("标本兼治", false), "标本兼治");
});

const prescribeReasoning = () => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: { tcmDiseaseName: "胸痹", primarySyndrome: "心血瘀阻证" },
  formula: { candidates: [{ name: "血府逐瘀汤加减", herbs: [{ name: "桃仁", role: "君" }, { name: "红花", role: "君" }, { name: "甘草", role: "使" }], formulaAnalysis: "桃仁、红花为君。" }],
    patentAndWestern: [{ name: "参芍片", type: "中成药" }], medicineCandidateStatus: { status: "available", reason: "已形成候选。" } },
  nonPharma: null,
});

await check("4.2 红旗未解除（当天急诊通道）时不列中成药、西药，原因写进 medicineCandidateStatus；其余病例照列", () => {
  const red = surface.projectDeliveredReasoning(prescribeReasoning(), { priorityEvaluation: { focus: "", window: "today", pathway: "red_flag_clearance" } });
  assert.deepEqual(red.formula.patentAndWestern, []);
  assert.equal(red.formula.medicineCandidateStatus.reason, surface.RED_FLAG_MEDICINE_WITHHELD_REASON);
  const normal = surface.projectDeliveredReasoning(prescribeReasoning(), { priorityEvaluation: { focus: "x", window: "within_3d", pathway: "pregnancy_review" } });
  assert.equal(normal.formula.patentAndWestern.length, 1);
});

// ───── 5 炮制品 ─────
await check("5.1 炮制品按《中药炮制学》：便溏且写健脾的白术用土炒白术；写利水的、没有便溏的不改；牡蛎按写的功用（收敛固涩煅用、重镇安神生用）；杜仲内服用盐杜仲", () => {
  assert.equal(processing.processedHerbName("白术", { purposeText: "健脾益气", recordText: "伴神疲乏力、大便溏薄。" }), "土炒白术");
  assert.equal(processing.processedHerbName("白术", { purposeText: "健脾益气", recordText: "伴神疲乏力，二便调。" }), undefined);
  assert.equal(processing.processedHerbName("白术", { purposeText: "燥湿利水", recordText: "大便溏薄" }), undefined);
  assert.equal(processing.processedHerbName("白术", { purposeText: "健脾益气", recordText: "无便溏，大便如常" }), undefined);
  assert.equal(processing.processedHerbName("牡蛎", { purposeText: "收敛固涩，止汗" }), "煅牡蛎");
  assert.equal(processing.processedHerbName("牡蛎", { purposeText: "重镇安神，收敛" }), undefined);
  assert.equal(processing.processedHerbName("山药", { purposeText: "补脾止泻", recordText: "大便溏薄" }), "麸炒山药");
  assert.equal(processing.processedHerbName("杜仲", { purposeText: "补肝肾" }), "盐杜仲");
  // 已写炮制的不改。
  assert.equal(processing.processedHerbName("炒白术", { purposeText: "健脾", recordText: "便溏" }), undefined);
});

await check("5.2 命名方原文写的炮制优先（完带汤：白术土炒、山药炒、白芍酒炒）", () => {
  assert.equal(processing.processedHerbName("白术", { formulaName: "完带汤", purposeText: "健脾燥湿", recordText: "" }), "土炒白术");
  assert.equal(processing.processedHerbName("山药", { formulaName: "完带汤加减", purposeText: "", recordText: "" }), "炒山药");
  assert.equal(processing.processedHerbName("白芍", { formulaName: "完带汤", purposeText: "", recordText: "" }), "酒白芍");
});

await check("5.3 交付面：药名带上炮制（processing 栏写的并进药名）；加减行按所引教材原文取煅牡蛎；方义同步；重复投影不变", () => {
  const reasoning = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: { tcmDiseaseName: "心悸", primarySyndrome: "心血不足证" },
    formula: { candidates: [{ name: "归脾汤加减", herbs: [{ name: "白术", role: "臣", function: "健脾益气" }, { name: "龙骨", role: "佐", processing: "煅" }, { name: "黄芪", role: "君", function: "补气" }], formulaAnalysis: "黄芪为君；白术为臣，健脾益气；龙骨为佐。" }],
      modifications: [{ trigger: "若兼阳虚而汗出肢冷", action: "加", herbName: "牡蛎", doseOrHandling: "9g", reason: "收敛固涩，制酸止痛", riskNote: "牡蛎先煎20–30分钟", evidence: { evidenceLevel: "kb_entry", source: "《中医内科学》心悸·心血不足证加减：兼阳虚而汗出肢冷，加炮附子、黄芪、煅龙骨、煅牡蛎", confidence: "中" } }] },
    nonPharma: null,
  };
  const once = surface.projectDeliveredReasoning(reasoning, { recordText: "伴神疲乏力，大便溏薄。" });
  const herbs = once.formula.candidates[0].herbs.map((herb) => herb.name);
  assert.deepEqual(herbs, ["土炒白术", "煅龙骨", "黄芪"]);
  assert.match(once.formula.candidates[0].formulaAnalysis, /土炒白术为臣/u);
  assert.equal(once.formula.modifications[0].herbName, "煅牡蛎");
  assert.match(once.formula.modifications[0].riskNote, /煅牡蛎先煎/u);
  // 有毒药不并炮制进药名（附子、半夏的规格与剂量由毒性药规则管）；教材条目原文写的炮制（煅瓦楞子）照写。
  const toxic = surface.projectDeliveredReasoning({ ...reasoning, formula: { ...reasoning.formula, candidates: [{ name: "四逆汤", herbs: [{ name: "附子", role: "君", processing: "制", isToxic: true }, { name: "干姜", role: "臣" }], formulaAnalysis: "附子为君。" }],
    modifications: [{ trigger: "若泛酸", action: "加", herbName: "瓦楞子", doseOrHandling: "15g", reason: "制酸止痛", riskNote: "", evidence: { evidenceLevel: "kb_entry", source: "《中医内科学》胃痛加减：泛酸者，加煅瓦楞子、海螵蛸", confidence: "中" } }] } }, { recordText: "胃痛" });
  assert.equal(toxic.formula.candidates[0].herbs[0].name, "附子");
  assert.equal(toxic.formula.modifications[0].herbName, "煅瓦楞子");
  const twice = surface.projectDeliveredReasoning(once, { recordText: "伴神疲乏力，大便溏薄。" });
  assert.deepEqual(twice.formula.candidates[0].herbs.map((herb) => herb.name), herbs);
  assert.equal(twice.formula.modifications[0].herbName, "煅牡蛎");
});

// ───── 6 原方 ─────
await check("6.1 荆防败毒散按原书 11 味：处方多出生姜、薄荷不算原方；与原书相同才算", () => {
  const eleven = ["荆芥", "防风", "羌活", "独活", "川芎", "柴胡", "前胡", "桔梗", "枳壳", "茯苓", "甘草"];
  assert.equal(surface.candidateIsOriginalFormula("荆防败毒散", [...eleven, "生姜", "薄荷"].map((name) => ({ name }))), false);
  assert.equal(surface.candidateIsOriginalFormula("荆防败毒散", eleven.map((name) => ({ name }))), true);
  assert.equal(surface.candidateIsOriginalFormula("荆防败毒散", [...eleven, "生姜"].map((name) => ({ name }))), false, "只多一味生姜也不算原方");
  // 原方列了生姜、大枣作引、本方没列：仍算原方（桂枝汤）。
  assert.equal(surface.candidateIsOriginalFormula("桂枝汤", ["桂枝", "白芍", "炙甘草"].map((name) => ({ name }))), true);
});

await check("6.2 出处订正：耳聋左慈丸出《饲鹤亭集方》、八味含柴胡；菟丝子散《太平圣惠方》收进目录，合方能拆开", () => {
  const ref = provenance.formulaCompilationReferences(["耳聋左慈丸"])[0];
  assert.match(String(ref?.source), /饲鹤亭集方/u);
  assert.ok(ref.ingredients.some((name) => name.includes("柴胡")) && !ref.ingredients.some((name) => name.includes("石菖蒲")));
  assert.deepEqual(provenance.formulaNameComponents("菟丝子散合桑螵蛸散加减"), ["菟丝子散", "桑螵蛸散"]);
});

const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
await check("6.3 合方的组成方都算：「菟丝子散合桑螵蛸散加减」里桑螵蛸散的远志、煅龙骨不当顺带安神药去掉（辨证阶段推荐的方向也算）", () => {
  const herbs = ["菟丝子", "桑螵蛸", "肉苁蓉", "益智", "五味子", "远志", "煅龙骨", "茯神", "炙甘草"].map((name, index) => ({ name, role: index < 2 ? "君" : index < 5 ? "臣" : "佐", dose: "6g" }));
  const prior = { stage: "diagnose", overview: { tcmDiseaseName: "遗尿", primarySyndrome: "下元虚寒证", recommendedFormulaDirection: "菟丝子散合桑螵蛸散加减", recommendedFormulaNames: [] } };
  const kept = compiler.withoutIncidentalSedatives({ name: "菟丝子散合桑螵蛸散加减", herbs }, prior, "遗尿1年，睡眠深", "反复遗尿1年").map((herb) => herb.name);
  assert.ok(kept.includes("远志") && kept.includes("煅龙骨"), kept.join("、"));
  // 只靠合方拆名（证名在教材里没有行）：
  const noRow = { stage: "diagnose", overview: { tcmDiseaseName: "遗尿", primarySyndrome: "肾虚不固证", recommendedFormulaDirection: "", recommendedFormulaNames: [] } };
  const byName = compiler.withoutIncidentalSedatives({ name: "菟丝子散合桑螵蛸散加减", herbs }, noRow, "遗尿1年", "反复遗尿1年").map((herb) => herb.name);
  assert.ok(byName.includes("远志") && byName.includes("煅龙骨"), `合方拆名：${byName.join("、")}`);
  // 只靠教材行组成（方名写成自拟方）：
  const rowHerbs = textbook.textbookRowForSyndrome("遗尿", "下元虚寒证")?.composition || [];
  const sedative = ["远志", "龙骨", "煅龙骨", "茯神", "石菖蒲"].find((name) => rowHerbs.includes(name));
  if (sedative) {
    const byRow = compiler.withoutIncidentalSedatives({ name: "自拟方", herbs }, { ...prior, overview: { ...prior.overview, recommendedFormulaDirection: "" } }, "遗尿1年", "反复遗尿1年").map((herb) => herb.name);
    assert.ok(byRow.some((name) => name.endsWith(sedative.replace(/^煅/u, ""))), `教材行组成：${byRow.join("、")}`);
  }
});

// ───── 7 证名跟着辨证依据 ─────
const compositeCase = (locationDetails, extra = {}) => ({
  overview: { primarySyndrome: "心血不足证", tcmDiagnosticRationale: "…为气血生化不足，故属心血不足证。", secondarySyndromes: [], tcmDifferentials: [{ syndrome: "心脾两虚证" }, { syndrome: "心阳不振证" }], ...extra },
  pathogenesis: { locationDifferentiation: { items: ["心", "脾"], details: locationDetails }, natureDifferentiation: { items: ["气虚", "血虚"] } },
});
const record3 = "心悸气短、神疲乏力3月，伴失眠多梦，食欲不振、食后腹胀，面色少华，月经量少色淡。";

await check("7.1 模型自己的病位分析列了脾、那一条依据有两项病历原文：证名换成国标合称心脾两虚证，依据里的旧证名同步，鉴别里的同名证去掉", () => {
  const reasoning = compositeCase([{ location: "心", basis: "心悸气短" }, { location: "脾", basis: "食欲不振、食后腹胀" }]);
  assert.deepEqual(surface.compositeSyndromeRename(reasoning, record3), { from: "心血不足证", to: "心脾两虚证" });
  assert.equal(reasoning.overview.primarySyndrome, "心脾两虚证");
  assert.match(reasoning.overview.tcmDiagnosticRationale, /故属心脾两虚证/u);
  assert.deepEqual(reasoning.overview.tcmDifferentials.map((row) => row.syndrome), ["心阳不振证"]);
});

await check("7.2 反证面：脾那一条只有一项、或已立兼证、或证名不在表里时不改", () => {
  assert.equal(surface.compositeSyndromeRename(compositeCase([{ location: "脾", basis: "食欲不振" }]), record3), undefined);
  assert.equal(surface.compositeSyndromeRename(compositeCase([{ location: "脾", basis: "食欲不振、食后腹胀" }], { secondarySyndromes: ["脾气虚证"] }), record3), undefined);
  assert.equal(surface.compositeSyndromeRename(compositeCase([{ location: "脾", basis: "食欲不振、食后腹胀" }], { primarySyndrome: "心虚胆怯证" }), record3), undefined);
});

await check("7.3 脾虚证 + 病性列了湿、病历两项湿象：脾虚湿困证；湿象只有一项不改", () => {
  const reasoning = (signs) => ({
    overview: { primarySyndrome: "脾虚证", secondarySyndromes: [] },
    pathogenesis: { locationDifferentiation: { items: ["脾"], details: [] }, natureDifferentiation: { items: ["气虚", "湿浊"] } },
    _signs: signs,
  });
  assert.equal(surface.compositeSyndromeRename(reasoning(), "带下量多、色白质稀，肢体困重，舌淡，苔白腻。")?.to, "脾虚湿困证");
  assert.equal(surface.compositeSyndromeRename(reasoning(), "带下量多、色白质稀，舌淡，苔白腻。"), undefined);
});

// ───── 8 血证分型 ─────
await check("8.1 血证写到具体一型：主诉鼻出血为鼻衄；鉴别只留讲到鼻衄的（经行衄血），不留血淋；交付病名「血证（鼻衄）」", () => {
  assert.equal(textbook.textbookDiseaseSubtype("血证", "反复鼻出血3天"), "鼻衄");
  assert.equal(textbook.textbookDiseaseSubtype("血证", "", "既往牙龈出血，近日鼻出血"), undefined);
  assert.equal(textbook.textbookDifferentialFitsSubtype("血证", "鼻衄", "血淋"), false);
  assert.equal(textbook.textbookDifferentialFitsSubtype("血证", "鼻衄", "经行衄血"), true);
  const reasoning = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: "血证", primarySyndrome: "胃热炽盛证", secondarySyndromes: [], tcmDiseaseDifferentials: [
      { diseaseName: "经行衄血", reason: "均有衄血", distinguishingPoints: "本例男性", typicalManifestation: "经期衄血", nextCheck: null },
      { diseaseName: "血淋", reason: "均有出血", distinguishingPoints: "本例鼻出血", typicalManifestation: "尿中带血", nextCheck: null }] },
    therapy: { overallMethod: "清胃泻火，凉血止血" }, pathogenesis: { chain: [] },
  };
  const out = surface.projectDeliveredReasoning(reasoning, { recordText: "主诉：反复鼻出血3天\n现病史：鼻出血，血色鲜红。" });
  assert.equal(out.overview.tcmDiseaseName, "血证（鼻衄）");
  assert.ok(!out.overview.tcmDiseaseDifferentials.some((row) => row.diseaseName === "血淋"));
  // 改名后教材行照样查得到（下游按病名找行）。
  assert.equal(textbook.textbookRowForSyndrome("血证（鼻衄）", "胃热炽盛证")?.group, "鼻衄");
});

// ───── 9 耳鼻喉病种 ─────
await check("9.1 乳蛾、喉痹、鼻鼽、鼻渊进教材病名：乳蛾风热外袭证用疏风清热汤", () => {
  const row = textbook.textbookRowForSyndrome("乳蛾", "风热外袭证");
  assert.ok(row?.formulas.includes("疏风清热汤"));
  for (const name of ["乳蛾", "喉痹", "鼻鼽", "鼻渊"]) assert.ok(textbook.isTextbookDiseaseName(name), name);
});

// ───── 10 加减与病情无关 ─────
await check("10.1 「无关」只给条件里一条本例表现都没有的行：腹痛未记录的「若寒湿凝滞腹痛」可判；「若恶寒甚」之于恶寒、「若头项强痛」之于头痛连及项背不判", () => {
  assert.equal(fit.conditionMentionsRecordedFinding("若寒湿凝滞腹痛", "带下量多，肢体困重，大便溏薄"), false);
  assert.equal(fit.conditionMentionsRecordedFinding("若兼有郁热", "畏寒肢冷，小便清长"), false);
  assert.equal(fit.conditionMentionsRecordedFinding("若恶寒甚", record1), true);
  assert.equal(fit.conditionMentionsRecordedFinding("若鼻塞流涕重", record1), true);
  const rows = [{ action: "加", trigger: "若寒湿凝滞腹痛", herbName: "香附", evidence: { evidenceLevel: "kb_entry", source: "《中医妇科学》带下过多·脾虚证加减：…" } },
    { action: "加", trigger: "若恶寒甚", herbName: "麻黄", evidence: { evidenceLevel: "kb_entry", source: "《中医内科学》感冒·风寒束表证加减：…" } }];
  assert.equal(fit.modificationFindingQualifies({ line: 0, verdict: "unrelated", quote: "" }, rows, "带下量多，肢体困重", "带下过多"), true);
  assert.equal(fit.modificationFindingQualifies({ line: 1, verdict: "unrelated", quote: "" }, rows, record1, "感冒"), false);
});

// ───── 11 西医 ─────
await check("11.1 心肌梗死 ST 段分型无心电图与肌钙蛋白时写急性冠脉综合征待查；病历有心电图 ST 段抬高时不改", () => {
  const noEcg = "主诉：胸骨后压榨样疼痛2小时\n现病史：活动中突发胸骨后压榨样闷痛，伴大汗。";
  assert.equal(westernCheck.deterministicWesternNameCorrection("急性ST段抬高型心肌梗死", noEcg)?.supportedName, "急性冠脉综合征待查");
  assert.equal(westernCheck.deterministicWesternNameCorrection("急性ST段抬高型心肌梗死", `${noEcg}\n辅助检查：心电图示V1-V4导联ST段抬高。`), undefined);
});

await check("11.2 核对摘录用省略号连接两段原文时按两段比对（两次核对一致才改名，一次带省略号就被判不出自病历）", () => {
  const text = "患者孕8周，2周前出现恶心、呕吐，食入即吐。发病以来体重略降，小便正常。";
  assert.equal(verbatim.quoteGroundedInText("孕8周，2周前出现恶心……发病以来体重略降", text), true);
  assert.equal(verbatim.quoteGroundedInText("孕8周……体重明显下降", text), false);
});

await check("11.3 沿用病历写明的既往诊断：推理说明先写病历原话；诊断标准要求的检查病历没有时写明沿用既往记录", () => {
  const out = westernStandard.establishedRationale({ name: "慢性浅表性胃炎", quote: "慢性浅表性胃炎病史2年", rationale: "慢性胃炎可致上腹胀满、纳差" }, "上腹部胀满、纳差2月。既往慢性浅表性胃炎病史2年。");
  assert.match(out, /^病历记载「慢性浅表性胃炎病史2年」/u);
  assert.match(out, /病历未附胃镜结果，诊断沿用既往记录/u);
  const withScope = westernStandard.establishedRationale({ name: "慢性浅表性胃炎", quote: "慢性浅表性胃炎病史2年", rationale: "慢性胃炎可致上腹胀满" }, "既往慢性浅表性胃炎病史2年，胃镜示胃窦黏膜充血。");
  assert.ok(!/病历未附/u.test(withScope));
});

// ───── 12 方义与加减理由里服务端留下的错话 ─────
await check("12.1 「故去姜半夏，另以生姜易之，并去本方中偏于峻补之品」：原方只缺已点名的半夏时，不点名的去药说法去掉；真去了别的药时照留", () => {
  const base = ["人参", "白术", "茯苓", "炙甘草", "陈皮", "半夏", "木香", "砂仁"];
  const analysis = "本方以香砂六君子汤为基础加减，因孕期不宜用半夏，故去姜半夏，另以生姜易之，并去本方中偏于峻补之品，取人参为君。";
  const kept = ["人参", "白术", "茯苓", "炙甘草", "陈皮", "木香", "砂仁", "生姜"];
  const out = review.withoutFalseBaseFormulaEdits(analysis, base, kept).text;
  assert.ok(!/偏于峻补之品/u.test(out), out);
  assert.match(out, /故去姜半夏/u);
  const removedMore = review.withoutFalseBaseFormulaEdits(analysis, base, kept.filter((name) => name !== "人参")).text;
  assert.match(removedMore, /偏于峻补之品/u);
});

await check("12.2 加减理由去无依据功效时不留残句：「散寒湿以止腹痛」去「散寒」不剩「湿以止腹痛」", () => {
  const reasoning = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: { tcmDiseaseName: "带下过多", primarySyndrome: "脾虚证" },
    formula: { candidates: [{ name: "完带汤", herbs: [{ name: "人参", role: "臣" }], formulaAnalysis: "" }],
      modifications: [{ trigger: "若腹痛", action: "加", herbName: "香附", doseOrHandling: "10g", reason: "理气解郁，散寒湿以止腹痛", riskNote: "", evidence: { evidenceLevel: "model_inference", source: "本例", confidence: "低" } }] },
    nonPharma: null,
  };
  const out = surface.projectDeliveredReasoning(reasoning);
  assert.ok(!/^湿|，湿以/u.test(out.formula.modifications[0].reason), out.formula.modifications[0].reason);
});
