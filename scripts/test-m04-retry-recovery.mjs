// M04「重新生成候选方药」的跨请求恢复能力（甲方生产实测 2026-08-04 缺陷3）。
//
// 生产实证（BASE_URL=https://82.156.128.153/tcm-cdss，2026-08-04）：
//   风寒病例「气虚外感风寒证」(fixa-d3b-614…)：
//     · 第 1 次 /api/diagnosis/prescribe → 0 味，stageTelemetry 增量
//       {outcomes.contract_rejected:1, reasonCodes.final_contract_rejected:1, retried:1}
//     · 第 2 次（= 医生点「重新生成候选方药」，原样重发同一份 caseState + 同一份已签名 M03）
//       → 同样 0 味、同一个 reasonCode，且**返回正文与第 1 次逐字节相同**（diff 无输出）。
//   同轮另一例「风寒束表-咳嗽」首轮 final_contract_rejected_repair_loop、0 味。
//
// 根因是重试的**性质**：同输入 → 同提示词 → 结构化阶段固定 temperature 0 → 同输出 → 同驳回 →
// 由驳回码确定性派生的同一段修复提示 → 同结局。编排层「同一修复提示重复注入=同一张失败彩票」
// 的信条只在单次请求内生效，跨请求时修复计数/fixpoint/时限全部归零。
//
// 本套件钉住策略层的不变量：
//   A. 首轮保持确定性（temperature 0、不预设修复已耗尽）——不改变今天已验收的首轮行为；
//   B. 重试轮必须换一张彩票（温度 > 0）并承接「修复机会已用尽」，使既有的带批注受理判定可达；
//   C. 出方（含带批注受理）立即清账，一次历史失败不得永久改变后续同病例的采样；
//   D. 账本身份 = 同病例 + 同一份已签名 M03；换病例或换签名即另一次诊疗，不继承失败；
//   E. 与既有 m04-repair-policy 的受理判定联通：repairExhausted 到达方式扩一种，安全前提一条不减。
import assert from "node:assert/strict";

const {
  m04AttemptKey,
  m04RetryPolicyForAttempt,
  priorM04ContractRejections,
  recordM04AttemptOutcome,
  resetM04AttemptLedger,
} = await import("../src/lib/m04-retry-policy.ts");
const { canAcceptTransparentFormulaFallback } = await import("../src/lib/m04-repair-policy.ts");

const failures = [];
const check = (name, fn) => {
  try { resetM04AttemptLedger(); fn(); } catch (error) { failures.push({ name, message: String(error?.message || error).slice(0, 600) }); }
};

const SIGNATURE = `hmac-sha256:${"a".repeat(64)}`;

check("A 首轮保持确定性：temperature 0，且不预设修复已耗尽", () => {
  const key = m04AttemptKey({ caseId: "case-1", m03ContractSignature: SIGNATURE });
  assert.ok(key, "同病例 + 已签名 M03 应能构成重试身份");
  const policy = m04RetryPolicyForAttempt(priorM04ContractRejections(key));
  assert.equal(policy.priorContractRejections, 0);
  assert.equal(policy.samplingTemperature, 0, "首轮必须仍是确定性采样");
  assert.equal(policy.repairExhaustedOnEntry, false, "首轮不得跳过修复轮");
});

check("B 重试轮必须换一张彩票，并承接「修复机会已用尽」（生产：两次输出逐字节相同）", () => {
  const key = m04AttemptKey({ caseId: "case-1", m03ContractSignature: SIGNATURE });
  recordM04AttemptOutcome(key, "contract_rejected");
  const second = m04RetryPolicyForAttempt(priorM04ContractRejections(key));
  assert.equal(second.priorContractRejections, 1);
  assert.ok(second.samplingTemperature > 0, "重试轮仍用 temperature 0 就是重抽同一张彩票");
  assert.equal(second.repairExhaustedOnEntry, true);

  recordM04AttemptOutcome(key, "contract_rejected");
  const third = m04RetryPolicyForAttempt(priorM04ContractRejections(key));
  assert.ok(third.samplingTemperature > second.samplingTemperature, "连续失败应继续加大脱离同一轨迹的力度");
  assert.ok(third.samplingTemperature <= 1, "温度阶梯必须有界");

  // 阶梯必须收敛，不得随失败次数无限升温。
  for (const prior of [4, 9, 50]) {
    assert.ok(m04RetryPolicyForAttempt(prior).samplingTemperature <= third.samplingTemperature + 0.2);
  }
});

