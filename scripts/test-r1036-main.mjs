// 第二十四轮（2026-10-26）：甲方全部用例重测与按类修复；胎盘早剥被开少腹逐瘀汤（君药活血化瘀）这一类的处理。
// 每条断言都有反证（~/runlogs/r1018/work/r1036/cp/cp.py）。
import assert from "node:assert/strict";
import fs from "node:fs";
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

const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const barred = await jiti.import("../src/lib/formula-base-herbs-barred.server.ts");
const bleedingRules = await jiti.import("../src/lib/active-bleeding-treatment.ts");

const BLEEDING = "患者年龄：30岁\n患者性别：女\n孕38周，持续剧烈腹痛6小时，阴道流血，色暗红，量中。";
const QUIET = "患者年龄：30岁\n患者性别：女\n小腹刺痛半年，经期加重，经色暗有血块。";

// ---------- 1 功效分类按书名查得到 ----------
await check("1.1 功效分类表的每个键都查得到（延胡索、土鳖虫、益智仁、刺蒺藜、扁蓄……此前换成药典名后查不到）；药典名、别名、炮制名同样查得到", () => {
  const data = JSON.parse(fs.readFileSync("src/data/tcm-herb-function-categories.json", "utf8")).categories;
  const lost = Object.keys(data).filter((key) => knowledge.getTcmHerbFunctionCategories(key).length === 0);
  assert.deepEqual(lost, []);
  for (const name of ["延胡索", "延胡索（元胡）", "元胡", "醋延胡索", "土鳖虫（䗪虫）", "怀牛膝"]) {
    assert.ok(knowledge.getTcmHerbFunctionCategories(name).includes("活血化瘀药"), name);
  }
  assert.deepEqual(knowledge.getTcmHerbFunctionCategories("益智").includes("补阳药"), true);
  assert.ok(!knowledge.getTcmHerbFunctionCategories("三七").includes("活血化瘀药"), "三七是化瘀止血药");
  assert.ok(knowledge.getTcmHerbFunctionCategories("三七").includes("止血药"));
});

// ---------- 2 本例不宜的药 ----------
await check("2.1 活动性出血时延胡索、川芎、五灵脂对本例不宜，三七、蒲黄不算；没有出血时都不算", () => {
  for (const herb of ["延胡索", "延胡索（元胡）", "川芎", "五灵脂"]) assert.equal(contract.herbBarredForCase(herb, BLEEDING), true, herb);
  for (const herb of ["三七", "蒲黄", "当归"]) assert.equal(contract.herbBarredForCase(herb, BLEEDING), false, herb);
  for (const herb of ["延胡索", "川芎"]) assert.equal(contract.herbBarredForCase(herb, QUIET), false, herb);
});

const prior = (names) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "腹痛", primarySyndrome: "瘀血内停证", recommendedFormulaNames: names, formulaSelectionMode: names.length ? "single" : "none" },
});
const declassified = {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
  formula: { candidates: [{ name: "本例辨证组方", constructionType: "self_devised", formulaNames: [], herbs: [
    { name: "当归", dose: "9g", role: "君" }, { name: "蒲黄", dose: "9g", role: "臣" }, { name: "三七", dose: "3g", role: "臣" }, { name: "小茴香", dose: "3g", role: "佐" },
  ] }] },
};

await check("2.2 锁定方组成里有本例不宜的药：列出药、所在方与原因；没有出血时为空", () => {
  const list = barred.formulaBaseHerbsBarredForCase(prior(["少腹逐瘀汤"]), BLEEDING);
  const names = list.map((item) => item.herb);
  // 目录写的是炮制名（醋延胡索、醋没药、炒五灵脂）。
  for (const herb of ["川芎", "没药", "五灵脂", "延胡索"]) assert.ok(names.some((name) => name.includes(herb)), `${herb} ∈ ${names.join("、")}`);
  assert.ok(list.every((item) => item.formula === "少腹逐瘀汤" && /出血或抗凝/.test(item.reason)), JSON.stringify(list));
  assert.deepEqual(barred.formulaBaseHerbsBarredForCase(prior(["少腹逐瘀汤"]), QUIET), []);
});

await check("2.3 合同：锁定方组成里有本例不宜的药时，透明降级为「本例辨证组方」受理；判据只认本例（没有出血或不给判据时照旧驳回）", () => {
  const reference = provenance.formulaCompilationReferences(["少腹逐瘀汤"]);
  assert.equal(reference.length, 1, "少腹逐瘀汤可编译");
  assert.equal(provenance.formulaCompilationContractIssue(declassified, prior(["少腹逐瘀汤"]), false, false, (herb) => contract.herbBarredForCase(herb, BLEEDING)), undefined);
  assert.equal(provenance.formulaCompilationContractIssue(declassified, prior(["少腹逐瘀汤"]), false, false, (herb) => contract.herbBarredForCase(herb, QUIET)), "formula_reference_declassified");
  assert.equal(provenance.formulaCompilationContractIssue(declassified, prior(["少腹逐瘀汤"]), false, false), "formula_reference_declassified");
});

await check("2.4 提示词：活动性出血时辨证阶段写「止血为先」，开方阶段写活血化瘀药不得入方、锁定方中本例不宜的药逐味列出；依据原文在规则里", () => {
  assert.match(bleedingRules.ACTIVE_BLEEDING_M03_RULE, /惟以止血为第一要法/);
  assert.match(bleedingRules.ACTIVE_BLEEDING_M03_RULE, /不立活血化瘀、破血逐瘀为主法/);
  assert.match(bleedingRules.ACTIVE_BLEEDING_M04_RULE, /活血化瘀药.*不得入方/);
  const diagnose = fs.readFileSync("src/app/api/diagnosis/diagnose/route.ts", "utf8");
  assert.match(diagnose, /if \(hasActiveBleedingRedFlag\(gated\.safetyGate\?\.redFlags \|\| \[\]\)\) stageInstructions \+= `\\n\\n\$\{ACTIVE_BLEEDING_M03_RULE\}`;/);
  const prescribe = fs.readFileSync("src/app/api/diagnosis/prescribe/route.ts", "utf8");
  assert.match(prescribe, /if \(activeBleedingInGroundingText\(structuredClinicalContext\)\) promptSuffixes\.push\(ACTIVE_BLEEDING_M04_RULE\);/);
  assert.match(prescribe, /formulaBaseHerbsBarredForCase\(signedPriorReasoning, structuredClinicalContext\)/);
  assert.match(prescribe, /formulaCompilationContractIssue\(reasoning, signedPriorReasoning, false, true, \(herb\) => herbBarredForCase\(herb, structuredClinicalContext\)\)/);
});

