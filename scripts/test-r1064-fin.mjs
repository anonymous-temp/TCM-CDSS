// 第四十七轮终测后（2026-11-15）主会话修复：
//  1. 合方的主治覆盖按组判：一首覆盖本病/主诉时，同组其余各首主治与本例肯定表现共有 ≥2 个受控概念也算覆盖
//     （甲方标准病例5 补中益气汤合玉屏风散 3/3 被改成自拟方）；单方不走这条（风热痹阻用银翘散仍不放行）。
//  2. 终表方义缺省关：模型调用在 0.9 秒预算内 269/269 超时，全部落成逐味功效罗列；开启时预算够写完一段。
//  3. 终表方义兜底句：开头跟交付方名、药名相同的写法差异不写、同一原方的加去合成一句。
// 每条断言都有反证（~/runlogs/r1018/work/r1064/cp/fin.py）。
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

const indications = await jiti.import("../src/lib/tcm-formula-indications.ts");
const policy = await jiti.import("../src/lib/m04-final-content-policy.ts");
const analysis = await jiti.import("../src/lib/m04-final-analysis-validation.ts");

// 合成病历（不取自甲方原文）：老年女性反复外感，平素乏力气短、自汗、纳少便溏、面色萎黄。
const deficiencyRecord = [
  "主诉：反复感冒半年余",
  "现病史：近半年感冒六七次，每次迁延一周以上。平日容易疲倦，动则气短，常自汗出，胃口差，进食稍多则胀，大便溏薄，面色萎黄。",
].join("\n");
const deficiencyCase = { overview: { tcmDiseaseName: "虚劳", primarySyndrome: "肺脾两虚证" } };

await check("1.1 合方：玉屏风散覆盖主诉时，补中益气汤因与本例乏力、气短、自汗、便溏、面色萎黄成组相合而同算覆盖", () => {
  const covered = indications.formulaNamesCoveringCase(deficiencyCase, ["补中益气汤", "玉屏风散"], deficiencyRecord);
  assert.ok(covered.has(indications.normalizedFormulaIdentity("玉屏风散")));
  assert.ok(covered.has(indications.normalizedFormulaIdentity("补中益气汤")));
});

await check("1.2 单方不走组规则：补中益气汤单独开、主治不含本病与主诉时仍不算覆盖", () => {
  const covered = indications.formulaNamesCoveringCase(deficiencyCase, ["补中益气汤"], deficiencyRecord);
  assert.equal(covered.size, 0);
  assert.equal(indications.formulaCoversDiseaseOrComplaint(deficiencyCase, "补中益气汤", deficiencyRecord), false);
});

await check("1.3 同组的其余方须与本例肯定表现共有 ≥2 个概念：表现只剩一项相合时不带进来", () => {
  // 只保留自汗一项与补中益气汤主治相合（乏力、便溏、面色、气短都不写）。
  const thin = "主诉：反复感冒半年余\n现病史：近半年感冒六七次，常自汗出，余无不适。";
  const covered = indications.formulaNamesCoveringCase(deficiencyCase, ["补中益气汤", "玉屏风散"], thin);
  assert.ok(covered.has(indications.normalizedFormulaIdentity("玉屏风散")));
  assert.equal(covered.has(indications.normalizedFormulaIdentity("补中益气汤")), false);
});

await check("1.4 否认的表现不算：便溏、乏力等写成否认时，补中益气汤不随组带进来", () => {
  const denied = "主诉：反复感冒半年余\n现病史：近半年感冒六七次，常自汗出。否认乏力、气短，无便溏，面色红润。";
  const covered = indications.formulaNamesCoveringCase(deficiencyCase, ["补中益气汤", "玉屏风散"], denied);
  assert.equal(covered.has(indications.normalizedFormulaIdentity("补中益气汤")), false);
});

await check("1.5 组里没有一首覆盖本病/主诉时整组都不放行（只有表现重合不够）", () => {
  const record = "主诉：双膝关节肿痛3天\n现病史：伴发热，咽痛，口渴，头痛，舌红苔黄，脉浮数。";
  const reasoning = { overview: { tcmDiseaseName: "痹证", primarySyndrome: "风热痹阻证" } };
  assert.equal(indications.formulaNamesCoveringCase(reasoning, ["银翘散"], record).size, 0);
  assert.equal(indications.formulaNamesCoveringCase(reasoning, ["银翘散", "桑菊饮"], record).size, 0);
});

