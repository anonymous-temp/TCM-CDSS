// 第二十七轮（2026-10-27）：甲方会看到的「整页退成非剂量」「同一份响应两种说法」按类收口。
// 每条断言都有反证（~/runlogs/r1018/work/r1039/cp/）。
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
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const modificationSafety = await jiti.import("../src/lib/m04-modification-safety.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = (reasoning, visible = "") => `${visible}${START}\n${JSON.stringify(reasoning)}\n${END}`;
const unwrap = (content) => JSON.parse(content.slice(content.indexOf(START) + START.length, content.indexOf(END)));

// ---------- 1 方向对立的药：定稿剔除与终审同一判据 ----------
// 甲方 100 例 C068（急性盆腔炎·湿热蕴结，M03 锁仙方活命饮）：出血尚未排除，候选去乳香、没药后已是自拟方（不再声称方名）。
// 剔药按 M03 锁定方把白芷、皂角刺当基准保护，终审按候选自己的方名不豁免、按「温」与清热对立驳回，整页退成非剂量页（3 次生成 2 次）。
const c068Prior = {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "急性盆腔炎", primarySyndrome: "湿热蕴结证", secondarySyndromes: [], recommendedFormulaNames: ["仙方活命饮"], recommendedFormulaDirection: "仙方活命饮加减", formulaSelectionMode: "single" },
  therapy: { overallPrinciple: "热者寒之", overallMethod: "清热利湿，活血止痛，解毒止带", subTherapies: [
    { therapy: "清热利湿，行气止痛", targetPathogenesis: "湿热壅阻下焦，气血不通则痛", priority: "主要" },
    { therapy: "清热解毒，透热外出", targetPathogenesis: "热毒内蕴，正邪交争而发热", priority: "次要" },
    { therapy: "清利下焦湿热，化浊止带", targetPathogenesis: "湿热下注冲任，秽浊下泄", priority: "次要" },
  ] },
  pathogenesis: { chain: [
    { nodeId: "P1", pathogenesis: "湿热壅阻下焦，气血不通则痛", therapyDirection: "清热利湿，行气止痛", patientFact: "下腹痛伴发热3天", syndromeEvidence: "伴黄色分泌物增多" },
    { nodeId: "P2", pathogenesis: "热毒内蕴，正邪交争而发热", therapyDirection: "清热解毒，透热外出", patientFact: "下腹痛伴发热3天", syndromeEvidence: "伴黄色分泌物增多" },
    { nodeId: "P3", pathogenesis: "湿热下注冲任，秽浊下泄", therapyDirection: "清利下焦湿热，化浊止带", patientFact: "伴黄色分泌物增多", syndromeEvidence: "下腹持续痛，伴黄色分泌物增多，近1天发热" },
  ], natureDifferentiation: { items: ["湿热", "毒", "气滞"], rootDeficiency: [], branchExcess: ["湿热", "毒", "气滞"] } },
};
const nodeTherapy = { P1: "清热利湿，行气止痛", P2: "清热解毒，透热外出", P3: "清利下焦湿热，化浊止带" };
const herb = (name, role, fn, ref, target) => ({ name, role, function: fn, prescriptionRole: `${role}药：${nodeTherapy[ref] || target}`, targetKind: ref === "FORMULA_STRUCTURE" ? "formula_structure" : "pathogenesis_node", targetRef: ref, targetPathogenesis: target, dose: "10g" });
const c068Herbs = [
  herb("金银花", "君", "清热解毒，清下焦湿热", "P1", "湿热壅阻下焦，气血不通则痛"),
  herb("赤芍", "臣", "清热凉血，散瘀止痛", "P1", "湿热壅阻下焦，气血不通则痛"),
  herb("天花粉", "臣", "清热泻火，消肿排脓", "P2", "热毒内蕴，正邪交争而发热"),
  herb("浙贝母", "臣", "清热散结，化浊止带", "P3", "湿热下注冲任，秽浊下泄"),
  herb("防风", "佐", "祛风胜湿，助热外透", "P2", "热毒内蕴，正邪交争而发热"),
  herb("白芷", "佐", "燥湿止带，消肿止痛", "P3", "湿热下注冲任，秽浊下泄"),
  herb("陈皮", "佐", "理气燥湿，顾护中焦", "FORMULA_STRUCTURE", "顾护中焦"),
  herb("皂角刺", "佐", "消肿托毒，排脓止带", "P3", "湿热下注冲任，秽浊下泄"),
  herb("甘草", "使", "调和诸药", "FORMULA_STRUCTURE", "调和诸药，协调药性"),
];
const c068Content = (candidate) => wrap({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{
  formulaAnalysis: "金银花为君，清热解毒；赤芍、天花粉、浙贝母为臣；防风、白芷、陈皮、皂角刺为佐；甘草为使。", herbs: c068Herbs, ...candidate,
}] } });

