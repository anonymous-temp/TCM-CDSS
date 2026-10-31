// 第二十五轮（2026-10-27）：婚育史里的「怀孕」、自行停药的读法、病历记载的当前出血、成人用儿科病名、上消化道类目的边界、
// 辨证依据漏讲表现时重写、居家穴位保健由模型按本例选穴。每条断言都有反证（~/runlogs/r1018/work/r1037/cp/）。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { createJiti } from "jiti";
import { answerNonModelRequest } from "./lib/local-model-endpoint.mjs";

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

const state = await jiti.import("../src/lib/clinical-state.ts");
const polarity = await jiti.import("../src/lib/clinical-polarity.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const bleedingRules = await jiti.import("../src/lib/active-bleeding-treatment.ts");
const western = await jiti.import("../src/lib/western-name-evidence-check.server.ts");
const facts = await jiti.import("../src/lib/clinical-facts.ts");
const coverage = await jiti.import("../src/lib/m03-rationale-coverage.server.ts");
const authoring = await jiti.import("../src/lib/home-acupoint-authoring.server.ts");
const capabilities = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");

// ---------- 1 婚育史 ----------
await check("1.1 婚育史里单独成项的「怀孕」「妊娠」读成当前妊娠（甲方测评病历 1「适龄婚育，配偶体健，怀孕」）；否认、未孕、孕产次数、既往孕产照旧", () => {
  const read = (text) => state.assessPregnancyState(text).status;
  assert.equal(read("婚育史：适龄婚育，配偶体健，怀孕"), "positive");
  assert.equal(read("婚育史：已婚，怀孕中"), "positive");
  assert.equal(read("婚育史：G2P1，现妊娠"), "positive");
  assert.equal(read("婚育史：已婚，否认怀孕"), "negative");
  assert.equal(read("婚育史：已婚未育，未怀孕"), "negative");
  assert.equal(read("婚育史：怀孕3次，顺产1次"), "unknown");
  assert.equal(read("婚育史：适龄婚育，育有1子"), "unknown");
  assert.equal(read("否认停经、妊娠"), "negative", "顿号前接的是否认串的一项");
});

await check("1.2 接口文档写明 symptoms 可传婚育史、月经史（甲方 10/13 以来的请求从未传过这两栏）", () => {
  const doc = fs.readFileSync("docs/中医CDSS-对外接口文档.md", "utf8");
  assert.ok(doc.includes("**`婚育史`、`月经史`**"), "symptoms 键名清单里写明婚育史、月经史");
});

// ---------- 2 自行停药 ----------
await check("2.1 停用写了时长或「自行」时不再把前一味当作在用（「利伐沙班，近一周自行停用」「阿司匹林，已停用半年」）；停后再服、长期服用照旧", () => {
  const current = (text) => polarity.affirmedCurrentMedicationText(text);
  assert.equal(current("用药史：利伐沙班，近一周自行停用"), undefined);
  assert.equal(current("用药史：阿司匹林，已停用半年"), undefined);
  assert.equal(current("用药史：二甲双胍0.5g tid，阿司匹林，已停用3个月"), "用药史:二甲双胍0.5g tid");
  assert.match(current("长期服用阿司匹林，停用1周后再次服用") || "", /阿司匹林/);
  assert.match(current("用药史：华法林长期服用") || "", /华法林/);
});

// ---------- 3 病历记载的当前出血 ----------
const C098 = "主诉：慢性咳嗽1月，呼吸困难突然加重2小时\n现病史：三天前门诊按慢性支气管炎处理，今天突然胸痛气促，活动后明显，咯血丝。\n用药史：利伐沙班，近一周自行停用";
const C070 = "主诉：经期腹痛伴经量增多半年\n现病史：经期头两天腹痛明显，经血量较以往增加，近月站起头晕。\n既往史：机械瓣膜置换术后\n用药史：华法林长期服用\n辅助检查：INR3.5，Hb101g/L";
await check("3.1 病历记载的当前咯血、正在抗凝且有当前出血，按活动性出血处理活血化瘀药（C098 不再取决于事实层引文、C070）；否认、既往、无抗凝、未出血不算", () => {
  for (const text of [C098, C070]) {
    assert.equal(safety.recordedCurrentBleedingForTreatment(text), true, text.slice(0, 20));
    assert.equal(safety.activeBleedingInGroundingText(text), true);
  }
  for (const text of [
    "主诉：咳嗽2周\n现病史：咳嗽，咳白痰，否认咯血。",
    "主诉：咳嗽2周\n现病史：咳嗽，咳白痰。\n既往史：既往支气管扩张咯血史",
    "主诉：胸闷1月\n用药史：华法林长期服用\n现病史：胸闷，无牙龈出血，无黑便。",
    "主诉：月经量多3月\n现病史：经量增多，色红。",
  ]) assert.equal(safety.recordedCurrentBleedingForTreatment(text), false, text);
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "黄芪" }, { name: "丹参" }], C070), "herb_1_special_population_high_risk_bleeding_anticoagulation");
});

