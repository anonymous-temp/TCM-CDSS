import table from "../data/allergen-classes.json";

/**
 * 患者约束档案里的过敏一项（2026-10-26 第二十一轮）：病历记录的过敏按 GB 7718-2025 等 15 类归类，推荐的每一项（饮食段的食材、
 * 食疗卡、饮片与加减、中成药成份）都对照同一套类别，一个核对器，不再每种输出各写各的检查（B061：病历记载鸡蛋过敏，饮食建议写「可食蒸蛋」）。
 * 分类表与出处：src/data/allergen-classes.source.json（运行时读精简表 allergen-classes.json）。
 * 读病历：过敏史一栏或带过敏提示词的分句里的类别词，按安全层同一套语境判定（否认、未问及不算）；读病历小任务的结果并集进来。
 * 匹配：每类单独扫描、取最左最长——排除词（蛋白质、鸡内金、乳香、鱼腥草…）与豁免配料也参与比长短，长的赢。
 */

type HerbEntry = { name: string; action: "avoid" | "caution"; sameAsFood?: string[] };
type ClassEntry = {
  id: string;
  labelZh: string;
  avoidPhraseZh: string;
  recordTerms: string[];
  genericRecordTerms: string[];
  intoleranceTerms: string[];
  singleCharTerms: string[];
  foodTerms: string[];
  cautionFoodTerms: string[];
  excludeTerms: string[];
  herbs: HerbEntry[];
  processedFormPattern?: { prefixes: string[]; exceptPrefixedNames: string[]; alsoHoneyFried: string[]; notHoneyFried: string[]; action: "avoid" | "caution" };
  medicineIngredientTerms: Array<{ term: string; action: "avoid" | "caution" }>;
  intoleranceHandling?: { foodAction?: string; herbAction?: string; medicineAction?: string };
  umbrellaOf?: Array<{ classId: string; foodAction: string; herbAction: string }>;
};
const DATA = table as unknown as { recordCues: string[]; singleCharRecordFollowers: string[]; classes: ClassEntry[] };
const CLASSES = new Map(DATA.classes.map((item) => [item.id, item]));
export const ALLERGY_CONCEPT_PREFIX = "allergy-";

export type AllergenAction = "avoid" | "caution";
export type RecordedAllergen = { classId: string; labelZh: string; kind: "allergy" | "intolerance"; quote: string };
type MentionPolarityAt = (text: string, index: number) => "affirmed" | "negated" | "excluded";

export function allergenClassLabel(classId: string): string | undefined {
  return CLASSES.get(classId)?.labelZh;
}

/** 写给患者的「请避开…」：取数据表的 avoidPhraseZh（乳及乳制品、蜂蜜及蜂产品本身已含制品，不能再拼「及其制品」）。 */
export function allergenAvoidPhrase(classIds: readonly string[]): string {
  return [...new Set(classIds)].map((classId) => CLASSES.get(classId)?.avoidPhraseZh).filter((phrase): phrase is string => Boolean(phrase)).join("、");
}

/** 读病历小任务用的清单项：每类一个「对X过敏」概念（id 为 allergy-<类>）。 */
export function allergenScreenConcepts(): Array<{ id: string; labelZh: string; definitionZh: string; notCountZh: string }> {
  return DATA.classes.map((item) => ({
    id: `${ALLERGY_CONCEPT_PREFIX}${item.id}`,
    labelZh: `对${item.labelZh}过敏或不耐受`,
    definitionZh: `病历写明对${item.labelZh}（如${item.recordTerms.slice(0, 5).join("、")}）过敏、过敏史里有它、食物过敏原检测阳性，或写明进食后出现皮疹、风团、瘙痒、口唇肿胀、喘憋、腹痛腹泻等过敏反应；不耐受也算（如${item.intoleranceTerms.slice(0, 2).join("、") || "乳糖不耐受"}）。`,
    notCountZh: "否认食物过敏；只是不爱吃、吃了胃不舒服而没有写过敏；家族成员的过敏；药物过敏（不属本清单）。",
  }));
}

