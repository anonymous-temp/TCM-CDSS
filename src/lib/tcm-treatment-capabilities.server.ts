import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { resolveAcupoint, selectAcupointsForCaseTerms } from "./tcm-acupoints";
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
  governedTcmTreatmentPrecisePlanTemplate,
  governedTcmTreatmentConditionalPoints,
  type TcmTreatmentPlanTemplate,
  type TcmTreatmentProjectCode,
  type TcmTreatmentIndicationTag,
} from "./tcm-treatment-projects";
import { affirmedClinicalText, type AssistedNegationClauses } from "./clinical-polarity";
import { assessPregnancyState } from "./clinical-state";

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
  "allergyHistory" | "conversation"
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
function annotateGovernedAcupoint(projectCode: TcmTreatmentProjectCode, site: string): string {
  if (projectCode === "auricular") return site;
  const entry = resolveAcupoint(site);
  if (!entry) return site;
  const meridian = entry.meridian && entry.meridian !== entry.name ? `·${entry.meridian}` : "";
  return `${site}（${entry.code}${meridian}）`;
}

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
function indicationEvidenceTerms(tag: TcmTreatmentIndicationTag, caseFacts: string): string[] {
  const pattern = INDICATION_PATTERNS.find(([candidate]) => candidate === tag)?.[1];
  if (!pattern || !caseFacts) return [];
  const scan = new RegExp(pattern.source, `${pattern.flags.replace(/g/g, "")}g`);
  return [...new Set([...caseFacts.matchAll(scan)].map((match) => match[0]).filter(Boolean))].slice(0, 3);
}

/** 经络腧穴类项目才按穴位主治选穴；耳穴、推拿、拔罐等自成定位体系，不套用经穴目录。 */
function projectUsesMeridianAcupoints(projectCode: TcmTreatmentProjectCode): boolean {
  return projectCode === "acupuncture" || projectCode === "moxibustion" || projectCode === "acupoint_application";
}

/**
 * 选穴用的本例主症词。只取**已签名结论与病历原文**里出现的症状级词，不引入任何新断言：
 * 穴位是按主治匹配选出来的，匹配依据必须是本例真实记录的症状，否则又变成通用池。
 */
function acupointCaseTerms(clinicalText: string, caseFacts: string, targetPathogenesis: string): string[] {
  const source = [clinicalText, caseFacts, targetPathogenesis].filter(Boolean).join("；");
  if (!source) return [];
  const SYMPTOM_SCAN = /(?:恶寒|发热|头痛|头晕|眩晕|鼻塞|流涕|喷嚏|咽痛|咳嗽|气喘|胸痛|胸闷|心悸|失眠|健忘|多梦|自汗|盗汗|无汗|口渴|纳呆|食少|腹胀|腹痛|泄泻|便秘|呕吐|恶心|呃逆|水肿|尿频|尿急|癃闭|带下|痛经|月经不调|腰痛|膝痛|肩痛|颈痛|痹痛|麻木|抽搐|瘾疹|湿疹|瘙痒|目赤|耳鸣|耳聋|牙痛|口疮)/g;
  return [...new Set([...source.matchAll(SYMPTOM_SCAN)].map((match) => match[0]))];
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
): Pick<TreatmentRecommendation,
  "treatmentContent" | "suggestedSitesOrPoints" | "scheduleSuggestion" | "techniqueBoundary" |
  "protocolSource" | "protocolStatus" | "protocolGap" | "tailoringStatus" |
  "pointProvenance" | "sourceAuthorityTier" | "adjudicationStatus" | "deferredSyndromeRefinement" |
  "deferredGovernedTemplate"
