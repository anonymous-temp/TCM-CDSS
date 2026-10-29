// 第三十轮（2026-10-29）：甲方当天实测里还没修的几处——1 岁女童病历写着婚育、月经记录；「慢性失眠障碍」病程 2 月余；
// 婴幼儿拔罐卡；针刺卡里写给系统的话；西医依据「症状层面工作诊断」；选了扶阳的病例辨证依据丢了流派那一句。
// 每条断言都有反证（~/runlogs/r1018/work/r1042/cp/）。
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
const conception = await jiti.import("../src/lib/conception-herb-policy.ts");
const precautions = await jiti.import("../src/lib/required-precautions.server.ts");
const checklist = await jiti.import("../src/lib/rationale-findings-checklist.ts");
const capabilities = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
const western = await jiti.import("../src/lib/western-name-evidence-check.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const coverage = await jiti.import("../src/lib/m03-rationale-coverage.server.ts");
const lineages = await jiti.import("../src/lib/tcm-lineages.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");

// 甲方 2026-10-29 00000239 的病历形状（接口传参：病历在 symptoms 的中文键里）。
const infantRecord = (overrides = {}) => types.normalizeCaseStateInput({
  id: "r1042-infant", chiefComplaint: "咳嗽、咽干伴恶心3天", patient: { sex: "女", age: 1 },
  symptoms: { 现病史: "患者3天前出现咳嗽、咽干伴恶心。", 过敏史: "否认药物及食物过敏史", 个人史: "月经周期 13天，有痛经史", 婚育史: "配偶体健，备孕" },
  tongue: "舌质淡红，苔薄白", ...overrides,
});
const withPatient = (patient, symptoms = {}, chiefComplaint = "咳嗽、咽干伴恶心3天") => types.normalizeCaseStateInput({
  id: "r1042-x", chiefComplaint, patient, symptoms: { 现病史: "患者3天前出现咳嗽、咽干伴恶心。", 过敏史: "否认药物及食物过敏史", ...symptoms },
});

// ---------- 1 未满 10 岁的病历写着本人的婚育、月经记录 ----------
await check("1.1 1 岁女童「月经周期13天，有痛经史」「配偶体健，备孕」：逐句列出，红旗筛查提示医生核实", () => {
  const state = infantRecord();
  assert.deepEqual(safety.ageImplausibleReproductiveStatements(state), ["月经周期 13天", "有痛经史", "配偶体健", "备孕"]);
  const advisories = safety.evaluateSafetyGate(state).advisories || [];
  assert.ok(advisories.some((line) => /与患者年龄（1岁）不符，可能录入有误，请核实/.test(line) && line.includes("配偶体健")), JSON.stringify(advisories));
  assert.match(safety.ageImplausibleReproductiveNotice(state), /【病历与年龄核对】.*不作为辨病、辨证、用药与注意事项的依据/);
  assert.match(safety.ageImplausibleReproductiveAdvisory(withPatient({ sex: "女", age: "8个月" }, { 婚育史: "已婚" })) || "", /（8个月）/);
  // 未满 8 岁写着月经（栏目名去掉后照读）。
  assert.deepEqual(safety.ageImplausibleReproductiveStatements(withPatient({ sex: "女", age: 7 }, { 个人史: "婚育月经史：月经初潮6岁" })), ["月经初潮6岁"]);
});

await check("1.2 对照：不提示的情形（喂养方式、母亲孕期、尚未来潮、性早熟就诊、10 岁及以上、否认）", () => {
  for (const [patient, symptoms, chief] of [
    [{ sex: "女", age: 1 }, { 个人史: "足月顺产，母乳喂养", 婚育史: "未婚" }],
    [{ sex: "女", age: 3 }, { 个人史: "其母孕期患妊娠期糖尿病，出生体重3.2kg" }],
    [{ sex: "女", age: 9 }, { 个人史: "月经尚未来潮" }],
    [{ sex: "女", age: 7 }, { 个人史: "月经尚未来潮" }],
    [{ sex: "女", age: 8 }, { 个人史: "月经来潮3个月，周期不规律" }, "阴道出血3个月"],
    [{ sex: "女", age: 12 }, { 个人史: "月经周期 28天，有痛经史", 婚育史: "未婚" }],
    [{ sex: "女", age: 5 }, { 个人史: "无痛经", 婚育史: "无" }],
    // 8–9 岁写着月经是性早熟，要看的病，不是录错（回放：社区病历「9 岁，乳房变大一段时间，近期月经突然来潮」）。
    [{ sex: "女", age: 9 }, { 现病史: "乳房开始变大，月经突然来潮。", 既往史: "婚育月经史：月经初潮（9岁）" }, "乳房变大一段时间，近期月经突然来潮"],
    [{ sex: "女", age: 9 }, { 个人史: "月经初潮9岁，周期不规律" }],
    // 未满 8 岁、就诊的就是阴道流血或乳房发育（性早熟就诊）：月经记录是这次要看的内容。
    [{ sex: "女", age: 7 }, { 现病史: "近2天阴道少量流血，家长以为月经来潮。" }, "阴道少量流血2天"],
    [{ sex: "女", age: 6 }, { 现病史: "半年来乳房逐渐变大，1月前月经来潮。" }, "乳房逐渐变大半年"],
    // 只写了栏目名的模板占位（甲方 10/28「个人史，月经史」）、栏目名里的「月经」。
    [{ sex: "女", age: 7 }, { 个人史: "个人史，月经史" }],
    [{ sex: "女", age: 5 }, { 个人史: "婚育月经史：未婚" }],
  ]) {
    const state = withPatient(patient, symptoms, chief);
    assert.deepEqual(safety.ageImplausibleReproductiveStatements(state), [], JSON.stringify(symptoms));
    assert.ok(!(safety.evaluateSafetyGate(state).advisories || []).some((line) => /与患者年龄/.test(line)), JSON.stringify(symptoms));
  }
});

await check("1.3 备孕这一档不给未满 10 岁的：药典孕妇禁用档、注意事项「月经逾期先验孕」都不出；成人照旧", () => {
  const infant = infantRecord();
  assert.equal(conception.chpPregnancyHerbTier(safety.clinicalGroundingText(infant)), undefined);
  assert.ok(!precautions.requiredPrecautionsForCase(infant).some((item) => item.kind === "conception_pregnancy_check"));
  const adult = infantRecord({ patient: { sex: "女", age: 30 } });
  assert.equal(conception.chpPregnancyHerbTier(safety.clinicalGroundingText(adult)), "conception");
  assert.ok(precautions.requiredPrecautionsForCase(adult).some((item) => item.kind === "conception_pregnancy_check"));
});

await check("1.4 辨证依据清单不列这些记录（此前逼出「痛经史为既往宿疾，不参与本次辨证」）；其余表现照列", () => {
  const facts = { affirmedSymptoms: [{ term: "痛经", quote: "有痛经史" }, { term: "乏力", quote: "伴乏力" }] };
  const symptoms = { 现病史: "患者3天前出现咳嗽、咽干伴恶心，伴乏力。", 个人史: "月经周期 13天，有痛经史", 婚育史: "配偶体健，备孕" };
  const infant = { ...infantRecord({ symptoms }), clinicalFacts: facts };
  const list = checklist.rationaleFindingsChecklist(infant);
  assert.ok(!list.includes("痛经") && list.includes("乏力"), JSON.stringify(list));
  const adult = { ...infantRecord({ symptoms, patient: { sex: "女", age: 30 } }), clinicalFacts: facts };
  assert.ok(checklist.rationaleFindingsChecklist(adult).includes("痛经"));
});

await check("1.5 辨证、开方两条路由都把核对提示接进提示词", () => {
  for (const route of ["src/app/api/diagnosis/diagnose/route.ts", "src/app/api/diagnosis/prescribe/route.ts"]) {
    assert.match(readFileSync(route, "utf8"), /ageImplausibleReproductiveNotice\(safeState\)/, route);
  }
});

// ---------- 2 婴幼儿不拔罐 ----------
const evidence = [{ type: "patient_fact", source: "主诉", confidence: "中" }];
const prior = {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "咳嗽", primarySyndrome: "肺胃气逆证", overallPathogenesis: "肺失宣肃", overallTherapy: "宣肃肺气", recommendedFormulaDirection: "无", evidence },
  westernDiagnosis: { primary: { name: "急性上呼吸道感染", status: "考虑", confidence: "中", supportingFacts: [], limitations: [], suggestedChecks: [], evidence }, differentials: [] },
  pathogenesis: { summary: "肺失宣肃", locationDifferentiation: { items: [], evidence }, natureDifferentiation: { items: [], evidence },
    chain: [{ nodeId: "P1", patientFact: "咳嗽", syndromeEvidence: "咳嗽", pathogenesis: "肺失宣肃", therapyDirection: "宣肃肺气", evidence }], uncertainties: [] },
  therapy: { overallPrinciple: "实则泻之", overallMethod: "宣肃肺气", subTherapies: [] }, formula: null, nonPharma: null, lineageAdaptation: null,
};
const child = (age) => ({ patient: { sex: "女", age }, chiefComplaint: "咳嗽3天", symptoms: { presentHistory: "咳嗽，咽干" } });

