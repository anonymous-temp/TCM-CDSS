import governedFormulaJson from "../data/tcm-formula-governed-catalog.json" with { type: "json" };
import retrievalConceptJson from "../data/tcm-formula-retrieval-concepts.json" with { type: "json" };
import retrievalIndexJson from "../data/tcm-formula-retrieval-index.json" with { type: "json" };
import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { affirmedClinicalText, type AssistedNegationClauses } from "./clinical-polarity";
import { canonicalTcmLocationTerm, canonicalTcmNatureTerm, canonicalTcmSyndromeTerm, governedTcmTermLabelById } from "./clinical-governance-tables";
import { syndromeHypothesesFromAffirmedText } from "./tcm-syndrome-hypothesis";

type FormulaIndicationEntry = {
  id: string;
  name: string;
  aliases: string[];
  source: string;
  ingredients: string[];
  catalog: "official_classic_catalog" | "verified_reference_catalog" | "official_local_formula_standard" | "evidence_adjudicated_identity";
  indications: string[];
  syndromeTags: string[];
  curatedSyndromeTags: string[];
  curatedSyndromeRelations: CuratedSyndromeRelation[];
  natureTags: string[];
  locationTags: string[];
  symptomTags: string[];
  diseaseTags: string[];
  retrievalEligible: boolean;
  identityLockEligible: boolean;
  prescriptionLockEligible: boolean;
  governanceStatus: string;
  blockingReasons: string[];
};

export type FormulaIndicationCandidate = FormulaIndicationEntry & {
  matchedConcepts: string[];
  matchedPatientFacts: string[];
  /** 排序分：检索证据 + 治理加权。仅用于排序与展示。 */
  score: number;
  /** 准入分：只含检索证据本身，不含治理加权。候选准入只看这个，治理裁定不得充当入场券。 */
  evidenceScore: number;
  directPrimarySyndromeMatch?: boolean;
  positiveSufficiency?: boolean;
  positiveSufficiencyBasis?: string;
};

type CuratedSyndromeRelation = {
  syndromeId: string;
  syndrome: string;
  fit: "primary" | "differential";
  therapyTerms: string[];
  discriminator?: string;
  sourceRefs: string[];
};

type ClinicalConcept = {
  id: string;
  key: string;
  patient: RegExp;
  indication: RegExp;
  weight: number;
};

type ClinicalConceptRow = { id: string; key: string; patientPattern: string; indicationPattern: string; weight: number };

// T8's data-owned synonym bridge recalls cards; it never diagnoses or authorizes a dose.
const CLINICAL_CONCEPTS: readonly ClinicalConcept[] = (
  retrievalConceptJson.entries as readonly ClinicalConceptRow[]
).map((entry) => ({
  id: entry.id,
  key: entry.key,
  patient: new RegExp(entry.patientPattern),
  indication: new RegExp(entry.indicationPattern),
  weight: entry.weight,
}));

type GovernedFormulaRow = {
  id: string;
  name: string;
  aliases?: string[];
  source: string;
  ingredients: string[];
  sourceClass: FormulaIndicationEntry["catalog"];
  indications: string[];
  syndromeTags: string[];
  curatedSyndromeTags?: string[];
  curatedSyndromeRelations?: CuratedSyndromeRelation[];
  natureTags: string[];
  locationTags: string[];
  symptomTags: string[];
  diseaseTags: string[];
  retrievalEligible: boolean;
  identityLockEligible: boolean;
  prescriptionLockEligible: boolean;
  governanceStatus: string;
  blockingReasons: string[];
};

const governedCatalog = governedFormulaJson as unknown as {
  entries: GovernedFormulaRow[];
};

/** T8 is the sole formula retrieval universe; historical same-name variants never enter here. */
const ENTRIES: readonly FormulaIndicationEntry[] = governedCatalog.entries
  .filter((entry) => entry.retrievalEligible)
  .map((entry) => ({
    id: entry.id,
    name: entry.name,
    aliases: entry.aliases || [],
    source: entry.source,
    ingredients: entry.ingredients,
    catalog: entry.sourceClass,
    indications: entry.indications,
    syndromeTags: entry.syndromeTags,
    curatedSyndromeTags: entry.curatedSyndromeTags || [],
    curatedSyndromeRelations: entry.curatedSyndromeRelations || [],
    natureTags: entry.natureTags,
    locationTags: entry.locationTags,
    symptomTags: entry.symptomTags,
    diseaseTags: entry.diseaseTags,
    retrievalEligible: entry.retrievalEligible,
    identityLockEligible: entry.identityLockEligible,
    prescriptionLockEligible: entry.prescriptionLockEligible,
    governanceStatus: entry.governanceStatus,
    blockingReasons: entry.blockingReasons,
  }));
const ENTRY_BY_ID = new Map(ENTRIES.map((entry) => [entry.id, entry] as const));
type FormulaRetrievalIndex = {
  indexes: {
    conceptToFormulaIds: Record<string, string[]>;
    syndromeToFormulaIds: Record<string, string[]>;
    natureToFormulaIds: Record<string, string[]>;
    locationToFormulaIds: Record<string, string[]>;
    symptomToFormulaIds: Record<string, string[]>;
    diseaseToFormulaIds: Record<string, string[]>;
  };
};
const RETRIEVAL_INDEX = (retrievalIndexJson as FormulaRetrievalIndex).indexes;

