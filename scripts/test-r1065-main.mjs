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
console.log(JSON.stringify({ failed })); process.exitCode = failed ? 1 : 0;
