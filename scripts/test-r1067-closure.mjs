// 合成病历与注入判据。所有检查在本机运行。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";
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
  const root = append(make("早泄", "肾气不固证", "肾气不固", "补益肾气"), "肾阳虚");
  assert.equal(out(root, context(), undefined, policy("d3")).ledger.find(row => row.pair.type === "阳虚").disposition, "named");
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
await check("L26", "空病机禁止从撤回节点造回完整链", () => {
  const root = make("不寐", "心血虚证", "脾阳不运", "温阳健脾");
  const solved = out(root).root;
  assert.deepEqual(solved.pathogenesis.chain, []);
  assert.equal(solved.overview.overallPathogenesis, "");
  assert.equal(solved.therapy.overallMethod, "");
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

const standardShapes = [
  ["感冒", "风寒束表证", "风寒束表，肺失宣降", "疏风散寒", "恶寒鼻塞，流清涕", "舌苔白", "脉浮紧"],
  ["心悸", "心虚胆怯证", "脾运不健", "镇惊定志", "心悸易惊，食少", "舌淡红", "脉细"],
  ["头痛", "血虚头痛", "血虚失养，脾运不健", "滋阴养血", "头晕头痛，食少，便溏", "舌淡", "脉细"],
  ["胃痛", "肝气犯胃证", "肝气横逆，胃失和降，脾失健运", "疏肝和胃", "胃脘胀痛，嗳气后减", "苔薄", "脉弦"],
  ["虚劳", "肺脾两虚证", "肺气不固，气陷", "补益肺脾", "劳后气短，食少", "舌淡", "脉弱"],
  ["腰痛", "肾阴虚证", "肾阴亏虚，肾虚热", "滋补肾阴", "腰部酸痛，午后烘热", "舌红", "脉细"],
  ["牙痛", "胃火上炎证", "胃热伤津，热扰心神", "清胃泻火", "牙龈肿痛，时感口渴", "舌红", "脉数"],
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
      assert.deepEqual(a.checkM03ElementClosure(solved.root), [], state);
    }
  });
}
console.log(`${checks - failures}/${checks} checks passed`);
process.exitCode = Number(failures > 0);
