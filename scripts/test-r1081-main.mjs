// 第六十二轮总指挥整合时的修改（实链回放 90 份甲方测评病历后发现的回归与遗漏）。每条断言的反证见 ~/runlogs/r1018/work/r1081/cp/。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { "@": root + "/src", "server-only": root + "/node_modules/next/dist/compiled/server-only/empty.js" } });
const sleep = await jiti.import("../src/lib/incidental-sleep-modification.ts");
const { topUpModificationRow, withoutIncidentalSedatives } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const { nationalTreatmentPrinciple } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const { withTwoOrganMethodFloor, twoOrganMethodFloorItem } = await jiti.import("../src/lib/two-organ-method-floor.ts");
const { governedFourCharacterMethodTerms } = await jiti.import("../src/lib/clinical-governance-tables.ts");
const { tidiedWesternBasis, withOnlyPrescribedOverlap, withinPrecautionCap } = await jiti.import("../src/lib/delivered-surface.ts");
const { settleWesternDiagnosisBasis } = await jiti.import("../src/lib/recorded-test-claims.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const { salvageM04Content } = await jiti.import("../src/lib/m04-salvage.ts");
const { normalizedFormulaIdentity } = await jiti.import("../src/lib/tcm-formula-indications.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");

let n = 0;
const check = (id, title, fn) => { fn(); n += 1; console.log(`✓ ${id} ${title}`); };
const prior = (disease, syndrome, method = "养血祛风") => ({
  overview: { tcmDiseaseName: disease, primarySyndrome: syndrome, secondarySyndromes: [], recommendedFormulaNames: [] },
  therapy: { overallMethod: method },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "头痛", pathogenesis: "血虚不荣", therapyDirection: method }] },
});

check("1.1", "顺带的睡眠差不加安神药：底线不因模型判「独立表现」而放行（甲方标准病历 3）", () => {
  const record = "患者男，32岁\n主诉：头痛2+月\n现病史：头痛隐隐，伴头晕、心悸、神疲乏力，睡眠差，纳可，二便调。";
  const row = { trigger: "睡眠差", herbName: "酸枣仁", reason: "宁心安神" };
  assert.equal(sleep.incidentalSleepModificationBlocked(row, prior("头痛", "血虚头痛"), { recordText: record, chiefComplaint: "头痛2+月" }), true);
  const state = normalizeCaseStateInput({ chiefComplaint: "头痛2+月", patient: { sex: "女", age: 32 }, symptoms: { 现病史: "头痛隐隐，伴头晕、心悸、神疲乏力，睡眠差，纳可，二便调。" } });
  const rejected = [];
  const compiled = topUpModificationRow({ trigger: "睡眠差", herbName: "酸枣仁", dose: "15g", reason: "宁心安神" }, {
    prior: prior("头痛", "血虚头痛"), caseState: state, candidateHerbNames: ["当归", "川芎", "白芍", "熟地黄"], baseHerbNames: ["当归", "川芎", "白芍", "熟地黄"],
    existingTriggers: [], authored: true, reviewedIndependentFinding: true, onReject: (code) => rejected.push(code),
  });
  assert.equal(compiled, undefined);
  assert.ok(rejected.includes("incidental_sleep"), rejected.join(","));
});

check("1.1b", "主方药味表同一条底线：模型给安神药写了「独立表现」和病历原句也不留；写「继发」的在心神范围内也去掉", () => {
  const record = "头痛隐隐，伴头晕、心悸、神疲乏力，睡眠差，纳可，二便调。";
  const herb = (name, role, extra = {}) => ({ name, dose: "10g", role, function: "", ...extra });
  const candidate = (scope) => ({ name: "本例辨证组方", herbs: [herb("当归", "君"), herb("川芎", "臣"), herb("白芍", "臣"), herb("熟地黄", "臣"),
    herb("酸枣仁", "佐", { symptomScope: scope, symptomQuote: "睡眠差" })] });
  const names = (rows) => rows.map((row) => row.name);
  assert.ok(!names(withoutIncidentalSedatives(candidate("independent"), prior("头痛", "血虚头痛"), record, "头痛2+月", record)).includes("酸枣仁"));
  assert.ok(!names(withoutIncidentalSedatives(candidate("secondary"), prior("头痛", "血虚头痛"), record, "头痛2+月", record)).includes("酸枣仁"));
  // 心神范围内（郁证；教材本证代表方里没有酸枣仁）：模型没说继发的安神药留着；说继发且有病历原句的去掉。
  assert.ok(names(withoutIncidentalSedatives(candidate("independent"), prior("郁证", "肝气郁结证"), record, "情志抑郁2月", record)).includes("酸枣仁"));
  assert.ok(!names(withoutIncidentalSedatives(candidate("secondary"), prior("郁证", "肝气郁结证"), record, "情志抑郁2月", record)).includes("酸枣仁"));
});

check("1.2", "证名里的「郁」不算心神范围，病名是郁证才算（甲方标准病历 8：蛇串疮·肝经郁热证）", () => {
  assert.equal(sleep.signedScopeInvolvesMind(prior("蛇串疮", "肝经郁热证")), false);
  assert.equal(sleep.signedScopeInvolvesMind(prior("胁痛", "肝气郁结证")), false);
  assert.equal(sleep.signedScopeInvolvesMind(prior("郁证", "肝气郁结证")), true);
  assert.equal(sleep.signedScopeInvolvesMind(prior("不寐", "肝火扰心证")), true);
  assert.equal(sleep.incidentalSleepModificationBlocked({ trigger: "夜间痛甚，影响睡眠", herbName: "首乌藤", reason: "养血安神" }, prior("蛇串疮", "肝经郁热证"),
    { recordText: "左侧胁肋部疼痛5天，夜间痛甚，影响睡眠，口苦咽干", chiefComplaint: "左侧胁肋部疼痛5+天" }), true);
});