await check("2.1 未满 3 岁不出拔罐卡（《刺法灸法学》「婴幼儿…不宜拔罐」）；3 岁起、成人照旧；针刺、耳穴不受影响", () => {
  for (const age of [1, "8个月", 2.5]) assert.match(capabilities.tcmTreatmentProjectExclusionReason("cupping", prior, child(age)) || "", /婴幼儿不宜拔罐/, String(age));
  for (const age of [3, 6, 40]) assert.equal(capabilities.tcmTreatmentProjectExclusionReason("cupping", prior, child(age)), undefined, String(age));
  for (const code of ["acupuncture", "auricular"]) assert.equal(capabilities.tcmTreatmentProjectExclusionReason(code, prior, child(1)), undefined, code);
});

// ---------- 3 「N月余」够不上 N+1 月的门槛 ----------
await check("3.1 「失眠…2月余」不是慢性失眠障碍（ICSD-3 满 3 个月）：交付失眠障碍；满 3 个月照旧", () => {
  const record = (course) => `主诉：失眠、多梦伴心悸、乏力${course}\n现病史：患者${course}前因工作压力过大出现失眠。`;
  assert.equal(western.deterministicWesternNameCorrection("慢性失眠障碍", record("2月余"), 38)?.supportedName, "失眠障碍");
  assert.equal(western.deterministicWesternNameCorrection("慢性失眠障碍", record("2个多月"), 38)?.supportedName, "失眠障碍");
  for (const course of ["3个月", "3月余", "半年"]) assert.equal(western.deterministicWesternNameCorrection("慢性失眠障碍", record(course), 38), undefined, course);
});

