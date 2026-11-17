// 仅对已存结构化输出回放：逐字/受治理同义词与现有判据作确定性近似，不能替代模型实测。
import fs from 'node:fs';
import path from 'node:path';
import { createJiti } from 'jiti';
const [inputRoot,goldPath,outDir]=process.argv.slice(2);
if(!inputRoot||!goldPath||!outDir)throw Error('usage: replay-r1066-elements.mjs <saved-output-root> <c10-gold.json> <output-dir>');
const jiti=createJiti(import.meta.url,{alias:{'@':`${process.cwd()}/src`,'server-only':`${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`}});
const closure=await jiti.import('../src/lib/m03-syndrome-element-closure.server.ts');
const criteria=await jiti.import('../src/lib/m03-secondary-syndrome-consistency.server.ts');
const safety=await jiti.import('../src/lib/diagnosis-safety.ts');
const textbook=await jiti.import('../src/lib/tcm-textbook-syndromes.ts');
const signs=await jiti.import('../src/lib/analysis-element-closure.ts');
const governance=await jiti.import('../src/lib/clinical-governance-tables.ts');
const gold=JSON.parse(fs.readFileSync(goldPath,'utf8'));
const compact=(s)=>String(s||'').replace(/[\s，,。；;、：:（）()]/gu,'');
const groups=safety.POSITIVE_FACT_EQUIVALENT_GROUPS;
const stats={note:'离线近似：逐字/受治理同义表映射到既有 evaluateCriteriaMatches；不调用模型；unknown 保留。已存交付面为输入，不能复现上游重写、后续锚定与M04。',total:0,renamed:0,secondary:0,withdrawn:0,changed:0,new47:{total:0,before:0,after:0,beforeExact:0,afterExact:0},sets:{},c10:[],changes:[]};
const verifier=async(name,ctx)=>{
 let entry=criteria.diagnosticsCriteriaFor(name)||criteria.elementCompositeCriteriaEntry(name);
 if(!entry){
  const row=textbook.textbookRowsNamed(name)[0];
  if(row)entry={name,line:0,keyPointsText:'',specific:[],category:null,categoryEntries:[],manifestations:textbook.primaryManifestationTerms?.(row)||criteria.primaryManifestationTerms(row)};
 }
 if(!entry)return {verdict:'unknown',specific:0,category:0,listed:0,distinct:0,entry:name};
 const items=criteria.criteriaItemsFor(entry);
 const clauses=ctx.recordText.split(/[，,。；;\n]/u).map(s=>s.replace(/^[^：:]{0,10}[：:]/u,'').trim()).filter(Boolean);
 const matches=[];
 const used=new Set();
 for(const item of items){
  const variants=[item,...groups.filter(g=>g.some(t=>compact(t)===compact(item))).flat()];
  let quote;
  for(const variant of variants.sort((a,b)=>b.length-a.length)){
   for(const clause of clauses){
    if(!signs.textHasSign(clause,variant))continue;
    const at=ctx.recordText.indexOf(variant);
    if(at<0||safety.clauseLocalMentionPolarityAt(ctx.recordText,at)!=='affirmed')continue;
    if(used.has(variant))continue;
    quote=variant;break;
   }
   if(quote)break;
  }
  if(quote){used.add(quote);matches.push({item,quote});}
 }
 return criteria.evaluateCriteriaMatches(entry,matches,ctx);
};
const same=(a,b)=>a===b||Boolean(governance.resolveNationalStandardTcmSyndromeTerm(a)?.id&&governance.resolveNationalStandardTcmSyndromeTerm(a)?.id===governance.resolveNationalStandardTcmSyndromeTerm(b)?.id);
fs.mkdirSync(outDir,{recursive:true,mode:0o700});
const log=console.info;console.info=()=>{};
for(const group of ['prod-c10-b2','retest-a7','new40-a7','new45-a7','p100c-a7','new47-a7']){
 const count={total:0,renamed:0,secondary:0,withdrawn:0,changed:0};stats.sets[group]=count;
 for(const file of fs.readdirSync(path.join(inputRoot,group)).filter(f=>f.endsWith('.r1.json')).sort()){
  const saved=JSON.parse(fs.readFileSync(path.join(inputRoot,group,file),'utf8'));
  const before=saved.diagnose?.structured;if(!before){throw Error(`missing structured ${group}/${file}`);}
  const state=saved.input;
  const gate=safety.withSafetyGate(state).safetyGate;
  const flags=gate?.status==='red_flag'?gate.redFlags:[];
  const recordText=safety.trustedInputText(state);
  const d=await closure.decideElementSupport(JSON.stringify(before),{recordText,caseState:state,gateRedFlags:flags},undefined,verifier);
  const after=JSON.parse(closure.applyElementSupportDecision(JSON.stringify(before),d));
  const old=before.overview.primarySyndrome,next=after.overview.primarySyndrome;
  const added=(after.overview.secondarySyndromes||[]).filter(s=>!(before.overview.secondarySyndromes||[]).includes(s));
  const withdrawalProbe={...before,overview:{...before.overview,primarySyndrome:after.overview.primarySyndrome,secondarySyndromes:after.overview.secondarySyndromes}};
  const withdrawals=(d?.elements||[]).filter(x=>x.verdict.verdict==='fail').filter(x=>closure.applyElementSupportDecision(JSON.stringify(withdrawalProbe),{...d,elements:[x],collapse:undefined})!==JSON.stringify(withdrawalProbe)).map(x=>({type:x.unit.type,organs:x.unit.organs,label:x.unit.label}));
  const changed=JSON.stringify(before)!==JSON.stringify(after),renamed=old!==next;
  const row={set:group,id:file.replace('.r1.json',''),old,next,oldSecondary:before.overview.secondarySyndromes||[],secondary:after.overview.secondarySyndromes||[],added,withdrawals,protectedByPrimary:d?.protectedByPrimary,verdicts:(d?.elements||[]).map(x=>({type:x.unit.type,organs:x.unit.organs,entry:x.verdict.entry,verdict:x.verdict.verdict,strict:x.verdict.strict,quotes:x.verdict.quotes})),collapse:d?.collapse};
  count.total++;stats.total++;
  for(const [key,yes] of [['renamed',renamed],['secondary',added.length>0],['withdrawn',withdrawals.length>0],['changed',changed]])if(yes){stats[key]++;count[key]++;}
  if(changed){stats.changes.push(row);fs.writeFileSync(path.join(outDir,`${group}-${row.id}.json`),JSON.stringify({before:{overview:before.overview,pathogenesis:before.pathogenesis,therapy:before.therapy},after:{overview:after.overview,pathogenesis:after.pathogenesis,therapy:after.therapy}},null,2),{mode:0o600});}
  if(group==='prod-c10-b2'){
   const answer=gold.find(g=>g.key===row.id)?.gold?.split('/');
   stats.c10.push({...row,gold:answer,goldDiseaseUnchanged:before.overview.tcmDiseaseName===after.overview.tcmDiseaseName,goldSyndromeBefore:answer?same(old,answer[1]):null,goldSyndromeAfter:answer?same(next,answer[1]):null});
  }
  if(group==='new47-a7'){
   const expected=saved.gold?.syndrome;if(!expected)throw Error(`gold missing ${file}`);
   stats.new47.total++;stats.new47.before+=same(old,expected)?1:0;stats.new47.after+=same(next,expected)?1:0;stats.new47.beforeExact+=old===expected?1:0;stats.new47.afterExact+=next===expected?1:0;row.gold=expected;
  }
 }
}
console.info=log;
fs.writeFileSync(path.join(outDir,'report.json'),JSON.stringify(stats,null,2),{mode:0o600});
fs.writeFileSync(path.join(outDir,'changes.txt'),stats.changes.map(r=>`${r.set}/${r.id}: ${r.old} → ${r.next}${r.added.length?'；兼 '+r.added.join('、'):''}${r.withdrawals.length?'；撤 '+r.withdrawals.map(x=>(x.type==='location'?'病位'+x.organs.join('、'):x.organs.join('')+x.label)).join('、'):''}`).join('\n')+'\n',{mode:0o600});
fs.writeFileSync(path.join(outDir,'c10.txt'),stats.c10.map(r=>`${r.id}: ${r.old} → ${r.next}；兼 ${r.secondary.join('、')||'无'}；撤 ${r.withdrawals.map(x=>x.label).join('、')||'无'}；gold=${r.gold?.join('/')}；经国标同义判定=${r.goldSyndromeAfter}`).join('\n')+'\n',{mode:0o600});
console.log(JSON.stringify({...stats,c10:stats.c10.map(r=>({id:r.id,old:r.old,next:r.next,secondary:r.secondary,gold:r.gold,goldSyndromeAfter:r.goldSyndromeAfter})),changes:stats.changes.length},null,2));