await check("3.2 红旗里的出血只是「需排除」的情况、病历没记载出血时，提示写「出血尚未排除」（C068）；病历记载出血的照旧写活动性出血；辨证路由用同一判据", () => {
  const c068 = "主诉：下腹痛伴发热3天\n现病史：下腹持续痛，性交后加重，伴黄色分泌物增多，近1天发热。";
  const flags = ["现有资料提示需立即急诊评估（需排除：急性盆腔炎/盆腔脓肿进展为脓毒症、异位妊娠破裂或流产伴腹腔内出血），原文依据：“下腹持续痛，性交后加重”"];
  assert.equal(safety.activeBleedingWording(c068, flags), "to_exclude");
  assert.equal(safety.activeBleedingWording(C098, flags), "recorded");
  const m04 = bleedingRules.activeBleedingM04Rule("to_exclude");
  assert.match(m04, /出血尚未排除/);
  assert.doesNotMatch(m04, /（活动性出血不宜活血化瘀）/);
  assert.equal(bleedingRules.activeBleedingM04Rule("recorded"), bleedingRules.ACTIVE_BLEEDING_M04_RULE);
  assert.match(bleedingRules.activeBleedingM03Rule("to_exclude"), /不要写成本例已有活动性出血/);
  const route = fs.readFileSync("src/app/api/diagnosis/diagnose/route.ts", "utf8");
  assert.match(route, /activeBleedingInGroundingText\(bleedingContext\)/);
  assert.doesNotMatch(route, /hasActiveBleedingRedFlag\(gated/);
});

await check("3.3 出血时开方提示列出本系统归为活血化瘀药的饮片（降香、郁金在列；C098 模型按旧版教材把降香当化瘀止血药作君）；有毒、破血逐瘀的不点名、按类写；化瘀止血药不在列", () => {
  const rule = bleedingRules.ACTIVE_BLEEDING_M04_RULE;
  const listed = rule.slice(rule.indexOf("归为活血化瘀药的有："), rule.indexOf("以及破血逐瘀类药"));
  for (const herb of ["降香", "郁金", "丹参", "川芎", "鸡血藤", "桃仁"]) assert.ok(listed.includes(herb), herb);
  for (const herb of ["斑鳌", "水蛭", "马钱子", "穿山甲", "三七", "蒲黄", "花蕊石"]) assert.ok(!listed.includes(herb), herb);
  assert.match(bleedingRules.activeBleedingM04Rule("to_exclude"), /归为活血化瘀药的有：[^；]*降香/);
});

await check("3.4 定稿剔除：药引/辅料（竹沥、姜汁）写成毫升或「适量」、没有克数且不是君药时单味拿出（C048 双合汤带竹沥整页退成非剂量）；写了克数或是君药的照留", async () => {
  const pruning = await jiti.import("../src/lib/m04-modification-safety.ts");
  const content = (herbs) => `前文\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "双合汤加减", herbs, formulaAnalysis: herbs.map((herb) => `${herb.name}为${herb.role}`).join("，") + "。" }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
  const candidateOf = (text) => JSON.parse(text.slice(text.indexOf("<!-- DIAGNOSIS_JSON_START -->") + 29, text.indexOf("<!-- DIAGNOSIS_JSON_END -->"))).formula.candidates[0];
  const herbs = (dose) => [{ name: "当归", role: "君", dose: "10g" }, { name: "川芎", role: "臣", dose: "6g" }, { name: "半夏", role: "佐", dose: "9g" }, { name: "竹沥", role: "佐", dose }, { name: "甘草", role: "使", dose: "6g" }];
  const pruned = candidateOf(pruning.dropSafetyConflictingM04CandidateHerbs(content(herbs("30ml")), "关节肿痛3月。"));
  assert.ok(!pruned.herbs.some((herb) => herb.name === "竹沥"));
  assert.match(pruned.notApplicable, /竹沥（药引\/辅料/);
  assert.ok(candidateOf(pruning.dropSafetyConflictingM04CandidateHerbs(content(herbs("10g")), "关节肿痛3月。")).herbs.some((herb) => herb.name === "竹沥"), "写了克数的照留");
});

// ---------- 4 成人用了儿科病名 ----------
await check("4.1 成人的「反复（上）呼吸道感染」确定性改名：本次有急性呼吸道感染表现写急性上呼吸道感染，否则写症状层面（甲方测评病历 5）；儿童不动；核对的 D 类不再留「原病名待查」", () => {
  const r5 = "主诉：反复上呼吸道感染1年余\n现病史：患者1年余前开始出现反复“上呼吸道感染”，近1年发作约9次。平素伴乏力、气短、自汗。";
  assert.equal(western.deterministicWesternNameCorrection("反复上呼吸道感染待查", r5, 78)?.supportedName, "乏力待查");
  assert.equal(western.deterministicWesternNameCorrection("反复上呼吸道感染", "主诉：反复感冒2年，本次咽痛、流涕2天\n现病史：2天前受凉后咽痛、流涕。", 40)?.supportedName, "急性上呼吸道感染");
  assert.equal(western.deterministicWesternNameCorrection("反复呼吸道感染", r5, 6), undefined);
  const source = fs.readFileSync("src/lib/western-name-evidence-check.server.ts", "utf8");
  assert.match(source, /!pediatricOnlyWesternName\(current\)/);
});

// ---------- 5 上消化道类目 ----------
await check("5.1 事实层「上消化道警示征象」类目写明乳房、甲状腺、淋巴结等消化道以外的肿块不属本类（C069 乳腺癌家族史＋乳房结节被归到这里）；提示词版本随之升级", () => {
  assert.match(facts.BACKSTOP_RED_FLAG_CATEGORIES.gi_alarm, /乳房、甲状腺、淋巴结等消化道以外的肿块不属本类/);
  assert.equal(facts.CLINICAL_FACTS_PROMPT_VERSION, "tcm-cdss-clinical-facts-triage-prompt-v28");
});

await check("5.2 事实层归到上消化道警示、而引文里一个消化道词也没有的（C069「洗澡时触及无痛肿块」）改记 other_critical，档位不变；病理写法的消化道癌（「胃窦腺癌」）与吞咽、消瘦照旧", () => {
  const source = "主诉：左乳无痛性结节1个月。现病史：洗澡时触及无痛肿块。既往史：母亲有乳腺癌史。病理示胃窦腺癌。近2月吞咽干硬食物时有梗阻感。";
  const finding = (quote) => ({ category: "gi_alarm", subject: "patient", status: "positive", urgency: "urgent", triageBasis: "urgent_review", quote });
  const grounded = facts.groundClinicalFacts({ redFlags: [finding("洗澡时触及无痛肿块"), finding("病理示胃窦腺癌"), finding("近2月吞咽干硬食物时有梗阻感")], semanticStatus: "checked" }, source);
  assert.deepEqual(grounded.redFlags.map((item) => `${item.category}/${item.urgency}`), ["other_critical/urgent", "gi_alarm/urgent", "gi_alarm/urgent"]);
});

// ---------- 6 辨证依据漏讲 ----------
await check("6.1 辨证依据漏讲两项以上已记录表现才重写；两字片段算提到（「大便稀溏」与「便溏」）", () => {
  const rationale = "头痛隐痛、遇劳加重、伴头晕心悸、面色少华，舌淡苔白脉细弱，为产后血虚、清窍失养，故属血虚头痛。";
  const findings = ["神疲乏力", "食欲下降", "小便清长", "大便稀溏", "头晕"];
  assert.deepEqual(coverage.missingRationaleFindings(rationale, findings), ["神疲乏力", "食欲下降", "小便清长", "大便稀溏"]);
  assert.equal(coverage.rationaleNeedsCoverageRewrite(["神疲乏力"], findings), false);
  assert.equal(coverage.rationaleNeedsCoverageRewrite(["神疲乏力", "食欲下降"], findings), true);
  assert.equal(coverage.rationaleMentionsFinding("脾虚便溏", "大便稀溏"), true);
});

await check("6.3 辨证依据清单把病历记录的舌象、脉象排在最前（甲方病历 3、11「证候分析不全面」，依据没引舌淡白、脉细弱）；未记录的不列", async () => {
  const checklist = await jiti.import("../src/lib/rationale-findings-checklist.ts");
  const types = await jiti.import("../src/lib/diagnosis-types.ts");
  const state = types.normalizeCaseStateInput({ chiefComplaint: "头痛2+月", patient: { sex: "女", age: 32 }, symptoms: { 现病史: "产后头痛，隐痛，神疲乏力，食欲下降。" }, tongue: "舌淡白，苔薄白", pulse: "脉细弱" });
  state.clinicalFacts = { affirmedSymptoms: [{ term: "神疲乏力", quote: "神疲乏力" }, { term: "食欲下降", quote: "食欲下降" }] };
  const items = checklist.rationaleFindingsChecklist(state);
  assert.deepEqual(items.slice(0, 2).map((item) => item.replace(/[,，]/g, "")), ["舌淡白苔薄白", "脉细弱"]);
  assert.match(checklist.rationaleFindingsChecklistNotice(state), /舌象、脉象也要写进推理/);
  const none = types.normalizeCaseStateInput({ chiefComplaint: "头痛", patient: { sex: "女", age: 32 }, symptoms: { 现病史: "头痛" }, tongue: "未记录", pulse: "" });
  none.clinicalFacts = { affirmedSymptoms: [] };
  assert.deepEqual(checklist.rationaleFindingsChecklist(none), []);
  // 没能看到（患儿不配合）不是所见，不列（C079 被逼着解释「脉象难配合」）。
  const child = types.normalizeCaseStateInput({ chiefComplaint: "腹泻1天", patient: { sex: "男", age: 2 }, symptoms: { 现病史: "腹泻" }, tongue: "舌淡红，苔薄白", pulse: "脉象难配合" });
  child.clinicalFacts = { affirmedSymptoms: [] };
  assert.deepEqual(checklist.rationaleFindingsChecklist(child).map((item) => item.replace(/[,，]/g, "")), ["舌淡红苔薄白"]);
  // 依据只罗列症状、没引舌脉时算漏讲。
  assert.deepEqual(coverage.missingRationaleFindings("产后头痛隐痛，故属血虚头痛；神疲乏力为气血不足；食欲下降为脾虚。", items), ["舌淡白,苔薄白", "脉细弱"]);
});

// 本地假模型：按请求里的任务回不同的 JSON。
async function withStubModel(reply, run) {
  const bodies = [];
  const server = createServer(async (req, res) => {
    if (await answerNonModelRequest(req, res)) return;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    const content = reply(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const overrides = { AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "synthetic-key", OPENAI_MODEL: "deepseek-flash", OPENAI_BASE_URL: baseUrl, CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash", CDSS_TEXT_MODEL_ALLOWED_HOSTS: "127.0.0.1", CDSS_SMALL_TASK_MEMO: "false" };
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    return await run(bodies);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise((resolve) => server.close(resolve));
  }
}

const tcmHalf = (rationale) => JSON.stringify({ overview: { tcmDiseaseName: "头痛", primarySyndrome: "血虚头痛", secondarySyndromes: [], tcmDiagnosticRationale: rationale } });
const record3 = "主诉：头痛2+月\n现病史：产后出现头痛，呈隐痛，遇疲劳加重，伴头晕、心悸、神疲乏力。食欲下降，睡眠差，小便清长，大便稀溏。";
const shortRationale = "头痛隐痛、遇劳加重、伴头晕心悸，舌淡苔白脉细弱，为产后血虚、清窍失养，故属血虚头痛。";
const findings3 = ["神疲乏力", "食欲下降", "小便清长", "大便稀溏", "心悸"];

await check("6.2 重写稿补上全部漏讲项、原稿已讲到的最多丢一项才采用；漏项、出现主证以外的证名都不采用（原样返回）", async () => {
  const good = "头痛隐痛、遇劳加重为产后血虚、清窍失养；头晕心悸为血不养心；神疲乏力、食欲下降为脾虚气血生化不足而失养；小便清长、大便稀溏为脾阳不振、运化失司；舌淡苔白脉细弱亦属血虚，故属血虚头痛。";
  await withStubModel(() => JSON.stringify({ rationale: good }), async (bodies) => {
    const out = JSON.parse(await coverage.completeRationaleCoverage(tcmHalf(shortRationale), { recordText: record3, findings: findings3 }));
    assert.equal(out.overview.tcmDiagnosticRationale, good);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0].messages[1].content, /原依据漏了：神疲乏力、食欲下降、小便清长、大便稀溏/);
  });
  // 原稿已讲到的丢一项仍采用（清单项多时一字不漏的稿子大多超长）。
  const dropsOne = "头痛隐痛、遇劳加重为产后血虚、清窍失养；神疲乏力、食欲下降为脾虚气血生化不足而失养；小便清长、大便稀溏为脾阳不振、运化失司；舌淡苔白脉细弱亦属血虚之象，故属血虚头痛。";
  await withStubModel(() => JSON.stringify({ rationale: dropsOne }), async () => {
    const out = JSON.parse(await coverage.completeRationaleCoverage(tcmHalf(shortRationale), { recordText: record3, findings: findings3 }));
    assert.equal(out.overview.tcmDiagnosticRationale, dropsOne, "漏讲项都补上、原稿讲到的心悸丢了一项，仍采用");
  });
  for (const bad of [
    "头痛隐痛、遇劳加重为产后血虚、清窍失养；头晕心悸为血不养心；神疲乏力为气血不足、形神失养；舌淡苔白脉细弱亦属血虚，故属血虚头痛。",
    "头痛隐痛为血虚；神疲乏力、食欲下降、小便清长、大便稀溏、心悸为脾肾阳虚证之象，故属血虚头痛。",
  ]) {
    await withStubModel(() => JSON.stringify({ rationale: bad }), async () => {
      const out = await coverage.completeRationaleCoverage(tcmHalf(shortRationale), { recordText: record3, findings: findings3 });
      assert.equal(JSON.parse(out).overview.tcmDiagnosticRationale, shortRationale, bad.slice(0, 20));
    });
  }
  // 没漏够两项时不发请求。
  await withStubModel(() => "{}", async (bodies) => {
    await coverage.completeRationaleCoverage(tcmHalf(shortRationale), { recordText: record3, findings: ["心悸", "头晕", "神疲乏力", "遇劳加重"] });
    assert.equal(bodies.length, 0);
  });
});

await check("6.4 外来证名只看「…证」片段里的证名本身：「无兼证」「以下按常规辨证」「可佐证」「属湿热中阻之主证」「属痰浊阻肺兼证」（兼证有它）不算；主证兼证以外的证名、改头换面的证名照旧算", () => {
  const input = { rationale: "发热、脉浮数，属邪在卫分。", primary: "湿热中阻证", secondary: ["痰浊阻肺证"] };
  for (const ok of [
    "吐泻交作，属湿热中阻之主证；咳白痰属痰浊阻肺兼证。另无兼证，可佐证气机不畅，不另立证，可与他证相别。",
    "吐泻交作，故属湿热中阻主证。从温病卫气营血看，本例属卫分证，以下按常规辨证处理。",
    "发热脉浮数属卫分证，吐泻为湿热中阻证。",
    "吐泻为湿热中阻证。从六经方证看，本例咽中如有炙脔与半夏厚朴汤证相合，以下按常规辨证处理。",
  ]) assert.deepEqual(coverage.foreignSyndromeNames(ok, input), [], ok.slice(0, 16));
  assert.deepEqual(coverage.foreignSyndromeNames("吐泻交作属湿热中阻证；胁胀属肝郁脾虚证。", input), ["肝郁脾虚证"]);
  assert.deepEqual(coverage.foreignSyndromeNames("吐泻交作，故属脾肾阳虚之兼证。", input), ["脾肾阳虚证"], "「X之兼证」取 X");
  assert.deepEqual(coverage.foreignSyndromeNames("头晕心悸，属兼证痰浊阻肺证之象；咽部堵塞感为痰气郁结于咽的主证表现。", input), []);
  assert.deepEqual(coverage.foreignSyndromeNames("吐泻交作，故属脾肾阳虚兼证。", input), ["脾肾阳虚证"]);
  // 病名接「证」、病历原话接「证」、「支持本证」「不列证」不算外来证名。
  assert.deepEqual(coverage.foreignSyndromeNames("心悸阵作属心悸证范畴；舌红支持本证，不列证。", { ...input, disease: "心悸" }), []);
  assert.deepEqual(coverage.foreignSyndromeNames("心悸阵作属心悸证范畴。", input), ["心悸证"], "病名不在时照算");
  assert.equal(coverage.syndromeNameInSpan("以下按常规辨证"), undefined);
  assert.equal(coverage.syndromeNameInSpan("故属阳虚水泛主证"), "阳虚水泛证");
});

await check("6.5 主诉里的主症：事实层词条出现在主诉里，或与主诉有三个字连着相同（病历 10「月经周期缩短」对事实层「月经周期提前」）；主诉栏是姓名、病名清单时不取", async () => {
  const checklist = await jiti.import("../src/lib/rationale-findings-checklist.ts");
  const types = await jiti.import("../src/lib/diagnosis-types.ts");
  const state = types.normalizeCaseStateInput({ chiefComplaint: "月经周期缩短半年余，加重1月", patient: { sex: "女", age: 35 }, symptoms: { 现病史: "月经周期提前至二十二天即来潮，经量较前明显增多，心烦易怒。" } });
  state.clinicalFacts = { affirmedSymptoms: [{ term: "月经周期提前", quote: "月经周期提前至二十二天即来潮" }, { term: "经量增多", quote: "经量较前明显增多" }, { term: "心烦易怒", quote: "心烦易怒" }] };
  assert.deepEqual(checklist.chiefComplaintFindings(state), ["月经周期提前"]);
  const named = types.normalizeCaseStateInput({ chiefComplaint: "杨立，男，12岁，因活动后头晕、乏力就诊", patient: { sex: "男", age: 12 }, symptoms: { 现病史: "活动后头晕、乏力5年。" } });
  named.clinicalFacts = { affirmedSymptoms: [{ term: "头晕", quote: "头晕" }, { term: "乏力", quote: "乏力" }] };
  assert.deepEqual(checklist.chiefComplaintFindings(named), ["头晕", "乏力"]);
  // 事实层这一次没抽到主症：退用主诉原话（至少四个字、现病史里对得上）。
  const noFact = types.normalizeCaseStateInput({ chiefComplaint: "月经周期缩短半年余，加重1月", patient: { sex: "女", age: 35 }, symptoms: { 现病史: "月经周期提前至二十二天即来潮，经量较前明显增多。" } });
  noFact.clinicalFacts = { affirmedSymptoms: [{ term: "经量增多", quote: "经量较前明显增多" }] };
  assert.deepEqual(checklist.chiefComplaintFindings(noFact), ["月经周期缩短"]);
  const nameOnly = types.normalizeCaseStateInput({ chiefComplaint: "杨立，男，12岁", patient: { sex: "男", age: 12 }, symptoms: { 现病史: "杨立近5年活动后头晕。" } });
  nameOnly.clinicalFacts = { affirmedSymptoms: [] };
  assert.deepEqual(checklist.chiefComplaintFindings(nameOnly), []);
  assert.equal(checklist.chiefComplaintPhrase("尿频、尿量多半年"), "尿频、尿量多");
});

await check("6.6 依据没讲到主症时单凭这一项也重写，主症排在漏项最前；主症换了写法（「胃痛」与「胃脘胀痛」、「多汗」与「汗多」）算讲到，不发请求", async () => {
  const half = (rationale) => JSON.stringify({ overview: { tcmDiseaseName: "月经先期", primarySyndrome: "阳盛血热证", secondarySyndromes: [], tcmDiagnosticRationale: rationale } });
  const original = "经量多、色紫红质稠、血块多，为热灼血分、迫血妄行，故属阳盛血热证；心烦易怒为肝郁化火。";
  const rewritten = "月经周期提前、经量多、色紫红质稠、血块多，为热扰冲任、迫血妄行，故属阳盛血热证；心烦易怒为肝郁化火、扰动冲任。";
  await withStubModel(() => JSON.stringify({ rationale: rewritten }), async (bodies) => {
    const out = JSON.parse(await coverage.completeRationaleCoverage(half(original), { recordText: "月经周期缩短半年余", findings: ["经量增多", "心烦易怒", "色紫红", "血块增多"], chiefFindings: ["月经周期提前"] }));
    assert.equal(out.overview.tcmDiagnosticRationale, rewritten);
    assert.equal(bodies.length, 1, "清单其余四项都讲到了，只漏主症也要重写");
    assert.match(bodies[0].messages[1].content, /原依据漏了：月经周期提前）/);
  });
  await withStubModel(() => "{}", async (bodies) => {
    await coverage.completeRationaleCoverage(half("胃脘胀痛、得嗳气则舒，为肝气犯胃，故属肝气犯胃证；动则汗多为气虚。"), { recordText: "胃痛半月", findings: ["嗳气"], chiefFindings: ["胃痛", "多汗"] });
    assert.equal(bodies.length, 0);
  });
  assert.equal(coverage.rationaleMentionsChiefSymptom("右下牙持续性胀痛", "牙痛"), true);
  assert.equal(coverage.rationaleMentionsChiefSymptom("经量多、色紫红", "月经周期提前"), false);
});

await check("6.7 证素核对撤下名外证素时，分句前半的病历表现（含舌脉）留下、归属改成待核实；没有归属词或前半太短的照旧整句删（甲方病历 3 本地三次连舌脉一起删掉）", async () => {
  const element = await jiti.import("../src/lib/m03-element-support.server.ts");
  const root = () => ({
    overview: { tcmDiseaseName: "头痛", primarySyndrome: "血虚头痛", secondarySyndromes: [],
      tcmDiagnosticRationale: "产后头痛隐隐、遇劳加重，故属血虚头痛；神疲乏力、面色少华、舌淡白、脉细弱为气血亏虚失养；食欲下降、大便稀溏为脾气虚弱、运化失司。从扶阳学派看阴阳实据，本例未见阳虚阴盛实据，以下按常规辨证处理。",
      overallPathogenesis: "产后血虚，清窍失养" },
    pathogenesis: { natureDifferentiation: { items: ["血虚", "气虚"] }, uncertainties: [],
      chain: [{ pathogenesis: "血虚不能上荣清窍", therapyDirection: "养血" }, { pathogenesis: "脾气虚弱，运化失司", therapyDirection: "健脾益气" }] },
    therapy: { overallMethod: "养血疏风，健脾益气" },
  });
  const units = element.elementCheckUnits(root());
  assert.ok(units.length > 0);
  const failed = { verdicts: units.map((unit) => ({ unit, verdict: { verdict: "fail", entry: unit.entryName, specific: 0, category: 0, listed: 0, distinct: 0 } })) };
  const out = JSON.parse(element.applyElementSupportDecision(JSON.stringify(root()), failed, "养血疏风"));
  const rationale = out.overview.tcmDiagnosticRationale;
  assert.match(rationale, /舌淡白、脉细弱/, "舌脉留下");
  assert.match(rationale, /食欲下降、大便稀溏/);
  assert.match(rationale, /是否兼.{1,4}虚尚待核实。从扶阳学派看/, "待核实一句放在流派那句之前");
  assert.doesNotMatch(rationale, /气血亏虚失养|脾气虚弱/);
  // 依据其余部分已讲到的表现不再放进待核实一句（舌脉已归到主证）。
  const explained = root();
  explained.overview.tcmDiagnosticRationale = "产后头痛隐隐，伴心悸、舌淡白、脉细弱，为血虚不能上荣，故属血虚头痛；心悸、舌淡白、脉细弱进一步支持气血亏虚；食欲下降、大便稀溏为脾气虚弱。";
  const explainedOut = JSON.parse(element.applyElementSupportDecision(JSON.stringify(explained), failed, "养血疏风")).overview.tcmDiagnosticRationale;
  assert.match(explainedOut, /；食欲下降、大便稀溏，是否兼.{1,4}虚尚待核实。$/);
  assert.equal(explainedOut.match(/舌淡白/g)?.length, 1);
  // 归属单独成分句（「…，为气虚失养」）：前面那串表现一并移进待核实，不留一串没有归属的表现。
  const split = root();
  split.overview.tcmDiagnosticRationale = "产后头痛隐隐，故属血虚头痛；遇劳加重、神疲乏力、精神不振，为气虚失养；睡眠差为血不养心。";
  const splitOut = JSON.parse(element.applyElementSupportDecision(JSON.stringify(split), failed, "养血疏风")).overview.tcmDiagnosticRationale;
  assert.match(splitOut, /^产后头痛隐隐，故属血虚头痛；睡眠差为血不养心。遇劳加重、神疲乏力、精神不振，是否兼.{1,4}虚尚待核实。$/);
  assert.equal(element.findingsBeforeAttribution("舌淡白、脉细弱进一步支持气血亏虚", new Set(["气虚"]), new Map([["血虚", "any"]])), "舌淡白、脉细弱");
  assert.equal(element.findingsBeforeAttribution("示气血亏虚", new Set(["气虚"]), new Map([["血虚", "any"]])), undefined);
  assert.equal(element.findingsBeforeAttribution("脾运不健则化源不足而气虚", new Set(["气虚"]), new Map([["血虚", "any"]])), undefined, "没有归属词");
});

await check("6.8 方义「以X易之」而X本在原方组成里（消风散有地黄：「以生地黄易之」，本地甲方病历 9）：去掉这一小句；「之」前面有被去掉的药（「去原方熟地之滋腻，以生地黄易之」）时照留（对照）", async () => {
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  const analysisOf = (name, herbs, analysis) => projectDeliveredReasoning({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name, formulaAnalysis: analysis, herbs: herbs.map((herb) => ({ name: herb })) }] },
    nonPharma: { precautions: [] },
  }).formula.candidates[0].formulaAnalysis;
  const xiaofengHerbs = ["荆芥", "防风", "蝉蜕", "牛蒡子", "苦参", "知母", "石膏", "生地黄", "当归", "苍术", "黑芝麻", "川木通", "甘草"];
  assert.equal(analysisOf("消风散加减", xiaofengHerbs, "本方以消风散为基础加减，以生地黄易之。荆芥、防风为君。"), "本方以消风散为基础加减。荆芥、防风为君。");
  const control = "本方以桃红四物汤为基础加减，去原方熟地之滋腻，以生地黄易之。桃仁、红花为君。";
  assert.equal(analysisOf("桃红四物汤加减", ["桃仁", "红花", "当归", "川芎", "白芍", "生地黄"], control), control);
});

// ---------- 7 居家穴位保健 ----------
const pool = JSON.parse(fs.readFileSync("src/data/tcm-home-acupressure-points.source.json", "utf8"));
const oldCare = JSON.parse(fs.readFileSync("src/data/tcm-home-acupoint-care.source.json", "utf8"));
await check("7.1 候选穴表：34 个穴、名字不重复、标准定位与主治非空；已在用的 13 个穴患者定位逐字沿用", () => {
  assert.equal(pool.points.length, 34);
  assert.equal(new Set(pool.points.map((point) => point.name)).size, 34);
  for (const point of pool.points) {
    assert.ok(point.standardLocation.length >= 6 && point.indications.length >= 4 && point.patientLocation.length >= 6, point.name);
    assert.ok(point.corpusRef?.locationLine > 0, point.name);
  }
  const old = new Map(Object.values(oldCare.constitutions).flatMap((entry) => [...entry.acupressure.points, ...(entry.extraPoints || [])]).map((point) => [point.name, point.patientLocation]));
  for (const [name, location] of old) assert.equal(pool.points.find((point) => point.name === name)?.patientLocation, location, name);
});

const authoringInput = (overrides = {}) => ({ disease: "胃痛", primarySyndrome: "肝气犯胃证", secondarySyndromes: [], method: "疏肝理气，和胃止痛", findings: ["胃脘胀痛", "嗳气", "心烦易怒"], ageYears: 36, sex: "男", pregnancyUnresolved: false, moxibustionAllowed: false, ...overrides });
await check("7.2 模型选穴只认表里的穴；妊娠状态未写明时去掉孕期禁用穴与腹部、腰骶部穴；理由带时长剂量或禁用语不收；艾灸只在本例允许时收", () => {
  const parse = (value, input = authoringInput()) => authoring.parseAuthoredHomeAcupoint(JSON.stringify(value), input);
  assert.deepEqual(parse({ points: [{ name: "内关", reason: "和胃止痛，缓解胃脘胀痛" }, { name: "太冲", reason: "疏肝理气，帮助平复心烦易怒" }], moxibustion: null })?.points.map((point) => point.name), ["内关", "太冲"]);
  assert.equal(parse({ points: [{ name: "四缝", reason: "消食化积" }] }), undefined, "表外穴");
  assert.equal(parse({ points: [{ name: "内关", reason: "每次按揉5分钟效果好" }] }), undefined, "带时长");
  const pregnant = authoringInput({ sex: "女", ageYears: 30, pregnancyUnresolved: true });
  assert.equal(parse({ points: [{ name: "合谷", reason: "理气止痛" }] }, pregnant), undefined, "孕期禁用穴");
  assert.equal(parse({ points: [{ name: "中脘", reason: "和胃止痛" }] }, pregnant), undefined, "腹部");
  assert.ok(parse({ points: [{ name: "内关", reason: "和胃止痛，缓解胃脘胀痛" }] }, pregnant));
  const withMoxa = parse({ points: [{ name: "足三里", reason: "健脾益气，帮助改善乏力纳差" }], moxibustion: { points: ["气海"], reason: "温阳益气" } }, authoringInput({ moxibustionAllowed: true }));
  assert.deepEqual(withMoxa?.moxibustion?.points, ["气海"]);
  assert.equal(parse({ points: [{ name: "足三里", reason: "健脾益气，帮助改善乏力纳差" }], moxibustion: { points: ["气海"], reason: "温阳益气" } })?.moxibustion, undefined, "本例不许艾灸");
});

await check("7.3 排版：腹部穴用掌根、其余用指腹，手法时长与注意事项取技术规范原文；医师项目已用的穴不再让患者按，选的穴全在项目卡上时照给", () => {
  const authored = { points: [{ name: "中脘", reason: "和胃止痛，缓解胃脘胀痛" }, { name: "内关", reason: "和胃降逆，减轻嗳气" }] };
  const text = authoring.renderAuthoredHomeAcupointCare(authored, { moxibustionAllowed: false });
  assert.match(text, /^按揉中脘、内关。取穴：中脘在上腹部正中线上[^；]*；内关在手掌朝上[^。]*。/);
  assert.match(text, /手法：内关用拇指或中指指腹[^；]*；中脘用掌根/);
  assert.doesNotMatch(text, /（[^）]*（/, "不套括号");
  assert.match(text, /中脘：和胃止痛，缓解胃脘胀痛；内关：和胃降逆，减轻嗳气。/);
  assert.ok(text.includes(oldCare.cautions.acupressure));
  assert.doesNotMatch(text, /艾灸/);
  assert.match(authoring.renderAuthoredHomeAcupointCare(authored, { clinicianPointText: "内关、足三里" }) || "", /^按揉中脘。取穴：中脘在/, "内关已在医师项目卡上，只留中脘");
  // 选的穴全在医师项目卡上时照给（不退回与本例无关的固定段落）。
  assert.match(authoring.renderAuthoredHomeAcupointCare(authored, { clinicianPointText: "中脘、内关" }) || "", /^按揉中脘、内关。/);
  assert.equal(authoring.renderAuthoredHomeAcupointCare({ points: [{ name: "四缝", reason: "消食化积" }] }, {}), null, "表外穴不排版");
});

const evidence = { sourceType: "patient_fact", sourceRef: "chiefComplaint", quote: "相关症状" };
const m03 = (primarySyndrome, natureItems) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "虚劳", primarySyndrome, overallPathogenesis: primarySyndrome, overallTherapy: "调理", recommendedFormulaDirection: "无", evidence },
  westernDiagnosis: { primary: { name: "乏力待查", status: "考虑", confidence: "中", supportingFacts: [], limitations: [], suggestedChecks: [], evidence }, differentials: [] },
  pathogenesis: { summary: primarySyndrome, locationDifferentiation: { items: ["脾"], evidence }, natureDifferentiation: { items: natureItems, evidence }, chain: [{ nodeId: "P1", patientFact: "乏力", syndromeEvidence: primarySyndrome, pathogenesis: primarySyndrome, therapyDirection: "健脾益气", evidence }], uncertainties: [] },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "健脾益气", subTherapies: [] },
  formula: null, nonPharma: null, lineageAdaptation: null,
});
const readyGate = { status: "ready", allowDiagnosis: true, allowDosePrescription: true, candidateMode: "full_dose", action: "proceed", missingItems: [], redFlags: [] };
const caseFor = (overrides = {}) => ({ patient: { sex: "男", age: 52 }, chiefComplaint: "乏力纳差2月", symptoms: { presentHistory: "乏力，食后腹胀，大便偏溏" }, pastHistory: "否认高血压、糖尿病史", medicationHistory: "否认当前用药", allergyHistory: "否认药物过敏", vitals: { T: "36.5℃", P: "76次/分", R: "18次/分", BP: "122/76mmHg" }, safetyGate: readyGate, ...overrides });
const careFor = (prior, caseState, authored) => {
  // 输入里放一个哨兵：applyTcmTreatmentCapabilityPriority 出错时原样返回输入，哨兵会留下来，不会被误当成「安全门给了 null」。
  const raw = { ...prior, stage: "prescribe", nonPharma: { diet: "清淡", lifestyle: "规律作息", emotion: "舒畅", acupointCare: "SENTINEL-模型自拟", tcmTreatments: [], precautions: [] } };
  const out = capabilities.applyTcmTreatmentCapabilityPriority(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(raw)}\n<!-- DIAGNOSIS_JSON_END -->`, caseState, prior, { authoredHomeAcupoint: authored });
  return JSON.parse(out.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]).nonPharma.acupointCare;
};
await check("7.4 交付：成人且技术规范段落给得出时用模型选的穴与理由；红旗、儿童照旧（红旗不给、儿童用规范段落）；模型那份没有时用规范段落；生成前就能算出输入", () => {
  const prior = m03("脾气虚证", ["气虚"]);
  const authored = { points: [{ name: "足三里", reason: "健脾益气，帮助改善乏力纳差" }] };
  const adult = careFor(prior, caseFor(), authored);
  assert.match(adult || "", /^按揉足三里。取穴：足三里在[^。]*。手法：用拇指或中指指腹/);
  assert.match(adult || "", /足三里：健脾益气，帮助改善乏力纳差/);
  const template = careFor(prior, caseFor(), undefined);
  assert.match(template || "", /气海/, "模型那份没有时用技术规范段落");
  assert.equal(careFor(prior, caseFor({ safetyGate: { ...readyGate, status: "red_flag", redFlags: ["x"], candidateMode: "limited_dose" } }), authored), null);
  // 妊娠阳性：技术规范段落按「推拿」项目禁忌整段不给，模型选的穴也不给。
  assert.equal(careFor(prior, caseFor({ patient: { sex: "女", age: 30 }, symptoms: { presentHistory: "妊娠12周，乏力，食后腹胀" } }), authored), null);
  const child = careFor(prior, caseFor({ patient: { sex: "女", age: 2 } }), authored);
  assert.doesNotMatch(child || "", /足三里：健脾益气/);
  const input = capabilities.homeAcupointAuthoringInputForCase(prior, caseFor(), ["乏力纳差2月", "食后腹胀"]);
  assert.equal(input?.primarySyndrome, "脾气虚证");
  assert.equal(input?.ageYears, 52);
  assert.equal(capabilities.homeAcupointAuthoringInputForCase(prior, caseFor({ patient: { sex: "女", age: 2 } }), []), undefined);
});

