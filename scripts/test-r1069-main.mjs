// 第五十二轮：随证加减在处方定稿后由模型专写、另一厂商复核（m04-modification-authoring.server.ts）；最后补写只补定稿这一步自己删掉的；
// 育龄女性停经伴腹痛/阴道出血时药典孕妇慎用药与可疑妊娠同样处理。模型调用全部用桩；病历为合成。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const authoring = await jiti.import("../src/lib/m04-modification-authoring.server.ts");
const delivery = await jiti.import("../src/lib/m04-final-delivery.server.ts");
const c = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");

const check = async (id, title, run) => {
  if (process.env.R1069_CHECK && process.env.R1069_CHECK !== id) return;
  try { await run(); console.log(`✓ ${id} ${title}`); } catch (error) { process.exitCode = 1; console.error(`✗ ${id} ${title}\n${error.stack}`); }
};

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const caseState = types.normalizeCaseStateInput({
  patient: { age: 35, sex: "男" },
  chiefComplaint: "咳嗽3天",
  symptoms: { 现病史: "3天前受凉后出现咳嗽，咳痰色黄，咽干，口渴，偶有恶心。", 既往史: "否认慢性病史" },
  tongue: "舌红，苔薄黄",
  pulse: "脉浮数",
});
const recordText = safety.clinicalGroundingText(caseState);
const prior = {
  stage: "diagnose",
  overview: { tcmDiseaseName: "咳嗽", primarySyndrome: "风热犯肺证", secondarySyndromes: [], tcmDiagnosticRationale: "咳痰色黄、咽干、舌红苔薄黄、脉浮数为风热犯肺之象。" },
  therapy: { overallMethod: "疏风清热，宣肺止咳" },
  pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "风热犯肺，肺失清肃" }] },
};
const herbs = [["桑叶", "君"], ["菊花", "臣"], ["苦杏仁", "臣"], ["连翘", "佐"], ["薄荷", "佐"], ["桔梗", "佐"], ["芦根", "佐"], ["甘草", "使"]]
  .map(([name, role]) => ({ name, role, dose: "10g", function: "疏风清热" }));
const existingRows = [
  { trigger: "本例已见咳痰色黄", targetPathogenesis: "痰热蕴肺", action: "加", herbName: "浙贝母", doseOrHandling: "10g", reason: "清热化痰", riskNote: "", evidence: { evidenceLevel: "model_inference", source: "患者原文：咳痰色黄", confidence: "中" } },
  { trigger: "本例已见口渴", targetPathogenesis: "热伤津液", action: "加", herbName: "天花粉", doseOrHandling: "10g", reason: "清热生津", riskNote: "", evidence: { evidenceLevel: "model_inference", source: "患者原文：口渴", confidence: "中" } },
];
const content = (rows = existingRows) => `正文\n${START}\n${JSON.stringify({
  stage: "prescribe",
  overview: prior.overview,
  therapy: prior.therapy,
  formula: { candidates: [{ name: "桑菊饮加减", herbs }], modifications: rows, patentAndWestern: [] },
  nonPharma: { precautions: [] },
})}\n${END}\n尾`;
const read = (value) => JSON.parse(value.slice(value.indexOf(START) + START.length, value.indexOf(END)).trim());
const plan = { findings: [{ text: "咽干", coveredBy: "", kind: "accompany" }], keep: [0], drop: [{ index: 1, why: "方中芦根已管口渴" }], rows: [{ trigger: "咽干", herbName: "玄参", dose: "10g", reason: "清热利咽", symptomPathogenesis: "热伤肺津" }] };
const author = (value) => async (_ns, _stage, _messages, _options, parse) => parse(value === undefined ? undefined : JSON.stringify(value));
const review = (verdicts) => async (ns) => { const v = verdicts[ns.replace("m04_modification_authoring_", "")]; return v === undefined ? undefined : { confirmed: v, why: "复核理由" }; };
const confirm = (verdicts, recheckSays = true) => ({ review: review(verdicts), recheck: async () => recheckSays });
const noCautions = async () => [];
const context = { recordText, prior, caseState };

