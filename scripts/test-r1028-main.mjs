// 10/24 第十六轮（甲方 100 例测试集 + 页面实测「妊娠状态未知被判可疑」）。
//
//   1 妊娠判据：「妊娠可能性尚待核实/尚未排除/不详」是未知，不是可疑；「妊娠状态明确否认」「怀孕已排除」是否认；
//     当前妊娠的其他写法（妊娠32天、妊娠腹痛、胎漏、胎动不安、先兆流产、单胎妊娠、妊娠后已经…）要认出来；
//     否定不跨逗号；「如孕5月」是比喻。
//   2 产科急症提示读妊娠判据（阳性或可疑）与「育龄女性停经伴出血或腹痛」，不看「妊娠」字面。
//   3 只有数值的体重下降须有当前消化道症状才算上消化道警示（C031 糖尿病多饮多尿）。
//   4 M04 特殊人群合同与兜底参考页的孕妇判据读妊娠判据（C039「近期未计划妊娠」曾把半夏、天南星判成孕期高风险）。
//   5 饮片味数：M04 提示词按本例锁定方的基础味数、组成下限给出具体做法。
//   6 流派：医生选了流派、模型判相符且写了该流派可锁定的方时，不再被改回教材代表方；短名单补进本例召回到的该流派方。

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

