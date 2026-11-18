// 合成病历与注入判据。所有检查在本机运行。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";
// Never read provider settings or contact an endpoint. F07 replaces fetch before generation.
Object.assign(process.env, { AI_TEXT_PROVIDER: "bailian-qwen", BAILIAN_QWEN_API_KEY: "synthetic-only",
  BAILIAN_QWEN_MODEL: "qwen3.7-plus", PRIMARY_DIAGNOSE_MODEL: "qwen3.8-flash", CONTROLLED_TERMINOLOGY_NORMALIZATION: "false",
  REASONING_CONTRACT_SIGNING_KEY: "synthetic-closure-signing-material-for-tests" });
globalThis.fetch = async () => { throw new Error("远程请求不属于离线测试"); };
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const a = await jiti.import("../src/lib/m03-element-assertions.ts");
const v = await jiti.import("../src/lib/m03-element-closure-v2.server.ts");
const s = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
const p = await jiti.import("../src/lib/delivered-surface.ts");
const c = await jiti.import("../src/lib/pathogenesis-columns.ts");
const old = await jiti.import("../src/lib/m03-syndrome-element-closure.server.ts");
const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const alignment = await jiti.import("../src/lib/m03-analysis-alignment.server.ts");
const cache = await jiti.import("../src/lib/stage-result-coalescing.server.ts");
const gov = await jiti.import("../src/lib/clinical-governance-tables.ts");
const therapyWriter = await jiti.import("../src/lib/analysis-element-closure.ts");
const tx = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");

let checks = 0, failures = 0;
const check = async (id, description, work) => {
  if (process.env.R1067_ONLY && process.env.R1067_ONLY !== id) return;
  checks++;
  try { await work(); console.log(`✓ ${id} ${description}`); }
  catch (error) { failures++; console.error(`✗ ${id} ${description}\n${error.stack}`); }
};
const policy = (...disabled) => ({ mode: "enforce", disabled: new Set(disabled) });
const context = (recordText = "主诉：活动后疲倦。\n现病史：活动后疲倦，食量稍减。\n舌象：舌淡。\n脉象：脉细。") => ({ recordText });
const wire = root => `<!-- DIAGNOSIS_JSON_START -->${JSON.stringify(root)}<!-- DIAGNOSIS_JSON_END -->`;
const entries = values => new Map(Object.entries(values).map(([name, pairs]) => [name, pairs.map(([item, quote]) => ({ item, quote }))]));
const allEntries = JSON.parse(fs.readFileSync(new URL("../src/data/tcm-diagnostics-syndrome-criteria.json", import.meta.url), "utf8")).entries.map(entry => entry.name);
const evidence = (root, matches, requested = [...matches.keys()]) => {
  const current = a.m03ElementContext(root);
  const row = a.selectedElementRow(current);
  return { context: { ...current, ...(row ? { textbookRow: { id: row.id } } : {}) }, matches, requested: new Set(requested) };
};
const make = (disease = "不寐", name = "心血虚证", mechanism = "心血亏虚，心神失养", method = "养血安神") => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: disease, primarySyndrome: name, primarySyndromeResolution: "resolved", secondarySyndromes: [],
    primarySyndromeBasis: ["活动后疲倦", "舌淡", "脉细"], tcmDiagnosticRationale: `活动后疲倦，舌淡脉细，${mechanism}，证属${name}。`,
    tcmDiseaseRationale: "本次主症结合病程辨病。", overallPathogenesis: `${mechanism}。`, overallTherapy: method },
  pathogenesis: { summary: `${mechanism}。`,
    natureDifferentiation: { items: [], rootDeficiency: [], branchExcess: [], basis: "活动后疲倦；舌淡" },
    locationDifferentiation: { items: ["心"], details: [{ location: "心", basis: "活动后疲倦" }] },
    chain: [{ nodeId: "P1", patientFact: "活动后疲倦", pathogenesis: mechanism, therapyDirection: method }],
    symptomClusters: [{ symptoms: ["活动后疲倦"], mechanism }], uncertainties: [] },
  therapy: { overallMethod: method, subTherapies: [{ therapy: method, targetPathogenesis: mechanism }] },
});
const append = (root, mechanism, method = "条畅气机") => {
  root.overview.overallPathogenesis += `${mechanism}。`;
  root.pathogenesis.summary += `${mechanism}。`;
  root.pathogenesis.chain.push({ nodeId: `P${root.pathogenesis.chain.length + 1}`, patientFact: "食量稍减", pathogenesis: mechanism, therapyDirection: method });
  root.pathogenesis.symptomClusters.push({ symptoms: ["食量稍减"], mechanism });
  return root;
};
const names = root => [root.overview.tcmDiseaseName, root.overview.primarySyndrome, ...root.overview.secondarySyndromes];
const out = (root, ctx = context(), snap, rules = policy(), evaluate) => v.solveM03ElementClosure(root, ctx, rules, snap, true, evaluate);
const verdict = (entry, status, supplied = {}) => ({ verdict: status, entry: entry.name, strict: status === "pass",
  specific: 2, category: 1, listed: 0, distinct: 3, ...supplied });
const forced = (root, ctx, mode, rules = policy()) => out(root, ctx,
  evidence(root, mode === "failed" ? new Map() : new Map(allEntries.map(name => [name, []])), allEntries), rules,
  (entry, matches, recordText, primaryTerms, d6, narrow) =>
    verdict(entry, mode, { evidenceDomains: v.evaluateClosureCriteria(entry, matches, recordText, primaryTerms, d6, narrow).evidenceDomains, quotes: [] }));
const find = (value, source = "mechanism", rules = policy()) => a.elementAssertionsInText(value, source, rules);
const keys = hits => [...new Set(hits.map(a.pairKey))].sort();

