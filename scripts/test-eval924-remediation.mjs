// 甲方 9.24 + 9.27 医学测评整改（2026-09-29）。
//
// 每条断言对应测评里的一个截图问题，且都带反证（把改动撤掉/换成对照输入后断言必须变红）。
// 输入取自生产同配置模型的真实输出（scripts/fixtures/eval924）与测评病例的签名结论，不是合成的乐观样例。
//
//   1 方解：模型原文 9/9 被旧校验（药名子串误判）整段丢弃 → 现在保留，只删真正的外来药分句
//   2 兜底方解句式与药味功效适用门（当归「调经止痛」进头痛方、甘草「祛痰止咳」进麻黄汤）
//   3 治则：只写「治病求本」→ 按已签名病性补具体治则
//   4 随证加减：最终出口去掉「加的药已在方中」；对应病机不再整段粘贴无关节点
//   5 过敏史/现用药：已记录不得说「未提及」
//   6 中医病名鉴别只收中医病名（流感 → 时行感冒）；西医鉴别共用词尾补全
//   7 有限结果：治法栏不写操作指引
//   8 煎服法：命名方按教材；无命名方按主治法；清热不归攻下
//   9 方名反查只用常用层；自拟方出处写组方参考；目录出处订正
//  10 非药物治疗教材方案：取穴/食疗/导引，证型相符、证据门、药食同源、无穴项目不说取穴
//  11 同一病历只算一次：并入/复用/断开不中止/显式重新生成
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

process.env.CDSS_STAGE_RESULT_REUSE = "true";

const failures = [];
let checks = 0;
const check = async (name, fn) => {
  checks += 1;
  try { await fn(); } catch (error) { failures.push({ name, message: String(error?.message || error).slice(0, 700) }); }
};
const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = (json) => `${START}\n${JSON.stringify(json)}\n${END}`;
const unwrap = (text) => {
  const start = text.indexOf(START) + START.length;
  return JSON.parse(text.slice(start, text.indexOf(END, start)));
};
const withEnv = async (key, value, fn) => {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
};

// ── 1 方解 ─────────────────────────────────────────────────────────────────
const review = await jiti.import("../src/lib/formula-analysis-review.ts");
const drafts = JSON.parse(readFileSync(new URL("./fixtures/eval924/formula-analysis-model-drafts.json", import.meta.url), "utf8")).drafts;

await check("1.1 模型原文 18/18 可用（旧校验 17/18 判为外来药：杏仁/地黄/枣仁/银花/屏风/煅龙齿/酒黄芩/菖蒲/木通）", () => {
  let unusable = 0;
  for (const draft of drafts) {
    const result = review.reviewAuthoredFormulaAnalysis(draft.authored, draft.herbs, {});
    if (!result.usable) unusable += 1;
    assert.equal(result.foreignHerbs.length, 0, `本方药味被当成外来药：${result.foreignHerbs}（${draft.herbs.join("、")}）`);
    // 方解正文保持模型原意：只允许去 Markdown/节点编号，不得丢分句
    assert.ok(result.text.length >= draft.authored.length * 0.9, "模型方解不得被大段删除");
  }
  assert.equal(unusable, 0);
  assert.ok(drafts.filter((draft) => draft.rejectedBefore.startsWith("foreign_herb")).length >= 15, "夹具应包含旧校验的误判样本");
});

await check("1.2 反证：方中确实没有的药只删那一个分句，其余原文保留", () => {
  const draft = drafts[0]; // 麻黄汤加辛夷
  const herbsWithoutXinyi = draft.herbs.filter((name) => name !== "辛夷");
  const result = review.reviewAuthoredFormulaAnalysis(draft.authored, herbsWithoutXinyi, {});
  assert.ok(result.foreignHerbs.includes("辛夷"), "辛夷不在本方，应被识别为外来药");
  assert.ok(!result.text.includes("辛夷"), "提到外来药的分句应被删掉");
  assert.ok(result.text.includes("麻黄") && result.text.includes("桂枝"), "其余分句必须保留");
  assert.ok(result.usable);
});

await check("1.3 「去某药」说明加减不算外来药；节点编号 P1 被清掉", () => {
  const herbs = ["黄芪", "白术", "防风", "党参"];
  const text = "本方取玉屏风散之意，黄芪为君，固表益气，白术为臣，健脾助运，防风为佐使，祛风而不留邪，去原方之外无须再加党参以外之品；直入P1以固卫表。";
  const result = review.reviewAuthoredFormulaAnalysis(text, herbs, { nodeLabels: { P1: "肺气不足" } });
  assert.ok(!/P\d/.test(result.text), `内部节点编号必须清掉：${result.text}`);
  assert.equal(result.foreignHerbs.length, 0, `「玉屏风散」里的「屏风」不是外来药：${result.foreignHerbs}`);
  const exempt = review.reviewAuthoredFormulaAnalysis("黄芪为君补气固表，白术为臣健脾助运，防风为佐祛风，较原方去当归而不用，重在固表。", herbs, {});
  assert.equal(exempt.foreignHerbs.length, 0, "「去当归」是说明加减，不得算成方中有当归");
});

await check("1.4 反证：逐味整段贴病机的灌水文本交给服务端兜底", () => {
  const filler = "心肾阴虚虚火内扰心神神不守舍故见心悸失眠";
  const text = `方中黄芪为君，${filler}；白术为臣，${filler}；防风为佐使，${filler}。助君药相使配伍。`;
  const result = review.reviewAuthoredFormulaAnalysis(text, ["黄芪", "白术", "防风"], {});
  assert.equal(result.usable, false);
  assert.ok(result.adjustments.includes("repeated_narrative"));
});

