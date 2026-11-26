// 第六十轮（2026-11-26）：发给甲方评审的五份真实病历样张（r1077 的 R046、R062、R007、R008、R010，生产 b9bd6b3）逐字复读后按类修。
// 材料与回放在 ~/runlogs/r1018/work/r1079。本套件一条断言对应一类：
//  1. 「原方」口径：疏风清热汤《中医喉科学讲义》补进原方组成表，药味逐味相同的处方不再叫「加减」（R008）。
//  2. 中成药注意事项：说明书来源站把「本品」换成了「商品名＋通用名」，写回「本品」；两栏各自的条目编号去掉；重复句只留一句（R008、R062、R007）。
//  3. 药味功效栏：同一味药的几条《中药学》功效原文，按方义里对这味药的说明来选（桑叶、防风、牛膝、川芎、天花粉）。
//  4. 病机链证候依据：与病历表现同文时换上的主证依据必须讲的是这个节点的表现（R046）。
//  5. 随访疗效评价标准：不把病历没记的二便、饮食、睡眠写成会好转的症状（R010）。
//  6. 拔罐卡：「5分钟后去罐」已是留罐时长，不再并列总论的留罐时间（R062）。
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
  assert.equal(pick("牛膝", "通利筋脉、引药下行至腰膝", "湿热蕴结腰府，经脉阻滞不通", "清热利湿，舒筋止痛；湿热腰痛"), "引血下行");
});

await check("3.3", "方义没讲到这味药时照旧按病机靶点与治法选；选出来的仍是《中药学》原文整小句", () => {
  const without = functions.selectGroundedHerbFunction({ name: "桑叶", role: "佐", target: "肺阴不足，肺失濡润，气逆作咳", therapy: "养阴清热，润肺止咳；肺阴亏虚证" }).text;
  const empty = functions.selectGroundedHerbFunction({ name: "桑叶", role: "佐", target: "肺阴不足，肺失濡润，气逆作咳", therapy: "养阴清热，润肺止咳；肺阴亏虚证", analysisUse: "" }).text;
  assert.equal(without, empty);
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
  const lugen = functions.selectGroundedHerbFunction({ name: "芦根", role: "佐", target: "", therapy: "", analysisUse: "清热生津" }).text;
  assert.equal(lugen, "清热泻火，生津止渴");
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