await check("1.1 候选已是自拟方时，M03 锁定方的原方药味不再豁免：终审会按方向对立拒的白芷、皂角刺单味剔除，剔后终审判据为空（C068）", () => {
  const content = c068Content({ name: "本例辨证组方", formulaNames: [], constructionType: "self_devised" });
  const before = contract.m04CandidateOpposingDirectionIndices(c068Herbs, c068Prior, []);
  assert.deepEqual([...before].map((index) => c068Herbs[index].name).sort(), ["白芷", "皂角刺"].sort(), "fixture: 终审会拒这两味");
  const pruned = unwrap(modificationSafety.declassifyAndDropOpposingM04CandidateHerbs(content, c068Prior)).formula.candidates[0];
  assert.deepEqual(pruned.herbs.map((item) => item.name), ["金银花", "赤芍", "天花粉", "浙贝母", "防风", "陈皮", "甘草"]);
  assert.equal(contract.m04CandidateOpposingDirectionIndices(pruned.herbs, c068Prior, pruned.formulaNames).size, 0, "剔后终审不再按方向拒");
  assert.doesNotMatch(pruned.formulaAnalysis, /白芷|皂角刺/, "方义随剔除改写");
});

await check("1.2 对照：候选仍声称仙方活命饮时终审本就按原方组成豁免，同一张方一味不删；终审的判据与剔药的判据同为一个函数", () => {
  const content = c068Content({ name: "仙方活命饮加减", formulaNames: ["仙方活命饮"], constructionType: "modified" });
  assert.equal(contract.m04CandidateOpposingDirectionIndices(c068Herbs, c068Prior, ["仙方活命饮"]).size, 0, "fixture: 声称原方时终审豁免");
  assert.equal(modificationSafety.declassifyAndDropOpposingM04CandidateHerbs(content, c068Prior), content);
});

// ---------- 2 净化器不把单值字段删空 ----------
// 甲方 100 例 C098（68 岁男性）：加减核对统计的说明「拟加药味与本例人群或状态冲突（药典孕妇禁用、妊娠/哺乳/儿童高风险…）」
// 被「男性不适用」整句删空，空串过不了结构校验（too_small_formula_modificationReview_droppedReasons_0_message），整张处方退成非剂量页。
const maleState = types.normalizeCaseStateInput({ id: "r1039-male", chiefComplaint: "咳嗽3天", patient: { sex: "男", age: 68 }, symptoms: { 现病史: "咳嗽3天，咯少量白痰。" } });
const dropMessage = "拟加药味与本例人群或状态冲突（药典孕妇禁用、妊娠/哺乳/儿童高风险、活动性出血时的活血化瘀药等），不宜加入";
const prescriptionWith = (extra) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "止嗽散加减", herbs: [{ name: "桔梗" }], notApplicable: "孕妇慎用", ...extra.candidate }],
  modificationReview: { submittedCount: 3, retainedCount: 2, droppedCount: 1, droppedReason: dropMessage, droppedReasons: [{ code: "special_population_conflict", count: 1, message: dropMessage }] } },
