import "server-only";
import { applyFormulaRelock, formulaRelockAfterSyndromeRewrite, syndromeRewriteBreaksFormulaLock } from "./tcm-formula-indications";

import promotion from "../data/tcm-syndrome-element-promotion.source.json" with { type: "json" };
import deficiencyLexicon from "../data/tcm-deficiency-element-lexicon.source.json" with { type: "json" };
import vitalWindows from "../data/priority-evaluation-windows.source.json" with { type: "json" };
import collapseSigns from "../data/tcm-true-heart-pain-signs.source.json" with { type: "json" };
import { deficiencyMentions, entailedDeficiencies, elementSupportEnabled, findingsBeforeAttribution, diagnosticsCriteriaEvidence, combinedElementVerdict, type DeficiencyType } from "./m03-element-support.server";
import { EXCESS_ELEMENTS, namedExcessElements, methodImpliedExcessElements, withoutDanglingConclusionLeads } from "./analysis-element-closure";
import { diagnosticsCriteriaFor, primaryManifestationTerms, textbookPatternFit, GROUP_CHECK_FIT_CEILING, verifySecondaryByCriteria, secondaryStructurallyInvalid, applySecondaryConsistencyDecision, withoutClauses, type CriteriaVerdict } from "./m03-secondary-syndrome-consistency.server";
import { textbookRowForSyndrome, textbookFormulaRowsForDisease } from "./tcm-textbook-syndromes";
import { compositeSyndromeRename } from "./delivered-surface";
import { governedFourCharacterMethodTerms, resolveNationalStandardTcmSyndromeTerm } from "./clinical-governance-tables";
import { clauseLocalMentionPolarityAt, currentVitalMeasurements, maskNonNegatingWuWords } from "./diagnosis-safety";
import { isCriticalSyndromeName } from "./m03-critical-syndrome";
import { trueHeartPainSignal } from "./true-heart-pain";
import { therapyItemsOnlyFor } from "./tcm-therapy-phrasing";
import type { CaseState } from "./diagnosis-types";
import { coreProseAfterCut, rowsAfterCut } from "./m03-core-prose-floor";

/** D3：判据与命名共用一份台账；不从病机链重建病位病性，不改变安全门。 */
type Json = Record<string, unknown>;
const object = (v: unknown): Json | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Json : undefined;
const text = (v: unknown): string => typeof v === "string" ? v.trim() : "";
const strings = (v: unknown): string[] => Array.isArray(v) ? v.map(text).filter(Boolean) : [];
const records = (v: unknown): Json[] => Array.isArray(v) ? v.flatMap((x) => object(x) ? [object(x)!] : []) : [];
const unique = <T,>(v: T[]): T[] => [...new Set(v)];
const split = (v: string): string[] => v.split(/[，,；;。]/u).map((x) => x.trim()).filter(Boolean);
const names = (root: Json): string[] => [text(object(root.overview)?.primarySyndrome), ...strings(object(root.overview)?.secondarySyndromes)].filter(Boolean);
const deficiencies = Object.keys(deficiencyLexicon.types) as DeficiencyType[];
const isDeficiency = (type: string): type is DeficiencyType => deficiencies.includes(type as DeficiencyType);
const extra = (type: string) => promotion.extras.find((row) => row.type === type);
const collapseNamed = (name: string) => name.endsWith("脱证") || isCriticalSyndromeName(name) || Boolean(extra("collapse")?.nameMarkers.some((marker) => name.includes(marker)));
const organsIn = (v: string): string[] => promotion.locationOrgans.filter((organ) => v.includes(organ));
const unknown = (entry?: string): CriteriaVerdict => ({ verdict: "unknown", entry, specific: 0, category: 0, listed: 0, distinct: 0 });
function pendingElementText(value: string): string {
  const prefix = promotion.pendingQuestionPrefixes.find((part) => value.startsWith(part));
  if (!prefix) return value;
  const rest = value.slice(prefix.length);
  const suffix = promotion.analysisNegationAfter.find((part) => rest.endsWith(part));
  return suffix ? rest.slice(0, -suffix.length) : rest;
}

export type LedgerElement = { type: string; organs: string[]; sources: string[]; entryName: string; secondaryName?: string; label: string; method: string };
export type ClosureContext = { recordText: string; gateRedFlags?: readonly string[]; caseState?: CaseState };
export type ClosureDecision = { elements: Array<{ unit: LedgerElement; verdict: CriteriaVerdict }>; context: ClosureContext; protectedByPrimary: boolean; collapse?: string };
export type CriteriaVerifier = (name: string, context: { recordText: string; primaryTerms: readonly string[]; breadth?: boolean }, signal?: AbortSignal) => Promise<CriteriaVerdict>;

