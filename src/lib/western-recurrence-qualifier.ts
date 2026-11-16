import policy from "../data/western-recurrence-qualifier.source.json";
import { clauseLocalMentionPolarityAt } from "./diagnosis-safety";

/** 复发限定须有同病复发记录。缺病史保留较宽病名，待查后缀不动，不把缺病史当作已否认。 */
export function settleWesternRecurrenceQualifier(name: string, basis: string, recordText: string): { name: string; basis: string } {
  const core = name.replace(/待[查排]$/u, "");
  const row = policy.rows.find((entry) => entry.names.includes(core));
  if (!row || !recordText) return { name, basis };
  const first = new RegExp(policy.firstEpisodePattern, "u");
  const connector = new RegExp(policy.recurrenceConnectorPattern, "u");
  const clauses = recordText.normalize("NFKC").split(/[，,。；;\n]/u);
  if ("requiresExplicitFirstEpisode" in row && row.requiresExplicitFirstEpisode && !clauses.some((clause) =>
    first.test(clause) && row.recordNames.some((term) => clause.includes(term)))) return { name, basis };
  const recurrenceClaim = (clause: string, requireAffirmed: boolean) => {
    return policy.recurrenceMarkers.some((marker) => {
      for (let at = clause.indexOf(marker); at >= 0; at = clause.indexOf(marker, at + marker.length)) {
        if (requireAffirmed && clauseLocalMentionPolarityAt(clause, at) !== "affirmed") continue;
        if (row.recordNames.some((term) => {
          const position = clause.indexOf(term);
          const gap = position < at ? clause.slice(position + term.length, at) : clause.slice(at + marker.length, position);
          return position >= 0 && Math.abs(position - at) <= policy.spanLimit && connector.test(gap);
        })) return true;
      }
      return false;
    });
  };
  const recurrent = clauses.some((clause) => {
    if (first.test(clause)) return false;
    return recurrenceClaim(clause, true);
  });
  if (recurrent) return { name, basis };
  // 含有无据复发限定的完整断言不交付；其它患者事实和鉴别要求保留。
  const kept = basis.split(/([，,。；;])/u).flatMap((clause, at, parts) => at % 2 || !clause.trim() ||
    row.names.some((term) => clause.includes(term)) || recurrenceClaim(clause, false)
    ? [] : [clause + (parts[at + 1] || "")]).join("").replace(/[，,；;]+。/gu, "。").replace(/[，,；;]+$/u, "");
  return { name: row.fallback + name.slice(core.length), basis: kept };
}
