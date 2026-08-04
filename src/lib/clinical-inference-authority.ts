/**
 * Shared clinical inference authority for M03 generation and independent review.
 *
 * Patient facts and clinical conclusions intentionally live at different semantic levels. Requiring
 * every mechanism word to appear verbatim in the chart makes legitimate syndrome differentiation
 * impossible; allowing a model to jump from one keyword to a named pattern is equally unsafe. This
 * contract defines the single evidence ladder used on both sides of the generation/review boundary.
 * Deterministic polarity, terminology and stage-contract checks remain binding beneath it.
 */
/**
 * 呈现层根修（甲方评测 2026-08-04 第 1 条：方义解析混入 L0/L1/L3 等工程标签）。
 *
 * 本合同原先用 `L0`–`L4` 给五个语义层编号，并被逐字注入 M03 生成 prompt、独立复核 prompt 和
 * 争议裁决 prompt。模型上下文里一旦存在 `L2 证候归纳层` 这样的记号，它就可能在自由文本字段里回声
 * （甲方看到的形态是 `L0/L1/L3`），这些字段随后被 M04 prompt 原样中继，再被
 * `buildFormulaAnalysis` 加引号抄进医生可见的方义解析。**净化输出端治不了这个类**——下一个
 * 病例换个位置照样漏。
 *
 * 注：artifacts/ 下 1440 份归档产出里搜不到任何层号泄漏（`\bL\d+\b` 的 180 处命中全是 ICD-10
 * 皮肤科编码），所以这条根修没有可回放的归档反例；能证明的是**源头已消失**——合同正文里不再有
 * 任何 `L\d`，模型上下文里就没有可回声的记号。兜底净化见 internal-tag-hygiene.ts。
 *
 * 因此层名改为纯中文描述性名称：模型上下文里不再存在任何 `L\d` 形态的记号，就没有可回声的源。
 * 层的语义、顺序与判定纪律完全不变，改的只是标签本身。
 * 同理，原 L4 条里的 `T8 受控检索候选` 也是流水线阶段编号，改为其含义描述。
 */
export const M03_CLINICAL_INFERENCE_AUTHORITY = [
  "【M03统一临床推理权威合同】",
  "第一层「患者事实」：症状、舌脉、体征、检查及阳性/阴性极性必须逐字或等义可回溯到病例；模型不得补造。patientFact 和 supportingFacts 属于本层。",
  "第二层「标准概念」：可把口语、俗称和同义表述归一为治理表中的标准症状、病位、病性或证候术语，但归一不得改变事实极性、时态、主体或严重程度。",
  "第三层「证候归纳」：具体证候不是单一关键词映射，必须由全案中两个及以上相互独立的阳性事实维度收敛支持；症状组合、舌脉、面色和病程可共同构成证据。一个复合原句内的多个临床表现可分别作为事实维度。反证或互相矛盾的观察必须降级，不得挑选有利记录。",
  "第四层「病机治法」：病机词和治法词是临床解释，不要求逐字出现在患者原话中；它们必须受已经成立的第三层证候、病位病性及对应事实组合约束，并通过 chain 明确展示‘事实组合→证候依据→病机→治法方向’。不得从单一失眠、乏力、汗出或疼痛直接跳到气血阴阳、寒热痰瘀或具体脏腑证。",
  "第五层「方剂方向」：命名方只能来自本例受控方剂检索给出的候选，且其核心方证须被前四层链条支持；经典方资料只能证明方证定义和方源，不能替代患者事实。未满足时清空方名并按已锁定病机辨证组方。",
  "判定纪律：逐字接地要求只适用于第一层患者事实；复核第三、四层时应检查证据组合和推导是否闭合，不能因为‘心神失养、气血生化不足、胃失和降’等机制词未逐字出现在病历就判越界。反之，只有理论上常见而本例缺少对应事实组合的结论仍必须拒绝。",
  "输出纪律：本合同的层号与层名是内部推理纪律，禁止出现在任何医生可见字段（证候、病机、治法、辨证分析、方义、加减理由）中；不得写“符合第三层”“按第四层推导”一类措辞，只写临床结论本身。",
].join("\n");

