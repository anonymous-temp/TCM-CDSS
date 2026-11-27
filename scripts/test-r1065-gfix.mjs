// 第四十九轮：本套件关闭 D1，仅验证既有教材主症甚判据；裸主症不再凑数，条件保留教材程度词。
process.env.CDSS_MODIFICATION_TEXTBOOK_FILL = "false";
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { alias: { '@': `${process.cwd()}/src`, 'server-only': `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const compiler = await jiti.import('../src/lib/m04-proposal-compiler.ts');
const surface = await jiti.import('../src/lib/delivered-surface.ts');
const criteria = await jiti.import('../src/lib/recorded-test-claims.ts');
const encounter = await jiti.import('../src/lib/western-encounter-primary.ts');
const provenance = await jiti.import('../src/lib/tcm-formula-provenance.ts');
const textbook = await jiti.import('../src/lib/tcm-textbook-syndromes.ts');
const differential = await jiti.import('../src/lib/tcm-disease-differential-authoring.server.ts');
const administration = await jiti.import('../src/lib/hypoglycemia-administration.ts');
const safety = await jiti.import('../src/lib/diagnosis-safety.ts');
let failed = 0;
const check = async (id, description, run) => { try { await run(); console.log(`✓ ${id} ${description}`); } catch (e) { failed++; console.error(`✗ ${id} ${description}\n${e.stack}`); } };
const state = { patient: { age: 44, sex: '女' }, chiefComplaint: '胃痛3天', symptoms: { 现病史: '胃脘胀痛，嗳气，腹胀。' } };
const prior = { stage: 'diagnose', schemaVersion: 'tcm-cdss-reasoning-v2', overview: { tcmDiseaseName: '胃痛', primarySyndrome: '肝气犯胃证', recommendedFormulaNames: ['柴胡疏肝散'], primarySyndromeBasis: ['胃脘胀痛，嗳气'] }, pathogenesis: { chain: [{ nodeId: 'P1', patientFact: '胃脘胀痛', pathogenesis: '肝胃气滞', therapyDirection: '疏肝理气和胃止痛' }] }, therapy: { overallMethod: '疏肝理气和胃止痛' } };
const context = { prior, caseState: state, recordText: safety.clinicalGroundingText(state) };
await check('1.1', '教材主症加强只在本例肯定存在时可用', () => {
  // 用同一教材表定位含“胃痛较甚”的行，不在夹具复制患者病历。
  const found = textbook.textbookRowForSyndrome('胃痛', '肝气犯胃证');
  assert.ok(found);
  const main = found.modifications.find(row => /胃痛.*甚/u.test(row.condition));
  assert.ok(main, JSON.stringify(found.modifications));
  const herb = main.herbs[0];
  // 第五十一轮起补位关时主症甚行一律不交付；判据本身在补位打开时照钉。
  assert.equal(compiler.textbookMainSymptomPresent(main.condition, herb, context), undefined, '补位关');
  process.env.CDSS_MODIFICATION_TEXTBOOK_FILL = 'true';
  try {
    assert.ok(compiler.textbookMainSymptomPresent(main.condition, herb, context));
    assert.equal(compiler.textbookMainSymptomPresent(main.condition, herb, { ...context, recordText: '主诉：腹胀3天\n现病史：无胃痛' }), undefined);
  } finally { process.env.CDSS_MODIFICATION_TEXTBOOK_FILL = 'false'; }
});
// r48 C3：条件条数夹具同时补上病历现症，不能凭空声明口干便溏。
await check('1.2', '裸主症不凑条数，普通条件与红旗排除仍成立', () => {
  const found = textbook.textbookRowForSyndrome('胃痛', '肝气犯胃证').modifications.find(row => /胃痛.*甚/u.test(row.condition));
  const rows = found.herbs.map(herbName => ({ trigger: '本例已见胃痛', herbName }));
  assert.equal(compiler.retainModificationFindings(rows, context).length, 0);
  assert.equal(compiler.retainModificationFindings([...rows, { trigger: '口干' }, { trigger: '便溏' }], { ...context, recordText: `${context.recordText}。口干，便溏。` }).length, 2);
  const red = { ...context, caseState: { ...state, safetyGate: { status: 'red_flag', redFlagFindings: [{ sourceQuote: '胃痛' }] } } };
  assert.equal(compiler.retainModificationFindings(rows, red).length, 0);
});
await check('1.3', '不恢复无教材依据的主症或备用若字条件', () => {
  assert.equal(compiler.textbookMainSymptomPresent('胃痛', '党参', context), undefined);
  assert.equal(compiler.presentModificationCondition('若便溏', context.recordText, context), undefined);
  assert.equal(compiler.modificationTriggerNotFinding('未接受检查', context), 'normal_or_meta');
});
await check('1.4', '第五十一轮：补位关时教材「主症甚」行不补（条件写主症加重而病历没记）；已有药和条件足额不再加', () => {
  const acid = { ...prior, pathogenesis: { chain: [{ nodeId: 'P1', patientFact: '反酸', pathogenesis: '肝火犯胃', therapyDirection: '清肝和胃' }] }, overview: { ...prior.overview, tcmDiseaseName: '吐酸', primarySyndrome: '热证', recommendedFormulaNames: ['左金丸'] }, therapy: { overallMethod: '清肝泻火，和胃降逆' } };
  const patient = { ...state, chiefComplaint: '反酸1月', symptoms: { 现病史: '反酸，烧心。' } };
  const result = compiler.topUpTextbookMainSymptom([], acid, patient, ['海螵蛸']);
  assert.equal(result.length, 0, '第五十一轮（甲方 11/18「条件不在病历里不应该推荐」）：「若见反酸甚」不补');
  assert.equal(compiler.topUpTextbookMainSymptom([], acid, patient, ['海螵蛸', '煅瓦楞子']).length, 0);
  const full = [{ trigger: '腹胀', herbName: '厚朴' }, { trigger: '嗳气', herbName: '木香' }];
  assert.equal(compiler.topUpTextbookMainSymptom(full, acid, { ...patient, symptoms: { 现病史: '反酸，腹胀，嗳气。' } }).length, 2);
  assert.equal(compiler.topUpTextbookMainSymptom([{ trigger: '夜间嗳气', reason: '制酸以减轻反酸' }], acid, { ...patient, symptoms: { 现病史: '反酸，夜间嗳气。' } }, ['海螵蛸']).length, 1);
});
await check('1.5', '教材主症补足先核对功效，不将制酸药的止血功效混作本例目的', () => {
  const acid = { ...prior, pathogenesis: { chain: [{ nodeId: 'P1', patientFact: '反酸', pathogenesis: '肝火犯胃', therapyDirection: '清肝和胃' }] }, overview: { ...prior.overview, tcmDiseaseName: '吐酸', primarySyndrome: '热证', recommendedFormulaNames: ['左金丸'] }, therapy: { overallMethod: '清肝泻火，和胃降逆' } };
  const patient = { ...state, chiefComplaint: '反酸1月', symptoms: { 现病史: '反酸，烧心。' } };
  // 第五十一轮起主症甚行只在补位打开（CDSS_MODIFICATION_TEXTBOOK_FILL=true）时补；功效核对本身照钉。
  process.env.CDSS_MODIFICATION_TEXTBOOK_FILL = 'true';
  try {
    const result = compiler.topUpTextbookMainSymptom([], acid, patient, ['海螵蛸']);
    const shell = result.find((row) => row.herbName === '煅瓦楞子');
    assert.ok(shell, JSON.stringify(result.map((row) => row.herbName)));
    assert.doesNotMatch(shell.reason, /止血/u);
  } finally { process.env.CDSS_MODIFICATION_TEXTBOOK_FILL = 'false'; }
});
await check('2.1', '易感因素和背景病不顶替本次问题；直接表现可关联', () => {
  assert.equal(encounter.establishedDiseaseExplainsEncounter('2型糖尿病', '尿频尿急再发5天'), false);
  assert.equal(encounter.establishedDiseaseExplainsEncounter('2型糖尿病', '尿频量多、腰膝酸软3月'), true);
  const suggested = { primary: { name: '2型糖尿病' }, candidates: [{ name: '尿路感染' }] };
  encounter.settleEncounterPrimary(suggested, '主诉：尿频尿急再发5天\n既往史：2型糖尿病6年');
  assert.notEqual(suggested.primary.name, '尿路感染');
  assert.equal(encounter.establishedDiseaseExplainsEncounter('帕金森病', '大便干结2年'), false);
  assert.equal(encounter.establishedDiseaseExplainsEncounter('高血压病', '头晕2天'), true);
  assert.equal(encounter.establishedDiseaseExplainsEncounter('帕金森病', '双手颤抖动作变慢1年'), true);
  assert.equal(encounter.establishedDiseaseExplainsEncounter('2型糖尿病', '患糖尿病十余年不愈'), true);
});
await check('2.2', '缓存恢复本次问题并保留慢病候选及主症匹配对照', () => {
  const western = { primary: { name: '2型糖尿病' }, candidates: [{ name: '2型糖尿病' }, { name: '复发性尿路感染待查' }] };
  encounter.settleEncounterPrimary(western, '主诉：尿频尿急5天\n既往史：2型糖尿病6年');
  assert.equal(western.primary.name, '复发性尿路感染待查');
  assert.ok(western.candidates.some(row => row.name === '2型糖尿病'));
  const direct = { primary: { name: '高血压病' } };
  encounter.settleEncounterPrimary(direct, '主诉：头晕2天\n既往史：高血压病10年');
  assert.equal(direct.primary.name, '高血压病');
  assert.equal(criteria.settleWesternDiagnosisBasis('高血压待查', '尚缺动态血压确认。', '发现血压升高3年\n缬沙坦80mg每天').name, '高血压');
});
await check('3.1', '上感按表临床诊断，依据尚缺措辞和空依据均不改变结论', () => {
  for (const basis of ['鼻塞流涕咽痛，符合急性上呼吸道感染；尚缺血常规确认。', '']) {
    assert.equal(criteria.settleWesternDiagnosisBasis('急性上呼吸道感染待查', basis, '主诉：鼻塞流涕2天\n现病史：咽痒咳嗽，恶寒发热').name, '急性上呼吸道感染');
  }
});
await check('3.2', '必需检查缺失即待查，已查和明确既往诊断作反例', () => {
  assert.equal(criteria.settleWesternDiagnosisBasis('慢性胃炎', '慢性胃炎诊断已确立。', '主诉：上腹胀1年').name, '慢性胃炎待查');
  assert.doesNotMatch(criteria.settleWesternDiagnosisBasis('慢性胃炎', '上腹胀，符合慢性胃炎。', '主诉：上腹胀1年').basis, /符合慢性胃炎/u);
  assert.equal(criteria.settleWesternDiagnosisBasis('慢性胃炎待查', '考虑慢性胃炎可能。', '主诉：上腹胀1年\n辅助检查：胃镜示慢性胃炎').name, '慢性胃炎');
  assert.equal(criteria.settleWesternDiagnosisBasis('慢性胃炎', '尚缺胃镜确认。', '主诉：上腹胀1年\n既往史：胃镜确诊慢性胃炎3年').name, '慢性胃炎');
});
await check('3.3', '结构化病程先定、检查且或关系、表外沿用旧规则', () => {
  assert.equal(criteria.settleWesternDiagnosisBasis('功能性消化不良', '诊断成立。', '患者：女，35岁\n主诉：餐后饱胀1月').name, '功能性消化不良待查');
  assert.equal(criteria.settleWesternDiagnosisBasis('功能性消化不良待查', '考虑功能性消化不良可能。', '患者：女，35岁\n主诉：餐后饱胀1年').name, '功能性消化不良');
  assert.equal(criteria.westernCriteriaCertainty('急性冠脉综合征', '辅助检查：心电图ST压低').pending, true);
  assert.doesNotMatch(criteria.settleWesternDiagnosisBasis('焦虑障碍待查', '症状反复，且病程未满6个月。', '主诉：过度担忧半年').basis, /未满/u);
  assert.equal(criteria.settleWesternDiagnosisBasis('未收载合成病', '考虑未收载合成病可能。', '主诉：乏力2天').name, '未收载合成病待查');
});
await check('3.4', '要点表的或检查可由已有血糖满足，未拍未进行不当成已有结果', () => {
  assert.equal(criteria.westernCriteriaCertainty('2型糖尿病', '空腹血糖11.8mmol/L，HbA1c9.3%').pending, false);
  assert.equal(criteria.westernCriteriaCertainty('低血糖症', '指尖血糖2.4mmol/L').pending, false);
  assert.equal(criteria.westernCriteriaCertainty('低血糖症', '自测指尖血糖5.5至6.3mmol/L').pending, true);
  assert.equal(criteria.westernCriteriaCertainty('类风湿关节炎', '主诉：关节肿痛4月\n辅助检查：RF阳性，抗CCP阳性').pending, false);
  assert.equal(criteria.westernCriteriaCertainty('髋部骨折', '未拍髋部X线').pending, true);
  assert.equal(criteria.westernCriteriaCertainty('蛛网膜下腔出血', '未进行头颅CT').pending, true);
});
await check('3.5', '要点表说明句不当缺项；按表现计数的病不由单项检查定确定度', () => {
  // 说明句（「既往脑梗死明确诊断记录/影像依据，……」）不是检查名：表不下结论，沿用现行判据，不凭空加待查。
  assert.equal(criteria.westernCriteriaCertainty('脑梗死后遗症', '主诉：右侧肢体活动不利2年'), undefined);
  assert.equal(criteria.settleWesternDiagnosisBasis('脑梗死后遗症', '右侧肢体活动不利2年，符合脑梗死后遗症。', '主诉：右侧肢体活动不利2年').name, '脑梗死后遗症');
  // 风湿热按 Jones 标准计数，抗O升高不能单独让病名去掉待查（反例：表里的检查组仍照常生效）。
  assert.equal(criteria.westernCriteriaCertainty('风湿热', '辅助检查：抗链球菌溶血素O增高'), undefined);
  assert.equal(criteria.settleWesternDiagnosisBasis('急性风湿热待查', '游走性膝痛伴发热，抗O增高，尚缺心超及ESR/CRP，需按Jones标准确认。', '辅助检查：抗链球菌溶血素O增高').name, '急性风湿热待查');
  assert.equal(criteria.westernCriteriaCertainty('细菌性痢疾', '粪常规：白细胞满视野').pending, true);
  // 短条目仍是检查名：头颅CT平扫已做即不缺。
  assert.equal(criteria.westernCriteriaCertainty('蛛网膜下腔出血', '头颅CT平扫：鞍上池高密度').pending, false);
});
await check('4.1', '自拟方不按药味找出处，方义明说才引用原书', () => {
  assert.equal(provenance.selfDevisedReferenceSource(['黄连', '黄芩', '黄柏', '栀子']), '自拟方');
  assert.equal(provenance.selfDevisedSourceForAnalysis('本方为自拟方。黄连清热。'), '自拟方');
  assert.match(provenance.selfDevisedSourceForAnalysis('本方以左金丸为基础加减。'), /左金丸.*丹溪心法/u);
  assert.doesNotMatch(provenance.selfDevisedSourceForAnalysis('本方为自拟方。'), /组方参考|需医生复核/u);
});
await check('4.2', '小方保留原方全部核心药不因加味多而降名；缺核心仍拒', () => {
  const added = ['白芍', '香附', '陈皮', '枳壳', '竹茹', '茯苓', '甘草', '生姜'];
  assert.equal(provenance.smallBaseOverextended('左金丸加减', ['黄连', '吴茱萸', ...added]), false);
  assert.equal(provenance.smallBaseOverextended('左金丸加减', ['黄连', ...added]), true);
});
await check('4.3', '出处教材与原书对照', () => {
  assert.doesNotMatch(provenance.deliveredFormulaSource('参附龙牡救逆汤', '《中医儿科学》'), /中医儿科学/u);
  assert.equal(provenance.deliveredFormulaSource('左金丸', '《丹溪心法》'), '《丹溪心法》');
});
await check('4.4', '交付末端清掉旧缓存的重合度出处，重投影不恢复', () => {
  const rx = { schemaVersion: 'tcm-cdss-reasoning-v2', stage: 'prescribe', overview: {}, formula: { candidates: [{ name: '自拟方', herbs: [], formulaAnalysis: '本方为自拟方。', formulaSource: { evidenceLevel: 'model_inference', source: '自拟方，组方参考：参附龙牡救逆汤（《中医儿科学》）加减', confidence: '低' } }], modifications: [] } };
  const once = surface.projectDeliveredReasoning(rx);
  assert.equal(once.formula.candidates[0].formulaSource.source, '自拟方');
  assert.deepEqual(surface.projectDeliveredReasoning(once), once);
});
await check('5.1', '补足名单按全部肯定表现，否认及家族史不供交集', () => {
  const record = '主诉：体重增加2年\n现病史：形体肥胖，无头晕，无眩晕。';
  assert.equal(textbook.textbookDifferentialSharesAffirmedFinding('眩晕', record), false);
  assert.ok(!differential.governedNameListForTopUp('肥胖', record, { sex: '女', age: 40 }, 2).includes('眩晕'));
  assert.equal(textbook.textbookDifferentialSharesAffirmedFinding('眩晕', '主诉：体重增加2年\n现病史：形体肥胖，伴头晕。'), true);
  assert.equal(textbook.textbookDifferentialSharesAffirmedFinding('眩晕', '主诉：体重增加2年\n家族史：母亲头晕'), false);
  assert.equal(textbook.textbookDifferentialSharesAffirmedFinding('胃痛', '主诉：体重增加2年\n现病史：上腹部疼痛。'), true);
  assert.equal(textbook.textbookDifferentialSharesAffirmedFinding('胃痛', '主诉：体重增加2年\n现病史：无上腹部疼痛。'), false);
});
await check('6.1', '低血糖及在用降糖药须饭后；停用、否认、家族史作反例', () => {
  for (const record of ['主诉：低血糖发作1月', '用药史：胰岛素每日注射', '用药史：格列齐特每日口服', '用药史：二甲双胍0.5g每日2次']) assert.equal(administration.afterMealAdministrationRequired(record), true, record);
  for (const record of ['现病史：否认低血糖', '用药史：格列齐特已停用', '家族史：父亲使用胰岛素', '现病史：未使用降糖药']) assert.equal(administration.afterMealAdministrationRequired(record), false, record);
  assert.equal(administration.afterMealAdministration('每日1剂，饭前空腹温服'), '每日1剂，饭后温服');
  assert.equal(administration.afterMealPrecaution('中药勿空腹服用。'), '中药宜饭后温服。');
  assert.equal(administration.afterMealPrecaution('监测空腹血糖；胰岛素餐前注射。'), '监测空腹血糖；胰岛素餐前注射。');
  assert.equal(administration.afterMealPrecaution('本方饭前空腹温服，监测空腹血糖，格列齐特餐前服用。'), '本方饭后温服，监测空腹血糖，格列齐特餐前服用。');
});
await check('6.2', '交付煎服法与注意事项同一口径且幂等，无风险时保留', () => {
  const rx = { schemaVersion: 'tcm-cdss-reasoning-v2', stage: 'prescribe', overview: {}, formula: { candidates: [{ name: '自拟方', herbs: [], formulaAnalysis: '本方为自拟方。', decoction: { method: '每日1剂，饭前空腹温服' }, formulaSource: { source: '自拟方' } }], modifications: [] }, nonPharma: { precautions: ['中药饭前空腹温服。'] } };
  const out = surface.projectDeliveredReasoning(rx, { recordText: '主诉：低血糖发作1月' });
  assert.match(out.formula.candidates[0].decoction.method, /饭后/u);
  assert.doesNotMatch(JSON.stringify(out.nonPharma.precautions), /饭前|空腹/u);
  assert.deepEqual(surface.projectDeliveredReasoning(out, { recordText: '主诉：低血糖发作1月' }), out);
  assert.match(surface.projectDeliveredReasoning(rx, { recordText: '主诉：头痛1月' }).formula.candidates[0].decoction.method, /饭前空腹/u);
});
if (failed) process.exit(1);