await check("3.2 病程上界：约数取不到上界，确数取得到", () => {
  assert.equal(western.recordCourseBelowThreshold({ upper: 90, upperExclusive: true }, 90), true);
  assert.equal(western.recordCourseBelowThreshold({ upper: 90, upperExclusive: false }, 90), false);
  assert.deepEqual(western.recordCourseDays("主诉：咽痛2周余"), { lower: 14, upper: 21, upperExclusive: true });
  assert.deepEqual(western.recordCourseDays("主诉：咽痛3周"), { lower: 21, upper: 21, upperExclusive: false });
});

// ---------- 4 卡片里写给系统的话 ----------
const prescribePayload = (techniqueBoundary) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
  overview: { tcmDiseaseName: "咳嗽", primarySyndrome: "风寒袭肺证" },
  formula: { candidates: [], patentAndWestern: [], modifications: [] },
  nonPharma: { precautions: [], tcmTreatments: [{ projectCode: "acupuncture", projectName: "针刺疗法", techniqueBoundary, scheduleSuggestion: "每日1次。" }] },
});

await check("4.1 针刺卡「…由现场医师复核后确定。适用于成人普通急性/亚急性咳嗽…不适用。」交付时去掉，操作本身留着", () => {
  const card = "如有怀孕可能请先告知医生：合谷孕期不宜针灸刺激。毫针针刺，风寒证以泻法为主并可配合灸法；进针深度、补泻手法、留针时长与禁忌由现场医师复核后确定。适用于成人普通急性/亚急性咳嗽已明确风寒袭肺或风寒束肺者；流感、感染恢复期、风热犯肺与红旗病例不适用。";
  const out = surface.projectDeliveredReasoning(prescribePayload(card)).nonPharma.tcmTreatments[0].techniqueBoundary;
  assert.equal(out, "如有怀孕可能请先告知医生：合谷孕期不宜针灸刺激。毫针针刺，风寒证以泻法为主并可配合灸法。");
  const rehab = "仅适用于已完成急性感染期处置后的恢复期；毫针操作、证型配穴和禁忌由具备资质的医师复核。";
  assert.equal(surface.projectDeliveredReasoning(prescribePayload(rehab)).nonPharma.tcmTreatments[0].techniqueBoundary, "仅适用于已完成急性感染期处置后的恢复期。");
});