await check("2.5 合同的每个调用处都带上本例判据（只漏一处，那一处就照旧驳回透明降级）", () => {
  const sources = ["src/lib/diagnosis-api.ts", "src/lib/m04-delivery-checkpoint.ts", "src/lib/his-prescription-validation.ts", "src/app/api/diagnosis/prescribe/route.ts"];
  let calls = 0;
  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/formulaCompilationContractIssue\(([\s\S]*?)\)(?=\s*(?:\|\||;|\n|:))/g)) {
      calls += 1;
      assert.match(match[1], /herbBarredForCase\(herb,/, `${file}: ${match[1].slice(0, 120)}`);
    }
  }
  assert.equal(calls, 6, "六处调用");
});

await check("2.6 教材锚定：活动性出血时不把治法改回教材的「活血化瘀，和络止痛」、不把方向改成含本例不宜药的少腹逐瘀汤，保留模型按止血为先写的；没有出血时照常锚定", () => {
  const diagnose = (method, direction) => ({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: "腹痛", primarySyndrome: "瘀血内停证", primarySyndromeResolution: "bounded", recommendedFormulaDirection: direction },
    therapy: { overallPrinciple: "急则治标", overallMethod: method, subTherapies: [] },
    pathogenesis: { chain: [], locationDifferentiation: { items: ["胞宫"] } },
  });
  const safetyBleeding = { activeBleeding: true, barredHerb: (herb) => contract.herbBarredForCase(herb, BLEEDING) };
  const kept = provenance.withDeterministicFormulaReferences(diagnose("化瘀止血，养血固冲", "本例辨证组方"), BLEEDING, undefined, safetyBleeding);
  assert.equal(kept.therapy.overallMethod, "化瘀止血，养血固冲");
  assert.doesNotMatch(kept.overview.recommendedFormulaDirection, /少腹逐瘀汤/);
  // 模型自己也写了逐瘀方（会厌逐瘀汤）：方向改为辨证组方；只去一味次要药的四物汤照留。
  const modelBarred = provenance.withDeterministicFormulaReferences(diagnose("化瘀止痛止血", "会厌逐瘀汤加减"), BLEEDING, undefined, safetyBleeding);
  assert.equal(modelBarred.overview.recommendedFormulaDirection, "按已锁定病机与治法辨证组方");
  assert.deepEqual(modelBarred.overview.recommendedFormulaNames, []);
  const siwu = provenance.withDeterministicFormulaReferences({ ...diagnose("益气止血固脱", "四物汤加减"), overview: { ...diagnose("", "").overview, tcmDiseaseName: "异位妊娠", primarySyndrome: "气血亏脱证", recommendedFormulaDirection: "四物汤加减" } }, BLEEDING, undefined, safetyBleeding);
  assert.match(siwu.overview.recommendedFormulaDirection, /四物汤/);
  const anchored = provenance.withDeterministicFormulaReferences(diagnose("化瘀止痛", "本例辨证组方"), QUIET);
  assert.match(anchored.therapy.overallMethod, /活血化瘀/);
  assert.match(anchored.overview.recommendedFormulaDirection, /少腹逐瘀汤/);
});

const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
// ---------- 3 出血类红旗的整类、生地黄按药典上限处理 ----------
await check("3.1 出血类红旗整类：事实层写的腹腔内出血、蛛网膜下腔出血、下消化道活动性出血、失血性休克都算；出血风险、缺血性卒中、紫癜皮疹不算", () => {
  for (const flag of [
    "现有资料提示需立即急诊评估（需排除：急性盆腔炎/盆腔脓肿进展为脓毒症、异位妊娠破裂或流产伴腹腔内出血）",
    "现有资料提示需立即急诊评估（需排除：蛛网膜下腔出血或其他急性颅内血管事件）",
    "现有资料提示需立即急诊评估（需排除：华法林过量致下消化道活动性出血伴低血容量/失血性休克早期）",
    "当前呕血、咖啡样呕吐物、黑便或便血提示活动性消化道出血风险，需立即评估循环状态并急诊处置",
    "妊娠期腹痛或阴道出血伴血压88/56mmHg，需立即急诊排除异位妊娠破裂或流产大出血",
  ]) assert.equal(safety.hasActiveBleedingRedFlag([flag]), true, flag);
  for (const flag of [
    "现有资料提示需立即急诊评估（需排除：左髋部骨折伴抗凝相关出血风险、骨筋膜室综合征）",
    "长期服用阿司匹林与华法林，需警惕消化道出血风险，用药前复核凝血",
    "现有资料提示需立即急诊评估（需排除：急性缺血性脑卒中（心源性栓塞可能））",
    "按压不褪色的皮疹（瘀点/瘀斑/紫癜）（NICE NG253 十六岁及以上疑似脓毒症红色征象），需立即急诊评估。",
    "急性或加重胸闷已出现，需先排除急性冠脉综合征等心血管风险",
  ]) assert.equal(safety.hasActiveBleedingRedFlag([flag]), false, flag);
});

await check("3.2 生地黄超出药典（地黄条目：生地黄 10–15g）按上限处理，不再整页退成非剂量页；药典内不动", () => {
  const adult = contract.ordinaryHistoricalDoseDeviation({ name: "生地黄", dose: "30g" }, "水煎服");
  assert.equal(adult?.max, 15);
  assert.match(adult?.basis || "", /地黄条目：生地黄/);
  assert.equal(contract.ordinaryHistoricalDoseDeviation({ name: "生地黄", dose: "12g" }, "水煎服"), undefined);
});

