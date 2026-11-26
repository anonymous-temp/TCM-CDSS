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

console.log(`r1081 main: ${n} checks passed`);