function positiveAt(value: string, at: number, length: number): boolean {
  const scoped = maskNonNegatingWuWords(value);
  const before = scoped.slice(0, at);
  const after = scoped.slice(at + length);
  const tail = scoped.slice(at).split(/[，,。；;]/u)[0];
  return !promotion.analysisNegatedClauseSuffixes.some((suffix) => tail.endsWith(suffix)) && !promotion.analysisNegationBefore.some((term) => new RegExp(`${term}[一-鿿]{0,3}$`, "u").test(before)) &&
    !promotion.analysisNegationAfter.some((term) => after.startsWith(term)) && clauseLocalMentionPolarityAt(scoped, at) === "affirmed";
}

function hasPositiveMarker(value: string, markers: readonly string[]): boolean {
  return markers.some((marker) => {
    for (let at = value.indexOf(marker); at >= 0; at = value.indexOf(marker, at + marker.length)) if (positiveAt(value, at, marker.length)) return true;
    return false;
  });
}

// 与旧证素核对同一构词守卫：养肝血/滋肾阴。复合治法中的另一脏腑字不能归给所有证素。
function infixedDeficiencyMethods(type: DeficiencyType, organ: string): string[] {
  return deficiencyLexicon.types[type].therapyVerbs.filter((verb) => verb.length === 2 && verb[1] === type[0])
    .map((verb) => `${verb[0]}${organ}${type[0]}`);
}

/** 沿用已有断言句边界，虚实共用逐处否认守卫。流派句不作为本例断言。 */
export function elementAssertionClauses(value: string): string[] {
  return value.split(/[。；;]/u).flatMap((sentence) => deficiencyLexicon.rationaleClauseFilter.lineageLensMarkers.some((m) => sentence.includes(m)) ? [] : sentence.split(/[，,]/u))
    .filter((clause) => deficiencyLexicon.rationaleClauseFilter.assertionMarkers.some((m) => clause.includes(m)));
}

function typesIn(value: string, nature = false, method = false): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const mention of deficiencyMentions(value)) {
    if (!positiveAt(value, mention.start, mention.text.length)) continue;
    for (const type of mention.types) found.set(type, unique([...(found.get(type) || []), ...mention.organs]));
  }
  for (const element of EXCESS_ELEMENTS) {
    if (hasPositiveMarker(value, element.analysisMentions) || (nature && hasPositiveMarker(value, promotion.natureElementMarkers[element.id])) ||
      (method && methodImpliedExcessElements(value).has(element.id) && hasPositiveMarker(value, element.methodWords))) found.set(element.id, organsIn(value));
  }
  for (const row of promotion.extras) {
    const markers = method ? row.methods : row.mentions;
    const exactNature = nature && "natureLabels" in row && row.natureLabels?.includes(value);
    if (hasPositiveMarker(value, markers) || exactNature) found.set(row.type, organsIn(value));
  }
  if (method) for (const type of deficiencies) {
    const organs = promotion.locationOrgans.filter((organ) => hasPositiveMarker(value, infixedDeficiencyMethods(type, organ)));
    if (hasPositiveMarker(value, promotion.deficiencyMethods[type]) || organs.length > 0) found.set(type, organs);
  }
  return found;
}

