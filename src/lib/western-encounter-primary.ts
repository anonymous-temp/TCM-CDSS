import policy from "../data/western-encounter-primary-policy.source.json";
import { SERVER_LABELED_GROUNDING_LINE, recordMentionPolarityAt } from "./diagnosis-safety";

export function encounterChief(recordText: string): string {
  return /主诉\s*[:：]\s*([^\n]+)/u.exec(recordText)?.[1] || recordText.split("\n").find((line) => line.trim() && !SERVER_LABELED_GROUNDING_LINE.test(line) && !/^患者/u.test(line)) || "";
}

/** 只给关联器授予直接主症；不把慢病的易感因素关系当作本次就诊。 */
export function establishedDiseaseExplainsEncounter(name: string, chief: string): boolean {
  const core = name.replace(/待[查排]$/u, "");
  const entry = policy.entries.find((row) => row.names.includes(core));
  const affirmed = (form: string) => {
    const at = chief.indexOf(form);
    return at >= 0 && recordMentionPolarityAt(chief, at) === "affirmed";
  };
  return (entry?.names || [core]).some(affirmed) || Boolean(entry?.presentations.some(affirmed));
}

/** 兜住旧缓存与模型直接选中的背景慢病。保留其为候选，优先还原已存在的本次问题名。 */
export function settleEncounterPrimary(western: Record<string, unknown>, recordText: string): void {
  const primary = western.primary as Record<string, unknown> | undefined;
  if (!primary || typeof primary.name !== "string") return;
  const core = primary.name.replace(/待[查排]$/u, "");
  if (!policy.entries.some((row) => row.names.includes(core))) return;
  const recordedAt = recordText.indexOf(core.replace(/^[12]型/u, ""));
  const history = establishedHistoryText(core, recordText) || (recordedAt >= 0 && recordMentionPolarityAt(recordText, recordedAt) === "affirmed" ? core : "");
  if (!history.includes(core.replace(/^[12]型/u, "")) || establishedDiseaseExplainsEncounter(core, encounterChief(recordText))) return;
  const chief = encounterChief(recordText);
  const problem = policy.problemNames.find((row) => row.forms.some((form) => chief.includes(form)));
  if (!problem) return; // 没有可追溯的问题名时不另造诊断。
  const candidates = Array.isArray(western.candidates) ? western.candidates as Record<string, unknown>[] : [];
  const selected = candidates.find((row) => typeof row.name === "string" && row.name !== primary.name && !String(row.name).includes(core) && problem.forms.some((form) => String(row.name).includes(form) || (form.startsWith("尿") && String(row.name).includes("尿路感染"))));
  const previous = { name: primary.name, keyEvidence: [history] };
  primary.name = selected?.name || problem.name;
  primary.coding = undefined;
  primary.clinicalRationale = `${chief}为本次就诊问题；既往${core}作为相关背景，仍需结合本次检查鉴别病因。`;
  primary.supportingFacts = [primary.clinicalRationale];
  western.candidates = [{ ...(selected || {}), name: primary.name }, previous, ...candidates.filter((row) => row !== selected && row.name !== previous.name)];
}

/** 无标签的兼容病历也可用明确的多年病史，但不把主诉原词当作既往确诊。 */
export function establishedHistoryText(name: string, recordText: string): string {
  const core = name.replace(/待[查排]$/u, "").replace(new RegExp(`(?:${policy.historySuffixes.join("|")})$`, "u"), "");
  const aliases = policy.entries.find((row) => row.names.includes(core))?.names || [core];
  return recordText.split("\n").filter((line) => aliases.some((alias) => {
    const at = line.indexOf(alias.replace(/^[12]型/u, ""));
    return at >= 0 && recordMentionPolarityAt(line, at) === "affirmed" &&
      (policy.historyMarkers.some((word) => line.includes(word)) || line.split(/[、，,；;]/u).some((item) => item.trim() === alias) || /\d+\s*年/u.test(line.slice(at + alias.replace(/^[12]型/u, "").length, at + alias.length + 12)));
  })).join("。");
}
