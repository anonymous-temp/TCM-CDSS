import config from "../data/record-quote-alignment.source.json";

/**
 * 模型引文 → 病历原文片段的对齐（2026-10-26 第二十一轮）。
 *
 * 各处接地检查原先只认「逐字子串」，于是模型把病历「脉象：弦」写成「脉弦」、把「腹痛“昨晚才开始”」
 * 写成「腹痛昨晚才开始」、把「mmHg」打成「mmHp」，引文都判为编造：病机链节点被整条删除（链删空就
 * m03_chain_empty → 有限诊断页，生产 C093），事实层多跑一轮引用修复。同一类写法差异在每个检查里各补
 * 一次是没有尽头的；这里一处对齐，所有接地检查共用（做法同 Google LangExtract 的 source grounding：
 * 抽取结果对回原文位置，exact → 近似 → not_found 分级）。
 *
 * 只放宽「写法」，不放宽「内容」：
 * - normalized：去掉空白与引号、标点归类、全半角、计量单位前的中文数词转数字；
 * - field_compact：带标签的四诊字段（脉象：弦 ⇄ 脉弦/弦脉，舌质：淡红 ⇄ 舌淡红）；
 * - latin_fuzzy：只允许拉丁字母各错一个（单位笔误），汉字与数字必须一致。
 * 返回值永远是病历里的原文片段，调用方拿它替换模型引文；否定、未评估等语境由调用方的 guard 判。
 */

export type QuoteAlignmentStatus = "exact" | "normalized" | "field_compact" | "latin_fuzzy";
export type QuoteAlignment = { status: QuoteAlignmentStatus; span: string; start: number; end: number };
export type QuoteAlignmentOptions = {
  /** 原文某位置的提及是否不能当作肯定事实（否定、未评估、他人等）；返回 true 则该位置不采用。 */
  excludedAt?: (sourceText: string, index: number) => boolean;
  /** 归一化后的引文最短长度（太短的片段到处都有）。 */
  minNormalizedChars?: number;
};

type Mapped = { text: string; start: number[]; end: number[] };

const DROPPED = new Set(Array.from(config.droppedQuoteMarks));
const PUNCTUATION = new Map<string, string>();
for (const entry of config.punctuationClasses) {
  for (const member of Array.from(entry.members)) PUNCTUATION.set(member, entry.canonical);
}
const NUMERAL_DIGITS = config.chineseNumeralDigits as Record<string, number>;
const NUMERAL_CHARS = `${Object.keys(NUMERAL_DIGITS).join("")}十`;
const NUMERAL_BEFORE_UNIT = new RegExp(
  `[${NUMERAL_CHARS}]{1,3}(?=${[...config.numeralUnits].sort((a, b) => b.length - a.length).join("|")})`,
  "gu",
);
const FIELD_LABELS = [...config.fieldLabels].sort((a, b) => b.label.length - a.label.length);
const FIELD_LINE = new RegExp(`(${FIELD_LABELS.map((item) => item.label).join("|")})\\s*[：:]\\s*([^\\n]+)`, "gu");
const LEADING_FIELD_LABEL = new RegExp(`^(${FIELD_LABELS.map((item) => item.label).join("|")})\\s*[：:]\\s*`, "u");
const EDGE_PUNCTUATION = /^[\s，,、；;：:。.!！?？]+|[\s，,、；;：:。.!！?？]+$/gu;

function chineseNumeralValue(numeral: string): number | undefined {
  if (!numeral) return undefined;
  const tenAt = numeral.indexOf("十");
  if (tenAt < 0) {
    if (numeral.length !== 1) return undefined;
    return NUMERAL_DIGITS[numeral];
  }
  if (numeral.indexOf("十", tenAt + 1) >= 0) return undefined;
  const tens = tenAt === 0 ? 1 : NUMERAL_DIGITS[numeral.slice(0, tenAt)];
  const onesText = numeral.slice(tenAt + 1);
  const ones = onesText ? NUMERAL_DIGITS[onesText] : 0;
  if (tens === undefined || ones === undefined || numeral.slice(0, tenAt).length > 1 || onesText.length > 1) return undefined;
  return tens * 10 + ones;
}

