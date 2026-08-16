/**
 * 质量分档表必须在**两道校验点**都被读到，不能只在第一道。
 *
 * 【钉的是什么】diagnosis-rejection-tiers.ts 把 primary_syndrome_name_nonstandard 从
 * 默认 T1（安全级硬拦截）改成了 T2（修复耗尽后带批注放行），注释写着：
 *   「此前它落在默认 T1……修复轮耗尽后整份 M03 作废，医生连病机治法都拿不到。
 *     改为 T2 后仍先走修复轮按规范重述，只有修不出来才带批注放行。」
 *
 * 但 shouldAcceptWithQualityAnnotation 此前**全文件只被调用一次**——在编排那道校验
 * （客户输出变换之前）。变换之后的 finalize 校验直接 `truncated = true` 走兜底，
 * 完全不查分档表。于是 T2 只要拖到 finalize 才暴露，声称的「带批注放行」就不存在。
 *
 * 【线上实证】2026-08-16 表里·阳明气分热盛案（25s）生产容器日志：
 *   finalized M03 rejected { reason: 'm03_primary_syndrome_name_nonstandard' }
 *   stage_result { outcome:'fallback', reviewStatus:'accepted', reviewAttemptCount:2 }
 * 复核已跑两轮并通过、病机治法俱在，只因证候名写法不合国标，整页清空成
 * 「当前证候依据不足以形成稳定结论」——而且对外还记成「复核不可用」。
 *
 * 这是本仓头号缺陷形状的又一例：**同一个修复只做了一半**（分档改了，第二个消费点没跟上）。
 *
 * 【为什么用源码级断言】受理与否取决于编排运行时的一长串状态（变换结果、复核 attestation、
 * 修复轮计数），没有可导出的纯函数能表达。这里断言的是**两道校验点都调用了同一个判据**，
 * 以及受理条件逐条不放宽——判据漏在某一处，断言就红，这正是本缺陷的形状。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const { shouldAcceptWithQualityAnnotation, isSafetyRejection, qualityAnnotationCopy } =
  await jiti.import("../src/lib/diagnosis-rejection-tiers.ts");

const api = readFileSync(path.join(repoRoot, "src/lib/diagnosis-api.ts"), "utf8");

// ── 1. 分档判据必须在**至少两处**被调用（编排一处 + finalize 一处）──────────
{
  const callLines = api.split("\n")
    .map((line, index) => ({ line: line.trim(), no: index + 1 }))
    .filter((entry) => /shouldAcceptWithQualityAnnotation\s*\(/.test(entry.line))
    .filter((entry) => !entry.line.startsWith("import") && !entry.line.startsWith("//") && !entry.line.startsWith("*"));
  assert.ok(
    callLines.length >= 2,
    "质量分档判据必须在编排校验与 finalize 校验两处都被调用；"
    + `实得 ${callLines.length} 处（${callLines.map((entry) => entry.no).join(",")}）。`
    + "只在第一处调用时，T2 问题拖到 finalize 才暴露就会整份 M03 作废——"
    + "线上实测 primary_syndrome_name_nonstandard 正是这样清空了一份复核已通过的结果。",
  );
}

// ── 2. finalize 受理必须与编排受理**同条件**，不得放宽 ──────────────────────
{
  assert.ok(
    /M03 quality-tier acceptance at finalization/.test(api),
    "finalize 受理必须留下可检索的日志标记，便于线上归因",
  );
  // 三条守卫逐一在场：硬安全合同、分档、草稿充实度
  const finalizeBlock = api.slice(api.indexOf("M03 quality-tier acceptance at finalization") - 2400,
    api.indexOf("M03 quality-tier acceptance at finalization"));
  assert.ok(
    /m03SafetyContractIssue\([\s\S]{0,160}isSafetyRejection\)/.test(finalizeBlock),
    "finalize 受理前必须先过硬安全合同——质量档放行绝不能绕过安全档",
  );
  assert.ok(
    /visibleDraftLength: m03CandidateSubstanceLength\(/.test(finalizeBlock),
    "finalize 受理必须沿用同一套草稿充实度度量（JSON-only 形态下用结构化载荷体积）",
  );
  assert.ok(
    /qualityAnnotationCopy\(finalizedM03RejectionReason\)/.test(finalizeBlock),
    "没有对应批注文案的码不得受理——医生必须看得到为什么带批注",
  );
}

// ── 3. 判据本身：安全档一律不受理，质量档需草稿够实 ────────────────────────
{
  assert.equal(
    shouldAcceptWithQualityAnnotation({
      rejectionReason: "primary_syndrome_name_nonstandard",
      safetyIssue: "",
      visibleDraftLength: 400,
    }), true,
    "T2 质量档 + 无安全问题 + 草稿够实 ⇒ 应带批注受理",
  );
  assert.equal(
    shouldAcceptWithQualityAnnotation({
      rejectionReason: "primary_syndrome_name_nonstandard",
      safetyIssue: "some_safety_issue",
      visibleDraftLength: 400,
    }), false,
    "存在硬安全问题时一律不受理——质量档不得绕过安全档",
  );
  assert.equal(
    shouldAcceptWithQualityAnnotation({
      rejectionReason: "primary_syndrome_name_nonstandard",
      safetyIssue: "",
      visibleDraftLength: 10,
    }), false,
    "草稿过短不受理：带批注放行的前提是确实有东西给医生看",
  );
  assert.equal(
    shouldAcceptWithQualityAnnotation({
      rejectionReason: "primary_syndrome_name_nonstandard",
      visibleDraftLength: 400,
    }), false,
    "未传 safetyIssue 时默认按「安全门未评估」处理，不得受理（fail-closed）",
  );
  // 安全档码不得混进质量受理
  assert.ok(
    isSafetyRejection("primary_syndrome_unstable") === true
    || shouldAcceptWithQualityAnnotation({
      rejectionReason: "primary_syndrome_unstable", safetyIssue: "", visibleDraftLength: 400,
    }) === false,
    "安全档码不得走质量受理",
  );
  assert.ok(
    typeof qualityAnnotationCopy("primary_syndrome_name_nonstandard") === "string"
    && qualityAnnotationCopy("primary_syndrome_name_nonstandard").length > 4,
    "T2 码必须有面向医生的批注文案",
  );
}

console.log("test-m03-finalize-quality-tier: OK");
