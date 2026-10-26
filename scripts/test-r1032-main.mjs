// 10/25 第二十轮（第十九轮评审留下的四类：未询问读成阳性、优先评估复诊与煎服法矛盾、晕厥伴窦性停搏漏红旗、模型把病历否认的写成有）。
//
//   1 一处记载的语境（clinicalAssertionContextAt）加「未评估」一维：是否/有无/未询问/尚未询问/不详/待核实……只管它所在的小句，
//     闸门、病历读法、否认照录核对、OSA 筛查共用；问答体按存在性问句与答句定有无；「有无/有没有」「无法X」不是否认词；
//     否认列举在正常所见（纳可、眠可）或频度起首的项（经常腹泻）处截断，逗号与顿号同一判据；整句的「不详」不再吞掉整句。
//   2 否认净化：病历肯定、模型否认时删掉这条否认（连同只回指它的结论尾句），不再改写成「病历已记录X阳性」；单值字段删空时退回旧写法；
//     辨病/辨证依据里以鉴别病证名为主语的否认不改；「未明显发热」是否认；倒装的「头痛剧烈」算记录了剧烈头痛。
//   3 给了剂量又要求先评估：复诊计划第一句与煎服法复诊节点是同一份计划（先评估 → 医生确认可服药 → 服完 N 剂复诊），M05 首次复诊同句。
//   4 晕厥/黑矇 + 心电记录的主要高危心律失常（清醒时停搏 ≥3 秒、二度 II 型/三度房室传导阻滞、室速）是确定性红旗（T6 syncope 数据）。
//   5 否认后逗号接着写的裸词，规则读法与事实模型都读成「没有」时，在 M03 两半与核对器里写明读法（A056）。
//   6 本例说法核对：片段在病历里只以否认形式出现时不再受「病历原文」保护。

import assert from "node:assert/strict";
import fs from "node:fs";
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

const D = await jiti.import("../src/lib/diagnosis-safety.ts");
const T = await jiti.import("../src/lib/diagnosis-types.ts");
const S = await jiti.import("../src/lib/delivered-surface.ts");
const RC = await jiti.import("../src/lib/prescription-regimen-contract.ts");
const CLAIM = await jiti.import("../src/lib/m03-patient-claim-check.server.ts");

