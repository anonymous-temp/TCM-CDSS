import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() + "/src",
  "server-only": process.cwd() + "/node_modules/next/dist/compiled/server-only/empty.js" } });
const lib = (module) => jiti.import("../src/lib/" + module + ".ts");
const author = await lib("m04-modification-authoring.server");
const fit = await lib("m04-modification-fit.server");
const compiler = await lib("m04-proposal-compiler");
const opening = await lib("formula-original-delivery");
const decoction = await lib("herb-decoction-rules");
const salvage = await lib("m04-salvage");
const functions = await lib("final-consistency-review.server");
const scopes = await lib("herb-function-display-source");
const candidate = { name: "茵陈蒿汤加减", baseFormulas: [{ name: "茵陈蒿汤", source: "《伤寒论》" }],
  herbs: ["茵陈", "栀子", "柴胡"].map((name) => ({ name })), formulaAnalysis: "本方以自拟方。方中茵陈为君。" };
const prior = { overview: { primarySyndrome: "肝经郁热证", tcmDiseaseName: "蛇串疮" } };
const proposed = { trigger: "睡眠差", herbName: "酸枣仁", dose: "10g", reason: "养心安神" };
const sedative = { name: "自拟方", herbs: [...candidate.herbs, { name: "酸枣仁", role: "佐", symptomScope: "secondary", symptomQuote: "痛得睡眠差" }] };
const reasoning = { formula: { candidates: [candidate] } };
const ask = (items) => async (_name, _stage, _messages, _limits, parse) => parse(JSON.stringify({ rows: items }));
const root = "zz-evidence/out";
const read = (file) => JSON.parse(readFileSync(file));
const test = async (name, fn) => {
  try { await fn(); console.log("PASS", name); }
  catch (error) { console.error("FAIL", name, error.message); process.exitCode = 1; }
};
await test("继发表现不能成为专写的新行", () => {
  const plan = author.parseAuthoringPlan(JSON.stringify({ findings: [{ text: "睡眠差", kind: "incidental" }], rows: [proposed] }), 0);
  assert.equal(plan.rows.length, 0);
});
await test("主方按病历原句判断继发，不因证名含郁放行", () => {
  assert.equal(compiler.withoutIncidentalSedatives(sedative, prior, "痛得睡眠差").length, 3);
});
await test("药症核对收到待交付理由", () => {
  assert.equal(fit.modificationFitRowPayload(proposed, 0).reason, proposed.reason);
});
await test("具名方首句与原方差异可重复投影", () => {
  const c = { name: "薏苡仁汤加减", baseFormulas: [{ name: "薏苡仁汤", source: "《类证治裁》" }],
    herbs: ["炒薏苡仁", "苍术", "羌活", "独活", "防风", "桂枝", "麻黄", "当归", "川芎", "白术", "生姜", "甘草"].map((name) => ({ name })), formulaAnalysis: "本方以自拟方。炒薏苡仁为君。" };
  const result = opening.finalFormulaOpening(c);
  assert.equal(result, "本方以薏苡仁汤为基础，去川乌，加白术。炒薏苡仁为君。");
  assert.equal(opening.finalFormulaOpening({ ...c, formulaAnalysis: result }), result);
});
await test("后下按药物分时，两煎共用同一剂", () => {
  const text = decoction.SPECIAL_DECOCTION_ORDER[2].phrase("沉香、木香、大黄");
  assert.match(text, /沉香、木香后下.*约5分钟.*大黄后下.*10～15分钟.*第二煎/);
});
await test("功效文字故障只修功效，整方重新验收", () => {
  const wrap = (r) => "<!-- DIAGNOSIS_JSON_START -->" + JSON.stringify(r) + "<!-- DIAGNOSIS_JSON_END -->";
  const c = { herbs: [{ name: "龙胆", function: "错误", dose: "5g", role: "君", targetPathogenesis: "肝胆湿热" }] };
  const result = salvage.salvageM04Content(wrap({formula:{candidates:[c]}}), { prior: {}, clinicalContext: "",
    issueOf: (content) => content.includes("错误") ? "finalized_prescription_candidate_0_herb_0_function_ungrounded" : undefined });
  assert.ok(result?.steps[0]?.action === "repair_function" && result.content.includes('"5g"'));
});
await test("逐味闭集选择，越界、缺答与重复答复留给原投影", async () => {
  const refs = scopes.herbFunctionSourceClauses("柴胡");
  const index = refs.findIndex((row) => row.text.includes("疏肝"));
  assert.ok(index >= 0);
  const chosen = await functions.selectFinalHerbFunctions(reasoning, {}, undefined, ask([{ name: "柴胡", indices: [index] }, { name: "栀子", indices: [999] }]));
  assert.deepEqual([...chosen], [["柴胡", refs[index].text]]);
  const signed = { ...reasoning, contractSignature: "fixture", clinicalReview: { reviewedPayloadHash: "fixture" },
    formula: { candidates: [{ ...candidate, herbs: [{ name: "柴胡", function: chosen.get("柴胡") }] }] } };
  assert.equal(scopes.projectGroundedHerbFunctions(signed).formula.candidates[0].herbs[0].function, refs[index].text);
  const unavailable = await functions.selectFinalHerbFunctions(reasoning, {}, undefined, async () => { throw Error("timeout"); });
  assert.equal(unavailable.size, 0);
});
await test("唯一禁用君药在原修复轮明确点名", () => {
  const hint = salvage.uniqueEmperorRepairHint([{ name: "骨碎补", role: "君" }], "m04_candidate_0_herb_0_special_population_high_risk_antithrombotic_therapy");
  assert.match(hint, /骨碎补.*抗凝.*接任/u);
  assert.equal(salvage.uniqueEmperorRepairHint([{name:"骨碎补",role:"佐"}], "candidate_0_herb_0_special_population_high_risk_antithrombotic_therapy"), undefined);
});
await test("核对过的药症理由使用药物条目编号", () => {
  const payload = author.verifyRowPayload({ herbName: "五味子", reason: "益气固表" });
  assert.ok(payload.functions.some((clause) => clause.includes("收敛")) && !payload.functions.includes("益气固表"));
});
await test("内部写作要求不进入加减理由", () => {
  assert.doesNotMatch(author.AUTHOR_SYSTEM, /补强治法第一项|reason 写明补强治法的哪一项/u);
});
await test("连续性交付仅恢复能复现并完成全量复核的问题", () => {
  const issue = "candidate_0_herb_0_function_ungrounded";
  const content = '<!-- DIAGNOSIS_JSON_START -->'+JSON.stringify({formula:{candidates:[{herbs:[{name:"龙胆",role:"君",function:"错误",dose:"5g"}]}]}})+'<!-- DIAGNOSIS_JSON_END -->';
  const inspect = (value) => ({ content: value, contractIssues: value.includes("错误") ? [issue] : [] });
  const ctx = { prior:{}, clinicalContext:"" };
  const original = inspect(content);
  const clean = salvage.repairRetainedM04(original, ctx, inspect, (value) => value);
  assert.ok(clean && !clean.contractIssues.length);
  assert.equal(salvage.repairRetainedM04(original, ctx, inspect, () => { throw Error("route rejected"); }), undefined);
  assert.equal(salvage.repairRetainedM04({...original,contractIssues:[issue,"unreviewed"]}, ctx, inspect, (v)=>v), undefined);
});
if (process.argv.includes("--replay")) {
  let files = 0, candidates = 0, edits = 0, linear = 0, noDose = 0, timing = 0, ambiguous = 0;
  for (const folder of readdirSync(root)) for (const file of readdirSync(root + "/" + folder).filter((x) => x.endsWith(".json"))) {
    files++;
    const result = read(root + "/" + folder + "/" + file)?.prescribe;
    if (result?.content?.includes("<!-- CDSS_NON_DOSE_PRESCRIPTION -->")) noDose++;
    for (const c of result?.structured?.formula?.candidates || []) {
      candidates++;
      const next = opening.finalFormulaOpening(c, result.structured.formula.modifications);
      if (next !== c.formulaAnalysis) { edits++; console.log("方义", folder + "/" + file, next.split("。")[0]); }
      if (opening.finalFormulaOpening({...c, formulaAnalysis:next}) !== next) linear++;
      const late = c.herbs.filter((h) => decoction.specialDecoctionOrderIndexes(h.name,h.decoctionRequirement || "").includes(2));
      if (late.length) { timing++; const text = decoction.SPECIAL_DECOCTION_ORDER[2].phrase(late.map(h=>h.name).join("、")); console.log("后下", folder+"/"+file, text); }
      ambiguous += c.herbs.filter((h) => scopes.herbFunctionSourceClauses(h.name).length > 1).length;
    }
  }
  let fixtureChanges = 0;
  for (const [caseName, labels] of [
    ["eval/病历8", {车前子:"清热利尿通淋", 柴胡:"疏肝解郁"}],
    ["eval/e1026-08", {车前子:"清热利尿通淋", 柴胡:"疏肝解郁"}],
    ["fresh/f12", {沉香:"行气止痛"}],
  ]) {
    const prescription = read(root + "/" + caseName + ".r1.json").prescribe.structured;
    const choices = Object.entries(labels).map(([name, expected]) => ({
      name, indices: [scopes.herbFunctionSourceClauses(name).findIndex((clause) => clause.text === expected)],
    }));
    const selected = await functions.selectFinalHerbFunctions(prescription, {}, undefined, ask(choices));
    for (const herb of prescription.formula.candidates[0].herbs) {
      const choice = selected.get(herb.name);
      if (choice && choice !== herb.function) {
        fixtureChanges++;
        console.log("闭集桩", caseName, herb.name, herb.function, "→", choice);
      }
    }
  }
  console.log({files,candidates,edits,nonIdempotent:linear,noDose,lateDecoctionCandidates:timing,multipleFunctionOptions:ambiguous,fixtureChanges});
}
