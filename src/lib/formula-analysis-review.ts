import { herbFunctionKnowledgeForDisplay, isKnownTcmHerbName } from "./tcm-knowledge";
import { compositionIdentityName, isKnownFormulaNameFragment } from "./tcm-formula-provenance";
import doctrinePhrasesJson from "../data/tcm-formula-doctrine-phrases.source.json";
import herbClaimConceptsJson from "../data/tcm-herb-claim-concepts.source.json";

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

const CHINESE_NUMERAL = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/**
 * 提到外来药的分句怎么改（2026-10-14 独立评审）：分句里没有本方药时整句删（原行为）；分句里也点了本方药时，
 * 只删外来药名和它旁边的一个顿号/连词，本方药名留下，同句的「二药」「三味」按剩下的本方药味数改写——
 * 此前整句删，「黄柏、苍术二药共为君」（苍术已被剔出本方）删成了没有君药名的「直清下注足部之湿热」。
 */
function withoutForeignHerbNames(clause: string, foreignSpans: readonly Span[], ownCount: number): string {
  if (ownCount === 0) return "";
  let out = clause;
  for (const span of [...foreignSpans].sort((left, right) => right.start - left.start)) {
    let start = span.start;
    let end = span.end;
    if (/[、和及与]/.test(out[start - 1] || "")) start -= 1;
    else if (out[end] === "、") end += 1;
    out = `${out.slice(0, start)}${out.slice(end)}`;
  }
  return out
    .replace(/([一二两三四五六七八九])(药|味)(共)?/g, (_match, _numeral: string, unit: string, together: string | undefined) =>
      ownCount >= 2 ? `${CHINESE_NUMERAL[ownCount] || ""}${unit}${together || ""}` : "")
    .replace(/([二两三四五六七八九])(臣|佐)/g, (match: string, _numeral: string, unit: string) =>
      ownCount >= 2 ? `${CHINESE_NUMERAL[ownCount] || ""}${unit}` : match);
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
  // 提示词里的系统说法被模型写进方义：「分治脾肾两层次级病机」（2026-10-14 全量复测 190 例中 1 例）、
  //「与本例已锁定治法方向不符」（同日独立评审）。改成病机、本例的原话说法。
  next = next.replace(/次级病机(?:节点)?|病机节点/g, () => {
    changed = true;
    return "病机";
  }).replace(/(?:本例)?已锁定(?:的|之)?(?=治法|证候|方向|病机)/g, () => {
    changed = true;
    return "本例";
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

/**
 * 修复提示词里的系统说法被模型写进方义（2026-10-19；X-E-0512「去肉桂，因本例签名治法与患者事实均未成立温阳方向，故不保留该药」、
 * X-G-1737、TCM-SD-484153「因本例治法方向未涵盖其收载方向，故不纳入」、BEST4SDT-174「因其温阳方向在本例…中无成立依据，故不保留」）。
 * 删掉「，因…故不保留/不纳入」这半句，「去肉桂」留下。只认这几个出自修复提示的说法，临床理由（「去肉桂之温燥」）不动。
 */
const REPAIR_PROMPT_JUSTIFICATION = /[，,]\s*因(?:[^。；;，,]*[，,])?[^。；;]*?(?:签名|成立依据|收载方向|均未成立[^。；;，,]{0,8}方向)[^。；;]*?[，,]?\s*故不(?:保留|纳入)(?:该药|此药)?/gu;

function withoutRepairPromptJustification(text: string): { text: string; changed: boolean } {
  const next = text.replace(REPAIR_PROMPT_JUSTIFICATION, "");
  return { text: next, changed: next !== text };
}

/**
 * 模型的自言自语（2026-10-19；RobustSDT-single_0448「加黄芪未入而以黄芪固表」——黄芪明明在方中；X-G-2860「去僵蚕未加」）：
 *「加X未入…」整个小句不留；「去X未加」只留「去X」。「未入煎」之类讲煎法的不在此列。
 */
const SELF_TALK_CLAUSE = /加[^，,。；;]{1,8}?未入(?!煎)/u;

function withoutSelfTalk(text: string): { text: string; changed: boolean } {
  // 按小句切开（标点留在小句末尾），去掉自言自语的小句；它若以句号/分号收尾，把这个收尾交给前一个保留的小句。
  const parts = text.split(/(?<=[，,。；;])/u);
  const kept: string[] = [];
  for (const part of parts) {
    if (!SELF_TALK_CLAUSE.test(part)) {
      kept.push(part);
      continue;
    }
    const ending = part.match(/[。；;]$/u)?.[0];
    if (ending && kept.length > 0) kept[kept.length - 1] = kept[kept.length - 1].replace(/[，,]$/u, ending);
  }
  const next = kept.join("").replace(/(去[^，,。；;]{1,8}?)未加/gu, "$1");
  return { text: next, changed: next !== text };
}

type DoctrineRow = { name: string; aliases?: string[]; phrase: string };
const DOCTRINE = doctrinePhrasesJson as unknown as { opposites: Record<string, string>; formulas: DoctrineRow[] };

/**
 * 阴阳互求的说法写反（tcm-formula-doctrine-phrases.source.json：《方剂学》左归丸「阳中求阴」、右归丸与肾气丸「阴中求阳」）。
 * 方义点到表中恰好一首方、而写的是相反的那一种时，换成教材原词（甲方标准病历 6：左归丸写成「阴中求阳」）。
 */
function withTextbookDoctrinePhrase(text: string): { text: string; changed: boolean } {
  const named = DOCTRINE.formulas.filter((row) => [row.name, ...(row.aliases || [])].some((name) => text.includes(name)));
  if (named.length !== 1) return { text, changed: false };
  const right = named[0].phrase;
  const wrong = DOCTRINE.opposites[right];
  if (!wrong) return { text, changed: false };
  // 模型两种说法都写了（「阳中求阴、阴中求阳」）时，改过来就成了同一短语连写两遍（2026-10-19 甲方标准病历 6：
  //「二者相配阳中求阴、阳中求阴」），相邻的重复只留一个；已经改过、留着重复的（交付面再投影）同样收拢。
  const escaped = right.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const repeated = new RegExp(`${escaped}(?:[、，,和与及又并]?${escaped})+`, "gu");
  const next = text.split(wrong).join(right).replace(repeated, right);
  return { text: next, changed: next !== text };
}

/** 主语药前面的引子（「佐以」「加」…，受治理表 subjectLeads），最长优先。 */
const SUBJECT_LEAD = new RegExp(`^(?:${[...((herbClaimConceptsJson as unknown as { subjectLeads?: string[] }).subjectLeads || [])]
  .sort((left, right) => right.length - left.length).map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "(?!)"})`, "u");

/** 两味药的合称（「硝黄」「芩连」，受治理表 tcm-herb-claim-concepts.source.json shorthandPairs）。 */
const SHORTHAND_PAIRS = ((herbClaimConceptsJson as unknown as { shorthandPairs?: Array<{ term: string; herbs: [string, string] }> }).shorthandPairs || [])
  .filter((item) => typeof item.term === "string" && item.term.length >= 2 && Array.isArray(item.herbs) && item.herbs.length === 2);

/**
 * 合称里只有一味在方中（2026-10-19 留出例 S046：方中无芒硝，方义「炙甘草为使，调和诸药、缓硝黄之峻」）：改成在方中的那一味。
 * 两味都在、都不在，或合称是方名的一部分（银翘散、知柏地黄丸）时不动。
 */
export function withShorthandPairsMatchingHerbs(text: string, candidateHerbs: readonly string[]): { text: string; changed: boolean } {
  const own = new Set(candidateHerbs.map(identityOf).filter(Boolean));
  let changed = false;
  let next = text;
  for (const pair of SHORTHAND_PAIRS) {
    if (!next.includes(pair.term)) continue;
    const present = pair.herbs.filter((herb) => own.has(identityOf(herb)));
    if (present.length !== 1) continue;
    const pieces = next.split(pair.term);
    let built = pieces[0];
    for (const piece of pieces.slice(1)) {
      // 合称后面紧跟方名词尾（银翘散、知柏地黄丸）：是方名，不改。
      if (COUNT_WORD_IN_FORMULA_NAME.test(piece)) {
        built += `${pair.term}${piece}`;
      } else {
        built += `${present[0]}${piece}`;
        changed = true;
      }
    }
    next = built;
  }
  return { text: next, changed };
}

/** 「二药」「三味」「四味」这类数量词（不含「二者」：它常指两个方面而不是两味药）。 */
const HERB_COUNT_WORD = /([二两三四五六七八九])(药|味)/gu;
/** 数量词后紧跟方名的（六味地黄丸、五味消毒饮、四味香薷饮）：数量词是方名的一部分。 */
const COUNT_WORD_IN_FORMULA_NAME = /^[^，,。；;：:、\s]{0,5}?(?:汤|丸|散|饮|丹|膏)/u;

/**
 * 数量词与点到的药味数对不上（2026-10-19 甲方标准病历 9：「蝉蜕、炒牛蒡子助其疏散风热…，当归养血和营以调营卫，四味共解风热犯卫」，
 * 前面只点了三味）。数的是同一段（上一个分号或句号之后）里、数量词之前**作主语**的本方药：逗号、顿号分开的每一小段开头的那味药
 *（「知母苦寒质润，助石膏泻火…，麦冬甘寒…，二药为臣」里的石膏是宾语，不数）。数量词说的可以是最后几味
 *（「丹参助君活经，竹茹、陈皮…，黄芪…，三药分承…」），所以只要等于从后往前数的某个数就不动；
 * 段里作主语的药不到两味时看整句（「盐黄柏…；苍术…，二药寒温相制」跨分号指前后两味），整句也对不上、且整句不到两味时不动
 *（「二药」只点一味的那一种由交付面单独处理）。药名经 formulaAnalysisHerbMentions 认（别名、炮制名、鹿胶珠＝鹿角胶）；
 * 落在药名或方名里的数字（五味子、六味地黄丸）不算数量词。
 */
export function withRecountedHerbCountWords(text: string, candidateHerbs: readonly string[]): { text: string; changed: boolean } {
  const own = new Set(candidateHerbs.map(identityOf).filter(Boolean));
  if (own.size === 0 || !HERB_COUNT_WORD.test(text)) return { text, changed: false };
  HERB_COUNT_WORD.lastIndex = 0;
  // 本方药的写法（原名与组成身份名），最长优先：药名识别会把「没药散瘀」「升麻散火」当方名跳过，这里按本方药名直接认开头。
  const ownNames = [...new Set(candidateHerbs.flatMap((name) => [stripAnnotation(name), identityOf(name)]).filter((name) => name && name.length >= 2))]
    .sort((left, right) => right.length - left.length);
  /** 一小段开头作主语的本方药（去掉「佐以」「加」这类引子之后）。 */
  const headIdentity = (piece: string): string => {
    const body = piece.trim().replace(SUBJECT_LEAD, "");
    const mention = formulaAnalysisHerbMentions(body).find((item) => item.start === 0);
    const identity = mention ? identityOf(mention.token) : identityOf(ownNames.find((name) => body.startsWith(name)) || "");
    return identity && own.has(identity) ? identity : "";
  };
  /** 一段（分号之间）里各小段开头作主语的本方药，按出现顺序去重。 */
  const subjectsOf = (segment: string): string[] => {
    const found: string[] = [];
    for (const piece of segment.split(/[，,、]/u)) {
      const identity = headIdentity(piece);
      if (identity && !found.includes(identity)) found.push(identity);
    }
    return found;
  };
  let changed = false;
  const rewritten = text.split(/(?<=[。！!])/u).map((sentence) => {
    const spans = formulaAnalysisHerbMentions(sentence);
    return sentence.replace(HERB_COUNT_WORD, (match: string, numeral: string, unit: string, offset: number) => {
      if (spans.some((span) => offset < span.end && offset + match.length > span.start)) return match;
      const after = sentence.slice(offset + match.length);
      if (after.startsWith("子") || COUNT_WORD_IN_FORMULA_NAME.test(after)) return match;
      const stated = numeral === "两" ? 2 : CHINESE_NUMERAL.indexOf(numeral);
      // 本句数量词之前按分号分段：当前段里从后往前数的任意几味，或从当前段往前整段整段地加，等于原数就不动
      //（「白芍、当归…；白术、茯苓…，四味共为臣」跨分号指前后两段四味）。
      const segments = sentence.slice(0, offset).split(/[；;]/u).map(subjectsOf);
      const current = segments[segments.length - 1] || [];
      const accepted = new Set(current.map((_item, index) => current.length - index));
      // 同一味药在前后两段都作主语（「香薷、金银花为君，香薷辛温…；金银花甘寒…，二药一温一清」）只算一次。
      const union = new Set(current);
      for (let index = segments.length - 2; index >= 0; index -= 1) {
        segments[index].forEach((identity) => union.add(identity));
        accepted.add(union.size);
      }
      const running = union.size;
      if (accepted.has(stated)) return match;
      const counted = current.length >= 2 ? current.length : running;
      if (counted < 2 || counted > 9 || (current.length < 2 && segments.length < 2)) return match;
      changed = true;
      return `${CHINESE_NUMERAL[counted]}${unit}`;
    });
  }).join("");
  return { text: rewritten, changed };
}

const GUIDE_PHRASE = /(?:载|引)(?:药|血|火|热)?([上下])行/gu;

/**
 * 引经方向写反（2026-10-19；TCM-SD-472698「桔梗为使，载药下行」）。只改这一处方向字：说这句话的药是同一句里离它最近的前一味本方药，
 * 该药在知识库/核对词典里只有一个引经方向（桔梗「载药上行」、牛膝「引血下行」）而方义写成了另一个时才改；库里没有引经说法的药不动。
 */
function withGuideDirectionMatchingHerb(text: string, ownIdentities: ReadonlySet<string>): { text: string; changed: boolean } {
  const mentions = formulaAnalysisHerbMentions(text);
  let changed = false;
  const chars = [...text];
  for (const match of text.matchAll(GUIDE_PHRASE)) {
    const at = match.index ?? 0;
    const sentenceStart = Math.max(text.lastIndexOf("。", at - 1), text.lastIndexOf("；", at - 1), text.lastIndexOf(";", at - 1)) + 1;
    const subject = [...mentions].reverse().find((mention) => mention.end <= at && mention.start >= sentenceStart);
    if (!subject) continue;
    const identity = identityOf(subject.token);
    if (!ownIdentities.has(identity)) continue;
    const knowledge = herbFunctionKnowledgeForDisplay(identity);
    const known = new Set([...knowledge.matchAll(GUIDE_PHRASE)].map((item) => item[1]));
    if (/引火归[元原]/u.test(knowledge)) known.add("下");
    if (known.size !== 1 || known.has(match[1])) continue;
    const directionIndex = at + match[0].lastIndexOf(match[1]);
    // text 与 chars 的下标一致：方义里没有代理对字符（药名、标点都在基本平面）。
    chars[directionIndex] = [...known][0];
    changed = true;
  }
  return { text: changed ? chars.join("") : text, changed };
}

/**
 * 服务端从方中删掉药味之后（m04-modification-safety 的方向剔除：痰热证里的薤白、半夏、天南星），方义还在讲这些药
 *（2026-10-19；X-G-1785、X-G-2919）。用同一个审方函数按剩下的药味再审一遍，讲删掉的药的分句随之删去。
 * 审完不可用（剩下的本方药讲得太少）时仍交回清理后的文字——不再提方中没有的药，比原文更接近事实；为空时原样返回。
 */
export function formulaAnalysisAfterHerbRemoval(
  analysis: string,
  retainedHerbs: readonly string[],
  opts: { nodeLabels?: Readonly<Record<string, string>> } = {},
): string {
  if (typeof analysis !== "string" || !analysis.trim()) return analysis;
  const review = reviewAuthoredFormulaAnalysis(analysis, retainedHerbs, opts);
  return review.text || analysis;
}

/** 小模型报来的一条「方义把某药不具备的功效安在它身上」（m04-formula-analysis-claim-check.server.ts 第一道）。 */
export type FormulaAnalysisHerbClaim = { herb: string; clause: string; claim: string };
export type FormulaAnalysisHerbClaimRemoval = {
  herb: string;
  claim: string;
  /** piece：删掉这味药谓语里含错说法的那一小段；segment：这味药的整段说明；herb_name：多药并列时只去掉这味药的名字。 */
  action: "piece" | "segment" | "herb_name";
  removed: string;
};
export type FormulaAnalysisHerbClaimReview = {
  text: string;
  removals: FormulaAnalysisHerbClaimRemoval[];
  rejected: Array<{ herb: string; claim: string; reason: string }>;
};

type ClaimConceptGroup = { id: string; claim: RegExp; support: RegExp };
const HERB_CLAIM_CONCEPTS = herbClaimConceptsJson as unknown as { groups: Array<{ id: string; claim: string; support: string }>; combinedEffectMarkers?: string[] };
const CLAIM_CONCEPT_GROUPS: readonly ClaimConceptGroup[] = (HERB_CLAIM_CONCEPTS.groups || [])
  .map((group) => ({ id: group.id, claim: new RegExp(group.claim, "u"), support: new RegExp(group.support, "u") }));
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 几味药合起来的作用的写法（tcm-herb-claim-concepts.source.json 的 combinedEffectMarkers）。 */
export function combinedEffectMarkerPattern(): RegExp {
  return new RegExp((HERB_CLAIM_CONCEPTS.combinedEffectMarkers || []).map(escapeRegExp).join("|") || "(?!)", "u");
}
const COMBINED_EFFECT = combinedEffectMarkerPattern();

/** 说法落在哪些功效概念组、其中哪些是参考功效不支持的（tcm-herb-claim-concepts.source.json）。 */
export function unsupportedHerbClaimConcepts(claim: string, reference: string): string[] {
  return CLAIM_CONCEPT_GROUPS
    .filter((group) => group.claim.test(claim) && !group.support.test(reference))
    .map((group) => group.id);
}

type AnalysisSegment = { start: number; end: number; subjectEnd: number; subjects: Span[] };

/**
 * 一句话（到「；」「。」为止）按「药名＋它的说明」切段：药名前面是句首、逗号或顿号才另起一段（「黄柏泻下焦相火、青蒿清透伏热」是两段）；
 * 紧挨着用顿号、「和」「与」「及」连着的几味药是同一段的主语（「瓜蒌、薤白为君」）；说明里顺带提到的药（「助熟地生血」）不另起段。
 */
function analysisSegments(text: string, sentenceStart: number, sentenceEnd: number): AnalysisSegment[] {
  const mentions = formulaAnalysisHerbMentions(text).filter((mention) => mention.start >= sentenceStart && mention.end <= sentenceEnd);
  const segments: AnalysisSegment[] = [];
  let current: AnalysisSegment | undefined;
  for (const mention of mentions) {
    if (current && current.subjectEnd === current.subjects[current.subjects.length - 1].end &&
      /^[、和与及]?$/u.test(text.slice(current.subjectEnd, mention.start))) {
      current.subjects.push(mention);
      current.subjectEnd = mention.end;
      continue;
    }
    const before = text.slice(sentenceStart, mention.start);
    const opensSegment = mention.start === sentenceStart || /[，,、]\s*$/u.test(before) || /^(?:本方以|方中|以)?$/u.test(before.trim());
    // 说明里顺带提到的药（前面不是句首或标点）不另起段，也不算主语。
    if (!current || opensSegment) {
      if (current) current.end = mention.start;
      current = { start: mention.start, end: sentenceEnd, subjectEnd: mention.end, subjects: [mention] };
      segments.push(current);
    }
  }
  return segments;
}

/** 一段说明（主语之后）按顿号、逗号与「并/兼/且」切成小段，返回含 index 的那一小段在全文里的起止（含它前面的分隔符）。 */
function predicatePieceAround(text: string, from: number, to: number, index: number): { start: number; end: number; others: string[] } {
  const bounds: number[] = [from];
  for (let position = from + 1; position < to; position += 1) {
    const char = text[position];
    if (/[，,、]/u.test(char) || (/[并兼且]/u.test(char) && !/[，,、]/u.test(text[position - 1]))) bounds.push(position);
  }
  bounds.push(to);
  let pieceIndex = 0;
  for (let position = 0; position < bounds.length - 1; position += 1) {
    if (index >= bounds[position] && index < bounds[position + 1]) pieceIndex = position;
  }
  const pieces = bounds.slice(0, -1).map((start, position) => text.slice(start, bounds[position + 1]));
  return {
    start: bounds[pieceIndex],
    end: bounds[pieceIndex + 1],
    others: pieces.filter((_, position) => position !== pieceIndex),
  };
}

function recountSubjectNumerals(segmentText: string, remaining: number): string {
  // 「五味子」里的「五味」不是数量词（2026-10-19 回放：「五味子、煅牡蛎收敛固涩」被数成「二味子」）。
  return segmentText.replace(/([二两三四五六七八九])(药|味|者)(?!子)/gu, (_match, _numeral: string, unit: string) =>
    remaining >= 2 ? `${CHINESE_NUMERAL[remaining] || ""}${unit}` : "");
}

/**
 * 第二道（确定性，唯一能删字的一道）：小模型报来的「某药被说成有某功效」，逐条核对后才删（2026-10-19，甲方标准病历 10
 * 「青蒿…并生津除烦」「黄柏…泄肝火」、病历 6「鹿胶珠、龟胶珠…滋阴养血兼退虚热」）。
 *   1 报来的片段逐字在方义里，错说法逐字在片段里；
 *   2 这味药在本方里；
 *   3 错说法落在功效概念组里，且至少有一组这味药的参考功效（referenceFor 给出）不支持；
 *   4 错说法确实是在说这味药：它在这味药那一段的说明里（主语是这味药，或这味药与别的药并列）。
 * 改法从小到大：这味药说明里还有别的内容时只删含错说法的那一小段（「青蒿后下清透虚热并生津除烦」→「青蒿后下清透虚热」）；
 * 几味药并列作主语、同列的药有这个功效时只去掉这味药的名字（「鹿胶珠、龟胶珠…滋阴」→「龟胶珠…滋阴」）；
 * 说明只剩这一句时删这味药的整段。改完方义若短于 24 字或不再讲本方，一处都不改。
 */
export function removeVerifiedHerbClaims(
  analysis: string,
  candidateHerbs: readonly string[],
  claims: readonly FormulaAnalysisHerbClaim[],
  referenceFor: (herb: string) => string,
): FormulaAnalysisHerbClaimReview {
  const original = typeof analysis === "string" ? analysis : "";
  const removals: FormulaAnalysisHerbClaimRemoval[] = [];
  const rejected: FormulaAnalysisHerbClaimReview["rejected"] = [];
  const ownIdentities = new Set(candidateHerbs.map(identityOf).filter(Boolean));
  // 参考功效按写法与本方同一身份的药名一起取：组成身份把熟地黄与地黄并成一味，只按身份名取会把熟地黄的「益精填髓」丢掉。
  const namesByIdentity = new Map<string, string[]>();
  for (const name of candidateHerbs) {
    const identity = identityOf(name);
    if (identity) namesByIdentity.set(identity, [...(namesByIdentity.get(identity) || []), stripAnnotation(name)]);
  }
  const referenceOf = (token: string) => [...new Set([stripAnnotation(token), ...(namesByIdentity.get(identityOf(token)) || [])])]
    .map(referenceFor).filter(Boolean).join("；");
  let text = original;
  for (const item of claims) {
    const herb = typeof item?.herb === "string" ? item.herb.trim() : "";
    const clause = typeof item?.clause === "string" ? item.clause.trim() : "";
    const claim = typeof item?.claim === "string" ? item.claim.trim() : "";
    const reject = (reason: string) => { rejected.push({ herb, claim, reason }); };
    if (!herb || !clause || !claim || claim.length > 16) { reject("malformed"); continue; }
    const clauseAt = text.indexOf(clause);
    if (clauseAt < 0 || !clause.includes(claim)) { reject("not_verbatim"); continue; }
    const identity = identityOf(herb);
    if (!ownIdentities.has(identity)) { reject("herb_not_in_candidate"); continue; }
    // 片段里得真的点到这味药（识别得出的药名，身份相同）：模型拿片段里别的写法（「龟胶」）去对本方的药，不算。
    if (!formulaAnalysisHerbMentions(clause).some((mention) => identityOf(mention.token) === identity)) { reject("herb_not_named_in_clause"); continue; }
    const unsupported = unsupportedHerbClaimConcepts(claim, referenceOf(herb));
    if (unsupported.length === 0) {
      reject(CLAIM_CONCEPT_GROUPS.some((group) => group.claim.test(claim)) ? "reference_supports_claim" : "claim_outside_concept_groups");
      continue;
    }
    const claimAt = clauseAt + clause.indexOf(claim);
    const sentenceStart = Math.max(text.lastIndexOf("。", claimAt - 1), text.lastIndexOf("；", claimAt - 1), text.lastIndexOf(";", claimAt - 1)) + 1;
    const stops = ["。", "；", ";"].map((stop) => text.indexOf(stop, claimAt)).filter((index) => index >= 0);
    const sentenceEnd = stops.length > 0 ? Math.min(...stops) : text.length;
    const segment = analysisSegments(text, sentenceStart, sentenceEnd)
      .find((candidate) => claimAt >= candidate.subjectEnd && claimAt < candidate.end);
    if (!segment || !segment.subjects.some((subject) => identityOf(subject.token) === identity)) {
      reject("claim_not_attributed_to_herb");
      continue;
    }
    const others = segment.subjects.filter((subject) => identityOf(subject.token) !== identity);
    const predicate = text.slice(segment.subjectEnd, segment.end);
    // 「一…、一…」分说两味药各自的作用（「桑白皮、黄芩为君，一泻肺中伏火、一清肝经郁热」）：说法归哪味药读不准，不动。
    if (others.length > 0 && /一[^，,。；;]{1,14}[、，,]\s*一/u.test(predicate)) { reject("distributive_clause"); continue; }
    const piece = predicatePieceAround(text, segment.subjectEnd, segment.end, claimAt);
    const pieceText = text.slice(piece.start, piece.end);
    // 几味药合起来的作用（「与白及、仙鹤草共奏化瘀止血之功」）不是单味药的功效，不动。
    if (COMBINED_EFFECT.test(pieceText)) { reject("combined_effect"); continue; }
    // 几味药并列作主语：这一段说明里讲到的功效，这味药一样都没有、而同列的药有（「鹿胶珠、龟胶珠…滋阴养血兼退虚热」里的「滋阴」），
    // 才只去掉这味药的名字。这味药也有其中某一项时（「熟地黄、山萸肉补肾填精、收涩固摄」），是分说，不动名字。
    const predicateGroups = CLAIM_CONCEPT_GROUPS.filter((group) => group.claim.test(predicate));
    const herbReference = referenceOf(herb);
    const herbSupportsSomething = predicateGroups.some((group) => group.support.test(herbReference));
    const predicateUnsupported = predicateGroups.filter((group) => !group.support.test(herbReference)).map((group) => group.id);
    const othersSupport = others.some((subject) => [...new Set([...unsupported, ...predicateUnsupported])]
      .some((id) => CLAIM_CONCEPT_GROUPS.find((group) => group.id === id)?.support.test(referenceOf(subject.token))));
    // 报来的这一项同列的药有（「熟地黄、山萸肉补肾填精、收涩固摄」里山萸肉收涩）：这一小段对别的药是真的，不删这一小段。
    const othersSupportClaim = others.some((subject) => unsupported
      .some((id) => CLAIM_CONCEPT_GROUPS.find((group) => group.id === id)?.support.test(referenceOf(subject.token))));
    // 并列的是君臣佐使名单（「枇杷叶、桑白皮为君，清肺降气、疏风止痒」）：去掉名字就改了这味药在方中的地位，不动名字。
    const roleList = /为[君臣佐使]/u.test(predicate);
    if (others.length > 0 && othersSupport && (herbSupportsSomething || roleList)) {
      if (othersSupportClaim) { reject(roleList ? "role_list" : "partially_supported_group"); continue; }
    } else if (others.length > 0 && othersSupport) {
      // 并列的药里别的药有这个功效：只去掉这味药的名字（连同它旁边的一个顿号/连词），段里的「二药」「三味」按剩下的药数改写。
      const flagged = segment.subjects.find((subject) => identityOf(subject.token) === identity)!;
      let start = flagged.start;
      let end = flagged.end;
      if (/[、和与及]/u.test(text[end] || "") && end < segment.subjectEnd) end += 1;
      else if (/[、和与及]/u.test(text[start - 1] || "")) start -= 1;
      const segmentText = `${text.slice(segment.start, start)}${text.slice(end, segment.end)}`;
      text = `${text.slice(0, segment.start)}${recountSubjectNumerals(segmentText, others.length)}${text.slice(segment.end)}`;
      removals.push({ herb, claim, action: "herb_name", removed: flagged.token });
      continue;
    }
    // 错说法在这一小段的末尾、前面还有别的功效时只删它（连同紧挨着的「兼/并/及/而」）：「龟胶偏滋阴退虚热」→「龟胶偏滋阴」。
    // 末尾是君臣佐使（「、泄热和胃为君」）时角色留下，只删前面的说法。
    const roleTail = pieceText.match(/(?:共|同)?为[君臣佐使]药?[，,、]?$/u)?.[0] || "";
    const tail = pieceText.slice(0, pieceText.length - roleTail.length).replace(/[，,、]+$/u, "");
    // 错说法夹在两个功效中间（「清热化湿解毒」）：只删这几个字。前面是「并/兼/而」等连接词时不在此列，按下面整小段处理。
    const claimInPiece = tail.indexOf(claim);
    if (claimInPiece > 0 && claimInPiece + claim.length < tail.length &&
      /[一-鿿]/u.test(tail[claimInPiece - 1]) && !/[兼并及而且又以与和]/u.test(tail[claimInPiece - 1]) &&
      /[一-鿿]/u.test(tail[claimInPiece + claim.length])) {
      const cutStart = piece.start + claimInPiece;
      removals.push({ herb, claim, action: "piece", removed: claim });
      text = `${text.slice(0, cutStart)}${text.slice(cutStart + claim.length)}`;
      continue;
    }
    if (roleTail && piece.start > segment.subjectEnd && tail.includes(claim)) {
      // 删掉说法（连同它前面的顿号）、保留「为君」：「青皮疏肝破气、泄热和胃为君」→「青皮疏肝破气为君」。
      const cutEnd = piece.start + tail.length;
      removals.push({ herb, claim, action: "piece", removed: text.slice(piece.start, cutEnd) });
      text = `${text.slice(0, piece.start)}${text.slice(cutEnd)}`;
      continue;
    }
    if (tail.endsWith(claim)) {
      const head = tail.slice(0, -claim.length).replace(/[兼并及而且又以]$/u, "");
      if (/[一-鿿]{2,}/u.test(head.replace(/^[，,、并兼且]/u, ""))) {
        const cutStart = piece.start + head.length;
        const cutEnd = piece.start + tail.length;
        removals.push({ herb, claim, action: "piece", removed: text.slice(cutStart, cutEnd) });
        text = `${text.slice(0, cutStart)}${text.slice(cutEnd)}`;
        continue;
      }
    }
    const otherContent = piece.others.some((value) => /[一-鿿]{2,}/u.test(value.replace(/^[，,、并兼且]/u, "")));
    if (otherContent) {
      const start = piece.start;
      let end = piece.end;
      // 这一小段在说明的最前面（主语之后直接就是它）：连同它后面的分隔符一起删，免得留下「黄柏、…」。
      if (start === segment.subjectEnd && /[，,、]/u.test(text[end] || "")) end += 1;
      removals.push({ herb, claim, action: "piece", removed: text.slice(start, end) });
      text = `${text.slice(0, start)}${text.slice(end)}`;
      continue;
    }
    let start = segment.start;
    const end = segment.end;
    if (/[，,、]/u.test(text[start - 1] || "")) start -= 1;
    removals.push({ herb, claim, action: "segment", removed: text.slice(start, end) });
    text = `${text.slice(0, start)}${text.slice(end)}`;
  }
  if (removals.length === 0) return { text: original, removals, rejected };
  const tidied = tidyPunctuation(text.replace(/^[，,、]/u, ""));
  const before = reviewAuthoredFormulaAnalysis(original, candidateHerbs);
  const after = reviewAuthoredFormulaAnalysis(tidied, candidateHerbs);
  if (tidied.length < 24 || (before.usable && !after.usable)) {
    return { text: original, removals: [], rejected: [...rejected, ...removals.map((removal) => ({ herb: removal.herb, claim: removal.claim, reason: "would_empty_analysis" }))] };
  }
  return { text: tidied, removals, rejected };
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
  const leaked = withoutRepairPromptJustification(text);
  if (leaked.changed) adjustments.push("repair_prompt_phrase_removed");
  text = leaked.text;
  const selfTalk = withoutSelfTalk(text);
  if (selfTalk.changed) adjustments.push("self_talk_removed");
  text = selfTalk.text;
  const doctrine = withTextbookDoctrinePhrase(text);
  if (doctrine.changed) adjustments.push("doctrine_phrase_corrected");
  text = doctrine.text;

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
    // 从后往前改，下标不漂移；同一分句多味外来药一并处理。
    const clauses = [...new Map(foreign.map((item) => {
      const bounds = clauseBounds(text, item.start);
      return [`${bounds.start}:${bounds.end}`, bounds] as const;
    })).values()].sort((left, right) => right.start - left.start);
    for (const bounds of clauses) {
      const inside = (span: Span) => span.start >= bounds.start && span.end <= bounds.end;
      const ownCount = new Set(mentions.filter(inside).map((span) => identityOf(span.token)).filter((identity) => ownIdentities.has(identity))).size;
      const kept = withoutForeignHerbNames(
        text.slice(bounds.start, bounds.end),
        foreign.filter(inside).map((span) => ({ ...span, start: span.start - bounds.start, end: span.end - bounds.start })),
        ownCount,
      );
      // 「黄柏、苍术苦寒清下焦湿热，二药合为君」：「二药」在下一个分句里，同样按剩下的本方药味数改写（2026-10-17 留出例 S145，
      // 苍术剔出本方后剩「黄柏苦寒清下焦湿热，二药合为君」）。剩一味时去掉数量词，留「为君」。
      // 整个分句删掉、且它以逗号结尾时，紧跟着的、不点任何药名的分句是它的后半句（「首乌藤养心安神，改善血不养心之睡眠差、心悸；」），
      // 一并删到分号或句号为止；否则留下没有主语的「改善血不养心之睡眠差、心悸」（2026-10-18 甲方标准病历 3，三次生成里两次）。
      // 「全方…」「共奏…」这类总括句不在此列。
      let rest = text.slice(bounds.end);
      if (kept === "" && /[，,]$/.test(text.slice(bounds.start, bounds.end))) {
        for (;;) {
          const next = rest.match(/^[^，,；;。！？!?：:]*[，,；;。]?/)?.[0] || "";
          if (!next || formulaAnalysisHerbMentions(next).length > 0 || /^\s*(?:全方|本方|诸药|共奏|合用|全)/.test(next)) break;
          rest = /。$/.test(next) ? `。${rest.slice(next.length)}` : rest.slice(next.length);
          if (/[；;。]$/.test(next)) break;
        }
      }
      const following = rest.replace(/^([，,]?\s*)([二两三四五六七八九])(药|味)(?!子)(合|共)?/, (match, lead: string, _numeral: string, unit: string, together: string | undefined) =>
        ownCount >= 2 ? `${lead}${CHINESE_NUMERAL[ownCount] || ""}${unit}${together || ""}` : ownCount === 1 ? lead : match);
      text = `${text.slice(0, bounds.start)}${kept}${following}`;
    }
    adjustments.push("foreign_clause_removed");
  }
  const guided = withGuideDirectionMatchingHerb(text, ownIdentities);
  if (guided.changed) adjustments.push("guide_direction_corrected");
  text = guided.text;
  const shorthand = withShorthandPairsMatchingHerbs(text, candidateHerbs);
  if (shorthand.changed) adjustments.push("shorthand_pair_matched_to_herbs");
  text = shorthand.text;
  const recounted = withRecountedHerbCountWords(text, candidateHerbs);
  if (recounted.changed) adjustments.push("herb_count_word_recounted");
  text = recounted.text;
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
