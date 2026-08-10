import governedFormulaJson from "../data/tcm-formula-governed-catalog.json" with { type: "json" };
import modernCaseFormulaIndexJson from "../data/tcm-modern-case-formula-index.json" with { type: "json" };
import retrievalConceptJson from "../data/tcm-formula-retrieval-concepts.json" with { type: "json" };
import retrievalIndexJson from "../data/tcm-formula-retrieval-index.json" with { type: "json" };
import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { affirmedClinicalText, type AssistedNegationClauses } from "./clinical-polarity";
import { canonicalTcmLocationTerm, canonicalTcmNatureTerm, canonicalTcmSyndromeTerm, formulaMatchSyndromeCompatible, governedSyndromeFeatureMatch, governedTcmTermLabelById, governedTreatmentMethodsInText, matchCompatibleGovernedSyndromeIds } from "./clinical-governance-tables";
import {
  applyBoundedSyndromeHypothesisRerank,
  clinicalAxesFromAffirmedText,
  syndromeHypothesesFromAffirmedText,
  type SyndromeHypothesis,
  type SyndromeHypothesisRerankDecision,
} from "./tcm-syndrome-hypothesis";
import {
  buildCasePopulationProfile,
  buildFormulaAxisProfile,
  scoreFormulaAxes,
  type FormulaAxisProfile,
  type FormulaAxisScoreBreakdown,
} from "./tcm-formula-axis-score";

type FormulaIndicationEntry = {
  id: string;
  name: string;
  aliases: string[];
  source: string;
  ingredients: string[];
  catalog: "official_classic_catalog" | "verified_reference_catalog" | "official_local_formula_standard" | "evidence_adjudicated_identity";
  indications: string[];
  /** 方剂功效（目录 functions 列），用于系统自主锁定时的治法一致性核验。 */
  functions: string[];
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
  /** 治理目录是否已为该方全部药味备齐可执行的数值剂量边界（1563/2937）。 */
  doseCompilationEligible: boolean;
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
  /** 是否有字面证据（概念、主治词或现代医案词命中）。为 false 表示该候选完全由证候假设带入。 */
  hasLiteralEvidence?: boolean;
  /** 现代医案索引命中的症状词（仅供呈现与排查，不是患者事实、不是处方依据）。 */
  matchedModernCaseTerms?: string[];
  /** 该方在现代医案索引里被命中词覆盖到的最高支持例数（0 表示未走本路）。 */
  modernCaseSupport?: number;
  /**
   * 病位/病性/人群轴的逐轴加减分明细（tcm-formula-axis-score.ts）。轴分只进 score（排序），
   * 绝不进 evidenceScore（准入）——轴对立降权但不淘汰；轴数据缺失时 total=0，回退纯 token 分。
   */
  axisScoreBreakdown?: FormulaAxisScoreBreakdown;
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
  functions?: string[];
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
  doseCompilationEligible?: boolean;
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
    functions: entry.functions || [],
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
    doseCompilationEligible: entry.doseCompilationEligible === true,
    governanceStatus: entry.governanceStatus,
    blockingReasons: entry.blockingReasons,
  }));
const ENTRY_BY_ID = new Map(ENTRIES.map((entry) => [entry.id, entry] as const));

/**
 * 可锁定方的排序乘数。校准口径：让「分数接近」的可锁定方稳定胜出，同时不掩盖分数显著更高的
 * 不可锁定方。实测锚点两端——(a) 心脾两虚案 天王补心丹(不可锁定) 与 归脾汤(可锁定) 分差 < 20%，
 * 乘数 1.35 让归脾汤回到首位；(b) 食积案 保和丸(不可锁定) 47.9 vs 钩藤饮(可锁定) 27.1×1.35=36.6,
 * 保和丸仍居首。两端同时成立的乘数区间约 1.2–1.7，取中位 1.35。
 * 这是排序权重常量，不是临床词表；调整它只改变呈现顺序，不改变任何安全边界或锁定判定。
 */
const LOCK_ELIGIBLE_RANK_MULTIPLIER = 1.35;

function formulaRankingScore(entry: { score: number; lockEligible: boolean }): number {
  return entry.score * (entry.lockEligible ? LOCK_ELIGIBLE_RANK_MULTIPLIER : 1);
}

/** 方剂轴档案按 id 惰性缓存：目录字段是构建期常量，档案只算一次。 */
const AXIS_PROFILE_BY_ID = new Map<string, FormulaAxisProfile>();
function axisProfileFor(entry: FormulaIndicationEntry): FormulaAxisProfile {
  const cached = AXIS_PROFILE_BY_ID.get(entry.id);
  if (cached) return cached;
  const profile = buildFormulaAxisProfile(entry);
  AXIS_PROFILE_BY_ID.set(entry.id, profile);
  return profile;
}
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

/**
 * 概念 → 方剂的**全部**受治理指向。
 *
 * 倒排索引里 conceptToFormulaIds / symptomToFormulaIds / diseaseToFormulaIds 是同一批概念正则
 * 在**不同文本域**上的命中：概念索引只扫主治原文，症状/病名索引还扫方名与别名
 * （详见 build-tcm-governance-tables.py 的 build_formula_retrieval_index）。此前只有概念索引
 * 参与候选池构建，后两者在 FormulaRetrievalIndex 类型里声明了却从未被读取——方名/别名自带的
 * 临床语义（如"头痛丸""耳鸣散"）因此从不召回。三者取并集是纯增量：索引缺失或为空时结果不变。
 */
function conceptFormulaIds(conceptId: string): readonly string[] {
  const concept = RETRIEVAL_INDEX.conceptToFormulaIds[conceptId] || [];
  const symptom = RETRIEVAL_INDEX.symptomToFormulaIds[conceptId] || [];
  const disease = RETRIEVAL_INDEX.diseaseToFormulaIds[conceptId] || [];
  if (symptom.length === 0 && disease.length === 0) return concept;
  return [...concept, ...symptom, ...disease];
}

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
 * ★ 这个常数最初只在三个病例上选点，不能把那三例当泛化证明。当前发布回归已扩为 15 个
 *   治疗方向病例 + 18 个病位/病性轴病例，并保留寒热、虚实对侧禁例；未因扩容结果重新调常数，
 *   避免拿验收集继续拟合。验收口径是**治疗方向是否正确**，不是某一首方是否精确命中——
 *   这只是给模型推理用的短名单，不是最终答案。
 */
const SYNDROME_PATH_WEIGHT = 3.0;
const SYNDROME_PATH_FORMULAS_PER_HYPOTHESIS = 6;
const SYNDROME_HYPOTHESIS_LIMIT = 8;
export const SYNDROME_HYPOTHESIS_RERANK_POOL_LIMIT = 40;
/**
 * 「零字面证据准入」的特异性门槛。
 *
 * 证候假设分计入准入分（evidenceScore ≥ 2）本身是对的——轴一致本来就是检索证据。
 * 但粗粒度证候会击穿它：「肾虚」只有 kidney+deficiency 两条轴、挂 33 首方，任何「夜尿多」类
 * 输入都能以覆盖度 1.0 拿到 2 分、加权后 6 分，于是在**一个主治词都没命中**的情况下把方送上首位。
 * 实测反例：「遇热加重，夜尿多」→ 首位崔氏八味丸（肾气丸，含肉桂附子），词面与概念命中均为空——
 * 热象输入拿到温阳方居首，正是本层声称要防的那类方向错误。
 *
 * 因此：候选**若完全没有字面证据**（概念与主治词都没命中），其证候假设必须足够特异
 * （命中轴数 ≥ 3）才准入。有字面证据的候选不受此限，假设照常加权排序。
 * 这不是把假设路关掉——它仍能把「睡不着觉、老忘事、心里发慌」这类口语病例带回归脾汤
 * （心脾气虚命中 4 轴）；被挡掉的只有靠一个泛证候蒙进来的。
 */
