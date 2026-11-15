// 本机离线回放工具：保存病历和逐条差异仅写工作目录外，不读取环境或密钥。
import fs from 'node:fs';
import path from 'node:path';
import { createJiti } from 'jiti';
const args=process.argv.slice(2), base=args[0]||'/var/tmp/r1064/herb-before';
const make=(root)=>createJiti(import.meta.url,{alias:{'@':`${root}/src`,'server-only':`${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`}});
const old=make(base), current=make(process.cwd());
const oldSurface=await old.import(`${base}/src/lib/delivered-surface.ts`),newSurface=await current.import(`${process.cwd()}/src/lib/delivered-surface.ts`);
const oldSafety=await old.import(`${base}/src/lib/m04-modification-safety.ts`),newSafety=await current.import(`${process.cwd()}/src/lib/m04-modification-safety.ts`);
const caution=await current.import(`${process.cwd()}/src/lib/herb-caution-check.server.ts`);
const grounding=await current.import(`${process.cwd()}/src/lib/diagnosis-safety.ts`);
const wrap=(r)=>`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(r)}\n<!-- DIAGNOSIS_JSON_END -->`;
const unwrap=(s)=>JSON.parse(s.split('<!-- DIAGNOSIS_JSON_START -->')[1].split('<!-- DIAGNOSIS_JSON_END -->')[0]);
// 桩只给字面命中及一次已预先点名的语义同义判断；真正的判断仍须通过两家一致和服务端极性核对。
const stub=async(_ns,_stage,messages,_opts,parse)=>{
 const payload=JSON.parse(messages[1].content);
 const mapped={'湿盛中满':['食后脘腹痞满'],'月经过多':['月经量多','经量增多'],'食少便溏':['食少便溏']};
 const result=parse(JSON.stringify({rows:payload.rows.map(t=>{
  const mention=[t.item.condition,...(mapped[t.item.condition]||[])].find(q=>payload.record.includes(q));
  return {id:t.id,applies:Boolean(mention),quote:mention||'',mention:mention||''};
 })}));return result?[result,result]:undefined;
};
const root=args[1]||'/home/coder/runlogs/r1018/work/r1063/out',outDir=args[2]||'/var/tmp/r1064/herb-replay',results=[];let count=0;
for(const set of ['p100c','new40','new45','retest'])for(const file of fs.readdirSync(`${root}/${set}-r46c`).filter(n=>n.endsWith('.r1.json')).sort()){
 const saved=JSON.parse(fs.readFileSync(`${root}/${set}-r46c/${file}`,'utf8'));const r=saved.prescribe?.structured;if(!r)throw Error(`${file} missing prescribed reasoning`);
 const recordText=grounding.clinicalGroundingText(saved.input),content=wrap(r);count++;
 const oldPruned=unwrap(oldSafety.dropSafetyConflictingM04CandidateHerbs(content,recordText));const newPruned=unwrap(newSafety.dropSafetyConflictingM04CandidateHerbs(content,recordText));
 const before=oldSurface.projectDeliveredReasoning(oldPruned,{recordText}),processed=newSurface.projectDeliveredReasoning(newPruned,{recordText});
 const hits=await caution.checkHerbCautions(wrap(processed),{recordText},undefined,stub);const after=unwrap(caution.applyHerbCautionHits(wrap(processed),hits));
 const changes=[];
 const diff=(a,b,p='')=>{if(JSON.stringify(a)===JSON.stringify(b))return;if(Array.isArray(a)&&Array.isArray(b)&&a.length===b.length){a.forEach((v,i)=>diff(v,b[i],`${p}[${i}]`));return;}if(a&&b&&!Array.isArray(a)&&!Array.isArray(b)&&typeof a==='object'&&typeof b==='object'){for(const k of new Set([...Object.keys(a),...Object.keys(b)]))diff(a[k],b[k],p?`${p}.${k}`:k);return;}changes.push({field:p,before:a,after:b});};
 diff(before,after);if(changes.length)results.push({file:`${set}-${file}`,processingChanged:JSON.stringify(before)!==JSON.stringify(processed),hits,changes});
}
fs.mkdirSync(outDir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(outDir,'changes.json'),JSON.stringify({count,changed:results.length,results},null,2),{mode:0o600});
console.log(JSON.stringify({count,changed:results.length,processingChanged:results.filter(r=>r.processingChanged).length,cautionChanged:results.filter(r=>r.hits.length).length,changedFields:results.reduce((s,r)=>s+r.changes.length,0)}));
