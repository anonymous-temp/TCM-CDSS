import { readFileSync } from "node:fs";
// 10.12 测评整改之后的余项（2026-10-14）。
//
// 依据是第二轮独立评审逐例列出的不通过项与硬伤（32 例；评审材料与结论在仓库外 ~/runlogs/fix1012/out/judge2）。
// 每一节对应其中一类问题；每条断言都带反证（把改动撤掉或换成对照输入后必须变红）。
// 辨证依据「模型原文被拼接句顶掉」与饮食栏追加通用句两项的断言在 test-diagnosis-stage-contract.mjs（那里有现成的 M03/M04 夹具）。
//
//   1 注意事项：说「方中有某药」而该药不在本方；提到本次没有给出的治疗项目
//   2 追问：一轮只问一题；病历已答的急症筛查题不再问；「其他急危重线索」的题有所指；红旗已成立时问处置
//   3 西医诊断：病名与病历已记录内容矛盾或说过头时的改名——只采信带病历原文引文的结论，只改病名一项
//   5 煎服用法：先煎且久煎的毒性药（附子等）单列，写 45–60 分钟至口尝无麻辣感
//   6 药味功效：外用功效不作为内服汤剂里该药的功效
//   7 中医鉴别：闭集选择点了名时候选只给这几个病；病名级鉴别缺失时只补写这一项（区分要点说本例，不贴教材定义）
//   4 针刺方案：教材分「实证 / 虚证」写的只取本例那一套；未按证型配穴时不写按病的治法；老年人、虚证、皮肤破损不列刺络拔罐；
//     老年人针刺量宜小；高血压专篇的疗程不套到没有高血压的眩晕上；外感/内伤写在一句里的只留本例那半句，别的项目不借针刺的疗程；
//     补泻手法与证候相反的泛指句改成相符的（点名到穴位的定法不动）；「进针深度」只写在用针的项目上
//   8 交付面：针刺卡里说流程的模板半句（复评、课程索引）；西医鉴别里模型自己写明「不适用」的项
//   9 不给剂量页的调护：只去掉被掩码改写的那一小句
//  10 注意事项按本例收口：已确认妊娠不写「如已怀孕」的假设小句；红旗未解除不写怎么服这张方
//  11 鉴别对象的「典型表现」不按本例阴性净化（JSON 字段与正文「常见：」一句同一口径）
//  12 方义核对：「芳香」不是药名（旧目录把它归成白芷）；分句里同时有本方药和外来药时只删外来药名
//  13 只记录主症、没有能分证型的表现时不套教材证型：提示词说明「贴合」的含义与中性写法；服务端改名不替模型新下病性；
//     组成逻辑按临床写法只写组成与出处，且这种条目不顶替方义
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const check = (name, run) => {
  cases += 1;
  try {
    run();
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};
const checkAsync = async (name, run) => {
  cases += 1;
  try {
    await run();
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

// ───── 1 注意事项与本方、与本次治疗项目一致 ─────
{
  const { precautionNamesHerbOutsideFormula } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
  const { precautionMentionsUndeliveredTreatment } = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
  const { canonicalTcmHerbIdentity } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
  const formula = new Set(["法半夏", "陈皮", "茯苓", "苍术", "厚朴", "紫苏子", "莱菔子", "人参"].map((name) => canonicalTcmHerbIdentity(name)));

  check("1.1 处方已去白芥子，注意事项不得再说「方中法半夏、白芥子偏温燥」", () => {
    assert.equal(precautionNamesHerbOutsideFormula("方中法半夏、白芥子偏温燥，服药期间多饮温水。", formula), true);
  });
  check("1.2 说的是本方确有的药时保留（对照）", () => {
    assert.equal(precautionNamesHerbOutsideFormula("方中法半夏、陈皮偏温燥，服药期间多饮温水。", formula), false);
    assert.equal(precautionNamesHerbOutsideFormula("方中有人参，服药时不宜同服萝卜、浓茶。", formula), false);
  });
  check("1.3 方外之物的配伍与忌口提示不算（「不宜同服藜芦、五灵脂」说的本来就不是本方的药）", () => {
    assert.equal(precautionNamesHerbOutsideFormula("方中有人参，服药时不宜同服藜芦、五灵脂制剂。", formula), false);
    assert.equal(precautionNamesHerbOutsideFormula("服药期间不宜同服藜芦、五灵脂制剂。", formula), false);
    assert.equal(precautionNamesHerbOutsideFormula("方中人参不宜与藜芦、五灵脂同服。", formula), false, "同一小句里跟在禁忌词后面的并列药名同样不算");
    assert.equal(precautionNamesHerbOutsideFormula("方中人参、藜芦同用，注意观察。", formula), true, "没有禁忌词时照常核对（对照）");
  });
  check("1.4 没有处方药味可核时不判（不猜）", () => {
    assert.equal(precautionNamesHerbOutsideFormula("方中白芥子偏温燥。", new Set()), false);
  });
  check("1.5 提到本次没有给出的治疗项目的那一条丢掉；给了的保留", () => {
    assert.equal(precautionMentionsUndeliveredTreatment("耳穴及针刺治疗须由专业医师操作，治疗后避风。", new Set(["auricular"])), true);
    assert.equal(precautionMentionsUndeliveredTreatment("耳穴及针刺治疗须由专业医师操作，治疗后避风。", new Set(["auricular", "acupuncture"])), false);
    assert.equal(precautionMentionsUndeliveredTreatment("艾灸后注意保暖，局部勿抓挠。", new Set(["acupuncture"])), true);
    assert.equal(precautionMentionsUndeliveredTreatment("针灸治疗后当日不宜洗冷水澡。", new Set(["moxibustion"])), false, "「针灸」泛指，给了针或灸之一即可");
    assert.equal(precautionMentionsUndeliveredTreatment("饭后温服，忌生冷。", new Set()), false);
  });
}

// ───── 2 追问 ─────
{
  Object.assign(process.env, {
    AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://api.deepseek.com",
    OPENAI_MODEL: "deepseek-flash", CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash", PRIMARY_QUESTION_MODEL: "deepseek-flash",
    CDSS_CLINICAL_FACTS_BACKSTOP: "false", CDSS_M02_PRECOMPUTE_NO_ANSWER: "false",
  });
  const contract = await jiti.import("../src/lib/m02-question-contract.ts");
  const followup = await jiti.import("../src/lib/followup-conversation.ts");
  const answerability = await jiti.import("../src/lib/m02-risk-question-answerability.server.ts");
  const START = "<!-- DIAGNOSIS_JSON_START -->";
  const END = "<!-- DIAGNOSIS_JSON_END -->";
  const planOf = (content) => JSON.parse(content.slice(content.indexOf(START) + START.length, content.indexOf(END))).m02Plan;
  const modelQuestion = (question, decisionBranch, a, b) => ({
    id: "q1", question, reason: "两种情况对应不同证型，用方不同。", targetField: "xianbingshi", decisionBranch,
    expectedDecisionImpact: "区分两种候选证型。", informationGain: 0.7, sourceEvidence: [],
    options: [
      { id: "a", label: "甲", answer: a, kind: "clinical_fact", recordValue: a },
      { id: "b", label: "乙", answer: b, kind: "clinical_fact", recordValue: b },
      { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
    ],
  });
  const modelPlan = (...questions) => JSON.stringify({ m02Plan: { schemaVersion: "tcm-cdss-m02-plan-v1", decision: "ask", rationale: "需要一条区分证型的事实。", questions: questions.map((item, index) => ({ ...item, id: `q${index + 1}` })) } });
  const asthma = {
    patient: { sex: "男", age: 38 }, chiefComplaint: "反复发作性喘息、喉中哮鸣10年，再发2天",
    symptoms: { presentHistory: "2天前受凉后再次发作，呼吸急促，喉间哮鸣。现能平卧，能完整成句说话，无口唇发紫，无发热。" },
  };
  const record = `${asthma.chiefComplaint}\n${asthma.symptoms.presentHistory}`;
  const urgent = (category, quote = "呼吸急促") => ({ redFlags: [{ category, status: "possible", urgency: "urgent", quote }] });
  const finalize = (state, providerContent) => planOf(contract.enforceM02UnansweredAxes(
    contract.ensureQuestionStructuredEnvelope(providerContent, record, contract.buildCaseAwareQuestionFallback(state)),
    record,
    contract.buildCaseAwareQuestionFallback(state, { settled: true }),
    state,
  ));
  const syndromeQuestion = modelQuestion("痰的颜色与质地是哪一种？", "syndrome", "痰稀薄色白、多泡沫", "痰黄黏稠、不易咳出");
  const triageQuestion = modelQuestion("原血栓侧下肢与对侧相比有无新发肿胀或疼痛？", "triage", "原血栓侧新发肿胀或疼痛", "双下肢对称，无新发肿胀疼痛");

  check("2.1 一轮只问一题：有急症筛查题时只问它，不再另带一题", () => {
    const plan = finalize({ ...asthma, clinicalFacts: urgent("respiratory") }, modelPlan(syndromeQuestion));
    assert.equal(plan.questions.length, 1, JSON.stringify(plan.questions.map((item) => item.question)));
    assert.equal(plan.questions[0].question, followup.POSSIBLE_RISK_QUESTIONS.respiratory.question);
  });
  check("2.2 模型一次给了两题也只留一题", () => {
    const second = modelQuestion("平时怕冷还是怕热？", "syndrome", "怕冷、喜热饮", "怕热、喜冷饮");
    const plan = finalize(asthma, modelPlan(syndromeQuestion, second));
    assert.equal(plan.questions.length, 1);
    assert.equal(plan.questions[0].question, syndromeQuestion.question);
  });
  check("2.3 病历已回答的筛查类目不再出筛查题，改问模型那一题", () => {
    const plan = finalize({ ...asthma, clinicalFacts: urgent("respiratory"), m02SuppressedRiskCategories: ["respiratory"] }, modelPlan(syndromeQuestion));
    assert.equal(plan.questions.length, 1);
    assert.equal(plan.questions[0].question, syndromeQuestion.question);
  });
  check("2.4 「其他急危重线索」：模型按该线索写了澄清题就用它，不再前置「请复核该异常」", () => {
    const state = { ...asthma, clinicalFacts: urgent("other_critical", "3个月前左下肢深静脉血栓形成") };
    const plan = finalize(state, modelPlan(triageQuestion));
    assert.equal(plan.questions.length, 1);
    assert.equal(plan.questions[0].question, triageQuestion.question);
  });
  check("2.5 「其他急危重线索」：模型没有针对它出题时，筛查题带上病历原话，「该异常」有所指", () => {
    const state = { ...asthma, clinicalFacts: urgent("other_critical", "3个月前左下肢深静脉血栓形成") };
    const plan = finalize(state, modelPlan(syndromeQuestion));
    assert.equal(plan.questions.length, 1);
    assert.equal(plan.questions[0].question, `病历记录“3个月前左下肢深静脉血栓形成”。${followup.POSSIBLE_RISK_QUESTIONS.other_critical.question}`);
    // 医生选了阳性选项：闸门仍按固定题干识别出类目（引文不影响识别）。
    const conversation = [
      { role: "assistant", content: plan.questions[0].question },
      { role: "user", content: followup.POSSIBLE_RISK_QUESTIONS.other_critical.positive },
    ];
    assert.deepEqual(followup.confirmedRiskScreeningCategories(conversation).map((item) => item.category), ["other_critical"]);
    assert.deepEqual(followup.confirmedRiskScreeningCategories([
      conversation[0], { role: "user", content: followup.POSSIBLE_RISK_QUESTIONS.other_critical.negative },
    ]), [], "阴性选项不构成确认（对照）");
  });
  check("2.6 核对结果的采信：结论为已写明没有/前提不成立，且引文逐字在病历里", () => {
    const ok = (payload) => answerability.recordAnswersRiskQuestion(JSON.stringify(payload), record);
    assert.equal(ok({ verdict: "answered_negative", quotes: ["现能平卧", "能完整成句说话", "无口唇发紫"] }), true);
    assert.equal(ok({ verdict: "not_applicable", quotes: ["无发热"] }), true);
    assert.equal(ok({ verdict: "answered_negative", quotes: ["现能平卧", "无呼吸困难"] }), false, "有一条引文不在病历里就不采信");
    assert.equal(ok({ verdict: "answered_negative", quotes: [] }), false, "没有引文不采信");
    assert.equal(ok({ verdict: "answered_positive", quotes: ["呼吸急促"] }), false, "病历写明存在的照常出题");
    assert.equal(ok({ verdict: "not_answered", quotes: ["现能平卧"] }), false);
    assert.equal(answerability.recordAnswersRiskQuestion("不是 JSON", record), false);
  });
  const savedFetch = globalThis.fetch;
  const completion = (payload) => new Response(JSON.stringify({
    id: "t", object: "chat.completion", model: "deepseek-flash",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { headers: { "content-type": "application/json" } });
  await checkAsync("2.7 出题前的核对：病历已答 ⇒ 该类目不出筛查题；没答、模型失败、开关关闭 ⇒ 照常出题", async () => {
    let calls = 0;
    try {
      globalThis.fetch = async () => { calls += 1; return completion({ verdict: "answered_negative", quotes: ["现能平卧", "无口唇发紫"] }); };
      assert.deepEqual(await answerability.riskCategoriesAnsweredByRecord({ ...asthma, clinicalFacts: urgent("respiratory") }, record), ["respiratory"]);
      assert.equal(calls, 1);
      const unanswered = "胸闷2天";
      globalThis.fetch = async () => { calls += 1; return completion({ verdict: "not_answered", quotes: ["胸闷2天"] }); };
      assert.deepEqual(await answerability.riskCategoriesAnsweredByRecord({ chiefComplaint: unanswered, clinicalFacts: urgent("cardiac", "胸闷") }, unanswered), []);
      globalThis.fetch = async () => { throw new Error("upstream down"); };
      assert.deepEqual(await answerability.riskCategoriesAnsweredByRecord({ chiefComplaint: "气喘1天", clinicalFacts: urgent("respiratory", "气喘") }, "气喘1天"), [], "模型不可用时照常出题");
      // 「其他急危重线索」没有固定内容可核对，不调用模型。
      const before = calls;
      globalThis.fetch = async () => { calls += 1; return completion({ verdict: "answered_negative", quotes: ["现能平卧"] }); };
      assert.deepEqual(await answerability.riskCategoriesAnsweredByRecord({ ...asthma, clinicalFacts: urgent("other_critical", "呼吸急促") }, record), []);
      assert.equal(calls, before);
      process.env.CDSS_M02_RISK_QUESTION_ANSWERABILITY = "false";
      assert.deepEqual(await answerability.riskCategoriesAnsweredByRecord({ ...asthma, clinicalFacts: urgent("sepsis", "发热") }, `${record}（开关关闭）`), []);
      assert.equal(calls, before, "开关关闭时不调用模型");
    } finally {
      delete process.env.CDSS_M02_RISK_QUESTION_ANSWERABILITY;
      globalThis.fetch = savedFetch;
    }
  });
  check("2.8 红旗已成立时的那一题：说明是哪一条急危重情况，问是否已安排急诊评估或转诊", () => {
    const block = contract.redFlagDispositionQuestion(["血压 70/40mmHg 达低血压/休克风险警戒值，需立即复测并评估循环灌注", "呼吸 44次/分异常，需先评估呼吸循环风险"]);
    const plan = planOf(contract.ensureQuestionStructuredEnvelope(block, "腹泻、呕吐3天，无尿8小时"));
    assert.equal(plan.decision, "ask");
    assert.equal(plan.questions.length, 1);
    assert.equal(plan.questions[0].question, "血压 70/40mmHg 达低血压/休克风险警戒值。请先按急症处置；目前是否已安排急诊评估或转诊？");
    assert.equal(plan.questions[0].decisionBranch, "triage");
    assert.deepEqual(plan.questions[0].options.map((item) => item.answer).slice(0, 2), ["已安排急诊评估或转诊", "尚未安排，正在现场评估"]);
    assert.ok(plan.questions[0].options.some((item) => item.kind === "unknown"));
    const semantic = contract.redFlagDispositionQuestion(["现有资料提示需立即急诊评估（需排除：细菌性脑膜炎），原文依据：“高热、头痛3天，神志改变半天”"]);
    assert.match(semantic, /现有资料提示需立即急诊评估（需排除：细菌性脑膜炎）。请先按急症处置/);
  });
  check("2.10 病历已齐全、模型也没有要问的：最后一道题是不预设内容的开放题，不再是主诉类别的危险征象筛查", () => {
    const complete = {
      patient: { sex: "男", age: 48 }, chiefComplaint: "右膝、右踝关节红肿热痛3天", tongue: "舌红，苔黄腻", pulse: "脉滑数",
      symptoms: { presentHistory: "右膝、右踝关节疼痛，局部红肿、摸着发烫，发热，体温37.9℃，怕风，出汗，口渴，小便黄，大便干。" },
    };
    const settled = contract.buildCaseAwareQuestionFallback(complete, { settled: true });
    assert.match(settled, /除病历已记录的情况外，患者还有没有其他不适需要一并处理？/);
    assert.doesNotMatch(settled, /外伤|局部红肿热/, "不得再问病历已写明的内容");
    // 病历没写到寒热/口渴/大便/汗出之一时，仍先问那一项（对照）。
    const missingThirst = { ...complete, symptoms: { presentHistory: "右膝、右踝关节疼痛，局部红肿，怕风，出汗，大便干。" } };
    assert.match(contract.buildCaseAwareQuestionFallback(missingThirst, { settled: true }), /口渴吗/);
    // 模型输出不可用时的安全兜底不变（对照）：仍是主诉类别的题。
    assert.doesNotMatch(contract.buildCaseAwareQuestionFallback(complete), /还有没有其他不适/);
  });
  check("2.12 四项生命体征都已录入时，问「生命体征」的题按已回答处理（模型曾问「生命体征栏记录的 90 指的是哪一项」）", () => {
    const vitalsQuestion = { ...modelQuestion("病历生命体征栏记录的“90”指的是哪一项？", "triage", "收缩压90mmHg", "脉搏90次/分"), targetField: "vitalsDetail" };
    const recorded = { ...asthma, vitals: { T: "37.9", P: "90", R: "18", BP: "128/82" } };
    const plan = finalize(recorded, modelPlan(vitalsQuestion));
    assert.ok(!plan.questions.some((item) => item.question.includes("90")), JSON.stringify(plan.questions.map((item) => item.question)));
    const partial = { ...asthma, vitals: { T: "37.9", P: "90" } };
    assert.ok(finalize(partial, modelPlan(vitalsQuestion)).questions.some((item) => item.question.includes("90")), "体征没录全时照常问（对照）");
  });
  await checkAsync("2.11 病历已回答的急症线索不再写进出题提示词（否则模型按「有线索就问它」再问一遍）", async () => {
    const { buildQuestionPrompt } = await jiti.import("../src/lib/diagnosis-prompts.ts");
    const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
    const state = normalizeCaseStateInput({
      id: "eval1014-prompt", phase: "question", questionRounds: 0, maxQuestionRounds: 1, conversation: [], customerId: "test-hospital",
      patient: { sex: "女", age: 2 }, chiefComplaint: "腹泻、发热2天", symptoms: { presentHistory: "腹泻水样便，发热，精神尚可，无抽搐。" },
    });
    state.clinicalFacts = { redFlags: [
      { category: "sepsis", subject: "patient", status: "possible", urgency: "urgent", quote: "发热" },
      { category: "pediatric_critical", subject: "patient", status: "possible", urgency: "urgent", quote: "腹泻水样便" },
    ] };
    const marker = (category) => `"category":"${category}"`;
    const all = buildQuestionPrompt(state);
    assert.ok(all.includes(marker("sepsis")) && all.includes(marker("pediatric_critical")), "对照：未核对时两条线索都在提示词里");
    const settled = buildQuestionPrompt(state, ["sepsis"]);
    assert.ok(!settled.includes(marker("sepsis")), "已回答的类目不再出现");
    assert.ok(settled.includes(marker("pediatric_critical")), "其余线索保留");
  });
  await checkAsync("2.9 出题路由：闸门已判急危重 ⇒ 不调用模型，直接给处置确认题；允许不追问时返回 proceed", async () => {
    const { POST } = await jiti.import("../src/app/api/diagnosis/question/route.ts");
    // 只数出题那次调用（流式）；为下一阶段预取输入的小任务（非流式）与本断言无关，让它们按不可用处理。
    let upstream = 0;
    globalThis.fetch = async (_url, init) => {
      if (JSON.parse(String(init?.body || "{}")).stream) upstream += 1;
      throw new Error("no upstream in this test");
    };
    const run = async () => {
      const response = await POST(new Request("http://localhost/api/diagnosis/question", {
        method: "POST", headers: { "Content-Type": "application/json", "x-cdss-customer-id": "test-hospital" },
        body: JSON.stringify({ caseState: {
          id: "eval1014-redflag", phase: "question", questionRounds: 0, maxQuestionRounds: 1, conversation: [],
          patient: { sex: "男", age: 1 }, chiefComplaint: "腹泻、呕吐3天，无尿8小时",
          symptoms: { 现病史: "患儿1岁，3天前开始腹泻，每日十余次蛋花汤样便，今日精神萎靡，嗜睡，已8小时无尿。" },
          vitals: { T: "36.2", P: "172", R: "44", BP: "70/40" },
        } }),
      }));
      assert.equal(response.status, 200);
      const text = (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line).content || "").filter((chunk) => chunk !== "[END]").join("");
      return planOf(text);
    };
    try {
      const asked = await run();
      assert.equal(asked.questions.length, 1);
      assert.match(asked.questions[0].question, /请先按急症处置；目前是否已安排急诊评估或转诊？$/);
      assert.doesNotMatch(asked.questions[0].question, /大便性状|怕冷|口角歪斜/);
      process.env.CDSS_M02_PROCEED_WHEN_SETTLED = "true";
      const proceed = await run();
      assert.equal(proceed.decision, "proceed");
      assert.deepEqual(proceed.questions, []);
      assert.equal(upstream, 0, "两种出口都不调用出题模型");
    } finally {
      delete process.env.CDSS_M02_PROCEED_WHEN_SETTLED;
      globalThis.fetch = savedFetch;
    }
  });
}

// ───── 3 西医诊断名与病历已记录内容的一致性 ─────
{
  const westernCheck = await jiti.import("../src/lib/western-name-evidence-check.server.ts");
  const record = "主诉：白天嗜睡半年\n现病史：白天困倦，坐着就能睡着。家属诉其夜间睡眠时无明显打鼾、憋气。\n月经史：周期尚规律，经量少。\n辅助检查：抗缪勒管激素0.9ng/ml";
  const verdict = (payload) => JSON.stringify({ verdict: "inconsistent", type: "B", quote: "家属诉其夜间睡眠时无明显打鼾、憋气", reason: "核心表现夜间打鼾憋气病历记录为无", supportedName: "白天嗜睡待查", ...payload });
  const parse = (payload, name = "睡眠呼吸暂停低通气综合征") => westernCheck.parseWesternNameCorrection(verdict(payload), record, name);

  check("3.1 结论为矛盾、引文逐字在病历里、名称合规时才采信", () => {
    assert.deepEqual(parse({}), { supportedName: "白天嗜睡待查", quote: "家属诉其夜间睡眠时无明显打鼾、憋气", reason: "核心表现夜间打鼾憋气病历记录为无", type: "B" });
    assert.deepEqual(westernCheck.parseWesternNameCorrection(JSON.stringify({ verdict: "inconsistent", type: "C", quote: "周期尚规律", reason: "诊断要求月经稀发或闭经，病历记录周期规律", supportedName: "卵巢储备功能减退" }), record, "早发性卵巢功能不全")?.supportedName, "卵巢储备功能减退");
  });
  check("3.2 不采信：判一致、引文不在病历里、名称带括号/并列/推测/证候、与原名相同、情形不在三类之内", () => {
    assert.equal(parse({ verdict: "consistent" }), undefined);
    assert.equal(parse({ quote: "夜间无打鼾" }), undefined, "引文必须逐字在病历里");
    assert.equal(parse({ quote: "嗜睡" }), undefined, "引文太短不足以成为依据");
    for (const name of ["发作性睡病（待排）", "嗜睡或发作性睡病", "发作性睡病可能", "痰湿困脾证", "睡眠呼吸暂停低通气综合征", "A", ""]) {
      assert.equal(parse({ supportedName: name }), undefined, `不合规的名称：${name}`);
    }
    assert.equal(parse({ type: "E" }), undefined, "情形只有 A–D");
    assert.equal(parse({ reason: "" }), undefined, "没有理由不采信");
    assert.equal(westernCheck.parseWesternNameCorrection("不是 JSON", record, "阴道炎"), undefined);
  });
  check("3.3 采信后只改病名：原病名留在候选与鉴别里，其余字段逐字不动", () => {
    const western = { westernDiagnosis: {
      primary: { name: "睡眠呼吸暂停低通气综合征", status: "考虑", confidence: "中", supportingFacts: ["白天困倦"], clinicalRationale: "白天嗜睡支持睡眠障碍方向。", limitations: [], suggestedChecks: [] },
      differentials: [{ name: "发作性睡病", reason: "同为日间嗜睡", distinguishingPoints: "未诉猝倒发作", nextCheck: "多次睡眠潜伏期试验" }],
      candidates: [{ name: "睡眠呼吸暂停低通气综合征", likelihood: "中", keyEvidence: ["白天困倦"], againstEvidence: [] }, { name: "发作性睡病", likelihood: "低", keyEvidence: [], againstEvidence: [] }],
    }, management: { redFlagLoop: "无", mustCollect: [], followupSafetyNet: "请服完本次的药后复诊。" } };
    const out = JSON.parse(westernCheck.applyWesternNameCorrection(JSON.stringify(western), parse({})));
    assert.equal(out.westernDiagnosis.primary.name, "白天嗜睡待查");
    assert.deepEqual({ ...out.westernDiagnosis.primary, name: western.westernDiagnosis.primary.name }, western.westernDiagnosis.primary, "主诊断的其余字段不动");
    assert.deepEqual(out.westernDiagnosis.candidates.map((item) => item.name), ["白天嗜睡待查", "睡眠呼吸暂停低通气综合征", "发作性睡病"]);
    assert.deepEqual(out.westernDiagnosis.candidates[1].againstEvidence, ["家属诉其夜间睡眠时无明显打鼾、憋气"], "原病名的反对依据是那句病历原文");
    assert.equal(out.westernDiagnosis.differentials[0].name, "睡眠呼吸暂停低通气综合征");
    assert.equal(out.westernDiagnosis.differentials[0].distinguishingPoints, "核心表现夜间打鼾憋气病历记录为无");
    assert.deepEqual(out.westernDiagnosis.differentials[1], western.westernDiagnosis.differentials[0]);
    assert.deepEqual(out.management, western.management);
    assert.equal(westernCheck.applyWesternNameCorrection("不是 JSON", parse({})), "不是 JSON", "解析不了时原样返回");
  });
  const savedFetch = globalThis.fetch;
  const completion = (payload) => new Response(JSON.stringify({
    id: "t", object: "chat.completion", model: "deepseek-flash",
    choices: [{ index: 0, message: { role: "assistant", content: typeof payload === "string" ? payload : JSON.stringify(payload) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { headers: { "content-type": "application/json" } });
  await checkAsync("3.4 收口：模型不可用、判一致、开关关闭、已是「待查」⇒ 西医半原样返回", async () => {
    const half = (name) => JSON.stringify({ westernDiagnosis: { primary: { name }, differentials: [], candidates: [{ name }] }, management: {} });
    let calls = 0;
    // 这一条只数核对模型的调用；诊断标准的现场检索另见 15.17。
    process.env.CDSS_WEB_SEARCH = "false";
    try {
      globalThis.fetch = async () => { calls += 1; return completion(verdict({})); };
      const changed = JSON.parse(await westernCheck.alignWesternNameWithRecord(half("睡眠呼吸暂停低通气综合征"), { recordText: record }));
      assert.equal(changed.westernDiagnosis.primary.name, "白天嗜睡待查");
      assert.equal(calls, 1);
      globalThis.fetch = async () => { calls += 1; return completion({ verdict: "consistent", type: "", quote: "", reason: "", supportedName: "" }); };
      assert.equal(await westernCheck.alignWesternNameWithRecord(half("发作性睡病"), { recordText: record }), half("发作性睡病"));
      globalThis.fetch = async () => { throw new Error("upstream down"); };
      assert.equal(await westernCheck.alignWesternNameWithRecord(half("特发性嗜睡症"), { recordText: record }), half("特发性嗜睡症"), "模型不可用时不改");
      const before = calls;
      globalThis.fetch = async () => { calls += 1; return completion(verdict({})); };
      assert.equal(await westernCheck.alignWesternNameWithRecord(half("头痛待查"), { recordText: record }), half("头痛待查"), "已停在症状层面的名称不核对");
      process.env.CDSS_WESTERN_NAME_EVIDENCE_CHECK = "false";
      assert.equal(await westernCheck.alignWesternNameWithRecord(half("不宁腿综合征"), { recordText: record }), half("不宁腿综合征"));
      assert.equal(calls, before, "两种情况都不调用模型");
    } finally {
      delete process.env.CDSS_WESTERN_NAME_EVIDENCE_CHECK;
      delete process.env.CDSS_WEB_SEARCH;
      globalThis.fetch = savedFetch;
    }
  });
  // 10/17：情形 D「名称比病历能支撑的更具体」（owner：没有关键检查时写上一级病名）；红旗病例不用 D。
  const anemia = "主诉：乏力、头晕3月\n现病史：近3月乏力头晕，月经量较前增多。\n辅助检查：血常规 血红蛋白98g/L";
  const specific = (extra = {}) => JSON.stringify({ verdict: "inconsistent", type: "D", quote: "血常规 血红蛋白98g/L", reason: "仅血红蛋白降低，未查铁代谢", supportedName: "贫血", ...extra });
  check("3.5 情形 D：采信后改成上一级病名；原病名留在鉴别里写「尚未取得确诊所需的检查或病程依据」，不把引文写成反对依据", () => {
    const correction = westernCheck.parseWesternNameCorrection(specific(), anemia, "缺铁性贫血");
    assert.deepEqual(correction, { supportedName: "贫血", quote: "血常规 血红蛋白98g/L", reason: "仅血红蛋白降低，未查铁代谢", type: "D" });
    const western = { westernDiagnosis: { primary: { name: "缺铁性贫血" }, differentials: [], candidates: [{ name: "缺铁性贫血", likelihood: "中", keyEvidence: ["血红蛋白98g/L"], againstEvidence: [] }] } };
    const out = JSON.parse(westernCheck.applyWesternNameCorrection(JSON.stringify(western), correction));
    assert.equal(out.westernDiagnosis.primary.name, "贫血");
    assert.deepEqual(out.westernDiagnosis.candidates[1], { name: "缺铁性贫血", likelihood: "中", keyEvidence: [], againstEvidence: [] });
    assert.equal(out.westernDiagnosis.differentials[0].name, "缺铁性贫血");
    assert.equal(out.westernDiagnosis.differentials[0].reason, "尚未取得确诊所需的检查或病程依据");
    assert.equal(out.westernDiagnosis.differentials[0].nextCheck, "完善确诊所需检查");
  });
  await checkAsync("3.6 红旗病例：D 不采信（急危重病名不改成待查），A–C 照常；同一份病历的缓存结果在两种请求之间不串", async () => {
    const half = (name) => JSON.stringify({ westernDiagnosis: { primary: { name }, differentials: [], candidates: [{ name }] }, management: {} });
    try {
      globalThis.fetch = async () => completion(specific());
      assert.equal(JSON.parse(await westernCheck.alignWesternNameWithRecord(half("缺铁性贫血"), { recordText: anemia })).westernDiagnosis.primary.name, "贫血");
      assert.equal(await westernCheck.alignWesternNameWithRecord(half("缺铁性贫血"), { recordText: anemia, redFlag: true }), half("缺铁性贫血"), "红旗：D 不采信（同一请求内容命中缓存也一样）");
      globalThis.fetch = async () => completion(verdict({}));
      assert.equal(JSON.parse(await westernCheck.alignWesternNameWithRecord(half("睡眠呼吸暂停低通气综合征"), { recordText: record, redFlag: true })).westernDiagnosis.primary.name, "白天嗜睡待查", "红旗：B 照常");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
  }

// ───── 4 针刺方案 ─────
{
  process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = "acupuncture,moxibustion,cupping,guasha,auricular,tuina,diet_therapy,qigong_daoyin,mind_therapy";
  const treatments = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
  const textbookPlan = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
  const evidence = { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" };
  const signedPrior = ({ disease, syndrome, method, western = "症状性问题", patientFact, pathogenesis }) => ({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    contractSignatureVersion: "tcm-cdss-m03-signature-v5", contractSignature: `hmac-sha256:${"a".repeat(64)}`,
    overview: { tcmDiseaseName: disease, primarySyndrome: syndrome, secondarySyndromes: [], overallPathogenesis: pathogenesis, overallTherapy: method, evidence },
    westernDiagnosis: { primary: { name: western, status: "证据有限", confidence: "低", supportingFacts: [], evidence }, differentials: [] },
    pathogenesis: { summary: pathogenesis, locationDifferentiation: { items: [], evidence }, natureDifferentiation: { items: [], evidence }, chain: [{ nodeId: "P1", patientFact, syndromeEvidence: patientFact, pathogenesis, therapyDirection: method, evidence }], uncertainties: [] },
    therapy: { overallPrinciple: method, overallMethod: method, subTherapies: [{ therapy: method, targetPathogenesis: pathogenesis, priority: "主要", evidence }] },
    formula: null, nonPharma: null, lineageAdaptation: null,
  });
  const caseOf = (chief, present, age = 36, vitals = {}) => ({
    patient: { sex: "男", age }, chiefComplaint: chief, symptoms: { presentHistory: present }, vitals, conversation: [],
    safetyGate: { status: "ready", allowDosePrescription: true, redFlags: [], missingItems: [] },
  });
  const acupuncture = (prior, caseState) => treatments.compileTcmTreatmentRecommendations([{ projectCode: "acupuncture", targetRef: "P1" }], prior, caseState)
    .find((card) => card.projectCode === "acupuncture");
  const pointNames = (card) => (card?.suggestedSitesOrPoints || []).map((item) => String(item).replace(/（.*$/, ""));
  const dizzy = (syndrome, method, pathogenesis, western) => signedPrior({ disease: "眩晕", syndrome, method, pathogenesis, western, patientFact: "头晕反复发作，耳鸣，腰膝酸软" });
  const dizzyFacts = "头晕反复发作，耳鸣，腰膝酸软，健忘，舌淡，脉沉细";

  check("4.1 眩晕·肾精不足（虚证）：只用教材虚证那一套——治法、主穴、操作都不带实证的内容", () => {
    const card = acupuncture(dizzy("肾精不足证", "补肾填精", "肾精亏虚，髓海不足"), caseOf("头晕反复2年", dizzyFacts, 50));
    assert.ok(card, "应有针刺方案");
    assert.match(card.treatmentContent, /^治法：补益气血，益精填髓/);
    assert.doesNotMatch(`${card.treatmentContent}${card.techniqueBoundary}`, /实证|平肝潜阳|\|/);
    const names = pointNames(card);
    for (const point of ["肝俞", "肾俞", "足三里"]) assert.ok(names.includes(point), `虚证主穴 ${point}：${names.join("、")}`);
    for (const point of ["太冲", "内关", "丰隆"]) assert.ok(!names.includes(point), `实证主穴 ${point} 不应出现：${names.join("、")}`);
  });
  check("4.2 眩晕·肝阳上亢（实证）取实证那一套；虚实夹杂的证名不取舍（对照）", () => {
    const excess = acupuncture(dizzy("肝阳上亢证", "平肝潜阳", "肝阳上亢，上扰清窍"), caseOf("头晕头胀1周", "头晕头胀，面红目赤，急躁易怒，口苦", 50));
    assert.match(excess.treatmentContent, /^治法：平肝潜阳，和胃化痰/);
    assert.ok(pointNames(excess).includes("太冲") && !pointNames(excess).includes("肾俞"), pointNames(excess).join("、"));
    const mixed = acupuncture(dizzy("气虚血瘀证", "益气活血", "气虚血瘀，清窍失养"), caseOf("头晕反复2年", dizzyFacts, 50));
    assert.match(mixed.treatmentContent, /实证：[\s\S]*虚证：/, "判不出虚实时沿用教材两套并列的写法");
  });
  check("4.3 老年人针刺：操作栏先写针刺量宜小；高血压专篇的长留针疗程不套到血压正常的老人身上", () => {
    const prior = dizzy("肾精不足证", "补肾填精", "肾精亏虚，髓海不足");
    const elderly = acupuncture(prior, caseOf("头晕反复2年", dizzyFacts, 74, { BP: "120/80" }));
    assert.ok(elderly.techniqueBoundary.startsWith(treatments.ELDERLY_ACUPUNCTURE_NOTE), elderly.techniqueBoundary);
    assert.doesNotMatch(elderly.scheduleSuggestion, /高血压|1小时/, elderly.scheduleSuggestion);
    const adult = acupuncture(prior, caseOf("头晕反复2年", dizzyFacts, 50, { BP: "120/80" }));
    assert.ok(!adult.techniqueBoundary.includes("老年人针刺量宜小"), "65 岁以下不加（对照）");
    assert.doesNotMatch(adult.scheduleSuggestion, /高血压/, "没有高血压的眩晕不引用高血压专篇的疗程");
    const hypertensive = acupuncture(dizzy("肝阳上亢证", "平肝潜阳", "肝阳上亢", "原发性高血压"), caseOf("头晕头胀1周", "头晕头胀，面红目赤，血压升高", 50, { BP: "168/100" }));
    assert.match(hypertensive.scheduleSuggestion, /高血压病/, "确有高血压的病例照常引用（对照）");
  });
  const itch = (syndrome, method, pathogenesis) => signedPrior({ disease: "风瘙痒", syndrome, method, pathogenesis, western: "皮肤瘙痒症", patientFact: "全身皮肤瘙痒，夜间为甚" });
  check("4.4 刺络拔罐：老年人、虚证、皮肤有抓痕血痂时不列；壮年实证且皮肤完好时照教材（对照）", () => {
    const frail = acupuncture(itch("血虚肝旺证", "养血平肝，祛风止痒", "血虚风燥，肌肤失养"), caseOf("全身皮肤瘙痒2年", "全身皮肤干燥瘙痒，夜间为甚，抓痕、血痂明显", 85));
    assert.ok(frail, "应有针刺方案");
    assert.doesNotMatch(frail.techniqueBoundary, /刺络|拔罐|放血/, frail.techniqueBoundary);
    assert.doesNotMatch(frail.treatmentContent, /疏风清热/, "没有按本例证型配穴时，不写按病的治法");
    assert.match(frail.treatmentContent, /^按病取基本穴/);
    const sturdy = acupuncture(itch("风热血热证", "疏风清热，凉血止痒", "风热郁于肌肤"), caseOf("全身皮肤瘙痒1周", "全身皮肤瘙痒，遇热加重，皮肤潮红，无破损", 30));
    assert.match(sturdy.techniqueBoundary, /刺络拔罐/, sturdy.techniqueBoundary);
    for (const [label, state, prior] of [
      ["只因年龄", caseOf("全身皮肤瘙痒1周", "全身皮肤瘙痒，遇热加重，皮肤潮红", 70), itch("风热血热证", "疏风清热，凉血止痒", "风热郁于肌肤")],
      ["只因虚证", caseOf("全身皮肤瘙痒2年", "全身皮肤干燥瘙痒，夜间为甚", 40), itch("血虚风燥证", "养血润燥，祛风止痒", "血虚风燥")],
      ["只因皮肤破损", caseOf("全身皮肤瘙痒1周", "全身皮肤瘙痒，遇热加重，抓痕明显，部分糜烂渗液", 30), itch("风热血热证", "疏风清热，凉血止痒", "风热郁于肌肤")],
    ]) {
      assert.doesNotMatch(acupuncture(prior, state).techniqueBoundary, /刺络|放血/, label);
    }
  });
  check("4.4b 皮肤针重叩出血也是出血类操作：糜烂渗出的湿疮不列（10/17 留出集）；皮肤完好的壮年实证照教材（对照）", () => {
    const eczema = (syndrome, method, pathogenesis) => signedPrior({ disease: "湿疮", syndrome, method, pathogenesis, western: "湿疹", patientFact: "四肢皮疹瘙痒" });
    const weeping = acupuncture(eczema("湿热浸淫证", "清热利湿止痒", "湿热浸淫肌肤"), caseOf("四肢皮疹瘙痒2周", "四肢红斑丘疹，瘙痒剧烈，抓后糜烂、有少量渗出", 35));
    assert.ok(weeping, "应有针刺方案");
    assert.doesNotMatch(JSON.stringify(weeping), /重叩出血|叩刺出血|刺络|放血/, JSON.stringify(weeping).slice(0, 400));
  });
  const cough = (syndrome, method, pathogenesis, patientFact) => signedPrior({ disease: "咳嗽", syndrome, method, pathogenesis, western: "慢性咳嗽", patientFact });
  const cards = (prior, state, codes) => treatments.compileTcmTreatmentRecommendations(codes.map((projectCode) => ({ projectCode, targetRef: "P1" })), prior, state);
  check("4.5 内伤咳嗽：教材「外感…；内伤…」一句里只留内伤那半句；耳穴、拔罐卡不借针刺的操作句当疗程", () => {
    const prior = cough("痰湿蕴肺证", "燥湿化痰，理气止咳", "脾湿生痰，上渍于肺", "咳嗽反复3月，痰多色白黏腻，晨起为甚");
    const state = caseOf("咳嗽反复3月", "咳嗽反复3月，痰多色白黏腻，晨起咳甚，胸闷脘痞，纳差，舌苔白腻，脉濡滑", 45);
    const out = cards(prior, state, ["acupuncture", "auricular", "cupping"]);
    const needle = out.find((card) => card.projectCode === "acupuncture");
    assert.ok(needle && /咳嗽」节/.test(needle.protocolSource), "夹具前提：走教材咳嗽节");
    assert.match(needle.techniqueBoundary, /内伤咳嗽针用平补平泻或补法/);
    for (const card of out) {
      assert.doesNotMatch(`${card.techniqueBoundary}${card.scheduleSuggestion}`, /外感咳嗽|闪罐/, `${card.projectCode}：${card.scheduleSuggestion}`);
    }
    for (const card of out.filter((item) => item.projectCode !== "acupuncture")) {
      assert.doesNotMatch(card.scheduleSuggestion, /针用|针刺/, `${card.projectCode} 的疗程不得是针刺的操作句：${card.scheduleSuggestion}`);
    }
    // 对照：外感（风热犯肺，院内咳嗽共识模板不收风热）留外感那半句、不留内伤那半句。
    const exterior = acupuncture(cough("风热犯肺证", "疏风清热，宣肺止咳", "风热犯肺，肺失清肃", "咳嗽3天，痰黄黏稠，咽痛，发热恶风"),
      caseOf("咳嗽3天", "咳嗽3天，痰黄黏稠，咽喉肿痛，发热恶风，口干，苔薄黄，脉浮数", 30));
    assert.match(`${exterior.techniqueBoundary}${exterior.scheduleSuggestion}`, /外感咳嗽针用泻法/, exterior.techniqueBoundary);
    assert.doesNotMatch(exterior.techniqueBoundary, /内伤咳嗽/, exterior.techniqueBoundary);
  });
  const insomnia = (syndrome, method, pathogenesis) => signedPrior({ disease: "不寐", syndrome, method, pathogenesis, western: "失眠障碍", patientFact: "入睡困难，多梦易醒" });
  check("4.6 补泻手法与证候相符：实热证不写「留针用补法」（院内失眠模板），虚证照旧写补法（对照）", () => {
    const excess = acupuncture(insomnia("痰热扰心证", "清化痰热，和中安神", "痰热内扰，心神不安"),
      caseOf("失眠2月", "入睡困难，多梦易醒，心烦，口苦，痰多，舌红苔黄腻，脉滑数", 40));
    assert.ok(/SRC-BEIJING-TCM-DOUBLE-HEART/.test(excess.protocolSource), `夹具前提：走院内失眠模板（${excess.protocolSource}）`);
    assert.doesNotMatch(excess.techniqueBoundary.replace(/平补平泻/g, ""), /补法/, excess.techniqueBoundary);
    assert.match(excess.techniqueBoundary, /针用泻法/);
    const deficiency = acupuncture(insomnia("心脾两虚证", "补益心脾，养血安神", "心脾两虚，心神失养"),
      caseOf("失眠半年", "入睡困难，多梦易醒，心悸健忘，神疲食少，面色少华，舌淡，脉细弱", 40));
    assert.match(deficiency.techniqueBoundary, /留针用补法/);
  });
  check("4.7 补泻改写的边界：点名到穴位的定法、平补平泻、「按虚补实泻」、虚实判不出时都不动", () => {
    const { manipulationMatchedToSyndrome: matched } = textbookPlan;
    assert.equal(matched("中经络：水沟用雀啄法；三阴交用提插补法。", "风痰阻络证"), "中经络：水沟用雀啄法；三阴交用提插补法。");
    assert.equal(matched("配穴按虚补实泻法操作。", "肾精不足证"), "配穴按虚补实泻法操作。");
    assert.equal(matched("毫针泻法或平补平泻法。", "肝肾阴虚证"), "毫针泻法或平补平泻法。");
    assert.equal(matched("毫针补法，可灸。", "气虚血瘀证"), "毫针补法，可灸。", "虚实夹杂不改");
    assert.equal(matched("毫针常规刺，泻法。", "肾精不足证"), "针用补法。");
    assert.equal(matched("留针用补法；毫针补法。", "肝火扰心证"), "针用泻法；", "同一段里只写一次");
  });
  check("4.9 出卡处的疗程栏、操作栏不写「复评」「课程索引」：胃脘痛针刺卡、食疗卡、失眠意疗卡（JSON、正文、页面同一份）", () => {
    const stomach = signedPrior({ disease: "胃痛", syndrome: "饮食伤胃证", method: "消食导滞，和胃止痛", pathogenesis: "饮食停滞，胃气失和", western: "功能性消化不良", patientFact: "胃脘胀痛，嗳腐吞酸" });
    const out = cards(stomach, caseOf("胃脘胀痛3天", "暴饮暴食后胃脘胀痛3天，嗳腐吞酸，大便不爽，舌苔厚腻，脉滑", 40), ["acupuncture", "diet_therapy", "auricular"]);
    assert.ok(out.length >= 2, `夹具前提：出卡（${out.map((card) => card.projectCode).join("、")}）`);
    for (const card of out) {
      assert.doesNotMatch(`${card.scheduleSuggestion}${card.techniqueBoundary}`, /复评|课程索引/, `${card.projectCode}：${card.scheduleSuggestion}｜${card.techniqueBoundary}`);
    }
    const mind = cards(insomnia("心脾两虚证", "补益心脾，养血安神", "心脾两虚，心神失养"),
      caseOf("失眠半年", "入睡困难，多梦易醒，心悸健忘，神疲食少，舌淡，脉细弱", 40), ["mind_therapy"])[0];
    assert.ok(mind, "夹具前提：有意疗卡");
    assert.doesNotMatch(mind.scheduleSuggestion, /复评/, mind.scheduleSuggestion);
    assert.match(mind.scheduleSuggestion, /复诊时按情绪与睡眠变化调整/, "只改措辞，复诊时按什么调整照写");
  });
  check("4.10 证型配穴：肾阴亏虚证不配「阴阳两虚」（关元、命门）；教材证型名不带病性时按辨证要点末尾的「为X」比对（消渴·下消）", () => {
    const xiaoke = (syndrome, method, fact) => signedPrior({ disease: "消渴", syndrome, method, pathogenesis: "肾虚固摄无权", western: "2型糖尿病", patientFact: fact });
    const yinxu = acupuncture(xiaoke("肾阴亏虚证", "滋阴固肾", "尿频量多，腰膝酸软，口干"),
      caseOf("口干多尿10年", "口干多饮，尿频量多，混浊如脂膏，腰膝酸软，乏力，头晕耳鸣，皮肤干燥，舌红少苔，脉细数", 63));
    assert.match(yinxu.treatmentContent, /本例属下消，在主穴基础上加复溜、太冲/, yinxu.treatmentContent);
    assert.doesNotMatch(yinxu.treatmentContent, /阴阳两虚/);
    const yinyang = acupuncture(xiaoke("阴阳两虚证", "滋阴温阳，补肾固涩", "小便频数，混浊如膏，畏寒肢冷"),
      caseOf("多尿10年", "小便频数，混浊如膏，面容憔悴，腰膝酸软，四肢欠温，畏寒怕冷，舌淡苔白而干，脉沉细无力", 60));
    assert.match(yinyang.treatmentContent, /本例属阴阳两虚，在主穴基础上加关元、命门/, "阴阳两虚证照配（对照）");
    // 「阴阳两虚」此前只拆出泛概念「虚」，任何虚证都能配上它：高血压病一节里「肝肾不足证」被配成阴阳两虚、加关元。
    const hypertension = acupuncture(signedPrior({ disease: "高血压病", syndrome: "肝肾不足证", method: "补益肝肾", pathogenesis: "肝肾不足，髓海失养", western: "原发性高血压", patientFact: "头晕耳鸣，腰膝酸软" }),
      caseOf("头晕耳鸣2年", "头晕耳鸣，腰膝酸软，畏寒怕冷，夜尿频多，舌淡，脉沉细", 60, { BP: "156/96" }));
    assert.ok(hypertension, "夹具前提：有针刺方案");
    assert.doesNotMatch(hypertension.treatmentContent, /阴阳两虚/, hypertension.treatmentContent);
  });
  check("4.11 目录模板对的是别的病（遗尿患儿因证名「肺脾气虚」命中感染后呼吸康复模板）：按证型加减过也让位给本病的教材方案", () => {
    const card = acupuncture(signedPrior({ disease: "遗尿", syndrome: "肺脾气虚证", method: "补肺益脾，固涩膀胱", pathogenesis: "肺脾气虚，膀胱失约", western: "遗尿症", patientFact: "夜间尿床，易感冒，神疲乏力" }),
      caseOf("夜间尿床2年", "患儿夜间尿床，每周3～4次，平素容易感冒，神疲乏力，食欲不振，大便溏薄，自汗，舌淡苔薄白，脉细弱", 7));
    assert.match(card.protocolSource, /「遗尿」节/, card.protocolSource);
    assert.doesNotMatch(`${card.treatmentContent}${card.suggestedSitesOrPoints.join("、")}`, /感冒|证型配穴由医师复核|二选一/, card.treatmentContent);
    for (const point of ["关元", "中极", "膀胱俞"]) assert.ok(pointNames(card).includes(point), pointNames(card).join("、"));
  });
  check("4.8 「补泻手法、进针深度」只写在用针的项目上，拔罐卡不写", () => {
    const prior = cough("痰湿蕴肺证", "燥湿化痰，理气止咳", "脾湿生痰，上渍于肺", "咳嗽反复3月，痰多色白黏腻，晨起为甚");
    const state = caseOf("咳嗽反复3月", "咳嗽反复3月，痰多色白黏腻，晨起咳甚，胸闷脘痞，纳差，舌苔白腻，脉濡滑", 45);
    const out = cards(prior, state, ["acupuncture", "cupping"]);
    assert.doesNotMatch(out.find((card) => card.projectCode === "cupping").techniqueBoundary, /进针/);
    assert.match(out.find((card) => card.projectCode === "acupuncture").techniqueBoundary, /进针深度/, "针刺卡照写（对照）");
  });
}

// ───── 5 煎服用法 ─────
{
  const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  const herbDecoction = await jiti.import("../src/lib/herb-decoction-rules.ts");
  const compilerSource = (await import("node:fs")).readFileSync(new URL("../src/lib/m04-proposal-compiler.ts", import.meta.url), "utf8");
  const START = "<!-- DIAGNOSIS_JSON_START -->";
  const END = "<!-- DIAGNOSIS_JSON_END -->";
  const methodOf = (herbNames) => {
    const content = `${START}\n${JSON.stringify({
      schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
      therapy: { overallMethod: "温补肾阳，固涩止遗", overallPrinciple: "", subTherapies: [{ therapy: "温补肾阳", priority: "主要" }] },
      formula: { candidates: [{ name: "自拟方", therapyMatch: "温补肾阳", constructionType: "self_devised", formulaNames: [],
        herbs: herbNames.map((name) => ({ name, dose: "6g" })), decoction: { doseCount: "7剂", dosesPerDay: 1, administrationTimesPerDay: 2 } }] },
    })}\n${END}`;
    const out = summary.applyDeterministicDecoctionMethod(content, "患者，男，30岁", 30);
    return JSON.parse(out.slice(out.indexOf(START) + START.length, out.indexOf(END))).formula.candidates[0].decoction.method;
  };
  check("5.1 附子与龙骨、牡蛎同方：附子单列「先煎45–60分钟（至口尝无麻辣感）」，龙骨牡蛎仍是先煎20–30分钟", () => {
    const method = methodOf(["附子", "龙骨", "牡蛎", "桑螵蛸", "甘草"]);
    assert.match(method, /附子先煎45–60分钟（至口尝无麻辣感）/, method);
    assert.match(method, /龙骨、牡蛎先煎20–30分钟/, method);
    assert.doesNotMatch(method, /附子[^，]*先煎20–30分钟|龙骨[^，]*45–60/, method);
    assert.ok(method.indexOf("附子先煎") < method.indexOf("龙骨、牡蛎先煎"), "久煎的毒性药排在最前");
  });
  check("5.3 大黄（药典几选一：后下 / 先煎 / 冲服）：按这味药实际标注的写，没有标注取后下；不得写成先煎", () => {
    const withDeclared = (name, decoctionRequirement) => {
      const content = `${START}\n${JSON.stringify({
        schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
        therapy: { overallMethod: "清热泻火，通腑", overallPrinciple: "", subTherapies: [{ therapy: "清热泻火", priority: "主要" }] },
        formula: { candidates: [{ name: "自拟方", therapyMatch: "清热泻火", constructionType: "self_devised", formulaNames: [],
          herbs: [{ name: "石膏", dose: "30g" }, { name, dose: "6g", ...(decoctionRequirement ? { decoctionRequirement } : {}) }, { name: "甘草", dose: "6g" }],
          decoction: { doseCount: "3剂", dosesPerDay: 1, administrationTimesPerDay: 2 } }] },
      })}\n${END}`;
      const out = summary.applyDeterministicDecoctionMethod(content, "患者，男，30岁", 30);
      return JSON.parse(out.slice(out.indexOf(START) + START.length, out.indexOf(END))).formula.candidates[0].decoction.method;
    };
    for (const declared of ["后下", "后下，禁止久煎", "后下或先煎或冲服、禁止久煎", undefined]) {
      const method = withDeclared("大黄", declared);
      assert.match(method, /大黄后下/, `${declared}: ${method}`);
      assert.doesNotMatch(method, /大黄[^，]*先煎|石膏、大黄先煎/, method);
      assert.match(method, /石膏先煎20–30分钟/, "石膏照旧先煎（对照）");
    }
    assert.match(withDeclared("大黄", "冲服"), /大黄冲服/, "标了冲服就写冲服");
    assert.match(withDeclared("大黄", "先煎"), /大黄先煎/, "只标了先煎就写先煎（对照：确有选择时照选择）");
  });
  check("5.4 加减加入有特殊煎法的药：煎法写在这一条的说明里（附子先煎45–60分钟），普通药不写（对照）", () => {
    const { specialDecoctionPhrase } = herbDecoction;
    assert.equal(specialDecoctionPhrase("附子"), "附子先煎45–60分钟（至口尝无麻辣感）");
    assert.equal(specialDecoctionPhrase("大黄"), "大黄后下", "几选一没有标注时取所列的第一种");
    assert.equal(specialDecoctionPhrase("砂仁"), "砂仁后下");
    assert.equal(specialDecoctionPhrase("姜半夏"), "", "普通药不写");
    assert.match(compilerSource, /riskNote: item\.actionType === "add"\s*\?\s*\[specialDecoctionPhrase\(item\.herbName\.trim\(\)\)/,
      "加减条目编译时按同一张表写煎法");
  });
  check("5.2 制川乌同样单列；没有这类药的处方写法不变（对照）", () => {
    assert.match(methodOf(["制川乌", "桂枝", "甘草"]), /制川乌先煎45–60分钟（至口尝无麻辣感）/);
    const plain = methodOf(["龙骨", "牡蛎", "甘草"]);
    assert.match(plain, /龙骨、牡蛎先煎20–30分钟/);
    assert.doesNotMatch(plain, /45–60/);
  });
}

// ───── 6 药味功效 ─────
{
  const kb = await jiti.import("../src/lib/tcm-knowledge.ts");
  check("6.1 蜂蜜在润肠通便方里的功效不得是「外用生肌敛疮」；白矾内服取「祛除风痰」而不是外用功效", () => {
    for (const role of ["君", "臣", "佐", "使"]) {
      assert.doesNotMatch(kb.getTcmHerbFunctionDisplayText("蜂蜜", role, "肠燥津亏，大便干结", "润肠通便"), /外用|生肌敛疮/, role);
    }
    const alum = kb.getTcmHerbFunctionDisplayText("白矾", "佐", "风痰", "祛风痰");
    assert.match(alum, /祛除风痰/);
    assert.doesNotMatch(alum, /外用/);
  });
  check("6.2 只说给药途径的条目照旧保留（对照）：朱砂的功效文本仍带不入煎的途径信息", () => {
    assert.match(kb.getTcmHerbFunctionText("蜂蜜"), /外用生肌敛疮/, "知识库原文不动，只是不拿它当内服功效");
    assert.match(kb.getTcmHerbFunctionDisplayText("朱砂", "佐", "心神不安", "镇心安神"), /安神/);
  });
}

// ───── 7 中医鉴别 ─────
{
  const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
  const authoring = await jiti.import("../src/lib/tcm-disease-differential-authoring.server.ts");
  check("7.1 闭集选择点了名：候选只给点到的病，不再跟着按字面重合取来的皮肤病", () => {
    const input = {
      chiefComplaint: "右膝、右踝关节红肿热痛3天", sex: "男", ageYears: 48,
      presentHistory: "患者3天前淋雨后出现右膝、右踝关节疼痛，局部红肿、摸着发烫，活动受限，用冷毛巾敷后觉得舒服，同时发热，体温37.9℃，怕风，出汗，口渴，心里烦闷，小便黄，大便干。夜间关节灼痛，难以入睡。无皮疹，无胸闷心慌，既往无类似发作。",
    };
    const lexical = textbook.textbookCandidatesForCase(input).map((item) => item.disease);
    assert.ok(lexical.some((name) => name !== "痹证"), `对照：不点名时字面候选里有别的病（${lexical.join("、")}）`);
    const picked = textbook.textbookCandidatesForCase({ ...input, preferredDiseases: ["痹证"] }).map((item) => item.disease);
    assert.deepEqual(picked, ["痹证"]);
    // 点到的病不在教材里（选择落空）时仍用字面候选。
    assert.deepEqual(textbook.textbookCandidatesForCase({ ...input, preferredDiseases: ["不存在的病名"] }).map((item) => item.disease), lexical);
  });
  check("7.2 教材【鉴别诊断】覆盖：痹证、黄疸、痢疾、郁证等内科常见病都有鉴别病证", () => {
    for (const [disease, expected] of [["痹证", "痿证"], ["黄疸", "萎黄"], ["痢疾", "泄泻"]]) {
      const names = textbook.textbookDifferentialsForDisease(disease).map((item) => item.name);
      assert.ok(names.includes(expected), `${disease} 应与 ${expected} 鉴别：${names.join("、") || "（空）"}`);
    }
  });
  const allowed = ["白浊", "白淫"];
  const good = { diseaseName: "白浊", reason: "同见下窍流出白色分泌物", typicalManifestation: "尿窍流出混浊如脓之物，小便淋沥涩痛", distinguishingPoints: "本例带下色白质稀，出自阴道，未诉尿痛", nextCheck: "尿常规" };
  const parse = (items) => authoring.parseAuthoredTcmDiseaseDifferentials(JSON.stringify({ differentials: items }), allowed);
  check("7.3 补写结果的采信：病名在闭集里、区分要点以「本例」起头且不贴教材定义", () => {
    assert.deepEqual(parse([good]), [good]);
    assert.deepEqual(parse([{ ...good, nextCheck: "" }])[0].nextCheck, null);
    assert.deepEqual(parse([{ ...good, diseaseName: "淋证" }]), [], "闭集外的病名不收");
    assert.deepEqual(parse([{ ...good, distinguishingPoints: "白浊是泌尿生殖系统的化脓性感染，临床特征为尿窍流出混浊如脓之物" }]), [], "照搬教材定义的不收");
    assert.deepEqual(parse([{ ...good, distinguishingPoints: "本例据教材定义可区分" }]), [], "提到教材的不收");
    assert.deepEqual(parse([{ ...good, typicalManifestation: "" }]), [], "典型表现不得为空");
    assert.equal(parse([good, { ...good }, { ...good, diseaseName: "白淫" }]).length, 2, "同名去重，最多两条");
    assert.deepEqual(authoring.parseAuthoredTcmDiseaseDifferentials("不是 JSON", allowed), []);
  });
  const savedFetch = globalThis.fetch;
  const completion = (payload) => new Response(JSON.stringify({
    id: "t", object: "chat.completion", model: "deepseek-flash",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { headers: { "content-type": "application/json" } });
  await checkAsync("7.4 收口：没有可保留的病名级鉴别才补写；已有的不动、不发请求；模型不可用原样返回", async () => {
    const half = (differentials) => JSON.stringify({ overview: { tcmDiseaseName: "带下过多", primarySyndrome: "脾虚证", tcmDiseaseDifferentials: differentials }, pathogenesis: { chain: [] } });
    const recordText = "白带量多半年，色白质稀如涕，无臭，无阴痒，神疲乏力，纳少便溏。";
    const textbookNames = textbook.textbookDifferentialsForDisease("带下过多").map((item) => item.name);
    assert.ok(textbookNames.length > 0, "夹具前提：教材对带下过多列有鉴别病证");
    let calls = 0;
    try {
      globalThis.fetch = async () => { calls += 1; return completion({ differentials: [{ ...good, diseaseName: textbookNames[0] }] }); };
      const filled = JSON.parse(await authoring.completeTcmDiseaseDifferentials(half([]), { recordText }));
      assert.equal(calls, 1);
      assert.equal(filled.overview.tcmDiseaseDifferentials[0].diseaseName, textbookNames[0]);
      assert.match(filled.overview.tcmDiseaseDifferentials[0].distinguishingPoints, /^本例/);
      assert.equal(filled.overview.primarySyndrome, "脾虚证", "其余字段不动");
      const existing = half([{ diseaseName: textbookNames[0], reason: "同见白色分泌物", distinguishingPoints: "本例出自阴道，未诉尿痛", typicalManifestation: "尿窍流浊", nextCheck: null }]);
      assert.equal(await authoring.completeTcmDiseaseDifferentials(existing, { recordText }), existing, "模型已经写了可保留的鉴别时原样返回");
      assert.equal(calls, 1, "不发请求");
      globalThis.fetch = async () => { throw new Error("upstream down"); };
      const other = half([{ diseaseName: "阴道炎", reason: "x", distinguishingPoints: "y" }]);
      assert.equal(await authoring.completeTcmDiseaseDifferentials(other, { recordText: `${recordText}（第二例）` }), other, "模型不可用时原样返回");
      assert.equal(await authoring.completeTcmDiseaseDifferentials("不是 JSON", { recordText }), "不是 JSON");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
}

// ───── 7c 鉴别病名一个判据（10/17）：教材所列的中医病证名照收，补写与交付面兜底都只认它 ─────
{
  const names = await jiti.import("../src/lib/tcm-disease-differential-normalization.ts");
  const authoring = await jiti.import("../src/lib/tcm-disease-differential-authoring.server.ts");
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  check("7.6 教材所列的中医病证名原样保留（背痛、尻痛、真头痛不再丢掉或改名成厥头痛）；西医病名照旧归一或丢弃（对照）", () => {
    assert.deepEqual(names.resolveTcmDiseaseDifferentialName("背痛", "腰痛"), { action: "keep", name: "背痛" });
    assert.deepEqual(names.resolveTcmDiseaseDifferentialName("尻痛", "腰痛"), { action: "keep", name: "尻痛" });
    assert.deepEqual(names.resolveTcmDiseaseDifferentialName("真头痛", "头痛"), { action: "keep", name: "真头痛" });
    assert.deepEqual(names.resolveTcmDiseaseDifferentialName("脱汗", "汗证"), { action: "keep", name: "脱汗" });
    assert.equal(names.resolveTcmDiseaseDifferentialName("丘疹性荨麻疹", "瘾疹").action, "drop", "教材瘾疹节列的西医病名");
    assert.equal(names.resolveTcmDiseaseDifferentialName("荨麻疹", "经行风疹块").name, "瘾疹", "西医别名仍归一成中医正名");
    assert.equal(names.resolveTcmDiseaseDifferentialName("肋间神经痛", "蛇串疮").action, "drop");
    assert.equal(names.resolveTcmDiseaseDifferentialName("背痛", "胃痛").action, "drop", "只对教材把它列在其下的那个病放宽");
    assert.equal(names.resolveTcmDiseaseDifferentialName("内科其他疾病虚证", "虚劳").action, "drop", "教材句子里的描述性短语不是病名");
  });
  const savedFetch = globalThis.fetch;
  const completion = (payload) => new Response(JSON.stringify({
    id: "t", object: "chat.completion", model: "deepseek-flash",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { headers: { "content-type": "application/json" } });
  const row = (diseaseName) => ({ diseaseName, reason: "同见皮肤瘙痒", typicalManifestation: "皮损多形，对称分布，有渗出倾向", distinguishingPoints: "本例风团骤起骤消，未诉渗出", nextCheck: "" });
  await checkAsync("7.7 教材所列一个都不是中医病名时（瘾疹）由模型提出中医病名补写；西医病名照样不收", async () => {
    const half = JSON.stringify({ overview: { tcmDiseaseName: "瘾疹", primarySyndrome: "风热犯表证", tcmDiseaseDifferentials: [] }, pathogenesis: { chain: [] } });
    let calls = 0;
    try {
      globalThis.fetch = async () => { calls += 1; return completion({ differentials: [row("丘疹性荨麻疹"), row("湿疮")] }); };
      const filled = JSON.parse(await authoring.completeTcmDiseaseDifferentials(half, { recordText: "大汗后吹空调出现全身红色风团2天，瘙痒，骤起骤消。" }));
      assert.equal(calls, 1);
      assert.deepEqual(filled.overview.tcmDiseaseDifferentials.map((item) => item.diseaseName), ["湿疮"]);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
  check("7.8 交付面兜底只贴判据收得下的病名：瘾疹不贴丘疹性荨麻疹的定义；腰痛照贴背痛、尻痛（补写失败时的兜底）", () => {
    const diagnose = (disease) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
      overview: { tcmDiseaseName: disease, primarySyndrome: "某证", tcmDiseaseDifferentials: [] },
      pathogenesis: { chain: [{ pathogenesis: "x" }] }, westernDiagnosis: { primary: { name: "x" }, differentials: [] } });
    const urticaria = projectDeliveredReasoning(diagnose("瘾疹")).overview.tcmDiseaseDifferentials;
    assert.ok(!urticaria.some((item) => /丘疹性荨麻疹/.test(item.diseaseName)), JSON.stringify(urticaria));
    const lumbago = projectDeliveredReasoning(diagnose("腰痛")).overview.tcmDiseaseDifferentials.map((item) => item.diseaseName);
    assert.deepEqual(lumbago, ["背痛", "尻痛"]);
  });
}

// ───── 7d 加减不得加方中已有的药（10/17：方中地黄，加减又「加生地黄」）─────
{
  const { modificationHerbIdentity } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
  check("7.9 生品与不带「生」字的同一味视为同一味；生姜、熟地黄、炙甘草仍各是一味（对照）", () => {
    for (const [left, right] of [["生地黄", "地黄"], ["生地", "地黄"], ["生石膏", "石膏"], ["生白芍", "白芍"], ["生甘草", "甘草"], ["生龙骨", "龙骨"]]) {
      assert.equal(modificationHerbIdentity(left), modificationHerbIdentity(right), `${left} = ${right}`);
    }
    for (const [left, right] of [["熟地黄", "地黄"], ["炙甘草", "甘草"], ["生姜", "干姜"]]) {
      assert.notEqual(modificationHerbIdentity(left), modificationHerbIdentity(right), `${left} ≠ ${right}`);
    }
    assert.equal(modificationHerbIdentity("生姜"), "生姜");
  });
}

// ───── 7e 治疗卡与居家穴位保健（10/17 甲方标准病历 5、6、9）─────
{
  const { cardSentencesMatchedToSyndrome } = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  const { compileHomeAcupointCare } = await jiti.import("../src/lib/home-acupoint-care.server.ts");
  const homeCareSource = JSON.parse(readFileSync(new URL("../src/data/tcm-home-acupoint-care.source.json", import.meta.url), "utf8"));
  check("7.10 卡片里写给别的证型的句子不留；阴虚、热证不留建议用灸的句子；相符的证型、非证型修饰、禁灸句照留（对照）", () => {
    assert.equal(cardSentencesMatchedToSyndrome("取肾俞、大肠俞、阿是穴。瘀血腰痛和寒湿腰痛可行刺络拔罐。", ["腰痛"], "肾阴虚证"), "取肾俞、大肠俞、阿是穴。");
    assert.equal(cardSentencesMatchedToSyndrome("毫针常规刺。寒湿腰痛、肾虚腰痛者，可加用灸法。", ["腰痛"], "肾阴虚证"), "毫针常规刺。", "肾虚相符，但阴虚不用灸");
    assert.equal(cardSentencesMatchedToSyndrome("寒湿腰痛、肾虚腰痛者，可加用灸法。", ["腰痛"], "肾阳虚证"), "寒湿腰痛、肾虚腰痛者，可加用灸法。");
    assert.equal(cardSentencesMatchedToSyndrome("急性腰痛可先冷敷。", ["腰痛"], "肾阴虚证"), "急性腰痛可先冷敷。");
    assert.equal(cardSentencesMatchedToSyndrome("风寒头痛加风门。风热头痛加大椎。", ["头痛"], "风热头痛证"), "风热头痛加大椎。");
    assert.equal(cardSentencesMatchedToSyndrome("阴虚火旺者禁灸。", ["不寐"], "阴虚火旺证"), "阴虚火旺者禁灸。");
    assert.equal(cardSentencesMatchedToSyndrome("瘀血腰痛可行刺络拔罐。", ["腰痛"], "肾阴虚证"), "瘀血腰痛可行刺络拔罐。", "整段都要删时原样返回");
  });
  check("7.11 交付面：只有一段治则的病种模板卡不下发；食疗卡是肥甘之品而饮食栏写清淡/避免滋腻时不下发；饮食栏不限时照发（对照）", () => {
    const card = (projectCode, treatmentContent, extra = {}) => ({ projectCode, protocolStatus: "governed_class_template_not_syndrome_tailored", tailoringStatus: "class_template_only", suggestedSitesOrPoints: ["足三里"], scheduleSuggestion: "", techniqueBoundary: "", treatmentContent, ...extra });
    const reasoning = (diet, treatments) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
      formula: { candidates: [{ name: "补肺汤", herbs: [], decoction: { method: "分2次饭后温服" } }] },
      nonPharma: { diet, precautions: [], acupointCare: null, tcmTreatments: treatments } });
    const tuina = card("tuina", "治则：虚劳以本虚为主，故治疗以虚则补之。手法：一指禅推法、揉法。");
    const pork = card("diet_therapy", "风热犯表：芋头炖猪排：芋头茎30g，猪排200g，煲熟调味。", { tailoringStatus: "syndrome_tailored", suggestedSitesOrPoints: [] });
    const ear = card("auricular", "取肺、脾、神门。压丸法。");
    const out = projectDeliveredReasoning(reasoning("饮食清淡易消化，忌辛辣油腻。", [tuina, pork, ear]));
    assert.deepEqual(out.nonPharma.tcmTreatments.map((item) => item.projectCode), ["auricular"]);
    const plain = projectDeliveredReasoning(reasoning("规律进食。", [pork]));
    assert.deepEqual(plain.nonPharma.tcmTreatments.map((item) => item.projectCode), ["diet_therapy"]);
    const herb = card("diet_therapy", "猪苓、茯苓煮水代茶。", { tailoringStatus: "syndrome_tailored", suggestedSitesOrPoints: [] });
    assert.equal(projectDeliveredReasoning(reasoning("饮食清淡。", [herb])).nonPharma.tcmTreatments.length, 1, "猪苓是药，不算肥甘");
  });
  check("7.12 居家穴位保健：按揉的穴位都已在医师治疗卡里时只写艾灸一段，不以「也可以」起头、不附按揉注意事项；有按揉时照旧（对照）", () => {
    const qi = homeCareSource.constitutions.qi_deficiency;
    const prior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { primarySyndrome: "肺气虚证" },
      pathogenesis: { natureDifferentiation: { items: ["气虚"] }, chain: [] } };
    const allPressed = qi.acupressure.points.map((point) => point.name).join("、");
    const safetyGate = { status: "ready", allowDosePrescription: true, candidateMode: "full_dose", redFlags: [], missingItems: [] };
    const onlyMoxa = compileHomeAcupointCare({ prior, safetyGate, ageYears: 60, clinicianPointText: allPressed });
    assert.ok(onlyMoxa && onlyMoxa.startsWith("艾灸"), onlyMoxa);
    assert.ok(!onlyMoxa.includes("按揉"), onlyMoxa);
    const both = compileHomeAcupointCare({ prior, safetyGate, ageYears: 60, clinicianPointText: "" });
    assert.ok(both && both.startsWith("按揉") && both.includes("也可以艾灸"), both);
  });
}

// ───── 7f 方义不说删了原方药味而其实没删（10/17 甲方标准病历 1、4、10）─────
{
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  const analysisFor = (name, names, formulaAnalysis) => projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
    formula: { candidates: [{ name, herbs: names.map((herb) => ({ name: herb, dose: "9g" })), formulaAnalysis }] }, nonPharma: null }).formula.candidates[0].formulaAnalysis;
  const chaihu = ["陈皮", "柴胡", "川芎", "香附", "枳壳", "白芍", "炙甘草"];
  const claim = "本方以柴胡疏肝散为基础加减，去原方中偏于走窜耗气之品，保留核心疏肝理气之组。柴胡为君。";
  check("7.13 原方药味一味不少时去掉「去原方中…之品」及紧跟的「保留…」；真删了一味时照留；目录查不到组成时不动（对照）", () => {
    assert.equal(analysisFor("柴胡疏肝散", chaihu, claim), "本方以柴胡疏肝散为基础加减。柴胡为君。");
    assert.equal(analysisFor("柴胡疏肝散", chaihu.filter((herb) => herb !== "川芎"), claim), claim);
    assert.equal(analysisFor("自拟方", ["陈皮"], "本方为自拟方，去其燥烈之品。"), "本方为自拟方，去其燥烈之品。");
  });
}

// ───── 7g 教材行不跨病找同名证（10/17 甲方标准病历 5：虚劳·肺脾两虚证找到了肺胀那一行）─────
{
  const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
  check("7.14 病名对上教材的节而该节没有这个证名时不找别的病；病名没对上任何一节时仍按证名找回那一行（对照）", () => {
    assert.equal(textbook.textbookRowForSyndrome("虚劳", "肺脾两虚证"), undefined);
    assert.equal(textbook.textbookRowForSyndrome("肺胀", "肺脾两虚证")?.disease, "肺胀");
    assert.equal(textbook.textbookRowForSyndrome("虚劳", "肺气虚证")?.disease, "虚劳");
    assert.equal(textbook.textbookRowForSyndrome("头风病", "血虚头痛证")?.disease, "头痛", "病名写法不同（头风病）时的反查不变");
  });
}

// ───── 7h 查体断言净化不把「有无…」的核实项当成断言（10/17 甲方标准病历 1 鼻渊核实项变成「未记录腹部查体结果」）─────
{
  const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
  const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
  const state = normalizeCaseStateInput({ patient: { sex: "女", age: 24 }, chiefComplaint: "恶寒发热、鼻塞流涕2天", conversation: [],
    symptoms: { "现病史": "2天前淋雨后恶寒发热，鼻塞、流清涕，稍有咳嗽，无汗。" } });
  check("7.15 核实项「查鼻窦区有无压痛」「是否压痛」原样保留；病历没写的查体断言「腹软，无压痛」照常改写（对照）", () => {
    const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseName: "感冒", tcmDiseaseDifferentials: [
      { diseaseName: "鼻渊", reason: "均以鼻塞流涕为主症", typicalManifestation: "流浊涕", distinguishingPoints: "本例流清涕", nextCheck: "查鼻窦区有无压痛" },
      { diseaseName: "腹痛", reason: "x", typicalManifestation: "y", distinguishingPoints: "腹软，无压痛", nextCheck: "是否压痛" },
    ] } };
    const out = safety.sanitizeUngroundedRedFlagNegations(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`, state);
    const rows = JSON.parse(out.slice(out.indexOf("-->") + 3, out.lastIndexOf("<!--"))).overview.tcmDiseaseDifferentials;
    assert.equal(rows[0].nextCheck, "查鼻窦区有无压痛");
    assert.equal(rows[1].nextCheck, "是否压痛");
    assert.match(rows[1].distinguishingPoints, /本次病历未记录腹部查体结果/);
  });
}

// ───── 7i 留出集的服务端缺陷（10/17）：手法、热证用灸、加减病机前缀、方义删药说法 ─────
{
  const plan = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
  const { modificationTargetPathogenesis } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  check("7.16 纯实热证（痰热郁肺、痰火扰心）里「平补平泻或补法」改为泻法；本虚标实（痰湿蕴肺）与单写平补平泻照留（对照）", () => {
    assert.equal(plan.manipulationMatchedToSyndrome("内伤咳嗽针用平补平泻或补法。", "痰热郁肺证"), "针用泻法。");
    assert.equal(plan.manipulationMatchedToSyndrome("内伤咳嗽针用平补平泻或补法。", "痰火扰心证"), "针用泻法。");
    assert.equal(plan.manipulationMatchedToSyndrome("内伤咳嗽针用平补平泻或补法。", "痰湿蕴肺证"), "内伤咳嗽针用平补平泻或补法。");
    assert.equal(plan.manipulationMatchedToSyndrome("针用平补平泻。", "痰热郁肺证"), "针用平补平泻。");
  });
  check("7.17 火字证名（痰火扰心）不列建议用灸的句子；命门火衰照列（对照）", () => {
    assert.equal(plan.cardSentencesMatchedToSyndrome("毫针常规刺。除阴虚火旺外，可加灸。", ["不寐"], "痰火扰心证"), "毫针常规刺。");
    assert.equal(plan.cardSentencesMatchedToSyndrome("毫针常规刺。可加灸。", ["阳痿"], "命门火衰证"), "毫针常规刺。可加灸。");
  });
  check("7.18 加减的对应病机不写成「兼见若兼见…」", () => {
    const out = modificationTargetPathogenesis({ trigger: "若兼见心悸怔忡，少寐健忘", targetRef: "P1", reason: "养心安神" }, { pathogenesis: "肝肾阴虚，虚火上扰" }, (value, fallback) => value || fallback);
    assert.equal(out, "兼见心悸怔忡，少寐健忘");
  });
  check("7.19 「去原方…之品后以附子、肉桂为君」：只去掉删药的说法，后半句留下", () => {
    const youGui = ["熟地黄", "附子", "肉桂", "山药", "山茱萸", "菟丝子", "鹿角胶", "枸杞子", "当归", "杜仲"];
    const out = projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
      formula: { candidates: [{ name: "右归丸", herbs: youGui.map((name) => ({ name, dose: "9g" })), formulaAnalysis: "本方以右归丸为基础加减，去原方温燥之品后以附子、肉桂为君，温补肾阳。" }] }, nonPharma: null }).formula.candidates[0].formulaAnalysis;
    assert.equal(out, "本方以右归丸为基础加减，以附子、肉桂为君，温补肾阳。");
    // 药味取自甲方标准病历 8 的实际处方（龙胆泻肝汤全方 + 牡丹皮）。
    const longdan = ["龙胆", "黄芩", "栀子", "泽泻", "川木通", "车前子", "地黄", "牡丹皮", "当归", "柴胡", "甘草"];
    const tail = projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
      formula: { candidates: [{ name: "龙胆泻肝汤加减", herbs: longdan.map((name) => ({ name, dose: "9g" })), formulaAnalysis: "本方以龙胆泻肝汤为基础加减，去原方苦寒之药以免过峻之弊，加牡丹皮以增凉血之力。龙胆为君。" }] }, nonPharma: null }).formula.candidates[0].formulaAnalysis;
    assert.equal(tail, "本方以龙胆泻肝汤为基础加减，加牡丹皮以增凉血之力。龙胆为君。", "说删药理由的残段不留");
  });
}

// ───── 7j 本地复测暴露的服务端缺陷（10/17 第二批）─────
{
  const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  const plan = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
  const treatments = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  check("7.20 「发无定处」「无故」不改成「未诉…」；病历没写的「无腹痛」照常改（对照）", () => {
    assert.equal(summary.unrecordedNegativesAsNotReported("风团发无定处，时起时消。", "皮肤瘙痒伴风团2天"), "风团发无定处，时起时消。");
    assert.equal(summary.unrecordedNegativesAsNotReported("情绪低落，无故哭泣。", "情绪低落3月"), "情绪低落，无故哭泣。");
    assert.equal(summary.unrecordedNegativesAsNotReported("无腹痛。", "皮肤瘙痒伴风团2天"), "未诉腹痛。");
  });
  check("7.21 卡片里写「风热证…刺络拔罐」的句子在风寒束表证里不留；风热证照留（对照）", () => {
    const text = "主穴列缺、合谷、风池。风热证大椎可行刺络拔罐。";
    assert.equal(plan.cardSentencesMatchedToSyndrome(text, ["感冒"], "风寒束表证"), "主穴列缺、合谷、风池。");
    assert.equal(plan.cardSentencesMatchedToSyndrome(text, ["感冒"], "风热犯表证"), text);
  });
  check("7.22 方义：不带「原方」的删药说法同样核对；模型自问自答（带问号的小句及其后的更正）不留", () => {
    const jing = ["荆芥", "防风", "羌活", "独活", "柴胡", "前胡", "川芎", "枳壳", "茯苓", "桔梗", "甘草", "生姜", "薄荷"];
    const analysisFor = (name, herbs, formulaAnalysis) => projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
      formula: { candidates: [{ name, herbs: herbs.map((herb) => ({ name: herb, dose: "9g" })), formulaAnalysis }] }, nonPharma: null }).formula.candidates[0].formulaAnalysis;
    assert.equal(analysisFor("荆防败毒散", jing, "本方以荆防败毒散为基础加减，去辛散走表之品，荆芥、防风为君。"), "本方以荆防败毒散为基础加减，荆芥、防风为君。");
    const chaihu = ["陈皮", "柴胡", "川芎", "香附", "枳壳", "白芍", "炙甘草"];
    assert.equal(analysisFor("柴胡疏肝散", chaihu, "本方以柴胡疏肝散为基础加减，去原方中与气滞胀痛无直接关联的川芎？不，川芎保留。柴胡、香附为君。"), "本方以柴胡疏肝散为基础加减。柴胡、香附为君。");
  });
  check("7.23 注意事项叫患者别再服的药正是推荐西成药时不留；别的药照留（对照）", () => {
    const out = projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
      formula: { candidates: [{ name: "安神定志丸加减", herbs: [], decoction: { method: "分2次饭后温服" } }], patentAndWestern: [{ name: "人参口服液" }] },
      nonPharma: { precautions: ["方中含人参，服本方期间不宜再服人参口服液等同类补气中成药。", "服本方期间不要再服黄连上清丸。", "注意休息，避免劳累。"], acupointCare: null, tcmTreatments: [] } });
    assert.deepEqual(out.nonPharma.precautions, ["服本方期间不要再服黄连上清丸。", "注意休息，避免劳累。"]);
  });
  check("7.24 居家按揉不算医师推拿：注意事项里的「推拿后…」在只有居家按揉时不留", () => {
    const delivered = treatments.deliveredTreatmentCodes([{ projectCode: "acupuncture" }], "按揉足三里，每次3分钟。");
    assert.equal(treatments.precautionMentionsUndeliveredTreatment("推拿、针刺后注意腰部保暖。", delivered), true);
    assert.equal(treatments.precautionMentionsUndeliveredTreatment("针刺后注意腰部保暖。", delivered), false);
    assert.ok(treatments.deliveredTreatmentCodes([], "也可以艾灸气海").has("moxibustion"));
  });
}

// ───── 7k 手工核对的功用剔除项（10/17：黑芝麻被标成「清热解毒」）─────
{
  const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");
  const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
  check("7.25 黑芝麻（炒黑芝麻）的功用文本不含清热解毒、补中益气；「清热解毒」的标注不再接地；补益肝肾照常（对照）", () => {
    for (const name of ["黑芝麻", "炒黑芝麻"]) {
      const text = knowledge.getTcmHerbFunctionText(name);
      assert.doesNotMatch(text, /清热解毒|补中益气/, text);
      assert.match(text, /补益肝肾/, text);
    }
    assert.equal(contract.herbFunctionMatchesKnowledge("黑芝麻", "清热解毒", "佐", "", true), false);
    assert.equal(contract.herbFunctionMatchesKnowledge("黑芝麻", "补益肝肾", "佐", "", false), true);
  });
}

// ───── 7l 几选一的煎法在药味表里只写一种（10/17 甲方标准病历 7：大黄「后下或先煎或冲服、禁止久煎」）─────
{
  const rules = await jiti.import("../src/lib/herb-decoction-rules.ts");
  check("7.26 药味表照抄的几选一整串换成所列第一种；只点了一种的照留（对照）", () => {
    assert.equal(rules.withOneOfDecoctionResolved("大黄", "后下或先煎或冲服、禁止久煎"), "后下、禁止久煎");
    assert.equal(rules.withOneOfDecoctionResolved("大黄", "冲服"), "冲服");
    assert.equal(rules.requiredDecoctionRequirement("大黄"), "后下、禁止久煎");
    assert.equal(rules.specialDecoctionPhrase("大黄", rules.withOneOfDecoctionResolved("大黄", "后下或先煎或冲服、禁止久煎")), "大黄后下");
  });
}

// ───── 7m 顺带的睡眠差不在主方里加安神药（10/17 甲方标准病历 3、10；甲方 10.12 测评 4.1）─────
{
  const { m04CompilerTestHooks } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
  const prior = (primarySyndrome, tcmDiseaseName) => ({ stage: "diagnose", overview: { primarySyndrome, tcmDiseaseName, secondarySyndromes: [] } });
  const herb = (name, role) => ({ name, role, dose: "10g" });
  const qingjing = { name: "清经散加减", herbs: [herb("牡丹皮", "君"), herb("地骨皮", "臣"), herb("白芍", "臣"), herb("熟地黄", "佐"), herb("青蒿", "佐"), herb("黄柏", "佐"), herb("茯苓", "使"), herb("酸枣仁", "佐")] };
  check("7.27 血热月经先期方里为顺带的寐差加的酸枣仁不留；心悸·心虚胆怯、不寐照留；原方自带的安神药照留；君臣药不动（对照）", () => {
    const names = (herbs) => herbs.map((item) => item.name);
    assert.deepEqual(names(m04CompilerTestHooks.withoutIncidentalSedatives(qingjing, prior("阳盛血热证", "月经先期"))), names(qingjing.herbs).filter((name) => name !== "酸枣仁"));
    assert.deepEqual(names(m04CompilerTestHooks.withoutIncidentalSedatives(qingjing, prior("心虚胆怯证", "心悸"))), names(qingjing.herbs));
    assert.deepEqual(names(m04CompilerTestHooks.withoutIncidentalSedatives(qingjing, prior("肝郁化火证", "不寐"))), names(qingjing.herbs));
    const guipi = { name: "归脾汤加减", herbs: ["白术", "茯神", "黄芪", "龙眼肉", "酸枣仁", "人参", "木香", "甘草", "当归", "远志"].map((name, index) => herb(name, index < 2 ? "君" : "佐")) };
    assert.equal(m04CompilerTestHooks.withoutIncidentalSedatives(guipi, prior("气血亏虚证", "眩晕")).length, guipi.herbs.length, "归脾汤原方的酸枣仁、远志照留");
    const chief = { name: "自拟方", herbs: [herb("酸枣仁", "君"), herb("当归", "臣"), herb("川芎", "佐"), herb("白芍", "佐")] };
    assert.equal(m04CompilerTestHooks.withoutIncidentalSedatives(chief, prior("血虚头痛证", "头痛")).length, 4, "君药不动");
  });
}

// ───── 7b 中医鉴别理由不写处置口吻 ─────
{
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  check("7.5 中医鉴别的理由去掉「以免漏诊」半句，其余不动；删完为空时保留原句", () => {
    const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: {
      tcmDiseaseName: "咳嗽", primarySyndrome: "风寒袭肺证",
      tcmDiseaseDifferentials: [
        { diseaseName: "肺痨", reason: "咳嗽需与肺痨鉴别，以免漏诊慢性传染性疾病", distinguishingPoints: "本例病程仅1周，未诉咯血", nextCheck: null },
        { diseaseName: "肺胀", reason: "同见咳嗽胸闷", distinguishingPoints: "本例无气促", nextCheck: null },
      ],
      tcmDifferentials: [{ syndrome: "风热犯肺证", reason: "避免误诊", distinguishingPoints: "本例痰白清稀" }],
    } };
    const out = projectDeliveredReasoning(structuredClone(reasoning));
    assert.equal(out.overview.tcmDiseaseDifferentials[0].reason, "咳嗽需与肺痨鉴别");
    assert.equal(out.overview.tcmDiseaseDifferentials[1].reason, "同见咳嗽胸闷", "没有这半句的不动");
    assert.equal(out.overview.tcmDifferentials[0].reason, "避免误诊", "删完为空时保留原句");
  });
}

// ───── 8 交付面 ─────
{
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  check("8.1 针刺卡里说流程的模板半句：「须根据症状变化复评」写成按症状变化调整，「课程索引」那句不列，其余不动", () => {
    const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", nonPharma: { tcmTreatments: [{
      projectCode: "acupuncture",
      scheduleSuggestion: "门诊项目频次参考为每日1次，每次选穴和疗程须根据症状变化复评。",
      techniqueBoundary: "毫针常规刺，中脘、足三里平补平泻；穴位仅为课程索引与门诊病种频次的组合参考。",
    }] } };
    const card = projectDeliveredReasoning(structuredClone(reasoning)).nonPharma.tcmTreatments[0];
    assert.equal(card.scheduleSuggestion, "门诊项目频次参考为每日1次，每次选穴和疗程须根据症状变化调整。");
    assert.equal(card.techniqueBoundary, "毫针常规刺，中脘、足三里平补平泻。");
    assert.doesNotMatch(`${card.scheduleSuggestion}${card.techniqueBoundary}`, /复评|课程索引/);
  });
  check("8.3 中医鉴别的教材兜底：理由不写「教材列为本病的鉴别病证」，要点去掉「本病与X相鉴别。」开场句，教材描述照列", () => {
    const out = projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
      overview: { tcmDiseaseName: "妊娠咳嗽", primarySyndrome: "阴虚肺燥证", tcmDiseaseDifferentials: [] }, westernDiagnosis: { primary: { name: "妊娠合并急性支气管炎" }, differentials: [] } });
    const rows = out.overview.tcmDiseaseDifferentials;
    assert.ok(rows.length > 0, "夹具前提：教材对妊娠咳嗽列有鉴别病");
    for (const row of rows) {
      assert.doesNotMatch(`${row.reason}${row.distinguishingPoints}`, /教材列为|^本病与/, JSON.stringify(row));
      assert.ok(row.distinguishingPoints.length > 10, "教材描述照列");
    }
  });
  check("8.2 西医鉴别：模型自己写明「不适用」的项不列（女性列前列腺增生、男性列异位妊娠），其余不动", () => {
    const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", westernDiagnosis: {
      primary: { name: "右输尿管下段结石", supportingFacts: [], limitations: [], suggestedChecks: [] },
      differentials: [
        { name: "急性阑尾炎", reason: "右下腹痛需鉴别", distinguishingPoints: "本例疼痛向会阴放射，彩超见结石", nextCheck: "血常规" },
        { name: "异位妊娠破裂", reason: "下腹痛需鉴别（本例为男性患者，不适用）", distinguishingPoints: "不适用", nextCheck: null },
      ],
    } };
    const out = projectDeliveredReasoning(structuredClone(reasoning)).westernDiagnosis.differentials.map((item) => item.name);
    assert.deepEqual(out, ["急性阑尾炎"]);
  });
}

// ───── 9 不给剂量页的调护 ─────
{
  const { renderM04DeliveryCheckpoint, retainM04DeliveryCheckpoint } = await jiti.import("../src/lib/m04-delivery-checkpoint.ts");
  const { compileM04Proposal } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
  const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");
  const prior = ReasoningV2Schema.parse({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "肝阳上亢证", overallPathogenesis: "肝阳上亢，上扰清窍", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "头晕头胀", syndromeEvidence: "头晕头胀", pathogenesis: "肝阳上亢，上扰清窍", therapyDirection: "平肝潜阳" }] },
    therapy: { overallPrinciple: "实则泻之", overallMethod: "平肝潜阳", subTherapies: [{ therapy: "平肝潜阳", targetPathogenesis: "肝阳上亢", priority: "主要" }] },
    formula: { candidates: [], patentAndWestern: [], modifications: [] },
  });
  const pageWith = (nonPharma) => {
    const reasoning = compileM04Proposal({
      candidate: {
        name: "自拟方", applicable: "头晕头胀。", notApplicable: "出现神志改变时急诊。",
        herbs: [
          { name: "天麻", dose: "10g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "平肝息风" },
          { name: "钩藤", dose: "12g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "清热平肝" },
          { name: "甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "调和诸药" },
        ].map((herb) => ({ ...herb, processing: null, isToxic: false, decoctionRequirement: herb.name === "钩藤" ? "后下" : null })),
        formulaAnalysis: "天麻平肝息风为君，钩藤清热平肝为臣，甘草调和诸药。",
        decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，煎服", followUpNode: "5日复诊" },
      },
      patentAndWestern: [], modifications: [], nonPharma: { tcmTreatments: [], ...nonPharma },
    }, prior);
    const checkpoint = retainM04DeliveryCheckpoint(undefined, {
      reasoning, content: `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`,
      priorReasoning: prior, clinicalContext: "头晕头胀", generatorModel: "synthetic",
    });
    const page = renderM04DeliveryCheckpoint(checkpoint, prior, "dose_withheld", ["血压 216/132mmHg 达重度高血压警戒值"]);
    return page.slice(page.indexOf("## 调护建议"), page.indexOf("<!-- CDSS_NON_DOSE_CANDIDATE_JSON"));
  };
  check("9.1 食盐用量被当作药量掩码时，只去掉那一小句，饮食栏其余照列；整条都被掩码时整条不列", () => {
    const care = pageWith({
      diet: "饮食清淡，每日食盐控制在5克以下，忌辛辣肥甘；可食芹菜、冬瓜等新鲜蔬菜。",
      lifestyle: "起居规律，避免熬夜。", emotion: "保持情绪平稳。",
      precautions: ["每次10克，每日3次。", "避免情绪激动。"],
    });
    assert.doesNotMatch(care, /审定处方|5克/, care);
    assert.match(care, /忌辛辣肥甘/, care);
    assert.match(care, /可食芹菜、冬瓜等新鲜蔬菜/, care);
    assert.match(care, /避免情绪激动/);
    assert.doesNotMatch(care, /每日3次/, "整条都被掩码的不列");
  });
}

// ───── 10 注意事项按本例收口 ─────
{
  const { m04CompilerTestHooks } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
  const filter = (precautions, state) => m04CompilerTestHooks.casePrecautions(precautions, state);
  const woman = (present, extra = {}) => ({
    patient: { sex: "女", age: 29 }, chiefComplaint: "咳嗽2周", symptoms: { presentHistory: present }, conversation: [],
    safetyGate: { status: "ready", allowDosePrescription: true, redFlags: [], missingItems: [] }, ...extra,
  });
  const pregnancyLine = "方中川贝母、玄参、桔梗等孕期需慎用，如已怀孕或备孕请先告知医生。";
  check("10.1 已确认妊娠：去掉「如已怀孕或备孕请先告知医生」这一小句，「孕期需慎用」照列；妊娠状态未知时整句照列（对照）", () => {
    assert.deepEqual(filter([pregnancyLine, "服药宜饭后温服。"], woman("孕24周，干咳2周，痰少而黏，咽干")),
      ["方中川贝母、玄参、桔梗等孕期需慎用。", "服药宜饭后温服。"]);
    assert.deepEqual(filter([pregnancyLine], woman("干咳2周，痰少而黏，咽干")), [pregnancyLine]);
    assert.deepEqual(filter(["如已怀孕请先告知医生。"], woman("孕24周，干咳2周")), [], "整条都是假设句时整条不列");
  });
  check("10.2 红旗未解除：不写怎么服这张方（温服、服药后观察、先煎），其余照列；没有红旗时照列（对照）", () => {
    const lines = ["本方宜温服，服药期间忌辛辣。", "方中含水牛角，须先煎，服药后注意观察神志。", "继续服用硝苯地平控释片，不要自行停药。", "注意休息，避免受凉。"];
    const redFlag = woman("高热、头痛3天，神志改变半天", { safetyGate: { status: "red_flag", allowDosePrescription: false, redFlags: ["神志改变"], missingItems: [] } });
    assert.deepEqual(filter(lines, redFlag), ["继续服用硝苯地平控释片，不要自行停药。", "注意休息，避免受凉。"]);
    assert.deepEqual(filter(lines, woman("干咳2周")), lines);
  });
  check("10.3 写给某一年龄段的条目只写给这个年龄段（10/17：24 岁感冒患者写「高龄或体弱者起身宜缓」）；年龄不详时照列（对照）", () => {
    const lines = ["高龄或体弱者起身宜缓，防跌倒。", "小儿服药宜少量多次。", "注意休息，避免受凉。"];
    const aged = (age) => ({ ...woman("咳嗽2周"), patient: { sex: "女", age } });
    assert.deepEqual(filter(lines, aged(24)), ["注意休息，避免受凉。"]);
    assert.deepEqual(filter(lines, aged(72)), ["高龄或体弱者起身宜缓，防跌倒。", "注意休息，避免受凉。"]);
    assert.deepEqual(filter(lines, aged(6)), ["小儿服药宜少量多次。", "注意休息，避免受凉。"]);
    assert.deepEqual(filter(lines, { ...woman("咳嗽2周"), patient: { sex: "女" } }).length, 3);
  });
}

// ───── 10b 交付面按最终卡片与煎服法核对注意事项（10/17） ─────
{
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  const prescription = (precautions, treatments, method = "每日1剂，水煎两次，共取药液约400mL，分2次饭后温服") => ({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
    formula: { candidates: [{ name: "柴胡疏肝散", herbs: [{ name: "柴胡", dose: "9g" }], decoction: { method } }] },
    nonPharma: { precautions, acupointCare: null, tcmTreatments: treatments },
  });
  const ear = { projectCode: "auricular", protocolStatus: "governed_patient_specific_plan", tailoringStatus: "syndrome_tailored", suggestedSitesOrPoints: ["神门"], scheduleSuggestion: "每日按压3次", techniqueBoundary: "", treatmentContent: "压丸" };
  const diet = { projectCode: "diet_therapy", protocolStatus: "governed_class_template_not_syndrome_tailored", tailoringStatus: "class_template_only", suggestedSitesOrPoints: [], scheduleSuggestion: "随三餐", techniqueBoundary: "", treatmentContent: "按本病常规选用食疗。" };
  check("10b.1 交付面去掉的卡（无内容的食疗模板）与从未出卡的导引、刮痧：注意事项里点名它们的条目不下发；已给出的耳穴照列（对照）", () => {
    const lines = ["耳穴及导引治疗请按医护人员指导进行。", "刮痧、针刺后注意保暖避风。", "耳穴压丸处每日按压，勿揉破皮肤。", "注意休息，避免受凉。"];
    const out = projectDeliveredReasoning(prescription(lines, [ear, diet]));
    assert.deepEqual(out.nonPharma.precautions, ["耳穴压丸处每日按压，勿揉破皮肤。", "注意休息，避免受凉。"]);
  });
  check("10b.2 服药时间以煎服法为准：煎服法写饭后，注意事项里「饭前温服」那一小句去掉，同条其余照列；与煎服法一致时不动（对照）", () => {
    const out = projectDeliveredReasoning(prescription(["汤剂宜饭前温服，服药期间忌生冷油腻。", "注意休息。"], [ear]));
    assert.deepEqual(out.nonPharma.precautions, ["服药期间忌生冷油腻。", "注意休息。"]);
    const same = projectDeliveredReasoning(prescription(["汤剂宜饭后温服，忌生冷。"], [ear]));
    assert.deepEqual(same.nonPharma.precautions, ["汤剂宜饭后温服，忌生冷。"]);
    const before = projectDeliveredReasoning(prescription(["宜饭后服用。", "忌食生冷油腻。"], [ear], "每日1剂，分2次空腹温服"));
    assert.deepEqual(before.nonPharma.precautions, ["忌食生冷油腻。"], "煎服法写空腹时，「饭后」那条整条只剩时间就不列");
  });
}

// ───── 11 鉴别对象的典型表现 ─────
{
  const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
  const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
  const state = normalizeCaseStateInput({ patient: { sex: "女", age: 60 }, chiefComplaint: "排便困难1年", conversation: [],
    symptoms: { "现病史": "患者1年来有便意却排不出来，每次蹲厕要用很大力气，大便本身并不干硬，3～4日一行。无腹痛，无便血，无消瘦。" } });
  const typical = "腹痛、呕吐、无排气排便";
  check("11.1 JSON：肠结的「典型表现」原样保留，不被改成本例的「否认腹痛；未诉呕吐」；同一行的区分要点照常净化（对照）", () => {
    const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseName: "便秘", tcmDiseaseDifferentials: [
      { diseaseName: "肠结", reason: "均以便秘不通为主症", typicalManifestation: typical, distinguishingPoints: "无呕吐，3～4日仍能排便", nextCheck: null },
    ] } };
    const out = safety.sanitizeUngroundedRedFlagNegations(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`, state);
    const row = JSON.parse(out.slice(out.indexOf("-->") + 3, out.lastIndexOf("<!--"))).overview.tcmDiseaseDifferentials[0];
    assert.equal(row.typicalManifestation, typical);
    assert.notEqual(row.distinguishingPoints, "无呕吐，3～4日仍能排便", "病历没写「无呕吐」，区分要点照常改写");
  });
  check("11.2 正文：鉴别一行「常见：」后的典型表现原样保留；不带这个标签的同样文字照常净化（对照）", () => {
    const line = (body) => `### 中医辨病鉴别\n- **肠结**：${body}；均以便秘不通为主症。\n`;
    assert.equal(safety.sanitizeUngroundedRedFlagNegations(line(`常见：${typical}`), state), line(`常见：${typical}`));
    // 对照句的否认词要在症状词前面：10/17 起前置否认词只管它后面的词，「腹痛、呕吐、无排气排便」不带标签也不再被改写
    //（此前把排在「无」前面的腹痛、呕吐也当成否认，见 preposed-negation-scope-forward）。
    const denied = "无排气排便、呕吐";
    assert.equal(safety.sanitizeUngroundedRedFlagNegations(line(`常见：${denied}`), state), line(`常见：${denied}`));
    assert.notEqual(safety.sanitizeUngroundedRedFlagNegations(line(denied), state), line(denied));
  });
}

// ───── 12 方义核对 ─────
{
  const { reviewAuthoredFormulaAnalysis } = await jiti.import("../src/lib/formula-analysis-review.ts");
  const { resolveGovernedTcmHerbIdentity } = await jiti.import("../src/lib/tcm-herb-identity.ts");
  check("12.1 「香薷辛温芳香」里的「芳香」是描述词：不当成外来药（白芷），君药香薷那一句保留", () => {
    assert.ok(!resolveGovernedTcmHerbIdentity("芳香").canonicalName, JSON.stringify(resolveGovernedTcmHerbIdentity("芳香")));
    assert.equal(resolveGovernedTcmHerbIdentity("白芷").canonicalName, "白芷", "白芷本身照常解析（对照）");
    const text = "本方以新加香薷饮为基础加减。香薷辛温芳香，解表祛暑，为君；金银花、连翘清热解毒，为臣；厚朴、广藿香化湿和中，为佐；甘草调和诸药，为使。";
    const out = reviewAuthoredFormulaAnalysis(text, ["香薷", "金银花", "连翘", "厚朴", "广藿香", "甘草"]);
    assert.deepEqual(out.foreignHerbs, []);
    assert.equal(out.text, text);
  });
  const herbs = ["黄柏", "薏苡仁", "防己", "滑石", "赤小豆", "甘草"];
  check("12.3 方义里的系统说法（次级病机、已锁定治法方向）改成病机原话", () => {
    const text = "本方以真武汤为基础加减。附子温肾助阳为君；白术、茯苓健脾利水为臣，分治脾肾两层次级病机；白芍敛阴为佐，与本例已锁定治法方向一致；甘草调和诸药为使。";
    const out = reviewAuthoredFormulaAnalysis(text, ["附子", "白术", "茯苓", "白芍", "甘草"]);
    assert.match(out.text, /分治脾肾两层病机/);
    assert.match(out.text, /与本例治法方向一致/);
    assert.doesNotMatch(out.text, /次级病机|已锁定/);
  });
  check("12.2 分句里同时点了本方药和外来药：只删外来药名，本方药名与「二药」「三臣」按剩下的味数改写；只有外来药的分句仍整句删（对照）", () => {
    const text = "本方以宣痹汤为基础加减。黄柏、苍术二药共为君，直清下注足部之湿热；防己、薏苡仁、蚕沙三臣分消湿热；鲜扁豆花清暑化湿，滑石、赤小豆清利湿热，为佐；甘草调和诸药，为使。";
    const out = reviewAuthoredFormulaAnalysis(text, herbs);
    assert.deepEqual(out.foreignHerbs.sort(), ["苍术", "蚕沙", "鲜扁豆花"].sort());
    assert.match(out.text, /黄柏为君，直清下注足部之湿热/);
    assert.match(out.text, /防己、薏苡仁二臣分消湿热/);
    assert.doesNotMatch(out.text, /苍术|蚕沙|鲜扁豆花|清暑化湿/);
    assert.match(out.text, /滑石、赤小豆清利湿热/);
  });
}

// ───── 13 稀疏病历不套教材证型 ─────
// 只记录「胃痛3天」「腰部疼痛2周」这类主症本身时，模型照教材候选的先后套第一条（寒邪客胃证、风寒头痛），服务端再按这一行
// 换上温胃散寒、香苏散合良附丸并给剂量；12 个只有主症的病例改前 24/24 次都这样（~/runlogs/tonguepulse-20261014）。
{
  const fs = await import("node:fs");
  const { textbookNearestRow, buildTextbookCandidateContext } = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
  const { withDeterministicFormulaReferences } = await jiti.import("../src/lib/tcm-formula-provenance.ts");
  const { applyDeterministicFormulaAnalysis } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  check("13.1 模型写了不带病性的中性证名：改名不把它改成带寒热湿热的教材证型；同义写法照常归一（对照）", () => {
    assert.equal(textbookNearestRow("腰痛", "经络不通证", "通络止痛", "腰痛2周，腰部疼痛2周"), undefined);
    assert.equal(textbookNearestRow("胃痛", "胃气不和证", "理气和胃，通络止痛", "胃痛3天"), undefined);
    assert.equal(textbookNearestRow("不寐", "心神不宁证", "宁心安神", "入睡困难，多梦易醒"), undefined, "否决只针对胜出行，不先剔行再排（剔掉竞争者曾把它改成心肾不交证）");
    assert.equal(textbookNearestRow("阳痿", "肾阳不足证", "温肾壮阳", "阳事不举，腰膝酸软，畏寒肢冷")?.syndromeName, "命门火衰证");
    assert.equal(textbookNearestRow("胃痛", "瘀血停胃证", "化瘀通络，理气和胃", "胃脘刺痛，痛有定处，按之痛甚")?.syndromeName, "瘀血停滞证");
    assert.equal(textbookNearestRow("胃痛", "胃寒证", "温胃散寒止痛", "胃痛3天")?.syndromeName, "寒邪客胃证", "模型自己写了寒，改成教材写法照旧");
  });
  const neutral = (syndrome, method) => withDeterministicFormulaReferences({
    stage: "diagnose",
    overview: {
      tcmDiseaseName: "腰痛", primarySyndrome: syndrome, primarySyndromeResolution: "bounded",
      primarySyndromeBasis: ["腰痛2周", "腰部疼痛2周"], recommendedFormulaDirection: "按已锁定病机与治法辨证组方",
      tcmDiagnosticRationale: `腰部疼痛2周，寒热喜恶、舌脉均未记录，暂按${syndrome}考虑。`,
    },
    therapy: { overallPrinciple: "实则泻之", overallMethod: method },
    pathogenesis: { chain: [{ patientFact: "腰部疼痛2周", syndromeEvidence: "腰部疼痛2周", pathogenesis: "经络气血不畅，不通则痛", therapyDirection: method }] },
  });
  check("13.2 中性证名不被教材一行的治法与代表方覆盖；证名对上教材一行时照旧用该行（对照）", () => {
    const kept = neutral("经络不通证", "通络止痛");
    assert.equal(kept.overview.primarySyndrome, "经络不通证");
    assert.equal(kept.therapy.overallMethod, "通络止痛");
    assert.doesNotMatch(String(kept.overview.recommendedFormulaDirection), /四妙丸/);
    const anchored = neutral("湿热腰痛", "通络止痛");
    assert.match(anchored.therapy.overallMethod, /清热利湿/);
    assert.match(String(anchored.overview.recommendedFormulaDirection), /四妙丸/);
  });
  check("13.3 提示词：候选先后不表示可能性，「贴合」要有能分证型的已记录表现；没有时写中性证名与调理方向；档位用语不进医生读的文字", () => {
    const header = buildTextbookCandidateContext({ chiefComplaint: "胃痛3天" });
    assert.match(header, /先后不表示可能性大小/);
    assert.match(header, /只记录了本病主症本身时，没有哪一行贴合/);
    const prompts = fs.readFileSync("src/lib/diagnosis-prompts.ts", "utf8");
    assert.match(prompts, /不得从候选里挑一个证型套用/);
    assert.match(prompts, /不写温、清、补、泻、化湿、活血等需要寒热虚实或病理产物依据的治法/);
    assert.match(prompts, /医生要读的文字里不写这些词/);
    assert.doesNotMatch(prompts, /写明是按主诉直接对应的症状层病名/);
  });
  check("13.4 组成逻辑只写组成与出处：不带流程用语与课程笔记（旧数据 155 条以「受控目录组成…进入处方编译」结尾）", () => {
    const rules = JSON.parse(fs.readFileSync("src/data/tcm-formula-composition-rules.json", "utf8")).entries;
    const bad = rules.filter((entry) => /受控目录|进入处方编译|方证定位|课程|锁方|审方|患者事实/.test(entry.summary));
    assert.deepEqual(bad.map((entry) => entry.formulaName), []);
    assert.ok(rules.filter((entry) => /^组成：.+。出处：.+。$/.test(entry.summary)).length >= 150);
  });
  check("13.5 只有组成与出处的条目不顶替方义；写了配伍的条目照旧可作兜底（对照）", () => {
    const wrap = (summary) => `<!-- DIAGNOSIS_JSON_START -->${JSON.stringify({ stage: "prescribe", formula: { candidates: [{ name: "桂枝汤", herbs: [], compositionLogic: [{ formulaName: "桂枝汤", summary }] }] } })}<!-- DIAGNOSIS_JSON_END -->`;
    const analysis = (summary) => {
      const out = applyDeterministicFormulaAnalysis(wrap(summary));
      return JSON.parse(out.slice(out.indexOf("-->") + 3, out.lastIndexOf("<!--"))).formula.candidates[0].formulaAnalysis;
    };
    assert.equal(analysis("组成：桂枝、芍药、生姜、大枣、甘草。出处：《伤寒论》。"), undefined);
    assert.match(String(analysis("桂枝与芍药一散一收，配合生姜、大枣、炙甘草调和营卫并顾护中焦。")), /一散一收/);
  });
}

// ───── 14 10.12 交付轮余项（2026-10-17 第二批） ─────
// 甲方 10 例 × 3 次本地复测后独立评审仍不通过的几项里，又有几处是服务端改坏的（~/runlogs/deliver1017/judge/local2-c10-r*）。
{
  const { textbookNearestRow } = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
  const { withDeterministicFormulaReferences } = await jiti.import("../src/lib/tcm-formula-provenance.ts");
  const feipiEvidence = "反复感冒1+年，易疲乏、短气自汗、声音低怯，食欲下降，进食稍多或滋腻则胃胀不适，大便稀溏";
  check("14.1 两脏合称不被改成教材的单脏证型（甲方病历5 肺脾两虚证 → 肺气虚证）；病位栏只写一脏时、单脏同义写法照旧归一（对照）", () => {
    assert.equal(textbookNearestRow("虚劳", "肺脾两虚证", "补肺健脾，益气固表", feipiEvidence, ["肺", "脾"]), undefined);
    assert.equal(textbookNearestRow("虚劳", "肺脾气虚证", "补益肺脾", feipiEvidence), undefined);
    assert.equal(textbookNearestRow("虚劳", "肺气亏虚证", "补益肺气", feipiEvidence, ["肺"])?.syndromeName, "肺气虚证");
    assert.equal(textbookNearestRow("腰痛", "肝肾阴虚证", "滋补肝肾", "腰部酸痛，五心烦热", ["肾", "腰府"])?.syndromeName, "肾阴虚证",
      "病位栏只写了肾，证名多写的肝没有定位，照旧改成教材单脏写法");
    assert.equal(textbookNearestRow("胃痛", "肝胃不和证", "疏肝和胃", "胃脘胀痛，嗳气，情志不遂加重", ["肝", "胃"])?.syndromeName, "肝气犯胃证",
      "教材这一行本身写了两脏，不算丢病位");
    const anchored = withDeterministicFormulaReferences({
      stage: "diagnose",
      overview: {
        tcmDiseaseName: "虚劳", primarySyndrome: "肺脾两虚证", primarySyndromeResolution: "bounded",
        primarySyndromeBasis: [feipiEvidence], recommendedFormulaDirection: "补肺汤合四君子汤加减",
        tcmDiagnosticRationale: "短气自汗、声音低怯为肺气虚；食少、便溏为脾气虚。两脏各有成组表现，故为肺脾两虚证。",
      },
      therapy: { overallPrinciple: "虚则补之", overallMethod: "补肺健脾，益气固表" },
      pathogenesis: { locationDifferentiation: { items: ["肺", "脾"] }, chain: [{ patientFact: "反复感冒1+年", syndromeEvidence: feipiEvidence, pathogenesis: "肺脾气虚，卫外不固", therapyDirection: "补肺健脾" }] },
    });
    assert.equal(anchored.overview.primarySyndrome, "肺脾两虚证");
    assert.match(anchored.overview.tcmDiagnosticRationale, /故为肺脾两虚证/);
    assert.equal(anchored.therapy.overallMethod, "补肺健脾，益气固表", "没有对上教材一行，治法不被锚成「补益肺气」");
  });
}

// ───── 14b 注意事项必须写到的项目（2026-10-17 第二批） ─────
// 病历 7 三次都没写自服的黄连上清丸、甲硝唑；病历 3 一次漏写产后哺乳；S143 丹毒没写抗菌治疗。规则算出项目 → 提示词逐项列出 →
// 交付面逐项核对，漏了用规则那句补上（~/runlogs/deliver1017/research/C-llm-methods.md：漏项靠模型自查查不出来）。
{
  const { selfTakenMedicationMentions } = await jiti.import("../src/lib/clinical-polarity.ts");
  const { recentChildbirthMentioned } = await jiti.import("../src/lib/clinical-state.ts");
  const { catalogSharedComposition } = await jiti.import("../src/lib/tcm-formula-provenance.ts");
  const { requiredPrecautionsForCase, requiredPrecautionsPromptSection } = await jiti.import("../src/lib/required-precautions.server.ts");
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
  const stateOf = (presentHistory, extra = {}) => normalizeCaseStateInput({
    id: `rp-${Math.random()}`, chiefComplaint: extra.chiefComplaint || "", patient: extra.patient || { sex: "女", age: 42 },
    symptoms: { 现病史: presentHistory, ...(extra.symptoms || {}) }, conversation: [],
  });
  const tooth = "患者三天前因进食大量火锅及饮用白酒后，次日晨起出现右侧下牙持续性胀痛，咀嚼时加剧。自服“黄连上清丸”及“甲硝唑片”后疼痛略有缓解，但药效过后疼痛如故。";
  check("14.2 病历里的自服药名：带引号与不带引号、多药并列都取出；未服、否认服用、「服药后」不取（对照）", () => {
    assert.deepEqual(selfTakenMedicationMentions(tooth), ["黄连上清丸", "甲硝唑片"]);
    assert.deepEqual(selfTakenMedicationMentions("头痛2天，自服布洛芬后缓解。"), ["布洛芬"]);
    assert.deepEqual(selfTakenMedicationMentions("曾口服阿莫西林胶囊3天无效"), ["阿莫西林胶囊"]);
    assert.deepEqual(selfTakenMedicationMentions("发病后未服药，否认服用抗凝药，服药后症状加重"), []);
  });
  check("14.3 一年内分娩才算（2+月前剖宫产、两个多月前生产后、产后半年）；3 年前顺产、只写孕产次的不算（对照）", () => {
    assert.equal(recentChildbirthMentioned("2+月前患者于当地医院行“剖宫产术”，术后产下1女，余无特殊。"), true);
    assert.equal(recentChildbirthMentioned("两个多月前患者生产后出现头痛"), true);
    assert.equal(recentChildbirthMentioned("产后半年，月经未复潮"), true);
    assert.equal(recentChildbirthMentioned("3年前顺产1子"), false);
    assert.equal(recentChildbirthMentioned("适龄婚育，孕1产1"), false);
  });
  check("14.4 中成药组成：受治理的常用方用核过的组成；目录多版本取共有药味；只有一个版本的不据此说组成（对照）", () => {
    assert.deepEqual(catalogSharedComposition("黄连上清丸"), ["黄连", "大黄", "黄柏", "黄芩", "栀子", "连翘"]);
    assert.deepEqual(catalogSharedComposition("黄连上清片"), catalogSharedComposition("黄连上清丸"));
    assert.deepEqual(catalogSharedComposition("六味地黄丸").sort(), ["山茱萸", "山药", "地黄", "泽泻", "牡丹皮", "茯苓"].sort());
    assert.deepEqual(catalogSharedComposition("板蓝根颗粒"), [], "目录只有一个同名「板蓝根丸」，组成与药典的板蓝根颗粒不同");
    assert.deepEqual(catalogSharedComposition("甲硝唑片"), []);
  });
  const prior = (western, tcm) => ({ westernDiagnosis: { primary: { name: western } }, overview: { tcmDiseaseName: tcm } });
  check("14.5 必写项目：自服中成药带组成、西药带说明书的戒酒；产后哺乳未记录；丹毒；男性、哺乳已记录、无自服药时不出（对照）", () => {
    const toothItems = requiredPrecautionsForCase(stateOf(tooth), prior("急性牙髓炎", "牙痛"));
    assert.deepEqual(toothItems.map((item) => item.kind), ["self_medication", "self_medication"]);
    assert.equal(toothItems[0].name, "黄连上清丸");
    assert.ok(toothItems[0].composition.includes("大黄"));
    assert.equal(toothItems[1].base, "甲硝唑");
    assert.equal(toothItems[1].alcoholWarning, true, "含酒精制剂的说明书写明与甲硝唑同用可出现双硫仑样反应");
    assert.match(requiredPrecautionsPromptSection(toothItems), /黄连上清丸[\s\S]*甲硝唑片[\s\S]*戒酒/);
    const postpartum = stateOf("两个多月前患者生产后出现头痛，呈隐痛。", { symptoms: { 既往史: "2+月前行“剖宫产术”，术后产下1女。" } });
    assert.deepEqual(requiredPrecautionsForCase(postpartum, prior("产后头痛", "头痛")).map((item) => item.kind), ["postpartum_lactation"]);
    const recordedLactation = stateOf("两个多月前患者生产后出现头痛，呈隐痛，现母乳喂养。");
    assert.deepEqual(requiredPrecautionsForCase(recordedLactation, prior("产后头痛", "头痛")), [], "哺乳已记录时由妊娠哺乳的硬边界处理，不在这里重复");
    const male = stateOf("两个多月前妻子生产后，患者熬夜后出现头痛。", { patient: { sex: "男", age: 35 } });
    assert.deepEqual(requiredPrecautionsForCase(male, prior("紧张型头痛", "头痛")), []);
    assert.deepEqual(requiredPrecautionsForCase(stateOf("左小腿红肿热痛2天。", { patient: { sex: "男", age: 57 } }), prior("下肢丹毒", "丹毒")).map((item) => item.kind), ["skin_infection_antibiotic"]);
    assert.deepEqual(requiredPrecautionsForCase(stateOf("发病后未服药。"), prior("急性上呼吸道感染", "感冒")), []);
    assert.deepEqual(requiredPrecautionsForCase(stateOf("前日吃山楂后胃脘胀满。"), prior("消化不良", "胃痞")), [], "食物名只靠去剂型的基础名对上山楂丸，不算自服药");
  });
  const prescription = (precautions, herbs = ["黄连", "生地黄", "牡丹皮", "升麻", "当归", "大黄"]) => ({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "清胃散加减", herbs: herbs.map((name) => ({ name })) }], patentAndWestern: [] },
    nonPharma: { precautions, tcmTreatments: [] },
  });
  check("14.6 交付面逐项核对：漏写的用规则那句补在最前（重叠药按本方实有的药味说），已写到的不动，再投影一次不变，辨证结果不加（对照）", () => {
    const items = requiredPrecautionsForCase(stateOf(tooth), prior("牙痛", "牙痛"));
    const out = projectDeliveredReasoning(prescription(["服药宜饭后温服，忌辛辣醇酒。"]), { requiredPrecautions: items });
    assert.equal(out.nonPharma.precautions.length, 3);
    assert.match(out.nonPharma.precautions[0], /^已自服的黄连上清丸与本方同含黄连、大黄，/);
    assert.match(out.nonPharma.precautions[1], /甲硝唑片[\s\S]*须戒酒，饮酒可引起双硫仑样反应/);
    assert.equal(out.nonPharma.precautions[2], "服药宜饭后温服，忌辛辣醇酒。");
    const again = projectDeliveredReasoning(structuredClone(out), { requiredPrecautions: items });
    assert.deepEqual(again.nonPharma.precautions, out.nonPharma.precautions);
    const covered = projectDeliveredReasoning(prescription(["黄连上清丸与本方都含黄连、大黄，服本方期间请停服。", "甲硝唑服药期间及停药后3天内不要饮酒。"]), { requiredPrecautions: items });
    assert.equal(covered.nonPharma.precautions.length, 2, "模型已写到的不再补");
    // 模型把提示里给的整串组成抄成「重叠」：本方没有的药删掉，只留本方真有的（本地复测病历 7：处方没有黄芩、黄柏、栀子、连翘）。
    const copied = projectDeliveredReasoning(prescription(["病历记录已自服黄连上清丸，与本方黄连、大黄、黄芩、黄柏、栀子、连翘等重叠，服本方期间应停服黄连上清丸。", "甲硝唑服药期间不要饮酒。"]), { requiredPrecautions: items });
    assert.equal(copied.nonPharma.precautions[0], "病历记录已自服黄连上清丸，与本方黄连、大黄等重叠，服本方期间应停服黄连上清丸。");
    // 一味真有的都不剩还说重叠：换成规则那一句（按本方实有药味说）。
    const none = projectDeliveredReasoning(prescription(["已自服黄连上清丸，与本方黄芩、栀子重叠，请停服。", "甲硝唑服药期间不要饮酒。"], ["升麻", "生地黄", "牡丹皮", "当归", "石膏"]), { requiredPrecautions: items });
    assert.match(none.nonPharma.precautions[0], /^已自服的黄连上清丸是否继续服用/);
    assert.ok(!none.nonPharma.precautions.some((line) => /黄芩、栀子重叠/.test(line)));
    const postpartumOut = projectDeliveredReasoning(prescription(["补益药宜饭前温服。"], ["当归", "川芎", "熟地黄", "白芍", "麦芽"]), { requiredPrecautions: [{ kind: "postpartum_lactation" }] });
    // 哺乳期慎用的药与逐味人群提示同一份知识库、同一档（中、高）：川芎、麦芽列，当归、白芍（低）不列。
    assert.equal(postpartumOut.nonPharma.precautions[0], "产后如正在哺乳，请服药前告知医生（方中川芎、麦芽哺乳期须慎用），由医生评估后再服。");
    // 模型写「方中暂无哺乳期慎用药」而知识库列了：换成规则那一句（本地复测病历 3）。
    const denied = projectDeliveredReasoning(prescription(["患者一年内分娩，如正在哺乳请先告知医生，方中暂无回乳或哺乳期慎用药。", "补益药宜饭前温服。"], ["当归", "川芎", "白芍"]), { requiredPrecautions: [{ kind: "postpartum_lactation" }] });
    assert.deepEqual(denied.nonPharma.precautions, ["产后如正在哺乳，请服药前告知医生（方中川芎哺乳期须慎用），由医生评估后再服。", "补益药宜饭前温服。"]);
    const diagnose = projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", nonPharma: { precautions: [] } }, { requiredPrecautions: items });
    assert.deepEqual(diagnose.nonPharma.precautions, []);
  });
}

// ───── 14c 病历 7 西医病名、方义加药说法、服药时间、运动保健（2026-10-17 第二批） ─────
{
  const fs = await import("node:fs");
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  check("14.7 西医病名核对 D：牙病分型须口腔检查，没有时只写「牙痛」（病历 7「急性牙髓炎」离线 3/3 → 牙痛）；运动保健按行动能力写", () => {
    const check = fs.readFileSync("src/lib/western-name-evidence-check.server.ts", "utf8");
    assert.match(check, /牙病的分型名称（急性牙髓炎、慢性牙髓炎、急性根尖周炎、牙周脓肿、智齿冠周炎等）需要口腔专科检查/);
    assert.match(check, /“关节炎”“牙痛”/);
    // 放在 D 段末尾：插在病程门槛那句前面时，功能性便秘 3 个月（S161）两次都漏判（~/runlogs/deliver1017/west/v4*-synth）。
    assert.ok(check.indexOf("肠易激综合征还必须有腹痛") < check.indexOf("牙病的分型名称"));
    const prompts = fs.readFileSync("src/lib/diagnosis-prompts.ts", "utf8");
    assert.match(prompts, /病历记录了行动受限（拄拐、助行器、骨折或关节术后、卧床、肢体无力）或高龄体弱时，只写与之相称的坐位或床旁活动/);
  });
  const xiaofeng = (analysis) => projectDeliveredReasoning({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "消风散加减", formulaAnalysis: analysis,
      herbs: ["荆芥", "防风", "蝉蜕", "炒牛蒡子", "苦参", "麸炒苍术", "川木通", "当归", "知母", "生地黄", "炒黑芝麻", "甘草", "白鲜皮"].map((name) => ({ name })) }] },
    nonPharma: { precautions: [] },
  }).formula.candidates[0].formulaAnalysis;
  check("14.8 方义开头「加X」而X本在原方（消风散有地黄：加生地黄、以生地黄易原方地黄）：去掉不实说法；真加的药、后文配伍照留（对照）", () => {
    assert.equal(xiaofeng("本方以消风散为基础加减，去煅石膏，加生地黄。荆芥、防风为君。"), "本方以消风散为基础加减，去煅石膏。荆芥、防风为君。");
    assert.equal(xiaofeng("本方以消风散为基础加减，去煅石膏，以生地黄易原方地黄并加用。荆芥、防风辛散。"), "本方以消风散为基础加减，去煅石膏。荆芥、防风辛散。");
    assert.equal(xiaofeng("本方以消风散为基础加减，去煅石膏，加生地黄、白鲜皮。荆芥为君。"), "本方以消风散为基础加减，去煅石膏，加白鲜皮。荆芥为君。");
    assert.equal(xiaofeng("本方以消风散为基础加减，加白鲜皮以止痒。生地黄清热凉血，加强养血之力。"), "本方以消风散为基础加减，加白鲜皮以止痒。生地黄清热凉血，加强养血之力。");
    // 加药说法跟在顿号后面（生产复测病历 9：「去石膏、加生地黄」）。
    assert.equal(xiaofeng("本方以消风散为基础，去石膏、加生地黄。荆芥、防风为君。"), "本方以消风散为基础，去石膏。荆芥、防风为君。");
  });
  check("14.9 注意事项「若胃脘不适可改为饭后温服」而煎服法已是饭后：去掉这一小句，同条其余照留；煎服法是饭前时照留（对照）", () => {
    const run = (method) => projectDeliveredReasoning({
      schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
      formula: { candidates: [{ name: "安神定志丸加减", herbs: [], decoction: { method } }] },
      nonPharma: { precautions: ["忌生冷油腻及浓茶，服后若胃脘不适可改为饭后温服。"], tcmTreatments: [] },
    }).nonPharma.precautions;
    assert.deepEqual(run("水煎服，每日1剂，分2次饭后温服"), ["忌生冷油腻及浓茶。"]);
    assert.deepEqual(run("水煎服，每日1剂，分2次饭前温服"), ["忌生冷油腻及浓茶，服后若胃脘不适可改为饭后温服。"]);
  });
}

// ───── 14d 第三轮复测评审又找到的服务端文字（2026-10-17） ─────
{
  const { applyWesternNameCorrection } = await jiti.import("../src/lib/western-name-evidence-check.server.ts");
  const { normalizeM03WesternDifferentials } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
  const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  check("14.10 情形 D 把原病名放进鉴别：理由开头的「无/未记录…检查」换成「尚缺」，不被当成对患者的否认；交付面带括注的对象也能改写", () => {
    const western = JSON.stringify({ westernDiagnosis: { primary: { name: "急性牙髓炎" }, candidates: [], differentials: [] } });
    const out = JSON.parse(applyWesternNameCorrection(western, { type: "D", supportedName: "牙痛", quote: "右侧下牙持续性胀痛", reason: "无口腔专科检查（牙髓活力、叩诊等）分型依据" }));
    assert.equal(out.westernDiagnosis.differentials[0].distinguishingPoints, "尚缺口腔专科检查（牙髓活力、叩诊等）分型依据");
    const delivered = projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", westernDiagnosis: { primary: { name: "牙痛" }, differentials: [
      { name: "急性牙髓炎", distinguishingPoints: "病历未记录冷热刺激痛（遇冷加重）（需问诊核实后方可用于排除）" },
    ] } });
    assert.equal(delivered.westernDiagnosis.differentials[0].distinguishingPoints, "未诉冷热刺激痛（遇冷加重）");
  });
  check("14.11 「颞动脉无压痛」「鼻窦区压痛」不是腹部查体；「腹软，无压痛」「无压痛」照常按腹部查体核（对照）", () => {
    const state = normalizeCaseStateInput({ id: "exam-site", chiefComplaint: "头痛2月", symptoms: { 现病史: "头痛2月，呈隐痛。" }, conversation: [], patient: { sex: "女", age: 32 } });
    const run = (text) => {
      const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", westernDiagnosis: { differentials: [{ name: "巨细胞动脉炎", distinguishingPoints: text }] } };
      const out = safety.sanitizeUngroundedRedFlagNegations(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`, state);
      return JSON.parse(out.slice(out.indexOf("-->") + 3, out.lastIndexOf("<!--"))).westernDiagnosis.differentials[0].distinguishingPoints;
    };
    assert.doesNotMatch(run("颞动脉无压痛、无怒张"), /腹部查体/);
    assert.doesNotMatch(run("查鼻窦区压痛"), /腹部查体/);
    assert.match(run("腹软，无压痛"), /腹部查体/);
    assert.match(run("全腹无压痛及反跳痛"), /腹部查体/);
  });
  check("14.12 「泌尿系结石/感染」拆开后「感染」借兄弟项的部位成「泌尿系感染」；「感染/肿瘤」借不到，原样（对照）", () => {
    const run = (name) => {
      const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", westernDiagnosis: { primary: { name: "腰痛" }, differentials: [{ name, reason: "需排除", distinguishingPoints: "大小便正常", nextCheck: "尿常规" }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
      const out = normalizeM03WesternDifferentials(content, "腰痛半年，大小便正常。", 70);
      return JSON.parse(out.slice(out.indexOf("-->") + 3, out.lastIndexOf("<!--"))).westernDiagnosis.differentials.map((item) => item.name);
    };
    assert.deepEqual(run("泌尿系结石/感染"), ["泌尿系结石", "泌尿系感染"]);
    const unborrowed = run("感染/肿瘤");
    assert.ok(unborrowed.includes("感染") && !unborrowed.some((name) => name.length > 2 && name.endsWith("感染")), JSON.stringify(unborrowed));
  });
}

// ───── 14e 治疗卡与注意事项（2026-10-17 第三轮复测评审） ─────
{
  const { cardSentencesNamingListedPoints } = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  check("14.13 针刺卡操作栏点名的穴位一个都不在本卡穴位里的句子不留（风寒感冒卡里的「少商、商阳用点刺放血法」）；说禁忌、不宜的句子照留；点名的穴有在卡上的照留（对照）", () => {
    const points = ["列缺（LU7·手太阴肺经）", "合谷（LI4·手阳明大肠经）", "风池（GB20）", "大椎（DU14）", "肺俞（BL13）"];
    const text = "诸穴均宜浅刺。风寒证可加灸法；少商、商阳用点刺放血法。 禁忌：膏肓、肺俞、膈俞等穴局部肌肉薄，须规范操作避免气胸。";
    assert.equal(cardSentencesNamingListedPoints(text, points), "诸穴均宜浅刺。风寒证可加灸法。 禁忌：膏肓、肺俞、膈俞等穴局部肌肉薄，须规范操作避免气胸。");
    assert.equal(cardSentencesNamingListedPoints("毫针常规刺，膻中不宜直刺、深刺，以免伤及内脏；阴水可加灸。", points), "毫针常规刺，膻中不宜直刺、深刺，以免伤及内脏；阴水可加灸。");
    assert.equal(cardSentencesNamingListedPoints("大椎、少商可点刺出血。", points), "大椎、少商可点刺出血。");
  });
  check("14.14 针刺卡在皮损局部取穴（阿是穴/围刺）时，注意事项里「皮损局部暂不施针」那一小句不留，同条其余照留；卡上没有局部取穴时照留（对照）", () => {
    const run = (card) => projectDeliveredReasoning({
      schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
      formula: { candidates: [{ name: "龙胆泻肝汤加减", herbs: [] }] },
      nonPharma: { precautions: ["针刺治疗需在正规医疗机构由专业人员操作，皮损局部暂不施针。"], tcmTreatments: [card] },
    }).nonPharma.precautions;
    assert.deepEqual(run({ projectCode: "acupuncture", suggestedSitesOrPoints: ["阿是穴", "夹脊（EX-B2）"], treatmentContent: "取局部穴位及相应夹脊穴为主。", techniqueBoundary: "皮损局部阿是穴用围刺法。" }),
      ["针刺治疗需在正规医疗机构由专业人员操作。"]);
    assert.deepEqual(run({ projectCode: "acupuncture", suggestedSitesOrPoints: ["夹脊（EX-B2）", "行间（LR2）"], treatmentContent: "取夹脊穴。", techniqueBoundary: "毫针刺，用泻法。" }),
      ["针刺治疗需在正规医疗机构由专业人员操作，皮损局部暂不施针。"]);
  });
}

// ───── 14f 第四轮复测评审：留出集的服务端文字（2026-10-17） ─────
{
  const { reviewAuthoredFormulaAnalysis } = await jiti.import("../src/lib/formula-analysis-review.ts");
  const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
  const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  const { moxibustionUnsuitableForSyndrome } = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
  const fs = await import("node:fs");
  check("14.15 剔掉外来药后，下一个分句里的「二药合为君」同样按剩下的本方药味数改写（S145）；两味都在时不动（对照）", () => {
    const herbs = ["黄柏", "薏苡仁", "防己", "牛膝", "滑石", "栀子", "甘草"];
    const out = reviewAuthoredFormulaAnalysis("本方以宣痹汤为基础加减。黄柏、苍术苦寒清下焦湿热，二药合为君，直解湿热下注之核心；薏苡仁、防己利湿除痹。", herbs);
    assert.match(out.text, /黄柏苦寒清下焦湿热，合为君|黄柏苦寒清下焦湿热，为君/);
    assert.doesNotMatch(out.text, /二药/);
    const kept = reviewAuthoredFormulaAnalysis("本方以宣痹汤为基础加减。黄柏、栀子苦寒清下焦湿热，二药合为君，直解湿热下注之核心；薏苡仁、防己利湿除痹。", herbs);
    assert.match(kept.text, /黄柏、栀子苦寒清下焦湿热，二药合为君/);
  });
  check("14.16 未录脉象时「脉微欲绝」整个换成「脉象待核实」，不留「欲绝」（S074）", () => {
    const state = normalizeCaseStateInput({ id: "pulse-tail", chiefComplaint: "汗出黏腻1月", symptoms: { 现病史: "汗出黏腻，口苦。" }, conversation: [], patient: { sex: "男", age: 40 } });
    const out = safety.sanitizeUngroundedRedFlagNegations("脱汗典型者脉微欲绝。", state);
    assert.doesNotMatch(out, /欲绝/);
    assert.match(out, /脉象待核实/);
  });
  check("14.17 鉴别的「建议核实」写成字符串 null 时按空值交付（S132）", () => {
    const out = projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseDifferentials: [{ diseaseName: "风瘙痒", nextCheck: "null" }, { diseaseName: "牛皮癣", nextCheck: "皮肤科视诊" }] } });
    assert.equal(out.overview.tcmDiseaseDifferentials[0].nextCheck, null);
    assert.equal(out.overview.tcmDiseaseDifferentials[1].nextCheck, "皮肤科视诊");
  });
  check("14.18 湿热、阴虚、实热、火类证候整张灸法卡不出（S067 湿热石淋）；虚寒、阳虚照出（对照）", () => {
    assert.equal(moxibustionUnsuitableForSyndrome("下焦湿热证"), true);
    assert.equal(moxibustionUnsuitableForSyndrome("肾阴虚证"), true);
    assert.equal(moxibustionUnsuitableForSyndrome("命门火衰证"), false);
    assert.equal(moxibustionUnsuitableForSyndrome("脾胃虚寒证"), false);
    const src = fs.readFileSync("src/lib/tcm-treatment-capabilities.server.ts", "utf8");
    assert.match(src, /definition\.code === "moxibustion" && moxibustionUnsuitableForSyndrome\(signedSyndromeText, prior\.therapy\?\.overallMethod \|\| ""\)\) return \[\]/);
  });
}

// ───── 14g 生产复测（d2bbe09）评审又找到的服务端文字 ─────
{
  const { groundDifferentialNegativeAssertions } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  check("14.19 鉴别要点里的「无法分型」不是否认，不改成「病历未记录法分型」；真正的「无X」未记录照常改（对照）", () => {
    const run = (text) => {
      const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", westernDiagnosis: { differentials: [{ name: "急性牙髓炎", distinguishingPoints: text }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
      const out = groundDifferentialNegativeAssertions(content, "右侧下牙持续性胀痛，咀嚼时加剧。");
      return JSON.parse(out.slice(out.indexOf("-->") + 3, out.lastIndexOf("<!--"))).westernDiagnosis.differentials[0].distinguishingPoints;
    };
    assert.equal(run("尚缺口腔专科检查（牙髓活力、叩诊等），无法分型"), "尚缺口腔专科检查（牙髓活力、叩诊等），无法分型");
    assert.match(run("无冷热刺激痛"), /病历未记录冷热刺激痛/);
    assert.match(run("无汗出"), /病历未记录汗出/, "无汗、无痰这类症状词照常按病历核");
    // 已存输出里「未诉法判断」100 余处、「未诉定处拒按」20 处；「无形寒肢冷」「无关节变形」是真正的否认，照常核。
    assert.equal(run("无法判断"), "无法判断");
    assert.match(run("无形寒肢冷"), /病历未记录形寒肢冷/);
    assert.match(run("无关节变形"), /病历未记录关节变形/);
  });
}

// ───── 15 10/18 轮：生产复测与留出集评审里剩下的几类（一类一修）─────
{
  const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  const record = "患者心悸1月，胸闷，乏力，体重无明显变化。";
  check("15.1 未录阴性「无X」一条判据：长短语（16 字内）改「未诉」；西医鉴别句中的「…、无夜间痛；」也改；病历写到过的对象（含换说法的长短语）不动（对照）", () => {
    assert.equal(visible.unrecordedNegativesAsNotReported("无气从少腹上冲胸咽之奔豚特征，与奔豚相区分", record), "未诉气从少腹上冲胸咽之奔豚特征，与奔豚相区分");
    assert.equal(visible.unrecordedNegativesAsNotReported("无发热恶寒，非外感", "患者咳嗽3天，无恶寒发热。"), "无发热恶寒，非外感", "首尾两字都在病历里：换了说法也算写到过");
    assert.equal(visible.unrecordedNegativesAsNotReported("无乏力", record), "无乏力");
    const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", westernDiagnosis: { differentials: [{ name: "腰椎转移瘤", reason: "年龄偏大需排除", distinguishingPoints: "未诉体重下降、无夜间痛；完善腰椎MRI" }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
    const read = (out) => JSON.parse(out.slice(out.indexOf("-->") + 3, out.lastIndexOf("<!--"))).westernDiagnosis.differentials[0].distinguishingPoints;
    assert.equal(read(visible.groundDifferentialNegativeAssertions(content, "腰痛2月，弯腰时加重。")), "未诉体重下降、夜间痛；完善腰椎MRI", "「未诉A、未诉B」并成「未诉A、B」");
    assert.equal(read(visible.groundDifferentialNegativeAssertions(content, "腰痛2月，无夜间痛。")), "未诉体重下降、无夜间痛；完善腰椎MRI", "病历写了无夜间痛时照留");
  });
}
{
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  const analysisFor = (name, names, formulaAnalysis) => projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
    formula: { candidates: [{ name, herbs: names.map((herb) => ({ name: herb, dose: "9g" })), formulaAnalysis }] }, nonPharma: null }).formula.candidates[0].formulaAnalysis;
  const liuwei = ["熟地黄", "山茱萸", "山药", "泽泻", "牡丹皮", "茯苓", "枸杞子"];
  check("15.2 六味俱在时「去原方中偏于清利的配伍重心」不留（S076）；真去了泽泻时照留（对照）", () => {
    const claim = "本方以六味地黄丸为基础加减，去原方中偏于清利的配伍重心，加枸杞子滋补肝肾。熟地黄为君。";
    assert.equal(analysisFor("六味地黄丸加减", liuwei, claim), "本方以六味地黄丸为基础加减，加枸杞子滋补肝肾。熟地黄为君。");
    assert.equal(analysisFor("六味地黄丸加减", liuwei.filter((herb) => herb !== "泽泻"), claim), claim);
  });
  check("15.3 内服方的药味功效栏去掉「外用＋功效」小句（补骨脂「外用消风祛斑」S054）；只说途径的「外用适量」与外洗方不动（对照）", () => {
    const run = (method, fn) => projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
      formula: { candidates: [{ name: "四神丸加减", decoction: { method }, herbs: [{ name: "补骨脂", dose: "9g", function: fn }] }] }, nonPharma: null }).formula.candidates[0].herbs[0].function;
    assert.equal(run("水煎服，分2次温服", "温肾助阳，温脾止泻，外用消风祛斑"), "温肾助阳，温脾止泻");
    assert.equal(run("水煎外洗患处", "温肾助阳，外用消风祛斑"), "温肾助阳，外用消风祛斑");
    assert.equal(run("水煎服", "外用适量"), "外用适量");
  });
  check("15.4 注意事项禁一类药（「不宜再服润肠通便类中成药」）而推荐里正是这类药时不留（S058）；推荐里没有这一类时照留（对照）", () => {
    const out = (recommend) => projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
      formula: { candidates: [{ name: "济川煎加减", herbs: [], decoction: { method: "分2次饭前温服" } }], patentAndWestern: recommend },
      nonPharma: { precautions: ["服本方期间不宜再服润肠通便类中成药，以免通下太过。", "注意休息。"], acupointCare: null, tcmTreatments: [] } }).nonPharma.precautions;
    assert.deepEqual(out([{ name: "便通胶囊", correspondingProblem: "便秘" }, { name: "乳果糖口服溶液", correspondingProblem: "慢性功能性便秘", indication: "润肠通便" }]), ["注意休息。"]);
    assert.deepEqual(out([{ name: "复方丹参滴丸", correspondingProblem: "胸痹" }]), ["服本方期间不宜再服润肠通便类中成药，以免通下太过。", "注意休息。"]);
  });
  check("15.5 针刺卡取阿是穴时「皮肤红肿灼热处不宜针刺」这一小句不留（S143，「红肿」与「处」之间隔字）；卡上无局部取穴时照留（对照）", () => {
    const run = (points) => projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
      formula: { candidates: [{ name: "普济消毒饮加减", herbs: [] }] },
      nonPharma: { precautions: ["卧床抬高患肢，皮肤红肿灼热处不宜针刺。"], acupointCare: null, tcmTreatments: [{ projectCode: "acupuncture", suggestedSitesOrPoints: points, techniqueBoundary: "毫针泻法", treatmentContent: "取穴" }] } }).nonPharma.precautions;
    assert.deepEqual(run(["曲池", "合谷", "阿是穴"]), ["卧床抬高患肢。"]);
    assert.deepEqual(run(["曲池", "合谷"]), ["卧床抬高患肢，皮肤红肿灼热处不宜针刺。"]);
  });
  check("15.6 规则必写项：未满 12 岁写给家长的喂服一条、75 岁起高龄一条，模型漏写时补；已写到的不重复（对照）", () => {
    const out = (required, precautions) => projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
      formula: { candidates: [{ name: "保和丸加减", herbs: [] }] }, nonPharma: { precautions, acupointCare: null, tcmTreatments: [] } }, { requiredPrecautions: required }).nonPharma.precautions;
    const child = out([{ kind: "pediatric_administration", ageYears: 7 }], ["饮食宜清淡。"]);
    assert.match(child[0], /少量多次/);
    assert.doesNotMatch(child[0], /按年龄折算/, "非剂量页也会走到这里：不写剂量已折算");
    assert.equal(out([{ kind: "pediatric_administration", ageYears: 7 }], ["患儿服药宜少量多次喂服。"]).length, 1);
    assert.match(out([{ kind: "elderly_administration", ageYears: 82 }], ["饮食宜清淡。"])[0], /年长者/);
  });
}
{
  const { requiredPrecautionsForCase } = await jiti.import("../src/lib/required-precautions.server.ts");
  const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
  const state = (age) => normalizeCaseStateInput({ id: "age", chiefComplaint: "纳差1周", patient: { sex: "男", age }, symptoms: { 现病史: "纳差1周。" }, conversation: [] });
  check("15.7 必写项按年龄算：8 岁 → 喂服一条，68 岁 → 年长一条（65 岁起，与项目卡同一界值），40 岁没有（对照）；「8个月」按月读", () => {
    assert.deepEqual(requiredPrecautionsForCase(state(8)).map((item) => item.kind), ["pediatric_administration"]);
    assert.deepEqual(requiredPrecautionsForCase(state(68)).map((item) => item.kind), ["elderly_administration"]);
    assert.deepEqual(requiredPrecautionsForCase(state(60)), []);
    assert.deepEqual(requiredPrecautionsForCase(state(40)), []);
    assert.equal(requiredPrecautionsForCase(state("8个月"))[0]?.kind, "pediatric_administration");
  });
}
{
  const { incidentalSleepSedativeModification } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
  const prior = (primarySyndrome, tcmDiseaseName) => ({ stage: "diagnose", overview: { primarySyndrome, tcmDiseaseName, secondarySyndromes: [] } });
  check("15.8 加减里为顺带睡眠差加的安神药不留（S132 瘾疹加珍珠母、S158 积滞加蝉蜕「宁心安神」）；夜啼、不寐、心脾两虚照留；触发不是睡眠时照留（对照）", () => {
    assert.equal(incidentalSleepSedativeModification({ trigger: "若瘙痒不能入眠", herbName: "珍珠母", reason: "平肝潜阳安神" }, prior("血虚风燥证", "瘾疹")), true);
    assert.equal(incidentalSleepSedativeModification({ trigger: "若烦躁、夜啼难眠", herbName: "蝉蜕", reason: "清疏郁热，宁心安神" }, prior("乳食内积证", "积滞")), true);
    assert.equal(incidentalSleepSedativeModification({ trigger: "若夜间啼哭不止", herbName: "蝉蜕", reason: "宁心安神" }, prior("心经积热证", "夜啼")), false);
    assert.equal(incidentalSleepSedativeModification({ trigger: "若夜啼难眠", herbName: "蝉蜕", reason: "宁心安神" }, prior("脾寒气滞证", "夜啼")), false, "病名就是夜啼时睡眠在病机里");
    assert.equal(incidentalSleepSedativeModification({ trigger: "若失眠多梦", herbName: "酸枣仁", reason: "养心安神" }, prior("心脾两虚证", "眩晕")), false);
    assert.equal(incidentalSleepSedativeModification({ trigger: "若瘙痒剧烈", herbName: "白鲜皮", reason: "祛风止痒" }, prior("血虚风燥证", "瘾疹")), false);
    assert.equal(incidentalSleepSedativeModification({ trigger: "若夜寐不安", herbName: "白鲜皮", reason: "祛风止痒" }, prior("血虚风燥证", "瘾疹")), false, "加的不是安神药、理由也不说安神");
  });
}
{
  const plan = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
  check("15.9 灸法看已签名治法：证名不带寒热字（石淋）而治法清热利湿时不宜灸；温阳、散寒治法照灸（对照）", () => {
    assert.equal(plan.moxibustionUnsuitableForSyndrome("石淋", "清热利湿，排石通淋"), true);
    assert.equal(plan.moxibustionUnsuitableForSyndrome("劳淋", "补脾益肾"), false);
    assert.equal(plan.moxibustionUnsuitableForSyndrome("寒湿腰痛证", "散寒行湿，温经通络"), false);
    assert.equal(plan.moxibustionUnsuitableForSyndrome("寒热错杂证", "清热温中"), false, "温清并用不算纯清");
  });
  check("15.10 卡片自述「多用于膏淋、劳淋」而本例是石淋：整张不出；本例是劳淋时照出；列的不是类型名时不管（对照）", () => {
    const text = "取肾俞、关元、气海、中极、三阴交。常规灸法，多用于膏淋、劳淋。";
    assert.equal(plan.cardApplicabilityExcludesSyndrome(text, ["淋证"], "石淋"), true);
    assert.equal(plan.cardApplicabilityExcludesSyndrome(text, ["淋证"], "劳淋"), false);
    assert.equal(plan.cardApplicabilityExcludesSyndrome("毫针常规刺，多用于急性发作期。", ["淋证"], "石淋"), false);
  });
}
{
  const treatments = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
  const { acupointPregnancySensitive } = await jiti.import("../src/lib/tcm-acupoints.ts");
  check("15.11 项目卡人群提示同一处：7 岁拔罐、耳穴卡有小儿一句，老年拔罐有老年一句，妊娠未写明且卡上有合谷、三阴交时点名；成年男性、没有孕期穴时没有（对照）", () => {
    assert.match(treatments.populationCardNote("cupping", 7, false, ["肺俞"]), /小儿拔罐/);
    assert.match(treatments.populationCardNote("auricular", 7, false, []), /贴压/);
    assert.match(treatments.populationCardNote("acupuncture", 7, false, []), /浅刺、快出针/);
    assert.match(treatments.populationCardNote("cupping", 80, false, []), /老年人拔罐/);
    assert.equal(treatments.populationCardNote("acupuncture", 80, false, []), treatments.ELDERLY_ACUPUNCTURE_NOTE);
    assert.match(treatments.populationCardNote("acupuncture", 30, true, ["合谷", "三阴交", "足三里"]), /合谷、三阴交孕期不宜/);
    assert.equal(treatments.populationCardNote("acupuncture", 30, true, ["足三里", "内关"]), "");
    assert.equal(treatments.populationCardNote("cupping", 40, false, ["肺俞"]), "");
  });
  check("15.12 孕期须回避的穴取自教材穴位目录：合谷、三阴交、关元、中极、次髎，以及腹部、腰骶部的中脘、天枢、肾俞、命门是；足三里、内关不是（对照）", () => {
    for (const name of ["合谷", "三阴交", "关元", "中极", "次髎", "中脘", "天枢", "肾俞", "命门"]) assert.equal(acupointPregnancySensitive(name), true, name);
    for (const name of ["足三里", "内关", "列缺"]) assert.equal(acupointPregnancySensitive(name), false, name);
  });
}
{
  const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");
  const rules = await jiti.import("../src/lib/herb-decoction-rules.ts");
  check("15.13 「外用＋功效」不再列举动词：外用消风祛斑、外治疮疡都算；外用、外用适量、外用不可内服不算（对照）", () => {
    for (const clause of ["外用消风祛斑", "外用生肌敛疮", "外治疮疡"]) assert.equal(knowledge.isExternalUseEfficacyClause(clause), true, clause);
    for (const clause of ["外用", "外用适量", "外用不可内服", "只供外用"]) assert.equal(knowledge.isExternalUseEfficacyClause(clause), false, clause);
  });
  check("15.14 《北京市中药饮片调剂规程》包煎品种：马勃、青黛、儿茶包煎；川贝母不再被未复核的模型行强制冲服（药典先给煎服量）；三七、朱砂的粉剂规则照旧（对照）", () => {
    for (const name of ["马勃", "青黛", "儿茶"]) assert.deepEqual(rules.decoctionRuleForHerb(name)?.required, ["包煎"], name);
    assert.equal(rules.decoctionRuleForHerb("川贝母"), undefined);
    assert.ok(rules.decoctionRuleForHerb("三七")?.oneOf?.[0]?.includes("冲服"));
    assert.ok(rules.decoctionRuleForHerb("朱砂")?.prohibited?.includes("同煎"));
  });
}
{
  const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
  const sources = (name, herbs) => provenance.resolveFormulaSources(name, herbs.map((herb) => ({ name: herb }))).map((item) => item.source);
  check("15.15 出处原书优先：竹叶石膏汤去粳米仍署《伤寒论》（S046；名录里「竹叶二把」「麦门冬」按药名身份比）；温胆汤带茯苓仍归《三因》（对照）", () => {
    assert.deepEqual(sources("竹叶石膏汤加减", ["石膏", "竹叶", "半夏", "麦冬", "柿蒂", "大黄", "厚朴", "人参", "炙甘草"]), ["《伤寒论》"]);
    assert.match(sources("温胆汤加减", ["半夏", "竹茹", "枳实", "陈皮", "甘草", "茯苓"])[0], /三因/);
  });
  check("15.15b 原书条目才按药名身份比，名录转载按原写法比（回放 724 个候选时转载写生地、丹皮、橘皮反而更「贴近」）：清胃散、普济消毒饮、逍遥散、生脉散、小半夏汤仍署原书；左归饮照原书原名开方署《景岳全书》", () => {
    assert.deepEqual(sources("清胃散加减", ["黄连", "升麻", "生地黄", "牡丹皮", "当归", "大黄", "石膏", "知母"]), ["《兰室秘藏》"]);
    assert.deepEqual(sources("普济消毒饮加减", ["黄芩", "黄连", "连翘", "板蓝根", "牛蒡子", "薄荷", "升麻", "柴胡", "玄参", "马勃", "桔梗", "陈皮", "甘草"]), ["《东垣试效方》"]);
    assert.match(sources("逍遥散加减", ["柴胡", "当归", "白芍", "白术", "茯苓", "丹参", "牡丹皮", "栀子", "甘草"])[0], /太平惠民和剂局方/);
    assert.deepEqual(sources("生脉散合人参养荣汤加减", ["人参", "黄芪", "麦冬", "五味子", "当归", "熟地黄", "白芍", "白术", "茯苓", "陈皮", "枸杞子", "川芎", "郁金", "炙甘草"])[0], "《医学启源》卷下。");
    assert.deepEqual(sources("小半夏汤合苓桂术甘汤加减", ["法半夏", "生姜", "茯苓", "桂枝", "白术", "陈皮", "甘草"]), ["《金匮要略》", "《金匮要略》"]);
    assert.deepEqual(sources("左归饮", ["熟地", "山药", "枸杞", "炙甘草", "茯苓", "山茱萸"]), ["《景岳全书》"]);
  });
}
{
  const search = await jiti.import("../src/lib/deepseek-web-search.server.ts");
  await checkAsync("15.16 联网检索结果解析：缺网址或标题的条目丢弃；权威度、相关度照搬；查询只接受名称（病历句子、超长、带标点的直接不查）", async () => {
    const parsed = search.parseWebSearchResponse({ results: [{ title: "缺铁性贫血", url: "https://www.msdmanuals.cn/x#t", site_name: "默沙东诊疗手册", summary: "血清铁蛋白…", authority: 4, rerank_score: 2.03 }, { title: "", url: "https://a" }, { title: "x", url: "ftp://b" }] });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].authority, 4);
    assert.deepEqual(await search.webSearchGovernedTerm("患者头痛三天伴恶心，无发热。", "诊断标准"), []);
  });
}

{
  const westernCheck = await jiti.import("../src/lib/western-name-evidence-check.server.ts");
  const criteria = await jiti.import("../src/lib/western-diagnostic-criteria.server.ts");
  await checkAsync("15.17 西医核对带上诊断标准要点：表里没有的病名现场检索（只用病名、权威度≥3、相关度≥1.5），摘要进核对模型的输入；检索失败照常核对；关掉开关不检索（对照）", async () => {
    const savedFetch = globalThis.fetch;
    const requests = [];
    const completion = (payload) => new Response(JSON.stringify({ id: "t", object: "chat.completion", model: "deepseek-flash",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { "content-type": "application/json" } });
    const name = "测试用罕见综合征甲";
    try {
      globalThis.fetch = async (url, init) => {
        const target = String(url);
        requests.push({ target, body: String(init?.body || "") });
        if (target.endsWith("/v1/tools/search")) {
          return new Response(JSON.stringify({ results: [
            { title: `${name}诊断标准`, url: "https://www.msdmanuals.cn/x", site_name: "默沙东诊疗手册", summary: "确诊需要基因检测，单凭临床表现不能诊断。".repeat(4), authority: 4, rerank_score: 2.1 },
            { title: "论坛帖子", url: "https://bbs.example.com/1", site_name: "论坛", summary: "随便说说".repeat(20), authority: 1, rerank_score: 2.5 },
            { title: "相关度低的权威页", url: "https://www.example.gov.cn/2", site_name: "某卫健委", summary: "与本病关系不大的内容。".repeat(10), authority: 4, rerank_score: 1.0 },
          ] }), { headers: { "content-type": "application/json" } });
        }
        return completion({ verdict: "consistent", type: "", quote: "", reason: "", supportedName: "" });
      };
      const reference = await criteria.westernCriteriaReference(name);
      assert.equal(reference?.kind, "search");
      assert.equal(reference.excerpts.length, 1, "权威度不够、相关度不够的两条都不进");
      const search = requests.find((item) => item.target.endsWith("/v1/tools/search"));
      assert.ok(search, "表里没有时现场检索");
      assert.equal(JSON.parse(search.body).query, `${name} 诊断标准`, "查询词只有病名");
      requests.length = 0;
      await westernCheck.westernNameCorrectionForRecord({ recordText: "乏力1月。", diagnosisName: name });
      const chat = requests.find((item) => item.target.endsWith("/chat/completions"));
      assert.match(JSON.parse(chat.body).messages[1].content, /默沙东诊疗手册/, "摘要进了核对模型的输入");
      assert.doesNotMatch(requests.filter((item) => item.target.endsWith("/v1/tools/search")).map((item) => item.body).join(""), /乏力/, "病历内容不进查询");
      process.env.CDSS_WEB_SEARCH = "false";
      requests.length = 0;
      assert.equal(await criteria.westernCriteriaReference("测试用罕见综合征乙"), undefined);
      assert.equal(requests.length, 0, "关掉开关不检索");
    } finally {
      delete process.env.CDSS_WEB_SEARCH;
      globalThis.fetch = savedFetch;
    }
  });
}

{
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  const run = (diet, precautions, cards = []) => {
    const out = projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {}, formula: { candidates: [{ name: "消风散加减", herbs: [] }] },
      nonPharma: { diet, precautions, acupointCare: null, tcmTreatments: cards } });
    return { diet: out.nonPharma.diet, cards: out.nonPharma.tcmTreatments.map((card) => card.projectCode) };
  };
  check("15.18 饮食自相矛盾：忌鱼虾又推荐清蒸鱼时去掉推荐那半句；忌海鲜发物而食疗卡是海鲜粥时不出这张卡；没点名的、鱼腥草不算（对照）", () => {
    assert.equal(run("饮食清淡，忌鱼虾、辛辣，可食清蒸鱼、冬瓜汤。", ["忌食鱼虾等发物。"]).diet, "饮食清淡，忌鱼虾、辛辣。");
    assert.deepEqual(run("宜清淡，忌辛辣。", ["服药期间忌食海鲜发物。"], [{ projectCode: "diet_therapy", treatmentContent: "海鲜粥：虾仁、粳米" }, { projectCode: "acupuncture", treatmentContent: "取穴" }]).cards, ["acupuncture"]);
    assert.equal(run("饮食清淡，可食冬瓜、绿豆汤。", ["忌食鱼虾等发物。"]).diet, "饮食清淡，可食冬瓜、绿豆汤。");
    assert.equal(run("宜清淡，可用鱼腥草煮水代茶。", ["服药期间忌食鱼虾。"]).diet, "宜清淡，可用鱼腥草煮水代茶。");
  });
}
{
  const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
  check("15.19 锚定教材治法时留下模型写的主症方向一句：「滋阴养血」+「养血和络止痛」→「滋阴养血，和络止痛」（病历3）；教材治法已有「止」、模型没有这一句时不动（对照）", () => {
    assert.equal(provenance.withSymptomDirectedClause("滋阴养血", "养血和络止痛"), "滋阴养血，和络止痛");
    assert.equal(provenance.withSymptomDirectedClause("疏散风寒止痛", "疏风散寒，通络止痛"), "疏散风寒止痛");
    assert.equal(provenance.withSymptomDirectedClause("滋阴养血", "养血滋阴"), "滋阴养血");
    const out = provenance.withDeterministicFormulaReferences({ stage: "diagnose", overview: { tcmDiseaseName: "头痛", primarySyndrome: "血虚头痛证", secondarySyndromes: [], recommendedFormulaDirection: "加味四物汤加减" }, therapy: { overallMethod: "养血和络止痛" }, pathogenesis: { chain: [] } });
    assert.equal(out.therapy.overallMethod, "滋阴养血，和络止痛");
  });
}
{
  const plan = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
  check("15.20 写饮食栏的本证参考：对上《中医食疗学》分证时给食疗原则与药食同源食材（不含酒）；对不上分证时为空（对照）", () => {
    const section = plan.textbookDietPromptSection({ diseaseNames: ["感冒"], westernNames: [], signedSyndromeText: "风寒束表证" });
    assert.match(section, /辛温解表/);
    assert.match(section, /葱白|红糖|苏叶/);
    assert.doesNotMatch(section, /黄酒/);
    assert.match(section, /不要默认写小米粥/);
    assert.equal(plan.textbookDietPromptSection({ diseaseNames: ["感冒"], westernNames: [], signedSyndromeText: "痰火扰心证" }), "");
  });
}
check("15.21 提示词原则：追问题干只问一件事；急症筛查可答性核对里主诉本身那一项不计；写饮食栏不要每例都写小米粥", () => {
  const prompts = readFileSync("src/lib/diagnosis-prompts.ts", "utf8");
  assert.match(prompts, /题干只问一件事/);
  assert.match(prompts, /不要每例都写小米粥、山药粥/);
  assert.match(readFileSync("src/lib/m02-risk-question-answerability.server.ts", "utf8"), /正是本次主诉或就诊原因本身的那一项/);
});

{
  const { requiredPrecautionsForCase } = await jiti.import("../src/lib/required-precautions.server.ts");
  const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  check("15.22 正在服用的药（既往史里的长期用药也算）列为必写项；没写药名的「规律服药」不算；已写到的不补（对照）", () => {
    const state = (history) => normalizeCaseStateInput({ id: "med", chiefComplaint: "头晕1周", patient: { sex: "男", age: 50 }, symptoms: { 现病史: "头晕1周。", 既往史: history }, conversation: [] });
    const items = requiredPrecautionsForCase(state("高血压10年，规律口服苯磺酸氨氯地平片5mg每日1次。"));
    assert.equal(items.find((item) => item.kind === "current_medications")?.names[0], "苯磺酸氨氯地平片");
    assert.equal(requiredPrecautionsForCase(state("高血压10年，规律服药。")).length, 0);
    const out = (precautions) => projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {}, formula: { candidates: [{ name: "天麻钩藤饮加减", herbs: [] }] },
      nonPharma: { precautions, acupointCare: null, tcmTreatments: [] } }, { requiredPrecautions: items }).nonPharma.precautions;
    assert.match(out(["饮食宜清淡。"])[0], /苯磺酸氨氯地平片.*告知医生/);
    assert.equal(out(["正在服用的降压药请继续按时服用并告知医生。"]).length, 1);
  });
  check("15.23 方中有药典标注有毒的药（附子、半夏、苦杏仁）而注意事项没提时补一句；已提到的、没有有毒药的不补（对照）", () => {
    const out = (herbs, precautions) => projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {}, formula: { candidates: [{ name: "四逆汤加减", herbs: herbs.map((name) => ({ name, dose: "9g" })) }] },
      nonPharma: { precautions, acupointCare: null, tcmTreatments: [] } }).nonPharma.precautions;
    assert.match(out(["附子", "干姜", "炙甘草"], ["饮食宜温。"]).at(-1), /附子在药典中标注有毒/);
    assert.equal(out(["附子", "干姜", "炙甘草"], ["附子须先煎1小时，有毒，不可加量。"]).length, 1);
    assert.equal(out(["干姜", "炙甘草"], ["饮食宜温。"]).length, 1);
  });
}
check("15.24 兼证口径写进辨证提示词：独立于主证、成组出现（含定性表现）的另一组表现立兼证；依据里写了兼夹而兼证栏为空不允许", () => {
  const prompts = readFileSync("src/lib/diagnosis-prompts.ts", "utf8");
  assert.match(prompts, /独立于主证、成组出现/);
  assert.match(prompts, /不得依据里写了兼夹而兼证栏为空/);
});

{
  const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
  const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
  const gate = (text) => safety.withSafetyGate(normalizeCaseStateInput({ id: "t3", chiefComplaint: "", patient: { sex: "女", age: 40 }, symptoms: { 现病史: text }, conversation: [] })).safetyGate;
  check("15.25 「T」后接化验单位不是体温（A 集：甲功「T32.0nmol/L」被读成体温 32℃）；「T 34.8」「体温32℃」照报低体温（对照）", () => {
    assert.equal(gate("心率91次/分，T32.0nmol/L（正常值为1.73~3nmol/L），T4100nmol/L。").redFlags.length, 0);
    assert.match(gate("T 34.8，嗜睡。").redFlags.join(""), /低体温/);
    assert.match(gate("体温32℃，嗜睡。").redFlags.join(""), /低体温/);
    assert.equal(gate("T 36.5℃，P 80次/分。").redFlags.length, 0);
  });
}
{
  const { renderM04DeliveryCheckpoint } = await jiti.import("../src/lib/m04-delivery-checkpoint.ts");
  check("15.26 不给剂量页照常列出处与随证加减（加减只写条件与药名，剂量被掩码）；没有加减时不出这一节（对照）", () => {
    const reasoning = (modifications) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
      formula: { candidates: [{ name: "逍遥散加减", formulaSource: { source: "逍遥散：《太平惠民和剂局方》" }, herbs: [{ name: "柴胡", role: "君", function: "疏肝解郁", dose: "10g" }], formulaAnalysis: "柴胡疏肝解郁为君。" }], modifications }, nonPharma: null });
    const page = renderM04DeliveryCheckpoint({ content: "", reasoning: reasoning([{ trigger: "若胁痛较甚", action: "add", herbName: "郁金", doseOrHandling: "10g", reason: "行气活血止痛" }]), payloadHash: "x" }, undefined, "dose_withheld", ["红旗未解除"]);
    assert.match(page, /出处：《太平惠民和剂局方》/);
    assert.match(page, /## 随证加减（未给剂量）/);
    assert.match(page, /若胁痛较甚：加郁金（行气活血止痛）/);
    assert.doesNotMatch(page.split("## 随证加减")[1] || "", /10g/);
    const none = renderM04DeliveryCheckpoint({ content: "", reasoning: reasoning([]), payloadHash: "x" }, undefined, "dose_withheld", ["红旗未解除"]);
    assert.doesNotMatch(none, /随证加减/);
  });
}

{
  const contract = await jiti.import("../src/lib/m02-question-contract.ts");
  check("15.27 「无需追问」要病历够：舌脉都有或寒热口渴二便汗记录了三项才 proceed；只有「刚发烧、流鼻涕」时照常出一题（IMCS-21 问诊集）；开关关掉时一律不 proceed（对照）", () => {
    const saved = process.env.CDSS_M02_PROCEED_WHEN_SETTLED;
    try {
      process.env.CDSS_M02_PROCEED_WHEN_SETTLED = "true";
      assert.equal(contract.m02ProceedWhenSettled("宝宝刚发烧，今天流鼻涕。"), false);
      assert.equal(contract.m02ProceedWhenSettled("恶寒发热2天，无汗，口不渴，大便调，舌淡红苔薄白，脉浮紧。"), true);
      assert.equal(contract.m02ProceedWhenSettled("怕冷，口不渴，大便溏，夜间盗汗。"), true);
      assert.equal(contract.m02ProceedWhenSettled(), true, "不给病历时（红旗处置题）只看开关");
      process.env.CDSS_M02_PROCEED_WHEN_SETTLED = "false";
      assert.equal(contract.m02ProceedWhenSettled("恶寒发热2天，无汗，口不渴，大便调，舌淡红苔薄白，脉浮紧。"), false);
    } finally {
      if (saved === undefined) delete process.env.CDSS_M02_PROCEED_WHEN_SETTLED; else process.env.CDSS_M02_PROCEED_WHEN_SETTLED = saved;
    }
  });
}

// ───── 16 终版验收（10/18）暴露的西医诊断两类服务端缺陷 ─────
{
  const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  const wrap = (name) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", westernDiagnosis: { primary: { name, supportingFacts: ["咳嗽、咳痰"], suggestedChecks: [] }, differentials: [] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
  const primaryName = (content) => JSON.parse(content.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]).westernDiagnosis.primary.name;
  check("16.1 慢性支气管炎的病程门槛按数字读：「5年，近3年每年持续3~4个月」够（X-D-0124）；「每年冬季发作，持续3个月以上，已10余年」够；病程1年余、每年1~2个月不够（对照）", () => {
    const met = [
      "主诉：咳嗽、咳痰5年\n现病史：咳嗽、咳痰5年，近3年每年持续咳嗽、咳痰3~4个月。",
      "主诉：反复咳嗽咳痰10余年\n现病史：反复咳嗽咳痰10余年，每年冬季发作，持续3个月以上。",
      "主诉：咳嗽咳痰喘息\n现病史：咳嗽、咳痰十年，每年发作持续三四个月不等。",
    ];
    for (const context of met) assert.equal(primaryName(visible.declassifyUnmetFormalM03WesternPrimary(wrap("慢性支气管炎"), context)), "慢性支气管炎", context);
    const unmet = [
      "主诉：咳嗽咳痰1年余\n现病史：咳嗽咳痰1年余，每年持续3个月。",
      "主诉：咳嗽咳痰10年\n现病史：咳嗽咳痰10年，每年咳嗽1~2个月。",
    ];
    for (const context of unmet) assert.notEqual(primaryName(visible.declassifyUnmetFormalM03WesternPrimary(wrap("慢性支气管炎"), context)), "慢性支气管炎", context);
  });
  const westernCheck = await jiti.import("../src/lib/western-name-evidence-check.server.ts");
  const record = "主诉：腰痛2个月，右下肢活动困难1周\n现病史：男，50岁，腰痛2个月，近1周右下肢活动困难，外院诊断坐骨神经痛。查体：贫血貌。";
  const verdict = (extra) => JSON.stringify({ verdict: "inconsistent", type: "D", quote: "腰痛2个月", reason: "尚未行骨髓穿刺与M蛋白检查", ...extra });
  check("16.2 情形 D 指不出更宽的病名时留住首要考虑：「多发性骨髓瘤」→「多发性骨髓瘤待查」，候选首位改名、鉴别不重复列它（X-D-4595 曾成「主要症状＋待查」，X-D-2054 成「腹胀」）", () => {
    for (const supportedName of ["腰痛待查", "多发性骨髓瘤待查"]) {
      const correction = westernCheck.parseWesternNameCorrection(verdict({ supportedName }), record, "多发性骨髓瘤");
      assert.equal(correction?.supportedName, "多发性骨髓瘤待查", supportedName);
      const western = { westernDiagnosis: { primary: { name: "多发性骨髓瘤" }, differentials: [{ name: "脊柱转移瘤", reason: "需排除" }], candidates: [{ name: "多发性骨髓瘤", likelihood: "中" }, { name: "脊柱转移瘤", likelihood: "低" }] } };
      const out = JSON.parse(westernCheck.applyWesternNameCorrection(JSON.stringify(western), correction)).westernDiagnosis;
      assert.equal(out.primary.name, "多发性骨髓瘤待查");
      assert.deepEqual(out.candidates.map((item) => item.name), ["多发性骨髓瘤待查", "脊柱转移瘤"]);
      assert.deepEqual(out.differentials.map((item) => item.name), ["脊柱转移瘤"]);
    }
  });
  check("16.3 提示词格式词照抄成的病名不采信（「主要症状＋待查」）；A–C 类症状待查照常（对照）；D 类有更宽病名时照常用它（对照）", () => {
    assert.equal(westernCheck.parseWesternNameCorrection(verdict({ type: "B", supportedName: "主要症状＋待查" }), record, "多发性骨髓瘤"), undefined);
    assert.equal(westernCheck.parseWesternNameCorrection(verdict({ type: "B", supportedName: "腰痛待查" }), record, "多发性骨髓瘤")?.supportedName, "腰痛待查");
    assert.equal(westernCheck.parseWesternNameCorrection(verdict({ supportedName: "贫血" }), record, "缺铁性贫血")?.supportedName, "贫血");
  });
}

{
  const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
  const id = (text) => provenance.identifyKnownFormulaNames(text);
  check("16.4 教材方名整体是一个方：目录里没有的教材方不在里面认出更短的别的方（栝蒌薤白半夏汤≠半夏汤，验收集 M 8 次锁错）；瓜蒌三种写法、丸散方作汤剂按同一首认；合方、已收录方照常（对照）", () => {
    assert.deepEqual(id("栝蒌薤白半夏汤合涤痰汤加减"), ["瓜蒌薤白半夏汤", "涤痰汤"]);
    assert.deepEqual(id("二地鳖甲煎"), []);
    assert.deepEqual(id("柴枳半夏汤"), []);
    assert.deepEqual(id("瓜蒌牛蒡汤"), ["栝楼牛蒡汤"]);
    assert.deepEqual(id("大黄白茅根汤"), []);
    assert.deepEqual(id("首选知柏地黄汤加减"), ["知柏地黄丸"]);
    assert.deepEqual(id("杞菊地黄汤"), ["杞菊地黄丸"]);
    assert.deepEqual(id("瓜蒌薤白白酒汤"), ["栝楼薤白白酒汤"]);
    assert.deepEqual(id("半夏汤"), ["半夏汤"]);
    assert.deepEqual(id("鳖甲煎丸"), ["鳖甲煎丸"]);
    assert.deepEqual(id("温胆汤合半夏泻心汤"), ["温胆汤", "半夏泻心汤"]);
    assert.deepEqual(id("驱虫粉合参苓白术散"), ["参苓白术散"]);
  });
}

{
  const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  const record = "主诉：腹痛腹泻间作两年，又作七天\n现病史：入院时患者：腹痛偶作，无肩背部放射痛，腹泻，大便日行1-2次，色黄欠成形，无粘液脓血，反酸偶作，无明显嗳气及胸骨后烧灼感，无头晕，无畏寒发热，无胸闷气喘，食纳欠佳，夜寐安，小便尚调。\n体格检查：颈部对称，无青筋暴露，无瘿瘤瘰疬，胸部对称，腹部平坦，无癥瘕痞块，舌淡苔白，脉细。";
  const chain = (nodes) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", pathogenesis: { chain: nodes.map(([patientFact, syndromeEvidence]) => ({ patientFact, syndromeEvidence, pathogenesis: "脾虚湿盛", therapyDirection: "健脾化湿" })) } })}\n<!-- DIAGNOSIS_JSON_END -->`;
  const kept = (content) => JSON.parse(visible.groundStructuredPatientFacts(content, record).split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]).pathogenesis.chain.length;
  check("16.5 逐项写否认的句子里，否认不跨逗号继承：「无牵扯痛，反酸偶作，无头晕…食纳欠佳」里没写「无」的是阳性，引这些原文的病机链节点照常接地（M-TCM-SD-422604 整条链被丢、M03 退回占位；语料 52,207 句 1,062 句改判、读过的全部是阳性被误读成「无…」：舌脉、纳眠、乏力、口干口苦…）；只有一个否认词的句子、顿号列举照旧继承（对照）", () => {
    assert.equal(kept(chain([["反酸偶作", "食纳欠佳"], ["食纳欠佳", "舌淡苔白，脉细"]])), 2);
    const single = "主诉：咳嗽\n现病史：否认高血压，糖尿病病史。";
    const singleKept = JSON.parse(visible.groundStructuredPatientFacts(chain([["糖尿病病史", "咳嗽"]]), single).split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]).pathogenesis.chain.length;
    assert.equal(singleKept, 0, "只有一个否认词时，逗号后的「糖尿病病史」仍按否认处理");
    const enumerated = "主诉：胃痛\n现病史：胃痛3天，无恶心、呕吐，无发热。";
    const enumeratedKept = JSON.parse(visible.groundStructuredPatientFacts(chain([["呕吐", "胃痛3天"]]), enumerated).split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]).pathogenesis.chain.length;
    assert.equal(enumeratedKept, 0, "顿号列举「无恶心、呕吐」里的呕吐仍是否认");
  });
}
{
  const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  check("16.17 辨证推断里的「示无里热」「提示里无湿热积滞」「里和无损」不改成「未诉…」（甲方病历 1/3/9 三次生成都出现「示未诉里热」）；与相邻病证区分的「无里急后重」仍改（对照）", () => {
    const record = "咳嗽3天，恶寒发热，无汗，舌淡红苔薄白，脉浮紧。小便清长。";
    for (const text of ["饮食二便尚可为里和无损之佐证。", "小便清长示无里热。", "二便尚调提示里无湿热积滞，故不属胃肠湿热。"]) {
      assert.equal(visible.unrecordedNegativesAsNotReported(text, record), text);
    }
    assert.equal(visible.unrecordedNegativesAsNotReported("无里急后重，与痢疾相区分", record), "未诉里急后重，与痢疾相区分");
  });
  const plan = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
  check("16.20 项目卡上的孕哺字样只写给可能属于这些人群的患者（甲方病历 2/4/6/8 男性，耳穴卡「妊娠期慎用」、针刺必查项「妊娠相关穴位」）；点了穴名的注意句所点穴都不在本卡上时不留（病历 6 腰痛卡「膏肓、肺俞、膈俞…避免气胸」）；育龄女性与本卡有该穴的照留（对照）", () => {
    assert.equal(plan.cardTextForPopulation("耳廓皮肤破溃、冻疮、感染或过敏时禁用，妊娠期慎用", false), "耳廓皮肤破溃、冻疮、感染或过敏时禁用。");
    assert.equal(plan.cardTextForPopulation("出血倾向、抗凝用药、妊娠相关穴位、局部感染和晕针史", false), "出血倾向、抗凝用药、局部感染和晕针史");
    assert.equal(plan.cardTextForPopulation("耳廓皮肤破溃时禁用，妊娠期慎用", true), "耳廓皮肤破溃时禁用，妊娠期慎用");
    assert.doesNotMatch(plan.cardSentencesNamingListedPoints("毫针常规刺。禁忌：膏肓、肺俞、膈俞等穴局部肌肉薄，须规范操作避免气胸。", ["肾俞", "委中", "腰阳关"]), /气胸/);
    assert.match(plan.cardSentencesNamingListedPoints("毫针常规刺。禁忌：肺俞等穴不宜深刺，避免气胸。", ["肺俞", "尺泽"]), /气胸/);
    assert.match(plan.cardSentencesNamingListedPoints("毫针常规刺。注意针刺深度，避免晕针。", ["肾俞"]), /晕针/, "没点穴名的注意句照留");
  });
  check("16.18 两字阴性项在病历里隔着修饰写到过（「腹中冷痛」对「无腹痛」）不改成「未诉腹痛」（留出例 S058）；中间隔标点的不算写到过（对照）", () => {
    assert.equal(visible.unrecordedNegativesAsNotReported("否认呕吐；无腹痛，与肠结相区分", "排便困难2年，腹中冷痛、热敷后舒服。"), "否认呕吐；无腹痛，与肠结相区分");
    assert.equal(visible.unrecordedNegativesAsNotReported("无腹痛，与肠结相区分", "排便困难2年，腹胀，偶有头痛。"), "未诉腹痛，与肠结相区分");
  });
}

{
  const surface = await jiti.import("../src/lib/delivered-surface.ts");
  check("16.6 药味功效栏里知识库与核对词典都不给的说法去掉（桔梗「载药下行」、益智「益气」；益智的知识库功用经教材核对剔除益气、安神），有依据的照留；整栏没依据时换成知识库功效短语（对照：当归「补血活血」不动）", () => {
    const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "缩泉丸加减", decoction: { method: "水煎服" }, herbs: [
      { name: "桔梗", role: "使", function: "宣肺利咽，载药下行", dose: "6g" },
      { name: "益智仁", role: "君", function: "温脾止泻，益气", dose: "10g" },
      { name: "当归", role: "臣", function: "补血活血", dose: "10g" },
      { name: "益智", role: "佐", function: "益气", dose: "10g" },
    ] }] } };
    const out = surface.projectDeliveredReasoning(structuredClone(reasoning));
    const fn = Object.fromEntries(out.formula.candidates[0].herbs.map((herb) => [herb.name, herb.function]));
    assert.equal(fn["桔梗"], "宣肺利咽");
    assert.equal(fn["益智仁"], "温脾止泻");
    assert.equal(fn["当归"], "补血活血");
    assert.ok(fn["益智"] && !/益气/.test(fn["益智"]), fn["益智"]);
  });
  check("16.16 去掉无依据的词后剩下的半句不成功效的整句去掉（甲方病历 6 川牛膝「补益肝肾，强健腰膝」曾成「肝肾，强健腰膝」）；字序不同的重复句只留一句；青蒿不再标「疏风清热」（知识库本草辑录，教材「清虚热，除骨蒸，解暑热，截疟，退黄」）；当归「补血行气」仍留「补血」（对照）", () => {
    const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "独活寄生汤加减", decoction: { method: "水煎服" }, herbs: [
      { name: "川牛膝", role: "佐", function: "补益肝肾，强健腰膝", dose: "10g" },
      { name: "熟地黄", role: "臣", function: "滋阴补血，补血滋阴", dose: "12g" },
      { name: "当归", role: "佐", function: "补血行气", dose: "6g" },
      { name: "青蒿", role: "佐", function: "疏风清热", dose: "10g" },
    ] }] } };
    const out = surface.projectDeliveredReasoning(structuredClone(reasoning));
    const fn = Object.fromEntries(out.formula.candidates[0].herbs.map((herb) => [herb.name, herb.function]));
    assert.ok(!/(?:^|，)肝肾/.test(fn["川牛膝"]), fn["川牛膝"]);
    assert.equal(fn["熟地黄"].split("，").length, 1, fn["熟地黄"]);
    assert.equal(fn["当归"], "补血");
    assert.doesNotMatch(fn["青蒿"], /疏风/, fn["青蒿"]);
  });
  check("16.19 方义点名去掉的药其实在处方里（「去桑皮之重复而留其泻肺之意」，桑白皮在方中，留出例 S151）去掉这一小句；「二药相合」前一句只点了一味药时也重数（S145）；真去掉的药（方中没有）照留（对照）", () => {
    const build = (analysis, herbs) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "清金化痰汤加减", decoction: { method: "水煎服" }, formulaAnalysis: analysis, herbs: herbs.map((name) => ({ name, role: "臣", function: "清热化痰", dose: "10g" })) }] } });
    const project = (analysis, herbs) => surface.projectDeliveredReasoning(structuredClone(build(analysis, herbs))).formula.candidates[0].formulaAnalysis;
    const s151 = project("本方以清金化痰汤为基础加减，去桑皮之重复而留其泻肺之意，以黄芩为君直清肺中痰热。", ["黄芩", "桑白皮", "川贝母", "桔梗"]);
    assert.doesNotMatch(s151, /去桑皮/, s151);
    assert.match(s151, /以黄芩为君/);
    const kept = project("本方以清金化痰汤为基础加减，去知母之滋腻，以黄芩为君直清肺中痰热。", ["黄芩", "桑白皮", "川贝母", "桔梗"]);
    assert.match(kept, /去知母之滋腻/, kept);
    const s145 = project("黄柏苦寒沉降，专清下焦湿热；二药相合为本方之核心，直解关节红肿灼痛。", ["黄柏", "薏苡仁", "防己"]);
    assert.doesNotMatch(s145, /二药/, s145);
  });
}

