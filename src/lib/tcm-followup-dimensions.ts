export const SIX_HEALTH_FOLLOWUP_DIMENSIONS = [
  { dimension: "睡眠", question: "入睡、夜醒、早醒和醒后精神较首诊如何变化？" },
  { dimension: "食欲", question: "食欲、餐量及进食后不适较首诊如何变化？" },
  { dimension: "大便", question: "频次、形态、排便难易及异常颜色较首诊如何变化？" },
  { dimension: "小便", question: "频次、尿量、颜色及排尿不适较首诊如何变化？" },
  { dimension: "四肢温度", question: "手足冷暖及活动后变化较首诊如何？" },
  { dimension: "精力", question: "白天精神、乏力程度及日常活动耐量较首诊如何变化？" },
] as const;

/**
 * 六维复评表。传入 selected 时只列出被选中的维度——「所有病人问同样六维」不是辨证论治，
 * 而挑哪几维取决于本例证候（湿热下注该问大便小便，心脾两虚该问睡眠精力），是模型的活。
 * 不传或选不出时列全六维：那只是少一层裁剪，不影响正确性。
 */
export function sixHealthFollowupTable(selected?: readonly string[]): string {
  const governed = new Set(SIX_HEALTH_FOLLOWUP_DIMENSIONS.map((item) => item.dimension));
  // 越界维度直接丢弃：本表是受治理闭集，调用方（含模型输出）无法向其中引入新维度。
  const picked = (selected || []).filter((item) => governed.has(item as never));
  const rows = picked.length >= 2
    ? SIX_HEALTH_FOLLOWUP_DIMENSIONS.filter((item) => picked.includes(item.dimension))
    : SIX_HEALTH_FOLLOWUP_DIMENSIONS;
  return [
    picked.length >= 2 ? "### 整体状态复评（按本例证候选取）" : "### 整体状态六维复评",
    "| 维度 | 复评问题 |",
    "|---|---|",
    ...rows.map((item) => `| ${item.dimension} | ${item.question} |`),
    "",
    "六维变化仅用于复评整体趋势，不替代主诉疗效指标、现代危险信号或处方后安全审方。",
  ].join("\n");
}