/** 归一化并保留每个归一字符在原文里的起止位置。 */
function normalizeWithMap(source: string): Mapped {
  const chars: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let index = 0;
  for (const raw of source) {
    const next = index + raw.length;
    const nfkc = raw.normalize("NFKC");
    for (const ch of Array.from(nfkc)) {
      if (/\s/u.test(ch) || DROPPED.has(ch) || DROPPED.has(raw)) continue;
      chars.push((PUNCTUATION.get(ch) || PUNCTUATION.get(raw) || ch).toLowerCase());
      start.push(index);
      end.push(next);
    }
    index = next;
  }
  // 计量单位前的中文数词转数字（「三天」⇄「3天」），映射到整段数词的原文范围。
  const text = chars.join("");
  const outChars: string[] = [];
  const outStart: number[] = [];
  const outEnd: number[] = [];
  let cursor = 0;
  for (const match of text.matchAll(NUMERAL_BEFORE_UNIT)) {
    const at = match.index ?? 0;
    const value = chineseNumeralValue(match[0]);
    if (value === undefined) continue;
    for (let i = cursor; i < at; i += 1) { outChars.push(chars[i]); outStart.push(start[i]); outEnd.push(end[i]); }
    const digits = String(value);
    const spanStart = start[at];
    const spanEnd = end[at + match[0].length - 1];
    for (const digit of digits) { outChars.push(digit); outStart.push(spanStart); outEnd.push(spanEnd); }
    cursor = at + match[0].length;
  }
  for (let i = cursor; i < chars.length; i += 1) { outChars.push(chars[i]); outStart.push(start[i]); outEnd.push(end[i]); }
  return { text: outChars.join(""), start: outStart, end: outEnd };
}

export function normalizedQuoteText(value: string): string {
  return normalizeWithMap(value).text;
}

const OPENING_MARKS = "“‘「『";
const CLOSING_MARKS = "”’」』";

function spanOf(source: string, mapped: Mapped, at: number, length: number): { span: string; start: number; end: number } | undefined {
  if (length <= 0) return undefined;
  let spanStart = mapped.start[at];
  let spanEnd = mapped.end[at + length - 1];
  // 引号被归一化丢掉了：片段里有未配对的引号时，把紧挨着的另一半带上，原文片段才完整。
  const count = (text: string, marks: string) => Array.from(text).filter((ch) => marks.includes(ch)).length;
  const inner = source.slice(spanStart, spanEnd);
  if (count(inner, OPENING_MARKS) > count(inner, CLOSING_MARKS) && CLOSING_MARKS.includes(source[spanEnd] || "")) spanEnd += 1;
  if (count(inner, CLOSING_MARKS) > count(inner, OPENING_MARKS) && OPENING_MARKS.includes(source[spanStart - 1] || "")) spanStart -= 1;
  const raw = source.slice(spanStart, spanEnd);
  const trimmedLeft = raw.length - raw.replace(/^[\s，,、；;：:。!！?？]+/u, "").length;
  const span = raw.replace(EDGE_PUNCTUATION, "");
  if (!span) return undefined;
  return { span, start: spanStart + trimmedLeft, end: spanStart + trimmedLeft + span.length };
}

function findAllowed(
  haystack: string,
  needle: string,
  accept: (at: number) => boolean,
): number {
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    if (accept(at)) return at;
    at = haystack.indexOf(needle, at + 1);
  }
  return -1;
}

type FieldForm = { form: string; start: number; end: number };

/** 病历里每个带标签的四诊字段，生成它的紧凑写法；位置指向「标签：取值」到该从句末尾的原文。 */
function fieldCompactForms(source: string): FieldForm[] {
  const forms: FieldForm[] = [];
  for (const match of source.matchAll(FIELD_LINE)) {
    const label = FIELD_LABELS.find((item) => item.label === match[1]);
    if (!label) continue;
    const lineStart = match.index ?? 0;
    const valueOffset = lineStart + match[0].length - match[2].length;
    for (const clauseMatch of match[2].matchAll(/[^，,；;。]+/gu)) {
      const clause = clauseMatch[0].trim();
      if (!clause) continue;
      const bare = label.compactPrefix && clause.startsWith(label.compactPrefix) ? clause.slice(label.compactPrefix.length) : clause;
      const variants = new Set<string>([clause, `${label.label}${bare}`]);
      if (label.compactPrefix) variants.add(`${label.compactPrefix}${bare}`);
      if (label.compactSuffix) variants.add(`${bare}${label.compactSuffix}`);
      const end = valueOffset + (clauseMatch.index ?? 0) + clauseMatch[0].length;
      for (const variant of variants) forms.push({ form: normalizedQuoteText(variant), start: lineStart, end });
    }
  }
  return forms;
}