function longestAt(text: string, index: number, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const candidate of candidates) {
    if (candidate && (!best || candidate.length > best.length) && text.startsWith(candidate, index)) best = candidate;
  }
  return best;
}

/** 病历里记录的过敏（确定性闭集读法）。polarityAt 用安全层的 clauseLocalMentionPolarityAt（本模块会进页面打包，不能反向引用安全层）。 */
export function recordedAllergensInText(text: string, polarityAt: MentionPolarityAt): RecordedAllergen[] {
  const found = new Map<string, RecordedAllergen>();
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const lineOffset = lineStart;
    lineStart += line.length + 1;
    const allergyLine = /^\s*(?:过敏史|过敏)\s*[：:]/u.test(line);
    let clauseStart = 0;
    for (const clause of line.split(/(?<=[，,；;。])/u)) {
      const clauseOffset = lineOffset + clauseStart;
      clauseStart += clause.length;
      if (!allergyLine && !DATA.recordCues.some((cue) => clause.includes(cue))) continue;
      for (const entry of DATA.classes) {
        if (found.has(entry.id)) continue;
        const candidates = [...entry.recordTerms, ...entry.intoleranceTerms, ...entry.excludeTerms, ...entry.singleCharTerms];
        for (let index = 0; index < clause.length; index += 1) {
          const term = longestAt(clause, index, candidates);
          if (!term) continue;
          const isSingle = term.length === 1 && entry.singleCharTerms.includes(term);
          const excluded = entry.excludeTerms.includes(term) && !entry.recordTerms.includes(term);
          if (excluded) { index += term.length - 1; continue; }
          if (isSingle && !DATA.singleCharRecordFollowers.some((follower) => clause.startsWith(follower, index + 1))) continue;
          const absolute = clauseOffset + index;
          const negated = polarityAt(text, absolute) !== "affirmed";
          if (negated) { index += term.length - 1; continue; }
          found.set(entry.id, {
            classId: entry.id,
            labelZh: entry.labelZh,
            kind: entry.intoleranceTerms.includes(term) && !entry.recordTerms.includes(term) ? "intolerance" : "allergy",
            quote: clause.replace(/[，,；;。]$/u, "").trim().slice(0, 60),
          });
          break;
        }
      }
    }
  }
  return [...found.values()];
}

/**
 * 引文里有没有说出这一类（本类的记录词、不耐受词、食物词或成份词，最左最长，排除词不算）。过敏类别是闭集：模型可以读、
 * 但它给的引文必须点出这一类，否则不采信（2026-10-26 C058：病历只记青霉素过敏，读病历小任务给了「对乳及乳制品过敏」，
 * 引文是病历原文却与乳制品无关）。
 */
function quoteNamesClass(entry: ClassEntry, quote: string): boolean {
  const named = [...entry.recordTerms, ...entry.intoleranceTerms, ...entry.foodTerms, ...entry.medicineIngredientTerms.map((item) => item.term)];
  const candidates = [...named, ...entry.excludeTerms];
  for (let index = 0; index < quote.length; index += 1) {
    const term = longestAt(quote, index, candidates);
    if (term) {
      if (named.includes(term) && !(entry.excludeTerms.includes(term) && !entry.recordTerms.includes(term))) return true;
      index += term.length - 1;
      continue;
    }
    if (entry.singleCharTerms.includes(quote[index]) && DATA.singleCharRecordFollowers.some((follower) => quote.startsWith(follower, index + 1))) return true;
  }
  return false;
}

