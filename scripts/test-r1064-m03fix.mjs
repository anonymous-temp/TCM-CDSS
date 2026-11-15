// S2fix: synthetic archive replay only; no credentials, network or live model.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createJiti } from 'jiti';
import { fixture, fakeIO } from './fixtures/m03-tcm-two-pass/synthetic.mjs';
const jiti = createJiti(import.meta.url, { alias: { '@': `${process.cwd()}/src`, 'server-only': `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const facts = await jiti.import('../src/lib/m03-tcm-facts.server.ts');
const runtime = await jiti.import('../src/lib/m03-tcm-runtime.server.ts');
const c = await jiti.import('../src/lib/m03-tcm-conclusion.ts');
const checks = await jiti.import('../src/lib/m03-tcm-conclusion-checks.server.ts');
const adapters = await jiti.import('../src/lib/m03-tcm-check-adapters.server.ts');
const format = await jiti.import('../src/lib/model-response-format.ts');
const policy = await jiti.import('../src/lib/m03-tcm-policy.ts');
const two = await jiti.import('../src/lib/m03-tcm-two-pass.server.ts');
const archive = JSON.parse(readFileSync(new URL('./fixtures/m03-tcm-two-pass/archived-synthetic-first-pass.json', import.meta.url), 'utf8'));
const budget = () => [new AbortController().signal, Date.now() + 10000];
const safety = { activeBleeding: false, barredHerb: () => false };
let count = 0, failed = 0;
async function check(id, title, fn) {
  if (process.env.M03FIX_CHECK && process.env.M03FIX_CHECK !== id) return;
  count++;
  try { await fn(); console.log(`✓ ${id} ${title}`); }
  catch (error) { failed++; console.error(`✗ ${id} ${title}\n${error.stack || error}`); }
}
function state(text) { return { chiefComplaint: '腹胀两周', symptoms: { 现病史: text }, tongue: '舌淡红，苔薄白', pulse: '脉和缓' }; }
const byText = (list, text) => { const found = list.find(item => item.text === text); assert.ok(found, text); return found; };
await check('F01', '分栏逐句保留当前表现及UTF-16来源，重复结构字段不抹空', () => {
  const input = state('近两周饭后腹胀，神疲乏力，便溏。');
  input.symptoms.体格检查 = input.symptoms.现病史;
  const out = facts.deterministicM03TcmFacts(input);
  assert.equal(byText(out, '神疲乏力').polarity, 'affirmed');
  assert.equal(byText(out, '便溏').scope, 'current');
  assert.equal(byText(out, '近两周饭后腹胀').observation, 'abnormal');
  assert.equal(out.filter(row => row.text === '神疲乏力').length, 1);
  assert.equal(byText(out, '神疲乏力').fieldPath, '/symptoms/现病史#8');
});
await check('F02', '否认及并列否认不翻阳；已知正常结束否认串', () => {
  const out = facts.deterministicM03TcmFacts(state('否认呕血、黑便，无腹痛，食欲尚可，神疲乏力。'));
  assert.equal(byText(out, '否认呕血、黑便').polarity, 'denied');
  assert.equal(byText(out, '无腹痛').polarity, 'denied');
  assert.equal(byText(out, '神疲乏力').polarity, 'affirmed');
});
await check('F03', '本人/时态/条件复用既有读法，当前句不受历史字段污染', () => {
  const input = state('父亲有胃癌。若出现黑便应就诊。去年出现腹痛，目前饭后腹胀。');
  input.symptoms.既往史 = '曾患胃溃疡';
  const out = facts.deterministicM03TcmFacts(input);
  assert.equal(byText(out, '父亲有胃癌').scope, 'other');
  assert.equal(byText(out, '若出现黑便应就诊').polarity, 'unknown');
  assert.equal(byText(out, '去年出现腹痛').scope, 'history');
  assert.equal(byText(out, '目前饭后腹胀').scope, 'current');
  assert.equal(byText(out, '曾患胃溃疡').scope, 'history');
});
await check('F04', '正常舌脉不作病性依据，unknown不升级阳性', () => {
  const out = facts.deterministicM03TcmFacts(state('说不清有无腹痛。'));
  for (const text of ['舌淡红', '苔薄白', '脉和缓']) assert.equal(byText(out, text).observation, 'normal');
  assert.equal(byText(out, '说不清有无腹痛').polarity, 'unknown');
});
const contexts = new Map();
async function archivedContext(row) {
  if (contexts.has(row.key)) return contexts.get(row.key);
  const name = JSON.parse(row.content).disease.name;
  const ctx = await runtime.prepareM03TcmRuntimeFacts(runtime.buildM03TcmRuntimeContext(row.caseState, [name], JSON.stringify(row.caseState.symptoms)), row.caseState, ...budget());
  contexts.set(row.key, ctx); return ctx;
}
await check('F05', '三个合成病例无需事实模型且教材病位/证素/主证候选均非空', async () => {
  const fetch = globalThis.fetch; globalThis.fetch = () => { throw Error('network prohibited'); };
  try {
    for (const row of archive.slice(0, 3)) {
      const ctx = await archivedContext(row);
      assert.ok(ctx.facts.length >= 15, row.key);
      assert.ok(ctx.units.length > 0 && ctx.syndromes.length > 0 && ctx.methods.length > 0, row.key);
      assert.ok(ctx.findingsChecklist.length >= 5, row.key);
    }
  } finally { globalThis.fetch = fetch; }
});
await check('F06', '精确名称映射编号、坏项局部丢弃且记违规，核心保留', () => {
  const d = fixture(), violations = [];
  d.proposal.locations[0].id = '脾'; d.proposal.elements.root[0].id = '气虚';
  d.proposal.elements.root.push({ id: '虚构', quotes: [0], criteria: ['虚构'] });
  d.proposal.methods.push({ text: '虚构方法', targets: ['气虚'], quotes: [0] });
  d.proposal.secondary = ['未知证']; d.proposal.lineage = { applicable: 'partial', targets: ['E1'] };
  d.proposal.locations[0].criteria.push('自由说明');
  const out = c.parseM03TcmProposal(d.proposal, d.ctx, violations);
  assert.equal(out.locations[0].id, 'L1'); assert.equal(out.elements.root[0].id, 'E1');
  assert.equal(out.elements.root.length, 1); assert.equal(out.methods.length, 1);
  assert.deepEqual(out.secondary, []); assert.equal(out.lineage, null);
  assert.ok(violations.includes('unit_out_of_set') && violations.includes('criteria_out_of_set') && violations.includes('unit_name_mapped'));
});
await check('F07', '核心缺失不能编造：病名作主证、无引文、未知病名及安全键均拒绝', () => {
  for (const mutate of [x => x.primary = '虚劳', x => x.disease.name = '未知病', x => x.quotePool = [], x => x.allowDose = true]) {
    const d = fixture(); mutate(d.proposal); assert.throws(() => c.parseM03TcmProposal(d.proposal, d.ctx));
  }
});
await check('F08', '重复引文归并且索引重排，来源冲突仍拒绝接地', () => {
  const d = fixture(); d.proposal.quotePool.push({ quote: '纳少', sourceHint: '任意' }); d.proposal.locations[0].quotes = [5];
  const out = c.parseM03TcmProposal(d.proposal, d.ctx);
  assert.equal(out.quotePool.length, 5); assert.deepEqual(out.locations[0].quotes, [0]);
  d.ctx.facts.push({ ...d.ctx.facts[0], scope: 'other', fieldPath: 'other' });
  assert.ok(!c.locateM03TcmQuotes(out, d.ctx).some(row => row.id === 'Q1'));
});
await check('F09', '候选编号明列、占位示例、DeepSeek系统schema及真实传输接线', () => {
  const prompt = c.buildM03TcmConclusionPrompt(fixture().ctx);
  for (const key of ['locationIds', 'rootIds', 'branchIds', 'syndromeNames', '<候选病名>']) assert.ok(prompt.includes(key));
  assert.ok(prompt.includes('病名不可充当证名'));
  const catalog = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"candidateIds"'))).candidateIds;
  assert.deepEqual(catalog.syndromeNames, fixture().ctx.syndromes.map(item => item.name));
  const system = format.structuredOutputSchemaInstruction('deepseek-flash', 'm03_tcm_conclusion');
  assert.match(system, /quotePool/); assert.match(system, /lineage/);
  const api = readFileSync('src/lib/diagnosis-api.ts', 'utf8');
  const transport = api.slice(api.indexOf('async function requestStructuredCompletion('), api.indexOf('export async function sampleQuestionPlanOnce'));
  assert.ok(transport.includes('explicitPromptCacheMessages(structuredSystemPrompt(kind, model, task)'));
});
await check('F10', '传输不抢先整份拒绝可恢复项，缺lineage进入解析后补null', async () => {
  const d = fixture(); delete d.proposal.lineage; d.proposal.locations.push({ broken: true }); let calls = 0;
  const complete = runtime.createM03TcmTaskCompletion('primary', async () => { calls++; return { ok: true, content: JSON.stringify(d.proposal), finishReason: 'stop' }; }, () => 'fallback');
  const result = await complete({ task: 'm03_tcm_conclusion', prompt: '', schema: c.M03_TCM_CONCLUSION_PROVIDER_SCHEMA, maxTokens: 1000, signal: budget()[0], absoluteDeadline: Date.now() + 1000 });
  const parsed = c.parseM03TcmProposal(result.value, d.ctx);
  assert.equal(calls, 1); assert.equal(parsed.lineage, null); assert.equal(parsed.locations.length, 1);
});
function batchReply(request) {
  const input = JSON.parse(request.prompt.split('\n').at(-1));
  return { units: input.units.map(unit => ({ id: unit.id, status: 'matched', matches: unit.candidate.criteriaIds.map((item, i) => ({ item, quoteId: `Q${unit.quotes[Math.min(i, unit.quotes.length - 1)] + 1}` })) })),
    diseases: ['visit_reason', 'history', 'disease_points'].map(checker => ({ checker, status: 'pass', replacement: null, quoteIds: ['Q1'] })),
    methods: [{ id: 'M1', status: 'pass' }], lineage: { status: 'pass' } };
}
await check('F11', '同份结论四类核对合并两家并行、相同输入复用且不跨revision', async () => {
  const d = fixture(); d.ctx.lineage = { code: 'synthetic', label: 'synthetic', targets: ['E1'], safetyDeference: '', unaffectedBySafety: [] }; d.proposal.lineage = { applicable: 'partial', targets: ['E1'] };
  const seen = []; let release;
  const latch = new Promise(resolve => { release = resolve; });
  const io = adapters.createM03TcmConclusionModelChecks({ completeCheck: async request => {
    seen.push(request); if (seen.length === 2) release();
    await latch; return { value: batchReply(request), finishReason: 'stop' };
  } }, safety);
  const out = await checks.checkM03TcmConclusion(d.proposal, d.ctx, io, ...budget());
  assert.ok(['ready', 'bounded'].includes(out.kind), JSON.stringify(out)); assert.equal(seen.length, 2);
  assert.equal(seen[0].prompt, seen[1].prompt); assert.deepEqual(seen.map(item => item.phase).sort(), ['propose', 'verify']);
  await checks.checkM03TcmConclusion(d.proposal, d.ctx, io, ...budget()); assert.equal(seen.length, 2);
  await checks.checkM03TcmConclusion(d.proposal, d.ctx, io, ...budget(), 2); assert.equal(seen.length, 4);
});
await check('F12', '双家分歧/重复/截断不当通过，逐项坏项不抹掉有效邻项', async () => {
  for (const mode of ['disagree', 'duplicate', 'truncated']) {
    const d = fixture();
    const io = adapters.createM03TcmConclusionModelChecks({ completeCheck: async request => {
      const value = batchReply(request); value.units.push({ broken: true });
      if (request.phase === 'verify') {
        if (mode === 'disagree') value.methods[0].status = 'fail';
        if (mode === 'duplicate') value.methods.push(value.methods[0]);
      }
      return { value, finishReason: mode === 'truncated' && request.phase === 'verify' ? 'length' : 'stop' };
    } }, safety);
    const result = await checks.checkM03TcmConclusion(d.proposal, d.ctx, io, ...budget());
    assert.equal(result.kind, 'unusable', mode);
  }
});
await check('F13', '自由criteria不作为权威，后续两家可对候选原条目重新匹配', async () => {
  const d = fixture(); d.proposal.elements.root[0].criteria = ['自由描述'];
  const io = adapters.createM03TcmConclusionModelChecks({ completeCheck: async request => ({ value: batchReply(request), finishReason: 'stop' }) }, safety);
  const out = await checks.checkM03TcmConclusion(d.proposal, d.ctx, io, ...budget());
  assert.ok(['ready', 'bounded'].includes(out.kind), JSON.stringify(out));
  assert.equal(out.record.root[0].strict, true); assert.ok(out.reasons.includes('criteria_out_of_set'));
});
await check('F14', '双家单位证据取交集，单方多认证据不得穿过严格计数', async () => {
  const d = fixture();
  const io = adapters.createM03TcmConclusionModelChecks({ completeCheck: async request => {
    const value = batchReply(request);
    if (request.phase === 'verify') value.units.find(unit => unit.id === 'E1').matches = [];
    return { value, finishReason: 'stop' };
  } }, safety);
  const out = await checks.checkM03TcmConclusion(d.proposal, d.ctx, io, ...budget());
  assert.ok(out.kind === 'unusable' || out.record.root.length === 0);
});
await check('F15', '原始存档假IO逐字回放：可恢复项通过，病名冒充主证不能伪造3/3成功', async () => {
  const results = [];
  for (const row of archive) {
    const ctx = await archivedContext(row); const violations = []; let accepted = false, reason;
    const complete = runtime.createM03TcmTaskCompletion(row.model, async () => ({ ok: true, content: row.content, finishReason: 'stop' }), () => undefined);
    const result = await complete({ task: 'm03_tcm_conclusion', prompt: c.buildM03TcmConclusionPrompt(ctx), schema: c.M03_TCM_CONCLUSION_PROVIDER_SCHEMA, maxTokens: 1000, signal: budget()[0], absoluteDeadline: Date.now() + 10000 });
    try { c.parseM03TcmProposal(result.value, ctx, violations); accepted = true; } catch (error) { reason = error.message; }
    results.push({ file: row.file, key: row.key, accepted, reason, violations, facts: ctx.facts.length, units: ctx.units.length, syndromes: ctx.syndromes.length });
    assert.equal(accepted, row.key === 'q07', JSON.stringify(results.at(-1)));
    if (row.key !== 'q07') assert.equal(reason, 'syndrome_out_of_set');
  }
  console.log(JSON.stringify({ archivedReplay: results }));
  if (process.env.M03FIX_REPLAY_REPORT) writeFileSync(process.env.M03FIX_REPLAY_REPORT, JSON.stringify(results, null, 2) + '\n');
});
await check('F16', '缓存策略升级；两步合成正常路径仍可冻结、写文和交付', async () => {
  assert.equal(policy.m03TcmTwoPassPolicy({}).version, 'm03-tcm-two-pass-v2');
  const d = fixture(), io = fakeIO(d);
  const out = await two.runM03TcmTwoPass(d.ctx, io, { enabled: true });
  assert.equal(out.kind, 'ready'); assert.equal(io.calls.length, 2);
});
await check('F17', '候选按受治理最长词项提名，不把定义关联图误作必备病位病性', () => {
  assert.deepEqual(runtime.nominateM03TcmAxes('脾胃虚寒证'), { locationIds: ['spleen', 'stomach'], elementIds: ['yang_deficiency'] });
  assert.deepEqual(runtime.nominateM03TcmAxes('阳虚秘').elementIds, ['yang_deficiency']);
  assert.deepEqual(runtime.nominateM03TcmAxes('肺经风热证').locationIds, ['lung']);
  assert.deepEqual(runtime.nominateM03TcmAxes('寒邪客胃证').elementIds, ['cold']);
  assert.deepEqual(runtime.nominateM03TcmAxes('未知病机').elementIds, []);
});
await check('F18', '文字首核包含最终投影；未变化的成品只核一次，发生变化必须重核', async () => {
  const d = fixture(), io = fakeIO(d); let calls = 0;
  const original = io.checkFacts;
  io.checkFacts = async (...args) => { calls++; assert.ok(args[0].projected); return original(...args); };
  assert.equal((await two.runM03TcmTwoPass(d.ctx, io, { enabled: true })).kind, 'ready');
  assert.equal(calls, 1);
  const changed = fixture(); changed.narrative.rationale.push(changed.sentence('extra', '本例无据文字。'));
  let checked = 0;
  const altered = fakeIO(changed, { checkFacts: async input => {
    checked++;
    return { inputHash: input.inputHash, baseRevision: input.baseRevision, conclusionHash: input.conclusionHash,
      status: input.sentences.some(slot => slot.sentence.id === 'extra') ? 'fail' : 'pass',
      violations: input.sentences.some(slot => slot.sentence.id === 'extra') ? [{ code: 'unsupported', sentenceIds: ['extra'], nodeIds: [], expectedUnitIds: ['E1'], recordQuoteIds: [], detail: '' }] : [] };
  } });
  const out = await two.runM03TcmTwoPass(changed.ctx, altered, { enabled: true });
  assert.ok(checked >= 2); assert.ok(!out.tcmRaw.includes('本例无据文字'));
});
console.log(`${count - failed}/${count} checks passed`);
if (failed) process.exitCode = 1;
