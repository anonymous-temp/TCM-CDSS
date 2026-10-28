// 第二十三轮（2026-10-26）：用户决定 D4「剂量一致化」——默认给剂量，风险用置顶警示、按人群剔除/标注药味、采纳门槛与「先评估再服药」的复诊第一步表达；
// 只有算不出剂量（缺主诉、儿童年龄段判不出、年龄记录冲突）才不给。接口字段与取值集合不变。
// 同轮处理第二十二轮的新发现：「N天前…出现」整句被闸门读成既往（只放宽到两周内起病）、儿童胸痛按成人冠脉判、周围性面瘫报卒中红旗、
// 顺带一句「睡眠差」要求 OSA 筛查。每条断言都有反证（~/runlogs/r1018/work/r1035/cp/cp.py）。
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

delete process.env.CDSS_DOSE_CONSISTENCY;
delete process.env.CDSS_REDFLAG_DOSE_AUTHORIZATION;
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const polarity = await jiti.import("../src/lib/clinical-polarity.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const pruning = await jiti.import("../src/lib/m04-modification-safety.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const pruningCompiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");

const gated = (raw) => safety.withSafetyGate(types.normalizeCaseStateInput(raw));
const permissionOf = (raw) => safety.derivePrescriptionPermission(gated(raw));
const record = (extra) => ({ chiefComplaint: extra.cc, patient: { sex: extra.sex || "女", ...(extra.age === undefined ? {} : { age: extra.age }) }, symptoms: { 现病史: extra.text, ...(extra.symptoms || {}) }, ...(extra.vitals ? { vitals: extra.vitals } : {}) });
const GI_BLEED = record({ cc: "黑便1天", sex: "男", age: 50, text: "今日解黑便2次，头晕乏力。" });
const PREGNANT = record({ cc: "恶心呕吐1周", age: 28, text: "停经8周，宫内早孕，恶心呕吐1周。" });
const WARFARIN = record({ cc: "失眠1月", sex: "男", age: 70, text: "失眠1月。", symptoms: { 用药史: "华法林3mg每日1次" } });
const CKD = record({ cc: "腰酸乏力2月", sex: "男", age: 62, text: "腰酸乏力2月，慢性肾脏病4期。" });
const CHILD_NO_AGE = record({ cc: "咳嗽2天", sex: "男", text: "患儿咳嗽2天。" });

// ---------- D4 剂量判定 ----------
await check("1.1 D4：红旗给剂量（limited_dose），红旗解除前不可采纳（formalAdoption=blocked），reasons 里是红旗本身", () => {
  const permission = permissionOf(GI_BLEED);
  assert.equal(permission.candidateMode, "limited_dose");
  assert.equal(permission.formalAdoption, "blocked");
  assert.ok(permission.reasons.some((reason) => /消化道出血/.test(reason)), JSON.stringify(permission.reasons));
  assert.equal(gated(GI_BLEED).safetyGate.candidateMode, "limited_dose");
});

await check("1.2 D4：妊娠、抗凝、慢性肾病这类独立边界给剂量，采纳需医生确认；原因仍列在 reasons", () => {
  for (const [label, raw, pattern] of [["妊娠", PREGNANT, /妊娠/], ["抗凝", WARFARIN, /抗凝/], ["肾病", CKD, /肾/]]) {
    const permission = permissionOf(raw);
    assert.equal(permission.candidateMode, "limited_dose", label);
    assert.equal(permission.formalAdoption, "eligible_after_doctor_confirmation", label);
    assert.ok(permission.reasons.some((reason) => pattern.test(reason)), `${label}: ${JSON.stringify(permission.reasons)}`);
  }
});

await check("1.3 D4：只有算不出剂量才不给——儿童没写年龄段 non_dose_only；缺主诉 blocked", () => {
  assert.equal(permissionOf(CHILD_NO_AGE).candidateMode, "non_dose_only");
  assert.equal(permissionOf({ ...GI_BLEED, chiefComplaint: "" , symptoms: {} }).candidateMode, "blocked");
});

await check("1.4 D4 回退：CDSS_DOSE_CONSISTENCY=false 回到旧口径（红旗与独立边界不给剂量）；CDSS_REDFLAG_DOSE_AUTHORIZATION=withhold 只收回红旗", () => {
  process.env.CDSS_DOSE_CONSISTENCY = "false";
  try {
    assert.equal(permissionOf(GI_BLEED).candidateMode, "non_dose_only");
    assert.equal(permissionOf(PREGNANT).candidateMode, "non_dose_only");
  } finally {
    delete process.env.CDSS_DOSE_CONSISTENCY;
  }
  process.env.CDSS_REDFLAG_DOSE_AUTHORIZATION = "withhold";
  try {
    assert.equal(permissionOf(GI_BLEED).candidateMode, "non_dose_only");
    assert.equal(permissionOf(PREGNANT).candidateMode, "limited_dose");
  } finally {
    delete process.env.CDSS_REDFLAG_DOSE_AUTHORIZATION;
  }
});

await check("1.5 D4 复诊第一步：红旗当天急诊或专科排除急危重情况；妊娠、抗凝、专科各写各的，抗凝带复查凝血", () => {
  const plan = (raw) => {
    const target = safety.priorityEvaluationFollowupTarget(gated(raw));
    return { target, text: target ? safety.priorityEvaluationFirstStep(target, { doses: 7, days: 7 }) : "" };
  };
  const red = plan(GI_BLEED);
  assert.equal(red.target?.pathway, "red_flag_clearance");
  assert.match(red.text, /^请在当天到医院急诊或专科就诊，先排除急危重情况；医生确认可以服药后，服完7剂药/);
  assert.equal(red.text.split("排除急危重情况").length, 2, "首句里「排除急危重情况」只说一次");
  // 辨证阶段写进来的旧红旗句（「请先尽快到医院急诊或相关专科就诊，排除急危重情况；…」）与首句重复，只留后半句（本轮实测 S178/S188/S190）。
  const merged = surface.followupWhenPriorityEvaluation(`${visible.RED_FLAG_SAFETY_NET}\n\n若再次出现剧烈头痛，请立即就医。`, red.target, { doses: 7, days: 7 });
  assert.equal(merged.split("排除急危重情况").length, 2, merged);
  assert.match(merged, /如症状持续、加重或出现新的不适，请立即急诊或呼叫急救。/);
  assert.match(merged, /若再次出现剧烈头痛/);
  // 就诊句已说「先排除X」的通道（发热胸闷 24 小时、高血糖酮症），后面不再说第二遍（生产探针 K16）。
  for (const pathway of ["febrile_chest_tightness", "hyperglycemic_ketosis"]) {
    const focus = { focus: "", window: "within_24h", pathway };
    for (const text of [safety.priorityEvaluationFirstStep(focus, { doses: 5, days: 5 }), safety.priorityEvaluationFirstStep(focus)]) {
      const excluded = text.match(/先排除([^，。；]+)/u)?.[1];
      assert.ok(excluded, text);
      assert.equal(text.split(`排除${excluded}`).length, 2, text);
    }
  }
  assert.match(safety.priorityEvaluationFirstStep({ focus: "", window: "within_2w", pathway: "breast_mass" }, { doses: 7, days: 7 }), /排除乳腺癌、医生确认可以服药后/, "就诊句没说排除的通道照旧");
  assert.equal(plan(PREGNANT).target?.pathway, "pregnancy_review");
  assert.match(plan(PREGNANT).text, /阴道流血/);
  assert.equal(plan(WARFARIN).target?.pathway, "anticoagulant_review");
  assert.match(plan(WARFARIN).text, /INR/);
  assert.equal(plan(CKD).target?.pathway, "specialist_review");
  assert.equal(plan(CHILD_NO_AGE).target, undefined);
});

await check("1.6 D4 复诊阶段：红旗给了剂量时照常出随访方案，总评写「红旗解除前不得采纳」，首次复诊先当天急诊", () => {
  const state = { ...gated(GI_BLEED), reasoningPrescribe: {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "归脾汤加减", herbs: [{ name: "黄芪", dose: "15g", role: "君" }, { name: "白术", dose: "10g", role: "臣" }], decoction: { followUpAfterDoses: 7, followUpAfterDays: 7 } }] },
  } };
  const payload = safety.buildDeterministicRiskFollowupPayload(state, null);
  const text = JSON.stringify(payload);
  assert.match(text, /红旗解除前不得采纳本方/);
  assert.match(text, /请在当天到医院急诊或专科就诊/);
  assert.doesNotMatch(text, /优先完成现场风险处置/);
});