/** 读病历小任务读出的过敏类别（allergy-<类>），并集进来；引文须点出这一类（quoteNamesClass）。 */
export function allergensFromScreen(present: ReadonlyArray<{ conceptId: string; quote: string }> | undefined): RecordedAllergen[] {
  return (present || []).flatMap((item) => {
    if (!item.conceptId.startsWith(ALLERGY_CONCEPT_PREFIX)) return [];
    const entry = CLASSES.get(item.conceptId.slice(ALLERGY_CONCEPT_PREFIX.length));
    if (!entry || !quoteNamesClass(entry, item.quote)) return [];
    const intolerance = entry.intoleranceTerms.some((term) => item.quote.includes(term)) && !entry.recordTerms.some((term) => item.quote.includes(term));
    return [{ classId: entry.id, labelZh: entry.labelZh, kind: intolerance ? "intolerance" as const : "allergy" as const, quote: item.quote }];
  });
}

/**
 * 过敏是「病历写明的」还是「按本次进食后的反应读出的疑似」：引文里有过敏陈述词（过敏、不耐受、sIgE…，同 recordCues）算写明，
 * 否则是读病历小任务按「进食后出现风团」读出的。两种写给患者的话不同——疑似的不能说「病历记录您对X过敏」
 * （2026-10-27 第二十四轮留出集 S128：进食海鲜后风团，过敏史「否认食物过敏史」，注意事项却写「病历记录您对海鲜过敏」）。
 * 两种都照样是硬约束（饮食、食疗、饮片、中成药都避开）。
 */
export function allergenStatedInRecord(allergen: Pick<RecordedAllergen, "quote">): boolean {
  return DATA.recordCues.some((cue) => allergen.quote.includes(cue));
}

/** 「病历记录您对A过敏或不耐受；本次进食B后发病，可能对B过敏」——前后两半按 allergenStatedInRecord 分。 */
export function allergenRecordPhrase(allergens: ReadonlyArray<RecordedAllergen>, label: (entry: RecordedAllergen) => string): string {
  const stated = allergens.filter(allergenStatedInRecord).map(label);
  const suspected = allergens.filter((entry) => !allergenStatedInRecord(entry)).map(label);
  return [
    stated.length > 0 ? `病历记录您对${stated.join("、")}过敏或不耐受` : "",
    suspected.length > 0 ? `本次进食${suspected.join("、")}后发病，可能对${suspected.join("、")}过敏` : "",
  ].filter(Boolean).join("；");
}

export function mergeRecordedAllergens(...lists: ReadonlyArray<ReadonlyArray<RecordedAllergen>>): RecordedAllergen[] {
  const merged = new Map<string, RecordedAllergen>();
  for (const item of lists.flat()) {
    const existing = merged.get(item.classId);
    if (!existing || (existing.kind === "intolerance" && item.kind === "allergy")) merged.set(item.classId, item);
  }
  return [...merged.values()];
}

type EffectiveClass = { entry: ClassEntry; foodCap?: AllergenAction; herbCap?: AllergenAction; foodAction: AllergenAction | "none"; herbAction: AllergenAction | "none"; medicineAction: AllergenAction | "none" };
const capAction = (action: AllergenAction, cap?: AllergenAction): AllergenAction => cap === "caution" ? "caution" : action;
const asAction = (value: string | undefined, fallback: AllergenAction | "none"): AllergenAction | "none" =>
  value === "avoid" || value === "caution" || value === "none" ? value : fallback;

function effectiveClasses(allergens: ReadonlyArray<RecordedAllergen>): EffectiveClass[] {
  const out = new Map<string, EffectiveClass>();
  const add = (entry: ClassEntry, kind: RecordedAllergen["kind"], foodCap?: AllergenAction, herbCap?: AllergenAction) => {
    const handling = kind === "intolerance" ? entry.intoleranceHandling : undefined;
    const next: EffectiveClass = {
      entry, foodCap, herbCap,
      foodAction: asAction(handling?.foodAction, "avoid"),
      herbAction: asAction(handling?.herbAction, "avoid"),
      medicineAction: asAction(handling?.medicineAction, "avoid"),
    };
    const existing = out.get(entry.id);
    if (!existing || (existing.foodCap && !foodCap)) out.set(entry.id, next);
  };
  for (const allergen of allergens) {
    const entry = CLASSES.get(allergen.classId);
    if (!entry) continue;
    add(entry, allergen.kind);
    for (const member of entry.umbrellaOf || []) {
      const memberEntry = CLASSES.get(member.classId);
      if (!memberEntry) continue;
      add(memberEntry, allergen.kind,
        member.foodAction === "caution" ? "caution" : undefined,
        member.herbAction === "caution" ? "caution" : undefined);
    }
  }
  return [...out.values()];
}

