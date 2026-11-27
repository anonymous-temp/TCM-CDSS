import { governedFourCharacterMethodTerms } from "./clinical-governance-tables";
import { splitTextbookDiseaseSubtype, textbookFormulaRowsForDisease, textbookRowCitable, textbookRowForSyndrome, textbookRowProvenance, textbookTherapyItems } from "./tcm-textbook-syndromes";

const termsOf = (value: string) => value.split(/[，,、；;。]/u).map(term => term.trim()).filter(Boolean);
const fourCharacters = (term: string) => /^\p{Script=Han}{4}$/u.test(term);

/** The signed method and the textbook quotation are independent of the display wording. */
export function treatmentMethodDisplay(method: string, disease: string, syndrome: string) {
  const original = termsOf(method);
  if (!original.length) return { text: "", reference: "" };
  const row = textbookRowForSyndrome(disease, syndrome);
  const source = row && row.syndromeName === syndrome && textbookRowCitable(row) ? termsOf(row.therapy) : [];
  const references = new Set<string>();
  const selected = new Set<string>();
  const unresolved: string[] = [];
  const existing = original.filter(fourCharacters);
  const attested = (term: string) => textbookTherapyItems().has(term) || governedFourCharacterMethodTerms().includes(term);

  // When the signed plan already uses four-character items, the book is still
  // cited independently as the reference for this exact disease and syndrome.
  if (row && source.length && (original.every(fourCharacters) || original.some(term => source.includes(term)))) {
    const label = original.some(term => source.includes(term)) ? "" : "本病证教材原文：";
    references.add(label + textbookRowProvenance(row) + "：" + row.therapy);
  }
  if (!source.length && original.every(fourCharacters)) {
    const { disease: chapter, subtype } = splitTextbookDiseaseSubtype(disease);
    const chapterRows = textbookFormulaRowsForDisease(disease).filter(candidate =>
      candidate.disease === chapter && textbookRowCitable(candidate));
    const subtypeRow = subtype && chapterRows.find(candidate => candidate.syndromeName === subtype);
    if (subtypeRow) references.add("本病分型教材原文：" + textbookRowProvenance(subtypeRow) + "：" + subtypeRow.therapy);
    else if (row && chapterRows.some(candidate => candidate.id === row.id) &&
        termsOf(row.therapy).some(term => original.includes(term))) {
      references.add("同病相关证型教材原文：" + textbookRowProvenance(row) + "：" + row.therapy);
      const additional = original.filter(term => !termsOf(row.therapy).includes(term));
      if (additional.length) references.add("本例辨证另取" + additional.join("、") + "，该项未见于上述原文");
    }
  }
  for (const term of original) {
    if (fourCharacters(term)) {
      selected.add(term);
      continue;
    }
    // Retain each original two-character concept. Only attested terms can be used.
    if (source.includes(term) && /^\p{Script=Han}{6}$/u.test(term)) {
      const units = [term.slice(0, 2), term.slice(2, 4), term.slice(4)];
      const candidates = [units[0] + units[1], units[1] + units[2], units[0] + units[2]].filter(attested);
      const pairs = candidates.flatMap((part, i) => candidates.slice(i + 1).map(tail => [part, tail]));
      const options = [...candidates.map(part => [part]), ...pairs];
      const parts = options.find(parts => {
        const display = new Set([...existing, ...selected, ...parts]);
        return display.size <= 3 && units.every(unit =>
          [...display].some(part => part.startsWith(unit) || part.endsWith(unit)));
      });
      if (parts) {
        for (const part of parts) selected.add(part);
        continue;
      }
    }
    unresolved.push(term);
  }
  // 拆不成四字、或拆后超过三项时照原文呈现：正文不出现「待核」之类的流程用语。
  if (unresolved.length || selected.size > 3) return { text: original.join("，"), reference: [...references].join("；") };
  return { text: [...selected].join("，"), reference: [...references].join("；") };
}
