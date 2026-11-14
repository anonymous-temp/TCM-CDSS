/**
 * 推拿、针灸教材原文的 OCR 缺字与错字（《推拿学》里「㨰法」的㨰字扫描时丢失，写成「以法作用于」「施法于」）。
 * 卡片生成（tcm-nondrug-textbook-plan.server.ts）与交付面（delivered-surface.ts）共用；有限闭集。
 */
const NONDRUG_TEXTBOOK_OCR_FIXES: ReadonlyArray<readonly [string, string]> = [
  ["顽同性", "顽固性"],
  ["以法作用", "以滚法作用"],
  ["以法施", "以滚法施"],
  ["施法于", "施滚法于"],
  ["用法在", "用滚法在"],
  ["、法、", "、滚法、"],
  ["：法、", "：滚法、"],
  ["伏免", "伏兔"],
  // 2026-11-14 第四十五轮：甲方 100 例 C026、C030「施以法」，C045「施法及揉法」（㨰字丢了）。
  ["施以法", "施以滚法"],
  ["施法及", "施滚法及"],
  ["施法约", "施滚法约"],
];
export function textbookOcrFixed(text: string): string {
  return NONDRUG_TEXTBOOK_OCR_FIXES.reduce((value, [wrong, right]) => value.split(wrong).join(right), String(text || ""))
    // 「施法5分钟」（数字前丢了㨰字）。
    .replace(/施法(?=\d)/gu, "施滚法");
}
