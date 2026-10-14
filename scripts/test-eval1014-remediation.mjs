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
//     老年人针刺量宜小；高血压专篇的疗程不套到没有高血压的眩晕上
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
    assert.deepEqual(parse({}), { supportedName: "白天嗜睡待查", quote: "家属诉其夜间睡眠时无明显打鼾、憋气", reason: "核心表现夜间打鼾憋气病历记录为无" });
    assert.deepEqual(westernCheck.parseWesternNameCorrection(JSON.stringify({ verdict: "inconsistent", type: "C", quote: "周期尚规律", reason: "诊断要求月经稀发或闭经，病历记录周期规律", supportedName: "卵巢储备功能减退" }), record, "早发性卵巢功能不全")?.supportedName, "卵巢储备功能减退");
  });
  check("3.2 不采信：判一致、引文不在病历里、名称带括号/并列/推测/证候、与原名相同、情形不在三类之内", () => {
    assert.equal(parse({ verdict: "consistent" }), undefined);
    assert.equal(parse({ quote: "夜间无打鼾" }), undefined, "引文必须逐字在病历里");
    assert.equal(parse({ quote: "嗜睡" }), undefined, "引文太短不足以成为依据");
    for (const name of ["发作性睡病（待排）", "嗜睡或发作性睡病", "发作性睡病可能", "痰湿困脾证", "睡眠呼吸暂停低通气综合征", "A", ""]) {
      assert.equal(parse({ supportedName: name }), undefined, `不合规的名称：${name}`);
    }
    assert.equal(parse({ type: "D" }), undefined);
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
      globalThis.fetch = savedFetch;
    }
  });
  }

// ───── 4 针刺方案 ─────
{
  process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = "acupuncture,moxibustion,cupping,guasha,auricular,tuina,diet_therapy,qigong_daoyin,mind_therapy";
  const treatments = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
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
}

// ───── 5 煎服用法 ─────
{
  const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
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

console.log(JSON.stringify({ cases, failures: process.exitCode ? "see above" : 0 }));
