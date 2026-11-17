// 第四十九轮 P3：全部为合成病例。红旗保留剂量、禁止正式采纳；时限只收紧。
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { '@': `${root}/src`, 'server-only': `${root}/node_modules/next/dist/compiled/server-only/empty.js` } });
const safety = await jiti.import('../src/lib/diagnosis-safety.ts');
const { normalizeCaseStateInput } = await jiti.import('../src/lib/diagnosis-types.ts');
let failed = 0, checks = 0;
async function check(id, title, run) {
 if (process.env.R1066_GATE_ONLY && process.env.R1066_GATE_ONLY !== id) return;
 checks++;
 try { await run(); console.log(`✓ ${id} ${title}`); }
 catch (e) { failed++; console.error(`✗ ${id} ${title}\n${e.stack}`); }
}
const stateFor = (text, extra = {}) => normalizeCaseStateInput({ id: 'r49-synthetic-gate', patient: { age: 51, sex: '男' }, chiefComplaint: '不适2天', symptoms: { 现病史: text }, tongue: '舌淡红，苔薄白', pulse: '弦', pastHistory: '否认慢性病', medicationHistory: '无', allergyHistory: '无药物过敏', vitals: { T: '36.6℃', P: '78次/分', R: '18次/分', BP: '124/78mmHg' }, conversation: [], ...extra });
const flagsFor = (text, extra) => safety.detectProgrammaticRedFlags(stateFor(text, extra));
const infectionFlag = (text, extra) => flagsFor(text, extra).find(flag => /颌面间隙|颈深部感染/u.test(flag));
const targetFor = (text, extra) => safety.priorityEvaluationFollowupTarget(stateFor(text, extra));
await check('1.1', '张口受限、吞咽痛与发热组合报颌面或颈深感染红旗', () => {
 assert.match(infectionFlag('张口受限，吞咽痛，发热。') || '', /张口受限.*吞咽痛.*发热.*立即急诊/u);
});
await check('1.2', '有限构词覆盖牙关紧闭、吞咽稍痛及口底肿胀', () => {
 for (const text of ['牙关紧闭，吞咽稍痛，发热。', '张口明显受限，吞咽困难，发热。', '张口受限，口底肿胀，发热。', '张口受限，流涎，发热。']) assert.ok(infectionFlag(text), text);
});
await check('1.3', '结构化或正文体温达到发热线也触发，不要求模型和糖尿病', () => {
 assert.ok(infectionFlag('张口受限，吞咽稍痛。', { vitals: { T: '38.3℃', P: '82', R: '18', BP: '120/76' } }));
 assert.ok(infectionFlag('牙关紧闭，吞咽痛，体温38.4℃。', { vitals: {} }));
});
await check('1.4', '普通牙痛、牙龈肿痛和咽痛发热无张口受限不触发', () => {
 for (const text of ['牙痛2天。', '吞咽稍痛，发热。', '牙龈肿痛，发热。', '急性扁桃体炎，咽痛发热，否认吞咽困难。']) assert.equal(infectionFlag(text), undefined, text);
});
await check('1.5', '无感染背景时，缺少局部伴随或发热不触发三联兜底', () => {
 for (const text of ['颞下颌关节紊乱，张口受限，无发热。', '张口受限，吞咽痛，无发热。', '张口受限，发热，无吞咽痛及口底肿胀。']) assert.equal(infectionFlag(text), undefined, text);
});
await check('1.6', '局部征象伴气道受累无需等待发热或完整三联征', () => {
 for (const text of ['张口受限，呼吸困难，无发热。', '口底肿胀，喘鸣，无发热。']) assert.ok(infectionFlag(text), text);
});
await check('1.7', '单纯气道症状不冒称颌面或颈深感染，低于数值发热线不拼成组合', () => {
 assert.equal(infectionFlag('喘鸣，呼吸困难。'), undefined);
 assert.equal(infectionFlag('支气管哮喘发作，喘鸣、呼吸困难，咽痛，发热。'), undefined);
 assert.equal(infectionFlag('重症肌无力5年，吞咽困难，饮水呛咳，呼吸困难，无发热。'), undefined);
 assert.equal(infectionFlag('张口受限，吞咽稍痛。', { vitals: { T: '37.9℃', P: '80', R: '18', BP: '120/76' } }), undefined);
});
await check('2.1', '每个成分的前置否认、后置阴性都不成为组合证据', () => {
 for (const text of ['否认张口受限，吞咽痛，发热。', '张口受限阴性，吞咽痛，发热。', '张口受限，否认吞咽痛，发热。', '张口受限，吞咽痛阴性，发热。', '张口受限，吞咽痛，否认发热。']) assert.equal(infectionFlag(text), undefined, text);
});
await check('2.2', '既往、已缓解及非患者事实不拼成当前感染', () => {
 for (const text of ['既往张口受限，现吞咽痛发热。', '张口受限已缓解，现吞咽痛发热。', '父亲张口受限；患者吞咽痛发热。', '如出现张口受限请急诊；现吞咽痛发热。']) assert.equal(infectionFlag(text), undefined, text);
});
await check('2.3', '否认背景与当前阳性分句分别读取，后续阳性出现可触发', () => {
 assert.ok(infectionFlag('否认牙痛，张口受限，吞咽稍痛，发热。'));
 assert.ok(infectionFlag('否认张口受限；今日出现张口受限，吞咽痛，发热。'));
});
await check('2.4', '局部发热和吐痰不等于感染三联征中的发热与呕吐', () => {
 assert.equal(infectionFlag('张口受限，吞咽稍痛，口底发热。'), undefined);
 assert.notEqual(targetFor('腹部隐痛，呕吐，手心发热。')?.window, 'within_24h');
 assert.notEqual(targetFor('腹部隐痛，咳嗽吐出少量痰，发热。')?.window, 'within_24h');
});
await check('3.1', '感染红旗首步立即急诊且保留剂量但不可采纳', () => {
 const state = stateFor('张口受限，吞咽痛，发热。');
 const gate = safety.evaluateSafetyGate(state);
 assert.equal(gate.status, 'red_flag');
 assert.equal(safety.derivePrescriptionPermission(state).formalAdoption, 'blocked');
 assert.match(safety.derivePrescriptionPermission(state).candidateMode, /^(?:limited|full)_dose$/u);
 const target = safety.priorityEvaluationFollowupTarget(state);
 assert.equal(target?.window, 'immediately');
 assert.match(safety.priorityEvaluationFirstStep(target), /立即到医院急诊/u);
});
await check('3.2', '感染合并原当天档警示仍为立即档', () => {
 const target = targetFor('张口受限，吞咽痛，发热；近两月进行性吞咽困难，体重下降6kg。');
 assert.equal(target?.window, 'immediately');
});
await check('3.3', 'HIS原始字段在无追问或跳过追问时均保留感染组合', () => {
 const text = '右颌下肿胀，张口受限，吞咽稍痛。';
 for (const conversation of [[], [{ role: 'user', content: '跳过追问' }]]) {
  const state = stateFor('', { chiefComplaint: '牙痛2天', hisRecord: { schemaVersion: 'tcm-cdss-his-v1', source: 'tcm-cdss-his', caseId: 'synthetic-r49-his', updatedAt: '2026-11-17T00:00:00Z', tongueImageUploaded: false, fields: { zhushu: '牙痛2天', xianbingshi: text, vitalsT: '38.4℃', vitalsP: '104', vitalsR: '18', vitalsBP: '122/78', age: '51岁', sex: '男', jiwangshi: '2型糖尿病7年', fuzhujiancha: '血糖17.3mmol/L' }, rawText: text }, conversation });
  assert.ok(safety.detectProgrammaticRedFlags(state).some(flag => /颌面间隙|颈深部感染/u.test(flag)));
  assert.equal(safety.priorityEvaluationFollowupTarget(state)?.window, 'immediately');
 }
});
await check('4.1', '稳定患者腹痛伴呕吐发热最迟24小时评估', () => {
 const state = stateFor('腹部隐痛，伴呕吐、发热。');
 assert.equal(safety.detectProgrammaticRedFlags(state).length, 0);
 assert.equal(safety.priorityEvaluationFollowupTarget(state)?.window, 'within_24h');
});
await check('4.2', '腹痛发热呕吐分写及体温数值仍收紧时限', () => {
 assert.equal(targetFor('腹部隐痛。呕吐两次。体温38.2℃。', { vitals: {} })?.window, 'within_24h');
});
await check('4.3', '三联征缺任一项、否认、历史症状不误触发新时限', () => {
 for (const text of ['腹部隐痛，呕吐，无发热。', '腹部隐痛，发热，无呕吐。', '无腹痛，呕吐发热。', '既往呕吐；现腹部隐痛、发热。', '腹胀，呕吐，发热。']) assert.notEqual(targetFor(text)?.window, 'within_24h', text);
});
await check('4.4', '持续剧痛或腹膜刺激征仍走原急腹症红旗、立即急诊', () => {
 for (const text of ['持续剧烈腹痛，伴呕吐、发热。', '腹痛，反跳痛阳性，呕吐发热。']) {
  assert.ok(flagsFor(text).some(flag => /腹/u.test(flag)), text);
  assert.ok(!safety.evaluateSafetyGate(stateFor(text)).missingItems.some(item => item.includes('腹部急性感染或急腹症')), text);
  assert.equal(targetFor(text)?.window, 'immediately', text);
 }
});
await check('4.5', '收紧为24小时后仍保留抗凝评估通道的凝血复查嘱咐', () => {
 const target = targetFor('腹部隐痛，呕吐、发热。', { medicationHistory: '正在口服华法林3mg每日1次' });
 assert.equal(target?.window, 'within_24h');
 assert.match(safety.priorityEvaluationFirstStep(target), /复查凝血/u);
 assert.match(safety.priorityEvaluationFirstStep(target, { doses: 5, days: 5 }), /复查凝血/u);
});
await check('4.6', '同为24小时的妊娠腹痛专门通道不被通用三联征覆盖', () => {
 for (const [weeks, pathway] of [[8, 'early_pregnancy_pain_bleeding'], [28, 'late_pregnancy_pain_bleeding']]) {
  const target = targetFor(`孕${weeks}周，腹部隐痛，呕吐发热。`, { patient: { age: 29, sex: '女' } });
  assert.equal(target?.window, 'within_24h');
  assert.equal(target?.pathway, pathway);
 }
});
await check('5.1', '研究判据：牙源或明确咽部感染伴转诊征象，无发热仍立即急诊', () => {
 for (const text of ['牙痛，张口受限，无发热。', '牙龈肿痛，吞咽困难，无发热。', '扁桃体炎，流涎，无发热。', '牙脓肿，口底肿胀，无发热。', '咽部感染，热土豆音，无发热。', '急性咽炎，呼吸困难，无发热。']) assert.ok(infectionFlag(text), text);
 assert.equal(infectionFlag('否认牙痛，张口受限，无发热。'), undefined);
 assert.equal(infectionFlag('既往牙脓肿，吞咽困难，无发热。'), undefined);
});
await check('5.2', '咽痛伴真正吞咽困难无需发热；吞咽痛和单纯颈淋巴结肿大不充当此征象', () => {
 assert.ok(infectionFlag('咽痛，吞咽困难，无发热。'));
 assert.ok(infectionFlag('咽部红肿、咽痛，吞咽和呼吸困难，发热。'));
 assert.ok(infectionFlag('吞咽困难伴咽痛，无发热。'));
 assert.equal(infectionFlag('普通咽痛，吞咽稍痛，无发热。'), undefined);
 assert.equal(infectionFlag('咽痛，否认吞咽困难，无发热。'), undefined);
 assert.equal(infectionFlag('咽痛，颈部淋巴结肿大，低热。'), undefined);
});
console.log(JSON.stringify({ suite: 'r1066-gate', checks, failed }));
process.exitCode = failed ? 1 : 0;