/** 虚实均算；明确的气血/气阴合称不能因为含“两虚”便蕴含所有阴阳虚。 */
export function entailedElements(syndromes: readonly string[]): Map<string, Set<string> | "any"> {
  const out = new Map<string, Set<string> | "any">();
  const put = (type: string, organs: string[] | "any") => {
    if (out.get(type) === "any") return;
    if (organs === "any" || organs.length === 0) { out.set(type, "any"); return; }
    const expanded = isDeficiency(type) ? organs.flatMap((organ) => [organ, ...deficiencyLexicon.entailment.organCoverageGroups.filter((group) => group.includes(organ)).flat()]) : organs;
    out.set(type, new Set([...(out.get(type) || []), ...expanded]));
  };
  for (const name of syndromes) {
    const locations = organsIn(name);
    if (locations.length > 0) put("location", locations);
    const explicit = promotion.explicitNameEntailments.find((row) => row.names.includes(name));
    const mentions = deficiencyMentions(name);
    const legacy = entailedDeficiencies([name]);
    const explicitTypes = mentions.filter((mention) => mention.text !== "两虚");
    const types = explicit?.types || (explicitTypes.length ? unique(explicitTypes.flatMap((m) => m.types).flatMap((type) => [type, ...(deficiencyLexicon.entailment.typeImplies[type as keyof typeof deficiencyLexicon.entailment.typeImplies] || [])])) : [...legacy.keys()]);
    for (const type of types) {
      const organs = explicit?.organs || legacy.get(type as DeficiencyType) || "any";
      put(type, organs === "any" ? organs : [...organs]);
    }
    for (const id of namedExcessElements([name])) put(id, "any");
    for (const row of promotion.extras) if (row.nameMarkers.some((m) => name.includes(m))) put(row.type, "any");
    for (const row of promotion.nameImpliedElements) if (row.markers.some((marker) => name.includes(marker))) {
      for (const type of row.types) put(type, "any");
      if (row.organs.length > 0) put("location", row.organs);
    }
    // 命名的虚热/虚寒由阴阳虚涵盖，不再另外立热/寒的兼证。
    if (types.includes("阳虚")) put("cold", "any");
    if (types.includes("阴虚")) put("heat", "any");
  }
  return out;
}

function covered(unit: Pick<LedgerElement, "type" | "organs">, entailed: ReturnType<typeof entailedElements>): boolean {
  const hit = entailed.get(unit.type);
  return hit === "any" || Boolean(hit && (unit.organs.length === 0 || unit.organs.every((organ) => hit.has(organ))));
}

function criteriaName(type: string, organs: string[]): string {
  if (!isDeficiency(type)) return EXCESS_ELEMENTS.find((row) => row.id === type)?.criteriaEntry || extra(type)?.entryName || "";
  const config = deficiencyLexicon.types[type];
  for (const prefix of [organs.join(""), [...organs].reverse().join("")].filter(Boolean)) {
    const entry = diagnosticsCriteriaFor(`${prefix}${config.organEntrySuffix}`);
    if (entry) return entry.name;
  }
  return config.genericEntry;
}

export function syndromeElementLedger(root: Json): LedgerElement[] {
  const overview = object(root.overview);
  const path = object(root.pathogenesis);
  const nature = object(path?.natureDifferentiation);
  const ledger = new Map<string, LedgerElement>();
  const namedProducts = namedExcessElements(names(root));
  const add = (value: string, source: string, nature = false, method = false) => {
    const interpreted = !method && (namedProducts.has("phlegm") || namedProducts.has("damp")) ? value.split("痰湿").join("") : value;
    for (const [type, organs] of typesIn(interpreted, nature, method)) {
      const key = isDeficiency(type) ? `${type}/${organs.join("")}` : type;
      const product = EXCESS_ELEMENTS.find((element) => element.id === type);
      const compound = product?.compound.find((part) => interpreted.includes(part.mention));
      const secondaryName = (compound?.secondaryNames || product?.secondaryNames || extra(type)?.secondaryNames || []).find((name) => resolveNationalStandardTcmSyndromeTerm(name));
      const row: LedgerElement = ledger.get(key) || { type, organs, sources: [], entryName: compound?.criteriaEntry || criteriaName(type, organs), ...(secondaryName ? { secondaryName } : {}), label: isDeficiency(type) ? type : compound?.mention || product?.label || extra(type)?.label || type,
        method: isDeficiency(type) ? deficiencyLexicon.types[type].therapyVerbs[0] : compound?.methodItem || product?.methodItem || extra(type)?.methods[0] || "" };
      if (compound && row.entryName === product?.criteriaEntry) {
        row.entryName = compound.criteriaEntry;
        row.label = compound.mention;
        row.method = compound.methodItem;
        if (secondaryName) row.secondaryName = secondaryName;
      }
      row.organs = unique([...row.organs, ...organs]);
      row.sources = unique([...row.sources, source]);
      ledger.set(key, row);
    }
  };
  for (const key of ["items", "rootDeficiency", "branchExcess"]) for (const value of strings(nature?.[key])) {
    add(value, `nature.${key}`, true);
    // 未收录的病性也记账；无判据时保留、遥测，不把“没有识别出来”当作“不成立”。
    if (value !== "无" && typesIn(value, true).size === 0) {
      const row: LedgerElement = ledger.get(`unmapped/${value}`) || { type: "unmapped", organs: [], sources: [], entryName: "", label: value, method: "" };
      row.sources = unique([...row.sources, `nature.${key}`]);
      ledger.set(`unmapped/${value}`, row);
    }
  }
  for (const clause of elementAssertionClauses(text(overview?.tcmDiagnosticRationale))) add(clause, "rationale");
  for (const node of records(path?.chain)) add(text(node.pathogenesis), "chain");
  for (const method of split(text(object(root.therapy)?.overallMethod))) add(method, "method", false, true);
  const named = names(root).join("、");
  const locations = strings(object(path?.locationDifferentiation)?.items).join("、");
  const assertedOrgans = unique([...ledger.values()].filter((row) => isDeficiency(row.type) && row.organs.length > 0)
    .filter((row) => row.organs.every((organ) => locations.includes(organ)) && row.organs.some((organ) => !named.includes(organ)))
    .map((row) => row.organs.join("")));
  for (const group of assertedOrgans) {
    const organs = organsIn(group).filter((organ) => !named.includes(organ));
    const assertion = [...ledger.values()].find((row) => row.organs.join("") === group && isDeficiency(row.type));
    const entryName = assertion ? criteriaName(assertion.type, organs) : "";
    if (organs.length > 0 && entryName.startsWith(organs.join(""))) ledger.set(`location/${organs.join("")}`, { type: "location", organs, sources: ["location", "rationale"], entryName, label: organs.join(""), method: "" });
  }
  for (const location of strings(object(path?.locationDifferentiation)?.items)) {
    if (location !== "无" && organsIn(location).length === 0 && !named.includes(location)) {
      ledger.set(`location/${location}`, { type: "location", organs: [location], sources: ["location"], entryName: "", label: location, method: "" });
    }
    for (const organ of organsIn(location)) {
      if (named.includes(organ)) continue;
      if ([...ledger.values()].some((row) => row.type === "location" && row.organs.includes(organ))) continue;
      ledger.set(`location/${organ}`, { type: "location", organs: [organ], sources: ["location"], entryName: "", label: organ, method: "" });
    }
  }
  return [...ledger.values()];
}

