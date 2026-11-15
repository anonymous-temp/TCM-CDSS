// Explicit offline input directories only; never reads credentials or runtime stores.
// Usage: flock /tmp/r1064-heavy.lock node --max-old-space-size=1280 scripts/replay-r1064-m04.mjs <r46c-dir> ...
import assert from 'node:assert/strict';
import { readdirSync,readFileSync } from 'node:fs';
import {join,basename} from 'node:path';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{alias:{'@':`${process.cwd()}/src`,'server-only':`${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`}});
const {finalizeM04Content}=await jiti.import('../src/lib/m04-final-content.server.ts');
const {normalizeCaseStateInput}=await jiti.import('../src/lib/diagnosis-types.ts');
const {clinicalGroundingText}=await jiti.import('../src/lib/diagnosis-safety.ts');
const files=process.argv.slice(2).flatMap(dir=>readdirSync(dir).filter(name=>name.endsWith('.r1.json')).map(name=>join(dir,name))).sort();
if(!files.length) throw Error('Provide explicit saved-output directories');
let modelCalls=0,offChanges=0,sourceFunctionChanges=0,analysisChanges=0,missingFunctions=0,candidates=0;
const cases=[];const functionChanges=new Map();
const strip=r=>{const c=structuredClone(r);for(const candidate of c.formula?.candidates||[]){delete candidate.formulaAnalysis;for(const h of candidate.herbs||[])delete h.function;}return c;};
for(const file of files){
 const saved=JSON.parse(readFileSync(file,'utf8')),r=saved.prescribe?.structured,prior=saved.diagnose?.structured;
 if(!r||!prior)throw Error(`Missing structured reasoning: ${file}`);
 const state=normalizeCaseStateInput(saved.input);
 // No model calls in this replay; input is bound solely for fingerprinting.
 const record=clinicalGroundingText?clinicalGroundingText(state):JSON.stringify(saved.input);
 const ctx={record,prior,caseState:state};
 const off=await finalizeM04Content(r,{...ctx,env:{CDSS_M04_FINAL_CONTENT:"false"}},{call:async()=>{modelCalls++;throw Error('off must not call');}});
 if(JSON.stringify(off)!==JSON.stringify(r))offChanges++;
 assert.equal(off,r);
 const on=await finalizeM04Content(r,{...ctx,env:{CDSS_M04_FINAL_CONTENT:'true',CDSS_M04_HERB_FUNCTION_SOURCE_ONLY:'on',CDSS_M04_FINAL_ANALYSIS:'on'}},{});
 assert.deepEqual(strip(on),strip(r),'The new modules may change content only, not prescription decisions');
 let functions=0,analyses=0,missing=0;
 for(let i=0;i<(r.formula?.candidates||[]).length;i++){
  candidates++;const old=r.formula.candidates[i],now=on.formula.candidates[i];
  if(old.formulaAnalysis!==now.formulaAnalysis){analyses++;analysisChanges++;}
  for(let j=0;j<(old.herbs||[]).length;j++){
   const before=old.herbs[j],after=now.herbs[j];
   if(!after.function){missing++;missingFunctions++;}
   if(before.function!==after.function){functions++;sourceFunctionChanges++;const key=JSON.stringify({name:after.name,before:before.function,after:after.function});functionChanges.set(key,(functionChanges.get(key)||0)+1);}
  }
 }
 cases.push({case:basename(file,'.r1.json'),set:basename(join(file,'..')),functions,analyses,missing});
}
console.log(JSON.stringify({files:files.length,offChanges,modelCalls,candidates,sourceFunctionChanges,analysisChanges,missingFunctions,
 note:'ON is deterministic fact-summary replay with no model and modifications disabled. It is not a clinical improvement rate or latency A/B.',cases,functionChanges:[...functionChanges].map(([change,count])=>({...JSON.parse(change),count}))},null,2));
