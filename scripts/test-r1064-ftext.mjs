// 第四十七轮 F1：全为合成片段；对应变异表 /var/tmp/r1064/cp/ftext.py。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { alias: { '@': `${process.cwd()}/src`, 'server-only': `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const summary = await jiti.import('../src/lib/diagnosis-visible-summary.ts');
const types = await jiti.import('../src/lib/diagnosis-types.ts');
const claims = await jiti.import('../src/lib/recorded-test-claims.ts');
const basis = await jiti.import('../src/lib/western-basis-authoring.server.ts');
const surface = await jiti.import('../src/lib/delivered-surface.ts');
const therapy = await jiti.import('../src/lib/tcm-therapy-phrasing.ts');
const coverage = await jiti.import('../src/lib/m03-method-coverage.server.ts');
const textbook = await jiti.import('../src/lib/tcm-textbook-syndromes.ts');
const terms = await jiti.import('../src/lib/clinical-terminology.ts');
const diff = await jiti.import('../src/lib/tcm-disease-differential-normalization.ts');
const closure = await jiti.import('../src/lib/analysis-element-closure.ts');
const patient = await jiti.import('../src/lib/m03-patient-claim-check.server.ts');
let count = 0, failed = 0;
async function check(id, title, fn) {
  if (process.env.FTEXT_ONLY && process.env.FTEXT_ONLY !== id) return;
  count++;
  try { await fn(); console.log(`✓ ${id} ${title}`); }
  catch (error) { failed++; console.error(`✗ ${id} ${title}\n${error.stack || error}`); }
}
const E = { evidenceLevel: 'model_inference', source: '本例资料', confidence: '中' };
const reasoning = () => ({ schemaVersion: 'tcm-cdss-reasoning-v2', stage: 'diagnose', formula: null, overview: { tcmDiseaseName: '胁痛', primarySyndrome: '湿热蕴结证', primarySyndromeResolution: 'resolved', primarySyndromeBasis: ['右侧胸肋部簇集水疱，灼痛'], secondarySyndromes: [], tcmDiseaseDifferentials: [], tcmDifferentials: [], overallPathogenesis: '湿热蕴结', overallTherapy: '清热利湿', evidence: E }, westernDiagnosis: { primary: { name: '带状疱疹', clinicalRationale: '单侧胸肋水疱，符合带状疱疹', evidence: E, status: '考虑', confidence: '中' }, candidates: [], differentials: [] }, pathogenesis: { summary: '湿热蕴结', locationDifferentiation: { items: ['胸胁', '肌肤'], details: [], resolution: 'bounded', evidence: E }, natureDifferentiation: { items: ['湿热', '毒'], rootDeficiency: [], branchExcess: ['湿热', '毒'], basis: '舌红苔黄腻', resolution: 'bounded', evidence: E }, chain: [], uncertainties: [] }, therapy: { overallMethod: '清热利湿', overallPrinciple: '热者寒之', subTherapies: [] } });
const wrap = x => `<!-- DIAGNOSIS_JSON_START -->${JSON.stringify(x)}<!-- DIAGNOSIS_JSON_END -->`;
const unwrap = s => JSON.parse(s.split('<!-- DIAGNOSIS_JSON_START -->')[1].split('<!-- DIAGNOSIS_JSON_END -->')[0]);
const settle = (name, text, record = '主诉：合成病历') => claims.settleWesternDiagnosisBasis(name, text, record);
await check('F01', '病性说明去重、有依据不说缺依据；无依据仍明示缺项', () => {
 const r = reasoning(), n = types.normalizeReasoningV2(r); assert.ok(n,types.reasoningV2SchemaIssueCode(r));
 // 第四十七轮终测：有逐字依据时不写说明（「病历依据尚待逐项核实」复核判机械句）；旧版写出的默认说明不沿用。
 assert.equal(n.pathogenesis.natureDifferentiation.resolutionReason, undefined);
 r.pathogenesis.natureDifferentiation.resolutionReason='病性“湿热、毒、湿热、毒”缺少可回溯的病历依据';
 assert.equal(types.normalizeReasoningV2(r).pathogenesis.natureDifferentiation.resolutionReason, undefined);
 r.pathogenesis.natureDifferentiation.resolutionReason='病性“湿热、毒”的病历依据尚待逐项核实';
 assert.equal(types.normalizeReasoningV2(r).pathogenesis.natureDifferentiation.resolutionReason, undefined);
 r.pathogenesis.natureDifferentiation.basis = '';
 assert.match(types.normalizeReasoningV2(r).pathogenesis.natureDifferentiation.resolutionReason, /尚缺直接/u);
});
await check('F02', '病位说明不计数；有依据时指明待核实病位', () => {
 const r=reasoning();r.pathogenesis.locationDifferentiation.details=[{location:'肌肤',basis:'水疱'}];
 const why=types.normalizeReasoningV2(r).pathogenesis.locationDifferentiation.resolutionReason;
 assert.match(why,/胸胁/u);assert.doesNotMatch(why,/目前只有|尚缺/u);
 r.pathogenesis.locationDifferentiation.resolutionReason='病位“胸胁、肌肤”目前只有1条病历依据支持';
 assert.doesNotMatch(types.normalizeReasoningV2(r).pathogenesis.locationDifferentiation.resolutionReason,/目前只有/u);
 r.pathogenesis.locationDifferentiation.details=[];assert.match(types.normalizeReasoningV2(r).pathogenesis.locationDifferentiation.resolutionReason,/尚缺/u);
});
await check('F03', '已接地的胸肋水疱支持直接病位；不据此反推胆', () => {
 const r=reasoning();r.pathogenesis.locationDifferentiation.items.push('胆');r.overview.primarySyndrome='肝胆湿热证';
 const n=unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(r),'右侧胸肋部簇集水疱，灼痛。舌红苔黄腻。'));
 assert.ok(n.pathogenesis.locationDifferentiation.details.some(x=>x.location==='胸胁'));
 assert.ok(n.pathogenesis.locationDifferentiation.details.some(x=>x.location==='肌肤'));
 assert.match(n.pathogenesis.locationDifferentiation.resolutionReason,/胆/u);
});
await check('F04', '表证已接地的成组见证支持卫表；一项不据以补表', () => {
 const r=reasoning();r.overview.primarySyndromeBasis=['怕冷，鼻塞，流清涕'];r.pathogenesis.locationDifferentiation.items=['卫表'];
 assert.equal(unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(r),'怕冷，鼻塞，流清涕。')).pathogenesis.locationDifferentiation.resolution,'resolved');
 r.overview.primarySyndromeBasis=['鼻塞'];assert.equal(unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(r),'鼻塞。')).pathogenesis.locationDifferentiation.resolution,'bounded');
 r.overview.primarySyndromeBasis=[];r.pathogenesis.chain=[{patientFact:'鼻塞',syndromeEvidence:'怕冷，流清涕'}];
 assert.equal(unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(r),'怕冷，鼻塞，流清涕。')).pathogenesis.locationDifferentiation.resolution,'resolved');
 assert.equal(unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(r),'鼻塞。')).pathogenesis.locationDifferentiation.resolution,'bounded');
 r.overview.primarySyndromeBasis=['脉浮紧'];r.pathogenesis.chain=[{patientFact:'喘息',syndromeEvidence:'昨夜外出受凉后气喘；怕冷、无汗、鼻塞流清涕'}];
 assert.equal(unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(r),'昨夜外出受凉后气喘，伴怕冷、无汗、鼻塞流清涕、头痛。脉象：浮紧。')).pathogenesis.locationDifferentiation.resolution,'resolved');
 r.pathogenesis.chain=[{patientFact:'喘息',syndromeEvidence:'否认怕冷、鼻塞流清涕'}];
 assert.equal(unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(r),'否认怕冷、鼻塞流清涕。脉浮紧。')).pathogenesis.locationDifferentiation.resolution,'bounded');
});
await check('F05', '西医考虑/成立/缺确认只保留一种确定度；临床可诊断且只缺病原时不降级', () => {
 const n=settle('过敏性鼻炎','鼻痒喷嚏，考虑过敏性鼻炎可能，诊断过敏性鼻炎成立，尚缺过敏原检测确认。');
 // R48：要点表可临床诊断，缺过敏原检测不降名。
 assert.equal(n.name,'过敏性鼻炎');assert.doesNotMatch(n.basis,/尚缺/u);
 assert.equal(settle('带状疱疹','单侧水疱，考虑带状疱疹可能，临床可诊断带状疱疹，尚缺病毒学确认病原。').name,'带状疱疹');
});
await check('F06', '方可确诊/方能确立决定待查；仅缺分型不影响病名', () => {
 for(const [name,text] of [['糖尿病酮症酸中毒','高血糖尿酮阳性，需血气证实酸中毒方可确诊糖尿病酮症酸中毒。'],['急性痛风性关节炎','关节急性红肿，需关节液检查确认急性痛风性关节炎。'],['急性冠脉综合征','持续胸痛，尚缺心肌肌钙蛋白，需结合检查分型，方能确立急性冠脉综合征。']]) assert.equal(settle(name,text).name,name === '急性痛风性关节炎' ? name : `${name}待查`,name);
 assert.equal(settle('鼻出血','鼻出血诊断成立；尚缺鼻内镜明确出血部位。').name,'鼻出血');
 assert.equal(settle('产后泌乳不足','乳汁量少，产后泌乳不足诊断已确立；尚缺甲状腺功能检查排除甲状腺功能异常。').name,'产后泌乳不足');
});
await check('F07', '本病不列需排除，不能同时排除和待排同一病；保留其它鉴别任务', () => {
 const a=settle('帕金森病','静止震颤，考虑帕金森病可能；需排除帕金森病；需排除甲亢。');assert.doesNotMatch(a.basis,/需排除帕金森病/u);assert.match(a.basis,/需排除甲亢/u);
 const variants=settle('帕金森病','运动迟缓，帕金森病诊断明确；需排除多系统萎缩、帕金森病痴呆。');assert.match(variants.basis,/帕金森病痴呆/u);
 const synonyms=settle('黄疸','黄疸病因待查；需排除溶血性黄疸、肝细胞性黄疸。');assert.match(synonyms.basis,/需排除溶血性黄疸、肝细胞性黄疸/u);
 const b=settle('婴儿型腹部绞痛','腹痛哭闹，可排除肠套叠等急腹症，诊断已确立；需排除牛奶蛋白过敏、肠套叠。');assert.doesNotMatch(b.basis,/可排除肠套叠/u);assert.match(b.basis,/需排除牛奶/u);
});
await check('F08', '本次已有甲功不改写成本次未复查；未查的检查保留', () => {
 const record='辅助检查：FT3 12pmol/L，FT4 35pmol/L，TSH降低。';
 const s=settle('甲亢','心悸多汗，既往已确诊甲亢，本次未复查甲状腺功能。',record);assert.doesNotMatch(s.basis,/未复查/u);
 assert.match(settle('甲亢','心悸多汗，本次未复查甲状腺功能。','心悸多汗。').basis,/未复查/u);
 assert.equal(settle('甲状腺功能亢进症','心悸多汗，尚缺甲状腺功能确认。','既往史：甲亢病史3年。').name,'甲状腺功能亢进症');
 assert.match(settle('脑梗死','肢体无力，本次未复查头颅MRI。','既往头颅MRI示陈旧性梗死。').basis,/未复查/u);
 assert.match(settle('十二指肠球部溃疡','反复腹痛，本次未复查胃镜。','既往史：2年前胃镜示十二指肠球部溃疡。辅助检查：本次未复查胃镜。').basis,/未复查胃镜/u);
});
await check('F09', '检查已见不能写缺X线/胆道影像；拟查不算已查', () => {
 assert.doesNotMatch(settle('膝关节骨关节炎','膝痛；尚缺膝关节X线，需X线确认。','辅助检查：膝关节X线示退变。').basis,/尚缺|需X线/u);
 assert.doesNotMatch(claims.withoutMissingClaimsForRecordedTests('发热黄疸；尚缺胆道影像学检查确认。','辅助检查：B超：胆总管扩张伴结石。'),/尚缺胆道/u);
 assert.match(claims.withoutMissingClaimsForRecordedTests('膝痛；尚缺膝关节X线。','处理：建议行膝关节X线。'),/尚缺/u);
 assert.match(claims.withoutMissingClaimsForRecordedTests('关节红肿；尚缺关节液尿酸盐结晶检查确认。','血尿酸550μmol/L。'),/尚缺关节液/u);
 assert.match(claims.withoutMissingClaimsForRecordedTests('膝痛；尚缺膝关节X线具体分级。','膝关节X线示退变，未给分级。'),/具体分级/u);
 assert.equal(claims.withoutMissingClaimsForRecordedTests('需排除甲状腺功能减退症、慢性肾脏病。','甲状腺功能正常。'),'需排除甲状腺功能减退症、慢性肾脏病。');
 assert.equal(claims.withoutMissingClaimsForRecordedTests('需结合TSH、FT4确认。','辅助检查：TSH降低，FT4升高。'),'需结合TSH、FT4确认。');
 assert.doesNotMatch(claims.withoutMissingClaimsForRecordedTests('白带异常；尚缺湿片等检查确认。','辅助检查：白带常规：滴虫阴性。'),/尚缺湿片/u);
});
await check('F10', '多年血压升高且在治不降为首次确诊待查；否认或停药不算在治', () => {
 const s=settle('原发性高血压待查','血压升高数年，考虑原发性高血压可能；尚缺三次非同日测量确认。','主诉：发现血压升高4年\n用药史：缬沙坦80mg每日一次\n血压148/94mmHg');
 assert.equal(s.name,'原发性高血压');assert.doesNotMatch(s.basis,/可能|尚缺/u);
 const payload=reasoning();payload.westernDiagnosis.primary={...payload.westernDiagnosis.primary,name:'原发性高血压待查',clinicalRationale:'血压持续升高，尚缺三次非同日测量确认。'};payload.westernDiagnosis.candidates=[{name:'原发性高血压待查'}];
 const restored=JSON.parse(basis.withNameMatchingBasisCertainty(JSON.stringify(payload),'血压升高4年\n用药史：缬沙坦80mg每日一次'));assert.equal(restored.westernDiagnosis.candidates[0].name,'原发性高血压');assert.equal(restored.westernDiagnosis.differentials.length,0);
 assert.equal(claims.recordStatesTreatedHypertension('高血压','血压升高4年\n用药史：否认服用缬沙坦'),false);
 assert.equal(claims.recordStatesTreatedHypertension('高血压','血压升高4年\n用药史：缬沙坦已停用半年'),false);
});
await check('F11', '急慢性病名与成句结论一致，不编写相反的病程结论', () => {
 const a=settle('急性荨麻疹','风团瘙痒；病程2周，按慢性荨麻疹考虑。');assert.doesNotMatch(a.basis,/按慢性/u);assert.match(a.basis,/病程2周/u);
 const b=settle('慢性荨麻疹','反复风团8周，按慢性荨麻疹考虑。');assert.match(b.basis,/按慢性/u);
});
await check('F12', '服务端定稿与交付投影使用同一西医确定度', () => {
 const r=reasoning();r.westernDiagnosis.primary.name='急性痛风性关节炎';r.westernDiagnosis.primary.clinicalRationale='关节红肿热痛；尚缺关节液检查确认急性痛风性关节炎。';
 const a=JSON.parse(basis.withNameMatchingBasisCertainty(JSON.stringify(r),'关节红肿热痛。'));
 const b=surface.projectDeliveredReasoning(r,{recordText:'关节红肿热痛。'});
 // R48：痛风按诊断要点表可临床诊断，两条定稿路径一致。
 assert.equal(a.westernDiagnosis.primary.name,'急性痛风性关节炎');assert.equal(b.westernDiagnosis.primary.name,a.westernDiagnosis.primary.name);
 assert.equal(surface.projectDeliveredReasoning(b,{recordText:'关节红肿热痛。'}).westernDiagnosis.primary.name,b.westernDiagnosis.primary.name);
});
await check('F13', '无出路/无所/无从属固定搭配，不变成未诉；真正未记录阴性仍改写', () => {
 for(const s of ['水无出路','无所适从','无从判断']) {
  assert.equal(summary.unrecordedNegativesAsNotReported(s,'小便量少。'),s);
  assert.equal(patient.negativeClaimAsNotReported(s,'小便量少。'),undefined);
 }
 assert.equal(summary.unrecordedNegativesAsNotReported('无头痛','口干。'),'未诉头痛');
});
await check('F14', '正常肯定陈述不会接续前项否认，也不转成未诉', () => {
 const r=reasoning();r.westernDiagnosis.differentials=[{name:'疱疹性口炎',distinguishingPoints:'本例无发热、呕吐腹泻、精神好，暂无全身感染征象'}];
 const s=summary.groundDifferentialNegativeAssertions(wrap(r),'无发热、呕吐腹泻。精神反应好。');
 assert.doesNotMatch(s,/未记录精神|未诉精神/u);
 assert.equal(patient.negativeClaimAsNotReported('精神反应好','口腔白屑。'),undefined);
 assert.equal(summary.withoutDenialsOfRecordedFindings('未诉精神好','精神反应好。'),'');
 assert.equal(summary.withoutDenialsOfRecordedFindings('未诉精神好','精神反应差。'),'未诉精神好');
});
await check('F15', '已记录的反酸否认/热敷减轻不再问未记录；未记录对照照问', () => {
 assert.equal(closure.uncertaintyAnsweredByRecord('有无泛酸嗳气','无反酸烧心。'),false);
 assert.deepEqual(closure.uncertaintyWithRecordedAnswers({item:'有无泛酸嗳气',reason:'病历未记录'},'无反酸烧心。'),{item:'嗳气',reason:'尚需核实嗳气'});
 assert.equal(closure.uncertaintyAnsweredByRecord('寒热喜恶','热敷减轻。'),true);
 assert.deepEqual(closure.uncertaintyWithRecordedAnswers({item:'饮食二便',reason:'未记录食欲与二便'},'神疲食少。'),{item:'二便',reason:'尚需核实二便'});
 assert.equal(closure.uncertaintyAnsweredByRecord('寒热喜恶','仅记膝痛。'),false);
 assert.equal(closure.uncertaintyAnsweredByRecord('寒热喜恶与上肢麻木','热敷减轻。'),false);
 assert.equal(closure.uncertaintyAnsweredByRecord('饮食药物','神疲食少。'),false);
 assert.equal(closure.uncertaintyAnsweredByRecord('小便色量','小便量偏少。'),false);
 assert.equal(closure.uncertaintyAnsweredByRecord('小便情况','无大小便异常。'),true);
 assert.equal(closure.uncertaintyAnsweredByRecord('冷汗肢温未记','皮肤湿冷。'),true);
 const r=reasoning();r.pathogenesis.uncertainties=[{item:'寒热喜恶',reason:'病历未记录',affects:'病性'}];
 assert.equal(surface.projectDeliveredReasoning(r,{recordText:'热敷减轻。'}).pathogenesis.uncertainties.length,0);
});
await check('F16', '正常舌脉句逐项核对；薄腻弦脉不能被说成薄白平缓', () => {
 const s='舌淡红、苔薄白、脉平缓等正常所见不参与辨证。气机郁滞。';
 assert.equal(summary.withoutUnrecordedNormalCommentary(s,'舌淡红，苔薄腻，脉弦。'),'气机郁滞。');
 assert.equal(summary.withoutUnrecordedNormalCommentary(s,'舌淡红，苔薄白，脉平缓。'),s);
 assert.equal(summary.withoutUnrecordedNormalCommentary(s,'舌淡红，苔薄白腻，脉平缓而无力。'),'气机郁滞。');
 assert.equal(summary.withoutNormalFindingSegments('舌淡红，苔白'),'');
 assert.equal(summary.withoutNormalFindingSegments('舌淡红，苔白腻'),'舌淡红，苔白腻');
});
await check('F17', '虚证已有病性要素归本虚，实证不凭空补虚', () => {
 const r=reasoning();r.overview.primarySyndrome='心阳欲脱证';r.pathogenesis.natureDifferentiation={items:['阳虚','气脱'],rootDeficiency:[],branchExcess:['阳虚','气脱'],basis:'大汗，四肢冰冷',resolution:'bounded',evidence:E};
 const n=unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(r),'大汗，四肢冰冷。'));
 assert.deepEqual(n.pathogenesis.natureDifferentiation.rootDeficiency,['阳虚','气脱']);assert.deepEqual(n.pathogenesis.natureDifferentiation.branchExcess,[]);
 assert.equal(unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(reasoning()),'舌红苔黄腻。')).pathogenesis.natureDifferentiation.rootDeficiency.length,0);
});
await check('F18', '肩关节周围炎按教材原句交付漏肩风；颈椎病不冒充中医鉴别', () => {
 assert.equal(terms.textbookSectionDeliveryName('肩关节周围炎'),'漏肩风');
 assert.equal(terms.canonicalTcmDiseaseName('肩关节周围炎',{overview:{primarySyndrome:'风寒湿痹证'},westernDiagnosis:{primary:{name:'肩周炎'}}}),'漏肩风');
 assert.equal(diff.resolveTcmDiseaseDifferentialName('颈椎病','漏肩风').action,'drop');
 assert.equal(diff.resolveTcmDiseaseDifferentialName('痿证','痹证').action,'keep');
 assert.equal(diff.resolveTcmDiseaseDifferentialName('白喉','口疮').action,'keep');
 assert.equal(diff.resolveTcmDiseaseDifferentialName('虱病','瘾疹').action,'keep');
 assert.equal(diff.resolveTcmDiseaseDifferentialName('吐血','咳嗽').action,'keep');
 // 第四十九轮P5有意改口径：教材映射已补骨关节炎→骨痹，鉴别交付规范中医名；不再因原节名为西医名丢弃。
 assert.deepEqual(diff.resolveTcmDiseaseDifferentialName('骨关节炎','痹证'),{action:'rename',name:'骨痹',from:'骨关节炎'});
 assert.equal(terms.textbookSectionDeliveryName('黄疸'),'黄疸');
 assert.equal(terms.textbookSectionDeliveryName('虚脱'),'虚脱');
});
await check('F19', '交付面的中医鉴别也过同一病名过滤', () => {
 const r=reasoning();r.overview.tcmDiseaseName='漏肩风';r.overview.tcmDiseaseDifferentials=[{diseaseName:'颈椎病',reason:'肩臂疼痛'},{diseaseName:'痿证',reason:'活动受限'},{diseaseName:'自拟鉴别病',reason:'凑数'}];
 const n=surface.projectDeliveredReasoning(r,{recordText:'主诉：肩臂疼痛。'});assert.ok(!n.overview.tcmDiseaseDifferentials.some(x=>x.diseaseName==='颈椎病'));assert.ok(n.overview.tcmDiseaseDifferentials.some(x=>x.diseaseName==='痿证'));assert.ok(!n.overview.tcmDiseaseDifferentials.some(x=>x.diseaseName==='自拟鉴别病'));
});
await check('F20', '典型表现不用英文西医定义和扫描残字，完整中文教材句保留', () => {
 for(const name of ['萎黄','肠结','白疕','猩红热']) assert.doesNotMatch(textbook.textbookDiseaseTypicalManifestation(name),/[A-Za-z■�]|巴细胞升高|扁平苔薛/u,name);
 assert.ok(textbook.textbookDiseaseTypicalManifestation('胃痛').length>10);
});
await check('F21', '受治理治法同义去重；寒痰/热痰、止痛与散寒不混同', () => {
 for(const s of ['镇肝息风，平肝息风','息风潜阳，平肝息风','滋养胃阴，滋阴生津','养阴增液，滋阴生津','益气补血，养血生发','补气养血，佐以通乳，通络下乳']) assert.ok(therapy.withoutRedundantTherapyPhrases(s).split('，').length<s.split('，').length,s);
 assert.equal(therapy.withoutRedundantTherapyPhrases('清热化痰，温化寒痰'),'清热化痰，温化寒痰');
 assert.equal(therapy.withoutRedundantTherapyPhrases('行气止痛，温经散寒'),'行气止痛，温经散寒');
});
await check('F22', '补项与合并按同一同义判据，通乳不重复补', () => {
 assert.equal(coverage.methodItemQualifies({item:'通络下乳',quotes:[],fromModel:true},{method:'补气养血，通乳',recordText:'产后乳少。'}),false);
 assert.equal(coverage.methodItemQualifies({item:'疏肝理气',quotes:[],fromModel:true},{method:'补气养血',recordText:'乳少，胸胁胀满。'}),true);
 const n=JSON.parse(coverage.withVerifiedMethodItemFrom(JSON.stringify({therapy:{overallMethod:'益气补血'}}),JSON.stringify({therapy:{verifiedMethodItem:'养血生发'}})));assert.equal(n.therapy.overallMethod,'益气补血');
});
await check('F23', '升阳救逆来自教材补充表原文，不因复核意见换成回阳救逆', () => {
 const table=JSON.parse(fs.readFileSync('src/data/tcm-textbook-syndrome-supplement.source.json','utf8'));
 const row=table.rows.find(x=>x.id==='supplement|虚脱|神陷气脱');assert.equal(row.therapy,'益气固脱，升阳救逆');assert.ok(row.sources.some(x=>x.includes('143272')));
});
console.log(JSON.stringify({checks:count,failed}));
if(failed)process.exitCode=1;
