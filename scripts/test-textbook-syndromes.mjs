import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

// 教材「病—证—治法—代表方—加减」对照表的运行时用法（tcm-textbook-syndromes.ts，2026-10-13）。
// 甲方医生按规划教材对照结果；此前病名、证名、方名由模型自由书写，同一病例重新生成 3 次方名只有一半病例一致，
// 证名与教材字面一致的 2/10、方是教材代表方的 2/10。这里钉：候选检索是确定性的并能取到对的那一行；
// 辨证结果的病名、治法、方名随教材行；教材配对算方剂的正向依据；追问题与加减触发由教材行给出。
// 病例文字是为本套件写的示意病历，不含任何真实病历。

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": "/dev/null" } });
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const { withDeterministicFormulaReferences } = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const { namedFormulaPositiveSufficiencyIssue, textbookRelationFormulaIdentityNames } = await jiti.import("../src/lib/tcm-formula-indications.ts");
const { canonicalTcmDiseaseName } = await jiti.import("../src/lib/clinical-terminology.ts");
const { modificationTriggerGroundedInM03 } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const { finalModificationTriggerGrounded } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");

const stats = textbook.textbookTableStats();
assert.ok(stats.diseases >= 300 && stats.rows >= 1200, `教材对照表规模异常：${JSON.stringify(stats)}`);

// ── 1. 候选检索：取到对的病、对的证，且两次调用结果逐字相同 ───────────────────────────────
const CASES = [
  { chiefComplaint: "怕冷发热、鼻塞流清涕2天", presentHistory: "2天前淋雨后怕冷明显，发热不高，无汗，鼻塞流清涕，头痛，周身酸楚，咳嗽痰白稀。", tongue: "舌苔薄白", pulse: "脉浮紧", sex: "女", ageYears: 24, disease: "感冒", syndrome: "风寒束表证", formula: "荆防败毒散" },
  { chiefComplaint: "心慌1个月", presentHistory: "1个月来心慌不宁，容易受惊，坐卧不安，夜间多梦易惊醒，听到声响就心慌，饮食减少。", tongue: "苔薄白", pulse: "脉细弦", sex: "男", ageYears: 30, disease: "心悸", syndrome: "心虚胆怯证", formula: "安神定志丸" },
  { chiefComplaint: "胃脘胀痛半月", presentHistory: "半月前与人争吵后胃脘胀痛，痛连两胁，生气后加重，嗳气后稍舒，喜叹气，大便不畅。", tongue: "舌苔薄白", pulse: "脉弦", sex: "女", ageYears: 41, disease: "胃痛", syndrome: "肝气犯胃证", formula: "柴胡疏肝散" },
  { chiefComplaint: "腰部酸痛半年", presentHistory: "半年来腰部酸软隐痛，劳累后加重，伴心烦少寐，口燥咽干，手足心热，面色潮红。", tongue: "舌红少苔", pulse: "脉弦细数", sex: "男", ageYears: 52, disease: "腰痛", syndrome: "肾阴虚证", formula: "左归丸" },
  { chiefComplaint: "右侧胁肋部簇集水疱伴疼痛4天", presentHistory: "4天前右侧胁肋部出现成簇水疱，皮损鲜红，灼热刺痛，口苦咽干，心烦易怒，大便干，小便黄。", tongue: "舌质红，苔薄黄", pulse: "脉弦滑数", sex: "男", ageYears: 60, disease: "蛇串疮", syndrome: "肝经郁热证", formula: "龙胆泻肝汤" },
  { chiefComplaint: "牙痛3天", presentHistory: "3天来右下牙痛剧烈，牙龈红肿，遇热加剧，口渴口臭，大便秘结，小便黄。", tongue: "舌红苔黄", pulse: "脉洪数", sex: "男", ageYears: 35, disease: "牙痛", syndrome: "胃火上炎证", formula: "清胃散" },
];
for (const item of CASES) {
  const first = textbook.textbookCandidatesForCase(item);
  const second = textbook.textbookCandidatesForCase(item);
  assert.deepEqual(first, second, `${item.disease}：同一份病历两次取到的候选必须逐字相同`);
  assert.equal(first[0]?.disease, item.disease, `${item.chiefComplaint}：第一候选病应为 ${item.disease}，实际 ${first.map((entry) => entry.disease).join("、")}`);
  assert.equal(first[0].rows[0].syndromeName, item.syndrome, `${item.disease}：第一候选证应为 ${item.syndrome}，实际 ${first[0].rows.slice(0, 3).map((row) => row.syndromeName).join("、")}`);
  assert.ok(first[0].rows[0].formulas.includes(item.formula), `${item.syndrome} 的代表方应含 ${item.formula}`);
  assert.ok(first.length <= 3 && first.every((entry) => entry.rows.length <= 8), "候选规模有上限");
  const context = textbook.buildTextbookCandidateContext(item);
  assert.ok(context.startsWith("【教材病证候选】") && context.includes(item.syndrome) && context.includes(item.formula));
}
// 「反复感冒」说的是体质，不是这一次得了感冒
{
  const habitual = textbook.textbookCandidatesForCase({ chiefComplaint: "反复感冒1年", presentHistory: "近一年反复感冒，平素易疲乏，短气自汗，声音低怯，食欲下降，大便稀溏。", sex: "男", ageYears: 45 });
  assert.equal(habitual[0]?.disease, "虚劳", `反复感冒伴气虚表现应先取虚劳，实际 ${habitual.map((entry) => entry.disease).join("、")}`);
}
// 否定的症状不算数；儿童不取成人内科，男性不取妇科
{
  const negated = textbook.textbookCandidatesForCase({ chiefComplaint: "乏力1周", presentHistory: "无头痛，无发热，无咳嗽，无心悸。", ageYears: 40, sex: "男" });
  assert.ok(!negated.some((entry) => ["头痛", "咳嗽", "心悸"].includes(entry.disease)), `被否认的症状不应带出对应的病：${negated.map((entry) => entry.disease).join("、")}`);
  const male = textbook.textbookCandidatesForCase({ chiefComplaint: "小腹痛2天", presentHistory: "小腹胀痛，痛处固定。", sex: "男", ageYears: 30 });
  assert.ok(male.every((entry) => !/妇科/.test(entry.book)), "男性不取妇科教材");
  assert.deepEqual(textbook.textbookCandidatesForCase({ chiefComplaint: "", presentHistory: "" }), []);
}

