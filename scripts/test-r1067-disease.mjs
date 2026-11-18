// 第五十轮 P3。合成记录与注入桩，不读密钥或调用外部模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, { fsCache: false, alias: { '@': `${process.cwd()}/src`, 'server-only': `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const load = (name) => jiti.import(`../src/lib/${name}.ts`);
const defs = await load('tcm-disease-defining-findings');
const points = await load('m03-disease-points-check.server');
const visit = await load('m03-visit-reason-check.server');
const tb = await load('tcm-textbook-syndromes');
const surface = await load('delivered-surface');
const aliases = await load('western-diagnosis-aliases');
const neutral = await load('m03-disease-neutral-policy');
const terms = await load('clinical-terminology');
const governance = await load('clinical-governance-tables');
const pick = await load('textbook-disease-pick.server');
const checks = [];
const check = (id, title, run) => checks.push({ id, title, run });
const json = (name) => JSON.parse(fs.readFileSync(`src/data/${name}.source.json`, 'utf8'));
const pointsInput = (disease, chiefComplaint, recordText, candidates, allowedDiseases = candidates) => ({ disease, chiefComplaint, recordText, candidates, allowedDiseases });
const strongFever = pointsInput('急惊风', '发热一天', '主诉：发热一天。体温39.4℃。患儿嗜睡。无抽搐。', ['急惊风', '呕吐'], ['急惊风', '呕吐', '高热', '头痛']);
const choose = (name) => JSON.stringify({ overview: { tcmDiseaseName: name } });
const root = (disease, syndrome) => ({
  schemaVersion: 'tcm-cdss-reasoning-v2', stage: 'diagnose',
  overview: { tcmDiseaseName: disease, tcmDiseaseRationale: '按现有表现辨病。', primarySyndrome: syndrome, secondarySyndromes: [], tcmDiseaseDifferentials: [], tcmDifferentials: [] },
  pathogenesis: { chain: [], uncertainties: [] }, therapy: {},
});
const refine = (context, disease, target) => defs.textbookDiseaseRefinementMatches(context, [target], disease)[0];
const knee = { ageYears: 59, chiefComplaint: '双膝活动痛三年', recordText: '双膝活动痛，负重加重。', exam: '双膝X线：关节间隙变窄，骨赘。' };
const copd = { ageYears: 52, chiefComplaint: '反复咳痰', pastHistory: '已诊断COPD。', recordText: '近来咳痰，活动后气促。' };
const gall = { ageYears: 45, chiefComplaint: '右胁胀痛', recordText: '右胁胀痛，进食油腻后发作。', pastHistory: '曾诊断胆囊结石。' };
const child = { ageYears: 4, chiefComplaint: '面黄纳差3个月', recordText: '长期偏食。形体偏瘦，面黄，纳差，时干时稀。' };
const labs = { chiefComplaint: '呕吐2天', exam: '指尖血糖25.2 mmol/L。尿酮体3+。', recordText: '近1个月多饮，多尿，体重下降。今有呕吐，呼吸深快。' };
const laborUrine = '主诉：尿频反复。劳累后再发，尿后余沥不尽，腰膝酸软，纳少乏力。';
const hotUrine = '主诉：尿血1天。小便带血，排尿疼痛。舌红，苔黄腻。';