function groundedOrganQuotes(root: Json, organ: string, recordText: string): string[] {
  return unique(records(object(object(root.pathogenesis)?.locationDifferentiation)?.details).filter((row) => text(row.location).includes(organ))
    .flatMap((row) => text(row.basis).split(/[、，,；;。]/u)).map((s) => s.trim()).filter((s) => s.length >= 2 && recordText.includes(s) && clauseLocalMentionPolarityAt(recordText, recordText.indexOf(s)) === "affirmed"));
}

function organRule(root: Json, unit: LedgerElement) {
  const primary = text(object(root.overview)?.primarySyndrome);
  return promotion.rules.find((rule) => rule.element === "location" && rule.primary.includes(primary) && rule.organ === unit.organs[0] &&
    (!rule.requires || syndromeElementLedger(root).some((row) => row.type === rule.requires)));
}

/** 只用与安全层同源的生命体征阈值/危候词表；红旗本身不由本模块决定。 */
export function groupedCollapseSignal(context: ClosureContext): boolean {
  if (!context.gateRedFlags?.length || !context.caseState) return false;
  if (trueHeartPainSignal(context.recordText, context.gateRedFlags)) return true;
  const vital = currentVitalMeasurements(context.caseState);
  const bp = vital.bloodPressure;
  const threshold = vitalWindows.vitalInstability.shockIndex;
  const collapse = unique(collapseSigns.collapseSigns.filter((sign) => {
    const at = context.recordText.indexOf(sign);
    return at >= 0 && clauseLocalMentionPolarityAt(context.recordText, at) === "affirmed";
  }));
  // 长短别名同一征象只算一次（大汗淋漓/大汗/汗出、脉微/脉微欲绝）。
  const independent = collapse.filter((sign) => !collapse.some((other) => other !== sign && other.includes(sign)));
  const numerical = Boolean(bp && vital.pulse != null && bp.systolic <= threshold.systolicAtMost && vital.pulse >= threshold.pulseAtLeast && vital.pulse / bp.systolic >= threshold.indexAtLeast);
  return numerical ? independent.length >= 1 : independent.length >= 2;
}

function collapseName(root: Json, context: ClosureContext): string | undefined {
  if (!groupedCollapseSignal(context) || names(root).some(collapseNamed)) return undefined;
  if (!syndromeElementLedger(root).some((unit) => unit.type === "collapse" && unit.sources.some((source) => source !== "method"))) return undefined;
  const disease = text(object(root.overview)?.tcmDiseaseName);
  const row = textbookFormulaRowsForDisease(disease).find((candidate) => collapseNamed(candidate.syndromeName) && resolveNationalStandardTcmSyndromeTerm(candidate.syndromeName));
  return row?.syndromeName || extra("collapse")?.secondaryNames?.find((name) => resolveNationalStandardTcmSyndromeTerm(name));
}