await check("2.1 终表方义缺省关、开启时预算够写完一段且有上限；开启但药味功效不按原文时整体停用", () => {
  assert.equal(policy.m04FinalContentPolicy({}).analysis, "off");
  assert.equal(policy.m04FinalContentPolicy({ CDSS_M04_FINAL_ANALYSIS: "on" }).analysis, "on");
  const budget = policy.m04FinalContentPolicy({}).analysisBudgetMs;
  assert.ok(budget > 900 && budget <= 4000, String(budget));
  assert.equal(policy.m04FinalContentPolicy({ CDSS_M04_FINAL_ANALYSIS: "on", CDSS_M04_HERB_FUNCTION_SOURCE_ONLY: "false" }).enabled, false);
});

const herb = (id, name, role, text) => ({ id, name, identity: name, formKey: name, role, functionText: text,
  functionSources: [{ id: `s-${id}`, kind: "kb", herbKey: name, text, sourceRef: "kb", sourceDigest: "d" }], targetRef: "", targetPathogenesis: "" });
const snapshot = (name, constructionType, changes) => ({
  fingerprint: "f", candidateKey: "c", name, constructionType,
  herbs: [herb("h1", "桑叶", "君", "疏散风热"), herb("h2", "陈皮", "佐", "理气健脾")],
  delta: { status: "known", bases: [{ key: "b1", name: "桑杏汤", book: "温病条辨", evidenceRef: "" }], changes },
  modifications: [], commentaries: [], priorDigest: "", decoctionDigest: "", recordDigest: "", sourceVersion: "", candidateDigest: "",
  clinicalContext: { primarySyndrome: "", therapy: "", findings: [] },
});

await check("3.1 兜底句开头跟交付方名：方名是成方加减时不写「本方为自拟方」", () => {
  const text = analysis.renderFinalFormulaAnalysis(snapshot("桑杏汤加减", "self_devised", []), []);
  assert.match(text, /^本方为桑杏汤加减。/u);
  assert.doesNotMatch(text, /自拟方/u);
  assert.match(analysis.renderFinalFormulaAnalysis(snapshot("自拟方", "self_devised", []), []), /^本方为自拟方。/u);
});

await check("3.2 兜底句不写药名相同的写法差异，同一原方的加、去合成一句", () => {
  const text = analysis.renderFinalFormulaAnalysis(snapshot("桑杏汤加减", "modified", [
    { id: "1", baseKey: "b1", kind: "preparation_changed", from: "陈皮", to: "陈皮", sourceRef: "" },
    { id: "2", baseKey: "b1", kind: "added", to: "白茅根", sourceRef: "" },
    { id: "3", baseKey: "b1", kind: "added", to: "仙鹤草", sourceRef: "" },
    { id: "4", baseKey: "b1", kind: "removed", from: "梨皮", sourceRef: "" },
  ]), []);
  assert.doesNotMatch(text, /陈皮，本方用陈皮/u);
  assert.equal((text.match(/较《温病条辨》桑杏汤原方/gu) || []).length, 1, text);
  assert.match(text, /加白茅根、仙鹤草，去梨皮/u);
});

const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const BI_PRIOR = {
  stage: "diagnose",
  overview: { tcmDiseaseName: "痹证", primarySyndrome: "瘀血痹阻证", primarySyndromeBasis: ["腰腿刺痛，夜间加重"], secondarySyndromes: [] },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "腰腿刺痛，夜间加重", pathogenesis: "瘀血阻络，经脉不通", therapyDirection: "活血化瘀，通络止痛" }] },
  therapy: { overallMethod: "活血化瘀，通络止痛" },
  westernDiagnosis: { primary: { name: "腰椎间盘突出症待查", supportingFacts: [] } },
};
const BI_CASE = { chiefComplaint: "腰腿疼痛2月", patient: { age: 58, sex: "男" }, symptoms: { 现病史: "腰腿刺痛2月，夜间加重，近一周右小腿麻木。" } };
await check("4.1 加减不加须由医生单独定量的管制/毒性、濒危药材（马钱子、羚羊角）；附子、鸡血藤照常可加", () => {
  assert.equal(compiler.isClinicianDosedRegulatedHerb("马钱子"), true);
  assert.equal(compiler.isClinicianDosedRegulatedHerb("制马钱子"), true);
  assert.equal(compiler.isClinicianDosedRegulatedHerb("羚羊角"), true);
  assert.equal(compiler.isClinicianDosedRegulatedHerb("附子"), false);
  const context = { prior: BI_PRIOR, caseState: BI_CASE, candidateHerbNames: ["桃仁", "红花", "当归", "川芎"], existingTriggers: [] };
  assert.equal(compiler.topUpModificationRow({ trigger: "小腿麻木", herbName: "马钱子", dose: "0.5g", reason: "通络止痛" }, context), undefined);
  const ok = compiler.topUpModificationRow({ trigger: "小腿麻木", herbName: "鸡血藤", dose: "15g", reason: "活血舒筋通络" }, context);
  assert.ok(ok, "对照：鸡血藤应能补");
});
