// 第三十二轮（2026-10-31）：甲方 10.29 测评。
// 1. 接口里 clinicalFacts.redFlags 非空当且仅当闸门 red_flag；否认项不再亮他们的横幅。生命体征数值由代码按年龄段判，事实层读成「不稳」的不算。
// 2. 加减：同一味药按身份比（乌贼骨=海螵蛸）；教材少于两条时模型条件句也算；条件句与已记录舌脉相反不用；证名不在教材表时用这张方的教材加减；
//    寒热相配的教材条目不单拆寒药。
// 3. 方义：《方剂学》方解作依据；竹叶是淡竹叶的简称；每味都讲到；原方姜枣写进用法；同源药不并用。
// 4. 窄核对改「一个模型提名、另一厂商的模型只答这一处」：两边各自自由作答再取一致，把两次抽样相乘，真问题也常被漏掉。
// 5. 西医：症状层面才问已确诊慢性病；慢性失眠障碍写规范名；诊断标准表里的病名不往 ICD 同义词上归。
// 每条断言都有反证（~/runlogs/r1018/work/r1044/cp/）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const facts = await jiti.import("../src/lib/delivered-clinical-facts.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const analysis = await jiti.import("../src/lib/formula-analysis-review.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const commentary = await jiti.import("../src/lib/formula-textbook-commentary.ts");
const crossModel = await jiti.import("../src/lib/cross-model-small-task.server.ts");
const lens = await jiti.import("../src/lib/m03-lens-consistency.server.ts");
const method = await jiti.import("../src/lib/m03-method-coverage.server.ts");
const western = await jiti.import("../src/lib/western-name-standard.server.ts");

// ── 1. 红旗字段 ──────────────────────────────────────────────
const denial = { category: "other_critical", subject: "patient", status: "negative", urgency: "routine", triageBasis: "x", quote: "否认疫区旅居史" };
const emergency = { category: "cardiac", subject: "patient", status: "positive", urgency: "emergency", triageBasis: "x", quote: "突发剧烈胸痛" };
const urgent = { category: "gi_alarm", subject: "patient", status: "positive", urgency: "urgent", triageBasis: "x", quote: "体重略有下降" };

await check("1.1 没有红旗时 redFlags 为空，其余字段原样（否认、待评估都不进）", () => {
  const out = facts.deliveredClinicalFactsForApiCaller({ affirmedSymptoms: ["头晕"], redFlags: [denial, urgent] }, { status: "needs_information", redFlags: [] });
  assert.deepEqual(out.redFlags, []);
  assert.deepEqual(out.affirmedSymptoms, ["头晕"]);
});

await check("1.2 红旗时留患者本人的紧急阳性项，否认项不留", () => {
  const out = facts.deliveredClinicalFactsForApiCaller({ redFlags: [denial, urgent, emergency] }, { status: "red_flag", redFlags: ["胸痛"] });
  assert.deepEqual(out.redFlags, [emergency]);
});

await check("1.3 只由确定性规则判出的红旗：事实层没有紧急项或没有事实时也非空", () => {
  const withFacts = facts.deliveredClinicalFactsForApiCaller({ redFlags: [denial] }, { status: "red_flag", redFlags: ["血压 230/130"] });
  assert.equal(withFacts.redFlags.length, 1);
  assert.equal(withFacts.redFlags[0].quote, "血压 230/130");
  assert.equal(withFacts.redFlags[0].urgency, "emergency");
  const noFacts = facts.deliveredClinicalFactsForApiCaller(null, { status: "red_flag", redFlags: ["血压 230/130"] });
  assert.equal(noFacts.redFlags.length, 1);
  assert.equal(facts.deliveredClinicalFactsForApiCaller(null, { status: "ready", redFlags: [] }), null);
});