await check("4.2 对照：写给医生的操作要求不动（孕期禁忌穴位由医师现场决定、距离和热度由医师控制、以现场查体为准）", () => {
  for (const text of [
    "妊娠可能、异常大量出血、急性腹痛或盆腔感染线索必须先复核；孕期禁忌穴位和操作由医师现场决定。",
    "仅适用于恢复期且无皮肤破损、感觉障碍或热损伤高风险者；距离和热度由医师控制。",
    "小儿针刺宜浅刺、快出针，一般不留针。补泻手法、进针深度以现场查体为准。",
  ]) assert.equal(surface.projectDeliveredReasoning(prescribePayload(text)).nonPharma.tcmTreatments[0].techniqueBoundary, text);
});

// ---------- 5 「症状层面工作诊断」 ----------
await check("5.1 西医依据「暂按眩晕综合征作症状层面工作诊断」交付为「初步诊断」；提示词不再写「工作判断」引子", () => {
  assert.equal(surface.clinicalWordingForSyntheticPhrases("缺乏前庭及影像客观依据，暂按眩晕综合征作症状层面工作诊断，需进一步定位病因。"),
    "缺乏前庭及影像客观依据，暂按眩晕综合征作初步诊断，需进一步定位病因。");
  assert.equal(surface.clinicalWordingForSyntheticPhrases("支持将胃食管反流病作为当前工作诊断。"), "支持将胃食管反流病作为当前初步诊断。");
  // 「的」留着（回放留存结果：「痰湿蕴肺的工作判断可成立」曾成「痰湿蕴肺初步判断可成立」）。
  assert.equal(surface.clinicalWordingForSyntheticPhrases("痰湿蕴肺的工作判断可成立但边界未完全确定。"), "痰湿蕴肺的初步判断可成立但边界未完全确定。");
  assert.equal(surface.clinicalWordingForSyntheticPhrases("暂作症状层面的工作诊断。"), "暂作初步诊断。");
  assert.equal(surface.clinicalWordingForSyntheticPhrases("无法定位病因，暂以症状层面诊断。"), "无法定位病因，暂以症状诊断。");
  assert.equal(surface.clinicalWordingForSyntheticPhrases("暂不能指向具体病因，故取症状层面诊断。"), "暂不能指向具体病因，故取症状诊断。");
  assert.equal(surface.clinicalWordingForSyntheticPhrases("暂只能停留在症状层面，需先排除器质性病因。"), "暂只能停留在症状诊断，需先排除器质性病因。");
  assert.equal(surface.clinicalWordingForSyntheticPhrases("舌脉、病程及寒热虚实表现未记录，证候仅达症状层。"), "舌脉、病程及寒热虚实表现未记录，证候仅达症状。");
  for (const untouched of ["病因暂不明确，需进一步检查。", "工作压力大后起病。"]) assert.equal(surface.clinicalWordingForSyntheticPhrases(untouched), untouched);
  const source = readFileSync("src/lib/m03-context-packets.ts", "utf8");
  assert.ok(source.includes("clinicalRationale 用1–2句（≤100字）说明"), "clinicalRationale 一句的说明找不到了，本条断言需要随之更新");
  assert.ok(!source.includes("事实模式→工作判断") && !source.includes("写症状层面的诊断"));
  // 不在提示词里加「不写…分级用语」一类禁令：本机实测它让中医半连流派眼目句一起不写（6/6 漏写，去掉后 2/3 写）。措辞由交付面改。
  assert.ok(!/不写“工作诊断”/.test(source));
});

// ---------- 6 流派视角那一句 ----------
const lens = "扶阳学派看阴阳实据，本例恶寒重、无汗、脉浮紧属表寒实证，未见阳虚阴盛实据。";
const rewriteInput = {
  rationale: `恶寒重、发热轻、无汗，为风寒束表。${lens}`,
  findings: ["鼻塞", "流清涕"], missing: ["鼻塞", "流清涕"], primary: "风寒束表证", secondary: [],
};