check('D01', '明确否认和病历未记在重画指令中区分', () => {
  const denied = points.deterministicDiseasePointsVerdict(strongFever);
  const unset = points.deterministicDiseasePointsVerdict({ ...strongFever, recordText: '发热。体温39.4℃。' });
  assert.deepEqual(denied.denied, ['抽搐']);
  assert.deepEqual(unset.unrecorded, ['抽搐']);
  assert.match(points.diseasePointsRedrawInstruction('急惊风', denied), /病历明确否认：抽搐/);
  assert.match(points.diseasePointsRedrawInstruction('急惊风', unset), /病历未记：抽搐/);
});
check('D02', '分科闭集中的高热有肯定体温，选项各带定义，伴随呕吐不单列', async () => {
  const verdict = await points.checkDiseaseAgainstDiagnosisPoints({ ...strongFever, recordText: strongFever.recordText + '昨晚呕吐两次。' });
  assert.equal(verdict.status, 'mismatch');
  assert.deepEqual(verdict.alternatives.map((item) => item.name), ['高热']);
  assert.match(verdict.alternatives[0].definition, /39|热/);
  assert.match(verdict.alternatives[0].evidence.join(''), /39\.4/);
  assert.equal(points.deterministicDiseasePointsVerdict({ ...strongFever, allowedDiseases: ['急惊风'] }).better, '');
});
check('D03', '重画只一次，并以新名的肯定定义和闭集验收；拒采、同名和超时保留首稿', async () => {
  const verdict = points.deterministicDiseasePointsVerdict(strongFever);
  let calls = 0;
  for (const [name, adopted] of [['高热', true], ['急惊风', false], ['呕吐', false], ['健忘', false]]) {
    const result = await points.redrawDiseasePointsTcmHalf(strongFever, verdict, async (instruction) => {
      calls += 1; assert.match(instruction, /高热｜定义/); return choose(name);
    });
    assert.equal(result.adopted, adopted, name);
  }
  assert.equal(calls, 4);
  const falseAlternative = { ...verdict, alternatives: [{ name: '呕吐', definition: '', evidence: [] }] };
  assert.equal(points.diseasePointsRedrawAcceptable(strongFever, falseAlternative, '呕吐'), false);
  assert.equal((await points.redrawDiseasePointsTcmHalf(strongFever, verdict, async () => { throw Error('timeout'); })).adopted, false);
});
check('D04', '交付保留原依据及病名，未记录补一项，同义、明确否认及真实干呕不重复追问', () => {
  const project = (d, text, item) => {
    const input = root(d, '痰湿中阻证');
    if (item) input.pathogenesis.uncertainties = [{ item, reason: '尚需问明', affects: '辨病' }];
    return surface.projectDeliveredReasoning(input, { recordText: text });
  };
  const missing = project('眩晕', '主诉：头胀。');
  assert.equal(missing.overview.tcmDiseaseRationale, '按现有表现辨病。');
  assert.equal(missing.overview.tcmDiseaseName, '眩晕');
  assert.deepEqual(missing.pathogenesis.uncertainties.map((row) => row.item), ['目眩或头晕']);
  assert.equal(project('眩晕', '头胀。', '是否视物旋转').pathogenesis.uncertainties.length, 1);
  assert.equal(project('急惊风', '高热。明确无抽搐。').pathogenesis.uncertainties.length, 0);
  assert.equal(project('呕吐', '干呕无物。').pathogenesis.uncertainties.length, 0);
});
check('D05', '共享简称保留原文与极性，房颤和 COPD 有有限词边界', () => {
  assert.equal(aliases.affirmedWesternHistoryDiagnosis('曾确诊 copd 5年。', '慢性阻塞性肺疾病').quote, '曾确诊 copd 5年');
  assert.equal(aliases.affirmedWesternHistoryDiagnosis('母亲有COPD。', '慢性阻塞性肺疾病'), undefined);
  assert.equal(aliases.affirmedWesternHistoryDiagnosis('否认COPD；记录项XCOPD。', '慢性阻塞性肺疾病'), undefined);
  assert.equal(aliases.affirmedWesternHistoryDiagnosis('房颤5年。', '心房颤动').term, '房颤');
  assert.equal(aliases.affirmedWesternHistoryDiagnosis('否认房颤。', '心房颤动'), undefined);
});
check('D06', '肺胀仅在本人慢阻肺史加当次咳痰和劳力气促时提名', () => {
  assert.equal(refine(copd, '咳嗽', '肺胀').display, '肺胀');
  assert.equal(refine({ ...copd, recordText: '咳痰，活动后无气促。' }, '咳嗽', '肺胀'), undefined);
  assert.equal(refine({ ...copd, pastHistory: '否认慢阻肺。' }, '咳嗽', '肺胀'), undefined);
  assert.equal(refine(copd, '肺胀', '肺胀'), undefined);
});
check('D07', '膝痹须当次膝痛及病史或同报告退变；术后、他处关节及儿童阴性', () => {
  assert.equal(refine(knee, '痹证', '骨关节炎').display, '膝痹');
  assert.equal(refine({ ...knee, exam: '', pastHistory: '已确诊膝骨性关节炎。' }, '痹证', '骨关节炎').display, '膝痹');
  for (const record of [
    { ...knee, chiefComplaint: '膝关节置换术后康复，膝痛。' },
    { ...knee, chiefComplaint: '双手小关节痛' },
    { ...knee, ageYears: 8, chiefComplaint: '膝关节痛伴发热' },
    { ...knee, exam: '双膝X线正常；手关节X线见退变。' },
  ]) assert.equal(refine(record, '痹证', '骨关节炎'), undefined);
  assert.deepEqual(tb.textbookFormulaRowsForDisease('膝痹').map((row) => row.id), tb.textbookFormulaRowsForDisease('骨关节炎').map((row) => row.id));
});
check('D08', '胆胀需当前胆系痛与胆囊结石，单纯胁痛或偶发结石留原病', () => {
  assert.equal(refine(gall, '胁痛', '胆石症').display, '胆胀');
  assert.equal(refine({ ...gall, pastHistory: '未见胆囊结石。' }, '胁痛', '胆石症'), undefined);
  assert.equal(refine({ ...gall, chiefComplaint: '左侧胁痛' }, '胁痛', '胆石症'), undefined);
  assert.equal(refine({ ...gall, recordText: '右胁胀痛，无其他不适。' }, '胁痛', '胆石症'), undefined);
});
check('D09', '儿科慢性消耗及喂养、消瘦食少便调成组，成人和单贫血阴性', () => {
  assert.equal(refine(child, '虚劳', '疳证').section, '疳证');
  assert.equal(refine({ ...child, ageYears: 24 }, '虚劳', '疳证'), undefined);
  assert.equal(refine({ ...child, recordText: '面色苍白，贫血。' }, '虚劳', '疳证'), undefined);
});
check('D10', '消渴的当前危重表现可解释就诊原因，孤立呕吐照旧核对；正反模型桩', async () => {
  const input = { chiefComplaint: labs.chiefComplaint, presentHistory: labs.recordText, disease: '消渴', picks: ['呕吐', '消渴'], diseaseRecord: labs };
  let calls = 0;
  const ask = async () => { calls += 1; return { status: 'not_covered', visitReason: '呕吐', better: '呕吐', reason: '' }; };
  assert.equal((await visit.checkDiseaseExplainsVisitReason(input, undefined, ask)).status, 'covered');
  assert.equal(calls, 0);
  const isolated = { ...input, diseaseRecord: { ...labs, exam: '尿酮体3+。', recordText: '恶心呕吐。' } };
  assert.equal((await visit.checkDiseaseExplainsVisitReason(isolated, undefined, ask)).status, 'not_covered');
  assert.equal(calls, 2);
});
check('D11', '分期取原发作，明确超过半年才标；精确日历端点及当前神志不误作发作神志', () => {
  const classify = (r) => tb.diseaseNameWithRecordSubtype('中风（恢复期）', r);
  assert.equal(classify('主诉：卒中后遗偏瘫。\n现病史：脑梗死2年，近期加重2天。目前神志清楚。'), '中风（后遗症期）');
  for (const term of ['半年','6个月','约6个月']) assert.equal(classify(`主诉：偏瘫。\n现病史：脑梗死${term}，目前意识清楚。`), '中风');
  assert.equal(classify('主诉：偏瘫。\n脑梗死2026-01-31。\n就诊日期：2026-07-31。'), '中风');
  assert.equal(classify('主诉：偏瘫。\n脑梗死2026-01-31。\n就诊日期：2026-08-01。'), '中风（后遗症期）');
  assert.equal(classify('主诉：偏瘫。\n脑梗死7天，发作时无意识障碍。'), '中风（中经络·急性期）');
  assert.equal(classify('主诉：偏瘫。\n脑出血21天，发作时意识丧失。'), '中风（中脏腑·急性期）');
});
check('D12', '汗证按昼夜分型，缺醒后止或双型均不冒定；原节可回查', () => {
  assert.equal(tb.diseaseNameWithRecordSubtype('汗证', '白天汗出，否认盗汗。'), '汗证（自汗）');
  assert.equal(tb.diseaseNameWithRecordSubtype('汗证', '每天下午反复出汗。'), '汗证（自汗）');
  assert.equal(tb.diseaseNameWithRecordSubtype('汗证', '寐中汗出，醒后汗止。'), '汗证（盗汗）');
  assert.equal(tb.diseaseNameWithRecordSubtype('汗证（盗汗）', '白天汗出。'), '汗证（自汗）');
  assert.equal(tb.diseaseNameWithRecordSubtype('汗证', '白天汗出。睡中汗出，醒后汗止。'), '汗证');
  assert.deepEqual(tb.splitTextbookDiseaseSubtype('汗证（自汗）'), { disease: '汗证', subtype: '自汗' });
  assert.ok(tb.textbookFormulaRowsForDisease('汗证（自汗）').length);
});
check('D13', '成人短程频泻能细分，儿科泄泻和低频不继承成人分组', () => {
  const r = '主诉：腹泻2天。\n今水样便，每日6次。';
  assert.equal(tb.diseaseNameWithRecordSubtype('泄泻', `患者年龄：38岁\n${r}`), '泄泻（暴泻）');
  assert.equal(tb.diseaseNameWithRecordSubtype('泄泻（暴泻）', `患者年龄：6岁\n${r}`), '泄泻');
  assert.equal(tb.diseaseNameWithRecordSubtype('泄泻', `患者年龄：38岁\n${r.replace('6次', '2次')}`), '泄泻');
});
check('D14', '多饮多尿不强定下消，热肿单膝不能靠痛风史覆盖', () => {
  assert.equal(tb.diseaseNameWithRecordSubtype('消渴', '主诉：多尿一月。\n小便量多。'), '消渴（下消）');
  assert.equal(tb.diseaseNameWithRecordSubtype('消渴', '主诉：多尿一月。\n小便量多，烦渴多饮。'), '消渴');
  assert.equal(tb.diseaseNameWithRecordSubtype('痛风', '主诉：第一跖趾关节红肿疼痛2天。\n既往确诊痛风。'), '痛风（急性期）');
  assert.equal(tb.diseaseNameWithRecordSubtype('痛风', '主诉：单膝红肿疼痛2天。\n高热寒战，既往痛风病史。'), '痛风');
});
check('D15', '项痹只作有定位证据的父节括注，未定位妊娠和单纯髋痛不贴阶段', () => {
  assert.equal(tb.diseaseNameWithRecordSubtype('痹证', '主诉：颈项疼痛。颈部活动受限，向上肢放射痛。'), '痹证（项痹）');
  assert.equal(tb.diseaseNameWithRecordSubtype('痹证', '主诉：颈肩部疼痛。\n现病史：转头受限。'), '痹证（项痹）');
  assert.equal(tb.diseaseNameWithRecordSubtype('痹证', '主诉：颈项疼痛。'), '痹证');
  assert.equal(tb.diseaseNameWithRecordSubtype('异位妊娠（已破损期）', '停经后腹痛，超声未做。'), '异位妊娠');
  assert.equal(tb.diseaseNameWithRecordSubtype('骨折（髋部骨折）', '跌伤后髋痛。未拍片。'), '骨折');
  // 总指挥第五十轮取舍：「疖（疖病）」「乳蛾（慢乳蛾急性发作）」两条细分不交付（括注读起来不像病名；甲方 11.05 病历 2 的答案就是「乳蛾」），规则已从数据里去掉。
  assert.equal(tb.diseaseNameWithRecordSubtype('疖', '项背反复起红肿结节，多处，此起彼伏，有脓头。'), '疖');
  assert.equal(tb.diseaseNameWithRecordSubtype('乳蛾', '主诉：咽痛3天。\n既往史：慢性扁桃体炎史2年。'), '乳蛾');
  assert.equal(tb.diseaseNameWithRecordSubtype('疖', '项后有一处脓头。'), '疖');
});
check('D15b', '病名细分后，原来的粗病名不作它的鉴别；教材自己列的鉴别病照留', () => {
  const norm = jiti('../src/lib/tcm-disease-differential-normalization.ts');
  assert.equal(norm.resolveTcmDiseaseDifferentialName('痹证', '膝痹').action, 'drop');
  assert.equal(norm.resolveTcmDiseaseDifferentialName('胁痛', '胆胀病').action, 'drop');
  assert.equal(norm.resolveTcmDiseaseDifferentialName('虚劳', '疳证').action, 'drop');
  assert.equal(norm.resolveTcmDiseaseDifferentialName('痹证', '腰痛').action, 'keep');
  assert.equal(norm.resolveTcmDiseaseDifferentialName('咳嗽', '感冒').action, 'keep');
});
check('D16', '留有原行的劳淋和血淋成组换证，鉴别与辨病原文不换字', () => {
  const labor = surface.projectDeliveredReasoning(root('淋证（劳淋）', '劳淋'), { recordText: laborUrine });
  const hot = root('淋证（血淋）', '血淋');
  hot.overview.tcmDiseaseRationale = '本次尿血，暂归血淋。';
  const result = surface.projectDeliveredReasoning(hot, { recordText: hotUrine });
  assert.equal(labor.overview.primarySyndrome, '脾肾两虚证');
  assert.equal(result.overview.primarySyndrome, '膀胱湿热证');
  assert.equal(result.overview.tcmDiseaseRationale, hot.overview.tcmDiseaseRationale);
  assert.equal(tb.textbookRowForSyndrome('淋证（血淋）', result.overview.primarySyndrome).id, 'neike|淋证|血淋');
  assert.equal(tb.textbookRowForSyndrome('淋证（劳淋）', labor.overview.primarySyndrome).id, 'neike|淋证|劳淋');
});
check('D17', '血淋虚实按当前表现，不套同名他病或已经规范的原证名', () => {
  const empty = tb.textbookSubtypeSyndromeDisplay('淋证（血淋）', '血淋', '仅尿血，无尿痛。');
  assert.deepEqual(empty, { display: undefined });
  assert.deepEqual(tb.textbookSubtypeSyndromeDisplay('汗证（自汗）', '自汗', '白天汗出。'), {});
  assert.equal(tb.textbookSubtypeSyndromeDisplay('淋证（血淋）', '血淋', '尿血，尿痛轻微，腰酸，五心烦热。').display, '肾阴虚火旺证');
  assert.equal(tb.textbookSubtypeSyndromeDisplay('淋证（血淋）', '血淋', `${hotUrine}尿痛轻微，腰酸，五心烦热。`).display, undefined);
  for (const [disease, name] of [['头痛','血虚头痛'],['淋证（石淋）','湿热蕴结证'],['哮病','冷哮证'],['泄泻','伤食泻'],['月经先期','阳盛血热证']]) {
    assert.equal(tb.textbookSubtypeSyndromeDisplay(disease, name, hotUrine), undefined);
  }
});
check('D18', '三处共用中性候选，本病且有成组证据才替换类目；稀疏尚沿用旧值', () => {
  const stomach = '胃脘胀，食后明显，嗳气频作。';
  assert.equal(tb.settledTextbookSyndromeName('胃痛', '气机失调证', stomach), '胃气不和证');
  assert.equal(tb.settledTextbookSyndromeName('头痛', '气机失调证', stomach), '气机失调证');
  assert.equal(tb.settledTextbookSyndromeName('胃痛', '气机失调证', '只有胃脘胀。'), '气机失调证');
  assert.equal(tb.settledTextbookSyndromeName('眩晕', '气机失调证', '发热，头晕。'), '气机失调证');
  assert.equal(neutral.supportedDiseaseNeutralName('汗证', '白天定时汗出。'), undefined);
  assert.match(neutral.diseaseNeutralPrompt(['胃痛'], stomach), /胃气不和证（胃脘胀、嗳气）/);
  const prompt = tb.buildTextbookCandidateContext({ chiefComplaint: '胃脘疼痛3天', recordText: stomach }, true);
  assert.match(prompt, /本病基本病机与中性证名[\s\S]*胃气不和证/);
  assert.equal(terms.governedSyndromeFromMechanismPhrases('感冒（湿滞中焦、气机不畅）', '感冒', '仅发热。'), '湿滞中焦证');
  assert.equal(terms.governedSyndromeFromMechanismPhrases('感冒（湿滞中焦）', '感冒', '发热。流涕。恶风。'), '风邪袭表证');
});
check('D19', '开关独立且单条可回退，不撤固定尾句的修复', () => {
  const controls = {
    CDSS_M03_DISEASE_DISABLED_RULES: () => assert.equal(refine(copd, '咳嗽', '肺胀'), undefined),
    CDSS_M03_DISEASE_REFINEMENT: () => assert.equal(tb.diseaseNameWithRecordSubtype('汗证', '白天汗出。'), '汗证'),
    CDSS_M03_SUBTYPE_SYNDROME_NAMES: () => assert.equal(tb.textbookSubtypeSyndromeDisplay('淋证（劳淋）', '劳淋', laborUrine), undefined),
    CDSS_M03_DISEASE_NEUTRAL_POLICY: () => assert.equal(tb.settledTextbookSyndromeName('胃痛', '气机失调证', '胃脘胀，嗳气。'), '气机失调证'),
  };
  for (const [key, run] of Object.entries(controls)) {
    const previous = process.env[key];
    try { process.env[key] = key.endsWith('DISABLED_RULES') ? 'copd-lung-distension' : 'false'; run(); }
    finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
  }
});
check('D20', '细分选病请求附实际命中项和教材闭集，未命中时无附加语料', () => {
  const state = { patient: { sex: '男', age: 60 }, chiefComplaint: copd.chiefComplaint, pastHistory: copd.pastHistory, symptoms: { presentHistory: copd.recordText }, conversation: [] };
  const request = pick.buildTextbookDiseasePickRequest(state);
  const supported = JSON.parse(request.messages[1].content).supportedRefinements;
  assert.deepEqual(supported.map((item) => item.name), ['肺胀']);
  assert.ok(request.allowed.has('肺胀'));
  assert.ok(supported[0].evidence.includes('COPD'));
  const other = pick.buildTextbookDiseasePickRequest({ ...state, pastHistory: '否认COPD。' });
  assert.equal(JSON.parse(other.messages[1].content).supportedRefinements, undefined);
  const his = pick.buildTextbookDiseasePickRequest({
    patient: { sex: '女', age: 64 }, chiefComplaint: '膝活动痛2年', symptoms: {}, conversation: [],
    hisRecord: { fields: { age: '64岁', fuzhuJiancha: '膝关节X线示退变。' } },
  });
  assert.deepEqual(JSON.parse(his.messages[1].content).supportedRefinements.map((item) => item.name), ['骨关节炎']);
});
check('D21', '治理数据 ID、教材行映射、国标属性及引文可回查', () => {
  const subtypes = json('tcm-textbook-disease-subtypes');
  const defined = json('tcm-disease-defining-findings');
  const policy = json('tcm-syndrome-name-policy');
  const rules = [...subtypes.evidenceRules, ...defined.refinements.filter((rule) => rule.id), ...defined.visitComplications];
  assert.equal(new Set(rules.map((rule) => rule.id)).size, rules.length);
  const corpusPath = '中医补充数据/灵丹GitHub/TCM Educational Materials.txt';
  const corpus = fs.existsSync(corpusPath) ? fs.readFileSync(corpusPath, 'utf8').split(/\r?\n/u) : undefined;
  const verifyQuote = ({ quote, line, book }) => {
    assert.ok(book && quote && line > 0, book);
    if (corpus) assert.ok(corpus.slice(line - 4, line + 4).join('').includes(quote.replace(/\r?\n/gu, '')), `${book}:${line}`);
  };
  for (const rule of rules) verifyQuote(rule.sourceRef);
  for (const [id, branches] of Object.entries(subtypes.syndromeDisplays)) {
    assert.ok(tb.textbookRowById(id)?.syndromeName);
    for (const branch of branches) {
      verifyQuote(branch.sourceRef);
      assert.equal(governance.resolveNationalStandardTcmSyndromeTerm(branch.displaySyndrome).standardTerm, branch.displaySyndrome);
      assert.ok(branch.groups.every((group) => group.length));
    }
  }
  for (const name of policy.neutralNames) {
    const result = governance.resolveTcmSyndromeTerm(name);
    assert.ok(governance.resolveNationalStandardTcmSyndromeTerm(name));
    assert.equal(result.entry.termClass === 'category_term', policy.categoryNames.includes(name), name);
  }
  for (const { sourceRef, candidates } of Object.values(policy.diseaseNeutralPolicy)) {
    verifyQuote(sourceRef);
    for (const { name, standardRef } of candidates) {
      assert.equal(governance.resolveTcmSyndromeTerm(name).entry.standardNumber, standardRef);
    }
  }
});

let failed = 0;
const selected = checks.filter(({ id }) => !process.env.R1067_DISEASE_ONLY || process.env.R1067_DISEASE_ONLY === id);
for (const { id, title, run } of selected) {
  try { await run(); console.log(`✓ ${id} ${title}`); }
  catch (error) { failed += 1; console.error(`✗ ${id} ${title}\n${error.stack}`); }
}
console.log(JSON.stringify({ total: selected.length, failed }));
if (failed) process.exitCode = 1;
