/**
 * 签名载荷 clinicalReview 上的**不可用原因码**必须随 attestation 一起走，并穿过契约。
 *
 * 【钉的是什么】TCMEval-SDT 194 例实测（提交 9cb0fca4）：clinicalReview=unavailable 的 18 例
 * attestation 字段只有 ["status", "reviewedPayloadHash"]——没有任何原因码，降级项无从归因。
 * 模型复核环节已于 2026-09-16 移除（2026-09-25 清除编排遗留）：正常签名结果的原因码恒为
 * not_configured；有限兜底页按真实原因标 not_attempted_no_valid_draft / not_attempted_upstream_down /
 * deadline。原「复核执行元信息 → 原因码」映射谓词随复核器一并删除（它只服务于已删除的复核执行）。
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
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");

// ── 1. 原因码必须能穿过契约（否则算了也传不出去）──────────────────────────
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

// ── 2. 回归对照：194 例导出数据里这批 attestation 当时确实没有原因码 ────────
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

// ── 3. 确定性兜底路径也必须带原因码，且必须与「尝试过并失败」区分开 ────────────
// 【为什么单列】首轮修复只覆盖了 clinicalReviewAttestation()（复核跑了但失败）。
// 194 例 18 例 unavailable 里，14 例走那条路、**4 例走确定性兜底**——而那 4 例正是
// 「完全 unresolved」的最坏情形（病例 4/35/148/250）。兜底路径根本不写 clinicalReview，
// 由签名层补一个裸的 {status:"unavailable"}，于是原因码在最需要它的地方缺席。
//
// 【为什么要新码而不复用 invalid_contract】兜底时复核**压根没启动**：生成方的结构化合同
// 修复耗尽后始终不合法，没有东西可供复核。而 invalid_contract 在复核语境里指**复核方**
// 返回的合同不合法。两者共用一个词，重试与跨提供方兜底就会对着「没东西可审」空转。
//
// 【旁证：同一个区分本仓已经做过一半】diagnose 路由 2026-08-04 的注释记着，上游 503 期间
// 甲方 10 例有 9 例被写成「当前证候依据不足」，医生以为病历不够去补录。那次把「服务故障」
// 与「证据不足」在**医生可见文案**上拆开了，但 attestation 层两者仍旧都写 unavailable。
{
  const safety = readFileSync(path.join(repoRoot, "src/lib/diagnosis-safety.ts"), "utf8");
  assert.ok(
    /reviewUnavailableReason\?:\s*ClinicalReviewAttestation\["unavailableReason"\]/.test(safety),
    "buildSafetyLimitedDiagnosisReasoning 必须能接收复核不可用原因码",
  );
  const route = readFileSync(path.join(repoRoot, "src/app/api/diagnosis/diagnose/route.ts"), "utf8");
  assert.ok(
    // 锚点按**语义**写，不钉 gate 变量名（2026-09-13：兜底页文案改为按原因码分支后，
    // truncatedGate 变成 truncatedGateFor(code)，字面锚点静默失配——本仓第四次同类）。
    /truncateFallback: signedLimitedDiagnosis\([\s\S]{0,80}"not_attempted_no_valid_draft"\)/.test(route),
    "合同修复耗尽的兜底必须标注「复核未启动·无合法草稿」，而不是裸 unavailable",
  );
  assert.ok(
    /signedLimitedDiagnosis\([\s\S]{0,80}"not_attempted_upstream_down"\)/.test(route),
    "上游不可用的降级页必须标注「复核未启动·上游不可用」——与「无合法草稿」是两种不同处置",
  );
  // 时限兜底必须是**独立的一页**，不能与合同校验失败共用。
  // 焊死在一个预渲染字符串上，超时也会被标成「没有合法草稿」——本轮修掉的混淆的低一层同款。
  assert.ok(
    /deadlineFallback: signedLimitedDiagnosis\([\s\S]{0,80}"deadline"\)/.test(route),
    "编排时限兜底必须单独标 deadline：时限触发时复核可能已启动并被切断，与「压根没启动」处置不同",
  );
  const api = readFileSync(path.join(repoRoot, "src/lib/diagnosis-api.ts"), "utf8");
  assert.ok(
    /deadlineFallback\?:\s*string;/.test(api),
    "StreamSafetyOptions 必须有独立的 deadlineFallback",
  );
  assert.ok(
    /const deadlineFallbackPage = opts\.deadlineFallback \|\| opts\.truncateFallback;/.test(api),
    "时限分支必须优先用 deadlineFallback（缺省回落 truncateFallback 以保持既有行为）",
  );

  // 有限兜底的原因码（含历史快照里可能出现的 accepted_but_draft_rejected_downstream）必须能穿过契约
  const exported = path.join(repoRoot, "docs/evaluations/TCMEval-SDT-194-reasoning-vs-gold-20260816.jsonl");
  const rows = readFileSync(exported, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const realReasoning = (rows.slice(1).find((item) => item?.productionResult?.reasoning?.formula !== undefined)
    || rows.slice(1)[0]).productionResult.reasoning;
  for (const code of ["not_attempted_no_valid_draft", "not_attempted_upstream_down",
    "accepted_but_draft_rejected_downstream"]) {
    const parsed = ReasoningV2Schema.safeParse({
      ...realReasoning,
      clinicalReview: { status: "unavailable", unavailableReason: code },
    });
    assert.ok(parsed.success, `契约必须接受「未启动」码 ${code}`);
    assert.equal(parsed.data.clinicalReview.unavailableReason, code, `${code} 必须原样穿过契约`);
  }
}

// ── 4. 基线对照：18 例里走兜底与走正常路径的分布钉在案 ────────────────────
{
  const exported = path.join(repoRoot, "docs/evaluations/TCMEval-SDT-194-reasoning-vs-gold-20260816.jsonl");
  if (existsSync(exported)) {
    const rows = readFileSync(exported, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const unavailable = rows.slice(1).filter((item) =>
      (item?.productionResult?.reasoning?.clinicalReview || {}).status === "unavailable");
    const fallback = unavailable.filter((item) => {
      const primary = item.productionResult.reasoning?.overview?.primarySyndrome || "";
      return primary.includes("依据不足以形成稳定结论") || primary.includes("急症处置优先");
    });
    assert.equal(fallback.length, 4, `基线：18 例 unavailable 中应有 4 例走确定性兜底，实得 ${fallback.length}`);
    assert.equal(unavailable.length - fallback.length, 14,
      "其余 14 例走正常路径（复核跑了但失败）——首轮修复只覆盖这 14 例");
  }
}

console.log("test-clinical-review-unavailable-reason: OK", { contractRoundTrip: true });

// ── 5. 各类兜底的可见理由必须各不相同（2026-09-13）────────────────────────────────
// 222 例实测第二类 7 例：attestation 是 not_attempted_no_valid_draft，医生看到的却是
// 「本次分析尚未形成通过临床复核的稳定证候结果」——把结构化交付问题说成复核否决。
// 措辞与原因码同源之后，路由实际会传的三类码与缺省必须逐条可区分；
// 模型复核环节已移除（owner 2026-09-25）：这些可见理由不得再提「独立临床复核」。
{
  const { limitedDiagnosisReasonCopy } = await jiti.import("../src/lib/diagnosis-safety.ts");
  const codes = ["not_attempted_no_valid_draft", "not_attempted_upstream_down", "deadline", undefined];
  const reasons = codes.map((code) => limitedDiagnosisReasonCopy(code).reason);
  assert.equal(new Set(reasons).size, reasons.length, "每个原因码必须有各自的可见理由");
  assert.match(limitedDiagnosisReasonCopy("not_attempted_no_valid_draft").reason, /完整性校验/);
  assert.doesNotMatch(limitedDiagnosisReasonCopy("not_attempted_no_valid_draft").reason, /通过临床复核/,
    "结构化交付问题不得说成复核否决");
  assert.doesNotMatch(limitedDiagnosisReasonCopy("not_attempted_upstream_down").reason, /通过临床复核|信息不足/,
    "上游故障不得说成临床结论");
  assert.match(limitedDiagnosisReasonCopy("deadline").reason, /安全时限/);
  for (const code of codes) {
    const copy = limitedDiagnosisReasonCopy(code);
    assert.doesNotMatch(`${copy.reason}${copy.limitation}${copy.nextAction}`, /临床复核|复核否决|模型复核|复核提出|复核未/,
      `${code ?? "缺省"}: 可见理由不得再提已删除的模型复核`);
  }
  // 缺省分支（生产路径上已不可达：三处兜底页都显式传码，拦截档 2026-09-25 删除）同样不得提复核。
  assert.equal(limitedDiagnosisReasonCopy(undefined).reason, "本次分析尚未形成稳定的证候结果");
}
