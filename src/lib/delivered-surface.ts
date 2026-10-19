/**
 * 交付面：调用方实际收到的结构化结果里，哪些字段不再带内容、哪些服务端生成的措辞要换成临床语言。
 *
 * 2026-10-13，甲方 10.12 测评。甲方面板读的是辨证、开方两个接口返回的结构化字段，用自己的标签直接显示。
 * 测评里被框出来的内容分两类：
 *   · 甲方明确不要的整块：西医诊断下面的症状依据、待查依据、检查建议；诊断名里的括号和「病因待查」；
 *   · 服务端写给审计看的话：「病历尚未确认胸痛是否存在」「病历已记录瘙痒阳性」「（需问诊核实后方可用于排除）」
 *     「适用于与本例锁定证候…一致的情况」「说明书用法字段已与…指纹绑定」「本例辨证组方」等。
 *
 * 接口冻结：字段名、层级、类型都不变，只允许某个字段不再带内容（空数组 / 空串）或写得更像临床语言。
 * 内部校验仍然需要其中一些内容（例如西医支持事实是多条接地校验的取材），所以不是让模型不写，
 * 而是在全部校验做完、签名之前投影一次：这里是「调用方看到什么」的唯一口径，页面、HIS 与接口读同一份。
 *
 * 净化器的句式是有限闭集（都由 diagnosis-safety.ts 自己生成），这里逐式换成医生平时的写法：
 * 没问到的写「未诉」，病历否认的写「否认」，病历有的写「有」。不改净化器本身——它守的是事实极性，
 * 守得对；不对的只是把守的过程原样念给了医生听。
 */

import { compositionIdentityName, formulaCompilationReferences, formulaNameCatalogCoverage, formulaNameIdentityHerbsMissing, formulaNameWithIdentityHerbsPresent, textbookFormulaGovernedEntryIsHomonym, textbookFormulaOriginalSource } from "./tcm-formula-provenance";
import { textbookBaseIngredients } from "./herb-record-caution";
import { precautionWithoutAbsentHerbs } from "./m04-proposal-compiler";
import { canonicalTcmHerbIdentity } from "./diagnosis-stage-contract";
import { conciseHerbFunctionLabel, formulaAnalysisHerbMentions, withMentionsAlignedToTableNames, withOpeningMatchingFormulaName, withoutChartAssertionClauses, withoutProcessParentheticals, withoutStrayLeadingRoleVerb, withoutUnsupportedHarmonizingClaims, withoutUnsupportedHarmonizingClause, withRoleOnlyHerbsExplained } from "./formula-analysis-review";
import { textbookDifferentialsForDisease, textbookRowForSyndrome } from "./tcm-textbook-syndromes";
import { resolveTcmDiseaseDifferentialName } from "./tcm-disease-differential-normalization";
import { clinicalTreatmentScheduleWording } from "./treatment-schedule-wording";
import { hasHerbBoundaryTail, herbBoundaryTail, stripHerbBoundaryTail, type HerbBoundaryAudience } from "./candidate-boundary-text";
import { getTcmHerbFunctionCategories, getTcmHerbFunctionDisplayText, getTcmHerbFunctionText, getTcmHerbGenerationSafetyProfile, herbFunctionKnowledgeForDisplay, isExternalUseEfficacyClause, isKnownTcmHerbName } from "./tcm-knowledge";
import { herbFunctionClaimUnsupportedPhrases, herbFunctionPhraseRecognized } from "./diagnosis-stage-contract";
import { deliveredTreatmentCodes, precautionMentionsUndeliveredTreatment, treatmentCardUndeliverable } from "./tcm-treatment-capabilities.server";
import { dietAdviceAvoidsRichFood, isFoodMedicineHomologyItem, recipeHasRichIngredient } from "./tcm-nondrug-textbook-plan.server";
import { discontinuedMedicationLabel, type RequiredPrecaution } from "./required-precautions";
import { chpPregnancyLabel } from "./conception-herb-policy";
import { patentMedicineCompositionIdentities } from "./patent-medicine-duplication.server";
import { findLocalPatentMedicineLabel } from "./local-patent-medicine-candidates";
import { textbookDistinctHerbKey } from "./herb-textbook-identity";
import { governedTcmHerbAdjudicatedCanonical } from "./tcm-herb-identity";
import { withoutRedundantTherapyPhrases } from "./tcm-therapy-phrasing";

/**
 * 投影时可选的本例信息：herbBoundaryAudience 决定逐味人群提示列哪些人群（见 herbBoundaryPopulationRelevant）；
 * requiredPrecautions 是本例注意事项必须写到的项目（required-precautions.server.ts 由病历算出）。
 */
export type DeliveredSurfaceOptions = {
  herbBoundaryAudience?: HerbBoundaryAudience;
  requiredPrecautions?: readonly RequiredPrecaution[];
  /**
   * 本例不给剂量的原因（辨证阶段由路由按安全门写）：红旗未解除为 red_flag，其余独立边界（待优先评估、妊娠哺乳…）为 withheld。
   * 复诊计划里「请服完本次的药后复诊」这句按它换成先就医（2026-10-19 验收主集 I 模块：不给剂量的病例仍写服完药再来）。
   */
  doseWithheld?: "red_flag" | "withheld";
  /** 投影的是不给剂量的那一页（renderM04DeliveryCheckpoint 设）：注意事项里不说「按医生开的剂量」。 */
  nonDosePage?: boolean;
};

/** 外用剂型（只用于注意事项措辞：外用药不说「服用」、不套口服间隔）。 */
// 「奇正消痛贴」「红花油」「风油精」也是外用（2026-10-19 Claude 评审 H 集 H-tri-6369、2210：写成了「正在服用…间隔1小时」「已自服的红花油」）。
const TOPICAL_MEDICATION_FORM = /(?:乳膏|软膏|凝胶|乳胶剂|搽剂|擦剂|涂剂|洗剂|洗液|贴剂|贴膏|膏药|(?<!口)贴|栓|栓剂|滴眼液|滴耳液|滴鼻液|喷雾剂|气雾剂|酊|红花油|药油|油精|活络油)$/u;

/** 涂在皮肤上的外用药（栓剂经直肠吸收、全身起效，不算；解热镇痛抗炎药按全身与皮肤外用分开各留一种，见 withoutSameClassAnalgesics）。 */
export function skinTopicalMedication(name: string, route = ""): boolean {
  return /外用|外涂|外搽|涂患处|局部/u.test(route) || (TOPICAL_MEDICATION_FORM.test(name.trim()) && !/栓剂?$/u.test(name.trim()));
}

/** 「中药与西药同服时最好间隔1小时左右」一类：红旗页上的用药提示不写怎么跟中药错开服（先就医）。 */
const URGENT_INTERVAL_CLAUSE = /间隔[^，,。；;]{0,10}(?:服|用)|(?:同服|同用|合用)[^，,。；;]{0,8}间隔|(?:分开|错开)[^，,。；;]{0,6}服/u;

const ADMINISTRATION_WORDS = /温服|凉服|饭前|饭后|空腹|睡前|餐前|餐后|分[次两二三]服|频服|顿服/u;
const DIET_WORDS = /忌|少食|少吃|少饮|避免[^，,。；;]{0,6}(?:食|饮|吃)|清淡|饮食有节|不宜过饱/u;
const administrationCovered = (lines: readonly string[]) => lines.some((line) => ADMINISTRATION_WORDS.test(line));
const dietCovered = (lines: readonly string[]) => lines.some((line) => DIET_WORDS.test(line));
/** 写到了戒酒或限酒（「忌食辛辣」不算——2026-10-19 M 集 MTCMB-21：每日白酒 5 两，饮食一条算写到了，戒酒一字未提）。 */
const alcoholCovered = (lines: readonly string[]) => lines.some((line) => /酒/u.test(line) && /戒|忌|禁|限|勿|不宜|不要|避免|少饮|不饮/u.test(line));
/** 写到了出血观察（牙龈出血、皮下瘀斑、黑便…）。 */
const bleedingWatchCovered = (lines: readonly string[]) => lines.some((line) => /出血|瘀斑|瘀点|黑便|血尿/u.test(line) && /观察|留意|注意|出现|警惕|如有|若有|一旦/u.test(line));
/** 写到了不要自行停用激素、免疫抑制剂。 */
const noSelfStopCovered = (lines: readonly string[], names: readonly string[]) => lines.some((line) =>
  /(?:自行|擅自|突然|骤然|随意)(?:停|减)|骤停|停用或减量|停药或减量/u.test(line) && (names.some((name) => line.includes(name)) || /激素|免疫抑制/u.test(line)));
const medicationBaseName = (name: string) => name.replace(/(?:片|胶囊|颗粒|丸|口服液|注射液|缓释片|肠溶片|分散片)$/u, "");
/**
 * 在用的药注意事项里还没点到名的那几个。逐个药核（2026-10-19 Claude 评审 M 集 J 模块：二甲双胍外漏格列喹酮、吡格列酮，
 * 「服阿司匹林期间注意出血」一句点到阿司匹林就算整项写到了，其余降糖、调脂药一个没提；「如正在服用其他药物请告知医生」这种泛泛一句也不算点名）。
 */
const unnamedCurrentMedications = (item: Extract<RequiredPrecaution, { kind: "current_medications" }>, lines: readonly string[]) =>
  item.names.filter((name) => !lines.some((line) => line.includes(medicationBaseName(name))));
const currentMedicationsNamed = (item: Extract<RequiredPrecaution, { kind: "current_medications" }>, lines: readonly string[]) =>
  unnamedCurrentMedications(item, lines).length === 0;

/** 注意事项里已经写到这一项了吗（说到药名 / 哺乳 / 抗菌治疗即算，不管模型怎么措辞）。 */
function requiredPrecautionCovered(item: RequiredPrecaution, lines: readonly string[]): boolean {
  // 运动保健一栏的项目，注意事项里不核（见 exerciseForMobilityLimitation）。
  if (item.kind === "mobility_limited_exercise") return true;
  if (item.kind === "self_discontinued_medication") return lines.some((line) => /停/u.test(line) && /自行|擅自|规律|遵医嘱/u.test(line) &&
    (item.names.some((name) => line.includes(name)) || /降压|降糖|原来|长期|原用/u.test(line) || (item.condition ? line.includes(item.condition) : false)));
  if (item.kind === "current_medications" && item.urgent) return item.names.every((name) => lines.some((line) => line.includes(medicationBaseName(name)) &&
    /带|携带|就医|急诊/u.test(line) && !URGENT_INTERVAL_CLAUSE.test(line)));
  if (item.kind === "self_medication") return lines.some((line) => line.includes(item.base) || line.includes(item.name));
  if (item.kind === "postpartum_lactation") return lines.some((line) => /哺乳|喂奶|母乳|授乳|乳汁/.test(line));
  if (item.kind === "pediatric_administration") return lines.some((line) => /小儿|患儿|儿童|幼儿|孩子|宝宝/.test(line) && /少量|多次|分次|频服|喂/.test(line));
  // 模型常只写「起身宜缓，防止跌倒」不点年龄：说到跌倒就算写到了，不再补一句同义的（2026-10-18 甲方病历 6 两句防跌倒）。
  if (item.kind === "elderly_administration") return lines.some((line) => /高龄|老年|老人|年老|年长|跌倒|摔倒/.test(line));
  if (item.kind === "current_medications") return currentMedicationsNamed(item, lines) && (!item.noSelfStop?.length || noSelfStopCovered(lines, item.noSelfStop));
  if (item.kind === "unnamed_medication" && item.herbal) return lines.some((line) => /中药|汤药|方子|处方/u.test(line) && /(?:正在|一直|在)服|原来|之前/u.test(line) && /告知|告诉|带给|医生/u.test(line));
  // 「请把正在使用的药物名称和用法告诉医生」也算写到了（「正在」后接「使用/服用」）：此前不认，同一页再补一句同样的话（M 集 MTCMB-6、TCMChat-336 等 6 例）。
  if (item.kind === "unnamed_medication") return lines.some((line) => /(?:正在|自行|已|在)(?:使用|服用|服|用|吃)[^，,。；;]{0,8}药|用药情况|药名|药物名称/u.test(line) && /告知|告诉|说明/u.test(line));
  if (item.kind === "antithrombotic_bleeding") return bleedingWatchCovered(lines);
  if (item.kind === "diabetes_glucose") return lines.some((line) => /血糖|控糖/u.test(line) && /监测|测|查|控制|稳定|控糖/u.test(line));
  if (item.kind === "herpes_zoster_antiviral") return lines.some((line) => /抗病毒/u.test(line));
  if (item.kind === "gout_diet") return lines.some((line) => /嘌呤/u.test(line));
  if (item.kind === "trigger_foods") return item.foods.every((food) => lines.some((line) => line.includes(food) && /避免|忌|不要|勿|少/u.test(line)));
  if (item.kind === "severe_hypertension_followup") return lines.some((line) => /血压/u.test(line) && /复测|测量|监测/u.test(line) && /就诊|就医|调整/u.test(line));
  if (item.kind === "administration_and_diet") return (!item.administration || administrationCovered(lines)) && dietCovered(lines) && (!item.alcohol || alcoholCovered(lines));
  if (item.kind === "reproductive_status_unknown") return lines.some((line) => /孕|哺乳/u.test(line));
  if (item.kind === "toxic_self_preparation") return lines.some((line) => item.herbs.some((herb) => line.includes(herb)) && /停用|停服|停止|不要再|勿再|不可再/u.test(line));
  if (item.kind === "conception_pregnancy_check") return lines.some((line) => /验孕|妊娠试验|早孕试纸|月经(?:逾期|推迟|延后)/u.test(line));
  if (item.kind === "menses_overdue_pregnancy_check") return lines.some((line) => /验孕|妊娠试验|早孕试纸|HCG/iu.test(line));
  return lines.some((line) => /抗生素|抗菌|抗感染|青霉素|头孢/.test(line));
}

/**
 * 模型写的自服药那一条里说「与本方同有/重叠」的药，只留本方处方里真有的（2026-10-17 本地复测：病历 7 的处方是清胃散加减，
 * 模型把提示里给的黄连上清丸组成整串抄成「与本方黄连、大黄、黄芩、黄柏、栀子、连翘等重叠」，后四味本方没有）。
 * 一味真有的都不剩、却仍说重叠时，换成规则那一句。药名本身（黄连上清丸含「黄连」）先保护起来再删。
 */
function withOnlyPrescribedOverlap(line: string, item: Extract<RequiredPrecaution, { kind: "self_medication" }>, herbIdentities: ReadonlySet<string>): string | undefined {
  if (item.composition.length === 0 || !(line.includes(item.base) || line.includes(item.name))) return line;
  const shielded = line.split(item.name).join("\u0000").split(item.base).join("\u0001");
  let pruned = shielded;
  for (const herb of item.composition.filter((name) => !herbIdentities.has(name))) {
    pruned = pruned.split(`${herb}、`).join("").split(`、${herb}`).join("").split(herb).join("");
  }
  const restored = pruned.split("\u0000").join(item.name).split("\u0001").join(item.base);
  const claimsOverlap = /重叠|同含|同有|都含|均含|共有/.test(restored);
  const remaining = item.composition.filter((name) => herbIdentities.has(name) && restored.includes(name));
  return claimsOverlap && remaining.length === 0 ? undefined : restored;
}

