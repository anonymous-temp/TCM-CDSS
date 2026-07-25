export const SIX_HEALTH_FOLLOWUP_DIMENSIONS = [
  { dimension: "睡眠", question: "入睡、夜醒、早醒和醒后精神较首诊如何变化？" },
  { dimension: "食欲", question: "食欲、餐量及进食后不适较首诊如何变化？" },
  { dimension: "大便", question: "频次、形态、排便难易及异常颜色较首诊如何变化？" },
  { dimension: "小便", question: "频次、尿量、颜色及排尿不适较首诊如何变化？" },
  { dimension: "四肢温度", question: "手足冷暖及活动后变化较首诊如何？" },
  { dimension: "精力", question: "白天精神、乏力程度及日常活动耐量较首诊如何变化？" },
] as const;

export function sixHealthFollowupTable(): string {
  return [
    "### 整体状态六维复评",
    "| 维度 | 复评问题 |",
    "|---|---|",
    ...SIX_HEALTH_FOLLOWUP_DIMENSIONS.map((item) => `| ${item.dimension} | ${item.question} |`),
    "",
    "六维变化仅用于复评整体趋势，不替代主诉疗效指标、现代危险信号或处方后安全审方。",
  ].join("\n");
}