/** 第十五/四十六轮同一判据任务的扩展触发；注入只供离线测试，不改变模型判据。 */
export async function decideElementSupport(content: string, context: ClosureContext, signal?: AbortSignal, verify: CriteriaVerifier = verifySecondaryByCriteria, telemetry = true): Promise<ClosureDecision | undefined> {
  if (!elementSupportEnabled()) return undefined;
  let root: Json | undefined;
  try { root = object(JSON.parse(content)); } catch { return undefined; }
  const overview = object(root?.overview);
  if (!root || !overview || !text(overview.primarySyndrome) || overview.primarySyndromeResolution === "unresolved") return undefined;
  const primaryRow = textbookRowForSyndrome(text(overview.tcmDiseaseName), text(overview.primarySyndrome));
  const fit = primaryRow ? textbookPatternFit(primaryRow, context.recordText) : undefined;
  const protectedByPrimary = fit !== undefined && fit >= GROUP_CHECK_FIT_CEILING;
  const collapse = collapseName(root, context);
  const entailed = entailedElements(names(root));
  const missing = syndromeElementLedger(root).filter((unit) => !covered(unit, entailed) && unit.type !== "collapse").map((unit) => {
    const namedOrgans = entailed.get(unit.type);
    if (!isDeficiency(unit.type) || !(namedOrgans instanceof Set)) return unit;
    const organs = unit.organs.filter((organ) => !namedOrgans.has(organ));
    return { ...unit, organs, entryName: criteriaName(unit.type, organs) };
  });
  // 器官明确的同类核对优先，泛称不再重复发一次任务。
  const units = missing.filter((unit) => unit.organs.length > 0 || !missing.some((other) => other.type === unit.type && other.organs.length > 0))
    .filter((unit) => !isDeficiency(unit.type) || unit.organs.length === 0 || !missing.some((other) => {
      if (other.type !== "location" || !unit.organs.every((organ) => other.organs.includes(organ))) return false;
      return other.entryName === unit.entryName || organRule(root!, other)?.requires === unit.type;
    }));
  const memo = new Map<string, Promise<CriteriaVerdict>>();
  const check = (entry: string) => {
    if (!memo.has(entry)) memo.set(entry, verify(entry, { recordText: context.recordText, primaryTerms: primaryManifestationTerms(primaryRow), breadth: true }, signal).catch(() => unknown(entry)));
    return memo.get(entry)!;
  };
  const elements = await Promise.all(units.map(async (unit) => {
    // 既有吻合度闸门只用于另找实邪；不能把它扩大到虚性/脏腑，否则产后身痛·血虚证永远补不进气虚。
    if (protectedByPrimary && !isDeficiency(unit.type) && unit.type !== "location" && unit.type !== "yingwei") return { unit, verdict: unknown(unit.entryName) };
    if (unit.type === "location") {
      // 无合称、也未断言这一脏腑的具体病性：无判据，不以“少两条”擅撤病位。
      const rule = organRule(root!, unit);
      if (!rule && !unit.entryName) return { unit, verdict: unknown() };
      const organQuotes = unit.organs.map((organ) => groundedOrganQuotes(root!, organ, context.recordText));
      const quotes = unique(organQuotes.flat());
      const grounded = organQuotes.every((own) => own.length >= 2);
      if (rule || !grounded) return { unit, verdict: { ...unknown(unit.entryName), verdict: grounded ? "pass" : "fail", strict: grounded, distinct: quotes.length, quotes } as CriteriaVerdict };
      return { unit, verdict: await check(unit.entryName) };
    }
    if (!unit.entryName) return { unit, verdict: unknown() };
    // 祛风也用于内风；仅凭治法不能选择外风的“风淫证”判据。
    if (unit.type === "wind" && unit.sources.every((source) => source === "method")) return { unit, verdict: unknown(unit.entryName) };
    const organ = await check(unit.entryName);
    if (isDeficiency(unit.type) && unit.entryName !== deficiencyLexicon.types[unit.type].genericEntry && !entailed.has(unit.type)) {
      const generic = await check(deficiencyLexicon.types[unit.type].genericEntry);
      return { unit, verdict: combinedElementVerdict(organ, generic).verdict };
    }
    return { unit, verdict: organ };
  }));
  if (telemetry) console.info("[tcm-cdss:telemetry] m03_syndrome_element_closure", { protectedByPrimary, units: elements.map(({ unit, verdict }) => `${unit.type}/${unit.organs.join("")}:${verdict.verdict}:${Boolean(verdict.strict)}`), collapse: collapse || null });
  return { elements, context, protectedByPrimary, ...(collapse ? { collapse } : {}) };
}

