// 第六十轮（2026-11-26）：发给甲方评审的五份真实病历样张（r1077 的 R046、R062、R007、R008、R010，生产 b9bd6b3）逐字复读后按类修。
// 材料与回放在 ~/runlogs/r1018/work/r1079。本套件一条断言对应一类：
//  1. 「原方」口径：疏风清热汤《中医喉科学讲义》补进原方组成表，药味逐味相同的处方不再叫「加减」（R008）。
//  2. 中成药注意事项：说明书来源站把「本品」换成了「商品名＋通用名」，写回「本品」；两栏各自的条目编号去掉；重复句只留一句（R008、R062、R007）。
//  3. 药味功效栏：同一味药的几条《中药学》功效原文，按方义里对这味药的说明来选（桑叶、防风、牛膝、川芎、天花粉）。
//  4. 病机链证候依据：与病历表现同文时换上的主证依据必须讲的是这个节点的表现（R046）。
//  5. 随访疗效评价标准：不把病历没记的二便、饮食、睡眠写成会好转的症状（R010）。
//  6. 拔罐卡：「5分钟后去罐」已是留罐时长，不再并列总论的留罐时间（R062）。
//  7. 线上重跑后新读出的几类：可凭临床诊断的病，依据句里「X待查」的回声不让病名一直待查（R046）；年龄未知不写给老年人的注意事项；
//     食疗卡疗程栏只写频次；主症补强行不主动添有毒药（R062 山豆根）；方义里抄进来的提示词半句（R007「原方沙参品种未定」）。
// 每条断言都有反证（~/runlogs/r1018/work/r1079/cp/）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

// 5.4 要经真正的 M05 作文入口走一遍（假模型回复），与 test:r1020-care 4.4 同一套桩。
Object.assign(process.env, {
  AI_TEXT_PROVIDER: "openai-compatible",
  OPENAI_API_KEY: "test-only-placeholder",
  OPENAI_BASE_URL: "https://api.deepseek.com",
  OPENAI_MODEL: "deepseek-flash",
  CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash",
});
delete process.env.M05_FOLLOWUP_AUTHORING;
for (const key of ["BAILIAN_QWEN_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"]) delete process.env[key];

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

