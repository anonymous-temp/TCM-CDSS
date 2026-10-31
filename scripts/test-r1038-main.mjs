// 第二十六轮（2026-10-27）：模型输出不稳定按算法收（追问两份采样取共识、舌脉漏讲单项触发重写、证素撤下后舌脉回归主证），
// 以及两处确定性缺口（否认列举越过未评估的一句、「60mg/d」读不出频次）。每条断言都有反证（~/runlogs/r1018/work/r1038/cp/）。
import assert from "node:assert/strict";
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

const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const coverage = await jiti.import("../src/lib/m03-rationale-coverage.server.ts");
const checklist = await jiti.import("../src/lib/rationale-findings-checklist.ts");
const { OPEN_LANGUAGE_CLASS_CONTEXTS } = await import("./lib/open-language-class-contexts.mjs");

const gateOf = (text) => safety.evaluateSafetyGate(OPEN_LANGUAGE_CLASS_CONTEXTS.outpatient_record(text, "r1038"));

// ---------- 1 否认列举到未评估的一句为止 ----------
await check("1.1 「无A，是否B尚未询问，<阳性表现>」与去掉开头否认的写法同判（第二十一轮遗留）；没有未评估项夹在中间的逐项否认照旧", () => {
  for (const [subject, sibling] of [
    ["头晕1天，无咳嗽，是否发热尚未询问，言语不清，肢体无力。", "头晕1天，是否发热尚未询问，言语不清，肢体无力。"],
    ["乏力3天，无咳嗽，有无黑便待核实，胸痛，大汗。", "乏力3天，有无黑便待核实，胸痛，大汗。"],
    ["头晕1天，否认外伤，呕吐情况不详，言语不清，肢体无力。", "头晕1天，呕吐情况不详，言语不清，肢体无力。"],
  ]) {
    assert.ok(gateOf(sibling).redFlags.length > 0, `兄弟句「${sibling}」自身应报警`);
    assert.ok(gateOf(subject).redFlags.length > 0, `「${subject}」被开头的否认吞掉`);
  }
  for (const text of ["头晕1天，无咳嗽，言语不清，肢体无力。", "头晕3天，否认胸痛，胸闷，气促。", "头晕3天，否认胸痛，胸闷，是否气促尚未询问。"]) {
    assert.equal(gateOf(text).redFlags.length, 0, `「${text}」是逐项否认，不应报警`);
  }
});

// ---------- 2 处方写法的给药频次 ----------
const medicationState = (medication) => types.normalizeCaseStateInput({
  id: "r1038-med", chiefComplaint: "血压升高5年，头晕半年", patient: { sex: "男", age: 48 },
  symptoms: { 现病史: "近半年血压控制不佳，时感头晕。", 用药史: medication, 过敏史: "否认药物过敏史" },
  vitals: { T: "36.5", P: "80", R: "18", BP: "150/96" },
});
const missingOf = (state) => (safety.withSafetyGate(state).safetyGate.missingItems || []).join("；");
await check("2.1 「硝苯地平控释片60mg/d」「1片/d」「2次/d」「q8h」读成写了频次（基层病历 B013）；只写剂量没写频次的照旧提示", () => {
  for (const medication of [
    "硝苯地平控释片60mg/d+富马酸比索洛尔5mg/d+培哚普利吲达帕胺1片/d",
    "硝苯地平缓释片20mg、2次/d",
    "阿莫西林胶囊0.5g q8h",
  ]) {
    assert.doesNotMatch(missingOf(medicationState(medication)), /缺少剂量\/频次|缺少药名\/剂量\/频次/, `「${medication}」不应再提示缺频次`);
  }
  assert.match(missingOf(medicationState("口服硝苯地平控释片60mg")), /缺少剂量\/频次/, "只写剂量、没写频次的照旧提示");
});

