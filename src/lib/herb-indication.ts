import textbookJson from "../data/tcm-herb-textbook-references.json";
import { preciseHerbSourceName } from "./herb-function-display-source";
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";

/**
 * 加减行「本例已见X：加某药」的药是否主治X：《中药学》该药【应用】各条的标题（「2.肝阳上亢，头痛眩晕」）与【功效】是这味药的主治范围
 *（第五十一轮，甲方 11/18 批注后 n8 判错：随症加减 52 份里 14 份是「已见症状行药症不对」——嗳气加苍术、烦躁加枳壳、说话困难加款冬花、
 * 反应弱加酸枣仁；甲方 10.29 点过「头晕目眩加白芍」）。只截教材原文，不改写，交给加减核对的模型判断药症是否对应
 *（字面比对误判太多：536 行里 282 行对不上，伸筋草—屈膝受限、防风—剧痒都算不对）。教材里查不到这味药时返回 undefined。
 */
type Entry = { function?: string; applications?: string; parent?: string };
const HERBS = (textbookJson as unknown as { herbs: Record<string, Entry> }).herbs;
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
