// 第五十三轮：甲方 11.20 复测病历 10、13 查出的四类问题，按类从根上收口（模型调用一律不发生；病历为合成或取自甲方病历的去标识写法）。
//  A 炮制品药名：身份目录与剂量层各用一份前缀表 → 一份受治理构词（tcm-herb-preparation-morphology.source.json），构建期对系统会写出的全部药名
//    入表、运行时兜底；连带核对生成目录里被构词放大的未复核别名（故纸、车前、茴香…）。
//  B 一味药作废整页：编译器「按上限给出」与合同剂量判据各写一份 → 合同导出 conservativeDoseCeilingG，编译器读它；压不了的非君药定稿时单味拿出。
//  C 病历写了却报缺：体格检查「W15kg」；接口调用方把追问作答（舌象/脉象）放在 conversation 里，舌脉栏仍空。
//  D 推出来的字段不随交付内容更新：加减核对统计、triggerSource 引用、炮制栏、「本例已见」后的病程。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { "@": `${root}/src`, "server-only": `${root}/node_modules/next/dist/compiled/server-only/empty.js` } });
const identity = await jiti.import("../src/lib/tcm-herb-identity.ts");
const kb = await jiti.import("../src/lib/tcm-knowledge.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const pediatricRule = await jiti.import("../src/lib/pediatric-dose-rule.ts");
const pruning = await jiti.import("../src/lib/m04-modification-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const baseline = await jiti.import("../src/lib/formula-baseline-display.ts");

const check = async (id, title, run) => {
  if (process.env.R1070_CHECK && process.env.R1070_CHECK !== id) return;
  try { await run(); console.log(`✓ ${id} ${title}`); } catch (error) { process.exitCode = 1; console.error(`✗ ${id} ${title}\n${error.stack}`); }
};
const data = (name) => JSON.parse(fs.readFileSync(`${root}/src/data/${name}`, "utf8"));
const catalog = data("tcm-herb-identity-catalog.json");
const rawIndex = catalog.resolutionIndex;

/** 系统自己会写出的药名（与构建期 system_herb_name_universe 同源的几张表）。 */
function systemNames() {
  const names = new Set();
  const add = (value) => { const name = String(value || "").trim(); if (name && name.length <= 8) names.add(name); };
  for (const rule of data("tcm-herb-processing-forms.source.json").rules) { add(rule.form); add(rule.herb); }
  for (const row of data("tcm-herb-purpose-processing.json").herbs) for (const form of row.forms) {
    const p = form.prefix; const b = row.herb;
    for (const name of p === "" ? [b] : p === "炭" ? [`${b}炭`, `${b.slice(0, -1)}炭`] : p === "蜜" ? [`蜜${b}`, `炙${b}`] : [`${p}${b}`]) add(name);
  }
  for (const entry of data("tcm-formula-original-compositions.json").entries) for (const herb of entry.herbs) {
    add(herb.herb); add(herb.written);
    const doubled = herb.herb.startsWith(herb.preparation || "\u0000") || (herb.preparation === "炭" && herb.herb.endsWith("炭"));
    if (herb.preparation && !doubled) add(herb.preparation === "炭" ? `${herb.herb}炭` : `${herb.preparation}${herb.herb}`);
  }
  for (const row of data("tcm-textbook-syndrome-formula-table.json").rows) {
    for (const name of row.composition || []) add(name);
    for (const mod of row.modifications || []) for (const name of mod.herbs || []) add(name);
  }
  return names;
}

await check("A1", "系统会写出的药名里，剂量层查得到用量的，身份目录也都认得（不再一边按药典核过、一边写「身份待核」）", () => {
  const offenders = [];
  for (const name of systemNames()) {
    const limit = kb.getTcmHerbDoseLimit(name);
    const resolved = identity.resolveGovernedTcmHerbIdentity(name);
    if (limit && !(resolved.canonicalName || resolved.doseCanonicalName) && resolved.status !== "ambiguous") offenders.push(name);
  }
  assert.deepEqual(offenders, [], `剂量层有用量而身份未收：${offenders.slice(0, 20).join("、")}`);
});

await check("A2", "甲方病历 10 的土炒白术、制苍术，以及线上出现过的炒升麻/炒黄连/炒甘草：处方核对不再是「身份待核、剂量来源无」", () => {
  for (const [name, dose] of [["土炒白术", "12g"], ["制苍术", "9g"], ["炒升麻", "6g"], ["炒黄连", "3g"], ["炒甘草", "6g"]]) {
    const verification = compiler.compileHerbVerification(name, dose, "水煎服");
    assert.notEqual(verification.verificationTier, "identity_pending", `${name}：${JSON.stringify(verification)}`);
    assert.notEqual(verification.doseSource, "none", name);
  }
  // 反例：真正不认得的名字照旧是身份待核。
  assert.equal(compiler.compileHerbVerification("不存在草", "9g", "水煎服").verificationTier, "identity_pending");
});

await check("A3", "构建期与运行时同一条构词：入表的构词行，运行时规则算出的原药与之相同；不在表里的模型写法由运行时接住", () => {
  let compared = 0;
  for (const [name, row] of Object.entries(rawIndex)) {
    if (row.status !== "source_backed_preparation_form" || !(row.sourceRefs || []).includes("SRC-HERB-PREPARATION-MORPHOLOGY")) continue;
    const prepared = identity.preparedHerbNameBase(name);
    assert.ok(prepared, `${name} 运行时规则不成立`);
    assert.equal(prepared.row.canonicalName, row.canonicalName, name);
    assert.equal(prepared.preparation, row.preparation, name);
    compared += 1;
  }
  assert.ok(compared >= 500, `构词入表行数异常：${compared}`);
  // 构建期入表本身也要在（运行时兜底会掩盖构建期漏掉的名字，而方剂剂量可编译性是构建期按入表结果算的）。
  for (const name of ["土炒白术", "制苍术", "炒升麻"]) assert.ok((rawIndex[name]?.sourceRefs || []).includes("SRC-HERB-PREPARATION-MORPHOLOGY"), `${name} 未在构建期入表`);
  assert.ok(data("tcm-formula-governed-catalog.json").entries.find((entry) => entry.name === "连朴饮")?.doseCompilationEligible, "连朴饮（制厚朴、姜炒川连）应可编译");
  // 不在任何表里的写法：「盐炒泽泻」——运行时兜底。
  const probe = ["盐炒泽泻", "姜炒竹茹", "酒炒丹参"].find((name) => !(name in rawIndex));
  assert.ok(probe, "探针名意外全部入表，换一个");
  const resolved = identity.resolveGovernedTcmHerbIdentity(probe);
  assert.equal(resolved.status, "source_backed_preparation_form");
  assert.ok(resolved.canonicalName && probe.endsWith(resolved.canonicalName), JSON.stringify(resolved));
});

await check("A4", "两种规格并写（生熟地、生炙草）不当一味药；中医师裁定不合并的炒神曲/焦神曲各自单列", () => {
  for (const name of ["生熟地", "生炙草", "生熟干地黄"]) assert.equal(identity.resolveGovernedTcmHerbIdentity(name).canonicalName, undefined, name);
  for (const name of ["炒神曲", "焦神曲"]) {
    const resolved = identity.resolveGovernedTcmHerbIdentity(name);
    assert.equal(resolved.canonicalName, name);
    assert.equal(resolved.doseCanonicalName, "六神曲");
  }
  assert.equal(identity.preparedHerbNameBase("炒六神曲"), undefined, "六神曲不经构词合并");
  // 同一炮制字叠写不是构词（第五十三轮新臂实测：原方炮制改名把模型写好的「荆芥穗炭」又接一个「炭」）。
  for (const name of ["荆芥穗炭炭", "炒炒白术", "焦焦栀子"]) assert.equal(identity.resolveGovernedTcmHerbIdentity(name).canonicalName, undefined, name);
  assert.equal(baseline.originalPreparedHerbName("荆芥穗炭", "炭"), undefined);
  assert.equal(baseline.originalPreparedHerbName("炒白术", "炒"), undefined);
  assert.equal(baseline.originalPreparedHerbName("甘草", "炙"), "炙甘草");
  // 「炒黄芩」先试「炒黄＋芩」不成立（已不收「炒黄」这个前缀），落到「炒＋黄芩」。
  assert.equal(identity.resolveGovernedTcmHerbIdentity("炒黄芩").canonicalName, "黄芩");
});

await check("A5", "构词放大的未复核别名已按核对结果改正：故纸→补骨脂，车前/茴香/大戟/贯仲为歧义，地胆草不落到龙胆", () => {
  assert.equal(identity.resolveGovernedTcmHerbIdentity("故纸").canonicalName, "补骨脂");
  assert.equal(identity.resolveGovernedTcmHerbIdentity("生故纸").canonicalName, "补骨脂");
  for (const [name, candidates] of [["车前", ["车前子", "车前草"]], ["茴香", ["小茴香", "八角茴香"]], ["大戟", ["京大戟", "红大戟"]], ["贯仲", ["绵马贯众", "紫萁贯众"]]]) {
    const resolved = identity.resolveGovernedTcmHerbIdentity(name);
    assert.equal(resolved.status, "ambiguous", name);
    assert.deepEqual([...resolved.candidates].sort(), [...candidates].sort(), name);
    assert.equal(identity.resolveGovernedTcmHerbIdentity(`炒${name}`).canonicalName, undefined, `炒${name} 不得经构词落药`);
  }
  for (const name of ["地胆草", "木防己", "枸杞根"]) assert.equal(identity.resolveGovernedTcmHerbIdentity(name).canonicalName, undefined, name);
  assert.equal(identity.resolveGovernedTcmHerbIdentity("蜀漆").canonicalName, "蜀漆", "蜀漆单列，不归常山");
  // 原先依赖这些别名的方剂按方裁定，剂量可编译性不丢。
  const formulas = data("tcm-formula-governed-catalog.json").entries;
  for (const [formula, raw, resolved] of [["木防己汤", "木防己", "防己"], ["禹功散", "茴香", "小茴香"], ["桂枝去芍药加蜀漆龙骨牡蛎救逆汤", "蜀漆", "常山"]]) {
    const entry = formulas.find((item) => item.name === formula);
    assert.ok(entry?.doseCompilationEligible, `${formula} 不可编译`);
    assert.equal(entry.ingredientLinks.find((link) => link.rawName === raw)?.adjudicatedIngredient, resolved, formula);
  }
});

await check("A6", "炮制前缀不再在各模块另写：src/lib 里同时含「麸炒」「土炒」的正则只在登记过的地方", () => {
  // 第五十三轮登记时的存量（文字比对用的去前缀，语义各有差异，未在本轮改动）；只许减少，不许新增。
  const allowed = new Map([
    ["diagnosis-stage-contract.ts", 1], ["diagnosis-visible-summary.ts", 1], ["formula-analysis-review.ts", 2], ["formula-textbook-commentary.ts", 1],
    ["herb-decoction-rules.ts", 1], ["m04-proposal-compiler.ts", 4], ["tcm-formula-provenance.ts", 1], ["tcm-knowledge.ts", 2], ["tcm-textbook-syndromes.ts", 1],
  ]);
  const found = new Map();
  for (const file of fs.readdirSync(`${root}/src/lib`).filter((name) => name.endsWith(".ts"))) {
    const text = fs.readFileSync(`${root}/src/lib/${file}`, "utf8");
    const count = (text.match(/\/\^\(\?:[^/\n]*麸炒[^/\n]*\/[a-z]*/gu) || []).filter((source) => source.includes("土炒")).length;
    if (count) found.set(file, count);
  }
  for (const [file, count] of found) assert.ok(count <= (allowed.get(file) ?? 0), `${file} 新增了 ${count} 处炮制前缀正则；请改读 governedHerbPreparationPrefixes()`);
});

await check("B1", "性质检验：每一味有数值区间的普通药，成人与各儿童档写到两倍上限时，编译器按上限给出的剂量正好是合同认可的", () => {
  const stages = [undefined, 0.2, 0.7, 2, 5, 9, 14].map((age) => (age == null ? undefined : pediatricRule.pediatricDoseRuleForAgeYears(age)));
  let checked = 0;
  for (const herb of data("tcm-knowledge.json").herbs) {
    const name = herb.name;
    if (!name || kb.clinicianDoseHerbClass(name) || kb.isClinicianDoseHerb(name) || kb.getTcmHerbGenerationSafetyProfile(name).isToxic) continue;
    if (!identity.resolveGovernedTcmHerbIdentity(name).canonicalName) continue;
    const limit = kb.getTcmHerbDoseLimit(name);
    if (!limit || (limit.sourceType !== "dose" && limit.sourceType !== "routeDose") || !(limit.max > 0)) continue;
    for (const stage of stages) {
      const ceiling = contract.conservativeDoseCeilingG(name, "水煎服", stage);
      if (!ceiling) continue;
      const dose = `${Math.round(ceiling.ceiling * 2 * 2) / 2 || 1}g`;
      if (!contract.dosePassesSafetySanityCeiling(name, dose) || contract.doseWithinConservativeModelLimit(name, dose, "水煎服", stage)) continue;
      const deviation = contract.ordinaryHistoricalDoseDeviation({ name, dose }, "水煎服", stage);
      assert.ok(deviation && deviation.direction === "above_reference", `${name} ${dose} ${stage?.tableLabel || "成人"} 压不了`);
      assert.ok(contract.doseWithinConservativeModelLimit(name, `${deviation.max}g`, "水煎服", stage), `${name} 压到 ${deviation.max}g 合同仍驳回（${stage?.tableLabel || "成人"}）`);
      checked += 1;
    }
  }
  assert.ok(checked >= 1500, `覆盖异常：${checked}`);
});

await check("B2", "病历 13：6 岁患儿茯神写 10g（按茯苓折算上限 7.5g），按上限给出并写明依据，不再整页退成无剂量页", () => {
  const six = pediatricRule.pediatricDoseRuleForAgeYears(6);
  const deviation = contract.ordinaryHistoricalDoseDeviation({ name: "茯神", dose: "10g" }, "水煎服", six);
  assert.equal(deviation?.max, 7.5);
  assert.match(contract.doseCeilingBasisLabel("茯神", deviation.basis), /按茯苓的《中国药典》/u);
  assert.ok(contract.doseWithinConservativeModelLimit("茯神", "7.5g", "水煎服", six));
  // 反例：写在上限内不动；成人照旧按 15g。
  assert.equal(contract.ordinaryHistoricalDoseDeviation({ name: "茯神", dose: "7g" }, "水煎服", six), undefined);
  assert.equal(contract.ordinaryHistoricalDoseDeviation({ name: "茯神", dose: "20g" }, "水煎服")?.max, 15);
});

await check("B3", "按上限给出从不把剂量往上抬：写定剂量以下没有认可上沿时不压（低于下限只批注）", () => {
  assert.equal(contract.conservativeDoseCeilingG("茯苓", "水煎服", undefined, 8), undefined);
  assert.equal(contract.conservativeDoseCeilingG("茯苓", "水煎服", undefined, 20)?.ceiling, 15);
  const below = contract.ordinaryHistoricalDoseDeviation({ name: "茯苓", dose: "5g" }, "水煎服");
  assert.equal(below?.direction, "below_reference");
  for (const herb of data("tcm-knowledge.json").herbs) {
    const limit = kb.getTcmHerbDoseLimit(herb.name || "");
    if (!limit?.alternatives?.length) continue;
    for (const grams of [limit.max + 0.5, limit.max * 1.6, limit.max * 3]) {
      const ceiling = contract.conservativeDoseCeilingG(herb.name, "水煎服", undefined, grams);
      if (ceiling) assert.ok(ceiling.ceiling < grams, `${herb.name} ${grams}g 压成 ${ceiling.ceiling}g`);
    }
  }
});

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const prescription = (herbs) => `${START}\n${JSON.stringify({ stage: "prescribe", overview: { primarySyndrome: "痰湿蕴肺证" }, formula: { candidates: [{ name: "本例辨证组方", herbs, decoction: { method: "水煎服，每日1剂" } }], modifications: [] } })}\n${END}`;
const herbsOf = (content) => JSON.parse(content.slice(content.indexOf(START) + START.length, content.indexOf(END))).formula.candidates[0].herbs;

await check("B4", "合同驳回而编译器不压的非君药（有毒药味超上限）定稿时单味拿出、写明原因；唯一君药不拿", () => {
  const context = "患者年龄：45岁\n患者性别：男\n主诉：咳嗽痰多2周";
  const herbs = [
    { name: "陈皮", role: "君", dose: "10g", function: "理气燥湿" },
    { name: "茯苓", role: "臣", dose: "15g", function: "健脾渗湿" },
    { name: "甘草", role: "使", dose: "6g", function: "调和诸药" },
    { name: "半夏", role: "佐", dose: "15g", function: "燥湿化痰" },
  ];
  assert.equal(contract.doseWithinConservativeModelLimit("半夏", "15g", "水煎服"), false);
  const out = pruning.dropSafetyConflictingM04CandidateHerbs(prescription(herbs), context);
  const kept = herbsOf(out).map((herb) => herb.name);
  assert.deepEqual(kept, ["陈皮", "茯苓", "甘草"]);
  assert.match(out, /半夏[^"]{0,40}有毒药味不由系统自动减量/u);
  // 反例：同一味是唯一君药时不拿（交给修复轮）；剂量在范围内照留。
  const asEmperor = herbs.map((herb) => (herb.name === "半夏" ? { ...herb, role: "君" } : herb.name === "陈皮" ? { ...herb, role: "臣" } : herb));
  assert.ok(herbsOf(pruning.dropSafetyConflictingM04CandidateHerbs(prescription(asEmperor), context)).some((herb) => herb.name === "半夏"));
  const withinRange = herbs.map((herb) => (herb.name === "半夏" ? { ...herb, name: "法半夏", dose: "9g" } : herb));
  assert.ok(herbsOf(pruning.dropSafetyConflictingM04CandidateHerbs(prescription(withinRange), context)).some((herb) => herb.name === "法半夏"));
  // 没有 dose 键的行（单元夹具、旧快照）不按缺剂量拿掉：编译出的药味行一律带 dose 键。
  const noDoseKey = [...withinRange, { name: "桔梗", role: "佐", function: "宣肺祛痰" }];
  assert.equal(herbsOf(pruning.dropSafetyConflictingM04CandidateHerbs(prescription(noDoseKey), context)).length, 5);
});

await check("B5", "同一类的另两种：知识库认不出的非君药、不能与他药同煎的非君药（芒硝）定稿时单味拿出；君药照旧交给修复轮", () => {
  const context = "患者年龄：45岁\n患者性别：男\n主诉：腹胀便秘3天";
  const herbs = [
    { name: "大黄", role: "君", dose: "10g", function: "泻下攻积" },
    { name: "厚朴", role: "臣", dose: "12g", function: "行气消胀" },
    { name: "枳实", role: "臣", dose: "10g", function: "破气消积" },
    { name: "芒硝", role: "佐", dose: "9g", function: "软坚泻下" },
    { name: "不存在草", role: "佐", dose: "9g", function: "x" },
  ];
  const out = pruning.dropSafetyConflictingM04CandidateHerbs(prescription(herbs), context);
  assert.deepEqual(herbsOf(out).map((herb) => herb.name), ["大黄", "厚朴", "枳实"]);
  assert.match(out, /芒硝[^"]{0,30}不能与他药同煎/u);
  assert.match(out, /不存在草[^"]{0,30}未查到这一味的规范药名/u);
  const asEmperor = herbs.map((herb) => (herb.name === "不存在草" ? { ...herb, role: "君" } : herb.name === "大黄" ? { ...herb, role: "臣" } : herb));
  assert.ok(herbsOf(pruning.dropSafetyConflictingM04CandidateHerbs(prescription(asEmperor), context)).some((herb) => herb.name === "不存在草"));
});

await check("A7", "几种炮制写法都认得时取药典正名：炮制栏蜜炙＋甘草并进药名是炙甘草，不是构词出来的蜜甘草", () => {
  assert.equal(surface.processedNameFromColumn("甘草", "蜜炙"), "炙甘草");
  assert.deepEqual(identity.preferStandardHerbNames(["蜜甘草", "炙甘草"]), ["炙甘草", "蜜甘草"]);
  assert.equal(surface.processedNameFromColumn("黄芩", "酒炙"), "酒黄芩");
});

const gateMissing = (input) => safety.withSafetyGate(types.normalizeCaseStateInput(input)).safetyGate.missingItemCodes || [];

await check("C1", "甲方体格检查写法「W15kg」「W 20kg」读成体重；化验缩写、体重下降不算", () => {
  const base = (exam) => ({ patient: { age: 6, sex: "男" }, chiefComplaint: "夜间遗尿反复1年", symptoms: { 现病史: "夜间遗尿反复1年", 体格检查: exam }, tongue: "舌淡苔白", pulse: "脉沉细" });
  for (const exam of ["T 36.5℃，P 96次/分，W15kg", "W 20kg，神志清", "体重15kg", "Wt15kg"]) assert.ok(!gateMissing(base(exam)).includes("pediatric_weight_unknown"), exam);
  for (const exam of ["WBC 15×10^9/L", "近半年体重下降2kg", "W15"]) assert.ok(gateMissing(base(exam)).includes("pediatric_weight_unknown"), exam);
});

await check("C2", "接口调用方回答我们的舌象/脉象追问：作答补进空着的舌脉栏，闸门不再报缺；没取得、栏位已有值、页面形状都不动", () => {
  const ask = (question, answer, extra = {}) => ({
    patient: { age: 42, sex: "女" }, chiefComplaint: "乏力、疲倦2月余", symptoms: { 现病史: "乏力、疲倦2月余，伴食欲减退、大便偏稀。" },
    conversation: [{ role: "assistant", content: question }, { role: "user", content: answer }], ...extra,
  });
  const state = types.normalizeCaseStateInput(ask("舌象更接近下列哪一种？", "舌红少津"));
  assert.equal(state.tongue, "舌红少津");
  assert.ok(!gateMissing(ask("舌象更接近下列哪一种？", "舌红少津")).includes("tongue_unknown"));
  assert.equal(types.normalizeCaseStateInput(ask("脉象更接近下列哪一种？", "弦细")).pulse, "脉弦细");
  assert.deepEqual([types.normalizeCaseStateInput(ask("舌脉情况如何？", "舌淡苔白，脉细弱"))].map((s) => [s.tongue, s.pulse])[0], ["舌淡苔白", "脉细弱"]);
  // 反例。
  assert.equal(types.normalizeCaseStateInput(ask("舌象更接近下列哪一种？", "本次未取得该信息")).tongue, undefined);
  for (const answer of ["舌象看不清", "舌苔没看清楚", "舌象未能查看"]) assert.equal(types.normalizeCaseStateInput(ask("舌象更接近下列哪一种？", answer)).tongue, undefined, answer);
  assert.equal(types.normalizeCaseStateInput(ask("舌象更接近下列哪一种？", "舌红少津", { tongue: "舌淡红，苔薄白" })).tongue, "舌淡红，苔薄白");
  assert.equal(types.normalizeCaseStateInput(ask("大便情况如何？", "大便偏稀，苔腻")).tongue, undefined);
});

const m04 = (overrides = {}) => ({
  stage: "prescribe",
  overview: { primarySyndromeBasis: ["带下量多色白质稀", "伴乏力纳差"] },
  westernDiagnosis: { primary: { supportingFacts: ["本例带下量多色白质稀持续3月，考虑阴道炎可能。"] } },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "发病以来腰膝酸软，睡眠尚可" }] },
  formula: {
    candidates: [{ herbs: [{ name: "土炒白术", processing: null, dose: "12g" }, { name: "制苍术", processing: null, dose: "9g" }, { name: "人参", processing: null, dose: "6g" }, { name: "酒白芍", processing: "酒炙", dose: "15g" }] }],
    modifications: [
      { trigger: "腰膝酸软", triggerSource: { kind: "western_supporting_fact", sourceRef: "westernDiagnosis.primary.supportingFacts[3]", sourceQuote: "发病以来腰膝酸软" }, herbName: "续断" },
      { trigger: "本例已见夜间遗尿反复1年", herbName: "桑螵蛸" },
      { trigger: "本例已见食欲不振", triggerSource: { kind: "primary_syndrome_basis", sourceRef: "overview.primarySyndromeBasis[1]", sourceQuote: "伴乏力纳差" }, herbName: "砂仁" },
    ],
    modificationReview: { submittedCount: 4, retainedCount: 1, droppedCount: 3, droppedReason: "x", droppedReasons: [{ code: "trigger_not_symptom", count: 2, message: "该条件不是需要另行加减的伴随表现" }] },
  },
  ...overrides,
});

await check("D1", "加减核对统计按交付的加减重算：保留=交付条数，删除=各原因合计，提交=两者之和", () => {
  const out = surface.withDerivedPrescriptionBookkeeping(m04());
  assert.deepEqual([out.formula.modificationReview.submittedCount, out.formula.modificationReview.retainedCount, out.formula.modificationReview.droppedCount], [5, 3, 2]);
  assert.equal(out.formula.modificationReview.droppedReason, "该条件不是需要另行加减的伴随表现（2条）");
});

await check("D2", "triggerSource 在交付内容里落空时改指仍能找到原文的位置，找不到就去掉；原本有效的不动", () => {
  const out = surface.withDerivedPrescriptionBookkeeping(m04());
  assert.deepEqual(out.formula.modifications[0].triggerSource, { kind: "pathogenesis_patient_fact", sourceRef: "pathogenesis.chain[0].patientFact:P1", sourceQuote: "发病以来腰膝酸软" });
  assert.deepEqual(out.formula.modifications[2].triggerSource, m04().formula.modifications[2].triggerSource);
  const noHome = m04({ pathogenesis: { chain: [] } });
  assert.equal(surface.withDerivedPrescriptionBookkeeping(noHome).formula.modifications[0].triggerSource, undefined);
});

await check("D3", "药名写着炮制而炮制栏空着时补上（土炒白术→土炒、制苍术→制）；已有炮制栏不动", () => {
  const herbs = surface.withDerivedPrescriptionBookkeeping(m04()).formula.candidates[0].herbs;
  assert.deepEqual(herbs.map((herb) => herb.processing), ["土炒", "制", null, "酒炙"]);
});

await check("D4", "「本例已见」后面不带病程（本例已见夜间遗尿反复1年 → 本例已见夜间遗尿）；只剩病程时不删；重复执行不变", () => {
  const out = surface.withDerivedPrescriptionBookkeeping(m04());
  assert.equal(out.formula.modifications[1].trigger, "本例已见夜间遗尿");
  const shortOnly = m04(); shortOnly.formula.modifications[1].trigger = "本例已见3天";
  assert.equal(surface.withDerivedPrescriptionBookkeeping(shortOnly).formula.modifications[1].trigger, "本例已见3天");
  assert.deepEqual(surface.withDerivedPrescriptionBookkeeping(out), out);
  // 辨证阶段不动。
  const diagnose = { stage: "diagnose", formula: null };
  assert.equal(surface.withDerivedPrescriptionBookkeeping(diagnose), diagnose);
});
