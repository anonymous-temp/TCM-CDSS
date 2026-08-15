import assert from "node:assert/strict";
import test from "node:test";
import {
  gapEchoed,
  persistentPrescriptionGapLabels,
  shouldRetryM04Attempt,
} from "./lib/robustness-live-assertions.mjs";

test("处方缺口回显忽略上一个请求的一次性语义筛查超时", () => {
  const missingItems = [
    "过敏史（明确有/无及过敏原/反应）",
    "当前用药（明确有/无及药物清单）",
    "语义红旗筛查未完成（模型超时）",
    "妊娠/哺乳/备孕状态（妊娠）",
  ];

  assert.deepEqual(persistentPrescriptionGapLabels(missingItems), [
    "过敏史",
    "当前用药",
    "妊娠/哺乳/备孕状态",
  ]);
  assert.equal(
    gapEchoed(missingItems, "正式采纳前需确认：过敏史、当前用药、妊娠/哺乳/备孕状态。"),
    true,
  );
});

test("处方缺口回显仍强制覆盖全部患者事实", () => {
  const missingItems = [
    "语义红旗筛查未完成（模型超时）",
    "过敏史（明确有/无及过敏原/反应）",
    "舌象",
    "脉象",
  ];

  assert.equal(gapEchoed(missingItems, "需确认过敏史、舌象。"), false);
  assert.equal(gapEchoed(missingItems, "需确认过敏史、舌象、脉象。"), true);
});

test("只有应出方案病例的可恢复 M04 失败才进入有限重试", () => {
  const base = {
    expectation: "should_prescribe",
    status: 200,
    transport: "",
    errorFrame: "",
    sawEnd: true,
    content: "正文",
    contract: null,
  };

  assert.equal(shouldRetryM04Attempt(base), true);
  assert.equal(shouldRetryM04Attempt({ ...base, content: "[TRUNCATED]" }), true);
  assert.equal(shouldRetryM04Attempt({ ...base, status: 0, transport: "This operation was aborted" }), true);
  assert.equal(shouldRetryM04Attempt({ ...base, contract: { formula: {} } }), false);
  assert.equal(shouldRetryM04Attempt({ ...base, content: "[TRUNCATED]", contract: { formula: {} } }), true);
  assert.equal(shouldRetryM04Attempt({ ...base, expectation: "should_not_prescribe_redflag" }), false);
  assert.equal(shouldRetryM04Attempt({ ...base, status: 401 }), false);
});
