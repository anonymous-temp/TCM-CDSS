// R47 C/D: all-field independent evidence checks, R01–R16 governance, scoped repair and rejection deletion.
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const facts = await jiti.import("../src/lib/delivery-patient-facts.server.ts");
const cross = await jiti.import("../src/lib/cross-model-small-task.server.ts");
const inv = await jiti.import("../src/lib/delivery-invariants.ts");
const governance = await jiti.import("../src/lib/delivery-invariant-governance.ts");
const repair = await jiti.import("../src/lib/delivery-gate-repair.ts");
const alignment = await jiti.import("../src/lib/m03-analysis-alignment.server.ts");
let checks = 0, failures = 0;
const check = async (id, description, run) => {
  if (process.env.R1064_FACTS_CHECK && process.env.R1064_FACTS_CHECK !== id) return;
  checks++;
  try { await run(); console.log(`✓ ${id} ${description}`); }
  catch (error) { failures++; console.error(`✗ ${id} ${description}\n${error.stack || error}`); }
};
const identities = [{ family: "deepseek", model: "deepseek-flash", endpointHost: "api.deepseek.com" }, { family: "qwen", model: "qwen3.8-flash", endpointHost: "dashscope.aliyuncs.com" }];
const state = { patient: { sex: "女", age: 44 }, chiefComplaint: "阵发烘热2天", symptoms: { 现病史: "烘热汗出，否认咽痛。", 既往史: "去年有胸痛，现已缓解。" }, tongue: "舌淡", pulse: "脉细", vitals: { T: "36.5" }, conversation: [{ role: "assistant", content: "是否胸痛？" }, { role: "user", content: "没有" }], gold: "不能用作事实" };
const record = facts.buildTrustedRecordIndex(state);
const candidate = (structured) => ({ stage: "diagnose", structured });
const verdict = (unit, kind = "not_patient_fact", extra = {}) => ({ occurrenceId: unit.occurrenceId, outputQuote: unit.text, outputStart: 0, outputEnd: unit.text.length, verdict: kind, recordEvidence: [], searchedSourcePaths: record.sources.map((source) => source.sourcePath), reason: "synthetic", ...extra });
const reviewer = (kind = "not_patient_fact", mutate) => async ({ units }) => {
  const a = { verdicts: units.map((unit) => verdict(unit, typeof kind === "function" ? kind(unit) : kind)) };
  const b = structuredClone(a);
  if (mutate) mutate(a, b, units);
  return { identities, results: [a, b] };
};
const evidence = { sourcePath: "/symptoms/现病史", start: 5, end: 9, quote: "否认咽痛" };
const scan = (m03, m04, extra = {}) => { const input = { m03, m04, recordIndex: record, ...extra }; return inv.scanDeliveryInvariants({ ...input, governedContext: extra.governedContext || governance.buildDeliveryInvariantGovernance({ ...input, recordText: "eGFR 17；Hb 75g/L", ageYears: 44 }) }); };
const base = () => ({ stage: "diagnose", overview: { tcmDiseaseName: "合成病", primarySyndrome: "气滞血瘀证", secondarySyndromes: [], overallPathogenesis: "气滞血瘀", tcmDiagnosticRationale: "气滞血瘀证", tcmDiseaseDifferentials: [{ diseaseName: "甲病" }, { diseaseName: "乙病" }], tcmDifferentials: [{ syndrome: "甲证" }, { syndrome: "乙证" }] }, pathogenesis: { natureDifferentiation: { items: ["气滞", "血瘀"], rootDeficiency: [], branchExcess: ["气滞", "血瘀"], basis: "舌淡" }, chain: [{ nodeId: "P1", pathogenesis: "气滞血瘀", patientFact: "舌淡" }], uncertainties: [] }, therapy: { overallMethod: "理气活血", overallPrinciple: "实则泻之" }, westernDiagnosis: { primary: { name: "合成诊断" }, differentials: [{ name: "甲诊断" }, { name: "乙诊断" }] } });
const has = (findings, id) => findings.some((finding) => finding.ruleId === id && finding.status === "violation");