function indexedEntries(ids: Iterable<string>): FormulaIndicationEntry[] {
  return [...new Set(ids)].flatMap((id) => {
    const entry = ENTRY_BY_ID.get(id);
    return entry ? [entry] : [];
  });
}

/**
 * 主治原文倒排索引：让检索直接使用受控目录自带的主治文本，而不是只走 39 条手写概念正则。
 *
 * 此前 pre-generation 短名单的全部临床词汇就是 tcm-formula-retrieval-concepts 的 39 条正则，
 * 命中不到就返回「未命中受控经典方主治索引」，模型一个方也拿不到。实测腰痛、耳鸣、水肿、消渴、
 * 关节痛这些门诊常见主诉全部为零候选——但这 500 个方剂**每一条都带主治原文**，其中
 * 腰痛命中五子衍宗丸/青娥丸、水肿命中五苓散/济生肾气丸、消渴命中金匮肾气丸。数据一直都在，
 * 只是被概念层挡掉了。概念表永远穷举不完临床用语，所以召回不能只挂在它上面。
 *
 * 词条来自主治原文本身（已是受控临床用语），不是从病历自由文本里切词，避免切出无意义片段。
 * 文档频率加权：出现在大量方剂里的词（如"不足""无力"）几乎没有鉴别力，权重随 df 衰减；
 * 覆盖面超过 COMMON_TERM_DF_RATIO 的词直接不进索引。
 */
const INDICATION_TERM_MIN_LENGTH = 2;
const INDICATION_TERM_MAX_LENGTH = 4;
/** 出现在超过这一比例方剂主治里的词没有鉴别力，不建索引。 */
const COMMON_TERM_DF_RATIO = 0.08;

/**
 * 证候假设路的权重与每假设取方上限。
 * 权重定得与词面证据同量级：这一路本来就比字面重合更有鉴别力（它比对的是证候而非词），
 * 压得太低等于白接；但也不能压过词面证据，否则一个宽泛证候假设就能盖过方证精确对应。
 * 上限存在的理由：证候→方分布长尾且被粗词占据，「风寒」一个证候挂了 58 首，
 * 不设限一次命中就灌满候选池。
 *
 * 权重 3.0 是在三个黄金病例上实测扫出来的拐点（1.6/3.0/4.5/6.0）：
 *   1.6 太低——肝火病例完全不动，二至丸（肝肾阴虚，治疗方向相反）仍居首；
 *   3.0 三例方向全对——归脾汤 #1、泻青丸+当归龙荟丸（清肝泻火）居前、桂枝汤 #1；
 *   6.0 开始过冲——证候路压过词面证据，风寒例灌入消风百解散这类冷僻方。
 * ★ 这是在三个病例上调出来的常数，样本很小，有过拟合风险。验收口径是**治疗方向是否正确**，
 *   不是某一首方是否精确命中——这只是给模型推理用的短名单，不是最终答案。
 */
const SYNDROME_PATH_WEIGHT = 3.0;
const SYNDROME_PATH_FORMULAS_PER_HYPOTHESIS = 6;
/** 只有挂得上方的证候才值得当检索假设——受控词表 2050 条里仅 497 条有方。 */
const FORMULA_REACHABLE_SYNDROME_IDS: ReadonlySet<string> = new Set(Object.keys(RETRIEVAL_INDEX.syndromeToFormulaIds || {}));

const CJK_RUN = /[一-龥]{2,}/g;

function indicationTerms(text: string): string[] {
  const terms: string[] = [];
  for (const run of text.match(CJK_RUN) || []) {
    for (let size = INDICATION_TERM_MIN_LENGTH; size <= INDICATION_TERM_MAX_LENGTH; size += 1) {
      for (let start = 0; start + size <= run.length; start += 1) {
        terms.push(run.slice(start, start + size));
      }
    }
  }
  return terms;
}

const INDICATION_TERM_INDEX: ReadonlyMap<string, { ids: ReadonlySet<string>; weight: number }> = (() => {
  const byTerm = new Map<string, Set<string>>();
  for (const entry of ENTRIES) {
    const text = (entry.indications || []).join("；");
    if (!text) continue;
    for (const term of new Set(indicationTerms(text))) {
      const bucket = byTerm.get(term);
      if (bucket) bucket.add(entry.id);
      else byTerm.set(term, new Set([entry.id]));
    }
  }
  const total = Math.max(1, ENTRIES.length);
  const index = new Map<string, { ids: ReadonlySet<string>; weight: number }>();
  for (const [term, ids] of byTerm) {
    const df = ids.size / total;
    if (df > COMMON_TERM_DF_RATIO) continue;
    // 越少见、越长的主治词鉴别力越强；权重压在 0.4–2.0，使其与概念权重（1–2）同量级，
    // 既能独立把零候选病例拉起来，又不会淹没已命中的受控概念。
    const rarity = Math.log(total / Math.max(1, ids.size)) / Math.log(total);
    const lengthBoost = Math.min(1, (term.length - 1) / 3);
    index.set(term, { ids, weight: Math.min(2, 0.4 + rarity * 1.2 + lengthBoost * 0.4) });
  }
  return index;
})();

