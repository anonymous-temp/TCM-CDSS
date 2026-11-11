import processingSource from "../data/tcm-herb-processing-forms.source.json" with { type: "json" };
import purposeProcessingSource from "../data/tcm-herb-purpose-processing.json" with { type: "json" };
import { recordedFindingReading } from "./diagnosis-safety";
import { knownWithSameDose, originalPreparedHerbName } from "./formula-baseline-display";
import { getTcmHerbDoseLimit, isKnownTcmHerbName } from "./tcm-knowledge";
import { compositionIdentityName, governedFormulaOriginalPreparations, identifyKnownFormulaNames, type OriginalFormulaContext } from "./tcm-formula-provenance";

/**
 * 同一味药炮制前后功用不同时交付哪种饮片（2026-11-08 第三十七轮，甲方 11.05 病历11/12「便溏用生白术」、病历10「完带汤写原方却用白术、山药」、
 * 病历3「汗出肢冷加牡蛎（生品重镇安神）」）。规则表 tcm-herb-processing-forms.source.json 逐条取《中药炮制学》原文。
 * 只改模型没写炮制、写的是生品名的那一味；命名方原文自带的炮制（完带汤「白术一两（土炒）」）优先。
 * 改出来的名字必须是知识库认得、有药典或参考用量的饮片名（剂量边界与原药相同），否则不改。
 */
type ProcessingRule = {
  herb: string;
  form: string;
  always?: boolean;
  recordCues: string[];
  purposeWords: string[];
  rawPurposeWords: string[];
};
const SOURCE = processingSource as { rules: ProcessingRule[]; preparedPrefixes: string[]; formulaNameSuffixes: string[] };
const RULES = SOURCE.rules;
/** 已带炮制或另一种饮片名的不动（「炒白术」「生白术」「白术炭」）。前缀表在数据文件里。 */
const PREPARED_PREFIX = new RegExp(`^(?:${[...SOURCE.preparedPrefixes].sort((a, b) => b.length - a.length).join("|")})`, "u");
const PREPARED_CHAR_CLASS = [...new Set(SOURCE.preparedPrefixes.join(""))].join("");
const FORMULA_SUFFIX_CLASS = SOURCE.formulaNameSuffixes.join("");

function recordAffirms(recordText: string, cue: string): boolean {
  if (!recordText.includes(cue)) return false;
  const reading = recordedFindingReading(recordText, cue);
  return reading === "affirmed" || reading === "conflicting";
}

export function processedHerbName(
  name: string,
  context: { purposeText?: string; recordText?: string; formulaName?: string; formulaContext?: OriginalFormulaContext },
): string | undefined {
  const base = String(name || "").trim();
  if (!base || PREPARED_PREFIX.test(base)) return undefined;
  const identity = compositionIdentityName(base);
  if (context.formulaName) {
    for (const entry of governedFormulaOriginalPreparations(context.formulaName.replace(/(?:加减|化裁|加味)$/u, ""), context.formulaContext)) {
      if (entry.identity !== identity) continue;
      if (entry.preparation) {
        const prepared = originalPreparedHerbName(base, entry.preparation);
        if (prepared) return prepared;
      }
    }
  }
  const rule = RULES.find((item) => item.herb === base);
  if (!rule || !knownWithSameDose(rule.form, base)) return undefined;
  const purpose = String(context.purposeText || "");
  const purposeHit = rule.purposeWords.some((word) => purpose.includes(word));
  if (rule.purposeWords.length > 0 && !purposeHit) return undefined;
  const cueHit = rule.recordCues.length > 0 && rule.recordCues.some((cue) => recordAffirms(String(context.recordText || ""), cue));
  if (rule.recordCues.length > 0 && !cueHit) return undefined;
  // 功用里生品的用途（利水、消肿）与炮制品的用途（健脾、止泻）都写了、病历又有便溏这类线索时，交付炮制品（第四十一轮，独立新病历 m13：
  // 参苓白术散合防己黄芪汤的白术写「健脾益气，渗利水湿」、病历大便溏薄，仍交付生白术）。只写生品用途的照旧留生品。
  if (rule.rawPurposeWords.some((word) => purpose.includes(word)) && !(cueHit && purposeHit)) return undefined;
  return rule.form;
}