/** 模型漏写时由规则补的那一句。只说病历记录的事实、方剂目录与说明书写着的内容。 */
type RequiredLineContext = {
  /** 方中知识库标注哺乳期禁用（HIGH）与慎用（MEDIUM）的药，与逐味人群提示同一档（页面上 HIGH 写作「禁用」）。 */
  lactationTiers?: { prohibited: string[]; caution: string[] };
  /** 方中知识库标注「出血倾向/月经期/抗凝状态」慎用的药（活血化瘀类）。 */
  bleedingHerbs?: string[];
};
function requiredPrecautionLine(item: RequiredPrecaution, herbIdentities: ReadonlySet<string>, lactationHerbs: readonly string[], pregnancyLabelledHerbs: readonly string[] = [], decoctionMethod = "", currentLines: readonly string[] = [], context: RequiredLineContext = {}): string {
  if (item.kind === "self_medication") {
    const overlap = item.composition.filter((herb) => herbIdentities.has(herb));
    const topical = TOPICAL_MEDICATION_FORM.test(item.name);
    const head = overlap.length > 0 && !topical
      ? `已自服的${item.name}与本方同含${overlap.slice(0, 4).join("、")}，服本方期间不宜再同时服用，以免药力叠加；如需继续请先告知医生`
      : topical
        ? `已外用的${item.name}是否继续使用，请服本方前告知医生，由医生决定`
        : `已自服的${item.name}是否继续服用，请服本方前告知医生，由医生决定`;
    return `${head}${item.alcoholWarning ? `；服用${item.base}期间须戒酒，饮酒可引起双硫仑样反应` : ""}。`;
  }
  if (item.kind === "postpartum_lactation") {
    // 禁用与慎用分开写，档位与药表逐味人群提示一致（2026-10-19 M 集 BEST4SDT-65：药表写三棱、莪术、川楝子哺乳期禁用，注意事项写「慎用」还漏了川楝子）。
    const tiers = context.lactationTiers;
    const named = tiers && (tiers.prohibited.length > 0 || tiers.caution.length > 0)
      ? [tiers.prohibited.length > 0 ? `${tiers.prohibited.slice(0, 6).join("、")}哺乳期禁用` : "", tiers.caution.length > 0 ? `${tiers.caution.slice(0, 6).join("、")}哺乳期须慎用` : ""].filter(Boolean).join("，")
      : lactationHerbs.length > 0 ? `${lactationHerbs.slice(0, 4).join("、")}哺乳期须慎用` : "";
    return `产后如正在哺乳，请服药前告知医生${named ? `（方中${named}）` : ""}，由医生评估后再服。`;
  }
  if (item.kind === "antithrombotic_bleeding") {
    const herbs = (context.bleedingHerbs || []).slice(0, 4).join("、");
    return item.drugs.length > 0
      ? `方中${herbs}有活血作用，与正在使用的${item.drugs.slice(0, 3).join("、")}同用可能增加出血风险；服药期间请留意牙龈出血、皮下瘀斑、黑便或血尿，出现时及时就医，并告诉医生您在用这些药。`
      : `您有${item.indication}病史，如正在服用抗凝或抗血小板药（如阿司匹林、氯吡格雷、华法林），请告诉医生；方中${herbs}有活血作用，同用可能增加出血风险，服药期间请留意牙龈出血、皮下瘀斑、黑便或血尿，出现时及时就医。`;
  }
  if (item.kind === "diabetes_glucose") {
    // 《中国2型糖尿病防治指南（2020年版）》：规律监测血糖、限制添加糖与含糖饮料。只有中医病名消渴或「糖尿病待查」时不说「您有糖尿病」（M 集 RobustSDT-0141）。
    return item.confirmed
      ? "您有糖尿病，服药期间请按医嘱继续控制血糖、定期监测血糖，少吃甜食和含糖饮料；如血糖明显波动或口渴、多尿加重，请及时就医。"
      : "口渴多饮、尿多的情况请尽早到医院查空腹血糖和糖化血红蛋白；服药期间少吃甜食和含糖饮料，如口渴、多尿加重或体重明显下降，请及时就医。";
  }
  if (item.kind === "pediatric_administration") {
    // 《中医儿科学》服药法：小儿服药宜少量多次频服，不可捏鼻强灌。不写「剂量已按年龄折算」——非剂量页也会走到这里。
    if (item.ageYears >= 12) return "孩子服药请家长看护，按医生给的量和次数服用，不要自行加量或停药；服药后如有明显不适请及时就医。";
    return "孩子服药宜少量多次、分次喂服，不要捏鼻强灌；请按医生给的量服，不要自行加量。";
  }
  if (item.kind === "elderly_administration") {
    return "年长者服药后起身宜缓，注意防跌倒；服药期间如有明显不适请及时告知家人和医生。";
  }
  if (item.kind === "current_medications" && item.urgent) {
    // 只补还没点到名的那几个（模型写了「请把倍博特、血塞通滴丸连同药盒带去就医」而漏了倍他乐克，M 集 MTCMB-85）。
    const names = item.names.filter((name) => !currentLines.some((line) => line.includes(medicationBaseName(name)) && /带|携带|就医|急诊/u.test(line)));
    return `请把正在使用的${(names.length > 0 ? names : item.names).join("、")}连同药盒带去就医，告诉医生最近一次用药的时间；是否继续使用由医生决定，不要自行加用或停用。`;
  }
  if (item.kind === "self_discontinued_medication") {
    return item.irregular
      ? `您之前未规律服用${discontinuedMedicationLabel(item)}，请由医生评估后按医嘱规律服用，不要自行停药或减量。`
      : `您之前自行停用了${discontinuedMedicationLabel(item)}，请尽快由医生评估后调整用药并规律服用，不要再自行停药或减量。`;
  }
  if (item.kind === "mobility_limited_exercise") return "";
  if (item.kind === "current_medications") {
    // 是否继续由医生定，不写「不要自行停用」：红旗病例里那句会变成让心率 42、血压 82/48 的患者继续服美托洛尔（2026-10-18 留出集 S188）。
    // 外用药（乳膏、贴剂、栓剂…）不说「服用」，也不套口服药的间隔时间（甲方病历 8：阿昔洛韦乳膏）。
    // 「予/给予」写的药（医生给过、可能已停）不说「正在」：请患者说明现在是否还在用（2026-10-19）。
    // 已写到这些药、只缺「激素和免疫抑制剂不要自行停用」时，只补这一句（不再把药名整句重说一遍）。
    const noSelfStop = item.noSelfStop || [];
    const noSelfStopLine = noSelfStop.length > 0 ? `${noSelfStop.join("、")}不要自行停用或减量，是否调整由医生决定` : "";
    if (noSelfStopLine && currentMedicationsNamed(item, currentLines)) return `${noSelfStopLine}。`;
    // 只补还没点到名的那几个，已经写到的不再重说一遍。
    const missing = unnamedCurrentMedications(item, currentLines);
    const names = missing.length > 0 ? missing : item.names;
    const given = new Set(item.given || []);
    const topical = names.filter((name) => TOPICAL_MEDICATION_FORM.test(name) && !given.has(name));
    const oral = names.filter((name) => !TOPICAL_MEDICATION_FORM.test(name) && !given.has(name));
    const recorded = names.filter((name) => given.has(name));
    return [
      oral.length > 0 ? `正在服用的${oral.join("、")}请告知医生，是否继续服用由医生决定；中药与西药同服时最好间隔1小时左右` : "",
      topical.length > 0 ? `正在外用的${topical.join("、")}请告知医生，是否继续使用由医生决定` : "",
      recorded.length > 0 ? `病历记录用过的${recorded.join("、")}，请告知医生现在是否还在用，能否与本方同用由医生决定` : "",
      noSelfStopLine,
    ].filter(Boolean).join("；") + "。";
  }
  if (item.kind === "unnamed_medication" && item.herbal) return "您一直在服的中药，请把方子带给医生看，是否与本方同服由医生决定，避免药味重复。";
  if (item.kind === "unnamed_medication") return "病历记录您自行用过药，请把正在用的药（药名和用法）告诉医生，避免与本方重复或相互影响。";
  if (item.kind === "herpes_zoster_antiviral") {
    // 《中国带状疱疹诊疗专家共识（2022 版）》：发疹 72 小时内尽早系统抗病毒；仍有新水疱、50 岁以上、累及眼耳者也应尽早。不写药名与剂量。
    return "带状疱疹请尽早到医院由医生评估是否需要口服抗病毒药（发疹3天内、仍有新水疱出现或年龄50岁以上尤应尽早），疼痛明显请一并告知医生；如皮疹累及眼周、耳部，或出现视物模糊、听力改变、剧烈头痛，请立即就医。";
  }
  if (item.kind === "gout_diet") return "痛风需低嘌呤饮食：少吃海鲜、动物内脏和浓肉汤，戒酒（尤其啤酒），每天多饮水。";
  if (item.kind === "trigger_foods") return `本次发病与进食${item.foods.join("、")}有关，服药期间及以后请避免${item.foods.join("、")}。`;
  if (item.kind === "severe_hypertension_followup") {
    return `本次血压${item.reading}明显偏高，请今天复测血压，并在当日或数日内到心内科或全科就诊调整降压药；如出现胸痛、气短、剧烈头痛、视物模糊、肢体无力或言语不清，请立即就医。`;
  }
  if (item.kind === "administration_and_diet") {
    // 服法照本方煎服法里的那一句（饭前/饭后/空腹/睡前 + 温服），没有就写温服；忌口来自已定证候。只补缺的那一半。
    const timing = decoctionMethod.match(/(?:饭前|饭后|餐前|餐后|空腹|睡前)[^，,。；;]{0,6}(?:温服|服)/u)?.[0] || (/温服/u.test(decoctionMethod) ? "温服" : "宜温服");
    const parts = [
      !item.administration || administrationCovered(currentLines) ? "" : `本方汤药${timing.startsWith("宜") ? timing : `宜${timing}`}`,
      dietCovered(currentLines) ? "" : `服药期间${item.diet}`,
      // 饮食已写到、只缺戒酒时单补（item.diet 已带「，戒酒」，饮食一半补上时不重复）。
      item.alcohol && dietCovered(currentLines) && !alcoholCovered(currentLines) ? "服药期间请戒酒" : "",
    ].filter(Boolean);
    return parts.length > 0 ? `${parts.join("；")}。` : "";
  }
  if (item.kind === "reproductive_status_unknown") {
    return `如已怀孕、可能怀孕或正在哺乳，请服药前告知医生${pregnancyLabelledHerbs.length > 0 ? `（方中${pregnancyLabelledHerbs.slice(0, 4).join("、")}为孕妇慎用或禁用之品）` : ""}。`;
  }
  if (item.kind === "toxic_self_preparation") {
    return `自行配制的含${item.herbs.join("、")}的药请立即停用，以后不要再自行配制服用（这些药药典标注有毒）；如出现口唇舌或四肢发麻、心慌、心跳不齐、呼吸困难，请立即就医。`;
  }
  if (item.kind === "menses_overdue_pregnancy_check") {
    return `本次月经已逾期未至，服药前请先验孕（早孕试纸或到医院查血、尿HCG）；确认怀孕请告知医生，由医生调整用药${pregnancyLabelledHerbs.length > 0 ? `（方中${pregnancyLabelledHerbs.slice(0, 4).join("、")}为药典「孕妇慎用」或「孕妇禁用」之品）` : ""}。`;
  }
  if (item.kind === "conception_pregnancy_check") {
    return `备孕期间服药，如月经逾期请先验孕，确认怀孕请立即停药并告知医生${pregnancyLabelledHerbs.length > 0 ? `（方中${pregnancyLabelledHerbs.slice(0, 4).join("、")}为药典「孕妇慎用」或「孕妇禁用」之品）` : ""}。`;
  }
  return `${item.disease}是细菌感染，除服本方外请到医院就诊，由医生决定抗菌药物治疗；如出现寒战高热、红肿迅速扩大、皮肤发紫或起水疱，请立即就医。`;
}

const SPECIAL_DECOCTION_WORD = /先煎|久煎|后下|包煎|另煎|烊化|冲服|兑服|同煎/gu;
/**
 * 一小句里点名某味药并说它的特殊煎法，而药表这味药的煎法要求与煎服法里都没有这个说法：去掉这一小句。
 * 说法以药表 decoctionRequirement 与煎服法那一行为准（二者由编译器按药典与教材写定）。
 */
function withoutContradictedDecoctionClaims(line: string, herbRows: readonly Json[], decoctionLine: string): string {
  const names = herbRows.map((herb) => String(herb.name || "").trim()).filter((name) => name.length >= 2);
  // 一小句里列了几味药、各说各的煎法（「方中桃仁打碎、五灵脂包煎」）：某味药说的煎法只算它后面到下一味药之前那一段；
  // 后面紧跟顿号就接下一味的（「龙齿、牡蛎先煎」两味都先煎）。此前整小句的煎法词都算到每一味头上：桃仁被算成说了「包煎」，
  // 整小句去掉后只剩「煎药时请按此处理。」（2026-10-19 Claude 评审 M 集 TCM-SD-482280、BEST4SDT-91）。
  const claimsFor = (clause: string, name: string): string[] => {
    const spans = names.flatMap((other) => [...clause.matchAll(new RegExp(other.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))]
      .map((match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + other.length, name: other })))
      .filter((span, _index, all) => !all.some((other) => other !== span && other.start <= span.start && other.end >= span.end && other.end - other.start > span.end - span.start))
      .sort((left, right) => left.start - right.start);
    const own = spans.filter((span) => span.name === name);
    if (own.length === 0) return [];
    return [...new Set(own.flatMap((span) => {
      let at = spans.indexOf(span);
      for (;;) {
        const next = spans[at + 1];
        const segment = clause.slice(spans[at].end, next ? next.start : clause.length);
        if (next && /^\s*[、和及与]\s*$/u.test(segment)) { at += 1; continue; }
        return segment.match(SPECIAL_DECOCTION_WORD) || [];
      }
    }))];
  };
  const contradicted = (clause: string) => herbRows.some((herb) => {
    const name = String(herb.name || "").trim();
    if (name.length < 2 || !clause.includes(name)) return false;
    const claimed = claimsFor(clause, name);
    if (claimed.length === 0) return false;
    const requirement = String(herb.decoctionRequirement || "");
    // 「与群药同煎」「捣碎后同煎」说这味药不用特殊煎法：药表要它先煎/后下/包煎/另煎/烊化时就是相抵（BEST4SDT-139：注意事项「龙齿捣碎后同煎」，
    // 药表与煎服行是龙齿先煎）。
    if (claimed.includes("同煎") && /先煎|久煎|后下|包煎|另煎|另炖|烊化/u.test(requirement)) return true;
    return claimed.some((word) => word !== "同煎" && !requirement.includes(word) &&
      !new RegExp(`${name}[^，,。；;]{0,8}${word}`, "u").test(decoctionLine));
  });
  return withoutTimingClauses(line, contradicted);
}

/**
 * 这一句点到的哺乳期用药与药表逐味人群提示同档：知识库列出的禁用、慎用药都点到了，所在小句禁用的说「禁」、慎用的说「慎」不说「禁」。
 */
function lactationLineMatchesTiers(line: string, tiers: { prohibited: readonly string[]; caution: readonly string[] }): boolean {
  const clauses = line.split(/[，,；;。]/u);
  const clauseOf = (name: string) => clauses.find((clause) => clause.includes(name));
  return tiers.prohibited.every((name) => /禁/u.test(clauseOf(name) || "")) &&
    tiers.caution.every((name) => { const clause = clauseOf(name) || ""; return /慎/u.test(clause) && !/禁/u.test(clause); });
}

/** 说到毒性、过量或中毒表现的一句（逐味核有毒药是否点到）。 */
const TOXICITY_ADVICE = /毒|发麻|麻木|心慌|心悸|过量|加量|久服|先煎|不适/u;

/**
 * 注意事项叫患者避开的一类药（「不宜再服润肠通便类中成药」「避免与通便类中成药重复使用」「勿与同类清热化痰中成药叠加」）的类名。
 * 前面的「其他/同类/与」、以及「含人参或党参的」这样的成份说法不算类名（成份另由 precautionAvoidedContainedHerbs 读）。
 */
function precautionAvoidedMedicineCategory(line: string): string | undefined {
  const raw = line.match(/([\u4e00-\u9fff]{2,10}?)类(?:的)?(?:中成药|西药|成药|药物|药)/u)?.[1]
    ?? line.match(/同类([\u4e00-\u9fff]{2,8}?)(?:的)?(?:中成药|西药|成药|药物)/u)?.[1];
  return raw?.replace(/^.*的(?=[\u4e00-\u9fff]{2,})/u, "")
    .replace(/^.*?(?:服用|服|用|吃|含|与|和|同|再|其他|其它|同)(?=[\u4e00-\u9fff]{2,})/u, "")
    .replace(/^(?:服用|服|用|吃|含|再|其他|其它|同)+/u, "");
}

/** 「不宜再服含人参或党参的滋补类中成药」：叫患者避开的成份药名（知识库认得的）。 */
function precautionAvoidedContainedHerbs(line: string): string[] {
  if (!/不宜|不要|勿|避免|停服|忌|不可/u.test(line)) return [];
  return [...line.matchAll(/含有?([\u4e00-\u9fff、或和及与]{2,24}?)(?:成分|成份)?(?:的|之)/gu)]
    .flatMap((match) => match[1].split(/[、或和及与]/u))
    .filter((name) => name.length >= 2 && isKnownTcmHerbName(name));
}

/** 含糖多的食物（闭集，糖尿病饮食段用）：红枣、大枣、蜂蜜、各种糖、桂圆、甘蔗、蜜饯。 */
const HIGH_SUGAR_FOOD = /红枣|大枣|蜜枣|蜂蜜|冰糖|红糖|白糖|饴糖|麦芽糖|桂圆|龙眼肉|甘蔗|蜜饯|果脯|甜点|糕点|含糖饮料/u;

/**
 * 饮食段里推荐的含糖多的食物：顿号列举里只去掉那一项（「可常吃山药炖鸡肉、红枣胡萝卜牛肉汤」→「可常吃山药炖鸡肉」），
 * 整个小句都是这类食物时去掉这一小句；叫患者少吃、不吃的小句不动。
 */
function withoutHighSugarRecommendations(diet: string): string {
  const AVOID = /忌|勿|不宜|不要|避免|少食|少吃|少饮|限制|控制|不吃/u;
  const DISH = /炖|煮|蒸|汤|粥|饮|炒|拌|茶|羹/u;
  const clauses = diet.split(/(?<=[，,；;。])/u);
  let dropping = false;
  const pieces = clauses.map((clause) => {
    const end = clause.match(/[，,；;。]$/u)?.[0] || "";
    const body = clause.slice(0, clause.length - end.length);
    // 被去掉的推荐小句后面接着说它怎么吃的（「佐餐食用，每周一至二次」「如党参蜂蜜饮」）一并去掉，到分号句号为止。
    if (dropping && /^(?:佐餐|每周|每日|每天|每次|作|如|或|当|代茶)/u.test(body.trim())) {
      if (/[；;。]/u.test(end)) dropping = false;
      return "";
    }
    dropping = false;
    if (!HIGH_SUGAR_FOOD.test(clause) || AVOID.test(clause)) return clause;
    const items = body.split("、");
    const kept = items.filter((item) => !HIGH_SUGAR_FOOD.test(item));
    // 顿号列举的每一项都是一道菜（「可常吃山药炖鸡肉、红枣胡萝卜牛肉汤」）才只去掉那一项；否则整个小句去掉（「可用党参、红枣与鸡肉同炖」）。
    if (kept.length === 0 || !items.every((item) => DISH.test(item))) {
      dropping = !/[；;。]/u.test(end);
      return "";
    }
    const lead = items[0].match(/^(?:可(?:常|多|适量)?(?:吃|食用|选|用|饮)?|宜(?:常|多)?(?:吃|食)?|多吃|常吃)/u)?.[0] || "";
    const joined = kept.join("、");
    return `${lead && !joined.startsWith(lead) ? lead : ""}${joined}${end}`;
  });
  if (pieces.every((piece, index) => piece === clauses[index])) return diet;
  const joined = pieces.join("").replace(/[，,；;]+(?=[。]|$)/u, "").replace(/^[，,；;。\s]+/u, "").trim();
  return joined && !/[。！？!?]$/u.test(joined) ? `${joined}。` : joined;
}

/**
 * 写给患者的注意事项里的医护流程话（2026-10-19 Claude 评审 M 集 TCM-SD-433219「备血」、MTCMB-41「须经医生与药师复核后使用」、
 * SD-466542「须由医生按现行药典与院内规则复核后使用」、RobustSDT-0062「服药前请医生确认」）：换成患者能照做的说法，其余照留。闭集。
 */
function withPatientFacingWorkflowWording(line: string, nonDosePage: boolean): string {
  return line
    .replace(/(?:须|需|应)(?:经|由)?(?:医生|医师)(?:与|和|或)?(?:药师)?(?:按[^，,。；;]{0,16}?)?复核后(?:再)?(?:使用|服用|服)/gu, nonDosePage ? "是否使用由医生面诊后决定" : "请遵医嘱服用")
    .replace(/(?:请|需|须)(?:医生|医师)(?:补充)?确认/gu, "请先咨询医生")
    .replace(/(?:并|、)?(?:交叉配血|备血|配血)(?=[、，,。；;]|$)/gu, "")
    .replace(/(?<=[\u4e00-\u9fff])、(?=[，,。；;])/gu, "");
}