> {
  const definition = getTcmTreatmentProjectDefinition(projectCode);
  // ── 精确证型模板优先（中医师 2026-08-11 裁定的落库方式）────────────────────────
  //
  // 裁定明确**不许**调整全局 upper_airway / respiratory 优先级：那会影响所有病例。
  // 改为在通用标签排序**之前**先试一道前置闸门，且闸门只对声明了 preciseSyndromeGate 的模板生效
  //（目前只有针刺的普通风寒咳嗽一条；构建期门禁钉住「只有针刺项目可以声明」）。
  //
  // 闸门要两把钥匙同时对上：当前咳嗽事实 + 已签名的风寒袭肺/风寒束肺；
  // 并显式排除流感、恢复期、风热——绝不把既有专项方案的适应证扩大过去。
  // 「流清涕」在这里只是**条件加穴**的触发词，不改变整例走哪条模板。
  const precise = governedTcmTreatmentPrecisePlanTemplate(projectCode, currentFacts, signedSyndromeText);
  const { tag, template: taggedTemplate } = resolveTreatmentIndication(projectCode, tags, clinicalText);
  const governedTemplate = precise.template || taggedTemplate;
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
    const matchedRefinement = governedTcmTreatmentSyndromeRefinement(governedTemplate, signedSyndromeText, caseFacts);
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
    const caseTerms = acupointCaseTerms(clinicalText, caseFacts, targetPathogenesis);
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
    const evidenceTerms = indicationEvidenceTerms(governedTemplate.indicationTag, caseFacts);
    const matchedTemplateTerms = governedTemplate.matchAny
      .filter((term) => clinicalText.normalize("NFKC").includes(term))
      .slice(0, 3);
    const groundedTerms = evidenceTerms.length > 0 ? evidenceTerms : matchedTemplateTerms;
    const focus = groundedTerms.length > 0 ? `围绕本例的「${groundedTerms.join("、")}」` : "";
    return {
      // 甲方评测(2026-08-04) 第 3 条：治疗内容不再内嵌病机原文。
      // 同一个对象已经带 targetPathogenesis 字段，渲染层单独成行；内嵌等于每个项目块把同一句病机
      // 印两遍，N 个项目就是 2N 遍。病机归病机字段，治疗内容只写这个项目本身的边界。
      treatmentContent: refinement
        ? `本例适用标准项目方案，${[focus, `按已签名证候「${refinement.syndromeLabel}」加减取穴`].filter(Boolean).join("并")}，由现场医师复核后实施。`
        : matchedRefinement
          ? `本例命中该病种标准取穴模板${focus ? `（${focus}）` : ""}，也命中了「${matchedRefinement.syndromeLabel}」的证型配穴，但该条配穴尚未完成中医师终审，本轮**不予应用**，仅呈现病种标准取穴，请按本例寒热虚实自行增减。`
          : `本例命中该病种标准取穴模板${focus ? `（${focus}）` : ""}，由现场医师复核后实施；本轮尚未按本例证型加减，请按本例寒热虚实增减。`,
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
      protocolStatus: refinement
        ? "governed_patient_specific_plan"
        : "governed_class_template_not_syndrome_tailored",
      // tailoringStatus 与 protocolStatus 在**同一处**派生，两者永不可能各说各的。
      // 它存在的唯一理由是 HIS 的 V1 兼容投影会把 protocolStatus 折叠回旧两态，
      // 而三态的真实值必须有一个不被折叠的落点（见 his-scheme-contract-version）。
      tailoringStatus: refinement ? "syndrome_tailored" as const : "class_template_only" as const,
      protocolGap: refinement
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
  const caseTerms = acupointCaseTerms(clinicalText, caseFacts, targetPathogenesis);
  // 先召回一个**更宽的候选池**再重排取 5（2026-08-11）。
  // 取 5 之后再排序救不回列缺、风池：它们按「主治命中词个数」排不进前 5，
  // 而它们恰恰是该病种受治理模板里的取穴。放宽的只是**候选池**，入选判据一字未松——
  // 仍必须是教材主治命中本例已记录症状的穴。
  const indicationMatched = projectUsesMeridianAcupoints(projectCode)
    ? selectAcupointsForCaseTerms(caseTerms, 16)
    : [];
  const referencePointFrequency = new Map<string, number>();
  for (const template of definition?.planTemplates || []) {
    if (!tcmTreatmentTemplatePointsAreGoverned(template)) continue;
    for (const point of template.sitesOrPoints) {
      referencePointFrequency.set(point, (referencePointFrequency.get(point) || 0) + 1);
    }
  }
  // 关键词召回**与受治理模板取穴取交集后重排**（甲方 2026-08-11 线上实测）。
  //
  // 实测：风寒咳嗽给出承灵、孔最、肩中俞，缺列缺、风池。根因是本例根本没走到治理模板——
  // 针刺唯一含列缺/风池的呼吸类模板 matchAny 只有「流感/流行性感冒」，而运行时词表
  // INDICATION_PATTERNS.respiratory 早已把「咳嗽/感冒」算作 respiratory，于是落进评估分支；
  // 评估分支里关键词召回是唯一穴位来源，且无条件盖过模板穴位池。
  // 而召回只按「本例症状词在主治串里出现的**个数**」排序：承灵命中 3 词压过列缺的 2 词，
  // 孔最靠「热病无汗」这条**热病**主治在风寒例里入选。
  //
  // 修法不新增任何穴位：入选仍必须「教材主治命中本例已记录症状」这一条，
  // 只是当**该适应证下的受治理模板也收了这个穴**时（两条证据同时成立）排在前面。
  // 稳定排序，其余次序不动；「主治含X」标注与呈现口径一字未改。
  // 只取**本适应证**下的受治理模板取穴。用全项目的模板池会把别的病种的穴拉进来——
  // 实测：咳嗽例里「心俞」因为在不寐模板里、且腧穴主治恰好含「咳嗽」而被排到前面。
  const governedTagPoints = new Set(
    (definition?.planTemplates || [])
      .filter((template) => (!tag || template.indicationTag === tag) && tcmTreatmentTemplatePointsAreGoverned(template))
      .flatMap((template) => template.sitesOrPoints)
      .map((point) => point.replace(/（[^）]*）/g, "").trim()),
  );
  const rankedIndicationMatched = [...indicationMatched]
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftGoverned = governedTagPoints.has(left.item.entry.name) ? 0 : 1;
      const rightGoverned = governedTagPoints.has(right.item.entry.name) ? 0 : 1;
      return leftGoverned - rightGoverned || left.index - right.index;
    })
    .map((entry) => entry.item)
    .slice(0, 5);
  const referenceCommonPoints = rankedIndicationMatched.length > 0
    ? rankedIndicationMatched.map((item) => `${item.entry.name}（${item.entry.code}·主治含${item.matchedTerms.join("、")}）`)
    : [...referencePointFrequency.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 5)
      .map(([point]) => annotateGovernedAcupoint(projectCode, point));
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