/** 病历阳性事实命中的主治词 → 方剂加权得分。词条来自受控主治原文，模型与自由文本都不参与。 */
function indicationTermMatches(facts: readonly string[]): Map<string, { score: number; terms: string[] }> {
  const merged = facts.join("；");
  const hits = new Map<string, { score: number; terms: string[] }>();
  if (!merged) return hits;
  const termsById = new Map<string, { term: string; weight: number }[]>();
  for (const [term, { ids, weight }] of INDICATION_TERM_INDEX) {
    if (!merged.includes(term)) continue;
    for (const id of ids) {
      const bucket = termsById.get(id);
      if (bucket) bucket.push({ term, weight });
      else termsById.set(id, [{ term, weight }]);
    }
  }
  // 只给**极大词**计分。索引词是主治原文的 2–4 字滑窗，一句「恶寒发热」会同时产出
  // 恶寒/发热/恶寒发/寒发热/恶寒发热 五条，原实现对每条各加一次权重——一个短语按五条独立证据计。
  // 实测后果：泛症状词多的方（二至丸命中口苦/失眠/多梦）拿到 18.6 分，而方证精确对应的
  // 龙胆泻肝汤只有 4.8 分，词面分把证候路整个压死。
  // 「被其他命中词包含的子串不计」这条规则本来就写在下面的协同度里，只是没用在基础分上——
  // 同一个口径必须两处一致，否则协同度在纠正一件基础分正在制造的事。
  for (const [id, matched] of termsById) {
    const unique = [...new Map(matched.map((item) => [item.term, item])).values()];
    const maximal = unique.filter((item) =>
      !unique.some((other) => other.term !== item.term && other.term.includes(item.term)));
    hits.set(id, {
      score: maximal.reduce((total, item) => total + item.weight, 0),
      terms: maximal.map((item) => item.term),
    });
  }
  return hits;
}

function positiveCaseFacts(caseState: CaseState, assistedNegations?: AssistedNegationClauses): string[] {
  const symptomText = Object.entries(caseState.symptoms || {})
    .map(([key, value]) => {
      const positive = affirmedClinicalText(typeof value === "string" ? value : String(value ?? ""), "affirmed", assistedNegations);
      return positive ? `${key}：${positive}` : undefined;
    })
    .filter((value): value is string => Boolean(value));
  const sources = [
    caseState.chiefComplaint,
    ...symptomText,
    caseState.tongue,
    caseState.pulse,
    caseState.faceNote,
    ...caseState.conversation.filter((item) => item.role === "user").map((item) => item.content),
  ];
  return sources
    .map((value) => affirmedClinicalText(value, "affirmed", assistedNegations))
    .filter((value): value is string => Boolean(value));
}

