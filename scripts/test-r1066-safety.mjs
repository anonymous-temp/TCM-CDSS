// 第四十九轮 P2：合成病例；D2、药病禁忌与本例人群慎用，共享真实实现。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import { createJiti } from 'jiti';
const jiti=createJiti(import.meta.url,{alias:{'@':`${process.cwd()}/src`,'server-only':`${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`}});
const safety=await jiti.import('../src/lib/diagnosis-safety.ts');
const types=await jiti.import('../src/lib/diagnosis-types.ts');
const contract=await jiti.import('../src/lib/diagnosis-stage-contract.ts');
const pruning=await jiti.import('../src/lib/m04-modification-safety.ts');
const compiler=await jiti.import('../src/lib/m04-proposal-compiler.ts');
const base=await jiti.import('../src/lib/formula-base-herbs-barred.server.ts');
const required=await jiti.import('../src/lib/required-precautions.server.ts');
const surface=await jiti.import('../src/lib/delivered-surface.ts');
const policy=await jiti.import('../src/lib/antithrombotic-herb-policy.ts');
const provenance=await jiti.import('../src/lib/tcm-formula-provenance.ts');
const boundary=await jiti.import('../src/lib/candidate-boundary-text.ts');
const requiredShared=await jiti.import('../src/lib/required-precautions.ts');
const polarity=await jiti.import('../src/lib/clinical-polarity.ts');
let failed=0,checks=0;
const check=async(id,title,run)=>{if(process.env.R1066_SAFETY_ONLY&&process.env.R1066_SAFETY_ONLY!==id)return;checks++;try{await run();console.log(`✓ ${id} ${title}`);}catch(e){failed++;console.error(`✗ ${id} ${title}\n${e.stack}`);}};
const state=(med='',record='腰背酸痛，肢体麻木，口干。',extra={})=>types.normalizeCaseStateInput({chiefComplaint:'腰背酸痛',patient:{age:60,sex:'男'},medicationHistory:med,symptoms:{现病史:record},...extra});
const context=med=>safety.clinicalGroundingText(state(med));
const on=context('华法林3mg每日1次，INR 2.4');
const quiet=context('未服药');
const h=(name,role='佐')=>({name,role,dose:'6g'});
const rx=(herbs,modifications=[])=>({schemaVersion:'tcm-cdss-reasoning-v2',stage:'prescribe',overview:{primarySyndrome:'气滞血瘀证'},formula:{candidates:[{name:'本例辨证组方',herbs,formulaAnalysis:'黄芪益气。',notApplicable:''}],modifications},nonPharma:{precautions:[]}});
const wrap=r=>'<!-- DIAGNOSIS_JSON_START -->'+JSON.stringify(r)+'<!-- DIAGNOSIS_JSON_END -->';
const unwrap=s=>JSON.parse(s.split('<!-- DIAGNOSIS_JSON_START -->')[1].split('<!-- DIAGNOSIS_JSON_END -->')[0]);
const prune=(r,ctx=on)=>unwrap(pruning.dropSafetyConflictingM04CandidateHerbs(wrap(r),ctx));
const safe=[h('黄芪','君'),h('白术','臣'),h('茯苓')];
const names=r=>r.formula.candidates[0].herbs.map(x=>x.name);
const prior={schemaVersion:'tcm-cdss-reasoning-v2',stage:'diagnose',overview:{tcmDiseaseName:'痹证',primarySyndrome:'气滞血瘀证',secondarySyndromes:[],recommendedFormulaNames:['桃红四物汤']},therapy:{overallMethod:'活血通络，益气养血'},pathogenesis:{chain:[{nodeId:'P1',patientFact:'肢体麻木',pathogenesis:'瘀血阻络',therapyDirection:'活血通络'}]}};
const top=(herbName,s=state('华法林3mg每日1次'))=>compiler.topUpModificationRow({trigger:'肢体麻木',herbName,dose:'6g',reason:'活血通络'},{prior,caseState:s,candidateHerbNames:['黄芪','白术','茯苓'],existingTriggers:[]});
const project=(r,s,items=required.requiredPrecautionsForCase(s))=>surface.projectDeliveredReasoning(r,{caseState:s,recordText:safety.clinicalGroundingText(s),requiredPrecautions:items});
await check('S01','抗栓在用判据在状态与正文形状一致；停药与过敏不算在用',()=>{
 assert.equal(polarity.clinicalClausePolarity('未服华法林后出现黑便'), 'affirmed', '用药否认不改变同句症状极性');
 for(const text of ['用药史：未服华法林','现用药：未服华法林'])assert.equal(polarity.affirmedCurrentMedicationText(text),undefined,text);
 for(const med of ['华法林3mg每日1次','阿司匹林100mg每日1次','氯吡格雷75mg每日1次','利伐沙班10mg每日1次']){const s=state(med);assert.equal(safety.currentAntithromboticTherapyRecorded(s),true);assert.equal(safety.currentAntithromboticTherapyRecorded(safety.clinicalGroundingText(s)),true);}
 for(const med of ['华法林已停用半年','未服华法林','未用华法林','暂不服华法林','没服华法林','未服药'])assert.equal(contract.herbBarredForCase('鸡血藤',context(med)),false,med);
 assert.equal(contract.herbBarredForCase('鸡血藤','腰痛\n过敏史：阿司匹林诱发喘息'),false);
 assert.equal(contract.herbBarredForCase('鸡血藤','腰痛\n家族史：父亲长期服用华法林3mg每日1次'),false);
 for(const med of ['华法林已停用半年','未服华法林'])assert.deepEqual(contract.recordedPopulationCautions('鸡血藤',context(med)),[]);
 assert.equal(contract.herbBarredForCase('鸡血藤',safety.clinicalGroundingText(state('','腰痛。现用药：未服华法林。'))),false);
 for(const med of ['未服华法林','未用华法林','没服华法林'])assert.ok(!required.requiredPrecautionsForCase(state(med)).some(x=>x.kind==='current_medications'&&x.names.some(n=>n.includes('华法林'))),med);
});
await check('S02','无出血也禁活血化瘀药，别名炮制同源；无抗栓对照保留',()=>{
 for(const herb of ['鸡血藤','醋延胡索','元胡','丹参','川牛膝','苏木']){assert.equal(contract.herbBarredForCase(herb,on),true,herb);assert.equal(contract.herbBarredForCase(herb,quiet),false,herb);}
});
await check('S03','定稿仅剔D2冲突非君药，并把逐味原因写入notApplicable',()=>{
 const out=prune(rx([...safe,h('鸡血藤'),h('川芎')]));assert.deepEqual(names(out),names(rx(safe)));assert.match(out.formula.candidates[0].notApplicable,/鸡血藤（正在用抗凝或抗血小板药/);assert.match(out.formula.candidates[0].notApplicable,/川芎/);
});
await check('S04','D2保留君药交修复轮，合同仍报冲突',()=>{
 const out=prune(rx([h('丹参','君'),...safe]));assert.ok(names(out).includes('丹参'));assert.match(contract.m04GenerationSpecialPopulationIssue(out.formula.candidates[0].herbs,on),/antithrombotic_therapy$/);
});
await check('S05','剔除后不足三味时保留供修复，避免静默缩成小方',()=>{
 const out=prune(rx([h('黄芪','君'),h('茯苓'),h('丹参')]));assert.equal(names(out).length,3);assert.ok(names(out).includes('丹参'));
});
await check('S06','锁定方的D2禁药清单供M04首轮重选',()=>{
 const rows=base.formulaBaseHerbsBarredForCase(prior,on);assert.ok(rows.some(x=>x.herb==='桃仁'&&/抗凝/.test(x.reason)));assert.ok(rows.some(x=>x.herb==='红花'));assert.equal(base.formulaBaseHerbsBarredForCase(prior,quiet).length,0);
});
await check('S07','补写加味复用人群拦截，阴性对照确认其余守卫能通过',()=>{
 assert.ok(top('鸡血藤',state('未服药')));assert.equal(top('鸡血藤'),undefined);
});
await check('S08','慎用标签对上肝损伤人群时不加，无此人群时可加',()=>{
 const liver='患者年龄：60岁\n患者性别：男\n肝功能不全。';assert.ok(contract.recordedPopulationCautions('补骨脂',liver).length);assert.equal(contract.herbAdditionPopulationConflict('补骨脂',liver),true);assert.equal(contract.herbAdditionPopulationConflict('补骨脂','腰痛。'),false);
});
await check('S09','主方慎用药与君药保留，只加本例人群说明且幂等',()=>{
 const r=rx([h('补骨脂','君'),h('白术','臣'),h('茯苓')]),ctx='患者年龄：60岁\n患者性别：男\n肝功能不全。';const out=prune(r,ctx);assert.deepEqual(names(out),names(r));assert.match(out.formula.candidates[0].notApplicable,/补骨脂.*肝功能不全.*慎用；本例有肝功能不全记录，使用前请医生确认/);assert.deepEqual(prune(out,ctx),out);
});
await check('S10','旧结构定稿也删去慎用加味，不动减药行',()=>{
 const r=rx(safe,[{action:'加',herbName:'补骨脂',trigger:'腰膝酸软'},{action:'减',herbName:'白术',trigger:'口干'}]);const out=prune(r,'患者年龄：60岁\n肝功能不全。');assert.deepEqual(out.formula.modifications.map(x=>x.action),['减']);
});
await check('S11','缓存交付独立挡住抗凝禁药加味；主方保持原表',()=>{
 const s=state('华法林3mg每日1次');const r=rx(safe,[{action:'加',herbName:'鸡血藤',trigger:'肢体麻木',reason:'活血通络',doseOrHandling:'6g'}]);const out=project(r,s);assert.equal(out.formula.modifications.length,0);assert.deepEqual(names(out),names(r));
});
await check('S12','正文现用药与用药史共用清单；小数剂量、来源括注及一直在吃不漏',()=>{
 const s=state('', '乏力。现用药：二甲双胍片0.5g每日2次（外院开具后一直在吃），硝苯地平控释片30mg每日1次。');assert.deepEqual(safety.recordedMedicationHistoryList(s),['二甲双胍片','硝苯地平控释片']);assert.deepEqual(safety.recordedMedicationHistoryList(state('二甲双胍片0.5g每日2次（外院开具后一直在吃）')),['二甲双胍片']);assert.deepEqual(safety.recordedMedicationHistoryList(state('阿托伐他汀已停用半年')),[]);
});
await check('S13','eGFR17在用二甲双胍必写禁忌提示，阈值30不触发',()=>{
 const s=state('','乏力。现用药：二甲双胍片0.5g每日2次（外院开具后一直在吃）。eGFR 17ml/(min·1.73m²)。');assert.ok(required.requiredPrecautionsForCase(s).some(x=>x.kind==='drug_condition_caution'&&x.ruleId==='metformin_egfr_below_30'));assert.ok(!required.drugConditionCautions(['二甲双胍片'],'eGFR 30',[]).some(x=>x.ruleId==='metformin_egfr_below_30'));assert.equal(required.drugConditionCautions(['二甲双胍片'],'eGFR 45',[]).length,0);
});
await check('S14','交付面漏写药病禁忌时补规则句，通用在用药提示不能抵扣',()=>{
 const s=state('二甲双胍片0.5g每日2次','乏力，eGFR 17。');const out=project({...rx(safe),nonPharma:{precautions:['正在服用二甲双胍片，请告知医生，是否继续由医生决定。']}},s);assert.ok(out.nonPharma.precautions.some(x=>/二甲双胍.*eGFR.*30.*禁用/.test(x)||/eGFR.*二甲双胍.*30.*禁用/.test(x)));assert.deepEqual(project(out,s),out);
});
await check('S15','减弱抗凝方向的人参类不禁，最终药味对应INR监测',()=>{
 assert.equal(policy.antithromboticHerbAvoid('人参'),false);assert.equal(contract.herbBarredForCase('人参',on),false);const s=state('华法林3mg每日1次');const out=project(rx([h('人参','君'),h('白术','臣'),h('茯苓')]),s);assert.ok(out.nonPharma.precautions.some(x=>/INR/.test(x)&&/人参.*减弱华法林/.test(x)));
});
await check('S16','活动性出血原分类不扩大：未用抗凝时三七蒲黄仍按止血药口径',()=>{
 const bleeding='患者年龄：45岁\n患者性别：男\n本次咯血。';assert.equal(contract.herbBarredForCase('川芎',bleeding),true);assert.equal(contract.herbBarredForCase('三七',bleeding),false);assert.equal(contract.herbBarredForCase('蒲黄',bleeding),false);
});
await check('S17','M04提示显式说明无出血也不用，保留减弱方向INR说明',()=>{
 const src=fs.readFileSync('src/app/api/diagnosis/prescribe/route.ts','utf8');assert.match(src,/if \(currentAntithromboticTherapyRecorded\(gated\)\)/);assert.match(src,/没有出血也遵守/);assert.match(src,/减弱华法林作用的人参类不按此禁用/);
});
await check('S18','禁药回调让锁定方透明改为辨证组方，停药对照仍需守方剂身份合同',()=>{
 const p={schemaVersion:'tcm-cdss-reasoning-v2',stage:'diagnose',overview:{tcmDiseaseName:'腹痛',primarySyndrome:'瘀血内停证',recommendedFormulaNames:['少腹逐瘀汤'],formulaSelectionMode:'single'}};
 const r=rx(safe);Object.assign(r.formula.candidates[0],{constructionType:'self_devised',formulaNames:[]});
 assert.equal(provenance.formulaCompilationContractIssue(r,p,false,false,herb=>contract.herbBarredForCase(herb,on)),undefined);
 assert.equal(provenance.formulaCompilationContractIssue(r,p,false,false,herb=>contract.herbBarredForCase(herb,quiet)),'formula_reference_declassified');
});
await check('S19','本例安全说明在逐味尾注重建与模板清理后仍交付',()=>{
 const s=state('','腰背酸痛，肝功能不全。');const ctx=safety.clinicalGroundingText(s);
 const r=rx([h('补骨脂','君'),h('白术','臣'),h('茯苓')]);
 r.formula.candidates[0].notApplicable='证候、病机、舌脉或安全边界变化时暂停采用，并重新辨证。 '+boundary.herbBoundaryTail([{herb:'补骨脂',isToxic:false,toxicity:[],populationRules:[{population:'肝功能不全',severity:'MEDIUM'}]}]);
 const finalized=prune(r,ctx);const out=surface.projectDeliveredReasoning(finalized,{caseState:s,recordText:ctx,herbBoundaryAudience:{reproductive:false,ageYears:60}});
 assert.match(out.formula.candidates[0].notApplicable,/本例有肝功能不全记录，使用前请医生确认/);
 assert.deepEqual(surface.projectDeliveredReasoning(out,{caseState:s,recordText:ctx,herbBoundaryAudience:{reproductive:false,ageYears:60}}),out);
 const withoutTail=rx(safe);withoutTail.formula.candidates[0].notApplicable='证候、病机、舌脉或安全边界变化时暂停采用，并重新辨证；按本例情况已去除：鸡血藤（抗凝在用）';
 assert.match(project(withoutTail,state('华法林3mg每日1次')).formula.candidates[0].notApplicable,/已去除：鸡血藤/);
});
await check('S20','生成数据与治理输入指纹一致，逐条保留方向和出处',()=>{
 for(const file of ['tcm-antithrombotic-herb-avoid.json','drug-condition-contraindications.json']){
  const doc=JSON.parse(fs.readFileSync('src/data/'+file,'utf8'));
  for(const [source,expected] of Object.entries(doc.sourceHashes))assert.equal(createHash('sha256').update(fs.readFileSync('src/data/'+source)).digest('hex'),expected,source);
  for(const row of doc.entries||doc.rules)assert.ok(row.source.url&&row.source.quote,row.name||row.id);
 }
});
const risks=s=>required.requiredPrecautionsForCase(s).filter(x=>x.kind==='drug_condition_caution');
const ids=s=>risks(s).map(x=>x.ruleId);
await check('S21','研究主表增强方向及别名不用；止血类与不同药用部位不泛禁',()=>{
 for(const name of ['当归','酒当归','当归尾','干姜','枸杞子','银杏叶','葛根'])assert.equal(contract.herbBarredForCase(name,on),true,name);
 // 总指挥 11/17：甘草与华法林相互作用的证据方向互相矛盾（研究 directionNote），不入禁用闭集，炙甘草照常作使药。
 for(const name of ['白果','三七','蒲黄','茜草','甘草','炙甘草'])assert.equal(contract.herbBarredForCase(name,on),false,name);
});
await check('S22','eGFR区间沿用化验读法：30–45的二甲双胍只评估，30–50的螺内酯提示监测',()=>{
 assert.deepEqual(ids(state('二甲双胍片0.5g每日2次','eGFR 29.9。')),['metformin_egfr_below_30']);
 for(const value of [30,44.9])assert.deepEqual(ids(state('二甲双胍片0.5g每日2次',`eGFR ${value}。`)),['metformin_egfr_30_to_45']);
 assert.equal(ids(state('二甲双胍片0.5g每日2次','eGFR 45。')).length,0);
 for(const value of [30,50])assert.ok(ids(state('螺内酯片25mg每日1次',`eGFR ${value}。`)).includes('spironolactone_renal_30_to_50'));
 assert.ok(!ids(state('螺内酯片25mg每日1次','eGFR 50.1。')).includes('spironolactone_renal_30_to_50'));
});
await check('S23','普利/沙坦与血钾阈值；依普利酮不误匹配普利，螺内酯起始门槛不冒充绝对禁忌',()=>{
 const ras=k=>ids(state('厄贝沙坦片150mg每日1次',`血钾${k}mmol/L。`));
 assert.equal(ras(5.5).length,0);assert.deepEqual(ras(5.6),['ras_potassium_5_5_to_6']);assert.deepEqual(ras(6),['ras_potassium_5_5_to_6']);assert.deepEqual(ras(6.1),['ras_potassium_above_6']);
 assert.equal(ids(state('依普利酮片25mg每日1次','血钾6.1mmol/L。')).length,0);
 assert.ok(ids(state('咪达普利片5mg每日1次','血钾5.8mmol/L。')).includes('ras_potassium_5_5_to_6'));
 assert.ok(ids(state('盐酸咪达普利片5mg每日1次','血钾5.8mmol/L。')).includes('ras_potassium_5_5_to_6'));
 assert.ok(ids(state('沙库巴曲缬沙坦钠片50mg每日2次','血钾5.8mmol/L。')).includes('ras_potassium_5_5_to_6'));
 const spiro=risks(state('螺内酯片25mg每日1次','血钾5.1mmol/L。'));assert.equal(spiro.length,1);assert.match(spiro[0].sentence,/起始.*门槛/);assert.doesNotMatch(spiro[0].sentence,/禁用/);
});
await check('S24','ACEI/ARB仅在孕/备孕提示；无此状态不套孕妇禁忌',()=>{
 const woman=text=>state('氯沙坦钾片50mg每日1次',text,{patient:{age:32,sex:'女'}});
 assert.ok(ids(woman('已怀孕10周。')).includes('ras_pregnancy_conception'));
 assert.ok(ids(woman('正在备孕，未避孕。')).includes('ras_pregnancy_conception'));
 assert.ok(!ids(woman('目前未怀孕，无备孕计划。')).includes('ras_pregnancy_conception'));
});
await check('S25','老年磺脲与苯二氮䓬注意事项有65岁边界，不误伤格列汀',()=>{
 for(const [drug,id] of [['格列本脲片2.5mg每日1次','sulfonylurea_older_adult'],['劳拉西泮片1mg睡前服','benzodiazepine_older_adult']]){
  assert.ok(ids(state(drug,'腰背酸痛。',{patient:{age:65,sex:'男'}})).includes(id));assert.ok(!ids(state(drug,'腰背酸痛。',{patient:{age:64,sex:'男'}})).includes(id));
 }
 assert.equal(ids(state('西格列汀片100mg每日1次','腰痛。',{patient:{age:78,sex:'男'}})).length,0);
 assert.ok(ids(state('氟西泮片15mg睡前服','腰痛。',{patient:{age:78,sex:'男'}})).includes('benzodiazepine_older_adult'));
});
await check('S26','NSAID药病规则不套外用与低剂量阿司匹林；活动性胃出血覆盖既往史的较低提示',()=>{
 assert.ok(ids(state('华法林3mg每日1次、布洛芬400mg每日2次')).includes('nsaid_antithrombotic'));
 assert.ok(!ids(state('阿司匹林100mg每日1次')).includes('nsaid_antithrombotic'));
 assert.ok(!ids(state('外用双氯芬酸钠凝胶','慢性肾病3期。')).includes('nsaid_ckd'));
 assert.ok(!ids(state('双氯芬酸钠凝胶','慢性肾病3期。')).includes('nsaid_ckd'), '明确外用剂型无给药动词时仍保留剂型');
 assert.ok(!ids(state('双氯芬酸二乙胺乳胶剂','慢性肾病3期。')).includes('nsaid_ckd'), '通用药名表未收整个剂型时仍保留明确外用剂型');
 assert.ok(!ids(state('双氯芬酸','慢性肾病3期。外用双氯芬酸。')).includes('nsaid_ckd'));
 const gi=ids(state('布洛芬400mg每日2次','本次消化道出血。'));assert.ok(gi.includes('nsaid_active_gi'));assert.ok(!gi.includes('nsaid_gi_history'));
});
await check('S27','同一在用药同时命中肾病和抗栓相互作用时逐项补齐，一条泛泛调整不能抵扣',()=>{
 const s=state('华法林3mg每日1次、布洛芬400mg每日2次','慢性肾病3期，eGFR 45。');const r=risks(s);
 assert.ok(r.some(x=>x.ruleId==='nsaid_ckd'));assert.ok(r.some(x=>x.ruleId==='nsaid_antithrombotic'));
 const result=project({...rx(safe),nonPharma:{precautions:['您肾功能减退，布洛芬请由医生调整。']}},s);
 assert.ok(result.nonPharma.precautions.some(x=>/布洛芬/.test(x)&&/抗凝|抗血小板|防血栓/.test(x)&&/出血/.test(x)));
 for(const item of r)assert.equal(requiredShared.drugConditionPrecautionCovered(item,result.nonPharma.precautions),true,item.ruleId);
 assert.deepEqual(project(result,s),result);
});
await check('S28','患者事实排除家族史、否认的分期与数值；已停药不生成药病提示',()=>{
 const family=state('布洛芬400mg每日2次','腰背酸痛。',{symptoms:{现病史:'腰背酸痛。',家族史:'父亲健在，患有慢性肾病3期和心力衰竭。'}});
 assert.equal(risks(family).length,0);assert.equal(risks(state('布洛芬400mg每日2次','否认慢性肾病3期。')).length,0);
 assert.equal(risks(state('二甲双胍片0.5g每日2次','否认eGFR 17这一化验结果。')).length,0);
 assert.ok(!ids(state('二甲双胍已停用半年','eGFR 17。')).includes('metformin_egfr_below_30'));
});
await check('S29','其余研究病名/病史规则按本例事实给一句；不把单次ALT或旧造影直接定为禁用',()=>{
 const witnesses=[
 ['二甲双胍片0.5g每日2次','本次急性心肌梗死。','metformin_acute_hypoxia'],
 ['二甲双胍片0.5g每日2次','长期酗酒。','metformin_excess_alcohol'],
 ['二甲双胍片0.5g每日2次','肝功能损害。','metformin_hepatic_impairment'],
 ['格列本脲片2.5mg每日1次','肾功能不全。','sulfonylurea_organ_impairment'],
 ['布洛芬400mg每日2次','严重肾衰竭。','nsaid_advanced_renal'],
 ['布洛芬400mg每日2次','既往胃溃疡。','nsaid_gi_history'],
 ['布洛芬400mg每日2次','心力衰竭。','nsaid_heart_failure'],
 ['布洛芬400mg每日2次','严重肝衰竭。','nsaid_severe_hepatic_or_bleeding'],
 ['缬沙坦片80mg每日1次','双侧肾动脉狭窄。','ras_renal_artery_stenosis'],
 ['螺内酯片25mg每日1次、依普利酮片25mg每日1次','腰痛。','spironolactone_contraindications'],
 ['地高辛片0.125mg每日1次','低钾血症。','digoxin_hypokalemia'],
 ['地高辛片0.125mg每日1次','高钙血症。','digoxin_hypercalcemia'],
 ['地高辛片0.125mg每日1次','低镁血症。','digoxin_hypomagnesemia'],
 ['地高辛片0.125mg每日1次','肾功能不全。','digoxin_renal_impairment'],
 ['地高辛片0.125mg每日1次','eGFR 45。','digoxin_renal_impairment'],
 ['普萘洛尔片10mg每日2次','支气管哮喘。','nonselective_beta_blocker_asthma'],
 ['普萘洛尔片10mg每日2次','三度房室传导阻滞。','propranolol_bradycardia_block_shock'],
 ['阿托伐他汀片20mg每日1次','失代偿期肝硬化。','statin_acute_liver_failure'],
 ['洛伐他汀片20mg每日1次','活动性肝病。','lovastatin_fluvastatin_active_liver']];
 for(const [drug,record,id] of witnesses){const s=state(drug,record);const item=risks(s).find(x=>x.ruleId===id);assert.ok(item,id);assert.doesNotMatch(item.sentence,/\{condition\}|您有，/);const out=project(rx(safe),s);assert.equal(requiredShared.drugConditionPrecautionCovered(item,out.nonPharma.precautions),true,id);}
 assert.ok(!ids(state('二甲双胍片0.5g每日2次','既往3年前发生急性心肌梗死。')).includes('metformin_acute_hypoxia'));
 assert.ok(!ids(state('美托洛尔缓释片47.5mg每日1次','支气管哮喘。')).includes('nonselective_beta_blocker_asthma'));
 assert.ok(!ids(state('阿托伐他汀片20mg每日1次','ALT 130U/L。')).includes('statin_acute_liver_failure'));
 assert.ok(!ids(state('二甲双胍片0.5g每日2次','2019年做过碘造影剂检查，eGFR 50。')).includes('metformin_iodinated_contrast'));
});
await check('S30','研究减弱方向含贯叶金丝桃及别名不作D2禁药，华法林规则按实际药味提示INR',()=>{
 for(const name of ['人参','红参','西洋参','贯叶金丝桃','圣约翰草'])assert.equal(policy.antithromboticHerbAvoid(name),false,name);
 const s=state('华法林3mg每日1次');const warfarin=required.requiredPrecautionsForCase(s).find(x=>x.kind==='warfarin_herbal');assert.ok(warfarin.decreaseHerbs.includes('贯叶金丝桃'));
 const out=project(rx([h('白术','君'),h('茯苓','臣'),h('贯叶金丝桃')]),s);assert.ok(out.nonPharma.precautions.some(x=>/INR/.test(x)&&/贯叶金丝桃.*减弱华法林/.test(x)));
});
await check('S31','不足三味未提交剔药时，新增慎用说明不能带出临时君药晋位',()=>{
 const r=rx([h('羚羊角','君'),h('钩藤','臣'),h('补骨脂')]);const out=prune(r,'患者年龄：60岁\n患者性别：男\n肝功能不全。');
 assert.deepEqual(out.formula.candidates[0].herbs.map(x=>[x.name,x.role]),r.formula.candidates[0].herbs.map(x=>[x.name,x.role]));
 assert.match(out.formula.candidates[0].notApplicable,/补骨脂.*本例有肝功能不全记录/);
});
await check('S32','在用药名剥除家属说明与残缺括号，已知缓释剂型保留',()=>{
 const s=state('氨氯地平按家属说明每日1次，降压药（备注剂量不详，另药待核）');
 const items=required.requiredPrecautionsForCase(s);const names=items.filter(x=>x.kind==='current_medications').flatMap(x=>x.names);
 assert.ok(names.includes('氨氯地平'));assert.ok(!names.some(x=>x.includes('家属')));
 assert.ok(safety.recordedMedicationHistoryList(s).includes('降压药'));
 const form=required.requiredPrecautionsForCase(state('美托洛尔缓释片47.5mg每日1次')).filter(x=>x.kind==='current_medications').flatMap(x=>x.names);assert.ok(form.includes('美托洛尔缓释片'));
 assert.equal(polarity.medicationHistoryItemCandidate('降压药（备注').candidate,'降压药');
 assert.equal(polarity.medicationHistoryItemCandidate('美托洛尔缓释片47.5mg每日1次').candidate,'美托洛尔缓释片', '共享候选清洗器不能以规范化药物身份替换实际剂型');
});
await check('S33','D2保留君药的缓存交付须请医生调整且确认前不服，旧观察句不能遮蔽',()=>{
 const s=state('华法林3mg每日1次');const r=rx([h('丹参','君'),...safe]);
 r.nonPharma.precautions=['您正在使用华法林，本方含丹参，需观察牙龈出血和黑便。','留意牙龈出血、皮下瘀斑、黑便或血尿。'];
 const out=project(r,s);const lines=out.nonPharma.precautions;
 assert.ok(lines.some(x=>x.includes(requiredShared.ANTITHROMBOTIC_FORMULA_REVIEW)&&x.includes('丹参')));
 assert.ok(!lines.some(x=>x.includes('丹参')&&!x.includes(requiredShared.ANTITHROMBOTIC_FORMULA_REVIEW)));
 assert.ok(names(out).includes('丹参'));assert.match(contract.m04GenerationSpecialPopulationIssue(out.formula.candidates[0].herbs,safety.clinicalGroundingText(s)),/antithrombotic_therapy$/);
 assert.deepEqual(project(out,s).nonPharma.precautions,lines);
});
await check('S34','注意事项正在用抗栓的断言须与既有安全层同一判据',()=>{
 for(const s of [state('利伐沙班'),state('利伐沙班、降压药（药名不详）'),state('', '腰背酸痛。',{symptoms:{现病史:'腰背酸痛。',用药史:'利伐沙班、降压药（药名不详）'}})]){
  assert.equal(required.requiredPrecautionsForCase(s).some(x=>x.kind==='antithrombotic_bleeding'&&x.drugs.length),safety.currentAntithromboticTherapyRecorded(s));
 }
 const stopped=state('利伐沙班已停用两月');assert.ok(!required.requiredPrecautionsForCase(stopped).some(x=>x.kind==='antithrombotic_bleeding'&&x.drugs.length));
 const taking=state('利伐沙班10mg每日1次');assert.ok(required.requiredPrecautionsForCase(taking).some(x=>x.kind==='antithrombotic_bleeding'&&x.drugs.includes('利伐沙班')));
});
await check('S35','药名清洗去来源说明后仍保留完整复方成分，不能只列第一个成分',()=>{
 for(const med of ['布地奈德福莫特罗吸入剂，偶漏用','长期吸入布地奈德福莫特罗']){
  const items=required.requiredPrecautionsForCase(state(med));const names=items.filter(x=>x.kind==='current_medications').flatMap(x=>x.names);
  assert.ok(names.includes('布地奈德福莫特罗'),JSON.stringify(names));assert.ok(!names.includes('布地奈德'),JSON.stringify(names));
 }
 assert.equal(polarity.medicationHistoryItemCandidate('氨氯地平按家属说明每日1次').candidate,'氨氯地平');
});
await check('S40','注意事项超过 6 条时安全类必写句排前不被截掉，调护句同话题不重复补、截断幂等（new45-n40 二甲双胍）',()=>{
 const req=[{kind:'disease_care',sentence:'血钾偏高时应少吃含钾高的食物。'},{kind:'elderly_administration'},
  {kind:'drug_condition_caution',ruleId:'metformin_egfr_below_30',drug:'二甲双胍片'},{kind:'high_risk_condition',conditions:['hyperkalemia','hyperkalemia_diet'],potassium:'5.7mmol/L'}];
 const metformin='您的肾功能（eGFR 17）已低于二甲双胍可以使用的范围（说明书：eGFR低于30禁用），请尽快就医由医生调整降糖方案，不要自行加量或换药。';
 const potassium='本次血钾偏高（5.7mmol/L），请遵医嘱尽快复查血钾，不要自行服用补钾药；少吃香蕉、橙子等含钾高的食物。';
 const lines=['饮食清淡，忌辛辣。','避风寒，注意保暖。','情绪舒畅，规律作息。','年长者服药后起身宜缓，注意防跌倒。','血钾偏高时应少吃含钾高的食物。','服药期间如有不适请就医。',metformin,potassium];
 const out=surface.precautionsWithSafetyFirst(lines,req,['血钾偏高时应少吃含钾高的食物。']);
 assert.equal(out.length,6); assert.ok(out.includes(metformin)&&out.includes(potassium)&&out.includes('年长者服药后起身宜缓，注意防跌倒。'),JSON.stringify(out));
 assert.deepEqual(out,lines.filter(line=>out.includes(line)),'留下的按原顺序');
 assert.ok(!out.includes('血钾偏高时应少吃含钾高的食物。'),'调护补句排最后被截');
 assert.deepEqual(surface.precautionsWithSafetyFirst(out,req,['血钾偏高时应少吃含钾高的食物。']),out);
 const short=['饮食清淡。','注意保暖。'];assert.deepEqual(surface.precautionsWithSafetyFirst(short,req,[]),short);
});
await check('S41','人群慎用提示只读患者本人的病史：家族史不带栏目名的「母亲肥胖、高血压」不写「本例有心血管病记录」（hold40 h08），本人高血压照写',()=>{
 assert.deepEqual(contract.recordedPopulationCautions('附子','患者性别：女\n近半年神疲乏力，畏寒肢冷。\n否认高血压、糖尿病、甲状腺疾病史\n母亲肥胖、高血压'),[]);
 assert.deepEqual(contract.recordedPopulationCautions('附子','患者性别：男\n高血压病史10年，规律服药。'),['心血管病']);
});
console.log(JSON.stringify({checks,failed}));process.exitCode=failed?1:0;