// ── 2 兜底方解句式与功效适用门 ──────────────────────────────────────────────
const target = await jiti.import("../src/lib/herb-target-contract.ts");
const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");

await check("2.1 兜底方解不再出现「取其…之长，直治」与「配合方中药味承接该病机」", () => {
  const text = target.buildFormulaAnalysis([
    { name: "麻黄", role: "君", function: "发汗解表，宣肺平喘，利水消肿", targetPathogenesis: "肺主皮毛，开窍于鼻，风寒束表，肺气失宣", therapyDirection: "辛温解表，宣肺散寒" },
    { name: "杜仲", role: "佐", function: "", targetPathogenesis: "肾气不足，腰府失养" },
    { name: "炙甘草", role: "使", function: "补脾益气，祛痰止咳，缓急止痛，调和诸药", targetPathogenesis: "调和诸药" },
  ], "辛温解表，宣肺散寒", "淋雨感寒 恶寒发热 鼻塞流涕 稍有咳嗽");
  assert.ok(!/之长|直治|承接该病机|配合方中药味/.test(text), `模板句式必须去掉：${text}`);
  assert.ok(/炙甘草/.test(text) && /调和/.test(text), `使药甘草应取「调和」类功效：${text}`);
  assert.ok(!/炙甘草[^。；]*祛痰止咳/.test(text), `甘草不得因治法里有「咳」字被写成祛痰止咳：${text}`);
});

await check("2.2 药味功效适用门：头痛方里的当归不写调经止痛；有痛经上下文时才可以", () => {
  const gated = knowledge.getTcmHerbFunctionDisplayText("当归", "佐", "气血两虚，清窍失养，头痛", "益气养血，通络止痛", false);
  assert.ok(!gated.includes("调经"), `无经带症状时不得选调经止痛：${gated}`);
  const withCase = knowledge.getTcmHerbFunctionDisplayText("当归", "佐", "寒凝血瘀，经行腹痛，痛经", "温经散寒，活血止痛", false);
  assert.ok(withCase.includes("调经") || withCase.includes("活血"), `有痛经上下文时应保留妇科功效：${withCase}`);
});

await check("2.3 使药炙甘草的功用栏：库里有「调和诸药」就取它，不再落成「需医生结合方义复核」占位句（「调和诸药」以「药」结尾，不是药类分类标签）", () => {
  const text = knowledge.getTcmHerbFunctionDisplayText("炙甘草", "使", "调和诸药，协调药性", "辛温解表，宣肺散寒", true);
  // 核对词典（药典2020 炙甘草功能 + 方剂学使药角色）给出「益气和中，调和诸药」；不得重复、不得有占位句，也不得带生甘草的清热解毒/祛痰止咳。
  assert.equal(text, "益气和中，调和诸药");
  assert.doesNotMatch(text, /清热解毒|祛痰止咳|需医生结合方义复核/);
});

// ── 3 治则 ─────────────────────────────────────────────────────────────────
const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const principleOf = (principle, nature, syndrome = "肾阴不足证", method = "滋补肾阴，强腰壮骨") => {
  const out = unwrap(summary.applyDeterministicTreatmentPrinciple(wrap({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    overview: { tcmDiseaseName: "腰痛", primarySyndrome: syndrome, overallTherapy: method, secondarySyndromes: [] },
    pathogenesis: { natureDifferentiation: nature, chain: [] },
    therapy: { overallPrinciple: principle, overallMethod: method, subTherapies: [] },
  })));
  return out.therapy.overallPrinciple;
};

await check("3.1 只写总纲「治病求本」时按已签名病性补具体治则（腰痛肾阴虚 → 虚则补之）", () => {
  const result = principleOf("治病求本", { items: ["肾阴虚"], rootDeficiency: ["肾阴不足"], branchExcess: [] });
  assert.match(result, /^虚则补之（滋补肾阴）/);
  assert.match(result, /治病求本/, "原总纲保留在后");
});

await check("3.2 反证：模型已写具体治则时原样保留；总纲+病性未定时不编造", () => {
  assert.equal(principleOf("寒者热之，温散祛邪", { items: ["寒"], rootDeficiency: [], branchExcess: ["寒"] }), "寒者热之，温散祛邪");
  assert.equal(principleOf("治病求本", { items: [], rootDeficiency: [], branchExcess: [] }, "", ""), "治病求本");
});

// ── 4 随证加减 ────────────────────────────────────────────────────────────
const modSafety = await jiti.import("../src/lib/m04-modification-safety.ts");
await check("4.1 最终出口：「加」的药已在方中即删（熟地黄）；不在方中的照留（反证）", () => {
  const prior = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "肾阴不足证" },
    westernDiagnosis: { primary: { supportingFacts: [{ fact: "口燥咽干", kind: "symptom" }] } },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "腰部隐痛，口燥咽干", syndromeEvidence: "腰部隐痛，口燥咽干", pathogenesis: "肾阴不足，腰府失养", therapyDirection: "滋补肾阴" }] },
    therapy: { overallMethod: "滋补肾阴", subTherapies: [] },
  };
  const content = wrap({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: {
      candidates: [{ name: "六味地黄丸加减", herbs: [{ name: "熟地黄", dose: "15g" }, { name: "山药", dose: "12g" }] }],
      modifications: [
        { trigger: "口燥咽干", targetPathogenesis: "肾阴不足", action: "加", herbName: "熟地黄", reason: "滋阴" },
        { trigger: "口燥咽干", targetPathogenesis: "肾阴不足", action: "加", herbName: "麦冬", reason: "养阴生津" },
      ],
    },
  });
  const out = unwrap(modSafety.dropUnsupportedM04ModificationDirections(content, prior));
  const names = out.formula.modifications.map((item) => item.herbName || "");
  assert.ok(!names.includes("熟地黄"), `方中已有熟地黄，不得再建议加：${names}`);
  assert.ok(names.includes("麦冬"), "方中没有的药照留（反证）");
});

