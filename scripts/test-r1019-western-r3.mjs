// 10/19 西医诊断第三轮整改的断言（独立评审 local12 甲方标准病历与留出集；材料在仓库外 ~/runlogs/r1018/work/r1019/agentD/r3）。
// 每一节对应一个缺陷类；每条断言都有对照，反证清单见各节注释（把对应改动撤掉后本节必须变红）。
//
//   1 病程：从主诉读病程；病程已够门槛时不采信「病程不够」（S077「1年余」）；远不到门槛时原病名不进候选与鉴别（S055 5天、病历4 半月）
//   2 建议核实：缺病程时写可以开出的检查或记录（表里 courseNextCheck，儿童另有一项），不写「随访至病程满N个月」
//   3 停在单个症状上的改名一律带「待查」（S077「乏力」）
//   4 患者性别不可能有的病名不进西医候选与鉴别
//   5 紧张型头痛、偏头痛按 ICHD-3 数特征；反应性关节炎要前驱感染；这类按临床表现诊断的病判 D 时不留「原病名待查」（病历3、S079）；
//     西医半自己写成「反应性关节炎待查」的也按去掉待查的病名核对
//   6 A–C 类理由只说缺什么的不采信（离线回放 X-D-2062）
//   7 同义写法：病历「大便干结」「5天未解大便」时鉴别里的「无便秘」不改成「未诉便秘」（S055）；不寐/眠差、眩晕同理
//   8 接线：西医半收口先按性别过滤名单；提示词
//
// 跑法：npm run test:r1019-western-r3（或 npx jiti scripts/test-r1019-western-r3.mjs）。R1019_SRC 指向一份源码副本时用来跑反证
//（数据表按 process.cwd() 读，跑反证时 cwd 要设成副本根目录）。
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
const completion = (payload) => new Response(JSON.stringify({
  id: "t", object: "chat.completion", model: "deepseek-flash",
  choices: [{ index: 0, message: { role: "assistant", content: typeof payload === "string" ? payload : JSON.stringify(payload) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { headers: { "content-type": "application/json" } });
const inconsistent = (extra) => JSON.stringify({ verdict: "inconsistent", ...extra });

const nameCheck = await lib("western-name-evidence-check.server.ts");
const criteria = await lib("western-diagnostic-criteria.server.ts");
const criteriaFile = JSON.parse(fs.readFileSync(path.join(process.env.R1019_SRC ? path.dirname(SRC) : REPO, "src/data/western-diagnostic-criteria.source.json"), "utf8"));

// ── 1 ── 反证：① recordCourseDays 恒返回 undefined ⇒ 1.2、1.4 变红；② 删掉「病程已够门槛就不采信」一行 ⇒ 1.2 变红；
//          ③ far_below 不再去掉原病名 ⇒ 1.3 变红；④ 门槛不分成人儿童 ⇒ 1.5 变红；⑤ 理由带检查字样也按病程论 ⇒ 1.6 变红
{
  const s077 = "食少、乏力1年余\n患者1年多前因重症肺炎住院治疗近1个月，出院后一直未能恢复，吃得少";
  const s055 = "大便干结5天\n平素嗜食辛辣。5天未解大便，腹胀，口干口臭";
  await check("1.1 主诉病程：1年余、2+月、两个多月、半月、十余年、数月、「10年，加重3天」取最长；「3天1次」是频次；主诉没写时长时不猜", () => {
    const days = (text) => nameCheck.recordCourseDays(text);
    assert.deepEqual(days("食少、乏力1年余"), { lower: 365, upper: 730 });
    assert.deepEqual(days("头痛2+月"), { lower: 60, upper: 90 });
    assert.deepEqual(days("两个多月"), { lower: 60, upper: 90 });
    assert.deepEqual(days("胃痛半月"), { lower: 15, upper: 15 });
    assert.deepEqual(days("反复咳嗽10年，加重3天"), { lower: 3650, upper: 3650 });
    assert.equal(days("十余年").lower, 3650);
    assert.deepEqual(days("数月"), { lower: 60, upper: 270 });
    assert.deepEqual(days("大便3天1次"), undefined);
    assert.equal(days("主诉：胸闷1周\n现病史：10年前行阑尾切除术").lower, 7);
    assert.equal(days("乏力\n患者10年前行阑尾切除术"), undefined, "主诉没写时长");
  });
  await check("1.2 S077：主诉「1年余」，核对仍说「需持续超6个月」——不采信（不交付「乏力」，鉴别里也不出现「随访至病程满6个月」）；对照：主诉「4个月」照常采信", () => {
    const verdict = (record) => nameCheck.parseWesternNameCorrection(inconsistent({ type: "D", quote: "出院后一直未能恢复", reason: "感染后疲劳综合征需疲劳持续超6个月且功能明显受损，病历未记录功能受限程度", supportedName: "乏力", missingTest: "随访至病程满6个月" }), record, "感染后疲劳综合征");
    assert.equal(verdict(s077), undefined);
    const control = verdict("食少、乏力4个月\n患者4个月前因重症肺炎住院治疗近1个月，出院后一直未能恢复");
    assert.equal(control?.supportedName, "乏力待查");
    assert.equal(control?.course, "unmet");
    // 表里有结构化门槛的病同样：慢性失眠障碍 3 个月，主诉「失眠半年」
    assert.equal(nameCheck.parseWesternNameCorrection(inconsistent({ type: "D", quote: "入睡困难", reason: "病程未满3个月门槛", supportedName: "失眠" }), "失眠半年\n入睡困难", "慢性失眠障碍"), undefined);
  });
  await check("1.3 远不到门槛（5天、半月对6个月）：原病名不进候选与鉴别；对照：3个月对6个月照常留在鉴别里", () => {
    const apply = (record, current, reason) => {
      const c = nameCheck.parseWesternNameCorrection(inconsistent({ type: "D", quote: record.split("\n")[1].slice(0, 12), reason, supportedName: "便秘待查" }), record, current);
      const western = { primary: { name: current }, candidates: [{ name: current, likelihood: "高", keyEvidence: ["x"], againstEvidence: [] }, { name: "肠梗阻", likelihood: "低", keyEvidence: [], againstEvidence: [] }],
        differentials: [{ name: "肠梗阻", reason: "需排除", distinguishingPoints: "有排气", nextCheck: "腹部平片" }] };
      return { c, w: JSON.parse(nameCheck.applyWesternNameCorrection(JSON.stringify({ westernDiagnosis: western }), c)).westernDiagnosis };
    };
    const far = apply(s055, "功能性便秘", "病程仅5天，未达成人6个月门槛");
    assert.equal(far.c.course, "far_below");
    assert.equal(far.w.primary.name, "便秘待查");
    assert.ok(!far.w.differentials.some((d) => d.name === "功能性便秘"), JSON.stringify(far.w.differentials));
    assert.ok(!far.w.candidates.some((d) => d.name === "功能性便秘"), JSON.stringify(far.w.candidates));
    const near = apply("便秘3个月\n大便干结3个月，排便费力", "功能性便秘", "病程3个月，未满6个月门槛");
    assert.equal(near.c.course, "unmet");
    const row = near.w.differentials.find((d) => d.name === "功能性便秘");
    assert.ok(row, JSON.stringify(near.w.differentials));
    assert.equal(row.nextCheck, "排便日记，有报警征象时结肠镜");
    assert.ok(near.w.candidates.some((d) => d.name === "功能性便秘"));
  });
  await check("1.4 病历4：主诉「胃痛半月」的功能性消化不良 → 消化不良待查，远不到门槛", () => {
    const c = nameCheck.parseWesternNameCorrection(inconsistent({ type: "D", quote: "以胃脘胀痛为主", reason: "病程仅半月，未达6个月门槛", supportedName: "消化不良" }), "胃痛半月\n患者半月前与家人争吵后出现胃痛不适，以胃脘胀痛为主", "功能性消化不良");
    assert.equal(c?.supportedName, "消化不良待查");
    assert.equal(c?.course, "far_below");
  });
  await check("1.5 未满18岁按罗马IV儿童门槛（功能性便秘1个月）：9岁、3个月不采信「病程不够」；对照：不给年龄时按成人6个月照常采信", () => {
    const kid = "便秘3个月\n患儿3个月来大便干结";
    const verdict = (options) => nameCheck.parseWesternNameCorrection(inconsistent({ type: "D", quote: "患儿3个月来大便干结", reason: "需病程满6个月以上", supportedName: "便秘待查" }), kid, "儿童功能性便秘", options);
    assert.equal(verdict({ patientAge: 9 }), undefined);
    assert.equal(verdict({})?.course, "unmet");
  });
  await check("1.6 理由说缺检查的（76岁起病尚缺结肠镜）不按病程论：病程10年也照常采信；对照见 1.2", () => {
    const c = nameCheck.parseWesternNameCorrection(inconsistent({ type: "D", quote: "大便干结10年", reason: "便秘10年，76岁起病尚缺结肠镜排除器质性病变", supportedName: "便秘待查", missingTest: "结肠镜" }), "便秘10年\n76岁，大便干结10年", "慢性功能性便秘");
    assert.equal(c?.supportedName, "便秘待查");
    assert.equal(c?.course, undefined);
    assert.equal(c?.missingTest, "结肠镜");
  });
}

// ── 2 ── 反证：① isCleanMissingTest 不拦「随访…病程」⇒ 2.1 变红；② westernDifferentialNextCheck 不用 courseNextCheck ⇒ 2.2 变红；
//          ③ 删掉 courseNextCheckUnder18 一项 ⇒ 2.2 变红；④ 删掉某条门槛条目的 courseNextCheck ⇒ 2.3 变红
{
  const record = "胃胀3个月\n患者3个月前出现上腹胀满";
  const d = (extra, options) => nameCheck.parseWesternNameCorrection(inconsistent({ type: "D", quote: "患者3个月前出现上腹胀满", reason: "病程3个月，未满6个月门槛", supportedName: "消化不良待查", ...extra }), record, "功能性消化不良", options);
  await check("2.1 核对写「随访至病程满6个月」「观察至病程满2个月」不采用为建议核实；对照：「胃镜」照常采用", () => {
    assert.equal(d({ missingTest: "随访至病程满6个月" })?.missingTest, undefined);
    assert.equal(d({ missingTest: "观察至病程满2个月" })?.missingTest, undefined);
    assert.equal(d({ missingTest: "胃镜" })?.missingTest, "胃镜");
  });
  await check("2.2 缺病程时建议核实写表里的一项：成人功能性消化不良「胃镜」，6岁患儿「症状日记，有报警征象时胃镜」，功能性便秘「排便日记…」，肠易激「排便日记…」", () => {
    assert.equal(nameCheck.westernDifferentialNextCheck("功能性消化不良", d({ missingTest: "随访至病程满6个月" })), "胃镜");
    const child = nameCheck.parseWesternNameCorrection(inconsistent({ type: "D", quote: "患儿1个月前出现上腹胀满", reason: "病程1个月，未满2个月门槛", supportedName: "消化不良待查", missingTest: "胃镜" }), "胃胀1个月\n患儿1个月前出现上腹胀满", "功能性消化不良", { patientAge: 6 });
    assert.equal(child?.course, "unmet");
    assert.equal(nameCheck.westernDifferentialNextCheck("功能性消化不良", child), "症状日记，有报警征象时胃镜");
    const ibs = nameCheck.parseWesternNameCorrection(inconsistent({ type: "D", quote: "腹痛伴腹泻1月", reason: "病程1个月，未满6个月门槛", supportedName: "腹痛待查" }), "腹痛腹泻1月\n腹痛伴腹泻1月", "肠易激综合征");
    assert.equal(nameCheck.westernDifferentialNextCheck("肠易激综合征", ibs), "排便日记，记录腹痛与排便的关系");
  });
  await check("2.3 表里每条结构化病程门槛都带可开出的检查或记录（不含随访、病程、观察字样）；只收起病至今的门槛（偏头痛、慢支没有）", () => {
    const withCourse = criteriaFile.entries.filter((e) => e.courseThresholdDays);
    assert.ok(withCourse.length >= 15, String(withCourse.length));
    for (const e of withCourse) {
      assert.ok(typeof e.courseNextCheck === "string" && e.courseNextCheck.length >= 2 && !/随访|病程|观察|等待/u.test(e.courseNextCheck), e.name);
      assert.ok(e.durationThreshold, e.name);
    }
    for (const name of ["偏头痛", "慢性支气管炎", "闭经", "稳定型心绞痛"]) assert.equal(criteriaFile.entries.find((e) => e.name === name)?.courseThresholdDays, undefined, name);
    assert.equal(criteria.westernCriteriaEntry("儿童功能性便秘")?.courseThresholdDays?.under18, 30);
  });
}

// ── 3 ── 反证：删掉 bareSymptom 那一行（supported = named）⇒ 3.1 变红；symptomLevelWesternName 恒 false ⇒ 3.1、3.2 变红
{
  const record = "食少、乏力4个月\n患者4个月前出院后一直未能恢复，全身倦怠没有力气，关节疼痛";
  await check("3.1 改成单个症状时补「待查」：乏力→乏力待查、头痛→头痛待查、多关节痛→多关节痛待查；对照：牙痛、贫血、关节炎是病名不加", () => {
    const named = (supportedName, type = "D", reason = "尚缺相关检查") => nameCheck.parseWesternNameCorrection(inconsistent({ type, quote: "全身倦怠没有力气", reason, supportedName }), record, "某综合征")?.supportedName;
    assert.equal(named("乏力"), "乏力待查");
    assert.equal(named("头痛", "B", "记录与该病核心表现相反"), "头痛待查");
    assert.equal(named("多关节痛", "B", "记录与该病核心表现相反"), "多关节痛待查");
    // 第十轮起 D 类交回的名称须是原名的宽写、症状层或病历原有说法（这份病历讲的是乏力，「某综合征→牙痛」会改写原病名待查，见 test:r1022-main 3.x）；
    // 这里要钉的是「牙痛是病名、不补待查」，改用不受该约束的 B 类。
    assert.equal(named("牙痛", "B", "记录与该病核心表现相反"), "牙痛");
    assert.equal(named("贫血", "B", "记录与该病核心表现相反"), "贫血");
    assert.equal(named("关节炎", "B", "记录与该病核心表现相反"), "关节炎");
  });
  await check("3.2 症状判据：ICD-10 R 章与少数别章症状码（关节痛、颈痛、便秘）算；病名（牙痛、失眠、贫血、高血压）不算", () => {
    for (const name of ["乏力", "头痛", "消化不良", "关节痛", "颈痛", "便秘", "多关节痛"]) assert.equal(nameCheck.symptomLevelWesternName(name), true, name);
    for (const name of ["牙痛", "失眠", "贫血", "高血压", "关节炎", "月经稀发"]) assert.equal(nameCheck.symptomLevelWesternName(name), false, name);
  });
  await check("3.3 对照：只去掉病程限定的上一级（急性尿潴留→尿潴留）不加「待查」；症状名不算西医半名单里的采纳", () => {
    const c = nameCheck.parseWesternNameCorrection(inconsistent({ type: "B", quote: "小便点滴难出2年", reason: "病程2年，与急性起病不符", supportedName: "尿潴留待查" }), "排尿困难2年\n小便点滴难出2年", "急性尿潴留");
    assert.equal(c?.supportedName, "尿潴留");
    const adopted = nameCheck.parseWesternNameCorrection(inconsistent({ type: "A", quote: "全身倦怠没有力气", reason: "检查所见指向另一病，与原名不符", supportedName: "乏力" }), record, "某综合征", { listedNames: ["乏力", "甲减"] });
    assert.equal(adopted?.supportedName, "乏力待查");
    assert.equal(adopted?.adoptedFromList, undefined);
  });
}

// ── 4 ── 反证：① FEMALE_ONLY 改成不匹配 ⇒ 4.1 变红；② 去掉「病名写明男性」的例外 ⇒ 4.2 变红；③ alignWesternPrimaryAndName 不过滤 ⇒ 8.1 变红
{
  const western = { westernDiagnosis: { primary: { name: "腹痛待查" },
    candidates: [{ name: "腹痛待查" }, { name: "异位妊娠" }, { name: "急性阑尾炎" }],
    differentials: [{ name: "盆腔炎性疾病" }, { name: "卵巢囊肿蒂扭转" }, { name: "急性阑尾炎" }, { name: "前列腺炎" }, { name: "乳腺增生" }] } };
  const names = (content, key) => JSON.parse(content).westernDiagnosis[key].map((item) => item.name);
  await check("4.1 男性：妊娠、卵巢、盆腔炎等妇产科病名移出候选与鉴别；女性：前列腺类移出；主诊断不动", () => {
    const male = nameCheck.withoutSexIncompatibleWesternNames(JSON.stringify(western), "男");
    assert.deepEqual(names(male, "candidates"), ["腹痛待查", "急性阑尾炎"]);
    assert.deepEqual(names(male, "differentials"), ["急性阑尾炎", "前列腺炎", "乳腺增生"]);
    const female = nameCheck.withoutSexIncompatibleWesternNames(JSON.stringify(western), "女");
    assert.deepEqual(names(female, "differentials"), ["盆腔炎性疾病", "卵巢囊肿蒂扭转", "急性阑尾炎", "乳腺增生"]);
    assert.equal(JSON.parse(female).westernDiagnosis.primary.name, "腹痛待查");
    assert.equal(nameCheck.westernNameOutsidePatientSex("产后抑郁", "male"), true);
    assert.equal(nameCheck.westernNameOutsidePatientSex("睾丸炎", "F"), true);
  });
  await check("4.2 对照：乳腺病两性都留；病名写明男性的（男性更年期综合征）留给男性；新生儿胎粪吸入留；性别不明不判、原样返回", () => {
    assert.equal(nameCheck.westernNameOutsidePatientSex("乳腺增生", "男"), false);
    assert.equal(nameCheck.westernNameOutsidePatientSex("男性更年期综合征", "男"), false);
    assert.equal(nameCheck.westernNameOutsidePatientSex("新生儿胎粪吸入综合征", "男"), false);
    assert.equal(nameCheck.westernNameOutsidePatientSex("前列腺增生", "男"), false);
    const raw = JSON.stringify(western);
    assert.equal(nameCheck.withoutSexIncompatibleWesternNames(raw, "其他或未明确"), raw);
    assert.equal(nameCheck.withoutSexIncompatibleWesternNames(raw, undefined), raw);
  });
}

// ── 5 ── 反证：① 删掉紧张型头痛的 featureRule ⇒ 5.1 变红；② 删掉反应性关节炎条目 ⇒ 5.2 变红；③ keepHypothesis 不看 testDefined ⇒ 5.3 变红；
//          ④ westernCriteriaPromptValue 不带 featureRule/requiredHistory ⇒ 5.1、5.2 变红
{
  await check("5.1 紧张型头痛按 ICHD-3 数特征：要点表带 featureRule 与 ICHD-3 原文（四项至少两项）；给核对模型的参照里有 featureRule", () => {
    const entry = criteria.westernCriteriaEntry("紧张型头痛");
    assert.match(entry?.featureRule || "", /至少记录到两项/u);
    assert.ok(entry?.featureRuleQuote?.includes("At least two of the following four characteristics:"));
    assert.match(entry?.featureRuleUrl || "", /ichd-3\.org/u);
    assert.match(String(criteria.westernCriteriaPromptValue({ kind: "table", entry }).featureRule || ""), /ICHD-3/u);
    assert.match(criteria.westernCriteriaEntry("偏头痛")?.featureRule || "", /单侧、搏动性、中重度/u);
  });
  await check("5.2 反应性关节炎：新条目要前驱肠道或泌尿生殖道感染（MSD 原文逐字），参照里带 requiredHistory", () => {
    const entry = criteria.westernCriteriaEntry("反应性关节炎");
    assert.ok(entry, "条目缺失");
    assert.equal(entry.quote, "诊断主要基于临床表现，需要有典型的外周关节炎，以及前驱的消化道或泌尿道感染症状，或特征性的关节外表现。");
    assert.match(entry.requiredHistory || "", /腹泻|尿道炎/u);
    assert.deepEqual(entry.requiredTests, []);
    assert.match(String(criteria.westernCriteriaPromptValue({ kind: "table", entry }).requiredHistory || ""), /前驱症状/u);
  });
  await check("5.3 按临床表现诊断、没有必需检查的病判 D 时不留「原病名待查」：病历3 紧张型头痛→头痛待查，S079 反应性关节炎→关节痛待查；对照：多发性骨髓瘤（要检查）照常「原病名待查」", () => {
    const tth = nameCheck.parseWesternNameCorrection(inconsistent({ type: "D", quote: "呈隐痛，时发时止", reason: "未记录双侧、紧箍样等特征，不足两项", supportedName: "头痛待查" }), "头痛2+月\n两个多月前患者生产后出现头痛，呈隐痛，时发时止", "紧张型头痛");
    assert.equal(tth?.supportedName, "头痛待查");
    const rea = nameCheck.parseWesternNameCorrection(inconsistent({ type: "D", quote: "出现双肩、双肘、双膝及腕关节疼痛", reason: "无前驱肠道或泌尿生殖道感染记录", supportedName: "关节痛待查" }), "四肢多关节游走性疼痛2周\n出现双肩、双肘、双膝及腕关节疼痛", "反应性关节炎");
    assert.equal(rea?.supportedName, "关节痛待查");
    const mm = nameCheck.parseWesternNameCorrection(inconsistent({ type: "D", quote: "腰痛3个月伴贫血", reason: "尚缺血清蛋白电泳与骨髓检查", supportedName: "腰痛待查" }), "腰痛3个月\n腰痛3个月伴贫血", "多发性骨髓瘤");
    assert.equal(mm?.supportedName, "多发性骨髓瘤待查");
  });
}

// ── 5.4 ── 反证：alignWesternNameWithRecord 不再按去掉「待查」的病名核对（checkName 恒为原名）⇒ 5.4 变红
{
  const savedFetch = globalThis.fetch;
  let calls = 0;
  let reply = { verdict: "inconsistent", type: "D", quote: "出现双肩、双肘、双膝及腕关节疼痛", reason: "无前驱肠道或泌尿生殖道感染记录", supportedName: "关节痛待查", emergencyName: false };
  globalThis.fetch = async () => { calls += 1; return completion(reply); };
  try {
    const content = (primary, tag) => JSON.stringify({ westernDiagnosis: { primary: { name: primary },
      candidates: [{ name: primary, likelihood: "中", keyEvidence: ["受凉后多关节痛"], againstEvidence: [] }, { name: "病毒性关节炎", likelihood: "低", keyEvidence: [], againstEvidence: [] }],
      differentials: [{ name: "病毒性关节炎", reason: "需鉴别", distinguishingPoints: "低热", nextCheck: `查血常规${tag}` }] } });
    const record = (tag) => `四肢多关节游走性疼痛2周（${tag}）\n出现双肩、双肘、双膝及腕关节疼痛`;
    const out = JSON.parse(await nameCheck.alignWesternNameWithRecord(content("反应性关节炎待查", "a"), { recordText: record("a"), patient: { sex: "女", age: 39 } })).westernDiagnosis;
    const firstCalls = calls;
    const untouched = await nameCheck.alignWesternNameWithRecord(content("腹痛待查", "b"), { recordText: record("b"), patient: { sex: "女", age: 39 } });
    const callsAfterControl = calls;
    reply = { ...reply, supportedName: "反应性关节炎待查" };
    const same = content("反应性关节炎待查", "c");
    const echoed = await nameCheck.alignWesternNameWithRecord(same, { recordText: record("c"), patient: { sex: "女", age: 39 } });
    await check("5.4 「反应性关节炎待查」按「反应性关节炎」核对：前驱感染没有记录时交付「关节痛待查」，原病名（不带待查）进候选与鉴别；对照：「腹痛待查」不核对；核对给回原来的「X待查」时不改", () => {
      assert.equal(firstCalls, 2, "第十轮 B3：病名核对并行两次，一致才改名");
      assert.equal(out.primary.name, "关节痛待查");
      const row = out.differentials.find((d) => d.name === "反应性关节炎");
      assert.equal(row?.reason, "尚未取得确诊所需的检查或病程依据", JSON.stringify(out.differentials));
      assert.equal(row?.nextCheck, "追问起病前数周有无腹泻、尿道炎或结膜炎", "建议核实是可执行的临床动作，不是通用句");
      assert.ok(!JSON.stringify(out).includes("反应性关节炎待查"), JSON.stringify(out));
      assert.equal(callsAfterControl, firstCalls, "腹痛待查不发核对");
      assert.equal(JSON.parse(untouched).westernDiagnosis.primary.name, "腹痛待查");
      assert.equal(echoed, same);
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
}

// ── 6 ── 反证：删掉 A–C 只说缺什么的那一行 ⇒ 6.1 变红
{
  const record = "近2个月胸闷，乏力，咳嗽\n胸片：肺门及纵隔淋巴结肿大，结核菌素试验（1：10000）48小时观察（+++）。";
  await check("6.1 A 类理由只说「无抗酸染色/培养等病原学结果」（没有已记录的相反所见）不采信（X-D-2062）；对照：理由写「痰涂片阴性」的 A 照常采信", () => {
    assert.equal(nameCheck.parseWesternNameCorrection(inconsistent({ type: "A", quote: "近2个月胸闷，乏力，咳嗽", reason: "病历仅结核菌素强阳性，无抗酸染色/培养等病原学结果", supportedName: "胸闷待查" }), record, "肺结核"), undefined);
    assert.equal(nameCheck.parseWesternNameCorrection(inconsistent({ type: "A", quote: "近2个月胸闷，乏力，咳嗽", reason: "痰涂片阴性，不支持肺结核", supportedName: "胸闷待查" }), record, "肺结核")?.supportedName, "胸闷待查");
    assert.equal(nameCheck.parseWesternNameCorrection(inconsistent({ type: "D", quote: "近2个月胸闷，乏力，咳嗽", reason: "尚缺病原学结果", supportedName: "肺结核待查" }), record, "肺结核")?.supportedName, "肺结核待查", "D 类说缺什么是本分");
  });
}

// ── 7 ── 反证：① recordMentionsNegatedTerm 不查同义词组 ⇒ 7.1、7.2 变红；② groundClause 不认「写到过」⇒ 7.2 变红；
//          ③ 同义词组删掉「未解大便」「大便干结」⇒ 7.1、7.3 变红；④ 删掉「只从总称往下展开」⇒ 7.4 变红
{
  const visible = await lib("diagnosis-visible-summary.ts");
  const safety = await lib("diagnosis-safety.ts");
  const { normalizeCaseStateInput } = await lib("diagnosis-types.ts");
  const s055Record = "大便干结5天\n平素嗜食辛辣。5天未解大便，腹胀，口干口臭，面红，心烦，小便短赤。无腹痛、呕吐，肛门有排气。";
  await check("7.1 病历「大便干结5天」：句中的「无便秘」不改成「未诉便秘」；不寐/眠差之于失眠、眩晕之于头晕同理；对照：病历没写过时照常改成「未诉…」", () => {
    assert.equal(visible.unrecordedNegativesAsNotReported("当前用药情况未记录、无便秘。", s055Record), "当前用药情况未记录、无便秘。");
    assert.equal(visible.unrecordedNegativesAsNotReported("需与之鉴别，无便秘。", "腹泻3天\n大便稀溏"), "需与之鉴别，未诉便秘。");
    assert.equal(visible.unrecordedNegativesAsNotReported("伴心悸，无失眠。", "不寐3月\n夜寐差，入睡后易醒"), "伴心悸，无失眠。");
    assert.equal(visible.unrecordedNegativesAsNotReported("伴心悸，无失眠。", "心悸3月\n活动后加重"), "伴心悸，未诉失眠。");
    assert.equal(visible.unrecordedNegativesAsNotReported("伴恶心，无头晕。", "眩晕2天\n视物旋转"), "伴恶心，无头晕。");
  });
  // 2026-10-21 第十二轮：病历肯定写着的表现被写成「无X/未诉X」时，鉴别与依据里直接删掉这一项（diagnosis-visible-summary.withoutDenialsOfRecordedFindings，
  // 留出例 S058「腹中冷痛」对「未诉腹痛」）。此前这一项留给净化器改写成「病历已记录便秘阳性」，交付为「有便秘」——放在鉴别要点里读不出区分。
  // 净化器自身的改写口径不变（下面两条照旧钉它）。
  await check("7.2 S055：鉴别分句「无便秘」不改成「病历未记录便秘（…）」，病历肯定写着便秘时删掉这一项；对照：「无发热」病历没写照常改", () => {
    const state = normalizeCaseStateInput({ id: "S055", chiefComplaint: "大便干结5天", patient: { sex: "男", age: 36 }, symptoms: { 现病史: "平素嗜食辛辣。5天未解大便，腹胀，口干口臭，面红，心烦，小便短赤。无腹痛、呕吐，肛门有排气。" }, conversation: [] });
    const ctx = safety.clinicalGroundingText(state);
    const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", westernDiagnosis: { primary: { name: "便秘" }, differentials: [{ name: "药物性便秘", reason: "需排除药物因素", distinguishingPoints: "当前用药情况未记录，无便秘", nextCheck: "核对现用药物" }, { name: "肠梗阻", reason: "需排除", distinguishingPoints: "无发热", nextCheck: "腹部平片" }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
    const grounded = visible.groundDifferentialNegativeAssertions(content, ctx);
    const rows = JSON.parse(grounded.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]).westernDiagnosis.differentials;
    assert.equal(rows[0].distinguishingPoints, "当前用药情况未记录");
    assert.equal(rows[1].distinguishingPoints, "病历未记录发热（需问诊核实后方可用于排除）");
    // 2026-10-25 第二十轮起，病历肯定、模型否认的那一项由净化器直接删掉，不再改写成「病历已记录便秘阳性」。
    assert.equal(safety.sanitizeUngroundedRedFlagNegations("当前用药情况未记录，无便秘", state), "当前用药情况未记录");
    assert.doesNotMatch(safety.sanitizeUngroundedRedFlagNegations("当前用药情况未记录，未诉便秘", state), /未诉便秘|尚未确认便秘/u);
  });
  await check("7.3 同义词组是同一份受治理数据（导出 POSITIVE_FACT_EQUIVALENT_GROUPS）；粪质、单次未排、眩晕记作下位词：「否认大便干结」不等于否认便秘", () => {
    const group = (term) => safety.POSITIVE_FACT_EQUIVALENT_GROUPS.find((g) => g.includes(term)) || [];
    for (const form of ["大便干结", "大便秘结", "未解大便", "大便难"]) assert.ok(group("便秘").includes(form), form);
    for (const form of ["不寐", "眠差"]) assert.ok(group("失眠").includes(form), form);
    assert.ok(group("头晕").includes("眩晕"));
    for (const form of ["大便干结", "未解大便", "眩晕"]) assert.ok(safety.NARROWER_THAN_GROUP_CANONICAL.has(form), form);
    assert.equal(safety.sourceDocumentsNegation("否认大便干结", "便秘"), false);
    assert.equal(safety.sourceDocumentsNegation("否认大便秘结", "便秘"), true, "大便秘结与便秘同义");
  });
  await check("7.4 只从总称往下展开：病历写「发热」时「无高热」仍改成「未诉高热」（下位词没写过）；对照：病历写「低热」时「无发热」留着", () => {
    assert.equal(visible.unrecordedNegativesAsNotReported("咽痛，无高热。", "发热2天\n发热，咽痛"), "咽痛，未诉高热。");
    assert.equal(visible.unrecordedNegativesAsNotReported("情绪不宁，无发热。", "低热1月\n低热，热势随情绪起伏"), "情绪不宁，无发热。");
  });
}

// ── 8 ── 反证：① alignWesternPrimaryAndName 不先过滤 ⇒ 8.1 变红；② 提示词恢复「随访至病程满6个月」⇒ 8.2 变红；
//          ③ 提示词不写症状加待查、不带 featureRule 规则 ⇒ 8.2 变红
{
  const reselect = await lib("western-primary-reselect.server.ts");
  const prompts = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    prompts.push(body.messages);
    return completion({ verdict: "consistent", action: "keep" });
  };
  try {
    const western = { westernDiagnosis: { primary: { name: "急性阑尾炎", status: "考虑" },
      candidates: [{ name: "急性阑尾炎" }, { name: "异位妊娠" }], differentials: [{ name: "卵巢囊肿蒂扭转" }, { name: "急性胃肠炎" }, { name: "输尿管结石" }] } };
    const out = await reselect.alignWesternPrimaryAndName(JSON.stringify(western), { recordText: "右下腹痛8小时（r3-8.1）\n转移性右下腹痛，伴恶心", patient: { sex: "男", age: 25 } });
    await check("8.1 西医半收口先按性别过滤名单：男性的异位妊娠、卵巢囊肿蒂扭转不进交付，也不进核对与重选的名单", () => {
      const parsed = JSON.parse(out).westernDiagnosis;
      assert.deepEqual(parsed.candidates.map((c) => c.name), ["急性阑尾炎"]);
      assert.deepEqual(parsed.differentials.map((c) => c.name), ["急性胃肠炎", "输尿管结石"]);
      const sent = prompts.flat().filter((m) => m.role === "user").map((m) => String(m.content)).join("\n");
      assert.ok(prompts.length >= 1, "没有发出核对请求");
      assert.match(sent, /急性胃肠炎/u, "名单本身要发出去（否则上面的断言是空转）");
      assert.doesNotMatch(sent, /异位妊娠|卵巢囊肿蒂扭转/u);
    });
    prompts.length = 0;
    await nameCheck.westernNameCorrectionForRecord({ recordText: "头痛2+月（r3-8.2）\n两个多月前出现头痛，呈隐痛", diagnosisName: "紧张型头痛", patient: { sex: "女", age: 32 } });
    await check("8.2 提示词：缺病程写可开出的检查（不写「随访至病程满6个月」）；单个症状加待查；featureRule、requiredHistory 的计数口径；紧张型头痛的参照随请求发出", () => {
      const system = String(prompts[0]?.find((m) => m.role === "system")?.content || "");
      const user = String(prompts[0]?.find((m) => m.role === "user")?.content || "");
      assert.doesNotMatch(system, /缺的是病程时写“随访至病程满6个月”/u);
      assert.match(system, /不写“随访至病程满N个月”这类等待病程的说法/u);
      assert.match(system, /只剩单个症状时写成症状加“待查”/u);
      assert.match(system, /有 featureRule 的/u);
      assert.match(system, /有 requiredHistory 的/u);
      assert.match(user, /featureRule/u);
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
}

const failed = results.filter((item) => !item.ok);
console.log(JSON.stringify({ suite: "r1019-western-r3", total: results.length, passed: results.length - failed.length, failed }, null, 1));
process.exit(failed.length ? 1 : 0);