await check("1.4 真实路由：接口调用方拿到的 clinicalFacts.redFlags 与闸门一致；页面调用不投影", async () => {
  process.env.CDSS_CLINICAL_FACTS_BACKSTOP = "false";
  const { POST } = await jiti.import("../src/app/api/diagnosis/red-flags/route.ts");
  const call = async (caseState, headers = {}) => {
    const response = await POST(new Request("http://localhost/api/diagnosis/red-flags", {
      method: "POST", headers: { "content-type": "application/json", "x-cdss-customer-id": "r1044-customer", ...headers },
      body: JSON.stringify({ caseState }),
    }));
    assert.equal(response.status, 200);
    return response.json();
  };
  const critical = { id: "r1044-rf-1", chiefComplaint: "突发胸痛1小时", patient: { sex: "男", age: 60 }, symptoms: { 现病史: "1小时前突发胸痛，伴大汗" }, vitals: { T: "36.5", P: "130", R: "28", BP: "70/40", SpO2: "85%" } };
  const ordinary = { id: "r1044-rf-2", chiefComplaint: "失眠1月", patient: { sex: "女", age: 42 }, symptoms: { 现病史: "失眠多梦1月" }, vitals: { T: "36.5", P: "78", R: "18", BP: "120/76" } };
  for (const headers of [{ "x-cdss-api-token": "x" }, { authorization: "Bearer x" }]) {
    const red = await call(critical, headers);
    assert.equal(red.safetyGate.status, "red_flag");
    assert.ok(red.clinicalFacts.redFlags.length > 0, "红旗时非空");
    const calm = await call(ordinary, headers);
    assert.notEqual(calm.safetyGate.status, "red_flag");
    assert.equal((calm.clinicalFacts?.redFlags || []).length, 0, "没有红旗时为空");
  }
  const page = await call(critical);
  assert.equal(page.safetyGate.status, "red_flag");
  assert.equal(page.clinicalFacts ?? null, null, "页面调用不合成（回传的是带签名的完整记录）");
});

const vitalFinding = { category: "vital_instability", subject: "patient", status: "positive", urgency: "urgent", triageBasis: "x", quote: "呼吸 20次/分" };
await check("1.5 代码按年龄段核过都在线内：事实层的「生命体征不稳」不进闸门；有超线读数时保留", () => {
  const normal = { patient: { age: "40岁", gender: "女" }, vitals: { respiration: "20次/分", pulse: "80次/分", temperature: "36.6℃", bloodPressure: "120/80" }, clinicalFacts: { redFlags: [vitalFinding] } };
  assert.equal(safety.withoutCodeClearedVitalFindings(normal).clinicalFacts.redFlags.length, 0);
  const high = { ...normal, vitals: { ...normal.vitals, pulse: "135次/分", temperature: "39.5℃" } };
  assert.equal(safety.withoutCodeClearedVitalFindings(high).clinicalFacts.redFlags.length, 1);
});

await check("1.6 带合成升级理由的、没有数字的不动", () => {
  const vitals = { respiration: "20次/分", pulse: "80次/分", temperature: "36.6℃", bloodPressure: "120/80" };
  const reasoned = { patient: { age: "40岁" }, vitals, clinicalFacts: { redFlags: [{ ...vitalFinding, escalationRationale: "多项组合" }] } };
  assert.equal(safety.withoutCodeClearedVitalFindings(reasoned).clinicalFacts.redFlags.length, 1);
  const wordOnly = { patient: { age: "40岁" }, vitals, clinicalFacts: { redFlags: [{ ...vitalFinding, quote: "面色苍白大汗" }] } };
  assert.equal(safety.withoutCodeClearedVitalFindings(wordOnly).clinicalFacts.redFlags.length, 1);
});

await check("1.6b 还有别的紧急发现时不清（黑便+低血压+心率快）", () => {
  const vitals = { respiration: "20次/分", pulse: "80次/分", temperature: "36.6℃", bloodPressure: "120/80" };
  const bleeding = { category: "gi_bleed", subject: "patient", status: "positive", urgency: "urgent", triageBasis: "x", quote: "黑便3天" };
  const state = { patient: { age: "40岁" }, vitals, clinicalFacts: { redFlags: [vitalFinding, bleeding] } };
  assert.equal(safety.withoutCodeClearedVitalFindings(state).clinicalFacts.redFlags.length, 2);
  const negated = { ...bleeding, status: "negative" };
  assert.equal(safety.withoutCodeClearedVitalFindings({ ...state, clinicalFacts: { redFlags: [vitalFinding, negated] } }).clinicalFacts.redFlags.length, 1, "否认的不算");
});

await check("1.7 复诊首句的路径也用同一份核过的事实", () => {
  const source = readFileSync("src/lib/diagnosis-safety.ts", "utf8");
  assert.match(source, /collectPriorityEvaluationEntries\(withoutCodeClearedVitalFindings\(state\), trustedInputText\(state\)\)/);
});