// ── 2. 按已定病名、证名找回教材行 ─────────────────────────────────────────────────────────
assert.equal(textbook.textbookRowForSyndrome("心悸", "心虚胆怯证")?.formulas[0], "安神定志丸");
assert.equal(textbook.textbookRowForSyndrome("头风病", "血虚头痛证")?.disease, "头痛", "病名写法不同、证名只属于一个病时按证名找回");
assert.equal(textbook.textbookRowForSyndrome("心悸", "肝气犯胃证"), undefined, "证名属于多个病、病名又对不上时不猜");
assert.equal(textbook.textbookRowForSyndrome("感冒", "一个教材没有的证"), undefined);

// ── 3. 辨证结果随教材行：病名、治法、方名 ────────────────────────────────────────────────
const m03 = (overview, therapy = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { primarySyndromeResolution: "bounded", secondarySyndromes: [], ...overview },
  westernDiagnosis: { primary: { name: "x", supportingFacts: [] } },
  pathogenesis: { chain: [] },
  therapy: { overallPrinciple: "", overallMethod: "", ...therapy },
});
{
  const out = withDeterministicFormulaReferences(m03(
    { tcmDiseaseName: "心悸", primarySyndrome: "心虚胆怯证", recommendedFormulaDirection: "酸枣仁汤加减" },
    { overallMethod: "益气镇惊、养血安神为主，兼以健脾和中" },
  ));
  assert.equal(out.overview.recommendedFormulaDirection, "安神定志丸加减", "心虚胆怯证的方是教材代表方，不是酸枣仁汤（测评原例）");
  assert.deepEqual(out.overview.recommendedFormulaNames, ["安神定志丸"]);
  assert.equal(out.therapy.overallMethod, "镇惊定志，养心安神", "治法用教材原文，不带「兼以」");
}
{
  const out = withDeterministicFormulaReferences(m03(
    { tcmDiseaseName: "头风病", primarySyndrome: "血虚头痛", tcmDiseaseRationale: "产后头部隐痛，故归头风病。", recommendedFormulaDirection: "八珍汤加减" },
  ));
  assert.equal(out.overview.tcmDiseaseName, "头痛", "病名用教材的节名");
  assert.equal(out.overview.tcmDiseaseRationale, "产后头部隐痛，故归头痛。");
  assert.match(out.overview.recommendedFormulaDirection, /^加味四物汤加减$/, "目录锁不住的教材代表方，方向仍写教材方名");
}
{
  // 模型已经写了教材代表方：原样保留它的写法；写了兼证时不覆盖治法
  const kept = withDeterministicFormulaReferences(m03(
    { tcmDiseaseName: "胃痛", primarySyndrome: "肝气犯胃证", recommendedFormulaDirection: "柴胡疏肝散加减", secondarySyndromes: ["脾胃虚弱证"] },
    { overallMethod: "疏肝理气，和胃止痛，健脾益气" },
  ));
  assert.equal(kept.overview.recommendedFormulaDirection, "柴胡疏肝散加减");
  assert.equal(kept.therapy.overallMethod, "疏肝理气，和胃止痛，健脾益气");
  // 对不上教材：不动模型写的
  const free = withDeterministicFormulaReferences(m03(
    { tcmDiseaseName: "感冒", primarySyndrome: "一个教材没有的证", recommendedFormulaDirection: "按已锁定病机与治法辨证组方" },
    { overallMethod: "自拟治法" },
  ));
  assert.equal(free.therapy.overallMethod, "自拟治法");
  assert.equal(free.overview.tcmDiseaseName, "感冒");
}

