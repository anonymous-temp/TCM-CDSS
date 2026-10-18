// 10/19 余项轮（2026-10-19）：≥300 条逐模块验收、甲方 10 例与留出集复评里剩下的服务端缺陷，一类一修。
//
// 每条断言都带反证：把改动撤掉或换成对照输入后必须变红（反证记录见 ~/runlogs/r1018/work/r1019/counterproofs.txt）。
//
//   1 极性：否认只在顿号列举里继承，逗号处重置（affirmedClinicalSourceClauses / affirmedClinicalText 与辨证合同分句器同一条）
//   2 辨证合同：转述病历的「药名 + 数量」（「每日饮白酒约5两」）不算剂量级内容（M-MTCMB-21 三轮修复 160 秒后退回占位）
//   3 妊娠：「此次妊娠后觉…」「怀孕以来…」是本次妊娠（X-G-2366 照常给了含川芎香附的剂量）；既往孕产不收
//   4 教材改名不丢模型写的病性因素（气虚血瘀 → 心血瘀阻）；命门火衰与肾阳不足同义
//   5 兼证一致：辨证依据写了兼夹病机、兼证栏为空时的窄核对（解析、校验、落地）
//   6 注意事项：病历里的用药（按给药动词取名，开放的药名 + 闭集的动词）、未写药名的自行用药、带状疱疹抗病毒、备孕验孕；
//     英文用法缩写与「1#」改中文；不到 80 岁不称「高龄」
//   7 因红旗等不给剂量的页只列安全类提示（留出集 S178：牛膝「功效与病机对应不够清楚」外露）
import assert from "node:assert/strict";
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
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const polarity = await jiti.import("../src/lib/clinical-polarity.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const state = await jiti.import("../src/lib/clinical-state.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const secondary = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
const precautions = await jiti.import("../src/lib/required-precautions.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const checkpoint = await jiti.import("../src/lib/m04-delivery-checkpoint.ts");

// ───── 1 极性 ─────
await check("1.1 「无胸闷、心慌，偶咳嗽，腰痛、腿疼，…小便热」逗号后的是阳性，顿号列举的「心慌」仍是否认；「无异常气味，舌淡苔白，脉弦滑」的舌脉是阳性（M-MTCMB-20 兼证核对与教材改名都读不到）", () => {
  const record = "发作性头晕，头痛，偶胸痛，无胸闷、心慌，偶咳嗽，腰痛、腿疼，纳可，眠一般，小便热，夜尿频，大便可。表情自然，无异常气味，舌淡苔白，脉弦滑。";
  const affirmed = polarity.affirmedClinicalSourceClauses(record).join("|");
  for (const term of ["偶咳嗽", "腰痛", "小便热", "夜尿频", "舌淡苔白", "脉弦滑"]) assert.ok(affirmed.includes(term), `${term} 应认作阳性：${affirmed}`);
  assert.ok(!affirmed.includes("心慌") && !affirmed.includes("胸闷"), `顿号列举的否认仍是否认：${affirmed}`);
  assert.equal(polarity.clinicalClausePolarity("也没有急躁易怒"), "negative", "句首「也」不挡否认词");
  assert.equal(polarity.clinicalClausePolarity("亦无发热"), "negative");
  assert.equal(polarity.clinicalClausePolarity("也有口苦"), "affirmed", "对照");
  assert.equal(polarity.clinicalClausePolarity("不发热"), "negative");
  assert.equal(polarity.clinicalClausePolarity("不吸烟"), "negative");
  for (const positive of ["不寐", "不思饮食", "不耐寒", "不适"]) assert.equal(polarity.clinicalClausePolarity(positive), "affirmed", `${positive} 是阳性症状`);
  assert.equal(polarity.affirmedClinicalText("否认口苦目赤，也没有急躁易怒"), undefined);
  const text = polarity.affirmedClinicalText(record) || "";
  assert.ok(text.includes("腰痛") && text.includes("舌淡苔白") && !text.includes("心慌"), text);
});

// ───── 2 剂量级内容 ─────
await check("2.1 病历「以饮用白酒为主，平均5两／日」被转述成「每日饮白酒约5两」不算剂量级内容；病历里没有这句的照旧算（对照）", () => {
  const record = "饮酒30年，以饮用白酒为主，平均5两／日，未戒酒，已经减量。";
  const reasoning = { overview: { primarySyndromeBasis: ["每日饮白酒约5两"] } };
  assert.deepEqual(contract.m03DoseLevelInstructionFindings(reasoning, "", "$", record), []);
  assert.ok(contract.m03DoseLevelInstructionFindings(reasoning, "", "$", "否认饮酒史。").length > 0);
  assert.ok(contract.m03DoseLevelInstructionFindings({ overview: { overallTherapy: "黄芪30g益气" } }, "", "$", record).length > 0, "病历没写的药量照旧拦");
});

// ───── 3 妊娠 ─────
await check("3.1 「此次妊娠后觉小腹胀痛」「怀孕以来恶心」「怀孕后出现腰酸」是当前妊娠；「前次妊娠后自然流产」「2年前怀孕后流产」「第一胎怀孕后」不是（对照）", () => {
  for (const text of ["平素易生闷气，此次妊娠后觉小腹胀痛不适。", "怀孕以来恶心呕吐，不思饮食。", "怀孕后出现腰酸，小腹坠胀。"]) {
    assert.equal(state.assessPregnancyState(text).status, "positive", text);
  }
  for (const text of ["前次妊娠后自然流产，现月经规律。", "2年前怀孕后流产一次。", "第一胎怀孕后行人工流产。"]) {
    assert.notEqual(state.assessPregnancyState(text).status, "positive", text);
  }
});

// ───── 4 教材改名 ─────
await check("4.1 模型写「气虚血瘀证」「痰瘀互结证」不改成教材单因素的「心血瘀阻证」；「肾阳不足证」→「命门火衰证」照旧归一（对照）", () => {
  assert.equal(textbook.textbookNearestRow("胸痹", "气虚血瘀证", "益气活血，通脉止痛", "胸闷，乏力，舌暗", []), undefined);
  assert.equal(textbook.textbookNearestRow("胸痹", "痰瘀互结证", "化痰祛瘀", "胸闷，乏力，舌暗", []), undefined);
  assert.equal(textbook.textbookNearestRow("阳痿", "肾阳不足证", "温肾壮阳", "阳事不举，腰膝酸软，畏寒肢冷")?.syndromeName, "命门火衰证");
});

// ───── 5 兼证一致 ─────
await check("5.1 找兼夹说法：「兼脾虚之象」「夹瘀」「本虚标实」算；「兼顾」「无兼夹」不算（对照）", () => {
  assert.deepEqual(secondary.secondaryPatternClaims("纳差便溏为兼脾虚之象。", "久病夹瘀；本虚标实"), ["纳差便溏为兼脾虚之象", "久病夹瘀", "本虚标实"]);
  assert.deepEqual(secondary.secondaryPatternClaims("治法兼顾脾胃，未见兼夹。", ""), []);
});
await check("5.2 补兼证要逐字引病历至少两条肯定表现；引的是否认句、名字是主证本身、只有一条的都不收（对照）", () => {
  const recordText = "胃脘胀痛连及两胁，嗳气频作，纳差，便溏，乏力，无口苦，舌淡苔白，脉弦细。";
  const context = { recordText, primarySyndrome: "肝气犯胃证", editableText: "依据…纳差便溏为兼脾虚之象。" };
  const ok = secondary.parseSecondaryConsistencyDecision(JSON.stringify({ decision: "add", secondarySyndrome: "脾气虚证", method: "健脾益气", evidence: ["纳差", "便溏"] }), context);
  assert.equal(ok?.decision, "add");
  assert.equal(secondary.parseSecondaryConsistencyDecision(JSON.stringify({ decision: "add", secondarySyndrome: "脾气虚证", method: "健脾益气", evidence: ["纳差", "口苦"] }), context), undefined, "口苦在否认句里");
  assert.equal(secondary.parseSecondaryConsistencyDecision(JSON.stringify({ decision: "add", secondarySyndrome: "肝气犯胃证", method: "疏肝和胃", evidence: ["纳差", "便溏"] }), context), undefined, "不能是主证本身");
  assert.equal(secondary.parseSecondaryConsistencyDecision(JSON.stringify({ decision: "add", secondarySyndrome: "脾气虚证", method: "健脾益气", evidence: ["纳差"] }), context), undefined, "只有一条");
  const tongue = { recordText: "头晕，口干口苦，舌苔黄、质腻，脉弦滑。", primarySyndrome: "肝阳上亢证", editableText: "" };
  assert.equal(secondary.parseSecondaryConsistencyDecision(JSON.stringify({ decision: "add", secondarySyndrome: "痰热内蕴证", method: "清热化痰", evidence: ["苔黄腻", "口干口苦"] }), tongue)?.decision, "add", "「苔黄腻」对得上「舌苔黄、质腻」");
  assert.equal(secondary.parseSecondaryConsistencyDecision(JSON.stringify({ decision: "add", secondarySyndrome: "痰热内蕴证", method: "清热化痰", evidence: ["苔黄腻", "胸闷痰多"] }), tongue), undefined, "「胸闷痰多」病历没有");
  assert.equal(secondary.parseSecondaryConsistencyDecision(JSON.stringify({ decision: "remove", clauses: ["纳差便溏为兼脾虚之象"] }), context)?.decision, "remove");
  assert.equal(secondary.parseSecondaryConsistencyDecision(JSON.stringify({ decision: "remove", clauses: ["原文里没有的句子"] }), context), undefined);
});
await check("5.3 落地：补兼证并列上它的治法；删分句时连带逗号、不留残句", () => {
  const root = { overview: { primarySyndrome: "肝气犯胃证", secondarySyndromes: [], tcmDiagnosticRationale: "胃脘胀痛连及两胁、嗳气为肝气犯胃，纳差便溏为兼脾虚之象。", overallPathogenesis: "肝郁犯胃" }, therapy: { overallMethod: "疏肝理气，和胃止痛" } };
  assert.equal(secondary.applySecondaryConsistencyDecision(root, { decision: "add", secondarySyndrome: "脾气虚证", method: "健脾益气", evidence: ["纳差", "便溏"] }), true);
  assert.deepEqual(root.overview.secondarySyndromes, ["脾气虚证"]);
  assert.equal(root.therapy.overallMethod, "疏肝理气，和胃止痛，健脾益气");
  assert.equal(secondary.withoutClauses("胃脘胀痛为肝气犯胃，舌苔黄腻示兼有湿热，脉弦。", ["舌苔黄腻示兼有湿热"]), "胃脘胀痛为肝气犯胃，脉弦。");
  assert.equal(secondary.withoutClauses("久病夹瘀，胃脘胀痛为肝气犯胃。", ["久病夹瘀"]), "胃脘胀痛为肝气犯胃。");
});

// ───── 6 注意事项 ─────
await check("6.1 病历用药按给药动词取名：卡托普利、倍博特、拜新同、舒利迭、左西替利嗪、强力湿痒膏都认；停用的、未予治疗、对症治疗、吃山楂不认（对照）", () => {
  const names = (text) => polarity.recordedMedicationMentions(text).names;
  assert.deepEqual(names("4天前头晕，自服“卡托普利”后缓解"), ["卡托普利"]);
  assert.deepEqual(names("自服倍博特1#QD，现血压控制在140/80mmHg"), ["倍博特"]);
  assert.deepEqual(names("予拜新同1# QD"), ["拜新同"]);
  assert.deepEqual(names("长期吸入舒利迭及噻托溴铵粉雾剂"), ["舒利迭", "噻托溴铵粉雾剂"]);
  assert.deepEqual(names("予以盐酸左西替利嗪片口服，强力湿痒膏外用"), ["盐酸左西替利嗪片", "强力湿痒膏"]);
  assert.deepEqual(names("平素服用阿司匹林肠溶片0.1 qd、倍他乐克缓释片47.5mg qd"), ["阿司匹林肠溶片", "倍他乐克缓释片"]);
  assert.deepEqual(names("确诊后口服吉非替尼，其后因不能耐受自行停用该药"), []);
  assert.deepEqual(names("未予重视，未予治疗；门诊予营养神经、活血止痛等对症治疗；予抗感染治疗后尿频、尿急缓解"), []);
  assert.deepEqual(names("吃山楂后腹胀，否认服用其他药物"), []);
  assert.equal(polarity.recordedMedicationMentions("经休息后及自用药物后未见明显缓解").unnamed, true);
  assert.equal(polarity.recordedMedicationMentions("否认服用其他药物").unnamed, false);
  assert.deepEqual(polarity.recordedMedicationMentions("予替米沙坦、开同治疗").given, ["替米沙坦", "开同"]);
});
const caseOf = (presentHistory, extra = {}) => ({ id: "r1019", phase: "done", patient: { sex: "男", age: 58 }, chiefComplaint: "x", symptoms: { presentHistory }, conversation: [], ...extra });
await check("6.2 规则项：病历用药进「正在使用」一项（予写的标出可能已停）；未写药名的自行用药单列；带状疱疹、备孕各一项", () => {
  const meds = precautions.requiredPrecautionsForCase(caseOf("头晕3天，自服倍博特，予替米沙坦治疗。"), null);
  const current = meds.find((item) => item.kind === "current_medications");
  assert.deepEqual(current?.names, ["倍博特", "替米沙坦"]);
  assert.deepEqual(current?.given, ["替米沙坦"]);
  assert.ok(precautions.requiredPrecautionsForCase(caseOf("咳嗽2周，自行服药后未见缓解。"), null).some((item) => item.kind === "unnamed_medication"));
  assert.ok(!precautions.requiredPrecautionsForCase(caseOf("咳嗽2周，未服药。"), null).some((item) => item.kind === "unnamed_medication"));
  const zoster = { westernDiagnosis: { primary: { name: "带状疱疹" } }, overview: { tcmDiseaseName: "蛇串疮" } };
  assert.ok(precautions.requiredPrecautionsForCase(caseOf("右胸胁簇集水疱3天。"), zoster).some((item) => item.kind === "herpes_zoster_antiviral"));
  assert.ok(!precautions.requiredPrecautionsForCase(caseOf("右胸胁簇集水疱3天。"), { westernDiagnosis: { primary: { name: "湿疹" } } }).some((item) => item.kind === "herpes_zoster_antiviral"));
  const female = (text) => caseOf(text, { patient: { sex: "女", age: 30 } });
  assert.ok(precautions.requiredPrecautionsForCase(female("月经后期，未避孕1年未孕。"), null).some((item) => item.kind === "conception_pregnancy_check"));
  assert.ok(!precautions.requiredPrecautionsForCase(female("月经后期，工具避孕。"), null).some((item) => item.kind === "conception_pregnancy_check"));
});
await check("6.2b 自行配制的有毒药（留出集 S190 自泡生草乌、生川乌药酒）单列一项排最前，交付面漏写时补「立即停用、不再自制」；处方里的附子不算（对照）", () => {
  const items = precautions.requiredPrecautionsForCase(caseOf("患者因关节痛自行用生草乌、生川乌泡酒。2小时前饮用该药酒约50ml，半小时后口唇发麻。"), null);
  assert.deepEqual(items[0], { kind: "toxic_self_preparation", herbs: ["生草乌", "生川乌"] });
  assert.ok(!precautions.requiredPrecautionsForCase(caseOf("关节冷痛3月，遇寒加重。"), null).some((item) => item.kind === "toxic_self_preparation"));
  assert.ok(!precautions.requiredPrecautionsForCase(caseOf("否认自行服用草药，关节冷痛。"), null).some((item) => item.kind === "toxic_self_preparation"));
});
const rx = (precautionLines, herbs = [{ name: "陈皮", role: "君", function: "理气健脾", dose: "10g" }]) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
  formula: { candidates: [{ name: "x", formulaAnalysis: "x", herbs }] },
  nonPharma: { precautions: precautionLines },
});
await check("6.3 交付面：漏写的规则项补规则那句（带状疱疹抗病毒、备孕验孕并点名孕妇慎用药、未写药名的自行用药、予写的药不说「正在」）；已写到的不补；补后再投影不变", () => {
  const toxic = surface.projectDeliveredReasoning(rx(["饮食清淡。"]), { requiredPrecautions: [{ kind: "toxic_self_preparation", herbs: ["生草乌", "生川乌"] }] });
  assert.match(toxic.nonPharma.precautions[0], /^自行配制的含生草乌、生川乌的药请立即停用/);
  const required = [{ kind: "herpes_zoster_antiviral" }, { kind: "conception_pregnancy_check" }, { kind: "unnamed_medication" }, { kind: "current_medications", names: ["倍博特", "替米沙坦"], given: ["替米沙坦"] }];
  const out = surface.projectDeliveredReasoning(rx(["饮食清淡。"], [{ name: "桃仁", role: "臣", function: "活血祛瘀", dose: "10g" }]), { requiredPrecautions: required });
  const lines = out.nonPharma.precautions.join("\n");
  assert.match(lines, /口服抗病毒药/);
  assert.match(lines, /月经逾期请先验孕[^。]*桃仁/);
  assert.match(lines, /把正在用的药（药名和用法）告诉医生/);
  assert.match(lines, /正在服用的倍博特请告知医生/);
  assert.match(lines, /病历记录用过的替米沙坦，请告知医生现在是否还在用/);
  assert.doesNotMatch(lines, /正在服用的[^；。]*替米沙坦/);
  const again = surface.projectDeliveredReasoning(out, { requiredPrecautions: required });
  assert.deepEqual(again.nonPharma.precautions, out.nonPharma.precautions, "幂等");
  const written = surface.projectDeliveredReasoning(rx(["带状疱疹请尽早就医评估抗病毒治疗。"]), { requiredPrecautions: [{ kind: "herpes_zoster_antiviral" }] });
  assert.equal(written.nonPharma.precautions.length, 1, "模型已写到抗病毒就不补");
});
await check("6.4 交付面：「倍博特1# QD」改成「1片每日1次」；62 岁的「高龄者」改「年长者」，85 岁不改（对照）", () => {
  const out = surface.projectDeliveredReasoning(rx(["正在服用的倍博特1# QD请继续，高龄者起身宜缓。"]), { herbBoundaryAudience: { reproductive: false, ageYears: 62 } });
  assert.equal(out.nonPharma.precautions[0], "正在服用的倍博特1片 每日1次请继续，年长者起身宜缓。");
  const old = surface.projectDeliveredReasoning(rx(["高龄者起身宜缓。"]), { herbBoundaryAudience: { reproductive: false, ageYears: 85 } });
  assert.equal(old.nonPharma.precautions[0], "高龄者起身宜缓。");
});