nonPharma: { precautions: ["服药期间忌食生冷。", "孕妇慎用本方。"], ...extra.nonPharma } });

await check("2.1 加减核对统计是服务端写的规则说明，男性患者也原样保留（整句只讲孕哺的、只有后半句讲孕哺的都不删）", () => {
  const out = unwrap(safety.sanitizeUngroundedRedFlagNegations(wrap(prescriptionWith({ candidate: {} })), maleState));
  assert.equal(out.formula.modificationReview.droppedReasons[0].message, dropMessage);
  assert.equal(out.formula.modificationReview.droppedReason, dropMessage);
  const twoClause = "拟加药味与本例状态冲突，不宜加入。药典孕妇禁用、哺乳期高风险的药同样不加。";
  const reasoning = prescriptionWith({ candidate: {} });
  reasoning.formula.modificationReview.droppedReasons[0].message = twoClause;
  const kept = unwrap(safety.sanitizeUngroundedRedFlagNegations(wrap(reasoning), maleState));
  assert.equal(kept.formula.modificationReview.droppedReasons[0].message, twoClause, "规则说明不按本例删句");
});

await check("2.2 单值字段整段只讲孕期时不删空（退回原文），列表里只讲孕期的那一条照旧去掉（对照）", () => {
  const out = unwrap(safety.sanitizeUngroundedRedFlagNegations(wrap(prescriptionWith({ candidate: {} })), maleState));
  assert.equal(out.formula.candidates[0].notApplicable, "孕妇慎用", "单值字段删空会过不了结构校验");
  assert.deepEqual(out.nonPharma.precautions, ["服药期间忌食生冷。"], "列表项照旧按男性不适用去掉");
});

// ---------- 3 开方正文的方名与方义跟着结构化结果走 ----------
// 2026-10-27 甲方 00000239（13 岁咳嗽）：结构化方义「本方为自拟方。…」，正文方义仍是「本方以本方案合本方案加减。…」；
// 同日 90000405 银翘散：结构化「本方用银翘散原方。」、正文「本方以银翘散为基础加减。」。开方结果的正文不随投影重渲染。
await check("3.1 交付投影改了方名与方义时，正文里的方名标题与方义段落换成投影后的写法；其余正文不动", () => {
  const analysis = "本方以本方案合本方案加减。法半夏为君，燥湿化痰；陈皮为臣，理气化痰；茯苓为臣，健脾渗湿；炙甘草为使，调和诸药。";
  const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {}, formula: { candidates: [{ name: "本例辨证组方",
    herbs: [{ name: "法半夏", role: "君" }, { name: "陈皮", role: "臣" }, { name: "茯苓", role: "臣" }, { name: "炙甘草", role: "使" }], formulaAnalysis: analysis }] }, nonPharma: {} };
  const visible = `## 儿童用药说明\n- 学龄儿童\n\n# 候选方药\n\n## 本例辨证组方\n**方案类型**：自拟方\n\n### 方义分析\n${analysis}\n\n### 剂数与煎服\n**剂数**：5剂\n`;
  const out = surface.applyDeliveredSurfaceToContent(wrap(reasoning, visible), {});
  const shown = out.slice(0, out.indexOf(START));
  const structured = unwrap(out).formula.candidates[0];
  assert.equal(structured.name, "自拟方");
  assert.match(shown, /\n## 自拟方\n/);
  assert.ok(shown.includes(structured.formulaAnalysis), "正文方义与结构化方义逐字相同");
  assert.doesNotMatch(shown, /本方案/);
  assert.match(shown, /## 儿童用药说明\n- 学龄儿童/, "渲染后并入的内容保留");
});

await check("3.2 方名写成自拟方、组成却正是辨证阶段锁定或剥名前所称的成方：逐味相同写原方名与原书出处、方义开头「本方用X原方」（接口回放 旋覆代赭汤七味）；保留数不够的照旧自拟方（对照）", () => {
  const rx = (herbs) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: { recommendedFormulaNames: ["旋覆代赭汤"] }, formula: { candidates: [{
    name: "自拟方", formulaNames: [], identityDeclassified: true, declassifiedFromFormulaNames: ["旋覆代赭汤"], formulaSource: { evidenceLevel: "model_inference", source: "自拟方", confidence: "中" },
    formulaAnalysis: "本方为自拟方。旋覆花下气消痰、降逆止呕，赭石重镇降逆，二药为君；半夏、生姜为臣；人参、大枣为佐；甘草为使。",
    herbs: herbs.map((name) => ({ name, role: "佐", dose: "9g" })) }] }, nonPharma: {} });
  const out = surface.projectDeliveredReasoning(rx(["旋覆花", "赭石", "半夏", "生姜", "人参", "大枣", "甘草"]), {}).formula.candidates[0];
  assert.equal(out.name, "旋覆代赭汤");
  assert.equal(out.formulaSource.source, "旋覆代赭汤：《伤寒论》");
  assert.match(out.formulaAnalysis, /^本方用旋覆代赭汤原方/);
  const partial = surface.projectDeliveredReasoning(rx(["旋覆花", "半夏", "茯苓", "陈皮", "甘草"]), {}).formula.candidates[0];
  assert.equal(partial.name, "自拟方", "保留数不到身份下限：不冠方名");
});