const pruningModule = await jiti.import("../src/lib/m04-modification-safety.ts");
// ---------- 4 定稿剔药后的残留文字 ----------
await check("4.1 定稿剔药后注意事项里点名已不在方中的药去掉（C018「方中含吴茱萸有小毒」）；在方中或在随证加减里的照留；定稿在剔药之后重写煎服行", () => {
  const body = (herbs, precautions, modifications = []) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "本例辨证组方", herbs: herbs.map((name) => ({ name, dose: "9g", role: "臣" })) }], modifications }, nonPharma: { precautions } })}\n<!-- DIAGNOSIS_JSON_END -->`;
  const read = (text) => JSON.parse(text.slice(text.indexOf("-->") + 3, text.lastIndexOf("<!--"))).nonPharma.precautions;
  const cleaned = read(pruningModule.withoutPrecautionsNamingAbsentHerbs(body(["黄连", "海螵蛸", "白芍"], ["方中含吴茱萸有小毒，请严格遵医嘱剂量服用，不可自行加量。", "服药期间忌食生冷油腻。"])));
  assert.deepEqual(cleaned, ["请严格遵医嘱剂量服用，不可自行加量。", "服药期间忌食生冷油腻。"]);
  const kept = read(pruningModule.withoutPrecautionsNamingAbsentHerbs(body(["黄连", "白芍"], ["方中含吴茱萸有小毒，请严格遵医嘱剂量服用。"], [{ herbName: "吴茱萸", action: "加" }])));
  assert.match(kept[0], /吴茱萸/, "随证加减里的药照留");
  const api = fs.readFileSync("src/lib/diagnosis-api.ts", "utf8");
  const finalize = api.slice(api.indexOf("const finalizeM04CandidateContent = "), api.indexOf("let lastM04CandidateDirectionPruned"));
  const after = finalize.slice(finalize.indexOf("declassifyAndDropOpposingM04CandidateHerbs(finalized"));
  assert.match(after, /applyDeterministicDecoctionMethod\(finalized,[\s\S]*withoutPrecautionsNamingAbsentHerbs\(finalized\)/);
});

const secondary = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
// ---------- 5 兼证结构 ----------
await check("5.1 兼证与主证寒热相反（K04 风热犯肺证兼风寒表证）或已被主证包含（肾阴虚证兼虚热证、肝郁脾虚证兼脾虚证）时撤下，连同只属于它的治法；寒热错杂写法与正常兼证照留", () => {
  assert.equal(secondary.secondaryStructurallyInvalid("风热犯肺证", "风寒表证"), "cold_heat_conflict");
  assert.equal(secondary.secondaryStructurallyInvalid("风寒束表证", "肺热证"), "cold_heat_conflict");
  assert.equal(secondary.secondaryStructurallyInvalid("肾阴虚证", "虚热证"), "entailed_by_primary");
  assert.equal(secondary.secondaryStructurallyInvalid("肝郁脾虚证", "脾虚证"), "entailed_by_primary");
  for (const [p, s, r] of [["风寒束表证", "肺热证", "外寒内热，寒包火"], ["湿热中阻证", "津液亏耗证"], ["阳虚水泛证", "痰浊阻肺证"], ["气滞血瘀证", "寒凝胞宫证"], ["热毒内盛证", "湿热下注证"], ["脾胃阴虚证", "脾气虚证"], ["肝郁血热证", "心火亢盛证"]]) {
    assert.equal(secondary.secondaryStructurallyInvalid(p, s, r || ""), undefined, `${p}+${s}`);
  }
  const root = { overview: { primarySyndrome: "风热犯肺证", secondarySyndromes: ["风寒表证"], tcmDiagnosticRationale: "咳嗽、咽痛、痰黄为风热犯肺，兼风寒表证见流清涕，故立兼证。", overallPathogenesis: "风热犯肺，兼风寒束表" }, therapy: { overallMethod: "疏风清热，宣肺止咳，散寒解表" } };
  assert.equal(secondary.withdrawSecondarySyndrome(root, "风寒表证", "疏风清热，宣肺止咳"), true);
  assert.deepEqual(root.overview.secondarySyndromes, []);
  assert.doesNotMatch(root.therapy.overallMethod, /散寒/);
});

// ---------- 6 中医治疗卡 ----------
const cards = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
const plan = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
await check("6.1 妊娠阳性或可疑时耳穴卡也不出（卡上自己写着妊娠期禁用，C097）；未妊娠照出", () => {
  const src = fs.readFileSync("src/lib/tcm-treatment-capabilities.server.ts", "utf8");
  const block = src.slice(src.indexOf("const pregnancyStatus = treatmentPregnancyStatus(caseState, facts);"), src.indexOf("return undefined;\n}\n\nfunction rankedTreatmentCandidates"));
  assert.match(block, /"auricular"/);
  void cards;
});

await check("6.2 句首证型名用逗号接做法（「肾阳虚，可加灸。」）按条件整句去留：肾阴虚证不留孤零零的「肾阳虚。」（C066），肾阳虚证照留", () => {
  const t = "毫针常规刺，补法或平补平泻。肾阳虚，可加灸。";
  assert.equal(plan.cardSentencesMatchedToSyndrome(t, ["绝经前后诸证"], "肾阴虚证"), "毫针常规刺，补法或平补平泻。");
  assert.match(plan.cardSentencesMatchedToSyndrome(t, ["绝经前后诸证"], "肾阳虚证"), /肾阳虚者可加灸/);
  assert.equal(plan.cardSentencesMatchedToSyndrome("湿热者，可点刺出血。", ["痹证"], "湿热痹阻证").includes("者者"), false);
});

// ---------- 7 依据与病历 ----------
const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
await check("7.1 否认已记录的发现整类：「未诉有痛风史」对既往史痛风史（C044）、「未见舌面生津」对「无苔，舌面生津」（api-ba8a）都去掉；病历没有的照留", () => {
  assert.equal(visible.withoutDenialsOfRecordedFindings("本例无外伤，未诉有痛风史，红肿以膝关节为主。", "既往史：痛风史5年。\n右膝关节红肿热痛2天。"), "本例无外伤，红肿以膝关节为主。");
  assert.equal(visible.withoutDenialsOfRecordedFindings("舌红少苔，未见舌面生津，为阴虚火旺之象。", "舌象：少苔或无苔，舌面生津"), "舌红少苔，为阴虚火旺之象。");
  assert.equal(visible.withoutDenialsOfRecordedFindings("本例无外伤，未诉有痛风史。", "右膝关节红肿热痛2天。"), "本例无外伤，未诉有痛风史。");
  assert.equal(safety.recordMentionPolarityAt("恶寒发热，无汗，头身疼痛", "恶寒发热，无汗，头身疼痛".indexOf("头身疼痛")), "affirmed");
  assert.equal(safety.recordMentionPolarityAt("无恶寒，发热", "无恶寒，发热".indexOf("发热")), "negated", "普通否认列举照旧");
});

await check("7.2 中性证名不被改成意思里带病性的教材证型（心神不宁证 → 心肾不交证，api-f076）；模型自己写的心肾不交证照认", async () => {
  const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
  assert.equal(textbook.textbookNearestRow("不寐", "心神不宁证", "宁心安神", "失眠多梦、心悸并见")?.syndromeName, undefined);
  assert.equal(textbook.textbookNearestRow("不寐", "心肾不交证", "滋阴降火，交通心肾", "失眠，心悸，腰膝酸软，五心烦热，舌红少苔")?.syndromeName, "心肾不交证");
});

await check("7.3 闸门：前置「无」只否认紧跟的独立成词体征（无汗、无汗出、无汗而喘、无痰、无苔），逗号之后的神志昏蒙、抽搐不被读成否认（语料 corpus-13204、12305）；逐项否认照旧", () => {
  const gate = (text) => safety.evaluateSafetyGate({ chiefComplaint: "咳嗽3天", symptoms: { 现病史: text }, patient: { sex: "男", age: 60 }, conversation: [] }).redFlags.join("|");
  assert.match(gate("怯寒发热，无汗，咳嗽，神志昏蒙。"), /神经/);
  assert.match(gate("无汗出，抽搐。"), /神经/);
  assert.match(gate("无汗而喘，神志昏蒙。"), /神经/);
  assert.match(gate("舌红无苔，神志昏蒙。"), /神经/);
  assert.equal(gate("无汗，无抽搐。"), "");
  assert.equal(gate("无汗、抽搐。"), "", "顿号列举照旧一并否认");
});

// ---------- 8 甲方 10.26 医学测评 ----------
const surface = await jiti.import("../src/lib/delivered-surface.ts");
await check("8.1 西医诊断依据：交付面把 clinicalRationale 放进症状依据栏唯一一项（甲方面板只读这一栏，10.26 全部 11 例判「无依据」）；开方阶段读回时这一句不当病历事实，照旧按病历补回；幂等", () => {
  const western = { primary: { name: "急性上呼吸道感染", supportingFacts: ["恶寒发热2天", "鼻塞流清涕"], supportingFactKinds: [], limitations: ["未查血常规"], suggestedChecks: ["血常规"], clinicalRationale: "淋雨后急性起病，恶寒发热、鼻塞流清涕，符合急性上呼吸道感染；需与流感鉴别。" } };
  assert.equal(surface.deliveredWesternBasis(western), "淋雨后急性起病，恶寒发热、鼻塞流清涕，符合急性上呼吸道感染；需与流感鉴别。");
  assert.equal(surface.isDeliveredWesternBasisOnly([surface.deliveredWesternBasis(western)], western), true);
  assert.equal(surface.isDeliveredWesternBasisOnly(["恶寒发热2天"], western), false);
  const prior = { stage: "diagnose", westernDiagnosis: { primary: { ...western.primary, supportingFacts: [surface.deliveredWesternBasis(western)] } } };
  const restored = surface.restoreDiagnoseSupportingFacts(prior, ["恶寒发热2天", "鼻塞流清涕"]);
  assert.deepEqual(restored.westernDiagnosis.primary.supportingFacts, ["恶寒发热2天", "鼻塞流清涕"]);
  const withFacts = { stage: "diagnose", westernDiagnosis: { primary: { ...western.primary, supportingFacts: ["恶寒发热2天"] } } };
  assert.equal(surface.restoreDiagnoseSupportingFacts(withFacts, ["别的"]), withFacts, "回传的是病历事实时原样不动");
  assert.equal(surface.deliveredWesternBasis({ primary: { clinicalRationale: "  " } }), undefined);
});

await check("8.2 同一份病历的语义事实按内容留存：留存后进程内缓存清空，再来同一份病历用第一次的结果、重新签名有效；病历改一字或留存关闭就不回放", async () => {
  const dir = fs.mkdtempSync("/tmp/r1036-facts-store-");
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { CLINICAL_FACTS_ATTESTATION_KEY: "clinical-facts-test-key-2026", CASE_SNAPSHOT_ENCRYPTION_KEY: "snapshot-test-key-0123456789abcdef", CDSS_STAGE_RESULT_REUSE: "true", CDSS_STAGE_RESULT_STORE_PATH: dir, AI_TEXT_PROVIDER: "openai-compatible", OPENAI_MODEL: "deepseek-flash", OPENAI_BASE_URL: "http://127.0.0.1:9", OPENAI_API_KEY: "test" });
    const runtime = await jiti.import("../src/lib/clinical-facts-runtime.ts");
    const state = { id: "store-1", phase: "diagnose", patient: { sex: "女", age: 32 }, chiefComplaint: "月经周期缩短半年余", symptoms: { 现病史: "月经量多，色紫红，夹血块" }, conversation: [] };
    const reply = JSON.stringify({ disposition: { setting: "urgent_specialist", mustNotMiss: [{ condition: "异常子宫出血", plausibility: "likely", evidenceQuotes: ["月经量多"], timeWindow: "within_2w" }], rationale: "量多" }, redFlags: [], affirmedSymptoms: [], encounterScope: { status: "active_current_target", quote: "月经量多" } });
    const fresh = await runtime.maybeAttachClinicalFactsBackstop(state, async () => reply);
    assert.equal(fresh.clinicalFacts.semanticStatus, "checked");
    assert.equal(await runtime.persistClinicalFactsForState(state, fresh.clinicalFacts), true);
    runtime.resetClinicalFactsServerCache();
    const reused = await runtime.maybeAttachClinicalFactsBackstop(state);
    assert.equal(reused.clinicalFacts.resultSource, "cache");
    assert.equal(reused.clinicalFacts.disposition?.setting, "urgent_specialist");
    assert.equal(runtime.hasValidClinicalFactsAttestation(reused.clinicalFacts, Date.now(), undefined, undefined), true);
    runtime.resetClinicalFactsServerCache();
    const edited = await runtime.maybeAttachClinicalFactsBackstop({ ...state, symptoms: { 现病史: "月经量多，色紫红，夹较多血块" } }, undefined, AbortSignal.timeout(3000));
    assert.notEqual(edited.clinicalFacts?.resultSource, "cache", "病历改了要重新抽取");
    runtime.resetClinicalFactsServerCache();
    process.env.CDSS_STAGE_RESULT_REUSE = "false";
    const off = await runtime.maybeAttachClinicalFactsBackstop(state, undefined, AbortSignal.timeout(3000));
    assert.notEqual(off.clinicalFacts?.resultSource, "cache", "留存关闭不回放");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("8.3 风团、荨麻疹本身不提示严重过敏：病历逐项否认胸闷气促、腹痛、喉头梗阻（甲方病历 9）不提示；伴胸闷气促或呕吐、或有喉头水肿声音嘶哑的照提示", () => {
  const adv = (text) => safety.evaluateSafetyGate({ chiefComplaint: "皮肤瘙痒伴风团2天", symptoms: { 现病史: text }, patient: { sex: "女", age: 28 }, conversation: [] }).advisories.join("|");
  assert.doesNotMatch(adv("全身风团时隐时现，伴发热、咽干，无胸闷、气促，无腹痛、腹泻，无喉头梗阻感。"), /严重过敏/);
  assert.match(adv("全身风团，伴胸闷、气促。"), /严重过敏/);
  assert.match(adv("风团伴呕吐2次。"), /严重过敏/);
  assert.match(adv("进食海鲜后声音嘶哑。"), /严重过敏/);
  assert.match(adv("全身风团，风团发作时出现呕吐，夜间尤甚。无腹痛、腹泻及呼吸困难。"), /严重过敏/, "发作时的呕吐也是受累");
  assert.match(adv("全身风团，发作时自觉憋闷。"), /严重过敏/);
});

const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
await check("8.4 治则：虚证而治法第一项是重镇、止痛一类治标法（心虚胆怯证「镇惊定志，养心安神」，甲方病历 2）写标本兼治；治法以补开头的（血虚头痛「滋阴养血，和络止痛」）仍是虚则补之", () => {
  const principle = (syndrome, method) => summary.nationalTreatmentPrinciple("虚则补之", { overview: { primarySyndrome: syndrome, secondarySyndromes: [] }, therapy: { overallMethod: method } });
  assert.equal(principle("心虚胆怯证", "镇惊定志，养心安神"), "标本兼治");
  assert.equal(principle("血虚头痛", "滋阴养血，和络止痛"), "虚则补之");
  assert.equal(principle("脾气虚证", "健脾益气，渗湿止泻"), "虚则补之");
});

const secondaryModule = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
await check("8.5 依据自己说这组表现「非独立病证」、兼证栏却写了它（甲方病历 10：兼心火亢盛证，依据「夜寐不宁系火热扰心所致，非独立病证」）：撤下兼证；否认句说的是别的因素时不撤", () => {
  assert.equal(secondaryModule.secondaryStructurallyInvalid("肝郁血热证", "心火亢盛证", "心烦易怒为肝郁化火；夜寐不宁系火热扰心所致，非独立病证。"), "declared_not_independent");
  assert.equal(secondaryModule.secondaryStructurallyInvalid("肝郁血热证", "心火亢盛证", "痰湿尚未成独立证候，暂作兼夹因素处理。"), undefined);
});

const elementSupport = await jiti.import("../src/lib/m03-element-support.server.ts");
await check("8.6 辨证依据里写出的名外虚性证素也要核（心虚胆怯证下「精神差、食欲下降，为心脾两虚、气血不足」，甲方病历 2）：核脾气虚与血虚；证名本身涵盖的不核", () => {
  const units = elementSupport.elementCheckUnits({ overview: { primarySyndrome: "心虚胆怯证", secondarySyndromes: [], tcmDiagnosticRationale: "心悸善惊为心胆气虚；精神差、食欲下降，为心脾两虚、气血不足。" }, pathogenesis: { chain: [{ pathogenesis: "心胆气虚，神志不宁" }], natureDifferentiation: { items: [] } } });
  const labels = units.map((unit) => `${unit.type}/${unit.organs.join("")}`).sort();
  assert.ok(labels.includes("气虚/脾"), labels.join(","));
  assert.ok(labels.some((label) => label.startsWith("血虚")), labels.join(","));
  assert.equal(elementSupport.elementCheckUnits({ overview: { primarySyndrome: "心脾两虚证", tcmDiagnosticRationale: "心悸失眠、纳差便溏，为心脾两虚。" }, pathogenesis: { chain: [] } }).length, 0);
});

const checklist = await jiti.import("../src/lib/rationale-findings-checklist.ts");
await check("8.7 辨证依据逐项交代的已记录表现列给中医半（甲方病历 3 只讲了头痛、头晕心悸，漏了纳差、便溏、小便清长）：取事实层抽出、原文可查的症状，去掉主诉里的", () => {
  const state = { chiefComplaint: "产后头痛2月余", symptoms: { 现病史: "产后头痛，呈隐痛，伴头晕、心悸、神疲乏力，食欲下降，小便清长，大便稀溏。" }, patient: { sex: "女", age: 32 }, conversation: [],
    clinicalFacts: { semanticStatus: "checked", redFlags: [], affirmedSymptoms: [{ term: "头痛", quote: "产后头痛" }, { term: "神疲乏力", quote: "神疲乏力" }, { term: "食欲下降", quote: "食欲下降" }, { term: "小便清长", quote: "小便清长" }, { term: "大便稀溏", quote: "大便稀溏" }, { term: "盗汗", quote: "夜间盗汗" }] } };
  const terms = checklist.rationaleFindingsChecklist(state);
  assert.deepEqual(terms, ["神疲乏力", "食欲下降", "小便清长", "大便稀溏"]);
  assert.match(checklist.rationaleFindingsChecklistNotice(state), /辨证依据要交代的已记录表现/);
});

const review = await jiti.import("../src/lib/formula-analysis-review.ts");
await check("8.8 方名与组成一致（甲方「柴胡疏肝散-柴胡疏肝散加减」）：组成与方剂目录原方逐味相同才是原方，方义开头写「本方用某方原方」；组成不同的方名补「加减」、方义照旧；目录查不到的不判", () => {
  const herbs = (list) => list.split("、").map((name) => ({ name }));
  assert.equal(surface.candidateIsOriginalFormula("柴胡疏肝散", herbs("柴胡、香附、陈皮、枳壳、白芍、川芎、炙甘草")), true);
  assert.equal(surface.candidateIsOriginalFormula("柴胡疏肝散", herbs("柴胡、香附、陈皮、枳壳、白芍、川芎、炙甘草、郁金")), false);
  assert.equal(surface.candidateIsOriginalFormula("桂枝汤", herbs("桂枝、白芍、炙甘草、生姜、大枣")), true);
  assert.equal(surface.candidateIsOriginalFormula("柴胡疏肝散加减", herbs("柴胡")), undefined);
  assert.equal(surface.candidateIsOriginalFormula("某某不存在汤", herbs("桂枝")), undefined);
  assert.match(review.withOpeningMatchingFormulaName("本方以柴胡疏肝散为基础加减。柴胡、香附为君。", "柴胡疏肝散", true).text, /^本方用柴胡疏肝散原方。/);
  assert.equal(review.withOpeningMatchingFormulaName("本方以柴胡疏肝散为基础加减。柴胡、香附为君。", "柴胡疏肝散", false).changed, false);
  assert.equal(review.withOpeningMatchingFormulaName("本方以柴胡疏肝散为基础加减。柴胡为君。", "柴胡疏肝散加减", true).changed, false);
  const delivered = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name: "柴胡疏肝散", herbs: herbs("柴胡、香附、陈皮、枳壳、白芍、川芎、炙甘草、郁金"), formulaAnalysis: "本方以柴胡疏肝散为基础加减。柴胡、香附为君。" }] } });
  assert.equal(delivered.formula.candidates[0].name, "柴胡疏肝散加减");
});

const localMedicine = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
await check("8.9 中成药要说到本例主要问题：蛇串疮不列穿黄清热胶囊（急性上呼吸道感染）、龙血竭胶囊（跌打损伤），龙胆泻肝丸对证；月经先期不列乳癖康胶囊（乳腺增生），加味逍遥丸照列；固经丸（阴虚血热）用于肝郁血热这类实热判方向相反（甲方病历 8、10）", () => {
  const label = (name) => localMedicine.findLocalPatentMedicineLabel(name)?.indication || "";
  const zoster = { chiefComplaint: "左侧胁肋部疼痛5天，水疱3天", tcmDiseaseName: "蛇串疮", westernName: "带状疱疹", syndromes: ["肝经郁热证"] };
  const menses = { chiefComplaint: "月经周期缩短半年余，加重1月", tcmDiseaseName: "月经先期", westernName: "异常子宫出血", syndromes: ["肝郁血热证"] };
  assert.equal(localMedicine.patentMedicineCoversMainProblem(label("穿黄清热胶囊"), zoster), false);
  assert.equal(localMedicine.patentMedicineCoversMainProblem(label("龙血竭胶囊"), zoster), false);
  assert.equal(localMedicine.patentMedicineCoversMainProblem(label("龙胆泻肝丸"), zoster), true);
  assert.equal(localMedicine.patentMedicineMatchesSignedSyndrome(label("龙胆泻肝丸"), zoster.syndromes), true);
  assert.equal(localMedicine.patentMedicineCoversMainProblem(label("乳癖康胶囊"), menses), false);
  assert.equal(localMedicine.patentMedicineCoversMainProblem(label("加味逍遥丸"), menses), true);
  assert.equal(localMedicine.patentMedicineCoversMainProblem(label("六味地黄丸"), { chiefComplaint: "腰部隐痛伴乏力半年", tcmDiseaseName: "腰痛", westernName: "腰痛待查", syndromes: ["肾阴虚证"] }), true);
  const direction = (name) => localMedicine.patentMedicineDirectionConflict({ clause: localMedicine.medicineFunctionClause(label(name)), herbs: [], indication: label(name) }, { names: "肝郁血热证", method: "疏肝清热，凉血调经" });
  assert.equal(direction("固经丸"), "deficiency_indication_for_excess");
  assert.equal(direction("加味逍遥丸"), undefined);
  const compilerSource = fs.readFileSync("src/lib/m04-proposal-compiler.ts", "utf8");
  assert.match(compilerSource, /patentMedicineCoversMainProblem\(labelIndication\(item\), mainProblem\) !== false/);
  assert.match(compilerSource, /\.\.\.coveredMedicines\.filter\(syndromeMatched\)/);
});

await check("8.10 月经病按月经周期复诊：去掉「调理2周后复诊评估月经…」，补一句下次月经来潮时复诊、连续观察3个周期（甲方病历 10）；别的病不动；幂等", () => {
  const out = surface.followupWithMenstrualCycle("建议调理2周后复诊评估月经周期及经量变化，若经量持续过多或出现头晕乏力，请及时就医。", "月经先期");
  assert.doesNotMatch(out, /2周后复诊/);
  assert.match(out, /下次月经来潮时及经净后复诊/);
  assert.match(out, /头晕乏力/);
  assert.equal(surface.followupWithMenstrualCycle(out, "月经先期"), out);
  const other = "请服完本次的药后复诊。若头痛加重请立即就医。";
  assert.equal(surface.followupWithMenstrualCycle(other, "头痛"), other);
});

await check("8.11 先就医评估那一句不套两层括号：待排除项自带「（需排除…）」时只取括号里的（甲方病历 10 本机复测「需排除异常子宫出血（需排除子宫内膜病变…）」）", () => {
  const text = safety.priorityEvaluationFirstStep({ focus: "异常子宫出血（需排除子宫内膜病变、凝血功能障碍或内分泌疾病）", window: "within_2w" });
  assert.match(text, /需排除子宫内膜病变、凝血功能障碍或内分泌疾病）/);
  assert.doesNotMatch(text, /（需排除[^）]*（/);
  assert.match(safety.priorityEvaluationFirstStep({ focus: "乳腺癌", window: "within_2w" }), /需排除乳腺癌/);
});

await check("8.12 提示词：开方阶段写明君药承担治法第一项、原方君药不能入汤剂时以同功效药易之、与本例虚寒之象相悖的苦寒药去掉；加减给主症加重时的强化；西医半写诊断依据、脏腑概念不当器官病名、儿科病名不用于成人；病名核对 D 收这两类", () => {
  const prompts = fs.readFileSync("src/lib/diagnosis-prompts.ts", "utf8");
  assert.match(prompts, /君药承担 M03 治法的第一项/);
  assert.match(prompts, /用同功效的安全药味替代并承其位（重镇安神可用磁石、珍珠母或生龙骨）/);
  assert.doesNotMatch(prompts.match(/君药承担 M03 治法的第一项[^\n]*/u)?.[0] || "", /朱砂/u, "开方提示词里不点毒性药的名（test:formula-provenance）");
  assert.match(prompts, /便溏、小便清长、舌淡等虚寒之象而无热象/);
  assert.match(prompts, /主方里承担治法第一项的药只有一味/);
  const packets = fs.readFileSync("src/lib/m03-context-packets.ts", "utf8");
  assert.match(packets, /医生会把它当作这条西医诊断的诊断依据来读/);
  assert.match(packets, /不以该器官疾病为名，加「待查」也不行/);
  assert.match(packets, /儿科专用的诊断名（如反复呼吸道感染）不用于成人/);
  const check = fs.readFileSync("src/lib/western-name-evidence-check.server.ts", "utf8");
  assert.match(check, /只由腰痛、乏力、口干这类非特异症状得来时也属 D/);
  assert.match(check, /儿科专用的诊断名（如“反复呼吸道感染”/);
});

await check("8.13 中医治疗：主证节点按病名算适应证——教材有该病的项目方案（《推拿学》虚劳）时，节点认出了别的标签也给（甲方病历 5 只有食疗）", () => {
  assert.equal(plan.textbookPlanExistsForDisease("tuina", "虚劳", "", 78), true);

  const src = fs.readFileSync("src/lib/tcm-treatment-capabilities.server.ts", "utf8");
  assert.match(src, /const mainNode = node === chain\[0\] && !explicit;\n\s*if \(score <= 0 && \(nodeTags\.size === 0 \|\| mainNode\)/);
});

await check("8.14 同一份病历复用：舌苔、脉象拆成几个勾选项写（「苔薄，苔白」「脉浮，脉紧」）与合写同一指纹（甲方 HIS 同一病历两次传法不同，10.26「相同病历输出一致性」）；苔色不同照旧不同", async () => {
  const coalescing = await jiti.import("../src/lib/stage-result-coalescing.server.ts");
  const fp = (tongue, pulse) => coalescing.stageRequestFingerprint("diagnose", { customerId: "x" }, { chiefComplaint: "咳嗽", tongue, pulse });
  assert.equal(fp("舌淡红，苔薄白", "脉浮紧"), fp("舌淡红，苔薄，苔白", "脉浮，脉紧"));
  assert.equal(fp("舌红，苔黄燥", "脉濡滑"), fp("舌红，苔黄，苔燥", "脉濡，脉滑"));
  assert.notEqual(fp("舌淡红，苔薄白", "脉浮紧"), fp("舌淡红，苔薄，苔黄", "脉浮紧"));
});

await check("8.15 方义：「去/易/不用」管到顿号连着的整串药名，后面点了本方药的分句不当被删外来药的后半句（胎盘早剥一例的方义丢了君药那一句；C096 同形）；真外来药照删", async () => {
  const review = await jiti.import("../src/lib/formula-analysis-review.ts");
  const herbs = ["三七", "蒲黄", "花蕊石", "仙鹤草", "白芍", "当归", "甘草"];
  const run = (text) => review.reviewAuthoredFormulaAnalysis(text, herbs).text;
  assert.match(run("本方为自拟方。以三七、蒲黄易延胡索、五灵脂为君，化瘀止血；花蕊石、仙鹤草为臣；甘草为使。"), /易延胡索、五灵脂为君/);
  assert.match(run("本方为自拟方。不用延胡索、川芎，以三七、蒲黄为君，化瘀止血；花蕊石、仙鹤草为臣；甘草为使。"), /以三七、蒲黄为君/);
  assert.match(run("本方为自拟方。去原方延胡索、川芎、五灵脂，三七、蒲黄为君，化瘀止血；甘草为使。"), /去原方延胡索、川芎、五灵脂，三七、蒲黄为君/);
  assert.doesNotMatch(run("本方为自拟方。三七、蒲黄为君，化瘀止血；朱砂、琥珀镇惊安神，花蕊石、仙鹤草为臣；甘草为使。"), /朱砂|琥珀/, "方中没有的药照删");
  const afterForeign = run("本方为自拟方。朱砂、琥珀重镇安神，以三七、蒲黄为君，化瘀止血；花蕊石、仙鹤草为臣；甘草为使。");
  assert.doesNotMatch(afterForeign, /朱砂|琥珀/);
  assert.match(afterForeign, /以三七、蒲黄为君/, "被删外来药分句之后点了本方药的分句留下");
});

await check("8.16 过敏一条：病历写明的说「病历记录您对X过敏」，读病历按「进食后发病」读出的说「可能对X过敏」（留出集 S128：海鲜后风团、过敏史「否认食物过敏史」）；两种都照样避开、M04 提示同一分法", async () => {
  const allergen = await jiti.import("../src/lib/allergen-profile.ts");
  const required = await jiti.import("../src/lib/required-precautions.server.ts");
  const stated = { classId: "egg", labelZh: "蛋类", kind: "allergy", quote: "鸡蛋过敏" };
  const suspected = { classId: "seafood", labelZh: "海鲜", kind: "allergy", quote: "进食大量海鲜并饮啤酒后，夜间全身出现大片红色风团" };
  const prescribe = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "四君子汤加减", herbs: [], decoction: { doseCount: "7剂", course: "7日", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日1剂，水煎分2次温服", followUpNode: "完成7剂（7日）后复诊", followUpAfterDoses: 7, followUpAfterDays: 7 } }], patentAndWestern: [] },
    nonPharma: { diet: "宜清淡。", precautions: [], tcmTreatments: [] }, management: { followupSafetyNet: "请服完7剂药后（约7天后）复诊。" } };
  const line = (classes) => (surface.projectDeliveredReasoning(prescribe, { requiredPrecautions: [{ kind: "food_allergy", classes }] }).nonPharma.precautions.find((entry) => /过敏/.test(entry)) || "");
  const onlySuspected = line([suspected]);
  assert.ok(!onlySuspected.includes("病历记录"), onlySuspected);
  assert.match(onlySuspected, /可能对海鲜过敏.*请避开海鲜/);
  assert.match(line([stated]), /^病历记录您对蛋类过敏或不耐受/);
  const both = line([stated, suspected]);
  assert.match(both, /病历记录您对蛋类过敏或不耐受；本次进食海鲜后发病，可能对海鲜过敏/);
  const prompt = required.requiredPrecautionsPromptSection([{ kind: "food_allergy", classes: [suspected] }]);
  assert.ok(!/病历记录对海鲜过敏/.test(prompt) && /疑似过敏/.test(prompt) && /这是硬约束/.test(prompt), prompt);
  assert.equal(allergen.allergenStatedInRecord({ quote: "吃虾后起风团" }), false);
  assert.equal(allergen.allergenStatedInRecord({ quote: "过敏史：海鲜过敏" }), true);
});

await check("8.17 复诊第一句：待排除项自带括号（「异常子宫出血（需排除子宫内膜病变…）」）时按配对括号取，不截成半句、不套两层括号（生产探针甲方测评病历 10：「先完成评估（需排除异常子宫出血（需排除…），再按…」）", async () => {
  const types = await jiti.import("../src/lib/diagnosis-types.ts");
  const raw = "患者信息：性别女，年龄32岁\n主诉：月经提前1周、量多3个月\n现病史：月经先期，量多色紫红质稠，夹血块，心烦易怒，口苦\n舌象：舌红，苔黄\n脉象：脉滑";
  const state = types.normalizeCaseStateInput({ id: "r1036-817", phase: "collect", patient: { sex: "女", age: 32 }, chiefComplaint: "月经提前1周、量多3个月",
    symptoms: { presentHistory: "月经先期，量多色紫红质稠，夹血块，心烦易怒，口苦" }, questionRounds: 0, maxQuestionRounds: 1, conversation: [{ role: "user", content: raw }], tongue: "舌红，苔黄", pulse: "脉滑" });
  const facts = { semanticStatus: "checked", reviewStatus: "single_pass", redFlags: [],
    disposition: { setting: "urgent_specialist", mustNotMiss: [{ condition: "异常子宫出血（需排除子宫内膜病变、凝血功能障碍或内分泌疾病）", plausibility: "likely", evidenceQuotes: ["量多色紫红质稠"], timeWindow: "within_2w" }] } };
  const target = safety.priorityEvaluationFollowupTarget({ ...state, clinicalFacts: facts });
  assert.equal(target?.focus, "异常子宫出血（需排除子宫内膜病变、凝血功能障碍或内分泌疾病）", "按配对括号取全");
  const text = safety.priorityEvaluationFirstStep(target, { doses: 7, days: 7 });
  assert.equal(text, "请在2周内到相关专科就诊，先完成评估（需排除子宫内膜病变、凝血功能障碍或内分泌疾病）；医生确认可以服药后，服完7剂药（约7天后）再复诊。");
  assert.equal(safety.exclusionFocusIn("宜24小时内…（需排除：病毒性心肌炎、肺炎）；处方前需完成评估"), "病毒性心肌炎、肺炎");
  // 已被截断的半句（缺右括号）也不套两层括号。
  assert.doesNotMatch(safety.priorityEvaluationFirstStep({ focus: "异常子宫出血（需排除子宫内膜病变、凝血功能障碍或内分泌疾病", window: "within_2w" }), /（需排除[^）]*（/);
});

await check("8.18 教材治法栏只锚打头那串治法短语：异位妊娠·气血亏脱证不再把「此证为腹腔内出血所致…术后再辅以…活血化瘀治疗」整段抄进治法（生产探针 A-eme-0028/0342）；二选一、分情况写的格子不锚定；普通格子逐字照旧", () => {
  assert.equal(provenance.textbookAnchorableMethod("益气止血固脱。此证为腹腔内出血所致，首应及时手术止血治疗。术后再辅以益气养血，活血化瘀治疗"), "益气止血固脱");
  assert.equal(provenance.textbookAnchorableMethod("辛温解表，宣肺化痰；辛凉解表，清肺化痰"), "");
  assert.equal(provenance.textbookAnchorableMethod("实证当清热利湿，凉血止血。虚证宜滋补肾阴，清热止血"), "");
  assert.equal(provenance.textbookAnchorableMethod("阳明腑实，阴液亏虚者，治宜攻下腑实，滋阴增液。阳明腑实，气液两虚者，治宜攻下腑实，补益气阴"), "");
  assert.equal(provenance.textbookAnchorableMethod("健脾化湿，清热解毒，以增强机体抵抗力、延缓癌变过程等"), "健脾化湿，清热解毒");
  for (const plain of ["辛温解表，宣肺散寒", "温脾补肾，以化水饮", "活血化瘀，和络止痛。"]) assert.equal(provenance.textbookAnchorableMethod(plain), plain.replace(/。$/, ""));
  const ectopic = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: "异位妊娠", primarySyndrome: "气血亏脱证", primarySyndromeResolution: "bounded", recommendedFormulaDirection: "四物汤加减" },
    therapy: { overallPrinciple: "急则治标", overallMethod: "益气固脱，止血", subTherapies: [] },
    pathogenesis: { chain: [], locationDifferentiation: { items: ["胞宫"] } } };
  const out = provenance.withDeterministicFormulaReferences(ectopic, BLEEDING, undefined, { activeBleeding: true, barredHerb: (herb) => contract.herbBarredForCase(herb, BLEEDING) });
  assert.doesNotMatch(out.therapy.overallMethod, /此证为|手术|活血化瘀/, out.therapy.overallMethod);
  assert.match(out.therapy.overallMethod, /^益气止血固脱/);
});

await check("8.19 出血类红旗认红旗本身、不认附在后面的原文引文：「需排除：急性肺栓塞伴休克/低氧血症），原文依据：“…咯血丝”」不算活动性出血（生产探针 C098 因此退成非剂量页）；红旗本身写出血的照算", () => {
  assert.equal(safety.hasActiveBleedingRedFlag(["现有资料提示需立即急诊评估（需排除：急性肺栓塞伴休克/低氧血症），原文依据：“今天突然胸痛气促，活动后明显，咯血丝”"]), false);
  assert.equal(safety.hasActiveBleedingRedFlag(["现有资料提示需立即急诊评估（需排除：支气管扩张伴大咯血），原文依据：“今晨咯鲜血约100ml”"]), true);
  assert.equal(safety.hasActiveBleedingRedFlag(["现有资料提示需立即急诊评估（需排除：异位妊娠破裂伴腹腔内出血），原文依据：“停经7周，突发下腹剧痛”"]), true);
  assert.equal(safety.hasActiveBleedingRedFlag(["当前呕血、咖啡样呕吐物、黑便或便血提示活动性消化道出血风险，需立即评估循环状态并急诊处置"]), true);
});

console.log(`r1036-main: ${cases} checks`);
