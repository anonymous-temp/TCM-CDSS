import cautionTableJson from "../data/tcm-herb-record-caution.source.json";
import { affirmedClinicalText } from "./clinical-polarity";
import { textbookDistinctHerbKey, textbookHerbCaution, textbookHerbsWithCaution } from "./herb-textbook-identity";
import { formulaCompilationReferences, governedDosageFormVariantComposition } from "./tcm-formula-provenance";

/**
 * 饮片的教材【使用注意】与本例病历对照（2026-10-19）。
 *
 * 甲方标准病历 3 三次生成都是熟地黄 12g 为君，而病历记「食欲下降…大便稀溏」；《中药学》熟地黄【使用注意】「凡气滞痰多，
 * 湿盛中满、食少便溏者忌服」（加味四物汤原方用的是生地黄，模型换成了熟地黄）。独立评审三次都判药味不通过。
 * 同一类：教材注意里写着「便溏 / 泄泻者忌服、慎用、不宜」的饮片有 35 味（当归、麦冬、玄参、知母、栀子、苦杏仁…）。
 *
 * 判据（只认已记录的事实，不推断）：
 *  1 教材这味药的【使用注意】里有一句写着便溏类条件（「食少便溏」「脾虚便溏」「大便溏泻」「肠滑泄泻」）并带忌服/慎用/不宜；
 *    讲不良反应的句子（「可引起腹泻」）不算——那句没有忌慎词，或者用的是「腹泻」（只作病历写法，不作注意条件）；
 *  2 病历阳性面里有便溏类表现（同时写着「大便尚正常」「二便调」的不算当前表现）；条件写了「食少」的，还要有食欲差一类表现；条件带限定（脾虚、气虚、脾胃虚寒，含紧挨在前、
 *    单独成项的「脾胃虚寒，」）的，已签名的证候里要有对应的虚证——湿热泄泻用栀子不在此列；
 *  3 这味药不是所选方原有的药味（原方是教材按证选定的整体，原方药味另由医生权衡）；生地黄与熟地黄按教材分作两味
 *    （加味四物汤原方生地黄、处方换成熟地黄，算新换入的）。
 * 「生用……者忌用」一句（何首乌）只管生品，处方写制首乌时不算。
 */

type CautionTable = {
  contraindicationWords: string[];
  conditionItemSeparators: string[];
  itemLeadingConnectives: string[];
  formulaNameModifierSuffixes: string[];
  looseStool: { cautionTerms: string[]; recordTerms: string[]; recordNormalTerms: string[] };
  poorAppetite: { cautionTerms: string[]; recordTerms: string[] };
  qualifiers: Array<{ cautionTerms: string[]; syndromeTerms: string[] }>;
};

const TABLE = cautionTableJson as unknown as CautionTable;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternation = (values: readonly string[]) => new RegExp(values.map(escape).join("|"), "u");
const CONTRAINDICATION = alternation(TABLE.contraindicationWords);
const ITEM_SEPARATOR = new RegExp(`(?:${[...TABLE.conditionItemSeparators].sort((a, b) => b.length - a.length).map(escape).join("|")})`, "u");
const LOOSE_IN_CAUTION = alternation(TABLE.looseStool.cautionTerms);
const APPETITE_IN_CAUTION = alternation(TABLE.poorAppetite.cautionTerms);
const MODIFIER_SUFFIX = new RegExp(`(?:${TABLE.formulaNameModifierSuffixes.map(escape).join("|")})$`, "u");
/** 「加味四物汤加减」→「加味四物汤」：取所选方的基础方名。 */
const baseFormulaName = (name: unknown) => String(name || "").trim().replace(MODIFIER_SUFFIX, "");
const LEADING_CONNECTIVES = new RegExp(`^(?:${TABLE.itemLeadingConnectives.map(escape).join("|")})+`, "u");

type CautionCondition = { text: string; verb: string; needsAppetite: boolean; qualifier?: { cautionTerms: string[]; syndromeTerms: string[] }; rawOnly: boolean };

function qualifierIn(text: string): CautionTable["qualifiers"][number] | undefined {
  return TABLE.qualifiers.find((group) => group.cautionTerms.some((term) => text.includes(term)));
}