// ---------- 4 甲方明说不要的写法 ----------
const boundary = await jiti.import("../src/lib/candidate-boundary-text.ts");
const repairPolicy = await jiti.import("../src/lib/m04-repair-policy.ts");
const textbookPlan = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");

await check("4.1 治疗卡的操作者要求不说「资质」（甲方 8/20「资质…不是给用户看的」；今日回放 69 张卡）；没有「资质」的原句不动", () => {
  assert.equal(surface.operatorRequirementWording("由具备相应资质的中医执业人员操作"), "由中医执业人员操作");
  assert.equal(surface.operatorRequirementWording("仅限具备相应资质和无菌操作条件的机构"), "仅限具备无菌操作条件的机构");
  assert.equal(surface.operatorRequirementWording("仅限具备针刀诊疗资质和无菌操作条件的机构"), "仅限具备针刀诊疗与无菌操作条件的机构");
  assert.equal(surface.operatorRequirementWording("必须先明确具体项目、适应证、资质和操作规范"), "必须先明确具体项目、适应证和操作规范");
  assert.equal(surface.operatorRequirementWording("由受训人员按体能和病情分级指导"), "由受训人员按体能和病情分级指导");
});

await check("4.2 男性、儿童、60 岁以上：逐味提示的合写人群标签去掉「月经期」，出血倾向、抗凝状态照列；育龄女性原样（对照）", () => {
  const profile = { herb: "川芎", isToxic: false, toxicity: [], populationRules: [{ population: "出血倾向/月经期/抗凝状态", severity: "MEDIUM" }] };
  assert.equal(boundary.herbBoundaryNote(profile, { reproductive: false, ageYears: 45 }), "川芎（出血倾向/抗凝状态慎用）");
  assert.equal(boundary.herbBoundaryNote(profile, { reproductive: true, ageYears: 30 }), "川芎（出血倾向/月经期/抗凝状态慎用）");
});

await check("4.3 开方质量批注不说「确定性核查」「系统未能自动对应」「已锁定治法」「M03」，开头写哪几项已核对（今日回放 47/90 份正文开头是这类句子）", () => {
  const notes = [
    "transparent_therapy_coverage", "transparent_therapy_herb_support", "transparent_therapy_herb_knowledge_missing",
    "candidate_0_herb_2_unsupported_high_impact_yang_warm", "herb_1_emperor_therapy_mismatch", "therapy_direction_uncovered_heat_clear", "pathogenesis_node_uncovered_P2",
  ].map((code) => repairPolicy.m04TherapyIssueQualityAnnotation(code));
  for (const note of notes) {
    assert.ok(note && note.startsWith(repairPolicy.QUALITY_LEAD), note);
    assert.doesNotMatch(note, /确定性|系统|锁定|M03|词表/, note);
  }
});