await check("6.5 煎服法写了「不须啜热粥」时，注意事项里「可进热粥助汗」那一小句去掉（甲方病历 1）；煎服法要求啜粥的方不动（对照）", () => {
  const withMethod = (method, lines) => ({ ...rx(lines), formula: { candidates: [{ name: "x", formulaAnalysis: "x", herbs: [{ name: "荆芥", role: "君", function: "解表散风", dose: "10g" }], decoction: { method } }] } });
  const out = surface.projectDeliveredReasoning(withMethod("温服，服后覆被取微汗，不须啜热粥；以遍身微汗为度", ["服后避风，可进热粥助汗，汗出即止。", "服药期间忌食生冷油腻。"]));
  assert.deepEqual(out.nonPharma.precautions, ["服后避风，汗出即止。", "服药期间忌食生冷油腻。"]);
  const porridge = surface.projectDeliveredReasoning(withMethod("温服，服后可少进热粥、加衣覆被以助微汗", ["服后避风，可进热粥助汗，汗出即止。"]));
  assert.deepEqual(porridge.nonPharma.precautions, ["服后避风，可进热粥助汗，汗出即止。"]);
});

await check("6.6 服法与忌口：注意事项一句没说怎么服或忌什么时补一句（服法照本方煎服法、忌口按已定证候：热证忌辛辣、痰湿少肥甘）；已写到的那一半不重复（对照）", () => {
  const prior = { overview: { primarySyndrome: "痰热郁肺证", secondarySyndromes: [] }, therapy: { overallMethod: "清热化痰，宣肺止咳" } };
  const items = precautions.requiredPrecautionsForCase(caseOf("咳嗽痰黄3天。"), prior);
  const diet = items.find((item) => item.kind === "administration_and_diet");
  assert.equal(diet?.diet, "忌食辛辣温燥、少饮酒，少食肥甘厚腻与甜黏之品");
  const withMethod = (lines) => ({ ...rx(lines), formula: { candidates: [{ name: "x", formulaAnalysis: "x", herbs: [{ name: "黄芩", role: "君", function: "清热燥湿", dose: "10g" }], decoction: { method: "水煎，每日1剂，分2次饭后温服" } }] } });
  const out = surface.projectDeliveredReasoning(withMethod(["注意保暖，避免受凉。"]), { requiredPrecautions: [diet] });
  assert.equal(out.nonPharma.precautions[0], "本方汤药宜饭后温服；服药期间忌食辛辣温燥、少饮酒，少食肥甘厚腻与甜黏之品。");
  const half = surface.projectDeliveredReasoning(withMethod(["饭后温服，注意保暖。"]), { requiredPrecautions: [diet] });
  assert.equal(half.nonPharma.precautions[0], "服药期间忌食辛辣温燥、少饮酒，少食肥甘厚腻与甜黏之品。");
  const both = surface.projectDeliveredReasoning(withMethod(["饭后温服，忌辛辣。"]), { requiredPrecautions: [diet] });
  assert.deepEqual(both.nonPharma.precautions, ["饭后温服，忌辛辣。"]);
});
await check("6.7 育龄女性妊娠哺乳都未记录：一项，交付面补「如已怀孕…告知医生」并点名孕妇慎用药；男性、未避孕（另有一项）、已记录哺乳的不出（对照）", () => {
  const woman = (text, extra = {}) => caseOf(text, { patient: { sex: "女", age: 32 }, ...extra });
  assert.ok(precautions.requiredPrecautionsForCase(woman("头痛2周。"), null).some((item) => item.kind === "reproductive_status_unknown"));
  assert.ok(!precautions.requiredPrecautionsForCase(caseOf("头痛2周。"), null).some((item) => item.kind === "reproductive_status_unknown"));
  assert.ok(!precautions.requiredPrecautionsForCase(woman("头痛2周，未避孕1年未孕。"), null).some((item) => item.kind === "reproductive_status_unknown"));
  assert.ok(!precautions.requiredPrecautionsForCase(woman("头痛2周，现母乳喂养。"), null).some((item) => item.kind === "reproductive_status_unknown"));
  const out = surface.projectDeliveredReasoning(rx(["饮食清淡。"], [{ name: "川芎", role: "君", function: "活血行气", dose: "10g" }]), { requiredPrecautions: [{ kind: "reproductive_status_unknown" }] });
  assert.match(out.nonPharma.precautions[0], /^如已怀孕、可能怀孕或正在哺乳，请服药前告知医生/);
  const copied = surface.projectDeliveredReasoning(rx(["育龄女性，妊娠与哺乳情况未记录：如已怀孕或正在哺乳，须服药前告知医生。"]), { requiredPrecautions: [{ kind: "reproductive_status_unknown" }] });
  assert.deepEqual(copied.nonPharma.precautions, ["如已怀孕或正在哺乳，须服药前告知医生。"], "抄进来的提示词标题去掉，且已写到不再补");
  assert.doesNotMatch(precautions.requiredPrecautionsPromptSection([{ kind: "reproductive_status_unknown" }]), /未记录：/);
});
await check("6.8 12–13 岁仍出儿童服药一项，规则句换成适合大孩子的说法；14 岁不出（对照）", () => {
  const kid = (age) => caseOf("咳嗽3天。", { patient: { sex: "男", age } });
  const item = precautions.requiredPrecautionsForCase(kid(13), null).find((entry) => entry.kind === "pediatric_administration");
  assert.equal(item?.ageYears, 13);
  assert.ok(!precautions.requiredPrecautionsForCase(kid(14), null).some((entry) => entry.kind === "pediatric_administration"));
  const out = surface.projectDeliveredReasoning(rx(["饮食清淡。"]), { requiredPrecautions: [item] });
  assert.match(out.nonPharma.precautions[0], /^孩子服药请家长看护/);
});