export function retrieveTcmFormulaIndicationCandidates(
  caseState: CaseState,
  limit = 5,
  recallHint = "",
  assistedNegations?: AssistedNegationClauses,
): FormulaIndicationCandidate[] {
  // 口语否定增补只作用于证据类 scope（见 clinical-polarity 的 AssistedNegationClauses 注释）。
  const facts = positiveCaseFacts(caseState, assistedNegations);
  if (facts.length === 0) return [];
  // recallHint 是口语→标准术语的检索查询（见 formula-recall-normalization.server.ts），
  // 只参与候选召回：它不进入 matchedPatientFacts，不作为患者事实，也不呈现给医生。
  const recallFacts = recallHint.trim() ? [...facts, recallHint.trim()] : facts;
  const caseConcepts = CLINICAL_CONCEPTS.filter((concept) => facts.some((fact) => concept.patient.test(fact)));
  // 概念索引与主治原文倒排索引取并集：概念表覆盖不到的临床用语（腰痛、耳鸣、水肿、消渴…）
  // 由方剂自带的主治文本直接召回。这是纯召回扩展——身份锁仍在下游独立校验主证候关联，
  // 多召回一个候选不会让任何方剂绕过锁。
  const termHits = indicationTermMatches(recallFacts);
  // 第三路召回：证候假设（L1a，确定性，零模型）。
  // 前两路都在比对**字面**——症状串对概念正则、症状串对主治原文。字面重合永远分不清
  // 「失眠属心脾两虚」还是「失眠属肝火扰心」，因为区分它们的信息（便溏 vs 口苦目赤）是一个
  // 证候判断而不是一个词。实测：肝火病例首位召回二至丸（肝肾阴虚，治疗方向相反），
  // 只因二至丸主治里恰好同时出现口苦/失眠/多梦。
  // 这一路把阳性事实映射到病位/病性轴，再按轴一致性取受控证候假设，走既有的
  // syndromeToFormulaIds 索引。**纯并集**：本层无命中时结果与之前完全一致。
  const syndromeHypotheses = syndromeHypothesesFromAffirmedText(
    recallFacts, undefined, FORMULA_REACHABLE_SYNDROME_IDS);
  const hypothesisScoreByFormulaId = new Map<string, number>();
  for (const hypothesis of syndromeHypotheses) {
    // 每个假设只取前若干首，防止「风寒」这类挂了 58 首的粗粒度证候一次灌满候选池。
    for (const id of (RETRIEVAL_INDEX.syndromeToFormulaIds[hypothesis.syndromeId] || []).slice(0, SYNDROME_PATH_FORMULAS_PER_HYPOTHESIS)) {
      hypothesisScoreByFormulaId.set(id, Math.max(hypothesisScoreByFormulaId.get(id) || 0, hypothesis.score));
    }
  }
  const candidates = indexedEntries([
    ...caseConcepts.flatMap((concept) => RETRIEVAL_INDEX.conceptToFormulaIds[concept.id] || []),
    ...termHits.keys(),
    ...hypothesisScoreByFormulaId.keys(),
  ]);
  return candidates.map((entry) => {
    const indicationText = entry.indications.join("；");
    const matched = caseConcepts.filter((concept) =>
      (RETRIEVAL_INDEX.conceptToFormulaIds[concept.id] || []).includes(entry.id));
    const matchedPatientFacts = facts.filter((fact) => matched.some((concept) => concept.patient.test(fact)));
    const rawConceptScore = matched.reduce((total, concept) => total + concept.weight, 0);
    // Focused source indications are more discriminating than encyclopedic paragraphs that happen
    // to mention many common symptoms. This corpus-level density normalization prevents long-text
    // cards from winning merely by surface area without hard-coding any formula name.
    const focusMultiplier = Math.max(1, Math.min(3, 40 / Math.max(12, indicationText.length)));
    // Offer/lock alignment. This pre-generation shortlist is ranked purely on symptom overlap, but
    // the identity lock later requires a direct primary-syndrome relation (see positiveSufficiency
    // below) — a formula with no syndromeTags can never be locked under any input. Measured on the
    // shipped catalog: 264 formulas are offerable here and 86 of them are permanently unlockable, so
    // the model's top pick was regularly stripped and the result degraded to 自拟方 (the reported
    // 心脾两虚 case: 天王补心丹 outranked 归脾汤 on raw symptom overlap alone).
    // Lockable candidates are therefore promoted rather than unlockable ones being hidden: an
    // unlockable formula is still a legitimate comparison reference, it just must not head a list
    // the model is asked to choose from. This adds no formula the retrieval did not already return.
    // Lock eligibility is a RANKING key only, never part of the score: `evidenceScore` alone gates
    // admission (>=2), so no formula whose symptom evidence was too weak to qualify is admitted,
    // and no formula is hidden. Every governance signal below obeys the same split.
    const lockEligible = entry.syndromeTags.length > 0;
    const termHit = termHits.get(entry.id);
    // Governance-adjudicated syndrome alignment (curated relations/tags) is a stronger signal than
    // machine-derived tags: it is what makes the canonical 心脾两虚→归脾汤 mapping outrank a merely
    // symptom-overlapping short-text formula (交泰丸) that happens to be lock-eligible by machine tags.
    const curatedBoost = entry.curatedSyndromeRelations.length > 0 || entry.curatedSyndromeTags.length > 0 ? 2 : 0;
    // 证据协同度：多个互相独立的临床词同时命中，比单个高权重词可信得多。
    // 目录 500→1800 后暴露的实例：消渴病例里只命中「口渴」一个泛词的银翘散，压过了同时命中
    // 「消渴+多饮」的消渴方——泛词权重高是因为它在概念层也命中，而真正对证的方靠的是特异主治词。
    // 实测四个首位正确的病例命中词数均 ≥2，唯一首位错误的只命中 1 词，因此协同度纳入打分有数据支撑。
    // 只放大检索证据本身，不放大 curatedBoost（治理裁定不该被词数稀释或放大）。
    // 只数「极大词」：主治词是 2–4 字滑窗切出来的，一句「神疲食少」会同时产出
    // 神疲食少/神疲食/疲食少/食少 四条，若按四条独立证据计，一个短语就能顶四个不同症状。
    // 被其他命中词包含的子串一律不计入协同度。
    const uniqueTerms = [...new Set(termHit?.terms || [])];
    const maximalTerms = uniqueTerms.filter((term) =>
      !uniqueTerms.some((other) => other !== term && other.includes(term)));
    const distinctEvidence = matched.length + maximalTerms.length;
    const coordinationFactor = 1 + Math.min(0.75, 0.25 * Math.max(0, distinctEvidence - 1));
    // 检索证据分与治理加权必须分开：证据分决定**能不能进候选**，治理加权只决定**排多前**。
    // 合成一个数会让治理裁定变成入场券——curatedBoost 恰好等于准入线 2，于是任何带裁定标签的方
    // 都能零证据入场。首批 241 条证型标签入库后立刻实测到：神应养真丹在「周身不适」下自身证据分
    // 1.31（低于准入线），加权后 3.31 进入候选。这与上方「score alone still gates admission」
    // 的既有不变式直接冲突，且量级会随治理进度增长——治理做得越多，噪声越多。
    // 证候假设路的贡献计入**准入分**：它是真实的检索证据（本例的病位病性轴与该证候一致，
    // 且该证候与该方存在受控关系），不是与本例无关的常数加权——这一点与 curatedBoost 不同。
    const hypothesisScore = (hypothesisScoreByFormulaId.get(entry.id) || 0) * SYNDROME_PATH_WEIGHT;
    const evidenceScore = (rawConceptScore * focusMultiplier + (termHit?.score || 0)) * coordinationFactor +
      hypothesisScore +
      (entry.catalog === "verified_reference_catalog" ? 0.25 : 0);
    const score = evidenceScore + curatedBoost;
    return {
      ...entry,
      evidenceScore,
      matchedConcepts: matched.map((concept) => concept.key),
      matchedIndicationTerms: [...new Set(termHit?.terms || [])]
        .sort((left, right) => right.length - left.length)
        .slice(0, 4),
      matchedPatientFacts: [...new Set(matchedPatientFacts)].slice(0, 3),
      score,
      lockEligible,
    };
  })
    .filter((entry) => entry.evidenceScore >= 2)
    // Lock-eligible formulas sort ahead of the rest, then by score within each group. A formula
    // with no syndromeTags can never satisfy the identity lock's direct primary-syndrome
    // requirement, so if the model picks one it is stripped and the result degrades to 自拟方 —
    // strictly worse for the doctor than a lower-scoring formula the system can actually stand
    // behind. Measured: 86 of the 264 offerable formulas are permanently unlockable, and on the
    // reported 心脾两虚 case 天王补心丹 (阴虚火旺, unlockable, and clinically wrong for 便溏/齿痕/脉细弱)
    // outranked 归脾汤 on raw symptom overlap. Ordering is the whole remedy: unlockable formulas stay
    // in the list as differential references, they just no longer head it.
    .sort((left, right) =>
      Number(right.lockEligible) - Number(left.lockEligible) ||
      right.score - left.score ||
      right.matchedConcepts.length - left.matchedConcepts.length ||
      left.name.localeCompare(right.name))
    .slice(0, Math.max(0, limit));
}

