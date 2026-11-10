// 第四十轮（2026-11-09）：11.05 点对点回复整理时复测发现的遗留，按类收口。
// 每条断言都有反证（~/runlogs/r1018/work/r1053/cp/）。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const check = async (name, run) => {
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
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const precautions = await jiti.import("../src/lib/required-precautions.server.ts");
const discriminators = await jiti.import("../src/lib/redflag-discriminators.ts");

const state = (input) => types.normalizeCaseStateInput(input);
const neuroAdvisory = (input) => safety.narrativeFallbackAdvisories(state(input)).some((item) => item.startsWith("意识水平改变"));
const obstetricAdvisory = (input) => safety.narrativeFallbackAdvisories(state(input)).some((item) => item.startsWith("妊娠相关腹痛"));

// ───── 1 兜底提示与红旗读同一个判据 ─────
const pregnant = {
  chiefComplaint: "孕8周，恶心、呕吐2周", patient: { sex: "女", age: 27 },
  symptoms: { 现病史: "患者停经8周，确诊宫内早孕，2周前出现恶心、呕吐，食入即吐，伴神疲嗜睡、头晕、乏力，无腹痛及阴道流血。" },
  vitals: { T: "36.6", P: "82", R: "18", BP: "108/68" },
};
await check("1.1 「神疲嗜睡」是疲乏写法，不报「意识水平改变」；单写「嗜睡，呼之可应」照报（与红旗判别读者同一份词）", () => {
  assert.equal(neuroAdvisory(pregnant), false);
  assert.equal(neuroAdvisory({ chiefComplaint: "发热2天", patient: { sex: "男", age: 70 }, symptoms: { 现病史: "发热2天，今日嗜睡，呼之可应。" } }), true);
  assert.ok(discriminators.isFatigueFramed("伴神疲嗜睡"));
  assert.ok(discriminators.WEAK_CONSCIOUSNESS_TERMS.includes("嗜睡"));
});

const stroke = {
  chiefComplaint: "右侧肢体无力、言语不清半年", patient: { sex: "男", age: 70 },
  symptoms: {
    现病史: "患者半年前突发右侧肢体无力、言语不清，于外院诊断为“脑梗死”，经治疗后遗留右侧半身不遂、手足麻木、口眼歪斜及言语謇涩，伴神疲乏力、气短懒言。现规律康复治疗中，肢体肌力较平稳，无新发言语不清，无跌倒。",
    体格检查: "右侧口眼㖞斜",
  },
  vitals: { T: "36.5", P: "78", R: "18", BP: "142/88" },
};
await check("1.2 脑梗死半年、明写遗留与无新发：红旗与兜底提示都不报（11.05 病历15）；病因不明的慢性无力、今日突发无力照报", () => {
  assert.equal(safety.withSafetyGate(state(stroke)).safetyGate.status === "red_flag", false);
  assert.equal(neuroAdvisory(stroke), false);
  assert.equal(neuroAdvisory({ chiefComplaint: "右侧肢体无力3月", patient: { sex: "男", age: 66 }, symptoms: { 现病史: "右侧肢体无力3月，逐渐出现，未就诊。" } }), true);
  const acute = structuredClone(stroke);
  acute.symptoms.现病史 += "今日晨起突然右侧肢体无力加重，言语不清加重。";
  assert.equal(safety.withSafetyGate(state(acute)).safetyGate.status, "red_flag");
});

