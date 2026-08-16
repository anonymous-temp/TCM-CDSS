import type { ClinicalStateStatus } from "./clinical-state";
import { clinicalClausePolarity, clinicalEventTemporalScopeAt } from "./clinical-polarity";
import redFlagTriageJson from "../data/redflag-triage-lexicon.json" with { type: "json" };

/**
 * 结构化临床语义分诊层。
 *
 * 目标:本模块用 LLM 作**受约束的追加语义发现器**,同时判断事实极性和处置紧急度。
 * 它可以发现口语化风险并提出优先复核/澄清，但不能单独拥有硬红旗门权；硬门只由确定性规则或
 * 已校验生命体征触发。语义层不可用时，确定性层仍独立工作。
 *
 * 四护栏:
 *  1. schema reject —— 严格校验结构/枚举,任一非法条目使整份结果失效并进入受限修复。
 *  2. 原文 grounding —— 每条 finding 必须给出**原文逐字片段(quote)**且该片段确在输入文本中,否则丢弃
 *     (杜绝 LLM 凭空造红旗 → 假阳性)。
 *  3. 双轴纪律 —— status 描述事实极性，urgency 描述处置层级；只有 positive + emergency 才进入红旗。
 *  4. 处置可解释 —— urgent/clarify 进入高信息量追问，routine 只进入后续诊断，不改变流程。
 *
 * 默认关闭:未提供 clinicalFacts 时所有合并函数为 no-op,行为与现状完全一致。
 */

export const BACKSTOP_RED_FLAG_CATEGORIES = {
  cardiac: "胸痛/胸闷伴急性心血管风险",
  syncope: "晕厥/黑矇/意识丧失",
  neuro: "急性神经功能异常（剧烈头痛/意识改变/言语不清/肢体无力）",
  gi_bleed: "消化道出血（呕血/黑便/便血）",
  // 受治理词表 redflag-triage-lexicon.json 有 18 类，本表此前只有 17 类，**唯独少 gi_alarm**。
  // 后果不是少一个标签：buildClinicalFactsExtractionPrompt 用本表生成「类目键只能取以下之一」，
  // 同一段提示词却把全部 18 类的受治理规则（含 gi_alarm）喂给模型——
  // 模型看得到规则、选不了键；就算硬选，解析处 `!(category in BACKSTOP_RED_FLAG_CATEGORIES)`
  // 会静默丢弃。于是**整个上消化道警示征象类别在语义回补层结构性失明**，
  // 而语义层的全部意义正是接住确定性层漏掉的口语表述。
  // （2026-08-16：确定性层与词表已加 gi_alarm，本表没跟上——同一修复只做了一半。）
  gi_alarm: "上消化道警示征象（吞咽/进食梗阻、恶性肿瘤病史伴消化道症状、不明原因消瘦）",
  bleeding: "其他急性出血（咯血/阴道流血/外伤出血/出血不止）",
  acute_abdomen: "急腹症（急性剧烈腹痛/腹胀）",
  respiratory: "急性呼吸困难/端坐呼吸",
  sepsis: "发热伴寒战/脓毒症风险",
  mental_crisis: "自杀/自伤/伤人意念或行为",
  shock: "休克或循环灌注不足风险",
  anaphylaxis: "严重过敏反应或气道受累风险",
  obstetric: "妊娠相关急症风险",
  pediatric_critical: "儿童全身危重表现",
  poisoning: "急性中毒或药物过量风险",
  metabolic: "严重低血糖或代谢紊乱风险",
  vital_instability: "生命体征异常需优先复核",
  other_critical: "其他可能立即改变处置路径的急危重线索",
} as const;

export type BackstopRedFlagCategory = keyof typeof BACKSTOP_RED_FLAG_CATEGORIES;

const RED_FLAG_MESSAGE: Record<BackstopRedFlagCategory, string> = {
  cardiac: "AI语义分诊提示：当前信息支持急性心血管红旗，需立即完成急诊评估",
  syncope: "AI语义分诊提示：当前信息支持意识丧失相关红旗，需立即评估循环及神经系统急症",
  neuro: "AI语义分诊提示：当前信息支持急性神经功能异常红旗，需立即完成卒中等急症评估",
  gi_bleed: "AI语义分诊提示：当前信息支持消化道出血红旗，需立即评估出血严重度",
  gi_alarm: "AI语义分诊提示：当前信息支持上消化道警示征象，需优先安排内镜或专科评估以排除恶性梗阻",
  bleeding: "AI语义分诊提示：当前信息支持急性出血红旗，需立即评估出血与循环状态",
  acute_abdomen: "AI语义分诊提示：当前信息支持急腹症红旗，需立即完成腹部急症评估",
  respiratory: "AI语义分诊提示：当前信息支持急性呼吸受损红旗，需立即评估呼吸与循环",
  sepsis: "AI语义分诊提示：当前信息支持严重感染红旗，需立即评估感染及循环状态",
  mental_crisis: "AI语义分诊提示：当前信息支持行为危机红旗，需立即进行现场安全评估并联系精神专科或急诊",
  shock: "AI语义分诊提示：当前信息支持循环灌注不足红旗，需立即完成生命体征与循环评估",
  anaphylaxis: "AI语义分诊提示：当前信息支持严重过敏或气道受累红旗，需立即评估气道、呼吸和循环",
  obstetric: "AI语义分诊提示：当前信息支持妊娠相关急症红旗，需立即完成产科急症评估",
  pediatric_critical: "AI语义分诊提示：当前信息支持儿童危重表现，需立即完成急诊评估",
  poisoning: "AI语义分诊提示：当前信息支持急性中毒或药物过量红旗，需立即核实暴露并急诊处置",
  metabolic: "AI语义分诊提示：当前信息支持严重代谢紊乱红旗，需立即床旁评估",
  vital_instability: "AI语义分诊提示：当前生命体征与临床表现共同支持急危重风险，需立即现场评估",
  other_critical: "AI语义分诊提示：当前信息支持可能立即改变处置路径的急危重红旗，需接诊医生立即复核",
};

const TRIAGE_ADVISORY_MESSAGE: Record<BackstopRedFlagCategory, string> = {
  cardiac: "心血管相关表现需优先复核",
  syncope: "意识丧失或黑矇相关表现需优先复核",
  neuro: "神经系统相关表现需优先复核",
  gi_bleed: "消化道出血相关表现需优先复核",
  gi_alarm: "上消化道警示征象需优先复核",
  bleeding: "出血相关表现需优先复核",
  acute_abdomen: "腹部急症相关表现需优先复核",
  respiratory: "呼吸相关表现需优先复核",
  sepsis: "感染相关表现需优先复核",
  mental_crisis: "情志危机相关表现需优先复核",
  shock: "循环灌注相关表现需优先复核",
  anaphylaxis: "严重过敏相关表现需优先复核",
  obstetric: "妊娠相关表现需优先复核",
  pediatric_critical: "儿童全身状态需优先复核",
  poisoning: "可疑中毒或药物过量需优先复核",
  metabolic: "代谢异常相关表现需优先复核",
  vital_instability: "生命体征异常需优先复测并结合症状评估",
  other_critical: "当前异常表现需优先复核",
};

export const TRIAGE_BASIS = {
  acute_target_organ_damage: "急性靶器官损害",
  time_sensitive_cardiovascular_event: "疑似时间敏感性急性心血管事件",
  airway_breathing_failure: "气道或呼吸衰竭",
  shock_or_anaphylaxis: "休克或严重过敏反应",
  acute_neurologic_deficit: "急性神经功能缺损",
  major_active_bleeding: "活动性大出血",
  active_behavioral_crisis: "正在发生的自伤或伤人危机",
  obstetric_emergency: "产科急症",
  extreme_vital_instability: "极端生命体征不稳定",
  other_immediate_threat: "其他明确的即时生命威胁",
  urgent_review: "需尽快优先评估",
  clarification_needed: "需补充关键信息后分级",
  routine_care: "常规诊疗",
} as const;

export type TriageBasis = keyof typeof TRIAGE_BASIS;

const EMERGENCY_TRIAGE_BASES: ReadonlySet<TriageBasis> = new Set([
  "acute_target_organ_damage",
  "time_sensitive_cardiovascular_event",
  "airway_breathing_failure",
  "shock_or_anaphylaxis",
  "acute_neurologic_deficit",
  "major_active_bleeding",
  "active_behavioral_crisis",
  "obstetric_emergency",
  "extreme_vital_instability",
  "other_immediate_threat",
]);

const CATEGORY_EMERGENCY_BASES: Record<BackstopRedFlagCategory, ReadonlySet<TriageBasis>> = {
  cardiac: new Set(["time_sensitive_cardiovascular_event", "acute_target_organ_damage", "shock_or_anaphylaxis", "other_immediate_threat"]),
  syncope: new Set(["time_sensitive_cardiovascular_event", "acute_neurologic_deficit", "shock_or_anaphylaxis", "other_immediate_threat"]),
  neuro: new Set(["acute_neurologic_deficit", "other_immediate_threat"]),
  gi_bleed: new Set(["major_active_bleeding", "shock_or_anaphylaxis", "other_immediate_threat"]),
  // 与 gi_bleed 刻意不同：警示征象本身是**限时排查恶性梗阻**，不是即刻威胁生命。
  // 只有合并活动性出血或循环失代偿时才升到 emergency；单纯吞咽梗阻/消瘦走提示与优先转诊，
  // 不占用急诊通道。放宽到 other_immediate_threat 会让每一个进食困难病人都弹急诊。
  gi_alarm: new Set(["major_active_bleeding", "shock_or_anaphylaxis"]),
  bleeding: new Set(["major_active_bleeding", "shock_or_anaphylaxis", "other_immediate_threat"]),
  acute_abdomen: new Set(["shock_or_anaphylaxis", "other_immediate_threat"]),
  respiratory: new Set(["airway_breathing_failure", "shock_or_anaphylaxis", "other_immediate_threat"]),
  sepsis: new Set(["shock_or_anaphylaxis", "extreme_vital_instability", "other_immediate_threat"]),
  mental_crisis: new Set(["active_behavioral_crisis"]),
  shock: new Set(["shock_or_anaphylaxis", "extreme_vital_instability"]),
  anaphylaxis: new Set(["shock_or_anaphylaxis", "airway_breathing_failure"]),
  obstetric: new Set(["obstetric_emergency", "major_active_bleeding", "shock_or_anaphylaxis"]),
  pediatric_critical: new Set(["airway_breathing_failure", "shock_or_anaphylaxis", "extreme_vital_instability", "other_immediate_threat"]),
  poisoning: new Set(["airway_breathing_failure", "acute_neurologic_deficit", "shock_or_anaphylaxis", "other_immediate_threat"]),
  metabolic: new Set(["acute_neurologic_deficit", "shock_or_anaphylaxis", "extreme_vital_instability", "other_immediate_threat"]),
  vital_instability: new Set(["acute_target_organ_damage", "airway_breathing_failure", "shock_or_anaphylaxis", "extreme_vital_instability"]),
  other_critical: EMERGENCY_TRIAGE_BASES,
};

export type RedFlagFinding = {
  category: BackstopRedFlagCategory;
  subject: "patient" | "other" | "uncertain";
  status: ClinicalStateStatus;
  urgency: "emergency" | "urgent" | "clarify" | "routine";
  triageBasis: TriageBasis;
  quote: string;
  /** Model-synthesized, additive-only escalation from multiple separately grounded facts. */
  escalationRationale?: string;
  escalationEvidenceQuotes?: string[];
};

export const CLINICAL_FACTS_EXTRACTOR_VERSION = "tcm-cdss-clinical-facts-triage-v19";
export const CLINICAL_FACTS_PROMPT_VERSION = "tcm-cdss-clinical-facts-triage-prompt-v21";

// 劳力/活动诱发的慢性基线症状限定词（“平路气短”“活动后气促”“劳力性胸闷”）：在已知慢性心肺肾
// 疾病或慢性病程框架下，这类限定描述的是基线功能状态而非急性事件；静息/夜间/端坐/新发/突发/
// 进行性加重/伴胸痛大汗等急性线索出现时不在此列。
const BASELINE_EXERTIONAL_MARKER = /(?:平路|平地|步行|走路|上楼|爬楼|爬坡|活动后|运动后|劳累后|劳力性|劳力|快步|快走|干活|体力活动)/;
const CARDIOPULMONARY_BASELINE_CONTEXT = /(?:心衰|心力衰竭|HF|EF\s*\d{1,2}\s*%?|射血分数|冠心病|心绞痛|心肌梗死|陈旧性心梗|COPD|慢阻肺|哮喘|肺心病|CKD|慢性肾|肾功能不全|尿毒症|支气管扩张|间质性肺|肺纤维化)/i;
const CHRONIC_COURSE_MARKER = /(?:(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:年|个月|月)|多年|数年|长期|平素|一直)/;
const ACUTE_ESCALATION_MARKER = /(?:夜间阵发|端坐呼吸|不能平卧|无法平卧|平卧困难|憋醒|痛醒|新发|突发|突然|急性|明显加重|进行性|加重|恶化|不缓解|难以缓解|大汗|冷汗|濒死|胸痛|晕厥|意识(?:模糊|障碍|改变)|咳粉红|粉红色泡沫|发绀|口唇发紫|嘴唇发紫|咯血)/;