await check("C01", "未知深字段、病机、卡片、调护、西医候选全部递归；机器/原文显式豁免", () => {
  const root = { pathogenesis: { chain: [{ pathogenesis: "本例咽痛", patientFact: "舌淡" }] }, nonPharma: { tcmTreatments: [{ note: "患者咽痛" }], lifestyle: "患者久病" }, westernDiagnosis: { candidates: [{ keyEvidence: ["患者咽痛"] }] }, future: { deep: ["本例咽痛"] }, clinicalReview: { note: "机器" } };
  const units = facts.collectDeliveryText(root);
  assert.equal(units.filter((unit) => unit.role === "clinical_narrative").length, 5);
  assert.equal(units.find((unit) => unit.path.endsWith("patientFact")).role, "verbatim_record");
});
await check("C02", "来源含人口/生命体征/回答/既往上下文；问题和gold不能当证据", () => {
  assert.ok(record.sources.some((source) => source.sourcePath === "/patient/age" && source.text === "44"));
  assert.ok(record.sources.some((source) => source.role === "history" && source.text.includes("去年")));
  assert.ok(record.sources.some((source) => source.role === "answer" && source.text === "没有" && source.questionContext === "是否胸痛？"));
  assert.ok(!record.sources.some((source) => source.text === "是否胸痛？" || source.text.includes("不能用作事实")));
});
await check("C03", "两家同厂商/模型家族与端点不合均不计独立", () => {
  assert.equal(cross.independentModelPair(identities), true);
  assert.equal(cross.independentModelPair([identities[0], { ...identities[0], model: "deepseek-chat" }]), false);
  assert.equal(cross.independentModelPair([identities[0], { ...identities[1], endpointHost: "api.deepseek.com" }]), false);
});
await check("C04", "输出逐字offset及来源逐字引文校验；伪造支持引文不能算通过", () => {
  const unit = { occurrenceId: "/x", path: "/x", text: "患者咽痛。" };
  const valid = verdict(unit, "contradicted", { recordEvidence: [evidence] });
  assert.equal(facts.parseFinalPatientFactVerdicts({ verdicts: [valid] }, [unit], record)[0].verdict, "contradicted");
  assert.equal(facts.parseFinalPatientFactVerdicts({ verdicts: [{ ...valid, recordEvidence: [{ ...evidence, quote: "同义咽痛" }] }] }, [unit], record)[0].verdict, "unknown");
  assert.deepEqual(facts.parseFinalPatientFactVerdicts({ verdicts: [{ ...valid, outputStart: 1 }] }, [unit], record), []);
});
await check("C05", "未诉/当前与既往并不豁免，缺失需检索全部来源；通则保留", async () => {
  const value = candidate({ pathogenesis: { summary: "未诉潮热。患者目前胸痛。" }, differential: "该病一般有胸痛。" });
  const result = await facts.checkFinalPatientFacts(value, record, {}, undefined, { reviewer: reviewer((unit) => unit.text.includes("一般") ? "not_patient_fact" : "unsupported") });
  assert.equal(result.cuts.length, 2);
  const changed = facts.applyDeliveryTextCuts(value, result.cuts).value;
  assert.equal(changed.structured.pathogenesis.summary, "");
  assert.equal(changed.structured.differential, value.structured.differential);
  const messages = JSON.stringify(facts.buildFinalPatientFactMessages([], record));
  assert.ok(messages.includes("未诉/未记录") && messages.includes("既往有不等于当前有"));
});
await check("C06", "唯一假句可删空；400字后的假句同样核；保留前面真实句", async () => {
  const value = candidate({ narrative: "已核一般推理。".repeat(80) + "患者咽痛。", one: "患者咽痛。" });
  const result = await facts.checkFinalPatientFacts(value, record, {}, undefined, { maxInputChars: 4000, maxBatches: 20, reviewer: reviewer((unit) => unit.text === "患者咽痛。" ? "unsupported" : "not_patient_fact") });
  const out = facts.applyDeliveryTextCuts(value, result.cuts);
  assert.equal(out.value.structured.one, "");
  assert.equal(out.value.structured.narrative, "已核一般推理。".repeat(80));
  assert.ok(result.coverage.every((entry) => entry.status !== "unknown"));
});
await check("C07", "两边分歧/遗漏/不同边界不能并集扩删", async () => {
  const value = candidate({ narrative: "患者咽痛。" });
  const result = await facts.checkFinalPatientFacts(value, record, {}, undefined, { reviewer: reviewer("unsupported", (_a, b) => { b.verdicts[0].verdict = "not_patient_fact"; }) });
  assert.equal(result.cuts.length, 0);
  assert.equal(result.status, "unknown");
  const boundaryDisagreement = await facts.checkFinalPatientFacts(value, record, {}, undefined, { reviewer: reviewer("unsupported", (_a, b) => { b.verdicts[0].unitKind = "independent_clause"; }) });
  assert.equal(boundaryDisagreement.cuts.length, 0);
});
await check("C08", "同厂商、超时、空回复和来源超预算明确unknown", async () => {
  const value = candidate({ narrative: "患者咽痛。" });
  const same = await facts.checkFinalPatientFacts(value, record, {}, undefined, { reviewer: async (request) => ({ ...(await reviewer("unsupported")(request)), identities: [identities[0], identities[0]] }) });
  const timeout = await facts.checkFinalPatientFacts(value, record, {}, undefined, { timeoutMs: 5, reviewer: () => new Promise(() => {}) });
  const budget = await facts.checkFinalPatientFacts(value, record, {}, undefined, { maxInputChars: 20, reviewer: reviewer() });
  for (const result of [same, timeout, budget]) { assert.equal(result.status, "unknown"); assert.equal(result.cuts.length, 0); }
});
await check("C09", "缓存绑定完整语境/结论/记录/厂商；unknown不缓存，原引文不可改", async () => {
  const value = candidate({ narrative: "一般病理推理。", patientFact: "舌淡" });
  let calls = 0, narrativeCalls = 0;
  const contexts = [];
  const review = async (request) => { contexts.push(JSON.parse(request.messages[1].content).deliveryContext); if (request.units.some((unit) => unit.path === "/structured/narrative")) narrativeCalls++; calls++; return reviewer()(request); };
  const first = await facts.checkFinalPatientFacts(value, record, {}, undefined, { reviewer: review, identities });
  await facts.checkFinalPatientFacts(value, record, first.cache, undefined, { reviewer: review, identities });
  assert.equal(calls, 1);
  await facts.checkFinalPatientFacts({ ...value, visibleText: "本例表现" }, record, first.cache, undefined, { reviewer: review, identities });
  assert.equal(narrativeCalls, 2);
  await facts.checkFinalPatientFacts(value, record, first.cache, undefined, { reviewer: review, identities, contextHash: "changed-scope-only" });
  assert.equal(contexts.at(-1).contextHash, "changed-scope-only", "the underlying model-task cache must also see scope changes");
  const previousHash = contexts[0].candidateHash;
  await facts.checkFinalPatientFacts(candidate({ ...value.structured, overview: { primarySyndrome: "另一已锁定证名" } }), record, first.cache, undefined, { reviewer: review, identities });
  assert.notEqual(contexts.at(-1).candidateHash, previousHash, "protected conclusion changes must invalidate the model-task memo, not only the outer cache");
  const badQuote = await facts.checkFinalPatientFacts(candidate({ patientFact: "病历没有的原话" }), record, {}, undefined, { reviewer: review });
  assert.equal(badQuote.status, "unknown");
  assert.equal(facts.applyDeliveryTextCuts(value, [{ path: "/structured/patientFact", before: "舌淡", start: 0, end: 2, quote: "舌淡" }]).applied, 0);
});
await check("C10", "过期快照与offset拒绝编辑；双重复句按路径分开", async () => {
  const value = candidate({ a: "患者咽痛。", b: "患者咽痛。" });
  const result = await facts.checkFinalPatientFacts(value, record, {}, undefined, { reviewer: reviewer("unsupported") });
  assert.equal(result.cuts.length, 2);
  assert.deepEqual(facts.planMinimalFactCuts(result, candidate({ a: "已变", b: "患者咽痛。" })), []);
  assert.equal(facts.applyDeliveryTextCuts(candidate({ a: "已变", b: "患者咽痛。" }), result.cuts).stale, 1);
});