await check("4.4 《推拿学》写「根据五脏的不同配以五脏的背俞穴」时按本例证名里的脏取背俞穴，这句方法本身不进穴位表；证名里没有脏时照教材全列（对照）", () => {
  const sites = ["背腰部", "腹部", "根据五脏的不同配以五脏的背俞穴", "大椎", "关元", "肺俞", "心俞", "肝俞", "脾俞", "肾俞"];
  const lungSpleen = textbookPlan.tuinaBackShuForSyndrome(sites, "肺脾两虚证");
  assert.deepEqual(lungSpleen.sites, ["背腰部", "腹部", "大椎", "关元", "肺俞", "脾俞"]);
  assert.equal(lungSpleen.note, "按本例肺、脾两脏取肺俞、脾俞。");
  assert.equal(textbookPlan.tuinaBackShuForSyndrome(sites, "气血两虚证").sites.length, 9, "证名无脏：全列（只去掉方法句）");
});

// ---------- 5 苦寒药对着病历显出的脾胃虚寒 ----------
// 甲方 10.26 测评病历 3（产后血虚头痛·加味四物汤）：「黄芩不宜」——病历记食欲下降、大便稀溏、小便清长，三次生成都带黄芩。
const caution = await jiti.import("../src/lib/herb-record-caution.ts");
const record3 = "主诉：头痛2+月\n现病史：生产后出现头痛，呈隐痛，时发时止，遇疲劳加重，伴头晕、心悸、神疲乏力。食欲下降，睡眠差，小便清长，大便稀溏。";
await check("5.1 教材「脾胃虚寒者不宜」的黄芩：病历有便溏一类、有虚寒表现、无热象且证候无热时判冲突；有口苦（热象）或证候带火时不判（对照）；当归的便溏类注意不按此条", () => {
  const hq = caution.herbAnyRecordCautionConflict("黄芩", record3, "血虚头痛");
  assert.equal(hq?.kind, "cold_deficiency");
  assert.deepEqual(hq?.recordFindings, ["大便稀溏", "小便清长"]);
  assert.equal(caution.herbRecordCautionIsHard(hq), true);
  assert.equal(caution.herbAnyRecordCautionConflict("黄芩", record3.replace("小便清长", "口苦、小便清长"), "血虚头痛"), undefined, "有热象");
  assert.equal(caution.herbAnyRecordCautionConflict("黄芩", record3, "肝火上炎证"), undefined, "证候带火");
  const dg = caution.herbAnyRecordCautionConflict("当归", record3, "血虚头痛");
  assert.equal(dg?.kind ?? "loose_stool", "loose_stool");
  assert.equal(caution.herbRecordCautionIsHard(dg), false, "当归的便溏类注意不让原方药味出方");
});

await check("5.2 定稿时把黄芩单味拿出并写明依据，当归、君药照留；提示词点名代表方里的黄芩要去掉，并说不新增苦寒清热药", () => {
  const rx = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: { primarySyndrome: "血虚头痛", secondarySyndromes: [] }, formula: { candidates: [{ name: "加味四物汤加减",
    formulaAnalysis: "白芍、当归为君，养血和络；生地黄、川芎为臣；黄芩为佐，清头目之热；甘草为使。",
    herbs: ["白芍:君", "当归:君", "生地黄:臣", "川芎:臣", "菊花:佐", "黄芩:佐", "甘草:使"].map((item) => ({ name: item.split(":")[0], role: item.split(":")[1], dose: "10g" })) }] } };
  const out = unwrap(modificationSafety.dropSafetyConflictingM04CandidateHerbs(wrap(rx), record3)).formula.candidates[0];
  assert.deepEqual(out.herbs.map((item) => item.name), ["白芍", "当归", "生地黄", "川芎", "菊花", "甘草"]);
  assert.match(out.notApplicable, /黄芩（《中药学》「脾胃虚寒者不宜」，本例大便稀溏、小便清长）/);
  assert.doesNotMatch(out.formulaAnalysis, /黄芩/);
  const section = caution.herbRecordCautionPromptSection(record3, "血虚头痛", ["加味四物汤加减"], ["当归", "川芎", "白芍", "生地黄", "菊花", "蔓荆子", "黄芩", "甘草"]);
  assert.match(section, /所选代表方原有的黄芩性苦寒，教材写明脾胃虚寒者忌用或不宜，本例去掉/);
  assert.match(section, /不要新增黄芩、黄连、黄柏、龙胆、石膏一类苦寒清热药/);
  assert.match(section, /所选代表方原有的当归可以保留/);
});