/**
 * 文本里这味药的生品名换成交付的饮片名（前面已带炮制字、或是方名的一部分时不换）。
 * 方名以药名开头的（龙胆泻肝汤、黄芪建中汤、当归四逆汤）整个方名不动：此前只看药名后一个字是不是剂型字，
 *「龙胆」改「酒龙胆」时「龙胆泻肝汤」被改成了「酒龙胆泻肝汤」（第四十二轮，原方炮制改读原方组成表后暴露）。
 */
export function withProcessedHerbMentions(text: string, renames: ReadonlyMap<string, string>): string {
  let out = String(text || "");
  if (renames.size === 0 || !out) return out;
  const formulaNames = [...new Set(identifyKnownFormulaNames(out))]
    .filter((name) => [...renames.keys()].some((from) => name.includes(from)))
    .sort((left, right) => right.length - left.length);
  const held: string[] = [];
  for (const name of formulaNames) {
    out = out.split(name).join(`\u0000${held.length}\u0000`);
    held.push(name);
  }
  for (const [from, to] of renames) {
    out = out.replace(new RegExp(`(?<![${PREPARED_CHAR_CLASS}])${from}(?![${FORMULA_SUFFIX_CLASS}])`, "gu"), to);
  }
  return out.replace(/\u0000(\d+)\u0000/gu, (_match, index: string) => held[Number(index)] ?? "");
}

/**
 * 按用途选饮片规格（2026-11-11 第四十二轮）：表 tcm-herb-purpose-processing.json 由 scripts/build-herb-purpose-processing.py 从《中药学》（十三五）
 * 【用法用量】【使用注意】【功效】原文切出（「平肝、清肝宜生用」「收敛固涩、制酸止痛煅用」「法半夏长于燥湿化痰…姜半夏长于…降逆止呕」，
 * 以及「内服一般炮制后用」一类内服须炮制的药）。线上 new40：天麻钩藤饮平肝潜阳交付了煅石决明（煅字来自调剂编码标准的组成），
 * 两例内服写了裸半夏。这一处只做一件事：给定药名、已写的规格、这味药在方中写的功用和剂量，按教材原句判该交付哪种规格。
 *  · 改规格（已写了炮制，或方剂目录给了调剂名）：只在功用里完整出现另一规格的用途短语、而当前规格的用途一个字都对不上时改
 *   （煅石决明「平肝潜阳」→ 石决明）；内服须炮制的药不改回生品；
 *  · 加炮制（生品名）：第三十七轮那九味仍按旧表（按病历线索加）；其余按用途短语的半词对上的规格，生品自己的用途也对上时不加；
 *  · 内服须炮制的药写了裸名：按用途选规格，选不出用教材第一个规格（法半夏）或制品（制天南星、制川乌…）；
 *  · 「多…用」「可…用」一类倾向性说法（weak）不据此改；
 *  · 改出来的名字须是知识库认得、有剂量上限的饮片名，且已开剂量不超过它的上限，否则不改。
 */

type PurposeFormRow = { prefix: string; purposes: string[]; weak: boolean; quote: string };
type PurposeHerbRow = { herb: string; forms: PurposeFormRow[]; internalMustProcess?: { quote: string } };
const PURPOSE_HERBS = new Map((purposeProcessingSource as { herbs: PurposeHerbRow[] }).herbs.map((row) => [row.herb, row]));
const RULE_MANAGED_HERBS = new Set(RULES.map((rule) => rule.herb));

