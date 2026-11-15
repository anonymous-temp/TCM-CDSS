import policy from "../data/delivery-facts-policy.source.json";
import { asRecord, asRows, asStrings, asText, collectDeliveryText, pointerValue, stableDeliveryJson } from "./delivery-text";

export type InvariantRuleId = keyof typeof policy.ruleLabels;
export type InvariantFinding = {
  ruleId: InvariantRuleId; path: string; relatedPaths: string[]; expected: unknown; actual: unknown;
  severity: "quality"; status: "violation" | "unknown"; mode: "enforce" | "shadow";
  repairOwner: "analysis" | "modifications" | "formula" | "differentials" | "ownership" | "references" | "integrity" | "western" | "governance";
  authority: string; detail: string;
};
export type GovernedElements = { ids: string[]; complete: boolean; authority: string };
export type GovernedFormulaClaim = { path: string; quote: string; herb: string; kind: "current" | "removed"; inCurrent: boolean; inOriginal?: boolean; authority: string; complete: boolean };
export type GovernedInvariantContext = {
  named?: GovernedElements; axis?: Record<string, GovernedElements>; pending?: Record<string, GovernedElements>;
  elementSides?: Record<string, "root" | "branch">;
  principle?: { compatible: boolean; expected: string; authority: string; complete: boolean };
  formulaClaims?: GovernedFormulaClaim[];
  roleClaims?: Array<{ path: string; herb: string; assigned: string; tableRole: string; authority: string; complete?: boolean }>;
  equivalentDiagnoses?: Record<string, string>;
  ownershipExpected?: Record<string, unknown>; ownershipShadowPaths?: string[];
  circulationRisk?: { triggered: boolean; reasonCodes: string[]; syndromeCompatible?: boolean; authority?: string };
  grades?: { path: string; expected: string; actual: string; authority: string }[];
};
export type InvariantScanInput = {
  m03?: unknown; m04?: unknown;
  recordIndex?: { sources: Array<{ sourcePath: string; text: string }>; hpiPaths: string[] };
  governedContext?: GovernedInvariantContext;
};
export const DELIVERY_INVARIANT_RULES = Object.entries(policy.ruleLabels).map(([ruleId, label]) => ({ ruleId: ruleId as InvariantRuleId, label, shadowOnly: ruleId === "R11" }));
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const equal = (left: unknown, right: unknown) => stableDeliveryJson(left) === stableDeliveryJson(right);
function expanded(ids: readonly string[]): Set<string> {
  const out = new Set(ids);
  for (const id of out) for (const implied of (policy.elementImplications as Record<string, string[]>)[id] || []) out.add(implied);
  return out;
}
/** Pure scan: no models, environment, mutation or safety predicates. Missing semantic authorities produce shadow unknown, never guessed verdicts. */
export function scanDeliveryInvariants(input: InvariantScanInput): InvariantFinding[] {
  const { governedContext: gov = {} } = input;
  const m03 = asRecord(input.m03);
  const m04 = asRecord(input.m04);
  const final = Object.keys(m03).length ? m03 : m04;
  const base = Object.keys(m03).length ? "/m03" : "/m04";
  const overview = asRecord(final.overview);
  const pathogenesis = asRecord(final.pathogenesis);
  const nature = asRecord(pathogenesis.natureDifferentiation);
  const findings: InvariantFinding[] = [];
  const hit = (ruleId: InvariantRuleId, path: string, expected: unknown, actual: unknown, repairOwner: InvariantFinding["repairOwner"], authority: string, detail = "", complete = true, relatedPaths: string[] = []) => {
    findings.push({ ruleId, path, relatedPaths, expected, actual, severity: "quality", status: complete ? "violation" : "unknown",
      mode: complete && ruleId !== "R11" ? "enforce" : "shadow", repairOwner, authority, detail });
  };
  const naturePath = `${base}/pathogenesis/natureDifferentiation`;
  const axis = gov.axis || {};
  const allLabels = sorted([ ...asStrings(nature.items), ...asStrings(nature.rootDeficiency), ...asStrings(nature.branchExcess) ]);
  const labelsIds = (labels: string[]) => expanded(labels.flatMap((label) => axis[label]?.ids || []));
  const natureIds = labelsIds(allLabels);
  const named = expanded(gov.named?.ids || []);
  const complete = Boolean(gov.named?.complete && allLabels.every((label) => axis[label]?.complete));
  if (Object.keys(nature).length) {
    if (!complete) {
      for (const id of ["R01", "R02"] as const) hit(id, naturePath, "governed syndrome/element mapping", allLabels, "governance", gov.named?.authority || "missing", "incomplete_element_mapping", false);
    } else {
      for (const id of sorted(named)) if (!natureIds.has(id)) hit("R01", naturePath, id, sorted(natureIds), "analysis", gov.named!.authority);
      const pending = expanded(Object.values(gov.pending || {}).filter((entry) => entry.complete).flatMap((entry) => entry.ids));
      const pendingComplete = asRows(pathogenesis.uncertainties).every((_row, index) => gov.pending?.[`${base}/pathogenesis/uncertainties/${index}/item`]?.complete);
      for (const id of sorted(natureIds)) if (!named.has(id) && !pending.has(id)) hit("R02", naturePath, "named or explicitly pending element", id, "analysis", gov.named!.authority, "", pendingComplete);
    }
    const items = asStrings(nature.items);
    const itemsIds = labelsIds(items);
    for (const column of ["rootDeficiency", "branchExcess"] as const) for (const label of asStrings(nature[column])) {
      const entry = axis[label];
      // Literal identical item is a structural member even when semantic mapping is unavailable.
      const member = items.includes(label) || (entry?.complete && entry.ids.every((id) => itemsIds.has(id)));
      const expectedSide = column === "rootDeficiency" ? "root" : "branch";
      const wrongSide = entry?.complete && entry.ids.some((id) => gov.elementSides?.[id] && gov.elementSides[id] !== expectedSide);
      if (!member || wrongSide) hit("R03", `${naturePath}/${column}`, "member of items and correct governed side", label, "analysis", wrongSide ? entry!.authority : "schema:root/branch subset of items", "", Boolean(items.includes(label) || entry?.complete || !items.length));
    }
    const overlap = asStrings(nature.rootDeficiency).filter((item) => asStrings(nature.branchExcess).includes(item));
    if (overlap.length) hit("R03", naturePath, "disjoint root/branch", overlap, "analysis", "schema:disjoint columns");
    if (gov.principle && !gov.principle.compatible) hit("R04", `${base}/therapy/overallPrinciple`, gov.principle.expected, asRecord(final.therapy).overallPrinciple, "analysis", gov.principle.authority, "", gov.principle.complete);
    else if (!gov.principle) hit("R04", `${base}/therapy/overallPrinciple`, "governed compatibility result", asRecord(final.therapy).overallPrinciple, "governance", "missing", "no_principle_authority", false);
  }
  const formula = asRecord(m04.formula);
  const recordIndex = input.recordIndex;
  asRows(formula.modifications).forEach((row, index) => {
    const path = `/m04/formula/modifications/${index}`;
    let trigger = asText(row.trigger);
    const prefix = policy.triggerDisplayPrefixes.find((item) => trigger.startsWith(item));
    if (prefix) trigger = trigger.slice(prefix.length);
    const sources = recordIndex?.sources.filter((source) => recordIndex.hpiPaths.includes(source.sourcePath)) || [];
    const source = asRecord(row.triggerSource);
    const sourceRef = asText(source.sourceRef);
    const sourceQuote = asText(source.sourceQuote);
    // Frozen triggerSource schema points into M03, not into the raw record. Validate both hops.
    const targetPath = sourceRef.split(":")[0].replace(/\[(\d+)\]/gu, "/$1").replace(/\./gu, "/");
    const referenced = targetPath ? pointerValue(final, `/${targetPath}`) : undefined;
    const kindMatches = source.kind === "primary_syndrome_basis" ? targetPath.startsWith("overview/primarySyndromeBasis/")
      : source.kind === "pathogenesis_patient_fact" ? /^pathogenesis\/chain\/\d+\/patientFact$/u.test(targetPath)
      : source.kind === "western_supporting_fact" && targetPath.startsWith("westernDiagnosis/primary/supportingFacts/");
    const nodeId = sourceRef.includes(":") ? sourceRef.slice(sourceRef.indexOf(":") + 1) : "";
    const refNode = source.kind === "pathogenesis_patient_fact" ? asRecord(pointerValue(final, `/${targetPath.slice(0, targetPath.lastIndexOf("/"))}`)) : {};
    const validSource = Boolean(kindMatches && typeof referenced === "string" && referenced.includes(sourceQuote) && sourceQuote.includes(trigger) &&
      (!nodeId || refNode.nodeId === nodeId) && sources.some((entry) => entry.text.includes(sourceQuote)));
    if (!trigger || !sources.some((entry) => entry.text.includes(trigger)) || !validSource) hit("R05", `${path}/trigger`, "verbatim current HPI quote with matching triggerSource", { trigger: row.trigger, triggerSource: row.triggerSource }, "modifications", "D1 §6 R05 HPI quotation contract", "format/source mismatch is not proof of fabricated patient fact", Boolean(recordIndex), [`${path}/triggerSource`]);
  });
  for (const claim of gov.formulaClaims || []) {
    if (claim.kind === "current" && !claim.inCurrent) hit("R06", claim.path, "herb in final candidate table", claim.quote, "formula", claim.authority, claim.herb, claim.complete);
    if (claim.kind === "removed" && (!claim.inOriginal || claim.inCurrent)) hit("R08", claim.path, "locked original has herb and current table does not", claim.quote, "formula", claim.authority, claim.herb, claim.complete);
  }
  if (asRows(formula.candidates).length && !gov.formulaClaims) for (const ruleId of ["R06", "R08"] as const) hit(ruleId, "/m04/formula/candidates", "governed identity/context claims", null, "governance", "missing", "no_formula_authority", false);
  for (const claim of gov.roleClaims || []) if (claim.assigned && ![...claim.assigned].every((role) => claim.tableRole.includes(role))) hit("R07", claim.path, claim.tableRole, claim.assigned, "formula", claim.authority, claim.herb, claim.complete !== false);
  for (const key of ["tcmDiseaseDifferentials", "tcmDifferentials"]) {
    const rows = asRows(overview[key]);
    if (rows.length < 2) hit("R09", `${base}/overview/${key}`, ">=2", rows.length, "differentials", "existing M03 differential minimum");
  }
  const western = asRecord(final.westernDiagnosis);
  const diagnosisGroups: [string, string, unknown, string][] = [
    [`${base}/overview/tcmDiseaseDifferentials`, asText(overview.tcmDiseaseName), overview.tcmDiseaseDifferentials, "diseaseName"],
    [`${base}/overview/tcmDifferentials`, asText(overview.primarySyndrome), overview.tcmDifferentials, "syndrome"],
    [`${base}/westernDiagnosis/differentials`, asText(asRecord(western.primary).name), western.differentials, "name"],
  ];
  const identity = (name: string) => gov.equivalentDiagnoses?.[name] || name.trim();
  for (const [path, primary, rows, key] of diagnosisGroups) {
    const seen = new Set(primary ? [identity(primary)] : []);
    asRows(rows).forEach((row, index) => {
      const name = identity(asText(row[key]));
      if (name && seen.has(name)) hit("R10", `${path}/${index}/${key}`, "distinct differential identity", row[key], "differentials", gov.equivalentDiagnoses?.[asText(row[key])] ? "governed diagnostic relation" : "exact name equality");
      if (name) seen.add(name);
    });
  }
  if (gov.circulationRisk?.triggered && gov.circulationRisk.syndromeCompatible !== true) hit("R11", `${base}/overview/primarySyndrome`, "governed critical syndrome review", { syndrome: overview.primarySyndrome, reasonCodes: gov.circulationRisk.reasonCodes }, "governance", gov.circulationRisk.authority || "phase4 governance missing", "shadow only; never diagnose shock or authorize safety", false);
  if (Object.keys(m03).length && Object.keys(m04).length) {
    if (gov.ownershipExpected) {
      for (const path of Object.keys(gov.ownershipExpected).sort()) {
        const actual = pointerValue(m04, path);
        if (!equal(actual, gov.ownershipExpected[path])) hit("R12", `/m04${path}`, gov.ownershipExpected[path], actual, "ownership", "enforceM04PriorStageOwnership", gov.ownershipShadowPaths?.includes(path) ? "stage-derived or governed-equivalent display; exact ownership requires final projection" : "", !gov.ownershipShadowPaths?.includes(path), [`/m03${path}`]);
      }
    } else hit("R12", "/m04", "M03 ownership projection", null, "governance", "missing", "missing_ownership_projection", false);
  }
  if (Object.keys(m04).length) {
    const nodes = new Set(asRows(asRecord(m04.pathogenesis).chain).map((row) => asText(row.nodeId)).filter(Boolean));
    const targets: [string, Record<string, unknown>][] = [];
    asRows(formula.candidates).forEach((candidate, index) => asRows(candidate.herbs).forEach((herb, herbIndex) => {
      if (herb.targetKind === "pathogenesis_node") targets.push([`/m04/formula/candidates/${index}/herbs/${herbIndex}/targetRef`, herb]);
    }));
    asRows(asRecord(m04.nonPharma).tcmTreatments).forEach((row, index) => {
      if (!row.targetKind || row.targetKind === "pathogenesis_node") targets.push([`/m04/nonPharma/tcmTreatments/${index}/targetRef`, row]);
    });
    for (const [path, row] of targets) if (!nodes.has(asText(row.targetRef))) hit("R13", path, sorted(nodes), row.targetRef, "references", "schema:targetKind/pathogenesis.chain.nodeId");
  }
  asRows(pathogenesis.uncertainties).forEach((row, index) => {
    const path = `${base}/pathogenesis/uncertainties/${index}/item`;
    const entry = gov.pending?.[path];
    if (!entry?.complete) hit("R14", path, "governed pending element IDs", row.item, "governance", "missing", "pending_scope_unclassified", false);
    if (entry?.complete && entry.ids.length && entry.ids.every((id) => named.has(id))) hit("R14", path, "only unsettled elements", row.item, "analysis", entry.authority);
  });
  for (const [stage, root] of [["m03", m03], ["m04", m04]] as const) {
    if (!Object.keys(root).length) continue;
    for (const entry of collectDeliveryText(root, `/${stage}`)) {
      if (entry.role !== "clinical_narrative") continue;
      for (const pattern of policy.morphologyPatterns) for (const match of entry.text.matchAll(new RegExp(pattern, "gu"))) hit("R15", entry.path, "complete uncorrupted text", match[0], "integrity", `${policy.version}:closed morphology`, `offset:${match.index}`);
    }
  }
  if (gov.grades) for (const grade of gov.grades) if (grade.expected !== grade.actual) hit("R16", grade.path, grade.expected, grade.actual, "western", grade.authority);
  return findings;
}
