export const SIX_HEALTH_FOLLOWUP_DIMENSIONS = [
  // 问句写给患者本人（2026-09-28 甲方：随访计划写进病历、交给患者），维度闭集不变。
  { dimension: "睡眠", question: "入睡快慢、夜里醒几次、是否早醒，醒后精神怎样，和这次就诊时比有没有变化？" },
  { dimension: "食欲", question: "胃口和饭量怎样，吃完饭后有没有不舒服，和这次就诊时比有没有变化？" },
  { dimension: "大便", question: "每天几次、是否成形、排便是否费力，颜色有没有异常，和这次就诊时比有没有变化？" },
  { dimension: "小便", question: "次数、尿量和颜色怎样，排尿时有没有不适，和这次就诊时比有没有变化？" },
  { dimension: "四肢温度", question: "手脚是凉还是热，活动后有没有变化，和这次就诊时比怎样？" },
  { dimension: "精力", question: "白天精神怎样、是否容易累，日常活动能不能坚持，和这次就诊时比有没有变化？" },
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
    "服药期间请留意以上几方面的变化，复诊时告诉医生；如出现明显不适，不要等到复诊，请及时就医。",
  ].join("\n");
}
