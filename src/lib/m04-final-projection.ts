import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { m04FinalContentPolicy } from "./m04-final-content-policy";
import { projectGroundedHerbFunctions } from "./herb-function-display-source";
import { buildFinalM04Snapshot, type FinalSnapshotContext } from "./m04-final-snapshot";
import { renderFinalFormulaAnalysis, validateFinalFormulaAnalysis } from "./m04-final-analysis-validation";
import { asRecord, asRecords, asText, type AnalysisSentence, type FinalM04Snapshot } from "./m04-final-content-types";

/** Reconstruct source-bound sentences from public text. No public flag/sidecar grants trust. */
export function finalAnalysisMatchesSnapshot(text: string, snapshot: FinalM04Snapshot): boolean {
  const drafts: AnalysisSentence[] = [];
  for (const [index, sentence] of (text.match(/[^。！？]+[。！？]/gu) || []).entries()) {
    const comma = sentence.indexOf("，");
    const head = sentence.slice(0, comma);
    const role = head.match(/为([君臣佐使])药$/u)?.[1];
    const names = head.replace(/为[君臣佐使]药$/u, "").split("、");
    const herbs = names.map((name) => snapshot.herbs.find((herb) => herb.name === name));
    if (comma >= 0 && herbs.length && herbs.every(Boolean)) {
      const effects = sentence.slice(comma + 1, -1).split("，");
      drafts.push({ id: `read-${index}`, kind: "herb_group", herbIds: herbs.map((herb) => herb!.id), role,
        sourceIds: herbs.flatMap((herb) => herb!.functionSources.filter((source) => effects.includes(source.text)).map((source) => source.id)),
        targetRefs: [], text: sentence });
    } else {
      const source = snapshot.commentaries.find((source) => ((source.text.match(/[^。！？]+[。！？]/gu) || []) as string[]).includes(sentence));
      if (source) drafts.push({ id: `read-${index}`, kind: "interaction", herbIds: snapshot.herbs.filter((herb) => sentence.includes(herb.name)).map((herb) => herb.id), sourceIds: [source.id], targetRefs: [], text: sentence });
    }
  }
  return renderFinalFormulaAnalysis(snapshot, validateFinalFormulaAnalysis(snapshot, drafts).accepted) === text;
}

/** Pure fallback used by checkpoints, client/HIS projection and pre-authoring contracts. */
export function projectM04FinalFacts<T>(reasoning: T, context?: Partial<FinalSnapshotContext>, forceSummary = false): T {
  const policy = m04FinalContentPolicy();
  if (!policy.enabled || asRecord(reasoning).stage !== "prescribe") return reasoning;
  // F2：功效按本例人群与病历选小句；投影拿得到病历时一并传入，与定稿那一次同一份上下文（拿不到时保守去掉人群专属小句）。
  const result = policy.functions === "on" ? projectGroundedHerbFunctions(reasoning, { recordText: context?.record }) : structuredClone(reasoning);
  if (policy.analysis !== "on") return result;
  const root = asRecord(result);
  const ctx = { record: "", prior: root, ...context };
  asRecords(asRecord(root.formula).candidates).forEach((candidate, candidateIndex) => {
    const snapshot = buildFinalM04Snapshot(result, { ...ctx, candidateIndex });
    const text = asText(candidate.formulaAnalysis);
    if (forceSummary || !finalAnalysisMatchesSnapshot(text, snapshot)) candidate.formulaAnalysis = renderFinalFormulaAnalysis(snapshot, []);
  });
  return result;
}

/** Finite public/compiler name alias; all clinical fields are untouched. */
export function m04FinalContractView(value: ClinicalReasoningResultV2): ClinicalReasoningResultV2 {
  return { ...value, formula: value.formula && { ...value.formula,
    candidates: value.formula.candidates.map((candidate) => candidate.name === "自拟方" && candidate.constructionType === "self_devised" && candidate.formulaNames?.length === 0
      ? { ...candidate, name: "本例辨证组方" } : candidate),
  } };
}