{
  const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
  const types = await jiti.import("../src/lib/diagnosis-types.ts");
  const permit = (age, chiefComplaint, body) => safety.derivePrescriptionPermission(safety.withSafetyGate(types.normalizeCaseStateInput({ id: "x", chiefComplaint, symptoms: { 现病史: body }, conversation: [], patient: { sex: "男", age } })));
  check("16.7 病历写「患儿，8个月」「男婴，3个月」「6岁患儿」而登记年龄是成人：不按成人给剂量，先核实年龄（验收集 X-G-1792 8个月患儿生地黄12g）；他人年龄、病程「3个月」、年龄一致的婴儿照常（对照）", () => {
    for (const [chief, body] of [["患儿，8个月", "腹泻2天。"], ["腹泻2天", "男婴，3个月，腹泻2天。"], ["头痛", "6岁患儿，头痛2天。"]]) {
      const permission = permit(45, chief, body);
      assert.equal(permission.candidateMode, "non_dose_only", `${chief}｜${body}`);
      assert.ok(permission.reasons.some((reason) => /患儿年龄与登记年龄不一致/.test(reason)));
    }
    assert.notEqual(permit(45, "咳嗽", "其子5岁，患者咳嗽3天。").candidateMode, "non_dose_only");
    assert.notEqual(permit(45, "腹痛", "腹痛3个月。").candidateMode, "non_dose_only");
    assert.ok(!(permit("8个月", "腹泻", "患儿，8个月，腹泻2天。").reasons || []).some((reason) => /登记年龄不一致/.test(reason)));
  });
}

