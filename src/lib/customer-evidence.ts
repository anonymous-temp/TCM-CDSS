const LABELED_EVIDENCE_LINE = /^(\s*(?:[-*]\s*)?(?:\*\*)?(?:证据依据|来源依据|参考依据|引用来源|方剂出处或依据|经典方出处|方剂资料收载来源|药典依据)(?:\*\*)?\s*[：:])\s*(.*?)\s*$/;
const INTERNAL_PLACEHOLDER = /(?:待检索|待核验|证据不足|检索失败|未配置|内部证据缺口|来源机构未明|年份未明|摘要未提供)/;
const EVIDENCE_COLUMN = /^(?:证据依据|来源依据|参考依据|引用来源|证据支持|方剂出处或依据|经典方出处|方剂资料收载来源|药典依据|依据)$/;
const AUTOMATION_ARTIFACT = /(?:Playwright\s+structured\s+V2\s+probe|Playwright\s+probe|自动化测试探针|回归测试结构化(?:药味|病机|候选方)?)/gi;

export type CustomerEvidenceDisplayStatus = "traceable" | "hidden";

const CUSTOMER_REFERENCE_LEVELS = new Set([
  "kb_entry",
  "guideline",
  "instruction",
  "drug_label",
  "literature",
  "classic_text",
]);

function hasTraceableReferenceSource(source: string): boolean {
  return /(?:\[[A-Z][A-Z0-9_-]{2,}\]|《[^》]{2,}》|https?:\/\/|\b(?:DOI|PMID)\b|(?:药品)?说明书|批准文号|药品标签|指南|共识|文献|药典)/i.test(source);
}

export function customerEvidenceDisplayStatus(evidence: unknown): CustomerEvidenceDisplayStatus {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return "hidden";
  const raw = evidence as Record<string, unknown>;
  if (raw.evidenceLevel === "insufficient") return "hidden";
  const source = typeof raw.source === "string" ? raw.source.trim() : "";
  const level = typeof raw.evidenceLevel === "string" ? raw.evidenceLevel.trim() : "";
  // Patient facts, deterministic rules and model inference are part of the reasoning trail, not
  // external references. Calling them “参考依据” makes an internal inference look like a guideline
  // or publication. Only traceable knowledge-base, classic-text, guideline, label or literature
  // records are customer-visible references.
  return source &&
    CUSTOMER_REFERENCE_LEVELS.has(level) &&
    !INTERNAL_PLACEHOLDER.test(source) &&
    hasTraceableReferenceSource(source)
    ? "traceable"
    : "hidden";
}

function scrubAutomationArtifactValue(value: unknown): unknown {
  if (typeof value === "string") return value.replace(AUTOMATION_ARTIFACT, "").trim();
  if (Array.isArray(value)) return value.map(scrubAutomationArtifactValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, scrubAutomationArtifactValue(item)]));
}

