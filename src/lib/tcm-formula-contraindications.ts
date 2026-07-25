import contraindicationRulesJson from "../data/tcm-contraindication-rules.json" with { type: "json" };
import formulaAliasesJson from "../data/tcm-formula-aliases.json" with { type: "json" };
import { affirmedClinicalText } from "./clinical-polarity";

type ContraindicationRule = {
  id: string;
  formulaNames: string[];
  contraindicationTerms: string[];
  message: string;
  severity: "block" | "review";
  sourceRefs: string[];
};

const contraindicationRules = contraindicationRulesJson.rules as ContraindicationRule[];
const aliasToCanonical = new Map<string, string>();
for (const entry of formulaAliasesJson.entries) {
  aliasToCanonical.set(entry.canonical, entry.canonical);
  for (const alias of entry.aliases) aliasToCanonical.set(alias, entry.canonical);
}

function normalizedFormulaName(value: string): string {
  const compact = value
    .replace(/[（(]?\s*《[^》]+》\s*[）)]?/g, "")
    .replace(/(?:加减|化裁|加味)方?$/g, "")
    .replace(/\s+/g, "")
    .trim();
  return aliasToCanonical.get(compact) || compact;
}

const TCM_AFFIRMED_STATE_TERMS = [
  "小便不利",
  "饥而不欲食",
  "心中烦不得卧",
  "不得眠",
  "不放屁",
  "无食欲",
  "食不下",
  "不欲饮",
  "不恶寒",
  "不渴",
] as const;

function tcmAffirmedText(value: string | null | undefined): string {
  let protectedText = value || "";
  const replacements = new Map<string, string>();
  TCM_AFFIRMED_STATE_TERMS.forEach((term, index) => {
    const token = `TCMSTATE${String(index).padStart(2, "0")}`;
    if (protectedText.includes(term)) {
      protectedText = protectedText.replaceAll(term, token);
      replacements.set(token, term);
    }
  });
  const noSweatToken = "TCMSTATE99";
  protectedText = protectedText.replace(/无汗(?!出)/g, noSweatToken);
  replacements.set(noSweatToken, "无汗");
  // Contraindication screening fails safe, not silent: an unresolved finding ("可能有肝功能异常")
  // must still be able to trip a rule. Only explicit denials are excluded. This is the opposite
  // direction from recall-style callers, which stay affirmed-only.
  let affirmed = affirmedClinicalText(protectedText, "affirmed_or_uncertain") || "";
  for (const [token, term] of replacements) affirmed = affirmed.replaceAll(token, term);
  return affirmed;
}

export function formulaContraindicationIssues(
  formulaNames: string[],
  clinicalText: string,
): Array<{
  ruleId: string;
  message: string;
  matchedTerms: string[];
  sourceRefs: string[];
  severity: "block" | "review";
}> {
  const normalizedNames = new Set(formulaNames.map(normalizedFormulaName));
  const affirmed = tcmAffirmedText(clinicalText);
  return contraindicationRules.flatMap((rule) => {
    if (!rule.formulaNames.some((name) => normalizedNames.has(normalizedFormulaName(name)))) return [];
    const matchedTerms = rule.contraindicationTerms.filter((term) => affirmed.includes(term));
    return matchedTerms.length > 0
      ? [{
          ruleId: rule.id,
          message: rule.message,
          matchedTerms,
          sourceRefs: rule.sourceRefs,
          severity: rule.severity,
        }]
      : [];
  });
}

export function firstFormulaContraindicationIssue(
  formulaNames: string[],
  clinicalText: string,
): string | undefined {
  return formulaContraindicationIssues(formulaNames, clinicalText)
    .find((issue) => issue.severity === "block")
    ?.ruleId;
}
