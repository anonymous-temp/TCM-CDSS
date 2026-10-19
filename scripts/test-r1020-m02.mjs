// 10/19 第八轮（2026-10-19 晚，WP-D）：第七轮 qwen 评审 B 集（IMCS-21/MedDG 问诊对话 335 例）报出的 M02 追问缺陷，一类一修。
//
// 每条断言都带对照（不该变的输入保持不变）；反证（原地改一个字符串让修复失效、确认变红）记在
// ~/runlogs/r1018/work/r1019/counterproofs.txt，前缀 8/m02/。
//
//   1 PHI：问诊记录「答：都没有」被抹成「答：[已脱敏]有」（都是姓氏字，没不是名字用字）——否认没了，追问再问被否认的腹泻
//     （B-IMCS21-train-10478589#6）；姓名反证：都 + 常见名字 + 叙述句式仍须抹掉
//   2 婴幼儿的急症筛查题：神经、呼吸类目对未满 3 岁（或年龄不详的儿童）不问「说话不清、突发剧烈头痛」「说话受限、不能平卧」
//     （B-IMCS21-dev-10143338#9）；闸门照常识别作答
//   3 「近来有没有加重」题：两个临床选项把加重与没有加重分开（持续不变、已缓解都在后一项）；病历已写出变化时（窄核对）不出这道题
//     （B-IMCS21-test-10334253#9、train-10389592#8）
//   4 decision=proceed 的病历充分判据：问答体记录里医生的提问不算患者表现（B-IMCS21-train-10141611#12）
//   5 模型题两个选项在所问维度上同值（窄核对第二件事，与重复核对同一次调用）与单问点核对的对象数判法
//   6 窄核对读的病历文本带上对话里的「题干 + 回答」；3.5 已答守卫认得新题干
//   7 出题提示词：婴幼儿一句、选项互斥举例
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const SRC = process.env.R1020_SRC ? path.resolve(process.env.R1020_SRC) : path.resolve(process.cwd(), "src");
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
delete process.env.CDSS_M02_OPTION_OVERLAP_CHECK;
delete process.env.CDSS_M02_QUESTION_REDUNDANCY_CHECK;
delete process.env.CDSS_M02_QUESTION_SINGLE_POINT_CHECK;

const { normalizeCaseStateInput } = await lib("diagnosis-types.ts");
const safety = await lib("diagnosis-safety.ts");
const contract = await lib("m02-question-contract.ts");
const followup = await lib("followup-conversation.ts");
const redundancy = await lib("m02-question-redundancy.server.ts");
const prompts = await lib("diagnosis-prompts.ts");

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const planOf = (content) => JSON.parse(content.slice(content.indexOf(START) + START.length, content.indexOf(END))).m02Plan;
const firstLine = (content) => (content || "").split("\n")[0];
const optionsOf = (content) => [...(content || "").matchAll(/^[ABC]\. (.+)$/gmu)].map((match) => match[1]);
const caseOf = (presentHistory, patient = { sex: "男", age: 40 }, extra = {}) =>
  normalizeCaseStateInput({ id: `r20m02-${cases}`, chiefComplaint: presentHistory.slice(0, 30), patient, symptoms: { 现病史: presentHistory }, tongue: "舌淡红，苔薄白", pulse: "脉缓", conversation: [], ...extra });
