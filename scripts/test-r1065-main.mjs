// 第四十八轮主会话：主症加强行的保留口径。合成夹具，不复制甲方病历。
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { alias: { '@': `${process.cwd()}/src`, 'server-only': `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const compiler = await jiti.import('../src/lib/m04-proposal-compiler.ts');
const safety = await jiti.import('../src/lib/diagnosis-safety.ts');
let failed = 0;
const check = async (id, title, run) => { if (process.env.R1065_ONLY && process.env.R1065_ONLY !== id) return; try { await run(); console.log(`✓ ${id} ${title}`); } catch (e) { failed++; console.error(`✗ ${id} ${title}\n${e.stack}`); } };
const state = { patient: { age: 45, sex: '女' }, chiefComplaint: '头胀1周', symptoms: { 现病史: '头胀1周，后枕部发紧，口苦。' } };
const prior = { overview: { tcmDiseaseName: '眩晕', primarySyndrome: '肝阳上亢证' } };
const ctx = { prior, caseState: state, recordText: safety.clinicalGroundingText(state) };
await check('1.1', '普通条件不足两项时保留一条本例已见主症的加强行', () => {
  const rows = [{ trigger: '本例已见后枕部发紧', herbName: '葛根' }, { trigger: '本例已见头胀', herbName: '菊花' }, { trigger: '头胀明显', herbName: '钩藤' }];
  const kept = compiler.retainModificationFindings(rows, ctx);
  assert.deepEqual(kept.map((row) => row.herbName), ['葛根', '菊花']);
});
await check('1.2', '普通条件已足两项时不保留主症行；主症未见于病历时不保留', () => {
  const full = [{ trigger: '本例已见后枕部发紧', herbName: '葛根' }, { trigger: '本例已见口苦', herbName: '龙胆' }, { trigger: '本例已见头胀', herbName: '菊花' }];
  assert.deepEqual(compiler.retainModificationFindings(full, ctx).map((row) => row.herbName), ['葛根', '龙胆']);
  const other = { ...ctx, caseState: { ...state, chiefComplaint: '眩晕1周', symptoms: { 现病史: '眩晕1周，口苦。' } } };
  other.recordText = safety.clinicalGroundingText(other.caseState);
  assert.equal(compiler.modificationTriggerNotFinding('本例已见头胀', other) === 'main_symptom' && compiler.retainModificationFindings([{ trigger: '本例已见头胀', herbName: '菊花' }], other).length > 0, false);
});
await check('1.3', '红旗病例的危重征象不因主症口径放行', () => {
  const red = { ...state, chiefComplaint: '胸痛2小时', symptoms: { 现病史: '胸痛2小时，大汗淋漓。' }, safetyGate: { status: 'red_flag', redFlags: ['持续胸痛伴大汗，原文依据：“胸痛2小时，大汗淋漓”'] } };
  const rc = { prior: { overview: { tcmDiseaseName: '真心痛', primarySyndrome: '心阳欲脱证' } }, caseState: red, recordText: safety.clinicalGroundingText(red) };
  assert.equal(compiler.retainModificationFindings([{ trigger: '本例已见胸痛', herbName: '丹参' }], rc).length, 0);
});
const textbook = await jiti.import('../src/lib/tcm-textbook-syndromes.ts');
await check('2.1', '只有网页转录依据的教材补充行不作出处；本机语料行照常', () => {
  const web = textbook.textbookRowForSyndrome('耳胀耳闭', '气血瘀阻证');
  assert.ok(web, '耳胀耳闭·气血瘀阻证应可检索');
  assert.equal(textbook.textbookRowCitable(web), false);
  assert.equal(textbook.textbookProvenanceVerified(textbook.textbookRowProvenance(web)), false);
  const local = textbook.textbookRowForSyndrome('耳胀耳闭', '风邪袭耳证') || textbook.textbookRowForSyndrome('心悸', '心虚胆怯证');
  assert.equal(textbook.textbookRowCitable(local), true);
  assert.equal(textbook.textbookProvenanceVerified(textbook.textbookRowProvenance(local)), true);
  const match = textbook.textbookModificationMatch('耳胀耳闭', '气血瘀阻证', '耳鸣', undefined);
  if (match) assert.equal(textbook.textbookRowCitable(match), false);
});
const commentary = await jiti.import('../src/lib/formula-textbook-commentary.ts');
await check('3.1', '方解定的君药与药表比对去掉剂型后缀（滑石粉=滑石），不去生熟', () => {
  assert.equal(commentary.textbookNamesTheseAsEmperors('甘露消毒丹', ['滑石粉', '黄芩', '茵陈']), commentary.textbookNamesTheseAsEmperors('甘露消毒丹', ['滑石', '黄芩', '茵陈']));
  assert.equal(commentary.textbookNamesTheseAsEmperors('甘露消毒丹', ['滑石', '黄芩', '茵陈']), true);
  assert.equal(commentary.textbookNamesTheseAsEmperors('甘露消毒丹', ['滑石粉', '黄芩', '连翘']), false);
});
const claims = await jiti.import('../src/lib/recorded-test-claims.ts');
await check('4.1', '可凭临床诊断的病跟着依据句的明确表态：须先排除/需专科确立/暂按此考虑 → 待查；单纯尚缺某检查不算', () => {
  const rec = '主诉：右足第一跖趾关节红肿热痛1天\n辅助检查：血尿酸560μmol/L，WBC 16.8';
  assert.equal(claims.settleWesternDiagnosisBasis('急性痛风性关节炎', '单关节夜间突发红肿热痛，需先排除化脓性关节炎与脓毒症。', rec).name, '急性痛风性关节炎待查');
  assert.equal(claims.settleWesternDiagnosisBasis('急性痛风性关节炎', '单关节夜间突发红肿热痛，血尿酸560，符合急性痛风性关节炎。', rec).name, '急性痛风性关节炎');
  assert.equal(claims.settleWesternDiagnosisBasis('急性上呼吸道感染待查', '鼻塞流涕咽痛，符合急性上呼吸道感染；尚缺血常规确认。', '主诉：鼻塞流涕2天').name, '急性上呼吸道感染');
});
await check('4.2', '尿常规「酮体3+」算已有尿酮体结果', () => {
  assert.equal(claims.recordHasTestResultFor('尿酮体', '辅助检查：尿常规：酮体3+，葡萄糖4+'), true);
});
await check('4.3', '有病程门槛的病：依据明说未确立时不去掉待查；病程缺口写「病程未满N个月」不写天数记录', () => {
  const rec = '主诉：反复担心患严重疾病半年\n现病史：反复担心患病半年，多次就医。';
  assert.equal(claims.settleWesternDiagnosisBasis('焦虑障碍', '反复担心患病半年，暂不能指向具体病种，故写症状名待查。', rec).name, '焦虑障碍待查');
  const ed = claims.settleWesternDiagnosisBasis('勃起功能障碍', '勃起不坚3个月，符合勃起功能障碍。', '主诉：勃起不坚3个月');
  assert.equal(ed.name, '勃起功能障碍待查');
  assert.doesNotMatch(ed.basis, /天的记录/u);
  assert.match(ed.basis, /病程未满6个月/u);
});

// 5. 原方括注（第四十八轮配对复核 r48d：「原方白术改用土炒白术，本方未照用」三份读不通；胃苓汤方义只写紫苏为引、用法只写乌梅为引，读者以为矛盾）。
const surface = await jiti.import('../src/lib/delivered-surface.ts');
const projectRx = (name, herbs, analysis, method) => surface.projectDeliveredReasoning({ schemaVersion: 'tcm-cdss-reasoning-v2', stage: 'prescribe', overview: {},
  formula: { candidates: [{ name, herbs: herbs.map((n) => ({ name: n, dose: '9g' })), formulaAnalysis: analysis, decoction: { method } }] }, nonPharma: null }).formula.candidates[0];
await check('5.1', '原书没写炮制、本方用了炮制品：写「原方作X，本方用Y」，不进「原方…本方未照用」', async () => {
  const y = projectRx('异功散', ['人参', '土炒白术', '茯苓', '甘草', '陈皮'], '本方用异功散原方，人参为君。', '每日1剂，水煎两次，共取药液约400mL，分2次温服');
  assert.match(y.formulaAnalysis, /^本方药味同异功散原方（原方作白术，本方用土炒白术）/u);
  assert.doesNotMatch(y.formulaAnalysis, /改用[^）]*本方未照用/u);
  const t = projectRx('天麻钩藤饮', ['天麻', '钩藤', '石决明', '栀子', '黄芩', '川牛膝', '盐杜仲', '益母草', '桑寄生', '首乌藤', '茯神'], '本方用天麻钩藤饮原方，天麻、钩藤为君。', '每日1剂，水煎两次，共取药液约400mL，分2次服');
  assert.match(t.formulaAnalysis, /（原方作杜仲，本方用盐杜仲）/u);
  // 再投影一次不变（括注开头仍是「（原方」，开头改写会先剥掉旧括注）。
  const again = surface.projectDeliveredReasoning({ schemaVersion: 'tcm-cdss-reasoning-v2', stage: 'prescribe', overview: {}, formula: { candidates: [y] }, nonPharma: null }).formula.candidates[0];
  assert.equal(again.formulaAnalysis, y.formulaAnalysis);
});
await check('5.2', '用法只写到一部分原书药引时，方义括注把药引写全；全写到了不再提（R33 口径）', async () => {
  const w = projectRx('胃苓汤', ['陈皮', '厚朴', '苍术', '白术', '茯苓', '泽泻', '猪苓', '肉桂', '甘草'], '本方用胃苓汤原方，陈皮、厚朴为君。', '每日1剂，水煎两次，共取药液约500mL，分2次服');
  assert.match(w.decoction.method, /原方以乌梅为引/u);
  assert.match(w.formulaAnalysis, /以紫苏、乌梅为引，本方未照用/u);
  assert.deepEqual(surface.originalFormulaDeliveryNotes('缓肝理脾汤', [], {}, '原方以煨姜、大枣为引，煎时可酌加'), []);
});
console.log(JSON.stringify({ failed })); process.exitCode = failed ? 1 : 0;
