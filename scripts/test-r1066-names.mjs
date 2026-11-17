// 第四十九轮 P5：病名定义、教材归一与辨病定义断言；全部合成夹具，无远端模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { alias: { '@': `${process.cwd()}/src`, 'server-only': `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const defining = await jiti.import('../src/lib/tcm-disease-defining-findings.ts');
const points = await jiti.import('../src/lib/m03-disease-points-check.server.ts');
const claims = await jiti.import('../src/lib/m03-patient-claim-check.server.ts');
const terms = await jiti.import('../src/lib/clinical-terminology.ts');
const surface = await jiti.import('../src/lib/delivered-surface.ts');
const textbook = await jiti.import('../src/lib/tcm-textbook-syndromes.ts');
const data = JSON.parse(fs.readFileSync('src/data/tcm-disease-defining-findings.source.json', 'utf8'));
let failed = 0, total = 0;
async function check(id, title, run) { if (process.env.NAMES_ONLY && process.env.NAMES_ONLY !== id) return; total++; try { await run(); console.log(`✓ ${id} ${title}`); } catch (error) { failed++; console.error(`✗ ${id} ${title}\n${error.stack}`); } }
const status = (d, r) => defining.diseaseDefiningFindingStatus(d, r).status;
const root = (disease, rationale, differentials = []) => ({ schemaVersion: 'tcm-cdss-reasoning-v2', stage: 'diagnose', overview: { tcmDiseaseName: disease, tcmDiseaseRationale: rationale, primarySyndrome: '痰湿中阻证', secondarySyndromes: [], tcmDiseaseDifferentials: differentials, tcmDifferentials: [] }, pathogenesis: { chain: [], uncertainties: [] }, therapy: {} });
const input = (disease, recordText, candidates) => ({ disease, recordText, candidates, chiefComplaint: recordText });
await check('N01', '定义表来源有逐字引文和行号，覆盖点名病种且每分支非空', () => {
  assert.ok(data.entries.length >= 16);
  const all = data.entries.flatMap(x => x.names); assert.equal(new Set(all).size, all.length);
  let local;
  for (const row of data.entries) {
    assert.ok(row.sourceRef.line > 0 && row.sourceRef.quote.length >= 10);
    assert.ok(row.anyOf.length && row.anyOf.every(b => b.length && b.every(g => g.length)));
    if (fs.existsSync(row.sourceRef.file)) { local ||= fs.readFileSync(row.sourceRef.file, 'utf8').split(/\r?\n/u); assert.equal(local.slice(row.sourceRef.line - 1, row.sourceRef.endLine).join('\n'), row.sourceRef.quote); }
  }
});
await check('N02', '急慢惊风：抽搐否认和未提均不成立，阳性成立', () => {
  for (const d of ['急惊风', '慢惊风']) { assert.equal(status(d, '现病史：高热嗜睡，无抽搐。'), 'missing'); assert.equal(status(d, '现病史：高热嗜睡。'), 'missing'); assert.equal(status(d, '现病史：肢体抽搐。'), 'supported'); }
});
await check('N03', '复用极性：他人、未问及不算，本人阳性与历史阴性并存不抹掉阳性', () => {
  for (const r of ['家族史：母亲曾有抽搐。', '现病史：是否抽搐尚未询问。']) assert.equal(status('急惊风', r), 'missing');
  assert.equal(status('急惊风', '既往无抽搐。现病史：今日出现四肢抽搐。'), 'supported');
});
await check('N04', '痫证须发作性和神志/抽搐表现，不借普通咳嗽发作立病', () => {
  assert.equal(status('痫证', '现病史：反复发作咳嗽。'), 'missing'); assert.equal(status('痫病', '现病史：发作时不应答，数秒后清醒。'), 'supported');
});
await check('N05', '头胀不是眩晕；头晕、目眩成立', () => {
  assert.equal(status('眩晕', '主诉：头胀，后枕发紧，未诉目眩旋转。'), 'missing');
  assert.equal(status('眩晕', '主诉：头晕3日。'), 'supported'); assert.equal(status('眩晕', '主诉：目眩1日。'), 'supported');
});
await check('N06', '胃痛腹痛按部位分，上腹痛不被腹痛子串命中', () => {
  assert.equal(defining.affirmedDefiningFinding('主诉：上腹痛。', '腹痛', ['上腹痛']), false);
  assert.equal(status('腹痛', '主诉：上腹痛。'), 'missing'); assert.equal(status('胃痛', '主诉：上腹痛。'), 'supported'); assert.equal(status('腹痛', '主诉：脐周疼痛。'), 'supported'); assert.equal(status('胃痛', '主诉：膝部疼痛。'), 'missing');
});
await check('N07', '恶心不能代替呕吐，干呕属教材允许表现', () => {
  assert.equal(status('呕吐', '现病史：恶心嗳气，无呕吐。'), 'missing'); assert.equal(status('呕吐', '现病史：干呕无物。'), 'supported');
});
await check('N08', '哮病需要哮鸣，普通气喘有喘证候选', () => {
  assert.equal(status('哮病', '既往史：支气管哮喘8年。现病史：喉中哮鸣有声2天。'), 'supported');
  assert.equal(status('哮病', '家族史：母亲有支气管哮喘。现病史：咳嗽，双肺闻及哮鸣音。'), 'missing');
  assert.equal(status('哮病', '现病史：反复发作气喘气短。'), 'missing'); assert.equal(status('哮病', '既往史：曾诊哮喘。'), 'missing'); assert.equal(status('哮病', '现病史：咳嗽，双肺闻及哮鸣音。'), 'missing'); assert.equal(status('哮病', '现病史：反复发作气喘，双肺闻及哮鸣音。'), 'supported'); assert.equal(status('喘证', '现病史：气喘气短。'), 'supported');
});
await check('N09', '急性神志改变不能借年龄诊痴呆，认知减退保留', () => {
  assert.equal(status('痴呆', '年龄：76岁；现病史：近一年记忆下降，今晨突发意识模糊，烦躁谵语。'), 'missing'); assert.equal(status('痴呆', '现病史：记忆力下降逐年加重，生活能力下降。'), 'supported');
});
await check('N10', '浮肿与尿路定义表现缺项不成立，淋证分型共享定义', () => {
  assert.equal(status('水肿', '现病史：尿少，无浮肿。'), 'missing'); assert.equal(status('水肿', '现病史：双足肿3天。'), 'supported'); assert.equal(status('淋证（血淋）', '现病史：小便频急涩痛。'), 'supported'); assert.equal(status('淋证', '现病史：腰痛。'), 'missing');
});
await check('N11', '确定性触发直接返回闭集内有肯定定义表现的候选，无需模型提名', async () => {
  const r = await points.checkDiseaseAgainstDiagnosisPoints(input('急惊风', '主诉：高热，无抽搐。', ['急惊风', '高热']));
  assert.equal(r.status, 'mismatch'); assert.equal(r.kind, 'defining_missing'); assert.equal(r.better, '高热');
});
await check('N12', '表外或无肯定支持的候选不被硬选成新病名', () => {
  const isolated = points.deterministicDiseasePointsVerdict(input('急惊风', '主诉：是否头晕尚未询问。现病史：高热。', ['眩晕'])); assert.equal(isolated.better, '');
  const r = points.deterministicDiseasePointsVerdict(input('眩晕', '主诉：头胀。', ['不寐', '胃痛'])); assert.equal(r.better, ''); assert.equal(r.status, 'mismatch');
  assert.equal(points.deterministicDiseasePointsVerdict(input('乳蛾', '主诉：咽痛。', ['胃痛'])).status, 'fits'); assert.equal(points.deterministicDiseasePointsVerdict(input('眩晕', '', [])).status, 'fits');
});
await check('N13', '便后鲜血刺痛且无肯定痔核提名肛裂，闭集/阴性/已见痔核守卫', () => {
  const rec = '现病史：排便后鲜红血，肛门刺痛，无痔核。';
  assert.equal(points.deterministicDiseasePointsVerdict(input('内痔', rec, ['内痔', '肛裂'])).kind, 'refinement');
  assert.equal(defining.textbookDiseaseRefinement('内痔', rec, ['内痔']), undefined);
  assert.equal(defining.textbookDiseaseRefinement('内痔', '现病史：排便后鲜红血，无肛门刺痛。', ['肛裂']), undefined);
  assert.equal(defining.textbookDiseaseRefinement('内痔', rec + '查体：见痔核。', ['肛裂']), undefined);
});
await check('N14', '重抽仍不成立保留病名、证名并补缺口；重复调用幂等', () => {
  const x = { tcmDiseaseName: '急惊风', tcmDiseaseRationale: '患儿高热嗜睡。', primarySyndrome: '暑热疫毒证' };
  defining.withDiseaseDefiningFindingCaveat(x, '高热嗜睡，无抽搐。'); assert.match(x.tcmDiseaseRationale, /抽搐尚未见，病名待核实/u); assert.equal(x.tcmDiseaseName, '急惊风'); assert.equal(x.primarySyndrome, '暑热疫毒证');
  const before = structuredClone(x); defining.withDiseaseDefiningFindingCaveat(x, '高热嗜睡，无抽搐。'); assert.deepEqual(x, before);
});
await check('N15', '交付面接入缺项提示，定义表现肯定时不加提示', () => {
  const out = surface.projectDeliveredReasoning(root('眩晕', '头胀，属眩晕。'), { recordText: '主诉：头胀。' }); assert.match(out.overview.tcmDiseaseRationale, /目眩或头晕尚未见，病名待核实/u);
  const ok = surface.projectDeliveredReasoning(root('眩晕', '本例头晕。'), { recordText: '主诉：头晕。' }); assert.doesNotMatch(ok.overview.tcmDiseaseRationale, /病名待核实/u);
});
await check('N16', '受治理旧名/西医标题归一，膝骨关节炎按膝部名交付', () => {
  for (const [old, name] of [['骨关节炎', '骨痹'], ['膝骨关节炎', '膝痹'], ['风热赤眼', '暴风客热'], ['葡萄疫', '紫癜']]) assert.equal(terms.canonicalTcmDiseaseName(old, { overview: {} }), name);
});
await check('N17', '逐节审计发现的西医标题有原文归属；多义无统一名不强改', () => {
  for (const [old, name] of [['虫咬皮炎', '恶虫叮咬'], ['挤压综合征', '压迮伤'], ['骨关节结核', '流痰'], ['胆石症', '胆胀']]) assert.equal(terms.textbookSectionDeliveryName(old), name);
  assert.equal(terms.textbookSectionDeliveryName('接触性皮炎'), '接触性皮炎');
});
await check('N18', '辨病依据三类定义子句无本例主语也送核；近似复述同样送核', () => {
  for (const [d, t] of [['腹痛', '痛位在胃脘以下耻骨毛际以上，故归腹痛。'], ['哮病', '呈反复发作性哮鸣气喘形态。'], ['呕吐', '胃气上逆自口而出，故归呕吐。']]) { const out = claims.textbookCopiedDiseaseClaims(root(d, t), '主诉：不适3天。'); assert.ok(out.some(x => x.textbookDefinition)); }
});
await check('N19', '逐字已记/待核实不送核，鉴别通则不当本例，证候字段不纳入', () => {
  assert.deepEqual(claims.textbookCopiedDiseaseClaims(root('呕吐', '胃内容物自口而出。'), '现病史：胃内容物自口而出。'), []);
  const x = root('哮病', '是否喉中哮鸣有声待核实。', [{ diseaseName: '哮病', distinguishingPoints: '反复发作性哮鸣气喘形态。' }]); x.overview.tcmDiagnosticRationale = '反复发作性哮鸣气喘形态。'; assert.deepEqual(claims.textbookCopiedDiseaseClaims(x, '主诉：气短。'), []);
});
await check('N20', '核对与复核提示均撤销辨病定义的通则豁免', () => {
  assert.match(claims.buildPatientClaimMessages('腹痛', []).map(x => x.content).join(''), /tcmDiseaseRationale.*即使未写/u);
  assert.match(claims.buildPatientClaimVerificationMessages('腹痛', []).map(x => x.content).join(''), /教材定义或诊断要点也按本例断言核对/u);
});
await check('N21', '复核判无据后按整句最小删除，保留其他有据完整句', () => {
  const x = root('腹痛', '本例上腹疼痛持续3天。痛位在胃脘以下耻骨毛际以上，故归腹痛。');
  claims.applyPatientClaimRemovals(x, 'tcm', [{ field: 'tcmDiseaseRationale', span: '胃脘以下耻骨毛际以上', textbookDefinition: true }], '主诉：上腹疼痛持续3天。'); assert.equal(x.overview.tcmDiseaseRationale, '本例上腹疼痛持续3天。');
});
await check('N22', '删后不足一句保留原句并加待核实，重复处理幂等', () => {
  const text = '胃气上逆自口而出，故归呕吐。'; const next = claims.withoutTextbookClaimSentence(text, '自口而出'); assert.equal(next, '胃气上逆自口而出，故归呕吐（待核实）。'); assert.equal(claims.withoutTextbookClaimSentence(next, '自口而出'), next);
});
await check('N23', '既有三值事实复核：supported 保留、partial/absent 删除，漏答保留', () => {
  const supported = claims.parsePatientClaimVerification(JSON.stringify({ items: [{ id: 0, verdict: 'supported' }, { id: 1, verdict: 'partial' }, { id: 2, verdict: 'absent' }] }), 4); assert.deepEqual([...supported], [0, 3]);
});
await check('N24', '路由确定性缺项优先，既往病重抽延后避免两次重抽', () => {
  const route = fs.readFileSync('src/app/api/diagnosis/diagnose/route.ts', 'utf8');
  assert.ok(route.includes('points.kind === "defining_missing" || points.kind === "refinement"'));
  assert.ok(route.includes('const historyRedraw = historyStatedUnique && redraw && writtenDiseaseIsTextbookNeighbour'));
  assert.ok(!/const historyRedraw[^;]+\? redraw\(/u.test(route));
});
await check('N25', '部位与疼痛必须同一词组，胃胀加膝痛、小腹胀加腰痛不拼接', () => {
  assert.equal(status('胃痛', '现病史：胃脘胀满，膝部疼痛。'), 'missing');
  assert.equal(status('腹痛', '现病史：小腹胀，腰部疼痛。'), 'missing');
  assert.equal(status('胃痛', '现病史：胃脘隐痛。'), 'supported');
});
await check('N26', '鉴别先讲他病特征、后讲本例时，只核本例部分', () => {
  const x = root('呕吐', '本例仅嗳气。', [{ diseaseName: '反胃', distinguishingPoints: '反胃可见胃内容物自口而出，本例仅嗳气。' }]);
  assert.deepEqual(claims.textbookCopiedDiseaseClaims(x, '主诉：嗳气。'), []);
});
await check('N27', '主诉明确上腹痛，正文笼统腹痛不能把部位改到胃脘以下', () => {
  assert.equal(status('腹痛', '主诉：上腹痛3天\n现病史：患者口述腹痛2天。'), 'missing');
  assert.equal(status('腹痛', '患者年龄：41岁\n患者性别：男\n上腹痛3天\n患者口述腹痛2天。'), 'missing');
  assert.equal(status('腹痛', '主诉：上腹痛伴脐周疼痛3天\n现病史：腹痛。'), 'supported');
});
await check('N28', '不以另一伴随症状给缺定义表现的病强指定替代病', () => {
  const r = points.deterministicDiseasePointsVerdict({ ...input('急惊风', '高热，呕吐，无抽搐。', ['呕吐']), chiefComplaint: '发热1天' }); assert.equal(r.better, '');
});
await check('N29', '病名和危重结论的重合不冒充患者表现送核', () => {
  assert.deepEqual(claims.textbookCopiedDiseaseClaims(root('真心痛', '属真心痛危重急症。'), '主诉：胸痛。'), []);
});
await check('N30', '膝痹和膝骨关节炎能找回骨关节炎原节，映射不丢教材行', () => {
  const original = textbook.textbookFormulaRowsForDisease('骨关节炎'); assert.ok(original.length);
  assert.deepEqual(textbook.textbookFormulaRowsForDisease('膝痹').map(x => x.id), original.map(x => x.id));
  assert.deepEqual(textbook.textbookFormulaRowsForDisease('膝骨关节炎').map(x => x.id), original.map(x => x.id));
});
await check('N31', '辨病依据定义重合子句送核缺省关闭（整句删除会删掉正面辨病结论，r49a 诊断依据复测集 85%→70%）', () => {
  const saved = process.env.CDSS_TEXTBOOK_DEFINITION_CLAIMS;
  delete process.env.CDSS_TEXTBOOK_DEFINITION_CLAIMS; assert.equal(claims.textbookDefinitionClaimsEnabled(), false);
  process.env.CDSS_TEXTBOOK_DEFINITION_CLAIMS = 'true'; assert.equal(claims.textbookDefinitionClaimsEnabled(), true);
  if (saved === undefined) delete process.env.CDSS_TEXTBOOK_DEFINITION_CLAIMS; else process.env.CDSS_TEXTBOOK_DEFINITION_CLAIMS = saved;
});
console.log(JSON.stringify({ total, failed })); process.exitCode = failed ? 1 : 0;