function rename(root: Json, to: string): void {
  const overview = object(root.overview)!;
  const from = text(overview.primarySyndrome);
  overview.primarySyndrome = to;
  const entailed = entailedElements([to]);
  overview.secondarySyndromes = strings(overview.secondarySyndromes).filter((name) => {
    const parts = [...entailedElements([name])];
    return !parts.length || !parts.every(([type, organs]) => covered({ type, organs: organs === "any" ? [] : [...organs] }, entailed));
  });
  for (const key of ["tcmDiagnosticRationale", "overallPathogenesis"]) if (typeof overview[key] === "string") overview[key] = (overview[key] as string).split(from).join(to);
  overview.tcmDifferentials = records(overview.tcmDifferentials).filter((row) => ![from, to].includes(text(row.syndrome))).map((row) => {
    for (const key of Object.keys(row)) if (key !== "syndrome" && typeof row[key] === "string") row[key] = (row[key] as string).split(from).join(to);
    return row;
  });
}

/** 表中条目也须运行时通过国标核对；参数注入只用于反证查不到的合称。 */
export function nationalElementCompositeName(rule: { composite: string } | undefined): string | undefined {
  return rule && resolveNationalStandardTcmSyndromeTerm(rule.composite) ? rule.composite : undefined;
}

function promote(root: Json, unit: LedgerElement, verdict: CriteriaVerdict, recordText = ""): boolean {
  if (verdict.verdict !== "pass" || !verdict.strict) return false;
  const overview = object(root.overview)!;
  if (covered(unit, entailedElements(names(root)))) return false;
  const primary = text(overview.primarySyndrome);
  const rule = unit.type === "location" ? organRule(root, unit) : promotion.rules.find((row) => row.element === unit.type && row.primary.includes(primary));
  const composite = nationalElementCompositeName(rule);
  // 晋升合称后锁定方不再对证时按新证名重选（formulaRelockAfterSyndromeRewrite，第五十五轮）；找不到可锁定的替代才改走立兼证（同样要不失效）。
  if (composite) {
    const relock = formulaRelockAfterSyndromeRewrite(root, (copy) => rename(copy as Json, composite), recordText);
    if (relock !== null) { rename(root, composite); if (relock) applyFormulaRelock(root, relock); return true; }
  }
  const entryName = verdict.entry || unit.entryName;
  const name = resolveNationalStandardTcmSyndromeTerm(entryName) ? entryName : unit.secondaryName || entryName;
  // D3 对已独立过辨证要点的证素立兼证；不再因同属本病的教材分型而挡掉（如汗证的营卫不和）。
  // 寒热冲突、主证已含等结构守卫仍共用；模型原生兼证的并列分型检查不变。
  if (!resolveNationalStandardTcmSyndromeTerm(name) || secondaryStructurallyInvalid(primary, name)) return false;
  const secondaries = strings(overview.secondarySyndromes);
  if (secondaries.includes(name) || secondaries.length >= 6) return false;
  if (syndromeRewriteBreaksFormulaLock(root, (copy) => { const o = object(copy.overview); if (o) o.secondarySyndromes = [...strings(o.secondarySyndromes), name]; }, recordText)) return false;
  const alreadyTreats = typesIn(text(object(root.therapy)?.overallMethod), false, true).has(unit.type);
  const governed = (promotion as { secondaryMethods?: Record<string, string> }).secondaryMethods?.[name];
  const method = governed && governedFourCharacterMethodTerms().includes(governed) ? governed : unit.method;
  applySecondaryConsistencyDecision(root, { decision: "add", secondarySyndrome: name, method: alreadyTreats ? "" : method, evidence: verdict.quotes || [] });
  if (!alreadyTreats && unit.method && typeof overview.overallTherapy === "string") overview.overallTherapy = text(object(root.therapy)?.overallMethod);
  overview.secondarySyndromes = [...secondaries, name];
  const path = object(root.pathogenesis);
  for (const node of records(path?.chain)) if (typesIn(text(node.pathogenesis)).has(unit.type)) node.evidence = diagnosticsCriteriaEvidence(name);
  return true;
}