function latinFuzzyIndex(haystack: string, needle: string, accept: (at: number) => boolean): number {
  if (!/[a-z]/u.test(needle) || needle.length < 4) return -1;
  for (let at = 0; at + needle.length <= haystack.length; at += 1) {
    let mismatches = 0;
    let ok = true;
    for (let i = 0; i < needle.length; i += 1) {
      const a = needle[i];
      const b = haystack[at + i];
      if (a === b) continue;
      if (!/[a-z]/u.test(a) || !/[a-z]/u.test(b) || ++mismatches > 1) { ok = false; break; }
    }
    if (ok && mismatches === 1 && accept(at)) return at;
  }
  return -1;
}

/**
 * 把模型引文对到病历原文。找不到返回 undefined。
 * 顺序：逐字 → 归一化 → 四诊字段紧凑写法 → 拉丁字母单错。每一级都先过调用方的 excludedAt。
 */
export function alignQuoteToSource(
  quote: string,
  sourceText: string,
  options: QuoteAlignmentOptions = {},
): QuoteAlignment | undefined {
  const trimmed = quote.trim().replace(EDGE_PUNCTUATION, "");
  if (!trimmed || !sourceText) return undefined;
  const excluded = (index: number) => Boolean(options.excludedAt?.(sourceText, index));

  const exactAt = findAllowed(sourceText, trimmed, (at) => !excluded(at));
  if (exactAt >= 0 && !LEADING_FIELD_LABEL.test(trimmed)) {
    return { status: "exact", span: trimmed, start: exactAt, end: exactAt + trimmed.length };
  }

  const mapped = normalizeWithMap(sourceText);
  const normalizedQuote = normalizedQuoteText(trimmed);
  const minChars = options.minNormalizedChars ?? 2;
  if (normalizedQuote.length < minChars) return undefined;

  // 带标签的引文（「脉象：弦」）先按字段紧凑写法比；剥掉标签后的单字取值（「弦」）不单独比。
  const labelled = trimmed.match(LEADING_FIELD_LABEL);
  const fieldLabel = labelled ? FIELD_LABELS.find((item) => item.label === labelled[1]) : undefined;
  const labelledValue = labelled ? trimmed.slice(labelled[0].length) : "";
  const fieldQuote = fieldLabel
    ? normalizedQuoteText(fieldLabel.compactPrefix && !labelledValue.startsWith(fieldLabel.compactPrefix)
      ? `${fieldLabel.compactPrefix}${labelledValue}`
      : labelledValue)
    : normalizedQuote;
  for (const form of fieldCompactForms(sourceText)) {
    if (form.form !== fieldQuote) continue;
    if (excluded(form.start)) continue;
    const span = sourceText.slice(form.start, form.end).replace(EDGE_PUNCTUATION, "");
    return { status: "field_compact", span, start: form.start, end: form.start + span.length };
  }
  if (labelled && exactAt >= 0) {
    return { status: "exact", span: trimmed, start: exactAt, end: exactAt + trimmed.length };
  }

  const acceptMapped = (at: number) => !excluded(mapped.start[at]);
  const normalizedAt = findAllowed(mapped.text, normalizedQuote, acceptMapped);
  if (normalizedAt >= 0) {
    const span = spanOf(sourceText, mapped, normalizedAt, normalizedQuote.length);
    if (span) return { status: "normalized", ...span };
  }

  const fuzzyAt = latinFuzzyIndex(mapped.text, normalizedQuote, acceptMapped);
  if (fuzzyAt >= 0) {
    const span = spanOf(sourceText, mapped, fuzzyAt, normalizedQuote.length);
    if (span) return { status: "latin_fuzzy", ...span };
  }
  return undefined;
}
