// 第五十五轮：定稿前一致性通读（final-consistency-review.server.ts）的范围与服务端核对。模型调用不发生：只测改动怎样写回、哪些改动被拒。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { "@": `${root}/src`, "server-only": `${root}/node_modules/next/dist/compiled/server-only/empty.js` } });
const review = await jiti.import("../src/lib/final-consistency-review.server.ts");

const check = async (id, title, run) => {
  if (process.env.R1073R_CHECK && process.env.R1073R_CHECK !== id) return;
  try { await run(); console.log(`✓ ${id} ${title}`); } catch (error) { process.exitCode = 1; console.error(`✗ ${id} ${title}\n${error.stack}`); }
};
const diagnose = () => ({
  stage: "diagnose",
  overview: { tcmDiseaseName: "胃痛", primarySyndrome: "肝气犯胃证", secondarySyndromes: [], tcmDiseaseRationale: "胃脘胀痛半月", tcmDiagnosticRationale: "情志不舒诱发",
    tcmDiseaseDifferentials: [{ diseaseName: "胃痞", reason: "均有胃脘不适", distinguishingPoints: "本例以痛为主" }, { diseaseName: "胁痛", reason: "均与肝郁相关", distinguishingPoints: "本例痛在胃脘" }] },
  pathogenesis: {
    locationDifferentiation: { items: ["肝", "胃"], details: [{ location: "肝", basis: "情志诱发" }, { location: "胃", basis: "胃脘胀痛" }] },
    natureDifferentiation: { items: ["气滞"], rootDeficiency: [], branchExcess: ["气滞"], basis: "胀痛，嗳气后舒" },
    overallPathogenesis: "肝气郁结，横逆犯胃",
    chain: [{ patientFact: "胃脘胀痛", pathogenesis: "肝气犯胃", therapyDirection: "疏肝和胃", syndromeEvidence: "胀痛连胁" }],
    uncertainties: [{ item: "舌象", reason: "未记录" }],
  },
  therapy: { overallMethod: "疏肝理气，和胃止痛" },
  westernDiagnosis: { primary: { name: "功能性消化不良", clinicalRationale: "病程半月，尚缺胃镜，诊断尚不确立", supportingFacts: [] } },
});
const prescribe = () => ({
  stage: "prescribe",
  formula: {
    candidates: [{ name: "柴胡疏肝散", formulaAnalysis: "柴胡疏肝解郁为君；白芍、甘草缓急止痛；陈皮、枳壳理气和胃。",
      herbs: [{ name: "柴胡", dose: "9g", role: "君", function: "疏肝" }, { name: "白芍", dose: "12g", role: "臣", function: "柔肝" }, { name: "陈皮", dose: "6g", role: "佐", function: "理气" },
        { name: "枳壳", dose: "9g", role: "佐", function: "行气" }, { name: "甘草", dose: "6g", role: "使", function: "调和" }] }],
    patentAndWestern: [{ name: "柴胡舒肝丸", correspondingProblem: "肝郁胃痛" }, { name: "三九胃泰颗粒", correspondingProblem: "胃痛" }],
  },
});
const apply = (stage, reasoning, patch) => review.applyFinalReviewPatch(stage, reasoning, patch, new Set(Object.keys(patch)));