const state = (presentHistory, extra = {}) => {
  const normalized = T.normalizeCaseStateInput({
    chiefComplaint: extra.chiefComplaint || "不适3天",
    symptoms: { presentHistory },
    conversation: [],
    patient: { sex: extra.sex || "男", age: extra.age ?? 50 },
    vitals: extra.vitals || { T: "36.6", P: "80", R: "18", BP: "120/76" },
  });
  return extra.clinicalFacts ? { ...normalized, clinicalFacts: extra.clinicalFacts } : normalized;
};
const json = (fields) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ x: fields })}\n<!-- DIAGNOSIS_JSON_END -->`;
const fieldsOf = (out) => JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).x;

// ───── 1 未评估一维 ─────
await check("1.1 是否/有无/未询问/尚未询问/情况未问/需询问：读成没记录；属性不详、问原因、答了有、未测体温照旧读有（C093）", () => {
  const absent = [["上腹痛3天。是否黑便尚未询问。", "黑便"], ["有无发热不详", "发热"], ["黑便情况未问", "黑便"], ["未询问有无呕血", "呕血"], ["需询问有无胸痛", "胸痛"], ["上消化道出血待排，黑便待排", "黑便"]];
  for (const [text, term] of absent) assert.equal(D.recordedFindingReading(text, term), "absent", text);
  const affirmed = [["腹痛性质不详", "腹痛"], ["发热，体温不详", "发热"], ["是否黑便：有", "黑便"], ["是否因受凉出现咳嗽", "咳嗽"], ["发热未测体温", "发热"], ["黑便2次", "黑便"]];
  for (const [text, term] of affirmed) assert.equal(D.recordedFindingReading(text, term), "affirmed", text);
  assert.equal(D.recordedFindingReading("无黑便", "黑便"), "denied");
});

await check("1.2 「不清/不明」常是症状名的一部分：神志不清、言语不清、构音不清照旧读有、照旧报神经红旗（回放里丢过 15 例）；「黑便情况不清楚」才算未评估", () => {
  for (const [text, term] of [["神志不清，呼之不应", "神志不清"], ["言语不清，右侧肢体无力", "言语不清"]]) assert.equal(D.recordedFindingReading(text, term), "affirmed", text);
  const gate = D.withSafetyGate(state("今晨突发言语不清，神志不清1小时。", { chiefComplaint: "突发言语不清1小时" })).safetyGate;
  assert.equal(gate.status, "red_flag");
  assert.equal(D.recordedFindingReading("黑便情况不清楚", "黑便"), "absent");
});

await check("1.3 整句的「（具体不详）」不再吞掉同句的「伴恶心」（B004）；同句后面的否认仍在，读成前后不一", () => {
  assert.equal(D.recordedFindingReading("头晕，伴恶心，无呕吐，予静脉滴注治疗（具体不详）。来诊时无恶心呕吐等不适", "恶心"), "conflicting");
});

await check("1.4 问答体：存在性问句按答句定（没有→否认、偶尔会有→有、答非所问→没记录，答句在下一段也认）；问属性的问句默认这个表现是有的", () => {
  assert.equal(D.recordedFindingReading("问：有没有发热或者呕吐 答：没有", "呕吐"), "denied");
  assert.equal(D.recordedFindingReading("问：请问一下，有没有发烧，反酸，呕吐等情况？ 答：没有这些情况。", "呕吐"), "denied");
  assert.equal(D.recordedFindingReading("问：有腹痛吗。 答：没有。", "腹痛"), "denied");
  assert.equal(D.recordedFindingReading("问：有没有恶心呕吐？ 答：偶尔会有。", "恶心"), "affirmed");
  assert.equal(D.recordedFindingReading("问：宝宝发热吗？ 答：吃奶没事", "发热"), "absent");
  assert.equal(D.recordedFindingReading("问：请问宝宝便秘多久了？ 答：4个月", "便秘"), "affirmed");
  assert.equal(D.recordedFindingReading("问：咳嗽厉害吗？有没有痰 答：厉害，有痰", "咳嗽"), "affirmed");
});

await check("1.5 「有无/有没有」「无法X」「漫无目的」里的字不是否认词；「无法排除呕血」仍是排除不了（不读成否认）", () => {
  assert.notEqual(D.recordedFindingReading("有无黑便不详", "黑便"), "denied");
  assert.equal(D.recordedFindingReading("整夜无法入睡，头痛，麻木", "头痛"), "affirmed");
  assert.equal(D.recordedFindingReading("左半身无法活动，语言不利，头晕", "头晕"), "affirmed");
  assert.notEqual(D.recordedFindingReading("无法排除呕血", "呕血"), "denied");
  // 「无法完全否认呕血」：情态 + 程度副词 + 否认词仍是排除不了（闸门保留出血信号，test:negation-presentation-parity）。
  assert.notEqual(D.recordedFindingReading("无法完全否认呕血", "呕血"), "denied");
  // 闸门一侧（isNegatedAt 的 NON_NEGATING_PHRASES）：「无法活动」的「无」不能把后面的言语不清读成否认。
  const gate = D.withSafetyGate(state("左半身无法活动，语言不利。", { chiefComplaint: "左半身活动不利", age: 66 })).safetyGate;
  assert.equal(gate.status, "red_flag", JSON.stringify(gate.redFlags));
  // 否认读者一侧（maskNonNegatingWuWords）：同一小句里「无法平卧伴胸闷」的「无」不否认胸闷。
  assert.equal(D.recordedFindingReading("夜间无法平卧伴胸闷", "胸闷"), "affirmed");
});

await check("1.6 否认列举在正常所见或频度起首的项处截断（A039「无口干口苦、纳可、眠可、经常腹泻」）；「否认呕血、黑便、持续剧烈腹痛」照旧整串否认；被测词之后的正常所见不截断", () => {
  assert.equal(D.recordedFindingReading("无口干口苦、纳可、眠可、经常腹泻", "腹泻"), "affirmed");
  assert.equal(D.recordedFindingReading("无发热，纳可，眠可，经常腹泻", "腹泻"), "affirmed");
  assert.equal(D.recordedFindingReading("无胸闷、心悸、时有胸痛", "胸痛"), "affirmed");
  assert.equal(D.recordedFindingReading("否认呕血、黑便、持续剧烈腹痛", "腹痛"), "denied");
  assert.notEqual(D.recordedFindingReading("咳嗽，无发热，胸闷，胸痛，纳可，眠可，二便调。", "胸痛"), "affirmed");
  const gate = D.withSafetyGate(state("头晕3天，否认呕血、黑便、持续剧烈腹痛。", { chiefComplaint: "头晕3天" })).safetyGate;
  assert.equal(gate.redFlags.length, 0, "整串否认不得报红旗");
});

await check("1.7 闸门：C093 形状（是否黑便尚未询问）不出消化道出血提示；写明黑便 2 次照报红旗", () => {
  const c093 = D.withSafetyGate(state("患者口述腹痛昨晚才开始，又称三天前就因疼痛请假；无呕血。是否黑便尚未询问。", { chiefComplaint: "上腹痛3天", sex: "女", age: 47 })).safetyGate;
  assert.ok(!(c093.advisories || []).some((item) => String(item).includes("消化道出血")), JSON.stringify(c093.advisories));
  const melena = D.withSafetyGate(state("上腹痛3天，解黑便2次。", { chiefComplaint: "上腹痛3天" })).safetyGate;
  assert.equal(melena.status, "red_flag");
});

// ───── 2 否认净化：删除而不是改写成阳性 ─────
await check("2.1 C093：「无黑便、呕血」→ 否认呕血＋黑便未记录；「无腹痛放射」整条删去；不再出现「阳性」", () => {
  const st = state("患者口述腹痛昨晚才开始，上腹痛3天；无呕血。是否黑便尚未询问", { chiefComplaint: "上腹痛3天" });
  const out = fieldsOf(D.sanitizeUngroundedRedFlagNegations(json({ againstEvidence: ["无腹痛放射", "无黑便、呕血"], distinguishingPoints: "无呕血，无黑便" }), st));
  assert.deepEqual(out.againstEvidence, ["病历已记录否认呕血；病历尚未确认黑便是否存在"]);
  assert.equal(out.distinguishingPoints, "无呕血，病历尚未确认黑便是否存在");
  assert.doesNotMatch(JSON.stringify(out), /阳性/);
});

await check("2.2 「未明显发热」是否认（C038）：模型的「无发热，体温36.8℃」原样保留", () => {
  const st = state("疼痛阵发放射至腹股沟，坐立不安，恶心，未明显发热。", { chiefComplaint: "左腰腹绞痛3小时" });
  assert.equal(D.recordedFindingReading("疼痛阵发放射至腹股沟，坐立不安，恶心，未明显发热。", "发热"), "denied");
  assert.equal(fieldsOf(D.sanitizeUngroundedRedFlagNegations(json({ distinguishingPoints: "无发热，体温36.8℃" }), st)).distinguishingPoints, "无发热，体温36.8℃");
});

await check("2.3 删掉的否认带走只回指它的结论尾句；整行只剩标签时连标签删；单值字段删空时退回旧写法、列表项删空时去掉", () => {
  const st = state("发热3天，咳嗽，咳黄痰，无胸痛", { chiefComplaint: "发热3天" });
  assert.equal(D.sanitizeUngroundedRedFlagNegations("辨证依据：咳嗽、咳黄痰，无发热，属痰热蕴肺。", st), "辨证依据：咳嗽、咳黄痰，属痰热蕴肺。");
  assert.equal(D.sanitizeUngroundedRedFlagNegations("肺痈：本例无发热，与肺痈不符；痰黄而不腥臭。", st), "肺痈：痰黄而不腥臭。");
  assert.equal(D.sanitizeUngroundedRedFlagNegations("鉴别要点：本例无发热，与之不符。", st), "");
  const out = fieldsOf(D.sanitizeUngroundedRedFlagNegations(json({ distinguishingPoints: "无发热", keyEvidence: ["无发热", "咳黄痰"] }), st));
  assert.equal(out.distinguishingPoints, "病历已记录发热阳性");
  assert.deepEqual(out.keyEvidence, ["咳黄痰"]);
});

await check("2.4 辨病依据里以鉴别病名为主语的否认说的是那个病（C065「产后腹痛无发热」），不按本例改写；本例自己的否认照常核对", () => {
  const st = state("产后8天发热伴下腹痛2天，恶露异味", { chiefComplaint: "产后8天发热伴下腹痛2天", sex: "女", age: 28 });
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ overview: {
    tcmDiseaseRationale: "产后寒战高热、下腹痛，归产后发热；产后腹痛无发热，乳痈发热有乳房局部症状，故不归二者。",
    tcmDiseaseDifferentials: [{ diseaseName: "产后腹痛", distinguishingPoints: "产后腹痛无发热" }, { diseaseName: "乳痈", distinguishingPoints: "本例无乳房红肿" }],
  } })}\n<!-- DIAGNOSIS_JSON_END -->`;
  const overview = JSON.parse(D.sanitizeUngroundedRedFlagNegations(content, st).split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]).overview;
  assert.match(overview.tcmDiseaseRationale, /产后腹痛无发热/);
  assert.doesNotMatch(overview.tcmDiseaseRationale, /阳性/);
});

