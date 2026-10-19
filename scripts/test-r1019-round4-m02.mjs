// 10/19 第四轮（2026-10-19）：Claude 评审 B 集（IMCS-21/MedDG 问诊对话 335 例）报出的 M02 服务端兜底题与筛查题缺陷，一类一修。
//
// 每条断言都带对照（不该变的输入保持不变），并跑过反证：R1019_SRC 指向只回退了本轮 M02 改动的副本时，各节断言必须变红；
// 单点反证（原地撤一处改动）记在 ~/runlogs/r1018/work/r1019/counterproofs.txt（前缀 4/m02/）。
//
//   1 婴幼儿（未满 3 岁、年龄不详的儿童）的基本问诊题：不问口渴喜冷喜热、怕冷怕热，改问家长看得到的吃奶/进食、大便、精神、
//     手脚温凉、睡汗；新生儿问大便颜色，不问「平时」；叙述里的月龄、日龄（娃儿55天、3周、月子娃）
//   2 病程按天计时题干只问「这次发病以来」；频次（一天…次）、「有时/总是」不算急性；口语大便、「全身冰冷」算已记录
//   3 未满 3 岁不出教材脉象题（三岁以下以指纹代脉）；3 岁及以上照出（对照）
//   4 舌象选项：淡与淡红单凭舌色不算互斥（齿痕舌对白腻苔可并见）；淡红对红、苔色不同照旧互斥（对照）
//   5 急症筛查题按人群与病历写法换题干（婴儿问吃奶、幼儿感染不问寒战血压、出血以病历原话定部位、男性无阴道出血、
//     其他急危重线索只问是否仍在发生），闸门照常识别作答；筛查题归 triage 分支
//   6 闸门会列为「需优先评估」的事实层线索在基本问诊题之前（clarify 级、已写明正在发生的出血、没有类目筛查题的线索）
//   7 重复核对提示词覆盖「题干问的那个表现本身已被否认」
import assert from "node:assert/strict";
import path from "node:path";
import { createJiti } from "jiti";

const SRC = process.env.R1019_SRC ? path.resolve(process.env.R1019_SRC) : path.resolve(process.cwd(), "src");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": SRC,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const lib = (name) => jiti.import(path.join(SRC, "lib", name));

const failures = [];
let cases = 0;
const check = async (name, run) => {
  cases += 1;
  try {
    await run();
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message.slice(0, 500) : String(error) });
  }
};

Object.assign(process.env, {
  AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://api.deepseek.com",
  OPENAI_MODEL: "deepseek-flash", CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash", PRIMARY_QUESTION_MODEL: "deepseek-flash",
  CDSS_CLINICAL_FACTS_BACKSTOP: "false", CDSS_M02_PRECOMPUTE_NO_ANSWER: "false", CDSS_SMALL_TASK_MEMO: "false",
});

const { normalizeCaseStateInput } = await lib("diagnosis-types.ts");
const safety = await lib("diagnosis-safety.ts");
const contract = await lib("m02-question-contract.ts");
const followup = await lib("followup-conversation.ts");
const textbook = await lib("tcm-textbook-syndromes.ts");
const redundancy = await lib("m02-question-redundancy.server.ts");

// 舌脉缺省按已记录：否则教材舌象题排在基本问诊题之前（第 3 节专门测舌脉缺失的情形）。
const caseOf = (presentHistory, patient = { sex: "男", age: 40 }, extra = {}) =>
  normalizeCaseStateInput({ id: `r4m02-${cases}`, chiefComplaint: presentHistory.slice(0, 30), patient, symptoms: { 现病史: presentHistory }, tongue: "舌淡红，苔薄白", pulse: "脉缓", conversation: [], ...extra });
