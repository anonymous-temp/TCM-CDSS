import { isKnownTcmHerbName } from "./tcm-knowledge";
import { compositionIdentityName, isKnownFormulaNameFragment } from "./tcm-formula-provenance";

/**
 * 模型写的方解怎么审（2026-09-29，甲方 9.24/9.27 医学测评第 6 条）。
 *
 * 【之前】`formulaAnalysisIsGroundedInCandidate` 是一道硬闸：方解里只要扫到一个「本方没有的药名」
 * 就整段丢弃、换成服务端逐味拼接的模板。扫描按 2–4 字窗口逐位查药名库，于是本方药名的**一部分**
 * 也算外来药——苦杏仁里的「杏仁」、熟地黄里的「地黄」、酸枣仁里的「枣仁」、金银花里的「银花」、
 * 石菖蒲里的「菖蒲」，炮制写法「煅龙齿/酒黄芩」对处方里的「龙齿/黄芩」，甚至方名「玉屏风散」里的
 * 「屏风」（防风别名）。甲方 9 例重放 9/9 被判不合格；485 张真实处方模拟 84% 会被误判。医生看到的
 * 「炙甘草取其祛痰止咳之长」「直治肺主皮毛，开窍于鼻」都出自那个模板，不是模型写的。
 *
 * 【现在】不再整段丢弃（owner 2026-09-29：不要硬拦截把模型内容换成模板）。
 *   1. 药名按**最长匹配**逐段识别，并统一到「去炮制的受治理正名」再与本方比对；方名片段整段跳过；
 *      「去木通」「以通草易木通」这类说明加减的写法不算外来药。
 *   2. 真正的外来药只删**提到它的那一个分句**，其余原文保留；剂量、Markdown、内部节点编号
 *      （P1/P2）与阶段代号（M03）就地清掉。
 *   3. 只有清理后几乎不剩内容、或根本没在讲本方（点到的本方药味不足 2 味）时，才回落服务端兜底。
 * 模型侧的纠偏在提示词与修复轮提示里（「方解只讨论 candidate.herbs 中的药味」），不额外加修复轮——
 * 方解措辞不改变可服用性，不值得为它多等一轮模型。
 */

export type FormulaAnalysisReview = {
  /** 清理后的方解；usable=false 时调用方应回落兜底。 */
  text: string;
  usable: boolean;
  /** 点到的本方药味数（按去炮制正名去重）。 */
  ownMentioned: number;
  /** 被删掉分句的真正外来药（原文写法）。 */
  foreignHerbs: string[];
  /** 做了哪些清理，供遥测统计采用率。 */
  adjustments: string[];
};

type Span = { start: number; end: number; token: string };

const MAX_HERB_TOKEN = 6;
const MAX_FORMULA_NAME = 12;
const FORMULA_NAME_SUFFIX = /[汤散丸饮丹膏煎方]/;
// 说明加减、对照原方、禁忌时提到本方没有的药，是方解的正当内容，不是「把别的方套过来」。
const EXEMPT_PREFIX = /(?:去|减|除|除去|删|不用|不取|未用|弃|易|代|替|换|改|而非|原方|原书|较|比|慎|忌|不宜|无需|无须|勿)[^，。；,;]{0,2}$/;
const EXEMPT_SUFFIX = /^[^，。；,;]{0,2}(?:易为|改为|换为|代之|替之|之类)/;
const PLACEHOLDER_ANALYSIS = /(?:具体配伍作用|具体作用).*(?:结合方义|复核)|同上述|参见前文|^依据最终药味、君臣佐使与对应病机生成。?$|由服务端(?:知识库)?生成/;
const DOSE_TOKEN = /[（(]?\s*\d+(?:\.\d+)?\s*(?:g|克|mg|毫克|ml|毫升|片|粒|枚)\s*[）)]?/gi;
const CLAUSE_BREAK = /[，,；;。！？!?：:]/;

function stripAnnotation(name: string): string {
  return name.replace(/[（(][^）)]*[）)]/g, "").replace(/\s+/g, "").trim();
}

function identityOf(name: string): string {
  const cleaned = stripAnnotation(name);
  if (!cleaned) return "";
  return compositionIdentityName(cleaned) || cleaned;
}

