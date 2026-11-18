import "server-only";
import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import {
  findUnsupportedM03ElementAssertions, m03ElementContext, selectedElementRow,
  type ElementAssertion,
} from "./m03-element-assertions";
import { textbookRowForSyndrome, type TextbookCaseInput } from "./tcm-textbook-syndromes";
import { recordedFindingReading } from "./diagnosis-safety";
import rules from "../data/m03-final-rationale-policy.source.json";

const { diseasePathogens, directConsequences, rowSupportedConsequences, exterior } = rules.elementAllowances;

export function finalRationaleElementContext(root: ClinicalReasoningResultV2, input: TextbookCaseInput = {}) {
  const source = root as unknown as Record<string, unknown>;
  const diagnosis = m03ElementContext(source);
  const row = selectedElementRow(m03ElementContext(source,
    textbookRowForSyndrome(diagnosis.disease, diagnosis.primarySyndrome, input)));
  return { diagnosis: m03ElementContext(source, row), row };
}

export function unsupportedRationaleElements(prose: string, context: ReturnType<typeof finalRationaleElementContext>, recordText = ""): ElementAssertion[] {
  const { diagnosis } = context;
  const names = [diagnosis.primarySyndrome, ...diagnosis.secondarySyndromes];
  const named = (markers: readonly string[]) => names.some((name) => markers.some((marker) => name.includes(marker)));
  const consequences = [...directConsequences, ...rowSupportedConsequences.filter((row) => {
    if (!context.row) return false;
    if (row.inspectionMarkers) return row.inspectionMarkers.some((marker) => context.row?.tongue.includes(marker));
    return row.manifestationMarkers?.some((marker) => context.row?.manifestations.includes(marker)) &&
      row.recordMarkers?.some((marker) => recordedFindingReading(recordText, marker) === "affirmed");
  })];
  return findUnsupportedM03ElementAssertions(diagnosis, prose).filter((hit) => {
    // A disease title licenses its own pathogen, with no added organ attribution.
    if (!hit.organ && Object.entries(diseasePathogens).some(([marker, types]) => diagnosis.disease.includes(marker) && types.includes(hit.type))) return false;
    // The allowance covers this occurrence of the consequence only.
    if (consequences.some(({ nameMarkers, types, forms }) => named(nameMarkers) && types.includes(hit.type) &&
      forms.some((form) => {
        const start = prose.lastIndexOf(form, hit.start);
        return start >= hit.clauseStart && start + form.length >= hit.end;
      }))) return false;
    // Scope the pathogen to the stated exterior sites and the matching named wind-cold/heat pattern.
    if (hit.organ && exterior.sites.includes(hit.organ) && exterior.types.includes(hit.type) && named(exterior.nameMarkers) &&
      exterior.pathogens.some((pathogen) => named([pathogen]) && (hit.phrase.includes(pathogen) ||
        (hit.start > hit.clauseStart && prose.startsWith(pathogen, hit.start - 1)) ||
        prose.startsWith(pathogen, hit.start)))) return false;
    return true;
  });
}
