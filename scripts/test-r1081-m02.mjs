import assert from "node:assert/strict";
import { createJiti } from "jiti";

Object.assign(process.env, {
  AI_TEXT_PROVIDER: "openai-compatible",
  OPENAI_API_KEY: "test-only",
  OPENAI_BASE_URL: "https://api.deepseek.com",
  OPENAI_MODEL: "deepseek-flash",
  PRIMARY_QUESTION_MODEL: "deepseek-flash",
  CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash",
  CDSS_CLINICAL_FACTS_BACKSTOP: "false",
  CDSS_M02_PRECOMPUTE_NO_ANSWER: "false",
  CDSS_REDFLAGS_PRECOMPUTE: "false",
  CDSS_SMALL_TASK_MEMO: "false",
  CDSS_STAGE_RESULT_REUSE: "false",
  CDSS_M02_PROCEED_WHEN_SETTLED: "true",
  CDSS_M02_QUESTION_CONSENSUS: "false",
});

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const followup = await jiti.import("../src/lib/followup-conversation.ts");
const contract = await jiti.import("../src/lib/m02-question-contract.ts");
const narrow = await jiti.import("../src/lib/m02-question-redundancy.server.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const { sanitizeCaseStateForModel, trustedInputText } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { stageRequestFingerprint } = await jiti.import("../src/lib/stage-result-coalescing.server.ts");
const { noAnswerCaseState } = await jiti.import("../src/lib/no-answer-precompute.server.ts");
const { buildQuestionPrompt } = await jiti.import("../src/lib/diagnosis-prompts.ts");
const { POST: questionPost } = await jiti.import("../src/app/api/diagnosis/question/route.ts");
const { POST: redFlagsPost } = await jiti.import("../src/app/api/diagnosis/red-flags/route.ts");

const SKIP = followup.FOLLOWUP_SKIP_SENTENCE;
const assistant = (content) => ({ role: "assistant", content });
const user = (content) => ({ role: "user", content });

const envelope = (questions, decision = questions.length ? "ask" : "proceed") => ({
  m02Plan: { schemaVersion: "tcm-cdss-m02-plan-v1", decision, rationale: "核实能改变下一步判断的资料。", questions },
});
const query = (question, { id = "q1", branch = "syndrome", field = "tcmDetail", a = "有这一表现", b = "这一表现未出现" } = {}) => ({
  id, question, reason: "不同回答会改变检查顺序。", targetField: field, decisionBranch: branch,
  expectedDecisionImpact: "根据回答决定检查方向。", informationGain: 0.82, sourceEvidence: [],
  options: [
    { id: "a", label: a, answer: a, recordValue: a, kind: "clinical_fact" },
    { id: "b", label: b, answer: b, recordValue: b, kind: "clinical_fact" },
    { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
  ],
});
const stem = "瘙痒是否在进食之后明显加剧？";
const newStem = "瘙痒部位是否可见新发皮疹？";
const base = {
  id: "r1081-m02", phase: "question", chiefComplaint: "皮肤瘙痒数周",
  patient: { sex: "女", age: 36 }, symptoms: { 现病史: "头颈部阵发发痒" }, conversation: [],
};
const approved = { verdict: "not_answered", quotes: [], stemClaim: null, unobservablePoint: null, optionValues: [] };

const jsonResponse = (data) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) }, finish_reason: "stop" }] }), {
  headers: { "content-type": "application/json" },
});
const sseResponse = (data) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(data) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, {
  headers: { "content-type": "text/event-stream" },
});
let primary = envelope([]);
let secondary = envelope([]);
let providerFailure = false;
let redundancy = () => approved;
let singlePoint = () => ({ verdict: "single", points: [] });
let captured = [];
const savedFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const system = body.messages?.[0]?.content || "";
  const payload = body.messages?.at(-1)?.content;
  if (/追问题与病历的重复核对器/.test(system)) {
    const input = JSON.parse(payload);
    captured.push({ system, input });
    return jsonResponse(await redundancy(input));
  }
  if (/追问题题干的核对器/.test(system)) return jsonResponse(singlePoint(JSON.parse(payload)));
  if (body.stream && /m02Plan/.test(JSON.stringify(body.messages))) {
    return providerFailure ? new Response("stub model failure", { status: 400 }) : sseResponse(primary);
  }
  if (body.temperature === 0.3 && /m02Plan/.test(JSON.stringify(body.messages))) return jsonResponse(secondary);
  // Background prefetches must also remain local to this stub.
  return jsonResponse({});
};