type GovernedRedFlagCategoryRule = {
  id: string;
  symptoms: string[];
  dangerCompanions: string[];
};

const GOVERNED_RED_FLAG_CATEGORY_RULES = redFlagTriageJson.categoryRules as GovernedRedFlagCategoryRule[];
const GOVERNED_CARDIAC_RULE = (() => {
  const rule = GOVERNED_RED_FLAG_CATEGORY_RULES.find((item) => item.id === "cardiac");
  if (!rule) throw new Error("缺少 T6 cardiac 红旗治理分类");
  return rule;
})();
const GOVERNED_NEURO_RULE = (() => {
  const rule = GOVERNED_RED_FLAG_CATEGORY_RULES.find((item) => item.id === "neuro") as
    | (GovernedRedFlagCategoryRule & { benignDowngrade?: { benignSymptoms: string[]; dangerExclusions: string[] } })
    | undefined;
  if (!rule?.benignDowngrade) throw new Error("缺少 T6 neuro 红旗治理分类或 benignDowngrade 边界");
  return rule as GovernedRedFlagCategoryRule & { benignDowngrade: { benignSymptoms: string[]; dangerExclusions: string[] } };
})();
const NEURO_ACUTE_ONSET_MARKERS = (redFlagTriageJson.dimensions?.acuteOnset as string[] | undefined) ?? [];

function containsAnyGovernedTerm(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function isNonAcuteIsolatedChestTightnessFinding(finding: RedFlagFinding, sourceText: string): boolean {
  if (finding.category !== "cardiac" || finding.subject !== "patient" ||
      (finding.status !== "positive" && finding.status !== "possible")) return false;
  const nonTightnessCardiacSymptoms = GOVERNED_CARDIAC_RULE.symptoms.filter((term) => term !== "胸闷");
  let offset = sourceText.indexOf(finding.quote);
  while (offset >= 0) {
    let sentenceStart = offset;
    while (sentenceStart > 0 && !MAJOR_CLAUSE_BOUNDARY.test(sourceText[sentenceStart - 1])) sentenceStart -= 1;
    let sentenceEnd = offset + finding.quote.length;
    while (sentenceEnd < sourceText.length && !MAJOR_CLAUSE_BOUNDARY.test(sourceText[sentenceEnd])) sentenceEnd += 1;
    const sentence = sourceText.slice(sentenceStart, sentenceEnd);
    const hasNonAcuteCourse = /(?:[2-9]|[一二两三四五六七八九十半数几多])\s*(?:周|月|年)|半个月|数周|数月|多年/.test(sentence);
    const isolatedTightness = sentence.includes("胸闷") && !containsAnyGovernedTerm(sentence, nonTightnessCardiacSymptoms);
    const hasDangerCompanion = containsAnyGovernedTerm(sentence, GOVERNED_CARDIAC_RULE.dangerCompanions);
    const governedBaselineContext = BASELINE_EXERTIONAL_MARKER.test(sentence) || CARDIOPULMONARY_BASELINE_CONTEXT.test(sentence);
    if (hasNonAcuteCourse && isolatedTightness && !hasDangerCompanion && !governedBaselineContext && !ACUTE_ESCALATION_MARKER.test(sentence)) return true;
    offset = sourceText.indexOf(finding.quote, offset + finding.quote.length);
  }
  return false;
}

// T6 neuro category boundary: a plain headache/dizziness complaint is the single most common benign
// outpatient chief complaint (眩晕/头痛/不寐). A batch model routinely overcalls it as a neuro
// "clarify" advisory, which then renders as a "神经系统相关表现需优先复核" card and couples a
// pre-prescription clarification. Cap the ENTIRE benign-head-symptom class deterministically — but
// ONLY the model's own clarify-level advisory, and ONLY when the quote's sentence contains no
// governed neuro emergency symptom, acute-onset qualifier, dangerCompanion, or posterior-circulation
// / meningeal danger term. This is strictly monotonic (clarify → routine, visibility only drops) and
// never touches emergency/urgent, so it is mathematically incapable of erasing a hard neuro red flag
// (雷击样头痛/卒中样起病 stay). Danger boundary is governed in redflag-triage-lexicon.json, not
// hardcoded, so the excluded-sign list is auditable and extendable in one place.
function isBenignHeadSymptomNeuroFinding(finding: RedFlagFinding, sourceText: string): boolean {
  if (finding.category !== "neuro" || finding.subject !== "patient" || finding.urgency !== "clarify") return false;
  if (finding.status !== "positive" && finding.status !== "possible") return false;
  const { benignSymptoms, dangerExclusions } = GOVERNED_NEURO_RULE.benignDowngrade;
  const blockingTerms = [
    ...GOVERNED_NEURO_RULE.symptoms,
    ...GOVERNED_NEURO_RULE.dangerCompanions,
    ...NEURO_ACUTE_ONSET_MARKERS,
    ...dangerExclusions,
  ];
  let offset = sourceText.indexOf(finding.quote);
  while (offset >= 0) {
    let sentenceStart = offset;
    while (sentenceStart > 0 && !MAJOR_CLAUSE_BOUNDARY.test(sourceText[sentenceStart - 1])) sentenceStart -= 1;
    let sentenceEnd = offset + finding.quote.length;
    while (sentenceEnd < sourceText.length && !MAJOR_CLAUSE_BOUNDARY.test(sourceText[sentenceEnd])) sentenceEnd += 1;
    const sentence = sourceText.slice(sentenceStart, sentenceEnd);
    const hasBenignHeadSymptom = containsAnyGovernedTerm(sentence, benignSymptoms);
    const hasBlockingTerm = containsAnyGovernedTerm(sentence, blockingTerms);
    if (hasBenignHeadSymptom && !hasBlockingTerm) return true;
    offset = sourceText.indexOf(finding.quote, offset + finding.quote.length);
  }
  return false;
}

// quote 级底线：劳力诱发限定 + 无急性线索的 quote 达不到 emergency 的证据底线（与 syncope 等
// 既有 quote 底线同一机制），降级为 urgent 走优先复核而非急性红旗。
function exertionalBaselineQuoteWithoutAcuteCue(quote: string): boolean {
  return BASELINE_EXERTIONAL_MARKER.test(quote) && !ACUTE_ESCALATION_MARKER.test(quote);
}

export type ClinicalFactsSemanticStatus = "checked" | "unavailable";
export type ClinicalFactsResultSource = "fresh" | "cache" | "failure";
export type ClinicalFactsUnavailableReason = "disabled" | "aborted" | "timeout" | "model_error" | "invalid_output" | "signing_unavailable";
export type ClinicalFactsReviewStatus = "checked" | "skipped" | "unavailable";

export type ClinicalFactsModelIdentity = {
  provider: string;
  model: string;
};

export type ClinicalFactsModelTrace = {
  extractor: ClinicalFactsModelIdentity;
  reviewer?: ClinicalFactsModelIdentity;
  adjudicator?: ClinicalFactsModelIdentity;
  independentReview: boolean;
  independentAdjudication: boolean;
  separateInvocationReview?: boolean;
  separateInvocationAdjudication?: boolean;
};

export type EncounterScope = {
  status: "active_current_target" | "historical_or_stable_only" | "unclear";
  quote: string;
  reviewAgreement?: "agreed" | "disagreed" | "unreviewed";
};

/**
 * 病历中**明确记载为阳性**的症状(2026-08-05)。
 *
 * 用途单一:核对模型写出的「病历已记录否认X」是否与原文矛盾。
 * 此前该核对完全靠词表 + 正则作用域,词表未收录的症状(瘀斑、肿胀、乏力、纳差…)
 * 根本不进入检查,模型的错误否认直接放行——线上 60 例语料实测 4 例误判即出于此。
 * 症状是开放集合,靠补词表穷举不完;而「这句话是不是在陈述该症状存在」本就是语义判断。
 *
 * 与规则层的分工(规则引导式,不是替代):
 *  · 规则层:词表命中的症状照旧确定性判定,本字段不参与,既有行为完全不变;
 *  · 本字段:补上词表未覆盖的那一半,由抽取模型在同一次调用里顺带给出;
 *  · 兜底:抽取不可用时本字段为空,核对退回纯规则,不产生新的降级。
 *
 * 方向单调:只能把「否认X」降级为「尚未确认X」,不能反向把「尚未确认」升成「否认」。
 * 因此模型判错的最坏后果是多一条待核实项,而不是把存在的症状说成不存在。
 */
export type AffirmedSymptom = {
  /** 症状名,尽量用病历原词。 */
  term: string;
  /** 病历中的原文依据,必须是原文子串。 */
  quote: string;
};

export type ClinicalFacts = {
  redFlags: RedFlagFinding[];
  /** 病历明确记载为阳性的症状;仅用于否认核对,不参与红旗与门禁判定。 */
  affirmedSymptoms?: AffirmedSymptom[];
  encounterScope?: EncounterScope;
  sourceFingerprint?: string;
  sourceCoverage?: "full" | "partial";
  sourceCharCount?: number;
  semanticStatus?: ClinicalFactsSemanticStatus;
  resultSource?: ClinicalFactsResultSource;
  unavailableReason?: ClinicalFactsUnavailableReason;
  reviewStatus?: ClinicalFactsReviewStatus;
  attestationVersion?: string;
  extractorVersion?: string;
  promptVersion?: string;
  extractedAt?: string;
  modelTrace?: ClinicalFactsModelTrace;
  attestation?: string;
};

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "positive", "possible", "negative", "historical", "unknown",
]);
const VALID_URGENCIES: ReadonlySet<string> = new Set([
  "emergency", "urgent", "clarify", "routine",
]);
const VALID_SUBJECTS: ReadonlySet<string> = new Set(["patient", "other", "uncertain"]);

// 口语化显性消化道出血 + 循环灌注不足组合是急诊处置的确定性严重度下限。LLM 仍负责
// 主体、极性和事件识别；一旦它已落地为患者当前阳性 gi_bleed，不能再因“像柏油一样”或
// “站起来眼前发黑”不是标准术语而把这一整类组合降成普通追问。
const OVERT_GI_BLEED_LANGUAGE = /(?:呕血|吐血|咖啡(?:色|样)(?:呕吐物|胃内容物|液体|黏液|粘液|物)|黑便|黑色便|柏油样便|便血|(?:拉|排|解|大便|粪便)[^，,。；;\n]{0,12}(?:像|如同|跟)?[^，,。；;\n]{0,4}柏油|(?:又黑又亮|黑得发亮|黑亮便))/;
const BLEEDING_HYPOPERFUSION_LANGUAGE = /(?:(?:站起|站立|起身|坐起|体位改变)[^，,。；;\n]{0,12})?(?:眼前发黑|黑矇|差点晕|要晕倒|晕厥|意识(?:不清|模糊|异常)|冷汗|心悸|面色苍白|头晕乏力|头晕|乏力)/;
const REPEATED_OR_MULTI_DAY_BLEEDING_LANGUAGE = /(?:大量|反复|多次|不止|持续出血|喷射|[2-9]\s*次|两次|三次|(?:这|近)?(?:两|三|[2-9])\s*(?:天|日))/;
const EXPLICIT_MILD_ABDOMINAL_PAIN_LANGUAGE = /(?:(?:腹|肚子|上腹|下腹|左下腹|右下腹)[^，,。；;\n]{0,6}(?:痛|疼)[^，,。；;\n]{0,8}(?:不是很重|不太重|不重|较轻|轻微|轻度|隐痛)|(?:轻微|轻度|较轻)[^，,。；;\n]{0,4}(?:腹痛|肚子痛|肚子疼))/;
const ACUTE_ABDOMEN_DANGER_LANGUAGE = /(?:突发|突然|剧烈|疼得厉害|明显加重|越来越|进行性|反跳痛|松手更疼|腹肌紧张|板状腹|休克|晕厥|意识改变|反复呕吐|持续呕吐|高热|停止排气排便|不排气|不排便|呕血|黑便|便血)/;
const NON_EXTREME_HIGH_FEVER_LANGUAGE = /(?:体温|T)\s*[:：]?\s*3[89](?:\.\d+|度\d+)?\s*(?:℃|\u00b0C|度)?/i;
const STABLE_MENTATION_LANGUAGE = /(?:神志|意识)(?:清楚|清醒|正常)/;
const STABLE_BREATHING_LANGUAGE = /呼吸(?:平稳|正常)|无(?:呼吸困难|气促|喘憋)/;
const FEVER_EMERGENCY_LANGUAGE = /(?:神志|意识)(?:模糊|不清|障碍|改变)|嗜睡|谵妄|烦躁|呼吸困难|呼吸急促|气促|喘憋|休克|低血压|四肢湿冷|肢端湿冷|皮肤花斑|花斑|尿量.{0,4}减少|少尿|无尿|发绀|口唇发紫|抽搐/;

function hasCurrentAffirmedPattern(text: string, pattern: RegExp): boolean {
  for (const match of text.matchAll(new RegExp(pattern.source, "g"))) {
    if (match[0] && hasCurrentQuoteOccurrence(text, match[0], false)) return true;
  }
  return false;
}