// ---------- 3 舌脉漏讲单项触发重写 ----------
await check("3.1 病历记录了的舌象或脉象漏讲时单凭这一项也重写；一般伴随表现漏一项照旧不触发", () => {
  const findings = ["正常舌象：淡红舌，薄白苔", "脉弦细", "胸闷", "善叹息", "大便溏结不调", "饮食欠佳"];
  assert.equal(coverage.rationaleNeedsCoverageRewrite(["脉弦细"], findings, ["正常舌象：淡红舌，薄白苔", "脉弦细"]), true);
  assert.equal(coverage.rationaleNeedsCoverageRewrite(["胸闷"], findings, ["正常舌象：淡红舌，薄白苔", "脉弦细"]), false);
  assert.equal(coverage.rationaleNeedsCoverageRewrite(["脉弦细"], findings), false, "不传舌脉时维持第二十五轮的阈值");
  const state = types.normalizeCaseStateInput({ id: "r1038-tp", chiefComplaint: "胃痛半月", tongue: "舌象：淡红舌，薄白苔", pulse: "脉象难配合" });
  assert.deepEqual(checklist.recordedTonguePulse(state), ["淡红舌,薄白苔"], "「难配合」不是所见，不进触发清单");
});

// ---------- 4 证素撤下后舌脉回到主证 ----------
await check("4.1 舌脉只剩在「是否兼X尚待核实」一句里才重写；重写稿须留那一句、X 不出那一句、舌脉写进那一句以外", () => {
  const stranded = "产后起病、头痛隐痛时发时止，为血虚清窍失养，故属血虚头痛；头晕、心悸为血虚不能上奉。神疲乏力、面色少华、舌淡白苔薄白、脉细弱、食欲下降、大便稀溏，是否兼脾气虚尚待核实。";
  const gap = coverage.keyFindingsOnlyInPendingSentence(stranded, ["舌淡白苔薄白", "脉细弱"]);
  assert.deepEqual(gap, { pendingElement: "脾气虚", stranded: ["舌淡白苔薄白", "脉细弱"] });
  const fine = "产后起病、头痛隐痛，为血虚清窍失养，故属血虚头痛；舌淡白、脉细弱为血虚之象。食欲下降、大便稀溏，是否兼脾气虚尚待核实。";
  assert.equal(coverage.keyFindingsOnlyInPendingSentence(fine, ["舌淡白", "脉细弱"]), undefined, "舌脉已在主证推理里，不重写");
  assert.equal(coverage.keyFindingsOnlyInPendingSentence("舌淡白、脉细弱，故属血虚头痛。", ["舌淡白", "脉细弱"]), undefined, "没有待核实那一句，不按这一类重写");
  // 核对删片段时连舌脉一起删掉（甲方病历 10：「脉濡，脉滑」整段不见）：同一个重写，按「漏讲」采信。
  assert.deepEqual(coverage.keyFindingsGapAfterChecks("月经周期提前，属阳盛血热证；舌红、苔黄支持热盛津伤", ["舌红,苔黄", "脉濡,脉滑"]), { stranded: ["脉濡,脉滑"] });
  assert.equal(coverage.keyFindingsGapAfterChecks("月经周期提前，属阳盛血热证；舌红苔黄、脉滑数为热盛之象", ["舌红,苔黄", "脉滑数"]), undefined, "舌脉都讲到了，不重写");
  assert.deepEqual(coverage.keyFindingsGapAfterChecks(stranded, ["舌淡白苔薄白", "脉细弱"]), gap, "只剩在待核实句里时按那一类处理");
  const input = { rationale: stranded, findings: ["舌淡白苔薄白", "脉细弱", "头晕", "心悸"], stranded: ["舌淡白苔薄白", "脉细弱"], pendingElement: "脾气虚", primary: "血虚头痛", secondary: [], disease: "头痛" };
  const good = "产后起病、头痛隐痛时发时止，为血虚清窍失养，故属血虚头痛；头晕、心悸为血虚不能上奉；舌淡白苔薄白、脉细弱为血虚不能充盈舌脉之象。食欲下降、大便稀溏，是否兼脾气虚尚待核实。";
  assert.equal(coverage.acceptedReattributedRationale(good, input), good);
  assert.equal(coverage.acceptedReattributedRationale(good.replace("食欲下降、大便稀溏，是否兼脾气虚尚待核实。", ""), input), undefined, "删了待核实那一句");
  assert.equal(coverage.acceptedReattributedRationale(good.replace("为血虚不能充盈舌脉之象", "为脾气虚之象"), input), undefined, "又把舌脉归给了没成组的脾气虚");
  assert.equal(coverage.acceptedReattributedRationale("产后起病、头痛隐痛时发时止，为血虚清窍失养，故属血虚头痛；头晕、心悸为血虚不能上奉。舌淡白苔薄白、脉细弱、食欲下降、大便稀溏，是否兼脾气虚尚待核实。", input), undefined, "舌脉仍只在待核实那一句里");
});