/** 炮制栏或药名前缀的写法折成表里的规格前缀（蜜炙→蜜、酒炙→酒、姜汁炙→姜、炒焦→焦、炒炭→炭、麸炒→炒、生→""）。 */
export function processingPrefixOf(processing: string): string {
  const p = String(processing || "").replace(/[（）()\s、，,]/gu, "").replace(/^(?:用|宜)/u, "").replace(/(?:用|品|后用)$/u, "");
  if (!p || p === "生") return "";
  if (/炭$/u.test(p)) return "炭";
  if (p === "炒焦" || p === "焦") return "焦";
  if (p === "醋淬") return "煅";
  if (/^姜(?:汁)?(?:炙|制)?$/u.test(p)) return "姜";
  const head = p.match(/^(蜜|酒|醋|盐)(?:水)?(?:炙|制|炒)?$/u);
  if (head) return head[1];
  if (p === "炙") return "蜜";
  if (p === "麸炒" || p === "清炒" || p === "炒黄" || p === "微炒") return "炒";
  return p;
}

/** 规格前缀拼成知识库认得、有剂量上限的饮片名（侧柏叶 + 炭 → 侧柏炭；甘草 + 蜜 → 炙甘草）。 */
function formNameFor(base: string, prefix: string): string | undefined {
  const candidates = prefix === ""
    ? [base]
    : prefix === "炭"
      ? [`${base}炭`, `${base.slice(0, -1)}炭`, `${base.slice(1)}炭`]
      : prefix === "蜜"
        ? [`蜜${base}`, `炙${base}`]
        : [`${prefix}${base}`];
  return candidates.find((name) => isKnownTcmHerbName(name) && Boolean(getTcmHerbDoseLimit(name)));
}

/** 用途短语切成比对用的词：两三个字的整词；四个字的拆成前后两半；更长的取前两字和整句。 */
function purposeUnits(phrase: string): string[] {
  if (phrase.length <= 3) return [phrase];
  if (phrase.length === 4) return [phrase.slice(0, 2), phrase.slice(2)];
  return [phrase.slice(0, 2), phrase];
}

type FormScore = { prefix: string; units: number; phrases: number; addPhrases: number };

/** 两个字、太泛的用途短语（「解毒」「止血」「止咳」）不作改规格的依据：同一味药功用里写这两个字，多半说的是别的用途。 */
const GENERIC_PURPOSE_PHRASES = new Set(["解毒", "清热", "止血", "止咳", "化瘀", "利尿", "驱虫", "透疹", "涌吐", "消食", "止泻", "止痛", "久咳"]);

function scoreForms(row: PurposeHerbRow, purposeText: string): FormScore[] {
  const byPrefix = new Map<string, string[]>();
  for (const form of row.forms) {
    if (form.weak) continue;
    byPrefix.set(form.prefix, [...(byPrefix.get(form.prefix) || []), ...form.purposes]);
  }
  // 同一味药几个规格共有的词（半夏三个规格都「化痰」）不算区分。
  const unitOwners = new Map<string, Set<string>>();
  for (const [prefix, phrases] of byPrefix) for (const unit of phrases.flatMap(purposeUnits)) unitOwners.set(unit, new Set([...(unitOwners.get(unit) || []), prefix]));
  return [...byPrefix].map(([prefix, phrases]) => ({
    prefix,
    units: new Set(phrases.flatMap(purposeUnits).filter((unit) => (unitOwners.get(unit)?.size || 0) === 1 && purposeText.includes(unit))).size,
    // 改规格：整句用途短语出现，两个字的泛词不算。
    phrases: phrases.filter((phrase) => purposeText.includes(phrase) && !GENERIC_PURPOSE_PHRASES.has(phrase)).length,
    // 给生品加炮制：整句用途短语出现且不短于三个字（「益气补中」「补肝肾」「升阳举陷」）。
    addPhrases: phrases.filter((phrase) => phrase.length >= 3 && purposeText.includes(phrase)).length,
  }));
}

function uniqueTop(scores: FormScore[], key: "units" | "phrases" | "addPhrases"): FormScore | undefined {
  const sorted = [...scores].sort((a, b) => b[key] - a[key]);
  if (!sorted[0] || sorted[0][key] < 1) return undefined;
  return sorted[1] && sorted[1][key] === sorted[0][key] ? undefined : sorted[0];
}

