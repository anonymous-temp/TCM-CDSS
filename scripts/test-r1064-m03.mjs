import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { fixture, fakeIO, envelope, textPass, violation } from "./fixtures/m03-tcm-two-pass/synthetic.mjs";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const c = await jiti.import("../src/lib/m03-tcm-conclusion.ts");
const checks = await jiti.import("../src/lib/m03-tcm-conclusion-checks.server.ts");
const n = await jiti.import("../src/lib/m03-tcm-narrative.ts");
const v = await jiti.import("../src/lib/m03-tcm-text-validation.server.ts");
const p = await jiti.import("../src/lib/m03-tcm-projection.ts");
const two = await jiti.import("../src/lib/m03-tcm-two-pass.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const anchor = await jiti.import("../src/lib/m03-tcm-anchor.ts");
const budget = () => [new AbortController().signal, Date.now() + 20_000];
const run = (data, io = fakeIO(data), options = {}) => two.runM03TcmTwoPass(data.ctx, io, { enabled: true, ...options });
const checked = async (data, io = fakeIO(data)) => checks.checkM03TcmConclusion(data.proposal, data.ctx, io, ...budget());
let count = 0, failed = 0;
const only = process.env.M03_CHECK;
async function check(id, name, fn) {
  if (only && only !== id) return;
  count++;
  try { await fn(); console.log(`✓ ${id} ${name}`); }
  catch (error) { failed++; console.error(`✗ ${id} ${name}\n${error.stack || error}`); }
}
const delivered = (result) => { assert.ok(["ready", "bounded"].includes(result.kind), JSON.stringify(result)); return result; };
await check("1.1", "主开关缺省关且parallel=false冲突关闭，不调用模型", async () => {
  assert.equal(two.m03TcmTwoPassPolicy({}).enabled, false);
  assert.equal(two.m03TcmTwoPassPolicy({ CDSS_M03_TCM_TWO_PASS: "true", M03_PARALLEL_GENERATION: "false" }).enabled, false);
  assert.deepEqual(await two.runM03TcmTwoPass(fixture().ctx, fakeIO(fixture()), { enabled: false }), { kind: "disabled" });
});
await check("1.2", "严格schema拒绝安全键与坏数组，两步provider对象拒绝附加字段", () => {
  const d = fixture(); assert.throws(() => c.parseM03TcmProposal({ ...d.proposal, allowDose: true }, d.ctx));
  assert.throws(() => c.parseM03TcmProposal({ ...d.proposal, locations: [{}] }, d.ctx));
  for (const schema of [c.M03_TCM_CONCLUSION_PROVIDER_SCHEMA, n.M03_TCM_NARRATIVE_PROVIDER_SCHEMA]) assert.equal(schema.additionalProperties, false);
});
await check("1.3", "所有候选ID/索引/重复引文/证名/治法/流派拒绝越界", () => {
  const d = fixture();
  for (const mutate of [x => x.locations[0].id = "FOREIGN", x => x.locations[0].quotes = [15], x => x.primary = "外来证", x => x.quotePool.push(x.quotePool[0]), x => x.methods[0].text = "虚构治法", x => x.lineage = { applicable: "partial", targets: ["E1"] }]) {
    const draft = structuredClone(d.proposal); mutate(draft); assert.throws(() => c.parseM03TcmProposal(draft, d.ctx));
  }
});
await check("1.4", "引用精确定位：歧义、伪造引文、其他人的证据不能肯定入组", async () => {
  const d = fixture(); const quotes = c.locateM03TcmQuotes(d.proposal, d.ctx); assert.equal(quotes[0].start, 2);
  d.ctx.facts.push({ ...d.ctx.facts[0], fieldPath: "duplicate" });
  assert.ok(!c.locateM03TcmQuotes(d.proposal, d.ctx).some(q => q.id === "Q1"));
  d.ctx.facts[1].scope = "other";
  assert.equal((await checked(d)).kind, "unusable");
});
await check("2.1", "正常两步：首步不含正文；病位/病性/治法同源，外部无内部ID", async () => {
  const d = fixture(), io = fakeIO(d); const result = delivered(await run(d, io));
  assert.deepEqual(io.calls.map(x => x.task), ["m03_tcm_conclusion", "m03_tcm_narrative"]);
  assert.ok(io.calls[1].prompt.includes('"text":"腹胀"'));
  assert.deepEqual(result.half.pathogenesis.natureDifferentiation.rootDeficiency, ["气虚"]);
  assert.equal(result.half.overview.overallTherapy, result.half.therapy.overallMethod);
  assert.equal(result.half.pathogenesis.summary, result.half.overview.overallPathogenesis);
  assert.ok(!result.tcmRaw.includes('"quoteIds"'));
  const full = types.ReasoningV2Schema.parse(result.half); assert.equal(full.overview.primarySyndrome, "脾气虚证");
  const raw = fakeIO(d); for (const key of ["checkUnits", "checkDisease", "checkMethods", "checkLineage"]) delete raw[key];
  const phases = [];
  raw.completeCheck = async request => {
    phases.push(`${request.kind}:${request.phase}`);
    const input = JSON.parse(request.prompt.split("\n").at(-1));
    if (request.phase === "verify") return { finishReason: "stop", value: { confirmations: input.claims.map(claim => ({ id: claim.id, confirmed: true })) } };
    const value = request.kind === "units" ? { units: [...input.units.map(unit => ({ id: unit.id, status: "matched", matches: unit.criteria.map((item, i) => ({ item, quoteId: `Q${unit.quotes[Math.min(i, unit.quotes.length - 1)] + 1}` })) })), { corrupt: true }] }
      : request.kind === "disease" ? { diseases: ["visit_reason", "disease_points"].map(checker => ({ checker, status: "pass", replacement: null, quoteIds: ["Q1"] })) }
      : request.kind === "methods" ? { methods: [{ id: "M1", status: "pass" }] } : { status: "pass" };
    return { finishReason: "stop", value };
  };
  const viaTransport = delivered(await run(d, raw)); assert.deepEqual(viaTransport.half.pathogenesis.natureDifferentiation.rootDeficiency, ["气虚"]);
  assert.ok(phases.includes("units:verify")); assert.ok(phases.includes("disease:verify"));
});
await check("2.2", "首步越界重抽只一次，仍越界不可进入文字", async () => {
  const d = fixture(); d.proposal.primary = "外来证"; const io = fakeIO(d);
  assert.equal((await run(d, io)).kind, "unusable"); assert.equal(io.calls.length, 2);
  assert.ok(io.calls.every(x => x.task === "m03_tcm_conclusion"));
});
await check("2.3", "名内证素也核；宽pass不能冻结；正常舌不能算血虚", async () => {
  const d = fixture(); d.proposal.elements.root[0].quotes = [3]; d.proposal.elements.root[0].criteria = ["神疲乏力"];
  d.proposal.methods[0].targets = ["L1"];
  const a = await checked(d); assert.equal(a.record.root.length, 0); assert.ok(a.record.pending.some(x => x.id === "E1"));
  const breadth = fixture();
  for (const text of ["气短", "自汗", "头晕目眩"]) { breadth.ctx.facts.push({ ...breadth.ctx.facts[0], fieldPath: text, text }); breadth.proposal.quotePool.push({ quote: text, sourceHint: null }); }
  breadth.ctx.units[1].criteriaName = "气虚证"; breadth.ctx.units[1].criteriaIds = ["气短", "自汗", "头晕目眩"];
  breadth.proposal.elements.root[0] = { id: "E1", quotes: [5,6,7], criteria: breadth.ctx.units[1].criteriaIds }; breadth.proposal.methods[0].targets = ["L1"];
  const b = await checked(breadth); assert.equal(b.record.root.length, 0); assert.ok(b.record.pending.some(x => x.reasonCode === "breadth_only"));
  const normal = fixture(); normal.ctx.units[1].criteriaName = "血虚证"; normal.ctx.units[1].criteriaIds = ["面色淡白", "舌色淡白", "脉细"];
  for (const text of ["脉和缓", "纳可"]) { normal.ctx.facts.push({ ...normal.ctx.facts[4], fieldPath: text, text }); normal.proposal.quotePool.push({ quote: text, sourceHint: null }); }
  normal.proposal.elements.root[0] = { id: "E1", quotes: [4,5,6], criteria: normal.ctx.units[1].criteriaIds };
  const out = await checked(normal); assert.equal(out.kind, "unusable");
  const hb = fixture();
  for (const text of ["面色淡白", "脉细", "血红蛋白96g/L"]) { hb.ctx.facts.push({ ...hb.ctx.facts[0], fieldPath: text, text }); hb.proposal.quotePool.push({ quote: text, sourceHint: null }); }
  hb.ctx.units[1].label = "血虚"; hb.ctx.syndromes[0].name = "血虚证"; hb.proposal.primary = "血虚证"; hb.ctx.methods[0].text = "滋阴养血"; hb.proposal.methods[0].text = "滋阴养血";
  hb.ctx.units[1].criteriaName = "血虚证"; hb.ctx.units[1].criteriaIds = ["面色淡白", "脉细"];
  hb.proposal.elements.root[0] = { id: "E1", quotes: [5,6,7], criteria: ["面色淡白", "脉细"] };
  const numeric = await checked(hb); assert.ok(numeric.record.root[0].quoteIds.includes("Q8")); assert.ok(numeric.record.root[0].criteriaIds.includes("rule:record-anemia-grade"));
  hb.proposal.elements.root[0].quotes = [5,6];
  assert.equal((await checked(hb)).kind, "unusable");
});
await check("2.4", "未知/关闭核对不当通过；迟到的旧revision/hash结果不可落地", async () => {
  const d = fixture(); const io = fakeIO(d, { checkDisease: undefined }); assert.equal((await checked(d, io)).kind, "unusable");
  const stale = fakeIO(d, { checkMethods: async input => ({ ...envelope(input, [{ id: "M1", status: "pass" }]), baseRevision: input.baseRevision - 1 }) });
  assert.equal((await checked(d, stale)).kind, "unusable");
  const staleHash = fakeIO(d, { checkUnits: async input => ({ ...envelope(input, []), inputHash: "old" }) });
  assert.equal((await checked(d, staleHash)).kind, "unusable");
});
await check("2.5", "换病名后所有单位/治法重核且重抽约束累积", async () => {
  const d = fixture(), revisions = []; let draws = 0;
  const io = fakeIO(d, { complete: async request => {
    const value = structuredClone(request.task === "m03_tcm_conclusion" ? d.proposal : d.narrative);
    if (request.task === "m03_tcm_conclusion" && draws++ > 0) value.disease.name = "胃痞";
    return { value, finishReason: "stop" };
  }, checkDisease: async input => { revisions.push(input.baseRevision); return envelope(input, input.proposal.disease.name === "虚劳"
    ? [{ checker: "visit_reason", status: "fail", replacement: "胃痞", quoteIds: ["Q1"] }]
    : [{ checker: "visit_reason", status: "pass", replacement: null, quoteIds: ["Q1"] }, { checker: "disease_points", status: "pass", replacement: null, quoteIds: ["Q1"] }]); } });
  const result = delivered(await run(d, io)); assert.equal(result.half.overview.tcmDiseaseName, "胃痞"); assert.deepEqual(revisions, [1, 2]);
  assert.ok(result.frozen.checks.every(x => x.inputHash === result.frozen.checks[0].inputHash));
});
await check("2.6", "冻结为独立深拷贝且hash不随属性顺序变化；pending不可进入有效集合", async () => {
  const d = fixture(), result = await checked(d); const frozen = c.freezeM03TcmConclusion(result.record, d.ctx);
  assert.ok(Object.isFrozen(frozen.root[0].quoteIds)); result.record.root[0].label = "篡改"; assert.equal(frozen.root[0].label, "气虚");
  assert.equal(c.m03TcmHash({ a: 1, b: 2 }), c.m03TcmHash({ b: 2, a: 1 }));
  const invalid = structuredClone(frozen); delete invalid.conclusionHash; invalid.pending.push({ id: "E1", target: "气虚", seenQuoteIds: [], missingCriteriaIds: [], reasonCode: "unknown" });
  assert.throws(() => c.freezeM03TcmConclusion(invalid, d.ctx));
});
await check("3.1", "文字全字段违规重写一次；二次违规整句删除不回原稿", async () => {
  const d = fixture(); d.narrative.rationale.push(d.sentence("bad", "阴津耗伤，另立阴虚。"));
  const io = fakeIO(d, { checkSemantics: async input => textPass(input, input.sentences.some(x => x.sentence.id === "bad") ? [violation(["bad"])] : []) });
  const result = delivered(await run(d, io)); assert.equal(result.quality.rewrites, 1); assert.ok(!result.tcmRaw.includes("阴津耗伤")); assert.ok(result.quality.prunedSentenceIds.includes("bad"));
  assert.equal(io.calls.filter(x => x.task === "m03_tcm_narrative").length, 2);
});
await check("3.2", "重写非法则删除首稿违规句；不是把原矛盾稿交回", async () => {
  const d = fixture(); d.narrative.overall.push(d.sentence("bad", "久病入络导致血瘀。")); let authored = 0;
  const io = fakeIO(d, { complete: async request => ({ value: request.task === "m03_tcm_conclusion" ? d.proposal : ++authored === 1 ? d.narrative : { unknown: true }, finishReason: "stop" }),
    checkFacts: async input => textPass(input, input.sentences.some(x => x.sentence.id === "bad") ? [violation(["bad"], "timeline")] : []) });
  const result = delivered(await run(d, io)); assert.ok(!result.tcmRaw.includes("久病入络")); assert.ok(result.quality.prunedSentenceIds.includes("bad"));
});
await check("3.3", "链偷加pending、依赖下游递归整节点删除并重排P编号/分治法", async () => {
  const d = fixture(); d.narrative.chain.push({ ...d.narrative.chain[0], id: "bad", unitIds: ["PENDING"] },
    { ...d.narrative.chain[0], id: "downstream", dependsOn: ["bad"] }, { ...d.narrative.chain[0], id: "keep" });
  const result = delivered(await run(d)); assert.deepEqual(result.half.pathogenesis.chain.map(x => x.nodeId), ["P1", "P2"]);
  assert.deepEqual(result.quality.prunedSentenceIds.sort(), ["bad", "downstream"]); assert.equal(result.half.therapy.subTherapies[1].targetPathogenesis, "P2");
});
await check("3.4", "时序/待核实已知项/鉴别典型表现冒充事实/流派另立证一起检查", async () => {
  const d = fixture(); d.narrative.rationale.push(d.sentence("time", "先喘后肿。"));
  d.narrative.diseaseDifferentials[0].distinguishingPoints.text = "本例有该病典型的情志抑郁。";
  d.ctx.units.push({ id: "E2", label: "阴虚", kind: "root", locationIds: ["L1"], criteriaIds: ["缺映射"] });
  d.proposal.elements.root.push({ id: "E2", quotes: [0], criteria: ["缺映射"] });
  d.narrative.uncertainties.push({ pendingId: "E2", item: d.sentence("pendingItem", "大便情况待问。"), reason: d.sentence("pendingReason", "本次大便未记录。"), affects: d.sentence("pendingAffects", "需补大便性状。") });
  const io = fakeIO(d, { checkFacts: async input => textPass(input, input.sentences.filter(x => x.sentence.id === "time" || x.sentence.id === "dif0d" || x.sentence.id === "pendingReason").map(x => violation([x.sentence.id], "full_field_facts"))) });
  const result = delivered(await run(d, io)); assert.ok(!result.tcmRaw.includes("先喘后肿")); assert.ok(!result.tcmRaw.includes("本例有该病典型"));
  assert.equal(result.narrative.diseaseDifferentials.length, 1); assert.equal(result.half.pathogenesis.uncertainties.length, 0);
  const slots = n.m03TcmNarrativeSentences(d.narrative); assert.ok(slots.some(x => x.path.endsWith("distinguishingPoints")));
});
await check("3.5", "全字段检查不可用则无未核长文字；核心全删不可造假链", async () => {
  const d = fixture(); const io = fakeIO(d, { checkFacts: undefined }); const result = await run(d, io);
  assert.equal(result.kind, "unusable"); assert.deepEqual(result.reasons, ["narrative_core_pruned"]);
  const empty = n.pruneInvalidM03TcmSentences(d.narrative, [violation(["ch1"])]); assert.equal(empty.chain.length, 0); assert.equal(n.usableM03TcmNarrative(empty), false);
});
await check("3.6", "rewrite开关关也删句；空引用/越界method/重复句ID不能漏", async () => {
  const d = fixture(); d.narrative.rationale.push(d.sentence("bad", "没有引文的推断。", []));
  const io = fakeIO(d); const result = delivered(await run(d, io, { rewrite: false })); assert.ok(!result.tcmRaw.includes("没有引文")); assert.equal(io.calls.length, 2);
  const duplicate = structuredClone(d.narrative); duplicate.rationale.push(duplicate.rationale[0]);
  assert.ok(v.structuralM03TcmNarrativeViolations(duplicate, result.frozen, d.ctx).some(x => x.code === "duplicate_sentence_id"));
  const malformed = structuredClone(d.narrative); malformed.chain[0].methodIds = ["UNKNOWN"];
  assert.ok(v.structuralM03TcmNarrativeViolations(malformed, result.frozen, d.ctx).some(x => x.code === "inactive_method"));
});
await check("4.1", "红旗沿用安全裁决，治则急则治标，不生成或改动西医management", async () => {
  const d = fixture(); d.ctx.safety.redFlag = true; const result = delivered(await run(d));
  assert.equal(result.half.therapy.overallPrinciple, "急则治标"); assert.ok(!("management" in result.half)); assert.ok(!("westernDiagnosis" in result.half));
  assert.equal(result.half.formula, null); assert.equal(d.ctx.safety.redFlag, true);
});
await check("4.2", "稀疏资料只用受治理中性工作证名、不补虚实", async () => {
  const d = fixture(); d.proposal.elements.root = []; d.proposal.primary = "脾失健运证"; d.proposal.methods = [{ text: "调理脾胃", targets: ["L1"], quotes: [1] }];
  for (const slot of n.m03TcmNarrativeSentences(d.narrative)) slot.sentence.unitIds = ["L1"];
  d.narrative.chain[0].methodIds = ["M0"]; d.narrative.chain[0].evidenceQuoteIds = ["Q2"];
  const result = delivered(await run(d)); assert.equal(result.half.overview.primarySyndromeResolution, "bounded");
  assert.deepEqual(result.half.pathogenesis.natureDifferentiation.items, []); assert.equal(result.half.therapy.overallPrinciple, "调理阴阳");
});
await check("4.3", "复合证名需全部因素strict通过，教材不得添漏因素；经方身份不免检", async () => {
  const d = fixture(); const first = await checked(d); const record = first.record;
  d.ctx.syndromes.push({ name: "脾气阴两虚证", locationIds: ["L1"], elementIds: ["E1", "E2"], compositeRuleId: "fixture:composite" });
  assert.equal(anchor.selectM03TcmSyndrome("脾气阴两虚证", record, d.ctx), undefined);
  d.ctx.syndromes[0].jingfangId = "fixture:jingfang";
  assert.equal(anchor.selectM03TcmSyndrome("脾气虚证", record, d.ctx).name, "脾气虚证");
  const compound = fixture();
  for (const text of ["胀闷", "胀痛", "脉弦"]) { compound.ctx.facts.push({ ...compound.ctx.facts[0], fieldPath: text, text }); compound.proposal.quotePool.push({ quote: text, sourceHint: null }); }
  compound.ctx.units.push({ id: "E2", label: "气滞", kind: "branch", locationIds: ["L1"], criteriaName: "气滞证", criteriaIds: ["胀闷", "胀痛", "脉弦"] });
  compound.ctx.syndromes.push({ name: "脾虚气滞证", locationIds: ["L1"], elementIds: ["E1", "E2"], compositeRuleId: "fixture:composite" });
  compound.proposal.elements.branch.push({ id: "E2", quotes: [5,6,7], criteria: ["胀闷", "胀痛", "脉弦"] });
  const composed = delivered(await run(compound)); assert.equal(composed.half.overview.primarySyndrome, "脾虚气滞证");
  record.root.push({ ...record.root[0], id: "E2", label: "阴虚" });
  assert.equal(anchor.selectM03TcmSyndrome("脾气阴两虚证", record, d.ctx).compositeRuleId, "fixture:composite");
});
await check("4.4", "流派只写冻结targets；句中另立病性删除，partial保留", async () => {
  const d = fixture(); d.ctx.lineage = { code: "danxi", label: "丹溪思路", targets: ["E1"], safetyDeference: "安全边界优先", unaffectedBySafety: [] };
  d.proposal.lineage = { applicable: "partial", targets: ["E1"] };
  d.narrative.lineageText = { reason: [d.sentence("lens", "本例纳少，从气机视角解释运化。")], influencedDecisions: [{ aspect: "辨证视角", detail: d.sentence("lensBad", "因此另立阴虚证。"), targetIds: ["E1"] }] };
  const io = fakeIO(d, { checkSemantics: async input => textPass(input, input.sentences.some(x => x.sentence.id === "lensBad") ? [violation(["lensBad"], "lens_new_element")] : []) });
  const result = delivered(await run(d, io)); assert.equal(result.half.lineageAdaptation.applicable, "partial"); assert.equal(result.half.lineageAdaptation.influencedDecisions.length, 0);
});
await check("4.5", "活动出血方锁与同名异方安全适配，命名不从治法反推湿", () => {
  const row = provenance.selectM03TcmFormulaIdentity({ disease: "腹痛", syndrome: "瘀血内停证", textbookRowId: "neike|腹痛|瘀血内停", direction: "少腹逐瘀汤加减", method: "活血祛瘀，温经止痛", keepDirection: true,
    caseSafety: { activeBleeding: true, barredHerb: () => false } });
  assert.deepEqual(row.formulaLock.names, []); assert.equal(row.formulaLock.mode, "self_devised");
});
await check("4.6", "最终投影与无参数重复投影均不改冻结结论；主动漂移必拒绝", async () => {
  const d = fixture(), result = delivered(await run(d)); const twice = surface.projectDeliveredReasoning(result.half);
  assert.equal(p.conclusionFootprint(twice), p.frozenM03TcmFootprint(result.frozen, d.ctx, false));
  const forged = structuredClone(result.half); forged.pathogenesis.natureDifferentiation.branchExcess = ["湿"];
  assert.throws(() => p.assertM03TcmProjection(result.frozen, forged, d.ctx));
});
await check("5.1", "最终实际投影再检查，覆盖所有出口且不以中间稿通过代替", async () => {
  const d = fixture(); d.narrative.rationale.push(d.sentence("last", "最终才发现的患者断言。")); let finals = 0;
  const io = fakeIO(d, { checkFacts: async input => { if (input.projected) finals++; return textPass(input, input.projected && input.sentences.some(x => x.sentence.id === "last") ? [violation(["last"], "final_surface")] : []); } });
  const result = delivered(await run(d, io)); assert.ok(finals >= 2); assert.ok(!result.tcmRaw.includes("最终才发现"));
});
await check("5.2", "同一绝对截止时间贯穿两步；abort/截断不输出首步JSON", async () => {
  const d = fixture(); const io = fakeIO(d); const deadline = Date.now() + 20_000; delivered(await run(d, io, { absoluteDeadline: deadline }));
  assert.ok(io.calls.every(x => x.absoluteDeadline === deadline));
  const truncated = fakeIO(d, { complete: async () => ({ value: d.proposal, finishReason: "length" }) });
  const incomplete = await run(d, truncated); assert.equal(incomplete.kind, "upstream_unavailable"); assert.deepEqual(incomplete.reasons, ["incomplete_conclusion"]);
  const controller = new AbortController(); controller.abort(); await assert.rejects(() => run(d, fakeIO(d), { signal: controller.signal }));
});
await check("5.3", "首步提示词明确闭集/原文/否认边界，第二步schema拒绝改结论", () => {
  const d = fixture(); assert.ok(c.buildM03TcmConclusionPrompt(d.ctx).includes("不得剪去否认范围"));
  assert.throws(() => n.M03TcmNarrativeSchema.parse({ ...d.narrative, overallMethod: "滋阴" }));
});
console.log(`${count - failed}/${count} checks passed`);
if (failed) process.exitCode = 1;
