// 第四十七轮 F3：合成夹具；不复制 p100c/retest 病历。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { alias: { '@': `${process.cwd()}/src`, 'server-only': `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` }, moduleCache: false });
const load = name => jiti.import(`../src/lib/${name}.ts`);
const safety = await load('diagnosis-safety'), types = await load('diagnosis-types'), state = await load('clinical-state'), polarity = await load('clinical-polarity');
const criteria = await load('western-diagnostic-criteria.server'), refs = await load('western-guideline-references'), evidence = await load('western-evidence-policy');
const required = await load('required-precautions.server'), surface = await load('delivered-surface'), population = await load('population-matched-precautions'), boundary = await load('candidate-boundary-text');
const lineage = await load('lineage-formula-wording'), plan = await load('tcm-nondrug-textbook-plan.server'), capabilities = await load('tcm-treatment-capabilities.server');
const parity=JSON.parse(fs.readFileSync("scripts/fixtures/r1064-fmisc-population-medication.json","utf8"));
let count = 0;
const check = async (id, title, run) => { if (process.env.FMISC_CHECK && process.env.FMISC_CHECK !== id) return; count++; try { await run(); console.log(`✓ ${id} ${title}`); } catch (e) { console.error(`✗ ${id} ${title}\n ${e.stack}`); process.exitCode = 1; } };
const patient = (text, { age = 31, sex = '女', past = '', medication = '未服药' } = {}) => types.normalizeCaseStateInput({ chiefComplaint: text, patient: { age, sex }, symptoms: { 现病史: text, 既往史: past, 用药史: medication }, tongue: '舌淡，苔薄白', pulse: '脉细弱', vitals: { T: '36.5', P: '78', R: '18', BP: '112/72' } });
const base = () => ({ schemaVersion: 'tcm-cdss-reasoning-v2', stage: 'diagnose', overview: { tcmDiseaseName: '不寐', primarySyndrome: '阴虚火旺证', secondarySyndromes: [], tcmDiagnosticRationale: '夜寐不安，属阴虚火旺证。', recommendedFormulaDirection: '六味地黄丸合交泰丸加减' }, pathogenesis: { chain: [] }, therapy: { overallPrinciple: '虚则补之', overallMethod: '滋阴降火' }, westernDiagnosis: { primary: { name: '慢性失眠' } }, formula: { candidates: [], modifications: [] }, nonPharma: { precautions: [] } });
await check('1.1', '本地最终回填亦核题，不沿症状借指南', () => {
  for (const [name, title] of [['上消化道出血','眩晕急诊诊断与治疗专家共识'],['高血压','眩晕急诊诊断与治疗专家共识'],['妊娠呕吐','闭经诊断与治疗指南'],['紧张型头痛','前庭性偏头痛诊断标准'],['过敏性休克','中国荨麻疹诊疗指南']]) {
    assert.equal(refs.westernGuidelineTitleMatches(name, title), false);
    assert.ok(refs.finalWesternGuidelineReferences(name, []).every(r => refs.westernGuidelineTitleMatches(name, r.citation)), name);
  }
  assert.deepEqual(criteria.westernGuidelineReferencesForName('高血压病'), [], '非指南科普标题不能成为本地兜底');
  assert.ok(criteria.westernGuidelineReferencesForName('紧张型头痛').length);
});
await check('1.2', '急慢性互斥；无来源与非白名单均空', () => {
  assert.equal(evidence.westernEvidenceTitleMatches('慢性咳嗽诊疗指南', ['急性咳嗽']), false);
  assert.equal(evidence.westernEvidenceTitleMatches('化疗相关腹泻共识',['腹泻']),false);
  assert.equal(evidence.westernEvidenceTitleMatches('功能性消化不良诊疗共识',['消化不良']),false);
  assert.equal(evidence.westernEvidenceTitleMatches('扁桃体咽炎',['慢性咽炎']),false);
  assert.equal(evidence.westernEvidenceTitleMatches('扁桃体咽炎',['急性咽炎']),true);
  assert.equal(evidence.westernEvidenceTitleMatches('失眠共病阻塞性睡眠呼吸暂停指南',['慢性失眠']),false);
  assert.equal(evidence.westernEvidenceTitleMatches('荨麻疹指南比较分析',['荨麻疹']),false);
  assert.deepEqual(refs.finalWesternGuidelineReferences('急性上呼吸道感染', [{ evidenceId:'x', citation:'ERS chronic cough', url:'https://www.nice.org.uk/x' }]).filter(r=>r.evidenceId==='x'), []);
  assert.deepEqual(refs.finalWesternGuidelineReferences('不存在的合成病名', []), []);
  assert.ok(!refs.finalWesternGuidelineReferences('紧张型头痛', [{ evidenceId:'fake', citation:'紧张型头痛指南', url:'https://bad.example/a' }]).some(r=>r.evidenceId==='fake'));
});
await check('2.1', '旧孕晚期不再覆盖当前哺乳通道；真实孕周仍优先', () => {
  const s = patient('剖宫产后25天，正在哺乳，乳汁不足。', { past:'既往史：体健；孕晚期贫血。' });
  assert.equal(state.assessPregnancyState(safety.clinicalGroundingText(s)).status, 'historical');
  assert.equal(safety.doseRestrictionFollowupTarget(s)?.pathway, 'lactation_review');
  assert.doesNotMatch(safety.priorityEvaluationFirstStep(safety.doseRestrictionFollowupTarget(s)), /孕周|孕期/u);
  assert.doesNotMatch(safety.priorityEvaluationFirstStep(safety.doseRestrictionFollowupTarget(s)), /确认哺乳情况|孩子月龄/u);
  assert.match(safety.priorityEvaluationFirstStep(safety.doseRestrictionFollowupTarget(s)), /婴儿观察/u);
  assert.equal(state.assessPregnancyState('既往史：高血压；目前妊娠12周').status, 'positive');
});
await check('2.2', '绝经年龄与结扎统一关闭常规提示，阴性与计划手术不算', () => {
  for (const [text,age] of [['49岁绝经',55],['已行输卵管结扎',38],['双侧输卵管切除',42],['绝经3年',52]]) {
    const s = patient(text, { age }); assert.equal(safety.pregnancyAdviceRelevant(s), false, text);
    assert.equal(safety.medicationPopulationAudience(s).pregnancy, false, text);
    assert.deepEqual(population.populationMatchedPrecautions(['如已怀孕或备孕，请告知医生。'],s), []);
  }
  for(const set of Object.values(parity.sets))for(const row of set.menopause)assert.equal(state.recordExcludesPregnancyPotential(row.text,row.age),row.excluded,row.text);
  for(const text of ['未行输卵管结扎','计划输卵管结扎','左侧输卵管切除','单侧输卵管结扎']) assert.equal(state.recordExcludesPregnancyPotential(text,38),false);
  assert.equal(state.recordExcludesPregnancyPotential('51岁绝经',51),false);
  assert.equal(safety.pregnancyAdviceRelevant(patient('输卵管结扎后，目前宫内妊娠8周')),true);
});
await check('2.3', '已知哺乳必写直接用药及婴儿观察提示，交付幂等', () => {
  const s = patient('产后11天，现纯母乳喂养。'); const items = required.requiredPrecautionsForCase(s);
  assert.ok(items.some(i=>i.kind==='postpartum_lactation' && i.confirmed));
  assert.match(required.requiredPrecautionsPromptSection(items),/孕期提示须另有当前妊娠事实/u);
  const r = {...base(),stage:'prescribe',nonPharma:{precautions:['如已怀孕或备孕请告知医生。','如正在哺乳请先告知医生。']}};
  const out = surface.projectDeliveredReasoning(r,{ caseState:s, requiredPrecautions:items }); const text=out.nonPharma.precautions.join('');
  const labelled=surface.projectDeliveredReasoning({...r,formula:{candidates:[{name:'自拟方',herbs:[{name:'桂枝',dose:'6g'}]}],modifications:[]}}, {caseState:s,requiredPrecautions:items});
  assert.ok(labelled.formula.candidates.some(c=>c.herbs.some(h=>h.name==='桂枝')), '反证夹具须保留所核药味');
  assert.ok(!labelled.nonPharma.precautions.some(line=>/桂枝哺乳期(?:须|需)?慎用/u.test(line)), '不得把药表已过滤的功效分类条重新写成哺乳慎用');
  assert.match(text,/您正在哺乳/u); assert.match(text,/婴儿/u); assert.doesNotMatch(text,/如正在哺乳|怀孕|备孕/u);
  assert.deepEqual(surface.projectDeliveredReasoning(out,{caseState:s,requiredPrecautions:items}),out);
});
await check('2.4', '孕哺标签分开，与卡片共用适用人群', () => {
  const a=safety.medicationPopulationAudience(patient('产后2月，正在哺乳。'));
  assert.equal(boundary.herbBoundaryPopulationRelevant('哺乳期',a),true);
  assert.equal(boundary.herbBoundaryPopulationRelevant('孕期/妊娠',a),false);
  assert.equal(boundary.followupSignsForPopulation('请在3天内面诊，确认哺乳情况、孩子月龄与哺乳期用药。',a),'请在3天内面诊，确认哺乳情况、孩子月龄与哺乳期用药。');
  assert.equal(safety.reproductiveAdviceRelevant(patient('已行输卵管结扎')),true);
  const tied=safety.medicationPopulationAudience(patient('已行输卵管结扎'));
  assert.equal(plan.cardTextForPopulation('妊娠期禁用。经期暂停。',true,tied),'经期暂停。');
  assert.equal(plan.cardTextForPopulation('妊娠期禁用。',false,tied),'');
  const previous=process.env.TCM_CLINIC_TREATMENT_CAPABILITIES;process.env.TCM_CLINIC_TREATMENT_CAPABILITIES='acupuncture,auricular';
  try {
    const r=base();r.contractSignatureVersion='tcm-cdss-m03-signature-v5';r.contractSignature='hmac-sha256:'+'1'.repeat(64);r.overview.tcmDiseaseName='乳痈';r.overview.primarySyndrome='肝郁胃热证';r.westernDiagnosis.primary.name='急性乳腺炎';r.therapy.overallPrinciple='实则泻之';r.therapy.overallMethod='疏肝清胃，通乳消肿';r.pathogenesis.chain=[{nodeId:'P1',patientFact:'乳房胀痛，乳汁淤积，头痛',syndromeEvidence:'舌红苔黄',pathogenesis:'肝郁胃热，乳络壅滞',therapyDirection:'疏肝清胃，通乳消肿'}];
    const cards=capabilities.compileTcmTreatmentRecommendations([{projectCode:'acupuncture',targetRef:'P1'}],r,patient('产后25天，正在哺乳，乳汁淤积，乳房红肿胀痛，伴头痛，舌红苔黄。'));
    assert.ok(cards.some(x=>x.projectCode==='acupuncture' && x.suggestedSitesOrPoints.some(p=>/肩井|合谷|三阴交/u.test(p))), '夹具须实际进入孕期敏感穴提示守卫');
    assert.doesNotMatch(JSON.stringify(cards),/怀孕|孕期|妊娠/u);
  } finally {if(previous===undefined)delete process.env.TCM_CLINIC_TREATMENT_CAPABILITIES;else process.env.TCM_CLINIC_TREATMENT_CAPABILITIES=previous;}

  const b=safety.medicationPopulationAudience(patient('妊娠18周'));
  assert.equal(boundary.herbBoundaryPopulationRelevant('孕期/妊娠',b),true);
  assert.equal(boundary.herbBoundaryPopulationRelevant('哺乳期',b),false);
  const both=safety.medicationPopulationAudience(patient('目前妊娠10周，仍在哺乳。'));
  assert.equal(both.pregnancy,true);assert.equal(both.lactation,true);
});
await check('3.1', '视角句与影响决策共用方名判据，不改模型适配结论', () => {
  const r=base(); r.overview.tcmDiagnosticRationale += '丹溪看阴虚相火，选大补阴丸加减。';
  r.lineageAdaptation={applicable:'applicable',influencedDecisions:[{aspect:'方源选择',detail:'选大补阴丸加减'}]};
  const out=lineage.lineageWordingMatchingDirection(r);
  assert.doesNotMatch(out.overview.tcmDiagnosticRationale,/大补阴丸/u);
  assert.deepEqual(out.lineageAdaptation.influencedDecisions,[]); assert.equal(out.lineageAdaptation.applicable,'applicable');
  const delivered=surface.projectDeliveredReasoning(r); assert.doesNotMatch(delivered.overview.tcmDiagnosticRationale,/大补阴丸/u);
  const rx={...base(),stage:'prescribe',formula:{candidates:[{name:'酸枣仁汤',herbs:[]}],modifications:[]}};
  rx.overview.tcmDiagnosticRationale += '丹溪重阴虚相火，选六味地黄丸合交泰丸。';
  assert.doesNotMatch(lineage.lineageWordingMatchingDirection(rx).overview.tcmDiagnosticRationale,/六味地黄丸/u, 'M04按实际交付方核对，不能只认M03方向');
});
await check('3.2', '交付同方与明确未采用的比较保留；提示要求非经方理由', () => {
  const r=base();r.overview.tcmDiagnosticRationale += '丹溪看阴虚相火，未用大补阴丸，选六味地黄丸合交泰丸。';
  assert.equal(lineage.lineageWordingMatchingDirection(r).overview.tcmDiagnosticRationale,r.overview.tcmDiagnosticRationale);
  r.overview.tcmDiagnosticRationale += '经方思路看寒热，故不取甘草汤、桔梗汤类方。';
  assert.equal(lineage.lineageWordingMatchingDirection(r).overview.tcmDiagnosticRationale,r.overview.tcmDiagnosticRationale);
  const prompts=fs.readFileSync('src/lib/diagnosis-prompts.ts','utf8');assert.ok(prompts.includes('解释经方候选为何没有方证相合者'));
  assert.ok(fs.readFileSync('src/lib/m03-tcm-narrative.server.ts','utf8').includes('解释经方候选为何没有方证相合者'));
});
await check('4.1', '吸入剂调量残片不是药名，具体药名保留', () => {
  assert.deepEqual(polarity.recordedMedicationMentions('自行将吸入剂加至每日5次').names,[]);
  assert.equal(polarity.cleanedMedicationNameCandidate('剂加至'),'');
  assert.deepEqual(polarity.recordedMedicationMentions('吃较多肉丸后腹胀').names,[]);
  assert.equal(polarity.cleanedMedicationNameCandidate('乌鸡白凤丸'),'乌鸡白凤丸');
  assert.equal(polarity.medicationHistoryItemCandidate('降压药').candidate,'降压药');
  assert.equal(polarity.medicationHistoryItemCandidate('吸入剂加至每日5次').candidate,'');
  assert.ok(polarity.recordedMedicationMentions('现吸入布地奈德，每日2次').names.includes('布地奈德'));
});
await check('4.2', '一年以前的疗程和本次未服药不算现用，继续与重启有反例', () => {
  for(const set of Object.values(parity.sets))for(const row of set.medication)assert.equal(polarity.recordedMedicationMentions(row.text).names.includes(row.name),row.current,row.text);
  const text='1年前口服左氧氟沙星5天。本次发病以来未服药。';
  assert.deepEqual(polarity.recordedMedicationMentions(text).names,[]);
  assert.equal(polarity.medicationOnlyPastMentions(text,'左氧氟沙星'),'past');
  const items=required.requiredPrecautionsForCase(patient(text));
  assert.ok(!items.some(i=>i.kind==='current_medications' && i.names.includes('左氧氟沙星')));
  assert.ok(polarity.recordedMedicationMentions('1年前开始口服氨氯地平，长期规律服用至今。').names.includes('氨氯地平'));
  assert.ok(polarity.recordedMedicationMentions('1年前服阿莫西林。本次重新口服阿莫西林。').names.includes('阿莫西林'));
});
await check('4.3', '旧结果的现用药清单须复核，编译、交付及可见正文一致', async () => {
  const current = await load('current-medication-precautions'), compiler = await load('m04-proposal-compiler'), visible = await load('diagnosis-visible-summary');
  const line = name => `正在服用的${name}请告知医生，是否继续服用、与本方如何错开服用由医生决定。`;
  const record = '1年前口服左氧氟沙星5天。本次未服药。自行将吸入剂加至每日5次。';
  for(const name of ['剂加至','肉丸','左氧氟沙星']) assert.deepEqual(current.currentMedicationPrecautions([line(name)],record),[]);
  const control = '1年前开始服用氨氯地平，长期规律服用至今。';
  assert.deepEqual(current.currentMedicationPrecautions([line('氨氯地平')],control),[line('氨氯地平')]);
  assert.deepEqual(current.currentMedicationPrecautions([line('降压药')],'长期服用降压药'),[line('降压药')]);
  const warning='您正在服用华法林，须观察出血并复查INR。';
  assert.deepEqual(current.currentMedicationPrecautions([warning],record),[warning], '只匹配封闭清单句式');
  const s=patient(record), precautions=[line('剂加至'),line('左氧氟沙星'),'吸入药不得自行加量。'];
  const r={...base(),stage:'prescribe',nonPharma:{precautions}};
  const projected=surface.projectDeliveredReasoning(r,{caseState:s});
  assert.doesNotMatch(projected.nonPharma.precautions.join(''),/剂加至|左氧氟沙星/u);
  assert.ok(projected.nonPharma.precautions.includes('吸入药不得自行加量。'));
  const cached=surface.projectDeliveredReasoning(r,{recordText:record});
  assert.doesNotMatch(cached.nonPharma.precautions.join(''),/剂加至|左氧氟沙星/u);
  const wrapped=`# 候选方药\n### 注意事项\n${precautions.map(x=>'- '+x).join('\n')}\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(r)}\n<!-- DIAGNOSIS_JSON_END -->`;
  // 对应 diagnosis-api 最终交付时已有的投影后重渲染，不另增句内修补。
  const rendered=visible.synchronizeVisibleClinicalSummary(surface.applyDeliveredSurfaceToContent(wrapped,{caseState:s}),'prescribe','',s);
  assert.doesNotMatch(rendered.split('<!-- DIAGNOSIS_JSON_START -->')[0],/剂加至|左氧氟沙星/u);
  assert.match(rendered,/吸入药不得自行加量/u);
  const proposal={candidate:{name:'本例辨证组方',herbs:[{name:'麦冬',dose:'10g',role:'君',processing:null,targetKind:'pathogenesis_node',targetRef:'P1'}],decoction:{doseCount:'3剂',dosesPerDay:1,administrationTimesPerDay:2,course:'3日'}},nonPharma:{diet:'规律饮食。',lifestyle:'规律作息。',emotion:'保持心情舒畅。',precautions},modifications:[]};
  const compiled=compiler.compileM04Proposal(proposal,base(),s);assert.ok(compiled);
  assert.doesNotMatch(compiled.nonPharma.precautions.join(''),/剂加至|左氧氟沙星/u);
});
await check('5.1', '恢复/后遗症期不交付开窍强刺激，按已签名气虚删点名泻法', () => {
  assert.equal(plan.strokeRecoveryCard(['中风'],['脑梗死后遗症'],'肢体无力45天'),true);
  assert.equal(plan.strokeRecoveryCard(['中风后遗症'],['脑梗死'],'肢体活动不利'),true);
  assert.equal(plan.strokeRecoveryCard(['中风'],['急性脑梗死'],'肢体无力2小时'),false);
  const text='水沟用雀啄法，以眼球湿润为度；内关用捻转泻法；尺泽提插泻法，使肢体抽动；三阴交用提插补法。';
  const out=plan.manipulationMatchedToSyndrome(text,'气虚血瘀证','扶正祛邪',true);
  assert.doesNotMatch(out,/雀啄|抽动|泻法/u);assert.match(out,/提插补法/u);
  assert.match(plan.manipulationMatchedToSyndrome('留针用补法。','痰火扰心证','实则泻之'),/泻法/u);
  const tooth=plan.textbookTreatmentPlan({projectCode:'acupuncture',diseaseNames:['牙痛'],westernNames:[],signedSyndromeText:'虚火上炎证',signedPrinciple:'虚则补之',currentFacts:'牙齿隐痛，午后加重，齿龈微红'});
  assert.match(tooth.techniqueBoundary,/泻法/u);assert.match(tooth.techniqueBoundary,/太溪用补法/u);assert.doesNotMatch(tooth.techniqueBoundary,/针用补法/u);
});
await check('5.2', '教材恢复期方案同步去开窍穴并保留原文依据', () => {
  const p=plan.textbookTreatmentPlan({ projectCode:'acupuncture', diseaseNames:['中风'], westernNames:['脑梗死后遗症'],signedSyndromeText:'气虚血瘀证', signedPrinciple:'扶正祛邪',signedMethod:'益气活血通络', chiefComplaint:'左侧肢体无力8个月',currentFacts:'左侧偏瘫，言语謇涩，神疲乏力，舌淡紫，脉细涩。',patientAgeYears:71 });
  assert.ok(p); assert.ok(!p.points.some(x=>x.name==='水沟'));assert.doesNotMatch(p.techniqueBoundary,/雀啄|抽动|提插泻法/u);
  const policy=JSON.parse(fs.readFileSync('src/data/tcm-stroke-recovery-card-policy.source.json','utf8'));assert.ok(policy.quotes.some(x=>x.includes('恢复期及后遗症期')));
});
await check('6.1', '当前抗凝排除针刺、埋针所在耳穴及全部有创项目；停药不触发', () => {
  const r=base(),s=patient('心悸半年',{age:68,medication:'华法林长期口服'});
  assert.equal(safety.currentAntithromboticTherapyRecorded(s),true);
  for(const code of ['acupuncture','auricular','thread_embedding','bloodletting','needle_knife','tuina','cupping','guasha']) assert.match(capabilities.tcmTreatmentProjectExclusionReason(code,r,s)||'',/抗凝/u,code);
  assert.doesNotMatch(capabilities.tcmTreatmentProjectExclusionReason('acupuncture',r,patient('心悸',{medication:'华法林已停药2年'}))||'',/正在使用抗凝/u);
});
await check('6.2', '抗凝伴出血不推荐艾灸，稳定无出血对照保留', () => {
  const r=base();r.overview.primarySyndrome='气血亏虚证';r.therapy.overallMethod='益气养血';const s=patient('月经量多，近两天经血增多，头晕。',{medication:'华法林长期服用'});
  s.symptoms.辅助检查='INR 3.5，Hb 100g/L';
  assert.match(capabilities.tcmTreatmentProjectExclusionReason('moxibustion',r,s)||'',/出血/u);
  assert.doesNotMatch(capabilities.tcmTreatmentProjectExclusionReason('moxibustion',r,patient('乏力，无出血。',{medication:'华法林长期服用'}))||'',/正在使用抗凝/u);
});
console.log(`${count} checks; failures=${process.exitCode||0}`);