/** 教材注意里便溏类的条件（每句一个或几个），按上面判据 1 解析。 */
export function looseStoolCautionConditions(caution: string): CautionCondition[] {
  const conditions: CautionCondition[] = [];
  for (const sentence of String(caution || "").split(/[。；;]/u)) {
    const verb = sentence.match(CONTRAINDICATION);
    if (!verb || verb.index == null) continue;
    const subject = sentence.slice(0, verb.index);
    if (!LOOSE_IN_CAUTION.test(subject)) continue;
    // 「本品苦寒，」这类讲药性的引子不是条件；条件项前的「故」「凡」也去掉。
    const items = subject.split(ITEM_SEPARATOR)
      .filter((item) => !item.trim().startsWith("本品"))
      .map((item) => item.trim().replace(LEADING_CONNECTIVES, "").replace(/者$/u, "").trim());
    for (const [position, item] of items.entries()) {
      if (!LOOSE_IN_CAUTION.test(item)) continue;
      // 紧挨在前、单独成项的限定（「脾胃虚寒，食少便溏者」「脾胃虚弱，肠滑泄泻者」）一并算这一条的限定。
      const previous = position > 0 ? items[position - 1] : "";
      const previousIsQualifierOnly = Boolean(previous) && Boolean(qualifierIn(previous)) && !LOOSE_IN_CAUTION.test(previous);
      conditions.push({
        text: `${previousIsQualifierOnly ? `${previous}，` : ""}${item}`,
        verb: verb[0],
        needsAppetite: APPETITE_IN_CAUTION.test(item),
        qualifier: qualifierIn(item) || (previousIsQualifierOnly ? qualifierIn(previous) : undefined),
        rawOnly: /生用/u.test(sentence),
      });
    }
  }
  return conditions;
}

/** 病历阳性面里出现的这一类表现（取原写法，供说明）。 */
function affirmedTerms(affirmed: string, terms: readonly string[]): string[] {
  return terms.filter((term) => affirmed.includes(term)).filter((term, _index, all) => !all.some((other) => other !== term && other.includes(term)));
}

export type HerbRecordCautionConflict = {
  herb: string;
  monograph: string;
  caution: string;
  cautionLine?: number;
  condition: string;
  /** 教材原句里的忌慎词（忌服、慎用、不宜…）。 */
  verb: string;
  /** 这一句只说生品（「生用……者忌用」）。 */
  rawOnly: boolean;
  recordFindings: string[];
};

/**
 * 一味药与本例病历的便溏类使用注意冲突时给出依据。recordText 是病历全文（接地文本），syndromeText 是已签名的证候与病性。
 * 只看这一味药本身；是不是原方药味由调用方判断（见 herbRecordCautionConflicts）。
 */
export function herbRecordCautionConflict(herbName: string, recordText: string, syndromeText = ""): HerbRecordCautionConflict | undefined {
  const caution = textbookHerbCaution(herbName);
  if (!caution) return undefined;
  const conditions = looseStoolCautionConditions(caution.text);
  if (conditions.length === 0) return undefined;
  const affirmed = affirmedClinicalText(recordText) || "";
  const looseFindings = affirmedTerms(affirmed, TABLE.looseStool.recordTerms);
  if (looseFindings.length === 0) return undefined;
  // 同时写着大便正常的，稀溏不是当前表现（既往、间断）。
  if (TABLE.looseStool.recordNormalTerms.some((term) => affirmed.includes(term))) return undefined;
  const appetiteFindings = affirmedTerms(affirmed, TABLE.poorAppetite.recordTerms);
  const processed = /^[制炙]/u.test(String(herbName || "").trim());
  for (const condition of conditions) {
    if (condition.rawOnly && processed) continue;
    if (condition.needsAppetite && appetiteFindings.length === 0) continue;
    if (condition.qualifier && !condition.qualifier.syndromeTerms.some((term) => syndromeText.includes(term))) continue;
    return {
      herb: String(herbName || "").trim(),
      monograph: caution.herb,
      caution: caution.text,
      cautionLine: caution.line,
      condition: condition.text,
      verb: condition.verb,
      rawOnly: condition.rawOnly,
      recordFindings: [...(condition.needsAppetite ? appetiteFindings : []), ...looseFindings],
    };
  }
  return undefined;
}

/**
 * 处方里与病历冲突、又不是所选方原有药味的那几味（判据 3）。formulaNames 是处方的方名与方名引用
 *（「加味四物汤加减」按「加味四物汤」取目录组成）；目录编不出组成时由 extraBaseIngredients 补教材组成。
 */