{
  const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  check("16.8 病历没写到的「无X」改「未诉X」时，「写到过」要首尾两字挨着出现：「言语清晰，小便不利」不算写到过「言语不利」（验收集 M 中医鉴别「无言语不利」「无口舌歪斜」）；「无恶寒发热」对「发热恶寒」两字互换仍算；未诉项只并相邻的，中间隔着「无X」的不并；「无…结果」不改（对照）", () => {
    const record = "主诉：头晕3天\n现病史：头晕，言语清晰，小便不利，无恶寒发热，无头痛头晕。";
    assert.equal(visible.unrecordedNegativesAsNotReported("无言语不利，与中风相区分。", record), "未诉言语不利，与中风相区分。");
    assert.equal(visible.unrecordedNegativesAsNotReported("无发热恶寒。", record), "无发热恶寒。");
    assert.equal(visible.unrecordedNegativesAsNotReported("无小便不利。", record), "无小便不利。");
    assert.equal(visible.unrecordedNegativesAsNotReported("未诉口苦、无头痛头晕、无胸脘痞闷。", record), "未诉口苦、无头痛头晕、未诉胸脘痞闷。");
    assert.equal(visible.unrecordedNegativesAsNotReported("无口苦、无胸脘痞闷。", record), "未诉口苦、胸脘痞闷。");
    assert.equal(visible.unrecordedNegativesAsNotReported("但无发作时心电图结果。", record), "但无发作时心电图结果。");
  });
}

