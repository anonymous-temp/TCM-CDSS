import type { CaseState, ClinicalReasoningResultV2, ClinicalReviewAttestation, Completeness, HisRecordSnapshot, SafetyGate, SafetyMissingItemCode, StructuredFollowupTimelineItem } from "./diagnosis-types";
import { cdssReasonCodeMarker, type CdssDegradeReasonCode } from "./cdss-reason-codes";
import { sectionTitleGroup } from "./cdss-vocab";
import {
  assessConceptionState,
  assessLactationState,
  assessPregnancyState,
  isKnownClinicalState,
  isUnknownClinicalFieldText,
  isUnknownClinicalText,
  isPositiveOrPossibleClinicalState,
  PULSE_FORCE_PATTERN_SOURCE,
  PULSE_QUALITY_PATTERN_SOURCE,
} from "./clinical-state";
import { inspectionLexiconPattern } from "./tcm-inspection-lexicon";
import { generalizeOccupation, scrubQuasiIdentifierText } from "./phi-sanitizer";
import { determineCompletenessLevel } from "./diagnosis-parse";
import {
  additiveRedFlagsFromFacts,
  groundedPatientTriageCategories,
  priorityEvaluationItemsFromFacts,
  semanticTriageAdvisoriesFromFacts,
  structuredRedFlagEvidenceFromFacts,
  type BackstopRedFlagCategory,
} from "./clinical-facts";
import { affirmedCurrentMedicationText, clinicalEventTemporalScopeAt } from "./clinical-polarity";
import { ensureActionableFollowupSafetyNet } from "./followup-safety-net";
import { buildThreePartLimitedStateCopyForSurface, sanitizeAuthoritativeClinicalOutput } from "./clinical-output-authority";
import { clinicalFieldRequiresExplicitPrescriptionState, clinicalRequiredFieldLabel } from "./clinical-governance-tables";
import { patientSexAllowsDoseLevelSuggestion } from "./clinical-required-fields";
import { activeEmergencyClearanceFindingsFromGate, emergencyClearanceContractIssue } from "./emergency-clearance-contract";
import { sixHealthFollowupTable } from "./tcm-followup-dimensions";
import redflagTriageLexicon from "../data/redflag-triage-lexicon.json" with { type: "json" };

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
const NEURO_DETECTION = governedDetectionNode<{ colloquialFocalSigns: string[] }>("neuro");
const RESPIRATORY_DETECTION = governedDetectionNode<{
  colloquialSymptoms: string[];
  orthopneaColloquial: string[];
  orthopneaBreathingCues: string[];
}>("respiratory");
const SYNCOPE_DETECTION = governedDetectionNode<{ colloquialSymptoms: string[] }>("syncope");
const PEDIATRIC_DETECTION = governedDetectionNode<{ colloquialCriticalSigns: string[] }>("pediatric_critical");
const POISONING_DETECTION = governedDetectionNode<{
  colloquialSymptoms: string[];
  colloquialCompanions: string[];
}>("poisoning");

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
  return state.conversation
    .filter((item) => item.role === "user" && item.content.trim())
    .map((item) => item.content.trim())
    .join("\n");
}

