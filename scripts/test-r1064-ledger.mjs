// Round 47 S1a: observation-only ledger, changed-sentence integrity, no live models.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const ledger = await jiti.import("../src/lib/delivery-rewrite-ledger.ts");
const scope = await jiti.import("../src/lib/delivery-rewrite-ledger.server.ts");
const sentences = await jiti.import("../src/lib/delivery-rewrite-sentences.ts");
const integrity = await jiti.import("../src/lib/delivery-rewrite-integrity.server.ts");
const selected = new Set((process.env.R1064_LEDGER_CHECKS || "").split(",").filter(Boolean));
let failures = 0; let checks = 0;
const check = async (id, text, run) => { if (selected.size && !selected.has(id)) return; checks++; try { await run(); console.log(`✓ ${id} ${text}`); } catch (e) { failures++; console.error(`✗ ${id} ${text}\n  ${e.stack || e}`); } };
const ctx = { requestId: "synthetic-ledger", stage: "diagnose", mode: "shadow" };
const presentation = { ruleId: "test.presentation", ruleVersion: "1", expected: { kind: "presentation", ruleVersion: "1" } };
const rename = { ruleId: "test.rename", ruleVersion: "1", expected: { kind: "rename", from: "当归", to: "当归尾", authority: "synthetic governed table" } };
const makeUnits = (before, after, rule = presentation, protectedPaths) => {
  const store = ledger.createRewriteLedger({ ...ctx, protectedPaths });
  store.snapshot("final", { text: before }, { text: after }, rule);
  return { store, units: sentences.changedSentenceUnits(store.events, { payload: { text: after } }) };
};
const signal = () => new AbortController().signal;
const modelBatch = (units, changes = {}) => Promise.resolve({ independent: true, content: { integrity: units.filter(u => !u.protected).map(u => ({ sentenceId: u.sentenceId, fluent: true, onlyExpectedDelta: true, span: null, reason: "", ...changes })) } });