function hasMajorActiveGiBleedingLanguage(text: string): boolean {
  return hasCurrentAffirmedPattern(text, OVERT_GI_BLEED_LANGUAGE) && (
    hasCurrentAffirmedPattern(text, BLEEDING_HYPOPERFUSION_LANGUAGE) ||
    hasCurrentAffirmedPattern(text, REPEATED_OR_MULTI_DAY_BLEEDING_LANGUAGE)
  );
}

function isExplicitlyLowRiskAbdominalPainFinding(finding: RedFlagFinding, sourceText: string): boolean {
  if (finding.category !== "acute_abdomen" || finding.subject !== "patient" ||
    finding.status !== "positive" || (finding.urgency !== "emergency" && finding.urgency !== "urgent")) return false;
  let offset = sourceText.indexOf(finding.quote);
  while (offset >= 0) {
    let sentenceStart = offset;
    while (sentenceStart > 0 && !MAJOR_CLAUSE_BOUNDARY.test(sourceText[sentenceStart - 1])) sentenceStart -= 1;
    let sentenceEnd = offset + finding.quote.length;
    while (sentenceEnd < sourceText.length && !MAJOR_CLAUSE_BOUNDARY.test(sourceText[sentenceEnd])) sentenceEnd += 1;
    const sentence = sourceText.slice(sentenceStart, sentenceEnd);
    if (hasCurrentAffirmedPattern(sentence, EXPLICIT_MILD_ABDOMINAL_PAIN_LANGUAGE) &&
      !hasCurrentAffirmedPattern(sentence, ACUTE_ABDOMEN_DANGER_LANGUAGE)) return true;
    offset = sourceText.indexOf(finding.quote, offset + finding.quote.length);
  }
  return false;
}

function isExplicitlyStableNonExtremeFeverFinding(finding: RedFlagFinding, sourceText: string): boolean {
  if ((finding.category !== "sepsis" && finding.category !== "vital_instability") ||
    finding.subject !== "patient" || finding.status !== "positive" || finding.urgency !== "emergency") return false;
  return hasCurrentAffirmedPattern(sourceText, NON_EXTREME_HIGH_FEVER_LANGUAGE) &&
    STABLE_MENTATION_LANGUAGE.test(sourceText) && STABLE_BREATHING_LANGUAGE.test(sourceText) &&
    !hasCurrentAffirmedPattern(sourceText, FEVER_EMERGENCY_LANGUAGE);
}

function emergencyEvidenceFloorSatisfied(
  category: BackstopRedFlagCategory,
  triageBasis: TriageBasis,
  quote: string,
): boolean {
  if (triageBasis === "extreme_vital_instability") {
    const bp = /(?:血压|BP)?\s*(\d{2,3})\s*\/\s*(\d{2,3})/i.exec(quote);
    const temperature = /(?:体温|T)?\s*(\d{2}(?:\.\d+)?)\s*(?:℃|度)/i.exec(quote);
    const pulse = /(?:心率|脉搏|P)\s*[:：]?\s*(\d{2,3})\s*次\/分/i.exec(quote);
    const respiration = /(?:呼吸|R)\s*[:：]?\s*(\d{1,2})\s*次\/分/i.exec(quote);
    const spo2 = /(?:SpO2|血氧(?:饱和度)?)\s*[:：]?\s*(\d{1,3})\s*%/i.exec(quote);
    return Boolean(
      (bp && (Number(bp[1]) >= 220 || Number(bp[1]) <= 80 || Number(bp[2]) >= 130)) ||
      (temperature && (Number(temperature[1]) >= 40 || Number(temperature[1]) < 35)) ||
      (pulse && (Number(pulse[1]) >= 150 || Number(pulse[1]) < 40)) ||
      (respiration && (Number(respiration[1]) >= 35 || Number(respiration[1]) <= 8)) ||
      (spo2 && Number(spo2[1]) <= 89)
    );
  }
  if (triageBasis === "major_active_bleeding") {
    return hasMajorActiveGiBleedingLanguage(quote) ||
      /大量|反复|多次|不止|持续出血|咖啡(?:色|样)|鲜血|喷射|(?:这|近)?(?:两|三|[2-9])天.{0,12}(?:黑便|黑色便|柏油|便血|咯血|呕血)|(?:呕血|黑便|黑色便|柏油样便|便血|咯血).{0,12}(?:[2-9]\s*次|两次|三次|[2-9]\s*(?:日|天)|两日|两天|三日|三天|头晕|乏力|晕厥|黑矇|意识|冷汗|心悸|面色苍白)/.test(quote);
  }
  if (category === "acute_abdomen" && triageBasis === "other_immediate_threat") {
    return /突发|剧烈|疼得厉害|板状腹|反跳痛|腹膜刺激|休克|持续呕吐|晕厥|意识改变/.test(quote);
  }
  if (category === "neuro" && triageBasis === "acute_neurologic_deficit") {
    return /突发|突然|雷击|爆炸|言语不清|说不出话|口角歪斜|肢体.{0,6}(?:无力|麻木|抬不起来)|(?:左|右)(?:侧)?[^，,。；;\n]{0,6}(?:无力|麻木|抬不起来)|偏瘫|视物重影|行走不稳|抽搐|意识改变/.test(quote);
  }
  if (category === "syncope") {
    return /意识.{0,8}(?:未恢复|不清|模糊|异常)|严重外伤|进行性|呼吸困难|气促|胸痛|大汗|低血压|休克|反复晕厥/.test(quote);
  }
  if ((category === "cardiac" || category === "respiratory") && exertionalBaselineQuoteWithoutAcuteCue(quote)) {
    return false;
  }
  return true;
}

/**
 * 护栏 1:逐项 schema 隔离。模型偶尔会在一个正确红旗后附带重复但不合约的次要 finding；
 * 不能让该附加项抹掉前面的合法急症事实。合法项继续进入 grounding，非法项被丢弃；只有模型
 * 明确返回了非空数组却没有任何合法项时才返回 null，避免非法结果坍缩成“权威空集”。
 */
export function parseClinicalFacts(raw: unknown): ClinicalFacts | null {
  const root = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!root || typeof root !== "object") return null;
  const list = (root as { redFlags?: unknown }).redFlags;
  if (!Array.isArray(list)) return null;
  const redFlags: RedFlagFinding[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const {
      category,
      subject,
      status,
      urgency,
      triageBasis,
      quote,
      escalationRationale,
      escalationEvidenceQuotes,
    } = item as Record<string, unknown>;
    if (typeof category !== "string" || !(category in BACKSTOP_RED_FLAG_CATEGORIES)) continue;
    if (typeof subject !== "string" || !VALID_SUBJECTS.has(subject)) continue;
    if (typeof status !== "string" || !VALID_STATUSES.has(status)) continue;
    if (typeof quote !== "string" || !quote.trim()) continue;
    const parsedUrgency = typeof urgency === "string" && VALID_URGENCIES.has(urgency)
      ? urgency as RedFlagFinding["urgency"]
      : undefined;
    const parsedTriageBasis = typeof triageBasis === "string" && triageBasis in TRIAGE_BASIS
      ? triageBasis as TriageBasis
      : undefined;
    if (!parsedUrgency || !parsedTriageBasis) continue;
    const dispositionContractSatisfied = parsedUrgency === "emergency"
      ? status === "positive" && EMERGENCY_TRIAGE_BASES.has(parsedTriageBasis) &&
        CATEGORY_EMERGENCY_BASES[category as BackstopRedFlagCategory].has(parsedTriageBasis)
      : parsedUrgency === "urgent"
        ? status === "positive" && parsedTriageBasis === "urgent_review"
        : parsedUrgency === "clarify"
          ? (status === "positive" || status === "possible") && parsedTriageBasis === "clarification_needed"
          : (status === "positive" || status === "negative" || status === "historical" || status === "unknown") &&
            parsedTriageBasis === "routine_care";
    const subjectContractSatisfied = subject !== "uncertain" || (
      parsedUrgency === "clarify" && parsedTriageBasis === "clarification_needed"
    );
    if (!dispositionContractSatisfied || !subjectContractSatisfied) continue;
    const parsedEscalationQuotes = Array.isArray(escalationEvidenceQuotes)
      ? [...new Set(escalationEvidenceQuotes
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value.length >= 2 && value.length <= 200))]
      : [];
    const parsedEscalationRationale = typeof escalationRationale === "string"
      ? escalationRationale.trim().slice(0, 600)
      : "";
    const validEscalation = parsedEscalationRationale.length >= 6 &&
      parsedEscalationQuotes.length >= 2 && parsedEscalationQuotes.length <= 6;
    const evidenceFloorText = validEscalation
      ? [quote.trim(), ...parsedEscalationQuotes].join("；")
      : quote.trim();
    const evidenceFloorSatisfied = parsedUrgency !== "emergency" || emergencyEvidenceFloorSatisfied(
      category as BackstopRedFlagCategory,
      parsedTriageBasis,
      evidenceFloorText,
    );
    redFlags.push({
      category: category as BackstopRedFlagCategory,
      subject: subject as RedFlagFinding["subject"],
      status: status as ClinicalStateStatus,
      // A first reader cannot acquire irreversible emergency authority from a quote that only
      // supports the prompt's urgent tier. Preserve the grounded finding and fail closed for formal
      // prescription, but cap it at urgent so the independent reviewer can still correct it.
      urgency: evidenceFloorSatisfied ? parsedUrgency : "urgent",
      triageBasis: evidenceFloorSatisfied ? parsedTriageBasis : "urgent_review",
      quote: quote.trim().slice(0, 200),
      ...(validEscalation ? {
        escalationRationale: parsedEscalationRationale,
        escalationEvidenceQuotes: parsedEscalationQuotes,
      } : {}),
    });
  }
  if (list.length > 0 && redFlags.length === 0) return null;
  const rawEncounterScope = (root as { encounterScope?: unknown }).encounterScope;
  const encounterStatus = rawEncounterScope && typeof rawEncounterScope === "object"
    ? memberOf(
        (rawEncounterScope as { status?: unknown }).status,
        ["active_current_target", "historical_or_stable_only", "unclear"] as const,
      )
    : undefined;
  const encounterQuote = rawEncounterScope && typeof rawEncounterScope === "object"
    ? boundedString((rawEncounterScope as { quote?: unknown }).quote, 240)
    : undefined;
  const encounterReviewAgreement = rawEncounterScope && typeof rawEncounterScope === "object"
    ? memberOf(
        (rawEncounterScope as { reviewAgreement?: unknown }).reviewAgreement,
        ["agreed", "disagreed", "unreviewed"] as const,
      )
    : undefined;
  const encounterScope = encounterStatus && encounterQuote
    ? {
        status: encounterStatus,
        quote: encounterQuote,
        reviewAgreement: encounterReviewAgreement || "unreviewed" as const,
      }
    : undefined;
  const sourceFingerprint = typeof (root as { sourceFingerprint?: unknown }).sourceFingerprint === "string"
    ? (root as { sourceFingerprint: string }).sourceFingerprint.slice(0, 80)
    : undefined;
  const sourceCoverage = memberOf(
    (root as { sourceCoverage?: unknown }).sourceCoverage,
    ["full", "partial"] as const,
  );
  const sourceCharCountValue = (root as { sourceCharCount?: unknown }).sourceCharCount;
  const sourceCharCount = typeof sourceCharCountValue === "number" && Number.isSafeInteger(sourceCharCountValue) && sourceCharCountValue >= 0
    ? sourceCharCountValue
    : undefined;
  const semanticStatus = memberOf(
    (root as { semanticStatus?: unknown }).semanticStatus,
    ["checked", "unavailable"] as const,
  );
  const resultSource = memberOf(
    (root as { resultSource?: unknown }).resultSource,
    ["fresh", "cache", "failure"] as const,
  );
  const unavailableReason = memberOf(
    (root as { unavailableReason?: unknown }).unavailableReason,
    ["disabled", "aborted", "timeout", "model_error", "invalid_output", "signing_unavailable"] as const,
  );
  const reviewStatus = memberOf(
    (root as { reviewStatus?: unknown }).reviewStatus,
    ["checked", "skipped", "unavailable"] as const,
  );
  const attestationVersion = boundedString((root as { attestationVersion?: unknown }).attestationVersion, 80);
  const extractorVersion = boundedString((root as { extractorVersion?: unknown }).extractorVersion, 80);
  const promptVersion = boundedString((root as { promptVersion?: unknown }).promptVersion, 80);
  const extractedAtValue = boundedString((root as { extractedAt?: unknown }).extractedAt, 40);
  const extractedAt = extractedAtValue && Number.isFinite(Date.parse(extractedAtValue)) ? extractedAtValue : undefined;
  const rawModelTrace = (root as { modelTrace?: unknown }).modelTrace;
  const modelIdentity = (value: unknown): ClinicalFactsModelIdentity | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const provider = boundedString((value as { provider?: unknown }).provider, 80);
    const model = boundedString((value as { model?: unknown }).model, 120);
    return provider && model ? { provider, model } : undefined;
  };
  const extractorIdentity = rawModelTrace && typeof rawModelTrace === "object"
    ? modelIdentity((rawModelTrace as { extractor?: unknown }).extractor)
    : undefined;
  const reviewerIdentity = rawModelTrace && typeof rawModelTrace === "object"
    ? modelIdentity((rawModelTrace as { reviewer?: unknown }).reviewer)
    : undefined;
  const adjudicatorIdentity = rawModelTrace && typeof rawModelTrace === "object"
    ? modelIdentity((rawModelTrace as { adjudicator?: unknown }).adjudicator)
    : undefined;
  const independentReview = rawModelTrace && typeof rawModelTrace === "object"
    ? (rawModelTrace as { independentReview?: unknown }).independentReview
    : undefined;
  const independentAdjudication = rawModelTrace && typeof rawModelTrace === "object"
    ? (rawModelTrace as { independentAdjudication?: unknown }).independentAdjudication
    : undefined;
  const separateInvocationReview = rawModelTrace && typeof rawModelTrace === "object"
    ? (rawModelTrace as { separateInvocationReview?: unknown }).separateInvocationReview
    : undefined;
  const separateInvocationAdjudication = rawModelTrace && typeof rawModelTrace === "object"
    ? (rawModelTrace as { separateInvocationAdjudication?: unknown }).separateInvocationAdjudication
    : undefined;
  const modelTrace = extractorIdentity && typeof independentReview === "boolean" && typeof independentAdjudication === "boolean"
    ? {
        extractor: extractorIdentity,
        ...(reviewerIdentity ? { reviewer: reviewerIdentity } : {}),
        ...(adjudicatorIdentity ? { adjudicator: adjudicatorIdentity } : {}),
        independentReview,
        independentAdjudication,
        ...(typeof separateInvocationReview === "boolean" ? { separateInvocationReview } : {}),
        ...(typeof separateInvocationAdjudication === "boolean" ? { separateInvocationAdjudication } : {}),
      }
    : undefined;
  const attestation = typeof (root as { attestation?: unknown }).attestation === "string" && /^hmac-sha256:[a-f0-9]{64}$/.test((root as { attestation: string }).attestation)
    ? (root as { attestation: string }).attestation
    : undefined;
  // 阳性症状:此处只做**结构校验**(字段存在、长度合理)。
  // 引用接地(quote 必须是病历原文子串)由运行时在拿得到原文的地方执行——
  // parseClinicalFacts 只接收模型输出,看不到病历,不能在这里假装校验过。
  // 接地失败的条目静默丢弃而非使整份失效:它只用于「不把存在的症状说成否认」这一个用途,
  // 少一条的后果是该症状退回纯规则判定(即现状),不会引入新错误。
  const rawAffirmed = (root as { affirmedSymptoms?: unknown }).affirmedSymptoms;
  const affirmedSymptoms = Array.isArray(rawAffirmed)
    ? rawAffirmed.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const term = String((item as { term?: unknown }).term || "").trim();
        const quote = String((item as { quote?: unknown }).quote || "").trim();
        if (term.length < 1 || term.length > 20 || quote.length < 2) return [];
        return [{ term, quote }];
      }).slice(0, 40)
    : [];

  return {
    // An unavailable semantic check cannot carry forward findings from an earlier successful run.
    redFlags: semanticStatus === "unavailable" ? [] : redFlags,
    affirmedSymptoms: semanticStatus === "unavailable" ? undefined : affirmedSymptoms,
    encounterScope: semanticStatus === "unavailable" ? undefined : encounterScope,
    sourceFingerprint,
    sourceCoverage,
    sourceCharCount,
    semanticStatus,
    resultSource,
    unavailableReason: semanticStatus === "unavailable" ? unavailableReason : undefined,
    reviewStatus,
    attestationVersion,
    extractorVersion,
    promptVersion,
    extractedAt,
    modelTrace,
    attestation,
  };
}