// ── 4. 教材病名是可交付的规范写法 ─────────────────────────────────────────────────────────
for (const [written, expected] of [["头痛", "头痛"], ["虚劳", "虚劳"], ["虚劳类病", "虚劳"], ["不寐", "不寐"]]) {
  assert.equal(canonicalTcmDiseaseName(written, { overview: { primarySyndrome: "" }, westernDiagnosis: { primary: { name: "" } } }), expected);
}

// ── 5. 教材配对是方剂的正向依据 ──────────────────────────────────────────────────────────
{
  const reasoning = m03(
    { tcmDiseaseName: "蛇串疮", primarySyndrome: "肝经郁热证", recommendedFormulaDirection: "龙胆泻肝汤加减", recommendedFormulaNames: ["龙胆泻肝汤"] },
    { overallMethod: "清泄肝火，解毒止痛" },
  );
  assert.deepEqual([...textbookRelationFormulaIdentityNames(reasoning, ["龙胆泻肝汤"])], ["龙胆泻肝汤"]);
  assert.equal(namedFormulaPositiveSufficiencyIssue(reasoning, ["龙胆泻肝汤"]), undefined, "教材代表方不得被判成缺少正向充分性（本机实测曾因此整方退成非剂量页）");
  // 反证：同一证型配一张教材没配的方，这条依据不成立
  assert.deepEqual([...textbookRelationFormulaIdentityNames(reasoning, ["导赤散"])], []);
  assert.deepEqual([...textbookRelationFormulaIdentityNames({ ...reasoning, overview: { ...reasoning.overview, primarySyndromeResolution: "unresolved" } }, ["龙胆泻肝汤"])], []);
}

// ── 6. 服务端自有的辨证追问 ──────────────────────────────────────────────────────────────
{
  const noTongue = textbook.textbookDiscriminatingQuestion({ chiefComplaint: "咳嗽3天", presentHistory: "3天来咳嗽，咳痰色白。", ageYears: 40 });
  assert.ok(noTongue, "舌脉缺失、候选不止一个证时应能出题");
  assert.equal(noTongue.field, "舌象");
  assert.notEqual(noTongue.optionA, noTongue.optionB, "两个选项必须不同");
  assert.match(noTongue.optionA, /脉/);
  assert.doesNotMatch(noTongue.reason, /证(?:与|，)/, "理由不点证名");
  const withTongue = textbook.textbookDiscriminatingQuestion({ ...CASES[1] });
  if (withTongue) {
    assert.equal(withTongue.field, "现病史");
    for (const option of [withTongue.optionA, withTongue.optionB]) {
      assert.ok(!CASES[1].presentHistory.includes(option.replace(/^伴/, "")), `选项问的是病历尚未记录的表现：${option}`);
    }
  }
  assert.equal(textbook.textbookDiscriminatingQuestion({ chiefComplaint: "体检要求调理" }), undefined, "对不上教材时不出题");
  // 选项是完整的症状，不是按顿号切剩的部位残片（2026-10-13，合成集 S134 实测出过「伴颜面」、S026「伴兼胁痛」）。
  // 逐病种扫一遍：舌脉已给时出的「伴…」选项，每一段都要带一个表「怎么样」的字，且不以兼/或/伴开头。
  const table = JSON.parse(fs.readFileSync(new URL("../src/data/tcm-textbook-syndrome-formula-table.json", import.meta.url), "utf8"));
  const rows = Array.isArray(table) ? table : table.rows;
  const predicate = /[痛疼胀满闷痞热寒冷凉烦渴干苦黏腻汗咳喘哕呕吐泻秘溏结稀黄赤红紫暗肿痒麻重困乏倦怠眩晕悸惊怒郁梦眠寐频涩急坠酸软鸣聋燥裂瘦萎厥逆饥呆嗳呃堵塞淡清浊臭]/;
  let asked = 0;
  for (const disease of new Set(rows.map((row) => row.disease))) {
    const question = textbook.textbookDiscriminatingQuestion({ chiefComplaint: `${disease}1周`, presentHistory: `${disease}1周。`, tongue: "舌淡红，苔薄白", pulse: "脉平", ageYears: 35 });
    if (!question || question.field !== "现病史") continue;
    asked += 1;
    for (const option of [question.optionA, question.optionB]) {
      for (const part of option.replace(/^伴/, "").split("、")) {
        assert.ok(part.length >= 2 && predicate.test(part) && !/^(?:兼|或|伴|并见)/.test(part), `${disease}：选项片段不是完整症状「${part}」（${option}）`);
      }
    }
  }
  assert.ok(asked >= 50, `扫描应覆盖足够多的病种，实际 ${asked}`);
}