await check("2.5 病历写倒装的「头痛剧烈」：模型的「无剧烈头痛」被改正（不落成「尚未确认剧烈头痛」）", () => {
  const out = D.sanitizeUngroundedRedFlagNegations("鉴别要点：本例无剧烈头痛，与真头痛相区分。", state("头痛剧烈，伴呕吐。", { chiefComplaint: "头痛2天" }));
  assert.doesNotMatch(out, /尚未确认剧烈头痛|无剧烈头痛/);
});

// ───── 3 复诊计划与煎服法同一份计划 ─────
const prescribeReasoning = () => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  formula: { candidates: [{ name: "四妙丸加减", herbs: [], decoction: {
    doseCount: "7剂", course: "7日", dosesPerDay: 1, administrationTimesPerDay: 2,
    method: "每日1剂，水煎分2次温服", followUpNode: "完成7剂（7日）后复诊；出现不适或症状加重时提前复诊",
    followUpAfterDoses: 7, followUpAfterDays: 7,
  } }] },
  management: { followupSafetyNet: "请在3天内到医院完成评估、核实病情后，再按医生安排服药与复诊。若出现经量骤增，请立即就医。" },
});

await check("3.1 计划的两种写法：无剂数时与改动前逐字相同；有剂数时先评估、医生确认可服药后服完 N 剂复诊（病历10、S044）", () => {
  assert.equal(D.priorityEvaluationFirstStep(""), "请在3天内到医院完成评估、核实病情后，再按医生安排服药与复诊。");
  assert.equal(D.priorityEvaluationFirstStep("社区获得性肺炎"), "请在3天内到相关专科就诊，先完成评估（需排除社区获得性肺炎），再按医生安排服药与复诊。");
  assert.equal(D.priorityEvaluationFirstStep({ focus: "乳腺癌", window: "within_2w", pathway: "breast_mass" }), "请在2周内到乳腺专科就诊，先完成乳腺超声检查（必要时加做乳腺X线），排除乳腺癌后再按医生安排服药与复诊。");
  assert.equal(D.priorityEvaluationFirstStep("", { doses: 7, days: 7 }), "请在3天内到医院完成评估、核实病情；医生确认可以服药后，服完7剂药（约7天后）再复诊。");
  assert.equal(D.priorityEvaluationFollowUpNode("", "完成7剂（7日）后复诊；出现不适或症状加重时提前复诊"), "先在3天内到医院完成评估；医生确认可以服药后，完成7剂（7日）后复诊；出现不适或症状加重时提前复诊");
});