const SYNDROME_PATH_SOLE_ADMISSION_MIN_AXES = 3;
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

/**
 * 第四路召回：现代医案「症状表述 → 受控方剂」倒排索引。
 *
 * 前三路的共同盲区是**表述年代**。概念路与主治词路比对的都是古籍主治原文，而古籍写的是
 * 「起碎疙瘩，形如黍屑，色赤肿痛」（枇杷清肺饮），现代病历写的是「面部粟疹累累，色红」——
 * 同一个临床事实，字面零重合；证候假设路又只能覆盖能归一到受控证候的那部分输入。
 * 实测 17 个目录内金标准方 recall@8 只有 35%，召不回的是银翘散、温胆汤、黄芪建中汤这类
 * 门诊核心方——不是它们没进目录，而是**没有人用古籍的话写病历**。
 *
 * 这一路的词条来自 2320 条真实现代医案里「该方被实际使用时医生写下的四诊描述」，
 * 由 scripts/build-modern-case-formula-index.mjs 在构建期编译成 词→方→(权重, 支持例数)。
 *
 * 边界（三条，缺一不可）：
 * - **纯增量**：索引缺失或形态不符时 MODERN_CASE_INDEX 为空表，本路恒返回空命中，
 *   候选池与分数与接入前逐位相同。
 * - **权重低于古籍主治词**：单例支持的配对权重 ≤0.2×MODERN_CASE_PATH_WEIGHT，
 *   与主治词的 0.4–2.0 相差一个数量级；医案统计是**用药习惯**的证据，
 *   强度本就不该等同于受治理主治原文。
 * - **只影响候选池与排序**：身份锁、正向充分性、剂量编译全部在 M03 之后由
 *   retrieveTcmFormulaCandidatesForReasoning 独立判定，本路一个字节都不参与。
 *   多召回一首方不会让任何方绕过锁——它只是让医生和模型看得到它。
 */
type ModernCaseFormulaIndex = ReadonlyMap<string, readonly { id: string; weight: number; support: number }[]>;

/**
 * 现代医案路的**保底**权重。本路的实际换算基准是本例候选池里最强的古籍字面证据
 * （见 literalEvidenceCeiling），这个常数只在池里字面证据本身很弱（甚至为零，即整池全靠
 * 证候假设与现代医案带入）时兜底，量级取与证候假设路一致的 3.0。
 */
const MODERN_CASE_PATH_WEIGHT = 3;
/**
 * 相对份额：本例最强现代医案指向 ≈ 0.9 × 本例最强古籍字面命中。
 * 不取 1.0 是为了在同等强度下让受治理主治原文略占先——医案统计是用药习惯的证据，
 * 治理层级低于主治原文，同分时不该反超。
 */
const MODERN_CASE_TOP_EVIDENCE_SHARE = 1.6;
/** 相对置信度的锐度指数。见 modernCaseScore 处注释。 */
const MODERN_CASE_CONFIDENCE_EXPONENT = 1;
/** 单条配对的权重上限：不让某一个词独自撑起一首方（生成器已压在 0–1，这里是运行时兜底）。 */
const MODERN_CASE_TERM_WEIGHT_CAP = 1;
/**
 * 归一化的绝对置信底线。
 *
 * 本路得分是命中词权重之和，天然随病历长度增长——长病历里每首方的分都高，短病历里都低，
 * 跨病例不可比。所以计分用**相对量**：本方得分 ÷ 本例最高得分。
 * 但纯相对量有一个致命反例：若本例最高分只有 0.3（全是单例支持的碎片命中），
 * 归一化会把这个纯噪声的第一名抬成满分。因此分母取 max(本例最高分, 底线)——
 * 本例整体信号弱时，全部候选按比例衰减，谁也上不了位。
 * 底线 1.2 的量级依据：银翘散/归脾汤/补阳还五汤这些真实命中的原始分在 1.3–2.0，
 * 而只靠碎片词凑出来的方普遍在 0.5 以下。
 */
const MODERN_CASE_CONFIDENCE_FLOOR = 1.2;

function buildModernCaseFormulaIndex(raw: unknown): ModernCaseFormulaIndex {
  const index = new Map<string, { id: string; weight: number; support: number }[]>();
  const terms = (raw as { terms?: unknown } | null | undefined)?.terms;
  if (!terms || typeof terms !== "object") return index;
  for (const [term, rows] of Object.entries(terms as Record<string, unknown>)) {
    if (typeof term !== "string" || !Array.isArray(rows)) continue;
    const parsed = rows.flatMap((row) => {
      if (!Array.isArray(row)) return [];
      const [id, weight, support] = row as [unknown, unknown, unknown];
      if (typeof id !== "string" || typeof weight !== "number" || typeof support !== "number") return [];
      if (!(weight > 0) || !(support >= 1)) return [];
      return [{ id, weight: Math.min(MODERN_CASE_TERM_WEIGHT_CAP, weight), support }];
    });
    if (parsed.length > 0) index.set(term, parsed);
  }
  return index;
}

/**
 * 现代医案召回路径的门控(2026-08-04),默认**关闭**。
 *
 * 它确实有效:接入 17270 条现代医案后,目录内经典方 recall@8 从 35% → 53%,recall@50 从
 * 47% → 76%,银翘散/温胆汤/黄连解毒汤/枇杷清肺饮这些原本 @50 都召不回的方全部回来了。
 *
 * 但它同时**破坏了寒热方向对称性**:风寒表证的首选方变成银翘散(辛凉解表),与风热犯肺
 * 同解——因为银翘散有 41 例现代医案支持,统计支持度压过了方向轴。这正是甲方投诉的错误类型。
 *
 * 已排除的两条修法:
 *  · 调权重无效 —— 一路降回接入前的量级仍然失败,问题不在量级而在是否允许统计证据越过方向判定;
 *  · 方向对立时医案分归零 —— 反而更差(recall 41%),因为受治理证候词表的轴分解本身被污染:
 *    实测「风寒表实证」同时解出 cold 与 heat,基于它的对立判定不可靠。
 *
 * 真正的前置条件是**修复证候轴分解的污染**,那是独立的一轮数据治理工作。在此之前默认关闭:
 * 宁可 recall 停在 35%,也不能让风寒证拿到辛凉方——召回少一个方医生自己会补,
 * 给错方向的方是临床错误。修复轴数据后置 CDSS_MODERN_CASE_RECALL=true 即可开启,
 * 届时 test:syndrome-hypothesis 的方向对称性断言就是它的验收闸。
 */
const MODERN_CASE_RECALL_ENABLED = process.env.CDSS_MODERN_CASE_RECALL === "true";

const MODERN_CASE_INDEX: ModernCaseFormulaIndex = MODERN_CASE_RECALL_ENABLED
  ? buildModernCaseFormulaIndex(modernCaseFormulaIndexJson)
  : new Map();

/**
 * 从病历阳性事实切出与索引同口径的 2–4 字滑窗，再查表。
 *
 * 与主治词路的 `merged.includes(term)` 全表扫描不同，这里反过来切病历、查索引：索引有 11 万词，
 * 逐词 includes 是每次检索十万次子串搜索。两种写法命中集合完全相同——索引词本身就是
 * 连续中文串上的 2–4 字滑窗，不可能跨标点。
 */