export type AllergenMatch = { classId: string; labelZh: string; term: string; action: AllergenAction };

/** 一段文字（饮食建议、食疗卡、中成药名与成份）里命中的过敏食材/成份。 */
export function allergenMatchesInText(text: string, allergens: ReadonlyArray<RecordedAllergen>, scope: "food" | "medicine" = "food"): AllergenMatch[] {
  const matches: AllergenMatch[] = [];
  for (const effective of effectiveClasses(allergens)) {
    const { entry } = effective;
    const baseAction = scope === "food" ? effective.foodAction : effective.medicineAction;
    if (baseAction === "none") continue;
    const actionOf = new Map<string, AllergenAction | "exclude">();
    for (const term of entry.excludeTerms) actionOf.set(term, "exclude");
    for (const herb of entry.herbs) actionOf.set(herb.name, herb.action);
    if (scope === "food") {
      for (const term of entry.cautionFoodTerms) actionOf.set(term, "caution");
      for (const term of entry.foodTerms) actionOf.set(term, "avoid");
    } else {
      for (const item of entry.medicineIngredientTerms) actionOf.set(item.term, item.action);
    }
    const candidates = [...actionOf.keys()];
    for (let index = 0; index < text.length; index += 1) {
      const term = longestAt(text, index, candidates);
      if (term) {
        const action = actionOf.get(term)!;
        if (action !== "exclude") {
          const capped = capAction(baseAction === "caution" ? "caution" : action, effective.foodCap);
          matches.push({ classId: entry.id, labelZh: entry.labelZh, term, action: capped });
        }
        index += term.length - 1;
        continue;
      }
      // 单字词（鱼、虾、蛋…）只在作为独立食物项时算：前后是列举、饮食动词或标点。
      const single = scope === "food" ? entry.singleCharTerms.find((char) => text[index] === char) : undefined;
      if (single && /^(?:$|[，,、；;。和或及与吃食喝忌少多])/u.test(text.slice(index + 1, index + 2)) && /(?:^|[，,、；;。和或及与吃食喝忌少多])$/u.test(text.slice(Math.max(0, index - 1), index))) {
        matches.push({ classId: entry.id, labelZh: entry.labelZh, term: single, action: capAction(baseAction, effective.foodCap) });
      }
    }
  }
  return matches;
}

/** 饮片（按处方原名，含炮制名）对照过敏类别：取最重的一档。 */
export function allergenHerbMatch(herbName: string, allergens: ReadonlyArray<RecordedAllergen>): AllergenMatch | undefined {
  const name = herbName.trim();
  if (!name) return undefined;
  let best: AllergenMatch | undefined;
  for (const effective of effectiveClasses(allergens)) {
    if (effective.herbAction === "none") continue;
    const { entry } = effective;
    let action: AllergenAction | undefined = entry.herbs.find((herb) => herb.name === name)?.action;
    const pattern = entry.processedFormPattern;
    if (!action && pattern && !pattern.notHoneyFried.includes(name)) {
      if (pattern.alsoHoneyFried.includes(name) ||
        (pattern.prefixes.some((prefix) => name.startsWith(prefix) && name.length > prefix.length) && !pattern.exceptPrefixedNames.includes(name))) {
        action = pattern.action;
      }
    }
    if (!action) continue;
    const capped = capAction(effective.herbAction === "caution" ? "caution" : action, effective.herbCap);
    if (!best || (best.action === "caution" && capped === "avoid")) best = { classId: entry.id, labelZh: entry.labelZh, term: name, action: capped };
  }
  return best;
}