const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
await check("4.2 对应病机：模型给的本症病机优先；与节点无交集的兼症写「兼见某症」，不再整段贴节点原文", () => {
  const node = { pathogenesis: "脾气虚弱，运化失健，水谷不化，故见纳差便溏", syndromeEvidence: "纳差，大便溏薄", patientFact: "纳差，大便溏薄", therapyDirection: "健脾益气" };
  const cleanNarrative = (value, fallback) => value || fallback;
  const authored = compiler.modificationTargetPathogenesis({ trigger: "小便清长", targetRef: "P1", reason: "温肾缩尿", symptomPathogenesis: "肾气不固，膀胱失约" }, node, cleanNarrative);
  assert.equal(authored, "肾气不固，膀胱失约", "模型写的本症病机（与触发症状相关）优先");
  const unrelated = compiler.modificationTargetPathogenesis({ trigger: "小便清长", targetRef: "P1", reason: "温肾缩尿" }, node, cleanNarrative);
  assert.equal(unrelated, "兼见小便清长", `症状与节点无关时不得贴节点原文：${unrelated}`);
  const own = compiler.modificationTargetPathogenesis({ trigger: "大便溏薄", targetRef: "P1", reason: "健脾止泻" }, node, cleanNarrative);
  assert.ok(own.startsWith("脾气虚弱"), `症状本就是该节点的表现时取节点主干：${own}`);
  assert.ok(!own.includes("故见"), `不再整段粘贴：${own}`);
  assert.ok(compiler.M04ProposalSchema.safeParse({}).success === false);
});

// ── 5 过敏史/现用药 ────────────────────────────────────────────────────────
const history = await jiti.import("../src/lib/record-history-consistency.ts");
await check("5.1 病历已记录否认药物过敏，「当前用药与过敏史未提及」里的过敏史被摘掉；用药未记录仍提示", () => {
  const fields = history.recordedHistoryFields({ allergyHistory: "否认药物过敏史，否认食物过敏史", pastHistory: "既往体健" });
  assert.deepEqual(fields, { allergy: true, medication: false, pastHistory: true });
  const out = history.reconcileRecordedHistoryClaims("当前用药与过敏史未提及，若患者正在服用其他药物请医生在采纳前核实。", fields);
  assert.ok(!/过敏/.test(out), `已记录的过敏史不得再说未提及：${out}`);
  assert.ok(/用药/.test(out), `用药确实没记录，仍应提示：${out}`);
});

await check("5.2 反证：过敏史确实没记录时，原句不动；整句只谈已记录项则整句删除", () => {
  const none = history.recordedHistoryFields({ allergyHistory: "", medicationHistory: "" });
  const sentence = "当前用药与过敏史未提及，请医生核实。";
  assert.equal(history.reconcileRecordedHistoryClaims(sentence, none), sentence);
  const fields = history.recordedHistoryFields({ allergyHistory: "否认药物过敏史" });
  assert.equal(history.reconcileRecordedHistoryClaims("过敏史未提及，请核实。注意休息。", fields), "注意休息。");
});

// ── 6 病名鉴别 ────────────────────────────────────────────────────────────
const tcmNames = await jiti.import("../src/lib/tcm-disease-differential-normalization.ts");
await check("6.1 中医病名鉴别栏：流感 → 时行感冒；带状疱疹 → 蛇串疮；荨麻疹 → 瘾疹", () => {
  assert.deepEqual(tcmNames.resolveTcmDiseaseDifferentialName("流感", "感冒"), { action: "rename", name: "时行感冒", from: "流感" });
  assert.equal(tcmNames.resolveTcmDiseaseDifferentialName("带状疱疹", "胁痛").name, "蛇串疮");
  assert.equal(tcmNames.resolveTcmDiseaseDifferentialName("荨麻疹", "湿疮").name, "瘾疹");
});

await check("6.2 反证：真正的中医病名（怔忡/鼻渊）原样保留；归一不了的西医病名丢弃；与当前病名相同的丢弃", () => {
  assert.equal(tcmNames.resolveTcmDiseaseDifferentialName("怔忡", "心悸").action, "keep");
  assert.equal(tcmNames.resolveTcmDiseaseDifferentialName("鼻渊", "感冒").action, "keep");
  assert.equal(tcmNames.resolveTcmDiseaseDifferentialName("肋间神经痛", "蛇串疮").action, "drop");
  assert.equal(tcmNames.resolveTcmDiseaseDifferentialName("感冒", "感冒").action, "drop");
});