await check("6.1 以派名起头的眼目句也认得（此前依据重写只认「以下按常规辨证处理」「从…看」）", () => {
  assert.equal(lineages.isLineageLensSentence(lens), true);
  assert.equal(lineages.isLineageLensSentence("从温病卫气营血看，本例属卫分证，以下按常规辨证处理。"), true);
  assert.equal(lineages.isLineageLensSentence("恶寒重、发热轻、无汗，为风寒束表。"), false);
  assert.equal(lineages.isLineageLensSentence("温病多见发热重。"), false);
});

await check("6.2 依据重写稿丢了流派那一句时原样接回末尾；没有流派句的原稿不加", () => {
  const rewritten = coverage.acceptedRationaleRewrite("恶寒重、发热轻、无汗，为风寒束表、卫阳被遏；鼻塞、流清涕为风寒犯肺、鼻窍不利；舌淡红、苔薄白、脉浮紧为表寒之象。", rewriteInput);
  assert.ok(rewritten?.endsWith(lens.replace(/\s+/g, "")), rewritten);
  assert.equal((rewritten.match(/扶阳学派看/g) || []).length, 1);
  const plain = coverage.acceptedRationaleRewrite("恶寒重、发热轻、无汗，为风寒束表、卫阳被遏；鼻塞、流清涕为风寒犯肺、鼻窍不利；舌淡红、苔薄白、脉浮紧为表寒之象。", { ...rewriteInput, rationale: "恶寒重、发热轻、无汗，为风寒束表。" });
  assert.ok(plain && !/扶阳/.test(plain), plain);
});

await check("6.3 流派句里的证名不算重写稿的外来证名；别派眼目句照旧去掉、本派的留着", () => {
  assert.deepEqual(coverage.foreignSyndromeNames(`恶寒重为风寒束表证。扶阳学派看阴阳实据，属阳虚寒凝证者方用温阳，本例未见。`, { ...rewriteInput, rationale: "恶寒重。" }), []);
  const reasoning = { overview: { tcmDiagnosticRationale: `恶寒重为风寒束表。温病看卫气营血层次，以下按常规辨证处理。${lens}` } };
  assert.equal(provenance.withoutForeignLineageLensSentence(reasoning, "support-yang").overview.tcmDiagnosticRationale, `恶寒重为风寒束表。${lens}`);
});

await check("6.4 选了流派时，提示词末尾的逐项交代清单提醒流派那一句照写（本机：清单在最末时 10 次里 6 次漏写）；不限流派不提", () => {
  const facts = { affirmedSymptoms: [{ term: "鼻塞", quote: "鼻塞" }, { term: "流清涕", quote: "流清涕" }] };
  const record = (lineage) => ({ ...types.normalizeCaseStateInput({ id: "r1042-lens", chiefComplaint: "恶寒、发热2天", patient: { sex: "女", age: 24 },
    symptoms: { 现病史: "淋雨后恶寒、发热，伴鼻塞、流清涕，无汗。" }, tcmLineagePreference: lineage }), clinicalFacts: facts });
  assert.match(checklist.rationaleFindingsChecklistNotice(record("support-yang")), /末尾仍按上文要求加一句「扶阳[^」]*」的辨证眼目/);
  assert.doesNotMatch(checklist.rationaleFindingsChecklistNotice(record("unrestricted")), /辨证眼目/);
  // 清单不足两项（1 岁女童选了扶阳：主诉以外没有可列的表现）时，单独提醒这一句。
  const sparse = (lineage) => ({ ...types.normalizeCaseStateInput({ id: "r1042-lens2", chiefComplaint: "咳嗽、咽干伴恶心3天", patient: { sex: "女", age: 1 },
    symptoms: { 现病史: "患者3天前出现咳嗽、咽干伴恶心。" }, tcmLineagePreference: lineage }), clinicalFacts: { affirmedSymptoms: [] } });
  assert.match(checklist.rationaleFindingsChecklistNotice(sparse("support-yang")), /【辨证依据末句】.*「扶阳[^」]*」的辨证眼目/);
  assert.equal(checklist.rationaleFindingsChecklistNotice(sparse("unrestricted")), "");
});

console.log(JSON.stringify({ suite: "r1042-main", cases }));