// ---------- 6 同类重复与无出处的间隔 ----------
await check("6.1 同属补气药的「参」只留一味（甲方 10.12「不要人参党参同用」；回放 C032、C040、C013）：留地位高的一味，写明原因；黄芪、白术等非参类补气药不动；两味都是君药时不拿（对照）", () => {
  const rx = (herbs) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: { primarySyndrome: "气虚证" }, formula: { candidates: [{ name: "自拟方", formulaAnalysis: "人参为君，大补元气；党参为佐。",
    herbs: herbs.map((item) => ({ name: item.split(":")[0], role: item.split(":")[1], dose: "10g" })) }] } });
  const out = unwrap(modificationSafety.dropSafetyConflictingM04CandidateHerbs(wrap(rx(["人参:君", "黄芪:臣", "白术:臣", "党参:佐", "甘草:使"])), "主诉：乏力")).formula.candidates[0];
  assert.deepEqual(out.herbs.map((item) => item.name), ["人参", "黄芪", "白术", "甘草"]);
  assert.match(out.notApplicable, /党参（与人参同属补气的参类，不重复使用）/);
  const both = rx(["人参:君", "党参:君", "黄芪:臣", "甘草:使"]);
  assert.equal(modificationSafety.dropSafetyConflictingM04CandidateHerbs(wrap(both), "主诉：乏力"), wrap(both), "两味都是君药：不拿");
  const shashen = rx(["北沙参:君", "太子参:臣", "麦冬:臣", "甘草:使"]);
  assert.equal(modificationSafety.dropSafetyConflictingM04CandidateHerbs(wrap(shashen), "主诉：口干"), wrap(shashen), "北沙参是补阴药，不与太子参算重复");
});

