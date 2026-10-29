import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { compileHomeAcupointCare } from "./home-acupoint-care.server";
import { renderAuthoredHomeAcupointCare, type AuthoredHomeAcupoint, type HomeAcupointAuthoringInput } from "./home-acupoint-authoring.server";
import { acupointPregnancySensitive, resolveAcupoint } from "./tcm-acupoints";
import {
  TCM_TREATMENT_PROJECTS,
  getTcmTreatmentProjectDefinition,
  governedTcmTreatmentPlanTemplateForTags,
  governedTcmTreatmentSyndromeRefinement,
  highestTcmSourceAuthorityTier,
  isKnownTcmTreatmentProjectCode,
  parseTcmTreatmentCapabilities,
  tcmRefinementAdjudication,
  tcmTreatmentPointProvenance,
  tcmTreatmentTemplatePointsAreGoverned,
  tcmTreatmentProjectIsPointFree,
  governedTcmTreatmentPrecisePlanTemplate,
  governedTcmTreatmentConditionalPoints,
  type TcmTreatmentPlanTemplate,
  type TcmTreatmentProjectCode,
  type TcmTreatmentIndicationTag,
} from "./tcm-treatment-projects";
import { affirmedClinicalText } from "./clinical-polarity";
import { canonicalTcmHerbIdentity } from "./diagnosis-stage-contract";
import { assessPregnancyState, conceptionWithoutPregnancyOrLactation } from "./clinical-state";
import { pediatricDoseRuleForAgeYears, pediatricDoseRuleForStageWords } from "./pediatric-dose-rule";
import { narrativePediatricAgeConflict, pregnancyAdviceRelevant, pregnancyScreenRequired, reproductiveAdviceRelevant, unevaluatedBreastMass } from "./diagnosis-safety";
import { cardApplicabilityExcludesSyndrome, cardSentencesMatchedToSyndrome, caseCourse, dietAdviceAvoidsRichFood, facialSoreRecorded, dietAdviceAvoidsTea, syndromeHasHeatNature, cardSentencesNamingListedPoints, cardTextForPopulation, manipulationMatchedToSyndrome, moxibustionUnsuitableForSyndrome, signedSyndromeDeficiencyExcess, syndromeLabelFitsSigned, textbookPlanExistsForDisease, textbookSectionNames, textbookTreatmentPlan, type TextbookPlan, type TextbookPlanInput } from "./tcm-nondrug-textbook-plan.server";
import governanceSourceRegistryJson from "../data/clinical-governance-source-registry.json" with { type: "json" };
import { clinicalTreatmentScheduleWording } from "./treatment-schedule-wording";

type DeliveryMode = "onsite" | "referral";
type DeploymentCapability = {
  projectCode: TcmTreatmentProjectCode;
  deliveryMode: DeliveryMode;
  priority: number;
  specialistApproved: boolean;
};

type CapabilityScope = {
  mode: "configured" | "not_configured";
  valid: boolean;
  reason?: string;
  items: DeploymentCapability[];
};

type ModelTreatmentProposal = { projectCode: TcmTreatmentProjectCode; targetRef: string };
type BaseTreatmentRecommendation = NonNullable<ClinicalReasoningResultV2["nonPharma"]>["tcmTreatments"][number];
type TreatmentRecommendation = BaseTreatmentRecommendation & {
  containsMedication: boolean;
  requiresMedicationAudit: boolean;
};

type TreatmentCandidate = ModelTreatmentProposal & { score: number; explicit: boolean };
type TreatmentCaseContext = Pick<CaseState,
  "clinicTreatmentCapabilities" | "clinicTreatmentCapabilitiesRestricted" | "safetyGate" |
  "patient" | "hisRecord" | "chiefComplaint" | "symptoms" | "pastHistory" | "medicationHistory" |
  "allergyHistory" | "conversation" | "vitals"
>;

// This classifier prefers signed positive diagnosis/pathogenesis fields. When both a node and the
// signed global summary use clinically neutral wording, it may fall back to affirmed *current*
// complaint/present-illness facts. Historical, medication and allergy fields remain excluded so a
// past condition or a negated differential cannot manufacture an indication. The catalog tag is the
// eligibility boundary; the score only determines which eligible non-executable assessment cards are
// shown first.
const INDICATION_PATTERNS: ReadonlyArray<readonly [TcmTreatmentIndicationTag, RegExp]> = [
  ["anorectal", /痔|肛瘘|肛裂|肛周|脱肛|直肠脱垂/],
  ["neurologic_rehabilitation", /中风后|卒中后|脑梗死恢复|脑出血恢复|偏瘫|肢体功能障碍|神经康复|运动功能恢复/],
  ["dizziness_balance", /眩晕|头晕|天旋地转|屋子.{0,4}(?:转|旋转)|平衡失司|平衡功能|良性阵发性位置性眩晕|BPPV/i],
  ["movement_disorder", /帕金森|颤证|震颤|静止性震颤|手抖|小写症|动作迟缓|运动调节功能|精细动作控制/],
  ["gynecology", /痛经|月经|经期|经量|闭经|崩漏|带下|胞宫|不孕|围绝经|产后/],
  ["dermatology", /湿疹|湿疮|皮炎|皮损|瘙痒|荨麻疹|银屑|痤疮|皮肤/],
  ["headache", /头痛|偏头痛|头胀|头部疼痛/],
  ["sleep_emotion", /不寐|失眠|入睡困难|易醒|多梦|焦虑|抑郁|情志|心神|烦躁/],
  ["upper_airway", /鼻鼽|鼻渊|变应性鼻炎|过敏性鼻炎|非变应性鼻炎|鼻塞|鼻痒|喷嚏|清涕|流涕|鼻窍/],
  // 感冒/流感必须在词表里：针刺目录的 acupuncture-influenza-hunan-2025 模板 matchAny 是
  // 「流感/流行性感冒」，而本词表 respiratory 此前只收咳喘类词——于是一例「流行性感冒 风寒束表、
  // 恶寒重发热轻、流清涕」只命中 upper_airway（来自「清涕」），upper_airway 没有针刺模板，
  // 整例落回评估态，流感模板永远够不着。这正是本文件 :146 注释里写过的「两张表各自漂移」。
  ["respiratory", /感冒|流感|流行性感冒|咳嗽|咳痰|气喘|哮喘|喘鸣|呼呼响|憋醒|活动后喘|上楼喘|劳力性气短|肺气|肺失|支气管|呼吸|胸闷气短/],
  ["digestive", /痞满|胃脘|脘腹|脘胀|上腹(?:部)?胀|饭后(?:不适|胀|饱胀)|餐后不适|早饱|嗳气|打嗝|胃气|胃失(?:和降|通降)|腹胀|腹痛|腹泻|泄泻|便秘|纳差|反酸|烧心|呕吐|恶心|胃肠|脾胃|消化/],
  ["musculoskeletal_pain", /颈肩|颈项|颈部|颈椎|颈肌|脖子|腰腿|腰痛|膝痛|关节|骨关节|肌筋膜|经筋|筋骨|痹阻|痹证|活动受限|疼痛/],
  ["metabolic_rehabilitation", /肥胖|超重|糖尿病|血糖|血脂|代谢|体重|脂肪肝/],
];

const PROJECT_TAG_AFFINITY: Readonly<Partial<Record<TcmTreatmentProjectCode, Partial<Record<TcmTreatmentIndicationTag, number>>>>> = {
  acupuncture: { digestive: 70, respiratory: 75, upper_airway: 100, musculoskeletal_pain: 95, neurologic_rehabilitation: 100, dizziness_balance: 100, movement_disorder: 90, gynecology: 85, dermatology: 55, headache: 90, sleep_emotion: 75, metabolic_rehabilitation: 65 },
  moxibustion: { digestive: 80, respiratory: 90, upper_airway: 90, musculoskeletal_pain: 75, gynecology: 100, sleep_emotion: 70, metabolic_rehabilitation: 70 },
  tuina: { digestive: 60, respiratory: 55, musculoskeletal_pain: 100, neurologic_rehabilitation: 90, metabolic_rehabilitation: 55 },
  cupping: { respiratory: 85, musculoskeletal_pain: 90 },
  guasha: { respiratory: 70, musculoskeletal_pain: 85, dermatology: 45 },
  needle_knife: { musculoskeletal_pain: 88 },
  acupoint_application: { digestive: 75, respiratory: 95, upper_airway: 92, musculoskeletal_pain: 70, gynecology: 75 },
  medicated_plaster: { musculoskeletal_pain: 92 },
  fumigation_wash: { musculoskeletal_pain: 80, gynecology: 80, dermatology: 95, anorectal: 80 },
  medicated_bath: { musculoskeletal_pain: 75, dermatology: 100 },
  auricular: { digestive: 90, upper_airway: 85, musculoskeletal_pain: 65, dizziness_balance: 95, gynecology: 90, headache: 100, sleep_emotion: 95, metabolic_rehabilitation: 90 },
  thread_embedding: { respiratory: 75, musculoskeletal_pain: 75, gynecology: 75, metabolic_rehabilitation: 85 },
  medicated_ironing: { digestive: 70, musculoskeletal_pain: 80, gynecology: 70 },
  bloodletting: { musculoskeletal_pain: 65, dermatology: 65 },
  fire_cautery: { dermatology: 70, anorectal: 70 },
  hook_cutting: { musculoskeletal_pain: 70 },
  thread_drainage: { anorectal: 100 },
  ligation: { anorectal: 95 },
  diet_therapy: { digestive: 100, respiratory: 65, gynecology: 70, dermatology: 70, sleep_emotion: 80, metabolic_rehabilitation: 100 },
  mind_therapy: { sleep_emotion: 100 },
  qigong_daoyin: { respiratory: 100, musculoskeletal_pain: 80, neurologic_rehabilitation: 95, movement_disorder: 100, sleep_emotion: 90, metabolic_rehabilitation: 95 },
};

// INDICATION_LABEL（适应证标签 → 症状域显示名）已删除：它唯一的运行时用途就是被治理分支
// 拿来当作「本例围绕什么」印给医生，而标签的匹配面宽于显示名——「头胀」因此被写成「头痛症状」、
// 「产后」被写成「经带与下腹症状」（甲方 2026-08-04 / 2026-08-10 ⑪ 两轮同一条）。
// 现在两个分支一律只引用 indicationEvidenceTerms（病历原文落点）或模板 matchAny 命中的原词。

/**
 * 用 T12 穴位目录（《经络腧穴学》399 穴：361 经穴 + 印堂 + 37 奇穴）标注模板穴位。
 *
 * 目录建好后一直只被测试脚本 import——医生看到的仍是模板里的裸穴名字符串，
 * 400 穴的定位/归经/国标代码一条都没到达界面。这里内联标注经络与代码：
 *   「神门」→「神门（HT7·手少阴心经）」
 * 用现有 string[] 契约，不改类型、不改 UI；**核验不到的穴名保持原样**，
 * 于是「哪些是受控穴位、哪些只是模板里的自由文本」在界面上一眼可分——
 * 这比统一加个好看的标签更有用，也不会把未核验项伪装成已核验。
 * executable=false 的项目边界不变：这里只补证据标注，不产生可执行指令。
 */
/**
 * T12 穴位目录收的是**经络腧穴**（361 经穴 + 印堂 + 37 奇穴）。耳穴自成一套定位体系，
 * 「神门」「心」「枕」在两套体系里是完全不同的部位——给耳穴的神门标上「HT7·手少阴心经」
 * 不是补充证据，而是把一个未核验的点伪装成已核验，且核错了体位
 * （生产实测 fixa-d1/d1b：耳穴方案里出现「神门（HT7·手少阴心经）」）。
 * 只对经穴体系的项目做标注；耳穴保持裸名，与"核验不到即保持原样"的既有约定一致。
 */
/**
 * 本项目在本例上可成立的适应证，按**与本例的相关度**排序。
 * 排序只用于在同一个项目内部挑一个适应证；目录里的 indicationTags 仍是资格边界。
 */
/**
 * 受治理适应证词表判定：这段文字属于哪些适应证标签。
 *
 * **导出供回归钉住词表一致性**：治疗项目的 planTemplates 各自带一份 matchAny 匹配词，
 * 与本词表编码的是同一个判断。两张表会各自漂移——2026-08-06 修的就是漂移的一半：
 * 本词表 sleep_emotion 收了「入睡困难/多梦/易醒」，针刺模板的 matchAny 却只有「失眠/不寐」，
 * 医生按常见写法录入时选穴整栏消失。test:tcm-treatments 现在逐词核对两表是否仍然同向。
 */
export function governedIndicationTagsForText(text: string): TcmTreatmentIndicationTag[] {
  const normalized = String(text || "").normalize("NFKC");
  return INDICATION_PATTERNS.filter(([, pattern]) => pattern.test(normalized)).map(([tag]) => tag);
}

function orderedIndicationTags(
  projectCode: TcmTreatmentProjectCode,
  tags: ReadonlySet<TcmTreatmentIndicationTag>,
): TcmTreatmentIndicationTag[] {
  const definition = getTcmTreatmentProjectDefinition(projectCode);
  if (!definition) return [];
  return [...tags]
    .filter((tag) => definition.indicationTags.includes(tag))
    .sort((left, right) =>
      (PROJECT_TAG_AFFINITY[projectCode]?.[right] || 0) - (PROJECT_TAG_AFFINITY[projectCode]?.[left] || 0) ||
      left.localeCompare(right));
}

/**
 * **一次**解析出本项目卡片使用的适应证与治理模板，卡片上的适应证标注、穴位、频次、疗程
 * 全部取自这一次解析的结果。
 *
 * 此前是三套各自独立的判据：入选打分取"该项目最擅长的那个适应证"、卡片标注取同一口径再算一遍、
 * 穴位却由 `planTemplates.find(...)` 按**目录排列顺序**决定。三者可以两两不一致，生产实测两种
 * 表现形式：
 *   · 标注"围绕头痛症状"、穴位却是失眠方的安眠/神门/内关/心俞（fixa-d1b）；
 *   · 产后头痛病例的灸法标注"经带与下腹症状"——该适应证来自主诉里的"产后"二字，
 *     而本例并无经带或下腹症状，标注却把它写成了患者的症状（fixa-d1）。
 * 解析一次之后，"卡片说的适应证"与"卡片给的方案"在结构上不可能再分叉。
 */
function resolveTreatmentIndication(
  projectCode: TcmTreatmentProjectCode,
  tags: ReadonlySet<TcmTreatmentIndicationTag>,
  clinicalText: string,
): { tag?: TcmTreatmentIndicationTag; template?: TcmTreatmentPlanTemplate } {
  const ordered = orderedIndicationTags(projectCode, tags);
  const template = governedTcmTreatmentPlanTemplateForTags(projectCode, clinicalText, ordered);
  return { tag: template ? template.indicationTag : ordered[0], template };
}

/**
 * 该适应证在**本例病历原文**里的落点。评估态卡片只能引用这些落点，不能改口成
 * 适应证标签的症状域显示名——显示名覆盖面窄于标签本身的匹配面，
 * 于是"产后"匹配上 gynecology 之后被显示成"经带与下腹症状"，写出了病历里没有的症状。
 */
export function indicationEvidenceTerms(tag: TcmTreatmentIndicationTag, caseFacts: string): string[] {
  const pattern = INDICATION_PATTERNS.find(([candidate]) => candidate === tag)?.[1];
  if (!pattern || !caseFacts) return [];
  const scan = new RegExp(pattern.source, `${pattern.flags.replace(/g/g, "")}g`);
  // 只是部位的词（颈部、关节）要和不适写在同一小句里才算本例的表现（2026-10-19，验收集 M-TCM-SD-433630/439348：
  // 查体模板「颈部对称，无青筋暴露」「右膝及踝关节X线示…」被写成「针对本例颈部」「针对本例关节、颈部」）。
  // 卡上写部位连同那一小句的不适（「胃脘不舒服」「胃脘胀满」），不单写部位（2026-10-19 第五轮留出例 S077「针对本例胃脘」、S158「腹胀、胃脘」）；
  //「消化」只在「消化不良」里算症状（S054「不消化的食物」被写成「针对本例…消化」）。
  const clauses = caseFacts.split(/[，,。；;\n]/);
  const terms: string[] = [];
  for (const match of caseFacts.matchAll(scan)) {
    const term = match[0];
    if (!term) continue;
    let shown: string | undefined = term;
    if (term === "消化") {
      shown = clauses.some((clause) => clause.includes("消化不良")) ? "消化不良" : undefined;
    } else if (/^(?:胃肠|脾胃)$/u.test(term)) {
      // 脏腑名不是本例的表现（「针对本例胃肠、脾胃」）。
      shown = undefined;
    } else if (BODY_PART_ONLY_TERMS.test(term)) {
      const clause = clauses.find((item) => item.includes(term) && BODY_COMPLAINT_WORDS.test(item.replace(term, "")));
      const complaint = clause ? (clause.slice(clause.indexOf(term) + term.length).match(BODY_COMPLAINT_PHRASE) || clause.match(BODY_COMPLAINT_PHRASE))?.[0] : undefined;
      shown = clause ? `${term}${complaint || ""}` : undefined;
    }
    if (shown && !terms.includes(shown)) terms.push(shown);
  }
  return terms.slice(0, 3);
}
/** 适应证词里只是部位、本身不说不适的词（闭集，取自 INDICATION_PATTERNS 的骨骼肌肉项与胃肠项）。 */
const BODY_PART_ONLY_TERMS = /^(?:颈肩|颈项|颈部|颈椎|颈肌|脖子|关节|骨关节|肌筋膜|经筋|筋骨|胃脘|脘腹)$/;
/** 部位所在小句里说不适的字（痛、酸、麻、僵、肿、活动受限、屈伸不利、不适…）。 */
const BODY_COMPLAINT_WORDS = /痛|酸|麻|僵|肿|胀|受限|不利|屈伸|无力|活动障碍|弹响|畸形|不适|不舒服|痞|满|嘈杂|灼热|发凉/;
/** 卡上与部位连写的那一段不适（取部位之后最先出现的一段）。 */
const BODY_COMPLAINT_PHRASE = /隐痛|胀痛|刺痛|灼痛|冷痛|疼痛|作痛|胀满|胀闷|痞满|痞闷|不适|不舒服|嘈杂|灼热|发凉|酸痛|酸胀|麻木|僵硬|肿胀|无力|活动受限|屈伸不利|胀|痛|痞|满/;