await check("6.3 投影：整份 M03 载荷里的病名鉴别逐条归一并去重", () => {
  const out = unwrap(tcmNames.normalizeM03TcmDiseaseDifferentialNames(wrap({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: {
      tcmDiseaseName: "感冒",
      tcmDiseaseDifferentials: [
        { diseaseName: "流感", reason: "流感与感冒需鉴别", distinguishingPoints: "无", typicalManifestation: "x", nextCheck: "y" },
        { diseaseName: "急性胃炎", reason: "r", distinguishingPoints: "d", typicalManifestation: "x", nextCheck: "y" },
        { diseaseName: "时行感冒", reason: "r2", distinguishingPoints: "d2", typicalManifestation: "x", nextCheck: "y" },
      ],
    },
  })));
  const names = out.overview.tcmDiseaseDifferentials.map((row) => row.diseaseName);
  assert.deepEqual(names, ["时行感冒"], `西医病名归一、无法归一的丢弃、重复去重：${names}`);
  assert.ok(out.overview.tcmDiseaseDifferentials[0].reason.includes("时行感冒"), "理由里的旧名同步替换");
});

await check("6.4 西医鉴别名共用词尾补全：房性/室性早搏 不再出现「房性」碎片", () => {
  const out = unwrap(summary.normalizeM03WesternDifferentials(wrap({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    westernDiagnosis: {
      primary: { name: "心律失常，待查", status: "证据有限", confidence: "低", supportingFacts: [], evidence: {} },
      differentials: [{ name: "房性/室性早搏", reason: "r", distinguishingPoints: "d", nextCheck: "n" }],
    },
  }), "患者心悸3月", 40));
  const names = out.westernDiagnosis.differentials.map((row) => row.name);
  assert.ok(!names.includes("房性"), `不得出现词尾缺失的碎片：${names}`);
  assert.ok(names.some((name) => name.includes("房性早搏")) && names.some((name) => name.includes("室性早搏")), `共用词尾应补全：${names}`);
});

await check("6.5 接线：M03 后处理链里必须真的调用病名鉴别归一，且其输出喂给下一步（源码级，反证由变异钉住）", () => {
  const source = readFileSync(new URL("../src/lib/diagnosis-api.ts", import.meta.url), "utf8");
  assert.match(source, /const tcmDifferentialNamed = phase\("tcm_disease_differentials", normalizeM03TcmDiseaseDifferentialNames\(westernProjection\)\);/);
  assert.match(source, /alignNormalizedM03WesternClinicalRationale\(tcmDifferentialNamed\)/, "归一结果必须继续往下传，不能算完就丢");
});

// ── 7 有限结果 ────────────────────────────────────────────────────────────
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
await check("7.1 有限结果的治法栏是临床状态，不再是「重新运行辨病辨证分析；已录入病历无需修改」", () => {
  const reasoning = safety.buildSafetyLimitedDiagnosisReasoning(
    { id: "c", patient: {}, chiefComplaint: "心悸", conversation: [], symptoms: {}, completeness: { level: "C" } },
    { status: "needs_information", allowDiagnosis: true, allowDosePrescription: false, redFlags: [], missingItems: [], reasons: ["模型服务暂时不可用"] },
  );
  assert.ok(!/重新运行|无需修改/.test(reasoning.overview.overallTherapy), reasoning.overview.overallTherapy);
  assert.ok(reasoning.management.followupSafetyNet.length > 0, "下一步操作仍写在随访安全网里");
});

// ── 8 煎服法 ────────────────────────────────────────────────────────────
const decoctionOf = (name, formulaName, subTherapies, overallMethod, constructionType = "single_base") => {
  const out = unwrap(summary.applyDeterministicDecoctionMethod(wrap({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    therapy: { overallMethod, overallPrinciple: "", subTherapies },
    formula: { candidates: [{
      name, therapyMatch: overallMethod, constructionType,
      formulaNames: formulaName ? [formulaName] : [],
      herbs: [{ name: "甘草", dose: "6g" }],
      decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2 },
    }] },
  }), "患者，男，30岁", 30));
  return out.formula.candidates[0].decoction;
};

await check("8.1 银翘散（辛凉平剂）：不啜粥、不覆被，勿过煮（教材原文）", () => {
  const d = decoctionOf("银翘散", "银翘散", [{ therapy: "辛凉透表，清热解毒", priority: "主要" }], "辛凉透表，清热解毒");
  assert.ok(!/少进热粥|加衣覆被/.test(d.administration), d.administration);
  assert.ok(/勿过煮|不宜久煎/.test(d.method), d.method);
  assert.ok(d.firstDecoctionMinutes <= 15);
});

await check("8.2 麻黄汤：温覆取微汗、不须啜粥；桂枝汤才啜热粥（反证：两者必须不同）", () => {
  // 治法只写「解表散邪」这类不含辛温/解肌线索的泛称：分档只能靠命名方的教材档案（去掉档案两个断言都会变红）。
  const mahuang = decoctionOf("麻黄汤", "麻黄汤", [{ therapy: "解表散邪", priority: "主要" }], "解表散邪");
  const guizhi = decoctionOf("桂枝汤", "桂枝汤", [{ therapy: "解表散邪", priority: "主要" }], "解表散邪");
  assert.match(mahuang.administration, /覆被取微汗，不须啜热粥/);
  assert.match(guizhi.administration, /少进热粥/);
  assert.ok(!/不须啜/.test(guizhi.administration));
});

await check("8.3 清胃散治法「清胃泻火，兼以生津通腑」：清热档饭后服，不被兼治的「通腑」抢成攻下档", () => {
  const d = decoctionOf("清胃散加减", "", [
    { therapy: "清胃泻火，凉血止痛", priority: "主要" },
    { therapy: "生津通腑", priority: "次要" },
  ], "清胃泻火，兼以生津通腑", "self_devised");
  assert.match(d.administration, /饭后/);
  assert.ok(!/得利即停|空腹/.test(d.administration), d.administration);
});

