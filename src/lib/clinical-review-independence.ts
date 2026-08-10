/**
 * 「独立复核」这四个字什么时候说得出口（甲方 2026-08-10 ⑨）。
 *
 * `independentFromGenerator` 在 diagnosis-api.ts 里算得很仔细——它记录的是「这次复核是否
 * 换了模型身份」，与 `independentInvocation`（是否另起一次无对话状态的请求）分开记账。
 * 但它**算出来即丢弃**：只进了 /api/model-health 的拓扑遥测，没有任何一处呈现读它，
 * 而医生可见的措辞一律无条件写「独立复核 / 独立临床复核」。
 *
 * 默认全 V4-Flash 部署下，候选链去重后只剩一个模型身份，`independentFromGenerator=false`——
 * 实际是**对同一模型的第二次无对话状态请求**。那仍是有价值的安全环节（无生成侧对话状态、
 * 复核专用提示词、只能加不能减风险），但它不是「独立」，把它说成独立就是对医生夸大了强度。
 *
 * 本模块是这条措辞的**唯一**导出谓词：拓扑位写进签名 attestation，三个出口
 *（服务端可见 Markdown、客户端卡片、HIS 方案）读同一份、用同一个改写函数。
 */

export type ClinicalReviewIndependence = "cross_model" | "same_model_second_pass";

export function clinicalReviewIndependenceOf(
  independentFromGenerator: boolean | undefined,
): ClinicalReviewIndependence {
  // 缺省（旧快照、未记录）按**较弱**的那一档处理：不能因为没记录就替它宣称独立。
  return independentFromGenerator === true ? "cross_model" : "same_model_second_pass";
}

/** 医生可读的复核方式名。 */
export function clinicalReviewLabel(independence: ClinicalReviewIndependence): string {
  return independence === "cross_model" ? "独立临床复核" : "二次临床复核";
}

/**
 * 复核方式的一句话说明。同模型第二次请求这一档必须把「同模型」讲出来——
 * 医生据此判断这道复核的证据强度，而不是被一个「独立」字样安慰。
 */
export function clinicalReviewMethodNote(independence: ClinicalReviewIndependence): string {
  return independence === "cross_model"
    ? "复核由与生成阶段不同的模型独立完成。"
    : "复核由同一模型另起一次无生成侧对话状态的请求完成（复核专用提示词，只增不减风险提示），不构成跨模型独立复核。";
}

/**
 * 把可见正文里无条件写死的「独立（临床）复核」改写成与**实际拓扑**一致的措辞。
 *
 * 之所以做成一次统一改写而不是逐处传参：这句措辞散落在 m04-repair-policy 的批注文案、
 * M03/M04 复核未完成通知、可见摘要的 resolutionReason、以及内部码降级文案里，
 * 逐处穿参会重演「同一判据多处各写各的」——本仓库的头号缺陷形状。
 * 跨模型拓扑下原样返回（措辞本就正确），因此这条改写在正确配置上是零操作。
 */
export function applyClinicalReviewIndependenceWording(
  text: string,
  independence: ClinicalReviewIndependence,
): string {
  if (independence === "cross_model") return text;
  return text
    .replace(/独立临床复核/g, "二次临床复核")
    .replace(/独立(?:诊断|处方)复核/g, (match) => match.replace("独立", "二次"))
    .replace(/独立复核/g, "二次复核");
}