await check("C11", "缺失必须覆盖全部来源检索，supported不能无引文", () => {
  const unit = { occurrenceId: "/x", path: "/x", text: "患者咽痛。" };
  const missing = verdict(unit, "unsupported", { searchedSourcePaths: [] });
  assert.equal(facts.parseFinalPatientFactVerdicts({ verdicts: [missing] }, [unit], record)[0].verdict, "unknown");
  assert.equal(facts.parseFinalPatientFactVerdicts({ verdicts: [verdict(unit, "supported")] }, [unit], record)[0].verdict, "unknown");
});
await check("C12", "安全结论/证名/药名剂量锁与原引文不会被事实模型删除", async () => {
  const value = candidate({ contractSignatureVersion: "schema-signature-v3", coding: { display: "冻结编码显示" }, terminologyMappings: [{ input: "原术语", standardTerm: "冻结术语" }], overview: { primarySyndrome: "脾气虚证" }, safetyGate: { note: "冻结安全结果" }, formula: { candidates: [{ herbs: [{ name: "白术", dose: "9g", function: "本例咽痛。" }] }] } });
  const result = await facts.checkFinalPatientFacts(value, record, {}, undefined, { reviewer: reviewer("unsupported") });
  assert.equal(result.cuts.length, 1);
  const changed = facts.applyDeliveryTextCuts(value, result.cuts).value;
  assert.equal(changed.structured.overview.primarySyndrome, "脾气虚证");
  assert.equal(changed.structured.formula.candidates[0].herbs[0].dose, "9g");
  assert.equal(changed.structured.safetyGate.note, "冻结安全结果");
});