await check("4.2 路由在证素撤下与本例说法删片段之后才核舌脉（删片段时连舌脉一起删掉的那一类也要补）", async () => {
  const fs = await import("node:fs");
  const route = fs.readFileSync(new URL("../src/app/api/diagnosis/diagnose/route.ts", import.meta.url), "utf8");
  assert.match(route, /reattributeStrandedKeyFindings\(\s*applyPatientClaimRemovalsToContent\(applyElementSupportDecision\(reconciled, elementDecision\), "tcm", claimRemovals\),/u);
  assert.match(route, /checkLineageLensInContent\(completed,[\s\S]{0,240}completeMethodCoverage\(completed,[\s\S]{0,1200}return promoteCriticalSecondarySyndrome\(withVerifiedMethodItemFrom\(withLensFrom\(reattributed, completed, lensChecked\), methodCovered\)\);/u);
});

// ---------- 5 追问两份采样取共识 ----------
await check("5.1 首轮判无需追问、第二份采样留下了模型自己的题：出第二份的题；关掉共识时照旧 proceed", async () => {
  Object.assign(process.env, {
    AI_TEXT_PROVIDER: "openai-compatible",
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://api.deepseek.com",
    OPENAI_MODEL: "deepseek-flash",
    PRIMARY_QUESTION_MODEL: "deepseek-flash",
    CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash",
    CDSS_CLINICAL_FACTS_BACKSTOP: "false",
    CDSS_M02_PROCEED_WHEN_SETTLED: "true",
    CDSS_SMALL_TASK_MEMO: "false",
  });
  const { POST } = await jiti.import("../src/app/api/diagnosis/question/route.ts");
  const caseState = {
    id: "r1038-consensus", phase: "question", questionRounds: 0, maxQuestionRounds: 1,
    patient: { sex: "女", age: 46 }, chiefComplaint: "反复入睡困难3月余",
    symptoms: { presentHistory: "入睡困难，多梦易醒，心烦，口干，大便干，怕热，盗汗" }, tongue: "舌红少苔", pulse: "脉细数",
    vitals: { T: "36.6", P: "78", R: "18", BP: "122/78" }, conversation: [],
  };
  const proceedPlan = { schemaVersion: "tcm-cdss-m02-plan-v1", decision: "proceed", rationale: "病历已足以辨证。", questions: [] };
  const askPlan = {
    schemaVersion: "tcm-cdss-m02-plan-v1", decision: "ask", rationale: "仍有一个会改变首要鉴别的未决分支。",
    questions: [{
      id: "q1", question: "入睡困难是否在情绪紧张或思虑后明显加重？", reason: "与情志的关系会改变首要鉴别方向。",
      targetField: "xianbingshi", decisionBranch: "differential", expectedDecisionImpact: "区分情志诱发与无明显关系。", informationGain: 0.82,
      sourceEvidence: ["入睡困难"],
      options: [
        { id: "a", label: "思虑后加重", answer: "情绪紧张或思虑后入睡困难明显加重", kind: "clinical_fact", recordValue: "思虑后入睡困难加重" },
        { id: "b", label: "无明显关系", answer: "与情绪无明显关系", kind: "clinical_fact", recordValue: "入睡困难与情绪无明显关系" },
        { id: "unknown", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
      ],
    }],
  };
  const savedFetch = globalThis.fetch;
  let samples = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const system = body.messages?.[0]?.content || "";
    if (!body.stream && /追问题与病历的重复核对器/.test(system)) {
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ verdict: "not_answered", quotes: [], reason: "", optionValues: [] }) }, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } });
    }
    if (!body.stream && /追问题题干的核对器/.test(system)) {
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ verdict: "single", points: [] }) }, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } });
    }
    if (!body.stream && body.temperature === 0.3) {
      samples += 1;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ m02Plan: askPlan }) }, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } });
    }
    if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ m02Plan: proceedPlan }) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  };
  const run = async () => {
    const response = await POST(new Request("http://localhost/api/diagnosis/question", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cdss-customer-id": "test-hospital" },
      body: JSON.stringify({ caseState }),
    }));
    assert.equal(response.status, 200);
    const text = (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line).content || "").filter((chunk) => chunk !== "[END]").join("");
    const start = "<!-- DIAGNOSIS_JSON_START -->";
    const end = "<!-- DIAGNOSIS_JSON_END -->";
    const tail = text.slice(text.lastIndexOf(start) + start.length);
    return JSON.parse(tail.slice(0, tail.indexOf(end)));
  };
  try {
    const consensus = await run();
    assert.equal(samples, 1, "第二份采样发了一次");
    assert.equal(consensus.m02Plan.decision, "ask");
    assert.equal(consensus.m02Plan.questions[0].question, askPlan.questions[0].question, "出的是第二份采样里模型自己的题");
    process.env.CDSS_M02_QUESTION_CONSENSUS = "false";
    samples = 0;
    const single = await run();
    assert.equal(samples, 0, "关掉共识不发第二份");
    assert.equal(single.m02Plan.decision, "proceed", "关掉共识：首轮判无需追问、病历充分时照旧 proceed");
  } finally {
    globalThis.fetch = savedFetch;
    delete process.env.CDSS_M02_QUESTION_CONSENSUS;
  }
});

