import { isAmbiguousM03WesternPrimaryLabel, isDisplayableClinicalText, isNondiscriminatingWesternSupportingFact, isUnstableM03CoreText, isWesternSupportingFactPolarityAligned, m03WesternClinicalRationaleIssue, m03WesternDurationIssue, narrativeFingerprint, NATURE_MECHANISM_PHRASE, patientFactSourceQuote } from "./diagnosis-stage-contract";
import { decoctionRuleForHerb, decoctionRuleSatisfied, requiredDecoctionRequirement } from "./herb-decoction-rules";
import { getTcmHerbFunctionDisplayText, isKnownTcmHerbName } from "./tcm-knowledge";
import { formulaStructureTarget, normalizeFormulaStructureRole } from "./herb-target-contract";
import { customerEvidenceDisplayStatus } from "./customer-evidence";
import { affirmedClinicalSourceClauses, affirmedClinicalText, clinicalClausePolarity } from "./clinical-polarity";
import { getM03TherapyLock } from "./m03-therapy-lock";
import { tcmTreatmentAssessmentPositioningForDisplay } from "./tcm-treatment-projects";
import { canonicalWesternDifferentialName, westernDifferentialIdentity } from "./clinical-terminology";
import { clinicalClauseText, clinicalOutputLabel, clinicalSentence, joinClinicalClauses, sanitizeAuthoritativeClinicalOutput } from "./clinical-output-authority";

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";
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
        const key = `${therapyPrint} ${targetPrint}`;
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
        .map(groundedQuote)
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
      decoction.method = `每日${dosesPerDay}剂；加冷水浸泡30分钟，武火煮沸后转文火；一煎30分钟、二煎20分钟；两煎合并药液约${finalVolume}mL；每日分${administrationTimesPerDay}次服；服药与进餐间隔按患者胃肠耐受、方剂性质及院内规范执行；特殊药味按药味表执行`;
      delete decoction.dailyDoseCount;
      decoction.soakMinutes = 30;
      decoction.decoctionTimes = 2;
      decoction.firstDecoctionMinutes = 30;
      decoction.secondDecoctionMinutes = 20;
      decoction.targetVolumeMl = finalVolume;
      decoction.administration = `每日${dosesPerDay}剂，每日分${administrationTimesPerDay}次服；服药与进餐间隔按患者胃肠耐受、方剂性质及院内规范执行`;
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