export function sanitizeCustomerEvidenceNarrative(content: string): string {
  return content
    .replace(/^.*(?:Playwright\s+structured\s+V2\s+probe|Playwright\s+probe|自动化测试探针|回归测试结构化(?:药味|病机|候选方)?).*$/gim, "")
    .replace(/本(?:加减|组方)思路[^。；\n]{0,30}(?:证据不足|待检索)[^。；\n]*(?:[。；]|$)/g, "本加减思路需由医生结合本例病机与已核验资料复核。")
    .replace(/^.*(?:内部检索状态|AUTO_PARSED_NEEDS_REVIEW).*$/gm, "")
    .replace(/(?:证据不足\s*[/／]?\s*待检索|依据待检索|引用待检索|证据来源待核验|证据URL待核验|内部证据缺口|检索失败|未配置|来源机构未明|年份未明|摘要未提供)/g, "")
    .replace(/^.*(?:证据依据|来源依据|参考依据|引用来源|方剂出处或依据|药典依据)[^\n]*2020[^\n]*$/gm, "")
    .replace(/(?:《?中华人民共和国药典》?|中国药典)[^|；。\n]{0,30}2020[^|；。\n]*/g, "历史药典规则基线（不作为现行药典核验结论）")
    .replace(/<!--\s*EVIDENCE_GAP:[^>]+-->/g, "")
    .replace(/[，,；;：:]\s*(?=[，,；;。\n])/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

export function sanitizeCustomerEvidenceDocument(content: string): string {
  const blockPattern = /<!-- DIAGNOSIS_JSON_START -->[\s\S]*?<!-- DIAGNOSIS_JSON_END -->/g;
  let output = "";
  let cursor = 0;
  for (const match of content.matchAll(blockPattern)) {
    const start = match.index || 0;
    output += sanitizeCustomerEvidenceNarrative(content.slice(cursor, start));
    try {
      const jsonText = match[0]
        .replace(/^<!-- DIAGNOSIS_JSON_START -->\s*/, "")
        .replace(/\s*<!-- DIAGNOSIS_JSON_END -->$/, "");
      const scrubbed = scrubAutomationArtifactValue(JSON.parse(jsonText));
      output += `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(scrubbed, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
    } catch {
      output += match[0];
    }
    cursor = start + match[0].length;
  }
  return output + sanitizeCustomerEvidenceNarrative(content.slice(cursor));
}

export function sanitizeInlineEvidenceClaims(
  content: string,
  sourceAllowed: (source: string) => boolean,
): string {
  return content
    .replace(
      /(?:本方案|本方|该方|此方)?\s*(?:依据|根据|参照|来源于|出自|源自|载于|见于|收载于)\s*(《[^》]{2,100}》(?:\s*\d{4}年?)?)(?:[^。；;\n]{0,12}(?:推荐|指出|认为|提示|证实|支持|记载|收载))?[：:，,]?/g,
      (claim, source: string) => sourceAllowed(source) ? claim : "",
    )
    .replace(
      /(《[^》]{2,100}》(?:\s*\d{4}年?)?)([^。；;\n]{0,16}(?:推荐|指出|认为|提示|证实|支持|记载|收载|载有|见载))/g,
      (claim, source: string) => sourceAllowed(source) ? claim : "",
    )
    .replace(
      /(?:本方案|本方|该方案|上述方案)?(?:已|得到|获得|获)?\s*(?:\d{4}年?)?[^。；;\n]{0,18}(?:某|相关|权威)?(?:研究|指南|共识|文献)[^。；;\n]{0,18}(?:证实|支持|推荐|证明)[^。；;\n]*(?:[。；;]|$)/g,
      (claim) => /《[^》]+》|\[[A-Z][A-Z0-9_-]+\]/.test(claim) ? claim : "",
    );
}

export function sanitizeUnverifiedClinicalNarrative(content: string): string {
  const decoded = content
    .replace(/&amp;(?=#(?:x300a|x300b|12298|12299);)/gi, "&")
    .replace(/(?:&#x300a;|&#12298;|&lang;)/gi, "《")
    .replace(/(?:&#x300b;|&#12299;|&rang;)/gi, "》");
  return sanitizeInlineEvidenceClaims(decoded, () => false)
    .replace(/(?:本方案|本方|该方|此方)?\s*(?:古籍出处|方剂出处|出处|原载|收录于|所据古籍(?:为)?)\s*[：:]?\s*《[^》]{1,100}》(?:\s*\d{4}年?)?/g, "")
    .replace(/(?:^|[；;，,。])\s*(?:本方案|本方|该方|此方)?\s*(?:古籍出处|方剂出处|出处(?:为)?|原载|收录于|所据古籍(?:为)?)[^；;，,。\n]{0,120}(?=$|[；;，,。\n])/g, "$1")
    .replace(/《[^》]{1,100}》(?:\s*\d{4}年?)?/g, "")
    .replace(/(?:^|[；;，,。])\s*(?:本方案|本方|该方|此方)\s*(?=[；;，,。]|$)/g, "$1")
    .replace(/[；;，,：:]\s*(?=[；;，,。]|$)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function sanitizeEvidenceTableCells(content: string, sourceAllowed: (source: string) => boolean): string {
  const lines = content.split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].includes("|") || !isTableSeparator(lines[index + 1])) continue;
    const headers = tableCells(lines[index]).map((cell) => cell.replace(/\*\*/g, "").trim());
    const evidenceIndexes = headers.map((header, cellIndex) => EVIDENCE_COLUMN.test(header) ? cellIndex : -1).filter((cellIndex) => cellIndex >= 0);
    if (evidenceIndexes.length === 0) continue;
    for (let rowIndex = index + 2; rowIndex < lines.length && lines[rowIndex].includes("|"); rowIndex += 1) {
      const cells = tableCells(lines[rowIndex]);
      for (const evidenceIndex of evidenceIndexes) {
        const source = (cells[evidenceIndex] || "").replace(/\*\*/g, "").trim();
        if (!source || INTERNAL_PLACEHOLDER.test(source) || !sourceAllowed(source)) cells[evidenceIndex] = "";
      }
      lines[rowIndex] = `| ${cells.join(" | ")} |`;
    }
  }
  return lines.join("\n");
}

export function sanitizeLabeledEvidenceLines(
  content: string,
  sourceAllowed: (source: string) => boolean,
): string {
  return sanitizeCustomerEvidenceDocument(sanitizeEvidenceTableCells(content, sourceAllowed)
    .split("\n")
    .map((line) => {
      const match = line.match(LABELED_EVIDENCE_LINE);
      if (!match) return line;
      const source = match[2].replace(/^\[|\]$/g, "").trim();
      if (!source || INTERNAL_PLACEHOLDER.test(source) || !sourceAllowed(source)) return "";
      return line;
    })
    .join("\n"));
}