type FormulaReasoningProjection =
  Pick<ClinicalReasoningResultV2, "overview" | "pathogenesis"> &
  Partial<Pick<ClinicalReasoningResultV2, "therapy" | "terminologyMappings">>;

function mappedGovernedIds(
  reasoning: FormulaReasoningProjection,
  namespace: "tcm_syndrome" | "tcm_nature" | "tcm_location",
): string[] {
  return (reasoning.terminologyMappings || [])
    .filter((item) => item.namespace === namespace)
    .map((item) => item.candidateId);
}

function primarySyndromeSemanticMapping(reasoning: FormulaReasoningProjection) {
  return (reasoning.terminologyMappings || []).find((item) =>
    item.namespace === "tcm_syndrome" && item.fieldPath === "overview.primarySyndrome");
}

function governedReasoningTags(reasoning: FormulaReasoningProjection): {
  syndrome: Set<string>;
  nature: Set<string>;
  location: Set<string>;
} {
  const syndromeValues = [
    reasoning.overview.primarySyndrome,
    reasoning.overview.overallPathogenesis,
    ...(reasoning.overview.tcmDifferentials || []).map((item) => item.syndrome),
    ...(reasoning.pathogenesis.chain || []).map((item) => item.pathogenesis),
  ];
  const natureValues = [
    ...(reasoning.pathogenesis.natureDifferentiation?.items || []),
    reasoning.pathogenesis.natureDifferentiation?.rootDeficiency,
    reasoning.pathogenesis.natureDifferentiation?.branchExcess,
  ];
  const locationValues = [
    ...(reasoning.pathogenesis.locationDifferentiation?.items || []),
    ...(reasoning.pathogenesis.locationDifferentiation?.details || []).map((item) => item.location),
  ];
  return {
    syndrome: new Set([
      ...syndromeValues.flatMap((value) => canonicalTcmSyndromeTerm(value)?.id ? [canonicalTcmSyndromeTerm(value)!.id] : []),
      ...mappedGovernedIds(reasoning, "tcm_syndrome"),
    ]),
    nature: new Set([
      ...natureValues.flatMap((value) => canonicalTcmNatureTerm(value)?.id ? [canonicalTcmNatureTerm(value)!.id] : []),
      ...mappedGovernedIds(reasoning, "tcm_nature"),
    ]),
    location: new Set([
      ...locationValues.flatMap((value) => canonicalTcmLocationTerm(value)?.id ? [canonicalTcmLocationTerm(value)!.id] : []),
      ...mappedGovernedIds(reasoning, "tcm_location"),
    ]),
  };
}

/**
 * Post-M03 retrieval may use only the validated structured syndrome/pathogenesis projection. It is
 * intentionally separate from pre-generation retrieval so model conclusions cannot leak backward
 * and masquerade as patient facts.
 */
