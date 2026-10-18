// 10/19 西医诊断整改的断言（验收集 D 不合格 131 例的根因分析；材料在仓库外 ~/runlogs/r1018/work/r1019/agentD）。
// 每一节对应一个服务端缺陷类或一项新增环节；每条断言都带对照或反证（反证清单见各节注释，跑法：把对应改动撤掉后本节必须变红）。
//
//   1 西医名称归一按整名：「高血压急症」「继发性高血压」「高血压脑病」不再被改成「高血压」（X-D-0154；鉴别里 24 处）
//   2 防证候混入的正则不吃「风湿热」：急性风湿热不再被换成「心悸」（X-D-5901）
//   3 正式病名守卫：肺功能写数值（FEV₁/FVC%为55%）读得出；慢性支气管炎「近3年每当秋冬发病」算够病程（X-D-2796、X-D-0020）
//   4 病名核对的落点：D 类给的上一级不再换回原名；A/B 类只去掉病程限定时不挂「待查」；A/B 类可改成西医半自己列出的病
//   5 红旗病例上急危重病名不被 A–C 改成症状（X-D-0529）
//   6 诊断标准要点表：类风湿关节炎按 1987 ACR 不必依赖血清学；新增链球菌感染后肾小球肾炎、糖皮质激素性青光眼
//   7 西医主诊断闭集重选：只在西医半自己的候选与鉴别里换名或补「伴X」，引文逐字在病历里；红旗不把急危重首要考虑换轻
//   8 接线与提示词
//
// 跑法：npx jiti scripts/test-r1019-western.mjs（不进闸门）。R1019_SRC 可指向一份源码副本，用来跑反证。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.R1019_SRC || path.join(REPO, "src");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": SRC,
    "server-only": path.join(REPO, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
process.env.CDSS_WEB_SEARCH = "false";
// 本地桩：small task 走受控术语模型配置（与 test-eval1014-remediation 同一套假配置；请求由 globalThis.fetch 桩接住）。
Object.assign(process.env, {
  AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://api.deepseek.com",
  OPENAI_MODEL: "deepseek-flash", CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash",
});

const results = [];
const check = async (name, run) => {
  try {
    await run();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message.slice(0, 400) : String(error) });
  }
};
const lib = (file) => jiti.import(path.join(SRC, "lib", file));
const wrap = (reasoning) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
const unwrap = (content) => JSON.parse(content.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
const completion = (payload) => new Response(JSON.stringify({
  id: "t", object: "chat.completion", model: "deepseek-flash",
  choices: [{ index: 0, message: { role: "assistant", content: typeof payload === "string" ? payload : JSON.stringify(payload) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { headers: { "content-type": "application/json" } });

// ── 1 ── 反证：把 WESTERN_DIAGNOSIS_RULES 的高血压一条改回子串匹配 /(?:原发性)?高血压(?:病)?/ ⇒ 1.1 变红
{
  const { canonicalWesternDiagnosisName } = await lib("clinical-terminology.ts");
  await check("1.1 高血压急症、继发性高血压、高血压脑病、高血压性脑出血、2型糖尿病酮症酸中毒保持原名", () => {
    for (const name of ["高血压急症", "继发性高血压", "高血压脑病", "高血压性脑出血", "高血压病3级", "2型糖尿病酮症酸中毒"]) {
      assert.equal(canonicalWesternDiagnosisName(name), name, name);
    }
  });
  await check("1.2 对照：同一个病的不同写法照常归一（原发性高血压病、OSAHS、失眠写法、包在鉴别句里的睡眠呼吸暂停）", () => {
    assert.equal(canonicalWesternDiagnosisName("原发性高血压病"), "高血压");
    assert.equal(canonicalWesternDiagnosisName("高血压病"), "高血压");
    assert.equal(canonicalWesternDiagnosisName("二型糖尿病"), "2型糖尿病");
    assert.equal(canonicalWesternDiagnosisName("阻塞性睡眠呼吸暂停低通气综合征"), "阻塞性睡眠呼吸暂停");
    assert.equal(canonicalWesternDiagnosisName("OSAHS"), "阻塞性睡眠呼吸暂停");
    assert.equal(canonicalWesternDiagnosisName("慢性-失眠障碍倾向"), "慢性失眠障碍");
    assert.equal(canonicalWesternDiagnosisName("劳力性呼吸困难待查：需排除阻塞性睡眠呼吸暂停"), "阻塞性睡眠呼吸暂停");
  });
}

// ── 2 ── 反证：去掉 (?<!风) ⇒ 2.1 变红
{
  const visible = await lib("diagnosis-visible-summary.ts");
  const reasoning = (name) => ({
    stage: "diagnose",
    overview: { tcmDiseaseName: "心悸", primarySyndrome: "心血不足证" },
    westernDiagnosis: { primary: { name, status: "考虑", confidence: "中", supportingFacts: ["近日心悸，气短，发热"], clinicalRationale: "扁桃体炎后2周出现游走性关节痛与环形红斑，符合该诊断；需排除感染性心内膜炎。" }, differentials: [] },
    pathogenesis: { chain: [] },
    therapy: {},
  });
  const context = "主诉：2周前患扁桃体炎，近日心悸，气短，发热\n现病史：2周前患扁桃体炎，近日心悸，气短，发热，出汗，疲乏，踝、膝关节游走性疼痛。";
  const name = (n) => unwrap(visible.applyM03AdvisoryQualityBoundaries(wrap(reasoning(n)), context)).westernDiagnosis.primary.name;
  await check("2.1 「急性风湿热」不被当成带证候的名称换掉（X-D-5901）", () => {
    assert.equal(name("急性风湿热"), "急性风湿热");
    assert.equal(name("风湿热"), "风湿热");
  });
  await check("2.2 对照：真带证候字样的名称照常换成症状层（「湿热痹」「风热感冒」）", () => {
    assert.notEqual(name("湿热痹"), "湿热痹");
    assert.notEqual(name("风热感冒"), "风热感冒");
  });
}

// ── 3 ── 反证：COPD 判据去掉 spirometryRatioBelowThreshold ⇒ 3.1 变红；慢支去掉季节写法 ⇒ 3.3 变红
{
  const visible = await lib("diagnosis-visible-summary.ts");
  const formal = (name) => wrap({ stage: "diagnose", westernDiagnosis: { primary: { name, supportingFacts: ["咳嗽、咳痰"], suggestedChecks: [] }, differentials: [] } });
  const primary = (name, context) => unwrap(visible.declassifyUnmetFormalM03WesternPrimary(formal(name), context)).westernDiagnosis.primary.name;
  await check("3.1 肺功能写数值：FEV₁/FVC%为55%、一秒率0.62 保留慢阻肺（X-D-2796）", () => {
    assert.equal(primary("慢性阻塞性肺疾病", "主诉：咳嗽5年，呼吸困难加重7天\n现病史：桶状胸，RV/TLC%=40%MVV占预计值50%，FEV₁/FVC%为55%"), "慢性阻塞性肺疾病");
    assert.equal(primary("慢性阻塞性肺疾病", "主诉：咳嗽咳痰10年\n辅助检查：肺功能一秒率0.62"), "慢性阻塞性肺疾病");
  });
  await check("3.2 对照：数值不低于 0.70、只写 FEV1 占预计值、没有肺功能时照常降级", () => {
    for (const context of [
      "主诉：咳嗽5年\n辅助检查：FEV1/FVC 75%",
      "主诉：咳嗽5年\n辅助检查：FEV1占预计值55%",
      "主诉：咳嗽5年，活动后气短",
    ]) assert.notEqual(primary("慢性阻塞性肺疾病", context), "慢性阻塞性肺疾病", context);
  });
  await check("3.3 慢支：「反复咳嗽、咳痰10年，近3年每当秋冬发病」算够病程（X-D-0020）", () => {
    assert.equal(primary("慢性支气管炎", "主诉：反复咳嗽、咳痰10年，近3年每当秋冬发病，大气变暖后逐渐减轻\n现病史：反复咳嗽、咳痰10年，近3年每当秋冬发病，大气变暖后逐渐减轻。"), "慢性支气管炎");
  });
  await check("3.4 对照：病程不足 2 年、只写「受凉后加重」、季节写法不在咳嗽句里时照常降级", () => {
    for (const context of [
      "主诉：咳嗽咳痰1年余\n现病史：咳嗽咳痰1年余，每当冬季发作。",
      "主诉：反复咳嗽咳痰10年\n现病史：反复咳嗽咳痰10年，受凉后加重。",
      "主诉：咳嗽咳痰10年\n现病史：咳嗽咳痰10年。\n既往史：每年冬季手足冻疮发作。",
    ]) assert.notEqual(primary("慢性支气管炎", context), "慢性支气管炎", context);
  });
}

// ── 4 ── 病名核对的落点
// 反证：keepHypothesis 去掉 !namesSameDiseaseFamily ⇒ 4.1 变红；去掉 qualifierOnly ⇒ 4.2 变红；去掉 adoptedFromList ⇒ 4.3 变红
{
  const check4 = await lib("western-name-evidence-check.server.ts");
  const verdict = (extra) => JSON.stringify({ verdict: "inconsistent", quote: "叩诊心界向两侧扩大，心音遥远", reason: "无超声定量依据", ...extra });
  const record = "主诉：咳嗽伴呼吸困难3个月\n现病史：颈静脉怒张，叩诊心界向两侧扩大，心音遥远。尿频，排尿困难2年，加重2周。肾活检：基底膜增厚，嗜银染色有钉突形成。";
  await check("4.1 D 类给的是原名的上一级（大量心包积液→心包积液待查）时用它，不换回「大量心包积液待查」（X-D-1053、X-D-4969）", () => {
    assert.equal(check4.parseWesternNameCorrection(verdict({ type: "D", supportedName: "心包积液待查" }), record, "大量心包积液")?.supportedName, "心包积液待查");
    assert.equal(check4.parseWesternNameCorrection(verdict({ type: "D", supportedName: "周期性麻痹待查" }), record, "低钾性周期性麻痹")?.supportedName, "周期性麻痹待查");
    // 对照：给的是症状待查（与原名不是同一类病）时仍留住首要考虑
    assert.equal(check4.parseWesternNameCorrection(verdict({ type: "D", supportedName: "呼吸困难待查" }), record, "大量心包积液")?.supportedName, "大量心包积液待查");
  });
  await check("4.2 A/B 类上一级只是去掉了病程限定（急性尿潴留→尿潴留待查）时交付「尿潴留」（X-D-0204）；C 类与症状待查照旧（对照）", () => {
    const quote = "尿频，排尿困难2年，加重2周";
    assert.equal(check4.parseWesternNameCorrection(verdict({ type: "B", quote, supportedName: "尿潴留待查" }), record, "急性尿潴留")?.supportedName, "尿潴留");
    assert.equal(check4.parseWesternNameCorrection(verdict({ type: "C", quote, supportedName: "尿潴留待查" }), record, "急性尿潴留")?.supportedName, "尿潴留待查");
    assert.equal(check4.parseWesternNameCorrection(verdict({ type: "B", quote, supportedName: "排尿困难待查" }), record, "急性尿潴留")?.supportedName, "排尿困难待查");
  });
  const listed = ["膜性肾病", "IgA肾病", "糖尿病肾病"];
  const adopt = (extra = {}) => check4.parseWesternNameCorrection(
    verdict({ type: "A", quote: "肾活检：基底膜增厚，嗜银染色有钉突形成", reason: "活检所见指向膜性肾病", supportedName: "膜性肾病", ...extra }),
    record, "微小病变型肾病", { listedNames: listed },
  );
  await check("4.3 A 类可改成西医半自己列出的病（活检钉突→膜性肾病，X-D-4841）；改写时首位用它自己的候选条目，原名进鉴别", () => {
    const correction = adopt();
    assert.equal(correction?.supportedName, "膜性肾病");
    assert.equal(correction?.adoptedFromList, true);
    const western = { westernDiagnosis: {
      primary: { name: "微小病变型肾病" },
      candidates: [
        { name: "微小病变型肾病", likelihood: "中", keyEvidence: ["大量蛋白尿"], againstEvidence: [] },
        { name: "膜性肾病", likelihood: "高", keyEvidence: ["钉突形成"], againstEvidence: [] },
      ],
      differentials: [{ name: "膜性肾病", reason: "活检所见", distinguishingPoints: "钉突", nextCheck: "抗PLA2R" }, { name: "IgA肾病", reason: "血尿", distinguishingPoints: "无", nextCheck: "活检" }],
    } };
    const out = JSON.parse(check4.applyWesternNameCorrection(JSON.stringify(western), correction)).westernDiagnosis;
    assert.equal(out.primary.name, "膜性肾病");
    assert.deepEqual(out.candidates[0], { name: "膜性肾病", likelihood: "高", keyEvidence: ["钉突形成"], againstEvidence: [] });
    assert.equal(out.candidates[1].name, "微小病变型肾病");
    assert.ok(!out.differentials.some((item) => item.name === "膜性肾病"), "升为主诊断的病不再留在鉴别里");
    assert.ok(out.differentials.some((item) => item.name === "微小病变型肾病"));
  });
  await check("4.4 对照：名单里没有的病、D 类、带「待查」的名称不算采自名单", () => {
    assert.equal(adopt({ supportedName: "膜增生性肾小球肾炎" })?.adoptedFromList, undefined);
    assert.equal(adopt({ type: "D" })?.adoptedFromList, undefined);
    assert.equal(adopt({ supportedName: "膜性肾病待查" })?.adoptedFromList, undefined);
  });
  await check("4.5 列出的名单不含主诊断本身，候选与鉴别去重", () => {
    assert.deepEqual(check4.listedWesternDiagnosisNames({ primary: { name: "A病" }, candidates: [{ name: "A病" }, { name: "B病" }], differentials: [{ name: "B病" }, { name: "C病" }] }), ["B病", "C病"]);
  });
}

// ── 5 ── 反证：heldOnRedFlag 改回只拦 D ⇒ 5.1 变红
{
  const check5 = await lib("western-name-evidence-check.server.ts");
  const savedFetch = globalThis.fetch;
  const record = "主诉：上腹痛12小时\n现病史：上腹痛12小时，腹胀，查体上腹压痛，胁腹皮肤呈灰紫色斑，血淀粉酶＜500SomogyiU。";
  const half = (name, differentials = []) => JSON.stringify({ westernDiagnosis: { primary: { name }, differentials, candidates: [{ name }] }, management: {} });
  const answer = (extra) => completion({ verdict: "inconsistent", type: "A", quote: "血淀粉酶＜500SomogyiU", reason: "淀粉酶未达诊断阈值", supportedName: "腹痛待查", emergencyName: true, ...extra });
  try {
    await check("5.1 红旗病例：急危重病名（急性胰腺炎）不被 A 类改成症状待查（X-D-0529）", async () => {
      globalThis.fetch = async () => answer({});
      assert.equal(await check5.alignWesternNameWithRecord(half("急性胰腺炎"), { recordText: record, redFlag: true }), half("急性胰腺炎"));
    });
    await check("5.2 对照：非红旗照常改；红旗而原名不是急危重症照常改；红旗而改成同一类病的上一级照常改", async () => {
      globalThis.fetch = async () => answer({});
      assert.equal(JSON.parse(await check5.alignWesternNameWithRecord(half("急性胰腺炎"), { recordText: record })).westernDiagnosis.primary.name, "腹痛待查");
      globalThis.fetch = async () => answer({ emergencyName: false });
      assert.equal(JSON.parse(await check5.alignWesternNameWithRecord(half("胰腺假性囊肿"), { recordText: record, redFlag: true })).westernDiagnosis.primary.name, "腹痛待查");
      globalThis.fetch = async () => answer({ supportedName: "胰腺炎待查" });
      assert.equal(JSON.parse(await check5.alignWesternNameWithRecord(half("重症急性胰腺炎"), { recordText: record, redFlag: true })).westernDiagnosis.primary.name, "胰腺炎待查");
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
}

// ── 6 ── 反证：把类风湿关节炎条目改回 ["RF或抗CCP血清学","CRP或血沉"]、删掉两条新条目 ⇒ 6.1/6.2 变红
{
  const criteria = await lib("western-diagnostic-criteria.server.ts");
  await check("6.1 类风湿关节炎：满足 1987 ACR 4 项或关节＞10个且病程≥6周时不依赖血清学（X-D-3306）", () => {
    const entry = criteria.westernCriteriaEntry("类风湿关节炎");
    assert.ok(entry);
    assert.match(entry.requiredTests.join("；"), /1987年ACR标准7项中4项/);
    assert.match(entry.requiredTests.join("；"), /不依赖这些检查即可分类/);
  });
  await check("6.2 新条目：急性链球菌感染后肾小球肾炎（按去掉「急性」查到）要链球菌感染证据与补体；糖皮质激素性青光眼要视神经损害", () => {
    const psgn = criteria.westernCriteriaEntry("急性链球菌感染后肾小球肾炎");
    assert.ok(psgn, "按核心病名查到");
    assert.equal(psgn.clinicallyDiagnosable, false);
    assert.ok(psgn.requiredTests.some((item) => /抗链球菌溶血素O/.test(item)));
    const glaucoma = criteria.westernCriteriaEntry("糖皮质激素性青光眼");
    assert.ok(glaucoma);
    assert.ok(glaucoma.definingFeatures.some((item) => /高眼压症/.test(item)));
    assert.equal(criteria.westernCriteriaEntry("急性肾小球肾炎"), undefined, "对照：上一级病名不受新条目影响");
  });
  await check("6.3 去掉病程限定前缀的查名：急性尿潴留→尿潴留；没有前缀时为空（对照）", () => {
    assert.equal(criteria.westernNameWithoutCourseOrSideQualifier("急性尿潴留"), "尿潴留");
    assert.equal(criteria.westernNameWithoutCourseOrSideQualifier("尿潴留"), undefined);
  });
}

// ── 7 ── 西医主诊断闭集重选
// 反证：parse 去掉名单校验 ⇒ 7.2 变红；去掉红旗取舍 ⇒ 7.3 变红；apply 的 append 不改名 ⇒ 7.4 变红；route 不接线 ⇒ 8.1 变红
{
  const reselect = await lib("western-primary-reselect.server.ts");
  const record = "主诉：女性，30岁，4小时前跌伤后昏迷5分钟\n现病史：4小时前跌伤后昏迷5分钟，清醒后步行回家。1小时前因剧烈头痛，呕吐3次送来急诊。血压80/60mmHg，四肢湿冷。";
  const listed = ["急性硬膜外血肿", "脑挫裂伤伴颅内血肿", "感染性休克"];
  const answer = (extra = {}) => JSON.stringify({ action: "replace", name: "急性硬膜外血肿", quote: "昏迷5分钟，清醒后步行回家", reason: "中间清醒期是硬膜外血肿的典型表现", currentIsEmergency: true, nameIsEmergency: true, ...extra });
  await check("7.1 replace：名单里的病、引文逐字在病历里时采信（X-D-0749、X-D-5339 硬膜下→硬膜外）", () => {
    assert.deepEqual(reselect.parseWesternPrimaryReselection(answer(), record, "急性硬膜下血肿", listed), { action: "replace", name: "急性硬膜外血肿", quote: "昏迷5分钟，清醒后步行回家", reason: "中间清醒期是硬膜外血肿的典型表现" });
  });
  await check("7.2 不采信：名称不在名单里、引文不在病历里、keep、名称与原名相同、名称带待查", () => {
    assert.equal(reselect.parseWesternPrimaryReselection(answer({ name: "脑震荡" }), record, "急性硬膜下血肿", listed), undefined);
    assert.equal(reselect.parseWesternPrimaryReselection(answer({ quote: "昏迷后一直未醒" }), record, "急性硬膜下血肿", listed), undefined);
    assert.equal(reselect.parseWesternPrimaryReselection(answer({ action: "keep" }), record, "急性硬膜下血肿", listed), undefined);
    assert.equal(reselect.parseWesternPrimaryReselection(answer({ name: "急性硬膜外血肿" }), record, "急性硬膜外血肿", ["急性硬膜外血肿"]), undefined);
    assert.equal(reselect.parseWesternPrimaryReselection(answer({ name: "颅内血肿待查" }), record, "急性硬膜下血肿", [...listed, "颅内血肿待查"]), undefined);
  });
  await check("7.3 红旗：急危重首要考虑不换成非急危重的病；换成同为急危重的病照常（对照）；非红旗不受限（对照）", () => {
    const softer = answer({ name: "脑挫裂伤伴颅内血肿", nameIsEmergency: false });
    assert.equal(reselect.parseWesternPrimaryReselection(softer, record, "急性硬膜下血肿", listed, { redFlag: true }), undefined);
    assert.ok(reselect.parseWesternPrimaryReselection(answer(), record, "急性硬膜下血肿", listed, { redFlag: true }));
    assert.ok(reselect.parseWesternPrimaryReselection(softer, record, "急性硬膜下血肿", listed, { redFlag: false }));
  });
  await check("7.4 append：成立的主诊断后补名单里的并发症「伴X」，并从鉴别里拿掉它（X-D-4827 腹膜炎伴感染性休克）；原名已是待查或已含该病时不补（对照）", () => {
    const append = JSON.stringify({ action: "append", name: "感染性休克", quote: "血压80/60mmHg，四肢湿冷", reason: "低血压伴末梢湿冷为休克", currentIsEmergency: true, nameIsEmergency: true });
    const selection = reselect.parseWesternPrimaryReselection(append, record, "急性弥漫性腹膜炎", listed);
    assert.equal(selection?.action, "append");
    const western = { westernDiagnosis: { primary: { name: "急性弥漫性腹膜炎" }, candidates: [{ name: "急性弥漫性腹膜炎", likelihood: "高", keyEvidence: ["全腹肌紧张"], againstEvidence: [] }, { name: "感染性休克", likelihood: "中" }], differentials: [{ name: "感染性休克" }, { name: "消化道穿孔" }] } };
    const out = JSON.parse(reselect.applyWesternPrimaryReselection(JSON.stringify(western), selection)).westernDiagnosis;
    assert.equal(out.primary.name, "急性弥漫性腹膜炎伴感染性休克");
    assert.equal(out.candidates[0].name, "急性弥漫性腹膜炎伴感染性休克");
    assert.deepEqual(out.candidates[0].keyEvidence, ["全腹肌紧张"]);
    assert.deepEqual(out.differentials.map((item) => item.name), ["消化道穿孔"]);
    assert.equal(reselect.parseWesternPrimaryReselection(append, record, "腹痛待查", listed), undefined);
    assert.equal(reselect.parseWesternPrimaryReselection(append, record, "感染性休克伴腹膜炎", listed), undefined);
    // 只补急危重并发症（262 例实跑补出「甲亢伴精神分裂症」「慢性胰腺炎伴糖尿病」）：模型判不是急危重的不追加。
    const nonEmergency = JSON.stringify({ action: "append", name: "感染性休克", quote: "血压80/60mmHg，四肢湿冷", reason: "低血压伴末梢湿冷为休克", currentIsEmergency: true, nameIsEmergency: false });
    assert.equal(reselect.parseWesternPrimaryReselection(nonEmergency, record, "急性弥漫性腹膜炎", listed), undefined);
  });
  await check("7.4b 名单里的病已包含原名时按换名处理（高血压→高血压急症，不写「高血压伴高血压急症」）；名单里的病带「伴」、原名已有两处「伴」时不追加（离线回放「急性心肌炎伴暴发性心肌炎伴心源性休克」）", () => {
    const appendOf = (name) => JSON.stringify({ action: "append", name, quote: "血压80/60mmHg，四肢湿冷", reason: "记录支持该诊断", currentIsEmergency: false, nameIsEmergency: true });
    assert.deepEqual(reselect.parseWesternPrimaryReselection(appendOf("高血压急症"), record, "高血压", ["高血压急症"]), { action: "replace", name: "高血压急症", quote: "血压80/60mmHg，四肢湿冷", reason: "记录支持该诊断" });
    assert.equal(reselect.parseWesternPrimaryReselection(appendOf("暴发性心肌炎伴心源性休克"), record, "急性心肌炎", ["暴发性心肌炎伴心源性休克"]), undefined);
    assert.equal(reselect.parseWesternPrimaryReselection(appendOf("代谢性酸中毒"), record, "腹泻病伴重度脱水伴低钾血症", ["代谢性酸中毒"]), undefined);
    assert.equal(reselect.parseWesternPrimaryReselection(appendOf("代谢性酸中毒"), record, "婴儿腹泻病伴重度脱水", ["代谢性酸中毒"])?.action, "append", "对照：原名只有一处「伴」时可以追加");
  });
  await check("7.4c 休克的数字门槛：引文血压收缩压≥90（90/60mmHg、12/8kPa）时不补「伴…休克」（离线回放 X-D-0060）；80/60mmHg、引文不带血压时照常（对照）", () => {
    const shock = (quote) => JSON.stringify({ action: "append", name: "心源性休克", quote, reason: "低血压提示休克", currentIsEmergency: true, nameIsEmergency: true });
    const chart = "主诉：胸痛2小时\n现病史：检查:血压90/60mmHg,心律不齐。BP 12/8kPa。另测血压80/60mmHg，四肢湿冷。";
    assert.equal(reselect.parseWesternPrimaryReselection(shock("检查:血压90/60mmHg,心律不齐"), chart, "急性下壁心肌梗死", ["心源性休克"]), undefined);
    assert.equal(reselect.parseWesternPrimaryReselection(shock("BP 12/8kPa"), chart, "急性下壁心肌梗死", ["心源性休克"]), undefined);
    assert.equal(reselect.parseWesternPrimaryReselection(shock("另测血压80/60mmHg，四肢湿冷"), chart, "急性下壁心肌梗死", ["心源性休克"])?.action, "append");
    assert.equal(reselect.parseWesternPrimaryReselection(shock("四肢湿冷"), chart, "急性下壁心肌梗死", ["心源性休克"])?.action, "append");
  });
  await check("7.5 replace 写回：首位用所选病自己的候选条目，原名留在候选与鉴别里", () => {
    const selection = reselect.parseWesternPrimaryReselection(answer(), record, "急性硬膜下血肿", listed);
    const western = { westernDiagnosis: { primary: { name: "急性硬膜下血肿", status: "考虑" }, candidates: [{ name: "急性硬膜下血肿", likelihood: "中" }, { name: "急性硬膜外血肿", likelihood: "中", keyEvidence: ["中间清醒期"] }], differentials: [{ name: "急性硬膜外血肿" }, { name: "蛛网膜下腔出血" }] } };
    const out = JSON.parse(reselect.applyWesternPrimaryReselection(JSON.stringify(western), selection)).westernDiagnosis;
    assert.equal(out.primary.name, "急性硬膜外血肿");
    assert.equal(out.primary.status, "考虑", "其余字段不动");
    assert.deepEqual(out.candidates.map((item) => item.name), ["急性硬膜外血肿", "急性硬膜下血肿"]);
    assert.deepEqual(out.candidates[0].keyEvidence, ["中间清醒期"]);
    assert.deepEqual(out.differentials.map((item) => item.name), ["急性硬膜下血肿", "蛛网膜下腔出血"]);
  });
  const savedFetch = globalThis.fetch;
  try {
    await check("7.6 收口：模型可用时按结论改；关开关、没有名单、模型不可用时原样返回且不多调用", async () => {
      let calls = 0;
      const half = JSON.stringify({ westernDiagnosis: { primary: { name: "急性硬膜下血肿" }, candidates: [{ name: "急性硬膜下血肿" }, { name: "急性硬膜外血肿" }], differentials: [] }, management: {} });
      globalThis.fetch = async () => { calls += 1; return completion(answer()); };
      assert.equal(JSON.parse(await reselect.reselectWesternPrimaryFromListed(half, { recordText: record })).westernDiagnosis.primary.name, "急性硬膜外血肿");
      assert.equal(calls, 1);
      const before = calls;
      const noList = JSON.stringify({ westernDiagnosis: { primary: { name: "急性硬膜下血肿" }, candidates: [{ name: "急性硬膜下血肿" }], differentials: [] } });
      assert.equal(await reselect.reselectWesternPrimaryFromListed(noList, { recordText: record }), noList);
      process.env.CDSS_WESTERN_PRIMARY_RESELECT = "false";
      assert.equal(await reselect.reselectWesternPrimaryFromListed(half, { recordText: record }), half);
      delete process.env.CDSS_WESTERN_PRIMARY_RESELECT;
      assert.equal(calls, before);
      globalThis.fetch = async () => { throw new Error("upstream down"); };
      assert.equal(await reselect.reselectWesternPrimaryFromListed(half.replace("急性硬膜下血肿", "硬膜下积液"), { recordText: record }), half.replace("急性硬膜下血肿", "硬膜下积液"));
    });
  } finally {
    delete process.env.CDSS_WESTERN_PRIMARY_RESELECT;
    globalThis.fetch = savedFetch;
  }
}

// ── 8 ── 接线与提示词。反证：route 改回只调 alignWesternNameWithRecord ⇒ 8.1 变红；收口不对新名称再核对 ⇒ 8.3 变红；
//          追加后仍交给核对 ⇒ 8.4 变红；删掉西医半提示词新增两句 ⇒ 8.2 变红
{
  await check("8.1 西医半收口接的是重选+核对", () => {
    const route = fs.readFileSync(path.join(SRC, "app/api/diagnosis/diagnose/route.ts"), "utf8");
    const transform = route.slice(route.indexOf("m03WesternHalfTransform:"), route.indexOf("m03WesternHalfTransform:") + 400);
    assert.match(transform, /alignWesternPrimaryAndName\(\s*westernContent/);
  });
  const reselect = await lib("western-primary-reselect.server.ts");
  const savedFetch = globalThis.fetch;
  const record = "主诉：腹痛、发热48小时\n现病史：腹痛、发热48h，血压80/60mmHg，神志清楚面色苍白，四肢湿冷，全腹肌紧张，肠鸣音消失。";
  const half = (name) => JSON.stringify({ westernDiagnosis: { primary: { name }, candidates: [{ name }, { name: "感染性休克" }, { name: "消化道穿孔" }], differentials: [] }, management: {} });
  const route = (bodies) => async (url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    const system = String(body.messages?.[0]?.content || "");
    return completion(system.startsWith("你是西医主诊断的核对器") ? bodies.reselect : bodies.check(JSON.parse(body.messages[1].content).diagnosisName));
  };
  const consistent = { verdict: "consistent", type: "", quote: "", reason: "", supportedName: "" };
  try {
    await check("8.3 换名后对新名称再核对：换成的病缺确诊检查时照常写成「待查」", async () => {
      globalThis.fetch = route({
        reselect: { action: "replace", name: "消化道穿孔", quote: "全腹肌紧张，肠鸣音消失", reason: "板状腹提示穿孔", currentIsEmergency: true, nameIsEmergency: true },
        check: (name) => name === "消化道穿孔" ? { verdict: "inconsistent", type: "A", quote: "全腹肌紧张，肠鸣音消失", reason: "未见膈下游离气体记录", supportedName: "急腹症待查" } : consistent,
      });
      assert.equal(JSON.parse(await reselect.alignWesternPrimaryAndName(half("急性弥漫性腹膜炎"), { recordText: record })).westernDiagnosis.primary.name, "急腹症待查");
    });
    await check("8.4 追加：核对没改原名时交付「原名伴X」，核对改了原名时交付核对结果、不再追加（对照）", async () => {
      const append = { action: "append", name: "感染性休克", quote: "血压80/60mmHg", reason: "低血压伴末梢湿冷为休克", currentIsEmergency: true, nameIsEmergency: true };
      // 小任务结果按请求内容缓存：这里换一个原名，避免取到 8.3 的缓存。核对桩对原名与组合名给不同结论，才分得出「组合名是否又交给了核对」。
      const downgrade = { verdict: "inconsistent", type: "D", quote: "全腹肌紧张，肠鸣音消失", reason: "尚缺影像依据", supportedName: "腹膜炎" };
      globalThis.fetch = route({ reselect: append, check: (name) => /伴/.test(name) ? downgrade : consistent });
      assert.equal(JSON.parse(await reselect.alignWesternPrimaryAndName(half("继发性腹膜炎"), { recordText: record })).westernDiagnosis.primary.name, "继发性腹膜炎伴感染性休克", "组合名不再交给核对");
      globalThis.fetch = route({ reselect: append, check: (name) => /伴/.test(name) ? consistent : downgrade });
      assert.equal(JSON.parse(await reselect.alignWesternPrimaryAndName(half("急性化脓性腹膜炎"), { recordText: record })).westernDiagnosis.primary.name, "腹膜炎", "原名被核对改了时交付核对结果");
    });
    await check("8.5 换成原名的细化而核对说细化过头时，交付原名的核对结果（离线回放 X-D-1286 系统性硬化症→「…伴肺间质纤维化急性加重」→「系统性硬化症待查」）；非细化的换名照常交付核对结果（对照，见 8.3）", async () => {
      const refine = { action: "replace", name: "系统性硬化症伴肺间质纤维化", quote: "全腹肌紧张，肠鸣音消失", reason: "记录支持肺间质纤维化", currentIsEmergency: false, nameIsEmergency: false };
      const halfRefine = JSON.stringify({ westernDiagnosis: { primary: { name: "系统性硬化症" }, candidates: [{ name: "系统性硬化症" }, { name: "系统性硬化症伴肺间质纤维化" }], differentials: [] }, management: {} });
      globalThis.fetch = route({ reselect: refine, check: (name) => name === "系统性硬化症" ? consistent : { verdict: "inconsistent", type: "D", quote: "全腹肌紧张，肠鸣音消失", reason: "尚缺高分辨CT", supportedName: "系统性硬化症待查" } });
      assert.equal(JSON.parse(await reselect.alignWesternPrimaryAndName(halfRefine, { recordText: record })).westernDiagnosis.primary.name, "系统性硬化症");
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
  await check("8.2 西医半提示词：写病因或病变本身、检查确定的分型部位分期写进病名；不再要求把并发症写进 name", async () => {
    const { buildM03ContextPackets } = await lib("m03-context-packets.ts");
    const western = buildM03ContextPackets({ sharedPatientContext: "主诉：腹痛", fullPrompt: "", evidenceContext: "", stageInstructions: "" }).western;
    assert.match(western, /写消化道穿孔而不是急性腹膜炎/);
    // 10/19 第二轮回放：「确诊检查还没有时照样写最可能的具体病种」一句让模型写出病历没有的分型（急性髓系白血病、肥厚型梗阻性心肌病、
    // 急性单纯性膀胱炎），已改成明确不加未写明的分型、程度与并发症。
    assert.match(western, /病历没有写明的分型、程度与并发症（如髓系或淋系、梗阻性、单纯性、重度）不要加进病名/);
    assert.doesNotMatch(western, /不要为了保守退到上一级类别名/);
    // 10/19 本机回放：西医半提示词加了「病历已记录的并发症用伴写进 name」后，262 例里 87 例的名称多出「伴/合并」，对照组 11 例因此
    // 判过度具体（无血气写呼吸衰竭、90/60mmHg 写休克、无凝血检查写 DIC）。这句已撤，并发症只由闭集重选按引文与数字门槛补。
    assert.doesNotMatch(western, /用“伴”“合并”写进 name，最多补一个/);
    const prompts = fs.readFileSync(path.join(SRC, "lib/diagnosis-prompts.ts"), "utf8");
    assert.match(prompts, /写消化道穿孔而不是急性腹膜炎/, "完整提示词（修复轮与不并行时用）同一口径");
  });
}

// ═══ 第二轮（10/19 终审复评，提交 a609be4 之后）═══
// ── 9 ── 鉴别拆分：只说病变走向的词（恶变/癌变）借兄弟项的部位或病名，借不到不单独成条（甲方标准病历 10 第 3 次生成）。
//        反证：去掉 PROCESS_ONLY_PATHOLOGY 分支 ⇒ 9.1 变红。
{
  const visible = await lib("diagnosis-visible-summary.ts");
  const split = (name) => unwrap(visible.groundStructuredPatientFacts(wrap({
    stage: "diagnose",
    westernDiagnosis: { primary: { name: "异常子宫出血", supportingFacts: [] }, differentials: [{ name, reason: "异常子宫出血需排除内膜病变", distinguishingPoints: "周期缩短经量增多，需内膜评估", nextCheck: "内膜厚度评估，必要时活检" }] },
    pathogenesis: { chain: [] },
  }), "主诉：月经量多3个月")).westernDiagnosis.differentials.map((item) => item.name);
  await check("9.1 「子宫内膜增生/恶变」→ 子宫内膜增生、子宫内膜恶变；「胃溃疡/恶变」→ 胃溃疡、胃溃疡恶变；不留孤零零的「恶变」", () => {
    assert.deepEqual(split("子宫内膜增生/恶变"), ["子宫内膜增生", "子宫内膜恶变"]);
    assert.deepEqual(split("胃溃疡/癌变"), ["胃溃疡", "胃溃疡癌变"]);
  });
  await check("9.2 对照：借部位的旧拆法不变（泌尿系结石/感染、颅内占位/肿瘤）；两个独立病名照常拆", () => {
    assert.deepEqual(split("泌尿系结石/感染"), ["泌尿系结石", "泌尿系感染"]);
    assert.deepEqual(split("颅内占位/肿瘤"), ["颅内占位", "颅内肿瘤"]);
    assert.deepEqual(split("子宫肌瘤/子宫腺肌病"), ["子宫肌瘤", "子宫腺肌病"]);
  });
}

// ── 10 ── 「皮疹」与具体皮损形态：病历写了红斑、水疱时，鉴别行里不带主语的「无皮疹」说的是被鉴别的病（甲方标准病历 8）。
//         反证：RASH_SPECIFIC_FORM 换成不匹配任何字 ⇒ 10.1 变红。
{
  const visible = await lib("diagnosis-visible-summary.ts");
  const herpes = "主诉：左侧胁肋部疼痛5天\n现病史：三天前发现左侧胁肋部及腰背部出现片状红斑，其上可见米粒大小水疱，疼痛剧烈。";
  const plain = "主诉：左侧胁肋部疼痛5天\n现病史：左侧胁肋部针刺样疼痛，夜间加重。";
  const points = (record, text = "本例已出现皮节分布水疱，无皮疹") => unwrap(visible.groundDifferentialNegativeAssertions(wrap({
    stage: "diagnose", westernDiagnosis: { differentials: [{ name: "肋间神经痛", reason: "需排除其他原因神经痛", distinguishingPoints: text }] },
  }), record)).westernDiagnosis.differentials[0].distinguishingPoints;
  await check("10.1 病历有红斑、水疱：「无皮疹」补上被鉴别的病名（肋间神经痛无皮疹），不改成「病历未记录皮疹」；句中「、无皮疹」也不改成「未诉皮疹」", () => {
    assert.equal(points(herpes), "本例已出现皮节分布水疱，肋间神经痛无皮疹");
    assert.equal(visible.unrecordedNegativesAsNotReported("仅有神经痛，无皮疹、无发热", herpes), "仅有神经痛，无皮疹、未诉发热");
    assert.equal(points(herpes, "本例已出现皮节分布水疱，肋间神经痛无皮疹"), "本例已出现皮节分布水疱，肋间神经痛无皮疹", "幂等");
  });
  await check("10.2 对照：病历没有任何皮损时照旧（「病历未记录皮疹…」/「未诉皮疹」）；写了主语「本例无皮疹」时不补病名", () => {
    assert.match(points(plain), /病历未记录皮疹/);
    assert.equal(visible.unrecordedNegativesAsNotReported("仅有神经痛，无皮疹、无发热", plain), "仅有神经痛，未诉皮疹、发热");
    assert.doesNotMatch(points(herpes, "本例无皮疹"), /肋间神经痛无皮疹/);
  });
}

// ── 11 ── 功能性肠病的儿童病程门槛与报警征象（留出例 S161、S058）。反证：功能性便秘条目改回成人 6 个月、可按临床诊断 ⇒ 11.1 变红；
//         核对提示词删掉儿童标准与结肠镜一句 ⇒ 11.2 变红。
{
  const criteria = await lib("western-diagnostic-criteria.server.ts");
  const check11 = await lib("western-name-evidence-check.server.ts");
  await check("11.1 要点表：功能性便秘写明儿童病程满1个月、50岁及以上或有报警征象需结肠镜；「儿童功能性便秘」「慢性功能性便秘」都查得到", () => {
    for (const name of ["儿童功能性便秘", "慢性功能性便秘", "小儿功能性便秘"]) {
      const entry = criteria.westernCriteriaEntry(name);
      assert.equal(entry?.name, "功能性便秘", name);
    }
    const entry = criteria.westernCriteriaEntry("功能性便秘");
    assert.match(entry.durationThreshold, /未满18岁[^；]*病程满1个月/);
    assert.equal(entry.clinicallyDiagnosable, false);
    assert.match(entry.requiredTests.join(""), /50岁及以上起病[^；]*结肠镜/);
    assert.match(criteria.westernCriteriaEntry("肠易激综合征").durationThreshold, /未满18岁[^；]*满2个月/);
    assert.match(criteria.westernCriteriaEntry("功能性消化不良").durationThreshold, /未满18岁[^；]*满2个月/);
    assert.equal(criteria.westernCriteriaEntry("小儿功能性腹痛")?.name, "小儿功能性腹痛", "对照：表里本来就有的儿童病名按原名查");
  });
  const savedFetch = globalThis.fetch;
  try {
    await check("11.2 核对提示词：儿童按罗马IV儿童门槛、不得套成人6个月；功能性便秘与肠易激综合征50岁及以上或报警征象需结肠镜；条件式必需检查只在符合条件时要求", async () => {
      let body = "";
      globalThis.fetch = async (url, init) => { body = String(init?.body || ""); return completion({ verdict: "consistent", type: "", quote: "", reason: "", supportedName: "" }); };
      await check11.westernNameCorrectionForRecord({ recordText: "主诉：大便干结3个月\n现病史：患儿9岁，3个月来大便干结如羊粪，4～5日一行。", diagnosisName: "儿童功能性便秘", patient: { sex: "男", age: 9 } });
      const messages = JSON.parse(body).messages;
      assert.match(messages[0].content, /未满18岁的患者按罗马IV儿童标准，功能性便秘满1个月/);
      assert.match(messages[0].content, /50岁及以上起病、或有报警征象[^；]*没有结肠镜结果就属 D/);
      assert.match(messages[0].content, /只在本例符合该条件时才要求这项检查/);
      assert.match(messages[1].content, /未满18岁（罗马IV儿童标准）：病程满1个月/, "儿童病名查到的要点表进了核对输入");
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
}

// ── 11b ── D 类理由自相矛盾（说门槛已满足）时不采信；病历写明外院已做相关检查且未见异常时按已有结果对待（甲方标准病历 2）。
//          反证：去掉自相矛盾判据 ⇒ 11.3 变红；删掉提示词「…即使没有逐项列出…不适用 D」⇒ 11.4 变红。
{
  const check11b = await lib("western-name-evidence-check.server.ts");
  const record = "主诉：大便干结3个月\n现病史：患儿9岁，3个月来大便干结如羊粪，4～5日一行，无便血。";
  const d = (reason) => check11b.parseWesternNameCorrection(JSON.stringify({ verdict: "inconsistent", type: "D", quote: "3个月来大便干结如羊粪", reason, supportedName: "便秘待查" }), record, "儿童功能性便秘");
  await check("11.3 D 类理由说门槛已满足时不采信；说未满、尚缺时照常（对照）", () => {
    assert.equal(d("儿童需病程满1个月，病历3个月已满足；无便血，符合"), undefined);
    assert.equal(d("病程未满1个月，不足以诊断")?.type, "D");
    assert.equal(d("尚缺结肠镜结果，虽符合症状标准")?.type, "D");
  });
  const savedFetch = globalThis.fetch;
  try {
    await check("11.4 核对提示词：病历写明外院已完善相关检查、未见异常的，按已有检查结果对待，不适用 D", async () => {
      let body = "";
      globalThis.fetch = async (url, init) => { body = String(init?.body || ""); return completion({ verdict: "consistent", type: "", quote: "", reason: "", supportedName: "" }); };
      await check11b.westernNameCorrectionForRecord({ recordText: "主诉：心悸1月\n现病史：曾于心内科完善相关检查后未见明显异常。", diagnosisName: "心脏神经症" });
      assert.match(JSON.parse(body).messages[0].content, /即使没有逐项列出、未见报告原件，也按已有检查结果对待，不适用 D/);
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
}

// ── 12 ── D 类原病名那条鉴别的「建议核实」写具体检查（留出集 8 例「完善确诊所需检查」）。
//         反证：westernDifferentialNextCheck 改回恒返回通用句 ⇒ 12.1 变红。
{
  const check12 = await lib("western-name-evidence-check.server.ts");
  const record = "主诉：上腹隐痛半年\n现病史：上腹隐痛半年，伴嗳气。";
  const d = (extra) => check12.parseWesternNameCorrection(JSON.stringify({ verdict: "inconsistent", type: "D", quote: "上腹隐痛半年", reason: "未行胃镜检查", supportedName: "消化不良", ...extra }), record, "慢性胃炎");
  const nextCheckOf = (correction, previous = "慢性胃炎") => JSON.parse(check12.applyWesternNameCorrection(JSON.stringify({ westernDiagnosis: { primary: { name: previous }, differentials: [], candidates: [{ name: previous, likelihood: "中" }] } }), correction)).westernDiagnosis.differentials[0].nextCheck;
  await check("12.1 核对给了缺的检查就写它（结肠镜）；没给时要点表里只有一项必需检查就用它（慢性胃炎→胃镜）", () => {
    assert.equal(nextCheckOf(d({ missingTest: "结肠镜" })), "结肠镜");
    assert.equal(nextCheckOf(d({})), "胃镜");
  });
  await check("12.3 区分要点里说缺哪项检查的「无…结果」改成「尚缺…」，不留给鉴别净化当否认（留出例 S058「未诉结肠镜结果」）", () => {
    const c = check12.parseWesternNameCorrection(JSON.stringify({ verdict: "inconsistent", type: "D", quote: "上腹隐痛半年", reason: "76岁起病，无结肠镜结果，需排除器质性病变", supportedName: "便秘待查", missingTest: "结肠镜" }), record, "慢性功能性便秘");
    const row = JSON.parse(check12.applyWesternNameCorrection(JSON.stringify({ westernDiagnosis: { primary: { name: "慢性功能性便秘" }, differentials: [], candidates: [] } }), c)).westernDiagnosis.differentials[0];
    assert.equal(row.distinguishingPoints, "76岁起病，尚缺结肠镜结果，需排除器质性病变");
    assert.equal(row.nextCheck, "结肠镜");
  });
  await check("12.2 对照：表里列了好几项必需检查时不替核对挑（缺铁性贫血）；缺失项不合规（带括号、过长）时不采用", () => {
    assert.equal(nextCheckOf(check12.parseWesternNameCorrection(JSON.stringify({ verdict: "inconsistent", type: "D", quote: "上腹隐痛半年", reason: "未查铁代谢", supportedName: "贫血" }), record, "缺铁性贫血"), "缺铁性贫血"), "完善确诊所需检查");
    assert.equal(d({ missingTest: "胃镜（必要时活检）" }).missingTest, undefined);
    assert.equal(d({ missingTest: "胃镜".repeat(13) }).missingTest, undefined);
    assert.equal(check12.parseWesternNameCorrection(JSON.stringify({ verdict: "inconsistent", type: "B", quote: "上腹隐痛半年", reason: "记录与诊断不符", supportedName: "腹痛待查", missingTest: "胃镜" }), record, "慢性胃炎")?.missingTest, undefined, "只有 D 类带缺失检查");
  });
}

const failed = results.filter((item) => !item.ok);
console.log(JSON.stringify({ suite: "r1019-western", total: results.length, passed: results.length - failed.length, failed }, null, 1));
process.exit(failed.length ? 1 : 0);