function formulaNameSpans(text: string): Span[] {
  const spans: Span[] = [];
  const bookPattern = /《[^》]{1,40}》/g;
  for (const match of text.matchAll(bookPattern)) {
    spans.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, token: match[0] });
  }
  for (let end = 0; end < text.length; end += 1) {
    if (!FORMULA_NAME_SUFFIX.test(text[end])) continue;
    for (let length = Math.min(MAX_FORMULA_NAME, end + 1); length >= 3; length -= 1) {
      const start = end - length + 1;
      const fragment = text.slice(start, end + 1);
      if (/[，,；;。：:、\s]/.test(fragment)) continue;
      if (isKnownFormulaNameFragment(fragment)) {
        spans.push({ start, end: end + 1, token: fragment });
        break;
      }
    }
  }
  return spans;
}

function insideAny(index: number, spans: readonly Span[]): Span | undefined {
  return spans.find((span) => index >= span.start && index < span.end);
}

/** 最长匹配识别文中的药名（跳过方名与书名片段）。 */
export function formulaAnalysisHerbMentions(text: string): Span[] {
  const blocked = formulaNameSpans(text);
  const mentions: Span[] = [];
  let index = 0;
  while (index < text.length) {
    const block = insideAny(index, blocked);
    if (block) {
      index = block.end;
      continue;
    }
    let matched: Span | undefined;
    for (let width = Math.min(MAX_HERB_TOKEN, text.length - index); width >= 2; width -= 1) {
      const token = text.slice(index, index + width);
      if (/[^一-鿿]/.test(token)) continue;
      if (isKnownTcmHerbName(token)) {
        matched = { start: index, end: index + width, token };
        break;
      }
    }
    if (matched) {
      mentions.push(matched);
      index = matched.end;
    } else {
      index += 1;
    }
  }
  return mentions;
}