await check("7.5 小模型按本例选穴：请求里有本例诊断、表现与候选穴主治；回的 JSON 经校验后返回；路由在开方一开始发出、候选定稿时等它", async () => {
  await withStubModel(() => JSON.stringify({ points: [{ name: "内关", reason: "和胃止痛，缓解胃脘胀痛" }], moxibustion: null }), async (bodies) => {
    const out = await authoring.authorHomeAcupointCare(authoringInput());
    assert.deepEqual(out?.points, [{ name: "内关", reason: "和胃止痛，缓解胃脘胀痛" }]);
    const user = bodies[0].messages[1].content;
    assert.match(user, /证候：肝气犯胃证/);
    assert.match(user, /胃脘胀痛、嗳气、心烦易怒/);
    assert.match(user, /- 内关（可自己按）：（1）心悸，心痛，胸闷。/);
  });
  const route = fs.readFileSync("src/app/api/diagnosis/prescribe/route.ts", "utf8");
  assert.match(route, /const homeAcupointAuthoring = homeAcupointInput \? authorHomeAcupointCare\(homeAcupointInput, signal\)/);
  assert.match(route, /Promise\.all\(\[\s*checkFormulaAnalysisClaimsInContent\(content, transformSignal\),\s*dropMisfitModifications\(content, transformSignal\),\s*homeAcupointAuthoring,?\s*\]\)/);
  assert.match(route, /\{ authoredHomeAcupoint \}\)/);
});

console.log(`r1037-main: ${cases} checks`);
