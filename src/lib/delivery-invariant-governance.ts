import { natureItemDeficiencyOrExcess } from "./nature-column-classification";
import policy from "../data/delivery-facts-policy.source.json";
import natureJson from "../data/tcm-nature-lexicon.json";
import { formulaAnalysisHerbMentions, formulaAnalysisRoleAssignments, reviewAuthoredFormulaAnalysis } from "./formula-analysis-review";
import { compositionIdentityName, originalFormulaFor, originalHerbMatches } from "./tcm-formula-provenance";
import { canonicalWesternDiagnosisName } from "./clinical-terminology";
import { enforceM04PriorStageOwnership } from "./diagnosis-structured-repair";
import { recordAnemiaGrade, recordCkdStage, regradedAnemiaText, regradedCkdStageText } from "./delivered-surface";
import { nationalTreatmentPrinciple } from "./diagnosis-visible-summary";
import { asRecord, asRows, asStrings, asText, pointerToken, stableDeliveryJson } from "./delivery-text";
import type { GovernedElements, GovernedInvariantContext, InvariantScanInput } from "./delivery-invariants";

const AUTHORITY = "delivery-facts-policy.source.json / tcm-nature-lexicon.json";
const aliases = new Map<string, string[]>();
for (const entry of natureJson.entries) {
  if (entry.kind === "eight_principles" || entry.kind === "disharmony") continue;
  for (const label of [entry.canonical, ...entry.aliases]) aliases.set(label, [entry.id]);
}
for (const [label, ids] of Object.entries(policy.elementAliases)) aliases.set(label, ids);
/** Exact controlled labels only. No substring inference (气虚发热 does not become an excess heat element). */
export function governedAxisElements(label: string): GovernedElements {
  const ids = aliases.get(label.trim());
  return { ids: ids || [], complete: Boolean(ids) && !policy.shadowAxisLabels.includes(label.trim()), authority: AUTHORITY };
}
export function governedSyndromeElements(names: string[]): GovernedElements {
  const entries = names.map((name) => (policy.syndromeElements as Record<string, string[]>)[name.trim()] || aliases.get(name.replace(/证$/u, "")));
  const evidence = policy.syndromeElementEvidence as Record<string, { rowId?: string }>;
  const mapped = policy.syndromeElements as Record<string, string[]>;
  return { ids: [...new Set(entries.flatMap((ids) => ids || []))], complete: names.length > 0 && entries.every(Boolean) && !names.some((name) => policy.shadowSyndromes.includes(name)) && names.every((name) => !mapped[name] || Boolean(evidence[name]?.rowId)), authority: AUTHORITY };
}
/** Adapter consumes existing authorities, not a second herb/formula/grade safety lexicon. Scanner stays pure and injectable. */
export function buildDeliveryInvariantGovernance(input: Omit<InvariantScanInput, "governedContext"> & { ageYears?: number; recordText?: string }): GovernedInvariantContext {
  const m03 = asRecord(input.m03);
  const m04 = asRecord(input.m04);
  const final = Object.keys(m03).length ? m03 : m04;
  const overview = asRecord(final.overview);
  const nature = asRecord(asRecord(final.pathogenesis).natureDifferentiation);
  const names = [asText(overview.primarySyndrome), ...asStrings(overview.secondarySyndromes)].filter(Boolean);
  const named = governedSyndromeElements(names);
  const axis: Record<string, GovernedElements> = {};
  for (const label of [...asStrings(nature.items), ...asStrings(nature.rootDeficiency), ...asStrings(nature.branchExcess)]) axis[label] = governedAxisElements(label);
  const elementSides: Record<string, "root" | "branch"> = {};
  for (const entry of natureJson.entries) {
    const side = natureItemDeficiencyOrExcess(entry.canonical);
    if (side) elementSides[entry.id] = side;
  }
  const pending: Record<string, GovernedElements> = {};
  // Pending element IDs must be supplied via reviewed sidecar, never promoted from model JSON.
  const gov: GovernedInvariantContext = { named, axis, elementSides, pending, formulaClaims: [], roleClaims: [], grades: [] };
  const currentPrinciple = asText(asRecord(final.therapy).overallPrinciple);
  // Reuse the project's existing principle policy. This is a quality comparison, never a safety/urgency verdict.
  if (currentPrinciple) {
    const axisProfile = { ...final, overview: { ...overview, primarySyndrome: [...asStrings(nature.rootDeficiency), ...asStrings(nature.branchExcess)].join("、"), secondarySyndromes: [] } };
    const expected = nationalTreatmentPrinciple(currentPrinciple, axisProfile);
    // 「急则治标」是缓急次序（红旗时由交付层置首），不是本虚标实的判断；比较时两边都不算（第四十七轮合并后，
    // nationalTreatmentPrinciple 无红旗上下文时会去掉它，红旗病例就会被误报 R04）。
    const terms = (value: string) => [...new Set(value.split(/[，,、；;]/u).map((term) => term.trim()).filter((term) => term && term !== "急则治标"))].sort().join("|");
    const compatible = terms(expected) === terms(currentPrinciple);
    gov.principle = { compatible, expected, authority: "shadow candidate from final root/branch labels; nationalTreatmentPrinciple governs names, not clinical root/branch priorities", complete: false };
  }
  const candidates = asRows(asRecord(m04.formula).candidates);
  candidates.forEach((candidate, index) => {
    const path = `/m04/formula/candidates/${index}/formulaAnalysis`;
    const analysis = asText(candidate.formulaAnalysis);
    const herbs = asRows(candidate.herbs);
    const currentNames = herbs.map((herb) => asText(herb.name));
    const inCurrent = (name: string) => currentNames.some((other) => compositionIdentityName(name) === compositionIdentityName(other));
    const source = asText(candidate.source) || asText(asRecord(candidate.formulaSource).source);
    const bases = asRows(candidate.baseFormulas);
    const originals = bases.length ? bases.map((base) => originalFormulaFor(asText(base.name), { book: asText(base.source) }))
      : [originalFormulaFor(asText(candidate.name), { book: source })];
    const allOriginalsKnown = originals.length > 0 && originals.every(Boolean);
    const guide = (name: string) => originals.some((entry) => entry?.guides.some((other) => originalHerbMatches(other, name)));
    const foreign = reviewAuthoredFormulaAnalysis(analysis, currentNames).foreignHerbs;
    for (const name of foreign) if (!guide(name)) gov.formulaClaims!.push({ path, quote: name, herb: name, kind: "current", inCurrent: inCurrent(name), complete: true, authority: "formula-analysis-review + compositionIdentityName" });
    const mentions = formulaAnalysisHerbMentions(analysis);
    for (const mention of mentions) {
      const left = Math.max(analysis.lastIndexOf("，", mention.start - 1), analysis.lastIndexOf(",", mention.start - 1), analysis.lastIndexOf("。", mention.start - 1), analysis.lastIndexOf("；", mention.start - 1)) + 1;
      const lead = analysis.slice(left, mention.start);
      // Closed grammatical form, constrained to the same comma clause. No semantic herb inference.
      if (!/去(?:原方)?/u.test(lead)) continue;
      const between = lead.slice(lead.lastIndexOf("去") + 1).replace(/^原方/u, "");
      const priorMentions = mentions.filter((item) => item.start >= left && item.end <= mention.start);
      let remainder = between;
      for (const prior of priorMentions) remainder = remainder.replace(prior.token, "");
      if (remainder.replace(/[、\s]/gu, "")) continue;
      const originalVersions = originals.flatMap((entry) => entry ? [entry.herbs.map((herb) => herb.herb).concat(entry.guides), ...(entry.alternates || []).map((alternate) => entry.herbs.map((herb) => herb.herb).filter((name) => !alternate.remove.includes(name)).concat(alternate.add, entry.guides))] : []);
      const memberships = originalVersions.map((names) => names.some((name) => originalHerbMatches(name, mention.token)));
      const versionKnown = memberships.length > 0 && (originals.length === 1 ? memberships.every((present) => present === memberships[0])
        : originals.every((entry) => !entry?.alternates?.length));
      gov.formulaClaims!.push({ path, quote: analysis.slice(left, mention.end), herb: mention.token, kind: "removed", inCurrent: inCurrent(mention.token), inOriginal: memberships.some(Boolean), complete: Boolean(allOriginalsKnown && versionKnown), authority: allOriginalsKnown ? `originalFormulaFor:${originals.map((entry) => entry!.book).join("+")}; herbs+guides+alternates` : "original identity/version unavailable" });
    }
    for (const sentence of analysis.split(/[。；;！!]/u)) {
      const assignments = formulaAnalysisRoleAssignments(sentence, currentNames);
      for (const [name, assigned] of assignments) {
        const strip = (value: string) => value.replace(/[（(][^）)]*[）)]/gu, "").trim();
        const exact = herbs.find((item) => strip(asText(item.name)) === name);
        const matches = herbs.filter((item) => compositionIdentityName(strip(asText(item.name))) === compositionIdentityName(name));
        const row = exact || (matches.length === 1 ? matches[0] : undefined);
        gov.roleClaims!.push({ path, herb: name, assigned, tableRole: asText(row?.role), complete: Boolean(row), authority: "formulaAnalysisRoleAssignments + final herbs.role (annotation/identity aligned)" });
      }
    }
  });
  if (Object.keys(m03).length && Object.keys(m04).length) {
    const start = "<!-- DIAGNOSIS_JSON_START -->";
    const end = "<!-- DIAGNOSIS_JSON_END -->";
    const projected = enforceM04PriorStageOwnership(`${start}${JSON.stringify(m04)}${end}`, m03);
    const expected = asRecord(JSON.parse(projected.slice(projected.indexOf(start) + start.length, projected.indexOf(end))));
    gov.ownershipExpected = {};
    gov.ownershipShadowPaths = [];
    // Compare the projector's exact differences by leaf. Derived M04 follow-up is observable shadow, not a request to restore M03's dose-free timeline.
    const differences = (locked: unknown, actual: unknown, path: string) => {
      if (stableDeliveryJson(locked) === stableDeliveryJson(actual)) return;
      if (locked && actual && typeof locked === "object" && typeof actual === "object" && Array.isArray(locked) === Array.isArray(actual) && (!Array.isArray(locked) || locked.length === (actual as unknown[]).length)) {
        for (const key of new Set([...Object.keys(locked), ...Object.keys(actual)])) differences((locked as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], `${path}/${pointerToken(key)}`);
        return;
      }
      gov.ownershipExpected![path] = locked;
      if (policy.ownershipProjectionPaths.includes(path) || (path.startsWith("/westernDiagnosis/") && path.endsWith("/name") && typeof locked === "string" && typeof actual === "string" && canonicalWesternDiagnosisName(locked) === canonicalWesternDiagnosisName(actual))) gov.ownershipShadowPaths!.push(path);
    };
    differences(expected, m04, "");
  }
  const recordText = input.recordText || (input.recordIndex?.sources.filter((source) => asRecord(source).role !== "history" && asRecord(source).role !== "mixed").map((source) => source.text).join("\n") || "");
  for (const [stage, root] of [["m03", m03], ["m04", m04]] as const) {
    const actual = asText(asRecord(asRecord(root.westernDiagnosis).primary).name);
    if (!actual) continue;
    const ckd = recordCkdStage(recordText, input.ageYears);
    const anemia = recordAnemiaGrade(recordText, input.ageYears);
    const expected = anemia ? regradedAnemiaText(ckd ? regradedCkdStageText(actual, ckd) : actual, anemia) : ckd ? regradedCkdStageText(actual, ckd) : actual;
    gov.grades!.push({ path: `/${stage}/westernDiagnosis/primary/name`, expected, actual, authority: "recordCkdStage/recordAnemiaGrade + existing scope guards" });
  }
  return gov;
}