function authoritativeFieldOrFallback(
  state: CaseState,
  key: keyof HisRecordSnapshot["fields"],
  fallback: unknown,
): string {
  const field = fieldText(state, key);
  if (state.hisRecord) return field;
  const userEnteredText = allUserMessages(state);
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

function isKnownTongueClinicalText(value: unknown): boolean {
  return !isUnknownClinicalFieldText(value, "tongue");
}

function isKnownPulseClinicalText(value: unknown): boolean {
  return !isUnknownClinicalFieldText(value, "pulse");
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
    ...flattenClinicalInput(state.vitals).map((value) => `生命体征：${value}`),
    state.pastHistory ? `既往史：${stringifyClinicalValue(state.pastHistory)}` : "",
    state.medicationHistory ? `用药史：${stringifyClinicalValue(state.medicationHistory)}` : "",
    state.allergyHistory ? `过敏史：${stringifyClinicalValue(state.allergyHistory)}` : "",
  ].filter(Boolean);
  const compatibilitySymptoms = currentHis.trim() || userConversationText.trim()
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
export function clinicalGroundingText(state: CaseState): string {
  const authoritative = trustedInputText(state);
  const symptomEntries = flattenClinicalInput(state.symptoms)
    .filter((entry) => typeof entry === "string" && entry.trim())
    .filter((entry) => !authoritative.includes(entry.trim()))
    .filter((entry) => !CLINICAL_NEGATION_FACT_TERMS.some((term) =>
      entry.includes(term) && sourceDocumentsNegation(authoritative, term)));
  if (symptomEntries.length === 0) return authoritative;
  return [authoritative, ...symptomEntries].filter(Boolean).join("\n");
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
  ["意识改变", "意识异常", "意识障碍", "意识不清", "意识模糊", "神志不清", "神志异常", "神志模糊", "神志昏蒙", "不省人事"],
  // 2026-08-13 鲁棒性压测把这一组又推进了一层：**医生按患者口语原样录入**时仍然全线漏检。
  // 实测原句「说话说不清楚，嘴角歪了，一侧手脚没劲，1小时前突然出现」——
  // 线上确定性红旗 0 条、模型语义提示也 0 条，status 只到 needs_information。
  // 这是全系统时间窗最紧的一类急症（溶栓窗），却是零提示。
  // 逐词看漏因很具体：词表有「说话不清」，而口语是「说话说不清楚」（「说话不清」并不连续出现）；
  // 有「口角歪斜」而口语是「嘴角歪了」；有「单侧无力/肢体无力」而口语是「一侧手脚没劲」。
  // 补的是同一批概念的口语面孔，不新增概念、不放宽任何急性/否定判定。
  ["言语不清", "说话不清", "说不清话", "说话说不清", "说话说不清楚", "话说不清", "说话费劲", "说话吐字不清",
    "言语含糊", "口齿不清", "构音不清", "说话含糊", "失语", "不能说话", "不能讲话",
    "言语理解障碍", "语言理解障碍", "言语謇涩", "语言謇涩", "舌强语謇"],
  ["肢体无力", "手脚无力", "单侧无力", "胳膊腿无力", "手臂无力", "上肢无力", "腿无力", "下肢无力",
    "手脚没劲", "胳膊没劲", "腿没劲", "半边没劲", "半边身子没劲", "一侧没劲", "抬不起胳膊", "抬不起腿",
    "肢体活动不利", "肢体不遂", "半身不遂", "偏身不遂", "半身不用"],
  ["口角歪斜", "口眼歪斜", "口眼㖞斜", "口舌歪斜", "嘴角歪", "嘴歪", "嘴巴歪", "脸歪", "面部歪斜"],
  ["偏盲"],
];
const FOCAL_NEUROLOGIC_TERMS = [...new Set(FOCAL_NEUROLOGIC_CONCEPT_GROUPS.flat())];

const POSITIVE_FACT_EQUIVALENT_GROUPS: readonly (readonly string[])[] = [
  ["发热", "发烧", "高热", "低热", "体温升高"],
  ["头痛", "头疼", "脑袋疼", "脑袋痛", "头部疼痛", "偏头痛"],
  // High-risk bleeding concepts must be grounded across ordinary patient phrasing. In particular,
  // Chinese aspect markers split the canonical surface ("没吐过血" does not literally contain
  // "吐血"). Without an explicit concept group, the output scrubber can incorrectly weaken a
  // documented denial into "尚未确认呕血" after the clinical review has already accepted it.
  ["呕血", "吐血", "吐过血", "呕出鲜血", "吐出鲜血", "呕咖啡色液体", "吐咖啡色液体"],
  // clinical-facts.ts 的 OVERT_GI_BLEED_LANGUAGE 早就收了「又黑又亮/黑得发亮/黑亮便/大便像柏油」
  // 这批口语，承重的确定性层反而没有——实测「拉的大便又黑又亮，人发晕」确定性红旗 0 条。
  // 两层的词表必须同源，否则模型层一停，最口语的那批写法就全裸奔。
  ["黑便", "大便发黑", "粪便发黑", "排黑色便", "柏油样便", "又黑又亮", "黑得发亮", "黑亮便",
    "大便像柏油", "大便如柏油", "拉柏油样便"],
  ["便血", "血便", "大便带血", "排便带血", "解血便"],
  ["咯血", "咳血", "咳出血"],
  // 出血组原先只存在于 NEGATED_HYPONYM_TABLE（第三份表）。并入主表后，
  // 阳性展开与否定收窄共用同一份数据。
  ["出血", "流血", "大出血", "大量出血"],
  ["放射痛", "疼痛向下肢放射", "疼痛往腿上窜", "痛往腿上窜", "往腿上窜", "向腿部放射", "向下肢放射", "窜到腿上", "串到腿上"],
  ["咳嗽", "干咳", "有痰咳嗽", "咳痰", "咳个不停", "一直咳"],
  ["呼吸困难", "气促", "气短", "喘憋", "气喘", "喘不上气", "呼吸费力"],
  ["胸痛", "胸口疼", "心前区痛", "胸口压迫", "胸骨后压榨感"],
  ["腹痛", "肚子疼", "肚子痛", "小肚子疼", "小肚子痛", "小腹疼", "小腹痛", "下腹疼", "下腹痛", "上腹疼", "上腹痛", "胃疼", "胃痛", "胃脘疼", "胃脘痛"],
  ["心悸", "心慌", "心跳快", "心跳加速", "心跳乱", "漏跳感"],
  ["胸闷", "胸口发闷", "胸口憋闷", "胸口堵", "胸部压迫感"],
  ["恶心", "反胃", "想吐"],
  ["呕吐", "吐了", "呕出", "吐出"],
  ["便秘", "大便难解", "排便困难", "解不出大便", "排便次数减少"],
  ["失眠", "入睡困难", "难以入睡", "睡眠差", "睡眠障碍"],
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
const NARROWER_THAN_GROUP_CANONICAL: ReadonlySet<string> = new Set([
  // 程度限定
  "高热", "低热", "壮热", "中等度热", "大出血", "大量出血",
  // 具体病名/性状限定
  "偏头痛", "干咳", "有痰咳嗽", "咳痰", "水样便",
  "心前区痛", "胸骨后压榨感", "心跳快", "心跳加速", "心跳乱", "漏跳感",
  // 部位限定
  "单侧无力", "上肢无力", "下肢无力", "腿无力", "手臂无力",
  "小肚子疼", "小肚子痛", "小腹疼", "小腹痛", "下腹疼", "下腹痛",
  "上腹疼", "上腹痛", "胃疼", "胃痛", "胃脘疼", "胃脘痛",
  "鼻痒", "鼻子痒", "眼痒", "眼睛痒", "鼻眼痒", "鼻子眼睛都痒", "皮肤痒", "皮肤瘙痒",
  // 时相限定
  "入睡困难", "难以入睡", "多梦易醒", "醒后再睡困难", "排便次数减少",
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
const CLINICAL_NEGATION_CUE = new RegExp(`(否认|不是(?!${DEGREE_AFTER_NEGATOR})|并非(?!${DEGREE_AFTER_NEGATOR})|不曾|均无|均未见|未见|未诉|未出现|没有|不伴|无明显|无再发|未再发|(?:当前|目前|现阶段|患者|病人)?(?:从未有|未曾有|无)(?=[\\u4e00-\\u9fa5]))`);
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

function sourceDocumentsNegation(source: string, term: string): boolean {
  const normalized = normalizeClinicalText(source);
  // 否定方向只认真同义，不认下位词——「否认高热」不给「否认发热」背书。
  const equivalents = negationGroundingEquivalents(term);
  for (const sentence of normalized.split(/[。；;\n]+/)) {
    for (const equivalent of equivalents) {
      let termIndex = sentence.indexOf(equivalent);
      while (termIndex >= 0) {
        // 「大出血」里含着「出血」两个字。若这次出现整个落在某个**下位词**里，
        // 那么被否认的是那个下位词，不是本词——否则上面的收窄会被子串匹配绕开
        // （实测：病历「否认大出血」→ 输出「病历已记录否认出血」）。
        if (occurrenceIsInsideNarrowerTerm(sentence, termIndex, equivalent.length, term)) {
          termIndex = sentence.indexOf(equivalent, termIndex + equivalent.length);
          continue;
        }
        if (!isExcludedClinicalAssertionAt(sentence, termIndex) && hasImmediateBareNegator(sentence, termIndex)) return true;
        const before = sentence.slice(Math.max(0, termIndex - 24), termIndex);
        const negations = Array.from(before.matchAll(new RegExp(CLINICAL_NEGATION_CUE.source, "g")));
        const nearest = negations.at(-1);
        if (nearest?.index != null) {
          const between = before.slice(nearest.index + nearest[0].length);
          if (!NEGATION_SCOPE_BREAK.test(between) && !NON_SYMPTOM_NEGATION_OBJECT.test(between)) return true;
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

function sourceDocumentsAffirmation(source: string, term: string): boolean {
  const normalized = normalizeClinicalText(source);
  const equivalents = POSITIVE_FACT_EQUIVALENT_GROUPS.find((group) => group.includes(term)) || [term];
  const conceptPatterns = POSITIVE_FACT_EQUIVALENT_PATTERNS.find((item) => item.terms.includes(term))?.patterns || [];
  for (const sentence of normalized.split(/[。；;\n]+/)) {
    for (const equivalent of equivalents) {
      let index = sentence.indexOf(equivalent);
      while (index >= 0) {
        if (
          !isExcludedClinicalAssertionAt(sentence, index) &&
          !hasImmediateBareNegator(sentence, index) &&
          !isNegatedAt(sentence, index) &&
          !/(待核实|待确认|不清楚|未知|不详|未采集|未说明)/.test(sentence)
        ) return true;
        index = sentence.indexOf(equivalent, index + equivalent.length);
      }
    }
    for (const pattern of conceptPatterns) {
      const matches = sentence.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`));
      for (const match of matches) {
        if (match.index != null && !isNegatedAt(sentence, match.index)) return true;
      }
    }
  }
  return false;
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
  return items.every((item) => {
    const index = source.indexOf(item);
    return index >= 0 && isNegatedAt(source, index);
  });
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

function sanitizeUngroundedNegationText(
  value: string,
  source: string,
  /** 抽取模型给出的、已在病历原文中接地的阳性症状名。规则未覆盖时用它核对否认。 */
  extractorAffirmedTerms: readonly string[] = [],
): string {
  const sanitizeClause = (clause: string): string => {
    const negationProbe = clause
      .replace(/无明显(?:诱因|原因|缓解|好转|改善)/g, "")
      // “肢体无力” is a positive neurologic symptom. The lexical “无” is part of the symptom name,
      // not a negation cue; masking it here prevents the output scrubber from rewriting a grounded
      // post-stroke fact into the synthetic sentence “病历已记录肢体无力阳性”.
      .replace(/肢体无力/g, "肢体乏力");
    const prefix = clause.match(/^(\s*(?:[-*]>?\s*|>\s*|#{1,6}\s*)?(?:[^：:|]{1,24}[：:]\s*)?)/)?.[1] || "";
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
      if (contradicted.length > 0) {
        return `${prefix}病历尚未确认${contradicted.join("、")}是否已排除；病历已记录该表现存在，请医生核对后再采纳`;
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
        sourceDocumentsAffirmation(source, term),
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
      const documentedPositive = mentioned.filter((term) => sourceDocumentsAffirmation(source, term));
      // 每个词只出一句。documentedDenialNotice 已经把「只否认了下位词」这种情形
      // 说成「病历已记录否认<变体>，<term>的一般情况需医生核实」，
      // 若再让它落进 stillUnknown 走一遍 unknownTermNotice，同一句会印两遍。
      const denial = documentedDenialNotices(source, mentioned.filter((term) => !documentedPositive.includes(term)));
      const documentedNegativeNotices = denial.notices;
      const stillUnknown = mentioned.filter((term) => !documentedPositive.includes(term) && !denial.covered.has(term));
      if (documentedPositive.length > 0 || documentedNegativeNotices.length > 0) {
        return `${prefix}${[
          documentedPositive.length > 0 ? `病历已记录${documentedPositive.join("、")}阳性` : "",
          documentedNegativeNotices.join("；"),
          stillUnknown.length > 0 ? unknownTermNotice(source, stillUnknown) : "",
        ].filter(Boolean).join("；")}`;
      }
    }
    if (CLINICAL_NEGATION_CUE.test(negationProbe)) {
      const contradictedPositive = CLINICAL_NEGATION_FACT_TERMS.filter(
        (term) => clause.includes(term) && sourceDocumentsAffirmation(source, term),
      );
      const unknown = CLINICAL_NEGATION_FACT_TERMS.filter(
        (term) => clause.includes(term) &&
          !sourceDocumentsNegation(source, term) &&
          !sourceDocumentsAffirmation(source, term),
      );
      if (contradictedPositive.length > 0 || unknown.length > 0) {
        const supportedNotices = documentedDenialNotices(
          source,
          CLINICAL_NEGATION_FACT_TERMS.filter((term) => clause.includes(term) && !unknown.includes(term)),
        ).notices;
        return `${prefix}${[
          contradictedPositive.length > 0 ? `病历已记录${contradictedPositive.join("、")}阳性` : "",
          supportedNotices.join("；"),
          unknown.length > 0 ? unknownTermNotice(source, unknown) : "",
        ].filter(Boolean).join("；")}`;
      }
    }
    const unsupportedNormality = CLINICAL_NORMALITY_TERMS.filter(
      (term) => clause.includes(term) &&
        /(正常|未见(?:明显)?异常|无(?:明显)?异常|阴性|未升高|参考范围内|功能良好)/.test(clause) &&
        !sourceDocumentsCurrentNormality(source, term),
    );
    if (unsupportedNormality.length > 0) {
      return `${prefix}相关检查结果以本次病历记录为准`;
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
  const scoped = value.replace(/[，,](?=(?:但|而|仍|却|同时|另有|随后|继而|突发|新发|出现|伴有))/g, "；");
  let sanitized = scoped.split("\n").map((line) => {
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      return line.split("|").map((cell) => cell.replace(/[^。；;，]+/g, sanitizeClause)).join("|");
    }
    // 子句边界必须含逗号。只按句号/分号切时，「热邪炽盛，未见黑便，未见呕血，热盛迫津」
    // 是**一个**子句，否定分支命中后整句被术语列表替换，「热邪炽盛」「热盛迫津」一并丢失——
    // 净化器越权删掉了它本不该动的、已接地的临床结论。
    // 含逗号后同一输入变为：「热邪炽盛，病历尚未确认黑便是否存在，病历尚未确认呕血是否存在，热盛迫津」
    // 未接地否定照样被净化（安全要求不变），真实病机保住。
    return line.replace(/[^。；;，]+/g, sanitizeClause);
  }).join("\n");
  sanitized = reconcileSyntheticPolarityContradictions(sanitized, source);
  if (!sourceHasKnownTongue(source)) {
    // 识别面与改写面必须认同一批词。少了受控词表这一半，病历里没有舌象、模型却编出
    // 「舌体颤动」「络脉青紫」时，净化器认不出来、原样放行——一条无据的舌象就这么进了结论。
    sanitized = sanitized
      .replace(/舌(?:质)?(?:淡|红|绛|紫|暗|胖|瘦|嫩|老|裂|齿痕|边红|尖红)[^，。；;\n|]{0,24}|苔(?:薄|厚|白|黄|腻|燥|润|剥|少|无)/g, "舌象待核实")
      .replace(new RegExp(inspectionLexiconPattern("tongue").source, "g"), "舌象待核实");
  }
  if (!sourceHasKnownPulse(source)) {
    sanitized = sanitized
      .replace(new RegExp(`脉(?:${PULSE_QUALITY_PATTERN_SOURCE}){1,4}(?:${PULSE_FORCE_PATTERN_SOURCE})?`, "g"), "脉象待核实")
      .replace(new RegExp(inspectionLexiconPattern("pulse").source, "g"), "脉象待核实");
  }
  return sanitized;
}

function normalizedAgeLiteral(value: unknown): string {
  return String(value ?? "").trim().replace(/\s*岁$/, "");
}

function sanitizeAgeClaimText(value: string, state: CaseState): string {
  const patientAge = normalizedAgeLiteral(state.patient.age);
  const hisAge = normalizedAgeLiteral(state.hisRecord?.fields?.age);
  const conflict = Boolean(patientAge && hisAge && patientAge !== hisAge);
  const authoritativeAge = hisAge || patientAge;
  if (!authoritativeAge && !conflict) return value;
  return value.replace(
    /(?:具体)?年龄(?:信息)?(?:未提供|未记录|未录入|不详|未知|待核实|待确认|需补录)/g,
    conflict ? "年龄记录存在冲突，需医生核实" : `年龄已记录为${authoritativeAge}岁`,
  );
}

const FEMALE_ONLY_CLINICAL_CONTEXT = /(月经|经期|妊娠|孕产|孕妇|孕期|哺乳|备孕女性|女性[^。；，,]{0,8}备孕)/;
const DEDUPLICATED_CLINICAL_LIST_FIELDS = new Set(["limitations", "suggestedChecks", "mustCollect"]);

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
        const visit = (value: unknown, key = "", parentKey = ""): unknown => {
          // Identity labels are not patient assertions. They have already passed the stage contract;
          // running negation prose replacement over them can turn a valid diagnosis name into a
          // sentence such as "病历已记录头痛阳性" and break the signed result after validation.
          if (typeof value === "string" && key === "name") return value;
          // 已删除 nonPharma.monitoring 的净化豁免。该豁免不是安全控制，而是对本净化器的**豁免**：
          // 它存在的唯一理由是重写 trigger 的条件/动作措辞会破坏 monitoring 的语义合同，让 M04
          // 合同拒掉服务端自己净化过的输出。语义合同（5 个 monitoring_* 驳回码）已随字段一并删除，
          // 继任字段 precautions 没有任何语义合同，因此恢复默认净化更安全：净化器只重写带否定/
          // 未知线索的从句（「否认X」「尚未确认X是否存在」），条件句「如出现黑便应立即就医」不触发
          // 任何分支；即便被改写也只是文案变形，不会造成任何驳回。
          if (typeof value === "string") {
            // Exact source facts have already crossed the structured grounding contract. Rewriting
            // them as explanatory prose can corrupt mixed-polarity records: for example, the exact
            // quote “否认突发最剧烈头痛” was expanded into both “头痛阳性” and “否认头痛”, making
            // the post-review contract reject its own grounded projection. Preserve exact chart
            // substrings in provenance-bearing fact fields; unsupported/provider-invented values
            // still flow through the sanitizer and remain fail-closed.
            if (
              ["supportingFacts", "primarySyndromeBasis", "patientFact", "syndromeEvidence"].includes(key) &&
              value.trim().length >= 2 &&
              source.includes(value.trim())
            ) {
              return value;
            }
            const sanitized = sanitizePatientApplicableText(sanitizeAgeClaimText(sanitizeUngroundedNegationText(value, source, extractorAffirmedTerms), state), state);
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
            const visited = value.map((item) => visit(item, key, key));
            if (key === "uncertainties") return visited.filter((item) => item !== undefined);
            return DEDUPLICATED_CLINICAL_LIST_FIELDS.has(key)
              ? deduplicateClinicalListItems(visited.filter((item) => typeof item !== "string" || Boolean(item.trim())))
              : visited;
          }
          if (!value || typeof value !== "object") return value;
          const visited = Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([childKey, raw]) => [childKey, visit(raw, childKey, key)]),
          );
          if (key === "uncertainties") {
            const row = visited as { item?: unknown; reason?: unknown; affects?: unknown };
            if ([row.item, row.reason, row.affects].some((item) => typeof item !== "string" || !item.trim())) return undefined;
          }
          return visited;
        };
        sanitizedBlock = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(visit(JSON.parse(jsonText)), null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
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
  const sanitizedNarrative = sanitizePatientApplicableText(sanitizeAgeClaimText(sanitizeUngroundedNegationText(placeholderContent, source, extractorAffirmedTerms), state), state);
  return sanitizedNarrative.replace(/__TCM_CDSS_JSON_BLOCK_(\d+)__/g, (_, index: string) => jsonBlocks[Number(index)] || "");
}

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
  const normalized = normalizeClinicalText(text);
  const measurements: BloodPressureMeasurement[] = [];
  for (const match of normalized.matchAll(contextualBloodPressurePattern())) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (!Number.isFinite(first) || !Number.isFinite(second)) continue;
    const index = (match.index ?? 0) + Math.max(0, match[0].lastIndexOf(match[1]));
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
    // Only an extreme value is eligible for the deterministic emergency fast path. Severe but
    // non-extreme hypertension requires repeat measurement plus symptom/target-organ assessment;
    // that contextual triage belongs to the semantic layer.
    if (Math.max(first, second) >= 220 || Math.min(first, second) >= 130 || Math.min(first, second) <= 45) {
      return { first, second };
    }
  }
  return null;
}

function bloodPressureIsCritical(bp: { systolic: number; diastolic: number } | null): boolean {
  return Boolean(bp && (bp.systolic >= 220 || bp.diastolic >= 130 || bp.systolic <= 80 || bp.diastolic <= 45));
}

// Accepts "38.9℃", "38.9度", the Chinese decimal idiom "38度9" (=38.9), and full-width input.
function parseTemperature(text: string): number | null {
  const t = normalizeClinicalText(text);
  // "38度9" / "38度9分" → 38.9 (度 as a decimal separator, 分 = tenth-of-a-degree). But a trailing digit
  // that begins a duration/count word ("39度2小时后复测", "38度9天") is NOT a decimal, so exclude those
  // units to avoid fabricating a temperature that could trip a red flag.
  const decimalDu = t.match(/(?<!\d)(4[0-5]|3\d)度(\d)(?!\d)(?!\s*(?:天|次|日|周|月|年|岁|小时|分钟|秒|时|点|余|多|回|下|个|号))/);
  if (decimalDu) return Number(`${decimalDu[1]}.${decimalDu[2]}`);
  const labeled = t.match(/(?:^|[^A-Za-z])(?:T|体温)["']?\s*[:：]?\s*["']?\s*(4[0-5]|3\d)(?:[.](\d))?/i);
  if (labeled) return Number(labeled[2] ? `${labeled[1]}.${labeled[2]}` : labeled[1]);
  const standalone = t.match(/(?<!\d)(4[0-5]|3\d)(?:[.](\d))?\s*(?:℃|°C|度)/i);
  if (standalone) return Number(standalone[2] ? `${standalone[1]}.${standalone[2]}` : standalone[1]);
  return null;
}

function parsePulse(text: string): number | null {
  const match = normalizeClinicalText(text).match(/(?:^|[^A-Za-z])(?:P|HR|心率|脉搏)["']?\s*[:：]?\s*["']?\s*(\d{2,3})\s*(?:次\/分|次每分|bpm)?/i);
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
  for (const match of normalized.matchAll(/(?:^|[^A-Za-z])(?:P|HR|心率|脉搏)["']?\s*[:：]?\s*["']?\s*(\d+(?:\.\d+)?)\s*(?:次\/分|次每分|bpm)?/gi)) {
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
  toNumber: (match: RegExpMatchArray) => number | null,
  isAbnormal: (value: number) => boolean,
): number | null {
  const normalized = normalizeClinicalText(text);
  let fallback: number | null = null;
  for (const match of normalized.matchAll(pattern)) {
    const value = toNumber(match);
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

function parseContextualTemperature(text: string): number | null {
  return parseContextualNumber(
    text,
    /(?:(?:^|[^A-Za-z])(?:T|体温)["']?\s*[:：]?\s*["']?\s*)?(4[0-5]|3\d)(?:(?:[.](\d))|(?:度(\d)))?\s*(?:℃|°C|度)?/gi,
    (match) => {
      if (!/(?:T|体温|℃|°C|度)/i.test(match[0])) return null;
      const decimal = match[2] || match[3];
      return Number(decimal ? `${match[1]}.${decimal}` : match[1]);
    },
    (value) => value >= 39 || value < 36,
  );
}

function parseContextualPulse(text: string): number | null {
  return parseContextualNumber(
    text,
    /(?:^|[^A-Za-z])(?:P|HR|心率|脉搏)["']?\s*[:：]?\s*["']?\s*(\d{2,3})\s*(?:次\/分|次每分|bpm)?/gi,
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

function parseContextualBloodPressure(text: string): { systolic: number; diastolic: number } | null {
  const normalized = normalizeClinicalText(text);
  let fallback: { systolic: number; diastolic: number } | null = null;
  for (const measurement of bloodPressureMeasurements(normalized)) {
    const { systolic, diastolic } = measurement;
    if (!Number.isFinite(systolic) || !Number.isFinite(diastolic) || systolic <= diastolic) continue;
    if (isExcludedClinicalAssertionAt(normalized, measurement.index) || isHistoricalOrResolvedAt(normalized, measurement.index)) continue;
    const bp = { systolic, diastolic };
    if (!fallback) fallback = bp;
    if (bloodPressureIsCritical(bp)) return bp;
  }
  return fallback;
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
export function currentVitalMeasurements(state: CaseState): CurrentVitalMeasurements {
  const structuredText = vitalsText(state);
  const narrativeText = trustedInputText(state);
  const structuredBloodPressure = parseContextualBloodPressure(structuredText);
  const narrativeBloodPressure = parseContextualBloodPressure(narrativeText);
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
      (value) => value >= 120 || value < 50,
    ),
    respiration: preferAbnormalNumber(
      parseContextualRespiration(structuredText),
      parseContextualRespiration(narrativeText),
      (value) => value >= 25 || value < 8,
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
const NEGATION_PATTERN = new RegExp(`(否认|不是(?!${DEGREE_AFTER_NEGATOR})|并非(?!${DEGREE_AFTER_NEGATOR})|不曾|无|未见|未发现|未诊断|未患|没有|没(?!有什么|关系|问题|事|错|完|意思|办法|时间|空|钱|人|影|底|数|辙|门|胃口|精神|力气|劲儿|劲|趣)|未诉|无诉|未主诉|未出现|未发生|未有|未曾|未再发|无再发|从未|从无|没有过|不伴|已缓解|已消失|排除)`, "g");
const NON_NEGATING_PHRASES = /(无明显诱因|无诱因|无缓解|无好转|无改善|没缓解|没好转|没改善|没消失|无规律|无特殊处理|未予处理|未治疗)/g;

function containsNegation(value: string): boolean {
  NEGATION_PATTERN.lastIndex = 0;
  const result = NEGATION_PATTERN.test(value);
  NEGATION_PATTERN.lastIndex = 0;
  return result;
}

type ClinicalAssertionSubject = "patient" | "non_patient";
type ClinicalAssertionMood = "actual" | "conditional";
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
  return context.subject === "non_patient" || context.mood === "conditional";
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

function isNegatedAt(text: string, index: number): boolean {
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
  if (last[0] === "排除") {
    const beforeNegation = before.slice(Math.max(0, (last.index ?? 0) - 8), last.index ?? 0);
    if (/(无法|不能|不可|尚未|未能|难以|需|待|仍需)/.test(beforeNegation)) return false;
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
      const afterTerm = text.slice(index, index + 24).replace(/^[^一-龥]*/, "");
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
    /^(?:约|已|持续|反复)?\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半数多几]+)\s*(?:次|分钟|分|小时|天|日|周|月|ml|mL|毫升)/.test(after) ||
    /^(?:后|伴有?|并|且|持续|反复|加重|发作|导致|致|继而|随后)/.test(after);
}

function hasTerm(text: string, term: string): boolean {
  let index = text.indexOf(term);
  while (index !== -1) {
    if (isExcludedClinicalAssertionAt(text, index)) {
      index = text.indexOf(term, index + term.length);
      continue;
    }
    const after = text.slice(index + term.length, index + term.length + 44);
    const postPersistentCue = /^(?:、|，|,|及|和|与|或)?[^。；;\n]{0,18}(?:没有|无|未见|未|尚未|并未).{0,8}(?:缓解|好转|改善)/.test(after);
    // 只有“均/皆/都”这类量化词才合法地回指前面的症状列表（“黑便、呕血、便血均无”），才允许较宽间隔。
    const postCollectiveNegated = /^(?:、|，|,|及|和|与|或)?[^。；;\n]{0,18}(?:均无|均未见|均否认|皆无|皆未见|皆否认|都无|都未见|都没有)/.test(after);
    // 顿号并列清单后接裸否定（“黑便、呕血、便血无”）：仅当间隔全为顿号并列项、不含逗号/数字时才算集合否定。
    const postListNegated = /^、[^。；;，,\d\n]{0,16}(?:无|未见|没有|否认|阴性)/.test(after);
    // 裸“无/否认/未见/已缓解”只有紧贴症状词时才是对它本身的否定（“黑便无”“黑便：否认”“黑便已缓解”）。
    // fail-closed 关键修复：不得跨过逗号/数字进入下一分句——“黑便3天，无腹痛”里的“无”否定的是腹痛，
    // 绝不能因此把作为红旗的“黑便”判为阴性而漏报消化道出血（其余晕厥/便血/呕血/肢体无力/寒战同理）。
    const postDirectNegated = /^[：:（(【\[\s]{0,4}(?:无|未见|没有|否认|阴性|未再发|无再发|已缓解|已消失)/.test(after);
    const postExplicitNegated = /^(?:(?:一|二|两|三|四|五|六|七|八|九|十|数|多|几)?次\s*)?(?:也|均|都)?\s*(?:并|且)?\s*(?:未|没有|无|未见|未出现|未发生|并未|且未|也未|也没有)(?:出现|发生|发作|再发|过)?/.test(after);
    const postNegated = !postPersistentCue && (postCollectiveNegated || postListNegated || postDirectNegated || postExplicitNegated);
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
      const affirmed = !isNegatedAt(normalized, index) || hasCommaSeparatedPositiveEvidence(normalized, index, term);
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
        const localClause = normalized.slice(Math.max(clauseStart, index - 24), Math.min(clauseEnd, index + term.length + 48));
        const priority =
          GOVERNED_ACUTE_ONSET_TERMS.some((cue) => localClause.includes(cue)) ||
          /(?:快速|明显|很快|迅速|持续|进行性|越来越)[^，,。；;\n]{0,4}加重|(?:仍|一直|反复)?持续(?:存在|不缓解)?|(?:未|无|没有|尚未)(?:见)?(?:缓解|好转|改善)/.test(localClause);
        if (priority) return true;
      }
    }
  }
  return false;
}

function hasAcuteAbdominalSignal(text: string): boolean {
  // 腹膜刺激征的口语表达（“按下去松手更疼”=反跳痛）与“肚子疼”类口语主诉必须覆盖；
  // 松手后“不疼”的否定式描述不命中（间隔字符排除不/无/未）。
  const severe = governedTermAlternation(GOVERNED_SEVERE_TERMS);
  const symptoms = abdominalSymptomAlternation();
  return hasAnyTerm(text, ["急腹痛", "腹膜刺激征", ...GOVERNED_PERITONEAL_SIGNS]) ||
    // 症状短语自带重度性质词（上腹剧痛/右下腹剧痛/脘腹剧烈疼痛/少腹急痛/腹部绞痛）
    hasPatternWithoutNegation(text, new RegExp(ABDOMINAL_SEVERE_PAIN_COMPOSITION)) ||
    hasPatternWithoutNegation(text, new RegExp(
      `(?:${symptoms})[^。；;\\n]{0,16}(?:疼得厉害|痛得厉害|挺不住|无法忍受|明显加重|快速加重|迅速加重|越来越重)|` +
      `(?:疼得厉害|痛得厉害|挺不住|无法忍受|明显加重|快速加重|迅速加重|越来越重)[^。；;\\n]{0,16}(?:${symptoms})`,
    )) ||
    hasPatternWithoutNegation(text, /(?:松手|放手|抬手|松开)(?:时|后)?[^，,。；;\n不无未]{0,4}(?:更|最|特别)?(?:疼|痛)/) ||
    hasPatternWithoutNegation(text, new RegExp(
      `(?:${severe})[^。；;\\n]{0,12}(?:${symptoms}|全腹[^。；;\\n]{0,4}痛)|` +
      `(?:${symptoms}|全腹[^。；;\\n]{0,4}痛)[^。；;\\n无未不否没]{0,12}(?:${severe})`,
    ));
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
function hasUpperGiAlarmFeatureSignal(text: string): boolean {
  // A
  if (hasPatternWithoutNegation(text, new RegExp(governedTermAlternation(GOVERNED_GI_ALARM.symptoms)))) return true;
  // B
  const progression = `${governedTermAlternation(GI_ALARM_DETECTION.progressionCues)}|\\d+\\s*(?:个)?(?:月|年|周)`;
  if (hasPatternWithoutNegation(text, new RegExp(
    `进食困难[^。；;\\n]{0,20}(?:${progression})|(?:${progression})[^。；;\\n]{0,20}进食困难`,
  ))) return true;
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
  const GI_CANCER = governedTermAlternation(GI_ALARM_DETECTION.gastrointestinalMalignancy);
  const digestive = governedTermAlternation(GI_ALARM_DETECTION.currentDigestiveSymptoms);
  const alarmDigestive = governedTermAlternation(GI_ALARM_DETECTION.alarmDigestiveFindings);
  if (hasPatientHistoryTermWithoutNegation(text, new RegExp(GI_CANCER))
    && hasPatternWithoutNegation(text, new RegExp(digestive))) return true;
  if (hasPatientHistoryTermWithoutNegation(text, new RegExp(CANCER))
    && hasPatientHistoryTermWithoutNegation(text, new RegExp(alarmDigestive))) return true;
  // D
  const weightLossCue = governedTermAlternation(GI_ALARM_DETECTION.unexplainedWeightLossCues);
  const weightLoss = governedTermAlternation(GI_ALARM_DETECTION.weightLossTerms);
  if (hasPatternWithoutNegation(text, new RegExp(
    `(?:${weightLossCue})[^。；;\\n]{0,8}(?:${weightLoss})`
    + `|(?:${weightLoss})[^。；;\\n]{0,10}\\d+\\s*(?:kg|公斤|斤|千克)`,
  ))) return true;
  return false;
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
const CATASTROPHIC_NEUROLOGIC_EVENT_PATTERN = /(?:昏迷|呼之不应|抽搐|惊厥|癫痫持续状态)/;
const ACUTE_CONSCIOUSNESS_CHANGE_TERMS = ["昏睡", "嗜睡", "谵妄"];

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

function hasStablePostAcuteNeurologicContext(text: string): boolean {
  const normalized = normalizeClinicalText(text);
  const hasEstablishedNeurologicEvent =
    /(?:脑梗死|脑卒中|中风|脑出血|TIA|短暂性脑缺血发作|颅脑损伤|神经损伤)[^。；;\n]{0,28}(?:后|恢复期|康复期|后遗)/i.test(normalized) ||
    /(?:脑梗死|脑卒中|脑出血|中风|TIA|短暂性脑缺血发作)(?:恢复期|康复期|后遗症)/i.test(normalized) ||
    /(?:脑梗死|脑卒中|中风|脑出血|TIA|短暂性脑缺血发作)[^。；;\n]{0,32}(?:遗留|残留)[^。；;\n]{0,20}(?:无力|麻木|言语不清|口角歪斜|步态异常)/i.test(normalized) ||
    // 病案常把确诊与结局拆成相邻两句：“脑 CT 示脑梗死。经治疗后遗留……”。
    // 句号不能让同一次事件的明确治疗后遗症重新变成“当前起病不明”的急症。
    /(?:脑梗死|脑卒中|中风|脑出血|TIA|短暂性脑缺血发作)[^。；;\n]{0,16}[。；;]\s*(?:经|已)?(?:抢救|治疗|手术|康复|出院)[^。；;\n]{0,16}(?:后)?(?:后遗|遗留|残留)/i.test(normalized);
  const hasNonAcuteCourse =
    /(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:周|个月|月|年)/.test(normalized);
  const hasCurrentStability =
    /(?:出院后|治疗后|恢复期|康复期|目前|当前|近(?:期|来|\d+个月|[一二两三四五六七八九十]+个月))[^。；;\n]{0,40}(?:病情稳定|稳定|逐渐改善|逐步恢复|无新发|未再发|无再发|无加重)/.test(normalized) ||
    /(?:病情稳定|恢复平稳|康复调理)[^。；;\n]{0,36}(?:无新发|未再发|无再发|无加重)?/.test(normalized);
  const explicitResidualBaseline = /(?:后遗|遗留|残留)[^。；;\n]{0,28}(?:无力|麻木|言语不清|口角歪斜|步态异常)/.test(normalized);
  const acuteChange = /(?:刚刚|刚才|今日|今天|今晨|新发|突发|突然|再发|(?<!反)复发|快速加重|明显加重|恶化)[^。；;\n]{0,28}(?:无力|麻木|言语不清|口角歪斜|步态异常)|(?:无力|麻木|言语不清|口角歪斜|步态异常)[^。；;\n]{0,20}(?:新发|再发|加重|恶化)/.test(normalized);
  return hasEstablishedNeurologicEvent && hasNonAcuteCourse && (hasCurrentStability || (explicitResidualBaseline && !acuteChange));
}

// 神经事件锚点与残留/急性线索（类别级，不含个案关键词）：用于区分「陈旧卒中残留/后遗症期」与
// 「旧卒中基础上的新发急性加重」。残留框架本身不是否定词，只是把时间轴限定为慢性基线；
// 一旦同一小句出现急性变化线索（突发/新发/再发/加重…），必须重新视为当前急症（fail-closed）。
const NEURO_EVENT_ANCHOR_SOURCE = String.raw`(?:脑梗(?:死|塞)?|脑卒中|卒中|中风|脑出血|脑溢血|脑血栓|脑栓塞|TIA|短暂性脑缺血发作|颅脑损伤|脑外伤|脑部手术|偏瘫)`;
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

// 判断局灶神经缺损是否附着急性变化线索：同小句内的起病/变化词、前一小句句尾的起病短语
// （“今晨突发，右侧肢体无力”），或紧随其后小句句首的变化动词（“遗留右侧肢体无力，近2日加重”）。
function neuroAcuteChangeAttachedAt(text: string, index: number, matchText: string): boolean {
  const { start, end } = clinicalSubClauseBoundsAt(text, index, matchText.length);
  NEURO_ACUTE_ANY_CUE_PATTERN.lastIndex = 0;
  for (const match of text.slice(start, end).matchAll(NEURO_ACUTE_ANY_CUE_PATTERN)) {
    const cueIndex = start + (match.index ?? 0);
    if (cueIndex >= index && cueIndex < index + matchText.length) continue;
    const isChangeVerb = NEURO_ACUTE_CHANGE_ONLY_PATTERN.test(match[0]);
    if (neuroAcuteCueUsableAt(text, cueIndex, match[0], index, isChangeVerb)) return true;
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
        neuroAcuteCueUsableAt(text, nextStart + changeAtHead[0].length - changeAtHead[1].length, changeAtHead[1], index, true)) return true;
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
      const residualFraming = !acuteChangeAttached && neuroResidualFramingAt(normalized, index, term);
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
function cardiacAcuteChangeAttachedAt(text: string, index: number, matchText: string): boolean {
  const { start, end } = clinicalSubClauseBoundsAt(text, index, matchText.length);
  CARDIAC_ACUTE_ANY_CUE_PATTERN.lastIndex = 0;
  for (const match of text.slice(start, end).matchAll(CARDIAC_ACUTE_ANY_CUE_PATTERN)) {
    const cueIndex = start + (match.index ?? 0);
    if (cueIndex >= index && cueIndex < index + matchText.length) continue;
    const isChangeVerb = CARDIAC_ACUTE_CHANGE_ONLY_PATTERN.test(match[0]);
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
  );
  while (index >= 0) {
    if (
      !isExcludedClinicalAssertionAt(normalized, index) &&
      (!isNegatedAt(normalized, index) || hasCommaSeparatedPositiveEvidence(normalized, index, term)) &&
      !isHistoricalOrResolvedAt(normalized, index, term.length)
    ) {
      if (cardiacAcuteChangeAttachedAt(normalized, index, term)) return true;
      const { start, end } = clinicalSubClauseBoundsAt(normalized, index, term.length);
      if (scopedCue.test(normalized.slice(start, end).replace(NON_NEGATING_PHRASES, ""))) return true;
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
  for (const term of ["胸痛", "心前区痛", "胸闷"]) {
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
        !sensoryDeficitIsChronicPeripheralAt(normalized, unilateralSensoryMatch.index, unilateralSensoryMatch.text)));
  if (stablePostAcuteCourse) {
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
    const before = text.slice(Math.max(0, match.index - 12), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 12);
    return !/(?:需|需要|待|尚待|未问|未询问|不详|未知|待核实)[^。；;\n]{0,10}$/.test(before) &&
      !/^(?:不详|未知|待核实|待询问)/.test(after);
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

export function detectProgrammaticRedFlags(state: CaseState): string[] {
  const text = trustedInputText(state);
  const redFlags: string[] = [];
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
    .some((clause) => hasPatternWithoutNegation(
      clause,
      new RegExp(`(?:再次|再发|复发)[^。；;\\n]{0,12}(?:${bleedTerms})`),
    ));
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
        return !/(?:否认|无|未见|未|没有|不伴|排除)/.test(text.slice(segmentStart, at));
      });
      if (!affirmedCompanion) continue;
      return true;
    }
    return false;
  })();
  const activeGiBleedingSignal =
    recurrentGiBleedingSignal || combinedUpperAndLowerGiBleedingSignal ||
    hasCoffeeGroundEmesis(text) || bleedSeverityAffirmed ||
    // 「大量/反复/喷射…」是修饰出血词本身的限定语，仍走原口径。
    hasPatternWithoutNegation(text, new RegExp(
      `(?:大量|反复|多次|再次|再发|复发|喷射|不止|持续出血)[^。；;\\n]{0,16}(?:${bleedTerms})`,
    ));
  const activeObstetricHemorrhageSignal =
    hasPatternWithoutNegation(text, /(?:孕|妊娠|怀孕)[^。；;\n]{0,40}(?:大量|大出血|持续|反复|鲜红色|血块|浸湿)[^。；;\n]{0,12}(?:阴道)?(?:出血|流血)/) ||
    hasPatternWithoutNegation(text, /(?:阴道)?(?:出血|流血)[^。；;\n]{0,30}(?:大量|大出血|持续|反复|鲜红色|血块|浸湿)[^。；;\n]{0,30}(?:孕|妊娠|怀孕)/);
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
  const bleedingCompanionAffirmed = GOVERNED_BLEEDING_COMPANIONS.some((term) =>
    hasPatternWithoutNegation(text, new RegExp(term)));
  const activeMajorVaginalBleedingSignal = vaginalBleedingAffirmed &&
    (governedMajorVaginalBleedingAffirmed || severityNearVaginalBleeding || criticalHemoglobin || bleedingCompanionAffirmed);
  const cardiacRiskFlagged = !cardiacClearanceApplies && (acuteChestPainSignal || (chestPainSignal && cardiacCompanion) || acuteChestTightnessSignal || (chestTightnessSignal && cardiacCompanion));
  const reportableCardiacRisk = cardiacRiskFlagged;
  if (reportableCardiacRisk) {
    redFlags.push(((acuteChestTightnessSignal || chestTightnessSignal) && cardiacCompanion) || (chestPainSignal && cardiacCompanion)
      ? "胸痛/胸闷伴大汗、放射痛或气促，需排除急性心血管事件"
      : acuteChestTightnessSignal
        ? "急性或加重胸闷已出现，需先排除急性冠脉综合征等心血管风险"
      : "短时程、新发、突发或持续胸痛/心前区痛已出现，即使暂未记录伴随症状，也需先排除急性心血管事件");
  }
  if (hasPatternWithoutNegation(text, /(?:突发|突然|雷击|爆炸).{0,8}头痛/) || hasNeurologicEmergencySignal(text)) {
    redFlags.push("突发剧烈头痛、意识或神经功能异常，需优先排除神经系统急症");
  }
  if (acuteAbdominalSignal) {
    redFlags.push("急性、突发或剧烈腹痛/腹胀已出现，需先排除急腹症等风险");
  }
  if (anaphylacticAirwaySignal) {
    redFlags.push("急性过敏反应伴喉头或上气道肿胀线索，需立即评估气道、呼吸和循环并急诊处置");
  }
  if (activeGiBleedingSignal) {
    redFlags.push("当前呕血、咖啡样呕吐物、黑便或便血提示活动性消化道出血风险，需立即评估循环状态并急诊处置");
  }
  // 上气道水肿场景下的「吞咽困难」已由过敏红旗完整承接，不再重复成第二条告警；
  // 出血已单独成条时也不叠加——同一事件两条告警会让医生开始忽略告警本身。
  if (hasUpperGiAlarmFeatureSignal(text) && !anaphylacticAirwaySignal) {
    redFlags.push("上消化道警示征象（吞咽/进食梗阻、恶性肿瘤病史伴消化道症状、或不明原因体重下降）已出现，需优先安排内镜或影像评估以排除梗阻、复发与占位，再评估处方");
  }
  if (activeObstetricHemorrhageSignal) {
    redFlags.push("妊娠期活动性大量阴道出血提示产科急症，需立即转产科急诊评估");
  }
  if (activeMajorVaginalBleedingSignal && !activeObstetricHemorrhageSignal) {
    redFlags.push("活动性大量阴道出血伴持续/反复、重度贫血或循环灌注风险，需立即评估失血量与循环状态并急诊处置");
  }
  const acuteRespiratorySignal =
    hasAnyTerm(text, ["端坐呼吸", "不能平卧", "无法平卧", "喘不上气", "口唇发紫", "嘴唇发紫",
      ...RESPIRATORY_DETECTION.colloquialSymptoms]) ||
    hasColloquialOrthopnea(text) ||
    hasPatternWithoutNegation(text, /(?:说|讲)(?:半句|一句|几句话).{0,12}(?:停|歇|喘)|(?:静息|坐着不动).{0,8}(?:呼吸困难|气促|喘憋)/);
  // 胸痛/胸闷伴气促时，心血管红旗文案已经完整承接呼吸循环风险；避免同一事件重复成两条告警。
  if (acuteRespiratorySignal && !reportableCardiacRisk && !anaphylacticAirwaySignal) {
    redFlags.push("突发或快速加重呼吸困难/端坐呼吸，需优先评估呼吸循环急症");
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
  if (obstetricContext && bp && (bp.systolic >= 160 || bp.diastolic >= 110) &&
      !(bp.systolic >= 180 || bp.diastolic >= 120)) {
    redFlags.push(`妊娠/产褥期血压 ${bp.systolic}/${bp.diastolic}mmHg 达重度高血压标准（≥160/110），需立即按子痫前期/子痫风险急诊评估，尤其伴头痛、视物异常或上腹痛时`);
  }
  const criticalBp = bp && bloodPressureIsCritical(bp) ? bp : null;
  if (criticalBp) {
    redFlags.push(criticalBp.systolic >= 180 || criticalBp.diastolic >= 120
      ? `血压 ${criticalBp.systolic}/${criticalBp.diastolic}mmHg 达重度高血压警戒值，需立即规范复测并评估急性靶器官损害；如伴胸痛、神经功能异常或呼吸困难应急诊处理`
      : `血压 ${criticalBp.systolic}/${criticalBp.diastolic}mmHg 达低血压/休克风险警戒值，需立即复测并评估循环灌注`);
  }
  if (temp != null && temp >= 40) {
    redFlags.push(`体温 ${temp}℃ 达极高热警戒值，需立即复测并评估严重感染、中枢或热相关急症`);
  }
  if (temp != null && temp < 35) {
    redFlags.push(`体温 ${temp}℃，达到低体温风险警戒阈值，需先评估循环、感染或暴露相关风险`);
  }
  if (pulse != null && (pulse >= 150 || pulse < 40)) {
    redFlags.push(`心率/脉搏 ${pulse}次/分异常，需先评估心血管风险`);
  }
  if (respiration != null && (respiration >= 35 || respiration < 8)) {
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
  { id: "acute-neurologic-event", message: /神经系统|神经功能|头痛/, source: /头痛|意识障碍|意识不清|神志不清|昏迷|昏睡|嗜睡|谵妄|呼之不应|抽搐|惊厥|无力|偏瘫|说不出话/, explanation: "急性意识、发作性事件或局灶神经异常需优先排除神经急症。" },
  { id: "acute-abdomen-emergency", message: /急腹症|剧烈腹痛|腹痛\/腹胀/, source: /腹痛|腹胀|胃痛|胃脘痛|肚子疼|右下腹痛|上腹痛|心口窝痛|胃部疼痛|反跳痛|松手更疼|板状腹|腹肌紧张/, explanation: "剧烈腹痛或腹膜刺激征达到急腹症硬门槛；单纯突发、尚无重症表现者进入优先评估而非自动急诊定级。" },
  { id: "active-gi-bleeding", message: /消化道出血/, source: /呕血|吐血|黑便|柏油样便|便血|咖啡(?:色|样)/, explanation: "活动性消化道出血表现需立即评估失血量和循环状态。" },
  { id: "active-major-bleeding", message: /活动性大量阴道出血/, source: /阴道(?:出血|流血)|血红蛋白|血色素|HGB|Hb/i, explanation: "活动性大量阴道出血伴持续、重度贫血或循环灌注表现，达到非产科大出血硬门槛。" },
  { id: "acute-respiratory-event", message: /呼吸循环急症|缺氧/, source: /呼吸困难|气促|喘憋|端坐呼吸|不能平卧|无法平卧|喘不上气|发紫/, explanation: "静息或快速加重的呼吸困难及缺氧表现需立即评估。" },
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
 * Model-outage fallback for common but non-definitive risk symptoms. These checks intentionally
 * never create an emergency lock: they preserve clinician visibility until the semantic model can
 * distinguish severity, timing and symptom combinations. The normal path remains fully model-owned.
 */
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
    hasAnyTerm(text, [...FOCAL_NEUROLOGIC_TERMS, "昏迷", "昏睡", "嗜睡", "谵妄", "呼之不应", "抽搐", "惊厥"]) &&
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
  if (hasAnyTerm(text, ["寒战"]) && (hasAnyTerm(text, ["高热", "发热"]) || (parseContextualTemperature(text) ?? 0) >= 38.5)) {
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
  if ((glucose != null && Number(glucose) < 3) || hasAnyTerm(text, ["严重低血糖", "低血糖昏迷"])) {
    addAdvisory("metabolic", "严重低血糖或代谢异常线索需立即复测，并优先评估意识与循环状态");
  }
  if (hasAnyTerm(text, ["妊娠", "怀孕", "孕早期", "早孕"]) &&
      hasAnyTerm(text, ["腹痛", "阴道流血", "头晕", "晕厥"])) {
    addAdvisory("obstetric", "妊娠相关腹痛、出血或循环症状需优先排除产科急症");
  }
  if (hasAnyTerm(text, ["全身冰冷", "四肢冰冷", "少尿", "无尿", "意识模糊"])) {
    addAdvisory("shock", "循环灌注异常线索需立即复核血压、意识、尿量及末梢循环");
  }
  if (hasAnyTerm(text, ["风团", "荨麻疹", "脸肿", "喉紧", "喉头肿胀", "声音嘶哑"])) {
    addAdvisory("anaphylaxis", "严重过敏或气道受累线索需立即复核气道、呼吸和循环");
  }
  if (hasAnyTerm(text, ["发绀", "精神萎靡", "反应差", ...PEDIATRIC_DETECTION.colloquialCriticalSigns]) && isPediatricPatient(state)) {
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
  if (bp && !bloodPressureIsCritical(bp) &&
      (bp.systolic >= 180 || bp.diastolic >= 120 || bp.systolic <= 90 || bp.diastolic <= 50)) {
    advisories.push(`血压 ${bp.systolic}/${bp.diastolic}mmHg 需立即规范复测，并结合胸痛、气促、神经症状及急性靶器官损害判断处置级别`);
  }
  if (temperature != null && temperature < 40 && temperature >= 39) {
    advisories.push(`体温 ${temperature}℃ 需尽快复测，并结合寒战、意识、循环及感染灶评估`);
  } else if (temperature != null && temperature >= 35 && temperature < 36) {
    advisories.push(`体温 ${temperature}℃ 偏低，需尽快复测并结合暴露、感染和循环状态评估`);
  }
  if (pulse != null && pulse < 150 && pulse >= 120) {
    advisories.push(`心率/脉搏 ${pulse}次/分需尽快复测，并结合节律、症状及基础心率评估`);
  } else if (pulse != null && pulse >= 40 && pulse < 50) {
    advisories.push(`心率/脉搏 ${pulse}次/分需尽快复测，并结合节律、症状及基础心率评估`);
  }
  if (respiration != null && respiration < 35 && respiration >= 25) {
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
  const structured = authoritativeFieldOrFallback(state, "sex", state.patient.sex);
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
  const structured = state.patient.age != null ? String(state.patient.age).trim() : "";
  if (isKnownClinicalText(structured)) return structured;
  return patientBoundNarrativeAge(normalizeClinicalText(trustedInputText(state)));
}

function patientBoundNarrativeAge(text: string): string {
  const ageLiteral = String.raw`(-?\d{1,4}(?:\.\d+)?\s*(?:岁(?:\s*\d{1,4}(?:\.\d+)?\s*(?:个月|月龄))?|个月|月龄))`;
  const labeled = text.match(new RegExp(`(?:^|[。；;\\n])\\s*(?:(?:患者|病人)\\s*)?年龄\\s*[:：]?\\s*${ageLiteral}`));
  if (labeled?.[1]) return labeled[1];
  const subjectFirst = text.match(new RegExp(
    `(?:^|[。；;\\n])\\s*(?:(?:患者|病人)\\s*(?:为|系|是)?\\s*(?:一名|一位)?\\s*(?:男性|女性|男|女|男童|女童|患儿)?|患儿|男童|女童|男性|女性|男|女)\\s*(?:年龄\\s*[:：]?|为|系|是|约|，|,)?\\s*${ageLiteral}`,
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

function pregnancyScreenRequired(state: CaseState): boolean {
  const sex = patientSexText(state);
  if (!/女/.test(sex)) return false;
  const text = normalizeClinicalText(trustedInputText(state));
  const physiologicallyNotAtRisk = /(绝经|停经)\s*(?:已|约)?\s*(?:1[2-9]|[2-9]\d)\s*(?:个月|月)|绝经后|双侧卵巢切除|子宫全切(?:除)?|无子宫/.test(text);
  // Age alone cannot establish reproductive potential. Without explicit physiologic status, screen
  // every female patient fail-closed, including adolescents and older adults whose menopause is unknown.
  return !physiologicallyNotAtRisk;
}

function hasNumericPediatricWeight(text: string): boolean {
  // Must be an explicit body-weight value (体重/WT/weight/BW immediately followed by the number).
  // A bare "<n>kg" elsewhere (e.g. "体重下降5kg" weight loss) must NOT satisfy the weight requirement.
  return /(?:体重|体重约|BW|WT|weight)\s*[:：约为]?\s*\d{1,3}(?:\.\d+)?\s*(?:kg|公斤|千克)?/i.test(normalizeClinicalText(text));
}

// 儿科病例可能只用定性词标注(患儿/婴儿/男童/月龄…)而无数字年龄。这类同样必须命中儿童剂量门：
// 本地知识库只有成人剂量区间，任何候选方一律 fail-closed 到儿科医师/药师个体化复核，绝不退化为成人剂量。
function hasQualitativePediatricContext(state: CaseState): boolean {
  const structuredDemographics = normalizeClinicalText([
    state.hisRecord?.fields?.sex,
    state.hisRecord?.fields?.age,
    state.patient.sex,
  ].filter(Boolean).join("；"));
  if (/(患儿|儿童|未成年人|新生儿|婴儿|婴幼儿|乳儿|幼儿|宝宝|男童|女童|月龄)/.test(structuredDemographics)) {
    return true;
  }
  return normalizeClinicalText(trustedInputText(state))
    .split(/[。；;\n]+/)
    .map((clause) => clause.trim().replace(/^(?:主诉|现病史|患者信息|一般资料)\s*[:：]\s*/, ""))
    .some((clause) => /^(?:(?:患者|病人)\s*(?:为|系|是)?\s*)?(?:一名|一位|该名|这个)?\s*(?:患儿|儿童患者|儿童|未成年人|新生儿|婴儿|婴幼儿|乳儿|幼儿|宝宝|小孩|孩子|少年|学龄前儿童|小学生|中学生|男童|女童)/.test(clause));
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

function hasExplicitPregnancyStatus(text: string): boolean {
  return isKnownClinicalState(assessPregnancyState(text));
}

function hasExplicitLactationStatus(text: string): boolean {
  return isKnownClinicalState(assessLactationState(text));
}

function hasExplicitConceptionStatus(text: string): boolean {
  return isKnownClinicalState(assessConceptionState(text));
}

function hasPositivePregnancyOrLactationRisk(text: string): boolean {
  return [
    assessPregnancyState(text),
    assessLactationState(text),
    assessConceptionState(text),
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
      return /(用药|服药|服用|口服|注射|应用|在用|停药|换药|减药|药名|剂量|频次|降压药|降糖药|抗凝药|抗血小板药|止痛药|止咳药|安眠药|中成药|中药|西药|保健品|阿司匹林|华法林|二甲双胍|胰岛素|硝苯地平|缬沙坦|氯吡格雷|[\u4e00-\u9fa5A-Za-z]{2,}(?:片|胶囊|颗粒|丸|散|口服液|注射液)|\d+(?:\.\d+)?\s*(?:mg|g|ml)\b|\b(?:bid|tid|qd|qod)\b)/i.test(clause);
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

function semanticScreeningUnavailableItem(state: CaseState): string | undefined {
  if (state.clinicalFacts?.sourceCoverage === "partial") {
    return "病历超出语义红旗预检完整覆盖范围";
  }
  if (state.clinicalFacts?.semanticStatus === "checked" && state.clinicalFacts.reviewStatus !== "checked") {
    return "语义红旗独立复核未完成";
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
  if (isPediatricPatient(state)) {
    reasons.push("儿童病例当前未配置可验证的个体化剂量规则");
  }
  if (hasPositivePregnancyOrLactationRisk(text)) {
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
export function highRiskDoseBoundaryReasons(state: CaseState): string[] {
  const source = trustedInputText(state);
  const medicationSource = [
    authoritativeFieldOrFallback(state, "yongyaoshi", state.medicationHistory),
    extractMedicationEvidenceText(source),
  ].filter(Boolean).join("；");
  const activeMedication = affirmedCurrentMedicationText(medicationSource) || "";
  const reasons: string[] = [];
  const push = (value: string) => {
    if (!reasons.includes(value)) reasons.push(value);
  };

  if (hasNonNegatedClinicalPattern(source, /(?:CKD|慢性肾脏病|慢性肾病)(?:[^。；\n]{0,12}(?:[3-5三四五]期|Ⅲ|Ⅳ|Ⅴ))|(?:肾功能不全|肾衰竭|尿毒症)/i) || hasReducedEgfr(source)) {
    push("慢性肾病3-5期、eGFR降低或肾功能不全需专科/药师完成个体化剂量复核");
  }
  if (hasNonNegatedClinicalPattern(source, /(?:心力衰竭|心衰|HFrEF|HFpEF|射血分数\s*(?:EF)?\s*[:：]?\s*(?:[1-3]?\d(?:\.\d+)?)\s*%|EF\s*[:：]?\s*(?:[1-3]?\d(?:\.\d+)?)\s*%)/i)) {
    push("心力衰竭或射血分数降低需结合容量状态、肾功能及现用药完成剂量复核");
  }
  if (/(?:华法林|利伐沙班|阿哌沙班|达比加群|艾多沙班|肝素|依诺肝素|磺达肝癸钠|抗凝药|抗凝治疗|阿司匹林|氯吡格雷|替格瑞洛|普拉格雷|抗血小板)/i.test(activeMedication)) {
    push("当前抗凝或抗血小板治疗需完成出血风险与药物相互作用复核");
  }
  if (/(?:环孢素|他克莫司|吗替麦考酚酯|霉酚酸|硫唑嘌呤|甲氨蝶呤|来氟米特|环磷酰胺|生物制剂|免疫抑制剂|长期[^。；\n]{0,8}(?:泼尼松|糖皮质激素)|正在[^。；\n]{0,8}(?:泼尼松|糖皮质激素))/i.test(activeMedication)) {
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
 * 安全门处置模式（甲方产品决策 2026-08-01）：CDSS 不阻断临床流程。
 *
 * 检测层一条不删——红旗、危急体征、完整度、就诊目标的判定照常执行、照常进 HIS 载荷；
 * 改变的只是**处置**：默认 advise 模式下，命中不再换来一页「未形成结论」，而是完整结果 +
 * 置顶安全警示横幅 + 审方复核提示。医生永远拿得到分析与候选，警示永远在最上面。
 *
 * 保留 block 档（CDSS_GATE_DISPOSITION=block）作为运维回退开关：切回旧的 fail-closed
 * 拦截行为，不需要改代码或重新构建。
 */
export function gateDispositionIsAdvisory(): boolean {
  return (process.env.CDSS_GATE_DISPOSITION || "advise").trim().toLowerCase() !== "block";
}

/**
 * 红旗病例的**剂量授权**开关，与 CDSS_GATE_DISPOSITION 分开成两轴。
 *
 * 【为什么必须分开】CDSS_GATE_DISPOSITION 管的是**流程与呈现**：命中红旗后还给不给 M03
 * 分析、要不要把警示置顶。剂量授权是另一回事——它决定 M04 能不能印出具体克数。
 * 把两者绑在一个开关上，正是此前那个缺陷的来源：为了「不阻断流程」而放行剂量，
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
  const redFlags = (gate?.redFlags || []).filter(Boolean);
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
  lines.push("> - 以下分析与候选方药仅供医生在完成上述风险处置判断的前提下参考，采纳前须经院内审方复核。");
  return `${lines.join("\n")}\n\n`;
}

/**
 * Candidate generation and formal adoption are separate permissions. Clinical alerts and audit
 * outcomes remain visible, but they cannot silently change either permission. This is the single
 * authority consumed by M04, the workbench and the HIS integration payload.
 */
export function derivePrescriptionPermission(state: CaseState): PrescriptionPermission {
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

  const operationalCompleteness = deriveOperationalCompleteness(state);
  if (operationalCompleteness.level !== "C" && state.questionRounds < 1) {
    // advise 档：信息覆盖有限降级为「有限信息候选」而不是拒绝——追问是增强手段，不是门槛。
    if (gateDispositionIsAdvisory()) {
      return {
        candidateMode: "limited_dose",
        formalAdoption: "eligible_after_doctor_confirmation",
        reasons: ["当前病历关键信息覆盖有限，候选按有限信息生成；建议补充一轮追问以提高信心"],
      };
    }
    return {
      candidateMode: "non_dose_only",
      formalAdoption: "blocked",
      reasons: ["当前病历关键信息覆盖有限，需优先完成至少一轮高信息增益追问"],
    };
  }

  const text = structuredCaseText(state);
  const pediatric = isPediatricPatient(state);
  const positivePregnancyOrLactation = hasPositivePregnancyOrLactationRisk(text);
  const highRiskReasons = highRiskDoseBoundaryReasons(state);
  const nonDoseReasons = [
    pediatric ? "儿童病例当前未配置可验证的个体化剂量规则" : "",
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
  const semanticAdvisories = semanticTriageAdvisoriesFromFacts(state.clinicalFacts, semanticSourceText);
  const semanticEmergencyFindings = additiveRedFlagsFromFacts(state.clinicalFacts, semanticSourceText, []);
  const semanticEmergencyEvidence = structuredRedFlagEvidenceFromFacts(state.clinicalFacts, semanticSourceText);
  const priorityEvaluationItems = priorityEvaluationItemsFromFacts(state.clinicalFacts, semanticSourceText);
  if (hasAbdominalPrioritySignal(semanticSourceText) && !hasAcuteAbdominalSignal(semanticSourceText)) {
    priorityEvaluationItems.push("突发、持续或进展性腹痛/胃痛需优先完成腹部查体与严重度评估");
  }
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
  const advisories = Array.from(new Set([...semanticAdvisories, ...fallbackAdvisories, ...vitalAdvisories]));
  const text = structuredCaseText(state);
  const ageRaw = patientAgeText(state);
  const age = numberFromClinicalText(ageRaw);
  const ageWasEntered = isKnownClinicalText(ageRaw);
  const hasInvalidAge = ageWasEntered && age == null && hasInvalidAgeText(ageRaw);
  const topLevelAge = normalizedAgeLiteral(state.patient.age);
  const hisAge = normalizedAgeLiteral(state.hisRecord?.fields?.age);
  const hasAgeConflict = Boolean(topLevelAge && hisAge && topLevelAge !== hisAge);
  const structuredBloodPressure = structuredBloodPressureAssessment(state);
  const hasInvalidBp = hasInvalidBloodPressureOrder(vitalsText(state)) ||
    (structuredBloodPressure.status === "invalid" && structuredBloodPressure.reason === "order");

  if (!isKnownClinicalText(state.chiefComplaint || fieldText(state, "zhushu"))) addMissing("chief_complaint", "主诉");
  if (hasInvalidAge) addMissing("age_invalid", "年龄数值需复核（0-120岁）");
  if (hasAgeConflict) addMissing("age_conflict", "年龄记录冲突需复核");
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
  else if (medicationHistoryNeedsClarification(medicationText)) addMissing("medication_details", "已提及当前用药但缺少药名/剂量/频次");
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
    // The current deterministic knowledge base has adult per-herb ranges only. Recording weight is
    // necessary clinical context but cannot be treated as a pediatric dose algorithm.
    addMissing("pediatric_dose_rules_unavailable", "未配置儿童剂量级处方规则（需儿科中医师/药师个体化复核）");
  }
  if (reproductiveScreenRequired) {
    const reproductiveLabel = clinicalRequiredFieldLabel("reproductive_status", "妊娠/哺乳/备孕状态");
    if (!hasExplicitPregnancyStatus(text)) addMissing("pregnancy_unknown", `${reproductiveLabel}（妊娠）`);
    if (!hasExplicitLactationStatus(text)) addMissing("lactation_unknown", `${reproductiveLabel}（哺乳）`);
    if (!hasExplicitConceptionStatus(text)) addMissing("conception_unknown", `${reproductiveLabel}（备孕）`);
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
  const reviewedSemanticEmergencyFindings = state.clinicalFacts?.reviewStatus === "checked"
    ? additiveRedFlagsFromFacts(state.clinicalFacts, semanticSourceText, programmaticRedFlags)
    : [];
  const redFlags = [...programmaticRedFlags, ...reviewedSemanticEmergencyFindings];
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
  const pregnancyPositive = hasPositivePregnancyOrLactationRisk(text);
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
  return { ...next, safetyGate: evaluateSafetyGate(next) };
}

export function reconcileRestoredCaseState(state: CaseState): CaseState {
  const recomputed = withSafetyGate(state);
  if (recomputed.safetyGate?.allowDiagnosis === false) {
    // advise 档：恢复快照不清空已生成的结论。旧行为把红旗病例刷新一次就打回 question 阶段并
    // 删除全部 M03/M04/M05 结果——服务端明明是带警示完整生成的，前端一次刷新等于把医生的
    // 工作成果销毁。改为保留内容 + safetyLocked 警示锁（呈现层置顶警示、采纳须医生确认）。
    if (gateDispositionIsAdvisory()) {
      return { ...recomputed, safetyLocked: true, lastError: state.lastError };
    }
    return {
      ...recomputed,
      phase: state.lastError ? "error" : "question",
      diagnosis: undefined,
      prescription: undefined,
      riskAssessment: undefined,
      reasoningDiagnose: undefined,
      reasoningPrescribe: undefined,
      reasoningV2: undefined,
      prescriptionRevision: undefined,
      safetyLocked: true,
      lastError: state.lastError,
    };
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
): ClinicalReasoningResultV2 {
  const redFlag = gate.status === "red_flag";
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
      primarySyndrome: redFlag ? "急症处置优先，中医证候暂缓" : "当前证候依据不足以形成稳定结论",
      primarySyndromeResolution: "unresolved",
      primarySyndromeBasis: [],
      primarySyndromeResolutionReason: redFlag
        ? "当前急危重症风险应优先处置，不应因继续辨证而延误急诊评估"
        : "本次分析尚未形成通过临床复核的稳定证候结果",
      secondarySyndromes: [],
      overallPathogenesis: "当前不形成可采纳的中医病机链",
      overallTherapy: redFlag ? "立即急诊或专科评估，不进入中药处方" : "重新完成辨病辨证分析与临床复核",
      recommendedFormulaDirection: "暂不进入候选方药",
      recommendedFormulaNames: [],
      formulaSelectionMode: "none",
      evidence,
    },
    westernDiagnosis: {
      primary: {
        name: redFlag ? "急危重症风险待排除" : "症状性问题，病因待临床鉴别",
        status: redFlag ? "需排除" : "证据有限",
        confidence: redFlag ? "高" : "低",
        supportingFacts,
        limitations: [redFlag
          ? "本路径只确认急诊处置优先级，不替代现场诊断"
          : "本次分析尚未形成可信的完整诊断结果"],
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
    "现有资料尚不足以支持联用、替代或对症用药方案。",
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

export function deriveFirstReviewTiming(state: CaseState, hasStrongRisk: boolean): string {
  if (hasStrongRisk) return "调整处方后当日复核；若采纳，1-3天内随访";
  const candidate = state.reasoningPrescribe?.formula?.candidates?.[0] ||
    (state.reasoningV2?.stage === "prescribe" ? state.reasoningV2.formula?.candidates?.[0] : undefined);
  const followUpNode = candidate?.decoction?.followUpNode?.trim();
  return followUpNode || "3-5天后复诊或线上随访";
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
const AUDIT_FIELD_SEPARATOR = /\s*(?:／|\/|\|)\s*/;
const AUDIT_RISK_TERMS = /(禁忌|慎用|相互作用|过敏|超量|超过|肝肾|妊娠|哺乳|出血|毒性|有毒|重复用药|心悸|血压|嗜睡|成瘾|依赖)/;
/** 不是「观察什么」的格：规则名、提示等级、处置建议、纯标识符、范围说明。 */
const AUDIT_NON_OBSERVATION = /^(?:规则审查|给药途径审查|剂量审查|配伍审查|适应证审查|强提示|一般提示|说明性提示|信息不足提示|\d+|[0-9a-f]{8}-[0-9a-f-]{20,}|请[^，,。]{0,40}$|范围说明[:：])/;
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

function auditRiskObservationFromLine(line: string): string {
  const cells = line.split(AUDIT_FIELD_SEPARATOR).map((cell) => cell.trim()).filter(Boolean);
  const candidates = (cells.length > 1 ? cells : [line])
    .filter((cell) => !AUDIT_NON_OBSERVATION.test(cell))
    .filter((cell) => cell.length >= 6 && cell.length <= 60)
    .filter((cell) => AUDIT_RISK_TERMS.test(cell))
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
function usableFollowupTriggers(values: readonly string[]): string[] {
  return values.filter((value) => value && !NON_TRIGGER_RECORD_STATEMENT.test(value));
}

export type DeterministicRiskFollowupPayload = {
  markdown: string;
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
    timeline?: Array<{ time: string; action: string; indicators: string[]; triggers: string[] }>;
  } | null,
): DeterministicRiskFollowupPayload {
  const gate = state.safetyGate || evaluateSafetyGate(state);
  const followup = structuredFollowupInputs(state);
  if (gate.status === "red_flag") {
    return {
      markdown: buildSafetyLimitedRisk(gate),
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
      markdown: buildNonDoseRiskFollowup(gate),
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
      markdown: buildRestrictedDoseRiskFollowup(hardDoseBoundary),
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
  const hasStrongRisk = hasCurrentRiskLine(
    riskSource,
    /(强提示|(?<!最)高风险|禁用|十八反|十九畏|超出知识库上限|确定性处方风险复核未完成|审方未完成|不能等同为无风险)/,
  );
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
  const firstReview = deriveFirstReviewTiming(state, hasStrongRisk);
  const coreMetrics = followup.coreFacts.length > 0
    ? `${followup.coreFacts.join("；")}的严重程度、发作频次及对日常功能的影响`
    : "本次主要症状的严重程度、发作频次及对日常功能的影响";
  const efficacyTrigger = "主要症状较首诊无改善或加重，或出现新的伴随症状";
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
        action: "完成首次复诊与疗效复评",
        // 观察指标由模型按本例写；模型没给（或校验没过）就逐字回落 coreMetrics 拼串。
        // 拼串的实测形态：「下尿路感染；小便灼热涩痛5天；苔黄腻的严重程度、发作频次及对日常
        // 功能的影响」——诊断名当成了观察项，舌苔当成了有发作频次的东西。
        indicators: uniqueFollowupText(
          authoredIndicators.length > 0
            ? [...authoredIndicators, "舌脉变化", "实际用药与不适反应"]
            : [coreMetrics, "舌脉变化", "实际用药与不适反应"],
          6),
        triggers: uniqueFollowupText(usableFollowupTriggers([efficacyTrigger, ...safetyTriggers]), 6),
      },
      {
        time: "治疗期间随时",
        action: "记录症状变化并按触发条件提前复评",
        indicators: uniqueFollowupText(
          authoredIndicators.length > 0
            ? [...authoredIndicators, "新发不适或原症加重"]
            : [...followup.coreFacts, "新发不适或原症加重"],
          6),
        triggers: uniqueFollowupText([
          efficacyTrigger,
          "出现急性加重或新的红旗症状时及时就医",
        ], 6),
      },
    ];
  return {
    markdown: [
    "## 处方安全总评",
    `**最高提示强度**：${highest}`,
    `**综合风险判断**：${overall}`,
    `**评级依据**：${hasStrongRisk ? "处方后置复核命中强提示或存在未完成的确定性审方链路。" : hasReviewRisk ? "病历或处方中存在需医生复核的用药、过敏、特殊人群或联用信息。" : "处方后置复核未提示明确高危冲突。"}`,
    `**医生需确认事项**：${doctorAction}`,
    ...(missingAdvisory ? [`**待核实信息**：${missingAdvisory}。这些未知项不阻断候选方案展示，正式采纳前请结合临床实际确认。`] : []),
    ...(vitalAdvisories.length > 0 ? [`**生命体征录入提示**：${vitalAdvisories.join("；")}`] : []),
    "",
    "## 随访管理方案",
    `**首次复诊时间**：${firstReview}`,
    authored
      ? `**复诊评估重点**：${authored.reviewFocus}`
      : `**复诊评估重点**：${coreMetrics}；舌脉及本例已记录的客观指标变化；用药执行情况。`,
    authored
      ? `**疗效评价标准**：${authored.efficacyCriteria}`
      : `**疗效评价标准**：以首诊记录为基线，比较${coreMetrics}；同时确认未出现新发不适。`,
    ...(actualRiskIndicators.length > 0 ? [`**安全性观察**：${actualRiskIndicators.join("；")}。`] : []),
    ...(followup.precautions.length > 0 ? [`**注意事项**：${followup.precautions.join("；")}`] : []),
    `**无效或加重的处置预案**：${efficacyTrigger}时，不自动沿用候选方案，由医生复评诊断、辨证与处方风险，并按实际情况安排检查或转诊。`,
    "",
    ...sixHealthFollowupTable(authored?.dimensions).split("\n"),
    "",
    // 「## 随访时间轴」这张表 2026-08-10 按甲方要求从**医生可见面**移除：随访时间与
    // 触发条件已经由上面「首次复诊时间 / 复诊评估重点 / 疗效评价标准 / 无效或加重的处置预案」
    // 逐条讲过，表格是同一批内容换个排版再印一遍。
    // 结构化 timelineItems 仍随 payload 返回（HIS 出参与 API 消费方读它），只是不再渲染。
    "## 生活管理",
    // 模型写本例证候该注意什么；固定安全句无论如何都保留——它不是调护建议，是边界声明。
    ...(authored ? [authored.lifestyle] : []),
    authored
      ? "以上调护按本例证候拟定；不要自行叠加中药或中成药，复诊时携带实际使用的全部药物清单。"
      : "按本例非药物建议安排饮食、作息、情志和活动；不要自行叠加中药或中成药，复诊时携带实际使用的全部药物清单。",
    ].join("\n"),
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
    "**首次复诊时间**：结合病情轻重和候选方案，由医生确定首次复诊节点。",
    `**复诊评估重点**：按临床可得情况补录${missing}，复核主症、兼症、舌脉变化与用药反应。`,
    "**安全性观察**：皮疹瘙痒、胃肠不适、头晕乏力、心悸胸闷、出血倾向及原症加重。",
    "**无效或加重的处置预案**：停止自动沿用候选方案，由医生重新辨证并复核处方。",
    "",
    ...sixHealthFollowupTable().split("\n"),
    "",
    "## 随访时间轴",
    "| 时间点 | 医生/患者动作 | 观察指标 | 触发处置 |",
    "|------|--------------|---------|---------|",
    `| 采纳前 | 结合临床实际复核${missing} | 证候、病机、方药匹配、剂量与禁忌 | 复核结论改变时调整候选方案 |`,
    "| 首次随访 | 记录疗效与不良反应 | 主症变化、舌脉、胃肠反应及过敏表现 | 无效、加重或ADR时停用并复评 |",
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
    reasoningDiagnose: state.reasoningDiagnose ? scrubUnknown(state.reasoningDiagnose, 12000) as typeof state.reasoningDiagnose : undefined,
    reasoningPrescribe: state.reasoningPrescribe ? scrubUnknown(state.reasoningPrescribe, 12000) as typeof state.reasoningPrescribe : undefined,
    reasoningV2: state.reasoningV2 ? scrubUnknown(state.reasoningV2, 12000) as typeof state.reasoningV2 : undefined,
    safetyLocked: state.safetyLocked,
  };
}

export function sanitizeUnknownForModel<T>(
  value: T,
  opts?: { patientName?: string; maxStringLength?: number; maxDepth?: number },
): T {
  const patientName = opts?.patientName || "";
  const maxStringLength = opts?.maxStringLength ?? 6000;
  const maxDepth = opts?.maxDepth ?? 8;
  return scrubUnknownValue(value, patientName, maxStringLength, maxDepth, 0) as T;
}

function scrubUnknownValue(
  value: unknown,
  patientName: string,
  maxStringLength: number,
  maxDepth: number,
  depth: number,
): unknown {
  if (value == null) return value;
  if (typeof value === "string") return limitModelText(scrubPhi(value, patientName), maxStringLength);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= maxDepth) return "[嵌套内容已截断]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) =>
      scrubUnknownValue(item, patientName, maxStringLength, maxDepth, depth + 1)
    );
  }
  if (typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
      const safeKey = scrubPhi(key, patientName)
        .replace(/[\u4e00-\u9fa5]{2,4}(?=(?:病情|症状|主诉|记录|备注|信息|情况))/g, "[已脱敏]");
      const keyLooksIdentifying = /(name|姓名|患者名|联系人|身份证|证件|电话|手机|地址|住址|就诊号|门诊号|住院号|病案号|病历号|病例号|电子病历号|医疗记录号|患者编号|mrn|medical.?record|record.?number|patient.?id)/i.test(key);
      next[safeKey] = keyLooksIdentifying
        ? undefined
        : scrubUnknownValue(item, patientName, maxStringLength, maxDepth, depth + 1);
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
    .replace(/(?:患者|家属|联系人|陪同者|监护人|医生|医师)\s*[:：]?\s*[\u4e00-\u9fa5]{2,4}(?=[，,；。\s]|反映|诉|称|表示|告知|建议|记录)/g, (match) => {
      const label = match.match(/^(患者|家属|联系人|陪同者|监护人|医生|医师)/)?.[1] || "人员";
      return `${label}[已脱敏]`;
    })
    .replace(/患者\s*[\u4e00-\u9fa5]{2,4}(?=[，,；。\s]|男|女|\d{1,3}\s*岁)/g, "患者[已脱敏]")
    .replace(/(本例|该患者|病例|病人|患儿)\s*[\u4e00-\u9fa5]{2,4}?(?=(?:既往|曾经|曾有|近|昨|今|因|诉|称|反映|表示|出现|发生|患|有|于|睡|入睡|失眠|头痛|头晕|胸痛|腹痛|发热|咳嗽|心悸|就诊|来诊|男|女|\d{1,3}\s*岁))/g, "$1[已脱敏]")
    // 临床字段标签之后的词不是姓名(2026-08-05)。
    //
    // 本分支按「姓氏字 + 1–2 字 + 叙述动词」判姓名。中文病历里这个形态与临床术语大面积撞车:
    // 「主诉：周身出现块状皮疹」的「周身」——周在姓氏表、身是 1 字、出现在动词表——被整体抹成
    // 脱敏标记。20 例线上语料实测 13 例在**送模型之前**就丢了临床事实,而模型看不到的事实,
    // 后面每一层都补不回来:病位判为空、病机链缺节点、西医支持依据只剩半句病历原文。
    //
    // 判据不是词表:周身、全身、白苔、黄疸、皮疹、干呕都不在任何受控词表里,靠补词表穷举不完。
    // 判据是**位置**——本系统的病历按字段录入,姓名在 patient 字段或带显式「姓名：」标签,
    // 不会紧跟在「主诉：」「四诊：」「舌：」这类临床字段标签之后。故只在标签冒号后否决本分支。
    // 高置信形态一条未动:显式姓名标签、某字名、姓氏+人口学邻接(，男/女/NN岁)、电话/证件/地址。
    // 真实姓名的叙述形态(「张三昨夜失眠」)不带临床标签前缀,仍然照常脱敏(见 test:clinical-grounding)。
    .replace(/(^|[，,。\s]|[；;](?!\s*$)|(?<!(?:主诉|现病史|既往史|个人史|家族史|婚育史|月经史|过敏史|用药史|四诊|望诊|闻诊|问诊|切诊|症见|刻下|查体|体格检查|舌象|脉象|舌|脉|辅助检查|检查|诊断|治法|治则)\s*)[:：]|患者|家属|联系人|陪同者|监护人)((?:欧阳|司马|上官|诸葛|[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包左石崔吉龚程邢裴陆荣翁荀羊惠甄曲封芮储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘厉戎祖武符刘景詹束龙叶幸司韶黎乔苍双闻莘党翟谭贡劳姬申扶堵冉宰郦雍却璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧沃利蔚越夔隆师巩厍聂晁勾敖融冷辛阚那简饶空曾沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公]))[\u4e00-\u9fa5]{1,2}(?=(?:近|昨|今|因|诉|称|反映|表示|出现|发生|患|有|于|睡|入睡|失眠|头痛|头晕|胸痛|腹痛|发热|咳嗽|心悸|就诊|来诊))/g, (_match, prefix: string) => `${prefix}[已脱敏]`)
    .replace(/^([\u4e00-\u9fa5]{2,4})(?=[，,；。\s]*(?:男|女|\d{1,3}\s*岁))/g,
      // 通用指代词不是姓名:「患者，女，36岁」里的「患者」被整体抹成脱敏标记,
      // 线上 20 例语料有 12 例命中。它不携带任何身份信息,抹掉只制造噪声。
      (match: string) => (/^(?:患者|病人|患儿|本例|该例|受试者|就诊者|老人|婴儿|幼儿|产妇|孕妇)$/.test(match) ? match : "[已脱敏]"))
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

export function markdownNdjsonResponse(markdown: string): Response {
  const timelineItems = parseStructuredFollowupTimeline(markdown);
  const visibleMarkdown = sanitizeAuthoritativeClinicalOutput(stripStructuredFollowupTimeline(markdown));
  const body = [
    ...(timelineItems.length > 0 ? [JSON.stringify({ type: "followup_timeline", timelineItems })] : []),
    JSON.stringify({ content: visibleMarkdown }),
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