/** 撤断言、保留病历表现；不写“需核实X”。不按功效删除方药。 */
function withdraw(root: Json, unit: LedgerElement, appendExtractedFindings = true): boolean {
  const overview = object(root.overview)!;
  const path = object(root.pathogenesis);
  if (!path || covered(unit, entailedElements(names(root)))) return false;
  const entails = entailedElements(names(root));
  const mentions = (value: string, method = false, natureLabel = false): boolean => {
    if (unit.type === "location") return unit.organs.some((organ) => value.includes(organ));
    const hit = typesIn(value, natureLabel, method).get(unit.type);
    if (!hit) return false;
    if (unit.organs.length === 0) return true;
    if (hit.length > 0) return hit.some((organ) => unit.organs.includes(organ));
    return !entails.has(unit.type);
  };
  const clean = (value: string, preserveFindings = false): string => {
    const clauses = value.split(/[。；;]/u).flatMap((sentence) => deficiencyLexicon.rationaleClauseFilter.lineageLensMarkers.some((m) => sentence.includes(m)) ? [] : sentence.split(/[，,]/u));
    const removals = clauses.map((s) => s.trim()).filter((s) => {
      if (!s || !mentions(pendingElementText(s))) return false;
      // 症状里的脏腑字不是病位断言；同一决定第二次落地时也保留已救回的病历表现。
      if (preserveFindings && unit.type === "location" && typesIn(s).size === 0 &&
        !deficiencyLexicon.rationaleClauseFilter.assertionMarkers.some((marker) => s.includes(marker))) return false;
      return true;
    });
    let next = withoutClauses(value, removals);
    if (preserveFindings && appendExtractedFindings) {
      const kept = removals.flatMap((clause) => {
        if (!isDeficiency(unit.type)) {
          const prefix = findingsBeforeAttribution(clause, new Set<DeficiencyType>(), entailedDeficiencies(names(root)));
          if (unit.type === "location") return prefix && typesIn(prefix).size === 0 ? [prefix] : [];
          return prefix && !mentions(prefix) ? [prefix] : [];
        }
        return findingsBeforeAttribution(clause, new Set([unit.type]), entailedDeficiencies(names(root))) || [];
      }).filter((s) => !next.includes(s));
      next = [next, ...kept].filter(Boolean).join("；");
    }
    return withoutDanglingConclusionLeads(next);
  };
  const nature = object(path.natureDifferentiation);
  if (nature && typeof nature.basis === "string") nature.basis = clean(nature.basis, true);
  if (nature) for (const key of ["items", "rootDeficiency", "branchExcess"]) if (Array.isArray(nature[key])) nature[key] = unique(strings(nature[key]).flatMap((item) => {
    if (!mentions(item, false, true)) return [item];
    // 气血两虚只撤气虚时保留血虚，不能把同一合称里的主证证素一并撤掉。
    return [...typesIn(item, true).keys()].filter((type) => type !== unit.type)
      .map((type) => isDeficiency(type) ? type : EXCESS_ELEMENTS.find((row) => row.id === type)?.label || (type === "collapse" ? "" : extra(type)?.label) || "").filter(Boolean);
  }));
  if (unit.type === "location") {
    const location = object(path.locationDifferentiation);
    if (location) {
      location.items = strings(location.items).filter((item) => !unit.organs.includes(item));
      location.details = records(location.details).filter((item) => !unit.organs.includes(text(item.location)));
    }
  }
  for (const key of ["tcmDiagnosticRationale", "overallPathogenesis"]) if (typeof overview[key] === "string") overview[key] = coreProseAfterCut(key, overview[key], clean(overview[key] as string, true));
  if (typeof path.summary === "string") path.summary = coreProseAfterCut("summary", path.summary, clean(path.summary));
  const row = textbookRowForSyndrome(text(overview.tcmDiseaseName), text(overview.primarySyndrome));
  const textbookMethod = split(row?.therapy || "");
  const cleanMethod = (value: string) => split(value).flatMap((item) => {
    if (!mentions(item, true) || textbookMethod.includes(item)) return [item];
    if (unit.type === "location" && therapyItemsOnlyFor(item, unit.organs.join(""), text(overview.primarySyndrome), row?.therapy || "").length === 0) return [item];
    const other = [...typesIn(item, false, true).keys()].some((type) => type !== unit.type);
    if (!other) return [];
    const verbs = isDeficiency(unit.type) ? [...promotion.deficiencyMethods[unit.type], ...promotion.locationOrgans.flatMap((organ) => infixedDeficiencyMethods(unit.type as DeficiencyType, organ))].sort((a, b) => b.length - a.length)
      : EXCESS_ELEMENTS.find((row) => row.id === unit.type)?.methodWords || extra(unit.type)?.methods || [];
    const remaining = verbs.reduce((rest, verb) => rest.split(verb).join(""), item).trim();
    return remaining && !mentions(remaining, true) ? [remaining] : [];
  }).join("，");
  const therapy = object(root.therapy);
  if (therapy && typeof therapy.overallMethod === "string") therapy.overallMethod = coreProseAfterCut("overallMethod", therapy.overallMethod, cleanMethod(therapy.overallMethod));
  if (typeof overview.overallTherapy === "string") overview.overallTherapy = coreProseAfterCut("overallTherapy", overview.overallTherapy, cleanMethod(overview.overallTherapy));
  const chainBefore = records(path.chain);
  path.chain = rowsAfterCut(chainBefore, chainBefore.flatMap((node) => {
    const mechanism = clean(text(node.pathogenesis));
    const method = cleanMethod(text(node.therapyDirection));
    if (!mechanism || !method) return [];
    return [{ ...node, pathogenesis: mechanism, therapyDirection: method }];
  }));
  if (therapy && Array.isArray(therapy.subTherapies)) therapy.subTherapies = records(therapy.subTherapies).flatMap((row) => {
    const targetPathogenesis = clean(text(row.targetPathogenesis));
    const method = cleanMethod(text(row.therapy));
    return targetPathogenesis && method ? [{ ...row, therapy: method, targetPathogenesis }] : [];
  });
  if (Array.isArray(path.symptomClusters)) path.symptomClusters = records(path.symptomClusters).flatMap((row) => {
    const mechanism = clean(text(row.mechanism));
    return mechanism ? [{ ...row, mechanism }] : [];
  });
  // 已否定的证素不再作为“是否兼X”的待核实项反复出现。
  path.uncertainties = records(path.uncertainties).filter((row) => !mentions(pendingElementText(text(row.item)), false, true));
  return true;
}

