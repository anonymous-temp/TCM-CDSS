/**
 * Shared clinical inference authority for M03 generation and independent review.
 *
 * Patient facts and clinical conclusions intentionally live at different semantic levels. Requiring
 * every mechanism word to appear verbatim in the chart makes legitimate syndrome differentiation
 * impossible; allowing a model to jump from one keyword to a named pattern is equally unsafe. This
 * contract defines the single evidence ladder used on both sides of the generation/review boundary.
 * Deterministic polarity, terminology and stage-contract checks remain binding beneath it.
 */
export const M03_CLINICAL_INFERENCE_AUTHORITY = [
  "【M03统一临床推理权威合同】",
  "L0 患者事实层：症状、舌脉、体征、检查及阳性/阴性极性必须逐字或等义可回溯到病例；模型不得补造。patientFact 和 supportingFacts 属于本层。",
  "L1 标准概念层：可把口语、俗称和同义表述归一为治理表中的标准症状、病位、病性或证候术语，但归一不得改变事实极性、时态、主体或严重程度。",
  "L2 证候归纳层：具体证候不是单一关键词映射，必须由全案中两个及以上相互独立的阳性事实维度收敛支持；症状组合、舌脉、面色和病程可共同构成证据。一个复合原句内的多个临床表现可分别作为事实维度。反证或互相矛盾的观察必须降级，不得挑选有利记录。",
  "L3 病机治法层：病机词和治法词是临床解释，不要求逐字出现在患者原话中；它们必须受已经成立的 L2 证候、病位病性及对应事实组合约束，并通过 chain 明确展示‘事实组合→证候依据→病机→治法方向’。不得从单一失眠、乏力、汗出或疼痛直接跳到气血阴阳、寒热痰瘀或具体脏腑证。",
  "L4 方剂方向层：命名方只能来自本例 T8 受控检索候选，且其核心方证须被 L0-L3 链条支持；经典方资料只能证明方证定义和方源，不能替代患者事实。未满足时清空方名并按已锁定病机辨证组方。",
  "判定纪律：逐字接地要求只适用于 L0 患者事实；复核 L2-L3 时应检查证据组合和推导是否闭合，不能因为‘心神失养、气血生化不足、胃失和降’等机制词未逐字出现在病历就判越界。反之，只有理论上常见而本例缺少对应事实组合的结论仍必须拒绝。",
].join("\n");