await check("8.4 反证：主治法本身是攻下时仍走攻下档；补益档仍是饭前空腹", () => {
  const purge = decoctionOf("大承气汤", "", [{ therapy: "攻下热结，荡涤肠胃", priority: "主要" }], "攻下热结", "self_devised");
  assert.match(purge.administration, /得利即停/);
  const tonic = decoctionOf("X", "", [{ therapy: "益气养血，健脾补虚", priority: "主要" }], "益气养血", "self_devised");
  assert.match(tonic.administration, /饭前|空腹/);
});

// ── 9 方名反查 / 出处 ──────────────────────────────────────────────────────
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
await check("9.1 反查命名只用常用层：0070 的十味组成不再被冷僻的益气培元饮（目录只录6味）冠名「加味」，改回六味地黄丸加味；关闭分层开关则复现旧行为（反证）", async () => {
  const herbs = ["熟地黄", "杜仲", "牡丹皮", "茯苓", "山药", "泽泻", "山茱萸", "续断", "枸杞子", "菟丝子"].map((name) => ({ name }));
  const tiered = provenance.identifyGovernedFormulaByComposition(herbs);
  assert.match(tiered?.displayName || "", /六味地黄丸/, `常用层内命名：${tiered?.displayName}`);
  await withEnv("CDSS_FORMULA_LOCK_TIER", "false", () => {
    const untiered = provenance.identifyGovernedFormulaByComposition(herbs);
    assert.match(untiered?.displayName || "", /益气培元饮/, `旧行为应复现（证明断言抓得住）：${untiered?.displayName}`);
  });
});

await check("9.2 自拟方出处：写「组方参考：某方（《出处》）加减」，找不到常用成方时写自拟方，不再是工程话术", () => {
  const references = provenance.selfDevisedFormulaReferences(["熟地黄", "山茱萸", "山药", "牡丹皮", "茯苓", "泽泻", "知母", "黄柏"]);
  assert.ok(references.some((item) => /地黄丸/.test(item.name)), `应参考六味/知柏地黄丸：${JSON.stringify(references)}`);
  assert.deepEqual(provenance.selfDevisedFormulaReferences(["朱砂", "冰片", "麝香"]), [], "无关组成不得硬凑参考");
});

await check("9.4 自拟方候选的出处栏：有近似常用成方写「组方参考」，没有写「自拟方」；两者都不再是工程话术", () => {
  const candidateFor = (herbs) => ({
    name: "本例辨证组方", formulaNames: [], constructionType: "self_devised", modificationStatus: "modified",
    therapyMatch: "滋补肾阴", formulaAnalysis: "滋补肾阴为主，兼清虚热。", applicable: "适用于肾阴不足证。", notApplicable: "证候变化时暂停。",
    formulaSource: { evidenceLevel: "model_inference", source: "占位", confidence: "中" },
    baseFormulas: [], herbs: herbs.map((name) => ({ name, dose: "9g", role: "君", function: "滋阴" })),
  });
  const sourceOf = (herbs) => provenance.enrichReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [candidateFor(herbs)] } })
    .reasoning.formula.candidates[0].formulaSource.source;
  const near = sourceOf(["熟地黄", "山茱萸", "山药", "牡丹皮", "茯苓", "泽泻", "知母", "黄柏"]);
  assert.match(near, /^自拟方，组方参考：.*地黄丸/, near);
  assert.ok(!/结构化匹配/.test(near));
  const none = sourceOf(["朱砂", "冰片", "麝香", "珍珠"]);
  assert.match(none, /^自拟方，按本例证候/, none);
  assert.ok(!/组方参考/.test(none));
});

const catalog = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-governed-catalog.json", import.meta.url), "utf8"));
await check("9.3 目录出处订正：龙胆泻肝汤《医方集解》等已联网核对的五首；反证：出处仍有争议的不动", () => {
  const source = (name) => catalog.entries.find((entry) => entry.name === name)?.source;
  assert.equal(source("龙胆泻肝汤"), "《医方集解》");
  assert.equal(source("血府逐瘀汤"), "《医林改错》");
  assert.equal(source("清营汤"), "《温病条辨》");
  assert.equal(source("三子养亲汤"), "《韩氏医通》");
  assert.equal(source("回阳救急汤"), "《伤寒六书》");
  assert.equal(source("六味地黄丸"), "《小儿药证直诀》", "没订正的方保持原样");
});

// ── 10 非药物治疗教材方案 ──────────────────────────────────────────────────
process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = "acupuncture,moxibustion,cupping,guasha,auricular,tuina,diet_therapy,qigong_daoyin,mind_therapy";
const treatments = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
const plans = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
const evidence = { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" };
const signedPrior = ({ disease, syndrome, secondary = [], method, western = "症状性问题", patientFact, pathogenesis }) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  contractSignatureVersion: "tcm-cdss-m03-signature-v5",
  contractSignature: `hmac-sha256:${"a".repeat(64)}`,
  overview: { tcmDiseaseName: disease, primarySyndrome: syndrome, secondarySyndromes: secondary, overallPathogenesis: pathogenesis, overallTherapy: method, evidence },
  westernDiagnosis: { primary: { name: western, status: "证据有限", confidence: "低", supportingFacts: [], evidence }, differentials: [] },
  pathogenesis: { summary: pathogenesis, locationDifferentiation: { items: [], evidence }, natureDifferentiation: { items: [], evidence }, chain: [{ nodeId: "P1", patientFact, syndromeEvidence: patientFact, pathogenesis, therapyDirection: method, evidence }], uncertainties: [] },
  therapy: { overallPrinciple: method, overallMethod: method, subTherapies: [{ therapy: method, targetPathogenesis: pathogenesis, priority: "主要", evidence }] },
  formula: null, nonPharma: null, lineageAdaptation: null,
});
const caseOf = (chief, present) => ({
  patient: { sex: "男", age: 36 }, chiefComplaint: chief, symptoms: { presentHistory: present }, conversation: [],
  safetyGate: { status: "ready", allowDosePrescription: true, redFlags: [], missingItems: [] },
});
const compile = (prior, caseState, codes) => treatments.compileTcmTreatmentRecommendations(codes.map((projectCode) => ({ projectCode, targetRef: "P1" })), prior, caseState);
const cardFor = (cards, code) => cards.find((card) => card.projectCode === code);

