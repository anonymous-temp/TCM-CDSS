// 第四十七轮 S4b：诊断表、检索来源和调护闭环。夹具全部为合成输入。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` }, moduleCache: false });
const check = async (id, title, run) => { try { await run(); console.log(`✓ ${id} ${title}`); } catch (error) { console.error(`✗ ${id} ${title}\n ${error.stack || error}`); process.exitCode = 1; } };
const criteria = await jiti.import("../src/lib/western-diagnostic-criteria.server.ts");
const search = await jiti.import("../src/lib/deepseek-web-search.server.ts");
const policy = await jiti.import("../src/lib/western-evidence-policy.ts");
const care = await jiti.import("../src/lib/western-disease-care.ts");
const required = await jiti.import("../src/lib/required-precautions.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const entries = JSON.parse(fs.readFileSync("src/data/western-diagnostic-criteria.source.json", "utf8")).entries;
const rx = (lines = []) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", nonPharma: { precautions: lines, diet: "", exercise: "" }, management: { followupSafetyNet: "请在24小时内到医院评估。" }, formula: { candidates: [], modifications: [] } });
await check("1.1", "扩表、别名与待查共享同一条目", () => {
  assert.ok(entries.length >= 400);
  assert.equal(new Set(entries.map((e) => e.name)).size, entries.length);
  assert.equal(criteria.westernCriteriaEntry("声带小结待查")?.name, "声带结节");
  assert.equal(criteria.westernCriteriaEntry("COPD")?.name, "慢性阻塞性肺疾病");
});
await check("1.2", "临床上感不强要检查、缺铁贫血仍要铁代谢，新增条目已复核", () => {
  assert.equal(criteria.westernCriteriaEntry("急性上呼吸道感染").clinicallyDiagnosable, true);
  assert.deepEqual(criteria.westernCriteriaEntry("急性上呼吸道感染").requiredTests, []);
  assert.equal(criteria.westernCriteriaEntry("缺铁性贫血").clinicallyDiagnosable, false);
  assert.match(criteria.westernCriteriaEntry("缺铁性贫血").requiredTests.join(""), /铁/);
  assert.ok(entries.filter((e) => e.retrievedAt === "2026-11-15").every((e) => e.reviewedAt));
});
await check("1.3", "每条最终病名均可返回白名单内、非空引用，未知病名不伪造", () => {
  for (const e of entries) {
    const refs = criteria.westernGuidelineReferencesForName(e.name);
    assert.equal(refs.length, 1, e.name);
    assert.ok(policy.isAllowedWesternEvidenceUrl(refs[0].url), e.name);
    assert.ok(refs[0].title && refs[0].siteName, e.name);
  }
  assert.deepEqual(criteria.westernGuidelineReferencesForName("不存在的合成病名"), []);
});
await check("2.1", "URL边界和专业版路径拦伪站、家用版、公众号、医院科普", () => {
  for (const url of ["https://msdmanuals.cn.evil.test/professional/x", "https://www.msdmanuals.cn/home/x", "https://mp.weixin.qq.com/x", "https://hospital.example.org/x"])
    assert.equal(policy.isAllowedWesternEvidenceUrl(url), false, url);
  assert.equal(policy.isAllowedWesternEvidenceUrl("https://www.msdmanuals.cn/professional/x"), true);
});
const hit = (title, url, extra = {}) => ({ title, url, siteName: "伪造的高权威站名", summary: "临床诊断要点".repeat(30), authority: 4, rerankScore: 9, date: null, ...extra });
await check("2.2", "在线结果须白名单且标题对题，中文优先", () => {
  const rows = search.filterWesternSearchResults([
    hit("缺铁性贫血", "https://mp.weixin.qq.com/x"),
    hit("肾病综合征诊断", "https://www.nhc.gov.cn/x"),
    hit("缺铁性贫血诊断", "https://www.nhc.gov.cn/zh", { rerankScore: 1 }),
    hit("缺铁性贫血诊断", "https://www.nhc.gov.cn/low", { authority: 2 }),
  ], "缺铁性贫血");
  assert.deepEqual(rows.map((r) => r.url), ["https://www.nhc.gov.cn/zh"]);
  const ordered = search.filterWesternSearchResults([hit("COPD", "https://www.nice.org.uk/guidance/ng115"), hit("COPD慢阻肺诊断", "https://www.nhc.gov.cn/c", { rerankScore: 1 })], "COPD");
  assert.equal(ordered[0].url, "https://www.nhc.gov.cn/c");
});
await check("2.3", "症状级病名在配置解析前返回，不发网络请求", async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("network should not run"); };
  try {
    for (const name of ["嗜睡", "喘息", "腹痛"]) assert.deepEqual(await search.webSearchGovernedTerm(name, "诊断标准"), []);
    assert.equal(calls, 0);
    // 结构性前置顺序亦钉住：无凭证时仅靠 [] 无法反证这一道守卫。
    const source = fs.readFileSync("src/lib/deepseek-web-search.server.ts", "utf8");
    assert.ok(source.indexOf("if (symptomLevelWesternName(name)) return [];") < source.indexOf("const config = textModelConfigForModel("));
    assert.ok(source.includes("if (symptomLevelWesternName(name)) return [];"));
  } finally { globalThis.fetch = previous; }
});
await check("3.1", "调护按最终西医病名/别名逐项命中，并发病也覆盖", () => {
  assert.ok(care.diseaseCareItemsForName("低血糖症").length >= 2);
  assert.ok(care.diseaseCareItemsForName("慢性肾脏病4期伴高钾血症").some((i) => i.disease === "高钾血症"));
  assert.deepEqual(care.diseaseCareItemsForName("肌无力"), []);
  const state = types.normalizeCaseStateInput({ chiefComplaint: "乏力2天", patient: { age: 35, sex: "男" }, symptoms: { 现病史: "近日食欲一般。" } });
  const items = required.requiredPrecautionsForCase(state, { westernDiagnosis: { primary: { name: "肝硬化腹水" } } });
  assert.ok(items.some((i) => i.kind === "disease_care" && i.sentence.includes("低盐")));
  assert.match(required.requiredPrecautionsPromptSection(items), /有腹水时应低盐/);
});
await check("3.2", "最终逐项补写且幂等，不触动复诊首句", () => {
  const items = care.diseaseCareItemsForName("肝硬化腹水"); const input = rx(["注意休息。", "如正在服用其他药物，请先告知医生，避免药效重复或相互影响。", "若出现皮疹请就医。", "保持规律作息。"]);
  const out = surface.projectDeliveredReasoning(input, { requiredPrecautions: items });
  for (const item of items) assert.ok(out.nonPharma.precautions.includes(item.sentence), item.id);
  assert.ok(out.nonPharma.precautions.includes(input.nonPharma.precautions[1]), "病名必写项不挤掉原有用药提示");
  assert.equal(out.management.followupSafetyNet, input.management.followupSafetyNet);
  assert.deepEqual(surface.projectDeliveredReasoning(out, { requiredPrecautions: items }), out);
});
await check("3.3", "冲突整句删除，正确的禁食物建议保留，低血糖不强喂", () => {
  const items = care.diseaseCareItemsForName("低血糖症");
  const out = surface.projectDeliveredReasoning({ ...rx(["少吃甜食。", "注意休息。"]), management: { followupSafetyNet: "请在24小时内到医院评估。少吃甜食。" }, nonPharma: { precautions: ["少吃甜食。", "注意休息。"], diet: "少吃甜食。饮食规律。", exercise: "" } }, { requiredPrecautions: items });
  assert.ok(!JSON.stringify(out).includes("少吃甜食"));
  assert.equal(out.management.followupSafetyNet, "请在24小时内到医院评估。");
  assert.ok(out.nonPharma.precautions.some((x) => x.includes("不能吞咽时不要喂食")));
  assert.equal(care.withoutDiseaseCareConflicts("避免饮酒。可以饮酒。避免饮酒，但可以饮酒。", care.diseaseCareItemsForName("肝硬化")), "避免饮酒。");
  assert.equal(care.withoutDiseaseCareConflicts("忌辛辣温燥、酒及浓茶咖啡。", care.diseaseCareItemsForName("甲状腺功能亢进症")), "忌辛辣温燥、酒及浓茶咖啡。", "禁忌列举的顿号不终止限制范围");
});
await check("3.4", "急症不输出恢复期运动；时限保留在注意事项", () => {
  assert.deepEqual(care.diseaseCareItemsForName("慢性阻塞性肺疾病", true), []);
  const items = care.diseaseCareItemsForName("低血糖症", true);
  assert.ok(items.some((i) => i.timeWindow.includes("15分钟")));
  assert.ok(items.some((i) => i.sentence.includes("立即")));
  const priorityEvaluation = { focus: "急危重情况", window: "immediately", pathway: "red_flag_clearance" };
  const before = surface.projectDeliveredReasoning(rx(), { priorityEvaluation });
  const after = surface.projectDeliveredReasoning(rx(), { priorityEvaluation, requiredPrecautions: items });
  assert.equal(after.management.followupSafetyNet, before.management.followupSafetyNet, "调护的15分钟节点不得改写立即急诊的首句");
  assert.deepEqual(surface.projectDeliveredReasoning(after, { priorityEvaluation, requiredPrecautions: items }), after);
});
await check("3.5", "停用旧口径、疑诊不直接要求用药", () => {
  assert.ok(!care.diseaseCareItemsForName("腰椎间盘突出症").some((i) => i.sentence.includes("卧硬板床3周")));
  assert.ok(!care.diseaseCareItemsForName("高血压待查").some((i) => i.careKind === "medication_safety"));
  assert.ok(!care.diseaseCareItemsForName("骨量减少").length);
});
