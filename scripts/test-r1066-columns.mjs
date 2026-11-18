import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { alias: { '@': `${process.cwd()}/src`, 'server-only': `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const columns = await jiti.import('../src/lib/pathogenesis-columns.ts');
const classification = await jiti.import('../src/lib/nature-column-classification.ts');
const alignment = await jiti.import('../src/lib/m03-analysis-alignment.server.ts');
const surface = await jiti.import('../src/lib/delivered-surface.ts');
let failed=0,passed=0;
const check=async(id,title,run)=>{if(process.env.COLUMNS_ONLY&&process.env.COLUMNS_ONLY!==id)return;try{await run();passed++;console.log(`✓ ${id} ${title}`);}catch(error){failed++;console.error(`✗ ${id} ${title}\n${error.stack}`);}};
const E={evidenceLevel:'model_inference',source:'患者原文',confidence:'中'};
const base=()=>({schemaVersion:'tcm-cdss-reasoning-v2',stage:'diagnose',overview:{tcmDiseaseName:'心悸',primarySyndrome:'心脾两虚证',secondarySyndromes:[],primarySyndromeBasis:['气短乏力','面色淡白'],tcmDiagnosticRationale:'气短乏力，为气血不足，心神失养。',overallPathogenesis:'气血不足，心神失养。'},pathogenesis:{natureDifferentiation:{items:['气虚','血虚'],rootDeficiency:['气虚','血虚'],branchExcess:[],basis:'气短乏力；面色淡白',resolution:'resolved',evidence:E},chain:[{nodeId:'P1',patientFact:'气短乏力',pathogenesis:'心气不足',therapyDirection:'益气养心，宁心安神',evidence:E}],uncertainties:[]},therapy:{overallMethod:'益气养血，宁心安神',overallPrinciple:'虚则补之'}});
const record='气短乏力，面色淡白，无咯血，咳黄黏痰。';
const pending=(item,reason='尚需核实')=>({item,reason,affects:'辨证'});
await check('C01','虚寒虚热气脱精亏归本，邪实及气逆归标，失调和未知不猜',()=>{
 for(const label of ['虚寒','虚热','心气欲脱','阳脱','精亏','气陷','阴虚火旺','气阴两伤','阴伤','阴火'])assert.equal(classification.natureItemDeficiencyOrExcess(label),'root');
 for(const label of ['寒','热','血瘀','气滞','气逆','风毒','痰饮','水湿','食积','腑实','阳亢','肝阳上亢','热邪伤津'])assert.equal(classification.natureItemDeficiencyOrExcess(label),'branch');
 for(const label of ['阴阳失调','尚待辨证','无'])assert.equal(classification.natureItemDeficiencyOrExcess(label),undefined);
});
await check('C02','两栏所有错位和占位统一重分，保留列中已写条目，幂等',()=>{
 const n={items:['虚热','寒','血虚'],rootDeficiency:['寒'],branchExcess:['虚热','气脱','无']};classification.classifyNatureColumns(n);
 assert.deepEqual(n.rootDeficiency,['虚热','血虚','气脱']);assert.deepEqual(n.branchExcess,['寒']);assert.ok(n.items.includes('气脱'));const copy=structuredClone(n);classification.classifyNatureColumns(n);assert.deepEqual(n,copy);
 const detailed={items:['寒'],rootDeficiency:['风寒外束'],branchExcess:[]};classification.classifyNatureColumns(detailed);assert.deepEqual(detailed.items,['寒']);assert.deepEqual(detailed.branchExcess,['风寒外束']);const ordered={items:['气虚','血虚'],rootDeficiency:['血虚','气虚'],branchExcess:[]};classification.classifyNatureColumns(ordered);assert.deepEqual(ordered.rootDeficiency,['血虚','气虚']);
});
await check('C03','空本虚有肯定断言和逐字支持引文则归栏；非空不擅自扩证素',()=>{
 const r=base();r.pathogenesis.natureDifferentiation={items:['气滞'],rootDeficiency:[],branchExcess:['气滞'],basis:'气短乏力'};columns.reconcileEmptyNatureAssertions(r,record);
 assert.ok(r.pathogenesis.natureDifferentiation.rootDeficiency.includes('气虚'));assert.ok(r.pathogenesis.natureDifferentiation.rootDeficiency.includes('血虚'));
 const n=base();n.pathogenesis.natureDifferentiation.items=['气虚'];n.pathogenesis.natureDifferentiation.rootDeficiency=['气虚'];columns.reconcileEmptyNatureAssertions(n,record);assert.deepEqual(n.pathogenesis.natureDifferentiation.rootDeficiency,['气虚']);
});
await check('C04','无依据肯定虚性按句撤，否认句和真实句保留；无病历不猜',()=>{
 const r=base();r.overview.tcmDiagnosticRationale='胁部胀痛，为气滞。心气欲脱。未见阳虚。';r.overview.overallPathogenesis='心气欲脱。';r.pathogenesis.chain=[];r.overview.primarySyndromeBasis=['胁部胀痛'];r.pathogenesis.natureDifferentiation={items:['气滞'],rootDeficiency:[],branchExcess:['气滞'],basis:'胁部胀痛'};
 columns.reconcileEmptyNatureAssertions(r,'胁部胀痛');assert.equal(r.overview.tcmDiagnosticRationale,'胁部胀痛，为气滞。未见阳虚。');assert.equal(r.overview.overallPathogenesis,'心气欲脱。');// 总指挥第四十九轮：删到核心下限以下保留原文（m11/h32 无剂量页）
 const n=base();n.pathogenesis.natureDifferentiation={items:[],rootDeficiency:[],branchExcess:[]};const before=n.overview.tcmDiagnosticRationale;columns.reconcileEmptyNatureAssertions(n,'');assert.equal(n.overview.tcmDiagnosticRationale,before);
});
await check('C05','空标实寒热瘀有逐字依据归栏，虚热不产生实热',()=>{
 for(const [mechanism,quote,label] of [['寒滞经络','局部冷痛','寒'],['热扰心神','口渴欲饮','热'],['瘀阻经络','舌紫暗','血瘀']]){const r=base();r.overview.tcmDiagnosticRationale=mechanism;r.overview.overallPathogenesis=mechanism;r.overview.primarySyndromeBasis=[quote];r.pathogenesis.chain=[{nodeId:'P1',patientFact:quote,pathogenesis:mechanism}];r.pathogenesis.natureDifferentiation={items:['气虚'],rootDeficiency:['气虚'],branchExcess:[],basis:quote};columns.reconcileEmptyNatureAssertions(r,quote);assert.ok(r.pathogenesis.natureDifferentiation.branchExcess.includes(label),label);}
 assert.ok(!columns.assertedNatureLabels('阴虚火旺，虚热内扰。').includes('热'));
 const other=base();other.overview.overallPathogenesis='湿困中焦。';other.pathogenesis.chain=[{nodeId:'P1',patientFact:'苔白腻，便溏',pathogenesis:'湿困中焦'}];columns.reconcileEmptyNatureAssertions(other,'苔白腻，便溏');assert.deepEqual(other.pathogenesis.natureDifferentiation.branchExcess,[]);assert.equal(other.pathogenesis.chain[0].pathogenesis,'湿困中焦');
});
await check('C06','病历阳性阴性与真同义均收口，未知冲突及未答复合项保留',()=>{
 const r=base();r.pathogenesis.uncertainties=[pending('有无咯血尚待核实'),pending('是否有咳痰'),pending('是否兼痰'),pending('有无呕吐'),pending('有无咯血及盗汗'),pending('有无胸痛')];
 columns.reconcileAnalysisUncertainties(r,record+'咳痰。胸痛是否存在尚不明确。');assert.deepEqual(r.pathogenesis.uncertainties.map(x=>x.item),['有无呕吐','有无盗汗','有无胸痛']);
 const c=base();c.pathogenesis.uncertainties=[pending('有无胸痛')];columns.reconcileAnalysisUncertainties(c,'昨日无胸痛。今日胸痛。');assert.equal(c.pathogenesis.uncertainties.length,1);
 const syn=base();syn.pathogenesis.uncertainties=[pending('有无黑便')];columns.reconcileAnalysisUncertainties(syn,'柏油样便。');assert.equal(syn.pathogenesis.uncertainties.length,0);
});
await check('C07','证名已含及依据肯定气血不足不再问，程度问题仍留',()=>{
 const r=base();r.pathogenesis.uncertainties=[pending('是否兼血虚'),pending('是否兼气虚'),pending('是否兼血虚程度严重')];columns.reconcileAnalysisUncertainties(r,record);assert.deepEqual(r.pathogenesis.uncertainties.map(x=>x.item),['是否兼血虚程度严重']);
 const named=base();named.overview.tcmDiagnosticRationale='';named.pathogenesis.natureDifferentiation={items:['气滞'],rootDeficiency:[],branchExcess:['气滞']};named.pathogenesis.uncertainties=[pending('是否兼血虚')];columns.reconcileAnalysisUncertainties(named,'');assert.equal(named.pathogenesis.uncertainties.length,0);
 const n=base();n.overview.primarySyndrome='肝郁气滞证';n.pathogenesis.natureDifferentiation={items:['气滞'],rootDeficiency:[],branchExcess:['气滞']};n.pathogenesis.uncertainties=[pending('是否兼血虚')];columns.reconcileAnalysisUncertainties(n,record);assert.equal(n.pathogenesis.uncertainties.length,0);
 const neg=base();neg.overview.primarySyndrome='肝郁气滞证';neg.overview.tcmDiagnosticRationale='未见血虚。';neg.pathogenesis.natureDifferentiation={items:['气滞'],rootDeficiency:[],branchExcess:['气滞']};neg.pathogenesis.uncertainties=[pending('是否兼血虚')];columns.reconcileAnalysisUncertainties(neg,record);assert.equal(neg.pathogenesis.uncertainties.length,1);
});
await check('C08','湿象成组已记、整体已定不再问；组合缺项保留未答部分',()=>{
 const r=base();r.pathogenesis.uncertainties=[pending('是否兼湿'),pending('舌苔已明确','无需再核实'),pending('寒热喜恶与大便性状')];columns.reconcileAnalysisUncertainties(r,'舌苔白腻，便溏，热敷减轻。');assert.ok(!r.pathogenesis.uncertainties.some(x=>x.item==='是否兼湿'));assert.ok(!r.pathogenesis.uncertainties.some(x=>x.item==='舌苔已明确'));
 const noRecord=base();const detailed=pending('是否兼肾气不固','本例虽见夜尿多，未见肾气不固的辨证要点（腰膝酸软、滑精）成组出现');noRecord.pathogenesis.uncertainties=[detailed];columns.reconcileAnalysisUncertainties(noRecord,'');assert.deepEqual(noRecord.pathogenesis.uncertainties,[detailed]);
 const partial=base();partial.pathogenesis.uncertainties=[pending('寒热喜恶及遇寒是否加重')];columns.reconcileAnalysisUncertainties(partial,'畏寒，肢冷。');assert.deepEqual(partial.pathogenesis.uncertainties.map(x=>x.item),['遇寒是否加重']);
 const m=base();m.pathogenesis.uncertainties=[pending('有无呕吐')];columns.reconcileAnalysisUncertainties(m,'呕吐情况未记录。');assert.equal(m.pathogenesis.uncertainties.length,1);
});
await check('C09','节点方向部分在总法里只留总法项；一项都不在保留原写（第五十一轮）；照抄总法或为空时从总法取相关项；不改总法',()=>{
 const r=base();r.therapy.overallMethod='清热凉血调经，益气养心';r.pathogenesis.chain=[{nodeId:'P1',pathogenesis:'热入血分',therapyDirection:'疏肝清热，宁心安神'},{nodeId:'P2',pathogenesis:'气虚失养',therapyDirection:'宁心安神'},{nodeId:'P3',pathogenesis:'热扰血分',therapyDirection:'凉血调经，疏肝清热'}];columns.reconcileChainTherapy(r);assert.deepEqual(r.pathogenesis.chain.map(x=>x.therapyDirection),['疏肝清热，宁心安神','宁心安神','凉血调经'],'第五十一轮：节点治法没有一项在总治法里时保留模型原写；部分在时只留在的项');assert.equal(r.therapy.overallMethod,'清热凉血调经，益气养心');
 const n=base();n.therapy.overallMethod='';columns.reconcileChainTherapy(n);assert.equal(n.pathogenesis.chain[0].therapyDirection,'益气养心，宁心安神','第五十一轮：没有对应总治法项时保留模型原写');
 const full=base();full.therapy.overallMethod='健脾益气，补益肝肾，润燥生津，解毒消肿，降逆和胃，升阳举陷';full.pathogenesis.chain=['精亏，髓海不足','燥邪伤津','毒结局部','气逆上冲','气陷下陷'].map((pathogenesis,i)=>({nodeId:`P${i}`,pathogenesis,therapyDirection:''}));columns.reconcileChainTherapy(full);assert.deepEqual(full.pathogenesis.chain.map(n=>n.therapyDirection),['补益肝肾','润燥生津','解毒消肿','降逆和胃','升阳举陷']);
});
const wrap=r=>`说明\n<!-- DIAGNOSIS_JSON_START -->${JSON.stringify(r)}<!-- DIAGNOSIS_JSON_END -->\n末尾`;
const unwrap=s=>JSON.parse(s.split('<!-- DIAGNOSIS_JSON_START -->')[1].split('<!-- DIAGNOSIS_JSON_END -->')[0]);
const validRewrite=()=>({rationale:'本例气短乏力为气虚之象，面色淡白为血虚之象，气血生化不足，心神失养，诸症合参辨证为心脾两虚证。',natureItems:['气虚','血虚'],rootDeficiency:['气虚','血虚'],branchExcess:[],natureBasis:'气短乏力；面色淡白',overallPathogenesis:'气血不足，心神失养',uncertainties:[]});
const misaligned=()=>{const r=base();r.overview.tcmDiagnosticRationale='气短乏力，为气虚之象。支持肝火扰心。';return r;};
await check('C10','首稿被拒带原拒因同任务再写一次，二稿通过；空待核实替换旧条目',async()=>{
 const r=misaligned();r.pathogenesis.uncertainties=[pending('有无夜尿')];let calls=0;
 const out=await alignment.alignAnalysisWithConclusion(wrap(r),{recordText:record},undefined,async(name,stage,messages)=>{calls++;assert.equal(name,'m03_analysis_alignment');if(calls===1)return {...validRewrite(),natureBasis:'捏造'};assert.ok(messages.some(m=>m.content.includes('basis_not_verbatim')));return validRewrite();});assert.equal(calls,2);assert.equal(unwrap(out).overview.tcmDiagnosticRationale,validRewrite().rationale);assert.deepEqual(unwrap(out).pathogenesis.uncertainties,[]);
});
await check('C11','两次失败按issue删隐式别证断言，真实句留下；证素栏归P6a不动',async()=>{
 const r=misaligned();r.pathogenesis.natureDifferentiation.items.push('血瘀');r.pathogenesis.natureDifferentiation.branchExcess=['血瘀'];let calls=0;const out=unwrap(await alignment.alignAnalysisWithConclusion(wrap(r),{recordText:record},undefined,async()=>{calls++;return {...validRewrite(),rationale:'过短'};}));assert.equal(calls,2);assert.equal(out.overview.tcmDiagnosticRationale,'气短乏力，为气虚之象。');assert.deepEqual(out.pathogenesis.natureDifferentiation,r.pathogenesis.natureDifferentiation);assert.equal(out.overview.primarySyndrome,r.overview.primarySyndrome);
});
await check('C12','首稿通过仅一次；取消不再发请求；不对齐与开关关闭保持原稿',async()=>{
 let calls=0;await alignment.alignAnalysisWithConclusion(wrap(misaligned()),{recordText:record},undefined,async()=>{calls++;return validRewrite();});assert.equal(calls,1);
 calls=0;assert.equal(await alignment.alignAnalysisWithConclusion(wrap(base()),{recordText:record},undefined,async()=>{calls++;return validRewrite();}),wrap(base()));assert.equal(calls,0);
 const abort=new AbortController();abort.abort();calls=0;await alignment.alignAnalysisWithConclusion(wrap(misaligned()),{recordText:record},abort.signal,async()=>{calls++;return undefined;});assert.equal(calls,0);
 const old=process.env.CDSS_M03_ANALYSIS_ALIGNMENT;process.env.CDSS_M03_ANALYSIS_ALIGNMENT='false';try{assert.equal(await alignment.alignAnalysisWithConclusion(wrap(misaligned()),{recordText:record}),wrap(misaligned()));}finally{if(old===undefined)delete process.env.CDSS_M03_ANALYSIS_ALIGNMENT;else process.env.CDSS_M03_ANALYSIS_ALIGNMENT=old;}
});
await check('C13','最终出口与缓存复用同判据、overview迁入项收口且输入不变',()=>{
 const r=base();r.pathogenesis.uncertainties=[pending('是否兼血虚'),pending('有无咯血')];r.pathogenesis.chain[0].therapyDirection='疏肝清热';const copy=structuredClone(r);const out=surface.projectDeliveredReasoning(r,{recordText:record});assert.deepEqual(r,copy);assert.deepEqual(out.pathogenesis.uncertainties,[]);assert.equal(out.pathogenesis.chain[0].therapyDirection,'疏肝清热','第五十一轮：节点治法与总治法无对应项时保留模型原写');assert.equal(out.overview.primarySyndrome,r.overview.primarySyndrome);assert.equal(out.overview.tcmDiseaseName,r.overview.tcmDiseaseName);const again=surface.projectDeliveredReasoning(out,{recordText:record});assert.deepEqual(again.pathogenesis,out.pathogenesis);
});
await check('C14','重写接受、术语归一与可见轴均复用分类，模型给错栏不延续',async()=>{
 const rw=validRewrite();rw.rootDeficiency=[];rw.branchExcess=['气虚','血虚'];const out=alignment.acceptedAlignmentRewrite(misaligned(),rw,record);assert.ok(out);assert.deepEqual(out.pathogenesis.natureDifferentiation.rootDeficiency,['气虚','血虚']);assert.deepEqual(out.pathogenesis.natureDifferentiation.branchExcess,[]);
 const terminology=await jiti.import('../src/lib/clinical-terminology.ts');const r=base();r.westernDiagnosis={primary:{name:'心悸'}};r.pathogenesis.natureDifferentiation.rootDeficiency=[];r.pathogenesis.natureDifferentiation.branchExcess=['气虚','血虚'];const canonical=terminology.withCanonicalClinicalTerminology(r);assert.deepEqual(canonical.pathogenesis.natureDifferentiation.branchExcess,[]);
 const summary=await jiti.import('../src/lib/diagnosis-visible-summary.ts');const visible=unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(r),record));assert.deepEqual(visible.pathogenesis.natureDifferentiation.branchExcess,[]);
});
await check('C15','overview把握度中的已答待核实同步收口，保留真正缺项',()=>{
 const r=base();r.overview.primarySyndromeResolutionReason='有无咯血尚待核实；有无呕吐尚待核实。';columns.reconcileAnalysisUncertainties(r,record);assert.equal(r.overview.primarySyndromeResolutionReason,'有无呕吐尚待核实。');
 const n=base();n.overview.primarySyndromeResolutionReason='有无咯血尚待核实。';columns.reconcileAnalysisUncertainties(n,record);assert.equal(n.overview.primarySyndromeResolutionReason,undefined);
});

await check('C16','对齐删到合同不通过时实际签名前入口拒绝候选，不能回滚矛盾原稿',async()=>{
 const evidence=E;
const apiCandidate = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "不寐",
    primarySyndrome: "心脾两虚证",
    primarySyndromeBasis: ["心悸健忘", "纳差便溏"],
    // 需求3：辨病与辨证各自成段。
    tcmDiseaseRationale: "以入睡困难、多梦易醒为主症，病程3个月，符合不寐范畴，与郁病、心悸相区分。",
    tcmDiagnosticRationale: "心悸健忘与纳差便溏并见，结合舌淡脉细弱，支持心脾两虚、心神失养。",
    tcmDifferentials: [],
    // 病名级鉴别（2026-08-04 起为 T2 不变式）：签名病名在 GB/T 15657 层级编码中存在相邻病名时
    // 必须给出，且填的必须是病名而不是证型。与上面的 tcmDifferentials（证型鉴别）是两层。
    tcmDiseaseDifferentials: [
      { diseaseName: "多寐病", reason: "同属睡眠病症但方向相反，需先分辨主症", distinguishingPoints: "本例为入睡困难与多梦易醒，非日间嗜睡", nextCheck: null },
    ],
    secondarySyndromes: [],
    overallPathogenesis: "脾气亏虚，心血失养",
    overallTherapy: "健脾益气，养血安神",
    recommendedFormulaDirection: "归脾汤加减",
    recommendedFormulaNames: ["归脾汤"],
    formulaSelectionMode: "single",
    evidence,
  },
  westernDiagnosis: {
    primary: {
      name: "失眠症状",
      status: "考虑",
      confidence: "中",
      supportingFacts: ["入睡困难、多梦易醒3个月"],
      clinicalRationale: "入睡困难、多梦易醒3个月支持失眠症状方向，但尚未取得日间功能受损情况，暂不升级为正式失眠障碍诊断。",
      limitations: ["未完成睡眠量表"],
      suggestedChecks: [],
      evidence,
    },
    differentials: [],
  },
  pathogenesis: {
    summary: "心脾两虚，心神失养",
    locationDifferentiation: { items: ["心", "脾"], evidence },
    natureDifferentiation: { items: ["气虚", "血虚"], evidence },
    chain: [{
      nodeId: "P1",
      patientFact: "心悸健忘、纳差便溏",
      syndromeEvidence: "舌淡，脉细弱",
      pathogenesis: "脾气亏虚，心血失养",
      therapyDirection: "健脾益气，养血安神",
      evidence,
    }],
    uncertainties: [],
  },
  therapy: {
    overallPrinciple: "虚则补之，标本兼顾",
    overallMethod: "健脾益气，养血安神",
    subTherapies: [
      { therapy: "健脾益气", targetPathogenesis: "脾气亏虚", priority: "主要" },
      { therapy: "养血安神", targetPathogenesis: "心血失养", priority: "兼顾" },
    ],
  },
  management: { followupSafetyNet: "若入睡困难持续2周不缓解或明显加重，及时复诊评估。" },
};
 const {callDiagnosisStream}=await jiti.import('../src/lib/diagnosis-api.ts');
 const env={AI_TEXT_PROVIDER:'openai-compatible',OPENAI_API_KEY:'synthetic-columns-only',OPENAI_BASE_URL:'https://api.deepseek.com',OPENAI_MODEL:'deepseek-v4-flash',PRIMARY_DIAGNOSE_MODEL:'deepseek-v4-flash',CONTROLLED_TERMINOLOGY_NORMALIZATION:'false',REASONING_CONTRACT_SIGNING_KEY:'synthetic-columns-signing-key-000000000000'};
 const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));const savedFetch=globalThis.fetch;
 try{
  Object.assign(process.env,env);globalThis.fetch=async(_url,init)=>{const request=JSON.parse(init.body);if(!request.stream)return Response.json({choices:[{message:{content:'{}'},finish_reason:'stop'}]});return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(apiCandidate)},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});};
  const options={structuredStage:'diagnose',structuredClinicalContext:'心悸健忘、纳差便溏；舌淡，脉细弱；入睡困难、多梦易醒3个月',structuredAllowedM03FormulaNames:['归脾汤'],truncateFallback:'SYNTHETIC_COLUMNS_FALLBACK',diagnoseSignatureContext:{contractVersion:'tcm-cdss-m03-signature-v5',caseId:'synthetic-columns',encounterId:'synthetic-columns-encounter',clinicalInputHash:`sha256:${'a'.repeat(64)}`},outputTransform:content=>content.replace(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/g,(_match,json)=>{const value=JSON.parse(json);value.overview.tcmDiagnosticRationale='';return '<!-- DIAGNOSIS_JSON_START -->'+JSON.stringify(value)+'<!-- DIAGNOSIS_JSON_END -->';})};
  const run=async(extra={})=>{const response=await callDiagnosisStream('synthetic columns contract','deepseek',undefined,'markdown',{...options,...extra});const lines=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));return lines.filter(f=>typeof f.content==='string').map(f=>f.content).join('');};
  const control=await run();const parsedControl=control.includes('<!-- DIAGNOSIS_JSON_START -->')?unwrap(control):undefined;assert.ok(parsedControl?.contractSignature,`对照必须能签出原候选：${control.slice(0,1200)}`);
  const rejected=await run({m03AnalysisAlignment:async()=>wrap({schemaVersion:'tcm-cdss-reasoning-v2',stage:'diagnose',overview:{},pathogenesis:{},westernDiagnosis:{},therapy:{}})});
  const parsedRejected=rejected.includes('<!-- DIAGNOSIS_JSON_START -->')?unwrap(rejected):undefined;assert.notDeepEqual(parsedRejected?{overview:parsedRejected.overview,pathogenesis:parsedRejected.pathogenesis}:null,{overview:parsedControl.overview,pathogenesis:parsedControl.pathogenesis},'删空后必须进入合同修复/兜底，不能回滚原临床载荷');
 }finally{globalThis.fetch=savedFetch;for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});

await check('C17','寒热表空单元格不作为空查询进入极性读法，首条引文不支持寒时仍能结束',()=>{
 const signs=columns.natureEvidenceTerms('寒',['肩部隐痛','畏寒']);assert.ok(signs.includes('畏寒'));assert.ok(!signs.includes(''));
 const r=base();r.overview.primarySyndromeBasis=['肩部隐痛','畏寒'];r.pathogenesis.natureDifferentiation.basis='肩部隐痛；畏寒';r.pathogenesis.chain=[{nodeId:'P1',patientFact:'畏寒',pathogenesis:'寒滞经络'}];columns.reconcileEmptyNatureAssertions(r,'肩部隐痛，畏寒');assert.ok(r.pathogenesis.natureDifferentiation.branchExcess.includes('寒'));
});
await check('C18','未知记载过滤保留原逗号否认范围，歧义记载不当成已答',async()=>{
 const safety=await jiti.import('../src/lib/diagnosis-safety.ts');const narrative='无腹痛，发热，呕吐，在家休息3天无效，并有加重趋势。';assert.equal(safety.recordedFindingReading(narrative,'发热'),'ambiguous');const r=base();r.pathogenesis.uncertainties=[pending('有无发热')];columns.reconcileAnalysisUncertainties(r,narrative);assert.equal(r.pathogenesis.uncertainties.length,1);
 const control=base();control.pathogenesis.uncertainties=[pending('有无发热')];columns.reconcileAnalysisUncertainties(control,'未见发热。');assert.equal(control.pathogenesis.uncertainties.length,0);
});
await check('C19','量化所见也用既有读法：体温已明确发热，不要求原文再写发热二字',()=>{
 const r=base();r.pathogenesis.uncertainties=[pending('有无发热')];columns.reconcileAnalysisUncertainties(r,'体温38.4℃。');assert.equal(r.pathogenesis.uncertainties.length,0);
 const unknown=base();unknown.pathogenesis.uncertainties=[pending('有无发热')];columns.reconcileAnalysisUncertainties(unknown,'发热情况不详，体温未测。');assert.equal(unknown.pathogenesis.uncertainties.length,1);
});
await check('C20','虚性火寒词不被截成实邪：命门火衰、阴火、相火偏旺及虚寒',()=>{
 for(const word of ['命门火衰','阴火内生','虚火上扰','虚寒失温'])assert.ok(!columns.assertedNatureLabels(word).some(x=>['火热','热','寒'].includes(x)),word);
 assert.ok(!columns.assertedNatureLabels('相火偏旺','肾阴不足，阴液亏虚').includes('火热'));
 assert.ok(columns.assertedNatureLabels('火毒内盛').includes('火热'));
 const r=base();r.overview.primarySyndrome='肾阳虚证';r.pathogenesis.natureDifferentiation={items:['阳虚'],rootDeficiency:['阳虚'],branchExcess:[],basis:'畏寒肢冷'};r.overview.tcmDiagnosticRationale='命门火衰，阳虚内寒。';r.overview.overallPathogenesis=r.overview.tcmDiagnosticRationale;r.pathogenesis.chain=[{nodeId:'P1',patientFact:'畏寒肢冷',pathogenesis:r.overview.tcmDiagnosticRationale}];columns.reconcileEmptyNatureAssertions(r,'畏寒肢冷');assert.deepEqual(r.pathogenesis.natureDifferentiation.branchExcess,[]);assert.equal(r.overview.tcmDiagnosticRationale,'命门火衰，阳虚内寒。');
});
await check('C21','只对肯定的独立病性断言对账，否定、待定、过程不误删',()=>{
 for(const sentence of ['未见畏寒肢冷及脉沉细等阳虚实据','舌红非虚寒','待四诊补充以定津伤','甚有阳脱之虞'])assert.deepEqual(columns.assertedNatureLabels(sentence),[],sentence);
 assert.ok(columns.assertedNatureLabels('阴虚不能濡养').includes('阴虚'));
 const r=base();r.overview.primarySyndrome='血热证';r.overview.tcmDiagnosticRationale='热灼津伤，口干欲饮。';r.overview.overallPathogenesis=r.overview.tcmDiagnosticRationale;r.overview.primarySyndromeBasis=['口干欲饮'];r.pathogenesis.natureDifferentiation={items:['热'],rootDeficiency:[],branchExcess:['热'],basis:'口干欲饮'};r.pathogenesis.chain=[{nodeId:'P1',patientFact:'口干欲饮',pathogenesis:r.overview.tcmDiagnosticRationale}];columns.reconcileEmptyNatureAssertions(r,'口干欲饮');assert.equal(r.overview.tcmDiagnosticRationale,'热灼津伤，口干欲饮。');assert.deepEqual(r.pathogenesis.natureDifferentiation.rootDeficiency,[]);
});
await check('C22','明确津亏与精亏复用诊断学依据，未知依据不臆造',()=>{
 const signs=columns.natureEvidenceTerms('津亏',['口干欲饮','皮肤干燥']);assert.ok(signs.includes('口干'));assert.ok(signs.includes('皮肤干燥'));assert.ok(columns.natureEvidenceTerms('精亏',['腰膝酸软']).includes('腰膝酸软'));
 const r=base();r.overview.primarySyndrome='肠燥津亏证';r.overview.tcmDiagnosticRationale='肠燥津亏，肠失濡养。';r.overview.overallPathogenesis=r.overview.tcmDiagnosticRationale;r.overview.primarySyndromeBasis=['皮肤干燥','便干'];r.pathogenesis.natureDifferentiation={items:['热'],rootDeficiency:[],branchExcess:['热'],basis:'皮肤干燥；便干'};r.pathogenesis.chain=[];columns.reconcileEmptyNatureAssertions(r,'皮肤干燥，便干。');assert.ok(r.pathogenesis.natureDifferentiation.rootDeficiency.includes('津亏'));assert.equal(r.overview.tcmDiagnosticRationale,'肠燥津亏，肠失濡养。');
});
await check('C23','关系问题不拆成有无题，未答的与否题原样保留',()=>{
 const r=base();const relation=pending('脉象与热象不尽相符','需辨兼夹');const thirst=pending('口渴与否','影响寒热偏性');const coexist=pending('舌红与苔薄白并存','兼夹待辨');r.pathogenesis.uncertainties=[relation,thirst,coexist];columns.reconcileAnalysisUncertainties(r,'舌红，脉象：脉滑，体温38.0℃，否认药物过敏。');assert.deepEqual(r.pathogenesis.uncertainties,[relation,thirst,coexist]);
 const answered=base();answered.pathogenesis.uncertainties=[thirst];columns.reconcileAnalysisUncertainties(answered,'口渴明显。');assert.deepEqual(answered.pathogenesis.uncertainties,[]);
});
await check('C24','overview辨证依据末尾待核实也与已肯定的气血不足对账',()=>{
 const r=base();r.overview.primarySyndrome='气虚发热证';r.pathogenesis.natureDifferentiation={items:['气虚'],rootDeficiency:['气虚'],branchExcess:[]};r.overview.tcmDiagnosticRationale='面色淡白为气血不足。是否兼血虚尚待核实。';columns.reconcileAnalysisUncertainties(r,'面色淡白。');assert.equal(r.overview.tcmDiagnosticRationale,'面色淡白为气血不足。');
 const n=base();n.overview.primarySyndrome='肝气郁结证';n.pathogenesis.natureDifferentiation={items:['气滞'],rootDeficiency:[],branchExcess:['气滞']};n.overview.tcmDiagnosticRationale='未见血虚。是否兼血虚尚待核实。';columns.reconcileAnalysisUncertainties(n,'胁部胀痛。');assert.equal(n.overview.tcmDiagnosticRationale,'未见血虚。是否兼血虚尚待核实。');
});
await check('C25','缺项理由逐项对账：保留经期腹痛，去已记血块；影像、别处血块与颜色不当作排出已答',()=>{
 const question=pending('经期腹痛情况','病历未记录有无腹痛及血块排出情况');
 for(const record of ['本次月经量增多，夹有血块。','本次月经来潮，无血块。']){const r=base();r.pathogenesis.uncertainties=[question];columns.reconcileAnalysisUncertainties(r,record);assert.equal(r.pathogenesis.uncertainties[0].item,question.item);assert.equal(r.pathogenesis.uncertainties[0].reason,'尚需核实腹痛');}
 for(const record of ['本次月经量少，超声示宫腔内有血块。','排便带血，见血块。','排便见血块，月经情况未记录。']){const r=base();r.pathogenesis.uncertainties=[question];columns.reconcileAnalysisUncertainties(r,record);assert.deepEqual(r.pathogenesis.uncertainties,[question]);}
 const other=base();const otherQuestion=pending('泌尿系症状','病历未记录有无腹痛及血块排出情况');other.pathogenesis.uncertainties=[otherQuestion];columns.reconcileAnalysisUncertainties(other,'本次月经量增多，夹有血块。');assert.deepEqual(other.pathogenesis.uncertainties,[otherQuestion]);
 const attr=base();const attribute=pending('经期血块颜色','病历未记录血块颜色');attr.pathogenesis.uncertainties=[attribute];columns.reconcileAnalysisUncertainties(attr,'本次月经量增多，血块增多。');assert.deepEqual(attr.pathogenesis.uncertainties,[attribute]);
});

await check('C26','检查未做未测或未评估不是已答；阴性症状和实际结果仍收口',()=>{
 for(const [item,record] of [['胸片','未做胸片和痰病原学检测。'],['血糖情况','未做头颅CT和血糖。'],['心电图','现场心电图未提供。'],['自杀风险','未进行自杀风险结构化评估。'],['胸痛性质','胸痛性质未充分评估。'],['无真菌镜检','无真菌镜检。'],['口渴与饮水','未描述口渴变化。'],['饮食与用药','病人拒绝进一步说明近期饮食与药物。']]){const r=base();const q=pending(item);r.pathogenesis.uncertainties=[q];columns.reconcileAnalysisUncertainties(r,record);assert.deepEqual(r.pathogenesis.uncertainties,[q],item);}
 const result=base();result.pathogenesis.uncertainties=[pending('血糖'),pending('有无咯血')];columns.reconcileAnalysisUncertainties(result,'血糖5.0mmol/L，无咯血。');assert.deepEqual(result.pathogenesis.uncertainties,[]);
});
await check('C27','组合宽标题缩成剩余检查属性，不改写成有无器官，孰重问题保留',()=>{
 const r=base();r.pathogenesis.uncertainties=[pending('尿色及尿常规'),pending('恶寒与恶风孰重')];columns.reconcileAnalysisUncertainties(r,'尿色黄，微恶寒。');assert.deepEqual(r.pathogenesis.uncertainties.map(x=>x.item),['尿常规','恶寒与恶风孰重']);
});

await check('C28','低热发热和畏寒等病历表现不截成独立实邪，明确热扰寒凝仍识别',()=>{
 for(const sentence of ['阴火内生而低热','卫表不固故恶寒','低热随劳累而发','怕热多汗'])assert.ok(!columns.assertedNatureLabels(sentence).some(x=>['火热','热','寒'].includes(x)),sentence);
 assert.ok(columns.assertedNatureLabels('热扰心神').includes('热'));assert.ok(columns.assertedNatureLabels('寒凝经络').includes('寒'));
});
await check('C29','非和而非统领并列否定，整段虚寒火衰不得成为肯定断言',()=>{
 for(const sentence of ['支持气滞而非湿热或虚寒','非脾肾亏虚、命门火衰之候'])assert.ok(!columns.assertedNatureLabels(sentence).some(x=>['阴虚','阳虚'].includes(x)),sentence);
 assert.ok(columns.assertedNatureLabels('阳虚非常明显').includes('阳虚'));
});

await check('C30','本次未测未评估的缺口不能由既往数值或担心某项的提及顶替',()=>{
 for(const [item,record] of [['眼压及瞳神','既往眼压偏高。今日未测眼压及裂隙灯。'],['听力与发育评估未做','家长担心听力。未做听力筛查和发育量表。']]){const r=base();const q=pending(item);r.pathogenesis.uncertainties=[q];columns.reconcileAnalysisUncertainties(r,record);assert.deepEqual(r.pathogenesis.uncertainties,[q]);}
});

await check('C31','已知表现的程度或主次仍未明时保留问题，不拿有无代答量化',()=>{
 const r=base();const degree=pending('大便偏干','阴津不足或肠燥，程度未明');const priority=pending('咽部异物感','痰气交阻与阴虚并存，主次待定');r.pathogenesis.uncertainties=[degree,priority];columns.reconcileAnalysisUncertainties(r,'大便偏干，咽部异物感。');assert.deepEqual(r.pathogenesis.uncertainties,[degree,priority]);
});

await check('C32','症状已记不能代答诱因和随访，缺项理由的属性作用域保持',()=>{
 const r=base();const triggers=pending('饮食及睡眠具体诱因','病历未记录失眠多梦、食后腹胀的诱发或缓解因素');const followup=pending('骨龄与激素随访','骨龄已记录，进展速度未明');r.pathogenesis.uncertainties=[triggers,followup];columns.reconcileAnalysisUncertainties(r,'失眠多梦，食后腹胀，骨龄8岁。');assert.deepEqual(r.pathogenesis.uncertainties,[triggers,followup]);
});

await check('C90','删句兜底不把总体病机、辨证依据、病机链删空（m11、h32 无剂量页）',async()=>{
 const floor=await jiti.import('../src/lib/m03-core-prose-floor.ts');
 assert.equal(floor.coreProseAfterCut('overallPathogenesis','寒邪外袭肌肤，阳气不达四末，血行凝滞',''),'寒邪外袭肌肤，阳气不达四末，血行凝滞');
 assert.equal(floor.coreProseAfterCut('overallPathogenesis','寒邪外袭肌肤，阳气不达四末，血行凝滞','寒邪外袭肌肤，血行凝滞，络脉不通'),'寒邪外袭肌肤，血行凝滞，络脉不通');
 assert.equal(floor.coreProseAfterCut('tcmDiagnosticRationale','原依据很长的一段话用来判断是否保留原文不被删到太短','故属。'),'原依据很长的一段话用来判断是否保留原文不被删到太短');
 assert.deepEqual(floor.rowsAfterCut([{a:1}],[]),[{a:1}]);assert.deepEqual(floor.rowsAfterCut([{a:1},{a:2}],[{a:2}]),[{a:2}]);
 const r=base();r.overview.overallPathogenesis='心气欲脱。';r.overview.tcmDiagnosticRationale='心气欲脱。';const out=alignment.withoutMisalignedAnalysis(r,record);
 assert.ok(String(out.overview.overallPathogenesis).length>0);assert.ok(String(out.overview.tcmDiagnosticRationale).length>0);
});
await check('C91','交付的病机链节点编号连续（删节点后 P2、P3 → P1、P2；开方阶段不重排）',()=>{
 const r=base();r.pathogenesis.chain=[{nodeId:'P2',patientFact:'头晕',pathogenesis:'血虚不能上荣',therapyDirection:'养血'},{nodeId:'P3',patientFact:'心悸',pathogenesis:'心血不足',therapyDirection:'养血'}];
 const out=surface.withContiguousChainNodeIds(r);assert.deepEqual(out.pathogenesis.chain.map(n=>n.nodeId),['P1','P2']);assert.equal(surface.withContiguousChainNodeIds(out),out);
 const rx={...structuredClone(r),stage:'prescribe'};assert.deepEqual(surface.withContiguousChainNodeIds(rx).pathogenesis.chain.map(n=>n.nodeId),['P2','P3']);
});
await check('C92','主证依据超过 8 条时截断不清空，补的无汗/脉浮紧原句排在前面（r49d rt-848256 风寒束表退回占位）',async()=>{
 const types=await jiti.import('../src/lib/diagnosis-types.ts');const contract=await jiti.import('../src/lib/diagnosis-stage-contract.ts');
 const r=base();r.overview.primarySyndrome='风寒束表证';r.overview.primarySyndromeBasis=['恶寒','发热','头痛','身痛','鼻塞','流清涕','喷嚏','咳嗽'];
 r.overview.tcmDiagnosticRationale='恶寒重、发热轻、无汗，脉浮紧，为风寒束表。';r.pathogenesis.chain=[{nodeId:'P1',patientFact:'恶寒重、发热轻，伴无汗；脉浮紧',pathogenesis:'风寒束表',therapyDirection:'辛温解表'}];
 const ctx='患者1天前受凉后出现恶寒、发热，恶寒重、发热轻，伴无汗、头痛；舌淡红，苔薄白，脉浮紧。';
 const projected=contract.projectM03KeySyndromeDiscriminators(r,ctx);
 assert.ok(projected.overview.primarySyndromeBasis.length>8,'投影后超过8条（用例须覆盖上限）');
 const parsed=types.ReasoningV2Schema.safeParse(projected);const normalized=parsed.success?parsed.data:{overview:types.ReasoningV2Schema.shape?.overview?.parse?.(projected.overview)};
 if(!parsed.success){const ov=types.ReasoningV2Schema.shape.overview.safeParse(projected.overview);assert.ok(ov.success,JSON.stringify(ov.error?.issues?.slice(0,2)));normalized.overview=ov.data;normalized.pathogenesis=projected.pathogenesis;}
 assert.equal(normalized.overview.primarySyndromeBasis.length,8);
 assert.ok(normalized.overview.primarySyndromeBasis.some(item=>/无汗/.test(item)),JSON.stringify(normalized.overview.primarySyndromeBasis));
 assert.equal(contract.m03KeySyndromeDiscriminatorIssue(normalized,ctx),undefined);
});
console.log(`${passed} passed, ${failed} failed`);if(failed)process.exit(1);
