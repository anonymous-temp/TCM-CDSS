import type { ClinicalReasoningResultV2, EvidenceRef } from "./diagnosis-types";
import { activeM03TcmUnits, assertM03TcmConclusion, m03TcmHash, verifyFrozenM03TcmConclusion,
  type FrozenM03TcmConclusion, type M03TcmContext } from "./m03-tcm-conclusion";
import type { M03TcmNarrative, M03TcmSentence } from "./m03-tcm-narrative";
import { treatmentPrincipleForCheckedTcmAxes } from "./diagnosis-visible-summary";

export type M03TcmHalf = Pick<ClinicalReasoningResultV2, "overview" | "pathogenesis" | "therapy" | "lineageAdaptation"> & {
  schemaVersion: "tcm-cdss-reasoning-v2"; stage: "diagnose"; formula: null; nonPharma: null;
};
const joined = (sentences: readonly M03TcmSentence[]) => sentences.map((sentence) => sentence.text).join("");
const unique = <T>(values: readonly T[]) => [...new Set(values)];
// Axis labels are sets. The shared delivery derivation orders them by the delivered names/chain.
const axisSet = (values: readonly string[]) => unique(values).sort();
export function m03TcmPrinciple(record: FrozenM03TcmConclusion, ctx: M03TcmContext): string {
  return treatmentPrincipleForCheckedTcmAxes(record.root.map((unit) => unit.label), record.branch.map((unit) => unit.label),
    record.methods.map((method) => method.text).join("，"), ctx.safety.redFlag);
}

/** Assembles only the existing TCM-owned fields. No Western/management field can be overwritten. */
export function projectM03TcmHalf(record: FrozenM03TcmConclusion, narrative: M03TcmNarrative, ctx: M03TcmContext): M03TcmHalf {
  if (!verifyFrozenM03TcmConclusion(record)) throw new Error("conclusion_hash_changed");
  assertM03TcmConclusion(record, ctx);
  const quoteText = (ids: readonly string[]) => unique(ids.map((id) => {
    const quote = record.quotes.find((item) => item.id === id);
    if (!quote) throw new Error("unknown_projection_quote");
    return quote.text;
  })).join("；");
  const evidence = (ids: readonly string[]): EvidenceRef => ({ evidenceLevel: ids.length ? "model_inference" : "insufficient",
    source: ids.length ? `患者原文：${quoteText(ids)}`.slice(0, 800) : "尚缺辨证依据", confidence: ids.length ? "中" : "低" });
  const active = activeM03TcmUnits(record);
  const primaryQuotes = unique([...record.primary.locationIds, ...record.primary.elementIds].flatMap((id) => active.find((unit) => unit.id === id)?.quoteIds || []));
  const method = record.methods.map((item) => item.text).join("，");
  const overall = joined(narrative.overall);
  const chain = narrative.chain.map((node, index) => ({
    nodeId: `P${index + 1}`, patientFact: quoteText(node.factQuoteIds), syndromeEvidence: quoteText(node.evidenceQuoteIds),
    pathogenesis: node.text, therapyDirection: node.methodIds.map((id) => {
      const item = record.methods.find((candidate) => candidate.id === id);
      if (!item) throw new Error("unknown_projection_method");
      return item.text;
    }).join("，"), evidence: evidence(node.evidenceQuoteIds),
  }));
  const differential = (row: M03TcmNarrative["diseaseDifferentials"][number], kind: "disease" | "syndrome") => {
    const candidate = ctx.differentials[kind].find((item) => item.id === row.candidateId);
    if (!candidate) throw new Error("differential_out_of_set");
    return { name: candidate.name, reason: row.reason.text, distinguishingPoints: row.distinguishingPoints.text,
      typicalManifestation: candidate.typicalManifestation, nextCheck: row.nextCheck?.text || null };
  };
  const roots = record.root.map((unit) => unit.label);
  const branches = record.branch.map((unit) => unit.label);
  const natureQuotes = unique([...record.root, ...record.branch].flatMap((unit) => unit.quoteIds));
  const locationQuotes = unique(record.locations.flatMap((unit) => unit.quoteIds));
  const boundary = record.primary.resolution === "resolved" ? "现有表现支持本次辨证。" : "现有表现可作初步辨证，尚需补充鉴别信息。";
  return {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", formula: null, nonPharma: null,
    overview: {
      tcmDiseaseName: record.disease.name, primarySyndrome: record.primary.name,
      primarySyndromeResolution: record.primary.resolution, primarySyndromeResolutionReason: boundary,
      primarySyndromeBasis: primaryQuotes.slice(0, 8).map((id) => quoteText([id])),
      secondarySyndromes: record.secondary.map((item) => item.name),
      tcmDiseaseRationale: joined(narrative.diseaseRationale), tcmDiagnosticRationale: joined(narrative.rationale),
      tcmDiseaseReferences: [], tcmSyndromeReferences: [],
      tcmDiseaseDifferentials: narrative.diseaseDifferentials.map((row) => { const { name, ...rest } = differential(row, "disease"); return { diseaseName: name, ...rest }; }),
      tcmDifferentials: narrative.syndromeDifferentials.map((row) => { const { name, ...rest } = differential(row, "syndrome"); return { syndrome: name, ...rest }; }),
      overallPathogenesis: overall, overallTherapy: method, recommendedFormulaDirection: record.direction,
      recommendedFormulaNames: [...record.formulaLock.names], formulaSelectionMode: record.formulaLock.mode,
      evidence: evidence(record.disease.quoteIds),
    },
    pathogenesis: {
      summary: overall,
      locationDifferentiation: { items: record.locations.map((unit) => unit.label),
        details: record.locations.map((unit) => ({ location: unit.label, basis: quoteText(unit.quoteIds) })),
        resolution: record.locations.length > 0 ? "resolved" : "bounded", evidence: evidence(locationQuotes) },
      natureDifferentiation: { items: unique([...roots, ...branches]), rootDeficiency: roots, branchExcess: branches,
        basis: quoteText(natureQuotes), resolution: natureQuotes.length > 0 ? record.primary.resolution : "bounded", evidence: evidence(natureQuotes) },
      symptomClusters: [], chain,
      uncertainties: narrative.uncertainties.map((row) => ({ item: row.item.text, reason: row.reason.text, affects: row.affects.text })),
    },
    therapy: { overallPrinciple: m03TcmPrinciple(record, ctx), overallMethod: method,
      subTherapies: chain.map((node, index) => ({ therapy: node.therapyDirection, targetPathogenesis: node.nodeId,
        priority: index === 0 ? "主要" : "次要", evidence: node.evidence })) },
    lineageAdaptation: record.lineage && ctx.lineage && narrative.lineageText && narrative.lineageText.reason.length > 0 ? {
      schemaVersion: "tcm-cdss-reasoning-v2", lineageCode: ctx.lineage.code, label: ctx.lineage.label,
      applicable: record.lineage.applicable, applicabilityReason: joined(narrative.lineageText.reason),
      influencedDecisions: narrative.lineageText.influencedDecisions.map((row) => ({ aspect: row.aspect, detail: row.detail.text })),
      unaffectedBySafety: [...ctx.lineage.unaffectedBySafety], safetyDeference: ctx.lineage.safetyDeference,
    } : null,
  };
}