await check("1.8 交给事实层的病历里生命体征带标签（裸的「生命体征：26」读不出是什么）", () => {
  const text = safety.trustedInputText({ chiefComplaint: "咳嗽", vitals: { respiration: "26次/分", bloodPressure: "120/80" } });
  assert.match(text, /呼吸[^\n]*26/);
  assert.match(text, /血压[^\n]*120\/80/);
  assert.doesNotMatch(text, /生命体征：26/);
});

// ── 2. 加减 ──────────────────────────────────────────────
const priorOf = (disease, syndrome, formulas = []) => ({
  stage: "diagnose",
  overview: { tcmDiseaseName: disease, primarySyndrome: syndrome, recommendedFormulaNames: formulas },
});

await check("2.1 教材条目按药的身份比：教材写乌贼骨，编译后叫海螵蛸也是这一条", () => {
  const prior = priorOf("胃痛", "脾胃虚寒证");
  assert.equal(contract.isTextbookConditionalModification("泛酸", "海螵蛸", prior), true);
  assert.equal(contract.isTextbookConditionalModification("泛酸", "乌贼骨", prior), true);
  assert.equal(contract.isTextbookConditionalModification("泛酸", "防风", prior), false);
});

await check("2.2 条件句的形状：症状变化可以；舌脉与另立证候不可以", () => {
  assert.equal(textbook.modelConditionalTriggerShape("若咳嗽较甚，痰稀色白"), true);
  assert.equal(textbook.modelConditionalTriggerShape("若舌红、脉细数"), false);
  assert.equal(textbook.modelConditionalTriggerShape("若兼气虚"), false);
  assert.equal(textbook.modelConditionalTriggerShape("复诊时"), false);
  // 恶寒甚、口渴多饮是症状，不是另立证候（governedSyndromeLabelAxes 曾把它们一并挡掉：回放 182 条）
  assert.equal(textbook.modelConditionalTriggerShape("若恶寒甚"), true);
  assert.equal(textbook.modelConditionalTriggerShape("若口渴多饮"), true);
});

await check("2.3 教材留下不足两条时模型条件句算合格；够两条时不算", () => {
  const prior = priorOf("胃痛", "脾胃虚寒证");
  const one = [{ trigger: "泛酸", herbName: "海螵蛸" }];
  assert.equal(contract.textbookModificationsThin(one, prior), true);
  assert.equal(contract.textbookModificationsThin([{ trigger: "泛酸", herbName: "海螵蛸" }, { trigger: "泛酸", herbName: "煅瓦楞子" }], prior), false);
});

await check("2.4 条件写的舌脉与本次已记录相反：不用（教材行也一样）", () => {
  const record = "舌淡，苔薄白，脉细弱";
  assert.equal(compiler.modificationConditionTonguePulseConflict("若兼有阴虚，而见舌红、脉细数", record), true);
  assert.equal(compiler.modificationConditionContradictsRecord("若兼有阴虚，而见舌红、脉细数", record), true);
});

await check("2.5 不相反的不拦：只有一边写、取值相同、条件不提舌脉", () => {
  assert.equal(compiler.modificationConditionTonguePulseConflict("若舌红", "脉细弱"), false, "病历没写舌");
  assert.equal(compiler.modificationConditionTonguePulseConflict("若脉细", "舌淡，脉细弱"), false, "条件没写脉率");
  assert.equal(compiler.modificationConditionTonguePulseConflict("若舌淡", "舌淡，苔薄白"), false);
  assert.equal(compiler.modificationConditionTonguePulseConflict("若头晕较甚", "舌淡，脉细弱"), false);
  assert.equal(compiler.modificationConditionTonguePulseConflict("若舌红、苔黄", "舌红，苔黄腻，脉数"), false);
});

await check("2.6 证名不在教材表、这张方在：用这张方的教材加减（同病优先）", () => {
  assert.equal(textbook.textbookRowForSyndrome("不寐", "心脾气血两虚证"), undefined, "前提：证名查不到行");
  const row = textbook.textbookRowForFormula("不寐", ["归脾汤"]);
  assert.ok(row && row.formulas.includes("归脾汤") && row.modifications.length > 0);
  assert.equal(row.disease, "不寐");
  assert.equal(textbook.textbookRowForFormula("不寐", []), undefined);
  assert.equal(textbook.textbookRowForFormula("不寐", ["不存在的方"]), undefined);
  const prompt = textbook.buildFormulaModificationContext("不寐", "心脾气血两虚证", ["归脾汤"]);
  assert.match(prompt, /教材加减/);
  assert.equal(textbook.buildFormulaModificationContext("不寐", "心脾两虚证", ["归脾汤"]), "", "证名查得到时走原来那段");
});