await check("3.2 交付面（开方）：复诊计划第一句换成带剂数的那句、煎服法复诊节点补上评估这一步；处方煎服合同仍通过；再投影一遍逐字不变", () => {
  const once = S.projectDeliveredReasoning(prescribeReasoning(), { priorityEvaluation: "" });
  assert.match(once.management.followupSafetyNet, /^请在3天内到医院完成评估、核实病情；医生确认可以服药后，服完7剂药（约7天后）再复诊。若出现经量骤增/u);
  assert.doesNotMatch(once.management.followupSafetyNet, /再按医生安排服药与复诊/);
  const decoction = once.formula.candidates[0].decoction;
  assert.match(decoction.followUpNode, /^先在3天内到医院完成评估；医生确认可以服药后，完成7剂（7日）后复诊/u);
  assert.equal(RC.prescriptionRegimenContractIssue(decoction), undefined);
  assert.deepEqual(S.projectDeliveredReasoning(once, { priorityEvaluation: "" }), once);
  const plain = S.projectDeliveredReasoning(prescribeReasoning(), {});
  assert.equal(plain.formula.candidates[0].decoction.followUpNode, "完成7剂（7日）后复诊；出现不适或症状加重时提前复诊", "不要求先评估时不动");
});

await check("3.3 M05 首次复诊与开方页同一句（乳房肿块：两周内乳腺专科 → 排除乳腺癌、医生确认可服药后服完 7 剂复诊）", () => {
  const st = state("左乳无痛性结节1个月，约花生米大小，活动可，尚未做乳腺超声。", { chiefComplaint: "左乳结节1个月", sex: "女", age: 38 });
  st.reasoningPrescribe = prescribeReasoning();
  const first = D.patientFacingFirstReview(st, false);
  assert.match(first, /^请在2周内到乳腺专科就诊，先完成乳腺超声检查（必要时加做乳腺X线）；排除乳腺癌、医生确认可以服药后，服完7剂药（约7天后）再复诊/u);
});

