// 10/21 第十二轮（用户：第 6 项中成药先不做，其余都做完）。
//
//   1 贫血分度按病历 Hb 读数重算（留出例 S032：Hb 92 g/L 交付为「中度贫血」）。国内成人分度 >90 轻、61–90 中、31–60 重、≤30 极重；
//     对照：妊娠、6 月龄以下、多个读数分度不一、读数≥130、「既往/曾」读数、不带单位的小读数都不改；g/dL 换算。
//   2 否认与病历相反的那一项删掉（留出例 S058：病历「腹中冷痛」，依据与鉴别写「未诉腹痛」）。病历肯定写着（原词/同义/部位+症状隔一两字）
//     且没否认才删；整句删空时连带悬空的「与X相区分」。对照：带程度限定的否认、推断、口不渴、阵发性燥热、流水红肿、恶梦和心悸、
//     否认句里的表现、「腰部疼痛不明显」、手心发热之于发热，都不删。语料回放（17,220 份病历 × 20 个症状）见 ~/runlogs/r1018/work/r1024/probe。
//   3 不给剂量时复诊按原因写节点（验收 S 集「随访可操作」）；给剂量的「服完本次的药后复诊」补上剂数与天数。
//   4 加减：规整阶段判「模型条件式加减」也带上方中药名（甲方病历 7：清胃散已含大黄、石膏、知母，教材两条加减都用不上，
//     模型写的条件式加减却在规整阶段被判「触发条件不能回溯」丢光，约每 3 次 1 次加减为空）。对照：教材加减仍可用时照旧不认。
//   5 兼证判据：《中医诊断学》辨证要点（特异表现 + 共见类症状，扣除主证教材证型自己的表现）；撤兼证连带只属于它的治法与「兼X」字样；
//     同头治法两项合一（健脾和胃 + 健脾益气 → 健脾益气和胃）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const check = async (name, run) => {
  cases += 1;
  await run();
  console.log(`  ok ${name}`);
};

const surface = await jiti.import("../src/lib/delivered-surface.ts");
const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const phrasing = await jiti.import("../src/lib/tcm-therapy-phrasing.ts");
const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const secondary = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");

console.log("1 贫血分度");
await check("1.1 Hb 92 g/L 的中度贫血改轻度；血红蛋白、HGB、g/dL 写法同样读", async () => {
  assert.equal(surface.regradedAnemiaName("中度贫血", "女，45岁。乏力2月。血常规：Hb 92g/L，MCV 72fl。", 45), "轻度贫血");
  assert.equal(surface.regradedAnemiaName("中度缺铁性贫血", "血红蛋白92 g/L", 30), "轻度缺铁性贫血");
  assert.equal(surface.regradedAnemiaName("轻度贫血", "HGB：58g/L", 50), "重度贫血");
  assert.equal(surface.regradedAnemiaName("重度贫血", "血红蛋白 9.2g/dl", 50), "轻度贫血");
  assert.equal(surface.regradedAnemiaName("中度贫血", "Hb 28g/L", 50), "极重度贫血");
});
await check("1.2 对照：分度一致、妊娠、6 月龄以下、读数分度不一、读数≥130、不带单位的小读数、病名没写分度 —— 不改", async () => {
  assert.equal(surface.regradedAnemiaName("重度贫血", "Hb：55g/L", 60), "重度贫血");
  assert.equal(surface.regradedAnemiaName("中度贫血", "孕28周，Hb 92g/L", 30), "中度贫血");
  assert.equal(surface.regradedAnemiaName("中度贫血", "Hb 92g/L", 0.3), "中度贫血");
  assert.equal(surface.regradedAnemiaName("中度贫血", "Hb 85g/L，复查Hb 95g/L", 50), "中度贫血");
  assert.equal(surface.regradedAnemiaName("中度贫血", "Hb 135g/L", 40), "中度贫血");
  assert.equal(surface.regradedAnemiaName("中度贫血", "Hb 9.2", 40), "中度贫血");
  assert.equal(surface.regradedAnemiaName("缺铁性贫血", "Hb 92g/L", 40), "缺铁性贫血");
});
await check("1.3 「既往/曾」的读数不收；只看本次", async () => {
  assert.equal(surface.regradedAnemiaName("中度贫血", "既往Hb 70g/L，本次复查Hb 95g/L", 50), "轻度贫血");
});
await check("1.4 交付面投影：主诊断、候选、鉴别同一口径", async () => {
  const reasoning = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "气血两虚证", primarySyndromeResolution: "bounded" },
    pathogenesis: { chain: [{ patientFact: "乏力" }] },
    westernDiagnosis: { primary: { name: "中度缺铁性贫血", supportingFacts: [] }, candidates: [{ name: "中度缺铁性贫血" }, { name: "中度贫血" }], differentials: [{ name: "中度巨幼细胞性贫血", reason: "x" }] },
    therapy: { overallMethod: "益气养血" },
  };
  const out = surface.projectDeliveredReasoning(reasoning, { recordText: "乏力2月，血红蛋白92g/L。", herbBoundaryAudience: { reproductive: false, ageYears: 52 } });
  assert.equal(out.westernDiagnosis.primary.name, "轻度缺铁性贫血");
  assert.equal(out.westernDiagnosis.candidates[1].name, "轻度贫血");
  assert.equal(out.westernDiagnosis.differentials[0].name, "轻度巨幼细胞性贫血");
});