{
  process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = "acupuncture,moxibustion,cupping,guasha,auricular,tuina,diet_therapy,qigong_daoyin,mind_therapy";
  const treatments = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
  const evidence = { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" };
  const prior = (disease, syndrome, method, fact) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", contractSignatureVersion: "tcm-cdss-m03-signature-v5", contractSignature: `hmac-sha256:${"a".repeat(64)}`,
    overview: { tcmDiseaseName: disease, primarySyndrome: syndrome, secondarySyndromes: [], overallPathogenesis: method, overallTherapy: method, evidence },
    westernDiagnosis: { primary: { name: "症状性问题", status: "证据有限", confidence: "低", supportingFacts: [], evidence }, differentials: [] },
    pathogenesis: { summary: method, locationDifferentiation: { items: [], evidence }, natureDifferentiation: { items: [], evidence }, chain: [{ nodeId: "P1", patientFact: fact, syndromeEvidence: fact, pathogenesis: method, therapyDirection: method, evidence }], uncertainties: [] },
    therapy: { overallPrinciple: method, overallMethod: method, subTherapies: [{ therapy: method, targetPathogenesis: method, priority: "主要", evidence }] }, formula: null, nonPharma: null, lineageAdaptation: null });
  const caseOf = (chief, present) => ({ patient: { sex: "男", age: 50 }, chiefComplaint: chief, symptoms: { presentHistory: present }, vitals: {}, conversation: [], safetyGate: { status: "ready", allowDosePrescription: true, redFlags: [], missingItems: [] } });
  const card = (code, args, chief) => treatments.compileTcmTreatmentRecommendations([{ projectCode: code, targetRef: "P1" }], prior(...args), caseOf(chief, args[3])).find((item) => item.projectCode === code);
  check("16.9 本病没有教材方案、目录模板是按顺带症状对上的：不给那张模板的穴位，落到评估态（奔豚伴失眠多梦曾给失眠耳穴；验收集 H：呃逆给失眠取穴、痿证给头痛取穴）；本病有教材方案的照常（对照：噎膈食疗）", () => {
    const auricular = card("auricular", ["奔豚", "肝郁化热证", "疏肝清热，降逆平冲", "气从少腹上冲胸咽，失眠多梦"], "气上冲感1月");
    assert.equal(auricular.protocolStatus, "assessment_only_no_patient_specific_protocol");
    assert.ok(!(auricular.suggestedSitesOrPoints || []).some((point) => /神门|皮质下/.test(String(point))), JSON.stringify(auricular.suggestedSitesOrPoints));
    const diet = card("diet_therapy", ["噎膈", "痰气交阻证", "开郁化痰，润燥降气", "吞咽梗阻，失眠多梦"], "吞咽不畅3月");
    assert.equal(diet.protocolStatus, "governed_patient_specific_plan");
  });
  check("16.10 皮损在面部（鼻旁、唇周…）时不写「皮损局部三棱针散刺出血」（危险三角区；验收集 H-tri-17402）；皮损在小腿照常（对照）", () => {
    const face = card("acupuncture", ["丹毒", "风热毒蕴证", "疏风清热解毒", "面部鼻旁皮肤红肿热痛"], "面部红肿2天");
    assert.doesNotMatch(face.techniqueBoundary, /散刺出血/);
    const leg = card("acupuncture", ["丹毒", "湿热毒蕴证", "清热利湿解毒", "小腿皮肤红肿热痛"], "小腿红肿2天");
    assert.match(leg.techniqueBoundary, /皮损局部用三棱针散刺出血/);
  });
}