function treatmentCaseFacts(caseState?: Partial<TreatmentCaseContext>, assistedNegations?: AssistedNegationClauses): string {
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
    .map((value) => affirmedClinicalText(typeof value === "string" ? value : "", "affirmed", assistedNegations))
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
function treatmentCurrentFacts(caseState?: Partial<TreatmentCaseContext>, assistedNegations?: AssistedNegationClauses): string {
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
    .map((value) => affirmedClinicalText(typeof value === "string" ? value : "", "affirmed", assistedNegations))
    .filter((value): value is string => Boolean(value))
    .join("；");
}

function treatmentPatientAgeYears(caseState?: Partial<TreatmentCaseContext>): number | undefined {
  const raw = caseState?.patient?.age ?? caseState?.hisRecord?.fields?.age;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 130) return raw;
  if (typeof raw !== "string") return undefined;
  const years = raw.match(/(\d+(?:\.\d+)?)\s*岁/)?.[1];
  if (years != null) return Number(years);
  const months = raw.match(/(\d+(?:\.\d+)?)\s*(?:个)?月/)?.[1];
  return months != null ? Number(months) / 12 : undefined;
}

/**
 * Project-level contraindications are a separate deterministic boundary from diagnostic affinity.
 * They remove a project before it reaches the model and again before server compilation. This is
 * intentionally project-specific: a contraindicated procedure must not erase unrelated low-risk
 * care such as diet or emotion support and therefore never blocks the overall consultation flow.
 */
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
    /热证|实热|湿热|痰热|血热|虚热|阴虚火旺|火热|火旺|舌红|苔黄|发热/.test(facts) &&
    !/寒热错杂|上热下寒/.test(facts)
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
  const pregnancyStatus = assessPregnancyState(facts).status;
  if (pregnancyStatus === "positive" || pregnancyStatus === "possible") {
    if (new Set<TcmTreatmentProjectCode>([
      "acupuncture", "moxibustion", "tuina", "cupping", "guasha", "needle_knife",
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
    const score = clinicalAffinity(projectCode, nodeIndicationTags(prior, node, currentFactFallback));
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
    prior.contractSignatureVersion === "tcm-cdss-m03-signature-v4" &&
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
): TreatmentRecommendation[] {
  if (!isTrustedM03(prior) || caseState?.safetyGate?.status === "red_flag") return [];
  const scope = effectiveCapabilityScope(caseState);
  if (!scope.valid) return [];

  const capabilityByCode = new Map(scope.items.map((item) => [item.projectCode, item]));
  const chain = Array.isArray(prior.pathogenesis?.chain) ? prior.pathogenesis.chain : [];
  const nodeById = new Map(chain.flatMap((node, index) => {
    const nodeId = node.nodeId || `P${index + 1}`;
    return [[nodeId, node] as const];
  }));
  const seen = new Set<TcmTreatmentProjectCode>();
  const rankedPool = rankedTreatmentCandidates(scope, prior, proposals, false, caseState);
  const proposalPool = rankedPool.some((item) => item.explicit) ? rankedPool : rankedPool.slice(0, 2);
  const caseFacts = treatmentCaseFacts(caseState);
  const currentFacts = treatmentCurrentFacts(caseState);
  const currentFactFallback = indicationTags(caseFacts);

  return proposalPool.flatMap((proposal) => {
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
    const treatmentPlan = controlledTreatmentPlan(
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
    );
    return [{
      projectCode: definition.code,
      projectName: definition.name,
      availability: clinicAvailable ? "clinic_available" as const : "referral_only" as const,
      riskLevel: definition.risk,
      recommendationMode: specialist ? "specialist_assessment_only" as const : clinicAvailable ? "clinician_assessment" as const : "referral_assessment" as const,
      targetRef: proposal.targetRef,
      targetPathogenesis: node.pathogenesis || node.syndromeEvidence || prior.overview.overallPathogenesis,
      ...(assessmentPositioning ? { assessmentPositioning } : {}),
      ...treatmentPlan,
      operatorRequirement: definition.operatorRequirement,
      requiredChecks: [
        definition.safetyFocus,
        ...(definition.requiresMedicationAudit ? ["含药外治采用前须完成成分、过敏、禁忌、相互作用及重复用药的独立用药审方。"] : []),
      ],
      containsMedication: definition.containsMedication,
      requiresMedicationAudit: definition.requiresMedicationAudit,
      // Even a complete governed template is an advisory draft. Only a licensed clinician may turn
      // it into an executable order after patient-specific examination and contraindication review.
      executable: false,
      clinicianReviewRequired: true as const,
    }];
  }).slice(0, 3);
}

export function applyTcmTreatmentCapabilityPriority(
  content: string,
  caseState?: Partial<TreatmentCaseContext>,
  prior?: ClinicalReasoningResultV2 | null,
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
    const recommendations = compileTcmTreatmentRecommendations(proposals, prior, caseState);
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
    reasoning.nonPharma.acupointCare = null;
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
