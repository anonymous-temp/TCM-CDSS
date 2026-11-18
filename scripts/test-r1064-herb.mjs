// 第四十七轮 C1：教材字段、使用注意接地与合并、在孕角色、用途炮制与液态药合同。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { alias: { '@': `${process.cwd()}/src`, 'server-only': `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
let checks = 0;
const check = async (id, run) => { checks++; try { await run(); console.log(`✓ ${id}`); } catch (e) { process.exitCode = 1; console.error(`✗ ${id}\n  ${e.stack || e}`); } };
const [caution, identity, processing, contract, safety, surface, local, decoction, types, liquid, revision] = await Promise.all([
  'herb-caution-check.server', 'herb-textbook-identity', 'herb-processing-forms', 'diagnosis-stage-contract', 'm04-modification-safety', 'delivered-surface', 'local-prescription-checks', 'herb-decoction-rules', 'diagnosis-types', 'herb-liquid-dose', 'prescription-revision',
].map((name) => jiti.import(`../src/lib/${name}.ts`)));
const refs = JSON.parse(fs.readFileSync('src/data/tcm-herb-textbook-references.json', 'utf8'));
const wrap = (root) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(root)}\n<!-- DIAGNOSIS_JSON_END -->`;
const unwrap = (content) => JSON.parse(content.split('<!-- DIAGNOSIS_JSON_START -->')[1].split('<!-- DIAGNOSIS_JSON_END -->')[0]);
const root = () => ({ schemaVersion:'tcm-cdss-reasoning-v2', stage:'prescribe', formula:{ candidates:[{name:'四物汤加减', herbs:[{name:'川芎',dose:'6g',role:'臣',verificationReasons:['已有提示']},{name:'当归',dose:'6g',role:'君'}]}],modifications:[{trigger:'头痛',action:'加',herbName:'川芎',doseOrHandling:'6g'},{trigger:'口干',action:'加',herbName:'麦冬',doseOrHandling:'10g'},{trigger:'疼痛',action:'减',herbName:'川芎',doseOrHandling:'2g'}]}, nonPharma:{precautions:[]} });
const finding = (quote='经量较往年明显增多') => ({id:0,applies:true,quote,mention:quote});
const task = (choose, secondChoose=choose) => async (_ns,_stage,messages,_opts,parse) => {
  const payload = JSON.parse(messages[1].content);
  // 第四十七轮提速：模型按去重后的条件（row.herbs 列出受约束的饮片）只回答适用的条目。
  const answer = (fn) => parse(JSON.stringify({applies:payload.rows.flatMap((row)=>{const r={applies:false,quote:'',mention:'',...fn(row)};return r.applies?[{id:row.id,quote:r.quote,mention:r.mention}]:[];})}));
  return [answer(choose),answer(secondChoose)];
};
const positive = (row) => row.herbs.includes('川芎') && row.condition==='月经过多' ? {applies:true,quote:'经量较往年明显增多',mention:'经量较往年明显增多'} : {};
await check('1.1 旧字段内容与顺序无损，新增字段齐全',()=>{
  const copy=structuredClone(refs);for(const herb of Object.values(copy.herbs))for(const field of ['applications','applicationsLine','cautionItems','pregnancy','processingPurposes'])delete herb[field];
  const sorted=(v)=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
  assert.equal(createHash('sha256').update(JSON.stringify(sorted(copy))).digest('hex'),'93463b384a4cee85dc2d5adddee11fa9e61249cf54736654a3e5fc06810bee3e');
  for(const herb of Object.values(refs.herbs)) { assert.equal(typeof herb.applications,'string'); assert.ok(Array.isArray(herb.cautionItems));assert.ok(Array.isArray(herb.pregnancy));assert.ok(Array.isArray(herb.processingPurposes)); }
});
await check('1.2 应用全文、注意条目、孕妇与炮制原句可追溯；生成器也能重建',()=>{
  assert.match(refs.herbs.熟地黄.applications,/精血亏虚/); assert.ok(refs.herbs.熟地黄.applicationsLine>150000);
  assert.ok(refs.herbs.川芎.cautionItems.some(i=>i.condition==='月经过多'&&i.strength==='不宜'));
  assert.ok(refs.herbs.牡蛎.processingPurposes.some(i=>i.raw.includes('收敛固涩、制酸止痛煅用')));
  assert.ok(refs.herbs.伸筋草.pregnancy.some(i=>i.strength==='慎'));
  assert.ok(refs.herbs.土牛膝.pregnancy.some(i=>i.strength==='慎'));assert.ok(refs.herbs.鹿角胶.cautionItems.some(i=>i.condition==='阴虚火旺'));
  assert.deepEqual(refs.herbs.川乌.pregnancy.map(i=>i.strength),['忌','慎']);
  // 合成教材片段只测分段；fresh clone 没有被 gitignore 的整本语料时仍可运行。
  const fixture = [
    ['熟地黄','食少便溏者忌服。'], ['川芎','月经过多者不宜用。孕妇慎用。'],
    ['伸筋草','孕妇慎用。'], ['川乌','生品内服宜慎，孕妇忌用。制川乌孕妇慎用。'],
    ['麻黄','失眠及高血压患者慎用，运动员禁用。'], ['牡蛎',''], ['鹿茸',''], ['麝香',''],
  ].flatMap(([name,caution]) => [name,'Herb（合成教材）','【药性】甘，平。','【功效】补益。','【应用】','1.示例应用','2.另一示例应用',
    '【用法用量】收敛固涩、制酸止痛煅用。','【使用注意】'+caution,
    ...(name==='鹿茸'?['附药：鹿角胶','本品为合成附药，功能温补。阴虚火旺者忌服。']:[]),
    ...(name==='麝香'?['附药：人工麝香','本品为合成附药，功能开窍。0.06～0.1g，入丸散，不宜入煎剂。孕妇禁用。']:[]),
  ]).join('\n');
  const realCorpus=process.env.CDSS_IGNORE_LOCAL_ARTIFACTS!=='1' && fs.existsSync(refs.source.file);
  execFileSync('python3',['-I','-c',"import runpy,sys\nm=runpy.run_path('scripts/build-herb-textbook-references.py')\nlines=(m['CORPUS'].read_text() if sys.argv[1]=='real' else sys.argv[2]).splitlines()\nif sys.argv[1]!='real':\n    m['parse_herbs'].__globals__['MATERIA_MEDICA_LINES']=(0,len(lines))\nh=m['parse_herbs'](lines);m['enrich_herbs'](h,lines)\nassert '【用法用量】' not in h['熟地黄']['applications']\nassert h['熟地黄']['applications'].count('2.') >= 1\nassert any(i['condition']=='月经过多' for i in h['川芎']['cautionItems'])\nassert any(i['strength']=='慎' for i in h['伸筋草']['pregnancy'])\nassert any(i['condition']=='阴虚火旺' for i in h['鹿角胶']['cautionItems'])\nassert not any(i['condition'][0].isdigit() or '入丸' in i['condition'] for i in h['人工麝香']['cautionItems'])\nassert [i['strength'] for i in h['川乌']['pregnancy']]==['忌','慎']\nassert h['牡蛎']['processingPurposes']\nassert not any(i['condition']=='失眠' and i['strength']=='禁' for i in h['麻黄']['cautionItems'])\np=runpy.run_path('scripts/build-herb-purpose-processing.py')\nr=p['form_rows']('合成药',{'usage':'煎服，3～6g。','processingPurposes':[{'raw':'收敛固涩煅用','line':123}]})\nassert len(r)==1 and r[0]['prefix']=='煅' and r[0]['line']==123\n",realCorpus?'real':'synthetic',fixture]);
});
await check('2.1 所有本方及加药条目入批；生制限定不串用',()=>{
  assert.ok(caution.herbCautionTargets(wrap(root())).some(t=>t.herb==='川芎'&&t.item.condition==='月经过多'));
  assert.ok(!identity.textbookHerbCautionItems('制何首乌').some(i=>i.raw.startsWith('生用')));
  assert.ok(!identity.textbookHerbCautionItems('生何首乌').some(i=>i.raw.includes('制用')));
  assert.ok(identity.textbookHerbCautionItems('皂矾').some(i=>i.condition==='孕妇'));
  assert.deepEqual(identity.textbookHerbCautionItems('制川乌').filter(i=>i.condition==='孕妇').map(i=>i.strength),['慎']);
});
await check('2.2 逐字阳性引文可用；否认、家族史、未问与伪引文不可用',()=>{
  assert.equal(caution.herbCautionFindingGrounded(finding(),'现病史：经量较往年明显增多。'),true);
  assert.equal(caution.herbCautionFindingGrounded(finding('经量增多'.repeat(50)),'经量增多'.repeat(50)),false,'过长摘录不能把单条说明推过接口500字上限');
  for(const record of ['否认经量较往年明显增多。','家族史：母亲经量较往年明显增多。','是否经量较往年明显增多尚未询问。','月经量正常。']) assert.equal(caution.herbCautionFindingGrounded(finding(),record),false,record);
});
await check('2.3 引文含否认词、本人另一阳性症状时，仍按被引用病情的位置查极性',()=>{
  assert.equal(caution.herbCautionFindingGrounded({...finding('无经量增多，伴头痛'),mention:'经量增多'},'无经量增多，伴头痛。'),false);
});
await check('2.4 两家一致才命中；单边同意不动',async()=>{
  const content=wrap(root());const ctx={recordText:'现病史：经量较往年明显增多。'};
  const hits=await caution.checkHerbCautions(content,ctx,undefined,task(positive));assert.equal(hits.length,1);
  assert.equal((await caution.checkHerbCautions(content,ctx,undefined,task(positive,()=>({})))).length,0);
});
await check('2.5 主方只注释不删味，已有注释保留；加减整行剔除并解释教材原文',async()=>{
  const original=root();original.formula.candidates[0].herbs[0].verificationReasons=Array.from({length:8},(_,i)=>i?'旧提示'+i:'已有提示');const content=wrap(original);const hits=await caution.checkHerbCautions(content,{recordText:'现病史：经量较往年明显增多。'},undefined,task(positive));
  const out=unwrap(caution.applyHerbCautionHits(content,hits));assert.equal(out.formula.candidates[0].herbs.length,2);
  assert.equal(out.formula.candidates[0].herbs[0].verificationReasons.length,8);assert.ok(out.formula.candidates[0].herbs[0].verificationReasons.includes('已有提示'));assert.match(out.formula.candidates[0].herbs[0].verificationReasons.join(''),/本例记有.*请医生核对是否保留/);
  assert.equal(out.formula.modifications.filter(r=>r.action==='加'&&r.herbName==='川芎').length,0);assert.equal(out.formula.modifications.length,2);/* R47 F2：删加减药的核对记录留在notApplicable，不进入患者注意事项。 */ assert.doesNotMatch(out.nonPharma.precautions.join(''),/未加川芎/);assert.match(out.formula.candidates[0].notApplicable,/未加川芎.*月经过多及出血性疾病/);
});
await check('2.6 超时、异常、缺项、重复编号、开关关闭与取消均无动作',async()=>{
  const content=wrap(root()),ctx={recordText:'经量较往年明显增多。'};
  let duplicateRejected=false,missingRejected=false;
  const invalid=async(_n,_s,messages,_o,parse)=>{const rows=JSON.parse(messages[1].content).rows;duplicateRejected=parse(JSON.stringify({rows:rows.map(()=>({id:0,applies:false}))}))===undefined;missingRejected=parse('{"rows":[]}')===undefined;return undefined;};
  assert.deepEqual(await caution.checkHerbCautions(content,ctx,undefined,invalid),[]);assert.equal(duplicateRejected,true);assert.equal(missingRejected,true);
  for(const stub of [async()=>undefined,async()=>{throw Error('timeout');},async(_n,_s,_m,_o,parse)=>{assert.equal(parse('{"rows":[]}'),undefined);return undefined;}]) assert.deepEqual(await caution.checkHerbCautions(content,ctx,undefined,stub),[]);
  process.env.CDSS_HERB_CAUTION_CHECK='false';try{assert.deepEqual(await caution.checkHerbCautions(content,ctx,undefined,task(positive)),[]);}finally{delete process.env.CDSS_HERB_CAUTION_CHECK;}
  const abort=new AbortController();abort.abort();assert.deepEqual(await caution.checkHerbCautions(content,ctx,abort.signal,task(positive)),[]);
});
await check('2.7 合并按药名匹配，先删行不复活，炮制变化不串生制注意',async()=>{
  const original=wrap(root());const hits=await caution.checkHerbCautions(original,{recordText:'经量较往年明显增多。'},undefined,task(positive));
  const fitted=root();fitted.formula.modifications.shift();const out=unwrap(caution.applyHerbCautionHits(wrap(fitted),hits));assert.equal(out.formula.modifications.length,2);assert.equal(out.formula.modifications[0].herbName,'麦冬');
});
await check('2.8 本方批任务与适配并行；补写候选同样在既有复核阶段并行核注意',()=>{
  const route=fs.readFileSync('src/app/api/diagnosis/prescribe/route.ts','utf8');const block=route.slice(route.indexOf('m04CandidateTransform: async'),route.indexOf('prescribeSignatureContext:',route.indexOf('m04CandidateTransform: async')));
  assert.match(block,/Promise\.all\([\s\S]*prepareM04CandidateContent[\s\S]*checkHerbCautions/);assert.match(block,/applyHerbCautionHits\(prepared, cautionHits\)/);
  const fit=fs.readFileSync('src/lib/m04-modification-fit.server.ts','utf8');assert.match(fit,/filterProposals: async[\s\S]*checkHerbCautions/);
});
await check('3.1 教材独有孕妇慎用药不作君臣；第五十一轮起佐使也不用',()=>{
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{name:'伸筋草',role:'君'}],'患者性别：女\n患者年龄：28岁\n婚育史：妊娠12周。'),'herb_0_special_population_high_risk_pregnancy');
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{name:'伸筋草',role:'臣'}],'患者性别：女\n患者年龄：28岁\n婚育史：可能妊娠。'),'herb_0_special_population_high_risk_pregnancy');
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{name:'伸筋草',role:'佐'}],'患者性别：女\n患者年龄：28岁\n婚育史：妊娠12周。'),'herb_0_special_population_high_risk_pregnancy','第五十一轮（用户 11/18）：不分君臣佐使');
});
await check('3.2 否认、未记录和他人孕史不触发教材角色限制；别名不漏',()=>{
  for(const context of ['患者性别：男\n现病史：伸筋疼痛。','患者性别：女\n婚育史：明确未孕。','患者性别：女\n家族史：母亲妊娠期间曾腿痛。'])assert.equal(contract.m04GenerationSpecialPopulationIssue([{name:'伸筋草',role:'君'}],context),undefined,context);
  assert.equal(identity.textbookPregnancyRestricted('醋鳖甲'),true);
});
await check('4.1 生何首乌补益精血或补肝肾改制；润肠用途保留生品',()=>{
  assert.equal(processing.purposeProcessedHerbName('生何首乌','','补益精血',9)?.name,'制何首乌');
  assert.equal(processing.purposeProcessedHerbName('何首乌','','补肝肾，益精血',9)?.name,'制何首乌');
  assert.equal(processing.purposeProcessedHerbName('何首乌','','养血',6)?.name,'制何首乌');
  assert.equal(processing.purposeProcessedHerbName('生何首乌','','润肠通便',6),undefined);
});
await check('4.2 牡蛎收敛固涩写煅，安神潜阳仍生用；同机制可用于龙骨',()=>{
  assert.equal(processing.purposeProcessedHerbName('牡蛎','','收敛固涩',20)?.name,'煅牡蛎');
  assert.equal(processing.purposeProcessedHerbName('牡蛎','','收敛固涩，潜阳固脱',20)?.name,'煅牡蛎');
  assert.equal(processing.purposeProcessedHerbName('牡蛎','','重镇安神，潜阳补阴',20),undefined);
  assert.equal(processing.purposeProcessedHerbName('龙骨','','收敛固涩',20)?.name,'煅龙骨');
});
await check('4.3 剂量越界、倾向用法不改规格',()=>{
  assert.equal(processing.purposeProcessedHerbName('何首乌','','补肝肾',80),undefined);
  assert.equal(processing.purposeProcessedHerbName('白芍','','平抑肝阳',10),undefined);
});
await check('4.4 交付真正走到用途规格，药表和方义一致且幂等',()=>{
  const input=root();input.formula.candidates[0]={name:'本例辨证组方',herbs:[{name:'生何首乌',dose:'9g',role:'臣',function:'补益精血'},{name:'牡蛎',dose:'20g',role:'佐',function:'收敛固涩'}],formulaAnalysis:'生何首乌补益精血，牡蛎收敛固涩。',decoction:{method:'水煎服。'}};
  const out=surface.projectDeliveredReasoning(input);assert.deepEqual(out.formula.candidates[0].herbs.map(h=>h.name),['制何首乌','煅牡蛎']);assert.match(out.formula.candidates[0].formulaAnalysis,/制何首乌/);assert.equal(surface.projectDeliveredReasoning(out).formula.candidates[0].herbs[0].name,'制何首乌');
});
await check('5.1 mL 可解析但绝不作克数；只有液体白名单能通过体积剂量',()=>{
  assert.equal(contract.normalizeComparableDose('30毫升'),'30mL');assert.equal(contract.doseInGrams('30mL'),undefined);
  assert.equal(contract.dosePassesSafetySanityCeiling('竹沥','30mL'),true);assert.equal(contract.dosePassesSafetySanityCeiling('当归','30mL'),false);
  assert.equal(contract.dosePassesSafetySanityCeiling('竹沥','15mL'),true);assert.equal(contract.doseWithinConservativeModelLimit('竹沥','15mL','兑服'),false);assert.equal(contract.doseWithinConservativeModelLimit('竹沥','15mL','兑服',{fraction:0.5}),true);
  assert.equal(contract.doseWithinConservativeModelLimit('竹沥','50mL','兑服'),true);assert.equal(contract.doseWithinConservativeModelLimit('竹沥','51mL','兑服'),false);assert.equal(contract.dosePassesSafetySanityCeiling('竹沥','30g'),false);
});
await check('5.2 竹沥不作药引剔除，克单位纠正为体积并标兑服',()=>{
  for(const dose of ['30mL','30g']){const r=root();r.formula.candidates[0].herbs.push({name:'竹沥',role:'佐',dose});const out=unwrap(safety.dropSafetyConflictingM04CandidateHerbs(wrap(r),'现病史：咳黄痰，口干。'));const herb=out.formula.candidates[0].herbs.find(h=>h.name==='竹沥');assert.ok(herb);assert.equal(herb.dose,'30mL');assert.equal(herb.decoctionRequirement,'兑服');}
  assert.deepEqual(decoction.decoctionRuleForHerb('竹沥').required,['兑服']);
  assert.equal(liquid.suggestedLiquidHerbDose('竹沥','40g'),'40mL');assert.equal(liquid.suggestedLiquidHerbDose('竹沥',undefined),'30mL');
  assert.match(fs.readFileSync('src/lib/m04-proposal-compiler.ts','utf8'),/const volumeDose = suggestedLiquidHerbDose\(herbName, modelDose, pediatric\?\.fraction\);\s*if \(volumeDose\) return volumeDose;/);
  const control=root();control.formula.candidates[0].herbs.push({name:'姜汁',role:'佐',dose:'10mL'},{name:'茯苓',role:'佐',dose:'10g'});assert.ok(!unwrap(safety.dropSafetyConflictingM04CandidateHerbs(wrap(control),'现病史：咳痰。')).formula.candidates[0].herbs.some(h=>h.name==='姜汁'),'其它未有体积依据的药引仍走旧规则');
});
await check('5.3 交付液态药与本地提交检查不再把毫升认作缺量',()=>{
  assert.equal(revision.isValidEditedHerbDose('30mL','竹沥'),true);assert.equal(revision.isValidEditedHerbDose('30mL','当归'),false);assert.equal(revision.isValidEditedHerbDose('30g','竹沥'),false);
  assert.match(fs.readFileSync('src/lib/his-scheme.ts','utf8'),/isValidEditedHerbDose\(herb\.dose, herb\.name\)/);
  const r=root();r.formula.candidates[0].herbs=[{name:'竹沥',role:'君',dose:'30g',function:'清热豁痰'}];r.formula.candidates[0].decoction={doseCount:'3剂',dosesPerDay:1,administrationTimesPerDay:2,course:'3天',method:'每日1剂，水煎取300mL，分2次温服，竹沥兑服。'};
  r.formula.modifications=[{action:'加',herbName:'竹沥',doseOrHandling:'40g',reason:'清热豁痰',trigger:'痰稠'}];
  const out=surface.projectDeliveredReasoning(r);assert.equal(out.formula.modifications[0].doseOrHandling,'40mL');assert.match(out.formula.modifications[0].riskNote,/竹沥兑服/);assert.equal(out.formula.candidates[0].herbs[0].dose,'30mL');assert.match(out.formula.candidates[0].decoction.method,/竹沥.*兑服/);
  out.formula.candidates[0].decoction.followUpNode='完成3剂后复诊';
  const state={...types.normalizeCaseStateInput({id:'synth-herb',patient:{sex:'男',age:40},chiefComplaint:'咳痰'}),reasoningPrescribe:out};assert.equal(local.prescriptionSubmissionIssue(state),undefined);
  state.reasoningPrescribe.formula.candidates[0].herbs[0].dose='适量';assert.equal(local.prescriptionSubmissionIssue(state),'herb_dose_incomplete');
});
console.log(`r1064-herb: ${checks} checks, ${process.exitCode ? 'FAILED' : 'PASS'}`);