await check("1.3 孕妇只写头晕：记录了血压脉搏且不在循环不稳定线以内时不报产科提示；没记录生命体征、或血压低时照报；腹痛照报", () => {
  assert.equal(obstetricAdvisory(pregnant), false);
  const noVitals = structuredClone(pregnant); delete noVitals.vitals;
  assert.equal(obstetricAdvisory(noVitals), true);
  const low = structuredClone(pregnant); low.vitals.BP = "86/50";
  assert.equal(obstetricAdvisory(low), true);
  const pain = structuredClone(pregnant); pain.symptoms.现病史 = pain.symptoms.现病史.replace("无腹痛及阴道流血", "下腹隐痛");
  assert.equal(obstetricAdvisory(pain), true);
  // 血压达到妊娠高血压线、或孕满 20 周时头晕照报（回放 A-eme-0393：孕34周、血压150/95、尿蛋白+、头晕）
  const high = structuredClone(pregnant); high.vitals.BP = "150/95";
  assert.equal(obstetricAdvisory(high), true);
  const late = { chiefComplaint: "孕34周，头晕2天", patient: { sex: "女", age: 27 }, symptoms: { 现病史: "现宫内孕34周，头晕2天，无腹痛及阴道流血。" }, vitals: { T: "36.6", P: "84", R: "18", BP: "118/72" } };
  assert.equal(obstetricAdvisory(late), true);
});

// ───── 2 待排除项自带「需排除」 ─────
await check("2.1 复诊第一句不写「需排除需排除」（11.05 病历8）；普通待排除项照旧", () => {
  const first = safety.priorityEvaluationFirstStep({ focus: "需排除凝血功能障碍、血小板减少导致的反复鼻出血", window: "within_48h" });
  assert.doesNotMatch(first, /需排除需排除|排除需排除/u, first);
  assert.match(first, /需排除凝血功能障碍/u, first);
  assert.match(safety.priorityEvaluationFirstStep({ focus: "肝脓肿", window: "within_24h" }), /需排除肝脓肿/u);
});

// ───── 3 治法：后一项的头两字就是前一项的尾两字 ─────
await check("3.1 「活血化瘀，化瘀通络」接成「活血化瘀通络」（11.05 病历15）；不相接的两项不动", () => {
  assert.equal(surface.clinicalMethodItems("益气扶正，活血化瘀，化瘀通络"), "益气扶正，活血通络"); // 第四十一轮：不接成六字，换成受治理的活血通络
  assert.equal(surface.clinicalMethodItems("补益肝肾，舒筋活络，散寒止痛"), "补益肝肾，舒筋活络，散寒止痛");
});

// ───── 4 已按早孕急症转诊时不另写「服药前先验孕」 ─────
await check("4.1 停经45天伴右下腹痛、阴道流血：注意事项不列「月经逾期先验孕」（11.05 病历17）；只停经无腹痛出血照列", () => {
  const ectopic = state({
    chiefComplaint: "停经45天，右下腹撕裂样疼痛伴阴道流血2小时", patient: { sex: "女", age: 32 },
    symptoms: { 现病史: "停经45天，2小时前突发右下腹撕裂样剧痛，伴阴道少量流血，头晕乏力。" },
    vitals: { T: "36.8", P: "112", R: "22", BP: "90/56" },
  });
  const kinds = (s) => precautions.requiredPrecautionsForCase(s).map((item) => item.kind);
  assert.ok(!kinds(ectopic).includes("menses_overdue_pregnancy_check"), kinds(ectopic).join(","));
  const overdue = state({ chiefComplaint: "失眠1月", patient: { sex: "女", age: 32 }, symptoms: { 现病史: "失眠1月，入睡困难。停经45天。" } });
  assert.ok(kinds(overdue).includes("menses_overdue_pregnancy_check"), kinds(overdue).join(","));
});

// ───── 5 方义里不实的「去原方…」不论怎么收尾 ─────
await check("5.1 「去原方中与本证无涉之偏，」这种半句也去掉（11.05 病历8，玉女煎五味都在方中）；点了药名的换药说法不动", () => {
  const out = surface.withoutRemovalClaims("石膏为君；牛膝引热下行为使。去原方中与本证无涉之偏，诸药相合，清胃泻火、凉血止血。");
  assert.doesNotMatch(out, /无涉之偏/u, out);
  assert.match(out, /诸药相合/u, out);
  const named = "去原方熟地之滋腻，以生地黄易之。";
  assert.equal(surface.withoutRemovalClaims(named), named);
});