// ── 7. 教材加减是合格的条件句触发 ─────────────────────────────────────────────────────────
{
  const hit = textbook.textbookModificationMatch("感冒", "风寒束表证", "若恶寒甚", "麻黄");
  assert.ok(hit && /恶寒甚/.test(hit.raw) && hit.book === "中医内科学");
  assert.equal(textbook.textbookModificationMatch("感冒", "风寒束表证", "若恶寒甚", "酸枣仁"), undefined, "药味不在这条教材加减里");
  assert.equal(textbook.textbookModificationMatch("感冒", "风寒束表证", "若夜寐不安"), undefined, "教材没有的条件");
  const prior = { ...m03({ tcmDiseaseName: "感冒", primarySyndrome: "风寒束表证", primarySyndromeBasis: ["恶寒重，发热轻"] }), pathogenesis: { chain: [{ nodeId: "P1", patientFact: "恶寒重，发热轻", syndromeEvidence: "无汗", pathogenesis: "风寒束表", therapyDirection: "辛温解表" }] } };
  assert.equal(modificationTriggerGroundedInM03("若恶寒甚", prior), true, "编译期：教材条件句是合格触发");
  assert.equal(finalModificationTriggerGrounded("若恶寒甚", prior), true, "最终合同：同一判据");
  assert.equal(modificationTriggerGroundedInM03("若复诊时出现失眠", prior), false, "自拟的假设句仍不合格");
  assert.equal(finalModificationTriggerGrounded("若复诊时出现失眠", prior), false);
  const context = textbook.buildTextbookFormulaContext("感冒", "风寒束表证");
  assert.match(context, /【教材方药】感冒·风寒束表证/);
  assert.match(context, /【教材加减】若恶寒甚，加麻黄、桂枝/);
}

// 去掉「证」只剩一个字的证名也能按病找到教材行（吐酸·热证；此前返回空，方名与加减都拿不到教材依据）。
assert.equal(textbook.textbookRowForSyndrome("吐酸", "热证")?.formulas.join("+"), "左金丸");
assert.equal(textbook.textbookRowForSyndrome("不存在的病", "热证"), undefined, "一个字的证名不做跨病反查");