console.log("2 否认与病历相反");
const s058 = "排便困难2年，4～5日一行，腹中冷痛、热敷后舒服，小便清长，腰膝酸冷。无恶心呕吐。舌淡，苔白，脉沉迟。";
await check("2.1 S058：「未诉腹痛」删掉，连带悬空的「与肠结相区分」；鉴别要点只有这一句时删空（页面改显示理由）", async () => {
  assert.equal(visible.withoutDenialsOfRecordedFindings("以排便困难、4～5日一行为主症，病程2年，属慢性大肠传导失常，归便秘；未诉腹痛，与肠结相区分。", s058),
    "以排便困难、4～5日一行为主症，病程2年，属慢性大肠传导失常，归便秘。");
  assert.equal(visible.withoutDenialsOfRecordedFindings("未诉腹痛", s058), "");
  assert.equal(visible.withoutDenialsOfRecordedFindings("本例无腹痛、无呕吐，与肠结相区分", s058), "本例无呕吐，与肠结相区分");
});
await check("2.2 病历原词或受治理同义写法肯定写着时删：无发热/无咳嗽对「发热3天，咳嗽」", async () => {
  assert.equal(visible.withoutDenialsOfRecordedFindings("无发热，无咳嗽", "发热3天，咳嗽。"), "");
  assert.equal(visible.withoutDenialsOfRecordedFindings("本例未诉胁痛，故与胁痛相鉴别", "右胁肋疼痛2年，持续性胀痛。"), "");
});
await check("2.3 对照：带程度限定的否认、推断、否认句、病历也否认了的、描述被鉴别的病，都不删", async () => {
  for (const [text, record] of [
    ["无剧烈腹痛", s058],
    ["示无里热", "大便干结，口渴。"],
    ["无恶心呕吐", s058],
    ["肠结常见腹痛，本例无此表现", s058],
    ["无腹痛", "腹中冷痛，后来无腹痛。"],
  ]) assert.equal(visible.withoutDenialsOfRecordedFindings(text, record), text, `${text} | ${record}`);
});
await check("2.4 「部位+症状」隔字写法的构词式守卫：腹中冷痛、腰酸痛、胁肋疼痛算；口不渴、阵发性燥热、流水红肿、恶梦和心悸、否认句里的、不明显的不算", async () => {
  for (const [term, record] of [["腹痛", "腹中冷痛"], ["腰痛", "腰酸痛，乏力"], ["胁痛", "两胁时胀痛不适"], ["腹胀", "腹部胀大，尿少"]]) {
    assert.equal(visible.recordAffirmsDeniedFinding(record, term), true, `${term} ← ${record}`);
  }
  for (const [term, record] of [["口渴", "口不渴，大便调"], ["发热", "阵发性燥热感10年"], ["水肿", "皮疹痒，抓破流水红肿"], ["恶心", "频繁恶梦和心悸不适"],
    ["腹痛", "病程中也没有头痛、胸腹疼痛等不适"], ["腰痛", "夜间疼痛加剧，腰部疼痛不明显"], ["发热", "手心脚心发热，盗汗"]]) {
    assert.equal(visible.recordAffirmsDeniedFinding(record, term), false, `${term} ← ${record}`);
  }
});

