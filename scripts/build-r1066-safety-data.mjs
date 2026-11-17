// 受治理安全数据的校验与产物；不读取网络、病历或环境配置。
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const read=name=>JSON.parse(fs.readFileSync(`src/data/${name}`,'utf8'));
const hash=name=>createHash('sha256').update(fs.readFileSync(`src/data/${name}`)).digest('hex');
const herbFile='tcm-antithrombotic-herb-avoid.source.json';
const drugFile='drug-condition-contraindications.source.json';
const oldDrugFile='western-drug-condition-cautions.source.json';
const herbs=read(herbFile), drug=read(drugFile), oldDrug=read(oldDrugFile);
const ensure=(ok,message)=>{if(!ok)throw Error(message);};
ensure(herbs.category==='活血化瘀药','herb category');
ensure(Array.isArray(drug.medicationListLabels)&&drug.medicationListLabels.length>0,'medication list labels');
for(const row of herbs.entries){
 ensure(row.name&&Array.isArray(row.aliases)&&['increase_bleeding','decrease_anticoagulation','conflicting_evidence'].includes(row.direction),`herb identity/direction ${row.name}`);
 ensure(row.basisType&&row.source?.url&&row.source?.quote,`herb provenance ${row.name}`);
}
const rules=[...new Map([...oldDrug.rules,...drug.rules].map(row=>[row.id,row])).values()];
const conditionKeys=new Set(['allOf','anyOf','egfrBelow','egfrAtLeast','egfrAtMost','ckdStageAtLeast','recordTerms','currentRecordTerms','recordedDrugAllergy','reactionTerms','ageAtLeast','potassiumAbove','potassiumAtLeast','potassiumAtMost','currentAntithrombotic','pregnancyOrConception','renalImpairment','currentMedicationTerms']);
function validateCondition(condition,id){
 ensure(condition&&Object.keys(condition).length>0,`empty condition ${id}`);
 for(const [key,value] of Object.entries(condition)){
  ensure(conditionKeys.has(key),`unknown condition ${id}.${key}`);
  if(key==='allOf'||key==='anyOf'){
   ensure(Array.isArray(value)&&value.length>0,`empty logic ${id}.${key}`);
   value.forEach(child=>validateCondition(child,id));
  }else if(Array.isArray(value))ensure(value.length>0&&value.every(item=>typeof item==='string'&&item.trim()),`term list ${id}.${key}`);
  else ensure(typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)),`condition value ${id}.${key}`);
 }
}
for(const row of rules){
 ensure(row.id&&(row.drugTerms?.length||row.drugSuffixes?.length)&&row.condition&&row.sentence&&row.source?.url&&row.source?.quote,`drug rule ${row.id}`);
 validateCondition(row.condition,row.id);
 for(const id of row.supersedes||[])ensure(rules.some(rule=>rule.id===id),`unknown superseded rule ${row.id} -> ${id}`);
}
for(const [file,value,sources] of [
 ['tcm-antithrombotic-herb-avoid.json',herbs,[herbFile]],
 ['drug-condition-contraindications.json',{...drug,rules},[drugFile,oldDrugFile]],
]){
 const generated={...value,sourceHashes:Object.fromEntries(sources.map(name=>[name,hash(name)]))};
 fs.writeFileSync(`src/data/${file}`,JSON.stringify(generated,null,2)+'\n');
 console.log(`${file}: ${value.entries?.length??value.rules.length}`);
}