// ── 7b. 教材条件式加减不按当前主证的方向核对 ──────────────────────────────────────────────────
// 实测（合成集 S027，头痛·痰浊头痛）：教材加减「若见口苦，大便不畅，舌苔黄腻，脉滑数，…加黄连、枳实、竹茹」
// 被「清热与主证方向不符」整条丢掉——条件说的正是证候化热，药的方向随条件走。非教材触发的加减仍照旧核方向。
{
  const { compileM04Proposal, highImpactHerbDirectionIssue } = await jiti.import("../src/lib/m04-proposal-compiler.ts").then(async (mod) => ({
    compileM04Proposal: mod.compileM04Proposal,
    highImpactHerbDirectionIssue: (await jiti.import("../src/lib/diagnosis-stage-contract.ts")).highImpactHerbDirectionIssue,
  }));
  const prior = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: "头痛", primarySyndrome: "痰浊头痛", primarySyndromeBasis: ["头痛昏蒙，胸脘满闷", "呕恶痰涎"], recommendedFormulaNames: [], formulaSelectionMode: "self_devised", recommendedFormulaDirection: "半夏白术天麻汤加减" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "头痛昏蒙，胸脘满闷，呕恶痰涎", pathogenesis: "脾失健运，痰浊中阻，上蒙清窍", therapyDirection: "健脾燥湿，化痰降逆" }] },
    therapy: { overallMethod: "健脾燥湿，化痰降逆", overallPrinciple: "实则泻之" },
    westernDiagnosis: { primary: { name: "头痛", supportingFacts: ["头痛昏蒙"] }, differentials: [] },
  };
  const herb = (name, dose, role) => ({ name, dose, role, targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "燥湿化痰", processing: null, isToxic: false, decoctionRequirement: null });
  const proposal = (modifications) => ({
    candidate: {
      name: "半夏白术天麻汤加减", applicable: "痰浊头痛。", notApplicable: "阴虚阳亢者不宜。",
      herbs: [herb("法半夏", "9g", "君"), herb("天麻", "10g", "君"), herb("白术", "12g", "臣"), herb("茯苓", "12g", "臣"), herb("陈皮", "6g", "佐"),
        { ...herb("甘草", "3g", "使"), targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "调和诸药" }],
      formulaAnalysis: "本方以半夏白术天麻汤为基础加减。法半夏燥湿化痰、天麻平肝息风共为君，白术、茯苓健脾祛湿为臣，陈皮理气化痰为佐，甘草调和诸药为使。",
      decoction: { doseCount: "7剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日1剂，水煎分两次温服", followUpNode: "服完7剂复诊" },
    },
    patentAndWestern: [], modifications,
    nonPharma: { diet: "饮食清淡，少食肥甘。", lifestyle: "规律作息。", emotion: "保持心情舒畅。", tcmTreatments: [], precautions: ["若头痛突然加剧，须及时就医。"] },
  });
  const textbookRow = { trigger: "若见口苦，大便不畅，舌苔黄腻，脉滑数", targetRef: "P1", actionType: "add", herbName: "黄连", dose: "3g", reason: "清热燥湿", symptomPathogenesis: "痰浊化热" };
  assert.ok(highImpactHerbDirectionIssue("黄连", "清热燥湿；健脾燥湿，化痰降逆", prior), "夹具：黄连对当前痰浊证确实触发方向核对");
  const kept = compileM04Proposal(proposal([textbookRow]), prior).formula.modifications;
  assert.deepEqual(kept.map((item) => item.herbName), ["黄连"], "教材条件式加减保留");
  assert.match(kept[0].evidence.source, /《中医内科学》头痛·痰浊头痛加减/);
  // 对照一：同一味药、触发改成病历已记录的表现（不是教材条件）→ 仍按方向核对丢弃。
  const factTriggered = compileM04Proposal(proposal([{ ...textbookRow, trigger: "胸脘满闷" }]), prior).formula.modifications;
  assert.deepEqual(factTriggered, [], "非教材触发的加减照旧核方向");
  // 对照二：教材条件、但药不在该条教材加减里（把枳壳写成枳实）→ 不算教材加减。
  const wrongHerb = compileM04Proposal(proposal([{ ...textbookRow, trigger: "若痰湿中阻，胸脘满闷甚", herbName: "枳实", reason: "行气消痞" }]), prior).formula.modifications;
  assert.deepEqual(wrongHerb, [], "药名必须在该条教材加减里");
}