await check("C13", "重叠矛盾回包不授权删除；真实缺项可凭完整来源检索核实", () => {
  const unit = { occurrenceId: "/x", path: "/x", text: "未诉口渴。" };
  const absent = verdict(unit, "supported", { recordBasis: "record_absence" });
  assert.equal(facts.parseFinalPatientFactVerdicts({ verdicts: [absent] }, [unit], record)[0].verdict, "supported");
  const rows = facts.parseFinalPatientFactVerdicts({ verdicts: [absent, verdict(unit, "unsupported")] }, [unit], record);
  assert.ok(rows.every((row) => row.verdict === "unknown"));
});

await check("C14", "两家明确同意独立从句时只删该从句，保留同句真实表现", async () => {
  const value = candidate({ narrative: "患者烘热，患者咽痛。" });
  const review = async ({ units }) => {
    const unit = units[0];
    const rows = [{ ...verdict(unit), outputQuote: "患者烘热，", outputEnd: 5 }, { ...verdict(unit, "unsupported"), outputQuote: "患者咽痛。", outputStart: 5, unitKind: "independent_clause" }];
    return { identities, results: [{ verdicts: rows }, { verdicts: structuredClone(rows) }] };
  };
  const result = await facts.checkFinalPatientFacts(value, record, {}, undefined, { reviewer: review });
  assert.equal(facts.applyDeliveryTextCuts(value, result.cuts).value.structured.narrative, "患者烘热。");
});