/**
 * 穴位标注「主治含X」用的本例症状词。穴位是按主治匹配选出来的，匹配依据必须是本例病历**当前**真实记录、且是本例症状的那个词
 *（2026-10-19 Claude 评审，此前从模型写的病机叙述与全部病历里扫词）：
 *  · 只读病历当前阳性面，不读模型叙述——「瘀久化热，故局部发热」让臂丛损伤的合谷标「主治含发热」（H-tri-1622）；
 *  · 词前紧挨否认（「发病后无发热」，H-tri-10322）、是「喜热恶寒」这类喜恶偏好（H-tri-10720，腹痛喜温，不是表证恶寒）、
 *    或只是另一症状的诱因（「受凉、咳嗽、伸腿疼痛加重」，H-tri-1476）的不算。三条都是构词式守卫：否认词与诱因句式为闭集。
 */
const SYMPTOM_SCAN = /(?:恶寒|发热|头痛|头晕|眩晕|鼻塞|流涕|喷嚏|咽痛|咳嗽|气喘|胸痛|胸闷|心悸|失眠|健忘|多梦|自汗|盗汗|无汗|口渴|纳呆|食少|腹胀|腹痛|泄泻|便秘|呕吐|恶心|呃逆|水肿|尿频|尿急|癃闭|带下|痛经|月经不调|腰痛|膝痛|肩痛|颈痛|痹痛|麻木|抽搐|瘾疹|湿疹|瘙痒|目赤|耳鸣|耳聋|牙痛|口疮)/g;
export function acupointCaseTerms(currentFacts: string, signedDiseaseNames: readonly string[] = []): string[] {
  // 已签名的病名本身（腰痛、眩晕、耳鸣…）是结论，不是叙述，照算。
  const terms = new Set<string>(signedDiseaseNames.flatMap((name) => [...String(name || "").matchAll(SYMPTOM_SCAN)].map((match) => match[0])));
  for (const clause of String(currentFacts || "").split(/[，,。；;\n]/u)) {
    for (const match of clause.matchAll(SYMPTOM_SCAN)) {
      const before = clause.slice(0, match.index);
      const after = clause.slice((match.index ?? 0) + match[0].length);
      if (/(?:无|未|没有|没|否认|不伴|不)[^、]{0,2}$/u.test(before)) continue;
      if (/喜[\u4e00-\u9fff]{1,2}$/u.test(before)) continue;
      if (/^[、和及]?[^。；;，,]{0,10}?(?:痛|酸|麻|胀)[^。；;，,]{0,3}(?:加重|加剧|更甚|明显)/u.test(after)) continue;
      // 「咳嗽或大笑时有漏尿」「咳嗽时胸痛」：症状词后面紧跟（可带并列的另一诱因）「时」，说的是另一件事发生的情形（2026-10-19 第五轮留出例 S114
      // 太溪标「主治含咳嗽」）。
      if (/^(?:[、和及或][^。；;，,]{0,6})?时/u.test(after)) continue;
      terms.add(match[0]);
    }
  }
  return [...terms];
}

/**
 * 治理模板穴位的**逐穴触发事实绑定**（甲方 2026-08-10 ⑪）。
 *
 * 评估分支早就在做这件事（「合谷（LI4·主治含恶寒、发热）」），治理分支却只印裸穴名，
 * 于是医生看得到「标准方案」四个字、看不到「凭什么是这几个穴」。同一判据只铺了一处。
 * 核验不到的穴名保持原样——「哪些是受控穴位」在界面上仍然一眼可分。
 */
function annotateGovernedTemplatePoint(
  projectCode: TcmTreatmentProjectCode,
  site: string,
  caseTerms: readonly string[],
  syndromeLabel?: string,
  /** 条件加穴的触发说明，逐字进标注（「鼻塞流清涕或头项症状时加用」）。给了它就不再拼「…加减」。 */
  triggerNote?: string,
): string {
  // 模板穴名本身可能已带括注（「太阳或率谷（按疼痛部位复核）」）。标注必须**并入同一个括号**，
  // 否则会印成「太阳或率谷（按疼痛部位复核）（EX-HN5·…）」两组括号。
  const existingNote = site.match(/（([^）]*)）\s*$/)?.[1] || "";
  const bareSite = existingNote ? site.slice(0, site.lastIndexOf("（")) : site;
  const wrap = (parts: readonly string[]) => {
    const inner = [existingNote, ...parts].filter(Boolean).join("；");
    return inner ? `${bareSite}（${inner}）` : bareSite;
  };
  const bareNote = triggerNote || (syndromeLabel ? `${syndromeLabel}加减` : "");
  if (projectCode === "auricular") return wrap(bareNote ? [bareNote] : []);
  const entry = resolveAcupoint(site);
  if (!entry) return wrap(bareNote ? [bareNote] : []);
  const meridian = entry.meridian && entry.meridian !== entry.name ? `·${entry.meridian}` : "";
  const indicationText = (entry.indications || []).join("；");
  const matchedTerms = caseTerms.filter((term) => indicationText.includes(term)).slice(0, 3);
  const trigger = triggerNote
    ? `·${triggerNote}`
    : syndromeLabel
      ? `·${syndromeLabel}加减`
      : matchedTerms.length > 0 ? `·主治含${matchedTerms.join("、")}` : "";
  return wrap([`${entry.code}${meridian}${trigger}`]);
}

/**
 * 目录模板操作栏写的「先排除A、B…」与已签名诊断（中医病名、西医主诊断）对照：诊断就是要先排除的那一类时，模板不适用本例。
 * 类别与诊断用字为闭集：骨折；感染（结核、化脓、脓肿、蜂窝织炎、骨髓炎、感染）；肿瘤、占位（癌、瘤、占位）。
 */
const EXCLUDE_FIRST_CATEGORIES: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/骨折/u, /骨折/u],
  [/感染/u, /结核|化脓|脓肿|蜂窝织炎|骨髓炎|感染/u],
  [/肿瘤|占位/u, /肿瘤|癌|瘤|占位/u],
];
export function templateExcludesSignedDiagnosis(techniqueBoundary: string, diagnosisNames: string): boolean {
  const items = String(techniqueBoundary || "").match(/先排除([^。；;]+)/u)?.[1];
  if (!items || !diagnosisNames.trim()) return false;
  return EXCLUDE_FIRST_CATEGORIES.some(([item, diagnosis]) => item.test(items) && diagnosis.test(diagnosisNames));
}

/** 受治理来源 ID → 卡片上的来源名（来源登记表的题名；题名不带书名号时写「发布者《题名》」）。查不到的 ID 原样保留。 */
const GOVERNED_SOURCE_BY_ID = new Map(
  ((governanceSourceRegistryJson as { entries?: Array<{ id?: string; title?: string; publisher?: string }> }).entries || [])
    .filter((entry) => entry.id && entry.title)
    .map((entry) => [entry.id!, entry] as const),
);
function governedSourceLabels(sourceIds: readonly string[]): string {
  return [...new Set(sourceIds.map((id) => {
    const entry = GOVERNED_SOURCE_BY_ID.get(id);
    if (!entry?.title) return id;
    return /《/.test(entry.title) ? entry.title : `${entry.publisher ? entry.publisher : ""}《${entry.title}》`;
  }))].join("、");
}

function controlledTreatmentPlan(
  projectCode: TcmTreatmentProjectCode,
  tags: ReadonlySet<TcmTreatmentIndicationTag>,
  targetPathogenesis: string,
  clinicalText: string,
  caseFacts: string,
  /** 已签名的证候/病机/治法文本。证型加减只看它，不看病历原文——见 syndromeRefinements 注释。 */
  signedSyndromeText: string,
  /**
   * 本例**当前**事实（主诉/现病史/四诊，已阳性化，**不含既往史**）。
   * 精确证型闸门与条件加穴都只读它：既往咳嗽不构成本次取穴的理由，「否认咳嗽」更不构成。
   */
  currentFacts = "",
  /**
   * 已签名证候的**结论性**文本（主证候名）。与上面那个 signedSyndromeText 是**两个不同的东西**：
   * 那个是给证型加减用的全量叙述（含病机链、辨证依据、治法方向），
   * 这个只给精确闸门用。2026-08-11 对抗性复核实测：把全量叙述喂进闸门，
   * 「本证与风寒袭肺证鉴别要点在于…」与「初起风寒袭肺，日久痰湿蕴肺」都会把它骗开。
   */
  signedSyndromeConclusion = "",
  /** 本例年龄（岁）。带年龄下限的模板取不到年龄一律不启用。 */
  patientAgeYears?: number,
  /** 教材方案（tcm-nondrug-textbook-plan.server.ts）的取材：已签名病名、西医主诊断、主证+兼证结论。 */
  textbookContext?: { diseaseNames: readonly string[]; westernNames: readonly string[]; signedSyndromeText: string; signedPrinciple?: string; signedMethod?: string; chiefComplaint?: string; avoidRichFood?: boolean; herbAlreadyPrescribed?: (herb: string) => boolean; prescribedHerbNames?: readonly string[]; signedRationale?: string; recordedDiabetes?: boolean; avoidTea?: boolean },
): Pick<TreatmentRecommendation,
  "treatmentContent" | "suggestedSitesOrPoints" | "scheduleSuggestion" | "techniqueBoundary" |
  "protocolSource" | "protocolStatus" | "protocolGap" | "tailoringStatus" |
  "pointProvenance" | "sourceAuthorityTier" | "adjudicationStatus" | "deferredSyndromeRefinement" |
  "deferredGovernedTemplate"