export function retrieveTcmFormulaCandidatesForReasoning(
  reasoning: FormulaReasoningProjection,
  limit = 5,
): FormulaIndicationCandidate[] {
  const tags = governedReasoningTags(reasoning);
  const deterministicPrimarySyndromeId = canonicalTcmSyndromeTerm(reasoning.overview.primarySyndrome)?.id;
  const semanticPrimaryMapping = primarySyndromeSemanticMapping(reasoning);
  const primarySyndromeId = deterministicPrimarySyndromeId || semanticPrimaryMapping?.candidateId;
  // A semantic miss-recovery mapping is additive retrieval evidence. It cannot silently replace
  // the signed primary syndrome or authorize a named formula until a clinician explicitly confirms
  // it; deterministic canonical/alias resolution retains its existing authority.
  const primarySyndromeIdentityConfirmed = Boolean(
    deterministicPrimarySyndromeId || semanticPrimaryMapping?.status === "clinician_confirmed",
  );
  const reasoningText = [
    reasoning.overview.primarySyndrome,
    reasoning.overview.overallPathogenesis,
    reasoning.pathogenesis.summary,
    ...(reasoning.pathogenesis.chain || []).flatMap((item) => [item.pathogenesis, item.therapyDirection]),
  ].filter(Boolean).join("；");
  const therapyText = [
    reasoning.therapy?.overallPrinciple,
    reasoning.therapy?.overallMethod,
    ...(reasoning.therapy?.subTherapies || []).map((item) => item.therapy),
    ...(reasoning.pathogenesis.chain || []).map((item) => item.therapyDirection),
    ...(reasoning.terminologyMappings || [])
      .filter((item) => item.namespace === "tcm_treatment_principle")
      .map((item) => item.canonical),
  ].filter(Boolean).join("；").replace(/\s+/g, "");
  const reasoningConcepts = CLINICAL_CONCEPTS.filter((concept) => concept.patient.test(reasoningText));
  const candidateIds = [
    ...[...tags.syndrome].flatMap((id) => RETRIEVAL_INDEX.syndromeToFormulaIds[id] || []),
    ...[...tags.nature].flatMap((id) => RETRIEVAL_INDEX.natureToFormulaIds[id] || []),
    ...[...tags.location].flatMap((id) => RETRIEVAL_INDEX.locationToFormulaIds[id] || []),
    ...reasoningConcepts.flatMap((concept) => RETRIEVAL_INDEX.conceptToFormulaIds[concept.id] || []),
  ];
  return indexedEntries(candidateIds).map((entry) => {
    const syndromeMatches = entry.syndromeTags.filter((id) => tags.syndrome.has(id));
    const natureMatches = entry.natureTags.filter((id) => tags.nature.has(id));
    const locationMatches = entry.locationTags.filter((id) => tags.location.has(id));
    const conceptMatches = reasoningConcepts.filter((concept) =>
      (RETRIEVAL_INDEX.conceptToFormulaIds[concept.id] || []).includes(entry.id));
    const directPrimarySyndromeMatch = Boolean(primarySyndromeId && entry.syndromeTags.includes(primarySyndromeId));
    const curatedPrimaryRelation = primarySyndromeId
      ? entry.curatedSyndromeRelations.find((relation) => relation.syndromeId === primarySyndromeId)
      : undefined;
    const curatedTherapySatisfied = Boolean(curatedPrimaryRelation?.therapyTerms.some((term) =>
      therapyText.includes(term.replace(/\s+/g, ""))));
    // A named formula is positively sufficient only when the signed primary syndrome itself has a
    // direct relation. Nature/location-only matches and differential-syndrome matches remain useful
    // for comparison but can never lock a formula identity. Curated high-frequency relations add a
    // second, explicit therapy-alignment requirement.
    const positiveSufficiency = primarySyndromeIdentityConfirmed && directPrimarySyndromeMatch && (
      curatedPrimaryRelation ? curatedTherapySatisfied : true
    );
    const curatedRelationBonus = curatedPrimaryRelation
      ? (curatedPrimaryRelation.fit === "primary" ? 8 : 5) + (curatedTherapySatisfied ? 2 : 0)
      : 0;
    const score = syndromeMatches.length * 6 + natureMatches.length * 2 + locationMatches.length * 1.5 +
      curatedRelationBonus +
      conceptMatches.reduce((total, concept) => total + concept.weight, 0);
    return {
      ...entry,
      matchedConcepts: [
        ...syndromeMatches.map((id) => `证候:${id}`),
        ...natureMatches.map((id) => `病性:${id}`),
        ...locationMatches.map((id) => `病位:${id}`),
        ...conceptMatches.map((item) => item.key),
      ],
      matchedPatientFacts: [],
      score,
      // 此处治理加权与准入分同源：curatedRelationBonus 只在**已签名主证候与该方存在受控关系**时产生，
      // 本身就是一条检索证据；不像症状召回那一路的 curatedBoost 是与本例无关的常数加权。
      evidenceScore: score,
      directPrimarySyndromeMatch,
      positiveSufficiency,
      positiveSufficiencyBasis: positiveSufficiency
        ? curatedPrimaryRelation
          ? `高频证候关系:${curatedPrimaryRelation.syndrome}；治法:${curatedPrimaryRelation.therapyTerms.join("、")}`
          : `方剂主治与主证候精确关系:${governedTcmTermLabelById(primarySyndromeId!) || primarySyndromeId}`
        : directPrimarySyndromeMatch && !primarySyndromeIdentityConfirmed
          ? `闭集语义映射仅用于召回，主证候“${reasoning.overview.primarySyndrome}”映射到“${semanticPrimaryMapping?.canonical || primarySyndromeId}”尚待医生确认`
        : directPrimarySyndromeMatch && curatedPrimaryRelation
          ? `证候关系存在，但已签名治法未命中:${curatedPrimaryRelation.therapyTerms.join("、")}`
          : "仅病性、病位、症状或鉴别证候相关，缺少主证候正向充分性",
    };
  }).filter((entry) => entry.score >= 2)
    .sort((left, right) =>
      Number(right.positiveSufficiency) - Number(left.positiveSufficiency) ||
      right.score - left.score ||
      Number(right.prescriptionLockEligible) - Number(left.prescriptionLockEligible) ||
      left.name.localeCompare(right.name))
    .slice(0, Math.max(0, limit));
}

