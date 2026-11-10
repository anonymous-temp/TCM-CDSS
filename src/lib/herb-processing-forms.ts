import processingSource from "../data/tcm-herb-processing-forms.source.json" with { type: "json" };
import { recordedFindingReading } from "./diagnosis-safety";
import { getTcmHerbDoseLimit, getTcmHerbGenerationSafetyProfile, isKnownTcmHerbName } from "./tcm-knowledge";
import { compositionIdentityName, governedFormulaOriginalPreparations } from "./tcm-formula-provenance";

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

/**
 * 改出来的饮片名要知识库认得、剂量边界与原药相同；有毒的药不在这里改（附子、半夏一类的炮制规格与剂量由毒性药规则与医生定，
 * 改名会让注意事项里按药名写的毒性提示对不上）。
 */
function knownWithSameDose(form: string, base: string): boolean {
  if (!isKnownTcmHerbName(form)) return false;
  if (getTcmHerbGenerationSafetyProfile(base).isToxic || getTcmHerbGenerationSafetyProfile(form).isToxic) return false;
  const formLimit = getTcmHerbDoseLimit(form);
  const baseLimit = getTcmHerbDoseLimit(base);
  if (!formLimit) return false;
  return !baseLimit || (formLimit.min === baseLimit.min && formLimit.max === baseLimit.max);
}

function recordAffirms(recordText: string, cue: string): boolean {
  if (!recordText.includes(cue)) return false;
  const reading = recordedFindingReading(recordText, cue);
  return reading === "affirmed" || reading === "conflicting";
}

/** 原方原文写的炮制换成饮片名：土炒→土炒白术，炒→炒山药，酒炒→酒白芍，制→制苍术。 */
function preparedNameFromOriginal(base: string, preparation: string): string | undefined {
  const candidates = [
    `${preparation}${base}`,
    preparation.endsWith("炒") && preparation.length === 2 ? `${preparation[0]}${base}` : "",
    preparation === "蜜炙" ? `炙${base}` : "",
  ].filter(Boolean);
  return candidates.find((name) => knownWithSameDose(name, base));
}

export function processedHerbName(
  name: string,
  context: { purposeText?: string; recordText?: string; formulaName?: string },
): string | undefined {
  const base = String(name || "").trim();
  if (!base || PREPARED_PREFIX.test(base)) return undefined;
  const identity = compositionIdentityName(base);
  if (context.formulaName) {
    for (const entry of governedFormulaOriginalPreparations(context.formulaName.replace(/(?:加减|化裁|加味)$/u, ""))) {
      if (entry.identity !== identity) continue;
      if (entry.rawName && entry.rawName !== base && knownWithSameDose(entry.rawName, base)) return entry.rawName;
      if (entry.preparation) {
        const prepared = preparedNameFromOriginal(base, entry.preparation);
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

/** 文本里这味药的生品名换成交付的饮片名（前面已带炮制字、或是方名的一部分时不换）。 */
export function withProcessedHerbMentions(text: string, renames: ReadonlyMap<string, string>): string {
  let out = String(text || "");
  for (const [from, to] of renames) {
    out = out.replace(new RegExp(`(?<![${PREPARED_CHAR_CLASS}])${from}(?![${FORMULA_SUFFIX_CLASS}])`, "gu"), to);
  }
  return out;
}