// ── 7b2. 教材没有给这一证列加减时：模型写的条件式加减在边界内接受 ─────────────────────────────
// 教材对照表里约四成外科行、两成妇科行没有可用的加减，这些证的处方加减栏常年是空的（合成集 153 张处方里 21 张）。
// 放开的只是触发条件；药味须已知、用量在药典范围内、不与方中药味相反、不与本例治法方向相悖。
{
  const row = textbook.textbookRowForSyndrome("湿疮", "脾虚湿蕴证");
  assert.ok(row && row.modifications.length === 0, "夹具：湿疮·脾虚湿蕴证在教材对照表里没有加减");
  const ok = (trigger) => textbook.conditionalModificationWithoutTextbook("湿疮", "脾虚湿蕴证", trigger);
  for (const trigger of ["若瘙痒较甚，夜间难眠", "若渗液较多", "若兼见纳呆腹胀", "若大便溏薄"]) assert.equal(ok(trigger), true, trigger);
  for (const trigger of ["复诊时若出现失眠", "若复诊时瘙痒加重", "若症状加重", "若必要时", "若效果不佳", "瘙痒较甚", "若病情变化", "若"]) assert.equal(ok(trigger), false, trigger);
  // 教材该证有加减时不走这条路：只认教材条件与已记录表现。
  assert.equal(textbook.conditionalModificationWithoutTextbook("感冒", "风寒束表证", "若咳嗽较甚，痰稀色白"), false);

  const { compileM04Proposal } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
  const { finalModificationTriggerGrounded: finalGrounded } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
  const prior = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: "湿疮", primarySyndrome: "脾虚湿蕴证", primarySyndromeBasis: ["皮损潮红、瘙痒，抓后糜烂渗出", "纳少，神疲，便溏"], recommendedFormulaNames: [], formulaSelectionMode: "self_devised", recommendedFormulaDirection: "除湿胃苓汤加减" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "皮损潮红、瘙痒，抓后糜烂渗出，纳少便溏", pathogenesis: "脾虚湿蕴，浸淫肌肤", therapyDirection: "健脾利湿止痒" }] },
    therapy: { overallMethod: "健脾利湿止痒", overallPrinciple: "虚则补之" },
    westernDiagnosis: { primary: { name: "湿疹", supportingFacts: ["皮损潮红、瘙痒"] }, differentials: [] },
  };
  const herb = (name, dose, role) => ({ name, dose, role, targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "健脾利湿", processing: null, isToxic: false, decoctionRequirement: null });
  const proposal = (modifications) => ({
    candidate: {
      name: "除湿胃苓汤加减", applicable: "脾虚湿蕴。", notApplicable: "阴虚者不宜。",
      herbs: [herb("苍术", "9g", "君"), herb("白术", "12g", "君"), herb("茯苓", "15g", "臣"), herb("泽泻", "9g", "臣"), herb("陈皮", "6g", "佐"),
        { ...herb("甘草", "3g", "使"), targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "调和诸药" }],
      formulaAnalysis: "本方以除湿胃苓汤为基础加减。苍术、白术健脾燥湿为君，茯苓、泽泻利水渗湿为臣，陈皮理气为佐，甘草调和诸药为使。",
      decoction: { doseCount: "7剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日1剂，水煎分两次温服", followUpNode: "服完7剂复诊" },
    },
    patentAndWestern: [], modifications,
    nonPharma: { diet: "饮食清淡。", lifestyle: "规律作息。", emotion: "保持心情舒畅。", tcmTreatments: [], precautions: ["若皮疹迅速扩散，须及时就医。"] },
  });
  const row1 = { trigger: "若渗液较多", targetRef: "P1", actionType: "add", herbName: "薏苡仁", dose: "15g", reason: "利水渗湿，健脾", symptomPathogenesis: "脾虚湿盛，浸淫肌肤" };
  const kept = compileM04Proposal(proposal([row1]), prior).formula.modifications;
  assert.deepEqual(kept.map((item) => [item.trigger, item.herbName, item.doseOrHandling]), [["若渗液较多", "薏苡仁", "15g"]]);
  assert.equal(kept[0].evidence.source, "按本证常见兼症变化拟定的备用加减");
  assert.equal(finalGrounded("若渗液较多", prior), true, "最终合同同一判据");
  // 边界零：这一类不豁免方向核对——脾虚湿蕴证里加清热药（白鲜皮）照旧丢弃。
  assert.deepEqual(
    compileM04Proposal(proposal([{ ...row1, trigger: "若瘙痒较甚，夜间难眠", herbName: "白鲜皮", dose: "10g", reason: "清热燥湿，祛风止痒" }]), prior).formula.modifications,
    [], "与本例治法方向相悖的加味丢弃",
  );
  assert.equal(finalGrounded("复诊时若出现失眠", prior), false);
  // 边界一：与方中药味相反的加味不保留，哪怕条件句合格。判据单独钉（编译路径里海藻还会先被方向核对拦下，证明不了这一条）。
  const { modificationHerbIncompatibleWithCandidate } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
  assert.equal(modificationHerbIncompatibleWithCandidate("海藻", ["苍术", "甘草"]), true, "甘草反海藻");
  assert.equal(modificationHerbIncompatibleWithCandidate("法半夏", ["制附子", "干姜", "炙甘草"]), true, "半夏反乌头类（附子）");
  assert.equal(modificationHerbIncompatibleWithCandidate("薏苡仁", ["苍术", "白术", "甘草"]), false);
  assert.equal(modificationHerbIncompatibleWithCandidate("陈皮", ["制附子", "法半夏"]), false, "方内原有的相反配对不算在新加的药头上");
  assert.deepEqual(compileM04Proposal(proposal([{ ...row1, herbName: "海藻", reason: "软坚散结" }]), prior).formula.modifications, [], "十八反的加味丢弃");
  // 边界二：流程话不算条件。
  assert.deepEqual(compileM04Proposal(proposal([{ ...row1, trigger: "若复诊时瘙痒加重" }]), prior).formula.modifications, []);
}