// ───── 6 血证分型的教材鉴别按教材分段 ─────
await check("6.1 鼻衄不配紫斑那一段的温病发斑、丹毒（原文顺带写了鼻衄也不算）；紫斑照配；尿血配血淋", () => {
  assert.equal(textbook.textbookDifferentialFitsSubtype("血证", "鼻衄", "温病发斑"), false);
  assert.equal(textbook.textbookDifferentialFitsSubtype("血证", "鼻衄", "温病"), false);
  assert.equal(textbook.textbookDifferentialFitsSubtype("血证", "鼻衄", "丹毒"), false);
  assert.equal(textbook.textbookDifferentialFitsSubtype("血证", "鼻衄", "经行衄血"), true);
  assert.equal(textbook.textbookDifferentialFitsSubtype("血证", "紫斑", "温病发斑"), true);
  assert.equal(textbook.textbookDifferentialFitsSubtype("血证", "尿血", "血淋"), true);
  assert.ok(!textbook.textbookDifferentialsForDisease("血证（鼻衄）", 50).some((item) => /温病|丹毒|出疹/u.test(item.name)));
});

// ───── 7 主证＋兼证正好是国标合称的两部分 ─────
const reasoningWith = (primary, secondary, natures) => ({
  overview: { primarySyndrome: primary, secondarySyndromes: secondary, tcmDiagnosticRationale: `属${primary}；兼脾不健运`, tcmDifferentials: [] },
  pathogenesis: { natureDifferentiation: { items: natures }, locationDifferentiation: { items: ["心", "脾"], details: [] } },
});
await check("7.1 「心血不足证」兼「脾气虚证」→ 心脾两虚证、兼证去掉（11.05 病历3）；兼证与合称无关或两条时不动", () => {
  const record = "心悸气短乏力3月，食欲不振、食后腹胀，失眠多梦，面色少华。";
  const merged = reasoningWith("心血不足证", ["脾气虚证"], ["气虚", "血虚"]);
  assert.deepEqual(surface.compositeSyndromeRename(merged, record), { from: "心血不足证兼脾气虚证", to: "心脾两虚证" });
  assert.equal(merged.overview.primarySyndrome, "心脾两虚证");
  assert.deepEqual(merged.overview.secondarySyndromes, []);
  const other = reasoningWith("心血不足证", ["痰湿阻滞证"], ["气虚", "血虚"]);
  assert.equal(surface.compositeSyndromeRename(other, record), undefined);
  assert.equal(other.overview.primarySyndrome, "心血不足证");
  const two = reasoningWith("心血不足证", ["脾气虚证", "肝郁证"], ["气虚", "血虚"]);
  assert.equal(surface.compositeSyndromeRename(two, record), undefined);
});

