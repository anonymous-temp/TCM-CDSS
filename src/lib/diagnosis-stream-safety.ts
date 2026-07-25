const STRUCTURED_START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";

// Doctor-facing wording is emitted at the substitution site, not translated later. The client
// re-runs this same function on drafts (DiagnosisClient.tsx) and on the deterministic
// `markdownNdjsonResponse` exits, neither of which passes through
// `scrubInternalVocabularyFromVisibleText` — so an internal placeholder minted here reached the
// doctor verbatim. One canonical string removes that whole divergence class.
const DOSE_PLACEHOLDER = "（剂量以审定处方为准）";
const REGIMEN_PLACEHOLDER = "用法与疗程以审定处方为准";

/** Arabic or Chinese quantity: 15 / 1.5 / 一 / 三十 / 两 / 半. */
const QUANTITY = String.raw`(?:\d+(?:\.\d+)?|[一二两三四五六七八九十百半]+)`;
/** Units that only occur in an executable dose — never in a symptom description. */
const DOSE_FORM_UNIT = String.raw`(?:剂|片|粒|丸|袋|支|滴|包|毫升|mL|ml|毫克|mg|微克|μg|mcg|克|g)`;
/** Units that make a course executable. */
const COURSE_UNIT = String.raw`(?:剂|日|天|周|疗程)`;

/**
 * Mask executable dosing, not the vocabulary that surrounds it.
 *
 * A regimen is a *quantity bound to a dose unit* (黄芪15g / 每日1剂 / 连服3剂). The timing and route
 * words on their own — 每日 每次 饭后 睡前 口服 外用 — are ordinary clinical Chinese: "每日腹泻3次",
 * "饭后脘腹胀", "睡前多梦易醒", "既往口服二甲双胍史", "口服葡萄糖耐量试验". Matching those words and
 * swallowing the following clause deleted the clinical finding itself, and inside a markdown table
 * it consumed the `|` delimiters and collapsed the row's columns. Each rule therefore requires a
 * quantity + unit, and replaces only the regimen token rather than a fixed run of following text.
 */
function sanitizeVisibleDiagnoseText(content: string): string {
  return content
    // 1. 药名 + 数量 + 剂量单位（黄芪15g / 阿司匹林100mg）。
    .replace(
      /([一-龥A-Za-z][一-龥A-Za-z·-]{0,15})\s*\d+(?:\.\d+)?\s*(?:微克|毫克|克|μg|mcg|mg|g|mL|ml|片|粒|丸|袋|支|滴)(?![一-龥A-Za-z])/g,
      `$1${DOSE_PLACEHOLDER}`,
    )
    // 2. 给药频次：频次词必须紧邻“数量 + 剂型单位”才构成用法（每日1剂 / 每次2片）。
    //    症状描述在频次词与数量之间隔着症状本身（每日腹泻3次），不再命中。
    .replace(
      new RegExp(String.raw`(?:每日|每天|每晚|每次|一日|早晚|饭前|饭后|睡前)\s*${QUANTITY}\s*${DOSE_FORM_UNIT}`, "g"),
      REGIMEN_PLACEHOLDER,
    )
    // 3. 煎服法：水煎服/煎服/冲服/吞服 只出现在处方用法中，掩码该词本身即可。
    .replace(/水煎服|煎服|冲服|吞服/g, REGIMEN_PLACEHOLDER)
    //    口服/外用 是普通临床用语，只有紧跟“数量 + 剂型单位”时才是用法。
    .replace(
      new RegExp(String.raw`(?:口服|外用)\s*${QUANTITY}\s*${DOSE_FORM_UNIT}`, "g"),
      REGIMEN_PLACEHOLDER,
    )
    // 4. 疗程：服用/疗程/开具/处方 + 数量 + 时间或剂数单位。
    //    临床病程（“症状已持续3天”）不含这些给药动词，保持可见。
    .replace(
      new RegExp(String.raw`(?:(?:连|连续|共|拟|建议)?服用?|疗程(?:为)?|开具|处方)\s*${QUANTITY}\s*${COURSE_UNIT}`, "g"),
      REGIMEN_PLACEHOLDER,
    )
    // 5. 裸剂数（“共5剂”）。连同前置数量词一起替换，避免留下“共…”这样的悬空半句；
    //    只掩码剂数本身，不吞后续临床叙述。
    .replace(
      new RegExp(String.raw`(?:共|连|连续|计)?\s*${QUANTITY}\s*剂(?![型量])`, "g"),
      REGIMEN_PLACEHOLDER,
    )
    // 相邻占位合并，避免同一句里重复出现同一句提示。
    .replace(
      new RegExp(String.raw`${REGIMEN_PLACEHOLDER}(?:[，、,；;\s]*${REGIMEN_PLACEHOLDER})+`, "g"),
      REGIMEN_PLACEHOLDER,
    );
}

/** M03 may stream clinical reasoning, but never an unvalidated executable dose or regimen. */
export function sanitizeDiagnoseStreamingDraft(content: string): string {
  const structuredStart = content.indexOf(STRUCTURED_START_MARKER);
  if (structuredStart < 0) return sanitizeVisibleDiagnoseText(content);
  return `${sanitizeVisibleDiagnoseText(content.slice(0, structuredStart))}${content.slice(structuredStart)}`;
}