const MAJOR_CLAUSE_BOUNDARY = /[。！？!?；;\n]/;
const NEW_ASSERTION_AFTER_COMMA = /^(?:但|但是|然而|不过|而|另有|同时)?\s*(?:(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:小时|天|日|周|月|年)前\s*)?(?:既往|曾经|过去|此前|以往|当前|目前|现阶段|本次|今日|今天|今晨|今早|昨夜|昨晚|昨日|近来|近期)?\s*(?:否认|不是|并非|不曾|没有|并无|未见|未发现|未出现|未再|不再|不伴|从未|无|暂无|已排除|已除外|有|是|转为|突发|新发|出现|发生|排出|患有|确诊|诊断为|再次|复发)/;
const RESOLVED_WITHIN_QUOTE = /(?:现已|目前已|已经|已)(?:消失|缓解|好转|痊愈)|(?:未再|不再)(?:出现|发作|发生)|现无|目前无/;
const DIRECT_NEGATION_BEFORE_QUOTE = /(?:否认|不是(?!很|太|特别|十分|非常|明显|严重|剧烈|轻|重|持续|一直)|并非(?!很|太|特别|十分|非常|明显|严重|剧烈|轻|重|持续|一直)|不曾|没有|并无|未见|未发现|未提示|未出现|不伴|从未|无|暂无|已排除|已除外)[^，,。！？!?；;\n]{0,16}$/;
const NON_NEGATING_MODIFIER_BEFORE_QUOTE = /(?:无(?:明显|明确)?(?:诱因|原因|诱发因素)|无(?:痛性|菌性|创性|症状性|脉性|意识性))\s*$/;
const DIRECT_NEGATION_AFTER_QUOTE = /^\s*(?:已排除|已除外|未见(?:明显)?异常|未发现(?:明显)?异常|不支持|不考虑|不存在|阴性)/;

// Temporal/resolution markers that can ground a historical_or_stable_only quote on their own.
const ENCOUNTER_TEMPORAL_HISTORICAL_MARKER = /(?:既往|曾经|此前|过去|\d+\s*(?:天|周|月|年)前|已(?:治愈|痊愈|缓解|消失|恢复)|目前(?:已)?无|当前(?:已)?无|现(?:已)?无|无新发|未再发|恢复期|后遗)/;
// Stability markers （目前稳定/当前稳定/稳定期） also match DISEASE-CONTROL phrasing ("血压控制
// 稳定", "规律服药，病情平稳"), which describes the state of an underlying disease, not the
// resolution of the visit target. They can ground historical_or_stable_only only when the quote
// is not framed as disease control/medication management.
const ENCOUNTER_STABILITY_MARKER = /目前稳定|当前稳定|稳定期/;
const ENCOUNTER_DISEASE_CONTROL_FRAME = /控制|达标|平稳|规律服药|规律用药|服药|用药|治疗方案|血压|血糖|血脂/;

/** 护栏 2:原文 grounding + positive 本地极性复核。 */
export function groundClinicalFacts(facts: ClinicalFacts, sourceText: string): ClinicalFacts {
  const scopeQuote = facts.encounterScope?.quote || "";
  const encounterScope = facts.encounterScope && sourceText.includes(scopeQuote) && (
    facts.encounterScope.status !== "historical_or_stable_only" ||
    ENCOUNTER_TEMPORAL_HISTORICAL_MARKER.test(scopeQuote) ||
    (ENCOUNTER_STABILITY_MARKER.test(scopeQuote) && !ENCOUNTER_DISEASE_CONTROL_FRAME.test(scopeQuote))
  )
    ? facts.encounterScope
    : undefined;
  const groundedRedFlags = facts.redFlags.filter((f) => {
    if (f.quote.length < 2 || !sourceText.includes(f.quote)) return false;
    if (f.status !== "positive" && f.status !== "possible") return true;
    return hasCurrentQuoteOccurrence(sourceText, f.quote, f.status === "possible");
  }).map((finding) => {
    if (finding.escalationRationale) {
      const evidenceQuotes = finding.escalationEvidenceQuotes || [];
      const escalationGrounded = evidenceQuotes.length >= 2 && evidenceQuotes.every((quote) =>
        sourceText.includes(quote) && hasCurrentQuoteOccurrence(sourceText, quote, false));
      if (!escalationGrounded) {
        const withoutInvalidEscalation = { ...finding };
        delete withoutInvalidEscalation.escalationRationale;
        delete withoutInvalidEscalation.escalationEvidenceQuotes;
        return finding.urgency === "emergency"
          ? { ...withoutInvalidEscalation, urgency: "urgent" as const, triageBasis: "urgent_review" as const }
          : withoutInvalidEscalation;
      }
    }
    // T6 cardiac category boundary: an isolated, non-acute chest-tightness complaint without any
    // category-specific danger companion is routine diagnostic context. A model may still overcall
    // it during a long batch; cap the entire class deterministically so identical records cannot
    // oscillate between ready and emergency across runs.
    if (isNonAcuteIsolatedChestTightnessFinding(finding, sourceText)) {
      return { ...finding, urgency: "routine" as const, triageBasis: "routine_care" as const };
    }
    // T6 neuro category boundary: plain headache/dizziness clarify-level overcall → routine
    // diagnostic context. Governed danger boundary blocks the downgrade whenever any emergency
    // symptom / acute-onset qualifier / posterior-circulation sign is present in the same sentence.
    if (isBenignHeadSymptomNeuroFinding(finding, sourceText)) {
      return { ...finding, urgency: "routine" as const, triageBasis: "routine_care" as const };
    }
    // 明确轻度腹痛且同一事件无突发剧烈、进行性加重、腹膜刺激征、反复呕吐、
    // 高热或出血等危险组合时，不能只因“腹痛”症状名被模型升为 urgent/emergency。
    // 保留 clarify 以便门诊继续追问，而不把该类普通当前症状并入红旗处置。
    if (isExplicitlyLowRiskAbdominalPainFinding(finding, sourceText)) {
      return { ...finding, urgency: "clarify" as const, triageBasis: "clarification_needed" as const };
    }
    // 38–40℃ 发热伴寒战需要优先评估，但在原文同时明确神志和呼吸稳定、且无循环/意识/呼吸危象时，
    // 不能由语义模型单独升级为脓毒症 emergency。极高热(>=40℃)仍由确定性生命体征门禁处理。
    if (isExplicitlyStableNonExtremeFeverFinding(finding, sourceText)) {
      return { ...finding, urgency: "urgent" as const, triageBasis: "urgent_review" as const };
    }
    if (finding.category !== "gi_bleed" || finding.subject !== "patient" || finding.status !== "positive") {
      return finding;
    }
    let offset = sourceText.indexOf(finding.quote);
    while (offset >= 0) {
      let sentenceStart = offset;
      while (sentenceStart > 0 && !MAJOR_CLAUSE_BOUNDARY.test(sourceText[sentenceStart - 1])) sentenceStart -= 1;
      let sentenceEnd = offset + finding.quote.length;
      while (sentenceEnd < sourceText.length && !MAJOR_CLAUSE_BOUNDARY.test(sourceText[sentenceEnd])) sentenceEnd += 1;
      if (hasMajorActiveGiBleedingLanguage(sourceText.slice(sentenceStart, sentenceEnd))) {
        return { ...finding, urgency: "emergency" as const, triageBasis: "major_active_bleeding" as const };
      }
      offset = sourceText.indexOf(finding.quote, offset + finding.quote.length);
    }
    return finding;
  });
  return {
    ...facts,
    encounterScope,
    redFlags: groundedRedFlags,
  };
}

function hasCurrentQuoteOccurrence(sourceText: string, quote: string, allowUncertain: boolean): boolean {
  let offset = sourceText.indexOf(quote);
  while (offset >= 0) {
    if (isCurrentQuoteOccurrence(sourceText, quote, offset, allowUncertain)) return true;
    offset = sourceText.indexOf(quote, offset + quote.length);
  }
  return false;
}

// 同句急性线索覆盖：极性模块把“昨夜/昨晚”一律视为历史，但“昨夜突发夜间阵发性呼吸困难”是
// 本次急性事件。quote 所在硬句内若有未被远 past 锚点（半年前/N年前/既往/曾）限定、未被局部否定
// （无/未/否认）的急性起病或加重线索，则该 quote 仍按当前事件 grounding。缓解/否认等后续检查
// 在此之后照常执行，不会复活已缓解事件。
const SENTENCE_ACUTE_ONSET_MARKER = /(?:突发|突然|新发|再发|复发|又发|刚刚|刚才|方才|明显加重|进行性加重|快速加重|加重|端坐呼吸|不能平卧|无法平卧|夜间阵发)/;
const DISTANT_PAST_ANCHOR = /(?:既往|曾经|曾|当时|多年前|数年前|(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:年|个月|月|周)前)/;
const CUE_LOCAL_NEGATION = /(?:无|未|没有|否认|并未|也无|也没有)$/;

function hasSameSentenceAcuteCue(sourceText: string, quoteStart: number): boolean {
  let sentenceStart = quoteStart;
  while (sentenceStart > 0 && !MAJOR_CLAUSE_BOUNDARY.test(sourceText[sentenceStart - 1])) sentenceStart -= 1;
  let sentenceEnd = quoteStart;
  while (sentenceEnd < sourceText.length && !MAJOR_CLAUSE_BOUNDARY.test(sourceText[sentenceEnd])) sentenceEnd += 1;
  const sentence = sourceText.slice(sentenceStart, sentenceEnd);
  for (const match of sentence.matchAll(new RegExp(SENTENCE_ACUTE_ONSET_MARKER.source, "g"))) {
    const cueIndex = match.index ?? 0;
    let clauseStart = cueIndex;
    while (clauseStart > 0 && !/[，,、]/.test(sentence[clauseStart - 1])) clauseStart -= 1;
    const beforeCue = sentence.slice(clauseStart, cueIndex);
    if (DISTANT_PAST_ANCHOR.test(beforeCue)) continue;
    if (CUE_LOCAL_NEGATION.test(beforeCue.replace(/\s+/g, ""))) continue;
    return true;
  }
  return false;
}

