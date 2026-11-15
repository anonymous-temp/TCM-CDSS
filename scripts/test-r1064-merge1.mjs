// 第四十七轮 M1：两源合流后的用方状态与全部主要读者一致；合成病例。
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { alias: { '@': `${process.cwd()}/src`, 'server-only': `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const t = await jiti.import('../src/lib/tcm-textbook-syndromes.ts');
const s = await jiti.import('../src/lib/textbook-formula-stage.ts');
const p = await jiti.import('../src/lib/tcm-formula-provenance.ts');
const i = await jiti.import('../src/lib/tcm-formula-indications.ts');
let failures = 0, checks = 0;
async function check(id, label, fn) { checks++; try { await fn(); console.log(`✓ ${id} ${label}`); } catch (e) { failures++; console.error(`✗ ${id} ${label}\n${e.stack}`); } }
const row = t.textbookRowById('fuke|异位妊娠|气血亏脱证');
const pre = '停经后腹痛，面色苍白，尚未手术。';
const post = '本次已行输卵管切除术，病情稳定。';
const reasoning = (disease = row.disease, syndrome = row.syndromeName, direction = '四物汤加减') => ({ schemaVersion: 'tcm-cdss-reasoning-v2', stage: 'diagnose', overview: { tcmDiseaseName: disease, primarySyndrome: syndrome, primarySyndromeResolution: 'resolved', secondarySyndromes: [], recommendedFormulaDirection: direction, recommendedFormulaNames: [] }, therapy: { overallMethod: '益气止血固脱' } });
await check('1.1', '同一行保留结构化出处和 KD 原文，术前替代方与旧接口同源', () => {
  assert.equal(row.precondition.kind, 'post_surgery'); assert.match(row.preconditionNotice, /术后再辅以/);
  assert.match(row.formulaStage, /手术止血后/); assert.ok(row.evidence.length);
  const use = s.evaluateTextbookFormulaUse(row, pre);
  assert.deepEqual(use.formulas, ['参附汤', '生脉散']); assert.deepEqual(use.representativeFormulas, []);
  assert.deepEqual(t.textbookTreatmentRow(row, pre), use.row);
  assert.deepEqual(t.textbookPendingPrecondition(row, pre), use.pendingPrecondition);
  assert.equal(s.textbookFormulaStageNotice(row, pre), use.notice);
  assert.deepEqual(s.currentTextbookFormulas(row, pre), use.representativeFormulas);
});
await check('1.2', '结构化操作证据优于宽泛术后；附加阶段和停药条件仍生效', () => {
  for (const record of ['拟行输卵管切除术，术后再复查。', '同事已行手术止血，术后良好。', '既往已行手术止血，术后良好。', '本次已行阑尾切除手术']) assert.deepEqual(s.evaluateTextbookFormulaUse(row, record).representativeFormulas, [], record);
  assert.deepEqual(s.evaluateTextbookFormulaUse(row, post).formulas, ['四物汤']);
  assert.deepEqual(s.evaluateTextbookFormulaUse(row, '本次已手术').formulas, ['四物汤']);
  const additional = { ...row, runtimePolicy: { ...row.runtimePolicy, requireAll: [...row.runtimePolicy.requireAll, ['已苏醒']] } };
  assert.deepEqual(s.evaluateTextbookFormulaUse(additional, post).formulas, []);
  assert.deepEqual(s.evaluateTextbookFormulaUse(additional, `${post}已苏醒。`).formulas, ['四物汤']);
  const stopped = { ...row, runtimePolicy: { ...row.runtimePolicy, stopIfAny: ['阳回脱止'] } };
  assert.deepEqual(s.evaluateTextbookFormulaUse(stopped, `${pre}阳回脱止。`).formulas, []);
});
await check('1.3', '替代方按同一安全回调和已签名方选择，覆盖校验不误删独参汤', () => {
  const use = s.evaluateTextbookFormulaUse(row, pre, { barredHerb: herb => herb.includes('附子') });
  assert.deepEqual(use.formulas, ['独参汤']); assert.equal(use.pendingPrecondition.fallback.line, 123654);
  assert.deepEqual(s.evaluateTextbookFormulaUse(row, pre, { barredHerb: () => true }).formulas, []);
  assert.deepEqual(s.evaluateTextbookFormulaUse(row, pre, { formulaNames: [] }).formulas, []);
  assert.deepEqual(s.evaluateTextbookFormulaUse(row, pre, { formulaNames: ['独参汤'] }).formulas, ['独参汤']);
  assert.equal(i.formulaCoversDiseaseOrComplaint(reasoning(), '独参汤', pre), true);
  assert.equal(i.formulaCoversDiseaseOrComplaint(reasoning(), '四物汤', pre), false);
  assert.equal(i.formulaCoversDiseaseOrComplaint(reasoning(), '四物汤', post), true);
});
await check('1.4', 'M03 传统锚定与两步选方同向且幂等，已完成手术才返回术后方', () => {
  for (const [record, barredHerb, names] of [[pre, undefined, ['参附汤', '生脉散']], [pre, h => h.includes('附子'), ['独参汤']], [post, undefined, ['四物汤']]]) {
    const safety = barredHerb ? { barredHerb, activeBleeding: false } : undefined;
    const old = p.withDeterministicFormulaReferences(reasoning(), record, undefined, safety);
    assert.deepEqual(old.overview.recommendedFormulaNames, names);
    const input = { disease: row.disease, syndrome: row.syndromeName, direction: '四物汤加减', textbookRowId: row.id, keepDirection: true, clinicalSourceText: record, caseSafety: safety };
    const next = p.selectM03TcmFormulaIdentity(input);
    assert.deepEqual(next.formulaLock.names, names);
    assert.deepEqual(p.selectM03TcmFormulaIdentity({ ...input, direction: next.direction }), next);
    if (record === pre) { assert.match(next.direction, /手术止血/); assert.ok(!next.direction.includes('四物汤')); }
  }
});
await check('1.5', '候选和 M04 教材块使用当前配合方向，不注入术后组成', () => {
  const block = t.buildTextbookFormulaContext(row.disease, row.syndromeName, { recordText: pre, formulaNames: ['独参汤'] });
  assert.match(block, /candidate.name 可用“独参汤加减”/); assert.ok(!block.includes('四物汤'));
  const context = t.buildTextbookCandidateContext({ preferredDiseases: [row.disease], chiefComplaint: '停经后腹痛', presentHistory: pre, recordText: pre, sex: '女', ageYears: 28 });
  const line = context.split('\n').find(line => line.includes('气血亏脱证｜'));
  assert.ok(line); assert.match(line, /当前参考方：参附汤合生脉散/); assert.ok(!line.includes('四物汤'));
});
await check('1.6', '先后方仅给当前阶段，M03/M04/正向关系与停药结果一致', () => {
  for (const [record, names] of [['', ['独参汤']], ['出血已止，病情稳定，症状缓解。', ['人参养荣汤']]]) {
    const blood = t.textbookRowById('neike|厥证|虚证|血厥');
    const r = reasoning(blood.disease, blood.syndromeName, '独参汤合人参养荣汤');
    assert.deepEqual(s.evaluateTextbookFormulaUse(blood, record).formulas, names);
    assert.deepEqual([...i.textbookRelationFormulaIdentityNames(r, ['独参汤', '人参养荣汤'], record)], names);
    assert.deepEqual(p.withDeterministicFormulaReferences(r, record).overview.recommendedFormulaNames, names);
    assert.match(t.buildTextbookFormulaContext(blood.disease, blood.syndromeName, { recordText: record }), /不得作合方/);
  }
  assert.deepEqual(s.evaluateTextbookFormulaUse(t.textbookRowById('wenbing|春温|阳气暴脱'), '阳回脱止，手足转温。').formulas, []);
  assert.equal(i.formulaCoversDiseaseOrComplaint(reasoning('厥证', '复合证'), '四味回阳饮', '尚未苏醒。'), false);
  assert.equal(i.formulaCoversDiseaseOrComplaint(reasoning('厥证', '复合证'), '四味回阳饮', '已苏醒。'), true);
});
await check('1.7', '签名教材身份例外必须满足当前阶段，不因旧方向恢复术后方', () => {
  const r = reasoning(); r.overview.formulaSelectionMode = 'self_devised';
  const candidate = { formulaNames: ['四物汤'], herbs: row.composition.map(name => ({ name })) };
  assert.equal(p.isSignedTextbookFormulaIdentity(candidate, r, pre), false);
  assert.equal(p.isSignedTextbookFormulaIdentity(candidate, r, post), true);
  assert.deepEqual([...i.textbookRelationFormulaIdentityNames(r, ['四物汤'], pre)], []);
  assert.deepEqual([...i.textbookRelationFormulaIdentityNames(r, ['四物汤'], post)], ['四物汤']);
});
await check('1.8', 'M03 两步重复投影沿用已定红旗状态，不误删治则也不新增红旗', async () => {
  const { fixture, fakeIO } = await import('./fixtures/m03-tcm-two-pass/synthetic.mjs');
  const two = await jiti.import('../src/lib/m03-tcm-two-pass.server.ts');
  for (const redFlag of [true, false]) {
    const data = fixture(); data.ctx.safety.redFlag = redFlag;
    const result = await two.runM03TcmTwoPass(data.ctx, fakeIO(data), { enabled: true });
    assert.ok(['ready', 'bounded'].includes(result.kind), JSON.stringify(result));
    assert.equal(result.half.therapy.overallPrinciple.includes('急则治标'), redFlag);
    assert.equal(data.ctx.safety.redFlag, redFlag);
  }
});
console.log(JSON.stringify({ suite: 'r1064-merge1', checks, failures }));
if (failures) process.exitCode = 1;