check("1.3", "「失眠多梦」是一个睡眠主诉，加健忘只有两项，不算心神表现突出", () => {
  assert.equal(sleep.mindSymptomsProminentInRecord("双耳耳鸣半年，伴腰膝酸软、失眠多梦、健忘、咽干口燥", "双耳耳鸣、听力下降半年"), false);
  assert.equal(sleep.mindSymptomsProminentInRecord("心悸、失眠多梦、心烦、健忘", "乏力1月"), true);
  assert.equal(sleep.mindSymptomsProminentInRecord("入睡困难，多梦", "失眠2月"), true);
});

check("2.1", "治则只跟证名走：病性栏里另有脾虚、津亏、内寒不改变实证、虚证的治则", () => {
  const withColumns = (syndrome, method, root, branch) => ({
    overview: { primarySyndrome: syndrome, secondarySyndromes: [] }, therapy: { overallMethod: method },
    pathogenesis: { natureDifferentiation: { resolution: "resolved", items: [...root, ...branch], rootDeficiency: root, branchExcess: branch } },
  });
  assert.equal(nationalTreatmentPrinciple("实则泻之", withColumns("肝气犯胃证", "疏肝解郁，理气止痛", ["脾虚"], ["气滞"])), "实则泻之");
  assert.equal(nationalTreatmentPrinciple("热者寒之", withColumns("风热外袭证", "疏风清热，消肿利咽", ["津亏"], ["风热"])), "热者寒之");
  assert.equal(nationalTreatmentPrinciple("虚则补之", withColumns("脾胃虚寒证", "温中健脾，和胃止痛", ["阳虚", "气虚"], ["内寒"])), "虚则补之");
  assert.notEqual(nationalTreatmentPrinciple("寒者热之", withColumns("寒凝血瘀证", "温经散寒，化瘀止痛", ["阳虚"], ["寒", "血瘀"])), "扶正祛邪");
});

