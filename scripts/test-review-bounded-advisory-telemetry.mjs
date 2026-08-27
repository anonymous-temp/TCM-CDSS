/**
 * 「复核不可用」与「复核不同意、服务端有界受理」必须在**所有**出口说同一句话。
 *
 * 甲方 08cc573 复测第 3 项：TCMEval 20 例里 10 例被签成 unavailable，而复核器实际返回的是
 * repair。签名 attestation 侧已于 a7907f2 修好（accepted + reviewDecision=repair + 原始问题码），
 * 但**运维指标侧没跟着修**：cdss_stage 只有 unavailable 一档，`reviewStatus = review.status`
 * 直接把有界受理记成复核不可用。2026-08-27 拉 30h 生产日志实测：10/58 例如此，
 * 指标读作「复核不可用 17%」，与同一次运行的签名载荷完全相反。
 *
 * 这正是本仓头号缺陷形状（同一判据两处各写各的）。修法是收敛成单一导出谓词
 * isBoundedAdvisoryReview，attestation 与指标共用；指标新增 bounded_advisory 一档，
 * 不再借用 unavailable。
 *
 * 编排语义不变：有界建议仍按 unavailable 走（不触发修复轮）——本套件只钉「怎么说」，不动「怎么做」。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const { isBoundedAdvisoryReview, clinicalReviewAttestation } = await jiti.import("../src/lib/diagnosis-api.ts");
const { recordCdssStageTelemetry, getCdssStageTelemetrySnapshot } = await jiti.import("../src/lib/cdss-stage-telemetry.ts");

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; console.log(`  ✓ ${label}`); };

const bounded = {
  status: "unavailable",
  issueCode: "review_unavailable",
  advisoryBoundary: "quality_concern",
  qualityOpinion: { decision: "repair", issueCode: "tcm_reasoning_unsupported" },
};

// ── 1. 谓词本身：两个条件缺一不可，避免把真·不可用误判成有界受理
check("谓词只在 advisoryBoundary 与 qualityOpinion 同时存在时为真", () => {
  assert.equal(isBoundedAdvisoryReview(bounded), true);
  assert.equal(isBoundedAdvisoryReview({ status: "unavailable", issueCode: "review_unavailable" }), false);
  assert.equal(isBoundedAdvisoryReview({ ...bounded, qualityOpinion: undefined }), false);
  assert.equal(isBoundedAdvisoryReview({ ...bounded, advisoryBoundary: undefined }), false);
});

// ── 2. 签名 attestation：保持既有语义（受理 + 复核器原始决定 + 原始问题码）
check("有界受理签成 accepted/repair/原始问题码，而非无原因 unavailable", () => {
  const attestation = clinicalReviewAttestation(bounded, { overview: { primarySyndrome: "心脾两虚证" } });
  assert.equal(attestation.status, "accepted");
  assert.equal(attestation.reviewDecision, "repair");
  assert.equal(attestation.reviewIssueCode, "tcm_reasoning_unsupported");
  assert.ok(!attestation.unavailableReason, `有界受理不应带不可用原因：${attestation.unavailableReason}`);
});
check("真·不可用仍签成 unavailable 且带原因码", () => {
  const attestation = clinicalReviewAttestation(
    { status: "unavailable", issueCode: "review_unavailable", execution: { attemptCount: 3, durationMs: 900, reason: "http_error" } },
    { overview: {} },
  );
  assert.equal(attestation.status, "unavailable");
  assert.ok(attestation.unavailableReason, "不可用必须带原因码，否则降级项无从归因");
});

// ── 3. 运维指标：两档分开计数，unavailable 不再被有界受理污染
check("bounded_advisory 只计入自己那一档，不计入 reviewUnavailable", () => {
  const readDiagnose = () => {
    const snapshot = getCdssStageTelemetrySnapshot();
    const stages = snapshot?.stages || snapshot;
    return stages?.diagnose || {};
  };
  const before = readDiagnose();
  const baseUnavailable = Number(before.reviewUnavailable || 0);
  const baseBounded = Number(before.reviewBoundedAdvisory || 0);
  recordCdssStageTelemetry({ stage: "diagnose", outcome: "success", durationMs: 1000, reviewStatus: "bounded_advisory" });
  const afterBounded = readDiagnose();
  assert.equal(Number(afterBounded.reviewBoundedAdvisory || 0), baseBounded + 1, "有界受理未被单独计数");
  assert.equal(Number(afterBounded.reviewUnavailable || 0), baseUnavailable, "有界受理污染了「复核不可用」计数");
  recordCdssStageTelemetry({ stage: "diagnose", outcome: "success", durationMs: 1000, reviewStatus: "unavailable" });
  const afterUnavailable = readDiagnose();
  assert.equal(Number(afterUnavailable.reviewUnavailable || 0), baseUnavailable + 1, "真·不可用漏计");
  assert.equal(Number(afterUnavailable.reviewBoundedAdvisory || 0), baseBounded + 1, "真·不可用被误计成有界受理");
});

// ── 4. 接线：两个出口必须问同一个谓词，且状态只有一个写入点
const api = readFileSync(new URL("../src/lib/diagnosis-api.ts", import.meta.url), "utf8");

check("attestation 与指标共用 isBoundedAdvisoryReview，无第二份内联判据", () => {
  // 定义处写作 `isBoundedAdvisoryReview<T extends {`，不匹配「函数名 + 左括号」，无需扣除。
  const uses = (api.match(/isBoundedAdvisoryReview\(/g) || []).length;
  assert.ok(uses >= 2, `谓词调用点只有 ${uses} 处（attestation 与指标各一处，至少 2 处）`);
  assert.ok(!/advisoryBoundary === "quality_concern" && review\.qualityOpinion\b/.test(api),
    "存在内联复写的有界受理判据，两处会分叉");
});

check("M03 复核状态只有一个写入点，且同时派生有界受理标记", () => {
  const direct = (api.match(/m03DiagnosticReviewStatus = review\.status;/g) || []).length;
  assert.equal(direct, 1, `复核状态赋值散落成 ${direct} 处`);
  const helperStart = api.indexOf("const noteM03ReviewStatus");
  assert.ok(helperStart > 0, "未找到 noteM03ReviewStatus");
  const helperBody = api.slice(helperStart, helperStart + api.slice(helperStart).indexOf("};") + 2);
  assert.ok(helperBody.length < 400, `helper 边界切过头（${helperBody.length} 字符），断言会空转`);
  assert.ok(helperBody.includes("m03DiagnosticReviewStatus = review.status;"), "状态赋值不在 helper 内");
  assert.ok(helperBody.includes("isBoundedAdvisoryReview(review)"), "helper 未派生有界受理标记");
  const callSites = (api.match(/noteM03ReviewStatus\(review\);/g) || []).length;
  assert.equal(callSites, 6, `复核状态写入调用点为 ${callSites} 处，已知为 6 处`);
});

check("指标上报点读的是派生标记而不是原始 status", () => {
  assert.ok(/m03ReviewBoundedAdvisory \? "bounded_advisory"/.test(api), "指标上报未区分有界受理");
});

console.log(`\n有界受理语义一致性：${checks} 项断言全部通过`);
