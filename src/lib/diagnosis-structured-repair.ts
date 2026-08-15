const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

const M03_WESTERN_SUPPORT_CONTRACT_REASONS = new Set([
  "m03_western_support_empty",
  "m03_western_support_tcm_pollution",
  "m03_western_support_demographic_padding",
  "m03_western_support_normal_vital_padding",
  "m03_western_support_nondiscriminating",
  "m03_western_support_historical_only",
  "m03_western_support_polarity_mismatch",
]);

export function isM03WesternSupportContractReason(reason: string): boolean {
  return M03_WESTERN_SUPPORT_CONTRACT_REASONS.has(reason);
}

/**
 * Final M04 validation must reuse the same safety-floor scope that admitted a transparent
 * formula-identity declassification. An accepted reviewer may produce no quality annotation, so
 * annotation presence alone cannot prove which validation scope was used earlier in the pipeline.
 */
export function shouldUseM04FinalizeSafetyFloor(
  transparentDeclassificationAccepted: boolean,
  transparentQualityAnnotationPresent: boolean,
): boolean {
  return transparentDeclassificationAccepted || transparentQualityAnnotationPresent;
}

export function shouldRunTargetedStructuredRetry(stage: "diagnose" | "prescribe", reason: string): boolean {
  if (stage === "prescribe") {
    return /^(?:json_invalid|sentinel_count_\d+_\d+|structured_resolver_rejected)$/.test(reason) ||
      /(?:formula_reference|formula_direction|formula_compilation|formula_component_\d+_unverified|m04_proposal|m04_(?:clinical|formula_composition|herb_plan|dose_rationale|patient_context)_semantic_review)/.test(reason) ||
      /^m04_candidate_\d+_high_risk_pair_incompatibility$/.test(reason) ||
      /^m04_candidate_\d+_(?:emperor_(?:missing|excess)|herb_\d+_(?:emperor_(?:not_primary|knowledge_missing|therapy_mismatch)|unknown|dose_outside_conservative_range|special_population_high_risk_[a-z0-9_]+|unsupported_high_impact_[a-z0-9_]+))$/.test(reason) ||
      /^m04_modification_\d+_herb_\d+_unsupported_high_impact_[a-z0-9_]+$/.test(reason);
  }
  return isM03WesternSupportContractReason(reason) ||
    /^(?:json_invalid|sentinel_count_\d+_\d+|structured_resolver_rejected|m03_(?:(?:primary_diagnosis|tcm_reasoning|formula_indication)_semantic_review|(?:primary_syndrome_basis|symptom_cluster)_polarity|clinical_wording_(?:intensity|subjective_objective)_mismatch|pathogenesis_summary_[a-z_]+_drift|(?:heat|cold_yang|phlegm_damp|blood_stasis|yin_deficiency)_decision_ungrounded|patient_fact_ungrounded_.+|chain_(?:empty|incomplete|key_discriminator_missing)|(?:location|nature)_classification_empty|single_evidence_location|nature_dimension_insufficient|discrimination_missing|primary_syndrome_unstable|tcm_syndrome_current_fact_missing|generic_tcm_template|explanation_placeholder|uncertainty_state_mismatch|followup_safety_net_not_actionable|overall_pathogenesis_unstable|therapy(?:_method)?_unstable|western_(?:primary_ambiguous|primary_background_comorbidity|primary_duration_mismatch|diagnosis_unstable|clinical_rationale_(?:missing|restatement)|differential_(?:ambiguous|analysis_missing))|tcm_(?:diagnostic_rationale_(?:missing|restatement)|differential(?:_analysis)?_missing)))$/.test(reason);
}

type BalancedJsonObject = {
  json: string;
  end: number;
  hasBraceInString: boolean;
};

/**
 * Some Chinese models occasionally use a typographic quote for a JSON delimiter while keeping
 * the rest of the object valid. Canonicalize only quotes whose surrounding token position proves
 * that they open or close a JSON key/value. Curly quotes used inside clinical prose remain intact.
 * The result still has to pass JSON.parse, the full reasoning schema, semantic grounding and the
 * stage contract, so this cannot add or reinterpret clinical data.
 */
function normalizeJsonDelimiterQuotes(value: string): string {
  const chars = [...value];
  let inString = false;
  let escaped = false;
  const previousNonWhitespace = (index: number) => {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (!/\s/.test(chars[cursor])) return chars[cursor];
    }
    return "";
  };
  const nextNonWhitespace = (index: number) => {
    for (let cursor = index + 1; cursor < chars.length; cursor += 1) {
      if (!/\s/.test(chars[cursor])) return chars[cursor];
    }
    return "";
  };
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
        continue;
      }
      if (char === "”" && /[:,}\]]/.test(nextNonWhitespace(index))) {
        chars[index] = '"';
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if ((char === "“" || char === "”") && /^(?:|[\[{,:])$/.test(previousNonWhitespace(index))) {
      chars[index] = '"';
      inString = true;
    }
  }
  return chars.join("");
}

function balancedJsonObject(text: string, start: number): BalancedJsonObject | undefined {
  if (text[start] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let hasBraceInString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "{" || char === "}") hasBraceInString = true;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { json: text.slice(start, index + 1), end: index + 1, hasBraceInString };
    }
  }
  return undefined;
}

function markerCount(content: string, marker: string): number {
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(marker, index)) >= 0) {
    count += 1;
    index += marker.length;
  }
  return count;
}

