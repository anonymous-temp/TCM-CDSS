// 第四十七轮 C2：加减条件分型、全处方成药重复、小方身份、治法同义与红旗治则。
// 全部病例为合成；每个编号在 /var/tmp/r1064/cp/mods.py 有独立反证。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { alias: { '@': `${process.cwd()}/src`, 'server-only': `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const compiler = await jiti.import('../src/lib/m04-proposal-compiler.ts');
const fit = await jiti.import('../src/lib/m04-modification-fit.server.ts');
const duplication = await jiti.import('../src/lib/patent-medicine-duplication.server.ts');
const provenance = await jiti.import('../src/lib/tcm-formula-provenance.ts');
const surface = await jiti.import('../src/lib/delivered-surface.ts');
const phrasing = await jiti.import('../src/lib/tcm-therapy-phrasing.ts');
const summary = await jiti.import('../src/lib/diagnosis-visible-summary.ts');
const flags = await jiti.import('../src/lib/clinical-red-flag-context.ts');
const check = async (id, name, run) => {
  if (process.env.R1064_MODS_CHECK && process.env.R1064_MODS_CHECK !== id) return;
  try { await run(); console.log(`✓ ${id} ${name}`); }
  catch (e) { console.error(`✗ ${id} ${name}\n  ${e.stack || e}`); process.exitCode = 1; }
};
const invalid = compiler.modificationTriggerNotFinding;
const recordText = '主诉：胃痛反复两周\n现病史：胃痛，排气后减轻，遇冷加重，表情痛苦，伴腹胀、口干、大便偏干。';
const caseState = { chiefComplaint: '胃痛反复两周', patient: { age: 43, sex: '男' }, symptoms: { 现病史: '胃痛，排气后减轻，表情痛苦，伴腹胀、口干、大便偏干。' } };
const prior = {
  schemaVersion: 'tcm-cdss-reasoning-v2', stage: 'diagnose',
  overview: { tcmDiseaseName: '胃痛', primarySyndrome: '肝胃不和证', primarySyndromeBasis: ['胃痛，腹胀，嗳气'], recommendedFormulaNames: [], formulaSelectionMode: 'self_devised' },
  pathogenesis: { chain: [{ nodeId: 'P1', patientFact: '胃痛，腹胀，嗳气', pathogenesis: '肝胃气滞', therapyDirection: '疏肝理气，和胃止痛' }] },
  therapy: { overallMethod: '疏肝理气，和胃止痛', overallPrinciple: '实则泻之' },
  westernDiagnosis: { primary: { name: '胃痛待查', supportingFacts: [] }, differentials: [] },
};
const herb = (name, role = '臣') => ({ name, role, dose: '6g', targetKind: 'pathogenesis_node', targetRef: 'P1', structureRole: null, function: '理气和胃', processing: null, isToxic: false, decoctionRequirement: null });
const proposal = (modifications = [], medicines = []) => ({
  candidate: { name: '自拟方', herbs: [herb('佛手', '君'), herb('香橼')], formulaAnalysis: '本方为自拟方。佛手疏肝理气为君，香橼理气和中为臣。', applicable: '胃脘胀痛。', notApplicable: '阴虚津亏者慎用。', decoction: { doseCount: '5剂', dosesPerDay: 1, administrationTimesPerDay: 2, method: '每日1剂，水煎分两次温服', followUpNode: '服完5剂复诊' } },
  modifications, patentAndWestern: medicines,
  nonPharma: { diet: '饮食有节。', lifestyle: '规律作息。', emotion: '保持心情平和。', tcmTreatments: [], precautions: [] },
});
const mod = (trigger, herbName = '木香') => ({ trigger, herbName, dose: '6g', targetRef: 'P1', actionType: 'add', reason: '理气和胃', symptomPathogenesis: '气机不畅' });
const rx = (modifications = [], medicines = [], candidate = { name: '自拟方', herbs: [herb('佛手', '君')], formulaAnalysis: '本方为自拟方。佛手理气为君。' }) => ({
  schemaVersion: 'tcm-cdss-reasoning-v2', stage: 'prescribe', overview: prior.overview, therapy: prior.therapy, pathogenesis: prior.pathogenesis,
  formula: { candidates: [candidate], modifications, patentAndWestern: medicines },
});
const START = '<!-- DIAGNOSIS_JSON_START -->', END = '<!-- DIAGNOSIS_JSON_END -->';
const wrap = (x) => `${START}\n${JSON.stringify(x)}\n${END}`;
const unwrap = (x) => JSON.parse(x.slice(x.indexOf(START) + START.length, x.indexOf(END)).trim());