> & {
  /** 方案取自教材本病节（按本病、本例证候，不按某个病机节点）：卡片的对应病机落在 P1。仅供汇总处使用，不进载荷。 */
  planOrigin?: "textbook";
} {
  const definition = getTcmTreatmentProjectDefinition(projectCode);
  const textbookInput: TextbookPlanInput | undefined = textbookContext
    ? {
        projectCode,
        diseaseNames: textbookContext.diseaseNames,
        westernNames: textbookContext.westernNames,
        signedSyndromeText: textbookContext.signedSyndromeText,
        currentFacts,
        signedNarrative: signedSyndromeText,
        signedRationale: textbookContext.signedRationale,
        patientAgeYears,
        signedPrinciple: textbookContext.signedPrinciple,
        signedMethod: textbookContext.signedMethod,
        chiefComplaint: textbookContext.chiefComplaint,
        avoidRichFood: textbookContext.avoidRichFood,
        recordedDiabetes: textbookContext.recordedDiabetes,
        avoidTea: textbookContext.avoidTea,
        herbAlreadyPrescribed: textbookContext.herbAlreadyPrescribed,
        prescribedHerbNames: textbookContext.prescribedHerbNames,
      }
    : undefined;
  const textbookPlan = textbookInput ? textbookTreatmentPlan(textbookInput) : undefined;
  // ── 精确证型模板优先（中医师 2026-08-11 裁定的落库方式）────────────────────────
  //
  // 裁定明确**不许**调整全局 upper_airway / respiratory 优先级：那会影响所有病例。
  // 改为在通用标签排序**之前**先试一道前置闸门，且闸门只对声明了 preciseSyndromeGate 的模板生效
  //（目前只有针刺的普通风寒咳嗽一条；构建期门禁钉住「只有针刺项目可以声明」）。
  //
  // 闸门要两把钥匙同时对上：当前咳嗽事实 + 已签名的风寒袭肺/风寒束肺；
  // 并显式排除流感、恢复期、风热——绝不把既有专项方案的适应证扩大过去。
  // 「流清涕」在这里只是**条件加穴**的触发词，不改变整例走哪条模板。
  const precise = governedTcmTreatmentPrecisePlanTemplate(
    projectCode,
    currentFacts,
    signedSyndromeConclusion,
    patientAgeYears,
  );

  /** 教材方案 → 卡片字段（tcm-nondrug-textbook-plan.server.ts）。证型相符 = 已按本例证型选穴/选方；配穴出自十三五规划教材，并经联网权威来源核对（2026-09-29）。 */
  const fromTextbook = (plan: TextbookPlan) => {
    const caseTerms = acupointCaseTerms(currentFacts, [...(textbookContext?.diseaseNames || []), ...(textbookContext?.westernNames || [])]);
    const bodySystem = projectCode !== "auricular";
    const points = plan.kind === "acupoint"
      ? plan.points.map((point) => (bodySystem
        ? annotateGovernedTemplatePoint(
            projectCode, point.name, caseTerms,
            point.role === "syndrome_refinement" ? point.syndromeLabel : undefined,
            point.role === "conditional_point" ? point.note : undefined,
          )
        : point.name))
      : [];
    const provenance = plan.kind === "acupoint"
      ? plan.points.map((point) => ({
          point: point.name,
          role: point.role,
          sourceRefs: plan.sourceRefs,
          authorityTier: "project_governed_source",
          // 教材原句 + 联网权威来源核对（~/runlogs/eval924/research、tcm-nondrug-web-sources.source.json）即为依据；
          // 无中医师可签字，不再把教材配穴挂成「待终审」（2026-09-29 owner 决定）。
          adjudicationStatus: "approved" as const,
          conflictNote: null,
        }))
      : [];
    return {
      treatmentContent: plan.treatmentContent,
      suggestedSitesOrPoints: points,
      scheduleSuggestion: plan.scheduleSuggestion,
      techniqueBoundary: plan.techniqueBoundary,
      protocolSource: plan.protocolSource,
      pointProvenance: provenance,
      sourceAuthorityTier: "project_governed_source",
      protocolStatus: plan.syndromeTailored
        ? "governed_patient_specific_plan" as const
        : "governed_class_template_not_syndrome_tailored" as const,
      tailoringStatus: plan.syndromeTailored ? "syndrome_tailored" as const : "class_template_only" as const,
      protocolGap: plan.syndromeTailored ? undefined : "syndrome_refinement_not_matched",
      ...(plan.syndromeTailored && plan.kind === "acupoint" ? { adjudicationStatus: "pending_clinician_review" as const } : {}),
      planOrigin: "textbook" as const,
    };
  };
  const { tag, template: taggedTemplate } = resolveTreatmentIndication(projectCode, tags, clinicalText);
  // 闸门只在**本节点自己的适应证**里生效。此前它无条件压过按病机节点解析出的模板，
  // 于是「咳嗽 + 颈项痹阻」两节点的病例里，打在颈痛节点上的针刺卡发出的是肺系取穴——
  // 卡片说的病机与卡片给的方案又分叉了，正是 test:treatment-indication 那一整类。
  const preciseFitsNode = Boolean(precise.template && tags.has(precise.template.indicationTag));
  const governedTemplate = (preciseFitsNode ? precise.template : undefined) || taggedTemplate;
  // 命中了精确模板但**还没签字**：模板整条不启用，本例照常走原有路径（多为评估态）——
  // 中医师原话「签字前保持评估态是正确的」。但不静默：把待签字的那条如实挂出来。
  const deferredGovernedTemplate = precise.deferred
    ? {
      deferredGovernedTemplate: {
        templateId: precise.deferred.template.id,
        indicationLabel: precise.deferred.template.preciseSyndromeGate!.indicationLabel,
        deferredPoints: [
          ...precise.deferred.template.sitesOrPoints,
          ...governedTcmTreatmentConditionalPoints(precise.deferred.template, currentFacts)
            .map((item) => item.point),
        ],
        conflictNote: precise.deferred.adjudication.conflictNote
          || "该病种标准取穴尚未完成中医师签字终审，本轮不作为患者级方案，仅供医生知悉。",
      },
    }
    : {};
  if (governedTemplate) {
    // 甲方评测(2026-08-04) 9.1：只有目录声明**已治理**的取穴才进「候选穴位」栏。
    // 目录里有三条模板把「点哪儿由别处/查体决定」写进了 sitesOrPoints，那是延期说明不是穴位
    // （见 tcmTreatmentTemplatePointsAreGoverned）。它照常呈现，但归到操作边界一行，
    // 不再冒充穴位——医生看到的「常用穴位」必须是穴位。
    const pointsGoverned = tcmTreatmentTemplatePointsAreGoverned(governedTemplate);
    // caseFacts 是**已确认的阳性**病历事实（affirmedClinicalText 的产物），
    // 因此「否认恶寒」不会把风寒袭肺的证据门槛顶开——这一点与全仓的极性口径同源。
    // 证型配穴先按已签名的证候结论（主证＋兼证）命中；按病机叙述（总病机、各节点病机、辨证依据、治法方向）才命中的，配穴证名须与证候结论相符，
    // 否则卡片会写「按X取穴」「X加减」而 X 不是本例的证（2026-10-19 Claude 评审：眩晕·痰湿中阻证因节点「久病气血不足」写成
    //「按气血亏虚取穴」（M-TCMChat-test-352）；痛痹因腰部闪挫节点的「气血瘀滞」加了瘀血阻络的膈俞、血海（M-TCMChat-test-438）；
    // 热秘写成「按饮食停滞取穴」（X-H-0326）；胃热写成按肝气犯胃加太冲、期门（X-H-0104））。
    // 主证先于兼证：脾胃虚寒证兼湿热中阻证按脾胃虚寒取穴（M-TCM-RobustSDT-single_0614）。
    const signedConclusion = textbookContext?.signedSyndromeText || signedSyndromeConclusion;
    const conclusionRefinement = (signedSyndromeConclusion ? governedTcmTreatmentSyndromeRefinement(governedTemplate, signedSyndromeConclusion, caseFacts) : undefined) ||
      (signedConclusion ? governedTcmTreatmentSyndromeRefinement(governedTemplate, signedConclusion, caseFacts) : undefined);
    const narrativeRefinement = conclusionRefinement ? undefined : governedTcmTreatmentSyndromeRefinement(governedTemplate, signedSyndromeText, caseFacts);
    const matchedRefinement = conclusionRefinement ||
      (narrativeRefinement && (!signedConclusion || syndromeLabelFitsSigned(narrativeRefinement.syndromeLabel, signedConclusion)) ? narrativeRefinement : undefined);
    // ── 未终审的证型加减不得冒充「按本例证型加减过」（2026-08-11）────────────────────
    //
    // 45 条证型配穴里只有一部分经过逐条复核。未终审的那些此前与已核验条目**待遇完全相同**：
    // 照样加穴、照样标 governed_patient_specific_plan。这等于把「我们还没核过的东西」
    // 呈现成「已按本例证型定制的方案」。
    //
    // 处置是**非对称**的，方向都取保守侧：
    //   · 加穴（addPoints）：未终审 ⇒ **不应用**。加一个没核过的穴是往外多给东西，不能做。
    //   · 剔除（removePoints）：未终审 ⇒ **照常应用**。剔除是往回收（湿热证剔关元这类），
    //     因为一条规则还没终审就把安全性剔除也一并撤销，反而更危险。
    //   · protocolStatus 降为病种模板态，protocolGap 记 pending 码，conflictNote 原样下发。
    const refinementAdjudication = matchedRefinement
      ? tcmRefinementAdjudication(matchedRefinement.id)
      : undefined;
    const refinementApproved = refinementAdjudication?.adjudicationStatus === "approved";
    const refinement = refinementApproved ? matchedRefinement : undefined;
    const caseTerms = acupointCaseTerms(currentFacts, [...(textbookContext?.diseaseNames || []), ...(textbookContext?.westernNames || [])]);
    // 剔除按**命中的**那条走，不按终审后的那条走——这是上面第二条的落点。
    const removed = new Set(matchedRefinement?.removePoints || []);
    const basePoints = governedTemplate.sitesOrPoints.filter((site) => !removed.has(site));
    // 条件加穴：本例**当前**症状命中触发词才加（风寒咳嗽兼鼻窍/头项症状加风池）。
    // 它与证型加减正交——证型加减每模板只取一条最具体的，条件加穴可多条并存，
    // 所以不能写成第二条证型加减（那样结构上只有一条能生效）。
    const conditionalPoints = governedTcmTreatmentConditionalPoints(governedTemplate, currentFacts)
      .filter((item) => !basePoints.includes(item.point));
    const points = pointsGoverned
      ? [
          ...basePoints.map((site) => annotateGovernedTemplatePoint(projectCode, site, caseTerms)),
          ...conditionalPoints.map((item) =>
            annotateGovernedTemplatePoint(projectCode, item.point, caseTerms, undefined, item.triggerNote)),
          ...(refinement?.addPoints || [])
            .filter((site) => !basePoints.includes(site) && !conditionalPoints.some((item) => item.point === site))
            .map((site) => annotateGovernedTemplatePoint(projectCode, site, caseTerms, refinement?.syndromeLabel)),
        ]
      : [];
    const pointProvenance = tcmTreatmentPointProvenance(
      governedTemplate,
      refinement || matchedRefinement,
      pointsGoverned ? conditionalPoints : [],
    );
    // 「围绕什么」只能引用**病历/已签名结论里真实出现的字**，不能改口成适应证标签的
    // 症状域显示名——后者覆盖面窄于标签本身的匹配面，于是「头胀」被写成了「头痛症状」
    //（甲方 2026-08-10 ⑪）。indicationEvidenceTerms 早就为同一个缺陷写好了，
    // 当初只铺到评估分支，治理分支漏了；又是一次同判据只铺一处。
    //
    // 举不出落点时**一个症状域也不说**（与评估分支同口径）：宁可少一句，也不能给一个
    // 只感冒、无咳嗽的病人写「围绕咳喘与呼吸功能」。退而求其次先用本模板真正命中的
    // matchAny 原词（如「流行性感冒」），它逐字来自本例文本，仍然是可核对的落点。
    // ── 被精确闸门选中的模板本身就是「按本例证型选的」（2026-08-11 签字生效后才暴露）──────
    //
    // 「个体化方案」在本仓库的定义是三件事同时成立：病种事实 + 本例已签名证型 + 该条已终审。
    // 精确闸门恰恰把这三件事写成了模板的准入条件（requireCurrentFactAny / requireSignedSyndromeAny
    // / adjudicationId 已 approved），所以走这条路进来的模板**天然满足**定义。
    //
    // 不加这一段的话，本模板没有 syndromeRefinements ⇒ matchedRefinement 为空 ⇒
    // protocolStatus 会被判成「命中病种模板但未按证型加减」，protocolGap 还会写
    // 「本例已签名证候未匹配到受治理的证型加减方案，请按寒热虚实增减」——
    // 而它恰恰是目录里最贴本例证型的一条。这句话会让医生以为系统没认出证型。
    const syndromeGatedTemplate = preciseFitsNode && Boolean(precise.template?.preciseSyndromeGate);
    const gateLabel = (preciseFitsNode ? precise.template?.preciseSyndromeGate?.indicationLabel : "") || "";
    const syndromeTailored = Boolean(refinement) || syndromeGatedTemplate;
    // 目录里只有病种类目模板、没按本例证型加减时，教材方案（按证型配穴/选方）更贴本例：
    // 证型相符 → 用教材；穴位型项目教材也未按证型时保持目录原状（有已治理来源的频次）。
    // 食疗/导引/意疗目录模板本身没有任何具体内容，教材方案有就用。
    // 目录穴位是「按查体确定/按疼痛部位选择」这类延期说明、真实穴位不足 3 个时（骨骼肌肉痛模板只有
    // 「局部阿是穴（查体确认）」「循经远端穴」），教材的具体取穴更能执行——同样用教材。
    const catalogSpecificPoints = governedTemplate.sitesOrPoints.filter((site) => {
      const bare = site.replace(/（[^）]*）\s*$/, "").trim();
      return projectCode === "auricular" ? bare.length > 0 && !/或/.test(bare) : Boolean(resolveAcupoint(bare));
    }).length;
    // 目录模板是按伴随症状对上的（眩晕病例因「多梦」对上失眠取穴、咳嗽病例因「胃脘」对上胃肠耳穴），而教材里有本病自己的方案：
    // 用教材的（2026-10-13 独立评审：眩晕·肾精不足给的是安眠、神门、内关、心俞）。判据见下面 templateOffDisease。
    const templateMatchedOn = [
      ...indicationEvidenceTerms(governedTemplate.indicationTag, caseFacts),
      ...governedTemplate.matchAny.filter((term) => clinicalText.normalize("NFKC").includes(term)),
    ];
    // 主诉常把伴随症状一并写进去（「产后小便不畅…小腹胀急」「瘿病…失眠烦躁」），此前「命中词不在主诉里」那一条因此拦不住，
    // 癃闭、瘿病、颤证拿到的都是腹胀、失眠模板，耳穴卡拿到头痛模板（2026-10-19，r1019 验收集）。
    const diseaseHasTextbookSection = Boolean(textbookContext &&
      textbookPlanExistsForDisease("acupuncture", textbookContext.diseaseNames[0], textbookContext.westernNames[0], patientAgeYears));
    // 「与病名相合」看本例中医病名、西医病名和对上的教材节名与又名（头风病之于头痛模板、时行感冒/流行性感冒之于流感模板都算本病）。
    const diseaseNameForms = textbookContext
      ? [...textbookContext.diseaseNames, ...textbookContext.westernNames,
        ...(diseaseHasTextbookSection ? textbookSectionNames(textbookContext.diseaseNames, textbookContext.westernNames) : [])].filter(Boolean)
      : [];
    const namesDisease = (terms: readonly string[], forms: readonly string[]) => terms.some((term) => forms.some((name) => name && (name.includes(term) || term.includes(name))));
    // 教材有本病这一项目的方案时，模板自己的匹配词须与已签名的病名（中医、西医）相合——教材节的又名不算（胃痛的耳穴卡用教材「胃、十二指肠、
    // 脾、肝…」，不因教材又名「胃脘痛」含模板词「胃脘」改用通用胃肠耳穴模板；呃逆用教材「耳中、胃、神门…」）；
    // 教材没有时放宽到同一症状域：同域的模板（各项目里 indicationTag 相同的那几条）有一条的匹配词与病名或教材节名相合，或病名本身落在这个症状域里
    //（胃痞的耳穴卡用胃肠耳穴模板——耳穴模板的匹配词没有「胃痞」，针刺的胃肠模板有）。
    const signedNameForms = textbookContext ? [...textbookContext.diseaseNames, ...textbookContext.westernNames].filter(Boolean) : [];
    const domainTerms = TCM_TREATMENT_PROJECTS.flatMap((definition) => definition.planTemplates)
      .filter((template) => template.indicationTag === governedTemplate.indicationTag)
      .flatMap((template) => template.matchAny);
    const templateNamesDisease = textbookPlan
      ? namesDisease(governedTemplate.matchAny, signedNameForms)
      : namesDisease([...governedTemplate.matchAny, ...domainTerms], diseaseNameForms) ||
        indicationTags(diseaseNameForms.join("；")).has(governedTemplate.indicationTag);
    // 2026-10-19（Claude 评审 M 集、H 集）：模板的匹配词与本例病名都不相合，就算对的是伴随症状——不再看主诉里有没有这个词、也不看是否按证型加减过。
    // 主诉常把伴随症状写在一起（「目赤肿痛，羞明流泪，伴头痛发热」「头晕头痛…恶心欲吐」「喉痛、头痛已2天」），此前只要主诉里有「头痛」，
    // 风热赤眼、眩晕、乳蛾、风牵偏视都拿到头痛模板，卡片写「针对本例头痛」（X-H-0155/0161、M-TCMChat-test-352、H-tri-16468、H-tri-6697）；
    // 按证型加减过也一样（眩晕·痰湿中阻按头痛模板的痰浊上扰配穴，五迟按腹胀模板、瘿痈与血证按头痛耳穴模板，紫癜性肾炎腰痛按骨骼肌肉模板，
    // H-tri-14474、H-tri-7467、X-H-0370、M-TCM-RobustSDT-single_0532）。精确证型闸门选中的模板除外（闸门本身就要求本例当前事实与证型）。
    // 模板自己写着「先排除骨折、感染…」，而已签名诊断正是其中一项（膝关节结核，H-tri-16689）：这张模板不适用本例，与对错病同样处理。
    const templateOffDisease = (!syndromeGatedTemplate && templateMatchedOn.length > 0 && diseaseNameForms.length > 0 && !templateNamesDisease) ||
      templateExcludesSignedDiagnosis(governedTemplate.techniqueBoundary, diseaseNameForms.join("；"));
    // 对的是别的病的模板，按证型加减过也不用（2026-10-14 独立评审：遗尿·肺脾气虚的患儿，因证名与「感染后呼吸康复」模板的匹配词
    // 「肺脾气虚」相同，针刺卡写成「按肺脾气虚取穴，针对本例感冒」，取的是反复感冒的穴）。
    // 教材方案按本例证型配了穴、目录只是病类通用模板时，用教材的（2026-10-18 留出集：泄泻、便秘 4 例都给了通用脾胃模板
    //「中脘、天枢、足三里、内关」，教材本病有按证型的配穴）。
    const textbookSyndromeTailored = textbookPlan?.kind === "acupoint" && textbookPlan.points.some((point) => point.role === "syndrome_refinement");
    // 目录模板按本例证型加减过、主穴却只是「局部阿是穴（查体确认）」「循经远端穴（按疼痛部位选择）」这类延期说明（真实穴位不足 3 个），
    // 教材又有本病的针灸节时：主穴用教材的（2026-10-19 留出例 S086 湿热腰痛：针刺卡没有委中、肾俞、大肠俞，「循经远端穴」是占位语；
    // 验收集同类 29 张，瘀血/寒湿腰痛、痹证三型）。教材本节有本例证型就整张用教材；没有时教材主穴 + 目录已终审的证型配穴。
    if (textbookPlan?.kind === "acupoint" && textbookInput && syndromeTailored && !syndromeGatedTemplate &&
      projectCode !== "auricular" && catalogSpecificPoints < 3) {
      // 进这一段的前提是目录证型配穴已命中且已终审（syndromeTailored 且非精确闸门 ⇒ refinement 已 approved），卡片的终审状态照它写。
      if (textbookSyndromeTailored) return { ...fromTextbook(textbookPlan), adjudicationStatus: "approved" as const, ...deferredGovernedTemplate };
      if (refinement) {
        const merged = textbookTreatmentPlan({
          ...textbookInput,
          catalogSyndromeRefinement: { label: refinement.syndromeLabel, addPoints: refinement.addPoints, removePoints: refinement.removePoints },
        });
        if (merged?.kind === "acupoint" && merged.syndromeTailored) {
          const card = fromTextbook(merged);
          const catalogRecords = tcmTreatmentPointProvenance(governedTemplate, refinement)
            .filter((record) => record.role === "syndrome_refinement");
          const fromCatalog = new Set(merged.points.filter((point) => point.fromCatalogRefinement).map((point) => point.name));
          return {
            ...card,
            pointProvenance: card.pointProvenance.map((record) =>
              (fromCatalog.has(record.point) && catalogRecords.find((item) => item.point === record.point)) || record),
            protocolSource: `${card.protocolSource}；${refinement.syndromeLabel}配穴：${governedSourceLabels(refinement.sourceRefs)}`,
            adjudicationStatus: "approved" as const,
            ...deferredGovernedTemplate,
          };
        }
      }
    }
    // 目录的证型配穴只对上了兼证、对不上主证，而教材本节按主证配了穴：用教材的（2026-10-19 晚，第九轮 WP9-D，H-tri-12291：
    // 脾肾阳虚泻兼湿热内蕴证的 2 岁患儿，针刺卡写「按湿热中阻取穴」、取阴陵泉与内庭——治的是兼证，清热的内庭还与主证的阳虚相反；
    // 教材泄泻节有肾阳虚衰（肾俞、命门）。回放 H/M/X 集共 3 张，其余两张教材没有按证型配穴，保持原状）。
    // 兼证有独立成组证据才立（甲方口径），但卡片的「按X取穴」说的是整张卡的取穴依据，主证不能被兼证顶替。
    const primaryOfSigned = signedSyndromeConclusion || String(textbookContext?.signedSyndromeText || "").split(/[；;]/)[0] || "";
    const refinementOnlyFitsSecondary = Boolean(matchedRefinement) && Boolean(primaryOfSigned) &&
      /[；;]/u.test(String(textbookContext?.signedSyndromeText || "")) &&
      !syndromeLabelFitsSigned(matchedRefinement!.syndromeLabel, primaryOfSigned);
    if (textbookPlan && (templateOffDisease || (refinementOnlyFitsSecondary && textbookSyndromeTailored) || (!syndromeTailored &&
      (tcmTreatmentProjectIsPointFree(projectCode) || !pointsGoverned || catalogSpecificPoints < 3 || textbookSyndromeTailored)))) {
      return { ...fromTextbook(textbookPlan), ...deferredGovernedTemplate };
    }
    // 对的是伴随症状的模板、本病又没有教材方案时不给这张模板的穴位，落到下面的评估态（2026-10-18 验收集 H：呃逆给失眠取穴、
    // 产后癃闭给腹胀取穴、痿证给头痛取穴）。按本例证型加减过的模板仍照用——那是按证型选的，不是按顺带症状。
    if (!(templateOffDisease && !textbookPlan)) {
    // 「取穴」只对取穴类项目成立；食疗/导引/意疗说「取穴」是甲方 9.24/9.27 测评点名的错误（食疗还需要取穴针刺吗）。
    const templateNoun = projectCode === "diet_therapy" ? "食疗" : projectCode === "qigong_daoyin" ? "功法" : projectCode === "mind_therapy" ? "情志调摄" : "取穴";
    const evidenceTerms = indicationEvidenceTerms(governedTemplate.indicationTag, caseFacts);
    // 「针对本例X」的 X 只能是病历里写到的、或已签名的中医病名（2026-10-19 晚，验收集 M-TCM-RobustSDT-single_0442：积证的卡写「针对本例功能性消化不良」——
    // 模板是按西医主诊断对上的，clinicalText 里有西医诊断名和模型写的病机，词在那里不等于本例有这个表现）。
    const claimableText = [caseFacts, ...(textbookContext?.diseaseNames || [])].join("；").normalize("NFKC");
    const matchedTemplateTerms = governedTemplate.matchAny
      .filter((term) => claimableText.includes(term))
      .slice(0, 3);
    const groundedTerms = evidenceTerms.length > 0 ? evidenceTerms : matchedTemplateTerms;
    return {
      // 甲方评测(2026-08-04) 第 3 条：治疗内容不再内嵌病机原文。
      // 同一个对象已经带 targetPathogenesis 字段，渲染层单独成行；内嵌等于每个项目块把同一句病机
      // 印两遍，N 个项目就是 2N 遍。病机归病机字段，治疗内容只写这个项目本身的边界。
      // 治疗内容只写医生要读的东西（2026-10-13，甲方 10.12 测评）：按什么证取穴、针对本例哪些表现、随症加了哪些穴。
      // 「本例命中该病种标准取穴模板」「双重条件准入」「本轮不予应用」是系统在讲自己怎么选的，不是治疗内容。
      treatmentContent: [
        refinement
          ? `按${refinement.syndromeLabel}${templateNoun === "取穴" ? "取穴" : `选用${templateNoun}`}`
          : syndromeGatedTemplate
            ? `按${gateLabel}${templateNoun === "取穴" ? "取穴" : `选用${templateNoun}`}`
            : `按本病常规${templateNoun === "取穴" ? "取穴" : `选用${templateNoun}`}`,
        groundedTerms.length > 0 ? `针对本例${groundedTerms.join("、")}` : "",
        conditionalPoints.length > 0 ? `随症加${conditionalPoints.map((item) => item.point).join("、")}` : "",
      ].filter(Boolean).join("，") + "。",
      suggestedSitesOrPoints: points,
      scheduleSuggestion: governedTemplate.scheduleSuggestion,
      techniqueBoundary: pointsGoverned
        ? governedTemplate.techniqueBoundary
        : [governedTemplate.techniqueBoundary, ...governedTemplate.sitesOrPoints].filter(Boolean).join("；"),
      protocolSource: [...new Set([
        ...governedTemplate.sourceRefs,
        ...(refinement?.sourceRefs || []),
        ...conditionalPoints.flatMap((item) => item.sourceRefs),
      ])].join("、"),
      // 逐穴来源与权威分级（2026-08-11）：protocolSource 那个拼接字符串回答不了
      // 「哪个穴来自哪个来源、什么等级、有没有分歧」，而这三件事决定集成方怎么展示、能否采纳。
      pointProvenance,
      sourceAuthorityTier: highestTcmSourceAuthorityTier([
        ...governedTemplate.sourceRefs,
        ...(refinement?.sourceRefs || []),
        ...conditionalPoints.flatMap((item) => item.sourceRefs),
      ]),
      // 只有**两把钥匙都对上**（病种模板 + 本例已签名证型）、且该条证型加减已终审，
      // 才算个体化方案。此前一律写 governed_patient_specific_plan，而四组八例的穴位逐字相同——
      // 那个标签说的不是这一次实际发生的事。
      protocolStatus: syndromeTailored
        ? "governed_patient_specific_plan"
        : "governed_class_template_not_syndrome_tailored",
      // tailoringStatus 与 protocolStatus 在**同一处**派生，两者永不可能各说各的。
      // 它存在的唯一理由是 HIS 的 V1 兼容投影会把 protocolStatus 折叠回旧两态，
      // 而三态的真实值必须有一个不被折叠的落点（见 his-scheme-contract-version）。
      tailoringStatus: syndromeTailored ? "syndrome_tailored" as const : "class_template_only" as const,
      protocolGap: syndromeTailored
        ? undefined
        : matchedRefinement
          ? "syndrome_refinement_pending_adjudication"
          : "syndrome_refinement_not_matched",
      // 只有**命中了**证型加减才谈得上终审状态。一条都没命中时这一栏必须缺省——
      // 写 pending_clinician_review 会让集成方以为「有一条配穴卡在终审里」，
      // 而实际情况是本例证候在该病种下根本没有对应的加减规则（protocolGap 已如实区分两者）。
      ...(matchedRefinement
        ? { adjudicationStatus: refinement ? "approved" as const : "pending_clinician_review" as const }
        : {}),
      ...deferredGovernedTemplate,
      ...(refinement || !matchedRefinement ? {} : {
        deferredSyndromeRefinement: {
          syndromeLabel: matchedRefinement.syndromeLabel,
          deferredPoints: [...matchedRefinement.addPoints],
          conflictNote: refinementAdjudication?.conflictNote
            || "该证型加减尚未完成中医师终审，本轮不作为患者级方案的依据。",
        },
      }),
    };
    }
  }

  // 没有目录模板可用时：教材有该病证的方案就给方案，而不是「本轮仅评估」（甲方 9.24/9.27 测评 2.4）。
  if (textbookPlan) return { ...fromTextbook(textbookPlan), ...deferredGovernedTemplate };
  const sourceRefs = definition?.protocolSourceRefs.filter(Boolean) || [];
  // protocolGap 只作为**内部状态**保留（呈现层据 protocolStatus 决定怎么说），
  // 不再写成给医生看的句子。原文两句讲的都是「系统目录里有没有模板」，
  // 不是这位病人的临床边界；医生读到的是系统自述，而不是本例能不能做这个项目。
  const protocolGap = definition?.patientSpecificParametersAllowed
    ? "catalog_indication_mismatch"
    : "catalog_protocol_absent";
  // 甲方评测(2026-08-03) 9.1：评估态项目卡也要给医生看得见的常用穴位参考。聚合该项目**全部
  // 治理模板**的高频穴位(top5)作为通用参考——不绑定本例适应证、不给频次疗程、protocolStatus
  // 仍为 assessment_only,呈现层按该状态标注「通用参考,未按本例适应证核定」。空模板项目保持为空。
  // 9.1：延期说明型模板整条排除在聚合之外——否则「常用穴位」栏里印的是
  // 「按针刺方案中与当前证型匹配的穴位」这样一句话（生产实测：产后头痛例的灸法卡片）。
  // 选穴依据从「模板里出现得多」换成「主治与本例主症对得上」(2026-08-05,甲方 6.1)。
  //
  // 甲方原话指向的正是旧实现自己写的那句标注:「常用穴位(通用参考,未按本例适应证核定)」——
  // 风寒束表例(淋雨后、恶寒重发热轻、无汗、脉浮紧)拿到的是一个与本例无关的通用池。
  // 旧口径是把该项目**全部治理模板**的穴位按出现频次取 top5,与本例是什么证、什么症无关。
  //
  // 而 T12 穴位目录 400 穴每一穴都带教材主治(indications),运行时从未查过——
  // 又一次「治理数据在库里、运行时没读」。改为按本例主症逐条匹配主治后实测:
  //   风寒感冒 → 合谷、风门、风池、列缺   脾虚泄泻 → 天枢、足三里、公孙、阴陵泉
  // 都是教材级取穴,且每一穴都能说出是本例哪个症把它选进来的。
  //
  // 安全边界一条未动:仍是证据层参考,executable=false 不变,补泻深度留针仍由现场医师定。
  // 主症取不到(病历太稀疏)时退回原有的模板高频池——不猜,不外推。
  // 评估态没有与本例匹配且已终审的患者级模板，就不展示任何具体穴位。
  // 过去用关键词从400穴目录拼 top5，甲方同一风寒感冒病例反复得到肩中俞、涌泉、大杼；
  // 这些穴虽各自“主治含发热/咳嗽”，却没有本例证型级方案依据。宁可留空并要求现场辨证，
  // 也不把未治理的关键词结果包装成临床推荐。
  const referenceCommonPoints: string[] = [];
  // 评估态 = 目录里没有与本例对应的标准方案。此时能证明的只有「病历里的哪句话把这个项目
  // 带进候选」，不能改口成症状域名称。举不出病历落点（标签只来自模型行文）时一句都不说，
  // 只讲清这是评估态——fail-closed 优于说一个患者没有的症状。
  const evidenceTerms = tag ? indicationEvidenceTerms(tag, caseFacts) : [];
  return {
    ...deferredGovernedTemplate,
    // 讲本例为什么进评估范围就够了。原文后半句「目录中暂无与本例对应的标准操作方案」是
    // 系统自述内部状态：医生要知道的是「这个项目现在只做现场评估、不给操作计划」，
    // 不是「你们的目录里缺模板」。
    treatmentContent: evidenceTerms.length > 0
      ? `本例的「${evidenceTerms.join("、")}」使该项目进入评估范围；本轮仅进行现场适应证、禁忌与资质评估，不形成操作计划。`
      : `就上述病机方向进行现场适应证、禁忌与资质评估，本轮不形成操作计划。`,
    suggestedSitesOrPoints: referenceCommonPoints,
    scheduleSuggestion: "",
    // parameterPolicy 是**系统显示策略**——目录里 2969 条项目一字不差，与病人无关
    // （「仅在病例文字命中模板适应证且通过红旗、资质和禁忌复核时可显示治理过的穴位…」）。
    // 操作边界这一栏只放真正的操作边界；评估态没有患者级参数可写。
    //
    // 但**不能留空**（2026-08-11）。留空看似最保守，实际后果是整条项目从签名载荷里消失：
    // TcmTreatmentRecommendationSchema 的 techniqueBoundary 是 min(1)，逐条隔离机制把这条
    // 判为非法、整条剔除，而可见正文在**归一之前**就已按原始载荷渲染完毕。于是医生页面
    // 印着三个诊疗项目，签名载荷与 HIS 方案里一个都没有。50 例实测：30 例页面有项目，
    // 载荷只有 14 例——评估态项目 100% 掉在这一条上，而且全程零信号。
    // 这里写的是这一档**真实存在的**操作边界（本轮不下发参数），不是为过 schema 编的占位句。
    techniqueBoundary: "本轮不下发患者级操作参数；具体操作参数与技术细节由现场执业人员按本机构规范、项目资质与患者耐受确定。",
    protocolSource: sourceRefs.join("、") || "T12 中医非药物项目治理目录",
    protocolStatus: "assessment_only_no_patient_specific_protocol",
    tailoringStatus: "assessment_only" as const,
    protocolGap,
  };
}