await check("2.6b 舌脉相反的教材条目不进开方提示词", () => {
  const syndrome = "肺卫不固证";
  const plain = textbook.buildTextbookFormulaContext("汗证", syndrome);
  assert.match(plain, /麦冬/, "前提：教材有这一条");
  const filtered = textbook.buildTextbookFormulaContext("汗证", syndrome, { recordText: "舌淡，苔薄白 脉细弱" });
  assert.doesNotMatch(filtered, /麦冬/);
  assert.match(filtered, /若气虚甚/);
  assert.match(textbook.buildTextbookFormulaContext("汗证", syndrome, { recordText: "舌红 脉细数" }), /麦冬/);
});

await check("2.7 这张方的教材加减算教材条目；别的方不算", () => {
  const row = textbook.textbookRowForFormula("不寐", ["归脾汤"]);
  const item = row.modifications.find((entry) => entry.herbs.length > 0 && entry.condition.length >= 2);
  const prior = priorOf("不寐", "心脾气血两虚证", ["归脾汤"]);
  assert.equal(contract.isTextbookConditionalModification(item.condition, item.herbs[0], prior), true);
  assert.equal(contract.isTextbookConditionalModification(item.condition, item.herbs[0], priorOf("不寐", "心脾气血两虚证", [])), false);
});

// ── 3. 方义 ──────────────────────────────────────────────
await check("3.1 每味都讲到：缺的补一句，放在总括句前；已讲到不动；重复调用不变", () => {
  const herbs = [
    { name: "金银花", role: "君", function: "疏散风热" },
    { name: "连翘", role: "君", function: "清热解毒" },
    { name: "淡竹叶", role: "佐", function: "清热生津" },
  ];
  const text = "金银花、连翘为君，疏散风热。全方共奏辛凉透表之功。";
  const out = analysis.withEveryHerbExplained(text, herbs);
  assert.match(out, /淡竹叶为佐，清热生津。全方共奏/);
  assert.equal(analysis.withEveryHerbExplained(out, herbs), out);
  assert.equal(analysis.withEveryHerbExplained("金银花、连翘为君。淡竹叶为佐。", herbs), "金银花、连翘为君。淡竹叶为佐。");
});

await check("3.2 简称算讲到（竹叶←淡竹叶）；有单独用量的不算（附子不是白附子）", () => {
  const herbs = [{ name: "淡竹叶", role: "佐", function: "清热生津" }];
  assert.equal(analysis.withEveryHerbExplained("芦根、竹叶清热生津。", herbs), "芦根、竹叶清热生津。");
  const out = analysis.withEveryHerbExplained("附子回阳救逆。", [{ name: "白附子", role: "佐", function: "祛风痰" }]);
  assert.match(out, /白附子为佐，祛风痰/);
});

await check("3.3 方解依据块给基础方的《方剂学》方解", () => {
  const block = commentary.formulaCommentaryPromptBlock(["银翘散"]);
  assert.match(block, /银翘散/);
  assert.match(block, /竹叶/);
  assert.equal(commentary.formulaCommentaryPromptBlock(["不存在的方"]), "");
});

await check("3.4 原方有姜枣引药、本方没列：用法里说明；列了、合方、自拟方都不说", () => {
  const herbs = ["人参", "白术", "黄芪", "茯苓", "龙眼肉", "当归", "远志", "酸枣仁", "木香", "甘草"].map((name) => ({ name }));
  assert.match(surface.omittedGuideHerbNote("归脾汤", herbs), /生姜、大枣为引/);
  assert.match(surface.omittedGuideHerbNote("归脾汤加减", herbs), /为引/);
  assert.equal(surface.omittedGuideHerbNote("归脾汤", [...herbs, { name: "生姜" }, { name: "大枣" }]), undefined);
  assert.equal(surface.omittedGuideHerbNote("自拟方", herbs), undefined);
  // 黄芪建中汤：方里有干姜，用法不再提生姜；大枣没列的还提大枣
  const note = surface.omittedGuideHerbNote("归脾汤", [...herbs, { name: "干姜" }]);
  assert.doesNotMatch(note, /生姜/);
  assert.match(note, /大枣/);
  assert.equal(surface.omittedGuideHerbNote("归脾汤合四物汤", herbs), undefined);
});