check("C 出方后立即清账：一次历史失败不得永久改变后续同病例的采样", () => {
  const key = m04AttemptKey({ caseId: "case-1", m03ContractSignature: SIGNATURE });
  recordM04AttemptOutcome(key, "contract_rejected");
  assert.equal(priorM04ContractRejections(key), 1);
  recordM04AttemptOutcome(key, "delivered");
  assert.equal(priorM04ContractRejections(key), 0);
  assert.equal(m04RetryPolicyForAttempt(priorM04ContractRejections(key)).samplingTemperature, 0);
});

check("D 账本身份 = 同病例 + 同一份已签名 M03；任一变化即另一次诊疗", () => {
  const key = m04AttemptKey({ caseId: "case-1", m03ContractSignature: SIGNATURE });
  recordM04AttemptOutcome(key, "contract_rejected");
  const otherCase = m04AttemptKey({ caseId: "case-2", m03ContractSignature: SIGNATURE });
  const otherSignature = m04AttemptKey({ caseId: "case-1", m03ContractSignature: `hmac-sha256:${"b".repeat(64)}` });
  assert.equal(priorM04ContractRejections(otherCase), 0, "换病例不得继承失败");
  assert.equal(priorM04ContractRejections(otherSignature), 0, "重新生成辨证后不得继承失败");
  // 缺少任一半时不构成身份：不记账、不改行为（行为与今天完全一致）。
  assert.equal(m04AttemptKey({ caseId: "", m03ContractSignature: SIGNATURE }), undefined);
  assert.equal(m04AttemptKey({ caseId: "case-1", m03ContractSignature: undefined }), undefined);
  recordM04AttemptOutcome(undefined, "contract_rejected");
  assert.equal(priorM04ContractRejections(undefined), 0);
  assert.equal(m04RetryPolicyForAttempt(priorM04ContractRejections(undefined)).samplingTemperature, 0);
});

check("D 账本条目过期后回落到首轮行为（fail-safe：丢账本 = 退回今天的行为，不放宽任何判定）", () => {
  const key = m04AttemptKey({ caseId: "case-1", m03ContractSignature: SIGNATURE });
  const t0 = 1_000_000;
  recordM04AttemptOutcome(key, "contract_rejected", t0);
  assert.equal(priorM04ContractRejections(key, t0 + 60_000), 1);
  assert.equal(priorM04ContractRejections(key, t0 + 31 * 60_000), 0, "超过存活期应回落到首轮");
});

check("E 与既有受理判定联通：repairExhausted 多一种到达方式，安全前提一条不减", () => {
  const base = {
    completedRepairAttempts: 0,
    strictFormulaIssue: undefined,
    therapyIssue: undefined,
    requestAborted: false,
  };
  // 首轮：没修过、没耗尽 → 不得受理降级（今天的行为）。
  assert.equal(canAcceptTransparentFormulaFallback({ ...base, repairExhausted: false }), false);
  // 重试轮：上一轮已证明修复无效 → 受理判定可达。
  assert.equal(canAcceptTransparentFormulaFallback({ ...base, repairExhausted: true }), true);
  // 安全前提不变：请求已取消、或剩余缺陷不属可豁免族，一律仍然作废。
  assert.equal(canAcceptTransparentFormulaFallback({ ...base, repairExhausted: true, requestAborted: true }), false);
  assert.equal(
    canAcceptTransparentFormulaFallback({ ...base, repairExhausted: true, strictFormulaIssue: "formula_composition_mismatch" }),
    false,
  );
  assert.equal(
    canAcceptTransparentFormulaFallback({ ...base, repairExhausted: true, therapyIssue: "transparent_therapy_contract_missing" }),
    false,
  );
});

resetM04AttemptLedger();
console.log(JSON.stringify({ cases: 6, failures: failures.length }));
if (failures.length > 0) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