function indicationTags(text: string): Set<TcmTreatmentIndicationTag> {
  return new Set(INDICATION_PATTERNS.flatMap(([tag, pattern]) => pattern.test(text) ? [tag] : []));
}

function globalIndicationText(prior: ClinicalReasoningResultV2): string {
  return [
    prior.overview.tcmDiseaseName,
    prior.overview.primarySyndrome,
    prior.overview.overallPathogenesis,
    prior.therapy.overallPrinciple,
    prior.therapy.overallMethod,
    prior.westernDiagnosis.primary.name,
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("；");
}

function nodeIndicationTags(
  prior: ClinicalReasoningResultV2,
  node: ClinicalReasoningResultV2["pathogenesis"]["chain"][number],
  currentFactFallback: ReadonlySet<TcmTreatmentIndicationTag>,
): Set<TcmTreatmentIndicationTag> {
  const local = indicationTags([node.patientFact, node.syndromeEvidence, node.pathogenesis, node.therapyDirection]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("；"));
  if (local.size > 0) return local;
  const global = indicationTags(globalIndicationText(prior));
  return global.size > 0 ? global : new Set(currentFactFallback);
}

/** 治理模板匹配所用的正文。排序与编译两处必须用同一份，否则"入选时算有方案、成卡时算没有"。 */
function treatmentClinicalText(
  prior: ClinicalReasoningResultV2,
  node: ClinicalReasoningResultV2["pathogenesis"]["chain"][number],
  caseFacts: string,
): string {
  return [globalIndicationText(prior), caseFacts, node.pathogenesis, node.syndromeEvidence]
    .filter(Boolean).join("；");
}

function clinicalAffinity(
  projectCode: TcmTreatmentProjectCode,
  tags: ReadonlySet<TcmTreatmentIndicationTag>,
): number {
  const definition = getTcmTreatmentProjectDefinition(projectCode);
  if (!definition) return 0;
  // A nasal/upper-airway node often contains TCM phrases such as “肺气失宣”. Do not let that
  // broader lung wording promote lower-airway rehabilitation projects above rhinitis-specific
  // options on the same node. A genuinely separate cough/asthma node is still scored normally.
  if (tags.has("upper_airway")) {
    if (!definition.indicationTags.includes("upper_airway")) return 0;
    return PROJECT_TAG_AFFINITY[projectCode]?.upper_airway || 50;
  }
  const compatible = definition.indicationTags.filter((tag) => tags.has(tag));
  if (compatible.length === 0) return 0;
  return Math.max(...compatible.map((tag) => PROJECT_TAG_AFFINITY[projectCode]?.[tag] || 50));
}

function treatmentCaseFacts(caseState?: Partial<TreatmentCaseContext>): string {
  if (!caseState) return "";
  const fields = caseState.hisRecord?.fields;
  const rawValues: unknown[] = [
    caseState.chiefComplaint,
    ...Object.values(caseState.symptoms || {}),
    caseState.pastHistory,
    caseState.medicationHistory,
    caseState.allergyHistory,
    fields?.zhushu,
    fields?.xianbingshi,
    fields?.jiwangshi,
    fields?.yongyaoshi,
    fields?.guomin,
    ...(caseState.conversation || []).filter((item) => item.role === "user").map((item) => item.content),
  ];
  return rawValues
    .map((value) => affirmedClinicalText(typeof value === "string" ? value : "", "affirmed"))
    .filter((value): value is string => Boolean(value))
    .join("；");
}

/**
 * Conservative current-fact fallback used only for treatment indication matching. Unlike
 * `treatmentCaseFacts`, this intentionally excludes past history, medication/allergy history and
 * conversation, whose temporal scope is not guaranteed. Chief complaint, normalized current
 * symptoms and HIS present-illness fields are current-encounter inputs by contract; negated clauses
 * are removed before matching.
 */
function treatmentCurrentFacts(caseState?: Partial<TreatmentCaseContext>): string {
  if (!caseState) return "";
  const fields = caseState.hisRecord?.fields;
  const rawValues: unknown[] = [
    caseState.chiefComplaint,
    ...Object.values(caseState.symptoms || {}),
    fields?.zhushu,
    fields?.xianbingshi,
    fields?.tcmDetail,
  ];
  return rawValues
    .map((value) => affirmedClinicalText(typeof value === "string" ? value : "", "affirmed"))
    .filter((value): value is string => Boolean(value))
    .join("；");
}

const INFANT_TODDLER_STAGES = new Set(["neonate", "infant", "toddler"]);
/** 新生儿、乳婴儿、幼儿（儿童剂量分档表，未满 3 周岁）；没有数值年龄时看病历的年龄段词。 */
function infantOrToddler(age: number | undefined, caseFacts: string): boolean {
  const rule = age != null ? pediatricDoseRuleForAgeYears(age) : pediatricDoseRuleForStageWords(caseFacts);
  return Boolean(rule && INFANT_TODDLER_STAGES.has(rule.stage));
}

function treatmentPatientAgeYears(caseState?: Partial<TreatmentCaseContext>): number | undefined {
  // 病历写明患儿年龄、登记年龄却是成人时，按病历的儿童年龄出卡（与剂量层同一判据 narrativePediatricAgeConflict，2026-10-18 起剂量层已按它
  // 先核实年龄；治疗卡此前仍按登记的成人年龄出，婴儿拿到成人的艾灸与针刺写法）。
  const narrativeChildAge = caseState?.patient ? narrativePediatricAgeConflict(caseState as CaseState) : undefined;
  if (narrativeChildAge != null) return narrativeChildAge;
  const raw = caseState?.patient?.age ?? caseState?.hisRecord?.fields?.age;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 130) return raw;
  if (typeof raw !== "string") return undefined;
  const years = raw.match(/(\d+(?:\.\d+)?)\s*岁/)?.[1];
  if (years != null) return Number(years);
  const months = raw.match(/(\d+(?:\.\d+)?)\s*(?:个)?月/)?.[1];
  return months != null ? Number(months) / 12 : undefined;
}

/**
 * 妊娠判定用的原文（2026-09-28）。treatmentCaseFacts 只保留肯定句，会把「可能怀孕」「妊娠可能」这类
 * 可疑表述当作不确定陈述剔掉，于是下面「取 positive 与 possible 两档」的妊娠禁忌实际只拦得住阳性：
 * 「停经7周，可能怀孕」的患者照样拿到针刺、艾灸项目卡。妊娠状态层自己处理否认与既往，
 * 直接喂原文即可，不会把「否认妊娠」判成阳性。
 */
function treatmentPregnancyText(caseState?: Partial<TreatmentCaseContext>): string {
  if (!caseState) return "";
  const fields = caseState.hisRecord?.fields;
  return [
    caseState.chiefComplaint,
    ...Object.values(caseState.symptoms || {}),
    caseState.pastHistory,
    caseState.medicationHistory,
    fields?.zhushu,
    fields?.xianbingshi,
    fields?.jiwangshi,
    fields?.tcmDetail,
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("；");
}

/**
 * Project-level contraindications are a separate deterministic boundary from diagnostic affinity.
 * They remove a project before it reaches the model and again before server compilation. This is
 * intentionally project-specific: a contraindicated procedure must not erase unrelated low-risk
 * care such as diet or emotion support and therefore never blocks the overall consultation flow.
 */
function treatmentPregnancyStatus(caseState: Partial<TreatmentCaseContext> | undefined, facts: string) {
  const raw = assessPregnancyState(treatmentPregnancyText(caseState)).status;
  return raw === "positive" || raw === "possible" ? raw : assessPregnancyState(facts).status;
}

/**
 * 热象的写法（2026-10-19，r1019 验收集：苔薄黄、苔微黄、舌尖微红、心口烦热、烘热、胸腔灼热都没被认作热象，
 * 居家保健照样给艾灸，郁证卡照样给直接灸）。闭集：舌、苔颜色的修饰写法（「舌淡红」是正常舌色，不算），
 * 自觉发热的说法，以及辨证结论里的郁热、化热、某脏热、某脏火。依据《刺法灸法学》灸法禁忌「阴虚阳亢、邪热内炽者慎用」。
 */
const MOXIBUSTION_HEAT_SIGNS = /舌(?:尖|边|边尖|质)?(?:微|偏|稍|略)?红(?!润)|苔(?:薄|微|稍|略)?黄|烦热|烘热|潮热|手足心热|灼热|郁热|化热|内热|里热|[胃肝心肺]热|[心肝胃]火/;
/**
 * 出血倾向（2026-10-19，验收集 M-TCMChat-test-418 血小板 28×10⁹/L、M-TCM-RobustSDT-single_0516 原发免疫性血小板减少症）：
 * 居家保健照样给按揉、艾灸，同一段话里却写着「有出血倾向的血液病患者不宜自行按揉」「有出血倾向者不宜艾灸」。
 * 判据：血小板减少的写法、紫癜、血友病、凝血功能障碍、出血倾向，或血小板计数低于 50×10⁹/L（只读本例肯定句）。
 */
const BLEEDING_TENDENCY_TERMS = /血小板[^。；，,]{0,4}(?:减少|降低|下降|低下)|血小板减少|紫癜|血友病|凝血(?:功能|机制)(?:障碍|异常)|出血倾向|弥散性血管内凝血/;
const PLATELET_COUNT = /(?:血小板(?:计数)?|PLT)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:[×*xX]\s*)?10/i;
export function bleedingTendencyRecorded(affirmedFacts: string): boolean {
  if (BLEEDING_TENDENCY_TERMS.test(affirmedFacts)) return true;
  const count = Number(affirmedFacts.match(PLATELET_COUNT)?.[1] ?? NaN);
  return Number.isFinite(count) && count < 50;
}
const BLEEDING_EXCLUDED_PROJECTS = new Set<TcmTreatmentProjectCode>([
  "tuina", "moxibustion", "cupping", "guasha", "bloodletting", "needle_knife", "fire_cautery", "hook_cutting", "thread_embedding",
]);