const state = await jiti.import("../src/lib/clinical-state.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const prompts = await jiti.import("../src/lib/diagnosis-prompts.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const indications = await jiti.import("../src/lib/tcm-formula-indications.ts");
const western = await jiti.import("../src/lib/western-name-evidence-check.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const polarity = await jiti.import("../src/lib/clinical-polarity.ts");

const preg = (text) => state.assessPregnancyState(text).status;

// 页面形状的病例（与 DiagnosisClient applyDraftToCaseState 同构的最小子集）。
function pageCase({ sex = "女", age = 35, chief, present = "", detail = "", past = "", exams = "", tongue = "舌淡红，苔薄白", pulse = "脉细", medication = "未服药", allergy = "否认药物过敏", lineage = "unrestricted", herbCount } = {}) {
  const raw = [`患者信息：性别${sex}，年龄${age}岁`, `主诉：${chief}`, present && `现病史：${present}`, past && `既往史：${past}`, `过敏史：${allergy}`, `用药史：${medication}`,
    "生命体征/体格检查：T 36.5℃，P 78次/分，R 18次/分，BP 112/72mmHg", `舌象：${tongue}`, `脉象：${pulse}`, detail && `其他四诊/问诊补充：${detail}`, exams && `辅助检查：${exams}`].filter(Boolean).join("\n");
  return types.normalizeCaseStateInput({
    id: "r1028-test", phase: "collect", patient: { sex, age }, chiefComplaint: chief,
    symptoms: { ...(present ? { presentHistory: present } : {}), ...(detail ? { tcmDetail: detail } : {}), ...(exams ? { exams } : {}) },
    questionRounds: 0, maxQuestionRounds: 1, conversation: [{ role: "user", content: raw }],
    hisRecord: { schemaVersion: "tcm-cdss-his-v1", source: "tcm-cdss-his", caseId: "r1028-test", updatedAt: "2026-10-24T00:00:00.000Z", tongueImageUploaded: false,
      fields: { sex, age: String(age), zhushu: chief, xianbingshi: present, jiwangshi: past, guomin: allergy, yongyaoshi: medication, vitalsT: "36.5", vitalsP: "78", vitalsR: "18", vitalsBP: "112/72", tcmTongue: tongue, tcmPulse: pulse, tcmDetail: detail, fuzhuJiancha: exams, tcmLineagePreference: lineage }, rawText: raw },
    tongue, pulse, pastHistory: past || undefined, medicationHistory: medication, allergyHistory: allergy, tcmLineagePreference: lineage,
    ...(herbCount ? { herbCountPreference: herbCount } : {}),
    vitals: { temperature: "36.5", pulse: "78", respiration: "18", bloodPressure: "112/72" },
  });
}

// ─── 1 妊娠判据 ───────────────────────────────────────────────────────────────
await check("1.1 妊娠状态「尚待核实/尚未排除/不详/未知」是未知，不是可疑（甲方截图失眠病例、C063、C066）", () => {
  for (const text of ["月经周期基本规律，经量偏少，末次月经及妊娠可能性尚待核实。", "妊娠可能性尚待核实，无明确孕检结果", "易烦躁、口干，妊娠可能性尚未排除",
    "怀孕可能性不详", "妊娠可能待确认", "末次月经2周前，妊娠状态未知"]) {
    assert.equal(preg(text), "unknown", text);
  }
});

await check("1.2 医生下的判断与有依据的可疑照旧按可疑（守住另一头）", () => {
  for (const text of ["不能排除妊娠", "妊娠可能性不能排除", "有妊娠可能", "停经45天，妊娠可能性待核实"]) assert.equal(preg(text), "possible", text);
  assert.equal(preg("可能怀孕了"), "positive");
  assert.equal(preg("末次月经昨日，暂无妊娠可能"), "negative");
});

await check("1.3 否认后置：「妊娠状态明确否认」「怀孕已排除」是否认，「尚未排除」不是（C069 曾被再问一遍）", () => {
  for (const text of ["月经基本规律，妊娠状态明确否认", "怀孕已排除", "妊娠可能已排除"]) assert.equal(preg(text), "negative", text);
  for (const text of ["妊娠可能性尚未排除", "妊娠待排除"]) assert.notEqual(preg(text), "negative", text);
});

await check("1.4 当前妊娠的其他写法要认出来（语料回放：妊娠32天、妊娠腹痛、胎漏、胎动不安等判成未知，孕妇可给剂量）", () => {
  for (const text of ["现又妊娠32天，面色苍白", "患者怀孕已32日，易紧张", "妊娠腹痛1个月", "妊娠后已经持续呕吐了20天", "彩超提示单胎妊娠合并子宫肌瘤",
    "停经45天，少量阴道流血3天。肾虚型胎漏", "胎动不安一周", "先兆流产3天", "妊娠恶阻2周", "孕5个月，阴道出血少量7天"]) {
    assert.equal(preg(text), "positive", text);
  }
});

await check("1.5 既往、否认、比喻不算当前妊娠", () => {
  assert.equal(preg("既往先兆流产史"), "historical");
  assert.equal(preg("既往妊娠32天时自然流产"), "historical");
  for (const text of ["妊娠水肿后遗下肢肿胀15年", "否认妊娠呕吐", "近期无先兆流产症状", "前次妊娠40天自然流产", "少腹胀大如孕5月，脐下肿物", "腹大如怀孕5个月"]) {
    assert.notEqual(preg(text), "positive", text);
  }
});

await check("1.6 否定不跨逗号：「也没有阴道流血，属于妊娠腹痛」不是否认妊娠", () => {
  assert.equal(preg("患者在妊娠期间出现小腹胀痛，没有腰酸感，也没有阴道流血，属于妊娠腹痛。"), "positive");
  // 「妊娠试验未做」不是否认妊娠；旧窗口跨过逗号把「无发热、咳嗽，妊娠」读成否认（C068 一类写法）。
  assert.equal(preg("无发热、咳嗽，妊娠试验未做"), "unknown");
  assert.equal(preg("没有腹痛，怀孕情况待问"), "unknown");
  assert.equal(preg("否认停经、妊娠"), "negative");
  assert.equal(preg("无腹痛，妊娠试验阴性"), "negative");
});

await check("1.7 出生史与既往分娩不是当前妊娠：「孕32周出生」「孕36+2周早产」「孕38周剖宫产」（C077 3 岁女童）", () => {
  for (const text of ["早产儿，孕32周出生", "孕36+2周早产", "既往孕2产1，孕38周剖宫产", "胎产史：第二胎第一产，孕7月剖腹产，出生体重1.9kg"]) assert.equal(preg(text), "historical", text);
  assert.equal(preg("孕32周，下肢浮肿"), "positive");
});

// ─── 2 安全闸门：妊娠状态未知的病例 ─────────────────────────────────────────────
const screenshotCase = pageCase({
  age: 36, chief: "入睡困难伴多梦3个月，加重2周。",
  present: "患者3个月前因工作压力增大逐渐出现入睡困难，夜间多梦、易醒。近2周症状明显加重，伴白天精神疲倦、心悸、食欲下降，偶有头晕。未见明显胸痛、呼吸困难等症状。",
  detail: "平时工作压力较大，思虑较多。食欲一般，偶有腹胀，大便基本正常。月经周期基本规律，经量偏少，末次月经及妊娠可能性尚待核实。",
  tongue: "舌质淡，舌体略胖，边有轻微齿痕，苔薄白。", pulse: "脉细弱", medication: "近期未规律服用处方药物", allergy: "无",
});

await check("2.1 甲方截图病例：不判妊娠阳性/可疑、不提示产科急症、剂量不被孕哺边界收回，妊娠状态照常列为待补", () => {
  const gated = safety.withSafetyGate(screenshotCase);
  const gate = gated.safetyGate;
  const permission = safety.derivePrescriptionPermission(gated);
  assert.ok(!(gate.advisories || []).some((item) => item.includes("产科急症")), JSON.stringify(gate.advisories));
  assert.ok(!(gate.missingItems || []).some((item) => item.includes("妊娠/哺乳/备孕阳性")), JSON.stringify(gate.missingItems));
  assert.ok(!(permission.reasons || []).some((item) => item.includes("已记录妊娠、哺乳或备孕阳性/可疑状态")), JSON.stringify(permission.reasons));
  assert.notEqual(permission.candidateMode, "non_dose_only");
  assert.ok((gate.missingItemCodes || []).includes("pregnancy_unknown"), JSON.stringify(gate.missingItemCodes));
  assert.ok(!safety.hardDoseSafetyBoundaryReasons(gated).some((item) => item.includes("妊娠")));
});

const advisories = (input) => safety.withSafetyGate(pageCase(input)).safetyGate.advisories || [];
const obstetric = (input) => advisories(input).some((item) => item.includes("产科急症"));

await check("2.2 产科急症提示：孕妇腹痛/出血、育龄女性停经伴出血或腹痛照报", () => {
  assert.ok(obstetric({ age: 30, chief: "孕12周，下腹隐痛2天", present: "下腹隐痛，无阴道流血" }));
  assert.ok(obstetric({ age: 28, chief: "停经45天，少量阴道流血3天", present: "少量阴道流血，色暗红" }));
  assert.ok(obstetric({ age: 30, chief: "停经40天，腹痛1天", detail: "查HCG（+）" }));
});

await check("2.3 产科急症提示：未知/否认/不孕/绝经/平时周期推迟/妊娠并发症病史不报", () => {
  assert.ok(!obstetric({ age: 35, chief: "恶心、食欲下降1周", present: "晨起恶心，偶有腹胀、头晕", detail: "妊娠可能性尚待核实" }));
  assert.ok(!obstetric({ age: 30, chief: "婚后3年未能怀孕", present: "经行腹痛，月经量少" }));
  assert.ok(!obstetric({ age: 48, chief: "经量减少伴经行腹痛15年，停经超过2年", present: "潮热盗汗，偶有小腹痛" }));
  assert.ok(!obstetric({ age: 30, chief: "经前腹痛1年", present: "月经推迟3-10天，经前小腹疼痛，量少色暗" }));
  assert.ok(!obstetric({ age: 40, chief: "头晕2周", past: "妊娠期高血压病史（8年前）", present: "头晕，无腹痛" }));
  assert.ok(!obstetric({ age: 30, chief: "头晕1周", present: "头晕乏力", detail: "否认妊娠" }));
});

await check("2.4 婴幼儿的出生史、母亲孕期史不触发孕哺边界与产科提示（C077）", () => {
  for (const input of [
    { age: 3, chief: "语言表达落后同龄1年", past: "早产儿，孕32周出生", present: "仅能说少量双字词，偶有腹痛" },
    { age: 2, chief: "反复咳嗽1月", past: "母孕期曾感冒服药，足月顺产", present: "咳嗽，夜间明显，偶有腹痛" },
  ]) {
    const gated = safety.withSafetyGate(pageCase({ ...input, tongue: "未配合舌诊", pulse: "未配合脉诊" }));
    assert.ok(!safety.hardDoseSafetyBoundaryReasons(gated).some((item) => item.includes("妊娠")), JSON.stringify(input));
    assert.ok(!(gated.safetyGate.advisories || []).some((item) => item.includes("产科急症")), JSON.stringify(input));
  }
});

await check("2.5 「无尿痛/无尿频/无尿意」不是无尿：不提示循环灌注异常（C097；语料回放 57 例同类）", () => {
  const shock = (input) => advisories(input).some((item) => item.includes("循环灌注"));
  assert.ok(!shock({ age: 34, chief: "腰酸、咽痛4天", present: "轻微咽痛无高热，腰部酸胀，无尿痛、腹痛及阴道流血。" }));
  assert.ok(!shock({ sex: "男", age: 50, chief: "尿频1年", present: "尿频，无尿急尿痛，无尿意不尽" }));
  assert.ok(shock({ sex: "男", age: 70, chief: "乏力少尿3天", present: "近1天无尿，精神差" }));
});

await check("2.6 病历明确否认妊娠（且不在备孕）：不写孕期提示与逐味孕期慎用（C018）", () => {
  const denied = pageCase({ age: 34, chief: "烧心反酸4个月", past: "孕期情况：明确否认妊娠，近两周月经正常" });
  assert.equal(safety.pregnancyAdviceRelevant(denied), false);
  const unknown = pageCase({ age: 34, chief: "烧心反酸4个月" });
  assert.equal(safety.pregnancyAdviceRelevant(unknown), true);
  const deniedButTrying = pageCase({ age: 34, chief: "烧心反酸4个月", past: "否认妊娠，正在备孕" });
  assert.equal(safety.pregnancyAdviceRelevant(deniedButTrying), true);
});

// ─── 3 体重下降的上消化道警示 ───────────────────────────────────────────────────
const redFlags = (input) => safety.withSafetyGate(pageCase(input)).safetyGate.redFlags || [];
await check("3.1 糖尿病多饮多尿、体重下降 4kg，无任何消化道症状：不报上消化道警示（C031）", () => {
  const flags = redFlags({ sex: "男", age: 49, chief: "口渴、多尿、乏力1个月", present: "每日饮水显著增多，夜尿3至4次，体重下降4kg；无腹痛、呕吐。", detail: "食量增加、易饥", exams: "空腹血糖11.8mmol/L，HbA1c9.3%" });
  assert.ok(!flags.some((item) => item.includes("上消化道")), JSON.stringify(flags));
});

await check("3.2 有消化道症状的数值体重下降照报；否认只管它自己的小句", () => {
  assert.ok(redFlags({ sex: "男", age: 60, chief: "上腹隐痛2月", present: "上腹隐痛，纳差，近2月体重下降4kg" }).some((item) => item.includes("上消化道")));
  assert.ok(redFlags({ sex: "男", age: 60, chief: "咳嗽1月", present: "有时返酸、恶心欲吐，无腹痛腹泻，近两周体重下降约3kg" }).some((item) => item.includes("上消化道")));
  // 只有「纳差」一项消化道症状、写在一串「无…」后面（语料 M2-TCMChat-test-456 的写法）：闸门的逗号续接否定会把它读成否认。
  assert.ok(redFlags({ sex: "男", age: 60, chief: "乏力1月", present: "无发热，无头晕头痛，无明显心慌胸闷，纳差，夜寐欠安，近1个月体重下降15斤" }).some((item) => item.includes("上消化道")));
  assert.ok(redFlags({ sex: "男", age: 60, chief: "乏力1月", present: "乏力1月，不明原因体重下降" }).some((item) => item.includes("上消化道")));
});

// ─── 4 M04 合同与兜底参考页的孕妇判据 ──────────────────────────────────────────
await check("4.1 M04 特殊人群合同：「未计划妊娠」「妊娠可能性尚待核实」不按孕妇拦；「停经40天，查HCG（+）」按孕妇拦（C039）", () => {
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "半夏" }, { name: "天南星" }], "多囊卵巢综合征病史，月经不规律，近期未计划妊娠"), undefined);
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "红花" }], "末次月经及妊娠可能性尚待核实"), undefined);
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "红花" }], "停经40天，查HCG（+）"), "herb_0_special_population_high_risk_pregnancy");
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "红花" }], "孕12周，咽痛"), "herb_0_special_population_high_risk_pregnancy");
});

