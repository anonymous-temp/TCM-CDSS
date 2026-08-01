/**
 * Precision-first formula mention extraction for offline evidence/case assets.
 *
 * Two-character catalog names are too ambiguous for free-text substring matching
 * (for example 痰饮 is also a syndrome, and 黄汤 is contained in 麻黄汤). Longer
 * matches suppress only occurrences they actually contain, so a separate explicit
 * mention of 半夏汤 is still retained beside 甘遂半夏汤.
 */
export function compileFormulaMentionMatcher(formulaNames, limit = 12) {
  const names = [...new Set(formulaNames)]
    .filter((name) => typeof name === "string" && [...name].length >= 3)
    // Array#sort is stable: keep the catalog/alias precedence for equal-length names.
    .sort((left, right) => right.length - left.length);
  return (text) => {
    const source = String(text || "");
    if (!source || limit <= 0) return [];
    const acceptedOccurrences = [];
    const acceptedNames = [];
    const seenNames = new Set();

    for (const name of names) {
      let start = source.indexOf(name);
      while (start >= 0) {
        const end = start + name.length;
        const containedByLongerOccurrence = acceptedOccurrences.some((occurrence) =>
          occurrence.start <= start &&
          occurrence.end >= end &&
          occurrence.end - occurrence.start > end - start);
        if (!containedByLongerOccurrence) {
          acceptedOccurrences.push({ start, end });
          if (!seenNames.has(name)) {
            seenNames.add(name);
            acceptedNames.push(name);
            if (acceptedNames.length >= limit) return acceptedNames;
          }
        }
        start = source.indexOf(name, start + name.length);
      }
    }
    return acceptedNames;
  };
}

export function formulaMentionHits(text, formulaNames, limit = 12) {
  return compileFormulaMentionMatcher(formulaNames, limit)(text);
}