const only = process.env.R1079_CHECK;
const check = async (id, name, run) => {
  if (only && only !== id) return;
  try {
    await run();
    console.log(`✓ ${id} ${name}`);
  } catch (error) {
    console.error(`✗ ${id} ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};
const data = (file) => JSON.parse(readFileSync(`${process.cwd()}/src/data/${file}`, "utf8"));

const surface = await jiti.import("../src/lib/delivered-surface.ts");
const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const pool = await jiti.import("../src/lib/instruction-record-pool.ts");
const functions = await jiti.import("../src/lib/herb-function-display-source.ts");
const analysisReview = await jiti.import("../src/lib/formula-analysis-review.ts");
const followup = await jiti.import("../src/lib/m05-followup-authoring.server.ts");
const cards = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const claims = await jiti.import("../src/lib/recorded-test-claims.ts");
const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");

const herb = (name, dose, role, extra = {}) => ({ name, dose, role, function: "", processing: null, decoctionRequirement: null, ...extra });
const prescribe = (candidate, extra = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
  overview: { tcmDiseaseName: "喉痹", primarySyndrome: "风热外袭证", secondarySyndromes: [] },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "咽痛", pathogenesis: "外邪搏结咽喉，气血壅滞", therapyDirection: "疏风散邪" }] },
  therapy: { overallPrinciple: "热者寒之", overallMethod: "疏风散邪，宣肺利咽，清热止痛" },
  formula: { candidates: [candidate], patentAndWestern: [], modifications: [], ...extra },
  nonPharma: { precautions: [], tcmTreatments: [] },
});
const SHUFENG = ["荆芥", "牛蒡子", "金银花", "连翘", "防风", "桔梗", "桑白皮", "黄芩", "玄参", "赤芍", "浙贝母", "天花粉", "甘草"];
const SHUFENG_ANALYSIS = "本方以疏风清热汤为基础加减。荆芥、牛蒡子为君，辛散风邪、利咽消肿；金银花、连翘、防风为臣，助君疏风清热、透邪外出，桔梗、桑白皮宣降肺气以止咳；黄芩、玄参、赤芍、浙贝母、天花粉为佐，清热利咽、凉血散结、生津化痰；甘草为使，调和诸药并利咽。全方共奏疏风散邪、宣肺利咽、清热止痛之效。";
const shufengCandidate = (herbs, name = "疏风清热汤加减") => ({
  name, formulaNames: ["疏风清热汤"], formulaSource: { evidenceLevel: "kb_entry", source: "疏风清热汤：《中医喉科学讲义》", confidence: "中" },
  herbs: herbs.map((item, index) => herb(item, "10g", index < 2 ? "君" : index < 7 ? "臣" : index < 12 ? "佐" : "使")),
  formulaAnalysis: SHUFENG_ANALYSIS, decoction: { method: "每日1剂，水煎两次，共取药液约500mL，分2次服", doses: 5, days: 5 },
});
const RECORD = "主诉：咽痛\n现病史：咳嗽";

// ───── 1 原方口径 ─────
await check("1.1", "原方组成表有疏风清热汤《中医喉科学讲义》十三味，摘句里逐味可见；不是调剂标准的写法", () => {
  const row = data("tcm-formula-original-compositions.source.json").rows.find((item) => item.name === "疏风清热汤");
  assert.ok(row, "原方组成表缺疏风清热汤");
  assert.equal(row.book, "中医喉科学讲义");
  assert.equal(row.ingredients.length, 13);
  assert.deepEqual([...row.ingredients.map((item) => item.herb)].sort(), [...SHUFENG].sort());
  const quotes = row.evidence.map((item) => item.quote).join("");
  for (const item of row.ingredients) assert.ok(quotes.includes(item.written), `${item.written} 不在摘句里`);
  assert.ok(!row.ingredients.some((item) => /炒|片$/u.test(item.written)), "不得照抄调剂标准的炒牛蒡子、黄芩片");
});

await check("1.2", "十三味与原方逐味相同：方名去掉「加减」，方义开头写「本方用疏风清热汤原方」；少一味（无赤芍）仍是加减", () => {
  const same = surface.projectDeliveredReasoning(prescribe(shufengCandidate(SHUFENG)), { recordText: RECORD }).formula.candidates[0];
  assert.equal(same.name, "疏风清热汤");
  assert.match(same.formulaAnalysis, /^本方用疏风清热汤原方。/u);
  const fewer = surface.projectDeliveredReasoning(prescribe(shufengCandidate(SHUFENG.filter((item) => item !== "赤芍"))), { recordText: RECORD }).formula.candidates[0];
  assert.equal(fewer.name, "疏风清热汤加减");
  assert.doesNotMatch(fewer.formulaAnalysis, /原方。/u);
  const more = surface.projectDeliveredReasoning(prescribe(shufengCandidate([...SHUFENG, "射干"])), { recordText: RECORD }).formula.candidates[0];
  assert.equal(more.name, "疏风清热汤加减");
});

// ───── 2 中成药注意事项 ─────
const SHL = "1.对本品及所含成份过敏者禁用。2.风寒感冒者禁用可可康双黄连口服液。1.忌烟、酒及辛辣、生冷、油腻食物。3.风寒感冒者不适用可可康双黄连口服液。6.发热体温超过38.5℃的患者，应去医院就诊。12.如正在使用其他药品，使用可可康双黄连口服液前请咨询医师或药师。如与其他药物同时使用可能会发生药物相互作用，详情请咨询医师或药师。";
await check("2.1", "「商品名＋通用名」写回「本品」；条目编号去掉；38.5 这样的小数不动", () => {
  const out = pool.tidiedMedicineLabelNote(SHL, "双黄连口服液");
  assert.doesNotMatch(out, /可可康|双黄连口服液/u);
  assert.match(out, /风寒感冒者禁用本品。/u);
  assert.match(out, /风寒感冒者不适用本品。/u);
  assert.match(out, /使用本品前请咨询医师或药师。/u);
  assert.doesNotMatch(out, /(?:^|。)\s*\d{1,2}[.．、]/u);
  assert.match(out, /38\.5℃/u);
  assert.ok(out.startsWith("对本品及所含成份过敏者禁用。"));
});

await check("2.2", "引导词后面直接是通用名：只把通用名写回「本品」；商品名里带「和」字（仁和）照样认得", () => {
  assert.equal(pool.tidiedMedicineLabelNote("6．儿童、年老体弱者、孕妇应在医师指导下服用凉解感冒合剂。", "凉解感冒合剂"), "儿童、年老体弱者、孕妇应在医师指导下服用本品。");
  assert.equal(pool.tidiedMedicineLabelNote("如正在使用其他药品，使用仁和丁香风油精前请咨询医师。", "丁香风油精"), "如正在使用其他药品，使用本品前请咨询医师。");
  // 同一段里已认出的商品名，句首再出现时一并去掉。
  assert.equal(pool.tidiedMedicineLabelNote("风寒感冒者禁用可可康双黄连口服液。可可康双黄连口服液性状发生改变时禁止使用。", "双黄连口服液"), "风寒感冒者禁用本品。本品性状发生改变时禁止使用。");
});

await check("2.3", "不是商品名的不动：通用名是别的药名的一部分（复方丹参片）、「前缀＋通用名」本身是目录里的另一个药", () => {
  assert.equal(pool.tidiedMedicineLabelNote("不宜与复方丹参片同用。", "丹参片"), "不宜与复方丹参片同用。");
  assert.equal(pool.tidiedMedicineLabelNote("服用丹栀逍遥丸期间忌生冷。", "逍遥丸", (name) => name === "丹栀逍遥丸"), "服用丹栀逍遥丸期间忌生冷。");
  // 没有外部目录可查时，引导词后面的两字前缀按商品名处理——所以交付面必须把目录查询传进来（见 2.5）。
  assert.equal(pool.tidiedMedicineLabelNote("服用丹栀逍遥丸期间忌生冷。", "逍遥丸"), "服用本品期间忌生冷。");
});

await check("2.4", "前后都是汉字、中间没有句读的编号补成句号；逐句去重只留第一句；没有可改之处时逐字不变", () => {
  const out = pool.tidiedMedicineLabelNote("10. 请将本品放在儿童不能接触的地方11.如与其他药物同时使用可能会发生药物相互作用，详情请咨询医师或药师。如与其他药物同时使用可能会发生药物相互作用，详情请咨询医师或药师。", "养阴清肺丸");
  assert.equal(out, "请将本品放在儿童不能接触的地方。如与其他药物同时使用可能会发生药物相互作用，详情请咨询医师或药师。");
  const plain = "忌烟酒及辛辣食物。服药3天症状无缓解，应去医院就诊。";
  assert.equal(pool.tidiedMedicineLabelNote(plain, "某某颗粒"), plain);
});

await check("2.5", "交付面：中成药行的注意事项不带商品名、不带条目编号；疗程提示照旧取自说明书", () => {
  const medicine = { type: "中成药", name: "双黄连口服液", specification: "20ml*6支", positioning: "替代方案", correspondingProblem: "外感风热之咽痛、咳嗽", route: "口服",
    usageBoundary: "", relationship: "", riskNote: `${SHL}7.服药3天症状无缓解，应去医院就诊。`, evidence: { evidenceLevel: "drug_label", source: "[LOCAL-INST-006]", confidence: "中" } };
  const out = surface.projectDeliveredReasoning(prescribe(shufengCandidate(SHUFENG), { patentAndWestern: [medicine] }), { recordText: RECORD }).formula.patentAndWestern[0];
  assert.ok(out, "中成药行不应被删");
  assert.doesNotMatch(out.riskNote, /可可康/u);
  assert.doesNotMatch(out.riskNote, /(?:^|。)\s*\d{1,2}[.．、]/u);
  assert.equal(out.usageBoundary, "服药3天症状无缓解，应去医院就诊。");
});

// ───── 3 药味功效栏按方义选句 ─────
await check("3.1", "方义里以这味药为主语的说明：并列主语每味都算，角色不算说明，分说的各归各", () => {
  const analysis = "牛膝、薏苡仁为臣，牛膝通利筋脉、引药下行至腰膝，薏苡仁利水渗湿、舒筋缓急，助君药分利湿热。萆薢、车前草为佐，利湿去浊、清热利尿。全方清利并行，共奏清热利湿、舒筋止痛之功。";
  assert.equal(analysisReview.formulaAnalysisUseOfHerb(analysis, "牛膝"), "通利筋脉、引药下行至腰膝");
  assert.match(analysisReview.formulaAnalysisUseOfHerb(analysis, "薏苡仁"), /利水渗湿、舒筋缓急/u);
  assert.equal(analysisReview.formulaAnalysisUseOfHerb(analysis, "萆薢"), "利湿去浊、清热利尿");
  assert.equal(analysisReview.formulaAnalysisUseOfHerb(analysis, "黄柏"), "");
  assert.doesNotMatch(analysisReview.formulaAnalysisUseOfHerb(SHUFENG_ANALYSIS, "甘草"), /共奏|疏风散邪/u);
  // 同一句里跟在后面的总括说法不算这味药的说明。
  assert.equal(analysisReview.formulaAnalysisUseOfHerb("黄柏为君，清热燥湿；甘草为使，调和诸药，诸药合用，共奏清热利湿之功。", "甘草"), "调和诸药");
});

await check("3.2", "同一味药的几条功效原文按方义选：桑叶「清肺润燥」、防风「祛风解表」、川芎「祛风止痛」、天花粉「生津止渴」、牛膝含「引血下行」", () => {
  const pick = (name, analysisUse, target, therapy) => functions.selectGroundedHerbFunction({ name, role: "佐", target, therapy, analysisUse }).text;
  assert.equal(pick("桑叶", "清肺润燥以助止咳", "肺阴不足，肺失濡润，气逆作咳", "养阴清热，润肺止咳；肺阴亏虚证"), "清肺润燥");
  assert.equal(pick("防风", "助君疏风清热、透邪外出", "外邪搏结咽喉，气血壅滞", "疏风散邪，宣肺利咽，清热止痛；风热外袭证"), "祛风解表");
  assert.equal(pick("川芎", "祛风止痛", "风寒外袭，卫阳被遏，清阳不展", "辛温解表，宣肺散寒；风寒束表证"), "祛风止痛");
  assert.equal(pick("天花粉", "清肺中虚热而生津，兼应阴虚内热", "阴虚内热，迫津外泄", "养阴清热，润肺止咳；肺阴亏虚证"), "生津止渴");
  const niuxi = pick("牛膝", "通利筋脉、引药下行至腰膝", "湿热蕴结腰府，经脉阻滞不通", "清热利湿，舒筋止痛；湿热腰痛");
  assert.match(niuxi, /引血下行/u);
  assert.doesNotMatch(niuxi, /逐瘀通经/u);
  // 说明里各有一段站得住的两条（薏苡仁「利水渗湿」「健脾止泻」）按治法分先后：清热利湿取「利水渗湿」，不写与本例无关的「止泻」。
  assert.equal(pick("薏苡仁", "利湿健脾、舒筋缓急", "湿热蕴结腰府，经脉阻滞不通", "清热利湿，舒筋止痛；湿热腰痛"), "利水渗湿");
  // 没有概念组可借、只有一段原字对得上的（枳壳「行滞以除痞」）同样按方义选。
  assert.equal(pick("枳壳", "行滞以除痞", "", ""), "行滞消胀");
  // 说明里一个字都对不上的（荆芥「辛凉透表、解毒利咽」）不按方义选，照旧按治法：不会选成「透疹」。
  assert.equal(pick("荆芥", "辛凉透表、解毒利咽", "风邪袭肺卫，鼻窍不利", "辛凉解表，利咽通窍；风热犯表证"), "解表散风");
});

await check("3.3", "方义没讲到这味药时照旧按病机靶点与治法选；选出来的仍是《中药学》原文整小句", () => {
  const without = functions.selectGroundedHerbFunction({ name: "桑叶", role: "佐", target: "肺阴不足，肺失濡润，气逆作咳", therapy: "养阴清热，润肺止咳；肺阴亏虚证" }).text;
  const empty = functions.selectGroundedHerbFunction({ name: "桑叶", role: "佐", target: "肺阴不足，肺失濡润，气逆作咳", therapy: "养阴清热，润肺止咳；肺阴亏虚证", analysisUse: "" }).text;
  assert.equal(without, empty);
  // 方义的说明与哪条原文都对不上、病机治法也没有线索时，只取原文第一条，不凑两条。
  assert.equal(functions.selectGroundedHerbFunction({ name: "桑叶", role: "佐", target: "", therapy: "", analysisUse: "与本例无关的话" }).text, "疏散风热");
  const sources = functions.herbFunctionSourceClauses("桑叶").map((item) => item.text);
  for (const name of ["桑叶", "防风", "牛膝", "川芎"]) {
    const available = functions.herbFunctionSourceClauses(name).map((item) => item.text);
    const chosen = functions.selectGroundedHerbFunction({ name, role: "臣", target: "", therapy: "", analysisUse: "祛风止痛、清肺润燥、引药下行" }).text;
    for (const clause of functions.functionClauses(chosen)) assert.ok(available.includes(clause), `${name}「${clause}」不是原文小句`);
  }
  assert.ok(sources.includes("清肺润燥"));
});

await check("3.5", "选出的两条原文小句意思重叠时只留一条（白术「健脾益气」「补气健脾」）；不重叠的两条都留", () => {
  const baizhu = functions.selectGroundedHerbFunction({ name: "白术", role: "臣", target: "", therapy: "", analysisUse: "健脾以助运化" }).text;
  assert.equal(baizhu, "健脾益气");
  // 并列的两条里，方义原字写到的那条排前面，重叠时留下的就是它（党参「补脾益气」：留「补脾益肺」，不留同组近义的「健脾益肺」）。
  assert.equal(functions.selectGroundedHerbFunction({ name: "党参", role: "君", target: "", therapy: "", analysisUse: "补脾益气以改善食少倦怠" }).text, "补脾益肺");
  const jinyinhua = functions.selectGroundedHerbFunction({ name: "金银花", role: "君", target: "", therapy: "", analysisUse: "疏散风热、清热解毒" }).text;
  assert.equal(jinyinhua, "清热解毒，疏散风热");
});

await check("3.4", "交付面：功效栏随方义（疏风清热汤里防风不写「胜湿止痛」）；再投影一遍不变", () => {
  const once = surface.projectDeliveredReasoning(prescribe(shufengCandidate(SHUFENG)), { recordText: RECORD });
  const herbs = Object.fromEntries(once.formula.candidates[0].herbs.map((item) => [item.name, item.function]));
  assert.equal(herbs["防风"], "祛风解表");
  assert.doesNotMatch(herbs["防风"], /胜湿止痛/u);
  const twice = surface.projectDeliveredReasoning(JSON.parse(JSON.stringify(once)), { recordText: RECORD });
  assert.deepEqual(twice.formula.candidates[0].herbs.map((item) => [item.name, item.function]), once.formula.candidates[0].herbs.map((item) => [item.name, item.function]));
});

// ───── 4 病机链证候依据 ─────
const S = "<!-- DIAGNOSIS_JSON_START -->";
const E = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = (reasoning) => `${S}\n${JSON.stringify(reasoning)}\n${E}`;
const unwrap = (content) => JSON.parse(content.slice(content.indexOf(S) + S.length, content.indexOf(E)));
const COLD_RECORD = "主诉：头痛、鼻塞、恶寒，咽痒、咳嗽一日余\n现病史：头痛、鼻塞、咽痒、咳嗽";
const coldDiagnose = () => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "感冒", primarySyndrome: "风寒束表证", primarySyndromeResolution: "resolved", primarySyndromeBasis: ["头痛、鼻塞、恶寒", "咽痒、咳嗽一日余"],
    tcmDiagnosticRationale: "恶寒为风寒束表、卫阳被遏；鼻塞为风寒犯鼻；咽痒、咳嗽为风寒袭肺、肺失宣肃，故辨证为风寒束表证。" },
  westernDiagnosis: {},
  pathogenesis: { symptomClusters: [], uncertainties: [], chain: [
    { nodeId: "P1", patientFact: "鼻塞", syndromeEvidence: "鼻塞", pathogenesis: "风寒束表，肺气失宣，鼻窍不利", therapyDirection: "宣肺通窍" },
    { nodeId: "P2", patientFact: "咽痒、咳嗽一日余", syndromeEvidence: "咽痒、咳嗽一日余", pathogenesis: "风寒束表，肺失宣肃，气逆作咳", therapyDirection: "宣肺止咳" },
  ] },
  therapy: { overallPrinciple: "寒者热之", overallMethod: "辛温解表，宣肺散寒" },
});
await check("4.1", "证候依据与病历表现同文：只换成讲同一表现的主证依据；没有这样的依据时不借别的表现", () => {
  const chain = unwrap(summary.applyM03AdvisoryQualityBoundaries(wrap(coldDiagnose()), COLD_RECORD)).pathogenesis.chain;
  const nose = chain.find((node) => node.patientFact === "鼻塞");
  const cough = chain.find((node) => /咽痒/u.test(node.patientFact));
  assert.ok(nose && cough, "两个节点都应保留");
  assert.equal(nose.syndromeEvidence, "头痛、鼻塞、恶寒");
  assert.doesNotMatch(cough.syndromeEvidence, /头痛|鼻塞|恶寒/u, "咽痒咳嗽节点的证候依据不得换成头痛、鼻塞、恶寒");
  assert.match(cough.syndromeEvidence, /咽痒|咳嗽/u);
});

// ───── 5 随访疗效评价标准 ─────
const EFFICACY = "腰痛逐渐减轻、发作次数减少，小便颜色变清、排尿顺畅，大便不黏滞，胃口和睡眠变好，精神体力恢复，说明治疗有效。";
await check("5.1", "病历只有腰痛与舌脉：疗效标准里二便、胃口、睡眠的小句不交付，其余照原文", () => {
  assert.equal(followup.efficacyCriteriaForRecord(EFFICACY, "主诉：腰痛1年余，加重3天\n舌象：舌质红；苔腻\n脉象：脉弦滑"), "腰痛逐渐减轻、发作次数减少，精神体力恢复，说明治疗有效。");
});

await check("5.2", "病历记了哪一方面就保留哪一方面；一句同时点到两方面、记了其一的保留；删完没有具体好转标志时原样返回；没有点到这些方面的逐字不变", () => {
  const urine = followup.efficacyCriteriaForRecord(EFFICACY, "主诉：腰痛1年余\n现病史：小便黄，睡眠差");
  assert.match(urine, /小便颜色变清、排尿顺畅/u);
  assert.doesNotMatch(urine, /大便不黏滞/u);
  assert.match(urine, /胃口和睡眠变好/u);
  const onlyGeneral = "小便颜色变清，大便通畅，说明治疗有效。";
  assert.equal(followup.efficacyCriteriaForRecord(onlyGeneral, "主诉：腰痛1年余"), onlyGeneral);
  const plain = "鼻塞流涕逐渐减轻、咽痛缓解、口干好转，精神体力恢复，说明治疗有效。";
  assert.equal(followup.efficacyCriteriaForRecord(plain, "主诉：流涕咽痛1天\n现病史：鼻塞流涕，咽痛口干。"), plain);
  assert.equal(followup.efficacyCriteriaForRecord(EFFICACY, ""), EFFICACY);
});

await check("5.3", "词表在数据文件里，四个方面各有小句用词与病历用词", () => {
  const domains = data("m05-followup-general-domains.source.json").domains;
  assert.deepEqual(domains.map((item) => item.name), ["小便", "大便", "食欲", "睡眠"]);
  for (const domain of domains) assert.ok(domain.clauseTerms.length > 0 && domain.recordTerms.length > 0);
});

await check("5.4", "经 authorFollowupClinicalContent 入口：出口按本例病历收口，缓存里仍是原文（同一份作文，记了小便的病历拿到带小便的那一句）", async () => {
  const reply = {
    reviewFocus: "复诊时医生会重点了解腰痛的程度和发作次数有没有减少，并查看舌象和脉象；请您服药期间留意并记下这些变化。",
    efficacyCriteria: EFFICACY,
    lifestyle: "饮食清淡，少吃油腻、甜食和辛辣；避免久坐久站和弯腰搬重物，腰部注意保暖；作息规律，不熬夜。",
    dimensions: ["睡眠", "食欲", "小便"],
    monitoringIndicators: ["腰痛程度", "腰痛发作次数", "活动是否受限"],
    urgentSigns: ["腰痛剧烈无法活动", "下肢麻木无力", "发热不退"],
    timeline: [],
  };
  let calls = 0;
  const original = globalThis.fetch;
  const originalInfo = console.info;
  console.info = () => {};
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "deepseek-flash",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(reply) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { "content-type": "application/json" } });
  };
  try {
    followup.resetAuthoredFollowupCache();
    const input = { syndrome: "湿热腰痛", herbs: ["黄柏", "苍术"] };
    const sparse = await followup.authorFollowupClinicalContent(types.normalizeCaseStateInput({ id: "r60-a", chiefComplaint: "腰痛1年余，加重3天", tongue: "舌质红；苔腻", pulse: "脉弦滑" }), input);
    assert.ok(sparse, "桩回复应被采纳");
    assert.equal(sparse.efficacyCriteria, "腰痛逐渐减轻、发作次数减少，精神体力恢复，说明治疗有效。");
    assert.equal(sparse.reviewFocus, reply.reviewFocus, "复诊时评估重点不在收口范围内");
    assert.ok(calls >= 1);
  } finally {
    globalThis.fetch = original;
    console.info = originalInfo;
    followup.resetAuthoredFollowupCache();
  }
});

// ───── 6 拔罐卡留罐时长 ─────
await check("6.1", "「5分钟后去罐」「10分钟后起罐」是留罐时长；只有频次的不是", () => {
  assert.equal(cards.cardStatesDuration("cupping", "5分钟后去罐。每日或隔日1次"), true);
  assert.equal(cards.cardStatesDuration("cupping", "10分钟后起罐"), true);
  assert.equal(cards.cardStatesDuration("cupping", "留罐10分钟"), true);
  assert.equal(cards.cardStatesDuration("cupping", "每日或隔日1次"), false);
  assert.equal(cards.cardStatesDuration("acupuncture", "5分钟后去罐"), false);
});

// ───── 7 线上重跑后新读出的几类 ─────
const COLD = "主诉：头痛、鼻塞、恶寒，咽痒、咳嗽一日余\n现病史：头痛、鼻塞、咽痒、咳嗽";
await check("7.1", "可凭临床诊断的病：依据句里的「X待查」只是病名回声，不算依据自己说未确立；依据另有明说未确立时照旧待查；需要检查才能确诊的病不受影响", () => {
  const echo = claims.settleWesternDiagnosisBasis("急性上呼吸道感染待查", "表现为头痛、鼻塞、恶寒、咽痒、咳嗽，符合急性上呼吸道感染的卡他症状，据此临床考虑急性上呼吸道感染待查；尚缺血象等检查佐证，需排除流行性感冒、过敏性鼻炎。", COLD);
  assert.equal(echo.name, "急性上呼吸道感染");
  assert.doesNotMatch(echo.basis, /待查/u);
  assert.match(echo.basis, /据此临床考虑急性上呼吸道感染；/u);
  const explicit = claims.settleWesternDiagnosisBasis("急性上呼吸道感染待查", "表现为头痛、鼻塞，考虑急性上呼吸道感染待查，但须先排除流行性感冒，诊断尚不能确立。", COLD);
  assert.equal(explicit.name, "急性上呼吸道感染待查");
  const needsTest = claims.settleWesternDiagnosisBasis("缺铁性贫血待查", "面色苍白、乏力，考虑缺铁性贫血待查；尚缺血清铁蛋白检查。", "主诉：乏力1月\n现病史：面色苍白");
  assert.equal(needsTest.name, "缺铁性贫血待查");
  assert.match(needsTest.basis, /考虑缺铁性贫血待查/u, "需要检查才能确诊的病，依据句里的写法不动");
});

await check("7.2", "年龄未知、病历也没写老年：写给老年人的注意事项不交付；病历写了老年或年龄够的照留；年轻人的照旧去掉", () => {
  const lines = ["汤药宜温服，饭后半小时服用。", "高龄或体弱者服药宜少量多次，起身宜缓，防跌倒。"];
  const unknown = compiler.casePrecautionsForTest(lines, types.normalizeCaseStateInput({ id: "r60-p1", chiefComplaint: "头痛、鼻塞、恶寒一日" }));
  assert.deepEqual(unknown, [lines[0]]);
  const elderlyRecord = compiler.casePrecautionsForTest(lines, types.normalizeCaseStateInput({ id: "r60-p2", chiefComplaint: "老年患者头痛、鼻塞一日" }));
  assert.equal(elderlyRecord.length, 2);
  const old = compiler.casePrecautionsForTest(lines, types.normalizeCaseStateInput({ id: "r60-p3", chiefComplaint: "头痛、鼻塞一日", patient: { sex: "男", age: 78 } }));
  assert.equal(old.length, 2);
  const young = compiler.casePrecautionsForTest(lines, types.normalizeCaseStateInput({ id: "r60-p4", chiefComplaint: "头痛、鼻塞一日", patient: { sex: "男", age: 24 } }));
  assert.deepEqual(young, [lines[0]]);
});

await check("7.3", "食疗卡疗程栏从说频次的小句起，做法留在内容栏；没有频次小句的原样", () => {
  assert.equal(cards.usageFromFrequencyClause("生姜、苏叶洗净切成细丝，放入锅内，以沸水冲泡，加盖温浸10分钟即成，每日2次，乘热顿服。"), "每日2次，乘热顿服。");
  assert.equal(cards.usageFromFrequencyClause("每日2次，温服。"), "每日2次，温服。");
  assert.equal(cards.usageFromFrequencyClause("泡水代茶饮。"), "泡水代茶饮。");
  assert.equal(cards.usageFromFrequencyClause(""), "");
});

await check("7.4", "说明书条目编号后面只有空格的写法（「10 本品性状发生改变时禁止使用」）也去掉；句中的数字不动", () => {
  assert.equal(pool.tidiedMedicineLabelNote("对本品过敏者禁用，过敏体质者慎用。10 本品性状发生改变时禁止使用。服药3 天症状无缓解应就诊。", "伤风停片"),
    "对本品过敏者禁用，过敏体质者慎用。本品性状发生改变时禁止使用。服药3 天症状无缓解应就诊。");
});

const COUGH_PRIOR = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "感冒", primarySyndrome: "风热犯表证", secondarySyndromes: [], tcmDiagnosticRationale: "鼻塞流涕、咽痛、口干为风热犯表之象。" },
  therapy: { overallMethod: "辛凉解表，利咽通窍" }, pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "风邪袭肺卫，鼻窍不利，咽部受邪" }] } };
await check("7.5", "主症补强行不主动添有毒药：主诉咽痛加山豆根不进，加有小毒或无毒的药照进；伴随表现的行不受这一条限制", () => {
  const caseState = types.normalizeCaseStateInput({ id: "r60-m1", chiefComplaint: "流涕咽痛1天", symptoms: { 现病史: "鼻塞流涕，咽痛口干。" } });
  const base = { prior: COUGH_PRIOR, caseState, candidateHerbNames: ["金银花", "连翘", "薄荷", "牛蒡子", "荆芥", "淡豆豉", "桔梗", "淡竹叶", "芦根", "甘草"],
    baseHerbNames: ["金银花", "连翘", "薄荷", "牛蒡子", "荆芥", "淡豆豉", "桔梗", "淡竹叶", "芦根", "甘草"], existingTriggers: [], authored: true };
  const codes = [];
  assert.equal(compiler.topUpModificationRow({ trigger: "咽痛", herbName: "山豆根", dose: "6g", reason: "利咽" }, { ...base, onReject: (code) => codes.push(code) }), undefined);
  assert.deepEqual(codes, ["main_symptom_toxic_herb"]);
  const mild = compiler.topUpModificationRow({ trigger: "咽痛", herbName: "马勃", dose: "3g", reason: "清肺利咽" }, base);
  assert.ok(mild, "无毒的利咽药可作主症补强");
  assert.equal(mild.herbName, "马勃");
  const accompany = [];
  compiler.topUpModificationRow({ trigger: "口干", herbName: "山豆根", dose: "3g", reason: "清热" }, { ...base, onReject: (code) => accompany.push(code) });
  assert.ok(!accompany.includes("main_symptom_toxic_herb"), "伴随表现的行不走这一条");
});

await check("7.6", "方义里抄进来的提示词半句（「原方沙参品种未定，」）不交付，其余照原文", () => {
  const candidate = { name: "沙参麦冬汤", formulaNames: ["沙参麦冬汤"], formulaSource: { evidenceLevel: "classic_text", source: "沙参麦冬汤：《温病条辨》", confidence: "中" },
    herbs: [["北沙参", "君"], ["麦冬", "君"], ["玉竹", "臣"], ["天花粉", "臣"], ["桑叶", "佐"], ["白扁豆", "佐"], ["甘草", "使"]].map(([name, role]) => herb(name, "10g", role)),
    formulaAnalysis: "本方用沙参麦冬汤原方，原方沙参品种未定，取北沙参养阴清肺、益胃生津，与麦冬同为君药；玉竹为臣，助君药养阴润燥，天花粉亦为臣，清热生津；桑叶为佐，轻清虚热而不伤阴，白扁豆为佐，健脾和中；甘草为使，调和诸药。",
    decoction: { method: "每日1剂，水煎两次，共取药液约500mL，分2次服", doses: 5, days: 5 } };
  const out = surface.projectDeliveredReasoning({ ...prescribe(candidate), overview: { tcmDiseaseName: "咳嗽", primarySyndrome: "肺阴亏虚证", secondarySyndromes: [] },
    therapy: { overallPrinciple: "虚则补之", overallMethod: "养阴清热，润肺止咳" } }, { recordText: "主诉：干咳\n现病史：盗汗" }).formula.candidates[0];
  assert.doesNotMatch(out.formulaAnalysis, /品种未定/u);
  assert.match(out.formulaAnalysis, /取北沙参养阴清肺/u);
  // 方义没有逐字对上的说法时（桑叶「轻清虚热而不伤阴」）按治法「润肺止咳」取「清肺润燥」，不取第一条「疏散风热」。
  assert.equal(out.herbs.find((item) => item.name === "桑叶").function, "清肺润燥");
});
