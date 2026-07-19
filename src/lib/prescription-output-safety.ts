import { isKnownTcmHerbName } from "./tcm-knowledge";

const PATENT_WESTERN_DOSAGE_FORM = /(片|胶囊|丸|滴丸|颗粒|冲剂|注射液|口服液|散|膏|合剂|糖浆|贴剂|栓剂|喷雾剂|气雾剂|乳膏|凝胶)/;
const CONCRETE_MEDICATION_USAGE = /(?:每日|每天|每次|一日|口服|含服|外用|静滴|静注|肌注|餐前|餐后|睡前|\d+(?:\.\d+)?\s*(?:mg|ml|片|粒|丸|支|袋|次)|[一二三四五六七八九十两]+\s*(?:片|粒|丸|支|袋|次))/i;
const REMOVED_MESSAGE = "该项不是中药饮片，已移至西药/中成药候选区独立审方后另行评估";

function sanitizeHerbTableRow(line: string): string {
  const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
  const herbName = cells[0] || "";
  if (!herbName || /^-+$/.test(herbName) || isKnownTcmHerbName(herbName) || !PATENT_WESTERN_DOSAGE_FORM.test(herbName)) {
    return line;
  }
  const replacements = cells.map((_, index) => index === 0 ? REMOVED_MESSAGE : "-");
  return `| ${replacements.join(" | ")} |`;
}

function sanitizeUnstructuredMedicationLine(line: string): string {
  if (!PATENT_WESTERN_DOSAGE_FORM.test(line) || !CONCRETE_MEDICATION_USAGE.test(line)) return line;
  return REMOVED_MESSAGE;
}

function sanitizeVisiblePrescriptionNarrative(content: string): string {
  let inHerbTable = false;
  return content.split("\n").map((line) => {
    const isTableLine = line.trimStart().startsWith("|");
    if (isTableLine && /药名/.test(line) && /剂量/.test(line) && /(?:炮制|规格|君臣佐使)/.test(line)) {
      inHerbTable = true;
      return line;
    }
    if (!isTableLine) inHerbTable = false;
    return inHerbTable ? sanitizeHerbTableRow(line) : sanitizeUnstructuredMedicationLine(line);
  }).join("\n");
}

export function enforceReviewedPrescriptionOutput(content: string): string {
  const blockPattern = /<!-- DIAGNOSIS_JSON_START -->[\s\S]*?<!-- DIAGNOSIS_JSON_END -->/g;
  let output = "";
  let cursor = 0;
  for (const match of content.matchAll(blockPattern)) {
    const start = match.index || 0;
    output += sanitizeVisiblePrescriptionNarrative(content.slice(cursor, start));
    // The structured proposal has already passed the M04 schema and herb-name contract. Applying
    // line-oriented narrative cleanup inside this JSON can replace one property line (for example a
    // patent-medicine usageBoundary) and corrupt the entire signed stage result.
    output += match[0];
    cursor = start + match[0].length;
  }
  return output + sanitizeVisiblePrescriptionNarrative(content.slice(cursor));
}