await check("L01", "D1 词表与两套名称分别核对", () => {
  assert.deepEqual(v.closureCriteriaLookup({ type: "fluid-loss" }), { entries: ["津液亏虚证"], name: "津液亏虚证" });
  assert.deepEqual(keys(find("阴津不足，津液亏耗")), ["fluid-loss/"]);
  assert.deepEqual(v.closureCriteriaLookup({ type: "wind" }, "风热"), { entries: ["风淫证", "热证"], name: "风热证" });
  assert.equal(gov.resolveNationalStandardTcmSyndromeTerm("风淫证"), undefined);
  assert.deepEqual(v.closureCriteriaLookup({ type: "toxin" }, "热毒"), { entries: [], name: "火毒证" });
  assert.deepEqual(keys(find("湿热化毒；痰湿内阻；阳脱")), ["collapse/", "damp/", "heat/", "phlegm/", "toxin/"]);
});
await check("L02", "D1 三岔口拒绝只有国标名、缺判据的毒和合成半项", () => {
  const root = append(make(), "热毒蕴结；痰湿内阻");
  const run = forced(root, context(), "pass");
  assert.equal(run.ledger.find(row => row.pair.type === "toxin").disposition, "withdrawn");
  assert.ok(!names(run.root).some(name => name.includes("毒")));
  assert.ok(!run.possible.includes("火毒证"));
  assert.ok(!keys(find("湿热化毒", "mechanism", policy("d1"))).includes("toxin/"));
});
await check("L03", "D3 肾气不固和心脾两虚按方向分解", () => {
  assert.deepEqual(keys(a.deliveryNamePairs("肾气不固证")), ["deficiency/肾", "insecurity/肾", "气虚/肾"]);
  assert.deepEqual(keys(a.deliveryNamePairs("心脾两虚证")), ["deficiency/心", "deficiency/脾", "气虚/脾", "血虚/心"]);
  const precise = a.findUnsupportedM03ElementAssertions({ disease: "", primarySyndrome: "肾气不固证", secondarySyndromes: [] }, "肾阳不振，肾气不足。");
  assert.deepEqual(keys(precise), ["阳虚/肾"]);
  const root = append(make("早泄", "肾气不固证", "肾气不固，封藏失职", "调理下元"), "肾阳虚");
  const result = out(root, context(), undefined, policy("d3"));
  assert.equal(result.guard, undefined, JSON.stringify(result.root.therapy));
  assert.equal(result.ledger.find(row => row.pair.type === "阳虚").disposition, "named");
});
await check("L04", "D3 虚寒虚热只在同一脏腑解释，未定位不能覆盖指定脏", () => {
  const context = { disease: "", primarySyndrome: "肾阳虚证", secondarySyndromes: ["阴虚证"] };
  assert.deepEqual(keys(a.findUnsupportedM03ElementAssertions(context, "肾虚寒，脾虚寒；胃虚热，肝火炽盛。")), ["deficient-cold/脾", "deficient-heat/胃", "heat/肝"]);
  assert.ok(a.deliveryPairCovered({ type: "气虚", organ: "肾" }, a.deliveryNamePairs("肾阳虚证")));
  assert.equal(a.deliveryPairCovered({ type: "气虚", organ: "胃" }, a.deliveryNamePairs("脾气虚证")), false);
});
await check("L05", "D5 病位和连续谓词分开登记", () => {
  assert.deepEqual(keys(find("病位在胃", "location")), []);
  assert.deepEqual(keys(find("胃热消谷，热扰心神", "location")), ["heat/心", "heat/胃"]);
  assert.deepEqual(keys(find("胃热消谷，热扰心神", "mechanism", policy("d5"))), ["heat/"]);
  assert.deepEqual(keys(find("脾虚失运，痰湿内生")), ["damp/", "phlegm/", "气虚/脾"]);
});
await check("L06", "D2 标准 8 解毒只由蛇串疮本行许可", () => {
  const root = append(make("蛇串疮", "肝经郁热证", "肝经郁热灼肤", "清泄肝火，解毒止痛"), "热毒蕴结，湿邪伤津", "清热解毒");
  root.pathogenesis.natureDifferentiation.items = ["热", "毒", "湿", "津亏"];
  const solved = forced(root, context(), "failed");
  assert.equal(solved.ledger.find(row => row.pair.type === "toxin").rowId, "waike|蛇串疮|肝经郁热证");
  assert.equal(solved.ledger.find(row => row.pair.type === "damp").disposition, "withdrawn_task_failed");
  assert.ok(solved.root.pathogenesis.natureDifferentiation.items.includes("毒"));
  const swapped = structuredClone(root);
  swapped.overview.tcmDiseaseName = "牙痛";
  assert.ok(!out(swapped).root.pathogenesis.natureDifferentiation.items.includes("毒"));
  assert.ok(!out(root, context(), undefined, policy("d2")).root.pathogenesis.natureDifferentiation.items.includes("毒"));
  const mismatched = { ...a.m03ElementContext(root), textbookRow: { id: "wrong-row" } };
  assert.deepEqual(keys(a.findUnsupportedM03ElementAssertions(mismatched, "本例毒邪灼肤。")), ["toxin/"]);
});
await check("L07", "D2 标准 10 原行支持伤津和冲任受热，不授权肝火和血瘀", () => {
  const root = make("月经先期", "阳盛血热证", "热扰冲任，热甚伤津", "清热凉血调经");
  const row = a.selectedElementRow(a.m03ElementContext(root));
  assert.ok(tx.textbookRowElementAnalysis(row).line > 0);
  assert.deepEqual(keys(a.findUnsupportedM03ElementAssertions(a.m03ElementContext(root), "热扰冲任，热甚伤津；肝火偏盛，血瘀阻络。")), ["heat/肝", "stasis/"]);
});
await check("L08", "D4 连续谓词、范围、引文与起止位置", () => {
  const root = make("阳痿", "肝气郁结证", "肝失疏泄、气机郁滞", "疏肝解郁");
  const prose = "旧病曾见阳虚。学派认为湿热常由痰湿郁久；无阳虚、湿邪。本例气机郁滞，郁久化热、热扰心神。病历记“疑痰湿，需核实”";
  const issues = a.findUnsupportedM03ElementAssertions(a.m03ElementContext(root), prose);
  assert.deepEqual(keys(issues), ["heat/", "heat/心"]);
  for (const issue of issues) assert.equal(prose.slice(issue.start, issue.end), issue.phrase);
  assert.deepEqual(find("郁久化热，热扰心神", "prose", policy("d4")), []);
});
await check("L09", "C004 空栏与治法回填沿用同一许可", () => {
  const root = append(make("咳嗽", "痰湿蕴肺证", "痰湿蕴肺，肺失宣降", "燥湿化痰，宣肺止咳"), "脾阳不运为阳虚", "温阳健脾");
  root.overview.tcmDiagnosticRationale += "舌淡，脉沉细，为阳虚。";
  root.overview.primarySyndromeBasis = ["舌淡", "畏寒肢冷"];
  root.pathogenesis.natureDifferentiation = { items: ["痰湿", "阳虚"], rootDeficiency: ["阳虚"], branchExcess: ["痰湿"], basis: "畏寒肢冷" };
  root.pathogenesis.uncertainties = [{ item: "是否兼阳虚", reason: "畏寒肢冷", affects: "温阳" }];
  const ctx = context("现病史：咳嗽，畏寒肢冷。\n舌象：舌淡。\n脉象：脉沉细。");
  const runtime = v.createM03ElementClosure(ctx, policy());
  const solved = runtime.settle(root, true).root;
  const copy = structuredClone(solved);
  copy.overview.tcmDiagnosticRationale += "阳虚失于温煦。";
  c.reconcileEmptyNatureAssertions(copy, ctx.recordText, label => runtime.allowsWriter(copy, label, "nature"));
  assert.ok(!copy.pathogenesis.natureDifferentiation.items.includes("阳虚"));
  assert.deepEqual(solved.pathogenesis.uncertainties, []);
  const projected = p.projectDeliveredReasoning(solved, { recordText: ctx.recordText, m03ElementAllows: runtime.allowsWriter });
  assert.deepEqual(runtime.inspect(projected), []);
});
await check("L10", "n16 化热连谓词及病位详情、总法镜像、症状簇成组撤净", () => {
  const root = append(make("阳痿", "肝气郁结证", "肝失疏泄，气机郁滞", "疏肝解郁"), "郁久化热、热扰心神", "清热泻火");
  root.pathogenesis.locationDifferentiation.items = ["宗筋", "胃热"];
  root.pathogenesis.locationDifferentiation.details = [{ location: "宗筋", basis: "临房不举" }, { location: "胃", basis: "胃热消谷" }];
  root.therapy.overallMethod += "，清热泻火";
  root.overview.overallTherapy = root.therapy.overallMethod;
  root.therapy.subTherapies.push({ therapy: "清胃泻火", targetPathogenesis: "胃热消谷" });
  root.pathogenesis.chain.push({ nodeId: "P3", patientFact: "胸胁发胀", pathogenesis: "肝气郁滞", therapyDirection: "疏肝解郁" });
  const solved = forced(root, context(), "fail").root;
  assert.deepEqual(a.checkM03ElementClosure(solved), []);
  assert.deepEqual(solved.pathogenesis.locationDifferentiation.items, ["宗筋"]);
  assert.deepEqual(solved.pathogenesis.locationDifferentiation.details.map(item => item.location), ["宗筋"]);
  assert.equal(solved.therapy.overallMethod, "疏肝解郁");
  assert.equal(solved.overview.overallTherapy, solved.therapy.overallMethod);
  assert.deepEqual(solved.pathogenesis.chain.map(item => item.nodeId), ["P1", "P2"]);
  assert.equal(solved.pathogenesis.symptomClusters.length, 1);
  assert.equal(solved.therapy.subTherapies.length, 1);
});
await check("L11", "n02 津亏不借胃阴诊断全身气阴两伤", () => {
  const root = append(make("呕吐", "胃阴亏虚证", "胃阴不足，胃气上逆", "和胃降逆"), "津液亏耗，气阴两虚", "滋阴生津");
  root.pathogenesis.natureDifferentiation.items = ["阴虚", "津液亏耗"];
  const solved = forced(root, context(), "fail");
  assert.deepEqual(names(solved.root), names(root));
  const fluid = solved.ledger.find(row => row.pair.type === "fluid-loss");
  assert.equal(fluid.disposition, "withdrawn");
  assert.ok(fluid.fields.includes("/overview/overallPathogenesis"));
  assert.deepEqual(a.checkM03ElementClosure(solved.root), []);
  assert.equal(solved.root.pathogenesis.chain[0].pathogenesis, "胃阴不足，胃气上逆");
});
await check("L12", "C058 湿和毒各自撤回，牙痛主证和安全建议保持", () => {
  const root = append(make("牙痛", "胃火上炎证", "胃火上炎，循经犯齿", "清胃泻火"), "湿热化毒", "利湿解毒");
  root.pathogenesis.natureDifferentiation.items = ["热", "湿", "毒"];
  root.management = { redFlagLoop: "如出现呼吸困难立即就医。" };
  const solved = forced(root, context(), "failed").root;
  assert.deepEqual(solved.pathogenesis.natureDifferentiation.items, ["热"]);
  assert.deepEqual(names(solved), names(root));
  assert.deepEqual(solved.management, root.management);
});
await check("L13", "D6 共有表现和单域不能支持严格晋升", () => {
  const entry = s.diagnosticsCriteriaFor("脾气虚证");
  const record = "现病史：纳少，腹胀，便溏。";
  const matches = ["纳少", "腹胀", "便溏"].map(item => ({ item, quote: item }));
  assert.equal(v.evaluateClosureCriteria(entry, matches, record, ["纳少", "腹胀", "便溏"], true).strict, false);
  const tongue = s.diagnosticsCriteriaFor("血虚证");
  const examples = [
    { item: tongue.specific[0], quote: "面色淡白" },
    { item: tongue.specific[1], quote: "唇色淡白" },
  ];
  assert.notEqual(v.evaluateClosureCriteria(tongue, examples, "舌象：面色淡白，唇色淡白。", [], true).strict, true);
});
await check("L14", "h12 针刺固定痛与暗舌各独立一域，去暗舌或只有方药不晋升", () => {
  const root = append(make("悬饮", "络气不和证", "络气不和，胸胁牵扯", "理气和络"), "瘀阻络脉", "活血化瘀");
  const matches = entries({ 血瘀证: [["疼痛", "痛处固定"], ["其疼痛特点为痛如针刺", "如针刺"], ["舌色青紫等", "舌暗"]] });
  const positive = context("现病史：左胸胁痛处固定，间歇如针刺。\n舌象：舌暗。\n脉象：脉弦。");
  const snapshot = evidence(root, matches);
  assert.deepEqual(out(root, positive, snapshot).root.overview.secondarySyndromes, ["血瘀证"]);
  assert.deepEqual(out(root, context("现病史：左胸胁痛处固定，间歇如针刺。\n舌象：舌红。"), snapshot).root.overview.secondarySyndromes, []);
  assert.deepEqual(out(root, context("现病史：左胸胁胀闷。\n用药史：丹参。"), snapshot).root.overview.secondarySyndromes, []);
  const entry = s.diagnosticsCriteriaFor("血瘀证");
  const shared = ["痛处固定", "如针刺"];
  const proof = ["痛处固定", "如针刺", "舌暗"];
  assert.equal(v.evaluateClosureCriteria(entry, matches.get(entry.name), positive.recordText, shared, true, proof).strict, true);
  assert.equal(v.evaluateClosureCriteria(entry, matches.get(entry.name), positive.recordText, shared, false, proof).strict, false);
});
await check("L15", "h12 同案引文与主次病机重复才吸收气滞", () => {
  const root = make("悬饮", "络气不和证", "络气不和，气机郁滞", "理气和络");
  root.overview.primarySyndromeBasis = ["胸胁胀闷", "脉弦"];
  root.overview.tcmDiagnosticRationale = "胸胁胀闷，脉弦，为气机郁滞，络气不和。";
  root.overview.secondarySyndromes = ["气滞证"];
  const ctx = context("现病史：胸胁胀闷。\n脉象：脉弦。");
  const snap = evidence(root, entries({ 气滞证: [["胀闷", "胸胁胀闷"], ["脉弦", "脉弦"]] }));
  assert.deepEqual(out(root, ctx, snap).root.overview.secondarySyndromes, []);
  assert.deepEqual(out(root, ctx, snap, policy("d7")).root.overview.secondarySyndromes, ["气滞证"]);
  const withoutCommon = { ...root, overview: { ...root.overview, primarySyndromeBasis: ["按压有痛"] } };
  assert.deepEqual(out(withoutCommon, ctx, snap).root.overview.secondarySyndromes, ["气滞证"]);
  assert.notEqual(gov.resolveNationalStandardTcmSyndromeTerm("络气不和证")?.id, gov.resolveNationalStandardTcmSyndromeTerm("气滞证")?.id);
});
await check("L16", "h32 局部冷、全身畏寒、宿疾按主体分开", () => {
  const root = append(make("冻疮", "寒凝血瘀证", "寒凝经络，瘀阻指端", "温经散寒"), "阳虚寒盛", "温阳散寒");
  root.pathogenesis.natureDifferentiation.items = ["寒", "血瘀", "阳虚"];
  const matches = entries({ 阳虚证: [["畏寒肢冷", "平素畏寒"], ["小便清长", "小便清长"], ["脉沉迟无力", "脉沉迟无力"], ["神疲乏力", "神疲乏力"], ["少气懒言", "少气懒言"], ["脉虚", "脉沉迟无力"]] });
  const current = "现病史：平素畏寒，小便清长，神疲乏力，少气懒言。\n舌象：舌淡。\n脉象：脉沉迟无力。";
  const snap = evidence(root, matches);
  assert.deepEqual(out(root, context(current), snap).root.overview.secondarySyndromes, ["阳虚证"]);
  assert.deepEqual(out(root, context("现病史：指尖遇冷疼痛，皮色暗。\n既往史：平素畏寒，小便清长，神疲乏力，少气懒言。\n脉象：脉沉迟无力。"), snap).root.overview.secondarySyndromes, []);
  assert.deepEqual(out(root, context("现病史：手指遇冷麻木。\n舌象：舌淡。\n脉象：脉沉迟无力。"), snap).root.overview.secondarySyndromes, []);
});
await check("L17", "m17 守住肾气不固，阳虚条件允许通用名而不强换", () => {
  const root = append(make("早泄", "肾气不固证", "肾气不固，精关失摄", "固精止泄"), "肾阳不振", "温肾固精");
  root.pathogenesis.natureDifferentiation.items = ["气虚", "肾阳虚"];
  const ctx = context("现病史：精关失摄，平素畏寒，小便清长，神疲乏力，少气懒言。\n脉象：脉沉迟无力。");
  const snap = evidence(root, entries({ 阳虚证: [["畏寒肢冷", "平素畏寒"], ["小便清长", "小便清长"], ["脉沉迟无力", "脉沉迟无力"], ["神疲乏力", "神疲乏力"], ["少气懒言", "少气懒言"], ["脉虚", "脉沉迟无力"]] }));
  const solved = out(root, ctx, snap);
  assert.deepEqual(names(solved.root), ["早泄", "肾气不固证", "阳虚证"]);
  assert.equal(solved.ledger.find(row => row.pair.organ === "肾" && row.pair.type === "阳虚").disposition, "withdrawn");
});
await check("L18", "一次判据任务去重，任务失败从各栏撤并计数", async () => {
  const root = append(make(), "脾阳不运，阳虚", "温阳助阳");
  root.pathogenesis.natureDifferentiation.items = ["阳虚"];
  let calls = 0;
  let requested = [];
  const ctx = context("现病史：胸闷乏力，畏寒。\n脉象：脉弱。");
  const tested = await v.collectM03ClosureEvidence(JSON.stringify(root), ctx, policy(), undefined, {
    request: async targets => {
      calls++;
      requested = targets.map(entry => entry.name);
      throw new Error("合成超时");
    },
    reconcile: async (content, context, signal, verify) => {
      await Promise.all([verify("阳虚证", { ...context, primaryTerms: [] }, signal), verify("阳虚证", { ...context, primaryTerms: [] }, signal)]);
      return content;
    },
  });
  const solved = out(root, ctx, tested.evidence);
  assert.equal(calls, 1);
  assert.equal(new Set(requested).size, requested.length);
  assert.ok(requested.includes("阳虚证"));
  assert.ok(requested.includes("脾阳虚证"));
  assert.ok(solved.taskFailed > 0);
  assert.ok(solved.ledger.some(row => row.disposition === "withdrawn_task_failed"));
  assert.deepEqual(a.checkM03ElementClosure(solved.root), []);
});
await check("L19", "只见治法或裸部位时不新起判据任务", async () => {
  const root = make();
  root.pathogenesis.locationDifferentiation.items = ["胃", "宗筋"];
  root.therapy.overallMethod += "，祛风通络";
  root.pathogenesis.summary += "清阳下陷。";
  let calls = 0;
  const result = await v.collectM03ClosureEvidence(JSON.stringify(root), context(), policy(), undefined, {
    reconcile: async content => content,
    request: async () => { calls++; return new Map(); },
  });
  assert.equal(calls, 0);
  const solved = out(root, context(), result.evidence);
  assert.deepEqual(solved.root.pathogenesis.locationDifferentiation.items, ["胃", "宗筋"]);
  assert.equal(solved.taskFailed, 0);
});
await check("L20", "已有独立兼证占满时不能挤掉它们，寒热对立只能撤", () => {
  const root = append(make("冻疮", "寒凝血瘀证", "寒凝血瘀", "温经散寒"), "实热内盛", "清热泻火");
  root.pathogenesis.natureDifferentiation.items = ["寒", "血瘀", "热"];
  const snap = evidence(root, entries({ 热证: [["发热", "发热"], ["口渴欲饮", "口渴欲饮"], ["脉数", "脉数"]] }));
  const ctx = context("现病史：发热，口渴欲饮。\n脉象：脉数。");
  const strict = e => verdict(e, "pass", { evidenceDomains: 2, quotes: ["发热", "脉数"] });
  assert.deepEqual(names(out(root, ctx, snap, policy(), strict).root), names(root));
  const full = append(make(), "实热内盛", "清热泻火");
  full.overview.secondarySyndromes = ["痰湿证", "气逆证", "营卫不和证", "气陷证", "脾气虚证", "血瘀证"];
  assert.deepEqual(names(out(full, ctx, { ...snap, context: a.m03ElementContext(full) }, policy(), strict).root), names(full));
});
await check("L21", "好证素进国标合称后重分解，旧教材行和方名保留", () => {
  const root = append(make("经行风疹块", "血虚证", "血虚失养", "养血祛风"), "气虚不运", "益气补气");
  root.overview.recommendedFormulaNames = ["当归饮子"];
  const ctx = context("现病史：神疲乏力，少气懒言，稍动更甚。\n舌象：舌质淡嫩。");
  const snap = evidence(root, entries({ 气虚证: [["神疲乏力", "神疲乏力"], ["少气懒言", "少气懒言"], ["动则诸症加剧", "稍动更甚"], ["舌质淡嫩", "舌质淡嫩"]] }));
  const solved = out(root, ctx, snap);
  assert.equal(solved.root.overview.primarySyndrome, "气血两虚证");
  assert.deepEqual(solved.root.overview.recommendedFormulaNames, root.overview.recommendedFormulaNames);
  assert.equal(a.selectedElementRow(a.m03ElementContext(solved.root)).id, a.selectedElementRow(a.m03ElementContext(root)).id);
  assert.ok(solved.ledger.some(row => row.disposition === "promoted:气血两虚证"));
  assert.deepEqual(a.checkM03ElementClosure(solved.root), []);
});
await check("L22", "撤回依据沿用原切口，提取的表现不接到句尾", () => {
  const root = make("便秘", "血虚证", "血虚失养", "养血润肠");
  root.overview.tcmDiagnosticRationale = "肢体酸麻为血虚。少气懒言、周身乏力为气虚。故属血虚证。";
  root.pathogenesis.natureDifferentiation.items = ["血虚", "气虚"];
  root.pathogenesis.natureDifferentiation.basis = "少气懒言；周身乏力";
  const raw = JSON.stringify(root);
  const legacy = old.applyElementSupportDecision(raw, { elements: [{ unit: old.syndromeElementLedger(root).find(unit => unit.type === "气虚"), verdict: verdict({ name: "气虚证" }, "fail") }], context: context(), protectedByPrimary: false });
  assert.match(JSON.parse(legacy).overview.tcmDiagnosticRationale, /周身乏力/);
  const solved = out(root).root;
  assert.doesNotMatch(solved.overview.tcmDiagnosticRationale, /气虚|周身乏力/);
  assert.match(solved.pathogenesis.natureDifferentiation.basis, /周身乏力/);
});
await check("L23", "链可恢复已核实版本，恢复亡失病机则拒绝", () => {
  const root = make();
  const accepted = structuredClone(root);
  accepted.pathogenesis.chain[0].pathogenesis = "脾阳不运";
  root.pathogenesis.chain = [];
  const runtime = v.createM03ElementClosure(context(), policy());
  const allows = draft => !runtime.inspect(draft).some(hit => hit.field.startsWith("/pathogenesis/chain"));
  assert.equal(summary.restoreValidatedM03Chain(wire(root), wire(accepted), allows), wire(root));
  accepted.pathogenesis.chain[0].pathogenesis = "心血亏虚";
  assert.notEqual(summary.restoreValidatedM03Chain(wire(root), wire(accepted), allows), wire(root));
});
await check("L24", "后续流派与治法合入按授权读同一决定", () => {
  const root = make("蛇串疮", "肝经郁热证", "肝经郁热灼肤", "疏通经络");
  const runtime = v.createM03ElementClosure(context(), policy());
  const lens = structuredClone(root);
  lens.overview.tcmDiagnosticRationale += "扶阳学派从阳气看本例。本例脾阳不运。";
  assert.equal(runtime.mergeContribution(JSON.stringify(root), JSON.stringify(lens), true), JSON.stringify(root));
  const proposed = structuredClone(root);
  proposed.therapy.overallMethod += "，利湿排毒";
  assert.equal(runtime.mergeContribution(JSON.stringify(root), JSON.stringify(proposed), false), JSON.stringify(root));
  proposed.therapy.overallMethod = "解毒止痛";
  assert.equal(runtime.mergeContribution(JSON.stringify(root), JSON.stringify(proposed), false), JSON.stringify(proposed));
});
await check("L25", "对齐不能把原病性数组用作新稿许可", () => {
  const root = make("产后身痛", "血虚证", "血虚失养", "养血通络");
  root.pathogenesis.natureDifferentiation.items = ["血虚", "阳虚"];
  const runtime = v.createM03ElementClosure(context(), policy());
  const rejection = {};
  const rewrite = {
    rationale: "活动后疲倦，舌淡脉细提示血虚不能濡养筋脉，故本次肢体不适系血失濡养所致，证属血虚证。",
    natureItems: ["血虚", "阳虚"], rootDeficiency: ["血虚", "阳虚"], branchExcess: [],
    natureBasis: "活动后疲倦；舌淡", overallPathogenesis: "血虚失养", uncertainties: [],
  };
  assert.equal(alignment.acceptedAlignmentRewrite(root, rewrite, context().recordText, rejection, runtime), undefined);
  assert.equal(rejection.reason, "nature_outside_conclusion");
});
await check("L26", "闭合会撤空整链时，保留进入闭合时的整稿并标记护栏", () => {
  const root = make("不寐", "心血虚证", "脾阳不运", "温阳健脾");
  const solved = out(root);
  assert.equal(solved.guard, "pathogenesis/chain");
  assert.deepEqual(solved.root, root);
});
await check("L27", "缓存指纹随闭合版本和单项开关而变，终验位置在签名前", () => {
  const before = process.env.CDSS_M03_ELEMENT_CLOSURE_V2;
  const disabled = process.env.CDSS_M03_ELEMENT_CLOSURE_V2_DISABLE;
  try {
    delete process.env.CDSS_M03_ELEMENT_CLOSURE_V2;
    delete process.env.CDSS_M03_ELEMENT_CLOSURE_V2_DISABLE;
    assert.equal(a.elementClosurePolicy().mode, "enforce");
    const key = () => cache.stageRequestFingerprint("diagnose", {}, {});
    const enforced = key();
    process.env.CDSS_M03_ELEMENT_CLOSURE_V2 = "observe";
    assert.notEqual(key(), enforced);
    process.env.CDSS_M03_ELEMENT_CLOSURE_V2 = "off";
    assert.equal(a.elementClosurePolicy().mode, "off");
    assert.notEqual(key(), enforced);
    process.env.CDSS_M03_ELEMENT_CLOSURE_V2 = "enforce";
    process.env.CDSS_M03_ELEMENT_CLOSURE_V2_DISABLE = "d3,d5";
    assert.notEqual(key(), enforced);
  } finally {
    if (before === undefined) delete process.env.CDSS_M03_ELEMENT_CLOSURE_V2;
    else process.env.CDSS_M03_ELEMENT_CLOSURE_V2 = before;
    if (disabled === undefined) delete process.env.CDSS_M03_ELEMENT_CLOSURE_V2_DISABLE;
    else process.env.CDSS_M03_ELEMENT_CLOSURE_V2_DISABLE = disabled;
  }
  const api = fs.readFileSync(new URL("../src/lib/diagnosis-api.ts", import.meta.url), "utf8");
  assert.match(api, /if \(!checkM03ElementsBeforeSign\(reasoning\)\)[\s\S]*?applyDiagnoseContractSignature\(attested/);
  assert.match(api, /if \(finalM03 && checkM03ElementsBeforeSign\(finalM03\)\) \{\s+signedContent = applyDiagnoseContractSignature/);
});
await check("L28", "独立行级许可的湿能回填，未经许可的湿在治法写入者处被挡", () => {
  const root = make("无教材病", "气虚证", "气虚乏力，湿困中焦", "健脾渗湿");
  const ctx = context("现病史：经期大便溏泄，肢体困重，腹胀。\n舌象：苔白腻。");
  root.pathogenesis.natureDifferentiation.items = ["气虚"];
  const runtime = v.createM03ElementClosure(ctx, policy());
  assert.deepEqual(therapyWriter.withMethodImpliedNatureElements(structuredClone(root), ctx.recordText), ["湿"]);
  assert.deepEqual(therapyWriter.withMethodImpliedNatureElements(root, ctx.recordText, id => runtime.allowsWriter(root, id, "element")), []);
  root.overview.secondarySyndromes = ["湿邪证"];
  assert.deepEqual(therapyWriter.withMethodImpliedNatureElements(root, ctx.recordText, id => runtime.allowsWriter(root, id, "element")), ["湿"]);
});

await check("L29", "病性复合项拆分后不把失去的组件重新带回", () => {
  const root = make("水肿", "脾肾阳虚证", "脾肾阳虚，水液停聚", "健脾利水");
  root.pathogenesis.natureDifferentiation.items = ["脾肾阳虚", "水湿"];
  const solved = out(root).root;
  assert.deepEqual(a.checkM03ElementClosure(solved), []);
  assert.ok(solved.pathogenesis.natureDifferentiation.items.some(value => value.includes("水停") || value.includes("水湿")));
});
await check("L30", "最后一次闭合后不改定稿依据，末端复查定位字段", () => {
  const root = make("便秘", "血虚证", "血虚失养", "养血润肠");
  root.overview.tcmDiagnosticRationale = "肢体酸麻为血虚。少气懒言为气虚。故辨血虚证。";
  const runtime = v.createM03ElementClosure(context(), policy());
  const unchanged = runtime.settle(root, false).root;
  assert.equal(unchanged.overview.tcmDiagnosticRationale, root.overview.tcmDiagnosticRationale);
  unchanged.pathogenesis.chain[0].pathogenesis += "，胃热消谷";
  assert.ok(runtime.inspect(unchanged).some(hit => hit.field === "/pathogenesis/chain/0/pathogenesis"));
});
await check("L31", "既有安全门认定成组危候时先落实，缺红旗不立", () => {
  const root = append(make("真心痛", "心血瘀阻证", "瘀阻心脉", "活血通脉"), "心阳欲脱", "回阳固脱");
  root.management = { redFlagLoop: "立即急诊评估。" };
  const recordText = "主诉：心前区剧痛2小时。现病史：大汗淋漓，冷汗，四肢厥冷，脉微欲绝。";
  const ctx = { recordText, caseState: { chiefComplaint: "心前区剧痛", vitals: { bp: "78/46", pulse: 124 } },
    gateRedFlags: ["胸痛/胸闷伴大汗、放射痛或气促，需排除急性心血管事件"] };
  assert.ok(old.groupedCollapseSignal(ctx));
  const solved = out(root, ctx).root;
  assert.notEqual(solved.overview.primarySyndrome, root.overview.primarySyndrome);
  assert.equal(solved.management.redFlagLoop, root.management.redFlagLoop);
  assert.deepEqual(names(out(root, { ...ctx, gateRedFlags: [] }).root), names(root));
});

await check("L32", "病位病性回填产生的待核项和未定证草稿都经末端许可", () => {
  const root = make("蛇串疮", "肝经郁热证", "肝经郁热", "清泄肝火，解毒止痛");
  root.overview.primarySyndromeResolution = "bounded";
  root.overview.primarySyndromeResolutionReason = "阳虚程度需结合随访评估";
  root.pathogenesis.locationDifferentiation.resolution = "resolved";
  root.pathogenesis.natureDifferentiation.resolution = "resolved";
  root.pathogenesis.natureDifferentiation.items = ["热"];
  const ctx = context();
  const runtime = v.createM03ElementClosure(ctx, policy());
  const old = p.projectDeliveredReasoning(root, { recordText: ctx.recordText });
  assert.ok(old.pathogenesis.uncertainties.some(item => item.item.includes("阳虚")));
  const projected = p.projectDeliveredReasoning(root, { recordText: ctx.recordText, m03ElementAllows: runtime.allowsWriter });
  assert.ok(!projected.pathogenesis.uncertainties.some(item => item.item.includes("阳虚")));
  root.overview.primarySyndromeResolution = "unresolved";
  root.pathogenesis.chain[0].pathogenesis = "脾阳不运";
  assert.ok(runtime.inspect(root).some(hit => hit.field === "/pathogenesis/chain/0/pathogenesis"));
  root.pathogenesis.chain = [];
  assert.deepEqual(runtime.inspect(root), []);
});

await check("F01", "同教材行的舌、脉同时符合才许可阴虚、虚火，限本脏", () => {
  const row = a.selectedElementRow({ disease: "耳鸣耳聋", primarySyndrome: "肾精亏损证", secondarySyndromes: [] });
  assert.ok(a.deliveryPairCovered({ type: "阴虚", organ: "肾" }, a.rowElementPairs(row)));
  assert.ok(a.deliveryPairCovered({ type: "deficient-heat" }, a.rowElementPairs(row)));
  for (const altered of [{ ...row, pulse: "脉缓" }, { ...row, tongue: "舌淡" }]) {
    assert.ok(!a.deliveryPairCovered({ type: "阴虚" }, a.rowElementPairs(altered)));
  }
  assert.ok(!a.deliveryPairCovered({ type: "阴虚", organ: "肝" }, a.rowElementPairs(row)));
});
await check("F02", "撤空病性时按证名分解回填，保留已定轴及本虚分栏", () => {
  const root = make("耳鸣耳聋", "肾精亏损证", "肾精不足", "补肾填精");
  Object.assign(root.pathogenesis.natureDifferentiation, { resolution: "resolved", items: ["痰浊"] });
  const result = out(root);
  assert.equal(result.guard, undefined);
  assert.ok(result.root.pathogenesis.natureDifferentiation.items.includes("精亏"));
  assert.ok(result.root.pathogenesis.natureDifferentiation.rootDeficiency.includes("精亏"));
  assert.deepEqual(a.checkM03ElementClosure(result.root), []);
});
await check("F03", "行级许可前按成组湿象合称，单一湿象保留教材单证", () => {
  const root = make("带下过多", "脾虚证", "脾虚湿困", "健脾除湿");
  root.pathogenesis.natureDifferentiation.items = ["气虚", "湿"];
  assert.deepEqual(names(out(root, context("四肢困重，大便溏，舌苔白腻。")).root), ["带下过多", "脾虚湿困证"]);
  assert.deepEqual(names(out(root, context("舌苔白腻。")).root), names(root));
});
await check("F04", "同合称的多个成分一并吸收；独立兼证、缺少另一脏成组依据不合", async () => {
  const root = make("心悸", "心血不足证", "心血不足，脾气虚弱", "补血养心，益气安神");
  root.overview.secondarySyndromes = ["心气虚证", "脾气虚证"];
  root.pathogenesis.locationDifferentiation.details.push({location: "脾", basis: "餐后腹满、食少"});
  root.pathogenesis.natureDifferentiation.items = ["血虚", "气虚"];
  const ctx = context("病史：近月易惊醒，餐后腹满、食少。");
  assert.deepEqual(names(out(root, ctx).root), ["心悸", "心脾两虚证"]);
  assert.deepEqual(names(out(root, context("餐后腹满。")).root), names(root));
  const original = structuredClone(root);
  root.overview.secondarySyndromes.push("肝郁证");
  assert.deepEqual(names(out(root, ctx).root), names(root));
  const collected = await v.collectM03ClosureEvidence(JSON.stringify(original), ctx, policy(), undefined, {
    reconcile: async value => value, request: async () => new Map(),
  });
  original.overview.secondarySyndromes = [];
  original.pathogenesis.locationDifferentiation.details.pop();
  assert.deepEqual(names(out(original, ctx, collected.evidence).root), ["心悸", "心脾两虚证"]);
});
await check("F05", "保住主证依据的鉴别点和链节点引用；纯定位与定位后的病性分开", () => {
  const root = append(make(), "脾阳不运", "温阳健脾");
  root.overview.primarySyndromeBasis.push("自汗");
  root.pathogenesis.chain[1].patientFact = "自汗";
  assert.equal(out(root).guard, "chain_key_discriminator_missing");
  root.overview.primarySyndromeBasis.pop();
  root.therapy.subTherapies[0].targetPathogenesis = "对应P2病机";
  assert.equal(out(root).guard, "missing_chain_reference");
  const keep = structuredClone(root.pathogenesis.chain[0]);
  delete keep.nodeId;
  root.pathogenesis.chain.push(keep);
  root.therapy.subTherapies[0].targetPathogenesis = "对应P3病机";
  assert.equal(out(root).root.therapy.subTherapies[0].targetPathogenesis, "对应P2病机");
  assert.deepEqual(keys(find("病位在胃热消谷", "location")), ["heat/胃"]);
  assert.deepEqual(find("病位在胃", "location"), []);
});
await check("F06", "撤空病位、总体病机或治法时，整例回到观察且末检仍可见名外断言", () => {
  for (const change of [
    root => { root.pathogenesis.locationDifferentiation.items = ["胃热"]; },
    root => { root.overview.primarySyndromeBasis = ["腕痛"]; root.overview.overallPathogenesis = "脾阳不运。"; },
    root => { root.therapy.overallMethod = "温阳健脾"; },
  ]) {
    const root = make();
    change(root);
    const runtime = v.createM03ElementClosure(context(), policy());
    const settled = runtime.settle(root, true);
    assert.ok(settled.guard, String(change));
    assert.ok(runtime.guarded());
    assert.deepEqual(settled.root, root);
    assert.deepEqual(runtime.settle(root, false).root, root);
    assert.ok(runtime.audit(root).length);
  }
});
await check("F07", "实际 M03 定稿、交付与签名在撤空护栏下只生成一次", async () => {
  const ctx = context("心悸健忘、纳差便溏；舌淡，脉细弱；入睡困难、多梦易醒3个月");
  const root = make("不寐", "心脾两虚证", "脾气亏虚，心血失养", "健脾益气，养血安神");
  const ev = { evidenceLevel: "model_inference", source: "本例四诊资料", confidence: "中" };
  Object.assign(root.overview, {
    primarySyndromeBasis: ["心悸健忘", "纳差便溏"], tcmDiseaseRationale: "入睡困难，多梦易醒，病程三个月，符合不寐。",
    tcmDiagnosticRationale: "心悸健忘与纳差便溏并见，结合舌淡脉细弱，支持心脾两虚、心神失养。",
    tcmDiseaseDifferentials: [{diseaseName: "多寐病", reason: "均有睡眠异常", distinguishingPoints: "入睡困难而非日间嗜睡", nextCheck: null}],
    recommendedFormulaDirection: "归脾汤加减", recommendedFormulaNames: ["归脾汤"], formulaSelectionMode: "single", evidence: ev,
  });
  delete root.overview.primarySyndromeResolution;
  root.westernDiagnosis = { primary: {name: "失眠症状", status: "考虑", confidence: "中", supportingFacts: ["入睡困难、多梦易醒3个月"],
    clinicalRationale: "入睡困难、多梦易醒3个月支持失眠症状，日间功能受损尚待评估。", limitations: ["未完成睡眠量表"], suggestedChecks: [], evidence: ev}, differentials: [] };
  Object.assign(root.pathogenesis, {
    locationDifferentiation: {items: ["心", "脾"], evidence: ev}, natureDifferentiation: {items: ["气虚", "血虚"], evidence: ev},
    chain: [{nodeId: "P1", patientFact: "心悸健忘、纳差便溏", syndromeEvidence: "舌淡，脉细弱",
      pathogenesis: "胃热消谷", therapyDirection: "健脾益气，养血安神", evidence: ev}], symptomClusters: [],
  });
  root.therapy.overallPrinciple = "虚则补之，标本兼顾";
  root.management = { followupSafetyNet: "若入睡困难持续两周不缓解或明显加重，及时复诊评估。" };
  const original = globalThis.fetch;
  const abort = new AbortController();
  let requests = 0;
  const runtime = v.createM03ElementClosure(ctx, policy());
  try {
    globalThis.fetch = async () => {
      requests++;
      const event = {choices: [{delta: {content: JSON.stringify(root)}, finish_reason: "stop"}]};
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {headers: {"content-type": "text/event-stream"}});
    };
    const { callDiagnosisStream } = await jiti.import("../src/lib/diagnosis-api.ts");
    const response = await callDiagnosisStream("合成辨证病例", "deepseek", undefined, "markdown", {
      structuredStage: "diagnose", requestSignal: abort.signal, structuredClinicalContext: ctx.recordText,
      structuredAllowedM03FormulaNames: ["归脾汤"], structuredOrchestrationStartedAt: Date.now(), m03ElementClosure: runtime,
      truncateFallback: "SYNTHETIC_LIMITED", diagnoseSignatureContext: { contractVersion: "tcm-cdss-m03-signature-v5",
        caseId: "synthetic-closure", encounterId: "synthetic-closure", clinicalInputHash: `sha256:${"a".repeat(64)}` },
    });
    const frames = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    const content = frames.findLast(frame => frame.content?.startsWith("<<<CDSS_STREAM_FINAL>>>"))?.content || "";
    assert.equal(requests, 1);
    assert.ok(runtime.guarded());
    assert.match(content, /"contractSignature":\s*"hmac-sha256:/);
    assert.match(content, /胃热消谷/);
    assert.doesNotMatch(content, /SYNTHETIC_LIMITED/);
  } finally { abort.abort(); globalThis.fetch = original; }
});

await check("F08", "危候伴胸痛、舌暗，判据未取得独立成组支持时保留危候、撤血瘀断言", () => {
  const root = append(make("真心痛", "心阳欲脱证", "心阳欲脱", "回阳固脱"), "血瘀阻络", "活血化瘀");
  root.pathogenesis.natureDifferentiation.items = ["阳脱", "血瘀"];
  const ctx = context("胸部压迫不适，冷汗淋漓，痛向肩部放射。\n舌象：舌质暗紫。");
  const result = out(root, ctx, evidence(root, new Map(), ["血瘀证"]));
  assert.deepEqual(names(result.root), ["真心痛", "心阳欲脱证"]);
  assert.equal(result.ledger.find(row => row.pair.type === "stasis").disposition, "withdrawn_task_failed");
  assert.deepEqual(result.root.pathogenesis.natureDifferentiation.items, ["阳脱"]);
});

await check("F09", "交付投影后才触发护栏也回滚同稿早先撤回，保留后写的独立字段", () => {
  const root = make();
  root.pathogenesis.natureDifferentiation.items = ["血虚", "津亏"];
  const runtime = v.createM03ElementClosure(context(), policy());
  const first = runtime.settle(root, true);
  assert.equal(first.guard, undefined);
  assert.deepEqual(first.root.pathogenesis.natureDifferentiation.items, ["血虚"]);
  const late = structuredClone(first.root);
  late.therapy.overallMethod = "温补肾阳";
  late.management = { followupSafetyNet: "两日后复诊" };
  const final = runtime.settle(late, false);
  assert.ok(final.guard);
  assert.deepEqual(final.root.pathogenesis.natureDifferentiation.items, ["血虚", "津亏"]);
  assert.deepEqual(final.root.management, late.management);
});

await check("F10", "本行已许可的证素若有严格独立成组判据，仍先进入可承载的国标合称", async () => {
  const root = append(make("产后身痛", "血虚证", "血虚失养", "补血益气"), "气虚失养", "益气扶正");
  const ctx = context("本次稍动气促，少气懒言。舌质淡嫩。");
  const matches = entries({ 气虚证: [["少气懒言", "少气懒言"], ["舌质淡嫩", "舌质淡嫩"]] });
  const requested = [];
  const snapshot = await v.collectM03ClosureEvidence(JSON.stringify(root), ctx, policy(), undefined, {
    reconcile: async (value, ctx, signal, verify) => { await verify("血虚证", { ...ctx, primaryTerms: [] }, signal); return value; },
    request: async groups => { requested.push(...groups.map(row => row.name)); return matches; },
  });
  assert.ok(requested.includes("气虚证"));
  const strict = entry => verdict(entry, "pass", {evidenceDomains: 2, quotes: ["少气懒言", "舌质淡嫩"]});
  assert.equal(out(root, ctx, snapshot.evidence, policy(), strict).root.overview.primarySyndrome, "气血两虚证");
  assert.equal(out(root, ctx).root.overview.primarySyndrome, "血虚证");
});

const standardShapes = [
  ["感冒", "风寒束表证", "风寒束表，肺失宣降", "疏风散寒", "恶寒鼻塞，流清涕", "舌苔白", "脉浮紧"],
  ["心悸", "心虚胆怯证", "心神不宁，脾运不健", "镇惊定志", "心悸易惊，食少", "舌淡红", "脉细"],
  ["头痛", "血虚头痛", "血虚失养，脾运不健", "滋阴养血", "头晕头痛，食少，便溏", "舌淡", "脉细"],
  ["胃痛", "肝气犯胃证", "肝气横逆，胃失和降，脾失健运", "疏肝和胃", "胃脘胀痛，嗳气后减", "苔薄", "脉弦"],
  ["虚劳", "肺脾两虚证", "谷气不充，肺气不固，气陷", "补益肺脾，培土生金", "劳后气短，食少", "舌淡", "脉弱"],
  ["腰痛", "肾阴虚证", "肾阴亏虚，肾虚热", "滋补肾阴", "腰部酸痛，午后烘热", "舌红", "脉细"],
  ["牙痛", "胃火上炎证", "胃火上炎，龈络受灼，胃热伤津，热扰心神", "清胃泻火", "牙龈肿痛，时感口渴", "舌红", "脉数"],
  ["蛇串疮", "肝经郁热证", "热毒蕴结，湿邪伤津", "清热解毒", "皮肤疱疹，灼痛", "舌红", "脉弦"],
  ["瘾疹", "风热犯表证", "风热表邪，热灼津伤", "疏风清热", "风团瘙痒，口干", "舌红", "脉浮"],
  ["月经先期", "阳盛血热证", "热扰冲任，热甚伤津，血瘀", "清热凉血调经", "经期提前，经色深红", "舌红", "脉数"],
];
for (const [index, [disease, name, mechanism, method, body, tongue, pulse]] of standardShapes.entries()) {
  await check(`S${String(index + 1).padStart(2, "0")}`, `标准病历 ${index + 1} 合成近邻在三桩下病名主兼证稳定`, () => {
    const root = make(disease, name, mechanism, method);
    for (const state of ["pass", "fail", "failed"]) {
      const solved = forced(root, context(`现病史：${body}。\n舌象：${tongue}。\n脉象：${pulse}。`), state);
      assert.deepEqual(names(solved.root), [disease, name], state);
      assert.equal(solved.guard, undefined, state);
      assert.deepEqual(a.checkM03ElementClosure(solved.root), [], state);
    }
  });
}
console.log(`${checks - failures}/${checks} checks passed`);
process.exitCode = Number(failures > 0);