const firstLine = (content) => (content || "").split("\n")[0];
const optionsOf = (content) => [...(content || "").matchAll(/^[AB]\. (.+)$/gmu)].map((match) => match[1]);
const settled = (state) => contract.buildCaseAwareQuestionFallback(state, { settled: true });
const SUBJECTIVE = /怕冷还是怕热|想喝凉的还是热的|口渴吗/u;
const withFacts = (state, redFlags, extra = {}) => ({ ...state, clinicalFacts: { redFlags }, ...extra });
const finding = (category, quote, urgency = "urgent", status = "positive") => ({ category, quote, urgency, status, subject: "patient" });

// ───── 1 婴幼儿的基本问诊题 ─────
await check("1.1 8 月龄、15 月龄、50 天的孩子不问口渴喜冷喜热、怕冷怕热（B-IMCS21-train-10252189#12、10877829#5、10013460#11）；问家长看得到的吃奶/进食；选项不带「或」", () => {
  const infant = settled(caseOf("宝宝八个月，有点低烧怎么办", { sex: "男", age: "8个月" }));
  assert.ok(!SUBJECTIVE.test(infant), infant);
  assert.equal(firstLine(infant), "**问题1：** 这几天吃奶和平时比怎样？");
  assert.deepEqual(optionsOf(infant), ["吃奶明显比平时少", "吃奶和平时差不多"]);
  const toddler = settled(caseOf("发烧到39.5，咳嗽两天", { sex: "男", age: "15个月" }));
  assert.ok(!SUBJECTIVE.test(toddler), toddler);
  assert.equal(firstLine(toddler), "**问题1：** 这几天孩子吃东西和平时比怎样？");
  for (const option of [...optionsOf(infant), ...optionsOf(toddler)]) assert.ok(!/或/u.test(option), option);
  assert.ok(!SUBJECTIVE.test(settled(caseOf("宝宝50天了，今天拉了4-5次，有的里边好多水，母乳喂养", { sex: "男", age: "50天" }))));
});
await check("1.2 对照：3 岁及以上、成人照旧问寒热/口渴（4 岁、5 岁的这类题评审判合格）", () => {
  assert.match(settled(caseOf("胃脘隐痛半年", { sex: "男", age: 45 })), /怕冷还是怕热/u);
  assert.match(settled(caseOf("咳嗽两天，流清涕", { sex: "女", age: 4 })), /怕冷还是怕热|口渴吗/u);
});
await check("1.3 新生儿：不问「平时大便」（4 天、10 天新生儿，B-IMCS21-train-10312916#7、dev-10192726#9）；吃奶已写时问大便颜色（灰白如陶土）；5 个月同一病历问大便性状（对照）", () => {
  const neonate = settled(caseOf("宝宝出生第4天，脸和眼白发黄，吃奶正常", { sex: "男", age: "4天" }));
  assert.ok(!/平时大便/u.test(neonate), neonate);
  assert.equal(firstLine(neonate), "**问题1：** 大便是什么颜色？");
  assert.deepEqual(optionsOf(neonate), ["大便黄色", "大便颜色发白，像陶土"]);
  const infant = settled(caseOf("宝宝脸和眼白发黄，吃奶正常", { sex: "男", age: "5个月" }));
  assert.equal(firstLine(infant), "**问题1：** 这几天大便怎样？");
});
await check("1.4 新生儿不问手脚温凉与睡汗；吃奶、大便、精神都已写时出开放题，不倒回寒热（对照：乳婴儿同一病历问手脚温凉）", () => {
  const text = "宝宝黄疸，吃奶正常，大便金黄，精神好";
  const neonate = settled(caseOf(text, { sex: "男", age: "10天" }));
  assert.ok(!/手脚|出汗|怕冷/u.test(neonate), neonate);
  assert.match(neonate, /还有没有其他不适/u);
  assert.equal(firstLine(settled(caseOf(text, { sex: "男", age: "3个月" }))), "**问题1：** 摸孩子的手脚，是偏凉还是偏热？");
});
await check("1.5 年龄栏为空的孩子（宝宝/孩子/娃）不问主观感受（B-IMCS21-test-10148432#4）；成人年龄栏为空照旧（对照）", () => {
  const child = settled(caseOf("医生，宝宝病毒感染反复高烧怎么办？", { sex: "男" }));
  assert.ok(!SUBJECTIVE.test(child), child);
  assert.match(settled(caseOf("胃脘隐痛半年，嗳气", { sex: "男" })), /怕冷还是怕热/u);
});
await check("1.6 叙述里的月龄日龄与新生儿称谓：娃儿55天、50多天的宝宝、宝宝3周、月子娃；「宝宝3周岁」「生完孩子12天」不是（对照）", () => {
  assert.equal(contract.m02PatientAgeDays("", "请问娃儿55天了，前面有六天没有大便了"), 55);
  assert.equal(contract.m02PatientAgeDays("", "50多天的宝宝喝药呕吐的原因"), 50);
  assert.equal(contract.m02PatientAgeDays("", "我家宝宝3周了，从昨天开始发烧"), 21);
  assert.equal(contract.m02PatientAgeDays("", "月子娃一直打喷嚏"), 14);
  assert.equal(contract.m02PatientAgeDays("", "宝宝3周岁，咳嗽"), undefined);
  assert.equal(contract.m02PatientAgeDays("", "刚生完孩子12天，今天下午肚子绞痛"), undefined);
  assert.equal(contract.m02PatientAgeDays("", "宝宝出生8天，黄疸。"), 8, "原有写法不变");
  assert.equal(contract.m02YoungChildBand(55, ""), "infant");
  assert.equal(contract.m02YoungChildBand(14, ""), "neonate");
  assert.equal(contract.m02YoungChildBand(2 * 365, ""), "toddler");
  assert.equal(contract.m02YoungChildBand(3 * 365 + 1, "宝宝"), undefined, "3 岁及以上不算");
  assert.equal(contract.m02YoungChildBand(undefined, "患者胃痛"), undefined);
});

