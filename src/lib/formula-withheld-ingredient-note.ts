/**
 * 方义里「原方中的X毒性较大，本方未用。」这一句（m04-proposal-compiler 的 withWithheldBaseIngredientNote 补写）的写法与识别，
 * 只在这一处。写这句的是开方编译，认这句的是出处层：处方被剥去成方身份（自拟方）时，出处层把方义里的「原方」一律换成「本方案」，
 * 这句就成了「本方案中的朱砂粉毒性较大」——说本方里有朱砂，随后方外药核对把这个分句删掉，只剩「本方未用。」
 *（2026-10-19 M 集 Claude 评审 MTCMB-73、MTCMB-82、RobustSDT-single_0034、H 集 X-H-0426、H-tri-3366）。
 * 两边各写一份正则，改一处另一处就对不上，所以放在同一个文件里。本模块不引任何别的模块（编译器与出处层都引它，免得循环引用）。
 */
export function withheldBaseIngredientNote(names: readonly string[], allToxic: boolean): string {
  return allToxic ? `原方中的${names.join("、")}毒性较大，本方未用。` : `原方中的${names.join("、")}本方未用。`;
}

const WITHHELD_BASE_INGREDIENT_NOTE = /原方中的[^，,。；;]{1,24}?(?:毒性较大，)?本方未用。/gu;

/** 去掉这句说明（没有原方可指时用：自拟方）。没有这句时原样返回。 */
export function withoutWithheldBaseIngredientNote(text: string): string {
  return typeof text === "string" ? text.replace(WITHHELD_BASE_INGREDIENT_NOTE, "") : text;
}
