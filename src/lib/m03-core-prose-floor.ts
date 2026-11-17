/**
 * 删句、撤回证素之后核心文字的下限（第四十九轮）。
 *
 * 本轮几处服务端删减（对齐重写被拒后的按句删除、病性空栏无据断言的撤句、证素闭合的撤回）各自只删「矛盾的那句」，
 * 但一份辨证里总体病机常常只有一两句：new40 m11 对齐两次被拒、兜底把总体病机全删了，hold40 h32 撤回「阳虚」时
 * 把仅有的一句总体病机删成空串——前者触发 T1 overall_pathogenesis_unstable 退成占位，后者让开方判 M03 不稳定，
 * 两例都成了无剂量页（基线同病历都出了方）。矛盾留着还能被复核看见，整页作废对医生没有用处：删到下限以下就保留原文。
 * 下限只拦「删空或只剩一两个字」：辨证依据、总体病机至少 6 个汉字，治法至少一项（2 字）。删到更短但仍成句的照删——
 * 删得对的短句（「胁部胀痛，为气滞。未见阳虚。」）不该因为短被退回。
 */
const MINIMUM_HAN: Record<string, number> = { tcmDiagnosticRationale: 6, overallPathogenesis: 6, overallMethod: 2, overallTherapy: 2, summary: 2 };

function hanCount(value: string): number {
  return (value.match(/[一-鿿]/gu) || []).length;
}

/** 删减后的文字够用就用，否则退回删减前的原文（原文本来就空的不补）。 */
export function coreProseAfterCut(key: string, original: unknown, next: string): string {
  const before = typeof original === "string" ? original : "";
  const minimum = MINIMUM_HAN[key] ?? 1;
  if (!before.trim()) return next;
  return hanCount(next) >= minimum ? next : before;
}

/** 病机链、分治法这类数组删到一条不剩时退回原数组（空病机链是 T1 m03_chain_empty）。 */
export function rowsAfterCut<T>(original: readonly T[], next: T[]): T[] {
  return next.length === 0 && original.length > 0 ? [...original] : next;
}
