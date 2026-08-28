/**
 * 经典方组成身份只有一个判据：服务端的确定性核验数字。
 *
 * 2026-08-27 拉 30h 生产日志实测：29 次出方里 6 次被独立复核判 formula_composition_mismatch，
 * 其中 5 次直接走确定性剥名且 completedRepairAttempts: 0 —— 医生要的「麻黄汤」变成
 * 「本例辨证组方加减」。这正是甲方 08cc573 复测第 1 项（同病例结果不稳定 / 经典方漂移）。
 *
 * 判层归因：候选在被复核之前**已经通过**确定性的组成身份核验（validatedStructuredReasoning →
 * formulaCompilationContractIssue → 保留数≥下限 且 锚点齐全），结果逐方写在 candidate.baseFormulas。
 * 但该字段只到达医生页面与 HIS 方案，唯独不进复核载荷 —— 复核器于是只能凭记忆复原原方组成，
 * 用一套无法复现的标准去推翻确定性层刚判过的同一件事。本仓头号缺陷形状，且方向反了：
 * 模型意见覆盖了确定性结论。
 *
 * 修法是把服务端的数字给复核器，并把两个意见码按判层重新划界：
 *   · formula_composition_mismatch —— 结构性判据，只看保留数/下限/锚点三组数字（缺 baseFormulas 时 fail-closed）；
 *   · herb_plan_mismatch —— 开放语言的临床保留意见，走修复轮且**保留方名**。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildM04ClinicalReviewPayload,
  buildM04ClinicalReviewPrompt,
  constrainM04ClinicalReviewScope,
  serverFormulaIdentityStatus,
} from "../src/lib/m04-clinical-review.ts";

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; console.log(`  ✓ ${label}`); };

const baseFormulas = [{
  name: "麻黄汤",
  source: "《伤寒论》",
  matchedIngredientCount: 4,
  totalIngredientCount: 4,
  minimumPreservedIngredientCount: 4,
  matchedRequiredIngredientCount: 2,
  requiredIngredientCount: 2,
  verificationStatus: "verified_individually",
}];
const candidateReasoning = (extra = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  formula: {
    candidates: [{
      name: "麻黄汤加减",
      formulaNames: ["麻黄汤"],
      constructionType: "single_base",
      modificationStatus: "modified",
      herbs: [
        { name: "麻黄", dose: "9g", role: "君" },
        { name: "桂枝", dose: "6g", role: "臣" },
        { name: "苦杏仁", dose: "9g", role: "佐" },
        { name: "甘草", dose: "3g", role: "使" },
      ],
      ...extra,
    }],
  },
});
const prior = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { primarySyndrome: "风寒束表证", recommendedFormulaNames: ["麻黄汤"], formulaSelectionMode: "single" } };

// ── 1. 载荷：服务端核验结果必须逐字到达复核器
check("复核载荷带上 baseFormulas 的保留数/下限/锚点三组数字", () => {
  const payload = buildM04ClinicalReviewPayload(prior, candidateReasoning({ baseFormulas }));
  const candidate = payload.candidate.formula.candidates[0];
  assert.deepEqual(candidate.baseFormulas, baseFormulas, "baseFormulas 未进入复核载荷");
  const wire = JSON.stringify(payload.candidate);
  for (const field of ["matchedIngredientCount", "minimumPreservedIngredientCount", "matchedRequiredIngredientCount", "requiredIngredientCount"]) {
    assert.ok(wire.includes(field), `复核载荷缺少字段 ${field}`);
  }
  assert.equal(candidate.formulaIdentityStatus, "verified");
});
check("modificationStatus 一并到达（加减与原方是两种形态）", () => {
  const payload = buildM04ClinicalReviewPayload(prior, candidateReasoning({ baseFormulas }));
  assert.equal(payload.candidate.formula.candidates[0].modificationStatus, "modified");
});
check("候选没有 baseFormulas 时不编造该字段", () => {
  const payload = buildM04ClinicalReviewPayload(prior, candidateReasoning());
  assert.equal(payload.candidate.formula.candidates[0].baseFormulas, undefined,
    "缺失的服务端核验结果被填成了非 undefined 值，复核器会据此误判身份已核验");
});

// ── 2. 服务端身份状态：复核器不再拥有第二套组成裁决权
const prompt = buildM04ClinicalReviewPrompt("患者男，35岁，恶寒发热无汗。", prior, candidateReasoning({ baseFormulas }), "");

check("提示词把组成身份从 LLM 职责移到服务端状态", () => {
  assert.ok(prompt.includes("formulaIdentityStatus=verified"), "提示词未声明服务端终局状态");
  assert.ok(/不得凭记忆复原原方/.test(prompt), "提示词未禁止凭记忆复原原方组成");
  assert.ok(prompt.includes("不得返回 formula_composition_mismatch"), "提示词仍允许模型推翻服务端身份");
});
check("组成意见不再暴露为模型输出坐标", () => {
  assert.ok(prompt.includes("加减太多/不像原方"), "提示词未覆盖既有误判形态");
  assert.ok(prompt.includes("herb_plan_mismatch"), "提示词未给出临床保留意见的替代出口");
  assert.equal(prompt.includes("formula_composition_mismatch 只能配 formula_core_composition"), false,
    "输出说明仍把服务端身份交给模型裁决");
});
check("已核验身份不能被旧模型组成意见推翻", () => {
  const legacyReview = { status: "repair", issueCode: "formula_composition_mismatch", repairFocus: "formula_core_composition" };
  assert.deepEqual(
    constrainM04ClinicalReviewScope(legacyReview, prior, candidateReasoning({ baseFormulas })),
    { status: "accepted", issueCode: "none" },
  );
});
check("缺失服务端身份核验时保持 fail-closed", () => {
  const legacyReview = { status: "repair", issueCode: "formula_composition_mismatch", repairFocus: "formula_core_composition" };
  assert.equal(serverFormulaIdentityStatus(candidateReasoning().formula.candidates[0]), "unverified");
  assert.deepEqual(constrainM04ClinicalReviewScope(legacyReview, prior, candidateReasoning()), legacyReview);
});
check("显式自拟方没有经典身份坐标", () => {
  const selfDevised = candidateReasoning({
    name: "本例辨证组方",
    formulaNames: [],
    constructionType: "self_devised",
    baseFormulas: [],
  });
  assert.equal(serverFormulaIdentityStatus(selfDevised.formula.candidates[0]), "not_claimed");
});

// ── 3. 接线：载荷里的判据字段只有一个来源
const source = readFileSync(new URL("../src/lib/m04-clinical-review.ts", import.meta.url), "utf8");
check("载荷直接转发 candidate.baseFormulas，不在复核侧另算一套", () => {
  assert.ok(source.includes("baseFormulas: candidate.baseFormulas,"), "载荷未直接转发服务端核验结果");
  assert.ok(!/minimumPreservedIngredientCount\s*[:=]\s*(?!.*candidate\.)/m.test(
    source.split("buildM04ClinicalReviewPayload")[1]?.slice(0, 3000) || ""),
    "复核侧自行计算了组成下限，与确定性层会分叉");
});

console.log(`\n经典方组成身份判据单一化：${checks} 项断言全部通过`);