// ───── 2 题干与已记录判据 ─────
await check("2.1 病程按天计：题干只问「这次发病以来」（B-MedDG-train-dialog4866#1 急性吐泻）；半年、「一天上拉3/4次」「有时半夜反酸」照旧（对照）", () => {
  const acute = settled(caseOf("前天下午肚子疼，然后夜里就开始上吐下泻，今天还是吐", { sex: "男", age: 25 }));
  assert.equal(firstLine(acute), "**问题1：** 这次发病以来，是怕冷还是怕热？");
  assert.equal(firstLine(settled(caseOf("胃脘隐痛半年", { sex: "男", age: 45 }))), "**问题1：** 平时或这次发病以来，是怕冷还是怕热？");
  assert.ok(!contract.m02AcuteCourse("最近总排便咋回事。。一天上拉3/4次"));
  assert.ok(!contract.m02AcuteCourse("反胃酸是什么原因？有时半夜突然反胃酸"));
  assert.ok(contract.m02AcuteCourse("肚子有点痛，昨天早上开始"));
});
await check("2.2 口语大便（3天没拉臭臭、拉绿屎）与「全身冰冷」算已记录，不再问（B-IMCS21-train-10653868#6、B-MedDG-train-dialog3673#10）；没写时照问（对照）", () => {
  const infant = settled(caseOf("孩子4个月，3天没拉臭臭了，也不怎么吃奶", { sex: "男", age: "4个月" }));
  assert.ok(!/大便/u.test(firstLine(infant)), infant);
  assert.ok(!/怕冷还是怕热/u.test(settled(caseOf("这次喝酒喝的特别多，全身冰冷，会不会有危险", { sex: "男", age: 19 }))));
  assert.match(settled(caseOf("这次喝酒喝的特别多，会不会有危险", { sex: "男", age: 19 })), /怕冷还是怕热/u);
});

