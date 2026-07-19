const TONGUE_EQUIVALENCE_GROUPS = [
  /舌尖(?:略|稍|微)?红/,
  /(?:舌边|边)(?:有)?(?:轻|轻度)?(?:齿痕|齿印)|齿痕舌/,
  /(?:苔薄少|苔少|少苔)/,
] as const;

const CLINICAL_NEGATION = /(?:无|未见|未出现|否认|不伴|待核实|待确认|不详|未知)/;

function clinicalPhrases(value: string): string[] {
  return value.split(/[，,；;。\n]+/).map((item) => item.trim()).filter(Boolean);
}

function tongueDetailScore(value: string): number {
  return (value.match(/(?:略|稍|微|轻|轻度|薄)/g) || []).length;
}

export function appendDelimitedValue(current: string, value: string): string {
  const next = value.trim();
  if (!next) return current;
  if (clinicalPhrases(current).some((item) => item === next)) return current;
  if (!current.trim()) return next;
  const sep = /[，,；;。]$/.test(current.trim()) ? "" : "，";
  return `${current}${sep}${next}`;
}

export function appendTonguePresetValue(current: string, value: string): string {
  const next = value.trim();
  if (!next) return current;
  const group = TONGUE_EQUIVALENCE_GROUPS.find((pattern) => pattern.test(next));
  if (!group) return appendDelimitedValue(current, next);
  const phrases = clinicalPhrases(current);
  const equivalentIndex = phrases.findIndex((phrase) => group.test(phrase) && !CLINICAL_NEGATION.test(phrase));
  if (equivalentIndex < 0) return appendDelimitedValue(current, next);

  const recorded = phrases[equivalentIndex];
  if (tongueDetailScore(recorded) >= tongueDetailScore(next)) return current;
  phrases[equivalentIndex] = next;
  return phrases.join("，");
}

export function appendClinicalPresetValue(field: string, current: string, value: string): string {
  return field === "tcmTongue"
    ? appendTonguePresetValue(current, value)
    : appendDelimitedValue(current, value);
}

const TONGUE_SPECIFIC_MARKER = /(?:舌|苔|齿痕|齿印|裂纹|瘀点|瘀斑|舌下络脉)/;
const PULSE_COMPACT_PATTERN = /^(?:脉)?(?:浮|沉|迟|数|滑|涩|弦|细|弱|濡|缓|紧|洪|结|代|促|虚|实|微|散|芤|革|牢|伏|动|长|短){1,4}(?:脉)?$/;

export type TonguePulseFieldConflict = {
  swapped: boolean;
  tongueLooksLikePulse: boolean;
  pulseLooksLikeTongue: boolean;
};

export function detectTonguePulseFieldConflict(tongue: string, pulse: string): TonguePulseFieldConflict {
  const normalizedTongue = tongue.replace(/[，,；;。\s]/g, "");
  const normalizedPulse = pulse.replace(/[，,；;。\s]/g, "");
  const tongueLooksLikePulse = Boolean(normalizedTongue) && PULSE_COMPACT_PATTERN.test(normalizedTongue) && (
    normalizedTongue.includes("脉") || Array.from(normalizedTongue).length >= 2
  );
  const pulseLooksLikeTongue = Boolean(normalizedPulse) && TONGUE_SPECIFIC_MARKER.test(normalizedPulse);
  return {
    swapped: tongueLooksLikePulse && pulseLooksLikeTongue,
    tongueLooksLikePulse,
    pulseLooksLikeTongue,
  };
}