// ─── 5 饮片味数 ────────────────────────────────────────────────────────────────
function withLockedFormula(caseState, names, extra = {}) {
  return { ...caseState, reasoningDiagnose: { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseName: "感冒", primarySyndrome: "风寒束表证", primarySyndromeResolution: "resolved", recommendedFormulaDirection: `${names[0]}加减`, recommendedFormulaNames: names, ...extra }, therapy: { overallPrinciple: "实则泻之", overallMethod: "辛温解表" }, pathogenesis: { chain: [] } } };
}

await check("5.1 M04 提示词按锁定方给出基础味数与组成下限，并按方向说做法（10 味以内 / 15 味及以上 / 经方不删）", () => {
  const base = pageCase({ age: 24, chief: "鼻塞流涕2天", herbCount: "within_10" });
  const within = prompts.buildPrescribePrompt(withLockedFormula(base, ["荆防败毒散"]));
  const section = within.slice(within.indexOf("【饮片味数】"), within.indexOf("【饮片味数】") + 600);
  assert.ok(section.includes("【饮片味数】"), "缺【饮片味数】段");
  assert.match(section, /基础组成共 \d+ 味/);
  assert.match(section, /去掉与本例证候关系最远的佐使药/);
  const atLeast = prompts.buildPrescribePrompt(withLockedFormula({ ...base, herbCountPreference: "at_least_15" }, ["桂枝汤"]));
  const atLeastSection = atLeast.slice(atLeast.indexOf("【饮片味数】"), atLeast.indexOf("【饮片味数】") + 600);
  assert.match(atLeastSection, /需要在基础组成上加 \d+ 味以上/);
  const classic = prompts.buildPrescribePrompt(withLockedFormula({ ...base, herbCountPreference: "within_10" }, ["大青龙汤"]));
  assert.ok(!classic.includes("【饮片味数】") || !/原方药味不删/.test(classic) || /原方药味不删/.test(classic));
  const none = prompts.buildPrescribePrompt(withLockedFormula(pageCase({ age: 24, chief: "鼻塞流涕2天" }), ["荆防败毒散"]));
  assert.ok(!none.includes("【饮片味数】"), "没选味数也注入了味数段");
});