await check("1.1", "开关缺省关闭，off 保留引用、字节及异常", async () => {
  assert.equal(scope.deliveryRewriteLedgerMode(undefined), "off"); assert.equal(scope.deliveryRewriteLedgerMode("invalid"), "off");
  const original = { text: "未诉未诉😀" };
  const out = await scope.withRewriteLedger(ctx, () => ledger.traceProjection("off", original, x => x), "off");
  assert.equal(out.value, original); assert.deepEqual(out.ledger, []);
  await assert.rejects(scope.withRewriteLedger(ctx, () => { throw Error("same failure"); }, "off"), /same failure/);
});
await check("1.2", "未登记 replace 被最终快照记为 unattributed，无变化不计", () => {
  const store = ledger.createRewriteLedger(ctx);
  store.snapshot("late", { text: "记录甲。", untouched: "原样" }, { text: "记录乙。", untouched: "原样" });
  assert.equal(store.events.length, 1); assert.equal(store.events[0].attribution, "unattributed"); assert.equal(store.events[0].path, "/diagnose/text");
});
await check("1.3", "数组删除、换位维持 occurrence，删除留 tombstone", () => {
  const store = ledger.createRewriteLedger(ctx);
  const original = { rows: [{ id: "a", text: "甲句。" }, { id: "b", text: "乙句。" }, { id: "c", text: "丙句。" }] };
  const edited = { rows: [{ id: "a", text: "甲改。" }, original.rows[1], original.rows[2]] };
  store.snapshot("first", original, edited, presentation);
  const id = store.events.find(e => e.after === "甲改。").occurrenceId;
  const final = { rows: [edited.rows[2], edited.rows[0]] };
  store.snapshot("reorder", edited, final, presentation);
  const moved = store.events.find(e => e.occurrenceId === id);
  assert.equal(moved.path, "/diagnose/rows/1/text");
  assert.ok(store.events.some(e => e.before === "乙句。" && e.tombstone));
  assert.equal(sentences.changedSentenceUnits(store.events, { payload: final }).find(u => u.occurrenceId === id).text, "甲改。");
});
await check("1.4", "相同句按字段和句内 occurrence 分开，JSON Pointer 转义", () => {
  const store = ledger.createRewriteLedger(ctx);
  store.snapshot("duplicates", { rows: ["同句。", "同句。"], "a/b~": "旧句。" }, { rows: ["同句改。", "同句改。"], "a/b~": "新句。" }, presentation);
  assert.equal(new Set(store.events.map(e => e.occurrenceId)).size, 3);
  assert.ok(store.events.some(e => e.path === "/diagnose/a~1b~0"));
  const repeated = makeUnits("甲。甲。", "甲。乙。"); assert.equal(repeated.units.length, 1); assert.equal(repeated.units[0].start, 2);
});
await check("1.5", "同一句多次改写仅检查一次并携带全链", async () => {
  const result = await scope.withRewriteLedger(ctx, () => ledger.traceProjection("outer", { text: "甲句。" }, input => ({ text:
    ledger.trackedText(presentation, { path: "/diagnose/text" }, x => x.replace("乙", "丙"), ledger.trackedText(presentation, { path: "/diagnose/text" }, x => x.replace("甲", "乙"), input.text)) })), "memory");
  assert.equal(result.ledger.length, 2); assert.equal(result.ledger[1].revision, 2);
  const units = sentences.changedSentenceUnits(result.ledger, { payload: result.value });
  assert.equal(new Set(units.map(u => u.sentenceId)).size, units.length); assert.equal(units[0].events.length, 2);
});
await check("1.6", "并发及嵌套 off 请求不串台", async () => {
  const outputs = await Promise.all(["one", "two"].map(requestId => scope.withRewriteLedger({ ...ctx, requestId }, async () => {
    await Promise.resolve(); ledger.trackedText(presentation, { path: "/diagnose/text" }, () => requestId, "old");
    await scope.withRewriteLedger(ctx, () => ledger.trackedText(presentation, { path: "/diagnose/text" }, () => "off", "old"), "off");
    return requestId;
  }, "memory")));
  outputs.forEach(o => { assert.equal(o.ledger.length, 1); assert.equal(o.ledger[0].requestId, o.value); assert.equal(o.ledger[0].after, o.value); });
});
await check("1.7", "原地修改也取到改前快照，memory/archive 不写文件", async () => {
  const out = await scope.withRewriteLedger(ctx, () => ledger.traceProjection("mutate", { text: "旧句。" }, x => { x.text = "新句。"; return x; }), "archive");
  assert.equal(out.ledger[0].before, "旧句。"); assert.equal(out.value.text, "新句。");
});
await check("1.8", "五族真实叶子入口均可观测且与 off 逐字等价", async () => {
  const surface = await jiti.import("../src/lib/delivered-surface.ts");
  const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  const formula = await jiti.import("../src/lib/formula-analysis-review.ts");
  const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
  const herbs = await jiti.import("../src/lib/herb-processing-forms.ts");
  const jobs = [
    () => surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDisease: "胃痛", primarySyndrome: "肝胃不和证" }, diagnosticRationale: { tcm: { syndromeRationale: "病历尚未确认口苦是否存在。" } } }),
    () => summary.unrecordedNegativesAsNotReported("无口苦。", "胃部胀满。"),
    () => formula.tidyPunctuation("甲，，乙。"),
    () => provenance.renamedDiseaseMentions("诊为耳鸣。", "耳鸣", "耳鸣耳聋"),
    () => herbs.withProcessedHerbMentions("当归活血。", new Map([["当归", "当归尾"]])),
  ];
  for (const job of jobs) {
    const off = await scope.withRewriteLedger(ctx, job, "off"); const on = await scope.withRewriteLedger(ctx, job, "memory");
    assert.deepEqual(on.value, off.value); assert.ok(on.ledger.length > 0, JSON.stringify(on.value)); assert.ok(on.ledger.every(e => e.ruleId !== "unattributed"));
  }
});
await check("1.9", "唯一字段的真实叶子链绑定路径并按规则计命中", async () => {
  const out = await scope.withRewriteLedger(ctx, () => ledger.traceProjection("final", { text: "旧句。" }, x => ({ text:
    ledger.observeTextRewrite(presentation, x.text, () => "新句。") })), "memory");
  assert.equal(out.ledger.length, 1); assert.equal(out.ledger[0].path, "/diagnose/text"); assert.equal(out.ledger[0].attribution, "leaf"); assert.equal(out.ledger[0].observationOnly, undefined);
});
await check("1.10", "替换有 id 的数组项产生新增和删除，不借用旧 occurrence", () => {
  const store = ledger.createRewriteLedger(ctx);
  const prior = { rows: [{ id: "a", text: "旧项。" }] };
  store.snapshot("seed", prior, prior, presentation);
  store.snapshot("replace", prior, { rows: [{ id: "b", text: "新项。" }] }, presentation);
  const removed = store.events.find(e => e.before === "旧项。"); const added = store.events.find(e => e.after === "新项。");
  assert.equal(removed.tombstone, true); assert.notEqual(removed.occurrenceId, added.occurrenceId);
});
await check("2.1", "只检查被改句，保留前后句上下文", () => {
  const { units } = makeUnits("旧句。未诉未诉口苦。尾句。", "新句。未诉未诉口苦。尾句。");
  assert.equal(units.length, 1); assert.equal(units[0].text, "新句。"); assert.equal(units[0].next, "未诉未诉口苦。");
  assert.deepEqual(integrity.checkRewriteMorphology(units), []);
});
await check("2.2", "重复固定词未诉未诉被拦，合法天天保留", () => {
  assert.ok(integrity.checkRewriteMorphology(makeUnits("旧句。", "未诉未诉口苦。").units).some(f => f.code === "repeated_fixed_phrase"));
  assert.deepEqual(integrity.checkRewriteMorphology(makeUnits("旧句。", "天天散步。").units), []);
});
await check("2.3", "空括号与跨句合法括号相区别", () => {
  assert.ok(integrity.checkRewriteMorphology(makeUnits("旧句。", "说明（）。").units).some(f => f.code === "empty_parentheses"));
  assert.deepEqual(integrity.checkRewriteMorphology(makeUnits("旧句。", "说明（先完成检查。再复诊）。").units), []);
});
await check("2.4", "重复炮制后缀及期望 rename 的新后缀被拦", () => {
  assert.ok(integrity.checkRewriteMorphology(makeUnits("当归。", "当归尾尾。").units).some(f => f.code === "repeated_processing_suffix"));
  const rule = { ...rename, expected: { ...rename.expected, from: "示例", to: "示例甲" } };
  assert.ok(integrity.checkRewriteMorphology(makeUnits("示例。", "示例甲甲。", rule).units).some(f => f.code === "repeated_processing_suffix"));
});
await check("2.5", "C062 同类中段残句去川芎，并以本方被拦", () => {
  assert.ok(integrity.checkRewriteMorphology(makeUnits("旧方义。", "去川芎，并以本方。").units).some(f => f.code === "unfinished_shell"));
});
await check("2.6", "悬空连词、截断边界、标签及来源孤句", () => {
  for (const text of ["说明，故。", "说明，。", "作用：", "（来源书名）。"]) assert.ok(integrity.checkRewriteMorphology(makeUnits("旧句。", text).units).length > 0, text);
});
await check("2.7", "不平衡括号引号有确定性 finding", () => {
  for (const text of ["说明（待复诊。", "说明“待复诊。", "说明）。"]) assert.ok(integrity.checkRewriteMorphology(makeUnits("旧句。", text).units).some(f => f.code === "unbalanced_delimiter"));
});
await check("2.8", "UTF-16/emoji 偏移及句号分号边界，不按逗号切", () => {
  const spans = sentences.localSentenceSpans("😀甲，乙。丙；丁");
  assert.equal(spans[0].end, 6); assert.equal(spans[0].text, "😀甲，乙。"); assert.equal(spans.length, 3);
});
await check("3.1", "复用一个已启动模型批次，语义改义整句删除", async () => {
  const { units } = makeUnits("旧句。", "本例结论改变。");
  const row = { fluent: true, onlyExpectedDelta: false, span: { start: 0, end: 2, text: "本例" }, reason: "meaning" };
  const column = integrity.buildRewriteIntegrityColumn(units); assert.equal(column.integrity.length, 1); assert.equal(column.integrity[0].expected.length, 1);
  const result = await integrity.checkRewriteIntegrity(units, { ...ctx, sharedBatch: modelBatch(units, row) }, signal());
  assert.equal(result.verdicts[0].status, "meaning_changed"); assert.equal(result.edits[0].expectedText, units[0].text); assert.equal(result.edits[0].replacement, "");
});
await check("3.2", "模型伪造 span、重复 id、解析错均 unknown", async () => {
  const { units } = makeUnits("旧句。", "新句。");
  const bad = { fluent: false, onlyExpectedDelta: true, span: { start: 0, end: 1, text: "伪造" } };
  const result = await integrity.checkRewriteIntegrity(units, { ...ctx, sharedBatch: modelBatch(units, bad) }, signal());
  assert.equal(result.verdicts[0].status, "unknown"); assert.equal(result.edits.length, 0);
  assert.equal(integrity.parseRewriteIntegrityColumn("invalid", units).invalidIds.length, 1);
  const row = { sentenceId: units[0].sentenceId, fluent: true, onlyExpectedDelta: true, reason: "" };
  assert.equal(integrity.parseRewriteIntegrityColumn({ integrity: [row, row] }, units).invalidIds.length, 1);
});
await check("3.3", "超时、中断、请求异常均 unknown，无误删", async () => {
  const { units } = makeUnits("旧句。", "新句。");
  for (const batch of [new Promise(() => {}), Promise.resolve(undefined)]) {
    const result = await integrity.checkRewriteIntegrity(units, { ...ctx, timeoutMs: 2, sharedBatch: batch }, signal());
    assert.equal(result.verdicts[0].status, "unknown"); assert.equal(result.edits.length, 0);
  }
  const abort = new AbortController(); abort.abort();
  const result = await integrity.checkRewriteIntegrity(units, { ...ctx, sharedBatch: modelBatch(units) }, abort.signal);
  assert.equal(result.verdicts[0].status, "unknown");
});
await check("3.4", "同厂商不计通过；独立完整结果才 pass", async () => {
  const { units } = makeUnits("旧句。", "新句。");
  const content = (await modelBatch(units)).content;
  const result = await integrity.checkRewriteIntegrity(units, { ...ctx, sharedBatch: Promise.resolve({ independent: false, content }) }, signal());
  assert.equal(result.verdicts[0].status, "unknown");
  const passed = await integrity.checkRewriteIntegrity(units, { ...ctx, sharedBatch: modelBatch(units) }, signal()); assert.equal(passed.verdicts[0].status, "pass");
});
await check("3.5", "原句只有明确通过终态约束且纯呈现变化才恢复", async () => {
  const { units } = makeUnits("原句完整。", "未诉未诉口苦。");
  const valid = await integrity.checkRewriteIntegrity(units, { ...ctx, validatedOriginal: () => true }, signal()); assert.equal(valid.edits[0].action, "restore");
  const missing = await integrity.checkRewriteIntegrity(units, ctx, signal()); assert.equal(missing.edits[0].action, "delete");
});
await check("3.6", "已删禁用药的 before、改名与未归类变化绝不恢复", async () => {
  const removed = { ...presentation, expected: { kind: "remove_unsupported", quote: "禁用药", decisionId: "deterministic-safety" } };
  for (const rule of [removed, rename, ledger.DELIVERY_REWRITE_RULES.formula]) {
    const { units } = makeUnits("原句含禁用药。", "未诉未诉口苦。", rule);
    const result = await integrity.checkRewriteIntegrity(units, { ...ctx, validatedOriginal: () => true }, signal()); assert.equal(result.edits[0].action, "delete"); assert.equal(result.edits[0].replacement, "");
  }
});
await check("3.7", "保护原文引文/安全字段不删不恢复，坏安全句交渲染器", async () => {
  const { units } = makeUnits("原文引文。", "未诉未诉口苦。", presentation, ["/diagnose/text"]);
  const result = await integrity.checkRewriteIntegrity(units, ctx, signal());
  assert.equal(result.edits.length, 0); assert.deepEqual(result.requiresSafetyRender, [units[0].sentenceId]); assert.equal(integrity.buildRewriteIntegrityColumn(units).integrity.length, 0);
});
await check("3.8", "删除留接续检查，不复活 tombstone；off 不检查", async () => {
  const { units } = makeUnits("禁用药。保留句。", "保留句。"); assert.equal(units.length, 1); assert.equal(units[0].deleted, true); assert.equal(units[0].next, "保留句。"); assert.equal(units[0].previous, undefined);
  const middle = makeUnits("前一。前二。删除句。后一。", "前一。前二。后一。").units;
  assert.equal(middle[0].previous, "前二。"); assert.equal(middle[0].next, "后一。");
  const result = await integrity.checkRewriteIntegrity(units, { ...ctx, sharedBatch: modelBatch(units, { fluent: false, reason: "join" }) }, signal()); assert.equal(result.edits.length, 0);
  const off = await integrity.checkRewriteIntegrity(makeUnits("旧句。", "未诉未诉。").units, { ...ctx, mode: "off" }, signal()); assert.deepEqual(off.verdicts, []);
});
await check("3.9", "药表、引文与安全机器字段默认保护", async () => {
  for (const path of ["/prescribe/formula/candidates/0/herbs/0/name", "/diagnose/pathogenesis/chain/0/patientFact", "/diagnose/safetyGate/reasonCode"]) assert.equal(ledger.deliveryPathProtected(path), true);
  const store = ledger.createRewriteLedger(ctx); store.snapshot("locked", { herbs: [{ name: "当归" }] }, { herbs: [{ name: "当归尾尾" }] }, rename);
  assert.equal(store.events[0].protected, true);
});
await check("3.10", "未归类改动及台账之后的 late writer 不伪装通过", async () => {
  const classified = makeUnits("旧句。", "新句。");
  const stale = sentences.changedSentenceUnits(classified.store.events, { payload: { text: "末端另写句。" } });
  const result = await integrity.checkRewriteIntegrity(stale, { ...ctx, sharedBatch: modelBatch(stale) }, signal()); assert.equal(result.verdicts[0].status, "unknown"); assert.equal(result.edits.length, 0);
  const { units } = makeUnits("旧句。", "新句。", ledger.DELIVERY_REWRITE_RULES.formula);
  const unclassified = await integrity.checkRewriteIntegrity(units, { ...ctx, sharedBatch: modelBatch(units) }, signal()); assert.equal(unclassified.verdicts[0].status, "unknown");
});
await check("3.11", "模糊半截句交小模型，拒绝句内补字建议", async () => {
  const { units } = makeUnits("旧句完整。", "这是未完成的");
  assert.deepEqual(integrity.checkRewriteMorphology(units), []);
  const result = await integrity.checkRewriteIntegrity(units, { ...ctx, sharedBatch: modelBatch(units, { fluent: false, span: { start: 0, end: 2, text: "这是" }, reason: "unfinished", suggestion: "不采信此补句" }) }, signal());
  assert.equal(result.verdicts[0].status, "malformed"); assert.equal(result.edits[0].replacement, ""); assert.equal(result.edits[0].end, units[0].text.length);
});
await check("4.1", "按最终句统计改坏关联，去重、unknown 与历史 null", () => {
  const { store, units } = makeUnits("旧句。", "新句。");
  const item = { caseId: "synthetic", events: store.events, sentences: units, verdicts: [{ sentenceId: units[0].sentenceId, status: "malformed" }] };
  const row = ledger.rewriteRuleStatistics([item, item]).ruleCounts[presentation.ruleId]; assert.equal(row.hits, 1); assert.equal(row.associatedBadSentences, 1); assert.equal(row.damageRate, 1);
  const unknown = ledger.rewriteRuleStatistics([{ ...item, verdicts: [] }]).ruleCounts[presentation.ruleId]; assert.equal(unknown.damageRate, null); assert.equal(unknown.unknownSentences, 1); assert.equal(unknown.coverageRate, 0);
  const settled = ledger.rewriteRuleStatistics([{ ...item, verdicts: [] }, item]).ruleCounts[presentation.ruleId]; assert.equal(settled.unknownSentences, 0);
  assert.equal(ledger.rewriteRuleStatistics(undefined).ruleCounts, null);
  const unbound = ledger.rewriteRuleStatistics([{ ...item, events: item.events.map(e => ({ ...e, observationOnly: true })), sentences: [] }]).ruleCounts[presentation.ruleId]; assert.equal(unbound.hits, null); assert.equal(unbound.unboundObservations, 1);
});
await check("4.2", "应用计划前校验全文指纹、逐字 span、重叠与陈旧偏移", () => {
  const { units } = makeUnits("旧句。", "😀新句。尾句。"); const unit = units[0];
  const edit = { ...unit, expectedText: unit.text, replacement: "" };
  assert.equal(sentences.applyIntegrityTextEdits("😀新句。尾句。", [edit]), "尾句。");
  assert.equal(sentences.applyIntegrityTextEdits("😀新句。尾变。", [edit]), undefined);
  assert.equal(sentences.applyIntegrityTextEdits("😀新句。尾句。", [edit, edit]), undefined);
  assert.equal(sentences.applyIntegrityTextEdits("😀新句。尾句。", [{ ...edit, expectedText: "伪造" }]), undefined);
});
await check("4.3", "纯模块无 Node/server-only 依赖，完整性模块不启动第三请求", () => {
  for (const name of ["delivery-rewrite-ledger", "delivery-rewrite-sentences", "delivery-gate-types"]) {
    const source = fs.readFileSync(`src/lib/${name}.ts`, "utf8"); assert.ok(!/from ["']node:|import ["']server-only/u.test(source));
  }
  const source = fs.readFileSync("src/lib/delivery-rewrite-integrity.server.ts", "utf8"); assert.ok(!/\b(?:crossModelJsonTask|primaryModelJsonTask|crossVendorConfirm|fetch)\s*\(/u.test(source));
});
await check("4.4", "一字段中改不同句的规则不会互相分摊坏句", () => {
  const store = ledger.createRewriteLedger(ctx); const other = { ...presentation, ruleId: "test.other" };
  store.text(presentation, { path: "/diagnose/text" }, "甲。乙。", "甲改。乙。");
  store.text(other, { path: "/diagnose/text" }, "甲改。乙。", "甲改。乙改。");
  const units = sentences.changedSentenceUnits(store.events, { payload: { text: "甲改。乙改。" } });
  assert.deepEqual(units[0].events.map(e => e.ruleId), [presentation.ruleId]); assert.deepEqual(units[1].events.map(e => e.ruleId), [other.ruleId]);
  const stats = ledger.rewriteRuleStatistics([{ caseId: "synthetic", events: store.events, sentences: units, verdicts: units.map((u, i) => ({ sentenceId: u.sentenceId, status: i ? "pass" : "malformed" })) }]);
  assert.equal(stats.ruleCounts[presentation.ruleId].associatedBadSentences, 1); assert.equal(stats.ruleCounts[other.ruleId].associatedBadSentences, 0);
});
console.log(JSON.stringify({ checks, failures }));
if (failures) process.exitCode = 1;
