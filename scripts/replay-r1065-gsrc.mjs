// Offline only. All source files and output directory are explicit arguments; never calls a model.
import fs from 'node:fs';
import path from 'node:path';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{alias:{'@':`${process.cwd()}/src`,'server-only':`${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`}});
const single=await jiti.import('../src/lib/pathogenesis-single-source.ts');
const closure=await jiti.import('../src/lib/analysis-element-closure.ts');
const summary=await jiti.import('../src/lib/diagnosis-visible-summary.ts');
const [manifestPath,outDir]=process.argv.slice(2);
if(!manifestPath||!outDir)throw Error('usage: node scripts/replay-r1065-gsrc.mjs manifest.json outDir');
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));fs.mkdirSync(outDir,{recursive:true,mode:0o700});
const counts={},changes=[],review=[];
const lex=JSON.parse(fs.readFileSync('src/data/tcm-nature-lexicon.json','utf8')).entries;
const policy=JSON.parse(fs.readFileSync('src/data/diagnosis-text-consistency.source.json','utf8')).analysisSourcePolicy;
const a=v=>Array.isArray(v)?v:[];
function recordFor(input){return [`主诉：${input.chiefComplaint||''}`,...Object.entries(input.symptoms||{}).map(([k,v])=>`${k}：${v}`),`舌象：${input.tongue||''}`,`脉象：${input.pulse||''}`,...Object.entries(input.vitals||{}).map(([k,v])=>`${k}：${v}`),...a(input.conversation).filter(r=>r.role==='user').map(r=>r.content)].join('\n');}
function metrics(r,record,derived){const p=r.pathogenesis||{},n=p.natureDifferentiation||{},l=p.locationDifferentiation||{},o=r.overview||{};
 const names=single.analysisElements([o.primarySyndrome,...a(o.secondarySyndromes)].join('；')).natures;
 const root=single.analysisElements(a(n.rootDeficiency).join('；')).natures,branch=single.analysisElements(a(n.branchExcess).join('；')).natures;
 const missingSide=names.some(id=>{const label=lex.find(x=>x.id===id)?.canonical||'';const side=summary.natureItemDeficiencyOrExcess(label);return side==='root'?(id==='deficiency'?!a(n.rootDeficiency).length:!root.includes(id)):side==='branch'?!branch.includes(id):false;});
 const pending=a(p.uncertainties);
 const settledPending=pending.some(row=>single.uncertaintyContradictsResolvedAxis(row,p)||(closure.uncertaintyAsksListedElement(row.item,p)&&n.resolution==='resolved'));
 const answered=pending.some(row=>closure.uncertaintyAnsweredByRecord(row.item,record));
 const invalidLocation=a(l.details).some(row=>String(row.basis||'').split(/[，,。；;、\n]/u).some(piece=>{const q=piece.replace(/^[^：:]*[：:]\s*/, '').trim();if(!q)return false;if(new RegExp(policy.normalFindings,'u').test(q))return true;return record.split('\n').some(line=>line.includes(q)&&new RegExp(policy.excludedSection,'u').test(line))&&!single.groundedAnalysisQuotes(q,record).length;}));
 const lacking=/尚缺直接的病历依据/.test(l.resolutionReason||'')&&a(derived?.pathogenesis?.locationDifferentiation?.details).some(d=>single.analysisElements(l.resolutionReason||'').locations.some(id=>single.analysisElements(d.location).locations.includes(id)));
 return [missingSide,settledPending,answered,invalidLocation,lacking].map(Number);
}
for(const entry of manifest.outputs){const raw=JSON.parse(fs.readFileSync(entry.path,'utf8')),record=recordFor(raw.input||{});let row={set:entry.set,id:entry.id,record,stages:{}};
 for(const stage of ['diagnose','prescribe']){const old=raw[stage]?.structured;if(!old?.pathogenesis)continue;const next=structuredClone(old);single.derivePathogenesisFromConclusions(next,record);
 const before=metrics(old,record,next),after=metrics(next,record,next);const bucket=counts[entry.set]??={cases:0,stages:0,before:[0,0,0,0,0],after:[0,0,0,0,0],changed:0};bucket.stages++;if(stage==='diagnose')bucket.cases++;before.forEach((v,i)=>bucket.before[i]+=v);after.forEach((v,i)=>bucket.after[i]+=v);
 const select=r=>({syndrome:r.overview.primarySyndrome,chain:r.pathogenesis.chain,location:r.pathogenesis.locationDifferentiation,nature:r.pathogenesis.natureDifferentiation,pending:r.pathogenesis.uncertainties});
 const changed=JSON.stringify(select(old))!==JSON.stringify(select(next));if(changed)bucket.changed++;
 row.stages[stage]={changed,before:select(old),after:select(next),metricsBefore:before,metricsAfter:after};
 }changes.push(row);
}
for(const packet of manifest.reviews){for(const row of JSON.parse(fs.readFileSync(packet.path,'utf8'))){for(const finding of a(row.findings).filter(f=>f.item==='H'&&f.level==='错')){
 const id=row.file.replace(/\.txt$/,'').replace(/^sb-/,'new47-');const change=changes.find(c=>c.set===packet.set&&c.id===id);
 review.push({...finding,set:packet.set,id,matched:!!change,before:change?.stages.diagnose?.before,after:change?.stages.diagnose?.after});
}}}
for(const [file,value] of [['summary.json',counts],['changes.json',changes],['h-review.json',review]])fs.writeFileSync(path.join(outDir,file),JSON.stringify(value,null,2),{mode:0o600});
console.log(JSON.stringify({counts,reviewRows:review.length,unmatched:review.filter(r=>!r.matched).map(r=>r.id)},null,2));
