// 第四十七轮 C3：鉴别主症交集、定义原文、最终病名指南、出处身份、病类不作证名、术后方前置条件。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const tb = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const guidelines = await jiti.import("../src/lib/western-guideline-references.ts");
const evidence = await jiti.import("../src/lib/cdss-evidence-context.ts");
const authoring = await jiti.import("../src/lib/tcm-disease-differential-authoring.server.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const original = await jiti.import("../src/lib/formula-original-composition.ts");
let failures = 0;
async function check(name, fn) { try { await fn(); console.log(`✓ ${name}`); } catch (error) { failures++; console.error(`✗ ${name}\n  ${error.message}`); process.exitCode = 1; } }
const chief = text => `主诉：${text}\n现病史：${text}`;
const differential = name => ({ diseaseName: name, typicalManifestation: "无痛、单侧、边界清楚", reason: "主症相近", distinguishingPoints: "本例表现需进一步核实", nextCheck: null });
const dx = (disease, syndrome, direction = "", extra = {}) => ({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseName: disease, primarySyndrome: syndrome, secondarySyndromes: [], primarySyndromeResolution: "resolved", recommendedFormulaDirection: direction, tcmDiseaseDifferentials: [], ...extra }, therapy: { overallMethod: "益气止血固脱" } });
const wrap = obj => `<!-- DIAGNOSIS_JSON_START -->${JSON.stringify(obj)}<!-- DIAGNOSIS_JSON_END -->`;
const unwrap = text => JSON.parse(text.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/)[1]);
await check("1.1 主症概念共享且不借伴随症状：咽痛不补郁证，吞咽困难不等于咽痛", () => {
 assert.equal(tb.textbookDifferentialSharesChiefComplaint("郁证", chief("咽痛半年，伴心情低落")), false);
 assert.equal(tb.textbookDifferentialSharesChiefComplaint("噎膈", chief("咽痛半年")), false);
 assert.equal(tb.textbookDifferentialSharesChiefComplaint("噎膈", chief("持续情绪低落、早醒2个月")), false);
 assert.equal(tb.textbookDifferentialSharesChiefComplaint("噎膈", chief("吞咽困难1月")), true);
});
await check("1.2 崩漏不补白带病，按概念接受经血与阴道流血；服务端补入的宁少于两项、模型写的去掉后不够两项时保留", () => {
 assert.equal(tb.textbookDifferentialSharesChiefComplaint("带下过多", chief("阴道不规则流血20天")), false);
 assert.equal(tb.textbookDifferentialSharesChiefComplaint("崩漏", chief("阴道不规则流血20天")), true);
 assert.equal(tb.textbookDifferentialSharesChiefComplaint("崩漏", chief("白带明显增多2周")), false);
 const raw = JSON.parse(fs.readFileSync("src/data/tcm-textbook-syndrome-formula-table.json", "utf8"));
 assert.equal(tb.textbookDiseaseTypicalManifestation("崩漏"), raw.diseases.find(row => row.disease === "崩漏").definition);
 // 第四十七轮总指挥订正：模型写的不相干鉴别只在去掉后仍够两项时去掉（甲方要求至少两个鉴别）；服务端补入的仍严格过滤。
 const out = surface.projectDeliveredReasoning(dx("崩漏", "血瘀证", "桃红四物汤", { tcmDiseaseDifferentials: [differential("带下过多"), differential("经间期出血"), differential("胎漏")] }), { recordText: chief("阴道不规则流血20天"), patientSex: "女" });
 assert.ok(!out.overview.tcmDiseaseDifferentials.some(x => /带下|白带/.test(x.diseaseName)), JSON.stringify(out.overview.tcmDiseaseDifferentials.map(x => x.diseaseName)));
 assert.ok(out.overview.tcmDiseaseDifferentials.length >= 2);
 const kept = surface.projectDeliveredReasoning(dx("崩漏", "血瘀证", "桃红四物汤", { tcmDiseaseDifferentials: [differential("带下过多"), differential("月经过多")] }), { recordText: chief("阴道不规则流血20天"), patientSex: "女" });
 assert.equal(kept.overview.tcmDiseaseDifferentials.length, 2, "去掉后不够两项时保留模型写的");
});
await check("1.3 乳癖典型表现逐字取定义，覆盖模型的乳核表现并幂等", () => {
 const out = surface.projectDeliveredReasoning(dx("乳核", "肝郁痰凝证", "", { tcmDiseaseDifferentials: [differential("乳癖")] }), { recordText: chief("乳房肿块3月") });
 const row = out.overview.tcmDiseaseDifferentials.find(x => x.diseaseName === "乳癖");
 assert.equal(row?.typicalManifestation, tb.textbookDiseaseTypicalManifestation("乳癖"));
 assert.match(row?.typicalManifestation || "", /乳腺组织/);
 assert.deepEqual(surface.projectDeliveredReasoning(out, { recordText: chief("乳房肿块3月") }), out);
 // 教材子型没有独立 definition 时留空，不能继续展示模型编的典型表现。
 assert.equal(tb.textbookDiseaseTypicalManifestation("吐血"), "");
 const noDefinition = surface.projectDeliveredReasoning(dx("咳嗽", "风寒袭肺证", "", { tcmDiseaseDifferentials: [differential("吐血")] }));
 assert.equal(noDefinition.overview.tcmDiseaseDifferentials.find(row => row.diseaseName === "吐血")?.typicalManifestation, "");
});
await check("1.4 教材候选鉴别也按相同主诉判据过滤，病名定义不能由模型自写", () => {
 assert.ok(tb.textbookDifferentialsForDisease("噎膈", 50, chief("吞咽困难1月")).every(x => tb.textbookDifferentialSharesChiefComplaint(x.name, chief("吞咽困难1月"))));
 assert.ok(!tb.buildTextbookCandidateContext({ chiefComplaint: "阴道不规则流血20天", diseaseName: "崩漏", sex: "女" }).includes("教材鉴别病名：带下"));
 const source = fs.readFileSync("src/lib/tcm-disease-differential-authoring.server.ts", "utf8");
 // 第四十七轮总指挥订正：教材为本病列出的鉴别（textbookListed）不够两项时可补足；模型另提的名字仍须与主诉主症有交集。
 assert.match(source, /resolved && \(textbookListed\.has\(resolved\) \|\| textbookDifferentialSharesChiefComplaint\(resolved, input\.recordText\)\)/);
 assert.match(source, /parseAuthoredTcmDiseaseDifferentials\(content, acceptName, need, input.recordText\)/);
 const authored = name => JSON.stringify({ differentials: [{ ...differential(name), reason: "主症相近", distinguishingPoints: "本例表现尚需进一步核实" }] });
 assert.deepEqual(authoring.parseAuthoredTcmDiseaseDifferentials(authored("郁证"), ["郁证"], 2, chief("咽痛半年")), []);
 assert.equal(authoring.parseAuthoredTcmDiseaseDifferentials(authored("乳癖"), ["乳癖"], 2, chief("乳房肿块3月"))[0]?.typicalManifestation, tb.textbookDiseaseTypicalManifestation("乳癖"));
});
await check("2.1 指南标题核最终病名核心，摘要/主诉相近不够", () => {
 assert.equal(guidelines.westernGuidelineTitleMatches("急性风湿热待查", "发热伴血小板减少综合征共识"), false);
 assert.equal(guidelines.westernGuidelineTitleMatches("急性胆囊炎", "化疗所致恶心呕吐指南"), false);
 assert.equal(guidelines.westernGuidelineTitleMatches("急性胆囊炎", "化疗所致恶心呕吐指南（胆囊炎研究组，2024）"), false);
 assert.equal(guidelines.westernGuidelineTitleMatches("急性胆囊炎待查", "胆囊炎诊疗指南"), true);
 assert.equal(guidelines.westernGuidelineTitleMatches("急性胆囊炎", "化疗指南 URL:https://example.com/胆囊炎"), false);
});
await check("2.2 不对题只回填经核题的表来源，表来源也不对题时输出空数组", () => {
 const wrong = [{ evidenceId: "EVID-GUIDE-001", citation: "化疗所致恶心呕吐指南", url: "https://example.com/wrong" }];
 const good = guidelines.finalWesternGuidelineReferences("急性胆囊炎", wrong);
 const table = JSON.parse(fs.readFileSync("src/data/western-diagnostic-criteria.source.json", "utf8")).entries;
 const row = table.find(x => x.name === "急性胆囊炎") || table.find(x => x.name === "胆囊炎");
 // F3：已实跑旧断言失败；表条目存在不能绕过标题核题（英文来源尚无受治理同义名时同样宁缺）。
 if (guidelines.westernGuidelineTitleMatches("急性胆囊炎", row.title)) {
  assert.equal(good[0]?.url, row.url);
  assert.equal(guidelines.finalWesternGuidelineReferences("急性胆囊炎待查", wrong)[0]?.url, row.url);
  assert.ok(good[0]?.citation.includes(row.title));
 } else {
  assert.deepEqual(good, []);
  assert.deepEqual(guidelines.finalWesternGuidelineReferences("急性胆囊炎待查", wrong), []);
 }
 assert.deepEqual(guidelines.finalWesternGuidelineReferences("未收录的合成诊断", wrong), []);
});
await check("2.3 服务端检索引用不被排序第一条劫持，改名定稿后重新判题", () => {
 const data = dx("胁痛", "肝郁气滞证");
 data.westernDiagnosis = { primary: { name: "急性胆囊炎", guidelineReferences: [{ evidenceId: "EVID-GUIDE-001" }] } };
 // 错题的机构名靠前，按旧排序会赢；末端回退不能冒充检索阶段已选中正确题名。
 // F3：末端统一核URL白名单，合成检索夹具也须使用白名单主机。
 const transform = evidence.buildEvidenceOutputTransform("- [EVID-GUIDE-001] 化疗指南（胆囊炎研究组，2024） URL:https://www.cma.org.cn/a\n- [EVID-GUIDE-002] 临床常见急腹症专家协作组关于胆囊炎诊疗指南（某学会，2024） URL:https://www.cma.org.cn/b");
 const result = unwrap(transform(wrap(data)));
 assert.equal(result.westernDiagnosis.primary.guidelineReferences[0]?.evidenceId, "EVID-GUIDE-002");
 result.westernDiagnosis.primary.name = "未收录的合成诊断";
 assert.deepEqual(unwrap(guidelines.finalizeWesternGuidelineContent(wrap(result))).westernDiagnosis.primary.guidelineReferences, []);
 const api = fs.readFileSync("src/lib/diagnosis-api.ts", "utf8");
 assert.match(api, /return finalizeWesternGuidelineContent\(applyM03KeySyndromeDiscriminatorsToContent/);
});
await check("3.1 桃红四物汤通用目录与原方同署医宗金鉴，生地版保留独立书名身份", () => {
 const ref = provenance.formulaCompilationReferences(["桃红四物汤"])[0];
 assert.equal(original.canonicalFormulaBook(ref.source), "医宗金鉴");
 assert.ok(ref.ingredients.includes("熟地黄"));
 assert.equal(original.textbookCitedFormulaBooks("桃红四物汤")[0], "医宗金鉴");
 assert.ok(original.originalFormula("桃红四物汤", "医宗金鉴").herbs.some(x => x.herb === "熟地黄"));
 assert.ok(original.originalFormula("桃红四物汤", "妇科冰鉴").herbs.some(x => x.herb === "地黄"));
 assert.equal(original.originalFormula("桃红四物汤", "医垒元戎"), undefined);
 assert.match(provenance.textbookCitedOriginalSource("桃红四物汤", ["当归", "川芎", "白芍", "桃仁", "红花", "地黄"], "《妇科冰鉴》"), /^《医宗金鉴》/);
});
await check("4.1 病类构词主证/兼证同一判据，普通风寒证名不受影响", () => {
 for (const name of ["外感咳嗽", "内伤咳嗽", "外感发热", "内伤发热证"]) assert.ok(tb.diseaseCategorySyndromeName(name), name);
 assert.equal(tb.diseaseCategorySyndromeName("风寒袭肺证"), undefined);
 const out = provenance.withDeterministicFormulaReferences(dx("咳嗽", "外感咳嗽", "", { secondarySyndromes: ["内伤咳嗽", "心神不宁证"] }), chief("咳嗽2天"));
 assert.equal(out.overview.primarySyndrome, "肺失宣降证");
 assert.deepEqual(out.overview.secondarySyndromes, ["心神不宁证"]);
});
await check("4.2 病类能据相应教材行定证时采用行名，不凭病类猜寒热", () => {
 assert.equal(tb.settledTextbookSyndromeName("咳嗽", "外感咳嗽", "咳嗽，咳痰稀薄色白，恶寒发热，头痛", "三拗汤合止嗽散"), "风寒袭肺证");
 assert.equal(tb.settledTextbookSyndromeName("发热", "内伤发热", "仅发热", ""), "气机不和证");
 assert.equal(tb.settledTextbookSyndromeName("咳嗽", "外感咳嗽", "否认咳痰稀薄色白，无恶寒发热，无头痛", "三拗汤合止嗽散"), "肺失宣降证");
});
const ectopic = tb.textbookRowForSyndrome("异位妊娠", "气血亏脱证");
await check("5.1 术后方的受治理条件含逐字引文和行号，其他术后适用情景扫描有记录", () => {
 assert.equal(ectopic.precondition.kind, "post_surgery");
 assert.equal(ectopic.precondition.line, 178240);
 assert.match(ectopic.precondition.quote, /首应及时手术止血治疗。术后/);
 const source = JSON.parse(fs.readFileSync("src/data/tcm-textbook-row-preconditions.source.json", "utf8"));
 assert.equal(source.scan.optionalPostoperativeContexts.length, 8);
 assert.deepEqual(ectopic.precondition, source.entries[ectopic.id]);
 assert.equal(ectopic.precondition.fallback.line, 122273);
 assert.equal(source.scan.requiredPreconditionRows, 3);
 const generated = JSON.parse(fs.readFileSync("src/data/tcm-textbook-syndrome-formula-table.json", "utf8"));
 for (const [id, condition] of Object.entries(source.entries)) assert.deepEqual(generated.rows.find(row => row.id === id)?.precondition, condition, id);
 for (const disease of ["乳腺癌", "乳岩"]) {
  const row = tb.textbookRowForSyndrome(disease, "脾虚胃弱证");
  assert.equal(row.precondition?.kind, "post_treatment");
  assert.ok(tb.textbookPendingPrecondition(row, "拟行化疗，食欲不振"));
  assert.equal(tb.textbookPendingPrecondition(row, "本次化疗后食欲不振"), undefined);
  assert.deepEqual(tb.textbookTreatmentRow(row, "尚未接受放化疗").formulas, []);
  assert.ok(!tb.buildTextbookFormulaContext(disease, "脾虚胃弱证", { recordText: "尚未接受放化疗" }).includes("代表方（教材原文）"));
 }
});
await check("5.2 否认、拟行、既往或他人手术均不满足本次前置条件，已完成本次手术才满足", () => {
 for (const text of ["尚未行手术止血", "拟行手术止血", "既往接受过宫外孕手术", "同事已行输卵管切除术", "建议手术止血", "无手术止血记录", "本次已行阑尾切除手术"]) assert.ok(tb.textbookPendingPrecondition(ectopic, text), text);
 assert.equal(tb.textbookPendingPrecondition(ectopic, "本次已行输卵管切除术，术后第2天"), undefined);
 assert.equal(tb.textbookPendingPrecondition(ectopic, "本次已手术"), undefined);
});
await check("5.3 M03 术前手术优先并用参附合生脉方向，术后仍可用原教材方", () => {
 const input = dx("异位妊娠", "气血亏脱证", "四物汤加黄芪");
 const pre = provenance.withDeterministicFormulaReferences(input, chief("停经后突发下腹剧痛，血压下降，尚未手术"));
 assert.match(pre.overview.recommendedFormulaDirection, /手术止血/);
 assert.match(pre.overview.recommendedFormulaDirection, /参附汤合生脉散/);
 assert.ok(!pre.overview.recommendedFormulaDirection.includes("四物汤"));
 assert.deepEqual(pre.overview.recommendedFormulaNames, ["参附汤", "生脉散"]);
 assert.equal(provenance.withDeterministicFormulaReferences(pre, chief("停经后突发下腹剧痛，血压下降，尚未手术")).overview.recommendedFormulaDirection, pre.overview.recommendedFormulaDirection);
 const clinicalContext = "患者年龄：29岁\n患者性别：女\n已妊娠6周，异位妊娠破裂，阴道流血，血压80/50mmHg，尚未手术。";
 const guarded = provenance.withDeterministicFormulaReferences(input, clinicalContext, undefined, { activeBleeding: true, barredHerb: herb => contract.herbBarredForCase(herb, clinicalContext) });
 assert.match(guarded.overview.recommendedFormulaDirection, /独参汤/);
 assert.ok(!guarded.overview.recommendedFormulaDirection.includes("四物汤"));
 assert.deepEqual(guarded.overview.recommendedFormulaNames, ["独参汤"]);
 const noSafe = provenance.withDeterministicFormulaReferences(input, clinicalContext, undefined, { activeBleeding: true, barredHerb: () => true });
 assert.deepEqual(noSafe.overview.recommendedFormulaNames, []);
 assert.ok(!noSafe.overview.recommendedFormulaDirection.includes("四物汤"));
 const post = provenance.withDeterministicFormulaReferences(input, "本次已行输卵管切除术，术后第2天");
 assert.match(post.overview.recommendedFormulaDirection, /四物汤/);
});
await check("5.4 M04 教材块不注入术后方组成，逐字提供急救方和手术优先方义要求", () => {
 const block = tb.buildTextbookFormulaContext("异位妊娠", "气血亏脱证", { recordText: "尚未手术" });
 assert.match(block, /第122273行.*参附汤/u);
 assert.match(block, /方义必须写明手术止血、纠正休克优先/);
 assert.ok(!block.includes("四物汤"));
 const alternative = tb.buildTextbookFormulaContext("异位妊娠", "气血亏脱证", { recordText: "尚未手术", formulaNames: ["独参汤"] });
 assert.match(alternative, /第123654行.*独参汤/);
 assert.ok(!alternative.includes("candidate.name 可用“参附汤"));
 assert.ok(!tb.buildTextbookFormulaContext("异位妊娠", "气血亏脱证", { recordText: "尚未手术", formulaNames: [] }).includes("candidate.name 可用"), "已签名为空的安全方向不重新注入受限急救方");
 assert.match(tb.buildTextbookFormulaContext("异位妊娠", "气血亏脱证", { recordText: "本次已行输卵管切除术" }), /四物汤/);
});
console.log(JSON.stringify({ suite: "r1064-dx", checks: 14, failures }));