await check('1.1', '缓解/加重因素不作条件；时间相关症状照留', () => {
  for (const text of ['排气后减轻', '得温则减', '热敷后缓解', '遇冷加重', '憋气或喝热水后能停一会儿']) assert.equal(invalid(text), 'factor', text);
  for (const text of ['饭后胃脘胀满', '夜间咳嗽', '大便偏干']) assert.equal(invalid(text), undefined, text);
});
await check('1.2', '表情神态不作药物加减条件；躯体症状照留', () => {
  assert.equal(invalid('本例已见表情痛苦'), 'demeanor');
  assert.equal(invalid('神态紧张'), 'demeanor');
  assert.equal(invalid('腹部绞痛'), undefined);
});
await check('1.3', '主症及其频次形态不作条件；伴随表现仍可用', () => {
  for (const trigger of ['胃痛', '若胃痛', '如果胃痛', '本例已见胃痛', '若兼见胃痛']) assert.equal(invalid(trigger, { caseState, prior }), 'main_symptom', trigger);
  assert.equal(invalid('夜间尿床每周4次', { caseState: { chiefComplaint: '夜间尿床半年' }, prior: { overview: { tcmDiseaseName: '遗尿' } } }), 'main_symptom');
  assert.equal(invalid('连声不断', { prior: { overview: { tcmDiseaseName: '呃逆' } } }), 'main_symptom');
  assert.equal(invalid('腹胀', { caseState, prior }), undefined);
});
await check('1.4', '休克灌注征象、红旗原文、优先评估所引表现共同排除', () => {
  const red = { safetyGate: { status: 'red_flag', redFlags: [], redFlagFindings: [{ sourceQuote: '胸闷发作伴出汗' }] } };
  assert.equal(invalid('四肢末梢稍凉、尿量减少', { caseState: red }), 'emergency_sign');
  assert.equal(invalid('胸闷发作伴出汗', { caseState: red }), 'emergency_sign');
  assert.equal(invalid('腹部压痛', { priorityEvaluation: { pathway: 'test', focus: '腹部压痛' } }), 'emergency_sign');
  assert.equal(invalid('四肢末梢稍凉'), undefined);
  assert.equal(invalid('口干', { caseState: red }), undefined);
  assert.equal(invalid('偶有出汗', { caseState: { safetyGate: { status: 'red_flag', advisories: ['相关患者原文：胸前憋闷、偶有出汗'] } } }), 'emergency_sign');
  assert.equal(invalid('右臂麻木', { caseState: { safetyGate: { status: 'needs_information', semanticTriage: { level: 'priority_review', evidence: [{ sourceQuote: '右臂麻木', evidenceQuotes: [] }] } } } }), 'emergency_sign');
});
await check('1.5', '原话接地也不能让非加减表现进入 present；正常/meta 复用', () => {
  assert.equal(compiler.presentModificationCondition('排气后减轻', recordText), undefined);
  assert.equal(compiler.presentModificationCondition('胃痛', recordText, { caseState, prior }), undefined);
  assert.equal(compiler.modificationTriggerIsNormalState('表情痛苦'), true);
  assert.equal(compiler.modificationTriggerIsNormalState('未接受检查'), true);
  assert.ok(compiler.presentModificationCondition('腹胀', recordText));
});
await check('1.6', '编译不交付缓解因素行；主症只在普通条件不足两项时保留一条（第四十八轮用户定）', () => {
  const result = compiler.compileM04Proposal(proposal([mod('胃痛'), mod('排气后减轻', '厚朴'), mod('腹胀', '枳壳'), { ...mod('胃痛', '佛手'), actionType: 'adjust', dose: '3g' }, { ...mod('胃痛', '香橼'), actionType: 'remove' }]), prior, caseState);
  assert.ok(result, '合成处方应可编译');
  assert.ok(!result.formula.modifications.some(row => /减轻/u.test(row.trigger)), JSON.stringify(result.formula.modifications));
  assert.ok(result.formula.modifications.some(row => row.herbName === '枳壳'));
  // 普通条件只有「腹胀」一项：保留一条主症加强行（只一条，且不是减/调整行）。
  assert.equal(result.formula.modifications.filter(row => /胃痛/u.test(row.trigger)).length, 1, JSON.stringify(result.formula.modifications));
  assert.ok(result.formula.modifications.filter(row => /胃痛/u.test(row.trigger)).every(row => row.action === '加'));
  assert.match(result.formula.modificationReview.droppedReasons.find(row => row.code === 'trigger_not_symptom').message, /另行加减的伴随表现/u, '主症存在，只是不另加药，不能误说成正常或未见症状');
});
await check('1.7', '补写使用同一分型，主症不因条数不足放行', () => {
  const context = { prior, caseState, candidateHerbNames: ['佛手'], existingTriggers: [] };
  assert.equal(compiler.topUpModificationRow({ ...mod('胃痛'), reason: '行气止痛' }, context), undefined);
  assert.equal(compiler.topUpModificationRow(mod('排气后减轻'), context), undefined);
  assert.ok(compiler.topUpModificationRow(mod('腹胀'), context));
  process.env.CDSS_STANDBY_MODIFICATIONS = 'true';
  try { assert.equal(compiler.topUpModificationRow(mod('若胃痛'), context), undefined); }
  finally { delete process.env.CDSS_STANDBY_MODIFICATIONS; }
});
await check('1.8', '核对在模型关闭时仍先清理确定性非表现行', async () => {
  const original = process.env.CDSS_M04_MODIFICATION_FIT;
  process.env.CDSS_M04_MODIFICATION_FIT = 'false';
  try {
    const result = unwrap(await fit.dropMisfitModifications(wrap(rx([{ trigger: '表情痛苦', action: '加', herbName: '木香' }, { trigger: '腹胀', action: '加', herbName: '厚朴' }])), { recordText, caseState, prior }));
    assert.deepEqual(result.formula.modifications.map(row => row.trigger), ['腹胀']);
  } finally { if (original === undefined) delete process.env.CDSS_M04_MODIFICATION_FIT; else process.env.CDSS_M04_MODIFICATION_FIT = original; }
});
await check('1.9', '交付缓存也按同一分型清理，剩余不足两条时只多留一条主症行、不造行', () => {
  const result = surface.projectDeliveredReasoning(rx([{ trigger: '胃痛', action: '加', herbName: '木香' }, { trigger: '表情痛苦', action: '加', herbName: '厚朴' }, { trigger: '腹胀', action: '加', herbName: '枳壳' }]), { recordText });
  assert.deepEqual(result.formula.modifications.map(row => row.trigger), ['腹胀', '胃痛']);
  const unlabeled = surface.projectDeliveredReasoning(rx([{ trigger: '胃痛', action: '加', herbName: '木香' }]), { recordText: recordText.replace('主诉：', ''), caseState });
  // 无标题的正文仍读结构化主诉认出主症；唯一一行是主症时作为主症加强行保留（第四十八轮），不另造行。
  assert.equal(compiler.modificationTriggerNotFinding('胃痛', { caseState, recordText: recordText.replace('主诉：', '') }), 'main_symptom', '无标题的正文仍读结构化主诉');
  assert.deepEqual(unlabeled.formula.modifications.map(row => row.trigger), ['胃痛']);
});
const medicine = { type: '中成药', name: '潞党参口服液', route: '口服', positioning: '需医生评估' };
await check('2.1', '单味成药与加味重复；减/调整/替代/外用例外保持', () => {
  assert.ok(duplication.patentMedicineDuplication(medicine, [herb('佛手')], [], [{ action: '加', herbName: '党参' }]));
  assert.equal(duplication.patentMedicineDuplication(medicine, [herb('佛手')], [], [{ action: '减', herbName: '党参' }]), undefined);
  assert.equal(duplication.patentMedicineDuplication({ ...medicine, positioning: '替代方案' }, [], [], [{ action: '加', herbName: '党参' }]), undefined);
  assert.equal(duplication.patentMedicineDuplication({ ...medicine, route: '外用' }, [], [], [{ action: '加', herbName: '党参' }]), undefined);
  assert.equal(duplication.patentMedicineDuplication(medicine, [], [], [{ action: '加', herbName: '人参' }]), undefined);
});
await check('2.2', '峻烈药仅在加味里重叠也拦', () => {
  assert.ok(duplication.patentMedicineDuplication({ type: '中成药', name: '三黄片' }, [herb('石膏')], [], [{ action: '加', herbName: '酒大黄' }]));
  assert.equal(duplication.patentMedicineDuplication({ type: '中成药', name: '三黄片' }, [herb('石膏')], [], []), undefined);
});
await check('2.3', '交付最终加味与成药同判，未重复成药保留', () => {
  const result = surface.projectDeliveredReasoning(rx([{ trigger: '乏力', action: '加', herbName: '党参' }], [medicine]), { recordText: `${recordText}\n伴乏力。` });
  assert.deepEqual(result.formula.patentAndWestern, []);
  const control = surface.projectDeliveredReasoning(rx([], [medicine]), { recordText: `${recordText}\n伴乏力。` });
  assert.equal(control.formula.patentAndWestern.length, 1);
});
const leftGoldHerbs = ['黄连', '吴茱萸', '白芍', '香附', '陈皮', '枳壳', '竹茹', '茯苓', '甘草', '生姜'];
await check('3.1', '小方命名阈值按原方味数和新增身份计，严格大于两倍', () => {
  // R48：完整保留底方核心药时，加味多不单独构成降名理由。
  assert.equal(provenance.smallBaseOverextended('左金丸加减', leftGoldHerbs), false);
  assert.equal(provenance.smallBaseOverextended('左金丸加减', leftGoldHerbs.slice(0, 6)), false, '新增4味=两倍不降名');
  assert.equal(provenance.smallBaseOverextended('左金丸加减', ['黄连', '吴茱萸', '酒黄连', '白芍']), false, '炮制不重复计数');
  assert.equal(provenance.smallBaseOverextended('四君子汤加减', leftGoldHerbs), false, '底方超过3味不适用');
  assert.equal(provenance.smallBaseOverextended('黄连温胆汤加减', leftGoldHerbs), false, '省略的原书条目不能把完整复方判成小方');
});
await check('3.2', '小方过度加味交付自拟，参考与原书保留，方义开头同步且幂等', () => {
  const candidate = { name: '左金丸加减', formulaNames: ['左金丸'], baseFormulas: [{ name: '左金丸' }], constructionType: 'single_base', herbs: leftGoldHerbs.filter(name => name !== '吴茱萸').map(name => herb(name)), formulaAnalysis: '本方以左金丸为基础加减。黄连清热，吴茱萸降逆，白芍柔肝。', formulaSource: { source: '左金丸：《丹溪心法》', evidenceLevel: 'classic_text' } };
  const input = rx([], [], candidate);
  input.overview = { ...input.overview, recommendedFormulaNames: ["左金丸"], recommendedFormulaDirection: "左金丸加减" };
  const result = surface.projectDeliveredReasoning(input);
  const c = result.formula.candidates[0];
  assert.equal(c.name, '自拟方'); assert.equal(c.constructionType, 'self_devised');
  assert.deepEqual(c.formulaNames, []); assert.deepEqual(c.baseFormulas, []);
  // R48：只引用方义明说的底方，不按药味重合度另挑。
  assert.match(c.formulaSource.source, /自拟方/u);
  assert.doesNotMatch(c.formulaSource.source, /组方参考/u);
  assert.match(c.formulaAnalysis, /^本方为自拟方/u);
  assert.deepEqual(surface.projectDeliveredReasoning(result), result, '重复投影不恢复为小方加减');
  const alreadySelf = rx([], [], { ...candidate, name: '自拟方', formulaNames: [], baseFormulas: [], constructionType: 'self_devised', formulaAnalysis: '本方为自拟方。黄连清热，吴茱萸降逆，白芍柔肝。', formulaSource: { evidenceLevel: 'model_inference', source: '自拟方，组方参考：左金丸（《丹溪心法》）加减' } });
  alreadySelf.overview = input.overview;
  const keptSelf = surface.projectDeliveredReasoning(alreadySelf);
  assert.doesNotMatch(keptSelf.formula.candidates[0].formulaAnalysis, /参照左金丸化裁/u, '只有 M03 推荐方名时不应把已自拟的方义先恢复、再改回并造参照句');
});
await check('4.1', '动作同义且对象相同才合并，阴阳和治法方向相异保留', () => {
  assert.equal(phrasing.withoutRedundantTherapyPhrases('温补肾阳，温肾助阳'), '温补肾阳');
  assert.equal(phrasing.withoutRedundantTherapyPhrases('辛凉解表，疏风解表'), '辛凉解表');
  assert.equal(phrasing.withoutRedundantTherapyPhrases('清利湿热，清热利湿'), '清利湿热');
  assert.equal(phrasing.withoutRedundantTherapyPhrases('益气养血，补气养血'), '益气养血');
  assert.equal(phrasing.withoutRedundantTherapyPhrases('辛温解表，辛凉解表'), '辛温解表，辛凉解表');
  assert.equal(phrasing.withoutRedundantTherapyPhrases('温中止痛，行气止痛'), '温中止痛，行气止痛');
});
await check('4.2', '流程话整项删除，仅流程项也不回填', () => {
  assert.equal(phrasing.withoutRedundantTherapyPhrases('疏肝理气，详查药因，复查血常规，排除器质性病变'), '疏肝理气');
  assert.equal(phrasing.withoutRedundantTherapyPhrases('完善检查'), '');
});
await check('4.3', '硬拼长项拆回并去掉前文已有的补气概念', () => {
  assert.equal(phrasing.withoutRedundantTherapyPhrases('益气养血，补气摄血固冲'), '益气养血，摄血固冲');
  assert.ok(surface.standardMethodItems('补气摄血固冲').every(item => item.length <= 4));
  assert.equal(surface.clinicalMethodItems('益气养血，补气摄血固冲'), '益气养血，摄血固冲');
});
await check('4.4', '无红旗撤急则治标，有红旗仍置顶；治则推导也不凭模型保留急字', () => {
  assert.equal(surface.principleWhenRedFlag('急则治标，虚则补之', false), '虚则补之');
  assert.equal(surface.principleWhenRedFlag('标本兼治', true), '急则治标');
  const neutral = { overview: { primarySyndrome: '证候待辨' }, therapy: { overallMethod: '' } };
  assert.equal(summary.nationalTreatmentPrinciple('急则治标', neutral), '调理阴阳');
  const input = rx(); input.therapy = { overallPrinciple: '急则治标，实则泻之', overallMethod: '温补肾阳，温肾助阳，详查药因' };
  const projected = surface.projectDeliveredReasoning(input);
  assert.equal(projected.therapy.overallPrinciple, '实则泻之');
  assert.equal(projected.therapy.overallMethod, '温补肾阳', '开方继承的治法同样收口');
});
await check('4.5', '共享红旗读者只读既定安全门或 red_flag_clearance', () => {
  assert.equal(flags.redFlagActiveFor({ safetyGate: { status: 'red_flag' } }), true);
  assert.equal(flags.redFlagActiveFor({ caseState: { safetyGate: { status: 'red_flag' } } }), true);
  assert.equal(flags.redFlagActiveFor({ priorityEvaluation: { pathway: 'red_flag_clearance' } }), true);
  assert.equal(flags.redFlagActiveFor({ safetyGate: { status: 'ready' }, priorityEvaluation: { pathway: 'red_flag_clearance' } }), false);
  assert.equal(flags.redFlagActiveFor({ priorityEvaluation: { pathway: 'urgent_specialist' } }), false);
});