// ── 4. 窄核对 ──────────────────────────────────────────────
await check("4.1 复核答案只认 confirmed 布尔值", () => {
  assert.equal(crossModel.parseConfirmed('{"confirmed":true}'), true);
  assert.equal(crossModel.parseConfirmed('{"confirmed":false}'), false);
  assert.equal(crossModel.parseConfirmed('{"confirmed":"true"}'), undefined);
  assert.equal(crossModel.parseConfirmed("[]"), undefined);
  assert.equal(crossModel.parseConfirmed(""), undefined);
});

await check("4.2 流派句肯定落到鉴别项的分句删掉；否定的留下", () => {
  const out = lens.foreignLensClauseRemoved("温病学派看，本例暑湿初起，属湿温初起之轻证。", ["湿温"]);
  assert.doesNotMatch(out, /湿温/);
  assert.match(out, /暑湿初起/);
  const kept = "温病学派看，本例暑湿初起，不属湿温。";
  assert.equal(lens.foreignLensClauseRemoved(kept, ["湿温"]), kept);
});

await check("4.3 流派句按摘录删分句", () => {
  const out = lens.lensWithoutQuotes("温病学派看，本例暑湿初起，湿重于热、津液未伤。", ["湿重于热"]);
  assert.doesNotMatch(out, /湿重于热/);
  assert.match(out, /暑湿初起/);
});

await check("4.4 治法补项的提名要合格：2–4 字、没写过、两条逐字摘录、方中有这项功效", () => {
  const context = { method: "疏风散寒，宣肺止咳", recordText: "咳嗽痰多，色白质稀，晨起明显。", formulaNames: ["二陈汤"], rowComposition: ["半夏", "陈皮", "茯苓", "甘草"] };
  assert.equal(method.methodItemQualifies({ item: "化痰", quotes: ["咳嗽痰多", "色白质稀"] }, context), true);
  assert.equal(method.methodItemQualifies({ item: "化痰", quotes: ["咳嗽痰多"] }, context), false, "摘录不足两条");
  assert.equal(method.methodItemQualifies({ item: "化痰", quotes: ["咳嗽痰多", "病历没有的话"] }, context), false, "摘录不逐字");
  assert.equal(method.methodItemQualifies({ item: "化痰", quotes: ["咳嗽痰多，色白质稀"] }, context), true, "一条里写了两项也算两条");
  assert.equal(method.methodItemQualifies({ item: "止咳", quotes: ["咳嗽痰多", "色白质稀"] }, context), false, "已经写过");
  assert.equal(method.methodItemQualifies({ item: "活血化瘀", quotes: ["咳嗽痰多", "色白质稀"] }, context), false, "方中没有这项功效");
});

await check("4.5 治法核对先逐组列：只取没人管的组，排序保留", () => {
  const groups = method.parseUncoveredGroups(JSON.stringify({ groups: [
    { findings: ["咳嗽"], coveredBy: "宣肺止咳", item: "" },
    { findings: ["咯痰量多"], coveredBy: null, item: "化痰" },
    { findings: ["鼻塞"], coveredBy: null, item: "通窍" },
    { findings: ["乏力"], coveredBy: "益气", item: "补气" },
  ] }));
  assert.deepEqual(groups.map((group) => group.item), ["化痰", "通窍"]);
  assert.equal(method.parseUncoveredGroups("not json"), undefined);
  assert.deepEqual(method.parseUncoveredGroups("[]"), []);
});

await check("4.6 流派句的判断片段：逐字用它；换了字取最像的分句；不像不算", () => {
  const sentence = "本例病在卫分兼困中焦，未见营血分或津伤重证。";
  assert.equal(lens.lensClauseOfClaim(sentence, "病在卫分"), "病在卫分");
  assert.equal(lens.lensClauseOfClaim(sentence, "未见津伤重证"), "未见营血分或津伤重证");
  assert.equal(lens.lensClauseOfClaim(sentence, "湿重于热"), undefined);
  assert.equal(lens.lensClauseOfClaim(sentence, ""), undefined);
});

await check("4.7 流派句判断的解析：取第一条有反驳的；没有反驳是 null；根数组也认", () => {
  const parse = lens.parseLensClaims;
  assert.deepEqual(parse(JSON.stringify({ claims: [{ claim: "未入营血", against: null }, { claim: "湿重于热", against: "舌红苔黄腻" }] })), { lensQuote: "湿重于热", recordQuote: "舌红苔黄腻" });
  assert.equal(parse(JSON.stringify({ claims: [{ claim: "未入营血", against: null }] })), null);
  assert.equal(parse("[]"), null);
  assert.equal(parse("{}"), undefined);
});