/** Same representation for a frozen record and every final delivery surface; no prose-derived inference. */
export function conclusionFootprint(value: M03TcmHalf): string {
  return m03TcmHash({ disease: value.overview.tcmDiseaseName, primary: value.overview.primarySyndrome,
    secondary: value.overview.secondarySyndromes || [], resolution: value.overview.primarySyndromeResolution,
    locations: axisSet(value.pathogenesis.locationDifferentiation.items),
    nature: axisSet(value.pathogenesis.natureDifferentiation.items), root: axisSet(value.pathogenesis.natureDifferentiation.rootDeficiency || []),
    branch: axisSet(value.pathogenesis.natureDifferentiation.branchExcess || []),
    method: value.therapy.overallMethod, therapy: value.overview.overallTherapy, principle: value.therapy.overallPrinciple,
    direction: value.overview.recommendedFormulaDirection, names: value.overview.recommendedFormulaNames || [], mode: value.overview.formulaSelectionMode,
    lineage: value.lineageAdaptation ? { code: value.lineageAdaptation.lineageCode, applicable: value.lineageAdaptation.applicable } : null });
}
export function frozenM03TcmFootprint(record: FrozenM03TcmConclusion, ctx: M03TcmContext, hasLineage: boolean): string {
  const root = axisSet(record.root.map((unit) => unit.label)), branch = axisSet(record.branch.map((unit) => unit.label));
  const method = record.methods.map((item) => item.text).join("，");
  return m03TcmHash({ disease: record.disease.name, primary: record.primary.name, secondary: record.secondary.map((item) => item.name),
    resolution: record.primary.resolution, locations: axisSet(record.locations.map((unit) => unit.label)), nature: axisSet([...root, ...branch]), root, branch,
    method, therapy: method, principle: m03TcmPrinciple(record, ctx), direction: record.direction, names: record.formulaLock.names, mode: record.formulaLock.mode,
    lineage: hasLineage && record.lineage && ctx.lineage ? { code: ctx.lineage.code, applicable: record.lineage.applicable } : null });
}
export function assertM03TcmProjection(record: FrozenM03TcmConclusion, half: M03TcmHalf, ctx: M03TcmContext): void {
  if (!verifyFrozenM03TcmConclusion(record) || conclusionFootprint(half) !== frozenM03TcmFootprint(record, ctx, half.lineageAdaptation !== null)) throw new Error("conclusion_projection_drift");
  if (half.overview.overallPathogenesis !== half.pathogenesis.summary) throw new Error("summary_projection_drift");
  const methods = new Set(record.methods.map((method) => method.text));
  for (const [index, node] of half.pathogenesis.chain.entries()) {
    if (node.nodeId !== `P${index + 1}` || !node.therapyDirection.split("，").every((item) => methods.has(item))) throw new Error("chain_projection_drift");
    const sub = half.therapy.subTherapies[index];
    if (sub?.targetPathogenesis !== node.nodeId || sub.therapy !== node.therapyDirection) throw new Error("subtherapy_projection_drift");
  }
  if (half.therapy.subTherapies.length !== half.pathogenesis.chain.length) throw new Error("subtherapy_projection_drift");
}
