export type ControlledSemanticNamespace =
  | "tcm_syndrome"
  | "tcm_location"
  | "tcm_nature"
  | "tcm_treatment_principle"
  | "tcm_formula"
  | "medicine_clinical_concept"
  | "icd10";

export type ControlledSemanticCandidate = {
  id: string;
  canonical: string;
  aliases: readonly string[];
  metadata?: Readonly<Record<string, string>>;
};

export type ControlledSemanticTarget = {
  key: string;
  namespace: ControlledSemanticNamespace;
  fieldPath: string;
  input: string;
  candidates: ControlledSemanticCandidate[];
};

export type ControlledSemanticDecision = {
  key: string;
  candidateId: string | null;
  confidence: number;
};

export type ControlledTerminologyMapping = {
  namespace: ControlledSemanticNamespace;
  fieldPath: string;
  originalText: string;
  candidateId: string;
  canonical: string;
  resolvedBy: "deepseek_closed_set";
  status: "suggested" | "clinician_confirmed";
  confidence: number;
  model: string;
  consensus: true;
  cache: "hit" | "miss";
};

const TERM_PUNCTUATION = /[\s，,。.!！?？；;：:、（）()【】\[\]《》"'“”‘’_\-/\\]+/g;

export function normalizeControlledSemanticText(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(TERM_PUNCTUATION, "").toLowerCase().trim()
    : "";
}

function characterSet(value: string): Set<string> {
  return new Set([...value]);
}

function ngrams(value: string, width: number): Set<string> {
  if (!value) return new Set();
  if (value.length <= width) return new Set([value]);
  return new Set(Array.from({ length: value.length - width + 1 }, (_, index) =>
    value.slice(index, index + width)));
}

function dice(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const value of left) if (right.has(value)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

function lexicalCandidateScore(input: string, candidate: ControlledSemanticCandidate): number {
  const values = [candidate.canonical, ...candidate.aliases]
    .map(normalizeControlledSemanticText)
    .filter(Boolean);
  let best = 0;
  for (const value of values) {
    if (value === input) return 100;
    const containment = value.includes(input) || input.includes(value)
      ? Math.min(value.length, input.length) / Math.max(value.length, input.length)
      : 0;
    const charDice = dice(characterSet(input), characterSet(value));
    const bigramDice = dice(ngrams(input, 2), ngrams(value, 2));
    const prefixSuffix = Number(input[0] === value[0]) * 0.25 +
      Number(input.at(-1) === value.at(-1)) * 0.25;
    best = Math.max(best, containment * 8 + bigramDice * 6 + charDice * 3 + prefixSuffix);
  }
  return best;
}

/**
 * This is only a generic shortlist algorithm. It does not decide clinical meaning and contains no
 * syndrome-specific keyword patches. The model can choose only from the returned closed set.
 */
export function prefilterControlledSemanticCandidates(
  inputValue: unknown,
  candidates: readonly ControlledSemanticCandidate[],
  limit = 24,
): ControlledSemanticCandidate[] {
  const input = normalizeControlledSemanticText(inputValue);
  if (!input) return [];
  return candidates
    .map((candidate) => ({ candidate, score: lexicalCandidateScore(input, candidate) }))
    .sort((left, right) =>
      right.score - left.score ||
      left.candidate.canonical.localeCompare(right.candidate.canonical) ||
      left.candidate.id.localeCompare(right.candidate.id))
    .slice(0, Math.max(1, limit))
    .map((item) => item.candidate);
}

export function validatedConsensusDecision(
  target: ControlledSemanticTarget,
  first: ControlledSemanticDecision | undefined,
  second: ControlledSemanticDecision | undefined,
  minimumConfidence = 0.8,
): { candidate: ControlledSemanticCandidate; confidence: number } | undefined {
  if (!first || !second || first.key !== target.key || second.key !== target.key) return undefined;
  if (!first.candidateId || first.candidateId !== second.candidateId) return undefined;
  if (!Number.isFinite(first.confidence) || !Number.isFinite(second.confidence)) return undefined;
  const confidence = Math.min(first.confidence, second.confidence);
  if (confidence < minimumConfidence) return undefined;
  const candidate = target.candidates.find((item) => item.id === first.candidateId);
  return candidate ? { candidate, confidence: Math.min(1, Math.max(0, confidence)) } : undefined;
}