export function tcmTreatmentProjectExclusionReason(
  projectCode: TcmTreatmentProjectCode,
  prior: ClinicalReasoningResultV2,
  caseState?: Partial<TreatmentCaseContext>,
): string | undefined {
  const caseFacts = treatmentCaseFacts(caseState);
  const reasoningFacts = [
    globalIndicationText(prior),
    ...prior.pathogenesis.chain.flatMap((node) => [node.patientFact, node.syndromeEvidence, node.pathogenesis]),
  ].filter(Boolean).join("；");
  const facts = `${caseFacts}；${reasoningFacts}`;
  const age = treatmentPatientAgeYears(caseState);
  const infant = (age != null && age < 1) || /新生儿|婴儿|婴幼儿|乳儿|\d+\s*(?:个)?月龄/.test(caseFacts);
  const eczema = /湿疹|湿疮|特应性皮炎|皮损/.test(reasoningFacts);
  if (infant && eczema && new Set<TcmTreatmentProjectCode>([
    "acupuncture", "guasha", "bloodletting", "fire_cautery", "needle_knife", "hook_cutting", "thread_embedding",
  ]).has(projectCode)) {
    return "婴幼儿湿疹不常规推荐针刺、刮痧或侵入性皮肤项目";
  }
  // 婴幼儿不拔罐：《刺法灸法学》（十三五）拔罐法禁忌证「婴幼儿…不宜拔罐」，注意事项「妊娠妇女及婴幼儿慎用拔罐方法」
  //（2026-10-29 甲方实测：1 岁女童咳嗽给了拔罐卡）。婴幼儿＝儿童剂量分档的新生儿、乳婴儿、幼儿（未满 3 周岁），同一张分档表。
  if (projectCode === "cupping" && infantOrToddler(age, caseFacts)) {
    return "婴幼儿不宜拔罐（《刺法灸法学》拔罐法禁忌证）";
  }

  const diabeticFoot = /糖尿病足|足部?溃疡|足溃疡|足坏疽|足部感染/.test(facts);
  if (diabeticFoot && new Set<TcmTreatmentProjectCode>([
    "acupuncture", "moxibustion", "cupping", "guasha", "needle_knife", "fumigation_wash",
    "medicated_bath", "medicated_ironing", "bloodletting", "fire_cautery", "hook_cutting", "thread_embedding",
  ]).has(projectCode)) {
    return "糖尿病足或足部破损感染不推荐常规热疗、皮肤刺激或侵入性项目";
  }

  const activeInflammation = /活动性感染|局部感染|化脓|脓肿|蜂窝织炎|急性炎症|红肿热痛|高热/.test(facts);
  if (activeInflammation && new Set<TcmTreatmentProjectCode>([
    "tuina", "moxibustion", "cupping", "guasha", "needle_knife", "acupoint_application",
    "medicated_plaster", "fumigation_wash", "medicated_bath", "medicated_ironing", "bloodletting",
    "fire_cautery", "hook_cutting", "thread_embedding",
  ]).has(projectCode)) {
    return "活动性感染或急性炎症期不推荐常规手法、热疗、外治或侵入性项目";
  }
  if (
    projectCode === "moxibustion" &&
    // 已签名证候病性属热（含暑，受治理病性词表，与卡片去灸同一判据 syndromeHasHeatNature）同样不灸：居家保健的艾灸也走这里
    //（2026-10-19 终评 M-TCM-RobustSDT-single_0102 暑湿伤表证）。
    ((/热证|实热|湿热|痰热|血热|虚热|阴虚火旺|火热|火旺|舌红|苔黄|发热/.test(facts) || MOXIBUSTION_HEAT_SIGNS.test(facts)) &&
      !/寒热错杂|上热下寒/.test(facts) || syndromeHasHeatNature(prior.overview?.primarySyndrome || ""))
  ) {
    return "当前热象或热证方向与灸法温热属性冲突，不推荐进入候选项目";
  }

  const heartFailure = /心力衰竭|心衰|射血分数(?:降低|减低)|LVEF\s*[<≤]\s*50|EF\s*[<≤]\s*50/.test(facts);
  if (heartFailure && projectCode === "medicated_bath") return "心力衰竭患者不常规推荐药浴";
  if (heartFailure && /急性|失代偿|不稳定/.test(facts) && projectCode === "qigong_daoyin") {
    return "急性或失代偿性心力衰竭不推荐导引运动项目";
  }

  const majorRenalImpairment = /慢性肾病\s*[3-5三四五ⅢⅣⅤ]期|CKD\s*[3-5]|肾功能不全|肾衰|尿毒症|eGFR\s*[<≤]\s*60/.test(facts);
  if (majorRenalImpairment && projectCode === "medicated_bath") return "显著肾功能异常不常规推荐药浴";

  // ─── 妊娠禁忌 ───
  // 这条此前**完全不存在**：本函数的全部禁忌只覆盖婴幼儿湿疹、糖尿病足、活动性炎症、
  // 灸法热证冲突、心衰、肾功能异常六项，妊娠一项没有——而妊娠禁针是针灸最基本的禁忌之一
  // （合谷、三阴交、昆仑、至阴、肩井等催产/活血穴，以及腰骶部、下腹部腧穴）。
  //
  // 判定**复用确定性状态层** assessPregnancyState/assessLactationState，不再写第七条正则：
  // 上面六条禁忌各写各的正则，正是"关键词冒充覆盖"的来源（口语「脚上烂了个洞老不收口」
  // 就绕过了糖尿病足那条）。妊娠状态层已有完整的阳性/可疑/否定/既往四档词表与套件
  // （test:pregnancy-recall），接它一处，四档语义与今后的每次扩充都自动同步。
  //
  // 取 positive 与 possible 两档：可疑妊娠同样不能扎。既往妊娠（historical）不拦。
  // 系统不建模具体穴位与部位，因此对侵入性/热疗/腹腰骶相关项目一律转人工按禁忌穴位评估——
  // 这是 fail-closed：宁可让医师多确认一次，不可默认放行。
  // 已签名的西医诊断写到凝血障碍、血小板减少（含「待查」）同样算（2026-10-19 Claude 评审 X-H-0370：针后血肿、轻伤出血，诊断
  //「凝血功能障碍相关出血待查」，居家保健仍给按揉期门、血海）。
  if (BLEEDING_EXCLUDED_PROJECTS.has(projectCode) && bleedingTendencyRecorded(`${caseFacts}；${prior.westernDiagnosis?.primary?.name || ""}`)) {
    return "出血倾向或血小板明显减少：不推荐按揉、灸、罐、刮痧及侵入性外治项目";
  }

  const pregnancyStatus = treatmentPregnancyStatus(caseState, facts);
  if (pregnancyStatus === "positive" || pregnancyStatus === "possible") {
    if (new Set<TcmTreatmentProjectCode>([
      // 耳穴（毫针、埋针、压丸）此前不在内，而耳穴卡自己写着「妊娠期禁用」（第二十四轮甲方 100 例 C097：妊娠 12 周给了耳穴卡）。
      "acupuncture", "moxibustion", "tuina", "cupping", "guasha", "needle_knife", "auricular",
      "thread_embedding", "bloodletting", "fire_cautery", "hook_cutting", "thread_drainage",
      "ligation", "medicated_bath", "medicated_ironing", "fumigation_wash", "acupoint_application",
      "medicated_plaster",
    ]).has(projectCode)) {
      return pregnancyStatus === "positive"
        ? "妊娠期：合谷、三阴交、昆仑、至阴等催产活血穴及腰骶、下腹部腧穴禁用，本系统不建模具体穴位与施术部位，需医师按妊娠禁忌逐项评估后决定"
        : "存在妊娠可能且未排除：涉及穴位刺激、热疗或外治的项目需先明确妊娠状态再评估";
    }
  }
  return undefined;
}

function rankedTreatmentCandidates(
  scope: CapabilityScope,
  prior: ClinicalReasoningResultV2,
  proposals: readonly ModelTreatmentProposal[],
  includeAssessmentOnlyProjects = false,
  caseState?: Partial<TreatmentCaseContext>,
): TreatmentCandidate[] {
  const chain = Array.isArray(prior.pathogenesis?.chain) ? prior.pathogenesis.chain : [];
  const currentFactFallback = indicationTags(treatmentCurrentFacts(caseState));
  const nodeById = new Map(chain.map((node, index) => [node.nodeId || `P${index + 1}`, node] as const));
  const capabilityByCode = new Map(scope.items.map((item) => [item.projectCode, item]));
  const proposedCodes = new Set(proposals.map((item) => item.projectCode));
  const scoredByKey = new Map<string, TreatmentCandidate>();
  const consider = (projectCode: TcmTreatmentProjectCode, targetRef: string, explicit: boolean) => {
    if (projectCode === "miscellaneous" || !capabilityByCode.has(projectCode)) return;
    if (tcmTreatmentProjectExclusionReason(projectCode, prior, caseState)) return;
    const node = nodeById.get(targetRef);
    if (!node) return;
    const nodeTags = nodeIndicationTags(prior, node, currentFactFallback);
    let score = clinicalAffinity(projectCode, nodeTags);
    // 适应证标签是词袋，没有收「蛇串疮/水疱」「心悸」这类病名：**该节点一个标签都没认出来**，而教材里有该病证的
    // 该项目方案时，病名本身就是适应证（亲和度取 55，低于任何标签命中）。节点认出了别的标签（睡眠节点上的推拿）
    // 说明它是另一个适应证的节点，不得凭病名改绑——「不得静默改绑到别的节点」的底线不变。
    // 主证节点（病机链第一个节点）承接的就是本病：教材有该病的这一项目方案时，即使节点认出了别的标签也按病名算适应证
    //（2026-10-26 甲方测评病历 5：虚劳·肺脾两虚证只给了食疗，《推拿学》虚劳节的方案没出；「这类虚证很适合针灸治疗」）。
    // 只用于服务端按目录补的项目（模型自己绑定了节点、却绑错了的，仍不得改绑，见上一段）。
    const mainNode = node === chain[0] && !explicit;
    if (score <= 0 && (nodeTags.size === 0 || mainNode) &&
      textbookPlanExistsForDisease(projectCode, prior.overview?.tcmDiseaseName, prior.westernDiagnosis?.primary?.name, treatmentPatientAgeYears(caseState))) score = 55;
    if (score <= 0) return;
    const key = `${projectCode}:${targetRef}`;
    const current = scoredByKey.get(key);
    if (!current || score > current.score || (explicit && !current.explicit)) {
      scoredByKey.set(key, { projectCode, targetRef, score, explicit });
    }
  };
  for (const proposal of proposals) consider(proposal.projectCode, proposal.targetRef, true);
  for (const capability of scope.items) {
    const definition = getTcmTreatmentProjectDefinition(capability.projectCode);
    if (!definition || capability.projectCode === "miscellaneous") continue;
    // A provider-selected project with a fabricated or mismatched target is discarded. Do not
    // silently make that same clinical choice valid by rebinding it to another node.
    if (proposedCodes.has(capability.projectCode) && ![...scoredByKey.values()].some((item) => item.projectCode === capability.projectCode && item.explicit)) continue;
    if (!includeAssessmentOnlyProjects && (definition.risk === "specialist" || definition.requiresMedicationAudit)) continue;
    for (const [index, node] of chain.entries()) consider(capability.projectCode, node.nodeId || `P${index + 1}`, false);
  }
  return [...scoredByKey.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.explicit !== right.explicit) return left.explicit ? -1 : 1;
    const leftPriority = capabilityByCode.get(left.projectCode)?.priority ?? 999;
    const rightPriority = capabilityByCode.get(right.projectCode)?.priority ?? 999;
    return leftPriority - rightPriority || left.projectCode.localeCompare(right.projectCode);
  });
}

function isTrustedM03(prior: ClinicalReasoningResultV2 | null | undefined): prior is ClinicalReasoningResultV2 {
  return Boolean(
    prior && prior.stage === "diagnose" &&
    prior.contractSignatureVersion === "tcm-cdss-m03-signature-v5" &&
    /^hmac-sha256:[a-f0-9]{64}$/i.test(String(prior.contractSignature || "")),
  );
}

function invalidConfiguredScope(reason: string): CapabilityScope {
  return { mode: "configured", valid: false, reason, items: [] };
}

function configuredCapabilitiesFromJson(raw: string): CapabilityScope | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown; items?: unknown };
    if (parsed.schemaVersion !== "tcm-cdss-clinic-treatment-capabilities-v1" || !Array.isArray(parsed.items)) {
      return invalidConfiguredScope("invalid_schema");
    }
    const seen = new Set<TcmTreatmentProjectCode>();
    const items: DeploymentCapability[] = [];
    for (const [index, entry] of parsed.items.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return invalidConfiguredScope("invalid_items");
      const item = entry as Record<string, unknown>;
      if (!isKnownTcmTreatmentProjectCode(item.projectCode) || seen.has(item.projectCode)) {
        return invalidConfiguredScope("invalid_items");
      }
      if (item.deliveryMode !== "onsite" && item.deliveryMode !== "referral") {
        return invalidConfiguredScope("invalid_items");
      }
      if (item.priority !== undefined && !Number.isFinite(Number(item.priority))) {
        return invalidConfiguredScope("invalid_items");
      }
      if (item.specialistApproved !== undefined && typeof item.specialistApproved !== "boolean") {
        return invalidConfiguredScope("invalid_items");
      }
      seen.add(item.projectCode);
      const definition = getTcmTreatmentProjectDefinition(item.projectCode);
      const specialistApproved = item.specialistApproved === true;
      const deliveryMode: DeliveryMode = definition?.risk === "specialist" && !specialistApproved
        ? "referral"
        : item.deliveryMode;
      items.push({
        projectCode: item.projectCode,
        deliveryMode,
        priority: item.priority === undefined ? index + 100 : Math.max(0, Math.min(999, Number(item.priority))),
        specialistApproved,
      });
    }
    return { mode: "configured", valid: true, items };
  } catch {
    return invalidConfiguredScope("invalid_json");
  }
}

function capabilityEntries(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === "string")) return undefined;
    return value.map((entry) => entry.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/[,，;；|]/).map((entry) => entry.trim()).filter(Boolean);
  }
  return undefined;
}

function strictCapabilityCodes(value: unknown): { valid: boolean; codes: TcmTreatmentProjectCode[] } {
  const entries = capabilityEntries(value);
  if (!entries) return { valid: false, codes: [] };
  if (entries.some((entry) => parseTcmTreatmentCapabilities(entry).length !== 1)) {
    return { valid: false, codes: [] };
  }
  return { valid: true, codes: parseTcmTreatmentCapabilities(entries) };
}

function deploymentCapabilityScope(): CapabilityScope {
  const json = configuredCapabilitiesFromJson(process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON || "");
  if (json) return json;

  const simpleRaw = process.env.TCM_CLINIC_TREATMENT_CAPABILITIES || "";
  if (simpleRaw.trim()) {
    const simple = strictCapabilityCodes(simpleRaw);
    if (!simple.valid || simple.codes.length === 0) return invalidConfiguredScope("invalid_capabilities");
    return {
      mode: "configured",
      valid: true,
      items: simple.codes.map((projectCode, index) => {
        const definition = getTcmTreatmentProjectDefinition(projectCode);
        return {
          projectCode,
          deliveryMode: definition?.risk === "specialist" ? "referral" as const : "onsite" as const,
          priority: index,
          specialistApproved: false,
        };
      }),
    };
  }

  return { mode: "not_configured", valid: false, reason: "not_configured", items: [] };
}

function effectiveCapabilityScope(caseState?: Pick<CaseState, "clinicTreatmentCapabilities" | "clinicTreatmentCapabilitiesRestricted">): CapabilityScope {
  const deployment = deploymentCapabilityScope();
  if (!deployment.valid) return deployment;
  const caseConstraintActive = caseState?.clinicTreatmentCapabilitiesRestricted === true ||
    (Array.isArray(caseState?.clinicTreatmentCapabilities) && caseState.clinicTreatmentCapabilities.length > 0);
  if (!caseConstraintActive) return deployment;

  const caseConstraint = strictCapabilityCodes(caseState.clinicTreatmentCapabilities);
  if (!caseConstraint.valid || caseConstraint.codes.length === 0) return { ...deployment, items: [] };
  const allowed = new Set(caseConstraint.codes);
  return { ...deployment, items: deployment.items.filter((item) => allowed.has(item.projectCode)) };
}

export function buildTcmTreatmentProjectPromptContext(
  caseState?: Partial<TreatmentCaseContext> & Pick<CaseState, "reasoningDiagnose">,
): string {
  const scope = effectiveCapabilityScope(caseState);
  const trustedPrior = isTrustedM03(caseState?.reasoningDiagnose) ? caseState.reasoningDiagnose : undefined;
  const chain = trustedPrior?.pathogenesis?.chain || [];
  const availableItems = scope.items.filter((item) => item.projectCode !== "miscellaneous");
  if (!scope.valid || chain.length === 0 || availableItems.length === 0) {
    return "【中医非药物治疗项目】当前机构未配置可推荐项目，tcmTreatments 必须输出空数组。";
  }
  const personalized = rankedTreatmentCandidates(scope, trustedPrior!, [], true, caseState).filter((item, index, all) =>
    all.findIndex((candidate) => candidate.projectCode === item.projectCode) === index
  );
  if (personalized.length === 0) {
    return "【中医非药物治疗项目】当前已签名诊断没有命中机构项目目录中的适应领域，tcmTreatments 必须输出空数组。";
  }
  const personalizedCodes = new Set(personalized.map((item) => item.projectCode));
  return [
    "【中医非药物治疗项目受控候选】",
    "以下仅列出部署配置允许的项目；模型须结合已签名 M03 的患者事实、病机节点、治法、禁忌和项目风险独立判断是否适合，不需要为了凑数而推荐。标记本机构可开展的项目优先。",
    ...availableItems.filter((item) => personalizedCodes.has(item.projectCode)).sort((left, right) => {
      const leftRank = personalized.findIndex((candidate) => candidate.projectCode === left.projectCode);
      const rightRank = personalized.findIndex((candidate) => candidate.projectCode === right.projectCode);
      return leftRank - rightRank;
    }).map((item) => {
      const definition = getTcmTreatmentProjectDefinition(item.projectCode);
      const medicationBoundary = definition?.requiresMedicationAudit ? "｜含药外治，仅作审方评估" : "";
      return `${item.projectCode}=${definition?.name || item.projectCode}｜${item.deliveryMode === "onsite" ? "本机构可开展" : "转介/评估"}${medicationBoundary}`;
    }),
    `可引用的 M03 病机节点：${chain.map((node, index) => `${node.nodeId || `P${index + 1}`}=${node.pathogenesis || node.syndromeEvidence}`).join("；")}`,
    "模型只输出确有临床理由的 projectCode 与真实 targetRef(P1/P2...)，最多3项，可输出空数组。不得输出穴位、部位、进针深度、温度、时长、放血量、药物组成、操作步骤或疗程参数；其他字段由服务端可信目录生成。",
  ].join("\n");
}

