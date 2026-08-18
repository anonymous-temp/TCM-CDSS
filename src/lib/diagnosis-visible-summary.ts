import { discriminatingWesternSupportClauses, narrativeMostlyCopies, NATURE_MECHANISM_PHRASE as MECHANISM_PREDICATE, herbFunctionMatchesKnowledge, isAmbiguousM03WesternPrimaryLabel, isDisplayableClinicalText, isNondiscriminatingWesternSupportingFact, isUnstableM03CoreText, isWesternSupportingFactPolarityAligned, m03SemanticIssue, m03WesternClinicalRationaleIssue, m03WesternDurationIssue, narrativeFingerprint, NATURE_MECHANISM_PHRASE, patientFactSourceQuote } from "./diagnosis-stage-contract";
import { isGovernedTcmDiseaseName } from "./clinical-terminology";
import { decoctionRuleForHerb, decoctionRuleSatisfied, requiredDecoctionRequirement } from "./herb-decoction-rules";
import { findTcmHerbPairIncompatibilities, getTcmHerbFunctionDisplayText, isKnownTcmHerbName } from "./tcm-knowledge";
import { formulaSyndromeConflictNotice, formulaSyndromeConflicts } from "./formula-syndrome-consistency";
import { buildFormulaAnalysis, formulaStructureTarget, formulaTargetPathogenesisCells, normalizeFormulaStructureRole } from "./herb-target-contract";
// 剂量写法判据复用 M04 那条已导出的，不写第二份。
import { PRECAUTION_DOSE_LIKE } from "./m04-proposal-compiler";
import { customerEvidenceDisplayStatus } from "./customer-evidence";
import { affirmedClinicalSourceClauses, affirmedClinicalText, clinicalClausePolarity, stripClinicalSectionLabel } from "./clinical-polarity";
import { getM03TherapyLock } from "./m03-therapy-lock";
import { buildClinicianTreatmentProjects } from "./tcm-treatment-clinician-view";
import { canonicalWesternDifferentialName, westernDifferentialIdentity } from "./clinical-terminology";
import { canonicalTcmLocationTerm, canonicalTcmNatureTerm, governedTcmLocationsInText, resolveNationalStandardTcmSyndromeTerm } from "./clinical-governance-tables";
import { clinicalAxisAttributionFromFacts } from "./tcm-syndrome-hypothesis";
import {
  classifyWesternDiagnosticEvidence,
  clinicalFactSourcesFromCaseState,
  clinicalFactSourcesFromContext,
  clinicalFactWithSource,
  guidelineReferenceDisplay,
  uniqueClinicalFacts,
  westernDiagnosticEvidenceGroups,
} from "./clinical-fact-source";
import { clinicalClauseText, clinicalOutputLabel, clinicalSentence, joinClinicalClauses, sanitizeAuthoritativeClinicalOutput } from "./clinical-output-authority";
import { displayableLineageAdaptation } from "./tcm-lineages";
import { safeDietAdviceForDisplay, GOVERNED_HERB_DATA_LABEL } from "./result-display-policy";
import { clinicalEvidenceFingerprint, prioritizeTcmEvidenceForDisplay } from "./clinical-evidence-display";
import { CLASSIC_EVIDENCE_ANCHOR_LABELS, CLASSIC_EVIDENCE_TIER_LABELS, sanitizeReasoningNarratives } from "./internal-tag-hygiene";
import { normalizeReasoningV2 } from "./diagnosis-types";

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

/**
 * 甲方评测(2026-08-04) 呈现层第 3 条「病机内容仍存在重复」的**单一去重权威**。
 *
 * 根因：M03 的病机在结构化载荷里天然存在于五个字段——overview.overallPathogenesis、
 * pathogenesis.summary（服务端投影＝chain 病机去重后分号连接）、caseRelationship.relationship、
 * chain[].pathogenesis、therapy.subTherapies[].targetPathogenesis。渲染层此前对每个字段各自
 * 无条件成句，于是同一段病机原文在一页里被医生读到 2–3 次。实测 1340 份归档产出：
 * 33% 的 overallPathogenesis 逐字包含某个 chain 病机，18% 的 subTherapies.targetPathogenesis
 * 与 chain 病机逐字相同，4% 的 caseRelationship.relationship 与两者之一相同。
 *
 * 规则：**一段病机原文在整篇可见正文中最多完整呈现一次**，后续位置改为短引用或整条省略。
 * 服务端 Markdown 投影与客户端结构化渲染共用本账本，避免两条渲染路径各写一套判据后再次分叉。
 */
export function createPathogenesisNarrativeLedger() {
  const shown: string[] = [];
  const fingerprintOf = (value: unknown): string => narrativeFingerprint(markdownCell(value));
  return {
    /** 这段病机是否已在正文别处完整呈现过（逐字相同，或已被更长的一段完整包含）。 */
    isAlreadyShown(value: unknown): boolean {
      const print = fingerprintOf(value);
      if (print.length < 4) return false;
      return shown.some((seen) => seen === print || seen.includes(print));
    },
    /** 登记一段将要完整呈现的病机原文；返回 false 表示调用方应改用短引用。 */
    claim(value: unknown): boolean {
      const print = fingerprintOf(value);
      if (print.length < 4) return true;
      if (shown.some((seen) => seen === print || seen.includes(print))) return false;
      shown.push(print);
      return true;
    },
  };
}

/** 内部经典证据枚举 → 医生可见中文标签；未收录取值返回空串，由调用方整段省略。 */
function classicTierLabel(value: unknown): string {
  return typeof value === "string" ? CLASSIC_EVIDENCE_TIER_LABELS[value.trim()] || "" : "";
}

function classicAnchorLabel(value: unknown): string {
  return typeof value === "string" ? CLASSIC_EVIDENCE_ANCHOR_LABELS[value.trim()] || "" : "";
}
type ClinicalResolutionValue = "resolved" | "bounded" | "unresolved";

function exactClinicalSourceQuotes(value: string, clinicalContext: string): string[] {
  const exact = (candidate: string): string | undefined => {
    const quote = patientFactSourceQuote(candidate, clinicalContext)?.trim();
    return quote && clinicalContext.includes(quote) ? quote : undefined;
  };
  const whole = exact(value);
  if (whole) return [whole];
  // A provider may join two real chart clauses into a newly worded sentence. That sentence is not
  // a source quote even though each component is individually supported. Split only on hard/comma
  // clause boundaries, re-ground every part, and retain the exact chart sentences. Unsupported
  // fragments disappear rather than being laundered through an otherwise true neighbouring fact.
  return [...new Set(value
    .split(/[，,。；;]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
    .flatMap((part) => {
      const quote = exact(part);
      return quote ? [quote] : [];
    }))];
}

function semanticItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []))];
}

function deduplicateWesternDifferentials(value: unknown): Record<string, unknown>[] {
  const unique: Record<string, unknown>[] = [];
  const byName = new Map<string, Record<string, unknown>>();
  for (const raw of recordList(value)) {
    const name = canonicalWesternDifferentialName(raw.name);
    const identity = westernDifferentialIdentity(name);
    if (!identity) continue;
    const existing = byName.get(identity);
    if (!existing) {
      const item = { ...raw, name };
      byName.set(identity, item);
      unique.push(item);
      continue;
    }
    for (const field of ["reason", "nextCheck"] as const) {
      const current = typeof existing[field] === "string" ? existing[field].trim() : "";
      const addition = typeof raw[field] === "string" ? raw[field].trim() : "";
      if (!addition || current === addition) continue;
      const limit = field === "reason" ? 1_000 : 600;
      existing[field] = (current ? `${current}；${addition}` : addition).slice(0, limit);
    }
  }
  return unique;
}

const EXERTIONAL_CARDIORESPIRATORY_PATTERN = /(?:(?:活动|运动|劳力|跑步?|快走|走快|爬楼|上楼|干活)[^。；\n]{0,32}(?:气短|气促|喘|喘鸣|哮鸣|憋气|呼吸困难|胸闷|胸口[^。；\n]{0,8}呼呼响)|(?:气短|气促|喘|喘鸣|哮鸣|憋气|呼吸困难|胸闷|胸口[^。；\n]{0,8}呼呼响)[^。；\n]{0,32}(?:活动|运动|劳力|跑步?|快走|走快|爬楼|上楼|干活))/;
const NOCTURNAL_BREATHLESSNESS_PATTERN = /(?:(?:夜间|夜里|晚上|睡眠中|睡觉时)[^。；\n]{0,32}(?:憋醒|憋气|气短|气促|喘|呼吸困难|不能平卧|端坐呼吸)|(?:憋醒|不能平卧|端坐呼吸)[^。；\n]{0,16}(?:夜间|夜里|晚上|睡眠中|睡觉时)?)/;
const HEART_FAILURE_DIFFERENTIAL = /^(?:心功能不全|心力衰竭|心衰)(?:待排|待查|可能)?$/;
const CORONARY_DIFFERENTIAL = /^(?:冠心病|冠状动脉粥样硬化性心脏病|心肌缺血(?:相关症状)?)(?:待排|待查|可能)?$/;
const CARDIOPULMONARY_FOLLOWUP_SENTENCE = "劳力性呼吸不适或夜间憋醒持续、加重时，应尽快复诊排除心功能不全等心源性原因；若出现静息呼吸困难、不能平卧、胸痛、晕厥或发绀，应立即急诊评估。";
const CURRENT_CONSTIPATION_PATTERN = /(?:便秘|大便[^。；\n]{0,12}(?:解不出来|难解|难以排出|排出困难|四五天一次|数日一行)|排便(?:困难|费劲|次数减少))/;
const RECENT_OR_PROGRESSIVE_CHANGE_PATTERN = /(?:(?:最近|近期|近来|近)\s*(?:(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半]+)\s*(?:个)?\s*(?:天|日|周|月|年))?[^。；\n]{0,24}(?:新发|初发|开始|出现|越来越|逐渐|进行性|加重|明显)|(?:新发|初发|首次出现|进行性加重|逐渐加重|越来越明显)[^。；\n]{0,24}(?:便秘|排便|大便))/;
const COLORECTAL_ORGANIC_DIFFERENTIAL = /(?:结肠|直肠|结直肠)[^。；\n]{0,16}(?:肿瘤|癌|占位|器质性病变)/;
const CONSTIPATION_AGE_THRESHOLD = 40;

function hasExertionalNocturnalBreathlessness(clinicalContext: string): boolean {
  const affirmed = affirmedClinicalText(clinicalContext) || "";
  return EXERTIONAL_CARDIORESPIRATORY_PATTERN.test(affirmed) && NOCTURNAL_BREATHLESSNESS_PATTERN.test(affirmed);
}

/**
 * Final M03 western projection normalization. Declassification can add the former primary label
 * after the first grounding pass, so differential de-duplication must run again immediately before
 * review/signing. A documented combination of exertional respiratory discomfort and nocturnal
 * breathlessness also requires explicit heart-source differentials and a patient-facing safety
 * net. These entries are exclusion directions, never deterministic disease diagnoses, and the
 * complete projection is still sent through independent clinical review.
 */
/**
 * 甲方评测(2026-08-03) 1.1.1：支持依据里出现「生命体征：88次/分」这类丢失指标名的裸值——
 * 模型从病历生命体征串里截半句。用病历上下文里的带标签原值把指标名找回来；找不回时原样保留。
 */
function relabelBareVitalSupportingFact(fact: string, clinicalContext: string): string {
  const bare = fact.match(/^生命体征[:：]\s*([\d.]+(?:\/[\d.]+)?)\s*(次\/分|℃|°C|mmHg|%)?$/);
  if (!bare) return fact;
  const value = bare[1];
  const labels: Array<[RegExp, string]> = [
    [new RegExp(`(?:BP|血压)[:：]?\\s*${value.replace(/\//g, "\\/")}`), "血压"],
    [new RegExp(`(?:P|脉搏|心率|HR)[:：]?\\s*${value}次`), "脉搏"],
    [new RegExp(`(?:R|呼吸)[:：]?\\s*${value}次`), "呼吸"],
    [new RegExp(`(?:T|体温)[:：]?\\s*${value}`), "体温"],
    [new RegExp(`(?:SpO2|血氧)[:：]?\\s*${value}`), "血氧饱和度"],
  ];
  const label = labels.find(([pattern]) => pattern.test(clinicalContext))?.[1];
  return label ? `${label} ${value}${bare[2] || ""}` : fact;
}

export function normalizeM03WesternDifferentials(
  content: string,
  clinicalContext: string,
  patientAgeYears?: number,
): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "diagnose") return content;
    const western = recordValue(reasoning.westernDiagnosis);
    if (!western) return content;

    let differentials = deduplicateWesternDifferentials(western.differentials);
    if (hasExertionalNocturnalBreathlessness(clinicalContext)) {
      const names = differentials.map((item) => markdownCell(item.name).replace(/[\s（）()，,。；;：:、]/g, ""));
      const required: Record<string, unknown>[] = [];
      if (!names.some((name) => HEART_FAILURE_DIFFERENTIAL.test(name))) {
        required.push({
          name: "心功能不全",
          reason: "临床记录同时存在劳力相关呼吸不适与夜间憋醒，需排除心源性原因；当前仅为鉴别方向，不等同于确诊。",
          distinguishingPoints: "是否存在不能平卧、下肢水肿、心脏体征或心功能相关客观异常。",
          nextCheck: "结合心肺查体、心电图、BNP/NT-proBNP及心脏超声评估；若静息气促或不能平卧应立即就医。",
        });
      }
      if (!names.some((name) => CORONARY_DIFFERENTIAL.test(name))) {
        required.push({
          name: "冠心病",
          reason: "劳力相关胸部或呼吸不适需排除心肌缺血等心源性表现；当前仅为鉴别方向，不等同于确诊。",
          distinguishingPoints: "症状是否与活动负荷稳定相关，是否伴胸部压迫感及心电图等缺血证据。",
          nextCheck: "评估心血管危险因素和症状与活动的关系，结合心电图及临床判断决定后续检查；急性胸痛应立即就医。",
        });
      }
      // Must-not-miss cross-domain alternatives stay visible even when the model already used the
      // eight-item allowance on lower-value entries. Exact duplicates are merged below.
      differentials = deduplicateWesternDifferentials([...required, ...differentials]);

      const rawManagement = recordValue(reasoning.management) || {};
      const currentSafetyNet = markdownCell(rawManagement.followupSafetyNet);
      const followupSafetyNet = currentSafetyNet.includes(CARDIOPULMONARY_FOLLOWUP_SENTENCE)
        ? currentSafetyNet
        : [currentSafetyNet, CARDIOPULMONARY_FOLLOWUP_SENTENCE].filter(Boolean).join(" ");
      reasoning.management = {
        ...rawManagement,
        followupSafetyNet: followupSafetyNet.slice(0, 1_600),
      };
    }

    const affirmed = affirmedClinicalText(clinicalContext) || "";
    const age = typeof patientAgeYears === "number" && Number.isFinite(patientAgeYears) && patientAgeYears >= 0 && patientAgeYears <= 120
      ? patientAgeYears
      : undefined;
    const hasOlderNewConstipation = typeof age === "number" && age > CONSTIPATION_AGE_THRESHOLD &&
      CURRENT_CONSTIPATION_PATTERN.test(affirmed) && RECENT_OR_PROGRESSIVE_CHANGE_PATTERN.test(affirmed);
    if (hasOlderNewConstipation) {
      const primary = recordValue(western.primary);
      if (primary) {
        const patientSpecificCheck = `患者年龄为${age}岁，且近期出现或进行性加重排便习惯改变，建议消化专科评估，并结合既往结直肠癌筛查史决定结肠镜检查，以排除结直肠器质性病变。`;
        primary.suggestedChecks = uniqueClinicalFacts([
          ...semanticItems(primary.suggestedChecks),
          patientSpecificCheck,
        ]).slice(0, 12);
      }
      if (!differentials.some((item) => COLORECTAL_ORGANIC_DIFFERENTIAL.test(markdownCell(item.name)))) {
        differentials = deduplicateWesternDifferentials([{
          name: "结直肠器质性病变",
          reason: `${age}岁患者近期出现或进行性加重的排便习惯改变，需先排除器质性原因；当前仅为鉴别方向，不等同于确诊。`,
          distinguishingPoints: "新发或进行性排便改变、便血、贫血、体重下降及既往筛查情况。",
          nextCheck: "消化专科评估，结合既往筛查史、体格检查及便潜血等结果决定结肠镜检查。",
        }, ...differentials]);
      }
      const rawManagement = recordValue(reasoning.management) || {};
      const currentSafetyNet = markdownCell(rawManagement.followupSafetyNet);
      const patientSpecificSafetyNet = `本例为${age}岁且近期出现或进行性加重排便习惯改变，该年龄与病程组合本身即需尽快完成消化专科评估，并结合既往筛查史决定结肠镜检查；便血、消瘦等其他报警征象应另行核实。`;
      const followupSafetyNet = currentSafetyNet.includes(patientSpecificSafetyNet)
        ? currentSafetyNet
        : [currentSafetyNet, patientSpecificSafetyNet].filter(Boolean).join(" ");
      reasoning.management = {
        ...rawManagement,
        followupSafetyNet: followupSafetyNet.slice(0, 1_600),
      };
    }
    western.differentials = differentials.slice(0, 8);
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

function resolutionValue(value: unknown): ClinicalResolutionValue | undefined {
  return value === "resolved" || value === "bounded" || value === "unresolved" ? value : undefined;
}

/**
 * 逐字重复的结构行是形状缺陷,不是临床缺陷:保留下来的那一行已经承载了同样的内容,
 * 不需要为此消耗一轮模型修复并冒着触发 M03 总时限降级的风险。
 *
 * 本函数只做删除与去重:不合并文本、不改写任何字段、不新增任何临床断言。只要化简会丢失
 * 任何一条医生可见的患者证据或病机靶点,就保持原样并由合同继续驳回。
 */