const herpes = signedPrior({ disease: "蛇串疮", syndrome: "肝胆湿热蕴结", secondary: ["气滞血瘀"], method: "清热利湿，泻火解毒", pathogenesis: "肝胆湿热蕴结，气滞血瘀", patientFact: "右胁肋部簇集水疱伴灼热刺痛，口苦，心烦易怒" });
const herpesCase = caseOf("右胁肋部水疱伴疼痛5天", "右胁肋部簇集水疱，灼热刺痛，口苦，心烦易怒，舌红，苔黄腻，脉弦数");
await check("10.1 蛇串疮（评估卡→教材方案）：主穴阿是穴/夹脊，证型相符加行间/大敦，症状触发加神门，来源带书名与行号", () => {
  const card = cardFor(compile(herpes, herpesCase, ["acupuncture"]), "acupuncture");
  assert.ok(card, "应给出针刺卡片");
  assert.equal(card.protocolStatus, "governed_patient_specific_plan");
  const sites = card.suggestedSitesOrPoints.join("；");
  assert.match(sites, /阿是穴/);
  assert.match(sites, /夹脊/);
  assert.match(sites, /行间/);
  assert.match(sites, /大敦/);
  assert.match(card.protocolSource, /《针灸治疗学》.*高树中.*教材原文第\d+行/);
  assert.equal(card.executable, false);
  assert.equal(card.clinicianReviewRequired, true);
  assert.ok(card.scheduleSuggestion.length > 0);
  assert.ok(!/取穴模板|不形成操作计划/.test(card.treatmentContent), card.treatmentContent);
});

await check("10.2 反证：证型对不上（胃火证）不按肝经郁热加穴；本例没有病历事实时一律不按证型加减", () => {
  const stomachFire = signedPrior({ disease: "蛇串疮", syndrome: "胃火炽盛证", method: "清胃泻火", pathogenesis: "胃火炽盛", patientFact: "右胁肋部水疱，口臭便秘" });
  const card = cardFor(compile(stomachFire, caseOf("右胁肋部水疱", "右胁肋部簇集水疱，口臭，便秘"), ["acupuncture"]), "acupuncture");
  assert.ok(card);
  assert.ok(!/行间|大敦/.test(card.suggestedSitesOrPoints.join("；")), "胃火证不得加肝经郁热的配穴");
  const noFacts = cardFor(compile(herpes, undefined, ["acupuncture"]), "acupuncture");
  assert.ok(!noFacts || noFacts.protocolStatus !== "governed_patient_specific_plan", "没有病历事实时不得按证型加减");
});

await check("10.3 教材没有的病名（白癜风）仍是评估态，不套别的病的穴位", () => {
  const vitiligo = signedPrior({ disease: "白癜风", syndrome: "肝郁气滞证", method: "疏肝解郁", pathogenesis: "肝郁气滞", patientFact: "皮肤白斑" });
  const cards = compile(vitiligo, caseOf("皮肤白斑", "皮肤白斑，无痒"), ["acupuncture"]);
  for (const card of cards) assert.equal(card.protocolStatus, "assessment_only_no_patient_specific_protocol", `${card.projectCode}: ${card.protocolStatus}`);
});

await check("10.4 食疗：无穴项目，方案要点写进正文，suggestedSitesOrPoints 为空，正文不说取穴；含麻黄附子等药材的食谱整方不出", () => {
  const deficiency = signedPrior({ disease: "虚劳", syndrome: "肺气虚", method: "补益肺气", pathogenesis: "肺气亏虚，卫外不固", patientFact: "咳嗽无力，气短，自汗，易感冒，动则加重" });
  const card = cardFor(compile(deficiency, caseOf("反复感冒伴气短乏力", "咳嗽无力，气短，自汗，动则加重，易感冒"), ["diet_therapy"]), "diet_therapy");
  assert.ok(card, "应给出食疗卡片");
  assert.deepEqual(card.suggestedSitesOrPoints, []);
  assert.ok(!/取穴|穴位/.test(card.treatmentContent), card.treatmentContent);
  assert.ok(!/麻黄|附子|乌头|马钱子/.test(card.treatmentContent), "含毒性药材的食谱不得进入方案");
  assert.match(card.protocolSource, /《中医食疗学》/);
});

