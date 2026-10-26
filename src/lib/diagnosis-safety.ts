import { confirmedRiskScreeningCategories, followupConversationView, isFollowupSkipMessage } from "./followup-conversation";
import type { CaseState, ClinicalReasoningResultV2, ClinicalReviewAttestation, Completeness, HisRecordSnapshot, SafetyGate, SafetyMissingItemCode, StructuredFollowupTimelineItem } from "./diagnosis-types";
import { cdssReasonCodeMarker, type CdssDegradeReasonCode } from "./cdss-reason-codes";
import type { WarningDisplayReceipt } from "./warning-display-binding";
import { sectionTitleGroup } from "./cdss-vocab";
import {
  assessConceptionState,
  assessLactationState,
  assessPregnancyState,
  isKnownClinicalState,
  isUnknownClinicalFieldText,
  isUnrecordedInspectionFieldValue,
  isUnknownClinicalText,
  isPositiveOrPossibleClinicalState,
  PULSE_FORCE_PATTERN_SOURCE,
  PULSE_QUALITY_PATTERN_SOURCE,
  PULSE_VESSEL_NOUN_LOOKBEHIND_SOURCE,
  recentChildbirthMentioned,
  recordExcludesPregnancyPotential,
} from "./clinical-state";
import { inspectionLexiconPattern } from "./tcm-inspection-lexicon";
import priorityEvaluationWindowTable from "../data/priority-evaluation-windows.source.json";
import { evaluateDiscriminators, redFeatureChecklistForPatient, type DiscriminatorOutcome } from "./redflag-discriminators";
import emergencyDiagnosisNames from "../data/emergency-diagnosis-names.source.json";
import { generalizeOccupation, shouldRedactNarrativeNameCandidate, scrubQuasiIdentifierText, scrubRecordHeaderName, scrubRelationPrefixedName, scrubSubjectPrefixedName } from "./phi-sanitizer";
import { determineCompletenessLevel } from "./diagnosis-types";
import {
  additiveRedFlagsFromFacts,
  dispositionAdvisoriesFromFacts,
  dispositionEmergencyRedFlagsFromFacts,
  dispositionPriorityItemsFromFacts,
  groundClinicalFacts,
  dispositionPriorityWindowFromFacts,
  dispositionPriorityTargetFromFacts,
  PRIORITY_EVALUATION_WINDOWS,
  type PriorityEvaluationWindowId,
  clinicalFactsReviewSettled,
  groundedPatientTriageCategories,
  HAEMATEMESIS_COLLOQUIAL_FORMS,
  HYPERTENSIVE_TARGET_ORGAN_SIGNS,
  priorityEvaluationItemsFromFacts,
  semanticTriageAdvisoriesFromFacts,
  structuredRedFlagEvidenceFromFacts,
  type BackstopRedFlagCategory,
} from "./clinical-facts";
import { CLINICAL_EXAM_NEGATION_VERB_SOURCE, affirmedCurrentMedicationText, clinicalEventTemporalScopeAt } from "./clinical-polarity";
import { ensureActionableFollowupSafetyNet } from "./followup-safety-net";
import { buildThreePartLimitedStateCopyForSurface, sanitizeAuthoritativeClinicalOutput } from "./clinical-output-authority";
import { clinicalFieldRequiresExplicitPrescriptionState, clinicalRequiredFieldLabel } from "./clinical-governance-tables";
import { patientSexAllowsDoseLevelSuggestion } from "./clinical-required-fields";
import { activeEmergencyClearanceFindingsFromGate, emergencyClearanceContractIssue } from "./emergency-clearance-contract";
import { sixHealthFollowupTable } from "./tcm-followup-dimensions";
import redflagTriageLexicon from "../data/redflag-triage-lexicon.json" with { type: "json" };
import physicalExamClaimLexicon from "../data/physical-exam-claim-lexicon.source.json" with { type: "json" };
import {
  PEDIATRIC_CLAUSE_SUBJECT_PATTERN,
  PEDIATRIC_STRUCTURED_WORD_PATTERN,
  pediatricDoseRuleForAgeYears,
  pediatricDoseRuleForStageWords,
  pediatricStageOldestAgeYears,
  stripInfantFeedingPhrases,
  type PediatricDoseRule,
} from "./pediatric-dose-rule";
import { pediatricVitalReferenceForAgeYears, type PediatricVitalReference } from "./pediatric-vital-reference";

type GovernedRedFlagCategory = {
  id: string;
  symptoms: string[];
  dangerCompanions: string[];
};

const GOVERNED_RED_FLAG_CATEGORIES = redflagTriageLexicon.categoryRules as GovernedRedFlagCategory[];
const governedRedFlagCategory = (id: string): GovernedRedFlagCategory => {
  const category = GOVERNED_RED_FLAG_CATEGORIES.find((item) => item.id === id);
  if (!category) throw new Error(`缺少红旗治理分类：${id}`);
  return category;
};
const GOVERNED_CARDIAC_SYMPTOMS = governedRedFlagCategory("cardiac").symptoms;
const GOVERNED_CARDIAC_PAIN_SYMPTOMS = GOVERNED_CARDIAC_SYMPTOMS.filter((term) => term !== "胸闷");
const GOVERNED_CARDIAC_COMPANIONS = governedRedFlagCategory("cardiac").dangerCompanions;
/**
 * 腹痛的**构词式**表达。词表按「完整词」穷举，而中文把程度词插在部位与「痛」之间就全部失配：
 * 词表有「上腹痛」「右下腹痛」，但实测「上腹剧痛」「右下腹剧痛」「脘腹剧烈疼痛」「少腹急痛」
 * 一律**零红旗**——异位妊娠（少腹急痛+停经）、急性胰腺炎（上腹剧痛）、阑尾炎（右下腹剧痛）
 * 的典型主诉全线漏检，而「突发腹痛」正常命中。这不是缺几个词，是穷举法本身对不上中文构词。
 *
 * 改成 部位 × (程度/性质)? × 痛，覆盖插入式表达。仍然只是**症状识别**：
 * 是否构成红旗照旧由上层的急性起病/程度/腹膜刺激征判据决定，本模式不放宽任何门槛。
 * 词表里的原有完整词一并保留（心口窝痛、肚子疼这类口语不符合构词式）。
 */
const ABDOMINAL_PAIN_COMPOSITION =
  "(?:全腹|上腹|中上腹|右上腹|左上腹|下腹|右下腹|左下腹|脐周|少腹|小腹|大腹|脘腹|胃脘|腹部|腹)"
  + "(?:部)?(?:[剧隐胀绞刺闷钝锐灼])?(?:烈|痛|性)?(?:阵发性|阵发|持续性|持续|急|剧烈|剧痛|绞痛)?"
  + "(?:疼痛|痛|疼)";
/**
 * 部位 + **重度性质词** + 痛。这一条单独存在，是因为上面的构词式模式会把程度词
 * 「吃」进症状匹配里：「右下腹剧痛」整体匹配成一个症状后，重度判据再去找相邻的重度词就找不到了
 * （实测「突发上腹剧痛，大汗」靠句末的「大汗」过关，而「突发右下腹剧痛」仍然零红旗）。
 * 症状短语自带重度性质词时，它本身就是重度证据。
 * 只收真正表示剧烈的性质词——隐痛/胀痛/刺痛不在其列。
 */
const ABDOMINAL_SEVERE_PAIN_COMPOSITION =
  "(?:全腹|上腹|中上腹|右上腹|左上腹|下腹|右下腹|左下腹|脐周|少腹|小腹|大腹|脘腹|胃脘|腹部|腹)"
  + "(?:部)?(?:剧烈|剧|绞|急|刀割样|撕裂样|针刺样)(?:烈)?(?:疼痛|痛|疼)";
const GOVERNED_ACUTE_ABDOMEN_SYMPTOMS = governedRedFlagCategory("acute_abdomen").symptoms;
const GOVERNED_ACUTE_ABDOMEN_COMPANIONS = governedRedFlagCategory("acute_abdomen").dangerCompanions;
const GOVERNED_PERITONEAL_SIGNS = GOVERNED_ACUTE_ABDOMEN_COMPANIONS.filter((term) =>
  ["反跳痛", "松手更疼", "板状腹", "腹肌紧张"].includes(term));
const GOVERNED_ACUTE_ONSET_TERMS = redflagTriageLexicon.dimensions.acuteOnset;
const GOVERNED_SEVERE_TERMS = redflagTriageLexicon.dimensions.severe;
const GOVERNED_BLEEDING = governedRedFlagCategory("bleeding");
const GOVERNED_MAJOR_VAGINAL_BLEEDING_TERMS = GOVERNED_BLEEDING.symptoms
  .filter((term) => /阴道/.test(term));
const GOVERNED_VAGINAL_BLEEDING_TERMS = GOVERNED_MAJOR_VAGINAL_BLEEDING_TERMS
  .flatMap((term) => {
    const base = term.replace(/大量/g, "");
    return [base, base.replace(/出血/g, "流血")];
  });
const GOVERNED_BLEEDING_COMPANIONS = GOVERNED_BLEEDING.dangerCompanions;
/**
 * 上消化道**警示征象**（alarm features）。与 gi_bleed 的区别：出血是「已经在出」，
 * 警示征象是「可能有占位/梗阻/复发」——两者的处置优先级同样高，但此前只有前者有规则。
 *
 * 【为什么补这一类】线上实测（胃癌术后、进食困难 10 月余加重 7 天、呕吐黏液、病理示腺癌浸润）：
 * safetyGate.redFlags = []、advisories = []，M03 按普通「胃气壅滞」出方，M05 只给「一般提示」。
 * 查因发现「吞咽困难」在本文件里**只**出现在上气道水肿（过敏性喉头水肿）规则内、作为气道功能线索；
 * 「恶性肿瘤 / 肿瘤 / 癌症 / 化疗 / 放疗」在本文件中一次都没出现过。
 *
 * 而 m02-question-contract.ts 的上消化道追问原文是
 * 「是否出现吞咽困难或进行性卡顿、呕血或黑便、持续呕吐或不明原因体重下降？」——
 * 追问层把这些当警示征象逐条问，确定性门却没有任何一条能接住医生的「是」。
 * 又是同一判据两处各写各的：一处问、一处不认。本次把词表收敛到受治理表的 gi_alarm 类，
 * 两处同源（test:safety-mutations 里有一条断言钉住 M02 问句里的每个征象词都在本类词表内）。
 */
const GOVERNED_GI_ALARM = governedRedFlagCategory("gi_alarm");
/**
 * 判据用到的每一份词表都从受治理表的 detection 节读。
 * 第一版把词表抄在代码里、只在表上留了一份「装饰性副本」——那正是本次要修的那种缺陷本身
 * （lint 报出未使用的常量时才发现）。词表只允许有一个来源。
 */
const GI_ALARM_DETECTION = (GOVERNED_GI_ALARM as unknown as {
  detection: {
    progressionCues: string[];
    gastrointestinalMalignancy: string[];
    malignancyGeneric: string[];
    currentDigestiveSymptoms: string[];
    alarmDigestiveFindings: string[];
    unexplainedWeightLossCues: string[];
    weightLossTerms: string[];
    weightLossDigestiveContext: string[];
  };
}).detection;

/**
 * 口语面孔一律从受治理表的 detection 节读，代码里不再抄第二份。
 *
 * 2026-08-16 实测的六类零检出（心血管/神经/呼吸/晕厥/儿科/中毒）是同一个根因：
 * 词表按完整书面词穷举，医生按患者原话录入就整条失配。逐类标定后，六类**都有一个
 * 同义且已经命中的书面兄弟**——所以补的是同一概念的说法，不是新开档位：
 *   · 「心前区闷得慌2小时」硬红旗 ✓ ／「心前区发闷2小时」0 ✗——只差一个同义动词
 *   · 「突发复视、步态不稳」硬红旗 ✓ ／「看东西成双影，走路发飘」0 ✗
 *   · 「喘不上气，不能平卧」硬红旗 ✓ ／「喘得厉害，晚上躺不平」0 ✗
 *   · 「晕厥发作」提示 ✓ ／「眼前一黑就倒了」0 ✗
 *   · 「患儿精神萎靡」提示 ✓ ／「孩子精神很差」0 ✗
 *   · 「有机磷农药中毒」提示 ✓ ／「误喝了敌敌畏」0 ✗
 * 硬门档位一律沿用兄弟词的档位，不因为是口语就抬高或压低。
 *
 * **不是所有口语词都能直接加**。实测 8 条常规门诊主诉（腰痛夜间躺不平、颈椎病垫高枕头、
 * 更年期冒虚汗、失眠白天没精神、老人摔倒在地、小儿厌食不吃不喝…）当前全是 0 红旗 0 提示，
 * 而它们恰好含有最直觉的那批口语词。所以词表里同时记了 excludedTerms 与排除理由，
 * 端坐呼吸更是只作构词式（口语词必须与呼吸线索同句）。
 */
function governedDetectionNode<T>(id: string): T {
  return (governedRedFlagCategory(id) as unknown as { detection: T }).detection;
}

const CARDIAC_DETECTION = governedDetectionNode<{ colloquialPressureVerbs: string[] }>("cardiac");
const NEURO_DETECTION = governedDetectionNode<{ colloquialFocalSigns: string[]; meningealSigns: string[] }>("neuro");
const ACUTE_ABDOMEN_DETECTION = governedDetectionNode<{
  peritonealSignForms: string[];
  obstructionSigns: string[];
  appendicealCholecystSigns: string[];
  obstructionExamSigns: string[];
  obstructionImagingSigns: string[];
  obstipationDays: number;
}>("acute_abdomen");
const TRAUMA_DETECTION = governedDetectionNode<{ acuteTraumaCues: string[]; fractureTerms: string[]; settledFractureCues: string[]; incarcerationSigns: string[] }>("other_critical");
const RESPIRATORY_DETECTION = governedDetectionNode<{
  colloquialSymptoms: string[];
  centralCyanosisSites: string[];
  centralCyanosisTerms: string[];
  orthopneaColloquial: string[];
  orthopneaBreathingCues: string[];
}>("respiratory");
const SYNCOPE_DETECTION = governedDetectionNode<{
  colloquialSymptoms: string[];
  highRiskEcgFindings: {
    pauseTerms: string[];
    pauseSecondsAtLeast: number;
    asleepCues: string[];
    conductionBlockForms: string[];
    ventricularArrhythmiaTerms: string[];
  };
}>("syncope");
const PEDIATRIC_DETECTION = governedDetectionNode<{ colloquialCriticalSigns: string[] }>("pediatric_critical");
const POISONING_DETECTION = governedDetectionNode<{
  colloquialSymptoms: string[];
  colloquialCompanions: string[];
}>("poisoning");

/**
 * 晕厥/黑矇 + 心电记录的主要高危心律失常（2026-10-25 第二十轮，基层病例 B024：「24小时动态心电图：窦性停搏，最长达3秒」后
 *「入院时突发晕厥」，两层都没报红旗——事实层判 clarify，确定性层的晕厥只有提示档）。2018 ESC 晕厥指南：清醒时窦性停搏 >3 s、
 * 二度 II 型/三度房室传导阻滞、室速是主要高危心电特征，需强化诊断、可能需紧急处理与住院；自发晕厥时记录到窦性停搏是起搏指征。
 * 词表与阈值在 T6 syncope.detection.highRiskEcgFindings（数值阈值 + 有限闭集）；睡眠中的长间歇不算；否认、既往、非本人按共用语境判据。
 * 返回命中的那一项（写进红旗理由），没有返回 undefined。类夹具 syncope-with-high-risk-ecg-finding。
 */
function syncopeWithHighRiskEcgFinding(text: string): string | undefined {
  const ecg = SYNCOPE_DETECTION.highRiskEcgFindings;
  const normalized = normalizeClinicalText(text);
  // 已植入起搏器：长间歇/传导阻滞已有处理。
  if (/(?:植入|安装|置入|安置)[^。；;\n]{0,6}起搏器|起搏器(?:植入|安装|置入)(?:术)?后/u.test(normalized)) return undefined;
  if (!syncopeInSameEpisode(normalized)) return undefined;
  const pause = new RegExp(`(${governedTermAlternation(ecg.pauseTerms)})[^。；;\\n]{0,12}?(\\d+(?:\\.\\d+)?)\\s*(?:秒|s(?![a-z])|S(?![a-z])|sec)`, "gu");
  const asleep = new RegExp(governedTermAlternation(ecg.asleepCues), "u");
  for (const match of normalized.matchAll(pause)) {
    const at = match.index ?? 0;
    if (!(Number(match[2]) >= ecg.pauseSecondsAtLeast)) continue;
    if (isExcludedClinicalAssertionAt(normalized, at) || isNegatedAt(normalized, at) || isHistoricalOrResolvedAt(normalized, at, match[0].length)) continue;
    const clauseStart = Math.max(...["。", "；", ";", "\n"].map((mark) => normalized.lastIndexOf(mark, at - 1))) + 1;
    if (asleep.test(normalized.slice(Math.max(clauseStart, at - 10), at + match[0].length))) continue;
    return `${match[1]}${match[2]}秒`;
  }
  for (const form of [...ecg.conductionBlockForms, ...ecg.ventricularArrhythmiaTerms]) {
    if (hasPatternWithoutNegation(normalized, new RegExp(governedTermAlternation([form]), "u"))) return form;
  }
  return undefined;
}

/**
 * 本次病程里的晕厥：不否认、是患者本人、不是假设或未评估；时间上只排除明确远期的（既往、多年前、去年、小时候…）。
 * 不用 hasTerm 的「当前」判据：「入院时突发晕厥」在那里算既往（clinical-polarity 的「入院时」时间线索），可在长间歇未处理时，
 * 同一病程里的晕厥就是这条规则要的风险背景（B024）。
 */
function syncopeInSameEpisode(normalized: string): boolean {
  const terms = [...governedRedFlagCategory("syncope").symptoms, ...SYNCOPE_DETECTION.colloquialSymptoms];
  for (const term of terms) {
    let at = normalized.indexOf(term);
    while (at >= 0) {
      const clauseStart = Math.max(...["。", "；", ";", "\n"].map((mark) => normalized.lastIndexOf(mark, at - 1))) + 1;
      const remote = /既往|曾经|多年前|去年|前年|\d+\s*年前|[一二两三四五六七八九十数几多]+年前|小时候|幼时|儿时|童年/u.test(normalized.slice(clauseStart, at));
      if (!remote && !isExcludedClinicalAssertionAt(normalized, at) && !isNegatedAt(normalized, at) && !isPostfixNegatedAt(normalized, at, term.length)) return true;
      at = normalized.indexOf(term, at + term.length);
    }
  }
  return false;
}

/**
 * 端坐呼吸的口语只在**与呼吸线索同句**时成立。
 * 「腰痛3年，夜间躺不平，翻身困难」「颈椎病，睡觉需垫高枕头」都是常规主诉，
 * 把「躺不平/垫高枕头」当独立症状词会把这两类整体抬成硬红旗——实测基线是 0。
 */
function hasColloquialOrthopnea(text: string): boolean {
  const anchor = governedTermAlternation(RESPIRATORY_DETECTION.orthopneaColloquial);
  const cue = governedTermAlternation(RESPIRATORY_DETECTION.orthopneaBreathingCues);
  return text
    .split(/[。；;\n]+/)
    .some((clause) => new RegExp(anchor).test(clause) && new RegExp(cue).test(clause));
}

function governedTermAlternation(terms: string[]): string {
  return [...terms]
    .sort((left, right) => right.length - left.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}

function stringifyClinicalValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function flattenClinicalInput(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(flattenClinicalInput);
  if (typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(flattenClinicalInput);
}

export function isLimitedDiagnosisText(text: string | undefined): boolean {
  // 服务端前置区（安全警示横幅 + 质量批注）位于首个 "## " 标题之前，措辞里天然含
  // 「急危重」「补充…确认」这类词。有限诊断的判定对象是**正文**——真正的降级页自身就以
  // "## 本次分析结论" 开头，剥掉前置区不影响其识别；不剥则带警示的完整结果会被误判为
  // 降级页，前端随即清空处方走回旧的拦截路径。
  const raw = text || "";
  const firstHeading = raw.search(/^##\s/m);
  const t = firstHeading > 0 ? raw.slice(firstHeading) : raw;
  // When M03 explicitly commits to "完整候选方案" as its 结论 (only permitted when the deterministic
  // completeness gate is C and no red flag), it produced a full candidate scheme. Do NOT let management
  // next-step narrative elsewhere in the report ("建议完善甲功后再评估" / "补齐现病史后再辨证") re-flag it
  // as limited and halt the chain — that intermittently re-broke prescription generation. Dose-level
  // safety stays independently governed by canEnterDosePrescriptionChain and the prescribe route gate.
  const conclusion = (t.replace(/\*/g, "").match(/结论[：:]\s*([^\n]+)/) || [])[1] || "";
  if (/完整候选方案/.test(conclusion)) return false;
  return /(信息不足建议模式|高风险安全建议模式|辨证信息完整度不足|暂不生成西医诊断|信息不足，?暂不生成|急危重症风险线索待排除|暂不(?:宜|进入|生成).{0,24}(?:方药|处方|候选方案|剂量)|不宜直接进入.{0,24}(?:剂量级|候选处方)|建议(?:先)?(?:补充|补齐|完善).{0,50}再(?:辨证|评估|处方|进入|开方)|(?:补充|补齐|完善).{0,50}后再(?:辨证|评估|处方|进入|开方)|证候锚点.{0,24}不足|病机链.{0,24}不足|缺少稳定证候锚点)/.test(t);
}

export function hasActionableM03Diagnosis(diagnosis?: string): boolean {
  const text = diagnosis?.trim() || "";
  if (!text || isLimitedDiagnosisText(text)) return false;
  return /(##\s*西医诊断|##\s*中医证候诊断|证候诊断|证候-病机关联|总体病机|子病机|中医辨证结论|完整候选方案)/.test(text);
}

function fieldText(state: CaseState, key: keyof HisRecordSnapshot["fields"]): string {
  return state.hisRecord?.fields?.[key] ?? "";
}

function allUserMessages(state: CaseState): string {
  return (state.conversation || [])
    .filter((item) => item.role === "user" && item.content.trim() && !isFollowupSkipMessage(item.content))
    .map((item) => item.content.trim())
    .join("\n");
}

/**
 * 对话里口述的主叙述：不跟在追问题干后面的 user 消息（followup-conversation.ts 是唯一口径）。
 * 「conversation 里有 user 消息」不等于「病历在对话里」：追问的回答只是对病历的补充。只有主叙述存在时，
 * symptoms 与顶层字段才可能是模型从对话里整理出来的二手内容，需要回到对话原文核对。
 */
function primaryNarrativeMessages(state: CaseState): string {
  return followupConversationView(state.conversation).primaryNarrative.join("\n");
}

function authoritativeFieldOrFallback(
  state: CaseState,
  key: keyof HisRecordSnapshot["fields"],
  fallback: unknown,
): string {
  const field = fieldText(state, key);
  if (state.hisRecord) return field;
  const userEnteredText = primaryNarrativeMessages(state);
  if (userEnteredText) {
    const candidate = stringifyClinicalValue(fallback).trim();
    return candidate && normalizeClinicalText(userEnteredText).includes(normalizeClinicalText(candidate)) ? candidate : "";
  }
  return stringifyClinicalValue(fallback);
}

function isKnownClinicalText(value: unknown): boolean {
  const text = stringifyClinicalValue(value).trim();
  return !isUnknownClinicalText(text);
}

// 字段槽口径（2026-08-26 拆谓词）：门禁/充实度问的是「这一栏医生填了没有」，
// 不是「写法是不是标准脉名」。自由文本识别面（净化器的编造防御，sourceHasKnown*）
// 仍走 isUnknownClinicalFieldText 的严格口径，两个问题各用各的谓词。
function isKnownTongueClinicalText(value: unknown): boolean {
  return !isUnrecordedInspectionFieldValue(value, "tongue");
}

function isKnownPulseClinicalText(value: unknown): boolean {
  return !isUnrecordedInspectionFieldValue(value, "pulse");
}

/**
 * 舌象/脉象**是否真的取得**——单一导出谓词（甲方 2026-08-13 P2 雷击样头痛）。
 *
 * 此前有两份各写各的：
 *   · 充实度那一处：`isKnownTongueClinicalText(权威栏) || (已上传舌照 && isKnownTongueClinicalText(图描述))`
 *     ——图描述可以救场；
 *   · 必查项那一处：`isKnownTongueClinicalText(权威栏 || 图描述)` ——**字符串短路**：
 *     舌象栏写了「舌象待核实」这种非空但不可用的文本时，`||` 直接返回它，图描述根本没机会参与。
 * 同一件事两个答案，正是本仓库头号缺陷形状。这里按**图描述可救场**的口径收敛（较宽的那一侧），
 * 因为它才是临床事实：舌照已上传且描述可用时，舌象就是取得了。
 */
export function hasObtainedTongueFinding(state: CaseState): boolean {
  const authoritative = authoritativeFieldOrFallback(state, "tcmTongue", state.tongue);
  if (isKnownTongueClinicalText(authoritative)) return true;
  return Boolean(state.hisRecord?.tongueImageUploaded && isKnownTongueClinicalText(state.tongueImageDesc));
}

export function hasObtainedPulseFinding(state: CaseState): boolean {
  return isKnownPulseClinicalText(authoritativeFieldOrFallback(state, "tcmPulse", state.pulse));
}

export function trustedInputText(state: CaseState): string {
  const hisFieldText = Object.values(state.hisRecord?.fields || {})
    .map((value) => stringifyClinicalValue(value))
    .filter(Boolean)
    .join("\n");
  const userConversationText = allUserMessages(state);

  // Safety and grounding must be based on clinician/patient input, never on fields that an earlier
  // model stage inferred. In particular, a collect model can misread "否认胸痛，但突发晕厥" and put
  // chest pain into state.symptoms; feeding that model-derived value back into the deterministic gate
  // turns a negated symptom into a positive red flag. HIS text/fields and user messages are the
  // authoritative sources. Clinician-entered top-level fields remain authoritative even after a
  // follow-up message is appended: a conversation must not evict tongue, pulse, vitals or histories
  // that were already recorded in the form. The model-derived symptoms DTO is intentionally excluded
  // whenever a primary source exists.
  const currentHis = state.hisRecord
    ? [state.hisRecord.rawText, hisFieldText].filter(Boolean).join("\n")
    : "";
  // chiefComplaint is a clinician-entered source field, not a model inference. Keep it in the
  // grounding corpus even when a follow-up conversation exists; otherwise a compatibility caller
  // without an HIS snapshot can lose the very fact that M03 is expected to explain.
  const clinicianEnteredFields = [
    state.tongue ? `舌象：${stringifyClinicalValue(state.tongue)}` : "",
    state.tongueImageDesc ? `舌象图像复核：${stringifyClinicalValue(state.tongueImageDesc)}` : "",
    state.pulse ? `脉象：${stringifyClinicalValue(state.pulse)}` : "",
    state.faceNote ? `面象：${stringifyClinicalValue(state.faceNote)}` : "",
    // 只取值、不带指标名，是有意保留的现状（2026-10-14 实测）：改成「生命体征：体温 35.5℃」后，语义事实层对低体温病例
    //（76 岁、甲减停药、35.5℃、嗜睡、反应迟钝）判急症的比例从 5/5 降到 2/5——语义层的输入文本一改，安全判断就会漂。
    // 要改这里，先按 regress:facts-class-parity 的办法整类量过再动。体征问题由追问层按结构化 vitals 判断（m02 vitalsDetail）。
    ...flattenClinicalInput(state.vitals).map((value) => `生命体征：${value}`),
    state.pastHistory ? `既往史：${stringifyClinicalValue(state.pastHistory)}` : "",
    state.medicationHistory ? `用药史：${stringifyClinicalValue(state.medicationHistory)}` : "",
    state.allergyHistory ? `过敏史：${stringifyClinicalValue(state.allergyHistory)}` : "",
  ].filter(Boolean);
  // 只有 HIS 快照或对话里的主叙述才会顶替 symptoms。追问的回答（紧跟题干的 user 消息）是对病历的补充：
  // 接口调用方的病历正文就在 symptoms 里，一条回答把它挤出去，现病史写明的出血、孕周、抗凝药就全读不到了。
  const compatibilitySymptoms = currentHis.trim() || primaryNarrativeMessages(state).trim()
    ? []
    : flattenClinicalInput(state.symptoms);
  const authoritativeInput = [currentHis, ...compatibilitySymptoms, ...clinicianEnteredFields, userConversationText].filter(Boolean).join("\n");
  if (authoritativeInput.trim()) return [state.chiefComplaint, authoritativeInput].filter(Boolean).join("\n");

  return [
    state.chiefComplaint,
    ...flattenClinicalInput(state.symptoms),
    state.tongue,
    state.pulse,
    state.faceNote,
    ...flattenClinicalInput(state.vitals),
    state.pastHistory,
    state.medicationHistory,
    state.allergyHistory,
  ].filter(Boolean).join("\n");
}

/**
 * 「接地语料」与「安全语料」是两件事，失效方向相反，因此不能共用同一份文本。
 *
 * trustedInputText 刻意把 state.symptoms 排除在外：M01 collect 可能把「否认胸痛，但突发晕厥」
 * 误读成 symptoms.pain=「胸痛」，把模型衍生字段喂回确定性安全门会把被否认的症状变成阳性红旗。
 * 对**红旗判定**来说，少一个来源是保守的——顶多漏掉一个模型幻觉。
 *
 * 但同一份文本还被用来判断「病历里到底有没有记录某个症状」。对**接地判定**来说，少一个来源是
 * 反向的：净化器会把一条真实记录的症状改写成「病历尚未确认X是否存在」，凭空制造一个不存在的
 * 「未知」。实测一例主诉为「睡不着三年多了」的失眠病例，M02 追问一产生对话，symptoms 整体出局，
 * 输出里出现了「病历尚未确认入睡困难是否存在；但睡眠障碍为突出表现」这种自相矛盾的句子——
 * 排除条件写的是「存在 HIS 记录或对话」，而真正的危险是「该字段可能由模型衍生」，两者并不等价：
 * 医生答完一条追问，并不会让他之前录入的症状变得不可信。trustedInputText 自己的注释也写着
 * 「一条后续消息不得驱逐已录入的舌象、脉象、生命体征与病史」——那条原则唯独没有应用到症状上，
 * 而症状恰恰是承载主症的字段。
 *
 * 因此这里把 symptoms 重新纳入接地语料，但**逐条**排除权威文本已明确否认的那些：极性反转
 * （模型把否认写成阳性）是当初排除它的唯一真实理由，权威否认一票否决即可堵住，不必连同全部
 * 真实症状一起丢弃。红旗判定仍走 trustedInputText，一字未改。
 */
/**
 * 接地语料里由服务端加标签写入的字段行（trustedInputText 的 clinicianEnteredFields 与下方补写的年龄、性别行）。
 * 它们是病历事实，但不是主诉：消费方找「主诉那一行」时必须跳过，否则无主诉标签的病历会把
 * 「患者年龄：45岁」当主诉（实测西医主诊断被写成「年龄：45岁症状」）。标签集合必须与写入处逐字一致。
 */
export const SERVER_LABELED_GROUNDING_LINE = /^(?:患者年龄|患者性别|舌象|舌象图像复核|脉象|面象|生命体征|既往史|用药史|过敏史)：/;

export function clinicalGroundingText(state: CaseState): string {
  const authoritative = trustedInputText(state);
  // 权威年龄以带标签形式注入接地语料（2026-08-25）：M04 特殊人群门禁的数字臂按
  // 「年龄：N岁」字面匹配，而裸叙述「患者，男，7岁」与 HIS 只给值不给键的字段
  // 都不带标签——门禁静默不触发。这里由唯一权威口径 authoritativePatientAgeYears
  // 补一行标签化事实（真实患者事实，additive-only），全部年龄敏感判据从此同源。
  const authoritativeAge = authoritativePatientAgeYears(state);
  const ageLine = authoritativeAge != null && !/年龄\s*[:：]/.test(authoritative)
    ? `患者年龄：${Number(authoritativeAge.toFixed(4))}岁`
    : "";
  // 性别同样补一行标签化事实（2026-10-24）：药典孕妇禁用档要在接地语料里认出「育龄女性」，而页面与 HIS 的性别常只在结构化字段里。
  const sex = patientSexText(state);
  const sexLine = (sex === "女" || sex === "男") && !/性别\s*[:：]?\s*[男女]/.test(authoritative) ? `患者性别：${sex}` : "";
  const groundingBase = [ageLine, sexLine, authoritative].filter(Boolean).join("\n");
  const symptomEntries = flattenClinicalInput(state.symptoms)
    .filter((entry) => typeof entry === "string" && entry.trim())
    .filter((entry) => !authoritative.includes(entry.trim()))
    .filter((entry) => !CLINICAL_NEGATION_FACT_TERMS.some((term) =>
      entry.includes(term) && sourceDocumentsNegation(authoritative, term)));
  if (symptomEntries.length === 0) return groundingBase;
  return [groundingBase, ...symptomEntries].filter(Boolean).join("\n");
}

const RED_FLAG_NEGATION_TERMS = [
  "胸痛", "胸闷", "心悸", "黑矇", "晕厥", "意识丧失", "意识改变",
  "呼吸困难", "气促", "大汗", "放射痛", "剧烈头痛", "头痛", "视物模糊", "发热", "寒战",
  "呕血", "吐血", "黑便", "大便发黑", "粪便发黑", "排黑色便", "柏油样便", "便血", "咯血", "阴道流血",
  "外伤出血", "出血不止", "大量出血", "急腹痛", "腹痛", "板状腹",
  "反跳痛", "抽搐", "言语不清", "肢体无力", "端坐呼吸", "喘憋",
  // 鉴别诊断中常被模型误写成“患者无”的非红旗事实；未问到同样只能标记待核实。
  "怕冷", "怕热", "消瘦", "突眼", "面色苍白", "头晕", "打鼾", "呼吸暂停",
  "日间嗜睡", "情绪低落", "焦虑", "烦躁", "五心烦热", "口干咽燥", "咽干",
  "胸胁满", "善太息", "纳差", "便溏", "皮疹", "瘙痒",
] as const;
const CLINICAL_NORMALITY_TERMS = [
  "肝功能", "肾功能", "甲状腺功能", "甲功", "血常规", "血红蛋白", "血糖", "血脂",
  "心电图", "肌钙蛋白", "血氧", "胸部影像", "头颅影像",
] as const;
const CLINICAL_POSITIVE_FACT_TERMS = [
  "胸痛", "胸闷", "心悸", "晕厥", "头痛", "视物模糊", "发热", "咳嗽", "气促", "呼吸困难",
  "腹痛", "恶心", "呕吐", "失眠", "入睡困难", "早醒", "盗汗", "潮热", "口苦", "口渴", "便秘", "腹泻",
] as const;
const CLINICAL_NEGATION_FACT_TERMS = [...new Set([...RED_FLAG_NEGATION_TERMS, ...CLINICAL_POSITIVE_FACT_TERMS])];
// 概念分组，而不是一张平表（2026-08-12）。
// 原来是一个扁平数组，只服务于**阳性方向**的红旗召回；否定方向另有一张
// POSITIVE_FACT_EQUIVALENT_GROUPS，而这批词一条都不在里面。于是同一个词表
// 认得「突发意识模糊」是红旗，却认不出「否认意识异常」已经把「意识改变」否掉了——
// 甲方 2026-08-12 实测：风寒感冒病例病历写着「否认意识异常」，随访仍印
// 「意识改变是否存在尚未确认」。分组后两个方向共用同一份数据，不再手抄第二份。
const FOCAL_NEUROLOGIC_CONCEPT_GROUPS: readonly (readonly string[])[] = [
  // 中医病历的意识改变写法（2026-10-19，r1019 验收集 M：「神志昏沉，闭目蜷卧」「神志昏沉、言语混乱」零红旗）。
  // 只收带「神志/神识」前缀或「神昏谵语」整词：「头昏沉」「精神昏沉」是头部或精神不振的描述，不是意识障碍。
  ["意识改变", "意识异常", "意识障碍", "意识不清", "意识模糊", "神志不清", "神志异常", "神志模糊", "神志昏蒙", "不省人事",
    "神志昏沉", "神识昏蒙", "神昏谵语"],
  // 2026-08-13 鲁棒性压测把这一组又推进了一层：**医生按患者口语原样录入**时仍然全线漏检。
  // 实测原句「说话说不清楚，嘴角歪了，一侧手脚没劲，1小时前突然出现」——
  // 线上确定性红旗 0 条、模型语义提示也 0 条，status 只到 needs_information。
  // 这是全系统时间窗最紧的一类急症（溶栓窗），却是零提示。
  // 逐词看漏因很具体：词表有「说话不清」，而口语是「说话说不清楚」（「说话不清」并不连续出现）；
  // 有「口角歪斜」而口语是「嘴角歪了」；有「单侧无力/肢体无力」而口语是「一侧手脚没劲」。
  // 补的是同一批概念的口语面孔，不新增概念、不放宽任何急性/否定判定。
  ["言语不清", "说话不清", "说不清话", "说话说不清", "说话说不清楚", "话说不清", "说话费劲", "说话吐字不清",
    "言语含糊", "口齿不清", "构音不清", "说话含糊", "失语", "不能说话", "不能讲话",
    "言语理解障碍", "语言理解障碍", "言语謇涩", "语言謇涩", "舌强语謇",
    // 中医病历的言语障碍写法（2026-10-19，r1019：「语言不利1天」此前只在重度高血压的靶器官判据里认得，
    // 不伴高血压时零红旗）。慢性病程与后遗症守卫（focalDeficitHasChronicCourseAt / neuroResidualFramingAt）照常适用。
    "言语不利", "语言不利",
    // 「蹇」是「謇」的常见异写（现代医案「语言蹇涩」52 次、「言语蹇涩」35 次，多于正字）。
    "言语蹇涩", "语言蹇涩", "舌强语蹇"],
  ["肢体无力", "手脚无力", "单侧无力", "胳膊腿无力", "手臂无力", "上肢无力", "腿无力", "下肢无力",
    "手脚没劲", "胳膊没劲", "腿没劲", "半边没劲", "半边身子没劲", "一侧没劲", "抬不起胳膊", "抬不起腿",
    "肢体活动不利", "肢体不遂", "半身不遂", "偏身不遂", "半身不用",
    // 同上：四肢、双下肢的活动不利（双下肢急性起病需排除脊髓、马尾与吉兰-巴雷）。单侧「左/右下肢活动不利」不收：
    // 那多是腰椎间盘突出、膝骨关节病的运动受限，不是本组的局灶缺损。
    "四肢活动不利", "双下肢活动不利"],
  ["口角歪斜", "口眼歪斜", "口眼㖞斜", "口舌歪斜", "嘴角歪", "嘴歪", "嘴巴歪", "脸歪", "面部歪斜"],
  ["偏盲"],
];
const FOCAL_NEUROLOGIC_TERMS = [...new Set(FOCAL_NEUROLOGIC_CONCEPT_GROUPS.flat())];

/**
 * 同一临床概念的各种写法（阳性方向展开、否定方向只认真同义——见下面 NARROWER_THAN_GROUP_CANONICAL）。
 * 导出给医生可见正文的「无X→未诉X」改写（diagnosis-visible-summary recordMentionsNegatedTerm）共用：病历写「大便干结5天」时，
 * 鉴别里的「无便秘」不能改成「未诉便秘」（2026-10-19 留出例 S055），那张改写此前只认原词，不认同义写法。
 */
export const POSITIVE_FACT_EQUIVALENT_GROUPS: readonly (readonly string[])[] = [
  // 「低烧」与「低热」同义（2026-10-17 局部发热守卫回放时发现：「每天低烧、下午掌心发热」原先只靠掌心发热被认成发热）。
  ["发热", "发烧", "高热", "低热", "低烧", "体温升高"],
  ["头痛", "头疼", "脑袋疼", "脑袋痛", "头部疼痛", "偏头痛"],
  // High-risk bleeding concepts must be grounded across ordinary patient phrasing. In particular,
  // Chinese aspect markers split the canonical surface ("没吐过血" does not literally contain
  // "吐血"). Without an explicit concept group, the output scrubber can incorrectly weaken a
  // documented denial into "尚未确认呕血" after the clinical review has already accepted it.
  // 「呕红」「呕吐物含血」这批写法与事实层共用 clinical-facts 的 HAEMATEMESIS_COLLOQUIAL_FORMS（只收「呕」开头，见该处）。
  ["呕血", "吐血", "吐过血", "呕出鲜血", "吐出鲜血", "呕咖啡色液体", "吐咖啡色液体", ...HAEMATEMESIS_COLLOQUIAL_FORMS],
  // clinical-facts.ts 的 OVERT_GI_BLEED_LANGUAGE 早就收了「又黑又亮/黑得发亮/黑亮便/大便像柏油」
  // 这批口语，承重的确定性层反而没有——实测「拉的大便又黑又亮，人发晕」确定性红旗 0 条。
  // 两层的词表必须同源，否则模型层一停，最口语的那批写法就全裸奔。
  // 「大便色黑」「黑色大便」「大便呈黑色」（2026-10-19 A 集 A-out-single_0242：「近一月来出现大便色黑，伴有腹痛、易于疲劳」
  // 确定性层没认出黑便，只靠事实层给了「优先复核」，照常给了剂量）。闭集词形，事实层 OVERT_GI_BLEED_LANGUAGE 同步收录。
  ["黑便", "大便发黑", "粪便发黑", "排黑色便", "柏油样便", "又黑又亮", "黑得发亮", "黑亮便",
    "大便像柏油", "大便如柏油", "拉柏油样便", "大便色黑", "粪便色黑", "黑色大便", "大便呈黑色", "大便颜色发黑"],
  ["便血", "血便", "大便带血", "排便带血", "解血便"],
  ["咯血", "咳血", "咳出血"],
  // 出血组原先只存在于 NEGATED_HYPONYM_TABLE（第三份表）。并入主表后，
  // 阳性展开与否定收窄共用同一份数据。
  ["出血", "流血", "大出血", "大量出血"],
  ["放射痛", "疼痛向下肢放射", "疼痛往腿上窜", "痛往腿上窜", "往腿上窜", "向腿部放射", "向下肢放射", "窜到腿上", "串到腿上"],
  ["咳嗽", "干咳", "有痰咳嗽", "咳痰", "咳个不停", "一直咳"],
  // 「咳喘」「喘促」「喘息」也是气促（2026-10-19 Claude 评审 M 集 BEST4SDT-73：病历「入夜则咳喘加重」，辨病依据写「未诉气促」）。
  ["呼吸困难", "气促", "气短", "喘憋", "气喘", "喘不上气", "呼吸费力", "咳喘", "喘促", "喘息"],
  // 体重下降与消瘦同义（SD-433219：病历「体重下降约20kg」，辨病依据写「未诉消瘦」）。
  ["消瘦", "体重下降", "体重减轻", "形体消瘦", "日渐消瘦"],
  ["胸痛", "胸口疼", "心前区痛", "胸口压迫", "胸骨后压榨感"],
  ["腹痛", "肚子疼", "肚子痛", "小肚子疼", "小肚子痛", "小腹疼", "小腹痛", "下腹疼", "下腹痛", "上腹疼", "上腹痛", "胃疼", "胃痛", "胃脘疼", "胃脘痛"],
  ["心悸", "心慌", "心跳快", "心跳加速", "心跳乱", "漏跳感"],
  ["胸闷", "胸口发闷", "胸口憋闷", "胸口堵", "胸部压迫感"],
  ["恶心", "反胃", "想吐"],
  ["呕吐", "吐了", "呕出", "吐出"],
  // 中医病历的便秘写法（2026-10-19）：大便秘结、大便难与便秘同义；大便干结/干燥是粪质、「N天未解大便」是一次未排，记作下位词
  //（阳性方向算写到过便秘，否定方向「否认大便干结」不等于否认便秘）。
  ["便秘", "大便难解", "排便困难", "解不出大便", "排便次数减少", "大便秘结", "大便难", "大便干结", "大便干燥", "未解大便"],
  // 中医病历的失眠写法（2026-10-19）：不寐是中医病名，眠差、寐差、睡眠欠佳与睡眠差同义。
  // 「难以入眠」「不易入睡」「入睡难」（2026-10-24 第十八轮基层病例 B064：「夜里异常兴奋难以入眠」，输出写成「未诉入睡困难」）。
  ["失眠", "入睡困难", "难以入睡", "睡眠差", "睡眠障碍", "不寐", "眠差", "寐差", "睡眠欠佳", "难以入眠", "不易入睡", "入睡难"],
  // 头晕与眩晕（2026-10-19）：病历两种写法混用；眩晕（旋转感）记作头晕的下位词，否定方向不展开。
  ["头晕", "眩晕"],
  ["早醒", "易醒", "多梦易醒", "醒后再睡困难"],
  ["盗汗", "夜间出汗", "夜里出汗", "夜里总出汗", "睡后出汗", "睡着后出汗", "睡眠后出汗", "睡醒后才发现汗湿"],
  ["腹泻", "泄泻", "拉肚子", "稀便", "大便稀", "便稀", "稀稀的", "水样便", "便溏"],
  ["瘙痒", "痒", "鼻痒", "鼻子痒", "眼痒", "眼睛痒", "鼻眼痒", "鼻子眼睛都痒", "皮肤痒", "皮肤瘙痒"],
  // 局灶神经缺损：与阳性方向的红旗召回共用同一份分组，不另抄一份（见上）。
  ...FOCAL_NEUROLOGIC_CONCEPT_GROUPS,
];
/**
 * 下位词：同组里比规范名**更窄**的说法（加了部位、程度或性状限定）。
 *
 * 【为什么必须区分】上面那张表被**两个方向**同时消费，而两个方向的正确答案是相反的：
 *   · 阳性方向（病历里有没有提到这个概念）——展开是对的：「上腹痛」当然能证明「腹痛」。
 *   · 否定方向（病历是不是否认了这个概念）——展开是错的：「否认上腹痛」**不等于**「否认腹痛」。
 * 甲方生产实测（tmp-probe/repro-hyponym.mjs 复现）：病历写「否认高热」，医生看到的是
 * 「病历已记录否认发热」——一个只被否认了 subtype 的症状类，被呈现成整类都排除了。
 * 同类还有「否认干咳」→「否认咳嗽」、「否认上腹痛」→「否认腹痛」、
 * 「否认入睡困难」→「否认失眠」，方向全都是不安全的那一侧。
 *
 * 更麻烦的是：正确措辞其实早就写好了（unknownTermNotice 会输出
 * 「病历已记录否认高热，发热的一般情况需医生核实」），但它永远走不到——
 * sourceDocumentsNegation 先靠同义组把「否认发热」判成已接地，直接返回了。
 * 这是同一条判据在两处各写各的：一处把高热当发热的同义词，另一处把高热当发热的下位词。
 *
 * 【口径】宁可多标。误标成下位词只会让措辞更保守（多一句「需医生核实」），
 * 漏标才会把「只否认了一个亚型」说成「整类已排除」。
 */
/**
 * 下位词自己的同义写法（与上位词无关，只是同一个窄概念换个说法）。判「否认与病历相反」时，下位词要求病历写到它本身——
 * 这些写法也算写到（2026-10-24 第十八轮基层病例 B064：「夜里异常兴奋难以入眠」，输出「未诉入睡困难」没被删）。闭集。
 */
export const NARROWER_TERM_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  入睡困难: ["难以入睡", "难以入眠", "不易入睡", "入睡难"],
};
export const NARROWER_THAN_GROUP_CANONICAL: ReadonlySet<string> = new Set([
  // 程度限定
  "高热", "低热", "低烧", "壮热", "中等度热", "大出血", "大量出血",
  // 颜色限定：「否认呕鲜血」不等于否认咖啡样呕吐物
  "呕鲜血", "呕吐鲜血", "呕吐物中有鲜红血", "呕吐物中可见鲜血",
  // 具体病名/性状限定
  "偏头痛", "干咳", "有痰咳嗽", "咳痰", "水样便",
  "心前区痛", "胸骨后压榨感", "心跳快", "心跳加速", "心跳乱", "漏跳感",
  // 部位限定
  "单侧无力", "上肢无力", "下肢无力", "腿无力", "手臂无力", "双下肢活动不利",
  "小肚子疼", "小肚子痛", "小腹疼", "小腹痛", "下腹疼", "下腹痛",
  "上腹疼", "上腹痛", "胃疼", "胃痛", "胃脘疼", "胃脘痛",
  "鼻痒", "鼻子痒", "眼痒", "眼睛痒", "鼻眼痒", "鼻子眼睛都痒", "皮肤痒", "皮肤瘙痒",
  // 时相限定
  "入睡困难", "难以入睡", "多梦易醒", "醒后再睡困难", "排便次数减少",
  // 粪质、单次未排与旋转性头晕（2026-10-19，见上表）
  "大便干结", "大便干燥", "未解大便", "眩晕",
]);

/** 否定方向可替换的等价说法：只含真同义，绝不含下位词。 */
function negationGroundingEquivalents(term: string): readonly string[] {
  if (NARROWER_THAN_GROUP_CANONICAL.has(term)) return [term];
  const group = POSITIVE_FACT_EQUIVALENT_GROUPS.find((item) => item.includes(term));
  if (!group) return [term];
  return group.filter((item) => !NARROWER_THAN_GROUP_CANONICAL.has(item));
}

/** term 的下位词（用于「只否认了亚型」的如实措辞）。与上面同一张表，不另立第二份。 */
function groupHyponymsOf(term: string): readonly string[] {
  if (NARROWER_THAN_GROUP_CANONICAL.has(term)) return [];
  const group = POSITIVE_FACT_EQUIVALENT_GROUPS.find((item) => item.includes(term));
  if (!group) return [];
  return group.filter((item) => NARROWER_THAN_GROUP_CANONICAL.has(item));
}

/**
 * 皮肤上的具体皮损形态（闭集）。疱疹/水疱前面同一分句里写的是口咽黏膜部位时不算（「咽峡及软腭部可见疱疹」是疱疹性咽峡炎，
 * 不是皮疹；2026-10-19 回放验收集 D）。
 */
export const SKIN_LESION_FORM = /(?<![咽峡腭口舌唇颊龈][^，,。；;]{0,16})(?:水疱|水泡|疱疹)|红斑|丘疹|风团|斑疹|疱疮/u;

const POSITIVE_FACT_EQUIVALENT_PATTERNS: readonly {
  terms: readonly string[];
  patterns: readonly RegExp[];
}[] = [
  {
    terms: POSITIVE_FACT_EQUIVALENT_GROUPS.find((group) => group.includes("头痛")) || ["头痛"],
    patterns: [
      // Patients commonly describe headache by location and pain quality without using the
      // canonical noun “头痛” (for example “右边脑袋一跳一跳地疼”). Match the
      // location phrase itself so the shared negation-scope check still protects “脑袋不疼”.
      /(?:脑袋|头部|后脑勺|太阳穴)[^。；;\n]{0,12}(?:疼|痛|胀|跳|刺)/,
      // Tight-band headache is commonly charted without the words 疼/痛 ("头上像戴了个紧箍").
      // It still establishes the existence of a headache-type complaint; severity, cause and
      // associated symptoms remain separate attributes and may legitimately stay unknown.
      /(?:头上|头部|脑袋)[^。；;\n]{0,12}(?:紧箍|箍紧|勒紧|绷紧|紧胀)/,
    ],
  },
  {
    // 病历写了具体皮损形态就算写到了「皮疹」这个总称（单向：写了皮疹不等于写了风团）。2026-10-19 甲方标准病历 9：病历「搔抓后迅速
    // 出现红色风团」，鉴别行「风瘙痒无原发皮疹」被当成本例未记录皮疹改成「病历尚未确认皮疹是否存在」，交付成「未诉皮疹」。
    // diagnosis-visible-summary 的「无皮疹→未诉皮疹」改写读同一个式子（SKIN_LESION_FORM）。
    terms: ["皮疹"],
    patterns: [SKIN_LESION_FORM],
  },
  {
    terms: POSITIVE_FACT_EQUIVALENT_GROUPS.find((group) => group.includes("咳嗽")) || ["咳嗽"],
    patterns: [
      // Colloquial charting often records the event as a verb ("老咳一口白痰", "咳几声")
      // rather than the noun 咳嗽. Start the match at 咳 so the shared negation-scope check still
      // sees preceding "不/没有/否认" and cannot turn a denied cough into an affirmed symptom.
      /咳(?:了)?(?:一|两|几|三|四|五|\d+)\s*(?:口|声)/,
      /咳(?:出|着|起来|个不停)/,
    ],
  },
  {
    terms: POSITIVE_FACT_EQUIVALENT_GROUPS.find((group) => group.includes("入睡困难")) || ["入睡困难"],
    patterns: [
      // Patients often quantify sleep latency without naming insomnia ("得一两个小时才睡着").
      // That still establishes difficulty initiating sleep, while duration/severity and cause may
      // remain unknown. Keep explicit negation in the match window for the shared polarity check.
      /(?:(?:躺|上床|入睡|睡觉)[^。；;\n]{0,18})?(?:要|得|需|花)[^。；;\n]{0,10}(?:小时|分钟)[^。；;\n]{0,8}才(?:能)?睡着/,
      /(?:躺|上床)[^。；;\n]{0,20}才(?:能)?睡着/,
    ],
  },
  {
    terms: POSITIVE_FACT_EQUIVALENT_GROUPS.find((group) => group.includes("呼吸困难")) || ["呼吸困难"],
    patterns: [
      // Colloquial exertional wheeze is a documented respiratory positive even when the patient
      // does not use the noun 呼吸困难. This only prevents output from relabelling the known
      // manifestation as unknown; red-flag urgency remains owned by the safety gate.
      /(?:胸口|胸部)[^。；;\n]{0,8}(?:呼呼响|喘鸣|哮鸣)/,
      /(?:喘鸣|哮鸣)(?:音|声)?/,
    ],
  },
  {
    terms: POSITIVE_FACT_EQUIVALENT_GROUPS.find((group) => group.includes("腹痛")) || ["腹痛"],
    patterns: [
      // A location plus colloquial “疼/痛” is the same positive abdominal-pain concept. Keep
      // the gap free of explicit negators so “肚子一点也不疼” cannot become an affirmation.
      /(?:肚子|小肚子|腹部|小腹|下腹|上腹|胃脘|胃部|肚脐周围)(?:(?!不|没|无|未)[^.。；;\n]){0,8}(?:疼|痛)/,
    ],
  },
  {
    terms: POSITIVE_FACT_EQUIVALENT_GROUPS.find((group) => group.includes("便秘")) || ["便秘"],
    patterns: [
      /大便[^。；;\n]{0,10}(?:解不出(?:来)?|排不出(?:来)?|拉不出(?:来)?|难解)/,
      /(?:排便|解大便)[^。；;\n]{0,8}(?:困难|费劲|不畅)/,
      /(?:隔)?[二两三四五六七八九十\d]{1,3}(?:[至到－—-][二两三四五六七八九十\d]{1,3})?天[^。；;\n]{0,4}(?:一|1)次/,
      /(?:每周|一周)[^。；;\n]{0,6}(?:[一二两12]次|少于三次|不足三次|不到三次)/,
    ],
  },
];
const DEGREE_AFTER_NEGATOR = "(?:很|太|特别|十分|非常|明显|严重|剧烈|轻|重|持续|一直)";
// 「未明显发热」与「无明显发热」同义，是否认（2026-10-25 第二十轮，甲方 100 例 C038 读成记录了发热）；「未明显好转/缓解」不是对表现的否认。
const CLINICAL_NEGATION_CUE = new RegExp(`(否认|不是(?!${DEGREE_AFTER_NEGATOR})|并非(?!${DEGREE_AFTER_NEGATOR})|不曾|均无|均未见|未见|未明显(?!好转|缓解|改善|减轻|变化|加重)|未诉|未出现|没有|不伴|无明显|无再发|未再发|(?:当前|目前|现阶段|患者|病人)?(?:从未有|未曾有|无)(?=[\\u4e00-\\u9fa5]))`);
// 否定作用域的终止判据(2026-08-04 修正)。
//
// 原判据只在逗号**后接转折词**时断作用域(「无胸痛，但突发晕厥」)。但中文病历里更常见的是
// 平铺并列:「无高热，头痛明显，周身酸痛，咳嗽不重」——这里「无」只否定紧随其后的「高热」,
// 逗号之后是各自独立的阳性陈述。原判据下,「无」的作用域一路蔓延过逗号,于是服务端
// 生成出「病历已记录否认头痛、发热」——**而病历原文明写「头痛明显」**。
// 生产实测:该串在一份 M03 输出里出现 5–6 次,并写进了病名鉴别的 distinguishingPoints,
// 医生看到的是系统「否认」了一个白纸黑字记录着的主症。
//
// 判据改为:逗号本身即终止否定作用域,**除非**逗号后是并列的否定延续
// (「无发热、咳嗽、消瘦」这种一个否定辖多项的列举,以及「无发热，无咳嗽」的重复否定,
// 前者用顿号、后者自带否定词,都不会被这条规则误伤——顿号不在此列,重复否定各自成立)。
// 保留原有的转折词形态是冗余但无害的:逗号已经断了,转折词只是更明确的信号。
//
// 方向上这是**收紧否定、放宽阳性**:宁可少判一个「已否认」(退化为「尚未确认」,
// 医生会去核实),也不能把病历白纸黑字的阳性主症说成否认——后者是直接的临床事实错误。
const NEGATION_SCOPE_BREAK = /[，,]/;
const NON_SYMPTOM_NEGATION_OBJECT = /(?:诱因|原因|缓解|好转|改善|变化|异常检查)/;

function hasImmediateBareNegator(text: string, index: number): boolean {
  // The broad assertion parser deliberately does not treat every bare “不/未” as a negation cue,
  // because phrases such as “不很严重” describe degree rather than absence. Here the cue is
  // accepted only when it is immediately adjacent to the matched clinical expression, or when a
  // short patient-action/aspect phrase is wholly inside the negation ("没解过柏油样便"). This
  // covers ordinary directional and event denials without letting a distant “不/未” cross clauses.
  return /(?:[不未无没]|(?:没有|没|未|无)(?:排|解|拉|咳|吐|呕|出现|发生|见|诉)?过?)\s*$/.test(
    text.slice(Math.max(0, index - 8), index),
  );
}

/**
 * 限定词塌缩的呈现修正：模型把「否认高热」压缩成「否认发热」、「否认突发最剧烈头痛」压缩成
 * 「否认头痛」时，净化器按接地纪律改写成「病历尚未确认发热是否存在」在逻辑上没错
 * （否认高热确实不排除低热），但对医生是自相矛盾的呈现（甲方生产实测）。
 * 这里识别「记录否认了 term 的更具体变体」：后缀限定（X=修饰+term）走通用规则，
 * 少数非后缀的临床上下位对（高热/低热→发热）走小表。命中时提示改为
 * 「病历已记录否认<变体>；<term>的一般情况需医生核实」。
 */
function documentedQualifiedDenial(source: string, term: string): string | undefined {
  const normalized = normalizeClinicalText(source);
  const qualifiers = "(?:持续|突发|突然|急性|反复|阵发性?|间断|明显|大量|剧烈|进行性|严重|轻微|最)";
  const candidates = [
    new RegExp(`${qualifiers}{1,3}${term}`, "g"),
    ...groupHyponymsOf(term).map((variant) => new RegExp(variant, "g")),
  ];
  for (const pattern of candidates) {
    for (const match of normalized.matchAll(pattern)) {
      const variant = match[0];
      if (variant === term) continue;
      if (sourceDocumentsNegation(normalized, variant)) return variant;
    }
  }
  return undefined;
}

/** 本次出现是否整个落在某个下位词内部（「出血」落在「大出血」里）。 */
function occurrenceIsInsideNarrowerTerm(
  sentence: string, index: number, length: number, term: string,
): boolean {
  for (const narrower of groupHyponymsOf(term)) {
    if (narrower === term || !narrower.includes(term)) continue;
    let at = sentence.indexOf(narrower);
    while (at >= 0) {
      if (at <= index && index + length <= at + narrower.length) return true;
      at = sentence.indexOf(narrower, at + narrower.length);
    }
  }
  return false;
}

/**
 * 「病历确实否认了这一项」该怎么说——一处措辞，所有确认点共用。
 *
 * 病历只否认了更窄的变体时，必须**如实说那个变体**，不能把它说成整类已排除。
 * 甲方实测：病历「否认突发最剧烈头痛」，医生看到「病历已记录否认头痛」——
 * 而同一行前半句还写着「病历已记录头痛阳性」，自相矛盾。
 * 返回 undefined 表示病历根本没有否认这一项。
 */
function documentedDenialNotices(source: string, terms: readonly string[]): {
  notices: string[];
  covered: Set<string>;
} {
  const plain: string[] = [];
  const qualifiedNotices: string[] = [];
  const covered = new Set<string>();
  for (const term of terms) {
    const qualified = documentedQualifiedDenial(source, term);
    if (qualified) {
      qualifiedNotices.push(`病历已记录否认${qualified}，${term}的一般情况需医生核实`);
      covered.add(term);
      continue;
    }
    if (sourceDocumentsNegation(source, term)) {
      plain.push(term);
      covered.add(term);
    }
  }
  // 普通否认仍然合并成一句（「病历已记录否认言语不清、肢体无力」）——那是既有措辞，
  // 拆成逐条会让一行里重复四个字。只有「病历只否认了更窄的变体」这一类必须单列，
  // 因为它带着各自不同的变体名与核实提示。
  return {
    notices: [
      ...(plain.length > 0 ? [`病历已记录否认${plain.join("、")}`] : []),
      ...qualifiedNotices,
    ],
    covered,
  };
}

function unknownTermNotice(source: string, terms: readonly string[]): string {
  const parts = terms.map((term) => {
    const denied = documentedQualifiedDenial(source, term);
    return denied
      ? `病历已记录否认${denied}，${term}的一般情况需医生核实`
      : `病历尚未确认${term}是否存在`;
  });
  return parts.join("；");
}

/**
 * 含「无」字的固定说法不是否认：面色无华、爪甲无泽、无光泽、无血色，以及短语末尾的目无神、口淡无味、脉沉细无力（2026-10-18 逐模块验收
 * 考试病例集 X-C-0137：模型写「面色无华、纳差、大便溏薄、舌淡苔白腻、脉缓，为脾运不健」，「无华」的「无」被当成前置否认词，纳差、便溏
 * 落进否认范围，病历里同样的「面色无华，纳差」也读不出纳差是阳性，整句被改成「病历尚未确认纳差是否存在；…便溏…」，面色、舌脉一并丢失）。
 * 只用于判断否认词（等长替换，下标不变）；找症状词仍用原文。「无神志不清」「无味觉减退」这类后面还接着词的照旧是否认。
 * 与 unrecordedNegativesAsNotReported 排除的固定搭配是同一类。类夹具 fixed-wu-word-not-negation-cue。
 */
export function maskNonNegatingWuWords(text: string): string {
  // 问句「有无X」「有没有X」里的「无」「没有」也不是否认（unassessedMentionAt，2026-10-25 第二十轮）。
  return text
    .replace(/无(?=(?:华|泽|光泽|血色)|(?:神|味|力)(?=[，,。；;、）)\s]|$))/gu, "＿")
    .replace(/有(无|没有|否(?!认))/gu, (_, word: string) => `有${"＿".repeat(word.length)}`)
    // 「无法行走」「无法入睡」是不能（症状本身），「漫无目的」「无精打采」是成语；「无法（完全）排除/否认X」是排除不了（可能有），不在此列。
    .replace(/无(?=法(?!(?:完全|彻底|明确|轻易|简单)?(?:排除|除外|否认)))|(?<=漫)无(?=目的)|无(?=精打采)/gu, "＿");
}

export function sourceDocumentsNegation(source: string, term: string): boolean {
  const normalized = normalizeClinicalText(source);
  // 否定方向只认真同义，不认下位词——「否认高热」不给「否认发热」背书。
  const equivalents = negationGroundingEquivalents(term);
  for (const sentenceMatch of normalized.matchAll(/[^。；;\n]+/gu)) {
    const rawSentence = sentenceMatch[0];
    const sentenceOffset = sentenceMatch.index ?? 0;
    const sentence = maskNonNegatingWuWords(rawSentence);
    for (const equivalent of equivalents) {
      let termIndex = sentence.indexOf(equivalent);
      while (termIndex >= 0) {
        // 「大出血」里含着「出血」两个字。若这次出现整个落在某个**下位词**里，
        // 那么被否认的是那个下位词，不是本词——否则上面的收窄会被子串匹配绕开
        // （实测：病历「否认大出血」→ 输出「病历已记录否认出血」）。
        // 下位词里的那一次、以及不是对本例当下的记载（家属的、假设的、未评估的：「是否黑便尚未询问」「有无发热不详」）都不算本例的否认
        //（2026-10-25 第二十轮：「有无」里的「无」曾被当成否认词，「未询问」的表现读成了否认）。
        // 问句里的表现、答句说「没有」：是记载的否认（questionAnswerPolarityAt）。
        if (!occurrenceIsInsideNarrowerTerm(sentence, termIndex, equivalent.length, term) && questionAnswerPolarityAt(normalized, sentenceOffset + termIndex) === "negative") return true;
        if (occurrenceIsInsideNarrowerTerm(sentence, termIndex, equivalent.length, term) || isExcludedClinicalAssertionAt(sentence, termIndex)) {
          termIndex = sentence.indexOf(equivalent, termIndex + equivalent.length);
          continue;
        }
        if (hasImmediateBareNegator(sentence, termIndex)) return true;
        const before = sentence.slice(Math.max(0, termIndex - 24), termIndex);
        const negations = Array.from(before.matchAll(new RegExp(CLINICAL_NEGATION_CUE.source, "g")));
        const nearest = negations.at(-1);
        if (nearest?.index != null) {
          const between = before.slice(nearest.index + nearest[0].length);
          // 列举里先出现正常所见或频度起首的一项（「无口干口苦、纳可、眠可、经常腹泻」），否认到它之前为止——与 isNegatedAt 同一判据。
          const runBroken = between.split(/[、，,]/u).slice(1).some((item) => ENUMERATION_RUN_BREAK_ITEM.test(item.trim()));
          if (!runBroken && !NEGATION_SCOPE_BREAK.test(between) && !NON_SYMPTOM_NEGATION_OBJECT.test(between)) return true;
        }
        // 后置否定（2026-08-09 收窄）。原判据是「术语后面紧跟否定词即判已否认」，
        // 但中文里否定词否定的是**它后面**的东西，不是前面的。于是
        //   「发热无汗」  → 无 否定的是汗，发热是阳性主症
        //   「发热无恶寒」→ 同上
        //   「头晕无力」  → 「无力」整个是症状词，根本不是否定
        // 全部被判成「病历已记录否认发热/头晕」——直接把病历白纸黑字的阳性主症说成否认。
        // 这与 :348 注释记载的前置方向缺陷是同一类（那次修的是「无高热，头痛明显」），
        // 后置方向当时没跟上。
        //
        // 合法的后置否定只有清单式记录：「发热：无」「发热无。」——否定词处在**分句末或标点前**。
        // 实测 695 份病历：分句末形态 0 例，「否定词后面还跟着字」6 例且全部是误判
        // （发热无汗 ×3、发热无恶寒 ×1、头晕无力 ×2），无一真阳性。
        // 因此判据加一条「否定词必须收尾」，既保住清单式记录，又消灭全部前向误判。
        const after = sentence.slice(termIndex + equivalent.length, termIndex + equivalent.length + 10);
        // 允许术语与否定词之间有分隔符：清单式病历写作「发热：无」「发热 无」。
        // 这一步之所以安全，正是因为下面的「收尾」判据——「发热，无汗」虽有分隔符，
        // 但否定词后面还跟着字，仍然不算否定。
        const postfixNegation = after.match(
          new RegExp(`^[：:、\\s]?(?:均)?(?:未见|未诉|未出现|否认|不是(?!${DEGREE_AFTER_NEGATOR})|并非(?!${DEGREE_AFTER_NEGATOR})|不曾|没有|无)`),
        );
        if (postfixNegation) {
          const trailing = after.slice(postfixNegation[0].length);
          if (trailing === "" || /^[，,、：:）)]/.test(trailing)) return true;
        }
        termIndex = sentence.indexOf(equivalent, termIndex + equivalent.length);
      }
    }
  }
  return false;
}

function freshAbsoluteDateInText(value: string, maxAgeDays = 30): boolean {
  const match = value.match(/(?:(\d{4})[-年\/](\d{1,2})[-月\/](\d{1,2})日?)/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return false;
  const ageDays = (Date.now() - timestamp) / 86_400_000;
  return ageDays >= -1 && ageDays <= maxAgeDays;
}

/** 检查名的常用简称（只用于在病历里找这项检查的那句记录）。 */
// 血氧的病历写法（2026-10-24 第十八轮基层病例 B002：「测指脉氧饱和度97%」，输出写成「病历未记录本次血氧结果」）。
const EXAM_TERM_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  甲功: ["甲状腺功能"], 甲状腺功能: ["甲功"],
  血氧: ["指脉氧", "氧饱和度", "SpO2", "SPO2", "指氧"], 血氧饱和度: ["指脉氧", "氧饱和度", "SpO2", "SPO2", "指氧"],
};
/**
 * 病历里关于这项检查结果的那一句（去掉「辅助检查：」这类字段标签），照录给医生看；病历没写这项检查的结果时说「病历未记录本次X结果」。
 * 只照录、不判断新旧：新旧由 sourceDocumentsCurrentNormality 判，这里只负责让医生看到原文。
 */
function recordedExamResultNotice(source: string, term: string): string {
  const names = [term, ...(EXAM_TERM_SYNONYMS[term] || [])];
  const sentence = normalizeClinicalText(source).split(/[。；;\n]+/)
    .map((item) => item.replace(/^\s*[^：:，,]{1,8}[：:]\s*/u, "").trim())
    // 结果也可以只是一个带单位的读数（「指脉氧饱和度97%」「血红蛋白92g/L」）。
    .find((item) => names.some((name) => item.includes(name)) &&
      /(?:正常|异常|升高|降低|阳性|阴性|未见|增高|减低)|\d+(?:\.\d+)?\s*(?:%|mmol|μmol|umol|g\/L|mg|U\/L|×10|次\/分)/u.test(item));
  return sentence && sentence.length <= 60 ? `病历记录${sentence}` : `病历未记录本次${term}结果`;
}

function sourceDocumentsCurrentNormality(source: string, term: string): boolean {
  const stale = /(既往|曾经|曾有|曾|陈旧|以前|之前|过去|当时|去年|上[周月次年]|前几[天日]|(?:\d+|[一二两三四五六七八九十半数几多])\s*(?:年|个月|月|周|天|日)前)/;
  const normal = /(正常|未见(?:明显)?异常|无(?:明显)?异常|阴性|未升高|参考范围内|功能良好)/;
  const abnormal = /(?:明显)?异常|升高|降低|阳性|受损|不全/;
  return normalizeClinicalText(source).split(/[。；;\n]+/).some((sentence) => {
    const isCurrent = /(?:本次|今日|今天|当前|目前|现查|此次)/.test(sentence) || freshAbsoluteDateInText(sentence);
    if (!isCurrent || stale.test(sentence)) return false;
    const groupedNormal = /(?:均|皆)[^，,。；;]{0,8}(?:正常|未见(?:明显)?异常|无(?:明显)?异常|阴性|未升高|参考范围内)/.test(sentence);
    return sentence.split(/[，,、]+/).some((clause) => {
      if (!clause.includes(term)) return false;
      const resultText = clause.slice(clause.indexOf(term) + term.length);
      const cleanedResult = resultText.replace(/未见(?:明显)?异常|无(?:明显)?异常/g, "正常");
      if (abnormal.test(cleanedResult)) return false;
      return normal.test(resultText) || groupedNormal;
    });
  });
}

/**
 * 「发热」接在身体部位之后（手心脚心发热、关节局部发热、面部发热）或后面跟「感」（发热感）时，说的是局部或自觉的热，
 * 不是体温升高的「发热」。2026-10-17：病历同时写「手心脚心发热」与「无发热」时，净化器把模型的「否认发热」改成
 *「病历已记录发热阳性；病历已记录否认发热」，交付面再译成「有发热；否认发热」——10/14 合成集 5 例、独立评审留出集
 * 西医鉴别不通过 8 例里的 2 例。冻结令允许的构词式词法守卫：「发热」紧前一个字是身体部位的词尾（心、足、手、掌、底、背、腰、面、颊、
 * 肢、节、处、肤、部，以及胸中、心中）——有限闭集，按字而不按整词，所以「足底发热」「手掌发热」这类没见过的组合也认得；
 *「恶心发热」的心不算。只作用于本净化器判「病历记录了该症状」这一处，安全闸门的发热判定不走这里。
 *「身体/全身/午后/自觉发热」仍按发热处理；「身体热度不退」这类不含「发热」字样的说法本来就认不出（语料回放 1 例，残留）。
 * 类夹具 scripts/fixtures/open-language-classes/local-heat-not-fever.json。
 */
const LOCAL_HEAT_SITE_BEFORE_FEVER = /(?:(?<!恶)心|[手足掌底背腰面颊肢节处肤部]|胸中|心中)$/;
function isLocalHeatNotFeverAt(sentence: string, index: number, equivalent: string): boolean {
  if (equivalent !== "发热") return false;
  return sentence[index + equivalent.length] === "感" || LOCAL_HEAT_SITE_BEFORE_FEVER.test(sentence.slice(Math.max(0, index - 4), index));
}

/**
 * 否认的是带程度/起病限定的那一种（「无剧烈头痛」「无突发头痛」「无喷射性呕吐」），病历里只有不带限定的症状本身（「头痛，呈隐痛」）：
 * 两者是不同的事实，不能把模型的否认改写成「病历已记录头痛阳性」（2026-10-19，甲方标准病历 3 第 2 次生成：真头痛鉴别的
 *「无剧烈头痛」交付成「有头痛；有头痛；未诉剧烈头痛」，辨病依据成「…，有头痛，故与二者区分」）。
 * 冻结令允许的确定性例外：有限闭集（限定词）+ 构词式守卫。span 里该词的每一处前面都紧挨着一个限定词、且病历没有肯定
 * 「限定词+该词」时返回 true；病历确实写了带限定的那一种（「突发剧烈头痛」）时照旧改写。类夹具 qualified-negation-not-bare-symptom。
 */
// 「明显」不在内：「无明显呕吐」「无明显消瘦」在病历里就是否认（语料回放 X-G-2004、H-tri-16069：病历写着「恶心呕吐」「日渐消瘦」，
// 模型写「无明显呕吐」「无明显消瘦」，那是真矛盾，要照旧改正）。
export const NEGATED_TERM_QUALIFIER_SOURCE = "最剧烈|剧烈|突发|突然|骤然|爆裂样|爆炸样|雷击样|撕裂样|刀割样|持续性|进行性|喷射性|喷射状|大量|频繁|严重|急性|剧";
/** 病历里写了带限定的那一种：「剧烈头痛」或倒装的「头痛剧烈」「头痛较剧烈」（同一小句、非否定）。 */
function qualifiedFormDocumented(source: string, qualifier: string, term: string): boolean {
  if (sourceDocumentsAffirmation(source, `${qualifier}${term}`)) return true;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return hasPatternWithoutNegation(normalizeClinicalText(source), new RegExp(`${escape(term)}[^，,。；;\\n无未]{0,4}${escape(qualifier)}`, "u"));
}
/** 「剧烈头痛」这类带限定词的复合项，病历写的是倒装的「头痛剧烈」（2026-10-25 第二十轮：复合项此前只按字面找，倒装写法落成「尚未确认剧烈头痛」）。 */
function qualifiedCompoundDocumented(source: string, term: string): boolean {
  const qualifier = term.match(new RegExp(`^(?:${NEGATED_TERM_QUALIFIER_SOURCE})`, "u"))?.[0];
  return Boolean(qualifier) && term.length > qualifier!.length + 1 && qualifiedFormDocumented(source, qualifier!, term.slice(qualifier!.length));
}
// 倒装的程度限定（「无头痛剧烈」「未见头痛如劈」，2026-10-19 甲方标准病历 3 第 1 次生成辨病依据成「…故归头痛；有头痛。」）。
const POSTPOSED_TERM_QUALIFIER = /^(?:较|很|特别|极|甚)?(?:剧烈|如劈|欲裂|如裂|难忍|剧)/u;
function termOnlyQualifiedIn(span: string, term: string, source: string): boolean {
  const qualifierAtEnd = new RegExp(`(?:${NEGATED_TERM_QUALIFIER_SOURCE})$`, "u");
  let at = span.indexOf(term);
  let seen = false;
  while (at >= 0) {
    const qualifier = span.slice(Math.max(0, at - 5), at).match(qualifierAtEnd)?.[0] ||
      span.slice(at + term.length, at + term.length + 4).match(POSTPOSED_TERM_QUALIFIER)?.[0]?.replace(/^(?:较|很|特别|极|甚)/u, "");
    if (!qualifier || qualifiedFormDocumented(source, qualifier, term)) return false;
    seen = true;
    at = span.indexOf(term, at + term.length);
  }
  return seen;
}

/**
 * 病历测得的最高体温（「T 38.0℃」「体温38.5℃」；只认 34–43℃）。发热类词的「病历记录了」也包括测得的体温（2026-10-24 甲方 100 例 C072：
 * 18 月龄 T 38.0℃，辨病依据的「无发热」被净化成「病历尚未确认发热是否存在」，交付成「未诉发热」）。
 */
export function recordedMaxBodyTemperature(source: string): number | undefined {
  let max: number | undefined;
  for (const match of String(source || "").normalize("NFKC").matchAll(/(?:\bT|体温)\s*[:：]?\s*(\d{2}(?:\.\d)?)\s*(?:℃|°C|度)?/gu)) {
    const value = Number(match[1]);
    if (value >= 34 && value <= 43 && (max === undefined || value > max)) max = value;
  }
  return max;
}
const FEVER_TERM_MIN_TEMPERATURE: Readonly<Record<string, number>> = { 发热: 37.3, 发烧: 37.3, 身热: 37.3, 体温升高: 37.3, 低热: 37.3, 高热: 39 };

export function sourceDocumentsAffirmation(source: string, term: string): boolean {
  return affirmationMentionKind(source, term).kind !== "none";
}

/**
 * 病历里该词的肯定记载是哪一种：clear（这一小句本身就是肯定：「头痛明显」「偶有胸痛」「T 38.5℃」）、ambiguous（否认列举后的裸词，
 * 只因为后面别的小句里有程度/时间词才没算进否认——见 isNegatedAt 的 afterTermScope），none（没有肯定记载）。
 * sourceDocumentsAffirmation 两种都算（与改动前同一结论）；recordedFindingReading 把后一种读成不明确。
 */
function affirmationMentionKind(source: string, term: string): { kind: "clear" | "ambiguous" | "none"; negatedMention: boolean } {
  const feverFloor = FEVER_TERM_MIN_TEMPERATURE[term];
  let clear = false;
  let ambiguous = false;
  let negatedMention = false;
  if (feverFloor !== undefined) {
    const measured = recordedMaxBodyTemperature(source);
    if (measured !== undefined && measured >= feverFloor) clear = true;
  }
  const normalized = normalizeClinicalText(source);
  const equivalents = POSITIVE_FACT_EQUIVALENT_GROUPS.find((group) => group.includes(term)) || [term];
  const conceptPatterns = POSITIVE_FACT_EQUIVALENT_PATTERNS.find((item) => item.terms.includes(term))?.patterns || [];
  for (const sentence of normalized.split(/[。；;\n]+/)) {
    const cueSentence = maskNonNegatingWuWords(sentence);
    for (const equivalent of equivalents) {
      let index = sentence.indexOf(equivalent);
      while (index >= 0) {
        if (
          !isLocalHeatNotFeverAt(sentence, index, equivalent) &&
          !isExcludedClinicalAssertionAt(sentence, index) &&
          // 「待核实/不详/未知」这类未评估说法只管它所在小句里的那个表现（isExcludedClinicalAssertionAt → unassessedMentionAt）；
          // 此前按整句判，同一句别处一个「（具体不详）」就把「伴恶心」也算成没记录（2026-10-25 第二十轮，基层病例 B004）。
          !hasImmediateBareNegator(cueSentence, index)
        ) {
          // 与 hasNonNegatedClinicalPattern 同一判据：前面有否认、逗号后另起肯定小句的，算记录了（MTCMB-14）。
          const positiveClause = hasCommaSeparatedPositiveEvidence(cueSentence, index, equivalent);
          if (positiveClause || !isNegatedAt(cueSentence, index)) {
            if (positiveClause || !isNegatedAt(cueSentence, index, "clause")) clear = true;
            else ambiguous = true;
          } else if (negationReachesMentionDirectly(cueSentence, index, equivalent)) {
            negatedMention = true;
          }
        }
        index = sentence.indexOf(equivalent, index + equivalent.length);
      }
    }
    for (const pattern of conceptPatterns) {
      const matches = sentence.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`));
      for (const match of matches) {
        if (match.index != null && !isExcludedClinicalAssertionAt(sentence, match.index) && !isNegatedAt(sentence, match.index)) clear = true;
      }
    }
  }
  return { kind: clear ? "clear" : ambiguous ? "ambiguous" : "none", negatedMention };
}

/**
 * 自带谓语的项（「眠差」「入睡困难」「食欲下降」「鼻塞声重」「咳嗽有痰」）：在说有，不是否认列举在逗号后延续的裸词。
 * 病历读法（negationReachesMentionDirectly）与读法核对提示（commaContinuedDenialReadingNotice）共用这一处
 *（2026-10-25 第二十轮：「无明显发热，食欲下降」曾读成否认食欲下降——读法用的是只看字数的裸词判据，提示用的是这一条）。
 */
const OWN_PREDICATE_ITEM = /[有伴见感觉作]|(?:差|少|多|可|调|佳|好|难|困难|不利|不畅|不适|欠佳|明显|重|轻|甚|剧|频|稀|干|黄|赤|红|淡|白|胀|紧|减退|增多|减少|加重|缓解|正常|下降|升高|降低|增加|不振|减弱|亢进|异常)$/u;
/**
 * 闸门判否认的这一处，是不是可以当作「病历否认了它」来读：否认词与它在同一逗号小句里（「无发热」「无发热、呕吐」），
 * 或它是否认列举在逗号后延续的裸词——这一小句里只有它自己，且与否认那一小句之间至多隔一个同样的短裸词小句
 *（「无呕吐，发热」「无腹痛，发热，呕吐」）。带了自己谓语的小句（「无汗，鼻塞声重，咳嗽有痰」）与隔得更远的
 *（「无食欲，眠差，入睡困难，小便调，便秘」）闸门的列举延续判成否认，读法不认。构词式守卫，只用于病历读法与照录核对，闸门不读。
 */
function negationReachesMentionDirectly(sentence: string, index: number, equivalent: string): boolean {
  const clauseStart = Math.max(sentence.lastIndexOf("，", index - 1), sentence.lastIndexOf(",", index - 1)) + 1;
  if (CLINICAL_NEGATION_CUE.test(sentence.slice(clauseStart, index))) return true;
  const rest = sentence.slice(index + equivalent.length);
  const clauseEnd = rest.search(/[，,。；;\n]/u);
  const tail = (clauseEnd >= 0 ? rest.slice(0, clauseEnd) : rest).trim();
  if (sentence.slice(clauseStart, index).trim() !== "" || !/^(?:等|等症|等症状)?$/u.test(tail)) return false;
  // 这一项或中间隔着的项自带谓语（OWN_PREDICATE_ITEM），就不是否认列举的延续。
  if (OWN_PREDICATE_ITEM.test(`${equivalent}${tail}`.replace(/(?:等症状|等症|等)$/u, ""))) return false;
  const previous = sentence.slice(0, Math.max(0, clauseStart - 1)).split(/[，,]/u);
  for (let hop = 0; hop < 2 && previous.length > 0; hop += 1) {
    const clause = previous.pop()!.trim();
    if (CLINICAL_NEGATION_CUE.test(clause)) return true;
    if (!/^[\u4e00-\u9fff]{2,4}$/u.test(clause) || OWN_PREDICATE_ITEM.test(clause)) return false;
  }
  return false;
}

/**
 * 病历对一个表现的读法（2026-10-25 第十九轮，A056）。一处判据、三个取值，各消费方按自己的失败方向取保守：
 *  · affirmed：只有肯定记载；
 *  · denied：有否认记载，且没有本小句里就成立的肯定（否认列举后的裸词与另一处明确否认并存时，按逐项否认读：
 *    「无腹痛，发热，呕吐，…」与后文「无呕吐」——两处都读成没有呕吐，病历前后一致）；
 *  · conflicting：本小句成立的肯定与否认都有（「否认胸痛。今日突发胸痛」，或病程里前后变化）；
 *  · ambiguous：只有「否认列举后的裸词」这一种记载，是否在否认范围里读不出；
 *  · absent：都没有。
 * 安全闸门不读它（闸门照旧把 ambiguous 当阳性）；交付文本的否认净化通过 sanitizerReading 读它。
 */
export type RecordedFindingReading = "affirmed" | "denied" | "conflicting" | "ambiguous" | "absent";
export function recordedFindingReading(source: string, term: string): RecordedFindingReading {
  const affirmation = affirmationMentionKind(source, term);
  // 否认记载两种判据都算：sourceDocumentsNegation（否认词作用域）与闸门的 isNegatedAt 里「否认词直达」或「列举延续到逗号后的裸词」
  //（「无呕吐，发热」；negationReachesMentionDirectly）。
  const denied = affirmation.negatedMention || sourceDocumentsNegation(source, term);
  if (affirmation.kind === "clear") return denied ? "conflicting" : "affirmed";
  if (affirmation.kind === "ambiguous") return denied ? "denied" : "ambiguous";
  return denied ? "denied" : "absent";
}

/**
 * 否认之后用逗号接着写的裸词（「无腹痛，发热，呕吐」）是中文病历里最常见的歧义写法：既可读成逐项否认，也可读成「无腹痛；有发热、呕吐」。
 * 2026-10-25 第二十轮 A056（8 月龄腹泻，病历两处「无腹痛，发热，呕吐」「无呕吐，发热」）：规则读法与事实模型（qwen3.8-max）都读成没有发热、
 * 呕吐，西医半也写「无发热、无呕吐」，中医半却 3 次里有 2–3 次写「发热、呕吐为湿浊内扰之象」——生成模型自己读歧了，事后核对器也读歧。
 * 两个读者一致时直接告诉生成模型怎么读（预防，而不是生成后再删）：只取这种位置上的裸词（negationReachesMentionDirectly 的列举延续），
 * 病历读法为「否认」（别处没有本小句成立的肯定），且事实模型没有把它列为阳性。任一读者不同意就不写，交给原有流程。
 * 返回给 M03 两半的一段提示；没有时为空串。
 */
export function commaContinuedDenialReadingNotice(state: CaseState): string {
  const source = clinicalGroundingText(state);
  const normalized = normalizeClinicalText(source);
  const extractorAffirmed = (state.clinicalFacts?.affirmedSymptoms || [])
    .filter((item) => Boolean(item?.term) && Boolean(item?.quote) && source.includes(item.quote))
    .map((item) => item.term);
  const denied: string[] = [];
  const quotes: string[] = [];
  for (const sentence of normalized.split(/[。；;\n]+/u)) {
    const cue = maskNonNegatingWuWords(sentence);
    const clauses: Array<{ text: string; start: number }> = [];
    let offset = 0;
    for (const raw of sentence.split(/[，,]/u)) {
      clauses.push({ text: raw, start: offset });
      offset += raw.length + 1;
    }
    clauses.forEach((clause, position) => {
      const item = clause.text.trim().replace(/(?:等症状|等症|等)$/u, "");
      // 只认名词性的裸词：自带谓语的（「眠差」「入睡困难」「鼻塞声重」「咳嗽有痰」「口干」）是在说有，不是否认列举的延续。
      if (position === 0 || !/^[\u4e00-\u9fff]{2,4}$/u.test(item) || CLINICAL_NEGATION_CUE.test(item) || OWN_PREDICATE_ITEM.test(item)) return;
      const index = clause.start + clause.text.indexOf(item);
      if (!negationReachesMentionDirectly(cue, index, item)) return;
      if (recordedFindingReading(source, item) !== "denied") return;
      if (extractorAffirmed.some((term) => term.length >= 2 && (term === item || term.includes(item) || item.includes(term)))) return;
      if (!denied.includes(item)) denied.push(item);
      // 引文从带否认词的那一小句起，到这一项为止（至多隔两项）。
      let from = position - 1;
      while (from > 0 && from >= position - 2 && !CLINICAL_NEGATION_CUE.test(maskNonNegatingWuWords(clauses[from].text))) from -= 1;
      const quote = clauses.slice(from, position + 1).map((part) => part.text.trim()).join("，");
      if (quotes.some((existing) => existing.includes(quote))) return;
      for (let at = quotes.length - 1; at >= 0; at -= 1) if (quote.includes(quotes[at])) quotes.splice(at, 1);
      quotes.push(quote);
    });
  }
  if (denied.length === 0) return "";
  return `\n\n【病历读法核对】病历${quotes.slice(0, 3).map((quote) => `「${quote}」`).join("")}里，否认词之后用逗号接着写的${denied.join("、")}按逐项否认读（与病历其余记载和事实抽取一致）：本例没有${denied.join("、")}，不得写成本例的表现、辨证依据或鉴别中「同见」的表现。`;
}

/**
 * 病历引文的读法要与它在病历原处一致（2026-10-25 第二十轮 A056）：模型把「蛋花样，无腹痛，发热，呕吐，于乡卫生院输液治疗两天无效」
 * 从「发热」切开，「发热，呕吐，于乡卫生院输液治疗两天无效，并有加重趋势」作为主证依据——逐字是病历原话，切掉「无腹痛，」以后读成了有发热、呕吐。
 * 引文开头若是病历原处落在否认范围里的裸词（negationReachesMentionDirectly，病历读法为否认），去掉这几项，剩下的仍逐字是病历原话；
 * 全部去掉时返回空串。不在病历里逐字出现的引文原样返回（另有接地核对）。
 */
export function quoteWithoutDeniedLeadingItems(quote: string, source: string): string {
  const text = String(quote || "");
  const normalizedSource = normalizeClinicalText(source);
  const at = normalizedSource.indexOf(normalizeClinicalText(text.trim()));
  if (!text.trim() || at < 0) return text;
  const sentenceStart = Math.max(...["。", "；", ";", "\n"].map((mark) => normalizedSource.lastIndexOf(mark, at - 1))) + 1;
  const ends = ["。", "；", ";", "\n"].map((mark) => normalizedSource.indexOf(mark, at)).filter((value) => value >= 0);
  const sentence = normalizedSource.slice(sentenceStart, ends.length > 0 ? Math.min(...ends) : normalizedSource.length);
  const cue = maskNonNegatingWuWords(sentence);
  const leading = text.trim();
  let cut = 0;
  for (const match of leading.matchAll(/[^，,]+[，,]?/gu)) {
    const item = match[0].replace(/[，,]$/u, "").trim();
    const position = at - sentenceStart + (match.index ?? 0);
    if (!/^[\u4e00-\u9fff]{2,4}$/u.test(item) || !negationReachesMentionDirectly(cue, position, item) || recordedFindingReading(source, item) !== "denied") break;
    cut = (match.index ?? 0) + match[0].length;
  }
  return cut === 0 ? text : leading.slice(cut).trim();
}

/** 读法不明确时，交付文本里替代「有X」「无X」的那一句（临床措辞，交付面不再改写）。 */
export function unsettledFindingNotice(terms: readonly string[]): string {
  return `${terms.join("、")}的有无病历记载不明确，需核实`;
}

function sourceHasKnownTongue(source: string): boolean {
  return !isUnknownClinicalFieldText(source, "tongue");
}

function sourceHasKnownPulse(source: string): boolean {
  return !isUnknownClinicalFieldText(source, "pulse");
}

function clauseOnlyAssertsFactWasNotRecorded(clause: string, prefix: string, terms: readonly string[]): boolean {
  let remainder = clause.slice(prefix.length);
  for (const term of [...terms].sort((left, right) => right.length - left.length)) {
    remainder = remainder.split(term).join("");
  }
  remainder = remainder
    .replace(/(?:本次|当前|目前|病历|患者|病人|主诉|自诉|症见|表现|症状|阳性|存在|有|均|以及|及|和|或|到|中|尚)?(?:未记录|未提及|未询问|未采集)/g, "")
    .replace(/[、，,。；;:：\s]/g, "");
  // Attribute-level gaps (for example “便秘相关细节未记录” or “排便费力程度未记录”)
  // intentionally leave meaningful text here. A known symptom's existence must never be used to
  // erase unknown severity, quality, timing, trigger, history or other sub-attributes.
  return remainder.length === 0;
}

function clauseNegationsAreLiterallyDocumented(clause: string, source: string): boolean {
  const match = clause.match(/(?:绝无|全无|尚无|暂无|没有|否认|未见|未出现|不伴|并无|无)(?:任何|相关|上述|该|此类|明显)?([^。；;]+)/);
  if (!match?.[1]) return false;
  const items = match[1]
    .split(/[、，,]|(?:及|和|或)/)
    .map((item) => item.replace(/^(?:本例|患者|病人|当前|目前)\s*/, "").trim())
    .filter((item) => item.length >= 2);
  if (items.length === 0) return false;
  // 同一判据（hasNonNegatedClinicalPattern）：病历里前有否认、逗号后另起「有/偶有」小句的不算否认（「无汗出，偶有胸痛」，MTCMB-14）。
  // 病历里任一处这样否认过都算（2026-10-25 A056：此前只看第一次出现的位置，第一次恰在歧义的「无腹痛，发热，呕吐，…并有加重趋势」里，
  // 病历原文「无呕吐，发热」被改写）；前后记载不一的不算照录，交给下面的读法分支。
  return items.every((item) => {
    // 只在病历读法是「否认」时按任一处照录放行：病历另有本小句成立的肯定（前后不一或其实是肯定）时不算照录（2026-10-25 回放：
    //「发热咳嗽4天…无汗，咳嗽呛感」，闸门的列举延续把「咳嗽呛感」读成否认，此前首次出现判法恰好看的是主诉那一处）。
    const reading = recordedFindingReading(source, item);
    if (reading === "affirmed" || reading === "conflicting") return false;
    let index = source.indexOf(item);
    while (index >= 0) {
      if (!isExcludedClinicalAssertionAt(source, index) && isNegatedAt(source, index) && !hasCommaSeparatedPositiveEvidence(source, index, item) &&
        negationReachesMentionDirectly(source, index, item)) return true;
      index = source.indexOf(item, index + item.length);
    }
    return false;
  });
}

/** 照录核对用的紧凑形：去空白、全半角标点归一。 */
function quoteComparable(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").replace(/[，,]/g, "，").replace(/[；;]/g, "；").replace(/[：:]/g, "：");
}

function qualifiedDocumentedDenial(source: string, term: string): string | undefined {
  for (const raw of source.split(/[。；;\n]+/)) {
    const clause = raw.trim();
    const index = clause.indexOf(term);
    if (index < 0 || !isNegatedAt(clause, index)) continue;
    const beforeTerm = clause
      .slice(0, index)
      .replace(/^.*?(?:绝无|全无|尚无|暂无|没有|否认|未见|未出现|不伴|并无|无)(?:任何|相关|上述|该|此类|明显)?/, "")
      .replace(/[\s，,、及和或]/g, "");
    // Only restore a qualified subtype denial (e.g. 雷击样头痛), never use a generic “否认头痛”
    // to overwrite the same chart's affirmative ordinary headache.
    if (beforeTerm.length > 0) return clause;
  }
  return undefined;
}

function reconcileSyntheticPolarityContradictions(value: string, source: string): string {
  const positiveTerms = CLINICAL_NEGATION_FACT_TERMS.filter((term) =>
    value.includes(`病历已记录${term}阳性`));
  if (positiveTerms.length === 0 || !value.includes("病历已记录否认")) return value;
  const seen = new Set<string>();
  return value
    .split(/([。；;])/)
    .map((part) => {
      if (!part || /^[。；;]$/.test(part)) return part;
      let clause = part;
      if (/病历已记录否认/.test(clause)) {
        for (const term of positiveTerms) {
          if (!clause.includes(term)) continue;
          const qualified = qualifiedDocumentedDenial(source, term);
          if (qualified) {
            clause = `病历已记录${qualified}`;
            break;
          }
        }
      }
      const fingerprint = clause.normalize("NFKC").replace(/[\s，,。；;：:、]/g, "");
      if (fingerprint && seen.has(fingerprint)) return "";
      if (fingerprint) seen.add(fingerprint);
      return clause;
    })
    .join("")
    .replace(/([。；;]){2,}/g, "$1");
}

/**
 * 前瞻/条件/疑问句不是对当前病历的断言（2026-09-28 线上实测）。
 *
 * 接地净化器判断的是「模型有没有断言一件病历里没有的事」。可是随访、注意事项、复诊安排
 * 里的句子按定义指向**将来**：「如症状无改善甚至出现胸痛、气促，应立即急诊就医」
 * 「有无新出现恶寒发热」「服药期间出现发热不退或痰中带血，应立即就医」。净化器把句内的
 * 「无改善」「有无」「出现X」读成对当前病历的否定/阳性断言，整句换成
 * 「病历尚未确认胸痛……是否存在」「病历已记录否认发热」——就医指征被删掉，
 * 写进病历的是一句自相矛盾的话。随访时间轴 sentinel 早已因同一原因整段豁免
 * （见 sanitizeFollowupTimelineSentinel），散文与 M04 注意事项没有跟上。
 *
 * 判据是**有限闭集**的条件/疑问虚词（若、如果、一旦、如出现、有无、服药期间、出现……时），
 * 属构词式守卫，不是开放语言词表。命中句从虚词起到句末原样保留，虚词之前与未命中的句子照旧净化，
 * 所以「患者否认X」这类对当前病历的断言仍受约束。
 * 「是否」不在其中：「X是否存在尚未确认」本身就是净化器要纠正的记录完整性断言。
 */
// 后两支是没有「若/如」的前瞻句（2026-10-13：87 例里 4 例注意事项被改坏）：
//   「服药2周失眠心悸无改善或加重，须复诊调整方案」→ 被改成「病历已记录心悸、失眠阳性，须复诊调整方案」
//   「…出现恶心、腹痛等不适请停药就医」           → 被改成「病历尚未确认恶心是否存在」
// 疗程起头（服药/用药 + N天/剂/周）或「出现/发生X」起头，且**同句后面带处置指令**（复诊/就医/停药…）才算；
// 没有指令的「患者服药3天后否认便血」「患者出现胸痛」仍是对病历的陈述，照旧净化。
const PROSPECTIVE_CARE_DIRECTIVE = "(?:请|须|应|需|要|立即|及时|尽快)[^。；;！!？?\\n|]*(?:复诊|就医|就诊|急诊|停药|告知|评估)";
const PROSPECTIVE_CLINICAL_SENTENCE = new RegExp(
  "(?:若(?!干)|如果|假如|倘若|万一|一旦|要是|如(?:出现|有|发现|伴|仍|再|症状|病情|服药|用药|感到|觉得|遇)|有无|(?:服药|用药|治疗|疗程)期间|(?:出现|发生)[^，,。；;]{1,24}时"
  + `|(?:服药|用药|服用|治疗)\\s*(?:\\d+(?:\\s*[-–~～至]\\s*\\d+)?|[一二两三四五六七八九十半]+)\\s*(?:天|日|剂|周|个?月)(?:后|内|以上)?(?=[^。；;！!？?\\n|]*${PROSPECTIVE_CARE_DIRECTIVE})`
  + `|(?:出现|发生)(?=[^，,。；;！!？?\\n|]{1,24}${PROSPECTIVE_CARE_DIRECTIVE}))`,
);

/** 以「须/请/应…就医、急诊、复诊、停药」收尾的句子（闭集的处置指令）。 */
const PROSPECTIVE_INSTRUCTION_SENTENCE = new RegExp(`${PROSPECTIVE_CARE_DIRECTIVE}[^。；;！!？?\\n|]{0,24}[。；;！!]?\\s*$`);
/** 句中出现这些词，说明它（至少前半）是在陈述当前病历，不能整句当作嘱咐放行。 */
const CHART_ASSERTION_MARKER = /患者|病人|患儿|本例|否认|病历|已记录|既往|查体|检查示/;

/**
 * 一个小句里否认词管得到的那一段（构词式守卫，闭集）。前置否认词（无/否认/未见…）管它后面的部分；
 * 否认词前面紧挨着「均/皆/俱/都/亦/也」，或否认词后面已经没有汉字时，是后置否认，管整句。
 * `probe` 是与 `clause` 等长、已抹掉固定说法的探针。
 */
function clauseNegationScope(clause: string, probe: string): string {
  const cue = new RegExp(CLINICAL_NEGATION_CUE.source, "g");
  const matches = [...probe.matchAll(cue)];
  if (matches.length === 0 || probe.length !== clause.length) return clause;
  const postposed = matches.some((match) => {
    const start = match.index ?? 0;
    return /[均皆俱都亦也]$/u.test(probe.slice(0, start)) || !/[\u4e00-\u9fa5]/u.test(probe.slice(start + match[0].length));
  });
  if (postposed) return clause;
  // 前置否认词管到顿号列举的哪一项为止（2026-10-19）。两种情形到此为止：
  //  · 本项是「无汗」「无痰」这类独立成词的体征——「恶寒重、发热轻、无汗、鼻塞流清涕、稍有咳嗽」里的「无」只否认汗；
  //  · 后面某项自带「有」「伴」「见」一类肯定词（「稍有咳嗽」「伴腹胀」）——它自己说了存在，不在否认之下。
  // 此前整段都算否认范围，病历记录了咳嗽，整句被改成「病历已记录咳嗽阳性」，风寒投影再把主症补在句末
  //（甲方标准病历 1 本地复测三次中两次）。「无恶心、呕吐」这类普通列举照旧一并否认。
  const scope = clause.slice(matches[0].index ?? 0);
  const items = scope.split("、");
  if (/^无[汗痰]$/u.test(items[0].trim())) return items[0];
  const affirmedAt = items.findIndex((item, index) => index > 0 && NEGATION_SCOPE_AFFIRMED_ITEM.test(item.trim()));
  return affirmedAt > 0 ? items.slice(0, affirmedAt).join("、") : scope;
}

/** 鉴别列表（中医病名/证候、西医）的字段名：其中每一项的 distinguishingPoints/reason 里，以该项病证名为主语的否认说的是那个病。 */
const DIFFERENTIAL_LIST_KEYS = new Set(["tcmDiseaseDifferentials", "tcmDifferentials", "differentials"]);

/** 写诊断理由的散文字段：其中以鉴别病证名为主语的否认分句说的是那个病。 */
const DIFFERENTIAL_PROSE_FIELDS = new Set(["tcmDiseaseRationale", "tcmDiagnosticRationale", "primarySyndromeRationale", "clinicalRationale"]);

/** 本结果里列出的鉴别病证名（中医病名、证候、西医鉴别与候选；去括号，至少 2 字）。 */
function collectDifferentialNames(root: unknown): string[] {
  const names = new Set<string>();
  const walk = (value: unknown, key = "") => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (DIFFERENTIAL_LIST_KEYS.has(key) || key === "candidates") {
          const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
          for (const field of ["diseaseName", "name", "syndrome"]) {
            const name = typeof row[field] === "string" ? String(row[field]).replace(/[（(][^（）()]*[）)]/gu, "").trim() : "";
            if (name.length >= 2) names.add(name);
          }
        }
        walk(item, key);
      }
      return;
    }
    if (value && typeof value === "object") for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) walk(child, childKey);
  };
  walk(root);
  return [...names];
}

/** 分句以被鉴别的病证名开头（可隔「则/多/常/一般/通常」），紧接着是否认词：「风瘙痒无原发皮疹」「肋间神经痛多无皮疹」。 */
function differentialSubjectNegation(clause: string, entryName: string): boolean {
  const at = clause.indexOf(entryName);
  if (at < 0 || /本例|患者|该患/u.test(clause.slice(0, at))) return false;
  return /^(?:则|多|常|一般|通常|往往|本身)?(?:无|没有|不伴|未见|并无|多无|常无)/u.test(clause.slice(at + entryName.length));
}

/** 顿号列举里自带肯定说法的一项：「稍有咳嗽」「伴腹胀」「可见黄痰」。前面的否认词管不到它。 */
const NEGATION_SCOPE_AFFIRMED_ITEM = /^(?:(?:稍|略|微|偶|时|常|仍|又|并|另|尚|还|均)?有(?!无)|伴有?|兼(?:有|见)|并见|可见|见|出现)/u;

export function isProspectiveClinicalSentence(value: string): boolean {
  return PROSPECTIVE_CLINICAL_SENTENCE.test(String(value || ""));
}

/** 小句在讲「去核实/本例没有」：建议核实、与否/是否/有无、未诉/未见/缺、诊脉/望舌这类动作。 */
const INSPECTION_CHECK_OR_ABSENCE_CLAUSE = /与否|是否|有无|[诊切察查摸按]脉|[望察查看观]舌|观察|核实|待查|待诊|待辨|待定|尚缺|缺少?|未诉|未见|未记录|未提及|未录|之记载|无此|否[、）)]|否$/u;
/** 下一小句说「本例未诉此/本例无此」：前一小句写的是别的病的表现（鉴别对象），不是对本例的断言。 */
const INSPECTION_OTHER_ENTITY_FOLLOWUP = /^\s*(?:而|但)?本例(?:并)?(?:未诉|无|未见|不见|未出现|未记录)/u;

/**
 * 对照小句的开头：「本例…」，或前面只隔一个连词/比较词——「而本例」「但本例」「与本例持续高热不符」「不同于本例」「较本例」。
 * 鉴别句的对照面写法不止一种（2026-10-19 X-C-0055：同一句鉴别「痫证发作无发热，与本例持续高热不符」，第七轮模型换成「与本例」，
 * 上一轮只认「（而/但）本例」，于是又被改成「有发热，与本例持续高热不符」，句子失去对照对象）。
 * 只列虚词与比较词（构词式闭集，不含症状词）。
 */
const CONTRAST_WITH_THIS_CASE_OPENING = /^\s*(?:而|但|却|然)?(?:(?:与|同|和|跟|较|不同于|有别于|异于|区别于)\s*)?本例/u;

/**
 * 否认净化用的读法：在 recordedFindingReading 之上取保守方向，并用事实抽取模型的阳性表核对读不出的那一种。
 *  · conflicting 按 affirmed 处理：病历在本小句里肯定过的表现，不让模型写成「无X」（回放 20,740 份病历：前后两种记载多是病程变化或
 *    条件句——「最近都有黑便。急性肠胃炎的时候，还没有黑便」「一痒就咳嗽，不痒就不咳嗽」——改写成阳性比「需核实」准）；
 *    同一句里不再另出一句「病历已记录否认X」（此前两句并存，交付成「有X；否认X」）。
 *  · ambiguous（只有否认列举后的裸词一种记载）：事实抽取模型把它列为阳性的按 affirmed；否则写明记载不明确。回放里这一种多半其实是
 *    新起的阳性小句（「无痰，胸闷，喘息严重」「不咳，口苦，晨起明显」），也有真是逐项否认的（A056），确定性规则判不出，交给第二个读者。
 */
type SanitizerReading = "affirmed" | "denied" | "ambiguous" | "absent";
function sanitizerReading(source: string, term: string, extractorAffirmedTerms: readonly string[]): SanitizerReading {
  const reading = recordedFindingReading(source, term);
  if (reading === "conflicting") return "affirmed";
  if (reading === "ambiguous") {
    const affirmedByExtractor = extractorAffirmedTerms.some((item) => item.length >= 2 && (item === term || item.includes(term) || term.includes(item)));
    return affirmedByExtractor ? "affirmed" : "ambiguous";
  }
  return reading;
}

/** 句中这些词里读法不明确的那几个，及替代它们的一句话。 */
function unsettledFindingsIn(
  terms: readonly string[],
  source: string,
  span: string,
  extractorAffirmedTerms: readonly string[],
): { terms: Set<string>; notices: string[] } {
  const unsettled = terms.filter((term) => !termOnlyQualifiedIn(span, term, source) &&
    sanitizerReading(source, term, extractorAffirmedTerms) === "ambiguous");
  // 同一表现的长短两种写法（「头痛」「剧烈头痛」）只留短的那个。
  const shown = unsettled.filter((term) => !unsettled.some((other) => other !== term && term.includes(other)));
  return { terms: new Set(unsettled), notices: shown.length > 0 ? [unsettledFindingNotice(shown)] : [] };
}

/**
 * 被删掉的否认小句的占位（逗号小句级）。行内收尾时连同一个相邻逗号一起去掉（withoutDroppedNegationClauses）；
 * 整段只剩它时成空串，JSON 列表里的空项由 visit 去掉。
 */
const DROPPED_NEGATION_CLAUSE = "\u0000CDSS_DROPPED_NEGATION\u0000";
/** 只是给前一小句下结论的尾句（「与之不符」「与外感不符」「不支持肺痈」「可资鉴别」）：前一小句删掉后它没有前提，一起删。 */
const DEPENDENT_CONCLUSION_CLAUSE = "(?:故|因此|所以|可)?(?:与[^，,。；;]{0,12}(?:不符|不同|有别|相区分|相鉴别|区分|鉴别)|不支持[^，,。；;]{0,12}|可资鉴别|(?:可)?排除[^，,。；;]{0,12}|不考虑[^，,。；;]{0,12}|非[^，,。；;]{1,10})";
function withoutDroppedNegationClauses(text: string): string {
  if (!text.includes(DROPPED_NEGATION_CLAUSE)) return text;
  const drop = DROPPED_NEGATION_CLAUSE;
  return text
    // 删掉的小句后面紧跟的、只回指它的结论尾句一并删（到句末或分号为止）。
    .replace(new RegExp(`${drop}[，,]\\s*${DEPENDENT_CONCLUSION_CLAUSE}(?=[。；;]|$)`, "gu"), drop)
    // 整句只剩它：连句末标点一起去掉。
    .replace(new RegExp(`(^|[。；;\\n])([ \\t]*)${drop}[。；;]`, "gu"), "$1$2")
    // 句中：连同一个相邻逗号去掉。
    .replace(new RegExp(`${drop}[，,]\\s*`, "gu"), "")
    .replace(new RegExp(`[，,]\\s*${drop}`, "gu"), "")
    .replace(new RegExp(drop, "gu"), "")
    .replace(/[；;，,]+([。])/gu, "$1")
    .replace(/([。；;])[；;，,]+/gu, "$1")
    .replace(/([：:])\s*[；;，,]+/gu, "$1")
    .replace(/^([ \t]*(?:[-*+]|\d+[.、])[ \t]*)[；;，,]+/gmu, "$1")
    // 整行只剩标签（「鉴别要点：。」「- **依据**：」）：内容全删了，标签也不留。
    .replace(/^[ \t]*(?:[-*+]|\d+[.、])?[ \t]*(?:\*\*)?[^\n：:*]{1,24}(?:\*\*)?[：:][ \t]*[。；;]?[ \t]*$/gmu, "");
}

function sanitizeUngroundedNegationText(
  value: string,
  source: string,
  /** 抽取模型给出的、已在病历原文中接地的阳性症状名。规则未覆盖时用它核对否认。 */
  extractorAffirmedTerms: readonly string[] = [],
  /**
   * 病历**字段槽**里是否已记录舌/脉（2026-08-26）。识别面与门禁面必须给同一个答案：
   * 医生把脉象写成转述式（「脉跳得又快又硬」）时门禁已判已记录，若净化面仍按自由文本
   * 严格口径判「无据」，就会把模型据此写出的脉象改写成「脉象待核实」——正是本文件
   * 头号缺陷形状（同一判据两处各写各的）的第 N 次复发。
   */
  recordedInspection: { tongue: boolean; pulse: boolean } = { tongue: false, pulse: false },
  /**
   * 病历肯定、模型否认时怎么改：drop 删掉这条否认（缺省）；affirm 是改动前的写法「病历已记录X阳性」，只给 JSON 里的单值字段兜底——
   * 删完整个字段就空了时（「鉴别要点：无腹痛」），空字段过不了下游合同，宁可退回旧写法。
   */
  contradictionMode: "drop" | "affirm" = "drop",
): string {
  const sanitizeClause = (clause: string): string => {
    // 抹掉的部分用等长占位，探针里的位置与原句一一对应（下面按否认线索的位置定否认作用域）。
    const negationProbe = clause
      .replace(/无明显(?:诱因|原因|缓解|好转|改善)/g, (masked) => "＿".repeat(masked.length))
      // “肢体无力” is a positive neurologic symptom. The lexical “无” is part of the symptom name,
      // not a negation cue; masking it here prevents the output scrubber from rewriting a grounded
      // post-stroke fact into the synthetic sentence “病历已记录肢体无力阳性”.
      .replace(/肢体无力/g, "肢体乏力")
      // 「发无定处、痛无定处、行无定时、无常、无度、无端、无故」是固定说法，不是对某个症状的否认（2026-10-17：
      //「以皮肤瘙痒、风团时消时现、发无定处为主症」被当成否认句，整句改成「病历已记录瘙痒阳性」，甲方标准病历 9 三次生成都是这样）。
      // 与 unrecordedNegativesAsNotReported 排除的固定搭配同一组。
      .replace(/无(?=定处|定时|定所|常|度|端|故)/g, "＿");
    // 面色无华、口淡无味、脉沉细无力这类固定说法同样不是否认（maskNonNegatingWuWords）。
    const negationProbeMasked = maskNonNegatingWuWords(negationProbe);
    const prefix = clause.match(/^(\s*(?:[-*]>?\s*|>\s*|#{1,6}\s*)?(?:[^：:|]{1,24}[：:]\s*)?)/)?.[1] || "";
    // 正文里鉴别一行的「常见：」是 differentialLine（diagnosis-visible-summary）给 typicalManifestation 加的标签：
    // 写的是鉴别对象那个病的表现，不是对本例的断言，与 JSON 里同一字段一样不净化（见下方 typicalManifestation 豁免）。
    if (/^常见[：:]/.test(clause.slice(prefix.length))) return clause;
    // Preserve a qualified denial only when every denied phrase is literally present under a
    // negation cue in the chart. This keeps “否认突发雷击样头痛” distinct from “否认头痛” when the
    // same record also affirms ordinary headache; collapsing the qualifier creates an impossible
    // same-screen “头痛阳性 + 否认头痛” contradiction.
    if (clauseNegationsAreLiterallyDocumented(clause, source)) return clause;

    // 语义层:规则词表未覆盖的症状,用抽取模型给出的阳性症状表核对(2026-08-05)。
    //
    // 规则引导式的分工——规则管确定的,语义管开放的,兜底管失败的:
    //  · 上面的规则判定照旧优先,词表命中的症状行为完全不变;
    //  · 走到这里说明规则没能确认这条否认,此时若抽取模型明确记录了该症状为阳性,
    //    就说明模型写的「否认X」与病历矛盾,降级为「尚未确认」;
    //  · 抽取不可用 / 未记录该症状 ⇒ 落到下面既有分支,行为与改动前一致(保留模型原文)。
    //
    // 为什么必须补这一层:症状是开放集合。此前核对只查一张策展词表(红旗词+阳性事实词),
    // 瘀斑、肿胀、乏力、纳差这些常见症状根本不在表内,模型的错误否认直接放行——
    // 线上 60 例语料实测 4 例误判全部出于此。靠继续补词表穷举不完,
    // 而「这句话是不是在陈述该症状存在」本就是语义判断。
    //
    // 方向单调:只能把「否认X」降级为「尚未确认X」,不能反向把「尚未确认」升成「否认」。
    // 模型判错的最坏后果是多一条待核实项,而不是把存在的症状说成不存在。
    if (extractorAffirmedTerms.length > 0) {
      const contradicted = extractorAffirmedTerms.filter((term: string) =>
        new RegExp(`否认[^。；;]{0,12}${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(clause));
      // 与下面规则判定的矛盾同一处理：删掉这条否认，不另写一句肯定（见 DROPPED_NEGATION_CLAUSE）。
      if (contradicted.length > 0) {
        return contradictionMode === "drop"
          ? `${prefix}${DROPPED_NEGATION_CLAUSE}`
          : `${prefix}病历尚未确认${contradicted.join("、")}是否已排除；病历已记录该表现存在，请医生核对后再采纳`;
      }
    }
    const documentedPendingTests = CLINICAL_NORMALITY_TERMS.filter(
      (term) => clause.includes(term) &&
        /(?:待核实|待确认|待查|未提供|未记录|未完成|不详|未知)/.test(clause) &&
        sourceDocumentsCurrentNormality(source, term),
    );
    if (documentedPendingTests.length > 0) {
      return `${prefix}病历已记录本次${documentedPendingTests.join("、")}未见明显异常；是否复查由医生结合病情判断`;
    }
    const unrecordedButDocumentedPositive = CLINICAL_NEGATION_FACT_TERMS.filter(
      (term) => clause.includes(term) &&
        /(?:未记录|未提及|未询问|未采集)/.test(clause) &&
        sanitizerReading(source, term, extractorAffirmedTerms) === "affirmed" &&
        !termOnlyQualifiedIn(clause, term, source),
    );
    if (
      unrecordedButDocumentedPositive.length > 0 &&
      clauseOnlyAssertsFactWasNotRecorded(clause, prefix, unrecordedButDocumentedPositive)
    ) {
      return `${prefix}病历已记录${unrecordedButDocumentedPositive.join("、")}阳性`;
    }
    // 两种语序都要认（2026-08-12）。原判据要求「尚未确认」出现在「是否存在」**之前**，
    // 于是本层只能纠正系统自己生成的那一种写法（「病历尚未确认意识改变是否存在」），
    // 模型写成主语在前的「意识改变是否存在尚未确认」时整条净化不触发——甲方引的正是后者。
    // clause 本来就是按句末标点切出来的一句，同句内两个记号都在即可，不必再约束先后。
    if (/(?:尚未|未)(?:确认|核实)/.test(clause) && /是否存在/.test(clause)) {
      const mentioned = CLINICAL_NEGATION_FACT_TERMS.filter((term) => clause.includes(term));
      // 「病历尚未确认剧烈头痛是否存在」里的「头痛」只是「剧烈头痛」的一部分：不得据病历里的普通头痛再补一句「头痛阳性」
      //（同一句过两遍净化时「有头痛；有头痛」就是这样叠出来的）。
      const documentedPositive = mentioned.filter((term) => sanitizerReading(source, term, extractorAffirmedTerms) === "affirmed" &&
        !termOnlyQualifiedIn(clause, term, source));
      const unsettled = unsettledFindingsIn(mentioned, source, clause, extractorAffirmedTerms);
      // 每个词只出一句。documentedDenialNotice 已经把「只否认了下位词」这种情形
      // 说成「病历已记录否认<变体>，<term>的一般情况需医生核实」，
      // 若再让它落进 stillUnknown 走一遍 unknownTermNotice，同一句会印两遍。
      const denial = documentedDenialNotices(source, mentioned.filter((term) => !documentedPositive.includes(term) && !unsettled.terms.has(term)));
      const documentedNegativeNotices = denial.notices;
      const stillUnknown = mentioned.filter((term) => !documentedPositive.includes(term) && !denial.covered.has(term) && !unsettled.terms.has(term));
      if (documentedPositive.length > 0 || documentedNegativeNotices.length > 0 || unsettled.notices.length > 0) {
        return `${prefix}${[
          documentedPositive.length > 0 ? `病历已记录${documentedPositive.join("、")}阳性` : "",
          ...unsettled.notices,
          documentedNegativeNotices.join("；"),
          stillUnknown.length > 0 ? unknownTermNotice(source, stillUnknown) : "",
        ].filter(Boolean).join("；")}`;
      }
    }
    if (CLINICAL_NEGATION_CUE.test(negationProbeMasked)) {
      // 前置的否认词只否认它后面的词（2026-10-17）：「恶寒重、发热轻、无汗」里的「无」否认的是汗，不是前面的发热；
      // 此前整句都算否认范围，病历记录了发热，整句被改成「病历已记录发热阳性」，再被风寒鉴别投影补回一遍
      //（甲方标准病历 1 两次生成的辨证依据都是「发热，为寒邪束表…之征；恶寒重、发热轻、无汗，为…之征」）。
      // 后置的「均无」「均否认」、以及句末才出现的否认词（「发热、头痛均否认」）否认的是前面列举的词，照旧整句算。
      const negatedSpan = clauseNegationScope(clause, negationProbeMasked);
      // 病历读法见 sanitizerReading：病历肯定过的改成阳性（不再同时另出一句否认）；病历按逐项否认读的照留模型的否认；
      // 读不出的写明需核实（2026-10-25 A056：病历先「无腹痛，发热，呕吐，…并有加重趋势」、后「无呕吐，发热」，此前同一句交付成「有呕吐；否认呕吐」）。
      const contradictedPositive = CLINICAL_NEGATION_FACT_TERMS.filter(
        (term) => negatedSpan.includes(term) &&
          (sanitizerReading(source, term, extractorAffirmedTerms) === "affirmed" || qualifiedCompoundDocumented(source, term)) &&
          !termOnlyQualifiedIn(negatedSpan, term, source),
      );
      const unsettled = unsettledFindingsIn(CLINICAL_NEGATION_FACT_TERMS.filter((term) => negatedSpan.includes(term)), source, negatedSpan, extractorAffirmedTerms);
      const unknown = CLINICAL_NEGATION_FACT_TERMS.filter(
        (term) => negatedSpan.includes(term) &&
          !sourceDocumentsNegation(source, term) &&
          !sourceDocumentsAffirmation(source, term) &&
          !qualifiedCompoundDocumented(source, term) &&
          // 「无剧烈头痛」否认的是剧烈头痛，不另出一句「头痛是否存在」（qualified-negation-not-bare-symptom）。
          !termOnlyQualifiedIn(negatedSpan, term, source),
      );
      if (contradictedPositive.length > 0 || unknown.length > 0 || unsettled.notices.length > 0) {
        // 病历肯定了的那几项：删掉模型的这条否认，不改写成「病历已记录X阳性」（2026-10-25 第二十轮）。改写是凭空写出一句肯定断言，
        // 读法一错就是一句错话，而且落在「不支持」「鉴别要点」这类槽里意思正好反过来——甲方 100 例 C093「不支持：有腹痛」「无呕血，有黑便」
        //（病历只写了「是否黑便尚未询问」）、C038「有发热，体温36.8℃」（病历「未明显发热」）、C065「有腹痛，乳痈发热无乳房局部症状」
        //（模型在写鉴别对象的表现）。删除是最小改动：错读的代价是少一句，不是多一句反话；与交付面 withoutDenialsOfRecordedFindings
        //（病历肯定、模型写「未诉/否认X」时删去该项）同一处理，此前两处一删一改。同一小句里别的项照旧：病历否认的照录，没写的写「尚未确认」。
        const supportedNotices = documentedDenialNotices(
          source,
          // 已改成阳性的词不再另出一句否认（「有X；否认X」）；病历否认的是它带限定的那一种（「否认突发雷击样头痛」）时保留，
          // 交给下面的 reconcileSyntheticPolarityContradictions 换成病历原句——那是两件不同的事实，不矛盾。
          CLINICAL_NEGATION_FACT_TERMS.filter((term) => clause.includes(term) && !unknown.includes(term) &&
            (!contradictedPositive.includes(term) || Boolean(qualifiedDocumentedDenial(source, term))) && !unsettled.terms.has(term)),
        ).notices;
        const remaining = [
          contradictionMode === "affirm" && contradictedPositive.length > 0 ? `病历已记录${contradictedPositive.join("、")}阳性` : "",
          ...unsettled.notices,
          supportedNotices.join("；"),
          unknown.length > 0 ? unknownTermNotice(source, unknown) : "",
        ].filter(Boolean);
        return `${prefix}${remaining.length > 0 ? remaining.join("；") : DROPPED_NEGATION_CLAUSE}`;
      }
    }
    const unsupportedNormality = CLINICAL_NORMALITY_TERMS.filter(
      (term) => clause.includes(term) &&
        /(正常|未见(?:明显)?异常|无(?:明显)?异常|阴性|未升高|参考范围内|功能良好)/.test(clause) &&
        !sourceDocumentsCurrentNormality(source, term),
    );
    if (unsupportedNormality.length > 0) {
      // 说清是哪项检查、病历里写的是什么（2026-10-19 留出例 S074：病历「肝功能、甲状腺功能正常（1周前本院）」，鉴别要点被改成
      //「相关检查结果以本次病历记录为准」，医生读不出是哪项、结果是什么）。病历写了这项检查的结果就照录那一句（连同时间），没写就说未记录。
      const notices = [...new Set(unsupportedNormality.map((term) => recordedExamResultNotice(source, term)))];
      return `${prefix}${notices.join("；")}`;
    }
    if (/(?:患者|病人|主诉|自诉|症见|表现为|伴有|出现|可见|现有)/.test(clause)) {
      const unsupportedPositive = CLINICAL_POSITIVE_FACT_TERMS.filter(
        (term) => hasPatientScopedSpanOccurrence(clause, term) &&
          !sourceDocumentsNegation(clause, term) &&
          !sourceDocumentsAffirmation(source, term),
      );
      if (unsupportedPositive.length > 0) {
        return `${prefix}病历尚未确认${unsupportedPositive.join("、")}是否存在`;
      }
    }
    return clause;
  };
  // 前瞻句整句屏蔽，放在逗号→分号改写之前：那一步会把「如症状无改善，出现胸痛」
  // 拆成两句，后半句失去条件词后又会被当成断言改写。
  // 只屏蔽从条件/疑问虚词起到句末的部分：虚词之前的分句仍是对当前病历的陈述，照常净化——
  // 「患者否认胸痛、呼吸困难，如出现上述症状应立即就医」里前半句的否认若病历里没有，仍要纠正，
  // 不能因为同句后半有「如出现」就整句放行（本函数也作用于 M03/M04 可见正文）。
  // 紧接着下一小句以「本例」起头、对照的是本例自己的表现时，不以「本例/患者」起头、带「无/没有/未见/不伴」的这一小句说的是鉴别对象那个病
  //（「痫证发作无热，本例持续高热不符」）：不按本例的否认改写——改了就成「有发热，本例持续高热不符」（2026-10-19 Claude 评审 D/H 集多例）。
  // 逐字照录病历原文的一段不改写：病历自己的话不会与病历矛盾（2026-10-25 A056：模型照录「…神疲，精神萎靡，无呕吐，发热」，
  // 交付成「…精神萎靡，有呕吐；有呕吐；否认呕吐，发热」）。净化按逗号小句做，所以看的是这一小句连同前后小句拼成的、
  // 在病历里逐字出现的最长一段（至少 8 字）；病程里先有后无（「伴呕吐2次。今日无呕吐」）照录后一句也不改。
  const recordComparable = quoteComparable(source);
  const clauseInVerbatimRecordSpan = (clause: string, offset: number, whole: string): boolean => {
    const sentenceStart = Math.max(...["。", "；", ";", "\n"].map((mark) => whole.lastIndexOf(mark, offset - 1))) + 1;
    const restEnd = whole.slice(offset).search(/[。；;\n]/u);
    const sentence = whole.slice(sentenceStart, restEnd >= 0 ? offset + restEnd : whole.length);
    const parts = sentence.split(/([，,])/u);
    const at = sentence.indexOf(clause, offset - sentenceStart > 0 ? offset - sentenceStart - 1 : 0);
    if (at < 0) return false;
    let position = 0;
    const units = parts.filter((_, index) => index % 2 === 0).map((text) => { const unit = { text, start: position }; position += text.length + 1; return unit; });
    const self = units.findIndex((unit) => unit.start <= at && at < unit.start + unit.text.length + 1);
    if (self < 0) return false;
    for (let from = self; from >= 0; from -= 1) {
      for (let to = self; to < units.length; to += 1) {
        const span = units.slice(from, to + 1).map((unit) => unit.text).join("，").replace(/^\s*(?:[-*]>?\s*|>\s*|#{1,6}\s*)?(?:[^：:|]{1,24}[：:]\s*)?/u, "");
        const comparable = quoteComparable(span);
        if (comparable.length >= 8 && recordComparable.includes(comparable)) return true;
      }
    }
    return false;
  };
  const sanitizeOwnClause = (clause: string, offset: number, whole: string): string => {
    if (CLINICAL_NEGATION_CUE.test(clause) && clauseInVerbatimRecordSpan(clause, offset, whole)) return clause;
    const next = whole.slice(offset + clause.length + 1).match(/^[^。；;，,]*/u)?.[0] || "";
    if (/无|没有|未见|不伴/u.test(clause) && !/^\s*(?:本例|患者|病人|该患)/u.test(clause) && CONTRAST_WITH_THIS_CASE_OPENING.test(next)) return clause;
    return sanitizeClause(clause);
  };
  const prospectiveSentences: string[] = [];
  const shielded = value.replace(/[^。；;！!？?\n|]+[。；;！!？?]?/g, (sentence) => {
    // 以处置指令收尾、且句中没有对病历的陈述标记的句子，整句都是给患者的前瞻嘱咐：
    // 「胃痛持续不缓解或加重，或出现板状腹、黑便、呕吐，须立即急诊就诊」里既没有「若/如」，
    // 「出现…」与指令之间还隔着逗号，按虚词起点屏蔽会漏掉中间一段（实测被改成「病历尚未确认呕吐是否存在」）。
    // 有陈述标记（患者/否认/病历…）的句子不走这一支，仍按虚词起点屏蔽，标记之前的断言照旧净化。
    const wholeSentenceInstruction = PROSPECTIVE_INSTRUCTION_SENTENCE.test(sentence) && !CHART_ASSERTION_MARKER.test(sentence);
    const marker = wholeSentenceInstruction ? sentence.search(/\S/) : sentence.search(PROSPECTIVE_CLINICAL_SENTENCE);
    if (marker < 0) return sentence;
    return `${sentence.slice(0, marker)}__TCM_CDSS_PROSPECTIVE_${prospectiveSentences.push(sentence.slice(marker)) - 1}__`;
  });
  const scoped = shielded.replace(/[，,](?=(?:但|而|仍|却|同时|另有|随后|继而|突发|新发|出现|伴有))/g, "；");
  let sanitized = scoped.split("\n").map((line) => {
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      return line.split("|").map((cell) => cell.replace(/[^。；;，]+/g, sanitizeOwnClause)).join("|");
    }
    // 子句边界必须含逗号。只按句号/分号切时，「热邪炽盛，未见黑便，未见呕血，热盛迫津」
    // 是**一个**子句，否定分支命中后整句被术语列表替换，「热邪炽盛」「热盛迫津」一并丢失——
    // 净化器越权删掉了它本不该动的、已接地的临床结论。
    // 含逗号后同一输入变为：「热邪炽盛，病历尚未确认黑便是否存在，病历尚未确认呕血是否存在，热盛迫津」
    // 未接地否定照样被净化（安全要求不变），真实病机保住。
    return line.replace(/[^。；;，]+/g, sanitizeOwnClause);
  }).join("\n");
  sanitized = reconcileSyntheticPolarityContradictions(withoutDroppedNegationClauses(sanitized), source);
  // 只改对本例的断言：小句里是「待查/与否/未诉…」时，舌脉词是要去核实或本例没有的东西，不是编出来的所见
  //（2026-10-19 Claude 评审 M 集：建议核实「诊脉弦数与否」改成「诊脉象待核实或弦数」，鉴别里「未诉肢冷、脉微欲绝之危象」
  // 改成「未诉肢冷脉象待核实之危象」，「汗出如珠伴肢冷脉微欲绝，本例未诉此」描述的是脱汗本身）。
  const unlessCheckOrAbsenceClause = (replacement: string) => (match: string, ...rest: unknown[]): string => {
    // 回调参数尾部是 (offset, 整串[, 具名组])：从后往前取，前面的捕获组也可能是字符串。
    const tail = [...rest].reverse();
    const whole = String(tail.find((value) => typeof value === "string") ?? "");
    const offset = Number(tail.find((value) => typeof value === "number") ?? 0);
    let start = offset;
    while (start > 0 && !/[，,。；;\n|]/u.test(whole[start - 1])) start -= 1;
    let end = offset + match.length;
    while (end < whole.length && !/[，,。；;\n|]/u.test(whole[end])) end += 1;
    // 前一步刚换进来的「舌象待核实」「脉象待核实」不算核实类小句（否则「舌红苔黄脉滑数」换掉舌象后，脉象就因「核实」二字被放过）。
    const clause = whole.slice(start, end).replace(/[舌脉]象待核实/gu, "");
    const nextClause = whole.slice(end + 1).match(/^[^，,。；;\n|]*/u)?.[0] || "";
    return INSPECTION_CHECK_OR_ABSENCE_CLAUSE.test(clause) || INSPECTION_OTHER_ENTITY_FOLLOWUP.test(nextClause) ? match : replacement;
  };
  if (!recordedInspection.tongue && !sourceHasKnownTongue(source)) {
    // 识别面与改写面必须认同一批词。少了受控词表这一半，病历里没有舌象、模型却编出
    // 「舌体颤动」「络脉青紫」时，净化器认不出来、原样放行——一条无据的舌象就这么进了结论。
    sanitized = sanitized
      // 舌苔整段一起换：只换「苔厚」两个字时「舌苔厚腻」成了「舌舌象待核实腻」（2026-10-19 Claude 评审 M 集 BEST4SDT-270）。
      .replace(/舌(?:质)?(?:淡|红|绛|紫|暗|胖|瘦|嫩|老|裂|齿痕|边红|尖红)[^，。；;\n|]{0,24}|舌?苔(?:薄|厚|白|黄|腻|燥|润|剥|少|无)(?:[薄厚白黄腻燥润剥少滑干灰黑微略稍]|而)*/g, unlessCheckOrAbsenceClause("舌象待核实"))
      .replace(new RegExp(inspectionLexiconPattern("tongue").source, "g"), unlessCheckOrAbsenceClause("舌象待核实"));
  }
  if (!recordedInspection.pulse && !sourceHasKnownPulse(source)) {
    sanitized = sanitized
      // 「生脉散」的「脉散」不是脉象（散脉）：方名前缀「生」作词形守卫（2026-10-13 第二轮独立评审：未录脉象的病例里
      // 方名被改成「生脉象待核实合参附龙牡救逆汤」，辨证结果、处方页、方义里共 12 处）。
      // 「脉微欲绝」「脉细如丝」：后面的「欲绝/欲脱/如丝」属于同一个脉象，一并换掉，不留「脉象待核实欲绝」（2026-10-17 留出例 S074）。
      // 「主动脉结」「静脉曲张」的「脉结」「脉…」是血管名（2026-10-19 D 集 X-D-4949：「主动脉结增宽」成了「主动脉象待核实增宽」）。
      // 「温通经脉散寒」「血脉实」「筋脉紧」的「脉散」「脉实」「脉紧」是脉管构词后碰巧跟着脉名字，不是脉象（2026-10-19 留出例 S079：
      // 方义「肉桂温通经脉散寒」被改成「肉桂温通经脉象待核实寒」）。守卫字集只此一处（clinical-state 的 PULSE_VESSEL_NOUN_LOOKBEHIND_SOURCE，含上面的生/动/静），
      // 受控词表那一支同样适用（词表里有「脉虚」「脉弱」「脉紧」…，「经脉虚弱」不是脉象）。
      .replace(new RegExp(`${PULSE_VESSEL_NOUN_LOOKBEHIND_SOURCE}脉(?:${PULSE_QUALITY_PATTERN_SOURCE}){1,4}(?:${PULSE_FORCE_PATTERN_SOURCE})?(?:欲绝|欲脱|如丝)?`, "g"), unlessCheckOrAbsenceClause("脉象待核实"))
      .replace(new RegExp(`${PULSE_VESSEL_NOUN_LOOKBEHIND_SOURCE}(?:${inspectionLexiconPattern("pulse").source})`, "g"), unlessCheckOrAbsenceClause("脉象待核实"));
  }
  return sanitized.replace(/__TCM_CDSS_PROSPECTIVE_(\d+)__/g, (_, index: string) => prospectiveSentences[Number(index)] ?? "");
}

function normalizedAgeLiteral(value: unknown): string {
  return String(value ?? "").trim().replace(/\s*岁$/, "");
}

/** 两处年龄相差不到约 18 天（0.05 岁）算同一个年龄：「8个月」与 0.6667 岁、「12天」与 0.033 岁都是一致的记录。 */
const AGE_AGREEMENT_TOLERANCE_YEARS = 0.05;

/**
 * 顶层 patient.age 与 HIS 年龄栏是否冲突。以前逐字比较字面量：调用方给数值年龄 0.6667、HIS 栏写「8个月」
 * （儿童剂量放开后婴儿是常态）就报「年龄记录冲突需复核」，剂量被降为有限信息。两边都能解析成年龄时比数值，
 * 解析不了的才回落到字面量比较。
 */
function agesConflict(left: unknown, right: unknown): boolean {
  const first = normalizedAgeLiteral(left);
  const second = normalizedAgeLiteral(right);
  if (!first || !second || first === second) return false;
  const firstYears = numberFromClinicalText(first);
  const secondYears = numberFromClinicalText(second);
  if (firstYears != null && secondYears != null) return Math.abs(firstYears - secondYears) > AGE_AGREEMENT_TOLERANCE_YEARS;
  return true;
}

function sanitizeAgeClaimText(value: string, state: CaseState): string {
  const patientAge = normalizedAgeLiteral(state.patient.age);
  const hisAge = normalizedAgeLiteral(state.hisRecord?.fields?.age);
  const conflict = agesConflict(state.patient.age, state.hisRecord?.fields?.age);
  const authoritativeAge = hisAge || patientAge;
  if (!authoritativeAge && !conflict) return value;
  return value.replace(
    /(?:具体)?年龄(?:信息)?(?:未提供|未记录|未录入|不详|未知|待核实|待确认|需补录)/g,
    conflict ? "年龄记录存在冲突，需医生核实" : `年龄已记录为${authoritativeAge}岁`,
  );
}

const FEMALE_ONLY_CLINICAL_CONTEXT = /(月经|经期|妊娠|孕产|孕妇|孕期|哺乳|备孕女性|女性[^。；，,]{0,8}备孕)/;
const DEDUPLICATED_CLINICAL_LIST_FIELDS = new Set(["limitations", "suggestedChecks", "mustCollect"]);

type PhysicalExamClaimGroup = { id: string; label: string; terms: string[]; documentedBy?: string[] };
const PHYSICAL_EXAM_CLAIM_GROUPS = physicalExamClaimLexicon.groups as PhysicalExamClaimGroup[];
const PHYSICAL_EXAM_CLAIM_CUES = (physicalExamClaimLexicon.claimCues as string[])
  .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const PHYSICAL_EXAM_CLAIM_CUE = new RegExp(`(?:${PHYSICAL_EXAM_CLAIM_CUES})`);
export const PHYSICAL_EXAM_ASSERTION_FIELDS = new Set([
  "supportingFacts", "primarySyndromeBasis", "patientFact", "syndromeEvidence",
  "clinicalRationale", "tcmDiagnosticRationale", "limitations", "suggestedChecks",
  "reason", "distinguishingPoints", "nextCheck", "overallPathogenesis", "summary",
  "mechanism", "basis", "affects", "followupSafetyNet",
  // 运动保健（2026-09-28 新增的模型叙述字段）：新字段不得进入已知裸奔清单，直接接受查体断言净化。
  "exercise",
]);

function physicalExamGroupPattern(group: PhysicalExamClaimGroup): RegExp {
  return new RegExp(group.terms.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
}

const PHYSICAL_EXAM_DOCUMENTED_CUES = ((physicalExamClaimLexicon as { documentedCues?: string[] }).documentedCues || [])
  .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const PHYSICAL_EXAM_DOCUMENTED_CUE = new RegExp(`(?:${[PHYSICAL_EXAM_CLAIM_CUES, ...PHYSICAL_EXAM_DOCUMENTED_CUES].filter(Boolean).join("|")})`);

/** 病历里是否已经记过这一类查体：输出断言用的词之外，再认「神经系统未见明显阳性体征」「两肺未闻干、湿啰音」这类记法（documentedBy）。 */
function sourceDocumentsPhysicalExam(source: string, group: PhysicalExamClaimGroup): boolean {
  const terms = [...group.terms, ...(group.documentedBy || [])].map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const groupPattern = new RegExp(terms.join("|"));
  return source.split(/[。；;\n]+/).some((clause) => groupPattern.test(clause) && PHYSICAL_EXAM_DOCUMENTED_CUE.test(clause));
}

/**
 * 腹部查体组里「压痛、反跳痛、肌紧张」本身不带部位。前面写了别的部位（「颞动脉无压痛」「局部压痛」「鼻窦区压痛」）时
 * 说的不是腹部查体（2026-10-17：巨细胞动脉炎的鉴别要点被改成「本次病历未记录腹部查体结果」，甲方标准病历 3）。
 * 构词式守卫：去掉否认/语气词后，这几个词前面若还有字、且不含腹/脐/剑突/麦氏，就不算这一组。
 */
const SITE_FREE_ABDOMINAL_EXAM_TERM = /压痛|反跳痛|肌紧张/;
function siteQualifiedOutsideGroup(group: PhysicalExamClaimGroup, part: string): boolean {
  if (group.label !== "腹部查体") return false;
  if (group.terms.some((term) => !SITE_FREE_ABDOMINAL_EXAM_TERM.test(term) && part.includes(term))) return false;
  const match = part.match(SITE_FREE_ABDOMINAL_EXAM_TERM);
  if (!match || match.index == null) return false;
  const before = part.slice(0, match.index).replace(new RegExp(PHYSICAL_EXAM_CLAIM_CUE.source, "g"), "").replace(/[\s、及和伴且并]/g, "");
  return /[\u4e00-\u9fa5]/.test(before) && !/腹|脐|剑突|麦氏/.test(before);
}

function sanitizeUngroundedPhysicalExamClaims(
  value: string,
  source: string,
): { text: string; missingLabels: string[] } {
  const missingLabels = new Set<string>();
  const parts = value.split(/([。；;，,])/);
  const sanitized = parts.map((part) => {
    if (!part || /^[。；;，,]$/.test(part)) return part;
    // 「有无压痛」「是否…」是在问要查什么，不是在说查到了什么（2026-10-17：鼻渊鉴别的核实项「查鼻窦区有无压痛」被当成
    // 腹部查体断言，改成「本次病历未记录腹部查体结果，需现场补充」，甲方标准病历 1）。构词式守卫：只去掉这两个疑问词再判断语气线索。
    const claimText = part.replace(/有无|是否/g, "");
    const unsupported = PHYSICAL_EXAM_CLAIM_GROUPS.filter((group) =>
      physicalExamGroupPattern(group).test(part)
      && !siteQualifiedOutsideGroup(group, claimText)
      && PHYSICAL_EXAM_CLAIM_CUE.test(claimText)
      && !sourceDocumentsPhysicalExam(source, group));
    if (unsupported.length === 0) return part;
    for (const group of unsupported) missingLabels.add(group.label);
    const prefix = part.match(/^(\s*(?:[-*]>?\s*|>\s*|#{1,6}\s*)?(?:[^：:|]{1,24}[：:]\s*)?)/)?.[1] || "";
    return `${prefix}本次病历未记录${unsupported.map((group) => group.label).join("、")}结果，需现场补充`;
  }).join("").replace(/([。；;，,]){2,}/g, "$1");
  return { text: sanitized, missingLabels: [...missingLabels] };
}

const PHYSICAL_EXAM_REFERENCE_LINE = /^\s*(?:(?:[-*>]|\d+[.)])\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?(?:参考文献|文献依据|文献来源|指南(?:原文|条文|依据|来源|标准)?|证据(?:引用|来源|依据)?|引用|出处|诊断标准|鉴别标准)(?:\*\*|__)?\s*[：:]/;

/**
 * 只在患者叙述上做查体接地。可见 Markdown 中的指南/文献行是通用
 * 鉴别标准，不是对当前患者的查体断言，不得改写成“本次病历未记录”。
 * 结构化 JSON 依旧只处理明确的患者断言字段，引用元数据不在白名单内。
 */
function sanitizeUngroundedPhysicalExamClaimsInNarrative(value: string, source: string): string {
  return value.split("\n").map((line) => {
    if (PHYSICAL_EXAM_REFERENCE_LINE.test(line) || /https?:\/\/|\[[^\]]+\]\([^\s)]+\)/.test(line)) return line;
    return sanitizeUngroundedPhysicalExamClaims(line, source).text;
  }).join("\n");
}

function deduplicateClinicalListItems(items: unknown[]): unknown[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (typeof item !== "string") return true;
    const identity = item
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, "")
      .replace(/[。；;]+$/g, "");
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function isAuthoritativeMale(state: CaseState): boolean {
  const value = String(state.hisRecord?.fields?.sex || state.patient.sex || "").trim();
  return /^(?:男|男性|男童|m|male|man)$/i.test(value);
}

function sanitizePatientApplicableText(value: string, state: CaseState): string {
  if (!isAuthoritativeMale(state) || !FEMALE_ONLY_CLINICAL_CONTEXT.test(value)) return value;
  return value.split("\n").map((line) => {
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      return line.split("|").map((cell) => FEMALE_ONLY_CLINICAL_CONTEXT.test(cell) ? " 本例男性不适用 " : cell).join("|");
    }
    const headingPrefix = line.match(/^(#{1,6}\s*)/)?.[1] || "";
    const body = headingPrefix ? line.slice(headingPrefix.length) : line;
    const clauses = body.split(/([。；;])/);
    const filtered = clauses.map((clause) => FEMALE_ONLY_CLINICAL_CONTEXT.test(clause) ? "" : clause).join("").trim();
    return filtered ? `${headingPrefix}${filtered}` : "";
  }).filter((line) => line.trim()).join("\n");
}

/**
 * M03 can assess that an unreported symptom is “information不足”, but it must never promote
 * absence-of-data into “患者否认”. Keep this as a deterministic customer-output guard in
 * addition to the prompt contract because fabricated negative history can suppress follow-up.
 */
/**
 * 随访时间轴 sentinel 的**结构化**净化（2026-08-12 线上实测）。
 *
 * 实测缺陷：随访时间轴帧对一整类病例静默消失。根因是净化器把 sentinel 里的 JSON
 * 当散文逐字改写——`"time":"服药3天后复诊"` 被改成 `"time":病历已记录咳嗽阳性` 并截断整个数组，
 * 下游 JSON.parse 落进 catch 返回 []，帧根本不发。没有报错、没有降级提示，
 * 集成方只会看到「有时有、有时没有」。
 *
 * 修法**不是**把 sentinel 整段跳过净化——时间轴里的观察项与触发条件同样是临床文本，
 * 同样要接受未接地否定的净化（第一版这么写，当场被 test:clinical-grounding 抓到：
 * 它连 M03 的 DIAGNOSIS_JSON sentinel 一起放行了，而那一段本来就该被净化）。
 * 改为**逐字段**净化：解析 → 每个字符串值单独过净化器 → 重新序列化。
 * 接地覆盖一点没丢，JSON 结构也不会再被打碎。
 *
 * 其余 sentinel（M03/M04 契约）的处理**一字未改**，仍按散文整体净化。
 */
function sanitizeFollowupTimelineSentinel(content: string, sanitize: (segment: string) => string): string {
  const start = content.indexOf(FOLLOWUP_TIMELINE_START);
  if (start < 0) return sanitize(content);
  const end = content.indexOf(FOLLOWUP_TIMELINE_END, start + FOLLOWUP_TIMELINE_START.length);
  if (end < 0) return sanitize(content);
  // 时间轴整段**不做接地净化**，原样保留。
  //
  // 接地净化管的是「模型有没有断言一件病历里没有的事」——它会把未接地的症状提及改写成
  // 「病历尚未确认X是否存在」。可是随访时间轴通篇是**前瞻性**内容：
  // 触发条件按定义就指向病人**现在还没有**的症状（「出现高热、腰痛加剧就提前来诊」），
  // 观察项与随访动作同理指向将来。对它做接地净化，产出的是
  // 「触发条件：病历尚未确认发热、腹痛是否存在」——本地实测（真实医案）出现 3 次，
  // 等于告诉医生「记录不全时提前复诊」。
  //
  // 只跳过这一个 sentinel：M03 的 DIAGNOSIS_JSON 是**对当前病历的断言**，必须照常净化
  //（第一版一并跳过，当场被 test:clinical-grounding 抓到）。
  return [
    sanitize(content.slice(0, start)),
    content.slice(start, end + FOLLOWUP_TIMELINE_END.length),
    sanitize(content.slice(end + FOLLOWUP_TIMELINE_END.length)),
  ].join("\n");
}

export function sanitizeUngroundedRedFlagNegations(content: string, state: CaseState): string {
  return sanitizeFollowupTimelineSentinel(content, (segment) => sanitizeUngroundedRedFlagNegationsInProse(segment, state));
}

function sanitizeUngroundedRedFlagNegationsInProse(content: string, state: CaseState): string {
  // 接地语料而非安全语料：这里判断的是「病历里有没有记录过这个症状」。用安全语料会把医生
  // 已录入、只是恰好没出现在 HIS/对话里的症状判成未知，从而凭空写出「病历尚未确认X是否存在」。
  // 见 clinicalGroundingText 的说明；红旗判定不走这条路径。
  const source = clinicalGroundingText(state);
  // 字段槽口径与门禁同源：舌/脉这一栏医生填了内容（含转述式写法）时，净化面不得再按
  // 「无据」把模型据此写出的舌脉改写成待核实。判据只有这一处，门禁读的是同一个谓词。
  const recordedInspection = {
    tongue: hasObtainedTongueFinding(state),
    pulse: hasObtainedPulseFinding(state),
  };
  // 抽取模型给出的阳性症状:只取 quote 能在接地语料中找到的条目(引用接地校验)。
  // parseClinicalFacts 只做结构校验、看不到病历原文,接地必须在这里完成。
  const extractorAffirmedTerms: string[] = (state.clinicalFacts?.affirmedSymptoms || [])
    .filter((item) => Boolean(item?.term) && Boolean(item?.quote) && source.includes(item.quote))
    .map((item) => item.term);
  const jsonBlocks: string[] = [];
  const placeholderContent = content.replace(
    /<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/g,
    (match, jsonText: string) => {
      let sanitizedBlock = match;
      try {
        const missingExamLabels = new Set<string>();
        const differentialNames: string[] = [];
        const visit = (value: unknown, key = "", parentKey = "", entryName = ""): unknown => {
          // Identity labels are not patient assertions. They have already passed the stage contract;
          // running negation prose replacement over them can turn a valid diagnosis name into a
          // sentence such as "病历已记录头痛阳性" and break the signed result after validation.
          if (typeof value === "string" && key === "name") return value;
          // 鉴别对象的「典型表现」写的是那个病自己的表现，不是对本例的断言（查体净化也把它当非本例字段，见 PHYSICAL_EXAM_ASSERTION_FIELDS）。
          // 2026-10-14 独立评审：肠结一条的典型表现「腹痛、呕吐、无排气排便」被改写成「否认腹痛；未诉呕吐」——本例的阴性填进了别的病的典型表现栏。
          if (typeof value === "string" && key === "typicalManifestation") return value;
          // 中成药、西药行里由服务端按说明书逐字补的字段（风险提示、用法边界、联用关系）是说明书原文，不是对本例的断言：
          //「感冒发热病人不宜服用」「不适用于急性肠炎腹泻，腹痛，或发烧」被改成「未诉发热」「未诉腹痛」（2026-10-24 第十八轮基层集
          // 11 个药、甲方 100 例 C001）。只豁免这几个说明书字段，correspondingProblem、positioning 等模型写的字段照常净化。
          if (typeof value === "string" && parentKey === "patentAndWestern" && MEDICINE_LABEL_FIELDS.has(key)) return value;
          // 已删除 nonPharma.monitoring 的净化豁免。该豁免不是安全控制，而是对本净化器的**豁免**：
          // 它存在的唯一理由是重写 trigger 的条件/动作措辞会破坏 monitoring 的语义合同，让 M04
          // 合同拒掉服务端自己净化过的输出。语义合同（5 个 monitoring_* 驳回码）已随字段一并删除，
          // 继任字段 precautions 没有任何语义合同，因此恢复默认净化更安全：净化器只重写带否定/
          // 未知线索的从句（「否认X」「尚未确认X是否存在」），条件句「如出现黑便应立即就医」不触发
          // 任何分支；即便被改写也只是文案变形，不会造成任何驳回。
          if (typeof value === "string") {
            // Only clinician-facing patient-assertion fields are eligible. Reference quotes,
            // source titles and rule metadata may legitimately describe examination criteria and
            // must never be rewritten as if they were claims about this patient.
            const examGrounded = PHYSICAL_EXAM_ASSERTION_FIELDS.has(key)
              ? sanitizeUngroundedPhysicalExamClaims(value, source)
              : { text: value, missingLabels: [] };
            for (const label of examGrounded.missingLabels) missingExamLabels.add(label);
            const groundedValue = examGrounded.text;
            // Exact source facts have already crossed the structured grounding contract. Rewriting
            // them as explanatory prose can corrupt mixed-polarity records: for example, the exact
            // quote “否认突发最剧烈头痛” was expanded into both “头痛阳性” and “否认头痛”, making
            // the post-review contract reject its own grounded projection. Preserve exact chart
            // substrings in provenance-bearing fact fields; unsupported/provider-invented values
            // still flow through the sanitizer and remain fail-closed.
            if (
              ["supportingFacts", "primarySyndromeBasis", "patientFact", "syndromeEvidence"].includes(key) &&
              groundedValue.trim().length >= 2 &&
              source.includes(groundedValue.trim())
            ) {
              return groundedValue;
            }
            // 鉴别行里以被鉴别病证自己为主语的否认（「风瘙痒无原发皮疹」「肋间神经痛无皮疹」）说的是那个病，不是本例，
            // 与 typicalManifestation 同理不净化；只护住这一分句，同一字段里写本例的分句照常核对（2026-10-19 甲方标准病历 9）。
            // 辨病、辨证依据与诊断说明里拿别的病作对照的分句同理（「产后腹痛无发热，乳痈…」「肺痨以咯血、潮热为主」）：主语是本结果里列出的
            // 某个鉴别病证名时不按本例改写（2026-10-25 第二十轮，甲方 100 例 C065 辨病依据交付成「有腹痛，乳痈发热无乳房局部症状」）。
            const kept: string[] = [];
            const subjectNames = (key === "distinguishingPoints" || key === "reason")
              ? [entryName, ...differentialNames].filter(Boolean)
              : DIFFERENTIAL_PROSE_FIELDS.has(key) ? differentialNames : [];
            const shielded = subjectNames.length > 0
              ? groundedValue.replace(/[^，,；;。]+/gu, (clause) => subjectNames.some((name) => differentialSubjectNegation(clause, name))
                ? `__CDSS_KEEP_${kept.push(clause) - 1}__`
                : clause)
              : groundedValue;
            const negationSanitized = sanitizeUngroundedNegationText(shielded, source, extractorAffirmedTerms, recordedInspection);
            // 单值字段被删空（整段只有一条与病历相反的否认）：退回旧写法，不留空字段；列表项删空由下面的数组分支去掉。
            const fieldEmptied = parentKey !== key && !negationSanitized.trim() && shielded.trim().length > 0;
            const sanitized = sanitizePatientApplicableText(sanitizeAgeClaimText(fieldEmptied
              ? sanitizeUngroundedNegationText(shielded, source, extractorAffirmedTerms, recordedInspection, "affirm")
              : negationSanitized, state), state)
              .replace(/__CDSS_KEEP_(\d+)__/gu, (_, index: string) => kept[Number(index)] ?? "");
            if (key === "followupSafetyNet") return ensureActionableFollowupSafetyNet(sanitized);
            const documentedPositive = sanitized.match(/病历已记录(.+?)阳性/);
            const exactDocumentedPositive = sanitized.match(/^\s*病历已记录(.+?)阳性[。；;]?\s*$/);
            if (key === "nextCheck" && documentedPositive?.[1]) {
              return `结合已记录的${documentedPositive[1]}，进一步评估严重度、诱发因素及必要检查`;
            }
            // If an uncertainty row says an already documented positive symptom is unknown, the
            // whole row is contradictory. Mark its reason empty so the containing uncertainty
            // object is removed below; do not manufacture a new “已明确记录” uncertainty reason.
            if (key === "reason" && parentKey === "uncertainties" && exactDocumentedPositive) return "";
            if (key === "reason" && exactDocumentedPositive?.[1]) {
              return `该症状已在病历中明确记录；后续仅需评估${exactDocumentedPositive[1]}的严重度、诱因及伴随表现`;
            }
            if ((key === "primarySyndromeResolutionReason" || key === "resolutionReason") && exactDocumentedPositive?.[1]) {
              // sanitizeUngroundedNegationText promotes a comma before a new discourse clause
              // (“，仍…”) to a semicolon. Emit that canonical boundary immediately so a
              // second pre-signature pass is byte-idempotent and cannot invalidate an accepted
              // independent M03 review.
              return `该症状已在病历中明确记录；当前仅能对相关证候或病机范围作有限判断；仍需结合${exactDocumentedPositive[1]}的严重度、诱因、伴随表现及四诊信息复核`;
            }
            // An uncertainty/check row that merely restates an already documented positive fact is
            // not a useful limitation or test. Remove the contradictory row instead of displaying
            // a synthetic "病历已记录...阳性" item under 建议检查/限制与反证.
            if ((key === "suggestedChecks" || key === "limitations" || key === "mustCollect") && exactDocumentedPositive) return "";
            return sanitized;
          }
          if (Array.isArray(value)) {
            // 净化把整条删空了（病历肯定、模型否认的那一项，DROPPED_NEGATION_CLAUSE）：列表里不留空项。原本就是空串的照旧。
            const visited = value.map((item) => visit(item, key, key, entryName))
              .filter((item, index) => !(typeof item === "string" && !item.trim() && typeof value[index] === "string" && String(value[index]).trim()));
            if (key === "uncertainties") return visited.filter((item) => item !== undefined);
            return DEDUPLICATED_CLINICAL_LIST_FIELDS.has(key)
              ? deduplicateClinicalListItems(visited.filter((item) => typeof item !== "string" || Boolean(item.trim())))
              : visited;
          }
          if (!value || typeof value !== "object") return value;
          const ownName = DIFFERENTIAL_LIST_KEYS.has(parentKey)
            ? ["diseaseName", "name", "syndrome"].map((field) => (value as Record<string, unknown>)[field])
              .find((field): field is string => typeof field === "string" && field.trim().length >= 2)?.trim().replace(/[（(][^（）()]*[）)]/gu, "") || ""
            : "";
          const visited = Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([childKey, raw]) => [childKey, visit(raw, childKey, key, ownName)]),
          );
          if (key === "uncertainties") {
            const row = visited as { item?: unknown; reason?: unknown; affects?: unknown };
            if ([row.item, row.reason, row.affects].some((item) => typeof item !== "string" || !item.trim())) return undefined;
          }
          return visited;
        };
        const parsedRoot = JSON.parse(jsonText);
        differentialNames.push(...collectDifferentialNames(parsedRoot));
        const visited = visit(parsedRoot) as Record<string, unknown>;
        if (missingExamLabels.size > 0) {
          const western = visited.westernDiagnosis && typeof visited.westernDiagnosis === "object" && !Array.isArray(visited.westernDiagnosis)
            ? visited.westernDiagnosis as Record<string, unknown>
            : undefined;
          const primary = western?.primary && typeof western.primary === "object" && !Array.isArray(western.primary)
            ? western.primary as Record<string, unknown>
            : undefined;
          if (primary) {
            const existing = Array.isArray(primary.limitations) ? primary.limitations : [];
            primary.limitations = deduplicateClinicalListItems([
              ...existing,
              ...[...missingExamLabels].map((label) => `本次病历未记录${label}结果，需现场补充。`),
            ]);
          }
        }
        sanitizedBlock = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(visited, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
      } catch {
        // Leave an invalid block unchanged; the structured-response validator will reject it.
      }
      const index = jsonBlocks.push(sanitizedBlock) - 1;
      // Preserve the exact surrounding whitespace. Injecting wrapper newlines here made each
      // pre-review/pre-signature pass add another blank line even when the JSON was unchanged,
      // which broke byte-idempotence and could trigger an unnecessary second model review.
      return `__TCM_CDSS_JSON_BLOCK_${index}__`;
    },
  );
  // 正文里的中成药/西药表格行（带说明书证据编号）同理不净化：说明书注意事项被删句、改写（与上面 JSON 字段同一类）。
  const labelRows: string[] = [];
  const shieldedContent = placeholderContent.replace(/^\|[^\n]*\[(?:LOCAL|EVIMED)[-A-Z0-9]*\][^\n]*$/gmu, (row) => `__TCM_CDSS_LABEL_ROW_${labelRows.push(row) - 1}__`);
  const examGroundedNarrative = sanitizeUngroundedPhysicalExamClaimsInNarrative(shieldedContent, source);
  const sanitizedNarrative = sanitizePatientApplicableText(sanitizeAgeClaimText(sanitizeUngroundedNegationText(examGroundedNarrative, source, extractorAffirmedTerms, recordedInspection), state), state);
  return sanitizedNarrative
    .replace(/__TCM_CDSS_LABEL_ROW_(\d+)__/g, (_, index: string) => labelRows[Number(index)] ?? "")
    .replace(/__TCM_CDSS_JSON_BLOCK_(\d+)__/g, (_, index: string) => jsonBlocks[Number(index)] || "");
}

/** 中成药、西药行里服务端按说明书逐字填写的字段（instruction-record-pool 补齐）：说明书原文，不按本例断言净化。 */
const MEDICINE_LABEL_FIELDS = new Set(["riskNote", "usageBoundary", "relationship", "specification", "singleDose", "frequency", "route"]);

function structuredCaseText(state: CaseState): string {
  return trustedInputText(state);
}

// Full-width digits/letters/punctuation (１８０／１２０, ３９℃, ＳｐＯ２) from HIS exports or Chinese
// IMEs would silently fail every ASCII \d vitals parser and turn the safety gate fail-OPEN.
// Normalize to half-width before any numeric parse. Chinese clause punctuation (。；，) is left
// untouched so downstream negation/clause logic keeps working.
export function normalizeClinicalText(value: string): string {
  if (!value) return value;
  return value
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, " ")
    .replace(/．/g, ".")
    .replace(/／/g, "/")
    .replace(/％/g, "%");
}

const CONTEXTUAL_BLOOD_PRESSURE_SOURCE = String.raw`(?:(?:BP|bloodPressure|血压)["']?\s*[:：]?\s*["']?\s*|(?:本次|当前|现在|今日|今天)?\s*(?:复测|复查|再测)[^。；;\n\d]{0,8})(\d{2,3})\s*(?:\/|\\|-|－|—|–|~|～)\s*(\d{2,3})\s*(?:mmHg)?`;
const LABELED_BLOOD_PRESSURE_SOURCE = String.raw`(?:收缩压|高压)["']?\s*[:：]?\s*["']?\s*(\d{2,3})\s*(?:mmHg)?[^。；;\n]{0,16}(?:舒张压|低压)["']?\s*[:：]?\s*["']?\s*(\d{2,3})\s*(?:mmHg)?`;
const REVERSED_LABELED_BLOOD_PRESSURE_SOURCE = String.raw`(?:舒张压|低压)["']?\s*[:：]?\s*["']?\s*(\d{2,3})\s*(?:mmHg)?[^。；;\n]{0,16}(?:收缩压|高压)["']?\s*[:：]?\s*["']?\s*(\d{2,3})\s*(?:mmHg)?`;

type BloodPressureMeasurement = {
  systolic: number;
  diastolic: number;
  index: number;
  first?: number;
  second?: number;
};

const STRUCTURED_SYSTOLIC_BP_KEYS = [
  "systolicBP", "systolicBp", "SBP", "sbp", "systolic", "systolicPressure",
] as const;
const STRUCTURED_DIASTOLIC_BP_KEYS = [
  "diastolicBP", "diastolicBp", "DBP", "dbp", "diastolic", "diastolicPressure",
] as const;

type StructuredBloodPressureAssessment =
  | { status: "absent" }
  | { status: "invalid"; reason: "incomplete" | "format" | "range" | "order" }
  | { status: "valid"; value: { systolic: number; diastolic: number } };

function firstStructuredVitalValue(vitals: Record<string, unknown> | undefined, keys: readonly string[]): { present: boolean; value?: unknown } {
  if (!vitals) return { present: false };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(vitals, key)) return { present: true, value: vitals[key] };
  }
  return { present: false };
}

function structuredBloodPressureNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && Number.isInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = normalizeClinicalText(value).trim().match(/^(\d{1,3})\s*(?:mmHg)?$/i);
  return match ? Number(match[1]) : null;
}

function structuredBloodPressureAssessment(state: CaseState): StructuredBloodPressureAssessment {
  const systolicEntry = firstStructuredVitalValue(state.vitals, STRUCTURED_SYSTOLIC_BP_KEYS);
  const diastolicEntry = firstStructuredVitalValue(state.vitals, STRUCTURED_DIASTOLIC_BP_KEYS);
  if (!systolicEntry.present && !diastolicEntry.present) return { status: "absent" };
  if (!systolicEntry.present || !diastolicEntry.present) return { status: "invalid", reason: "incomplete" };

  const systolic = structuredBloodPressureNumber(systolicEntry.value);
  const diastolic = structuredBloodPressureNumber(diastolicEntry.value);
  if (systolic == null || diastolic == null) return { status: "invalid", reason: "format" };
  if (systolic < 40 || systolic > 300 || diastolic < 20 || diastolic > 200) {
    return { status: "invalid", reason: "range" };
  }
  if (systolic <= diastolic) return { status: "invalid", reason: "order" };
  return { status: "valid", value: { systolic, diastolic } };
}

function contextualBloodPressurePattern(): RegExp {
  return new RegExp(CONTEXTUAL_BLOOD_PRESSURE_SOURCE, "gi");
}

function bloodPressureMeasurements(text: string): BloodPressureMeasurement[] {
  // 范围写法「180～200/100～110mmHg」「140～159/90～99」：收缩压、舒张压各是一个范围，取各自上限作一次读数，并把这一段遮住，
  // 免得下面把「180～200」读成 180/200 报「收缩压/舒张压倒置」（2026-10-19 Claude 评审 D 集 X-D-0395、1223）。
  const measurements: BloodPressureMeasurement[] = [];
  const normalized = normalizeClinicalText(text).replace(
    /(\d{2,3})\s*[~～\-－—–至]\s*(\d{2,3})\s*[\/／]\s*(\d{2,3})\s*[~～\-－—–至]\s*(\d{2,3})/gu,
    (span: string, a: string, b: string, c: string, d: string, offset: number) => {
      const systolic = Math.max(Number(a), Number(b));
      const diastolic = Math.max(Number(c), Number(d));
      if (systolic > diastolic) measurements.push({ systolic, diastolic, first: systolic, second: diastolic, index: offset });
      return " ".repeat(span.length);
    });
  // 千帕写法（「BP21/12kPa」，老病案常见）：按 1kPa=7.5mmHg 换算后再判（2026-10-19 H 集 H-tri-2808：21/12kPa≈158/90mmHg
  // 被当成 21/12mmHg，报了低血压休克红旗、收回剂量）。
  const KPA_AFTER = /^\s*k\s*pa/iu;
  const kpaToMmHg = (value: number) => Math.round(value * 7.5);
  for (const match of normalized.matchAll(contextualBloodPressurePattern())) {
    let first = Number(match[1]);
    let second = Number(match[2]);
    if (!Number.isFinite(first) || !Number.isFinite(second)) continue;
    const index = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
    if (KPA_AFTER.test(normalized.slice((match.index ?? 0) + match[0].length))) {
      first = kpaToMmHg(first);
      second = kpaToMmHg(second);
    }
    measurements.push({ systolic: first, diastolic: second, first, second, index });
  }
  for (const match of normalized.matchAll(/(?:BP|血压)\s*[:：]?\s*(\d{1,2}(?:\.\d{1,2})?)\s*\/\s*(\d{1,2}(?:\.\d{1,2})?)\s*k\s*pa/giu)) {
    if (!/\./u.test(match[1] + match[2])) continue;
    const index = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
    const first = kpaToMmHg(Number(match[1]));
    const second = kpaToMmHg(Number(match[2]));
    measurements.push({ systolic: first, diastolic: second, first, second, index });
  }
  for (const match of normalized.matchAll(new RegExp(LABELED_BLOOD_PRESSURE_SOURCE, "gi"))) {
    const index = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
    measurements.push({ systolic: Number(match[1]), diastolic: Number(match[2]), index });
  }
  for (const match of normalized.matchAll(new RegExp(REVERSED_LABELED_BLOOD_PRESSURE_SOURCE, "gi"))) {
    const index = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
    measurements.push({ systolic: Number(match[2]), diastolic: Number(match[1]), index });
  }
  return measurements.sort((a, b) => a.index - b.index);
}

function parseBloodPressure(text: string): { systolic: number; diastolic: number } | null {
  const measurement = bloodPressureMeasurements(text).find((item) => item.systolic > item.diastolic);
  return measurement ? { systolic: measurement.systolic, diastolic: measurement.diastolic } : null;
}

function hasInvalidBloodPressureOrder(text: string): boolean {
  return bloodPressureMeasurements(text).some((item) => item.systolic <= item.diastolic);
}

function criticalInvertedBloodPressure(text: string): { first: number; second: number } | null {
  const normalized = normalizeClinicalText(text);
  for (const measurement of bloodPressureMeasurements(normalized)) {
    if (measurement.first == null || measurement.second == null) continue;
    const { first, second } = measurement;
    if (!Number.isFinite(first) || !Number.isFinite(second) || first > second) continue;
    if (isExcludedClinicalAssertionAt(normalized, measurement.index) || isHistoricalOrResolvedAt(normalized, measurement.index)) continue;
    // A value at or above the severe hypertension boundary must enter the deterministic safety
    // path even when the two components appear reversed. The message still requires normalized
    // repeat measurement and target-organ assessment; the parser never silently swaps the values.
    if (Math.max(first, second) >= 180 || Math.min(first, second) >= 120 || Math.min(first, second) <= 45) {
      return { first, second };
    }
  }
  return null;
}

function bloodPressureIsCritical(
  bp: { systolic: number; diastolic: number } | null,
  pediatric?: PediatricVitalReference,
): boolean {
  if (!bp) return false;
  if (bp.systolic >= 180 || bp.diastolic >= 120) return true;
  // 未满 10 岁按 PALS 年龄低血压线（新生儿<60、婴儿<70、1～10 岁<70+2×岁）；成人的收缩压≤80/舒张压≤45
  // 会把健康婴幼儿（收缩压 80～100、舒张压 40～55）判成休克风险。
  if (pediatric?.systolicHypotensionBelow != null) return bp.systolic < pediatric.systolicHypotensionBelow;
  return bp.systolic <= 80 || bp.diastolic <= 45;
}

/**
 * 裸「度」既是体温的口语单位（发烧39度、38度5），也是角度单位。骨伤/推拿/针灸病历里
 * 「直腿抬高试验30度阳性」「针尖与皮肤成45度角斜刺」「折端向外成角约40度」「掌倾角约负30度」
 * 的数值正好落在 30–45 这一段，被读成低体温/极高热红旗，于是整份腰椎间盘突出症病历扣掉剂量。
 * 2026-09-26 公开语料实测：CMB-Clin 74 例真实病案里「腰椎间盘突出症」因
 * 「左下肢直腿抬高试验30度阳性」误报「体温 30℃ 低体温」；灵丹医案 30–45 区间的 50 处「N度」
 * 里 10 处是角度（针刺进针角、抬腿角、骨折成角）。
 *
 * 冻结令例外：数值阈值 + 构词式词法守卫。只在**单位是裸「度」**时生效——带 ℃/°C 或
 * T/体温 标签的一律照旧按体温处理，本守卫不碰。判据取「最近锚点胜出」：同一硬句里，
 * 角度线索若比体温线索更靠近该数值，它就不是体温。这与 clinicalEventTemporalScopeAt
 * 的既往/当前锚点是同一口径，因此「直腿抬高试验30度阳性，体温39度」里 39 仍是发热。
 */
const ANGLE_MEASURE_CUE_SOURCE = String.raw`(?:抬高|抬腿|抬起|屈曲|屈伸|伸展|后伸|前屈|背伸|跖屈|外展|内收|内旋|外旋|旋转|旋颈|侧弯|侧屈|侧倾|外翻|内翻|活动度|关节活动|角度|成角|夹角|倾角|倾斜|弧度|斜刺|平刺|直刺|进针|针尖|针身|Cobb|试验|[成呈](?=\s*(?:负|约|[0-9]|[一二两三四五六七八九十])))`;
const TEMPERATURE_MEASURE_CUE_SOURCE = String.raw`(?:体温|腋温|耳温|肛温|口温|腋下|发热|发烧|高热|低热|壮热|身热|潮热|烧到|烧至|烧得|热度|退热|降温|寒战)`;

function lastCueIndex(text: string, source: string): number {
  let last = -1;
  for (const match of text.matchAll(new RegExp(source, "g"))) last = match.index ?? last;
  return last;
}

/** 见上方说明：该处的裸「度」是角度而非体温。matched 里已带 ℃/°C 或 T/体温 时恒为 false。 */
function isAngularDegreeAt(text: string, matchStart: number, matched: string): boolean {
  if (/℃|°C|T|体温/i.test(matched)) return false;
  if (!matched.includes("度")) return false;
  // 「45度角」「30～45度角」：单位后面直接跟「角」，构词式判定，不必看上下文。
  if (/^\s*角/.test(text.slice(matchStart + matched.length))) return true;
  const hardStart = Math.max(
    text.lastIndexOf("。", matchStart - 1),
    text.lastIndexOf("；", matchStart - 1),
    text.lastIndexOf(";", matchStart - 1),
    text.lastIndexOf("\n", matchStart - 1),
  ) + 1;
  const before = text.slice(hardStart, matchStart);
  return lastCueIndex(before, ANGLE_MEASURE_CUE_SOURCE) > lastCueIndex(before, TEMPERATURE_MEASURE_CUE_SOURCE);
}

// Accepts "38.9℃", "38.9度", the Chinese decimal idiom "38度9" (=38.9), and full-width input.
function parseTemperature(text: string): number | null {
  const t = normalizeClinicalText(text);
  // "38度9" / "38度9分" → 38.9 (度 as a decimal separator, 分 = tenth-of-a-degree). But a trailing digit
  // that begins a duration/count word ("39度2小时后复测", "38度9天") is NOT a decimal, so exclude those
  // units to avoid fabricating a temperature that could trip a red flag.
  for (const match of t.matchAll(/(?<!\d)(4[0-5]|3\d)度(\d)(?!\d)(?!\s*(?:天|次|日|周|月|年|岁|小时|分钟|秒|时|点|余|多|回|下|个|号))/g)) {
    if (isAngularDegreeAt(t, match.index ?? 0, match[0])) continue;
    return Number(`${match[1]}.${match[2]}`);
  }
  for (const labeled of t.matchAll(/(?:^|[^A-Za-z])(?:T|体温)["']?\s*[:：]?\s*["']?\s*(4[0-5]|3\d)(?:[.](\d))?/gi)) {
    if (followedByLabUnit(t, (labeled.index ?? 0) + labeled[0].length)) continue;
    return Number(labeled[2] ? `${labeled[1]}.${labeled[2]}` : labeled[1]);
  }
  for (const match of t.matchAll(/(?<!\d)(4[0-5]|3\d)(?:[.](\d))?\s*(?:℃|°C|度)/gi)) {
    if (isAngularDegreeAt(t, match.index ?? 0, match[0])) continue;
    return Number(match[2] ? `${match[1]}.${match[2]}` : match[1]);
  }
  return null;
}

/**
 * 「T」后面的数接着化验单位时不是体温（2026-10-18 逐模块验收 A 集：甲功「T32.0nmol/L（正常值为1.73~3nmol/L）」——T3 的 3
 * 在原文里丢了——被读成体温 32℃，报低体温红旗）。单位是有限闭集：mol 类、mg、g/L、U/L、IU、ng、μg、pg、%。
 */
const LAB_UNIT_AFTER_VALUE = /^\s*(?:[.\d]+\s*)?(?:(?:n|p|m|μ|µ|u)?mol\b|mg|g\s*\/\s*L|U\s*\/\s*L|IU|ng|μg|µg|ug|pg|%)/i;
function followedByLabUnit(text: string, endIndex: number): boolean {
  return LAB_UNIT_AFTER_VALUE.test(text.slice(endIndex, endIndex + 12));
}

function parsePulse(text: string): number | null {
  // 「胎心率150次/分」是胎儿心率，不是孕妇的脉搏（2026-10-19 Claude 评审 A 集 A-eme-0142：红旗理由写成「心率/脉搏 150次/分异常」）。构词式守卫：心率前面紧挨「胎」不算。
  const match = normalizeClinicalText(text).match(/(?:^|[^A-Za-z胎])(?:P|HR|心率|脉搏)["']?\s*[:：]?\s*["']?\s*(\d{2,3})\s*(?:次\/分|次每分|bpm)?/i);
  if (!match) return null;
  const value = Number(match[1]);
  // 生理可达边界之外的录入值（如 0、300 次/分）不是有效测量，交给非法值复核流程而不是危急值。
  return Number.isFinite(value) && value >= 20 && value <= 250 ? value : null;
}

function parseRespiration(text: string): number | null {
  const match = normalizeClinicalText(text).match(/(?:^|[^A-Za-z])(?:R|RR|呼吸)["']?\s*[:：]?\s*["']?\s*(\d{1,2})\s*(?:次\/分|次每分)?/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 5 && value <= 60 ? value : null;
}

function parseSpo2(text: string): number | null {
  const match = normalizeClinicalText(text).match(/(?:SpO2|指脉氧|血氧(?:饱和度)?|氧饱和度)["']?\s*[:：]?\s*["']?\s*(\d+(?:\.\d+)?)\s*%?/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 50 && value <= 100 ? value : null;
}

// 生理可达边界（与解析器一致）：超出边界或无法解析的录入值既不是“正常”，也不是有效危急值，
// 必须显式进入 missingItems 要求按范围/格式重录；真正的异常有效值仍按原阈值产生危急红旗。
function invalidSpo2Values(text: string): string[] {
  const normalized = normalizeClinicalText(text);
  const out: string[] = [];
  const pattern = /(?:(?:SpO2|指脉氧|血氧(?:饱和度)?|氧饱和度)["']?\s*[:：]?\s*["']?\s*(\d+(?:\.\d+)?)\s*%?|(?:本次|当前|现在|今日|今天)?\s*(?:复测|复查|再测)[^。；;\n\d]{0,8}(\d+(?:\.\d+)?)\s*%)/gi;
  for (const match of normalized.matchAll(pattern)) {
    const raw = match[1] || match[2];
    const value = Number(raw);
    const valueIndex = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(raw));
    if (isExcludedClinicalAssertionAt(normalized, valueIndex)) continue;
    if (!Number.isFinite(value) || value < 50 || value > 100) out.push(`${raw}%`);
  }
  return out;
}

function invalidPulseValues(text: string): string[] {
  const normalized = normalizeClinicalText(text);
  const out: string[] = [];
  for (const match of normalized.matchAll(/(?:^|[^A-Za-z胎])(?:P|HR|心率|脉搏)["']?\s*[:：]?\s*["']?\s*(\d+(?:\.\d+)?)\s*(?:次\/分|次每分|bpm)?/gi)) {
    const value = Number(match[1]);
    const valueIndex = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
    if (isExcludedClinicalAssertionAt(normalized, valueIndex)) continue;
    if (!Number.isFinite(value) || value < 20 || value > 250) out.push(match[1]);
  }
  return out;
}

function invalidRespirationValues(text: string): string[] {
  const normalized = normalizeClinicalText(text);
  const out: string[] = [];
  for (const match of normalized.matchAll(/(?:^|[^A-Za-z])(?:R|RR|呼吸)["']?\s*[:：]?\s*["']?\s*(\d+(?:\.\d+)?)\s*(?:次\/分|次每分)?/gi)) {
    const value = Number(match[1]);
    const valueIndex = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
    if (isExcludedClinicalAssertionAt(normalized, valueIndex)) continue;
    if (!Number.isFinite(value) || value < 5 || value > 60) out.push(match[1]);
  }
  return out;
}

function invalidTemperatureValues(text: string): string[] {
  const normalized = normalizeClinicalText(text);
  const out: string[] = [];
  // 仅带 T/体温 标签的候选：无标签的 ℃ 数值（水温等）不按体温非法值处理。
  for (const match of normalized.matchAll(/(?:^|[^A-Za-z])(?:T|体温)["']?\s*[:：]?\s*["']?\s*(\d+(?:\.\d+)?)\s*(?:℃|°C|度)?/gi)) {
    if (followedByLabUnit(normalized, (match.index ?? 0) + match[0].length)) continue;
    const value = Number(match[1]);
    const valueIndex = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
    if (isExcludedClinicalAssertionAt(normalized, valueIndex)) continue;
    if (!Number.isFinite(value) || value < 30 || value > 45) out.push(match[1]);
  }
  // 中文小数写法“45度9”=45.9：先按整数位通过上一条扫描，这里按真实小数值复核。
  for (const match of normalized.matchAll(/(?:^|[^A-Za-z])(?:T|体温)["']?\s*[:：]?\s*["']?\s*(\d{2})度(\d)/g)) {
    const value = Number(`${match[1]}.${match[2]}`);
    const valueIndex = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
    if (isExcludedClinicalAssertionAt(normalized, valueIndex)) continue;
    if (value < 30 || value > 45) out.push(String(value));
  }
  return out;
}

function preferAbnormalNumber(
  primary: number | null,
  secondary: number | null,
  isAbnormal: (value: number) => boolean,
): number | null {
  if (secondary != null && isAbnormal(secondary)) return secondary;
  return primary ?? secondary;
}

function isHistoricalOrResolvedAt(text: string, index: number, eventLength = 0): boolean {
  return clinicalEventTemporalScopeAt(text, index, eventLength) !== "current";
}

function parseContextualNumber(
  text: string,
  pattern: RegExp,
  toNumber: (match: RegExpMatchArray, normalized: string) => number | null,
  isAbnormal: (value: number) => boolean,
): number | null {
  const normalized = normalizeClinicalText(text);
  let fallback: number | null = null;
  for (const match of normalized.matchAll(pattern)) {
    const value = toNumber(match, normalized);
    if (value == null || !Number.isFinite(value)) continue;
    const numericCapture = match.slice(1).find((part) => part && /\d/.test(part));
    const valueOffset = numericCapture ? match[0].lastIndexOf(numericCapture) : 0;
    const index = (match.index ?? 0) + Math.max(0, valueOffset);
    if (isExcludedClinicalAssertionAt(normalized, index)) continue;
    if (isHistoricalOrResolvedAt(normalized, index, match[0].length - Math.max(0, valueOffset))) continue;
    if (fallback == null) fallback = value;
    if (isAbnormal(value)) return value;
  }
  return fallback;
}

/**
 * 体温：有本次读数（「现在快39℃」「目前体温38.5℃」「就诊时T 38℃」）时以本次为准；前几天、上次、某月那次的极值不当成现在的体温
 *（2026-10-19 Claude 评审 B 集 IMCS21-10663648#4「前几天发烧39-40℃，现在快39℃」、MedDG-5010#11「12月流感时体温40℃」报了极高热红旗）。
 */
const CURRENT_TEMPERATURE_CUE = /(?:现在|目前|现|今日|今天|今晨|刻下|此刻|就诊时|入院时|查体)[^，,。；;\n]{0,6}$/u;
const PAST_EPISODE_TEMPERATURE_CUE = /(?:前几天|前两天|前些天|\d{1,2}月[^，,。；;\n]{0,8}时|去年|上次|前次|那次|当时|之前|既往)[^，,。；;\n]{0,8}$/u;
function parseContextualTemperature(text: string): number | null {
  const normalized = normalizeClinicalText(text);
  const pattern = /(?:(?:^|[^A-Za-z])(?:T|体温)["']?\s*[:：]?\s*["']?\s*)?(4[0-5]|3\d)(?:(?:[.](\d))|(?:度(\d)))?\s*(?:℃|°C|度)?/gi;
  const current = [...normalized.matchAll(pattern)].filter((match) => /(?:T|体温|℃|°C|度)/i.test(match[0]) &&
    CURRENT_TEMPERATURE_CUE.test(normalized.slice(Math.max(0, (match.index ?? 0) - 10), (match.index ?? 0) + match[0].indexOf(match[1]))));
  const masked = current.length > 0
    ? [...normalized.matchAll(pattern)].reduce((acc, match) => {
      const start = match.index ?? 0;
      const before = normalized.slice(Math.max(0, start - 16), start + match[0].indexOf(match[1]));
      return PAST_EPISODE_TEMPERATURE_CUE.test(before) ? `${acc.slice(0, start)}${" ".repeat(match[0].length)}${acc.slice(start + match[0].length)}` : acc;
    }, normalized)
    : normalized.replace(pattern, (span: string, _a: string, _b: string, _c: string, offset: number) => {
      const before = normalized.slice(Math.max(0, offset - 16), offset + span.search(/\d/));
      return /(?:\d{1,2}月[^，,。；;\n]{0,8}时|去年|上次|前次|那次)[^，,。；;\n]{0,8}$/u.test(before) ? " ".repeat(span.length) : span;
    });
  return parseContextualTemperatureRaw(masked);
}

function parseContextualTemperatureRaw(text: string): number | null {
  return parseContextualNumber(
    text,
    /(?:(?:^|[^A-Za-z])(?:T|体温)["']?\s*[:：]?\s*["']?\s*)?(4[0-5]|3\d)(?:(?:[.](\d))|(?:度(\d)))?\s*(?:℃|°C|度)?/gi,
    (match, normalized) => {
      if (!/(?:T|体温|℃|°C|度)/i.test(match[0])) return null;
      if (isAngularDegreeAt(normalized, match.index ?? 0, match[0])) return null;
      if (followedByLabUnit(normalized, (match.index ?? 0) + match[0].length)) return null;
      const decimal = match[2] || match[3];
      return Number(decimal ? `${match[1]}.${decimal}` : match[1]);
    },
    (value) => value >= 39 || value < 36,
  );
}

function parseContextualPulse(text: string): number | null {
  return parseContextualNumber(
    text,
    /(?:^|[^A-Za-z胎])(?:P|HR|心率|脉搏)["']?\s*[:：]?\s*["']?\s*(\d{2,3})\s*(?:次\/分|次每分|bpm)?/gi,
    (match) => {
      const value = Number(match[1]);
      return Number.isFinite(value) && value >= 20 && value <= 250 ? value : null;
    },
    (value) => value >= 120 || value < 50,
  );
}

function parseContextualRespiration(text: string): number | null {
  return parseContextualNumber(
    text,
    /(?:^|[^A-Za-z])(?:R|RR|呼吸)["']?\s*[:：]?\s*["']?\s*(\d{1,2})\s*(?:次\/分|次每分)?/gi,
    (match) => {
      const value = Number(match[1]);
      return Number.isFinite(value) && value >= 5 && value <= 60 ? value : null;
    },
    (value) => value >= 25 || value < 8,
  );
}

function parseContextualSpo2(text: string): number | null {
  return parseContextualNumber(
    text,
    /(?:(?:SpO2|指脉氧|血氧(?:饱和度)?|氧饱和度)["']?\s*[:：]?\s*["']?\s*(\d+(?:\.\d+)?)\s*%?|(?:本次|当前|现在|今日|今天)?\s*(?:复测|复查|再测)[^。；;\n\d]{0,8}(\d+(?:\.\d+)?)\s*%)/gi,
    (match) => {
      const value = Number(match[1] || match[2]);
      return Number.isFinite(value) && value >= 50 && value <= 100 ? value : null;
    },
    (value) => value <= 91,
  );
}

/**
 * 早先一次读数已被本次测量取代（2026-10-19，r1019 验收集 M-MTCMB-50/90：「急诊时测血压190/101mmHg，予…后好转」
 *「自测血压180/107mmHg…急诊…予硝酸甘油泵…症状缓解」，入院查体血压 172/96、164/97，确定性层仍按急诊那次报重度高血压）。
 * 冻结令允许的确定性例外：构词式守卫（闭集）。早先读数前 12 字内有院外/当时的测量语（自测、时测、当时、急诊、
 * 就诊时、发病时、入院前、在家、外院、院外、当地），读数之后写了处置（予、给予、经、服、含服、静滴、泵入、
 * 治疗、处理、降压、对症），且后面还有一次本次测量（生命体征、体格检查、查体、入院时、现/目前/刻下/今日…测、今测、
 * 复测或「血压：」标注）——此时以本次测量为准。类夹具 superseded-prior-blood-pressure。
 */
const PRIOR_EPISODE_BP_MARKER = /自测|时测|当时|急诊|就诊时|发病时|入院前|在家|外院|院外|当地/u;
const BP_TREATMENT_AFTER = /予|给予|经|服|含服|静滴|静推|泵入|治疗|处理|降压|对症/u;
const CURRENT_BP_CONTEXT = /生命体征|体格检查|查体|入院时|(?:现|目前|刻下|今日|今天|本次)[^，,。；;\n]{0,4}(?:测|血压|BP)|今测|复测|血压\s*[:：]/u;
function priorEpisodeBloodPressureAt(normalized: string, index: number, nextIndex: number): boolean {
  if (!PRIOR_EPISODE_BP_MARKER.test(normalized.slice(Math.max(0, index - 12), index))) return false;
  return BP_TREATMENT_AFTER.test(normalized.slice(index, nextIndex));
}
function parseContextualBloodPressureDetailed(text: string): { bp: { systolic: number; diastolic: number } | null; priorEpisode: boolean } {
  const normalized = normalizeClinicalText(text);
  let fallback: { systolic: number; diastolic: number } | null = null;
  const measurements = bloodPressureMeasurements(normalized).filter((measurement) =>
    Number.isFinite(measurement.systolic) && Number.isFinite(measurement.diastolic) && measurement.systolic > measurement.diastolic &&
    !isExcludedClinicalAssertionAt(normalized, measurement.index));
  const eligible = measurements.filter((measurement) => {
    if (isHistoricalOrResolvedAt(normalized, measurement.index)) return false;
    // 病史里的极值（「最高血压280/243mmhg」「自测血压最高达180/105」）是既往测过的最高值，不是这次测到的血压
    //（2026-10-18 验收集 M-TCMChat-test-352：既往最高值当成当前值报重度高血压红旗）。构词式守卫：读数前 10 字内有极值词。
    return !/最高|最低|峰值|曾达|曾高达/u.test(normalized.slice(Math.max(0, measurement.index - 10), measurement.index));
  });
  for (const measurement of eligible) {
    const bp = { systolic: measurement.systolic, diastolic: measurement.diastolic };
    if (!bloodPressureIsCritical(bp)) {
      if (!fallback) fallback = bp;
      continue;
    }
    // 本次测量只看写法（查体/生命体征/复测…），不用通用的既往/已缓解判据——「…后症状缓解。生命体征：血压164/97」里
    // 「缓解」在本次读数之前，会把它误判成已缓解的旧读数。
    const later = measurements.find((item) => item.index > measurement.index &&
      CURRENT_BP_CONTEXT.test(normalized.slice(Math.max(measurement.index + 1, item.index - 40), item.index)));
    if (later && priorEpisodeBloodPressureAt(normalized, measurement.index, later.index)) {
      if (!fallback) fallback = { systolic: later.systolic, diastolic: later.diastolic };
      continue;
    }
    const priorEpisode = !later && priorEpisodeBloodPressureAt(normalized, measurement.index, normalized.length);
    return { bp, priorEpisode };
  }
  return { bp: fallback, priorEpisode: false };
}
function parseContextualBloodPressure(text: string): { systolic: number; diastolic: number } | null {
  return parseContextualBloodPressureDetailed(text).bp;
}

export function currentVitalsSummary(state: CaseState): string | undefined {
  const topLevel = state.vitals || {};
  const observations = (field: keyof HisRecordSnapshot["fields"], label: string, keys: string[]) => {
    const authoritative = fieldText(state, field);
    const values = (isKnownClinicalText(authoritative)
      ? [authoritative]
      : keys.map((key) => stringifyClinicalValue(topLevel[key])))
      .filter((value) => isKnownClinicalText(value));
    return values.map((value) => `${label}:${value}`).join("；");
  };
  const authoritativeBloodPressure = fieldText(state, "vitalsBP");
  const splitBloodPressure = !isKnownClinicalText(authoritativeBloodPressure)
    ? structuredBloodPressureAssessment(state)
    : { status: "absent" as const };
  const structuredVitals = [
    observations("vitalsT", "T", ["temperature", "T", "temp"]),
    observations("vitalsP", "P", ["pulse", "P", "heartRate", "HR"]),
    observations("vitalsR", "R", ["respiration", "R", "respiratoryRate", "RR"]),
    observations("vitalsBP", "BP", ["bloodPressure", "BP", "bp"]),
    splitBloodPressure.status === "valid" ? `BP:${splitBloodPressure.value.systolic}/${splitBloodPressure.value.diastolic}` : "",
  ].filter(Boolean).join("；");
  const temperature = parseContextualTemperature(structuredVitals);
  const pulse = parseContextualPulse(structuredVitals);
  const respiration = parseContextualRespiration(structuredVitals);
  const bloodPressure = parseContextualBloodPressure(structuredVitals);
  const authoritativeDetail = fieldText(state, "vitalsDetail");
  const detail = isKnownClinicalText(authoritativeDetail)
    ? authoritativeDetail
    : [
        stringifyClinicalValue(topLevel.detail),
        ...[topLevel.SpO2, topLevel.spo2, topLevel.oxygenSaturation]
          .map((value) => stringifyClinicalValue(value))
          .filter((value) => isKnownClinicalText(value))
          .map((value) => `SpO2:${value}`),
      ].filter((value) => isKnownClinicalText(value)).join("；");
  const spo2 = preferAbnormalNumber(parseContextualSpo2(detail), parseContextualSpo2(structuredVitals), (value) => value <= 91);
  const parts = [
    temperature != null ? `T ${temperature}℃` : "",
    pulse != null ? `P ${pulse}次/分` : "",
    respiration != null ? `R ${respiration}次/分` : "",
    bloodPressure ? `BP ${bloodPressure.systolic}/${bloodPressure.diastolic}mmHg` : "",
    spo2 != null ? `SpO2 ${spo2}%` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("；") : undefined;
}

function vitalsText(state: CaseState): string {
  return [
    currentVitalsSummary(state),
    fieldText(state, "vitalsT") && `T:${fieldText(state, "vitalsT")}`,
    fieldText(state, "vitalsP") && `P:${fieldText(state, "vitalsP")}`,
    fieldText(state, "vitalsR") && `R:${fieldText(state, "vitalsR")}`,
    fieldText(state, "vitalsBP") && `BP:${fieldText(state, "vitalsBP")}`,
    fieldText(state, "vitalsDetail"),
  ].filter(Boolean).join(" ");
}

export type CurrentVitalMeasurements = {
  bloodPressure: { systolic: number; diastolic: number } | null;
  temperature: number | null;
  pulse: number | null;
  respiration: number | null;
  spo2: number | null;
  invertedCriticalBloodPressure: { first: number; second: number } | null;
};

function bloodPressureReviewPriority(value: { systolic: number; diastolic: number } | null): number {
  if (!value) return 0;
  if (bloodPressureIsCritical(value)) return 3;
  if (value.systolic >= 180 || value.diastolic >= 120 || value.systolic <= 90 || value.diastolic <= 50) return 2;
  return 1;
}

/**
 * One current-measurement source for both hard red flags and non-blocking vital advisories.
 * Values documented in clinician-entered free text are parsed with the same polarity and temporal
 * rules as structured vitals, so a subcritical abnormal value cannot disappear merely because it
 * was entered in the narrative field.
 */
/**
 * 儿童生命体征参考线（未满 12 岁且年龄可判）。有数值年龄按数值；只写了档位词（「幼儿」）时取该档最大年龄，
 * 两头都落在更保守的一侧。年龄未知、12 岁及以上返回 undefined，调用方沿用成人线。
 */
export function pediatricVitalReferenceForCase(input: CaseState): PediatricVitalReference | undefined {
  const state = withPatientObject(input);
  const age = numberFromClinicalText(patientAgeText(state));
  if (age != null) return pediatricVitalReferenceForAgeYears(age);
  const rule = pediatricDoseRuleForCase(state);
  return pediatricVitalReferenceForAgeYears(rule ? pediatricStageOldestAgeYears(rule) : undefined);
}

/** 部分构造的病例（只带主诉/事实的探针与旧快照）没有 patient 对象：按「年龄、性别都未知」处理，不抛错。 */
function withPatientObject(state: CaseState): CaseState {
  return state.patient ? state : { ...state, patient: {} as CaseState["patient"] };
}

export function currentVitalMeasurements(state: CaseState): CurrentVitalMeasurements {
  const pediatricVitals = pediatricVitalReferenceForCase(state);
  const structuredText = vitalsText(state);
  const narrativeText = trustedInputText(state);
  const structuredBloodPressure = parseContextualBloodPressure(structuredText);
  const narrative = parseContextualBloodPressureDetailed(narrativeText);
  // 叙述里的危急读数是院外/当时那次、且之后已经处置（priorEpisodeBloodPressureAt），而本次结构化录入了血压：以本次为准。
  const narrativeBloodPressure = narrative.priorEpisode && structuredBloodPressure ? null : narrative.bp;
  const bloodPressure = [structuredBloodPressure, narrativeBloodPressure]
    .sort((left, right) => bloodPressureReviewPriority(right) - bloodPressureReviewPriority(left))[0] ?? null;
  return {
    bloodPressure,
    temperature: preferAbnormalNumber(
      parseContextualTemperature(structuredText),
      parseContextualTemperature(narrativeText),
      (value) => value >= 39 || value < 36,
    ),
    pulse: preferAbnormalNumber(
      parseContextualPulse(structuredText),
      parseContextualPulse(narrativeText),
      (value) => value >= (pediatricVitals?.pulseAdvisoryFrom ?? 120) || value < 50,
    ),
    respiration: preferAbnormalNumber(
      parseContextualRespiration(structuredText),
      parseContextualRespiration(narrativeText),
      (value) => value >= (pediatricVitals?.respirationAdvisoryFrom ?? 25) || value <= 8,
    ),
    spo2: preferAbnormalNumber(
      parseContextualSpo2(structuredText),
      parseContextualSpo2(narrativeText),
      (value) => value <= 91,
    ),
    invertedCriticalBloodPressure: criticalInvertedBloodPressure(`${structuredText}\n${narrativeText}`),
  };
}

function hasRequiredVitals(state: CaseState): boolean {
  const text = vitalsText(state);
  return Boolean(parseTemperature(text) && parsePulse(text) && parseRespiration(text) && parseBloodPressure(text));
}

const VITAL_FIELD_CHECKS: Array<{ key: keyof HisRecordSnapshot["fields"]; vitalKeys: string[]; label: string; parse: (s: string) => unknown; name: string }> = [
    { key: "vitalsBP", vitalKeys: ["bloodPressure", "BP", "bp"], label: "BP", parse: parseBloodPressure, name: "血压" },
    { key: "vitalsT", vitalKeys: ["temperature", "T", "temp"], label: "T", parse: parseTemperature, name: "体温" },
    { key: "vitalsP", vitalKeys: ["pulse", "P", "heartRate", "HR"], label: "P", parse: parsePulse, name: "脉搏/心率" },
    { key: "vitalsR", vitalKeys: ["respiration", "R", "respiratoryRate", "RR"], label: "R", parse: parseRespiration, name: "呼吸" },
];

type InvalidVitalFinding = {
  name: "血压" | "体温" | "脉搏/心率" | "呼吸" | "血氧";
  label: string;
  value: string;
  kind: "range" | "format";
  expected: string;
};

const INVALID_VITAL_LABELS = {
  血压: "血压",
  体温: "体温",
  "脉搏/心率": "脉搏/心率",
  呼吸: "呼吸",
  血氧: "血氧饱和度（SpO2）",
} as const;

const INVALID_VITAL_EXPECTED = {
  血压: "收缩压/舒张压mmHg（收缩压40-300、舒张压20-200，如120/80）",
  体温: "30-45℃",
  "脉搏/心率": "20-250次/分",
  呼吸: "5-60次/分",
  血氧: "50-100%",
} as const;

// 已录入但非法（无法解析或超出生理可达边界）的生命体征：逐项给出原始值与所需格式/范围，
// 让医生明确重录要求。只报第一个 offending 值，避免同一项重复告警。
function invalidEnteredVitalFindings(state: CaseState): InvalidVitalFinding[] {
  const findings: InvalidVitalFinding[] = [];
  const push = (name: InvalidVitalFinding["name"], value: string, kind: InvalidVitalFinding["kind"]) => {
    if (findings.some((finding) => finding.name === name)) return;
    findings.push({
      name,
      label: INVALID_VITAL_LABELS[name],
      value: value.slice(0, 24),
      kind,
      expected: INVALID_VITAL_EXPECTED[name],
    });
  };
  const structuredBloodPressure = structuredBloodPressureAssessment(state);
  if (structuredBloodPressure.status === "invalid") {
    const rawSystolic = stringifyClinicalValue(firstStructuredVitalValue(state.vitals, STRUCTURED_SYSTOLIC_BP_KEYS).value) || "（缺）";
    const rawDiastolic = stringifyClinicalValue(firstStructuredVitalValue(state.vitals, STRUCTURED_DIASTOLIC_BP_KEYS).value) || "（缺）";
    push(
      "血压",
      `收缩压${rawSystolic}/舒张压${rawDiastolic}`,
      structuredBloodPressure.reason === "range" || structuredBloodPressure.reason === "order" ? "range" : "format",
    );
  }
  for (const check of VITAL_FIELD_CHECKS) {
    // A top-level value may have been entered through an API client even when an HIS snapshot is
    // also present. It is not trusted as an affirmative red-flag fact, but a malformed entered value
    // must still fail closed and request correction instead of silently disappearing.
    const enteredValues = [
      fieldText(state, check.key),
      ...check.vitalKeys.map((key) => stringifyClinicalValue(state.vitals?.[key])),
    ].filter((value) => isKnownClinicalText(value));
    for (const value of enteredValues) {
      if (check.parse(`${check.label}:${value}`) == null) {
        push(check.name as InvalidVitalFinding["name"], value, /\d/.test(value) ? "range" : "format");
        break;
      }
    }
  }
  const corpus = `${vitalsText(state)}\n${trustedInputText(state)}`;
  // 结构化录入的 SpO2（topLevel.SpO2/spo2/oxygenSaturation）不带标签地散落在 vitals 对象里，
  // 显式补上标签再扫，避免非法血氧经结构化通道静默消失。
  const structuredSpo2 = [state.vitals?.SpO2, state.vitals?.spo2, state.vitals?.oxygenSaturation]
    .map((value) => stringifyClinicalValue(value))
    .filter((value) => isKnownClinicalText(value))
    .map((value) => `SpO2:${value}`)
    .join("\n");
  const invalidSpo2 = invalidSpo2Values(`${corpus}\n${structuredSpo2}`);
  if (invalidSpo2.length > 0) push("血氧", invalidSpo2[0], "range");
  const invalidPulse = invalidPulseValues(corpus);
  if (invalidPulse.length > 0) push("脉搏/心率", invalidPulse[0], "range");
  const invalidRespiration = invalidRespirationValues(corpus);
  if (invalidRespiration.length > 0) push("呼吸", invalidRespiration[0], "range");
  const invalidTemperature = invalidTemperatureValues(corpus);
  if (invalidTemperature.length > 0) push("体温", invalidTemperature[0], "range");
  return findings;
}

function formatInvalidVitalFinding(finding: InvalidVitalFinding): string {
  return finding.kind === "range"
    ? `${finding.label}数值异常(${finding.value})，请按 ${finding.expected} 范围重新录入`
    : `${finding.label}无法识别为有效数值(${finding.value})，请按 ${finding.expected} 格式重新录入`;
}

function unparseableVitalNames(state: CaseState): string[] {
  return Array.from(new Set(invalidEnteredVitalFindings(state).map((finding) => finding.name)));
}

// Missing vital signs remain optional for an ordinary, non-high-risk presentation. Once a value is
// entered, however, an unparseable value must not silently unlock a dose-level prescription.
export function unparseableVitalAdvisories(state: CaseState): string[] {
  return unparseableVitalNames(state).map((name) => `${name}已录入但无法识别为有效数值，请核对录入格式（处方前必须复核）`);
}

function symptomsFieldText(state: CaseState, key: string): string {
  const value = state.symptoms?.[key];
  return stringifyClinicalValue(value);
}

function hasSubstantivePresentHistory(value: string): boolean {
  const normalized = normalizeClinicalText(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!isKnownClinicalText(normalized)) return false;
  const compact = normalized.replace(/[\s，,。.!！?？；;：:、（）()【】\[\]"'“”‘’_-]+/g, "");
  if (!compact || /^(?:(?:null|undefined|nan|none|nil|unknown|test|测试|患者|病人|无|不详|未知|未提供))+$/i.test(compact)) return false;
  // Narrative completeness requires at least one clinical-course or symptom signal. Arbitrary
  // control-character/XSS/program-literal payloads are still sanitized elsewhere, but they cannot
  // be counted as meaningful present history merely because their string length is non-zero.
  return /(?:\d+(?:\.\d+)?\s*(?:分钟|小时|天|日|周|月|年)|近来|近期|今[日天晨晚]|昨[日天晚]|夜间|晨起|起病|开始|突发|逐渐|持续|反复|间断|发作|诱因|受凉|劳累|进食|活动|体位|伴|不伴|加重|减轻|缓解|治疗|服药|检查|疼|痛|胀|麻|晕|悸|咳|痰|喘|热|寒|汗|吐|泻|便|尿|睡|眠|食欲|乏力|皮疹|瘙痒|出血|水肿|呼吸|血压|血糖)/i.test(normalized);
}

export function deriveOperationalCompleteness(state: CaseState): Completeness {
  const chiefText = authoritativeFieldOrFallback(state, "zhushu", state.chiefComplaint);
  const presentHistoryText = authoritativeFieldOrFallback(state, "xianbingshi", symptomsFieldText(state, "presentHistory"));
  const hasChief = isKnownClinicalText(chiefText);
  const hasVitals = hasRequiredVitals(state);
  const hasTongue = hasObtainedTongueFinding(state);
  const hasPulse = hasObtainedPulseFinding(state);
  const hasPresentHistory = hasSubstantivePresentHistory(presentHistoryText);
  const hasTcmDetail = isKnownClinicalText(authoritativeFieldOrFallback(state, "tcmDetail", symptomsFieldText(state, "tcmDetail"))) ||
    isKnownClinicalText(authoritativeFieldOrFallback(state, "tcmFace", state.faceNote));
  const hasPastOrMedicationContext = isKnownClinicalText(authoritativeFieldOrFallback(state, "jiwangshi", state.pastHistory)) ||
    isKnownClinicalText(authoritativeFieldOrFallback(state, "yongyaoshi", state.medicationHistory)) ||
    isKnownClinicalText(authoritativeFieldOrFallback(state, "guomin", state.allergyHistory));

  const compactNarrative = (value: string) => value.normalize("NFKC").replace(/[\s，,。.!！?？；;：:、（）()【】\[\]"'“”‘’_-]+/g, "");
  const compactChief = compactNarrative(chiefText);
  const compactHistory = compactNarrative(presentHistoryText);
  const novelHistory = compactChief && compactHistory.includes(compactChief)
    ? compactHistory.replace(compactChief, "")
    : compactHistory;
  const hasDistinctPresentHistory = hasPresentHistory && (
    !compactChief ||
    (compactHistory !== compactChief && !compactChief.includes(compactHistory) && novelHistory.length >= 6)
  );
  const hasNarrativeDetail = hasDistinctPresentHistory || hasTcmDetail;
  const hasContextDetail = hasNarrativeDetail || hasPastOrMedicationContext;
  const redFlagScreenText = trustedInputText(state);
  const hasExplicitRedFlagScreening = /(否认|无|不伴|未见|排除|已查|检查).{0,40}(胸痛|胸闷|气促|呼吸困难|晕厥|黑便|便血|呕血|肢体无力|剧烈头痛|高热|寒战|抽搐|意识障碍|自杀|轻生|自伤|他伤|心电图|血压|血氧|生命体征)|生命体征|T\s*\d|BP\s*\d|血压\s*\d|心率\s*\d|血氧\s*\d/i.test(redFlagScreenText);
  const redFlag = Math.min(1,
    (hasChief ? 0.28 : 0) +
    (hasContextDetail ? 0.22 : 0) +
    (hasExplicitRedFlagScreening ? 0.25 : 0) +
    (hasVitals ? 0.25 : 0),
  );
  const rawInfoGain = [hasChief, hasNarrativeDetail, hasTongue, hasPulse].filter(Boolean).length / 4;
  const infoGain = hasChief
    ? Math.max(0.3, hasNarrativeDetail ? rawInfoGain : Math.min(rawInfoGain, 0.5))
    : 0;
  const rawManagementImpact = [
    hasChief,
    hasTongue,
    hasPulse,
    hasContextDetail || hasVitals || hasPastOrMedicationContext,
  ].filter(Boolean).length / 4;
  const managementImpact = hasChief ? Math.max(0.3, rawManagementImpact) : 0;
  const rawAnswerability = [hasChief, hasTongue, hasPulse, hasNarrativeDetail].filter(Boolean).length / 4;
  const answerability = hasChief
    ? Math.max(0.3, hasNarrativeDetail ? rawAnswerability : Math.min(rawAnswerability, 0.5))
    : 0;
  // A real chief complaint is an analyzable but insufficient record, so it starts at B rather than
  // A. It still cannot reach C without an independent present-history/四诊 contribution and explicit
  // safety screening; copied chief-complaint text and normal defaults do not add those contributions.
  const scores = { redFlag: hasChief ? Math.max(0.3, redFlag) : redFlag, infoGain, managementImpact, answerability };
  return {
    ...scores,
    level: determineCompletenessLevel(scores),
  };
}

/** M03 uses the chief complaint as its only required clinical entry point. */
export function canProceedToM03AfterFollowup(state: CaseState): boolean {
  return isKnownClinicalText(state.chiefComplaint || fieldText(state, "zhushu"));
}

// 裸“没”是口语标准否定词（“没胸痛晕倒”），但大量固定搭配里它不是对后续症状词的否定
// （没胃口=纳差、没精神=乏力、没什么/没关系/没问题…），用负向前瞻排除这些搭配，避免制造漏报。
// 查体否定动词与 clinical-polarity 的 NEGATIVE_PREFIX 共用同一份闭集——同一判据只写一处
// （「全腹未触及压痛反跳痛」原判阳性反跳痛，见该文件里的实测记录）。
const NEGATION_PATTERN = new RegExp(`(${CLINICAL_EXAM_NEGATION_VERB_SOURCE}|否认|不是(?!${DEGREE_AFTER_NEGATOR})|并非(?!${DEGREE_AFTER_NEGATOR})|不曾|无|未见|未明显(?!好转|缓解|改善|减轻|变化|加重)|未发现|未诊断|未患|没有|没(?!有什么|关系|问题|事|错|完|意思|办法|时间|空|钱|人|影|底|数|辙|门|胃口|精神|力气|劲儿|劲|趣)|未诉|无诉|未主诉|未出现|未发生|未有|未曾|未再发|无再发|从未|从无|没有过|不伴|已缓解|已消失|排除)`, "g");
// 「有无/有没有/有否」是问句（unassessedMentionAt 判未评估），其中的「无」「没有」不是否认词（2026-10-25 第二十轮：「有无黑便不详」曾读成否认黑便）。
const NON_NEGATING_PHRASES = /(无明显诱因|无诱因|无缓解|无好转|无改善|没缓解|没好转|没改善|没消失|无规律|无特殊处理|未予处理|未治疗|有无|有没有|有否|无法(?!(?:完全|彻底|明确|轻易|简单)?(?:排除|除外|否认))|漫无目的|无精打采)/g;

function containsNegation(value: string): boolean {
  NEGATION_PATTERN.lastIndex = 0;
  const result = NEGATION_PATTERN.test(value);
  NEGATION_PATTERN.lastIndex = 0;
  return result;
}

type ClinicalAssertionSubject = "patient" | "non_patient";
type ClinicalAssertionMood = "actual" | "conditional" | "unassessed";
type ClinicalAssertionTemporality = "current" | "historical";

type ClinicalAssertionContext = {
  subject: ClinicalAssertionSubject;
  mood: ClinicalAssertionMood;
  temporality: ClinicalAssertionTemporality;
};

const PATIENT_SUBJECT_MARKER = /^(?:患者本人|患者|病人|患儿|本人|我)$/;
const CLINICAL_SUBJECT_MARKERS = /(?:我|其)?(?:父亲|母亲|爸爸|妈妈|爸|妈|父母|家属|家人|家里人|亲属|祖父|祖母|爷爷|奶奶|外祖父|外祖母|姥爷|姥姥|儿子|女儿|哥哥|姐姐|弟弟|妹妹|兄|姐|弟|妹|兄弟|姐妹|丈夫|妻子|配偶|岳父|岳母|岳父母|公公|婆婆|公婆|伯父|伯母|叔叔|婶婶|舅舅|舅妈|姑姑|姑父|姨妈|姨父|侄子|侄女|外甥|外甥女)|患者本人|患者|病人|患儿|本人|我/g;
const REPORTER_RELATIVE_SOURCE = "(?:家属|家人|亲属|儿子|女儿|妻子|丈夫|配偶|母亲|父亲|妈妈|爸爸|老伴|哥哥|弟弟|姐姐|妹妹|兄弟|姐妹)";
const REPORTER_RELATIVE_AT_END = new RegExp(`${REPORTER_RELATIVE_SOURCE}$`);

/**
 * 未评估的记载：病历在这一处既没说有、也没说无（2026-10-25 第二十轮，甲方 100 例 C093「是否黑便尚未询问」读成记录了黑便，
 * 模型写的「无黑便」被改成「有黑便」）。ConText 算法把一处记载的语境分成否定、假设/不确定、时间、主语几个维度，每个维度是
 *「触发词 + 方向 + 作用域（到小句边界为止）」；这里是其中「未评估」一维（Azure TA4H 叫 neutral_possible，i2b2 归 hypothetical）。
 *  · 前置触发：本小句里、被测词之前有问句或未问的说法——是否、有无、有没有、可有、未询问、未问及、未查、需询问、待核实……；
 *    「是否因受凉…」「是否与进食有关」问的是原因或关系，不是有无（伪触发）；「未查到/未查出」是查了没有，归否定。
 *  · 后置触发：被测词所在小句以未评估的状态收尾——尚未询问、未问、不详、不清楚、未知、待核实、待排……，中间只夹「情况、与否、有无」；
 *    夹着性质、部位、程度、原因、次数、具体这类属性名词时，不详的是属性，表现本身照有（「腹痛性质不详」「静脉滴注治疗（具体不详）」）。
 *  · 小句里或问句后紧跟着答了「有/是/阳性」的，按答案算（「是否黑便：有」）。
 * 此前同一类判据有两份各写各的：病历读法按整句判（同一句里任何地方出现「不详」，整句的表现都不算记录——B024 一类「伴恶心，……
 *（具体不详）」把「伴恶心」吞掉），闸门与否认核对则完全不认「是否/尚未询问」。现在只有这一处，经 clinicalAssertionContextAt 的
 * mood 落到所有消费方（闸门 hasTerm/hasNonNegatedClinicalPattern、病历读法、否认照录核对、OSA 筛查）。
 * 冻结令允许的确定性例外：有限闭集（触发词、属性名词）+ 构词式守卫（方向、小句作用域、伪触发、答句）。类夹具 unassessed-mention-not-recorded。
 */
const UNASSESSED_VERB = "(?:询问|问及|问到|追问|问|查(?![到出见及体])|检查(?![到出见及])|评估|记录|提及|采集|描述|说明)";
const UNASSESSED_STATUS_SOURCE = `(?:尚未|暂未|未曾|未|没有?)${UNASSESSED_VERB}|不详|未知|待(?:核实|确认|询问|追问|排除?|评估|查明)|无法(?:确定|判断|评估|回忆|描述)|未能(?:确认|明确)`;
// 「不清、不清楚、不明、说不清、记不清」本身常是症状名的一部分（神志不清、言语不清、构音不清、视物不清、吐字不清）：只在前面隔着
//「情况/与否/有无」或冒号、括号时才算未评估（「黑便情况不清楚」「黑便：说不清」）。2026-10-25 回放：裸用时神经系统红旗 15 例丢失。
const UNASSESSED_WEAK_STATUS_SOURCE = "不清楚?|不明|说不清|记不清";
const UNASSESSED_PRE_TRIGGER = new RegExp(
  `(?:是否|有无|有没有|有否|可有|是不是|(?:尚未|暂未|未曾|未|没有?|需要?|待|尚待)${UNASSESSED_VERB}(?:过)?(?:有无|是否|有没有)?)(?!因|由|与|和|跟|在|于|为|系|属|需|要|能|可以)`,
  "u",
);
const UNASSESSED_POST_TRIGGER = new RegExp(
  `(?:(?:的)?(?:情况|与否|之?有无|是否存在|是否出现|是否发生)?\\s*[：:（(]?\\s*(?:${UNASSESSED_STATUS_SOURCE})|(?:(?:的)?(?:情况|与否|之?有无|是否存在|是否出现|是否发生)\\s*[：:（(]?|\\s*[：:（(])\\s*(?:${UNASSESSED_WEAK_STATUS_SOURCE}))\\s*[）)]?\\s*$`,
  "u",
);
const UNASSESSED_ATTRIBUTE_NOUN = /性质|部位|程度|原因|病因|诱因|次数|频率|频次|时间|时长|[^大]量|颜色|色泽|具体|最高|范围|规律|特点|变化|治疗|用药|药物|药名|剂量|结果|数值|经过|名称|日期|年限|病程|来源/u;
const UNASSESSED_PSEUDO = /(?:不论|无论|不管)(?:是否|有无)/u;

/**
 * 问答体记录（「问：有没有发热或者呕吐 答：没有」「问：有没有恶心呕吐？答：偶尔会有」）：被测词落在问句里（「问：」之后、「答：」之前，
 * 同一个分号段内）时，问句的作用域跨过逗号到「答：」为止，有无由答句定——答句以有/是/偶尔会有起头为 positive，以没有/无/都没有起头为
 * negative，其余（答非所问、没答）为 unanswered。不在问句里返回 undefined。
 */
/** 问属性而不是问有无的词（「咳嗽厉害吗」「便秘多久了」「咳嗽频繁吗」）：问句默认这个表现是有的。 */
const ATTRIBUTE_QUESTION_WORD = /厉害|严重|频繁|多久|几天|几次|多少|什么|怎么|如何|明显|好转|加重|缓解|重不重|多不多|好不好|正常|规律|时候/u;
function questionAnswerPolarityAt(normalized: string, index: number): "positive" | "negative" | "unanswered" | undefined {
  const segmentStart = Math.max(...["；", ";", "。", "\n"].map((mark) => normalized.lastIndexOf(mark, index - 1))) + 1;
  const ends = ["；", ";", "。", "\n"].map((mark) => normalized.indexOf(mark, index)).filter((value) => value >= 0);
  const segment = normalized.slice(segmentStart, ends.length > 0 ? Math.min(...ends) : normalized.length);
  const at = index - segmentStart;
  const question = segment.slice(0, at).search(/问\s*[：:]/u);
  if (question < 0 || /答\s*[：:]/u.test(segment.slice(question, at))) return undefined;
  // 只认问有没有的问句：被测词前有「有没有/有无/是否/有」，或词后只隔「等情况/症状」就是「吗/么/没有/不」。
  // 问属性的（「便秘多久了」「咳嗽厉害吗」「咳嗽几天了」）默认这个表现是有的，不在这里处理。
  const questionText = segment.slice(question, at);
  const sinceLastBreak = questionText.slice(Math.max(questionText.lastIndexOf("？"), questionText.lastIndexOf("?")) + 1);
  const suffixQuestion = /^([\u4e00-\u9fff]{1,8}?)(?:等|这些|这种)?(?:情况|症状|表现|不适)?(?:吗|么|嘛|没有)/u.exec(segment.slice(at));
  const existenceQuestion = /(?:有没有|有无|是否|有否|可有|(?:^|[，,？?\s])有)/u.test(sinceLastBreak.replace(/^问\s*[：:]/u, " ")) ||
    (Boolean(suffixQuestion) && !ATTRIBUTE_QUESTION_WORD.test(suffixQuestion![1]));
  if (!existenceQuestion) return undefined;
  // 答句在本段，或问句以句号收尾、答句在下一段（「问：有腹痛吗。答：没有。」）。
  const following = normalized.slice(segmentStart + at).split(/问\s*[：:]/u)[0];
  const answer = /答\s*[：:]\s*([^；;。\n]*)/u.exec(following)?.[1]?.trim() || "";
  if (!answer) return "unanswered";
  if (/^(?:都|也|均|全|就是)?(?:没有|没|无|不|否|未)/u.test(answer)) return "negative";
  if (/^(?:就是|是的?|对|嗯)?[，,]?\s*(?:有|是|偶尔(?:会)?有|有时(?:会)?有|经常有|会有|一直有)/u.test(answer)) return "positive";
  return "unanswered";
}

function unassessedMentionAt(normalized: string, index: number): boolean {
  const answered = questionAnswerPolarityAt(normalized, index);
  if (answered) return answered !== "positive";
  const clauseStart = Math.max(...["，", ",", "。", "；", ";", "\n", "？", "?", "（", "(", "！", "!"].map((mark) => normalized.lastIndexOf(mark, index - 1))) + 1;
  const ends = ["，", ",", "。", "；", ";", "\n", "？", "?", "！", "!"].map((mark) => normalized.indexOf(mark, index)).filter((value) => value >= 0);
  const clauseEnd = ends.length > 0 ? Math.min(...ends) : normalized.length;
  const before = normalized.slice(clauseStart, index);
  const after = normalized.slice(index, clauseEnd);
  if (/[：:]\s*(?:有|是|阳性|＋|\+)/u.test(after) ||
      /^[？?]\s*(?:患者|家属|患儿)?(?:答|回答|诉|称)?[：:]?\s*(?:有|是|阳性)/u.test(normalized.slice(clauseEnd, clauseEnd + 10))) return false;
  if (UNASSESSED_PRE_TRIGGER.test(before) && !UNASSESSED_PSEUDO.test(before)) return true;
  const post = UNASSESSED_POST_TRIGGER.exec(after);
  return Boolean(post) && !UNASSESSED_ATTRIBUTE_NOUN.test(after.slice(0, post!.index));
}

function clinicalAssertionContextAt(text: string, index: number): ClinicalAssertionContext {
  const normalized = normalizeClinicalText(text);
  const hardStart = Math.max(
    normalized.lastIndexOf("。", index - 1),
    normalized.lastIndexOf(".", index - 1),
    normalized.lastIndexOf("；", index - 1),
    normalized.lastIndexOf(";", index - 1),
    normalized.lastIndexOf("\n", index - 1),
  ) + 1;
  const prefix = normalized.slice(hardStart, index);

  const conditionalMatches = [...prefix.matchAll(/(?:若|如果|一旦|倘若|假如|当(?=(?:患者|病人|患儿|本人|我|出现|发生|血压|血氧|体温|心率|脉搏|呼吸))|如(?=(?:出现|发生|再发|有)))(?=[^。；;\n]{0,40})/g)];
  const lastConditional = conditionalMatches.at(-1);
  let mood: ClinicalAssertionMood = "actual";
  if (lastConditional?.index != null) {
    const afterConditional = prefix.slice(lastConditional.index + lastConditional[0].length);
    const resetMatch = [...afterConditional.matchAll(/(?:(?:但|但是|然而|实际(?:上)?|事实上)[^。；;\n]{0,16}|[，,]\s*)(?:患者本人|患者|病人|患儿|本人|我)\s*/g)].at(-1);
    const resetTail = resetMatch?.index == null
      ? ""
      : afterConditional.slice(resetMatch.index + resetMatch[0].length);
    const lastComma = Math.max(afterConditional.lastIndexOf("，"), afterConditional.lastIndexOf(","));
    const assertionClauseEndCandidates = ["，", ",", "。", "；", ";", "\n"]
      .map((marker) => normalized.indexOf(marker, index))
      .filter((value) => value >= 0);
    const assertionClauseEnd = assertionClauseEndCandidates.length > 0
      ? Math.min(...assertionClauseEndCandidates)
      : normalized.length;
    const assertionClause = normalized.slice(index, assertionClauseEnd);
    const commaDelimitedClause = lastComma >= 0
      ? `${afterConditional.slice(lastComma + 1)}${assertionClause}`
      : "";
    const explicitCurrentReset = /(?:(?:但|但是|然而|实际(?:上)?|事实上)[^。；;\n]{0,16}|[，,]\s*)(?:患者本人|患者|病人|患儿|本人|我)?\s*(?:本次|目前|当前|现在|今日|今天|今晨|现(?:已|在)?|确有|已出现|已经|正在|仍(?:在|有)?|刚刚|突然|突发)/.test(afterConditional)
      || Boolean(commaDelimitedClause) && /(?:本次|目前|当前|现在|今日|今天|今晨|现(?:已|在)?|确有|已出现|已经|正在|仍(?:在|有)?|刚刚|突然|突发|持续\s*\d)/.test(commaDelimitedClause);
    const modalOrFutureTail = /(?:会|将|可能|也许|或许|预计|计划|打算|拟|假如|若|如果|一旦|时则|时会|就会)/.test(`${resetTail} ${commaDelimitedClause}`);
    const independentPatientReset = Boolean(resetMatch) && !modalOrFutureTail;
    const resetToCurrentPatient = explicitCurrentReset && !modalOrFutureTail || independentPatientReset;
    if (!resetToCurrentPatient) mood = "conditional";
  }
  const assertionEndCandidates = ["。", "；", ";", "\n"]
    .map((marker) => normalized.indexOf(marker, index))
    .filter((value) => value >= 0);
  const assertionEnd = assertionEndCandidates.length > 0 ? Math.min(...assertionEndCandidates) : normalized.length;
  const assertionTail = normalized.slice(index, assertionEnd);
  if (/^[^，,。；;\n]{0,28}时\s*(?:应|需|要|则|会|可|请|立即|建议)/.test(assertionTail)) {
    mood = "conditional";
  }
  // "如胸痛加重，应立即急诊" is prospective safety-net language even though "如" is
  // followed by the symptom rather than by "出现". Inspect the full hard clause (the prefix alone
  // ends immediately before the symptom) and suppress only symptom occurrences before the advice
  // verb. A later explicit current statement in the same clause therefore remains an actual finding.
  const hardAssertion = normalized.slice(hardStart, assertionEnd);
  for (const match of hardAssertion.matchAll(/如[^。；;\n]{0,32}(?:加重|恶化)[^。；;\n]{0,32}(?:应|需|请|建议|立即|及时|马上|就医|转诊|急诊)/g)) {
    const adviceOffset = match[0].search(/(?:应|需|请|建议|立即|及时|马上|就医|转诊|急诊)/);
    const conditionalStart = hardStart + (match.index ?? 0);
    const adviceStart = adviceOffset < 0 ? conditionalStart + match[0].length : conditionalStart + adviceOffset;
    if (index >= conditionalStart && index < adviceStart) mood = "conditional";
  }
  if (mood === "actual" && unassessedMentionAt(normalized, index)) mood = "unassessed";

  let subject: ClinicalAssertionSubject = /家族史\s*[:：]?/.test(prefix) ? "non_patient" : "patient";
  const clauseStart = Math.max(
    hardStart,
    normalized.lastIndexOf("，", index - 1) + 1,
    normalized.lastIndexOf(",", index - 1) + 1,
  );
  const clauseEndCandidates = ["，", ",", "。", ".", "；", ";", "\n"]
    .map((marker) => normalized.indexOf(marker, index))
    .filter((value) => value >= 0);
  const clauseEnd = clauseEndCandidates.length > 0 ? Math.min(...clauseEndCandidates) : normalized.length;
  const clause = normalized.slice(clauseStart, clauseEnd);
  const assertionOffset = index - clauseStart;
  let nearestDistance = Number.POSITIVE_INFINITY;
  CLINICAL_SUBJECT_MARKERS.lastIndex = 0;
  for (const match of clause.matchAll(CLINICAL_SUBJECT_MARKERS)) {
    const markerStart = match.index ?? 0;
    const markerEnd = markerStart + match[0].length;
    // 介词「与/跟/同/和」后面的亲属是同伴、不是主语（2026-10-18，构词式守卫）：「与丈夫发生争吵时突然出现剧烈头痛」
    // 头痛的是患者，此前按最近的亲属词判成「非患者」，蛛网膜下腔出血的典型诱因描述因此零红旗（验收集 A-eme-0089）。
    if (!PATIENT_SUBJECT_MARKER.test(match[0]) && /[与跟同和]$/u.test(clause.slice(0, markerStart))) continue;
    const distance = markerEnd <= assertionOffset
      ? assertionOffset - markerEnd
      : markerStart >= assertionOffset
        ? markerStart - assertionOffset
        : 0;
    if (distance <= nearestDistance) {
      nearestDistance = distance;
      const relativeSelfMarker =
        match[0] === "本人" &&
        REPORTER_RELATIVE_AT_END.test(clause.slice(Math.max(0, markerStart - 8), markerStart));
      subject = PATIENT_SUBJECT_MARKER.test(match[0]) && !relativeSelfMarker ? "patient" : "non_patient";
    }
  }
  CLINICAL_SUBJECT_MARKERS.lastIndex = 0;
  const reporterPrefix = normalized.slice(hardStart, index);
  if (
    new RegExp(`${REPORTER_RELATIVE_SOURCE}\\s*(?:代诉|诉|说|称|反映|报告|告知|提供病史)\\s*[：:]?[^。；;\\n]*$`).test(reporterPrefix) &&
    !new RegExp(`${REPORTER_RELATIVE_SOURCE}\\s*(?:本人|自己|有|出现|发生|突发|患有)`).test(reporterPrefix)
  ) {
    subject = "patient";
  }

  const temporalScope = clinicalEventTemporalScopeAt(normalized, index);
  const temporality: ClinicalAssertionTemporality = temporalScope === "current" ? "current" : "historical";

  return { subject, mood, temporality };
}

function isExcludedClinicalAssertionAt(text: string, index: number): boolean {
  const context = clinicalAssertionContextAt(text, index);
  return context.subject === "non_patient" || context.mood !== "actual";
}

/**
 * 原文某位置的提及能不能当作患者本人、此刻、肯定存在的事实（2026-10-26 第二十一轮）。
 * 引文对齐（source-quote-alignment.ts）把模型引文换成病历原文片段之前用它守住语境：
 * 「是否黑便尚未询问」里的黑便是 excluded，「无呕血」里的呕血是 negated。与安全门同一套 ConText 判据。
 */
export function recordMentionPolarityAt(text: string, index: number): "affirmed" | "negated" | "excluded" {
  const normalized = normalizeClinicalText(text);
  if (isExcludedClinicalAssertionAt(normalized, index)) return "excluded";
  if (isNegatedAt(normalized, index)) return "negated";
  return "affirmed";
}

/**
 * 只看提及所在的那个逗号分句的读法（第二十一轮）：给「只加风险」的读法用——指南判别项读病历、过敏档案。
 * 安全门自己的否认串（「无腹痛，发热，呕吐」逐项否认）会越过逗号，把「一天没怎么尿，身上皮肤发花」里的皮肤发花、
 *「否认药物过敏，鸡蛋过敏」里的鸡蛋也读成否认；这两个读法若照用，会把真阳性丢掉。分句内的否认、未问及、他人照旧排除。
 */
export function clauseLocalMentionPolarityAt(text: string, index: number): "affirmed" | "negated" | "excluded" {
  let start = index;
  while (start > 0 && !/[，,。；;\n]/u.test(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !/[，,。；;\n]/u.test(text[end])) end += 1;
  return recordMentionPolarityAt(text.slice(start, end), index - start);
}

function hasPatientScopedSpanOccurrence(text: string, span: string): boolean {
  let offset = text.indexOf(span);
  while (offset >= 0) {
    const assertionIndex = offset + Math.max(0, span.length - 1);
    if (!isExcludedClinicalAssertionAt(text, assertionIndex)) return true;
    offset = text.indexOf(span, offset + span.length);
  }
  return false;
}

/**
 * 「纯强度/时相修饰段」：共享否定枚举里，顿号与被测词之间只剩这些修饰词时，说明该段仍是
 * **同一个枚举项的组成部分**（"否认呕血、黑便、持续剧烈腹痛" 里 、 后的「持续」是
 * 「持续剧烈腹痛」自己的定语），而不是新起的阳性从句。
 *
 * 这是一个类缺陷的根修：红旗词表里大量条目本身以强度词开头/含强度词（持续剧烈腹痛、
 * 突发最剧烈头痛、急性胸痛…），而下面两个启发式恰恰把这些强度词当作「阳性从句起点」
 * 与「阳性证据」——共享否定作用域在枚举第 3 项之后被切断，整句否认被判成急症阳性
 * （甲方生产实测："否认呕血、黑便、持续剧烈腹痛、发热及明显消瘦" 直接弹急诊转诊页）。
 * 修饰词自身不携带极性；极性只能来自动词性内容或明确的转折/新起词。
 */
const INTENSITY_MODIFIER_ONLY_SEGMENT = /^(?:持续|突发|突然|急性|反复|阵发性?|间断|间歇性?|明显|大量|少量|剧烈|进行性|快速|逐渐|新发|再发|复发|严重|轻微|最)*$/;

/**
 * 否认词跨逗号延续到后面的裸词（「否认胸痛，胸闷，气促」）是这套判据的既有设计；可是同一句的逗号列举里只要有一项带着自己的肯定证据，
 * 这一串就不是否认列举，而是否认一项之后接着写的阳性表现（2026-10-25 第十九轮，网上基层病历 A056 引出的整类排查）：
 *「无咳嗽，胸痛，伴大汗」「无头痛，言语不清，右侧肢体无力」「无恶心，黑便3次」「无咳嗽，乏力，胸痛，大汗淋漓」此前红旗全丢——
 * 去掉开头那句无关的否认，同一句都是红旗。冻结令允许的确定性例外：有限闭集（数量/次数、起首的「伴/有/偶有/出现…」、程度/时相/起病词、
 * 侧别）+ 构词式守卫（以否认词起首的项本身是否认，跳过；有「均无/均否认」这类集体后置否认时整串仍是否认）。只会把「否认」改成「未否认」，
 * 闸门方向只增不减。类夹具 scripts/fixtures/open-language-classes/denial-run-broken-by-positive-item.json。
 * afterTermScope 为 "clause"（病历读法）时只看被测词自己那一小句。
 */
/**
 * 否认列举到这一项为止：频度起首的项（「经常腹泻」「时有心慌」）在说有；正常所见（「纳可」「眠可」「二便调」「月经正常」）是另起的
 * 系统回顾，不在否认词之下（2026-10-25 第二十轮，基层病例 A039「无口干口苦、纳可、眠可、经常腹泻」把经常腹泻读成否认）。
 * 逗号列举（DENIAL_RUN_POSITIVE_ITEM）与顿号列举（isNegatedAt 的顿号分支）共用。顿号列举不用强度/时相词断开：
 *「否认呕血、黑便、持续剧烈腹痛」里的「持续剧烈」是被否认那一项自己的定语（INTENSITY_MODIFIER_ONLY_SEGMENT）。
 */
const FREQUENCY_LEAD_SOURCE = "^(?:经常|常常|时常|偶尔|偶有|时有|常有|每日|每天|每晚|一直|总是)";
const NORMAL_FINDING_ITEM = /(?:可|调|正常|尚可|佳|如常)$/u;
// 正常所见只在否认词与被测词之间才截断（「无口干口苦、纳可、眠可、经常腹泻」）；在被测词之后（「无发热，胸闷，胸痛，纳可，眠可」）
// 说明不了前面那几项是有是无，不截断（回放 corpus-986/13174）。频度起首的项在哪里都算（与「偶有/时有」同类，见 DENIAL_RUN_POSITIVE_ITEM）。
const ENUMERATION_RUN_BREAK_ITEM = new RegExp(`${FREQUENCY_LEAD_SOURCE}|${NORMAL_FINDING_ITEM.source}`, "u");
const DENIAL_RUN_POSITIVE_ITEM = new RegExp([
  "\\d+(?:\\.\\d+)?\\s*(?:次|天|日|周|月|年|小时|分钟|ml|mL|毫升|斤|kg|公斤)",
  "[一二两三四五六七八九十数几多]次",
  "^(?:伴有?|有|见|偶有|时有|常有|出现|自觉|并有)",
  "(?:明显|剧烈|频作|频发|加重|严重|持续|阵发|反复|大量|不止|淋漓|难忍|如注|突发|突然|骤然|新发|再发|复发|今日|今晨|今早|今天|昨日|昨晚|昨夜|近日|刚刚|刚才)",
  "(?:左侧|右侧|双侧|一侧|单侧|半身|偏身)",
  // 2026-10-25 第二十轮：频度起首（「经常腹泻」）——见 ENUMERATION_RUN_BREAK_ITEM；正常所见只看被测词之前（denialRunBrokenByPositiveItem）。
  FREQUENCY_LEAD_SOURCE,
].join("|"), "u");
const DENIAL_RUN_ITEM_NEGATED = /^(?:否认|无|未见|未诉|未出现|没有|不伴|并无|尚无|暂无)/u;
const DENIAL_RUN_COLLECTIVE_NEGATION = /(?:均无|均否认|均未|皆无|皆否认|都没有|都无)/u;
function denialRunBrokenByPositiveItem(afterNegation: string, text: string, index: number, scope: "window" | "clause"): boolean {
  const sentenceRest = text.slice(index).split(/[。；;\n]/u)[0];
  const termClause = `${afterNegation.slice(Math.max(afterNegation.lastIndexOf("，"), afterNegation.lastIndexOf(",")) + 1)}${sentenceRest.split(/[，,]/u)[0]}`;
  const items = scope === "clause"
    ? [termClause]
    : [...afterNegation.split(/[，,]/u).slice(1, -1), termClause, ...sentenceRest.split(/[，,]/u).slice(1)];
  if (items.some((item) => DENIAL_RUN_COLLECTIVE_NEGATION.test(item))) return false;
  // 否认词与被测词之间的项两种范围都看（clause 范围只是不借被测词之后小句的修饰词）。
  const between = afterNegation.split(/[，,]/u).slice(1, -1);
  if (between.some((item) => NORMAL_FINDING_ITEM.test(item.trim()) && !DENIAL_RUN_ITEM_NEGATED.test(item.trim()))) return true;
  return items.some((item) => {
    const trimmed = item.trim();
    return Boolean(trimmed) && !DENIAL_RUN_ITEM_NEGATED.test(trimmed) && DENIAL_RUN_POSITIVE_ITEM.test(trimmed);
  });
}

/**
 * afterTermScope：被测词之后找程度/时间修饰时看多远。安全闸门用缺省的 "window"（词后 24 字，可越过逗号进下一小句——宁可多判阳性）；
 * 病历读法（recordedFindingReading）另用 "clause" 再判一次，只看被测词所在的这一小句：两种范围给出不同结论的那一处，
 * 是「越过逗号借来的修饰词」决定的阳性，读法记为不明确（2026-10-25，A056「无腹痛，发热，呕吐，于乡卫生院输液治疗两天无效，
 * 并有加重趋势」：「加重」说的是腹泻，却让发热、呕吐都成了阳性，再与后文「无呕吐」叠出「有呕吐；否认呕吐」）。
 */
function isNegatedAt(text: string, index: number, afterTermScope: "window" | "clause" = "window"): boolean {
  const hardStart = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
  ) + 1;
  const before = text.slice(Math.max(hardStart, index - 40), index).replace(NON_NEGATING_PHRASES, "");
  const matches = Array.from(before.matchAll(NEGATION_PATTERN));
  if (matches.length === 0) return false;

  const last = matches[matches.length - 1];
  const lastNegationEnd = (last.index ?? 0) + last[0].length;
  if (last[0] === "排除" || last[0] === "否认" || last[0] === "除外") {
    // 「无法排除呕血」「不能完全否认呕血」「尚未除外出血」：情态 + 否定动词 = 排除不了 = 可能有。
    // 此前只给「排除」装了这道守卫，「否认」没有，于是「无法完全否认呕血」把呕血红旗抹掉
    // （2026-09-08 用真函数复现）。clinical-polarity 的 NON_NEGATING_WU_MODAL 是同一判据；情态词是
    // 封闭语法类，枚举安全。允许情态词与否定动词之间夹一个程度副词（完全/彻底/明确）。
    const beforeNegation = before.slice(Math.max(0, (last.index ?? 0) - 10), last.index ?? 0);
    if (/(无法|不能|不可|尚未|未能|难以|需|待|仍需)(?:完全|彻底|明确|轻易|简单)?$/.test(beforeNegation)) return false;
  }
  const afterNegation = before.slice(lastNegationEnd);
  if (/(但|但是|然而|不过|却|但有|另有|仍有|转为|改为)/.test(afterNegation) ||
      /[，,](?:昨|今|近(?:日|天|两|几|\d)|本次|此次|当前|目前|现在|活动后|运动后|劳累后|持续|新发|突发|突然|出现|伴有|继而|随后|开始)/.test(afterNegation)) {
    return false;
  }
  const commaIndex = Math.max(afterNegation.lastIndexOf("，"), afterNegation.lastIndexOf(","));
  if (commaIndex >= 0) {
    const afterComma = afterNegation.slice(commaIndex + 1);
    const beforeComma = afterNegation.slice(0, commaIndex);
    const explicitNegativeContinuation = new RegExp(`^(?:也|亦|并|且|均|都)?\\s*(?:否认|不是(?!${DEGREE_AFTER_NEGATOR})|并非(?!${DEGREE_AFTER_NEGATOR})|不曾|无|未见|没有|未诉|未出现|未发生|不伴)`).test(afterComma.trim());
    if (!explicitNegativeContinuation && denialRunBrokenByPositiveItem(afterNegation, text, index, afterTermScope)) return false;
    const explicitPositiveClause = /^(?:突发|出现|再发|复发|伴|伴有|持续|加重|发作|本次|当前|目前|现在|现|诉|呈|排出|排)/.test(afterComma.trim())
      // 否认列举的延续项是**裸词**（「否认胸痛，胸闷，气促」）。一旦从句里出现了
      // 诱发/发作/加重这类动词，它描述的就是一个已经发生的阳性事件，不是继续在否认。
      // 判据取动词而不是穷举诱因词：诱因的说法无穷（登楼/爬坡/搬重物/情绪激动/餐后/夜间…），
      // 穷举必漏。实测漏检的是「否认糖尿病，登楼时诱发胸痛，今日新发」——劳力性心绞痛，
      // 恰恰是最不能漏的那一类；而去掉那句无关的既往史否认后同一主诉正常出红旗。
      // 「未出现/未发作」这类否定延续由上面的 explicitNegativeContinuation 先行拦住。
      || /(?:诱发|引发|激发|加剧|发作|出现)/.test(afterComma);
    // Ordinary commas may continue a compact denial list ("否认胸痛，胸闷，气促"). A prior
    // enumeration comma, however, closes that list before the comma ("否认胸痛、气促，晕厥").
    // Concrete actions/counts are handled as positive evidence by hasCommaSeparatedPositiveEvidence.
    if (!explicitNegativeContinuation && (beforeComma.includes("、") || explicitPositiveClause)) return false;
    // 逗号紧邻被测词时(afterComma 为空),需要看**词之后**才能判断这是否认列举还是新的阳性陈述。
    //
    // 甲方生产实测:病历写「无高热，头痛明显，咳嗽不重」,系统输出「病历已记录否认头痛、发热」
    // ——把白纸黑字的主症说成否认,还写进了病名鉴别的 distinguishingPoints,一份输出里出现 5–6 次。
    // 原因是「无」的作用域越过逗号蔓延到了后面的独立陈述。
    //
    // 但不能一律按逗号断:「否认胸痛，胸闷，气促」是紧凑否认列举,逗号确实在延续否定。
    // 两者的区别不在逗号**前**(都是完整的否定对象),而在被测词**后**:
    //   · 「头痛明显」「心悸频作」「腹痛剧烈」—— 词后跟程度/频次修饰,是阳性断言;
    //   · 「胸闷」「气促」—— 裸词,是否认列举的延续项。
    // 因此只在「否定对象已完整 + 词后带阳性修饰」时终止作用域,不影响裸词列举。
    if (!explicitNegativeContinuation && afterComma.trim().length === 0 && beforeComma.trim().length > 0) {
      const afterTermWindow = text.slice(index, index + 24).replace(/^[^一-龥]*/, "");
      const afterTerm = afterTermScope === "clause" ? afterTermWindow.split(/[，,。；;\n]/u)[0] : afterTermWindow;
      // 跳过被测词本身:词长未知,故取词后 24 字里首个出现的修饰词位置作判据。
      //
      // 判据分两组，都表示「这是一句阳性断言，不是否认列举的延续项」：
      //  ① 程度/频次修饰（原有）——「头痛明显」「心悸频作」。
      //  ② 起病时间限定（2026-08-09 补）——「胸痛今日新发」「气促昨夜突发」。
      //     缺 ② 的实测后果：「否认糖尿病，胸痛今日新发」**零红旗**，而去掉那句无关的
      //     「否认糖尿病」后同一主诉正常出红旗——一句与胸痛毫不相干的既往史否认，
      //     跨过逗号把今日新发的胸痛吃掉了。语序换成「否认糖尿病，今日新发胸痛」则正常，
      //     因为那条路径由上面第 1723 行的「逗号后紧跟时间词」分支拦住了；
      //     症状在前、时间限定在后的写法没有任何分支接住。两种写法在门诊都很常见。
      if (/(?:明显|剧烈|频作|频发|加重|严重|持续|阵发|反复|大量|为主|突出|尤甚|不重|不剧|较轻|轻微)/.test(afterTerm)
        || /(?:今日|今晨|今早|今天|昨日|昨晚|昨夜|近日|本次|此次|刚刚|刚才|方才)/.test(afterTerm)
        || /(?:新发|突发|突然|骤然|再发|复发|首次发作)/.test(afterTerm)) {
        return false;
      }
    }
  }
  const enumerationIndex = afterNegation.lastIndexOf("、");
  if (enumerationIndex >= 0) {
    const afterEnumeration = afterNegation.slice(enumerationIndex + 1).trim();
    // 顿号列举里出现正常所见或频度起首的一项，否认到它之前为止（ENUMERATION_RUN_BREAK_ITEM）。
    if (afterNegation.split("、").slice(1).some((item) => ENUMERATION_RUN_BREAK_ITEM.test(item.trim()) && !DENIAL_RUN_ITEM_NEGATED.test(item.trim()))) return false;
    // afterNegation 止于被测词起点：顿号之后若只剩纯修饰段，它是被测词自己的定语，
    // 共享否定继续生效，不得按「新阳性从句」否决。
    if (!INTENSITY_MODIFIER_ONLY_SEGMENT.test(afterEnumeration) &&
        /^(?:但|但有|却|另有|出现|发生|伴|伴有|合并|继而|随后|再发|复发|新发|突发|突然|持续|加重)/.test(afterEnumeration)) return false;
  }

  return before.length - lastNegationEnd <= 42;
}

function hasCommaSeparatedPositiveEvidence(text: string, index: number, term: string): boolean {
  const hardClauseStart = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
  ) + 1;
  const beforeTerm = text.slice(hardClauseStart, index);
  const lastComma = Math.max(beforeTerm.lastIndexOf("，"), beforeTerm.lastIndexOf(","), beforeTerm.lastIndexOf("、"));
  if (lastComma < 0) return false;
  const beforeComma = beforeTerm.slice(0, lastComma);
  const afterComma = beforeTerm.slice(lastComma + 1);
  const after = text.slice(index + term.length, index + term.length + 44);
  if (!containsNegation(beforeComma) || containsNegation(afterComma)) return false;
  const separator = beforeTerm[lastComma];
  if (separator === "、") {
    // 顿号 + 纯修饰段 = 同一枚举项的定语（"…、持续[剧烈腹痛]"），仍在共享否定作用域内；
    // 该段不构成阳性证据，且不得再落入下方「词面含强度词即阳性」的判定。
    if (INTENSITY_MODIFIER_ONLY_SEGMENT.test(afterComma.trim())) return false;
    if (!/^(?:但|但有|却|另有|出现|发生|伴|伴有|合并|继而|随后|再发|复发|新发|突发|突然|持续|加重)/.test(afterComma.trim())) {
      return false;
    }
  }
  if (/^(?:(?:一|二|两|三|四|五|六|七|八|九|十|数|多|几)?次\s*)?(?:也|均|都)?\s*(?:并|且)?\s*(?:未|没有|无|未见|未出现|未发生|并未|且未|也未|也没有)/.test(after)) return false;
  return /(?:突发|剧烈|急性|持续|加重|快速加重)/.test(term) ||
    /(?:伴有?|合并|继而|随后)[^，,。；;\n]+/.test(term) ||
    /^(?:排出?|出现|发生|伴|伴有|合并|再发|复发|突发|突然|新发|今(?:日|晨)|昨(?:日|晚|夜)|持续|加重)/.test(afterComma.trim()) ||
    /(?:伴有?|并|且|继而|随后)[^，,。；;\n]*$/.test(afterComma.trim()) ||
    // 逗号后的小句以「有/偶有/时有/见」直接引出该症状（「无汗出，偶有胸痛」「无头痛，有胸痛」）：是新起的肯定小句（2026-10-19 Claude 评审 M 集
    // MTCMB-14：鉴别里「无胸痛」与病历「偶有胸痛」相抵却没被改正，交付成「未诉胸痛」）。构词式：小句里只有这一个动词、本身不带否定。
    /^(?:偶尔?|时|常|尚|仍|另|间或|间断|反复)?(?:有|见|感|觉)$/.test(afterComma.trim()) ||
    /^(?:约|已|持续|反复)?\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半数多几]+)\s*(?:次|分钟|分|小时|天|日|周|月|ml|mL|毫升)/.test(after) ||
    /^(?:后|伴有?|并|且|持续|反复|加重|发作|导致|致|继而|随后)/.test(after);
}

/**
 * 症状词**之后**的否定（后缀否定）：「黑便无」「呕血阴性」「呕血（-）」「黑便、呕血、便血均无」
 * 「呕血一次也没有」「晕厥并未发生」。此前这套判据只写在 hasTerm 里；hasGiBleedPrioritySignal 与
 * hasAbdominalPrioritySignal 只用前置否定 isNegatedAt 判定，于是「呕血阴性」「呕血（-）」「呕血并未出现」
 * 在提示档/优先评估档被当阳性（2026-09-08 用真函数复现），而同一句在红旗档（hasTerm）却被正确判否。
 * 同一判据两处各写各的——现在只在这里写一份，三个调用方共用。
 */
function isPostfixNegatedAt(text: string, index: number, termLength: number): boolean {
  const after = text.slice(index + termLength, index + termLength + 44);
  const postPersistentCue = /^(?:、|，|,|及|和|与|或)?[^。；;\n]{0,18}(?:没有|无|未见|未|尚未|并未).{0,8}(?:缓解|好转|改善)/.test(after);
  // 只有“均/皆/都”这类量化词才合法地回指前面的症状列表（“黑便、呕血、便血均无”），才允许较宽间隔。
  const postCollectiveNegated = /^(?:、|，|,|及|和|与|或)?[^。；;\n]{0,18}(?:均无|均未见|均否认|皆无|皆未见|皆否认|都无|都未见|都没有)/.test(after);
  // 顿号并列清单后接裸否定（“黑便、呕血、便血无”）：仅当间隔全为顿号并列项、不含逗号/数字时才算集合否定。
  const postListNegated = /^、[^。；;，,\d\n]{0,16}(?:无|未见|没有|否认|阴性)/.test(after);
  // 裸“无/否认/未见/已缓解”只有紧贴症状词时才是对它本身的否定（“黑便无”“黑便：否认”“黑便已缓解”）。
  // fail-closed 关键修复：不得跨过逗号/数字进入下一分句——“黑便3天，无腹痛”里的“无”否定的是腹痛，
  // 绝不能因此把作为红旗的“黑便”判为阴性而漏报消化道出血（其余晕厥/便血/呕血/肢体无力/寒战同理）。
  // 「呕血（-）」「黑便(-)」是系统回顾/查体里的标准阴性记法，与「阴性」同义（2026-09-08 实测漏判）。
  const postDirectNegated = /^(?:[：:（(【\[\s]{0,4}(?:无|未见|没有|否认|阴性|未再发|无再发|已缓解|已消失)|\s*[（(]\s*[-−－—]\s*[)）])/.test(after);
  const postExplicitNegated = /^(?:(?:一|二|两|三|四|五|六|七|八|九|十|数|多|几)?次\s*)?(?:也|均|都)?\s*(?:并|且)?\s*(?:未|没有|无|未见|未出现|未发生|并未|且未|也未|也没有)(?:出现|发生|发作|再发|过)?/.test(after);
  return !postPersistentCue && (postCollectiveNegated || postListNegated || postDirectNegated || postExplicitNegated);
}

function hasTerm(text: string, term: string): boolean {
  let index = text.indexOf(term);
  while (index !== -1) {
    if (isExcludedClinicalAssertionAt(text, index)) {
      index = text.indexOf(term, index + term.length);
      continue;
    }
    const postNegated = isPostfixNegatedAt(text, index, term.length);
    const historicalResolved = isHistoricalOrResolvedAt(text, index, term.length);
    const anaphoricRecurrence = hasAnaphoricRecurrenceAfter(text, index, term);
    // A comma normally continues an explicit negative symptom list. It becomes a positive boundary
    // only when the new entity carries its own action cue ("排黑色便") or a concrete duration/count
    // ("呕血1次", "便血2日"). This preserves sensitivity without turning routine comma-separated
    // denials into a wall of false red flags.
    const commaSeparatedTimedPositive = hasCommaSeparatedPositiveEvidence(text, index, term);
    if (((!isNegatedAt(text, index) || commaSeparatedTimedPositive) && !postNegated && !historicalResolved) || anaphoricRecurrence) return true;
    index = text.indexOf(term, index + term.length);
  }
  return false;
}

function hasAnaphoricRecurrenceAfter(text: string, index: number, term: string): boolean {
  const before = text.slice(Math.max(0, index - 18), index);
  const after = text.slice(index + term.length, index + term.length + 80);
  if (!/(既往|曾经|曾有|曾|此前|过去|上次)/.test(before)) return false;
  return /(?:已缓解|已消失|已好转|治疗后好转|无再发|未再发)[^。；;\n]{0,24}[、，,；;]?\s*(?:本次|当前|目前|现在|今日|今天)?\s*(?:再次|再度|又)?(?:再发|复发|发作|出现)(?![^。；;\n]{0,8}(?:未|无|否认))/.test(after);
}

type ClinicalAssertionSpan = {
  start: number;
  end: number;
  text: string;
};

function clinicalAssertionSpanAt(text: string, index: number): ClinicalAssertionSpan {
  const start = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
  ) + 1;
  const endCandidates = ["。", "；", ";", "\n"]
    .map((mark) => text.indexOf(mark, index))
    .filter((position) => position >= 0);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : text.length;
  return { start, end, text: text.slice(start, end) };
}

function hasAffirmedPatternInSpan(text: string, span: ClinicalAssertionSpan, pattern: RegExp): boolean {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  for (const match of span.text.matchAll(new RegExp(pattern.source, flags))) {
    const index = span.start + (match.index ?? 0);
    const context = clinicalAssertionContextAt(text, index);
    if (context.subject !== "patient" || context.mood !== "actual" || context.temporality !== "current") continue;
    if (!isNegatedAt(text, index) && !isHistoricalOrResolvedAt(text, index, match[0].length)) return true;
  }
  return false;
}

function hasAnaphylacticAirwayEmergency(text: string): boolean {
  const normalized = normalizeClinicalText(text);
  const upperAirwayEdema = /(?:喉头|咽喉|喉咙|声门|舌|口唇)[^，,。；;\n]{0,8}(?:水肿|肿胀|肿起|发肿)/g;
  for (const edema of normalized.matchAll(upperAirwayEdema)) {
    const index = edema.index ?? -1;
    if (index < 0) continue;
    const span = clinicalAssertionSpanAt(normalized, index);
    if (!hasAffirmedPatternInSpan(normalized, span, upperAirwayEdema)) continue;

    const afterEdema = normalized.slice(index + edema[0].length, span.end);
    if (/^(?:[^，,]{0,16})?(?:(?:现已|目前已|已经|已)(?:消退|消肿|缓解|消失|恢复)|治疗后(?:消退|消肿|缓解|消失|恢复))/.test(afterEdema)) continue;

    const exposure = hasAffirmedPatternInSpan(
      normalized,
      span,
      /(?:进食|食用|吃(?:了)?|服用|口服|注射|输注|接触)[^，,。；;\n]{0,18}(?:后|之后|随即|即刻)|(?:过敏|暴露)[^，,。；;\n]{0,10}(?:后|导致|引起)/,
    );
    const rapid = hasAffirmedPatternInSpan(
      normalized,
      span,
      /(?:迅速|快速|突然|突发|即刻|随即|很快|数分钟内|短时间内)/,
    );
    const airwayDysfunction = [
      /(?:声音嘶哑|声嘶|发声困难|说话困难)/,
      /(?:吞咽困难|不能吞咽|吞不下)/,
      /(?:呼吸困难|喘憋|喉鸣|喘鸣|吸气困难)/,
      /(?:咽喉|喉头|喉咙)[^，,。；;\n]{0,8}(?:发紧|紧缩|堵塞感)/,
    ].filter((pattern) => hasAffirmedPatternInSpan(normalized, span, pattern)).length;

    // Current upper-airway edema is itself dangerous; exposure, rapid onset, or a concurrent
    // airway-function change establishes that the finding belongs to the active reaction episode.
    if (exposure || rapid || airwayDysfunction > 0) return true;
  }
  // Some patients describe upper-airway compromise as obstruction/tightness rather than visible
  // swelling. Require the full episode signature (recent exposure + allergic manifestation +
  // airway/breathing/circulation involvement) so this remains a high-specificity catastrophe floor.
  const recentExposure = hasPatternWithoutNegation(
    normalized,
    /(?:进食|食用|吃(?:了)?|服用|口服|注射|输注|接触)[^。；;\n]{0,24}(?:后|之后|随即|即刻)/,
  );
  const allergicManifestation = hasPatternWithoutNegation(
    normalized,
    /(?:全身)?(?:荨麻疹|风团|皮疹)|(?:口唇|眼睑|面部|舌)(?:肿|肿胀)|过敏反应/,
  );
  const airwayBreathingCirculation = hasPatternWithoutNegation(
    normalized,
    /(?:喉头|咽喉|喉咙)[^。；;\n]{0,10}(?:阻塞感|堵塞感|发紧|紧缩)|呼吸困难|喘憋|喉鸣|声音嘶哑|晕厥|意识淡漠/,
  ) || ((parseContextualSpo2(normalized) ?? 100) <= 91) || bloodPressureIsCritical(parseContextualBloodPressure(normalized));
  if (recentExposure && allergicManifestation && airwayBreathingCirculation) return true;
  return false;
}

function hasAnyTerm(text: string, terms: string[]): boolean {
  return terms.some((term) => hasTerm(text, term));
}

function hasPatternWithoutNegation(text: string, pattern: RegExp): boolean {
  const source = pattern.source;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(source, flags);
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    if (isExcludedClinicalAssertionAt(text, index)) continue;
    if ((!isNegatedAt(text, index) || hasCommaSeparatedPositiveEvidence(text, index, match[0])) &&
        !isHistoricalOrResolvedAt(text, index, match[0].length)) return true;
  }
  return false;
}

/**
 * 未经影像或病理评估的乳房肿块（2026-10-24 甲方 100 例 C069：38 岁、母亲乳腺癌、左乳无痛结节 1 个月、尚未做乳腺超声，
 * 红旗与优先关注都是空的，照常疏肝方，针刺卡还取乳根、膻中）。NICE NG12：30 岁及以上不明原因的乳房肿块（不论有无疼痛）
 * 按疑似肿瘤路径两周内转诊；男性 50 岁及以上乳晕下不明肿块同样。这里是给剂量的优先评估项（不是红旗）：复诊节点改为
 * 「3天内到相关专科完成评估（需排除乳腺癌）」，治疗卡不在乳房局部施术（tcm-treatment-capabilities 读同一个判据）。
 * 写法是有限闭集的构词式守卫：部位（乳房/乳腺/左右双乳/乳晕/腋下）+ 肿块类名词，否定与既往按 hasPatternWithoutNegation；
 * 病历里已有乳腺影像、穿刺或病理的结果，或写明已确诊、已切除的，不算未评估。
 */
const BREAST_MASS_PATTERN = /(?:乳房|乳腺|[左右双]侧?乳|乳晕|腋下|腋窝)[^。；;\n，,]{0,6}(?:肿块|结节|包块|硬结|肿物)|(?:触及|扪及|摸到|摸及)[^。；;\n，,]{0,8}(?:乳房|乳腺|乳)[^。；;\n，,]{0,6}(?:肿块|结节|包块|硬结|肿物)/u;
const BREAST_EVALUATION_RECORDED = /(?:超声|B超|彩超|钼靶|X线|MRI|磁共振|穿刺|病理|活检)[^。；;\n]{0,16}(?:示|提示|显示|所见|报告|结果|BI-?RADS|诊断为)|BI-?RADS|已确诊|确诊为|切除术后|已切除|乳[^。；;\n，,]{0,6}术后|(?:确诊|诊断为?)[^。；;\n]{0,6}乳(?:腺)?癌|(?<!母亲|母|姐姐|妹妹|家族|家人|外婆|奶奶|姨)乳(?:腺)?癌[^。；;\n]{0,8}(?:确诊|术后|复发|转移|化疗|放疗|肿物)/iu;
// 乳痈、乳腺炎（红肿热痛、成脓）与哺乳期的乳房结块按感染处置，不是「不明原因的肿块」。
const BREAST_INFLAMMATORY = /乳痈|乳腺炎|化脓|流脓|脓肿|成脓|哺乳期/u;
export function unevaluatedBreastMass(state: CaseState): boolean {
  return unevaluatedBreastMassText(trustedInputText(state), authoritativePatientAgeYears(state), patientSexText(withPatientObject(state)));
}
export function unevaluatedBreastMassText(text: string, ageYears: number | undefined, sex: string): boolean {
  const normalized = normalizeClinicalText(text);
  if (!hasPatternWithoutNegation(normalized, BREAST_MASS_PATTERN)) return false;
  if (BREAST_EVALUATION_RECORDED.test(normalized) || BREAST_INFLAMMATORY.test(normalized)) return false;
  if (ageYears == null) return /女/.test(sex);
  return /男/.test(sex) ? ageYears >= 50 : ageYears >= 30;
}

/**
 * 「患者本人的既往事实」判据：只排除**否定**与**非本人主语**，不排除历史性。
 *
 * hasPatternWithoutNegation 会把 isHistoricalOrResolvedAt 判为历史的命中一并丢掉——
 * 对症状是对的（「既往有胸痛」不是当前红旗），对**恶性肿瘤病史**恰恰相反：
 * 「食管癌术后放化疗」本身就是历史陈述，而这正是风险所在。实测中把肿瘤史写进既往史或现病史，
 * 两种写法都判不出来，整条分支是死的。
 *
 * 「否认肿瘤病史」仍然不算，「母亲患胃癌」（非本人）仍然不算。
 */
function hasPatientHistoryTermWithoutNegation(text: string, pattern: RegExp): boolean {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    if (isExcludedClinicalAssertionAt(text, index)) continue;
    if (!isNegatedAt(text, index) || hasCommaSeparatedPositiveEvidence(text, index, match[0])) return true;
  }
  return false;
}

/** 词表完整词 + 构词式腹痛，合成一条。两个消费点共用，避免只补一处而另一处继续漏。 */
function abdominalSymptomAlternation(): string {
  return `${governedTermAlternation(GOVERNED_ACUTE_ABDOMEN_SYMPTOMS)}|${ABDOMINAL_PAIN_COMPOSITION}`;
}

/**
 * 消化道出血正字（呕血/黑便/便血族 + 咖啡样构词式）的确定性优先评估信号。
 *
 * 与 narrativeFallbackAdvisories 的 gi_bleed 检测同一治理来源（giBleedConceptTerms /
 * 咖啡样构词式），但带逐命中否定/排除/既往断言守卫：晋级到优先评估档会扣发剂量，
 * 不允许把「否认黑便」「三年前曾便血」当阳性——否定式既往史误报是回归套件显式钉着的类别。
 *
 * 为什么这一档要确定性、不只靠语义回补层（2026-08-30 黄金基线实测）：
 * 「否认咯血，便血两日」期望 needs_information，此前该期望完全押在语义层单条抽取不漂移上；
 * 语义层逐条隔离/复核变异丢掉这一条时，门禁静默落回 ready + 提示档。闭集正字属判据分层
 * （§17）允许的确定性例外；硬门档（red_flag）仍按 T6 要求严重度证据，本谓词只管优先评估档。
 */
export function hasGiBleedPrioritySignal(text: string): boolean {
  if (hasCoffeeGroundEmesis(text)) return true;
  const normalized = normalizeClinicalText(text);
  for (const term of giBleedConceptTerms()) {
    let cursor = 0;
    while (cursor <= normalized.length) {
      const index = normalized.indexOf(term, cursor);
      if (index < 0) break;
      cursor = index + term.length;
      if (isExcludedClinicalAssertionAt(normalized, index)) continue;
      const affirmed = (!isNegatedAt(normalized, index) || hasCommaSeparatedPositiveEvidence(normalized, index, term)) &&
        !isPostfixNegatedAt(normalized, index, term.length);
      if (affirmed && !isHistoricalOrResolvedAt(normalized, index, term.length)) return true;
    }
  }
  return false;
}

function hasAbdominalPrioritySignal(text: string): boolean {
  const normalized = normalizeClinicalText(text);
  // 原实现按词表逐词 indexOf，加不进构词式模式；改为对合成正则做全局匹配，
  // 否定/既往/排除断言的判定逐个命中位置照旧执行，语义不变。
  const matcher = new RegExp(abdominalSymptomAlternation(), "g");
  for (const match of normalized.matchAll(matcher)) {
    const index = match.index ?? -1;
    const term = match[0];
    if (index >= 0) {
      if (isExcludedClinicalAssertionAt(normalized, index)) continue;
      const affirmed = (!isNegatedAt(normalized, index) || hasCommaSeparatedPositiveEvidence(normalized, index, term)) &&
        !isPostfixNegatedAt(normalized, index, term.length);
      if (affirmed && !isHistoricalOrResolvedAt(normalized, index, term.length)) {
        const clauseStart = Math.max(
          normalized.lastIndexOf("。", index - 1),
          normalized.lastIndexOf("；", index - 1),
          normalized.lastIndexOf(";", index - 1),
          normalized.lastIndexOf("\n", index - 1),
        ) + 1;
        const clauseEndCandidates = ["。", "；", ";", "\n"]
          .map((mark) => normalized.indexOf(mark, index))
          .filter((position) => position >= 0);
        const clauseEnd = clauseEndCandidates.length > 0 ? Math.min(...clauseEndCandidates) : normalized.length;
        // 被否认的加重线索（「无明显加重及缓解因素」）不算进展（与 hasSymptomThenUnnegatedCue 同一守卫，类夹具 negated-abdominal-change-cue）。
        const localClause = normalized.slice(Math.max(clauseStart, index - 24), Math.min(clauseEnd, index + term.length + 48))
          .replace(/(?:无|未|没有|未见|并无|否认|不再|并未)[^，,。；;\n]{0,3}?(?:明显|快速|很快|迅速|持续|进行性|越来越)?[^，,。；;\n]{0,4}?加重/gu, (match) => "＿".repeat(match.length))
          // 被否认的并列症状里的「持续」（「无黑便、便血及持续呕吐」）说的不是腹痛本身（2026-10-24 甲方 100 例 C011：餐后腹胀 6 个月
          // 被要求「优先完成腹部查体与严重度评估」）。
          .replace(/(?:无|没有|未见|并无|否认|不伴)[^，,。；;\n]{0,12}?持续[^，,。；;\n]{0,6}/gu, (match) => "＿".repeat(match.length));
        const priority =
          GOVERNED_ACUTE_ONSET_TERMS.some((cue) => localClause.includes(cue)) ||
          /(?:快速|明显|很快|迅速|持续|进行性|越来越)[^，,。；;\n]{0,4}加重|(?:仍|一直|反复)?持续(?:存在|不缓解)?|(?:未|无|没有|尚未)(?:见)?(?:缓解|好转|改善)/.test(localClause);
        if (priority) return true;
      }
    }
  }
  return false;
}

/**
 * 慢性病程里「遇到某个诱因就……难忍/剧烈」写的是发作规律，不是此刻的急腹痛（2026-10-18，逐模块验收主集 RobustSDT 0608：
 * 「近2年来症状逐渐加重…进食稍多则脘腹胀痛难忍」被报「急性、突发或剧烈腹痛」）。只在病历写了一个月以上的病程、全文没有
 * 今日/突发/近 N 天这类起病线索时，把「诱因 + 则/即/就 + …难忍/剧烈」这一段从程度词判据里拿掉；腹膜刺激征等其余判据照旧。
 * 类夹具 chronic-triggered-abdominal-severity。
 */
const TRIGGERED_SEVERITY = /(?:稍多|过饱|多食|进食|饭后|食后|餐后|劳累|受凉|遇冷|遇寒|每于|每因|每遇|每当|一旦)[^。；;，,]{0,6}(?:则|即|就|便|后)[^。；;，,]{0,10}(?:难忍|剧烈|剧痛|绞痛|疼得厉害|痛得厉害)/gu;
const ABDOMINAL_CHRONIC_COURSE = /\d+(?:\.\d+)?\s*(?:年|个月|月)|[一二两三四五六七八九十半]+\s*(?:年|个月)|多年|数年/u;
// 写了以小时、分钟计的时长（「剧痛2小时」）就是此刻这一次的发作，同样算起病线索。
const ABDOMINAL_ACUTE_ONSET = /今(?:日|天|晨|早|晚)|昨(?:日|晚|夜|天)|突发|突然|骤然|刚刚|刚才|急性|近\s*\d+\s*(?:小时|天|日)|\d+(?:\.\d+)?\s*(?:小时|分钟|h)|半小时|数小时/u;
function withoutChronicTriggeredSeverity(text: string): string {
  if (!ABDOMINAL_CHRONIC_COURSE.test(text) || ABDOMINAL_ACUTE_ONSET.test(text)) return text;
  return text.replace(TRIGGERED_SEVERITY, (match) => "＿".repeat(match.length));
}

/**
 * 程度词判据之前，再拿掉三类「写的是慢性规律或常见良性情形」的程度词（2026-10-19，r1019 红旗验收）。只遮程度词本身，
 * 腹膜刺激征、肠梗阻征、阑尾/胆囊体征都读原文，照旧报警。冻结令允许的确定性例外：有限闭集 + 数值阈值 + 构词式守卫。
 *  ① 月经期腹痛（痛经、经期、经行、月经来潮…）：「经行腹痛剧烈」「痛经，经期小腹绞痛」不是急腹症；妊娠阳性或可疑时不遮（异位妊娠）。
 *     语料回放：现代医案 163 次腹痛红旗里约 36 次是痛经。
 *  ② 慢性规律里的程度词：同一小句写了一个月以上的病程（「胃脘胀痛难忍2年」），或写成间歇发作（「有时轻微有时剧烈」），
 *     全文又没有起病线索（今日/突发/近 N 天/小时）和两周内的加重，就不算此刻的剧烈腹痛。
 *     「反复胃痛3年，腹痛剧烈，按之痛甚」这种程度词单独成句的照旧报（chronic-triggered-abdominal-severity 的反例）。
 *  ③ 腹泻里的绞痛（「腹泻3日，伴腹部绞痛」）：肠炎的痉挛性腹痛。只遮「绞痛」，便血、黏液脓血、停止排气同句时不遮。
 * 类夹具 abdominal-severity-non-acute-context。
 */
const MENSTRUAL_PAIN_CONTEXT = /痛经|经期|经行|行经|月经来潮|月经期|经前|经后|来月经|例假/u;
const EPISODIC_SEVERITY_MARKER = /有时|时而|时有|偶有|偶尔|间断|阵发|发作时/u;
const DIARRHOEAL_CONTEXT = /腹泻|泄泻|泻下|便溏|稀便|水样便|大便次数增多|排便不爽|里急后重/u;
const DIARRHOEAL_DANGER = /便血|血便|带血|下血|脓血|黏液血|粘液血|停止排气|停止排便|呕血|黑便/u;
const ABDOMINAL_SEVERITY_WORD = new RegExp(`${GOVERNED_SEVERE_TERMS.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}|绞痛|急痛|剧`, "gu");
const RECENT_ABDOMINAL_CHANGE = /(?:近|最近)\s*(?:\d+|[一二两三四五六七八九十几])\s*(?:天|日|周)[^。；;\n]{0,16}(?:加重|加剧)|(?:\d+|[一二两三四五六七八九十几])\s*(?:天|日)前[^。；;\n]{0,16}(?:加重|加剧)|(?:加重|加剧)\s*(?:\d+|[一二两三四五六七八九十几])\s*(?:天|日)/u;
function maskSeverityIn(segment: string, pattern: RegExp = ABDOMINAL_SEVERITY_WORD): string {
  return segment.replace(new RegExp(pattern.source, "gu"), (match) => "＿".repeat(match.length));
}
function withoutNonAcuteAbdominalSeverity(text: string): string {
  const pregnancy = assessPregnancyState(text).status;
  const pregnancyPossible = pregnancy === "positive" || pregnancy === "possible";
  const chronicEligible = !ABDOMINAL_ACUTE_ONSET.test(text) && !RECENT_ABDOMINAL_CHANGE.test(text);
  return text.split(/(?<=[。；;\n])/u).map((sentence) => {
    let next = sentence;
    // 只遮与月经相关的那几小句：写了经期线索的小句，或同一句里不带上腹部位（胃、脘、上腹、胁、脐）的下腹痛小句——
    //「胃痛剧烈，伴…经前腹痛」里的胃痛不是痛经（语料回放 T16-MR-05890）。
    if (!pregnancyPossible && MENSTRUAL_PAIN_CONTEXT.test(next)) {
      next = next.split(/(?<=[，,])/u).map((clause) =>
        MENSTRUAL_PAIN_CONTEXT.test(clause) || (/小腹|少腹|下腹|腹痛|腹部/u.test(clause) && !/胃|脘|上腹|胁|脐/u.test(clause))
          ? maskSeverityIn(clause)
          : clause).join("");
    }
    if (DIARRHOEAL_CONTEXT.test(next) && !hasPatternWithoutNegation(next, DIARRHOEAL_DANGER)) next = maskSeverityIn(next, /绞痛/u);
    if (chronicEligible) {
      next = next.split(/(?<=[，,])/u).map((clause) =>
        new RegExp(ABDOMINAL_SEVERITY_WORD.source, "u").test(clause) && (EPISODIC_SEVERITY_MARKER.test(clause) ||
          (ABDOMINAL_CHRONIC_COURSE.test(clause) && courseDurationDays(clause) >= 30))
          ? maskSeverityIn(clause)
          : clause).join("");
    }
    return next;
  }).join("");
}

/**
 * 查体与病程里的客观急腹症征象（2026-10-18，验收集 A：外科考试病例「腹壁呈板状僵硬」「右下腹明显压痛，轻度肌紧张」
 *「腹胀并停止排气排便2天」都是零红旗）。词表在 T6 acute_abdomen.detection（受治理闭集）；这里只有两条构词式：
 *  · 不带部位的「肌紧张」：前 20 字内写了腹/脐/麦氏点才算腹部查体，「肌紧张性头痛」不算；
 *  · 肠梗阻征（停止排气排便）要与当前腹痛、腹胀或呕吐同在。
 * 否定、既往、已缓解一律走 hasPatternWithoutNegation（「无压痛、反跳痛及肌紧张」不报）。
 */
function hasObjectiveAbdominalEmergencySign(text: string): boolean {
  if (hasPatternWithoutNegation(text, new RegExp(governedTermAlternation(ACUTE_ABDOMEN_DETECTION.peritonealSignForms)))) return true;
  if (hasPatternWithoutNegation(text, /(?<=(?:腹|脐|麦氏点)[^。；;\n]{0,20})(?:轻度|明显|显著)?肌紧张(?!性)/u)) return true;
  if (hasPatternWithoutNegation(text, new RegExp(governedTermAlternation(ACUTE_ABDOMEN_DETECTION.obstructionSigns))) &&
    hasPatternWithoutNegation(text, new RegExp(`${abdominalSymptomAlternation()}|呕吐`))) return true;
  return hasNamedAbdominalEmergencySign(text);
}

/**
 * 命名的急腹症查体征与肠梗阻的查体/影像征（2026-10-19，r1019 验收集 A：阑尾炎「麦氏点压痛、腰大肌征阳性」、
 * 小肠梗阻「腹膨隆，见肠型，有气过水声，平片阶梯状液平」、老年「无排便7天，腹痛、呕吐2天」都零红旗）。
 * 词表在 T6 acute_abdomen.detection（受治理闭集）。冻结令允许的确定性例外：有限闭集 + 数值阈值（未排便 ≥3 天）+ 构词式守卫：
 *  · 阳性写法后紧跟（-）/阴性/－ 的不算（「麦氏点压痛（-）」）；否定、既往照旧由 hasPatternWithoutNegation 排除；
 *  · 影像气液平要与腹/肠/立位平片同句、且同句没有胸/肺（肺脓肿的气液平）；
 *  · N 天未排便要与当前腹痛或腹胀、以及呕吐同在（痛、吐、胀、闭）。
 * 类夹具 named-abdominal-emergency-signs。
 */
function hasNamedAbdominalEmergencySign(text: string): boolean {
  const negativeTail = String.raw`(?![^，,。；;\n]{0,6}?(?:阴性|[（(]\s*[-－−]\s*[)）]|－|(?<![\d])-(?!\d)))`;
  if (hasPatternWithoutNegation(text, new RegExp(`(?:${governedTermAlternation(ACUTE_ABDOMEN_DETECTION.appendicealCholecystSigns)})${negativeTail}`, "u"))) return true;
  if (hasPatternWithoutNegation(text, new RegExp(`(?:${governedTermAlternation(ACUTE_ABDOMEN_DETECTION.obstructionExamSigns)})${negativeTail}`, "u"))) return true;
  const imaging = new RegExp(governedTermAlternation(ACUTE_ABDOMEN_DETECTION.obstructionImagingSigns), "u");
  if (text.split(/[。；;\n]+/u).some((sentence) => imaging.test(sentence) && /腹|肠|立位|平片/u.test(sentence) && !/胸|肺/u.test(sentence) &&
    hasPatternWithoutNegation(sentence, imaging))) return true;
  const days = ACUTE_ABDOMEN_DETECTION.obstipationDays;
  const obstipationMatches = [...text.matchAll(/(?:(\d+|[一二两三四五六七八九十]+)\s*(?:天|日)\s*(?:未|无|没有|不)\s*(?:排便|解大便|解便|大便|排气排便))|(?:(?:未|无|没有)\s*(?:排便|解大便|解便|大便)\s*(\d+|[一二两三四五六七八九十]+)\s*(?:天|日))|(?:(?:大便|排便)\s*(\d+|[一二两三四五六七八九十]+)\s*(?:天|日)\s*(?:未|没)\s*(?:解|排))/gu)]
    .filter((match) => {
      const value = courseNumberValue(match[1] || match[2] || match[3]);
      const index = match.index ?? 0;
      return value != null && value >= days && !isHistoricalOrResolvedAt(text, index, match[0].length) && !isExcludedClinicalAssertionAt(text, index);
    });
  if (obstipationMatches.length === 0) return false;
  // 「无排便7天，腹痛、呕吐2天」里的「无」只管排便：先把未排便那一段遮掉，再判腹痛、呕吐，免得否定沿逗号串过去。
  let masked = text;
  for (const match of obstipationMatches) {
    const index = match.index ?? 0;
    masked = `${masked.slice(0, index)}${"＿".repeat(match[0].length)}${masked.slice(index + match[0].length)}`;
  }
  return hasPatternWithoutNegation(masked, /呕吐|吐出/u) &&
    hasPatternWithoutNegation(masked, new RegExp(abdominalSymptomAlternation(), "u"));
}

/**
 * 脑膜刺激征阳性（2026-10-18，验收集 A-eme-0082 结核性脑膜炎零红旗）。词表在 T6 neuro.detection.meningealSigns；
 * 「颈抵抗」后写阴性或（-）的不算，「颈软、无抵抗」本来就不含这个词。
 */
function hasMeningealSign(text: string): boolean {
  return hasPatternWithoutNegation(text, new RegExp(
    `(?:${governedTermAlternation(NEURO_DETECTION.meningealSigns)})(?!\\s*(?:阴性|[(（]\\s*[-－−]\\s*[)）]))`,
    "u",
  ));
}

/**
 * 外伤后 3 天内的骨折（2026-10-18）。同一句里要有骨折词、外伤线索和起病时间（N 小时，或 N≤3 天/日，或今日、昨日），
 * 且这句不是术后、陈旧、已固定的骨折。词表在 T6 other_critical.detection；时间门槛按数字判。
 */
function hasAcuteTraumaFracture(text: string): boolean {
  const fracture = new RegExp(governedTermAlternation(TRAUMA_DETECTION.fractureTerms));
  const trauma = new RegExp(governedTermAlternation(TRAUMA_DETECTION.acuteTraumaCues));
  const settled = new RegExp(governedTermAlternation(TRAUMA_DETECTION.settledFractureCues));
  return text.split(/[。；;\n]+/u).some((sentence) => {
    if (!trauma.test(sentence) || settled.test(sentence)) return false;
    // 时间门槛由下面按数字判，所以这里只看否认与主语，不用通用的「N天前＝既往」作用域（它会把「2天前摔倒…骨折」判成既往）。
    const fractureAt = sentence.search(fracture);
    if (fractureAt < 0 || isNegatedAt(sentence, fractureAt) || isExcludedClinicalAssertionAt(sentence, fractureAt)) return false;
    // 句子把外伤锚在「N个月/年/周前」时是旧伤，句中别处的「24小时内…」说的是当时的经过（验收集 H-tri-16191）。
    if (/(?:\d+|[一二两三四五六七八九十半]+)\s*(?:个)?(?:月|年|周|星期)(?:余|多)?前/u.test(sentence)) return false;
    if (/(?:今日|今天|今晨|昨日|昨天|昨晚|刚刚|刚才)/u.test(sentence)) return true;
    return [...sentence.matchAll(/(\d+(?:\.\d+)?|[一二两三半])\s*(?:个)?(小时|天|日)/gu)].some((match) => {
      if (match[2] === "小时") return true;
      const value = /^\d/u.test(match[1]) ? Number(match[1]) : ({ 一: 1, 二: 2, 两: 2, 三: 3, 半: 0.5 } as Record<string, number>)[match[1]];
      return value != null && value <= 3;
    });
  });
}

function hasSymptomThenUnnegatedCue(text: string, symptoms: string, cues: string): boolean {
  for (const match of text.matchAll(new RegExp(`(${symptoms})([^。；;\\n]{0,16}?)(${cues})`, "gu"))) {
    const index = match.index ?? -1;
    if (index < 0 || isExcludedClinicalAssertionAt(text, index)) continue;
    if (isNegatedAt(text, index) && !hasCommaSeparatedPositiveEvidence(text, index, match[0])) continue;
    if (isHistoricalOrResolvedAt(text, index, match[0].length)) continue;
    const cueIndex = index + match[1].length + match[2].length;
    // 线索自身被否定（「无明显加重」「未见加重」「没有越来越重」）：线索前 4 字内有否定词即不算。
    if (/(?:无|未|没有|未见|并无|否认|不再|并未)[^，,。；;\n]{0,2}$/u.test(text.slice(Math.max(0, cueIndex - 4), cueIndex))) continue;
    return true;
  }
  return false;
}

function hasAcuteAbdominalSignal(rawText: string): boolean {
  // 腹膜刺激征的口语表达（“按下去松手更疼”=反跳痛）与“肚子疼”类口语主诉必须覆盖；
  // 松手后“不疼”的否定式描述不命中（间隔字符排除不/无/未）。
  const severe = governedTermAlternation(GOVERNED_SEVERE_TERMS);
  const symptoms = abdominalSymptomAlternation();
  const text = withoutNonAcuteAbdominalSeverity(withoutChronicTriggeredSeverity(rawText));
  const worseningCue = "疼得厉害|痛得厉害|挺不住|无法忍受|明显加重|快速加重|迅速加重|越来越重";
  return hasAnyTerm(rawText, ["急腹痛", "腹膜刺激征", ...GOVERNED_PERITONEAL_SIGNS]) ||
    hasObjectiveAbdominalEmergencySign(rawText) ||
    // 症状短语自带重度性质词（上腹剧痛/右下腹剧痛/脘腹剧烈疼痛/少腹急痛/腹部绞痛）
    hasPatternWithoutNegation(text, new RegExp(ABDOMINAL_SEVERE_PAIN_COMPOSITION)) ||
    // 症状在前、加重线索在后：否定要在线索的位置上判（2026-10-19，r1019：「偶有上腹胀满，无明显加重及缓解因素」
    // 只在症状处判否定，于是报了急腹症；与 10/13 消化道出血「否定也要在出血词处判」同一形状）。类夹具 negated-abdominal-change-cue。
    hasSymptomThenUnnegatedCue(text, symptoms, worseningCue) ||
    hasPatternWithoutNegation(text, new RegExp(
      `(?:${worseningCue})[^。；;\\n]{0,16}(?:${symptoms})`,
    )) ||
    hasPatternWithoutNegation(text, /(?:松手|放手|抬手|松开)(?:时|后)?[^，,。；;\n不无未]{0,4}(?:更|最|特别)?(?:疼|痛)/) ||
    hasPatternWithoutNegation(text, new RegExp(
      // 程度词后面紧跟逗号，说明它是在收束前一个症状（「瘙痒剧烈，同时胃脘、腹部疼痛」里剧烈的是瘙痒），
      // 不向后修饰腹痛（2026-10-13，句法守卫；「腹痛剧烈，…」由下一行的「症状在前」方向承接）。
      `(?:${severe})(?![，,])[^。；;\\n]{0,12}(?:${symptoms}|全腹[^。；;\\n]{0,4}痛)|` +
      `(?:${symptoms}|全腹[^。；;\\n]{0,4}痛)[^。；;\\n无未不否没]{0,12}(?:${severe})`,
    ));
}

const SIGNIFICANT_WEIGHT_LOSS_KG = 3;

/**
 * 上消化道警示征象只读当前、消化道部位的伴随表现（2026-10-19，r1019 验收集 M：
 *  · 乳腺癌术后病例的「双乳超声示：左乳包块」被当成消化道包块（TCM-SD 438290）；
 *  · 小细胞肺癌病例「2017年10月…伴乏力、体重下降，就诊于当地医院」这段确诊当年的经过被当成当前消瘦（BEST4SDT-158）。
 * 冻结令允许的确定性例外：构词式守卫（闭集）。
 *  · 包块/肿块前 6 字内是消化道以外的部位（乳、颈、腋、甲状腺、皮下、腹股沟、锁骨、淋巴结、子宫、卵巢、附件、阴道、
 *    阴囊、睾丸、四肢、背、头皮、肺）时遮掉这个词；
 *  · 以公历年份开头的句子（「2017年10月…」）在病历另有刻下/现症/目前/入院时/就诊时这类当前段落时，整句视为既往经过，遮掉。
 * 肿瘤史本身不受影响（它本来就按「本人既往事实」读）。类夹具 gi-alarm-site-and-dated-history。
 */
const NON_DIGESTIVE_MASS = /(?:乳腺?|乳房|颈部?|腋窝?|甲状腺|皮下|腹股沟|锁骨上?|淋巴结|子宫|卵巢|附件|阴道|阴囊|睾丸|四肢|背部?|头皮|肺)[^，,。；;\n]{0,6}(?:包块|肿块)/gu;
const CURRENT_SECTION_MARKER = /刻下|现症|目前|入院时|就诊时|现患者|现仍|现有/u;
function withoutNonDigestiveMassOrDatedHistory(text: string): string {
  const masked = text.replace(NON_DIGESTIVE_MASS, (match) => match.replace(/包块|肿块/gu, "＿＿"));
  if (!CURRENT_SECTION_MARKER.test(masked)) return masked;
  return masked.split(/(?<=[。；;\n])/u).map((sentence) =>
    /^\s*(?:19|20)\d{2}\s*年/u.test(sentence) && !CURRENT_SECTION_MARKER.test(sentence)
      ? "＿".repeat(sentence.length - 1) + sentence.slice(-1)
      : sentence).join("");
}

/**
 * 上消化道警示征象的**单一判据**。四条分支，分别对应不同的临床成立方式：
 *
 *  A 梗阻类征象本身即警示：吞咽困难/咽下困难/进食梗阻/哽噎/噎膈。指南口径下，
 *    新发吞咽困难本身就是内镜指征，不需要额外伴随条件。
 *  B 「进食困难」单独出现太松（牙痛、口腔溃疡都能写成进食困难），要求同句带进展或病程线索。
 *  C 恶性肿瘤病史 + 当前消化道症状：这是本次实测漏掉的那一条。癌症术后放化疗患者出现新发或
 *    加重的消化道症状，首先要排除的是复发与吻合口梗阻，不是辨证开方。
 *    肿瘤词表用**具体病种**而不是裸「癌」字，避免「癌胚抗原」这类检验名误命中。
 *  D 不明原因/进行性体重下降：单独的「消瘦」是中医常用描述，必须带「不明原因/进行性/具体数值」。
 *
 * 四条一律走 hasPatternWithoutNegation：甲方 P0 病例原文写的是「无呕血黑便，无消瘦，无吞咽困难」，
 * 把否定式读成阳性会把整个普通门诊病例打成红旗——那正是本仓库反复付过代价的误报形态。
 */
/** 命中的是哪一类上消化道警示征象（红旗理由只写命中的那一类，见 4630 行附近）。 */
type UpperGiAlarmKind = "obstruction" | "malignancy" | "weight_loss";
function upperGiAlarmFeatureKind(rawText: string): UpperGiAlarmKind | undefined {
  const text = rawText;
  // 伴随表现与体重下降只读当前、消化道部位的写法（见 withoutNonDigestiveMassOrDatedHistory）；肿瘤史本身照旧读全文。
  const findingsText = withoutNonDigestiveMassOrDatedHistory(rawText);
  // A
  if (hasPatternWithoutNegation(text, new RegExp(governedTermAlternation(GOVERNED_GI_ALARM.symptoms)))) return "obstruction";
  // B
  const progression = `${governedTermAlternation(GI_ALARM_DETECTION.progressionCues)}|\\d+\\s*(?:个)?(?:月|年|周)`;
  if (hasPatternWithoutNegation(text, new RegExp(
    `进食困难[^。；;\\n]{0,20}(?:${progression})|(?:${progression})[^。；;\\n]{0,20}进食困难`,
  ))) return "obstruction";
  // C：恶性肿瘤病史分两档，避免「任何癌症幸存者 + 任何腹胀 = 永久红旗」这类噪声。
  //   · 消化道本身的恶性肿瘤 + **任何**当前消化道症状 ⇒ 触发。
  //     食管癌术后新发上腹胀满要先排除复发与吻合口狭窄，这一档不该再加门槛。
  //   · 其他部位恶性肿瘤 + **警示级**消化道表现（梗阻/进食困难/呕吐/消瘦/包块/黑便）⇒ 触发。
  //     实测促成这一档的病例：子宫内膜癌术后 + 肠梗阻史 + 胃胀痛1周。
  //     若不分档，十年前的乳腺癌幸存者偶发腹胀也会永远挂着红旗，医生很快就会不再看红旗。
  // 「任意癌」这一档不进词表而写成词法守卫：病种白名单必然漏（第一版就漏了子宫内膜癌），
  // 而裸「癌」会被「癌胚抗原」「防癌体检」误命中，两头都要挡住。词表管的是词，
  // (?<![防抗致])癌(?!胚|抗原) 管的是构词，两者性质不同，不该混进同一张表。
  const CANCER = `${governedTermAlternation(GI_ALARM_DETECTION.malignancyGeneric)}|(?<![防抗致])癌(?!胚|抗原)`;
  // 病理报告写的是**组织学名**：「结肠腺癌」「胃低分化腺癌」「食管鳞癌」「直肠印戒细胞癌」，
  // 受治理词表收的是**病种名**「结肠癌/胃癌/食管癌」——中间多一个组织学定语就整类失配。
  // 2026-09-26 公开语料实测（CMB-Clin「结肠癌肝转移」一例）：病理报告为「结肠腺癌」，
  // 该例此前能出警示靠的是把「未触及腹部包块」误读成阳性包块；查体否定动词补齐后本例整例漏检。
  // 与上面 CANCER 那条同一修法：部位仍只取受治理词表里的那几个（去掉词尾「癌」），
  // 代码只补构词——中间允许的组织学定语是闭集。冻结令例外：构词式词法守卫。
  const GI_CANCER_SITE = governedTermAlternation(
    GI_ALARM_DETECTION.gastrointestinalMalignancy.map((term) => term.replace(/癌$/, "")),
  );
  const GI_CANCER_HISTOLOGY =
    "(?:低分化|中分化|高分化|中低分化|未分化|印戒细胞|黏液|粘液|管状|乳头状|神经内分泌|鳞状细胞|鳞|腺鳞|腺)*";
  const GI_CANCER = `(?:${GI_CANCER_SITE})${GI_CANCER_HISTOLOGY}癌(?!胚|抗原)`;
  const digestive = governedTermAlternation(GI_ALARM_DETECTION.currentDigestiveSymptoms);
  const alarmDigestive = governedTermAlternation(GI_ALARM_DETECTION.alarmDigestiveFindings);
  if (hasPatientHistoryTermWithoutNegation(text, new RegExp(GI_CANCER))
    && hasPatternWithoutNegation(findingsText, new RegExp(digestive))) return "malignancy";
  if (hasPatientHistoryTermWithoutNegation(text, new RegExp(CANCER))
    && hasPatientHistoryTermWithoutNegation(findingsText, new RegExp(alarmDigestive))) return "malignancy";
  // D
  const weightLossCue = governedTermAlternation(GI_ALARM_DETECTION.unexplainedWeightLossCues);
  const weightLoss = governedTermAlternation(GI_ALARM_DETECTION.weightLossTerms);
  if (hasPatternWithoutNegation(findingsText, new RegExp(`(?:${weightLossCue})[^。；;\\n]{0,8}(?:${weightLoss})`))) return "weight_loss";
  // 带数值的体重下降要够得上「有临床意义」才算警示（2026-10-13，数值阈值）。此前任何数字都算：
  // 「干咳3月，近3个月体重下降约2kg」被报成上消化道警示征象并收回剂量。通行定义是 6–12 个月内
  // 非刻意下降超过体重的 5%；病历通常不写体重，按 60kg 折算取 3kg（6 斤）。达不到的仍留在病历里供医生判断。
  // 「8-10斤」「4～5kg」这类区间取上限。
  const measuredLoss = new RegExp(
    `(?:${weightLoss})[^。；;\\n\\d]{0,10}(?:\\d+(?:\\.\\d+)?\\s*[-~～—–至到]\\s*)?(\\d+(?:\\.\\d+)?)\\s*(kg|公斤|斤|千克)`,
    "gi",
  );
  // 只有数值、没写「不明原因/进行性」的体重下降，要同时有当前消化道症状才算**上消化道**警示（2026-10-24，甲方 100 例 C031：
  //「口渴、多尿、乏力1个月…体重下降4kg」，空腹血糖 11.8，被报「上消化道警示征象（不明原因体重下降）」并收回剂量）。
  // NICE NG12 的上消化道转诊口径也是「体重下降 + 上腹痛/反流/消化不良」。体重词本身（消瘦）不算消化道症状。
  const weightLossWords = new Set(GI_ALARM_DETECTION.weightLossTerms);
  const digestiveWithoutWeightLoss = [
    ...GI_ALARM_DETECTION.currentDigestiveSymptoms.filter((term) => !weightLossWords.has(term)),
    ...GI_ALARM_DETECTION.weightLossDigestiveContext,
  ];
  // 极性按小句判：否定词只管它自己那个逗号小句，不沿逗号向后继承（「无发热，无明显心慌胸闷，纳差，呃逆」里纳差是阳性）。
  // 这里只决定「要不要报」，读宽一点是报警方向，比闸门的逗号续接否定宽松是有意的（语料回放 M2-TCMChat-test-456、corpus-17177）。
  const digestivePattern = new RegExp(governedTermAlternation(digestiveWithoutWeightLoss), "g");
  const hasCurrentDigestiveSymptom = findingsText.split(/[，,。；;\n]+/).some((clause) => {
    for (const match of clause.matchAll(digestivePattern)) {
      if (!/(?:否认|无|未见|未|没有|不伴|未诉)/.test(clause.slice(0, match.index ?? 0))) return true;
    }
    return false;
  });
  for (const match of hasCurrentDigestiveSymptom ? findingsText.matchAll(measuredLoss) : []) {
    const kilograms = Number(match[1]) * (match[2] === "斤" ? 0.5 : 1);
    if (kilograms < SIGNIFICANT_WEIGHT_LOSS_KG) continue;
    const index = match.index ?? -1;
    if (index < 0 || isExcludedClinicalAssertionAt(findingsText, index)) continue;
    if ((!isNegatedAt(findingsText, index) || hasCommaSeparatedPositiveEvidence(findingsText, index, match[0])) &&
        !isHistoricalOrResolvedAt(findingsText, index, match[0].length)) return "weight_loss";
  }
  return undefined;
}

/**
 * 咖啡样呕吐物的**构词式**判据。与 ABDOMINAL_PAIN_COMPOSITION 是同一类修法：
 * 词表按完整词穷举，中文换个说法就全部失配。
 *
 * 【实测】线上鲁棒性压测的真实妊娠剧吐病案原文写「吐出咖啡色黏液」「吐出咖啡色液体」，
 * 确定性层 redFlags **为 0**——词表里只有「咖啡样呕吐物」「呕咖啡样物」两个完整词。
 * 该例最终能出红旗，靠的是模型语义回补层。但那一层按设计**只能追加**、且依赖模型可用：
 * 2026-08-12 主模型账户欠费停摆 8 小时，同样这份病历会一条红旗都没有。
 * 承重的必须是确定性层。
 *
 * 更直白的证据是同一文件内部就自相矛盾：否定扫描的同义词组（本文件 334 行附近）早已列出
 * 「呕咖啡色液体」「吐咖啡色液体」——**否定侧认得这个说法，阳性侧不认得**。
 * 又是同一判据两处各写各的。
 *
 * 两条分支，都刻意限定在**同一分句内**（字符类排除逗号）：
 *  · 呕/吐 + 咖啡色|咖啡样：覆盖「吐出咖啡色黏液」「呕吐物呈咖啡色」；
 *  · 咖啡色|咖啡样 + 呕吐物|胃内容物：名词自带呕吐语义，不需要动词。
 * 跨逗号会把「呕吐3天，阴道流出咖啡色分泌物」读成上消化道出血——旧血性阴道分泌物同样写咖啡色，
 * 那是产科线索不是消化道出血，判错方向比漏判更糟。
 */
const COFFEE_GROUND_EMESIS_COMPOSITION =
  "(?:呕|吐)[^，,。；;\\n]{0,8}咖啡(?:色|样)"
  + "|咖啡(?:色|样)[^，,。；;\\n]{0,6}(?:呕吐物|胃内容物)";

function hasCoffeeGroundEmesis(text: string): boolean {
  return hasPatternWithoutNegation(text, new RegExp(COFFEE_GROUND_EMESIS_COMPOSITION));
}

/**
 * 按概念取同义词组：给一个代表词（如「黑便」），拿回该概念的**全部**写法。
 * 检出口一律走这里，杜绝「词在 POSITIVE_FACT_EQUIVALENT_GROUPS 里、检出口却另抄一份短表」。
 */
function conceptGroupTerms(representative: string): string[] {
  const group = POSITIVE_FACT_EQUIVALENT_GROUPS.find((item) => item.includes(representative));
  return group ? [...group] : [representative];
}

/** 消化道出血三个概念（呕血/黑便/便血）的全部写法。 */
function giBleedConceptTerms(): string[] {
  return [...conceptGroupTerms("呕血"), ...conceptGroupTerms("黑便"), ...conceptGroupTerms("便血")];
}

/** 同上，合并成正则交替式。 */
function giBleedConceptAlternation(): string {
  return governedTermAlternation(giBleedConceptTerms());
}

function clinicalClauseBounds(text: string, index: number): { start: number; end: number } {
  const start = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
  ) + 1;
  const following = ["。", "；", ";", "\n"]
    .map((mark) => text.indexOf(mark, index))
    .filter((position) => position >= 0);
  return { start, end: following.length > 0 ? Math.min(...following) : text.length };
}

function hasAcutePositiveTerm(text: string, terms: string[]): boolean {
  const acuteCue = /(突发|急性|新发|突然|持续|加重|快速加重|端坐|昨日起|昨夜开始|活动后|运动后|劳累后)/;
  for (const term of terms) {
    let index = text.indexOf(term);
    while (index !== -1) {
      if (isExcludedClinicalAssertionAt(text, index)) {
        index = text.indexOf(term, index + term.length);
        continue;
      }
      if ((!isNegatedAt(text, index) || hasCommaSeparatedPositiveEvidence(text, index, term)) && !isHistoricalOrResolvedAt(text, index, term.length)) {
        const clause = clinicalClauseBounds(text, index);
        const start = Math.max(clause.start, index - 12);
        const end = Math.min(clause.end, index + term.length + 12);
        const windowText = text.slice(start, end).replace(NON_NEGATING_PHRASES, "");
        if (acuteCue.test(windowText)) return true;
      }
      index = text.indexOf(term, index + term.length);
    }
  }
  return false;
}

function hasRecentPositiveTerm(text: string, terms: string[]): boolean {
  const normalized = normalizeClinicalText(text);
  const recentCue = /(\d+(?:\.\d+)?\s*(?:分钟|分|小时|天|日|h|H)|[一二两三四五六七八九十几两]\s*(?:天|日)|半小时|半日|半天|一天|数小时|几小时|多小时|刚刚|刚才|方才|今日|今天|今晨|当前|现在|目前|昨日|昨日起|昨夜|昨晚|近期|近来|最近|近(?:(?:\d+|[一二两三四五六七八九十几两])?[日天]|两天|几天)|本次|新近|新发|再发|复发|又发|又有|突发|突然|急性|持续|加重|快速加重|活动后|运动后|劳累后)/;
  for (const term of terms) {
    let index = normalized.indexOf(term);
    while (index !== -1) {
      if (isExcludedClinicalAssertionAt(normalized, index)) {
        index = normalized.indexOf(term, index + term.length);
        continue;
      }
      const start = Math.max(0, index - 24);
      const end = Math.min(normalized.length, index + term.length + 24);
      const windowText = normalized.slice(start, end).replace(NON_NEGATING_PHRASES, "");
      const afterTerm = normalized.slice(index + term.length, index + term.length + 18).replace(NON_NEGATING_PHRASES, "");
      // “否认胸痛、头痛，今晨气促/气促持续2小时”中的逗号开启了新的阳性分句。
      // 仅当否定词与目标症状之间已经存在逗号时才覆盖继承否定；“否认气促，持续2小时”仍保持阴性。
      const separatedFromPriorNegation = hasCommaSeparatedPositiveEvidence(normalized, index, term);
      const resolvedAfterTerm = /^[^。；;\n]{0,16}(?:(?:现已|目前已|当前已|已经|已)(?:缓解|消失|好转)|(?:现|目前|当前)?(?:未再发|未出现)|(?:现|目前|当前)(?:无|没有)(?:气促|呼吸困难|喘憋|再发|症状|不适))/.test(afterTerm);
      if ((!isNegatedAt(normalized, index) || separatedFromPriorNegation) && !isHistoricalOrResolvedAt(normalized, index, term.length) && !resolvedAfterTerm && recentCue.test(windowText)) return true;
      index = normalized.indexOf(term, index + term.length);
    }
  }
  return false;
}

// 局灶神经缺损词。**中医门诊的中风描述用的是另一套词**，原表只收了西医写法，
// 于是这个中医 CDSS 认得「口角歪斜」却认不得「口眼歪斜」、认得「肢体无力」却认不得「半身不遂」。
// 实测（2026-08-09）：「今晨突发口眼歪斜」「今晨突发半身不遂」「今晨突发不省人事」
// 「今晨突发意识模糊」「今晨突发肢体活动不利」全部**零红旗**，而「今晨突发口角歪斜」正常命中。
// 同一个卒中病人，医生按中医术语写就没有红旗——这是本层最不该有的漏。

// 从数组派生，不再手抄第二份。原实现把同一批词在数组和正则里各写一遍，
// 加词时只改一处就会静默半失效——本仓库最常复发的缺陷形状。
const FOCAL_NEUROLOGIC_PATTERN = new RegExp(
  `(?:${FOCAL_NEUROLOGIC_TERMS.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
);
// 「抽搐痛」「抽搐感」「抽搐样痛」是疼痛的性质（「头抽搐痛七年」「头痛呈拘急跳痛抽搐感」），不是发作性抽搐（2026-10-19 Claude 评审 H 集
// H-tri-19642：七年间断性紧张性头痛被报神经急症、剂量收回）。构词式守卫：只看「抽搐」后面紧跟的痛/感，其余写法照旧。
// 「抽搐的痛」「抽搐似的疼」同属这一构词（2026-10-24 第十八轮基层病例 B008：26 岁胃痛半年「疼痛为“抽搐的痛，好像有很多胃气”」被报神经急症）。
// 「抽搐疼痛」同一构词（2026-10-25 第二十轮回放 corpus-17224：「四肢无力、麻木感、时有抽搐疼痛」）。
const CATASTROPHIC_NEUROLOGIC_EVENT_PATTERN = /(?:昏迷|呼之不应|抽搐(?!痛|疼痛?|感|样(?:疼|胀)?痛|(?:样|似)?的(?:疼痛|胀痛|痛|疼))|惊厥|癫痫持续状态)/;
const ACUTE_CONSCIOUSNESS_CHANGE_TERMS = ["昏睡", "嗜睡", "谵妄"];
/**
 * 意识改变：急性意识改变那组词、灾难性神经事件里的昏迷/呼之不应，加上同义的书面写法；「反应（较平时）迟钝/变慢」按构词式认。
 * 只用于低体温合并意识改变这一条（不要求「突发」这类急性词：低体温本身就是这条规则的另一半证据）。
 */
const CONSCIOUSNESS_CHANGE_TERMS = [...ACUTE_CONSCIOUSNESS_CHANGE_TERMS, "昏迷", "呼之不应", "意识模糊", "意识障碍", "神志不清", "神志模糊", "神志恍惚",
  "神志昏沉", "神识昏蒙", "神昏谵语"];
const SLOWED_RESPONSE_PATTERN = /反应(?:较平时|比平时|较前|比以前|明显)?(?:迟钝|变慢|迟缓)/;

/** 病历当前、肯定地记录了意识改变时返回那个说法（否定、既往、已缓解的不算）。 */
function currentConsciousnessChangeTerm(text: string): string | undefined {
  const normalized = normalizeClinicalText(text);
  for (const term of CONSCIOUSNESS_CHANGE_TERMS) {
    let index = normalized.indexOf(term);
    while (index !== -1) {
      if (!isExcludedClinicalAssertionAt(normalized, index) &&
          (!isNegatedAt(normalized, index) || hasCommaSeparatedPositiveEvidence(normalized, index, term)) &&
          !isHistoricalOrResolvedAt(normalized, index, term.length)) return term;
      index = normalized.indexOf(term, index + term.length);
    }
  }
  const slowed = firstPatternMatchWithoutNegation(normalized, SLOWED_RESPONSE_PATTERN);
  return slowed ? "反应迟钝" : undefined;
}

/**
 * 「急性线索**跟在体征后面**」的写法。
 *
 * 中文病历里「复视、行走不稳，今天突然出现」「嘴角歪了……1小时前突然开始」是常见语序，
 * 而原判据只认线索在前，于是同一份事实换个语序就零红旗——**书面语与口语一起漏**
 * （实测：「今天突然出现复视、行走不稳」红旗 1；「复视、行走不稳，今天突然出现」红旗 0）。
 *
 * 这套写法本仓早就有一份，写在 stablePostAcuteCourse 分支里的 acuteCueAfterDeficit，
 * 只是被关在那个分支内、且只覆盖 FOCAL_NEUROLOGIC_PATTERN。提成共享常量供两处使用，
 * 不再各写各的。
 *
 * 弱线索必须带动词才算：「本次/当前/目前」单独出现不构成急性——
 * 「脑梗死后遗留左侧肢体无力3年，**本次**因失眠就诊」是残留基线复诊，不是新发卒中。
 * 强线索（新发/突发/突然/快速加重/恶化）可单独成立，但保留 无/未 的否定回看。
 */
const TRAILING_ACUTE_NEURO_CUE =
  "(?:(?:刚刚|刚才|方才|今日|今天|今晨|昨日起|本次|当前|目前)(?:突然)?(?:出现|发生|再发|复发|加重|恶化)"
  // 「反复发作」里含「复发」——substring 陷阱。前向 acuteCue 早就带着 (?<!反) 这个回看，
  // 而被提取的这份（原残留分支）没有：在那个分支里它撞不上，合并后就撞上了。
  // 实测「右侧手指麻木反复发作10余年，每年冬季发作」被判成神经系统急症，由既有套件当场抓出。
  + "|(?<!无)(?<!未)(?:新发|突发|突然|再发|(?<!反)复发|快速加重|明显加重|恶化))";

function hasAcuteExtendedStrokeWarning(text: string): boolean {
  const acuteCue = /(?:刚刚|刚才|方才|今日|今天|今晨|昨日起|近\s*(?:\d+|[一二两三四五六七八九十几两]+)\s*(?:分钟|小时|天|日)|本次|当前|目前|新发|突发|突然|再发|(?<!反)复发)/;
  const cueRequiredSign = new RegExp(
    "(?:(?:左|右|单|一|偏)侧|半身|偏身)[^。；;\\n]{0,8}(?:麻木|感觉减退|感觉丧失|偏盲)"
    + `|视物重影|复视|视野缺损|偏盲|行走不稳|站立不稳|共济失调|${governedTermAlternation(NEURO_DETECTION.colloquialFocalSigns)}`,
  );
  const selfAcuteVisualSign = /突然失明|视力骤降/;
  // extendedSign 自身含顶层 `|`；拼接时必须整体分组。未分组会让急性前缀只约束第一支，
  // 后面的“行走不稳/复视/共济失调”无论持续多久都直接命中红旗。
  // “突然失明/视力骤降”本身已编码急性变化，不再额外要求第二个急性前缀。
  const acuteExtended = new RegExp(`${acuteCue.source}.{0,24}(?:${cueRequiredSign.source})`);
  const posteriorCombination = new RegExp(`${acuteCue.source}.{0,24}(?:眩晕|头晕).{0,20}(?:复视|视物重影|行走不稳|站立不稳|共济失调|吞咽困难|构音不清)|${acuteCue.source}.{0,24}(?:复视|视物重影|行走不稳|站立不稳|共济失调).{0,20}(?:眩晕|头晕)`);
  // 后置语序：体征在前、急性线索在后。同句内（不跨 。；;）且间隔不超过 20 字。
  const acuteExtendedTrailing = new RegExp(
    `(?:${cueRequiredSign.source})[^。；;\\n]{0,20}${TRAILING_ACUTE_NEURO_CUE}`,
  );
  return hasPatternWithoutNegation(text, selfAcuteVisualSign) ||
    hasPatternWithoutNegation(text, acuteExtended) ||
    hasPatternWithoutNegation(text, acuteExtendedTrailing) ||
    hasPatternWithoutNegation(text, posteriorCombination);
}

const NEURO_EVENT_ANCHOR_SOURCE_TEXT = String.raw`脑梗(?:死|塞)?|脑卒中|卒中|中风|脑出血|脑溢血|脑血栓|脑栓塞|TIA|短暂性脑缺血发作|颅脑损伤|脑外伤|脑部手术|偏瘫`;
// 已确立的神经事件：与 NEURO_EVENT_ANCHOR_SOURCE 同一张表（2026-10-18 起；此前这里另写了一份，少了「脑梗」「偏瘫」，
//「确诊为急性脑梗…好转出院…刻下左侧肢体无力」于是不算陈旧事件、报成神经急症——逐模块验收主集 TCM-SD 438001）。
// 周围性面瘫（面神经炎、口僻）也是已确立的事件：「口角歪斜1月，住院治疗后改善出院，现仍口角歪斜」不是新发卒中（TCM-SD 436764）。
const NEURO_ESTABLISHED_EVENT_SOURCE = String.raw`(?:${NEURO_EVENT_ANCHOR_SOURCE_TEXT}|神经损伤|面神经炎|面神经麻痹|周围性面瘫|面瘫|口僻|贝尔麻痹)`;
/** 小句整体是否被否认（「无肢体无力加重」「未再发」）。只看小句开头的否定词。 */
function isNegatedClinicalClause(clause: string): boolean {
  return /^\s*(?:无|未|否认|没有|不伴)/u.test(clause) || /(?:未再|无再|未见)(?:发|发作|加重)/u.test(clause);
}

function hasStablePostAcuteNeurologicContext(text: string): boolean {
  const normalized = normalizeClinicalText(text);
  const event = NEURO_ESTABLISHED_EVENT_SOURCE;
  const hasEstablishedNeurologicEvent =
    new RegExp(`${event}[^。；;\\n]{0,28}(?:后|恢复期|康复期|后遗)`, "i").test(normalized) ||
    new RegExp(`${event}(?:恢复期|康复期|后遗症)`, "i").test(normalized) ||
    // 「突发中风偏瘫，当时伴有意识不清、头痛呕吐，经某医院住院治疗…但遗留右侧肢体无力」：事件与遗留之间隔着当时的经过，放宽到同一句 80 字。
    new RegExp(`${event}[^。；;\\n]{0,80}(?:遗留|残留)[^。；;\\n]{0,20}(?:无力|麻木|言语不清|口角歪斜|步态异常)`, "i").test(normalized) ||
    // 病案常把确诊与结局拆成相邻两句：“脑 CT 示脑梗死。经治疗后遗留……”。
    // 句号不能让同一次事件的明确治疗后遗症重新变成“当前起病不明”的急症。
    new RegExp(`${event}[^。；;\\n]{0,16}[。；;]\\s*(?:经|已)?(?:抢救|治疗|手术|康复|出院)[^。；;\\n]{0,16}(?:后)?(?:后遗|遗留|残留)`, "i").test(normalized) ||
    // 「确诊为急性脑梗，予溶栓…治疗，好转出院」：同一句里有经治疗好转出院的结局。
    new RegExp(`${event}[^。；;\\n]{0,60}(?:好转|改善|缓解)(?:后)?出院`, "i").test(normalized) ||
    // 没写病名、但起病有日期（两周以上）且已经治疗好转（「1月前…出现左侧口角歪斜…住院治疗，经治疗症状改善出院」，TCM-SD 436764）。
    /(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:周|个月|月|年)前[^。；;\n]{0,60}(?:无力|麻木|言语不清|口角歪斜|口眼歪斜|步态异常|偏瘫)[\s\S]{0,120}?(?:好转|改善|缓解)(?:后)?出院/.test(normalized);
  const hasNonAcuteCourse =
    /(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:周|个月|月|年)/.test(normalized);
  const hasCurrentStability =
    /(?:出院后|治疗后|恢复期|康复期|目前|当前|近(?:期|来|\d+个月|[一二两三四五六七八九十]+个月))[^。；;\n]{0,40}(?:病情稳定|稳定|逐渐改善|逐步恢复|无新发|未再发|无再发|无加重)/.test(normalized) ||
    /(?:病情稳定|恢复平稳|康复调理)[^。；;\n]{0,36}(?:无新发|未再发|无再发|无加重)?/.test(normalized) ||
    /(?:好转|改善|缓解)(?:后)?出院/.test(normalized);
  const explicitResidualBaseline = /(?:后遗|遗留|残留)[^。；;\n]{0,28}(?:无力|麻木|言语不清|口角歪斜|步态异常)/.test(normalized);
  const acuteChange = /(?:刚刚|刚才|今日|今天|今晨|新发|突发|突然|再发|(?<!反)复发|快速加重|明显加重|恶化)[^。；;\n]{0,28}(?:无力|麻木|言语不清|口角歪斜|步态异常)|(?:无力|麻木|言语不清|口角歪斜|步态异常)[^。；;\n]{0,20}(?:新发|再发|加重|恶化)/.test(normalized);
  return hasEstablishedNeurologicEvent && hasNonAcuteCourse && (hasCurrentStability || (explicitResidualBaseline && !acuteChange));
}

// 神经事件锚点与残留/急性线索（类别级，不含个案关键词）：用于区分「陈旧卒中残留/后遗症期」与
// 「旧卒中基础上的新发急性加重」。残留框架本身不是否定词，只是把时间轴限定为慢性基线；
// 一旦同一小句出现急性变化线索（突发/新发/再发/加重…），必须重新视为当前急症（fail-closed）。
const NEURO_EVENT_ANCHOR_SOURCE = String.raw`(?:${NEURO_EVENT_ANCHOR_SOURCE_TEXT})`;
const NEURO_RESIDUAL_MARKER_SOURCE = String.raw`(?:后遗(?:症)?(?:期)?|后遗症|遗留|残留|残存|陈旧(?:性)?|恢复期|康复期)`;
const NEURO_RESIDUAL_MARKER_PATTERN = new RegExp(NEURO_RESIDUAL_MARKER_SOURCE);
const NEURO_ACUTE_ONSET_CUE_SOURCE = String.raw`(?:刚刚|刚才|方才|今(?:日|天|晨|早|晚)|昨日|昨晚|昨夜|现在|目前|当前|本次|近日|近期|近(?:\d+|[一二两三四五六七八九十]+)\s*(?:小时|天|日|周)|新发|突发|突然|急性)`;
// “反复发作”包含连续子串“复发”，但表达的是慢性反复而不是“本次复发”。
// 复发必须排除前一字为“反”，否则冻疮/癫痫等多年反复病程会被误点燃为急性卒中。
const NEURO_ACUTE_CHANGE_CUE_SOURCE = String.raw`(?:再发|(?<!反)复发|又发|加重|恶化|进展)`;
const NEURO_ACUTE_ANY_CUE_PATTERN = new RegExp(`${NEURO_ACUTE_ONSET_CUE_SOURCE}|${NEURO_ACUTE_CHANGE_CUE_SOURCE}`, "g");
const NEURO_ACUTE_CHANGE_ONLY_PATTERN = new RegExp(`^(?:${NEURO_ACUTE_CHANGE_CUE_SOURCE})$`);
const NEURO_HISTORICAL_ANCHOR_PATTERN = /(?:既往|曾经|曾|当时|陈旧|多年前|数年前|(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:年|个月|月|周|天|日)前)/;

// 逗号/顿号级小句边界（硬句边界之内）：急性线索只在其所修饰的小句内有效，
// 避免“今天突发胸痛，既往脑梗遗留肢体无力”里胸痛的急性词跨过逗号点燃陈旧神经缺损。
function clinicalSubClauseBoundsAt(text: string, index: number, length: number): { start: number; end: number } {
  const start = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
    text.lastIndexOf("，", index - 1),
    text.lastIndexOf(",", index - 1),
  ) + 1;
  const endCandidates = ["。", "；", ";", "\n", "，", ","]
    .map((mark) => text.indexOf(mark, index + Math.max(0, length)))
    .filter((position) => position >= 0);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : text.length;
  return { start, end };
}

// 急性线索本身必须未被否定、未被既往/陈旧时间锚点限定；纯时间/起病词若与缺损之间隔着
// 残留标记（“目前遗留右侧肢体无力”），描述的是慢性基线而非急性事件，不能算急性。
// 变化类动词（加重/再发/复发/恶化/进展）不受残留标记阻断：残留基础上加重本身就是卒中警示。
function neuroAcuteCueUsableAt(text: string, cueIndex: number, cueText: string, deficitIndex: number, isChangeVerb: boolean): boolean {
  // “肢体无力”的“无”是症状名词的一部分，不是否定词；掩码后再做否定判定（与输出清洗层同一手法），
  // 否则“中风后遗留左侧肢体无力，今日突然加重”里的加重会被误判为受否定。
  const masked = text.replace(/肢体无力/g, "肢体乏力");
  if (isNegatedAt(masked, cueIndex)) return false;
  const cueBounds = clinicalSubClauseBoundsAt(masked, cueIndex, cueText.length);
  if (NEURO_HISTORICAL_ANCHOR_PATTERN.test(masked.slice(cueBounds.start, cueIndex))) return false;
  if (!isChangeVerb && cueIndex + cueText.length <= deficitIndex &&
      NEURO_RESIDUAL_MARKER_PATTERN.test(masked.slice(cueIndex + cueText.length, deficitIndex))) return false;
  return true;
}

/**
 * 神经缺损上的变化动词说的是慢性进展、不是本次急性加重（只用于局灶神经缺损；胸痛胸闷的「加重1个月」是恶化型心绞痛线索，不走这里）。
 *  · 「加重2个月」「加重伴言语不利3个月」：变化动词所在小句写的时长全在一个月以上（2026-10-19 回放：进行性共济失调、痴呆病程里的
 *    「加重伴言语不利3个月」被报神经急症）；
 *  · 「逐渐加重」「缓慢加重」：缺损本身写了一个月以上的病程（「双下肢活动不利半年，逐渐加重」）。「进行性加重」不在此列。
 * 小句里有一个月以内的时长（「加重3天」「近3天逐渐加重」）或什么时长都没写（「逐渐加重」接在无病程的缺损后）时照旧按急性。
 * 冻结令允许的确定性例外：数值阈值 + 构词式守卫。类夹具 chronic-focal-deficit-duration。
 */
function neuroChangeIsChronicProgression(text: string, cueIndex: number, cueText: string, deficitIndex: number): boolean {
  const { start, end } = clinicalSubClauseBoundsAt(text, cueIndex, cueText.length);
  const clause = text.slice(start, end);
  if (hasShortCourseSpan(clause)) return false;
  if (courseDurationDays(clause) >= CHRONIC_FOCAL_DEFICIT_DAYS) return true;
  return /(?:逐渐|渐渐|日渐|缓慢|慢慢)$/u.test(text.slice(Math.max(start, cueIndex - 2), cueIndex)) &&
    focalDeficitOwnChronicCourseAt(text, deficitIndex, focalDeficitTermAt(text, deficitIndex));
}

// 判断局灶神经缺损是否附着急性变化线索：同小句内的起病/变化词、前一小句句尾的起病短语
// （“今晨突发，右侧肢体无力”），或紧随其后小句句首的变化动词（“遗留右侧肢体无力，近2日加重”）。
function neuroAcuteChangeAttachedAt(text: string, index: number, matchText: string): boolean {
  const { start, end } = clinicalSubClauseBoundsAt(text, index, matchText.length);
  NEURO_ACUTE_ANY_CUE_PATTERN.lastIndex = 0;
  for (const match of text.slice(start, end).matchAll(NEURO_ACUTE_ANY_CUE_PATTERN)) {
    const cueIndex = start + (match.index ?? 0);
    if (cueIndex >= index && cueIndex < index + matchText.length) continue;
    const isChangeVerb = NEURO_ACUTE_CHANGE_ONLY_PATTERN.test(match[0]);
    if (neuroAcuteCueUsableAt(text, cueIndex, match[0], index, isChangeVerb) &&
        !(isChangeVerb && neuroChangeIsChronicProgression(text, cueIndex, match[0], index))) return true;
  }
  if (start > 0) {
    const prevEnd = start - 1;
    const prevStart = prevEnd > 0 ? clinicalSubClauseBoundsAt(text, prevEnd - 1, 0).start : 0;
    const prevSegment = text.slice(prevStart, prevEnd);
    const onsetAtTail = prevSegment.match(new RegExp(`(${NEURO_ACUTE_ONSET_CUE_SOURCE})(?:出现|发生)?\\s*$`));
    if (onsetAtTail?.index != null &&
        neuroAcuteCueUsableAt(text, prevStart + onsetAtTail.index, onsetAtTail[1], index, false)) return true;
  }
  if (end < text.length) {
    const nextStart = end + 1;
    const nextEnd = clinicalSubClauseBoundsAt(text, nextStart, 0).end;
    const nextSegment = text.slice(nextStart, nextEnd);
    const changeAtHead = nextSegment.match(new RegExp(`^\\s*(?:(?:${NEURO_ACUTE_ONSET_CUE_SOURCE}|且|并|又)\\s*){0,3}(?:明显|显著|逐渐|渐进)?(${NEURO_ACUTE_CHANGE_CUE_SOURCE})`));
    if (changeAtHead?.index != null &&
        neuroAcuteCueUsableAt(text, nextStart + changeAtHead[0].length - changeAtHead[1].length, changeAtHead[1], index, true) &&
        !neuroChangeIsChronicProgression(text, nextStart + changeAtHead[0].length - changeAtHead[1].length, changeAtHead[1], index)) return true;
  }
  return false;
}

// 判断局灶神经缺损是否被明确框定为陈旧/残留/后遗症期基线：脑血管事件锚点 + 残留标记
// （“脑梗后遗症期”“中风后遗”“陈旧性脑梗…遗留”），或缺损小句内直接带残留标记。
// 不含急性线索的含混表述不进入此分支，保持 fail-closed（未知起病按当前处理）。
function neuroResidualFramingAt(text: string, index: number, matchText: string): boolean {
  const hardStart = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
  ) + 1;
  const before = text.slice(hardStart, index);
  const anchoredResidual = new RegExp(
    `${NEURO_EVENT_ANCHOR_SOURCE}[^。；;\\n]{0,24}${NEURO_RESIDUAL_MARKER_SOURCE}`,
  ).test(before);
  if (anchoredResidual) return true;
  const { start } = clinicalSubClauseBoundsAt(text, index, matchText.length);
  return NEURO_RESIDUAL_MARKER_PATTERN.test(text.slice(start, index));
}

// 局限于指趾/耳垂等末梢部位、并有数月数年反复病程的麻木，常见于冻疮、周围神经病等
// 门诊场景，不能仅因前文恰有“右侧”二字就提升成卒中红旗。该豁免同时要求“慢性/反复”
// 与“末梢/对称/局限分布”两类证据；任何附着的突发、新发、加重线索仍由上游优先报警。
function sensoryDeficitIsChronicPeripheralAt(text: string, index: number, matchText: string): boolean {
  const windowStart = Math.max(0, index - 96);
  const windowEnd = Math.min(text.length, index + matchText.length + 64);
  const windowText = text.slice(windowStart, windowEnd);
  const chronicCourse = /(?:反复|间断|每年|多年|数年|长期|持续)[^。；;\n]{0,24}(?:(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:余|多)?(?:个月|月|年)|发作|存在)|(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:余|多)?(?:个月|月|年)(?:来|以上)?/.test(windowText);
  const peripheralDistribution = /(?:双(?:手|足|侧手|侧足)|手指|脚趾|指趾|耳垂|末梢|对称|局部)/.test(windowText);
  return chronicCourse && peripheralDistribution;
}

function hasOnlyStableResidualNeurologicDeficit(text: string): boolean {
  const normalized = normalizeClinicalText(text);
  if (hasNeurologicEmergencySignal(normalized)) return false;
  let sawResidual = false;
  for (const match of normalized.matchAll(new RegExp(FOCAL_NEUROLOGIC_PATTERN.source, "g"))) {
    const index = match.index ?? -1;
    if (index < 0 || isExcludedClinicalAssertionAt(normalized, index) || isNegatedAt(normalized, index)) continue;
    if (!neuroResidualFramingAt(normalized, index, match[0])) return false;
    sawResidual = true;
  }
  return sawResidual;
}

/**
 * 病程时长（天）。只认「数字/中文数字 + 周/月/年」这一构词（数值阈值例外）；「2019年」「8月25号」这类日期不算。
 * 「数/几/多」按 2 计（数月 ≈ 60 天），「半」按 0.5。
 */
const CHRONIC_FOCAL_DEFICIT_DAYS = 30;
const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function courseNumberValue(raw: string): number | undefined {
  if (/^\d+(?:\.\d+)?$/u.test(raw)) return Number(raw);
  if (raw === "半") return 0.5;
  if (/^[数几多]+$/u.test(raw)) return 2;
  const match = /^([一二两三四五六七八九])?(十)?([一二两三四五六七八九])?$/u.exec(raw);
  if (!match || (!match[1] && !match[2] && !match[3])) return undefined;
  if (!match[2]) return CN_DIGIT[match[1] || match[3]];
  return (match[1] ? CN_DIGIT[match[1]] : 1) * 10 + (match[3] ? CN_DIGIT[match[3]] : 0);
}
// 「3个多月」「7个余月」「一个半月」：量词「个」与余/多/半之间的写法也认；「N天」按天数计（「言语蹇涩32天」）。
// 2026-10-19 回放：「四肢活动不利伴言语不利3个多月」原先读不出病程，被当成起病不明的当前缺损。「日」不收（「8月25日」是日期）。
const COURSE_DURATION_SOURCE = String.raw`(?<![\d.年月])(\d+(?:\.\d+)?|[一二两三四五六七八九十半数几多]+)\s*(?:余|多)?\s*(个(?:余|多|半)?月|月|年|周|星期|天)(?![号日\d])`;
function courseSpanDays(value: number, unit: string): number {
  if (unit === "年") return value * 365;
  if (unit === "天") return value;
  if (unit === "周" || unit === "星期") return value * 7;
  return value * 30 + (unit.includes("半") ? 15 : 0);
}
function courseDurationDays(segment: string): number {
  let longest = 0;
  for (const match of segment.matchAll(new RegExp(COURSE_DURATION_SOURCE, "gu"))) {
    const value = courseNumberValue(match[1]);
    if (value == null) continue;
    if (match[2] === "年" && value >= 100) continue;
    longest = Math.max(longest, courseSpanDays(value, match[2]));
  }
  return longest;
}
/** 片段里写了一个月以内的时长（N 小时/天/日，不足 30 天的 N 周，「半个月」「半月」）。 */
const SHORT_SPAN_SOURCE = String.raw`(\d+(?:\.\d+)?|[一二两三四五六七八九十半数几]+)\s*(?:个)?(小时|天|日|周|星期)(?![号\d])`;
function hasShortCourseSpan(segment: string): boolean {
  const shortUnit = [...segment.matchAll(new RegExp(SHORT_SPAN_SOURCE, "gu"))].some((match) => {
    const value = courseNumberValue(match[1]);
    if (value == null) return false;
    const days = match[2] === "周" || match[2] === "星期" ? value * 7 : match[2] === "小时" ? value / 24 : value;
    return days < CHRONIC_FOCAL_DEFICIT_DAYS;
  });
  if (shortUnit) return true;
  return [...segment.matchAll(new RegExp(COURSE_DURATION_SOURCE, "gu"))].some((match) => {
    const value = courseNumberValue(match[1]);
    return value != null && courseSpanDays(value, match[2]) < CHRONIC_FOCAL_DEFICIT_DAYS;
  });
}
/** 起病锚点写在缺损词之前：「1年余前…出现」「半年来」「10岁起」「自幼」「多年来」。 */
function chronicOnsetAnchorBefore(segment: string): boolean {
  if (/(?:\d+|[一二两三四五六七八九十]+)\s*岁(?:时)?(?:起|开始|以来)|自幼|自小|从小|(?:多|数)年(?:来|以来)/u.test(segment)) return true;
  for (const match of segment.matchAll(new RegExp(`${COURSE_DURATION_SOURCE}\\s*(?:余|多)?\\s*(?:前|来|以来)`, "gu"))) {
    if (courseDurationDays(match[0]) >= CHRONIC_FOCAL_DEFICIT_DAYS) return true;
  }
  return false;
}
/**
 * 同一份病历里写了一个月内的加重、再发或突发（「3天前加重」「1周前…症状较前加重」）：急性加于慢性之上，慢性病程守卫让位。
 * 只看写了局灶缺损词或「症状」的句子，别处症状的近期变化不算。
 */
const RECENT_CHANGE_SOURCE = String.raw`(\d+(?:\.\d+)?|[一二两三四五六七八九十半数几]+)\s*(?:个)?(小时|天|日|周|星期)(?:前|来|内|以来)?[^。；;\n]{0,24}(?:加重|突发|突然|新发|再发|(?<!反)复发|恶化|进展)`;
function hasRecentFocalWorsening(text: string): boolean {
  return text.split(/[。；;\n]+/u).some((sentence) => {
    if (!FOCAL_NEUROLOGIC_PATTERN.test(sentence) && !/症状|(?:左|右|单|一|偏)侧[^，,]{0,6}麻木/u.test(sentence)) return false;
    return [...sentence.matchAll(new RegExp(RECENT_CHANGE_SOURCE, "gu"))].some((match) => {
      const value = courseNumberValue(match[1]);
      if (value == null) return false;
      const days = match[2] === "小时" ? value / 24 : match[2] === "周" || match[2] === "星期" ? value * 7 : value;
      // 「肢体无力」的「无」不是否定词（与 neuroAcuteCueUsableAt 同一手法：掩码后再判否定）。
      return days < CHRONIC_FOCAL_DEFICIT_DAYS && !isNegatedAt(sentence.replace(/无力/gu, "乏力"), (match.index ?? 0) + match[0].length - 2);
    });
  });
}

/**
 * 局灶神经缺损自身带着两周以上的病程（2026-10-19，r1019 红旗验收：「左侧肢体无力2年」「双下肢无力半年，右侧明显」
 *「10岁起反复出现发作性右侧偏瘫，时伴言语不清」都被报成神经急症；中风后遗症、慢性脊髓病是中医门诊的常见病种）。
 * 冻结令允许的确定性例外：数值阈值（≥30 天；NICE NG128：一周以上的 TIA 已不走 24 小时急诊通道。取一个月而不是两周，
 * 是因为语料回放里「左侧肢体活动不利伴头痛半月」（75 岁，需排除慢性硬膜下血肿）这类亚急性病例仍应先急诊评估）+ 构词式守卫。病程要么写在缺损词后
 * 同一小句 16 字内、且中间没有一个月以内的时长（「无力2年」「无力已有1年」「失语伴右上肢活动不利7个月余」「语言不利、定向力和思维能力下降1年」），
 * 要么作为起病锚点写在同一小句缺损词之前（「1年余前…出现双下肢无力」）；缺损小句以「伴/时伴/并伴/偶伴」开头时沿用上一小句的起病锚点。
 * 同一缺损在病历别处已写明是慢性的，这一处又没写自己的时间（主诉「语言不利2年」、刻下症「语言不利」），按同一个慢性缺损看
 *（sameDeficitChronicElsewhere）。附着急性或加重线索的不走这里（调用方先判）。类夹具 chronic-focal-deficit-duration。
 */
function focalDeficitHasChronicCourseAt(text: string, index: number, matchText: string): boolean {
  if (hasRecentFocalWorsening(text)) return false;
  return focalDeficitOwnChronicCourseAt(text, index, matchText) || sameDeficitChronicElsewhere(text, index, matchText);
}
function focalDeficitOwnChronicCourseAt(text: string, index: number, matchText: string): boolean {
  const { start, end } = clinicalSubClauseBoundsAt(text, index, matchText.length);
  const after = text.slice(index + matchText.length, Math.min(end, index + matchText.length + 24));
  const trailing = new RegExp(`^([^，,。；;\\n]{0,16}?)(?:已|已有|有|约|达|持续)?${COURSE_DURATION_SOURCE}`, "u").exec(after);
  if (trailing && !hasShortCourseSpan(trailing[1]) && courseDurationDays(trailing[0]) >= CHRONIC_FOCAL_DEFICIT_DAYS) return true;
  if (chronicOnsetAnchorBefore(text.slice(start, index))) return true;
  if (start > 0 && /^\s*(?:时伴|偶伴|并伴|伴有|伴|并)/u.test(text.slice(start, index))) {
    const previous = clinicalSubClauseBoundsAt(text, Math.max(0, start - 2), 0);
    return chronicOnsetAnchorBefore(text.slice(previous.start, start));
  }
  return false;
}
/** deficitIndex 处的局灶缺损词（最长匹配）；不是缺损词时返回空串。 */
function focalDeficitTermAt(text: string, index: number): string {
  return FOCAL_NEUROLOGIC_TERMS.filter((term) => text.startsWith(term, index)).sort((a, b) => b.length - a.length)[0] ?? "";
}
/** 同一缺损的写法归一：「语言不利」=「言语不利」，「蹇」=「謇」。只用于判断两处说的是不是同一个缺损。 */
function focalDeficitIdentity(term: string): string {
  return term.replace(/^语言/u, "言语").replace(/蹇/gu, "謇");
}
/** 缺损词前同一小句 8 字内写的侧别（左/右/双/四肢）；没写返回空串。 */
function focalDeficitSideAt(text: string, index: number): string {
  const { start } = clinicalSubClauseBoundsAt(text, index, 0);
  return /(左|右|双|四肢)[^，,。；;\n]{0,6}$/u.exec(text.slice(Math.max(start, index - 8), index))?.[1] ?? "";
}
/**
 * 这一处缺损没写自己的时间，而同一缺损（同一写法、侧别不冲突）在病历别处写明了一个月以上的病程或后遗症框架、且那一处没有急性线索：
 * 是同一个慢性缺损的复述（主诉写病程、刻下症或查体再写一遍）。这一处所在的句子写了一个月以内的时长（「3天来言语不利」
 *「右侧肢体活动不利，语言笨拙已有半个月」）、另一处侧别不同（「左侧肢体无力2年…右侧肢体无力」）、或缺损是意识改变时不算，照旧按当前缺损。
 */
function sameDeficitChronicElsewhere(text: string, index: number, matchText: string): boolean {
  // 意识改变不做这种继承：「经行神志不清一年」之后的「神志不清」可能就是此刻正在发作。
  if (FOCAL_NEUROLOGIC_CONCEPT_GROUPS[0].includes(matchText)) return false;
  const identity = focalDeficitIdentity(matchText);
  const side = focalDeficitSideAt(text, index);
  const mentions: Array<{ at: number; term: string }> = [];
  for (const term of FOCAL_NEUROLOGIC_TERMS) {
    if (focalDeficitIdentity(term) !== identity) continue;
    for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + term.length)) {
      const otherSide = focalDeficitSideAt(text, at);
      if (at !== index && side && otherSide && side !== otherSide) continue;
      mentions.push({ at, term });
    }
  }
  // 这一缺损只要有一处所在的句子写了一个月以内的时长（「3天来言语不利」「右侧肢体活动不利，语言笨拙已有半个月」——句尾的时长管整句），
  // 病历就是在说它是新近的，谁也不继承慢性。
  if (mentions.some(({ at }) => hasShortCourseSpan(clinicalSentenceAt(text, at)))) return false;
  return mentions.some(({ at, term }) => at !== index &&
    !isExcludedClinicalAssertionAt(text, at) && !isNegatedAt(text, at) &&
    !neuroAcuteChangeAttachedAt(text, at, term) &&
    (focalDeficitOwnChronicCourseAt(text, at, term) || neuroResidualFramingAt(text, at, term)));
}
/** index 所在的整句（句号、分号、换行之间）。 */
function clinicalSentenceAt(text: string, index: number): string {
  const start = Math.max(...["。", "；", ";", "\n"].map((mark) => text.lastIndexOf(mark, index - 1))) + 1;
  const ends = ["。", "；", ";", "\n"].map((mark) => text.indexOf(mark, index)).filter((at) => at >= 0);
  return text.slice(start, ends.length > 0 ? Math.min(...ends) : text.length);
}

function hasCurrentFocalNeurologicDeficit(text: string): boolean {
  const normalized = normalizeClinicalText(text);
  for (const term of FOCAL_NEUROLOGIC_TERMS) {
    let index = normalized.indexOf(term);
    while (index >= 0) {
      const context = clinicalAssertionContextAt(normalized, index);
      const commaSeparatedPositive = hasCommaSeparatedPositiveEvidence(normalized, index, term);
      // 急性变化线索可覆盖“既往/半年前”级的历史时间框定（旧卒中 + 今突发必须仍然报警）；
      // 残留/后遗症框架则在无急性线索时压下慢性基线缺损（陈旧脑梗遗留无力不再误报急症）。
      const acuteChangeAttached = neuroAcuteChangeAttachedAt(normalized, index, term);
      const residualFraming = !acuteChangeAttached && (neuroResidualFramingAt(normalized, index, term) ||
        focalDeficitHasChronicCourseAt(normalized, index, term));
      if (
        context.subject === "patient" &&
        context.mood === "actual" &&
        (acuteChangeAttached || (context.temporality === "current" && !residualFraming)) &&
        (!isNegatedAt(normalized, index) || commaSeparatedPositive)
      ) {
        return true;
      }
      index = normalized.indexOf(term, index + term.length);
    }
  }
  return false;
}

// 劳力性慢性稳定型胸痛/胸闷 vs 慢性背景上的急性冠脉事件（类别级，不含个案关键词）。
// 与神经残留判别同一设计：劳力诱发 + 慢性病程/稳定性锚点 = 慢性稳定基线，不报急性红旗；
// 一旦出现急性变化线索（静息/夜间发作、新发/突发、进行性加重、不缓解），即使在慢性背景上也必须报警。
const CARDIAC_EXERTIONAL_TRIGGER_PATTERN = /(?:劳力性|劳力|活动后|运动后|劳累后|快走|快步|爬坡|爬楼|上楼|登高|提重物|体力活动)/;
const CARDIAC_CHRONIC_COURSE_PATTERN = /(?:(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:年|个月|月)|多年|数年|长期)/;
const CARDIAC_STABILITY_PATTERN = /(?:稳定型心绞痛|稳定性心绞痛|规律服药|规律用药|控制稳定|病情稳定|同前|无变化|无明显变化|平素)/;
const CARDIAC_ACUTE_ONSET_CUE_SOURCE = String.raw`(?:刚刚|刚才|方才|今(?:日|天|晨|早|晚)|昨日|昨晚|昨夜|近日|近期|近(?:\d+|[一二两三四五六七八九十]+)\s*(?:小时|天|日|周)|新发|突发|突然|急性|静息|夜间|痛醒|憋醒)`;
const CARDIAC_ACUTE_CHANGE_CUE_SOURCE = String.raw`(?:再发|复发|加重|恶化|进展|不缓解|难以缓解|频发|频繁|频作|进行性)`;
const CARDIAC_ACUTE_ANY_CUE_PATTERN = new RegExp(`${CARDIAC_ACUTE_ONSET_CUE_SOURCE}|${CARDIAC_ACUTE_CHANGE_CUE_SOURCE}`, "g");
const CARDIAC_ACUTE_CHANGE_ONLY_PATTERN = new RegExp(`^(?:${CARDIAC_ACUTE_CHANGE_CUE_SOURCE})$`);

// 胸痛/胸闷/心前区痛某一具体出现位置是否附着急性变化线索：同小句、前一小句句尾起病短语、
// 或紧随其后小句句首的变化动词。线索可用性（否定/历史锚点/残留阻断）复用神经层的通用判定。
/**
 * 变化类线索（频繁、加重、复发…）写在顿号并列的另一个症状**前面**时，修饰的是那个症状，不是胸闷（2026-10-18 留出集 RobustSDT 0264：
 *「主诉胸闷、频繁肠鸣，伴脘腹喜温畏冷…」被报「急性或加重胸闷」、收回剂量）。写在并列症状**后面**的（「胸闷、心悸加重2天」）是整串的谓语，照旧算。
 * 同一形态的上一次修复是 10/14 的腹痛（程度词后跟逗号即结束）。类夹具 change-cue-on-sibling-symptom。
 * cueIndex/termIndex 是同一段文字里的下标。
 */
function changeCueHeadsSiblingSymptom(text: string, cueIndex: number, termIndex: number): boolean {
  if (termIndex < 0) return false;
  const segmentStart = text.lastIndexOf("、", cueIndex - 1) + 1;
  const nextComma = text.indexOf("、", cueIndex);
  const segmentEnd = nextComma >= 0 ? nextComma : text.length;
  const sameSegmentAsTerm = termIndex >= segmentStart && termIndex < segmentEnd;
  if (sameSegmentAsTerm) return false;
  // 只看段首：段首到线索之间没有别的字（允许空白）才算「修饰后面的那个症状」。
  return /^\s*$/u.test(text.slice(segmentStart, cueIndex)) && segmentStart > 0;
}

function cardiacAcuteChangeAttachedAt(text: string, index: number, matchText: string): boolean {
  const { start, end } = clinicalSubClauseBoundsAt(text, index, matchText.length);
  CARDIAC_ACUTE_ANY_CUE_PATTERN.lastIndex = 0;
  for (const match of text.slice(start, end).matchAll(CARDIAC_ACUTE_ANY_CUE_PATTERN)) {
    const cueIndex = start + (match.index ?? 0);
    if (cueIndex >= index && cueIndex < index + matchText.length) continue;
    const isChangeVerb = CARDIAC_ACUTE_CHANGE_ONLY_PATTERN.test(match[0]);
    if (isChangeVerb && changeCueHeadsSiblingSymptom(text.slice(start, end), cueIndex - start, index - start)) continue;
    if (neuroAcuteCueUsableAt(text, cueIndex, match[0], index, isChangeVerb)) return true;
  }
  if (start > 0) {
    const prevEnd = start - 1;
    const prevStart = prevEnd > 0 ? clinicalSubClauseBoundsAt(text, prevEnd - 1, 0).start : 0;
    const prevSegment = text.slice(prevStart, prevEnd);
    const onsetAtTail = prevSegment.match(new RegExp(`(${CARDIAC_ACUTE_ONSET_CUE_SOURCE})(?:出现|发生|发作)?\\s*$`));
    if (onsetAtTail?.index != null &&
        neuroAcuteCueUsableAt(text, prevStart + onsetAtTail.index, onsetAtTail[1], index, false)) return true;
  }
  if (end < text.length) {
    const nextStart = end + 1;
    const nextEnd = clinicalSubClauseBoundsAt(text, nextStart, 0).end;
    const nextSegment = text.slice(nextStart, nextEnd);
    const changeAtHead = nextSegment.match(new RegExp(`^\\s*(?:(?:${CARDIAC_ACUTE_ONSET_CUE_SOURCE}|且|并|又)\\s*){0,3}(?:明显|显著|逐渐|渐进)?(${CARDIAC_ACUTE_CHANGE_CUE_SOURCE})`));
    if (changeAtHead?.index != null &&
        neuroAcuteCueUsableAt(text, nextStart + changeAtHead[0].length - changeAtHead[1].length, changeAtHead[1], index, true)) return true;
  }
  return false;
}

/**
 * 「每次胸闷持续数分钟至十余分钟」说的是**每次发作多长**，不是「持续不缓解」（2026-10-14）。
 *
 * 下面的小句线索把「持续」「N分钟」都当作急性线索，于是「半年来反复胸闷…每次胸闷持续数分钟至十余分钟，可自行缓解，近期无加重。
 * 无胸痛放射，无大汗，无夜间憋醒」报了「急性或加重胸闷」红旗、收回剂量（合成评测 S020，教材胸痹·痰浊闭阻的典型病历）。
 * 这正是稳定型心绞痛的定义写法：卫生行业标准 WS 319-2010「1 个月～3 个月内相对稳定」；《稳定性冠心病诊断与治疗指南》（2018）
 * 描述发作「持续数分钟至10余分钟」。不稳定型心绞痛与急诊转诊的界线是单次持续超过 20 分钟（ESC、WS 319）、静息或夜间发作、
 * 新发或近期加重（见 ~/runlogs/fix1014/research/C-western-criteria-chestpain.md）。
 *
 * 守卫只在三件事同时成立时把这段发作时长从小句里拿掉，其余线索照旧判：
 *  · 写法是「每次 / 发作时 + 时长」，且时长上限不到 20 分钟（「十余分钟」按 15 分钟计，「数分钟」按 5 分钟计）；
 *  · 病历写了一个月以上的反复发作病程；
 *  · 病历没有写（未被否认的）静息、夜间憋醒、痛醒。
 * 冻结令允许的确定性例外：数值阈值 + 构词式词法守卫。类目样例：scripts/fixtures/open-language-classes/chronic-stable-chest-tightness-episode-duration.json。
 */
const EPISODE_DURATION_PHRASE = /(?:每次|每回|每次发作|发作时)[^，,。；;]{0,8}?(?:持续|历时|约)?[^，,。；;\d一二两三四五六七八九十数几半]{0,3}?((?:\d+(?:\.\d+)?|[一二两三四五六七八九十]+|数|几|十余|十几|半)\s*(?:分钟|分)?(?:\s*(?:至|到|~|～|—|-)\s*(?:\d+(?:\.\d+)?|[一二两三四五六七八九十]+|数|几|十余|十几))?\s*(?:分钟|分))/;
const CHRONIC_RECURRENT_COURSE = /(?:(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:个)?(?:月|年)(?:来|余|以来|多)?|半年|多年|数年)[^。；;]{0,12}?(?:反复|发作|阵发)|(?:反复|阵发)[^。；;]{0,12}?(?:(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:个)?(?:月|年)|半年|多年|数年)/;
const CHINESE_DIGIT: Readonly<Record<string, number>> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function episodeDurationUpperMinutes(span: string): number | undefined {
  const values = [...span.matchAll(/\d+(?:\.\d+)?|十余|十几|[一二两三四五六七八九十]+|数|几|半/g)].map(([token]) => {
    if (/^\d/.test(token)) return Number(token);
    if (token === "十余" || token === "十几") return 15;
    if (token === "数" || token === "几") return 5;
    if (token === "半") return 0.5;
    if (token.length === 1) return CHINESE_DIGIT[token];
    if (token.startsWith("十")) return 10 + (CHINESE_DIGIT[token.slice(1)] || 0);
    if (token.endsWith("十")) return (CHINESE_DIGIT[token[0]] || 0) * 10;
    return (CHINESE_DIGIT[token[0]] || 0) * 10 + (CHINESE_DIGIT[token[2]] || 0);
  }).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : undefined;
}

function withoutStableEpisodeDuration(subClause: string, wholeText: string): string {
  const phrase = subClause.match(EPISODE_DURATION_PHRASE);
  if (!phrase) return subClause;
  const upper = episodeDurationUpperMinutes(phrase[1]);
  if (upper == null || upper >= 20) return subClause;
  if (!CHRONIC_RECURRENT_COURSE.test(wholeText)) return subClause;
  if (hasPatternWithoutNegation(wholeText, /静息|夜间憋醒|憋醒|痛醒/)) return subClause;
  return subClause.replace(phrase[0], "");
}

/**
 * Chest tightness is common in respiratory, digestive and anxiety presentations. Unlike current
 * chest pain, an isolated current mention is not by itself a high-specificity ACS floor. Acute
 * authority therefore requires an onset/change cue attached to the chest-tightness subclause.
 * This prevents another symptom's modifier in “头晕加重，伴胸闷” from crossing the comma and
 * falsely becoming “胸闷加重”, while preserving “胸闷近一周明显加重/今晨突发胸闷”.
 */
function hasScopedAcuteChestTightnessSignal(text: string): boolean {
  const normalized = normalizeClinicalText(text);
  const term = "胸闷";
  let index = normalized.indexOf(term);
  const scopedCue = new RegExp(
    `${CARDIAC_ACUTE_ONSET_CUE_SOURCE}|${CARDIAC_ACUTE_CHANGE_CUE_SOURCE}|` +
    String.raw`(?:持续|未缓解|无缓解|没有缓解|压榨|濒死|\d+(?:\.\d+)?\s*(?:分钟|分|小时|h|H)|半小时|数小时)`,
    "g",
  );
  while (index >= 0) {
    if (
      !isExcludedClinicalAssertionAt(normalized, index) &&
      (!isNegatedAt(normalized, index) || hasCommaSeparatedPositiveEvidence(normalized, index, term)) &&
      !isHistoricalOrResolvedAt(normalized, index, term.length)
    ) {
      if (cardiacAcuteChangeAttachedAt(normalized, index, term)) return true;
      const { start, end } = clinicalSubClauseBoundsAt(normalized, index, term.length);
      const scoped = withoutStableEpisodeDuration(normalized.slice(start, end).replace(NON_NEGATING_PHRASES, ""), normalized);
      const termAt = scoped.indexOf(term);
      for (const match of scoped.matchAll(scopedCue)) {
        if (CARDIAC_ACUTE_CHANGE_ONLY_PATTERN.test(match[0]) && changeCueHeadsSiblingSymptom(scoped, match.index ?? 0, termAt)) continue;
        return true;
      }
    }
    index = normalized.indexOf(term, index + term.length);
  }
  return false;
}

// 单个胸痛/胸闷出现位置是否被框定为劳力性慢性稳定基线：本小句带劳力诱发词，
// 且同一硬句内有慢性病程（2年/数月/多年）或稳定性/管理锚点（稳定型心绞痛/规律服药/控制同前）。
function cardiacMentionIsChronicStableAt(text: string, index: number, matchText: string): boolean {
  const { start, end } = clinicalSubClauseBoundsAt(text, index, matchText.length);
  if (!CARDIAC_EXERTIONAL_TRIGGER_PATTERN.test(text.slice(start, end))) return false;
  const hardStart = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
  ) + 1;
  const hardEndCandidates = ["。", "；", ";", "\n"]
    .map((mark) => text.indexOf(mark, index + matchText.length))
    .filter((position) => position >= 0);
  const hardEnd = hardEndCandidates.length > 0 ? Math.min(...hardEndCandidates) : text.length;
  const hardClause = text.slice(hardStart, hardEnd);
  return CARDIAC_CHRONIC_COURSE_PATTERN.test(hardClause) || CARDIAC_STABILITY_PATTERN.test(hardClause);
}

// 整段文本是否只有「劳力性慢性稳定」一种胸痛/胸闷叙事：每个未被排除/否定的提及都必须是
// 慢性稳定框架，且没有任何提及附着急性变化线索。任一提及是急性或含混（无劳力框架）→ false，
// 维持原有急性信号判定（fail-closed 保守报警）。
function hasChronicStableExertionalCardiacOnly(text: string): boolean {
  const normalized = normalizeClinicalText(text);
  let sawMention = false;
  // 受治理 cardiac.symptoms 共 6 条，此前这里只手抄了 3 条（缺 胸口压迫 / 胸骨后压榨感 / 胸口疼）。
  // 本函数的契约是「**所有**心血管提及都是慢性稳定」才降级，只巡查一半词表会两头出错：
  //  · 漏检向：病历同时写「胸痛3年劳累诱发（慢性稳定）」与「今日胸骨后压榨感（急性）」时，
  //    循环只看到胸痛、判定全部慢性稳定 ⇒ 降级生效，而那个急性症状**从未被检查过**；
  //  · 误报向：纯口语「胸口疼3年、劳累诱发、休息缓解」不在枚举内 ⇒ sawMention 恒假 ⇒
  //    不降级，稳定性心绞痛病人每次复诊都弹红旗。
  // 收敛成读受治理表，两头同时修正。
  for (const term of GOVERNED_CARDIAC_SYMPTOMS) {
    let index = normalized.indexOf(term);
    while (index >= 0) {
      if (!isExcludedClinicalAssertionAt(normalized, index) && !isNegatedAt(normalized, index)) {
        sawMention = true;
        if (!cardiacMentionIsChronicStableAt(normalized, index, term)) return false;
        if (cardiacAcuteChangeAttachedAt(normalized, index, term)) return false;
      }
      index = normalized.indexOf(term, index + term.length);
    }
  }
  return sawMention;
}

function firstPatternMatchWithoutNegation(text: string, pattern: RegExp): { index: number; text: string } | undefined {  const source = pattern.source;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(source, flags);
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    if (isExcludedClinicalAssertionAt(text, index)) continue;
    if ((!isNegatedAt(text, index) || hasCommaSeparatedPositiveEvidence(text, index, match[0])) &&
        !isHistoricalOrResolvedAt(text, index, match[0].length)) return { index, text: match[0] };
  }
  return undefined;
}

/**
 * 突发头痛（雷击样头痛线索）。2026-10-18 起排除一种形态：「突发」领起的是一串并列的外感症状，头痛只是其中一项，同一小句有鼻塞、
 * 流涕、喷嚏、咽痛、恶寒恶风这类外感症状，且没有剧烈、爆炸样之类的程度词（逐模块验收主集 RobustSDT 0098：「今晨起突发鼻塞、头痛，
 * 伴流清涕、频繁喷嚏…恶风明显」被报「突发剧烈头痛、意识或神经功能异常」）。「突发头痛」「突发剧烈头痛」「突发头晕、头痛、呕吐」照旧算。
 * 类夹具 sudden-headache-in-cold-symptom-list。
 */
const SUDDEN_HEADACHE = /(?:突发|突然|雷击|爆炸).{0,8}头痛/gu;
const COLD_SYMPTOM_IN_CLAUSE = /鼻塞|流(?:清|浊)?涕|喷嚏|咽痛|咽痒|恶寒|恶风|畏风|怕风/u;
const HEADACHE_SEVERITY = /剧烈|剧痛|爆炸|炸裂|撕裂|难以忍受|无法忍受|最严重|从未有过|雷击/u;
function hasSuddenHeadacheSignal(text: string): boolean {
  if (!hasPatternWithoutNegation(text, /(?:突发|突然|雷击|爆炸).{0,8}头痛/)) return false;
  for (const match of text.matchAll(SUDDEN_HEADACHE)) {
    const at = match.index ?? 0;
    const clauseStart = Math.max(...["。", "；", ";", "\n"].map((mark) => text.lastIndexOf(mark, at - 1))) + 1;
    const ends = ["。", "；", ";", "\n"].map((mark) => text.indexOf(mark, at + match[0].length)).filter((index) => index >= 0);
    const clause = text.slice(clauseStart, ends.length > 0 ? Math.min(...ends) : text.length);
    const coldList = /[、，,]/u.test(match[0]) && COLD_SYMPTOM_IN_CLAUSE.test(clause) && !HEADACHE_SEVERITY.test(clause);
    if (!coldList && hasPatternWithoutNegation(match[0], /(?:突发|突然|雷击|爆炸).{0,8}头痛/)) return true;
  }
  return false;
}

function hasNeurologicEmergencySignal(text: string): boolean {
  const normalized = normalizeClinicalText(text);
  if (hasPatternWithoutNegation(normalized, CATASTROPHIC_NEUROLOGIC_EVENT_PATTERN)) return true;
  if (hasAcutePositiveTerm(normalized, ACUTE_CONSCIOUSNESS_CHANGE_TERMS)) return true;
  const stablePostAcuteCourse = hasStablePostAcuteNeurologicContext(normalized);
  const extendedStrokeWarning = hasAcuteExtendedStrokeWarning(normalized);
  const unilateralSensoryMatch = firstPatternMatchWithoutNegation(
    normalized,
    /(?:(?:左|右|单|一|偏)侧|半身|偏身)[^。；;\n]{0,12}(?:麻木|感觉减退|感觉丧失|偏盲)/,
  );
  // 与局灶缺损同一判别口径：陈旧/残留框架下的慢性感觉缺损不报急症；附着急性变化线索时仍报。
  const activeUnilateralSensoryDeficit = unilateralSensoryMatch != null &&
    (neuroAcuteChangeAttachedAt(normalized, unilateralSensoryMatch.index, unilateralSensoryMatch.text) ||
      (!neuroResidualFramingAt(normalized, unilateralSensoryMatch.index, unilateralSensoryMatch.text) &&
        !focalDeficitHasChronicCourseAt(normalized, unilateralSensoryMatch.index, unilateralSensoryMatch.text) &&
        !sensoryDeficitIsChronicPeripheralAt(normalized, unilateralSensoryMatch.index, unilateralSensoryMatch.text)));
  if (stablePostAcuteCourse) {
    // 陈旧事件基础上本次新出现或加重的缺损（「1月前…改善出院，今日突然右侧肢体无力」）：逐小句看，小句里有起病/加重线索和缺损、
    // 又没有「N月前、当时、既往」这类历史锚点时就是急症。下面两条正则漏掉了不带「左/右侧」限定、或线索与缺损隔着「出现」的写法
    //（2026-10-18 把陈旧事件的认法放宽时由反证找到；放宽之前这类病历走下面的「当前缺损默认算急症」，不受影响）。
    const clauseAcuteChange = normalized.split(/[。；;\n，,]/u).some((clause) => {
      if (NEURO_HISTORICAL_ANCHOR_PATTERN.test(clause)) return false;
      if (!/无力|麻木|言语不清|言语不利|口角歪斜|口眼歪斜|步态|偏瘫|视物模糊|视物不清|复视|吞咽困难|饮水呛咳/u.test(clause)) return false;
      // 线索本身被否认（「近三个月无新发口角歪斜」「未再发」）不算：按本文件同一个否认判据看线索所在位置。
      return [...clause.matchAll(/(?:刚刚|刚才|今日|今天|今晨|今早|昨晚|昨夜|新发|突发|突然|再发|(?<!反)复发|又发|加重|恶化)/gu)]
        .some((cue) => !isNegatedAt(clause, cue.index ?? 0) && !isNegatedClinicalClause(clause.slice(Math.max(0, (cue.index ?? 0) - 3))));
    });
    if (clauseAcuteChange) return true;
    const acuteCueBeforeDeficit = new RegExp(`(?:刚刚|刚才|方才|今日|今天|今晨|昨日起|近\\s*(?:\\d+|[一二两三四五六七八九十几两]+)\\s*(?:小时|天|日)|本次|当前|目前|新发|突发|突然|再发|复发|快速加重|明显加重).{0,20}(?:出现|发生|再发|复发|加重)?[^。；;\\n]{0,8}${FOCAL_NEUROLOGIC_PATTERN.source}`);
    const acuteCueAfterDeficit = new RegExp(`${FOCAL_NEUROLOGIC_PATTERN.source}[^。；;\\n]{0,20}${TRAILING_ACUTE_NEURO_CUE}`);
    return extendedStrokeWarning || hasPatternWithoutNegation(text, acuteCueBeforeDeficit) || hasPatternWithoutNegation(text, acuteCueAfterDeficit) ||
      hasPatternWithoutNegation(text, new RegExp(`(?:病情|康复)(?:原本|曾经|一直)?稳定[^。；;\\n]{0,30}(?:但|然而|现|目前|当前)[^。；;\\n]{0,12}${FOCAL_NEUROLOGIC_PATTERN.source}[^。；;\\n]{0,8}(?:加重|恶化|再发|复发)`));
  }
  const explicitAcuteChange = hasCurrentFocalNeurologicDeficit(text);
  if (explicitAcuteChange) return true;
  if (extendedStrokeWarning) return true;
  if (activeUnilateralSensoryDeficit) return true;
  // Unknown-onset focal deficits are current by default. Historical, negated, conditional, or
  // non-patient mentions must not be promoted back to an emergency by this deterministic floor.
  return hasCurrentFocalNeurologicDeficit(text);
}

// 陈旧/既往标记：一个「心电图正常」「已急诊评估排除」若被这些词限定，说明是既往/历史结论，
// 不能用来清除本次的活动性急性表现（否则会出现 fail-open：陈旧正常心电图漏报当前急性胸痛）。
const CARDIAC_STALENESS_MARKERS = /(既往|曾经|曾有|曾|陈旧|以前|之前|从前|过去|当年|当时|去年|前年|昨日|昨天|昨晨|昨晚|昨夜|前日|前天|上[周月次年]|前几[天日]|(?:24|二十四)\s*(?:小时|h)前|(?:[一二两三四五六七八九十半数几多]|\d+)\s*(?:年|个月|月|周|天|日|小时)前|多年前)/;

function hasApplicableRelativeStaleness(beforeClearance: string): boolean {
  const regex = new RegExp(CARDIAC_STALENESS_MARKERS.source, "g");
  let last: RegExpMatchArray | undefined;
  for (const match of beforeClearance.matchAll(regex)) last = match;
  if (!last || last.index == null) return false;
  const tail = beforeClearance.slice(last.index + last[0].length);
  // “曾有心前区痛，已由心内科明确非急症”中的历史词修饰症状，不修饰逗号后的当前结论。
  if (/(胸痛|心前区痛|胸闷|气促|呼吸困难|晕厥|黑矇|意识丧失)/.test(tail)) return false;
  // 明确的本次/今日锚点重新开启当前临床结论。
  if (/(今日|今天|本次|当前|现在|目前).{0,16}$/.test(tail)) return false;
  return true;
}

function hasStaleAbsoluteDate(value: string): boolean {
  const clinicalDateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const clinicalPart = (type: "year" | "month" | "day") => Number(clinicalDateParts.find((part) => part.type === type)?.value);
  const currentYear = clinicalPart("year");
  const currentMonth = clinicalPart("month");
  const currentDay = clinicalPart("day");
  const full = value.match(/(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})(?:日)?/);
  // 无年份只接受明确的中文月日写法；裸“36.6”“122/76”更可能是体温或血压，不能按日期处理。
  const partial = full ? null : value.match(/(?:^|[^\d])(\d{1,2})月(\d{1,2})日/);
  if (!full && !partial) return false;
  const year = full ? Number(full[1]) : currentYear;
  const month = Number(full ? full[2] : partial![1]);
  const day = Number(full ? full[3] : partial![2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const invalid = date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day;
  if (invalid) return true;
  const clinicalToday = Date.UTC(currentYear, currentMonth - 1, currentDay);
  // 只认中国临床时区的“今天”；昨天及更早是陈旧证据，未来日期是无效证据，均不能清除当前红旗。
  return date.getTime() !== clinicalToday;
}

function isStaleAt(text: string, index: number, matchText = ""): boolean {
  const hardClauseStart = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("\n", index - 1),
  ) + 1;
  const hardClauseEndCandidates = ["。", "；", ";", "\n"]
    .map((mark) => text.indexOf(mark, index + matchText.length))
    .filter((position) => position >= 0);
  const hardClauseEnd = hardClauseEndCandidates.length > 0 ? Math.min(...hardClauseEndCandidates) : text.length;
  const hardClause = text.slice(hardClauseStart, hardClauseEnd);
  const hardBefore = text.slice(hardClauseStart, index);
  const softClauseStart = Math.max(text.lastIndexOf("，", index - 1), text.lastIndexOf(",", index - 1), hardClauseStart - 1) + 1;
  const before = text.slice(Math.max(softClauseStart, index - 32), index);
  const after = text.slice(index + matchText.length, index + matchText.length + 32);
  const windowText = `${before}${matchText}${after}`;
  return CARDIAC_STALENESS_MARKERS.test(windowText) || hasApplicableRelativeStaleness(hardBefore) || hasStaleAbsoluteDate(hardClause);
}

// 返回未被否定、且未被陈旧/既往标记限定的最后一个匹配的结束位置（无则 -1）。
function lastPatternEndFresh(text: string, pattern: RegExp): number {
  const source = pattern.source;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(source, flags);
  let lastEnd = -1;
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? -1;
    const clauseStart = Math.max(text.lastIndexOf("。", index - 1), text.lastIndexOf("；", index - 1), text.lastIndexOf(";", index - 1), text.lastIndexOf("\n", index - 1)) + 1;
    const polarityWindow = `${text.slice(Math.max(clauseStart, index - 12), index)}${match[0]}`;
    const uncertainOrPending = /(尚未|不能|未能|无法|未予|建议|需|待|考虑)/.test(polarityWindow);
    if (index < 0 || uncertainOrPending || isNegatedAt(text, index) || isStaleAt(text, index, match[0])) continue;
    lastEnd = Math.max(lastEnd, index + match[0].length);
  }
  return lastEnd;
}

function acuteCardiacClearanceBoundary(text: string): number {
  const normalized = normalizeClinicalText(text);
  // 清除只认「本次/近期」的临床评估与客观检查；陈旧/既往结论不清除当前急性表现（fail-closed）。
  const clinicianClearedEnd = lastPatternEndFresh(
    normalized,
    /(?:(?:(?:今日|今天|本次|当前|已|已经|经|由)[^，,。；;\n]{0,8})?(?:急诊|心内科|心血管|医院|医生|专科|上级医院).{0,24}(?:已明确排除|明确排除|已排除|评估后明确排除|评估明确排除|评估排除|评估为|诊断为|会诊明确).{0,24}(?:非急症|非急危重|急性冠脉|ACS|心梗|心肌梗死|急性心血管事件|危险|危急|肋软骨炎)|(?:今日|今天|本次|当前)?(?:已|已经)?明确(?:由|经)(?:急诊|心内科|心血管|医院|医生|专科|上级医院).{0,12}排除.{0,12}(?:急性冠脉|ACS|心梗|心肌梗死|急性心血管事件|危险|危急)|(?:今日|今天|本次|当前)?(?:已|已经)?明确排除.{0,12}(?:急性冠脉|ACS|心梗|心肌梗死|急性心血管事件|危险|危急).{0,12}(?:经|由)?(?:急诊|心内科|心血管|医院|医生|专科|上级医院)(?:确认|评估确认))/i,
  );
  // 单次心电图和肌钙蛋白不能脱离采样时序、连续检测与临床路径独立排除 ACS。
  return clinicianClearedEnd;
}

function hasCurrentOrRecurrentPositiveTerm(text: string, terms: string[]): boolean {
  const normalized = normalizeClinicalText(text);
  const cue = /(本次|本轮|现在|现|目前|当前|今日|今天|再发|复发|仍有|仍感|持续|加重|突发|突然|新发|未缓解|无缓解|没有缓解|\d+(?:\.\d+)?\s*(?:分钟|分|小时|h|H)|半小时|数小时)/;
  const postCue = /(仍有|仍感|持续|再发|复发|未缓解|无缓解|没有缓解|未见缓解|尚未缓解|没有好转|无好转|未改善|没有改善|加重|压榨|濒死|\d+(?:\.\d+)?\s*(?:分钟|分|小时|h|H)|半小时|数小时)/;
  for (const term of terms) {
    let index = normalized.indexOf(term);
    while (index !== -1) {
      if (isExcludedClinicalAssertionAt(normalized, index)) {
        index = normalized.indexOf(term, index + term.length);
        continue;
      }
      if (hasAnaphoricRecurrenceAfter(normalized, index, term)) return true;
      if (!isNegatedAt(normalized, index) || hasCommaSeparatedPositiveEvidence(normalized, index, term)) {
        // A current-time word inside a resolved phrase such as "目前无再发"
        // must not reactivate a historical symptom. True recurrence remains positive
        // because isHistoricalOrResolvedAt returns false when the symptom has recurred.
        if (isHistoricalOrResolvedAt(normalized, index, term.length)) {
          index = normalized.indexOf(term, index + term.length);
          continue;
        }
        const clause = clinicalClauseBounds(normalized, index);
        const start = Math.max(clause.start, index - 24);
        const end = Math.min(clause.end, index + term.length + 28);
        const windowText = normalized.slice(start, end).replace(NON_NEGATING_PHRASES, "");
        const after = normalized.slice(index + term.length, end).replace(NON_NEGATING_PHRASES, "");
        if (cue.test(windowText) || postCue.test(after)) return true;
      }
      index = normalized.indexOf(term, index + term.length);
    }
  }
  return false;
}

function hasPositiveCardiacSignalAfterClearance(text: string, clearanceBoundary: number): boolean {
  const normalized = normalizeClinicalText(text);
  const afterClearance = normalized.slice(Math.max(0, clearanceBoundary));
  return (
    hasCurrentOrRecurrentPositiveTerm(afterClearance, [...GOVERNED_CARDIAC_SYMPTOMS, ...GOVERNED_CARDIAC_COMPANIONS]) ||
    hasRecentPositiveTerm(afterClearance, GOVERNED_CARDIAC_SYMPTOMS) ||
    hasAcutePositiveTerm(afterClearance, GOVERNED_CARDIAC_SYMPTOMS) ||
    (hasAnyTerm(afterClearance, GOVERNED_CARDIAC_SYMPTOMS) && hasAnyTerm(afterClearance, GOVERNED_CARDIAC_COMPANIONS))
  );
}

const MENTAL_HEALTH_CRISIS_TERMS = [
  "自杀", "轻生", "想死", "不想活", "不愿活", "活不下去", "寻短见", "一了百了", "不想醒来",
  "结束生命", "自伤", "割腕", "跳楼", "服毒", "伤害自己", "伤害他人", "他伤",
];

function hasCurrentMentalHealthCrisis(text: string): boolean {
  for (const term of MENTAL_HEALTH_CRISIS_TERMS) {
    let index = text.indexOf(term);
    while (index >= 0) {
      const before = text.slice(Math.max(0, index - 24), index);
      const after = text.slice(index + term.length, index + term.length + 64);
      const recommendationOnly = /(?:筛查|询问|评估|排除|关注|观察|监测|风险|预防)[^。；;\n]{0,10}$/.test(before);
      const historicalNowNegative = /(?:既往|曾经|曾有|过去|多年前|上次)[^。；;\n]{0,16}$/.test(before) &&
        /(?:目前|当前|现在|现)[^。；;\n]{0,24}(?:否认|无|没有|未见)[^。；;\n]{0,12}(?:意念|想法|计划|行为|倾向|再发)?/.test(after);
      const excludedContext = isExcludedClinicalAssertionAt(text, index) || isHistoricalOrResolvedAt(text, index, term.length);
      if (!isNegatedAt(text, index) && !excludedContext && !recommendationOnly && !historicalNowNegative) return true;
      index = text.indexOf(term, index + term.length);
    }
  }
  return false;
}

function mentalHealthSafetyScreenRequired(text: string): boolean {
  return hasAnyTerm(text, ["情绪低落", "明显抑郁", "重度抑郁", "绝望", "无望", "活着没意思", "兴趣丧失", "精神崩溃", "严重焦虑"]);
}

function hasExplicitMentalHealthSafetyScreen(text: string): boolean {
  return /(?:否认|无|没有|未见|未出现|从无)[^。；;\n]{0,24}(?:自杀|轻生|想死|不想活|不愿活|活不下去|寻短见|一了百了|不想醒来|自伤|伤害自己|伤害他人|他伤)(?:意念|想法|计划|行为|倾向)?/.test(text) ||
    /(?:自杀|轻生|想死|不想活|不愿活|活不下去|寻短见|一了百了|不想醒来|自伤|伤害自己|伤害他人|他伤)(?:意念|想法|计划|行为|倾向)?[^。；;\n]{0,16}(?:阴性|否认|无|没有|未见)/.test(text);
}

function insomniaPresentation(text: string): boolean {
  return hasAnyTerm(text, ["失眠", "入睡困难", "难以入睡", "易醒", "早醒", "睡眠差", "睡眠障碍"]);
}

function hasExplicitOsaScreen(text: string): boolean {
  const domains = [/(?:打鼾|鼾声)/, /(?:睡眠中)?呼吸暂停|憋醒/, /(?:白天|日间)(?:嗜睡|困倦|疲乏)/, /高血压|血压/];
  return domains.filter((pattern) => {
    const match = text.match(pattern);
    if (!match || match.index == null) return false;
    // 「需询问打鼾」「打鼾不详」不算已筛查：与病历读法、闸门同一个未评估判据（unassessedMentionAt）。
    return !unassessedMentionAt(normalizeClinicalText(text), match.index);
  }).length >= 3;
}

function thyroidScreenRequired(text: string): boolean {
  const triggerGroups = [
    ["心悸", "心动过速", "脉搏快"],
    ["体重下降", "消瘦", "体重增加"],
    ["怕热", "怕冷", "多汗", "手抖", "震颤", "突眼"],
    ["焦虑", "烦躁"],
  ];
  return triggerGroups.filter((terms) => hasAnyTerm(text, terms)).length >= 2;
}

function hasCurrentThyroidAssessment(text: string): boolean {
  return /(?:本次|近期|近一个月|当前|今日|今天)?[^。；;\n]{0,12}(?:甲功|甲状腺功能|TSH|FT3|FT4)[^。；;\n]{0,28}(?:正常|未见异常|异常|升高|降低|阳性|阴性|待复查|待检查)/i.test(text);
}

/**
 * 重度高血压（≥180/120）是否伴急性靶器官表现（2026-10-19，用户决定，依据 2017 ACC/AHA 高血压指南 §11.2 与 ACEP 临床政策：
 * 无急性靶器官损害的重度高血压是「高血压急迫/重度无症状高血压」，处置是尽快在门诊复测并调整降压治疗，不是急诊；
 * 合并胸痛、呼吸困难、神经功能缺损、意识改变、视物异常、剧烈或突发头痛（或头痛伴呕吐）、抽搐、少尿时才是高血压急症）。
 * 冻结令允许的确定性例外：有限闭集（靶器官症状词）+ 数值阈值。症状须为当前、非否定、非既往（hasPatternWithoutNegation）；
 * 神经缺损借用 hasNeurologicEmergencySignal（陈旧/残留缺损不算急性靶器官表现）。妊娠/产褥期另由 ≥160/110 的产科规则处理；
 * 未满 18 岁照旧按急症（AAP 2017：青少年 >180/120 即刻转急诊，不论有无症状）。
 * 返回命中的表现（用于红旗文案），没有返回 undefined。类夹具 asymptomatic-severe-hypertension。
 */
const PEDIATRIC_SEVERE_HYPERTENSION = "未满18岁";
export function severeHypertensionTargetOrganSign(state: CaseState): string | undefined {
  // 未满 18 岁不适用成人口径：AAP 2017 儿童高血压指南要求 2 级高血压超过第 95 百分位 30mmHg（青少年 >180/120）即刻转急诊，
  // 不论有无症状。儿童一律按「伴急症」处理，红旗照旧。
  if (isPediatricPatient(state)) return PEDIATRIC_SEVERE_HYPERTENSION;
  const text = normalizeClinicalText(trustedInputText(state));
  for (const [label, pattern] of HYPERTENSIVE_TARGET_ORGAN_SIGNS) {
    if (hasAffirmedTargetOrganSign(text, pattern)) return label;
  }
  if (hasNeurologicEmergencySignal(text)) return "神经功能异常";
  // 神经功能缺损的其余写法（语言不利、四肢/双下肢活动不利、面瘫、共济失调、不能行走）：当前、非否定、
  // 且不是一个月以上的陈旧缺损（focalDeficitHasChronicCourseAt / neuroResidualFramingAt）时算。
  // 语料回放：「语言不利1天，血压220/130」「四肢活动不利，语言蹒跚已有三天，血压200/96」不能因为这条改动失去红旗。
  for (const match of text.matchAll(HYPERTENSIVE_NEURO_DEFICIT_LANGUAGE)) {
    const index = match.index ?? -1;
    if (index < 0 || !targetOrganMatchAffirmed(text, index, match[0])) continue;
    if (focalDeficitHasChronicCourseAt(text, index, match[0]) || neuroResidualFramingAt(text, index, match[0])) continue;
    return "神经功能异常";
  }
  return undefined;
}
const HYPERTENSIVE_NEURO_DEFICIT_LANGUAGE = /(?:四肢|双下肢|下肢|上肢|肢体|半身|单侧|一侧|左侧|右侧)[^，,。；;\n]{0,3}(?:活动不利|无力|不遂|瘫)|偏瘫|言语(?:不清|不利|謇涩)|语言(?:不利|謇涩|蹒跚|不清)|口角歪斜|口眼歪斜|面瘫|共济失调|上睑(?:下垂|麻痹)|不能(?:走路|行走|站立)/gu;
/** 「偶有胸闷」「时有头痛加重」：否定词沿逗号串进来时（「无头痛，心慌，偶有胸闷」），紧挨着的「偶有/时有/伴有/有」以它为准。 */
function targetOrganMatchAffirmed(text: string, index: number, matchText: string): boolean {
  if (isExcludedClinicalAssertionAt(text, index)) return false;
  // 「1天前…头痛加重」是本次起病，不是既往：同一句里锚在 7 天以内的不按既往排除。
  const sentenceStart = Math.max(...["。", "；", ";", "\n"].map((mark) => text.lastIndexOf(mark, index - 1))) + 1;
  const recentAnchor = [...text.slice(sentenceStart, index).matchAll(/(\d+|[一二两三四五六七])\s*(?:个)?(小时|天|日)前/gu)]
    .some((match) => match[2] === "小时" || (courseNumberValue(match[1]) ?? 99) <= 7);
  if (!recentAnchor && isHistoricalOrResolvedAt(text, index, matchText.length)) return false;
  if (/(?:偶有|时有|常有|伴有|有时|伴|仍有|出现)$/u.test(text.slice(Math.max(0, index - 3), index))) return true;
  return !isNegatedAt(text, index) || hasCommaSeparatedPositiveEvidence(text, index, matchText);
}
function hasAffirmedTargetOrganSign(text: string, pattern: RegExp): boolean {
  return [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))]
    .some((match) => match.index != null && targetOrganMatchAffirmed(text, match.index, match[0]));
}

/**
 * 「反复/多次/再次/再发/复发」修饰出血时，只在两种情况下算活动性出血的严重度证据（2026-10-19，r1019 红旗验收：
 *「近1月反复出现便血色红」「痔疮反复便血」「反复便血2年，色鲜红，量少」都被报成活动性消化道出血）：
 *  · 出血是上消化道的（呕血、黑便/柏油样便、咖啡样物）；
 *  · 同一句里有 7 天以内的时间窗（今日、昨日、刚刚、近日、这几天、近 N 天、N 天、1 周、N 小时，N≤7）——「反复便血20余年，加重1周」
 *    「多年来反复便血，最近几天又出现了复发」仍报。
 * 量的修饰（大量、喷射、不止）与头晕、晕厥等灌注不足伴随症不受影响。冻结令允许的确定性例外：数值阈值 + 有限闭集。
 * 依据：BSG 2019 下消化道出血指南（Oakland 评分≤8 可门诊处理）——少量、慢性、鲜红色便血不是急诊处置对象。
 * 类夹具 gi-bleed-recurrence-recent-window。
 */
const GI_BLEED_RECURRENCE_WORD = /^(?:反复|多次|再次|再发|复发)$/u;
const RECENT_BLEED_WINDOW = /今(?:日|天|晨|早|晚)|昨(?:日|天|晚|夜)|刚刚|刚才|近日|(?:最近|近|这)(?:几|数)(?:天|日)|数日来|(?:近\s*)?(\d+(?:\.\d+)?|[一二两三四五六七八九十半]+)\s*(?:个)?(小时|天|日|周|星期)(?:来|内|以来|前)?/gu;
function giBleedRecurrenceCountsAsActive(text: string, at: number, bleedText: string): boolean {
  if ([...conceptGroupTerms("呕血"), ...conceptGroupTerms("黑便")].some((term) => bleedText.includes(term)) || /咖啡/u.test(bleedText)) return true;
  const sentenceStart = Math.max(...["。", "；", ";", "\n"].map((mark) => text.lastIndexOf(mark, at - 1))) + 1;
  const endCandidates = ["。", "；", ";", "\n"].map((mark) => text.indexOf(mark, at)).filter((index) => index >= 0);
  const sentence = text.slice(sentenceStart, endCandidates.length > 0 ? Math.min(...endCandidates) : text.length);
  for (const match of sentence.matchAll(new RegExp(RECENT_BLEED_WINDOW.source, "gu"))) {
    if (!match[1]) return true;
    const value = courseNumberValue(match[1]);
    const days = value == null ? undefined : match[2] === "周" || match[2] === "星期" ? value * 7 : value;
    if (days != null && (match[2] === "小时" || days <= 7)) return true;
  }
  return false;
}

export function detectProgrammaticRedFlags(state: CaseState): string[] {
  const text = trustedInputText(state);
  const redFlags: string[] = [];
  // 医生对急症筛查题选了阳性选项：选项本身是泛指句，必须连同题干才知道确认了什么。
  for (const confirmed of confirmedRiskScreeningCategories(state.conversation)) {
    redFlags.push(`追问已由医生确认存在下列急症表现之一（${confirmed.question.replace(/[？?]\s*$/, "")}），请立即完成急诊或转诊评估`);
  }
  // The semantic ensemble owns broad natural-language triage. These few catastrophic narrative
  // checks are an always-on lower bound: a signed empty model result can never erase an already
  // explicit time-sensitive emergency. This layer only adds; same-episode clearance remains handled
  // by the existing temporal/polarity contract below.
  const measurements = currentVitalMeasurements(state);
  const bp = measurements.bloodPressure;
  const temp = measurements.temperature;
  const pulse = measurements.pulse;
  const respiration = measurements.respiration;
  const spo2 = measurements.spo2;
  const invertedCriticalBp = measurements.invertedCriticalBloodPressure;
  if (hasCurrentMentalHealthCrisis(text)) {
    redFlags.push("已出现自杀、自伤或伤害他人的意念/计划/行为线索，需立即进行现场安全评估并联系精神专科或急诊处置，不得仅依赖自动分级");
  }
  const explicitCurrentTcmCriticalPattern = text
    .split(/[。；;\n]+/)
    .map((clause) => clause.trim())
    .some((clause) => {
      if (!hasPatternWithoutNegation(clause, /戴阳证|阴盛格阳|脉微欲绝/)) return false;
      const historicalOnly = /(?:既往|曾经|曾有|上次|过去|多年前)/.test(clause) &&
        !/(?:当前|目前|现见|现为|本次|今日|仍|再次|复发)/.test(clause);
      return !historicalOnly;
    });
  if (explicitCurrentTcmCriticalPattern) {
    redFlags.push("病历明确记录当前危重中医证候术语（戴阳、阴盛格阳或脉微欲绝），需立即核实意识、呼吸、循环和生命体征并急诊评估；不得仅据课程方证自行处置");
  }
  if (invertedCriticalBp) {
    redFlags.push(`血压录入 ${invertedCriticalBp.first}/${invertedCriticalBp.second}mmHg 疑似收缩压/舒张压倒置且包含危急值，不能静默纠正；需立即规范复测并按高血压危象或循环风险完成现场评估`);
  }

  const colloquialChestPressureSignal = hasPatternWithoutNegation(
    text,
    new RegExp(
      "(?:胸口|胸前|胸部|胸骨后|心口|心前区).{0,10}(?:(?:像|跟|如同).{0,5})?(?:石头|重物|东西)?"
      + `(?:压着|压住|压得|压迫|发紧|勒紧|箍紧|堵得慌|闷得慌|${governedTermAlternation(CARDIAC_DETECTION.colloquialPressureVerbs)})`,
    ),
  );
  const chestPainSignal = hasAnyTerm(text, GOVERNED_CARDIAC_PAIN_SYMPTOMS) || colloquialChestPressureSignal;
  const chestTightnessSignal = hasAnyTerm(text, ["胸闷"]);
  // 劳力性慢性稳定型（劳力诱发 + 慢性病程/规律服药/控制稳定，无急性变化线索）不是急性冠脉
  // 待排情形，降级急性信号；静息/夜间/新发/突发/加重/不缓解等急性线索附着时不受影响。
  const chronicStableExertionalCardiacOnly = hasChronicStableExertionalCardiacOnly(text);
  const acuteChestPainSignal = !chronicStableExertionalCardiacOnly && (
    hasAcutePositiveTerm(text, GOVERNED_CARDIAC_PAIN_SYMPTOMS) ||
    hasRecentPositiveTerm(text, GOVERNED_CARDIAC_PAIN_SYMPTOMS) ||
    hasCurrentOrRecurrentPositiveTerm(text, GOVERNED_CARDIAC_PAIN_SYMPTOMS) ||
    (colloquialChestPressureSignal && /(?:突然|突发|刚才|刚刚|新发|开始|持续|不缓解|无缓解|冷汗|大汗|气促|呼吸困难|\d+(?:\.\d+)?\s*(?:分钟|分|小时))/.test(text)));
  const acuteChestTightnessSignal =
    !chronicStableExertionalCardiacOnly && hasScopedAcuteChestTightnessSignal(text);
  const cardiacCompanion = hasAnyTerm(text, [...GOVERNED_CARDIAC_COMPANIONS, "一身汗", "压榨", "濒死"]);
  const cardiacClearanceBoundary = acuteCardiacClearanceBoundary(text);
  const cardiacCleared = cardiacClearanceBoundary >= 0;
  const activeCardiacAfterClearance = cardiacCleared && hasPositiveCardiacSignalAfterClearance(text, cardiacClearanceBoundary);
  const cardiacClearanceApplies = cardiacCleared && !activeCardiacAfterClearance;
  const acuteAbdominalSignal = hasAcuteAbdominalSignal(text);
  const anaphylacticAirwaySignal = hasAnaphylacticAirwayEmergency(text);
  // 出血词一律从概念分组取，不再在这里手抄第二份完整词表。
  // 手抄那份只有「黑便/柏油样便」这类书面语，于是「拉的大便又黑又亮，人发晕」确定性红旗为 0；
  // 而同一批口语在 POSITIVE_FACT_EQUIVALENT_GROUPS 与 clinical-facts 里明明都收着——
  // 词在库里，检出口读不到，是本轮反复出现的同一种缺陷。
  const bleedTerms = giBleedConceptAlternation();
  const recurrentGiBleedingSignal = text
    .split(/[，,。；;\n]+/)
    .some((clause) => {
      const match = clause.match(new RegExp(`(?:再次|再发|复发)[^。；;\\n]{0,12}(${bleedTerms})`));
      const clauseAt = text.indexOf(clause);
      return Boolean(match) && hasPatternWithoutNegation(clause, new RegExp(`(?:再次|再发|复发)[^。；;\\n]{0,12}(?:${bleedTerms})`)) &&
        giBleedRecurrenceCountsAsActive(text, Math.max(0, clauseAt) + (match?.index ?? 0), match?.[1] ?? "");
    });
  const combinedUpperAndLowerGiBleedingSignal =
    hasAnyTerm(text, [...conceptGroupTerms("呕血")]) && hasAnyTerm(text, [...conceptGroupTerms("黑便"), ...conceptGroupTerms("便血")]);
  // 伴随症词表**保持原样**，不加「没力气/人发晕/脸色发白」这类口语面孔。
  //
  // 我一度按「口语与书面语同权」把它们加了进去，闸门当场红：
  // test-clinical-facts 有一条刻意的断言——「老人家最近大便发黑好几天了，人也没力气」
  // 在模型不可用时**只能形成非阻断提示，不得取得硬红旗门权**。
  // 那不是漏检，是 T6 的既定边界（gi_bleed 的 hardGateRequires 要求
  // active_or_recurrent_bleeding_with_severity_evidence），口语档由 narrativeFallbackAdvisories 承接。
  // 也就是说我原先「口语消化道出血确定性层零检出」的判断读窄了：确定性层是covered 的，
  // 只是按设计走提示档而非硬门档。真正的缺口只在**词表没收「又黑又亮」这批口语**，
  // 那一条已在概念分组里补齐——提示档因此覆盖到了，硬门边界一寸未动。
  const bleedSeverityCompanion = "[2-9]\\s*次|两次|三次|大量|反复|多次|再次|再发|复发|喷射|不止"
    + "|头晕|乏力|晕厥|黑矇|意识改变|冷汗|心悸|面色苍白";
  // 严重度伴随症必须**自身是阳性**。原实现把出血词与伴随症拼成一条正则，
  // 否定判定只落在出血词的位置上，于是「服用铁剂后大便发黑，无头晕乏力，复查便潜血阴性」
  // 照样判成活动性出血——伴随症被整句否认了，判据却读成阳性证据。
  // 这类误报的代价不是多一条提示：医生一旦发现红旗会对着「无头晕乏力」乱响，就会开始忽略红旗。
  // 判定形状与原实现**逐字一致**（出血词 + 20 字窗 + 伴随症拼成一条正则，整段过否定扫描），
  // 只多加一道减法：段内的伴随症本身若被否定，这一段不算严重度证据。
  //
  // 为什么必须保持原形状：共享否定作用域的逃生门 hasCommaSeparatedPositiveEvidence 是拿
  // **整段**来判「否认」辖不辖到这一项的——「否认腹痛，黑便伴头晕」正是靠段尾的「头晕」
  // 判出「否认」只辖腹痛。改成先找出血词再找伴随症、只把出血词传进逃生门，这条既有断言当场变红。
  const bleedSeverityAffirmed = (() => {
    const combined = new RegExp(
      `(?:${bleedTerms})[^。；;\\n]{0,20}(?:${bleedSeverityCompanion})`, "g",
    );
    const companionMatcher = new RegExp(bleedSeverityCompanion, "g");
    for (const match of text.matchAll(combined)) {
      const start = match.index ?? -1;
      if (start < 0) continue;
      if (isExcludedClinicalAssertionAt(text, start)) continue;
      if (isNegatedAt(text, start) && !hasCommaSeparatedPositiveEvidence(text, start, match[0])) continue;
      if (isHistoricalOrResolvedAt(text, start, match[0].length)) continue;
      // 「服用铁剂后大便发黑，无头晕乏力，复查便潜血阴性」——伴随症整句被否认，
      // 原实现照样判成活动性出血。红旗对着「无头晕乏力」乱响，医生很快就会不再看红旗。
      //
      // 判据是**紧邻否定**，不是 isNegatedAt：后者按共享作用域判，
      // 在「否认腹痛，黑便伴头晕」里会把「头晕」也算进「否认」的辖域（实测把这条既有断言打红），
      // 而那句里「否认」明明只辖腹痛。只看伴随症所在的那一个逗号分段里有没有否定词，
      // 就能把这两句分开：前者分段是「无头晕乏力」，后者是「黑便伴头晕」。
      const affirmedCompanion = [...match[0].matchAll(companionMatcher)].some((companion) => {
        const at = start + (companion.index ?? 0);
        const segmentStart = Math.max(
          ...["，", ",", "。", "；", ";", "\n", "、"].map((mark) => text.lastIndexOf(mark, at - 1)),
          start - 1,
        ) + 1;
        if (/(?:否认|无|未见|未|没有|不伴|排除)/.test(text.slice(segmentStart, at))) return false;
        return !GI_BLEED_RECURRENCE_WORD.test(companion[0]) ||
          giBleedRecurrenceCountsAsActive(text, at, match[0].match(new RegExp(`^(?:${bleedTerms})`))?.[0] ?? "");
      });
      if (!affirmedCompanion) continue;
      return true;
    }
    return false;
  })();
  // 「大量/反复/喷射…」是修饰出血词本身的限定语，仍走原口径——但否定必须在**出血词**的位置也判一次。
  // 原实现只在匹配起点（限定语）判否定，而限定语修饰的未必是出血词：「反复上腹痛1年，无呕血黑便」
  // 里「反复」说的是腹痛，16 字窗却跨过逗号和「无」把它接到「呕血」上，消化科最常规的一句阴性症状
  // 就成了活动性出血红旗（2026-10-13 甲方反流病例实测）。判法与上面 bleedSeverityAffirmed 一致。
  const qualifiedGiBleedingSignal = (() => {
    const qualifier = /大量|反复|多次|再次|再发|复发|喷射|不止|持续出血/g;
    const bleedHere = new RegExp(`^(?:${bleedTerms})`);
    for (const head of text.matchAll(qualifier)) {
      const start = head.index ?? -1;
      if (start < 0) continue;
      if (isExcludedClinicalAssertionAt(text, start)) continue;
      const windowStart = start + head[0].length;
      // 窗口内的每个出血词都看一遍：「反复上腹痛，无呕血，近2天黑便」第一个出血词被否认、第二个是阳性。
      for (let offset = 0; offset <= 16; offset += 1) {
        const bleedAt = windowStart + offset;
        if (bleedAt >= text.length || /[。；;\n]/.test(text[bleedAt])) break;
        const found = text.slice(bleedAt).match(bleedHere);
        if (!found) continue;
        const span = text.slice(start, bleedAt + found[0].length);
        if (isNegatedAt(text, start) && !hasCommaSeparatedPositiveEvidence(text, start, span)) break;
        if (isNegatedAt(text, bleedAt) && !hasCommaSeparatedPositiveEvidence(text, bleedAt, found[0])) continue;
        if (isHistoricalOrResolvedAt(text, start, span.length)) continue;
        if (GI_BLEED_RECURRENCE_WORD.test(head[0]) && !giBleedRecurrenceCountsAsActive(text, start, found[0])) continue;
        return true;
      }
    }
    return false;
  })();
  const activeGiBleedingSignal =
    recurrentGiBleedingSignal || combinedUpperAndLowerGiBleedingSignal ||
    hasCoffeeGroundEmesis(text) || bleedSeverityAffirmed || qualifiedGiBleedingSignal;
  const activeObstetricHemorrhageSignal =
    hasPatternWithoutNegation(text, /(?:孕|妊娠|怀孕)[^。；;\n]{0,40}(?:大量|大出血|持续|反复|鲜红色|血块|浸湿)[^。；;\n]{0,12}(?:阴道)?(?:出血|流血)/) ||
    hasPatternWithoutNegation(text, /(?:阴道)?(?:出血|流血)[^。；;\n]{0,30}(?:大量|大出血|持续|反复|鲜红色|血块|浸湿)[^。；;\n]{0,30}(?:孕|妊娠|怀孕)/);
  // 妊娠 20 周以后的阴道流血（产前出血）不论量多少都要当日产科评估，排除前置胎盘、胎盘早剥（数值阈值：孕周≥20）。
  // 此前只认「大量/持续/血块」这类量词：「妊娠37周，晨起发现阴道流血，多于月经量」（Claude 评审 A 集 A-eme-0142）的红旗
  // 只靠把「胎心率150」误读成孕妇脉搏才出来。「见红」在足月是临产先兆，不算。
  const gestationalWeeks = Number(text.match(/(?:孕|妊娠|怀孕)\s*(\d{2})(?:\s*\+\s*\d)?\s*周/u)?.[1] ?? NaN);
  const antepartumBleedingSignal = Number.isFinite(gestationalWeeks) && gestationalWeeks >= 20 && gestationalWeeks <= 42 &&
    hasPatternWithoutNegation(text, /阴道[^。；;\n，,]{0,6}(?:出血|流血)/u);
  // 非妊娠活动性大量阴道出血同样属于 bleeding 硬门。旧实现只有产科分支，且只认连续短语
  // 「阴道大量出血」；真实病案常写成「阴道出血21天，量多」「阴道流血不止，面色苍白」，
  // 甚至已经给出血色素 66g/L。三个信号都在病例里时，旧门仍然红旗为零。
  //
  // 症状词从受治理 bleeding 类的「阴道大量出血」派生（只去掉程度词），严重度仍需独立满足：
  // 明确量多/持续/反复/血块，或循环灌注表现，或血红蛋白/血色素 <=70g/L。少量点滴、
  // 已止旧史与否定表述不能取得硬门权。
  const vaginalBleedingPattern = GOVERNED_VAGINAL_BLEEDING_TERMS.join("|") || "阴道(?:出血|流血)";
  const governedMajorVaginalBleedingPattern = GOVERNED_MAJOR_VAGINAL_BLEEDING_TERMS.join("|");
  const governedMajorVaginalBleedingAffirmed = governedMajorVaginalBleedingPattern
    ? hasPatternWithoutNegation(text, new RegExp(`(?:${governedMajorVaginalBleedingPattern})`))
    : false;
  const vaginalBleedingAffirmed = governedMajorVaginalBleedingAffirmed ||
    hasPatternWithoutNegation(text, new RegExp(`(?:${vaginalBleedingPattern})`));
  const majorBleedingSeverity = [
    ...GOVERNED_SEVERE_TERMS,
    "量多", "大出血", "持续", "反复", "不止", "鲜红", "血块", "浸湿",
  ].join("|");
  const severityNearVaginalBleeding =
    hasPatternWithoutNegation(text, new RegExp(
      `(?:${vaginalBleedingPattern})[^。；;\\n]{0,40}(?:${majorBleedingSeverity})`,
    )) ||
    hasPatternWithoutNegation(text, new RegExp(
      `(?:${majorBleedingSeverity})[^。；;\\n]{0,20}(?:${vaginalBleedingPattern})`,
    ));
  const criticalHemoglobin = [...text.matchAll(
    /(?:血红蛋白|血色素|HGB|Hb(?!A1c))\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:g\s*\/\s*L|g\/L)?/gi,
  )].some((match) => Number(match[1]) > 0 && Number(match[1]) <= 70);
  // 重度血小板减少（2026-10-19 A 集 A-non-0046：「反复牙龈出血和月经增多半年…PLT 13×109/L」只给了「出血优先复核」，照常给剂量）。
  // 数值阈值（冻结规则允许的例外）：ASH 2019 成人 ITP 指南——新诊断且 PLT<20×10⁹/L 建议住院（有条件推荐），已知 ITP、
  // 无出血者可门诊随访。这里取：PLT<10 直接报；10–<20 须同时有当前皮肤黏膜或脏器出血才报。
  // 单位写法：×10^9/L、×10⁹/L、上标丢失的「×109/L」、G/L 或不带单位；「13万/μl」是 130×10⁹/L，不收；「最低/曾/既往」的读数、
  // 输血量（「1u」「1治疗量」）不收。
  const severeThrombocytopeniaCount = (() => {
    for (const match of text.matchAll(/(?:血小板(?:计数)?|PLT)\s*(?:[(（]\s*PLT\s*[)）])?\s*[:：]?\s*(\d+(?:\.\d+)?)(?!\s*(?:\.\d|万|\d|u\b|U\b|单位|治疗量|袋|ml|mL|毫升|次|%))/giu)) {
      const value = Number(match[1]);
      const at = match.index ?? 0;
      if (!(value >= 0 && value < 20)) continue;
      // 「×10^11/L」「×10^12/L」是旧单位或别的计数（2.1×10^11/L = 210×10⁹/L），不收；「×10^3/μL」与 ×10⁹/L 同值。
      const exponent = text.slice(at + match[0].length).match(/^\s*[×xX*]\s*10\s*(?:\^|⁹|¹)?\s*(\d{0,2})/u)?.[1];
      if (exponent && exponent !== "9" && exponent !== "3") continue;
      const clauseStart = Math.max(...["，", ",", "。", "；", ";", "\n"].map((mark) => text.lastIndexOf(mark, at - 1))) + 1;
      // 「输注/机采血小板1u」是输血量（语料回放 T16-MR-08715），不是计数。
      if (/(?:最低|曾|既往|以往|此前|治疗前|入院时|输注?|机采)/u.test(text.slice(Math.max(clauseStart, at - 12), at + 3))) continue;
      if (isHistoricalOrResolvedAt(text, at, match[0].length)) continue;
      return value;
    }
    return undefined;
  })();
  const thrombocytopeniaBleeding = severeThrombocytopeniaCount !== undefined && (severeThrombocytopeniaCount < 10 ||
    hasPatternWithoutNegation(text, /(?:出血|流血|瘀斑|瘀点|紫癜|鼻衄|齿衄|月经(?:增多|量多|过多)|便血|血尿|咯血|呕血|黑便)/u));
  const bleedingCompanionAffirmed = GOVERNED_BLEEDING_COMPANIONS.some((term) =>
    hasPatternWithoutNegation(text, new RegExp(term)));
  const activeMajorVaginalBleedingSignal = vaginalBleedingAffirmed &&
    (governedMajorVaginalBleedingAffirmed || severityNearVaginalBleeding || criticalHemoglobin || bleedingCompanionAffirmed);
  // 14 岁以下儿童、病程写明为反复/数月以上、又没有任何急性线索（突发、加重、持续不缓解…）时，胸闷/胸痛伴气促不按急性冠脉事件报
  //（2026-10-24 第十八轮基层病例 B059：9 岁「反复咳嗽、喘息半年，夜间明显…偶尔伴胸闷气促」、FeNO 升高的过敏性哮喘被报急性心血管事件）。
  // 年龄与病程是数值/闭集守卫（冻结规则允许的例外）；急性胸痛、急性胸闷两路不受影响，成人不变。
  const caseAgeYears = numberFromClinicalText(patientAgeText(withPatientObject(state)));
  const chronicPediatricChestSymptom = caseAgeYears != null && caseAgeYears < 14 && !acuteChestPainSignal && !acuteChestTightnessSignal &&
    /(?:反复|多年|半年|数月|长期|(?:\d+|[一二两三四五六七八九十])\s*(?:个)?(?:月|年))/u.test(text);
  const cardiacRiskFlagged = !cardiacClearanceApplies && !chronicPediatricChestSymptom &&
    (acuteChestPainSignal || (chestPainSignal && cardiacCompanion) || acuteChestTightnessSignal || (chestTightnessSignal && cardiacCompanion));
  const reportableCardiacRisk = cardiacRiskFlagged;
  if (reportableCardiacRisk) {
    redFlags.push(((acuteChestTightnessSignal || chestTightnessSignal) && cardiacCompanion) || (chestPainSignal && cardiacCompanion)
      ? "胸痛/胸闷伴大汗、放射痛或气促，需排除急性心血管事件"
      : acuteChestTightnessSignal
        ? "急性或加重胸闷已出现，需先排除急性冠脉综合征等心血管风险"
      : "短时程、新发、突发或持续胸痛/心前区痛已出现，即使暂未记录伴随症状，也需先排除急性心血管事件");
  }
  // 理由按实际命中的那一项写（2026-10-19 Claude 评审 H 集：十余例没有任何头痛记录的卒中、抽搐、脊髓病例，
  // 不给剂量的理由都写「突发剧烈头痛、意识或神经功能异常」，读起来像病人有剧烈头痛）。后半句不变，按「神经系统急症」归类的地方照旧认得。
  const suddenHeadacheSignal = hasSuddenHeadacheSignal(text);
  const neurologicEmergencySignal = hasNeurologicEmergencySignal(text);
  if (suddenHeadacheSignal || neurologicEmergencySignal) {
    redFlags.push(suddenHeadacheSignal && neurologicEmergencySignal
      ? "突发剧烈头痛伴意识或神经功能异常，需优先排除神经系统急症"
      : suddenHeadacheSignal
        ? "突发剧烈头痛，需优先排除神经系统急症"
        : "意识或神经功能异常，需优先排除神经系统急症");
  } else if (hasMeningealSign(text)) {
    redFlags.push("脑膜刺激征阳性（颈抵抗、克氏征或布氏征），需优先排除脑膜炎、蛛网膜下腔出血等神经系统急症");
  }
  if (acuteAbdominalSignal) {
    redFlags.push("急性、突发或剧烈腹痛/腹胀已出现，需先排除急腹症等风险");
  }
  if (anaphylacticAirwaySignal) {
    redFlags.push("急性过敏反应伴喉头或上气道肿胀线索，需立即评估气道、呼吸和循环并急诊处置");
  }
  // 脱出物或疝块不能还纳（嵌顿）：T6 other_critical.detection.incarcerationSigns；否认、既往走 hasPatternWithoutNegation。
  if (text.split(/[。；;\n]+/u).some((sentence) =>
    /(?:\d+|[一二两三四五六七八九十半])\s*(?:个)?(?:小时|天|日|周)|今日|今天|昨日|昨天|突然|突发|加重|剧痛/u.test(sentence) &&
    hasPatternWithoutNegation(sentence, new RegExp(governedTermAlternation(TRAUMA_DETECTION.incarcerationSigns))))) {
    redFlags.push("脱出物或疝块不能还纳（嵌顿），有绞窄坏死风险，需急诊或肛肠/外科专科评估");
  }
  if (hasAcuteTraumaFracture(text)) {
    redFlags.push("外伤后3天内的骨折，需先急诊或骨科处置（固定、评估出血与神经血管损伤），再评估中药处方");
  }
  if (activeGiBleedingSignal) {
    redFlags.push("当前呕血、咖啡样呕吐物、黑便或便血提示活动性消化道出血风险，需立即评估循环状态并急诊处置");
  }
  const syncopeEcgFinding = syncopeWithHighRiskEcgFinding(text);
  if (syncopeEcgFinding) {
    redFlags.push(`晕厥伴心电记录的高危心律失常（${syncopeEcgFinding}），需立即心内科急诊评估（心电监护，必要时临时起搏）`);
  }
  if (thrombocytopeniaBleeding) {
    redFlags.push(`重度血小板减少（PLT ${severeThrombocytopeniaCount}×10⁹/L）${(severeThrombocytopeniaCount ?? 0) < 10 ? "" : "伴出血表现"}，有严重自发出血风险，需血液科急诊评估`);
  }
  // 上气道水肿场景下的「吞咽困难」已由过敏红旗完整承接，不再重复成第二条告警；
  // 出血已单独成条时也不叠加——同一事件两条告警会让医生开始忽略告警本身。
  // 括号里只写命中的那一类（2026-10-19 Claude 评审 M 集 SD-433219：理由列出全部三类，注意事项据此写成「已有吞咽梗阻、消瘦等警示征象」，
  // 病历并无吞咽梗阻）。「上消化道警示征象（」这个开头不变，按它归类的地方照旧认得。
  const upperGiAlarmKind = upperGiAlarmFeatureKind(text);
  // 体重下降同时咯血、痰中带血：红旗照报，但要查的首先是肺（结核、肺癌），不写「上消化道…内镜」（2026-10-24 甲方 100 例 C005：
  // 63 岁吸烟者咯血 1 周、体重下降 5kg、食欲差，红旗写成上消化道警示征象，评审判标签错）。
  const respiratoryBleeding = upperGiAlarmKind === "weight_loss" &&
    hasPatternWithoutNegation(text, /咯血|咳血|痰血|痰中[^，,。；;\n]{0,4}带[^，,。；;\n]{0,4}血/u);
  if (upperGiAlarmKind && !anaphylacticAirwaySignal && respiratoryBleeding) {
    redFlags.push("咯血伴体重下降，需优先完成胸部CT与痰检以排除肺癌或肺结核，再评估处方");
  } else if (upperGiAlarmKind && !anaphylacticAirwaySignal) {
    const item = upperGiAlarmKind === "obstruction" ? "吞咽或进食梗阻" : upperGiAlarmKind === "malignancy" ? "恶性肿瘤病史伴消化道症状" : "不明原因体重下降";
    redFlags.push(`上消化道警示征象（${item}）已出现，需优先安排内镜或影像评估以排除梗阻、复发与占位，再评估处方`);
  }
  if (activeObstetricHemorrhageSignal) {
    redFlags.push("妊娠期活动性大量阴道出血提示产科急症，需立即转产科急诊评估");
  } else if (antepartumBleedingSignal) {
    redFlags.push(`妊娠${gestationalWeeks}周阴道流血，需立即转产科急诊评估（排除前置胎盘、胎盘早剥）`);
  }
  if (activeMajorVaginalBleedingSignal && !activeObstetricHemorrhageSignal && !antepartumBleedingSignal) {
    redFlags.push("活动性大量阴道出血伴持续/反复、重度贫血或循环灌注风险，需立即评估失血量与循环状态并急诊处置");
  }
  const breathingDistressSignal =
    hasAnyTerm(text, ["端坐呼吸", "不能平卧", "无法平卧", "喘不上气",
      ...RESPIRATORY_DETECTION.colloquialSymptoms]) ||
    hasColloquialOrthopnea(text) ||
    hasPatternWithoutNegation(text, /(?:说|讲)(?:半句|一句|几句话).{0,12}(?:停|歇|喘)|(?:静息|坐着不动).{0,8}(?:呼吸困难|气促|喘憋)/);
  // 中心性发绀的查体写法（「口唇发绀」「口唇轻紫绀」「口唇面颊轻度发绀」）：部位与词表都在 T6 respiratory.detection。
  const centralCyanosisSignal = hasAnyTerm(text, ["口唇发紫", "嘴唇发紫"]) ||
    hasPatternWithoutNegation(text, new RegExp(
      `(?:${governedTermAlternation(RESPIRATORY_DETECTION.centralCyanosisSites)})[^，,。；;\\n无未不否没]{0,4}(?:${governedTermAlternation(RESPIRATORY_DETECTION.centralCyanosisTerms)})`,
    ));
  // 同一份病历实测血氧 ≥94%（静息、未吸氧时中心性发绀一般在 SpO2 85% 以下才出现）：「口唇略发绀」是慢性或外周表现，不单凭它报急症
  //（2026-10-24 第十八轮基层病例 B017：慢阻肺稳定期「口唇略发绀」「指脉氧96%」被报呼吸循环急症）。数值阈值，冻结规则允许的例外；
  // 呼吸困难/端坐呼吸那一半不受影响，血氧 ≤89% 仍由生命体征红旗报。
  const cyanosisWithNormalOxygen = centralCyanosisSignal && spo2 != null && spo2 >= 94;
  const acuteRespiratorySignal = breathingDistressSignal || (centralCyanosisSignal && !cyanosisWithNormalOxygen);
  // 胸痛/胸闷伴气促时，心血管红旗文案已经完整承接呼吸循环风险；避免同一事件重复成两条告警。
  // 只有发绀、没有呼吸困难的写法时，理由写发绀（2026-10-19 Claude 评审 M 集 SD-451922：病历只有「口唇发绀、爪甲青紫」，
  // 理由却是「突发或快速加重呼吸困难/端坐呼吸」）。判定（报不报）不变。
  if (acuteRespiratorySignal && !reportableCardiacRisk && !anaphylacticAirwaySignal) {
    redFlags.push(breathingDistressSignal
      ? "突发或快速加重呼吸困难/端坐呼吸，需优先评估呼吸循环急症"
      : "口唇发绀等中心性发绀表现，需优先评估血氧与呼吸循环急症");
  }
  // 产科语境的重度高血压阈值独立于通用危急值：妊娠期/产褥期收缩压≥160 或舒张压≥110 即为
  // 重度（子痫前期/子痫谱系），常伴持续头痛、视物异常、右上腹痛。通用 180/120 阈值覆盖不到
  // 这一段（实测产后10天 BP 170/112 + 剧烈头痛 + 视物异常未触发任何确定性红旗）。
  // 妊娠判定走**受治理谓词**，不在这里自写第三份正则。
  // 原来这里是 /妊娠|怀孕|孕\d+(?:周|月)|.../ ——「孕」后必须跟数字，于是门诊最常见的
  // 「孕妇」「孕晚期」「有身孕」一律判不出。实测：BP 170/112 + 剧烈头痛 + 视物模糊，
  // 主诉写「孕32周」触发重度子痫前期红旗，写「孕妇」则**零红旗**。同一个病人，换个写法就没了。
  // assessPregnancyState 已经覆盖这批口语写法，且带否定/既往/备孕的排除（不孕症、否认妊娠、
  // 既往孕2产1、备孕中全判非阳性），比这里自写的强得多——同一判据不该有两份实现。
  // 产褥期是**另一个概念**（子痫前期谱系延伸到产后6周），不属于妊娠谓词，单列。
  const pregnancyStatus = assessPregnancyState(text).status;
  const obstetricContext = pregnancyStatus === "positive" || pregnancyStatus === "possible"
    || hasPatternWithoutNegation(text, /产后|产褥|分娩后|坐月子|剖宫产后|顺产后/);
  const obstetricSevereHypertension = Boolean(
    obstetricContext && bp && (bp.systolic >= 160 || bp.diastolic >= 110),
  );
  if (obstetricSevereHypertension && bp) {
    redFlags.push(`妊娠/产褥期血压 ${bp.systolic}/${bp.diastolic}mmHg 达重度高血压标准（≥160/110），需立即按子痫前期/子痫风险急诊评估，尤其伴头痛、视物异常或上腹痛时`);
  }
  const pediatricVitals = pediatricVitalReferenceForCase(state);
  const criticalBp = bp && bloodPressureIsCritical(bp, pediatricVitals) ? bp : null;
  if (criticalBp && !obstetricSevereHypertension) {
    if (criticalBp.systolic >= 180 || criticalBp.diastolic >= 120) {
      // 重度高血压只有合并急性靶器官表现时才是急症（见 severeHypertensionTargetOrganSign）；没有时走 measuredVitalAdvisories 的醒目提示。
      const targetOrgan = severeHypertensionTargetOrganSign(state);
      if (targetOrgan === PEDIATRIC_SEVERE_HYPERTENSION) {
        redFlags.push(`血压 ${criticalBp.systolic}/${criticalBp.diastolic}mmHg 达重度高血压警戒值（未满 18 岁），需立即规范复测并急诊评估急性靶器官损害`);
      } else if (targetOrgan) {
        redFlags.push(`血压 ${criticalBp.systolic}/${criticalBp.diastolic}mmHg 达重度高血压警戒值，并伴${targetOrgan}，需立即规范复测并按高血压急症评估急性靶器官损害，应急诊处理`);
      }
    } else {
      redFlags.push(`血压 ${criticalBp.systolic}/${criticalBp.diastolic}mmHg 达低血压/休克风险警戒值，需立即复测并评估循环灌注`);
    }
  }
  if (temp != null && temp >= 40) {
    redFlags.push(`体温 ${temp}℃ 达极高热警戒值，需立即复测并评估严重感染、中枢或热相关急症`);
  }
  if (temp != null && temp < 35) {
    redFlags.push(`体温 ${temp}℃，达到低体温风险警戒阈值，需先评估循环、感染或暴露相关风险`);
  }
  // 体温 35～35.5℃ 合并病历记录的意识改变（owner 2026-10-14）：单看体温只是「偏低需复测」，合并嗜睡、反应迟钝、意识模糊时
  // 判红旗。此前只有语义事实层兜：76 岁、35.5℃、嗜睡、反应较平时迟钝的病例，6 次抽取有 1 次被评成 urgent 而放出剂量。
  // 数值阈值 + 有限闭集（意识改变的词与闸门其余各处同一组），属开放语言冻结的允许例外。
  if (temp != null && temp >= 35 && temp <= 35.5) {
    const consciousness = currentConsciousnessChangeTerm(text);
    if (consciousness) {
      redFlags.push(`体温 ${temp}℃ 偏低并伴${consciousness}，需立即评估低体温相关的循环、感染与代谢原因`);
    }
  }
  if (pulse != null && (pulse >= (pediatricVitals?.pulseRedFlagFrom ?? 150) || pulse < 40)) {
    redFlags.push(`心率/脉搏 ${pulse}次/分异常，需先评估心血管风险`);
  }
  if (respiration != null && (respiration >= (pediatricVitals?.respirationRedFlagFrom ?? 35) || respiration <= 8)) {
    redFlags.push(`呼吸 ${respiration}次/分异常，需先评估呼吸循环风险`);
  }
  if (spo2 != null && spo2 <= 89) {
    redFlags.push(`血氧饱和度 ${spo2}% 偏低，需先评估缺氧风险`);
  }
  // T6 authority boundary: grounded model findings remain visible through semantic advisories and
  // priority questions, but only deterministic category rules or validated vital thresholds may
  // create a hard red flag here.
  return Array.from(new Set(redFlags));
}

type ProgrammaticRedFlagFinding = NonNullable<SafetyGate["redFlagFindings"]>[number];

function stableRedFlagHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `RF-${(hash >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
}

export function redFlagClearanceFingerprint(
  gate: Pick<SafetyGate, "redFlags" | "redFlagFindings">,
): string {
  const atoms = (gate.redFlagFindings || []).map((finding) =>
    [finding.ruleId, finding.sourceQuote, finding.message].map((item) => item.trim().replace(/\s+/g, " ")).join("|"),
  );
  const source = atoms.length > 0
    ? atoms
    : gate.redFlags.map((item) => item.trim().replace(/\s+/g, " "));
  return stableRedFlagHash([...new Set(source)].sort().join("\n"));
}

/**
 * 这是全系统唯一一个能把确定性阳性红旗整条抹掉的判定。
 *
 * 它此前的**唯一内容判据是 `assessmentSummary.trim().length < 12`** —— 一个字数验证器。
 * 实测：一句「今天天气不错今天天气不错」即可让 status 由 red_flag 变 ready、
 * allowDosePrescription 由 false 变 true、redFlags 由「胸痛/胸闷伴大汗、放射痛或气促」变空数组。
 *
 * 现在内容判据收敛到 emergency-clearance-contract.ts 的**同一个导出谓词**：签发端
 * （issueEmergencyClearance）与这一处消费端跑的是同一份判据，不再各写各的。
 * 重跑而不是只信签名，是因为签名只能证明「这份凭证是我们签的」，证明不了
 * 「它对得上**此刻**的红旗集合」——后者才是解除约束的前提。
 */
function hasCurrentEmergencyClearance(
  state: CaseState,
  gate: Pick<SafetyGate, "redFlags" | "redFlagFindings">,
): boolean {
  const clearance = state.emergencyClearance;
  if (!clearance || !Number.isFinite(Date.parse(clearance.confirmedAt))) return false;
  if (clearance.redFlagFingerprint !== redFlagClearanceFingerprint(gate)) return false;
  return emergencyClearanceContractIssue({
    activeFindings: activeEmergencyClearanceFindingsFromGate(gate),
    attestations: clearance.findings,
    assessmentSummary: clearance.assessmentSummary,
  }) === undefined;
}

/**
 * 红旗规则表。`message` 是这条规则**自己**产出的提示语形态，`source` 是它在病历里认的词。
 *
 * 2026-08-12：呈现层此前把 `message` 的模式又抄了一份（医生页面用
 * `/心血管|冠脉|胸痛|胸闷/` 判断该显示哪张急诊卡片）。同一判据两处各写各的，
 * 表这边加一条、页面那边不知道。现在从这里导出 redFlagRuleIdForMessage，
 * 呈现层只问「这句提示语属于哪条规则」，不再自带词表。
 */
const RED_FLAG_FINDING_RULES: Array<{
  id: string;
  message: RegExp;
  source: RegExp;
  explanation: string;
}> = [
  { id: "critical-vital-sign", message: /^(?:血压|体温|心率\/脉搏|呼吸 \d|血氧饱和度)/, source: /血压|BP|体温|T\s*[:：]?\s*\d|心率|脉搏|P\s*[:：]?\s*\d|呼吸|R\s*[:：]?\s*\d|血氧|SpO2/i, explanation: "已记录生命体征达到确定性危急阈值，需规范复测并现场评估。" },
  { id: "mental-crisis-current", message: /自杀|自伤|伤害他人/, source: /想死|活不下去|寻短见|一了百了|不想醒来|自杀|轻生|自伤|他伤/, explanation: "当前自伤、他伤或自杀意念需要立即现场安全评估。" },
  { id: "acute-cardiac-event", message: /心血管|冠脉|胸痛|胸闷/, source: /胸痛|胸闷|胸口|胸前|胸骨后|心口|心前区/, explanation: "急性或伴危险表现的胸部症状需先排除时间敏感性心血管事件。" },
  { id: "acute-neurologic-event", message: /神经系统|神经功能|头痛/, source: new RegExp(`头痛|意识障碍|意识不清|神志不清|昏迷|昏睡|嗜睡|谵妄|呼之不应|抽搐|惊厥|无力|偏瘫|说不出话|颈抵抗|克氏征|克尼格征|Kernig|布氏征|布鲁津斯基征|Brudzinski|脑膜刺激征|${FOCAL_NEUROLOGIC_PATTERN.source}`), explanation: "急性意识、发作性事件或局灶神经异常需优先排除神经急症。" },
  { id: "acute-abdomen-emergency", message: /急腹症|剧烈腹痛|腹痛\/腹胀/, source: /腹痛|腹胀|胃痛|胃脘痛|肚子疼|右下腹痛|上腹痛|心口窝痛|胃部疼痛|反跳痛|松手更疼|板状腹|腹肌紧张|板状|板样|腹壁强直|肌紧张|腹膜刺激征|停止排气|停止排便|停止肛门排气|肛门停止排气/, explanation: "剧烈腹痛或腹膜刺激征达到急腹症硬门槛；单纯突发、尚无重症表现者进入优先评估而非自动急诊定级。" },
  { id: "active-gi-bleeding", message: /消化道出血/, source: new RegExp(`呕血|吐血|黑便|柏油样便|便血|咖啡(?:色|样)|${governedTermAlternation([...HAEMATEMESIS_COLLOQUIAL_FORMS])}`), explanation: "活动性消化道出血表现需立即评估失血量和循环状态。" },
  { id: "syncope-high-risk-arrhythmia", message: /晕厥伴心电记录的高危心律失常/, source: /晕厥|黑矇|意识丧失|晕倒|昏倒|停搏|长间歇|房室传导阻滞|室速|室性心动过速|室颤/, explanation: "晕厥合并心电记录的主要高危心律失常（长间歇、高度房室传导阻滞、室速），需心电监护下急诊评估，可能需要起搏或住院。" },
  { id: "severe-thrombocytopenia", message: /重度血小板减少/, source: /血小板|PLT/i, explanation: "血小板低于10×10⁹/L，或低于20×10⁹/L并有出血表现，有颅内出血等严重自发出血风险，需血液科急诊评估。" },
  { id: "active-major-bleeding", message: /活动性大量阴道出血/, source: /阴道(?:出血|流血)|血红蛋白|血色素|HGB|Hb/i, explanation: "活动性大量阴道出血伴持续、重度贫血或循环灌注表现，达到非产科大出血硬门槛。" },
  { id: "acute-respiratory-event", message: /呼吸循环急症|缺氧/, source: /呼吸困难|气促|喘憋|端坐呼吸|不能平卧|无法平卧|喘不上气|发紫/, explanation: "静息或快速加重的呼吸困难及缺氧表现需立即评估。" },
  { id: "incarceration", message: /不能还纳（嵌顿）/, source: /不能还纳|无法还纳|不能回纳|无法回纳|还纳不能|嵌顿/, explanation: "脱出物或疝块不能还纳，有绞窄坏死风险，需急诊或专科评估。" },
  { id: "acute-trauma-fracture", message: /外伤后3天内的骨折/, source: /骨折|摔伤|跌伤|跌倒|摔倒|车祸|外伤|撞伤|砸伤|坠落|扭伤|挤压伤/, explanation: "外伤后数日内的骨折需先完成急诊或骨科处置，再评估中药处方。" },
  { id: "tcm-critical-pattern", message: /危重中医证候术语/, source: /戴阳证|阴盛格阳|脉微欲绝/, explanation: "病历明确记录当前危重证候术语；该术语只触发现代急症核实，不直接授权任何课程方药或操作。" },
];

/**
 * 一句红旗提示语属于哪条规则。呈现层据此决定显示哪张急诊卡片，不得再自带关键词表。
 * 认不出返回空串——调用方应回落到通用急症措辞，而不是猜一个专科方向。
 */
export function redFlagRuleIdForMessage(message: string): string {
  const text = String(message || "");
  if (!text.trim()) return "";
  return RED_FLAG_FINDING_RULES.find((rule) => rule.message.test(text))?.id || "";
}

function programmaticRedFlagFindings(
  state: CaseState,
  redFlags: readonly string[],
): ProgrammaticRedFlagFinding[] {
  const sourceText = trustedInputText(state);
  const clauses = sourceText
    .split(/[\n。；;]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  return redFlags.map((message, index) => {
    const rule = RED_FLAG_FINDING_RULES.find((candidate) => candidate.message.test(message));
    const sourceQuote = rule
      ? clauses.find((clause) => hasPatternWithoutNegation(clause, rule.source))
      : undefined;
    return {
      ruleId: rule?.id || `deterministic-red-flag-${index + 1}`,
      severity: "emergency" as const,
      sourceQuote: (sourceQuote || message.match(/(?:血压|体温|心率\/脉搏|呼吸|血氧饱和度)[^，。；]{0,60}/)?.[0] || "结构化病例事实命中确定性规则").slice(0, 500),
      ruleExplanation: rule?.explanation || "当前病例事实命中确定性急危重症规则，需先完成现场评估。",
      message,
    };
  });
}

/**
 * 两路读法不一致（2026-10-26 第二十一轮）：确定性规则读出的红旗，语义事实层对同一处原文给了「否认 / 未问及 / 不是患者本人」的读法，
 * 而且该类目没有任何肯定的读法时，红旗与「剂量不给」都保留（接口取值冻结，也不能让一次模型输出撤销确定性红旗），只在这条红旗后面
 * 写明两种读法不一致、请医生先核实、核实确无可解除。只认结构化规则（带原文分句）与同类目的语义条目；急缓判断不同的不算——
 * B024 窦性停搏伴晕厥，语义层判 clarify、规则判急诊，后者是对的。已存 371 例带事实层的红旗病例里此条件一例未触发。
 */
const READER_DISAGREEMENT_RULE_CATEGORIES: Record<string, BackstopRedFlagCategory> = {
  "acute-cardiac-event": "cardiac",
  "acute-neurologic-event": "neuro",
  "acute-abdomen-emergency": "acute_abdomen",
  "active-gi-bleeding": "gi_bleed",
  "syncope-high-risk-arrhythmia": "syncope",
  "active-major-bleeding": "bleeding",
  "acute-respiratory-event": "respiratory",
  "mental-crisis-current": "mental_crisis",
  incarceration: "acute_abdomen",
};
export const READER_DISAGREEMENT_NOTE_LEAD = "两种读法不一致，请先核实";

function withReaderDisagreementNote(state: CaseState, message: string): string {
  if (message.includes(READER_DISAGREEMENT_NOTE_LEAD)) return message;
  const facts = state.clinicalFacts;
  if (!facts || facts.semanticStatus !== "checked" || !clinicalFactsReviewSettled(facts.reviewStatus)) return message;
  const rule = RED_FLAG_FINDING_RULES.find((candidate) => candidate.message.test(message));
  const category = rule ? READER_DISAGREEMENT_RULE_CATEGORIES[rule.id] : undefined;
  if (!rule || !category) return message;
  const sourceText = trustedInputText(state);
  if (facts.disposition?.setting === "emergency") return message;
  const grounded = groundClinicalFacts(facts, sourceText).redFlags.filter((finding) => finding.category === category);
  if (grounded.some((finding) => finding.subject === "patient" && (finding.status === "positive" || finding.status === "possible"))) return message;
  // 规则命中的每一处（去重后的分句）都要被语义层对同一处原文读成否认/未问及/他人，才算两路读法相反。
  const clauses = [...new Set(sourceText.split(/[\n。；;]+/).map((item) => item.trim()).filter((item) => hasPatternWithoutNegation(item, rule.source)))];
  if (clauses.length === 0) return message;
  const contraryFindings = grounded.filter((finding) =>
    (finding.status === "negative" || finding.status === "unknown" || finding.subject !== "patient") && rule.source.test(finding.quote));
  const coverOf = (clause: string) => contraryFindings.find((finding) => clause.includes(finding.quote) || finding.quote.includes(clause));
  if (!clauses.every((clause) => coverOf(clause))) return message;
  const contrary = coverOf(clauses[0])!;
  const reading = contrary.subject !== "patient" ? "不是患者本人的情况" : contrary.status === "negative" ? "否认" : "未问及或未确定";
  return `${message}（${READER_DISAGREEMENT_NOTE_LEAD}：病历「${contrary.quote}」这一处，规则读为存在，语义复核读为${reading}；核实确有则按上述处置，确无可由医生解除此项）`;
}

/**
 * Model-outage fallback for common but non-definitive risk symptoms. These checks intentionally
 * never create an emergency lock: they preserve clinician visibility until the semantic model can
 * distinguish severity, timing and symptom combinations. The normal path remains fully model-owned.
 */
/** 腹痛的构词式：「下腹隐痛」「小腹坠痛」「腹部胀痛」——字面「腹痛」认不出这些（2026-10-24，孕 12 周下腹隐痛没有产科提示）。 */
const ABDOMINAL_PAIN_FORM = /腹[部中]?[^，,。；;\n无不未没]{0,2}痛/;

export function narrativeFallbackAdvisories(state: CaseState): string[] {
  const text = trustedInputText(state);
  const semanticCategories = state.clinicalFacts?.semanticStatus === "checked"
    ? groundedPatientTriageCategories(state.clinicalFacts, text)
    : new Set<BackstopRedFlagCategory>();
  const advisories: string[] = [];
  const addAdvisory = (category: BackstopRedFlagCategory, message: string) => {
    if (!semanticCategories.has(category)) advisories.push(message);
  };
  if (hasAnyTerm(text, [...governedRedFlagCategory("syncope").symptoms, ...SYNCOPE_DETECTION.colloquialSymptoms])) {
    addAdvisory("syncope", "晕厥、黑矇或意识丧失相关信息需优先复核当前状态、诱因、伤情及心电风险");
  }
  if (
    hasAnyTerm(text, [
      ...governedRedFlagCategory("neuro").symptoms,
      ...FOCAL_NEUROLOGIC_TERMS,
      "昏迷", "昏睡", "嗜睡", "谵妄", "呼之不应", "抽搐", "惊厥",
    ]) &&
    !hasStablePostAcuteNeurologicContext(text) &&
    !hasOnlyStableResidualNeurologicDeficit(text)
  ) {
    addAdvisory("neuro", "意识水平改变、抽搐或局灶神经功能异常需优先复核起病时间、当前意识、发作持续时间及卒中/癫痫等急症风险");
  }
  if (hasAnyTerm(text, giBleedConceptTerms()) || hasCoffeeGroundEmesis(text)) {
    addAdvisory("gi_bleed", "消化道出血相关表现需优先复核出血量、持续性、循环状态及血红蛋白");
  }
  if (hasAnyTerm(text, ["咯血", "阴道流血", "外伤出血", "出血不止", "大量出血"])) {
    addAdvisory("bleeding", "出血相关表现需优先复核出血量、活动性及循环状态");
  }
  // sepsis.qualifiers = ['current','severe']：高热/寒战/感染单独出现在门诊过于常见，仍按合取，
  // 这与 acute_abdomen 的「腹痛须带急性/严重限定」是同一条治理口径（见词表 governance.scopeNote：
  // 不得做无差别笛卡尔积）。但「脓毒症」是**诊断级结论词**——与 shock 类目的「休克」同性质，
  // 写进病历时本身就是结论，不应再要求叠加寒战+发热。受治理表没有「结论词」这个字段，
  // 故在此显式二分而不是整表并入；同类判断另见本函数产科分支。
  if ((hasAnyTerm(text, ["寒战"]) && (hasAnyTerm(text, ["高热", "发热"]) || (parseContextualTemperature(text) ?? 0) >= 38.5))
    || hasAnyTerm(text, ["脓毒症"])) {
    addAdvisory("sepsis", "发热伴寒战需优先复核意识、循环、感染灶及脓毒症风险");
  }
  if (hasAbdominalPrioritySignal(text)) {
    addAdvisory("acute_abdomen", "持续或进行性腹痛/腹胀需优先复核严重度、腹膜刺激征、呕吐、排气排便及循环状态");
  }
  if (hasAnyTerm(text, ["呼吸困难", "气促", "喘憋", ...RESPIRATORY_DETECTION.colloquialSymptoms])
    || hasColloquialOrthopnea(text)) {
    addAdvisory("respiratory", "呼吸困难或气促相关表现需优先复核静息严重度、说话能力、血氧及循环状态");
  }
  // 这里原本是一份行内字面量，与词表 poisoning.symptoms 各写各的且已分叉
  // （代码多出「过量服用/整瓶/整盒/毒物」，词表多出「农药暴露」）。四个词已收进词表，此处只读词表。
  if (hasAnyTerm(text, [...governedRedFlagCategory("poisoning").symptoms, ...POISONING_DETECTION.colloquialSymptoms])) {
    addAdvisory("poisoning", "可疑中毒或药物过量需立即核实物质、剂量、时间、意识及呼吸循环状态");
  }
  const glucose = text.match(/(?:血糖|GLU)\s*[:：]?\s*(\d+(?:\.\d+)?)/i)?.[1];
  if ((glucose != null && Number(glucose) < 3)
    || hasAnyTerm(text, [...governedRedFlagCategory("metabolic").symptoms, "低血糖昏迷"])) {
    addAdvisory("metabolic", "严重低血糖或代谢异常线索需立即复测，并优先评估意识与循环状态");
  }
  // 产科是本函数里唯一不能整表并入的一类：受治理 obstetric.symptoms 中
  // 「妊娠出血」「孕期阴道出血」**自带妊娠限定**，可独立成立；「剧烈下腹痛」不带——
  // 整表并入会把非孕患者的剧烈下腹痛判成产科急症（它已由 acute_abdomen 承接）。
  // 故按「是否自带妊娠限定」二分：自带的独立成立，不自带的仍与妊娠上下文合取。
  {
    const obstetric = governedRedFlagCategory("obstetric");
    const pregnancyQualified = obstetric.symptoms.filter((term) => /妊娠|孕|产/.test(term));
    const needsPregnancyContext = obstetric.symptoms.filter((term) => !/妊娠|孕|产/.test(term));
    // 「是否妊娠」读受治理的妊娠判据（阳性或可疑），不再看「妊娠/怀孕」字面（2026-10-24 甲方页面实测）：
    // 字面判据把「妊娠可能性尚待核实」「妊娠状态未知」「妊娠期高血压病史」都当成孕妇，失眠病历因一句「偶有头晕」
    // 被提示「需优先排除产科急症」。
    if (
      hasAnyTerm(text, pregnancyQualified) ||
      (isPositiveOrPossibleClinicalState(assessPregnancyState(maternalStateText(state, text))) &&
        (hasAnyTerm(text, ["腹痛", "阴道流血", "头晕", "晕厥", ...needsPregnancyContext, ...obstetric.dangerCompanions]) || hasPatternWithoutNegation(text, ABDOMINAL_PAIN_FORM))) ||
      // 育龄女性停经伴阴道出血或腹痛：妊娠状态没写，也要先排除异位妊娠、流产（语料回放：「停经38天，阴道流血9天」「停经41天，带中夹血」
      // 以前只因分析里碰巧写了「妊娠」二字才有这条提示）。只认出血与腹痛，不认头晕——闭经病例常伴头晕。
      // 「停经超过2年」「停经3年」是绝经，不收；「月经推迟3-10天」说的是平时周期，不是这次没来，也不收。
      (pregnancyScreenRequired(state) && hasPatternWithoutNegation(text, /(?:停经|月经(?:逾期|过期|未至|未来潮))(?![^。；;，,\n]{0,6}年)/) &&
        (hasAnyTerm(text, ["阴道流血", "阴道出血", "带中夹血", "见红"]) || hasPatternWithoutNegation(text, ABDOMINAL_PAIN_FORM)))
    ) {
      addAdvisory("obstetric", "妊娠相关腹痛、出血或循环症状需优先排除产科急症");
    }
  }
  if (hasAnyTerm(text, [...governedRedFlagCategory("shock").symptoms,
    "全身冰冷", "四肢冰冷", "少尿", "意识模糊"]) ||
    // 「无尿」要按构词式认：「无尿痛、腹痛及阴道流血」里的「无尿」是否认尿痛（2026-10-24 甲方 100 例 C097：孕 12 周、血压 110/68，
    // 被提示「循环灌注异常线索需立即复核」）。
    hasPatternWithoutNegation(text, /无尿(?![痛频急道意感等])/)) {
    addAdvisory("shock", "循环灌注异常线索需立即复核血压、意识、尿量及末梢循环");
  }
  if (hasAnyTerm(text, [...governedRedFlagCategory("anaphylaxis").symptoms,
    "风团", "荨麻疹", "脸肿", "喉紧", "喉头肿胀", "声音嘶哑"])) {
    addAdvisory("anaphylaxis", "严重过敏或气道受累线索需立即复核气道、呼吸和循环");
  }
  if (hasAnyTerm(text, [...governedRedFlagCategory("pediatric_critical").symptoms,
    "发绀", "精神萎靡", "反应差", ...PEDIATRIC_DETECTION.colloquialCriticalSigns]) && isPediatricPatient(state)) {
    addAdvisory("pediatric_critical", "儿童全身危重表现需立即复核呼吸、循环、意识及脱水状态");
  }
  return Array.from(new Set(advisories));
}

/** Critical measured vitals are the deterministic floor of the hybrid red-flag architecture. */
export function hasDeterministicCriticalVitalRedFlag(state: CaseState): boolean {
  return detectProgrammaticRedFlags(state).some((flag) =>
    /^(?:血压(?:录入|\s)|体温\s|心率\/脉搏\s|呼吸\s|血氧饱和度\s)/.test(flag)
  );
}

/**
 * Measured values that need prompt repeat measurement and clinical review but are not, by
 * themselves, proof of an emergency. The semantic triage layer combines them with symptoms,
 * timing, baseline and target-organ findings; these advisories never become workflow blockers.
 */
export function measuredVitalAdvisories(state: CaseState): string[] {
  const {
    bloodPressure: bp,
    temperature,
    pulse,
    respiration,
    spo2,
  } = currentVitalMeasurements(state);
  const advisories: string[] = [];
  const pediatricVitals = pediatricVitalReferenceForCase(state);
  const pediatricBloodPressure = pediatricVitals?.systolicHypotensionBelow != null;
  if (bp && !bloodPressureIsCritical(bp, pediatricVitals) &&
      (bp.systolic >= 180 || bp.diastolic >= 120 ||
        (!pediatricBloodPressure && (bp.systolic <= 90 || bp.diastolic <= 50)))) {
    advisories.push(`血压 ${bp.systolic}/${bp.diastolic}mmHg 需立即规范复测，并结合胸痛、气促、神经症状及急性靶器官损害判断处置级别`);
  }
  // 重度高血压而病历未记录急性靶器官表现（2017 ACC/AHA、ACEP）：不按急症收回剂量，但给醒目提示——当日复测、尽快调整降压治疗。
  if (bp && (bp.systolic >= 180 || bp.diastolic >= 120) && !severeHypertensionTargetOrganSign(state)) {
    advisories.push(`【重度高血压】血压 ${bp.systolic}/${bp.diastolic}mmHg（≥180/120），病历未记录胸痛、呼吸困难、神经功能异常、意识改变、视物异常、剧烈头痛、抽搐或少尿等急性靶器官表现：请今日规范复测血压，并请患者当日或数日内到心内科/全科就诊调整降压治疗；如出现上述任一表现须立即急诊`);
  }
  if (temperature != null && temperature < 40 && temperature >= 39) {
    advisories.push(`体温 ${temperature}℃ 需尽快复测，并结合寒战、意识、循环及感染灶评估`);
  } else if (temperature != null && temperature >= 35 && temperature < 36) {
    advisories.push(`体温 ${temperature}℃ 偏低，需尽快复测并结合暴露、感染和循环状态评估`);
  }
  if (pulse != null && pulse < (pediatricVitals?.pulseRedFlagFrom ?? 150) && pulse >= (pediatricVitals?.pulseAdvisoryFrom ?? 120)) {
    advisories.push(`心率/脉搏 ${pulse}次/分需尽快复测，并结合节律、症状及基础心率评估`);
  } else if (pulse != null && pulse >= 40 && pulse < 50) {
    advisories.push(`心率/脉搏 ${pulse}次/分需尽快复测，并结合节律、症状及基础心率评估`);
  }
  if (respiration != null && respiration < (pediatricVitals?.respirationRedFlagFrom ?? 35) && respiration >= (pediatricVitals?.respirationAdvisoryFrom ?? 25)) {
    advisories.push(`呼吸 ${respiration}次/分需尽快复测，并结合呼吸困难、血氧及基础状态评估`);
  }
  if (spo2 != null && spo2 > 89 && spo2 <= 91) {
    advisories.push(`血氧饱和度 ${spo2}% 需立即复测，并结合呼吸症状、基础血氧和吸氧状态评估`);
  }
  return advisories;
}

export function sectionText(markdown: string, headings: string[]): string {
  if (!markdown.trim()) return "";
  const escaped = headings.map((heading) => heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`^##\\s*(?:${escaped})\\s*(?:[：:]\\s*[^\\n]+)?\\s*$`, "mi");
  const match = markdown.match(pattern);
  if (!match || match.index == null) return "";
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = rest.search(/^##\s+/m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

export function detectModelRedFlags(state: CaseState): string[] {
  const redFlagTitles = sectionTitleGroup("redFlag");
  const source = [
    sectionText(state.diagnosis || "", redFlagTitles),
    sectionText(state.riskAssessment || "", redFlagTitles),
  ].filter(Boolean).join("\n");
  if (!source.trim()) return [];

  const positiveRisk = /(高风险|红旗阳性|急诊|立即转诊|建议转诊|需转诊|先转诊|需优先排除急危重|需优先排除急症|需优先排除急性|危急值)/;
  return source
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .filter((line) =>
      line.length > 0 &&
      positiveRisk.test(line) &&
      !(/(信息不足|缺少|缺失|补齐|补充|待补充|暂不生成|不生成|不进入方药|暂停处方|完善后|重评估)/.test(line) &&
        !/(高风险|红旗阳性|急诊|立即转诊|建议转诊|需转诊|先转诊|危急值)/.test(line)) &&
      !isRiskLineNegatedOrEnumerative(line)
    )
    .slice(0, 5);
}

function numberFromClinicalText(value: string): number | null {
  const text = normalizeClinicalText(value).trim();
  const yearMatch = text.match(/(-?\d+(?:\.\d+)?)\s*岁(?:\s*(-?\d+(?:\.\d+)?)\s*(?:个月|月龄))?/);
  if (yearMatch) {
    const years = Number(yearMatch[1]);
    const months = yearMatch[2] == null ? 0 : Number(yearMatch[2]);
    const combined = years + months / 12;
    return Number.isFinite(combined) && years >= 0 && months >= 0 && combined <= 120 ? combined : null;
  }
  const monthMatch = text.match(/(-?\d+(?:\.\d+)?)\s*(?:个月|月龄)/);
  if (monthMatch) {
    const months = Number(monthMatch[1]);
    const years = months / 12;
    return Number.isFinite(years) && months >= 0 && years <= 120 ? years : null;
  }
  // 新生儿的年龄只按天/周龄记录（HIS 年龄栏「12天」「3周龄」）。只接受**整栏就是一个天/周数**：
  // 叙述里的「发热3天」不是年龄——叙述来源由 patientBoundNarrativeAge 先按岁/月字面筛过，走不到这里。
  const dayMatch = text.match(/^(?:出生(?:后)?\s*)?(\d+(?:\.\d+)?)\s*(?:天|日)(?:龄)?$/);
  if (dayMatch) {
    const days = Number(dayMatch[1]);
    return Number.isFinite(days) && days >= 0 && days <= 365 * 120 ? days / 365 : null;
  }
  const weekMatch = text.match(/^(?:出生(?:后)?\s*)?(\d+(?:\.\d+)?)\s*周龄$/);
  if (weekMatch) {
    const weeks = Number(weekMatch[1]);
    return Number.isFinite(weeks) && weeks >= 0 && weeks <= 52 * 120 ? (weeks * 7) / 365 : null;
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const years = Number(text);
  return Number.isFinite(years) && years >= 0 && years <= 120 ? years : null;
}

function hasInvalidAgeText(value: string): boolean {
  const text = normalizeClinicalText(value).trim();
  if (!/-?\d+(?:\.\d+)?/.test(text)) return false;
  return numberFromClinicalText(text) == null;
}

function patientSexText(state: CaseState): string {
  const structured = authoritativeFieldOrFallback(state, "sex", state.patient?.sex);
  if (isKnownClinicalText(structured)) {
    const normalized = normalizeClinicalText(structured).trim();
    if (/女/.test(normalized) || /^(?:f|female|woman)$/i.test(normalized)) return "女";
    if (/男/.test(normalized) || /^(?:m|male|man)$/i.test(normalized)) return "男";
  }
  const text = normalizeClinicalText(trustedInputText(state));
  const explicitMale = /(?:^|[，,；;。\s])(?:患者|病人)?\s*(?:男性|男)(?=[，,；;。\s\d]|性|患者|童)/.test(text) || /\d{1,3}\s*岁\s*(?:男性|男|男童)/.test(text) || /\b(?:male|man)\b/i.test(text) || /(?:性别|sex)\s*[:：]?\s*m\b/i.test(text);
  const explicitFemale = /(?:^|[，,；;。\s])(?:患者|病人)?\s*(?:女性|女)(?=[，,；;。\s\d]|性|患者)/.test(text) || /\d{1,3}\s*岁\s*(?:女性|女)/.test(text) || /\b(?:female|woman)\b/i.test(text) || /(?:性别|sex)\s*[:：]?\s*f\b/i.test(text);
  if (explicitMale && !explicitFemale) return "男";
  if (explicitFemale && !explicitMale) return "女";
  // 妊娠/孕周/哺乳可在缺少性别字段时作为女性生理状态线索；“备孕”可能描述男性，不能单独推断女性。
  if (/(妊娠|孕\d+周|哺乳期)/.test(text)) return "女";
  return "";
}

function patientAgeText(state: CaseState): string {
  // An HIS snapshot owns demographics whenever it exists, including an intentionally empty field;
  // never fall back to a potentially stale compatibility DTO in that case. Without HIS, however,
  // `patient.age` is the caller's structured demographic input and must survive later follow-up
  // messages. Requiring the *last* user message to repeat the age made a valid 56-year-old become
  // age-unknown after answering an unrelated M02 question, silently disabling both age-sensitive
  // diagnostic management and downstream dose calibration.
  if (state.hisRecord) {
    const hisAge = fieldText(state, "age");
    if (isKnownClinicalText(hisAge)) return hisAge;
    // A current HIS raw record is still a primary source. Accept only a patient-bound demographic
    // phrase from that record; never fall back to the top-level compatibility DTO and never treat a
    // relative's age as the patient's age.
    return patientBoundNarrativeAge(normalizeClinicalText(trustedInputText(state)));
  }
  const structured = state.patient?.age != null ? String(state.patient.age).trim() : "";
  if (isKnownClinicalText(structured)) return structured;
  return patientBoundNarrativeAge(normalizeClinicalText(trustedInputText(state)));
}

function patientBoundNarrativeAge(text: string): string {
  const ageLiteral = String.raw`(-?\d{1,4}(?:\.\d+)?\s*(?:岁(?:\s*\d{1,4}(?:\.\d+)?\s*(?:个月|月龄))?|个月|月龄))`;
  const labeled = text.match(new RegExp(`(?:^|[。；;\\n])\\s*(?:(?:患者|病人)\\s*)?年龄\\s*[:：]?\\s*${ageLiteral}`));
  if (labeled?.[1]) return labeled[1];
  const subjectFirst = text.match(new RegExp(
    // 主语与性别、性别与年龄之间各允许一个逗号：「患者，男，7岁」是 HIS/直调方最常见的
    // 人口学写法（2026-08-25 实测该形态四条模式全不命中，年龄敏感门禁静默失效）。
    // 逗号只允许出现在这两个衔接位，「患者，其子7岁」仍因「其」阻断而不误绑。
    `(?:^|[。；;\\n])\\s*(?:(?:患者|病人)\\s*[，,]?\\s*(?:为|系|是)?\\s*(?:一名|一位)?\\s*(?:男性|女性|性别\\s*[男女]|男|女|男童|女童|患儿)?|患儿|男童|女童|男性|女性|男|女)\\s*[，,]?\\s*(?:年龄\\s*[:：]?|为|系|是|约)?\\s*${ageLiteral}`,
  ));
  if (subjectFirst?.[1]) return subjectFirst[1];
  const ageFirst = text.match(new RegExp(
    `(?:^|[。；;\\n])\\s*(?:主诉|现病史)?\\s*[:：]?\\s*${ageLiteral}\\s*(?=男性|女性|男|女|男童|女童|患儿|患者|病人|[，,]\\s*(?:因|主诉|就诊|反复|出现|有|无|患))`,
  ));
  if (ageFirst?.[1]) return ageFirst[1];
  const conciseAgeFirst = text.match(new RegExp(
    `(?:^|[。；;\\n])\\s*(?:主诉|现病史)?\\s*[:：]?\\s*${ageLiteral}\\s*(?=(?:因|反复|出现|主诉|就诊|诉|患))`,
  ));
  return conciseAgeFirst?.[1] || "";
}

/** Structured patient age shared by downstream regimen rendering; avoids reparsing prose context. */
export function authoritativePatientAgeYears(state: CaseState): number | undefined {
  return numberFromClinicalText(patientAgeText(state)) ?? undefined;
}

/** 育龄女性、未写明已绝经/无子宫：安全门据此追问妊娠状态；居家穴位保健据此按妊娠禁忌从严（同一判据）。 */
/**
 * 给患者的「如已怀孕、备孕或哺乳请告知医生」这类提示对本例是否有意义（2026-10-13）。
 * 只管**提示语**，不参与任何安全判定：安全闸门的孕哺筛查仍用 pregnancyScreenRequired（10–59 岁女性一律追问）。
 * 独立评审实测：64 岁已绝经 14 年、52 岁月经已停 1 年的女性，以及 11 岁女童，注意事项里都写着「如已怀孕或备孕请先告知医生」。
 * 不适用：非女性；不足 12 岁；pregnancyScreenRequired 已判为生理上无妊娠可能（60 岁及以上、绝经满一年、子宫或双侧卵巢切除）；
 * 45 岁及以上且病历写明月经已停一年以上。年龄不详的女性按适用处理。
 */
export function reproductiveAdviceRelevant(state: CaseState): boolean {
  if (!/女/.test(patientSexText(state))) return false;
  if (!pregnancyScreenRequired(state)) return false;
  const age = authoritativePatientAgeYears(state);
  if (age == null) return true;
  if (age < 12) return false;
  if (age >= 45 && /(?:月经|经水)(?:已)?(?:停|断|绝)[^，,。；;\n]{0,6}[1-9]\d*\s*年|(?:停经|绝经|经断)[^，,。；;\n]{0,6}[1-9]\d*\s*年/.test(normalizeClinicalText(trustedInputText(state)))) return false;
  return true;
}

/**
 * 写给患者的孕哺提示（「如已怀孕、可能怀孕或正在哺乳，请服药前告知医生」、逐味「孕期慎用」、复诊里的妊娠相关信号）是否写给本例
 *（2026-10-22）。在 reproductiveAdviceRelevant（12 岁起）之上再收一档：未满 15 岁（人口统计通用的育龄口径 15–49 岁）不写，
 * 病历自己写到停经、月经推迟、性生活、妊娠、早孕或哺乳的除外。S 集 12 岁、14 岁女孩发热、头痛的处方都写着上面那句（第十二轮评审）。
 * 月经、带下类提示仍按 reproductiveAdviceRelevant；安全闸门的孕哺筛查（pregnancyScreenRequired，10–59 岁）不受影响。
 */
const YOUNG_ADOLESCENT_PREGNANCY_CONTEXT = /停经|月经(?:推迟|延后|逾期|未至|未来)|性生活|同房|怀孕|妊娠|早孕|哺乳|HCG/iu;
export function pregnancyAdviceRelevant(state: CaseState): boolean {
  if (!reproductiveAdviceRelevant(state)) return false;
  // 病历明确否认妊娠、也不在备孕：不再写孕期提示与逐味「孕期慎用」（2026-10-24 甲方 100 例 C018「明确否认妊娠，近两周月经正常」
  // 仍出现「孕期/妊娠慎用」「如已怀孕请先告知」，测试重点即「明确妊娠阴性不应触发孕期提示」）。
  const recorded = normalizeClinicalText(trustedInputText(state));
  if (assessPregnancyState(maternalStateText(state, recorded)).status === "negative" &&
    !isPositiveOrPossibleClinicalState(assessConceptionState(recorded))) return false;
  const age = authoritativePatientAgeYears(state);
  if (age == null || age >= 15) return true;
  return YOUNG_ADOLESCENT_PREGNANCY_CONTEXT.test(normalizeClinicalText(trustedInputText(state)));
}

export function pregnancyScreenRequired(state: CaseState): boolean {
  const sex = patientSexText(state);
  if (!/女/.test(sex)) return false;
  const text = normalizeClinicalText(trustedInputText(state));
  const age = authoritativePatientAgeYears(state);
  const physiologicallyNotAtRisk =
    recordExcludesPregnancyPotential(text, age ?? undefined) ||
    // 年龄仅关闭“未知状态必须追问”，绝不覆盖下游已记录的阳性妊娠/哺乳/备孕硬边界。
    // 60 岁以下继续 fail-closed；60 岁及以上不再生成无临床价值的常规生殖状态追问。
    // 下限同理（2026-09-26 实测：3 岁女童病例被要求填写妊娠/哺乳/备孕状态）。取 10 岁而不是
    // 月经初潮的常见年龄：初潮最早可在 8–9 岁，10 岁及以上仍然追问，宁可多问一句。
    (age != null && (age >= 60 || age < 10));
  return !physiologicallyNotAtRisk;
}

function hasNumericPediatricWeight(text: string): boolean {
  // Must be an explicit body-weight value (体重/WT/weight/BW immediately followed by the number).
  // A bare "<n>kg" elsewhere (e.g. "体重下降5kg" weight loss) must NOT satisfy the weight requirement.
  return /(?:体重|体重约|BW|WT|weight)\s*[:：约为]?\s*\d{1,3}(?:\.\d+)?\s*(?:kg|公斤|千克)?/i.test(normalizeClinicalText(text));
}

// 儿科病例可能只用定性词标注(患儿/婴儿/男童/月龄…)而无数字年龄。这类同样必须命中儿童剂量门：
// 本地知识库只有成人剂量区间，绝不退化为成人剂量——能从定性词判出年龄段的按年龄分数法折算，判不出的（只写「患儿」）收回剂量。
// 词表与分句开头正则都来自 pediatric-dose-rule（一份数据，判「是不是儿童」与判「哪一档」不会各写各的）。
function pediatricQualitativeText(state: CaseState): string | undefined {
  const structuredDemographics = normalizeClinicalText([
    state.hisRecord?.fields?.sex,
    state.hisRecord?.fields?.age,
    state.patient.sex,
  ].filter(Boolean).join("；"));
  if (PEDIATRIC_STRUCTURED_WORD_PATTERN.test(structuredDemographics)) return structuredDemographics;
  const narrative = normalizeClinicalText(trustedInputText(state));
  return narrative
    .split(/[。；;\n]+/)
    .map((clause) => clause.trim().replace(/^(?:主诉|现病史|患者信息|一般资料)\s*[:：]\s*/, ""))
    .find((clause) => PEDIATRIC_CLAUSE_SUBJECT_PATTERN.test(clause))
    // 没有数值年龄时，病历别处称「患儿」也算儿童（「患者张某，男，年龄未详（文中称患儿）」，2026-10-19 Claude 评审 H 集 H-tri-289：
    // 判不出儿童，按成人给了人参 6g、黄芪 15g）。只在登记年龄缺失时走到这里；判出来的年龄段仍按下面的定性词，只写「患儿」的收回剂量。
    // 「患者照顾5岁患儿」「陪同患儿就诊」说的是别人的孩子：同一小句有照看、陪同一类动词时不算。
    ?? (narrative.split(/[，,。；;\n]+/u).some((clause) => /患儿/u.test(clause) && !/照顾|照看|看护|陪同|陪|带着?|抱着?|其|家中|家有/u.test(clause)) ? "患儿" : undefined);
}

function hasQualitativePediatricContext(state: CaseState): boolean {
  return pediatricQualitativeText(state) !== undefined;
}

/**
 * 「这份病历是不是儿童病例」的**单一判据**。
 *
 * 之前全仓有四处各自判断，三处（剂量降级理由、处方许可、缺口清单）写的是
 *   `(age != null && age < 18) || (age == null && hasQualitativePediatricContext(state))`
 * 而**儿童危重提示那一处只写了后半截**——结构化年龄那一分支漏了。
 * 于是 `patient.age = 4` 且主诉「口唇发紫、精神很差」的患儿，只要自由文本
 * 没在分句开头写出「患儿/孩子」，就一条儿童危重提示都拿不到（实测 0 条）。
 *
 * 漏得这么隐蔽有两层原因，缺一不可：
 *  ① `hasQualitativePediatricContext` 的结构化分支只读 `hisRecord.fields.age` 与
 *     `patient.sex`，**`patient.age` 根本不在读取列表里**（它本就只负责"没有数字年龄"的场合）；
 *  ② 它的文本分支要求儿童词出现在**分句开头**，所以「4岁患儿精神萎靡」也不算。
 * 两条叠加，四处里唯独安全提示那处退化成"只认写法不认年龄"。
 *
 * 收敛成一个谓词而不是在第四处补个 if：本仓头号缺陷形状就是同一判据多处各写各的，
 * 补 if 只是把四处变五处。
 */
export function isPediatricPatient(state: CaseState): boolean {
  const age = numberFromClinicalText(patientAgeText(state));
  if (age != null) return age < 18;
  return hasQualitativePediatricContext(state);
}

/**
 * 儿童剂量档位（年龄分数法）。**不是儿童 → undefined；是儿童但年龄段判不出（无数值年龄、定性词也只写「患儿」）→ undefined**，
 * 两种情形靠 isPediatricPatient 区分：后者继续收回剂量并追问年龄。数值年龄优先于定性词（与 isPediatricPatient 同序）。
 */
export function pediatricDoseRuleForCase(input: CaseState): PediatricDoseRule | undefined {
  const state = withPatientObject(input);
  if (!isPediatricPatient(state)) return undefined;
  const age = numberFromClinicalText(patientAgeText(state));
  if (age != null) return pediatricDoseRuleForAgeYears(age);
  const qualitative = pediatricQualitativeText(state);
  return qualitative ? pediatricDoseRuleForStageWords(qualitative) : undefined;
}

/** 儿童且年龄段可判：剂量走年龄分数法，不再是独立硬边界。 */
const PEDIATRIC_AGE_STAGE_UNKNOWN_REASON = "儿童年龄段无法判定（需要数值年龄或月龄），暂不能按年龄分数法折算剂量";

function hasExplicitPregnancyStatus(text: string): boolean {
  return isKnownClinicalState(assessPregnancyState(text));
}

function hasExplicitLactationStatus(text: string): boolean {
  return isKnownClinicalState(assessLactationState(text));
}

function hasExplicitConceptionStatus(text: string): boolean {
  return isKnownClinicalState(assessConceptionState(text));
}

/**
 * 婴幼儿语境：数值年龄 <10 岁（与 pregnancyScreenRequired 同界），或没有数值年龄但档位词落在新生儿/乳婴儿/幼儿/学龄前。
 * 这类患者不会有自己的哺乳期，病历里的「母乳喂养」是患儿的喂养方式。
 */
function isInfantFeedingContext(state: CaseState): boolean {
  const rule = pediatricDoseRuleForCase(state);
  if (!rule) return false;
  const age = numberFromClinicalText(patientAgeText(state));
  if (age != null) return age < 10;
  return rule.stage === "neonate" || rule.stage === "infant" || rule.stage === "toddler" || rule.stage === "preschool";
}

/** 孕哺备孕阳性判据读的文本：婴幼儿语境先去掉喂养方式词，其余原样。 */
function maternalStateText(state: CaseState, text: string): string {
  if (!isInfantFeedingContext(state)) return text;
  // 婴幼儿的出生史、母亲孕期情况（「母孕期感冒服药」「其母孕期患妊娠期糖尿病」）说的是母亲，不是患儿自己（2026-10-24）。
  return stripInfantFeedingPhrases(text)
    .split(/(?<=[。；;，,\n])/)
    .filter((clause) => !/母(?:亲|孕|体)|其母|生母|胎龄|出生(?:时|史|体重)/.test(clause))
    .join("");
}

/**
 * 妊娠或哺乳阳性/可疑：独立硬边界，不给剂量。
 * 备孕/未避孕自 2026-10-14 起不在其中（owner 决定）：照常给剂量，药典孕妇禁用饮片不进方、慎用的逐味标注，
 * 判据是 clinical-state 的 conceptionWithoutPregnancyOrLactation。理由文案「已记录妊娠、哺乳或备孕阳性/可疑状态」不改——
 * 对接方与签名载荷读它，妊娠、哺乳病例照旧给出这句。
 */
function hasPositivePregnancyOrLactationRisk(text: string): boolean {
  return [
    assessPregnancyState(text),
    assessLactationState(text),
  ].some(isPositiveOrPossibleClinicalState);
}

function missingVitalsForHighRiskPresentation(state: CaseState): string[] {
  const text = structuredCaseText(state);
  const hasRespiratoryRisk = hasAnyTerm(text, ["呼吸困难", "气促", "喘憋", "端坐呼吸"]);
  const hasAcuteAbdominalRisk = hasAcuteAbdominalSignal(text);
  const hasBleedingRisk = hasAnyTerm(text, [...giBleedConceptTerms(), "咯血", "阴道流血", "外伤出血", "出血不止", "大量出血"]) || hasCoffeeGroundEmesis(text);
  const hasOtherHighRiskPresentation =
    hasAnyTerm(text, ["胸痛", "胸闷", "心前区痛", "晕厥", "黑矇", "意识丧失", "寒战", "高热", "意识改变", "言语不清", "肢体无力"]) ||
    hasBleedingRisk ||
    hasAcuteAbdominalRisk ||
    hasPatternWithoutNegation(text, /(突发|剧烈).{0,8}头痛|发热.{0,8}寒战|寒战.{0,8}发热/);
  if (!hasRespiratoryRisk && !hasOtherHighRiskPresentation) return [];

  const vital = vitalsText(state);
  const missing: string[] = [];
  if (parseTemperature(vital) == null) missing.push("体温");
  if (parsePulse(vital) == null) missing.push("心率/脉搏");
  if (parseRespiration(vital) == null) missing.push("呼吸");
  if (parseBloodPressure(vital) == null) missing.push("血压");
  if (hasRespiratoryRisk && parseSpo2(vital) == null) missing.push("血氧饱和度");
  return missing;
}

function medicationStatusIsActionable(text: string): boolean {
  if (!isKnownClinicalText(text)) return false;
  if (
    /(否认|无|没有|未使用|未服用)[^。；\n]{0,24}(用药|服药|当前用药|长期用药|中药|中成药|西药|保健品)/.test(text) ||
    /(目前|当前)?[^。；\n]{0,8}(未|无|没有)[^。；\n]{0,16}(使用|服用)[^。；\n]{0,18}(中药|中成药|西药|保健品|药物)/.test(text) ||
    /(?:已|现已)?停用[^。；\n]{0,12}(?:全部|所有)?(?:药物|中药|中成药|西药|保健品)/.test(text)
  ) return true;
  // 写到的药都已停用、没有正在用的（2026-10-24 C088「普萘洛尔曾短期服用，目前停用」被当成「已提及当前用药但缺少药名/剂量/频次」）：
  // 当前用药状态是明确的「无」。同一份记录里还有现服、正在用、长期用的药时不算。
  const medicationClauses = text.split(/[。；;\n]+/).map((clause) => clause.trim()).filter(Boolean);
  // 只认写明「现在已停」的说法（目前停用、现已停药、已停服、停用至今）；「停药复发」「停药后失眠依旧」说的是过去停过，不算。
  if (medicationClauses.length > 0 &&
    medicationClauses.every((clause) => /(?:目前|现在|现已|现|已经|均已|已)(?:已)?(?:停用|停服|停药)|(?:停用|停服|停药)(?:至今|中)|未再(?:服用|使用)|不再(?:服用|使用)/.test(clause)) &&
    !/(?:现服|正在|仍在|仍服|一直|长期|间断|常(?:服|口服|用)|偶服|每日|每天|在用|目前(?:仍)?(?:服用|使用|口服))/.test(text)) return true;
  const namedDose = /(?:服用|口服|使用|应用|在用|现服|偶服|吃)[^。；\n]{0,10}([\u4e00-\u9fa5A-Za-z]{2,20})\s*\d+(?:\.\d+)?\s*(?:mg|g|ml|毫克|克|片|粒|袋|丸)/i.exec(text) ||
    /(?:^|[，,；;。\n])\s*((?:阿司匹林|华法林|二甲双胍|胰岛素|硝苯地平|缬沙坦|氯吡格雷|褪黑素)|[\u4e00-\u9fa5A-Za-z]{2,20}(?:片|胶囊|颗粒|丸|散|口服液|注射液))\s*\d+(?:\.\d+)?\s*(?:mg|g|ml|毫克|克|片|粒|袋|丸)/i.exec(text);
  if (!namedDose || /^(?:药物|中药|西药|成药|安眠药|降压药|降糖药|抗凝药|止痛药|止咳药)$/.test(namedDose[1])) return false;
  return /(?:每(?:日|天|晚|早|周)|一日|一天|早晚|睡前|晨起|餐前|餐后|必要时|按需|偶尔|不定期|\b(?:bid|tid|qd|qod|prn)\b|\d+\s*次\s*[\/／]\s*(?:日|天|周))/i.test(text);
}

function allergyStatusIsActionable(text: string): boolean {
  if (!isKnownClinicalText(text)) return false;
  if (/(否认|无|没有)[^。；\n]{0,12}(过敏|药物过敏|食物过敏)/.test(text)) return true;
  return /(青霉素|头孢|磺胺|阿司匹林|布洛芬|花粉|海鲜|皮疹|喉头水肿|呼吸困难|过敏性休克|荨麻疹)/.test(text);
}

function allergyHistoryNeedsClarification(text: string): boolean {
  const normalized = stringifyClinicalValue(text).trim();
  if (!normalized) return false;
  if (allergyStatusIsActionable(text)) return false;
  if (/^(?:过敏史|药物过敏|食物过敏)?[:：]?(?:未提及|未采集|未知|不详|待确认|需确认)$/.test(normalized)) {
    return false;
  }
  return /(有|曾|既往|出现过|发生过)[^。；\n]{0,18}(过敏|药物过敏|食物过敏)|过敏体质|易过敏|过敏待查|过敏[^。；\n]{0,18}(不详|不清楚|不明确|待查)|药物过敏史[^。；\n]{0,18}(不详|不清楚|不明确|待查)/.test(normalized);
}

/** 用药记录里写了具体药名（常见药名、剂型构词或西药词尾）。 */
const NAMED_MEDICATION = /(?:阿司匹林|华法林|二甲双胍|胰岛素|硝苯地平|缬沙坦|氯吡格雷|褪黑素|左甲状腺素|[\u4e00-\u9fa5A-Za-z]{2,}(?<![一二两三四五六七八九十半几数\d])(?:片|胶囊|颗粒|丸|口服液|注射液|缓释片|控释片)|[\u4e00-\u9fa5]{1,6}(?:西林|霉素|沙星|洛芬|普利|沙坦|他汀|地平|双胍|格列[\u4e00-\u9fa5]{1,2}|唑仑|西泮|洛尔|替丁|拉唑|噻嗪))/u;

function medicationHistoryNeedsClarification(text: string): boolean {
  const normalized = stringifyClinicalValue(text).trim();
  if (!normalized) return false;
  if (medicationStatusIsActionable(text)) return false;
  if (/^(?:用药史|当前用药|现用药)?[:：]?(?:未提及|未采集|未知|不详|待确认|需确认)$/.test(normalized)) {
    return false;
  }
  return /(服用|口服|使用|注射|应用|在用|现服|偶服|吃)|(?:阿司匹林|华法林|二甲双胍|胰岛素|硝苯地平|缬沙坦|氯吡格雷|褪黑素)|\d+(?:\.\d+)?\s*(?:mg|g|ml|毫克|克|片|粒|袋|丸)/i.test(normalized) ||
    /(正在|长期|目前|当前|平时|一直|近期)?[^。；\n]{0,12}(服用|口服|使用|注射|应用|在用)[^。；\n]{0,18}(药|中药|中成药|西药|保健品|降压药|降糖药|抗凝药|止痛药|安眠药)/.test(normalized) ||
    /(降压药|降糖药|抗凝药|抗血小板药|止痛药|止咳药|安眠药|中成药|中药|西药|保健品)[^。；\n]{0,30}(不详|不清(?:楚)?|忘记|未带|不明确|若干|一些|长期)/.test(normalized) ||
    /(服用|口服|使用|在用)[^。；\n]{0,24}(药|降压药|降糖药|抗凝药|中成药|西药)[^。；\n]{0,30}(药名|剂量|频次)[^。；\n]{0,18}(不详|不清(?:楚)?|不明确|未知)/.test(normalized);
}

function extractMedicationEvidenceText(text: string): string {
  return text
    .split(/[。；;\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => {
      const allergyOnly = /(过敏|不良反应|ADR)/i.test(clause) &&
        !/(当前用药|现用药|用药史|服药|服用|口服|注射|应用|在用|停药|换药|减药|药名|剂量|频次)/.test(clause);
      if (allergyOnly) return false;
      return /(用药|服药|服用|口服|注射|应用|在用|停药|换药|减药|药名|剂量|频次|降压药|降糖药|抗凝药|抗血小板药|止痛药|止咳药|安眠药|中成药|中药|西药|保健品|阿司匹林|华法林|二甲双胍|胰岛素|硝苯地平|缬沙坦|氯吡格雷|[\u4e00-\u9fa5A-Za-z]{2,}(?:片|胶囊|颗粒|丸|散|口服液|注射液)|\b(?:bid|tid|qd|qod)\b)/i.test(clause) ||
        // 裸数值+单位本身不是用药证据：血红蛋白 122g/L、出血 300mL、输液
        // 500mL 都是常见病历量值。只有同一分句还带明确给药频次时，才把它当成
        // 省略药名/动作的当前用药线索。
        /\d+(?:\.\d+)?\s*(?:mg|g|ml)(?!\s*[\/／]\s*(?:l|dl|ml))[^。；\n]{0,20}(?:每(?:日|天|晚|早|周)|一日|一天|早晚|睡前|晨起|餐前|餐后|必要时|按需|偶尔|不定期|\b(?:bid|tid|qd|qod|prn)\b|\d+\s*次\s*[\/／]\s*(?:日|天|周))/i.test(clause);
    })
    .join("；");
}

function extractAllergyEvidenceText(text: string): string {
  return text
    .split(/[。；;\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => /(过敏|不良反应|ADR|青霉素|头孢|磺胺|花粉|海鲜|荨麻疹|喉头水肿|过敏性休克)/i.test(clause))
    .join("；");
}

// A missing chief complaint is the only missing-data hard stop. Every other missing field is a
// high-information follow-up opportunity: the doctor may answer it or explicitly continue with a
// visibly limited candidate. Positive pediatric/pregnancy states and true emergencies are handled
// separately as actual dose boundaries, not confused with an unknown field.
const FORMAL_ADOPTION_BLOCKING_CODES: ReadonlySet<SafetyMissingItemCode> = new Set(["chief_complaint"]);

/**
 * 辨证轴的**非阻断**缺项闭集（2026-08-26，三轴分离后的最终形态）。
 *
 * 24 个缺项码按「这一项不满足，改变的是什么」归三轴：
 *
 *  · 剂量安全轴 —— 改变「能不能给药、给多少」：性别/生理状态、过敏史、当前用药、
 *    妊娠/哺乳/备孕、儿科体重与儿童剂量规则。candidateMode 与儿科/妊娠独立硬边界
 *    已单独管辖剂量，不该再连坐证候命名（拆轴依据同 2026-08-15 红旗/剂量授权两轴）。
 *
 *  · 安全评估/处置轴 —— 改变「要不要先做别的评估」：附加语义筛查不可用、优先临床
 *    评估项、高风险主诉缺体征、情志危机/OSA/甲功专项筛查建议。与 2026-08-01
 *    「检测永不阻断」同一条裁定：红旗本身都允许 M03 继续生成风险分析与鉴别，
 *    专项筛查建议反而清空辨证是自相矛盾。semantic_screen_unavailable 尤其如此——
 *    那是**我方附加层**没跑成（确定性红旗层仍在且该层按设计只增不减），
 *    因我方降级而清空医生的辨证，代价与收益不成比例。
 *    这些码仍进 missingItems → status=needs_information → 剂量照旧不放行、横幅照旧提示。
 *
 *  · 辨证证据轴 / 病历质量轴（**不在本闭集，继续压制**）—— 改变「证候能不能命名」：
 *    主诉缺失、舌象/脉象未取得（四诊合参是证候命名的证据基础），以及年龄冲突、
 *    血压倒置、体征数值非法与来源冲突这类「病历本身不可信」的录入错误。
 *
 * default-deny 不变：不在本闭集的码（含将来新增码）一律按压制处理。
 * 码与条目数不对应（无码追加条目，如妊娠特殊人群复核）同样 fail-closed。
 */
const SYNDROME_AXIS_NON_BLOCKING_CODES: ReadonlySet<SafetyMissingItemCode> = new Set([
  // 剂量安全轴
  "sex_unknown",
  "allergy_unknown",
  "allergy_details",
  "medication_unknown",
  "medication_details",
  "pregnancy_unknown",
  "lactation_unknown",
  "conception_unknown",
  "pediatric_weight_unknown",
  "pediatric_age_unknown",
  // 旧快照可能带着它（2026-09-30 起不再产生：儿童剂量改按年龄分数法折算）。
  "pediatric_dose_rules_unavailable",
  // 安全评估/处置轴
  "semantic_screen_unavailable",
  "priority_evaluation_required",
  "high_risk_missing_vitals",
  "behavioral_crisis_screening",
  "osa_screening",
  "thyroid_screening",
]);

export function syndromeAxisInformationSufficient(
  gate: SafetyGate | null | undefined,
  state?: CaseState,
): boolean {
  if (!gate) return false;
  const codes = gate.missingItemCodes || [];
  const items = gate.missingItems || [];
  if (gate.status === "ready") {
    // Filling the final dose-context gap must not invalidate the same syndrome evidence. A ready
    // flag alone is not evidence: recompute the existing clinical axes from the current record,
    // rather than trusting model-supplied completeness or reviving a cleared tongue/pulse field.
    if (!state || !gate.allowDiagnosis || codes.length || items.length) return false;
    const actual = deriveOperationalCompleteness(state);
    return hasObtainedTongueFinding(state) && hasObtainedPulseFinding(state) &&
      actual.infoGain >= 0.6 && actual.managementImpact >= 0.6 && actual.answerability >= 0.6;
  }
  if (gate.status !== "needs_information") return false;
  if (codes.length === 0 || codes.length !== items.length) return false;
  return codes.every((code) => SYNDROME_AXIS_NON_BLOCKING_CODES.has(code));
}

function semanticScreeningUnavailableItem(state: CaseState): string | undefined {
  if (state.clinicalFacts?.sourceCoverage === "partial") {
    return "病历超出语义红旗预检完整覆盖范围";
  }
  // 事实层复核相位 2026-09-25 删除后，本轮结果一律是 single_pass（已完成态）。这里只可能被
  // **存量浏览器状态**里 reviewStatus 停在旧值（skipped 等）的快照触发，处置与此前一致（视为未完成）；
  // 文案不再提一个已不存在的「独立复核」环节。
  if (state.clinicalFacts?.semanticStatus === "checked" && !clinicalFactsReviewSettled(state.clinicalFacts.reviewStatus)) {
    return "语义红旗预检结果来自旧版本，需重新预检";
  }
  if (state.clinicalFacts?.semanticStatus !== "unavailable") return undefined;
  const reasonLabels = {
    disabled: "语义模型已禁用",
    aborted: "请求中止",
    timeout: "模型超时",
    model_error: "模型调用失败",
    invalid_output: "模型输出无效",
    signing_unavailable: "可信签名不可用",
  } as const;
  const reason = state.clinicalFacts.unavailableReason;
  return `语义红旗筛查未完成${reason ? `（${reasonLabels[reason]}）` : ""}`;
}

export function canForceProceedPastSafetyGate(gate: SafetyGate | undefined): boolean {
  if (!gate) return false;
  if (gate.status === "red_flag") return false;
  if (gate.status === "ready") return true;
  if (gate.missingItemCodes && gate.missingItemCodes.length === gate.missingItems.length) {
    return gate.missingItemCodes.length > 0 && gate.missingItemCodes.every((code) => !FORMAL_ADOPTION_BLOCKING_CODES.has(code));
  }
  // Compatibility for drafts persisted before typed missing-item codes were introduced.
  return gate.missingItems.length > 0 && gate.missingItems.every((item) => item !== "主诉");
}

export function hardDoseSafetyBoundaryReasons(state: CaseState): string[] {
  const gate = evaluateSafetyGate(state);
  if (gate.status === "red_flag") return gate.redFlags.length > 0 ? gate.redFlags : ["命中急危重红旗"];
  const text = structuredCaseText(state);
  const reasons: string[] = [];
  // 儿童只有「年龄段判不出」才是硬边界；判得出的按年龄分数法折算（pediatric-dose-rule），不再一律收回剂量。
  if (isPediatricPatient(state) && !pediatricDoseRuleForCase(state)) {
    reasons.push(PEDIATRIC_AGE_STAGE_UNKNOWN_REASON);
  }
  if (hasPositivePregnancyOrLactationRisk(maternalStateText(state, text))) {
    reasons.push("已记录妊娠、哺乳或备孕阳性/可疑状态");
  }
  reasons.push(...highRiskDoseBoundaryReasons(state));
  return reasons;
}

export function hasHardDoseSafetyBoundary(state: CaseState): boolean {
  return hardDoseSafetyBoundaryReasons(state).length > 0;
}

export type PrescriptionPermission = {
  candidateMode: "full_dose" | "limited_dose" | "non_dose_only" | "blocked";
  formalAdoption: "eligible_after_doctor_confirmation" | "blocked";
  reasons: string[];
  /** 儿童且年龄段可判时给出的折算档位；下游（提示词、合同、编译器、HIS）只读这一个结果。 */
  pediatricDose?: PediatricDoseRule;
};

function hasNonNegatedClinicalPattern(text: string, pattern: RegExp): boolean {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    const index = match.index ?? -1;
    if (index < 0 || isExcludedClinicalAssertionAt(text, index)) continue;
    if (!isNegatedAt(text, index) || hasCommaSeparatedPositiveEvidence(text, index, match[0])) return true;
  }
  return false;
}

function hasReducedEgfr(text: string): boolean {
  for (const match of text.matchAll(/eGFR\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)/gi)) {
    const index = match.index ?? -1;
    const value = Number(match[1]);
    if (index < 0 || !Number.isFinite(value) || value >= 60) continue;
    if (!isExcludedClinicalAssertionAt(text, index) && !isNegatedAt(text, index)) return true;
  }
  return false;
}

/**
 * Dose-level plans are intentionally stricter than diagnostic discussion. These conditions span
 * diseases, objective renal/cardiac measurements, treatment state and medicines, so the gate works
 * from clinical concepts rather than individual test-case sentences. The independent M04 reviewer
 * remains a semantic backstop for equivalent wording that the deterministic lower bound cannot see.
 */
/**
 * 病历里写明的儿童年龄与登记年龄冲突（2026-10-18）：登记年龄是成人（≥18 岁），病历却写「患儿，8个月」「男婴，3个月」「6岁患儿」。
 * 结构化年龄优先的口径下这类病例按成人给了剂量（验收集 X-G-1792：8 个月患儿生地黄 12g、知母 9g）。两边说的是同一个患者时
 * 只能有一个对，涉及儿童剂量就先核实，不按任何一边折算。只认儿童称谓紧接年龄的写法，「其子5岁」这类他人年龄不算。
 * 返回病历写的年龄（岁），不冲突返回 undefined。
 */
export function narrativePediatricAgeConflict(state: CaseState): number | undefined {
  const registered = numberFromClinicalText(patientAgeText(state));
  if (registered == null || registered < 18) return undefined;
  const text = [state.chiefComplaint, trustedInputText(state)].filter(Boolean).join("。");
  const forward = /(?:患儿|婴儿|新生儿|男婴|女婴|宝宝|小儿|男孩|女孩|男童|女童)[，,、\s]*(\d{1,3})\s*(个月|月龄|天|日|岁)(?![前来余后内])/u.exec(text);
  const backward = /(\d{1,2})\s*岁(?:的)?(?:患儿|男孩|女孩|男童|女童|小儿)/u.exec(text);
  const years = forward
    ? Number(forward[1]) / (/(?:个月|月龄)/u.test(forward[2]) ? 12 : /(?:天|日)/u.test(forward[2]) ? 365 : 1)
    : backward ? Number(backward[1]) : undefined;
  return years != null && years < 18 ? years : undefined;
}

/**
 * 家族史一栏的原文（甲方传参形状里是 symptoms 的「家族史」键，HIS 字段同名）。拍平后的病历不带栏名，
 * 「母亲健在，患有冠心病、心力衰竭」逗号后那一小句没有主语，按小句判主语时算成了患者本人（2026-10-19 Claude 评审 M 集 MTCMB-21：
 * 患者本人无心衰，剂量因「心力衰竭…需完成剂量复核」被收回）。
 */
function familyHistoryFieldTexts(state: CaseState): string[] {
  const fromSymptoms = Object.entries((state.symptoms || {}) as Record<string, unknown>)
    .filter(([key]) => /家族史/u.test(key)).map(([, value]) => stringifyClinicalValue(value));
  const fromHis = Object.entries(state.hisRecord?.fields || {})
    .filter(([key]) => /家族史/u.test(key)).map(([, value]) => stringifyClinicalValue(value));
  return [...fromSymptoms, ...fromHis].map((value) => value.trim()).filter((value) => value.length >= 4);
}

/** 免疫抑制治疗：安全门「当前免疫抑制治疗」与注意事项「不要自行停用或减量」读同一份（2026-10-19 起导出）。 */
export const IMMUNOSUPPRESSIVE_MEDICATION = /(?:环孢素|他克莫司|吗替麦考酚酯|霉酚酸|硫唑嘌呤|甲氨蝶呤|来氟米特|环磷酰胺|生物制剂|免疫抑制剂|长期[^。；\n]{0,8}(?:泼尼松|糖皮质激素)|正在[^。；\n]{0,8}(?:泼尼松|糖皮质激素))/i;
/** 全身用糖皮质激素的药名（INN 词干「-松/-龙」的中文通用名与俗名，闭集）：骤停有肾上腺皮质功能不全的风险，注意事项写「不要自行停用或减量」。 */
export const CORTICOSTEROID_MEDICATION = /泼尼松|泼尼龙|强的松|可的松|地塞米松|倍他米松|曲安西龙|激素/u;
/** 抗凝、抗血小板药：安全门「当前抗凝或抗血小板治疗」与注意事项的出血观察一条读同一份（2026-10-19 起导出）。 */
// 「华法令」是华法林的另一种音译写法，老病案常见（2026-10-20 第十轮 S 集 S-anticoag-004/007：认不出，口服华法令的房颤患者给了剂量）。
export const ANTITHROMBOTIC_MEDICATION = /(?:华法林|华法令|利伐沙班|阿哌沙班|达比加群|艾多沙班|肝素|依诺肝素|磺达肝癸钠|抗凝药|抗凝治疗|阿司匹林|氯吡格雷|替格瑞洛|普拉格雷|抗血小板)/i;

/**
 * 病历写着通常须长期抗凝或抗血小板的情形、却没写药名（2026-10-19 Claude 评审 M 集 MTCMB-42：冠脉支架术后 3 个月、右下肢深静脉血栓，
 * 方含丹参、川芎，注意事项没有出血一条）。闭集：冠脉支架/PCI 术后、深静脉血栓、肺栓塞、心房颤动、机械瓣置换——
 * 2016 ACC/AHA 双联抗血小板指南（支架术后 6–12 个月）、CHEST 2021 静脉血栓栓塞指南（至少 3 个月抗凝）、2020 ESC 房颤指南。
 * 只用于注意事项「如正在服用抗凝或抗血小板药」那一句，不进安全门。返回病历里的说法；否认的不算。
 */
const ANTITHROMBOTIC_INDICATION = /PCI|经皮冠状动脉介入|冠脉支架|冠状动脉支架|(?:植入|置入)[^，,。；;]{0,6}支架|深静脉血栓|肺栓塞|心房颤动|房颤|机械瓣|瓣膜置换/iu;
export function antithromboticIndicationRecorded(state: CaseState): string | undefined {
  const source = familyHistoryFieldTexts(state).reduce((text, family) => text.split(family).join(""), trustedInputText(state));
  if (!hasNonNegatedClinicalPattern(source, ANTITHROMBOTIC_INDICATION)) return undefined;
  const hit = source.match(ANTITHROMBOTIC_INDICATION)?.[0] || "";
  // 写给患者的说法：病历原文（「于OM植入1枚支架」「房颤」）换成病名。
  if (/深静脉血栓/u.test(hit)) return "深静脉血栓";
  if (/肺栓塞/u.test(hit)) return "肺栓塞";
  if (/房颤|心房颤动/u.test(hit)) return "心房颤动";
  if (/瓣/u.test(hit)) return "心脏瓣膜置换";
  return "冠脉支架植入";
}

/**
 * 病历写着患者本人有糖尿病（「2型糖尿病」「10年糖尿病史」「平素血糖控制欠佳」），家族史与否认的不算。注意事项写控糖与血糖监测一条用
 *（2026-10-19 Claude 评审 M 集 TCM-SD-453850、BEST4SDT-250）。
 */
const DIABETES_RECORDED = /糖尿病|消渴|血糖控制(?:不佳|欠佳|差|不理想)/u;
/** 已签名的西医诊断就是糖尿病（不是「糖尿病待查/待排/可能」）。 */
export function diabetesDiagnosisConfirmed(westernName: string): boolean {
  return /糖尿病(?!待查|待排|可能|\?|？)/u.test(westernName);
}
export function diabetesRecorded(state: CaseState): boolean {
  const source = familyHistoryFieldTexts(state).reduce((text, family) => text.split(family).join(""), trustedInputText(state));
  return hasNonNegatedClinicalPattern(source, DIABETES_RECORDED);
}

export function highRiskDoseBoundaryReasons(state: CaseState): string[] {
  // 患者本人的病（肾功能不全、心衰、糖尿病足…）不从家族史一栏里读。
  const source = familyHistoryFieldTexts(state).reduce((text, family) => text.split(family).join(""), trustedInputText(state));
  const medicationSource = [
    authoritativeFieldOrFallback(state, "yongyaoshi", state.medicationHistory),
    extractMedicationEvidenceText(source),
  ].filter(Boolean).join("；");
  const activeMedication = affirmedCurrentMedicationText(medicationSource) || "";
  const reasons: string[] = [];
  const push = (value: string) => {
    if (!reasons.includes(value)) reasons.push(value);
  };

  if (narrativePediatricAgeConflict(state) != null) {
    push("病历写明的患儿年龄与登记年龄不一致，涉及儿童剂量折算，需先核实年龄");
  }
  if (hasNonNegatedClinicalPattern(source, /(?:CKD|慢性肾脏病|慢性肾病)(?:[^。；\n]{0,12}(?:[3-5三四五]期|Ⅲ|Ⅳ|Ⅴ))|(?:肾功能不全|肾衰竭|尿毒症)/i) || hasReducedEgfr(source)) {
    push("慢性肾病3-5期、eGFR降低或肾功能不全需专科/药师完成个体化剂量复核");
  }
  if (hasNonNegatedClinicalPattern(source, /(?:心力衰竭|心衰|HFrEF|HFpEF|射血分数\s*(?:EF)?\s*[:：]?\s*(?:[1-3]?\d(?:\.\d+)?)\s*%|EF\s*[:：]?\s*(?:[1-3]?\d(?:\.\d+)?)\s*%)/i)) {
    push("心力衰竭或射血分数降低需结合容量状态、肾功能及现用药完成剂量复核");
  }
  if (ANTITHROMBOTIC_MEDICATION.test(activeMedication)) {
    push("当前抗凝或抗血小板治疗需完成出血风险与药物相互作用复核");
  }
  if (IMMUNOSUPPRESSIVE_MEDICATION.test(activeMedication)) {
    push("当前免疫抑制治疗需完成感染、肝肾功能及药物相互作用复核");
  }
  if (hasNonNegatedClinicalPattern(source, /(?:糖尿病足|糖尿病性足溃疡|足部溃疡|足坏疽|糖足)/i)) {
    push("糖尿病足、足部溃疡或坏疽需先完成创面、感染和血供分级");
  }
  if (hasNonNegatedClinicalPattern(source, /(?:(?:活动期|急性发作|再次发作|明显加重|未控制)[^。；\n]{0,16}(?:系统性红斑狼疮|红斑狼疮|类风湿关节炎|血管炎|炎症性肠病|自身免疫病)|(?:系统性红斑狼疮|红斑狼疮|类风湿关节炎|血管炎|炎症性肠病|自身免疫病)[^。；\n]{0,16}(?:活动期|急性发作|再次发作|明显加重|未控制))/i)) {
    push("活动期自身免疫性疾病需由相关专科与药师联合复核后再决定剂量方案");
  }
  return reasons;
}

/**
 * 不给剂量时复诊提示按哪一类原因写节点（2026-10-21 第十二轮；验收 S 集「随访可操作」90.4%：不给剂量的页只写「按医生安排复诊」，
 * 没有天数、没有观察指标）。判据与 derivePrescriptionPermission 的各条边界同源：红旗 → 今天急诊；妊娠、哺乳、抗凝 → 3 天内面诊
 *（抗凝另写开始服药后 1 周内复查凝血）；患儿年龄不明 → 补充年龄当天；肾功能不全、心衰、免疫抑制、糖尿病足、活动期自身免疫病 → 3 天内专科；
 * 其余（语义复核未完成等）→ 3 天内就诊。给剂量的病例返回 undefined。
 */
export type DoseWithheldFollowupKind = "red_flag" | "pregnancy" | "lactation" | "anticoagulant" | "pediatric_age" | "specialist" | "other";
/**
 * 给了剂量、但安全门要求「正式采纳前需优先完成临床评估」时，复诊计划的第一句要先说去评估（2026-10-24 甲方 100 例：突发性耳聋、
 * 结核密切接触、疑似风湿热、恶性胆道梗阻待排等 16 例照写「请服完本次的药后复诊」，与安全门的要求相反）。
 * 返回评估要排除的情况（开放判断写的「需排除：X」）；只有类目提示、没有具体去向时返回空串；不需要优先评估或已是红旗时 undefined。
 */
export function priorityEvaluationFollowupFocus(state: CaseState): string | undefined {
  return priorityEvaluationFollowupTarget(state)?.focus;
}

export type PriorityEvaluationPathway = keyof typeof priorityEvaluationWindowTable.pathways;
/** 复诊计划第一句的评估对象：要排除什么、最迟多久、走哪条专门路径（2026-10-26 第二十一轮）。 */
export type PriorityEvaluationTarget = { focus: string; window: PriorityEvaluationWindowId; pathway?: PriorityEvaluationPathway };

/**
 * 时限取各来源里最紧的一档：事实模型对「宜先专科评估」各项给的 timeWindow、乳房肿块的疑似肿瘤路径（两周内）、
 * 血糖与酮体达到 DKA 两项标准（24 小时内），其余按缺省 3 天内。此前只有一个常量和一条按病名的正则。
 */
export function priorityEvaluationFollowupTarget(state: CaseState): PriorityEvaluationTarget | undefined {
  const gate = evaluateSafetyGate(state);
  if (gate.status === "red_flag") return undefined;
  const item = (gate.missingItems || []).find((entry) => entry.includes("优先完成临床评估"));
  if (!item) return undefined;
  const focus = item.match(/需排除：(.+?)）；处方前/u)?.[1]?.trim() || "";
  const defaultWindow = priorityEvaluationWindowTable.defaultWindow as PriorityEvaluationWindowId;
  const rank = (window: PriorityEvaluationWindowId) => PRIORITY_EVALUATION_WINDOWS.indexOf(window);
  const entries = collectPriorityEvaluationEntries(state, trustedInputText(state));
  if (entries.length === 0) return { focus, window: defaultWindow };
  const most = entries.reduce((best, next) => rank(next.window || defaultWindow) < rank(best.window || defaultWindow) ? next : best);
  return {
    focus: most.focus ?? (most.text.match(/需排除：(.+?)）/u)?.[1]?.trim() || focus),
    window: most.window || defaultWindow,
    ...(most.pathway ? { pathway: most.pathway } : {}),
  };
}

/** 病历文本里患者本人有糖尿病（家族史一栏另由 diabetesRecorded 剔除；这里给门禁用，读同一份可信文本）。 */
function diabetesRecordedInText(text: string, state: CaseState): boolean {
  const source = familyHistoryFieldTexts(state).reduce((value, family) => value.split(family).join(""), text);
  return hasNonNegatedClinicalPattern(source, DIABETES_RECORDED);
}

/**
 * ADA 2024 高血糖危象共识的 DKA 前两项（血糖 ≥11.1 mmol/L 或既往糖尿病；尿酮 ≥2+ 或血酮 ≥3.0 mmol/L）同时成立。
 * 只读数值：「酮体(++)」「尿酮2+」「β-羟丁酸 3.4 mmol/L」「随机血糖 21.0 mmol/L」「GLU 380 mg/dL」；「最高/既往/曾」的读数不算。
 */
const KETOSIS_THRESHOLDS = priorityEvaluationWindowTable.hyperglycemicKetosisThresholds;
const HISTORICAL_LAB_CUE = /(?:最高|既往|曾|以前|此前|上次|去年|年前|月前)[^。；;\n，,]{0,6}$/u;
function hyperglycemicKetosisSignal(text: string, diabetesKnown: boolean): boolean {
  const normalized = normalizeClinicalText(text);
  const current = (index: number) => !HISTORICAL_LAB_CUE.test(normalized.slice(Math.max(0, index - 12), index));
  let glucoseHigh = diabetesKnown;
  for (const match of normalized.matchAll(/(?:血糖|葡萄糖|GLU)[^。；;\n\d]{0,10}?(\d+(?:\.\d+)?)\s*(mmol\s*\/\s*L|mg\s*\/\s*dL)?/giu)) {
    if (!current(match.index ?? 0)) continue;
    const value = Number(match[1]);
    const mgdl = /mg/iu.test(match[2] || "");
    if (mgdl ? value >= KETOSIS_THRESHOLDS.glucoseMgPerDl : value >= KETOSIS_THRESHOLDS.glucoseMmolPerL && value < 100) glucoseHigh = true;
  }
  if (!glucoseHigh) return false;
  for (const match of normalized.matchAll(/(?:尿)?酮体?\s*[（(：:]?\s*(\+{1,4}|[1-4]\s*\+)/gu)) {
    if (!current(match.index ?? 0)) continue;
    const plus = /^\d/u.test(match[1]) ? Number(match[1].replace(/\D/gu, "")) : match[1].length;
    if (plus >= KETOSIS_THRESHOLDS.urineKetonePlus) return true;
  }
  for (const match of normalized.matchAll(/(?:血酮(?:体)?|β\s*-?\s*羟丁酸|BHB)[^。；;\n\d]{0,8}?(\d+(?:\.\d+)?)/giu)) {
    if (!current(match.index ?? 0)) continue;
    if (Number(match[1]) >= KETOSIS_THRESHOLDS.bloodKetoneMmolPerL) return true;
  }
  return false;
}

export function doseWithheldFollowupKind(state: CaseState): DoseWithheldFollowupKind | undefined {
  const gate = evaluateSafetyGate(state);
  if (gate.status === "red_flag") return "red_flag";
  const permission = derivePrescriptionPermission(state);
  if (permission.candidateMode !== "non_dose_only" && permission.candidateMode !== "blocked") return undefined;
  const maternal = maternalStateText(state, structuredCaseText(state));
  if (isPositiveOrPossibleClinicalState(assessPregnancyState(maternal))) return "pregnancy";
  if (isPositiveOrPossibleClinicalState(assessLactationState(maternal))) return "lactation";
  if ((isPediatricPatient(state) && !pediatricDoseRuleForCase(state)) || narrativePediatricAgeConflict(state) != null) return "pediatric_age";
  const highRisk = highRiskDoseBoundaryReasons(state);
  if (highRisk.some((reason) => reason.includes("抗凝"))) return "anticoagulant";
  if (highRisk.length > 0) return "specialist";
  return "other";
}

/**
 * 红旗病例的**剂量授权**开关。
 *
 * 安全门的处置口径只有一种（甲方产品决策 2026-08-01；owner 2026-09-25 删除 block 回退档）：
 * 检测层照常执行、照常进 HIS 载荷，命中换来的是完整结果 + 置顶安全警示横幅 + 审方复核提示，
 * 而不是一页「未形成结论」。剂量授权是另一回事——它决定 M04 能不能印出具体克数。
 * 【为什么必须单独成轴】此前剂量授权曾与处置档位绑在一个开关上：为了「不阻断流程」而放行剂量，
 * 顺带把儿科体重缺失、妊娠阳性这些与红旗无关的硬边界一起放行了。
 *
 * 默认 withhold：红旗未解除时不给剂量级候选，与 2026-08-15 起的线上行为一致。
 * allow 是**运维回退档**：切回「红旗也照常出剂量方、由医生按警示自行裁量」的旧行为，
 * 不需要改代码或重新构建。回退后独立硬边界（儿科/妊娠/语义筛查/高危剂量）依然拦截——
 * 这一条不受本开关影响，也不该受。
 */
export function redFlagDoseAuthorizationAllowed(): boolean {
  return (process.env.CDSS_REDFLAG_DOSE_AUTHORIZATION || "withhold").trim().toLowerCase() === "allow";
}

/** 集成方用于识别「本响应携带未解除安全警示」的稳定标记（见对外接口文档）。 */
export const SAFETY_ADVISORY_MARKER = "<!-- CDSS_SAFETY_ADVISORY -->";

/**
 * 置顶安全警示横幅。内容全部来自确定性安全门的判定结果，不经模型；
 * 前置到可见正文最前，不进入结构化 sentinel，也不参与合同签名载荷。
 */
export function buildSafetyAdvisoryBanner(
  gate: SafetyGate | null | undefined,
  extraNotes: readonly string[] = [],
): string {
  // 每一条不同的红旗都列出（2026-10-19）：去重；语义层红旗末尾的「原文依据：“…”」不进横幅（横幅只说要处置什么，原文在红旗详情里）。
  const redFlags = [...new Set((gate?.redFlags || [])
    .map((flag) => String(flag || "").replace(/[，,；;]?\s*原文依据[：:][\s\S]*$/u, "").trim())
    .filter(Boolean))];
  const reasons = (gate?.reasons || []).filter(Boolean);
  const notes = extraNotes.filter(Boolean);
  if (redFlags.length === 0 && reasons.length === 0 && notes.length === 0) return "";
  const lines = [
    SAFETY_ADVISORY_MARKER,
    "> ⚠️ **安全警示（未解除，请医生优先处置）**",
  ];
  if (redFlags.length > 0) lines.push(`> - 红旗提示：${redFlags.join("；")}`);
  for (const reason of reasons) lines.push(`> - ${reason}`);
  for (const note of notes) lines.push(`> - ${note}`);
  // 2026-10-13：横幅是给接诊医生看的，不写「候选/采纳/审方」这类系统流程词。
  lines.push("> - 以下分析与方药供医生在处置上述风险之后参考，用药前请再次核对。");
  return `${lines.join("\n")}\n\n`;
}

/**
 * Candidate generation and formal adoption are separate permissions. Clinical alerts and audit
 * outcomes remain visible, but they cannot silently change either permission. This is the single
 * authority consumed by M04, the workbench and the HIS integration payload.
 */
export function derivePrescriptionPermission(state: CaseState): PrescriptionPermission {
  const permission = deriveBasePrescriptionPermission(state);
  // 儿童且年龄段可判、且本例仍允许出剂量：把折算档位并入结果（有限信息/满信息两条出口都带上）。
  // 说明文字**不进 reasons**：reasons 是「正式采纳前需确认/待复核」清单，折算口径不是待确认项
  // （2026-09-30 回放：它曾以「需确认：儿童（乳婴儿…）剂量按年龄分数法折算…」出现在信息完整性边界里）。
  // 口径由 pediatricDose 携带，页面「儿童用药说明」与各药核对语读它。收回剂量的出口不带——那里没有剂量可折算。
  if (permission.candidateMode !== "limited_dose" && permission.candidateMode !== "full_dose") return permission;
  const pediatricDose = pediatricDoseRuleForCase(state);
  if (!pediatricDose) return permission;
  return {
    ...permission,
    pediatricDose,
  };
}

function deriveBasePrescriptionPermission(state: CaseState): PrescriptionPermission {
  const gate = evaluateSafetyGate(state);
  const chiefComplaint = (state.chiefComplaint || fieldText(state, "zhushu")).trim();
  if (!chiefComplaint) {
    return { candidateMode: "blocked", formalAdoption: "blocked", reasons: ["缺少主诉"] };
  }
  // 红旗**不再提前返回**。原先两版都在这里 return，于是儿科体重缺失、妊娠阳性、
  // 语义筛查不可用这几道与红旗无关的独立硬边界根本轮不到评估：
  //   · 旧版 advise 档直接给 full_dose ⇒ 红旗儿科病例反而拿到了完整剂量方；
  //   · 新版无条件 non_dose_only ⇒ 结论碰巧安全，但开关失效、且掩盖了上面那个排序缺陷。
  // 现在只在函数末尾按各自理由汇总，红旗只决定「要不要收回剂量授权」这一件事。
  if (gate.status === "red_flag" && !redFlagDoseAuthorizationAllowed()) {
    const redFlagReasons = gate.redFlags && gate.redFlags.length > 0
      ? [...gate.redFlags]
      : ["当前存在急危重分流提示"];
    return {
      candidateMode: "non_dose_only",
      formalAdoption: "blocked",
      reasons: Array.from(new Set([...redFlagReasons, ...highRiskDoseBoundaryReasons(state)])),
    };
  }

  // 独立硬边界先于「信息覆盖有限」判定（2026-10-13）。此前顺序反过来：完整度不到 C 且一轮追问都没答时
  // 先返回 limited_dose，妊娠阳性/可疑、哺乳、抗凝、患儿年龄不明、语义筛查未完成这几道边界轮不到评估——
  // 同一份病历写得越少反而越能拿到剂量（实测妊娠 12 周给出带剂量方），而 M05 读的
  // hardDoseSafetyBoundaryReasons 同时在说「不得采纳」。与上面红旗分支当年的提前返回是同一个排序缺陷。
  const text = structuredCaseText(state);
  const pediatric = isPediatricPatient(state);
  const pediatricDose = pediatricDoseRuleForCase(state);
  const positivePregnancyOrLactation = hasPositivePregnancyOrLactationRisk(maternalStateText(state, text));
  const highRiskReasons = highRiskDoseBoundaryReasons(state);
  const nonDoseReasons = [
    pediatric && !pediatricDose ? PEDIATRIC_AGE_STAGE_UNKNOWN_REASON : "",
    positivePregnancyOrLactation ? "已记录妊娠、哺乳或备孕阳性/可疑状态" : "",
    ...highRiskReasons,
  ].filter(Boolean);
  if (nonDoseReasons.length > 0) {
    return { candidateMode: "non_dose_only", formalAdoption: "blocked", reasons: nonDoseReasons };
  }

  const semanticSafetyUnverified = gate.missingItemCodes?.includes("semantic_screen_unavailable") === true;
  if (semanticSafetyUnverified) {
    return {
      candidateMode: "non_dose_only",
      formalAdoption: "blocked",
      reasons: Array.from(new Set([
        "本次临床风险复核未完成，当前仅生成非剂量临床分析",
        ...(gate.missingItems || []),
      ])),
    };
  }

  const operationalCompleteness = deriveOperationalCompleteness(state);
  if (operationalCompleteness.level !== "C" && state.questionRounds < 1) {
    // 信息覆盖有限降级为「有限信息候选」而不是拒绝——追问是增强手段，不是门槛。
    return {
      candidateMode: "limited_dose",
      formalAdoption: "eligible_after_doctor_confirmation",
      reasons: ["当前病历关键信息覆盖有限，候选按有限信息生成；建议补充一轮追问以提高信心"],
    };
  }

  if (operationalCompleteness.level !== "C") {
    return {
      candidateMode: "limited_dose",
      formalAdoption: "eligible_after_doctor_confirmation",
      reasons: Array.from(new Set([
        "已完成追问但关键信息仍有限；可生成有限信息候选，正式采纳前需医生逐项确认未知边界",
        ...(gate.missingItems || []),
        ...(gate.advisories || []),
      ])),
    };
  }

  if (gate.status === "needs_information" || gate.missingItems.length > 0) {
    return {
      candidateMode: "limited_dose",
      formalAdoption: "eligible_after_doctor_confirmation",
      reasons: Array.from(new Set([...(gate.missingItems || []), ...(gate.advisories || [])])),
    };
  }
  return {
    candidateMode: "full_dose",
    formalAdoption: "eligible_after_doctor_confirmation",
    reasons: gate.advisories || [],
  };
}

/**
 * Keep every doctor-actionable prescription boundary visible. Permission reasons and safety-gate
 * missing items overlap frequently, but neither list is a substitute for the other.
 */
export function mergePrescriptionReviewItems(
  permissionReasons: readonly string[] = [],
  safetyMissingItems: readonly string[] = [],
): string[] {
  return Array.from(new Set(
    [...permissionReasons, ...safetyMissingItems]
      .map((item) => item.trim())
      .filter(Boolean),
  ));
}

/**
 * 指南红旗判别项 → 闸门（2026-10-26 第二十一轮；表与口径见 redflag-discriminators.ts）。文字项读事实层里带着的读病历结果
 *（引文须仍在本次可信文本里），数值项读本次实测生命体征。只会多报，不撤销任何判断。
 */
const DISCRIMINATOR_OUTCOME_CACHE = new WeakMap<CaseState, DiscriminatorOutcome>();
function discriminatorOutcomeForState(state: CaseState): DiscriminatorOutcome {
  // 同一次门禁求值里会读三次（红旗、优先评估、提示），按病例对象记一次。
  const cached = DISCRIMINATOR_OUTCOME_CACHE.get(state);
  if (cached) return cached;
  const outcome = computeDiscriminatorOutcome(state);
  DISCRIMINATOR_OUTCOME_CACHE.set(state, outcome);
  return outcome;
}
function computeDiscriminatorOutcome(state: CaseState): DiscriminatorOutcome {
  const ageYears = authoritativePatientAgeYears(state);
  const sourceText = trustedInputText(state);
  const screen = state.clinicalFacts?.discriminatorScreen;
  const verifiedScreen = screen && screen.status === "checked"
    ? { ...screen, present: screen.present.filter((item) => sourceText.includes(item.quote)) }
    : screen;
  const vitals = currentVitalMeasurements(state);
  return evaluateDiscriminators({
    patient: {
      ageMonths: ageYears != null ? ageYears * 12 : undefined,
      pregnant: assessPregnancyState(maternalStateText(state, structuredCaseText(state))).status === "positive",
    },
    vitals: {
      temperature: vitals.temperature,
      heartRate: vitals.pulse,
      respiratoryRate: vitals.respiration,
      spo2: vitals.spo2,
      systolicBP: vitals.bloodPressure?.systolic,
    },
    screen: verifiedScreen,
  });
}

/** 两路读病历的指南核对都没完成时，给医生的当面核对清单（不改处置；语义筛查失败本身另有缺项、不给剂量）。 */
function discriminatorChecklistAdvisory(state: CaseState): string[] {
  const facts = state.clinicalFacts;
  // 危急生命体征已直接定红旗时事实层不跑，也就没有这份结果，不出清单。
  if (facts?.discriminatorScreen?.status !== "unavailable") return [];
  const ageYears = authoritativePatientAgeYears(state);
  const labels = redFeatureChecklistForPatient({ ageMonths: ageYears != null ? ageYears * 12 : undefined });
  return labels.length > 0
    ? [`指南红色征象的核对没有完成（读病历的复核没有返回），请当面逐项确认有无：${labels.join("；")}。有任何一项请立即急诊评估`]
    : [];
}

/**
 * 本系统自己的西医主诊断是急危重病名、安全门却没有红旗时补报一条（2026-10-26 第二十一轮；病名表 emergency-diagnosis-names.source.json）。
 * 只读确定的写法（不带待查、待排、可能、既往、术后）；只会多报。
 */
const EMERGENCY_DIAGNOSIS_STEMS = emergencyDiagnosisNames.names.map((entry) => entry.stem).sort((a, b) => b.length - a.length);
const EMERGENCY_DIAGNOSIS_EXCLUDED = new RegExp(emergencyDiagnosisNames.excludeQualifiers, "u");
export function ownEmergencyDiagnosisName(state: CaseState): string | undefined {
  const reasoning = state.reasoningDiagnose as { stage?: unknown; westernDiagnosis?: { primary?: { name?: unknown } } } | undefined;
  if (!reasoning || reasoning.stage !== "diagnose") return undefined;
  const name = typeof reasoning.westernDiagnosis?.primary?.name === "string" ? reasoning.westernDiagnosis.primary.name.trim() : "";
  if (!name || EMERGENCY_DIAGNOSIS_EXCLUDED.test(name)) return undefined;
  return EMERGENCY_DIAGNOSIS_STEMS.some((stem) => name.includes(stem)) ? name : undefined;
}

type PriorityEvaluationEntry = { text: string; window?: PriorityEvaluationWindowId; pathway?: PriorityEvaluationPathway; focus?: string };

/**
 * 开方前须优先完成的临床评估项（安全门写缺项文字、复诊计划定时限，同一份清单；2026-10-26 第二十一轮从门禁里抽出）。
 * window：这一项最迟多久内评估；没有的按缺省 3 天内。
 */
function collectPriorityEvaluationEntries(state: CaseState, semanticSourceText: string): PriorityEvaluationEntry[] {
  const entries: PriorityEvaluationEntry[] = priorityEvaluationItemsFromFacts(state.clinicalFacts, semanticSourceText).map((text) => ({ text }));
  const texts = () => entries.map((entry) => entry.text);
  // 开方前处置去向（开放判断）：类目表之外的必须排除情况也扣剂量，见 clinical-facts ClinicalDisposition。
  const dispositionWindow = dispositionPriorityWindowFromFacts(state.clinicalFacts, semanticSourceText);
  const dispositionItems = dispositionPriorityItemsFromFacts(state.clinicalFacts, semanticSourceText, texts());
  for (const text of dispositionItems) {
    entries.push({ text, ...(dispositionWindow && text.includes("宜先由西医相关专科尽快评估") ? { window: dispositionWindow } : {}) });
  }
  // 处置去向与类目条目引同一句原文时不单列（见 dispositionPriorityItemsFromFacts），它的时限与要排除的情况挂到那条类目条目上。
  const dispositionTarget = dispositionItems.length === 0 ? dispositionPriorityTargetFromFacts(state.clinicalFacts, semanticSourceText) : undefined;
  // 没有引同一句的，挂到第一条还没有时限的条目上：时限是模型对这一病例要排除的情况给的，只会让复诊更早。
  const sharedQuoteEntry = dispositionTarget
    ? entries.find((entry) => entry.text.includes(`“${dispositionTarget.quote}”`)) ?? entries.find((entry) => !entry.window)
    : undefined;
  if (dispositionTarget && sharedQuoteEntry && !sharedQuoteEntry.window) {
    sharedQuoteEntry.window = dispositionTarget.window;
    sharedQuoteEntry.focus = dispositionTarget.conditions[0];
  }
  if (hasAbdominalPrioritySignal(semanticSourceText) && !hasAcuteAbdominalSignal(semanticSourceText)) {
    entries.push({ text: "突发、持续或进展性腹痛/胃痛需优先完成腹部查体与严重度评估" });
  }
  const breast = priorityEvaluationWindowTable.pathways.breast_mass;
  if (unevaluatedBreastMassText(semanticSourceText, authoritativePatientAgeYears(state), patientSexText(state)) &&
    !texts().some((item) => item.includes(breast.focus))) {
    entries.push({
      text: "乳房肿块尚未完成影像评估，宜先由乳腺专科尽快评估（需排除：乳腺癌）；处方前需完成评估",
      window: breast.window as PriorityEvaluationWindowId, pathway: "breast_mass", focus: breast.focus,
    });
  }
  const ketosis = priorityEvaluationWindowTable.pathways.hyperglycemic_ketosis;
  if (hyperglycemicKetosisSignal(semanticSourceText, diabetesRecordedInText(semanticSourceText, state)) &&
    !texts().some((item) => item.includes(ketosis.focus))) {
    entries.push({
      text: "高血糖伴酮体升高，已达糖尿病酮症酸中毒的血糖与酮体两项标准（ADA 2024），宜当天到医院急诊查血气与血酮（需排除：糖尿病酮症酸中毒）；处方前需完成评估",
      window: ketosis.window as PriorityEvaluationWindowId, pathway: "hyperglycemic_ketosis", focus: ketosis.focus,
    });
  }
  if (
    hasGiBleedPrioritySignal(semanticSourceText) &&
    !(state.clinicalFacts?.semanticStatus === "checked" &&
      groundedPatientTriageCategories(state.clinicalFacts, semanticSourceText).has("gi_bleed"))
  ) {
    // 与 narrativeFallbackAdvisories 同一套让位语义：语义层已有接地的 gi_bleed 结论时让位
    // （其条目自带原文引用与升级说明，信息量更高）；语义层缺席或单条漏检时本确定性项兜底，
    // needs_information 的承诺从此不押在模型可用性上。
    entries.push({ text: "消化道出血相关表现需优先复核出血量、持续性、循环状态及血红蛋白；处方前需完成评估" });
  }
  // 指南脓毒症高危数值项：当天评估（不升红旗，见 redflag-discriminators.source.json gatePolicy）。
  for (const item of discriminatorOutcomeForState(state).priority) {
    if (!entries.some((entry) => entry.text.includes(`需排除：${item.focus}`))) {
      entries.push({ text: item.text, window: "within_24h", focus: item.focus });
    }
  }
  return entries;
}

export function evaluateSafetyGate(state: CaseState): SafetyGate {
  const missingItems: string[] = [];
  const missingItemCodes: SafetyMissingItemCode[] = [];
  const addMissing = (code: SafetyMissingItemCode, label: string) => {
    missingItemCodes.push(code);
    missingItems.push(label);
  };
  const reasons: string[] = [];
  const vitalAdvisories = measuredVitalAdvisories(state);
  const semanticSourceText = trustedInputText(state);
  const semanticAdvisories = [
    ...semanticTriageAdvisoriesFromFacts(state.clinicalFacts, semanticSourceText),
    ...dispositionAdvisoriesFromFacts(state.clinicalFacts, semanticSourceText),
  ];
  const semanticEmergencyFindings = [
    ...additiveRedFlagsFromFacts(state.clinicalFacts, semanticSourceText, []),
    ...dispositionEmergencyRedFlagsFromFacts(state.clinicalFacts, semanticSourceText),
  ];
  const semanticEmergencyEvidence = structuredRedFlagEvidenceFromFacts(state.clinicalFacts, semanticSourceText);
  const priorityEvaluationItems = collectPriorityEvaluationEntries(state, semanticSourceText).map((entry) => entry.text);
  const semanticTriage = semanticEmergencyFindings.length > 0
    ? {
        level: "emergency_review" as const,
        findings: semanticEmergencyFindings,
        evidence: semanticEmergencyEvidence,
      }
    : priorityEvaluationItems.length > 0
      ? { level: "priority_review" as const, findings: priorityEvaluationItems }
      : undefined;
  const fallbackAdvisories = narrativeFallbackAdvisories(state);
  const discriminatorAdvisories = [...discriminatorOutcomeForState(state).advisories, ...discriminatorChecklistAdvisory(state)];
  const advisories = Array.from(new Set([...semanticAdvisories, ...fallbackAdvisories, ...vitalAdvisories, ...discriminatorAdvisories]));
  const text = structuredCaseText(state);
  const ageRaw = patientAgeText(state);
  const age = numberFromClinicalText(ageRaw);
  const ageWasEntered = isKnownClinicalText(ageRaw);
  const hasInvalidAge = ageWasEntered && age == null && hasInvalidAgeText(ageRaw);
  const hasAgeConflict = agesConflict(state.patient.age, state.hisRecord?.fields?.age);
  const structuredBloodPressure = structuredBloodPressureAssessment(state);
  const hasInvalidBp = hasInvalidBloodPressureOrder(vitalsText(state)) ||
    (structuredBloodPressure.status === "invalid" && structuredBloodPressure.reason === "order");

  if (!isKnownClinicalText(state.chiefComplaint || fieldText(state, "zhushu"))) addMissing("chief_complaint", "主诉");
  if (hasInvalidAge) addMissing("age_invalid", "年龄数值需复核（0-120岁）");
  if (hasAgeConflict || narrativePediatricAgeConflict(state) != null) addMissing("age_conflict", "年龄记录冲突需复核");
  const trustedText = trustedInputText(state);
  const sex = patientSexText(state);
  const allergyText = authoritativeFieldOrFallback(state, "guomin", state.allergyHistory) || extractAllergyEvidenceText(trustedText);
  const medicationText =
    authoritativeFieldOrFallback(state, "yongyaoshi", state.medicationHistory) ||
    extractMedicationEvidenceText(trustedText);
  const reproductiveScreenRequired = pregnancyScreenRequired(state);
  if (!patientSexAllowsDoseLevelSuggestion(sex)) addMissing("sex_unknown", `${clinicalRequiredFieldLabel("sex", "性别/生理状态")}（剂量建议前需明确生理风险分层）`);
  if (clinicalFieldRequiresExplicitPrescriptionState("allergy_history") && !isKnownClinicalText(allergyText)) addMissing("allergy_unknown", `${clinicalRequiredFieldLabel("allergy_history", "过敏史")}（明确有/无及过敏原/反应）`);
  else if (allergyHistoryNeedsClarification(allergyText)) addMissing("allergy_details", "已提及过敏史但缺少过敏原/反应");
  if (clinicalFieldRequiresExplicitPrescriptionState("medication_history") && !isKnownClinicalText(medicationText)) addMissing("medication_unknown", `${clinicalRequiredFieldLabel("medication_history", "当前用药")}（明确有/无及药物清单）`);
  // 写了药名、只缺剂量频次时不说「缺少药名」（2026-10-24 C045：病历写着二甲双胍，评审判复述不准）。
  else if (medicationHistoryNeedsClarification(medicationText)) {
    addMissing("medication_details", NAMED_MEDICATION.test(medicationText) ? "已提及当前用药但缺少剂量/频次" : "已提及当前用药但缺少药名/剂量/频次");
  }
  if (hasInvalidBp) addMissing("blood_pressure_invalid", "血压数值需复核（收缩压应高于舒张压）");
  const invalidVitalFindings = invalidEnteredVitalFindings(state).filter((finding) => !(finding.name === "血压" && hasInvalidBp));
  if (invalidVitalFindings.length > 0) {
    addMissing("vitals_invalid", `生命体征数值需复核（${invalidVitalFindings.map(formatInvalidVitalFinding).join("；")}）`);
  }
  const vitalSourceConflicts = Array.isArray(state.vitals?.sourceConflicts)
    ? state.vitals.sourceConflicts.map((item) => stringifyClinicalValue(item)).filter(Boolean)
    : [];
  if (vitalSourceConflicts.length > 0) {
    const conflictSummary = vitalSourceConflicts.join("；").slice(0, 600);
    addMissing("vitals_source_conflict", `生命体征来源记录冲突（${conflictSummary}）`);
    advisories.push(`生命体征存在来源冲突，请以本次实测值核对后更新：${conflictSummary}`);
  }
  const semanticUnavailable = semanticScreeningUnavailableItem(state);
  if (semanticUnavailable) addMissing("semantic_screen_unavailable", semanticUnavailable);
  if (priorityEvaluationItems.length > 0) {
    addMissing("priority_evaluation_required", `正式采纳前需优先完成临床评估（${priorityEvaluationItems.join("；")}）`);
  }
  const highRiskMissingVitals = missingVitalsForHighRiskPresentation(state);
  if (highRiskMissingVitals.length > 0) {
    addMissing("high_risk_missing_vitals", `高风险主诉需补充生命体征（${highRiskMissingVitals.join("、")}）`);
  }
  // 与充实度那一处共用同一谓词（此前这里是 `权威栏 || 图描述` 的字符串短路，
  // 舌象栏写「舌象待核实」时图描述救不了场，两处对同一份病历给出不同答案）。
  if (!hasObtainedTongueFinding(state)) addMissing("tongue_unknown", "舌象");
  if (!hasObtainedPulseFinding(state)) addMissing("pulse_unknown", "脉象");
  if (isPediatricPatient(state)) {
    if (!hasNumericPediatricWeight(text)) addMissing("pediatric_weight_unknown", "儿童体重数值");
    // 剂量按年龄分数法折算（pediatric-dose-rule）：只缺「年龄段」时才无法折算；体重是核对项，不参与折算。
    if (!pediatricDoseRuleForCase(state)) {
      addMissing("pediatric_age_unknown", "儿童年龄或月龄（用于年龄分数法折算剂量）");
    }
  }
  if (reproductiveScreenRequired) {
    const reproductiveLabel = clinicalRequiredFieldLabel("reproductive_status", "妊娠/哺乳/备孕状态");
    // 妊娠一项已经明确（阳性、可疑或否认）时，哺乳、备孕两项不再逐项追问（2026-10-24 甲方 100 例 C018「明确否认妊娠，近两周月经正常」
    // 仍列「哺乳」「备孕」、C062 尿妊娠试验阳性的异位妊娠仍列「备孕」，评审判为过度追问）：妊娠阳性或可疑本身已是不给剂量的边界，
    // 备孕无从谈起；否认妊娠时备孕只影响药典孕妇慎用药的逐味标注，哺乳只在病历提到近一年内分娩时才需要问。
    const pregnancyKnown = hasExplicitPregnancyStatus(maternalStateText(state, text));
    const pregnancyNegative = pregnancyKnown && !isPositiveOrPossibleClinicalState(assessPregnancyState(maternalStateText(state, text)));
    if (!pregnancyKnown) addMissing("pregnancy_unknown", `${reproductiveLabel}（妊娠）`);
    if (!hasExplicitLactationStatus(text) && (!pregnancyKnown || (pregnancyNegative && recentChildbirthMentioned(text)))) {
      addMissing("lactation_unknown", `${reproductiveLabel}（哺乳）`);
    }
    if (!hasExplicitConceptionStatus(text) && !pregnancyKnown) addMissing("conception_unknown", `${reproductiveLabel}（备孕）`);
  }
  if (mentalHealthSafetyScreenRequired(trustedText) &&
      !hasExplicitMentalHealthSafetyScreen(trustedText) &&
      !hasCurrentMentalHealthCrisis(trustedText)) {
    addMissing("behavioral_crisis_screening", "情志危机需补充当前自杀/自伤/他伤安全筛查");
  }
  if (insomniaPresentation(trustedText) && !hasExplicitOsaScreen(trustedText)) {
    addMissing("osa_screening", "失眠需补充OSA风险筛查（打鼾/呼吸暂停/日间嗜睡/高血压）");
  }
  if (thyroidScreenRequired(trustedText) && !hasCurrentThyroidAssessment(trustedText)) {
    addMissing("thyroid_screening", "相关症状需补充甲状腺功能线索或近期甲功");
  }

  // Hard-stop red flags must be traceable to the current authoritative record. Model report text is
  // intentionally excluded here: a previous limited template or an ungrounded M01 extraction must not
  // feed itself back into the next safety evaluation and permanently lock the case.
  const programmaticRedFlags = detectProgrammaticRedFlags(state);
  // 语义回补层的急症发现（positive + emergency，经病历原文接地与复核）必须参与门禁状态判定，
  // 而不是只进 semanticTriage 展示字段——否则出现「载荷里写着 emergency_review、顶层门禁
  // 却是 needs_information、红旗为空」的状态分裂（实测产后重度高血压案）。additive 层的
  // 纪律不变：只增不减，确定性阳性红旗与危急体征永远不会被它取消；类目级去重由
  // additiveRedFlagsFromFacts(existingRedFlags) 自己完成。仅在语义结果已过独立复核
  //（reviewStatus=checked）时参与升级，未复核的语义结果保持展示级。
  // 2026-09-20 起复核相位按配置关闭，接地后的单次抽取（single_pass）同为完成态，照常参与升级。
  const reviewedSemanticEmergencyFindings = clinicalFactsReviewSettled(state.clinicalFacts?.reviewStatus)
    ? [
        ...additiveRedFlagsFromFacts(state.clinicalFacts, semanticSourceText, programmaticRedFlags),
        ...dispositionEmergencyRedFlagsFromFacts(state.clinicalFacts, semanticSourceText),
      ]
    : [];
  const discriminatorRedFlags = discriminatorOutcomeForState(state).redFlags;
  const redFlags = [
    ...programmaticRedFlags.map((flag) => withReaderDisagreementNote(state, flag)),
    ...reviewedSemanticEmergencyFindings,
    ...discriminatorRedFlags,
  ];
  const ownEmergencyName = redFlags.length === 0 ? ownEmergencyDiagnosisName(state) : undefined;
  if (ownEmergencyName) {
    redFlags.push(`本次辨病的西医诊断为急危重病「${ownEmergencyName}」，需先完成急诊或专科评估，再评估中药处方`);
  }
  if (redFlags.length > 0) {
    const redFlagFindings = programmaticRedFlagFindings(state, redFlags);
    const activeGate = { redFlags, redFlagFindings };
    if (hasCurrentEmergencyClearance(state, activeGate)) {
      const clearanceNotice = `已记录医生现场急症排查结果：${state.emergencyClearance?.assessmentSummary}`;
      return {
        status: missingItems.length > 0 ? "needs_information" : "ready",
        allowDiagnosis: true,
        allowDosePrescription: missingItems.length === 0,
        action: missingItems.length > 0 ? "complete_before_prescription" : "proceed",
        missingItems,
        missingItemCodes,
        redFlags: [],
        redFlagFindings: [],
        advisories: Array.from(new Set([clearanceNotice, ...advisories])),
        reasons: [clearanceNotice, "原急危重风险线索保留在病例留痕中；当前常规诊疗仅基于医生已完成的现场排查继续。"],
      };
    }
    return {
      status: "red_flag",
      // 急性红旗不终止 Agent 会话：允许 M03 继续生成风险分析、鉴别与转诊闭环；
      // 但剂量级 M04 与正式采纳保持硬边界。
      allowDiagnosis: true,
      allowDosePrescription: false,
      action: "refer_or_emergency",
      missingItems,
      missingItemCodes,
      redFlags,
      redFlagFindings,
      advisories,
      semanticTriage,
      // 措辞必须带明确的紧迫性副词：这句是红旗病例**首屏第一眼**看到的处置指令。
      // 50 例基层回归实测（RF02 胸痛）：原文「需先完成急诊或转诊评估」有动作、无时限，
      // 与「立即/尽快」这类紧迫性表述隔了一层——红旗首屏不该让医生自己去推断有多急。
      reasons: ["当前资料提示急危重症风险，请立即完成急诊或转诊评估，不得因继续辨证而延误。"],
    };
  }

  const diagnosisBlockingMissing = missingItems.filter((item) => item === "主诉");

  // 没有主诉就没有可分析的临床目标。其余缺口先进入追问，但不再阻断医生显式选择的
  // 有限分析；最终候选会携带安全锁，正式采纳仍需补齐。
  if (diagnosisBlockingMissing.length > 0) {
    reasons.push(...vitalAdvisories);
    reasons.push(`缺少临床分析入口（${diagnosisBlockingMissing.join("、")}），请先补充后再进行辨证。`);
    return {
      status: "needs_information",
      allowDiagnosis: false,
      allowDosePrescription: false,
      action: "complete_before_prescription",
      missingItems,
      missingItemCodes,
      redFlags: [],
      advisories,
      semanticTriage,
      reasons,
    };
  }

  // 有主诉即可在追问后继续 M03。舌脉、常规筛查和处方级安全槽位不足时，默认先追问；
  // 医生显式继续可查看安全锁定候选，儿科/急性高危/明确孕哺等硬边界仍不能绕过。
  // An explicit positive pregnancy/lactation/conception statement is itself sufficient to lock the
  // dose path, even if a stale or contradictory demographic field says male/outside childbearing age.
  const pregnancyPositive = hasPositivePregnancyOrLactationRisk(maternalStateText(state, text));
  if (missingItems.length > 0 || pregnancyPositive) {
    const prescriptionMissing = pregnancyPositive
      ? [...missingItems, "特殊人群用药复核（妊娠/哺乳/备孕阳性）"]
      : missingItems;
    reasons.push(...vitalAdvisories, `辨证信息已具备；剂量级候选处方前需补齐或复核：${prescriptionMissing.join("、")}。`);
    return {
      status: "needs_information",
      allowDiagnosis: true,
      allowDosePrescription: false,
      action: "complete_before_prescription",
      missingItems: prescriptionMissing,
      missingItemCodes,
      redFlags: [],
      advisories,
      semanticTriage,
      reasons,
    };
  }

  return {
    status: "ready",
    allowDiagnosis: true,
    allowDosePrescription: true,
    action: "proceed",
    missingItems: [],
    missingItemCodes: [],
    redFlags: [],
    advisories,
    semanticTriage,
    reasons: [...vitalAdvisories, "主诉、舌脉和核心辨证信息已具备，可进入辅助推理。"],
  };
}

export function withSafetyGate(state: CaseState): CaseState {
  const operationalCompleteness = deriveOperationalCompleteness(state);
  // Completeness is a live property of the current record. Never keep a historical/model high score
  // after the clinician clears a field or changes it to "待核实"; doing so lets stale confidence unlock
  // M03/M04. Model analysis remains visible in its report, while the workflow gate is recomputed solely
  // from the current authoritative record on every transition and restore.
  const next = {
    ...state,
    completeness: operationalCompleteness,
  };
  const gate = evaluateSafetyGate(next);
  // 把剂量呈现模式随门禁一起下发：derivePrescriptionPermission 是唯一权威口径，
  // 此前只在 HIS 出口消费，接口消费者只见 allowDosePrescription 布尔而误读为"不得出现剂量"。
  const permission = derivePrescriptionPermission({ ...next, safetyGate: gate });
  return { ...next, safetyGate: { ...gate, candidateMode: permission.candidateMode } };
}

export function reconcileRestoredCaseState(state: CaseState): CaseState {
  const recomputed = withSafetyGate(state);
  if (recomputed.safetyGate?.allowDiagnosis === false) {
    // 恢复快照不清空已生成的结论。旧行为把红旗病例刷新一次就打回 question 阶段并
    // 删除全部 M03/M04/M05 结果——服务端明明是带警示完整生成的，前端一次刷新等于把医生的
    // 工作成果销毁。改为保留内容 + safetyLocked 警示锁（呈现层置顶警示、采纳须医生确认）。
    return { ...recomputed, safetyLocked: true, lastError: state.lastError };
  }
  if (recomputed.safetyGate?.allowDosePrescription === false) {
    return {
      ...recomputed,
      // Preserve the last generated result for clinical review, but relock it under the current
      // safety rules. A refresh or rule upgrade must not silently delete work or upgrade it to an
      // adoptable prescription.
      safetyLocked: true,
      // A failed M03/M04/M05 must remain retryable after refresh. Clearing lastError here used to
      // convert a real stage failure into a dead "待生成" report with no recovery action.
      lastError: state.lastError,
    };
  }
  // A previously limited/truncated/unverified result does not become adoptable merely because a
  // later restore happens to see a ready gate. Only a fresh successful generation/audit may clear
  // that provenance lock.
  return { ...recomputed, safetyLocked: state.safetyLocked === true };
}

export function deriveSafetyLocked(
  state: CaseState,
  opts: {
    truncated?: boolean;
    placeholderSource?: boolean;
    contentMismatch?: boolean;
    hardSafetyLock?: boolean;
  } = {},
): boolean {
  const gate = state.safetyGate || evaluateSafetyGate(state);
  const permission = derivePrescriptionPermission({ ...state, safetyGate: gate });
  return Boolean(
    !gate.allowDiagnosis ||
    permission.formalAdoption === "blocked" ||
    opts.truncated ||
    opts.placeholderSource ||
    opts.contentMismatch ||
    opts.hardSafetyLock,
  );
}

export function buildSafetyLimitedDiagnosis(state: CaseState, gate: SafetyGate): string {
  const analysisIncomplete = gate.missingItems.some((item) => /辨病辨证结果完整性/.test(item));
  const status = gate.status === "red_flag"
    ? "需优先处置的高风险提示"
    : analysisIncomplete
      ? "本次未形成可复核的完整辨病辨证结果"
      : "现有信息下的有限建议";
  const redFlagRows = gate.redFlags.length > 0
    ? gate.redFlags.map((item) => `| 急危重红旗 | 高风险 | ${item} | 先急诊/转诊或完成专科排查；补充评估结果后可重新推理 |`)
    : ["| 急危重红旗 | 尚需结合现场评估 | 当前病历未识别明确急危重线索；仍需结合病情核实关键安全信息 | 补充必要信息后重新评估 |"];
  const missingRows = gate.missingItems.length > 0
    ? gate.missingItems.map((item) => `| ${item} | 影响红旗排查/辨证或处方安全 | ${analysisIncomplete ? "重新运行辨病辨证分析；如仍未形成完整结果，由医生结合现有病历人工判断" : "补充会直接改变判断的病历信息后重新评估"} |`)
    : ["| 无确定缺失项 | 仍需医生现场查体、生命体征和必要检查复核 | 如病情变化，补充后重新提交 |"];
  const limitedStateCopy = buildThreePartLimitedStateCopyForSurface(
    gate.status === "red_flag" ? "red_flag_escalation" : "limited_clinical_scheme",
    {
      knownFacts: gate.redFlags.length > 0
        ? `已识别需优先处置的风险线索：${gate.redFlags.join("；")}`
        : "已记录本次主诉并完成当前病历的风险筛查",
      unavailableConclusion: "可直接采纳的完整辨病辨证及具体用药方案",
      reason: gate.reasons.join("；") || "现有资料尚不能支持该结论",
      nextAction: gate.status === "red_flag"
        ? "立即按急诊或转诊流程处置；完成现场评估后再重新推理"
        : analysisIncomplete
          ? "重新运行辨病辨证分析；如仍未形成完整结果，由医生结合现有病历判断"
          : "补充会改变诊断、辨证或用药安全判断的必要信息后重新评估",
    },
  );
  return sanitizeAuthoritativeClinicalOutput([
    "## 本次分析结论",
    limitedStateCopy,
    "",
    `**结论**：${status}`,
    `**理由**：${gate.reasons.join("；")}`,
    `**缺失信息**：${gate.missingItems.length > 0 ? gate.missingItems.join("、") : "无"}`,
    `**处理建议**：${gate.status === "red_flag" ? "立即停止常规诊疗并转急诊；危及生命时呼叫120。先完成急诊/转诊评估；若医生已排除急症，可补充现场评估结果后重新推理。" : analysisIncomplete ? "重新运行辨病辨证分析；如仍未形成完整结果，保留已录入病历并由医生人工判断，本结果不进入剂量级候选。" : "请补充会影响诊断、辨证或用药安全的必要信息后重新评估。"}`,
    "",
    "## 红旗排查",
    "| 风险类别 | 风险评估 | 患者依据 | 下一步 |",
    "|---------|---------|---------|-------|",
    ...redFlagRows,
    "",
    "## 信息充分度",
    "| 补录项 | 影响环节 | 建议动作 |",
    "|-------|---------|---------|",
    ...missingRows,
    "",
    "## 西医诊断",
    "| 项目 | 内容 |",
    "|------|------|",
    `| 西医诊断 | ${gate.status === "red_flag" ? "急危重症风险线索待排除，需优先转诊或急诊评估" : analysisIncomplete ? "本次未形成可复核的西医工作诊断" : "现有资料尚不足以支持西医诊断倾向"} |`,
    `| 支持证据 | ${gate.redFlags.join("；") || gate.reasons.join("；")} |`,
    "| 建议检查 | 由医生结合主诉和现场情况补充生命体征、必要检验检查及专科评估 |",
    "| 证据依据 | 当前病历、已测生命体征与急危重风险筛查；具体诊断仍需结合现场查体和院内规范 |",
    "",
    "## 中医证候诊断",
    "**证候诊断**：尚未形成可复核的证候结论",
    "**证候-病机联系**：当前信息尚不能形成可复核的证候—病机链。可补充与本病有关的四诊信息；性别/生理状态、过敏史、当前用药及儿童、妊娠哺乳等特殊人群信息须在采用具体用量候选前核实。",
    "**证据支持**：当前资料不足以形成可采纳的证候-病机链路。",
    "**证据依据**：当前病历与风险筛查结果；具体医学判断须结合院内规范、指南/文献/说明书及医生现场评估。",
    "",
    "## 证候分布与病机映射",
    "| 候选证候 | 主/兼 | 关联病机 | 治法方向 | 支持证据 | 反证/冲突点 | 下一步 |",
    "|---------|------|---------|---------|---------|------------|-------|",
    "| 尚未形成可复核的证候结论 | - | 当前尚未形成稳定病机链 | 现有资料不支持进入候选方药 | 缺少会改变辨证或用药的必要信息，或需先排除急症 | 无法形成闭环证据链 | 补充后重新推理 |",
    "",
    "## 总体病机",
    "**病位**：暂不判断",
    "**病性**：暂不判断",
    "**核心病机**：尚未形成可复核结论；需补充必要四诊信息或先完成急症排查后再判断。",
    "**病机依据**：当前输出只用于补录与安全提示，不作为处方级辨证依据。",
    "",
    "## 治法框架",
    "**总治法**：尚未形成可复核结论",
    "**子治法组合**：待红旗排查与四诊信息补齐后生成。",
    "",
    "## 证据链",
    "| 结论 | 支持证据 | 反证/限制 | 缺失信息 | 来源依据 | 下一步 |",
    "|------|---------|-----------|---------|---------|-------|",
    `| ${status} | ${gate.redFlags.join("；") || gate.reasons.join("；")} | 不形成正式诊断或处方 | ${gate.missingItems.join("、") || "医生现场评估结果"} | 当前病历与风险筛查 | 补充后重新评估 |`,
  ].join("\n"));
}

/**
 * 有限 M03 兜底页的**可见理由必须说出真实原因**（2026-09-13，222 例实测第二类 7 例）。
 *
 * 此前非红旗分支无条件写「本次分析尚未形成通过临床复核的稳定证候结果」，把结构化交付/解析
 * 问题说成复核问题，会让医生以为是临床证据不够而去补录，也让归因跑偏（与 2026-08-04
 * 「上游 503 被写成证候依据不足」是同一类混淆）。
 *
 * 这里按 attestation 的 unavailableReason 逐支给出各自的理由、限制与下一步动作。
 * 模型复核环节已于 2026-09-16 移除：可见理由里不再提「独立临床复核」（owner 2026-09-25）；
 * 只由已删除的复核执行产生的码（accepted_but_draft_rejected_downstream / invalid_contract /
 * http_error / transport_error / not_configured）不再有专属文案。
 *
 * 缺省分支在生产路径上已不可达（diagnose 路由三处兜底页都显式传码，拦截档 2026-09-25 删除），
 * 但保留为防御性兜底——旧文案里的「通过临床复核」指向一个不存在的环节，故 2026-09-25 一并改写。
 * 存量浏览器状态里可能仍留着旧串，客户端的 M03 级重跑正则因此继续匹配旧文案（多匹配一条只会
 * 让它从 M03 重跑，方向安全）。
 */
export function limitedDiagnosisReasonCopy(
  reviewUnavailableReason?: ClinicalReviewAttestation["unavailableReason"],
): { reason: string; limitation: string; nextAction: string } {
  switch (reviewUnavailableReason) {
    case "not_attempted_no_valid_draft":
      return {
        reason: "本次辨病辨证结果不完整，未能形成可用的证候结论",
        limitation: "本次未形成完整的辨病辨证结果",
        nextAction: "重新运行辨病辨证分析；已录入病历无需修改",
      };
    case "not_attempted_upstream_down":
      return {
        reason: "模型推理服务暂时不可用，本轮未能完成辨病辨证",
        limitation: "本次为上游服务故障，不是病历信息不足",
        nextAction: "稍后重新运行辨病辨证分析；已录入病历无需修改",
      };
    case "deadline":
      return {
        reason: "本次辨病辨证未在本阶段安全时限内完成",
        limitation: "本次受时限约束提前收口",
        nextAction: "重新运行辨病辨证分析；如反复超时请联系系统管理员",
      };
    default:
      return {
        reason: "本次分析尚未形成稳定的证候结果",
        limitation: "本次分析尚未形成可信的完整诊断结果",
        nextAction: "重新运行辨病辨证分析",
      };
  }
}

/** 急症有限 M03 的西医占位名。构造（下方）与识别（isEmergencyLimitedDiagnosis）共用这一个常量。 */
const LIMITED_M03_EMERGENCY_WESTERN_NAME = "急危重症风险待排除";

/**
 * 这份（已签名的）有限 M03 是否是**因红旗**收口的急症变体。只认本文件构造器写下的占位名常量，
 * 不对自由文本做正则（prescribe 路由此前对「急危重|急症」「呼叫120|转急诊」做正则反推）。
 * 签名 M03 记下的红旗属于只可追加、不可降级的事实：M04 时刻的安全门若因语义事实过期、未随请求
 * 带回等原因不再是 red_flag，也不得把这份急症有限结果降成普通「待补充信息」页。
 */
export function isEmergencyLimitedDiagnosis(reasoning: ClinicalReasoningResultV2 | undefined): boolean {
  return reasoning?.stage === "diagnose" &&
    reasoning.overview.primarySyndromeResolution === "unresolved" &&
    reasoning.pathogenesis.chain.length === 0 &&
    reasoning.westernDiagnosis.primary.name === LIMITED_M03_EMERGENCY_WESTERN_NAME;
}

/**
 * 有限结果沿用并行西医半（2026-10-19）。中医半修复耗尽（病机链接地失败、截断）时，西医半是独立生成、已核对过病名的结论；
 * 验收集 D 里 4 例因占位名不合格，其中 3 例西医半写的是对的（急性白血病、输血后丙型肝炎、人工流产后宫腔粘连待查——
 * 附在有限页的未签名草稿里）。只取名称、状态、把握度、推理、鉴别与候选，逐项限长；名称不干净（并列、推测语气、带证候）时不采用。
 * 支持事实不沿用：它们要经接地校验，有限结果不跑那一步。只用于非红旗有限结果；红旗有限结果的占位名是急症识别的常量。
 */
function carriedWesternDiagnosis(content: string | undefined): ClinicalReasoningResultV2["westernDiagnosis"] | undefined {
  if (!content) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return undefined; }
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const text = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const western = object(object(parsed)?.westernDiagnosis);
  const primary = object(western?.primary);
  const name = text(primary?.name, 80).replace(/[（(][^（）()]{0,60}[）)]/g, "").trim();
  if (name.length < 2 || name.length > 40 || /[\/、？?]|或|可能|疑似|待排|证$/.test(name)) return undefined;
  const status = primary?.status === "考虑" || primary?.status === "需排除" || primary?.status === "证据有限" ? primary.status : "证据有限";
  const confidence = primary?.confidence === "高" || primary?.confidence === "中" || primary?.confidence === "低" ? primary.confidence : "低";
  const differentials = (Array.isArray(western?.differentials) ? western.differentials : []).flatMap((raw) => {
    const item = object(raw);
    const itemName = text(item?.name, 80);
    if (itemName.length < 2) return [];
    return [{
      name: itemName,
      reason: text(item?.reason, 120) || "需鉴别",
      distinguishingPoints: text(item?.distinguishingPoints, 200) || undefined,
      nextCheck: text(item?.nextCheck, 120) || undefined,
    }];
  }).slice(0, 8);
  const candidates = (Array.isArray(western?.candidates) ? western.candidates : []).flatMap((raw) => {
    const item = object(raw);
    const itemName = text(item?.name, 80).replace(/[（(][^（）()]{0,60}[）)]/g, "").trim();
    if (itemName.length < 2) return [];
    const list = (value: unknown) => (Array.isArray(value) ? value : []).map((entry) => text(entry, 200)).filter(Boolean).slice(0, 3);
    const likelihood = item?.likelihood === "高" || item?.likelihood === "中" || item?.likelihood === "低" ? item.likelihood : "中";
    return [{ name: itemName, likelihood, keyEvidence: list(item?.keyEvidence), againstEvidence: list(item?.againstEvidence) }];
  }).slice(0, 3);
  // 候选首项与主诊断同名（合同口径）：首项不是主诊断时把主诊断补在最前。
  const leadCandidates = candidates.length > 0 && candidates[0].name !== name
    ? [{ name, likelihood: "中" as const, keyEvidence: [], againstEvidence: [] }, ...candidates.filter((item) => item.name !== name)].slice(0, 3)
    : candidates;
  return {
    primary: {
      name,
      status,
      confidence,
      supportingFacts: [],
      clinicalRationale: text(primary?.clinicalRationale, 400) || undefined,
      limitations: ["本次中医辨证未完成，西医诊断为独立生成的工作诊断，请医生结合病历核实"],
      suggestedChecks: [],
      evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "低" },
    },
    differentials,
    candidates: leadCandidates,
  } as ClinicalReasoningResultV2["westernDiagnosis"];
}

/**
 * A hard red flag or an exhausted M03 repair must close as an explicit, signed limited contract,
 * not as a half-JSON stream. This contract intentionally leaves TCM syndrome/pathogenesis
 * unresolved: it authorizes only the next non-dose safety step and cannot become a dose-level M04.
 */
export function buildSafetyLimitedDiagnosisReasoning(
  state: CaseState,
  gate: SafetyGate,
  /**
   * 复核为何不可用。**这条路径此前根本不写 clinicalReview**，由签名层补一个裸的
   * `{status:"unavailable"}`，于是原因码在「复核确实不可用」的那条路上恰好缺席——
   * 194 例实测 18 例 unavailable 里有 4 例走这里，而那 4 例正是完全 unresolved 的最坏情形。
   *
   * 同一个区分在本仓已经做过一半：diagnose 路由 2026-08-04 把「上游服务故障」与
   * 「临床证据不足」在**医生可见文案**上拆开了（上游 503 期间 10 例有 9 例被写成
   * 「证候依据不足」，医生以为病历不够去补录）。拆的是 presentation 层，
   * attestation 层两者仍旧都写 unavailable——这里补上。
   */
  reviewUnavailableReason?: ClinicalReviewAttestation["unavailableReason"],
  /**
   * 并行生成的西医半（已过病名核对与闭集重选）。中医半修复耗尽、落到有限结果时，非红旗有限结果用它作西医诊断，
   * 不再用占位名「症状性问题，病因待临床鉴别」顶掉一份完整的西医结论（2026-10-19，见 carriedWesternDiagnosis）。
   */
  carried?: { westernHalfContent?: string },
): ClinicalReasoningResultV2 {
  const redFlag = gate.status === "red_flag";
  const limitedCopy = limitedDiagnosisReasonCopy(reviewUnavailableReason);
  const carriedWestern = redFlag ? undefined : carriedWesternDiagnosis(carried?.westernHalfContent);
  const evidence = {
    evidenceLevel: "deterministic_rule" as const,
    source: redFlag ? "急危重风险筛查" : "现有信息下的有限诊断结果",
    confidence: redFlag ? "高" as const : "低" as const,
  };
  const supportingFacts = redFlag
    ? gate.redFlags.slice(0, 8)
    : [state.chiefComplaint || state.hisRecord?.fields?.zhushu || "当前主诉已记录"].filter(Boolean).slice(0, 8);
  const uncertaintyItems = (gate.missingItems.length > 0
    ? gate.missingItems
    : [redFlag ? "急症现场评估结果" : "稳定的证候与病机链"])
    .slice(0, 12)
    .map((item) => ({
      item,
      reason: redFlag ? "当前应优先完成急诊或专科评估" : "当前资料或模型结果不足以形成稳定结论",
      affects: "中医证候、病机与剂量级候选方药",
    }));

  return {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    completeness: state.completeness,
    ...(reviewUnavailableReason
      ? { clinicalReview: { status: "unavailable" as const, unavailableReason: reviewUnavailableReason } }
      : {}),
    overview: {
      // 有限诊断的结构化出口与 A/B 级、红旗去具体度决策表使用同一个
      // 服务端标签。fallback 是在签名前预渲染的权威结果，不能依赖签名后的
      // 可见投影再来清空证候或方剂方向。
      primarySyndrome: "症状级工作判断",
      primarySyndromeResolution: "unresolved",
      primarySyndromeBasis: [],
      primarySyndromeResolutionReason: redFlag
        ? "当前急危重症风险应优先处置，不应因继续辨证而延误急诊评估"
        : limitedCopy.reason,
      secondarySyndromes: [],
      overallPathogenesis: "当前不形成可采纳的中医病机链",
      // 治法栏只写临床状态，不写操作指引（2026-09-29 甲方测评 1.2：HIS 按字段展示，医生在「治法」栏
      // 读到「重新运行辨病辨证分析；已录入病历无需修改」）。下一步操作仍在 management.followupSafetyNet
      // 与 primarySyndromeResolutionReason 里。
      overallTherapy: redFlag ? "立即急诊或专科评估，不进入中药处方" : "辨病辨证尚未完成，暂不确定治法",
      recommendedFormulaDirection: "",
      recommendedFormulaNames: [],
      formulaSelectionMode: "none",
      evidence,
    },
    westernDiagnosis: carriedWestern ?? {
      primary: {
        name: redFlag ? LIMITED_M03_EMERGENCY_WESTERN_NAME : "症状性问题，病因待临床鉴别",
        status: redFlag ? "需排除" : "证据有限",
        confidence: redFlag ? "高" : "低",
        supportingFacts,
        limitations: [redFlag
          ? "本路径只确认急诊处置优先级，不替代现场诊断"
          : limitedCopy.limitation],
        suggestedChecks: [redFlag ? "立即按急诊或对应专科流程评估" : "由医生补充鉴别所需问诊、查体和检查"],
        evidence,
      },
      differentials: [],
    },
    pathogenesis: {
      summary: "中医病机尚未稳定，本次不做推断。",
      locationDifferentiation: {
        items: [], details: [], resolution: "unresolved", resolutionReason: "未形成可复核的病位证据", evidence,
      },
      natureDifferentiation: {
        items: [], rootDeficiency: [], branchExcess: [], basis: "", resolution: "unresolved", resolutionReason: "未形成可复核的病性证据", evidence,
      },
      symptomClusters: [],
      chain: [],
      uncertainties: uncertaintyItems,
    },
    therapy: {
      overallPrinciple: redFlag ? "急诊处置优先，不锁定中医治法" : "暂不锁定剂量级治法",
      subTherapies: [],
    },
    formula: null,
    nonPharma: null,
    lineageAdaptation: null,
    management: {
      redFlagLoop: redFlag ? "立即停止常规诊疗并转急诊；危及生命时呼叫120" : "病情加重或出现新的急危重线索时立即升级处置",
      mustCollect: gate.missingItems.slice(0, 12),
      followupSafetyNet: "完成现场评估或补录后，重新运行辨病辨证分析",
    },
  };
}

function uniqueNonEmpty(items: ReadonlyArray<string | undefined>): string[] {
  return Array.from(new Set(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item))));
}

/**
 * 为签名有限 M03 结果构造权威安全门。
 *
 * 合同耗尽、编排超时、上游不可用等 fallback 都会附加自己的原因和补录项，
 * 但它们不得把当前病例已由确定性规则识别的红旗覆盖为 needs_information。
 * 红旗属于只可追加、不可降级的权威事实；同时有限结果本身不授权继续诊断
 * 或进入剂量级 M04。
 */
export function safetyGateForLimitedDiagnosisFallback(
  authoritativeGate: SafetyGate,
  fallbackGate: SafetyGate,
): SafetyGate {
  if (authoritativeGate.status !== "red_flag") return fallbackGate;

  const missingItemCodes = Array.from(new Set([
    ...(fallbackGate.missingItemCodes || []),
    ...(authoritativeGate.missingItemCodes || []),
  ]));
  const advisories = uniqueNonEmpty([
    ...(authoritativeGate.advisories || []),
    ...(fallbackGate.advisories || []),
  ]);

  return {
    ...fallbackGate,
    status: "red_flag",
    allowDiagnosis: false,
    allowDosePrescription: false,
    action: "refer_or_emergency",
    missingItems: uniqueNonEmpty([
      ...fallbackGate.missingItems,
      ...authoritativeGate.missingItems,
    ]),
    ...(missingItemCodes.length > 0 ? { missingItemCodes } : {}),
    redFlags: [...authoritativeGate.redFlags],
    ...(authoritativeGate.redFlagFindings
      ? { redFlagFindings: authoritativeGate.redFlagFindings.map((finding) => ({ ...finding })) }
      : {}),
    ...(advisories.length > 0 ? { advisories } : {}),
    ...(authoritativeGate.semanticTriage
      ? { semanticTriage: structuredClone(authoritativeGate.semanticTriage) }
      : {}),
    reasons: uniqueNonEmpty([
      ...authoritativeGate.reasons,
      ...fallbackGate.reasons,
    ]),
  };
}

export function renderSafetyLimitedDiagnosisContract(
  state: CaseState,
  gate: SafetyGate,
  signedReasoning: ClinicalReasoningResultV2,
): string {
  return [
    buildSafetyLimitedDiagnosis(state, gate),
    "",
    "## 本节生成状态",
    gate.status === "red_flag"
      ? "当前仅形成急症限定结果；本结果只用于急诊分流和暂停剂量级候选处方，不代表已经完成中医辨证。"
      : "本次资料尚不足以形成完整诊断；当前仅显示有限临床建议，不生成剂量级候选处方，可补充资料后重新评估。",
    "",
    "<!-- DIAGNOSIS_JSON_START -->",
    JSON.stringify(signedReasoning, null, 2),
    "<!-- DIAGNOSIS_JSON_END -->",
  ].join("\n");
}

// 展示层与 HIS 层判定“本轮是安全降级的非剂量结果”的唯一依据，必须与本文件实际输出的正文同源。
// 历史故障 b04fe65 只改了正文措辞（“不展示剂量级候选方药”→“不展示包含具体用量的候选方药”），
// 三处判定仍在匹配旧措辞，于是每一次安全降级都被误判为“候选方药本次未完整生成”的生成失败，
// 服务端写好的降级原因与下一步动作被整段丢弃。新增或改写降级正文时必须同步本列表。
/** 非剂量处方页的机器可读标记。服务端渲染时写入，医生不可见，不随文案措辞漂移。 */
export const NON_DOSE_PRESCRIPTION_MARKER = "<!-- CDSS_NON_DOSE_PRESCRIPTION -->";

const NON_DOSE_PRESCRIPTION_DECLARATIONS = [
  "当前不展示包含具体用量的候选方药",
  // 历史措辞：已保存/已恢复的旧病例仍可能携带，判定必须继续认得。
  "不展示剂量级候选方药",
  "不生成中药饮片剂量",
  "当前未满足剂量级候选处方",
] as const;

/**
 * 机器可读标记优先于文案匹配。
 *
 * 这两者本该是同一件事的两种表达，实际却各写各的：非剂量页由服务端渲染时会嵌入
 * `<!-- CDSS_NON_DOSE_PRESCRIPTION -->` 标记，而本判据只认上面那张**手写文案清单**。
 * m04-deterministic-fallback 的确定性兜底页（M03 已锁定方剂基准组成 + 逐味药典剂量区间 +
 * 特殊人群提醒）带了标记、也写了自己的声明句「上表剂量区间为药典边界而非本例建议量」，
 * 但那句从未登记进清单，于是判据返回 false —— 客户端 `expectedNonDoseLimitedPrescription`
 * 随之为 false，整页被当成合同不完整丢弃，替换成「本次未形成可核验的完整药味与剂量」并报错。
 * **该功能的立项理由就是消灭空白页，结果它自己产出的页在生产上从未出厂过。**
 * 而「重新生成」按钮打的是同一条确定性路由，必然再败。
 *
 * 因此判据改为标记优先：标记由服务端渲染时写入、医生不可见、不随文案措辞漂移，
 * 是比中文句子更可靠的事实来源。文案清单保留，用于兼容不带标记的历史快照。
 * 客户端另有一道「正文不得出现具体克数」的独立校验，标记优先不会绕过它。
 */
export function isNonDosePrescriptionText(text: string | undefined): boolean {
  if (!text) return false;
  if (text.includes(NON_DOSE_PRESCRIPTION_MARKER)) return true;
  return NON_DOSE_PRESCRIPTION_DECLARATIONS.some((declaration) => text.includes(declaration));
}

export function buildSafetyLimitedPrescription(gate: SafetyGate, reasonCode?: CdssDegradeReasonCode): string {
  const limitedStateCopy = buildThreePartLimitedStateCopyForSurface("non_dose_treatment_direction", {
    knownFacts: gate.redFlags.length > 0
      ? `已识别需优先处置的风险线索：${gate.redFlags.join("；")}`
      : "已完成当前可用病历和处方前风险边界核查",
    unavailableConclusion: "包含具体用量的候选处方",
    reason: gate.reasons.join("；") || "尚有处方安全信息需要核实",
    nextAction: gate.status === "red_flag"
      ? "立即按急诊或转诊流程处置，完成现场评估后再考虑用药"
      : "核实所列信息并完成院内审方后，再决定是否采用具体用量",
  });
  return sanitizeAuthoritativeClinicalOutput([
    NON_DOSE_PRESCRIPTION_MARKER,
    ...(reasonCode ? [cdssReasonCodeMarker(reasonCode)] : []),
    "## 当前结论",
    limitedStateCopy,
    "",
    "## 处方前必要信息核查",
    `**医生开方前需确认**：${[...gate.missingItems, ...gate.redFlags].join("；") || "需完成医生复核"}`,
    "**处方安全边界**：当前尚不具备形成包含具体用量候选处方的必要条件，因此不提供中药饮片剂量、剂数、煎服法或西药/中成药用法用量。",
    "",
    "## 中药饮片处方",
    `${NON_DOSE_PRESCRIPTION_DECLARATIONS[0]}。请先完成急诊/转诊评估，或补充会直接影响用药安全的信息后重新分析。`,
    "",
    "## 西药/中成药方案",
    "现有资料尚不足以形成可核验的西药或中成药候选。",
    "",
    "## 用药风险提示",
    `- **提示强度**：${gate.status === "red_flag" ? "强提示" : "待补充信息后再评估"}`,
    `- **风险点**：${gate.redFlags.join("；") || gate.reasons.join("；")}`,
    // Reasons carry the gate rationale (e.g. 急诊指引/门禁原因). When concrete red flags already
    // occupy the risk line above, they must still be rendered instead of being silently dropped.
    ...(gate.redFlags.length > 0 && gate.reasons.length > 0
      ? [`- **急诊指引/处置原因**：${gate.reasons.join("；")}`]
      : []),
    "- **医生动作**：补齐信息、完成红旗排查和院内审方复核后再考虑处方。",
  ].join("\n"));
}

export function buildSafetyLimitedRisk(gate: SafetyGate): string {
  const limitedStateCopy = buildThreePartLimitedStateCopyForSurface(
    gate.status === "red_flag" ? "red_flag_escalation" : "limited_clinical_scheme",
    {
      knownFacts: gate.redFlags.length > 0
        ? `已识别需优先处置的风险线索：${gate.redFlags.join("；")}`
        : "已完成当前可用病历的风险筛查",
      unavailableConclusion: "完整的处方安全结论",
      reason: gate.reasons.join("；") || "尚有安全信息需要核实",
      nextAction: gate.status === "red_flag"
        ? "立即按急诊或转诊流程处置"
        : "补充所列信息并重新完成风险评估",
    },
  );
  return sanitizeAuthoritativeClinicalOutput([
    "## 当前结论",
    limitedStateCopy,
    "",
    "## 处方安全总评",
    `**最高提示强度**：${gate.status === "red_flag" ? "强提示" : "待补充信息后再评估"}`,
    `**综合风险判断**：${gate.status === "red_flag" ? "高风险" : "当前尚有安全信息待核实；补充所列信息后重新评估"}`,
    `**评级依据**：${gate.reasons.join("；")}`,
    `**医生需确认事项**：${[...gate.missingItems, ...gate.redFlags].join("；") || "请完善病历后复核"}`,
    "",
    "## 转诊评估",
    `**转诊建议**：${gate.status === "red_flag" ? "需要" : "暂不判断"}`,
    `**转诊指征**：${gate.redFlags.join("；") || "无明确红旗，但关键安全信息未补齐"}`,
    `**紧急程度**：${gate.status === "red_flag" ? "急诊" : "完善信息后评估"}`,
    "",
    "## 随访时间轴",
    "| 时间点 | 医生/患者动作 | 观察指标 | 触发处置 |",
    "|------|--------------|---------|---------|",
    `| 当前 | 完善${gate.missingItems.join("、") || "红旗排查"} | 主诉、舌脉、四诊问诊，以及已提示但不完整的过敏/用药/特殊人群信息 | 信息未补齐前不形成包含具体用量的候选处方 |`,
    "| 补齐后 | 重新发起辅助推理 | 证候、病机、风险提示 | 完成必要的处方前信息核查后进入候选方案 |",
  ].join("\n"));
}

function riskSignalLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .filter((line) =>
      line.length > 0 &&
      !/^#{1,6}\s/.test(line) &&
      !/^\|?\s*(提示强度|风险说明|证据依据|医生动作|最高提示强度|综合风险判断)\s*\|?/.test(line) &&
      !/^-{2,}|^\|[-:|\s]+$/.test(line)
    );
}

export function isConditionalSafetyNetRiskLine(line: string): boolean {
  const text = line.trim().replace(/\s+/g, "");
  if (!text) return false;
  if (/(?:患者须知|用药须知|健康宣教|随访|观察指标|触发处置|安全性观察|红旗症状|红旗预警).{0,80}(?:如|若|一旦|当|出现|发生|新发|突发|急性|加重|无效|未解除)/.test(text)) {
    return true;
  }
  if (/(?:如|若|一旦|当).{0,120}(?:出现|发生|新发|加重|无效|未解除).{0,120}(?:请|应|需|建议|立即|及时|就医|转诊|急诊|暂停|停止|复评|复核|处理)/.test(text)) {
    return true;
  }
  if (/(?:出现|发生|新发|加重|无效|无改善|未解除).{0,100}(?:时|则).{0,80}(?:请|应|需|建议|立即|及时|就医|转诊|急诊|暂停|停止|复评|复核|处理)/.test(text)) {
    return true;
  }
  return /(?:转诊指征|推荐科室|紧急程度).{0,80}(?:出现红旗|出现.*急诊|突发|急性|按主诉|常规随访)/.test(text);
}

export function isRiskLineNegatedOrEnumerative(line: string): boolean {
  return /(未见|未提示|未发现|无明确|暂无|没有|否认|排除|不提示|不构成|低风险|未命中|暂不需要|不需要|无需|仅为枚举|风险分级|低风险\s*\/\s*需关注\s*\/\s*高风险|强提示\s*\/\s*一般提示|强提示\s*\/\s*一般提示\s*\/\s*(?:信息不足提示|待补充信息后再评估))/.test(line) ||
    isConditionalSafetyNetRiskLine(line);
}

export function hasCurrentRiskLine(text: string, pattern: RegExp): boolean {
  return riskSignalLines(text).some((line) => pattern.test(line) && !isRiskLineNegatedOrEnumerative(line));
}

function extractMarkdownSections(text: string, headingPattern: RegExp): string {
  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s*(.+?)\s*$/);
    if (heading) {
      if (current) sections.push(current.join("\n"));
      current = headingPattern.test(heading[1] || "") ? [line] : null;
      continue;
    }
    if (current) current.push(line);
  }

  if (current) sections.push(current.join("\n"));
  return sections.join("\n\n");
}

function riskReviewSource(state: CaseState): string {
  const riskSectionPattern = /(用药风险提示|处方安全总评|确定性处方风险复核|合理用药审方|灵犀统一审方|十八反十九畏|处方风险复核|安全总评)/;
  return [
    state.riskAssessment || "",
    extractMarkdownSections(state.prescription || "", riskSectionPattern),
    extractMarkdownSections(state.diagnosis || "", riskSectionPattern),
  ].filter(Boolean).join("\n");
}

/** Strong-risk ownership shared by M05 authoring inputs and the deterministic final timeline. */
export function hasStrongPrescriptionRisk(state: CaseState): boolean {
  return hasCurrentRiskLine(
    riskReviewSource(state),
    /(强提示|(?<!最)高风险|禁用|十八反|十九畏|超出知识库上限|确定性处方风险复核未完成|审方未完成|不能等同为无风险)/,
  );
}

const DEFAULT_FIRST_REVIEW_TIMING = "3-5天后复诊或线上随访";

function primaryPrescribeCandidate(state: CaseState) {
  return state.reasoningPrescribe?.formula?.candidates?.[0] ||
    (state.reasoningV2?.stage === "prescribe" ? state.reasoningV2.formula?.candidates?.[0] : undefined);
}

export function deriveFirstReviewTiming(state: CaseState, hasStrongRisk: boolean): string {
  if (hasStrongRisk) return "调整处方后当日复核；若采纳，1-3天内随访";
  const followUpNode = primaryPrescribeCandidate(state)?.decoction?.followUpNode?.trim();
  return followUpNode || DEFAULT_FIRST_REVIEW_TIMING;
}

/**
 * 首次复诊时间写给患者的那句话（2026-09-28，甲方：随访计划要写进病历、告诉患者何时复诊）。
 *
 * 时间点仍以 deriveFirstReviewTiming 为唯一来源（处方煎服法 → 复诊节点），这里只换说法：
 * 「完成7剂（7日）后复诊」「调整处方后当日复核；若采纳，1-3天内随访」是写给医生/系统的，
 * 患者读到的应当是「请在服完7剂药后（约7天后）复诊」。剂数与天数优先取结构化字段，
 * 与 prescription-regimen-contract 的 followUpAfterDoses/followUpAfterDays 同源。
 * 正文「首次复诊时间」与随访时间轴第一条共用本函数的结果，两处仍逐字相同。
 */
/**
 * 安全门要求先完成临床评估时，复诊安排的第一句（辨证页、开方页的复诊计划与 M05 首次复诊共用这一处；2026-10-24 C069 两处各写各的，
 * 开方页「2周内到乳腺专科」、M05「3天内到相关专科」，评审判时间窗矛盾）。乳房肿块按 NICE NG12 疑似肿瘤路径：两周内专科评估。
 *
 * 开了剂量的方还有煎服法里的「完成7剂（7日）后复诊」：两句此前由两处各写（这里与 applyDeterministicFollowUpNode），读起来是
 *「3天内去评估」对「服完7剂再来」（2026-10-25 第二十轮：已存输出里给了剂量又要求先评估的 52 例全部如此，甲方标准病历 10、S044 被评审判矛盾）。
 * 现在一份计划、两种写法：先评估（时限、去哪、做什么）→ 医生确认可以服药 → 服完 N 剂复诊。regimen 取方剂的 followUpAfterDoses/Days，
 * 复诊计划第一句（priorityEvaluationFirstStep）与煎服法复诊节点（priorityEvaluationFollowUpNode）都由 priorityEvaluationPlan 拼出。
 */
type PriorityEvaluationPlan = { window: string; visit: string; nodeVisit: string; clearance: string; withoutRegimenTail?: string };
const PRIORITY_WINDOW_LABELS = new Map(priorityEvaluationWindowTable.windows.map((entry) => [entry.id, entry.label]));
const PRIORITY_WINDOW_LABEL_PATTERN = priorityEvaluationWindowTable.windows.map((entry) => entry.label).join("|");
function priorityEvaluationTarget(target: PriorityEvaluationTarget | string): PriorityEvaluationTarget {
  return typeof target === "string"
    ? { focus: target, window: priorityEvaluationWindowTable.defaultWindow as PriorityEvaluationWindowId }
    : target;
}
function priorityEvaluationPlan(input: PriorityEvaluationTarget | string): PriorityEvaluationPlan {
  const target = priorityEvaluationTarget(input);
  const window = PRIORITY_WINDOW_LABELS.get(target.window) || "3天内";
  const pathway = target.pathway ? priorityEvaluationWindowTable.pathways[target.pathway] : undefined;
  if (pathway) {
    return { window, visit: pathway.visit, nodeVisit: pathway.nodeVisit, clearance: pathway.clearance, withoutRegimenTail: pathway.withoutRegimenTail };
  }
  const focus = target.focus;
  return focus
    ? { window, visit: `到相关专科就诊，先完成评估（需排除${focus}）`, nodeVisit: "到相关专科完成评估", clearance: "医生确认可以服药后" }
    : { window, visit: "到医院完成评估、核实病情", nodeVisit: "到医院完成评估", clearance: "医生确认可以服药后" };
}
type FollowupRegimen = { doses?: unknown; days?: unknown };
function regimenCounts(regimen?: FollowupRegimen): { doses: number; days: number } | undefined {
  const doses = Number(regimen?.doses);
  const days = Number(regimen?.days);
  return Number.isInteger(doses) && Number.isInteger(days) && doses > 0 && days > 0 ? { doses, days } : undefined;
}
export function priorityEvaluationFirstStep(target: PriorityEvaluationTarget | string, regimen?: FollowupRegimen): string {
  const plan = priorityEvaluationPlan(target);
  const counts = regimenCounts(regimen);
  if (counts) return `请在${plan.window}${plan.visit}；${plan.clearance}，服完${counts.doses}剂药（约${counts.days}天后）再复诊。`;
  if (plan.withoutRegimenTail) return `请在${plan.window}${plan.visit}，${plan.withoutRegimenTail}。`;
  return priorityEvaluationTarget(target).focus
    ? `请在${plan.window}${plan.visit}，再按医生安排服药与复诊。`
    : `请在${plan.window}${plan.visit}后，再按医生安排服药与复诊。`;
}
/** 煎服法的复诊节点前面补上评估这一步（与 priorityEvaluationFirstStep 同一份计划）。已补过的原样返回。 */
export function priorityEvaluationFollowUpNode(target: PriorityEvaluationTarget | string, node: string): string {
  const plan = priorityEvaluationPlan(target);
  if (!node.trim() || new RegExp(`^先在(?:${PRIORITY_WINDOW_LABEL_PATTERN})`, "u").test(node)) return node;
  return `先在${plan.window}${plan.nodeVisit}；${plan.clearance}，${node.trim()}`;
}

export function patientFacingFirstReview(state: CaseState, hasStrongRisk: boolean): string {
  if (hasStrongRisk) return "处方需经医生调整确认后再服用；确认用药后，请在1-3天内复诊。";
  // 安全门要求先完成临床评估的病例：首次复诊先说去评估（与辨证、开方页复诊计划的第一句同一判据，2026-10-24）。
  const priorityTarget = priorityEvaluationFollowupTarget(state);
  const decoction = primaryPrescribeCandidate(state)?.decoction;
  if (priorityTarget !== undefined) {
    return `${priorityEvaluationFirstStep(priorityTarget, { doses: decoction?.followUpAfterDoses, days: decoction?.followUpAfterDays }).replace(/。$/u, "")}；如有不适或症状加重，请立即就医。`;
  }
  const doses = decoction?.followUpAfterDoses;
  const days = decoction?.followUpAfterDays;
  if (Number.isInteger(doses) && Number.isInteger(days) && Number(doses) > 0 && Number(days) > 0) {
    return `请在服完${doses}剂药后（约${days}天后）复诊；如有不适或症状加重，请提前复诊。`;
  }
  const timing = deriveFirstReviewTiming(state, false);
  if (timing === DEFAULT_FIRST_REVIEW_TIMING) {
    return "请在3-5天后复诊，或通过电话、线上向医生反馈服药后的变化；如有不适或症状加重，请提前复诊。";
  }
  return timing;
}

/** 就医警示的兜底：模型没有写出本例的急症表现时，至少给出不分病种都成立的几条。 */
const GENERIC_URGENT_SIGNS = ["高热不退", "胸痛或呼吸困难", "神志不清或抽搐", "呕血、便血或咯血等出血"];
const PATIENT_EFFICACY_TRIGGER = "服药后主要症状没有好转或反而加重，或出现新的不适";
const PATIENT_WORSENING_PLAN = "服药后症状没有好转、反而加重，或出现新的不适，请及时回门诊复诊，由医生重新评估并调整治疗；请不要自行加减或更换药物。如出现皮疹、瘙痒、胸闷气短等过敏或明显不适，请暂停服药并及时就医。";
const PATIENT_MEDICATION_NOTE = "请不要自行叠加中药或中成药；复诊时请携带正在使用的全部药物（或药盒、药品清单）。";

function patientUrgentCareLine(signs: readonly string[] | undefined): string {
  const usable = uniqueFollowupText([...(signs || [])], 6).filter((item) => !isRecordCompletenessStatement(item));
  return `如出现${(usable.length >= 2 ? usable : GENERIC_URGENT_SIGNS).join("、")}，请立即到急诊就医。`;
}

function hasStructuredDoseCandidate(state: CaseState): boolean {
  const candidates = [
    ...(state.reasoningPrescribe?.formula?.candidates || []),
    ...(state.reasoningV2?.stage === "prescribe" ? state.reasoningV2.formula?.candidates || [] : []),
  ];
  return candidates.some((candidate) =>
    Array.isArray(candidate.herbs) && candidate.herbs.length > 0 &&
    candidate.herbs.every((herb) => typeof herb.dose === "string" && /\d(?:\.\d+)?\s*(?:mg|g|克|钱|mL|ml|毫升)/i.test(herb.dose))
  );
}

function buildNonDoseRiskFollowup(gate: SafetyGate): string {
  const pending = gate.missingItems.join("、") || "结构化剂量方案及其处方级安全复核";
  return [
    "## 处方安全总评",
    "**最高提示强度**：待补充信息后再评估",
    "**综合风险判断**：本轮未生成剂量级处方，不作处方用药风险或疗效判定，也不生成用药阶段随访安排。",
    `**当前受限状态**：${pending}尚未完成；不得将本轮结果表述为可采纳或可审阅的剂量级候选处方。`,
    "",
    "## 非药物与继续评估",
    "**当前建议**：仅进行与主诉相适应的作息、饮食、情志、活动等非药物管理，并继续观察症状变化；不据此自行用药。",
    `**继续评估重点**：补足或复核${pending}，同时记录主诉、伴随症状、舌脉及必要生命体征。`,
    "**重新评估条件**：安全信息和适用的个体化剂量规则补足后，重新发起处方级评估；出现急性加重或红旗症状时立即转入现场评估或急诊处置。",
    "",
    "## 后续评估时间轴",
    "| 时间点 | 医生/患者动作 | 观察指标 | 触发处置 |",
    "|------|--------------|---------|---------|",
    `| 当前 | 继续临床评估并补足${pending} | 主诉、伴随症状、舌脉及必要生命体征 | 症状急性加重或出现红旗时及时就医 |`,
    "| 补足后 | 重新进行辨证与处方级安全评估 | 个体化剂量依据、过敏/现用药及特殊人群风险 | 仍不满足安全边界时继续保持非剂量状态 |",
  ].join("\n");
}

function buildRestrictedDoseRiskFollowup(reasons: string[]): string {
  const reasonText = reasons.join("；") || "处方级安全筛查尚未完成";
  return [
    "## 处方安全总评",
    "**最高提示强度**：待补充信息后再评估",
    "**综合风险判断**：本轮虽存在结构化剂量候选，但处方级安全筛查未完成，当前为受限状态。",
    `**受限原因**：${reasonText}。`,
    "**医生需确认事项**：当前候选不得采纳、执行或转写；仅可保留为待复核记录。",
    "",
    "## 继续评估",
    `**当前动作**：完成${reasonText}，并结合患者现场情况进行人工安全复核。`,
    "**重新评估条件**：受限原因解除后，重新计算安全门并再次完成处方级风险评估。",
    "**期间处置**：仅提供与主诉相适应的非药物管理和症状观察；出现急性加重或红旗症状时及时就医。",
    "",
    "## 后续评估时间轴",
    "| 时间点 | 医生/患者动作 | 观察指标 | 触发处置 |",
    "|------|--------------|---------|---------|",
    `| 当前 | 完成受限项并人工复核 | ${reasonText} | 未完成前保持不可采纳、不可执行 |`,
    "| 受限解除后 | 重新进行处方级安全评估 | 剂量依据、过敏/现用药及特殊人群风险 | 仍不满足安全边界时继续保持受限状态 |",
  ].join("\n");
}

function followupTableCell(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\|/g, "／").replace(/\s+/g, " ").trim();
}

function uniqueFollowupText(values: Array<string | undefined>, limit = 5): string[] {
  return [...new Set(values
    .map((value) => followupTableCell(value || ""))
    .filter((value) => value.length >= 2))].slice(0, limit);
}

// M05 随访汇总原先从 nonPharma.monitoring 取 指标/时间/触发 三路输入。该结构化字段已删除，
// 这里改为：指标与触发落到既有的 coreFacts / 固定回退路径（两条回退本就存在且被测试覆盖），
// 注意事项只作为一条只读文本行呈现，不再变成随访时间轴的结构化行。
function structuredFollowupInputs(state: CaseState): {
  precautions: string[];
  coreFacts: string[];
} {
  const prescribe = state.reasoningPrescribe || (state.reasoningV2?.stage === "prescribe" ? state.reasoningV2 : undefined);
  const diagnose = state.reasoningDiagnose || state.reasoningV2;
  return {
    precautions: uniqueFollowupText(prescribe?.nonPharma?.precautions || [], 6),
    coreFacts: uniqueFollowupText([
      ...(diagnose?.westernDiagnosis?.primary?.supportingFacts || []),
      ...(diagnose?.overview?.primarySyndromeBasis || []),
      state.chiefComplaint,
    ], 5),
  };
}

const FOLLOWUP_TIMELINE_START = "<!-- FOLLOWUP_TIMELINE_JSON_START -->";
const FOLLOWUP_TIMELINE_END = "<!-- FOLLOWUP_TIMELINE_JSON_END -->";

function validStructuredFollowupItem(value: unknown): value is StructuredFollowupTimelineItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.time === "string" && Boolean(item.time.trim()) &&
    typeof item.action === "string" && Boolean(item.action.trim()) &&
    Array.isArray(item.indicators) && item.indicators.every((entry) => typeof entry === "string" && Boolean(entry.trim())) &&
    Array.isArray(item.triggers) && item.triggers.every((entry) => typeof entry === "string" && Boolean(entry.trim()));
}

export function parseStructuredFollowupTimeline(content: string | undefined): StructuredFollowupTimelineItem[] {
  if (!content) return [];
  const start = content.indexOf(FOLLOWUP_TIMELINE_START);
  const end = content.indexOf(FOLLOWUP_TIMELINE_END, start + FOLLOWUP_TIMELINE_START.length);
  if (start < 0 || end < 0) return [];
  try {
    const parsed = JSON.parse(content.slice(start + FOLLOWUP_TIMELINE_START.length, end).trim());
    return Array.isArray(parsed) ? parsed.filter(validStructuredFollowupItem).slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function stripStructuredFollowupTimeline(content: string): string {
  return content
    .replace(/<!-- FOLLOWUP_TIMELINE_JSON_START -->[\s\S]*?<!-- FOLLOWUP_TIMELINE_JSON_END -->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizedStructuredFollowupItems(items: StructuredFollowupTimelineItem[]): StructuredFollowupTimelineItem[] {
  return items
    .map((item) => ({
      time: followupTableCell(item.time),
      action: followupTableCell(item.action),
      indicators: uniqueFollowupText(item.indicators, 8),
      triggers: uniqueFollowupText(item.triggers, 8),
    }))
    .filter((item) => item.time && item.action && (item.indicators.length > 0 || item.triggers.length > 0))
    .slice(0, 8);
}

function withStructuredFollowupTimeline(markdown: string, items: StructuredFollowupTimelineItem[]): string {
  return [
    markdown,
    FOLLOWUP_TIMELINE_START,
    JSON.stringify(normalizedStructuredFollowupItems(items)),
    FOLLOWUP_TIMELINE_END,
  ].join("\n");
}

/**
 * 从审方文本里抽出**可读的风险观察项**（2026-08-12 线上实测重写）。
 *
 * 实测缺陷：原实现按行取整段，于是审方表格的**整行原文**被当成观察项，外面再套上
 * 「出现X时提前复诊」，直接摆在随访时间轴第一条上给医生看。实测产出：
 *   「出现规则审查 ／ 强提示 ／ 医师处方权限需确认 ／ 3 ／ 苦杏仁(捣碎) 药品主数据标注为
 *     毒性药品,当前医生权限标识为 未提供。 ／ 毒性药品处方权(主数据/官方管制目录) ／
 *     请确认开方医师权限… ／ f6a08f3d-83d9-40a9-ae76-c1c6206d5301时提前复诊」
 * 里面有规则名、等级、序号、处置建议、UUID——唯独不是一个「观察什么」。
 * 还有一条把整段**范围说明**（「中成药/西药候选已按药品身份及联用边界提交…」）也套了进去。
 *
 * 改为结构化抽取：审方行是 `／` 或 `|` 分隔的多格，只取**风险描述**那一格
 * （含临床风险词、且不是规则名/等级/处置建议/标识符）。取不到就**这一条不生成**——
 * 宁可少一条触发条件，也不能把一段乱码摆给医生当随访依据。
 */
const AUDIT_RISK_TERMS = /(禁忌|慎用|相互作用|过敏|超量|超过|肝肾|妊娠|哺乳|出血|毒性|有毒|重复用药|心悸|血压|嗜睡|成瘾|依赖)/;
/** 不是「观察什么」的格：规则名、提示等级、处置建议、纯标识符、范围说明。 */
const AUDIT_NON_OBSERVATION = /^(?:规则审查|给药途径审查|剂量审查|配伍审查|适应证审查|强提示|一般提示|说明性提示|信息不足提示|\d+|[0-9a-f]{8}-[0-9a-f-]{20,}|请[^，,。]{0,40}$|范围说明[:：])/;
/** 规则元数据描述系统权限或目录身份，不是患者可观察到的随访症状。 */
const AUDIT_RULE_METADATA = /(?:处方权|主数据|管制目录|权限)/;
/** 至少包含一个患者能观察或医生能复核的完整临床条件，不能只是「毒性反应」这类标题。 */
const AUDIT_PATIENT_OBSERVATION = /(?:出现|发生|加重|减轻|缓解|无改善|不适|症状|心悸|胸闷|头晕|乏力|麻木|皮疹|出血|疼痛|呕吐|腹泻|呼吸|血压|嗜睡|成瘾|依赖|禁忌|慎用|相互作用|超过|超量)/;
/**
 * 审核/数据完整性类条目**不是患者能"出现"的事**。
 * 「未找到药品主数据」「未提供可识别的单次剂量」「关键安全审核项目暂未得到可核验结果」
 * 说的是我方或药师要补的动作，写成「出现…时提前复诊」是让病人去处理我们的数据缺口。
 * 本地实测（真实医案）这三种形态都出现过。
 */
// 只认「缺失/无法」这一类动词，不认名词。「主数据」两种语境都出现——
// 「**未找到**药品主数据」是覆盖缺口，「药品**主数据标注为**毒性药品」是真实临床风险，
// 按名词过滤会把后者一并误杀（实测如此）。
const AUDIT_DATA_COVERAGE = /(未找到|未提供|未识别|暂不能|暂未|无法完成|无法识别|未得到|重新审方|重新审核)/;

/**
 * 审方表既可能用全角斜线，也可能用 Markdown 竖线；规则名自身还会包含
 * `主数据/官方管制目录`。只在括号外切列，避免把规则名切成能通过风险词筛选的残片。
 */
function splitAuditFields(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let groupingDepth = 0;
  for (const character of line) {
    if (character === "(" || character === "（" || character === "[" || character === "【") groupingDepth += 1;
    if (character === ")" || character === "）" || character === "]" || character === "】") {
      groupingDepth = Math.max(0, groupingDepth - 1);
    }
    if (groupingDepth === 0 && (character === "／" || character === "/" || character === "|")) {
      if (field.trim()) fields.push(field.trim());
      field = "";
      continue;
    }
    field += character;
  }
  if (field.trim()) fields.push(field.trim());
  return fields;
}

function hasBalancedAuditGrouping(value: string): boolean {
  const pairs: Record<string, string> = { "(": ")", "（": "）", "[": "]", "【": "】" };
  const closing = new Set(Object.values(pairs));
  const stack: string[] = [];
  for (const character of value) {
    if (pairs[character]) stack.push(pairs[character]);
    else if (closing.has(character) && stack.pop() !== character) return false;
  }
  return stack.length === 0;
}

function auditRiskObservationFromLine(line: string): string {
  if (!AUDIT_RISK_TERMS.test(line)) return "";
  const cells = splitAuditFields(line);
  const candidates = (cells.length > 1 ? cells : [line])
    .filter((cell) => !AUDIT_NON_OBSERVATION.test(cell))
    .filter((cell) => !AUDIT_RULE_METADATA.test(cell))
    .filter(hasBalancedAuditGrouping)
    .filter((cell) => cell.length >= 6 && cell.length <= 60)
    .filter((cell) => AUDIT_PATIENT_OBSERVATION.test(cell))
    .filter((cell) => !AUDIT_DATA_COVERAGE.test(cell))
    // 逗号拼起来的标签串（「抗凝,蒲黄 活血化瘀,出血」）不是一句能读的观察项。
    .filter((cell) => {
      const tokens = cell.split(/[，,、]/).map((token) => token.trim()).filter(Boolean);
      return tokens.length <= 2 || tokens.filter((token) => token.length >= 6).length >= tokens.length / 2;
    })
    // 处置建议（「请…」「建议…」「应…」）是给医生的动作，不是给患者的观察项。
    .filter((cell) => !/^(?:请|建议|应|须|需)/.test(cell));
  return candidates[0] || "";
}

function concreteAuditRiskObservations(value: string): string[] {
  return uniqueFollowupText(value
    .split(/\n+/)
    .map((line) => line
      .replace(/^\s*(?:[-*]|\d+[.、])\s*/, "")
      .replace(/\*\*/g, "")
      .replace(/^\|?|\|?$/g, "")
      .trim())
    .filter((line) =>
      line.length >= 4 &&
      /(禁忌|慎用|相互作用|过敏|超量|剂量|肝肾|妊娠|哺乳|出血|毒性|重复用药|强提示|一般提示)/.test(line) &&
      !/(?:未见明确|未识别|未发现|暂无|无明确).{0,12}(?:风险|冲突|问题)/.test(line) &&
      !/(?:处方可作为候选方案|结合过敏史|现用药|特殊人群状态和院内规则完成复核)/.test(line))
    .map(auditRiskObservationFromLine)
    .filter(Boolean), 4);
}

/**
 * 触发条件必须是**会发生在病人身上的事**。「病历尚未确认发热是否存在」是记录完整性陈述，
 * 病人不可能"出现"它；摆在 triggers 里等于告诉医生「记录不全时提前复诊」。
 * 2026-08-12 线上实测在湿热淋证例的第 2、3 条上各出现一次。
 */
const NON_TRIGGER_RECORD_STATEMENT = /(?:病历(?:已|尚未|未)|尚未确认|未记录|记录完整性|资料未|信息未)/;
export function isRecordCompletenessStatement(value: string): boolean {
  return NON_TRIGGER_RECORD_STATEMENT.test(String(value || ""));
}
function usableFollowupTriggers(values: readonly string[]): string[] {
  return values.filter((value) => value && !isRecordCompletenessStatement(value));
}

export type DeterministicRiskFollowupPayload = WarningTextProjection & {
  timelineItems: StructuredFollowupTimelineItem[];
};

/**
 * M05 载荷。**安全结论恒为确定性**（最高提示强度/综合风险判断/评级依据/医生需确认事项
 * 全部来自灵犀处方后审方，模型碰不到）；authored 只替换临床内容槽位——
 * 复诊评估重点、疗效评价口径、生活管理、复评维度。authored 为空时逐字回落原模板。
 */
export function buildDeterministicRiskFollowupPayload(
  state: CaseState,
  authored?: {
    reviewFocus: string; efficacyCriteria: string; lifestyle: string; dimensions: string[];
    monitoringIndicators?: string[];
    urgentSigns?: string[];
    timeline?: Array<{ time: string; action: string; indicators: string[]; triggers: string[] }>;
  } | null,
): DeterministicRiskFollowupPayload {
  const gate = state.safetyGate || evaluateSafetyGate(state);
  const followup = structuredFollowupInputs(state);
  if (gate.status === "red_flag") {
    return {
      ...joinWarningText([buildSafetyLimitedRisk(gate)]),
      timelineItems: normalizedStructuredFollowupItems([{
      time: "当前",
      action: "优先完成现场风险处置",
      indicators: uniqueFollowupText([...gate.redFlags, ...followup.coreFacts]),
      triggers: uniqueFollowupText(gate.reasons.length > 0 ? gate.reasons : ["按急诊或转诊流程处置"]),
      }]),
    };
  }
  if (!hasStructuredDoseCandidate(state)) {
    return {
      ...joinWarningText([buildNonDoseRiskFollowup(gate)]),
      timelineItems: normalizedStructuredFollowupItems([{
        time: "当前",
        action: "补足处方级评估所需信息",
        indicators: uniqueFollowupText([...followup.coreFacts, ...gate.missingItems]),
        triggers: ["安全信息和结构化剂量方案未完成前，不形成用药阶段随访安排"],
      }]),
    };
  }
  const hardDoseBoundary = hardDoseSafetyBoundaryReasons(state);
  if (hardDoseBoundary.length > 0) {
    return {
      ...joinWarningText([buildRestrictedDoseRiskFollowup(hardDoseBoundary)]),
      timelineItems: normalizedStructuredFollowupItems([{
        time: "当前",
        action: "完成受限项并人工复核",
        indicators: uniqueFollowupText(hardDoseBoundary),
        triggers: ["受限原因未解除前，候选处方不可采纳或执行"],
      }]),
    };
  }

  const vitalAdvisories = unparseableVitalAdvisories(state);
  const missingAdvisory = gate.missingItems.length > 0 ? gate.missingItems.join("、") : "";
  const riskSource = riskReviewSource(state);
  // 审方结论只影响提示强度和医生复核动作，不参与硬安全门控。
  const hasStrongRisk = hasStrongPrescriptionRisk(state);
  // NOTE: pure evidence-provenance tokens ("待检索"/"证据不足") are intentionally NOT here — every
  // model-inference prescription cites them, so scanning for them mislabels benign cases as 中风险.
  const hasReviewRisk = Boolean(missingAdvisory) || hasCurrentRiskLine(riskSource, /(一般提示|需复核|慎用|相互作用|过敏|特殊人群|信息不足提示|待补充信息后再评估|用药史|当前用药)/);
  const highest = hasStrongRisk ? "强提示" : hasReviewRisk ? "一般提示" : "说明性提示";
  const overall = hasStrongRisk ? "较高风险，需调整或复核后采纳" : hasReviewRisk ? "中等风险，需医生复核后采纳" : "当前未识别确定性高危用药冲突，仍需医生最终确认";
  const doctorAction = hasStrongRisk
    ? "候选处方命中强提示或审方未完成，请调整剂量/药味、完善复核或请药师复核后再采纳。"
    : hasReviewRisk
      ? "处方可作为候选方案审阅，请结合过敏史、现用药、特殊人群状态和院内规则完成复核。"
      : "当前无确定性强提示；仍需医生按病情、说明书和院内药事规则最终确认。";
  // 随访管理方案写进病历、交给患者（2026-09-28 甲方）：栏目名不变，内容一律写给患者本人——
  // 什么时候复诊、服药期间留意什么、出现什么提前来、出现什么立即去急诊。
  // 安全总评（上方「处方安全总评」）仍是给医生的确定性结论，不在此列。
  const firstReview = patientFacingFirstReview(state, hasStrongRisk);
  const symptomFocus = followup.coreFacts.length > 0
    ? followup.coreFacts.map((fact) => fact.replace(/[。.；;，,]+$/g, "")).join("、")
    : "本次主要不适";
  const efficacyTrigger = PATIENT_EFFICACY_TRIGGER;
  const authoredIndicators = (authored?.monitoringIndicators || []).filter((item) => Boolean(item?.trim()));
  const actualRiskIndicators = concreteAuditRiskObservations(riskSource);
  // 随访时间轴只保留两条确定性行（首次复诊 + 治疗期间随时）。原先由 nonPharma.monitoring 派生的
  // 第三类行随字段一并删除：注意事项是自由文本，不再有 timing/metric/trigger 的字段归属，
  // 硬塞进结构化时间轴只会重新制造那套语义合同。它改由下方 `**注意事项**` 只读行呈现。
  // ── 随访时间轴：整条由模型按本例撰写，安全项只增不减地并进去 ────────────────────
  //
  // 2026-08-12 之前这张表只有 indicators 是模型写的，且两条目共用同一份；
  // action 两条写死、time 第二条恒为「治疗期间随时」、triggers 主体恒为一句固定话术。
  // 一个风寒表证与一个湿热淋证拿到的时间轴逐字相同——那不是随访方案，是排版。
  //
  // 三条边界（模型碰不到）：
  //   ① 第一条的时间点强制等于处方煎服法定的 firstReview，与正文「首次复诊时间」同源；
  //   ② 审方得出的安全触发条件（concreteAuditRiskObservations）**并进第一条**，
  //      模型给什么都不能把它挤掉——这与临床事实回补层「只可追加」同一方向；
  //   ③ 红旗 / 无结构化剂量 / 硬剂量边界三条降级路径在上面就 return 了，根本不到这里。
  // 审方短语自带句号/已经是完整条件句时，不要再套「出现…时提前复诊」——
  // 线上实测产出「出现抗凝者增加出血风险。时提前复诊」，医生读到的是一句病句。
  const safetyTriggers = actualRiskIndicators.map((item) => {
    const phrase = item.replace(/[。.；;，,]+$/g, "").trim();
    if (!phrase) return "";
    // 已经以动词/条件开头的（「服药后出现…」「用药期间…」）原样保留，只补上复诊动作。
    return /^(?:服药|用药|治疗|出现|如出现|若出现)/.test(phrase)
      ? `${phrase}时提前复诊`
      : `出现${phrase}时提前复诊`;
  }).filter(Boolean);
  const authoredTimeline = (authored?.timeline || []).filter((item) => item?.time && item?.action);
  const timelineItems: StructuredFollowupTimelineItem[] = authoredTimeline.length >= 2
    ? authoredTimeline.map((item, index) => ({
      time: index === 0 ? firstReview : item.time,
      action: item.action,
      indicators: uniqueFollowupText(item.indicators, 6),
      triggers: uniqueFollowupText(
        usableFollowupTriggers(index === 0 ? [...item.triggers, ...safetyTriggers] : item.triggers),
        6),
    }))
    : [
      {
        time: firstReview,
        action: "按时复诊，把服药后的变化和不适告诉医生",
        // 观察项由模型按本例写；模型没给（或校验没过）就回落本例已记录的主要表现。
        indicators: uniqueFollowupText(
          authoredIndicators.length > 0
            ? [...authoredIndicators, "服药后有无不适", "是否按时服药"]
            : [...followup.coreFacts.map((fact) => `${fact.replace(/[。.；;，,]+$/g, "")}的变化`), "服药后有无不适", "是否按时服药"],
          6),
        triggers: uniqueFollowupText(usableFollowupTriggers([efficacyTrigger, ...safetyTriggers]), 6),
      },
      {
        time: "服药期间",
        action: "每天留意症状变化，出现下列情况请提前就诊",
        indicators: uniqueFollowupText(
          authoredIndicators.length > 0
            ? [...authoredIndicators, "新出现的不适或原有症状加重"]
            : [...followup.coreFacts, "新出现的不适或原有症状加重"],
          6),
        triggers: uniqueFollowupText([
          efficacyTrigger,
          "症状突然明显加重时，请立即就医",
        ], 6),
      },
    ];
  return {
    ...joinWarningText([
    "## 处方安全总评",
    // These are formatted conclusions, not new evidence. Actual audit enums and independent
    // current findings are supplied separately; words in labels/negative boilerplate cannot grade.
    adviceText(`**最高提示强度**：${highest}`),
    adviceText(`**综合风险判断**：${overall}`),
    adviceText(`**评级依据**：${hasStrongRisk ? "处方后置复核命中强提示或存在未完成的确定性审方链路。" : hasReviewRisk ? "病历或处方中存在需医生复核的用药、过敏、特殊人群或联用信息。" : "处方后置复核未提示明确高危冲突。"}`),
    adviceText(`**医生需确认事项**：${doctorAction}`),
    ...(missingAdvisory ? [`**待核实信息**：${missingAdvisory}。这些未知项不阻断候选方案展示，正式采纳前请结合临床实际确认。`] : []),
    ...(vitalAdvisories.length > 0 ? [`**生命体征录入提示**：${vitalAdvisories.join("；")}`] : []),
    "",
    "## 随访管理方案",
    adviceText(`**首次复诊时间**：${firstReview}`),
    adviceText(authored
      ? `**复诊评估重点**：${authored.reviewFocus}`
      : `**复诊评估重点**：复诊时医生会重点了解${symptomFocus}有没有减轻、发作次数和对日常生活的影响，并查看舌象和脉象；请您服药期间留意这些变化，复诊时如实告诉医生实际服药情况和服药后的不适。`),
    adviceText(authored
      ? `**疗效评价标准**：${authored.efficacyCriteria}`
      : `**疗效评价标准**：与这次就诊时相比，${symptomFocus}明显减轻或发作减少，且没有出现新的不适，说明治疗有效；如果没有好转甚至加重，请按时或提前复诊。`),
    ...(actualRiskIndicators.length > 0 ? [`**安全性观察**：服药期间请留意：${actualRiskIndicators.map((item) => item.replace(/[。.；;，,]+$/g, "")).join("；")}；如出现上述情况，请及时复诊。`] : []),
    // 同一批注意事项的 owner 是 M04 处方正文的「### 注意事项」节（2026-08-25 审查 V3）；
    // M05 只在 M04 段缺席时兜底渲染，否则下载报告里同一内容双印且格式不一致。
    ...(followup.precautions.length > 0 && !(state.prescription || "").includes("### 注意事项")
      ? [`**注意事项**：${followup.precautions.map((item) => item.replace(/[。.；;，,]+$/g, "")).join("；")}。`]
      : []),
    adviceText(`**无效或加重的处置预案**：${PATIENT_WORSENING_PLAN}${patientUrgentCareLine(authored?.urgentSigns)}`),
    "",
    ...sixHealthFollowupTable(authored?.dimensions).split("\n").map(adviceText),
    "",
    // 「## 随访时间轴」这张表 2026-08-10 按甲方要求从**医生可见面**移除：随访时间与
    // 触发条件已经由上面「首次复诊时间 / 复诊评估重点 / 疗效评价标准 / 无效或加重的处置预案」
    // 逐条讲过，表格是同一批内容换个排版再印一遍。
    // 结构化 timelineItems 仍随 payload 返回（HIS 出参与 API 消费方读它），只是不再渲染。
    "## 生活管理",
    // 模型写本例证候该注意什么；固定安全句无论如何都保留——它不是调护建议，是边界声明。
    ...(authored ? [adviceText(authored.lifestyle)] : []),
    adviceText(authored
      ? PATIENT_MEDICATION_NOTE
      : `饮食、作息、情绪和活动请按本次调护建议安排；${PATIENT_MEDICATION_NOTE}`),
    ]),
    timelineItems: normalizedStructuredFollowupItems(timelineItems),
  };
}

export function buildDeterministicRiskFollowup(
  state: CaseState,
  authored?: Parameters<typeof buildDeterministicRiskFollowupPayload>[1],
): string {
  const payload = buildDeterministicRiskFollowupPayload(state, authored);
  return withStructuredFollowupTimeline(payload.markdown, payload.timelineItems);
}

export function buildDeterministicRiskFollowupProjection(
  state: CaseState,
  authored?: Parameters<typeof buildDeterministicRiskFollowupPayload>[1],
): DeterministicRiskFollowupPayload {
  const payload = buildDeterministicRiskFollowupPayload(state, authored);
  return { ...payload, markdown: withStructuredFollowupTimeline(payload.markdown, payload.timelineItems) };
}

export function buildForcedIncompleteRiskFollowup(state: CaseState): string {
  const gate = state.safetyGate || evaluateSafetyGate(state);
  const missing = gate.missingItems.join("、") || "关键四诊信息";
  return [
    "## 处方安全总评",
    "**最高提示强度**：待临床复核",
    "**综合风险判断**：本轮已按医生选择，基于现有资料形成候选方案；以下待核实信息不会阻断报告生成，但须在正式采纳前由医生确认。",
    `**待复核信息**：${missing}。请结合本次接诊可获得的资料核对证候、病机、方药匹配与剂量合理性。`,
    "",
    "## 随访管理方案",
    "**首次复诊时间**：请按医生告知的时间复诊；如有不适或症状加重，请提前复诊。",
    "**复诊评估重点**：复诊时医生会再次核对本次尚未确认的病情信息，并查看主要症状、伴随不适、舌象脉象和服药后的反应；请您如实告知过敏史、正在使用的药物等情况，服药期间留意症状变化。",
    "**安全性观察**：服药期间请留意有无皮疹瘙痒、胃肠不适、头晕乏力、心悸胸闷、出血倾向或原有症状加重；如出现上述情况，请及时复诊。",
    `**无效或加重的处置预案**：${PATIENT_WORSENING_PLAN}${patientUrgentCareLine(undefined)}`,
    "",
    ...sixHealthFollowupTable().split("\n"),
    "",
    "## 随访时间轴",
    "| 时间点 | 医生/患者动作 | 观察指标 | 触发处置 |",
    "|------|--------------|---------|---------|",
    "| 首次复诊 | 按医生告知的时间复诊，把服药后的变化告诉医生 | 主要症状变化、服药后有无胃肠不适或过敏表现 | 症状没有好转或加重、出现皮疹等不适时，请提前复诊 |",
    "| 服药期间 | 每天留意症状变化 | 主要症状、精神体力 | 症状突然明显加重时，请立即就医 |",
  ].join("\n");
}

export function applySafetyLimitedOutcome(state: CaseState): CaseState {
  const gated = withSafetyGate(state);
  const gate = gated.safetyGate!;
  return {
    ...gated,
    diagnosis: buildSafetyLimitedDiagnosis(gated, gate),
    prescription: buildSafetyLimitedPrescription(gate),
    riskAssessment: buildSafetyLimitedRisk(gate),
    phase: "done",
  };
}

export function applyCompletenessLimitedOutcome(state: CaseState): CaseState {
  const gated = withSafetyGate(state);
  const completenessLevel = gated.completeness?.level || "未评估";
  const completenessText = completenessLevel === "C" ? "可生成候选方案" : completenessLevel === "B" ? "可初步推理" : "信息不足";
  const gate: SafetyGate = {
    status: "needs_information",
    allowDiagnosis: false,
    allowDosePrescription: false,
    action: "complete_before_prescription",
    missingItems: [`辨证信息完整度不足（当前：${completenessText}，需达到：可生成候选方案）`],
    redFlags: [],
    reasons: ["主诉、舌脉或核心辨证证据仍不足以支撑剂量级候选处方。年龄和非高风险场景下的生命体征不作为通用阻断项；性别/生理状态、过敏史与当前用药须在 M04 前明确。"],
  };
  return {
    ...gated,
    safetyGate: gate,
    diagnosis: buildSafetyLimitedDiagnosis(gated, gate),
    prescription: buildSafetyLimitedPrescription(gate),
    riskAssessment: buildSafetyLimitedRisk(gate),
    phase: "done",
  };
}

export function sanitizeCaseStateForModel(state: CaseState): CaseState {
  const patientName = state.patient.name || state.hisRecord?.fields?.patientName || "";
  const limitText = (value?: string, max = 6000) => {
    if (!value) return value;
    return value.length > max ? `${value.slice(0, max)}\n[内容已按模型上下文预算截断]` : value;
  };
  const scrub = (value?: string, max = 6000) => {
    if (!value) return value;
    return limitText(scrubPhi(value, patientName), max);
  };
  const scrubHeadTail = (value?: string, max = 12000) => {
    if (!value) return value;
    return limitModelTextHeadTail(scrubPhi(value, patientName), max);
  };
  const scrubFields = (fields: HisRecordSnapshot["fields"] | undefined): HisRecordSnapshot["fields"] => {
    const next: HisRecordSnapshot["fields"] = {};
    for (const [key, value] of Object.entries(fields || {})) {
      next[key as keyof HisRecordSnapshot["fields"]] = scrub(value);
    }
    return { ...next, patientName: undefined };
  };
  const scrubUnknown = <T>(value: T, maxStringLength = 6000): T =>
    sanitizeUnknownForModel(value, { patientName, maxStringLength });
  // 已签名推理载荷：保留 schema 键、逐值脱敏（2026-09-28）。此前走上面的通用规则，键名含 name 的字段
  // 整键丢弃——M04 提示词里的 M03 结论因此没有 recommendedFormulaNames/tcmDiseaseName，
  // 「服务端方剂目录编译基准」段恒为「M03 未锁定命名方」，模型写自拟方，随后被组成合同按锁定方驳回、
  // 再跑一轮修复（本机 65 例基线 64 次 M04 里 14 次 formula_reference_declassified，11 次即此）。
  // 路由在用之前已验签，客户端带不进签名域外的键。
  const scrubSignedReasoning = <T>(value: T): T =>
    sanitizeUnknownForModel(value, { patientName, maxStringLength: 12000, preserveSchemaKeys: true });
  const safeHisRecord = state.hisRecord
    ? {
        schemaVersion: state.hisRecord.schemaVersion,
        source: state.hisRecord.source,
        caseId: "deidentified-case",
        updatedAt: "",
        tongueImageUploaded: state.hisRecord.tongueImageUploaded,
        fields: scrubFields(state.hisRecord.fields),
        // The latest clinical supplement is often appended to a long HIS note. Preserve the real
        // tail after PHI scrubbing so semantic triage can still see it; the marker also prevents a
        // projected source from being mistaken for full coverage and signed as complete.
        rawText: scrubHeadTail(state.hisRecord.rawText, 12000) || "",
      }
    : undefined;
  // Build an explicit clinical DTO. Spreading CaseState here would silently forward future UI,
  // audit, revision or persistence fields to an external model before they receive a PHI review.
  return {
    id: "deidentified-case",
    phase: state.phase,
    patient: {
      name: undefined,
      sex: scrub(state.patient.sex, 200),
      age: state.patient.age,
      occupation: generalizeOccupation(state.patient.occupation),
    },
    chiefComplaint: scrub(state.chiefComplaint) || "",
    symptoms: scrubUnknown(state.symptoms) as Record<string, unknown>,
    tongue: scrub(state.tongue),
    pulse: scrub(state.pulse),
    faceNote: scrub(state.faceNote),
    tongueImageDesc: scrub(state.tongueImageDesc),
    tongueDx: state.tongueDx ? scrubUnknown(state.tongueDx, 2000) as typeof state.tongueDx : undefined,
    faceCapture: state.faceCapture ? scrubUnknown(state.faceCapture, 2000) as typeof state.faceCapture : undefined,
    vitals: state.vitals ? scrubUnknown(state.vitals) as Record<string, unknown> : undefined,
    pastHistory: scrub(state.pastHistory),
    medicationHistory: scrub(state.medicationHistory),
    allergyHistory: scrub(state.allergyHistory),
    tcmLineagePreference: scrub(state.tcmLineagePreference, 500),
    // 味数偏好是受控枚举，不含 PHI，原样透传给模型侧。
    herbCountPreference: state.herbCountPreference,
    clinicTreatmentCapabilities: state.clinicTreatmentCapabilities?.slice(0, 24),
    clinicTreatmentCapabilitiesRestricted: state.clinicTreatmentCapabilitiesRestricted,
    hisRecord: safeHisRecord,
    safetyGate: state.safetyGate ? scrubUnknown(state.safetyGate, 2000) as SafetyGate : undefined,
    clinicalFacts: state.clinicalFacts ? scrubUnknown(state.clinicalFacts, 4000) as typeof state.clinicalFacts : undefined,
    completeness: { ...state.completeness },
    questionRounds: state.questionRounds,
    maxQuestionRounds: state.maxQuestionRounds,
    skipDifferentiationGate: state.skipDifferentiationGate,
    conversation: state.conversation
      .slice(-10)
      .map((item) => ({ ...item, content: limitText(scrub(item.content) || "", 2000) || "" })),
    diagnosis: scrub(state.diagnosis, 30000),
    prescription: scrub(state.prescription, 30000),
    riskAssessment: scrub(state.riskAssessment, 30000),
    // A previous result is retained solely for read-only UI continuity. Sending it to the model
    // would contaminate the new run with stale conclusions and defeat the independent rerun.
    previousResult: undefined,
    reasoningDiagnose: state.reasoningDiagnose ? scrubSignedReasoning(state.reasoningDiagnose) : undefined,
    reasoningPrescribe: state.reasoningPrescribe ? scrubSignedReasoning(state.reasoningPrescribe) : undefined,
    reasoningV2: state.reasoningV2 ? scrubSignedReasoning(state.reasoningV2) : undefined,
    safetyLocked: state.safetyLocked,
  };
}

export function sanitizeUnknownForModel<T>(
  value: T,
  opts?: {
    patientName?: string;
    maxStringLength?: number;
    maxDepth?: number;
    /**
     * 只给**服务端签名过的推理载荷**（reasoningDiagnose / reasoningPrescribe / reasoningV2）用：
     * 键名是受治理 schema 的字段名，不是客户端随意带来的键，保留全部键、照常逐值脱敏。
     * 缺省的「键名像身份标识就整键丢弃」对它们是误伤：`/name/i` 把 recommendedFormulaNames、
     * tcmDiseaseName、deferredFormulaSelection.names、药味 name 一并删掉（见 sanitizeCaseStateForModel）。
     */
    preserveSchemaKeys?: boolean;
  },
): T {
  const patientName = opts?.patientName || "";
  const maxStringLength = opts?.maxStringLength ?? 6000;
  const maxDepth = opts?.maxDepth ?? 8;
  return scrubUnknownValue(value, patientName, maxStringLength, maxDepth, 0, Boolean(opts?.preserveSchemaKeys)) as T;
}

function scrubUnknownValue(
  value: unknown,
  patientName: string,
  maxStringLength: number,
  maxDepth: number,
  depth: number,
  preserveSchemaKeys = false,
): unknown {
  if (value == null) return value;
  if (typeof value === "string") return limitModelText(scrubPhi(value, patientName), maxStringLength);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= maxDepth) return "[嵌套内容已截断]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) =>
      scrubUnknownValue(item, patientName, maxStringLength, maxDepth, depth + 1, preserveSchemaKeys)
    );
  }
  if (typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
      const safeKey = scrubPhi(key, patientName)
        .replace(/[\u4e00-\u9fa5]{2,4}(?=(?:病情|症状|主诉|记录|备注|信息|情况))/g, "[已脱敏]");
      const keyLooksIdentifying = !preserveSchemaKeys &&
        /(name|姓名|患者名|联系人|身份证|证件|电话|手机|地址|住址|就诊号|门诊号|住院号|病案号|病历号|病例号|电子病历号|医疗记录号|患者编号|mrn|medical.?record|record.?number|patient.?id)/i.test(key);
      next[safeKey] = keyLooksIdentifying
        ? undefined
        : scrubUnknownValue(item, patientName, maxStringLength, maxDepth, depth + 1, preserveSchemaKeys);
    }
    return next;
  }
  return undefined;
}

function limitModelText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n[内容已按模型上下文预算截断]` : value;
}

function limitModelTextHeadTail(value: string, max: number): string {
  if (value.length <= max) return value;
  const marker = "\n【原始病历中段已按模型上下文预算省略】\n";
  const available = Math.max(2, max - marker.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`;
}

function scrubPhi(text: string, patientName = ""): string {
  text = scrubRecordHeaderName(text, "[已脱敏]");
  // 「本例赵敏既往有高血压」这条原是行内正则、且没有姓氏正向判定，实测吃掉临床文本
  // （本例患儿 / 该患者既往 / 病人自诉）。收敛到共享谓词，见 phi-sanitizer 注释。
  text = scrubSubjectPrefixedName(text, "[已脱敏]");
  // 「家属王强代述病情」同理：原行内规则无姓氏判定，误吃「患者自诉头痛」的同时漏掉「代述/签字」。
  text = scrubRelationPrefixedName(text, "[已脱敏]");
  let next = text;
  if (patientName) next = next.replaceAll(patientName, "[已脱敏]");
  return scrubQuasiIdentifierText(next
    .replace(
      /((?:姓名|患者|家属|联系人|陪同者|监护人)\s*[:：]?\s*)[\u3400-\u9fff]{1,20}[·•][\u3400-\u9fff·•]{1,30}(?=\s*[,，；;。\s]*(?:男|女|\d{1,3}\s*岁|电话|手机|就诊|来诊|入院|出院|诉|称|反映|表示))/g,
      "$1[已脱敏]",
    )
    .replace(/(?:姓名|患者|家属|联系人|陪同者|监护人)\s*[:：]?\s*[A-Z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,30}){1,3}/g, (match) => {
      const label = match.match(/^(姓名|患者|家属|联系人|陪同者|监护人)/)?.[1] || "人员";
      return `${label}：[已脱敏]`;
    })
    .replace(/(^|[；;。\n]\s*)([A-Z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,30}){1,3})(?=\s*(?:昨夜|今日|今晨|近日|近\d|来诊|就诊|入院|出院|自述|反映|称|表示|出现|发生|患|失眠|头痛|头晕|胸痛|腹痛|发热|咳嗽|心悸))/g, "$1[已脱敏]")
    .replace(/(^|[；;。\n]\s*)([A-Z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,30}){1,3})(?=\s*[\u4e00-\u9fa5])/g, "$1[已脱敏]")
    .replace(/姓名\s*[:：]?\s*[^，；。\n]+/g, "姓名：[已脱敏]")



    // 临床字段标签之后的词不是姓名(2026-08-05)。
    //
    // 本分支按「姓氏字 + 1–2 字 + 叙述动词」判姓名。中文病历里这个形态与临床术语大面积撞车:
    // 「主诉：周身出现块状皮疹」的「周身」——周在姓氏表、身是 1 字、出现在动词表——被整体抹成
    // 脱敏标记。20 例线上语料实测 13 例在**送模型之前**就丢了临床事实,而模型看不到的事实,
    // 后面每一层都补不回来:病位判为空、病机链缺节点、西医支持依据只剩半句病历原文。
    //
    // 临床标签保留既有位置语义；裸字段值由共享姓名消歧函数使用受治理术语与有限构词判断。
    // 当前疾病词表已经收载黄疸、干呕，不能再以“没有词表”为由把所有无标签双字姓名放过。
    // 高置信形态一条未动:显式姓名标签、某字名、姓氏+人口学邻接(，男/女/NN岁)、电话/证件/地址。
    // 真实姓名的叙述形态(「张三昨夜失眠」)不带临床标签前缀,仍然照常脱敏(见 test:clinical-grounding)。
    // 前缀组里的「病人/患儿/本例/病例」（2026-10-13）：这四个标签此前只走 scrubSubjectPrefixedName，而它用的是
    // phi-sanitizer 那张较短的姓氏表——「病人经伟有高血压」「病人平芳…」「病人充磊…」三个姓原样留存。
    // 让它们与「患者」一样落到本分支，用同一张姓氏表判；受治理词形照常豁免（病人经常头痛）。
    .replace(/(^|[，,。\s]|[；;](?!\s*$)|(?<!(?:主诉|现病史|既往史|个人史|家族史|婚育史|月经史|过敏史|用药史|四诊|望诊|闻诊|问诊|切诊|症见|刻下|查体|体格检查|舌象|脉象|舌|脉|辅助检查|检查|诊断|治法|治则)\s*)[:：]|患者|病人|患儿|本例|病例|家属|联系人|陪同者|监护人)((?:欧阳|司马|上官|诸葛|[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包左石崔吉龚程邢裴陆荣翁荀羊惠甄曲封芮储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘厉戎祖武符刘景詹束龙叶幸司韶黎乔苍双闻莘党翟谭贡劳姬申扶堵冉宰郦雍却璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧沃利蔚越夔隆师巩厍聂晁勾敖融冷辛阚那简饶空曾沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公肖付闫覃岳兰涂蒙牟卓佟苟隋商丛佘池苑邝官胥栗楚鄢谌粟冼蔺楼仝郜帅屠练漆卿索晋邸敬朴])[\u4e00-\u9fa5]{1,2})(?=(?:近|昨|今|因|诉|称|反映|表示|出现|发生|患|有|于|睡|入睡|失眠|头痛|头晕|胸痛|腹痛|发热|咳嗽|心悸|就诊|来诊))/g, (match, prefix: string, candidate: string, offset: number, whole: string) =>
      // 第四、五个实参是回调的偏移与全文：方义起句「方中有人参」要看候选之后的原文（见 isFormulaReadingOpening）。
      shouldRedactNarrativeNameCandidate(candidate, whole.slice(offset + match.length, offset + match.length + 10))
        ? `${prefix}[已脱敏]` : match)
    // 病历抬头姓名改走**共享**判据（phi-sanitizer.scrubRecordHeaderName）。
    // 原先只有「句首 2-4 字 + 性别/年龄」一个上下文条件，靠一份「不该脱敏的词」黑名单兜底
    // （患者/病人/患儿/本例…，注释记着「线上 20 例语料有 12 例命中」）。黑名单挡不住临床措辞：
    //   「反复咳嗽，男，45岁」→「[已脱敏]，男，45岁」  主诉开头没了
    //   「初诊，女，32岁」「既往体健，男，60岁」同样被吃；「患者男，45岁」连「男」都被吃
    //   （「患者男」是 3 字，不等于黑名单里的「患者」）
    // 这是**送模型路径上的临床信息丢失**，不是显示问题。
    // 共享判据改用「姓氏枚举 ∩ 上下文」正向交集：认得出姓名（含复姓「欧阳明月」，
    // 单字姓枚举覆盖不到），又不误伤临床措辞。实测 6 条非姓名抬头全部保留。
    // 保留原脱敏标记 [已脱敏]，避免无谓改动既有签名载荷。
    .replace(/\b1[3-9]\d{9}\b/g, "[手机号已脱敏]")
    .replace(/\b0\d{2,3}-?\d{7,8}\b/g, "[电话已脱敏]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已脱敏]")
    .replace(/\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, "[证件号已脱敏]")
    .replace(/(身份证号?|证件号?|医保号|社保号|就诊号|门诊号|住院号|病案号|病历号|病例号|病例编号|电子病历号|医疗记录号|患者编号|MRN)\s*#?\s*[:：=]?\s*[A-Za-z0-9][A-Za-z0-9._/#-]{3,}/gi, (_match, label: string) => {
      return `${label}：[已脱敏]`;
    })
    .replace(/(?:住址|地址|家庭住址|工作单位)\s*[:：]?\s*[^，；。\n]+/g, (match) => {
      const label = match.split(/[:：]/)[0] || "地址";
      return `${label}：[已脱敏]`;
    })
    .replace(/(?:出生日期|出生年月|生日)\s*[:：]?\s*\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2}日?)?/g, (match) => {
      const label = match.split(/[:：]/)[0] || "出生日期";
      return `${label}：[已脱敏]`;
    }));
}

export function sanitizeFreeTextForExternalClinicalService(text: string, explicitNames: string[] = []): string {
  let next = text;
  for (const name of explicitNames) {
    const cleaned = name.trim();
    if (cleaned) next = next.replaceAll(cleaned, "[已脱敏]");
  }
  return scrubPhi(next)
    .replace(/<!--\s*DIAGNOSIS_JSON_(?:START|END)\s*-->/gi, "[用户输入结构标记已移除]")
    .replace(/<<<CDSS_STREAM_FINAL>>>/g, "[用户输入流标记已移除]");
}

export function sanitizeFreeTextForModel(text: string): string {
  return sanitizeFreeTextForExternalClinicalService(text);
}

export function markdownNdjsonResponse(markdown: string, observation?: WarningDisplayReceipt): Response {
  const timelineItems = parseStructuredFollowupTimeline(markdown);
  const visibleMarkdown = sanitizeAuthoritativeClinicalOutput(stripStructuredFollowupTimeline(markdown));
  const body = [
    ...(timelineItems.length > 0 ? [JSON.stringify({ type: "followup_timeline", timelineItems })] : []),
    JSON.stringify({ content: visibleMarkdown }),
    ...(observation ? [JSON.stringify({ type: "warning_profile", observation })] : []),
    JSON.stringify({ content: "[END]" }),
    "",
  ].join("\n");
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });
}


/**
 * 仅供回归套件使用。否定作用域是「病历阳性主症被说成已否认」这类临床事实错误的唯一判据，
 * 而它此前只有间接覆盖（经 unknownTermNotice 的产物断言）。直接暴露谓词才能逐例钉住方向。
 */
export const __negationInternalsForTest = { sourceDocumentsNegation } as const;
import { adviceText, joinWarningText, type WarningTextProjection } from "./warning-text-projection";
