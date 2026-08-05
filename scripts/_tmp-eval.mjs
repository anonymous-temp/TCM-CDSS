import fs from "node:fs";
import { createJiti } from "jiti";
const jiti=createJiti(import.meta.url,{alias:{"@":`${process.cwd()}/src`}});
const g=await jiti.import("../src/lib/clinical-governance-tables.ts");
const ind=await jiti.import("../src/lib/tcm-formula-indications.ts");
const syn=(await jiti.import("../src/data/tcm-syndrome-lexicon.json")).default;
const rows=Array.isArray(syn)?syn:(syn.entries||[]);
const ZF=new Set(); for(const s of ["肝","胆","心","脾","胃","肺","肾","大肠","小肠","膀胱","三焦","心包","脑","胞宫"]){
  const e=g.canonicalTcmLocationTerm(s); if(e) ZF.add(e.id); }
const prof=new Map();
for(const r of rows){ const o=new Set((r.locations||[]).filter(x=>ZF.has(x))), n=new Set(r.natures||[]);
  if(o.size&&n.size) prof.set(r.id,{o,n,l:r.canonical}); }
const SECOND=new Set(["fluid_retention","water_dampness","dampness","phlegm","food_stagnation"]);
const sub=(a,b)=>[...a].every(x=>b.has(x));
const NAT=[]; for(const s of ["湿","热","寒","风","燥","火","毒","痰","瘀","气虚","血虚","阴虚","阳虚","气滞","水停","食积"]){
  const e=g.canonicalTcmNatureTerm(s); if(e) NAT.push([s,e.id,e.aliases||[]]); }
const natIn=(t)=>{const out=new Set(); const s=String(t||"");
  for(const [w,id,al] of NAT){ if(s.includes(w)||al.some(a=>s.includes(a))) out.add(id); } return out;};
const data=JSON.parse(fs.readFileSync("/tmp/gy/m03-many.json","utf8"));
let tot=0,already=0,gained=0,multi=0; const detail=[];
for(const row of data){
  const m=row.m03, p=m.pathogenesis||{};
  const loc=new Set(); for(const v of [...(p.locationDifferentiation?.items||[]),...((p.locationDifferentiation?.details||[]).map(d=>d.location))])
    for(const e of (g.governedTcmLocationsInText(v)||[])) if(ZF.has(e.id)) loc.add(e.id);
  const nat=new Set(); const nd=p.natureDifferentiation||{};
  for(const v of [...(nd.items||[]),...(nd.rootDeficiency||[]),...(nd.branchExcess||[])]) for(const id of natIn(v)) nat.add(id);
  const corr=(t)=>{const q=prof.get(t); if(!q||!loc.size||!nat.size)return false;
    if(!sub(q.o,loc))return false; if(sub(q.n,nat))return true;
    const d=[...q.n].filter(x=>!nat.has(x)); return d.length===1&&d.every(x=>SECOND.has(x));};
  let list=[]; try{list=ind.retrieveTcmFormulaCandidatesForReasoning(m,40);}catch{continue}
  tot++;
  const old=list.filter(e=>e.positiveSufficiency).map(e=>e.name);
  const neu=list.filter(e=>!e.positiveSufficiency&&(e.syndromeTags||[]).some(corr)).map(e=>e.name);
  if(old.length) already++;
  if(!old.length&&neu.length) gained++;
  if(neu.length>3) multi++;
  detail.push({n:row.n,证:m.overview.primarySyndrome,金标准方:row.金标准方,原可锁:old.slice(0,3),新增:neu.slice(0,5),新增数:neu.length});
}
for(const d of detail) console.log(`#${d.n} 「${d.证}」金标准=${d.金标准方||"-"}\n    原可锁=[${d.原可锁}]  新增=[${d.新增}]${d.新增数>5?` …共${d.新增数}`:""}`);
console.log(`\n=== ${tot} 例:原本有可锁方 ${already} 例;新增使 ${gained} 例从「无方可锁」变为「有方可锁」;新增>3首的 ${multi} 例 ===`);
