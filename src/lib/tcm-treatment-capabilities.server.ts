import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { resolveAcupoint } from "./tcm-acupoints";
import {
  TCM_TREATMENT_PROJECTS,
  getTcmTreatmentProjectDefinition,
  governedTcmTreatmentPlanTemplate,
  isKnownTcmTreatmentProjectCode,
  parseTcmTreatmentCapabilities,
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
  ["respiratory", /咳嗽|咳痰|气喘|哮喘|喘鸣|呼呼响|憋醒|活动后喘|上楼喘|劳力性气短|肺气|肺失|支气管|呼吸|胸闷气短/],
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

const INDICATION_LABEL: Record<TcmTreatmentIndicationTag, string> = {
  digestive: "脾胃与消化症状",
  respiratory: "咳喘与呼吸功能",
  upper_airway: "鼻窍与上气道症状",
  musculoskeletal_pain: "局部疼痛与活动受限",
  neurologic_rehabilitation: "神经功能康复",
  dizziness_balance: "眩晕与平衡功能",
  movement_disorder: "运动功能障碍",
  gynecology: "经带与下腹症状",
  dermatology: "皮肤症状",
  headache: "头痛症状",
  sleep_emotion: "睡眠与情志症状",
  metabolic_rehabilitation: "代谢与体重管理",
  anorectal: "肛肠局部症状",
};

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
function annotateGovernedAcupoint(site: string): string {
  const entry = resolveAcupoint(site);
  if (!entry) return site;
  const meridian = entry.meridian && entry.meridian !== entry.name ? `·${entry.meridian}` : "";
  return `${site}（${entry.code}${meridian}）`;
}

function dominantIndicationTag(
  projectCode: TcmTreatmentProjectCode,
  tags: ReadonlySet<TcmTreatmentIndicationTag>,
): TcmTreatmentIndicationTag | undefined {
  return [...tags]
    .filter((tag) => Boolean(getTcmTreatmentProjectDefinition(projectCode)?.indicationTags.includes(tag)))
    .sort((left, right) => (PROJECT_TAG_AFFINITY[projectCode]?.[right] || 0) - (PROJECT_TAG_AFFINITY[projectCode]?.[left] || 0))[0];
}

function controlledTreatmentPlan(
  projectCode: TcmTreatmentProjectCode,
  tags: ReadonlySet<TcmTreatmentIndicationTag>,
  targetPathogenesis: string,
  clinicalText: string,
): Pick<TreatmentRecommendation,
  "treatmentContent" | "suggestedSitesOrPoints" | "scheduleSuggestion" | "techniqueBoundary" |
  "protocolSource" | "protocolStatus" | "protocolGap"
> {
  const tag = dominantIndicationTag(projectCode, tags);
  const indication = tag ? INDICATION_LABEL[tag] : "当前病机与主要症状";
  const definition = getTcmTreatmentProjectDefinition(projectCode);
  const governedTemplate = governedTcmTreatmentPlanTemplate(projectCode, clinicalText, tags);
  if (governedTemplate) {
    return {
      treatmentContent: `本例适用标准项目方案，围绕${indication}与“${targetPathogenesis}”由现场医师复核后实施。`,
      suggestedSitesOrPoints: governedTemplate.sitesOrPoints.map(annotateGovernedAcupoint),
      scheduleSuggestion: governedTemplate.scheduleSuggestion,
      techniqueBoundary: governedTemplate.techniqueBoundary,
      protocolSource: governedTemplate.sourceRefs.join("、"),
      protocolStatus: "governed_patient_specific_plan",
      protocolGap: undefined,
    };
  }

  const sourceRefs = definition?.protocolSourceRefs.filter(Boolean) || [];
  const protocolGap = definition?.patientSpecificParametersAllowed
    ? `目录存在该项目的其他适应证模板，但与本例适应证不符；不得跨适应证套用穴位、部位、频次或疗程。`
    : "当前目录缺少与该项目及本例适应证对应的标准操作方案；不得生成患者级穴位、部位、频次或疗程。";
  return {
    treatmentContent: `本例与${indication}及病机节点“${targetPathogenesis}”存在项目评估关联；仅进入现场适应证、禁忌与资质评估，不形成操作计划。`,
    suggestedSitesOrPoints: [],
    scheduleSuggestion: "",
    techniqueBoundary: definition?.parameterPolicy || protocolGap,
    protocolSource: sourceRefs.join("、") || "T12 中医非药物项目治理目录",
    protocolStatus: "assessment_only_no_patient_specific_protocol",
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
  const currentFactFallback = indicationTags(treatmentCaseFacts(caseState));

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
    const treatmentClinicalText = [
      globalIndicationText(prior),
      treatmentCaseFacts(caseState),
      node.pathogenesis,
      node.syndromeEvidence,
    ].filter(Boolean).join("；");
    const matchedIndicationTags = nodeIndicationTags(prior, node, currentFactFallback);
    const treatmentPlan = controlledTreatmentPlan(
      definition.code,
      matchedIndicationTags,
      node.pathogenesis || node.syndromeEvidence || prior.overview.overallPathogenesis,
      treatmentClinicalText,
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