// ───── 4 晕厥 + 高危心电 ─────
await check("4.1 B024：动态心电图窦性停搏最长达3秒、入院时突发晕厥 → 红旗；三度房室传导阻滞＋晕倒 → 红旗；规则名可反查", () => {
  const b024 = D.withSafetyGate(state("因头晕到社区卫生服务中心就诊，经24小时动态心电图检查，发现窦性停搏，最长达3秒。医师建议紧急转院；入院时突发晕厥。", { chiefComplaint: "头晕", age: 67 })).safetyGate;
  assert.equal(b024.status, "red_flag");
  assert.ok(b024.redFlags.some((flag) => flag.includes("窦性停搏3秒")), JSON.stringify(b024.redFlags));
  assert.equal(D.redFlagRuleIdForMessage(b024.redFlags.join("；")), "syncope-high-risk-arrhythmia");
  const avb = D.withSafetyGate(state("今晨起床后突然晕倒，约1分钟自行苏醒；心电图示三度房室传导阻滞。", { chiefComplaint: "晕厥1次", age: 72 })).safetyGate;
  assert.equal(avb.status, "red_flag");
});

await check("4.2 对照：停搏 2.1 秒、睡眠中的停搏、否认晕厥、已植入起搏器、心电图未见停搏都不报", () => {
  for (const text of ["动态心电图：窦性停搏最长2.1秒；今晨晕厥1次。", "动态心电图：夜间睡眠中窦性停搏3.2秒；近1周晕厥1次。", "动态心电图：窦性停搏，最长达3秒。无晕厥、黑矇。",
    "既往三度房室传导阻滞已植入起搏器，今头晕2天，晕厥1次。", "晕厥1次；心电图未见窦性停搏、房室传导阻滞。"]) {
    const gate = D.withSafetyGate(state(text, { chiefComplaint: "头晕", age: 67 })).safetyGate;
    assert.ok(!gate.redFlags.some((flag) => flag.includes("高危心律失常")), `${text} → ${JSON.stringify(gate.redFlags)}`);
  }
});

// ───── 5 病历读法核对（A056） ─────
const A056 = "患儿于三天前开始腹泻，一天7-8次，蛋花样，无腹痛，发热，呕吐，于乡卫生院输液治疗两天无效，并有加重趋势。到我卫生室就诊，患儿今天已腹泻十余次，全身状况良，神疲，精神萎靡，无呕吐，发热。";
const A056_FACTS = { affirmedSymptoms: [["蛋花样便", "蛋花样"], ["腹泻", "三天前开始腹泻"], ["神疲", "神疲"], ["精神萎靡", "精神萎靡"]].map(([term, quote]) => ({ term, quote, status: "positive" })) };

