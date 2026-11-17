// D3，合成病例；现有判据任务用可注入桩，不调用模型、不读取运行时密钥。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { alias: { '@': `${process.cwd()}/src`, 'server-only': `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const element = await jiti.import('../src/lib/m03-syndrome-element-closure.server.ts');
const legacy = await jiti.import('../src/lib/m03-element-support.server.ts');
const textbook = await jiti.import('../src/lib/tcm-textbook-syndromes.ts');
const governance = await jiti.import('../src/lib/clinical-governance-tables.ts');
let failed = 0, checks = 0;
const check = async (id, title, run) => {
  if (process.env.R1066_ONLY && process.env.R1066_ONLY !== id) return;
  checks++;
  try { await run(); console.log(`✓ ${id} ${title}`); } catch (e) { failed++; console.error(`✗ ${id} ${title}\n${e.stack}`); }
};
const make = (primary = '血虚证', natures = ['血虚', '气虚']) => ({
  schemaVersion: 'tcm-cdss-reasoning-v2', stage: 'diagnose',
  overview: { tcmDiseaseName: '产后身痛', primarySyndrome: primary, primarySyndromeResolution: 'resolved', secondarySyndromes: [],
    tcmDiagnosticRationale: `面白、舌淡、脉细为血虚；少气懒言、神疲乏力、动则加剧为气虚；故辨为${primary}。`,
    overallPathogenesis: '血虚失养，筋脉不荣；气虚不能充养筋脉', overallTherapy: '补血，益气', recommendedFormulaNames: ['黄芪桂枝五物汤'],
    tcmDifferentials: [{ syndrome: '气血两虚证', reason: `与${primary}均可见疲倦` }, { syndrome: '血瘀证', reason: `与${primary}鉴别` }] },
  pathogenesis: { natureDifferentiation: { items: natures, rootDeficiency: natures, branchExcess: [], basis: '少气懒言；舌淡' },
    locationDifferentiation: { items: [], details: [] },
    chain: [{ patientFact: '肢体疼痛', pathogenesis: '血虚失养，筋脉不荣', therapyDirection: '补血' }, { patientFact: '少气懒言、神疲乏力', pathogenesis: '气虚不能充养筋脉', therapyDirection: '益气' }],
    uncertainties: [{ item: '是否兼气虚', reason: '尚待核实', affects: '益气' }] },
  therapy: { overallMethod: '补血，益气', subTherapies: [{ therapy: '益气', targetPathogenesis: '气虚不能充养筋脉' }] },
});
const context = { recordText: '主诉：产后肢体疼痛。现病史：少气懒言，神疲乏力，动则加剧，面色淡白。舌象：舌淡白。脉象：脉细。' };
const verdict = (entry, v = 'pass', strict = true) => ({ verdict: v, entry, strict, specific: 2, category: 1, listed: 0, distinct: 3, quotes: ['少气懒言','神疲乏力','动则加剧'] });
const decide = (r, v = 'pass', ctx = context, strict = true) => element.decideElementSupport(JSON.stringify(r), ctx, undefined, async (entry) => verdict(entry, v, strict));
const apply = async (r, v = 'pass', ctx = context, strict = true) => JSON.parse(element.applyElementSupportDecision(JSON.stringify(r), await decide(r, v, ctx, strict)));
await check('E01', '台账读取三病性栏、断言、治法和病位，合称最长匹配', () => {
  const r = make(); r.pathogenesis.natureDifferentiation.branchExcess = ['血瘀']; r.therapy.overallMethod = '滋阴，化痰'; r.pathogenesis.locationDifferentiation.items = ['肾'];
  const rows = element.syndromeElementLedger(r);
  for (const type of ['气虚','血虚','stasis','阴虚','phlegm','location']) assert.ok(rows.some((u) => u.type === type), type);
  assert.ok(rows.find((u) => u.type === '气虚').sources.includes('rationale'));
  assert.ok(legacy.deficiencyMentions('气阴两伤，阳气虚脱，心阳欲脱，阴精亏虚').flatMap((u) => u.types).includes('阴虚'));
});
await check('E02', '虚实蕴含精确，气血两虚不蕴含阴虚，阳虚涵盖气虚', () => {
  assert.equal(element.entailedElements(['气血两虚证']).has('阴虚'), false);
  for (const type of ['气虚','阳虚','water']) assert.ok(element.entailedElements(['阳虚水泛证']).has(type), type);
  assert.ok(element.entailedElements(['气滞血瘀证']).has('stasis'));
  assert.ok(element.entailedElements(['痰气互结证']).has('qi-stagnation'));
  assert.ok(element.entailedElements(['肝肾两虚证']).has('阳虚'));
  assert.equal(element.entailedElements(['气血两虚证']).has('heat'), false);
});
await check('E03', '否认与流派视角不作为本例的阳虚/瘀断言', () => {
  const r = make('血虚证', ['血虚']); r.pathogenesis.chain = [];
  r.overview.tcmDiagnosticRationale = '舌淡示血虚；未见阳虚之象；无瘀血之征；扶阳学派从阳虚阴盛看本例；气虚未甚。'; r.therapy.overallMethod = '补血';
  const rows = element.syndromeElementLedger(r);
  assert.ok(!rows.some((u) => ['阳虚','stasis','气虚'].includes(u.type)));
});
await check('E04', '血虚加气虚成组改气血两虚，依据鉴别同步，方与治法不变', async () => {
  const r = make(); const out = await apply(r);
  assert.equal(out.overview.primarySyndrome, '气血两虚证');
  assert.match(out.overview.tcmDiagnosticRationale, /辨为气血两虚证/);
  assert.deepEqual(out.overview.tcmDifferentials, [{syndrome:'血瘀证',reason:'与气血两虚证鉴别'}]);
  assert.deepEqual(out.overview.recommendedFormulaNames, r.overview.recommendedFormulaNames);
  assert.equal(out.therapy.overallMethod, r.therapy.overallMethod);
  assert.equal(out.pathogenesis.uncertainties.length, 0);
});
await check('E05', '气虚加血虚的反向合称', async () => {
  assert.equal((await apply(make('气虚证'))).overview.primarySyndrome, '气血两虚证');
});
await check('E06', '气虚加血瘀复合名，活动出血只核证不绕过安全层', async () => {
  const r = make('气虚证',['气虚','血瘀']); r.overview.tcmDiagnosticRationale = '疼痛固定为血瘀；故属气虚证。'; r.pathogenesis.chain = []; r.therapy.overallMethod = '益气，化瘀';
  assert.equal((await apply(r, 'pass', {recordText:'皮下瘀斑，疼痛固定，舌有瘀点，脉涩。'})).overview.primarySyndrome, '气虚血瘀证');
});
await check('E07', '没有合称则以判据条目立兼证，保留已有独立兼证', async () => {
  const r = make('心虚胆怯证',['气虚','血虚']); r.overview.secondarySyndromes = ['痰湿证'];
  r.overview.tcmDiagnosticRationale = '面色淡白、唇甲色淡为肝血不足；故属心虚胆怯证。'; r.pathogenesis.chain = []; r.therapy.overallMethod = '镇惊定志，养血';
  const out = await apply(r);
  assert.deepEqual(out.overview.secondarySyndromes, ['痰湿证','肝血虚证']);
  r.overview.secondarySyndromes=['痰湿证','水湿证'];
  assert.deepEqual((await apply(r)).overview.secondarySyndromes,['痰湿证','水湿证','肝血虚证']);
  r.overview.secondarySyndromes=Array.from({length:6},(_,i)=>`已有独立证${i}`);
  assert.equal((await apply(r)).overview.secondarySyndromes.length,6);
  r.overview.secondarySyndromes=['痰湿证'];r.therapy.overallMethod='镇惊定志';
  assert.match((await apply(r)).therapy.overallMethod,/养血/);
});
await check('E08', '未知判定完全不动，并且失败的小任务不冒充不成立', async () => {
  const r = make(); const raw = JSON.stringify(r);
  assert.equal(element.applyElementSupportDecision(raw, await decide(r, 'unknown')), raw);
  const d = await element.decideElementSupport(raw, context, undefined, async () => { throw Error('stub unavailable'); });
  assert.equal(element.applyElementSupportDecision(raw, d), raw);
});
await check('E09', '仅宽路径通过不能立兼证，仍保持成组证据口径', async () => {
  const r = make(); assert.equal((await apply(r, 'pass', context, false)).overview.primarySyndrome, '血虚证');
});
await check('E10', '不成立从各病性栏、治法与病机撤回，病历表现保留且不造待核实', async () => {
  const r = make(); r.overview.tcmDiagnosticRationale += '是否兼气虚尚待核实。'; const out = await apply(r, 'fail');
  assert.deepEqual(out.pathogenesis.natureDifferentiation.items, ['血虚']);
  assert.deepEqual(out.pathogenesis.natureDifferentiation.rootDeficiency, ['血虚']);
  assert.equal(out.therapy.overallMethod, '补血');
  assert.deepEqual(out.therapy.subTherapies, []);
  assert.equal(out.pathogenesis.chain.length, 1);
  assert.doesNotMatch(out.overview.tcmDiagnosticRationale, /为气虚|需核实|是否兼气虚/);
  assert.match(out.overview.tcmDiagnosticRationale, /少气懒言、神疲乏力、动则加剧/);
  assert.deepEqual(out.pathogenesis.uncertainties, []);
});
await check('E11', '只有依据/治法写到的证素也核对，不受旧两虚一实的数量上限', async () => {
  const r = make('气虚证', ['气虚']); r.pathogenesis.chain = []; r.overview.tcmDiagnosticRationale = '痰浊为痰证之象；口黏为湿邪之征；疼痛固定为血瘀之象。'; r.therapy.overallMethod = '养血，滋阴，化饮，利水';
  const d = await decide(r);
  for (const type of ['血虚','阴虚','phlegm','damp','stasis','fluid','water']) assert.ok(d.elements.some((u) => u.unit.type === type), type);
});
const organCase = () => {
  const r = make('脾阳虚衰证',['阳虚']); r.overview.tcmDiseaseName='水肿'; r.overview.tcmDiagnosticRationale='畏寒、便溏为脾阳虚；腰膝冷痛为肾阳不足；故属脾阳虚衰证。';
  r.pathogenesis.chain=[]; r.therapy.overallMethod='温阳利水';
  r.pathogenesis.locationDifferentiation={items:['脾','肾'],details:[{location:'脾',basis:'便溏'},{location:'肾',basis:'腰膝冷痛、夜尿多'}]}; return r;
};
const organContext = {recordText:'便溏，腰膝冷痛，夜尿多。'};
await check('E12', '脏腑补入合称须两条肯定原文，脾肾阳虚不改原方', async () => {
  const out = await apply(organCase(),'pass',organContext);
  assert.equal(out.overview.primarySyndrome,'脾肾阳虚证');
});
await check('E13', '另一脏腑依据只有一条则各栏撤回，不写需核实肾', async () => {
  const r=organCase();r.pathogenesis.locationDifferentiation.details[1].basis='腰膝冷痛';
  const out=await apply(r,'unknown',organContext);
  assert.deepEqual(out.pathogenesis.locationDifferentiation.items,['脾']);
  assert.doesNotMatch(out.overview.tcmDiagnosticRationale,/肾阳不足|需核实肾/);
});
await check('E14', '无脏腑合称/无可用判据不擅自删除病位', async () => {
  const r=make();r.pathogenesis.locationDifferentiation={items:['肝'],details:[]};
  assert.deepEqual((await apply(r,'unknown')).pathogenesis.locationDifferentiation,r.pathogenesis.locationDifferentiation);
});
const collapseContext = { recordText:'胸痛持续不缓解，大汗淋漓，皮肤湿冷，面色苍白。血压80/50mmHg，心率120次/分。', gateRedFlags:['急性心血管事件'], caseState:{patient:{age:60,sex:'男'},vitals:{bloodPressure:'80/50',pulse:'120'}} };
const collapseCase = () => {
  const r=make('气滞血瘀证',['血瘀','阳脱']); r.overview.tcmDiseaseName='真心痛';r.overview.tcmDiagnosticRationale='大汗淋漓、皮肤湿冷为心阳欲脱之象；胸痛为血瘀阻络。';r.pathogenesis.chain=[];r.therapy.overallMethod='回阳固脱';return r;
};
await check('E15', '确定性红旗+休克体征+分析脱证，真心痛优先本病脱证教材行', async () => {
  const out=await apply(collapseCase(),'unknown',collapseContext);
  assert.match(out.overview.primarySyndrome,/脱证$/);
  assert.ok(textbook.textbookFormulaRowsForDisease('真心痛').some((r)=>r.syndromeName===out.overview.primarySyndrome));
  assert.ok(out.overview.secondarySyndromes.includes('气滞血瘀证'));
  const prior=collapseCase();prior.overview.secondarySyndromes=['痰湿证','寒湿证'];
  assert.deepEqual((await apply(prior,'unknown',collapseContext)).overview.secondarySyndromes,['痰湿证','寒湿证','气滞血瘀证']);
  const highPressure={...collapseContext,gateRedFlags:['循环不稳定'],recordText:'胸痛持续不缓解，大汗淋漓，面色苍白。',caseState:{patient:{age:60,sex:'男'},vitals:{BP:'150/95',P:'108'}}};
  assert.match((await apply(collapseCase(),'fail',highPressure)).overview.primarySyndrome,/脱证$/);
  const cardiacOnly={...collapseContext,recordText:'胸痛持续不缓解，大汗。',caseState:{patient:{age:60,sex:'男'}}};
  assert.match((await apply(collapseCase(),'unknown',cardiacOnly)).overview.primarySyndrome,/脱证$/);
});
await check('E16', '缺红旗、缺成组体征、缺分析断言均不升级脱证', async () => {
  for (const ctx of [{...collapseContext,gateRedFlags:[]},{...collapseContext,recordText:'胸痛，大汗。',caseState:{vitals:{bloodPressure:'125/80',pulse:'80'}}}]) {
    assert.equal((await apply(collapseCase(),'unknown',ctx)).overview.primarySyndrome,'气滞血瘀证');
  }
  const r=collapseCase();r.overview.tcmDiagnosticRationale='胸痛为血瘀。';r.pathogenesis.natureDifferentiation.items=['血瘀'];r.pathogenesis.natureDifferentiation.rootDeficiency=[];r.therapy.overallMethod='活血化瘀';
  assert.equal((await apply(r,'unknown',collapseContext)).overview.primarySyndrome,'气滞血瘀证');
});
await check('E17', '原病无脱证教材行则补国标脱证兼证', async () => {
  const r=collapseCase();r.overview.tcmDiseaseName='瘾疹';r.overview.secondarySyndromes=['痰湿证','寒湿证'];
  const out=await apply(r,'unknown',collapseContext);
  assert.ok(out.overview.secondarySyndromes.some((s)=>governance.resolveNationalStandardTcmSyndromeTerm(s)&&/脱/u.test(s)));
  assert.deepEqual(out.overview.secondarySyndromes.slice(0,2),['痰湿证','寒湿证']);
});
await check('E18', '并行兼证核对已立同一证，撤回时重读实际证名', async () => {
  const r=make();const d=await decide(r,'fail');r.overview.secondarySyndromes=['气虚证'];
  assert.deepEqual(JSON.parse(element.applyElementSupportDecision(JSON.stringify(r),d)).pathogenesis.natureDifferentiation.items,['血虚','气虚']);
});
await check('E19', '原教材行可按新增合称回查，避免合称丢掉方药依据', () => {
  const row=textbook.textbookRowForSyndrome('产后身痛','气血两虚证');
  assert.ok(row); assert.equal(row.syndromeName,'血虚证');
});
await check('E20', '真实路由接入统一台账并传入确定性红旗与生命体征', () => {
  const route=fs.readFileSync(new URL('../src/app/api/diagnosis/diagnose/route.ts',import.meta.url),'utf8');
  assert.match(route, /from "@\/lib\/m03-syndrome-element-closure.server"/);
  assert.match(route,/caseState: safeState, gateRedFlags: gated.safetyGate\?\.redFlags/);
});
await check('E21', '新合称需国标命名，重复运行幂等', async () => {
  const r=make(); const d=await decide(r);const once=element.applyElementSupportDecision(JSON.stringify(r),d);
  assert.equal(element.applyElementSupportDecision(once,d),once);
  assert.ok(governance.resolveNationalStandardTcmSyndromeTerm(JSON.parse(once).overview.primarySyndrome));
});
await check('E22', '模板式主证充分吻合时沿用既有兼证闸门，避免标准病例改名', async () => {
  const r=make('风寒束表证',['风寒','湿']);r.overview.tcmDiseaseName='感冒';r.pathogenesis.chain=[];r.overview.tcmDiagnosticRationale='舌苔白腻为湿邪；恶寒无汗为风寒束表。';r.therapy.overallMethod='辛温解表';
  const ctx={recordText:'恶寒重，发热轻，无汗，头身疼痛，肢节酸痛，鼻塞，流清涕，咳嗽，痰稀薄色白，舌苔薄白，脉浮紧。'};
  const d=await decide(r,'pass',ctx);assert.equal(d.protectedByPrimary,true);
  assert.equal(JSON.parse(element.applyElementSupportDecision(JSON.stringify(r),d)).overview.primarySyndrome,'风寒束表证');
  assert.deepEqual(JSON.parse(element.applyElementSupportDecision(JSON.stringify(r),d)).overview.secondarySyndromes,[]);
});
await check('E23', '撤回合称中的一项，仍保留主证病性与相邻治法', async () => {
  const r=make();r.overview.tcmDiseaseName='';r.pathogenesis.natureDifferentiation.items=['气血两虚'];r.therapy.overallMethod='补血益气，通络止痛';
  const out=await apply(r,'fail');
  assert.deepEqual(out.pathogenesis.natureDifferentiation.items,['血虚']);
  assert.equal(out.therapy.overallMethod,'补血，通络止痛');
});
await check('E24', '营卫不和无可用国标复合名时，成组后立规范兼证', async () => {
  const r=make('肺卫不固证',['表虚']);r.overview.tcmDiseaseName='汗证';r.pathogenesis.chain=[];r.overview.tcmDiagnosticRationale='一阵冷一阵热为营卫不和；故属肺卫不固证。';r.therapy.overallMethod='调和营卫';
  const out=await apply(r,'pass',{recordText:'一阵冷一阵热。'});
  assert.ok(out.overview.secondarySyndromes.includes('营卫不和证'));
});
await check('E25', '治理表中的合称运行时仍须国标可解析，查不到不使用', () => {
  assert.equal(element.nationalElementCompositeName({composite:'未收录的合称证'}),undefined);
  assert.equal(element.nationalElementCompositeName({composite:'气血两虚证'}),'气血两虚证');
});
await check('E26', '实邪判据名不是国标名时用既有合法兼证名，湿热仍过组合判据', async () => {
  const r=make('气虚证',['气虚','湿']);r.pathogenesis.chain=[];r.overview.tcmDiagnosticRationale='肢体困重、苔白腻为湿邪；故属气虚证。';r.therapy.overallMethod='益气祛湿';
  const out=await apply(r,'pass',{recordText:'肢体困重，苔白腻，脉濡。'});
  assert.deepEqual(out.overview.secondarySyndromes,['湿浊内蕴证']);
  r.pathogenesis.natureDifferentiation.items=['气虚','湿热'];r.pathogenesis.natureDifferentiation.rootDeficiency=['气虚','湿热'];r.overview.tcmDiagnosticRationale='苔黄腻、口苦为湿热内蕴；故属气虚证。';
  const d=await decide(r,'pass',{recordText:'苔黄腻，口苦。'});
  assert.equal(d.elements.find(x=>x.unit.type==='damp').unit.entryName,'湿热证');
  const mixed=JSON.parse(element.applyElementSupportDecision(JSON.stringify(r),d));
  assert.deepEqual(mixed.overview.secondarySyndromes,['湿热证']);
});
await check('E27', '未收录病性及官窍病位也记账，无判据保留并且不发核对任务', async () => {
  const r=make('血虚证',['血虚','燥','未分类病性']);r.pathogenesis.chain=[];r.pathogenesis.natureDifferentiation.rootDeficiency=['血虚'];r.overview.tcmDiagnosticRationale='面白、舌淡为血虚。';r.therapy.overallMethod='补血';r.pathogenesis.locationDifferentiation={items:['目'],details:[]};
  const rows=element.syndromeElementLedger(r);
  assert.ok(rows.some(x=>x.type==='unmapped'&&x.label==='燥'));
  assert.ok(rows.some(x=>x.type==='location'&&x.organs.includes('目')));
  let calls=0;const raw=JSON.stringify(r);const d=await element.decideElementSupport(raw,{recordText:'面色淡白，舌淡。'},undefined,async()=>{calls++;return verdict('血虚证','unknown');});
  assert.equal(calls,0);
  assert.ok(d.elements.every(x=>x.verdict.verdict==='unknown'));
  assert.equal(element.applyElementSupportDecision(raw,d),raw);
});
await check('E28', '撤回保留否认句、完整表现与共治治法，不把命名蕴含当病性造词', async () => {
  const r=make('血虚证',['血虚','湿']);r.pathogenesis.chain=[];r.overview.tcmDiagnosticRationale='舌淡红、苔薄白示无明显寒热与湿浊之象；故属血虚证。';r.therapy.overallMethod='补血';
  const deniedOut=await apply(r,'fail');assert.match(deniedOut.overview.tcmDiagnosticRationale,/无明显寒热与湿浊之象/);assert.deepEqual(deniedOut.pathogenesis.natureDifferentiation.items,['血虚']);
  r.pathogenesis.natureDifferentiation.items=['血虚','气滞'];r.pathogenesis.natureDifferentiation.rootDeficiency=['血虚'];r.overview.tcmDiagnosticRationale='舌淡红苔薄、脉弦提示气机不畅，故属血虚证。';
  const text=(await apply(r,'fail')).overview.tcmDiagnosticRationale;assert.match(text,/脉弦/);assert.doesNotMatch(text,/脉弦提/);
  const collapse=make('气脱证',['气虚','阳脱']);collapse.pathogenesis.chain=[];collapse.overview.tcmDiagnosticRationale='大汗为阳脱之象。';collapse.therapy.overallMethod='益气固脱';
  assert.deepEqual((await apply(collapse,'fail')).pathogenesis.natureDifferentiation.items,['气虚']);
  const water=make('阳虚证',['阳虚','水湿']);water.pathogenesis.chain=[];water.overview.tcmDiagnosticRationale='肢体浮肿为水湿之象。';water.therapy.overallMethod='温阳';
  const waterRaw=JSON.stringify(water);const wd=await element.decideElementSupport(waterRaw,context,undefined,async(name)=>verdict(name,name==='饮证'?'unknown':'fail'));assert.deepEqual(JSON.parse(element.applyElementSupportDecision(waterRaw,wd)).pathogenesis.natureDifferentiation.items,['阳虚']);
  const organ=make('脾虚痰盛证',['气虚','痰']);organ.pathogenesis.chain=[];organ.overview.tcmDiseaseName='肥胖';organ.overview.tcmDiagnosticRationale='纳少为脾气虚；胃脘不适、反胃为胃气虚。';organ.pathogenesis.locationDifferentiation={items:['脾','胃'],details:[{location:'胃',basis:'反胃'}]};organ.therapy.overallMethod='健脾和胃';
  const od=await decide(organ,'unknown',{recordText:'纳少，胃脘不适、反胃。'});const oo=element.applyElementSupportDecision(JSON.stringify(organ),od);assert.match(JSON.parse(oo).overview.tcmDiagnosticRationale,/胃脘不适、反胃/);assert.equal(JSON.parse(oo).therapy.overallMethod,'健脾和胃');assert.equal(element.applyElementSupportDecision(oo,od),oo);
});
await check('E29', '肝风/内热及仅祛风治法不误套外风判据，明确外风仍可核对命名', async () => {
  const r=make('脾虚肝旺证',['气虚','肝风','内热']);r.pathogenesis.chain=[];r.overview.tcmDiagnosticRationale='纳少便溏为脾虚。';r.therapy.overallMethod='健脾，祛风';
  let calls=[];const raw=JSON.stringify(r);const d=await element.decideElementSupport(raw,{recordText:'纳少便溏，肢体抽动。'},undefined,async(name)=>{calls.push(name);return verdict(name,'unknown');});
  assert.deepEqual(calls,[]);assert.equal(element.applyElementSupportDecision(raw,d),raw);
  r.pathogenesis.natureDifferentiation.items=['气虚','风'];r.pathogenesis.natureDifferentiation.rootDeficiency=['气虚'];r.overview.tcmDiagnosticRationale='恶风、汗出为风邪外袭。';calls=[];
  const positive=await element.decideElementSupport(JSON.stringify(r),{recordText:'恶风，汗出，脉浮缓。'},undefined,async(name)=>{calls.push(name);return verdict(name);});
  assert.ok(calls.includes('风淫证'));
  assert.ok(JSON.parse(element.applyElementSupportDecision(JSON.stringify(r),positive)).overview.secondarySyndromes.includes('外风证'));
  assert.equal(element.entailedElements(['风燥伤肺证']).get('wind'),'any');
  assert.equal(element.entailedElements(['风火攻目证']).get('wind'),'any');
});
await check('E30', '治法逐项读，另一治法的脏腑不误归证素，插脏腑动宾形态仍识别', async () => {
  const r=make('肝血虚证',['血虚']);r.pathogenesis.chain=[];r.overview.tcmDiagnosticRationale='面色淡白、脉细为肝血虚。';r.therapy.overallMethod='健脾养血';
  const d=await decide(r,'unknown');assert.equal(d.elements.filter(x=>x.unit.type==='血虚').length,0);
  r.overview.primarySyndrome='气虚证';r.overview.tcmDiagnosticRationale='乏力为气虚。';r.pathogenesis.natureDifferentiation.items=['气虚'];r.pathogenesis.natureDifferentiation.rootDeficiency=['气虚'];r.therapy.overallMethod='益气，养肝血，滋肾阴';
  const rows=element.syndromeElementLedger(r);assert.ok(rows.some(x=>x.type==='血虚'&&x.organs.includes('肝')));assert.ok(rows.some(x=>x.type==='阴虚'&&x.organs.includes('肾')));
  r.therapy.overallMethod='益气养肝血';r.overview.tcmDiseaseName='';const out=await apply(r,'fail');assert.equal(out.therapy.overallMethod,'益气');
});
await check('E31', '无力是肯定表现，后置未见不算证素断言，失败仍保留原始表现与否认', async () => {
  const r=make('血虚证',['血虚','气虚']);r.pathogenesis.chain=[];r.therapy.overallMethod='补血';
  r.overview.tcmDiagnosticRationale='脉沉细无力为血虚气弱；阴虚火旺、相火妄动之象未见。';
  const ledger=element.syndromeElementLedger(r);assert.ok(ledger.some(x=>x.type==='气虚'&&x.sources.includes('rationale')));assert.ok(!ledger.some(x=>x.type==='阴虚'));
  const out=await apply(r,'fail');assert.doesNotMatch(out.overview.tcmDiagnosticRationale,/气弱/);assert.match(out.overview.tcmDiagnosticRationale,/脉沉细无力/);assert.match(out.overview.tcmDiagnosticRationale,/阴虚火旺、相火妄动之象未见/);
});
console.log(JSON.stringify({checks,failed}));process.exitCode=failed?1:0;