function isCurrentQuoteOccurrence(sourceText: string, quote: string, quoteStart: number, allowUncertain: boolean): boolean {
  const quoteEnd = quoteStart + quote.length;
  let sentenceStart = quoteStart;
  while (sentenceStart > 0 && !MAJOR_CLAUSE_BOUNDARY.test(sourceText[sentenceStart - 1])) sentenceStart -= 1;
  let sentenceEnd = quoteEnd;
  while (sentenceEnd < sourceText.length && !MAJOR_CLAUSE_BOUNDARY.test(sourceText[sentenceEnd])) sentenceEnd += 1;

  const sentence = sourceText.slice(sentenceStart, sentenceEnd);
  const relativeQuoteStart = quoteStart - sentenceStart;
  let localStart = 0;
  for (const match of sentence.slice(0, relativeQuoteStart).matchAll(/[，,]/g)) {
    const commaEnd = (match.index || 0) + match[0].length;
    if (NEW_ASSERTION_AFTER_COMMA.test(sentence.slice(commaEnd))) localStart = commaEnd;
  }
  const localQuoteStart = relativeQuoteStart - localStart;
  const localQuoteEnd = localQuoteStart + quote.length;
  const localSentence = sentence.slice(localStart).replace(/^\s+/, "");
  const trimmedPrefix = sentence.slice(localStart).length - localSentence.length;
  const quoteStartInClause = Math.max(0, localQuoteStart - trimmedPrefix);
  const quoteEndInClause = Math.max(quoteStartInClause + quote.length, localQuoteEnd - trimmedPrefix);
  const beforeQuote = localSentence.slice(0, quoteStartInClause);
  const afterQuote = localSentence.slice(quoteEndInClause);

  const polarity = clinicalClausePolarity(quote);
  if (polarity !== "affirmed" && !(allowUncertain && polarity === "uncertain")) return false;
  if (DIRECT_NEGATION_BEFORE_QUOTE.test(beforeQuote) && !NON_NEGATING_MODIFIER_BEFORE_QUOTE.test(beforeQuote)) return false;
  if (clinicalEventTemporalScopeAt(sourceText, quoteStart, quote.length) !== "current" &&
      !hasSameSentenceAcuteCue(sourceText, quoteStart)) return false;
  if (/^\s*(?:病史|史)/.test(afterQuote)) return false;
  if (DIRECT_NEGATION_AFTER_QUOTE.test(afterQuote)) return false;
  if (RESOLVED_WITHIN_QUOTE.test(quote)) return false;

  const escapedQuote = escapeRegExp(quote);
  const directlyResolved = new RegExp(
    `${escapedQuote}[，,\\s]{0,4}(?:(?:现已|目前已|已经|已)(?:消失|缓解|好转|痊愈)|(?:未再|不再)(?:出现|发作|发生)|(?:现已|目前已)(?:无|没有))`,
  );
  return !directlyResolved.test(localSentence);
}

/**
 * 消费层慢性基线判别（与提取层 quote 底线同一类别规则，但能看到完整原文）：
 * cardiac/respiratory 类 emergency finding 的 quote 若只是劳力/活动诱发的基线症状
 * （“平路气短”“活动后气促”），且原文存在已知慢性心肺肾疾病背景或慢性病程，并且 quote 所在
 * 硬句没有任何急性变化线索（夜间阵发/端坐/不能平卧/新发/突发/加重/不缓解/胸痛大汗），
 * 则不升级为急性红旗——只保留为可见的优先复核提示（additive-only，不删除任何确定性结论）。
 * 含混情形（无劳力限定、无疾病背景）一律返回 false，维持保守升级（fail-closed）。
 */
function chronicBaselineFramedFinding(finding: RedFlagFinding, sourceText: string): boolean {
  if (finding.category !== "cardiac" && finding.category !== "respiratory") return false;
  if (finding.status !== "positive" || finding.urgency !== "emergency") return false;
  if (ACUTE_ESCALATION_MARKER.test(finding.quote)) return false;
  const quoteExertional = BASELINE_EXERTIONAL_MARKER.test(finding.quote);
  let offset = sourceText.indexOf(finding.quote);
  let sawOccurrence = false;
  let sawCourseInSentence = false;
  while (offset >= 0) {
    sawOccurrence = true;
    let sentenceStart = offset;
    while (sentenceStart > 0 && !MAJOR_CLAUSE_BOUNDARY.test(sourceText[sentenceStart - 1])) sentenceStart -= 1;
    let sentenceEnd = offset + finding.quote.length;
    while (sentenceEnd < sourceText.length && !MAJOR_CLAUSE_BOUNDARY.test(sourceText[sentenceEnd])) sentenceEnd += 1;
    const sentence = sourceText.slice(sentenceStart, sentenceEnd);
    if (ACUTE_ESCALATION_MARKER.test(sentence)) return false;
    if (!quoteExertional) {
      let clauseStart = offset;
      while (clauseStart > sentenceStart && !/[，,、]/.test(sourceText[clauseStart - 1])) clauseStart -= 1;
      let clauseEnd = offset + finding.quote.length;
      while (clauseEnd < sentenceEnd && !/[，,、]/.test(sourceText[clauseEnd])) clauseEnd += 1;
      if (!BASELINE_EXERTIONAL_MARKER.test(sourceText.slice(clauseStart, clauseEnd))) return false;
    }
    if (CHRONIC_COURSE_MARKER.test(sentence)) sawCourseInSentence = true;
    offset = sourceText.indexOf(finding.quote, offset + finding.quote.length);
  }
  if (!sawOccurrence) return false;
  return CARDIOPULMONARY_BASELINE_CONTEXT.test(sourceText) || sawCourseInSentence;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

function memberOf<const T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === "string" && values.includes(value as T[number]) ? value as T[number] : undefined;
}

function escalationExplanation(finding: RedFlagFinding): string {
  if (!finding.escalationRationale || !finding.escalationEvidenceQuotes?.length) return "";
  return `。${finding.escalationRationale}。相关患者原文：${finding.escalationEvidenceQuotes.join("、")}`;
}

export type StructuredRedFlagEvidence = {
  category: BackstopRedFlagCategory;
  sourceQuote: string;
  escalationRationale?: string;
  evidenceQuotes: string[];
};

/**
 * 将语义升级依据保留为结构化数据，供页面用 evidence chips 呈现。
 * 不把理由和逐字证据重新拼进一条告警字符串，避免括号嵌套和同句重复。
 */
export function structuredRedFlagEvidenceFromFacts(
  facts: ClinicalFacts | undefined,
  sourceText: string,
): StructuredRedFlagEvidence[] {
  if (!facts || facts.redFlags.length === 0) return [];
  const grounded = groundClinicalFacts(facts, sourceText).redFlags;
  const categories = new Set<BackstopRedFlagCategory>();
  const evidence: StructuredRedFlagEvidence[] = [];
  for (const finding of grounded) {
    if (
      finding.subject !== "patient" ||
      finding.status !== "positive" ||
      finding.urgency !== "emergency" ||
      chronicBaselineFramedFinding(finding, sourceText) ||
      categories.has(finding.category)
    ) continue;
    categories.add(finding.category);
    evidence.push({
      category: finding.category,
      sourceQuote: finding.quote,
      ...(finding.escalationRationale ? { escalationRationale: finding.escalationRationale } : {}),
      evidenceQuotes: [...new Set([finding.quote, ...(finding.escalationEvidenceQuotes || [])])].slice(0, 8),
    });
  }
  return evidence;
}

/**
 * 护栏 3+4:语义分诊合并(同步)。返回**待追加**的红旗消息:仅 grounded、positive 且 emergency、
 * 且类目尚未被确定性红旗覆盖的 finding 才生成消息。绝不移除 existingRedFlags 中的任何一条。
 * facts 缺省(默认关闭)时返回空数组 → no-op。
 */
export function additiveRedFlagsFromFacts(
  facts: ClinicalFacts | undefined,
  sourceText: string,
  existingRedFlags: readonly string[],
): string[] {
  if (!facts || facts.redFlags.length === 0) return [];
  const grounded = groundClinicalFacts(facts, sourceText).redFlags;
  const additions: string[] = [];
  const coveredCategories = new Set<BackstopRedFlagCategory>();
  for (const finding of grounded) {
    if (finding.subject !== "patient") continue;
    if (finding.status !== "positive" || finding.urgency !== "emergency") continue;
    // 已知慢性心肺疾病背景下的劳力性基线症状（无急性线索）不升级为急性红旗；
    // 该事实仍经 semanticTriageAdvisoriesFromFacts 以优先复核形式保持可见。
    if (chronicBaselineFramedFinding(finding, sourceText)) continue;
    if (coveredCategories.has(finding.category)) continue;
    const message = RED_FLAG_MESSAGE[finding.category];
    // 若确定性层已就该类目给出红旗(消息包含类目关键词),不重复追加。
    const alreadyCovered = existingRedFlags.some((existing) => overlapsCategory(existing, finding.category));
    if (alreadyCovered) continue;
    coveredCategories.add(finding.category);
    additions.push(message);
  }
  return additions;
}

/**
 * Preserve the model's non-emergency triage output as a visible, non-blocking clinical advisory.
 * The model owns semantic classification; this function only enforces source grounding, status/urgency
 * compatibility and category-level de-duplication.
 */
export function semanticTriageAdvisoriesFromFacts(
  facts: ClinicalFacts | undefined,
  sourceText: string,
): string[] {
  if (!facts || facts.redFlags.length === 0) return [];
  const grounded = groundClinicalFacts(facts, sourceText).redFlags;
  const advisories: string[] = [];
  const coveredCategories = new Set<BackstopRedFlagCategory>();
  for (const finding of grounded) {
    if (finding.subject === "other") continue;
    if (finding.subject === "uncertain") {
      if (coveredCategories.has(finding.category)) continue;
      coveredCategories.add(finding.category);
      advisories.push(`请确认“${finding.quote}”描述的是患者本人还是他人；确认前不据此改变患者分诊。`);
      continue;
    }
    if (finding.status !== "positive" && finding.status !== "possible") continue;
    // 被消费层判别为劳力性慢性基线的 emergency finding 降级为可见的优先复核提示：
    // 保持 additive-only 的可追溯性，但不形成急性红旗。
    const demotedBaselineEmergency = finding.urgency === "emergency" && chronicBaselineFramedFinding(finding, sourceText);
    if (finding.urgency !== "emergency" && finding.urgency !== "urgent" && finding.urgency !== "clarify" && !demotedBaselineEmergency) continue;
    if (coveredCategories.has(finding.category)) continue;
    coveredCategories.add(finding.category);
    const action = finding.urgency === "emergency" && !demotedBaselineEmergency
      ? "建议立即由接诊医生现场复核并按复核结果处置；本条语义发现不单独形成硬门"
      : finding.urgency === "urgent" || demotedBaselineEmergency
        ? "建议优先评估"
        : "建议在本轮问诊中澄清";
    advisories.push(`${TRIAGE_ADVISORY_MESSAGE[finding.category]}，${action}。原文依据：“${finding.quote}”${escalationExplanation(finding)}`);
  }
  return advisories;
}

/**
 * Grounded model findings that require priority assessment or one disposition-changing clarification
 * before formal prescription adoption. This is derived from structured model semantics rather than a
 * symptom list: emergency findings hard-stop, while urgent/clarify findings keep M03 available but
 * prevent an unresolved risk question from silently becoming a full-dose prescription.
 */
export function priorityEvaluationItemsFromFacts(
  facts: ClinicalFacts | undefined,
  sourceText: string,
): string[] {
  if (!facts || facts.redFlags.length === 0) return [];
  const grounded = groundClinicalFacts(facts, sourceText).redFlags;
  const items: string[] = [];
  const coveredCategories = new Set<BackstopRedFlagCategory>();
  for (const finding of grounded) {
    if (finding.subject !== "patient" ||
        (finding.status !== "positive" && finding.status !== "possible") ||
        (finding.urgency !== "emergency" && finding.urgency !== "urgent" && finding.urgency !== "clarify")) continue;
    if (coveredCategories.has(finding.category)) continue;
    coveredCategories.add(finding.category);
    const action = finding.urgency === "emergency"
      ? "需立即现场复核并完成相应处置后再评估处方"
      : finding.urgency === "urgent"
        ? "处方前需完成评估"
        : "处方前需澄清";
    items.push(`${TRIAGE_ADVISORY_MESSAGE[finding.category]}；${action}。原文依据：“${finding.quote}”${escalationExplanation(finding)}`);
  }
  return items;
}

