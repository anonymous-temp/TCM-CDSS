// 第三十六轮（2026-11-02）：甲方 11/2 实测（开始传体格检查、16 条链路全选扶阳）读出来的缺陷。
// 每条断言都有反证（~/runlogs/r1018/work/r1048/cp/）。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const check = async (name, run) => {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const western = await jiti.import("../src/lib/western-rationale-alignment.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");

await check("1.1 西医说明改名后不留残句：描述随断言去掉", () => {
  assert.equal(western.rationaleAlignedWithRenamedPrimary("活动后反缓解，符合心律失常类发作特点；尚无心电图", "心律失常", "D"), "活动后反缓解，考虑心律失常可能；尚无心电图");
  assert.equal(western.rationaleAlignedWithRenamedPrimary("伴长期酗酒，符合股骨头缺血性坏死早期表现，需影像学确立", "股骨头缺血性坏死", "D"), "伴长期酗酒，考虑股骨头缺血性坏死可能，需影像学确立");
  // 不是描述的后文照旧断开
  assert.equal(western.rationaleAlignedWithRenamedPrimary("符合胃炎需胃镜确认", "胃炎", "D"), "考虑胃炎可能，需胃镜确认");
});

const projected = (candidate) => {
  const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: { primarySyndrome: "气滞血瘀证" }, formula: { candidates: [{ herbs: [{ name: "川芎", role: "君" }, { name: "丹参", role: "君" }, { name: "甘草", role: "使" }], ...candidate }] } };
  return surface.projectDeliveredReasoning(reasoning).formula.candidates[0];
};

await check("2.1 自拟方方义里的「去X、去Y」（修复轮自述）不留；动宾不动", () => {
  const out = projected({ name: "自拟方", formulaAnalysis: "本方为自拟方。川芎、丹参为君，通络散结；甘草为使，调和诸药。去赤芍、去夏枯草、去菊花，全方共奏通络散结之功。" });
  assert.ok(!/去赤芍|夏枯草|菊花/u.test(out.formulaAnalysis), out.formulaAnalysis);
  assert.match(out.formulaAnalysis, /全方共奏通络散结之功/u);
  const verb = projected({ name: "自拟方", formulaAnalysis: "本方为自拟方。川芎、丹参为君，去瘀生新；甘草为使。" });
  assert.match(verb.formulaAnalysis, /去瘀生新/u);
});

await check("2.2 成方方义里「去X」不走这条（原方加减是真说法）", () => {
  const out = projected({ name: "血府逐瘀汤加减", formulaAnalysis: "本方以血府逐瘀汤为基础加减，去赤芍，川芎、丹参为君。" });
  assert.match(out.formulaAnalysis, /去赤芍/u);
});

await check("2.3 方名带「加味」时开头句只取方名本身", () => {
  const out = projected({ name: "二陈汤加味", herbs: [{ name: "半夏", role: "君" }, { name: "陈皮", role: "臣" }, { name: "茯苓", role: "臣" }, { name: "僵蚕", role: "佐" }, { name: "甘草", role: "使" }], formulaAnalysis: "本方以本方案为基础加减，半夏为君；甘草为使。" });
  assert.ok(!/加味为基础/u.test(out.formulaAnalysis), out.formulaAnalysis);
  assert.match(out.formulaAnalysis, /^本方以二陈汤为基础加减/u);
});

await check("3.1 筋伤进教材病名：肌肉拉伤能选到它，初期治法和方来自《中医骨伤科学》", () => {
  const row = textbook.textbookRowForSyndrome("筋伤", "气滞血瘀证");
  assert.equal(row?.book, "中医骨伤科学");
  assert.deepEqual(row?.formulas, ["桃红四物汤"]);
  assert.match(row?.therapy || "", /活血化瘀/u);
});

const visit = await jiti.import("../src/lib/western-visit-reason-check.server.ts");

await check("5.1 主诉的主要问题去掉伴随与病程", () => {
  assert.equal(visit.chiefComplaintLeadProblem("肌肉拉伤XXX天"), "肌肉拉伤");
  assert.equal(visit.chiefComplaintLeadProblem("左眼结膜充血伴赘生物XXX天"), "左眼结膜充血");
  assert.equal(visit.chiefComplaintLeadProblem("反复头痛3月，再发1天"), "头痛");
  assert.equal(visit.chiefComplaintLeadProblem("发现睑腺炎1月余"), "睑腺炎");
});

await check("5.2 只在主诊断与主诉毫无共同字、非红旗、非待查时才问", () => {
  assert.equal(visit.visitReasonCheckApplies("过敏性鼻炎", "肌肉拉伤XXX天"), true);
  assert.equal(visit.visitReasonCheckApplies("过敏性鼻炎", "肌肉拉伤XXX天", true), false);
  assert.equal(visit.visitReasonCheckApplies("偏头痛", "反复头痛3月"), false);
  assert.equal(visit.visitReasonCheckApplies("头痛待查", "肌肉拉伤3天"), false);
});

await check("5.3 落到最终内容：原诊断进鉴别并写明缘由；病名已被别的核对改掉时不动", () => {
  const content = JSON.stringify({ westernDiagnosis: { primary: { name: "过敏性鼻炎", clinicalRationale: "符合变应性鼻炎" }, candidates: [{ name: "过敏性鼻炎", likelihood: "高" }], differentials: [{ name: "感冒", reason: "x" }] } });
  const decision = { checkedName: "过敏性鼻炎", name: "肌肉拉伤", lead: "肌肉拉伤" };
  const out = JSON.parse(visit.applyWesternVisitReasonDecision(content, decision)).westernDiagnosis;
  assert.equal(out.primary.name, "肌肉拉伤");
  assert.match(out.primary.clinicalRationale, /本次就诊的问题是肌肉拉伤/u);
  assert.equal(out.candidates[0].name, "肌肉拉伤");
  assert.equal(out.differentials[0].name, "过敏性鼻炎");
  assert.match(out.differentials[0].reason, /主诉之外/u);
  const other = JSON.stringify({ westernDiagnosis: { primary: { name: "鼻炎待查" } } });
  assert.equal(visit.applyWesternVisitReasonDecision(other, decision), other);
});

await check("6.1 教材加减里切出来不是症状变化的条件不进候选", () => {
  const conditions = textbook.textbookRowForSyndrome("心衰", "气虚血瘀证")?.modifications.map((item) => item.condition) || [];
  assert.ok(conditions.length > 0);
  assert.ok(!conditions.some((item) => /比类/u.test(item)), conditions.join("|"));
  const bian = textbook.textbookRowForSyndrome("男性不育症", "气血两虚证")?.modifications.map((item) => item.condition) || [];
  assert.ok(!bian.some((item) => /除辨证论治外/u.test(item)), bian.join("|"));
  // 切剩一个字的条件（可）
  const single = textbook.textbookRowForSyndrome("喘证", "水凌心肺证")?.modifications.map((item) => item.condition) || [];
  assert.ok(!single.some((item) => item.replace(/^(?:若|如果|如)/u, "").trim().length < 2), single.join("|"));
});

await check("7.1 兼证键缺失时交付空数组（接口文档写明）", () => {
  const out = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { primarySyndrome: "气滞血瘀证" } });
  assert.deepEqual(out.overview.secondarySyndromes, []);
  const kept = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { primarySyndrome: "气滞血瘀证", secondarySyndromes: ["脾气虚证"] } });
  assert.deepEqual(kept.overview.secondarySyndromes, ["脾气虚证"]);
});
