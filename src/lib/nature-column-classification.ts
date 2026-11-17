import natureJson from "../data/tcm-nature-lexicon.json";
import policy from "../data/pathogenesis-columns.source.json";

const ROOT = new RegExp(policy.classification.rootPattern, "u");
const BRANCH = new RegExp(policy.classification.branchPattern, "u");
const EMPTY = new Set(policy.classification.emptyLabels);
const entries = natureJson.entries;
const STANDALONE = new Set([...policy.classification.standaloneLabels, ...entries.flatMap((entry) => [entry.canonical, ...entry.aliases])]);
export function natureItemDeficiencyOrExcess(item: string): "root" | "branch" | undefined {
  const value = String(item || "").normalize("NFKC").trim();
  if (!value || EMPTY.has(value)) return undefined;
  if (ROOT.test(value) || policy.classification.rootExactNames.includes(value)) return "root";
  const hits = entries.filter((entry) => [entry.canonical, ...entry.aliases].some((name) => value.includes(name)))
    .sort((a, b) => b.canonical.length - a.canonical.length);
  if (hits.some((entry) => entry.kind === "deficiency" || policy.classification.rootIds.includes(entry.id))) return "root";
  return BRANCH.test(value) || hits.some((entry) => policy.classification.branchKinds.includes(entry.kind)) ? "branch" : undefined;
}

/** Preserve authored labels, including column-only labels; move every recognized item to its governed side. */
export function classifyNatureColumns(nature: Record<string, unknown>): void {
  const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()) && !EMPTY.has(item.trim())).map((item) => item.trim()) : [];
  const authoredItems = list(nature.items);
  const roots = list(nature.rootDeficiency), branches = list(nature.branchExcess);
  const columns = [...roots, ...branches];
  const items = [...new Set([...authoredItems, ...columns])];
  // A detailed column phrase (风寒外束) may cover an item (寒); it must not become a mechanism sentence in items.
  nature.items = [...new Set([...authoredItems, ...columns.filter((item) => STANDALONE.has(item))])];
  nature.rootDeficiency = [...new Set([...roots.filter((item) => natureItemDeficiencyOrExcess(item) === "root"), ...items.filter((item) => natureItemDeficiencyOrExcess(item) === "root")])].filter((item, _, all) => !all.some((other) => other !== item && other.includes(item)));
  nature.branchExcess = [...new Set([...branches.filter((item) => natureItemDeficiencyOrExcess(item) === "branch"), ...items.filter((item) => natureItemDeficiencyOrExcess(item) === "branch")])].filter((item, _, all) => !all.some((other) => other !== item && other.includes(item)));
}
