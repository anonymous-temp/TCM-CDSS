/**
 * 复核不可用的**原因码**必须随 attestation 一起走。
 *
 * 【钉的是什么】TCMEval-SDT 194 例实测（提交 9cb0fca4）：
 *   clinicalReview=accepted    176 例，均分 20.34%
 *   clinicalReview=unavailable  18 例，均分 **13.48%**（其中 4 例完全 unresolved）
 * 但从导出的 194 例原始数据里逐条查 attestation，字段只有
 *   ["status", "reviewedPayloadHash"]
 * ——**没有任何原因码**。于是这 18 例只知道「不可用」，不知道是超时、上游报错、
 * 契约不合法还是压根没配置。「列为生产降级项」这句话没有原因码就无从下手，
 * 有限重试与跨提供方兜底也无从设计。
 *
 * 【根因是同一种老毛病】diagnosis-api 的 ClinicalReviewExecutionMeta.reason 一直算着这五种失败，
 * 但 clinicalReviewAttestation() 只取 status 就返回，**算出来即丢弃**——
 * 与同文件里 independentFromGenerator 曾经的毛病同形（那处注释写着「一直算着这一位，
 * 却算出来即丢弃：只进了 /api/model-health 的拓扑遥测，呈现层无人读」）。
 * 同一个函数、同一种丢法，第二次。
 *
 * 【为什么做成单一导出谓词】不提出来就只能写源码级断言（grep 函数体），
 * 那种断言只能证明「代码里有这一行」，不能证明「这一行算得对」——本轮已经吃过一次亏。
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { clinicalReviewUnavailableReason } = await jiti.import("../src/lib/clinical-review-binding.ts");
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");

// ── 1. 五种失败都必须产出对应原因码 ────────────────────────────────────────
const FAILURES = ["not_configured", "deadline", "invalid_contract", "http_error", "transport_error"];
for (const reason of FAILURES) {
  assert.equal(
    clinicalReviewUnavailableReason("unavailable", reason), reason,
    `不可用时必须原样带出原因码：${reason}`,
  );
}

// ── 2. 成功档不得产出原因码（原因码只描述不可用）──────────────────────────
assert.equal(clinicalReviewUnavailableReason("accepted", "accepted"), undefined, "accepted 不得带原因码");
assert.equal(
  clinicalReviewUnavailableReason("accepted", "deadline"), undefined,
  "status=accepted 时即便执行元信息带着 deadline 也不得产出原因码——原因码只描述不可用",
);
assert.equal(clinicalReviewUnavailableReason("unavailable", "accepted"), undefined, "accepted 不是失败原因");
assert.equal(
  clinicalReviewUnavailableReason("unavailable", "repair"), undefined,
  "repair 是修复轮，不是不可用原因",
);

// ── 3. 未知/缺失一律不猜 ───────────────────────────────────────────────────
assert.equal(clinicalReviewUnavailableReason("unavailable", undefined), undefined, "缺执行元信息时不得编造原因码");
assert.equal(clinicalReviewUnavailableReason("unavailable", "unknown_reason"), undefined, "未登记的码一律不放行");

// ── 4. 原因码必须能穿过契约（否则算了也传不出去）──────────────────────────
{
  // 底座用**导出数据里的真实 M03 载荷**，不手搓：ReasoningV2Schema 要求 formula 等多个字段，
  // 手搓夹具会因为缺字段而失败，测出来的是夹具不是契约（本轮已踩过一次）。
  const exported = path.join(repoRoot, "docs/evaluations/TCMEval-SDT-194-reasoning-vs-gold-20260816.jsonl");
  const rows = readFileSync(exported, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const sample = rows.slice(1).find((item) => item?.productionResult?.reasoning?.formula !== undefined)
    || rows.slice(1)[0];
  const realReasoning = sample.productionResult.reasoning;
  const base = {
    ...realReasoning,
    clinicalReview: {
      status: "unavailable",
      unavailableReason: "deadline",
      attemptCount: 2,
      durationMs: 209_500,
    },
  };
  const parsed = ReasoningV2Schema.safeParse(base);
  assert.ok(parsed.success, `契约必须接受原因码字段：${JSON.stringify(parsed.error?.issues?.slice(0, 2))}`);
  assert.equal(parsed.data.clinicalReview.unavailableReason, "deadline", "原因码必须穿过契约而不是被剥掉");
  assert.equal(parsed.data.clinicalReview.durationMs, 209_500, "耗时必须穿过契约——它是区分超时与上游报错的依据");

  // 非法码不得整块作废 attestation（沿用本仓 catch(undefined) 的隔离口径）
  const bad = ReasoningV2Schema.safeParse({
    ...base,
    clinicalReview: { ...base.clinicalReview, unavailableReason: "made_up" },
  });
  assert.ok(bad.success, "非法原因码不得让整个 attestation 作废");
  assert.equal(bad.data.clinicalReview.unavailableReason, undefined, "非法原因码应被丢弃而不是原样透传");
  assert.equal(bad.data.clinicalReview.status, "unavailable", "status 必须保留");
}

// ── 5. 回归对照：194 例导出数据里这批 attestation 当时确实没有原因码 ────────
// 这条不是断言产品行为，是把「修复前长什么样」钉在案，避免以后有人以为一直都有。
{
  const exported = path.join(repoRoot, "docs/evaluations/TCMEval-SDT-194-reasoning-vs-gold-20260816.jsonl");
  if (existsSync(exported)) {
    const rows = readFileSync(exported, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const cases = rows.slice(1);
    const unavailable = cases.filter((item) =>
      (item?.productionResult?.reasoning?.clinicalReview || {}).status === "unavailable");
    assert.equal(unavailable.length, 18, `基线数据应有 18 例 unavailable，实得 ${unavailable.length}`);
    assert.ok(
      unavailable.every((item) => item.productionResult.reasoning.clinicalReview.unavailableReason === undefined),
      "这份导出是修复前的基线，按定义不该带原因码；若它带上了说明对照关系记错了",
    );
  }
}

console.log("test-clinical-review-unavailable-reason: OK", {
  failureReasons: FAILURES.length,
  contractRoundTrip: true,
});