export function applyElementSupportDecision(content: string, decision: ClosureDecision | undefined, appendExtractedFindings = true): string {
  if (!decision) return content;
  let root: Json | undefined;
  try { root = object(JSON.parse(content)); } catch { return content; }
  if (!root || !object(root.overview) || !object(root.pathogenesis)) return content;
  let changed = false;
  // 先落实已有红旗与成组危候支持的脱证，随后重读证名再撤回，不能先把脱证的依据当名外阳虚删掉。
  if (decision.collapse && !names(root).some(collapseNamed)) {
    const overview = object(root.overview)!;
    const primary = text(overview.primarySyndrome);
    const row = textbookFormulaRowsForDisease(text(overview.tcmDiseaseName)).find((r) => r.syndromeName === decision.collapse);
    if (row) {
      rename(root, decision.collapse);
      overview.secondarySyndromes = unique([...strings(overview.secondarySyndromes), primary]).slice(0, 6);
    } else overview.secondarySyndromes = [...strings(overview.secondarySyndromes).slice(0, 5), decision.collapse];
    changed = true;
  }
  for (const { unit, verdict } of decision.elements) {
    if (verdict.verdict === "fail") changed = withdraw(root, unit, appendExtractedFindings) || changed;
    else if (verdict.verdict === "pass") changed = promote(root, unit, verdict, decision.context.recordText) || changed;
  }
  // 沿用七条已核对合称（包括其兼证吸收规则），教材方与治法保持原行。
  if (changed && !decision.protectedByPrimary && compositeSyndromeRename(root, decision.context.recordText)) changed = true;
  if (changed) {
    const path = object(root.pathogenesis)!;
    const entailed = entailedElements(names(root));
    path.uncertainties = records(path.uncertainties).filter((row) => ![...typesIn(pendingElementText(text(row.item)), true)].some(([type, organs]) => covered({ type, organs }, entailed)));
  }
  return changed ? JSON.stringify(root) : content;
}

/** P1 keeps the legacy rationale cut as P2's fallback, without appending extracted findings. */
export function withdrawM03RationaleFallback(root: Json, units: readonly LedgerElement[]): void {
  const source = object(root.overview);
  if (!source || typeof source.tcmDiagnosticRationale !== "string") return;
  const draft = { overview: { ...source }, pathogenesis: {} };
  for (const unit of units) withdraw(draft, unit, false);
  source.tcmDiagnosticRationale = draft.overview.tcmDiagnosticRationale;
}