console.log("3 不给剂量时的复诊节点");
const caseState = (record, extra = {}) => ({
  id: "r1024", chiefComplaint: record.split("。")[0], patient: { sex: "女", age: 30 }, symptoms: { 现病史: record }, vitals: {},
  conversation: [], phase: "prescribe", questionRounds: 1, maxQuestionRounds: 1, ...extra,
});
await check("3.1 原因类别与扣剂量同一判据：妊娠、哺乳、抗凝、儿童年龄不明、专科评估；给剂量的病例为 undefined", async () => {
  assert.equal(safety.doseWithheldFollowupKind(caseState("胃脘胀痛3天。妊娠已6个月。")), "pregnancy");
  assert.equal(safety.doseWithheldFollowupKind(caseState("咳嗽5天。产后2月，哺乳中。")), "lactation");
  assert.equal(safety.doseWithheldFollowupKind(caseState("头晕1周。长期口服华法林。")), "anticoagulant");
  assert.equal(safety.doseWithheldFollowupKind(caseState("咳嗽3天。慢性肾功能不全，肌酐升高。")), "specialist");
  assert.equal(safety.doseWithheldFollowupKind(caseState("患儿咳嗽3天。", { patient: { sex: "男" } })), "pediatric_age");
});
await check("3.2 不给剂量的复诊句按原因写节点；已写过的换成新的、幂等；红旗写今天", async () => {
  const pregnant = surface.followupWhenDoseWithheld("请服完本次的药后复诊；如出现腹痛请立即就医。", "withheld", "pregnancy");
  assert.match(pregnant, /^请在3天内到产科或中医妇科面诊/);
  assert.equal(surface.followupWhenDoseWithheld(pregnant, "withheld", "pregnancy"), pregnant, "幂等");
  const old = "请先到医院就诊，由医生完成评估并确定能否用药、怎么用药后，再按医生安排复诊。如出现高热请急诊。";
  assert.match(surface.followupWhenDoseWithheld(old, "withheld", "anticoagulant"), /^请带上正在服用的抗凝或抗血小板药，在3天内.*服药后1周内复查凝血指标/);
  assert.doesNotMatch(surface.followupWhenDoseWithheld(old, "withheld", "anticoagulant"), /按医生安排复诊/);
  assert.match(surface.followupWhenDoseWithheld("注意休息。", "red_flag", "red_flag"), /^请今天就到医院急诊/);
});
await check("3.3 给剂量的方：「请服完本次的药后复诊」补剂数与天数；取不到数时原样", async () => {
  assert.equal(surface.followupWithDoseCount("请服完本次的药后复诊；如有不适请提前复诊。", 7, 7), "请在服完7剂药后（约7天后）复诊；如有不适请提前复诊。");
  assert.equal(surface.followupWithDoseCount("请服完本次的药后复诊。", undefined, 7), "请服完本次的药后复诊。");
  assert.equal(surface.followupWithDoseCount("请在服完7剂药后（约7天后）复诊。", 7, 7), "请在服完7剂药后（约7天后）复诊。");
});
await check("3.4 开方阶段投影：不给剂量按原因改写；给剂量按方剂的剂数补天数", async () => {
  const prescribe = (followUpAfterDoses) => ({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "x", herbs: [], decoction: { followUpAfterDoses, followUpAfterDays: followUpAfterDoses } }], patentAndWestern: [], modifications: [] },
    management: { followupSafetyNet: "请服完本次的药后复诊；如出现高热请立即就医。" },
  });
  assert.match(surface.projectDeliveredReasoning(prescribe(5), {}).management.followupSafetyNet, /^请在服完5剂药后（约5天后）复诊/);
  assert.match(surface.projectDeliveredReasoning(prescribe(5), { doseWithheld: "withheld", doseWithheldKind: "lactation" }).management.followupSafetyNet, /^请在3天内到医院面诊，由医生确认哺乳情况/);
});

