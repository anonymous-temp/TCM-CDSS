import type { CaseState } from "./diagnosis-types";
import { ageImplausibleReproductiveStatements, clinicalGroundingText } from "./diagnosis-safety";
import { isUnrecordedInspectionFieldValue } from "./clinical-state";
import { lineageLabel, resolveLineageCode } from "./tcm-lineages";

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
/** 病历记录了的舌象、脉象（未记录、「难配合」不算）。也是辨证依据重写的单项触发（m03-rationale-coverage）。 */
export function recordedTonguePulse(state: CaseState): string[] {
  return ([["tongue", state.tongue], ["pulse", state.pulse]] as const)
    .filter(([field, value]) => !isUnrecordedInspectionFieldValue(value, field))
    .map(([, value]) => String(value || "").normalize("NFKC").replace(/^\s*(?:舌象|脉象)\s*[:：]\s*/u, "").trim())
    // 「脉象难配合」「舌象患儿不配合」是没能看到，不是所见；列进清单会逼模型去解释它（C079：「脉象难配合系患儿年幼…不能据此另立他证」）。
    .filter((value) => value.length >= 2 && !/配合/u.test(value));
}

/**
 * 与年龄不符的婚育、月经记录（ageImplausibleReproductiveStatements）不进清单（2026-10-29：1 岁女童的「有痛经史」进了清单，
 * 依据只好写「痛经史为既往宿疾，不参与本次辨证」）。
 */
function inAgeImplausibleRecord(conflicting: readonly string[], term: string, quote: string): boolean {
  const compactQuote = quote.normalize("NFKC").replace(/\s+/gu, "");
  return conflicting.some((clause) => {
    const compactClause = clause.replace(/\s+/gu, "");
    return compactClause.includes(compactQuote) || compactQuote.includes(compactClause) || compactClause.includes(term);
  });
}

export function rationaleFindingsChecklist(state: CaseState, maxItems = 12): string[] {
  const source = clinicalGroundingText(state);
  const chief = String(state.chiefComplaint || "").normalize("NFKC");
  const conflicting = ageImplausibleReproductiveStatements(state);
  const terms: string[] = recordedTonguePulse(state).slice(0, 2);
  for (const item of state.clinicalFacts?.affirmedSymptoms || []) {
    const term = String(item?.term || "").trim();
    const quote = String(item?.quote || "").trim();
    if (term.length < 2 || !quote || !source.includes(quote)) continue;
    if (inAgeImplausibleRecord(conflicting, term, quote)) continue;
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
  const conflicting = ageImplausibleReproductiveStatements(state);
  for (const item of state.clinicalFacts?.affirmedSymptoms || []) {
    const term = String(item?.term || "").trim();
    const quote = String(item?.quote || "").trim();
    if (term.length < 2 || !quote || !source.includes(quote) || !(chief.includes(term) || sharesThreeCharacterRun(chief, term))) continue;
    if (inAgeImplausibleRecord(conflicting, term, quote)) continue;
    if (terms.some((existing) => existing.includes(term) || term.includes(existing))) continue;
    terms.push(term);
    if (terms.length >= maxItems) break;
  }
  // 事实层这一次没抽到主症（同一份病历 10，「月经周期提前」时有时无）：退用主诉第一句去掉病程后的原话，
  // 要求至少四个字（「杨立」「经初潮」这类不取）且现病史里有三个字连着相同（病名清单式主诉一般对不上现病史）。
  if (terms.length === 0) {
    const phrase = chiefComplaintPhrase(chief);
    const history = String((state.symptoms as Record<string, unknown> | undefined)?.presentHistory || "").normalize("NFKC");
    if (phrase.length >= 4 && sharesThreeCharacterRun(history, phrase)) terms.push(phrase);
  }
  return terms;
}

/** 病程写法：「半年余」「2+月」「3天」「数周」「1小时」（「尿量多半年」的「多」不算病程）。 */
const COURSE_SPAN = /[近约已]?[\d一二两三四五六七八九十半几数+＋]+\s*个?\s*小?[时天日周月年][余多]?以?来?/gu;

/** 主诉第一句、「伴」或括号之前、去掉病程：「月经周期缩短半年余，加重1月」→「月经周期缩短」。 */
export function chiefComplaintPhrase(chiefComplaint: string): string {
  const first = String(chiefComplaint || "").normalize("NFKC").split(/[，,；;。\n]/u)[0] || "";
  return first.split(/[（(伴]/u)[0].replace(COURSE_SPAN, "").replace(/\s+/gu, "").trim();
}

/**
 * 医生选了流派时，清单这一段末尾再提一句：依据最后那一句流派眼目句照写（2026-10-29 第三十轮：选了扶阳的风寒感冒，逐项交代清单排在提示词
 * 最末，模型照清单写完就收尾，本机 10 次里 6 次没有流派那一句；关掉清单时 2/2 都有）。
 */
function lineageLensReminder(state: CaseState): string {
  const code = resolveLineageCode(String(state.tcmLineagePreference || ""));
  if (code === "unrestricted") return "";
  return `写完这些之后，末尾仍按上文要求加一句「${lineageLabel(code)}」的辨证眼目看本例的话，不要因为逐项交代而省掉。`;
}

export function rationaleFindingsChecklistNotice(state: CaseState): string {
  const terms = rationaleFindingsChecklist(state);
  // 清单不足两项时不列清单，流派那一句照样提醒（1 岁女童选了扶阳，清单为空，本机 4 次都没写流派句）。
  if (terms.length < 2) {
    const reminder = lineageLensReminder(state);
    return reminder ? `\n\n【辨证依据末句】overview.tcmDiagnosticRationale ${reminder.replace(/^写完这些之后，/u, "")}` : "";
  }
  return `\n\n【辨证依据要交代的已记录表现】本例病历记录了：${terms.join("、")}。overview.tcmDiagnosticRationale 要逐项说明它们各属哪一病机（舌象、脉象也要写进推理，说明它们支持哪一病机；主证能解释的说明如何解释；主证解释不了的写明其病机归属，够成组时按规则立兼证，不够时不立证、不进治法），不要只挑其中两三项；只写病历里有的，不补写。${lineageLensReminder(state)}`;
}
