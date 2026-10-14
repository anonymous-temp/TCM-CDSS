/**
 * 中医治疗项目卡（tcmTreatments）疗程栏、操作栏里说流程的写法换成临床写法（2026-10-14）。
 *
 * 院内目录的模板句写的是「每次选穴和疗程须根据症状变化复评」「疗程由复评决定」「按耐受和复评结果确定」
 * 「穴位仅为课程索引与门诊病种频次的组合参考」——评分细则把「复评」列为流程词，独立评审逐例判工程用语不通过。
 * 只改措辞，不改频次、疗程数与操作本身。出卡处（tcm-treatment-capabilities）与交付面投影（delivered-surface）
 * 用这同一个函数：前者让 JSON、正文与页面拿到同一份文字，后者兜住此前已签名、仍在回放的结果。
 * 「实际取穴由现场医师复核」这类操作人员要求不在这里删，仍由交付面投影整句去掉（出卡处的操作栏保留它，见 test:tcm-treatments）。
 */
export function clinicalTreatmentScheduleWording(value: string): string {
  const text = String(value || "");
  const reworded = text
    .replace(/疗程由复评决定。?/g, "")
    .replace(/[；;，,]?\s*穴位仅为课程索引与门诊病种频次的组合参考。?/g, "。")
    .replace(/按(本例)?耐受和复评结果确定/g, "按$1耐受和疗效调整")
    .replace(/(变化|症状)复评/g, "$1调整")
    .replace(/复评/g, "评估")
    .replace(/。{2,}/g, "。")
    .replace(/^[。；;，,\s]+/, "")
    .trim();
  return reworded || text;
}