await check("10.5 药食同源过滤：麻黄附子粥/含川芎白芷/当归主料的食谱整方拒绝；姜糖苏叶饮通过（对照）", () => {
  assert.equal(plans.recipeUsesOnlyFoodSafeIngredients("麻黄3g，制附子3g，干姜3g，粳米50g，葱白2茎，红糖少许。将麻黄、附子、干姜研为极细粉末。"), false);
  assert.equal(plans.recipeUsesOnlyFoodSafeIngredients("川芎10g，白芷10g，鱼头1个。同炖。"), false);
  assert.equal(plans.recipeUsesOnlyFoodSafeIngredients("当归30g，羊肉500g，生姜10g。炖汤。"), false, "当归仅作香辛料和调味品（2019年第8号公告），不得作主料");
  assert.equal(plans.recipeUsesOnlyFoodSafeIngredients("苏叶、生姜各3g，红糖15g。生姜、苏叶洗净切成细丝，放入锅内，以沸水冲泡，加盖温浸10分钟即成。"), true);
});

await check("10.6 全部食谱：通过过滤的食谱里不存在麻黄/附子/川乌/草乌/马钱子/半夏/细辛（1200+ 条逐条扫）", () => {
  const data = JSON.parse(readFileSync(new URL("../src/data/tcm-nondrug-textbook-protocols.json", import.meta.url), "utf8"));
  let passed = 0;
  let total = 0;
  for (const entry of data.diet) for (const syndrome of entry.syndromes) for (const recipe of syndrome.recipes) {
    total += 1;
    if (!plans.recipeUsesOnlyFoodSafeIngredients(recipe.text)) continue;
    passed += 1;
    const ingredientSentence = recipe.text.split("。")[0];
    assert.ok(!/麻黄|附子|川乌|草乌|马钱子|半夏|细辛|雄黄|朱砂/.test(ingredientSentence), `${recipe.name} 含毒性药材却通过了过滤：${ingredientSentence}`);
  }
  assert.ok(total >= 1000 && passed > 100 && passed < total, `过滤应有实际作用：${passed}/${total}`);
});

await check("10.7 气功导引：无穴项目，条目来自国家体育总局/中华中医药学会团体标准，正文不说取穴", () => {
  const insomnia = signedPrior({ disease: "不寐", syndrome: "心脾两虚证", method: "补益心脾，养心安神", pathogenesis: "心脾两虚，心神失养", patientFact: "入睡困难，多梦易醒", western: "失眠障碍" });
  const cards = compile(insomnia, caseOf("入睡困难2月", "入睡困难，多梦易醒，心悸健忘"), ["qigong_daoyin", "mind_therapy", "diet_therapy"]);
  for (const card of cards) {
    if (!["qigong_daoyin", "mind_therapy", "diet_therapy"].includes(card.projectCode)) continue;
    assert.deepEqual(card.suggestedSitesOrPoints, [], `${card.projectCode} 是无穴项目`);
    assert.ok(!/取穴/.test(card.treatmentContent), `${card.projectCode} 的正文不得说取穴：${card.treatmentContent}`);
  }
});

await check("10.8 教材方案总开关：CDSS_NONDRUG_TEXTBOOK_PLANS=false 时回到评估态（回滚路径可用）", async () => {
  await withEnv("CDSS_NONDRUG_TEXTBOOK_PLANS", "false", () => {
    const card = cardFor(compile(herpes, herpesCase, ["acupuncture"]), "acupuncture");
    assert.ok(!card || card.protocolStatus === "assessment_only_no_patient_specific_protocol", card?.protocolStatus);
  });
});

await check("10.10 频次：教材该病证节没写频次时用联网核对的 A/B 级来源（带来源与等级）；教材有明确频次时以教材为准（反证）", () => {
  const herpesPlan = plans.textbookTreatmentPlan({ projectCode: "acupuncture", diseaseNames: ["蛇串疮"], westernNames: [], signedSyndromeText: "肝胆湿热", currentFacts: "簇集水疱 灼热刺痛 口苦 心烦易怒" });
  assert.match(herpesPlan.scheduleSuggestion, /每日1次/, herpesPlan.scheduleSuggestion);
  assert.match(herpesPlan.scheduleSuggestion, /国家中医药管理局/, "频次必须写明是谁说的");
  assert.match(herpesPlan.protocolSource, /频次来源：.*A级/, herpesPlan.protocolSource);
  const headachePlan = plans.textbookTreatmentPlan({ projectCode: "acupuncture", diseaseNames: ["头痛"], westernNames: [], signedSyndromeText: "气血亏虚", currentFacts: "头痛 头晕 神疲乏力" });
  assert.match(headachePlan.scheduleSuggestion, /^头痛急性发作时每日治疗1-2次/, "教材有明确频次时以教材为准");
  assert.ok(!/频次来源/.test(headachePlan.protocolSource), "教材已有频次时不再引网络来源");
  const data = JSON.parse(readFileSync(new URL("../src/data/tcm-nondrug-web-schedules.source.json", import.meta.url), "utf8"));
  assert.ok(data.entries.length >= 80 && data.entries.every((entry) => ["A", "B"].includes(entry.tier) && entry.url && entry.quote && entry.sourceTitle), "只收带 URL 与引文的 A/B 级来源");
});

await check("10.9 数据出处：每条教材病证节都带书名与行号；行号可回溯", () => {
  const data = JSON.parse(readFileSync(new URL("../src/data/tcm-nondrug-textbook-protocols.json", import.meta.url), "utf8"));
  for (const key of ["acupuncture", "tuina", "diet"]) {
    assert.ok(data[key].length >= 30, `${key} 条目过少`);
    for (const entry of data[key]) {
      assert.ok(Number.isInteger(entry.line) && entry.line > 0, `${key}/${entry.disease} 缺行号`);
      assert.ok(entry.book || key === "diet", `${key}/${entry.disease} 缺书名`);
    }
  }
  for (const key of ["zhenjiu_zhiliao", "zhenjiu_xue", "tuina", "shiliao"]) assert.ok(data.sources[key]?.title && data.sources[key]?.isbn, `${key} 缺书目信息`);
});

