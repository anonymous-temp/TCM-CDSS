// 第二十八轮（2026-10-28）：遗留项与甲方病例再测出的问题按类收口。
// 每条断言都有反证（~/runlogs/r1018/work/r1040/cp/）。
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
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const authoring = await jiti.import("../src/lib/tcm-disease-differential-authoring.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const medicines = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
const secondary = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const boundary = await jiti.import("../src/lib/candidate-boundary-text.ts");

// ---------- 1 男性的中医病名鉴别：只属妇科的病在补写之前就不算数 ----------
// 甲方 100 例 C015（21 岁男性肠痈）：模型写了「异位妊娠」「腹痛」两项，交付面删掉异位妊娠后只剩一项——补写小任务在 M03 收口时
// 数到的是两项，没有补。数「留得下的鉴别」、补写候选、交付兜底现在用同一个判据 tcmDifferentialDiseaseFitsPatient。
await check("1.1 男性：异位妊娠不算留得下的病名鉴别（于是会补写到两项），教材候选也不给；女性照留；交付面同一判据", () => {
  const rows = [{ diseaseName: "异位妊娠", reason: "均可右下腹痛" }, { diseaseName: "腹痛", reason: "均以腹痛为主" }];
  assert.deepEqual(authoring.retainableDiseaseDifferentialRows(rows, "肠痈", { sex: "男" }).map((item) => item.name), ["腹痛"]);
  assert.deepEqual(authoring.retainableDiseaseDifferentialRows(rows, "肠痈", { sex: "女" }).map((item) => item.name), ["异位妊娠", "腹痛"]);
  assert.deepEqual(authoring.retainableDiseaseDifferentialRows(rows, "肠痈").map((item) => item.name), ["异位妊娠", "腹痛"]);
  assert.equal(textbook.tcmDifferentialDiseaseFitsPatient("异位妊娠", { sex: "男" }), false);
  assert.equal(textbook.tcmDifferentialDiseaseFitsPatient("异位妊娠", { sex: "女" }), true);
  assert.equal(textbook.tcmDifferentialDiseaseFitsPatient("胃痛", { sex: "男" }), true);
});

// ---------- 2 周围性面瘫的评估时限按激素窗口 ----------
// AAO-HNS 2013：起病 72 小时内口服激素；York 基层路径（NICE CKS 摘要）：起病 72 小时内就诊者考虑泼尼松龙。
const facialState = (chiefComplaint, history = "受风后出现左侧面部麻木，额纹消失，眼裂变大，鼻唇沟变浅，口角下垂。") => types.normalizeCaseStateInput({
  id: "r1040-facial", chiefComplaint, patient: { sex: "男", age: 35 }, symptoms: { 现病史: history },
  vitals: { T: "36.6", P: "76", R: "16", BP: "122/78" },
});
await check("2.1 起病不超过 72 小时或读不出起病时间：24 小时内；超过 72 小时：48 小时内（复诊句里的时限随之）", () => {
  assert.equal(safety.facialPalsyOnsetHours(facialState("口角歪斜2天")), 48);
  assert.equal(safety.facialPalsyOnsetHours(facialState("突发口眼歪斜1h")), 1);
  assert.equal(safety.peripheralFacialPalsyWindow(facialState("口角歪斜2天")), "within_24h");
  assert.equal(safety.peripheralFacialPalsyWindow(facialState("口角歪斜")), "within_24h");
  assert.equal(safety.peripheralFacialPalsyWindow(facialState("口角歪斜5天")), "within_48h");
  assert.equal(safety.peripheralFacialPalsyWindow(facialState("周围性面瘫11年")), "within_48h");
  assert.equal(safety.peripheralFacialPalsyWindow(facialState("口角歪斜", "1周前受风后出现左侧面部麻木，额纹消失，眼裂变大，口角下垂。")), "within_48h");
  const recent = safety.withSafetyGate(facialState("口角歪斜2天"));
  const late = safety.withSafetyGate(facialState("口角歪斜5天"));
  assert.equal(recent.safetyGate.status === "red_flag", false);
  assert.match(JSON.stringify(recent.safetyGate), /24小时内到神经内科或面瘫门诊/u);
  assert.match(JSON.stringify(late.safetyGate), /48小时内到神经内科或面瘫门诊/u);
  assert.equal(safety.priorityEvaluationFollowupTarget(recent)?.window, "within_24h");
  assert.equal(safety.priorityEvaluationFollowupTarget(late)?.window, "within_48h");
});

// ---------- 2b 写在「既往史：」一栏里的否认妊娠 ----------
// 甲方 100 例（接口形状）C018：「既往史：孕期情况：明确否认妊娠，近两周月经正常」判成既往，妊娠、哺乳、备孕三项都列为待补、又追问一次。
await check("2b.1 否认妊娠写在既往史栏里仍是现在的否认；肯定的妊娠写在既往史栏里照旧按既往", () => {
  const state = (pastHistory) => types.normalizeCaseStateInput({
    id: "r1040-c018", chiefComplaint: "烧心反酸4个月", patient: { sex: "女", age: 34 },
    symptoms: { 现病史: "晚餐后和躺下时胸骨后烧灼感，抬高床头有改善。", 既往史: pastHistory },
    vitals: { T: "36.6", P: "78", R: "18", BP: "112/74" },
  });
  const codes = (pastHistory) => safety.withSafetyGate(state(pastHistory)).safetyGate.missingItemCodes.filter((code) => /pregnancy|lactation|conception/u.test(code));
  assert.deepEqual(codes("孕期情况：明确否认妊娠，近两周月经正常"), []);
  assert.deepEqual(codes("否认妊娠"), []);
  assert.ok(codes("高血压病史3年").includes("pregnancy_unknown"));
  const clinical = jiti.import("../src/lib/clinical-state.ts");
  return clinical.then((m) => {
    assert.equal(m.assessPregnancyState("既往史：否认妊娠").status, "negative");
    assert.equal(m.assessPregnancyState("既往史：妊娠2次，均顺产").status === "positive", false);
  });
});

// ---------- 3 中成药说明书写的证与本例证候各在别的脏腑 ----------
// 甲方 10.12 标准病历 2（心悸·心虚胆怯证）推荐五味安神颗粒：说明书「适用于心脾两虚证」。说明书的证更宽（包含本例脏腑）不算。
const wuwei = "养心安神，健脾和中。适用于心脾两虚证，症见心烦，急燥易怒，心悸，口干，易汗出，睡眠多梦易醒，神疲乏力，食欲不振，肌肉酸楚。";
const direction = (names, method) => ({ names, method });
await check("3.1 心脾两虚证的成药不给心虚胆怯证；给心脾两虚证、心血虚证照给；肝肾阴虚的成药给肾阴虚证照给", () => {
  const conflict = (indication, names, method = "") => medicines.patentMedicineDirectionConflict({ clause: medicines.medicineFunctionClause(indication), herbs: [], indication }, direction(names, method));
  assert.equal(conflict(wuwei, "心虚胆怯证", "镇惊定志，养心安神"), "label_syndrome_other_organ");
  assert.equal(conflict(wuwei, "心脾两虚证", "补益心脾"), undefined);
  assert.equal(conflict(wuwei, "心血虚证", "养血安神"), undefined);
  assert.equal(conflict("补益肝肾，滋阴止血。用于肝肾阴虚，眩晕耳鸣，咽干鼻燥，腰膝酸痛，月经量多。", "肾阴虚证", "滋补肾阴"), undefined);
  assert.equal(medicines.labelSyndromeNamesOtherOrgan("肝胆湿热", "肝经郁热证"), false);
  assert.equal(medicines.labelSyndromeNamesOtherOrgan("脾胃虚弱", "肝郁气滞证"), true);
});

// ---------- 4 补兼证与模型自写兼证同一道结构判据 ----------
// 第二十七轮 qwen 评审 api-641286fcfcbf：风热犯肺证被补写路径补成「兼风寒表证」，治法末尾多出「辛温解表」。
await check("4.1 补写路径要补的兼证寒热与主证相反、已被主证包含时不补；正常的兼证照补", () => {
  const ctx = { primarySyndrome: "风热犯肺证", rationale: "发热重、微恶风、有汗，为风热袭表。", pathogenesis: "风热之邪袭表犯肺。", claims: [] };
  const add = (name) => ({ decision: "add", secondarySyndrome: name, method: "辛温解表", evidence: ["流清涕"] });
  const rejected = secondary.structurallyAdmissibleSecondaryDecision(add("风寒表证"), undefined, ctx);
  assert.equal(rejected.decision, undefined);
  assert.equal(rejected.rejected, "cold_heat_conflict");
  const entailed = secondary.structurallyAdmissibleSecondaryDecision(add("虚热证"), undefined, { ...ctx, primarySyndrome: "肾阴虚证" });
  assert.equal(entailed.rejected, "entailed_by_primary");
  const kept = secondary.structurallyAdmissibleSecondaryDecision(add("脾气虚证"), undefined, { ...ctx, primarySyndrome: "肝气犯胃证" });
  assert.equal(kept.decision?.decision, "add");
  assert.equal(kept.rejected, undefined);
});

// ---------- 5 「以泡沫多为主症」不是泛述 ----------
await check("5.1 「多为主」是量词谓语：其后未记录的「无涩痛」改成「未诉涩痛」；「多见」「多为」泛述仍不改", () => {
  const record = "主诉：嗜酒 口感 疲劳感强 小便泡沫多";
  assert.match(summary.unrecordedNegativesAsNotReported("以小便泡沫多为主症、尿时无涩痛，归入尿浊范畴。", record), /尿时未诉涩痛/u);
  assert.match(summary.unrecordedNegativesAsNotReported("膏淋多见小便混浊、无尿痛者少。", record), /无尿痛/u);
});

// ---------- 6 加减的人群慎用提示与每味药同一个写法 ----------
await check("6.1 男性、60 岁以上的人群提示不写「月经期」，育龄女性照写", () => {
  assert.equal(boundary.herbBoundaryPopulationLabel("出血倾向/月经期/抗凝状态", { reproductive: false, ageYears: 72 }), "出血倾向/抗凝状态");
  assert.equal(boundary.herbBoundaryPopulationLabel("出血倾向/月经期/抗凝状态", { reproductive: true, ageYears: 30 }), "出血倾向/月经期/抗凝状态");
});

// ---------- 7 「复评」换成临床写法 ----------
await check("7.1 模型写在鉴别里的「复评意识、体温」交付为「再次评估…」；没有该词的原样不动", () => {
  assert.equal(surface.clinicalWordingForSyntheticPhrases("复评意识、体温、血压及血气电解质"), "再次评估意识、体温、血压及血气电解质");
  const untouched = "复查血常规";
  assert.equal(surface.clinicalWordingForSyntheticPhrases(untouched), untouched);
});

// ---------- 8 红旗病例的辨证边界说法随剂量轴 ----------
// 剂量一致化（D4）以后红旗病例照给剂量、红旗解除前不能正式采纳；辨证页的不确定项仍写「本次不显示具体用量」，与开方页的剂量相抵
//（第二十八轮甲方接口病例 api-1a822c88d975：65 岁黑便、P112、BP94/60）。
await check("8.1 红旗：默认（照给剂量）写「风险解除前本方不能正式采纳」，不写「本次不显示具体用量」；CDSS_REDFLAG_DOSE_AUTHORIZATION=withhold 时照旧", () => {
  const reasoning = { stage: "diagnose", overview: { primarySyndrome: "脾不统血证", primarySyndromeResolution: "resolved", primarySyndromeResolutionReason: "" }, pathogenesis: { uncertainties: [] }, management: {} };
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const run = () => {
    const out = summary.annotateM03DecisionSpecificityBoundary(content, { reason: summary.m03RedFlagBoundaryReason(), mustCollect: "完成急危重风险评估", activeRedFlag: true });
    return JSON.parse(out.slice(out.indexOf("START -->") + 9, out.indexOf("<!-- DIAGNOSIS_JSON_END")));
  };
  const saved = process.env.CDSS_REDFLAG_DOSE_AUTHORIZATION;
  try {
    delete process.env.CDSS_REDFLAG_DOSE_AUTHORIZATION;
    const dosed = JSON.stringify(run());
    assert.doesNotMatch(dosed, /不显示具体用量|正式采纳与具体用量/u);
    assert.match(dosed, /风险解除前本方不能正式采纳|正式采纳须在风险处置之后/u);
    process.env.CDSS_REDFLAG_DOSE_AUTHORIZATION = "withhold";
    assert.match(JSON.stringify(run()), /本次不显示具体用量|正式采纳与具体用量/u);
  } finally {
    if (saved === undefined) delete process.env.CDSS_REDFLAG_DOSE_AUTHORIZATION; else process.env.CDSS_REDFLAG_DOSE_AUTHORIZATION = saved;
  }
});

console.log(`\n${cases} 项${process.exitCode ? "，有失败" : "，全部通过"}`);
