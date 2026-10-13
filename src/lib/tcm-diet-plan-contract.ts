function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function foodExampleAfterMarker(value: string): string {
  let markerAt = -1;
  let markerLength = 0;
  const keepFirst = (at: number, length: number) => {
    if (at >= 0 && (markerAt < 0 || at < markerAt)) {
      markerAt = at;
      markerLength = length;
    }
  };
  // 引出食物示例的说法是有限闭集。2026-10-13 补齐常见写法：此前只认「可用/例如/比如」等五种，
  // 模型写「可选小米粥、山药粥等易消化餐食」不算有示例，于是每例都被追加一句通用的「三餐定时…」，
  // 同一栏里出现两遍（甲方 10.12 测评）。
  for (const marker of ["可适当食用", "可适量食用", "可用", "例如", "比如", "可选用", "可选", "宜选用", "宜选", "宜食用", "宜食", "宜吃", "可食用", "可食", "可吃", "可多食", "多食", "多吃", "推荐", "建议食用", "适合食用"]) {
    keepFirst(value.indexOf(marker), marker.length);
  }
  if (markerAt < 0) return "";
  return value.slice(markerAt + markerLength).split(/[，,。；;]/, 1)[0] || "";
}

function hasConcreteFoodExample(value: string): boolean {
  const example = foodExampleAfterMarker(value);
  return (example.match(/\p{Script=Han}/gu) || []).length >= 3;
}

function hasConcreteDietAction(value: string): boolean {
  const hasQuantityOrTiming = /\d+\s*[\p{Script=Han}]{1,3}/u.test(value) ||
    value.includes("少量多餐") || value.includes("少食多餐");
  const hasDirective = value.includes("不") || value.includes("避免") ||
    value.includes("限制") || value.includes("减少") || value.includes("忌") || value.includes("少食") || value.includes("少吃");
  return value.length >= 16 && hasDirective && (hasQuantityOrTiming || hasConcreteFoodExample(value));
}

/** 医生端食疗卡与 M04 生成校验共用的最小完整性合同。 */
export function isConcreteClinicianDietPlan(value: unknown): boolean {
  const diet = cleanText(value);
  return hasConcreteDietAction(diet) && hasConcreteFoodExample(diet);
}

const DETERMINISTIC_ORDINARY_MEAL_EXAMPLE =
  "三餐定时、每餐七八分饱；例如米饭或面食搭配清淡烹调的当季蔬菜；减少辛辣油炸食物和夜宵。";

/**
 * 非药物调护是建议性内容，不能因为模型少写一个餐食示例而连坐作废已经通过安全核验的处方。
 * 保留模型给出的病例相关内容，仅在其不满足医生端最小可执行合同时追加普通膳食示例。
 * 兜底不宣称治疗作用，也不引入药食两用食材、功能性食物或剂量。
 */
export function ensureConcreteClinicianDietPlan(value: unknown): string {
  const diet = cleanText(value);
  if (isConcreteClinicianDietPlan(diet)) return diet;
  return [diet, DETERMINISTIC_ORDINARY_MEAL_EXAMPLE].filter(Boolean).join(" ");
}