console.log("4 加减：规整阶段带上方中药名");
const tooth = ReasoningV2Schema.parse({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "牙痛", primarySyndrome: "胃火上炎证", overallPathogenesis: "胃火炽盛，循经上炎", recommendedFormulaNames: ["清胃散"], formulaSelectionMode: "named_formula", primarySyndromeBasis: ["牙龈肿胀", "渴喜冷饮"] },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "右侧下牙持续性胀痛", syndromeEvidence: "牙龈肿胀", pathogenesis: "胃火上炎", therapyDirection: "清胃泻火" }] },
  therapy: { overallPrinciple: "实则泻之", overallMethod: "清胃泻火，凉血消肿", subTherapies: [{ therapy: "清胃泻火", targetPathogenesis: "胃火上炎", priority: "主要" }] },
  formula: { candidates: [], patentAndWestern: [], modifications: [] },
});
const toothProposal = (herbNames) => ({
  candidate: {
    name: "清胃散加减", applicable: "", notApplicable: "",
    herbs: herbNames.map((name, index) => ({ name, dose: "10g", role: index === 0 ? "君" : "臣", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "清胃泻火", processing: null, isToxic: false, decoctionRequirement: null })),
    formulaAnalysis: `${herbNames.join("、")}共奏清胃泻火之功。`,
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，水煎分两次温服", followUpNode: "5日复诊" },
  },
  patentAndWestern: [],
  modifications: [{ actionType: "add", trigger: "若牙龈出血", targetRef: "P1", herbName: "白茅根", dose: "15g", reason: "凉血止血" }],
  nonPharma: { diet: "清淡饮食。", lifestyle: "规律作息。", emotion: "调畅情志。", precautions: ["忌辛辣。"], tcmTreatments: [] },
});
await check("4.1 教材两条加减的药（大黄、石膏、知母）都已在方中：模型条件式加减「若牙龈出血加白茅根」保留", async () => {
  const reasoning = compiler.compileM04Proposal(toothProposal(["黄连", "升麻", "生地黄", "牡丹皮", "当归", "大黄", "石膏", "知母"]), tooth);
  assert.ok(reasoning);
  const herbs = reasoning.formula.modifications.map((item) => item.herbName);
  assert.ok(herbs.includes("白茅根"), JSON.stringify(reasoning.formula.modifications));
});
await check("4.2 对照：教材加减还用得上（方中没有大黄）时，模型自写的条件式加减照旧不认", async () => {
  const reasoning = compiler.compileM04Proposal(toothProposal(["黄连", "升麻", "生地黄", "牡丹皮", "当归", "石膏", "知母"]), tooth);
  const herbs = reasoning.formula.modifications.map((item) => item.herbName);
  assert.ok(!herbs.includes("白茅根"), JSON.stringify(reasoning.formula.modifications));
  assert.equal(reasoning.formula.modificationReview.droppedReasons[0]?.code, "trigger_not_current_fact");
});
await check("4.3 规整阶段的判据带上了方中药名", async () => {
  const source = readFileSync(new URL("../src/lib/m04-proposal-compiler.ts", import.meta.url), "utf8");
  assert.match(source, /modificationTriggerGroundedInM03\(trigger, prior, \[\.\.\.prescribedNameByIdentity\.values\(\)\]\)/);
});