function renderFormulaCandidates(
  candidates: readonly FormulaIndicationCandidate[],
  phaseLabel: "M03病例事实" | "M03签名证候/病机",
): string[] {
  return candidates.map((candidate) => {
    const curatedSyndromeIds = new Set(candidate.curatedSyndromeTags);
    const governedRelations = [
      ...candidate.syndromeTags.flatMap((id) => {
        const label = governedTcmTermLabelById(id);
        return label ? [`${curatedSyndromeIds.has(id) ? "经核验证候" : "候选证候"}:${label}`] : [];
      }),
      ...candidate.natureTags.map((id) => governedTcmTermLabelById(id)).filter(Boolean).map((label) => `病性:${label}`),
      ...candidate.locationTags.map((id) => governedTcmTermLabelById(id)).filter(Boolean).map((label) => `病位:${label}`),
    ];
    return [
      `- [${candidate.id}] ${candidate.name}｜出处：${candidate.source}`,
      `  基础组成：${candidate.ingredients.join("、")}`,
      `  目录主治：${candidate.indications.join("；").slice(0, 260)}`,
      `  ${phaseLabel}命中：${candidate.matchedConcepts.join("、")}｜事实：${candidate.matchedPatientFacts.join("；") || "由已签名结构化辨证字段精确召回"}`,
      `  T1/T3/T4关联索引：${governedRelations.join("、") || "暂无标准术语关联"}（仅作检索关联，必须结合本例事实临床核对）`,
      ...(phaseLabel === "M03签名证候/病机"
        ? [`  命名方正向充分性：${candidate.positiveSufficiency ? `通过（${candidate.positiveSufficiencyBasis}）` : `不通过（${candidate.positiveSufficiencyBasis}）`}`]
        : []),
      // identityLockEligible 只说明「治理层允许锁定」，不代表本方真能锁上：身份锁要求主证候直接
      // 关联（positiveSufficiency 需 directPrimarySyndromeMatch），而无 syndromeTags 的方剂在任何
      // 输入下都不可能满足。实测 1795 首里 810 首属于此类——卡片若一律写「可锁定」，
      // 模型选中后必被 enforceRetrievedM03FormulaSelection 剥离、结果降级为自拟方，
      // 对医生是负价值。因此这里按**实际可锁定性**呈现，并说明它仍可用于鉴别。
      `  治理状态：${!candidate.identityLockEligible
        ? "仅作检索参考，不得锁定方名或生成剂量"
        : candidate.syndromeTags.length === 0
          ? "尚未建立标准证候关联，本方不可锁定方名；可用于鉴别对比，不得作为最终推荐方"
          : "方剂身份可在方证整体匹配后锁定；剂量仍由M04独立编译并经处方后审方"}`,
    ].join("\n");
  });
}

export function buildTcmFormulaIndicationContext(
  caseState: CaseState,
  limit = 5,
  recallHint = "",
  assistedNegations?: AssistedNegationClauses,
): string {
  const candidates = retrieveTcmFormulaIndicationCandidates(caseState, limit, recallHint, assistedNegations);
  if (candidates.length === 0) {
    return "【M03经典方检索】本例当前阳性事实未命中受控经典方主治索引；可按已锁定病机与治法形成自拟方向，但必须说明未采用经典方是因受控目录无匹配结果。";
  }
  return [
    "【M03经典方检索（受控目录；候选不是自动推荐）】",
    ...renderFormulaCandidates(candidates, "M03病例事实"),
    "选择纪律：逐一核对当前阳性事实、舌脉与核心病机；只有 identityLockEligible 且方证整体匹配者才可在 recommendedFormulaDirection 写入方名。方名身份锁定不等于患者剂量已确定，也不等于处方后审方通过。标记为仅检索的条目只能用于鉴别。候选仅部分匹配或反证明显时不得硬套；全部不匹配时写“按已锁定病机与治法辨证组方”，并说明病例内理由。不得使用候选以外的未受控命名方。",
  ].join("\n");
}

/**
 * The second retrieval phase runs only after M03 has been parsed and validated. It makes the
 * signed syndrome/pathogenesis-to-formula relation visible to M04 without letting M04 invent or
 * replace the formula identity already locked by M03.
 */
