import { compositionIdentityName } from "./tcm-formula-provenance";
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";
import textbookReferencesJson from "../data/tcm-herb-textbook-references.json";

/**
 * 《中药学》（十三五规划教材）各味正文按药名找（2026-10-19）。两处要用：
 *  · 判「是不是同一味药」：组成身份名把炮制品并到原药（炙黄芪＝黄芪、法半夏＝半夏），但教材分立成两味的不能并——
 *    生地黄在清热凉血药、熟地黄在补血药（patent-medicine-duplication 判中成药与汤剂重复、herb-record-caution 判是否原方药味）；
 *  · 取这味药的【使用注意】（herb-record-caution）与【用法用量】（herb-decoction-rules 核对特殊煎法标注）；
 *  · 方义里的药名与药味表写法不一（鹿胶珠／鹿角胶）时判是不是同一味（formula-analysis-review）。
 * 数据 tcm-herb-textbook-references.json 由 scripts/build-herb-textbook-references.py 从本地教材语料生成。
 */

type TextbookHerbEntry = {
  function?: string; line?: number; parent?: string | null;
  caution?: string; cautionLine?: number; usage?: string; usageLine?: number;
};

const HERBS = ((textbookReferencesJson as { herbs?: Record<string, TextbookHerbEntry> }).herbs || {});

/** 药典名（饮片用量所依的正名）：生地黄→地黄、酒大黄→大黄、熟地黄仍是熟地黄。 */
function pharmacopoeiaFormName(name: string): string {
  const resolved = resolveGovernedTcmHerbIdentity(name);
  return resolved.doseCanonicalName || resolved.canonicalName || name;
}

let index: { byForm: Map<string, string>; split: Set<string> } | undefined;
/** 正文（不含附药）按药典名索引；组成身份相同、教材却分立几味的组成身份（生地黄与熟地黄）。不另列药名。 */
function monographIndex(): { byForm: Map<string, string>; split: Set<string> } {
  if (index) return index;
  const byForm = new Map<string, string>();
  const monographsByIdentity = new Map<string, Set<string>>();
  for (const [name, entry] of Object.entries(HERBS)) {
    if (entry?.parent) continue;
    const form = pharmacopoeiaFormName(name);
    if (!byForm.has(form)) byForm.set(form, name);
    const identity = compositionIdentityName(name);
    if (!identity) continue;
    const group = monographsByIdentity.get(identity) || new Set<string>();
    group.add(name);
    monographsByIdentity.set(identity, group);
  }
  index = {
    byForm,
    split: new Set([...monographsByIdentity].filter(([, group]) => group.size > 1).map(([identity]) => identity)),
  };
  return index;
}

function clean(name: string): string {
  return String(name || "").normalize("NFKC").replace(/\s+/g, "").replace(/[（(][^）)]*[）)]/g, "");
}

/** 这味药在教材里的正文名（「熟地」→熟地黄、「地黄」「干地黄」→生地黄、「酒当归」→当归）；教材没有单列时为 undefined。 */
export function textbookMonographName(name: string): string | undefined {
  const value = clean(name);
  if (!value) return undefined;
  const direct = HERBS[value];
  if (direct && !direct.parent) return value;
  const { byForm } = monographIndex();
  const byPharmacopoeia = byForm.get(pharmacopoeiaFormName(value));
  if (byPharmacopoeia) return byPharmacopoeia;
  const identity = compositionIdentityName(value);
  if (identity && !monographIndex().split.has(identity)) {
    const byIdentity = byForm.get(pharmacopoeiaFormName(identity)) || (HERBS[identity] && !HERBS[identity].parent ? identity : undefined);
    if (byIdentity) return byIdentity;
  }
  return undefined;
}

/** 判「同一味药」用的键：组成身份名；教材把同一组成身份分成几味时，再按教材那一味区分。 */
export function textbookDistinctHerbKey(name: string): string {
  const value = clean(name);
  const identity = compositionIdentityName(value);
  if (!identity) return "";
  if (!monographIndex().split.has(identity)) return identity;
  return `${identity}|${monographIndex().byForm.get(pharmacopoeiaFormName(value)) || ""}`;
}

/** 教材【使用注意】原文与行号（语料行号从 1 起）。 */
export function textbookHerbCaution(name: string): { herb: string; text: string; line?: number } | undefined {
  const monograph = textbookMonographName(name);
  const entry = monograph ? HERBS[monograph] : undefined;
  return monograph && entry?.caution ? { herb: monograph, text: entry.caution, line: entry.cautionLine } : undefined;
}

/** 教材里写了【使用注意】的正文药名。 */
export function textbookHerbsWithCaution(): string[] {
  return Object.entries(HERBS).filter(([, entry]) => !entry?.parent && Boolean(entry?.caution)).map(([name]) => name);
}

/**
 * 这味药在教材里单列的那一条（正文或附药）：本名就有条目的取本名（茯神是茯苓的附药，单列），否则取药典正名的条目
 *（鹿胶珠→鹿角胶，附药），再否则取正文（熟地→熟地黄）。都没有时为 undefined。
 */
export function textbookEntryName(name: string): string | undefined {
  const value = clean(name);
  if (!value) return undefined;
  if (HERBS[value]) return value;
  const resolved = resolveGovernedTcmHerbIdentity(value);
  for (const candidate of [resolved.canonicalName, resolved.doseCanonicalName]) {
    if (candidate && HERBS[candidate]) return candidate;
  }
  return textbookMonographName(value);
}

/**
 * 教材【用法用量】（附药取功能之后的用法句，龙齿「煎服，15～30g，先煎」）。教材没有这味药、或附药没有自己的用法句时为 undefined
 *（不借所附正药的：鹿角胶附在鹿茸下，鹿茸是「研末冲服」）。
 */
export function textbookHerbUsage(name: string): { herb: string; text: string; line?: number } | undefined {
  const entryName = textbookEntryName(name);
  const entry = entryName ? HERBS[entryName] : undefined;
  return entryName && entry?.usage ? { herb: entryName, text: entry.usage, line: entry.usageLine } : undefined;
}