await check("1.1", "开关：缺省只在生产开；显式 on/off 优先", () => {
  assert.equal(authoring.modificationAuthoringEnabled({}), false);
  assert.equal(authoring.modificationAuthoringEnabled({ NODE_ENV: "production" }), true);
  assert.equal(authoring.modificationAuthoringEnabled({ NODE_ENV: "production", CDSS_M04_MODIFICATION_AUTHORING: "off" }), false);
  assert.equal(authoring.modificationAuthoringEnabled({ CDSS_M04_MODIFICATION_AUTHORING: "on" }), true);
});

await check("1.2", "写作结果解析：越界与重复的序号丢掉；同一序号既留又删按删；行要有条件和药", () => {
  const parsed = authoring.parseAuthoringPlan(JSON.stringify({ keep: [0, 0, 5, 1], drop: [{ index: 1, why: "x" }, { index: 9, why: "y" }], rows: [{ trigger: "咽干", herbName: "玄参", dose: "10g" }, { trigger: "", herbName: "芦根" }] }), 2);
  assert.deepEqual(parsed.keep, [0]);
  assert.deepEqual(parsed.drop.map((entry) => entry.index), [1]);
  assert.equal(parsed.rows.length, 1);
  assert.equal(authoring.parseAuthoringPlan("不是 JSON", 2), undefined);
  assert.equal(authoring.parseAuthoringPlan(JSON.stringify({ keep: [0] }), 2), undefined, "没有 rows 不算写作结果");
});

await check("1.3", "写作说留的首轮行与新写的行经复核交付，写作说删的去掉：首轮对的留下，新写的伴随表现一条进方", async () => {
  const out = await authoring.authorModificationsInContent(content(), context, undefined, { author: author(plan), ...confirm({ keep: true, new: true }), cautions: noCautions });
  assert.ok(out, "写作成功时返回改写后的内容");
  const rows = read(out).formula.modifications;
  assert.deepEqual(rows.map((row) => row.herbName), ["浙贝母", "玄参"], JSON.stringify(rows));
  assert.match(rows[1].trigger, /咽干/u);
  assert.equal(rows[1].doseOrHandling, "10g");
  assert.match(rows[1].evidence.source, /咽干/u, "依据写患者原文");
  assert.ok(out.startsWith("正文") && out.trimEnd().endsWith("尾"), "标记外的正文不动");
});

await check("1.4", "复核：新写的行另一家说有错、写作那一家也认这个理由才不进，不认就进；首轮留下的行不再复核", async () => {
  const bothAgree = read(await authoring.authorModificationsInContent(content(), context, undefined, { author: author(plan), ...confirm({ new: false }, true), cautions: noCautions })).formula.modifications;
  assert.deepEqual(bothAgree.map((row) => row.herbName), ["浙贝母"], JSON.stringify(bothAgree));
  const recheckDisagrees = read(await authoring.authorModificationsInContent(content(), context, undefined, { author: author(plan), ...confirm({ new: false }, false), cautions: noCautions })).formula.modifications;
  assert.deepEqual(recheckDisagrees.map((row) => row.herbName), ["浙贝母", "玄参"], JSON.stringify(recheckDisagrees));
  const keptNotReviewed = read(await authoring.authorModificationsInContent(content(), context, undefined, { author: author(plan), ...confirm({ keep: false, new: true }, true), cautions: noCautions })).formula.modifications;
  assert.deepEqual(keptNotReviewed.map((row) => row.herbName), ["浙贝母", "玄参"], JSON.stringify(keptNotReviewed));
});

await check("1.5", "复核没答出来（超时）：新写的行不进；首轮留下的照留，写作删的照删", async () => {
  const rows = read(await authoring.authorModificationsInContent(content(), context, undefined, { author: author(plan), review: async () => undefined, recheck: async () => undefined, cautions: noCautions })).formula.modifications;
  assert.deepEqual(rows.map((row) => row.herbName), ["浙贝母"], JSON.stringify(rows));
});

