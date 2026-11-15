import { formulaAnalysisHerbMentions, herbWordReliableInFreeText, mentionInHerbPosition } from "./formula-analysis-review";
import { snapshotFingerprint } from "./m04-final-snapshot";
import { asRecord, asRecords, asText, type AnalysisSentence, type FinalM04Snapshot, type SourceSpan } from "./m04-final-content-types";

export function renderAnalysisSlots(snapshot: FinalM04Snapshot, text: string): string | undefined {
  let invalid = false;
  const rendered = text.replace(/\{herb:([^}]+)\}/gu, (_, id: string) => {
    const herb = snapshot.herbs.find((herb) => herb.id === id);
    if (!herb) invalid = true;
    return herb?.name || "";
  });
  return invalid || /[{}]/u.test(rendered) ? undefined : rendered;
}
function sourcesFor(snapshot: FinalM04Snapshot): SourceSpan[] {
  return [...snapshot.herbs.flatMap((herb) => herb.functionSources), ...snapshot.commentaries];
}
/** The initial version deliberately accepts a narrow, executable source grammar.
 * An unproved free interaction is discarded as a sentence, never edited into a new claim. */
export function groundedHerbGroupText(snapshot: FinalM04Snapshot, ids: readonly string[], role: string | undefined, sourceIds: readonly string[]): string | undefined {
  const herbs = ids.map((id) => snapshot.herbs.find((herb) => herb.id === id));
  if (!ids.length || new Set(ids).size !== ids.length || herbs.some((herb) => !herb || role && role !== herb.role)) return undefined;
  const sources = sourceIds.map((id) => sourcesFor(snapshot).find((source) => source.id === id));
  if (!sources.length || sources.some((source) => !source || !herbs.some((herb) => herb!.name === source.herbKey))) return undefined;
  const effects = [...new Set(sources.map((source) => source!.text))];
  // A group cannot give herb A a function sourced only to herb B.
  if (effects.some((effect) => herbs.some((herb) => !herb!.functionSources.some((source) => source.text === effect && sourceIds.includes(source.id))))) return undefined;
  return `${herbs.map((herb) => herb!.name).join("、")}${role ? `为${role}药` : ""}，${effects.join("，")}。`;
}

export function validateFinalFormulaAnalysis(snapshot: FinalM04Snapshot, draft: unknown): {
  accepted: readonly AnalysisSentence[]; violations: readonly { sentenceId: string; code: string }[];
} {
  const accepted: AnalysisSentence[] = [], violations: { sentenceId: string; code: string }[] = [];
  const container = asRecord(draft);
  const rows = Array.isArray(draft) ? asRecords(draft) : asRecords(container.sentences);
  const snapshotValid = snapshotFingerprint(snapshot) === snapshot.fingerprint;
  const seen = new Set<string>();
  for (const row of rows.slice(0, 40)) {
    const id = asText(row.id);
    const reject = (code: string) => violations.push({ sentenceId: id, code });
    if (!snapshotValid || container.fingerprint !== undefined && container.fingerprint !== snapshot.fingerprint) { reject("stale_snapshot"); continue; }
    if (!id || seen.has(id)) { reject("duplicate_sentence_id"); continue; }
    seen.add(id);
    const ids = Array.isArray(row.herbIds) ? row.herbIds.filter((id): id is string => typeof id === "string") : [];
    const sourceIds = Array.isArray(row.sourceIds) ? row.sourceIds.filter((id): id is string => typeof id === "string") : [];
    const targetRefs = Array.isArray(row.targetRefs) ? row.targetRefs.filter((id): id is string => typeof id === "string") : [];
    const herbs = ids.map((id) => snapshot.herbs.find((herb) => herb.id === id));
    if (!ids.length || new Set(ids).size !== ids.length || herbs.some((herb) => !herb) || targetRefs.some((ref) => !herbs.some((herb) => herb!.targetRef === ref))) { reject("outside_herb_table"); continue; }
    const text = renderAnalysisSlots(snapshot, asText(row.text));
    if (!text || text.length > 1200) { reject("invalid_slots"); continue; }
    const mentions = formulaAnalysisHerbMentions(text).filter((mention) => herbWordReliableInFreeText(mention.token) && mentionInHerbPosition(text, mention.start));
    if (mentions.some((mention) => !herbs.some((herb) => herb!.name === mention.token))) { reject("foreign_herb_in_text"); continue; }
    if (row.count !== undefined && row.count !== ids.length) { reject("count_mismatch"); continue; }
    const role = asText(row.role) || undefined;
    if (role && herbs.some((herb) => herb!.role !== role)) { reject("role_mismatch"); continue; }
    let supported = false;
    if (row.kind === "herb_group") supported = text === groundedHerbGroupText(snapshot, ids, role, sourceIds);
    if (row.kind === "interaction") {
      // Exact full commentary sentences only, from the resolved formula, with no missing partner.
      const source = snapshot.commentaries.find((source) => sourceIds.length === 1 && source.id === sourceIds[0]);
      const complete: string[] = source?.text.match(/[^。！？]+[。！？]/gu) || [];
      const allMentions = formulaAnalysisHerbMentions(text);
      const matchesRoles = allMentions.every((mention) => {
        const herb = snapshot.herbs.find((herb) => herb.name === mention.token);
        const after = text.slice(mention.end).match(/^[^。；，]{0,8}为([君臣佐使])/u)?.[1];
        return herb && (!after || after === herb.role);
      });
      // Group roles in commentary are accepted only when the source itself has no role
      // words: group-role prose requires stronger parsing, so conservatively defer it.
      supported = Boolean(source && complete.includes(text) && matchesRoles && !/[君臣佐使]/u.test(text) &&
        allMentions.length > 0 && allMentions.every((mention) => herbs.some((herb) => herb!.name === mention.token)));
    }
    if (!supported) { reject("unsupported_sentence"); continue; }
    accepted.push({ id, kind: row.kind as AnalysisSentence["kind"], herbIds: ids, role, sourceIds, targetRefs, text, ...(row.count !== undefined ? { count: ids.length } : {}) });
  }
  return { accepted, violations };
}

