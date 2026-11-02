// 第三十六轮（2026-11-02）：甲方 11/2 实测（开始传体格检查、16 条链路全选扶阳）读出来的缺陷。
// 每条断言都有反证（~/runlogs/r1018/work/r1048/cp/）。
import assert from "node:assert/strict";
import fs from "node:fs";
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

const repair = await jiti.import("../src/lib/structured-clinical-repair.ts");

await check("8.1 定向修复末尾多的括号去掉；别的语法错误照旧算失败", () => {
  const candidate = { herbs: [{ name: "桑寄生" }], referenceCaseUse: { adoptedCaseIds: [] } };
  const good = JSON.stringify({ candidate });
  assert.ok(repair.spliceM04CandidatePatch({ modifications: [] }, good));
  const out = repair.spliceM04CandidatePatch({ modifications: [] }, `${good}}`);
  assert.deepEqual(JSON.parse(out).candidate, candidate);
  assert.equal(repair.spliceM04CandidatePatch({}, good.slice(0, -2)), undefined);
  assert.equal(repair.spliceM04CandidatePatch({}, `${good}}}}}`), undefined, "多到不像手滑的不救");
});

await check("8.2 修复轮 JSON 用不了算修复机会用尽；连接失败不算", () => {
  const source = fs.readFileSync("src/lib/diagnosis-api.ts", "utf8");
  const at = source.indexOf('console.warn("[tcm-cdss:model] structured retry request failed"');
  assert.ok(at > 0);
  const block = source.slice(at, at + 700);
  assert.match(block, /opts\.structuredStage === "prescribe" && retry\.reason === "retry_invalid_json"\) m04RepairLoopEarlyExit = true/u);
});

await check("2.4 自拟方：「去X者」开头的整句连解释一起不留", () => {
  const out = projected({ name: "自拟方", formulaAnalysis: "本方为自拟方。川芎、丹参为君，通络散结。去柴胡、马勃、炒牛蒡子者，本例无卫分表证，故精简以合十味之限。全方共奏通络之功。" });
  assert.ok(!/柴胡|精简/u.test(out.formulaAnalysis), out.formulaAnalysis);
  assert.match(out.formulaAnalysis, /全方共奏通络之功/u);
});

await check("5.4 换成名单里的病时说明不写「按此诊断」", () => {
  const content = JSON.stringify({ westernDiagnosis: { primary: { name: "甲病" }, candidates: [{ name: "乙病", likelihood: "中" }], differentials: [] } });
  const out = JSON.parse(visit.applyWesternVisitReasonDecision(content, { checkedName: "甲病", name: "乙病", lead: "腹痛" })).westernDiagnosis;
  assert.match(out.primary.clinicalRationale, /考虑乙病/u);
  assert.equal(out.candidates[0].likelihood, "中");
});

await check("5.5 主诉有几个问题时能解释其中一个就算：提名和复核两边都这样问", () => {
  const source = fs.readFileSync("src/lib/western-visit-reason-check.server.ts", "utf8");
  assert.match(source, /能解释其中一个就算解释得了/u);
  assert.match(source, /能解释其中一个也答 false/u);
});

const secondary = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");

await check("9.1 依据说「非独立兼证」时撤下兼证，不要求点名；只说「兼证」不算", () => {
  assert.equal(secondary.secondaryStructurallyInvalid("心血不足证", "脾虚湿困证", "舌胖齿痕为脾虚水湿内停之象，属兼湿而非独立兼证；综合为心血不足。"), "declared_not_independent");
  assert.equal(secondary.secondaryStructurallyInvalid("心血不足证", "脾虚湿困证", "舌胖齿痕为脾虚水湿内停之象，兼证为脾虚湿困。"), undefined);
});

await check("10.1 顺带的睡眠差：安神写在一项里也不留；心神在证名里时照留", () => {
  assert.equal(surface.withoutIncidentalSedationMethod("滋阴固肾，缩尿止频，生津润燥，安神止痒", false), "滋阴固肾，缩尿止频，生津润燥，止痒");
  assert.equal(surface.withoutIncidentalSedationMethod("清养肺胃，生津润燥，敛汗安神", false), "清养肺胃，生津润燥，敛汗");
  assert.equal(surface.withoutIncidentalSedationMethod("滋阴固肾，安神止痒", true), "滋阴固肾，安神止痒");
  assert.equal(surface.withoutIncidentalSedationMethod("滋阴固肾，养心安神", false), "滋阴固肾");
});
