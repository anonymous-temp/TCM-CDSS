import textbookJson from "../data/tcm-herb-textbook-references.json";
import chiefConcepts from "../data/tcm-differential-chief-concepts.source.json" with { type: "json" };
import relevance from "../data/tcm-modification-relevance.source.json";
import { preciseHerbSourceName } from "./herb-function-display-source";
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";

/**
 * 加减行「本例已见X：加某药」的药是否主治X：《中药学》该药【应用】各条的标题（「2.肝阳上亢，头痛眩晕」）与【功效】是这味药的主治范围
 *（第五十一轮，甲方 11/18 批注后 n8 判错：随症加减 52 份里 14 份是「已见症状行药症不对」——嗳气加苍术、烦躁加枳壳、说话困难加款冬花、
 * 反应弱加酸枣仁；甲方 10.29 点过「头晕目眩加白芍」）。只截教材原文，不改写；同一表现的不同写法按受治理的症状概念组
 *（tcm-differential-chief-concepts、tcm-modification-relevance 同义组）认。教材里查不到这味药时不下结论（返回 undefined）。
 */
type Entry = { function?: string; applications?: string; parent?: string };
const HERBS = (textbookJson as unknown as { herbs: Record<string, Entry> }).herbs;
const GROUPS: string[][] = [
  ...(chiefConcepts as { concepts: Array<{ forms: string[] }> }).concepts.map((group) => group.forms),
  ...Object.entries((relevance as { equivalents: Record<string, string[]> }).equivalents).map(([term, group]) => [term, ...group]),
].map((group) => group.filter((form) => typeof form === "string" && form.length >= 2));
// 两字片段比对时不算数的泛词（「明显」「减少」本身不是表现）。
const GENERIC_BIGRAMS = new Set(["明显", "偶有", "时有", "较前", "减少", "增多", "不适", "加重", "反复", "有时", "稍有", "略有", "伴有", "出现", "本例", "已见"]);

const cache = new Map<string, string | null>();
export function herbIndicationText(herbName: string): string | undefined {
  const name = String(herbName || "").trim();
  if (!name) return undefined;
  if (cache.has(name)) return cache.get(name) ?? undefined;
  let key = preciseHerbSourceName(name);
  if (!key || !HERBS[key]) {
    const canonical = resolveGovernedTcmHerbIdentity(name).canonicalName;
    key = canonical && HERBS[canonical] ? canonical : undefined;
  }
  const entry = key ? HERBS[key] : undefined;
  const parent = entry?.parent ? HERBS[entry.parent] : undefined;
  const applications = entry?.applications || parent?.applications || "";
  const titles = applications.split("\n").map((paragraph) => paragraph.trim()).filter(Boolean)
    .map((paragraph) => paragraph.replace(/^\d+\s*[.．、]\s*/u, "").split(/[　。]/u)[0].trim());
  const text = entry ? [entry.function || parent?.function || "", ...titles].filter(Boolean).join("；") : "";
  cache.set(name, text || null);
  return text || undefined;
}

export function herbIndicatedForFindingTerms(herbName: string, terms: readonly string[]): boolean | undefined {
  const text = herbIndicationText(herbName);
  if (!text) return undefined;
  const wanted = terms.map((term) => String(term || "").trim()).filter((term) => term.length >= 2);
  if (wanted.length === 0) return undefined;
  for (const term of wanted) {
    if (text.includes(term)) return true;
    for (const group of GROUPS) {
      if (group.some((form) => term.includes(form) || (form.includes(term) && term.length >= 2)) && group.some((form) => text.includes(form))) return true;
    }
    for (let at = 0; at + 2 <= term.length; at += 1) {
      const bigram = term.slice(at, at + 2);
      if (/^[一-鿿]{2}$/u.test(bigram) && !GENERIC_BIGRAMS.has(bigram) && text.includes(bigram)) return true;
    }
  }
  return false;
}