// ───── 8 备用加减与证候寒热相反 ─────
await check("8.1 下元虚寒证的「若兼有郁热，加栀子」不交付、提示词不列；同向的「若畏寒肢冷较甚，加肉桂」照留；寒热错杂不判", () => {
  assert.equal(textbook.standbyHerbOpposesSyndromePole("栀子", "下元虚寒证"), true);
  assert.equal(textbook.standbyHerbOpposesSyndromePole("肉桂", "下元虚寒证"), false);
  assert.equal(textbook.standbyHerbOpposesSyndromePole("栀子", "寒热错杂证"), false);
  assert.equal(textbook.standbyHerbOpposesSyndromePole("干姜", "胃热炽盛证"), true);
  const prompt = textbook.buildTextbookFormulaContext("遗尿", "下元虚寒证", { recordText: "" });
  assert.doesNotMatch(prompt, /兼有郁热/u, prompt);
  const prior = types.ReasoningV2Schema.parse({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: "遗尿", primarySyndrome: "下元虚寒证", overallPathogenesis: "肾阳不足，膀胱失约", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "睡中遗尿", syndromeEvidence: "睡中遗尿，畏寒肢冷", pathogenesis: "肾阳不足，膀胱失约", therapyDirection: "温补肾阳，固摄止遗" }] },
    therapy: { overallPrinciple: "虚则补之", overallMethod: "温补肾阳，固摄止遗", subTherapies: [{ therapy: "温补肾阳", targetPathogenesis: "肾阳不足", priority: "主要" }] },
    formula: { candidates: [], patentAndWestern: [], modifications: [] },
  });
  const out = compiler.compileM04Proposal({
    candidate: {
      name: "自拟方", applicable: "遗尿。", notApplicable: "",
      herbs: [
        { name: "菟丝子", dose: "6g", role: "君", function: "补肾固精" }, { name: "桑螵蛸", dose: "5g", role: "君", function: "固精缩尿" },
        { name: "益智", dose: "4g", role: "臣", function: "暖肾缩尿" }, { name: "炙甘草", dose: "3g", role: "使", function: "调和诸药" },
      ].map((herb) => ({ ...herb, targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, processing: null, isToxic: false, decoctionRequirement: null })),
      formulaAnalysis: "菟丝子、桑螵蛸为君，益智为臣，炙甘草为使。",
      decoction: { doseCount: "7剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，煎服", followUpNode: "7日复诊" },
    },
    patentAndWestern: [],
    modifications: [
      { trigger: "若兼有郁热", targetRef: "P1", actionType: "add", herbName: "栀子", dose: "5g", reason: "清泄郁热" },
      { trigger: "若畏寒肢冷较甚", targetRef: "P1", actionType: "add", herbName: "肉桂", dose: "2g", reason: "温补命门" },
    ],
    nonPharma: { diet: "宜温。", lifestyle: "规律作息。", emotion: "调畅情志。", precautions: [], tcmTreatments: [] },
  }, prior, state({ chiefComplaint: "反复遗尿1年", patient: { sex: "男", age: 6 }, symptoms: { 现病史: "睡中遗尿，每周3-4次，畏寒肢冷，小便清长。" } }));
  const herbs = out.formula.modifications.map((item) => item.herbName);
  assert.ok(!herbs.includes("栀子"), herbs.join(","));
  assert.ok(herbs.includes("肉桂"), herbs.join(","));
});

// ───── 9 「本例已见」认同义写法与连写的两个症状 ─────
await check("9.1 「若纳呆腹胀」对「食欲不振、食后腹胀」写成本例已见（11.05 病历3）；病历只写一半时不算；下位词不由总称证明", () => {
  const record = "伴神疲懒言、失眠多梦、健忘、食欲不振、食后腹胀、面色少华。";
  assert.match(compiler.modificationConditionAlreadyPresent("若纳呆腹胀", record)?.trigger || "", /^本例已见纳呆、腹胀$/u);
  assert.equal(compiler.modificationConditionAlreadyPresent("若纳呆腹胀", "伴腹胀，纳可。"), undefined);
  assert.equal(compiler.modificationConditionAlreadyPresent("若上腹痛", "下腹痛2天。"), undefined);
  assert.match(compiler.modificationConditionAlreadyPresent("若心慌", "阵发心悸1月。")?.trigger || "", /^本例已见/u);
});