export function compileTcmTreatmentRecommendations(
  proposals: readonly ModelTreatmentProposal[],
  prior: ClinicalReasoningResultV2 | null | undefined,
  caseState?: Partial<TreatmentCaseContext>,
  /** 本次 M04 的饮食调护原文（要求清淡、避免滋腻时食疗卡不选肥甘之品）。 */
  dietAdvice = "",
  /** 本次处方的药味名（食疗卡不选含同一味药的方子）。 */
  prescribedHerbNames: readonly string[] = [],
  /** 本次 M04 的注意事项原文（写明忌茶时食疗卡不选含茶叶的方子）。 */
  precautionText = "",
): TreatmentRecommendation[] {
  if (!isTrustedM03(prior) || caseState?.safetyGate?.status === "red_flag") return [];
  const scope = effectiveCapabilityScope(caseState);
  if (!scope.valid) return [];
  const prescribedIdentities = new Set(prescribedHerbNames.map((name) => canonicalTcmHerbIdentity(name)).filter(Boolean));

  const capabilityByCode = new Map(scope.items.map((item) => [item.projectCode, item]));
  const chain = Array.isArray(prior.pathogenesis?.chain) ? prior.pathogenesis.chain : [];
  const nodeById = new Map(chain.flatMap((node, index) => {
    const nodeId = node.nodeId || `P${index + 1}`;
    return [[nodeId, node] as const];
  }));
  const seen = new Set<TcmTreatmentProjectCode>();
  const rankedPool = rankedTreatmentCandidates(scope, prior, proposals, false, caseState);
  const caseFacts = treatmentCaseFacts(caseState);
  const currentFacts = treatmentCurrentFacts(caseState);
  const currentFactFallback = indicationTags(caseFacts);
  // 模型一条都不提名时只取前 2 名——但排名是按适应证亲和度算的，与「本例有没有已签字的
  // 患者级方案」无关。实测普通风寒咳嗽：针刺排第 4，于是那条中医师已签字、已按本例证型
  // 加减的取穴方案（肺俞/中府/列缺/太渊/风门/合谷 + 条件加穴风池）连被编译的机会都没有。
  // 已经命中签字精确证型闸门的项目一律进池：它不是"多推荐一个项目"，
  // 而是"别把已经算好的、有人签过字的方案扔掉"。仍受下面的名额与档次排序约束。
  const signedSyndromeText = prior.overview.primarySyndrome || "";
  const patientAgeYears = treatmentPatientAgeYears(caseState);
  const gateTagByCode = new Map<TcmTreatmentProjectCode, string>();
  for (const item of rankedPool) {
    if (gateTagByCode.has(item.projectCode)) continue;
    const template = governedTcmTreatmentPrecisePlanTemplate(
      item.projectCode, currentFacts, signedSyndromeText, patientAgeYears,
    ).template;
    if (template) gateTagByCode.set(item.projectCode, template.indicationTag);
  }
  const gateOpenedCodes = new Set(gateTagByCode.keys());
  const widenedPool = rankedPool.some((item) => item.explicit)
    ? rankedPool
    : [...rankedPool.slice(0, 2), ...rankedPool.filter((item) => gateOpenedCodes.has(item.projectCode))];
  // ── 签字方案必须落到与它适应证相符的那个病机节点上（2026-08-12 线上抓到）─────────
  //
  // rankedPool 里同一个项目对**每个**病机节点各有一条候选，按适应证亲和度排序；
  // 下面的 flatMap 按 projectCode 去重，只留分最高的那条。于是当 M03 写出两个节点时：
  //   P1 风寒犯肺，肺气失宣，上逆为咳    ← 呼吸
  //   P2 风寒束表，卫阳被遏，经气不利    ← 表证/经气
  // 亲和度把针刺打在 P2 上，而模板 indicationTag=respiratory 与 P2 不符，
  // governedTcmTreatmentPlanTemplate 里的 preciseFitsNode 判 false，
  // **那条已签字的取穴方案被整条丢弃**、退回泛化召回（承灵/孔最/肩中俞）。
  // 实测：M03 写一个节点时必成，写两个节点时必败——甲方两次反馈的正是后一种。
  //
  // 修法只在**同一个项目内部**换掉 targetRef，不动任何跨项目的次序与分数：
  // 闸门已开的项目，改用「节点标签含模板适应证」的那条候选。找不到相符节点时不做任何事
  // （维持原状、照旧走评估态），绝不把方案硬挂到一个对不上的节点上。
  const nodeTagsOf = (targetRef: string) => {
    const node = nodeById.get(targetRef);
    return node ? nodeIndicationTags(prior, node, currentFactFallback) : new Set<string>();
  };
  // **模型显式提名的节点不动**：它是一次临床选择——「这一针要治他的颈痛」——
  // 不是排序副产物。咳嗽合并颈项痹阻的病例里，模型把针刺提名到颈痛节点是对的，
  // 此时既有的 preciseFitsNode 正好挡住「颈痛卡片发出肺系取穴」，那条保护必须保留。
  // 只有在没人显式选过节点、由亲和度自己挑的时候，才把它纠到模板适应证相符的那个节点。
  const preferredRefByCode = new Map<TcmTreatmentProjectCode, string>();
  for (const [code, tag] of gateTagByCode) {
    if (widenedPool.some((item) => item.projectCode === code && item.explicit)) continue;
    const fitting = widenedPool.find((item) => item.projectCode === code && nodeTagsOf(item.targetRef).has(tag));
    if (fitting) preferredRefByCode.set(code, fitting.targetRef);
  }
  const proposalPool = widenedPool.filter((item) => {
    const preferred = preferredRefByCode.get(item.projectCode);
    return preferred === undefined || item.targetRef === preferred;
  });

  const compiled = proposalPool.flatMap((proposal) => {
    if (seen.has(proposal.projectCode)) return [];
    const capability = capabilityByCode.get(proposal.projectCode);
    const definition = getTcmTreatmentProjectDefinition(proposal.projectCode);
    const node = nodeById.get(proposal.targetRef);
    if (!capability || !definition || !node) return [];
    seen.add(proposal.projectCode);
    const clinicAvailable = capability.deliveryMode === "onsite";
    const specialist = definition.risk === "specialist";
    const medicationAssessment = definition.requiresMedicationAudit
      ? "含药外治仅作项目适应证评估；本模块不生成药物配方、操作参数或疗程，拟采用产品或处方须另行完成独立用药审方。"
      : undefined;
    const assessmentPositioning = specialist
      ? "仅建议由具备专项资质的医生进行适应证与可行性评估，不形成操作医嘱。"
      : medicationAssessment || (!clinicAvailable
        ? "当前仅作转介或现场评估方向，不代表本机构可开展。"
        : undefined);
    const matchedIndicationTags = nodeIndicationTags(prior, node, currentFactFallback);
    const signedSyndromeText = [prior.overview.primarySyndrome, ...(Array.isArray(prior.overview.secondarySyndromes) ? prior.overview.secondarySyndromes : [])]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("；");
    // 灸法卡与证候相反时整张不出（2026-10-17 留出例 S067：湿热石淋拿到「常规灸法，多用于膏淋、劳淋」）。此前只去卡里说灸的句子，
    // 整张灸法卡每句都说灸，去完为空又退回原文。
    if (definition.code === "moxibustion" && moxibustionUnsuitableForSyndrome(signedSyndromeText, prior.therapy?.overallMethod || "")) return [];
    // 拔罐、刮痧是以泻为主的操作，纯虚证整张不出（2026-10-18 甲方病历 6：肾阴虚腰痛三次生成都给了拔罐/走罐，教材腰痛节只对寒湿、瘀血腰痛加拔罐）。
    // 虚实夹杂、实证照常。与灸法、刺络用同一个虚实判据。
    if ((definition.code === "cupping" || definition.code === "guasha") && signedSyndromeDeficiencyExcess(signedSyndromeText) === "deficiency") return [];
    const { planOrigin, ...plannedRaw } = controlledTreatmentPlan(
      definition.code,
      matchedIndicationTags,
      node.pathogenesis || node.syndromeEvidence || prior.overview.overallPathogenesis,
      treatmentClinicalText(prior, node, caseFacts),
      caseFacts,
      // 证型加减只读**已签名结论**：证候名、总病机、治法与本节点病机/辨证依据/治法方向。
      // 病历原文（caseFacts）刻意排除——「淋雨受寒」不等于辨证结论是风寒束表。
      [
        prior.overview.primarySyndrome,
        prior.overview.overallPathogenesis,
        prior.therapy.overallPrinciple,
        prior.therapy.overallMethod,
        node.pathogenesis,
        node.syndromeEvidence,
        node.therapyDirection,
      ].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("；"),
      // 精确证型闸门与条件加穴只读**当前**事实：treatmentCaseFacts 含既往史/用药史/过敏史，
      // 用它会让「既往咳嗽」把本例带进普通风寒咳嗽模板——中医师裁定里点名要排除这一情形。
      currentFacts,
      // 闸门的第二把钥匙只认**结论性**证候名，不认病机链/辨证依据/治法方向这些叙述文本。
      prior.overview.primarySyndrome || "",
      treatmentPatientAgeYears(caseState),
      // 教材方案取材：已签名的中医病名、西医主诊断，以及主证+兼证结论（证型配穴/选方只读它）。
      {
        diseaseNames: [prior.overview.tcmDiseaseName || ""].filter(Boolean),
        westernNames: [prior.westernDiagnosis?.primary?.name || ""].filter(Boolean),
        signedSyndromeText,
        signedPrinciple: prior.therapy?.overallPrinciple || "",
        signedMethod: prior.therapy?.overallMethod || "",
        chiefComplaint: typeof caseState?.chiefComplaint === "string" ? caseState.chiefComplaint : "",
        avoidRichFood: dietAdviceAvoidsRichFood(dietAdvice),
        // 糖尿病读病历全部阳性面（含既往史）与已签名病名：糖尿病多写在既往史里（M-TCMChat-test-405）。
        recordedDiabetes: RECORDED_DIABETES.test([caseFacts, prior.overview.tcmDiseaseName || "", prior.westernDiagnosis?.primary?.name || ""].join("；")),
        avoidTea: dietAdviceAvoidsTea(`${dietAdvice}；${precautionText}`),
        herbAlreadyPrescribed: prescribedIdentities.size > 0 ? (herb: string) => prescribedIdentities.has(canonicalTcmHerbIdentity(herb)) : undefined,
        prescribedHerbNames,
        // 辨病、辨证依据原文：教材同节分型的病（淋证六淋…）里，型写在依据中（「故属石淋湿热蕴结证」），针刺卡「本例属X」以它为准。
        signedRationale: [prior.overview.tcmDiseaseRationale, prior.overview.tcmDiagnosticRationale]
          .filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("；"),
      },
    );
    // 囟门未闭（2 岁以下，或病历写明）的患儿，针刺卡不列头顶部腧穴：卡上同时写着「囟门未闭者头顶部腧穴不针」又列着百会、四神聪，自相矛盾。
    const plannedTreatment = openFontanelleAvoidsVertex(definition.code, patientAgeYears, currentFacts) ? withoutVertexPoints(plannedRaw) : plannedRaw;
    // 教材卡与院内目录卡在这里过同一道：针刺的补泻手法与已签名证候相符（失眠模板写的是「留针用补法」），
    // 疗程栏与操作栏不写流程用语（「复评」「课程索引」「由现场医师复核」）。
    // 写给别的证型的句子、阴虚热证里建议用灸的句子也在这里去掉（cardSentencesMatchedToSyndrome），治疗内容栏同样过这一道。
    const diseaseNamesForCard = [prior.overview.tcmDiseaseName || ""].filter(Boolean);
    const course = caseCourse([prior.westernDiagnosis?.primary?.name || ""], typeof caseState?.chiefComplaint === "string" ? caseState.chiefComplaint : "");
    const cardSentences = (value: string) => cardSentencesMatchedToSyndrome(value, diseaseNamesForCard, signedSyndromeText, course);
    // 只用于针刺卡：穴位栏就是本例的取穴处方。推拿卡的操作是一整套教材手法，穴位栏只列主穴，不能按它删步骤。
    const cardPoints = definition.code === "acupuncture" && Array.isArray(plannedTreatment.suggestedSitesOrPoints)
      ? plannedTreatment.suggestedSitesOrPoints.filter((point): point is string => typeof point === "string")
      : [];
    const reproductiveRelevant = caseState?.patient ? reproductiveAdviceRelevant(caseState as CaseState) : true;
    const cardText = (value: string) => cardTextForPopulation(clinicalTreatmentScheduleWording(cardSentencesNamingListedPoints(cardSentences(
      definition.code === "acupuncture" ? manipulationMatchedToSyndrome(value, signedSyndromeText, prior.therapy?.overallPrinciple || "") : value), cardPoints)), reproductiveRelevant);
    // 卡片写明只适用于本病另几个类型、本例的证不在其中时整张不出（cardApplicabilityExcludesSyndrome）。
    if ([plannedTreatment.treatmentContent, plannedTreatment.techniqueBoundary]
      .some((value) => typeof value === "string" && cardApplicabilityExcludesSyndrome(value, diseaseNamesForCard, prior.overview.primarySyndrome || ""))) return [];
    // 病历写到皮肤破损时卡上会写「局部皮肤破损…处不施术，取穴避开皮损」（localSiteCardNote），同一张卡就不能再取「阿是穴」（2026-10-19
    // 留出例 S143 丹毒：针刺卡列着阿是穴）。围刺（蛇串疮「皮损局部阿是穴围刺」）本来就是在皮损周围下针，不在此列。
    // 已签名诊断写到骨折（含「待查」）：卡上写着「骨折及其周围肿胀处不施术」（localSiteCardNote），取局部（阿是穴、局部、患处）的针、灸、罐、
    // 刮痧卡与这句相抵——伤处取阿是穴、申脉、丘墟并「针刺时配合踝关节活动」（2026-10-19 Claude 评审 H-tri-3960 踝部骨折），腰椎压缩性骨折
    // 拔罐取肾俞、大肠俞、阿是穴并「可行刺络拔罐」（M-TCMChat-test-375）。这类卡整张不出；只取远端穴、不在伤处施术的卡与耳穴卡照出。
    const signedDiagnosisNames = [prior.overview.tcmDiseaseName || "", prior.westernDiagnosis?.primary?.name || ""];
    const treatsLocalSite = cardTreatsLocalSite(plannedTreatment.suggestedSitesOrPoints, `${plannedTreatment.treatmentContent || ""}${plannedTreatment.techniqueBoundary || ""}`);
    if (LOCAL_SITE_NOTE_PROJECTS.has(definition.code) && fractureSigned(signedDiagnosisNames) && treatsLocalSite) return [];
    // 面部疮疡（鼻旁颊部丹毒、疔疖）同样不在疮疡处下针（2026-10-19 Claude 评审 H-tri-17402：卡仍取阿是穴）。只管取局部的卡：
    // 不寐卡不因病历顺带写了「面部偶发痤疮」就印面部皮损的提示。
    const facialSore = treatsLocalSite && facialSoreRecorded(currentFacts, signedDiagnosisNames);
    const lesionPointAvoided = LOCAL_SITE_NOTE_PROJECTS.has(definition.code) &&
      (BROKEN_SKIN_RECORDED.test(currentFacts) || facialSore) &&
      !/围刺/.test(`${plannedTreatment.treatmentContent || ""}${plannedTreatment.techniqueBoundary || ""}`);
    // 未经影像评估的乳房肿块（unevaluatedBreastMass，与安全门的优先评估同一判据）：不在乳房局部施术——针刺卡去掉胸前乳房周围的穴，
    // 取局部的其他外治卡整张不出（2026-10-24 C069：乳根、膻中「向肿块方向斜刺」，评审要求先完成影像排除恶性）。
    const breastMassAvoided = Boolean(caseState?.patient) && unevaluatedBreastMass(caseState as CaseState);
    if (breastMassAvoided && definition.code !== "acupuncture" && LOCAL_SITE_NOTE_PROJECTS.has(definition.code) && treatsLocalSite) return [];
    const sitesWithoutLesion = Array.isArray(plannedTreatment.suggestedSitesOrPoints)
      ? plannedTreatment.suggestedSitesOrPoints.filter((site) => {
        const point = String(site).replace(/（[^）]*）\s*$/, "").trim();
        return !(lesionPointAvoided && LESION_POINT.test(point)) && !(breastMassAvoided && (BREAST_REGION_POINTS.has(point) || LESION_POINT.test(point)));
      })
      : plannedTreatment.suggestedSitesOrPoints;
    if ((lesionPointAvoided || breastMassAvoided) && Array.isArray(plannedTreatment.suggestedSitesOrPoints) && plannedTreatment.suggestedSitesOrPoints.length > 0 &&
      (sitesWithoutLesion || []).length === 0) return [];
    const lesionText = (value: string) => {
      const withoutLesion = lesionPointAvoided ? withoutLesionPointMention(value) : value;
      return breastMassAvoided ? withoutBreastRegionPointSentences(withoutLesion) : withoutLesion;
    };
    const treatmentPlan = {
      ...plannedTreatment,
      ...(lesionPointAvoided || breastMassAvoided ? {
        suggestedSitesOrPoints: sitesWithoutLesion,
        ...(Array.isArray(plannedTreatment.pointProvenance)
          ? { pointProvenance: plannedTreatment.pointProvenance.filter((record) => !LESION_POINT.test(String(record.point || "")) && !(breastMassAvoided && BREAST_REGION_POINTS.has(String(record.point || "")))) }
          : {}),
      } : {}),
      ...(typeof plannedTreatment.treatmentContent === "string" ? { treatmentContent: lesionText(cardSentences(plannedTreatment.treatmentContent)) } : {}),
      ...(typeof plannedTreatment.techniqueBoundary === "string" ? { techniqueBoundary: lesionText(cardText(plannedTreatment.techniqueBoundary)) } : {}),
      ...(typeof plannedTreatment.scheduleSuggestion === "string" ? { scheduleSuggestion: cardText(plannedTreatment.scheduleSuggestion) } : {}),
    };
    // 卡片的「对应病机」跟着方案实际治的那个节点走（2026-10-19 甲方病历 10：月经先期·阳盛血热，耳穴卡写「热扰心神，神不守舍」、
    // 针刺卡写「肝胆热盛，灼伤津液」，取的却都是月经不调节的冲任穴）。教材方案按本病与本例证候取穴，不按节点，治的是核心病机 P1
    //（首个节点：M03 要求它解释主诉主症，君药同样只能引用它）；目录模板按节点的适应证命中，仍落在原节点上。
    // 按证名概念重合挑节点试过两种，都未采用（P1 是 M03 合同定义的核心病机）：全节点比重合，76 张卡从 P1 挪走、多数更差
    //（鼻渊卡落到「风热袭表」、消渴卡落到「脾气不足」）；只在 P1 与证名毫不重合时挪，33 张，消渴「气阴两伤」认不出气阴概念被挪到「脾气不足」。
    // 病名写成两病并列（「不寐兼项痹」）时，教材方案只对得上其中一个病节，说不清它治的是哪个节点：仍用模型所选节点（test:tcm-treatments 颈肩节点推拿卡）。
    const singleSignedDisease = !/兼|合并|伴/.test(prior.overview.tcmDiseaseName || "");
    const primaryNodeId = chain.length > 0 ? (chain[0].nodeId || "P1") : undefined;
    const cardNodeId = planOrigin === "textbook" && singleSignedDisease && primaryNodeId && nodeById.has(primaryNodeId) ? primaryNodeId : proposal.targetRef;
    const cardNode = nodeById.get(cardNodeId) || node;
    return [{
      projectCode: definition.code,
      projectName: definition.name,
      availability: clinicAvailable ? "clinic_available" as const : "referral_only" as const,
      riskLevel: definition.risk,
      recommendationMode: specialist ? "specialist_assessment_only" as const : clinicAvailable ? "clinician_assessment" as const : "referral_assessment" as const,
      targetRef: cardNodeId,
      targetPathogenesis: cardNode.pathogenesis || cardNode.syndromeEvidence || prior.overview.overallPathogenesis,
      ...(assessmentPositioning ? { assessmentPositioning } : {}),
      ...treatmentPlan,
      // 小儿针刺的通行要求（《针灸学》刺法注意事项：小儿不能配合，不宜留针；囟门未闭者头顶部腧穴不宜针刺）。
      // 取穴方案出自成人教材，写法是「毫针常规刺，留针」——2026-10-13 独立评审：2 岁、7 岁、11 岁病例照搬成人写法。
      // 小儿、老年与妊娠未写明的人群提示：所有项目卡同一处（populationCardNote）。此前只有针刺卡有小儿、老年两句。
      ...(() => {
        const note = `${populationCardNote(definition.code, patientAgeYears, caseState?.patient ? homeCarePregnancyUnresolved(caseState) && pregnancyAdviceRelevant(caseState as CaseState) : false, treatmentPlan.suggestedSitesOrPoints, caseState?.patient ? conceptionCardCaution(caseState) : false)}${fontanelleCardNote(definition.code, patientAgeYears, currentFacts)}${localSiteCardNote(definition.code, currentFacts, [prior.overview.tcmDiseaseName || "", prior.westernDiagnosis?.primary?.name || ""], treatsLocalSite)}${breastMassAvoided && LOCAL_SITE_NOTE_PROJECTS.has(definition.code) ? "乳房肿块性质未明（尚未完成影像评估）前，不在乳房及肿块局部施术。" : ""}${moxibustionBurnCardNote(definition.code, caseFacts, `${treatmentPlan.treatmentContent || ""}${treatmentPlan.techniqueBoundary || ""}${treatmentPlan.scheduleSuggestion || ""}`)}`;
        return typeof treatmentPlan.techniqueBoundary === "string" && note
          ? { techniqueBoundary: `${note}${treatmentPlan.techniqueBoundary}` }
          : {};
      })(),
      operatorRequirement: definition.operatorRequirement,
      requiredChecks: [
        cardTextForPopulation(definition.safetyFocus, reproductiveRelevant),
        ...(definition.requiresMedicationAudit ? ["含药外治采用前须完成成分、过敏、禁忌、相互作用及重复用药的独立用药审方。"] : []),
      ],
      containsMedication: definition.containsMedication,
      requiresMedicationAudit: definition.requiresMedicationAudit,
      // Even a complete governed template is an advisory draft. Only a licensed clinician may turn
      // it into an executable order after patient-specific examination and contraindication review.
      executable: false,
      clinicianReviewRequired: true as const,
    }];
  });
  // ── 名额只有 3 个：给不出方案的项目不得把给得出方案的挤掉（甲方 2026-08-12）────────
  //
  // 实测（42 岁男性，普通风寒咳嗽，已签名「风寒袭肺证」）：页面上三个项目是
  // 气功导引（穴位为空）、灸法（泛化召回 承灵/孔最/肩中俞）、拔罐（病种模板未按证型加减），
  // 唯独没有针刺——而针刺排第 4，被这里的截断切掉了。它是本例**唯一**一个
  // governed_patient_specific_plan：中医师已签字、已按本例证型加减，取穴为
  // 肺俞、中府、列缺、太渊、风门、合谷（甲方点名要的列缺就在其中）。
  //
  // 根因是排序只按适应证亲和度分数，完全不看「这个项目对本例究竟能不能给出方案」。
  // 于是一个连一个穴位都给不出的评估态项目，把唯一能给出完整签字取穴方案的项目挤出了名额。
  //
  // 修法不新增任何项目、不放宽任何闸门、不改亲和度分数，**也不改次序口径**：
  // 成熟度只决定「谁占得到这 3 个名额」（已签字的患者级方案 > 病种标准模板 > 仅评估），
  // 名额内的先后仍由适应证亲和度控制——那是既有的、有测试钉着的原则
  //（test:tcm-treatment-projects「clinical fit ranks ahead of clinic display priority」）。
  // 所以这不是"把针刺特殊照顾"，而是"名额优先给能拿出东西的那个"，对全部病种一视同仁。
  const PROTOCOL_MATURITY: Readonly<Record<string, number>> = {
    governed_patient_specific_plan: 0,
    governed_class_template_not_syndrome_tailored: 1,
  };
  const maturityOf = (status: unknown) => PROTOCOL_MATURITY[String(status || "")] ?? 2;
  // 交付面会去掉的卡（仅评估、无穴的类目模板、只有一段治则的模板）不先占名额（2026-10-19：此前推拿「治则：…」卡占了第三个名额、
  // 交付时又被去掉，腰痛病例的教材耳穴卡因此消失；郁证病例的灸法卡也是这样「意外」出不来）。判据见 treatmentCardUndeliverable。
  const selected = new Set(
    compiled
      .map((item, index) => ({ item, index }))
      .sort((left, right) =>
        Number(treatmentCardUndeliverable(left.item)) - Number(treatmentCardUndeliverable(right.item)) ||
        maturityOf(left.item.protocolStatus) - maturityOf(right.item.protocolStatus) || left.index - right.index)
      .slice(0, 3)
      .map((entry) => entry.index),
  );
  return compiled.filter((_, index) => selected.has(index));
}