await check("D01", "R01证名有而病性缺；气虚发热/暑热蕴含不机械误报", () => {
  const value = base(); value.pathogenesis.natureDifferentiation = { items: ["气滞"], branchExcess: ["气滞"], rootDeficiency: [] };
  assert.ok(has(scan(value), "R01"));
  value.overview.primarySyndrome = "气虚发热证"; value.pathogenesis.natureDifferentiation = { items: ["气虚"], rootDeficiency: ["气虚"], branchExcess: [] };
  assert.ok(!has(scan(value), "R01"));
  value.overview.primarySyndrome = "暑热疫毒证"; value.pathogenesis.natureDifferentiation = { items: ["暑", "毒"], rootDeficiency: [], branchExcess: ["暑", "毒"] };
  assert.ok(!has(scan(value), "R01"));
});
await check("D02", "R02名外证素须待核；治理不足不硬拦", () => {
  const value = base(); value.pathogenesis.natureDifferentiation.items.push("痰");
  assert.ok(has(scan(value), "R02"));
  const ctx = governance.buildDeliveryInvariantGovernance({ m03: value });
  ctx.pending = { "/m03/pathogenesis/uncertainties/0/item": { ids: ["phlegm"], complete: true, authority: "synthetic governed sidecar" } };
  assert.ok(!has(scan(value, undefined, { governedContext: ctx }), "R02"));
  value.overview.primarySyndrome = "未治理复合证";
  assert.ok(scan(value).some((row) => row.ruleId === "R02" && row.mode === "shadow"));
  assert.equal(governance.governedSyndromeElements(["脾虚证"]).complete, false);
  assert.equal(governance.governedAxisElements("虚热").complete, false);
});
await check("D03", "R03本标必须属于items且不误分；同义控制标签可闭合", () => {
  const value = base(); value.pathogenesis.natureDifferentiation.rootDeficiency = ["血瘀"]; value.pathogenesis.natureDifferentiation.branchExcess = [];
  assert.ok(has(scan(value), "R03"));
  assert.ok(!has(scan(base()), "R03"));
});
await check("D04", "R04复用既有治则权威，缺依据shadow", () => {
  const value = base(); value.therapy.overallPrinciple = "虚则补之";
  // Existing name-derived principles do not govern all clinical root/branch priorities; default candidate stays shadow.
  assert.ok(scan(value).some((row) => row.ruleId === "R04" && row.mode === "shadow"));
  const governed = governance.buildDeliveryInvariantGovernance({ m03: value });
  governed.principle = { compatible: false, expected: "实则泻之", authority: "synthetic reviewed principle compatibility", complete: true };
  assert.ok(has(scan(value, undefined, { governedContext: governed }), "R04"));
  assert.ok(!has(scan(base()), "R04"));
  assert.ok(inv.scanDeliveryInvariants({ m03: value }).filter((row) => row.ruleId === "R04").every((row) => row.mode === "shadow"));
});
await check("D05", "R05逐字HPI与triggerSource同时核，主诉事实不能冒充HPI", () => {
  const m04 = { overview: { primarySyndromeBasis: ["烘热汗出"] }, formula: { modifications: [{ trigger: "本例已见烘热汗出", triggerSource: { kind: "primary_syndrome_basis", sourceRef: "overview.primarySyndromeBasis[0]", sourceQuote: "烘热汗出" } }] } };
  assert.ok(!has(scan(undefined, m04), "R05"));
  m04.formula.modifications[0].trigger = "本例已见阵发烘热2天";
  assert.ok(has(scan(undefined, m04), "R05"));
  m04.formula.modifications[0].trigger = "本例已见烘热";
  m04.formula.modifications[0].triggerSource.sourceQuote = "烘热";
  assert.ok(!has(scan(undefined, m04), "R05"));
  m04.overview.primarySyndromeBasis[0] = "畏寒";
  assert.ok(has(scan(undefined, m04), "R05"));
});
await check("D06", "R06方义外药；炮制半夏、原方比较与药引不误报", () => {
  const m04 = { formula: { candidates: [{ name: "二陈汤", source: "《太平惠民和剂局方》", formulaAnalysis: "黄芪为君，补气。", herbs: [{ name: "法半夏", role: "君" }, { name: "茯苓", role: "臣" }] }] } };
  assert.ok(has(scan(undefined, m04), "R06"));
  m04.formula.candidates[0].formulaAnalysis = "半夏燥湿化痰，茯苓健脾。";
  assert.ok(!has(scan(undefined, m04), "R06"));
  m04.formula.candidates[0].formulaAnalysis = "去黄芪，以法半夏燥湿化痰。";
  assert.ok(!has(scan(undefined, m04), "R06"));
});
await check("D07", "R07角色冲突及组合角色", () => {
  const m04 = { formula: { candidates: [{ formulaAnalysis: "炙甘草为臣。", herbs: [{ name: "炙甘草", role: "使" }] }] } };
  assert.ok(has(scan(undefined, m04), "R07"));
  m04.formula.candidates[0].herbs[0].role = "臣使";
  assert.ok(!has(scan(undefined, m04), "R07"));
});
await check("D08", "R08原方有且现方无，来源错误/多版本只shadow，药引包含在原方", () => {
  const m04 = { formula: { candidates: [{ name: "四君子汤", source: "《太平惠民和剂局方》", formulaAnalysis: "去黄芪。", herbs: [{ name: "人参", role: "君" }, { name: "白术", role: "臣" }] }] } };
  assert.ok(has(scan(undefined, m04), "R08"));
  m04.formula.candidates[0].formulaAnalysis = "去茯苓。";
  assert.ok(!has(scan(undefined, m04), "R08"));
  m04.formula.candidates[0].source = "《不存在的方书》";
  assert.ok(scan(undefined, m04).some((row) => row.ruleId === "R08" && row.status === "unknown"));
  const withGuide = { formula: { candidates: [{ name: "归脾汤", source: "《校注妇人良方》", formulaAnalysis: "去生姜、大枣。", herbs: [{ name: "白术" }] }] } };
  const claims = governance.buildDeliveryInvariantGovernance({ m04: withGuide }).formulaClaims.filter((claim) => claim.kind === "removed");
  assert.equal(claims.length, 2); assert.ok(claims.every((claim) => claim.inOriginal === true));
});
await check("D09", "R09病名级和证候级鉴别均至少2", () => {
  const value = base(); value.overview.tcmDifferentials = [{ syndrome: "甲证" }];
  assert.ok(has(scan(value), "R09"));
  assert.ok(!has(scan(base()), "R09"));
});
await check("D10", "R10同名及受治理同一关系；不靠包含关系判同病", () => {
  const value = base(); value.westernDiagnosis.differentials[0].name = "合成诊断";
  assert.ok(has(scan(value), "R10"));
  value.westernDiagnosis.differentials[0].name = "合成诊断的亚型";
  assert.ok(!has(scan(value), "R10"));
  value.westernDiagnosis.differentials[0].name = "另一合法别名";
  const ctx = governance.buildDeliveryInvariantGovernance({ m03: value });
  ctx.equivalentDiagnoses = { "另一合法别名": "合成诊断" };
  assert.ok(has(scan(value, undefined, { governedContext: ctx }), "R10"));
});
await check("D11", "R11只消费冻结风险结果且永久shadow，不新造休克判据", () => {
  const findings = scan(base(), undefined, { governedContext: { circulationRisk: { triggered: true, reasonCodes: ["synthetic_frozen_circulation"] } } });
  const rows = findings.filter((row) => row.ruleId === "R11");
  assert.equal(rows.length, 1); assert.equal(rows[0].mode, "shadow");
  assert.equal(repair.findingsToDeliveryRepairRequests(rows, { m03: base() }, "enforce").requests.length, 0);
});
await check("D12", "R12按现有ownership全部章节核漂移，包括病机/治法", () => {
  const value = base(), m04 = { ...structuredClone(value), stage: "prescribe" };
  assert.ok(!has(scan(value, m04), "R12"));
  m04.pathogenesis.chain[0].pathogenesis = "另一病机";
  assert.ok(has(scan(value, m04), "R12"));
});
await check("D13", "R13删除节点/坏引用检出，非node目标不误判", () => {
  const m04 = { ...base(), formula: { candidates: [{ herbs: [{ name: "白术", targetKind: "pathogenesis_node", targetRef: "P9" }] }] } };
  assert.ok(has(scan(base(), m04), "R13"));
  m04.formula.candidates[0].herbs[0].targetKind = "symptom";
  assert.ok(!has(scan(base(), m04), "R13"));
});
await check("D14", "R14只按受治理pending elementId核同一要素", () => {
  const value = base(); value.pathogenesis.uncertainties = [{ item: "瘀象是否成立", pending: true, elementIds: ["blood_stasis"], elementAuthority: "synthetic reviewed element annotation" }];
  assert.ok(!has(scan(value), "R14"), "model-written authority labels do not establish governance");
  const ctx = governance.buildDeliveryInvariantGovernance({ m03: value });
  ctx.pending = { "/m03/pathogenesis/uncertainties/0/item": { ids: ["blood_stasis"], complete: true, authority: "synthetic server-reviewed annotation" } };
  assert.ok(has(scan(value, undefined, { governedContext: ctx }), "R14"));
  ctx.pending["/m03/pathogenesis/uncertainties/0/item"].ids = ["phlegm"];
  assert.ok(!has(scan(value, undefined, { governedContext: ctx }), "R14"));
});
await check("D15", "R15中段残句、空括号与重复后缀；天天及原始引文保留", () => {
  const value = base(); value.overview.tcmDiagnosticRationale = "先写正确。去药，并以本方。后续完整。";
  assert.ok(has(scan(value), "R15"));
  value.overview.tcmDiagnosticRationale = "患者天天运动。";
  value.pathogenesis.chain[0].patientFact = "当归尾尾（）。";
  assert.ok(!has(scan(value), "R15"));
});
await check("D16", "R16复用当前eGFR/Hb分级及标准句保护", () => {
  const value = base(); value.westernDiagnosis.primary.name = "慢性肾脏病5期";
  assert.ok(has(scan(value), "R16"));
  value.westernDiagnosis.primary.name = "尚未达到慢性肾脏病5期eGFR<15的标准";
  assert.ok(!has(scan(value), "R16"));
  value.westernDiagnosis.primary.name = "轻度贫血";
  assert.ok(has(scan(value), "R16"));
});
await check("D17", "纯函数幂等且不写输入，治理缺失不冒充通过", () => {
  const value = base(), before = JSON.stringify(value);
  const a = scan(value), b = scan(value);
  assert.deepEqual(a, b); assert.equal(JSON.stringify(value), before);
  assert.ok(inv.scanDeliveryInvariants({ m03: value }).some((row) => row.status === "unknown" && row.mode === "shadow"));
});
await check("D18", "限域修复冻结结论/药表，只可改指定方义；shadow不发请求", () => {
  const m04 = { formula: { candidates: [{ name: "合成方", formulaAnalysis: "错误方义", herbs: [{ name: "白术", dose: "9g" }] }] } };
  const input = { m04 };
  const finding = { ruleId: "R06", path: "/m04/formula/candidates/0/formulaAnalysis", expected: "表内药", actual: "外药", mode: "enforce", status: "violation", repairOwner: "formula" };
  assert.equal(repair.findingsToDeliveryRepairRequests([finding], input, "shadow").requests.length, 0);
  const plan = repair.findingsToDeliveryRepairRequests([finding], input, "enforce");
  assert.equal(plan.requests.length, 1);
  const changed = structuredClone(input); changed.m04.formula.candidates[0].formulaAnalysis = "新方义";
  assert.equal(repair.deliveryRepairStayedInScope(input, changed, plan.requests[0]), true);
  changed.m04.formula.candidates[0].herbs[0].dose = "99g";
  assert.equal(repair.deliveryRepairStayedInScope(input, changed, plan.requests[0]), false);
  changed.m04.formula.candidates[0].herbs[0].dose = "9g";
  changed.m04.nonPharma = { lifestyle: "越界新建议" };
  assert.equal(repair.deliveryRepairStayedInScope(input, changed, plan.requests[0]), false);
});
await check("D19", "对齐重写拒收后删矛盾句/条目/链，结论与原引文锁不动", () => {
  const value = base(); value.overview.primarySyndrome = "脾气虚证"; value.therapy.overallMethod = "健脾益气";
  value.pathogenesis.natureDifferentiation = { items: ["气虚", "血瘀"], rootDeficiency: ["气虚"], branchExcess: ["血瘀"], basis: "舌淡" };
  value.overview.tcmDiagnosticRationale = "舌淡为气虚之象。未见血瘀。尚不足以另立血瘀主证。瘀血阻络，故属气滞血瘀证。";
  value.overview.overallPathogenesis = "瘀血阻络。";
  const out = alignment.withoutMisalignedAnalysis(value, "舌淡");
  assert.equal(out.overview.primarySyndrome, value.overview.primarySyndrome);
  assert.ok(!JSON.stringify(out.overview).includes("瘀血阻络"));
  assert.ok(out.overview.tcmDiagnosticRationale.includes("未见血瘀"));
  assert.ok(out.overview.tcmDiagnosticRationale.includes("尚不足以另立血瘀主证"));
  assert.deepEqual(out.pathogenesis.natureDifferentiation.branchExcess, []);
  assert.equal(out.pathogenesis.chain.length, 0);
});
await check("D20", "缺项不编依据或抹掉真实分析，未解决finding保留；旧接受条件仍拒绝假引文", () => {
  const value = base(); value.overview.tcmDiagnosticRationale += "。未见便血，不支持热结或肠结。纳食一般属表证影响，不作兼证。"; value.pathogenesis.natureDifferentiation.items = ["气滞"]; value.pathogenesis.natureDifferentiation.branchExcess = ["气滞"];
  const out = alignment.withoutMisalignedAnalysis(value, "舌淡");
  assert.equal(out.overview.tcmDiagnosticRationale, value.overview.tcmDiagnosticRationale);
  assert.equal(out.pathogenesis.natureDifferentiation.basis, value.pathogenesis.natureDifferentiation.basis);
  // R48：缺失要素从已交付证名/链补齐，不再把缺项留给第二套病性判据；仍不编造引文。
  assert.deepEqual(out.pathogenesis.natureDifferentiation.items, ["气滞", "血瘀"]);
  assert.ok(!alignment.analysisMisalignments(out, "舌淡").some((issue) => issue.code === "syndrome_element_missing"));
  const rewrite = { rationale: "患者症状形成气滞血瘀，病机与证候相符，诸症合参进一步说明病机演变，辨证属于气滞血瘀证。", natureItems: ["气滞", "血瘀"], rootDeficiency: [], branchExcess: ["气滞", "血瘀"], natureBasis: "捏造引文", overallPathogenesis: "气滞血瘀", uncertainties: [] };
  assert.equal(alignment.acceptedAlignmentRewrite(value, rewrite, "舌淡"), undefined);
});