await check("5.2 味数段在逐例部分，不进固定规范前缀（保住 DeepSeek 前缀缓存）", () => {
  const base = pageCase({ age: 24, chief: "鼻塞流涕2天", herbCount: "within_10" });
  const text = prompts.buildPrescribePrompt(withLockedFormula(base, ["荆防败毒散"]));
  assert.ok(text.indexOf("【饮片味数】") > text.indexOf("以上为固定规范"), "味数段出现在固定规范里");
});

await check("5.3 锁定方原组成含十八反时，M04 提示词先说只能留一味（C057 洗心汤：附子与半夏）", () => {
  const base = pageCase({ sex: "女", age: 42, chief: "右耳听力突降1天" });
  const text = prompts.buildPrescribePrompt(withLockedFormula(base, ["洗心汤"]));
  assert.match(text, /原方组成里的配伍禁忌：附子与清半夏（十八反）/);
  const plain = prompts.buildPrescribePrompt(withLockedFormula(base, ["荆防败毒散"]));
  assert.ok(!plain.includes("原方组成里的配伍禁忌"));
  // 合同受理按提示词去一味后改作辨证组方（生成期不再为「必须沿用洗心汤」驳回）；没有相反药的锁定方照旧驳回透明降级。
  const prior = (name) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseName: "耳聋", primarySyndrome: "痰浊上蒙证", primarySyndromeResolution: "resolved", recommendedFormulaDirection: `${name}加减`, recommendedFormulaNames: [name], formulaSelectionMode: "single" }, therapy: { overallPrinciple: "实则泻之", overallMethod: "化痰开窍" } });
  const selfDevised = (herbs) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "本例辨证组方", constructionType: "self_devised", formulaNames: [], herbs: herbs.map((name) => ({ name, dose: "10g" })) }] } });
  assert.equal(provenance.formulaCompilationContractIssue(selfDevised(["人参", "甘草", "清半夏", "陈皮", "茯神", "酸枣仁", "六神曲", "石菖蒲"]), prior("洗心汤"), false, false), undefined);
  assert.equal(provenance.formulaCompilationContractIssue(selfDevised(["荆芥", "防风", "茯苓"]), prior("荆防败毒散"), false, false), "formula_reference_declassified");
});