/**
 * 交付面（delivered-surface.ts）不下发的项目卡：仅评估态；食疗、导引、情志这类无穴项目只有类目模板而无内容；
 * 病种模板的内容只是一段「治则：…」。出卡处排名额用同一判据（交付面那边是这三条的原样副本，2026-10-19 起应改为调用本函数）。
 */
export function treatmentCardUndeliverable(item: { projectCode?: unknown; protocolStatus?: unknown; tailoringStatus?: unknown; suggestedSitesOrPoints?: unknown; treatmentContent?: unknown }): boolean {
  if (item.protocolStatus === "assessment_only_no_patient_specific_protocol" || item.tailoringStatus === "assessment_only") return true;
  const points = Array.isArray(item.suggestedSitesOrPoints) ? item.suggestedSitesOrPoints.length : 0;
  const pointFree = item.projectCode === "diet_therapy" || item.projectCode === "qigong_daoyin" || item.projectCode === "mind_therapy";
  if (pointFree && points === 0 && item.tailoringStatus === "class_template_only") return true;
  return item.tailoringStatus === "class_template_only" && /^治则[:：]/.test(String(item.treatmentContent || "").trim());
}

// 艾灸的烫伤风险另算：糖尿病与感觉减退者对热不敏感，体温升高时不宜温灸（《护理人员中医技术使用手册》悬灸禁忌）。
// 只读确定性肯定句（treatmentCaseFacts 已剔除否认与既往），闭集词与数值阈值。
const MOXIBUSTION_BURN_RISK = /糖尿病|消渴|感觉(?:减退|迟钝|障碍|异常)|周围神经病变/;
/** 病历记有糖尿病（含消渴病名）：食疗卡按《成人糖尿病食养指南（2023年版）》选方（recipeUnsuitableForDiabetes）。 */
const RECORDED_DIABETES = /糖尿病|消渴/u;

// 需要筛查妊娠的患者（与安全门同一判据 pregnancyScreenRequired：育龄女性、未写明已绝经或无子宫）
// 没有写明否认妊娠时，居家保健按妊娠禁忌从严去掉禁用穴与腹部、腰骶部穴位。
function homeCarePregnancyUnresolved(caseState: Partial<TreatmentCaseContext>): boolean {
  if (!pregnancyScreenRequired(caseState as CaseState)) return false;
  return assessPregnancyState(treatmentPregnancyText(caseState)).status !== "negative";
}

/**
 * 备孕（未避孕、计划妊娠）而未妊娠、未哺乳：与开方同一判据 conceptionWithoutPregnancyOrLactation（2026-10-14 owner 决定，
 * 孕妇慎用药照给、注明「使用前请确认未妊娠，月经逾期者先验孕」）。项目卡上的孕期慎用穴同样注明（2026-10-19 留出例 S102：
 * 未避孕1年、末次月经50天前，取三阴交、气海、归来无一句提示；就诊时的尿妊娠试验阴性管不到疗程中的妊娠）。
 */
function conceptionCardCaution(caseState: Partial<TreatmentCaseContext>): boolean {
  if (!pregnancyScreenRequired(caseState as CaseState)) return false;
  return conceptionWithoutPregnancyOrLactation(treatmentPregnancyText(caseState));
}

function homeAcupointCareForCase(
  prior: ClinicalReasoningResultV2,
  caseState: Partial<TreatmentCaseContext> | undefined,
  recommendations: ReadonlyArray<{ projectCode: string; suggestedSitesOrPoints?: string[] }>,
  authored?: AuthoredHomeAcupoint,
): string | null {
  const template = homeAcupointTemplateForCase(prior, caseState, recommendations);
  // 技术规范段落给得出（安全门、年龄、妊娠、项目禁忌都过了）而且是成人时，用模型按本例选的穴（home-acupoint-authoring.server.ts）；
  // 模型那份不可用或穴位都已在医师项目里时仍用段落。艾灸只在段落本身也给艾灸时写。
  if (!template || !authored) return template;
  const ageYears = caseState ? treatmentPatientAgeYears(caseState) : undefined;
  if (ageYears == null || ageYears < 18) return template;
  return renderAuthoredHomeAcupointCare(authored, {
    clinicianPointText: recommendations.flatMap((item) => item.suggestedSitesOrPoints || []).join("、"),
    moxibustionAllowed: template.includes("艾灸"),
  }) || template;
}

/**
 * 模型选穴的输入（路由在开方一开始就发出请求，与 M04 生成并行）：技术规范段落在本例给得出、且是成人时才有；
 * 段落给不出（红旗、儿童、妊娠阳性或可疑、项目禁忌、证候对不上体质）时返回 undefined，不发请求。
 */
export function homeAcupointAuthoringInputForCase(
  prior: ClinicalReasoningResultV2 | null | undefined,
  caseState: Partial<TreatmentCaseContext> | undefined,
  findings: readonly string[],
): HomeAcupointAuthoringInput | undefined {
  if (!prior || !caseState) return undefined;
  const ageYears = treatmentPatientAgeYears(caseState);
  if (ageYears == null || ageYears < 18) return undefined;
  const template = homeAcupointTemplateForCase(prior, caseState, []);
  if (!template) return undefined;
  const overview = prior.overview;
  return {
    disease: String(overview?.tcmDiseaseName || ""),
    primarySyndrome: String(overview?.primarySyndrome || ""),
    secondarySyndromes: (overview?.secondarySyndromes || []).map((item) => String(item || "")).filter(Boolean),
    method: String(prior.therapy?.overallMethod || ""),
    findings: [...new Set(findings.map((item) => item.trim()).filter(Boolean))].slice(0, 12),
    ageYears,
    sex: String((caseState as { patient?: { sex?: unknown } }).patient?.sex || ""),
    pregnancyUnresolved: homeCarePregnancyUnresolved(caseState),
    moxibustionAllowed: template.includes("艾灸"),
  };
}

function homeAcupointTemplateForCase(
  prior: ClinicalReasoningResultV2,
  caseState: Partial<TreatmentCaseContext> | undefined,
  recommendations: ReadonlyArray<{ projectCode: string; suggestedSitesOrPoints?: string[] }>,
): string | null {
  if (!caseState) return null;
  const temperature = Number.parseFloat(String(caseState.vitals?.T ?? "").replace(/[^\d.]/g, ""));
  const ageYears = treatmentPatientAgeYears(caseState);
  // 0～36 月龄的居家按揉是《0～36个月儿童中医药健康管理服务技术规范》给健康儿童的保健（按月龄取迎香、足三里、四神聪…），
  // 不是本次疾病的治疗：急性发热期不给（2026-10-19，验收集 H-tri-597：3 岁肺炎喘嗽高热，唯一的治疗内容是「按揉四神聪」）。
  if (ageYears != null && ageYears <= 3 && ((Number.isFinite(temperature) && temperature >= 37.3) || /发热|高热|壮热|身热/.test(
    // 手足心热、五心烦热这类局部或自觉的热不是发热（2026-10-19：3 岁厌食「手足心发热」被当作发热）。
    treatmentCurrentFacts(caseState).replace(/(?:手足心|五心|手心|足心|心口|胸口|局部|关节)[^，,。；;]{0,2}热/g, "")))) return null;
  return compileHomeAcupointCare({
    prior,
    safetyGate: caseState.safetyGate,
    ageYears,
    acupressureExclusion: tcmTreatmentProjectExclusionReason("tuina", prior, caseState),
    moxibustionExclusion: tcmTreatmentProjectExclusionReason("moxibustion", prior, caseState),
    moxibustionBurnRisk: MOXIBUSTION_BURN_RISK.test(treatmentCaseFacts(caseState)) ||
      (Number.isFinite(temperature) && temperature >= 37.3),
    clinicianPointText: recommendations.flatMap((item) => item.suggestedSitesOrPoints || []).join("、"),
    clinicianMoxibustion: recommendations.some((item) => item.projectCode === "moxibustion"),
    pregnancyUnresolved: homeCarePregnancyUnresolved(caseState),
  });
}

export const ELDERLY_ACUPUNCTURE_AGE_YEARS = 65;
export const ELDERLY_ACUPUNCTURE_NOTE = "老年人针刺量宜小：取穴少而精、浅刺、手法宜轻、留针时间宜短，取卧位，留针期间注意观察以防晕针。";

/**
 * 项目卡的人群提示（2026-10-18 起所有项目卡同一处；此前只有针刺卡有小儿、老年两句，7 岁患儿的拔罐卡、耳穴卡照搬成人写法——
 * 留出例 S151；育龄女性妊娠未写明时，针刺卡取合谷、三阴交也没有任何提示——S144 一类）。
 *  · 小儿（未满 12 岁）与老年（65 岁起）：《针灸学》「久病、体质虚弱者和老人、儿童，针灸治疗量宜小，宜选用卧位」；
 *    T/CACM 1560.3—2023「年老、虚弱、严重消瘦者，拔罐时间宜短」；《刺法灸法学》晕针预防「取穴宜精，手法宜轻」。
 *  · 妊娠未写明的育龄女性：卡上有教材穴位目录标为孕妇禁用/慎用、或定位在脐下小腹、骶部的穴位时（acupointPregnancySensitive），
 *    提示先告知是否可能怀孕；妊娠阳性或可疑时这些项目在项目级禁忌里已整张去掉。
 */
const PEDIATRIC_CARD_NOTE: Partial<Record<string, (ageYears: number) => string>> = {
  acupuncture: (age) => `小儿针刺宜浅刺、快出针，一般不留针，手法宜轻；${age < 2 ? "囟门未闭者头顶部腧穴不针；" : ""}不能配合者改用小儿推拿或穴位贴敷。`,
  cupping: () => "小儿拔罐治疗量宜小：选小号罐，吸拔力宜轻，留罐时间宜短，由成人陪护，防止烫伤和皮肤损伤。",
  auricular: () => "小儿耳穴宜用贴压（如王不留行籽），不用毫针，按压手法宜轻。",
  moxibustion: () => "小儿施灸治疗量宜小，须由成人看护，以局部温热为度，防止烫伤。",
  guasha: () => "小儿刮痧手法宜轻、时间宜短，以皮肤微红为度，不强求出痧。",
};
const ELDERLY_CARD_NOTE: Partial<Record<string, string>> = {
  acupuncture: ELDERLY_ACUPUNCTURE_NOTE,
  cupping: "老年人拔罐吸拔力宜轻、留罐时间宜短，皮肤松弛或有破损处不拔。",
  moxibustion: "老年人对热的感觉较迟钝，施灸时注意温度，防止烫伤。",
  guasha: "老年人刮痧手法宜轻、时间宜短，以皮肤微红为度。",
};
/**
 * 病历写到局部皮肤破损、流脓或骨折时，针、灸、罐卡上写明避开这些部位（2026-10-19，验收集 H-tri-4189：颜面多处流脓结痂、
 * 形成窦道的痤疮病例，针刺卡取阳白、四白而无一句提示；M-TCM-SD-439348：胫骨骨折伴小腿擦伤，局部阿是穴无提示）。
 * 依据《刺法灸法学》针刺注意事项「皮肤有感染、溃疡、瘢痕或肿瘤的部位不宜针刺」与拔罐、施灸的同类禁忌。只读本例肯定句。
 */
