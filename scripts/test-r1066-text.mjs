// 第四十九轮 P4；全部为合成片段，不调用模型、不读取环境文件。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{alias:{'@':`${process.cwd()}/src`,'server-only':`${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`}});
const surface=await jiti.import('../src/lib/delivered-surface.ts');
const visible=await jiti.import('../src/lib/diagnosis-visible-summary.ts');
const terms=await jiti.import('../src/lib/clinical-terminology.ts');
const prompts=await jiti.import('../src/lib/diagnosis-prompts.ts');
const evidence=()=>({evidenceLevel:'model_inference',source:'本例四诊',confidence:'中'});
const rec='主诉：胃脘胀痛3天\n现病史：胃脘胀痛，嗳气后减轻。';
const base=()=>({schemaVersion:'tcm-cdss-reasoning-v2',stage:'diagnose',overview:{tcmDiseaseName:'胃痛',primarySyndrome:'胃气不和证',primarySyndromeResolution:'bounded',primarySyndromeBasis:['胃脘胀痛'],secondarySyndromes:[],tcmDiseaseRationale:'以胃脘胀痛为主。',tcmDiagnosticRationale:'胃脘胀痛，故属胃气不和证。',overallPathogenesis:'胃气不和，气机不畅。',evidence:evidence()},pathogenesis:{locationDifferentiation:{items:['胃'],details:[{location:'胃',basis:'胃脘胀痛'}],resolution:'resolved',evidence:evidence()},natureDifferentiation:{items:['气滞'],rootDeficiency:[],branchExcess:['气滞'],basis:'胃脘胀痛',resolution:'resolved',evidence:evidence()},summary:'胃气不和，气机不畅。',chain:[],uncertainties:[]},therapy:{overallMethod:'和胃理气',overallPrinciple:'调其气机',subTherapies:[]}});
const promote=(r,record=rec,red=false)=>{visible.withResolvedAxisEvidenceConfidence(r,record,red);return r.pathogenesis;};
const clean=surface.withoutUnrecordedCourseAndLocation;
let count=0,failed=0;
async function check(id,title,fn){if(process.env.R1066_TEXT_ONLY&&process.env.R1066_TEXT_ONLY!==id)return;count++;try{await fn();console.log(`✓ ${id} ${title}`);}catch(e){failed++;console.error(`✗ ${id} ${title}\n${e.stack}`);}}
await check('T01','各病位逐字有据为高，三焦和同名部位复用原判据',()=>{
 const r=base();r.pathogenesis.locationDifferentiation.items=['中焦','胃脘'];assert.equal(promote(r).locationDifferentiation.evidence.confidence,'高');
});
await check('T02','各病性逐字有据为高，不改依据及证素内容',()=>{
 const r=base();const before=structuredClone(r.pathogenesis.natureDifferentiation);assert.equal(promote(r).natureDifferentiation.evidence.confidence,'高');delete before.evidence;const after=structuredClone(r.pathogenesis.natureDifferentiation);delete after.evidence;assert.deepEqual(after,before);
});
await check('T03','有界和未定维持原中低，无病历不升',()=>{
 for(const resolution of ['bounded','unresolved'])for(const confidence of ['中','低']){const r=base();for(const axis of [r.pathogenesis.locationDifferentiation,r.pathogenesis.natureDifferentiation]){axis.resolution=resolution;axis.evidence.confidence=confidence;}const before=structuredClone(r);promote(r);assert.deepEqual(r,before);}const r=base();promote(r,'');assert.equal(r.pathogenesis.locationDifferentiation.evidence.confidence,'中');
});
await check('T04','红旗两轴不升，最终投影读既定门且二次幂等',()=>{
 const r=base();promote(r,rec,true);assert.equal(r.pathogenesis.locationDifferentiation.evidence.confidence,'中');assert.equal(r.pathogenesis.natureDifferentiation.evidence.confidence,'中');const options={recordText:rec,safetyGate:{status:'red_flag'}};const out=surface.projectDeliveredReasoning(r,options);assert.equal(out.pathogenesis.locationDifferentiation.evidence.confidence,'中');assert.deepEqual(surface.projectDeliveredReasoning(out,options),out);
});
await check('T05','缺任一要素依据不升；伪造引文和正常表现不能充据',()=>{
 const r=base();r.pathogenesis.locationDifferentiation.items.push('肾');r.pathogenesis.natureDifferentiation.items.push('血瘀');promote(r);assert.equal(r.pathogenesis.locationDifferentiation.evidence.confidence,'中');assert.equal(r.pathogenesis.natureDifferentiation.evidence.confidence,'中');const q=base();q.pathogenesis.locationDifferentiation.details[0].basis='胃脘剧痛';q.pathogenesis.natureDifferentiation.basis='胃脘剧痛';promote(q);assert.equal(q.pathogenesis.locationDifferentiation.evidence.confidence,'中');assert.equal(q.pathogenesis.natureDifferentiation.evidence.confidence,'中');
 const normal=base();normal.pathogenesis.locationDifferentiation.details[0].basis='舌淡红';normal.pathogenesis.natureDifferentiation.basis='舌淡红';promote(normal,'主诉：胃脘胀痛3天\n舌淡红。');assert.equal(normal.pathogenesis.locationDifferentiation.evidence.confidence,'中');assert.equal(normal.pathogenesis.natureDifferentiation.evidence.confidence,'中');
});
await check('T06','整名覆盖国标别名、教材、诊断学、复合名、经方，拒绝自造及裸标签',()=>{
 for(const name of ['胃气不和证','脾胃气滞证','心虚胆怯证','气血两虚证','麻黄汤证','肠燥津亏证'])assert.equal(terms.governedSyndromeName(name),true,name);
 for(const name of ['虚构胃气证','胃气不和证兼虚构证','血淋','劳淋','热淋','石淋','气淋','膏淋','肾虚','血淋证','肾虚证'])assert.equal(terms.governedSyndromeName(name),false,name);
});
await check('T07','气机中性名按受治理等义表改，依据和总述及链同步整名',()=>{
 for(const [from,to] of [['中焦气机不和证','脾胃不和证'],['中焦气滞证','脾胃不和证'],['肺气不和证','肺气上逆证'],['肺气壅塞证','肺气上逆证'],['耳窍气滞证','气滞耳窍证'],['气机逆乱证','气机失调证'],['风邪客表证','风邪袭表证']]){
 const r=base();r.overview.primarySyndrome=from;r.overview.tcmDiagnosticRationale=`属${from}。`;r.overview.overallPathogenesis=`${from}为主。`;r.pathogenesis.summary=`${from}。`;r.pathogenesis.chain=[{patientFact:from,pathogenesis:`${from}失调。`}];const axes=structuredClone([r.pathogenesis.locationDifferentiation,r.pathogenesis.natureDifferentiation]);surface.withGovernedSyndromeNames(r);assert.equal(r.overview.primarySyndrome,to);assert.ok(r.overview.tcmDiagnosticRationale.includes(to));assert.ok(r.overview.overallPathogenesis.includes(to));assert.ok(r.pathogenesis.summary.includes(to));assert.ok(r.pathogenesis.chain[0].pathogenesis.includes(to));assert.equal(r.pathogenesis.chain[0].patientFact,from);assert.deepEqual([r.pathogenesis.locationDifferentiation,r.pathogenesis.natureDifferentiation],axes);
 }
});
await check('T08','兼证名同义改名而不增加兼证，所有解释同步且幂等',()=>{
 const r=base();r.overview.secondarySyndromes=['耳窍气滞证'];r.overview.tcmDiagnosticRationale='胃气不和证，兼耳窍气滞证。';surface.withGovernedSyndromeNames(r);assert.deepEqual(r.overview.secondarySyndromes,['气滞耳窍证']);assert.ok(r.overview.tcmDiagnosticRationale.includes('气滞耳窍证'));assert.deepEqual(surface.withGovernedSyndromeNames(r),[]);
});
await check('T09','裸肾虚只读已有虚性：阴阳气分别映射，阴阳并见和未分型保留',()=>{
 for(const [labels,to] of [[['阴虚','精亏'],'肾阴虚证'],[['阳虚'],'肾阳虚证'],[['气虚'],'肾气虚证'],[[],'肾虚'],[['阴虚','阳虚'],'肾虚'],[['气虚','阴虚'],'肾虚']]){const r=base();r.overview.primarySyndrome='肾虚';r.overview.tcmDiagnosticRationale='故辨为肾虚。';r.pathogenesis.natureDifferentiation={items:labels,rootDeficiency:labels,branchExcess:[]};surface.withGovernedSyndromeNames(r);assert.equal(r.overview.primarySyndrome,to);assert.equal(r.overview.tcmDiagnosticRationale,`故辨为${to}。`);}
 const bare=base();bare.overview.primarySyndrome='肾虚';bare.pathogenesis.natureDifferentiation.items=['阴虚'];bare.pathogenesis.natureDifferentiation.branchExcess=[];bare.overview.tcmDiagnosticRationale='病机为肾虚水泛，故辨为肾虚。';surface.withGovernedSyndromeNames(bare);assert.equal(bare.overview.tcmDiagnosticRationale,'病机为肾虚水泛，故辨为肾阴虚证。');
});
await check('T10','映射不了保留原名、遥测只记固定原因和字段，不输出病历',()=>{
 const r=base();r.overview.primarySyndrome='清窍气机失和证';const lines=[];const info=console.info;try{console.info=(...args)=>lines.push(args);surface.withGovernedSyndromeNames(r);}finally{console.info=info;}assert.equal(r.overview.primarySyndrome,'清窍气机失和证');assert.equal(lines[0][0],'[tcm-cdss:telemetry] syndrome_name_ungoverned');assert.equal(JSON.stringify(lines).includes('清窍'),false);
});
const state=(chief)=>({patient:{age:39,sex:'男'},chiefComplaint:chief,symptoms:{现病史:'胃脘胀痛，嗳气。'},conversation:[],tcmLineagePreference:'unrestricted'});
await check('T11','M03 中性功能名取自词表实有小清单，不给 X 气不和造名范式',()=>{
 assert.ok(terms.GOVERNED_NEUTRAL_SYNDROME_NAMES.length>5&&terms.GOVERNED_NEUTRAL_SYNDROME_NAMES.length<30);const prompt=prompts.buildDiagnosePrompt(state('胃脘胀痛3天'));assert.ok(prompt.includes('从下面这些规范名里选'));for(const name of terms.GOVERNED_NEUTRAL_SYNDROME_NAMES){assert.ok(terms.governedSyndromeName(name));assert.ok(prompt.includes(name));}assert.equal(prompt.includes('X气不和证'),false);
});
await check('T12','M03 仅病程读不出时给核对提示，X天和XXX天均按未记录',()=>{
 for(const chief of ['胃脘胀痛','胃脘胀痛X天','胃脘胀痛XXX天'])assert.ok(prompts.buildDiagnosePrompt(state(chief)).includes('本例病程未记录，不写病程长短与起病缓急'));
 assert.equal(prompts.buildDiagnosePrompt(state('胃脘胀痛3天')).includes('本例病程未记录，不写病程长短与起病缓急'),false);
});
await check('T13','未知病程删数日数月长短、新病久病断言，保留其它临床子句',()=>{
 for(const claim of ['病程数日','病程数月','病程较长','病程较短','新病','久病'])assert.equal(clean(`胃脘胀痛，${claim}，故属胃痛。`,'主诉：胃脘胀痛XXX天'),'胃脘胀痛，故属胃痛。',claim);
});
await check('T14','数字病程按现有解析数量级核对，含中文、余数和半年',()=>{
 assert.equal(clean('胃脘胀痛，病程数月，故属胃痛。',rec),'胃脘胀痛，故属胃痛。');assert.ok(clean('病程数日，胃脘胀痛。',rec).includes('病程数日'));assert.ok(clean('病程半年，胃脘胀痛。','主诉：胃脘胀痛6个月').includes('病程半年'));assert.equal(clean('病程3个月，胃脘胀痛。','主诉：胃脘胀痛2月余'),'胃脘胀痛。');
});
await check('T15','长短与已记录数量级一致，不以长期病历支持短病程',()=>{
 assert.equal(clean('病程短，胃脘胀痛。','主诉：胃脘胀痛2年'),'胃脘胀痛。');assert.equal(clean('久病，胃脘胀痛。',rec),'胃脘胀痛。');assert.ok(clean('病程较长，胃脘胀痛。','主诉：胃脘胀痛2年').includes('病程较长'));
});
await check('T16','起病缓急必须有本例原文，数字病程本身不推出急缓',()=>{
 assert.equal(clean('起病急，病程短，胃脘胀痛。',rec),'病程短，胃脘胀痛。');assert.ok(clean('起病急，胃脘胀痛。',`${rec}\n现病史：突发胃脘痛。`).includes('起病急'));assert.equal(clean('起病缓慢，胃脘胀痛。',`${rec}\n现病史：突发胃脘痛。`),'胃脘胀痛。');assert.equal(clean('起病急，胃脘胀痛。','主诉：胃脘胀痛X天'),'胃脘胀痛。');
});
await check('T17','部位断言须有对应原文，教材定义式无部位不进入本例依据',()=>{
 assert.equal(clean('以腹痛为主，痛位在胃脘以下耻骨毛际以上，故属腹痛。','主诉：腹痛XXX天'),'以腹痛为主，故属腹痛。');assert.ok(clean('痛位在右上腹，故属胁痛。','主诉：右上腹痛3天').includes('痛位在右上腹'));assert.ok(clean('痛位在上腹胃脘，故属胃痛。',rec).includes('痛位在上腹胃脘'));assert.equal(clean('部位在左下腹，故属腹痛。','主诉：右上腹痛3天'),'故属腹痛。');
});
await check('T18','未记录与待核实、假设句不当断言删除，清理后不留空标点',()=>{
 for(const text of ['病程数月尚待核实，胃脘胀痛。','病程长短未记录，胃脘胀痛。','需核实病程数月与否。','若起病急，需及时评估。'])assert.equal(clean(text,rec),text);
 assert.equal(clean('起病急、病程数日；胃脘胀痛。','主诉：胃脘胀痛X天'),'胃脘胀痛。');
});
await check('T19','最终投影全部解释栏删无据子句；可信度统一提升且幂等',()=>{
 const r=base();const claim='胃脘胀痛，病程数日，起病急，痛位在右下腹。';for(const key of ['tcmDiseaseRationale','tcmDiagnosticRationale','overallPathogenesis'])r.overview[key]=claim;r.pathogenesis.summary=claim;
 const options={recordText:'主诉：胃脘胀痛XXX天\n现病史：胃脘胀痛，嗳气后减轻。',safetyGate:{status:'ready'}};const out=surface.projectDeliveredReasoning(r,options);for(const key of ['tcmDiseaseRationale','tcmDiagnosticRationale','overallPathogenesis'])assert.equal(out.overview[key],'胃脘胀痛。');assert.equal(out.pathogenesis.summary,'胃脘胀痛。');assert.equal(out.pathogenesis.locationDifferentiation.evidence.confidence,'高');assert.equal(out.pathogenesis.natureDifferentiation.evidence.confidence,'高');assert.deepEqual(surface.projectDeliveredReasoning(out,options),out);
});
await check('T20','映射有语境条件，不以腰痛名泛化经脉，也不把病名当证名全局替换',()=>{
 assert.equal(terms.governedSyndromeReplacement('腰部气机不和证',[],'腰部疼痛'),undefined);assert.equal(terms.governedSyndromeReplacement('腰部气机不和证',['气滞'],'腰部经脉气机不畅'),'经脉不和证');const r=base();r.overview.primarySyndrome='血淋';r.overview.tcmDiseaseName='淋证（血淋）';surface.withGovernedSyndromeNames(r);assert.equal(r.overview.tcmDiseaseName,'淋证（血淋）');
});
await check('T22','教材鉴别的起病和病程泛述保留，不按本例短病程删除',()=>{
 for(const text of ['风温起病急骤、高热汗出而热复起。','痿证多双下肢痿软、起病缓慢。','与内伤头痛之反复发作、病程长不同。','感冒多伴恶寒发热、病程短。'])assert.equal(clean(text,rec),text);
});
await check('T23','实际交付规范主证且二次投影幂等，不改变轴条目',()=>{
 const r=base();r.overview.primarySyndrome='中焦气机不和证';r.overview.tcmDiagnosticRationale='胃脘胀痛，属中焦气机不和证。';const options={recordText:rec};const out=surface.projectDeliveredReasoning(r,options);assert.equal(surface.projectDeliveredReasoning(r).overview.primarySyndrome,'脾胃不和证');assert.equal(out.overview.primarySyndrome,'脾胃不和证');assert.ok(out.overview.tcmDiagnosticRationale.includes('脾胃不和证'));assert.deepEqual(out.pathogenesis.locationDifferentiation.items,r.pathogenesis.locationDifferentiation.items);assert.deepEqual(out.pathogenesis.natureDifferentiation.items,r.pathogenesis.natureDifferentiation.items);assert.deepEqual(surface.projectDeliveredReasoning(out,options),out);
});
await check('T24','受治理策略的中性清单和映射目标逐个实有，来源和去重完整',()=>{
 const policy=JSON.parse(readFileSync('src/data/tcm-syndrome-name-policy.source.json','utf8'));assert.equal(new Set(policy.neutralNames).size,policy.neutralNames.length);for(const name of policy.neutralNames)assert.ok(terms.governedSyndromeName(name),name);for(const rule of policy.renames){assert.ok(terms.governedSyndromeName(rule.to),rule.to);assert.ok(rule.source);}
});
await check('T25','病程读取排除孕周，保留真正病程；仅孕周加占位仍告知未知',()=>{
 assert.ok(clean('病程3周，故属便秘。','主诉：妊娠20周排便困难3周').includes('病程3周'));assert.equal(clean('病程数月，故属便秘。','主诉：妊娠20周排便困难X天'),'故属便秘。');assert.ok(prompts.buildDiagnosePrompt(state('妊娠20周排便困难X天')).includes('本例病程未记录'));
});
await check('T26','删完整最小起病断言及依附词，不留属、逾1年、半年等孤立残句',()=>{
 for(const text of ['起病缓慢逾1年，胃脘胀痛。','隐匿起病半年，胃脘胀痛。','受凉后急性起病，胃脘胀痛。'])assert.equal(clean(text,'主诉：胃脘胀痛1年'),'胃脘胀痛。');assert.equal(clean('病程3天属急性起病，故属胃痛。',rec),'病程3天，故属胃痛。');assert.equal(clean('尿量少，与久病及肾相关。','主诉：尿量少两周'),'尿量少。');assert.equal(clean('胃脘胀痛；',rec),'胃脘胀痛；');
});
await check('T27','起病缓急连带的数字时长共用病程核对，明确突发也不能写错数量级',()=>{
 const r=rec+'\n现病史：突发胃脘胀痛。';assert.equal(clean('起病急半年，胃脘胀痛。',r),'胃脘胀痛。');assert.ok(clean('起病急3天，胃脘胀痛。',r).includes('起病急3天'));
});
await check('T28','明确命名位置省略证字也同步，普通气机描述和其它证名词头保留',()=>{
 const r=base();r.overview.primarySyndrome='腰部气机不和证';r.overview.tcmDiagnosticRationale='腰部经脉气机不畅，故主证属腰部气机不和。';surface.withGovernedSyndromeNames(r);assert.equal(r.overview.tcmDiagnosticRationale,'腰部经脉气机不畅，故主证属经脉不和证。');assert.equal(terms.renamedSyndromeMentions('腰部气机不和，故证属腰部气机不和。','腰部气机不和证','经脉不和证'),'腰部气机不和，故证属经脉不和证。');assert.equal(terms.renamedSyndromeMentions('肾虚水泛，故辨为肾虚。','肾虚','肾阴虚证'),'肾虚水泛，故辨为肾阴虚证。');
});
await check('T29','占位主诉而本次现病史已记病程时沿用原数值读法，不取既往时长',()=>{
 const s=state('胃脘胀痛XXX天');s.symptoms.现病史='胃脘胀痛3天，嗳气。';s.symptoms.既往史='高血压病8年';assert.equal(prompts.buildDiagnosePrompt(s).includes('本例病程未记录'),false);assert.ok(clean('病程3天，故属胃痛。','主诉：胃脘胀痛XXX天',s.symptoms.现病史).includes('病程3天'));const r=base();r.overview.tcmDiseaseRationale='病程3天，故属胃痛。';assert.ok(surface.projectDeliveredReasoning(r,{recordText:'主诉：胃脘胀痛XXX天\n胃脘胀痛3天，嗳气。',caseState:s}).overview.tcmDiseaseRationale.includes('病程3天'));
 const missing=state('胃脘胀痛XXX天');missing.symptoms.既往史='高血压病8年';assert.ok(prompts.buildDiagnosePrompt(missing).includes('本例病程未记录'));
});
await check('T21','接口文档说明已明确逐项有据的高以及红旗边界',()=>{
 const doc=readFileSync('docs/中医CDSS-对外接口文档.md','utf8');assert.ok(doc.includes('每个要素各有逐字可回溯的病历依据'));assert.ok(doc.includes('红旗病例不提升'));
});
await check('T40','病名加括号当证名、病机短语当证名时，取第一个对得上受治理证名的短语（只互换滞/阻/困/蕴/郁），对不上不改',()=>{
 assert.equal(terms.governedSyndromeFromMechanismPhrases('感冒（湿滞中焦、气机不畅）'),'湿滞中焦证');assert.ok(terms.governedSyndromeName('湿滞中焦证'));assert.equal(terms.governedSyndromeFromMechanismPhrases('感冒（湿郁中焦）'),'湿滞中焦证');
 assert.equal(terms.governedSyndromeFromMechanismPhrases('中焦气机不和证'),undefined);
 const r={schemaVersion:'tcm-cdss-reasoning-v2',stage:'diagnose',overview:{tcmDiseaseName:'感冒',primarySyndrome:'感冒（湿滞中焦、气机不畅）',secondarySyndromes:[],tcmDiagnosticRationale:'头晕、食欲减退为湿滞中焦。'},pathogenesis:{natureDifferentiation:{items:['湿']}}};
 surface.withGovernedSyndromeNames(r);assert.equal(r.overview.primarySyndrome,'湿滞中焦证');
});
await check('T41','腹痛定义部位（胃脘以下、耻骨毛际以上）写成本例所见而病历无具体腹部部位时删这一分句；病历写了下腹的保留（retest rt-273344）',()=>{
 const make=(rec)=>surface.withoutUnrecordedCourseAndLocation('以胃脘以下腹痛为主症，伴恶心、呕吐，故归腹痛。',rec);
 const out=make('患者3天前出现腹痛、恶心、呕吐伴发热。');assert.ok(!/胃脘以下/.test(out),out);assert.match(out,/恶心、呕吐/);
 assert.match(make('患者3天前出现下腹疼痛、恶心、呕吐。'),/胃脘以下/);
});
console.log(`${count-failed}/${count} passed`);if(failed)process.exitCode=1;