function modernCaseFormulaMatches(
  facts: readonly string[],
  index: ModernCaseFormulaIndex,
): Map<string, { score: number; terms: string[]; support: number }> {
  const hits = new Map<string, { score: number; terms: string[]; support: number }>();
  if (index.size === 0) return hits;
  const merged = facts.join("；");
  if (!merged) return hits;
  const matchedTerms = new Set(indicationTerms(merged).filter((term) => index.has(term)));
  if (matchedTerms.size === 0) return hits;
  const byFormula = new Map<string, { term: string; weight: number; support: number }[]>();
  for (const term of matchedTerms) {
    for (const row of index.get(term) || []) {
      const bucket = byFormula.get(row.id);
      if (bucket) bucket.push({ term, weight: row.weight, support: row.support });
      else byFormula.set(row.id, [{ term, weight: row.weight, support: row.support }]);
    }
  }
  // 与主治词路同一条纪律：只给**极大词**计分。「恶寒发热」会同时切出恶寒/发热/恶寒发/寒发热/
  // 恶寒发热，逐条计分等于把一个短语按五条独立证据算。两路口径必须一致，否则权重不可比。
  const raw = new Map<string, { score: number; terms: string[]; support: number }>();
  let best = 0;
  for (const [id, matched] of byFormula) {
    const maximal = matched.filter((item) =>
      !matched.some((other) => other.term !== item.term && other.term.includes(item.term)));
    const score = maximal.reduce((total, item) => total + item.weight, 0);
    if (score <= 0) continue;
    best = Math.max(best, score);
    raw.set(id, {
      score,
      terms: maximal.sort((left, right) => right.weight - left.weight).map((item) => item.term),
      support: maximal.reduce((max, item) => Math.max(max, item.support), 0),
    });
  }
  // 归一化：见 MODERN_CASE_CONFIDENCE_FLOOR。分母带底线，本例整体信号弱时全部候选按比例衰减。
  const denominator = Math.max(best, MODERN_CASE_CONFIDENCE_FLOOR);
  for (const [id, item] of raw) hits.set(id, { ...item, score: item.score / denominator });
  return hits;
}

