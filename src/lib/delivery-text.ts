import policy from "../data/delivery-facts-policy.source.json";

export type DeliveryJson = Record<string, unknown>;
export const asRecord = (value: unknown): DeliveryJson => value && typeof value === "object" && !Array.isArray(value) ? value as DeliveryJson : {};
export const asText = (value: unknown): string => typeof value === "string" ? value : "";
export const asRows = (value: unknown): DeliveryJson[] => Array.isArray(value) ? value.map(asRecord) : [];
export const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
export const pointerToken = (key: string) => key.replace(/~/gu, "~0").replace(/\//gu, "~1");
export const pointerParts = (path: string) => path.split("/").slice(1).map((key) => key.replace(/~1/gu, "/").replace(/~0/gu, "~"));
export function pointerValue(root: unknown, path: string): unknown {
  return pointerParts(path).reduce<unknown>((value, key) => value && typeof value === "object" ? (value as DeliveryJson)[key] : undefined, root);
}
export function stableDeliveryJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableDeliveryJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableDeliveryJson((value as DeliveryJson)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export type DeliveryTextRole = "clinical_narrative" | "verbatim_record" | "source_citation" | "machine" | "deterministic_safety";
export type TextOccurrence = { path: string; occurrenceId: string; text: string; role: DeliveryTextRole; scope: "mixed" };
/** Unknown fields are narrative by default. Exemptions are explicit schema roles, never a patient-word regex. */
export function collectDeliveryText(root: unknown, base = ""): TextOccurrence[] {
  const out: TextOccurrence[] = [];
  const visit = (value: unknown, path: string, inherited?: DeliveryTextRole) => {
    if (typeof value === "string") {
      out.push({ path, occurrenceId: path, text: value, role: inherited || "clinical_narrative", scope: "mixed" });
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}/${index}`, inherited));
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      const role = inherited || (policy.machineTrees.includes(key) || policy.machineKeys.includes(key) || policy.lockedKeys.includes(key) || (key === "name" && /\/(?:herbs|primary|differentials|candidates)\/?.*$/u.test(path)) ? "machine"
        : policy.safetyTrees.includes(key) ? "deterministic_safety"
        : policy.verbatimKeys.includes(key) ? "verbatim_record"
        : policy.sourceKeys.includes(key) ? "source_citation" : undefined);
      visit(item, `${path}/${pointerToken(key)}`, role);
    }
  };
  visit(root, base);
  return out;
}
export type DeliveryTextCut = { path: string; occurrenceId: string; before: string; start: number; end: number; quote: string; reason: string };
/** Complete sentence boundaries preserve subject/negation scope. No new words and no before-text restoration. */
export function sentenceRange(text: string, start: number, end: number): [number, number] {
  let left = start;
  let right = end;
  while (left > 0 && !/[。！？!?；;\n]/u.test(text[left - 1])) left -= 1;
  while (right < text.length && !/[。！？!?；;\n]/u.test(text[right - 1])) right += 1;
  return [left, right];
}
export function applyDeliveryTextCuts<T>(root: T, cuts: readonly DeliveryTextCut[]): { value: T; applied: number; stale: number } {
  const value = structuredClone(root);
  let applied = 0;
  let stale = 0;
  const groups = new Map<string, DeliveryTextCut[]>();
  const roles = new Map(collectDeliveryText(root).map((entry) => [entry.path, entry.role]));
  for (const cut of cuts) {
    if (roles.get(cut.path) !== "clinical_narrative" || pointerValue(root, cut.path) !== cut.before || cut.start < 0 || cut.end <= cut.start || cut.end > cut.before.length || cut.before.slice(cut.start, cut.end) !== cut.quote) { stale += 1; continue; }
    groups.set(cut.path, [...(groups.get(cut.path) || []), cut]);
  }
  for (const [path, entries] of groups) {
    const original = entries[0].before;
    const ranges = entries.map((cut) => [cut.start, cut.end]).sort((a, b) => a[0] - b[0]);
    const merged: number[][] = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    let next = original;
    for (const [start, end] of merged.reverse()) next = next.slice(0, start) + next.slice(end);
    const parts = pointerParts(path);
    const key = parts.pop();
    const parent = parts.reduce<unknown>((node, part) => (node as DeliveryJson)[part], value);
    if (key !== undefined && parent && typeof parent === "object") { (parent as DeliveryJson)[key] = next; applied += entries.length; }
  }
  return { value, applied, stale };
}
