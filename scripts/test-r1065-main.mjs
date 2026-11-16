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
console.log(JSON.stringify({ failed })); process.exitCode = failed ? 1 : 0;
