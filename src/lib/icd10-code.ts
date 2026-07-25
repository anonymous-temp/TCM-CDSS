/**
 * Chinese payer ICD-10 expansion used by the governed workbook. Besides the three-character ICD
 * category, it permits decimal extensions, lowercase `x` placeholders, and dagger/asterisk paired
 * codes. No whitespace or arbitrary punctuation is accepted.
 */
export const ICD10_PAYER_CODE_PATTERN = /^[A-Z]\d{2}(?:[.][A-Z0-9x]+)?(?:[+*\nA-Z0-9x.]+)?$/;

export function isSupportedIcd10PayerCode(value: string): boolean {
  return value.length <= 80 && ICD10_PAYER_CODE_PATTERN.test(value);
}