await check("6.9 重度高血压而无靶器官表现：一项给患者的复测与就诊提示，交付面漏写时补；伴胸痛的（红旗另有处置）与血压正常的不出（对照）", () => {
  const withBp = (text, BP) => caseOf(text, { vitals: { BP } });
  const item = precautions.requiredPrecautionsForCase(withBp("头晕1月。", "186/104mmHg"), null).find((entry) => entry.kind === "severe_hypertension_followup");
  assert.equal(item?.reading, "186/104mmHg");
  assert.ok(!precautions.requiredPrecautionsForCase(withBp("头晕1月，今晨胸痛。", "186/104mmHg"), null).some((entry) => entry.kind === "severe_hypertension_followup"));
  assert.ok(!precautions.requiredPrecautionsForCase(withBp("头晕1月。", "136/84mmHg"), null).some((entry) => entry.kind === "severe_hypertension_followup"));
  const out = surface.projectDeliveredReasoning(rx(["饮食清淡。"]), { requiredPrecautions: [item] });
  assert.match(out.nonPharma.precautions[0], /^本次血压186\/104mmHg明显偏高，请今天复测血压/);
});

// ───── 7 不给剂量页 ─────
await check("7.1 因红旗不给剂量的页不列「功效与病机对应不够清楚」这类质量提示，配伍禁忌照列；合同未过的页照旧列（对照）", () => {
  const reasoning = rx(["饮食清淡。"], [{ name: "牛膝", role: "臣", function: "引血下行", dose: "15g" }]);
  const quality = { code: "candidate_0_herb_0_function_target", candidateIndex: 0, herbIndex: 0, herbName: "牛膝", message: "牛膝：该药的功效说明与本例病机的对应不够清楚。", suggestedAction: "请核对该药在本方中的用意，其余内容不受影响。" };
  const pair = { code: "candidate_0_high_risk_pair_incompatibility", candidateIndex: 0, message: "甘草—甘遂：属十八反。", suggestedAction: "本方含配伍禁忌，调整相关药味之前不得采纳或开出。" };
  const withheld = checkpoint.renderM04DeliveryCheckpoint({ reasoning, findings: [quality], contractIssues: ["x"] }, undefined, "dose_withheld", ["红旗未解除"]);
  assert.doesNotMatch(withheld, /对应不够清楚|处方补充提示|有需要医生核对之处/);
  const withPair = checkpoint.renderM04DeliveryCheckpoint({ reasoning, findings: [quality, pair], contractIssues: ["x"] }, undefined, "dose_withheld", ["红旗未解除"]);
  assert.match(withPair, /十八反/);
  assert.doesNotMatch(withPair, /对应不够清楚/);
  const rejected = checkpoint.renderM04DeliveryCheckpoint({ reasoning, findings: [quality], contractIssues: ["x"] }, undefined, "contract_rejected");
  assert.match(rejected, /对应不够清楚/);
});

console.log(JSON.stringify({ suite: "r1019-remediation", cases, failures: process.exitCode ? "see above" : 0 }));
