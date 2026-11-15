// 第四十七轮 S4a：急症分支检索、阶段用方、缺口闭集与跨病方名身份。全为合成病例。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createJiti } from 'jiti';
process.env.CDSS_TEXTBOOK_DISEASE_PICK='false';
process.env.CDSS_FORMULA_TRUST_MODEL='true';
const jiti=createJiti(import.meta.url,{alias:{'@':`${process.cwd()}/src`,'server-only':`${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`}});
const types=await jiti.import('../src/lib/diagnosis-types.ts');
const emergency=await jiti.import('../src/lib/tcm-emergency-candidates.ts');
const table=await jiti.import('../src/lib/tcm-textbook-syndromes.ts');
const stage=await jiti.import('../src/lib/textbook-formula-stage.ts');
const indications=await jiti.import('../src/lib/tcm-formula-indications.ts');
const provenance=await jiti.import('../src/lib/tcm-formula-provenance.ts');
const prompts=await jiti.import('../src/lib/diagnosis-prompts.ts');
const pick=await jiti.import('../src/lib/textbook-disease-pick.server.ts');
const facts=await jiti.import('../src/lib/clinical-facts.ts');
let failures=0;let checks=0;
const check=async(id,label,run)=>{checks++;try{await run();console.log(`✓ ${id} ${label}`);}catch(e){failures++;console.error(`✗ ${id} ${label}\n${e.stack||e}`);}};
const state=(record,flag='循环灌注不足',extra={})=>{
 const s=types.normalizeCaseStateInput({id:'r1064-emerg-synthetic',chiefComplaint:extra.chief||record,patient:{age:extra.age??45,sex:extra.sex||'女'},symptoms:{现病史:record},tongue:extra.tongue||'',pulse:extra.pulse||''});
 s.safetyGate={status:flag?'red_flag':'ready',redFlags:flag?[flag]:[],missingItems:[],allowDiagnosis:true,allowDosePrescription:true};return s;
};
const ids=s=>emergency.emergencyTextbookCandidates(s).map(x=>x.rowId);
const reasoning=(disease='痹证',syndrome='风热犯表证',formula='银翘散')=>({stage:'diagnose',schemaVersion:'tcm-cdss-reasoning-v2',overview:{tcmDiseaseName:disease,primarySyndrome:syndrome,primarySyndromeResolution:'bounded',secondarySyndromes:[],recommendedFormulaDirection:`${formula}加减`,recommendedFormulaNames:[formula],formulaSelectionMode:'single',overallTherapy:'辛凉解表，清热解毒'},therapy:{overallMethod:'辛凉解表，清热解毒',subTherapies:[]},pathogenesis:{chain:[],locationDifferentiation:{items:[]},natureDifferentiation:{items:[]}},lineageAdaptation:{applicable:'partial'}});
const shock=state('输液后过敏，胸闷气憋，面色苍白，四肢厥冷，冷汗淋漓，脉微欲绝。','急性过敏反应伴循环灌注不足');
await check('1.1','50 个映射行可达，34 个主表行只覆盖一次且保留组成与逐字出处',()=>{
 const map=JSON.parse(fs.readFileSync('src/data/tcm-emergency-redflag-map.source.json','utf8'));
 const all=[...new Set(map.flatMap(x=>x.candidateRows))];assert.equal(all.length,50);
 for(const id of all)assert.ok(table.textbookRowById(id),id);
 const row=table.textbookRowById('fuke|异位妊娠|气血亏脱证');assert.equal(row.formulaStage,'手术止血后辅助治疗');assert.ok(row.composition.includes('当归'));assert.ok(row.evidence.some(e=>e.quote.includes('术后再辅以')));
 const rows=table.textbookFormulaRowsForDisease('异位妊娠');assert.equal(rows.filter(r=>r.id===row.id).length,1);
});
await check('1.2','过敏性休克提升气脱，普通皮疹、否认和既往表现均不提升',()=>{
 assert.ok(ids(shock).includes('supplement|虚脱|神陷气脱'));
 assert.deepEqual(ids(state('风团瘙痒，神志清楚，无胸闷，无冷汗，无四肢厥冷。','急性过敏反应')),[]);
 assert.ok(!ids(state('本次接触过敏原后风团瘙痒，否认胸闷气憋，无冷汗，无面色苍白，无四肢厥冷。','急性过敏反应')).includes('supplement|虚脱|神陷气脱'));
 assert.ok(!ids(state('既往过敏性休克伴胸闷气憋、面色苍白、冷汗淋漓。现仅风团瘙痒。','急性过敏反应')).includes('supplement|虚脱|神陷气脱'));
 const cardiac=state('持续胸痛，胸闷气憋，面色苍白，冷汗淋漓，脉微欲绝。');cardiac.allergyHistory='无已知药物过敏';
 assert.ok(!ids(cardiac).includes('supplement|虚脱|神陷气脱'));
});
await check('1.3','无红旗不提升；单有红旗但分支表现不符不提升',()=>{
 const s=structuredClone(shock);s.safetyGate.status='ready';assert.deepEqual(ids(s),[]);
 assert.deepEqual(ids(state('皮疹瘙痒。','低血压/休克风险')),[]);
});
await check('1.4','置顶候选进入 M03 并附病历依据；空模型选病仍能补急症病名',async()=>{
 const c=emergency.emergencyTextbookCandidates(shock);assert.equal(emergency.withEmergencyDiseasesFirst(['瘾疹'],c)[0],'虚脱');
 assert.equal((await pick.pickTextbookDiseasesForCase(shock))[0],'虚脱');
 const context=prompts.buildDiagnosePrompt(shock,{textbookDiseasePicks:['瘾疹']});
 assert.ok(context.includes('【急症辨证候选优先】'));assert.ok(context.includes('病历有「'));assert.ok(context.indexOf('◆ 虚脱')<context.indexOf('◆ 瘾疹'));
 assert.ok(context.includes('气脱证'));
});
await check('1.5','休克与异位妊娠表现相符才提升，男性不进妇产候选',()=>{
 const record='停经，突发下腹剧痛，阴道流血，腹腔积液，面色苍白，冷汗淋漓。';
 assert.ok(ids(state(record,'异位妊娠破裂伴循环不稳定')).includes('zxy_fuchanke|异位妊娠|休克型——气陷血脱证（输卵管妊娠破裂）'));
 assert.ok(!ids(state(record,'异位妊娠破裂伴循环不稳定',{sex:'男'})).some(x=>x.includes('异位妊娠')));
});
await check('1.6','DKA 阴伤/阴竭按表现分支，单纯高糖不强配危象证',()=>{
 assert.ok(ids(state('烦渴，唇红舌干，呼吸深快。','酮症酸中毒')).includes('supplement|糖尿病|阴伤阳浮'));
 assert.ok(ids(state('口干，舌燥少津，呼吸深大。','酮症酸中毒')).includes('supplement|糖尿病|阴伤阳浮'));
 assert.ok(ids(state('神昏，肢厥，脉微细。','酮症酸中毒')).includes('supplement|糖尿病|阴竭阳亡'));
 assert.deepEqual(ids(state('多饮多尿，神志清楚。','酮症酸中毒')),[]);
 const low=state('血糖1.8mmol/L，神昏，肢厥，脉微细。','严重代谢紊乱');
 low.clinicalFacts={redFlags:[{category:'metabolic',subject:'patient',status:'positive',urgency:'emergency',triageBasis:'other_immediate_threat',quote:'血糖1.8mmol/L，神昏，肢厥，脉微细'}]};
 assert.ok(facts.groundClinicalFacts(low.clinicalFacts,low.chiefComplaint).redFlags.some(x=>x.category==='metabolic'&&x.urgency==='emergency'));
 assert.ok(!ids(low).some(x=>x.startsWith('supplement|糖尿病|')));
});
await check('1.7','卒中闭脱分开；儿童急惊风须有抽搐，成人不选儿科行',()=>{
 assert.ok(ids(state('偏瘫，神昏，汗多肢冷。','神经系统急症')).includes('neike|中风|脱证'));
 assert.ok(ids(state('偏瘫，神昏，口噤，两手握拳，面赤身热，苔黄腻。','神经系统急症')).includes('neike|中风|阳闭'));
 assert.ok(!ids(state('神昏抽搐，牙关紧闭，面赤身热，苔黄腻。','神经系统急症')).some(x=>x.startsWith('neike|中风|')));
 assert.ok(ids(state('发热，抽搐，咽红，脉浮数。','神经系统急症',{age:5})).includes('erke|急惊风|外感风热'));
 for(const s of [state('发热，无抽搐，咽红。','神经系统急症',{age:5}),state('发热，抽搐，咽红。','神经系统急症',{age:25})])assert.ok(!ids(s).some(x=>x.startsWith('erke|')));
});
await check('1.8','facts 类目仅用接地的本人当前 emergency 条目',()=>{
 const s=state('输液后过敏，胸闷气憋，面色苍白，冷汗淋漓。','现有资料需立即急诊');
 const finding={category:'anaphylaxis',subject:'patient',status:'positive',urgency:'emergency',triageBasis:'shock_or_anaphylaxis',quote:'输液后过敏，胸闷气憋，面色苍白，冷汗淋漓'};
 s.clinicalFacts={redFlags:[finding]};assert.ok(ids(s).includes('supplement|虚脱|神陷气脱'));
 for(const patch of [{subject:'other'},{status:'negative'},{urgency:'clarify'},{quote:'并不存在的引文'}]){s.clinicalFacts={redFlags:[{...finding,...patch}]};assert.deepEqual(ids(s),[]);}
});
await check('1.9','其余红旗类目按表现分支，未出现的症状不补造',()=>{
 const samples=[
  ['胸痛持续不缓解，大汗淋漓。','急性冠脉综合征','supplement|真心痛|心阳欲脱'],
  ['胸骨后剧痛，面色苍白，冷汗。','急性冠脉综合征','supplement|真心痛|心阳欲脱'],
  ['呕血量多，面色苍白，冷汗。','活动性消化道出血','supplement|血证|气随血脱'],
  ['高热，谵语，唇干烦渴，苔黄燥。','严重感染','supplement|虚脱|毒热内陷'],
  ['转移性右下腹痛，固定压痛，苔白腻。','急腹症','zxy_waike|急性阑尾炎|瘀滞证'],
  ['哮喘发作，张口抬肩，汗出肢冷，脉微欲绝。','呼吸衰竭','supplement|哮病|喘脱危'],
  ['高热，神昏，舌红绛，脉细数。','极高热','supplement|高热|热入营血'],
  ['心力衰竭，喘悸不休，额汗如油，肢厥，尿少。','急性心血管事件','neike|心衰|喘脱危证'],
  ['产后大量出血，面色苍白，冷汗。','产科急症伴大出血','fuke|产后血晕|血虚气脱证'],
  ['精神刺激后突然昏倒，气粗，口噤握拳。','意识异常','neike|厥证|实证|气厥'],
 ];
 for(const [record,flag,rowId] of samples){assert.ok(ids(state(record,flag)).includes(rowId),rowId);assert.deepEqual(ids(state('暂无相符表现。',flag)),[]);}
});
await check('2.1','异位妊娠术后方未手术时不锁；已手术且无活动出血时可参考',()=>{
 const r=reasoning('异位妊娠','气血亏脱证','四物汤');
 const before=provenance.withDeterministicFormulaReferences(r,'停经，下腹剧痛，尚未手术。');
 assert.deepEqual(before.overview.recommendedFormulaNames,[]);assert.match(before.overview.recommendedFormulaDirection,/手术止血优先/u);
 const after=provenance.withDeterministicFormulaReferences(r,'已行手术止血，术后病情稳定。');assert.ok(after.overview.recommendedFormulaDirection.includes('四物汤'));
 const row=table.textbookRowById('fuke|异位妊娠|气血亏脱证');
 assert.deepEqual(stage.currentTextbookFormulas(row,'计划手术，未手术止血。'),[]);
});
await check('2.2','M04 前置处置提示取代无条件沿用术后方',()=>{
 const text=table.buildTextbookFormulaContext('异位妊娠','气血亏脱证',{recordText:'尚未手术。'});
 assert.match(text,/前置处置/u);assert.match(text,/不把本行代表方作为当前方/u);assert.ok(!text.includes('辨证阶段已定用该代表方'));
});
await check('2.3','血厥、暑厥先后方逐阶段选择，不拼成合方；气厥须苏醒',()=>{
 const blood=table.textbookRowById('neike|厥证|虚证|血厥');assert.deepEqual(stage.currentTextbookFormulas(blood,''),['独参汤']);assert.deepEqual(stage.currentTextbookFormulas(blood,'出血已止，病情稳定，症状缓解。'),['人参养荣汤']);
 const heat=table.textbookRowById('zxy_neike|厥证|暑厥');assert.deepEqual(stage.currentTextbookFormulas(heat,''),['紫雪丹']);assert.deepEqual(stage.currentTextbookFormulas(heat,'已苏醒。'),['白虎加人参汤']);
 assert.deepEqual(stage.currentTextbookFormulas(table.textbookRowById('neike|厥证|虚证|气厥'),'尚未苏醒。'),[]);
 assert.ok(table.buildTextbookFormulaContext('厥证','血厥虚证').includes('不得作合方'));
});
await check('2.4','回阳停止条件与条件择方不当合方锁定',()=>{
 assert.deepEqual(stage.currentTextbookFormulas(table.textbookRowById('wenbing|春温|阳气暴脱'),'阳回脱止，手足转温。'),[]);
 assert.deepEqual(stage.currentTextbookFormulas(table.textbookRowById('wenbing|春温|内闭外脱'),'神昏，汗多。'),[]);
});
await check('3.1','喉喑等缺口病名进入生成闭集与运行时闭集，儿/妇科过滤',()=>{
 const names=JSON.parse(fs.readFileSync('src/data/tcm-textbook-disease-names.json','utf8')).names;
 assert.ok(names.includes('喉喑'));assert.ok(table.textbookDiseaseNamesForCase({sex:'男',ageYears:40}).includes('喉喑'));
 const supplement=JSON.parse(fs.readFileSync('src/data/tcm-textbook-syndrome-supplement.source.json','utf8'));
 assert.ok(supplement.rows.some(r=>r.disease==='喉喑'&&r.department==='耳鼻喉'));
 for(const r of supplement.rows.filter(r=>/妇|产科/u.test(r.department)&&!table.textbookFormulaRowsForDisease(r.disease).some(x=>!(/妇|产科/u.test(x.department)))))assert.ok(!table.textbookDiseaseNamesForCase({sex:'男',ageYears:40}).includes(r.disease),r.disease);
});
await check('3.2','KA 48 行、21 病按原文入表；分期和纯条件不冒充证名，生成与运行时均可达',()=>{
 const supplement=JSON.parse(fs.readFileSync('src/data/tcm-textbook-syndrome-supplement.source.json','utf8'));
 const added=supplement.rows.filter(r=>r.recordKind);assert.equal(added.length,48);assert.equal(new Set(added.map(r=>r.disease)).size,21);
 const generated=JSON.parse(fs.readFileSync('src/data/tcm-textbook-disease-names.json','utf8')).names;
 for(const r of added){assert.ok(r.evidence.length);assert.ok(r.therapy);assert.notEqual(r.recordKind,'source_stage');assert.ok(table.textbookRowById(r.id),r.id);assert.ok(generated.includes(r.disease));assert.ok(table.textbookDiseaseNamesForCase({sex:'女',ageYears:/儿科/u.test(r.department)?8:40}).includes(r.disease),r.disease);}
});
await check('4.1','跨病的银翘散、毓麟珠不得凭证候/治法放行；本病代表方可用',()=>{
 assert.equal(indications.formulaCoversDiseaseOrComplaint(reasoning(),'银翘散'),false);
 assert.equal(indications.formulaCoversDiseaseOrComplaint(reasoning('痹证','肾阳虚证','毓麟珠'),'毓麟珠'),false);
 assert.equal(indications.formulaCoversDiseaseOrComplaint(reasoning('头痛','复合证','川芎茶调散'),'川芎茶调散'),true);
 assert.equal(indications.formulaCoversDiseaseOrComplaint(reasoning('喉喑','会厌瘀血证','会厌逐瘀汤'),'会厌逐瘀汤'),true);
});
await check('4.2','目录主治覆盖及主诉覆盖可用，对照无覆盖拒绝',()=>{
 assert.equal(indications.formulaCoversDiseaseOrComplaint(reasoning('未入表病','新证','银翘散'),'银翘散','主诉：发热咽痛2天\n现病史：咽痛。'),true);
 assert.equal(indications.formulaCoversDiseaseOrComplaint(reasoning('未入表病','新证','银翘散'),'银翘散','主诉：关节疼痛2月\n现病史：发热。'),false);
 assert.equal(indications.formulaCoversDiseaseOrComplaint(reasoning('未入表病','新证','银翘散'),'银翘散','患者年龄：40岁\n患者性别：女\n发热咽痛2天\n无其他不适。'),true);
 assert.equal(indications.formulaCoversDiseaseOrComplaint(reasoning('痹证','风热痹阻证','银翘散'),'银翘散','膝关节疼痛伴发热1周\n现病史：发热。'),false);
 assert.ok(indications.buildTcmFormulaReasoningContext(reasoning('未入表病','风热犯表证','银翘散'),5,'unrestricted','主诉：发热咽痛2天').includes('M03 已锁定方：银翘散'));
});
await check('4.3','流派、信任模型、M03 锁方和二次核验共用主治覆盖',()=>{
 const r=reasoning();assert.ok(!indications.lineageFormulaSyndromeSupportedNames(r,['银翘散']).has('银翘散'));
 assert.ok(!indications.trustedModelFormulaIdentityNames(r,['银翘散']).has('银翘散'));
 const out=JSON.parse(indications.enforceRetrievedM03FormulaSelection(`<!-- DIAGNOSIS_JSON_START -->${JSON.stringify(r)}<!-- DIAGNOSIS_JSON_END -->`,['银翘散']).match(/START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END/)[1]);
 assert.deepEqual(out.overview.recommendedFormulaNames,[]);
 assert.match(indications.namedFormulaPositiveSufficiencyIssue(r,['银翘散'])||'',/missing/u);
 const final=provenance.withDeterministicFormulaReferences(r);assert.deepEqual(final.overview.recommendedFormulaNames,[]);
});
await check('4.4','M04 组成虽像成方，跨病也按自拟交付并保留参考方及出处、全部药味',()=>{
 const ingredients=provenance.formulaCompilationReferences(['银翘散'])[0].ingredients;
 const herbs=ingredients.map(name=>({name,dose:'6g',role:'佐药',function:'疏风清热',targetPathogenesis:'风热',evidence:{evidenceLevel:'kb_entry',source:'目录',confidence:'中'}}));
 const r={...reasoning(),stage:'prescribe',formula:{candidates:[{name:'银翘散',herbs,applicable:'风热证',notApplicable:'寒证',formulaAnalysis:'以银翘散为基础',therapyMatch:'疏风清热'}]}};
 const c=provenance.enrichReasoning(r).reasoning.formula.candidates[0];
 assert.equal(c.constructionType,'self_devised');assert.equal(c.name,'本例辨证组方');assert.deepEqual(c.formulaNames,[]);assert.equal(c.herbs.length,herbs.length);assert.match(c.formulaSource.source,/参考.*银翘散/u);
 const control=structuredClone(r);control.overview.tcmDiseaseName='感冒';assert.equal(provenance.enrichReasoning(control).reasoning.formula.candidates[0].constructionType,'single_base');
 const mixed=structuredClone(control);mixed.formula.candidates[0].name='银翘散合毓麟珠';mixed.formula.candidates[0].formulaNames=['银翘散','毓麟珠'];assert.equal(provenance.enrichReasoning(mixed).reasoning.formula.candidates[0].constructionType,'self_devised');
 // 单方显示名可解析，载荷却额外声称另一张跨病方：独立钉住全部声明都须覆盖。
 const stale=structuredClone(mixed);stale.formula.candidates[0].name='银翘散';assert.equal(provenance.resolveFormulaSources(stale.formula.candidates[0].name,herbs).length,1);assert.equal(provenance.enrichReasoning(stale).reasoning.formula.candidates[0].constructionType,'self_devised');
});
await check('4.5','签名前最后的身份恢复不能绕过覆盖；自拟按组成恢复也同判据',()=>{
 const ingredients=provenance.formulaCompilationReferences(['银翘散'])[0].ingredients;
 const herbs=ingredients.map(name=>({name,dose:'6g',role:'佐药',function:'疏风清热',targetPathogenesis:'风热',evidence:{evidenceLevel:'kb_entry',source:'目录',confidence:'中'}}));
 const r={...reasoning(),stage:'prescribe',formula:{candidates:[{name:'本例辨证组方',formulaNames:[],herbs,formulaAnalysis:'按本例组方',applicable:'风热证',notApplicable:'寒证',therapyMatch:'疏风清热'}]}};
 assert.equal(provenance.restoreGovernedFormulaIdentity(r,reasoning()).formula.candidates[0].name,'本例辨证组方');
 const noLock=reasoning();noLock.overview.recommendedFormulaNames=[];noLock.overview.formulaSelectionMode='self_devised';
 assert.equal(provenance.restoreGovernedFormulaIdentity(r,noLock).formula.candidates[0].name,'本例辨证组方');
 const named=structuredClone(r);named.formula.candidates[0].name='银翘散';named.formula.candidates[0].formulaNames=['银翘散'];assert.equal(provenance.restoreGovernedFormulaIdentity(named,noLock).formula.candidates[0].name,'本例辨证组方');
 const control=structuredClone(r);control.overview.tcmDiseaseName='感冒';assert.ok(provenance.restoreGovernedFormulaIdentity(control,{...noLock,overview:{...noLock.overview,tcmDiseaseName:'感冒'}}).formula.candidates[0].name.includes('银翘散'));
 const sparse=structuredClone(r);delete sparse.overview;assert.ok(provenance.restoreGovernedFormulaIdentity(sparse,{...noLock,overview:{...noLock.overview,tcmDiseaseName:'感冒'}}).formula.candidates[0].name.includes('银翘散'));
});
console.log(JSON.stringify({checks,failures}));if(failures)process.exit(1);