// ---------- 6 评估时限按指南收紧 ----------
function pageCase({ sex = "女", age = 35, chief, present = "", exams = "" } = {}) {
  const raw = [`患者信息：性别${sex}，年龄${age}岁`, `主诉：${chief}`, present && `现病史：${present}`, "过敏史：否认药物过敏", "用药史：未服药",
    "生命体征/体格检查：T 36.5℃，P 78次/分，R 18次/分，BP 128/80mmHg", "舌象：舌淡红，苔薄白", "脉象：脉弦", exams && `辅助检查：${exams}`].filter(Boolean).join("\n");
  return types.normalizeCaseStateInput({
    id: "r1038-window", phase: "collect", patient: { sex, age }, chiefComplaint: chief,
    symptoms: { ...(present ? { presentHistory: present } : {}), ...(exams ? { exams } : {}) },
    questionRounds: 0, maxQuestionRounds: 1, conversation: [{ role: "user", content: raw }],
    tongue: "舌淡红，苔薄白", pulse: "脉弦", medicationHistory: "未服药", allergyHistory: "否认药物过敏",
    vitals: { temperature: "36.5", pulse: "78", respiration: "18", bloodPressure: "128/80" },
  });
}
const mustNotMiss = (condition, quote, timeWindow) => ({ semanticStatus: "checked", reviewStatus: "single_pass", redFlags: [],
  disposition: { setting: "urgent_specialist", mustNotMiss: [{ condition, plausibility: "likely", evidenceQuotes: [quote], timeWindow }] } });