export function buildTcmFormulaReasoningContext(
  reasoning: FormulaReasoningProjection | undefined,
  limit = 5,
): string {
  if (!reasoning) return "【M03后方剂精确检索】无已签名结构化辨证结果，未执行证候/病机召回。";
  const candidates = retrieveTcmFormulaCandidatesForReasoning(reasoning, limit);
  if (candidates.length === 0) {
    return "【M03后方剂精确检索】已签名证候/病机未命中 T8 受控关系；M04 只能承接 M03 的自拟方向，不得临时附会命名方。";
  }
  return [
    "【M03后方剂精确检索（T1/T3/T4 → T8；只核对既有选择）】",
    ...renderFormulaCandidates(candidates, "M03签名证候/病机"),
    "承接纪律：只有“命名方正向充分性=通过”的条目才可承接 M03 方名；病性/病位粗粒度命中只能用于鉴别。M04 不得新增、替换或合并 M03 未锁定的方名。若已锁定方未通过正向充分性，必须停止沿用该方名并交回临床复核。",
  ].join("\n");
}

function normalizedFormulaIdentity(value: string): string {
  return value.replace(/\s+/g, "").replace(/(?:加减|化裁)$/, "");
}

/** Recheck a signed M03 formula identity before M04; stale/tampered snapshots fail closed. */
export function namedFormulaPositiveSufficiencyIssue(
  reasoning: unknown,
  formulaNames: readonly string[],
): string | undefined {
  if (formulaNames.length === 0) return undefined;
  const candidates = retrieveTcmFormulaCandidatesForReasoning(
    reasoning as FormulaReasoningProjection,
    ENTRIES.length,
  )
    .filter((entry) => entry.positiveSufficiency);
  const allowed = new Set(candidates.flatMap((entry) =>
    [entry.name, ...entry.aliases].map(normalizedFormulaIdentity)));
  const unsupported = formulaNames.find((name) => !allowed.has(normalizedFormulaIdentity(name)));
  return unsupported ? `named_formula_positive_sufficiency_missing:${unsupported}` : undefined;
}

/**
 * M03 may only lock a classic identity that came from the case-bound shortlist. The catalog-wide
 * normalizer still recognizes names for provenance, but an unrelated recognized name is safely
 * declassified instead of being allowed to steer M04.
 */
export function enforceRetrievedM03FormulaSelection(content: string, allowedNames: readonly string[]): string {
  const preGenerationAllowed = new Set(allowedNames.map((name) => name.replace(/\s+/g, "")));
  const lockEligible = new Set(ENTRIES
    .filter((entry) => entry.identityLockEligible)
    .flatMap((entry) => [entry.name, ...entry.aliases])
    .map((entry) => entry.replace(/\s+/g, "")));
  return content.replace(
    /<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/g,
    (match, jsonText: string) => {
      try {
        const parsed = JSON.parse(jsonText) as {
          stage?: unknown;
          terminologyMappings?: Array<{
            namespace?: unknown;
            fieldPath?: unknown;
            status?: unknown;
          }>;
          overview?: {
            recommendedFormulaDirection?: unknown;
            recommendedFormulaNames?: unknown;
            formulaSelectionMode?: unknown;
            deferredFormulaSelection?: unknown;
          };
        };
        if (parsed.stage !== "diagnose" || !parsed.overview) return match;
        const reasoningAllowed = (() => {
          try {
            return retrieveTcmFormulaCandidatesForReasoning(parsed as unknown as ClinicalReasoningResultV2, 8)
              .filter((entry) => entry.identityLockEligible && entry.positiveSufficiency)
              .flatMap((entry) => [entry.name, ...entry.aliases])
              .map((entry) => entry.replace(/\s+/g, ""));
          } catch {
            return [];
          }
        })();
        // Pre-generation symptom recall controls what the model sees, but cannot prove a formula is
        // sufficient for the signed syndrome. Final identity locking is therefore based solely on
        // the post-M03 positive-sufficiency set.
        void preGenerationAllowed;
        const allowed = new Set(reasoningAllowed.filter((name) => lockEligible.has(name)));
        const names = Array.isArray(parsed.overview.recommendedFormulaNames)
          ? parsed.overview.recommendedFormulaNames.filter((name): name is string => typeof name === "string")
          : [];
        if (names.length === 0 || names.every((name) => allowed.has(name.replace(/\s+/g, "")))) return match;
        const primarySyndromeAwaitingConfirmation = (parsed.terminologyMappings || []).some((item) =>
          item.namespace === "tcm_syndrome" &&
          item.fieldPath === "overview.primarySyndrome" &&
          item.status === "suggested");
        const originalMode = parsed.overview.formulaSelectionMode;
        const originalDirection = parsed.overview.recommendedFormulaDirection;
        if (
          primarySyndromeAwaitingConfirmation &&
          typeof originalDirection === "string" &&
          (originalMode === "single" || originalMode === "combined" || originalMode === "alternatives")
        ) {
          // Keep the model's exact pre-confirmation choice inside the signed M03 envelope. A later
          // clinician confirmation may restore only these names, and only after positive
          // sufficiency is recomputed against the confirmed governed syndrome.
          parsed.overview.deferredFormulaSelection = {
            direction: originalDirection,
            names,
            mode: originalMode,
            reason: "semantic_mapping_pending_clinician_confirmation",
          };
        }
        parsed.overview.recommendedFormulaDirection = "按已锁定病机与治法辨证组方";
        parsed.overview.recommendedFormulaNames = [];
        parsed.overview.formulaSelectionMode = "self_devised";
        return `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(parsed, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
      } catch {
        return match;
      }
    },
  );
}