/**
 * 同一页说同一件事的两句（「病历记录您自行用过药，请把正在用的药（药名和用法）告诉医生…」与模型写的「请把正在使用的药物名称和用法告诉医生…」，
 * M 集 MTCMB-6 等 6 例）：只看两个话题——不点药名、泛泛请患者把在用的药告诉医生的，与说哺乳的——较短一句的二字词六成以上都在较长一句里时，
 * 留先出现的那句（规则补的排在最前）。点了具体药名的（「正在服用的阿司匹林请告知医生」「正在服用的二甲双胍请告知医生」）句式几乎一样，不并。
 */
function withoutRepeatedTopicLines(lines: readonly unknown[]): unknown[] {
  const topic = (line: string) => /(?:告知|告诉)医生/u.test(line) && /药名|药物名称|用药情况|(?:正在|在)(?:使用|服用|用)的(?:药物|药)(?![\u4e00-\u9fff]{2,}(?:片|胶囊|颗粒|丸))/u.test(line) ? "medication"
    : /哺乳/u.test(line) ? "lactation" : "";
  const bigrams = (line: string) => new Set([...line.replace(/[^\u4e00-\u9fff]/gu, "")].map((_char, index, all) => all.slice(index, index + 2).join("")).filter((pair) => pair.length === 2));
  const kept: unknown[] = [];
  for (const line of lines) {
    if (typeof line === "string" && topic(line)) {
      const own = bigrams(line);
      const repeated = kept.some((other) => {
        if (typeof other !== "string" || topic(other) !== topic(line)) return false;
        const theirs = bigrams(other);
        const [short, long] = own.size <= theirs.size ? [own, theirs] : [theirs, own];
        return short.size > 0 && [...short].filter((pair) => long.has(pair)).length / short.size >= 0.6;
      });
      if (repeated) continue;
    }
    kept.push(line);
  }
  return kept;
}

/** 只剩一句指回前文的话（「煎药时请按此处理。」「请照此操作。」）：前文被删后没有所指。构词式闭集。 */
const ANAPHORIC_INSTRUCTION = /^(?:煎药时|煎煮时|服药时|服用时)?(?:请)?(?:按此|照此|按上述|照上述|如上)(?:处理|操作|执行|煎煮|煎|服用|服)?[。.；;，,]?$/u;
/** 没有主语、说的却是某味药的炮制或煎法（「须经炮制并按医嘱服用，不可自行加量或久服。」，主语那一小句被删后剩下的，M 集 MTCMB-59）。 */
const SUBJECTLESS_HERB_HANDLING = /^(?:须|需|应|宜)(?:经|先)?(?:炮制|先煎|后下|包煎|另煎|烊化|久煎|打碎|捣碎)/u;

/** 只陈述「方中有某某等药」、没有任何提示的残句：方中之后只有药名（顿号分隔，药名都认得）。 */
function isPrecautionStub(line: string): boolean {
  if (ANAPHORIC_INSTRUCTION.test(line) || SUBJECTLESS_HERB_HANDLING.test(line)) return true;
  const listed = line.match(/^方中(?:有|含|所用)?([\u4e00-\u9fff、]{2,40}?)(?:等)?(?:药|药物|药味|之品)?[。.]?$/u)?.[1];
  return Boolean(listed) && listed!.split("、").every((name) => name.length >= 2 && isKnownTcmHerbName(name));
}

/**
 * 行动受限的患者：站立屈膝或久行的功法改坐式，并写明扶物、家人陪同。已经按受限写了的（坐位、扶、陪同、床旁、卧位）不动。
 */
export function exerciseForMobilityLimitation(exercise: string, limitation: string): string {
  if (/坐位|坐式|坐着|扶|陪同|床旁|卧位|床上/u.test(exercise)) return exercise;
  const adapted = exercise.replace(/(?<!坐式)八段锦/gu, "坐式八段锦").replace(/(?<!坐式)太极拳/gu, "坐式太极拳");
  return `${adapted.replace(/[。；;，,\s]+$/u, "")}。病历记录${limitation}，以上活动请在家人陪同下扶物或坐位进行，量力而行，防止跌倒。`;
}

/** 用法缩写（有限闭集）→ 中文；「1#」→「1片」。80 岁以下的「高龄」改「年长」。 */
const DOSING_ABBREVIATIONS: ReadonlyArray<[RegExp, string]> = [
  [/(?<![A-Za-z])q\.?o\.?d\.?(?![A-Za-z])/giu, "隔日1次"],
  [/(?<![A-Za-z])q\.?d\.?(?![A-Za-z])/giu, "每日1次"],
  [/(?<![A-Za-z])b\.?i\.?d\.?(?![A-Za-z])/giu, "每日2次"],
  [/(?<![A-Za-z])t\.?i\.?d\.?(?![A-Za-z])/giu, "每日3次"],
  [/(?<![A-Za-z])q\.?i\.?d\.?(?![A-Za-z])/giu, "每日4次"],
  [/(?<![A-Za-z])q\.?n\.?(?![A-Za-z])/giu, "每晚1次"],
  [/(?<![A-Za-z])p\.?r\.?n\.?(?![A-Za-z])/giu, "必要时"],
  [/(\d+(?:\.\d+)?)\s*#/gu, "$1片"],
  // 药物类别的英文缩写（闭集；验收主集 M-TCM-SD-480964 注意事项写「ARB」被判不合格）。
  [/(?<![A-Za-z])ARBs?(?![A-Za-z])(?:类(?:降压药|抑酸药|止痛药|药物|药)?)?/gu, "沙坦类降压药"],
  [/(?<![A-Za-z])ACEIs?(?![A-Za-z])(?:类(?:降压药|抑酸药|止痛药|药物|药)?)?/gu, "普利类降压药"],
  [/(?<![A-Za-z])CCBs?(?![A-Za-z])(?:类(?:降压药|抑酸药|止痛药|药物|药)?)?/gu, "地平类降压药"],
  [/(?<![A-Za-z])PPIs?(?![A-Za-z])(?:类(?:降压药|抑酸药|止痛药|药物|药)?)?/gu, "拉唑类抑酸药"],
  [/(?<![A-Za-z])NSAIDs?(?![A-Za-z])(?:类(?:降压药|抑酸药|止痛药|药物|药)?)?/gu, "非甾体抗炎止痛药"],
];
function withPatientFacingDosingWords(line: string, ageYears: number | null | undefined): string {
  let out = line;
  for (const [pattern, replacement] of DOSING_ABBREVIATIONS) out = out.replace(pattern, replacement);
  if (typeof ageYears === "number" && ageYears < 80) out = out.replace(/高龄(?:患者|者|老人)?/gu, (match) => match === "高龄" ? "年长" : "年长者");
  return out;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is Json => Boolean(item)) : [];
}

const OBJECT = "([^，,。；;：:（）()\\n]{1,60}?)";

/** 净化器与鉴别归一写出的系统句式 → 临床写法。顺序有意义：长句式在前。 */
const SYNTHETIC_PHRASES: ReadonlyArray<[RegExp, string]> = [
  [new RegExp(`病历尚未确认${OBJECT}是否已排除[；;，,]\\s*病历已记录该表现存在[，,]\\s*请医生核对后再采纳`, "g"), "有$1"],
  [new RegExp(`病历已记录否认${OBJECT}[，,]\\s*[^，,。；;\\n]{1,30}?的一般情况需医生核实`, "g"), "否认$1"],
  [new RegExp(`病历已记录本次${OBJECT}未见明显异常[；;，,]\\s*是否复查由医生结合病情判断`, "g"), "本次$1未见明显异常"],
  // 对象里可以自带括注（「口腔专科检查（牙髓活力、叩诊等）」），这一式的结尾是固定句，按到它为止取对象。
  [/病历未记录([^，,。；;：:\n]{1,60}?)(?:记录)?[（(]需问诊核实后方可用于排除[）)]/g, "未诉$1"],
  [new RegExp(`病历(?:中)?尚未确认${OBJECT}是否存在`, "g"), "未诉$1"],
  [new RegExp(`${OBJECT}是否存在尚未(?:确认|核实)`, "g"), "未诉$1"],
  [new RegExp(`病历已记录否认${OBJECT}(?=[，,。；;）)\\n]|$)`, "g"), "否认$1"],
  [new RegExp(`病历已记录${OBJECT}阳性`, "g"), "有$1"],
  [new RegExp(`病历已记录${OBJECT}阴性`, "g"), "无$1"],
  // 档位用语「症状层」漏进写给医生的话（2026-10-19 留出集 S074「热郁轻重暂按症状层把握」）：换成临床说法。
  [/(?:暂)?按症状层(?:面)?(?:把握|考虑|判断|处理)/g, "暂按现有症状判断"],
  // 「病历已记录无胸痛」：后面本来就是一句通顺的否定，去掉前缀即可。
  [/病历已记录(?=无|未见|未诉|不伴|否认)/g, ""],
  // 「病历已记录关节无明显红肿发热」：部位在前、否定在后，同样去掉前缀。
  [/病历已记录(?=[^，,。；;：:\n]{1,8}(?:无|未见|未诉|不伴))/g, ""],
];

/**
 * 「完整度未达C级：以下结论基于现有信息形成，属有界建议；…正式采纳前请医生核对未知项。」是服务端对信息覆盖有限的
 * 结果统一加的标注（diagnosis-visible-summary.applyM03DecisionSpecificityPolicy），甲方测评第一条点名的工程术语。
 * 它被写进待查依据、证候把握度说明和不确定项三处；交付时整句去掉，原字段里模型自己写的内容保留。
 */
const BOUNDED_ADVICE_NOTE = /完整度未达C级[:：][^。\n]*。(?:\s*)/g;
/** 其余几句服务端批注（都是固定句，有限闭集）：病机栏的提示、把握度说明里的校验状态、推荐方向里的锁定说明。 */
const SERVER_NOTES: readonly RegExp[] = [
  /[（(]服务端提示[:：][^）)]*[）)]/g,
  /本次结构化辨证结果未通过服务端完整性校验[。；;，,]?\s*/g,
  /[（(](?:按已签名证候反查受控目录锁定|原选另含未通过受控目录核验的方)[^）)]*[）)]/g,
];

/** 把系统句式换成临床写法；没有命中时原样返回（逐字节不变）。 */
export function clinicalWordingForSyntheticPhrases(value: string): string {
  if (!/病历(?:中)?(?:尚未确认|已记录|未记录)|是否存在尚未|完整度未达C级|服务端|受控目录|症状层/.test(value)) return value;
  let text = value.replace(BOUNDED_ADVICE_NOTE, "");
  for (const note of SERVER_NOTES) text = text.replace(note, "");
  text = text.trim();
  for (const [pattern, replacement] of SYNTHETIC_PHRASES) text = text.replace(pattern, replacement);
  return text
    .replace(/未诉([^，,。；;\n]{1,40}?)记录(?=[，,。；;）)\n]|$)/g, "未诉$1")
    // 「未诉咯血；未诉消瘦；未诉咳嗽」并成一句（2026-10-19 Claude 评审 H/D 集多例连串碎句）。
    .replace(/(未诉[^，,。；;\n]{1,40})[，,；;]\s*未诉/g, "$1、")
    .replace(/(未诉[^，,。；;\n]{1,40})[，,；;]\s*未诉/g, "$1、")
    .replace(/[，,]{2,}/g, "，");
}

/** 这些键的值是机器取值或逐字引用，不做措辞替换。 */
const VERBATIM_KEYS = new Set([
  "schemaVersion", "stage", "contractSignature", "contractSignatureVersion", "clinicalReview", "terminologyMappings",
  "evidenceId", "evidenceFingerprint", "sourceRef", "sourceRefs", "sourceQuote", "patientFact", "syndromeEvidence",
  "primarySyndromeBasis", "citation", "excerpt", "coding", "classicEvidence", "pointProvenance", "protocolSource",
]);

function rewordDeep(value: unknown, key = ""): unknown {
  if (VERBATIM_KEYS.has(key)) return value;
  if (typeof value === "string") return clinicalWordingForSyntheticPhrases(value);
  if (Array.isArray(value)) return value.map((item) => rewordDeep(item, key));
  const object = record(value);
  if (!object) return value;
  for (const [childKey, child] of Object.entries(object)) object[childKey] = rewordDeep(child, childKey);
  return object;
}

const CAUSE_UNKNOWN_SUFFIX = /(?:[，,]\s*(?:病因待查|病因待鉴别|病因未明|病因不明)|[（(]\s*(?:病因待查|待查|待因|症状性|症状|病因待鉴别|病因不明)\s*[）)]|待因)$/u;
const PLACEHOLDER_WESTERN_NAME = /^(?:当前未形成可复核的西医工作诊断|症状性(?:诊断|问题)[，,]\s*病因待(?:临床)?鉴别)$/;

/**
 * 交付的西医诊断名：一个规范病名，不带括号说明，不带「，病因待查」。
 * 症状层面的工作诊断（ICD-10 R 章，或名称本身以「症状」收尾）写成「X待查」；点了名的病种只留病名本身
 *（「功能性消化不良，病因待查」自相矛盾：既已定病，又说病因待查）。
 */
export function deliveredWesternDiagnosisName(name: unknown, coding?: unknown): string {
  const label = typeof name === "string" ? name.trim() : "";
  if (!label || PLACEHOLDER_WESTERN_NAME.test(label)) return label;
  const causeUnknown = CAUSE_UNKNOWN_SUFFIX.test(label);
  let core = label.replace(CAUSE_UNKNOWN_SUFFIX, "").trim();
  // 括号里的部位、分期、累及范围等说明不进诊断名；ICD 名称自带的括号（如「高血压病（原发性）」）很少，统一去掉。
  core = core.replace(/[（(][^（）()]{0,60}[）)]/g, "").replace(/[，,；;、\s]+$/g, "").trim();
  if (!core) return label;
  const code = typeof record(coding)?.code === "string" ? String(record(coding)!.code) : "";
  const symptomLevel = /^R/i.test(code) || /症状$/.test(core);
  core = core.replace(/症状$/, "");
  if (/待查$/.test(core)) return core;
  return causeUnknown && symptomLevel ? `${core}待查` : core;
}

/** 西医鉴别名同样只留名称本身。 */
function deliveredDifferentialName(name: unknown): unknown {
  if (typeof name !== "string") return name;
  const core = name.replace(CAUSE_UNKNOWN_SUFFIX, "").replace(/[（(][^（）()]{0,60}[）)]/g, "").trim();
  return core || name;
}

const SELF_COMPOSED_NAME = /^本例辨证组方(?:加减)?$/;
/** 逐味安全边界句（candidate-boundary-text.ts 写的那一段）之前的通用模板句。 */
const NOT_APPLICABLE_TEMPLATE_HEAD = /^[\s\S]*?(?=各药毒性与特殊人群提示[:：])/;

/** 服务端的有限结论（红旗收口、修复用尽）：证候未定且病机链为空。它的支持事实里放的是红旗发现，开方阶段要读。 */
function isLimitedDiagnose(reasoning: Json): boolean {
  const overview = record(reasoning.overview);
  const chain = record(reasoning.pathogenesis)?.chain;
  return overview?.primarySyndromeResolution === "unresolved" && (!Array.isArray(chain) || chain.length === 0);
}