await check("6.1 指南时限表：病名对上的行取最紧一档；条件行只认写明条件的病名；拉丁缩写按词边界", () => {
  assert.equal(safety.guidelineEvaluationWindow("短暂性脑缺血发作")?.window, "within_24h");
  assert.equal(safety.guidelineEvaluationWindow("下肢深静脉血栓形成")?.window, "within_24h", "指南写 4 小时内/立即的，映射为非红旗的最紧一档");
  assert.equal(safety.guidelineEvaluationWindow("马尾综合征（腰椎间盘突出致马尾神经压迫）")?.window, "within_24h");
  assert.equal(safety.guidelineEvaluationWindow("慢性肾病3期患者使用NSAIDs致急性肾损伤或肾功能恶化")?.window, "within_24h");
  assert.equal(safety.guidelineEvaluationWindow("TIA")?.window, "within_24h");
  assert.equal(safety.guidelineEvaluationWindow("PET-CT提示占位"), undefined, "PE 不在 PET 里匹配");
  assert.equal(safety.guidelineEvaluationWindow("高钾血症"), undefined, "条件行（血钾分档）不认不带条件的病名");
  assert.equal(safety.guidelineEvaluationWindow("中度高钾血症")?.window, "within_24h");
  assert.equal(safety.guidelineEvaluationWindow("周围性面瘫"), undefined, "面瘫的时限是负责人决定，表里不收");
  assert.equal(safety.guidelineEvaluationWindow("乳腺癌")?.window, "within_2w");
  assert.equal(safety.guidelineEvaluationWindow("功能性消化不良"), undefined);
  assert.equal(safety.guidelineEvaluationWindow("胰腺癌待排（梗阻性黄疸）")?.window, "within_24h", "对上几行时取最紧的一档（梗阻性黄疸 24 小时、胰腺癌两周）");
});

await check("6.2 事实模型给的时限比指南慢时收紧到指南的一档（急性肾损伤 48 小时 → 24 小时）；模型更紧的照用；专门路径不动", () => {
  // 第二十一轮基层病历 B032 一类：肌酐 64→233（KDIGO 3 期），事实模型给 48 小时；NICE NG148 要求 24 小时内与肾内科讨论。
  const aki = pageCase({ sex: "男", age: 66, chief: "乏力纳差1周", present: "近1周乏力、纳差，自服布洛芬止痛", exams: "血肌酐233μmol/L（3个月前64μmol/L）" });
  assert.equal(safety.evaluateSafetyGate(aki).status === "red_flag", false, "fixture: 不是红旗病例");
  const slow = safety.priorityEvaluationFollowupTarget({ ...aki, clinicalFacts: mustNotMiss("急性肾损伤（药物相关）", "血肌酐233μmol/L（3个月前64μmol/L）", "within_48h") });
  assert.equal(slow?.window, "within_24h");
  const loose = safety.priorityEvaluationFollowupTarget({ ...aki, clinicalFacts: mustNotMiss("慢性肾脏病进展", "血肌酐233μmol/L（3个月前64μmol/L）", "within_48h") });
  assert.equal(loose?.window, "within_48h", "对不上表的病名照用模型的时限");
  const tighter = safety.priorityEvaluationFollowupTarget({ ...aki, clinicalFacts: mustNotMiss("肺癌待排", "血肌酐233μmol/L（3个月前64μmol/L）", "within_48h") });
  assert.equal(tighter?.window, "within_48h", "模型给的比表里紧（肺癌两周 vs 模型 48 小时）照用模型的：只收紧，不放松");
  const lump = pageCase({ age: 38, chief: "左乳无痛性结节1个月", present: "洗澡时触及无痛肿块", exams: "尚未乳腺超声" });
  const breast = safety.priorityEvaluationFollowupTarget({ ...lump, clinicalFacts: mustNotMiss("乳腺癌", "洗澡时触及无痛肿块", "within_2w") });
  assert.deepEqual(breast, { focus: "乳腺癌", window: "within_2w", pathway: "breast_mass" });
});

console.log(JSON.stringify({ suite: "r1038-main", cases, failures: process.exitCode ? "see above" : 0 }));
