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

const MECHANISM_ITEM = new RegExp(policy.classification.mechanismItemPattern, "u");
const EXTERIOR_ITEM = new RegExp(policy.classification.exteriorPathogenPattern, "u");
const EXTERIOR_SYNDROME_NAME = new RegExp(policy.classification.exteriorSyndromeNamePattern, "u");
const EXTERIOR_LABEL: string = policy.classification.exteriorPathogenLabel;
const ELEMENT_KINDS = new Set<string>([...policy.classification.branchKinds, "deficiency"]);

/**
 * 病性栏里写成机理句的条目换成它所含的病性词（第五十九轮，r1077 百例阅卷「病性栏写的不是病性、标实为无」）：
 * 「外邪袭表」「外邪犯胃」「外感」→「外邪」；「湿郁化热」→「湿」「热」；规范病性词与本虚类短语不动。
 * 认不出病性词的机理句（「心神不宁」）：栏里还有别的条目时去掉，否则原样留着，不让病性栏变空。
 */
export function natureItemsWithoutMechanismPhrases(items: readonly string[]): string[] {
  const out: string[] = [];
  const unrecognized: string[] = [];
  const push = (value: string) => { if (value && !out.includes(value)) out.push(value); };
  for (const raw of items) {
    const item = String(raw || "").normalize("NFKC").trim();
    if (!item) continue;
    if (STANDALONE.has(item) || !MECHANISM_ITEM.test(item)) { push(item); continue; }
    if (EXTERIOR_ITEM.test(item)) { push(EXTERIOR_LABEL); continue; }
    const labels = entries.filter((entry) => ELEMENT_KINDS.has(entry.kind) && [entry.canonical, ...entry.aliases].some((name) => item.includes(name)))
      .map((entry) => entry.canonical).filter((label, _, all) => !all.some((other) => other !== label && other.includes(label)));
    if (labels.length > 0) { labels.forEach(push); continue; }
    // 病性词表认不出、但句子本身就是一种气机失常的（「肺气上逆」「胃气上逆」）：按闭集写成对应的病性词（气逆）。
    // 第五十九轮生产重测 R025：病性栏只有「肺气上逆」，本虚、标实两栏都是空的。
    const mapped = (policy.classification.mechanismItemLabels as Array<{ pattern: string; label: string }>).find((row) => new RegExp(row.pattern, "u").test(item));
    if (mapped) push(mapped.label); else unrecognized.push(item);
  }
  // 已有具体的邪气（风、寒、湿、热…）时不再并列笼统的「外邪」。
  const specific = out.filter((item) => item !== EXTERIOR_LABEL && natureItemDeficiencyOrExcess(item) === "branch");
  const settled = specific.length > 0 ? out.filter((item) => item !== EXTERIOR_LABEL) : out;
  return settled.length > 0 ? settled : unrecognized;
}

/** 证名自带、病性栏却没有的病性词（证名寒湿而病性只列湿；兼证肺脾气虚而本虚为无）。existing 是病性栏现有的全部条目。 */
export function natureLabelsNamedBySyndromeMissingFrom(syndromeNames: string, existing: readonly string[]): string[] {
  const names = String(syndromeNames || "").normalize("NFKC");
  const out: string[] = [];
  for (const row of policy.classification.syndromeNameNatureElements as Array<{ chars: string[]; label: string; deficiencyContextPattern?: string; deficiencyLabel?: string }>) {
    if (!row.chars.some((char) => names.includes(char))) continue;
    if (existing.some((item) => row.chars.some((char) => item.includes(char)))) continue;
    out.push(row.deficiencyContextPattern && row.deficiencyLabel && new RegExp(row.deficiencyContextPattern, "u").test(names) ? row.deficiencyLabel : row.label);
  }
  return out;
}

/** 证名是外感表证而没有点名风寒湿热的（外邪犯肺证、外感表证）：病性栏为空时按「外邪」写。 */
export function exteriorSyndromeNatureLabel(syndromeNames: string): string | undefined {
  return EXTERIOR_SYNDROME_NAME.test(String(syndromeNames || "")) ? EXTERIOR_LABEL : undefined;
}

/** 证名自带、病位栏却没有的脏腑（证名脾肾阳虚而病位只列脾、肠）。 */
export function organsNamedBySyndromeMissingFrom(syndromeNames: string, existing: readonly string[]): string[] {
  const names = String(syndromeNames || "").normalize("NFKC");
  return (policy.classification.syndromeNameOrgans as string[]).filter((organ) => names.includes(organ) && !existing.some((item) => item.includes(organ)));
}

/** Resolve a bare temperature label only when the authored mechanism qualifies it and no named syndrome requires an independent pathogen. */
export function qualifyDeficiencyTemperature(nature: Record<string, unknown>, syndrome: string, mechanism: string): void {
  const roots = Array.isArray(nature.rootDeficiency) ? nature.rootDeficiency : [];
  const branches = Array.isArray(nature.branchExcess) ? nature.branchExcess : [];
  for (const row of policy.classification.syndromeNameNatureElements) {
    if (!row.deficiencyLabel || !row.deficiencyContextPattern || !roots.length) continue;
    const virtual = row.deficiencyLabel;
    const qualifier = new RegExp(row.deficiencyContextPattern, "u");
    const forms = policy.nonExcessForms.filter(form => row.chars.some(char => form.includes(char)) && qualifier.test(form));
    const explains = [mechanism, ...roots.filter((label): label is string => typeof label === "string")].some(source => source.split(/[。；，、]/u).some(clause =>
      !new RegExp(policy.assertionModalityPattern, "u").test(clause) && forms.some(form => clause.includes(form))));
    const otherNamed = syndrome.split("、").some(name => row.chars.some(char => name.includes(char)) && !qualifier.test(name));
    if (!explains || otherNamed) continue;
    const generic = branches.filter(label => typeof label === "string" && [...label].every(char => row.chars.includes(char)));
    if (!generic.length) continue;
    nature.branchExcess = (nature.branchExcess as unknown[]).filter(label => !generic.includes(label));
    nature.items = [...new Set([...(Array.isArray(nature.items) ? nature.items : []).filter(label => !generic.includes(label)), virtual])];
    classifyNatureColumns(nature);
  }
}