// ── 7c. 教材方里不入煎的药味提前告知开方模型（含目录里该方的组成）──────────────────────────────
// 实测（合成集 S128，瘾疹·胃肠湿热证，防风通圣散）：教材行自带的组成没有列全，提示里就没有这句话，
// 模型把原方的芒硝照写进汤剂药味，三轮驳回（route_not_decoction）后整方退成非剂量页。
{
  const { buildPrescribePrompt } = await jiti.import("../src/lib/diagnosis-prompts.ts");
  const row = textbook.textbookRowForSyndrome("瘾疹", "胃肠湿热证");
  assert.ok(row && row.formulas.includes("防风通圣散"), "夹具：瘾疹·胃肠湿热证的代表方是防风通圣散");
  const prompt = buildPrescribePrompt({
    id: "tb-nondecoct", patient: { sex: "男", age: 34 }, chiefComplaint: "全身风团伴腹痛1天", symptoms: {}, conversation: [],
    reasoningDiagnose: {
      schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
      overview: { tcmDiseaseName: "瘾疹", primarySyndrome: "胃肠湿热证", primarySyndromeBasis: ["全身风团，瘙痒剧烈", "腹痛，大便2日未解"], recommendedFormulaNames: [], formulaSelectionMode: "self_devised", recommendedFormulaDirection: "防风通圣散加减" },
      pathogenesis: { chain: [{ nodeId: "P1", patientFact: "全身风团，腹痛，大便未解", pathogenesis: "胃肠湿热，郁于肌肤", therapyDirection: "疏风解表，通腑泄热" }] },
      therapy: { overallMethod: "疏风解表，通腑泄热", overallPrinciple: "实则泻之" },
      westernDiagnosis: { primary: { name: "荨麻疹", supportingFacts: ["全身风团"] }, differentials: [] },
    },
  });
  assert.match(prompt, /教材方中不入煎的药味：[^\n]*芒硝[^\n]*不要写进 candidate\.herbs/);
  // 仍然写进去时，修复提示必须让模型删掉这一味——此前与「煎法未填」共用提示（「把 decoctionRequirement 原样填成…」），照做也过不了。
  const { structuredClinicalRepairHint } = await jiti.import("../src/lib/structured-clinical-repair.ts");
  const hint = structuredClinicalRepairHint("prescribe", "m04_candidate_0_herb_3_route_not_decoction", []);
  assert.match(hint, /从 candidate\.herbs 中删去这一味/);
  assert.doesNotMatch(hint, /原样填成服务端给出的煎服要求/);
  assert.match(structuredClinicalRepairHint("prescribe", "m04_candidate_0_herb_3_decoction_missing_required", []), /原样填成服务端给出的煎服要求/, "煎法未填的提示不变");
}

// ── 7d. 教材合集的 OCR 错字在读入时改正 ───────────────────────────────────────────────────────
// 生成器按原样保留了扫描错字；方名、药名要对目录、对处方，还显示给医生。此前辨证结果里出现过
// 「龙胆泻肝汤合革薢渗湿汤加减」。这里钉：读出来的方名、组成、加减药味里不再有清单内的错字。
{
  const row = textbook.textbookRowForSyndrome("湿疮", "湿热蕴肤证");
  assert.ok(row?.formulas.includes("萆薢渗湿汤"), `湿疮·湿热蕴肤证的方名应为萆薢渗湿汤：${row?.formulas}`);
  const typos = /黄苓|意苡仁|螟蚣|瓜萎|[草革]薢|莞蔚子|青箱子|桑[蝶螺]蛸|海[蝶螺]蛸|孚L香|金养麦|篇蓄|竹茄|三菱|木爪|黄氏/;
  const table = JSON.parse(fs.readFileSync(new URL("../src/data/tcm-textbook-syndrome-formula-table.json", import.meta.url), "utf8"));
  let checked = 0, rawTypos = 0;
  for (const raw of table.rows) {
    if ((raw.formulas || []).concat(raw.composition || []).some((name) => typos.test(name))) rawTypos += 1;
    const loaded = textbook.textbookRowForSyndrome(raw.disease, raw.syndromeName || raw.syndrome);
    if (!loaded) continue;
    checked += 1;
    const names = [...loaded.formulas, ...loaded.composition, ...loaded.modifications.flatMap((item) => [...item.herbs, item.raw, item.condition])];
    assert.ok(!names.some((name) => typos.test(name)), `${raw.disease}·${raw.syndromeName}：读入后仍有错字 ${names.filter((name) => typos.test(name)).join("、")}`);
  }
  assert.ok(rawTypos > 50 && checked > 1000, `夹具：生成物里确有这些错字（${rawTypos} 行），读入后逐行检查了 ${checked} 行`);
}