function deliveredDiagnose(reasoning: Json): void {
  // 鉴别的「建议核实」模型写成字符串 null 的，按空值交付（2026-10-17 留出例 S132「建议核实：null」）。
  const overviewForNulls = record(reasoning.overview);
  for (const row of [
    ...records(overviewForNulls?.tcmDiseaseDifferentials),
    ...records(overviewForNulls?.tcmDifferentials),
    ...records(record(reasoning.westernDiagnosis)?.differentials),
  ]) {
    if (typeof row.nextCheck === "string" && /^(?:null|undefined)$/i.test(row.nextCheck.trim())) row.nextCheck = null;
  }
  // 只有那句统一标注、没有别的内容的不确定项整条去掉（留一条空原因的条目没有意义）。
  const pathogenesis = record(reasoning.pathogenesis);
  if (pathogenesis && Array.isArray(pathogenesis.uncertainties)) {
    pathogenesis.uncertainties = pathogenesis.uncertainties.filter((item) => {
      const row = record(item);
      const reason = typeof row?.reason === "string" ? row.reason : "";
      return !(reason && !reason.replace(BOUNDED_ADVICE_NOTE, "").trim());
    });
  }
  const western = record(reasoning.westernDiagnosis);
  const primary = record(western?.primary);
  if (primary && !isLimitedDiagnose(reasoning)) {
    primary.name = deliveredWesternDiagnosisName(primary.name, primary.coding);
    // 甲方红框「方框内内容不建议展示」：症状依据、待查依据、检查建议三块整块不再输出。
    primary.supportingFacts = [];
    if (Array.isArray(primary.supportingFactKinds)) primary.supportingFactKinds = [];
    primary.limitations = [];
    primary.suggestedChecks = [];
  }
  for (const item of records(western?.differentials)) item.name = deliveredDifferentialName(item.name);
  // 模型自己写明「不适用」的鉴别项（女性病例列前列腺增生、男性病例列异位妊娠，理由写「本例为男性患者，不适用」）不列（2026-10-14 独立评审）。
  if (western && Array.isArray(western.differentials)) {
    western.differentials = records(western.differentials).filter((item) =>
      !/不适用/.test(`${typeof item.reason === "string" ? item.reason : ""}${typeof item.distinguishingPoints === "string" ? item.distinguishingPoints : ""}`));
  }
  // 「某某类病」是国标里的分类名，不是病名（测评截图里的「痹证类病」「虚劳类病」）。
  const overview = record(reasoning.overview);
  if (overview && typeof overview.tcmDiseaseName === "string") overview.tcmDiseaseName = overview.tcmDiseaseName.replace(/类病$/u, "");
  // 中医鉴别诊断每例必出（甲方 10.12 测评 2.3「中医鉴别诊断未生成」）：模型没写或写的病名全被归一丢掉时，
  // 用教材【鉴别诊断】对该病列出的病证补齐，要点是教材原文。有限结论（证候未形成）不补。
  if (overview && !isLimitedDiagnose(reasoning) && typeof overview.tcmDiseaseName === "string" &&
    (!Array.isArray(overview.tcmDiseaseDifferentials) || overview.tcmDiseaseDifferentials.length === 0)) {
    // 教材一句话列几个病（「本病应与甲、乙、丙相鉴别」）时，这几个病取到的是同一句：同一句只用一次。
    // 名字与补写小任务、辨证阶段归一走同一个判据（resolveTcmDiseaseDifferentialName）：西医病名（瘾疹节的丘疹性荨麻疹）不贴。
    const diseaseName = overview.tcmDiseaseName;
    const textbookDifferentials = textbookDifferentialsForDisease(diseaseName)
      .flatMap((item) => {
        const resolved = resolveTcmDiseaseDifferentialName(item.name, diseaseName);
        return resolved.action === "drop" ? [] : [{ ...item, name: resolved.name }];
      })
      .filter((item, index, list) => list.findIndex((other) => other.text === item.text) === index);
    // 理由不写来源口吻（「教材列为本病的鉴别病证」），要点去掉「本病与X相鉴别。」这类开场句（2026-10-14 独立评审：元话语）。
    // 教材对鉴别病的描述照列；按本例写区分要点的是辨证阶段的补写（tcm-disease-differential-authoring），这里只是它没写出时的兜底。
    if (textbookDifferentials.length > 0) {
      overview.tcmDiseaseDifferentials = textbookDifferentials.map((item) => ({
        diseaseName: item.name,
        reason: "主症相近",
        distinguishingPoints: item.text
          .replace(/^(?:本病|本证)?(?:应|需|须)?与[^。；;]{1,40}(?:相)?鉴别[。；;]\s*/u, "")
          .replace(/。[；;]/g, "。")
          .trim() || item.text,
        typicalManifestation: "",
        nextCheck: null,
      }));
    }
  }
  // 推荐方向里的系统批注（「按已签名证候反查受控目录锁定，医生可改选」）不是方名的一部分。
  if (overview && typeof overview.recommendedFormulaDirection === "string") {
    overview.recommendedFormulaDirection = overview.recommendedFormulaDirection.replace(/[（(]按已签名证候反查受控目录锁定[^）)]*[）)]/g, "").trim();
  }
  for (const item of records(overview?.tcmDiseaseDifferentials)) {
    if (typeof item.diseaseName === "string") item.diseaseName = item.diseaseName.replace(/类病$/u, "");
  }
  // 中医鉴别的理由写病证本身为何相近，不写「以免漏诊」「避免误诊」这类处置口吻（甲方 10.12 测评；提示词已要求，模型仍偶有，
  // 2026-10-14 评测 28 例里 3 例）。只删这半句；删完为空时保留原句。
  for (const item of [...records(overview?.tcmDiseaseDifferentials), ...records(overview?.tcmDifferentials)]) {
    if (typeof item.reason !== "string") continue;
    const trimmed = item.reason.replace(/[，,；;]?\s*(?:以免|避免|防止)(?:漏诊|误诊)[^，,。；;]*/gu, "").trim();
    if (trimmed.length >= 2) item.reason = trimmed;
  }
  for (const item of records(western?.candidates)) {
    item.name = records(western?.candidates).indexOf(item) === 0 && primary ? primary.name : deliveredDifferentialName(item.name);
  }
}

