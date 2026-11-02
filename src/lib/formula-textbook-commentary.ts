import textbookReferencesJson from "../data/tcm-herb-textbook-references.json" with { type: "json" };

type Commentaries = Record<string, { commentary?: string; features?: string }>;
const COMMENTARIES = ((textbookReferencesJson as unknown as { formulaCommentaries?: Commentaries }).formulaCommentaries) || {};

/** 方解里讲配伍的部分：后面的沿革（「本方原载于…」「本方是…的代表方」）不用。 */
function commentaryBody(text: string): string {
  const cut = text.search(/本方(?:原载|原名|出自|始见|系|是)|后世|《[^》]+》(?:载|称|云)/u);
  return (cut > 40 ? text.slice(0, cut) : text).trim().slice(0, 420);
}

/** 《方剂学》这张方的方解。名字带「加减/加味」或别名写法时取基础方名。 */
export function formulaTextbookCommentary(name: string): string | undefined {
  const base = String(name || "").trim().replace(/(?:加减|化裁|加味)$/u, "");
  const entry = COMMENTARIES[base];
  return entry?.commentary ? commentaryBody(entry.commentary) : undefined;
}

/**
 * 《方剂学》方解写明煎时加的姜枣（「引用生姜、大枣」「煎加姜、枣」「煎服时，少加生姜、大枣」）。这些方的药味表里没有姜枣，
 * 目录组成也没有（归脾汤十味），原方的用法却是「加姜、枣，水煎服」（甲方 10.29 测评）。
 */
export function formulaGuideHerbsFromCommentary(name: string): string[] {
  const base = String(name || "").trim().replace(/(?:加减|化裁|加味)$/u, "");
  const text = COMMENTARIES[base]?.commentary || "";
  const hit = text.match(/(?:引用|煎加|煎时加|少加)\s*(生姜、大枣|生姜|大枣|姜、枣|姜枣)/u)?.[1];
  if (!hit) return [];
  return /[、枣]/u.test(hit) && /姜/u.test(hit) ? ["生姜", "大枣"] : [hit];
}

/** M04 提示词里的【方解依据】：至多两张方。查不到时返回空串。 */
export function formulaCommentaryPromptBlock(names: readonly string[]): string {
  const lines = [...new Set(names.map((name) => String(name || "").trim().replace(/(?:加减|化裁|加味)$/u, "")).filter(Boolean))]
    .flatMap((name) => {
      const commentary = formulaTextbookCommentary(name);
      return commentary ? [`${name}：${commentary}`] : [];
    })
    .slice(0, 2);
  if (lines.length === 0) return "";
  return [
    "【方解依据】以下是《方剂学》对基础方的方解。formulaAnalysis 与 herbs[].function 讲原方药味时，这味药在本方中的作用与君臣佐使以此为准，结合本例病机用自己的话写，不照抄整段；本例新加的药再按本例说明。",
    ...lines,
  ].join("\n");
}

/**
 * 《方剂学》方解把这几味共同列为君药（参苓白术散「人参、白术、茯苓…共为君」、消风散四味为君）：君药超过两味时据此判断是不是原方的配伍。
 * 君药一般一两味，超过两味又不是方解写的才算写错（第三十五轮 W20：「人参、白术、茯苓」表随方义改成三味君药，合同判超限，整页没有剂量）。
 */
export function textbookNamesTheseAsEmperors(formulaName: string, herbNames: readonly string[]): boolean {
  const base = String(formulaName || "").trim().replace(/(?:加减|化裁|加味)$/u, "");
  const text = COMMENTARIES[base]?.commentary || "";
  if (!text || herbNames.length === 0) return false;
  return text.split(/[。；;]/u).some((sentence) => /为君|君药/u.test(sentence) && herbNames.every((name) => sentence.includes(name)));
}