await check("4.8 摘录带栏目名、舌脉两字片段", async () => {
  const quote = await jiti.import("../src/lib/verbatim-quote.ts");
  const record = "有高血压病史5年，规律服药。舌质红，苔黄腻 脉数";
  assert.equal(quote.quoteGroundedInText("既往史：有高血压病史5年", record), true);
  assert.equal(quote.quoteGroundedInText("个人史：有高血压病史5年", "无此内容"), false);
  assert.equal(quote.quoteGroundedInText("舌质红，苔黄腻；脉数", record), false, "默认片段至少三字");
  assert.equal(quote.quoteGroundedInText("舌质红，苔黄腻；脉数", record, { minPartChars: 2 }), true);
});

await check("4.9 治法补的一项经复核后，教材锚定接在后面；没有复核的不接；交付面去掉这个键", async () => {
  const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
  const base = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseName: "咳嗽", primarySyndrome: "风寒袭肺证", secondarySyndromes: [], recommendedFormulaDirection: "三拗汤合止嗽散加减" }, therapy: { overallMethod: "疏风散寒，宣肺止咳，化痰" }, pathogenesis: { chain: [] } };
  const kept = provenance.withDeterministicFormulaReferences({ ...base, therapy: { ...base.therapy, verifiedMethodItem: "化痰" } }, "咳嗽痰多");
  assert.match(kept.therapy.overallMethod, /化痰$/);
  assert.equal(kept.overview.overallTherapy, kept.therapy.overallMethod);
  const plain = provenance.withDeterministicFormulaReferences(base, "咳嗽痰多");
  assert.doesNotMatch(plain.therapy.overallMethod, /化痰/, "模型自己多写的项锚定时仍去掉");
  const twice = provenance.withDeterministicFormulaReferences(kept, "咳嗽痰多");
  assert.equal(twice.therapy.overallMethod, kept.therapy.overallMethod, "重复锚定不重复接");
  const inRow = provenance.withDeterministicFormulaReferences({ ...base, therapy: { ...base.therapy, verifiedMethodItem: "宣肺止咳" } }, "咳嗽痰多");
  assert.equal((inRow.therapy.overallMethod.match(/宣肺止咳/g) || []).length, 1, "教材治法里已有的不再接");
  const delivered = surface.projectDeliveredReasoning(kept);
  assert.equal(delivered.therapy.verifiedMethodItem, undefined);
  assert.match(delivered.therapy.overallMethod, /化痰/);
});

await check("4.10 并行核对的结果落到被别的核对改过的内容上：治法只接这一项；视角句还在才换", () => {
  const make = (rationale, method, extra = {}) => JSON.stringify({ overview: { tcmDiagnosticRationale: rationale, overallTherapy: method }, therapy: { overallMethod: method, ...extra } });
  const merged = JSON.parse(method.withVerifiedMethodItemFrom(make("依据。", "疏风散寒"), make("依据。", "疏风散寒，宣肺止咳，化痰", { verifiedMethodItem: "化痰" })));
  assert.equal(merged.therapy.overallMethod, "疏风散寒，化痰", "别的核对去掉的项不带回来");
  assert.equal(merged.overview.overallTherapy, "疏风散寒，化痰");
  assert.equal(merged.therapy.verifiedMethodItem, "化痰");
  const untouched = make("依据。", "疏风散寒");
  assert.equal(method.withVerifiedMethodItemFrom(untouched, make("依据。", "疏风散寒，宣肺")), untouched, "没有复核项不动");
  const before = make("主症为风寒。温病看，本例湿重于热，未入营血。", "x");
  const checked = make("主症为风寒。温病看，本例未入营血。", "x");
  const rewritten = make("主症风寒束表。温病看，本例湿重于热，未入营血。", "x");
  assert.equal(JSON.parse(lens.withLensFrom(rewritten, before, checked)).overview.tcmDiagnosticRationale, "主症风寒束表。温病看，本例未入营血。");
  const lensGone = make("主症风寒束表。", "x");
  assert.equal(lens.withLensFrom(lensGone, before, checked), lensGone, "视角句已不在");
  assert.equal(lens.withLensFrom(rewritten, before, before), rewritten, "核对没改");
});

