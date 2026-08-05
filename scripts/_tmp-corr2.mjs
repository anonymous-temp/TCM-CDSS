import fs from "node:fs";
import { createJiti } from "jiti";
const jiti=createJiti(import.meta.url,{alias:{"@":`${process.cwd()}/src`}});
const g=await jiti.import("../src/lib/clinical-governance-tables.ts");
const ind=await jiti.import("../src/lib/tcm-formula-indications.ts");
const syn=(await jiti.import("../src/data/tcm-syndrome-lexicon.json")).default;
const rows=Array.isArray(syn)?syn:(syn.entries||[]);
// 只比脏腑实体病位:卫气营血/经络/层次类是释义脚手架,不是本例定位
const ZF=new Set(); for(const s of ["肝","胆","心","脾","胃","肺","肾","大肠","小肠","膀胱","三焦","心包","脑","胞宫"]){
  const e=g.canonicalTcmLocationTerm(s); if(e) ZF.add(e.id); }
const prof=new Map();
for(const r of rows){ const o=new Set((r.locations||[]).filter(x=>ZF.has(x))), n=new Set(r.natures||[]);
  if(o.size&&n.size) prof.set(r.id,{o,n,l:r.canonical}); }
const SECOND=new Set(["fluid_retention","water_dampness","dampness","phlegm","food_stagnation"]);
const sub=(a,b)=>[...a].every(x=>b.has(x));
// 病性包含扫描(镜像 governedTcmLocationsInText 的做法)
const NAT=[]; for(const s of ["湿","热","寒","风","燥","火","毒","痰","瘀","气虚","血虚","阴虚","阳虚","气滞","水停","食积"]){
  const e=g.canonicalTcmNatureTerm(s); if(e) NAT.push([s,e.id,e.aliases||[]]); }
const naturesInText=(t)=>{const out=new Set(); const s=String(t||"");
  for(const [w,id,al] of NAT){ if(s.includes(w)||al.some(a=>s.includes(a))) out.add(id); } return out;};

const m03=JSON.parse(fs.readFileSync("/tmp/gy/m03-case5.json","utf8"));
const p=m03.pathogenesis||{};
const loc=new Set(); for(const v of [...(p.locationDifferentiation?.items||[]),...((p.locationDifferentiation?.details||[]).map(d=>d.location))])
  for(const e of (g.governedTcmLocationsInText(v)||[])) if(ZF.has(e.id)) loc.add(e.id);
const nat=new Set(); const nd=p.natureDifferentiation||{};
for(const v of [...(nd.items||[]),...(nd.rootDeficiency||[]),...(nd.branchExcess||[])]) for(const id of naturesInText(v)) nat.add(id);
console.log("本例签名脏腑病位:",[...loc].join(",")||"(空)");
console.log("本例签名病性:",[...nat].join(",")||"(空)");
const corr=(tagId)=>{ const q=prof.get(tagId); if(!q||!loc.size||!nat.size) return false;
  if(!sub(q.o,loc)) return false;
  if(sub(q.n,nat)) return true;
  const d=[...q.n].filter(x=>!nat.has(x)); return d.length===1&&d.every(x=>SECOND.has(x)); };
const list=ind.retrieveTcmFormulaCandidatesForReasoning(m03,40);
let gain=0,already=0;
console.log(`\n召回 ${list.length} 首:`);
for(const e of list){ const hit=(e.syndromeTags||[]).filter(t=>corr(t));
  if(e.positiveSufficiency){already++;continue;}
  if(hit.length){gain++; console.log(`  ★新增 ${e.name}  经 ${hit.map(t=>g.governedTcmTermLabelById(t)).join("、")}`);} }
console.log(`\n原本可锁定 ${already} 首,新增 ${gain} 首 / 共召回 ${list.length} 首`);