await check("1.6", "写作失败或内容解析不了时返回 undefined（调用方回到核对＋补写）", async () => {
  assert.equal(await authoring.authorModificationsInContent(content(), context, undefined, { author: author(undefined), ...confirm({}), cautions: noCautions }), undefined);
  assert.equal(await authoring.authorModificationsInContent("没有标记", context, undefined, { author: author(plan), ...confirm({}), cautions: noCautions }), undefined);
});

await check("1.7", "新写的行照旧过编译阶段的安全底线：药已在方中、条件病历没有的都进不了，拦掉的判据可记", async () => {
  const rejected = [];
  const base = { prior, caseState, candidateHerbNames: herbs.map((herb) => herb.name), baseHerbNames: herbs.map((herb) => herb.name), existingTriggers: [], authored: true, onReject: (code) => rejected.push(code) };
  assert.equal(c.topUpModificationRow({ trigger: "咽干", herbName: "芦根", dose: "15g", reason: "清热生津" }, base), undefined);
  assert.equal(c.topUpModificationRow({ trigger: "头痛", herbName: "川芎", dose: "6g", reason: "活血止痛" }, base), undefined);
  assert.deepEqual(rejected, ["herb_in_formula", "not_present"]);
  const viaAuthor = read(await authoring.authorModificationsInContent(content([]), context, undefined, {
    author: author({ findings: [], keep: [], drop: [], rows: [{ trigger: "咽干", herbName: "芦根", dose: "15g", reason: "清热生津" }] }),
    ...confirm({ new: true }), cautions: noCautions,
  })).formula.modifications;
  assert.deepEqual(viaAuthor, [], "复核说对也进不了：方中已有芦根");
});

await check("1.8", "主症补强：写作并复核过的行不按「条件即主诉本身」拦（甲方 10.26 病历2）；其余路径照旧拦", () => {
  const base = { prior, caseState, candidateHerbNames: herbs.map((herb) => herb.name), baseHerbNames: herbs.map((herb) => herb.name), existingTriggers: [] };
  const row = { trigger: "咳嗽", herbName: "紫菀", dose: "10g", reason: "润肺下气止咳，补强宣肺止咳" };
  const codes = [];
  assert.equal(c.topUpModificationRow(row, { ...base, onReject: (code) => codes.push(code) }), undefined);
  assert.deepEqual(codes, ["not_present"], "非写作路径：主诉本身不算本例已见的加减条件");
  const compiled = c.topUpModificationRow(row, { ...base, authored: true });
  assert.ok(compiled, "写作路径的主症补强行可进");
  assert.equal(compiled.herbName, "紫菀");
});

await check("1.9", "教材【使用注意】点名本例情况的新加味不进（与补写同一核对）", async () => {
  const cautions = async (wrapped) => {
    const value = read(wrapped);
    const row = value.formula.modifications[0];
    return [{ herb: row.herbName, item: { condition: "x", raw: "x", line: 1 }, quote: "咽干" }];
  };
  // 桩返回的命中项对不上教材行号时 applyHerbCautionHits 不删；这里只验写作一步把命中交给同一函数、且不因此报错。
  const out = await authoring.authorModificationsInContent(content([]), context, undefined, { author: author({ findings: [], keep: [], drop: [], rows: plan.rows }), ...confirm({ new: true }), cautions });
  assert.ok(out);
});

