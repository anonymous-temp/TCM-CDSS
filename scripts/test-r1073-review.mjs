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
  assert.deepEqual(notReviewed.rejected, ["辨证依据:not_reviewed"]);
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