/** 病历阳性事实命中的主治词 → 方剂加权得分。词条来自受控主治原文，模型与自由文本都不参与。 */
function indicationTermMatches(facts: readonly string[]): Map<string, { score: number; terms: string[] }> {
  const merged = facts.join("；");
  const hits = new Map<string, { score: number; terms: string[] }>();
  if (!merged) return hits;
  const termsById = new Map<string, { term: string; weight: number }[]>();
  // 反转循环方向：切病历、查索引，而不是遍历 11.3 万索引词逐个 includes（2026-08-09）。
  //
  // **不改任何打分**。这一路的权重尺度上标定着一批治理常数（准入线 2、curatedBoost 2、
  // SYNDROME_PATH_WEIGHT 3、LOCK_ELIGIBLE_RANK_MULTIPLIER 1.35、coordinationFactor ≤1.75），
  // 换尺子会让它们全部作废；所以这里只换遍历方式，命中集合与权重逐条不变。
  //
  // 等价性不是照抄注释——同文件 :410 早就写过这句声称，但本仓库已经因为「相信未经实测的
  // 等价性声称」踩过坑。实测（300 例真实归档 M03 产物）：命中集合 0/300 不一致，
  // 耗时 4.27ms → 0.03ms per case（**128×**）。断言见 scripts/test-formula-symptom-retrieval.mjs。
  // 成立的前提：索引词就是连续中文串上的 2–4 字滑窗（indicationTerms 与建索引同一个函数），
  // 因此不可能跨标点，切窗查表与全表 includes 必然同集。
  for (const term of new Set(indicationTerms(merged))) {
    const entry = INDICATION_TERM_INDEX.get(term);
    if (!entry) continue;
    for (const id of entry.ids) {
      const bucket = termsById.get(id);
      if (bucket) bucket.push({ term, weight: entry.weight });
      else termsById.set(id, [{ term, weight: entry.weight }]);
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

export function positiveCaseFacts(caseState: CaseState, assistedNegations?: AssistedNegationClauses): string[] {
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

/**
 * L1b 的唯一候选来源：L1a 在“可到达受控方剂”的证候闭集里生成的确定性假设。
 * 不带 recallHint，避免把另一轮模型改写的文本当作患者事实再次送进语义重排。
 */
export function formulaSyndromeHypothesisPool(
  caseState: CaseState,
  assistedNegations?: AssistedNegationClauses,
): { facts: string[]; hypotheses: SyndromeHypothesis[] } {
  const facts = positiveCaseFacts(caseState, assistedNegations);
  return {
    facts,
    hypotheses: syndromeHypothesesFromAffirmedText(
      facts,
      SYNDROME_HYPOTHESIS_RERANK_POOL_LIMIT,
      FORMULA_REACHABLE_SYNDROME_IDS,
    ),
  };
}

export function retrieveTcmFormulaIndicationCandidates(
  caseState: CaseState,
  limit = 5,
  recallHint = "",
  assistedNegations?: AssistedNegationClauses,
  syndromeRerank: readonly SyndromeHypothesisRerankDecision[] = [],
  /** 现代医案索引可注入，默认用构建期产物；传空表即为「索引缺失」，用于钉住纯增量兜底。 */
  modernCaseIndex: ModernCaseFormulaIndex = MODERN_CASE_INDEX,
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
  // 第四路召回：现代医案索引（构建期统计派生，零模型）。见 modernCaseFormulaMatches 上方注释。
  const modernHits = modernCaseFormulaMatches(recallFacts, modernCaseIndex);
  // 第三路召回：证候假设（L1a，确定性，零模型）。
  // 前两路都在比对**字面**——症状串对概念正则、症状串对主治原文。字面重合永远分不清
  // 「失眠属心脾两虚」还是「失眠属肝火扰心」，因为区分它们的信息（便溏 vs 口苦目赤）是一个
  // 证候判断而不是一个词。实测：肝火病例首位召回二至丸（肝肾阴虚，治疗方向相反），
  // 只因二至丸主治里恰好同时出现口苦/失眠/多梦。
  // 这一路把阳性事实映射到病位/病性轴，再按轴一致性取受控证候假设，走既有的
  // syndromeToFormulaIds 索引。**纯并集**：本层无命中时结果与之前完全一致。
  const syndromeHypotheses = syndromeRerank.length > 0
    ? applyBoundedSyndromeHypothesisRerank(
      syndromeHypothesesFromAffirmedText(
        recallFacts,
        SYNDROME_HYPOTHESIS_RERANK_POOL_LIMIT,
        FORMULA_REACHABLE_SYNDROME_IDS,
      ),
      syndromeRerank,
      SYNDROME_HYPOTHESIS_LIMIT,
    )
    : syndromeHypothesesFromAffirmedText(
      recallFacts,
      SYNDROME_HYPOTHESIS_LIMIT,
      FORMULA_REACHABLE_SYNDROME_IDS,
    );
  const hypothesisScoreByFormulaId = new Map<string, number>();
  /** 每首方所命中假设里最特异的那条的轴数，用于「零字面证据准入」门槛。 */
  const hypothesisAxesByFormulaId = new Map<string, number>();
  for (const hypothesis of syndromeHypotheses) {
    // 每个假设只取前若干首，防止「风寒」这类挂了 58 首的粗粒度证候一次灌满候选池。
    for (const id of (RETRIEVAL_INDEX.syndromeToFormulaIds[hypothesis.syndromeId] || []).slice(0, SYNDROME_PATH_FORMULAS_PER_HYPOTHESIS)) {
      hypothesisScoreByFormulaId.set(id, Math.max(hypothesisScoreByFormulaId.get(id) || 0, hypothesis.score));
      hypothesisAxesByFormulaId.set(id, Math.max(hypothesisAxesByFormulaId.get(id) || 0, hypothesis.matchedAxes));
    }
  }
  const candidates = indexedEntries([
    ...caseConcepts.flatMap((concept) => conceptFormulaIds(concept.id)),
    ...termHits.keys(),
    ...hypothesisScoreByFormulaId.keys(),
    ...modernHits.keys(),
  ]);
  // 病位/病性/人群轴（2026-08-03 复盘的模板化偏置根修）：token 重叠只再是基础分，
  // 目录已有的轴数据参与排序——轴一致加分、方向对立减分、人群冲突降权并保留标注。
  // 病例轴与假设路同源（clinicalAxesFromAffirmedText），人群档案只用阳性事实 + 病例人口学字段。
  const caseAxes = clinicalAxesFromAffirmedText(recallFacts);
  const casePopulation = buildCasePopulationProfile(caseState.patient, facts);
  const scored = candidates.map((entry) => {
    const indicationText = entry.indications.join("；");
    const matched = caseConcepts.filter((concept) => conceptFormulaIds(concept.id).includes(entry.id));
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
    const modernHit = modernHits.get(entry.id);
    // 古籍字面证据（概念 + 主治词，含协同度放大）。这一项同时是现代医案路的换算基准，见下方 pass 2。
    const classicLiteralEvidence =
      (rawConceptScore * focusMultiplier + (termHit?.score || 0)) * coordinationFactor;
    const baseEvidence = classicLiteralEvidence + hypothesisScore +
      (entry.catalog === "verified_reference_catalog" ? 0.25 : 0);
    // 轴分只调排序：token/概念/假设证据决定准入（evidenceScore），轴一致/对立决定同池内先后。
    // 轴数据缺失的方剂 total=0，与升级前完全同分——additive 兜底，绝不因缺数据被淘汰。
    const axisScoreBreakdown = scoreFormulaAxes(axisProfileFor(entry), caseAxes, {
      mode: "full",
      population: casePopulation,
    });
    return {
      entry,
      modernHit,
      classicLiteralEvidence,
      baseEvidence,
      curatedBoost,
      axisScoreBreakdown,
      lockEligible,
      hypothesisAxes: hypothesisAxesByFormulaId.get(entry.id) || 0,
      hasClassicLiteralEvidence: rawConceptScore > 0 || (termHit?.score || 0) > 0,
      matchedConcepts: matched.map((concept) => concept.key),
      matchedIndicationTerms: [...new Set(termHit?.terms || [])]
        .sort((left, right) => right.length - left.length)
        .slice(0, 4),
      matchedPatientFacts: [...new Set(matchedPatientFacts)].slice(0, 3),
    };
  });
  /**
   * Pass 2 —— 现代医案路的换算基准：本例候选池里最高的一份**古籍字面证据**。
   *
   * 为什么不能用固定常数：主治词路的分是命中词权重之和，没有上界，实测同一个池里从 3 分到 48 分
   * 都有（主治文本长的方天然占便宜）。给现代医案路配一个固定常数，等于在一把刻度不断变化的尺子上
   * 刻死一格——实测把它配成 3 分（与证候假设路同量级）时，一个**本路排名第一、支持 21 例**的
   * 银翘散在小儿外感发热病例里只能从 7.0 升到 10.0，仍然输给同案里靠泛词堆出 19.6 分的人参养荣汤。
   * 那不是权重没调够，是两把尺子不可通约。
   *
   * 改用相对份额后这句话才有临床含义：**「本例最强的现代医案指向」与「本例最强的古籍字面命中」
   * 价值相当**。两者都是「本例写下的词出现在该方的临床表述里」，区别只是那份表述来自
   * 2320 条真实医案还是来自古籍主治原文；后者措辞更受治理，前者更贴近现代病历用语。
   * 这也让本路自带上界：它永远不可能超过本例古籍证据的最高值太多，一路失灵不会独占整张短名单。
   */
  const classicEvidenceCeiling = scored.reduce(
    (max, item) => (item.classicLiteralEvidence > max ? item.classicLiteralEvidence : max), 0);
  const modernEvidenceUnit = Math.max(MODERN_CASE_PATH_WEIGHT, classicEvidenceCeiling * MODERN_CASE_TOP_EVIDENCE_SHARE);
  return scored.map((item) => {
    const modernCaseScore = (item.modernHit?.score || 0) ** MODERN_CASE_CONFIDENCE_EXPONENT * modernEvidenceUnit;
    // 字面证据 = 概念命中 + 主治词命中 + 现代医案词命中。三者皆无时，该候选完全由证候假设带进来。
    // 现代医案命中算字面证据：它同样是「本例写下的词出现在该方的临床表述里」，
    // 只是那份表述来自真实医案而不是古籍主治——证据类型相同，年代不同。
    const hasLiteralEvidence = item.hasClassicLiteralEvidence || modernCaseScore > 0;
    const hypothesisSoleAdmissionAllowed = hasLiteralEvidence ||
      item.hypothesisAxes >= SYNDROME_PATH_SOLE_ADMISSION_MIN_AXES;
    const evidenceScore = item.baseEvidence + modernCaseScore;
    const score = evidenceScore + item.curatedBoost + item.axisScoreBreakdown.total;
    return {
      ...item.entry,
      evidenceScore: hypothesisSoleAdmissionAllowed ? evidenceScore : 0,
      hasLiteralEvidence,
      axisScoreBreakdown: item.axisScoreBreakdown,
      matchedConcepts: item.matchedConcepts,
      matchedIndicationTerms: item.matchedIndicationTerms,
      matchedModernCaseTerms: (item.modernHit?.terms || []).slice(0, 4),
      modernCaseSupport: item.modernHit?.support || 0,
      matchedPatientFacts: item.matchedPatientFacts,
      score,
      lockEligible: item.lockEligible,
    };
  })
    .filter((entry) => entry.evidenceScore >= 2)
    // 排序键的层次（两条实测教训必须同时保住，2026-08-04 修正第一条的副作用）：
    //
    // 1) 字面证据优先于纯证候假设。假设路比对的是「本例的轴与某证候一致」，不是「本例症状
    //    出现在该方主治里」；有真正命中主治的候选时，让零字面命中的方领衔就是把推断摆到
    //    证据前面。实测：「遇热加重，夜尿多」下崔氏八味丸（温阳）零字面命中却居首。
    //
    // 2) 可锁定性是**加权**，不再是绝对首键。原实现把 lockEligible 放在最前，理由是不可锁定
    //    的方被模型选中后会被 strip、退化成自拟方，对医生更差（实测 心脾两虚 案 天王补心丹
    //    以字面重合压过归脾汤）。但绝对首键把「目录标注缺口」放大成了「临床推荐缺陷」：
    //    目录 2937 首里 593 首（20%）无证候标注、恒为 lockEligible=false，于是无论多对证都排在
    //    全部可锁定方之后——短名单只取 5–8 首，它们等于被永久删除。实测保和丸在「食积停滞、
    //    嗳腐吞酸」病例下证据分 47.9（全池最高，是次高的 1.8 倍）却排 264/274，模型根本看不到它。
    //    改为乘数后：分数接近时可锁定方仍然胜出（教训 2 保住），分数显著更高的不可锁定方
    //    可以上位（保和丸类解禁）。乘数是可校准参数，不是临床词表；校准依据见常量注释。
    .sort((left, right) =>
      Number(right.hasLiteralEvidence) - Number(left.hasLiteralEvidence) ||
      formulaRankingScore(right) - formulaRankingScore(left) ||
      Number(right.lockEligible) - Number(left.lockEligible) ||
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
      // 主证候还要再走一次「复合证候取首段」归一。候选集合 candidateIds 正是由这里的 tags.syndrome
      // 反查 syndromeToFormulaIds 得来的：整串归一失败时，主证对应的方剂**根本进不了候选集**，
      // 后面无论正向充分性怎么判都没有意义。只补主证一项，兼证/鉴别证仍按原口径整串归一。
      ...(canonicalPrimarySyndromeId(reasoning.overview.primarySyndrome) ? [canonicalPrimarySyndromeId(reasoning.overview.primarySyndrome)!] : []),
      // 主证的匹配相容类也进入召回：方剂标签挂在同证的另一个 id 下时，不展开就意味着该方
      // 连候选集都进不了（胃火上炎的候选池里没有标成胃火炽盛的清胃散，匹配层再对也没用）。
      // 召回口径与匹配口径一致（严格相等 ∪ 差一个继发负担维度，全部否决生效）——只对主证展开，
      // 兼证/鉴别证仍按原口径整串归一。
      ...matchCompatibleGovernedSyndromeIds(canonicalPrimarySyndromeId(reasoning.overview.primarySyndrome)),
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
/**
 * 复合证候的主证段归一。
 *
 * 命名方身份锁要求 primarySyndromeId 存在（positiveSufficiency 需 directPrimarySyndromeMatch）。
 * 而受控证候词表收的是**单一证候**：「心脾两虚证」「肝阳上亢证」「痰热扰心证」都能归一，
 * 「心脾两虚兼血瘀」「肝阳上亢，痰热扰心」整串则一个都归不上。
 *
 * 真实病例里复合证候是常态而不是例外——一组 10 例公开医案跑下来，6 例的主证候是复合写法，
 * 这 6 例的 primarySyndromeId 全为空，于是检索出的 200 个候选**没有一个**能满足正向充分性，
 * M03 只能一律走自拟方。医生因此从头到尾看不到一次「归脾汤加减」这样的命名方结论，
 * 而这恰恰是中医处方最该给出的东西。
 *
 * 按中医书写惯例，复合证候的**首段**是主证，其后是兼证（结构上另有 secondarySyndromes 承接）。
 * 所以这里只做一件事：整串归一失败时，按连接词切分并只取**首段**再归一一次。
 *
 * 三条边界，缺一不可：
 * - 只取首段，不是任意一段。取任意段会让兼证反客为主，把方锁到次要矛盾上。
 * - 仍然走同一张受控词表，不做模糊匹配；首段是已签名证候的字面子串，不引入新的语义推断，
 *   因此仍属确定性归一（primarySyndromeIdentityConfirmed），与需要医生确认的语义兜底路径不同。
 * - 锁定方名只是让 M04 拿到可编译基准方，剂量、配伍禁忌、特殊人群、治法覆盖等检查一条未减。
 */
function canonicalPrimarySyndromeId(primarySyndrome: unknown): string | undefined {
  const whole = canonicalTcmSyndromeTerm(primarySyndrome)?.id;
  if (whole) return whole;
  const text = typeof primarySyndrome === "string" ? primarySyndrome.trim() : "";
  if (!text) return undefined;
  // 表述噪声剥离。模型在信息不全时会把主证候写成**描述性短语**而不是规范证候名：
  // 实测公开医案「眩晕-痰热上扰」得到「头晕（症状层）伴痰湿内阻倾向」——病机段写得完全正确
  //（痰湿内蕴、湿郁化热），但主证候字段带着括号注释与「倾向」尾缀，整串与首段都归不上，
  // 于是方剂身份锁全链失效、只能出自拟方。括号注释与不确定性尾缀不携带证候语义，先剥掉。
  const denoised = text
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/(?:倾向|趋势|可能|状态|表现|为主)$/g, "")
    .trim();
  const denoisedWhole = denoised && denoised !== text
    ? canonicalTcmSyndromeTerm(denoised)?.id || canonicalTcmSyndromeTerm(`${denoised}证`)?.id
    : undefined;
  if (denoisedWhole) return denoisedWhole;
  const segments = (denoised || text)
    .split(/[，,；;、]|兼(?:有|见|夹)?|夹(?:有)?|合并|伴(?:有|见)?/)
    .map((segment) => segment.replace(/(?:倾向|趋势|可能|状态)$/g, "").trim())
    .filter(Boolean);
  if (segments.length === 0) return undefined;
  // 仍然是**首段优先**：按顺序取第一个能归一的段，首段是有效证候时必然命中它，
  // 兼证不会反客为主。只有当首段根本不是证候表述（如上面的「头晕」症状层）时，
  // 才会继续用后续段——那正是需要挽回的情形，而不是让整例退化成自拟方。
  for (const segment of segments) {
    if (segment === text) continue;
    const id = canonicalTcmSyndromeTerm(segment)?.id || canonicalTcmSyndromeTerm(`${segment}证`)?.id;
    if (id) return id;
  }
  return undefined;
}

export function retrieveTcmFormulaCandidatesForReasoning(
  reasoning: FormulaReasoningProjection,
  limit = 5,
): FormulaIndicationCandidate[] {
  const tags = governedReasoningTags(reasoning);
  const deterministicPrimarySyndromeId = canonicalPrimarySyndromeId(reasoning.overview.primarySyndrome);
  const semanticPrimaryMapping = primarySyndromeSemanticMapping(reasoning);
  const primarySyndromeId = deterministicPrimarySyndromeId || semanticPrimaryMapping?.candidateId;
  // A semantic miss-recovery mapping is additive retrieval evidence. It cannot silently replace
  // the signed primary syndrome or authorize a named formula until a clinician explicitly confirms
  // it; deterministic canonical/alias resolution retains its existing authority.
  const primarySyndromeIdentityConfirmed = Boolean(
    deterministicPrimarySyndromeId || semanticPrimaryMapping?.status === "clinician_confirmed",
  );
  // 召回文本必须包含**患者主症**,不能只有证候与病机(2026-08-04)。
  //
  // 实测缺陷:产后头痛例,M03 已把病位判为「心、脾、头窍」、治法改为「荣脑止痛」,
  // 但 M04 首选方仍是归脾汤加减,九味药里没有一味针对头痛的(川芎、白芷、蔓荆子之类)。
  // 追下去发现:候选池由 tags(证候/病性/病位)与 reasoningConcepts 反查索引得来,而
  // reasoningConcepts 只扫证候名、总病机、病机链——**主诉与主症一个字都没进来**。
  // 检索索引里 headache 维度挂着 114 首方,概念 id 空间与症状 id 空间 27/27 完全重合,
  // 也就是说数据齐备、通路也在,只是喂进去的文本里没有「头痛」这两个字。
  //
  // 修法是补齐扫描字段,不是加规则:患者主症本就写在签名结论内——病位判据的 basis、
  // 主证依据、西医诊断的支持事实。这些字段是 M03 对「凭什么这么判」的记录,
  // 天然含主诉原文(实测 basis = "产后2月余,头痛反复发作1月")。西医诊断的支持事实
  // 不在 FormulaReasoningProjection 这个投影类型里,故未取——前两项已覆盖本类缺陷。
  //
  // 只读签名结论内的字段,不另取 caseState:召回依据必须与已签名的结论同源,
  // 否则会出现「方是按签名外的信息选的」这种无法追溯的情况。
  const reasoningText = [
    reasoning.overview.primarySyndrome,
    reasoning.overview.overallPathogenesis,
    reasoning.pathogenesis.summary,
    ...(reasoning.pathogenesis.chain || []).flatMap((item) => [item.pathogenesis, item.therapyDirection]),
    ...(reasoning.overview.primarySyndromeBasis || []),
    ...(reasoning.pathogenesis.locationDifferentiation?.details || []).map((item) => item.basis),
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
    ...reasoningConcepts.flatMap((concept) => conceptFormulaIds(concept.id)),
  ];
  return indexedEntries(candidateIds).map((entry) => {
    const syndromeMatches = entry.syndromeTags.filter((id) => tags.syndrome.has(id));
    const natureMatches = entry.natureTags.filter((id) => tags.nature.has(id));
    const locationMatches = entry.locationTags.filter((id) => tags.location.has(id));
    const conceptMatches = reasoningConcepts.filter((concept) => conceptFormulaIds(concept.id).includes(entry.id));
    // 主证匹配走证候特征等同层：模型写规范名、方剂标签用古典名（心胆气虚 vs 心虚胆怯）时，
    // 两个国标 id 在特征层（病位×病性）是同一个证。等同判定完全建立在受控枚举上
    // （见 clinical-governance-tables 的 governedSyndromeFeatureMatch），阴阳/寒热/虚实极性
    // 与脏腑边界一票否决，无特征或混合极性条目 fail-closed 不参与——同 id 语义原样保留。
    // 在此之上叠加表↔肺卫外感风证的受控 match-tier 相容（肺主皮毛：风寒束表 ↔ 风寒犯肺），
    // 与 tags.syndrome 的召回展开共用同一谓词（formulaMatchSyndromeCompatible），
    // 否则相容方连候选池都进不了；基准措辞在 basis 里如实区分「精确关系」与「表↔肺卫相容」。
    const exactPrimarySyndromeMatch = Boolean(primarySyndromeId &&
      entry.syndromeTags.some((tag) => governedSyndromeFeatureMatch(tag, primarySyndromeId)));
    const directPrimarySyndromeMatch = exactPrimarySyndromeMatch || Boolean(primarySyndromeId &&
      entry.syndromeTags.some((tag) => formulaMatchSyndromeCompatible(tag, primarySyndromeId)));
    const curatedPrimaryRelation = primarySyndromeId
      ? entry.curatedSyndromeRelations.find((relation) => formulaMatchSyndromeCompatible(relation.syndromeId, primarySyndromeId))
      : undefined;
    const curatedTherapySatisfied = Boolean(curatedPrimaryRelation?.therapyTerms.some((term) =>
      therapyText.includes(term.replace(/\s+/g, ""))));
    // A named formula is positively sufficient only when the signed primary syndrome itself has a
    // direct relation. Nature/location-only matches and differential-syndrome matches remain useful
    // for comparison but can never lock a formula identity. Curated high-frequency relations add a
    // second, explicit therapy-alignment requirement.
    // ★ 已知数据缺口（不在本层修复）：治理目录里只有 1563/2937 的方备齐全部药味的数值剂量边界，
    // 锁定不可编译的方会让 M04 秒级返回非剂量降级（实测天王补心丹、镇肝熄风汤 0 味）。
    // 曾尝试在此处加 entry.doseCompilationEligible 过滤，但它误伤经典方——缺的往往是
    // **非药典成分**而非药味本身：黄连阿胶汤缺「鸡子黄」（食材）、天王补心丹缺「朱砂粉」
    //（管制毒性药）、镇肝熄风汤缺矿物药剂量。按可编译性禁锁等于把这些常用方整类逐出，
    // 既有治理关系（心肾不交→黄连阿胶汤）随即断裂。
    // 正确修法在数据侧：为食材/矿物/管制成分补齐或显式豁免剂量边界，而不是在召回层收紧。
    const positiveSufficiency = primarySyndromeIdentityConfirmed && directPrimarySyndromeMatch && (
      curatedPrimaryRelation ? curatedTherapySatisfied : true
    );
    const curatedRelationBonus = curatedPrimaryRelation
      ? (curatedPrimaryRelation.fit === "primary" ? 8 : 5) + (curatedTherapySatisfied ? 2 : 0)
      : 0;
    const baseScore = syndromeMatches.length * 6 + natureMatches.length * 2 + locationMatches.length * 1.5 +
      curatedRelationBonus +
      conceptMatches.reduce((total, concept) => total + concept.weight, 0);
    // guard 模式只做方向减分：签名病性/病位与方剂轴方向对立（如签名虚证召回泻实方）沉底，
    // 匹配加分不重复计（natureMatches/locationMatches 已按签名标签逐条加过分）。
    // 减分只作用于排序 score；准入仍看 baseScore（evidenceScore），对立候选保留作鉴别参考。
    const axisScoreBreakdown = scoreFormulaAxes(
      axisProfileFor(entry),
      { locations: tags.location, natures: tags.nature },
      { mode: "guard" },
    );
    const score = baseScore + axisScoreBreakdown.total;
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
      axisScoreBreakdown,
      // 此处治理加权与准入分同源：curatedRelationBonus 只在**已签名主证候与该方存在受控关系**时产生，
      // 本身就是一条检索证据；不像症状召回那一路的 curatedBoost 是与本例无关的常数加权。
      // 准入分固定为轴调整前的 baseScore：轴对立只降排序权重，不得把已凭证据入场的候选挤出集合。
      evidenceScore: baseScore,
      directPrimarySyndromeMatch,
      positiveSufficiency,
      positiveSufficiencyBasis: positiveSufficiency
        ? curatedPrimaryRelation
          ? `高频证候关系:${curatedPrimaryRelation.syndrome}；治法:${curatedPrimaryRelation.therapyTerms.join("、")}`
          : exactPrimarySyndromeMatch
            ? `方剂主治与主证候精确关系:${governedTcmTermLabelById(primarySyndromeId!) || primarySyndromeId}`
            : `方剂主治与主证候表↔肺卫外感风证受控相容:${governedTcmTermLabelById(primarySyndromeId!) || primarySyndromeId}`
        : directPrimarySyndromeMatch && !primarySyndromeIdentityConfirmed
          ? `闭集语义映射仅用于召回，主证候“${reasoning.overview.primarySyndrome}”映射到“${semanticPrimaryMapping?.canonical || primarySyndromeId}”尚待医生确认`
        : directPrimarySyndromeMatch && curatedPrimaryRelation
          ? `证候关系存在，但已签名治法未命中:${curatedPrimaryRelation.therapyTerms.join("、")}`
          : "仅病性、病位、症状或鉴别证候相关，缺少主证候正向充分性",
    };
  }).filter((entry) => entry.evidenceScore >= 2)
    .sort((left, right) =>
      Number(right.positiveSufficiency) - Number(left.positiveSufficiency) ||
      // 同为正向充分时，剂量可编译的方排前面。治理目录里只有 1563/2937 的方备齐全部药味的
      // 法定数值剂量边界——锁定一个不可编译的方，M04 只能返回非剂量降级，医生连自拟方都拿不到
      //（实测：肝阳上亢锁镇肝熄风汤[龙骨药典未收载] → 0 味；同证的天麻钩藤饮完全可编译）。
      // 这里只调整**排序**不改变可锁集合：无可编译替代时该方照旧可锁，
      // 既有治理关系（心肾不交→黄连阿胶汤[鸡子黄非药典成分]）不会因此断裂。
      Number(right.doseCompilationEligible) - Number(left.doseCompilationEligible) ||
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
      // 逐条重复「仅作检索关联，必须结合本例事实临床核对」会把同一句对冲复制 N 遍，与区块开头的
      // 选择规则重复。实测中这类层叠对冲的净效果是把模型推向最保守的一侧——对一个 8/8 方证吻合、
      // 排名第一的候选仍然写「无匹配、自拟」。核对要求保留在区块开头说一次即可。
      `  T1/T3/T4关联索引：${governedRelations.join("、") || "暂无标准术语关联"}`,
      ...(phaseLabel === "M03签名证候/病机"
        ? [`  命名方正向充分性：${candidate.positiveSufficiency ? `通过（${candidate.positiveSufficiencyBasis}）` : `不通过（${candidate.positiveSufficiencyBasis}）`}`]
        : []),
      // 人群轴冲突按规则「降权并保留标注」：候选不淘汰，但医生与模型必须看得到冲突事实。
      ...((candidate.axisScoreBreakdown?.population.conflicts.length || 0) > 0
        ? [`  人群轴提示：${candidate.axisScoreBreakdown!.population.conflicts.join("；")}（已在排序中降权，保留供鉴别核对）`]
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
  syndromeRerank: readonly SyndromeHypothesisRerankDecision[] = [],
): string {
  const candidates = retrieveTcmFormulaIndicationCandidates(
    caseState,
    limit,
    recallHint,
    assistedNegations,
    syndromeRerank,
  );
  if (candidates.length === 0) {
    return "【M03经典方检索】本例当前阳性事实未命中受控经典方主治索引；可按已锁定病机与治法形成自拟方向，但必须说明未采用经典方是因受控目录无匹配结果。";
  }
  // 选择规则前置。原实现把它放在 5 条候选之后，模型要先读完 5 遍「仅作检索关联」「候选不是自动
  // 推荐」才知道该拿这些候选做什么；加上 M03 提示词全局 100+ 条禁令，净效果是模型学到「保守、别
  // 下结论」，对方证 8/8 吻合、排名第一的候选仍写自拟。规则改为先说「怎么选」，再列候选。
  return [
    "【M03经典方检索（受控目录）】",
    "选择规则：以下候选已按本例阳性事实召回并排序。逐条核对方证眼目后，从“治理状态=可锁定”的条目中选出 1–3 个方证整体匹配的方名，逐字写入 overview.recommendedFormulaNames（不得改写、不得加书名号），formulaSelectionMode 相应填 single/combined/alternatives，recommendedFormulaDirection 直接写出方名。确有匹配却留空改自拟会被服务端确定性驳回并要求重做：自拟方没有出处可考，临床上比承接经典方更难辩护。只有当每一条都与本例方证不符时才写“按已锁定病机与治法辨证组方”，并说明是哪条方证眼目不满足。标记为仅检索参考的条目只能用于鉴别，不得锁定；也不得使用候选以外的未受控命名方。方名锁定不等于剂量已定——剂量由 M04 独立编译并经处方后审方。",
    ...renderFormulaCandidates(candidates, "M03病例事实"),
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
 * The missing symmetric half of enforceRetrievedM03FormulaSelection.
 *
 * That guard only ever REMOVES a formula the case cannot support — its first branch returns the
 * content unchanged when `recommendedFormulaNames` is empty. So over-claiming is caught and
 * under-claiming passes silently, even though under-claiming is the more damaging direction:
 * a self-devised formula carries no 出处, is clinically harder to defend than the classic it
 * replaced, and strips M04 of its compilable baseline — forcing herbs, doses, 君臣佐使 and P-node
 * bindings to be generated from scratch on the hardest available path.
 *
 * Measured: a textbook 心脾两虚 不寐 whose own signed M03 yields 归脾汤 (plus 酸枣仁汤, 参苓白术散,
 * 秘元煎) at positive sufficiency was emitted as `self_devised` with an empty name list. Nothing
 * caught it; M04 then burned two repair rounds and degraded to a non-dose contract, and the
 * doctor saw a refusal page.
 *
 * This function does NOT pick a formula — choosing one is a clinical decision that stays with the
 * model and the physician. It only reports which lock-eligible, positively-sufficient candidates
 * the model passed over, so the contract can demand a repair round that names them.
 *
 * Returns [] whenever the selection is legitimate: a formula was locked, the server itself
 * deferred the choice pending clinician confirmation, or no sufficient candidate exists.
 */
/**
 * 已签名治法的受控治法词 id 集合。取材与 enforceRetrievedM03FormulaSelection 同源
 * （recommendedFormulaDirection + therapy.overallMethod），因为下面那条对齐判据要三处共用。
 */
export function signedTherapyMethodIds(reasoning: unknown): Set<string> {
  const source = reasoning as {
    overview?: { recommendedFormulaDirection?: unknown };
    therapy?: { overallMethod?: unknown };
  } | null | undefined;
  return new Set(governedTreatmentMethodsInText([
    typeof source?.overview?.recommendedFormulaDirection === "string" ? source.overview.recommendedFormulaDirection : "",
    typeof source?.therapy?.overallMethod === "string" ? source.therapy.overallMethod : "",
  ].filter(Boolean).join("；")).map((entry) => entry.id));
}

/**
 * 「这张方的功效方向与已签名治法是否**明确对立**」——一条判据，三处消费。
 *
 * 【为什么必须共用】这条判据原本只写在 systemLockable 那一处（系统自锁支路），注释里点名
 * 记着它是为哪一例加的：湿热内蕴证（阳黄）召回到导赤散（功效「清心利水养阴」，主治末句恰好
 * 写着「属湿热内蕴者」故证候标签命中），而本例签名治法是「清热利湿退黄，通腑泄热」。
 * 但系统能把一张方摆到医生面前的路**有三条**，当时只堵了一条：
 *   ① 系统自锁（systemLockable）        —— 有这道门
 *   ② 校验模型自己选的方（allowed 集）   —— 没有
 *   ③ 修复轮候选（missedLockable…）      —— 没有
 * 实测（tmp-probe/repro-formula-void.mjs，签名主证「湿热内蕴证」+ 治法「清热利湿退黄，通腑泄热」）：
 *   · 模型选「茵陈蒿汤」（本例金标准方）⇒ names=[] / self_devised，被作废；
 *   · 模型选「导赤散」                  ⇒ names=["导赤散"] / single，**原样放行**；
 *   · 作废之后修复轮告诉模型「以下经典方与本例方证匹配、可锁定且已通过正向充分性核验：
 *     导赤散、大橘皮汤、柴芩煎」。
 * 也就是说：删掉对的方，再把错的方标成「已核验」喂回去——恰恰是 ① 处注释声称已经避免的那一例。
 *
 * 【判据本身不变，仍然只否决明确对立、不否决数据缺失】目录里 2367/2910 条可锁方 functions 为空
 * （茵陈蒿汤本身就是其中之一），把「抽不出治法词」也判为不一致会挡掉全部数据缺口而非临床错误。
 * 所以两侧都抽得出治法词、且交集为空时才否决——它只可能删掉**有据可查地方向相反**的方。
 */
export function formulaTherapyAlignedWithSigned(
  functions: readonly string[] | undefined,
  signedMethods: ReadonlySet<string>,
): boolean {
  if (signedMethods.size === 0) return true;
  const formulaMethods = governedTreatmentMethodsInText((functions || []).join("；"));
  if (formulaMethods.length === 0) return true;
  return formulaMethods.some((method) => signedMethods.has(method.id));
}

export function missedLockableFormulaCandidates(reasoning: unknown, limit = 3): string[] {
  const overview = (reasoning as {
    overview?: {
      recommendedFormulaNames?: unknown;
      deferredFormulaSelection?: unknown;
      primarySyndromeResolution?: unknown;
    };
  } | null | undefined)?.overview;
  if (!overview) return [];
  const locked = Array.isArray(overview.recommendedFormulaNames)
    ? overview.recommendedFormulaNames.filter((name): name is string =>
        typeof name === "string" && Boolean(name.trim()))
    : [];
  if (locked.length > 0) return [];
  // An empty list that enforceRetrievedM03FormulaSelection produced itself, by parking the model's
  // choice until a clinician confirms the governed syndrome mapping, is our doing — not an omission.
  if (overview.deferredFormulaSelection) return [];
  // A formula identity is locked TO a syndrome. When the model states it could not establish one,
  // demanding a lock would be asking it to bind a formula to nothing — that case belongs to the
  // limited-result path, not to this policy check.
  if (overview.primarySyndromeResolution === "unresolved") return [];
  try {
    const signedMethods = signedTherapyMethodIds(reasoning);
    return retrieveTcmFormulaCandidatesForReasoning(reasoning as ClinicalReasoningResultV2, 8)
      .filter((entry) => entry.identityLockEligible && entry.positiveSufficiency)
      // 修复提示词会把这些方名写成「已通过正向充分性核验……逐字抄写」，是三条通路里
      // 对模型影响最强的一条。治法方向对立的方在这里必须先掉队，否则等于指挥模型改错。
      .filter((entry) => formulaTherapyAlignedWithSigned(entry.functions, signedMethods))
      .slice(0, limit)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
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
        // 证候级二次检索（2026-08-04）：生成前的短名单是**症状级**召回，模型只能从它看到的方里选；
        // 而这里的检索用的是**已签名证候+病机+治法**，精确得多。此前它只用于「校验模型选的方」
        // （只能删不能加），于是「辨证正确但正解方从未进入模型视野」的病例只能退化成自拟方
        // （实测 百合固金汤/肾气丸/保阴煎 等 6 例：证候全部辨对，方名一个都没给出）。
        // 现在同一次检索结果额外承担一个纯增益职责：模型没给出可锁定方名时，把它检索到的
        // 受治理经典方作为**参考候选**呈现给医生（见下方 systemRetrieved 分支）。
        const reasoningCandidates = (() => {
          try {
            return retrieveTcmFormulaCandidatesForReasoning(parsed as unknown as ClinicalReasoningResultV2, 8)
              .filter((entry) => entry.identityLockEligible && entry.positiveSufficiency);
          } catch {
            return [];
          }
        })();
        // Pre-generation symptom recall controls what the model sees, but cannot prove a formula is
        // sufficient for the signed syndrome. Final identity locking is therefore based solely on
        // the post-M03 positive-sufficiency set.
        void preGenerationAllowed;
        // 治法对齐从这里就生效，而不是只在下面的系统自锁支路生效。原先「模型选的方」只过
        // identityLockEligible + positiveSufficiency 两道门，于是签名治法「清热利湿退黄，通腑泄热」
        // 的阳黄例里，模型选导赤散（清心利水养阴）会被原样锁定并写成「导赤散加减」。
        // 判据见 formulaTherapyAlignedWithSigned：只否决两侧都抽得出治法词且交集为空的情形。
        const signedMethodIds = signedTherapyMethodIds(parsed);
        const allowed = new Set(reasoningCandidates
          .filter((entry) => formulaTherapyAlignedWithSigned(entry.functions, signedMethodIds))
          .flatMap((entry) => [entry.name, ...entry.aliases])
          .map((entry) => entry.replace(/\s+/g, ""))
          .filter((name) => lockEligible.has(name)));
        const names = Array.isArray(parsed.overview.recommendedFormulaNames)
          ? parsed.overview.recommendedFormulaNames.filter((name): name is string => typeof name === "string")
          : [];
        // 证候级检索里已通过确定性核验、可直接锁定的方（top1 锁定，其余留作医生备选）。
        //
        // 判据与「校验模型选的方」完全同源：identityLockEligible（目录有证候标注）
        // + positiveSufficiency（已签名主证候与该方存在受控正向关系）+ lockEligible（目录级可锁）。
        // 也就是说，系统自己提出的方要过的是**和模型提出的方一模一样的那道门**，没有任何放宽。
        //
        // 治法对齐这道门原本**只写在这一处**（系统自锁支路），加它的理由记在下面：
        // 湿热内蕴证(阳黄)召回到导赤散(功效「清心利水养阴」,主治末句恰好写着「属湿热内蕴者」
        // 故证候标签命中),而本例签名治法是「清热利湿退黄,通腑泄热」。把导赤散挂成阳黄的方名,
        // 比输出自拟方更坏——医生会照着抓药。
        // 但系统把方摆到医生面前的路有三条,当时只堵了这一条;判据现已上移为共用导出
        // formulaTherapyAlignedWithSigned,三处同源(见其注释与实测)。
        const systemLockable = reasoningCandidates
          .filter((entry) => formulaTherapyAlignedWithSigned(entry.functions, signedMethodIds))
          .map((entry) => entry.name)
          .filter((name) => lockEligible.has(name.replace(/\s+/g, "")));
        // 模型未给方名（自拟）时：若证候级检索找到了满足充分性的受治理经典方，锁定其首选。
        //
        // 原实现只把它放进 deferredFormulaSelection「仅供参考、不锁定、不进 M04」。实测代价：
        // 20 例线上语料里 16 例系统本就检索到了正解方（肾阳虚→金匮肾气丸、脾虚湿盛→参苓白术散、
        // 胃热炽盛→清胃散、风热犯表→银翘散、心脾两虚→归脾汤），却因为不锁定而一律输出「本例辨证
        // 组方」——甲方看到的自拟方比例 74%，主因就是这一条。医生拿到的是一张没有出处的方，
        // 而系统手里明明握着一条**受控治理关系**。
        //
        // 锁定的证据强度高于模型自由选择：它绑定的是已签名主证候与该方的受控正向关系，
        // 而不是模型的一次生成。留痕完整：候选全表写入 deferredFormulaSelection，
        // reason 标明来源，医生可据此改选。fail-closed 不变——一条都不满足时仍走自拟方。
        if (names.length === 0) {
          if (systemLockable.length === 0 || parsed.overview.deferredFormulaSelection) return match;
          parsed.overview.deferredFormulaSelection = {
            direction: typeof parsed.overview.recommendedFormulaDirection === "string"
              ? parsed.overview.recommendedFormulaDirection
              : "按已锁定病机与治法辨证组方",
            names: systemLockable.slice(0, 3),
            mode: systemLockable.length > 1 ? "alternatives" : "single",
            reason: "system_retrieved_governed_lock",
          };
          parsed.overview.recommendedFormulaNames = [systemLockable[0]];
          parsed.overview.formulaSelectionMode = "single";
          parsed.overview.recommendedFormulaDirection = `${systemLockable[0]}加减（按已签名证候反查受控目录锁定，医生可改选）`;
          return `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(parsed, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
        }
        if (names.every((name) => allowed.has(name.replace(/\s+/g, "")))) return match;
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
        } else if (
          typeof originalDirection === "string" &&
          (originalMode === "single" || originalMode === "combined" || originalMode === "alternatives")
        ) {
          // 作废不等于抹掉。此前只有「术语映射待医生确认」这一种作废会留痕，其余一律**静默**清空——
          // 医生看到的是一张自拟方，看不到系统本来锁的是什么，也看不到是因为什么被撤。
          // 实测（阳黄例，签名主证「湿热内蕴证」）：模型选中的是本例金标准方**茵陈蒿汤**，
          // 只因受治理目录里茵陈蒿汤的 syndromeTags 不含「湿热内蕴」这个 id（是目录数据缺口，
          // 不是临床错误）而被清空，全链路再无痕迹——M04 的 declassifiedFromFormulaNames 兜底
          // 取的正是 prior.overview.recommendedFormulaNames，此时已空。
          //
          // 留痕不放宽锁定：names/mode 仍然清空、仍走自拟方（fail-closed 不变），
          // 只是把模型的原选择与撤销原因写进签名信封，供医生复核与 M04 剥名说明使用。
          // 同时这也止住了修复轮的反向指挥——missedLockableFormulaCandidates 见到
          // deferredFormulaSelection 即返回 []（那是"系统自己的处置"，不是"模型的遗漏"），
          // 否则它会接着把治法不对的替代方标成「已通过正向充分性核验」喂回给模型。
          parsed.overview.deferredFormulaSelection = {
            direction: originalDirection,
            names,
            mode: originalMode,
            reason: "governed_syndrome_relation_unverified",
          };
        }
        // 模型选了方但没通过核验时：**不用系统的方顶替**，仍走自拟方。
        //
        // 这条边界是实测逼出来的，不是保守。曾让系统在这里也补位，20 例可锁定率 45%→80%，
        // 但湿热内蕴证（阳黄）出现了致命一例：模型选的是茵陈蒿汤（本例金标准方），
        // 因证候特征层的释义并集差异未通过核验被驳回，系统改锁了同样通过核验的**导赤散**
        //（清心利水养阴）。医生会照着抓药——把不对证的方挂上方名，比输出自拟方坏得多。
        //
        // 区别在于「模型有没有看着本例做过选择」：
        //   · 模型没选 ⇒ 系统补位只是**增加信息**，不与任何临床判断冲突；
        //   · 模型选了但没过核验 ⇒ 驳回它是对的，但换一个模型从未考虑过的方是越权。
        // 后者仍降为自拟方（既有 fail-closed 行为不变），模型原选留痕待医生复核。
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


/**
 * 仅供 scripts/test-*.mjs 与等价性实测使用。导出的是**只读引用**，不提供任何写入口。
 * 这里要证的是「遍历索引词 includes」与「切病历查索引」命中集合等价——
 * 该等价性此前只是一句注释，而本仓库已经因为「照抄注释里的等价性声称」踩过坑。
 */
export const __retrievalInternalsForTest = {
  INDICATION_TERM_INDEX,
  indicationTerms,
} as const;