export function renderFinalFormulaAnalysis(snapshot: FinalM04Snapshot, sentences: readonly AnalysisSentence[]): string {
  const { accepted } = validateFinalFormulaAnalysis(snapshot, sentences);
  // 开头跟交付的方名走：方名是成方（含「X加减」）就不写「本方为自拟方」（第四十七轮复核：方名「八正散加减」、方义却说自拟方）。
  const selfDevised = (snapshot.constructionType === "self_devised" || snapshot.delta.status === "self_devised") && /自拟/u.test(snapshot.name || "自拟");
  const opening = selfDevised ? "本方为自拟方。" : `本方为${snapshot.name}。`;
  // 同一首原方的加、去合成一句；药名相同的「原方写作陈皮，本方用陈皮」不写（复核：读不通）。
  const grouped = new Map<string, { prefix: string; added: string[]; removed: string[]; other: string[] }>();
  if (snapshot.delta.status === "known") for (const change of snapshot.delta.changes) {
    const base = snapshot.delta.bases.find((base) => base.key === change.baseKey);
    const prefix = base ? `较《${base.book}》${base.name}原方` : "较所参照原方";
    const group = grouped.get(prefix) || { prefix, added: [], removed: [], other: [] };
    grouped.set(prefix, group);
    if (change.kind === "added" && change.to) group.added.push(change.to);
    else if (change.kind === "removed" && change.from) group.removed.push(change.from);
    else if (change.kind === "substituted") group.other.push(`以${change.to}替代${change.from}`);
    else if (change.kind === "preparation_changed" && change.from && change.to && change.from !== change.to) group.other.push(`原方用${change.from}，本方用${change.to}`);
    else if (change.kind === "guide_omitted") group.other.push(`原方药引${change.from}本方未列`);
    else if (change.guideLocation === "modification") group.other.push(`原方药引${change.from}列于随证加减`);
  }
  const changes = [...grouped.values()].flatMap((group) => {
    const parts = [
      ...(group.added.length ? [`加${[...new Set(group.added)].join("、")}`] : []),
      ...(group.removed.length ? [`去${[...new Set(group.removed)].join("、")}`] : []),
      ...[...new Set(group.other)],
    ];
    return parts.length ? [`${group.prefix}${parts.join("，")}。`] : [];
  });
  const explained = new Set(accepted.flatMap((sentence) => sentence.herbIds));
  const facts = snapshot.herbs.filter((herb) => !explained.has(herb.id)).flatMap((herb) => {
    const selected = herb.functionSources.filter((source) => herb.functionText.includes(source.text));
    const text = groundedHerbGroupText(snapshot, [herb.id], herb.role || undefined, selected.map((source) => source.id));
    return text ? [text] : [];
  });
  return [opening, ...changes, ...accepted.map((sentence) => sentence.text), ...facts].join("");
}