await check("D21", "实际对齐入口失败不得返回矛盾原稿，关闭开关仍兼容旧路径", async () => {
  const value = base(); value.overview.primarySyndrome = "脾气虚证"; value.therapy.overallMethod = "健脾益气";
  value.overview.tcmDiagnosticRationale = "舌淡为气虚之象。属气滞血瘀证。为气滞血瘀证。";
  value.pathogenesis.natureDifferentiation = { items: ["气虚", "血瘀"], rootDeficiency: ["气虚"], branchExcess: ["血瘀"], basis: "舌淡" };
  const start = "<!-- DIAGNOSIS_JSON_START -->", end = "<!-- DIAGNOSIS_JSON_END -->";
  const content = `${start}${JSON.stringify(value)}${end}`;
  const previous = process.env.CDSS_M03_ANALYSIS_ALIGNMENT;
  try {
    process.env.CDSS_M03_ANALYSIS_ALIGNMENT = "true";
    const result = await alignment.alignAnalysisWithConclusion(content, { recordText: "舌淡" }, undefined, async () => undefined);
    const parsed = JSON.parse(result.slice(result.indexOf(start) + start.length, result.indexOf(end)));
    assert.equal(parsed.overview.tcmDiagnosticRationale, "舌淡为气虚之象。");
    process.env.CDSS_M03_ANALYSIS_ALIGNMENT = "false";
    assert.equal(await alignment.alignAnalysisWithConclusion(content, { recordText: "舌淡" }, undefined, async () => undefined), content);
  } finally { if (previous === undefined) delete process.env.CDSS_M03_ANALYSIS_ALIGNMENT; else process.env.CDSS_M03_ANALYSIS_ALIGNMENT = previous; }
});
await check("D22", "补鉴别只能append，受限重写不能改引文/安全数据", () => {
  const snapshot = { m03: { overview: { tcmDifferentials: [{ syndrome: "甲证" }] }, pathogenesis: { natureDifferentiation: { items: ["气虚"], evidence: { source: "冻结出处" } } } } };
  const finding = { ruleId: "R09", path: "/m03/overview/tcmDifferentials", expected: ">=2", actual: 1, mode: "enforce", status: "violation", repairOwner: "differentials" };
  const request = repair.findingsToDeliveryRepairRequests([finding], snapshot, "enforce").requests[0];
  const changed = structuredClone(snapshot); changed.m03.overview.tcmDifferentials = [{ syndrome: "乙证" }, { syndrome: "丙证" }];
  assert.equal(repair.deliveryRepairStayedInScope(snapshot, changed, request), false);
  changed.m03.overview.tcmDifferentials = [{ syndrome: "甲证" }, { syndrome: "乙证" }];
  assert.equal(repair.deliveryRepairStayedInScope(snapshot, changed, request), true);
});