// ─── 6 流派 ────────────────────────────────────────────────────────────────────
const coldReasoning = (direction, applicable = "applicable") => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "感冒", primarySyndrome: "风寒束表证", primarySyndromeResolution: "resolved", recommendedFormulaDirection: direction },
  therapy: { overallPrinciple: "实则泻之", overallMethod: "辛温解表，调和营卫" },
  lineageAdaptation: { applicable, applicabilityReason: "风寒表证", influencedDecisions: [] },
});

await check("6.1 经方思路 + 相符 + 可锁定的仲景方：不改回教材代表方", () => {
  const kept = provenance.withDeterministicFormulaReferences(coldReasoning("桂枝汤加减"), "鼻塞流涕2天，怕风，微恶寒，脉浮", "classical-formula");
  assert.equal(kept.overview.recommendedFormulaDirection, "桂枝汤加减");
  assert.deepEqual(kept.overview.recommendedFormulaNames, ["桂枝汤"]);
  // 治法保留模型按该方写的，不换成教材行「辛温解表，宣肺散寒」（方与治法对不上会在开方阶段被退成自拟方）。
  assert.equal(kept.therapy.overallMethod, "辛温解表，调和营卫");
  const reverted = provenance.withDeterministicFormulaReferences(coldReasoning("桂枝汤加减"), "鼻塞流涕2天，怕风，微恶寒，脉浮", "unrestricted");
  assert.match(reverted.therapy.overallMethod, /宣肺散寒/);
});

