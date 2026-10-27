/**
 * 候选方「不适用情形」里由服务端追加的逐味提示：毒性与特殊人群用药边界。
 *
 * 2026-10-13 全面回归：这段文字此前是规则表的原样拼接——「麻黄（孕期/妊娠:MEDIUM/麻黄；心血管病:MEDIUM/麻黄）」，
 * 内部等级枚举和规则原文片段直接进了签名载荷，红旗/妊娠等非剂量页还把它印给医生（185 例里 14 例）。
 * 另一处缺陷：候选每重新编译一次（修复轮、终审），上一次追加的尾段先被叙述净化削成
 * 「；；；；。命中相应人群或状态时…复核。」再追加一遍新的，残段逐轮累积（瘦身前后都是约四分之一病例）。
 * 生成与剥离放在同一个文件里：尾段长什么样只有这里知道，编译器与出处富化都调同一个剥离函数。
 */
import modificationRelevanceJson from "../data/tcm-modification-relevance.source.json";

export type HerbBoundaryRule = { population: string; severity: "LOW" | "MEDIUM" | "HIGH" };
export type HerbBoundaryProfile = { herb: string; isToxic: boolean; toxicity: readonly string[]; populationRules: readonly HerbBoundaryRule[] };

const HERB_BOUNDARY_MARKER = "各药毒性与特殊人群提示：";
const HERB_BOUNDARY_TRAILER = "相应人群或状态请停用、替换，或经医生/药师复核后使用。";
/** 旧版写法：已签名的历史载荷与浏览器快照里还有，剥离时必须认得。 */
const LEGACY_HERB_BOUNDARY_MARKER = "逐味生成前安全边界：";
const LEGACY_HERB_BOUNDARY_TRAILER = "命中相应人群或状态时按规则停用、替换或由医生/药师复核。";

const SEVERITY_WORDING = [
  ["HIGH", "禁用或须强复核"],
  ["MEDIUM", "慎用"],
] as const;

/**
 * 本例可能属于哪些人群（2026-10-17）。逐味提示原先对每位患者都列全部人群：30 岁男性的处方写着「石菖蒲（孕期/妊娠禁用）」，
 * 合成集里男性、儿童与 60 岁以上患者的处方 96% 都带孕期或哺乳期提示——甲方 10.12 测评「内容冗余」一类。
 * 只按人群本身能否适用过滤（性别与年龄）；病情类人群（心血管病、肝肾功能不全、出血倾向/月经期/抗凝状态、运动员…）
 * 病历未必写全，一律保留。孕哺是否适用用 reproductiveAdviceRelevant 的同一判据（育龄女性；年龄不详按适用）。
 */
/** reproductive：月经、带下类（reproductiveAdviceRelevant）；pregnancy：孕哺类（pregnancyAdviceRelevant），缺省同 reproductive。 */
export type HerbBoundaryAudience = { reproductive: boolean; pregnancy?: boolean; ageYears: number | null };

export function herbBoundaryPopulationRelevant(population: string, audience?: HerbBoundaryAudience): boolean {
  if (!audience) return true;
  // 知识库的人群标签是一个小闭集（孕期/妊娠、哺乳期、儿童/婴幼儿、老年人…），按标签里的字判断即可，不另立词表。
  if (population.includes("孕") || population.includes("哺乳")) return audience.pregnancy ?? audience.reproductive;
  if (population.includes("儿童") || population.includes("婴幼儿")) return audience.ageYears == null || audience.ageYears < 18;
  if (population.includes("老年")) return audience.ageYears == null || audience.ageYears >= 60;
  return true;
}

/**
 * 病情类合写标签里只对育龄女性成立的那一段（「出血倾向/月经期/抗凝状态」的「月经期」）：本例不可能属于时去掉这一段，其余照列
 *（第二十七轮：男性、儿童、60 岁以上患者的处方写着「川芎（出血倾向/月经期/抗凝状态慎用）」，今日回放 49 份）。
 */
export function herbBoundaryPopulationLabel(population: string, audience?: HerbBoundaryAudience): string {
  if (!audience || audience.reproductive || !population.includes("/")) return population;
  return population.split("/").filter((part) => !part.includes("月经") && !part.includes("经期")).join("/") || population;
}

/** 文本里有本文件写出的尾段（新写法）。 */
export function hasHerbBoundaryTail(text: string): boolean {
  return String(text || "").includes(HERB_BOUNDARY_MARKER);
}

/** 单味药的提示；没有毒性也没有中高等级人群规则时返回 undefined。给了 audience 时只列本例可能属于的人群。 */
export function herbBoundaryNote(profile: HerbBoundaryProfile, audience?: HerbBoundaryAudience): string | undefined {
  const parts = [
    ...(profile.isToxic && profile.toxicity.length > 0 ? [`毒性：${profile.toxicity.join("、")}`] : []),
    ...SEVERITY_WORDING.flatMap(([severity, wording]) => {
      const populations = [...new Set(profile.populationRules
        .filter((rule) => rule.severity === severity && herbBoundaryPopulationRelevant(rule.population.trim(), audience))
        .map((rule) => herbBoundaryPopulationLabel(rule.population.trim(), audience))
        .filter(Boolean))];
      return populations.length > 0 ? [`${populations.join("、")}${wording}`] : [];
    }),
  ];
  return parts.length > 0 ? `${profile.herb}（${parts.join("；")}）` : undefined;
}

/** 整段尾注；没有任何一味需要提示时返回空串。 */
export function herbBoundaryTail(profiles: readonly HerbBoundaryProfile[], audience?: HerbBoundaryAudience): string {
  const notes = profiles.flatMap((profile) => herbBoundaryNote(profile, audience) ?? []);
  return notes.length > 0 ? `${HERB_BOUNDARY_MARKER}${notes.join("；")}。${HERB_BOUNDARY_TRAILER}` : "";
}