check("3.1", "两脏同虚的证名，治法缺一脏时从国标术语补一条；已到上限、两脏都有、不是两脏同虚时不动", () => {
  const governed = new Set(governedFourCharacterMethodTerms());
  const floored = withTwoOrganMethodFloor("益气固表，补肺止咳", "肺脾两虚证", 3);
  assert.equal(floored.split("，").length, 3);
  assert.ok(floored.startsWith("益气固表，补肺止咳，"));
  assert.ok(/脾/.test(floored.split("，")[2]) && governed.has(floored.split("，")[2]), floored);
  assert.equal(withTwoOrganMethodFloor(floored, "肺脾两虚证", 3), floored);
  assert.equal(withTwoOrganMethodFloor("补肺固表，健脾益气", "肺脾两虚证", 3), "补肺固表，健脾益气");
  // 条数到上限：不加条，把只写肾的那一项换成两脏合写的国标术语。
  assert.equal(withTwoOrganMethodFloor("滋肾益阴，育阴潜阳，养心安神", "肝肾阴虚证", 3), "滋补肝肾，育阴潜阳，养心安神");
  assert.equal(withTwoOrganMethodFloor("滋补肝肾，育阴潜阳，养心安神", "肝肾阴虚证", 3), "滋补肝肾，育阴潜阳，养心安神");
  assert.equal(withTwoOrganMethodFloor("益气养血，调经止痛，温经散寒", "肝肾阴虚证", 3), "益气养血，调经止痛，温经散寒");
  assert.ok(governed.has(twoOrganMethodFloorItem("肝肾阴虚证", "滋肾益阴，育阴潜阳")) && /肝/.test(twoOrganMethodFloorItem("肝肾阴虚证", "滋肾益阴，育阴潜阳")));
  assert.ok(/阳/.test(twoOrganMethodFloorItem("脾肾阳虚证", "温肾助阳")));
  assert.equal(twoOrganMethodFloorItem("肝胃不和证", "疏肝理气"), undefined);
  assert.equal(twoOrganMethodFloorItem("气血两虚证", "益气养血"), undefined);
  assert.equal(twoOrganMethodFloorItem("心脾两虚证", "益气养血"), undefined);
  assert.equal(twoOrganMethodFloorItem("肺脾两虚证", "补中益气，补肺固表"), undefined);
  assert.match(readFileSync(root + "/src/lib/delivered-surface.ts", "utf8"), /withTwoOrganMethodFloor\(therapy\.overallMethod, overviewRecord\.primarySyndrome/);
});

check("4.1", "西医依据里讲命名方式的半句删掉，前半句保留", () => {
  assert.equal(tidiedWesternBasis("乏力1年，缺乏血常规、甲状腺功能等客观结果，暂不能确立具体病种，故写症状名待查。"),
    "乏力1年，缺乏血常规、甲状腺功能等客观结果，暂不能确立具体病种。");
  assert.equal(tidiedWesternBasis("头晕发热，缺乏影像等客观依据，尚不能指向具体病种，故暂以症状名待查。"), "头晕发热，缺乏影像等客观依据，尚不能指向具体病种。");
  assert.equal(tidiedWesternBasis("胃镜示慢性萎缩性胃炎，诊断明确。"), "胃镜示慢性萎缩性胃炎，诊断明确。");
  assert.equal(tidiedWesternBasis("一年内感冒约九次，故按反复上呼吸道感染考虑。", "患者年龄：78岁\n主诉：反复感冒1+年"), "一年内感冒约九次，故按反复感冒考虑。");
  assert.equal(tidiedWesternBasis("一年内感冒约九次，故按反复上呼吸道感染考虑。", "患者年龄：4岁\n主诉：反复感冒1年"), "一年内感冒约九次，故按反复上呼吸道感染考虑。");
});

check("5.1", "病历写明既往已确诊：依据写成「既往已确诊X；…；本次未复查Y」，不再说尚需核实", () => {
  const record = "主诉：双膝疼痛、屈伸不利2年\n现病史：患者2年前无明显诱因出现双膝关节隐痛、酸软无力，伴屈伸不利，遇劳加重。\n既往史：有\"膝骨关节炎\"病史2年，否认类风湿及痛风史";
  const settled = settleWesternDiagnosisBasis("膝骨关节炎", "老年女性双膝隐痛、屈伸不利2年，负重活动加重、休息减轻，符合膝骨关节炎的机械性疼痛特点；但缺乏影像学与关节查体记录，故尚需核实。", record);
  assert.equal(settled.name, "膝骨关节炎");
  assert.match(settled.basis, /^既往已确诊膝骨关节炎；/);
  assert.match(settled.basis, /本次未复查影像学与关节查体。$/);
  assert.doesNotMatch(settled.basis, /尚需核实|缺乏/);
  // 实链里模型的写法：「既往已有该病诊断；但缺影像与查体支撑，故置信度中等」（交付面稍后把「置信度中等」换成「尚需核实」）。
  const live = settleWesternDiagnosisBasis("膝骨关节炎", "双膝慢性疼痛2年，符合膝骨关节炎的机械性疼痛特征；既往已有该病诊断；但缺影像与查体支撑，故置信度中等。", record);
  assert.match(live.basis, /既往已有该病诊断；本次未复查影像与查体。$/);
  // 对照：病历没有既往确诊时不加这句话。
  const fresh = settleWesternDiagnosisBasis("膝骨关节炎待查", "双膝隐痛2年，缺乏影像学记录，故尚需核实。", "主诉：双膝疼痛2年\n现病史：双膝隐痛2年。\n既往史：既往体健");
  assert.doesNotMatch(fresh.basis, /既往已确诊/);
});

check("5.2", "病名待查而依据写「可临床诊断」（后面不带病名）：照第五十九轮口径去掉这一小句，名与依据都是待查；病名不因依据去掉待查", () => {
  const record = "主诉：发热、头昏、胸闷、恶心1天\n现病史：高温环境下劳作后出现发热、头昏。";
  const settled = settleWesternDiagnosisBasis("中暑待查", "高温暴露后发热头昏，符合中暑的临床特点；依据高温暴露史与典型症状可临床诊断，尚需与热射病、急性胃肠炎鉴别。", record);
  assert.equal(settled.name, "中暑待查");
  assert.doesNotMatch(settled.basis, /可临床诊断/);
  assert.match(settled.basis, /符合中暑的临床特点/);
  assert.match(settled.basis, /尚需与热射病、急性胃肠炎鉴别/);
  // 对照：病名不带待查时依据照留。
  assert.match(settleWesternDiagnosisBasis("中暑", "高温暴露后发热头昏，依据高温暴露史与典型症状可临床诊断。", record).basis, /可临床诊断/);
});

check("6.1", "病历写「曾服」：不向病人要现用剂量与频次", () => {
  const item = { kind: "self_medication", name: "仙灵骨葆", base: "仙灵骨葆", composition: [] };
  assert.equal(withOnlyPrescribedOverlap("您曾服仙灵骨葆，请告知医生现用剂量与频次，新增中药合用前由医生或药师核对。", item, new Set()),
    "您曾服仙灵骨葆，如目前仍在服用请告知医生，新增中药合用前由医生或药师核对。");
  assert.equal(withOnlyPrescribedOverlap("您正在服用的仙灵骨葆请告知医生剂量与频次。", item, new Set()), "您正在服用的仙灵骨葆请告知医生剂量与频次。");
});

check("6.2", "已有点出药名的孕期提示时，后面重复的孕期慎用句不留；带其他内容的句子保留", () => {
  const named = "如已怀孕、可能怀孕或正在哺乳，须服药前告知医生。牡丹皮为孕妇慎用药。";
  assert.deepEqual(withinPrecautionCap([named, "本方饭后温服。", "方中牡丹皮等孕期慎用，备孕者请先告知医生。"]), [named, "本方饭后温服。"]);
  assert.deepEqual(withinPrecautionCap(["如已怀孕或备孕请先告知医生。", "方中牡丹皮等孕期慎用，备孕者请先告知医生。"]).length, 2);
  assert.deepEqual(withinPrecautionCap([named, "孕期如出现阴道出血请立即就医。"]).length, 2);
});

check("7.1", "整份病例读出的在用抗凝药按接地正文登记，开方合同凭正文也读得到", () => {
  const using = normalizeCaseStateInput({ chiefComplaint: "心悸1月", patient: { sex: "男", age: 66 },
    symptoms: { 现病史: "阵发心悸1月，住院期间对症治疗后出院。出院予利伐沙班片抗凝治疗。", 既往史: "阵发性心房颤动" } });
  const plain = normalizeCaseStateInput({ chiefComplaint: "心悸1月", patient: { sex: "男", age: 66 }, symptoms: { 现病史: "阵发心悸1月，未服药。", 既往史: "既往体健" } });
  assert.equal(safety.currentAntithromboticTherapyRecorded(using), true);
  const textA = "r1081 登记用接地正文甲：阵发心悸1月。", textB = "r1081 登记用接地正文乙：阵发心悸1月。";
  assert.equal(safety.currentAntithromboticTherapyRecorded(textA), false);
  safety.registerCurrentAntithromboticTherapy([textB], plain);
  assert.equal(safety.currentAntithromboticTherapyRecorded(textB), false);
  safety.registerCurrentAntithromboticTherapy([textA], using);
  assert.equal(safety.currentAntithromboticTherapyRecorded(textA), true);
  assert.match(readFileSync(root + "/src/app/api/diagnosis/prescribe/route.ts", "utf8"), /registerCurrentAntithromboticTherapy\(\[groundingText, structuredClinicalContext, clinicalGroundingText\(gated\)\], gated\)/);
});

check("8.1", "与年龄不符的婚育月经记录不进调护、随访写作读的个人史；成人照常", () => {
  const child = normalizeCaseStateInput({ chiefComplaint: "咳嗽3天", patient: { sex: "女", age: 1 },
    symptoms: { 现病史: "咳嗽3天，咽干。", 个人史: "足月顺产，月经周期 13天，有痛经史", 婚育史: "配偶体健，备孕" } });
  const cleaned = safety.withoutAgeImplausibleReproductiveStatements("足月顺产，月经周期 13天，有痛经史", child);
  assert.doesNotMatch(cleaned, /月经|痛经/);
  assert.match(cleaned, /足月顺产/);
  const adult = normalizeCaseStateInput({ chiefComplaint: "咳嗽3天", patient: { sex: "女", age: 30 }, symptoms: { 现病史: "咳嗽3天。", 个人史: "月经周期 28天，有痛经史" } });
  assert.equal(safety.withoutAgeImplausibleReproductiveStatements("月经周期 28天，有痛经史", adult), "月经周期 28天，有痛经史");
  assert.match(readFileSync(root + "/src/lib/m05-followup-authoring.server.ts", "utf8"), /withoutAgeImplausibleReproductiveStatements\(value, state\)/);
});

check("9.1", "方名依据不足而调用方的剥离没有改动时，剥成自拟方、药味剂量照留，不退成不给剂量", () => {
  const reasoning = { stage: "prescribe", formula: { candidates: [{ name: "归肾丸", constructionType: "named", formulaNames: ["归肾丸"], baseFormulas: ["归肾丸"],
    herbs: [{ name: "熟地黄", dose: "15g", role: "君" }, { name: "菟丝子", dose: "12g", role: "君" }, { name: "枸杞子", dose: "10g", role: "臣" }] }] } };
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const parse = (text) => JSON.parse(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/.exec(text)[1]).formula.candidates[0];
  const issueOf = (text) => (parse(text).identityDeclassified === true ? undefined : "named_formula_positive_sufficiency_missing:归肾丸");
  const salvaged = salvageM04Content(content, { prior: prior("月经过少", "肾阳虚证"), clinicalContext: "月经量少半年", issueOf, declassify: (text) => text });
  assert.ok(salvaged, "调用方的剥离不改动时仍要保底");
  const candidate = parse(salvaged.content);
  assert.equal(candidate.name, "自拟方");
  assert.equal(candidate.identityDeclassified, true);
  assert.deepEqual(candidate.herbs.map((herb) => `${herb.name}${herb.dose}`), ["熟地黄15g", "菟丝子12g", "枸杞子10g"]);
  // 对照：调用方的剥离已经解决问题时用它的结果（记成「X加减」），不再剥成自拟方。
  const viaCaller = salvageM04Content(content, { prior: prior("月经过少", "肾阳虚证"), clinicalContext: "月经量少半年",
    issueOf: (text) => (parse(text).name === "归肾丸加减" ? undefined : "named_formula_positive_sufficiency_missing:归肾丸"),
    declassify: (text) => text.replace('"name":"归肾丸"', '"name":"归肾丸加减"') });
  assert.equal(parse(viaCaller.content).name, "归肾丸加减");
});

check("9.2", "栝楼、栝蒌、瓜蒌三种写法是同一首方的身份（d084 乳痈：锁「栝楼牛蒡汤」、候选库「瓜蒌牛蒡汤」）；别的字不归一", () => {
  assert.equal(normalizedFormulaIdentity("栝楼牛蒡汤"), normalizedFormulaIdentity("瓜蒌牛蒡汤"));
  assert.equal(normalizedFormulaIdentity("栝蒌薤白半夏汤加减"), "瓜蒌薤白半夏汤");
  assert.notEqual(normalizedFormulaIdentity("归脾汤"), normalizedFormulaIdentity("归肾丸"));
  assert.match(readFileSync(root + "/src/lib/tcm-formula-indications.ts", "utf8"), /allowedNames\.some\(\(other\) => sameFormulaNameSpelling\(other, normalizedFormulaIdentity\(name\)\)\)/);
});


// —— 第六十二轮第二批：本机 100 份交付病历逐字阅卷后服务端那几类（每条反证见 ~/runlogs/r1018/work/r1081/cp/）。——
const rp = await jiti.import("../src/lib/required-precautions.server.ts");
const { requiredPrecautionLineForTest, withoutRepeatedAnalysisSentence, triggerWithoutCourse, recordMedicineNames } = await jiti.import("../src/lib/delivered-surface.ts");
const decoction = await jiti.import("../src/lib/herb-decoction-rules.ts");
const { textbookOcrFixed } = await jiti.import("../src/lib/nondrug-text-fixes.ts");
const { withoutBareMenstrualAttributeTerms } = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
const { withoutDerivedRootItems, classifyNatureColumns } = await jiti.import("../src/lib/nature-column-classification.ts");
const { diseaseDefiningFindingStatus } = await jiti.import("../src/lib/tcm-disease-defining-findings.ts");
const { reconcileAnalysisUncertainties } = await jiti.import("../src/lib/pathogenesis-columns.ts");
const { textbookTreatmentPlan } = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
const caseOf = (chief, present, extra = {}) => normalizeCaseStateInput({ chiefComplaint: chief, patient: { sex: "男", age: 50 }, symptoms: { 现病史: present }, ...extra });

check("10.1", "活动性出血时病历里自服的非甾体抗炎药写立即停用；没出血、阿司匹林、外用剂型不写", () => {
  const items = rp.requiredPrecautionsForCase(caseOf("呕血黑便1天", "1天前饮酒后呕吐咖啡色液体2次，排黑便3次，自服布洛芬缓释胶囊止痛。"), undefined);
  const stop = items.find((item) => item.kind === "bleeding_stop_drug");
  assert.deepEqual(stop?.names, ["布洛芬缓释胶囊"]);
  assert.ok(!items.some((item) => item.kind === "self_medication" && item.name === "布洛芬缓释胶囊"), "同一味药不再另写自服一条");
  assert.match(requiredPrecautionLineForTest(stop), /布洛芬缓释胶囊会加重出血，请立即停用/u);
  assert.ok(!rp.requiredPrecautionsForCase(caseOf("腰痛3天", "腰痛3天，自服布洛芬缓释胶囊止痛，无呕血黑便。"), undefined).some((item) => item.kind === "bleeding_stop_drug"));
  const bleedingWith = (drugClause) => rp.requiredPrecautionsForCase(caseOf("呕血黑便1天", `1天前饮酒后呕吐咖啡色液体2次，排黑便3次，${drugClause}`), undefined);
  assert.ok(safety.activeBleedingInGroundingText(safety.clinicalGroundingText(caseOf("呕血黑便1天", "1天前饮酒后呕吐咖啡色液体2次，排黑便3次。"))), "夹具本身是活动性出血");
  assert.ok(!bleedingWith("膝关节外用双氯芬酸二乙胺乳胶剂。").some((item) => item.kind === "bleeding_stop_drug"), "外用剂型不算");
  assert.ok(!bleedingWith("自行外用布洛芬乳膏涂膝关节。").some((item) => item.kind === "bleeding_stop_drug"), "剂型不在末尾的外用写法也不算");
  assert.ok(!bleedingWith("长期口服阿司匹林肠溶片100mg每日1次。").some((item) => item.kind === "bleeding_stop_drug"), "抗血小板药是否暂停由医生定，不在此列");
  assert.deepEqual(bleedingWith("自服布洛芬缓释胶囊，并外涂双氯芬酸钠凝胶。").find((item) => item.kind === "bleeding_stop_drug")?.names, ["布洛芬缓释胶囊"]);
});

check("10.2", "服药后过敏观察：病历有皮损才问「皮损与原有表现不同」，没有的只写新出现皮疹瘙痒", () => {
  const cough = safety.buildForcedIncompleteRiskFollowup(caseOf("咳嗽3天", "3天前受凉后咳嗽，咯白痰，无发热。"));
  assert.doesNotMatch(cough, /皮损与原有表现不同/u);
  assert.match(cough, /如服药后新出现皮疹或瘙痒/u);
  const eczema = safety.buildForcedIncompleteRiskFollowup(caseOf("双手皮疹瘙痒3月", "3个月前双手背出现丘疹、红斑，瘙痒，搔抓后渗液。"));
  assert.match(eczema, /皮损与原有表现不同/u);
});

check("10.3", "随访复诊重点只取病历原话：交付的一整句西医依据不当症状", () => {
  const state = { ...caseOf("呕血黑便1天", "1天前饮酒后呕吐暗红色血液2次，解柏油样便1次。"),
    reasoningDiagnose: { westernDiagnosis: { primary: { supportingFacts: ["既往胃镜确诊溃疡，本次呕血黑便符合其出血表现，考虑十二指肠球部溃疡伴出血"] } },
      overview: { primarySyndromeBasis: ["呕吐暗红色血液2次"] } } };
  const facts = safety.structuredFollowupInputs(state).coreFacts;
  assert.ok(!facts.some((fact) => fact.includes("符合其出血表现")), facts.join("|"));
  assert.ok(facts.includes("呕吐暗红色血液2次"));
  const quoted = { ...caseOf("咳嗽3天", "咳嗽3天，咯白痰。"), reasoningDiagnose: { westernDiagnosis: { primary: { supportingFacts: ["咯白痰"] } } } };
  assert.ok(safety.structuredFollowupInputs(quoted).coreFacts.includes("咯白痰"), "病历原话照收");
});

check("10.4", "玄明粉按药典写溶入煎好的药液，写作溶化、冲服也算交代了", () => {
  const rule = decoction.decoctionRuleForHerb("玄明粉");
  assert.deepEqual(rule?.oneOf, [["溶入", "溶化", "冲服"]]);
  assert.equal(decoction.decoctionRuleSatisfied("玄明粉", "溶化"), true);
  assert.equal(decoction.decoctionRuleSatisfied("玄明粉", ""), false);
  const index = decoction.specialDecoctionOrderIndex("玄明粉");
  assert.match(decoction.SPECIAL_DECOCTION_ORDER[index].phrase("玄明粉"), /玄明粉溶入煎好的药液中服/u);
});

check("10.5", "耳穴、拔罐卡没有本节频次时写教材总论的次数，不写「首次安排一次面诊治疗」", () => {
  const plan = textbookTreatmentPlan({ projectCode: "auricular", diseaseNames: ["感冒"], westernNames: [], signedSyndromeText: "风寒束表证", currentFacts: "恶寒发热，鼻塞流清涕，咳嗽", patientAgeYears: 40 });
  assert.ok(plan, "感冒有耳穴卡");
  assert.doesNotMatch(String(plan.scheduleSuggestion), /首次安排一次面诊治疗/u);
  assert.match(String(plan.scheduleSuggestion), /压丸：可留置2～4天，期间可嘱患者每日自行按压2～3次/u);
  const cupping = textbookTreatmentPlan({ projectCode: "cupping", diseaseNames: ["咳嗽"], westernNames: [], signedSyndromeText: "风寒袭肺证", currentFacts: "咳嗽，咯白痰，恶寒", patientAgeYears: 40 });
  assert.ok(cupping, "咳嗽有拔罐卡");
  assert.doesNotMatch(String(cupping.scheduleSuggestion), /首次安排一次面诊治疗/u);
  assert.match(String(cupping.scheduleSuggestion), /可每日1次或隔日1次/u);
  assert.equal(textbookOcrFixed("篇蓄粥：篇蓄30g"), "萹蓄粥：萹蓄30g");
});

check("10.6", "月经属性名（经期、经量、月经）不单独当本例表现；和异常连写的照列", () => {
  assert.deepEqual(withoutBareMenstrualAttributeTerms(["经期", "经量", "月经"], "月经周期28天，经期4天，经量中等，色暗"), []);
  assert.deepEqual(withoutBareMenstrualAttributeTerms(["经量", "小腹冷痛"], "经量偏少，色暗有块，小腹冷痛"), ["经量偏少", "小腹冷痛"]);
  assert.deepEqual(withoutBareMenstrualAttributeTerms(["经期", "经量"], "经期无腹痛，经量偏少"), ["经量偏少"], "否认的不算异常");
});

check("10.7", "方义紧挨着重复的一句去掉；不相邻或不同的句子照留", () => {
  assert.equal(withoutRepeatedAnalysisSentence("本方以越婢加半夏汤为基础，加桑白皮、苦杏仁、桔梗。加桑白皮、苦杏仁、桔梗。麻黄与石膏为君。"),
    "本方以越婢加半夏汤为基础，加桑白皮、苦杏仁、桔梗。麻黄与石膏为君。");
  const kept = "麻黄为君。石膏为臣。麻黄为君，宣肺。";
  assert.equal(withoutRepeatedAnalysisSentence(kept), kept);
});

check("10.8", "本虚栏里虚火、虚热有阴虚在就不单列，虚寒有阳虚在就不单列；没有来源条目时照留", () => {
  assert.deepEqual(withoutDerivedRootItems(["阴虚", "虚火"]), ["阴虚"]);
  assert.deepEqual(withoutDerivedRootItems(["肾阴虚", "虚热", "虚火"]), ["肾阴虚"]);
  assert.deepEqual(withoutDerivedRootItems(["阳虚", "虚寒"]), ["阳虚"]);
  assert.deepEqual(withoutDerivedRootItems(["虚热"]), ["虚热"]);
  const nature = { items: ["阴虚", "虚火"], rootDeficiency: ["阴虚", "虚火"], branchExcess: [] };
  classifyNatureColumns(nature);
  assert.deepEqual(nature.rootDeficiency, ["阴虚"]);
  assert.ok(nature.items.includes("虚火"), "病性条目不动");
});

check("10.9", "引用的睡眠呼吸暂停筛查项写中文，不写英文缩写", () => {
  const gate = safety.evaluateSafetyGate(caseOf("失眠3月", "入睡困难3个月，多梦易醒。"));
  const text = gate.missingItems.join("、");
  assert.match(text, /睡眠呼吸暂停风险筛查/u);
  assert.doesNotMatch(text, /OSA/u);
});

check("10.10", "触发条件去病程尾巴：数字区间和「每次N天」这类属性时长不删", () => {
  assert.equal(triggerWithoutCourse("本例已见月经量多、每次7-8天"), "本例已见月经量多、每次7-8天");
  assert.equal(triggerWithoutCourse("本例已见经期7天"), "本例已见经期7天");
  assert.equal(triggerWithoutCourse("本例已见头晕2月"), "本例已见头晕");
});

check("10.11", "定义性表现「部位＋痛」中间隔一两个修饰字也算写到；否认、隔着标点不算", () => {
  assert.equal(diseaseDefiningFindingStatus("胃痛", "患者2天前贪凉饮冷后出现胃脘拘急作痛，阵发加重。").status, "supported");
  assert.equal(diseaseDefiningFindingStatus("胃痛", "胃脘部隐隐作痛半月。").status, "supported");
  assert.equal(diseaseDefiningFindingStatus("胃痛", "腹泻2天。无胃脘作痛，大便稀。").status, "missing");
  assert.equal(diseaseDefiningFindingStatus("胃痛", "胃脘胀满3天，无疼痛。").status, "missing");
  assert.equal(diseaseDefiningFindingStatus("胃痛", "头晕1周，胃脘不痛。").status, "missing");
  assert.equal(diseaseDefiningFindingStatus("胃痛", "不慎受凉后胃脘拘急作痛2天。").status, "supported", "小句前半的「不慎」不是否认");
  assert.equal(diseaseDefiningFindingStatus("胃痛", "未见呕吐及胃脘作痛。").status, "missing");
});

check("10.12", "待核实一栏：理由就是病历原话（没说缺什么）的去掉；「舌红脉数支持」病历两项都写着的去掉；真缺的照留", () => {
  const record = "从事餐饮工作，双手常接触水及洗涤剂。舌红，苔薄黄，脉数。";
  const reasoning = { overview: { primarySyndrome: "风伤肠络证", secondarySyndromes: [] }, pathogenesis: { uncertainties: [
    { item: "接触诱因", reason: "双手常接触水及洗涤剂", affects: "防护建议" },
    { item: "舌红脉数支持", reason: "尚需核实舌红脉数支持", affects: "证候细节" },
    { item: "出血量变化", reason: "仅记录量少数滴，未观察动态", affects: "复查节奏" },
  ] } };
  reconcileAnalysisUncertainties(reasoning, record);
  assert.deepEqual(reasoning.pathogenesis.uncertainties.map((row) => row.item), ["出血量变化"]);
});

check("10.13", "注意事项按药味表对齐药名时，病历里引号或剂型写着的药名不改（「藿香正气水」不成「广藿香正气水」）", () => {
  const names = recordMedicineNames("自服“藿香正气水”2支，另服复方炙甘草口服溶液。");
  assert.ok(names.includes("藿香正气水"), names.join("|"));
  assert.ok(names.some((name) => name.startsWith("复方炙甘草")), names.join("|"));
});


check("10.14", "安全层的四处读法：乳房无肿块不排乳腺癌、白天无尿失禁不是无尿、慢性声嘶不算气道受累、婴儿呼吸按 PALS 分档", () => {
  assert.equal(safety.unevaluatedBreastMassText("双侧乳房周期性胀痛，经后消退，未触及肿块。", 38, "女"), false);
  assert.equal(safety.unevaluatedBreastMassText("左乳无肿块，乳房胀痛1月。", 45, "女"), false);
  assert.equal(safety.unevaluatedBreastMassText("左乳外上触及一肿块2周，无痛。", 45, "女"), true);
  assert.equal(safety.unevaluatedBreastMassText("左乳触及一不规则肿块1月，质硬。", 52, "女"), true, "「不规则」不是否认");
  assert.equal(safety.unevaluatedBreastMassText("左乳无痛性结节1个月。洗澡时触及无痛肿块，近月无明显增大。", 45, "女"), true, "「无痛性」不是否认（甲方 100 例 C069）");
  assert.equal(safety.unevaluatedBreastMassText("右乳房上有一个像胡桃一样大小的结节，乳头溢血。", 45, "女"), true, "同一小句里部位与肿块隔得远一些也认");
  assert.equal(safety.unevaluatedBreastMassText("自查乳房未触及明显肿块，乳房胀痛。", 40, "女"), false);
  const advisories = (state) => safety.evaluateSafetyGate(state).advisories.join("；");
  const enuresis = normalizeCaseStateInput({ chiefComplaint: "夜间遗尿1年", patient: { sex: "男", age: 7 }, symptoms: { 现病史: "夜间遗尿每周3-4次，白天无尿失禁，无尿痛。" }, vitals: { T: "36.6", P: "88", R: "20", BP: "100/62" } });
  assert.doesNotMatch(advisories(enuresis), /循环灌注异常/u);
  const anuria = normalizeCaseStateInput({ chiefComplaint: "腹泻呕吐2天", patient: { sex: "男", age: 70 }, symptoms: { 现病史: "腹泻呕吐2天，今日无尿，乏力。" } });
  assert.match(advisories(anuria), /循环灌注异常/u);
  const hoarse = normalizeCaseStateInput({ chiefComplaint: "声音嘶哑2月", patient: { sex: "女", age: 45 }, symptoms: { 现病史: "干咳少痰、声音嘶哑2月，咽干。" }, vitals: { T: "36.5", P: "76", R: "16", BP: "118/72" } });
  assert.doesNotMatch(advisories(hoarse), /严重过敏或气道受累/u);
  const acute = normalizeCaseStateInput({ chiefComplaint: "吃海鲜后皮疹1小时", patient: { sex: "女", age: 30 }, symptoms: { 现病史: "1小时前进食海鲜后全身风团，伴声音嘶哑、喉紧。" } });
  assert.match(advisories(acute), /严重过敏或气道受累/u);
  const infant = (rr) => normalizeCaseStateInput({ chiefComplaint: "咳嗽2天", patient: { sex: "男", age: "8个月" }, symptoms: { 现病史: "咳嗽2天，无发热，吃奶可，精神好，无呼吸费力。" }, vitals: { T: "36.8", P: "120", R: String(rr) } });
  assert.doesNotMatch(advisories(infant(32)), /呼吸.{0,10}需尽快复测/u);
  assert.match(safety.evaluateSafetyGate(infant(52)).redFlags.join("；"), /呼吸 52次\/分/u, "WHO 快速呼吸线（2～12 月龄≥50）照旧是红旗");
  const toddler = (rr) => normalizeCaseStateInput({ chiefComplaint: "咳嗽2天", patient: { sex: "女", age: "2岁" }, symptoms: { 现病史: "咳嗽2天，无发热，精神好。" }, vitals: { T: "36.8", P: "110", R: String(rr) } });
  assert.doesNotMatch(advisories(toddler(34)), /呼吸.{0,10}需尽快复测/u);
  assert.match(advisories(toddler(38)), /呼吸 38次\/分需尽快复测/u);
});

const polarity = await jiti.import("../src/lib/clinical-polarity.ts");
check("10.15", "自服药名读法：维生素B12片、B2 等带编号的名字不截断；剂量与次数不进药名；长期规律服用的不算「曾自服」", () => {
  const names = polarity.selfTakenMedicationMentions("近1周自服维生素B12片1片每日1次，另自服维生素B2片。");
  assert.ok(names.some((name) => name.startsWith("维生素B12")), names.join("|"));
  assert.ok(names.some((name) => name.startsWith("维生素B2")), names.join("|"));
  assert.ok(!names.some((name) => /每日|1片/u.test(name)), names.join("|"));
  const items = rp.requiredPrecautionsForCase(caseOf("口干多饮1年", "糖尿病3年，长期规律服用盐酸二甲双胍片0.5g每日2次，近1月口干多饮。"), undefined);
  assert.ok(!items.some((item) => item.kind === "self_medication" && /二甲双胍/u.test(item.name)), JSON.stringify(items.map((item) => item.kind)));
});

check("10.16", "附子等久煎药的煎法只写时长，不让病人口尝药液", () => {
  const phrase = decoction.SPECIAL_DECOCTION_ORDER[0].phrase("制附子");
  assert.equal(phrase, "制附子先煎45–60分钟");
  assert.doesNotMatch(phrase, /口尝/u);
});

const authoring = await jiti.import("../src/lib/tcm-disease-differential-authoring.server.ts");
// 模型自提、教材里没有定义的中医病名鉴别：另一家模型摘出病历里两病都可见的表现（逐字）才收；判不成立、摘句对不上病历的不收。
{
  const record = "患者男，45岁。舌部溃疡伴红肿、疼痛2天，进食时加重。舌红，苔黄，脉数。";
  const rows = [{ diseaseName: "牙宣", reason: "口腔疼痛" }, { diseaseName: "舌岩", reason: "口腔局部病变" }];
  const ctx = { recordText: record, diseaseName: "口疮" };
  const deferred = new Set(["舌岩"]);
  const yes = await authoring.crossVerifiedDifferentials(rows, deferred, ctx, async () => ({ shared: "舌部溃疡伴红肿、疼痛", confirmed: true }));
  assert.deepEqual(yes.map((item) => item.diseaseName), ["牙宣", "舌岩"]);
  assert.match(yes[1].reason, /舌部溃疡伴红肿、疼痛/u, "相近之处写成病历原话");
  assert.equal(yes[0].reason, "口腔疼痛", "不需核的照原样");
  assert.deepEqual((await authoring.crossVerifiedDifferentials(rows, deferred, ctx, async () => ({ shared: "舌部溃疡", confirmed: false }))).map((item) => item.diseaseName), ["牙宣"], "另一家判不成立不收");
  assert.deepEqual((await authoring.crossVerifiedDifferentials(rows, deferred, ctx, async () => ({ shared: "舌体肿物质硬", confirmed: true }))).map((item) => item.diseaseName), ["牙宣"], "摘句对不上病历不收");
  assert.deepEqual((await authoring.crossVerifiedDifferentials(rows, deferred, ctx, async () => undefined)).map((item) => item.diseaseName), ["牙宣"], "核对失败不收");
  n += 1; console.log("✓ 10.17 模型自提、教材没有定义的鉴别病名：另一家摘出病历里两病共有的表现才收（带下过多、口疮、胬肉攀睛这类教材鉴别少的病）");
}

const boundary = await jiti.import("../src/lib/candidate-boundary-text.ts");
check("10.18", "逐味人群提示里模型照写的括注：本例不可能属于的人群去掉（41 岁男性不写「孕期/妊娠慎用」），一个不剩整条去掉；育龄女性照留", () => {
  const male = { sex: "男", ageYears: 41, pregnancy: false, lactation: false, reproductive: false };
  const woman = { sex: "女", ageYears: 30, pregnancy: true, lactation: true, reproductive: true };
  assert.equal(boundary.withoutIrrelevantPopulationCautions("枳壳（孕期/妊娠慎用）", male), "");
  assert.equal(boundary.withoutIrrelevantPopulationCautions("川芎（孕期/妊娠、出血倾向慎用）；牛膝（孕期/妊娠慎用）", male), "川芎（出血倾向慎用）");
  assert.equal(boundary.withoutIrrelevantPopulationCautions("枳壳（孕期/妊娠慎用）", woman), "枳壳（孕期/妊娠慎用）");
  assert.equal(boundary.withoutIrrelevantPopulationCautions("按本例情况已去除：附子（孕期不宜）", male), "按本例情况已去除：附子（孕期不宜）", "去除说明不动");
});
console.log(`r1081 main: ${n} checks passed`);