{
  const surface = await jiti.import("../src/lib/delivered-surface.ts");
  const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
  const western = await jiti.import("../src/lib/western-name-evidence-check.server.ts");
  process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = "acupuncture,moxibustion,cupping,guasha,auricular,tuina,diet_therapy,qigong_daoyin,mind_therapy";
  const treatments = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
  const evidence = { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" };
  const prior = (disease, syndrome, method, fact) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", contractSignatureVersion: "tcm-cdss-m03-signature-v5", contractSignature: `hmac-sha256:${"a".repeat(64)}`,
    overview: { tcmDiseaseName: disease, primarySyndrome: syndrome, secondarySyndromes: [], overallPathogenesis: method, overallTherapy: method, evidence },
    westernDiagnosis: { primary: { name: "症状性问题", status: "证据有限", confidence: "低", supportingFacts: [], evidence }, differentials: [] },
    pathogenesis: { summary: method, locationDifferentiation: { items: [], evidence }, natureDifferentiation: { items: [], evidence }, chain: [{ nodeId: "P1", patientFact: fact, syndromeEvidence: fact, pathogenesis: method, therapyDirection: method, evidence }], uncertainties: [] },
    therapy: { overallPrinciple: method, overallMethod: method, subTherapies: [{ therapy: method, targetPathogenesis: method, priority: "主要", evidence }] }, formula: null, nonPharma: null, lineageAdaptation: null });
  const caseOf = (chief, present) => ({ patient: { sex: "女", age: 62 }, chiefComplaint: chief, symptoms: { presentHistory: present }, vitals: {}, conversation: [], safetyGate: { status: "ready", allowDosePrescription: true, redFlags: [], missingItems: [] } });
  const rx = (candidate, nonPharma = null) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [candidate] }, nonPharma });
  check("16.11 交付面：「二药」前只点到一味本方药时去掉数量词（留出集 S145）；功效栏占位句换知识库功效（赤小豆）；卡片里系统讲自己不输出什么的半句去掉（甲方病历 3「不输出进针方向和深度」）", () => {
    const out = surface.projectDeliveredReasoning(rx({ name: "宣痹汤加减", formulaAnalysis: "黄柏苦寒清下焦湿热，二药相合清利湿热，共为君；黄芪补气，当归养血，二药相合气血双补。", herbs: [{ name: "黄柏", role: "君", function: "清热燥湿", dose: "10g" }, { name: "黄芪", role: "臣", function: "补气", dose: "15g" }, { name: "当归", role: "臣", function: "补血活血", dose: "10g" }, { name: "赤小豆", role: "佐", function: "佐药，本方中的具体配伍作用需医生结合方义复核", dose: "15g" }] },
      { tcmTreatments: [{ projectCode: "acupuncture", techniqueBoundary: "外伤后头痛先行急诊评估；不输出进针方向和深度。", scheduleSuggestion: "每日1次。" }] }));
    const candidate = out.formula.candidates[0];
    assert.equal(candidate.formulaAnalysis, "黄柏苦寒清下焦湿热，清利湿热，共为君；黄芪补气，当归养血，二药相合气血双补。");
    assert.equal(candidate.herbs[3].function, "利水消肿");
    assert.doesNotMatch(out.nonPharma.tcmTreatments[0].techniqueBoundary, /不输出/);
  });
  check("16.12 方义里「木香行气散结」不当成方名「木香行气散」换掉（留出集 S067 曾成「本方结」）；真写方名的照常识别（对照）", () => {
    assert.deepEqual(provenance.identifyKnownFormulaNames("木香行气散结，缓解腰腹绞痛"), []);
    assert.deepEqual(provenance.identifyKnownFormulaNames("方用逍遥散加减"), ["逍遥散"]);
  });
  check("16.13 纯虚证不出拔罐/刮痧卡（甲方病历 6 肾阴虚腰痛三次都给了走罐）；肾虚腰痛不套《腰椎间盘突出症》方案的频次；寒湿腰痛照常（对照）", () => {
    const deficient = treatments.compileTcmTreatmentRecommendations([{ projectCode: "cupping", targetRef: "P1" }, { projectCode: "acupuncture", targetRef: "P1" }], prior("腰痛", "肾阴虚证", "滋补肾阴", "腰部酸痛，腰膝酸软"), caseOf("腰痛3月", "腰部酸痛，腰膝酸软"));
    assert.ok(!deficient.some((card) => card.projectCode === "cupping"));
    const needle = deficient.find((card) => card.projectCode === "acupuncture");
    assert.doesNotMatch(`${needle?.scheduleSuggestion || ""}${needle?.protocolSource || ""}`, /腰椎间盘突出症/);
    const cold = treatments.compileTcmTreatmentRecommendations([{ projectCode: "cupping", targetRef: "P1" }], prior("腰痛", "寒湿腰痛证", "散寒行湿，温经通络", "腰部冷痛重着"), caseOf("腰痛1周", "腰部冷痛重着，遇寒加重"));
    assert.ok(cold.some((card) => card.projectCode === "cupping"));
  });
  check("16.14 注意事项：正在用的药不写「不要自行停用」（红旗病例曾让心率42、血压82/48的患者继续服美托洛尔，留出集 S188），外用药不说服用、不套口服间隔；模型写过防跌倒就不再补一句（甲方病历 6）", () => {
    const required = [{ kind: "current_medications", names: ["美托洛尔", "阿昔洛韦乳膏"] }, { kind: "elderly_administration", ageYears: 70 }];
    const out = surface.projectDeliveredReasoning(rx({ name: "x", formulaAnalysis: "x", herbs: [] }, { precautions: ["起身宜缓，防止跌倒。"] }), { requiredPrecautions: required });
    const lines = out.nonPharma.precautions.join("\n");
    assert.doesNotMatch(lines, /不要自行停用/);
    assert.match(lines, /正在服用的美托洛尔请告知医生，是否继续服用由医生决定/);
    assert.match(lines, /正在外用的阿昔洛韦乳膏请告知医生/);
    assert.equal((lines.match(/跌倒/g) || []).length, 1);
  });
  check("16.15 情形 D：靠病程门槛定义的病（功能性消化不良）不改成「原病名待查」，沿用核对给的名称（甲方病历 4 曾成「功能性消化不良待查」）；缺确诊检查的病照旧留住首要考虑（对照）", () => {
    const record = "主诉：胃胀半月\n现病史：上腹胀满半月，食后加重。";
    const payload = (supportedName, reason) => JSON.stringify({ verdict: "inconsistent", type: "D", quote: "上腹胀满半月", reason, supportedName });
    assert.equal(western.parseWesternNameCorrection(payload("上腹胀满待查", "病程半月，未满6个月"), record, "功能性消化不良")?.supportedName, "上腹胀满待查");
    const myeloma = "主诉：腰痛2个月\n现病史：腰痛2个月，贫血貌。";
    assert.equal(western.parseWesternNameCorrection(JSON.stringify({ verdict: "inconsistent", type: "D", quote: "腰痛2个月", reason: "尚未行骨髓穿刺与M蛋白检查", supportedName: "腰痛待查" }), myeloma, "多发性骨髓瘤")?.supportedName, "多发性骨髓瘤待查");
  });
}

console.log(JSON.stringify({ cases, failures: process.exitCode ? "see above" : 0 }));