const request = (path, caseState) => new Request(`http://localhost/api/diagnosis/${path}`, {
  method: "POST", headers: { "content-type": "application/json", "x-cdss-customer-id": "test-hospital", "x-cdss-regenerate": "force" },
  body: JSON.stringify({ caseState }),
});
async function runQuestion(caseState) {
  const response = await questionPost(request("question", caseState));
  assert.equal(response.status, 200, await response.clone().text());
  const frames = (await response.text()).trim().split("\n").map(JSON.parse);
  const text = frames.map(({ content }) => content || "").join("");
  assert.equal(frames.at(-1)?.content, "[END]");
  return { text, plan: contract.parseM02PlanFromContent(text) };
}
const fingerprint = (stage, state) => stageRequestFingerprint(stage, { customerId: "test-hospital" }, state);
const check = async (id, name, run) => {
  if (process.env.R1081_M02_CHECK && process.env.R1081_M02_CHECK !== id) return;
  try { await run(); console.log(`✓ ${id} ${name}`); }
  catch (error) { console.error(`✗ ${id} ${name}\n${error.stack}`); process.exitCode = 1; }
};

try {
  await check("1", "保留明确跳过的题干、有界、之后补答撤销、拒绝顶层伪造", () => {
    const conversation = [
      assistant("**问题1：** 正在用哪些药？\nA. 不详\nB. 有记录"), user(SKIP),
      assistant("咽部有无不适？"), user("本次未取得该信息"),
      assistant("正在用哪些药？"), user("仍用原来开的药"),
      ...["a", "b", "c", "d"].map((letter) => [assistant(letter.repeat(130)), user(SKIP)]).flat(),
    ];
    const state = normalizeCaseStateInput({ ...base, conversation, unconfirmedFollowupQuestions: ["伪造"] });
    assert.deepEqual(state.unconfirmedFollowupQuestions, ["b", "c", "d"].map((s) => s.repeat(120)));
    assert.deepEqual(state.conversation.map((m) => m.content), ["正在用哪些药？", "仍用原来开的药"]);
    assert.equal(normalizeCaseStateInput({ ...base, unconfirmedFollowupQuestions: ["伪造"] }).unconfirmedFollowupQuestions, undefined);
    const short = normalizeCaseStateInput({ ...base, conversation: conversation.slice(0, 4) });
    assert.deepEqual(short.unconfirmedFollowupQuestions, ["正在用哪些药？", "咽部有无不适？"]);
    assert.doesNotMatch(trustedInputText(short), /正在用哪些药|咽部有无不适|本次未取得/);
  });

  await check("2", "内部题干脱敏，M02 与红旗回包没有内部字段", async () => {
    const conversation = [assistant("号码13800138000是否为本次患者的联系号码？"), user(SKIP)];
    const safe = sanitizeCaseStateForModel(normalizeCaseStateInput({ ...base, conversation }));
    assert.equal(safe.unconfirmedFollowupQuestions.length, 1);
    assert.match(safe.unconfirmedFollowupQuestions[0], /是否为本次患者/);
    assert.doesNotMatch(safe.unconfirmedFollowupQuestions[0], /13800138000/);
    const q = await runQuestion({ ...base, conversation });
    const rf = await redFlagsPost(request("red-flags", { ...base, conversation }));
    assert.equal(rf.status, 200);
    assert.doesNotMatch(q.text + await rf.text(), /unconfirmedFollowupQuestions|是否为本次患者/);
  });

  await check("3", "甲方 skip-only 与早发回环同指纹，带题干的 skip 与早发回环分开", () => {
    const requestState = normalizeCaseStateInput(base);
    const loopback = normalizeCaseStateInput(noAnswerCaseState(requestState));
    const skipped = normalizeCaseStateInput({ ...base, conversation: [user(SKIP)] });
    const paired = normalizeCaseStateInput({ ...base, conversation: [assistant(stem), user(SKIP)] });
    assert.equal(skipped.unconfirmedFollowupQuestions, undefined);
    assert.deepEqual(paired.unconfirmedFollowupQuestions, [stem]);
    for (const stage of ["diagnose", "prescribe"]) {
      assert.equal(fingerprint(stage, loopback), fingerprint(stage, skipped), stage);
      assert.notEqual(fingerprint(stage, loopback), fingerprint(stage, paired), stage);
    }
  });

  await check("4", "同文重问离线挡住，未答和新问点作为对照", async () => {
    primary = envelope([query(stem)]);
    const explicit = { ...base, questionRounds: 0, conversation: [assistant(`**问题1：** ${stem}\nA. 有\nB. 无`), user("没有")] };
    captured = [];
    assert.equal((await runQuestion(explicit)).plan.decision, "proceed");
    assert.equal(captured.filter(({ input }) => input.question === stem).length, 0);
    // 已有一轮作答之后只为处置或用药安全再问（总指挥整合，第六十二轮）：辨证方向的新问点不再问，安全方向的新问点照问。
    primary = envelope([query(newStem)]);
    assert.equal((await runQuestion(explicit)).plan.decision, "proceed");
    primary = envelope([query(newStem, { branch: "treatment_safety" })]);
    assert.equal((await runQuestion(explicit)).plan.questions[0].question, newStem);
    process.env.CDSS_M02_SECOND_ROUND_SAFETY_ONLY = "false";
    primary = envelope([query(newStem)]);
    assert.equal((await runQuestion(explicit)).plan.questions[0].question, newStem);
    delete process.env.CDSS_M02_SECOND_ROUND_SAFETY_ONLY;
    primary = envelope([query(stem)]);
    assert.equal((await runQuestion({ ...explicit, conversation: [assistant(stem), user(SKIP)] })).plan.questions[0].question, stem);
  });

  await check("5", "服务端题也核对，已答问答不受长病历裁剪；旧题独自不能充当证据", async () => {
    const content = contract.ensureQuestionStructuredEnvelope(JSON.stringify(envelope([query(newStem)])));
    const context = { previousAnswers: [{ question: "发痒的地方有起疹子吗？", answer: "没有" }] };
    const record = "患者主诉皮肤发痒。".repeat(400);
    captured = [];
    redundancy = ({ previousAnswers }) => previousAnswers?.[0]?.answer === "没有"
      ? { ...approved, verdict: "answered", quotes: ["没有"] } : approved;
    assert.deepEqual(await narrow.questionIdsFailingNarrowChecks(content, record, content, undefined, context), ["q1"]);
    assert.equal(captured[0].input.record.length, 2400);
    assert.deepEqual(captured[0].input.previousAnswers, context.previousAnswers);
    redundancy = () => ({ ...approved, verdict: "answered", quotes: ["发痒的地方有起疹子吗"] });
    assert.deepEqual(await narrow.questionIdsFailingNarrowChecks(content, record, content, undefined, context), []);
    redundancy = () => approved;
  });

  await check("6", "题干改写原话被撤题，原话、近似书写和无效引文放行", async () => {
    const altered = "膝关节刺痛是否随下楼加重？";
    const original = "膝关节隐隐作痛是否随下楼加重？";
    const record = { ...base, chiefComplaint: "膝关节隐隐作痛3周", symptoms: { 现病史: "膝关节隐隐作痛" }, tongue: "舌淡红苔薄白", pulse: "脉弦" };
    redundancy = ({ question }) => ({ ...approved, stemClaim: question === altered ? "膝关节刺痛" : "膝关节隐隐作痛" });
    primary = envelope([query(altered)]);
    assert.equal((await runQuestion(record)).plan.decision, "proceed");
    primary = envelope([query(original)]);
    assert.equal((await runQuestion(record)).plan.questions[0].question, original);
    assert.equal(narrow.questionStemFailsGrounding(JSON.stringify({ stemClaim: "脉弦" }), "脉弦这一表现何时出现？", "脉象：弦"), false);
    assert.equal(narrow.questionStemFailsGrounding(JSON.stringify({ stemClaim: "毫无关系的引文" }), altered, "膝关节隐隐作痛"), false);
    redundancy = () => approved;
  });

  await check("7", "婴幼儿不能回答的感受被撤题，可观察问题和成人保留", async () => {
    const subjective = "鼻塞时是否觉得头部发沉？";
    const observable = "鼻塞时是否张口呼吸？";
    const prior = [assistant("夜间能否安睡？"), user("夜间睡眠平稳")];
    const child = { ...base, questionRounds: 0, conversation: prior, chiefComplaint: "鼻塞2天", patient: { age: "10个月", sex: "女" } };
    redundancy = () => ({ ...approved, unobservablePoint: "头部发沉" });
    primary = envelope([query(subjective, { branch: "treatment_safety" })]);
    assert.equal((await runQuestion(child)).plan.decision, "proceed");
    assert.equal((await runQuestion({ ...child, patient: { age: 28 } })).plan.questions[0].question, subjective);
    primary = envelope([query(observable, { branch: "treatment_safety" })]);
    assert.equal((await runQuestion(child)).plan.questions[0].question, observable);
    primary = envelope([query("脉象更接近哪一种？", { field: "tcmPulse", a: "脉浮", b: "脉沉" })]);
    assert.equal((await runQuestion(child)).plan.decision, "proceed");
    redundancy = () => approved;
  });

  await check("8", "有效安全未知优先于辨证，一轮只留一题", async () => {
    const urgency = "目前是否仍有皮下出血？";
    primary = envelope([query(newStem), query(urgency, { id: "q2", branch: "triage" })]);
    const { plan } = await runQuestion(base);
    assert.deepEqual(plan.questions.map((item) => item.question), [urgency]);
    const prompt = buildQuestionPrompt(normalizeCaseStateInput(base));
    assert.match(prompt, /先核实病历未答、且会改变当前处置或用药安全/);
    assert.match(prompt, /避孕记录不能代替对妊娠状态的确认/);
    assert.match(prompt, /逐字沿用原话/);
  });

  await check("9", "首份题核对未结束，先合格的并行采样可以胜出", async () => {
    process.env.CDSS_M02_QUESTION_CONSENSUS = "true";
    let release;
    const wait = new Promise((resolve) => { release = resolve; });
    const timer = setTimeout(() => release(approved), 600);
    redundancy = ({ question }) => question === stem ? wait : approved;
    primary = envelope([query(stem)]);
    secondary = envelope([query(newStem, { branch: "treatment_safety" })]);
    try {
      const { plan } = await runQuestion({ ...base, conversation: [assistant("最初出现在哪儿？"), user("先见于头颈部")], questionRounds: 0 });
      assert.equal(plan.questions[0].question, newStem);
    } finally {
      clearTimeout(timer);
      release(approved);
      redundancy = () => approved;
      process.env.CDSS_M02_QUESTION_CONSENSUS = "false";
    }
  });

  await check("10", "仍保留单问点和选项互斥核对；语义故障按原题放行", async () => {
    const question = "皮肤颜色与食欲各有什么变化？";
    const content = contract.ensureQuestionStructuredEnvelope(JSON.stringify(envelope([query(question, { a: "有变化", b: "没有变化" })])));
    singlePoint = () => ({ verdict: "compound", points: ["皮肤颜色", "食欲"] });
    assert.deepEqual(await narrow.questionIdsFailingNarrowChecks(content, "皮肤不适", ""), ["q1"]);
    singlePoint = () => ({ verdict: "single", points: [] });
    redundancy = () => ({ ...approved, optionValues: ["有变化", "没有变化"] });
    assert.deepEqual(await narrow.questionIdsFailingNarrowChecks(content, "皮肤不适", ""), [], "肯定与否定不算同值");
    const overlap = contract.ensureQuestionStructuredEnvelope(JSON.stringify(envelope([query(newStem, { a: "出现红疹", b: "有红色皮疹" })])));
    redundancy = () => ({ ...approved, optionValues: ["红疹", "红色皮疹"] });
    assert.deepEqual(await narrow.questionIdsFailingNarrowChecks(overlap, "皮肤不适", ""), ["q1"]);
    redundancy = () => null;
    assert.deepEqual(await narrow.questionIdsFailingNarrowChecks(content, "皮肤不适", ""), []);
    redundancy = () => approved;
  });

  await check("11", "模型没有合格题时不重新加回被核对否决的兜底；原样放行对照", async () => {
    primary = envelope([]);
    captured = [];
    redundancy = ({ question }) => question !== stem
      ? { ...approved, verdict: "answered", quotes: ["头颈部阵发发痒"] } : approved;
    const first = await runQuestion(base);
    assert.equal(first.plan.decision, "proceed");
    assert.ok(captured.length > 0, "候选兜底题经过窄核对");
    redundancy = () => approved;
    const second = await runQuestion(base);
    assert.equal(second.plan.decision, "ask");
    assert.equal(second.plan.questions.length, 1);
  });

  await check("12", "已完成追问的接口来访直接 proceed，显式可出题的记录仍走窄核对", async () => {
    primary = envelope([query(newStem)]);
    const completed = { ...base, conversation: [assistant(stem), user("没有")] };
    assert.equal((await runQuestion(completed)).plan.decision, "proceed");
    assert.equal((await runQuestion({ ...completed, questionRounds: 0 })).plan.decision, "proceed");
    primary = envelope([query(newStem, { branch: "treatment_safety" })]);
    assert.equal((await runQuestion({ ...completed, questionRounds: 0 })).plan.questions[0].question, newStem);
  });

  await check("13", "上游失败也只能交付通过窄核对的兜底题", async () => {
    providerFailure = true;
    try {
      const open = await runQuestion(base);
      assert.equal(open.plan.decision, "ask");
      const sameStem = open.plan.questions[0].question;
      redundancy = ({ question }) => question === sameStem
        ? { ...approved, verdict: "answered", quotes: ["头颈部阵发发痒"] } : approved;
      const caught = await runQuestion(base);
      assert.equal(caught.plan.decision, "proceed");
      assert.match(caught.text, /"completeness"/);
    } finally {
      redundancy = () => approved;
      providerFailure = false;
    }
  });
  if (process.argv.includes("--replay")) {
    const { readdirSync, readFileSync } = await import("node:fs");
    const root = "zz-evidence/out";
    // 逐条读过已有问答和交付题。引文是人工编码的窄核对桩，故数字只衡量过滤链连通性。
    const known = new Map([
      ["eval/e05-08.r1.json", "无头晕、心慌、出冷汗"],
      ["eval/e1026-05.r1.json", "平素不畏寒"],
      ["eval/e1026-10.r1.json", "本次月经前后伴胸胁胀满或乳房胀痛"],
      ["eval/e1029-c23-519424.r1.json", "按压时疼痛加重"],
      ["eval/e1029-c24-180544.r1.json", "经行小腹冷痛拒按"],
      ["eval/rt-685504.r1.json", "静息时呼吸急促，活动后加重，尚能平卧"],
      ["eval/rt-767552.r1.json", "自汗稍一活动即明显加重"],
      ["api/z70583caea9.r1.json", "发热时恶寒明显"],
    ]);
    const stats = { archive: 0, answered: 0, originalAsk: 0, exact: 0, stubRepeat: 0, noRepeatLabel: 0, retained: 0, otherFilters: 0, skipOnly: 0, skipCorrectFingerprint: 0 };
    for (const folder of readdirSync(root)) {
      for (const filename of readdirSync(`${root}/${folder}`).filter((name) => name.endsWith(".json"))) {
        const path = `${folder}/${filename}`;
        const { input, question } = JSON.parse(readFileSync(`${root}/${path}`, "utf8"));
        if (!input) continue;
        stats.archive++;
        const state = normalizeCaseStateInput(input);
        const reported = followup.followupConversationView(input.conversation);
        if (reported.skipped && !reported.answers.length && state.conversation.length === 0 && !state.unconfirmedFollowupQuestions) {
          stats.skipOnly++;
          const original = normalizeCaseStateInput({ ...input, conversation: [] });
          const loopback = normalizeCaseStateInput(noAnswerCaseState(original));
          if (["diagnose", "prescribe"].every((stage) => fingerprint(stage, loopback) === fingerprint(stage, state))) stats.skipCorrectFingerprint++;
        }
        if (!reported.answers.length) continue;
        stats.answered++;
        const historical = question?.structured?.m02Plan;
        if (historical?.decision !== "ask") continue;
        stats.originalAsk++;
        const candidate = historical.questions[0].question;
        const exact = followup.previouslyAnsweredFollowupQuestion(candidate, reported.answers);
        if (path.startsWith("eval/e1029-c01-")) {
          assert.equal(state.tongue, "舌质淡红、苔薄白");
          const oldKnownAnswerGuard = contract.enforceM02UnansweredAxes(
            contract.ensureQuestionStructuredEnvelope(JSON.stringify({ m02Plan: historical })),
            trustedInputText(state),
          );
          console.log("REPLAY c01 existing deterministic option guard", contract.parseM02PlanFromContent(oldKnownAnswerGuard)?.decision);
        }
        const quote = known.get(path);
        if (quote) assert.ok(reported.answers.some(({ answer }) => answer.includes(quote)), path);
        primary = { m02Plan: historical };
        redundancy = (check) => quote && check.question === candidate
          ? { ...approved, verdict: "partly", quotes: [quote] }
          : approved;
        const result = await runQuestion({ ...input, phase: "question", questionRounds: 0 });
        const retained = result.plan.questions.some(({ question: stem }) => stem === candidate);
        console.log("REPLAY", path, exact ? "exact" : quote ? "annotated" : "control", result.plan.decision, retained);
        if (exact || quote) {
          assert.equal(retained, false, path);
          stats[exact ? "exact" : "stubRepeat"]++;
        } else {
          stats.noRepeatLabel++;
          stats[retained ? "retained" : "otherFilters"]++;
        }
      }
    }
    console.log("REPLAY", JSON.stringify(stats));
    const loadFresh = (key) => JSON.parse(readFileSync(`${root}/fresh/${key}.r1.json`, "utf8"));
    const f01 = loadFresh("f01");
    primary = { m02Plan: f01.question.structured.m02Plan };
    redundancy = ({ question }) => ({ ...approved, stemClaim: question.includes("胸胁窜痛") ? "胸胁窜痛" : null });
    const f01Replay = await runQuestion({ ...f01.input, phase: "question", questionRounds: 0 });
    assert.doesNotMatch(f01Replay.plan.questions.map(({ question }) => question).join(""), /胸胁窜痛/);
    console.log("REPLAY f01", f01Replay.plan.decision);
    const f07 = loadFresh("f07");
    const bleeding = "目前是否仍有阴道出血？";
    primary = envelope([query(bleeding, { branch: "triage", a: "目前仍有阴道出血", b: "目前无阴道出血" })]);
    redundancy = () => approved;
    assert.equal((await runQuestion({ ...f07.input, phase: "question", questionRounds: 0 })).plan.questions[0].question, bleeding);
    const f12 = loadFresh("f12");
    const pregnancy = "目前是否已确认妊娠？";
    const reproductive = query(pregnancy, { id: "q2", branch: "treatment_safety", a: "目前已经妊娠", b: "目前没有妊娠" });
    primary = envelope([...f12.question.structured.m02Plan.questions, reproductive]);
    const f12Replay = await runQuestion({ ...f12.input, phase: "question", questionRounds: 0 });
    assert.equal(f12Replay.plan.questions[0].question, pregnancy);
    console.log("REPLAY f07/f12 两份安全分支桩均保留");
  }
} finally {
  globalThis.fetch = savedFetch;
}