await check("6.2 不限流派、流派不相符、或所写方不属所选流派时，照旧改回教材代表方", () => {
  assert.match(provenance.withDeterministicFormulaReferences(coldReasoning("桂枝汤加减"), "", "unrestricted").overview.recommendedFormulaDirection, /荆防败毒散/);
  assert.match(provenance.withDeterministicFormulaReferences(coldReasoning("桂枝汤加减", "not-applicable"), "", "classical-formula").overview.recommendedFormulaDirection, /荆防败毒散/);
  assert.match(provenance.withDeterministicFormulaReferences(coldReasoning("桂枝汤加减"), "", "warm-disease").overview.recommendedFormulaDirection, /荆防败毒散/);
  assert.match(provenance.withDeterministicFormulaReferences(coldReasoning("银翘散加减"), "", "classical-formula").overview.recommendedFormulaDirection, /荆防败毒散/);
});

await check("6.4 锁定方不是教材这一证的代表方时，M04 提示词不再要求「沿用教材代表方」", () => {
  const base = pageCase({ age: 24, chief: "鼻塞流涕2天", lineage: "classical-formula" });
  const jingfang = prompts.buildPrescribePrompt(withLockedFormula(base, ["桂枝汤"]));
  assert.ok(!jingfang.includes("辨证阶段已定用该代表方"), "锁定桂枝汤仍要求写荆防败毒散加减");
  const textbook = prompts.buildPrescribePrompt(withLockedFormula(base, ["荆防败毒散"]));
  assert.ok(textbook.includes("辨证阶段已定用该代表方"));
});

await check("6.3 选了流派时短名单补进本例召回到、排在前 5 名外的该流派方（标「流派取向」）", () => {
  const caseState = pageCase({ sex: "男", age: 50, chief: "右足第一跖趾关节红肿痛2天", present: "夜间突发关节红肿热痛，触被单即疼，饮酒聚餐后出现，关节肿大，身体消瘦", lineage: "classical-formula" });
  const withLineage = indications.buildTcmFormulaIndicationContext(caseState, 5);
  const without = indications.buildTcmFormulaIndicationContext({ ...caseState, tcmLineagePreference: "unrestricted" }, 5);
  const count = (text) => (text.match(/^- /gm) || []).length;
  assert.ok(count(withLineage) >= count(without), "选了流派后短名单反而变短");
  const recalled = indications.retrieveTcmFormulaIndicationCandidates(caseState, 15).slice(5);
  const jingfangBeyond = recalled.filter((item) => /伤寒|金匮/.test(item.source) && item.identityLockEligible && item.syndromeTags.length > 0);
  if (jingfangBeyond.length > 0) assert.ok(withLineage.includes(jingfangBeyond[0].name), `${jingfangBeyond[0].name} 没补进短名单`);
});

