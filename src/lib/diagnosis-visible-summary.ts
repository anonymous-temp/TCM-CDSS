import { isDisplayableClinicalText, isNondiscriminatingWesternSupportingFact, isUnstableM03CoreText, isWesternSupportingFactPolarityAligned, patientFactSourceQuote } from "./diagnosis-stage-contract";
import { decoctionRuleForHerb, decoctionRuleSatisfied, requiredDecoctionRequirement } from "./herb-decoction-rules";
import { getTcmHerbFunctionDisplayText, isKnownTcmHerbName } from "./tcm-knowledge";
import { formulaStructureTarget, normalizeFormulaStructureRole } from "./herb-target-contract";
import { customerEvidenceDisplayStatus } from "./customer-evidence";
import { affirmedClinicalText, clinicalClausePolarity } from "./clinical-polarity";
import { getM03TherapyLock } from "./m03-therapy-lock";
import { tcmTreatmentAssessmentPositioningForDisplay } from "./tcm-treatment-projects";

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";
type ClinicalResolutionValue = "resolved" | "bounded" | "unresolved";

function semanticItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []))];
}

function resolutionValue(value: unknown): ClinicalResolutionValue | undefined {
  return value === "resolved" || value === "bounded" || value === "unresolved" ? value : undefined;
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
      return patientFactSourceQuote(value, clinicalContext) || "";
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
        overview.primarySyndromeResolutionReason = typeof overview.primarySyndromeResolutionReason === "string" && overview.primarySyndromeResolutionReason.trim()
          ? overview.primarySyndromeResolutionReason.trim()
          : finalResolution === "bounded"
            ? "当前证候为有限资料下的工作判断，需结合后续四诊复核"
            : "当前资料不足以形成有意义的证候工作判断";
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
        location.resolutionReason = typeof location.resolutionReason === "string" && location.resolutionReason.trim()
          ? location.resolutionReason.trim()
          : finalResolution === "bounded" ? "病位为有限资料下的工作归纳" : "当前资料不足以定位病位";
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
        nature.resolutionReason = typeof nature.resolutionReason === "string" && nature.resolutionReason.trim()
          ? nature.resolutionReason.trim()
          : finalResolution === "bounded" ? "病性为有限资料下的工作归纳" : "当前资料不足以归纳病性";
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
    const method = `每日1剂；加冷水浸泡30分钟，武火煮沸后转文火；一煎30分钟、二煎20分钟；两煎合并药液约${finalVolume}mL；早晚分服；服药与进餐间隔按患者胃肠耐受、方剂性质及院内规范执行；特殊药味按药味表执行`;
    for (const rawCandidate of candidates) {
      if (!rawCandidate || typeof rawCandidate !== "object" || Array.isArray(rawCandidate)) continue;
      const candidate = rawCandidate as Record<string, unknown>;
      if (!candidate.decoction || typeof candidate.decoction !== "object" || Array.isArray(candidate.decoction)) continue;
      const decoction = candidate.decoction as Record<string, unknown>;
      decoction.method = method;
      decoction.dailyDoseCount = 1;
      decoction.soakMinutes = 30;
      decoction.decoctionTimes = 2;
      decoction.firstDecoctionMinutes = 30;
      decoction.secondDecoctionMinutes = 20;
      decoction.targetVolumeMl = finalVolume;
      decoction.administration = "早晚分服；服药与进餐间隔按患者胃肠耐受、方剂性质及院内规范执行";
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
      const course = typeof decoction.course === "string" ? decoction.course.trim() : "";
      const doseMatch = doseCount.match(/^(\d{1,2})\s*剂$/);
      const courseMatch = course.match(/^(\d{1,2})\s*(日|天|周)$/);
      if (doseMatch) {
        decoction.followUpNode = `完成${doseCount.replace(/\s/g, "")}后复诊；出现不适或症状加重时提前复诊`;
        decoction.followUpAfterDoses = Number(doseMatch[1]);
        if (courseMatch) decoction.followUpAfterDays = Number(courseMatch[1]) * (courseMatch[2] === "周" ? 7 : 1);
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
        const quote = stripClinicalTransportPrefix(patientFactSourceQuote(fact, clinicalContext) || "");
        return quote &&
          !looksLikeSerializedClinicalState(quote) &&
          !isNondiscriminatingWesternSupportingFact(quote) &&
          clinicalClausePolarity(quote) === "affirmed"
          ? [quote]
          : [];
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
      ])
        .filter((fact) => !isNondiscriminatingWesternSupportingFact(fact))
        .filter((fact) => isWesternSupportingFactPolarityAligned(fact, clinicalContext)));
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
      western.differentials = western.differentials.flatMap((raw) => {
        const item = recordValue(raw);
        if (!item || typeof item.name !== "string" || !item.name.trim()) return [];
        const sourceQuote = typeof item.reason === "string" ? patientFactSourceQuote(item.reason, clinicalContext) : undefined;
        return [{
          ...item,
          reason: sourceQuote
            ? `${sourceQuote}；该方向需结合临床表现及相关检查继续鉴别。`
            : "当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。",
        }];
      });
    }
    const groundedChain = pathogenesis.chain.flatMap((rawNode) => {
      if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) return [];
      const node = rawNode as Record<string, unknown>;
      if (typeof node.patientFact !== "string") return [];
      if (isUnstableM03CoreText(node.pathogenesis) || isUnstableM03CoreText(node.therapyDirection)) return [];
      if (!clinicalContext) return [node];
      const sourceQuote = stripClinicalTransportPrefix(
        patientFactSourceQuote(node.patientFact, clinicalContext) ||
        (typeof node.syndromeEvidence === "string" ? patientFactSourceQuote(node.syndromeEvidence, clinicalContext) : undefined) ||
        "",
      );
      // syndromeEvidence is an evidence field, not a second place for the model to add textbook
      // symptoms. Reusing the verified source quote preserves the model's pathogenesis/therapy while
      // preventing one unsupported typical symptom from rejecting the entire M03 result.
      return sourceQuote ? [{ ...node, patientFact: sourceQuote, syndromeEvidence: sourceQuote }] : [];
    });
    // A repair model can produce a clinically reviewable neutral mechanism while paraphrasing its
    // patientFact so heavily that literal grounding drops every node. In that one bounded case,
    // rebind only the first structurally complete mechanism to the already verified chief-complaint
    // source quote. This does not approve the mechanism: the full deterministic contract and the
    // independent M03 reviewer still run after this transform and reject a semantic mismatch.
    if (groundedChain.length === 0 && clinicalContext && fallback.fact) {
      const fallbackSource = stripClinicalTransportPrefix(patientFactSourceQuote(fallback.fact, clinicalContext) || "");
      const repairableNode = pathogenesis.chain.find((rawNode) => {
        const node = recordValue(rawNode);
        return node &&
          !isUnstableM03CoreText(node.pathogenesis) &&
          !isUnstableM03CoreText(node.therapyDirection) &&
          isNeutralFunctionalM03Core(node.pathogenesis) &&
          isNeutralFunctionalM03Core(node.therapyDirection);
      });
      if (
        fallbackSource &&
        repairableNode &&
        !isNondiscriminatingWesternSupportingFact(fallbackSource) &&
        isWesternSupportingFactPolarityAligned(fallbackSource, clinicalContext)
      ) {
        groundedChain.push({
          ...repairableNode,
          patientFact: fallbackSource,
          syndromeEvidence: fallbackSource,
        });
      }
    }
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
    const symptomName = symptomCore === "症状性诊断，病因待临床鉴别"
      ? symptomCore
      : `${symptomCore.replace(/症状$/, "")}症状`;
    if (!fallback.fact || symptomName.length < 2 || symptomName.length > 600) return content;

    const previousName = markdownCell(primary.name);
    const suggestedChecks = semanticItems(primary.suggestedChecks);
    const differentials = recordList(western.differentials).map((item) => ({ ...item }));
    if (previousName && previousName !== symptomName && !differentials.some((item) => markdownCell(item.name) === previousName)) {
      differentials.unshift({
        name: previousName,
        reason: "独立临床复核认为现有病程或必备条件尚不足，暂列鉴别诊断",
        nextCheck: suggestedChecks[0] || "结合病程演变、查体及必要检查复核诊断标准",
      });
    }
    western.differentials = differentials.slice(0, 8);
    primary.name = symptomName;
    primary.status = "证据有限";
    primary.confidence = "低";
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
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.normalize("NFKC").replace(/[\s，,。；;：:、()（）【】\[\]]+/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const SPECIFIC_TCM_REBIND_CONCEPT = /(?:阴虚|阳虚|气虚|血虚|气滞|血瘀|津亏|痰|湿|瘀|火|寒|热|脾|胃|肝|心|肺|肾|胆|三焦|营卫|经络|心神|清热|温阳|滋阴|补气|益气|养血|活血|化瘀|化痰|祛湿|泻火|疏肝|健脾|补肾)/;

function isNeutralFunctionalM03Core(value: unknown): boolean {
  return typeof value === "string" &&
    /(?:功能|调节|节律|状态)/.test(value) &&
    !SPECIFIC_TCM_REBIND_CONCEPT.test(value);
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
    .replace(/^(?:患者|反复|近来|近期|近)/, "")
    .replace(/(?:约|已)?\d+(?:\.\d+)?\s*(?:分钟|小时|天|日|周|个月|月|年)(?:余|左右)?/g, "")
    .replace(/(?:半|一|二|两|三|四|五|六|七|八|九|十)+\s*(?:天|日|周|个月|月|年)(?:余|左右)?/g, "")
    .replace(/要求.*$/, "")
    .trim();
  return {
    name: core.length >= 2 && core.length <= 40 ? `${core}（病因待鉴别）` : "症状性诊断，病因待临床鉴别",
    fact,
  };
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
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const source = stripClinicalTransportPrefix(value);
    if (source.length < 4 || source.length > 500 || /^(?:无|不详|未知|未提供|未记录|待补充)$/.test(source)) return;
    const affirmed = affirmedClinicalText(source);
    if (!affirmed) return;
    // Keep one authoritative HIS field as one grounded fact. Splitting it and then capping the
    // fragments used to discard branch-changing facts merely because they appeared late in the
    // same field (for example, bowel changes after several earlier symptom clauses).
    if (!isNondiscriminatingWesternSupportingFact(affirmed) && !facts.includes(affirmed)) facts.push(affirmed);
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
    if (labeled) add(labeled);
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
 * Kept as a pipeline boundary for compatibility. Clinical labels are no longer rewritten from
 * punctuation or keyword heuristics; malformed or unsupported decisions are repaired by the
 * independent clinical reviewer, while uncertainty is represented by the signed resolution fields.
 */
export function normalizeDiagnoseConfidenceAndLabels(content: string, clinicalContext: string): string {
  void clinicalContext;
  return content;
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
    const processing = [markdownCell(herb.processing), markdownCell(herb.decoctionRequirement)].filter(Boolean).join("；") || "饮片";
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
  const lines = [
    "# 中医辅助诊疗报告",
    "",
    "## 西医诊断",
    `**诊断倾向**：${markdownCell(westernPrimary?.name)}`,
    `**判断状态**：${markdownCell(westernPrimary?.status)}；置信度：${markdownCell(westernPrimary?.confidence)}`,
  ];
  const westernFacts = Array.isArray(westernPrimary?.supportingFacts) ? westernPrimary.supportingFacts.map(markdownCell).filter(Boolean) : [];
  const westernLimitations = Array.isArray(westernPrimary?.limitations) ? westernPrimary.limitations.map(markdownCell).filter(Boolean) : [];
  const westernChecks = Array.isArray(westernPrimary?.suggestedChecks) ? westernPrimary.suggestedChecks.map(markdownCell).filter(Boolean) : [];
  if (westernFacts.length > 0) lines.push(`**支持依据**：${westernFacts.join("；")}`);
  if (westernLimitations.length > 0) lines.push(`**限制与反证**：${westernLimitations.join("；")}`);
  if (westernChecks.length > 0) lines.push(`**建议检查**：${westernChecks.join("；")}`);
  const westernEvidence = recordValue(westernPrimary?.evidence);
  if (customerEvidenceDisplayStatus(westernEvidence) === "traceable") {
    const references = markdownCell(westernEvidence?.source).split(/\n+|；(?=\s*(?:\[[A-Z]|《|https?:\/\/))/).map((item) => item.trim()).filter(Boolean);
    if (references.length > 0) lines.push("", "### 参考文献", ...references.map((item, index) => `${index + 1}. ${item}`));
  }
  if (westernDifferentials.length > 0) {
    lines.push(
      "",
      "### 鉴别方向",
      ...westernDifferentials.map((item) => `- **${markdownCell(item.name)}**：${markdownCell(item.reason)}${markdownCell(item.nextCheck) ? `；建议：${markdownCell(item.nextCheck)}` : ""}`),
    );
  }
  lines.push(
    "",
    "## 中医诊断",
    ...(isDisplayableClinicalText(markdownCell(overview?.tcmDiseaseName)) ? [`**中医病名**：${markdownCell(overview?.tcmDiseaseName)}`] : []),
    `**证型**：${markdownCell(overview?.primarySyndrome)}`,
    "",
    "## 病机分析",
    `**总体病机**：${markdownCell(overview?.overallPathogenesis)}`,
  );
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
  if (locationItems.length > 0) lines.push(`**病位辨证**：${locationItems.join("、")}`);
  const locationDetails = recordList(locationDifferentiation?.details);
  if (locationDetails.length > 0) {
    lines.push(...locationDetails.map((item) => `- **${markdownCell(item.location)}**：${markdownCell(item.basis)}`));
  }
  if (natureItems.length > 0) lines.push(`**病性辨证**：${natureItems.join("、")}`);
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
    "## 治则治法",
    `**治则**：${markdownCell(therapy?.overallPrinciple)}`,
    `**总治法**：${markdownCell(therapy?.overallMethod) || markdownCell(overview?.overallTherapy)}`,
  );
  if (subTherapies.length > 0) {
    lines.push(
      "",
      "| 分治治法 | 对应病机 | 优先级 |",
      "|---|---|---|",
      ...subTherapies.map((item) => `| ${markdownCell(item.therapy)} | ${markdownCell(item.targetPathogenesis)} | ${markdownCell(item.priority)} |`),
    );
  }
  if (uncertainties.length > 0) {
    lines.push(
      "",
      "## 需复核的不确定项",
      ...uncertainties.map((item) => `- **${markdownCell(item.item)}**：${markdownCell(item.reason)}；影响：${markdownCell(item.affects)}`),
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
  const patentAndWestern = recordList(formula?.patentAndWestern).filter((item) => {
    const evidence = recordValue(item.evidence);
    return [item.name, item.specification, item.singleDose, item.frequency, item.route, item.course]
      .every((value) => isDisplayableClinicalText(markdownCell(value)) && !/(?:按说明书|医生复核|医生评估|待确认|待核验|待检索|结合病情|另行确定)/.test(markdownCell(value))) &&
      customerEvidenceDisplayStatus(evidence) === "traceable";
  });
  const modifications = recordList(formula?.modifications).filter((item) =>
    [item.trigger, item.action, item.targetPathogenesis, item.reason]
      .every((value) => isDisplayableClinicalText(markdownCell(value)))
  );
  const nonPharma = recordValue(reasoning.nonPharma);
  const lines = [
    "# 候选方药",
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
    if (decoction) {
      lines.push(
        "",
        "### 剂数与煎服",
        `**剂数**：${markdownCell(decoction.doseCount)}`,
        `**煎服法**：${markdownCell(decoction.method)}`,
        `**疗程建议**：${[markdownCell(decoction.course), markdownCell(decoction.followUpNode)].filter(Boolean).join("；首次复诊：")}`,
      );
    }
  }
  if (modifications.length > 0) {
    lines.push("", "## 随症加减", ...modifications.map((item) => `- **${markdownCell(item.trigger)}**：${markdownCell(item.action)}；对应病机：${markdownCell(item.targetPathogenesis)}；${markdownCell(item.reason)}`));
  }
  if (patentAndWestern.length > 0) {
    lines.push(
      "",
      "## 西药/中成药方案",
      "| 类型 | 药品 | 规格 | 单次剂量 | 频次 | 途径 | 疗程 | 用药定位 | 对应问题 | 参考文献 | 联用/替代关系 | 风险提示 |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|",
      ...patentAndWestern.map((item) => {
        const itemEvidence = recordValue(item.evidence);
        return `| ${markdownCell(item.type)} | ${markdownCell(item.name)} | ${markdownCell(item.specification)} | ${markdownCell(item.singleDose)} | ${markdownCell(item.frequency)} | ${markdownCell(item.route)} | ${markdownCell(item.course)} | ${markdownCell(item.positioning)} | ${markdownCell(item.correspondingProblem)} | ${markdownCell(itemEvidence?.source)} | ${markdownCell(item.relationship)} | ${markdownCell(item.riskNote)} |`;
      }),
    );
  }
  if (nonPharma) {
    lines.push("", "## 非药物干预建议");
    for (const [label, key] of [["饮食", "diet"], ["起居", "lifestyle"], ["情志", "emotion"], ["穴位保健", "acupointCare"]] as const) {
      if (isDisplayableClinicalText(markdownCell(nonPharma[key]))) lines.push(`- **${label}**：${markdownCell(nonPharma[key])}`);
    }
    const treatmentProjects = recordList(nonPharma.tcmTreatments);
    if (treatmentProjects.length > 0) {
      lines.push(
        "",
        "### 中医治疗项目",
        "| 项目 | 机构适配 | 对应病机 | 实施与安全边界 |",
        "|---|---|---|---|",
        ...treatmentProjects.map((item) => {
          const availability = item.availability === "clinic_available" ? "本机构可开展" : "转介评估";
          const requiredChecks = Array.isArray(item.requiredChecks)
            ? item.requiredChecks.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map(markdownCell)
            : [];
          const materialPositioning = tcmTreatmentAssessmentPositioningForDisplay(item.assessmentPositioning);
          return `| ${markdownCell(item.projectName)} | ${availability} | ${markdownCell(item.targetPathogenesis)} | ${[markdownCell(materialPositioning), markdownCell(item.operatorRequirement), ...requiredChecks].filter(Boolean).join("；")} |`;
        }),
      );
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

/** Internal confidence/resolution enums → doctor-facing Chinese after an explicit Chinese label. */
const VISIBLE_CONFIDENCE_ENUM: Record<string, string> = {
  resolved: "较高",
  bounded: "有限",
  unresolved: "不足",
};

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
  // 2. Internal enum values behind Chinese labels → doctor-facing wording (markdown-bold tolerant).
  text = text.replace(
    /((?:判断)?把握度|置信度)(\*{0,2}[ \t]*[:：][ \t]*\*{0,2})(resolved|bounded|unresolved)(?![A-Za-z])/g,
    (_match, label: string, separator: string, value: string) => `${label}${separator}${VISIBLE_CONFIDENCE_ENUM[value]}`,
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
  return text;
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