console.log("5 兼证判据与治法合并");
await check("5.1 证名查《中医诊断学》条目：原名、同义名、「X不足证/X亏虚证」；表里有行号与原文", async () => {
  assert.equal(secondary.diagnosticsCriteriaFor("脾气虚证")?.name, "脾气虚证");
  assert.equal(secondary.diagnosticsCriteriaFor("脾虚证")?.name, "脾气虚证");
  assert.equal(secondary.diagnosticsCriteriaFor("津亏证")?.name, "津液亏虚证");
  assert.equal(secondary.diagnosticsCriteriaFor("心气不足证")?.name, "心气虚证");
  assert.equal(secondary.diagnosticsCriteriaFor("风邪证")?.name, "风淫证");
  assert.equal(secondary.diagnosticsCriteriaFor("不存在证"), undefined);
  assert.equal(secondary.diagnosticsCriteriaFor("肝火上炎证")?.name, "肝火炽盛证", "书中写明「肝火炽盛证又名肝火上炎证」");
  assert.equal(secondary.diagnosticsCriteriaFor("湿热内蕴证")?.name, "湿热证");
  assert.deepEqual(secondary.diagnosticsCriteriaFor("湿热内蕴证")?.components, ["湿淫证", "热证"]);
  const spleen = secondary.diagnosticsCriteriaFor("脾气虚证");
  assert.equal(spleen.keyPointsText, "纳少、腹胀、便溏与气虚症状共见。");
  assert.deepEqual(spleen.specific, ["纳少", "腹胀", "便溏"]);
  assert.deepEqual(spleen.categoryEntries, ["气虚证"]);
  assert.ok(spleen.line > 0);
});
await check("5.2 判定：特异表现 + 共见类症状够数才立；与主证教材表现相同的不算（独立成组）", async () => {
  const spleen = secondary.diagnosticsCriteriaFor("脾气虚证");
  const record = "胸闷如压，痰多气短，身体沉重。疲倦乏力，不想吃饭，大便偏稀，少气懒言。舌淡苔白腻，脉滑。";
  const matches = [
    { item: "纳少", quote: "不想吃饭" }, { item: "便溏", quote: "大便偏稀" }, { item: "少气懒言", quote: "少气懒言" },
  ];
  assert.equal(secondary.evaluateCriteriaMatches(spleen, matches, { recordText: record, primaryTerms: ["胸闷如窒", "痰多气短"] }).verdict, "pass");
  assert.equal(secondary.evaluateCriteriaMatches(spleen, matches.slice(0, 2), { recordText: record, primaryTerms: [] }).verdict, "fail", "缺共见的气虚症状");
  assert.equal(secondary.evaluateCriteriaMatches(spleen, matches, { recordText: record, primaryTerms: ["少气懒言", "大便偏稀"] }).verdict, "fail", "两条是主证自己的表现");
  assert.equal(secondary.evaluateCriteriaMatches(spleen, [{ item: "纳少", quote: "编造的表现" }, ...matches.slice(1)], { recordText: record, primaryTerms: [] }).verdict, "fail", "摘录须出自病历");
});
await check("5.2b 组合证（湿热）：湿与热两边各至少 1 条、合计至少 3 条；只有热象不立", async () => {
  const dampHeat = secondary.diagnosticsCriteriaFor("湿热内蕴证");
  const record = "头身困重，脘痞纳呆，口苦，小便短黄，大便干结，面赤，口渴欲饮。";
  const hot = [{ item: "小便短黄", quote: "小便短黄" }, { item: "面赤", quote: "面赤" }, { item: "口渴欲饮", quote: "口渴欲饮" }];
  assert.equal(secondary.evaluateCriteriaMatches(dampHeat, hot, { recordText: record, primaryTerms: [] }).verdict, "fail", "只有热象");
  assert.equal(secondary.evaluateCriteriaMatches(dampHeat, [...hot, { item: "肢体困重", quote: "头身困重" }], { recordText: record, primaryTerms: [] }).verdict, "pass");
});
await check("5.3 两三个字的摘录每个字都在主证某条表现里，算同一表现（头晕之于头痛而晕）", async () => {
  const qi = secondary.diagnosticsCriteriaFor("心气虚证");
  const record = "头痛而晕，心悸，自汗，动则加重。";
  const verdict = secondary.evaluateCriteriaMatches(qi, [{ item: "心悸怔忡", quote: "心悸" }, { item: "头晕目眩", quote: "头痛而晕" }, { item: "自汗", quote: "自汗" }], { recordText: record, primaryTerms: ["头痛而晕"] });
  assert.equal(verdict.category + verdict.listed, 1, JSON.stringify(verdict));
});
await check("5.4 撤下模型自写的兼证：兼证栏、只属于它的治法项、依据里的「兼X」一并去掉；主证的治法不动", async () => {
  const root = {
    overview: { primarySyndrome: "痰湿蕴肺证", secondarySyndromes: ["气虚证"], tcmDiagnosticRationale: "咳嗽痰多色白，胸闷，为痰湿蕴肺；病性属痰湿兼气虚，舌苔白腻、脉濡滑支持痰湿内盛。", overallPathogenesis: "脾失健运，痰湿内生，上贮于肺" },
    therapy: { overallMethod: "燥湿化痰，理气止咳，健脾益气" },
  };
  assert.equal(secondary.withdrawSecondarySyndrome(root, "气虚证", "燥湿化痰，理气止咳"), true);
  assert.deepEqual(root.overview.secondarySyndromes, []);
  assert.equal(root.therapy.overallMethod, "燥湿化痰，理气止咳");
  assert.doesNotMatch(root.overview.tcmDiagnosticRationale, /兼气虚/);
  assert.match(root.overview.tcmDiagnosticRationale, /病性属痰湿/);
});
await check("5.5 同头治法两项合一；三项同头、不同头、不足四字的不合", async () => {
  assert.equal(phrasing.withoutRedundantTherapyPhrases("燥湿化痰，理气止咳，健脾和胃，健脾益气"), "燥湿化痰，理气止咳，健脾益气和胃");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("滋养肝肾，平肝潜阳，活血通窍，活血化瘀"), "滋养肝肾，平肝潜阳，活血化瘀通窍");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("清肠化湿，调气和血，清热解毒，清热生津"), "清肠化湿，调气和血，清热解毒生津");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("清热利湿，清热解毒，清热凉血"), "清热利湿，清热解毒，清热凉血");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("疏肝理气，健脾和胃"), "疏肝理气，健脾和胃");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("和血通络，活血通络"), "和血通络", "原有的同义去重照旧");
});
await check("5.6 只属于兼证的治法项：含兼证要素用词、不含主证要素用词、不在主证教材治法里", async () => {
  assert.deepEqual(phrasing.therapyItemsOnlyFor("燥湿化痰，理气止咳，健脾和胃，健脾益气", "气虚证", "痰湿蕴肺证"), ["健脾益气"]);
  assert.deepEqual(phrasing.therapyItemsOnlyFor("清热润肠，行气通便，生津润燥", "津亏证", "燥热便秘"), [], "主证也有燥：拿不准，保留");
  assert.deepEqual(phrasing.therapyItemsOnlyFor("通阳泄浊，豁痰宣痹，健脾益气", "脾气虚证", "痰浊闭阻证", "健脾益气"), [], "主证教材治法里有");
});
await check("5.7 流程：模型自写的兼证与两条补立路径都过同一判据；开关与遥测在", async () => {
  const source = readFileSync(new URL("../src/lib/m03-secondary-syndrome-consistency.server.ts", import.meta.url), "utf8");
  assert.match(source, /verifySecondaryByCriteria\(text\(name\), \{ recordText: context\.recordText, primaryTerms \}, signal\)/);
  assert.match(source, /criteria = await verifySecondaryByCriteria\(decision\.secondarySyndrome/);
  assert.match(source, /CDSS_M03_SECONDARY_CRITERIA/);
  assert.match(source, /m03_secondary_criteria/);
});

console.log(`\nr1024 main: ${cases} checks passed`);