const withFacts = (state, redFlags, extra = {}) => ({ ...state, clinicalFacts: { redFlags }, ...extra });
const finding = (category, quote, urgency = "urgent", status = "positive") => ({ category, quote, urgency, status, subject: "patient" });
const option = (id, value) => ({ id, label: value, answer: value, kind: "clinical_fact", recordValue: value });
const question = (stem, a, b, branch = "syndrome", id = "q1") => ({
  id, question: stem, reason: "两种情况对应不同证型，用方不同。", targetField: "xianbingshi", decisionBranch: branch,
  expectedDecisionImpact: "区分两种候选证型。", informationGain: 0.7, sourceEvidence: [],
  options: [option("a", a), option("b", b), { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" }],
});
const envelope = (...questions) => [START, JSON.stringify({ m02Plan: { schemaVersion: "tcm-cdss-m02-plan-v1", decision: "ask", rationale: "需要一条区分证型的事实。", questions } }), END].join("\n");

const savedFetch = globalThis.fetch;
const completion = (payload) => new Response(JSON.stringify({
  id: "t", object: "chat.completion", model: "deepseek-flash",
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { headers: { "content-type": "application/json" } });
/** 桩模型：按请求里的系统提示词分派（重复核对 / 单问点 / 趋势核对），记录每次请求体。 */
const stubModel = (answers) => {
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const system = body.messages?.[0]?.content || "";
    if (system.includes("追问题与病历的重复核对器")) return completion(answers.record(body));
    if (system.includes("追问题题干的核对器")) return completion(answers.stem ? answers.stem(body) : { verdict: "single", points: [] });
    return completion({});
  };
  return bodies;
};

// ───── 1 PHI：「都没有」不是姓名 ─────
await check("1.1 「答：都没有」「都没有发热」「患者都没有腹泻」不被当姓名抹掉（否认保留）；整句问诊记录原样（B-IMCS21-train-10478589#6）", () => {
  for (const text of [
    "答：都没有",
    "都没有发热",
    "患者都没有腹泻",
    "问：好的，宝宝发烧多少度几天了 答：最高39度，就是昨天晚上开始；问：除了发烧还有没有其他症状，比如腹泻，咳嗽流涕 答：都没有",
    "答：都不是", "答：都有", "答：都会", "答：都无", "答：都未",
  ]) {
    assert.equal(safety.sanitizeFreeTextForModel(text), text, text);
  }
});
await check("1.2 对照（隐私）：都 + 常见名字 + 叙述句式仍然抹掉，闭集只收「都 + 否定/有无」", () => {
  for (const text of ["患者都伟有高血压", "患者都敏近两天发热", "都明有头痛", "答：都伟有高血压", "家属都强代述病情"]) {
    const sanitized = safety.sanitizeFreeTextForModel(text);
    assert.ok(/\[(?:姓名)?已脱敏\]/u.test(sanitized), `${text} → ${sanitized}`);
    assert.ok(!/都(?:伟|敏|明|强)/u.test(sanitized), `${text} → ${sanitized}`);
  }
});
await check("1.3 甲方形状：问诊记录进入 trustedInputText 后「答：都没有」仍在，追问模型与窄核对读到的是否认", () => {
  const state = normalizeCaseStateInput({
    id: "r20m02-phi", chiefComplaint: "宝宝发烧可不可以吃鸡蛋？", patient: { sex: "男", age: "" }, conversation: [],
    symptoms: { 现病史: "宝宝发烧可不可以吃鸡蛋？", 问诊记录: "问：好的，宝宝发烧多少度几天了 答：最高39度，就是昨天晚上开始；问：除了发烧还有没有其他症状，比如腹泻，咳嗽流涕 答：都没有" },
  });
  const text = safety.trustedInputText(safety.sanitizeCaseStateForModel(state));
  assert.ok(text.includes("比如腹泻，咳嗽流涕 答：都没有"), text);
  assert.ok(!text.includes("[已脱敏]有"), text);
});

// ───── 2 婴幼儿的急症筛查题 ─────
const NEURO_ADULT = followup.POSSIBLE_RISK_QUESTIONS.neuro.question;
const RESP_ADULT = followup.POSSIBLE_RISK_QUESTIONS.respiratory.question;
await check("2.1 神经类目：65 天、15 天、8 个月、只写「宝宝」的孩子不问「说话不清、突发剧烈头痛」，改问抽搐、肢体活动、口角歪斜、嗜睡难唤醒、喷射性呕吐", () => {
  const youngChild = followup.RISK_QUESTION_VARIANTS.neuro.youngChild.question;
  for (const [age, text] of [["65天", "出生后缺血缺氧性脑病，下唇抖动"], ["15天", "新生儿黄疸，肌张力低"], ["8个月", "发热后嗜睡"], ["", "宝宝发烧后精神差"]]) {
    const state = withFacts(caseOf(text, { sex: "男", age }), [finding("neuro", text.slice(0, 8))]);
    const risk = contract.m02PossibleRiskQuestion(state);
    assert.equal(risk?.category, "neuro", age);
    assert.equal(risk.question, youngChild, `${age}：${risk.question}`);
    assert.ok(!/说话不清|头痛/u.test(risk.question));
  }
  assert.match(youngChild, /抽搐/u);
  assert.match(youngChild, /口角歪斜/u);
});
await check("2.2 对照：成人、3 岁以上儿童的神经、呼吸筛查题照旧；呼吸类目婴幼儿换成鼻翼扇动、三凹征", () => {
  for (const [age, text] of [[45, "说话含糊，右手无力"], ["8岁", "头痛伴呕吐"]]) {
    const risk = contract.m02PossibleRiskQuestion(withFacts(caseOf(text, { sex: "男", age }), [finding("neuro", text.slice(0, 4))]));
    assert.equal(risk?.question, NEURO_ADULT, String(age));
  }
  const youngResp = contract.m02PossibleRiskQuestion(withFacts(caseOf("咳嗽喘息两天", { sex: "女", age: "8个月" }), [finding("respiratory", "喘息")]));
  assert.equal(youngResp.question, followup.RISK_QUESTION_VARIANTS.respiratory.youngChild.question);
  assert.match(youngResp.question, /鼻翼扇动/u);
  assert.equal(contract.m02PossibleRiskQuestion(withFacts(caseOf("咳嗽喘息两天", { sex: "女", age: 30 }), [finding("respiratory", "喘息")])).question, RESP_ADULT);
  // 同一轮已有的婴幼儿写法不变（对照）
  assert.equal(contract.m02PossibleRiskQuestion(withFacts(caseOf("精神差", { sex: "男", age: "3天" }), [finding("pediatric_critical", "精神差")])).question,
    followup.RISK_QUESTION_VARIANTS.pediatric_critical.infant.question);
  assert.equal(contract.m02PossibleRiskQuestion(withFacts(caseOf("发热", { sex: "男", age: "10个月" }), [finding("sepsis", "发热")])).question,
    followup.RISK_QUESTION_VARIANTS.sepsis.youngChild.question);
});
await check("2.3 新写法进兜底题块后仍是合格的追问计划（两个临床选项 + 未取得），闸门按「题干 + 阳性选项」识别作答（神经 / 呼吸）", () => {
  const state = withFacts(caseOf("出生后缺血缺氧性脑病，下唇抖动", { sex: "男", age: "65天" }), [finding("neuro", "下唇抖动")]);
  const block = contract.buildCaseAwareQuestionFallback(state);
  assert.ok(!/说话不清/u.test(block), block);
  const plan = planOf(contract.ensureQuestionStructuredEnvelope(block, "出生后缺血缺氧性脑病，下唇抖动"));
  assert.equal(plan.questions[0].options.filter((item) => item.kind === "clinical_fact").length, 2);
  assert.equal(plan.questions[0].options.filter((item) => item.kind === "unknown").length, 1);
  for (const category of ["neuro", "respiratory"]) {
    const variant = followup.riskScreeningQuestionFor(category, "youngChild");
    const confirmed = followup.confirmedRiskScreeningCategories([{ role: "assistant", content: variant.question }, { role: "user", content: variant.positive }]);
    assert.deepEqual(confirmed.map((item) => item.category), [category]);
  }
  // 模型自己写的同轴题仍被认作覆盖该风险（RISK_AXIS_PATTERNS 读得到新写法里的口角歪斜、口唇发紫）
  const covered = contract.enforceM02UnansweredAxes(envelope(question("患儿是否抽搐、口角歪斜或嗜睡难以唤醒？", "出现抽搐、口角歪斜或嗜睡", "未出现上述表现", "triage")), "出生后缺血缺氧性脑病，下唇抖动", block, state);
  assert.equal(planOf(covered).questions.length, 1);
});

// ───── 3 「近来有没有加重」题 ─────
const trendFinding = (quote) => finding("other_critical", quote, "clarify");
await check("3.1 优先评估兜底题：题干问「近来有没有加重」，两个临床选项把加重与没有加重分开；不再有“已经缓解，目前未再出现”与“持续”无处可选", () => {
  const state = withFacts(caseOf("宝宝两岁昨晚突然发高烧，一直都是39.5度", { sex: "男", age: 2 }), [trendFinding("宝宝两岁昨晚突然发高烧")]);
  const block = contract.buildCaseAwareQuestionFallback(state);
  assert.equal(firstLine(block), "**问题1：** 病历记录“宝宝两岁昨晚突然发高烧”。这一情况近来有没有加重？");
  assert.deepEqual(optionsOf(block), ["近来加重，请补充具体表现", "没有加重", followup.FOLLOWUP_SKIP_SENTENCE]);
  assert.ok(!/已经缓解|持续/u.test(block), block);
  const plan = planOf(contract.ensureQuestionStructuredEnvelope(block, "宝宝两岁昨晚突然发高烧"));
  assert.equal(plan.questions[0].options.filter((item) => item.kind === "clinical_fact").length, 2);
  assert.equal(plan.questions[0].options.filter((item) => item.kind === "unknown").length, 1);
  // 不进闸门识别（不是急症筛查，答「近来加重」不能升成急症确认）
  assert.deepEqual(followup.confirmedRiskScreeningCategories([{ role: "assistant", content: "病历记录“宝宝两岁昨晚突然发高烧”。这一情况近来有没有加重？" }, { role: "user", content: "近来加重，请补充具体表现" }]), []);
});
await check("3.2 路由用的 m02PriorityTrendQuestion 只在这一支返回：读数引文、有类目筛查题的线索、已写明正在发生的出血都不是（对照）", () => {
  const base = caseOf("反复发烧三天", { sex: "男", age: 5 });
  const trend = contract.m02PriorityTrendQuestion(withFacts(base, [trendFinding("反复发烧三天")]));
  assert.equal(trend.quote, "反复发烧三天");
  assert.equal(trend.question, "病历记录“反复发烧三天”。这一情况近来有没有加重？");
  assert.deepEqual(trend.options, ["近来加重，请补充具体表现", "没有加重"]);
  assert.equal(contract.m02PriorityTrendQuestion(withFacts(base, [trendFinding("体温38.1℃")])), undefined, "读数引文");
  assert.equal(contract.m02PriorityTrendQuestion(withFacts(base, [trendFinding("T 39.5")])), undefined, "读数引文");
  assert.equal(contract.m02PriorityTrendQuestion(withFacts(base, [finding("gi_bleed", "大便黑色", "clarify")])), undefined, "有类目筛查题");
  assert.equal(contract.m02PriorityTrendQuestion(withFacts(base, [finding("gi_bleed", "大便黑色", "clarify")], { m02AffirmedRiskCategories: ["gi_bleed"] })), undefined, "已写明正在发生的出血问循环灌注");
  assert.equal(contract.m02PriorityTrendQuestion(base), undefined, "没有线索");
  assert.equal(contract.m02PriorityTrendQuestion(withFacts(base, [{ ...trendFinding("反复发烧三天"), subject: "other" }])), undefined, "他人的线索");
});
await check("3.3 病历已写出变化（m02PriorityTrendAnswered）：优先评估题不出，兜底接着走原顺序；没标记时照出（对照）", () => {
  const record = "宝宝两岁昨晚突然发高烧39.6，药效过了一直都是39.5度，白天降到38左右，17点又有38.8，这样一直发烧";
  const state = withFacts(caseOf(record, { sex: "男", age: 2 }), [trendFinding("宝宝两岁昨晚突然发高烧39.6")]);
  assert.match(contract.buildCaseAwareQuestionFallback(state, { settled: true }), /近来有没有加重/u);
  const answered = { ...state, m02PriorityTrendAnswered: true };
  assert.equal(contract.m02PriorityEvaluationQuestion(answered), undefined);
  const settled = contract.buildCaseAwareQuestionFallback(answered, { settled: true });
  assert.ok(!/近来有没有加重/u.test(settled), settled);
  // 走的是原来的兜底顺序：与没有这条线索的同一病例逐字相同
  assert.equal(settled, contract.buildCaseAwareQuestionFallback(caseOf(record, { sex: "男", age: 2 }), { settled: true }));
  assert.equal(contract.buildCaseAwareQuestionFallback(answered), contract.buildCaseAwareQuestionFallback(caseOf(record, { sex: "男", age: 2 })));
});
await check("3.4 趋势核对：病历写出变化且引文逐字时判已回答；没写、引文不逐字、不是 answered、模型失败、开关关闭都当没写（照常出题）", async () => {
  const record = "宝宝七个月昨天肚胀，晚上开始发烧，39度，用了退热栓退烧了，第二天还是烧38.8度，晚上七点量体温又烧38.8度了";
  const trend = { question: "病历记录“发烧，39度”。这一情况近来有没有加重？", options: ["近来加重，请补充具体表现", "没有加重"] };
  try {
    const bodies = stubModel({ record: () => ({ verdict: "answered", quotes: ["第二天还是烧38.8度", "又烧38.8度了"], reason: "已写先后读数" }) });
    assert.equal(await redundancy.priorityTrendAnsweredByRecord(trend, record), true);
    const system = bodies[0].messages[0].content;
    assert.ok(system.includes("趋势题：题干问某一情况近来有没有加重"), "趋势题的判法");
    assert.ok(!system.includes("optionValues") && !system.includes("第二件事"), "趋势核对不带选项重叠的第二件事");
    assert.deepEqual(Object.keys(JSON.parse(bodies[0].messages[1].content)), ["record", "question", "options"]);
    stubModel({ record: () => ({ verdict: "answered", quotes: ["病历没有这句话"], reason: "x" }) });
    assert.equal(await redundancy.priorityTrendAnsweredByRecord(trend, record), false, "引文不逐字");
    stubModel({ record: () => ({ verdict: "not_answered", quotes: [], reason: "x" }) });
    assert.equal(await redundancy.priorityTrendAnsweredByRecord(trend, record), false, "没写");
    stubModel({ record: () => ({ verdict: "partly", quotes: ["还是烧38.8度"], reason: "x" }) });
    assert.equal(await redundancy.priorityTrendAnsweredByRecord(trend, record), true, "partly 同样算已写出");
    globalThis.fetch = async () => { throw new Error("upstream down"); };
    assert.equal(await redundancy.priorityTrendAnsweredByRecord(trend, record), false, "模型失败");
    stubModel({ record: () => ({ verdict: "answered", quotes: ["还是烧38.8度"], reason: "x" }) });
    process.env.CDSS_M02_QUESTION_REDUNDANCY_CHECK = "false";
    assert.equal(await redundancy.priorityTrendAnsweredByRecord(trend, record), false, "开关关闭");
  } finally {
    delete process.env.CDSS_M02_QUESTION_REDUNDANCY_CHECK;
    globalThis.fetch = savedFetch;
  }
});

await check("3.5 已答守卫：病历已写病情趋势（逐渐加重…）时，「近来有没有加重」题与旧题干一样被确定性删掉；没写趋势的同一病例照出（对照）", () => {
  const trendBlock = (record) => contract.ensureQuestionStructuredEnvelope(
    contract.buildCaseAwareQuestionFallback(withFacts(caseOf(record, { sex: "男", age: 30 }), [trendFinding("大便黑色")])), record);
  const run = (record) => planOf(contract.enforceM02UnansweredAxes(trendBlock(record), record));
  assert.equal(run("大便黑色，逐渐加重一周").decision, "proceed");
  assert.equal(run("大便黑色，时好时坏一周").decision, "proceed");
  const kept = run("大便黑色一周");
  assert.equal(kept.decision, "ask");
  assert.match(kept.questions[0].question, /近来有没有加重/u);
});

// ───── 4 decision=proceed 的充分判据 ─────
await check("4.1 问答体记录里医生的提问不算患者表现：提问里的「发烧」「拉肚子」没被回答，不凑数（B-IMCS21-train-10141611#12）", () => {
  const record = [
    "孩子从暑假开始就感冒咳嗽，好个几天又开始咳嗽反反复复到现在，（晚上睡觉很爱流汗背上衣服都湿透了）",
    "问：您好 答：你好；问：流鼻涕不 答：不流鼻涕，只咳嗽，整晚都是咳；问：白天也是一阵一阵的咳嗽吗 答：白天没有晚上严重；问：发烧，拉肚子不 答：早晨起床也咳的厉害",
  ].join("\n");
  assert.equal(contract.m02RecordSufficientForProceed(record), false);
  // 对照：回答里写了（不发烧、不拉肚子）照常数
  assert.equal(contract.m02RecordSufficientForProceed(record.replace("答：早晨起床也咳的厉害", "答：不发烧，不拉肚子")), true);
  // 对照：非问答体的病历叙述照常数；舌脉都记录照常算充分
  assert.equal(contract.m02RecordSufficientForProceed("咳嗽反复，发烧过两次，拉肚子，晚上爱流汗"), true);
  assert.equal(contract.m02RecordSufficientForProceed("咳嗽反复。舌红苔黄，脉滑数。"), true);
  // 对照：没有「答：」的「问：」不动（找不到回答就不删）
  assert.equal(contract.m02RecordSufficientForProceed("咳嗽反复，发烧过两次，拉肚子，晚上爱流汗；问：还有吗"), true);
});
await check("4.2 不充分时 enforceM02UnansweredAxes 在 proceed 打开的部署里给服务端兜底题而不是 proceed；充分时仍 proceed（对照）", () => {
  const previous = process.env.CDSS_M02_PROCEED_WHEN_SETTLED;
  process.env.CDSS_M02_PROCEED_WHEN_SETTLED = "true";
  try {
    const insufficient = "孩子咳嗽反复，晚上爱流汗\n问：发烧，拉肚子不 答：早晨起床也咳的厉害";
    const fallback = contract.buildCaseAwareQuestionFallback(caseOf(insufficient, { sex: "男", age: "" }), { settled: true });
    const proceed = [START, JSON.stringify({ m02Plan: { schemaVersion: "tcm-cdss-m02-plan-v1", decision: "proceed", rationale: "足够", questions: [] } }), END].join("\n");
    assert.equal(planOf(contract.enforceM02UnansweredAxes(proceed, insufficient, fallback)).decision, "ask");
    const sufficient = "孩子咳嗽反复，发烧过两次，拉肚子，晚上爱流汗";
    assert.equal(planOf(contract.enforceM02UnansweredAxes(proceed, sufficient, fallback)).decision, "proceed");
  } finally {
    if (previous === undefined) delete process.env.CDSS_M02_PROCEED_WHEN_SETTLED; else process.env.CDSS_M02_PROCEED_WHEN_SETTLED = previous;
  }
});

// ───── 5 选项同值与单问点对象数 ─────
await check("5.1 optionsTakeSameValue：两段原文逐字出自对应选项才算；一边带否定/转折字（得温痛减对得温不减）不算同向；长度与段数不合规不算", () => {
  const same = redundancy.optionsTakeSameValue;
  const warm = ["得温痛减、遇寒加重", "喜温喜按、空腹痛甚、得食则缓"];
  const pack = (values) => JSON.stringify({ verdict: "not_answered", quotes: [], optionValues: values });
  assert.equal(same(pack(["得温痛减", "喜温"]), warm), true);
  assert.equal(same(pack(["喜热饮", "喜热饮"]), ["喜热饮，饮冷即呕清水", "口干不欲饮，喜热饮"]), true, "两个选项都写喜热饮（10825#5）");
  assert.equal(same(pack(["痰白清稀", "色白而稀"]), ["痰白清稀、量不多", "痰多色白而稀、喉间痰声辘辘"]), true, "痰色质地同值（9040#1）");
  assert.equal(same(pack(["得温痛减", "得温不减"]), ["得温痛减、遇寒加重", "得温不减、遇热反加重"]), false, "相反取值");
  assert.equal(same(pack(["遇寒加重", "遇热反加重"]), ["得温痛减、遇寒加重", "得温不减、遇热反加重"]), false, "转折字（反）");
  assert.equal(same(pack(["得温痛减", "得温后减轻"]), warm), false, "第二段不出自选项 B");
  assert.equal(same(pack(["温", "喜温"]), warm), false, "单字");
  assert.equal(same(pack(["得温痛减", "喜温", "遇寒加重"]), warm), false, "三段");
  assert.equal(same(pack([]), warm), false, "空数组 = 互斥");
  assert.equal(same("not json", warm), false);
  assert.equal(same(pack(["得温痛减", "喜温"]), [warm[0]]), false, "选项不是两个");
  assert.equal(same(JSON.stringify({ verdict: "not_answered", quotes: [] }), warm), false, "没有 optionValues 字段（开关关闭的老形态）");
});
await check("5.2 经窄核对入口：两个选项同值的模型题被删，互斥的题不动；重复病历的判定优先且各题号只出现一次；请求带上选项", async () => {
  const warmQuestion = question("胃痛时对冷热的反应更接近哪一种？", "得温痛减、遇寒加重", "喜温喜按、空腹痛甚、得食则缓");
  const coldQuestion = question("胃痛时对冷热的反应更接近哪一种？", "得温痛减、遇寒加重", "得温不减、遇热反加重");
  try {
    let bodies = stubModel({ record: (body) => {
      const overlap = JSON.parse(body.messages[1].content).options[1].includes("喜温喜按");
      return { verdict: "not_answered", quotes: [], reason: "", optionValues: overlap ? ["得温痛减", "喜温"] : [] };
    } });
    assert.deepEqual(await redundancy.questionIdsFailingNarrowChecks(envelope(warmQuestion), "胃痛3天。", ""), ["q1"]);
    assert.deepEqual(await redundancy.questionIdsFailingNarrowChecks(envelope(coldQuestion), "胃痛3天。", ""), []);
    const recordBody = bodies.find((body) => body.messages[0].content.includes("追问题与病历的重复核对器"));
    assert.ok(recordBody.messages[0].content.includes("另外还有第二件事"), "重复核对的提示词带选项同值这一件事");
    assert.ok(recordBody.messages[0].content.includes("optionValues"));
    assert.deepEqual(JSON.parse(recordBody.messages[1].content).options, ["得温痛减、遇寒加重", "喜温喜按、空腹痛甚、得食则缓"]);
    // 单问点核对仍只给题干（test-r1019-safety-m02 Q3.1 的口径：选项一变它的结论就变）
    const stemBody = bodies.find((body) => body.messages[0].content.includes("题干是不是要患者分别回答两个不同对象的情况"));
    assert.deepEqual(Object.keys(JSON.parse(stemBody.messages[1].content)), ["question"]);
    // 重复病历与选项同值同时成立：只出现一次
    stubModel({ record: () => ({ verdict: "answered", quotes: ["胃痛3天"], reason: "x", optionValues: ["得温痛减", "喜温"] }) });
    assert.deepEqual(await redundancy.questionIdsFailingNarrowChecks(envelope(warmQuestion), "胃痛3天。", ""), ["q1"]);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
await check("5.3 开关 CDSS_M02_OPTION_OVERLAP_CHECK=false：发出的重复核对请求与改动前逐字相同（无第二件事、无 optionValues），同值的题照出", async () => {
  process.env.CDSS_M02_OPTION_OVERLAP_CHECK = "false";
  try {
    const bodies = stubModel({ record: () => ({ verdict: "not_answered", quotes: [], reason: "", optionValues: ["得温痛减", "喜温"] }) });
    const warmQuestion = question("胃痛时对冷热的反应更接近哪一种？", "得温痛减、遇寒加重", "喜温喜按、空腹痛甚、得食则缓");
    assert.deepEqual(await redundancy.questionIdsFailingNarrowChecks(envelope(warmQuestion), "胃痛3天。", ""), []);
    const system = bodies.find((body) => body.messages[0].content.includes("追问题与病历的重复核对器")).messages[0].content;
    assert.ok(!system.includes("第二件事") && !system.includes("optionValues"));
    assert.ok(system.includes("只判断一件事：这道题要问的内容，病历里是不是已经写明了。"), "开关关闭时保留改动前的原句");
    assert.ok(system.endsWith("只输出 JSON：{\"verdict\":\"answered|partly|not_answered\",\"quotes\":[\"…\"],\"reason\":\"…\"}"));
  } finally {
    delete process.env.CDSS_M02_OPTION_OVERLAP_CHECK;
    globalThis.fetch = savedFetch;
  }
});
await check("5.4 单问点提示词：大便气味与肛门感觉、咳嗽力度与痰量是两个对象；同一排出物的几项特征仍是一个对象；冷热与按压的疼痛反应仍按 10/19 口径是一个问点（对照）", async () => {
  try {
    const bodies = stubModel({ record: () => ({ verdict: "not_answered", quotes: [], reason: "" }) });
    await redundancy.questionIdsFailingNarrowChecks(envelope(question("胃痛时对冷热的反应更接近哪一种？", "得温痛减", "得温不减")), "胃痛3天。", "");
    const system = bodies.find((body) => body.messages[0].content.includes("题干是不是要患者分别回答两个不同对象的情况")).messages[0].content;
    const compoundLine = system.split("\n").find((line) => line.startsWith("- compound"));
    const singleLine = system.split("\n").find((line) => line.startsWith("- single"));
    assert.ok(compoundLine.includes("“大便的气味和排便时肛门的感觉”") && compoundLine.includes("“咳嗽的力度和痰量”"), compoundLine);
    assert.ok(singleLine.includes("“大便的气味和性状更接近哪一种”") && singleLine.includes("“大便的颜色和性状”"), singleLine);
    assert.ok(singleLine.includes("疼痛对冷热和按压的反应"), "10/19 项目负责人口径不变");
    assert.ok(!singleLine.includes("大便的性状和排便时的感觉"), "旧的含糊示例已换掉");
    assert.ok(system.includes("对象数的判法"));
  } finally {
    globalThis.fetch = savedFetch;
  }
});

// ───── 6 窄核对读的病历文本 ─────
await check("6.1 m02NarrowCheckRecordText：对话里的「题干 + 回答」按问答体补在病历文本后面；无对话、跳过句、不跟在题干后的 user 消息都不补（对照）", () => {
  const text = "宝宝发烧，吃鸡蛋可以吗";
  const added = contract.m02NarrowCheckRecordText(text, [
    { role: "assistant", content: "有没有腹泻、咳嗽、流涕？" },
    { role: "user", content: "都没有" },
  ]);
  assert.equal(added, `${text}\n问：有没有腹泻、咳嗽、流涕？ 答：都没有`);
  assert.equal(contract.m02NarrowCheckRecordText(text, []), text);
  assert.equal(contract.m02NarrowCheckRecordText(text, undefined), text);
  assert.equal(contract.m02NarrowCheckRecordText(text, [{ role: "assistant", content: "还有别的不适吗？" }, { role: "user", content: followup.FOLLOWUP_SKIP_SENTENCE }]), text, "跳过句");
  assert.equal(contract.m02NarrowCheckRecordText(text, [{ role: "user", content: "我孩子昨晚开始咳嗽" }]), text, "对话里口述的主叙述已在 trustedInputText 里");
});
await check("6.2 路由把补全后的文本交给急症筛查核对与窄核对（源码断言：两处都读 narrowCheckRecordText，不再读 sourceText）", () => {
  const source = fs.readFileSync(path.join(SRC, "app/api/diagnosis/question/route.ts"), "utf8");
  assert.ok(source.includes("const narrowCheckRecordText = m02NarrowCheckRecordText(sourceText, safeCaseState.conversation);"));
  assert.ok(source.includes("riskCategoryRecordStatus(inputCaseState, narrowCheckRecordText, signal)"));
  assert.ok(source.includes("questionIdsFailingNarrowChecks(split.content, narrowCheckRecordText,"));
  assert.ok(source.includes("priorityTrendAnsweredByRecord(trend, narrowCheckRecordText, signal)"));
  assert.ok(!/riskCategoryRecordStatus\(inputCaseState, sourceText/u.test(source));
  assert.ok(!/questionIdsFailingNarrowChecks\(split\.content, sourceText/u.test(source));
});

// ───── 7 出题提示词 ─────
await check("7.1 出题提示词：未满 3 岁婴幼儿一条（不问脉象、口渴喜冷热、咽痛、头痛；不满 1 岁不问痰色；问吃奶、精神、大便、尿量、手脚温凉、睡汗、呼吸费力）；选项互斥举例含痰与饮水冷热", () => {
  const prompt = prompts.buildQuestionPrompt(caseOf("宝宝咳嗽三天", { sex: "男", age: "8个月" }));
  assert.ok(prompt.includes("未满3岁的婴幼儿（含新生儿、乳婴儿；病历只写“宝宝、孩子”而没有年龄的也按此处理）"));
  assert.ok(prompt.includes("不问脉象、口渴想喝凉的还是热的、咽痒咽痛、头痛头晕；问家长和医生看得到的"));
  assert.ok(prompt.includes("吃奶或进食、精神反应、大便、尿量、手脚温凉、睡着后出汗、呼吸是否费力"));
  assert.ok(prompt.includes("不满1岁的婴儿还不会咳痰，不问痰的颜色质地，改问喉间有无痰声"), "痰色只对不满 1 岁的婴儿禁问：1–3 岁及年龄不详的孩子问痰的题评审多判合格（24 道里 23 道）");
  assert.ok(prompt.includes("一个写痰白清稀、另一个写痰黄黏稠，不能两个都是白稀痰、只在量上有别"));
  assert.ok(prompt.includes("一个写喜热饮、另一个写喜凉饮，不能两个都写喜热饮"));
  // 对照：原有约束还在
  assert.ok(prompt.includes("题干只问一件事（一个维度）"));
  assert.ok(prompt.includes("儿童等特殊人群要结合当前主诉和已有事实评估全身状态与处置优先级"));
});

const summary = { suite: "r1020-m02", src: SRC, cases, failures };
console.log(JSON.stringify(summary, null, 1));
if (failures.length > 0) process.exitCode = 1;