// ── 5. 西医 ──────────────────────────────────────────────
await check("5.1 要不要问慢性病：症状层面与笼统综合征问，明确病名不问", () => {
  assert.equal(western.primaryNameIsSymptomLevel("头晕待查"), true);
  assert.equal(western.primaryNameIsSymptomLevel("眩晕综合征"), true);
  assert.equal(western.primaryNameIsSymptomLevel("眩晕"), true);
  assert.equal(western.primaryNameIsSymptomLevel("高血压病"), false);
  assert.equal(western.primaryNameIsSymptomLevel("急性胃炎"), false);
});

await check("5.2 提名要有依据：摘录逐字在病历里、写着这个病", () => {
  const record = "既往史：高血压病史10年，规律服药。";
  assert.equal(western.establishedDiseaseQualifies({ name: "高血压病", quote: "高血压病史10年" }, record), true);
  assert.equal(western.establishedDiseaseQualifies({ name: "冠心病", quote: "高血压病史10年" }, record), false);
  assert.equal(western.establishedDiseaseQualifies({ name: "高血压病", quote: "糖尿病史" }, record), false);
  assert.equal(western.establishedDiseaseQualifies({ name: "高血压病", quote: "高血压病史3年" }, record), false, "摘录不逐字");
  assert.equal(western.establishedDiseaseQualifies({ name: "高血压病待查", quote: "高血压病待查" }, "既往史：高血压病待查。"), false, "待查不算已确诊");
});

await check("5.3 规范写法：慢性失眠障碍 → 慢性失眠（保留待查）；红旗病例不问慢性病", async () => {
  const content = (name) => JSON.stringify({ westernDiagnosis: { primary: { name, clinicalRationale: "x" }, candidates: [], differentials: [] } });
  const out = JSON.parse(await western.finalizeWesternPrimaryName(content("慢性失眠障碍"), { recordText: "失眠2年", redFlag: true }));
  assert.equal(out.westernDiagnosis.primary.name, "慢性失眠");
  const pending = JSON.parse(await western.finalizeWesternPrimaryName(content("慢性失眠障碍待查"), { recordText: "失眠2年", redFlag: true }));
  assert.equal(pending.westernDiagnosis.primary.name, "慢性失眠待查");
});

await check("5.4 诊断标准表里的病名不往 ICD 同义词上归（围绝经期综合征）", () => {
  assert.equal(western.icdSynonymEligible("围绝经期综合征"), false);
  assert.equal(western.icdSynonymEligible("高血压病"), false, "ICD 查得到的不用归");
  assert.equal(western.icdSynonymEligible("某未收录综合征"), true);
});

await check("5.5 字面相近的 ICD 候选按相似度取", () => {
  const candidates = western.icdLexicalCandidates("慢性失眠");
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((name) => /失眠|慢性/.test(name)));
});

// ── 6. 证候、同源药、寒热相配 ──────────────────────────────────
const secondary = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
const pruning = await jiti.import("../src/lib/m04-modification-safety.ts");
const medicines = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");

await check("6.1 判据表外的合称按脏腑拆开：肺胃热盛证 → 肺、胃两条；查不出的不拆", () => {
  const names = secondary.compoundCriteriaEntries("肺胃热盛证").map((entry) => entry.name);
  assert.equal(names.length, 2);
  assert.ok(names[0].includes("肺") && names[0].includes("热"));
  assert.ok(names[1].includes("胃") && names[1].includes("热"));
  assert.deepEqual(secondary.compoundCriteriaEntries("痰气郁结证"), []);
  assert.deepEqual(secondary.compoundCriteriaEntries("某证"), []);
});

await check("6.2 证素的宽路径：证候表现三条算有据；立兼证仍按辨证要点", () => {
  const entry = secondary.diagnosticsCriteriaFor("血虚证");
  const specific = new Set(entry.specific);
  const listed = entry.manifestations.filter((item) => !specific.has(item) && !/色淡白|脉细/.test(item)).slice(0, 3);
  assert.equal(listed.length, 3, "前提：证候表现里有三条非要点");
  const recordText = listed.map((item, index) => `患者${item}${"甲乙丙"[index]}`).join("，");
  const matches = listed.map((item) => ({ item, quote: item }));
  assert.equal(secondary.evaluateCriteriaMatches(entry, matches, { recordText, primaryTerms: [] }).verdict, "fail");
  assert.equal(secondary.evaluateCriteriaMatches(entry, matches, { recordText, primaryTerms: [], breadth: true }).verdict, "pass");
  assert.equal(secondary.evaluateCriteriaMatches(entry, matches.slice(0, 2), { recordText, primaryTerms: [], breadth: true }).verdict, "fail");
});