function deliveredPrescribe(reasoning: Json, options?: DeliveredSurfaceOptions): void {
  // 开方结果里带着辨证阶段的副本：同一口径再投影一次（调用方回传的是已投影的那份，幂等）。
  deliveredDiagnose(reasoning);
  const formula = record(reasoning.formula);
  const priorOverview = record(reasoning.overview);
  const textbookRow = textbookRowForSyndrome(String(priorOverview?.tcmDiseaseName || ""), String(priorOverview?.primarySyndrome || ""));
  const direction = typeof priorOverview?.recommendedFormulaDirection === "string" ? priorOverview.recommendedFormulaDirection.trim() : "";
  for (const candidate of records(formula?.candidates)) {
    // 内服方的药味功效栏不印「外用＋功效」小句（补骨脂「外用消风祛斑」，留出例 S054）：模型照抄知识库原文时也会带上。
    // 外洗、外敷、熏洗类方子不动。
    const decoctionText = JSON.stringify(candidate.decoction ?? "");
    if (!/外洗|外敷|熏洗|坐浴|外涂|湿敷/u.test(decoctionText)) {
      for (const herb of records(candidate.herbs)) {
        if (typeof herb.function !== "string" || !/外用|外治|外敷/u.test(herb.function)) continue;
        const clauses = herb.function.split(/[，,；;]/u).map((clause) => clause.trim()).filter(Boolean);
        const kept = clauses.filter((clause) => !isExternalUseEfficacyClause(clause));
        if (kept.length > 0 && kept.length < clauses.length) herb.function = kept.join("，");
      }
    }
    // 药味功效栏里知识库与核对词典都不给这味药的说法去掉（黄柏「滋阴清热」→「清热」、黄连「舒肝和胃」、益智「益气」、
    // 桔梗「载药下行」）；整栏都没依据时换成知识库的功效短语。知识库里没有这味药时不动。
    for (const herb of records(candidate.herbs)) {
      if (typeof herb.function !== "string" || !herb.function.trim()) continue;
      // 功效栏是兜底占位句（「佐药，本方中的具体配伍作用需医生结合方义复核」）而知识库有该药功效时，交付知识库功效（2026-10-18 留出集 S145
      // 赤小豆：库里有「利水消肿，解毒排脓」，只因与本方治法对不上被换成了占位句）。库里也没有时照留。
      if (/需医生结合方义复核/u.test(herb.function)) {
        const plain = getTcmHerbFunctionDisplayText(String(herb.name || ""), String(herb.role || ""), "", "", false);
        if (plain && !/需医生结合方义复核/u.test(plain)) herb.function = conciseHerbFunctionLabel(plain, 2);
        continue;
      }
      const knowledge = herbFunctionKnowledgeForDisplay(String(herb.name || ""));
      const unsupported = herbFunctionClaimUnsupportedPhrases(herb.function, knowledge);
      // 逐句去：一句去掉无依据的词之后，剩下的还得自己是一条功效（落在功效概念组里，或就是知识库原文的一段），否则整句去掉。
      // 此前只抠掉词本身，「补益肝肾，强健腰膝」去掉「补益」剩「肝肾」（2026-10-18 甲方标准病历 6 川牛膝，三次生成里两次）。
      // 两句只是字序不同的（「滋阴补血，补血滋阴」）只留一句。
      const seen = new Set<string>();
      // 剩下的半句要是知识库里某一项本身或它的开头才算（石菖蒲「开窍」是「开窍豁痰」的开头，算；「肝肾」只是「补肝肾」的后半，不算）。
      const knowledgeItems = new Set(knowledge.split(/[，,；;、]/u).map((item) => item.trim()).filter(Boolean));
      const originalClauses = herb.function.split(/[，,；;、]/u).map((clause) => clause.trim()).filter(Boolean);
      const clauses = herb.function.split(/[，,；;、]/u).map((clause) => clause.trim()).flatMap((clause) => {
        // 讲配伍分工的小句（「制约温补」「防疏风伤阴」「使祛风不伤正」）说的是与别的药的关系，不是这味药的功效，不动。
        if (/^(?:制约|防|使|配|协调|佐制|监制|以防)/u.test(clause)) {
          const fingerprint = [...clause].sort().join("");
          if (seen.has(fingerprint)) return [];
          seen.add(fingerprint);
          return [clause];
        }
        // 无依据的词只能从小句的头或尾去掉（「滋阴清热」→「清热」）；夹在中间的（「补气以养心神」「健脾益气兼能止泻」）去掉会留下残句，整句不留。
        let rest = clause;
        for (let changed = true; changed;) {
          changed = false;
          for (const phrase of unsupported) {
            if (rest.startsWith(phrase)) { rest = rest.slice(phrase.length); changed = true; }
            else if (rest.endsWith(phrase)) { rest = rest.slice(0, -phrase.length); changed = true; }
          }
        }
        rest = rest.trim();
        if (unsupported.some((phrase) => rest.includes(phrase))) return [];
        if (!/[\u4e00-\u9fff]{2,}/u.test(rest)) return [];
        // 去掉无依据的词后剩下的半句已被同栏另一句包含（「滋阴清热」去「滋阴」剩「清热」，同栏已有「清热燥湿」）时不重复留。
        if (rest !== clause && originalClauses.some((other) => other !== clause && other.length > rest.length && other.includes(rest))) return [];
        if (rest !== clause && (/^[以而并及与和兼助]|[以而并及与和兼助]$/u.test(rest) ||
          (!herbFunctionPhraseRecognized(rest) && ![...knowledgeItems].some((item) => item.startsWith(rest))))) return [];
        const fingerprint = [...rest].sort().join("");
        if (seen.has(fingerprint)) return [];
        seen.add(fingerprint);
        return [rest];
      });
      // 没有要去的词、也没有重复句时原样留（分隔符等不动）。
      if (unsupported.length === 0 && clauses.length === herb.function.split(/[，,；;、]/u).filter((clause) => clause.trim()).length) continue;
      // 整栏都去掉时换成知识库功效（与上面占位句那一支同一取法，再投影一次结果不变）；知识库也给不出时照留原文。
      // 治法对不上时展示取法会给空串，再退到知识库功用的前几条（分类标签「…药」不算）。
      const plain = clauses.length > 0 ? "" : getTcmHerbFunctionDisplayText(String(herb.name || ""), String(herb.role || ""), "", "", false) ||
        [...knowledgeItems].filter((item) => !/药$/u.test(item) && !/外用/u.test(item)).slice(0, 3).join("，");
      // 知识库兜底取前几条时同一功效的两种写法常连着出现（石膏「清热泻火，清热降火」、栀子「清热解毒，清热利尿，清热利湿」、
      // 苦杏仁「祛痰止咳，止咳平喘，降气止咳平喘」，2026-10-19 H 集 0461、17949、597）：近义只留一条，最多两条（conciseHerbFunctionLabel）。
      const dedupedPlain = conciseHerbFunctionLabel([...new Map(plain.split(/[，,]/u).map((item) => item.trim()).filter(Boolean)
        .map((item) => [[...item].sort().join(""), item] as const)).values()].join("，"), 2);
      herb.function = clauses.length > 0
        ? clauses.join("，")
        : dedupedPlain && !/需医生结合方义复核/u.test(dedupedPlain) ? dedupedPlain : herb.function;
    }
    // 功效栏最后整理一遍（模型写的与知识库兜底的都过）：括注与小句开头的连接字去掉、近义重复只留一条（conciseHerbFunctionLabel）；
    // 不是调和药的「调和诸药」去掉（withoutUnsupportedHarmonizingClause：茯神、五味子作使药写成「…，调和诸药」）。
    for (const herb of records(candidate.herbs)) {
      if (typeof herb.function !== "string" || !herb.function.trim() || /需医生结合方义复核/u.test(herb.function)) continue;
      const name = String(herb.name || "");
      herb.function = conciseHerbFunctionLabel(withoutUnsupportedHarmonizingClause(name, herb.function,
        `${herbFunctionKnowledgeForDisplay(name)}；${getTcmHerbFunctionText(name)}`));
    }
    // 名实相符（2026-10-19 M 集 Claude 评审：「乌头汤加减」方中无川乌、「沙参麦冬汤加减」无沙参）：方名承载药不在处方里的那张方
    // 不再用它命名——多为系统不编制用量、要求不写进药味表的毒性或品种未定的味（制川乌、朱砂、沙参）。合方去掉那一张；
    // 一张不剩时与服务端剥名同一形态（自拟方、formulaNames 与 baseFormulas 为空、self_devised），出处栏写自拟方。
    // 判据见 formulaNameWithIdentityHerbsPresent；方义开头随后按最终方名改（withOpeningMatchingFormulaName）。
    // 放在改回教材代表方之前：去掉名实不符的方名后，辨证阶段推荐的那张方若确在处方里，下面照常改回（再投影一次结果不变）。
    if (typeof candidate.name === "string") {
      const renamed = formulaNameWithIdentityHerbsPresent(candidate.name, records(candidate.herbs).map((herb) => String(herb.name || "")));
      if (renamed) {
        const droppedNames = new Set(renamed.dropped.map((item) => item.formula));
        const keptName = (value: unknown) => typeof value === "string" && !droppedNames.has(value.trim().replace(/(?:加减|化裁|加味)$/u, ""));
        candidate.name = renamed.name;
        if (Array.isArray(candidate.formulaNames)) candidate.formulaNames = candidate.formulaNames.filter(keptName);
        if (Array.isArray(candidate.baseFormulas)) candidate.baseFormulas = records(candidate.baseFormulas).filter((base) => keptName(base.name));
        if (typeof candidate.constructionType === "string") {
          candidate.constructionType = renamed.kept.length === 0 ? "self_devised" : renamed.kept.length === 1 ? "single_base" : "combined";
        }
        const sourceRecord = record(candidate.formulaSource);
        if (sourceRecord && typeof sourceRecord.source === "string") {
          const entries = sourceRecord.source.split(/[；;]/u).map((item) => item.trim()).filter(Boolean)
            .filter((item) => ![...droppedNames].some((formula) => item.startsWith(`${formula}：`) || item.startsWith(`${formula}:`)));
          sourceRecord.source = renamed.kept.length === 0 || entries.length === 0 ? "自拟方" : entries.join("；");
          if (renamed.kept.length === 0) {
            sourceRecord.evidenceLevel = "model_inference";
            sourceRecord.confidence = "中";
          }
        }
      }
    }
    // 两个阶段方名一致（甲方 10.12 测评「方剂名称前后不一致」）：辨证阶段定的是教材代表方、处方确实以该方组成为主体
    //（教材组成过半在方中），而方名在开方阶段被改成了别的名字或「本例辨证组方」时，方名用辨证阶段定下的那个。
    // 组成没有过半时不改名——那时方子确实不是这张方，名字照实。
    if (textbookRow && direction && textbookRow.formulas.some((name) => direction.includes(name)) &&
      typeof candidate.name === "string" && !textbookRow.formulas.some((name) => String(candidate.name).includes(name))) {
      const herbs = records(candidate.herbs).map((herb) => String(herb.name || ""));
      // 只认辨证阶段推荐方向里写到的那几张：教材一行常列两张方分治两种偏向（尿浊·肾虚不固证「偏肾阴虚者知柏地黄丸；偏肾阳虚者
      // 鹿茸补涩丸」），推荐方向写的是鹿茸补涩丸，处方也是温肾固涩，却因熟地、山萸肉、山药、茯苓占了知柏地黄丸一半组成被改名成
      //「知柏地黄丸加减」（2026-10-19 M 集 RobustSDT-single_0280，评审：方中无知母、黄柏）。
      const directed = textbookRow.formulas.filter((name) => direction.includes(name));
      const covered = textbookFormulasCoveredByPrescription({ ...textbookRow, formulas: directed }, herbs);
      if (covered.length > 0) {
        // 合方只有其中一张的组成在处方里时，方名只写那一张（「龙胆泻肝汤合萆薢渗湿汤加减」而方中没有后者的药）。
        const allCovered = covered.length === directed.length;
        candidate.name = allCovered ? (/加减$/.test(direction) ? direction : `${direction}加减`) : `${covered.join("合")}加减`;
        const sourceRecord = record(candidate.formulaSource);
        // 出处写方剂的原书（方剂目录里有的按目录），目录没有收的方才注明是哪本教材哪一证的代表方。
        // 此前一律写教材（「三子养亲汤：《中医内科学》咳嗽·痰湿蕴肺证代表方」），原书应为《韩氏医通》（2026-10-13 独立评审）。
        if (sourceRecord) {
          const textbookNote = `《${textbookRow.book}》${textbookRow.disease}·${textbookRow.syndromeName}代表方`;
          sourceRecord.source = covered
            // 编译目录没有这首方时，名录里与教材组成逐味相同的那一条是原书（加味四物汤《金匮翼》卷五，2026-10-19 甲方标准病历 3）；
            // 都没有时才写教材。
            // 组成与教材对不上的同名异方不用；国家经典名方目录、同方另一剂型也查（textbookFormulaOriginalSource，2026-10-19 化肝煎、十全大补丸）。
            .map((name) => `${name}：${textbookFormulaOriginalSource(name, textbookBaseIngredients(textbookRow, [name]), textbookCompositionOptions(textbookRow)) || textbookNote}`)
            .join("；");
        }
        // 方义里的方名此前被当作「自拟方不得自称成方」替换成了「本方案」，随方名一起还原。
        if (typeof candidate.formulaAnalysis === "string") {
          // 方名已随辨证阶段改回教材代表方，方义开头「本方为自拟方」改成以该方为基础（与方名同一判据，见 withOpeningMatchingFormulaName；
          // 此前把「自拟方」三字换成「以X加减」，开头成了「本方为以虎潜丸加减」，H 集 10322 等三例）。句中其余「故自拟组方」随之改掉。
          const label = covered.join("合");
          candidate.formulaAnalysis = withOpeningMatchingFormulaName(candidate.formulaAnalysis, String(candidate.name)).text
            .replace(/(?<!本方[为系乃属])自拟(?:组方|方剂|一方|方)/g, `以${label}加减`);
        }
      }
    }
    // 方名本来就是辨证阶段定的教材代表方（「竹叶石膏汤加减」），处方以该方组成为主体（教材组成过半在方中）时，出处写这首方的原书，
    // 与上面改名时同一取法：
    //  · 按证去掉其中几味（胃火上逆去人参、粳米）不足八成、出处核验没有通过，出处栏写着「当前可核验依据不足」
    //   （2026-10-19 留出例 S046，评审：竹叶石膏汤出《伤寒论》，知识库目录即有）；
    //  · 此前写成了教材（「《中医内科学》头痛·血虚头痛代表方」）而名录里有与教材组成逐味相同的原书条目（加味四物汤《金匮翼》卷五，
    //    甲方标准病历 3）。已是原书的不动，再投影结果不变。
    if (textbookRow && typeof candidate.name === "string" && textbookRow.formulas.some((name) => String(candidate.name).includes(name))) {
      const sourceRecord = record(candidate.formulaSource);
      const covered = textbookFormulasCoveredByPrescription(textbookRow, records(candidate.herbs).map((herb) => String(herb.name || "")))
        .filter((name) => String(candidate.name).includes(name));
      if (sourceRecord && covered.length > 0) {
        const current = typeof sourceRecord.source === "string" ? sourceRecord.source : "";
        const textbookNote = `《${textbookRow.book}》${textbookRow.disease}·${textbookRow.syndromeName}代表方`;
        const next = covered.map((name) => `${name}：${textbookFormulaOriginalSource(name, textbookBaseIngredients(textbookRow, [name]), textbookCompositionOptions(textbookRow)) || textbookNote}`).join("；");
        const placeholder = !current.trim() || /证据不足|依据不足|待检索|待核验|内部证据缺口|EVIDENCE_GAP/u.test(current);
        const upgradesTextbookNote = /代表方/u.test(current) && !/代表方/u.test(next);
        // 编译目录没有这首方、出处是按方名从名录里取的同名异方（加味四物汤《朱氏集验方》卷十，五味），而名录里有与教材组成
        // 逐味相同的原书（《金匮翼》卷五）：换成后者（2026-10-19 甲方标准病历 3 第三轮复测两次判「同名异方的出处」）。
        // 编译目录有这首方（竹叶石膏汤《伤寒论》）而出处取成了组成更像的同名后世方（《症因脉治》卷一，多一味知母）时同理：
        // 教材代表方指的是编译目录那一首（2026-10-19 留出例 S046 第三轮复测）。处方确以它为主体（covered 已要求组成过半）。
        const homonymSource = covered.some((name) => {
          const preferred = textbookFormulaOriginalSource(name, textbookBaseIngredients(textbookRow, [name]), textbookCompositionOptions(textbookRow));
          if (!preferred || current.includes(preferred)) return false;
          // 同一本书的不同写法（《外台》与《外台秘要》）不算换书：书名里任一相邻两字已在现有出处里就不动。
          const title = preferred.replace(/[《》\s]/gu, "").replace(/卷.*$/u, "");
          return ![...title].slice(0, -1).some((_, index) => current.includes(title.slice(index, index + 2)));
        });
        // 出处是受治理条目的书、而那一条与教材组成对不上（同名异方，textbookFormulaOriginalSource 不认它）、名录里也找不到教材那一首：
        // 写教材出处，不署一本组成不同的书（四七汤：受治理条目《局方》人参、官桂、半夏、甘草；教材的四七汤是半夏、厚朴、茯苓、苏叶、
        // 姜、枣，2026-10-19 M 集 RobustSDT-single_0061）。
        const governedHomonym = covered.some((name) => {
          const reference = formulaCompilationReferences([name])[0];
          return Boolean(reference?.source) && current.includes(reference!.source) &&
            textbookFormulaGovernedEntryIsHomonym(name, textbookBaseIngredients(textbookRow, [name]), textbookCompositionOptions(textbookRow));
        });
        if (placeholder || upgradesTextbookNote || homonymSource || governedHomonym) sourceRecord.source = next;
      }
    }
    // 方义里的方名此前被「自拟方不得自称成方」一律换成了「本方案」（tcm-formula-provenance）。
    // 方名最终是成方时把它换回来；确是自拟方时「本方以本方案为基础加减」只是空话，改成一句说明。
    // 此前只处理了带「为基础」的写法，「本方以本方案加减。」被留成「本方以本方。」（合成集 84 例里 3 例）。
    if (typeof candidate.formulaAnalysis === "string" && /本方案/.test(candidate.formulaAnalysis)) {
      const finalName = typeof candidate.name === "string" ? candidate.name.trim() : "";
      const selfComposed = !finalName || finalName === "自拟方" || SELF_COMPOSED_NAME.test(finalName);
      const label = finalName.replace(/加减$/u, "");
      // 开头点方名的那个分句整句重写：占位替换会把合方名拆坏（「本方以本方案合脾约本方案为基础加减」「本方以本方案化裁」），
      // 逐个词替换救不回来；后文其余的「本方案」改回「本方」。
      const opening = candidate.formulaAnalysis.match(/^([^，,。；;]*本方案[^，,。；;]*)([，,。；;])\s*/);
      const rest = opening ? candidate.formulaAnalysis.slice(opening[0].length) : candidate.formulaAnalysis;
      candidate.formulaAnalysis = `${opening ? (selfComposed ? "本方为自拟方。" : `本方以${label}为基础加减${opening[2]}`) : ""}${rest}`
        .replace(/本方案/g, "本方");
    }
    // 方义开头与最终方名一致（自拟方 / 以某方为基础），三种写法同一个判据（withOpeningMatchingFormulaName）。
    if (typeof candidate.formulaAnalysis === "string" && typeof candidate.name === "string") {
      candidate.formulaAnalysis = withOpeningMatchingFormulaName(candidate.formulaAnalysis, candidate.name).text;
    }
    // 方义里的药名按药味表写（朱茯神→茯神，withMentionsAlignedToTableNames；编译时审过一次，交付面按最终药味表再对一次）；
    // 去掉阴性净化器写进方义的病历断言小句；只点了角色的药补上药味表里它的功效。
    // 不是调和药的药说成「调和诸药」的去掉（withoutUnsupportedHarmonizingClaims，与功效栏同一判据 herbHarmonizesFormula）。
    if (typeof candidate.formulaAnalysis === "string") {
      const herbRows = records(candidate.herbs);
      const tableNames = herbRows.map((herb) => String(herb.name || "")).filter(Boolean);
      const aligned = withoutChartAssertionClauses(withMentionsAlignedToTableNames(withoutProcessParentheticals(candidate.formulaAnalysis).text, tableNames).text).text;
      const harmonized = withoutUnsupportedHarmonizingClaims(aligned, tableNames,
        (name) => `${herbFunctionKnowledgeForDisplay(name)}；${getTcmHerbFunctionText(name)}`).text;
      candidate.formulaAnalysis = withRoleOnlyHerbsExplained(withoutStrayLeadingRoleVerb(harmonized).text, herbRows).text;
    }
    // 方义说「去原方中…之品」而处方其实保留了原方全部药味（2026-10-17：甲方标准病历 1、4、10，三次生成里 4 次，独立评审判陈述失实）。
    // 方名能在方剂目录里查到组成、且组成逐味都在处方里时，去掉这句「去…」以及紧跟的「保留…/留其主体」；查不到组成时不动。
    if (typeof candidate.formulaAnalysis === "string" && REMOVAL_CLAIM_CLAUSE.test(candidate.formulaAnalysis) && typeof candidate.name === "string") {
      const baseName = candidate.name.trim().replace(/(?:加减|化裁|加味)$/u, "");
      const reference = formulaCompilationReferences([baseName])[0];
      const present = new Set(records(candidate.herbs).map((herb) => compositionIdentityName(String(herb.name || ""))).filter(Boolean));
      const ingredients = (reference?.ingredients || []).map((name) => compositionIdentityName(name.replace(/[（(][^）)]*[）)]/g, ""))).filter(Boolean);
      if (ingredients.length > 0 && ingredients.every((id) => present.has(id))) {
        candidate.formulaAnalysis = withoutRemovalClaims(candidate.formulaAnalysis);
      }
    }
    // 方义说「去桑皮…」而桑白皮就在处方里（2026-10-18 留出例 S151 清金化痰汤）：点名去掉的药味按组成身份全在处方里时，这一小句不实，去掉。
    // 放在「加X」核对之前：「去原方之淡竹叶用量从简而加芦根」去掉前半后剩「加芦根」，要再经加药核对（再投影一次结果不变，X 集 C-0394）。
    if (typeof candidate.formulaAnalysis === "string" && /(?:去|去掉|删去|减去)/u.test(candidate.formulaAnalysis)) {
      const present = new Map<string, string[]>();
      for (const herb of records(candidate.herbs)) {
        const name = String(herb.name || "");
        const identity = compositionIdentityName(name);
        if (identity) present.set(identity, [...(present.get(identity) || []), name]);
      }
      candidate.formulaAnalysis = withoutFalseNamedRemovalClaims(candidate.formulaAnalysis, present);
    }
    // 开头一句说「加X」而X本来就在原方组成里（含生用写法：消风散原方有地黄，方义写「加生地黄」「以生地黄易原方地黄并加用」，
    // 2026-10-17 甲方标准病历 9 两次生成）：去掉这个不实的加药说法，其余照留。原方组成查不到时不动。
    if (typeof candidate.formulaAnalysis === "string" && typeof candidate.name === "string" && /加|易/.test(candidate.formulaAnalysis)) {
      const baseName = candidate.name.trim().replace(/(?:加减|化裁|加味)$/u, "");
      const reference = formulaCompilationReferences([baseName])[0];
      // 方名是辨证阶段定的教材代表方、而受治理条目是组成不同的同名异方时，原方组成按教材：四七汤的受治理条目是《局方》人参、官桂、
      // 半夏、甘草，教材呕吐·肝气犯胃证的四七汤是半夏、厚朴、茯苓、苏叶、姜、枣，方义说「加紫苏叶、厚朴、生姜、大枣」不实
      //（2026-10-19 M 集 RobustSDT-single_0061）。不是同名异方时不用教材组成：教材行常把本证的加味一起列进组成
      //（儿科沙参麦冬汤列了桑白皮、款冬花，胁痛行把逍遥散与柴胡疏肝散并列），拿它当原方会把真的加药说法去掉。
      const textbookBase = textbookRow && textbookRow.formulas.some((name) => baseName.includes(name)) &&
        textbookFormulaGovernedEntryIsHomonym(baseName, textbookBaseIngredients(textbookRow, [baseName]), textbookCompositionOptions(textbookRow))
        ? textbookBaseIngredients(textbookRow, [baseName]) : [];
      const catalogIds = new Set((textbookBase.length > 0 ? textbookBase : reference?.ingredients || [])
        .map((name) => rawFormHerbIdentity(name.replace(/[（(][^）)]*[）)]/g, ""))).filter(Boolean));
      if (catalogIds.size > 0) candidate.formulaAnalysis = withoutFalseAdditionClaims(candidate.formulaAnalysis, catalogIds);
    }
    // 方义里夹着模型的自问自答（「去原方中…的川芎？不，川芎保留。」，2026-10-17 甲方标准病历 4）：带问号的小句与同句里紧跟的自我更正不留。
    if (typeof candidate.formulaAnalysis === "string" && /[二两](?:药|味)/u.test(candidate.formulaAnalysis)) {
      candidate.formulaAnalysis = withRecountedPairWords(candidate.formulaAnalysis, records(candidate.herbs).map((herb) => String(herb.name || "")).filter(Boolean));
    }
    if (typeof candidate.formulaAnalysis === "string" && /[？?]/.test(candidate.formulaAnalysis)) {
      candidate.formulaAnalysis = withoutQuestionChatter(candidate.formulaAnalysis);
    }
    if (typeof candidate.name === "string" && SELF_COMPOSED_NAME.test(candidate.name.trim())) candidate.name = "自拟方";
    // 「适用于与本例锁定证候…及病机链一致的情况」是每例相同的模板句，不带内容。
    if (typeof candidate.applicable === "string") candidate.applicable = "";
    // 逐味人群提示只列本例可能属于的人群：按候选药味从同一份知识库重写尾段（尾段的写法只在 candidate-boundary-text 一处）。
    // 投影后尾段的标记已去掉，再投影一次不会重写，幂等。
    if (options?.herbBoundaryAudience && typeof candidate.notApplicable === "string" && hasHerbBoundaryTail(candidate.notApplicable)) {
      const herbNames = records(candidate.herbs).map((herb) => typeof herb.name === "string" ? herb.name.trim() : "").filter(Boolean);
      const tail = herbBoundaryTail(herbNames.map((name) => getTcmHerbGenerationSafetyProfile(name)), options.herbBoundaryAudience);
      // 交付面本来只留尾段（尾段前的模板句由下面同一处去掉）；一味都不剩时整栏为空。
      candidate.notApplicable = tail ? [stripHerbBoundaryTail(candidate.notApplicable), tail].filter(Boolean).join(" ") : "";
    }
    if (typeof candidate.notApplicable === "string") {
      const text = candidate.notApplicable;
      if (/各药毒性与特殊人群提示[:：]/.test(text)) {
        // 只留逐味的特殊人群提示（数据来自药典与说明书），去掉前面每例相同的模板句与收尾的流程话。
        candidate.notApplicable = text.replace(NOT_APPLICABLE_TEMPLATE_HEAD, "")
          .replace(/^各药毒性与特殊人群提示[:：]\s*/, "")
          .replace(/相应人群或状态请停用、替换，或经医生\/药师复核后使用。?$/, "")
          .replace(/禁用或须强复核/g, "禁用").replace(/[；;。\s]+$/g, "").trim();
      } else if (/^证候、病机、舌脉或安全边界变化时/.test(text.trim())) {
        candidate.notApplicable = "";
      }
    }
    const source = record(candidate.formulaSource);
    if (source && typeof source.source === "string" && /^自拟方/.test(source.source.trim())) source.source = "自拟方";
    // 合方出处各条收尾的句号去掉（「五神汤：《辨证录》卷十三。；萆薢渗湿汤：…」，S143；写法同 formulaSourceLabel）。
    if (source && typeof source.source === "string") source.source = source.source.replace(/[。．.]+(?=\s*[；;]|\s*$)/gu, "");
  }
  for (const medicine of records(formula?.patentAndWestern)) {
    // 说明书各段拼接留下的「；；」「。；」「。。」：收成一个标点（第五轮方名代理统计 741 条里 17 条）。
    if (typeof medicine.riskNote === "string") medicine.riskNote = medicine.riskNote.replace(/([；;。])(?:\s*[；;。])+/gu, "$1");
    // 「说明书用法字段已与本候选的说明书条目及指纹绑定」「与中药饮片方案不默认联用…」是系统说明，不是用药信息。
    if (typeof medicine.usageBoundary === "string") medicine.usageBoundary = "";
    if (typeof medicine.relationship === "string") medicine.relationship = "";
  }
  const nonPharma = record(reasoning.nonPharma);
  if (nonPharma && Array.isArray(nonPharma.precautions)) {
    // 整句被禁词表或净化清空后只剩标点的条目不下发。
    nonPharma.precautions = nonPharma.precautions.filter((item) => typeof item === "string" && /[\u4e00-\u9fff]{4,}/u.test(item));
  }
  if (nonPharma && Array.isArray(nonPharma.tcmTreatments)) {
    // 给不出具体内容的项目不下发（甲方 10.12 测评 5.2「中医治疗具体内容未展示」）：「仅评估」的项目只有项目名和一句
    //「本轮仅进行现场评估，不形成操作计划」；食疗、导引、情志这类无穴项目在目录里只有类目模板、没有任何做法。
    nonPharma.tcmTreatments = records(nonPharma.tcmTreatments).filter((item) => {
      // 仅评估、无穴项目只有类目模板、病种模板只是一段治则（甲方标准病历 5 的推拿卡）：与出卡处选三张卡时同一个判据
      //（tcm-treatment-capabilities treatmentCardUndeliverable，2026-10-19 起共用，此前两处各写一份，选卡占了名额、交付时又删掉）。
      if (treatmentCardUndeliverable(item)) return false;
      // 食疗方与本例饮食宜忌相反：饮食栏写清淡、忌油腻或避免滋腻，食疗卡却是猪排、猪肺这类肥甘之品
      //（2026-10-17，甲方标准病历 9「芋头炖猪排」对「饮食清淡易消化」，病历 5「猪肺粥」对「避免滋腻碍脾」）。
      // 判据与出卡处同一份（tcm-nondrug-textbook-plan 的 dietAdviceAvoidsRichFood / recipeHasRichIngredient）。
      if (item.projectCode === "diet_therapy" && dietAdviceAvoidsRichFood(String(nonPharma.diet || "")) &&
        recipeHasRichIngredient(String(item.treatmentContent || ""))) return false;
      return true;
    });
  }
  if (nonPharma) {
    const foods = avoidedFoods([String(nonPharma.diet || ""), ...(Array.isArray(nonPharma.precautions) ? nonPharma.precautions.map((line) => String(line || "")) : [])]);
    if (foods.length > 0) {
      if (typeof nonPharma.diet === "string") nonPharma.diet = withoutContradictingRecommendation(nonPharma.diet, foods);
      if (Array.isArray(nonPharma.tcmTreatments)) {
        nonPharma.tcmTreatments = records(nonPharma.tcmTreatments).filter((item) => item.projectCode !== "diet_therapy" ||
          !foods.some((food) => mentionsFood(String(item.treatmentContent || ""), food)));
      }
    }
  }
  if (nonPharma && typeof nonPharma.diet === "string" && nonPharma.diet.trim()) {
    // 饮食段里说汤药什么时候服（「饭前温服汤药」）而煎服法是饭后（或反过来）：以煎服法为准，去掉饮食段那一小句
    //（2026-10-19 Claude 评审 M 集 TCM-SD-422604；注意事项一栏 10/17 起已按同一判据处理，饮食段没接上）。
    const dietMethod = String(record(records(formula?.candidates)[0]?.decoction)?.method || "");
    const dietMethodTiming = /饭后|餐后/.test(dietMethod) ? "after" : /饭前|餐前|空腹/.test(dietMethod) ? "before" : "";
    const dietConflicting = dietMethodTiming === "after" ? /(?:饭前|餐前|空腹)[^，,。；;]{0,6}(?:服|汤药|药)/u
      : dietMethodTiming === "before" ? /(?:饭后|餐后)[^，,。；;]{0,6}(?:服|汤药|药)/u : undefined;
    if (dietConflicting) nonPharma.diet = withoutTimingClauses(String(nonPharma.diet), dietConflicting);
    // 饮食段推荐当食物吃的药，正是方中药典标注有毒的那味（「适量食用桃仁煮粥或入菜」而方中已有桃仁，M 集 TCM-SD-466542、488992、481822）：
    // 等于加量，去掉那一小句。
    const toxicInFormula = records(records(formula?.candidates)[0]?.herbs)
      .map((herb) => String(herb.name || "").trim())
      // 有毒，或药典「孕妇慎用/禁用」的峻烈之品（桃仁、红花、三棱…）：当食物吃就是加量。药食同源、又不属活血/攻下类的（薏苡仁、莲子、山药）
      // 当食物吃照常（第五轮注意事项代理回放：此前 25 份饮食段里的薏米粥一类被删，男性病人也删）。桃仁也在药食同源目录里，按活血化瘀药照删。
      .filter((name) => name.length >= 2 && (getTcmHerbGenerationSafetyProfile(name).toxicity.length > 0 ||
        (Boolean(chpPregnancyLabel(name)) && !(isFoodMedicineHomologyItem(name.replace(/^(?:燀|炒|焯|生|制|法|姜|清)/u, "")) &&
          !getTcmHerbFunctionCategories(name).some((category) => /活血|破血|泻下|攻下|逐水/u.test(category))))))
      .map((name) => name.replace(/^(?:燀|炒|焯|生|制|法|姜|清)/u, ""));
    if (toxicInFormula.length > 0) {
      nonPharma.diet = withoutTimingClauses(String(nonPharma.diet), (clause) => toxicInFormula.some((name) => clause.includes(name)) &&
        // 「少食/少吃」是忌口，「少量食用桃仁煮粥」不是（M 集 test-488）。
        !/忌|勿|不宜|不要|避免|少食|少吃|少饮|少用/u.test(clause));
    }
    // 糖尿病：饮食段推荐的含糖多的食物（红枣、蜂蜜、冰糖…）那一小句去掉（2026-10-19 Claude 评审 M 集 TCM-SD-453850「红枣胡萝卜汤」；
    //《中国2型糖尿病防治指南（2020年版）》医学营养治疗：限制添加糖与含糖饮料）。叫患者少吃、不吃的照留。
    if ((options?.requiredPrecautions || []).some((item) => item.kind === "diabetes_glucose")) {
      nonPharma.diet = withoutHighSugarRecommendations(String(nonPharma.diet));
    }
  }
  if (nonPharma && Array.isArray(nonPharma.precautions)) {
    // 去掉卡之后再按最终给出的项目核一遍注意事项（出卡处按出卡时的集合核过，交付面去掉的卡它不知道）。
    const delivered = deliveredTreatmentCodes(records(nonPharma.tcmTreatments), nonPharma.acupointCare);
    let precautions: unknown[] = nonPharma.precautions.filter((line) => !precautionMentionsUndeliveredTreatment(line, delivered));
    // 说「方中有某药」而该药已不在最终处方里（编译之后还会剔药：方向不成立的加味、加减建议）：只去掉这个药名，
    // 只讲这味药的那一小句去掉，别的小句照留（2026-10-19 留出例 S145「方中黄柏、苍术苦寒燥烈」，苍术已剔出本方）。
    const prescribedIdentities = new Set([
      ...records(records(formula?.candidates)[0]?.herbs).map((herb) => canonicalTcmHerbIdentity(String(herb.name || ""))),
      ...records(formula?.modifications).map((item) => canonicalTcmHerbIdentity(String(item.herbName || ""))),
    ].filter(Boolean));
    precautions = precautions
      .map((line) => typeof line === "string" ? precautionWithoutAbsentHerbs(line, prescribedIdentities) : line)
      .filter((line) => typeof line !== "string" || line.trim().length > 0);
    // 服药时间以本方的煎服法为准：煎服法写饭后、注意事项写饭前（或反过来）时，去掉注意事项里说时间的那一小句
    //（甲方标准病历 2 两次生成都是「汤剂宜饭前温服」对「饭后温服」）。
    const method = String(record(records(formula?.candidates)[0]?.decoction)?.method || "");
    const methodTiming = /饭后|餐后/.test(method) ? "after" : /饭前|餐前|空腹/.test(method) ? "before" : "";
    // 「若胃脘不适可改为饭后温服」而煎服法本来就是饭后（甲方标准病历 2）：说「改为」煎服法已定的时间，同样前后矛盾；
    // 煎服法是饭前时，「若胃脘不适可改为饭后」是有条件的改法，不算矛盾，照留。
    const conflicting = methodTiming === "after"
      ? /(?<!改(?:为|在|到))(?:饭前|餐前|空腹)|改(?:为|在|到)(?:饭|餐)后/
      : methodTiming === "before" ? /(?<!改(?:为|在|到))(?:饭后|餐后)|改(?:为|在|到)(?:(?:饭|餐)前|空腹)/ : undefined;
    if (conflicting) {
      precautions = precautions
        .map((line) => typeof line === "string" ? withoutTimingClauses(line, conflicting) : line)
        .filter((line) => typeof line === "string" && /[\u4e00-\u9fff]{4,}/u.test(line));
    }
    // 注意事项叫患者别再服的药，正是本次推荐西成药里的药（2026-10-17：「不宜再服人参口服液」与推荐人参口服液同出一页）。
    // 推荐是医生评估后的选项，注意事项那一条不留。
    // 注意事项说「不宜再服含X的中成药」，推荐的中成药说明书成份正含X（按组成身份比较，与推荐药重复判据同一份组成）：
    // 不推荐那味药，注意事项照留（2026-10-19 Claude 评审 M 集 RobustSDT-0299 一类：注意事项与推荐药自相矛盾）。
    const avoidedContained = new Set(precautions.flatMap((line) => typeof line === "string" ? precautionAvoidedContainedHerbs(line) : [])
      .map((name) => textbookDistinctHerbKey(name)).filter(Boolean));
    if (avoidedContained.size > 0 && formula && Array.isArray(formula.patentAndWestern)) {
      formula.patentAndWestern = records(formula.patentAndWestern).filter((item) => item.type === "西药" ||
        !patentMedicineCompositionIdentities(String(item.name || "")).some((herb) => avoidedContained.has(herb)));
    }
    const recommended = records(formula?.patentAndWestern).map((item) => String(item.name || "").trim()).filter((name) => name.length >= 2);
    if (recommended.length > 0) {
      precautions = precautions.filter((line) => typeof line !== "string" ||
        !recommended.some((name) => line.includes(name) && /不宜|不要|勿|避免|停服|忌/.test(line)));
      // 同一类：注意事项说「不宜再服润肠通便类中成药」，推荐里正有便通胶囊、乳果糖（留出例 S058，独立评审：同类问题甲方曾要求剔除）。
      // 类名（「润肠通便」）出现在推荐药的名称、对应问题或适应证里（也读本地说明书的适应证：推荐行只带对应问题时，「新复方芦荟胶囊（失眠）」
      // 看不出是通便药，M 集 RobustSDT-0431），或类名的两个二字词都出现，就算同一类。
      const medicineText = (item: Json) => [item.name, item.correspondingProblem, item.indication, item.functionIndication,
        findLocalPatentMedicineLabel(String(item.name || ""))?.indication].filter((value) => typeof value === "string").join("；");
      const decoctionHerbs = records(records(formula?.candidates)[0]?.herbs).map((herb) => String(herb.name || "").trim()).filter(Boolean);
      const decoctionCategories = new Set(decoctionHerbs.flatMap((name) => getTcmHerbFunctionCategories(name)));
      const stacked = new Set<Json>();
      precautions = precautions.filter((line) => {
        if (typeof line !== "string" || !/不宜|不要|勿|避免|停服|忌/.test(line)) return true;
        // 点了成份的（「不宜再服含人参或党参的滋补类中成药」）只管含这几味的成药，上面按成份已处理；不按「滋补」一类去删注意事项（M 集 RobustSDT-0299）。
        if (precautionAvoidedContainedHerbs(line).length > 0) return true;
        // 点了一个具体成药再说「等同类」的（「不要再服人参天麻药酒等同类祛风活血中成药」）说的是患者自己在用的那种，不是推荐的药：照留（留出例 S079）。
        if (/[\u4e00-\u9fff]{2,12}(?:丸|片|胶囊|颗粒|口服液|合剂|药酒|膏|散|冲剂)等(?:同类|其他|此类)?/u.test(line)) return true;
        const category = precautionAvoidedMedicineCategory(line);
        if (!category || category.length < 2) return true;
        const words = category.length >= 4 ? [category.slice(0, 2), category.slice(-2)] : [category];
        const conflicting = records(formula?.patentAndWestern).filter((item) => {
          const text = medicineText(item);
          return text.includes(category) || words.every((word) => text.includes(word));
        });
        if (conflicting.length === 0) return true;
        // 推荐的中成药里起这一类作用的药，与本方汤药里的药同属一类（芦荟与大黄同为攻下药）：注意事项说得对——是推荐药叠加了本方的作用，
        // 不推荐那味药，注意事项照留（M 集 RobustSDT-0431：茵陈蒿汤含大黄，又推荐新复方芦荟胶囊）。否则仍按原口径去掉注意事项那一条。
        const stacking = conflicting.filter((item) => item.type !== "西药" && patentMedicineCompositionIdentities(String(item.name || "")).some((herb) =>
          words.some((word) => getTcmHerbFunctionText(herb).includes(word)) && getTcmHerbFunctionCategories(herb).some((value) => decoctionCategories.has(value))));
        if (stacking.length === conflicting.length) {
          for (const item of stacking) stacked.add(item);
          return true;
        }
        return false;
      });
      if (stacked.size > 0 && formula) formula.patentAndWestern = records(formula.patentAndWestern).filter((item) => !stacked.has(item));
    }
    // 针刺卡在皮损局部取穴（阿是穴、围刺）时，注意事项里「皮损局部暂不施针」那一小句与之矛盾，不留（2026-10-17 本地复测：
    // 蛇串疮卡按教材「皮损局部阿是穴用围刺法」，注意事项写「皮损局部暂不施针」；丹毒卡列阿是穴，注意事项写「红肿处不宜针刺」）。
    const localNeedling = records(nonPharma.tcmTreatments).some((item) => item.projectCode === "acupuncture" &&
      (JSON.stringify(item.suggestedSitesOrPoints || []).includes("阿是穴") || /围刺/.test(`${String(item.techniqueBoundary || "")}${String(item.treatmentContent || "")}`)));
    if (localNeedling) {
      precautions = precautions
        .map((line) => typeof line === "string" ? withoutTimingClauses(line, LOCAL_NEEDLING_FORBIDDEN) : line)
        .filter((line) => typeof line !== "string" || /[\u4e00-\u9fff]{4,}/u.test(line));
    }
    // 红旗未解除：在用药的那一条只写带药就医（规则句补在最前），模型写的「与中药间隔服用」那一小句去掉，
    // 只写「告知医生、是否继续由医生决定」而没写就医的整条也去掉，免得与规则句重复（2026-10-19 留出集 S188）。
    const urgentMedication = (options?.requiredPrecautions || []).find((item): item is Extract<RequiredPrecaution, { kind: "current_medications" }> =>
      item.kind === "current_medications" && Boolean(item.urgent));
    if (urgentMedication) {
      const bases = urgentMedication.names.map((name) => name.replace(/(?:片|胶囊|颗粒|丸|口服液|注射液|缓释片|肠溶片|分散片)$/u, ""));
      precautions = precautions
        .map((line) => typeof line === "string" ? withoutTimingClauses(line, URGENT_INTERVAL_CLAUSE) : line)
        .filter((line) => typeof line !== "string" || (/[\u4e00-\u9fff]{4,}/u.test(line) &&
          !(bases.some((name) => line.includes(name)) && !/带|携带|就医|急诊/u.test(line))));
    }
    // 本例必须写到的项目（自服药、产后哺乳、丹毒抗感染）逐项核对，模型漏写的用规则那句补在最前（2026-10-17）。
    // 已写到的不动；补上之后再投影一次就都算写到了，幂等。
    const required = options?.requiredPrecautions || [];
    if (required.length > 0) {
      const herbIdentities = new Set(records(records(formula?.candidates)[0]?.herbs)
        .map((herb) => compositionIdentityName(String(herb.name || ""))).filter(Boolean));
      // 模型写到的自服药那一条：说重叠的药只留本方真有的；一味不剩又说重叠的，删掉这条，下面按漏写补规则那句。
      for (const item of required) {
        if (item.kind !== "self_medication") continue;
        precautions = precautions.flatMap((line) => typeof line === "string" ? [withOnlyPrescribedOverlap(line, item, herbIdentities)].filter((value): value is string => Boolean(value)) : [line]);
      }
      // 哺乳期慎用的药按逐味人群提示同一份知识库、同一档（中、高）列；模型写「方中暂无哺乳期慎用药」而知识库列了的，换成规则那一句
      //（2026-10-17 本地复测病历 3：同一页的逐味提示写着川芎哺乳期慎用）。
      const candidateHerbNames = records(records(formula?.candidates)[0]?.herbs).map((herb) => String(herb.name || "").trim()).filter(Boolean);
      const lactationSeverity = (name: string) => getTcmHerbGenerationSafetyProfile(name).populationRules
        .find((rule) => rule.population.includes("哺乳") && (rule.severity === "HIGH" || rule.severity === "MEDIUM"))?.severity;
      const lactationHerbs = candidateHerbNames.filter((name) => lactationSeverity(name));
      const lactationTiers = {
        prohibited: lactationHerbs.filter((name) => lactationSeverity(name) === "HIGH"),
        caution: lactationHerbs.filter((name) => lactationSeverity(name) === "MEDIUM"),
      };
      if (lactationHerbs.length > 0 && required.some((item) => item.kind === "postpartum_lactation")) {
        precautions = precautions.filter((line) => typeof line !== "string" ||
          !/(?:暂无|并无|无|没有|不含|未见)[^，,。；;]{0,8}(?:哺乳期慎用|回乳)/.test(line));
        // 模型写了含「哺乳」的一句、点了药名，但没逐味点到知识库列出的药，或把禁用的写成慎用（慎用的写成禁用）：这句换成规则那句
        //（2026-10-19 M 集 BEST4SDT-65：「方中三棱、莪术、丁香、小茴香哺乳期须慎用」，药表三棱、莪术、川楝子哺乳期禁用）。与有毒药逐味核同一做法。
        precautions = precautions.filter((line) => typeof line !== "string" || !/哺乳/u.test(line) ||
          !(lactationHerbs.some((name) => line.includes(name)) || /哺乳期(?:须|需)?(?:慎用|禁用)/u.test(line)) ||
          lactationLineMatchesTiers(line, lactationTiers));
      }
      // 抗凝、抗血小板与活血药：方中知识库标注「出血倾向/月经期/抗凝状态」慎用的药（M 集 MTCMB-7、42、62）。方中没有时这一项不补。
      const bleedingHerbs = candidateHerbNames.filter((name) => getTcmHerbGenerationSafetyProfile(name).populationRules
        .some((rule) => /抗凝/u.test(rule.population)));
      // 饮食一项也看调护里的饮食段（非剂量页的调护把饮食段与注意事项排在一起，模型已写「饮食宜清淡易消化…」时不再补一句同样的话，
      // 2026-10-19 H 集 19642、1045、4393、6953）。只用于核对，补的句子仍进注意事项。
      const current = precautions.filter((line): line is string => typeof line === "string");
      const coverageLines = [...current, ...(nonPharma && typeof nonPharma.diet === "string" && nonPharma.diet.trim() ? [nonPharma.diet] : [])];
      const pregnancyLabelledHerbs = records(records(formula?.candidates)[0]?.herbs)
        .map((herb) => String(herb.name || "").trim())
        .filter((name) => name && chpPregnancyLabel(name));
      // 方中有哺乳期禁用/慎用药时，「哺乳」一句要逐味点到、档位与药表一致才算写到（只写「如正在哺乳请告知医生」的补规则那句）。
      const lactationNamed = lactationHerbs.length === 0 || current.some((line) => /哺乳/u.test(line) && lactationLineMatchesTiers(line, lactationTiers));
      const added = required.filter((item) => item.kind !== "antithrombotic_bleeding" || bleedingHerbs.length > 0)
        .filter((item) => (item.kind === "postpartum_lactation" && !lactationNamed) ||
          !requiredPrecautionCovered(item, item.kind === "administration_and_diet" ? coverageLines : current))
        .map((item) => requiredPrecautionLine(item, herbIdentities, lactationHerbs, pregnancyLabelledHerbs,
          String(record(records(formula?.candidates)[0]?.decoction)?.method || ""), item.kind === "administration_and_diet" ? coverageLines : current,
          { lactationTiers, bleedingHerbs }))
        .filter(Boolean);
      if (added.length > 0) precautions = [...added, ...precautions];
    }
    // 方中有药典标注有毒（含「有小毒」）的药而注意事项一句没提（2026-10-18 验收主集：附子、半夏、苦杏仁）：补一句。只看最终处方。
    const toxicHerbs = records(records(formula?.candidates)[0]?.herbs)
      .map((herb) => String(herb.name || "").trim())
      .filter((name) => name && getTcmHerbGenerationSafetyProfile(name).toxicity.length > 0);
    if (toxicHerbs.length > 0) {
      const lines = precautions.filter((line): line is string => typeof line === "string");
      // 逐味核：每一味有毒的药都要在说毒性或中毒表现的那句里被点到（2026-10-19 留出例 S054：只写了「吴茱萸有小毒」，附子一字未提）。
      const unmentioned = [...new Set(toxicHerbs)].filter((name) => !lines.some((line) => line.includes(name) && TOXICITY_ADVICE.test(line)));
      if (unmentioned.length > 0) {
        // 不给剂量的页没有「医生开的剂量」：改说用不用、用多少由医生面诊后定（2026-10-19 留出集 S188 红旗页「须按医生开的剂量和煎法服用」）。
        precautions = [...precautions, options?.nonDosePage
          ? `方中${unmentioned.slice(0, 3).join("、")}在药典中标注有毒，是否使用及用量、煎法须由医生面诊后决定，不要自行配药服用；如服用后出现口唇或手足发麻、心慌、恶心呕吐，请停药并就医。`
          : `方中${unmentioned.slice(0, 3).join("、")}在药典中标注有毒，须按医生开的剂量和煎法服用，不可自行加量或久服；如出现口唇或手足发麻、心慌、恶心呕吐，请停药并就医。`];
      }
    }
    // 煎服法按教材写了「不须啜热粥」（荆防败毒散、麻黄汤一类），注意事项里「可进热粥助汗」那一小句去掉（甲方标准病历 1，
    // 2026-10-18 复评：两处说法相抵，患者无所适从）。只删劝进热粥的小句，其余照留。
    const decoctionMethod = String(record(records(formula?.candidates)[0]?.decoction)?.method || "");
    if (/不须啜(?:热)?粥|不必啜(?:热)?粥|不啜(?:热)?粥/u.test(decoctionMethod)) {
      precautions = precautions
        .map((line) => typeof line === "string" ? withoutTimingClauses(line, PORRIDGE_TO_SWEAT) : line)
        .filter((line) => typeof line !== "string" || line.trim().length > 0);
    }
    // 模型把提示词里的条目标题抄进写给患者的话（2026-10-19 本地复测病历 10「育龄女性，妊娠与哺乳情况未记录：如已怀孕…」）：去掉这类标题。
    precautions = precautions.map((line) => typeof line !== "string" ? line : line.replace(PROMPT_ITEM_HEADING, ""));
    // 写给患者的话里不留英文用法缩写（验收主集 J：模型照抄病历「倍博特1# QD」）与「1#」；不到 80 岁不称「高龄」（留出集 S190：62 岁写成高龄者）。
    const ageYears = options?.herbBoundaryAudience?.ageYears;
    precautions = precautions.map((line) => typeof line !== "string" ? line : withPatientFacingDosingWords(line, ageYears));
    // 注意事项里的药名与药味表写法不一（「鹿胶珠、龟胶珠需烊化」而药味表是鹿角胶、龟甲胶）时改成药味表的写法——
    // 与方义同一个取法（withMentionsAlignedToTableNames，2026-10-19 甲方标准病历 6 第三轮复测）。先改名，下面的煎法核对才对得上药味表。
    const tableHerbNames = records(records(formula?.candidates)[0]?.herbs).map((herb) => String(herb.name || "")).filter(Boolean);
    if (tableHerbNames.length > 0) {
      precautions = precautions.map((line) => typeof line === "string" ? withMentionsAlignedToTableNames(line, tableHerbNames).text : line);
    }
    // 注意事项里说某味药先煎/后下/包煎…，而药表与煎服法给这味药的是别的煎法或没有特殊煎法：以药表与煎服法为准，去掉那一小句
    //（2026-10-19 验收主集 RobustSDT-single_0595：注意事项「人参须先煎久煎」，药表是另煎）。
    const herbRows = records(records(formula?.candidates)[0]?.herbs);
    const decoctionLine = String(record(records(formula?.candidates)[0]?.decoction)?.method || "");
    precautions = precautions
      .map((line) => typeof line === "string" ? withoutContradictedDecoctionClaims(line, herbRows, decoctionLine) : line)
      .filter((line) => typeof line !== "string" || /[\u4e00-\u9fff]{4,}/u.test(line));
    precautions = precautions.map((line) => typeof line === "string" ? withPatientFacingWorkflowWording(line, Boolean(options?.nonDosePage)) : line);
    precautions = withoutRepeatedTopicLines(precautions);
    // 只剩「方中有木香、当归等药。」这种不带任何提示的半句（后半句被前面哪一步删掉了）：整条不留（2026-10-19 留出例 S078）。
    precautions = precautions.filter((line) => typeof line !== "string" || !isPrecautionStub(line.trim()));
    nonPharma.precautions = precautions;
  }
  // 运动保健按病历记录的行动受限写（甲方标准病历 5：拄拐的 78 岁患者写成「以散步、八段锦为主」）。
  const mobility = (options?.requiredPrecautions || []).find((item): item is Extract<RequiredPrecaution, { kind: "mobility_limited_exercise" }> =>
    item.kind === "mobility_limited_exercise");
  if (mobility && nonPharma && typeof nonPharma.exercise === "string" && nonPharma.exercise.trim()) {
    nonPharma.exercise = exerciseForMobilityLimitation(nonPharma.exercise, mobility.limitation);
  }
  for (const treatment of records(nonPharma?.tcmTreatments)) {
    for (const key of ["scheduleSuggestion", "techniqueBoundary"]) {
      // 先去掉「实际取穴由现场医师复核」「实际间隔与疗程由面诊医生…确定 / 调整」这类操作人员要求，
      // 再按出卡处同一个函数改写流程用语（此前已签名、仍在回放的结果也按同一口径）。
      if (typeof treatment[key] === "string") {
        const original = String(treatment[key]);
        // 目录原文里系统讲自己不输出什么的半句（「不输出进针方向和深度」「深刺、透刺和高风险解剖区域不由系统给出操作参数」，
        // 2026-10-18 甲方病历 3 与留出集 S086 评审判工程用语）也一并去掉。
        treatment[key] = clinicalTreatmentScheduleWording(original
          .replace(/[；;，,]?\s*实际(?:取穴|间隔与疗程)[^。；;]*?(?:复核|确定|调整)。?/g, "。")
          .replace(/[；;，,]?\s*[^。；;，,]*?(?:不输出|不由系统给出|系统不(?:给出|输出))[^。；;]*。?/g, "。")) || original;
      }
    }
    if (Array.isArray(treatment.suggestedSitesOrPoints)) {
      treatment.suggestedSitesOrPoints = treatment.suggestedSitesOrPoints.map((item) => typeof item === "string" ? item.replace(/[（(]按证型加选[）)]/g, "") : item);
    }
  }
  for (const modification of records(formula?.modifications)) {
    if (typeof modification.riskNote === "string" && /药味工作台|重新审方/.test(modification.riskNote)) modification.riskNote = "";
    // 加减理由里这味药没有的功效（2026-10-19 M 集 BEST4SDT-193 北沙参「益气养阴」、TCM-SD-448967 连翘「清热散结兼通肠腑」）：
    // 与药味功效栏同一判据（herbFunctionClaimUnsupportedPhrases），从小句头尾去掉；夹在中间去不干净的小句整句不留（只剩它时不动）。
    if (typeof modification.reason === "string" && typeof modification.herbName === "string" && modification.reason.trim()) {
      modification.reason = withoutUnsupportedReasonPhrases(modification.reason, herbFunctionKnowledgeForDisplay(modification.herbName));
    }
  }
  // 条件与所加的药都相同的加减只留一条（同一条教材加减被模型写了两遍）。条件相同、加的药不同（「加龙胆草、夏枯草」拆成两行）是
  // 一药一行的结构，不并。
  if (formula && Array.isArray(formula.modifications)) {
    const seen = new Set<string>();
    formula.modifications = records(formula.modifications).filter((item) => {
      const key = `${String(item.trigger || "").replace(/^若/u, "").replace(/[\s，,。；;：:]/gu, "")}|${String(item.action || "")}|${compositionIdentityName(String(item.herbName || "")) || String(item.herbName || "")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

/**
 * 加减理由里去掉无依据的功效说法：只从小句头尾去（「益气养阴」→「养阴」，「清热散结兼通肠腑」→「清热散结」）。讲与别的药、与病机关系的小句
 *（「助凉血止血之力」「使…」）不动；说法夹在小句中间的也不动（理由是成句的话，抠掉中间的词会成残句）。一句不剩时原样。
 */
function withoutUnsupportedReasonPhrases(reason: string, knowledge: string): string {
  const unsupported = herbFunctionClaimUnsupportedPhrases(reason, knowledge);
  if (unsupported.length === 0) return reason;
  const clauses = reason.split(/([，,；;])/u);
  const kept: string[] = [];
  for (let index = 0; index < clauses.length; index += 2) {
    const clause = clauses[index].trim();
    const separator = clauses[index + 1] || "";
    if (/^(?:助|使|配|协|以|防|制约|佐|兼顾|针对)/u.test(clause)) {
      kept.push(clause, separator);
      continue;
    }
    let rest = clause;
    for (let changed = true; changed;) {
      changed = false;
      for (const phrase of unsupported) {
        if (rest.startsWith(phrase)) { rest = rest.slice(phrase.length).replace(/^[以而并及与和兼且]+/u, ""); changed = true; }
        else if (rest.endsWith(phrase)) { rest = rest.slice(0, -phrase.length).replace(/[以而并及与和兼且]+$/u, ""); changed = true; }
      }
    }
    // 去掉之后剩下的两个字得自己是一条功效（落在功效概念组里，或是知识库原文的一段）：「温补心阳」去「温补」剩「心阳」不留。
    if (rest !== clause && (!/[\u4e00-\u9fff]{2,}/u.test(rest) ||
      (rest.length < 3 && !herbFunctionPhraseRecognized(rest) && !knowledge.includes(rest)))) continue;
    kept.push(rest, separator);
  }
  const text = kept.join("").replace(/[，,；;]+$/u, "");
  return text || reason;
}

/**
 * 「二药/两味」前面同一句里只点到一味本方药时，数量词不成立（2026-10-18 留出集 S145：「黄柏苦寒清下焦湿热，二药相合清利…共为君」，
 * 另一味已不在方中）。去掉数量词与紧跟的「相合/合用」，其余照留；点到两味及以上的不动。
 */
function withRecountedPairWords(text: string, herbNames: readonly string[]): string {
  // 数前面点名了几味本方的药：别名经 formulaAnalysisHerbMentions 认（桂心、炮附片、麦门冬、熟地），它漏掉的再按原名与组成身份名找
  //（它会把「升麻散火」里的「升麻散」当方名，漏数升麻；2026-10-18 回放：甲方病历 7「升麻…，生地黄…，二药为臣」曾被误改）。
  const own = new Set(herbNames.map((name) => compositionIdentityName(name)).filter(Boolean));
  const variants = herbNames.map((name) => ({ identity: compositionIdentityName(name), names: [...new Set([name, compositionIdentityName(name)].filter((value): value is string => Boolean(value) && value.length >= 2))] }));
  const namedCount = (value: string) => new Set([
    ...formulaAnalysisHerbMentions(value).map((mention) => compositionIdentityName(mention.token)).filter((identity) => own.has(identity)),
    ...variants.filter((variant) => variant.names.some((name) => value.includes(name))).map((variant) => variant.identity),
  ]).size;
  // 按句号分句数：「二药」常跨分号指前后两味（「盐黄柏…；苍术…，二药寒温相制」，留出例 S086）。前面只点了一味药时才去掉
  //（「黄柏…，专清下焦湿热；二药相合…」，苍术那一句已被去掉，留出例 S145）。
  return text.split(/(?<=[。！!])/u).map((sentence) => sentence.replace(/([；;，,]?)\s*[二两](?:药|味)(?:相合|合用|配伍|相配|同用)?/gu, (match, separator: string, offset: number) =>
    namedCount(sentence.slice(0, offset)) === 1 ? (separator ? "，" : "") : match)).join("");
}

/** 处方里有没有这味药的同一规格：组成身份相同，且生/熟/炙/炒等炮制写法不冲突（「去熟地黄…以生地黄」是换药，不算在方中）。 */
function presentSameForm(name: string, present: ReadonlyMap<string, readonly string[]>): boolean {
  const identity = compositionIdentityName(name);
  // 受治理目录裁定为同一味、只是不自动归一的古名（白蜜即蜂蜜）也算：「去白蜜之冲服而取蜂蜜入煎」去的就是方中的蜂蜜
  //（2026-10-19 M 集 TCM-SD-485454、BEST4SDT-193 黄芪汤）。
  const adjudicated = governedTcmHerbAdjudicatedCanonical(name);
  const forms = present.get(identity) || (adjudicated ? present.get(compositionIdentityName(adjudicated)) : undefined);
  if (!forms) return false;
  const prefix = (value: string) => value.match(/^[生熟炙炒焦煅制]/u)?.[0] || "";
  return forms.some((form) => form === name || prefix(form) === prefix(name));
}

/** 方义里点名去掉某几味药（「去桑皮之重复而留其泻肺之意」），而这几味按组成身份都在处方里：这一小句不实，去掉。 */
function withoutFalseNamedRemovalClaims(analysis: string, present: ReadonlyMap<string, readonly string[]>): string {
  return analysis.split(/(?<=。)/u).map((sentence) => {
    // 带问号的句子是模型的自问自答，由 withoutQuestionChatter 整段处理，这里不动。
    if (/[？?]/u.test(sentence)) return sentence;
    const clauses = sentence.split(/(?<=[，,；;])/u);
    const kept = clauses.flatMap((clause) => {
      const body = clause.replace(/^\s*(?:并|且|再)?/u, "");
      if (!/^(?:去|去掉|删去|减去)/u.test(body)) return [clause];
      // 换药不是删药：「去茯神易茯苓」「去鹿角胶改以鹿胶珠」「去茯神而以茯苓宁心」照留。
      if (/[易改换代]|而以/u.test(body)) return [clause];
      // 去的对象到「而/并/加/增」或小句末为止：「去原方之燥烈而增玄参」去的不是玄参。对象里「之」前是性状、之后才是药
      //（「去原方中辛温走窜之川芎减量」「去原方之甘草用量从简」，2026-10-19 M 集 BEST4SDT-118、H 集 X-H-0456：川芎、甘草都在方中）。
      const claim = body.match(/^(?:去|去掉|删去|减去)(?:原方中?|其)?([^，,。；;]{1,16}?)(?=、?(?:而|并|加|增)|[，,。；;]|$)/u);
      const named = formulaAnalysisHerbMentions(claim?.[1] || "").map((mention) => mention.token).filter(Boolean);
      if (!claim || named.length === 0 || !named.every((name) => presentSameForm(name, present))) return [clause];
      // 同一小句后半说的是加药（「去人参加柿蒂以专于降逆止呃」「…用量从简并加苍术」）：加药那半句留下。
      const rest = body.slice(claim[0].length).replace(/^[、]?(?:用量不变)?(?:而|并且|并|且)?/u, "");
      return /^(?:加|增)/u.test(rest) ? [rest] : [];
    });
    if (kept.length === clauses.length && kept.every((clause, index) => clause === clauses[index])) return sentence;
    const joined = kept.join("");
    return /[，,；;]$/u.test(joined) && /。$/u.test(sentence) ? `${joined.replace(/[，,；;]$/u, "")}。` : joined;
  }).join("");
}

/** 教材行的组成是否几张方的并集（合方行没有分方组成）：出处按组成认方时用（textbookFormulaOriginalSource）。 */
function textbookCompositionOptions(row: { formulas: readonly string[]; compositionByFormula?: readonly unknown[] }): { compositionIsUnion: boolean } {
  return { compositionIsUnion: row.formulas.length > 1 && !(row.compositionByFormula?.length) };
}

/**
 * 处方确以教材代表方中的哪几张为主体（组成过半在方中）。
 *
 * 基准有两个，取高的：教材行自带的组成（外科、妇科的合方常只列一部分，个别方没有列），与方剂目录里该方的组成。
 * 药名按组成身份比（龙胆草=龙胆、当归尾=当归、生甘草=甘草、麻子仁=火麻仁）——此前按字面比，
 * 合成集 6 例辨证阶段定了教材代表方、处方也确是那张方，方名却落成「自拟方」，两个阶段方名不一致。
 * 教材行的组成不分属哪张方：合方时它过半只说明「并集过半」，各张都算；目录能分清时按目录各算各的。
 */
function textbookFormulasCoveredByPrescription(row: { formulas: string[]; composition: string[] }, herbNames: readonly string[]): string[] {
  // 方名承载药不在处方里的方不算（与交付方名同一判据 formulaNameIdentityHerbsMissing：知柏地黄丸而方中无知母、黄柏）。
  const formulas = row.formulas.filter((name) => formulaNameIdentityHerbsMissing(name, herbNames).length === 0);
  if (formulas.length < row.formulas.length) return formulas.length > 0 ? textbookFormulasCoveredByPrescription({ ...row, formulas }, herbNames) : [];
  const present = new Set(herbNames.map((name) => compositionIdentityName(name)).filter(Boolean));
  const share = (ingredients: readonly string[]) => {
    const ids = [...new Set(ingredients.map((name) => compositionIdentityName(name.replace(/[（(][^）)]*[）)]/g, ""))).filter(Boolean))];
    return ids.length === 0 ? 0 : ids.filter((id) => present.has(id)).length / ids.length;
  };
  const byCatalog = row.formulas.filter((name) => formulaCompilationReferences([name]).some((reference) => share(reference.ingredients) >= 0.5));
  if (byCatalog.length > 0) return byCatalog;
  if (share(row.composition) < 0.5) return [];
  // 编译目录核不了、方名目录（各版本）核得了的，也要过半（M 集 test-482「化坚二陈丸加减」只剩黄连、甘草，按教材行合集算过了半，目录覆盖 0.33）。
  const catalogCovered = (name: string) => formulaCompilationReferences([name]).length > 0 || (formulaNameCatalogCoverage(name, herbNames) ?? 1) >= 0.5;
  if (row.formulas.length < 2) return row.formulas.filter(catalogCovered);
  // 合方行里有目录组成可核的方，就只认目录核不了的那几首（2026-10-19 验收集 X-G-2312：「椒目瓜蒌汤合十枣汤」处方里一味十枣汤的药都没有，
  // 整行药味过半仍把两首都算上）。核得了的方由上面的逐方核对决定。
  const uncheckedNames = row.formulas.filter((name) => formulaCompilationReferences([name]).length === 0);
  const unchecked = uncheckedNames.filter(catalogCovered);
  if (uncheckedNames.length > 0 && unchecked.length === 0) return [];
  return unchecked.length > 0 ? unchecked : [...row.formulas];
}

function withoutQuestionChatter(analysis: string): string {
  return analysis.split(/(?<=[。！!])/).map((sentence) => {
    const clauses = sentence.split(/(?<=[，,；;？?])/);
    const at = clauses.findIndex((clause) => /[？?]/.test(clause));
    if (at < 0) return sentence;
    // 问号小句及其后的同句内容（「不，川芎保留。」）都是自我更正的过程，只留问号之前的部分。
    const kept = clauses.slice(0, at).join("").replace(/[，,；;]$/, "");
    return kept ? `${kept}。` : "";
  }).join("");
}

/** 方义里「去原方中…之品」这类说删了原方药味的小句。 */
/** 注意事项里叫患者别在皮损/患处针刺的小句。 */
// 2026-10-18：「皮肤红肿灼热处不宜针刺」（留出例 S143 丹毒）——「红肿」与「处」之间可隔几个字，病灶同理。
// 2026-10-18：「皮损局部不作针刺」（甲方标准病历 8 三次生成之一）——否定词还有「不作/不做/不施」。
/** 规则注意事项提示词条目的标题式开头（有限闭集：育龄女性/备孕/服法与忌口这几项的标题）。 */
const PROMPT_ITEM_HEADING = /^(?:育龄女性[，,]?妊娠与哺乳情况(?:均)?未记录|患者备孕或未避孕|服法与忌口)[：:]\s*/u;
/** 劝进热粥助汗的小句（「可进热粥助汗」「服后喝碗热稀粥」）；「忌热粥」这类否定说法不算。 */
const PORRIDGE_TO_SWEAT = /(?<![忌勿不禁])(?:啜|喝|进|食|吃|饮)[^，,。；;]{0,4}热(?:稀)?粥/u;
const LOCAL_NEEDLING_FORBIDDEN = /(?:皮损|局部|患处|病灶|红肿[^，,。；;]{0,4}处|疱疹|皮疹)[^，,。；;]{0,6}(?:暂不|不宜|勿|避免|禁止|不可|不要|不作|不做|不施)[^，,。；;]{0,4}(?:施针|针刺|针)/u;

/** 组成身份，生用写法算同一味（生地黄 = 地黄）：与开方编译里判断加减是否重复同一口径。 */
function rawFormHerbIdentity(name: string): string {
  const trimmed = name.trim();
  return compositionIdentityName(trimmed.length >= 3 ? trimmed.replace(/^生/u, "") : trimmed);
}

/**
 * 方义开头一句（「本方以X为基础加减，去A，加B。」）里不实的加药说法：「加B」的B已在原方组成里，去掉B（都去掉时整小句不留）；
 *「以B易原方B'」两边是同一味，整小句不留。只看第一句，后面讲配伍的话不动。
 */
function withoutFalseAdditionClaims(analysis: string, catalogIds: ReadonlySet<string>): string {
  const end = analysis.indexOf("。");
  const first = end >= 0 ? analysis.slice(0, end) : analysis;
  const rest = end >= 0 ? analysis.slice(end) : "";
  // 「去石膏、加生地黄」：加药说法也会跟在顿号后面（2026-10-17 生产复测病历 9），顿号后紧跟「加」的地方同样切开。
  const clauses = first.split(/[，,；;]|、(?=(?:并|再|另)?加)/);
  const kept = clauses.flatMap((clause) => {
    const swap = clause.match(/^\s*(?:并|且)?以([^，,；;易]{2,6})易(?:原方(?:中)?)?([^，,；;并]{2,6})/u);
    if (swap && rawFormHerbIdentity(swap[1]) === rawFormHerbIdentity(swap[2])) return [];
    const addition = clause.match(/^(\s*(?:并|再|另)?(?:加用|加入|加))([^，,；;]+)$/u);
    if (!addition) return [clause];
    const names = addition[2].split(/[、和及与]/u).map((item) => item.trim()).filter(Boolean);
    const remaining = names.filter((item) => !catalogIds.has(rawFormHerbIdentity(item)));
    if (remaining.length === names.length) return [clause];
    return remaining.length > 0 ? [`${addition[1]}${remaining.join("、")}`] : [];
  });
  if (kept.length === clauses.length && kept.every((clause, index) => clause === clauses[index])) return analysis;
  return `${kept.join("，")}${rest}`;
}

// 2026-10-18：说法不止「…之品」——留出例 S076 六味地黄丸六味俱在，方义写「去原方中偏于清利的配伍重心」。
// 「配伍（重心）/部分/成分」同样是说删了原方的东西；只在原方药味逐味都在处方里时才去，查不到组成时不动。
// 「去原方之峻消」「去原方之燥烈」：去掉的是原方的某种药性（2026-10-19 H 集 X-H-0331 保和丸七味俱在），同样是说删了原方的东西。
const REMOVAL_CLAIM_ENDING = "(?:之品|之药|药味|诸药|之味|的?配伍(?:重心)?|部分|成分|之(?:峻|燥|寒|温|滋|腻)[\\u4e00-\\u9fff]{0,2})";
const REMOVAL_CLAIM_CLAUSE = new RegExp(`(?:^|[，,。；;])\\s*(?:并|且)?(?:去|删去|减去|去掉)(?:原方|其)?[^，,。；;]{0,20}${REMOVAL_CLAIM_ENDING}`, "u");
function withoutRemovalClaims(analysis: string): string {
  return analysis.split(/(?<=。)/).map((sentence) => {
    const clauses = sentence.split(/(?<=[，,；;])/);
    const kept: string[] = [];
    let dropping = false;
    for (const clause of clauses) {
      const body = clause.replace(/^\s*(?:并|且)?/u, "");
      const claim = body.match(new RegExp(`^(?:去|删去|减去|去掉)(?:原方|其)?[^，,。；;]{0,20}?${REMOVAL_CLAIM_ENDING}(?:后|而)?`, "u"));
      // 点了药名的（「去原方熟地之滋腻，以生地黄易之」）交给按药名、按炮制写法核对的 withoutFalseNamedRemovalClaims：
      // 这里按组成身份算「都在方中」，熟地黄与生地黄是同一身份，会把换药说成删药。
      if (claim && formulaAnalysisHerbMentions(claim[0]).length > 0) {
        dropping = false;
        kept.push(clause);
        continue;
      }
      if (claim) {
        // 同一小句里「去…之品后以附子、肉桂为君」：只去掉说删药的部分，后面的话留下。
        const rest = body.slice(claim[0].length);
        dropping = true;
        // 只留「以附子、肉桂为君」这种自成一句的后半；「以免过峻之弊」「以防…」这类说删药理由的残段一并不留
        //（2026-10-17 本地复测：「本方以龙胆泻肝汤为基础加减，过峻之弊，加牡丹皮…」）。
        // 后半是加药（「去原方之峻消，加芦根…」写成一小句「…之峻消而加芦根」）同样留下，去掉开头的「而/并」。
        const addition = rest.trim().replace(/^(?:而|并且|并|且)(?=(?:加|增))/u, "");
        if (/^(?:加|增)/u.test(addition)) {
          kept.push(addition);
          dropping = false;
          continue;
        }
        if (!/^(?:以|用)[^，,。；;]*为/u.test(rest.trim())) continue;
        kept.push(rest);
        dropping = false;
        continue;
      }
      if (dropping && /^(?:而)?(?:留|保留)/u.test(body)) continue;
      dropping = false;
      kept.push(clause);
    }
    const joined = kept.join("");
    // 去掉的是句末小句时，前一小句收尾的逗号换成句号。
    return /[，,；;]$/.test(joined) && /。$/.test(sentence) ? `${joined.replace(/[，,；;]$/, "")}。` : joined;
  }).join("");
}


/**
 * 饮食里自相矛盾的那一半（2026-10-18；10/17 独立评审：饮食栏写「忌鱼虾」，同页又推荐「清蒸鱼」）：
 * 注意事项与饮食栏里「忌/少食/避免/不宜…」点了名的食物，又出现在饮食栏的推荐小句或食疗卡的食谱里时，去掉推荐的那一半。
 * 依据：《中药学》「疮疡、皮肤病患者应忌食鱼、虾、蟹等腥膻发物」——忌口是辨证的结论，推荐不能与它相反。
 * 食物按点名的词比：「鱼虾蟹」拆成单字，单字只认作食物用的写法（鱼腥草、木鱼不算）。
 */
const AVOID_FOOD_CLAUSE = /(?:忌食?|禁食|少食|少吃|避免(?:食用|进食|吃)?|不宜(?:多)?(?:食用?|吃)?|勿食|戒)([^。；;，,]{1,20})/gu;
function avoidedFoods(texts: readonly string[]): string[] {
  const foods = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(AVOID_FOOD_CLAUSE)) {
      for (const part of match[1].replace(/等.*$/u, "").split(/[、和及与或]/u)) {
        const item = part.replace(/^(?:食|吃|用|进食|食用)/u, "").replace(/(?:之品|类|等|食物|饮品|食品)$/u, "").trim();
        if (/^[鱼虾蟹贝]{2,4}$/u.test(item)) for (const char of item) foods.add(char);
        else if (item.length >= 2 && item.length <= 6) {
          foods.add(item);
          // 「海鲜发物」「辛辣油腻」这类四到六字的并称：两字一段也算点了名。
          if (item.length >= 4) for (let index = 0; index + 2 <= item.length; index += 2) foods.add(item.slice(index, index + 2));
        }
      }
    }
  }
  return [...foods];
}
function mentionsFood(text: string, food: string): boolean {
  if (food.length >= 2) return text.includes(food);
  return new RegExp(`${food}(?!腥草|鳞|翅)`, "u").test(text.replace(/木鱼|鱼腥草|鱼际/gu, ""));
}
function withoutContradictingRecommendation(diet: string, foods: readonly string[]): string {
  if (foods.length === 0) return diet;
  const clauses = diet.split(/(?<=[，,；;。])/u);
  const kept = clauses.filter((clause) => /忌|禁|少食|少吃|避免|不宜|勿|戒/u.test(clause) || !foods.some((food) => mentionsFood(clause, food)));
  if (kept.length === clauses.length) return diet;
  const joined = kept.join("").replace(/[，,；;]+$/u, "");
  return joined && !/[。！？]$/u.test(joined) ? `${joined}。` : joined;
}

/** 去掉命中的小句（逗号、分号、句号分隔），其余原样；全部命中时返回空串。 */
function withoutTimingClauses(line: string, pattern: RegExp | ((clause: string) => boolean)): string {
  const matches = (text: string) => typeof pattern === "function" ? pattern(text) : pattern.test(text);
  // 删掉的小句后面紧跟「并/且/同时…」开头的小句时，连词失去了前项（「…可改为饭后服用，并告知医生」→「并告知医生」，
  // 2026-10-19 留出例 S086、验收主集 M-431898）：去掉连词，动作句前补「请」。
  const clauses = line.split(/(?<=[，,；;。])/);
  // 逐小句判，不拿整行判：判据带否定条件时（「提到方中药、且不是忌口」），整行里别的小句有「忌」就会让整行跳过——
  // 「…忌辛辣油腻；可适量吃山楂、桃仁入膳」里的桃仁一直没被去掉（2026-10-19 Claude 评审 M 集 test-375、SD-488992、MTCMB-35，四例）。
  if (!clauses.some((clause) => matches(clause))) return line;
  // 删掉的小句后面只剩它的频次（「饭后半小时服，每日2次；忌食辛辣」删去服法后剩「每日2次；忌…」，H 集 9496、15384）：频次随它一起去掉。
  const FREQUENCY_ONLY = /^(?:每日|每天|一日|日)\s*(?:\d+|[一二两三四])\s*(?:剂|次)(?:温服|服用|服)?[，,；;。]?$/u;
  const removed = clauses.map((clause) => matches(clause));
  const joined = clauses.map((clause, index) => {
    if (removed[index]) return "";
    if (index > 0 && removed[index - 1] && FREQUENCY_ONLY.test(clause.trim())) {
      removed[index] = true;
      return "";
    }
    // 指回被删小句的「煎药时请按此处理」不单独留下（M 集 TCM-SD-482280）。
    if (index > 0 && removed[index - 1] && ANAPHORIC_INSTRUCTION.test(clause.trim())) {
      removed[index] = true;
      return "";
    }
    if (index > 0 && removed[index - 1] && /^(?:并|且|同时|再)/u.test(clause)) {
      const rest = clause.replace(/^(?:并且|并|且|同时|再)/u, "");
      return /^(?:告知|告诉|及时|立即|尽快|就医|复诊|停)/u.test(rest) ? `请${rest}` : rest;
    }
    return clause;
  }).join("").replace(/[，,；;]+$/, "").trim();
  return joined && !/[。！？!?]$/.test(joined) ? `${joined}。` : joined;
}

const FINISH_MEDICINE_FIRST = /请?(?:服完|吃完|用完)本次的?药(?:后|再)?(?:按时)?复诊[^。；;]*[。；;]?/u;
/**
 * 不给剂量的病例：复诊提示不能以「服完本次的药」为节点（本次没有可服的药）。红旗先急诊或专科就诊；其余先就诊完成评估、
 * 由医生确定用药。模型写的需立即就医的表现照留。幂等：换过的句子不再含「服完本次的药」。
 */
/**
 * 这一条注意事项只是一句忌口，说的每一项饮食栏都已写到（2026-10-19 留出集 S178/S188/S190：不给剂量页把饮食栏与注意事项
 * 排在同一节「调护建议」里，模型把提示词里本例忌口那一句「饮食宜清淡、易消化，少食辛辣油腻」照抄进注意事项，同一页两句饮食）。
 * 每个小句去掉「服药期间/饮食宜/忌/少食/避免…」这层框架后，剩下的每一项（按顿号、和、及拆开；四字的按两个二字词）都要在饮食栏里出现；
 * 有一个小句说的不是饮食栏里有的（「注意保暖」「戒酒」而饮食栏没写酒），整条照留。
 */
const DIET_CLAUSE_FRAME = /^(?:服药期间|治疗期间|平时|平素)?(?:饮食)?(?:宜|应|须|需)?(?:忌食?|少食|少吃|少饮|避免(?:进食|食用)?|勿食|不宜(?:进食|食用|多食)?)?/u;
export function dietOnlyPrecautionCoveredBy(line: string, diet: string): boolean {
  if (!diet.trim() || !DIET_WORDS.test(line)) return false;
  const clauses = line.trim().replace(/[。！!]+$/u, "").split(/[，,；;]/u).map((clause) => clause.trim()).filter(Boolean);
  return clauses.length > 0 && clauses.every((clause) => {
    const items = clause.replace(DIET_CLAUSE_FRAME, "").replace(/(?:之品|食物|饮食|等)$/u, "").split(/[、和及与]/u).filter(Boolean);
    return items.length > 0 && items.every((item) => item.length >= 2 &&
      (diet.includes(item) || (item.length === 4 && diet.includes(item.slice(0, 2)) && diet.includes(item.slice(2)))));
  });
}

export function followupWhenDoseWithheld(text: string, reason: "red_flag" | "withheld"): string {
  const first = reason === "red_flag"
    ? "请先到医院急诊或专科就诊，由医生评估、排除急重情况后再定后续治疗。"
    : "请先到医院就诊，由医生完成评估并确定能否用药、怎么用药后，再按医生安排复诊。";
  if (FINISH_MEDICINE_FIRST.test(text)) return text.replace(FINISH_MEDICINE_FIRST, first);
  if (reason === "red_flag" && !/急诊|就医|就诊/u.test(text)) return `${first}${text}`;
  return text;
}

/** 就地投影一份已解析的结构化结果。非 V2 结果原样返回。 */
export function projectDeliveredReasoning<T>(reasoning: T, options?: DeliveredSurfaceOptions): T {
  const object = record(reasoning);
  if (!object || object.schemaVersion !== "tcm-cdss-reasoning-v2") return reasoning;
  const projected = structuredClone(object);
  if (projected.stage === "diagnose") {
    deliveredDiagnose(projected);
    const therapy = record(projected.therapy);
    if (therapy && typeof therapy.overallMethod === "string") therapy.overallMethod = withoutRedundantTherapyPhrases(therapy.overallMethod);
    const overviewRecord = record(projected.overview);
    if (overviewRecord && typeof overviewRecord.overallTherapy === "string") overviewRecord.overallTherapy = withoutRedundantTherapyPhrases(overviewRecord.overallTherapy);
    const management = record(projected.management);
    if (management && typeof management.followupSafetyNet === "string" && options?.doseWithheld) {
      management.followupSafetyNet = followupWhenDoseWithheld(management.followupSafetyNet, options.doseWithheld);
    }
  }
  else if (projected.stage === "prescribe") {
    deliveredPrescribe(projected, options);
    // 方义里某一步删掉连词后面那半句、留下「…化生而，…」的残句（甲方标准病历 6 最终复测）：去掉悬空的「而」。
    for (const candidate of records(record(projected.formula)?.candidates)) {
      if (typeof candidate.formulaAnalysis === "string") {
        candidate.formulaAnalysis = candidate.formulaAnalysis.replace(/(?<=[\u4e00-\u9fff])而(?=[，,；;。])/gu, "")
          // 前面几步删句后留下的「。。」（删句处的根因已在 reviewAuthoredFormulaAnalysis 修掉；这里兜住已缓存的结果与其他删句步骤）。
          .replace(/。(?:\s*。)+/gu, "。");
      }
    }
  }
  else return reasoning;
  rewordDeep(projected);
  return projected as T;
}

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

/** 对 sentinel 内的结构化结果应用交付面投影；没有变化时逐字节返回原文。 */
export function applyDeliveredSurfaceToContent(content: string, options?: DeliveredSurfaceOptions): string {
  const start = content.lastIndexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const parsed = JSON.parse(content.slice(start + START_MARKER.length, end).trim());
    const projected = projectDeliveredReasoning(parsed, options);
    if (JSON.stringify(projected) === JSON.stringify(parsed)) return content;
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(projected, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

/**
 * 开方阶段读回辨证结果时，把病历里已记录的当前表现补回西医支持事实（只在本次请求的内存里）。
 *
 * 交付面不再带症状依据，但开方阶段有三处核对要用它：随证加减的触发症状必须能回溯到「已记录的当前表现」。
 * 这些支持事实本来就是病历原句的逐字摘录，所以直接从病历的现病史取同一类内容（肯定极性的分句），
 * 不改变任何判定口径；交付前会再次清空。回传的辨证结果自带支持事实时原样不动。
 */
export function restoreDiagnoseSupportingFacts<T>(prior: T, affirmedRecordClauses: readonly string[]): T {
  const object = record(prior);
  const primary = record(record(object?.westernDiagnosis)?.primary);
  if (!object || object.stage !== "diagnose" || !primary) return prior;
  const existing = Array.isArray(primary.supportingFacts) ? primary.supportingFacts.filter((item) => typeof item === "string" && item.trim()) : [];
  if (existing.length > 0) return prior;
  const facts = [...new Set(affirmedRecordClauses.map((item) => item.trim()).filter((item) => item.length >= 2 && item.length <= 600))].slice(0, 12);
  if (facts.length === 0) return prior;
  const restored = structuredClone(object);
  (record(record(restored.westernDiagnosis)!.primary)!).supportingFacts = facts;
  return restored as T;
}