// ───── 3 教材脉象题按年龄 ─────
const COUGH = "宝宝咳嗽一周，有痰，晚上咳得多";
await check("3.1 未满 3 岁不出「本例的脉象」（三岁以下以指纹代脉；B-IMCS21-train-10172804#10、10354911#9 等 5 例）；4 岁同一病历照出脉象题（对照）", () => {
  const noTonguePulse = { tongue: undefined, pulse: undefined };
  for (const age of ["7个月", 1, 2]) {
    const content = settled(caseOf(COUGH, { sex: "男", age }, noTonguePulse));
    assert.ok(!/脉象/u.test(content), `${age}：${firstLine(content)}`);
  }
  assert.match(firstLine(settled(caseOf(COUGH, { sex: "男", age: 4 }, noTonguePulse))), /脉象/u);
});

// ───── 4 舌象选项互斥 ─────
await check("4.1 「舌淡嫩，边有齿痕」对「舌淡红，苔白腻」不互斥（B-IMCS21-train-10216260#8）；淡对红、淡红对红、苔色不同仍互斥（对照）", () => {
  assert.equal(textbook.tongueOptionsMutuallyExclusive("舌淡嫩，边有齿痕", "舌淡红，苔白腻"), false);
  assert.equal(textbook.tongueOptionsMutuallyExclusive("舌淡白", "舌淡红"), false);
  assert.equal(textbook.tongueOptionsMutuallyExclusive("舌淡，苔薄白", "舌红，苔黄"), true);
  assert.equal(textbook.tongueOptionsMutuallyExclusive("舌质红，苔厚腻", "舌淡红，苔白"), true, "评审判合格的呕吐题（B-IMCS21-test-10398436#4）");
  assert.equal(textbook.tongueOptionsMutuallyExclusive("舌淡红，苔薄白", "舌淡，苔黄腻"), true, "苔色不同照旧互斥");
  assert.equal(textbook.tongueOptionsMutuallyExclusive("苔白腻", "苔黄腻"), true);
});