await check('1.10', '补写计数前先去不合格条件，已足两条也清理并保留原行', async () => {
  const rows = [{ trigger: '表情痛苦', action: '加', herbName: '木香' }, { trigger: '腹胀', action: '加', herbName: '枳壳' }, { trigger: '口干', action: '加', herbName: '麦冬' }];
  const result = unwrap(await fit.topUpModificationConditions(wrap(rx(rows)), { recordText, caseState, prior }));
  assert.deepEqual(result.formula.modifications.map(row => row.trigger), ['腹胀', '口干']);
});
await check('2.4', '编译以实际通过的加味比成药，不因被剔除的加味误删成药', () => {
  const cough = { ...prior, overview: { ...prior.overview, tcmDiseaseName: '咳嗽', primarySyndrome: '肺气虚证', primarySyndromeBasis: ['咳声低弱，气短，乏力'] }, therapy: { overallMethod: '补益肺气，健脾益气' }, pathogenesis: { chain: [{ nodeId: 'P1', patientFact: '咳声低弱，气短，乏力', pathogenesis: '肺气不足', therapyDirection: '补益肺气' }] } };
  const patient = { chiefComplaint: '咳嗽反复一月', patient: { age: 48, sex: '男' }, symptoms: { 现病史: '咳声低弱，气短，乏力，便溏。' } };
  const med = { ...medicine, usageBoundary: '按说明书由医生评估', correspondingProblem: '咳嗽、气短', evidenceId: 'LOCAL-INST-001', evidenceFingerprint: `sha256:${'a'.repeat(64)}`, relationship: '补益肺气', riskNote: '请医生核实' };
  const add = { ...mod('乏力', '党参'), reason: '补益肺气', symptomPathogenesis: '肺气不足' };
  const withAddition = compiler.compileM04Proposal(proposal([add], [med]), cough, patient);
  assert.ok(withAddition.formula.modifications.some(row => row.herbName === '党参'));
  assert.deepEqual(withAddition.formula.patentAndWestern, []);
  const control = compiler.compileM04Proposal(proposal([{ ...add, trigger: '表情痛苦' }], [med]), cough, patient);
  assert.equal(control.formula.patentAndWestern.length, 1, '被剔掉的加味不算实际重复');
});