export function textbookBaseIngredients(
  row: {
    formulas?: readonly string[];
    composition?: readonly string[];
    compositionByFormula?: ReadonlyArray<{ formula?: string; herbs?: readonly string[] }>;
  } | undefined,
  candidateNames: readonly string[],
): string[] {
  const names = candidateNames.map((name) => String(name || "").trim()).filter(Boolean);
  const named = (formula: unknown) => typeof formula === "string" && Boolean(formula) && names.some((name) => name.includes(formula));
  if (row?.compositionByFormula?.length) {
    return row.compositionByFormula.filter((item) => named(item.formula)).flatMap((item) => [...(item.herbs || [])]);
  }
  const base = (row?.formulas || []).some(named) ? [...(row?.composition || [])] : [];
  // 教材行没有分方组成、方剂目录也没有这个名字的方（2026-10-20 第八轮，留出例 S145 痛风·湿热阻痹「四妙散合宣痹汤」：教材只列了宣痹汤的药，
  // 目录只收同组成的「四妙丸」）：按剂型互换的名字取受治理目录里的组成补进来，否则这首方的药（苍术）既不算原方药味、也不计入方名覆盖。
  const extras = (row?.formulas || [])
    .filter((formula) => named(formula) && formulaCompilationReferences([formula]).length === 0)
    .flatMap((formula) => governedDosageFormVariantComposition(formula));
  return extras.length > 0 ? [...new Set([...base, ...extras])] : base;
}

export function herbRecordCautionConflicts(
  herbs: ReadonlyArray<{ name?: unknown; role?: unknown }>,
  formulaNames: readonly string[],
  recordText: string,
  syndromeText = "",
  /** 目录编不出组成的方（加味四物汤同名方多、不可锁定）由调用方补教材该证代表方的组成。 */
  extraBaseIngredients: readonly string[] = [],
): Array<HerbRecordCautionConflict & { index: number; role?: string }> {
  const bases = formulaNames
    .map(baseFormulaName)
    .filter(Boolean);
  const baseKeys = new Set([
    ...formulaCompilationReferences([...new Set(bases)]).flatMap((reference) => reference.ingredients),
    ...extraBaseIngredients,
  ].map((name) => textbookDistinctHerbKey(name)).filter(Boolean));
  return herbs.flatMap((herb, index) => {
    const name = typeof herb.name === "string" ? herb.name.trim() : "";
    if (!name || baseKeys.has(textbookDistinctHerbKey(name))) return [];
    const conflict = herbRecordCautionConflict(name, recordText, syndromeText);
    return conflict ? [{ ...conflict, index, ...(typeof herb.role === "string" ? { role: herb.role } : {}) }] : [];
  });
}

/**
 * 给 M04 模型的一段话（事先列出，免得修复）：本例病历记着的便溏类表现，以及《中药学》写明此类患者忌服、慎用、不宜的饮片。
 * 这些药不要新增或换入；所选代表方原有的药味可以保留，保留时注意事项写明。没有冲突时为空串，提示词不变。
 * formulaNames、extraBaseIngredients 与 herbRecordCautionConflicts 同义，只用来把原方药味从「不要新增」里分出来。
 */
export function herbRecordCautionPromptSection(
  recordText: string,
  syndromeText = "",
  formulaNames: readonly string[] = [],
  extraBaseIngredients: readonly string[] = [],
): string {
  const conflicts = textbookHerbsWithCaution()
    .map((name) => herbRecordCautionConflict(name, recordText, syndromeText))
    .filter((item): item is HerbRecordCautionConflict => Boolean(item));
  if (conflicts.length === 0) return "";
  const bases = formulaNames.map(baseFormulaName).filter(Boolean);
  const baseKeys = new Set([
    ...formulaCompilationReferences([...new Set(bases)]).flatMap((reference) => reference.ingredients),
    ...extraBaseIngredients,
  ].map((name) => textbookDistinctHerbKey(name)).filter(Boolean));
  const kept = conflicts.filter((item) => baseKeys.has(textbookDistinctHerbKey(item.monograph))).map((item) => item.monograph);
  const findings = [...new Set(conflicts.flatMap((item) => item.recordFindings))];
  const listed = conflicts.map((item) => `${item.rawOnly ? "生" : ""}${item.monograph}（${item.condition}者${item.verb}）`).join("、");
  return [
    `【饮片使用注意与本例】病历记有${findings.join("、")}。《中药学》【使用注意】写明此类患者忌服、慎用或不宜的饮片：${listed}。`,
    `这些药不要新增进处方，也不要用它们替换代表方里的药味${kept.length > 0 ? `；所选代表方原有的${kept.join("、")}可以保留，保留时在注意事项里写明` : ""}。`,
  ].join("");
}