// ───── 5 急症筛查题的写法 ─────
const ask = (state) => contract.buildCaseAwareQuestionFallback(state);
const gateWith = (question, answer, patient = { sex: "男", age: 40 }) => safety.evaluateSafetyGate(normalizeCaseStateInput({
  id: `r4m02-gate-${cases}`, chiefComplaint: "纳差1周", patient,
  symptoms: { 现病史: "患者1周来食欲欠佳，餐后稍胀，无恶心呕吐，二便调。", 既往史: "既往体健", 过敏史: "否认药物过敏史", 个人史: "无烟酒" },
  tongue: "舌淡红，苔薄白", pulse: "脉弦", vitals: { T: "36.6", P: "78", R: "18", BP: "126/78" },
  conversation: [{ role: "assistant", content: question }, { role: "user", content: answer }],
}));
await check("5.1 新生儿、乳婴儿的儿童危重筛查问吃奶，不问「拒绝饮水」（B-IMCS21-test-10454205#4 3 天新生儿）；2 岁照旧（对照）", () => {
  const neonate = ask(withFacts(caseOf("出生3天黄疸偏高", { sex: "男", age: "3天" }), [finding("pediatric_critical", "黄疸偏高")]));
  assert.match(firstLine(neonate), /吃奶明显减少甚至拒奶/u);
  assert.ok(!/拒绝饮水/u.test(neonate), neonate);
  const toddler = ask(withFacts(caseOf("发烧拉肚子，小便变少", { sex: "男", age: 2 }), [finding("pediatric_critical", "小便变少")]));
  assert.match(firstLine(toddler), /拒绝饮水/u);
});
await check("5.2 未满 3 岁的感染筛查不问寒战、血压（B-IMCS21-train-10700122#1 5 月龄）；成人照旧（对照）", () => {
  const infant = ask(withFacts(caseOf("五个半月，发烧最高39°", { sex: "女", age: "5个月" }), [finding("sepsis", "发烧最高39°")]));
  assert.ok(!/寒战|血压/u.test(firstLine(infant)), infant);
  assert.match(firstLine(infant), /精神很差/u);
  assert.match(firstLine(ask(withFacts(caseOf("发热39℃两天", { sex: "女", age: 40 }), [finding("sepsis", "发热39℃两天")]))), /寒战/u);
});
await check("5.3 出血筛查：有病历原话时原话在前、只问是否仍在出血及头晕心慌出冷汗，不列咯血、阴道流血（B-MedDG-train-dialog1722#12、8156#3）；没原话时男性去掉阴道出血，女性照旧（对照）", () => {
  const anchored = ask(withFacts(caseOf("今天大便时流血，大便完了，还流了一些", { sex: "男", age: 46 }), [finding("bleeding", "大便完了，还流了一些")]));
  assert.equal(firstLine(anchored), "**问题1：** 病历记录“大便完了，还流了一些”。目前是否仍在出血不止，或伴头晕、心慌、出冷汗？");
  assert.ok(!/咯血|阴道/u.test(anchored));
  const male = ask(withFacts(caseOf("鼻子出血", { sex: "男", age: 46 }), [finding("bleeding", "")]));
  assert.ok(!/阴道/u.test(firstLine(male)) && /咯血/u.test(firstLine(male)), male);
  assert.match(firstLine(ask(withFacts(caseOf("鼻子出血", { sex: "女", age: 46 }), [finding("bleeding", "")]))), /阴道大量流血/u);
});
await check("5.4 其他急危重线索只问一件事：是否仍在发生（B-MedDG-train-dialog1533#3：旧题干一题问起病时间、严重程度、生命体征、意识呼吸五件事），选项不用「经复核」", () => {
  const content = ask(withFacts(caseOf("孕38周+6天，昨天晚上拉肚子拉的可狠", { sex: "女", age: 25 }), [finding("other_critical", "昨天晚上拉肚子拉的可狠")]));
  assert.equal(firstLine(content), "**问题1：** 病历记录“昨天晚上拉肚子拉的可狠”。目前这一情况是否仍在发生？");
  assert.ok(!/起病时间|生命体征|经复核/u.test(content), content);
});
await check("5.5 每种换写的题干：阳性选项 → 闸门红旗，阴性选项 → 不报（含引文前缀与旧版「其他急危重线索」题干）", () => {
  const items = [];
  for (const [category, variants] of Object.entries(followup.RISK_QUESTION_VARIANTS)) {
    for (const variant of Object.keys(variants)) items.push({ category, ...followup.riskScreeningQuestionFor(category, variant) });
  }
  items.push({ category: "bleeding", ...followup.riskScreeningQuestionFor("bleeding", "anchored"), question: `${followup.riskQuestionQuotePrefix("大便完了，还流了一些")}${followup.riskScreeningQuestionFor("bleeding", "anchored").question}` });
  items.push({ category: "other_critical", ...followup.POSSIBLE_RISK_QUESTIONS.other_critical, question: `${followup.riskQuestionQuotePrefix("昨天晚上拉肚子拉的可狠")}${followup.POSSIBLE_RISK_QUESTIONS.other_critical.question}` });
  assert.ok(items.length >= 6);
  for (const item of items) {
    assert.deepEqual(followup.confirmedRiskScreeningCategories([{ role: "assistant", content: item.question }, { role: "user", content: item.positive }]).map((entry) => entry.category), [item.category], item.question);
    assert.equal(gateWith(item.question, item.positive).status, "red_flag", `${item.question}：阳性须报红旗`);
    assert.notEqual(gateWith(item.question, item.negative).status, "red_flag", `${item.question}：阴性不报红旗`);
  }
  const legacy = "请复核该异常是否正在发生，并补充起病时间、严重程度、生命体征和意识呼吸状态。";
  assert.deepEqual(followup.confirmedRiskScreeningCategories([{ role: "assistant", content: `${followup.riskQuestionQuotePrefix("左下肢肿胀")}${legacy}` }, { role: "user", content: "异常仍在发生，请补充具体表现" }]).map((entry) => entry.category), ["other_critical"], "调用方回传的旧题干照常识别");
  assert.deepEqual(followup.confirmedRiskScreeningCategories([{ role: "assistant", content: "这几天吃奶和平时比怎样？" }, { role: "user", content: "存在上述任一情况，请补充具体表现" }]), [], "别的题配阳性句不算（对照）");
});
await check("5.6 筛查题归 triage 分支（此前标 differential，B-IMCS21 儿童危重筛查题）；基本问诊题仍是 syndrome（对照）", () => {
  const branchOf = (content) => contract.parseM02PlanFromContent(contract.ensureQuestionStructuredEnvelope(content, "")).questions[0].decisionBranch;
  assert.equal(branchOf(ask(withFacts(caseOf("发烧拉肚子，小便变少", { sex: "男", age: 2 }), [finding("pediatric_critical", "小便变少")]))), "triage");
  assert.equal(branchOf(settled(caseOf("胃脘隐痛半年", { sex: "男", age: 45 }))), "syndrome");
});