// ───── 10 分型病的鉴别：教材对照型、补写按分型数 ─────
const normalization = await jiti.import("../src/lib/tcm-disease-differential-normalization.ts");
const authoring = await jiti.import("../src/lib/tcm-disease-differential-authoring.server.ts");
await check("10.1 鼻衄的教材对照型「吐血」可交付（要点取吐血段原文）、经行衄血按分段照留；「血证」不是血证（鼻衄）的鉴别；不分型时照旧", () => {
  const list = textbook.textbookDifferentialsForDisease("血证（鼻衄）", 50);
  assert.deepEqual(list.map((item) => item.name), ["经行衄血", "吐血", "外伤鼻衄", "齿衄"]);
  assert.match(list[1].text, /鼻腔、口腔及咽喉出血/u);
  // 男性按性别过滤后仍有两项以上（鼻衄的诊断条文写明排除外伤，齿衄按出血部位区分）
  assert.ok(list.filter((item) => textbook.tcmDifferentialDiseaseFitsPatient(item.name, { sex: "男" })).length >= 2);
  assert.equal(normalization.resolveTcmDiseaseDifferentialName("齿衄", "血证（鼻衄）").action, "keep");
  assert.equal(normalization.resolveTcmDiseaseDifferentialName("吐血", "血证（鼻衄）").action, "keep");
  assert.equal(normalization.resolveTcmDiseaseDifferentialName("经行衄血", "血证（鼻衄）").action, "keep");
  assert.equal(normalization.resolveTcmDiseaseDifferentialName("血证", "血证（鼻衄）").action, "drop");
  assert.equal(normalization.resolveTcmDiseaseDifferentialName("吐血", "血证").action, "drop");
  assert.equal(textbook.diseaseNameWithRecordSubtype("血证", "主诉：反复鼻出血3天\n现病史：鼻出血，血色鲜红。"), "血证（鼻衄）");
  assert.equal(textbook.diseaseNameWithRecordSubtype("鼻衄", ""), "血证（鼻衄）");
  // 病名是月经病的（经行衄血列在内科血证节，不只属妇科）男性不列
  assert.equal(textbook.tcmDifferentialDiseaseFitsPatient("经行衄血", { sex: "男" }), false);
  assert.equal(textbook.tcmDifferentialDiseaseFitsPatient("经行衄血", { sex: "女" }), true);
  assert.equal(textbook.tcmDifferentialDiseaseFitsPatient("吐血", { sex: "男" }), true);
});
await check("10.2 补写鉴别按本型数：模型写的温病、丹毒在血证（鼻衄）下不算已写（交付时会被滤掉），于是会补；紫斑下照算", () => {
  const rows = [{ diseaseName: "温病" }, { diseaseName: "丹毒" }];
  assert.equal(authoring.retainableDiseaseDifferentialRows(rows, "血证（鼻衄）", { sex: "男" }).length, 0);
  assert.equal(authoring.retainableDiseaseDifferentialRows(rows, "血证（紫斑）", { sex: "男" }).length, 2);
});

// ───── 11 停经伴腹痛、出血：注意事项不写「如已怀孕」假设小句 ─────
await check("11.1 停经45天右下腹撕裂样痛伴阴道流血：「方中有孕期慎用的药，如已怀孕或备孕请先告知医生」去掉假设小句；只剩「请先告知医生」的整条不留；非孕女性照写", () => {
  const prior = types.ReasoningV2Schema.parse({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: "异位妊娠", primarySyndrome: "气血亏脱证", overallPathogenesis: "血溢脉外，气随血脱", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "阴道少量流血", syndromeEvidence: "面色苍白，脉细数", pathogenesis: "血溢脉外，气随血脱", therapyDirection: "益气止血固脱" }] },
    therapy: { overallPrinciple: "急则治标", overallMethod: "益气止血固脱", subTherapies: [{ therapy: "益气固脱", targetPathogenesis: "气随血脱", priority: "主要" }] },
    formula: { candidates: [], patentAndWestern: [], modifications: [] },
  });
  const compile = (caseState) => compiler.compileM04Proposal({
    candidate: {
      name: "自拟方", applicable: "气血亏脱。", notApplicable: "",
      herbs: [
        { name: "黄芪", dose: "20g", role: "君", function: "补气摄血" }, { name: "熟地黄", dose: "12g", role: "君", function: "养血" },
        { name: "白芍", dose: "12g", role: "臣", function: "养血敛阴" }, { name: "炙甘草", dose: "6g", role: "使", function: "调和诸药" },
      ].map((herb) => ({ ...herb, targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, processing: null, isToxic: false, decoctionRequirement: null })),
      formulaAnalysis: "黄芪、熟地黄为君，白芍为臣，炙甘草为使。",
      decoction: { doseCount: "3剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，煎服", followUpNode: "3日复诊" },
    },
    patentAndWestern: [], modifications: [],
    nonPharma: { diet: "宜清淡。", lifestyle: "卧床休息。", emotion: "安定情绪。", precautions: ["方中有孕期慎用的药，如已怀孕或备孕请先告知医生。", "如已怀孕，请先告知医生，由医生确认后方可继续服用。", "饮食宜清淡易消化。"], tcmTreatments: [] },
  }, prior, caseState).nonPharma.precautions;
  const ectopic = compile(state({ chiefComplaint: "停经45天，右下腹撕裂样疼痛伴阴道流血2小时", patient: { sex: "女", age: 32 }, symptoms: { 现病史: "停经45天，突发右下腹撕裂样剧痛，伴阴道少量流血。" } }));
  assert.ok(!ectopic.some((line) => /如已怀孕|或备孕/u.test(line)), ectopic.join(" / "));
  assert.ok(!ectopic.some((line) => /^请先告知医生/u.test(line)), ectopic.join(" / "));
  assert.ok(ectopic.some((line) => /方中有孕期慎用的药/u.test(line)), ectopic.join(" / "));
  const plain = compile(state({ chiefComplaint: "乏力1月", patient: { sex: "女", age: 32 }, symptoms: { 现病史: "乏力1月，面色苍白。" } }));
  assert.ok(plain.some((line) => /如已怀孕或备孕/u.test(line)), plain.join(" / "));
});

