// 第四十八轮 C2：合成片段；反证表 /var/tmp/r1065/cp/dxtext.py。无服务、无模型调用。
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { alias: { '@': `${process.cwd()}/src`, 'server-only': `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const surface = await jiti.import('../src/lib/delivered-surface.ts');
const therapy = await jiti.import('../src/lib/tcm-therapy-phrasing.ts');
const closure = await jiti.import('../src/lib/analysis-element-closure.ts');
const textbook = await jiti.import('../src/lib/tcm-textbook-syndromes.ts');
const criteria = await jiti.import('../src/lib/m03-secondary-syndrome-consistency.server.ts');
const element = await jiti.import('../src/lib/m03-element-support.server.ts');
const western = await jiti.import('../src/lib/recorded-test-claims.ts');
const recurrence = await jiti.import('../src/lib/western-recurrence-qualifier.ts');
let count = 0, failures = 0;
async function check(id, name, fn) {
  if (process.env.DXTEXT_ONLY && process.env.DXTEXT_ONLY !== id) return;
  count++;
  try { await fn(); console.log(`✓ ${id} ${name}`); }
  catch (error) { failures++; console.error(`✗ ${id} ${name}\n${error.stack || error}`); }
}
const E = { evidenceLevel: 'model_inference', source: '病例内推理', confidence: '中' };
const base = () => ({ schemaVersion: 'tcm-cdss-reasoning-v2', stage: 'diagnose', overview: { tcmDiseaseName: '胁痛', primarySyndrome: '肝郁气滞证', primarySyndromeBasis: ['右胁胀痛'], secondarySyndromes: [], tcmDiseaseDifferentials: [], tcmDifferentials: [], tcmDiagnosticRationale: '右胁胀痛，为肝气不舒。', overallPathogenesis: '肝气郁滞', evidence: E }, pathogenesis: { locationDifferentiation: { items: ['肝'], details: [{ location: '肝', basis: '右胁胀痛' }], resolution: 'resolved', evidence: E }, natureDifferentiation: { items: ['气滞'], rootDeficiency: [], branchExcess: ['气滞'], basis: '右胁胀痛', resolution: 'resolved', evidence: E }, chain: [{ nodeId: 'P1', patientFact: '右胁胀痛', pathogenesis: '肝气郁滞', therapyDirection: '疏肝理气', evidence: E }], uncertainties: [] }, therapy: { overallMethod: '疏肝理气', overallPrinciple: '实则泻之', subTherapies: [] }, westernDiagnosis: { primary: { name: '胆囊炎待查', clinicalRationale: '右胁痛，需进一步检查。', evidence: E }, differentials: [], candidates: [] } });
const project = (r, recordText = '主诉：右胁胀痛3日。', extra = {}) => surface.projectDeliveredReasoning(r, { recordText, ...extra });
await check('D01', '消脂同目的补项折叠；不同治法保留；反向顺序及幂等', () => {
  assert.equal(therapy.withoutRedundantTherapyPhrases('理气消脂，健脾消脂'), '理气消脂');
  assert.equal(therapy.withoutRedundantTherapyPhrases('健脾消脂，理气消脂'), '健脾消脂');
  assert.equal(therapy.withoutRedundantTherapyPhrases('理气消脂，健脾益气'), '理气消脂，健脾益气');
  assert.equal(therapy.therapyItemAlreadyCovered('健脾消脂', '理气消脂'), true);
});
await check('D02', '通络/通脉止痛同义折叠；温中与行气止痛不合并', () => {
  assert.equal(therapy.withoutRedundantTherapyPhrases('通络止痛，通脉止痛'), '通络止痛');
  assert.equal(therapy.withoutRedundantTherapyPhrases('温中止痛，行气止痛'), '温中止痛，行气止痛');
});
await check('D03', '同一降逆动作、通窍目的补项不重复，交付字段也收口', () => {
  for (const [input, expected] of [['降逆止呕，制酸降逆','降逆止呕'], ['养血通窍，化湿通窍','养血通窍']]) {
    assert.equal(therapy.withoutRedundantTherapyPhrases(input), expected);
    assert.equal(surface.clinicalMethodItems(input), expected);
    assert.equal(therapy.withoutRedundantTherapyPhrases(expected), expected);
  }
});
await check('D04', '只有两句或三句的重复、句尾与混用标点均折叠，非相邻句不删', () => {
  for (const input of ['未发现感染灶，未发现感染灶', '未发现感染灶，未发现感染灶，未发现感染灶。', '症状已缓解；未发现感染灶，未发现感染灶。']) {
    const output = surface.readabilityCleaned(input);
    assert.equal((output.match(/未发现感染灶/gu) || []).length, 1, output);
    assert.equal(surface.readabilityCleaned(output), output);
  }
  assert.equal(surface.readabilityCleaned('疼痛加重，休息后缓解，疼痛加重。'), '疼痛加重，休息后缓解，疼痛加重。');
  assert.equal(surface.readabilityCleaned('高，高'), '高，高');
});
await check('D05', '脱水问项读到皮肤弹性及尿量；只写其一仍待核实', () => {
  const row = { item: '有无脱水', reason: '未记录尿量及皮肤弹性细节', affects: '补液评估' };
  assert.equal(closure.uncertaintyWithRecordedAnswers(row, '皮肤弹性可。无尿少、口唇干裂。'), undefined);
  assert.deepEqual(closure.uncertaintyWithRecordedAnswers(row, '皮肤弹性可。'), { ...row, item: '尿量', reason: '尚需核实尿量' });
  assert.deepEqual(closure.uncertaintyWithRecordedAnswers(row, '皮肤弹性未记录，尿量不详。'), row);
});
await check('D06', '宽标题从理由读取异食缺项；未知不当已回答', () => {
  const row = { item: '饮食偏好细节', reason: '未记录嗜食异物与否', affects: '与虫积鉴别' };
  assert.equal(closure.uncertaintyWithRecordedAnswers(row, '患儿无异食癖。'), undefined);
  assert.deepEqual(closure.uncertaintyWithRecordedAnswers(row, '异食癖未询问。'), row);
});
await check('D07', '组合已答项只留下未答项，二便调已回答大便性状', () => {
  assert.equal(closure.uncertaintyAnsweredByRecord('疼痛性质', '关节酸痛。'), false, '新覆盖不改变轴判定使用的旧谓词');
  assert.deepEqual(closure.uncertaintyWithRecordedAnswers({ item: '有无泛酸嗳气', reason: '病历未记录' }, '无反酸烧心。'), { item: '嗳气', reason: '尚需核实嗳气' });
  assert.deepEqual(closure.uncertaintyWithRecordedAnswers({ item: '饮食二便', reason: '未记录食欲与二便' }, '神疲食少。'), { item: '二便', reason: '尚需核实二便' });
  const row = { item: '睡眠环境及作息细节', reason: '病历未记录睡眠环境、作息规律等细节' };
  assert.deepEqual(closure.uncertaintyWithRecordedAnswers(row, '生活起居规律。'), { ...row, item: '睡眠环境', reason: '尚需核实睡眠环境' });
  assert.equal(closure.uncertaintyWithRecordedAnswers({ item: '大便性状', reason: '未记录溏结' }, '发病以来二便调。'), undefined);
  const detail = { item: '大便性状细节', reason: '未记气味、有无灼热，寒热偏性不明' };
  assert.deepEqual(closure.uncertaintyWithRecordedAnswers(detail, '大便偏溏。'), detail, '一般性状不能回答气味、灼热细节');
  assert.equal(closure.uncertaintyWithRecordedAnswers({ item: '缺寒热喜恶与疼痛性质', reason: '寒湿兼夹待定' }, '天冷后加重，上下楼梯及久站后加重，休息后减轻。'), undefined);
});
await check('D08', '明确无口疮史才已答；既往体健不能替代口疮复发史', () => {
  const row = { item: '溃疡复发史', reason: '既往无口疮记录' };
  assert.equal(closure.uncertaintyWithRecordedAnswers(row, '既往无口疮。'), undefined);
  assert.deepEqual(closure.uncertaintyWithRecordedAnswers(row, '既往体健。'), row);
});
await check('D09', '女性不列男性生殖疾病，未知性别与共同病名不误删', () => {
  for (const name of ['精浊','精癃','慢性子痈']) {
    assert.equal(textbook.tcmDifferentialDiseaseFitsPatient(name, { sex: '女' }), false, name);
    assert.equal(textbook.tcmDifferentialDiseaseFitsPatient(name, { sex: '男' }), true, name);
    assert.equal(textbook.tcmDifferentialDiseaseFitsPatient(name), true, name);
  }
  assert.equal(textbook.tcmDifferentialDiseaseFitsPatient('淋证', { sex: '女' }), true);
  assert.equal(textbook.tcmDifferentialDiseaseFitsPatient('异位妊娠', { sex: '男' }), false);
});
await check('D10', '受损教材整段不交付，不猜箭头原字，正常定义保留', () => {
  assert.equal(textbook.textbookDefinitionSuitableForDisplay('喉病以声嘶为主，伴喉痒→干涩。'), false);
  assert.equal(textbook.textbookDefinitionSuitableForDisplay('喉病以声音嘶哑为主症。'), true);
  assert.equal(textbook.textbookDefinitionSuitableForDisplay('西医学认为该病……'), false);
});
await check('D11', '教材序号不进入已缓存的区分要点，临床数值不误删', () => {
  assert.equal(textbook.textbookDifferentialTextWithoutNumber('38.5℃时疼痛加重。'), '38.5℃时疼痛加重。');
  assert.equal(textbook.textbookDifferentialTextWithoutNumber('8.尿血与血淋相鉴别。'), '尿血与血淋相鉴别。');
  const r = base();r.overview.tcmDiseaseDifferentials = [{ diseaseName: '悬饮', reason: '主症相近', distinguishingPoints: '8. 胸胁疼痛，随呼吸加重。', typicalManifestation: '', nextCheck: null }, { diseaseName: '腹痛', reason: '部位邻近', distinguishingPoints: '体温38.5℃，疼痛在腹部。', typicalManifestation: '', nextCheck: null }];
  const out = project(r);
  assert.equal(out.overview.tcmDiseaseDifferentials[0].distinguishingPoints, '胸胁疼痛，随呼吸加重。');
  assert.equal(out.overview.tcmDiseaseDifferentials[1].distinguishingPoints, '体温38.5℃，疼痛在腹部。');
});
await check('D12', '扣掉主证共有表现不等于未见：保留已接地原文且不改变成组判定', () => {
  const entry = criteria.diagnosticsCriteriaFor('血虚证');
  const matches = [{ item: '面色淡白', quote: '面色白' }, { item: '舌色淡白', quote: '舌淡' }, { item: '脉细', quote: '脉细弱' }];
  const verdict = criteria.evaluateCriteriaMatches(entry, matches, { recordText: '面色白，舌淡，脉细弱。', primaryTerms: ['面色白','舌淡','脉细弱'], breadth: true });
  assert.equal(verdict.verdict, 'fail');
  assert.deepEqual(verdict.observedQuotes, ['面色白','舌淡','脉细弱']);
  assert.deepEqual(verdict.quotes, []);
  const denied = criteria.evaluateCriteriaMatches(entry, matches, { recordText: '无面色白，未见舌淡，否认脉细弱。', primaryTerms: [], breadth: true });
  assert.deepEqual(denied.observedQuotes, []);
});
await check('D13', '新生成的证素待核实不抄整组未见目录，已见共有表现如实保留', () => {
  const r = base();r.overview.primarySyndrome = '气滞证';r.pathogenesis.chain.push({ patientFact: '面色白', pathogenesis: '血虚失养', therapyDirection: '养血' });r.pathogenesis.natureDifferentiation.rootDeficiency = ['血虚'];r.pathogenesis.natureDifferentiation.items.push('血虚');
  const unit = element.elementCheckUnits(r).find(x => x.type === '血虚');assert.ok(unit);
  const verdict = { verdict: 'fail', entry: '血虚证', specific: 0, category: 0, listed: 0, distinct: 0, quotes: [], observedQuotes: ['面色白','舌淡','脉细弱'] };
  const out = JSON.parse(element.applyElementSupportDecision(JSON.stringify(r), { verdicts: [{ unit, verdict }] }, ''));
  const pending = out.pathogenesis.uncertainties.find(x => x.item === '是否兼血虚');assert.ok(pending);
  assert.match(pending.reason, /已记录面色白、舌淡、脉细弱/u);
  assert.doesNotMatch(pending.reason, /未见|辨证要点（/u);
});
await check('D14', '缓存证素说明重新投影，不把所见表现或性别不适用表现当缺项', () => {
  const row = { item: '是否兼肾气不固', reason: '本例虽见腰膝酸软，未见肾气不固的辨证要点（腰膝酸软、滑精、滑胎、带下量多清稀）成组出现' };
  const out = closure.uncertaintyWithRecordedAnswers(row, '腰膝酸软，带下量多清稀。');
  assert.match(out.reason, /已记录腰膝酸软/u);assert.doesNotMatch(out.reason, /未见|滑精|滑胎/u);
});
await check('D15', '撤回分句时连带无主语归属续句，保留有主体的新句', () => {
  assert.equal(criteria.withoutClauses('皮肤瘙痒为风邪。平时怕冷示气虚，为发病之内因；舌脉未记录。', ['平时怕冷示气虚']), '皮肤瘙痒为风邪。舌脉未记录。');
  assert.equal(criteria.withoutClauses('平时怕冷示气虚，舌红为热象。', ['平时怕冷示气虚']), '舌红为热象。');
});
await check('D16', '无复发证据时名和依据一并定稿；明确反复及未知病名作对照', () => {
  const out = western.settleWesternDiagnosisBasis('复发性阿弗他溃疡', '舌缘溃疡3天，无发热，符合复发性阿弗他溃疡，诊断依据为反复口腔溃疡病史。', '舌缘小溃疡3天。既往体健。');
  assert.equal(out.name, '口腔溃疡');assert.match(out.basis, /溃疡3天/u);assert.doesNotMatch(out.basis, /复发|反复/u);
  assert.equal(recurrence.settleWesternRecurrenceQualifier('复发性阿弗他溃疡', '', '口腔溃疡反复发作3年。').name, '复发性阿弗他溃疡');
  assert.equal(recurrence.settleWesternRecurrenceQualifier('复发性尿路感染待查', '', '既往无尿路感染，此次首次发作。').name, '尿路感染待查');
  assert.equal(western.settleWesternDiagnosisBasis('复发性尿路感染待查', '首次发作，需检查。', '既往无尿路感染。').name, '尿路感染待查');
  assert.equal(recurrence.settleWesternRecurrenceQualifier('复发性尿路感染待查', '', '尿频、尿急反复发作2年。').name, '复发性尿路感染待查');
  assert.equal(recurrence.settleWesternRecurrenceQualifier('慢性胃炎', '', '反复腹痛。').name, '慢性胃炎');
});
await check('D17', '不是同病复发或仅待核实不能支持限定词', () => {
  assert.match(recurrence.settleWesternRecurrenceQualifier('复发性阿弗他溃疡', '反复感冒，现舌缘溃疡3天，符合复发性阿弗他溃疡。', '舌缘溃疡3天。').basis, /反复感冒/u, '其它疾病的反复事实不能删掉');
  for (const text of ['反复感冒伴口腔溃疡3天。','反复感冒，现口腔溃疡3天。','口腔溃疡复发史不详。','否认口腔溃疡反复发作。','既往无口腔溃疡。','首次发作口腔溃疡。']) {
    assert.equal(recurrence.settleWesternRecurrenceQualifier('复发性阿弗他溃疡', '', text).name, '口腔溃疡', text);
  }
});
await check('D18', '交付接线过滤已答项、性别、复发名，保留输入且重放幂等', () => {
  const r = base();r.overview.tcmDiseaseDifferentials = [{ diseaseName: '精浊', reason: '尿频尿急', distinguishingPoints: '本例为女性', typicalManifestation: '', nextCheck: null }];r.pathogenesis.uncertainties = [{ item: '饮食偏好细节', reason: '未记录嗜食异物与否' }];r.westernDiagnosis.primary.name = '复发性阿弗他溃疡';r.westernDiagnosis.primary.clinicalRationale = '舌缘溃疡3天，无发热。';
  const snapshot = JSON.stringify(r), opts = { patientSex: '女' }, rec = '主诉：舌缘溃疡3天，既往体健。无异食癖。';
  const out = project(r, rec, opts);
  assert.equal(out.westernDiagnosis.primary.name, '口腔溃疡');
  assert.ok(out.overview.tcmDiseaseDifferentials.every(x => x.diseaseName !== '精浊'));
  assert.ok(out.pathogenesis.uncertainties.every(x => x.item !== '饮食偏好细节'));
  assert.equal(JSON.stringify(r), snapshot);
  assert.deepEqual(project(out, rec, opts), out);
});
await check('D19', '开方载荷沿用同一文字规则，不重算轴；已签只读投影保留结论', () => {
  const r = base();r.stage = 'prescribe';r.pathogenesis.uncertainties = [{ item: '饮食偏好细节', reason: '未记录嗜食异物与否' }];
  r.overview.tcmDiseaseDifferentials = [{ diseaseName: '精浊', reason: '尿频', distinguishingPoints: '不适用', typicalManifestation: '' }, { diseaseName: '喉痹', reason: '喉病', distinguishingPoints: '8. 喉痛', typicalManifestation: '喉痒→干涩' }];
  r.westernDiagnosis.primary.name = '复发性阿弗他溃疡';r.westernDiagnosis.primary.clinicalRationale = '舌缘溃疡3天，符合复发性阿弗他溃疡。';r.westernDiagnosis.primary.supportingFacts = [r.westernDiagnosis.primary.clinicalRationale];
  const rec = '舌缘溃疡3天。既往体健。无异食癖。', opts = { recordText: rec, patientSex: '女' };
  const out = surface.projectDeliveredReasoning(r, opts);
  assert.equal(out.westernDiagnosis.primary.name, '口腔溃疡');assert.doesNotMatch(out.westernDiagnosis.primary.supportingFacts.join(''), /复发性/u);
  assert.equal(out.pathogenesis.uncertainties.length, 0);assert.deepEqual(out.pathogenesis.natureDifferentiation, r.pathogenesis.natureDifferentiation);
  assert.equal(out.overview.tcmDiseaseDifferentials.length, 1);assert.equal(out.overview.tcmDiseaseDifferentials[0].typicalManifestation, '');assert.equal(out.overview.tcmDiseaseDifferentials[0].distinguishingPoints, '喉痛');
  assert.deepEqual(surface.projectDeliveredReasoning(out, opts), out);
  assert.equal(surface.projectDeliveredM03TcmDisplay(r, opts).westernDiagnosis.primary.name, '复发性阿弗他溃疡');
});
await check('D20', '组合题部分已答后不与已有细问重复，保留具体理由及原顺序', () => {
  const detail = { item: '二便', reason: '未记录排便频次和尿量', affects: '排泄细节' };
  const compound = { item: '口渴与二便', reason: '病历未记录', affects: '兼夹' };
  for (const rows of [[detail, compound], [compound, detail]]) {
    assert.deepEqual(closure.uncertaintiesWithRecordedAnswers(rows, '无口渴。'), [detail]);
  }
  const other = { item: '缺口渴与二便', reason: '边界待核实', affects: '兼夹' };
  const narrowed = closure.uncertaintiesWithRecordedAnswers([compound, other], '无口渴。');
  assert.equal(narrowed.length, 1);assert.equal(narrowed[0].item, '二便');
  const r = base();r.pathogenesis.uncertainties = [detail, compound];
  for (const stage of ['diagnose', 'prescribe']) {
    const out = project({ ...r, stage }, '无口渴。');
    assert.deepEqual(out.pathogenesis.uncertainties, [detail]);
  }
});
console.log(`\n${count} checks, ${failures} failures`);
if (failures) process.exitCode = 1;