// ───── 6 需优先评估的线索在基本问诊题之前 ─────
await check("6.1 事实层 clarify 级阳性线索（突然瘫软 → 晕厥类）：出该类筛查题，不问怕冷怕热（B-MedDG-train-dialog11584#1）；没有线索时照旧（对照）", () => {
  const base = caseOf("肚子不舒服，想拉肚子，想吐，然后突然身体没力气瘫软", { sex: "男", age: 28 });
  const content = settled(withFacts(base, [finding("syncope", "突然身体没力气瘫软", "clarify")]));
  assert.equal(firstLine(content), `**问题1：** ${followup.POSSIBLE_RISK_QUESTIONS.syncope.question}`);
  assert.match(settled(base), /怕冷还是怕热/u);
  assert.match(contract.m02ClinicalFactsFootprint(withFacts(base, [finding("syncope", "突然身体没力气瘫软", "clarify")])), /syncope/u, "这条线索在先发结果的指纹里");
});
await check("6.2 病历已写明正在出血（affirmed）：问循环灌注表现，题干带病历原话（B-MedDG-train-dialog14432#7 黑便后虚脱）；闸门照常识别作答", () => {
  const state = withFacts(caseOf("最近都有黑便，上厕所出来就感觉人都有点虚脱了", { sex: "男", age: 19 }), [finding("gi_bleed", "最近都有黑便")], { m02AffirmedRiskCategories: ["gi_bleed"] });
  const content = settled(state);
  const shock = followup.POSSIBLE_RISK_QUESTIONS.shock;
  assert.equal(firstLine(content), `**问题1：** 病历记录“最近都有黑便”。${shock.question}`);
  assert.equal(gateWith(`病历记录“最近都有黑便”。${shock.question}`, shock.positive).status, "red_flag");
});
await check("6.3 没有类目筛查题的线索（上消化道警示征象）：以病历原话问近来加重、持续还是缓解；不进闸门识别（不是急症确认，对照）", () => {
  const content = settled(withFacts(caseOf("大便困难，大便黑色，口臭很严重", { sex: "男", age: 30 }), [finding("gi_alarm", "大便黑色")]));
  assert.equal(firstLine(content), "**问题1：** 病历记录“大便黑色”。这一情况近来是在加重、持续，还是已经缓解？");
  assert.deepEqual(followup.confirmedRiskScreeningCategories([{ role: "assistant", content: "病历记录“大便黑色”。这一情况近来是在加重、持续，还是已经缓解？" }, { role: "user", content: "近来加重或出现新表现，请补充具体表现" }]), []);
  // 「其他急危重线索」只到 clarify 级时同样问近来变化：它的筛查题答「仍在发生」即按急症确认，不该由 clarify 级线索触发。
  const other = settled(withFacts(caseOf("孕38周，昨天晚上拉肚子拉的可狠", { sex: "女", age: 25 }), [finding("other_critical", "昨天晚上拉肚子拉的可狠", "clarify")]));
  assert.equal(firstLine(other), "**问题1：** 病历记录“昨天晚上拉肚子拉的可狠”。这一情况近来是在加重、持续，还是已经缓解？");
});
await check("6.4 不出优先评估题（对照）：病历已回答该类筛查题、他人的线索、只认明确现症时的 possible、emergency（由路由出处置题）", () => {
  const base = caseOf("肚子不舒服，然后突然身体没力气瘫软", { sex: "男", age: 28 });
  assert.match(settled(withFacts(base, [finding("syncope", "突然身体没力气瘫软", "clarify")], { m02SuppressedRiskCategories: ["syncope"] })), /怕冷还是怕热/u);
  assert.match(settled(withFacts(base, [{ ...finding("syncope", "突然身体没力气瘫软", "clarify"), subject: "other" }])), /怕冷还是怕热/u);
  assert.match(settled(withFacts(base, [finding("syncope", "突然身体没力气瘫软", "clarify", "possible")])), /怕冷还是怕热/u);
  assert.match(settled(withFacts(base, [finding("syncope", "突然身体没力气瘫软", "emergency")])), /怕冷还是怕热/u);
});

