/**
 * 窄核对小任务交回的「病历原文摘录」是否真出自病历。
 *
 * 模型摘两处记录时常用「；」「，」拼成一句，且顺序未必与病历一致：S102 的西医核对交回
 * 「性激素六项大致正常；妇科彩超：子宫附件未见明显异常」，病历里两段是反着写的，整段子串比对不过，
 * 多囊卵巢综合征的降级就被丢掉（2026-10-19 第九轮终测，2 次探针 1 次如此）。
 * 判据：整段逐字在原文里；或按句读切开后每一段（各至少 3 字，两字片段如「正常」到处都有）都逐字在原文里。长度上下限照整段算。
 * 只比空白与全半角归一后的文本，不做同义改写——拼接只放宽「顺序」，不放宽「原文」。
 */
const compact = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");

export function quoteGroundedInText(
  quote: string,
  text: string,
  options: { minChars?: number; maxChars?: number } = {},
): boolean {
  const { minChars = 4, maxChars = 60 } = options;
  const whole = compact(quote);
  if (whole.length < minChars || whole.length > maxChars) return false;
  const source = compact(text);
  if (source.includes(whole)) return true;
  const parts = whole.split(/[；;，,。]+/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((part) => part.length >= 3 && source.includes(part));
}