const BROKEN_SKIN_RECORDED = /流脓|窦道|破溃|溃烂|擦伤|渗液|皮损破/;
/** 胸前乳房周围的穴（足阳明、足太阴、足少阴、任脉在胸部第 2–6 肋间的穴与乳中、乳根）：乳房肿块未经评估时针刺卡不取。 */
const BREAST_REGION_POINTS = new Set(["乳中", "乳根", "膺窗", "屋翳", "库房", "气户", "天池", "天溪", "食窦", "胸乡", "周荣", "膻中", "神封", "灵墟", "步廊", "神藏", "期门"]);
/** 卡片文字里点到上面这些穴的句子去掉（「乳根、膻中向肿块方向斜刺」）。 */
function withoutBreastRegionPointSentences(text: string): string {
  const sentences = text.split(/(?<=[。；;])/u);
  const kept = sentences.filter((sentence) => ![...BREAST_REGION_POINTS].some((point) => sentence.includes(point)) && !/肿块|结节局部|患处/u.test(sentence));
  return kept.length > 0 ? kept.join("") : text;
}
/** 「阿是穴」「局部阿是穴」：取的就是病痛（皮损）所在处。 */
const LESION_POINT = /^(?:局部)?阿是穴$/;
/** 卡片文字里列举的「阿是穴」去掉（「取肾俞、大肠俞、阿是穴」「阿是穴、委中可用三棱针点刺出血」），不动其他穴名。 */
function withoutLesionPointMention(text: string): string {
  return text.replace(/、(?:局部)?阿是穴(?=[、，,。；;\s]|$)/gu, "").replace(/(?:局部)?阿是穴、/gu, "");
}
const LOCAL_SITE_NOTE_PROJECTS = new Set(["acupuncture", "moxibustion", "cupping", "guasha"]);
/** 已签名诊断名写到骨折（含「待查」；「排除骨折」不算）。只认诊断名：「X线排除骨折」「2个月前颅骨骨折」不是本次的骨折部位。 */
export function fractureSigned(diagnosisNames: readonly string[]): boolean {
  return diagnosisNames.some((name) => /骨折/u.test(name) && !/排除|除外|不考虑/u.test(name));
}
/** 卡片取的是病痛局部（阿是穴、局部、患处、伤处、压痛点）。 */
export function cardTreatsLocalSite(points: unknown, text: string): boolean {
  const names = Array.isArray(points) ? points.map((point) => String(point).replace(/（[^）]*）\s*$/u, "").trim()) : [];
  return names.some((name) => LESION_POINT.test(name) || /局部|患处|伤处|痛点/u.test(name)) ||
    /阿是穴|患处|患部|伤处|压痛点|局部(?:取穴|施|穴)/u.test(String(text || ""));
}
export function localSiteCardNote(code: string, currentFacts: string, diagnosisNames: readonly string[] = [], treatsLocalSite = true): string {
  if (!LOCAL_SITE_NOTE_PROJECTS.has(code)) return "";
  const notes: string[] = [];
  if (BROKEN_SKIN_RECORDED.test(currentFacts)) notes.push("局部皮肤破损、流脓或擦伤处不施术，取穴避开皮损。");
  else if (treatsLocalSite && facialSoreRecorded(currentFacts, diagnosisNames)) notes.push("面部皮损处（鼻旁、口唇周围尤甚）不针刺、不挤压、不放血。");
  if (fractureSigned(diagnosisNames)) notes.push("骨折及其周围肿胀处不施术。");
  return notes.join("");
}

/**
 * 施灸的烫伤风险（2026-10-19 Claude 评审 H-tri-5395：腓总神经损伤、小腿外侧及足背皮肤感觉减退，灸法卡只有通用的「防烫伤」）。
 * 居家保健的艾灸在同一风险下整段不给（homeAcupointCareForCase 的 moxibustionBurnRisk），医师的灸法卡照给、但写明这一条。
 * 判据与居家保健同一个 MOXIBUSTION_BURN_RISK（本例肯定句，含既往史里的糖尿病）。针刺卡只在卡上仍写着施灸（温针灸、加灸）时提示。
 */
const MOXIBUSTION_CARD_WORDING = /温针灸|加灸|灸法|可灸|施灸|艾灸|悬灸|隔姜灸|温和灸/u;
export function moxibustionBurnCardNote(code: string, caseFacts: string, cardText: string): string {
  if (!MOXIBUSTION_BURN_RISK.test(String(caseFacts || ""))) return "";
  const text = String(cardText || "").replace(/《[^》]*》/gu, "");
  if (code !== "moxibustion" && !(code === "acupuncture" && MOXIBUSTION_CARD_WORDING.test(text))) return "";
  const diabetes = RECORDED_DIABETES.test(caseFacts);
  const sensory = /感觉(?:减退|迟钝|障碍|异常)|周围神经病变/u.test(caseFacts);
  const who = diabetes && sensory ? "本例有糖尿病及局部感觉减退" : diabetes ? "本例有糖尿病" : "本例有局部感觉减退";
  return `${who}，对热不敏感：施灸以施术者手感试温、时间宜短，${sensory ? "感觉减退处不直接施灸，" : ""}防止烫伤。`;
}

/**
 * 病历记有囟门未闭时，针刺卡写明头顶部腧穴不针（2026-10-19 晚，第九轮 WP9-D）。小儿针刺的通行提示只在 2 岁以下写「囟门未闭者头顶部腧穴不针」
 * （PEDIATRIC_CARD_NOTE，《针灸学》刺法注意事项）；这一轮五迟、五软接上了教材小儿脑性瘫痪节（主穴百会、风府、四神聪），H-tri-14474
 * 5 岁患儿病历写「囟门闭合不全」，卡上有百会、四神聪而无一句提示。2 岁以上病历写明囟门未闭的才补这一句；写法是有限闭集的构词式守卫
 * （囟门 + 未闭/未合/闭合不全/闭合延迟/迟闭/过大）。2 岁以下已有通行提示，不重复。
 */
const FONTANELLE_OPEN_RECORDED = /囟门(?:未闭|未合|闭合不全|闭合延迟|闭合迟缓|迟闭|不闭|过大|宽大|开大)/u;
/** 囟门区的头顶部腧穴（《经络腧穴学》：百会、前顶、囟会、上星、后顶、四神聪）。 */
const FONTANELLE_VERTEX_POINTS: ReadonlySet<string> = new Set(["百会", "四神聪", "前顶", "囟会", "上星", "后顶"]);
/** 2 岁以下（囟门通常未闭，与 PEDIATRIC_CARD_NOTE 同界），或 2～11 岁病历写明囟门未闭：针刺卡不列头顶部腧穴。 */
export function openFontanelleAvoidsVertex(code: string, ageYears: number | undefined, currentFacts: string): boolean {
  if (code !== "acupuncture" || ageYears == null || ageYears >= 12) return false;
  return ageYears < 2 || fontanelleCardNote(code, ageYears, currentFacts) !== "";
}
function withoutVertexPoints<T extends { suggestedSitesOrPoints?: unknown; pointProvenance?: unknown; treatmentContent?: unknown; techniqueBoundary?: unknown }>(plan: T): T {
  const plain = (value: unknown) => String(value || "").replace(/[（(][^）)]*[）)]/g, "").replace(/^双侧/u, "").trim();
  const sites = Array.isArray(plan.suggestedSitesOrPoints) ? plan.suggestedSitesOrPoints.filter((site) => !FONTANELLE_VERTEX_POINTS.has(plain(site))) : plan.suggestedSitesOrPoints;
  // 去掉头顶穴后一个穴也不剩，说明这张卡就是头顶取穴的方案：保持原样，由卡上的提示交医生判断（不把卡删成空）。
  if (Array.isArray(sites) && sites.length === 0) return plan;
  const stripTransfix = (text: unknown) => typeof text === "string" ? text.replace(/四神聪可向百会穴?透刺[。；;]?/gu, "") : text;
  return {
    ...plan,
    suggestedSitesOrPoints: sites,
    ...(Array.isArray(plan.pointProvenance)
      ? { pointProvenance: plan.pointProvenance.filter((record) => !FONTANELLE_VERTEX_POINTS.has(plain((record as { point?: unknown })?.point))) }
      : {}),
    treatmentContent: stripTransfix(plan.treatmentContent),
    techniqueBoundary: stripTransfix(plan.techniqueBoundary),
  };
}

export function fontanelleCardNote(code: string, ageYears: number | undefined, currentFacts: string): string {
  if (code !== "acupuncture" || ageYears == null || ageYears < 2 || ageYears >= 12) return "";
  return FONTANELLE_OPEN_RECORDED.test(String(currentFacts || "").normalize("NFKC")) ? "病历记有囟门未闭，头顶部腧穴不针。" : "";
}

export function populationCardNote(
  code: string,
  ageYears: number | undefined,
  pregnancyUnresolved: boolean,
  points: unknown,
  /** 备孕而未妊娠、未哺乳（conceptionCardCaution）。 */
  tryingToConceive = false,
): string {
  const notes: string[] = [];
  if (ageYears != null && ageYears < 12) notes.push(PEDIATRIC_CARD_NOTE[code]?.(ageYears) || "");
  if (ageYears != null && ageYears >= ELDERLY_ACUPUNCTURE_AGE_YEARS) notes.push(ELDERLY_CARD_NOTE[code] || "");
  const pointNames = Array.isArray(points) ? points.filter((point): point is string => typeof point === "string") : [];
  const sensitive = pregnancyUnresolved || tryingToConceive
    ? pointNames.map((point) => point.replace(/[（(][^）)]*[）)]/g, "").trim()).filter((point) => acupointPregnancySensitive(point))
    : [];
  // 卡上的孕期敏感穴全部列出：此前只列前 4 个，产后妊娠未明的卡上列着秩边、承山、昆仑、环跳，却漏了同卡配穴里的三阴交、至阴
  //（2026-10-19 Claude 评审 H-tri-830；验收集 19 张卡同样漏列）。卡片取穴至多 12 个，不必截断。
  const listed = [...new Set(sensitive)].join("、");
  if (sensitive.length > 0) {
    notes.push(tryingToConceive
      ? `备孕期间：${listed}孕期不宜针灸刺激，施术前请确认未妊娠，月经逾期者先验孕。`
      : `如有怀孕可能请先告知医生：${listed}孕期不宜针灸刺激。`);
  }
  return notes.filter(Boolean).join("");
}

/**
 * 注意事项里点名的治疗项目必须是本例实际给出的项目（2026-10-14 起在出卡处过滤；2026-10-17 起交付面再按最终卡片过一遍）。
 * 出卡之后交付面还会去掉给不出具体内容的卡（仅评估、无穴的类目模板），而注意事项是按出卡时的集合过滤的，
 * 于是「耳穴及导引治疗请按医护人员指导进行」「刮痧、针刺后注意保暖」留在了没有这些卡的病例上（甲方标准病历 2、9、10，独立评审）。
 * 判据只在这一处，出卡处与交付面共用。
 */

/** 注意事项里的治疗项目称呼 → 项目编码（项目目录是有限闭集；只收指向单一项目的说法）。 */
const PRECAUTION_TREATMENT_MENTIONS: ReadonlyArray<readonly [RegExp, readonly TcmTreatmentProjectCode[]]> = [
  [/针刺|扎针|毫针|电针/, ["acupuncture"]],
  [/针灸/, ["acupuncture", "moxibustion"]],
  [/艾灸|温灸|灸法|隔姜灸/, ["moxibustion"]],
  [/拔罐/, ["cupping", "bloodletting"]],
  [/刮痧/, ["guasha"]],
  [/耳穴|耳豆|压豆/, ["auricular"]],
  [/推拿/, ["tuina"]],
  [/穴位贴敷|敷贴/, ["acupoint_application"]],
  [/熏洗|坐浴/, ["fumigation_wash"]],
  [/药浴/, ["medicated_bath"]],
  [/埋线/, ["thread_embedding"]],
  // 「导引治疗」是项目；运动保健栏里的「可练八段锦」不是注意事项点名的治疗，不在此列。
  [/导引/, ["qigong_daoyin"]],
  // 「针刺与食疗须在专科评估后由医师安排」而本例没给食疗卡（2026-10-19 Claude 评审 H-tri-10295）。
  [/食疗/, ["diet_therapy"]],
];

export function precautionMentionsUndeliveredTreatment(line: unknown, delivered: ReadonlySet<string>): boolean {
  if (typeof line !== "string") return false;
  return PRECAUTION_TREATMENT_MENTIONS.some(([pattern, codes]) => pattern.test(line) && !codes.some((code) => delivered.has(code)));
}

/** 本例实际给出的项目：治疗卡的项目编码，加上居家穴位保健里的艾灸（「艾灸时注意防烫」说的是它）与按揉。 */
export function deliveredTreatmentCodes(treatments: ReadonlyArray<{ projectCode?: unknown }>, acupointCare: unknown): Set<string> {
  const care = typeof acupointCare === "string" ? acupointCare : "";
  return new Set<string>([
    ...treatments.flatMap((item) => typeof item.projectCode === "string" ? [item.projectCode] : []),
    ...(/灸/.test(care) ? ["moxibustion"] : []),
    // 居家按揉是患者自己做的穴位保健，不等于医师的推拿项目：「推拿后注意保暖」不因它成立（2026-10-17 甲方标准病历 4、6）。
    ...(/按揉|按压|按摩/.test(care) ? ["home_acupressure"] : []),
  ]);
}

export function applyTcmTreatmentCapabilityPriority(
  content: string,
  caseState?: Partial<TreatmentCaseContext>,
  prior?: ClinicalReasoningResultV2 | null,
  options?: { authoredHomeAcupoint?: AuthoredHomeAcupoint },
): string {
  const startMarker = "<!-- DIAGNOSIS_JSON_START -->";
  const endMarker = "<!-- DIAGNOSIS_JSON_END -->";
  const start = content.lastIndexOf(startMarker);
  const end = start >= 0 ? content.indexOf(endMarker, start + startMarker.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + startMarker.length, end).trim()) as ClinicalReasoningResultV2;
    if (reasoning.stage !== "prescribe") return content;
    const existingNonPharma = reasoning.nonPharma;
    const proposals = (existingNonPharma?.tcmTreatments || []).flatMap((item) =>
      isKnownTcmTreatmentProjectCode(item.projectCode) && /^P\d{1,2}$/.test(item.targetRef)
        ? [{ projectCode: item.projectCode, targetRef: item.targetRef }]
        : []
    );
    // 食疗卡要看本次的饮食调护与处方药味（2026-10-19 甲方病历 5：饮食栏「忌生冷肥甘」、处方有黄芪 20g）。
    const prescribedHerbNames = (reasoning.formula?.candidates?.[0]?.herbs || [])
      .map((herb) => String(herb?.name || "")).filter(Boolean);
    const precautionText = Array.isArray(existingNonPharma?.precautions)
      ? existingNonPharma!.precautions.filter((line): line is string => typeof line === "string").join("；")
      : "";
    const recommendations = compileTcmTreatmentRecommendations(proposals, prior, caseState, String(existingNonPharma?.diet || ""), prescribedHerbNames, precautionText);
    if (!existingNonPharma && recommendations.length === 0) return content;
    reasoning.nonPharma = existingNonPharma || {
      diet: "",
      lifestyle: "",
      emotion: "",
      acupointCare: null,
      tcmTreatments: [],
      precautions: [],
    };
    reasoning.nonPharma.tcmTreatments = recommendations;
    // 交付面会去掉的卡（仅评估、只有治则、无内容的类目模板）不算给出了（2026-10-19 甲方病历 5：78 岁虚劳，模型提名导引、灸法、推拿三项，
    // 编出来是两张仅评估卡和一张只有治则的推拿卡，交付时全被去掉；居家穴位保健却按这三张卡算「医师已在灸、已在按」，于是也是 null，
    // 三次生成中医治疗一栏全空）。居家保健去重与注意事项核对都只看会交付的卡。
    const deliverable = recommendations.filter((item) => !treatmentCardUndeliverable(item));
    // 穴位保健不收 M04 模型自己写的文字（会绕过禁忌核对）：成人由小模型从受治理穴位表里按本例选穴、写理由，服务端校验后排版
    //（home-acupoint-authoring.server.ts，路由预先发出、这里传入）；其余由技术规范段落确定性编译。红旗、不出剂量等安全门下为 null。
    reasoning.nonPharma.acupointCare = prior ? homeAcupointCareForCase(prior, caseState, deliverable, options?.authoredHomeAcupoint) : null;
    // 注意事项提到的治疗项目必须是本次确实给出的（2026-10-14 独立评审：写「耳穴及针刺治疗须由专业医师操作」，本例并没有针刺）。
    // 模型写注意事项时看到的是自己提名的项目，随后服务端按机构能力与禁忌重排、增删；提到已不在清单里的项目的那一条整条丢掉。
    // 居家穴位保健里的艾灸、按揉也算给出了（「艾灸时注意防烫」说的是它）。
    if (Array.isArray(reasoning.nonPharma.precautions)) {
      const delivered = deliveredTreatmentCodes(deliverable, reasoning.nonPharma.acupointCare);
      reasoning.nonPharma.precautions = reasoning.nonPharma.precautions
        .filter((line) => !precautionMentionsUndeliveredTreatment(line, delivered));
    }
    return `${content.slice(0, start + startMarker.length)}\n${JSON.stringify(reasoning)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

export function getTcmTreatmentProjectStatus() {
  const scope = deploymentCapabilityScope();
  return {
    catalogCount: TCM_TREATMENT_PROJECTS.length,
    capabilityMode: scope.mode,
    configurationValid: scope.valid,
    configuredCount: scope.items.length,
    onsiteCount: scope.items.filter((item) => item.deliveryMode === "onsite").length,
    items: scope.items.map((item) => {
      const definition = getTcmTreatmentProjectDefinition(item.projectCode)!;
      return {
        projectCode: item.projectCode,
        name: definition.name,
        deliveryMode: item.deliveryMode,
        priority: item.priority,
        riskLevel: definition.risk,
        containsMedication: definition.containsMedication,
        requiresMedicationAudit: definition.requiresMedicationAudit,
      };
    }),
    specialistProjectsRequireExplicitConfiguration: true,
    ...(scope.reason ? { reason: scope.reason } : {}),
  };
}