// ── 8. 教材病名闭集选择（textbook-disease-pick.server.ts）──────────────────────────────────────
// 主诉的说法是开放的；词表桥接在 172 例带教材答案的合成病例上只把 79% 对到正确的教材病名（「胃脘刺痛」
// 「腰部冷痛」「不爱吃饭」「便后滴血」都对不上），闭集选择后 98.8%。这里钉：只收清单里的名字；点名的病排在候选最前；
// 没有点名时候选与改动前一致；同名病按书的先后取节；选择不可用时返回空数组。
{
  const { parseTextbookDiseasePick, pickTextbookDiseasesForCase } = await jiti.import("../src/lib/textbook-disease-pick.server.ts");
  const names = textbook.textbookDiseaseNamesForCase({ sex: "女", ageYears: 40 });
  assert.ok(names.includes("胃痛") && names.includes("月经后期") && !names.includes("厌食"), "成年女性：有内科、妇科病名，没有儿科独有的病名");
  assert.ok(!textbook.textbookDiseaseNamesForCase({ sex: "男", ageYears: 40 }).includes("月经后期"), "男性不取妇科病名");
  assert.ok(textbook.textbookDiseaseNamesForCase({ sex: "男", ageYears: 5 }).includes("厌食"), "儿童取儿科病名");
  const allowed = new Set(names);
  assert.deepEqual(parseTextbookDiseasePick('{"diseases":["胃痛","慢性胃炎（自拟）","胃痛","腹痛","泄泻","便秘"]}', allowed), ["胃痛", "腹痛", "泄泻"], "清单外的名字丢弃、去重、最多 3 个");
  for (const bad of ["", "不是JSON", '{"diseases":"胃痛"}', '{"names":["胃痛"]}', null]) {
    assert.deepEqual(parseTextbookDiseasePick(bad, allowed), [], `非法输出按空处理：${bad}`);
  }
  // 词表对不上的主诉：没有点名时取不到这个病，点名后排在最前并给出它的教材证型。
  const stabbing = { chiefComplaint: "胃脘刺痛3月", presentHistory: "3个月来胃脘部刺痛，痛处固定，夜间明显。", sex: "男", ageYears: 50 };
  assert.ok(!textbook.textbookCandidatesForCase(stabbing).some((item) => item.disease === "胃痛"), "夹具：词表桥接对不上「胃脘刺痛」");
  const picked = textbook.textbookCandidatesForCase({ ...stabbing, preferredDiseases: ["胃痛", "不存在的病名"] });
  assert.equal(picked[0]?.disease, "胃痛");
  assert.ok(picked[0].rows.some((row) => row.syndromeName === "瘀血停滞证"), "点名的病给出它的教材证型");
  assert.match(textbook.buildTextbookCandidateContext({ ...stabbing, preferredDiseases: ["胃痛"] }), /◆ 胃痛（《中医内科学》）[\s\S]*瘀血停滞证/);
  // 「反复感冒」说的是体质：主诉只有这种说法时，点名的「感冒」不作数，虚劳排最前（甲方标准病历 5：反复感冒1+年 → 虚劳·肺脾两虚；
  // 闭集选择把感冒排第一时，三次生成都落到「气虚感冒·参苏饮」）。本次确有外感说法的不受影响。
  const habitual = { chiefComplaint: "反复感冒1+年", presentHistory: "近一年感冒约九次。平素易疲乏、短气自汗、声音低怯，食欲下降，大便稀溏。", sex: "女", ageYears: 78 };
  assert.equal(textbook.textbookCandidatesForCase({ ...habitual, preferredDiseases: ["感冒", "虚劳"] })[0]?.disease, "虚劳");
  assert.ok(!textbook.textbookCandidatesForCase({ ...habitual, preferredDiseases: ["感冒"] }).slice(0, 1).some((item) => item.disease === "感冒"));
  assert.equal(textbook.textbookCandidatesForCase({ chiefComplaint: "感冒发热、鼻塞流涕3天，平素容易感冒", presentHistory: "恶寒发热，鼻塞流清涕。", preferredDiseases: ["感冒"] })[0]?.disease, "感冒");
  // 没有点名：候选与不带该字段时逐字相同。
  assert.equal(
    textbook.buildTextbookCandidateContext({ ...CASES[0], preferredDiseases: [] }),
    textbook.buildTextbookCandidateContext({ ...CASES[0] }),
  );
  // 同名病在几本教材里各有一节：成人取内科（便秘「气秘」），与按病名取节同一个顺序。
  const constipation = textbook.textbookCandidatesForCase({ chiefComplaint: "便秘半年", presentHistory: "大便干结，排便困难，嗳气频作，胁腹胀满。", sex: "女", ageYears: 45 });
  const section = constipation.find((item) => item.disease === "便秘");
  assert.equal(section?.book, "中医内科学", "成人便秘取内科一节");
  // 未配置模型 / 已中止 / 开关关闭：返回空数组，不抛错。
  const state = { chiefComplaint: "胃脘刺痛3月", patient: { sex: "男", age: 50 }, symptoms: { presentHistory: "胃脘刺痛" }, conversation: [] };
  const saved = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "BAILIAN_QWEN_API_KEY", "CONTROLLED_TERMINOLOGY_MODEL"]) delete process.env[key];
  assert.deepEqual(await pickTextbookDiseasesForCase(state), [], "未配置时返回空数组");
  process.env.CDSS_TEXTBOOK_DISEASE_PICK = "false";
  assert.deepEqual(await pickTextbookDiseasesForCase(state), [], "开关关闭时返回空数组");
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
}

console.log("textbook syndromes: ok", stats);