// ── 11 同一病历只算一次 ────────────────────────────────────────────────────
const coalesce = await jiti.import("../src/lib/stage-result-coalescing.server.ts");
const ndjson = (lines) => lines.map((line) => `${JSON.stringify(line)}\n`).join("");
const stagedResponse = (calls, delayMs, final = `${START}\n{"stage":"diagnose"}\n${END}`) => async () => {
  calls.count += 1;
  const body = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(ndjson([{ content: "第一段" }])));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      controller.enqueue(encoder.encode(ndjson([{ content: final }, { content: "[END]" }])));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
};
const readAll = async (response) => await response.text();

await check("11.1 同一病历并发两次只计算一次：后到者并入同一次计算，读到完整结果", async () => {
  coalesce.resetStageResultCacheForTests();
  const calls = { count: 0 };
  const key = coalesce.stageRequestFingerprint("diagnose", { clientId: "c", customerId: "t" }, { id: "x", chiefComplaint: "心悸" });
  const compute = stagedResponse(calls, 80);
  const [first, second] = await Promise.all([
    coalesce.coalesceStageResponse({ stage: "diagnose", key, compute, cacheable: () => true }),
    coalesce.coalesceStageResponse({ stage: "diagnose", key, compute, cacheable: () => true }),
  ]);
  const [a, b] = await Promise.all([readAll(first), readAll(second)]);
  assert.equal(calls.count, 1, "只应计算一次");
  assert.equal(a, b, "两个调用方读到同一份完整流");
  assert.ok(a.includes("[END]"));
  assert.equal(first.headers.get("x-cdss-stage-result"), null, "发起计算的请求不带复用标记");
  assert.equal(second.headers.get("x-cdss-stage-result"), "joined", "并入进行中计算的请求标 joined");
});

await check("11.2 调用方中途断开不中止计算：结果入缓存，下一次重试直接拿到（不再「暂未生成」）", async () => {
  coalesce.resetStageResultCacheForTests();
  const calls = { count: 0 };
  const key = coalesce.stageRequestFingerprint("prescribe", { clientId: "c", customerId: "t" }, { id: "y", chiefComplaint: "腰痛" });
  const compute = stagedResponse(calls, 120);
  const first = await coalesce.coalesceStageResponse({ stage: "prescribe", key, compute, cacheable: () => true });
  await first.body.cancel(); // HIS 30 秒断开
  await new Promise((resolve) => setTimeout(resolve, 300));
  const retry = await coalesce.coalesceStageResponse({ stage: "prescribe", key, compute, cacheable: () => true });
  assert.equal(retry.headers.get("x-cdss-stage-result"), "reused", "重试应直接复用已算完的结果");
  assert.ok((await readAll(retry)).includes("[END]"));
  assert.equal(calls.count, 1);
});

await check("11.3 反证：显式重新生成绕过复用；不可复用的结果（降级页）不入缓存；指纹随病历内容变化", async () => {
  coalesce.resetStageResultCacheForTests();
  const calls = { count: 0 };
  const key = coalesce.stageRequestFingerprint("diagnose", { clientId: "c", customerId: "t" }, { id: "z", chiefComplaint: "头痛" });
  const compute = stagedResponse(calls, 10);
  await readAll(await coalesce.coalesceStageResponse({ stage: "diagnose", key, compute, cacheable: () => true }));
  await readAll(await coalesce.coalesceStageResponse({ stage: "diagnose", key, compute, cacheable: () => true, bypass: true }));
  assert.equal(calls.count, 2, "bypass 必须重算");
  coalesce.resetStageResultCacheForTests();
  const degraded = { count: 0 };
  const degradedCompute = stagedResponse(degraded, 10, "降级页");
  await readAll(await coalesce.coalesceStageResponse({ stage: "diagnose", key, compute: degradedCompute, cacheable: () => false }));
  await readAll(await coalesce.coalesceStageResponse({ stage: "diagnose", key, compute: degradedCompute, cacheable: () => false }));
  assert.equal(degraded.count, 2, "不可复用的结果下次照常重算");
  const other = coalesce.stageRequestFingerprint("diagnose", { clientId: "c", customerId: "t" }, { id: "z", chiefComplaint: "腹痛" });
  assert.notEqual(other, key, "病历内容变了指纹必须变");
  const sameWithOutputs = coalesce.stageRequestFingerprint("diagnose", { clientId: "c", customerId: "t" }, { id: "z2", chiefComplaint: "头痛", diagnosis: "上一轮结果" });
  assert.equal(sameWithOutputs, key, "重推时带回的上一轮产物与病历 id 不参与指纹");
  const otherTenant = coalesce.stageRequestFingerprint("diagnose", { clientId: "c", customerId: "t2" }, { id: "z", chiefComplaint: "头痛" });
  assert.notEqual(otherTenant, key, "不同租户绝不共用结果");
});

if (failures.length > 0) console.error(JSON.stringify({ failures }, null, 2));
assert.equal(failures.length, 0, `甲方 9.24/9.27 测评整改回归失败 ${failures.length} 项`);
console.log(JSON.stringify({ checks, failures: 0 }));
