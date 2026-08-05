// 线上语料回归:把手上带金标准的病历全过一遍真实生产链路。
// 与 regress:prod-smoke 的区别——那个测「链路是否通」,这个测「临床结论是否对」。
import fs from "node:fs";
const B=(process.env.BASE_URL||"").replace(/\/+$/,""), T=process.env.CDSS_API_TOKEN||"";
const H={"Content-Type":"application/json","x-cdss-api-token":T};
const LIMIT=Number(process.env.LIMIT||60), OUT=process.env.OUT||"/tmp/gy/ck/online-corpus.json";
const files=(process.env.FILES||"artifacts/web-cases-batch3.json,artifacts/web-cases-batch4-mcq.json,artifacts/web-cases-batch4-records.json").split(",");
let pool=[];
for(const f of files){ if(!fs.existsSync(f))continue;
  const d=JSON.parse(fs.readFileSync(f,"utf8"));
  const rows=Array.isArray(d)?d:(d.cases||d.entries||d.items||[]);
  pool.push(...rows.map((r,i)=>({...r,_src:f.split("/").pop(),_i:i})));
}
// 均匀抽样,不只取头部
const step=Math.max(1,Math.floor(pool.length/LIMIT));
const cases=pool.filter((_,i)=>i%step===0).slice(0,LIMIT);
console.log(`语料 ${pool.length} 例,抽样 ${cases.length} 例`);
async function call(p,b){
  try{const r=await fetch(`${B}/api/diagnosis/${p}`,{method:"POST",headers:H,body:JSON.stringify(b)});
   const raw=await r.text(); if(!r.ok)return{s:r.status,e:raw.slice(0,90)};
   let md="";for(const l of raw.split("\n")){if(!l.trim())continue;try{const o=JSON.parse(l);if(o.content&&o.content!=="[END]")md+=o.content;if(o.error)return{s:"stream_error",e:o.error};}catch{}}
   const m=md.match(/<!-- DIAGNOSIS_JSON_START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END -->/);
   return{s:200,md,js:m?JSON.parse(m[1].trim()):null};
  }catch(e){return{s:"ERR",e:String(e).slice(0,90)};}
}
const results=[]; let n=0;
for(const c of cases){
  n++;
  const cs={id:`corpus-${Date.now()}-${n}`,patient:{sex:c.sex||"未知",age:c.age||null},
    chiefComplaint:c.chiefComplaint||"",symptoms:{现病史:c.presentHistory||""},
    tongue:c.tongue||"",pulse:c.pulse||"",conversation:[],vitals:{}};
  const a=await call("diagnose",{caseState:cs});
  const row={no:c.no??c._i,src:c._src,主诉:(c.chiefComplaint||"").slice(0,26),
    金标准病名:c.tcmDisease||null,金标准证候:c.tcmSyndrome||c.syndrome||null,M03:a.s};
  if(a.s===200&&a.js){
    row.主证=a.js.overview?.primarySyndrome;
    row.病名鉴别数=(a.js.overview?.tcmDiseaseDifferentials||[]).length;
    row.病位=a.js.pathogenesis?.locationDifferentiation?.items||[];
    row.治法=a.js.therapy?.overallMethod;
    row.否认误判=/否认/.test(a.md)&&(c.presentHistory||"").length>0
      ? (a.md.match(/病历已记录否认([^；。、]{2,8})/g)||[]).filter(x=>{const t=x.replace(/病历已记录否认/,"");return (c.presentHistory||"").includes(t);}).length : 0;
    row.L标签=/\bL[0-4]\b/.test(a.md);
    row.证候名含括号=/[（(]/.test(a.js.overview?.primarySyndrome||"");
    const b=await call("prescribe",{caseState:{...cs,reasoningDiagnose:a.js}});
    row.M04=b.s;
    if(b.s===200&&b.js){const f=b.js.formula?.candidates?.[0];
      row.首选方=f?.name; row.药味数=f?.herbs?.length||0;
      row.自拟方=/本例辨证组方|自拟/.test(f?.name||"");}
  }
  results.push(row);
  if(n%10===0){console.log(`  ${n}/${cases.length}`); fs.writeFileSync(OUT,JSON.stringify(results,null,1));}
}
fs.writeFileSync(OUT,JSON.stringify(results,null,1));
const ok3=results.filter(r=>r.M03===200).length, ok4=results.filter(r=>r.M04===200).length;
const 括号=results.filter(r=>r.证候名含括号).length, 误判=results.filter(r=>r.否认误判>0).length;
const 标签=results.filter(r=>r.L标签).length, 自拟=results.filter(r=>r.自拟方).length;
console.log(JSON.stringify({总数:results.length,M03成功:ok3,M04成功:ok4,证候名含括号:括号,否认误判:误判,L标签泄漏:标签,自拟方:自拟},null,2));