function clauseBounds(text: string, index: number): { start: number; end: number } {
  let start = index;
  while (start > 0 && !CLAUSE_BREAK.test(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !CLAUSE_BREAK.test(text[end])) end += 1;
  // 连同分句后的标点一起删；句末句号保留给前一分句收尾。
  if (end < text.length && text[end] !== "。") end += 1;
  return { start, end };
}

function tidyPunctuation(text: string): string {
  return text
    .replace(/([，,；;、])\s*(?=[，,；;。])/g, "")
    .replace(/^[，,；;、。\s]+/, "")
    .replace(/[，,；;、]+。/g, "。")
    .replace(/[，,；;、]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function replaceInternalReferences(text: string, nodeLabels: Readonly<Record<string, string>>): { text: string; changed: boolean } {
  let changed = false;
  let next = text.replace(/(?:与)?M0[1-5](?:已)?(?:锁定|签名)?(?:的|之)?/g, (match) => {
    changed = true;
    return match.startsWith("与") ? "与本例" : "本例";
  });
  next = next.replace(/[（(]\s*P\d+\s*[）)]/g, () => {
    changed = true;
    return "";
  });
  next = next.replace(/P(\d+)(之)?/g, (match: string, id: string, of: string | undefined, offset: number, whole: string) => {
    changed = true;
    const label = nodeLabels[`P${id}`];
    // 「以顾P4之脾运不足」：后文已经说了这条病机，就只删编号，不再把标签塞回去（否则成了「脾运不足之脾运不足」）。
    const following = whole.slice(offset + match.length, offset + match.length + 4);
    if (!label || (of && following.startsWith(label.slice(0, 2)))) return "";
    return `${label}${of || ""}`;
  });
  return { text: next, changed };
}

function hasRepeatedNarrative(text: string): boolean {
  const window = 12;
  const counts = new Map<string, number>();
  for (let index = 0; index + window <= text.length; index += 1) {
    const piece = text.slice(index, index + window);
    if (/[，,；;。\s]/.test(piece)) continue;
    const next = (counts.get(piece) || 0) + 1;
    if (next >= 3) return true;
    counts.set(piece, next);
  }
  return false;
}

export function reviewAuthoredFormulaAnalysis(
  raw: string,
  candidateHerbs: readonly string[],
  opts: { nodeLabels?: Readonly<Record<string, string>> } = {},
): FormulaAnalysisReview {
  const adjustments: string[] = [];
  let text = typeof raw === "string" ? raw.trim() : "";
  if (!text || PLACEHOLDER_ANALYSIS.test(text)) {
    return { text: "", usable: false, ownMentioned: 0, foreignHerbs: [], adjustments: text ? ["placeholder"] : ["empty"] };
  }
  const withoutMarkdown = text
    .replace(/\*\*/g, "")
    .replace(/(?:^|\n)\s*(?:#{1,6}|[-*•]|\d+[.、)])\s+/g, "")
    .replace(/[\r\n]+/g, "");
  if (withoutMarkdown !== text) adjustments.push("markdown_stripped");
  text = withoutMarkdown;
  const withoutDose = text.replace(DOSE_TOKEN, "");
  if (withoutDose !== text) adjustments.push("dose_stripped");
  text = withoutDose;
  const internal = replaceInternalReferences(text, opts.nodeLabels || {});
  if (internal.changed) adjustments.push("internal_reference_rewritten");
  text = internal.text;

  // 同一段话反复出现（逐味把整条病机贴一遍）不是方解，是模板灌水：清理救不回来，交给服务端兜底。
  // 12 字窗口出现 ≥3 次即判——正常方解里同一个 12 字片段极少出现三次。
  if (hasRepeatedNarrative(text)) {
    return { text: "", usable: false, ownMentioned: 0, foreignHerbs: [], adjustments: [...adjustments, "repeated_narrative"] };
  }
  const ownIdentities = new Set(candidateHerbs.map(identityOf).filter(Boolean));
  const ownRaw = new Set(candidateHerbs.map(stripAnnotation).filter(Boolean));
  const mentions = formulaAnalysisHerbMentions(text);
  const mentionedOwn = new Set<string>();
  const foreign: Span[] = [];
  for (const mention of mentions) {
    const identity = identityOf(mention.token);
    if (ownRaw.has(mention.token) || ownIdentities.has(identity)) {
      mentionedOwn.add(identity || mention.token);
      continue;
    }
    const before = text.slice(Math.max(0, mention.start - 6), mention.start);
    const after = text.slice(mention.end, mention.end + 6);
    if (EXEMPT_PREFIX.test(before) || EXEMPT_SUFFIX.test(after)) continue;
    foreign.push(mention);
  }
  const foreignHerbs = [...new Set(foreign.map((item) => item.token))];
  if (foreign.length > 0) {
    // 从后往前删，下标不漂移；同一分句多味外来药只删一次。
    const removals = [...new Map(foreign.map((item) => {
      const bounds = clauseBounds(text, item.start);
      return [`${bounds.start}:${bounds.end}`, bounds] as const;
    })).values()].sort((left, right) => right.start - left.start);
    for (const bounds of removals) text = `${text.slice(0, bounds.start)}${text.slice(bounds.end)}`;
    adjustments.push("foreign_clause_removed");
  }
  text = tidyPunctuation(text);
  if (text.length > 1200) {
    const cut = text.slice(0, 1200);
    const lastStop = cut.lastIndexOf("。");
    text = lastStop >= 200 ? cut.slice(0, lastStop + 1) : cut;
    adjustments.push("truncated");
  }
  // 删过外来药分句之后，剩下的本方药味要重新数一遍——被删的分句里可能也点过本方药。
  const remainingOwn = foreign.length > 0
    ? new Set(formulaAnalysisHerbMentions(text)
      .map((mention) => identityOf(mention.token))
      .filter((identity) => ownIdentities.has(identity)))
    : mentionedOwn;
  const ownMentioned = remainingOwn.size;
  // 覆盖度：至少点到本方 60% 的药味（不少于 2 味）。旧口径是 80%；放宽是因为模型常把同作用药并成一个配伍分句，
  // 但只讲君臣两味、漏掉半数药味的方解不是方解（test:client-feedback-20260817 钉着「遗漏半数必须重建」）。
  const requiredCoverage = Math.min(ownIdentities.size, Math.max(2, Math.ceil(ownIdentities.size * 0.6)));
  const usable = text.length >= 24 && ownMentioned >= requiredCoverage;
  if (!usable) adjustments.push(ownMentioned < requiredCoverage ? "not_about_candidate" : "too_short_after_cleanup");
  return { text, usable, ownMentioned, foreignHerbs, adjustments };
}
