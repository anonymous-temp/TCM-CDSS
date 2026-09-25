/**
 * 否定判据的**呈现层与安全门对齐**（2026-09-08「否定提示错误」用真函数复现的四类缺陷）。
 *
 * 仓库里「是不是否定」这一判据分散在五处（clinical-polarity / diagnosis-safety 的 isNegatedAt 与
 * hasTerm / sourceDocumentsNegation / stage-contract / clinical-facts），各写各的。本轮收敛的是：
 *  A. clinicalClausePolarity：总括量词否定（均无/皆无/都没有）与后缀否定（阴性/（-）/并未出现/
 *     一次也没有）此前判 affirmed —— M02 回填的「都没有」曾被当阳性过敏史，黄金基线原文
 *     「胸痛胸闷均无」里的胸痛被读成阳性；词表复用 clinical-vocabulary 的受治理总括形态，不另抄一份。
 *  B. 混合极性整句（「否认腹痛，呕血1次」）此前被 classifyWesternDiagnosticEvidence 与
 *     documentedExclusionFacts 整条归入「排除依据」——安全门同一句抬出消化道出血优先评估，
 *     西医依据表却展示成「已排除」。现由 isWhollyNegatedClinicalFact 一处判定。
 *  C. 安全门提示档：hasGiBleedPrioritySignal / hasAbdominalPrioritySignal 只用前置否定，
 *     「呕血阴性」「呕血（-）」「呕血并未出现」被当阳性抬出优先评估；hasTerm 的后缀否定判据
 *     抽成 isPostfixNegatedAt 三处共用。
 *  D. isNegatedAt 的情态守卫只装在「排除」上：「无法完全否认呕血」把呕血红旗抹掉；现与
 *     clinical-polarity 的 NON_NEGATING_WU_MODAL 同口径。
 * 每条都配反向护栏：真正的否定仍否定，真正的阳性仍阳性。
 */
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { clinicalClausePolarity, affirmedClinicalSourceClauses, isWhollyNegatedClinicalFact } = await jiti.import("../src/lib/clinical-polarity.ts");
const { classifyWesternDiagnosticEvidence } = await jiti.import("../src/lib/clinical-fact-source.ts");
const { withSafetyGate, hasGiBleedPrioritySignal } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");

// A. 子句极性
for (const clause of ["胸痛胸闷均无", "均无胸痛", "皆无", "都没有", "两个都没有", "呕血（-）", "呕血(-)", "呕血阴性", "呕血并未出现", "晕厥一次也未发生", "意识丧失并未发生", "肢体无力也未见", "呕血一次也没有"]) {
  assert.equal(clinicalClausePolarity(clause), "negative", `应判否定：${clause}`);
}
for (const clause of ["咳嗽并未缓解", "无痛性黄疸", "无症状性菌尿", "没精神", "胸痛3天伴大汗", "头痛明显", "呕血1次"]) {
  assert.equal(clinicalClausePolarity(clause), "affirmed", `应判阳性：${clause}`);
}
assert.equal(clinicalClausePolarity("无法完全否认呕血"), "uncertain");
assert.equal(clinicalClausePolarity("都不清楚"), "uncertain", "总括不知形态 → uncertain");

// B. 混合极性整句
assert.deepEqual(affirmedClinicalSourceClauses("否认腹痛，呕血1次"), ["呕血1次"], "数量断言是独立的阳性子句");
assert.deepEqual(affirmedClinicalSourceClauses("否认高血压病史，血压偏高"), ["血压偏高"], "偏高/偏低是独立断言");
assert.deepEqual(affirmedClinicalSourceClauses("否认胸痛、大汗、放射痛"), [], "顿号列举继承否定");
for (const [fact, wholly] of [
  ["否认腹痛，呕血1次", false],
  ["无腹痛，胸痛3天伴大汗", false],
  ["未见皮疹，胸痛剧烈2小时", false],
  ["否认胸痛、大汗、放射痛", true],
  ["否认呕血黑便", true],
  ["肢体无力3天", false],
  ["咳嗽3天", false],
]) {
  assert.equal(isWhollyNegatedClinicalFact(fact), wholly, `整条否定判定：${fact}`);
}
const mixed = classifyWesternDiagnosticEvidence({ supportingFacts: ["否认腹痛，呕血1次"] }, []);
assert.deepEqual(mixed.excluding, [], "混合极性句不得进入排除依据");
assert.deepEqual(mixed.supporting, ["否认腹痛，呕血1次"], "混合极性句作为支持依据整句保留（逐字引文）");
const pure = classifyWesternDiagnosticEvidence({ supportingFacts: ["否认胸痛、大汗、放射痛"] }, []);
assert.deepEqual(pure.excluding, ["否认胸痛、大汗、放射痛"], "整条否定仍是排除依据");

// C/D. 安全门提示档与红旗档
const gate = (rawText) => withSafetyGate(normalizeCaseStateInput({
  caseId: "negation-parity",
  hisRecord: {
    schemaVersion: "tcm-cdss-his-v1", source: "tcm-cdss-his", caseId: "negation-parity", updatedAt: "2026-06-29T08:00:00.000Z", tongueImageUploaded: false,
    fields: { zhushu: "入睡困难2月", sex: "男", age: "45岁", guomin: "否认药物过敏", yongyaoshi: "否认当前用药", vitalsT: "36.5℃", vitalsP: "76次/分", vitalsR: "18次/分", vitalsBP: "122/76mmHg", tcmTongue: "舌淡红，苔薄白", tcmPulse: "弦细", tcmDetail: "睡眠问诊：否认明显打鼾、目击呼吸暂停及日间嗜睡，无高血压病史。", xianbingshi: "入睡困难，多梦易醒，纳可。", jiwangshi: "否认严重心脑血管疾病。" },
    rawText,
  },
  rawText,
  patient: { age: 45, sex: "male" },
})).safetyGate;
const giPriority = (rawText) => /消化道出血/.test((gate(rawText).reasons || []).join("\n"));
for (const negated of ["呕血阴性", "呕血（-）", "呕血(-)，黑便(-)", "呕血并未出现", "否认腹痛，呕血并未出现", "呕血一次也没有", "黑便、呕血、便血均无", "否认呕血黑便。"]) {
  assert.equal(hasGiBleedPrioritySignal(negated), false, `后缀/总括否定不得抬出消化道出血信号：${negated}`);
  assert.equal(giPriority(negated), false, `安全门不得为否定表述抬优先评估：${negated}`);
}
for (const positive of ["呕血1次", "否认腹痛，呕血1次", "无法完全否认呕血", "不能除外呕血", "尚未排除黑便", "呕血并未缓解"]) {
  assert.equal(hasGiBleedPrioritySignal(positive), true, `阳性/不确定表述必须保留消化道出血信号（fail-closed）：${positive}`);
  assert.equal(giPriority(positive), true, `安全门必须为阳性/不确定表述抬优先评估：${positive}`);
}
assert.equal(gate("突发胸痛伴大汗").status, "red_flag", "红旗档对照不受影响");
assert.equal(gate("胸痛胸闷均无，否认大汗放射痛。").status, "ready", "总括否定的黄金基线原文仍 ready");

console.log(JSON.stringify({ suite: "negation-presentation-parity", failures: 0 }));