// ───── 7 重复核对提示词 ─────
await check("7.1 重复核对提示词写明「题干问的那个表现本身已被否认」算 answered（B-IMCS21-test-10327571#11「咳嗽时候没有痰」被问痰的颜色）；判 answered 且引文逐字时删题", async () => {
  const START = "<!-- DIAGNOSIS_JSON_START -->";
  const END = "<!-- DIAGNOSIS_JSON_END -->";
  const option = (id, value) => ({ id, label: value, answer: value, kind: "clinical_fact", recordValue: value });
  const plan = { schemaVersion: "tcm-cdss-m02-plan-v1", decision: "ask", rationale: "x", questions: [{
    id: "q1", question: "咳嗽时痰的颜色和质地更接近哪一种？", reason: "区分寒痰与热痰。", targetField: "xianbingshi", decisionBranch: "syndrome",
    expectedDecisionImpact: "区分寒热。", informationGain: 0.7, sourceEvidence: [],
    options: [option("a", "痰白清稀"), option("b", "痰黄黏稠"), { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" }],
  }] };
  const content = [START, JSON.stringify({ m02Plan: plan }), END].join("\n");
  const record = "宝宝咳嗽3天。问：有痰吗 答：咳嗽时候没有痰";
  const savedFetch = globalThis.fetch;
  const bodies = [];
  let removed;
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const payload = body.messages[0].content.includes("追问题与病历的重复核对器")
        ? { verdict: "answered", quotes: ["咳嗽时候没有痰"], reason: "病历已写明没有痰" }
        : { verdict: "single", points: [] };
      return new Response(JSON.stringify({ id: "t", object: "chat.completion", model: "deepseek-flash", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { "content-type": "application/json" } });
    };
    removed = await redundancy.questionIdsFailingNarrowChecks(content, record, "");
  } finally {
    globalThis.fetch = savedFetch;
  }
  const system = bodies.find((body) => body.messages?.[0]?.content?.includes("追问题与病历的重复核对器"))?.messages[0].content || "";
  assert.ok(system.includes("前提已被否认也算 answered"), "提示词缺「前提已被否认」一类");
  assert.ok(system.includes("咳嗽时候没有痰"), "提示词缺本类示例");
  assert.deepEqual(removed, ["q1"]);
});

const summary = { suite: "r1019-round4-m02", src: SRC, cases, failures };
console.log(JSON.stringify(summary, null, 1));
if (failures.length > 0) process.exitCode = 1;