const pregnantText = (lines) => safety.clinicalGroundingText(types.normalizeCaseStateInput({ patient: { age: lines.age ?? 32, sex: lines.sex ?? "女" }, chiefComplaint: lines.cc, symptoms: { 现病史: lines.hpi } }));
await check("3.1", "育龄女性停经伴腹痛或阴道出血：开方核对按可疑妊娠拦药典孕妇慎用药（制附子、花蕊石；e05-17）", () => {
  const text = pregnantText({ cc: "停经45天，右下腹撕裂样疼痛伴阴道流血2小时", hpi: "平素月经规律，停经45天，突发右下腹撕裂样剧痛，伴阴道少量流血。" });
  assert.equal(safety.pregnancyPainOrBleedingSignalInGroundingText(text), true);
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "人参", role: "君" }, { name: "制附子", role: "君" }], text), "herb_1_special_population_high_risk_pregnancy");
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "黄芪", role: "君" }, { name: "花蕊石", role: "佐" }], text), "herb_1_special_population_high_risk_pregnancy");
});

await check("3.2", "反证：男性、60 岁以上、10 岁以下、没写停经、否认停经、停经但无腹痛出血——都不按可疑妊娠拦", () => {
  const cases = [
    { sex: "男", cc: "停经45天，腹痛2小时", hpi: "腹痛。" },
    { age: 62, cc: "停经45天，腹痛2小时", hpi: "腹痛。" },
    { age: 8, cc: "停经45天，腹痛2小时", hpi: "腹痛。" },
    { cc: "右下腹痛2小时", hpi: "右下腹痛，伴阴道少量流血，月经规律，末次月经2周前。" },
    { cc: "腹痛2小时", hpi: "否认停经，腹痛。" },
    { cc: "停经45天", hpi: "停经45天，无腹痛，无阴道流血。" },
  ];
  for (const item of cases) {
    const text = pregnantText(item);
    assert.equal(safety.pregnancyPainOrBleedingSignalInGroundingText(text), false, JSON.stringify(item));
    assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "黄芪", role: "君" }, { name: "花蕊石", role: "佐" }], text), undefined, JSON.stringify(item));
  }
});

await check("3.3", "同一判据：病历文本版与 CaseState 版对同一病历结论一致", () => {
  for (const item of [
    { cc: "停经45天，右下腹撕裂样疼痛伴阴道流血2小时", hpi: "停经45天，右下腹痛，阴道流血。" },
    { cc: "停经45天", hpi: "停经45天，无腹痛，无阴道流血。" },
    { sex: "男", cc: "腹痛2小时", hpi: "腹痛。" },
    { age: 65, cc: "停经2月，腹痛1天", hpi: "停经2月，腹痛。" },
  ]) {
    const state = types.normalizeCaseStateInput({ patient: { age: item.age ?? 32, sex: item.sex ?? "女" }, chiefComplaint: item.cc, symptoms: { 现病史: item.hpi } });
    assert.equal(safety.pregnancyPainOrBleedingSignalInGroundingText(safety.clinicalGroundingText(state)), safety.pregnancyPainOrBleedingSignal(state), JSON.stringify(item));
  }
});

const surface = await jiti.import("../src/lib/delivered-surface.ts");
const herbRow = (name) => ({ name, dose: "10g", role: name === "桑叶" ? "君" : "佐", function: "疏风清热", targetKind: "pathogenesis", targetRef: "P1", decoctionRequirement: "", evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } });
const mainRow = { trigger: "本例已见咳嗽", targetPathogenesis: "肺失宣肃", action: "加", herbName: "紫菀", doseOrHandling: "10g", reason: "润肺下气止咳，补强宣肺止咳", riskNote: "", evidence: { evidenceLevel: "model_inference", source: "患者原文：出现咳嗽", confidence: "中" } };
const rx = (rows) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: prior.overview, therapy: prior.therapy, pathogenesis: prior.pathogenesis,
  formula: { candidates: [{ name: "自拟方", constructionType: "self_devised", herbs: herbs.map((herb) => herbRow(herb.name)), decoction: { dosesPerDay: 1, administrationTimesPerDay: 2 }, formulaAnalysis: "桑叶、菊花疏风清热。" }], modifications: rows, patentAndWestern: [] },
  nonPharma: { diet: "清淡饮食。", precautions: [], tcmTreatments: [] } });
