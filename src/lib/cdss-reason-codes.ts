/**
 * 降级/驳回 reasonCode 机器码表(2026-08-03 复盘的根源级工程)。
 *
 * 问题:前端流程分流靠正则匹配服务端中文文案(如 M03_LEVEL_PRESCRIBE_BLOCK_PATTERN),
 * 服务端改一个措辞,前端分流就瞎——文案与流程语义耦合。
 * 解法:降级页在正文嵌入稳定机器码标记(HTML 注释,医生不可见,与 CDSS_NON_DOSE_PRESCRIPTION
 * 同一形态);前端**按码分流**,文案随便改。码表前后端同构 import,单一来源。
 *
 * 约定:
 *  - 标记必须落在可见正文(sentinel JSON 之外),由服务端降级页构造函数负责嵌入;
 *  - 前端读码优先、旧文案正则仅作为对存量缓存病例的回退;
 *  - 新增码只能追加,不得改写既有码的语义(前端按码写死流程动作)。
 */

export const CDSS_DEGRADE_REASON_CODES = [
  /** M03 未形成稳定证候/未通过完整性与一致性复核 —— 重试须从辨证重跑 */
  "m03_unstable",
  /** 回传的 M03 缺少有效签名(或跨环境/跨病例) —— 重试须从辨证重跑 */
  "m03_signature_missing",
  /** 辨证语义复核未完成(复核服务不可用等) —— 重试须从辨证重跑 */
  "semantic_review_unfinished",
  /** 缺主诉 —— 须补录后从采集重跑 */
  "missing_chief_complaint",
  /** 信息完整度未达 C —— 补充信息后重跑辨证 */
  "completeness_below_c",
  /** 安全门红旗拦截(block 档) —— 完成风险处置后重试 */
  "safety_gate_blocked",
  /** M04 输出截断且无可回收候选 —— 可直接重试 M04 */
  "m04_truncated_no_candidate",
  /** 确定性方剂参考页(非剂量增强形态) —— 可直接重试 M04 尝试完整出方 */
  "deterministic_reference",
  /** 锁定方无可执行剂量基准(block 档) —— 医生调整方向或切 advise 档 */
  "formula_dose_boundary_unavailable",
  /**
   * 上游模型服务暂时不可用(修复轮/复核走非流式端点,provider 503/超时)。
   * 与「证候依据不足」是**完全不同**的事:前者是服务故障,重试即可;后者是临床证据不足,
   * 重试无用、需补充病历。此前两者共用同一句降级文案,把服务故障说成了临床结论——
   * 医生据此会误以为病历不充分(实测:上游 503 期间甲方10例有9例显示「证候依据不足」)。
   */
  "upstream_model_unavailable",
] as const;

export type CdssDegradeReasonCode = (typeof CDSS_DEGRADE_REASON_CODES)[number];

const MARKER_PATTERN = /<!--\s*CDSS_REASON_CODE:([a-z0-9_]+)\s*-->/;

export function cdssReasonCodeMarker(code: CdssDegradeReasonCode): string {
  return `<!-- CDSS_REASON_CODE:${code} -->`;
}

/** 从降级页正文提取机器码;无标记或码不在表内返回 undefined(回退旧文案正则)。 */
export function extractCdssReasonCode(text: string | undefined): CdssDegradeReasonCode | undefined {
  const match = (text || "").match(MARKER_PATTERN);
  if (!match) return undefined;
  const code = match[1] as CdssDegradeReasonCode;
  return (CDSS_DEGRADE_REASON_CODES as readonly string[]).includes(code) ? code : undefined;
}

/** 该码的重试是否必须从 M03 辨证级重跑(而不是原地重试 M04)。 */
export function reasonCodeRequiresM03Rerun(code: CdssDegradeReasonCode | undefined): boolean {
  return code === "m03_unstable" ||
    code === "m03_signature_missing" ||
    code === "semantic_review_unfinished" ||
    code === "completeness_below_c";
}
