const STRUCTURED_START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";

function sanitizeVisibleDiagnoseText(content: string): string {
  return content
    .replace(
      /([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z·-]{0,15})\s*\d+(?:\.\d+)?\s*(?:微克|毫克|克|μg|mcg|mg|g|mL|ml|片|粒|丸|袋|支|滴)(?![\u4e00-\u9fa5A-Za-z])/g,
      "$1（剂量信息待候选方药阶段核验）",
    )
    .replace(
      /(?:每日|每天|每晚|每次|一日|早晚|饭前|饭后|睡前)\s*[^。；\n]{0,40}/g,
      "用法与疗程待候选方药阶段核验",
    )
    .replace(
      /(?:水煎服|煎服|冲服|吞服|口服|外用)(?:[^。；\n]{0,40})/g,
      "用法与疗程待候选方药阶段核验",
    )
    .replace(
      /(?:(?:连|连续|共|拟|建议)?服用?|疗程(?:为)?|开具|处方)\s*\d+\s*(?:剂|日|天|周)(?:[^。；\n]{0,20})/g,
      "用法与疗程待候选方药阶段核验",
    )
    .replace(
      /\d+\s*剂(?:[^。；\n]{0,20})/g,
      "疗程待候选方药阶段核验",
    );
}

/** M03 may stream clinical reasoning, but never an unvalidated executable dose or regimen. */
export function sanitizeDiagnoseStreamingDraft(content: string): string {
  const structuredStart = content.indexOf(STRUCTURED_START_MARKER);
  if (structuredStart < 0) return sanitizeVisibleDiagnoseText(content);
  return `${sanitizeVisibleDiagnoseText(content.slice(0, structuredStart))}${content.slice(structuredStart)}`;
}