const CATEGORY_DEDUP_KEYWORDS: Record<BackstopRedFlagCategory, RegExp> = {
  cardiac: /心血管|冠脉|胸痛|胸闷/,
  syncope: /晕厥|黑矇|意识丧失/,
  neuro: /神经系统|剧烈头痛|意识改变|言语不清|肢体无力/,
  gi_bleed: /消化道出血|呕血|黑便|便血/,
  // 去重关键词刻意与 gi_bleed 不重叠：两类同现时（胃癌术后 + 黑便）必须各自保留一条，
  // 一条是出血处置、一条是恶性梗阻排查，合并会丢掉后者。
  gi_alarm: /上消化道警示|吞咽困难|进食梗阻|噎膈|恶性梗阻|不明原因消瘦/,
  bleeding: /咯血|阴道流血|外伤出血|出血不止|急性出血/,
  acute_abdomen: /急腹症|腹痛|腹胀/,
  respiratory: /呼吸困难|端坐呼吸|呼吸循环/,
  sepsis: /脓毒症|寒战|严重感染/,
  mental_crisis: /自杀|自伤|伤害他人|轻生/,
  shock: /休克|循环灌注|低血压/,
  anaphylaxis: /严重过敏|过敏性休克|气道受累/,
  obstetric: /产科|妊娠|孕期|阴道流血/,
  pediatric_critical: /儿童|患儿|发绀|精神萎靡/,
  poisoning: /中毒|药物过量|毒物/,
  metabolic: /低血糖|代谢紊乱|酮症酸中毒/,
  vital_instability: /生命体征|血压|心率|脉搏|呼吸频率|血氧|体温/,
  other_critical: /急危重|立即改变处置|优先复核/,
};

/**
 * Categories already represented by grounded, current patient findings.
 * Consumers use this to de-duplicate only the same risk category instead of allowing one semantic
 * finding to suppress unrelated deterministic fallback advisories.
 */
export function groundedPatientTriageCategories(
  facts: ClinicalFacts | undefined,
  sourceText: string,
): ReadonlySet<BackstopRedFlagCategory> {
  if (!facts || facts.redFlags.length === 0) return new Set();
  return new Set(
    groundClinicalFacts(facts, sourceText).redFlags
      .filter((finding) =>
        finding.subject === "patient" &&
        (finding.status === "positive" || finding.status === "possible") &&
        (finding.urgency === "emergency" || finding.urgency === "urgent" || finding.urgency === "clarify"))
      .map((finding) => finding.category),
  );
}

function overlapsCategory(existingMessage: string, category: BackstopRedFlagCategory): boolean {
  return CATEGORY_DEDUP_KEYWORDS[category].test(existingMessage);
}