// ───── 12 加减之间也不重复同源的药 ─────
await check("12.1 同一张处方的两条加减不各加瓜蒌子与瓜蒌（11.05 病历2 复测）；方中已有瓜蒌皮时不再加瓜蒌；无关的药照留", () => {
  const rows = [{ action: "加", herbName: "苦杏仁" }, { action: "加", herbName: "瓜蒌子" }, { action: "加", herbName: "瓜蒌" }, { action: "加", herbName: "射干" }];
  assert.deepEqual(compiler.withoutMutuallyIncompatibleAdditions(rows, ["荆芥", "金银花", "桔梗", "甘草"]).map((row) => row.herbName), ["苦杏仁", "瓜蒌子", "射干"]);
  assert.deepEqual(compiler.withoutMutuallyIncompatibleAdditions([{ action: "加", herbName: "瓜蒌" }], ["瓜蒌皮", "桔梗"]), []);
});

await check("10.3 辨证阶段的病名归一按本例的型判：血证 + 病历鼻出血 → 「吐血」「齿衄」照留（不当成本病同名）；交付面男性一项都没有时补到两项", () => {
  const wrap = (reasoning) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const reasoning = { stage: "diagnose", overview: { tcmDiseaseName: "血证", tcmDiseaseDifferentials: [{ diseaseName: "吐血" }, { diseaseName: "齿衄" }] } };
  const out = normalization.normalizeM03TcmDiseaseDifferentialNames(wrap(reasoning), "主诉：反复鼻出血3天\n现病史：反复鼻出血，血色鲜红。");
  assert.match(out, /吐血/u); assert.match(out, /齿衄/u);
  const unsubtyped = normalization.normalizeM03TcmDiseaseDifferentialNames(wrap(reasoning), "");
  assert.doesNotMatch(unsubtyped, /"diseaseName":"吐血"/u);
  const projected = surface.projectDeliveredReasoning({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: "血证", primarySyndrome: "胃热炽盛证", tcmDiseaseDifferentials: [] }, pathogenesis: {}, therapy: {}, westernDiagnosis: { primary: {} },
  }, { recordText: "主诉：反复鼻出血3天\n现病史：反复鼻出血。", patientSex: "男" });
  const names = projected.overview.tcmDiseaseDifferentials.map((item) => item.diseaseName);
  assert.equal(names.length, 2, names.join(","));
  assert.ok(!names.includes("经行衄血"), names.join(","));
});

await check("10.4 接线：辨证收口把病历文本交给病名归一（否则分型病按「血证」判，吐血、齿衄被丢）", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(`${process.cwd()}/src/lib/diagnosis-api.ts`, "utf8");
  assert.match(source, /normalizeM03TcmDiseaseDifferentialNames\(westernProjection, clinicalContext\)/u);
});
