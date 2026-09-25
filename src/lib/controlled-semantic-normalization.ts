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
  /** 仅 2026-09-20 之前的两次一致映射携带；单次调用起不再输出，保留为可选以兼容已签名的旧载荷。 */
  consensus?: true;
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

type PreparedCandidateValue = { text: string; chars: Set<string>; bigrams: Set<string> };

// 候选词表是模块级常量（数千条），此前每次预筛都对每个候选的每个别名重算归一化、字集与二元组，
// 生产 M03 的术语归一相位因此有约 1–2s 纯 CPU（2026-09-25 cpu-prof：ngrams/characterSet/dice
// 占该相位绝大部分，模型调用本身只有 ~0.9s）。按候选对象缓存预处理结果，打分公式与排序逐字不变。
const preparedCandidateValues = new WeakMap<ControlledSemanticCandidate, PreparedCandidateValue[]>();

function preparedValues(candidate: ControlledSemanticCandidate): PreparedCandidateValue[] {
  let prepared = preparedCandidateValues.get(candidate);
  if (!prepared) {
    prepared = [candidate.canonical, ...candidate.aliases]
      .map(normalizeControlledSemanticText)
      .filter(Boolean)
      .map((text) => ({ text, chars: characterSet(text), bigrams: ngrams(text, 2) }));
    preparedCandidateValues.set(candidate, prepared);
  }
  return prepared;
}

function lexicalCandidateScore(
  input: string,
  inputChars: Set<string>,
  inputBigrams: Set<string>,
  candidate: ControlledSemanticCandidate,
): number {
  let best = 0;
  for (const value of preparedValues(candidate)) {
    if (value.text === input) return 100;
    const containment = value.text.includes(input) || input.includes(value.text)
      ? Math.min(value.text.length, input.length) / Math.max(value.text.length, input.length)
      : 0;
    const charDice = dice(inputChars, value.chars);
    const bigramDice = dice(inputBigrams, value.bigrams);
    const prefixSuffix = Number(input[0] === value.text[0]) * 0.25 +
      Number(input.at(-1) === value.text.at(-1)) * 0.25;
    best = Math.max(best, containment * 8 + bigramDice * 6 + charDice * 3 + prefixSuffix);
  }
  return best;
}

function compareByCanonicalThenId(left: ControlledSemanticCandidate, right: ControlledSemanticCandidate): number {
  return left.canonical.localeCompare(right.canonical) || left.id.localeCompare(right.id);
}

// 同分项的相对顺序只取决于 canonical/id，与输入无关——按词表数组缓存一次排好的次序与名次，
// 排序时用整数名次代替逐对 localeCompare（原实现对几千个同分/近同分项逐对 localeCompare）。
// 名次取自同一比较器的稳定排序，故与原排序逐项一致（含 canonical/id 完全相同的项保持原相对次序）。
const tieOrderCache = new WeakMap<readonly ControlledSemanticCandidate[], {
  ordered: ControlledSemanticCandidate[];
  rank: Map<ControlledSemanticCandidate, number>;
}>();

function tieOrder(candidates: readonly ControlledSemanticCandidate[]) {
  let cached = tieOrderCache.get(candidates);
  if (!cached) {
    const ordered = [...candidates].sort(compareByCanonicalThenId);
    const rank = new Map<ControlledSemanticCandidate, number>();
    ordered.forEach((candidate, index) => {
      if (!rank.has(candidate)) rank.set(candidate, index);
    });
    cached = { ordered, rank };
    tieOrderCache.set(candidates, cached);
  }
  return cached;
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
  const size = Math.max(1, limit);
  const inputChars = characterSet(input);
  const inputBigrams = ngrams(input, 2);
  const scored: Array<{ candidate: ControlledSemanticCandidate; score: number }> = [];
  const zeroScored = new Set<ControlledSemanticCandidate>();
  for (const candidate of candidates) {
    const score = lexicalCandidateScore(input, inputChars, inputBigrams, candidate);
    if (score > 0) scored.push({ candidate, score });
    else zeroScored.add(candidate);
  }
  const { ordered, rank } = tieOrder(candidates);
  scored.sort((left, right) =>
    right.score - left.score || (rank.get(left.candidate) ?? 0) - (rank.get(right.candidate) ?? 0));
  const shortlist = scored.slice(0, size).map((item) => item.candidate);
  if (shortlist.length >= size) return shortlist;
  // 正分不足 limit 时按原算法用零分项补齐：它们在原排序里排在所有正分之后、彼此按 canonical/id。
  for (const candidate of ordered) {
    if (shortlist.length >= size) break;
    if (zeroScored.has(candidate)) shortlist.push(candidate);
  }
  return shortlist;
}

/**
 * 单次闭集映射的受理判据（2026-09-20 起取代两次一致共识：同一提示词、同一模型、temperature 0
 * 连发两遍只是同一张彩票再买一次）。仍然守住三条：候选必须来自服务端预筛的闭集、置信度不低于
 * 下限、模型弃权（candidateId=null）不形成映射。映射只是待医生确认的召回建议，不静默替换签名结论。
 */
export function validatedClosedSetDecision(
  target: ControlledSemanticTarget,
  decision: ControlledSemanticDecision | undefined,
  minimumConfidence = 0.8,
): { candidate: ControlledSemanticCandidate; confidence: number } | undefined {
  if (!decision || decision.key !== target.key || !decision.candidateId) return undefined;
  if (!Number.isFinite(decision.confidence) || decision.confidence < minimumConfidence) return undefined;
  const candidate = target.candidates.find((item) => item.id === decision.candidateId);
  return candidate ? { candidate, confidence: Math.min(1, Math.max(0, decision.confidence)) } : undefined;
}
