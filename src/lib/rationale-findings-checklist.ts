import type { CaseState } from "./diagnosis-types";
import { clinicalGroundingText } from "./diagnosis-safety";
import { isUnrecordedInspectionFieldValue } from "./clinical-state";

/**
 * 辨证依据要逐一交代去向的已记录表现（2026-10-26 甲方测评病历 3「辨证依据简单，不全面」）。
 *
 * 提示词早有「病历记录的每一项主要伴随表现都要讲到它属于哪一病机」，模型仍常只挑两三项：产后头痛的病历记了
 * 神疲乏力、食欲下降、小便清长、大便稀溏，依据只讲了头痛、头晕心悸、面色少华。泛泛的规则模型会漏，逐项清单才会照着写
 * （漏项靠模型自评几乎发现不了，第二十二轮研究）。清单取事实层抽出的「明确陈述为存在」的症状（每条引文都要在病历原文里），
 * 去掉主诉里已有的；只是列给模型看，不改任何判定。
 */
/**
 * 病历记了舌象、脉象时排在清单最前（2026-10-27 第二十五轮：甲方 10.26 测评病历 3、11「证候分析不全面」，评审指出依据没引病历里的
 * 「舌淡白、苔薄白、脉细弱」；甲方口径是「症状＋舌脉→证型」。清单此前只有事实层的症状）。未记录、未查的不列。
 */
function recordedTonguePulse(state: CaseState): string[] {
  return ([["tongue", state.tongue], ["pulse", state.pulse]] as const)
    .filter(([field, value]) => !isUnrecordedInspectionFieldValue(value, field))
    .map(([, value]) => String(value || "").normalize("NFKC").replace(/^\s*(?:舌象|脉象)\s*[:：]\s*/u, "").trim())
    // 「脉象难配合」「舌象患儿不配合」是没能看到，不是所见；列进清单会逼模型去解释它（C079：「脉象难配合系患儿年幼…不能据此另立他证」）。
    .filter((value) => value.length >= 2 && !/配合/u.test(value));
}

export function rationaleFindingsChecklist(state: CaseState, maxItems = 12): string[] {
  const source = clinicalGroundingText(state);
  const chief = String(state.chiefComplaint || "").normalize("NFKC");
  const terms: string[] = recordedTonguePulse(state).slice(0, 2);
  for (const item of state.clinicalFacts?.affirmedSymptoms || []) {
    const term = String(item?.term || "").trim();
    const quote = String(item?.quote || "").trim();
    if (term.length < 2 || !quote || !source.includes(quote)) continue;
    if (chief.includes(term)) continue;
    if (terms.some((existing) => existing.includes(term) || term.includes(existing))) continue;
    terms.push(term);
    if (terms.length >= maxItems) break;
  }
  return terms;
}

/**
 * 主诉里的主症：事实层「明确存在」、引文在病历原文里、且词条出现在主诉中的表现（清单为免重复正好把它们去掉了）。
 * 2026-10-27：甲方病历 10 有一次依据只讲经量、经色，没讲主症「月经周期缩短」，评审按甲方 10.12「不能遗漏主症」判不通过。
 * 取事实层词条而不是直接切主诉：真实病历的主诉栏常写成姓名、日期、病名清单（「杨立，男，12岁…」「1990年10月经初潮」）。
 * 词条换了说法也算（病历 10 主诉「月经周期缩短」，事实层记「月经周期提前」：两者有三个字连着相同）。
 */
function sharesThreeCharacterRun(chief: string, term: string): boolean {
  for (let at = 0; at + 3 <= term.length; at += 1) if (chief.includes(term.slice(at, at + 3))) return true;
  return false;
}

export function chiefComplaintFindings(state: CaseState, maxItems = 4): string[] {
  const source = clinicalGroundingText(state);
  const chief = String(state.chiefComplaint || "").normalize("NFKC");
  const terms: string[] = [];
  for (const item of state.clinicalFacts?.affirmedSymptoms || []) {
    const term = String(item?.term || "").trim();
    const quote = String(item?.quote || "").trim();
    if (term.length < 2 || !quote || !source.includes(quote) || !(chief.includes(term) || sharesThreeCharacterRun(chief, term))) continue;
    if (terms.some((existing) => existing.includes(term) || term.includes(existing))) continue;
    terms.push(term);
    if (terms.length >= maxItems) break;
  }
  return terms;
}

export function rationaleFindingsChecklistNotice(state: CaseState): string {
  const terms = rationaleFindingsChecklist(state);
  if (terms.length < 2) return "";
  return `\n\n【辨证依据要交代的已记录表现】本例病历记录了：${terms.join("、")}。overview.tcmDiagnosticRationale 要逐项说明它们各属哪一病机（舌象、脉象也要写进推理，说明它们支持哪一病机；主证能解释的说明如何解释；主证解释不了的写明其病机归属，够成组时按规则立兼证，不够时不立证、不进治法），不要只挑其中两三项；只写病历里有的，不补写。`;
}
