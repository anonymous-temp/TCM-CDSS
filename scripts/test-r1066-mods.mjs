// 第四十九轮：D1 补位、条件质量、末端保底及加减煎法。全部病历为合成。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{alias:{'@':`${process.cwd()}/src`,'server-only':`${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`}});
const c=await jiti.import('../src/lib/m04-proposal-compiler.ts');
const s=await jiti.import('../src/lib/delivered-surface.ts');
const v=await jiti.import('../src/lib/diagnosis-visible-summary.ts');
const safe=await jiti.import('../src/lib/diagnosis-safety.ts');
const textbook=await jiti.import('../src/lib/tcm-textbook-syndromes.ts');
const types=await jiti.import('../src/lib/diagnosis-types.ts');
const fit=await jiti.import('../src/lib/m04-modification-fit.server.ts');
const state=types.normalizeCaseStateInput({patient:{age:38,sex:'男'},chiefComplaint:'鼻塞2天',symptoms:{现病史:'鼻塞，恶寒，咳嗽，舌苔薄白，脉浮紧。'}});
const prior={stage:'diagnose',overview:{tcmDiseaseName:'感冒',primarySyndrome:'风寒束表证',recommendedFormulaNames:['荆防败毒散'],primarySyndromeBasis:['鼻塞，恶寒，咳嗽']},therapy:{overallMethod:'辛温解表，宣肺散寒'},pathogenesis:{chain:[{nodeId:'P1',patientFact:'鼻塞，恶寒，咳嗽',pathogenesis:'风寒束表，肺失宣肃',therapyDirection:'辛温解表'}]}};
const names=['荆芥','防风','甘草'];
const herb=name=>({name,role:name==='荆芥'?'君':'臣',dose:'6g',targetKind:'pathogenesis_node',targetRef:'P1',function:'解表',processing:null,isToxic:false});
const rx=(rows=[])=>({schemaVersion:'tcm-cdss-reasoning-v2',stage:'prescribe',overview:prior.overview,therapy:prior.therapy,pathogenesis:prior.pathogenesis,formula:{candidates:[{name:'自拟方',constructionType:'self_devised',herbs:names.map(herb),decoction:{dosesPerDay:1,administrationTimesPerDay:2},formulaAnalysis:'荆芥、防风解表。'}],modifications:rows,patentAndWestern:[]},nonPharma:{diet:'清淡饮食。',precautions:[],tcmTreatments:[]}});
const ctx={prior,caseState:state,recordText:safe.clinicalGroundingText(state)};
const fill=(rows=[],p=prior,st=state,ns=names)=>c.fillTextbookModificationConditions(rows,p,st,ns);
const check=async(id,title,run)=>{if(process.env.R1066_MODS_CHECK&&process.env.R1066_MODS_CHECK!==id)return;try{await run();console.log(`✓ ${id} ${title}`);}catch(e){process.exitCode=1;console.error(`✗ ${id} ${title}\n${e.stack}`);}};
await check('01','阴性与体型闭集不作条件，阳性不寐不思饮食保留',()=>{
 for(const text of ['不痒不痛','不痛不痒','无胸闷','未见口干','形体略胖','体型偏瘦'])assert.equal(c.modificationTriggerNotFinding(text),'normal_or_meta',text);
 for(const text of ['不寐','不思饮食','无汗','无力','无痛性结节','无症状性血尿'])assert.equal(c.modificationTriggerNotFinding(text),undefined,text);
});
await check('02','因素与危重哭声按类别拦截，夜间特点不当诱因',()=>{
 for(const text of ['行走及咳嗽加重','活动腹痛加重','运动后减轻'])assert.equal(c.modificationTriggerNotFinding(text),'factor',text);
 for(const trigger of ['阴竭欲脱，烦躁','心阳欲脱','汗出如油','痰鸣息涌，不得平卧'])assert.equal(c.modificationTriggerNotFinding(trigger),'emergency_sign',trigger);
 assert.equal(c.modificationTriggerNotFinding('哭声较弱',{caseState:{safetyGate:{status:'red_flag'}}}),'emergency_sign');
 for(const trigger of ['皮肤瘀斑','皮下紫斑','腹大有水，小便短少不利'])assert.equal(c.modificationTriggerNotFinding(trigger,{caseState:{safetyGate:{status:'red_flag'}}}),'emergency_sign');
 for(const trigger of ['夜间腹痛加重','夜间咳嗽加重','咳嗽夜间加重'])assert.equal(c.modificationTriggerNotFinding(trigger),undefined,trigger);
});
await check('03','主症名不补数；已记特点必须引入条件',()=>{
 const st={...state,chiefComplaint:'胃痛3天',symptoms:{现病史:'胃痛拒按，胃痛明显，夜间加重，伴口干。'}};
 const context={caseState:st,recordText:safe.clinicalGroundingText(st)};
 assert.equal(c.modificationTriggerNotFinding('胃痛',context),'main_symptom');
 assert.equal(c.retainModificationFindings([{trigger:'胃痛',herbName:'木香'}],context).length,0);
 assert.equal(c.modificationTriggerNotFinding('胃痛拒按',context),undefined);
 assert.equal(c.modificationTriggerNotFinding('胃痛明显',context),undefined);
 assert.equal(c.modificationTriggerNotFinding('胃痛难忍',context),'main_symptom');
});
await check('04','同功效小类及完整作用重叠才删，异类与不同作用放过',()=>{
 assert.equal(c.modificationFunctionRepeatsCandidate('泽泻','利水渗湿，通利小便',['茯苓']),true);
 assert.equal(c.modificationFunctionRepeatsCandidate('泽泻','泄热',['茯苓']),false);
 assert.equal(c.modificationFunctionRepeatsCandidate('茯苓','利水渗湿，健脾宁心',['猪苓']),false,'理由另有主方未覆盖的已收载作用时不算清楚重复');
 assert.equal(c.modificationFunctionRepeatsCandidate('天花粉','生津止渴',['麦冬','地骨皮']),false,'分类不同不猜重复');
});
await check('05','D1 缺省开启、补到两条件且逐字有教材证据',()=>{
 const rows=fill();assert.equal(c.distinctModificationConditions(rows),2,JSON.stringify(rows));
 assert.ok(rows.every(row=>/^若见/u.test(row.trigger)&&row.evidence.evidenceLevel==='kb_entry'&&row.evidence.source.includes('《中医内科学》感冒·风寒束表证加减：')));
 assert.ok(rows.every(row=>!names.includes(row.herbName)&&c.modificationIsTextbookFill(row,ctx)));
 assert.deepEqual(fill(rows),rows);
});
await check('06','D1 开关关闭时不补未知表现，已有两条件时不追加',()=>{
 process.env.CDSS_MODIFICATION_TEXTBOOK_FILL='false';try{assert.equal(fill().length,0);}finally{delete process.env.CDSS_MODIFICATION_TEXTBOOK_FILL;}
 const rows=[{trigger:'本例已见恶寒',herbName:'桂枝',action:'加',reason:'温通经脉',doseOrHandling:'3g'},{trigger:'本例已见咳嗽',herbName:'紫菀',action:'加',reason:'润肺下气',doseOrHandling:'5g'}];
 assert.deepEqual(fill(rows),rows);
 assert.deepEqual(fill([...rows,...fill()]),rows,"已有两项时不再占用 D1 行");
});
await check('07','D1 共用寒热与舌脉矛盾闸，教材不豁免安全',()=>{
 const p={...prior,overview:{tcmDiseaseName:'遗尿',primarySyndrome:'下元虚寒证',recommendedFormulaNames:['菟丝子散']}};
 const st=types.normalizeCaseStateInput({patient:{sex:'男',age:28},chiefComplaint:'遗尿',symptoms:{现病史:'遗尿，舌淡苔白，脉沉迟。'}});
 assert.equal(c.topUpModificationRow({trigger:'若见郁热',herbName:'栀子',dose:'6g',reason:'清热泻火'},{prior:p,caseState:st,candidateHerbNames:[],existingTriggers:[],textbookFill:true}),undefined);
 assert.equal(c.modificationConditionTonguePulseConflict('若见口苦、苔黄腻','舌淡，苔白，脉沉迟。'),true);
});
await check('08','D1 在红旗病例同样补，危重条件仍逐项不合格',()=>{
 const st={...state,safetyGate:{status:'red_flag',redFlags:['立即评估'],redFlagFindings:[]}};
 const rows=fill([],prior,st);assert.equal(c.distinctModificationConditions(rows),2);
 assert.ok(rows.every(row=>c.modificationTriggerNotFinding(row.trigger,{...ctx,caseState:st})!=='emergency_sign'));
 const priority=c.fillTextbookModificationConditions([],prior,state,names,{priorityEvaluation:{focus:'周身酸痛'}});assert.ok(!priority.some(row=>row.trigger.includes('周身酸痛')));
});
await check('09','交付删行后补位且再次投影完全幂等',()=>{
 const input=rx([{trigger:'形体略胖',action:'加',herbName:'茯苓',doseOrHandling:'10g',reason:'利水渗湿',riskNote:''}]);
 const options={caseState:state,recordText:ctx.recordText};const a=s.projectDeliveredReasoning(input,options),b=s.projectDeliveredReasoning(a,options);
 assert.ok(!a.formula.modifications.some(row=>row.trigger==='形体略胖'));
 assert.equal(c.distinctModificationConditions(a.formula.modifications),2,JSON.stringify(a.formula.modifications));assert.deepEqual(b,a);
 const heart=rx();heart.overview={tcmDiseaseName:'真心痛',primarySyndrome:'气滞血瘀证',recommendedFormulaNames:['血府逐瘀汤']};heart.therapy={overallMethod:'活血化瘀，通脉止痛'};const st={...state,chiefComplaint:'胸部闷痛',symptoms:{现病史:'胸部闷痛，舌暗，脉涩。'}};
 const first=s.projectDeliveredReasoning(heart,{caseState:st,recordText:safe.clinicalGroundingText(st)});assert.deepEqual(s.projectDeliveredReasoning(first,{caseState:st,recordText:safe.clinicalGroundingText(st)}),first);
 const rash=rx();rash.overview={tcmDiseaseName:'瘾疹',primarySyndrome:'风寒束表证',recommendedFormulaNames:['桂枝麻黄各半汤']};rash.therapy={overallMethod:'疏风散寒，调和营卫'};const rs={...state,chiefComplaint:'风团瘙痒',symptoms:{现病史:'风团瘙痒，平时怕冷，舌淡苔白，脉浮紧。'}};
 const r1=s.projectDeliveredReasoning(rash,{caseState:rs,recordText:safe.clinicalGroundingText(rs)});assert.ok(r1.formula.modifications.length);assert.deepEqual(s.projectDeliveredReasoning(r1,{caseState:rs,recordText:safe.clinicalGroundingText(rs)}),r1);
 assert.ok(r1.formula.modifications.some(row=>row.herbName==='法半夏'),'教材明确法半夏时不改成姜半夏');
 const damp=rx();damp.overview={tcmDiseaseName:'眩晕',primarySyndrome:'气血亏虚证',recommendedFormulaNames:['归脾汤']};damp.therapy={overallMethod:'益气养血'};damp.pathogenesis={chain:[{nodeId:'P1',patientFact:'头晕乏力',pathogenesis:'气血不足，清窍失养',therapyDirection:'益气养血'}]};damp.formula.candidates[0].herbs=['黄芪','党参','当归','白芍','甘草'].map((name,index)=>({...herb(name),role:index===0?'君':'臣'}));damp.formula.candidates[0].formulaAnalysis='黄芪、党参益气，当归、白芍养血，甘草调和。';const ds={...state,chiefComplaint:'头晕',symptoms:{现病史:'头晕乏力，舌淡，脉细。'}};
 const d1=s.projectDeliveredReasoning(damp,{caseState:ds,recordText:safe.clinicalGroundingText(ds)});assert.ok(d1.formula.modifications.some(row=>row.herbName==='炒薏苡仁'));assert.deepEqual(s.projectDeliveredReasoning(d1,{caseState:ds,recordText:safe.clinicalGroundingText(ds)}),d1);
});
await check('10','假教材出处不可绕过缺省禁止模型备用条件的闸',()=>{
 const fake={trigger:'若见头项强痛',herbName:'葛根',action:'加',evidence:{evidenceLevel:'kb_entry',source:'《中医内科学》随便写的来源'}};
 assert.equal(c.modificationIsTextbookFill(fake,ctx),false);
 assert.equal(c.retainModificationFindings([fake],ctx).length,0);
});
await check('11','主方煎法只含药表药，加减先煎后下包煎捣碎归本行附注',()=>{
 const input=rx(['龙骨','木香','辛夷','酸枣仁'].map(herbName=>({trigger:'若见伴随表现',herbName,action:'加',riskNote:''})));
 const a=v.projectDeterministicDecoctionMethod(input,'',38);const method=a.formula.candidates[0].decoction.method;
 for(const row of a.formula.modifications){assert.ok(!method.includes(row.herbName),method);assert.ok(row.riskNote.includes(row.herbName),JSON.stringify(row));}
 assert.match(a.formula.modifications[0].riskNote,/先煎/u);assert.match(a.formula.modifications[1].riskNote,/后下/u);assert.match(a.formula.modifications[2].riskNote,/包煎/u);assert.match(a.formula.modifications[3].riskNote,/捣碎/u);
 assert.deepEqual(v.projectDeterministicDecoctionMethod(a,'',38),a);
 const cached=rx([{trigger:'腹胀',herbName:'辛夷',action:'加',riskNote:''}]);cached.formula.candidates[0].decoction.method='每日1剂，辛夷包煎，水煎分2次服';
 const projected=s.projectDeliveredReasoning(cached);assert.ok(!projected.formula.candidates[0].decoction.method.includes('辛夷'));assert.match(projected.formula.modifications[0].riskNote,/辛夷包煎/u);
});
await check('12','M04 首轮三四备选及不重复作用，定稿后仅一次补写',()=>{
 const prompt=readFileSync(new URL('../src/lib/diagnosis-prompts.ts',import.meta.url),'utf8');assert.match(prompt,/3–4 条不同条件/u);assert.match(prompt,/不加本方药味表里已有的药，也不加与方中某味药同一功效、管同一表现的药/u);assert.match(prompt,/adjust 行必须写目标剂量 dose/u);
 const source=readFileSync(new URL('../src/lib/m04-final-delivery.server.ts',import.meta.url),'utf8');const terminal=source.indexOf('  const selectedTable =');assert.ok(terminal>=0);
 assert.equal((source.slice(terminal,source.indexOf('  const schemaIssue',terminal)).match(/await topUpModificationConditions\(/g)||[]).length,1);
});
await check('13','补写模型关闭时先做确定性 D1，足量不调用模型',async()=>{
 process.env.CDSS_M04_MODIFICATION_FIT='false';try{const start='<!-- DIAGNOSIS_JSON_START -->',end='<!-- DIAGNOSIS_JSON_END -->';const result=await fit.topUpModificationConditions(`${start}${JSON.stringify(rx())}${end}`,ctx);const parsed=JSON.parse(result.slice(result.indexOf(start)+start.length,result.indexOf(end)));assert.equal(c.distinctModificationConditions(parsed.formula.modifications),2);}finally{delete process.env.CDSS_M04_MODIFICATION_FIT;}
});
await check('14','计数合并本例已见/若见前缀，同条件不能凑两条',()=>{
 assert.equal(c.distinctModificationConditions([{trigger:'本例已见口干'},{trigger:'若见口干'},{trigger:'若口干'}]),1);
});

await check('15','本证无条目时同方回退和成方核对读取同一行',()=>{
 const row=textbook.textbookRowForModifications('腰痛','肾阴虚证',['左归丸']);assert.ok(row?.modifications.length);
 const entry=row.modifications.find(x=>x.herbs.length);assert.ok(entry);
 const matched=textbook.textbookModificationMatch('腰痛','肾阴虚证',`若见${entry.condition}`,entry.herbs[0],undefined,['左归丸']);assert.ok(matched);assert.equal(matched.raw,entry.raw);
});

await check('16','D1 无教材目的句时按本例选功效，不把男性用药理由写成调经',()=>{
 const reason=c.textbookModificationReason('头痛甚，加白芍','白芍',['白芍'],{sex:'男',ageYears:38,recordText:'头痛，舌淡，脉细。'});assert.ok(reason);assert.doesNotMatch(reason,/调经|安胎/u);
});

await check('17','教材要求先去主方药时，不单补该条加药，也不改主方',()=>{
 const p={...prior,overview:{tcmDiseaseName:'腰痛',primarySyndrome:'肾阴虚证',recommendedFormulaNames:['左归丸']}};
 const row=textbook.textbookRowForModifications('腰痛','肾阴虚证',['左归丸']);const entry=row.modifications.find(x=>textbook.textbookModificationRemovals(x).includes('鹿角胶'));assert.ok(entry);
 const st={...state,chiefComplaint:'腰痛',symptoms:{现病史:'腰痛，舌红少苔，脉细数。'}};
 assert.equal(c.topUpModificationRow({trigger:`若见${entry.condition}`,herbName:'知母',dose:'6g',reason:'清热泻火'},{prior:p,caseState:st,candidateHerbNames:['鹿角胶'],existingTriggers:[],textbookFill:true}),undefined);
});

await check('18','关闭D1时不借同方另一证的主症甚行，保留本证旧判据',()=>{
 const p={...prior,overview:{tcmDiseaseName:'胃痛',primarySyndrome:'中焦气滞样证',recommendedFormulaNames:['柴胡疏肝散']}};
 const row=textbook.textbookRowForModifications('胃痛','中焦气滞样证',['柴胡疏肝散']);const entry=row.modifications.find(x=>/胃痛.*甚/u.test(x.condition));assert.ok(entry);
 const st={...state,chiefComplaint:'胃痛',symptoms:{现病史:'胃痛，伴腹胀。'}};const context={prior:p,caseState:st,recordText:safe.clinicalGroundingText(st)};
 assert.ok(c.textbookMainSymptomPresent(entry.condition,entry.herbs[0],context));
 process.env.CDSS_MODIFICATION_TEXTBOOK_FILL='false';try{assert.equal(c.textbookMainSymptomPresent(entry.condition,entry.herbs[0],context),undefined);}finally{delete process.env.CDSS_MODIFICATION_TEXTBOOK_FILL;}
});

await check('19','同数旧行被D1替换后，模型取消也须返回实际新行',async()=>{
 const p={...prior,overview:{tcmDiseaseName:'腰痛',primarySyndrome:'肾阴虚证',recommendedFormulaNames:['左归丸']},therapy:{overallMethod:'滋补肾阴'},pathogenesis:{chain:[{nodeId:'P1',patientFact:'腰部酸痛',pathogenesis:'肾阴不足，腰府失养',therapyDirection:'滋补肾阴'}]}};
 const st=types.normalizeCaseStateInput({patient:{age:67,sex:'男'},chiefComplaint:'腰痛',symptoms:{现病史:'腰部酸痛，舌红少苔，脉细数。'}});
 const ns=['熟地黄','山茱萸','山药','龟甲胶','鹿角胶','枸杞子','菟丝子','川牛膝','麦冬','地骨皮'];
 const expected=fill([],p,st,ns);assert.equal(c.distinctModificationConditions(expected),1);assert.ok(expected.length);
 const input=rx(Array.from({length:expected.length},()=>({trigger:'形体略胖',herbName:'茯苓',action:'加',doseOrHandling:'10g',reason:'利水渗湿'})));input.overview=p.overview;input.therapy=p.therapy;input.pathogenesis=p.pathogenesis;input.formula.candidates[0].herbs=ns.map(herb);
 const start='<!-- DIAGNOSIS_JSON_START -->',end='<!-- DIAGNOSIS_JSON_END -->',controller=new AbortController();controller.abort();
 const result=await fit.topUpModificationConditions(`${start}${JSON.stringify(input)}${end}`,{prior:p,caseState:st,recordText:safe.clinicalGroundingText(st)},controller.signal);
 const parsed=JSON.parse(result.slice(result.indexOf(start)+start.length,result.indexOf(end)));
 assert.ok(!parsed.formula.modifications.some(row=>row.trigger==='形体略胖'));assert.deepEqual(parsed.formula.modifications,expected);
});

await check('20','旧全量备用开关保留三条教材条件，不按D1上限截断',()=>{
 const book=textbook.textbookRowForModifications(prior.overview.tcmDiseaseName,prior.overview.primarySyndrome,prior.overview.recommendedFormulaNames);
 const rows=[];
 for(const entry of book.modifications){
  for(const herbName of entry.herbs){
   const trigger=`若见${entry.condition.replace(/^(?:若|如果|如|见)/u,'').replace(/(?:者|时)$/u,'')}`;
   const row=c.topUpModificationRow({trigger,herbName,dose:'3g',reason:c.textbookModificationReason(entry.raw,herbName,entry.herbs,{sex:'男',ageYears:38})},{prior,caseState:state,candidateHerbNames:[...names,...rows.map(row=>row.herbName)],baseHerbNames:names,existingTriggers:rows.map(row=>row.trigger),allowTextbookMain:true,textbookFill:true});
   if(row){rows.push(row);break;}
  }
  if(rows.length===3)break;
 }
 assert.equal(c.distinctModificationConditions(rows),3,'需三个真实且可编译的教材条件隔离回退守卫');
 process.env.CDSS_STANDBY_MODIFICATIONS='true';try{assert.deepEqual(fill(rows),rows);}finally{delete process.env.CDSS_STANDBY_MODIFICATIONS;}
});