function defaultMustProcessPrefix(row: PurposeHerbRow): string {
  const named = row.forms.find((form) => !form.weak && form.prefix && form.prefix !== "炭");
  if (named) return named.prefix;
  return /醋炙/u.test(row.internalMustProcess?.quote || "") ? "醋" : "制";
}

/** 教材写明内服须炮制的药（半夏、附子、川乌、天南星…）。 */
export function internalMustProcessHerb(name: string): boolean {
  return Boolean(PURPOSE_HERBS.get(String(name || "").trim())?.internalMustProcess);
}

export type PurposeProcessingDecision = { name: string; base: string; prefix: string; quote: string };

/**
 * name：交付前的药名（可带前缀，如「煅石决明」）；processing：炮制栏（可空）；purposeText：这味药在方中写的功用、角色、病机；
 * grams：已开剂量（克）。返回应交付的饮片名，不需要改时返回 undefined。
 */
export function purposeProcessedHerbName(
  name: string,
  processing: string | undefined,
  purposeText: string,
  grams?: number,
): PurposeProcessingDecision | undefined {
  const written = String(name || "").trim();
  if (!written) return undefined;
  let base = written;
  let current = processingPrefixOf(processing || "");
  if (!PURPOSE_HERBS.has(base)) {
    const prefixed = written.match(/^(煅|炒|焦|蜜|炙|酒|醋|盐|煨|姜|制|法|清|生)(.{2,})$/u);
    const suffixed = written.match(/^(.{2,})炭$/u);
    if (prefixed && PURPOSE_HERBS.has(prefixed[2])) { base = prefixed[2]; current = processingPrefixOf(prefixed[1]); }
    else if (suffixed && PURPOSE_HERBS.has(suffixed[1])) { base = suffixed[1]; current = "炭"; }
  }
  const row = PURPOSE_HERBS.get(base);
  if (!row) return undefined;
  const mustProcess = Boolean(row.internalMustProcess);
  const text = String(purposeText || "");
  const scores = scoreForms(row, text);
  const scoreOf = (prefix: string) => scores.find((item) => item.prefix === prefix);
  let target: string | undefined;
  if (current) {
    // 改规格：另一规格的用途短语完整出现，当前规格一个词都对不上。
    const top = uniqueTop(scores, "phrases");
    const mine = scoreOf(current);
    if (top && top.prefix !== current && !(mine && (mine.units > 0 || mine.phrases > 0)) && !(mustProcess && top.prefix === "")) target = top.prefix;
  } else {
    if (RULE_MANAGED_HERBS.has(base) && !mustProcess) return undefined;
    const raw = scoreOf("");
    if (mustProcess) {
      // 内服须炮制：在几种炮制品里按用途的区分词选（姜半夏「降逆止呕」），选不出用默认规格。
      const top = uniqueTop(scores.filter((item) => item.prefix !== ""), "units");
      target = top ? top.prefix : defaultMustProcessPrefix(row);
    } else {
      const top = uniqueTop(scores.filter((item) => item.prefix !== ""), "addPhrases");
      if (top && !(raw && raw.units > 0)) target = top.prefix;
    }
  }
  if (target === undefined || target === current) return undefined;
  const next = formNameFor(base, target);
  // 改回生品时药名本身可能已是生品名（「石决明」＋炮制栏「煅」），比的是规格不是名字。
  if (!next || (next === written && !(target === "" && current))) return undefined;
  const limit = getTcmHerbDoseLimit(next);
  if (!limit || typeof limit.max !== "number" || (typeof grams === "number" && Number.isFinite(grams) && grams > limit.max)) return undefined;
  const quote = target === "" || !mustProcess || scoreOf(target)?.units
    ? (row.forms.find((form) => form.prefix === target && !form.weak)?.quote || row.internalMustProcess?.quote || "")
    : row.internalMustProcess?.quote || "";
  return { name: next, base, prefix: target, quote };
}
