import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createJiti } from 'jiti';
import { wireFixture } from './fixtures/r1064-m04/wire-fixture.mjs';
// No test or mutation may escape to a real provider. wire() installs its own synthetic responder.
globalThis.fetch = async () => { throw new Error('m04wire_offline_only'); };
const jiti = createJiti(import.meta.url, { alias: { '@': `${process.cwd()}/src`, 'server-only': `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
Object.assign(process.env, { OPENAI_API_KEY:'test-only',OPENAI_BASE_URL:'https://api.deepseek.com',CONTROLLED_TERMINOLOGY_MODEL:'deepseek-flash',AI_TEXT_PROVIDER:'bailian-qwen',BAILIAN_QWEN_API_KEY:'test-only',BAILIAN_QWEN_BASE_URL:'https://dashscope.aliyuncs.com/compatible-mode/v1',BAILIAN_QWEN_MODEL:'qwen3.7-plus',PRIMARY_PRESCRIBE_MODEL:'qwen3.7-plus',PRIMARY_PRESCRIBE_REPAIR_MODEL:'qwen3.8-max',M04_ORCHESTRATION_DEADLINE_MS:'60000', CDSS_M04_FINAL_CONTENT:'true', CDSS_M04_FINAL_ANALYSIS:'on', CDSS_M04_MODIFICATION_CLOSED_SET:'off', CDSS_M05_PREFETCH:'false', REASONING_CONTRACT_SIGNING_KEY:'m04wire-synthetic-signing-key-more-than-32-characters' });
const types = await jiti.import('../src/lib/diagnosis-types.ts');
const compiler = await jiti.import('../src/lib/m04-proposal-compiler.ts');
const surface = await jiti.import('../src/lib/delivered-surface.ts');
const projection = await jiti.import('../src/lib/m04-final-projection.ts');
const policy = await jiti.import('../src/lib/m04-final-content-policy.ts');
const delivery = await jiti.import('../src/lib/m04-final-delivery.server.ts');
const visible = await jiti.import('../src/lib/diagnosis-visible-summary.ts');
const source = await jiti.import('../src/lib/herb-function-display-source.ts');
const snap = await jiti.import('../src/lib/m04-final-snapshot.ts');
const binding = await jiti.import('../src/lib/clinical-review-binding.ts');
const signature = await jiti.import('../src/lib/reasoning-contract-signature.ts');
const checkpoint = await jiti.import('../src/lib/m04-delivery-checkpoint.ts');
const application = await jiti.import('../src/lib/herb-application-index.server.ts');
const evidence = await jiti.import('../src/lib/governed-evidence-sources.server.ts');
const cache = await jiti.import('../src/lib/stage-result-coalescing.server.ts');
const draft = await jiti.import('../src/lib/diagnosis-stream-module-drafts.ts');
const { prior, proposal } = wireFixture(types.ReasoningV2Schema);
const state = types.normalizeCaseStateInput({id:'m04wire-synthetic',patient:{age:45,sex:'男'},chiefComplaint:'食少倦怠，便溏',symptoms:{presentHistory:'食少倦怠，大便溏薄。'},reasoningDiagnose:prior});
const record = '成人；食少倦怠；大便溏薄';
const reasoning = () => types.ReasoningV2Schema.parse(compiler.compileM04Proposal(structuredClone(proposal), prior, state));
const wrap = r => `安全横幅\n\n# 候选方药\n旧正文\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(r)}\n<!-- DIAGNOSIS_JSON_END -->`;
const parse = text => JSON.parse(text.split('<!-- DIAGNOSIS_JSON_START -->')[1].split('<!-- DIAGNOSIS_JSON_END -->')[0]);
const ctx = {structuredStage:'prescribe',structuredCaseState:state,structuredPriorReasoning:prior,structuredClinicalContext:record};
const signatureContext = {contractVersion:'tcm-cdss-m04-signature-v3',caseId:'synthetic',encounterId:'synthetic',clinicalInputHash:`sha256:${'a'.repeat(64)}`,diagnoseContractHash:`sha256:${'b'.repeat(64)}`};
let checks=0,failures=0;
async function check(id,title,fn){if(process.env.M04WIRE_CHECK && process.env.M04WIRE_CHECK!==id)return;checks++;try{await fn();console.log(`✓ ${id} ${title}`);}catch(e){failures++;console.error(`✗ ${id} ${title}\n${e.stack}`);}}
const seal = async (r=reasoning(),io={}) => delivery.applyM04FinalContent(wrap(r),binding.clinicalReviewNotPerformedAttestation(r),ctx,undefined,Date.now()+3000,io);
await check('27','方名身份/方向类问题（路由已按自己的口径放行）不在终稿这一步判死；剂量类照旧拦（第四十七轮新 40 份 3 份无剂量页）',async()=>{
 const prior2=structuredClone(prior);prior2.overview={...prior2.overview,recommendedFormulaNames:['四君子汤'],formulaSelectionMode:'single'};
 const ctx2={...ctx,structuredPriorReasoning:prior2};
 const r=reasoning();r.formula.candidates[0].name='四君子汤加减';r.formula.candidates[0].formulaNames=[];
 const out=await delivery.applyM04FinalContent(wrap(r),binding.clinicalReviewNotPerformedAttestation(r),ctx2,undefined,Date.now()+3000,{});
 assert.ok(out.content.includes('DIAGNOSIS_JSON_START'));
 const bad=reasoning();bad.formula.candidates[0].herbs[0].dose='999g';await assert.rejects(seal(bad),/m04_final_safety:/);
});
// 第四十七轮终测：终表方义的模型调用在 0.9 秒预算内 269/269 超时、全部落成逐味功效罗列，复核出处方义失败率 40–62%；缺省改关，本套件显式开启以继续钉住该路径的接线。
await check('01','终表方义缺省关（显式开启才走）、闭集待A/B，false逐字返回且不调用模型',async()=>{
 assert.equal(policy.m04FinalContentPolicy({}).enabled,true);assert.equal(policy.m04FinalContentPolicy({}).analysis,'off');assert.equal(policy.m04FinalContentPolicy({CDSS_M04_FINAL_ANALYSIS:'on'}).analysis,'on');assert.equal(policy.m04FinalContentPolicy({}).modifications,'off');
 process.env.CDSS_M04_FINAL_CONTENT='false';try{const r=reasoning(),text=wrap(r),a=binding.clinicalReviewNotPerformedAttestation(r);assert.deepEqual(await delivery.applyM04FinalContent(text,a,ctx,undefined,undefined,{call(){throw Error('unexpected');}}),{content:text,attestation:a});}finally{process.env.CDSS_M04_FINAL_CONTENT='true';}
 assert.equal(policy.m04FinalContentPolicy({CDSS_M04_FINAL_ANALYSIS:'on',CDSS_M04_HERB_FUNCTION_SOURCE_ONLY:'false'}).enabled,false);assert.equal(policy.m04FinalContentPolicy({CDSS_M04_HERB_FUNCTION_SOURCE_ONLY:'false'}).enabled,true);
});
await check('02','编译角色以药表为准，旧开关仍随方义校正臣佐',()=>{
 const p=structuredClone(proposal.candidate);p.formulaAnalysis='党参为君药，白术为佐药，茯苓为臣药，炙甘草为使药。';
 const on=compiler.m04CompilerTestHooks.withAnalysisConsistentCandidate(p,prior,state);assert.equal(on.herbs[1].role,'臣');
 process.env.CDSS_M04_FINAL_CONTENT='false';try{assert.equal(compiler.m04CompilerTestHooks.withAnalysisConsistentCandidate(p,prior,state).herbs[1].role,'佐');}finally{process.env.CDSS_M04_FINAL_CONTENT='true';}
});
await check('03','功效原句投影不借用方义，自由功效不进入预览',()=>{
 const r=reasoning();r.formula.candidates[0].herbs[0].function='降气平喘，醒神';r.formula.candidates[0].formulaAnalysis='党参降气平喘醒神。';
 const result=parse(visible.applyDeterministicHerbFunctions(wrap(r)));const h=result.formula.candidates[0].herbs[0];
 assert.ok(h.function && !/降气平喘|醒神/u.test(h.function));assert.ok(source.functionClauses(h.function).every(t=>source.herbFunctionSourceClauses(h.name).some(s=>s.text===t)));
 const frames=draft.newM04ModuleDraftFrames(JSON.stringify({candidate:r.formula.candidates[0]}),new Set());assert.ok(frames.length);assert.doesNotMatch(frames[0].content,/降气平喘|醒神/u);
});
await check('04','旧方义不再控制药引，投影幂等且终稿无异药',()=>{
 const r=reasoning();r.formula.candidates[0].formulaAnalysis='去生地黄，白芷醒神。';
 const out=surface.projectDeliveredReasoning(r,{caseState:state,recordText:record});assert.deepEqual(surface.projectDeliveredReasoning(out,{caseState:state,recordText:record}),out);
 assert.doesNotMatch(out.formula.candidates[0].formulaAnalysis,/白芷|去生地黄/u);
 const raw=readFileSync(new URL('../src/lib/delivered-surface.ts',import.meta.url),'utf8');assert.match(raw,/const guideNote = m04FinalContentPolicy\(\)\.enabled/);
});
await check('05','末端作者只见最终表，JSON、Markdown和attestation同源',async()=>{
 const calls=[];const r=reasoning();r.formula.candidates[0].formulaAnalysis='旧的矛盾方义';
 const out=await seal(r,{call:async(task,payload)=>{calls.push(task);assert.ok(!JSON.stringify(payload).includes('旧的矛盾方义'));return {sentences:[]};}});
 const final=parse(out.content);assert.deepEqual(calls,['analysis']);assert.ok(out.content.startsWith('安全横幅'));assert.ok(out.content.includes(final.formula.candidates[0].formulaAnalysis));
 assert.equal(out.attestation.reviewedPayloadHash,binding.clinicalReviewPayloadHash(final));assert.doesNotMatch(out.content,/旧正文|旧的矛盾方义/u);assert.equal(types.reasoningV2SchemaIssueCode(final),undefined);
});
await check('06','终稿签名覆盖功效和方义，后改任一药味使签名失效',async()=>{
 const out=await seal();const r=parse(out.content);r.clinicalReview=out.attestation;
 const signed=signature.applyPrescribeContractSignature(wrap(r),signatureContext);const final=parse(signed);
 assert.ok(binding.hasBoundClinicalReviewAttestation(final));assert.match(final.contractSignature,/^hmac-sha256:/);
 const stale=structuredClone(final);stale.formula.candidates[0].herbs[0].role='使';assert.equal(binding.hasBoundClinicalReviewAttestation(stale),false);
 const changed=signature.applyPrescribeContractSignature(wrap({...stale,clinicalReview:binding.clinicalReviewNotPerformedAttestation(stale)}),signatureContext);assert.notEqual(parse(changed).contractSignature,final.contractSignature);
});
await check('07','作者超时、abort与坏JSON均退终稿摘要，不还原旧方义',async()=>{
 for(const mode of ['timeout','abort','json']){const controller=new AbortController();if(mode==='abort')controller.abort();const out=await delivery.applyM04FinalContent(wrap(reasoning()),undefined,ctx,controller.signal,Date.now()+20,{call:async()=>mode==='timeout'?new Promise(()=>{}):'{bad'});const r=parse(out.content);assert.match(r.formula.candidates[0].formulaAnalysis,/党参/);assert.ok(out.attestation.reviewedPayloadHash);}
});
await check('08','非剂量checkpoint正文与独立JSON同稿、无剂量无采纳',()=>{
 const r=reasoning();r.formula.candidates[0].formulaAnalysis='白芷醒神';const cp={content:wrap(r),reasoning:r,payloadHash:binding.clinicalReviewPayloadHash(r)};
 const text=checkpoint.renderM04DeliveryCheckpoint(cp,prior,'dose_withheld',['儿童体重未提供'],{caseState:state,recordText:record});
 const data=JSON.parse(text.split(checkpoint.NON_DOSE_CANDIDATE_JSON_PREFIX)[1].split(checkpoint.NON_DOSE_CANDIDATE_JSON_SUFFIX)[0]);assert.equal(data.adoptable,false);assert.doesNotMatch(text,/白芷醒神|12g|10g|contractSignature/u);assert.ok(text.includes(data.candidates[0].formulaAnalysis));
});
await check('09','应用证据只接受逐字真实引文，伪造药名或内容不注册',()=>{
 const span=application.herbApplications('竹茹')[0];const citation=application.applicationCitation(span);assert.equal(evidence.governedEvidenceSourceVerified(citation),true);assert.equal(evidence.governedEvidenceSourceVerified(citation.replace('竹茹','白芷')),false);assert.equal(evidence.governedEvidenceSourceVerified('《中药学》白芷【应用】：止头晕'),false);
});
await check('10','整体stage缓存按策略版本隔离，包括非法组合回退',()=>{
 const before=cache.stageRequestFingerprint('prescribe',{clientId:'test',customerId:'test'},state);
 process.env.CDSS_M04_FINAL_CONTENT='false';const off=cache.stageRequestFingerprint('prescribe',{clientId:'test',customerId:'test'},state);process.env.CDSS_M04_FINAL_CONTENT='true';assert.notEqual(before,off);
 process.env.CDSS_M04_MODIFICATION_CLOSED_SET='on';try{assert.notEqual(before,cache.stageRequestFingerprint('prescribe',{clientId:'test',customerId:'test'},state));}finally{process.env.CDSS_M04_MODIFICATION_CLOSED_SET='off';}
});
await check('11','独立渲染不更改公开结构，不再触发句内修补',async()=>{
 const out=await seal();const r=parse(out.content);const rendered=visible.renderFinalM04Content(out.content,r,state);assert.deepEqual(parse(rendered),r);assert.ok(rendered.includes(r.formula.candidates[0].formulaAnalysis));assert.equal(rendered,out.content);
});
await check('12','后改角色/药名会使旧方义失效，源句仍可重复读取',async()=>{
 const out=await seal();const r=parse(out.content);const old=r.formula.candidates[0].formulaAnalysis;
 const s=snap.buildFinalM04Snapshot(r,{record,prior});assert.equal(projection.finalAnalysisMatchesSnapshot(old,s),true);
 r.formula.candidates[0].herbs[0].role='臣';const changed=projection.projectM04FinalFacts(r);assert.notEqual(changed.formula.candidates[0].formulaAnalysis,old);assert.match(changed.formula.candidates[0].formulaAnalysis,/党参为臣药/u);
});
await check('13','剂量安全检查独立于方义质量，危险剂量不能定稿签名',async()=>{
 const r=reasoning();r.formula.candidates[0].herbs[0].dose='999g';await assert.rejects(seal(r),/m04_final_safety:/);
});
await check('14','调整/减药复用确定性编译，不能针对表外药',()=>{
 const r=reasoning();const row={trigger:'脘腹胀满',action:'调整',herbName:'党参',reason:'健脾益气',targetPathogenesis:prior.pathogenesis.chain[0].pathogenesis};
 const modifiedState=types.normalizeCaseStateInput({...state,symptoms:{presentHistory:'食少倦怠，大便溏薄，脘腹胀满。'}});const modifiedPrior=structuredClone(prior);modifiedPrior.pathogenesis.chain[0].patientFact+='，脘腹胀满';const accepted=delivery.compileFinalExistingModification(row,r,{prior:modifiedPrior,caseState:modifiedState});assert.equal(accepted?.action,'调整');assert.equal(accepted?.doseOrHandling,null);assert.equal(delivery.compileFinalExistingModification({...row,herbName:'白芷'},r,{prior,caseState:state}),undefined);
});
await check('15','旧作者/自由补写只在各自回退策略运行',async()=>{
 process.env.CDSS_M04_MODIFICATION_CLOSED_SET='on';try{const text=wrap(reasoning());assert.equal(await delivery.prepareM04CandidateContent(text,{recordText:record,prior,caseState:state}),text);const raw=readFileSync(new URL('../src/lib/m04-final-delivery.server.ts',import.meta.url),'utf8');assert.match(raw,/policy.enabled && policy.analysis === "on" \? content : checkFormulaAnalysisClaims/);assert.match(raw,/policy.enabled && policy.modifications === "on" \? content : dropMisfit/);assert.match(raw,/policy.enabled && policy.modifications === "on" \? combined : topUp/);}finally{process.env.CDSS_M04_MODIFICATION_CLOSED_SET='off';}
});
await check('16','主路径接点在最后投影后与签名前，M05预取读终稿',()=>{
 const api=readFileSync(new URL('../src/lib/diagnosis-api.ts',import.meta.url),'utf8');const at=api.indexOf('= await applyM04FinalContent(');assert.ok(at>api.lastIndexOf('applyDeliveredSurfaceToContent(emissionContent'));assert.ok(at<api.indexOf('let signedContent = opts.structuredStage'));
 const prefetch=readFileSync(new URL('../src/lib/stage-prefetch.server.ts',import.meta.url),'utf8').split('export function prefetchAssessFollowupFromFinalCandidate')[1];assert.match(prefetch,/authorFollowupFromPrescribeHandoff\(requestCaseState, reasoning, ""\)/);assert.doesNotMatch(prefetch,/normalizeM04DraftCandidate/);
});
const api = await jiti.import('../src/lib/diagnosis-api.ts');
async function wire(first=proposal, options={}) {
 const savedFetch=globalThis.fetch;const requests=[];
 Object.assign(process.env,{OPENAI_API_KEY:'test-only',OPENAI_BASE_URL:'https://api.deepseek.com',CONTROLLED_TERMINOLOGY_MODEL:'deepseek-flash',AI_TEXT_PROVIDER:'bailian-qwen',BAILIAN_QWEN_API_KEY:'test-only',BAILIAN_QWEN_BASE_URL:'https://dashscope.aliyuncs.com/compatible-mode/v1',BAILIAN_QWEN_MODEL:'qwen3.7-plus',PRIMARY_PRESCRIBE_MODEL:'qwen3.7-plus',PRIMARY_PRESCRIBE_REPAIR_MODEL:'qwen3.8-max',M04_ORCHESTRATION_DEADLINE_MS:'60000'});
 if(options.nonStrict)process.env.PRIMARY_PRESCRIBE_MODEL='deepseek-flash';
 globalThis.fetch=async (_url,init)=>{const body=JSON.parse(init.body);requests.push(body);if(requests.length>8)throw Error('unbounded');let value=requests.length===1?first:options.replies?.[requests.length-2]||options.reply||proposal;
  const user=body.messages?.findLast(m=>m.role==='user')?.content||'';
  if(user.startsWith('{') && user.includes('"snapshot"')) {const payload=JSON.parse(user);if(payload.snapshot?.fingerprint)value={fingerprint:payload.snapshot.fingerprint,sentences:[...payload.snapshot.herbs].reverse().filter(h=>h.functionSources.length).map((h,i)=>({id:`wire-${i}`,kind:'herb_group',herbIds:[h.id],role:h.role,sourceIds:[h.functionSources[0].id],targetRefs:[],text:`{herb:${h.id}}为${h.role}药，${h.functionSources[0].text}。`}))};}
  if(body.stream){return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(value)},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}
  return Response.json({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}]});
 };
 try {const response=await api.callDiagnosisStream('synthetic m04wire fixture','deepseek',undefined,'markdown',{structuredStage:'prescribe',structuredCaseState:state,structuredPriorReasoning:prior,structuredClinicalContext:record,truncateFallback:'GENERIC_FALLBACK',structuredOrchestrationStartedAt:Date.now(),prescribeSignatureContext:signatureContext,...options.opts});const frames=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));return {text:frames.filter(f=>f.content?.startsWith('<<<CDSS_STREAM_FINAL>>>')).at(-1)?.content||'',requests};}finally{globalThis.fetch=savedFetch;}
}
await check('17','正常首轮流的终稿正文与签名载荷同源',async()=>{
 const {text,requests}=await wire();const r=parse(text);assert.ok(requests.some(req=>JSON.stringify(req.messages).includes('只为最终药表写方义')));assert.match(r.formula.candidates[0].formulaAnalysis,/^本方[^。]*。炙甘草为使药/u);assert.ok(r.contractSignature);assert.ok(binding.hasBoundClinicalReviewAttestation(r));assert.ok(text.includes(r.formula.candidates[0].formulaAnalysis));assert.ok(projection.finalAnalysisMatchesSnapshot(r.formula.candidates[0].formulaAnalysis,snap.buildFinalM04Snapshot(r,{record,prior})));
});
await check('18','危险首轮必须修复，修复后仍进入末端定稿',async()=>{
 const bad=structuredClone(proposal);bad.candidate.herbs[0].dose='501g';const {text,requests}=await wire(bad);assert.ok(requests.length>=2);const r=parse(text);assert.match(r.formula.candidates[0].formulaAnalysis,/^本方[^。]*。炙甘草为使药/u);assert.ok(binding.hasBoundClinicalReviewAttestation(r));assert.doesNotMatch(text,/501g/);assert.ok(projection.finalAnalysisMatchesSnapshot(r.formula.candidates[0].formulaAnalysis,snap.buildFinalM04Snapshot(r,{record,prior})));
});
await check('19','透明自拟降级与非剂量流均不回到矛盾方义',async()=>{
 const bad=structuredClone(proposal);bad.candidate.formulaAnalysis='白芷醒神，去党参。';
 const locked=structuredClone(prior);Object.assign(locked.overview,{recommendedFormulaNames:['六君子汤'],formulaSelectionMode:'single'});bad.candidate.name='六君子汤';const {text}=await wire(bad,{opts:{structuredPriorReasoning:locked}});assert.ok(parse(text).formula.candidates[0].identityDeclassified);assert.doesNotMatch(text,/白芷醒神|去党参/u);
 const non=await wire(bad,{opts:{structuredDoseWithheldReasons:['儿童体重未提供']}});assert.ok(non.text.includes(checkpoint.NON_DOSE_CANDIDATE_JSON_PREFIX));assert.doesNotMatch(non.text,/白芷醒神|去党参|contractSignature|12g/u);
});
await check('20','HIS展示终稿功效与方义，不二次改写已签数据',async()=>{
 const his=await jiti.import('../src/lib/his-scheme.ts');const out=await seal();const r=parse(out.content);r.clinicalReview=out.attestation;const signed=parse(signature.applyPrescribeContractSignature(wrap(r),signatureContext));
 const hs={...state,reasoningDiagnose:prior,reasoningPrescribe:signed,reasoningV2:signed,prescription:out.content};const payload=his.buildHisAiSchemePayload(hs);
 assert.deepEqual(payload.prescriptions.structuredHerbs.map(h=>[h.name,h.function]),signed.formula.candidates[0].herbs.map(h=>[h.name,h.function]));assert.ok(JSON.stringify(payload).includes(signed.formula.candidates[0].formulaAnalysis));assert.deepEqual(hs.reasoningPrescribe,signed);
});
await check('21','非严格首轮坏JSON经严格fallback仍定稿签名',async()=>{
 const {text,requests}=await wire({invalid:true},{nonStrict:true});const r=parse(text);assert.ok(requests.length>=2);assert.match(r.formula.candidates[0].formulaAnalysis,/^本方[^。]*。炙甘草为使药/u);assert.ok(binding.hasBoundClinicalReviewAttestation(r));assert.ok(projection.finalAnalysisMatchesSnapshot(r.formula.candidates[0].formulaAnalysis,snap.buildFinalM04Snapshot(r,{record,prior})));
});
await check('22','连续性保留时先同步定稿，旧方义不进入预签快照',()=>{
 const r=reasoning();r.formula.candidates[0].formulaAnalysis='白芷醒神，去党参。';const cp=checkpoint.retainM04DeliveryCheckpoint(undefined,{content:wrap(r),reasoning:r,priorReasoning:prior,clinicalContext:record});assert.ok(cp);assert.doesNotMatch(cp.content,/白芷醒神|去党参/u);assert.equal(cp.payloadHash,binding.clinicalReviewPayloadHash(cp.reasoning));assert.ok(cp.content.includes(cp.reasoning.formula.candidates[0].formulaAnalysis));
});
await check('23','来源功效不能反向选择炮制；药名、剂量与功效二次投影稳定',()=>{
 const r=reasoning();const h=r.formula.candidates[0].herbs[0];Object.assign(h,{name:'牛膝',function:'补肝肾，强筋骨',processing:null});
 const a=surface.projectDeliveredReasoning(projection.projectM04FinalFacts(r),{caseState:state,recordText:record});const b=surface.projectDeliveredReasoning(a,{caseState:state,recordText:record});assert.equal(a.formula.candidates[0].herbs[0].name,'牛膝');assert.deepEqual(b,a);
});
await check('24','缺省作者等待预算够写完一段（0.9 秒时 269/269 超时）且有上限；中止时无模型调用',async()=>{
 assert.ok(policy.m04FinalContentPolicy({}).analysisBudgetMs>900&&policy.m04FinalContentPolicy({}).analysisBudgetMs<=4000);const c=new AbortController();c.abort();let calls=0;const result=await delivery.applyM04FinalContent(wrap(reasoning()),undefined,ctx,c.signal,Date.now()+3000,{call:async()=>{calls++;return {};}});assert.equal(calls,0);assert.ok(parse(result.content).formula.candidates[0].formulaAnalysis);
});
await check('25','新路径关闭旧草稿M05预取，只给终稿药表',()=>{
 const raw=readFileSync(new URL('../src/lib/stage-prefetch.server.ts',import.meta.url),'utf8').split('export function prefetchAssessFollowupFromDraftCandidate')[1];assert.match(raw,/if \(m04FinalContentPolicy\(\).enabled \|\|/);
 const deliverySource=readFileSync(new URL('../src/lib/m04-final-delivery.server.ts',import.meta.url),'utf8');assert.ok(deliverySource.indexOf('prefetchAssessFollowupFromFinalCandidate(caseState, final)')>deliverySource.indexOf('final = normalized;'));
});
await check('26','闭集开启后无可靠当前事实不保留旧加减，方义仍按终表写',async()=>{
 process.env.CDSS_M04_MODIFICATION_CLOSED_SET='on';try{const r=reasoning();r.formula.modifications=[{trigger:'本例已见头晕',action:'加',herbName:'白芷',doseOrHandling:null,reason:'头晕',targetPathogenesis:'脾虚',riskNote:'',evidence:{evidenceLevel:'model_inference',source:'模型',confidence:'低'}}];const calls=[];const out=await seal(r,{call:async(kind)=>{calls.push(kind);return kind==='findings'?{findings:[]}:{sentences:[]};}});assert.equal(parse(out.content).formula.modifications.length,0);assert.ok(calls.indexOf('analysis')>calls.indexOf('findings'));assert.doesNotMatch(out.content,/白芷|本例已见头晕/);}finally{process.env.CDSS_M04_MODIFICATION_CLOSED_SET='off';}
});
console.log(JSON.stringify({checks,failures}));if(failures)process.exit(1);