await check("1.7 D4：辨证路由只在剂量确实没给时写 structuredDoseWithheld（红旗给了剂量走当天评估通道）", () => {
  const route = fs.readFileSync("src/app/api/diagnosis/diagnose/route.ts", "utf8");
  assert.match(route, /structuredDoseWithheld: \["non_dose_only", "blocked"\]\.includes\(derivePrescriptionPermission\(gated\)\.candidateMode\)/);
});

// ---------- D4 按人群剔除 ----------
await check("2.1 D4：活动性出血红旗时，《中药学》活血化瘀药（红花）按出血/抗凝人群拦；止血药（三七）不拦；没有出血红旗不拦", () => {
  const bleeding = "今日解黑便2次，头晕乏力。";
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "黄芪" }, { name: "红花" }], bleeding), "herb_1_special_population_high_risk_bleeding_anticoagulation");
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "三七" }], bleeding), undefined);
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "红花" }], "胃脘胀痛半月，无黑便。"), undefined);
});

await check("2.1b D4：闸门的出血红旗按接地正文登记后，开方核对认得（正文里生命体征不带项名、凭正文重算读不出低血压）；没有登记、没有出血红旗时不认", () => {
  const text = `患者年龄：28岁\n患者性别：女\n停经6周，右下腹痛伴阴道少量出血1天。尿妊娠试验阳性\n生命体征：88/56\n生命体征：${Date.now() % 1000}`;
  assert.equal(safety.activeBleedingInGroundingText(text), false, "凭正文读不出");
  safety.registerActiveBleedingRedFlags([text], ["急性或突发头痛"]);
  assert.equal(safety.activeBleedingInGroundingText(text), false, "不是出血类红旗不登记");
  safety.registerActiveBleedingRedFlags([text], ["妊娠期腹痛或阴道出血伴血压88/56mmHg，需立即急诊排除异位妊娠破裂或流产大出血"]);
  assert.equal(safety.activeBleedingInGroundingText(text), true);
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "熟地黄" }, { name: "川芎" }], text), "herb_1_special_population_high_risk_bleeding_anticoagulation");
  const route = fs.readFileSync("src/app/api/diagnosis/prescribe/route.ts", "utf8");
  assert.match(route, /registerActiveBleedingRedFlags\(\[groundingText, structuredClinicalContext, clinicalGroundingText\(gated\)\], gated\.safetyGate\?\.redFlags/);
});

