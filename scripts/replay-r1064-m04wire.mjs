// Offline only; explicit r46c directories. Never loads env files or calls a model.
import {createJiti} from 'jiti';import {readFileSync,readdirSync,writeFileSync} from 'node:fs';import {join,basename,resolve} from 'node:path';
const arm=process.argv[2],root=resolve(process.argv[3]),out=process.argv[4];
const j=createJiti(import.meta.url,{alias:{'@':`${root}/src`,'server-only':`${root}/node_modules/next/dist/compiled/server-only/empty.js`}});
process.env.CDSS_M04_FINAL_CONTENT=arm==='on'?'true':'false';process.env.CDSS_M04_MODIFICATION_CLOSED_SET='off';
const {projectDeliveredReasoning}=await j.import(`${root}/src/lib/delivered-surface.ts`);
const {normalizeCaseStateInput}=await j.import(`${root}/src/lib/diagnosis-types.ts`);
const {clinicalGroundingText}=await j.import(`${root}/src/lib/diagnosis-safety.ts`);
const {m04SafetyContractIssue}=await j.import(`${root}/src/lib/diagnosis-stage-contract.ts`);
const {isKnownTcmHerbName}=await j.import(`${root}/src/lib/tcm-knowledge.ts`);
const {distinctModificationConditions}=await j.import(`${root}/src/lib/m04-proposal-compiler.ts`);
const results=[];
for(const dir of process.argv.slice(5))for(const name of readdirSync(dir).filter(x=>x.endsWith('.r1.json')).sort()){
 const saved=JSON.parse(readFileSync(join(dir,name),'utf8'));const r=saved.prescribe.structured,prior=saved.diagnose.structured,state=normalizeCaseStateInput(saved.input),record=clinicalGroundingText(state);
 const start=performance.now();const projected=projectDeliveredReasoning(r,{caseState:state,recordText:record});const second=projectDeliveredReasoning(projected,{caseState:state,recordText:record});
 const safety=m04SafetyContractIssue(projected,prior,{isKnownHerbName:isKnownTcmHerbName,trustedWorkbenchEdit:false,auditedClinicalRisksAreAdvisory:false,clinicalContext:record,waiveTherapyCoverageAnnotated:true});
 results.push({id:`${basename(dir)}:${name}`,milliseconds:performance.now()-start,idempotent:JSON.stringify(projected)===JSON.stringify(second),safety:safety||null,distinct:distinctModificationConditions(projected.formula.modifications),reasoning:projected});
}
writeFileSync(out,JSON.stringify({arm,cases:results},null,2));console.log(JSON.stringify({arm,count:results.length,nonIdempotent:results.filter(x=>!x.idempotent).map(x=>x.id)}));