await check('1.11', '同类构词的留出写法与开发集同判，餐后症状作负对照', () => {
  const examples = JSON.parse(readFileSync(new URL('../src/data/tcm-modification-trigger-policy.source.json', import.meta.url), 'utf8')).examples;
  for (const row of [...examples.development, ...examples.heldOut]) assert.equal(invalid(row.trigger), row.reason, row.trigger);
  for (const trigger of examples.negativeControls) assert.equal(invalid(trigger), undefined, trigger);
});

await check('3.3', '教材方向锁定小方时重复投影也不恢复名字或重复方义', () => {
  const input = rx([], [], { name: '左金丸加减', herbs: leftGoldHerbs.filter(name => name !== '吴茱萸').map(name => herb(name)), formulaAnalysis: '本方以左金丸为基础加减。黄连清热，吴茱萸降逆。', formulaSource: { source: '左金丸：《丹溪心法》' } });
  input.overview = { ...input.overview, tcmDiseaseName: '吐酸', primarySyndrome: '热证', primarySyndromeBasis: ['吞酸，胃脘胀满'], recommendedFormulaNames: ['左金丸'], recommendedFormulaDirection: '左金丸加减' };
  const once = surface.projectDeliveredReasoning(input);
  const twice = surface.projectDeliveredReasoning(once);
  assert.equal(twice.formula.candidates[0].name, '自拟方');
  assert.deepEqual(twice, once);
  const alreadySelf = structuredClone(input);
  alreadySelf.formula.candidates[0].name = '自拟方';
  alreadySelf.formula.candidates[0].formulaAnalysis = '本方为自拟方。黄连清热，吴茱萸降逆。';
  const keptSelf = surface.projectDeliveredReasoning(alreadySelf);
  assert.doesNotMatch(keptSelf.formula.candidates[0].formulaAnalysis, /参照左金丸化裁/u, '教材命中也不凭恢复路径给已有自拟方增写方义');
});

await check('1.12', '生成与补写提示均禁止以主诉主症凑加减，语义核对有同一原则', () => {
  const prompts = readFileSync(new URL('../src/lib/diagnosis-prompts.ts', import.meta.url), 'utf8');
  const topUp = readFileSync(new URL('../src/lib/m04-modification-fit.server.ts', import.meta.url), 'utf8');
  assert.match(prompts, /主诉主症及其频次、形态已由主方治疗/u);
  assert.match(topUp, /主诉主症及其频次、形态由主方治疗/u);
});