/**
 * 去掉服务端此前追加的尾段（新旧两种写法），以及旧尾段被叙述净化削剩的残段。
 * 只认本文件自己写出去的标记与结尾句；模型写的正文不动。
 */
export function stripHerbBoundaryTail(text: string): string {
  let head = String(text || "");
  for (const marker of [HERB_BOUNDARY_MARKER, LEGACY_HERB_BOUNDARY_MARKER]) {
    const at = head.indexOf(marker);
    if (at >= 0) head = head.slice(0, at);
  }
  for (const trailer of [HERB_BOUNDARY_TRAILER, LEGACY_HERB_BOUNDARY_TRAILER]) head = head.split(trailer).join("");
  return head
    .replace(/[；;]{2,}。?/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 复诊提示、急症表现里写给患者的「出现…请就医」项目，只留本例患者可能出现的（2026-10-19，Claude 评审 M-TCM-RobustSDT-single_0516：
 * 61 岁女性的复诊提示写着「月经量骤增」）。注意事项、随证加减、逐味人群提示早已按同一判据收口（reproductiveAdviceRelevant：
 * 男性、12 岁以下、60 岁及以上、已绝经者没有此可能），模型自己写的复诊提示一直没有过这道判据。
 * 词表不另立：月经/带下类取 tcm-modification-relevance 的 femaleReproductiveTerms（随证加减的触发条件用的是同一份），
 * 孕哺类取同文件的 pregnancyLactationTerms。audience.reproductive 为 false 时，含这些词的那一项（按顿号、逗号、分号切）整项去掉，
 * 其余项照旧；去掉后前一项改用被去项的收尾标点，开头的「若/出现」转给下一项；整句只剩「若出现X，请立即就医」这一个项目时整句去掉。
 * 按本例可能性过滤，不改任何临床判断：audience 缺省或 reproductive 为 true（育龄女性、年龄不详）时原样返回。
 */
const FEMALE_REPRODUCTIVE_SIGN_TERMS: readonly string[] = (modificationRelevanceJson as { femaleReproductiveTerms: string[] }).femaleReproductiveTerms;
const PREGNANCY_LACTATION_SIGN_TERMS: readonly string[] = (modificationRelevanceJson as { pregnancyLactationTerms: string[] }).pregnancyLactationTerms;
const SIGN_ITEM_DELIMITER = /(?<=[、，,；;。！？!?])/u;
// 引导词与「说怎么办」的起头词是句式功能词（不是临床词表），放在数据文件里（tcm-modification-relevance.source.json 的 followupSignGrammar），
// 长的在前，这里只拼正则。
const SIGN_GRAMMAR = (modificationRelevanceJson as { followupSignGrammar: { conditionLeads: string[]; eventLeads: string[]; actionStarts: string[] } }).followupSignGrammar;
const SIGN_LEAD = new RegExp(`^(?:${SIGN_GRAMMAR.conditionLeads.join("|")})?(?:${SIGN_GRAMMAR.eventLeads.join("|")})?`, "u");
/** 紧接在症状项后面、说怎么办的小句（请…就医、须…、立即…）：症状项被去光时，这一句失去了条件，整句去掉。 */
const SIGN_ACTION_START = new RegExp(`^(?:${SIGN_GRAMMAR.actionStarts.join("|")})`, "u");

export function followupSignOutsidePopulation(item: string, audience?: HerbBoundaryAudience): boolean {
  if (!audience) return false;
  const text = String(item || "");
  return (!audience.reproductive && FEMALE_REPRODUCTIVE_SIGN_TERMS.some((term) => text.includes(term))) ||
    (!(audience.pregnancy ?? audience.reproductive) && PREGNANCY_LACTATION_SIGN_TERMS.some((term) => text.includes(term)));
}

export function followupSignsForPopulation(text: string, audience?: HerbBoundaryAudience): string {
  const original = String(text || "");
  if (!audience || !followupSignOutsidePopulation(original, audience)) return original;
  const sentences = original.split(/(?<=[。！？!?])/u).map((sentence) => {
    let items = sentence.split(SIGN_ITEM_DELIMITER).map((piece) => {
      const match = piece.match(/^([\s\S]*?)([、，,；;。！？!?]?)$/u);
      return { body: match?.[1] ?? piece, delimiter: match?.[2] ?? "" };
    });
    for (let guard = 0; guard < 20; guard += 1) {
      const at = items.findIndex((item) => followupSignOutsidePopulation(item.body, audience));
      if (at < 0) break;
      const removed = items[at];
      const next = items[at + 1];
      const previous = items[at - 1];
      if (at === 0 && (!next || SIGN_ACTION_START.test(next.body))) return "";
      const rest = items.filter((_, index) => index !== at);
      if (at > 0) {
        // 被去项在句末（后面没有别的项）时，前一项接上被去项的收尾标点；否则也承接被去项的标点（「黑便、月经量骤增，或头晕」→「黑便，或头晕」）。
        rest[at - 1] = { ...previous, delimiter: removed.delimiter };
      } else {
        const lead = removed.body.match(SIGN_LEAD)?.[0] ?? "";
        if (lead && !next.body.startsWith(lead)) rest[0] = { ...next, body: `${lead}${next.body}` };
      }
      items = rest;
    }
    return items.map((item) => `${item.body}${item.delimiter}`).join("");
  });
  const result = sentences.join("");
  return result.trim() ? result : original;
}

/** 条目列表（急症表现、观察指标…）里去掉本例不可能出现的项。 */
export function signListForPopulation(items: readonly string[] | undefined, audience?: HerbBoundaryAudience): string[] {
  return (items || []).filter((item) => !followupSignOutsidePopulation(item, audience));
}
