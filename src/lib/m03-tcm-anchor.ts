import type { M03TcmConclusion, M03TcmContext, M03TcmSyndromeCandidate } from "./m03-tcm-conclusion";
import { m03TcmHash } from "./m03-tcm-conclusion";
import { formulaNamesCarryLineage, identifyKnownFormulaNames, selectM03TcmFormulaIdentity, type FormulaReferenceCaseSafety } from "./tcm-formula-provenance";
import { textbookRowForSyndrome } from "./tcm-textbook-syndromes";
import { activeBloodMovingMethodItem, methodForActiveBleeding } from "./active-bleeding-treatment";

export type AnchorDecision = { status: "ready" | "bounded"; record: M03TcmConclusion; reasons: string[] };
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id));
/** A textbook name is a nomination, not an exemption from the checked factor set. */
export function selectM03TcmSyndrome(
  name: string, record: M03TcmConclusion, ctx: M03TcmContext,
): M03TcmSyndromeCandidate | undefined {
  const locations = new Set(record.locations.map((unit) => unit.id));
  const elements = new Set([...record.root, ...record.branch].map((unit) => unit.id));
  const proposed = ctx.syndromes.find((candidate) => candidate.name === name);
  if (!proposed) return undefined;
  const supported = (candidate: M03TcmSyndromeCandidate) => candidate.locationIds.every((id) => locations.has(id)) &&
    candidate.elementIds.every((id) => elements.has(id)) && (candidate.elementIds.length > 0 || candidate.neutral === true && candidate.locationIds.length > 0);
  if (!supported(proposed)) return undefined;
  // Preserve a validated Jingfang identity. Only genuinely equivalent rows may rename it.
  if (proposed.jingfangId) return proposed;
  const row = textbookRowForSyndrome(record.disease.name, name);
  const equivalent = row && ctx.syndromes.find((candidate) => candidate.name === row.syndromeName &&
    candidate.textbookRowId === row.id && sameSet(candidate.elementIds, proposed.elementIds) &&
    sameSet(candidate.locationIds, proposed.locationIds) && supported(candidate));
  return equivalent || proposed;
}

/** Two finite reductions; no rationale/chain is manufactured to invoke a legacy mutator. */
export function resolveM03TcmAnchor(
  input: M03TcmConclusion, ctx: M03TcmContext, caseSafety?: FormulaReferenceCaseSafety,
): AnchorDecision {
  const record = structuredClone(input);
  if (caseSafety?.activeBleeding) {
    const ordered = methodForActiveBleeding(record.methods.map((method) => method.text).join("，")).split("，");
    record.methods = record.methods.filter((method) => !activeBloodMovingMethodItem(method.text))
      .sort((a, b) => ordered.indexOf(a.text) - ordered.indexOf(b.text));
  }
  const candidate = selectM03TcmSyndrome(record.primary.name, record, ctx);
  if (!candidate) return { status: "bounded", record, reasons: ["naming_gap"] };
  record.primary = { name: candidate.name, locationIds: [...candidate.locationIds], elementIds: [...candidate.elementIds], resolution: record.primary.resolution };
  record.anchor = { textbookRowId: candidate.textbookRowId || null, jingfangId: candidate.jingfangId || null, compositeRuleId: candidate.compositeRuleId || null };
  const reduce = () => {
    const decision = selectM03TcmFormulaIdentity({ disease: record.disease.name, syndrome: record.primary.name,
      direction: record.direction, textbookRowId: candidate.textbookRowId, method: record.methods.map((method) => method.text).join("，"),
      factorLabels: [...record.root, ...record.branch].map((unit) => unit.label),
      secondarySyndromes: record.secondary.map((syndrome) => syndrome.name),
      keepDirection: Boolean(candidate.jingfangId || record.lineage && record.lineage.applicable !== "not-applicable" && ctx.lineage &&
        formulaNamesCarryLineage(identifyKnownFormulaNames(record.direction), ctx.lineage.code) === true), caseSafety });
    record.direction = decision.direction;
    record.formulaLock = decision.formulaLock;
  };
  reduce();
  const first = m03TcmHash(record);
  reduce();
  if (m03TcmHash(record) !== first) {
    record.direction = "";
    record.formulaLock = { names: [], mode: "none", sourceIds: [] };
    record.primary.resolution = "bounded";
    return { status: "bounded", record, reasons: ["non_convergent_anchor"] };
  }
  return { status: record.primary.resolution === "bounded" ? "bounded" : "ready", record, reasons: [] };
}