const withEnv = (value, run) => { const saved = process.env.CDSS_M04_MODIFICATION_AUTHORING; try { if (value === undefined) delete process.env.CDSS_M04_MODIFICATION_AUTHORING; else process.env.CDSS_M04_MODIFICATION_AUTHORING = value; return run(); } finally { if (saved === undefined) delete process.env.CDSS_M04_MODIFICATION_AUTHORING; else process.env.CDSS_M04_MODIFICATION_AUTHORING = saved; } };

await check("1.10", "留存过滤：写作开着时主症补强行留下；关掉时照旧按「主诉本身」去掉", () => {
  const ctx = { recordText, caseState, prior };
  assert.deepEqual(c.retainModificationFindings([mainRow], ctx).map((row) => row.herbName), []);
  assert.deepEqual(c.retainModificationFindings([mainRow], { ...ctx, allowMainSymptom: true }).map((row) => row.herbName), ["紫菀"]);
});

await check("1.11", "末端教材补行里的留存读同一开关：写作开着时主症补强行留下，关掉时去掉", () => {
  const p2 = { ...prior, stage: "diagnose" };
  const on = c.fillTextbookModificationConditions([mainRow], p2, caseState, herbs.map((herb) => herb.name), { authored: true });
  const off = c.fillTextbookModificationConditions([mainRow], p2, caseState, herbs.map((herb) => herb.name));
  assert.ok(on.some((row) => row.herbName === "紫菀"), JSON.stringify(on));
  assert.ok(!off.some((row) => row.herbName === "紫菀"), JSON.stringify(off));
});

await check("1.13", "合并：写作留下的首轮行里被加减核对删掉的不交付；写作新加的行（同一条件换了药）不受影响", () => {
  const wrap = (rows) => `${START}\n${JSON.stringify({ formula: { candidates: [], modifications: rows } })}\n${END}`;
  const a = { trigger: "本例已见口渴", action: "加", herbName: "天花粉" }, b = { trigger: "本例已见咳痰色黄", action: "加", herbName: "浙贝母" }, n = { trigger: "本例已见口渴", action: "加", herbName: "芦根" };
  const merged = read(delivery.withoutRowsRemovedBy(wrap([b, a, n]), wrap([b, a]), wrap([b])));
  assert.deepEqual(merged.formula.modifications.map((row) => row.herbName), ["浙贝母", "芦根"]);
  assert.equal(delivery.withoutRowsRemovedBy(wrap([b, a]), wrap([b, a]), wrap([b, a])), wrap([b, a]), "核对没删时原样返回");
});

await check("1.12", "交付投影读同一开关：开着时主症补强行交付，关掉时去掉", () => {
  const on = withEnv("on", () => surface.projectDeliveredReasoning(rx([mainRow]), { caseState, recordText }));
  assert.ok(on.formula.modifications.some((row) => row.herbName === "紫菀"), JSON.stringify(on.formula.modifications));
  const off = withEnv("off", () => surface.projectDeliveredReasoning(rx([mainRow]), { caseState, recordText }));
  assert.ok(!off.formula.modifications.some((row) => row.herbName === "紫菀"), JSON.stringify(off.formula.modifications));
});

await check("1.14", "新写的行只补到两个不同的条件，另加至多一条补强治法第一项的行", async () => {
  const twoKept = { findings: [], keep: [0, 1], drop: [], rows: [
    { purpose: "uncovered", trigger: "咽干", herbName: "玄参", dose: "10g", reason: "清热利咽" },
    { purpose: "reinforce", trigger: "咳嗽", herbName: "紫菀", dose: "10g", reason: "润肺下气止咳，补强宣肺止咳" },
  ] };
  const rows = read(await authoring.authorModificationsInContent(content(), context, undefined, { author: author(twoKept), ...confirm({ new: true }), cautions: noCautions })).formula.modifications;
  assert.deepEqual(rows.map((row) => row.herbName), ["浙贝母", "天花粉", "紫菀"], JSON.stringify(rows));
});