const m04Content = (name, herbs) => `前文\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name, herbs, formulaAnalysis: herbs.map((herb) => herb.name).join("、"), notApplicable: "" }], modifications: [] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
const m04Candidate = (text) => JSON.parse(text.slice(text.indexOf("<!-- DIAGNOSIS_JSON_START -->") + 29, text.indexOf("<!-- DIAGNOSIS_JSON_END -->"))).formula.candidates[0];

await check("6.3 同源药只留一味：生姜+干姜留角色高的；原方两味都有时不动；君药不删", () => {
  const herbs = [{ name: "黄芪", role: "君", dose: "15g" }, { name: "干姜", role: "臣", dose: "6g" }, { name: "白术", role: "臣", dose: "10g" }, { name: "生姜", role: "佐", dose: "6g" }, { name: "甘草", role: "使", dose: "6g" }];
  const out = m04Candidate(pruning.dropSafetyConflictingM04CandidateHerbs(m04Content("自拟方", herbs), "胃痛1年，喜温喜按。"));
  assert.deepEqual(out.herbs.map((herb) => herb.name), ["黄芪", "干姜", "白术", "甘草"]);
  const kept = m04Candidate(pruning.dropSafetyConflictingM04CandidateHerbs(m04Content("厚朴温中汤", [{ name: "厚朴", role: "君", dose: "10g" }, { name: "干姜", role: "臣", dose: "6g" }, { name: "生姜", role: "佐", dose: "6g" }, { name: "陈皮", role: "佐", dose: "6g" }]), "腹胀痛，喜温。"));
  assert.deepEqual(kept.herbs.map((herb) => herb.name), ["厚朴", "干姜", "生姜", "陈皮"]);
});

await check("6.4 教材一条里寒热相配：与主证相反的寒药不单列；整条都清热的不算", () => {
  assert.equal(medicines.herbThermalSide("黄连"), "cold");
  assert.equal(medicines.herbThermalSide("吴茱萸"), "warm");
  const prior = { stage: "diagnose", overview: { tcmDiseaseName: "胃痛", primarySyndrome: "脾胃虚寒证" }, therapy: { overallMethod: "温中健脾，和胃止痛" }, pathogenesis: { natureDifferentiation: { items: [{ name: "虚寒" }] } } };
  assert.equal(compiler.textbookEntryOpposedSide("黄连", ["黄连", "吴茱萸", "海螵蛸"], "清热燥湿，泻火解毒", prior), true);
  assert.equal(compiler.textbookEntryOpposedSide("黄连", ["黄连", "竹茹", "知母"], "清热燥湿，泻火解毒", prior), false);
  assert.equal(compiler.textbookEntryOpposedSide("黄连", ["肉桂", "黄连"], "清心降火", prior), false, "两味成对的（交泰丸）一起补，不算拆开");
  assert.equal(compiler.textbookEntryOpposedSide("海螵蛸", ["黄连", "吴茱萸", "海螵蛸"], "制酸止痛", prior), false);
});

await check("6.5 加减下限：不足两条时按教材补，至多补到要的数；同方教材行也能补；没有教材行不编", () => {
  const stub = (item) => [{ herbName: item.herbName, doseOrHandling: item.dose, trigger: item.trigger }];
  const prior = { stage: "diagnose", overview: { tcmDiseaseName: "不寐", primarySyndrome: "心脾气血两虚证", recommendedFormulaNames: ["归脾汤"] }, pathogenesis: { chain: [{ nodeId: "P1" }] } };
  const rows = compiler.textbookFallbackModifications(prior, ["人参", "白术"], stub, 2);
  assert.ok(rows.length >= 1 && rows.length <= 2, `得到 ${rows.length} 条`);
  assert.equal(compiler.textbookFallbackModifications({ ...prior, overview: { ...prior.overview, recommendedFormulaNames: [] } }, ["人参"], stub, 2).length, 0);
  assert.ok(compiler.textbookFallbackModifications(prior, ["人参", "白术"], stub, 1).length <= 1);
});

console.log(`\n${cases} checks`);
if (process.exitCode) console.error("failed");