await check("6.2 规则补写的现用药提示不写「最好间隔1小时左右」（甲方 8/20「注意事项出现无证据药物间隔」）", () => {
  const src = readFileSync("src/lib/delivered-surface.ts", "utf8");
  assert.doesNotMatch(src, /同服时最好间隔1小时左右`/);
  assert.match(src, /是否继续服用、与本方如何错开服用由医生决定/);
});

await check("6.3 证名、病名不涉心神时治法里单列的「宁心安神」一项去掉（回放 虚劳·脾胃阴虚、消渴）；心脾两虚、不寐照留；「宁心止汗」不是整项安神，照留（对照）", () => {
  const diag = (disease, syndrome, method) => surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: disease, primarySyndrome: syndrome, secondarySyndromes: [] }, therapy: { overallMethod: method } }, {}).therapy.overallMethod;
  assert.equal(diag("虚劳", "脾胃阴虚证", "益气健脾，滋阴和胃，宁心安神"), "益气健脾，滋阴和胃");
  assert.equal(diag("消渴", "气阴亏虚证", "生津止渴，宁心安神"), "生津止渴");
  assert.equal(diag("心悸", "心脾两虚证", "补血养心，益气安神，宁心安神"), "补血养心，益气安神，宁心安神");
  assert.equal(diag("虚劳", "脾胃阴虚证", "养阴和胃，健脾益气，宁心止汗"), "养阴和胃，健脾益气，宁心止汗");
});

// ---------- 7 中成药与汤剂药性相反 ----------
const patentMedicine = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
await check("7.1 证名不分寒热（外感风邪证）时按已签名治法定寒热：治法只清热时不推辛温的桂枝颗粒；治法也不分时按汤剂组成（清热药过三分之一、无温散药）；寒热都有的汤剂不判（对照）", () => {
  const guizhi = { clause: "解肌发表，调和营卫", herbs: ["桂枝", "白芍", "生姜", "大枣", "甘草"] };
  assert.equal(patentMedicine.patentMedicineDirectionConflict(guizhi, { names: "外感风邪证", method: "疏风清热，宣肺利咽" }), "warm_for_heat_case");
  const coldDecoction = patentMedicine.decoctionThermalByComposition(["黄芩", "栀子", "连翘", "黄连", "甘草", "桔梗"]);
  assert.equal(coldDecoction, "cold");
  assert.equal(patentMedicine.patentMedicineDirectionConflict(guizhi, { names: "外感风邪证", method: "疏风解表", decoctionThermal: coldDecoction }), "warm_for_heat_case");
  const mixed = patentMedicine.decoctionThermalByComposition(["川芎", "荆芥穗", "防风", "羌活", "白芷", "黄芩", "栀子", "连翘", "黄连", "甘草"]);
  assert.equal(patentMedicine.patentMedicineDirectionConflict(guizhi, { names: "外感风邪证", method: "疏风解表", decoctionThermal: mixed }), undefined, "寒热都有的汤剂不判");
  assert.equal(patentMedicine.patentMedicineDirectionConflict(guizhi, { names: "外感风邪证", method: "疏风解表" }), undefined, "治法与汤剂都不定：不判");
});

// ---------- 8 新臂扫描抓到的两处 ----------
const secondary = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
await check("8.1 男性患者的中医病名鉴别不列只属《中医妇科学》的病（C015：21 岁男性肠痈列了异位妊娠）；女性照列、非妇科病照列（对照）", () => {
  const diag = (sex) => surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: "肠痈", primarySyndrome: "瘀滞证", secondarySyndromes: [], tcmDiseaseDifferentials: [
      { diseaseName: "腹痛", reason: "均有腹痛", distinguishingPoints: "无固定压痛点" }, { diseaseName: "异位妊娠", reason: "均有下腹痛", distinguishingPoints: "停经史" }] },
    therapy: { overallMethod: "行气活血，通腑泄热" } }, { patientSex: sex }).overview.tcmDiseaseDifferentials.map((item) => item.diseaseName);
  assert.ok(!diag("男").includes("异位妊娠"), diag("男").join("、"));
  assert.ok(diag("男").includes("腹痛"));
  assert.ok(diag("女").includes("异位妊娠"), "女性照列");
});

await check("8.2 依据明确排除了某一型（「故不归寒凝或湿热」）而兼证栏写着它（C061 寒凝胞宫证）：按依据撤下；排除语后面说的是别的型时不撤（对照）", () => {
  const rationale = "经期小腹痉挛痛、热敷缓解，为胞宫气滞血行不畅，故属气滞血瘀证；舌淡红、苔薄白示无明显寒热与湿浊，故不归寒凝或湿热。";
  assert.equal(secondary.secondaryStructurallyInvalid("气滞血瘀证", "寒凝胞宫证", rationale), "declared_not_independent");
  assert.equal(secondary.secondaryStructurallyInvalid("气滞血瘀证", "肝郁脾虚证", rationale), undefined);
  assert.equal(secondary.secondaryStructurallyInvalid("肝气犯胃证", "脾气虚证", "纳差、便溏为脾虚之象，不属单纯肝郁。"), undefined);
});

console.log(JSON.stringify({ suite: "r1039-main", cases, failures: process.exitCode ? "see above" : 0 }));