export function normalizeM03StructuralDuplicates(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "diagnose") return content;
    let changed = false;

    const pathogenesis = recordValue(reasoning.pathogenesis);
    const chain = recordList(pathogenesis?.chain);
    if (pathogenesis && chain.length > 1) {
      // patientFact 与 syndromeEvidence 是分别独立回溯到病历原文的两列证据(见 groundStructuredPatientFacts),
      // 只要它们仍有区别,删除节点就是删除医生可见的患者证据。因此必须四个字段同时退化成同一个非空
      // 指纹,后续节点才是首节点的逐字副本;否则保持原样,由合同驳回并让模型重新拆解病机链。
      const degenerate = (["patientFact", "syndromeEvidence", "pathogenesis", "therapyDirection"] as const)
        .every((key) => {
          const fingerprints = chain.map((node) => narrativeFingerprint(node[key]));
          return Boolean(fingerprints[0]) && new Set(fingerprints).size === 1;
        });
      if (degenerate) {
        pathogenesis.chain = [{ ...chain[0], nodeId: "P1" }];
        changed = true;
      }
    }

    const therapy = recordValue(reasoning.therapy);
    const subTherapies = recordList(therapy?.subTherapies);
    if (therapy && subTherapies.length > 1) {
      const seen = new Set<string>();
      const deduplicated = subTherapies.filter((item) => {
        const therapyPrint = narrativeFingerprint(item.therapy);
        const targetPrint = narrativeFingerprint(item.targetPathogenesis);
        // 只删除治法与所针对病机同时逐字重复的行。治法相同但病机靶点不同的行各自承载不同临床内容,
        // 删除会丢一个靶点并可能把一个驳回码换成另一个,故保持原样交给合同。空指纹行同样保留。
        if (!therapyPrint || !targetPrint) return true;
        const key = `${therapyPrint}\x00${targetPrint}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // 去重不得把分治法压到多节点病机链要求的下限之下,否则只是把一个驳回码换成另一个。
      const chainLength = recordList(recordValue(reasoning.pathogenesis)?.chain).length;
      const minimum = chainLength > 1 ? Math.min(2, chainLength) : 1;
      if (deduplicated.length !== subTherapies.length && deduplicated.length >= minimum) {
        therapy.subTherapies = deduplicated;
        changed = true;
      }
    }

    if (!changed) return content;
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

function lowerEvidenceConfidence(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  (value as Record<string, unknown>).confidence = "低";
}

/**
 * Detailed disease-location/nature fields enrich the report but do not own the M03 workflow gate.
 * Clinical classification is a semantic task owned by the model and the independent reviewer.
 * This pass only canonicalizes arrays, grounds quoted patient facts and makes uncertainty explicit;
 * it never deletes a disease location or nature because it is absent from a finite keyword table.
 */
export function sanitizeOptionalPathogenesisClassifications(content: string, clinicalContext: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "diagnose") return content;
    const pathogenesis = reasoning.pathogenesis && typeof reasoning.pathogenesis === "object" && !Array.isArray(reasoning.pathogenesis)
      ? reasoning.pathogenesis as Record<string, unknown>
      : null;
    const groundedQuote = (value: unknown): string => {
      if (typeof value !== "string" || !value.trim()) return "";
      if (!clinicalContext) return value.trim();
      return exactClinicalSourceQuotes(value, clinicalContext)[0] || "";
    };

    const overview = reasoning.overview && typeof reasoning.overview === "object" && !Array.isArray(reasoning.overview)
      ? reasoning.overview as Record<string, unknown>
      : null;
    if (overview) {
      overview.primarySyndromeBasis = semanticItems(overview.primarySyndromeBasis)
        .flatMap((item) => {
          const quote = groundedQuote(item);
          return quote ? affirmedClinicalSourceClauses(quote) : [];
        })
        .filter((item) => clinicalClausePolarity(item) === "affirmed")
        .filter(Boolean);
      const syndrome = typeof overview.primarySyndrome === "string" ? overview.primarySyndrome.trim() : "";
      const requested = resolutionValue(overview.primarySyndromeResolution);
      const finalResolution: ClinicalResolutionValue = !syndrome
        ? "unresolved"
        : requested === "resolved" && (overview.primarySyndromeBasis as string[]).length > 0
          ? "resolved"
          : requested === "unresolved" ? "unresolved" : "bounded";
      overview.primarySyndromeResolution = finalResolution;
      if (finalResolution === "resolved") delete overview.primarySyndromeResolutionReason;
      else {
        const groundedBasisCount = (overview.primarySyndromeBasis as string[]).length;
        overview.primarySyndromeResolutionReason = typeof overview.primarySyndromeResolutionReason === "string" && overview.primarySyndromeResolutionReason.trim()
          ? overview.primarySyndromeResolutionReason.trim()
          : finalResolution === "bounded"
            ? `证型“${syndrome}”仅有${groundedBasisCount}条可逐字回溯的本例依据，尚未达到稳定结论所需证据`
            : "本例记录尚未形成可供判断的证型名称与可回溯依据";
        lowerEvidenceConfidence(overview.evidence);
      }
    }

    const location = pathogenesis?.locationDifferentiation && typeof pathogenesis.locationDifferentiation === "object" && !Array.isArray(pathogenesis.locationDifferentiation)
      ? pathogenesis.locationDifferentiation as Record<string, unknown>
      : null;
    if (location) {
      location.items = semanticItems(location.items);
      const groundedDetails = Array.isArray(location.details)
        ? location.details.flatMap((rawDetail) => {
            if (!rawDetail || typeof rawDetail !== "object" || Array.isArray(rawDetail)) return [];
            const detail = rawDetail as Record<string, unknown>;
            if (typeof detail.location !== "string" || !detail.location.trim()) return [];
            const basis = groundedQuote(detail.basis);
            return basis ? [{ location: detail.location.trim(), basis }] : [];
          })
        : [];
      const basisCounts = new Map<string, number>();
      groundedDetails.forEach((detail) => {
        const key = String(detail.basis || "").normalize("NFKC").replace(/[\s，,。；;：:、→-]+/g, "");
        basisCounts.set(key, (basisCounts.get(key) || 0) + 1);
      });
      location.details = groundedDetails.filter((detail) => {
        const key = String(detail.basis || "").normalize("NFKC").replace(/[\s，,。；;：:、→-]+/g, "");
        return basisCounts.get(key) === 1;
      });
      const itemSet = new Set(location.items as string[]);
      const detailedLocations = new Set((location.details as Array<{ location: string }>).map((detail) => detail.location));
      const fullyGrounded = itemSet.size > 0 && [...itemSet].every((item) => detailedLocations.has(item));
      const requested = resolutionValue(location.resolution);
      const finalResolution: ClinicalResolutionValue = itemSet.size === 0
        ? "unresolved"
        : requested === "resolved" && fullyGrounded ? "resolved" : "bounded";
      location.resolution = finalResolution;
      if (finalResolution === "resolved") delete location.resolutionReason;
      else {
        const locationLabel = joinClinicalClauses([...itemSet], "、") || "未定";
        location.resolutionReason = typeof location.resolutionReason === "string" && location.resolutionReason.trim()
          ? location.resolutionReason.trim()
          : finalResolution === "bounded"
            ? `病位“${locationLabel}”仅有${(location.details as unknown[]).length}条互相独立且可逐字回溯的本例依据`
            : "本例记录中没有可稳定归属的病位及其依据";
        lowerEvidenceConfidence(location.evidence);
      }
    }

    const nature = pathogenesis?.natureDifferentiation && typeof pathogenesis.natureDifferentiation === "object" && !Array.isArray(pathogenesis.natureDifferentiation)
      ? pathogenesis.natureDifferentiation as Record<string, unknown>
      : null;
    if (nature) {
      for (const key of ["items", "rootDeficiency", "branchExcess"] as const) {
        nature[key] = semanticItems(nature[key]);
      }
      // 病性栏放的是属性词(气虚/血瘀/寒/热)。写成机理句(胃失和降、气机郁滞)的条目是填错栏位:
      // 同一临床内容已经完整保留在 overallPathogenesis 与 pathogenesis.chain 中。这里只删除
      // 错栏条目,不改写、不新增任何病性;删空后由下面的 resolution 归一化自动降级为 unresolved。
      nature.items = (nature.items as string[]).filter((item) => !NATURE_MECHANISM_PHRASE.test(item));
      const groundedBasis = groundedQuote(nature.basis);
      nature.basis = groundedBasis || "";
      const hasClassification = ["items", "rootDeficiency", "branchExcess"].some((key) => (nature[key] as unknown[]).length > 0);
      const requested = resolutionValue(nature.resolution);
      const finalResolution: ClinicalResolutionValue = !hasClassification
        ? "unresolved"
        : requested === "resolved" && Boolean(groundedBasis) ? "resolved" : "bounded";
      nature.resolution = finalResolution;
      if (finalResolution === "resolved") delete nature.resolutionReason;
      else {
        const natureLabel = joinClinicalClauses([...new Set([
          ...(nature.items as string[]),
          ...(nature.rootDeficiency as string[]),
          ...(nature.branchExcess as string[]),
        ])], "、") || "未定";
        nature.resolutionReason = typeof nature.resolutionReason === "string" && nature.resolutionReason.trim()
          ? nature.resolutionReason.trim()
          : finalResolution === "bounded"
            ? `病性“${natureLabel}”缺少可逐字回溯的本例依据，暂不能标记为已解决`
            : "本例记录中没有可稳定归纳的病性及其依据";
        lowerEvidenceConfidence(nature.evidence);
      }
    }

    if (Array.isArray(pathogenesis?.symptomClusters)) {
      pathogenesis.symptomClusters = pathogenesis.symptomClusters.flatMap((rawCluster) => {
        if (!rawCluster || typeof rawCluster !== "object" || Array.isArray(rawCluster)) return [];
        const cluster = rawCluster as Record<string, unknown>;
        if (typeof cluster.mechanism !== "string" || !cluster.mechanism.trim()) return [];
        const symptoms = Array.isArray(cluster.symptoms)
          ? [...new Map(cluster.symptoms.flatMap((item) => {
              const quote = groundedQuote(item);
              const key = quote.normalize("NFKC").replace(/[\s，,。；;：:、→+_-]+/g, "");
              return quote && key ? [[key, quote] as const] : [];
            })).values()]
          : [];
        return symptoms.length > 0 ? [{ ...cluster, symptoms, mechanism: cluster.mechanism.trim() }] : [];
      });
    }
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

const M03_LOCATION_QUALITY_DIMENSIONS = [
  /舌|苔/,
  /脉/,
  /大便|排便|便秘|便溏|下利|泄泻/,
  /小便|排尿|尿色|尿量|尿频|尿急/,
  /恶寒|恶热|怕冷|怕热|发热|寒热/,
  /汗出|无汗|自汗|盗汗|大汗/,
  /睡眠|入睡|早醒|夜醒|失眠/,
  /胃口|食欲|进食|纳差|不欲食/,
] as const;

const M03_COLD_HEAT_QUALITY_DIMENSIONS = [
  /面色|两颧|目赤|精神|神志/,
  /口鼻气|气息|呼吸急促/,
  /舌|苔/,
  /脉/,
  /胸|腹|心下|喜按|拒按/,
  /小便|排尿|尿色|尿量|尿频|尿急/,
  /口渴|不渴|欲饮|不欲饮|喜冷饮|喜热饮/,
  /大便|排便|便秘|便溏|下利|泄泻/,
  /恶寒|恶热|怕冷|怕热|发热|寒热/,
  /汗出|无汗|自汗|盗汗|大汗/,
] as const;

function m03QualityDimensionCount(text: string, dimensions: readonly RegExp[]): number {
  return dimensions.filter((pattern) => pattern.test(text)).length;
}

const NONDIAGNOSTIC_WESTERN_SUPPORT = /^(?:不限定|未限定|既往体健|无特殊病史|无用药史|无过敏史|纳可|纳眠可|二便正常|大小便正常|口不渴(?:，?二便正常)?|面色正常|神清)$/;

/**
 * M03 质量门的局部降级投影。
 *
 * 这一步只做四类可逆操作：删除未接地/无鉴别力项、把 resolved 降为 bounded、
 * 从已经存在的病机链投影重复结构字段、追加医生可见的质量边界。它不新增证候、病机、
 * 治法或患者事实。真正的硬安全边界仍由 m03SafetyContractIssue 独立执行。
 */
export function applyM03AdvisoryQualityBoundaries(content: string, clinicalContext: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "diagnose") return content;
    const overview = recordValue(reasoning.overview);
    const western = recordValue(reasoning.westernDiagnosis);
    const primary = recordValue(western?.primary);
    const pathogenesis = recordValue(reasoning.pathogenesis);
    const therapy = recordValue(reasoning.therapy);
    if (!overview || !pathogenesis || !therapy) return content;

    // 需求3：诊断要出三个——西医诊断（含 ICD-10）、中医辨病、中医辨证候。中医病名因此重新成为
    // 展示字段，不能再在归一化阶段删掉。
    //
    // 此前这里写着「产品不展示中医病名」并 delete 掉该字段。提示词（要求填 tcmDiseaseName +
    // tcmDiagnosticRationale）、可见摘要（第 1747 行渲染「**中医病名**」）、结构化契约
    // （m03SemanticIssue 的 tcm_disease_rationale_missing）和界面（「辨病：」一行）都已经按需求3
    // 接好了，唯独这一句把字段在送达客户端之前删掉——实测一组公开医案跑下来，辨病推理写着
    // 「符合『不寐』病范畴」，病名本身却是空的，界面上「辨病」那一行永远不出现。
    // 该字段仍然是可选的：模型给不出稳定病名时留空，不构成门禁。

    const chain = recordList(pathogenesis.chain);
    if (primary) {
      const fallback = chiefComplaintFallbackDiagnosis(clinicalContext);
      const fallbackFacts = affirmedClinicalSourceClauses(stripClinicalTransportPrefix(fallback.fact || ""))
        .filter((fact) => !isNondiscriminatingWesternSupportingFact(fact));
      const fallbackFact = fallbackFacts[0] || "";
      const currentName = markdownCell(primary.name);
      if (
        !isDisplayableClinicalText(currentName) ||
        isAmbiguousM03WesternPrimaryLabel(currentName) ||
        /(?:风寒|风热|痰湿|湿热|气虚|血虚|阴虚|阳虚|血瘀|证$)/.test(currentName)
      ) {
        primary.name = symptomLevelWesternName(fallbackFact, fallback.name);
        primary.status = "证据有限";
        primary.confidence = "低";
      }

      const groundedFacts = semanticItems(primary.supportingFacts)
        .flatMap((fact) => exactClinicalSourceQuotes(fact, clinicalContext))
        .flatMap((fact) => affirmedClinicalSourceClauses(stripClinicalTransportPrefix(fact)))
        .filter((fact) =>
          Boolean(fact) &&
          !isNondiscriminatingWesternSupportingFact(fact) &&
          clinicalClausePolarity(fact) === "affirmed" &&
          isWesternSupportingFactPolarityAligned(fact, clinicalContext)
        );
      const documentedCurrentFacts = [
        ...documentedSymptomFieldFacts(clinicalContext),
        ...documentedObjectiveFacts(clinicalContext),
        ...documentedMaterialFacts(clinicalContext),
      ]
        .flatMap((fact) => affirmedClinicalSourceClauses(stripClinicalTransportPrefix(fact)))
        .filter((fact) =>
          Boolean(fact) &&
          !NONDIAGNOSTIC_WESTERN_SUPPORT.test(fact) &&
          !isNondiscriminatingWesternSupportingFact(fact) &&
          isWesternSupportingFactPolarityAligned(fact, clinicalContext)
        );
      const chainFact = chain
        .map((node) => markdownCell(node.patientFact))
        .find((fact) =>
          Boolean(fact) &&
          !isNondiscriminatingWesternSupportingFact(fact) &&
          isWesternSupportingFactPolarityAligned(fact, clinicalContext)
        );
      // 就诊经过分句在这里剥离：三个来源（模型依据、病历投影、病机链）汇合后只此一处，
      // 避免三条路径各写一遍判据后再分叉。剥离结果仍是病历原文的连续子串，逐字可回溯不变。
      primary.supportingFacts = uniqueClinicalFacts([
        ...groundedFacts,
        ...fallbackFacts,
        ...documentedCurrentFacts,
        ...(chainFact ? [chainFact] : []),
      ].flatMap((fact) => discriminatingWesternSupportClauses(fact)))
        .filter((fact) => !NONDIAGNOSTIC_WESTERN_SUPPORT.test(fact))
        .filter((fact) => !isNondiscriminatingWesternSupportingFact(fact))
        .map((fact) => relabelBareVitalSupportingFact(fact, clinicalContext))
        .slice(0, 6);
      if ((primary.supportingFacts as unknown[]).length === 0) {
        primary.status = "证据有限";
        primary.confidence = "低";
        primary.limitations = uniqueClinicalFacts([
          ...semanticItems(primary.limitations),
          "当前缺少可逐字回溯且具有鉴别力的西医诊断依据，西医部分仅作症状性工作判断。",
        ]).slice(0, 12);
      }
      if (!isDisplayableClinicalText(markdownCell(primary.clinicalRationale)) && (primary.supportingFacts as unknown[]).length > 0) {
        primary.clinicalRationale =
          `${String((primary.supportingFacts as unknown[])[0])}支持当前症状性工作判断；具体病因仍需结合病程、查体及必要检查鉴别。`;
      }
    }

    if (western) {
      const submittedDifferentials = deduplicateWesternDifferentials(western.differentials);
      const displayableDifferentials = submittedDifferentials.filter((item) =>
        isDisplayableClinicalText(markdownCell(item.name)) &&
        markdownCell(item.reason).length >= 4 &&
        markdownCell(item.distinguishingPoints).length >= 4
      );
      western.differentials = displayableDifferentials;
      // 下限守卫。这段过滤原本只删不判，是本文件三处同构过滤里唯一没有下限的一处——
      // 紧邻的中医鉴别分支（下方）与 supportingFacts 分支（上方）都在被删空时降级并写明原因。
      //
      // 两层代价：
      // 1) 医生看到的是「有主诊断、鉴别列表为空」，而没有任何迹象表明鉴别项是被系统删掉的，
      //    因此不会去追问——静默变短比明确降级更危险。
      // 2) 它压制了自己的检测器：m03SemanticIssue 的 western_differential_analysis_missing
      //    判据正是「任一鉴别项 reason 或 distinguishingPoints < 4 字」，而这里删掉的恰好就是它们。
      //    本函数在 m03SemanticIssue 之前运行，于是那个本该触发一轮定向修复的 T2 码永远命中不到。
      if (submittedDifferentials.length > 0 && displayableDifferentials.length === 0 && primary) {
        primary.confidence = "低";
        primary.limitations = uniqueClinicalFacts([
          ...semanticItems(primary.limitations),
          "本次未能形成可展示的西医鉴别分析，主诊断按症状性工作判断展示；请结合病程、查体与必要检查自行核对需排除的方向。",
        ]).slice(0, 12);
        lowerEvidenceConfidence(primary.evidence);
      }
    }

    const syndrome = markdownCell(overview.primarySyndrome);
    const syndromeBasis = uniqueClinicalFacts(semanticItems(overview.primarySyndromeBasis));
    overview.primarySyndromeBasis = syndromeBasis;
    const tcmDifferentials = recordList(overview.tcmDifferentials).filter((item) =>
      isDisplayableClinicalText(markdownCell(item.syndrome)) &&
      markdownCell(item.reason).length >= 4 &&
      markdownCell(item.distinguishingPoints).length >= 4
    );
    overview.tcmDifferentials = tcmDifferentials;
    if (syndrome && (syndromeBasis.length === 0 || tcmDifferentials.length === 0)) {
      overview.primarySyndromeResolution = "bounded";
      overview.primarySyndromeResolutionReason = tcmDifferentials.length === 0
        ? "现有资料尚不足以完成相近证型的稳定鉴别，当前证型按有界建议展示。"
        : "当前证型可逐字回溯的本例依据仍有限，按有界建议展示。";
      lowerEvidenceConfidence(overview.evidence);
    }

    const location = recordValue(pathogenesis.locationDifferentiation);
    if (location?.resolution === "resolved") {
      const basis = recordList(location.details).map((item) => markdownCell(item.basis)).filter(Boolean).join("；");
      if (m03QualityDimensionCount(basis, M03_LOCATION_QUALITY_DIMENSIONS) < 2) {
        location.resolution = "bounded";
        location.resolutionReason = "病位归纳目前只有单一证据维度支持，已按有界建议展示。";
        lowerEvidenceConfidence(location.evidence);
      }
    }
    const nature = recordValue(pathogenesis.natureDifferentiation);
    if (nature?.resolution === "resolved") {
      const labels = [
        ...semanticItems(nature.items),
        ...semanticItems(nature.rootDeficiency),
        ...semanticItems(nature.branchExcess),
      ].join("；");
      const basis = markdownCell(nature.basis);
      if (/寒|热|火|温|凉/.test(labels) &&
          m03QualityDimensionCount(basis, M03_COLD_HEAT_QUALITY_DIMENSIONS) < 2) {
        nature.resolution = "bounded";
        nature.resolutionReason = "寒热病性目前缺少两个以上相互独立的证据维度，已按有界建议展示。";
        lowerEvidenceConfidence(nature.evidence);
      }
    }

    const projectedSubTherapies = chain.flatMap((node, index) => {
      const therapyDirection = markdownCell(node.therapyDirection);
      const targetPathogenesis = markdownCell(node.pathogenesis);
      const evidence = recordValue(node.evidence) || recordValue(overview.evidence) || {
        evidenceLevel: "model_inference",
        source: "既有病机链的确定性投影",
        confidence: "低",
      };
      return therapyDirection && targetPathogenesis
        ? [{
            therapy: therapyDirection,
            targetPathogenesis,
            priority: index === 0 ? "主要" : "次要",
            evidence,
          }]
        : [];
    });
    const existingSubTherapies = recordList(therapy.subTherapies);
    if (projectedSubTherapies.length > 0 && (
      existingSubTherapies.length === 0 ||
      existingSubTherapies.some((item) =>
        !markdownCell(item.therapy) || !markdownCell(item.targetPathogenesis))
    )) {
      therapy.subTherapies = projectedSubTherapies;
    }

    for (const node of chain) {
      if (narrativeFingerprint(node.patientFact) !== narrativeFingerprint(node.syndromeEvidence)) continue;
      const replacement = syndromeBasis.find((basis) =>
        narrativeFingerprint(basis) &&
        narrativeFingerprint(basis) !== narrativeFingerprint(node.patientFact)
      );
      if (replacement) node.syndromeEvidence = replacement;
    }

    const strictIssue = m03SemanticIssue(reasoning, clinicalContext);
    const projectedQualityBoundary = [
      markdownCell(overview.primarySyndromeResolutionReason),
      markdownCell(location?.resolutionReason),
      markdownCell(nature?.resolutionReason),
    ].some((value) => /有界|证据维度|依据仍有限/.test(value));
    if (strictIssue || projectedQualityBoundary) {
      const westernOnly = typeof strictIssue === "string" && /^western_|^clinical_wording_/.test(strictIssue);
      const item = westernOnly ? "西医诊断依据边界" : "辨证推理质量边界";
      const reason = westernOnly
        ? "西医部分存在依据完整性或表述层面的不足，已与中医辨证解耦并按有界建议展示。"
        : "部分支撑说明、分类或鉴别深度仍不充分；已保留可回溯的患者事实、工作证候及病机治法。";
      const uncertainties = recordList(pathogenesis.uncertainties).filter((row) => markdownCell(row.item) !== item);
      pathogenesis.uncertainties = [...uncertainties, {
        item,
        reason,
        affects: westernOnly
          ? "影响西医工作诊断的置信度，不影响已通过事实核验的中医辨证部分。"
          : "影响结论深度与鉴别把握，不影响风险筛查和已回溯患者事实。",
      }].slice(0, 12);
    }

    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

const NON_TCM_EVIDENCE_GAP = /(?:缺乏|缺少|未做|未查|尚无|待查|未完善)[^，,。；;]{0,18}(?:CT|MRI|影像|化验|实验室|量表|评分|内镜|彩超|超声|血常规|生化|HbA1c|腹诊|腹部触诊)/i;

/**
 * Modern tests and generic examination gaps may belong in western differential planning, but they
 * must not become the stated reason why an otherwise bounded TCM analysis cannot be formed. This
 * pass rewrites only explanatory projections from conclusions and verbatim facts the model already
 * supplied; it never invents a syndrome, location, nature or pathogenesis node.
 */
export function normalizeM03TcmRationaleEvidenceBoundary(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "diagnose") return content;
    const overview = recordValue(reasoning.overview);
    const pathogenesis = recordValue(reasoning.pathogenesis);
    if (!overview || !pathogenesis) return content;
    const currentRationale = markdownCell(overview.tcmDiagnosticRationale);
    if (NON_TCM_EVIDENCE_GAP.test(currentRationale)) {
      const basis = semanticItems(overview.primarySyndromeBasis).map(markdownCell).filter(Boolean).slice(0, 3);
      const disease = clinicalClauseText(markdownCell(overview.tcmDiseaseName)) || "当前中医工作病名";
      const syndrome = clinicalClauseText(markdownCell(overview.primarySyndrome)) || "当前工作证候";
      const mechanism = clinicalClauseText(markdownCell(overview.overallPathogenesis));
      overview.tcmDiagnosticRationale = clinicalSentence([
        `结合${basis.length > 0 ? joinClinicalClauses(basis, "、") : "当前已记录的阳性表现"}，中医工作病名考虑${disease}，主证候倾向${syndrome}`,
        mechanism ? `现有事实支持的病机以${mechanism}为限` : "病机深度按现有事实保守表达",
      ], "；");
    }
    if (NON_TCM_EVIDENCE_GAP.test(markdownCell(overview.primarySyndromeResolutionReason))) {
      overview.primarySyndromeResolutionReason = "当前证候基于已记录的阳性表现形成有限判断，未取得的资料仅限制结论深度";
    }
    const location = recordValue(pathogenesis.locationDifferentiation);
    if (location && NON_TCM_EVIDENCE_GAP.test(markdownCell(location.resolutionReason))) {
      location.resolutionReason = "现有阳性事实不足以进一步定位病位，当前保持未决";
    }
    const nature = recordValue(pathogenesis.natureDifferentiation);
    if (nature && NON_TCM_EVIDENCE_GAP.test(markdownCell(nature.resolutionReason))) {
      nature.resolutionReason = "现有阳性事实不足以进一步归纳病性，当前保持未决";
    }
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

/**
 * Keep the duplicated pathogenesis summary as a deterministic projection of the authoritative
 * overall pathogenesis. This removes a second model-authored reasoning surface before contract
 * validation without adding or changing any clinical conclusion.
 */
export function normalizeM03PathogenesisSummaryProjection(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "diagnose") return content;
    const overview = recordValue(reasoning.overview);
    const pathogenesis = recordValue(reasoning.pathogenesis);
    const overallPathogenesis = overview ? markdownCell(overview.overallPathogenesis) : "";
    if (!pathogenesis || !overallPathogenesis) return content;
    // Prefer the already-grounded chain mechanisms. `overallPathogenesis` is still a model-owned
    // conclusion and can be broader than the individual reviewed nodes; copying it verbatim into
    // summary can duplicate that overreach and trap a repair loop on the redundant field. A joined
    // chain projection removes that second surface while retaining every established node.
    const chainProjection = joinClinicalClauses([...new Set(recordList(pathogenesis.chain)
      .map((node) => markdownCell(node.pathogenesis))
      .filter((value) => value && !isUnstableM03CoreText(value)))], "；");
    const projection = chainProjection || overallPathogenesis;
    if (markdownCell(pathogenesis.summary) === projection) return content;
    pathogenesis.summary = projection;
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

/**
 * Apply only reviewer-requested projection declassification that cannot add a clinical decision.
 * Summary drift is reduced to the already-reviewed overall pathogenesis; unsupported optional
 * location/nature classifications are cleared to unresolved. Any other review issue must stay on
 * the normal model-repair/fail-closed path.
 */
export function applyM03ProjectionOnlyReviewRepair(content: string, issueCodes: readonly string[]): string {
  const allowed = new Set(["pathogenesis_summary_drift", "location_unsupported", "nature_unsupported"]);
  const codes = [...new Set(issueCodes.filter(Boolean))];
  if (codes.length === 0 || codes.some((code) => !allowed.has(code))) return content;
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "diagnose") return content;
    const overview = recordValue(reasoning.overview);
    const pathogenesis = recordValue(reasoning.pathogenesis);
    if (!overview || !pathogenesis) return content;
    if (codes.includes("pathogenesis_summary_drift")) {
      const projected = normalizeM03PathogenesisSummaryProjection(content);
      if (projected !== content) {
        const projectedStart = projected.indexOf(START_MARKER);
        const projectedEnd = projectedStart >= 0 ? projected.indexOf(END_MARKER, projectedStart + START_MARKER.length) : -1;
        if (projectedStart < 0 || projectedEnd < 0) return content;
        const projectedReasoning = JSON.parse(projected.slice(projectedStart + START_MARKER.length, projectedEnd).trim()) as Record<string, unknown>;
        const projectedPathogenesis = recordValue(projectedReasoning.pathogenesis);
        if (!projectedPathogenesis) return content;
        pathogenesis.summary = projectedPathogenesis.summary;
      }
    }
    if (codes.includes("location_unsupported")) {
      const location = recordValue(pathogenesis.locationDifferentiation) || {};
      pathogenesis.locationDifferentiation = {
        ...location,
        items: [],
        details: [],
        resolution: "unresolved",
        resolutionReason: "独立临床复核判定原病位依据不足，已撤回病位分类",
        ...(recordValue(location.evidence)
          ? { evidence: { ...recordValue(location.evidence), confidence: "低" } }
          : {}),
      };
    }
    if (codes.includes("nature_unsupported")) {
      const nature = recordValue(pathogenesis.natureDifferentiation) || {};
      pathogenesis.natureDifferentiation = {
        ...nature,
        items: [],
        rootDeficiency: [],
        branchExcess: [],
        basis: "",
        resolution: "unresolved",
        resolutionReason: "独立临床复核判定原病性依据不足，已撤回病性分类",
        ...(recordValue(nature.evidence)
          ? { evidence: { ...recordValue(nature.evidence), confidence: "低" } }
          : {}),
      };
    }
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

/**
 * 煎服方式按方剂性质分档（2026-08-05）。
 *
 * 判据只读**已签名 M03 治法**与候选自身的 therapyMatch，两者都在签名信封内；不读 caseState，
 * 不调模型，不新增任何知识。治法→煎法的对应是中药学教材层面的确定性关系：
 *   · 解表/透疹/宣肺类：药性轻扬走表，久煎则气散失效。《温病条辨》银翘散原方即注
 *     「香气大出，即取服，勿过煮」。故短浸短煎、武火、温服取汗、得汗即止。
 *   · 补益/滋填类：药多厚味质重，需文火久煎方能出味。故长浸久煎、饭前空腹温服。
 *   · 攻下类：中病即止，不宜多服久服。
 *   · 其余：常规煎法（即原有默认），行为与改动前一致。
 * 判不出方剂性质时一律落到常规档——不猜，不外推。
 */
function decoctionProfileFromSignedTherapy(
  reasoning: Record<string, unknown>,
  candidate: Record<string, unknown>,
): { id: string; soakMinutes: number; firstMinutes: number; secondMinutes: number; heat: string; administration: string } {
  const therapy = recordValue(reasoning.therapy);
  const signed = [
    typeof therapy?.overallMethod === "string" ? therapy.overallMethod : "",
    typeof therapy?.overallPrinciple === "string" ? therapy.overallPrinciple : "",
    typeof candidate.therapyMatch === "string" ? candidate.therapyMatch : "",
  ].join("；");
  const REGULAR = {
    id: "regular",
    soakMinutes: 30,
    firstMinutes: 30,
    secondMinutes: 20,
    heat: "武火煮沸后转文火",
    administration: "饭后温服；服药与进餐间隔按患者胃肠耐受及院内规范执行",
  };
  if (!signed.trim()) return REGULAR;
  if (/(?:解表|发汗|疏风|透疹|宣肺|辛凉|辛温|疏散外邪|解肌)/.test(signed)) {
    return {
      id: "exterior_releasing",
      soakMinutes: 20,
      firstMinutes: 15,
      secondMinutes: 10,
      heat: "武火急煎，沸后即计时，不宜久煎",
      administration: "温服，服后可少进热粥、加衣覆被以助微汗；以遍身微汗为度，得汗即停后服，不必尽剂",
    };
  }
  if (/(?:补益|补气|补血|补虚|滋阴|滋补|温阳|益气|养血|填精|健脾益气|培元|扶正)/.test(signed)) {
    return {
      id: "tonifying",
      soakMinutes: 60,
      firstMinutes: 45,
      secondMinutes: 30,
      heat: "武火煮沸后转文火慢煎",
      administration: "饭前空腹温服，以利吸收；虚不受补或胃脘不适者改为饭后服",
    };
  }
  if (/(?:攻下|泻下|通腑|荡涤|峻下)/.test(signed)) {
    return {
      id: "purgative",
      soakMinutes: 30,
      firstMinutes: 20,
      secondMinutes: 15,
      heat: "武火煮沸后转文火",
      administration: "空腹温服；以大便通畅为度，得利即停后服，不可连服久服",
    };
  }
  return REGULAR;
}

/**
 * 治则确定性补齐（2026-08-05）。
 *
 * 甲方实测：辨证已经明确，「治则」栏却写着「暂不锁定剂量级治法」——这是一句**工程占位串**
 * （DEFAULT_THERAPY 的兜底值），本意用于安全降级路径，却在模型未填 overallPrinciple 时
 * 直落到医生眼前。20 例线上语料 19 例命中，等于这一栏几乎从未给出过真正的治则。
 *
 * 治则与治法是两层：治法是具体的（健脾益气、渗湿止泻），治则是战略层的（扶正、祛邪、
 * 标本兼治）。治则可由**已签名病性辨证**确定性推出，不需要模型再判一次：
 *   · 标本俱见（rootDeficiency 与 branchExcess 皆非空）⇒ 标本兼治，扶正祛邪
 *   · 纯虚 ⇒ 扶正补虚    · 纯实 ⇒ 祛邪治标
 * 病性未定（resolution=unresolved 或两侧皆空）时不编造治则，改写成临床可读的等待语，
 * 而不是工程占位串——医生看到的每一句都应该是临床语言。
 */
/**
 * 总体病机不得是病历事实的复述（2026-08-05，甲方 3.2）。
 *
 * 甲方截图里的「总体病机」写着：**「病历已记录腹泻，排解不畅。」**——这是一条病历事实
 * 加一句服务端极性模板，不是病机。病机要回答「为什么会这样」（脾失健运、湿浊内生、
 * 清浊不分），而不是把主诉换个说法再说一遍。
 *
 * 判据是确定性的、只看形态不猜语义：
 *  · 以服务端事实模板开头（病历已记录/病历尚未确认/患者诉/病历记载…）⇒ 不是病机；
 *  · 通篇不含任何受控病性或病机动词（虚/实/寒/热/湿/瘀/滞/郁/亏/失健/上逆/不固…）
 *    ⇒ 只是症状复述，不是病机。
 * 命中时不编造病机，改写成明确的待补充说明——让医生知道这一栏没有结论，
 * 而不是把一句病历原文当成病机读下去。
 */
/**
 * 总体病机这一栏该怎么处置：替换 / 加批注 / 原样。
 *
 * 【为什么分三档】原实现只有「替换」一档，判据是一张 38 字病机动词表，不含表内字就整段
 * 换成「现有四诊与病史尚不足以形成可采纳的总体病机」。实测被换掉的全是规范病机表述——
 * 营卫不和（表里是「失和」不是「不和」）、肝气犯胃、心神不宁、胃气不降、冲任失调、
 * 肝阳化风、气机升降失常。模型写了教科书级病机，医生读到的是「资料不足」。
 *
 * 【三档的依据各不相同】
 *  · replace —— 只针对**服务端自己生成**的形态：事实模板原样回抛，或逐字复述病历
 *    （narrativeMostlyCopies，与合同侧 overall_pathogenesis_restates_facts 同一条判据）。
 *    这两种都能机检，替换是安全的。
 *  · annotate —— 「这段有没有病机要素」是语义判断，规则做不好。既不装作它合格，
 *    也不把模型写的东西销毁：原文保留 + 一句明说的服务端提示，最终由医生判断。
 *  · keep —— 命中受治理病机谓词（NATURE_MECHANISM_PHRASE，与合同侧共用同一导出）。
 */
function overallPathogenesisDisposition(
  value: unknown, facts: readonly string[],
): "replace" | "annotate" | "keep" {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "keep";
  if (/^(?:病历已记录|病历尚未确认|病历记载|患者诉|患者自述|现病史记录|本例记录)/.test(text)) return "replace";
  if (narrativeMostlyCopies(text, facts)) return "replace";
  return MECHANISM_PREDICATE.test(text) ? "keep" : "annotate";
}

const PATHOGENESIS_NOT_ESTABLISHED =
  "现有四诊与病史尚不足以形成可采纳的总体病机，请补充关键问诊后复核（本栏不采用主诉复述代替病机）。";
const PATHOGENESIS_NO_MECHANISM_NOTE = "（服务端提示：本栏未见病机要素，请医生核定是否需要补充病机推演）";

/**
 * 临床事实状态模板只能用于事实展示，不能混入病机结论。
 * 保留同句中已经成立的病机，只切掉「病历已记录…阳性/阴性」这一事实尾巴。
 */
function stripEmbeddedClinicalFactStatus(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/(?:[，,；;]\s*)?病历已记录[^。；;\n]{1,160}(?=[。；;\n]|$)[。；;]?/g, "")
    .replace(/[，,；;。]+\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 中医病名必须是**单一病名**，辨病推理不得是循环套话（2026-08-05，甲方 2.1）。
 *
 * 甲方实测输出：病名写成「头痛/头风病」，推理写成
 *   「患者以头痛为主要症状，符合中医头痛/头风病诊断标准，故诊断头痛/头风病」
 * 两处都是形式问题，不涉及临床判断：
 *  · 斜杠并列两个病名 = 辨病没有落定。中医书写惯例主病名在前，取首个受治理病名即可；
 *    被去掉的那个不是丢失——它本就该出现在辨病鉴别里，而不是塞进病名字段。
 *  · 「符合 X 诊断标准，故诊断 X」是同义反复，读完仍不知道凭什么判这个病。
 *    服务端不替模型编造依据（那会造出病历里没有的事实），但必须把这句话标成
 *    「未给出实质辨病依据」，让医生知道这一栏没有结论可采信。
 */
const diseaseIsCircularGuardEnabled = true;

function singleGovernedDiseaseName(value: unknown): { name: string; dropped: string[] } | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || !/[/／、|]/.test(text)) return undefined;
  const segments = text.split(/[/／、|]/).map((item) => item.trim()).filter(Boolean);
  if (segments.length < 2) return undefined;
  const governed = segments.filter((item) => isGovernedTcmDiseaseName(item));
  if (governed.length === 0) return undefined;
  return { name: governed[0], dropped: segments.filter((item) => item !== governed[0]) };
}

function diseaseRationaleIsCircular(value: unknown, diseaseName: string): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || !diseaseName) return false;
  // 去掉「以X为主要症状」「符合…诊断标准」「故诊断X」这三段模板后还剩多少实质内容。
  const stripped = text
    // 「以X为主要症状」里的 X 是**辨病依据本身**，只能剥框架、不能连 X 一起剥。
    // 原实现整段删除，于是「患者以多饮多尿为主要症状，伴形体消瘦，故诊断为消渴」
    // 剩下「伴形体消瘦」5 字 < 8，被判成同义反复，医生看到的是
    // 「本次输出未给出「消渴」的实质辨病依据」——而多饮多尿正是消渴的诊断依据。
    .replace(/患者?以([^，,。；;]{1,24})为(?:主要)?症状/g, "$1")
    .replace(/符合(?:中医)?[^，,。；;]{0,24}诊断标准[，,。；;]?/g, "")
    .replace(/故(?:可)?诊断(?:为)?[^，,。；;]{0,24}[，,。；;]?/g, "")
    .replace(new RegExp(diseaseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "")
    .replace(/[，,。；;、\s]/g, "");
  return stripped.length < 8;
}

export function applyDeterministicTreatmentPrinciple(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "diagnose") return content;
    // therapy 缺失时也要能改写病机,故不再早退;新建的 therapy 必须挂回 reasoning,
    // 否则后面的赋值写在游离对象上、输出里看不到。
    const therapy = recordValue(reasoning.therapy) || (reasoning.therapy = {} as Record<string, unknown>, recordValue(reasoning.therapy)!);
    // 总体病机被写成病历事实复述时改写成待补充说明（甲方 3.2）。与治则补齐同一道归一，
    // 两者都是「医生看到的每一句都应该是临床语言」的同一件事。
    const overview = recordValue(reasoning.overview);
    // 甲方 2.1:病名并列与循环套话。两条都只改形式,不替模型编造辨病依据。
    if (overview) {
      const single = singleGovernedDiseaseName(overview.tcmDiseaseName);
      if (single) {
        const original = String(overview.tcmDiseaseName || "");
        overview.tcmDiseaseName = single.name;
        if (typeof overview.tcmDiseaseRationale === "string") {
          overview.tcmDiseaseRationale = overview.tcmDiseaseRationale.split(original).join(single.name);
        }
      }
      const diseaseName = typeof overview.tcmDiseaseName === "string" ? overview.tcmDiseaseName.trim() : "";
      if (diseaseIsCircularGuardEnabled && diseaseRationaleIsCircular(overview.tcmDiseaseRationale, diseaseName)) {
        overview.tcmDiseaseRationale =
          `本次输出未给出「${diseaseName}」的实质辨病依据（原文为同义反复），请医生结合主症与病程形态自行核定病名。`;
      }
    }
    const pathogenesis = recordValue(reasoning.pathogenesis);
    if (overview && typeof overview.overallPathogenesis === "string") {
      overview.overallPathogenesis = stripEmbeddedClinicalFactStatus(overview.overallPathogenesis);
    }
    if (pathogenesis) {
      if (typeof pathogenesis.summary === "string") {
        pathogenesis.summary = stripEmbeddedClinicalFactStatus(pathogenesis.summary);
      }
      const relationship = recordValue(pathogenesis.caseRelationship);
      if (relationship && typeof relationship.relationship === "string") {
        relationship.relationship = stripEmbeddedClinicalFactStatus(relationship.relationship);
      }
      for (const node of recordList(pathogenesis.chain)) {
        if (typeof node.pathogenesis === "string") {
          node.pathogenesis = stripEmbeddedClinicalFactStatus(node.pathogenesis);
        }
      }
    }
    if (overview) {
      // 事实面与合同侧 m03SemanticIssue 取材一致，判据也一致。
      // recordList 只收**对象**数组（它对每一项跑 recordValue），字符串数组会被整个丢成 []。
      // 这里三个取材有两个是字符串数组，用错就等于事实面全空、判据被架空——
      // 那样「逐字复述病历」也会一路放行，比原来的字表还松。
      const stringList = (value: unknown): string[] => (Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        : []);
      const pathogenesisFactSurface = [
        ...stringList(overview.primarySyndromeBasis),
        ...stringList(recordValue(recordValue(reasoning.westernDiagnosis)?.primary)?.supportingFacts),
        ...recordList(recordValue(reasoning.pathogenesis)?.chain)
          .map((item) => String(item.patientFact || "")),
      ].filter(Boolean);
      const disposition = overallPathogenesisDisposition(overview.overallPathogenesis, pathogenesisFactSurface);
      if (disposition === "replace") {
        overview.overallPathogenesis = PATHOGENESIS_NOT_ESTABLISHED;
      } else if (disposition === "annotate") {
        const text = String(overview.overallPathogenesis || "").trim();
        // 幂等：批注只加一次。
        if (text && !text.endsWith(PATHOGENESIS_NO_MECHANISM_NOTE)) {
          overview.overallPathogenesis = `${text}${PATHOGENESIS_NO_MECHANISM_NOTE}`;
        }
      }
    }
    const current = typeof therapy.overallPrinciple === "string" ? therapy.overallPrinciple.trim() : "";
    // 只接管占位串、空值与无本例信息的泛化类别；模型自己写出的实质治则原样保留。
    if (current && !/^(?:暂不锁定剂量级治法|暂不锁定|待定|由服务端生成|正治法?|反治法?|治疗本病)$/.test(current)) {
      return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
    }

    const nature = recordValue(pathogenesis?.natureDifferentiation);
    const list = (value: unknown): string[] => (Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : []);
    const root = list(nature?.rootDeficiency);
    const branch = list(nature?.branchExcess);
    const items = list(nature?.items);
    const DEFICIENCY = /(?:气虚|血虚|阴虚|阳虚|精亏|不足|亏虚|虚弱|虚损|两虚)/;
    const EXCESS = /(?:实|热|火|寒|湿|痰|饮|瘀|滞|郁|积|毒|风|燥|水停)/;
    const hasDeficiency = root.length > 0 || items.some((item) => DEFICIENCY.test(item));
    const hasExcess = branch.length > 0 || items.some((item) => EXCESS.test(item) && !DEFICIENCY.test(item));

    const hasCold = items.some((item) => /寒/.test(item)) && !items.some((item) => /热|火/.test(item));
    const hasHeat = items.some((item) => /热|火/.test(item)) && !items.some((item) => /寒/.test(item));
    const principle = hasCold
      ? "寒者热之，温散祛邪"
      : hasHeat
        ? "热者寒之，清解祛邪"
        : hasDeficiency && hasExcess
      ? "标本兼治，扶正祛邪"
      : hasDeficiency
        ? "扶正补虚，固本培元"
        : hasExcess
          ? "祛邪治标，邪去正安"
          : "";
    therapy.overallPrinciple = principle || "病性尚未分明，治则待补充四诊后确定";
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

export function applyDeterministicDecoctionMethod(content: string, clinicalContext: string, patientAgeYears?: number): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "prescribe") return content;
    const formula = reasoning.formula && typeof reasoning.formula === "object" && !Array.isArray(reasoning.formula)
      ? reasoning.formula as Record<string, unknown>
      : null;
    const candidates = Array.isArray(formula?.candidates) ? formula.candidates : [];
    const ageLiteral = String.raw`(-?\d{1,4}(?:\.\d+)?\s*(?:岁(?:\s*\d{1,4}(?:\.\d+)?\s*(?:个月|月龄))?|个月|月龄))`;
    const normalizedContext = clinicalContext.normalize("NFKC");
    const contextLiteral = normalizedContext.match(new RegExp(`(?:^|[。；;\\n])\\s*(?:(?:患者|病人)\\s*)?年龄\\s*[:：]?\\s*${ageLiteral}`))?.[1]
      || normalizedContext.match(new RegExp(`(?:^|[。；;\\n])\\s*(?:患者|病人|患儿|男童|女童)\\s*(?:为|系|是|约|，|,)?\\s*${ageLiteral}`))?.[1]
      || normalizedContext.match(new RegExp(`(?:^|[。；;\\n])\\s*${ageLiteral}\\s*(?=男童|女童|患儿|患者|病人|[，,]\\s*(?:因|主诉|就诊|反复|出现|有|无|患))`))?.[1]
      || "";
    const yearMatch = contextLiteral.match(/(-?\d+(?:\.\d+)?)\s*岁(?:\s*(-?\d+(?:\.\d+)?)\s*(?:个月|月龄))?/);
    const monthMatch = !yearMatch ? contextLiteral.match(/(-?\d+(?:\.\d+)?)\s*(?:个月|月龄)/) : null;
    const contextAge = yearMatch
      ? Number(yearMatch[1]) + Number(yearMatch[2] || 0) / 12
      : monthMatch
        ? Number(monthMatch[1]) / 12
        : undefined;
    const age = typeof patientAgeYears === "number" && Number.isFinite(patientAgeYears) && patientAgeYears >= 0 && patientAgeYears <= 120
      ? patientAgeYears
      : contextAge;
    const finalVolume = typeof age === "number" && Number.isFinite(age) && age >= 0 && age < 18 ? 200 : 500;
    for (const rawCandidate of candidates) {
      if (!rawCandidate || typeof rawCandidate !== "object" || Array.isArray(rawCandidate)) continue;
      const candidate = rawCandidate as Record<string, unknown>;
      if (!candidate.decoction || typeof candidate.decoction !== "object" || Array.isArray(candidate.decoction)) continue;
      const decoction = candidate.decoction as Record<string, unknown>;
      const dosesPerDay = typeof decoction.dosesPerDay === "number" && Number.isInteger(decoction.dosesPerDay)
        ? decoction.dosesPerDay
        : undefined;
      const administrationTimesPerDay =
        typeof decoction.administrationTimesPerDay === "number" && Number.isInteger(decoction.administrationTimesPerDay)
          ? decoction.administrationTimesPerDay
          : undefined;
      if (
        dosesPerDay == null ||
        dosesPerDay < 1 ||
        dosesPerDay > 3 ||
        administrationTimesPerDay == null ||
        administrationTimesPerDay < dosesPerDay ||
        administrationTimesPerDay > 6
      ) continue;
      // 煎法随方剂性质走，不再一张模板打天下(2026-08-05)。
      //
      // 原实现把模型写的煎服法**整段覆盖**为固定串：一律浸泡30分钟、一煎30分钟、二煎20分钟，
      // 只有药液量随年龄变。甲方连试数例发现煎服方式完全一样——确实一样，是代码写死的。
      // 而解表剂与补益剂的煎法在中医里是相反的：银翘散「香气大出即取服，勿过煮」，
      // 补益剂则要文火久煎取其厚味。用同一张模板等于把这条基本用药常识抹平了。
      //
      // 推导源是**已签名治法**，不是模型自由发挥，也不新增知识：治法词表是受控的(1276 条)，
      // 治法与煎法的对应是中药学教材层面的确定性关系。方剂性质判不出来时退回常规煎法。
      const profile = decoctionProfileFromSignedTherapy(reasoning, candidate);
      decoction.method = `每日${dosesPerDay}剂；加冷水浸泡${profile.soakMinutes}分钟，${profile.heat}；`
        + `一煎${profile.firstMinutes}分钟、二煎${profile.secondMinutes}分钟；两煎合并药液约${finalVolume}mL；`
        + `每日分${administrationTimesPerDay}次服，${profile.administration}；特殊药味按药味表执行`;
      delete decoction.dailyDoseCount;
      decoction.soakMinutes = profile.soakMinutes;
      decoction.decoctionTimes = 2;
      decoction.firstDecoctionMinutes = profile.firstMinutes;
      decoction.secondDecoctionMinutes = profile.secondMinutes;
      decoction.targetVolumeMl = finalVolume;
      decoction.decoctionProfile = profile.id;
      decoction.administration = `每日${dosesPerDay}剂，每日分${administrationTimesPerDay}次服，${profile.administration}`;
    }
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

export function applyDeterministicFollowUpNode(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "prescribe") return content;
    const formula = reasoning.formula && typeof reasoning.formula === "object" && !Array.isArray(reasoning.formula)
      ? reasoning.formula as Record<string, unknown>
      : null;
    for (const rawCandidate of Array.isArray(formula?.candidates) ? formula.candidates : []) {
      if (!rawCandidate || typeof rawCandidate !== "object" || Array.isArray(rawCandidate)) continue;
      const candidate = rawCandidate as Record<string, unknown>;
      if (!candidate.decoction || typeof candidate.decoction !== "object" || Array.isArray(candidate.decoction)) continue;
      const decoction = candidate.decoction as Record<string, unknown>;
      const doseCount = typeof decoction.doseCount === "string" ? decoction.doseCount.trim() : "";
      const doseMatch = doseCount.match(/^(\d{1,2})\s*剂$/);
      const dosesPerDay = typeof decoction.dosesPerDay === "number" && Number.isInteger(decoction.dosesPerDay)
        ? decoction.dosesPerDay
        : undefined;
      if (doseMatch && dosesPerDay != null && dosesPerDay >= 1 && dosesPerDay <= 3) {
        const totalDoses = Number(doseMatch[1]);
        if (totalDoses % dosesPerDay !== 0) continue;
        const courseDays = totalDoses / dosesPerDay;
        decoction.course = `${courseDays}日`;
        decoction.followUpNode = `完成${doseCount.replace(/\s/g, "")}（${courseDays}日）后复诊；出现不适或症状加重时提前复诊`;
        decoction.followUpAfterDoses = totalDoses;
        decoction.followUpAfterDays = courseDays;
      }
    }
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

export function applyDeterministicHerbDecoctionRequirements(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "prescribe") return content;
    const formula = reasoning.formula && typeof reasoning.formula === "object" && !Array.isArray(reasoning.formula)
      ? reasoning.formula as Record<string, unknown>
      : null;
    for (const rawCandidate of Array.isArray(formula?.candidates) ? formula.candidates : []) {
      if (!rawCandidate || typeof rawCandidate !== "object" || Array.isArray(rawCandidate)) continue;
      const candidate = rawCandidate as Record<string, unknown>;
      for (const rawHerb of Array.isArray(candidate.herbs) ? candidate.herbs : []) {
        if (!rawHerb || typeof rawHerb !== "object" || Array.isArray(rawHerb)) continue;
        const herb = rawHerb as Record<string, unknown>;
        const name = typeof herb.name === "string" ? herb.name : "";
        const rule = decoctionRuleForHerb(name);
        if (!rule) continue;
        const current = typeof herb.decoctionRequirement === "string" ? herb.decoctionRequirement.trim() : "";
        if (decoctionRuleSatisfied(name, current)) continue;
        herb.decoctionRequirement = requiredDecoctionRequirement(name);
      }
    }
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

/**
 * @param opts.fillRolePlaceholder 只有 **finalize（修复机会已用尽）** 才可传 true。
 *
 * 甲方 2026-08-10 ⑤（黄芪）：本函数此前无条件把 `getTcmHerbFunctionDisplayText` 的结果写回，
 * 而该函数在「库里有条目但没有一条对得上本方治法」时返回角色兜底句
 * 「臣药，本方中的具体配伍作用需医生结合方义复核」——**它永远非空**。
 * 于是模型没写方义（或写得不接地）时，服务端在**契约校验之前**就替它填上了一句合法值，
 * `candidate_*_herb_*_function(_ungrounded)` 从此不可能触发，
 * structured-clinical-repair 里那段修复指导语成了永远打不到的死代码。
 * 医生看到的不是「系统让模型重写了一遍方义」，而是那句零内容套话。
 *
 * 现在分两段：契约前只写**KB 对齐串**，对不上就留空 / 留原文，让修复轮真正跑起来；
 * 角色兜底句移到路由终审之后的 finalize，只负责「不给医生一个空栏」。
 */
export function applyDeterministicHerbFunctions(
  content: string,
  opts?: { fillRolePlaceholder?: boolean },
): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "prescribe") return content;
    const formula = recordValue(reasoning.formula);
    for (const candidate of recordList(formula?.candidates)) {
      for (const herb of recordList(candidate.herbs)) {
        const name = markdownCell(herb.name);
        if (!name || !isKnownTcmHerbName(name)) continue;
        const alignedFunction = getTcmHerbFunctionDisplayText(
          name,
          markdownCell(herb.role),
          markdownCell(herb.targetPathogenesis),
          // 本方治法参与筛选：功效条目须与「本方要做什么」相关才进方义。
          // 治法可能落在 overallMethod 或 overallPrinciple(历史载荷两种都有),
          // 加上候选自身的 therapyMatch 与子治法方向,三处并取——少取一处就会把
          // 相关功效误判成无关而丢掉(实测:治法只写在 overallPrinciple 时,
          // 酸枣仁的「安神」被整条滤掉)。
          [markdownCell(recordValue(reasoning.therapy)?.overallMethod),
            markdownCell(recordValue(reasoning.therapy)?.overallPrinciple),
            ...recordList(recordValue(reasoning.therapy)?.subTherapies).map((item) => markdownCell(item.therapy)),
            markdownCell(candidate.therapyMatch)].filter(Boolean).join("；"),
          // 契约前不许回落角色兜底句——它是本条缺陷的载体，见函数头注释。
          false,
        ).trim();
        // 服务端在这里的角色是**校验**，不是覆盖。
        //
        // 原实现无条件 `herb.function = canonicalFunction`，而 canonicalFunction 永远非空
        // （对不上治法时会返回角色兜底句），于是模型写的方义 100% 被丢弃。
        // 实测（当前代码在 7461 条归档药味行上重放）：35.4% 的行最终印的是
        // 「君药，本方中的具体配伍作用需医生结合方义复核」这句零内容套话；
        // 而这 2638 条里 KB 本就没有功效条目的是 **0 条**——全部是「库里有、
        // 2-gram 逐字对齐没对上本方治法」。挑出该药哪一条功效适用于本方，
        // 正是模型比逐字对齐强的地方，把这一步交回给它。
        //
        // 安全面为零新增：保留模型文本的前提是它通过 herbFunctionMatchesKnowledge——
        // 与合同侧 candidate_*_herb_*_function_ungrounded 用的是**同一个**导出谓词，
        // 高影响方向（清热/活血/温阳/攻下）必须有该药 KB 佐证、毒性药必须提毒性。
        // 过不了就照旧回落 canonicalFunction（先 KB 对齐串、再角色兜底句）。
        const modelFunction = markdownCell(herb.function);
        if (modelFunction && herbFunctionMatchesKnowledge(
          name, modelFunction, markdownCell(herb.role), markdownCell(herb.targetPathogenesis),
        )) continue;
        if (alignedFunction) {
          herb.function = alignedFunction;
          continue;
        }
        // KB 对不上本方治法：**契约前保持原样**。空 → candidate_*_herb_*_function，
        // 有文但不接地 → _function_ungrounded，两者都是 T2 码，先走一轮修复让模型把
        // 「这味药在本方里做什么」写清楚；修不出来才由 finalize 补角色兜底句。
        if (opts?.fillRolePlaceholder) {
          herb.function = getTcmHerbFunctionDisplayText(
            name,
            markdownCell(herb.role),
            markdownCell(herb.targetPathogenesis),
            "",
          );
        }
      }
    }
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

export function applyDeterministicHerbPrescriptionRoles(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "prescribe") return content;
    const formula = recordValue(reasoning.formula);
    for (const candidate of recordList(formula?.candidates)) {
      for (const herb of recordList(candidate.herbs)) {
        const target = markdownCell(herb.targetPathogenesis);
        const currentRole = markdownCell(herb.prescriptionRole)
          .replace(/(?:^|；)\s*知识库功用[：:][\s\S]*$/, "")
          .trim();
        const meaningfulRole = /^(?:由服务端(?:知识库)?生成|待生成|待补充|待确认)$/.test(currentRole)
          ? ""
          : currentRole;
        if (target) herb.prescriptionRole = meaningfulRole || `对应${target}`;
      }
    }
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

/**
 * 方解是不是在讲**本方**。三条都是可机检的形态判据，不猜临床对错——
 * 「这段方解写得好不好」是模型与独立复核的活，这里只挡三件事：
 * 讲的不是本方、提到本方没有的药、把剂量写进方解。
 */
function formulaAnalysisIsGroundedInCandidate(text: string, candidateHerbs: readonly string[]): boolean {
  if (text.length < 24 || text.length > 1200) return false;
  if (PRECAUTION_DOSE_LIKE.test(text)) return false;
  if (/(?:具体配伍作用|具体作用).*(?:结合方义|复核)|同上述|参见前文/.test(text)) return false;
  if (/\*\*|(?:^|\s)[#*-]\s/.test(text)) return false;
  if (!/(?:(?:为|作)[君臣佐使]|君药|臣药|佐药|使药)/.test(text)) return false;
  if (!/(?:助|协同|相伍|相须|相使|一宣一降|调和|缓[^。；]{0,8}峻|佐制|反佐)/.test(text)) return false;
  const own = new Set(candidateHerbs.map((name) => name.replace(/\s+/g, "")));
  let mentioned = 0;
  for (const name of own) if (name && text.includes(name)) mentioned += 1;
  const requiredCoverage = Math.max(2, Math.ceil(own.size * 0.8));
  if (mentioned < Math.min(requiredCoverage, own.size)) return false;
  // 扫出文中所有受治理药名，必须全部属于本方。窗口 2–4 字覆盖绝大多数饮片名。
  for (let index = 0; index < text.length; index += 1) {
    for (let width = 4; width >= 2; width -= 1) {
      const token = text.slice(index, index + width);
      if (token.length < width) continue;
      if (own.has(token)) break;
      if (isKnownTcmHerbName(token)) return false;
    }
  }
  return true;
}

export function applyDeterministicFormulaAnalysis(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "prescribe") return content;
    const formula = recordValue(reasoning.formula);
    for (const candidate of recordList(formula?.candidates)) {
      const herbs = recordList(candidate.herbs);
      // 逐味成句，见 buildFormulaAnalysis 的注释：原实现按角色分组 + 每角色一句固定模板，
      // 「直治核心病机，构成本方主要治疗支点」对每一张方的君药都相同，读不出本例信息，
      // 也读不出同一病机上两味药各自承担什么。
      const analysis = buildFormulaAnalysis(
        herbs.map((herb) => ({
          name: markdownCell(herb.name),
          role: markdownCell(herb.role),
          function: markdownCell(herb.function),
          targetPathogenesis: markdownCell(herb.targetPathogenesis),
        })),
        markdownCell(candidate.therapyMatch),
      );
      // 方解交给模型写，服务端连续自然段只作**兜底**。
      //
      // 【改之前】提示词里根本没有 formulaAnalysis 这个字段——模型从没被问过方解，
      // 这一段 100% 是服务端按「病机分组 + 逐味 function」拼出来的。甲方实测的两个症状
      // （「方解仍是通用功效拼接」「桂枝出现占位复核话术」）都是这么来的：
      // 逐味 function 取不到本方作用时会回落成「君药，本方中的具体配伍作用需医生结合方义复核」，
      // 拼进方解就成了医生看到的那句占位话术。
      // 这与已经修过的逐味方义是同一个形状：服务端拼接冒充临床内容。
      //
      // 【改之后】模型写整段方解（君臣佐使如何配伍、为何这样配），
      // 确定性层只校验三条可机检项，过不了才回落到拼接版：
      //   · 必须真的在讲**本方**：至少点到本方 2 味药；
      //   · 不得提到本方没有的药（防止把别的方的方解套过来）；
      //   · 不得写剂量（剂量在药味表里，方解里出现即越权）；
      //   · 必须是连续自然段，不接受 Markdown 标题或列表。
      const authored = markdownCell(candidate.formulaAnalysis);
      const authoredHerbs = herbs.map((herb) => markdownCell(herb.name)).filter(Boolean);
      if (authored && formulaAnalysisIsGroundedInCandidate(authored, authoredHerbs)) {
        candidate.formulaAnalysis = authored;
      } else if (analysis) {
        candidate.formulaAnalysis = analysis;
      } else {
        const compositionAnalysis = recordList(candidate.compositionLogic)
          .map((item) => markdownCell(item.summary))
          .filter(isDisplayableClinicalText)
          .filter((value) => !/(?:受控目录组成|目录来源|方证定位|进入处方编译|逐项核对患者事实)/.test(value));
        if (compositionAnalysis.length > 0) candidate.formulaAnalysis = compositionAnalysis.join("；");
      }
    }
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

export function applyDeterministicHerbTargets(content: string, priorReasoning: unknown): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "prescribe") return content;
    const prior = recordValue(priorReasoning);
    const priorPathogenesis = recordValue(prior?.pathogenesis);
    const nodes = recordList(priorPathogenesis?.chain).map((node, index) => ({
      id: markdownCell(node.nodeId) || `P${index + 1}`,
      text: markdownCell(node.pathogenesis) || markdownCell(node.syndromeEvidence),
    }));
    const formula = recordValue(reasoning.formula);
    for (const candidate of recordList(formula?.candidates)) {
      for (const herb of recordList(candidate.herbs)) {
        const targetKind = markdownCell(herb.targetKind);
        const targetRef = markdownCell(herb.targetRef);
        const role = markdownCell(herb.role);
        if (targetKind === "pathogenesis_node") {
          const node = nodes.find((item) => item.id === targetRef);
          if (!node?.text) continue;
          herb.targetRef = node.id;
          herb.structureRole = null;
          herb.targetPathogenesis = node.text;
        } else if (targetKind === "formula_structure" && /^(?:佐|使)$/.test(role)) {
          const referencedNode = nodes.find((item) => item.id === targetRef);
          if (referencedNode?.text) {
            // Preserve a valid clinical P-node reference when the model mislabeled only its kind.
            // This repairs the type, not the target. Unknown P9/provider prose remains untouched and
            // is rejected by the semantic contract.
            herb.targetKind = "pathogenesis_node";
            herb.structureRole = null;
            herb.targetPathogenesis = referencedNode.text;
            continue;
          }
          const structureRole = normalizeFormulaStructureRole(herb.structureRole) ||
            normalizeFormulaStructureRole(herb.targetPathogenesis) ||
            (/^(?:佐|使)$/.test(role) ? "harmonize" : undefined);
          const target = formulaStructureTarget(structureRole);
          if (!target) continue;
          // targetRef is a protocol constant for non-clinical formula structure, not a clinical
          // decision. Once role and controlled structureRole agree, canonicalize the constant so a
          // stray P9/blank wrapper cannot discard an otherwise valid prescription. Invalid P-node
          // references under targetKind=pathogenesis_node remain untouched and fail closed.
          herb.targetRef = "FORMULA_STRUCTURE";
          herb.structureRole = structureRole;
          herb.targetPathogenesis = target;
        } else if (targetKind !== "pathogenesis_node" && targetKind !== "formula_structure") {
          // targetKind 缺失或不是受控取值(schema 会把非法值 catch 成 undefined,最终仍报
          // target_ref_missing)时,只补 targetKind/targetRef 两个接线字段。仅当本药的
          // targetPathogenesis 已经逐字等于且只等于一个 M03 病机节点文本时才回填该节点号:
          // 指向是病例自身已确定的,服务端没有做任何临床判断。指向不明(无匹配或多个匹配)时
          // 保持原样继续由合同驳回。本分支不写入任何治法或病机文本。
          const targetText = markdownCell(herb.targetPathogenesis);
          const matched = targetText ? nodes.filter((item) => item.text === targetText) : [];
          if (matched.length !== 1) continue;
          herb.targetKind = "pathogenesis_node";
          herb.targetRef = matched[0].id;
          herb.structureRole = null;
        }
      }
    }
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

export function applyDeterministicCandidateTherapyMatch(content: string, priorReasoning: unknown): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "prescribe") return content;
    const prior = recordValue(priorReasoning);
    const lockedMethod = getM03TherapyLock(prior).candidateMatch;
    if (!lockedMethod) return content;
    const formula = recordValue(reasoning.formula);
    for (const candidate of recordList(formula?.candidates)) {
      candidate.therapyMatch = lockedMethod;
    }
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

/**
 * Grounding can legitimately remove normal vitals, demographics, TCM findings, or background
 * history from Western supporting facts. If the provider rationale depended on one of those
 * removed items, rebuild only the bounded bridge between the surviving chart fact and the
 * provider-selected working diagnosis. No new disease, finding, or exclusion is introduced.
 */
export function alignNormalizedM03WesternClinicalRationale(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "diagnose") return content;
    const western = recordValue(reasoning.westernDiagnosis);
    const primary = recordValue(western?.primary);
    if (!primary || !m03WesternClinicalRationaleIssue(reasoning)) return content;

    const name = markdownCell(primary.name);
    const firstGroundedFact = semanticItems(primary.supportingFacts)[0];
    if (!isDisplayableClinicalText(name) || !isDisplayableClinicalText(firstGroundedFact)) return content;

    primary.clinicalRationale =
      `${firstGroundedFact}支持将“${name}”作为当前工作诊断；` +
      "但现有资料尚不足以确定具体病因，因此暂不采用更具体的病因标签。";
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

/**
 * 近似重复的病历事实去重：主诉与现病史常常一句包住另一句（「产后2月余，头痛反复发作1月」
 * 与「产后2月余，近1月头痛反复，劳累后加重，伴…」）。逐字包含时只保留信息更全的那条，
 * 避免同一事实在推理句里印两遍。只按**包含关系**判等，不做任何相似度猜测。
 */
function dropContainedClinicalFacts(facts: readonly string[]): string[] {
  const values = [...new Set(facts.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean))];
  return values.filter((item) => !values.some((other) => other !== item && other.includes(item)));
}

/** 病位条目 → 受控病位 ID（认规范名/别名，也认复合表述里内嵌的受控病位）。 */
function governedLocationAxisIds(item: string): string[] {
  const exact = canonicalTcmLocationTerm(item);
  if (exact) return [exact.id];
  return governedTcmLocationsInText(item).map((entry) => entry.id);
}

/** 病性条目 → 受控病性 ID。复合写法（气血亏虚）在词表里归一不到时返回空，归属整条跳过。 */
function governedNatureAxisIds(item: string): string[] {
  const exact = canonicalTcmNatureTerm(item);
  return exact ? [exact.id] : [];
}

/** 拼接前去掉引文自带的句末标点，避免拼出「…。，故辨为…」这类破碎标点。 */
function trimTrailingClinicalPunctuation(value: string): string {
  return value.replace(/[。；;，,、\s]+$/u, "");
}

/**
 * Keep the explanatory TCM rationale from becoming a second failure surface after grounding.
 * This only projects the surviving model-authored fact, syndrome and pathogenesis into one
 * readable inference sentence; it does not infer a new syndrome, location, nature or therapy.
 */
export function alignNormalizedM03TcmDiagnosticRationale(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "diagnose") return content;
    const issue = m03SemanticIssue(reasoning);
    if (issue !== "tcm_diagnostic_rationale_missing" && issue !== "tcm_diagnostic_rationale_restatement") return content;

    // 只在模型**确实没写**时才由服务端生成，不再覆盖模型写过的辨证推理。
    //
    // 这一段原先在 prepareDiagnoseStructuredContent 里无条件跑，而 prepare 早于契约校验、
    // 独立复核与修复轮。于是一旦被判 restatement，模型原文就地被模板拼接串顶掉，改写完
    // issue 变 undefined，修复轮再也不会回头找模型要——模型连一次「按提示自己重写」的
    // 机会都没有。实测被顶掉的是这样的原文：
    //   「…思虑劳倦耗伤心肝，肝不藏血则魂不守舍，心血不足则神不安宁，故辨为心肝血虚证。」
    // 病因—病机—症状因果链三段在输出里全部消失，而病因正是治法与生活调摄的直接依据。
    // 现在 restatement 交由独立复核给 repair 意见，服务端只补空白。
    const existingRationale = markdownCell(recordValue(reasoning.overview)?.tcmDiagnosticRationale);
    if (issue === "tcm_diagnostic_rationale_restatement" && isDisplayableClinicalText(existingRationale)) {
      return content;
    }

    const overview = recordValue(reasoning.overview);
    const pathogenesis = recordValue(reasoning.pathogenesis);
    const chain = recordList(pathogenesis?.chain);
    const facts = semanticItems(overview?.primarySyndromeBasis);
    const fact = facts[0] || markdownCell(chain[0]?.patientFact);
    const syndrome = markdownCell(overview?.primarySyndrome);
    const mechanism = markdownCell(overview?.overallPathogenesis) || markdownCell(chain[0]?.pathogenesis);
    if (
      !isDisplayableClinicalText(fact) ||
      !isDisplayableClinicalText(syndrome) ||
      !isDisplayableClinicalText(mechanism)
    ) return content;

    // 甲方评测 2026-08-04 第 2.1 条「推理过程没有实际内容」的根修。
    //
    // 上一版模板（2026-08-03）已经把四诊要点、病位、病性都织进来了，仍然被判为套话——
    // 生产实测那一句是：
    //   「四诊要点：产后2月余，头痛反复发作1月、产后2月余，近1月头痛反复，劳累后加重，伴神疲
    //     乏力、心悸失眠、面色少华，舌象：…，提示病位在心、脾、头窍、病性属气血亏虚，
    //     病机为产后气血亏虚，…，不荣则痛；…面色少华。，故辨为“心脾两虚，气血不足”。」
    // 三个病：① 主诉与现病史近乎逐字重复地并排列出（同一事实印两遍）；
    //        ② 四诊要点与病位病性之间**没有任何对应关系**——读者读不出为什么是这几个病位，
    //           这才是「没有实际内容」的实质：它是字段拼接，不是推理；
    //        ③ 病机原文整段照抄，自带句号，拼出「。，故辨为」这种破碎标点。
    //
    // 本版仍然只做投影（不新增证候/病位/病性/治法），但补上缺的那一步**归属关系**：
    // 每条病位/病性后面注明是本例哪一条四诊要点支持它，映射取自受治理的症状—轴表
    // （tcm-symptom-axis-map，与证候假设层同一张），不新写任何中文词表；
    // 归属不上的条目照常列出，只是不带「据」——fail-open，不因为词表没收录就删掉医生的判断。
    const nature = recordValue(pathogenesis?.natureDifferentiation);
    const location = recordValue(pathogenesis?.locationDifferentiation);
    const tongueFact = facts.find((item) => /舌/.test(item)) || "";
    const pulseFact = facts.find((item) => /脉/.test(item)) || "";
    const symptomFacts = dropContainedClinicalFacts(
      facts.filter((item) => item !== tongueFact && item !== pulseFact),
    ).slice(0, 3);
    // 归属用的事实池比呈现用的四诊要点宽：primarySyndromeBasis 常常只收主诉与舌脉三条，
    // 而支持病位病性的伴随症状（心悸失眠→心、神疲乏力→脾）写在现病史里。症状簇、病机节点
    // 患者事实与西医支持事实都是**已接地的病历原句**（groundStructuredPatientFacts 逐条核过），
    // 拿它们做归属不引入任何新事实。
    const attributionFacts = dropContainedClinicalFacts([
      ...symptomFacts,
      tongueFact,
      pulseFact,
      ...chain.map((node) => markdownCell(node.patientFact)).filter(Boolean),
      ...recordList(pathogenesis?.symptomClusters).flatMap((cluster) => semanticItems(cluster.symptoms)),
      ...semanticItems(recordValue(recordValue(reasoning.westernDiagnosis)?.primary)?.supportingFacts),
    ]);
    const attribution = clinicalAxisAttributionFromFacts(attributionFacts);
    const withBasis = (item: string, axisIds: readonly string[], table: Map<string, string[]>): string => {
      const basis = [...new Set(axisIds.flatMap((id) => table.get(id) || []))];
      return basis.length > 0 ? `${item}（据${joinClinicalClauses(basis.slice(0, 2), "、")}）` : item;
    };
    const locationItems = semanticItems(location?.items).slice(0, 3)
      .map((item) => withBasis(item, governedLocationAxisIds(item), attribution.locations))
      .join("、");
    // 病性同时看 items 与 rootDeficiency/branchExcess：复合写法（「气血亏虚」）在受控病性词表里
    // 归一不到，拆分后的「气虚」「血虚」才归一得到，归属也只有在拆分层才成立。
    const natureItems = [...new Set([
      ...semanticItems(nature?.items),
      ...semanticItems(nature?.rootDeficiency),
      ...semanticItems(nature?.branchExcess),
    ])].slice(0, 3)
      .map((item) => withBasis(item, governedNatureAxisIds(item), attribution.natures))
      .join("、");
    const fourDiagClues = [symptomFacts.join("、"), tongueFact, pulseFact].filter(Boolean).join("，");
    overview!.tcmDiagnosticRationale = [
      `四诊要点：${fourDiagClues || fact}`,
      locationItems || natureItems
        ? `据此辨病位在${locationItems || "待定"}${natureItems ? `、病性属${natureItems}` : ""}`
        : "",
      `病机为${trimTrailingClinicalPunctuation(mechanism)}`,
      `故辨为“${syndrome}”`,
    ].filter(Boolean).join("，") + "。";
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

/** 服务端自产的鉴别理由回落句。措辞刻意不含「本例／患者」——否则会被自己的接地校验再判一次。 */
const DIFFERENTIAL_REASON_EMPTY_FALLBACK = "当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。";
const DIFFERENTIAL_REASON_UNGROUNDED_FALLBACK =
  "该条鉴别理由与病历记录不一致，未予采纳；请医生结合临床表现与相关检查自行判断。";
const SERVER_AUTHORED_DIFFERENTIAL_REASONS: ReadonlySet<string> = new Set([
  DIFFERENTIAL_REASON_EMPTY_FALLBACK,
  DIFFERENTIAL_REASON_UNGROUNDED_FALLBACK,
]);

export function groundStructuredPatientFacts(content: string, clinicalContext: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "diagnose") return content;
    const pathogenesis = reasoning.pathogenesis && typeof reasoning.pathogenesis === "object" && !Array.isArray(reasoning.pathogenesis)
      ? reasoning.pathogenesis as Record<string, unknown>
      : null;
    if (!Array.isArray(pathogenesis?.chain)) return content;
    const western = recordValue(reasoning.westernDiagnosis);
    const westernPrimary = recordValue(western?.primary);
    const fallback = chiefComplaintFallbackDiagnosis(clinicalContext);
    if (westernPrimary) {
      const serverDowngradeMarker =
        "现有资料不足以满足原具体疾病的完整诊断标准，当前仅保留症状性工作诊断";
      const isServerSymptomDowngrade =
        westernPrimary.status === "证据有限" &&
        westernPrimary.confidence === "低" &&
        typeof westernPrimary.name === "string" &&
        /(?:症状|不适)$/.test(westernPrimary.name.trim()) &&
        typeof westernPrimary.clinicalRationale === "string" &&
        Boolean(fallback.fact) &&
        westernPrimary.clinicalRationale.startsWith(`${fallback.fact}支持症状级工作诊断；`) &&
        semanticItems(westernPrimary.limitations).includes(serverDowngradeMarker);
      const groundedFacts = (Array.isArray(westernPrimary.supportingFacts) ? westernPrimary.supportingFacts : []).flatMap((fact) => {
        if (typeof fact !== "string") return [];
        return exactClinicalSourceQuotes(fact, clinicalContext).flatMap((sourceQuote) => {
          const quote = stripClinicalTransportPrefix(sourceQuote);
          return quote &&
            clinicalContext.includes(quote) &&
            !looksLikeSerializedClinicalState(quote) &&
            !isNondiscriminatingWesternSupportingFact(quote) &&
            clinicalClausePolarity(quote) === "affirmed"
            ? [quote]
            : [];
        });
      });
      const courseFacts = documentedMaterialFacts(clinicalContext);
      const symptomFieldFacts = documentedSymptomFieldFacts(clinicalContext);
      westernPrimary.supportingFacts = isServerSymptomDowngrade
        ? (fallback.fact ? [fallback.fact] : groundedFacts.slice(0, 1))
        : boundedClinicalFacts(uniqueClinicalFacts([
            ...(fallback.fact ? [fallback.fact] : []),
            ...symptomFieldFacts,
            ...documentedObjectiveFacts(clinicalContext),
            ...courseFacts,
            ...groundedFacts,
            ...documentedExclusionFacts(clinicalContext),
          ]
            // Filter before containment de-duplication. Otherwise an inadmissible long line containing
            // tongue/pulse or mixed polarity can hide a shorter, exact and clinically valid source fact.
            .filter((fact) => !isNondiscriminatingWesternSupportingFact(fact))
            .filter((fact) => isWesternSupportingFactPolarityAligned(fact, clinicalContext))));
      // 依据分类标注只能贴在**已接地的** supportingFacts 上。模型标了病历没有的条目
      // （实测：supportingFacts 只有发热咳痰，却标了「胸片示右下肺片状影」），
      // 呈现层本来就会忽略它，但不清掉就等于把一条编造事实留在了签名载荷里。
      if (Array.isArray(westernPrimary.supportingFactKinds)) {
        const groundedSet = new Set(groundedFacts.map((fact) => fact.trim()));
        westernPrimary.supportingFactKinds = westernPrimary.supportingFactKinds.filter((raw) => {
          const item = recordValue(raw);
          return typeof item?.fact === "string" && groundedSet.has(item.fact.trim());
        });
      }
      const primaryEvidence = recordValue(westernPrimary.evidence);
      const providerEvidenceSource = markdownCell(primaryEvidence?.source);
      westernPrimary.evidence = {
        evidenceLevel: markdownCell(primaryEvidence?.evidenceLevel) || "model_inference",
        source: /^(?:无|暂无|未提供|未检索|待检索|内部证据缺口)$/.test(providerEvidenceSource) ? "病例内推理" : providerEvidenceSource || "病例内推理",
        confidence: markdownCell(primaryEvidence?.confidence) || markdownCell(westernPrimary.confidence) || "低",
      };
      if (groundedFacts.length === 0) westernPrimary.confidence = "低";
    }
    if (Array.isArray(western?.differentials)) {
      western.differentials = deduplicateWesternDifferentials(western.differentials.flatMap((raw) => {
        const item = recordValue(raw);
        if (!item || typeof item.name !== "string" || !item.name.trim()) return [];
        // 鉴别理由由模型写，确定性层**只校验、不覆盖**。
        //
        // 【改之前】判据是「这句里有没有一段病历原文的逐字引用」（exactClinicalSourceQuotes）。
        // 但鉴别理由的接地对象是**疾病特征**，不是本例病历——「主动脉瓣狭窄同样以劳力性胸闷
        // 气短为首发表现，需经心脏听诊与超声心动图除外」根本不该含病历原文。于是凡是写得像样
        // 的都命不中，一律被换成同一句套话。归档实测：24175 条 reason 里 3365 条
        // 逐字都是「当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。」，
        // 而幸存下来的那些是靠碰巧命中病历子串活下来的，不是因为写得更好。
        //
        // 【改之后】只驳回**对本例的虚假断言**：把理由按硬分句切开，只有明确指向本例
        //（本例／该患者／患者）的分句才过病历极性校验——复用与 supportingFacts 同一个
        // 导出谓词 isWesternSupportingFactPolarityAligned，不写第二份。
        // 纯疾病特征描述不是对本例的断言，不受病历极性约束，原样保留。
        // 全部分句都被驳回时才回落，且回落句必须**如实说明是校验没过**，
        // 不能伪装成「资料仅支持列为鉴别方向」这种听起来像临床结论的话。
        const rawReason = typeof item.reason === "string" ? item.reason.trim() : "";
        // 服务端自产的回落句不再进校验：它是我们自己写的，不是模型对本例的断言。
        // 不设这道门就会**不幂等**——回落句里带「本例」二字，第二遍 prepare 会把它自己
        // 的第一分句当成未接地的患者断言删掉（实测 17/120 例，句子每过一遍短一截）。
        // 而 prepare 的幂等性是「复核看到的字节 == 签名覆盖的字节」这条承重前提。
        if (SERVER_AUTHORED_DIFFERENTIAL_REASONS.has(rawReason)) return [{ ...item }];
        const reasonClauses = rawReason.split(/(?<=[。；;])/).map((part) => part.trim()).filter(Boolean);
        // 指向本例的分句必须**接地**：原来那条「必须含病历原文」的要求本身没错，
        // 错在它被施加到了整条理由上（疾病特征本来就不该含病历原文）。
        // 只留给本例断言这一侧，既挡住凭空断言，又放行疾病知识。
        // 两道都过：极性不得与病历冲突 + 必须能在病历里找到落点。
        // 实测：病历「否认反酸烧心」，模型写「本例存在明显反酸烧心」⇒ 驳回；
        //       模型写「但本例否认反酸烧心，可能性较低」⇒ 保留。
        const keptClauses = reasonClauses.filter((clause) => {
          if (!/本例|该患者|患者/.test(clause)) return true;
          if (!isWesternSupportingFactPolarityAligned(clause, clinicalContext)) return false;
          return Boolean(exactClinicalSourceQuotes(clause, clinicalContext)[0]);
        });
        const reason = rawReason.length === 0
          ? DIFFERENTIAL_REASON_EMPTY_FALLBACK
          : keptClauses.length === 0
            ? DIFFERENTIAL_REASON_UNGROUNDED_FALLBACK
            : keptClauses.join("");
        return [{ ...item, reason }];
      }));
    }
    const groundedChain = pathogenesis.chain.flatMap((rawNode) => {
      if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) return [];
      const node = rawNode as Record<string, unknown>;
      if (typeof node.patientFact !== "string") return [];
      if (isUnstableM03CoreText(node.pathogenesis) || isUnstableM03CoreText(node.therapyDirection)) return [];
      if (!clinicalContext) return [node];
      const patientFactQuote = stripClinicalTransportPrefix(
        exactClinicalSourceQuotes(node.patientFact, clinicalContext)[0] || "",
      );
      const syndromeEvidenceQuote = typeof node.syndromeEvidence === "string"
        ? stripClinicalTransportPrefix(exactClinicalSourceQuotes(node.syndromeEvidence, clinicalContext)[0] || "")
        : "";
      // These fields have different semantics: patientFact is the observed manifestation and
      // syndromeEvidence is the four-examination/diagnostic evidence used to infer the mechanism.
      // Each must independently ground to the chart; never copy one quote into both columns.
      return patientFactQuote && syndromeEvidenceQuote
        ? [{ ...node, patientFact: patientFactQuote, syndromeEvidence: syndromeEvidenceQuote }]
        : [];
    });
    pathogenesis.chain = groundedChain.map((node, index) => ({ ...node, nodeId: `P${index + 1}` }));
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

/**
 * Fail-safe for a concrete disease label that the independent reviewer says has not met its formal
 * criteria. The model still owns the original differential reasoning; the server only demotes that
 * label and promotes a symptom-level description derived from the chart's chief complaint. This is
 * deliberately followed by another independent review before the result can be signed.
 */
export function declassifyUnsupportedM03WesternPrimary(content: string, clinicalContext: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "diagnose") return content;
    const western = recordValue(reasoning.westernDiagnosis);
    const primary = recordValue(western?.primary);
    if (!western || !primary) return content;
    const fallback = chiefComplaintFallbackDiagnosis(clinicalContext);
    const symptomCore = fallback.name.replace(/（病因待鉴别）$/, "").trim();
    const genericSymptomName = symptomCore === "症状性诊断，病因待临床鉴别"
      ? symptomCore
      : `${symptomCore.replace(/症状$/, "")}症状`;
    const symptomName = symptomLevelWesternName(fallback.fact, genericSymptomName);
    if (!fallback.fact || symptomName.length < 2 || symptomName.length > 600) return content;

    const previousName = markdownCell(primary.name);
    const suggestedChecks = semanticItems(primary.suggestedChecks);
    const differentials = recordList(western.differentials).map((item) => ({ ...item }));
    if (previousName && previousName !== symptomName && !differentials.some((item) => markdownCell(item.name) === previousName)) {
      differentials.unshift({
        name: previousName,
        reason: "独立临床复核认为现有病程或必备条件尚不足，暂列鉴别诊断",
        distinguishingPoints: "是否满足该疾病的病程阈值、功能影响、必要客观依据及排除条件。",
        nextCheck: suggestedChecks[0] || "结合病程演变、查体及必要检查复核诊断标准",
      });
    }
    western.differentials = differentials.slice(0, 8);
    primary.name = symptomName;
    primary.status = "证据有限";
    primary.confidence = "低";
    primary.supportingFacts = [fallback.fact];
    primary.clinicalRationale = `${fallback.fact}支持症状级工作诊断；原具体疾病的病程阈值或必备条件尚未全部取得，因此暂不作为主诊断。`;
    primary.limitations = uniqueClinicalFacts([
      ...semanticItems(primary.limitations),
      "现有资料不足以满足原具体疾病的完整诊断标准，当前仅保留症状性工作诊断",
    ]).slice(0, 12);
    const evidence = recordValue(primary.evidence);
    primary.evidence = {
      ...(evidence || {}),
      evidenceLevel: markdownCell(evidence?.evidenceLevel) || "model_inference",
      source: markdownCell(evidence?.source) || "病例内推理",
      confidence: "低",
    };
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

/**
 * A primary field containing several diagnoses is not a usable working diagnosis. Collapse it to
 * the chart-grounded symptom level before spending a model repair round; the original alternatives
 * remain visible as a differential and the independent reviewer still decides clinical adequacy.
 */
export function declassifyAmbiguousM03WesternPrimary(content: string, clinicalContext: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    const primary = recordValue(recordValue(reasoning.westernDiagnosis)?.primary);
    if (!isAmbiguousM03WesternPrimaryLabel(primary?.name)) return content;
    return declassifyUnsupportedM03WesternPrimary(content, clinicalContext);
  } catch {
    return content;
  }
}

type FormalWesternCriteriaGuard = {
  label: RegExp;
  criteria: (affirmedClinicalContext: string) => boolean;
};

/**
 * 「病历说这个病此前已经被诊断过」——一条判据，四条 guard 共用，且**与语序无关**。
 *
 * 【改之前】每条 guard 各带一个 established 正则，四条内容几乎相同，都是
 * `(?:既往史|既往确诊|既往诊断|已确诊|明确诊断|曾诊断为)[^。；\n]{0,40}<病名>`——
 * 把引导词**枚举**出来、且要求它出现在病名**前面 40 字以内**。中文病历的写法是开放集合，
 * 实测漏网（tmp-probe/repro-asthma-label.mjs，primary=支气管哮喘）：
 *   ·「外院确诊支气管哮喘3年」          ⇒ 降级为「喘息症状」（"确诊"不在枚举里，只有"既往确诊"）
 *   ·「某三甲医院诊断为支气管哮喘」      ⇒ 降级（"诊断为"不在枚举里，只有"曾诊断为"）
 *   ·「长期规律吸入布地奈德福莫特罗控制哮喘」⇒ 降级（长期规律 ICS/LABA 本身即已确立诊断）
 * 越是照着真实病历写，越会被判成"没有既往诊断"。这正是拿枚举做阅读理解。
 *
 * 【改之后】判据落到**分句**上：同一个阳性分句里既出现该病名，又出现既往/他处诊断的断言标记，
 * 前后语序不限。标记本身仍是受控集合，但它断言的是"这句话在陈述一个已成立的诊断"这件通用的事，
 * 而不是逐个病名去枚举引导词。不收 裸「诊断」——「需完善肺功能诊断」不能算既往诊断。
 * 分句划分与极性判定复用 clinical-polarity 的既有实现，不在这里另写一套。
 */
const ESTABLISHED_DIAGNOSIS_MARKER =
  /(?:确诊|诊断为|诊断过|已诊断|曾诊断|明确诊断|诊断明确|诊为|病史|既往|已知|外院|他院|上级医院|三甲医院|规律(?:吸入|服用|用药|治疗)|长期(?:吸入|服用|用药|治疗))/;

function hasEstablishedDiagnosis(affirmedContext: string, label: RegExp): boolean {
  const inClause = new RegExp(label.source, label.flags.replace(/[gy]/g, ""));
  return affirmedContext
    .split(/[。；;\n]/)
    // 字段标签必须先剥掉：「现病史：」自己就含「病史」二字，不剥的话每一句都算既往诊断。
    // 剥法复用极性层的同一个导出，不在这里另写一份。
    .map((clause) => stripClinicalSectionLabel(clause))
    .some((clause) => inClause.test(clause) && ESTABLISHED_DIAGNOSIS_MARKER.test(clause));
}

/** 病程分期后缀：不改变「是哪个病」，只说处在哪一期。闭集且结构性，不是语义判断。 */
const DISEASE_STAGE_SUFFIX = /(?:[（(][^）)]{0,20}[）)])?\s*(?:急性发作期|慢性持续期|临床缓解期|急性加重期|发作期|缓解期|稳定期|活动期)?$/;

/**
 * 这条 guard 说的是不是**这个病本身**。
 *
 * 【为什么必须整名判定】label 原先是裸子串匹配（`/(?:支气管)?哮喘/`），于是凡是名字里带
 * 「哮喘」两个字的病都被按支气管哮喘的判据审。实测（tmp-probe/repro-asthma-label.mjs）：
 *   · 心源性哮喘（端坐呼吸、粉红色泡沫痰、双下肢水肿、冠心病心梗史、双肺满布湿啰音）
 *     ⇒ 降级为「喘息症状」，理由是病历没写「吸入沙丁胺醇后明显缓解」。
 *     急性左心衰是心内科急症，按支气管哮喘的舒张剂反应去审本身就是错的，
 *     而且降级方向是**不安全**的那一侧：随后 applyDeterministicIcd10Coding 按 primary.name
 *     编码，HIS 侧拿到的是症状码。
 *   · 哮喘持续状态 ⇒ 同样降级，且判据在这里是反的——「吸入沙丁胺醇无缓解」恰恰是它的定义
 *     性特征，病情越重越必然被降级。
 *   · 咳嗽变异性哮喘（另一诊断实体，判据是激发试验而非舒张剂反应）⇒ 降级为「咳嗽症状」。
 *   · 慢性阻塞性肺疾病急性加重期 ⇒ 降级为「咳嗽症状」。
 *
 * 【判定口径】前缀限定词（心源性/咳嗽变异性/职业性/药物性…）改变的是「哪个病」，
 * 一旦出现就不属于本 guard；后缀分期词只说「哪一期」，剥掉后仍是同一个病，继续受管。
 * 认不出的名字 ⇒ **不受管**，交由独立临床复核（它本就负责本表以外的全部疾病）——
 * 失败方向是「正式病名保留下来、由复核把关」，而不是「急症病名变成症状名」。
 */
function guardLabelMatchesWholeName(label: RegExp, name: string): boolean {
  const stripped = name.trim().replace(DISEASE_STAGE_SUFFIX, "").trim();
  if (!stripped) return false;
  return new RegExp(`^(?:${label.source})$`, label.flags.replace(/[gy]/g, "")).test(stripped);
}

function hasOsaObjectiveEvidence(context: string): boolean {
  for (const match of context.matchAll(/(?:AHI|REI|呼吸暂停低通气指数)\s*[:：=]?\s*(?:≥|>=|＞=)?\s*(\d+(?:\.\d+)?)/gi)) {
    if (Number(match[1]) >= 5) return true;
  }
  return /(?:多导睡眠监测|PSG|睡眠呼吸监测)[^。；\n]{0,60}(?:提示|支持|符合|诊断)[^。；\n]{0,24}(?:阻塞性睡眠呼吸暂停|OSA(?:HS)?)/i.test(context);
}

// Closed, high-certainty respiratory criteria only. These labels repeatedly appear in sparse
// primary-care records and must not become a formal primary diagnosis merely because limitations
// admit the missing criteria. The independent reviewer remains responsible for every disease not
// listed here and re-reviews any deterministic declassification.
const FORMAL_WESTERN_CRITERIA_GUARDS: FormalWesternCriteriaGuard[] = [
  {
    label: /慢性支气管炎/,
    criteria: (context) => /(?:(?:每年|年均)[^。；\n]{0,24}(?:3|三)(?:个)?月[^。；\n]{0,32}(?:连续|至少)[^。；\n]{0,12}(?:2|两|二)年|(?:连续|至少)[^。；\n]{0,12}(?:2|两|二)年[^。；\n]{0,32}(?:每年|年均)[^。；\n]{0,24}(?:3|三)(?:个)?月)/.test(context),
  },
  {
    label: /(?:慢性阻塞性肺疾病|慢阻肺|\bCOPD\b)/i,
    criteria: (context) => /(?:(?:FEV1\s*\/\s*FVC|一秒率)[^。；\n]{0,20}(?:<|＜|低于)\s*(?:0?\.7|70\s*%)|肺功能[^。；\n]{0,40}(?:持续气流受限|阻塞性通气功能障碍|支持慢阻肺|符合慢阻肺))/i.test(context),
  },
  {
    label: /(?:阻塞性睡眠呼吸暂停(?:低通气)?(?:综合征)?|\bOSA(?:HS)?\b)/i,
    criteria: hasOsaObjectiveEvidence,
  },
  {
    label: /(?:支气管)?哮喘/,
    criteria: (context) =>
      /(?:肺功能|支气管舒张试验|支气管激发试验|峰流速|\bPEF\b)[^。；\n]{0,80}(?:阳性|可逆|明显变异|支持哮喘|符合哮喘)/i.test(context) ||
      /(?:吸入|使用|应用)[^。；\n]{0,20}(?:沙丁胺醇|支气管舒张剂|短效β2受体激动剂)[^。；\n]{0,40}(?:明显缓解|明显改善|有效)/i.test(context),
  },
];

/**
 * Demote a closed set of formal respiratory disease labels when their minimum documented
 * criteria or an established prior diagnosis are absent. This is a label-safety transform only:
 * the original disease stays in differentials and the full result is independently reviewed.
 */
export function declassifyUnmetFormalM03WesternPrimary(content: string, clinicalContext: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0 || !clinicalContext.trim()) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    const western = recordValue(reasoning.westernDiagnosis);
    const primary = recordValue(western?.primary);
    const name = markdownCell(primary?.name);
    // The shared duration contract is a deterministic label boundary, not a reason to redraw the
    // whole diagnosis. Apply the same symptom-level declassification used for unmet formal
    // respiratory criteria before independent review. This prevents a short diarrhoea course from
    // consuming every repair round while preserving the model's TCM reasoning and the original
    // disease label as an explicit differential.
    if (m03WesternDurationIssue(reasoning, clinicalContext)) {
      return declassifyUnsupportedM03WesternPrimary(content, clinicalContext);
    }
    const guard = FORMAL_WESTERN_CRITERIA_GUARDS.find((item) => guardLabelMatchesWholeName(item.label, name));
    if (!guard) return content;
    // Only affirmed clauses may satisfy a formal disease criterion. This prevents text such as
    // “否认既往确诊哮喘” or “未见舒张试验阳性” from preserving an unsupported label.
    const affirmedContext = affirmedClinicalText(clinicalContext) || "";
    if (hasEstablishedDiagnosis(affirmedContext, guard.label) || guard.criteria(affirmedContext)) return content;
    return declassifyUnsupportedM03WesternPrimary(content, clinicalContext);
  } catch {
    return content;
  }
}

function stripClinicalTransportPrefix(value: string): string {
  return value
    .split(/[；;]/)
    .map((part) => part
      .trim()
      .replace(/^(?:医生\/患者|医生记录|系统)[：:]\s*/, "")
      .replace(/^(?:基层接诊初始记录|本轮追问补充|问诊补充|四诊补充|症状补充|病情经过|主诉|现病史)[：:]\s*/, "")
      .trim())
    .filter(Boolean)
    .join("；");
}

function boundedClinicalFacts(values: string[], maxItems = 12, maxChars = 2_400): string[] {
  const result: string[] = [];
  let usedChars = 0;
  for (const value of values) {
    const fact = value.trim().slice(0, 600);
    if (!fact || result.length >= maxItems || usedChars + fact.length > maxChars) break;
    result.push(fact);
    usedChars += fact.length;
  }
  return result;
}

function looksLikeSerializedClinicalState(value: string): boolean {
  const trimmed = value.trim();
  return /^(?:\{|\[)/.test(trimmed) || /"(?:presentHistory|tcmDetail|chiefComplaint|symptoms|vitals)"\s*:/.test(trimmed);
}

function chiefComplaintFallbackDiagnosis(clinicalContext: string): { name: string; fact?: string } {
  const fact = clinicalContext.match(/(?:^|\n)主诉[：:]\s*([^\n]+)/)?.[1]?.trim() ||
    clinicalContext.split("\n").map((item) => item.trim()).find((item) => Boolean(item) && !looksLikeSerializedClinicalState(item));
  if (!fact) return { name: "症状性诊断，病因待临床鉴别" };
  const core = fact
    .split(/[，,；;]/)[0]
    .replace(/^(?:患者|反复|近来|近期|最近|近)/, "")
    .replace(/(?:约|已)?\d+(?:\.\d+)?\s*(?:分钟|小时|天|日|周|个月|月|年)(?:余|左右)?/g, "")
    .replace(/(?:这|近|有)?(?:半|一|二|两|三|四|五|六|七|八|九|十)+\s*(?:天|日|周|个月|月|年)(?:余|左右)?/g, "")
    .replace(/要求.*$/, "")
    .trim();
  return {
    name: core.length >= 2 && core.length <= 40 ? `${core}（病因待鉴别）` : "症状性诊断，病因待临床鉴别",
    fact,
  };
}

/**
 * 症状级标签表。**行序不是临床优先级**，只是作者书写顺序——因此不能用 find() 取首个命中。
 * 实测（2026-08-10）：`find` 让腹泻（第 2 行）压过头痛（第 11 行），
 * 「主诉：头痛3天，伴恶心、大便稀」的主诊断被算成「腹泻症状」。
 */
const GOVERNED_SYMPTOM_LABELS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
    { pattern: /(?:反酸|烧心|烧灼感)/, label: "反酸烧心症状" },
    { pattern: /(?:腹泻|稀便|拉肚子|便溏|大便稀|稀水样|(?:吃|饭)[^，。；]{0,16}跑厕所)/, label: "腹泻症状" },
    { pattern: /(?:便秘|排便(?:困难|费劲|不畅)|大便[^，。；\n]{0,12}(?:解不出来|拉不出来|排不出来)|(?:三四|四五|五六|好几|\d+)\s*(?:天|日)[^，。；\n]{0,8}(?:一次|才(?:解|拉|排)|不上厕所)|大便干结|便干(?:成)?颗粒|干球状便)/, label: "便秘症状" },
    { pattern: /(?:(?:吃完饭|饭后|餐后)[^，。；]{0,20}(?:肚子|上腹|胃|脸)?[^，。；]{0,8}胀|(?:上腹|胃脸|肚子上边)胀)/, label: "餐后上腹胀症状" },
    { pattern: /(?:腹胀|肚子[^，。；]{0,8}胀|胃胀|脸胀)/, label: "腹胀症状" },
    { pattern: /(?:腹痛|肚子[^，。；]{0,6}痛|胃痛|上腹痛)/, label: "腹痛症状" },
    { pattern: /咳[嗽嘈]?[^\n。；]{0,20}痰|痰[^\n。；]{0,20}咳/, label: "咳嗽咳痰症状" },
    { pattern: /咳/, label: "咳嗽症状" },
    { pattern: /(?:呼呼响|喘鸣|哮鸣|喘|夜间憋醒|晚上[^。；\n]{0,12}憋醒)/, label: "喘息症状" },
    { pattern: /(?:气短|气促|呼吸困难|憋气)/, label: "气短症状" },
    { pattern: /(?:头痛|脑袋疼|头部[^，。；]{0,8}痛)/, label: "头痛症状" },
    { pattern: /(?:头晕|眩晕|天旋地转)/, label: "头晕症状" },
    { pattern: /(?:心悸|心慌|心跳[^，。；]{0,8}(?:快|乱|不齐))/, label: "心悸症状" },
    { pattern: /(?:失眠|入睡困难|睡不好|多梦易醒|夜醒)/, label: "睡眠障碍症状" },
    { pattern: /(?:颈痛|脖子[^，。；]{0,8}(?:痛|酸|僵))/, label: "颈部疼痛症状" },
    { pattern: /(?:膝痛|膝盖[^，。；]{0,8}痛)/, label: "膝关节疼痛症状" },
    { pattern: /(?:乏力|疲乏|没劲|容易累)/, label: "乏力症状" },
  ];

/**
 * 裸症状词集合：标签剥掉「症状/待查」后**恰好**等于其中之一，才算症状级工作诊断。
 *
 * 原判据是后缀正则 /(?:…|头痛|眩晕|…)(?:待查)?$/，只看末两字，于是
 * 「偏头痛」（ICD G43，疾病实体）、「紧张型头痛」（G44.2）、
 * 「良性阵发性位置性眩晕」（BPPV，Dix-Hallpike 阳性摆在病历里）全被判成症状级并改名。
 * 改为「整名恰好是裸症状词」：方向上偏向**保留模型写的名字**——
 * 模型给出的是具体病种时不再被降级，只有它确实只写了一个裸症状词时才进入规范化。
 */
const BARE_SYMPTOM_LABELS: ReadonlySet<string> = new Set([
  "症状", "不适", "咳嗽", "咳痰", "喘息", "喘鸣", "气短", "气促", "呼吸困难",
  "反酸", "烧心", "腹泻", "便秘", "腹胀", "腹痛", "头痛", "头晕", "眩晕",
  "心悸", "失眠", "睡眠障碍", "颈部疼痛", "膝关节疼痛", "乏力",
]);

/** 标签剥掉不确定性后缀后的裸名；用于判定「这是不是只写了一个症状词」。 */
function bareDiagnosisLabel(value: string): string {
  return value.trim().replace(/(?:待查|待明确|待鉴别|（病因待查）|\(病因待查\))$/, "").replace(/症状$/, "").trim();
}

/** 症状词尾缀（原判据，保留）：标签以某个受治理症状词收尾。 */
const SYMPTOM_WORD_SUFFIX = /(?:症状|不适|咳嗽|咳痰|喘息|喘鸣|气短|气促|呼吸困难|反酸|烧心|腹泻|便秘|腹胀|腹痛|头痛|头晕|眩晕|心悸|失眠|睡眠障碍|颈部疼痛|膝关节疼痛|乏力)(?:待查|待明确|待鉴别)?$/;
/** 不确定性标记：模型自己声明这还不是确诊。 */
const WORKING_LABEL_MARKER = /(?:症状|待查|待明确|待鉴别)$/;

/**
 * 「这个主诊断名是不是症状级工作诊断」。
 *
 * 复合判据，两条缺一不可：
 *  ① 以受治理症状词收尾（原判据，保留——「劳力性呼吸困难待查」在病历只记录喘息时
 *     应当被纠正为「喘息症状」，那是接地纠正，test:stage-contract 钉着它）；
 *  ② **且**带不确定性标记（症状/待查/待明确/待鉴别），或整名就是一个裸症状词。
 *
 * 加②是因为只用①会把疾病实体一并降级：实测「偏头痛」(ICD G43)、「紧张型头痛」(G44.2)、
 * 「良性阵发性位置性眩晕」(BPPV，Dix-Hallpike 阳性摆在病历里) 全被改成「头痛症状/头晕症状」，
 * 原标签还凭空消失。它们都没有不确定性标记——模型给的是确诊名，不该被当成待查症状。
 */
function isSymptomLevelWorkingLabel(value: string): boolean {
  const trimmed = value.trim();
  if (!SYMPTOM_WORD_SUFFIX.test(trimmed)) return false;
  if (WORKING_LABEL_MARKER.test(trimmed)) return true;
  const bare = bareDiagnosisLabel(trimmed);
  return bare.length > 0 && BARE_SYMPTOM_LABELS.has(bare);
}

/**
 * 主诉里占主导的那个症状。
 *
 * 按**在主诉文本里出现的位置**取最靠前的一个，并且忽略「伴/兼/并/同时/合并/另有」之后的段落——
 * 中文病历用这些词明确标记兼症（「反复腹胀2年，伴大便稀溏」里大便稀溏是兼症）。
 * 原实现按表行序 find()，与病历里谁是主症完全无关。
 */
function symptomLevelWesternName(fact: string | undefined, fallback: string): string {
  if (!fact) return fallback;
  const governedSymptomLabels = GOVERNED_SYMPTOM_LABELS;
  // 先只在「兼症标记」之前的主段里找主症；主段找不到再退回全文。
  const primarySegment = fact.split(/(?:伴(?:有|随)?|兼(?:有|见)?|并(?:有|见)?|同时|合并|另有)/)[0] || fact;
  const pickEarliest = (text: string) => {
    let best: { label: string; index: number } | undefined;
    for (const item of governedSymptomLabels) {
      const match = text.match(item.pattern);
      const index = match?.index;
      if (index == null) continue;
      if (!best || index < best.index) best = { label: item.label, index };
    }
    return best?.label;
  };
  return pickEarliest(primarySegment) || pickEarliest(fact) || fallback;
}

/**
 * Keep the signed Western diagnosis label unchanged for review and downstream contracts, while
 * presenting governed symptom-level labels as an explicit working diagnosis to clinicians.
 */
/**
 * 症状级工作诊断的**非规范括注写法**。
 *
 * 生产实测（2026-08-04，归档 case-966 在生产复跑）：`primary.name = "头痛（症状性）"`，
 * 医生页面逐字显示「诊断倾向：头痛（症状性）」。同一批归档里还有「尿路感染（症状性）」
 * 「多汗症（症状性）」「三叉神经痛（症状性）」——这是一整类写法，不是一个 case 的口误。
 * 「（症状性）」不是临床规范术语（规范用法是「症状性癫痫」这类**病因学**限定，
 * 挂在「头痛」后面反而把「病因不明」说成了「病因已知为症状性」，语义正相反）。
 *
 * 服务端此前只认 `X症状` 这一种形态（模型按提示词写「头痛症状」时能转），
 * 模型改用括注写法就整条漏过去。这里按**形态族**收口，而不是逐个字符串补丁。
 */
/**
 * 末尾的「病因未明」限定形态族。
 *
 * `，病因待查` 也在其中，而它恰恰是本函数**自己产出**的规范写法——收进来是为了让这个转换
 * **幂等**。不收会出事：一份已经规范化过的 `头痛，病因待查` 再过一次时 qualifier 判空，
 * 于是走「编码名称替换」分支，`coding.display="头痛"` 是 core 的子串 ⇒ 整条被塌回「头痛」，
 * 「病因待查」凭空消失，诊断从「病因不明」变成了「已定为头痛」。
 * HIS 写回接上这个唯一权威后，该形态在同一份载荷上会被求值两次，问题即刻显形。
 */
const NON_STANDARD_SYMPTOM_QUALIFIER =
  /(?:症状|[（(](?:症状性|症状|待查|待因|病因待查|病因待鉴别|病因不明)[）)]|待因|[，,]\s*(?:病因待查|病因未明|病因不明))$/u;

/**
 * Keep the signed Western diagnosis label unchanged for review and downstream contracts, while
 * presenting governed symptom-level labels as an explicit working diagnosis to clinicians.
 *
 * 医生可见标签只显示规范诊断核心名；不确定性由 status/confidence/limitations 表达，
 * 不再给每个症状级标签统一追加「病因待查」。它是医生可见标签的唯一权威：
 *   1) 有 ICD-10 编码时以**编码名称**为规范诊断名（编码由服务端确定性关联，不是模型措辞）；
 *   2) 症状性/待查等限定从展示名剥离，签名载荷仍保留原始不确定性语义。
 * 签名载荷里的 primary.name 原样保留，复核与下游契约不变。
 */
export function westernDiagnosisLabelForDisplay(value: unknown, coding?: unknown): string {
  const label = typeof value === "string" ? value.trim() : "";
  if (!label) return "";
  if (/^症状性(?:诊断|问题)[，,]\s*病因待(?:临床)?鉴别$/.test(label)) {
    return "当前未形成可复核的西医工作诊断";
  }
  const codingDisplay = markdownCell(recordValue(coding)?.display);
  const qualifier = label.match(NON_STANDARD_SYMPTOM_QUALIFIER)?.[0] || "";
  const core = qualifier ? label.slice(0, label.length - qualifier.length).trim() : label;
  if (!core) return label;
  // 编码名称只在它确实是本标签的规范化写法时替换（同名或以其为核心），避免编码歧义时改写诊断。
  const standardCore = codingDisplay && (codingDisplay === core || core.includes(codingDisplay))
    ? codingDisplay
    : core;
  return standardCore;
}

function documentedMaterialFacts(clinicalContext: string): string[] {
  return clinicalContext
    .split(/[\n。；;]+/)
    .map(stripClinicalTransportPrefix)
    .filter((item) => item.length >= 4 && item.length <= 100)
    .filter((item) =>
      /(?:病情稳定|恢复平稳|逐渐改善|逐步恢复|无新发|未再发|无再发|无加重|持续加重|明显加重)/.test(item) ||
      /(?:SpO2|血氧|HbA1c|糖化血红蛋白|eGFR|血压|BP|体温|心率|脉搏|呼吸)\s*[:：]?\s*\d/i.test(item)
    )
    .slice(0, 2);
}

function documentedSymptomFieldFacts(clinicalContext: string): string[] {
  const facts: string[] = [];
  const unlabeledCurrentSymptom = /(?:疼|痛|酸|胀|麻|无力|乏力|晕|咳|痰|喘|气短|气促|呼吸|憋|心悸|心慌|恶心|呕吐|反酸|烧心|腹泻|稀便|便秘|排便|失眠|睡不|早醒|发热|发烧|出汗|皮疹|瘙痒|红肿|流血|出血|加重|增多|减少|反复|发作)/;
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const source = stripClinicalTransportPrefix(value);
    if (source.length < 4 || source.length > 500 || /^(?:无|不详|未知|未提供|未记录|待补充)$/.test(source)) return;
    // Preserve exact source substrings while removing negative/uncertain clauses. The normalized
    // `affirmedClinicalText` result is suitable for matching but not for a verbatim evidence field:
    // NFKC changes Chinese punctuation and can join adjacent facts into text that never occurred in
    // the chart. Keep every affirmed hard-clause group so a later branch-changing symptom is not
    // lost merely because it appeared late in the same HIS field.
    for (const affirmed of affirmedClinicalSourceClauses(source)) {
      if (
        source.includes(affirmed) &&
        clinicalContext.includes(affirmed) &&
        !isNondiscriminatingWesternSupportingFact(affirmed) &&
        !facts.includes(affirmed)
      ) facts.push(affirmed);
    }
  };
  for (const line of clinicalContext.split("\n").map((item) => item.trim()).filter(Boolean)) {
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          // Serialized HIS snapshots may also contain names, demographics, lineage preferences and
          // tongue/pulse fields. Only fields that can carry western history/symptoms are eligible;
          // all others remain available elsewhere in the clinical context but never become western
          // diagnosis evidence.
          if (!/^(?:zhushu|chiefComplaint|xianbingshi|presentHistory|tcmDetail|symptoms|extraText|fuzhuJiancha|auxiliaryExamination)$/i.test(key)) continue;
          add(value);
        }
        continue;
      } catch {
        // A non-JSON line can still be an HIS field below.
      }
    }
    const labeled = line.match(/^(?:现病史|问诊补充|四诊补充|症状补充|病情经过)[：:]\s*(.+)$/)?.[1];
    if (labeled) {
      add(labeled);
      continue;
    }
    // Compatibility/HIS callers may send a plain current-history sentence without a field label.
    // Copy only symptom/trajectory-bearing lines; history, tongue/pulse, medication, allergy and
    // vital labels remain excluded, and add() still enforces affirmed polarity plus the western
    // nondiscriminating-fact guard. This prevents a late branch-changing symptom from disappearing
    // merely because its transport omitted “现病史：”.
    if (!/^(?:主诉|舌象|舌质|舌苔|脉象|面象|生命体征|既往史|个人史|家族史|婚育史|月经史|孕产史|用药史|过敏史|药物过敏史)[：:]/.test(line) && unlabeledCurrentSymptom.test(line)) {
      add(line);
    }
  }
  return boundedClinicalFacts(facts, 8, 2_400);
}

function documentedObjectiveFacts(clinicalContext: string): string[] {
  const patterns = [
    /(?:SpO2|血氧|氧饱和度)\s*[:：]?\s*\d{2,3}\s*%?/gi,
    /(?:HbA1c|糖化血红蛋白)\s*[:：]?\s*\d+(?:\.\d+)?\s*%?/gi,
    /eGFR\s*[:：]?\s*\d+(?:\.\d+)?(?:\s*mL\/min(?:\/1\.73m2)?)?/gi,
    /(?:BP|血压)\s*[:：]?\s*\d{2,3}\s*\/\s*\d{2,3}\s*(?:mmHg)?/gi,
    /(?:T|体温)\s*[:：]?\s*\d{2}(?:\.\d)?\s*(?:℃|°C|度)?/gi,
  ];
  return [...new Set(patterns.flatMap((pattern) => Array.from(clinicalContext.matchAll(pattern), (match) => match[0].trim())))].slice(0, 3);
}

function documentedExclusionFacts(clinicalContext: string): string[] {
  const values = clinicalContext.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        return Object.values(parsed).filter((value): value is string => typeof value === "string");
      } catch {
        return [trimmed];
      }
    }
    return [trimmed];
  });
  return values
    .flatMap((value) => value.split(/[；;。]+/))
    .map((value) => value.trim())
    .filter((value) => value.length >= 3 && value.length <= 120)
    .filter((value) => /(?:否认|未见|不伴|无)(?:明显)?/.test(value))
    .filter((value) => /外伤|红肿热|锁膝|肢体麻木|肢体无力|胸痛|气促|喘憋|咯血|呕血|黑便|发热|晕厥|意识改变/.test(value))
    .slice(0, 1)
    .map(stripClinicalTransportPrefix);
}

/**
 * Canonicalize symptom-level Western working diagnoses against the documented dominant complaint.
 * Disease labels remain model/reviewer decisions, but a provider must not relabel charted wheeze as
 * dyspnea (or vice versa) merely because both occur in the same respiratory differential. This
 * bounded terminology transform only applies to labels that are already explicitly symptom-level;
 * the independently reviewed disease differential remains untouched.
 */
export function normalizeDiagnoseConfidenceAndLabels(content: string, clinicalContext: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "diagnose") return content;
    const western = recordValue(reasoning.westernDiagnosis);
    const primary = recordValue(western?.primary);
    if (!primary || typeof primary.name !== "string") return content;
    let normalized = primary.name.trim().replace(/待因$/, "（病因待查）");
    // 症状级工作诊断的规范化。三条边界都是 2026-08-10 实测缺陷的直接产物：
    //
    // ① 只在标签**整名恰好是裸症状词**时才进来（见 isBareSymptomLevelLabel）。
    //    原判据是后缀正则，把「偏头痛」(G43)、「紧张型头痛」(G44.2)、
    //    「良性阵发性位置性眩晕」(BPPV) 这些疾病实体一并降级成症状。
    // ② 模型写的症状词**已经出现在主诉里**时，不改。它已经对了，没有可规范化的东西。
    //    原实现无条件重算，实测「头痛症状」+「主诉：头痛3天，伴恶心、大便稀」→「腹泻症状」，
    //    而 supportingFacts 仍是「头痛3天」——医生看到一张自相矛盾的诊断卡，
    //    错名还会带 ICD 编码进 HIS。且 prepare 每轮修复都重跑，模型改回去也会被再改一次，赢不了。
    // ③ 真的改名时，原标签必须进鉴别并写明理由——合法的降级通路
    //    （declassifyUnsupportedM03WesternPrimary）就是这么做的，这里原本什么都不留。
    if (!isAmbiguousM03WesternPrimaryLabel(normalized) && isSymptomLevelWorkingLabel(normalized)) {
      const fallback = chiefComplaintFallbackDiagnosis(clinicalContext);
      // 只按**主诉主症**规范化。「被主诉提到过」不等于「是主症」——
      // 「大便老解不出来，四五天一次，肚子还胀」里腹胀是兼症，主症是便秘，
      // test:stage-contract 钉着这一条。判据全部落在 symptomLevelWesternName 的语序取值里。
      const rewritten = symptomLevelWesternName(fallback.fact, normalized);
      if (rewritten !== normalized) {
        const differentials = Array.isArray(western?.differentials) ? western.differentials : [];
        // 原标签不得凭空消失：进鉴别、写理由，与合法降级通路（declassifyUnsupportedM03WesternPrimary）同口径。
        differentials.unshift({
          name: normalized,
          reason: `模型给出的症状级主诊断「${normalized}」与本次主诉的主症不一致，已按主诉主症规范为「${rewritten}」；原标签保留在鉴别中供医生复核。`,
        });
        if (western) western.differentials = differentials;
      }
      normalized = rewritten;
    }
    if (normalized === primary.name) return content;
    primary.name = normalized;
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

/**
 * Customer-output scrubbers are allowed to redact unsupported prose, but they must never mutate a
 * patient fact that already passed the M03 grounding contract. Restore only the grounded chain from
 * the accepted server copy; all other transformed fields (including evidence redaction) stay intact.
 */
export function restoreValidatedM03Chain(content: string, acceptedContent: string): string {
  const parse = (value: string): { start: number; end: number; reasoning: Record<string, unknown> } | null => {
    const start = value.indexOf(START_MARKER);
    const end = start >= 0 ? value.indexOf(END_MARKER, start + START_MARKER.length) : -1;
    if (start < 0 || end < 0) return null;
    try {
      const reasoning = JSON.parse(value.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
      return reasoning.stage === "diagnose" ? { start, end, reasoning } : null;
    } catch {
      return null;
    }
  };
  const transformed = parse(content);
  const accepted = parse(acceptedContent);
  if (!transformed || !accepted) return content;
  const acceptedPathogenesis = recordValue(accepted.reasoning.pathogenesis);
  const transformedPathogenesis = recordValue(transformed.reasoning.pathogenesis);
  if (!acceptedPathogenesis || !transformedPathogenesis || !Array.isArray(acceptedPathogenesis.chain)) return content;
  transformedPathogenesis.chain = JSON.parse(JSON.stringify(acceptedPathogenesis.chain));
  return `${content.slice(0, transformed.start + START_MARKER.length)}\n${JSON.stringify(transformed.reasoning, null, 2)}\n${content.slice(transformed.end)}`;
}

// 构造级根治(2026-08-03 复盘)：此前非字符串一律静默置空——decoction.dosesPerDay 这类数字
// 字段流经这里就渲染成「每日  剂」空白模板。现在数字在本体内转串,"合法值被清洗器吞掉"
// 这一类从构造上消失;真正的非法类型(对象/数组)仍置空,由行级省略逻辑兜底。
function markdownCell(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.replace(/[|\r\n]+/g, " ").trim() : "";
}

/**
 * 多行**段落**（非表格单元格）的渲染口。
 *
 * 甲方评测(2026-08-04) 7.1「方解格式不正确」的直接根因：方义解析本身是一段合法的 Markdown
 * 列表（`buildFormulaAnalysis` 用 `\n` 分行），却被 markdownCell 渲染——而 markdownCell 的
 * 职责是**表格单元格**，它把 `[|\r\n]+` 一律压成空格（换行会撑破表格）。于是整段列表在医生
 * 页面上塌成一行「… - **黄芪**（君）：… - **当归**（君）：…」，看起来像格式坏了，其实是
 * 用错了渲染口。段落只需要转义竖线，换行必须原样保留。
 */
function markdownBlock(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").replace(/\|/g, "\\|").trim();
}

// markdownCell 对非字符串一律返回空串——decoction.dosesPerDay 这类**数字**字段直接经它渲染
// 会产出「每日  剂 / 每日分  次服」空白模板（甲方生产实测的服法残片一类；下游 re-render
// 会绕过 outputTransform 清洗层，必须在渲染源头就不产生空位）。
function markdownNumberCell(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return markdownCell(value);
}

function canonicalHerbTable(candidate: Record<string, unknown>): string {
  const herbs = Array.isArray(candidate.herbs) ? candidate.herbs : [];
  if (herbs.length === 0) return "";
  // 「对应病机」列走统一的去重呈现：同一段病机在本表里只完整写一次，其余行指向首次出现。
  // 服务端 Markdown 与客户端表格共用 formulaTargetPathogenesisCells，两条渲染路径不再各写一套。
  const targetCells = formulaTargetPathogenesisCells(
    herbs.map((rawHerb) => (rawHerb && typeof rawHerb === "object" && !Array.isArray(rawHerb)
      ? (rawHerb as Record<string, unknown>).targetPathogenesis
      : "")),
  );
  const rows = herbs.map((rawHerb, index) => {
    const herb = rawHerb && typeof rawHerb === "object" && !Array.isArray(rawHerb)
      ? rawHerb as Record<string, unknown>
      : {};
    const processing = joinClinicalClauses([markdownCell(herb.processing), markdownCell(herb.decoctionRequirement)], "；") || "饮片";
    return `| ${index + 1} | ${markdownCell(herb.name)} | ${processing} | ${markdownCell(herb.dose)} | ${markdownCell(herb.role)} | ${markdownCell(herb.prescriptionRole)} | ${markdownCell(targetCells[index])} | ${markdownCell(herb.function)} |`;
  });
  return [
    "| 序号 | 药名 | 炮制/煎服要求 | 剂量 | 君臣佐使 | 处方角色 | 对应病机/证候/症状 | 配伍意义 |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordValue).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

// ─── 国标证候名双显（甲方评测 2026-08-04） ──────────────────────────────────
//
// 系统写的是脏腑病机式证候名（「外感风寒」「痰热扰神证」「湿热蕴脾证」），教材与甲方核对用的
// 是 GB/T 16751.2-2021 收录的规范证候名（「风寒外袭证」「痰火扰神证」「湿热困脾证」）。二者
// 临床等价，但按国标逐字对表就会被判为不规范。因此在医生可见的 M03 结论里**并列**显示国标名。
//
// 映射只允许来自受控词表（src/data/tcm-syndrome-lexicon.json 的 canonical/aliases），复用两条
// **既有**通路，不新增第二套映射机制、更不写证候关键词表：
//  1) clinical-governance-tables.resolveNationalStandardTcmSyndromeTerm —— 确定性 canonical/alias
//     命中，覆盖「本身就是国标条目别名」的写法（占多数）；
//  2) terminologyMappings —— controlled-semantic-normalization 的闭集共识映射轨迹，
//     覆盖词表里查不到的复合写法（「外感风寒，兼夹食积」）。这是既有载荷字段，此处只读不写。
// 先确定性、后模型轨迹：确定性命中更强，且能就地拦截模型对同一串给出的其它写法。
//
// 三条硬约束：输入本身已是国标规范名（仅「证/型」后缀差异）时不显示括号（无信息量）；
// 两条通路都落空时不显示括号（绝不臆造）；轨迹里的 canonical 必须逐字命中国标词表条目、
// 且 candidateId 与该条目 id 一致，否则丢弃。
function nationalStandardSyndromeName(
  reasoning: Record<string, unknown>,
  fieldPath: string,
  syndromeText: unknown,
): string {
  const syndrome = typeof syndromeText === "string" ? syndromeText.trim() : "";
  if (!syndrome) return "";
  const direct = resolveNationalStandardTcmSyndromeTerm(syndrome);
  // 判据是「国标原文与所存文本**是否不同**」，不是「命中方式是不是别名」（甲方 2026-08-05 R2）。
  //
  // 原来按 matchKind 判：alias 命中才显示国标名，canonical 命中一律返回空串。
  // 但 canonical 是**去后缀**规范名，与国标原文本就不同——「湿热困脾」vs 国标「湿热困脾证」。
  // 于是出现反直觉结果：医生点确认把证候归一到 canonical 之后，
  // 「（国标对应：湿热困脾证）」这个括注反而消失了，医生做了正确动作却看到更不规范的名字。
  // 改按文本差异判：别名命中照常显示；canonical 命中但缺「证」后缀时同样显示；
  // 所存文本已经逐字等于国标原文时才静默（此时再显示就是重复）。
  if (direct) return direct.standardTerm !== syndrome ? direct.standardTerm : "";
  for (const raw of Array.isArray(reasoning.terminologyMappings) ? reasoning.terminologyMappings : []) {
    const item = recordValue(raw);
    if (!item || item.namespace !== "tcm_syndrome" || item.fieldPath !== fieldPath) continue;
    if (typeof item.originalText !== "string" || item.originalText.trim() !== syndrome) continue;
    const governed = resolveNationalStandardTcmSyndromeTerm(item.canonical);
    if (governed?.matchKind === "canonical" && governed.id === item.candidateId) return governed.standardTerm;
  }
  return "";
}

function syndromeLabelWithNationalStandard(
  reasoning: Record<string, unknown>,
  fieldPath: string,
  syndromeText: unknown,
): string {
  const label = markdownCell(syndromeText);
  if (!label) return label;
  const standard = markdownCell(nationalStandardSyndromeName(reasoning, fieldPath, syndromeText));
  return standard ? `${label}（国标对应：${standard}）` : label;
}

/**
 * 指南/文献依据：只取**证据层真检索到**的条目。
 *
 * 甲方示例里写着《内科学》第10版、《中国成人社区获得性呼吸道感染诊治指南(2024)》这类引用。
 * 本项目铁律是「引用必须有 KB/证据条目背书」，所以这里不允许模型自己写：
 * 只有 evidence.evidenceLevel 表明来自外部证据（非 model_inference / 非病例内推理）时，
 * 才把 evidence.source 作为引用印出来。检索不到就一条不印——
 * 宁可少一栏，也不让一条编造的指南名出现在医生面前。
 */
function governedGuidelineReferences(primary: Record<string, unknown> | null | undefined): string[] {
  // 首选**服务端按 evidenceId 反查渲染**的结构化引用（甲方 2026-08-10 ⑩）。
  //
  // 归档量化（1531 个 json、2280 条 evidence）：model_inference 2177 条 = 95.5%，
  // source 全部是提示词模板里那句「病例内推理」——而下面第一个被排除的就是 model_inference、
  // 第二个正则第一个词就是「病例内推理」。模板在教模型填一个呈现层保证会丢掉的值，
  // 于是 grep「指南/文献依据」→ 0 个文件，这一栏自诞生起产出过 0 条。
  //
  // 结构化引用里的题名/机构/年份/URL 全部来自本轮真检索到的条目字段（见
  // cdss-evidence-context.resolveGovernedGuidelineReferences），模型只能写一句 appliesTo，
  // 因此这里可以直接印，不需要再过一遍反伪造白名单。
  const structured = recordList(primary?.guidelineReferences)
    .map((item) => {
      if (!markdownCell(item.citation)) return "";
      // 文字与地址由 clinical-fact-source 的共享投影产出（页面用的是同一处）；
      // 这一侧仍拼成一行纯文本，输出与此前逐字相同。
      const display = guidelineReferenceDisplay(item);
      return `${display.text}${display.href ? ` ${display.href}` : ""}`;
    })
    .filter(Boolean);
  if (structured.length > 0) return structured;
  const evidence = recordValue(primary?.evidence);
  const level = markdownCell(evidence?.evidenceLevel);
  const source = markdownCell(evidence?.source);
  if (!source) return [];
  if (!level || level === "model_inference" || level === "insufficient") return [];
  if (/^(?:病例内推理|无|暂无|未提供|未检索|待检索|内部证据缺口)$/.test(source)) return [];
  return [source];
}

/**
 * 鉴别条目的**受治理出处**。只在该证候/病名能解析到国标条目时才给出，
 * 解析不到就返回空——引用必须有条目背书，宁可不印，也不让一条编造的书名出现。
 */
function governedTermSourceLabel(name: string): string {
  const standard = resolveNationalStandardTcmSyndromeTerm(name);
  return standard ? "GB/T 16751.2-2021 中医临床诊疗术语·证候部分" : "";
}

/**
 * 一条中医鉴别怎么写给医生看（甲方 2026-08-10 示例格式）。
 *
 * 医生读鉴别要按顺序拿到三件事：这个证候/病名**通常长什么样** → **本例哪一点对不上**
 * → 需要做什么才能确认。原实现只有中间那一件，读者不知道拿什么在跟本例比。
 * 出处只印**受治理**的来源（国标 GB/T 16751.2-2021 等），取不到就不印——
 * 引用必须有条目背书，不让模型自己写《中医内科学》第10版。
 */
function differentialLine(name: string, item: Record<string, unknown>): string {
  const typical = markdownCell(item.typicalManifestation);
  const source = governedTermSourceLabel(name);
  return `- **${name}**：${clinicalSentence([
    typical ? `常见：${typical}` : "",
    markdownCell(item.reason),
    markdownCell(item.distinguishingPoints) ? `本例区分要点：${markdownCell(item.distinguishingPoints)}` : "",
    markdownCell(item.nextCheck) ? `建议核实：${markdownCell(item.nextCheck)}` : "",
    source ? `依据：${source}` : "",
  ], "；")}`;
}

/**
 * 与该病机同源的症状组事实，作为证候依据排序的备选池。
 * 判据与客户端卡片同源（clinicalEvidenceFingerprint 双向包含），不新增任何事实。
 */
function symptomClusterFacts(pathogenesis: Record<string, unknown> | null | undefined, nodePathogenesis: string): string[] {
  if (!nodePathogenesis) return [];
  const target = clinicalEvidenceFingerprint(nodePathogenesis);
  return recordList(pathogenesis?.symptomClusters)
    .filter((cluster) => {
      const mechanism = clinicalEvidenceFingerprint(markdownCell(cluster.mechanism));
      return Boolean(mechanism) && Boolean(target) && (mechanism.includes(target) || target.includes(mechanism));
    })
    .flatMap((cluster) => (Array.isArray(cluster.symptoms) ? cluster.symptoms : []))
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}

/** 病历接地正文的首行即主诉（trustedInputText 以 chiefComplaint 开头）。取不到就空串，排序照常工作。 */
function groundedChiefComplaint(clinicalContext: string): string {
  return clinicalContext.split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function visibleDiagnoseFromReasoning(reasoning: Record<string, unknown>, clinicalContext = "", caseState: unknown = null): string {
  const overview = recordValue(reasoning.overview);
  const westernDiagnosis = recordValue(reasoning.westernDiagnosis);
  const westernPrimary = recordValue(westernDiagnosis?.primary);
  const pathogenesis = recordValue(reasoning.pathogenesis);
  const therapy = recordValue(reasoning.therapy);
  const caseRelationship = recordValue(pathogenesis?.caseRelationship);
  const chain = recordList(pathogenesis?.chain).filter((node) =>
    isDisplayableClinicalText(markdownCell(node.patientFact)) &&
    isDisplayableClinicalText(markdownCell(node.syndromeEvidence)) &&
    isDisplayableClinicalText(markdownCell(node.pathogenesis)) &&
    isDisplayableClinicalText(markdownCell(node.therapyDirection))
  );
  const uncertainties = recordList(pathogenesis?.uncertainties);
  const subTherapies = recordList(therapy?.subTherapies);
  const westernHeading = `## ${clinicalOutputLabel("M03-western", "西医诊断倾向")}`;
  const overviewHeading = `## ${clinicalOutputLabel("M03-overview", "中医诊断概览")}`;
  const pathogenesisHeading = `## ${clinicalOutputLabel("M03-pathogenesis", "病机拆解")}`;
  const therapyHeading = `## ${clinicalOutputLabel("M03-therapy", "治则治法")}`;
  const lines = [
    "# 中医辅助诊疗报告",
    "",
    westernHeading,
    `**诊断倾向**：${westernDiagnosisLabelForDisplay(markdownCell(westernPrimary?.name), westernPrimary?.coding)}`,
  ];
  // 甲方评测(2026-08-04) 1.1.1：诊断依据分「支持/排除/待查」三类并标注事实来源。
  // 三类都是对已签名载荷既有字段的重新归类（见 clinical-fact-source.ts），不新增任何推断；
  // 来源取自受治理必填字段矩阵的字段名，标不出来源的条目照常呈现。
  // 两路来源合并，医生页面与本出口从此同源（2026-08-12 线上实测）。
  //
  // 只读接地正文是不够的：HIS 直传时 trustedInputText 把 hisRecord.fields 的值**不带标题**
  // 拼进正文（diagnosis-safety.ts:172），无标题的行只能落到「现病史」兜底，于是既往史与
  // 生命体征被印成「（来源：现病史）」并因此被分进「症状依据」。
  // 病例状态那一路直接读受治理字段路径，是**读出来的**归属；正文那一路留作兜底。
  // 谁优先不在这里判——统一交给 resolveClinicalFactSource（labeled 压过 guessed）。
  const evidenceSources = [
    ...clinicalFactSourcesFromCaseState(caseState),
    ...clinicalFactSourcesFromContext(clinicalContext),
  ];
  const evidence = classifyWesternDiagnosticEvidence(westernPrimary, evidenceSources);
  // 「支持依据」不得沦为病历原文的复印件(2026-08-05)。
  //
  // 甲方实测:该栏输出「大便时溏时泻，迁延反复，稍进油腻食物，则大便次数明显增加，食少，
  // 食后脘闷不舒，面」——一整句现病史原文,而且**在「面色萎黄」中间被截断**,末尾孤零零一个
  // 「面」字。字段本意是「逐项列事实」,实际成了整段病历的复印件,医生读到的不是诊断依据。
  //
  // 三条确定性清理,只改呈现形态,不改变任何结论、不新增推断:
  //  1) 截断残片:末尾分句短于 3 字且整条不以句末标点收尾 ⇒ 该残片是截断产物,去掉;
  //  2) 逐项拆分:一条里裹着多个并列事实时按分句拆开,恢复「逐项」的本意。因果句
  //     (「稍进油腻食物，则大便次数明显增加」)由「则/故/因此」判定并整句保留,不拆散;
  //  3) 舌脉出栏:舌象脉象不构成**西医**诊断依据,它们在中医辨证栏有完整呈现。
  //     留在西医卡里既占篇幅又误导——读者会以为舌淡在支持「腹泻，病因待查」。
  const trimTruncatedTail = (value: string): string => {
    const text = value.trim();
    if (/[。；;！!？?…]$/.test(text)) return text;
    const cut = text.lastIndexOf("，");
    if (cut < 0) return text;
    return text.length - cut - 1 < 3 ? text.slice(0, cut) : text;
  };
  const TONGUE_PULSE_ONLY = /^(?:舌|苔|脉)[^，,；;]*$/;
  const splitEnumeratedFacts = (value: string): string[] => {
    const text = trimTruncatedTail(value);
    if (!text) return [];
    // 逗号少于 2 个的短句不拆:那本来就是一条事实。
    if ((text.match(/[，,]/g) || []).length < 2) return [text];
    const parts: string[] = [];
    let buffer = "";
    for (const clause of text.split(/[，,]/).map((item) => item.trim()).filter(Boolean)) {
      // 因果/转折后件必须与前件合并,否则「则大便次数明显增加」会独立成条,读不懂。
      if (buffer && /^(?:则|故|因此|遂|即|便|以致|从而|并|伴|兼)/.test(clause)) {
        buffer = `${buffer}，${clause}`;
        continue;
      }
      if (buffer) parts.push(buffer);
      buffer = clause;
    }
    if (buffer) parts.push(buffer);
    return parts.filter((item) => item.length >= 3);
  };
  const evidenceLine = (label: string, values: readonly string[], withSource: boolean) => {
    const expanded = label === "指南/文献依据"
      ? values.map((value) => (typeof value === "string" ? trimTruncatedTail(value) : String(value)))
      : values.flatMap((value) => (typeof value === "string" ? splitEnumeratedFacts(value) : [String(value)]))
          .filter((item) => !TONGUE_PULSE_ONLY.test(item));
    const items = [...new Set(expanded)].map(markdownCell).filter(Boolean);
    if (items.length === 0) return;
    lines.push(`**${label}**：${joinClinicalClauses(
      items.map((item) => (withSource ? clinicalFactWithSource(item, evidenceSources) : item)), "；")}`);
  };
  // 依据分类呈现（甲方 2026-08-10）：删掉笼统的「支持依据」与「待查依据」，
  // 改成「有啥列啥」——症状依据 / 体征依据 / 检查依据 / 排除依据 / 指南依据。
  // 只有一类有内容时不写分类名，直接写「依据」（甲方示例三：上感只有一条依据）。
  // 指南依据只印**证据层真检索到**的条目：引用必须有 KB 条目背书是本项目铁律，
  // 检索不到就不出这一栏，不让模型自己写《内科学》第10版。
  // 候选诊断（甲方 2026-08-10「别就一个」）。第 1 条必须与主诊断一致，否则页面上会出现
  // 两个互相矛盾的「首选」——不一致时直接不呈现这一段，而不是把矛盾摆给医生。
  const westernCandidates = recordList(westernDiagnosis?.candidates)
    .filter((item) => isDisplayableClinicalText(markdownCell(item.name)));
  const primaryName = markdownCell(westernPrimary?.name);
  const candidatesUsable = westernCandidates.length > 1 && primaryName &&
    markdownCell(westernCandidates[0].name) === primaryName;
  const guidelineRefs = governedGuidelineReferences(westernPrimary);
  // 分组与标题走**与医生页面同一个**投影函数（2026-08-11）。此前这里手写一份、页面手写另一份，
  // 结果 0810 的分类改动只落到了这一侧，页面继续显示旧的「支持依据/待查依据」。
  const categorized = westernDiagnosticEvidenceGroups(evidence, guidelineRefs.map((text) => ({ text })));
  if (candidatesUsable) {
    lines.push(`**候选诊断（按可能性排序）**：${westernCandidates.map((item, index) => {
      const facts = (Array.isArray(item.keyEvidence) ? item.keyEvidence : [])
        .filter((fact): fact is string => typeof fact === "string" && Boolean(fact.trim()));
      const against = (Array.isArray(item.againstEvidence) ? item.againstEvidence : [])
        .filter((fact): fact is string => typeof fact === "string" && Boolean(fact.trim()));
      return clinicalSentence([
        `${index + 1}. ${markdownCell(item.name)}（可能性${markdownCell(item.likelihood) || "中"}）`,
        facts.length > 0 ? `支持：${facts.map(markdownCell).join("、")}` : "",
        against.length > 0 ? `不支持：${against.map(markdownCell).join("、")}` : "",
      ], "，").replace(/[。]$/, "");
    }).join("；")}`);
  }
  for (const group of categorized) evidenceLine(group.label, group.items.map((item) => item.text), group.withSource);
  lines.push(
    "",
    overviewHeading,
    // 甲方评测(2026-08-04) 1.2.1「中医诊断卡只保留证候结论，病名与病史复述移除」：
    // 中医病名与它的归属推理一并移到下方「中医辨病鉴别」段（辨病是独立的一段判断，
    // 与证候结论不该挤在同一张卡里）。字段本身不变，签名载荷与 HIS 方案照常携带 tcmDiseaseName。
    `**证型**：${syndromeLabelWithNationalStandard(reasoning, "overview.primarySyndrome", overview?.primarySyndrome)}`,
    // 服务端把模型选的方名剥离进 deferredFormulaSelection 之后，必须告诉医生它被剥离了。
    //
    // 剥离本身是对的：方名锁定要求签名证候与该方在治理目录中有直接关系，关系不成立就不该锁。
    // 但此前这个字段写进签名信封后**三处都不渲染**（界面、可见摘要、HIS 全无），医生只看到
    // 「本例辨证组方」，完全不知道模型其实选了方、更不知道为什么没采纳。
    //
    // 实测一例：24 岁女性，恶寒重发热轻、无汗、脉浮紧、舌淡红苔薄白——教科书麻黄汤证。
    // 模型选的正是麻黄汤，服务端因「模型签名的是风寒束**表**证，而麻黄汤在目录里标的是
    // 风寒束**肺**证」判定关系不成立，剥离后显示自拟方。两个国标证候码相邻却互不关联，
    // 这属于术语治理层要补的关系；在补上之前，至少不能让医生连模型选过什么都看不到。
    ...deferredFormulaSelectionLines(overview),
    "",
    pathogenesisHeading,
    `**总体病机**：${markdownCell(overview?.overallPathogenesis)}`,
  );
  // 病机去重账本按**呈现顺序**登记：总体病机是本节标题句，先占位；后续四个病机字段命中即改短引用。
  const pathogenesisLedger = createPathogenesisNarrativeLedger();
  pathogenesisLedger.claim(overview?.overallPathogenesis);
/**
 * 被剥离的方名选择渲染成一行医生可读的说明。方名只从签名信封里逐字取出，不重新检索、不代选，
 * 措辞明确写成「未锁定、供医生判断」，避免被读成推荐。
 */
function deferredFormulaSelectionLines(overview: Record<string, unknown> | null | undefined): string[] {
  const deferred = recordValue(overview?.deferredFormulaSelection);
  if (!deferred) return [];
  const names = Array.isArray(deferred.names)
    ? deferred.names.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
    : [];
  if (names.length === 0) return [];
  return [`**未锁定经典方方向**：本次分析曾检索到 ${names.map(markdownCell).join("、")}，但该方与本例签名证候尚无可核验的直接对应关系，因此未予锁定为候选处方；仅供医生进行方证鉴别。`];
}

  // 甲方评测(2026-08-03)要求鉴别诊断给到病名级：辨病鉴别(相邻中医病名)在前、证候鉴别在后，
  // 两层分节呈现，标题不再笼统写「中医鉴别」。
  //
  // 2026-08-04 的 1.2.1 在此之上再分一层：概览卡只留证候结论，**辨病**（病名 + 归属推理）与
  // **辨证**（推理链）各自成段。此前辨证分析直接插在概览卡里，卡片因此同时载着结论、病名与
  // 一整段引用了主诉原文的推理——甲方读到的就是「诊断卡里又在复述病史」。分段之后，
  // 卡片回答「是什么证」，两个分段各自回答「为什么是这个病名/这个证型」，与客户端诊断卡同构。
  const tcmDiseaseName = markdownCell(overview?.tcmDiseaseName);
  const tcmDiseaseDifferentials = recordList(overview?.tcmDiseaseDifferentials);
  // 服务端结构化正文**始终**带病名：0805 需求3 要求诊断出三个（西医 / 中医辨病 / 中医辨证），
  // HIS 写回与导出链路读的就是这一份。医生屏幕上要不要显示是另一件事，由
  // TCM_DISEASE_NAME_VISIBLE_TO_CLINICIAN 在客户端两个出口统一决定（见该常量注释）。
  const showTcmDiseaseName = isDisplayableClinicalText(tcmDiseaseName);
  if (showTcmDiseaseName || tcmDiseaseDifferentials.length > 0) {
    const insertAt = lines.indexOf(pathogenesisHeading);
    lines.splice(insertAt, 0,
      "### 中医辨病",
      ...(showTcmDiseaseName ? [`**中医病名**：${tcmDiseaseName}`] : []),
      ...(isDisplayableClinicalText(markdownCell(overview?.tcmDiseaseRationale))
        ? [`**辨病推理**：${markdownCell(overview?.tcmDiseaseRationale)}`]
        : []),
      "",
    );
  }
  // 辨病鉴别缺席时必须说明,不能静默消失(2026-08-05)。
  //
  // 甲方反馈「中医的鉴别诊断依据应该是病的而不是证候的」。核对 20 例线上语料:辨病鉴别
  // 27 条**全部是病名**(泄泻↔痢疾、感冒↔咳嗽),一条证候都没混进来,分栏本身是对的。
  // 真正的问题是另一件事——3 例中医病名根本没成立,于是「中医辨病鉴别」整段静默消失,
  // 页面上只剩「中医证候鉴别」。医生看到的就是「鉴别诊断怎么全是证候」。
  // 缺席的原因必须写出来:是辨病未成立,不是把证候当成了病。
  if (tcmDiseaseDifferentials.length === 0 && recordList(overview?.tcmDifferentials).length > 0) {
    const insertAt = lines.indexOf(pathogenesisHeading);
    lines.splice(insertAt, 0,
      "### 中医辨病鉴别",
      isDisplayableClinicalText(markdownCell(overview?.tcmDiseaseName))
        ? "本例现有资料未形成需要区分的相邻中医病名，故未列辨病鉴别。"
        : "本例中医病名尚未成立，故不列辨病鉴别；证候层面的取舍见上方辨证依据。",
      "");
  }
  if (tcmDiseaseDifferentials.length > 0) {
    const insertAt = lines.indexOf(pathogenesisHeading);
    lines.splice(insertAt, 0,
      "### 中医辨病鉴别",
      ...tcmDiseaseDifferentials.map((item) => differentialLine(markdownCell(item.diseaseName), item)),
      "",
    );
  }
  if (isDisplayableClinicalText(markdownCell(overview?.tcmDiagnosticRationale))) {
    lines.splice(lines.indexOf(pathogenesisHeading), 0,
      "### 中医辨证",
      `**辨证推理**：${markdownCell(overview?.tcmDiagnosticRationale)}`,
      "",
    );
  }
  const tcmDifferentials = recordList(overview?.tcmDifferentials);
  // 甲方 2.2「鉴别诊断展示错误：要求根据病名进行鉴别诊断，目前还有证候鉴别」(2026-08-05)。
  //
  // 鉴别诊断在医生的阅读习惯里是**病名级**判断（泄泻↔痢疾、感冒↔咳嗽），与它并列摆一段
  // 证候鉴别，读者会把两者都当成鉴别诊断。证候之间的取舍属于辨证过程，本就该在辨证段落里
  // 交代，而不是另立一段与辨病鉴别对仗。
  //
  // 只从**可见正文**移除，签名载荷 overview.tcmDifferentials 与 HIS 出参一字不动——
  // 已集成的调用方仍能拿到这份数据，医生页面不再把它当鉴别诊断呈现。
  // 2026-08-10 甲方给了新的示例，明确要看到「不寐·肝火扰心证 — 常见…本例无热象可排除」
  // 这种证候级取舍。它与上面 2.2 那条并不矛盾——2.2 反对的是把证候鉴别**另立一段**
  // 与辨病鉴别对仗（读者会把两者都当鉴别诊断），并且原话就写着「证候之间的取舍属于辨证
  // 过程，本就该在辨证段落里交代」。所以这里把它放回**辨证段之内**，标题写「证候取舍」
  // 而不是「鉴别诊断」，格式与辨病鉴别同源（differentialLine）。
  if (tcmDifferentials.length > 0) {
    const insertAt = lines.indexOf(pathogenesisHeading);
    if (insertAt >= 0) {
      lines.splice(insertAt, 0,
        "**证候取舍**：",
        ...tcmDifferentials.map((item) => differentialLine(markdownCell(item.syndrome), item)),
        "",
      );
    }
  }
  if (!isDisplayableClinicalText(markdownCell(overview?.overallPathogenesis)) && isDisplayableClinicalText(markdownCell(pathogenesis?.summary))) {
    lines.push(`**病机归纳**：${markdownCell(pathogenesis?.summary)}`);
  }
  const locationDifferentiation = recordValue(pathogenesis?.locationDifferentiation);
  const natureDifferentiation = recordValue(pathogenesis?.natureDifferentiation);
  const locationItems = Array.isArray(locationDifferentiation?.items)
    ? locationDifferentiation.items.map(markdownCell).filter(isDisplayableClinicalText)
    : [];
  const natureItems = Array.isArray(natureDifferentiation?.items)
    ? natureDifferentiation.items.map(markdownCell).filter(isDisplayableClinicalText)
    : [];
  if (locationItems.length > 0) lines.push(`**病位辨证**：${joinClinicalClauses(locationItems, "、")}`);
  const locationDetails = recordList(locationDifferentiation?.details);
  if (locationDetails.length > 0) {
    lines.push(...locationDetails.map((item) => `- **${markdownCell(item.location)}**：${markdownCell(item.basis)}`));
  }
  if (natureItems.length > 0) lines.push(`**病性辨证**：${joinClinicalClauses(natureItems, "、")}`);
  if (isDisplayableClinicalText(markdownCell(natureDifferentiation?.basis))) {
    lines.push(`**病性依据**：${markdownCell(natureDifferentiation?.basis)}`);
  }
  if (caseRelationship && [caseRelationship.rootPattern, caseRelationship.mainManifestation, caseRelationship.relationship].some((item) => isDisplayableClinicalText(markdownCell(item)))) {
    lines.push(
      `**本证**：${markdownCell(caseRelationship.rootPattern)}`,
      `**主要表现**：${markdownCell(caseRelationship.mainManifestation)}`,
      // 病机联系与总体病机逐字相同是最常见的一处重复：本行只在它确实补充了新内容时才出现。
      ...(pathogenesisLedger.claim(caseRelationship.relationship)
        ? [`**病机联系**：${markdownCell(caseRelationship.relationship)}`]
        : []),
    );
  }
  if (chain.length > 0) {
    lines.push(
      "",
      "### 子病机与治法",
      "| 患者事实 | 证候依据 | 子病机 | 对应治法 |",
      "|---|---|---|---|",
      // 子病机列：若该节点病机已被总体病机逐字包含，改写为短引用而不是把同一句再抄一遍。
      // 表格不留空单元格——「已含于总体病机」本身就是医生要的信息（这一节点没有额外内容）。
      //
      // 证候依据列接 prioritizeTcmEvidenceForDisplay（甲方 2026-08-10 ②）：该排序此前只被
      // 客户端一张 React 卡片消费，可见 Markdown 与 HIS 两个出口把原始 syndromeEvidence
      // 直接印出去，于是同一份签名载荷在三个出口呈现不一致（主诉复述在这里照印、在卡片里被降权）。
      ...chain.map((node) => `| ${markdownCell(node.patientFact)} | ${
        markdownCell(prioritizeTcmEvidenceForDisplay(
          [markdownCell(node.syndromeEvidence)],
          symptomClusterFacts(pathogenesis, markdownCell(node.pathogenesis)),
          groundedChiefComplaint(clinicalContext),
          2,
        ).join("；") || markdownCell(node.syndromeEvidence))
      } | ${markdownCell(node.pathogenesis)} | ${markdownCell(node.therapyDirection)} |`),
    );
  }
  lines.push(
    "",
    therapyHeading,
    `**治则**：${markdownCell(therapy?.overallPrinciple)}`,
    `**总治法**：${markdownCell(therapy?.overallMethod) || markdownCell(overview?.overallTherapy)}`,
  );
  if (subTherapies.length > 0) {
    lines.push(
      "",
      "| 分治方向 | 对应病机 |",
      "|---|---|",
      // 医生必须能在每个分治方向旁直接读到真实病机，不使用跨段占位。
      ...subTherapies.map((item) => `| ${markdownCell(item.therapy)} | ${markdownCell(item.targetPathogenesis)} |`),
    );
  }
  // 流派适配记录（甲方基线 §10.2：报告须简洁说明采用了哪些流派特征）。
  // 可展示判据与医生页面、HIS 共用同一实现 displayableLineageAdaptation：
  // 未选具体流派 / 空壳内容一律不出现；安全让位声明永远随段落出现。
  const lineageDisplay = displayableLineageAdaptation(reasoning.lineageAdaptation);
  if (lineageDisplay) {
    lines.push(
      "",
      `## ${clinicalOutputLabel("M03-M04-lineage", "流派适配记录")}`,
      `**诊疗思路**：${markdownCell(lineageDisplay.label)}（本例${lineageDisplay.applicability}）`,
      ...(lineageDisplay.reason ? [`**适配说明**：${markdownCell(lineageDisplay.reason)}`] : []),
      ...lineageDisplay.influencedDecisions.map((item) => `- **${markdownCell(item.aspect)}**：${markdownCell(item.detail)}`),
      ...(lineageDisplay.alternativeDirection ? [`**替代方向**：${markdownCell(lineageDisplay.alternativeDirection)}`] : []),
      `**安全边界**：${markdownCell(lineageDisplay.safetyBoundary)}`,
    );
  }
  if (uncertainties.length > 0) {
    lines.push(
      "",
      "## 需复核的不确定项",
      ...uncertainties.map((item) => `- **${markdownCell(item.item)}**：${clinicalSentence([
        markdownCell(item.reason),
        markdownCell(item.affects) ? `影响：${markdownCell(item.affects)}` : "",
      ], "；")}`),
    );
  }
  // M03 management remains structured input for M05. It is intentionally not repeated in the
  // diagnosis report, where generic "未记录/待核实" safety lists read like positive findings.
  return `${lines.filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n").trim()}\n\n`;
}

function visiblePrescribeFromReasoning(reasoning: Record<string, unknown>): string {
  const formula = recordValue(reasoning.formula);
  const candidate = recordList(formula?.candidates)[0];
  const decoction = recordValue(candidate?.decoction);
  const formulaSource = recordValue(candidate?.formulaSource);
  const discriminationPath = recordList(candidate?.discriminationPath);
  const classicEvidence = recordList(candidate?.classicEvidence);
  const compositionLogic = recordList(candidate?.compositionLogic);
  const textualModifications = recordList(candidate?.textualModifications);
  const patentAndWestern = recordList(formula?.patentAndWestern).filter((item) => {
    const evidence = recordValue(item.evidence);
    return [item.name, item.correspondingProblem, item.evidenceId, item.evidenceFingerprint]
      .every((value) => isDisplayableClinicalText(markdownCell(value))) &&
      customerEvidenceDisplayStatus(evidence) === "traceable";
  });
  const medicineCandidateStatus = recordValue(formula?.medicineCandidateStatus);
  const modifications = recordList(formula?.modifications).filter((item) =>
    [item.trigger, item.action, item.targetPathogenesis, item.reason]
      .every((value) => isDisplayableClinicalText(markdownCell(value)))
  );
  const nonPharma = recordValue(reasoning.nonPharma);
  const lines = [
    `# ${clinicalOutputLabel("M04-formula", "候选方药")}`,
  ];
  if (candidate) {
    const constructionType = markdownCell(candidate.constructionType);
    const isSelfDevised = constructionType === "self_devised";
    const isSingleHerb = constructionType === "single_herb";
    lines.push(
      "",
      `## ${markdownCell(candidate.name)}`,
      ...(isSelfDevised ? ["**方案类型**：自拟方"] : isSingleHerb ? ["**方案类型**：单味方案"] : []),
      ...(candidate.identityDeclassified === true ? [
        // 把「原本锁的是什么」一并说出来。只写「未沿用原命名经方身份」时，医生看到的是
        // M03 页推荐麻黄汤、M04 页给一张不含麻黄的自拟方，两页互相矛盾又无从判断原因。
        // 这里不改任何门禁判定，只是把系统已经知道、却没告诉医生的那半句补上。
        ...(recordList(candidate.declassifiedFromFormulaNames).length > 0
          || (Array.isArray(candidate.declassifiedFromFormulaNames)
            && candidate.declassifiedFromFormulaNames.length > 0)
          ? [`**处方身份说明**：M03 原锁定「${(candidate.declassifiedFromFormulaNames as string[])
            .map((value) => markdownCell(value)).filter(Boolean).join("、")}」，`
            + "但本方实际组成与该方的标准组成不符，已按自拟方呈现，不代表原方或经典出处；"
            + "如需按原方开具，请补齐缺失药味后重新生成，或按当前完整药味与剂量重新审方。"]
          : ["**处方身份说明**：实际组成未沿用原命名经方身份，不代表原方或经典出处；请按当前完整药味与剂量重新审方。"]),
      ] : []),
      ...(!isSelfDevised && !isSingleHerb && customerEvidenceDisplayStatus(formulaSource) === "traceable"
        ? [`**方剂出处**：${markdownCell(formulaSource?.source)}`]
        : []),
      "",
      "### 药味清单",
      canonicalHerbTable(candidate),
      // 配伍禁忌确定性警示(2026-08-03 瘿病案根修): 检测下沉到渲染层**无条件执行**——
      // 任何上游旗标(审方委托 auditedClinicalRisksAreAdvisory 等)都只能改变处置,不能关掉检测。
      // 此前该旗标把合同层的十八反检查整个跳过,甘草+海藻自拟方在医生页面零提示地出方
      // (HIS/L4 与审方仍拦,但 M04 页面沉默)。渲染层命中即显著呈现,处置权交医生/药师。
      ...(() => {
        const herbNames = (Array.isArray(candidate.herbs) ? candidate.herbs : [])
          .map((herb) => (herb && typeof herb === "object" ? String((herb as Record<string, unknown>).name || "") : ""))
          .filter(Boolean);
        const pairs = herbNames.length >= 2 ? findTcmHerbPairIncompatibilities(herbNames) : [];
        if (pairs.length === 0) return [] as string[];
        return [
          "",
          "### ⚠️ 配伍禁忌提示（确定性检测）",
          ...pairs.map((pair) => `- **${pair.leftDrug} × ${pair.rightDrug}**：命中${pair.category || "十八反十九畏"}（${pair.basis || "本地配伍规则"}）。是否同用须由医师专项权衡并说明理由，采纳前必须经药师逐对复核；本提示为本地规则确定性生成，不可关闭。`),
        ];
      })(),
      // 证-方方向核对(2026-08-04,甲方考题集裁决第1条):证名与所选方各自看都像话、合起来
      // 自相矛盾的病例此前无任何一层校验(实测判「脾虚湿蕴证」却锁定寒湿阻遏专方茵陈术附汤)。
      // 与配伍禁忌同样是**提示不阻断**:确定性检出即呈现,处置权交医生。
      ...(() => {
        const formulaNames = [
          ...(Array.isArray(candidate.formulaNames) ? candidate.formulaNames : []),
          ...(typeof candidate.name === "string" ? [candidate.name] : []),
        ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
        const overviewRecord = recordValue(reasoning.overview);
        const syndrome = typeof overviewRecord?.primarySyndrome === "string" ? overviewRecord.primarySyndrome : "";
        const notice = formulaSyndromeConflictNotice(formulaSyndromeConflicts(formulaNames, syndrome));
        return notice ? ["", notice] : [];
      })(),
      "",
      "### 方义分析",
      markdownBlock(candidate.formulaAnalysis),
    );
    if (compositionLogic.length > 0) {
      lines.push(
        "",
        "### 组成逻辑",
        // tier/anchorLevel 是内部枚举（canon/common/experience、tiaowen/…）。此前直接 `${}` 进
        // 医生可见 Markdown，医生页面上就出现「（canon）」这种工程记号——与 L0/L1/L3 同一类问题。
        // 统一走 internal-tag-hygiene 的标签表，枚举→中文；未收录的取值整段省略而不是打印原码。
        ...compositionLogic.map((item) =>
          `- **${markdownCell(item.formulaName)}**：${markdownCell(item.summary)}${
            classicTierLabel(item.tier) ? `（${classicTierLabel(item.tier)}）` : ""}`),
      );
    }
    if (discriminationPath.length > 0) {
      lines.push(
        "",
        "### 方证鉴别路径",
        ...discriminationPath.map((item) =>
          `- 与 **${markdownCell(item.againstFormula)}** 鉴别：${clinicalSentence([
            markdownCell(item.question),
            markdownCell(item.status) ? `当前状态：${markdownCell(item.status)}` : "",
          ], "；")}`),
      );
    }
    if (classicEvidence.length > 0) {
      lines.push(
        "",
        "### 经典条文依据",
        ...classicEvidence.map((item) => {
          const qualifiers = joinClinicalClauses([
            [classicAnchorLabel(item.anchorLevel), markdownCell(item.clauseNumber)].filter(Boolean).join(" "),
            classicTierLabel(item.tier),
          ].filter(Boolean), "；");
          return `- ${markdownCell(item.citation)}${qualifiers ? `（${qualifiers}）` : ""}`;
        }),
      );
    }
    if (textualModifications.length > 0) {
      lines.push(
        "",
        "### 条文加减复核线索（未自动应用）",
        ...textualModifications.map((item) => {
          const addHerbs = joinClinicalClauses(semanticItems(item.addHerbs), "、") || "无";
          const removeHerbs = joinClinicalClauses(semanticItems(item.removeHerbs), "、") || "无";
          const resultingFormula = clinicalClauseText(markdownCell(item.resultingFormula));
          return `- **${markdownCell(item.ruleId)}**：${clinicalSentence([
            `当前阳性触发 ${joinClinicalClauses(semanticItems(item.matchedTriggers), "、")}`,
            resultingFormula ? `参考结果方 ${resultingFormula}` : "",
            `加 ${addHerbs}，去 ${removeHerbs}`,
            `证据 ${markdownCell(item.sourceCitation)}`,
          ], "；")}须由医生复核，不会自动改写本处方。`;
        }),
      );
    }
    if (decoction) {
      const dosesPerDayText = markdownNumberCell(decoction.dosesPerDay);
      const administrationTimesText = markdownNumberCell(decoction.administrationTimesPerDay);
      lines.push(
        "",
        "### 剂数与煎服",
        `**剂数**：${markdownCell(decoction.doseCount)}`,
        // 两个数字任一缺失时整行省略——宁可少一行，不产出「每日  剂」空白模板。
        ...(dosesPerDayText && administrationTimesText
          ? [`**每日剂数 / 分服次数**：每日 ${dosesPerDayText} 剂 / 每日分 ${administrationTimesText} 次服`]
          : []),
        `**煎服法**：${markdownCell(decoction.method)}`,
        // 需求5：处方展示面不再出现复诊节点（M05「随访管理方案/随访时间轴」仍确定性给出首次复诊
        // 时间）。decoction.followUpNode 字段本身及其服务端确定性生成（applyDeterministicFollowUpNode）
        // 必须保留——它是 rxaudit 提交门、HIS 导出与 M05 首次复诊的唯一数据源，删字段即 fail-open。
        // 保留 joinClinicalClauses 包裹：clinicalClauseText 会剥尾部标点，直接用 markdownCell 会改变归一化行为。
        `**疗程建议**：${joinClinicalClauses([markdownCell(decoction.course)])}`,
      );
    }
  }
  if (modifications.length > 0) {
    const modificationPathogenesisLedger = createPathogenesisNarrativeLedger();
    lines.push("", "## 随证加减建议", ...modifications.map((item) => {
      const triggerSource = recordValue(item.triggerSource);
      const sourceQuote = markdownCell(triggerSource?.sourceQuote);
      const target = markdownCell(item.targetPathogenesis);
      const displayedTarget = modificationPathogenesisLedger.claim(target) ? target : "";
      // 可替换药味另起一行呈现（甲方接口需求）。缺货/过敏/特殊人群禁用时医生要有备选，
      // 而「替代品与原药差异在哪」是临床最容易出事的地方，必须与药名同时给出。
      const substitutions = recordList(item.substitutions)
        .map((sub) => `${markdownCell(sub.replaces)} → ${markdownCell(sub.substitute)}（${clinicalSentence([
          markdownCell(sub.rationale), markdownCell(sub.differenceNote),
        ], "；")}）`)
        .filter(Boolean);
      return [`- **${markdownCell(item.trigger)}**：${clinicalSentence([
        markdownCell(item.action),
        displayedTarget ? `对应病机：${displayedTarget}` : "",
        markdownCell(item.reason),
        sourceQuote ? `触发依据：${sourceQuote}` : "",
        // riskNote 是加减行的**合同必填字段**，React 卡片与 HIS 出参都呈现它，
        // 唯独这条 Markdown 分支从不读它（甲方 2026-08-10 ⑥）：同一份签名载荷，
        // 三个出口里两个有风险提示、一个没有。加减本身会改变方的构成，
        // 「这一加会带来什么风险」正是医生采纳前要看的那句。
        markdownCell(item.riskNote) ? `风险提示：${markdownCell(item.riskNote)}` : "",
      ], "；")}`,
        ...(substitutions.length > 0
          ? [`  - 可替换药味：${substitutions.join("；")}（替代药同样受剂量上限、十八反十九畏与特殊人群规则约束）`]
          : []),
      ].join("\n");
    }));
  }
  if (patentAndWestern.length > 0) {
    lines.push(
      "",
      `## ${clinicalOutputLabel("M04-patent-western", "中成药/西药候选")}`,
      "| 类型 | 药品 | 规格 | 建议层级 | 用药定位 | 对应问题 | 参考文献 | 风险提示 |",
      "|---|---|---|---|---|---|---|---|",
      ...patentAndWestern.map((item) => {
        const itemEvidence = recordValue(item.evidence);
        const level = item.recommendationMode === "discussion_only" ? "仅供讨论（无剂量）" : "说明书绑定候选（无剂量）";
        return `| ${markdownCell(item.type)} | ${markdownCell(item.name)} | ${markdownCell(item.specification) || "—"} | ${level} | ${markdownCell(item.positioning)} | ${markdownCell(item.correspondingProblem)} | ${markdownCell(itemEvidence?.source)} | ${markdownCell(item.riskNote)} |`;
      }),
    );
  } else if (medicineCandidateStatus?.status === "no_evidence_match" && isDisplayableClinicalText(markdownCell(medicineCandidateStatus.reason))) {
    lines.push("", `## ${clinicalOutputLabel("M04-patent-western", "中成药/西药候选")}`, markdownCell(medicineCandidateStatus.reason));
  }
  if (nonPharma) {
    const clinicianTreatmentProjects = buildClinicianTreatmentProjects(
      normalizeReasoningV2(reasoning)?.nonPharma,
    );
    const hasDietTherapyProject = clinicianTreatmentProjects.some((item) => item.projectCode === "diet_therapy");
    lines.push("", `## ${clinicalOutputLabel("M03-M04-nonpharma", "非药物调护与中医项目")}`);
    for (const [label, key] of [["饮食", "diet"], ["起居", "lifestyle"], ["情志", "emotion"], ["穴位保健", "acupointCare"]] as const) {
      // 饮食一栏必须过食疗净化再印（甲方 2026-08-05 衍生条目）。
      //
      // 此前净化只做在客户端 DiagnosisClient，而**服务端可见正文走的是未净化原文**——
      // 这份正文会进 caseState.prescription、HIS 的处方卡片与各类导出，
      // 于是「宜多食山楂、黑木耳以活血化瘀」这类把食物写成治疗手段的表述，
      // 在医生界面上被拦下了，在接口与导出里却照样流出去。净化必须做在所有出口，不是某一个。
      //
      // 这里不传过敏史/用药史：可见正文层拿不到它们，缺省即走**更保守**的那句兜底
      // （safeDietAdviceForDisplay 在信息未知时本就如此设计），宁可保守不可放宽。
      const raw = key === "diet"
        ? safeDietAdviceForDisplay(String(nonPharma[key] ?? ""), {})
        : nonPharma[key];
      if (key === "diet" && hasDietTherapyProject) continue;
      if (isDisplayableClinicalText(markdownCell(raw))) lines.push(`- **${label}**：${markdownCell(raw)}`);
    }
    if (clinicianTreatmentProjects.length > 0) {
      lines.push("", "### 中医非药物方案");
      for (const item of clinicianTreatmentProjects) {
        lines.push(
          `#### ${markdownCell(item.title)}`,
          `- **核心内容**：${markdownCell(item.content)}`,
          ...(item.sitesOrPoints && item.sitesOrPoints.length > 0
            ? [`- **穴位/部位**：${joinClinicalClauses(item.sitesOrPoints.map(markdownCell), "；")}`]
            : []),
          ...(item.schedule ? [`- **频次/复评**：${markdownCell(item.schedule)}`] : []),
        );
      }
    }
    // 渲染侧从「监测指标」三列表格改为「注意事项」条目列表：字段已由 metric/timing/trigger
    // 三元组换成自由文本 precautions（见 diagnosis-types 与 diagnosis-stage-contract 的注释）。
    const precautions = Array.isArray(nonPharma.precautions)
      ? nonPharma.precautions
          .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
          .map(markdownCell)
          .filter(isDisplayableClinicalText)
      : [];
    if (precautions.length > 0) {
      lines.push("", "### 注意事项", ...precautions.map((item) => `- ${item}`));
    }
  }
  return `${lines.filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n").trim()}\n\n`;
}

/** 中医治疗项目 protocolGap 的医生可读文案。受控映射，认不出的码返回空串（不上屏）。
 *  导出供 HIS 写回同源消费——同一个码在两个出口翻成两种说法，正是本轮反复出现的缺陷形状。 */
/**
 * 「系统看到了什么、为什么没用」的**唯一**说法（2026-08-11）。
 *
 * 待终审的证型配穴此前只铺到了医生页面与 HIS 两个出口，服务端 Markdown 一句没有——
 * 又是同一形状。加第三态（待签字的病种模板）时一并收口：三个出口共用这两句话。
 */
export function deferredSyndromeRefinementCopy(
  deferred: { syndromeLabel?: unknown; deferredPoints?: unknown; conflictNote?: unknown } | undefined,
): string {
  if (!deferred) return "";
  const label = markdownCell(deferred.syndromeLabel);
  if (!label) return "";
  const points = (Array.isArray(deferred.deferredPoints) ? deferred.deferredPoints : [])
    .map((point) => markdownCell(point)).filter(Boolean);
  return clinicalSentence([
    `本例已签名证候命中「${label}」的配穴方案${points.length > 0 ? `（${points.join("、")}）` : ""}，但该条尚未完成中医师终审，本轮未予应用`,
    markdownCell(deferred.conflictNote),
  ], "；");
}

/**
 * 命中但**尚未中医师签字**的病种标准取穴模板。与上一句的区别必须说清楚：
 * 上一句是「病种模板能用、这条证型加减不敢用」，这一句是「整条病种模板都还没签字，本例保持评估态」。
 * 写成同一句话，医生就无从判断眼前这几个穴到底是不是受治理的取穴。
 */
export function deferredGovernedTemplateCopy(
  deferred: { indicationLabel?: unknown; deferredPoints?: unknown; conflictNote?: unknown } | undefined,
): string {
  if (!deferred) return "";
  const label = markdownCell(deferred.indicationLabel);
  if (!label) return "";
  const points = (Array.isArray(deferred.deferredPoints) ? deferred.deferredPoints : [])
    .map((point) => markdownCell(point)).filter(Boolean);
  return clinicalSentence([
    `本例已匹配到「${label}」的标准取穴${points.length > 0 ? `（${points.join("、")}）` : ""}，但该模板尚未完成中医师签字终审，本轮不作为患者级方案，本项目仍按评估态呈现`,
    markdownCell(deferred.conflictNote),
  ], "；");
}

/**
 * 治疗方案的「加减状态」说法——**唯一**一处（2026-08-11 对抗性复核抓到）。
 *
 * 缺陷：patient-specific 这一档的三处措辞（Markdown 方案状态、Markdown 穴位标题、页面徽标与穴位标题）
 * 一律写「按证型加减」，而「加减」断言的是**在基础方上做过增删**这个动作。
 * 新增的证型专用模板（精确闸门选中）根本没有加减穴——它是整条按证型选的方案，
 * 于是页面告诉医生"系统在基础方上增删过"，而实际没有。产出侧自己的 treatmentContent 说的是
 * 「以本例当前病种事实与已签名证型双重条件准入」，同一个状态三处三种说法，其中两处断言了没发生的事。
 *
 * 区分判据不引入新枚举值（新增枚举破坏 V1 是本轮已经吃过的亏），而是读**已有的**逐穴溯源：
 * 有 syndrome_refinement 角色 ⇒ 确实做过证型加减；没有 ⇒ 是证型专用模板选中。
 * 三个出口共用这一处，不可能再各说各的。
 */
export function tcmTreatmentTailoringPresentation(item: {
  protocolStatus?: unknown;
  pointProvenance?: ReadonlyArray<{ role?: unknown }> | null;
}): { status: string; pointsLabel: string; badge: string } {
  const status = markdownCell(item.protocolStatus);
  const roles = (Array.isArray(item.pointProvenance) ? item.pointProvenance : []).map((entry) => markdownCell(entry?.role));
  if (status === "governed_patient_specific_plan") {
    const refined = roles.includes("syndrome_refinement") || roles.includes("syndrome_removal");
    const conditional = roles.includes("conditional_point");
    if (refined) {
      return {
        status: "已按本例证型加减取穴的标准方案，仍须医生复核",
        pointsLabel: "按本例证型加减后的候选穴位",
        badge: "按证型加减 · 待复核",
      };
    }
    // 证型专用模板：整条方案按本例已签名证型选定，没有在基础方上增删。
    return {
      status: `本例证型专用的标准取穴方案${conditional ? "（含按本例症状触发的条件加穴）" : ""}，仍须医生复核`,
      pointsLabel: `本例证型专用标准取穴${conditional ? "（含条件加穴）" : ""}`,
      badge: "证型专用方案 · 待复核",
    };
  }
  if (status === "governed_class_template_not_syndrome_tailored") {
    return {
      status: "已命中该病种标准取穴模板，尚未按本例证型加减，须医生按证型增减后实施",
      pointsLabel: "该病种标准取穴模板（未按本例证型加减）",
      badge: "病种模板 · 未按证型加减",
    };
  }
  return {
    status: "仅作项目评估，未形成患者级操作方案",
    pointsLabel: "常用穴位（通用参考，未按本例适应证核定）",
    badge: "仅项目评估",
  };
}

export function tcmTreatmentProtocolGapCopy(gap: string): string {
  if (gap === "catalog_indication_mismatch") return "本项目目录中暂无与本例适应证对应的标准操作方案，本轮仅作现场评估。";
  if (gap === "catalog_protocol_absent") return "本项目尚无可下发的患者级操作方案，本轮仅作现场适应证与资质评估。";
  if (gap === "syndrome_refinement_not_matched") return "已命中该病种标准取穴模板，但本例已确认证候未匹配到标准的证型加减方案，请医生按本例寒热虚实增减后实施。";
  // 2026-08-11：命中了证型配穴、但那一条尚未完成中医师终审。与上一条的区别必须说清楚——
  // 上一条是「没有对应的加减」，这一条是「有，但我们还不敢用」。把两者写成同一句话，
  // 医生就无从判断是该自己加减、还是该等我们的终审结论。
  if (gap === "syndrome_refinement_pending_adjudication") return "已命中该病种标准取穴模板与本例证型的配穴方案，但该条配穴尚未完成中医师终审，本轮不予应用；下方仅为病种标准取穴，请医生按本例寒热虚实自行增减。";
  return "";
}

/**
 * 投影前把载荷过一遍 schema 归一。签名前 attachClinicalReviewAttestation 用的就是这一份归一结果，
 * 提前到这里等于让「页面看到的」与「载荷里存着的」出自同一次归一。
 * 归一抛错时返回原对象：宁可保留一次未归一的呈现，也不能让整页 M03/M04 消失。
 */
function normalizedReasoningForProjection(parsed: Record<string, unknown>): Record<string, unknown> {
  try {
    // safeParse 失败时返回 undefined（不是抛错），这一分支必须显式接住：
    // 拿 undefined 去投影会把整页 M03/M04 变成空壳。
    return (normalizeReasoningV2(parsed) as unknown as Record<string, unknown> | undefined) ?? parsed;
  } catch {
    return parsed;
  }
}

export function synchronizeVisibleClinicalSummary(
  content: string,
  expectedStage: "diagnose" | "prescribe",
  /**
   * 病历接地正文。只用于给诊断依据标注**事实来源**（第 1.1.1 条）：来源靠该正文的行结构确定，
   * 载荷本身不携带这一信息。缺省为空串——不传时三分类照常呈现，只是不带来源标注（fail-open）。
   */
  clinicalContext = "",
  /**
   * 已脱敏的病例状态。同样只用于事实来源归属：接地正文里 HIS 直传的字段是**不带标题**的裸行，
   * 光靠行结构会把既往史/用药史/生命体征一律猜成现病史（2026-08-12 线上实测）。
   * 不传时退回只读正文的旧行为（fail-open）。
   */
  caseState: unknown = null,
): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const parsed = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (parsed.schemaVersion !== "tcm-cdss-reasoning-v2" || parsed.stage !== expectedStage) return content;
    // ─── 内部工程记号的**唯一**净化点 ───────────────────────────────────────────
    // 这里是真正的渲染边界：服务端可见 Markdown（下面的 visible*FromReasoning）、客户端结构化
    // 渲染（DiagnosisClient 解析 sentinel）和 HIS 方案读的都是这一份 reasoning。因此净化必须
    // 发生在**投影之前**、且要**写回 sentinel**，三个消费者才拿到同一份干净数据；只洗 Markdown
    // 会让医生页面（走结构化渲染）继续显示 L0/L1/L3。
    //
    // 记号集合由 internal-tag-hygiene 从各内部词表推导，不是黑名单；机器取值字段（targetKind /
    // evidenceLevel / warningLevel / nodeId…）在 MACHINE_VALUED_KEYS 里显式豁免，合同校验与
    // 签名载荷不受影响（本函数在 applyDiagnose/PrescribeContractSignature 之前运行）。
    const reasoning = sanitizeReasoningNarratives(parsed);
    // ─── 页面必须渲染**最终载荷会留下的那份**，不是它的更宽松版本（2026-08-11）────────
    //
    // 投影此前读原始 JSON，而签名前的 attachClinicalReviewAttestation 用 schema 归一后的结果
    // 重写 sentinel（逐条隔离会剔掉任一非法条目）。两者之间没有任何一致性约束，于是
    // 「页面有、载荷无」成为一个完全静默的缺陷类：
    //   实测 50 例 M04 中医治疗项目——30 例页面印出三个项目，签名载荷里只有 14 例有。
    //   根因是评估态项目的 techniqueBoundary 写空串，撞上 schema 的 min(1) 被整条剔除；
    //   医生看到项目、HIS 与结构化卡片一个都收不到，且没有任何日志或原因码。
    // 修法只改**投影的输入**，不改 sentinel：sentinel 仍按既有口径原样保留（净化未改动即
    // 逐字节不动，这条由 test:stream-safety 钉着），归一只决定页面显示什么。
    // 归一失败时回落到原载荷（fail-open），不因一次 schema 抖动清空整页。
    const projected = sanitizeReasoningNarratives(normalizedReasoningForProjection(reasoning));
    const visible = expectedStage === "diagnose"
      ? visibleDiagnoseFromReasoning(projected, clinicalContext, caseState)
      : visiblePrescribeFromReasoning(projected);
    const sanitizedSentinel = JSON.stringify(reasoning) === JSON.stringify(parsed)
      ? content.slice(start)
      : `${START_MARKER}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
    return `${visible}${sanitizedSentinel}`;
  } catch {
    return content;
  }
}


// ─── Streaming-draft internal-vocabulary scrubber (P2-2) ─────────────────────
// The final structured UI renders from the signed sentinel JSON and never shows pipeline
// vocabulary. Raw model drafts in the streamed preview / truncated-draft path can still leak
// internal enum values and reason codes (把握度：bounded, lineageCode: unrestricted, the dose
// placeholder "用法与疗程待候选方药阶段核验"). This scrubber rewrites ONLY the human-visible
// markdown head; the DIAGNOSIS_JSON sentinel block the client parses stays byte-exact.

/**
 * A whole line that is just an internal field dump: a camelCase / snake_case code identifier (or a
 * known plain internal field) followed by an enum or snake_case code value. Clinical lines survive:
 * the value set never matches Chinese text, numbers, units or words like "normal", and clinical
 * abbreviations (BP, HbA1c) fail the code-identifier shape. eGFR is camel-shaped, but its value is
 * numeric/clinical prose, never an internal enum, so those lines stay.
 */
const INTERNAL_FIELD_DUMP_LINE = /^[ \t]*(?:[-*>][ \t]*)?(?:\*\*)?(?:[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+|reason|status|outcome|resolution|confidence)(?:\*\*)?[ \t]*[:：][ \t]*(?:\*\*)?(?:resolved|bounded|unresolved|unrestricted|accepted|repair|unavailable|not_run|success|preferred|cross_model_fallback|[a-z][a-z0-9]*_[a-z0-9_]+)(?:\*\*)?[ \t]*[。.]?[ \t]*$/gm;

/** Internal repair/review reason codes that must never reach a doctor-facing draft, even mid-sentence. */
const INTERNAL_EMBEDDED_CODE = /\b(?:m0[1-5]_[a-z0-9_]+|signed_limited_fallback(?:_[a-z0-9_]+)*|criteria_not_met|diagnostic_label_overstated|formula_indication_mismatch|formula_composition_mismatch|herb_plan_mismatch|dose_rationale_concern|patient_context_mismatch|tcm_reasoning_unsupported|review_unavailable|quarantine_loop|identical_guidance_fixpoint|contract_rejected|provider_error|stream_truncated)\b/g;

function scrubVisibleMarkdownHead(head: string): string {
  let text = head;
  // 1. Server sanitizer placeholders → doctor-facing phrasing (longest form first).
  text = text
    .replaceAll("用法与疗程待候选方药阶段核验", "用法与疗程以审定处方为准")
    .replaceAll("（剂量信息待候选方药阶段核验）", "（剂量以审定处方为准）")
    .replaceAll("剂量信息待候选方药阶段核验", "剂量以审定处方为准")
    .replaceAll("疗程待候选方药阶段核验", "疗程以审定处方为准");
  text = text
    .replace(/(?:程序化|确定性)?安全槽位门控|程序化安全门控|确定性门控|安全门控|红旗门控|安全门禁/g, "风险筛查规则")
    .replace(/证候锚点/g, "证候依据")
    .replace(/缺失槽位/g, "待补充信息")
    .replace(/(?:闭集)?(?:受治理|受控|服务端)?(?:中药|本地)?知识库/g, GOVERNED_HERB_DATA_LABEL)
    .replace(/受治理(?=(?:的)?(?:基准|模板|方案|数据|目录|词表|来源|条目))/g, "标准")
    .replace(/(?:闭集|受控)?(?:术语|语义)映射/g, "标准术语对照")
    .replace(/闭集受控|闭集/g, "标准")
    // 受控 is only scrubbed in front of pipeline nouns: bare 受控 is legitimate clinical Chinese
    // ("血压受控"、"病情受控") and must survive. Same reason 映射 above is anchored to 术语/语义 —
    // a bare /映射/ rule would rewrite the "证候分布与病机映射" heading that DiagnosisClient.tsx
    // still matches on when falling back to loose Markdown section extraction.
    .replace(/受控(?=(?:目录|词表|术语|候选|方案|项目|病位|病性|经典方|组成|结构|操作))/g, "标准")
    .replace(/已签名(?=(?:的)?(?:诊断|结论|证候|病机|辨证|治法|方向|处方))/g, "已确认")
    .replace(/锚点药味/g, "核心药味")
    .replace(/经典证据锚点/g, "经典条文依据")
    .replace(/锚点/g, "依据")
    .replace(/(?:语义|术语|证候|病机)召回|召回(?=(?:阶段|通道|结果|范围|逻辑|索引))/g, "检索")
    .replace(/服务端/g, "系统");
  // 2. Confidence labels are internal calibration metadata. Remove only the metadata phrase:
  // model drafts sometimes append it to a clinically useful sentence on the same line.
  text = text.replace(
    /(?:[ \t]*[；;，,][ \t]*)?\*{0,2}(?:判断)?(?:把握度|置信度)\*{0,2}[ \t]*[：:][ \t]*\*{0,2}(?:较高|较低|高|中|低|resolved|bounded|unresolved)\*{0,2}[。.]?/g,
    "",
  );
  text = text.replace(
    /(诊疗思路偏好|流派偏好)(\*{0,2}[ \t]*[:：][ \t]*\*{0,2})unrestricted(?![A-Za-z])/g,
    "$1$2未限定",
  );
  // 3. Whole-line internal field dumps are dropped outright; blank gaps are collapsed.
  text = text.replace(INTERNAL_FIELD_DUMP_LINE, "").replace(/\n{3,}/g, "\n\n");
  // 4. Remaining embedded internal reason codes degrade to a generic doctor-facing marker.
  text = text.replace(INTERNAL_EMBEDDED_CODE, (token) =>
    token.startsWith("m03_") || token.startsWith("m04_") ? "独立临床复核" : "系统内部校验");
  return sanitizeAuthoritativeClinicalOutput(text);
}

/**
 * Deterministically scrub internal pipeline vocabulary from streamed/draft visible text.
 * Idempotent and sentinel-aware: content from DIAGNOSIS_JSON_START onward is returned byte-exact,
 * so contract signatures and the client-side structured parser are unaffected.
 */
export function scrubInternalVocabularyFromVisibleText(content: string): string {
  const start = content.indexOf(START_MARKER);
  if (start < 0) return scrubVisibleMarkdownHead(content);
  return `${scrubVisibleMarkdownHead(content.slice(0, start))}${content.slice(start)}`;
}