export function applyDeterministicHerbFunctions(content: string): string {
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
        const canonicalFunction = getTcmHerbFunctionDisplayText(
          name,
          markdownCell(herb.role),
          markdownCell(herb.targetPathogenesis),
        ).trim();
        if (canonicalFunction) herb.function = canonicalFunction;
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

export function applyDeterministicFormulaAnalysis(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "prescribe") return content;
    const formula = recordValue(reasoning.formula);
    const roleOrder = ["君", "臣", "佐", "使"];
    const roleLogic: Record<string, string> = {
      君: "直治核心病机，构成本方主要治疗支点",
      臣: "协同君药并加强相关病机的处理",
      佐: "兼顾次要病机、配伍制约或中焦耐受",
      使: "协调方中药性并使各治疗方向相互衔接",
    };
    for (const candidate of recordList(formula?.candidates)) {
      const herbs = recordList(candidate.herbs);
      const roleLines = roleOrder.flatMap((role) => {
        const members = herbs.filter((herb) => markdownCell(herb.role) === role);
        if (!members.length) return [];
        const names = members.map((herb) => {
          const name = markdownCell(herb.name);
          const herbFunction = markdownCell(herb.function).replace(/[；;。]+$/g, "");
          return name && herbFunction ? `${name}（${herbFunction}）` : name;
        }).filter(Boolean).join("、");
        const targets = [...new Set(members
          .map((herb) => markdownCell(herb.targetPathogenesis).replace(/[；;。]+$/g, ""))
          .filter(Boolean))].join("；");
        return [`${role}药以${names}为组，${targets ? `对应${targets}，` : ""}${roleLogic[role]}。`];
      });
      const therapyMatch = markdownCell(candidate.therapyMatch);
      candidate.formulaAnalysis = [
        `本候选方共${herbs.length}味${therapyMatch ? `，围绕“${therapyMatch}”展开组方` : "，按已锁定病机与治法展开组方"}。`,
        ...roleLines,
        "各药组共同形成从核心病机到兼夹与配伍调和的治疗层次；药味增删改后，方义将按当前完整处方重新计算。",
      ].join("");
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
      westernPrimary.supportingFacts = boundedClinicalFacts(uniqueClinicalFacts([
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
        // Preserve a model-authored differential reason when it contains an exact chart quote.
        // Only an ungrounded reason is replaced with a bounded neutral explanation; deterministic
        // normalization must not erase a clinically useful distinction that already passed grounding.
        const sourceQuote = typeof item.reason === "string"
          ? exactClinicalSourceQuotes(item.reason, clinicalContext)[0]
          : undefined;
        return [{
          ...item,
          reason: sourceQuote
            ? item.reason
            : "当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。",
        }];
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
  established: RegExp;
  criteria: (affirmedClinicalContext: string) => boolean;
};

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
    established: /(?:既往史|既往确诊|既往诊断|已确诊|明确诊断|曾诊断为)[^。；\n]{0,30}慢性支气管炎/,
    criteria: (context) => /(?:(?:每年|年均)[^。；\n]{0,24}(?:3|三)(?:个)?月[^。；\n]{0,32}(?:连续|至少)[^。；\n]{0,12}(?:2|两|二)年|(?:连续|至少)[^。；\n]{0,12}(?:2|两|二)年[^。；\n]{0,32}(?:每年|年均)[^。；\n]{0,24}(?:3|三)(?:个)?月)/.test(context),
  },
  {
    label: /(?:慢性阻塞性肺疾病|慢阻肺|\bCOPD\b)/i,
    established: /(?:既往史|既往确诊|既往诊断|已确诊|明确诊断|曾诊断为)[^。；\n]{0,30}(?:慢性阻塞性肺疾病|慢阻肺|COPD)/i,
    criteria: (context) => /(?:(?:FEV1\s*\/\s*FVC|一秒率)[^。；\n]{0,20}(?:<|＜|低于)\s*(?:0?\.7|70\s*%)|肺功能[^。；\n]{0,40}(?:持续气流受限|阻塞性通气功能障碍|支持慢阻肺|符合慢阻肺))/i.test(context),
  },
  {
    label: /(?:阻塞性睡眠呼吸暂停(?:低通气)?(?:综合征)?|\bOSA(?:HS)?\b)/i,
    established: /(?:既往史|既往(?:患有|有)?|既往确诊|既往诊断|已确诊|明确诊断|曾诊断为)[^。；\n]{0,40}(?:阻塞性睡眠呼吸暂停(?:低通气)?(?:综合征)?|OSA(?:HS)?)/i,
    criteria: hasOsaObjectiveEvidence,
  },
  {
    label: /(?:支气管)?哮喘/,
    established: /(?:既往史|既往(?:患有|有)?|既往确诊|既往诊断|已确诊|明确诊断|曾诊断为)[^。；\n]{0,40}(?:支气管)?哮喘/,
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
    const guard = FORMAL_WESTERN_CRITERIA_GUARDS.find((item) => item.label.test(name));
    if (!guard) return content;
    // Only affirmed clauses may satisfy a formal disease criterion. This prevents text such as
    // “否认既往确诊哮喘” or “未见舒张试验阳性” from preserving an unsupported label.
    const affirmedContext = affirmedClinicalText(clinicalContext) || "";
    if (guard.established.test(affirmedContext) || guard.criteria(affirmedContext)) return content;
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
      .replace(/^(?:基层接诊初始记录|本轮追问补充|问诊补充|四诊补充|症状补充|病情经过)[：:]\s*/, "")
      .trim())
    .filter(Boolean)
    .join("；");
}

function uniqueClinicalFacts(values: string[]): string[] {
  const result: Array<{ key: string; value: string }> = [];
  for (const value of values) {
    const key = value.normalize("NFKC").replace(/[\s，,。；;：:、()（）【】\[\]]+/g, "");
    if (!key || result.some((item) => item.key === key || item.key.includes(key))) continue;
    // Prefer the complete exact chart sentence when an earlier item is only a substring. This
    // removes redundant provider-split fragments without merging two source clauses or changing
    // their polarity.
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (key.includes(result[index].key)) result.splice(index, 1);
    }
    result.push({ key, value });
  }
  return result.map((item) => item.value);
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

function symptomLevelWesternName(fact: string | undefined, fallback: string): string {
  if (!fact) return fallback;
  const governedSymptomLabels: ReadonlyArray<{ pattern: RegExp; label: string }> = [
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
  const governed = governedSymptomLabels.find((item) => item.pattern.test(fact));
  if (governed) return governed.label;
  return fallback;
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
    const symptomLevelWorkingLabel = /(?:症状|不适|咳嗽|咳痰|喘息|喘鸣|气短|气促|呼吸困难|反酸|烧心|腹泻|便秘|腹胀|腹痛|头痛|头晕|眩晕|心悸|失眠|睡眠障碍|颈部疼痛|膝关节疼痛|乏力)(?:待查|待明确|待鉴别)?$/;
    if (!isAmbiguousM03WesternPrimaryLabel(normalized) && symptomLevelWorkingLabel.test(normalized)) {
      const fallback = chiefComplaintFallbackDiagnosis(clinicalContext);
      normalized = symptomLevelWesternName(fallback.fact, normalized);
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

function markdownCell(value: unknown): string {
  return typeof value === "string" ? value.replace(/[|\r\n]+/g, " ").trim() : "";
}

function canonicalHerbTable(candidate: Record<string, unknown>): string {
  const herbs = Array.isArray(candidate.herbs) ? candidate.herbs : [];
  if (herbs.length === 0) return "";
  const rows = herbs.map((rawHerb, index) => {
    const herb = rawHerb && typeof rawHerb === "object" && !Array.isArray(rawHerb)
      ? rawHerb as Record<string, unknown>
      : {};
    const processing = joinClinicalClauses([markdownCell(herb.processing), markdownCell(herb.decoctionRequirement)], "；") || "饮片";
    return `| ${index + 1} | ${markdownCell(herb.name)} | ${processing} | ${markdownCell(herb.dose)} | ${markdownCell(herb.role)} | ${markdownCell(herb.prescriptionRole)} | ${markdownCell(herb.targetPathogenesis)} | ${markdownCell(herb.function)} |`;
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

function visibleDiagnoseFromReasoning(reasoning: Record<string, unknown>): string {
  const overview = recordValue(reasoning.overview);
  const westernDiagnosis = recordValue(reasoning.westernDiagnosis);
  const westernPrimary = recordValue(westernDiagnosis?.primary);
  const westernDifferentials = recordList(westernDiagnosis?.differentials);
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
  const westernHeading = `## ${clinicalOutputLabel("M03-western", "西医诊断倾向与鉴别")}`;
  const overviewHeading = `## ${clinicalOutputLabel("M03-overview", "中医诊断概览")}`;
  const pathogenesisHeading = `## ${clinicalOutputLabel("M03-pathogenesis", "病机拆解")}`;
  const therapyHeading = `## ${clinicalOutputLabel("M03-therapy", "治则治法")}`;
  const lines = [
    "# 中医辅助诊疗报告",
    "",
    westernHeading,
    `**诊断倾向**：${markdownCell(westernPrimary?.name)}`,
  ];
  const westernFacts = Array.isArray(westernPrimary?.supportingFacts) ? westernPrimary.supportingFacts.map(markdownCell).filter(Boolean) : [];
  const westernLimitations = Array.isArray(westernPrimary?.limitations) ? westernPrimary.limitations.map(markdownCell).filter(Boolean) : [];
  const westernChecks = Array.isArray(westernPrimary?.suggestedChecks) ? westernPrimary.suggestedChecks.map(markdownCell).filter(Boolean) : [];
  if (westernFacts.length > 0) lines.push(`**支持依据**：${joinClinicalClauses(westernFacts, "；")}`);
  if (isDisplayableClinicalText(markdownCell(westernPrimary?.clinicalRationale))) {
    lines.push(`**临床分析**：${markdownCell(westernPrimary?.clinicalRationale)}`);
  }
  if (westernLimitations.length > 0) lines.push(`**限制与反证**：${joinClinicalClauses(westernLimitations, "；")}`);
  if (westernChecks.length > 0) lines.push(`**建议检查**：${joinClinicalClauses(westernChecks, "；")}`);
  const westernEvidence = recordValue(westernPrimary?.evidence);
  if (customerEvidenceDisplayStatus(westernEvidence) === "traceable") {
    const references = markdownCell(westernEvidence?.source).split(/\n+|；(?=\s*(?:\[[A-Z]|《|https?:\/\/))/).map((item) => item.trim()).filter(Boolean);
    if (references.length > 0) lines.push("", "### 参考文献", ...references.map((item, index) => `${index + 1}. ${item}`));
  }
  if (westernDifferentials.length > 0) {
    lines.push(
      "",
      "### 鉴别方向",
      ...westernDifferentials.map((item) => `- **${markdownCell(item.name)}**：${clinicalSentence([
        markdownCell(item.reason),
        markdownCell(item.distinguishingPoints) ? `区分要点：${markdownCell(item.distinguishingPoints)}` : "",
        markdownCell(item.nextCheck) ? `建议核实：${markdownCell(item.nextCheck)}` : "",
      ], "；")}`),
    );
  }
  lines.push(
    "",
    overviewHeading,
    ...(isDisplayableClinicalText(markdownCell(overview?.tcmDiseaseName)) ? [`**中医病名**：${markdownCell(overview?.tcmDiseaseName)}`] : []),
    `**证型**：${markdownCell(overview?.primarySyndrome)}`,
    "",
    pathogenesisHeading,
    `**总体病机**：${markdownCell(overview?.overallPathogenesis)}`,
  );
  if (isDisplayableClinicalText(markdownCell(overview?.tcmDiagnosticRationale))) {
    lines.splice(lines.indexOf(pathogenesisHeading), 0, `**辨证分析**：${markdownCell(overview?.tcmDiagnosticRationale)}`, "");
  }
  const tcmDifferentials = recordList(overview?.tcmDifferentials);
  if (tcmDifferentials.length > 0) {
    const insertAt = lines.indexOf(pathogenesisHeading);
    lines.splice(insertAt, 0,
      "### 中医鉴别",
      ...tcmDifferentials.map((item) => `- **${markdownCell(item.syndrome)}**：${clinicalSentence([
        markdownCell(item.reason),
        markdownCell(item.distinguishingPoints) ? `区分要点：${markdownCell(item.distinguishingPoints)}` : "",
        markdownCell(item.nextCheck) ? `建议核实：${markdownCell(item.nextCheck)}` : "",
      ], "；")}`),
      "",
    );
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
      `**病机联系**：${markdownCell(caseRelationship.relationship)}`,
    );
  }
  if (chain.length > 0) {
    lines.push(
      "",
      "### 子病机与治法",
      "| 患者事实 | 证候依据 | 子病机 | 对应治法 |",
      "|---|---|---|---|",
      ...chain.map((node) => `| ${markdownCell(node.patientFact)} | ${markdownCell(node.syndromeEvidence)} | ${markdownCell(node.pathogenesis)} | ${markdownCell(node.therapyDirection)} |`),
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
      ...subTherapies.map((item) => `| ${markdownCell(item.therapy)} | ${markdownCell(item.targetPathogenesis)} |`),
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
    lines.push(
      "",
      `## ${markdownCell(candidate.name)}`,
      ...(candidate.identityDeclassified === true ? [
        "**处方身份说明**：实际组成未沿用原命名经方身份，不代表原方或经典出处；请按当前完整药味与剂量重新审方。",
      ] : []),
      ...(customerEvidenceDisplayStatus(formulaSource) === "traceable" ? [`**方剂出处**：${markdownCell(formulaSource?.source)}`] : []),
      "",
      "### 药味清单",
      canonicalHerbTable(candidate),
      "",
      "### 方义分析",
      markdownCell(candidate.formulaAnalysis),
    );
    if (compositionLogic.length > 0) {
      lines.push(
        "",
        "### 组成逻辑",
        ...compositionLogic.map((item) =>
          `- **${markdownCell(item.formulaName)}**：${markdownCell(item.summary)}（${markdownCell(item.tier)}）`),
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
        ...classicEvidence.map((item) =>
          `- ${markdownCell(item.citation)}（${markdownCell(item.anchorLevel)}${markdownCell(item.clauseNumber) ? ` ${markdownCell(item.clauseNumber)}` : ""}；${markdownCell(item.tier)}）`),
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
      lines.push(
        "",
        "### 剂数与煎服",
        `**剂数**：${markdownCell(decoction.doseCount)}`,
        `**每日剂数 / 分服次数**：每日 ${markdownCell(decoction.dosesPerDay)} 剂 / 每日分 ${markdownCell(decoction.administrationTimesPerDay)} 次服`,
        `**煎服法**：${markdownCell(decoction.method)}`,
        `**疗程建议**：${joinClinicalClauses([markdownCell(decoction.course), markdownCell(decoction.followUpNode)], "；首次复诊：")}`,
      );
    }
  }
  if (modifications.length > 0) {
    lines.push("", "## 本次随症加减", ...modifications.map((item) => {
      const triggerSource = recordValue(item.triggerSource);
      const sourceQuote = markdownCell(triggerSource?.sourceQuote);
      return `- **${markdownCell(item.trigger)}**：${clinicalSentence([
        markdownCell(item.action),
        markdownCell(item.targetPathogenesis) ? `对应病机：${markdownCell(item.targetPathogenesis)}` : "",
        markdownCell(item.reason),
        sourceQuote ? `触发依据：${sourceQuote}` : "",
      ], "；")}`;
    }));
  }
  const modificationReview = recordValue(formula?.modificationReview);
  const droppedCount = typeof modificationReview?.droppedCount === "number" ? modificationReview.droppedCount : 0;
  if (droppedCount > 0) {
    lines.push(
      "",
      "## 加减建议核查说明",
      `另有 ${droppedCount} 条加减建议未展示：${markdownCell(modificationReview?.droppedReason) || "未满足当前事实、病机引用或药味安全条件"}。`,
    );
  }
  if (patentAndWestern.length > 0) {
    lines.push(
      "",
      `## ${clinicalOutputLabel("M04-patent-western", "中成药/西药候选")}`,
      "| 类型 | 药品 | 规格 | 建议层级 | 用药定位 | 对应问题 | 参考文献 | 联用/替代关系 | 风险提示 |",
      "|---|---|---|---|---|---|---|---|---|",
      ...patentAndWestern.map((item) => {
        const itemEvidence = recordValue(item.evidence);
        const level = item.recommendationMode === "discussion_only" ? "仅供讨论（无剂量）" : "说明书绑定候选（无剂量）";
        return `| ${markdownCell(item.type)} | ${markdownCell(item.name)} | ${markdownCell(item.specification) || "—"} | ${level} | ${markdownCell(item.positioning)} | ${markdownCell(item.correspondingProblem)} | ${markdownCell(itemEvidence?.source)} | ${markdownCell(item.relationship)} | ${markdownCell(item.riskNote)} |`;
      }),
    );
  } else if (medicineCandidateStatus?.status === "no_evidence_match" && isDisplayableClinicalText(markdownCell(medicineCandidateStatus.reason))) {
    lines.push("", `## ${clinicalOutputLabel("M04-patent-western", "中成药/西药候选")}`, markdownCell(medicineCandidateStatus.reason));
  }
  if (nonPharma) {
    lines.push("", `## ${clinicalOutputLabel("M03-M04-nonpharma", "非药物调护与中医项目")}`);
    for (const [label, key] of [["饮食", "diet"], ["起居", "lifestyle"], ["情志", "emotion"], ["穴位保健", "acupointCare"]] as const) {
      if (isDisplayableClinicalText(markdownCell(nonPharma[key]))) lines.push(`- **${label}**：${markdownCell(nonPharma[key])}`);
    }
    const treatmentProjects = recordList(nonPharma.tcmTreatments);
    if (treatmentProjects.length > 0) {
      lines.push("", "### 中医治疗项目");
      for (const item of treatmentProjects) {
        const availability = item.availability === "clinic_available" ? "本机构可开展" : "转介评估";
        const requiredChecks = Array.isArray(item.requiredChecks)
          ? item.requiredChecks.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map(markdownCell)
          : [];
        const materialPositioning = tcmTreatmentAssessmentPositioningForDisplay(item.assessmentPositioning);
        const sites = Array.isArray(item.suggestedSitesOrPoints)
          ? joinClinicalClauses(item.suggestedSitesOrPoints.map(markdownCell), "；")
          : "";
        const hasPatientSpecificProtocol = item.protocolStatus === "governed_patient_specific_plan";
        lines.push(
          `#### ${markdownCell(item.projectName)} · ${availability}`,
          `- **方案状态**：${hasPatientSpecificProtocol ? "已有对应适应证的标准操作方案，仍须医生复核" : "仅作项目评估，未形成患者级操作方案"}`,
          `- **治疗内容**：${markdownCell(item.treatmentContent)}`,
          `- **对应病机**：${markdownCell(item.targetPathogenesis)}`,
          ...(sites ? [`- **建议部位/候选穴位**：${sites}`] : []),
          ...(markdownCell(item.scheduleSuggestion) ? [`- **评估节奏**：${markdownCell(item.scheduleSuggestion)}`] : []),
          ...(markdownCell(item.protocolGap) ? [`- **未形成方案的原因**：${markdownCell(item.protocolGap)}`] : []),
          `- **安全边界**：${clinicalSentence([markdownCell(item.techniqueBoundary), markdownCell(materialPositioning), markdownCell(item.operatorRequirement), ...requiredChecks], "；")}`,
          `- **方案依据**：${markdownCell(item.protocolSource)}`,
        );
      }
    }
    const monitoring = recordList(nonPharma.monitoring);
    if (monitoring.length > 0) {
      lines.push("", "### 监测指标", "| 指标 | 时间 | 复诊触发 |", "|---|---|---|", ...monitoring.map((item) => `| ${markdownCell(item.metric)} | ${markdownCell(item.timing)} | ${markdownCell(item.trigger)} |`));
    }
  }
  return `${lines.filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n").trim()}\n\n`;
}

export function synchronizeVisibleClinicalSummary(
  content: string,
  expectedStage: "diagnose" | "prescribe",
): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.schemaVersion !== "tcm-cdss-reasoning-v2" || reasoning.stage !== expectedStage) return content;
    const visible = expectedStage === "diagnose"
      ? visibleDiagnoseFromReasoning(reasoning)
      : visiblePrescribeFromReasoning(reasoning);
    return `${visible}${content.slice(start)}`;
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
    .replace(/(?:闭集)?(?:受控|服务端)(?:中药)?知识库/g, "中药知识库")
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