await check("D23", "失败删句前不把气虚发热当实热；湿/水湿治理ID归一", () => {
  const value = base(); value.overview.primarySyndrome = "气虚发热证"; value.therapy.overallMethod = "益气健脾";
  value.overview.tcmDiagnosticRationale = "气虚发热证";
  value.pathogenesis.natureDifferentiation = { items: ["气虚"], rootDeficiency: ["气虚"], branchExcess: [] };
  assert.ok(!alignment.analysisMisalignments(value, "乏力").some((issue) => issue.code === "syndrome_element_missing"));
  assert.deepEqual([...alignment.natureElementsIn("水湿")], [...alignment.natureElementsIn("湿")]);
  value.overview.primarySyndrome = "暑热疫毒证"; value.overview.tcmDiagnosticRationale = "暑热疫毒证";
  value.pathogenesis.natureDifferentiation = { items: ["暑", "毒"], rootDeficiency: [], branchExcess: ["暑", "毒"] };
  assert.ok(!alignment.analysisMisalignments(value, "暑热").some((issue) => issue.code === "syndrome_element_missing"));
});

await check("D24", "历史抽查误报整类回归：药名括注、治则次序、M04派生复诊句", () => {
  const m03 = base(); m03.management = { followupSafetyNet: "服完本次药后复诊" };
  const m04 = structuredClone(m03); m04.stage = "prescribe"; m04.management.followupSafetyNet = "服完5剂药后复诊";
  const rows = scan(m03, m04).filter((row) => row.ruleId === "R12");
  assert.equal(rows.length, 1); assert.equal(rows[0].mode, "shadow");
  m03.therapy.overallPrinciple = "急则治标，实则泻之";
  assert.ok(!scan(m03).some((row) => row.ruleId === "R04"));
  const rx = { formula: { candidates: [{ formulaAnalysis: "延胡索为臣。", herbs: [{ name: "延胡索（元胡）", role: "臣" }] }] } };
  const gov = governance.buildDeliveryInvariantGovernance({ m04: rx });
  assert.equal(gov.roleClaims[0].tableRole, "臣"); assert.ok(!has(scan(undefined, rx), "R07"));
  rx.formula.candidates[0].formulaAnalysis = "延胡索为臣。延胡索为使。";
  assert.ok(has(scan(undefined, rx), "R07"));
});

console.log(JSON.stringify({ checks, failures }));
if (failures) process.exitCode = 1;