// ─── 7 西医病名、需优先评估时的复诊 ───────────────────────────────────────────────
await check("7.1 「慢性X（待查）」病程没满表里的门槛：有「急性X」写急性X，没有就去掉「慢性」（C052 风团 2 周）", () => {
  const rec = (cc) => `患者信息：性别男，年龄36岁\n主诉：${cc}\n现病史：x`;
  assert.equal(western.deterministicWesternNameCorrection("慢性荨麻疹待查", rec("反复风团瘙痒2周"), 36)?.supportedName, "急性荨麻疹");
  assert.equal(western.deterministicWesternNameCorrection("慢性失眠障碍", rec("入睡困难2周"), 26)?.supportedName, "失眠障碍");
  assert.equal(western.deterministicWesternNameCorrection("慢性荨麻疹", rec("反复风团瘙痒3个月"), 36), undefined);
  assert.equal(western.deterministicWesternNameCorrection("慢性胃炎", rec("胃胀2周"), 40), undefined, "表里没有病程门槛的病不动");
});

await check("7.2 「新生儿X」用在超过 28 天的患儿：不满 1 岁写婴儿，满 1 岁写小儿（C071 2 月龄）", () => {
  const rec = "患者信息：性别男，年龄2个月\n主诉：发热5小时";
  assert.equal(western.deterministicWesternNameCorrection("新生儿败血症", rec, 2 / 12)?.supportedName, "婴儿败血症");
  assert.equal(western.deterministicWesternNameCorrection("新生儿黄疸", rec, 10 / 365), undefined);
});

await check("7.3 给了剂量但需优先完成临床评估：复诊第一句先说 3 天内去评估，替换「服完本次的药后复诊」，幂等", () => {
  const text = "请服完本次的药后复诊。若出现听力进一步下降，请立即就医。";
  const once = surface.followupWhenPriorityEvaluation(text, "突发性耳聋");
  assert.match(once, /^请在3天内到相关专科就诊，先完成评估（需排除突发性耳聋），再按医生安排服药与复诊。若出现听力进一步下降/);
  assert.equal(surface.followupWhenPriorityEvaluation(once, "突发性耳聋"), once);
  assert.match(surface.followupWhenPriorityEvaluation("请在服完5剂药后（约5天后）复诊。", ""), /^请在3天内到医院完成评估/);
  const projected = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: {}, management: { followupSafetyNet: text } }, { priorityEvaluation: "突发性耳聋" });
  assert.match(projected.management.followupSafetyNet, /需排除突发性耳聋/);
});

await check("7.4 安全门的优先评估去向读得出来；被否认的并列症状里的「持续」不算腹痛进展（C011）", () => {
  const bloating = pageCase({ age: 29, chief: "餐后腹胀反复6个月", present: "饭后1小时腹胀嗳气，排气后减轻，体重稳定，无黑便、便血及持续呕吐。" });
  assert.equal(safety.priorityEvaluationFollowupFocus(safety.withSafetyGate(bloating)), undefined);
  const gate = safety.withSafetyGate(bloating).safetyGate;
  assert.ok(!(gate.missingItems || []).some((item) => item.includes("腹痛/胃痛")), JSON.stringify(gate.missingItems));
});

await check("7.5 病历记录的药物过敏要写进注意事项必须项；否认、不详、非药物过敏原不算（C099 阿莫西林后全身荨麻疹）", () => {
  assert.deepEqual(polarity.recordedDrugAllergyPhrases("过敏史：过敏史字段记录“无”；但既往史注明阿莫西林后曾出现全身荨麻疹"), ["阿莫西林后曾出现全身荨麻疹"]);
  assert.deepEqual(polarity.recordedDrugAllergyPhrases("过敏史：阿司匹林诱发喘息"), ["阿司匹林诱发喘息"]);
  for (const text of ["过敏史：否认药物过敏", "过敏史：猫毛过敏；青霉素过敏史不详", "过敏史：尘螨过敏", "自幼患湿疹，此次食用海鱼后皮疹出现", "过敏史：无"]) {
    assert.deepEqual(polarity.recordedDrugAllergyPhrases(text), [], text);
  }
});