await check("5.1 A056：两个读者（规则读法、事实模型）都读成没有的发热、呕吐写进读法核对；事实模型列为阳性的那一项不写；自带谓语的项与没有否认的病历为空", () => {
  const notice = D.commaContinuedDenialReadingNotice(state(A056, { chiefComplaint: "蛋花样便三天", age: 0.67, clinicalFacts: A056_FACTS }));
  assert.match(notice, /【病历读法核对】病历「无腹痛，发热，呕吐」「无呕吐，发热」里/u);
  assert.match(notice, /本例没有发热、呕吐/u);
  const withFever = D.commaContinuedDenialReadingNotice(state(A056, { age: 0.67, clinicalFacts: { affirmedSymptoms: [...A056_FACTS.affirmedSymptoms, { term: "发热", quote: "发热", status: "positive" }] } }));
  assert.match(withFever, /本例没有呕吐，/u);
  for (const text of ["无食欲，眠差，入睡困难，小便调，便秘", "无汗，鼻塞声重，咳嗽有痰", "发热3天，咳嗽，咳黄痰"]) assert.equal(D.commaContinuedDenialReadingNotice(state(text)), "", text);
  // 读法本身与提示同一判据：自带谓语的项不是否认列举的延续（C019「无明显发热，食欲下降」此前读成否认食欲下降）。
  assert.notEqual(D.recordedFindingReading("其他四诊/问诊补充：无明显发热，食欲下降", "食欲下降"), "denied");
  assert.notEqual(D.recordedFindingReading("无恶寒发热，无恶心呕吐，纳差，二便调", "纳差"), "denied");
});

await check("5.2 辨证路由把读法核对接进两半共用的阶段指令与本例说法核对的病历", () => {
  const route = fs.readFileSync("src/app/api/diagnosis/diagnose/route.ts", "utf8");
  assert.match(route, /stageInstructions \+= commaContinuedDenialReadingNotice\(safeState\)/u);
  assert.match(route, /patientClaimRecordText\([^)]*\)[^\n]*commaContinuedDenialReadingNotice\(safeState\)/u);
});

await check("5.3 引文读法与病历原处一致：「发热，呕吐，于乡卫生院输液治疗两天无效…」去掉开头落在否认范围里的发热、呕吐；全落在否认里的一条不交付；病历肯定的照留", () => {
  const record = `现病史：${A056}`;
  assert.equal(D.quoteWithoutDeniedLeadingItems("发热，呕吐，于乡卫生院输液治疗两天无效，并有加重趋势", record), "于乡卫生院输液治疗两天无效，并有加重趋势");
  assert.equal(D.quoteWithoutDeniedLeadingItems("无腹痛，发热，呕吐", record), "无腹痛，发热，呕吐", "带着否认词的引文读法本来就对");
  assert.equal(D.quoteWithoutDeniedLeadingItems("咳嗽，咳痰", "咳嗽3天，无发热，咳嗽，咳痰。"), "咳嗽，咳痰", "病历另处肯定的不去");
  const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndromeBasis: ["蛋花样便三天", "发热，呕吐，于乡卫生院输液治疗两天无效，并有加重趋势", "发热，呕吐"] },
    pathogenesis: { chain: [{ patientFact: "发热，呕吐，于乡卫生院输液治疗两天无效，并有加重趋势" }] } };
  const out = S.projectDeliveredReasoning(reasoning, { recordText: record });
  assert.deepEqual(out.overview.primarySyndromeBasis, ["蛋花样便三天", "于乡卫生院输液治疗两天无效，并有加重趋势"]);
  assert.equal(out.pathogenesis.chain[0].patientFact, "于乡卫生院输液治疗两天无效，并有加重趋势");
});

// ───── 6 本例说法核对：只以否认形式出现的片段不受「病历原文」保护 ─────
await check("6.1 「发热、呕吐」在 A056 病历里只以否认形式出现：两次核对标到时不再因逐字出现而放过；病历肯定写着的片段照旧不删", () => {
  const fields = [{ id: "tcmDiagnosticRationale", text: "蛋花样便、日泻十余次，属脾虚泻。发热、呕吐为湿浊内扰、胃气上逆之象。" }];
  const claims = JSON.stringify({ claims: [{ field: "tcmDiagnosticRationale", span: "发热、呕吐" }, { field: "tcmDiagnosticRationale", span: "日泻十余次" }] });
  const removals = CLAIM.parsePatientClaimRemovals(claims, fields, A056);
  assert.deepEqual(removals.map((item) => item.span), ["发热、呕吐"]);
});

console.log(`r1032-main: ${cases} checks`);