await check("R1", "缺省关闭；只有 CDSS_FINAL_CONSISTENCY_REVIEW=on 才开", () => {
  const saved = process.env.CDSS_FINAL_CONSISTENCY_REVIEW;
  delete process.env.CDSS_FINAL_CONSISTENCY_REVIEW; assert.equal(review.finalConsistencyReviewMode(), "off");
  process.env.CDSS_FINAL_CONSISTENCY_REVIEW = "1"; assert.equal(review.finalConsistencyReviewMode(), "off");
  process.env.CDSS_FINAL_CONSISTENCY_REVIEW = "on"; assert.equal(review.finalConsistencyReviewMode(), "on");
  if (saved === undefined) delete process.env.CDSS_FINAL_CONSISTENCY_REVIEW; else process.env.CDSS_FINAL_CONSISTENCY_REVIEW = saved;
});
await check("R2", "辨证阶段范围：病名、主证、兼证不许改；review 里没点到的字段不写；分析类字段照写", () => {
  const r = diagnose();
  const { applied, rejected } = review.applyFinalReviewPatch("diagnose", r, { 主证: "肝胃不和证", 总体病机: "肝郁气滞，横逆犯胃，胃失和降" }, new Set(["主证", "总体病机"]));
  assert.deepEqual(applied, ["总体病机"]); assert.deepEqual(rejected, ["主证:out_of_scope"]);
  assert.equal(r.overview.primarySyndrome, "肝气犯胃证");
  assert.equal(r.pathogenesis.overallPathogenesis, "肝郁气滞，横逆犯胃，胃失和降");
  const notReviewed = review.applyFinalReviewPatch("diagnose", diagnose(), { 辨证依据: "改写" }, new Set());
  assert.deepEqual(notReviewed.rejected, ["辨证依据:out_of_scope"]);
});
await check("R3", "西医病名只许加或去「待查」，换成别的病不写", () => {
  const r = diagnose();
  assert.deepEqual(apply("diagnose", r, { 西医诊断: "功能性消化不良待查" }).applied, ["西医诊断"]);
  assert.equal(r.westernDiagnosis.primary.name, "功能性消化不良待查");
  const other = diagnose();
  assert.deepEqual(apply("diagnose", other, { 西医诊断: "慢性胃炎" }).rejected, ["西医诊断:renamed"]);
  assert.equal(other.westernDiagnosis.primary.name, "功能性消化不良");
});
await check("R4", "治法每项四字、不重复；待核实只许删改不许加；病机链条数不变；中医鉴别不少于原有（至多 2）", () => {
  const r = diagnose();
  assert.deepEqual(apply("diagnose", r, { 治法: "疏肝理气，和胃止痛，缓急" }).rejected, ["治法:not_four_char_items"]);
  assert.deepEqual(apply("diagnose", r, { 治法: "疏肝理气，疏肝理气" }).rejected, ["治法:not_four_char_items"]);
  assert.deepEqual(apply("diagnose", r, { 治法: "疏肝理气、和胃止痛、降逆止呕" }).applied, ["治法"]);
  assert.equal(r.therapy.overallMethod, "疏肝理气，和胃止痛，降逆止呕");
  assert.deepEqual(apply("diagnose", r, { 待核实: [{ 项目: "舌象", 原因: "未记录" }, { 项目: "脉象", 原因: "未记录" }] }).rejected, ["待核实:added_items"]);
  assert.deepEqual(apply("diagnose", r, { 待核实: [] }).applied, ["待核实"]);
  assert.deepEqual(apply("diagnose", r, { 病机链: [] }).rejected, ["病机链:chain_length"]);
  assert.deepEqual(apply("diagnose", r, { 中医鉴别: [{ 病名: "胃痞", 相似: "均有胃脘不适", 要点: "本例以痛为主" }] }).rejected, ["中医鉴别:too_few"]);
});
await check("R5", "开方阶段：方义漏讲原来讲到的药不写；中成药只删不加；药味只许改功效与同一味药的炮制写法，增删药、改剂量、改角色不写", () => {
  const r = prescribe();
  assert.deepEqual(apply("prescribe", r, { 方义: "柴胡疏肝解郁为君；白芍缓急止痛。" }).rejected, ["方义:herb_mention_dropped"]);
  assert.deepEqual(apply("prescribe", r, { 中成药: [{ 药名: "柴胡舒肝丸" }, { 药名: "逍遥丸" }] }).rejected, ["中成药:added_medicine"]);
  assert.deepEqual(apply("prescribe", r, { 中成药: [{ 药名: "柴胡舒肝丸" }] }).applied, ["中成药"]);
  assert.deepEqual(r.formula.patentAndWestern.map((row) => row.name), ["柴胡舒肝丸"]);
  const herbs = (overrides) => r.formula.candidates[0].herbs.map((h, i) => ({ 药名: h.name, 剂量: h.dose, 角色: h.role, 功效: h.function, ...(overrides[i] || {}) }));
  assert.deepEqual(apply("prescribe", r, { 药味: herbs({ 1: { 剂量: "30g" } }) }).rejected, ["药味:composition_changed"]);
  assert.deepEqual(apply("prescribe", r, { 药味: herbs({ 2: { 药名: "香附" } }) }).rejected, ["药味:composition_changed"]);
  assert.deepEqual(apply("prescribe", r, { 药味: herbs({ 0: { 角色: "臣" } }) }).rejected, ["药味:composition_changed"]);
  assert.deepEqual(apply("prescribe", r, { 药味: herbs({ 3: { 药名: "麸炒枳壳", 功效: "理气宽中" } }) }).applied, ["药味"]);
  assert.equal(r.formula.candidates[0].herbs[3].name, "麸炒枳壳");
  assert.equal(r.formula.candidates[0].herbs[3].dose, "9g");
  assert.deepEqual(apply("prescribe", r, { 加减: [] }).rejected, ["加减:out_of_scope"]);
});
await check("R6", "接线：定稿通读在交付面投影之前（投影、合同与签名照常作用于改写结果），改写后过不了合同整份放弃", () => {
  const source = fs.readFileSync(`${root}/src/lib/diagnosis-api.ts`, "utf8");
  const reviewAt = source.indexOf("emissionContent = await reviewEmissionConsistency(emissionContent);");
  const projectAt = source.indexOf("const surfaced = projectEmissionSurface(emissionContent);");
  assert.ok(reviewAt > 0 && projectAt > reviewAt && projectAt - reviewAt < 200);
  assert.match(source, /final_consistency_review_rejected/u);
  assert.match(source, /m04SafetyContractIssue\(reasoning, opts\.structuredPriorReasoning/u);
});

await check("R7", "正文分项均为四字，来源必须匹配本病本证；无可核实表述时正文照原文", async () => {
  const { treatmentMethodDisplay } = await jiti.import("../src/lib/treatment-method-display.ts");
  const result = treatmentMethodDisplay("健脾温阳利水", "水肿", "脾阳虚衰证");
  assert.equal(result.text, "健脾温阳，温阳利水");
  assert.equal(result.reference, "《中医内科学》水肿·脾阳虚衰证：健脾温阳利水");
  const alreadyFormatted = treatmentMethodDisplay("清热凉血，祛风止血，润肠通便", "内痔", "风伤肠络证");
  assert.equal(alreadyFormatted.text, "清热凉血，祛风止血，润肠通便");
  assert.match(alreadyFormatted.reference, /《中医外科学》内痔·风伤肠络证：清热凉血祛风/u);
  const related = treatmentMethodDisplay("补血养心，益气安神，健脾和胃", "心悸", "心脾两虚证");
  assert.match(related.reference, /同病相关证型教材原文：《中医内科学》心悸·心血不足证：补血养心，益气安神/u);
  assert.match(related.reference, /本例辨证另取健脾和胃/u);
  const subtype = treatmentMethodDisplay("清热利湿，通淋止痛", "淋证（热淋）", "膀胱湿热证");
  assert.match(subtype.reference, /本病分型教材原文：《中医内科学》淋证·热淋：清热利湿通淋/u);
  const unresolved = treatmentMethodDisplay("健脾温阳利水", "胃痛", "肝气犯胃证");
  // 无可核实的四字拆法时正文照原文，不出现「待核」类流程用语，也不借用别的病证出处。
  assert.equal(unresolved.text, "健脾温阳利水");
  assert.doesNotMatch(unresolved.reference, /《|待核|待医师/u);
  const unsplittable = treatmentMethodDisplay("健脾利湿止痒", "湿疮", "脾虚湿蕴证");
  assert.equal(unsplittable.text, "健脾利湿止痒");
  assert.match(unsplittable.reference, /《中医外科学》湿疮·脾虚湿蕴证：健脾利湿止痒/u);
  const overflow = treatmentMethodDisplay("清暑祛湿解表，和胃降逆，健脾化湿", "感冒", "暑湿伤表证");
  assert.equal(overflow.text, "清暑祛湿解表，和胃降逆，健脾化湿");
  const signed = "清热利湿止带，理气和胃，清热止痒";
  const overlap = treatmentMethodDisplay(signed, "带下过多", "湿热下注证");
  assert.ok(overlap.text.split("，").every(term => /^\p{Script=Han}{4}$/u.test(term)));
  assert.match(overlap.reference, /清热利湿止带/u);
});
await check("R8", "写回治则须命中受控候选并被复核点名；双病史不能证明新增并发症", async () => {
  const context = { suggestedPrinciple: "扶正祛邪" };
  const r = diagnose();
  assert.deepEqual(review.applyFinalReviewPatch("diagnose", r, { 治则: "扶正祛邪" }, new Set(), context).applied, []);
  assert.deepEqual(review.applyFinalReviewPatch("diagnose", r, { 治则: "虚则补之" }, new Set(["治则"]), context).applied, []);
  assert.deepEqual(review.applyFinalReviewPatch("diagnose", r, { 治则: "扶正祛邪" }, new Set(["治则"]), context).applied, ["治则"]);
  const { settleWesternDiagnosisBasis } = await jiti.import("../src/lib/recorded-test-claims.ts");
  const prior = "既往史：慢性肾小球肾炎病史8年，2年前诊断慢性肾脏病3期";
  assert.equal(settleWesternDiagnosisBasis("慢性肾小球肾炎伴慢性肾脏病3期待查", "本次水肿加重。", prior).name, "慢性肾小球肾炎伴慢性肾脏病3期");
  assert.equal(settleWesternDiagnosisBasis("慢性肾小球肾炎伴慢性肾脏病4期待查", "分期尚待检查。", prior).name, "慢性肾小球肾炎伴慢性肾脏病4期待查");
});
await check("R9", "随访按已签西医诊断补客观监测；待查、儿童、已经写过的指标不重复", async () => {
  const { adultFollowupReferences } = await jiti.import("../src/lib/western-disease-care.ts");
  assert.match(adultFollowupReferences("2型糖尿病伴血糖控制不佳", 60, "核对夜尿次数").join(""), /糖化血红蛋白/u);
  assert.deepEqual(adultFollowupReferences("2型糖尿病待查", 60, ""), []);
  assert.deepEqual(adultFollowupReferences("2型糖尿病", 16, ""), []);
  assert.deepEqual(adultFollowupReferences("2型糖尿病", 60, "请带上近期HbA1c结果。"), []);
});
await check("R10", "处方投影从签名诊断取回诊断、证、病机和治法，处方仍通过自己的投影", async () => {
  const { applyDeliveredSurfaceToContent, projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  const prior = diagnose();
  const proposal = { ...prior, ...prescribe(), therapy: { overallMethod: "活血化瘀" } };
  const wrap = obj => "<!-- DIAGNOSIS_JSON_START -->" + JSON.stringify(obj) + "<!-- DIAGNOSIS_JSON_END -->";
  const projected = applyDeliveredSurfaceToContent(wrap(proposal), { signedDiagnose: prior });
  const actual = JSON.parse(projected.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
  for (const key of ["overview", "westernDiagnosis", "pathogenesis", "therapy"]) assert.deepEqual(actual[key], prior[key]);
  const terminal = projectDeliveredReasoning(actual, { signedDiagnose: prior });
  for (const key of ["overview", "westernDiagnosis", "pathogenesis", "therapy"]) assert.deepEqual(terminal[key], prior[key]);
  assert.ok(terminal.formula.candidates.length);
});
await check("R11", "外治不得把已签的阴阳俱虚缩成阴虚；病位不同的变体方案不用", async () => {
  const { textbookTreatmentPlan } = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
  const mixed = textbookTreatmentPlan({
    projectCode: "acupuncture", diseaseNames: ["绝经前后诸证"], westernNames: [],
    signedSyndromeText: "肾阴阳俱虚证", signedMethod: "阴阳双补，调补肝肾", signedLocations: ["肾"],
    currentFacts: "绝经后忽冷忽热，腰背冷痛，下肢发凉，手足心热，汗出。",
  });
  assert.ok(mixed?.treatmentContent);
  assert.doesNotMatch(mixed.treatmentContent, /本例属肾阴虚[，。]/u);
  const unrelated = textbookTreatmentPlan({
    projectCode: "acupuncture", diseaseNames: ["耳鸣耳聋"], westernNames: [], signedSyndromeText: "气血亏虚证",
    signedPrinciple: "虚则补之", signedMethod: "益气养血", signedLocations: ["耳窍", "脾"],
    currentFacts: "耳鸣伴乏力，劳累后加重，休息缓解。",
  });
  assert.ok(!unrelated?.treatmentContent.includes("补肾养窍"));
});

await check("R12", "合称对上多个脏腑时不按教材顺序选方", async () => {
  const { textbookRowForSyndrome } = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
  assert.equal(textbookRowForSyndrome("虚劳", "气血两虚证")?.syndromeName, undefined);
  assert.equal(textbookRowForSyndrome("虚劳", "肺气虚证")?.syndromeName, "肺气虚证");
});


await check("R13", "第六十三轮：通读不减治法项、不写受治理词表外的新治法；去「待查」须确定性结算同意且非红旗", async () => {
  const dropped = diagnose();
  assert.deepEqual(apply("diagnose", dropped, { 治法: "疏肝理气" }).rejected, ["治法:dropped_items"]);
  assert.equal(dropped.therapy.overallMethod, "疏肝理气，和胃止痛");
  const coined = diagnose();
  assert.deepEqual(apply("diagnose", coined, { 治法: "疏肝理气，胃气舒畅" }).rejected, ["治法:ungoverned_item"]);
  const twice = diagnose(); twice.therapy.overallMethod = "回阳救逆，益气固脱，活血止痛";
  assert.deepEqual(apply("diagnose", twice, { 治法: "固脱救逆，回阳固脱，益气活血" }).rejected, ["治法:repeated_half"]);
  const reworded = diagnose();
  assert.deepEqual(apply("diagnose", reworded, { 治法: "疏肝理气，和胃降逆" }).applied, ["治法"], "受治理四字治法可以改写原项");
  const ctx = (extra) => ({ recordText: "主诉：停经50天，下腹剧痛2小时。尿妊娠试验阳性。", ...extra });
  const pending = () => { const r = diagnose(); r.westernDiagnosis.primary.name = "异位妊娠破裂待查"; r.westernDiagnosis.primary.clinicalRationale = "符合异位妊娠破裂，需急诊超声。"; return r; };
  const red = pending();
  assert.deepEqual(review.applyFinalReviewPatch("diagnose", red, { 西医诊断: "异位妊娠破裂" }, new Set(["西医诊断"]), ctx({ redFlag: true })).rejected, ["西医诊断:not_established"]);
  assert.equal(red.westernDiagnosis.primary.name, "异位妊娠破裂待查");
  const noRecord = pending();
  assert.deepEqual(review.applyFinalReviewPatch("diagnose", noRecord, { 西医诊断: "异位妊娠破裂" }, new Set(["西医诊断"]), { redFlag: false }).rejected, ["西医诊断:not_established"]);
  const pharyngitis = diagnose(); pharyngitis.westernDiagnosis.primary.name = "急性咽炎待查";
  pharyngitis.westernDiagnosis.primary.clinicalRationale = "咽痛灼热，查体咽黏膜鲜红肿胀，符合急性咽炎。";
  assert.deepEqual(review.applyFinalReviewPatch("diagnose", pharyngitis, { 西医诊断: "急性咽炎" }, new Set(["西医诊断"]),
    { recordText: "主诉：咽痛2天。查体：咽黏膜鲜红肿胀。", redFlag: false }).applied, ["西医诊断"], "结算认可、非红旗时可去待查（对照）");
});

await check("R14", "病历写明的诊断伴其控制状态不写待查；伴另一个未确立的并发症照旧待查（D047）", async () => {
  const { settleWesternDiagnosisBasis } = await jiti.import("../src/lib/recorded-test-claims.ts");
  const rec = "主诉：尿频量多、腰膝酸软3月\n现病史：患者6年前体检发现血糖升高，诊断为2型糖尿病。\n既往史：2型糖尿病病史6年，现服盐酸二甲双胍片0.5g每日3次\n辅助检查：空腹血糖8.9mmol/L，糖化血红蛋白7.9%";
  assert.equal(settleWesternDiagnosisBasis("2型糖尿病伴血糖控制不佳待查", "符合血糖控制不佳。", rec).name, "2型糖尿病伴血糖控制不佳");
  assert.equal(settleWesternDiagnosisBasis("2型糖尿病伴糖尿病肾病待查", "尿蛋白阳性。", rec).name, "2型糖尿病伴糖尿病肾病待查");
  assert.equal(settleWesternDiagnosisBasis("2型糖尿病伴血糖控制不佳待查", "符合血糖控制不佳。", "主诉：口干多饮3月\n辅助检查：空腹血糖8.9mmol/L").name, "2型糖尿病伴血糖控制不佳待查", "病历没写明诊断时照旧待查（对照）");
});

await check("R15", "未诉改写不拆「不省人事」；方义里「审阅候选」一类流程用语删那一小句（d024、d098）", async () => {
  const { negativeClaimItems } = await jiti.import("../src/lib/tcm-therapy-phrasing.ts");
  assert.deepEqual(negativeClaimItems("无突然昏仆、不省人事及四肢厥冷")?.items, ["突然昏仆", "不省人事及四肢厥冷"]);
  assert.deepEqual(negativeClaimItems("无恶寒、不发热")?.items, ["恶寒", "发热"], "列举里的「不」仍是否认（对照）");
  const { withoutInternalCompositionTalk } = await jiti.import("../src/lib/delivered-surface.ts");
  assert.equal(withoutInternalCompositionTalk("本方以泻心汤合十灰散加减，为急危出血的审阅候选。以大黄为君。"), "本方以泻心汤合十灰散加减。以大黄为君。");
});
