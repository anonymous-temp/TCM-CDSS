import fs from "node:fs";
import { createJiti } from "jiti";
const jiti=createJiti(import.meta.url,{alias:{"@":`${process.cwd()}/src`}});
const g=await jiti.import("../src/lib/clinical-governance-tables.ts");
const ind=await jiti.import("../src/lib/tcm-formula-indications.ts");
const syn=(await jiti.import("../src/data/tcm-syndrome-lexicon.json")).default;
const rows=Array.isArray(syn)?syn:(syn.entries||[]);
const CHAN=/_channel_level$/;
const prof=new Map();
for(const r of rows){ const o=new Set((r.locations||[]).filter(x=>!CHAN.test(x))), n=new Set(r.natures||[]);
  if(o.size&&n.size) prof.set(r.id,{o,n,l:r.canonical}); }
const SECOND=new Set(["fluid_retention","water_dampness","dampness","phlegm","food_stagnation"]);
const sub=(a,b)=>[...a].every(x=>b.has(x));

const m03=JSON.parse(fs.readFileSync("/tmp/gy/m03-case5.json","utf8"));
// 复刻 governedReasoningTags 的病位/病性抽取(只用签名 M03 自己的字段)
const loc=new Set(); for(const v of [...(m03.pathogenesis?.locationDifferentiation?.items||[]),
  ...((m03.pathogenesis?.locationDifferentiation?.details||[]).map(d=>d.location))]){
  const e=g.canonicalTcmLocationTerm(v); if(e) loc.add(e.id); }
const nat=new Set(); const nd=m03.pathogenesis?.natureDifferentiation||{};
for(const v of [...(nd.items||[]), nd.rootDeficiency, nd.branchExcess]){ const e=g.canonicalTcmNatureTerm(v); if(e) nat.add(e.id); }
console.log("本例签名病位:",[...loc].join(",")||"(空)");
console.log("本例签名病性:",[...nat].join(",")||"(空)");
const corroborated=(tagId)=>{ const p=prof.get(tagId); if(!p) return false;
  if(!loc.size||!nat.size) return false;
  if(!sub(p.o,loc)) return false;
  if(sub(p.n,nat)) return true;
  const diff=[...p.n].filter(x=>!nat.has(x));
  return diff.length===1 && diff.every(x=>SECOND.has(x)); };

const list=ind.retrieveTcmFormulaCandidatesForReasoning(m03,30);
console.log(`\n召回 ${list.length} 首,逐条看新判据:`);
let gain=0;
for(const e of list.slice(0,20)){
  const hit=(e.syndromeTags||[]).filter(t=>corroborated(t));
  const mark=e.positiveSufficiency?"已通过":(hit.length?"★新增通过":"仍不通过");
  if(!e.positiveSufficiency&&hit.length) gain++;
  console.log(`  ${mark.padEnd(10)} ${e.name}  命中标签=${hit.map(t=>g.governedTcmTermLabelById(t)).join("、")||"-"}`);
}
console.log(`\n本例新增可锁定: ${gain} 首`);