export function enforceStructuredStageOwnership(
  content: string,
  expectedStage: "diagnose" | "prescribe",
): string {
  if (expectedStage !== "diagnose") return content;
  const start = content.lastIndexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const parsed = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as {
      stage?: unknown;
      formula?: unknown;
    };
    if (!parsed || typeof parsed !== "object" || parsed.stage !== "diagnose" || parsed.formula == null) return content;
    // Formula selection and all dose-bearing fields belong to M04. A provider occasionally echoes a
    // formula object while repairing an otherwise valid M03; discard that unauthorized stage field
    // instead of rejecting the whole diagnosis. M03 dose instructions elsewhere remain subject to
    // the semantic contract and cannot be repaired here.
    parsed.formula = null;
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(parsed, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

function repairMissingStructuredStartSentinel(
  content: string,
  expectedStage: "diagnose" | "prescribe",
): string | undefined {
  if (content.includes(START_MARKER) || markerCount(content, END_MARKER) !== 1) return undefined;
  const endMarkerIndex = content.indexOf(END_MARKER);
  if (content.slice(endMarkerIndex + END_MARKER.length).trim()) return undefined;

  const beforeEndMarker = content.slice(0, endMarkerIndex);
  const jsonEnd = beforeEndMarker.trimEnd().length;
  const candidates: Array<{
    start: number;
    balanced: BalancedJsonObject;
    parsed: { schemaVersion?: unknown; stage?: unknown };
  }> = [];

  let searchFrom = beforeEndMarker.length - 1;
  while (searchFrom >= 0) {
    const start = beforeEndMarker.lastIndexOf("{", searchFrom);
    if (start < 0) break;
    searchFrom = start - 1;
    const balanced = balancedJsonObject(beforeEndMarker, start);
    if (!balanced || balanced.end !== jsonEnd) continue;
    try {
      const parsed = JSON.parse(balanced.json) as { schemaVersion?: unknown; stage?: unknown };
      candidates.push({ start, balanced, parsed });
    } catch {
      // A repair candidate must independently parse as one complete JSON object.
    }
  }

  if (candidates.length !== 1) return undefined;
  const [{ start, balanced, parsed }] = candidates;
  if (balanced.hasBraceInString || /[{}]/.test(beforeEndMarker.slice(0, start))) return undefined;
  if (parsed.schemaVersion !== "tcm-cdss-reasoning-v2" || parsed.stage !== expectedStage) return undefined;

  const visiblePrefix = beforeEndMarker.slice(0, start).trim();
  const block = `${START_MARKER}\n${JSON.stringify(parsed, null, 2)}\n${END_MARKER}`;
  return [visiblePrefix, block].filter(Boolean).join("\n\n");
}

export function repairCompletedStructuredSentinel(
  content: string,
  expectedStage: "diagnose" | "prescribe",
): string | undefined {
  const markerIndex = content.lastIndexOf(START_MARKER);
  if (markerIndex < 0) return undefined;
  const visiblePrefix = content.slice(0, markerIndex).trim();
  if (visiblePrefix.includes(START_MARKER)) return undefined;
  const afterMarker = markerIndex + START_MARKER.length;
  const leadingWhitespace = content.slice(afterMarker).match(/^\s*/)?.[0].length ?? 0;
  const normalizedContent = `${content.slice(0, afterMarker + leadingWhitespace)}${normalizeJsonDelimiterQuotes(content.slice(afterMarker + leadingWhitespace))}`;
  const balanced = balancedJsonObject(normalizedContent, afterMarker + leadingWhitespace);
  if (!balanced) return undefined;
  const trailing = normalizedContent.slice(balanced.end).trim();
  if (trailing && !END_MARKER.startsWith(trailing)) return undefined;
  try {
    const parsed = JSON.parse(balanced.json) as { schemaVersion?: unknown; stage?: unknown };
    if (parsed.schemaVersion !== "tcm-cdss-reasoning-v2" || parsed.stage !== expectedStage) return undefined;
    const block = `${START_MARKER}\n${JSON.stringify(parsed, null, 2)}\n${END_MARKER}`;
    return [visiblePrefix, block].filter(Boolean).join("\n\n");
  } catch {
    return undefined;
  }
}

export function resolveCompletedStructuredResponse(
  content: string,
  expectedStage: "diagnose" | "prescribe",
  finishReason: string | null,
): string | undefined {
  if (finishReason !== "stop") return undefined;
  const markerIndex = content.lastIndexOf(START_MARKER);
  if (markerIndex < 0) return repairMissingStructuredStartSentinel(content, expectedStage);
  if (content.slice(0, markerIndex).includes(START_MARKER)) return undefined;
  const endIndex = content.indexOf(END_MARKER, markerIndex + START_MARKER.length);
  if (endIndex < 0) return repairCompletedStructuredSentinel(content, expectedStage);
  if (content.slice(endIndex + END_MARKER.length).trim()) return undefined;
  try {
    const rawJson = content.slice(markerIndex + START_MARKER.length, endIndex).trim();
    const normalizedJson = normalizeJsonDelimiterQuotes(rawJson);
    const parsed = JSON.parse(normalizedJson) as {
      schemaVersion?: unknown;
      stage?: unknown;
    };
    if (parsed.schemaVersion !== "tcm-cdss-reasoning-v2" || parsed.stage !== expectedStage) return undefined;
    if (normalizedJson === rawJson) return content.trim();
    const visiblePrefix = content.slice(0, markerIndex).trim();
    const block = `${START_MARKER}\n${JSON.stringify(parsed, null, 2)}\n${END_MARKER}`;
    return [visiblePrefix, block].filter(Boolean).join("\n\n");
  } catch {
    return undefined;
  }
}