function safeJsonParse(text: string): unknown {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export const CLINICAL_FACTS_EXTRACTION_SYSTEM_PROMPT =
  "你是门诊安全分诊和就诊目标分层的结构化临床语义判断器。理解口语、否定、时序、严重程度和当前状态；把普通症状与真正急诊级红旗分开，并判断本次是否存在当前治疗目标；不得补充患者未写明的信息。";

export const CLINICAL_FACTS_REVIEW_SYSTEM_PROMPT =
  "你是独立的门诊分诊复核医师。你必须重新阅读患者原文，质疑初判，统一处置层级；不能因首轮结论而锚定，也不能补充原文没有的事实。";

export function buildClinicalFactsExtractionPrompt(text: string): string {
  const categories = Object.entries(BACKSTOP_RED_FLAG_CATEGORIES)
    .map(([key, label]) => `  "${key}"（${label}）`)
    .join("\n");
  const governedCategoryRules = redFlagTriageJson.categoryRules.map((rule) =>
    `- ${rule.id}｜症状：${rule.symptoms.join("、")}｜限定维度：${rule.qualifiers.join("、")}｜危险伴随：${rule.dangerCompanions.join("、") || "无"}｜硬门条件：${rule.hardGateRequires}`,
  ).join("\n");
  return [
    "从下面【临床文本】中识别急危重红旗线索。先在内部完成口语归一、否定与时序判断，只输出**一个 JSON 对象**，不要正文/代码围栏/解释。",
    "格式：{\"redFlags\":[{\"category\":<类目键>,\"subject\":<patient|other|uncertain>,\"status\":<positive|possible|negative|historical|unknown>,\"urgency\":<emergency|urgent|clarify|routine>,\"triageBasis\":<处置依据键>,\"quote\":<原文逐字片段>,\"escalationRationale\":<可选：多线索合成升级理由>,\"escalationEvidenceQuotes\":<可选：2-6条原文逐字片段>}],\"affirmedSymptoms\":[{\"term\":<症状名>,\"quote\":<原文逐字片段>}],\"encounterScope\":{\"status\":<active_current_target|historical_or_stable_only|unclear>,\"quote\":<原文逐字片段>}}",
    "affirmedSymptoms：文本中**明确陈述为存在**的症状，不限于红旗类目，常见如瘀斑、肿胀、乏力、纳差、腰酸、多梦等一律照收；每条 quote 必须逐字来自原文。被否定的（无X、否认X）与未提及的一律不收。该字段仅用于核对后续结论有没有把已记录的症状误写成否认，不参与任何分级判定。",
    "类目键只能取以下之一：",
    categories,
    "T6 类目组合边界（用于语义发现与澄清；不得把词表做无差别组合，也不得由模型单独形成硬门）：",
    governedCategoryRules,
    "处置依据键只能取以下之一：",
    Object.entries(TRIAGE_BASIS).map(([key, label]) => `  \"${key}\"（${label}）`).join("\n"),
    "硬规则：",
    "- encounterScope 判断本次就诊是否有可作为辨证/治疗目标的当前阳性症状、功能问题或异常指标。active_current_target=有明确当前目标；historical_or_stable_only=只有既往已治愈/已缓解事件、当前无症状，或无新发变化的稳定背景/后遗状态且没有本次活动性目标；unclear=原文不足以判断。既往疾病名称本身、正常舌脉和正常生命体征不能单独成为当前目标。",
    "- 当前治疗/医疗处置请求或当前不适症状一律判 active_current_target：要求开药、加用中药、调理、治疗、续药、调整方案、咨询用药等当前请求，以及头晕、疼痛、乏力、胀满、口干等任何当前不适主诉，即使其背后的原发病被描述为控制稳定、达标或规律服药，也必须选 active_current_target。‘控制稳定、血压达标、病情平稳’描述的是疾病状态而不是本次就诊目标，绝不能单独作为 historical_or_stable_only 的 grounding quote；historical_or_stable_only 的 quote 中不得包含当前症状或当前治疗请求。",
    "- encounterScope.quote 必须是能单独证明该状态的最短连续原文逐字片段。若同一病历同时存在新的当前阳性问题，即使另一个既往问题已稳定，也必须选 active_current_target 并引用当前阳性问题；不得被‘无某一红旗’误导为全局无症状。",
    "- subject 必须说明该事实属于谁：患者本人用 patient；明确是家属、朋友、同事、室友、其他患者或被引用/教学病例用 other；文本无法判断主体时用 uncertain。只有 patient 能改变当前患者分诊，不能把陪诊者、其他患者、引用病例或宣教文本的急症算到患者身上。subject=uncertain 必须使用 urgency=clarify 与 triageBasis=clarification_needed，留待确认主体。",
    "- quote 必须是【临床文本】中**逐字出现**的片段(用于核验),不得改写、不得翻译、不得凭空生成。",
    "- quote 必须取能够单独证明该 finding 的最短连续原文片段，不要把同句中无关的否认、既往史、陈旧检查或其他症状一起抄入。",
    "- 同一句出现‘否认A，但/然而出现B’时，B 的 finding 只引用 B 的当前阳性片段；当前急性事件后写有既往/上周/两周前检查时，只引用当前事件，不把陈旧检查并入 quote。",
    "- ‘无明显诱因胸痛’表示胸痛没有明确诱因，不是‘无胸痛’；应只引用其中的当前症状片段，例如原文存在时可引用‘胸痛伴大汗1小时’。这是一条修饰关系原则，须同样适用于其他‘无明确原因/诱因’表达。",
    "- redFlags 是处置分诊集合，不是一般症状抽取集合。只输出会导致立即急诊、尽快优先评估，或仅差一个高信息问题就可能改变这两类处置的事实。普通、轻度、稳定或已有明确低风险限定的症状留给后续 M03，不输出到 redFlags。",
    "- 处置优先级看严重度、时序和进展轨迹，不看症状名本身。明确轻度且稳定/改善，并无危险组合时不进入 redFlags；短期持续进展、明显加重，且当前严重度或处置关键信息未明时，至少作为 clarify/urgent 的非阻断处置线索。这一原则适用于所有症状。",
    "- 只报确有文本依据的处置线索;文本未提及的类目不要输出。若文本已明确限定为轻度/稳定，并否认该类急症的主要危险组合，不得仅因症状名称将其塞入红旗类目。",
    "- 逐项识别所有会改变处置优先级的当前事实；不能因为同一句否认了另一个症状，就遗漏‘但/同时/随后’之后的当前阳性事实。",
    "- 被明确否认的(如“否认黑便”“无胸痛”)用 status=negative;既往已缓解用 historical;当前阳性用 positive;疑似/不确定用 possible。",
    "- ‘差点/险些/几乎/像要/感觉要’描述的是未完成或近似事件，不得直接当作该事件已经发生；应按原文语义归入 possible/clarify，除非同一文本另有明确已发生事实。该原则适用于晕厥、跌倒、呕吐、抽搐等所有事件。",
    "- urgency 与 status 分开判断：emergency=现有资料本身已足以要求立即急诊/急救评估；urgent=需尽快优先评估但现有资料不支持立即急诊；clarify=事实、严重度或当前状态仍需一个问题澄清；routine=普通阳性症状，进入常规诊疗即可。",
    "- triageBasis 必须与 urgency 一致：emergency 只能使用疑似时间敏感性急性心血管事件、急性靶器官损害、呼吸衰竭、休克/严重过敏、急性神经缺损、活动性大出血、行为危机、产科急症、极端生命体征或其他明确即时威胁对应的键；urgent/clarify/routine 分别使用 urgent_review/clarification_needed/routine_care。",
    "- 当前持续或新发胸痛疑似时间敏感性心血管事件时使用 time_sensitive_cardiovascular_event；不要把胸痛本身误写成 acute_target_organ_damage，除非文本另有明确急性靶器官损害。",
    "- 当前未缓解的胸痛按疑似时间敏感性心血管事件标 emergency，即使伴随症状尚未记录；单纯含糊胸闷通常先 urgent/clarify，若同时存在持续气促、大汗、晕厥或明显进行性加重，则按当前组合重新判断是否 emergency。",
    "- 单次少量黑便、便血、呕血或外伤后渗血，且当前稳定、没有灌注不足表现时通常标 urgent/clarify；反复显性出血，或出血同时伴头晕乏力、晕厥、意识/循环异常等灌注不足线索，现有资料已足以按活动性大出血或其他即时威胁标 emergency。不能因为缺少血红蛋白或生命体征记录就把这种组合降级。",
    "- 同一危险事件的伴随表现用于提高主事件严重度时，优先合并为一个最能代表处置路径的 finding，避免重复拆成多个类目。例如柏油样黑便伴站立眼前发黑应由 gi_bleed + major_active_bleeding 表达；不要再输出一个使用 major_active_bleeding 的 syncope finding。每条 triageBasis 都必须属于该 category 允许的急诊依据。",
    "- 当单条线索均未达到升级阈值、但同一当前事件的多条事实组合后足以提升处置层级时，可在代表处置路径的一个 finding 中填写 escalationRationale，并用 escalationEvidenceQuotes 列出 2-6 条分别支撑合成判断的最短连续原文逐字片段。不得引用人口学信息本身冒充危险事实，不得跨患者主体、跨既往与当前事件拼接，不得用未提及/未知项补全组合。该字段只能追加或升级语义发现，绝不能降低任何确定性结论。",
    "- 单次晕厥后已清醒且当前稳定通常标 urgent；伴持续意识异常、严重外伤、进行性心肺症状或循环不稳时才标 emergency。",
    "- 突发雷击样剧烈头痛、当前新发或较稳定基线明显加重的局灶神经功能缺损标 emergency；只有‘剧烈头痛’但起病方式和神经体征不明时标 urgent/clarify。突发剧烈、短病程腹痛本身已构成急腹症待排，应标 emergency；仅持续加重但未见突发剧烈、腹膜刺激征、休克或持续呕吐时先 urgent/clarify。腹膜刺激征的口语表达同样构成急腹症：‘按下去松手更疼/松手更疼’（反跳痛）、腹肌紧张、板状腹，或腹痛伴反复呕吐（≥2次）、高热、停止排气排便，均按 acute_abdomen + emergency，不得因主诉口语化（肚子疼/右下肚子疼）而降级。",
    "- emergency 既可由当前持续严重症状、意识/循环/呼吸受损、显著进行性恶化构成，也可由‘突发严重短病程’、‘稳定基线上新近局灶缺损’、‘反复显性出血伴灌注不足’等时间敏感组合构成。未记录某个伴随症状不等于明确否认，不能以资料缺项作为降级依据。单独的慢性、间歇、运动诱发、夜间偶发症状，以及没有当前严重度信息的表达，不得仅因症状名称标 emergency。",
    "- 孤立的重度但非极端生命体征（如血压180-219/120-129、心率120-149或40-49、呼吸25-34、SpO2 90-91%、体温39.0-39.9或35.0-35.9）一般标为 vital_instability + urgent；只有达到极端值，或与急性靶器官损害、意识/呼吸/循环不稳定等表现组成明确急症时才可标 emergency。",
    "- 发热（sepsis/严重感染类）的 emergency 线与确定性生命体征阈值一致：体温≥40℃，或发热同时伴循环/意识/呼吸受损（意识改变、嗜睡、烦躁、谵妄、低血压或休克征象、四肢湿冷、皮肤花斑、呼吸急促困难、尿量明显减少、发绀、抽搐）时才可标 emergency；38–40℃ 发热伴寒战但神志清楚、呼吸平稳、循环稳定时只标 urgent（sepsis 或 vital_instability + urgent_review），不得仅凭高热度数或寒战标 emergency。",
    "- 血压>180/120但明确没有胸痛、呼吸困难、急性神经异常、意识改变等急性靶器官症状时，不得仅凭血压值标 emergency，应标 vital_instability + urgent_review。",
    "- negative/historical/unknown 的 urgency 必须为 routine；possible 必须为 clarify。positive 可根据完整上下文取 emergency、urgent、clarify 或 routine；positive+clarify 表示症状存在已确认，但严重度或当前处置分级尚待澄清。",
    "- 没有合适专类但原文确实提示可能立即改变处置路径时，使用 other_critical；不得把普通慢性症状、常规检查缺失或一般鉴别诊断放入该类。",
    "- 不做任何超出文本的事实补全；不得把‘晚上偶尔憋醒’改写成‘端坐呼吸’，不得把‘跑快时胸口呼呼响’改写成‘静息呼吸困难’。",
    "- 已知心衰/冠心病/心绞痛/COPD/慢阻肺/哮喘/CKD 等慢性心肺肾疾病患者的劳力或活动诱发的基线症状（如平路气短、活动后气促、上楼喘、劳力性胸闷），是基线功能状态而非急性事件：只要没有夜间阵发性呼吸困难、端坐呼吸、不能平卧、新发/突发、进行性加重、不缓解或伴胸痛大汗等急性变化线索，一律不得标 emergency，按 urgent/clarify 保持优先复核即可；出现上述任一急性线索时必须按急性事件正常升级。不含劳力限定或疾病背景的含混表述按未知处理，不得据此降级。",
    "",
    "【临床文本】",
    text.slice(0, 12_000),
  ].join("\n");
}

export function buildClinicalFactsReviewPrompt(text: string, initialFacts: ClinicalFacts): string {
  const initialFindings = initialFacts.redFlags.map((finding, index) => ({
    findingId: `rf-${index + 1}`,
    ...finding,
  }));
  return [
    buildClinicalFactsExtractionPrompt(text),
    "",
    "【独立复核】下面是首轮结构化初判，只能作为待质疑材料，不能直接照抄。请重新阅读【临床文本】，重点复核：当前/既往、否定范围、症状组合、严重度、进展轨迹、是否真正达到即时急诊或优先评估条件。主动拒绝“只因出现症状名就纳入红旗”的过度分诊；同时，缺少伴随症状、生命体征或检查结果只是未知，不能作为降低急症等级的阴性证据。当前时间敏感事件不能被既往、昨日、上周或其他发作的正常检查清除。已知慢性心肺疾病背景下、由劳力或活动诱发的基线症状（平路气短、活动后气促等），在没有夜间阵发性呼吸困难、端坐呼吸、不能平卧、新发/突发、进行性加重或伴胸痛大汗等急性线索时，应把首轮 emergency 纠正为 urgent/clarify；出现急性线索时不得降级。发热分级按同一原则复核：体温未达40℃且无循环/意识/呼吸受损（意识改变、嗜睡、低血压/休克、呼吸急促困难、尿量减少、皮肤花斑、发绀、抽搐）的高热寒战，应把首轮 emergency 纠正为 urgent；达到40℃或伴上述受损表现时不得降级。",
    "输出 JSON 格式：{\"redFlags\":[最终完整事实],\"encounterScope\":{\"status\":\"active_current_target|historical_or_stable_only|unclear\",\"quote\":\"原文逐字片段\"},\"reviews\":[{\"findingId\":\"rf-1\",\"decision\":\"confirm|modify|reject\",\"dispositionChangeEvidence\":{\"basis\":\"current_same_episode_clearance|polarity_correction|subject_correction\",\"quote\":\"支持降低等级的原文逐字片段\"}}]}。独立重判 encounterScope，不能照抄首轮；如果有任何新的当前阳性问题，不得判 historical_or_stable_only。当前治疗/处置请求（要求开药、加用中药、调理、治疗、续药等）或当前不适主诉同样意味着 active_current_target；‘控制稳定、血压达标、病情平稳’只描述疾病状态，不能单独支撑 historical_or_stable_only。",
    "首轮每个 positive/possible finding 都必须被逐项处理：在 reviews 中显式写 findingId 和 decision，不能靠省略删除。",
    "confirm/modify 时，在对应的最终 redFlags 条目内额外写入同一 findingId；可以依原文修正 category/subject/status/urgency/triageBasis/quote。reject 时不保留该条。首轮遗漏的新事实不写 findingId。",
    "如果 reject，或把 emergency/urgent 降到更低等级，必须填写 dispositionChangeEvidence：只能引用本次当前同一事件已缓解/已由当次临床评估排除的事实，或能证明首轮极性/主体理解错误的逐字原文。陈旧检查、既往评估、未记录伴随症状、一般性的‘情况尚可’都不能作为降级证据。confirm 或升级时不要填写该字段。",
    `首轮初判：${JSON.stringify({ redFlags: initialFindings, encounterScope: initialFacts.encounterScope }).slice(0, 5000)}`,
  ].join("\n");
}

const DISPOSITION_CHANGE_BASES = new Set([
  "current_same_episode_clearance",
  "polarity_correction",
  "subject_correction",
]);

type ReviewDecision = {
  decision: "confirm" | "modify" | "reject";
  evidenceBasis?: string;
  evidenceQuote?: string;
};

type DispositionReduction = {
  findingId: string;
  initialFinding: RedFlagFinding;
  proposedFinding?: RedFlagFinding;
  evidenceBasis: string;
  evidenceQuote: string;
};

function urgencyRank(urgency: RedFlagFinding["urgency"]): number {
  return urgency === "emergency" ? 3 : urgency === "urgent" ? 2 : urgency === "clarify" ? 1 : 0;
}

function isDispositionReduction(initial: RedFlagFinding, proposed: RedFlagFinding | undefined): boolean {
  if (!proposed) return true;
  if (initial.subject === "patient" && proposed.subject !== "patient") return true;
  if ((initial.status === "positive" || initial.status === "possible") &&
      proposed.status !== "positive" && proposed.status !== "possible") return true;
  return urgencyRank(proposed.urgency) < urgencyRank(initial.urgency);
}

function findingPreservesOrRaisesDisposition(initial: RedFlagFinding, reviewed: RedFlagFinding): boolean {
  if (initial.category !== reviewed.category || initial.subject !== reviewed.subject) return false;
  if ((initial.status === "positive" || initial.status === "possible") &&
      reviewed.status !== "positive" && reviewed.status !== "possible") return false;
  return urgencyRank(reviewed.urgency) >= urgencyRank(initial.urgency);
}

function mergeGroundedFindings(...groups: readonly RedFlagFinding[][]): RedFlagFinding[] {
  const merged: RedFlagFinding[] = [];
  for (const finding of groups.flat()) {
    if (merged.some((item) => item.category === finding.category && item.subject === finding.subject &&
      item.status === finding.status && item.urgency === finding.urgency && item.quote === finding.quote)) continue;
    merged.push(finding);
  }
  return merged;
}

function mergeReviewedEncounterScope(
  initial: ClinicalFacts["encounterScope"],
  reviewed: ClinicalFacts["encounterScope"],
): ClinicalFacts["encounterScope"] {
  if (!initial || !reviewed) return undefined;
  if (initial.status === reviewed.status) {
    return { ...reviewed, reviewAgreement: "agreed" };
  }
  // A disagreement can never acquire authority to suppress current clinical reasoning. Preserve
  // the conservative active/unclear state and make the disagreement explicit in the signed facts.
  const conservative = initial.status === "active_current_target"
    ? initial
    : reviewed.status === "active_current_target"
      ? reviewed
      : { status: "unclear" as const, quote: reviewed.quote };
  return { ...conservative, reviewAgreement: "disagreed" };
}

function explicitStaleClearanceEvidence(text: string): boolean {
  return /(?:既往|曾经|之前|此前|上次|上周|上月|数日前|几天前|昨日|昨天|前天|两周前|一月前|往年|陈旧)/.test(text);
}

function reductionEvidencePassesTemporalContract(reduction: DispositionReduction): boolean {
  if (reduction.evidenceBasis !== "current_same_episode_clearance") return true;
  // This is deliberately a tiny temporal trust contract, not a symptom classifier. LLMs own the
  // clinical interpretation; the server only prevents an explicitly old assessment from acquiring
  // authority over a current time-sensitive event.
  return !explicitStaleClearanceEvidence(reduction.evidenceQuote);
}

function buildDispositionAdjudicationPrompt(text: string, reductions: DispositionReduction[]): string {
  return [
    "你是第三方急诊分流降级裁决医师。只判断拟议的降级是否被患者原文明确支持，不重新生成整份红旗列表。",
    "只有以下情况可 allowReduction=true：本次当前同一事件已经明确缓解或被当次临床评估直接排除；首轮把否定事实误判为阳性；首轮把他人事实误判为患者本人。",
    "既往、昨日、上周、另一发作的正常检查或低风险评估不能清除当前时间敏感事件；未记录某个伴随症状、生命体征或检查不等于阴性；不确定时必须 false。",
    "只输出 JSON：{\"decisions\":[{\"findingId\":\"rf-1\",\"allowReduction\":true|false,\"evidenceQuote\":\"原文逐字片段\"}]}。每个 findingId 恰好一次；evidenceQuote 必须逐字来自临床文本，false 时也要引用最相关的当前原文。",
    `待裁决降级：${JSON.stringify(reductions)}`,
    "【临床文本】",
    text.slice(0, 12_000),
  ].join("\n");
}

function dispositionReductionApprovals(
  raw: string,
  reductions: DispositionReduction[],
  text: string,
): Map<string, boolean> | null {
  const root = safeJsonParse(raw);
  const items = root && typeof root === "object" && Array.isArray((root as { decisions?: unknown }).decisions)
    ? (root as { decisions: unknown[] }).decisions
    : [];
  if (items.length !== reductions.length) return null;
  const expectedIds = new Set(reductions.map((item) => item.findingId));
  const decisions = new Map<string, boolean>();
  for (const item of items) {
    if (!item || typeof item !== "object") return null;
    const findingId = (item as { findingId?: unknown }).findingId;
    const allowReduction = (item as { allowReduction?: unknown }).allowReduction;
    const evidenceQuote = (item as { evidenceQuote?: unknown }).evidenceQuote;
    if (typeof findingId !== "string" || !expectedIds.has(findingId) || decisions.has(findingId)) return null;
    if (typeof allowReduction !== "boolean" || typeof evidenceQuote !== "string" ||
        !evidenceQuote.trim() || !text.includes(evidenceQuote.trim())) return null;
    decisions.set(findingId, allowReduction);
  }
  return decisions.size === expectedIds.size ? decisions : null;
}

function resolveReviewedDisposition(
  grounded: ClinicalFacts,
  reviewedGrounded: ClinicalFacts,
  rawReviewedFlags: unknown[],
  reductions: DispositionReduction[],
  approvals: ReadonlyMap<string, boolean>,
): ClinicalFacts {
  const rejectedReductionIds = new Set(
    reductions.filter((item) => approvals.get(item.findingId) !== true).map((item) => item.findingId),
  );
  const acceptedReviewed = reviewedGrounded.redFlags.filter((_, index) => {
    const rawItem = rawReviewedFlags[index];
    const findingId = rawItem && typeof rawItem === "object"
      ? (rawItem as { findingId?: unknown }).findingId
      : undefined;
    return typeof findingId !== "string" || !rejectedReductionIds.has(findingId);
  });
  const conservativeFallbacks = grounded.redFlags.filter((_, index) =>
    rejectedReductionIds.has(`rf-${index + 1}`));
  return {
    redFlags: mergeGroundedFindings(acceptedReviewed, conservativeFallbacks),
    encounterScope: mergeReviewedEncounterScope(grounded.encounterScope, reviewedGrounded.encounterScope),
    reviewStatus: "checked",
  };
}

export type FactsLlmCall = (
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  phase?: "extract" | "repair" | "review" | "adjudicate",
) => Promise<string>;

export type ExtractClinicalFactsOptions = {
  independentReview?: boolean;
  allowDispositionReductions?: boolean;
};

/**
 * 受约束抽取器。护栏 1(schema)+2(grounding)在此应用;返回 null 表示抽取不可用(调用方 fallback 纯确定性)。
 * llmCall 依赖注入,便于确定性测试。
 */
export async function extractClinicalFacts(
  text: string,
  llmCall: FactsLlmCall,
  signal?: AbortSignal,
  options: ExtractClinicalFactsOptions = {},
): Promise<ClinicalFacts | null> {
  if (!text.trim()) return { redFlags: [] };
  if (signal?.aborted) return null;
  const extractionPrompt = buildClinicalFactsExtractionPrompt(text);
  let raw: string;
  try {
    raw = await llmCall(CLINICAL_FACTS_EXTRACTION_SYSTEM_PROMPT, extractionPrompt, signal, "extract");
  } catch {
    return null; // fail-closed:抽取不可用 → 纯确定性
  }
  if (signal?.aborted) return null;
  let parsed = parseClinicalFacts(raw);
  let repairUsed = false;
  if (!parsed && !signal?.aborted) {
    const repairPrompt = [
      extractionPrompt,
      "",
      "【结构修复】上一份输出不是有效契约。请重新完成同一临床语义判断，为每条红旗同时填写 subject、status、urgency、triageBasis 和逐字 quote，并填写 encounterScope.status 与逐字 quote，只输出一个合法 JSON 对象。即使没有红旗也必须输出 redFlags 空数组。不得输出解释、Markdown、代码围栏或额外字段。",
      `上一份无效输出：${raw.slice(0, 2000)}`,
    ].join("\n");
    try {
      repairUsed = true;
      raw = await llmCall(CLINICAL_FACTS_EXTRACTION_SYSTEM_PROMPT, repairPrompt, signal, "repair");
      if (signal?.aborted) return null;
      parsed = parseClinicalFacts(raw);
    } catch {
      return null;
    }
  }
  if (!parsed) return null;
  let grounded = groundClinicalFacts(parsed, text);
  if (!repairUsed && grounded.redFlags.length < parsed.redFlags.length && !signal?.aborted) {
    const rejectedQuotes = parsed.redFlags
      .filter((finding) => !grounded.redFlags.some((accepted) =>
        accepted.category === finding.category && accepted.subject === finding.subject &&
        accepted.status === finding.status && accepted.quote === finding.quote))
      .map((finding) => finding.quote)
      .slice(0, 8);
    const groundingRepairPrompt = [
      extractionPrompt,
      "",
      "【原文引用修复】上一份 JSON 结构合法，但下列 quote 未通过当前事实的原文落地核验。请重新完成同一语义判断：每条 quote 只取能够单独支撑该 finding 的最短连续原文片段；排除同句中无关的否认、既往史和陈旧检查。若该事实实际被否认或属于既往，应纠正 status/urgency/triageBasis；不得为了保留红旗而改变患者事实。仍只输出一个合法 JSON 对象。",
      `未落地 quote：${JSON.stringify(rejectedQuotes)}`,
      `上一份输出：${raw.slice(0, 2400)}`,
    ].join("\n");
    try {
      const repairedRaw = await llmCall(
        CLINICAL_FACTS_EXTRACTION_SYSTEM_PROMPT,
        groundingRepairPrompt,
        signal,
        "repair",
      );
      if (signal?.aborted) return null;
      const repaired = parseClinicalFacts(repairedRaw);
      if (repaired) {
        const repairedGrounded = groundClinicalFacts(repaired, text);
        const merged = [...grounded.redFlags];
        for (const finding of repairedGrounded.redFlags) {
          if (!merged.some((accepted) => accepted.category === finding.category && accepted.subject === finding.subject &&
            accepted.status === finding.status && accepted.quote === finding.quote)) {
            merged.push(finding);
          }
        }
        grounded = { ...grounded, redFlags: merged };
      }
    } catch {
      // Keep the already-grounded subset. A failed quote repair cannot restore rejected findings.
    }
  }
  if (!options.independentReview) return { ...grounded, reviewStatus: "skipped" };
  // A reviewer response can be non-empty yet still violate the findingId/grounding contract. Give
  // that independent phase one bounded fresh attempt using the exact same grounded first pass.
  // The original findings stay fixed across attempts, so a malformed response can neither erase a
  // stricter disposition nor trigger a new extractor run with an easier baseline.
  for (let reviewAttempt = 1; reviewAttempt <= 2; reviewAttempt += 1) {
    try {
      const reviewedRaw = await llmCall(
      CLINICAL_FACTS_REVIEW_SYSTEM_PROMPT,
      buildClinicalFactsReviewPrompt(text, grounded),
      signal,
      "review",
    );
      if (signal?.aborted) return null;
      const reviewed = parseClinicalFacts(reviewedRaw);
      if (!reviewed) throw new Error("clinical_facts_review_schema_invalid");
      const reviewedGrounded = groundClinicalFacts(reviewed, text);
    // The reviewer is authoritative only when every returned item passes the same source contract.
    // A malformed citation cannot erase or upgrade the already-grounded first pass.
    if (reviewedGrounded.redFlags.length !== reviewed.redFlags.length) {
      throw new Error("clinical_facts_review_grounding_invalid");
    }
    const activeInitial = grounded.redFlags.filter((finding) => finding.status === "positive" || finding.status === "possible");
    const monotonicReview = activeInitial.every((initial) =>
      reviewedGrounded.redFlags.some((candidate) => findingPreservesOrRaisesDisposition(initial, candidate)));
    if (monotonicReview) {
      return {
        redFlags: mergeGroundedFindings(reviewedGrounded.redFlags, grounded.redFlags),
        encounterScope: mergeReviewedEncounterScope(grounded.encounterScope, reviewedGrounded.encounterScope),
        reviewStatus: "checked",
      };
    }
    // If the runtime cannot prove that the reduction reviewer and adjudicator are independent,
    // disagreement is resolved monotonically. The review still contributes new grounded findings,
    // but it cannot erase or downgrade the first-pass disposition.
    if (!options.allowDispositionReductions) {
      return {
        redFlags: mergeGroundedFindings(grounded.redFlags, reviewedGrounded.redFlags),
        encounterScope: mergeReviewedEncounterScope(grounded.encounterScope, reviewedGrounded.encounterScope),
        reviewStatus: "checked",
      };
    }
    const reviewRoot = safeJsonParse(reviewedRaw);
    const reviewItems = reviewRoot && typeof reviewRoot === "object" && Array.isArray((reviewRoot as { reviews?: unknown }).reviews)
      ? (reviewRoot as { reviews: unknown[] }).reviews
      : [];
    const initialFindingIds = new Set(grounded.redFlags.map((_, index) => `rf-${index + 1}`));
    const decisions = new Map<string, ReviewDecision>();
    let malformedReviewDecision = false;
    for (const item of reviewItems) {
      if (!item || typeof item !== "object") {
        malformedReviewDecision = true;
        continue;
      }
      const findingId = (item as { findingId?: unknown }).findingId;
      const decision = (item as { decision?: unknown }).decision;
      const evidence = (item as { dispositionChangeEvidence?: unknown }).dispositionChangeEvidence;
      const evidenceBasis = evidence && typeof evidence === "object"
        ? (evidence as { basis?: unknown }).basis
        : undefined;
      const evidenceQuote = evidence && typeof evidence === "object"
        ? (evidence as { quote?: unknown }).quote
        : undefined;
      if (typeof findingId !== "string" || !initialFindingIds.has(findingId) ||
          (decision !== "confirm" && decision !== "modify" && decision !== "reject") ||
          decisions.has(findingId)) {
        malformedReviewDecision = true;
        continue;
      }
      if (evidence != null && (
        typeof evidence !== "object" ||
        typeof evidenceBasis !== "string" || !DISPOSITION_CHANGE_BASES.has(evidenceBasis) ||
        typeof evidenceQuote !== "string" || !evidenceQuote.trim() || !text.includes(evidenceQuote.trim())
      )) {
        malformedReviewDecision = true;
        continue;
      }
      decisions.set(findingId, {
        decision,
        evidenceBasis: typeof evidenceBasis === "string" ? evidenceBasis : undefined,
        evidenceQuote: typeof evidenceQuote === "string" ? evidenceQuote.trim() : undefined,
      });
    }
    const rawReviewedFlags = reviewRoot && typeof reviewRoot === "object" && Array.isArray((reviewRoot as { redFlags?: unknown }).redFlags)
      ? (reviewRoot as { redFlags: unknown[] }).redFlags
      : [];
    const reviewedFindingIds = new Map<string, number>();
    rawReviewedFlags.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const findingId = (item as { findingId?: unknown }).findingId;
      if (typeof findingId !== "string") return;
      if (!initialFindingIds.has(findingId) || reviewedFindingIds.has(findingId)) {
        malformedReviewDecision = true;
        return;
      }
      reviewedFindingIds.set(findingId, index);
    });
    if (malformedReviewDecision) throw new Error("clinical_facts_review_decision_invalid");
    const dispositionReductions: DispositionReduction[] = [];
    for (let index = 0; index < grounded.redFlags.length; index += 1) {
      const initialFinding = grounded.redFlags[index];
      if (initialFinding.status !== "positive" && initialFinding.status !== "possible") continue;
      const findingId = `rf-${index + 1}`;
      const reviewDecision = decisions.get(findingId);
      if (!reviewDecision) throw new Error("clinical_facts_review_decision_missing");
      const reviewedIndex = reviewedFindingIds.get(findingId);
      const proposedFinding = reviewedIndex == null ? undefined : reviewedGrounded.redFlags[reviewedIndex];
      if (reviewDecision.decision === "confirm" && !proposedFinding) {
        throw new Error("clinical_facts_review_confirmed_finding_missing");
      }
      if (reviewDecision.decision === "modify" && !proposedFinding) {
        throw new Error("clinical_facts_review_modified_finding_missing");
      }
      if (reviewDecision.decision === "reject" && proposedFinding) {
        throw new Error("clinical_facts_review_rejected_finding_retained");
      }
      if (isDispositionReduction(initialFinding, proposedFinding)) {
        if (!reviewDecision.evidenceBasis || !reviewDecision.evidenceQuote) {
          throw new Error("clinical_facts_review_reduction_evidence_missing");
        }
        dispositionReductions.push({
          findingId,
          initialFinding,
          proposedFinding,
          evidenceBasis: reviewDecision.evidenceBasis,
          evidenceQuote: reviewDecision.evidenceQuote,
        });
      }
    }
    const unresolvedInitialFinding = grounded.redFlags
      .map((finding, index) => ({ finding, findingId: `rf-${index + 1}` }))
      .filter(({ finding }) => finding.status === "positive" || finding.status === "possible")
      .some(({ finding, findingId }) => {
        if (reviewedGrounded.redFlags.some((reviewedFinding) =>
          reviewedFinding.category === finding.category && reviewedFinding.subject === finding.subject &&
          reviewedFinding.quote === finding.quote)) return false;
        const decision = decisions.get(findingId)?.decision;
        if (decision === "reject") return false;
        if (decision !== "confirm" && decision !== "modify") return true;
        const reviewedIndex = reviewedFindingIds.get(findingId);
        return reviewedIndex == null || reviewedGrounded.redFlags[reviewedIndex] == null;
      });
    // The adjudicator may explicitly downgrade or negate a first-pass finding, but omission is not
    // a review decision. Treating silence as clearance would let an empty second response erase a
    // grounded emergency fact.
    if (unresolvedInitialFinding) {
      throw new Error("clinical_facts_review_initial_finding_unresolved");
    }
    if (dispositionReductions.length > 0) {
      const approvals = new Map<string, boolean>();
      const eligibleReductions: DispositionReduction[] = [];
      for (const reduction of dispositionReductions) {
        // A second model and an adjudicator may add or raise a disposition, but an already grounded
        // emergency cannot be erased by model-only consensus. This model-agnostic monotonic contract
        // prevents a fluent but semantically wrong explanation from reopening dose-level workflow.
        if (reduction.initialFinding.urgency === "emergency") approvals.set(reduction.findingId, false);
        else if (reductionEvidencePassesTemporalContract(reduction)) eligibleReductions.push(reduction);
        else approvals.set(reduction.findingId, false);
      }
      if (eligibleReductions.length > 0) {
        try {
          const adjudicatedRaw = await llmCall(
            CLINICAL_FACTS_REVIEW_SYSTEM_PROMPT,
            buildDispositionAdjudicationPrompt(text, eligibleReductions),
            signal,
            "adjudicate",
          );
          if (signal?.aborted) return null;
          const adjudicated = dispositionReductionApprovals(adjudicatedRaw, eligibleReductions, text);
          for (const reduction of eligibleReductions) {
            approvals.set(reduction.findingId, adjudicated?.get(reduction.findingId) === true);
          }
        } catch {
          // A missing adjudicator cannot authorize a downgrade. Keep the stricter grounded
          // disposition while preserving the fact that the independent review itself completed.
          for (const reduction of eligibleReductions) approvals.set(reduction.findingId, false);
        }
      }
      return resolveReviewedDisposition(
        grounded,
        reviewedGrounded,
        rawReviewedFlags,
        dispositionReductions,
        approvals,
      );
    }
    return {
      ...reviewedGrounded,
      encounterScope: mergeReviewedEncounterScope(grounded.encounterScope, reviewedGrounded.encounterScope),
      reviewStatus: "checked",
    };
    } catch {
      if (signal?.aborted) return null;
      if (reviewAttempt === 2) return { ...grounded, reviewStatus: "unavailable" };
    }
  }
  return { ...grounded, reviewStatus: "unavailable" };
}