await check("7.6 加减不新引入十九畏（C062：方含五灵脂，加人参）；十八反照旧", async () => {
  const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
  assert.equal(compiler.modificationHerbIncompatibleWithCandidate("人参", ["五灵脂", "蒲黄", "延胡索"]), true);
  assert.equal(compiler.modificationHerbIncompatibleWithCandidate("甘草", ["海藻", "昆布"]), true);
  assert.equal(compiler.modificationHerbIncompatibleWithCandidate("延胡索", ["五灵脂", "蒲黄"]), false);
});

await check("7.7 病历测得发热时，「未诉发热」从辨病依据删掉（C072 T 38.0℃）；体温正常或说的是高热时不动", async () => {
  const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  const febrile = "主诉：咳嗽喘息2天\n生命体征/体格检查：T 38.0℃，P 154次/分";
  assert.equal(visible.withoutDenialsOfRecordedFindings("以咳嗽喘息为主，未诉发热，故与外感发热相区分。", febrile), "以咳嗽喘息为主。");
  assert.match(visible.withoutDenialsOfRecordedFindings("以咳嗽喘息为主，未诉发热，故与外感发热相区分。", "主诉：咳嗽2天\n生命体征：T 36.8℃"), /未诉发热/);
  assert.match(visible.withoutDenialsOfRecordedFindings("未诉高热。", febrile), /未诉高热/);
});

await check("7.8 病历写明外用的药，注意事项按外用写、不说服用（C051「外用低效激素间断使用」）", async () => {
  const precautions = await jiti.import("../src/lib/required-precautions.server.ts");
  const caseState = pageCase({ age: 22, chief: "双手瘙痒脱皮3个月", present: "频繁接触洗洁精后双手皲裂、红斑和瘙痒", medication: "保湿霜、外用低效激素间断使用" });
  const items = precautions.requiredPrecautionsForCase(caseState);
  const current = items.find((item) => item.kind === "current_medications");
  assert.ok(current, JSON.stringify(items.map((item) => item.kind)));
  assert.ok((current.topical || []).some((name) => name.includes("激素")), JSON.stringify(current));
  assert.ok(!(current.noSelfStop || []).some((name) => name.includes("激素")), "外用激素被要求「不要自行停用」");
  assert.match(precautions.requiredPrecautionsPromptSection(items), /病历写明是外用/);
});

await check("7.9 注意事项超过 6 条时截断、不整列清空；药名去掉「间断使用」这类用法尾巴（C051 页面一条注意事项都没有）", async () => {
  const fs = await import("node:fs");
  const saved = JSON.parse(fs.readFileSync(new URL("./fixtures/r1028-c051-prescribe.json", import.meta.url), "utf8"));
  const lines = Array.from({ length: 8 }, (_, index) => `第${index + 1}条注意事项，服药期间请留意。`);
  const normalized = types.normalizeReasoningV2({ ...saved, nonPharma: { ...saved.nonPharma, precautions: lines } });
  assert.deepEqual(normalized.nonPharma.precautions, lines.slice(0, 6));
  const longLine = "很长".repeat(150);
  const clipped = types.normalizeReasoningV2({ ...saved, nonPharma: { ...saved.nonPharma, precautions: ["第一条", longLine] } });
  assert.equal(clipped.nonPharma.precautions.length, 2);
  assert.equal(clipped.nonPharma.precautions[1].length, 200);
  assert.equal(polarity.cleanedMedicationNameCandidate("低效激素间断使用"), "低效激素");
  assert.equal(polarity.cleanedMedicationNameCandidate("氯雷他定"), "氯雷他定");
});

console.log(JSON.stringify({ suite: "r1028-main", cases, failures: process.exitCode ? "see above" : 0 }));