const content = (herbs, extra = {}) => `前文\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "测试方", herbs, formulaAnalysis: herbs.map((herb) => `${herb.name}为${herb.role}`).join("，") + "。", ...extra }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
const candidateOf = (text) => JSON.parse(text.slice(text.indexOf("<!-- DIAGNOSIS_JSON_START -->") + 29, text.indexOf("<!-- DIAGNOSIS_JSON_END -->"))).formula.candidates[0];

await check("2.2 D4 定稿剔除：冲突的非君药按单味删掉、写进「慎用与不适用」、方义随之改写；君药不删；删后不足 3 味不删", () => {
  const bleeding = "今日解黑便2次，头晕乏力。";
  const herbs = [{ name: "黄芪", role: "君", dose: "15g" }, { name: "当归", role: "臣", dose: "10g" }, { name: "白术", role: "臣", dose: "10g" }, { name: "红花", role: "佐", dose: "6g" }, { name: "甘草", role: "使", dose: "6g" }];
  const pruned = candidateOf(pruning.dropSafetyConflictingM04CandidateHerbs(content(herbs), bleeding));
  assert.deepEqual(pruned.herbs.map((herb) => herb.name).filter((name) => name === "红花"), []);
  assert.match(pruned.notApplicable, /按本例情况已去除：.*红花（出血或抗凝状态不宜）/);
  assert.doesNotMatch(pruned.formulaAnalysis, /红花/);
  const emperor = [{ name: "红花", role: "君", dose: "6g" }, { name: "黄芪", role: "臣", dose: "15g" }, { name: "白术", role: "臣", dose: "10g" }, { name: "甘草", role: "使", dose: "6g" }];
  const keptEmperor = candidateOf(pruning.dropSafetyConflictingM04CandidateHerbs(content(emperor), bleeding));
  assert.ok(keptEmperor.herbs.some((herb) => herb.name === "红花"), "君药不删，交给修复轮");
  const tiny = [{ name: "黄芪", role: "君", dose: "15g" }, { name: "红花", role: "佐", dose: "6g" }, { name: "甘草", role: "使", dose: "6g" }];
  const keptTiny = candidateOf(pruning.dropSafetyConflictingM04CandidateHerbs(content(tiny), bleeding));
  assert.equal(keptTiny.herbs.length, 3, "删后不足 3 味不删");
});

await check("2.3 D4 定稿剔除：方内十八反删地位较低的一味（甘草—海藻删海藻以外的低位药），没有病历上下文时不动", () => {
  const herbs = [{ name: "海藻", role: "君", dose: "10g" }, { name: "昆布", role: "臣", dose: "10g" }, { name: "浙贝母", role: "臣", dose: "10g" }, { name: "甘草", role: "使", dose: "6g" }];
  const pruned = candidateOf(pruning.dropSafetyConflictingM04CandidateHerbs(content(herbs), "颈前肿块2月。"));
  assert.deepEqual(pruned.herbs.map((herb) => herb.name), ["海藻", "昆布", "浙贝母"]);
  assert.match(pruned.notApplicable, /甘草（与海藻属/);
  assert.equal(pruning.dropSafetyConflictingM04CandidateHerbs(content(herbs), ""), content(herbs));
});

await check("2.3b D4 定稿剔除：须医生单独定量的管制或濒危药材（羚羊角）还有别的君药时拿出并写明另行开具；它是唯一君药时不拿", () => {
  const context = "发热、头痛伴呕吐2天，意识障碍半天。";
  const herbs = [{ name: "羚羊角", role: "君", dose: "3g" }, { name: "钩藤", role: "君", dose: "12g" }, { name: "桑叶", role: "臣", dose: "9g" }, { name: "菊花", role: "臣", dose: "9g" }, { name: "白芍", role: "佐", dose: "12g" }, { name: "甘草", role: "使", dose: "6g" }];
  const pruned = candidateOf(pruning.dropSafetyConflictingM04CandidateHerbs(content(herbs), context));
  assert.deepEqual(pruned.herbs.map((herb) => herb.name), ["钩藤", "桑叶", "菊花", "白芍", "甘草"]);
  assert.match(pruned.notApplicable, /羚羊角（须由医生单独定量的管制或濒危药材，未列入本方，如需使用请医生另行开具）/);
  const sole = [{ name: "羚羊角", role: "君", dose: "3g" }, ...herbs.slice(2)];
  assert.ok(candidateOf(pruning.dropSafetyConflictingM04CandidateHerbs(content(sole), context)).herbs.some((herb) => herb.name === "羚羊角"), "唯一君药不拿");
});

await check("2.4 D4：开方定稿在核对与签名之前做安全剔除（finalizeM04CandidateContent）", () => {
  const api = fs.readFileSync("src/lib/diagnosis-api.ts", "utf8");
  const finalize = api.slice(api.indexOf("const finalizeM04CandidateContent = "), api.indexOf("let lastM04CandidateDirectionPruned"));
  assert.match(finalize, /dropSafetyConflictingM04CandidateHerbs\(finalized, opts\.structuredClinicalContext \|\| ""\)/);
});

await check("2.5 D4 随证加减与方中药味同一判据：活动性出血时拟加的红花不列（三七照列）；转氨酶升高时拟加川楝子照列并写明肝功能不全者慎用；对照不写", () => {
  const compiler = pruningCompiler;
  const prior = types.ReasoningV2Schema.parse({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: "胃痛", primarySyndrome: "瘀血停胃证", overallPathogenesis: "瘀停胃络，不通则痛", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "胃脘隐痛", syndromeEvidence: "胃脘隐痛，痛有定处", pathogenesis: "瘀停胃络，不通则痛", therapyDirection: "化瘀通络" }] },
    therapy: { overallPrinciple: "实则泻之", overallMethod: "化瘀通络，和胃止痛", subTherapies: [{ therapy: "化瘀通络", targetPathogenesis: "瘀停胃络", priority: "主要" }] },
    formula: { candidates: [], patentAndWestern: [], modifications: [] },
  });
  const compile = (caseState) => compiler.compileM04Proposal({
    candidate: {
      name: "自拟方", applicable: "胃脘隐痛。", notApplicable: "",
      herbs: [
        { name: "黄芪", dose: "15g", role: "君", function: "补气升阳" }, { name: "党参", dose: "12g", role: "臣", function: "健脾益气" },
        { name: "白术", dose: "10g", role: "臣", function: "健脾燥湿" }, { name: "炙甘草", dose: "6g", role: "使", function: "调和诸药" },
      ].map((herb) => ({ ...herb, targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, processing: null, isToxic: false, decoctionRequirement: null })),
      formulaAnalysis: "黄芪补气为君，党参、白术健脾为臣，炙甘草调和诸药为使。",
      decoction: { doseCount: "7剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，煎服", followUpNode: "7日复诊" },
    },
    patentAndWestern: [],
    modifications: [
      { trigger: "胃脘隐痛", targetRef: "P1", actionType: "add", herbName: "红花", dose: "6g", reason: "活血止痛" },
      { trigger: "胃脘隐痛", targetRef: "P1", actionType: "add", herbName: "三七", dose: "3g", reason: "化瘀止血" },
      { trigger: "胃脘隐痛", targetRef: "P1", actionType: "add", herbName: "川楝子", dose: "6g", reason: "行气止痛" },
    ],
    nonPharma: { diet: "宜温热易消化饮食。", lifestyle: "规律作息。", emotion: "调畅情志。", precautions: [], tcmTreatments: [] },
  }, prior, caseState);
  const added = (raw) => compile(types.normalizeCaseStateInput(raw)).formula.modifications;
  const bleeding = added(record({ cc: "胃脘隐痛伴黑便1天", sex: "男", age: 50, text: "胃脘隐痛，痛有定处，今日解黑便2次，头晕乏力。" }));
  assert.ok(!bleeding.some((item) => item.herbName === "红花"), JSON.stringify(bleeding.map((item) => item.herbName)));
  assert.ok(bleeding.some((item) => item.herbName === "三七"), JSON.stringify(compile(types.normalizeCaseStateInput(record({ cc: "胃脘隐痛伴黑便1天", sex: "男", age: 50, text: "胃脘隐痛，痛有定处，今日解黑便2次，头晕乏力。" }))).formula.modificationReview));
  const liver = added(record({ cc: "胃脘隐痛1月", sex: "男", age: 50, text: "胃脘隐痛，痛有定处。转氨酶升高半年。" }));
  assert.match(liver.find((item) => item.herbName === "川楝子")?.riskNote || "", /川楝子肝功能不全者慎用/, JSON.stringify(liver));
  assert.ok(liver.some((item) => item.herbName === "红花"), "没有出血红旗时红花照列");
  const control = added(record({ cc: "胃脘隐痛1月", sex: "男", age: 50, text: "胃脘隐痛，痛有定处，肝功能正常。" }));
  assert.ok(control.some((item) => item.herbName === "川楝子"));
  assert.doesNotMatch(control.find((item) => item.herbName === "川楝子")?.riskNote || "", /肝功能不全/);
});

// ---------- 新发现：时间、儿童胸痛、周围性面瘫、OSA ----------
await check("3.1 两周内起病（N天/日前 N≤14、1–2周前、半月前…出现）按当前；15天、22天、十几天、月、年仍按既往", () => {
  const scope = (text, term) => polarity.clinicalEventTemporalScopeAt(text, text.indexOf(term), term.length);
  assert.equal(scope("2天前受凉后出现咽痛、流涕、发热，伴鼻塞，病程中出现间断干咳，伴胸闷、气促。", "胸闷"), "current");
  assert.equal(scope("3天前出现胸痛，伴大汗。", "胸痛"), "current");
  assert.equal(scope("半月前劳累后出现发热，体温最高39.5℃。", "39.5"), "current");
  for (const text of ["15天前突然出现阴道流血。", "22天前突然出现言语欠清。", "十几天前出现胸痛。", "6个月前受凉后出现发热，最高41℃。", "2年前出现胸闷。"]) {
    const term = text.match(/阴道流血|言语欠清|胸痛|41|胸闷/u)[0];
    assert.notEqual(scope(text, term), "current", text);
  }
});

await check("3.2 儿童胸痛没有心源性警示不按急性冠脉报红旗，有发热走 24 小时心电图通道；活动时胸痛、晕厥、先心病、家族猝死照报", () => {
  const kid = (text, extra = {}) => record({ cc: "胸痛2天", age: 12, text, ...extra });
  const cough = gated(kid("咳嗽2天，咳时胸痛，伴发热，体温38.5℃。", { vitals: { T: "38.5", P: "96", R: "20", BP: "105/68" } }));
  assert.equal(cough.safetyGate.redFlags.length, 0, cough.safetyGate.redFlags.join("；"));
  assert.equal(safety.priorityEvaluationFollowupTarget(cough)?.pathway, "febrile_chest_tightness");
  // 否认写法不算心源性警示（生产探针：「无晕厥，活动后无胸痛加重」曾被读成活动时胸痛）。
  assert.equal(gated(record({ cc: "咳嗽咳痰3天", sex: "男", age: 13, text: "咳嗽咳痰3天，咳时胸痛，伴发热，体温38.5℃，无晕厥，活动后无胸痛加重。", vitals: { T: "38.5", P: "96", R: "20", BP: "105/68" } })).safetyGate.redFlags.length, 0);
  for (const text of ["1天前打篮球时出现胸痛。", "今天胸痛，伴晕厥一次。", "胸痛2天，先天性心脏病术后。", "胸痛2天，其父40岁猝死。", "跑步后胸痛加重2天。"]) {
    assert.equal(gated(kid(text)).safetyGate.status, "red_flag", text);
  }
  assert.equal(gated(record({ cc: "胸痛2天", sex: "男", age: 40, text: "咳嗽2天，咳时胸痛。" })).safetyGate.status, "red_flag", "成人不受影响");
});

await check("3.3 只有周围性面瘫（额纹消失、闭眼不全）不报神经红旗，24/48 小时内评估；伴肢体无力、言语不清或额纹保留照报", () => {
  const bell = gated(record({ cc: "口角歪斜2天", age: 20, text: "2天前受风后出现左侧面部麻木,额纹消失,眼裂变大,鼻唇沟变浅，口角下垂歪向左侧。" }));
  assert.equal(bell.safetyGate.redFlags.length, 0, bell.safetyGate.redFlags.join("；"));
  const target = safety.priorityEvaluationFollowupTarget(bell);
  assert.equal(target?.pathway, "peripheral_facial_palsy");
  // 第二十八轮：起病 2 天仍在激素 72 小时窗口内，评估时限为 24 小时（peripheralFacialPalsyWindow；超过 72 小时仍为 48 小时，见 test:r1040-main 2.1）。
  assert.match(safety.priorityEvaluationFirstStep(target), /24小时内.*72小时内/);
  for (const text of ["2天前出现口角歪斜，额纹消失，伴右侧肢体无力。", "今晨突发口角歪斜，额纹存在，言语不清。", "今晨突发口角歪斜，言语不清。"]) {
    assert.equal(gated(record({ cc: "口角歪斜", sex: "男", age: 66, text })).safetyGate.status, "red_flag", text);
  }
});

await check("3.4 OSA 筛查只对以失眠就诊的病例要求；胃痛病历顺带一句睡眠差不要", () => {
  const codes = (raw) => gated(raw).safetyGate.missingItemCodes || [];
  assert.ok(!codes(record({ cc: "上腹部胀痛半月", text: "半月前与家人争吵后出现上腹部胀痛，伴胸闷、善太息，睡眠差。" })).includes("osa_screening"));
  assert.ok(codes(record({ cc: "失眠3月", text: "入睡困难3月，易醒。" })).includes("osa_screening"));
});

await check("3.5 妊娠伴腹痛或阴道出血：循环不稳定（血压≤90/≤50、心率≥120、晕厥）报红旗；否则 20 周前 24 小时早孕评估、20 周后 24 小时产科急诊（NICE NG126）", () => {
  const early = (vitals, text = "停经6周，右下腹痛伴阴道少量出血1天，伴头晕。尿妊娠试验阳性。") => gated(record({ cc: "停经6周，腹痛伴阴道出血1天", age: 28, text, vitals }));
  for (const [vitals, text] of [[{ BP: "88/56", P: "104" }], [{ BP: "112/70", P: "124" }], [{ BP: "106/68", P: "96" }, "停经7周，下腹痛伴阴道出血半天，今晨如厕时晕倒一次。"]]) {
    const state = early(vitals, text);
    assert.equal(state.safetyGate.status, "red_flag", JSON.stringify(vitals));
    assert.match(state.safetyGate.redFlags.join("；"), /妊娠期腹痛或阴道出血伴.*异位妊娠破裂/);
    assert.equal(safety.priorityEvaluationFollowupTarget(state)?.pathway, "red_flag_clearance");
  }
  const stable = early({ BP: "110/70", P: "88" });
  assert.notEqual(stable.safetyGate.status, "red_flag");
  assert.deepEqual([safety.priorityEvaluationFollowupTarget(stable)?.window, safety.priorityEvaluationFollowupTarget(stable)?.pathway], ["within_24h", "early_pregnancy_pain_bleeding"]);
  assert.notEqual(early({ BP: "106/68", P: "96" }, "停经7周，下腹痛伴阴道出血半天，无晕厥。").safetyGate.status, "red_flag", "否认晕厥不算");
  const late = gated(record({ cc: "妊娠腹痛1周", age: 30, text: "怀孕34周，宫缩痛一周。" }));
  assert.equal(safety.priorityEvaluationFollowupTarget(late)?.pathway, "late_pregnancy_pain_bleeding");
  assert.match(safety.priorityEvaluationFirstStep(safety.priorityEvaluationFollowupTarget(late)), /24小时内到产科急诊/);
  const lateUnstable = gated(record({ cc: "妊娠腹痛1天", age: 30, text: "怀孕34周，下腹持续疼痛1天。", vitals: { BP: "86/52" } }));
  assert.match(lateUnstable.safetyGate.redFlags.join("；"), /妊娠34周腹痛伴血压86\/52mmHg.*胎盘早剥/);
  assert.equal(gated(record({ cc: "腹痛1天", age: 30, text: "怀孕已5个半月，下腹隐痛1天。" })).safetyGate.status !== "red_flag" &&
    safety.priorityEvaluationFollowupTarget(gated(record({ cc: "腹痛1天", age: 30, text: "怀孕已5个半月，下腹隐痛1天。" })))?.pathway, "late_pregnancy_pain_bleeding");
  // 对照：孕妇没有腹痛出血、非孕男性腹痛、闭经半年伴头晕，血压同样 88/56，都不报这一条。
  for (const raw of [record({ cc: "咳嗽5天", age: 30, text: "咳嗽5天，咽痒。妊娠12周，无腹痛及阴道流血。", vitals: { BP: "88/56" } }),
    record({ cc: "腹痛2天", sex: "男", age: 30, text: "下腹隐痛2天。", vitals: { BP: "88/56" } }),
    record({ cc: "停经半年", age: 30, text: "停经半年，头晕乏力。", vitals: { BP: "88/56" } })]) {
    assert.doesNotMatch((gated(raw).safetyGate.redFlags || []).join("；"), /妊娠/, raw.chiefComplaint);
  }
  // 不孕求子写法读成的「可疑妊娠」、没写停经：产科提示照旧，不走 24 小时早孕通道。
  assert.notEqual(safety.priorityEvaluationFollowupTarget(gated(record({ cc: "未避孕2年未孕", age: 30, text: "结婚未避孕2年多仍未能怀孕。平时经常下腹痛，腰酸。" })))?.pathway, "early_pregnancy_pain_bleeding");
  assert.equal(safety.priorityEvaluationFollowupTarget(gated(record({ cc: "停经40天", age: 30, text: "未避孕，停经40天，下腹隐痛2天。" })))?.pathway, "early_pregnancy_pain_bleeding");
  assert.equal(safety.recordedGestationalWeeks("妊娠12+3周"), 12);
  assert.equal(safety.recordedGestationalWeeks("怀孕已5个半月"), 24);
  assert.equal(safety.recordedGestationalWeeks("未避孕5个月未能怀孕"), undefined);
  assert.equal(safety.recordedGestationalWeeks("备孕2个月，不孕3年"), undefined);
});

console.log(`r1035-main: ${cases} checks`);
