import tcmNondrugTreatmentJson from "../data/tcm-nondrug-treatment-evidence-catalog.json" with { type: "json" };
import governanceSourceRegistryJson from "../data/clinical-governance-source-registry.json" with { type: "json" };
import refinementAdjudicationJson from "../data/tcm-acupoint-syndrome-refinement-adjudications.source.json" with { type: "json" };

/**
 * 来源权威等级（2026-08-11）。等级本来就登记在受治理来源注册表里，只是从来没有 join 到
 * 「这一条证型配穴」上——于是对外只能笼统说「不寐与痛经来自权威来源」，而实际情况是
 * **同一病种下逐条不同**：不寐前 4 条有 T/CAAM 011-2014，「痰热内扰」「脾胃不和」只有教材表。
 * 排序只用于取一条规则里的**最高**等级，不做任何临床判断。
 */
export const TCM_SOURCE_AUTHORITY_TIERS = [
  "regulatory_primary",
  "government_primary",
  "government_mirror",
  "professional_society_standard",
  // 专家共识**不等于**学会团体标准：没有标准编号与复审周期，单独一档。
  // 中医师 2026-08-11 终审明确要求「政府指导 / 学会标准 / 专家共识 / 组合推导必须如实区分」。
  "professional_society_consensus",
  "professional_society_reference",
  "project_governed_source",
  "unregistered",
] as const;
export type TcmSourceAuthorityTier = (typeof TCM_SOURCE_AUTHORITY_TIERS)[number];

/**
 * 权威等级的**唯一**中文说法。医生页面、服务端 Markdown 与 HIS 说明共用这一张表——
 * 同一个等级在三个出口翻成三种说法，正是本仓库反复出现的那个缺陷形状。
 */
export const TCM_SOURCE_AUTHORITY_TIER_LABELS: Record<string, string> = {
  regulatory_primary: "国家标准/规范",
  government_primary: "政府发布方案",
  government_mirror: "政府方案转载",
  professional_society_standard: "学会标准",
  professional_society_consensus: "专家共识",
  professional_society_reference: "学会参考条目",
  project_governed_source: "项目治理教材来源",
  unregistered: "来源未登记",
};

const AUTHORITY_TIER_BY_SOURCE_ID = new Map<string, TcmSourceAuthorityTier>(
  ((governanceSourceRegistryJson as { entries?: Array<{ id?: string; authorityTier?: string }> }).entries || [])
    .flatMap((entry) => (entry?.id && entry.authorityTier
      ? [[entry.id, entry.authorityTier as TcmSourceAuthorityTier] as const]
      : [])),
);

export function tcmSourceAuthorityTier(sourceId: string): TcmSourceAuthorityTier {
  return AUTHORITY_TIER_BY_SOURCE_ID.get(String(sourceId || "").trim()) || "unregistered";
}

/** 一组来源里最高的那一档。空数组按 unregistered 处理（fail-closed 方向：不知道就当没登记）。 */
export function highestTcmSourceAuthorityTier(sourceIds: readonly string[]): TcmSourceAuthorityTier {
  let best: TcmSourceAuthorityTier = "unregistered";
  let bestRank: number = TCM_SOURCE_AUTHORITY_TIERS.length;
  for (const id of sourceIds) {
    const tier = tcmSourceAuthorityTier(id);
    const rank = TCM_SOURCE_AUTHORITY_TIERS.indexOf(tier);
    if (rank >= 0 && rank < bestRank) { best = tier; bestRank = rank; }
  }
  return best;
}

export type TcmRefinementAdjudicationStatus = "approved" | "pending_clinician_review";

export type TcmRefinementAdjudication = {
  adjudicationStatus: TcmRefinementAdjudicationStatus;
  conflictNote: string | null;
  /** 具体存疑的穴位（可空）。仅用于呈现，不改变「整条不应用加穴」的处置。 */
  pendingPoints: readonly string[];
};

const REFINEMENT_ADJUDICATIONS = new Map<string, TcmRefinementAdjudication>(
  Object.entries(
    (refinementAdjudicationJson as {
      entries?: Record<string, { adjudicationStatus?: string; conflictNote?: string | null; pendingPoints?: string[] }>;
    }).entries || {},
  ).map(([id, entry]) => [id, {
    adjudicationStatus: entry?.adjudicationStatus === "approved" ? "approved" : "pending_clinician_review",
    conflictNote: typeof entry?.conflictNote === "string" && entry.conflictNote.trim() ? entry.conflictNote : null,
    pendingPoints: Array.isArray(entry?.pendingPoints) ? entry.pendingPoints.filter((p) => typeof p === "string") : [],
  }]),
);

/**
 * 单条证型加减的终审状态。**台账里没有登记的条目一律按未终审处理**——
 * 方向必须是这一侧：新录进目录、还没进复核的条目不能因为「台账没提到它」就自动获得
 * 「已核验」身份，那正好是本轮要修的那个缺陷（未终审条目被标成患者级个体化方案）。
 */
export function tcmRefinementAdjudication(refinementId: string): TcmRefinementAdjudication {
  return REFINEMENT_ADJUDICATIONS.get(refinementId) || {
    adjudicationStatus: "pending_clinician_review",
    conflictNote: "该证型加减尚未进入逐条终审台账，本轮不作为「按本例证型加减」的依据。",
    pendingPoints: [],
  };
}

/** 逐穴的来源与终审记录。粒度到穴位，因为主穴与加减穴来自**不同**来源。 */
export type TcmTreatmentPointProvenance = {
  point: string;
  /**
   * conditional_point（2026-08-11 中医师裁定新增）：既非主穴、也非证型加减，
   * 而是本例出现某组**当前症状**时才加的穴（风寒咳嗽兼鼻窍/头项症状加风池）。
   * HIS 的 V1 兼容投影把它折叠回 syndrome_refinement——新增枚举值不得破坏 V1，
   * 这条教训来自本轮 protocolStatus 第三态（见 his-scheme-contract-version）。
   */
  role: "base_point" | "syndrome_refinement" | "syndrome_removal" | "conditional_point";
  sourceRefs: string[];
  authorityTier: TcmSourceAuthorityTier;
  adjudicationStatus: TcmRefinementAdjudicationStatus;
  conflictNote: string | null;
};

export const TCM_TREATMENT_PROJECT_CODES = [
  "acupuncture", "moxibustion", "tuina", "cupping", "guasha", "needle_knife",
  "acupoint_application", "medicated_plaster", "fumigation_wash", "medicated_bath",
  "auricular", "thread_embedding", "medicated_ironing", "bloodletting", "fire_cautery",
  "hook_cutting", "thread_drainage", "ligation", "diet_therapy", "mind_therapy",
  "qigong_daoyin", "miscellaneous",
] as const;

export const TCM_TREATMENT_INDICATION_TAGS = [
  "digestive",
  "respiratory",
  "upper_airway",
  "musculoskeletal_pain",
  "neurologic_rehabilitation",
  "dizziness_balance",
  "movement_disorder",
  "gynecology",
  "dermatology",
  "headache",
  "sleep_emotion",
  "metabolic_rehabilitation",
  "anorectal",
] as const;

export type TcmTreatmentProjectCode = typeof TCM_TREATMENT_PROJECT_CODES[number];
export type TcmTreatmentIndicationTag = typeof TCM_TREATMENT_INDICATION_TAGS[number];
export type TcmTreatmentProjectRisk = "low" | "moderate" | "specialist";
/**
 * 证型加减层（甲方 2026-08-10 ⑪）。
 *
 * 本目录此前 25 条 planTemplates 的 matchAny **无一含寒热虚实**，命中判据是病名字符串；
 * 400 穴目录的 indications 文本里也根本没有性质词，匹配面为零。于是实测结果是：
 * 甲流「风寒束表」与「风热犯表」、不寐「心脾两虚」与「肝火扰心」、胃痞「湿热中阻」与
 * 「脾胃虚寒」、右膝痹「寒湿」与「湿热」——四组八例的穴位**逐字相同**，
 * 而 protocolStatus 八次都写着 governed_patient_specific_plan。
 *
 * 加减层不是把病种模板换掉，而是在它之上加一层**二次判据**：
 * 只有先命中病种模板（matchAny）、再命中本例已签名证候（syndromeMatchAny），
 * 才算「按本例证型加减过」。两把钥匙缺一，protocolStatus 只能是
 * governed_class_template_not_syndrome_tailored——命中了标准取穴模板，但没按证型加减。
 * 这样既不会让「风寒」二字在别的病种上乱命中，也不会再把病种级模板冒充成个体化方案。
 */
export type TcmTreatmentSyndromeRefinement = {
  id: string;
  /** 医生可读的证型名，进呈现层与 HIS。 */
  syndromeLabel: string;
  /** 证型判据：逐字命中**已签名**证候/病机/治法文本才成立，不看病历原文。 */
  syndromeMatchAny: readonly string[];
  /** 该证型在主穴之上加的配穴（教材/指南级配穴表）。 */
  addPoints: readonly string[];
  /**
   * 该证型下必须从主穴里剔除的穴位。
   * 确定性层没有能力判「关元宜不宜湿热」——穴位目录只有 indications 与 operation，
   * 没有寒热温凉/补泻宜忌属性列。因此闸门做在**证型配穴表**这一层：
   * 关元只出现在虚寒类加减里，湿热类把它剔除，判据来自权威配穴表而不是我们自造的词表。
   */
  removePoints?: readonly string[];
  /**
   * 证型之外**还必须成立**的病历证据（中医师 2026-08-11 终审要求）。
   *
   * 证型名对上不等于该加减就该自动显示：风寒袭肺要有恶寒/无汗/清涕这类表寒线索，
   * 痰湿中阻要有苔腻/身重/纳呆，肝肾亏虚要有腰膝酸软/久病/劳则加重。
   * 判据走**已确认的阳性病历事实**（affirmedClinicalText 的产物），因此「否认恶寒」不会命中。
   * 不设此字段时行为与原先完全一致。
   */
  additionalEvidenceAny?: readonly string[];
  /**
   * 这条配穴是**照录**某条来源原文，还是由两条规则**组合推导**出来的。
   *
   * 中医师终审的原话：「需要把来源标为『热痹规则＋湿邪配穴的组合推导』，
   * 不能写成教材存在一条完全相同的原文」。组合推导的条目一律不得升等级，
   * 其权威等级封顶在 project_governed_source。
   */
  sourceDerivation?: "verbatim_source_row" | "combination_inference";
  sourceRefs: readonly string[];
};

/**
 * 「条件加穴」——不属于主穴、也不属于证型加减，而是**本例出现某组当前症状时才加**的穴。
 *
 * 中医师 2026-08-11 对普通风寒咳嗽的裁定里明确要求了这一档：
 * 「列缺应固定进入普通咳嗽主穴，风池不应对所有风寒咳嗽强制加入，
 *   而应作为鼻窍、头项症状明显时的条件加穴」。
 *
 * 为什么不复用 syndromeRefinements：那一层的判据是**证型**（只读已签名证候文本），
 * 而且 governedTcmTreatmentSyndromeRefinement 每个模板只返回**一条**最具体的加减——
 * 把「风寒袭肺加风门合谷」和「有鼻窍/头项症状加风池」写成两条证型加减，
 * 结构上就只有一条能生效。条件加穴与证型加减是两个正交的维度，因此单开一档。
 *
 * 判据刻意走**当前事实**（treatmentCurrentFacts：主诉/现病史/四诊，不含既往史），
 * 不走 caseFacts：既往有过偏头痛不构成本次加风池的理由。
 */
export type TcmTreatmentConditionalPoint = {
  point: string;
  /** 本例**当前**事实里命中任一条才加这个穴。 */
  requireCurrentFactAny: readonly string[];
  /** 给医生看的触发说明，逐字进穴位标注——医生要能看出这个穴是被什么带进来的。 */
  triggerNote: string;
  sourceRefs: readonly string[];
};

/**
 * 「精确证型模板优先」闸门（中医师 2026-08-11 裁定的落库方式）。
 *
 * 背景：普通风寒咳嗽此前拿不到列缺、风池，根因有两层——
 *   ① 「流清涕」先命中 upper_airway，抢在 respiratory 前面，于是够不到呼吸类模板；
 *   ② 目录里根本没有「普通风寒咳嗽」的受治理模板，只有流感专用与恢复期两条。
 * 裁定明确**不许调整全局 upper_airway / respiratory 优先级**（那会影响所有病例），
 * 改为给这一条模板单独开一个前置闸门：两把钥匙同时对上才走它，且发生在通用标签排序**之前**。
 *
 * 三条边界写在数据里而不是代码里：
 *   · requireCurrentFactAny —— 必须有**当前**咳嗽事实（既往咳嗽、否认咳嗽都不算）；
 *   · requireSignedSyndromeAny —— 必须有**已签名**的风寒袭肺/风寒束肺（病历里「淋雨」不算）；
 *   · excludeAny —— 流感、恢复期、风热等一律排除，绝不扩大既有专项方案的适应证。
 */
export type TcmTreatmentPreciseSyndromeGate = {
  requireCurrentFactAny: readonly string[];
  requireSignedSyndromeAny: readonly string[];
  excludeAny: readonly string[];
  /**
   * 适用年龄下限（岁）。中医师签字裁定的适用范围原文是「**成人**」，而模板自己的
   * techniqueBoundary 也写着成人——闸门此前没有任何年龄判据，实测 8 个月婴儿同样拿到
   * 六穴患者级方案，其中中府（LU1）、肺俞（BL13）在小儿身上正是气胸风险穴。
   * **年龄取不到时一律不启用**：拿不到年龄就不能证明是成人，方向必须取保守侧。
   */
  minAgeYears?: number;
  /** 该模板在终审台账里的键。未登记 / 未签字 ⇒ 模板不启用，本例保持评估态。 */
  adjudicationId: string;
  /** 医生可读的模板适应证名，进呈现层与 HIS（「普通咳嗽·风寒袭肺证」）。 */
  indicationLabel: string;
};

export type TcmTreatmentPlanTemplate = {
  id: string;
  indicationTag: TcmTreatmentIndicationTag;
  matchAny: readonly string[];
  sitesOrPoints: readonly string[];
  techniqueBoundary: string;
  scheduleSuggestion: string;
  sourceRefs: readonly string[];
  parameterCompleteness: string;
  syndromeRefinements?: readonly TcmTreatmentSyndromeRefinement[];
  conditionalPoints?: readonly TcmTreatmentConditionalPoint[];
  preciseSyndromeGate?: TcmTreatmentPreciseSyndromeGate;
};

export type TcmTreatmentProjectDefinition = {
  code: TcmTreatmentProjectCode;
  name: string;
  risk: TcmTreatmentProjectRisk;
  indicationTags: readonly TcmTreatmentIndicationTag[];
  containsMedication: boolean;
  requiresMedicationAudit: boolean;
  operatorRequirement: string;
  safetyFocus: string;
  aliases: string[];
  evidenceStatus: string;
  protocolSourceRefs: readonly string[];
  recommendationMode: string;
  executable: boolean;
  governedParameterTemplateAvailable: boolean;
  governedFrequencyTemplateAvailable: boolean;
  coverageDisposition: string;
  clinicianReviewRequired: true;
  patientSpecificParametersAllowed: boolean;
  parameterPolicy: string;
  planTemplates: readonly TcmTreatmentPlanTemplate[];
};

type ProjectCatalogInput = Omit<TcmTreatmentProjectDefinition, "containsMedication" | "requiresMedicationAudit"> &
  Partial<Pick<TcmTreatmentProjectDefinition, "containsMedication" | "requiresMedicationAudit">>;

function defineProject(definition: ProjectCatalogInput): TcmTreatmentProjectDefinition {
  const containsMedication = definition.containsMedication === true;
  const requiresMedicationAudit = definition.requiresMedicationAudit === true;
  if (containsMedication !== requiresMedicationAudit) {
    throw new Error(`Medication governance metadata must agree for ${definition.code}`);
  }
  return { ...definition, containsMedication, requiresMedicationAudit };
}

type GovernedTreatmentProjectRow = {
  projectCode: TcmTreatmentProjectCode;
  projectName: string;
  aliases: string[];
  riskLevel: TcmTreatmentProjectRisk;
  indicationTags: TcmTreatmentIndicationTag[];
  containsMedication: boolean;
  requiresMedicationAudit: boolean;
  operatorRequirement: string;
  safetyFocus: string;
  evidenceStatus: string;
  protocolSourceRefs: string[];
  recommendationMode: string;
  executable: boolean;
  governedParameterTemplateAvailable: boolean;
  governedFrequencyTemplateAvailable: boolean;
  coverageDisposition: string;
  clinicianReviewRequired: true;
  patientSpecificParametersAllowed: boolean;
  parameterPolicy: string;
  planTemplates: TcmTreatmentPlanTemplate[];
};

const GOVERNED_TREATMENT_ROWS = tcmNondrugTreatmentJson.entries as readonly GovernedTreatmentProjectRow[];

/**
 * T12 is the sole runtime project registry. Recommendation code may rank eligible projects, but it
 * cannot invent a project, relax its medication-audit flag, or turn a governance row executable.
 */
export const TCM_TREATMENT_PROJECTS: readonly TcmTreatmentProjectDefinition[] =
  GOVERNED_TREATMENT_ROWS.map((row) => defineProject({
    code: row.projectCode,
    name: row.projectName,
    risk: row.riskLevel,
    indicationTags: row.indicationTags,
    containsMedication: row.containsMedication,
    requiresMedicationAudit: row.requiresMedicationAudit,
    operatorRequirement: row.operatorRequirement,
    safetyFocus: row.safetyFocus,
    aliases: row.aliases,
    evidenceStatus: row.evidenceStatus,
    protocolSourceRefs: row.protocolSourceRefs,
    recommendationMode: row.recommendationMode,
    executable: row.executable,
    governedParameterTemplateAvailable: row.governedParameterTemplateAvailable,
    governedFrequencyTemplateAvailable: row.governedFrequencyTemplateAvailable,
    coverageDisposition: row.coverageDisposition,
    clinicianReviewRequired: row.clinicianReviewRequired,
    patientSpecificParametersAllowed: row.patientSpecificParametersAllowed,
    parameterPolicy: row.parameterPolicy,
    planTemplates: row.planTemplates,
  }));

const expectedProjectCodes = new Set(TCM_TREATMENT_PROJECT_CODES);
if (
  TCM_TREATMENT_PROJECTS.length !== expectedProjectCodes.size ||
  TCM_TREATMENT_PROJECTS.some((item) => !expectedProjectCodes.has(item.code)) ||
  new Set(TCM_TREATMENT_PROJECTS.map((item) => item.code)).size !== expectedProjectCodes.size
) {
  throw new Error("T12 treatment project catalog does not exactly cover the runtime project-code contract");
}

const PROJECT_BY_CODE = new Map(TCM_TREATMENT_PROJECTS.map((item) => [item.code, item]));
const PROJECT_CODE_BY_ALIAS = new Map(TCM_TREATMENT_PROJECTS.flatMap((item) =>
  [item.code, item.name, ...item.aliases].map((alias) => [alias.toLowerCase(), item.code] as const)
));

export function isKnownTcmTreatmentProjectCode(value: unknown): value is TcmTreatmentProjectCode {
  return typeof value === "string" && PROJECT_BY_CODE.has(value as TcmTreatmentProjectCode);
}

export function parseTcmTreatmentCapabilities(value: unknown): TcmTreatmentProjectCode[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，;；|]/)
      : [];
  return [...new Set(entries.flatMap((entry) => {
    const normalized = String(entry || "").trim().toLowerCase();
    const code = PROJECT_CODE_BY_ALIAS.get(normalized);
    return code ? [code] : [];
  }))];
}

export function getTcmTreatmentProjectDefinition(code: TcmTreatmentProjectCode): TcmTreatmentProjectDefinition | undefined {
  return PROJECT_BY_CODE.get(code);
}

/**
 * 按**给定的适应证优先级**选取治理模板。
 *
 * 旧签名接收的是一个无序 Set，实现用 `planTemplates.find(...)`——于是真正决定选哪套穴位的是
 * **目录里模板的排列顺序**，而不是本例的适应证。针刺的模板表第一条恰好是失眠方
 * （安眠/神门/内关/心俞），只要病历里出现「失眠」二字，头痛病例也会拿到这套安眠穴位，
 * 而卡片标题上写的却是按项目亲和度算出来的另一个适应证（头痛症状）——同一张卡片里
 * 「适应证」和「穴位」来自两套互不相干的判据（生产实测 fixa-d1b：肝阳上亢头痛 → 安眠/心俞）。
 *
 * 改为按调用方给出的**有序**适应证逐个匹配：先找排第一的适应证有没有对应模板，没有再退而求其次。
 * 选中的模板自带 indicationTag，呈现层据此标注，两者不可能再分叉。
 */
export function governedTcmTreatmentPlanTemplateForTags(
  code: TcmTreatmentProjectCode,
  clinicalText: string,
  orderedIndicationTags: readonly TcmTreatmentIndicationTag[],
): TcmTreatmentPlanTemplate | undefined {
  const normalized = clinicalText.normalize("NFKC");
  const definition = PROJECT_BY_CODE.get(code);
  if (!definition?.patientSpecificParametersAllowed) return undefined;
  // matchAny 不是「同一标签下多模板的消歧器」，而是**本例绑定判据本身**：
  // 调用方（compileTcmTreatmentRecommendations、以及回归套件）允许传入项目声明的全部适应证标签，
  // 由这里按病历原文决定命中哪一条。
  //
  // 2026-08-06 曾试图放宽为「该标签下只有一条模板时，标签命中即足够」，用来解决
  // 「入睡困难」匹配不到 sleep_emotion 模板的问题——**实测灾难性**：头痛病例拿到了
  // 中脘、天枢、足三里这套消化类穴位，因为标签列表里的 digestive 恰好只有一条模板。
  // 那次放宽等于取消本例绑定，而本例绑定正是甲方 9.1 / 6.1 两轮投诉的核心。
  // 词表稀疏要在**模板 matchAny 数据侧**补齐（见 test:tcm-treatments 的词表一致性断言），
  // 不能靠削弱这里的判据换取覆盖率。
  for (const tag of orderedIndicationTags) {
    const matched = definition.planTemplates.find((template) =>
      // 带精确证型闸门的模板**只能**从闸门进（2026-08-11 端到端实测抓到）。
      //
      // 它同时也是一条普通的 respiratory 模板、matchAny 是「咳嗽/咳痰/干咳」，
      // 于是这条按病名匹配的常规通路可以绕过闸门把它选出来——实测风热咳嗽与
      // 「仅有既往咳嗽」两例都因此拿到了风寒证取穴。那正是中医师裁定明令禁止的扩大适应证：
      // 闸门写了「必须同时命中已签名风寒袭肺」，却还留着一扇不看证型的后门。
      //
      // 判据放在这里而不是给 matchAny 加限定词：matchAny 是**病种**判据，
      // 它本来就该匹配所有咳嗽；决定"这条模板能不能用"的是闸门，两者不是一回事。
      !template.preciseSyndromeGate &&
      template.indicationTag === tag &&
      // 走同一个阳性判据而不是裸 includes：实测「甲型流感病毒抗原**阴性**」里的「流感」
      // 会把病例送进流感专项模板，拿到列缺/合谷/风池/太阳/外关与「每日1次、每次30分钟」——
      // 一个阴性结果反而换来了专项取穴。不新造第三个判官，复用闸门那一个。
      template.matchAny.some((term) => containsAffirmedTerm(normalized, term)));
    if (matched) return matched;
  }
  return undefined;
}

/**
 * 「这段文字里**阳性地**提到了这个词吗」——闸门与条件加穴的取词判据。
 *
 * 运行时喂进来的当前事实已经过 affirmedClinicalText 阳性化，理论上「无咳嗽」不会留到这里。
 * 但闸门自己也必须站得住：裸 `includes("咳嗽")` 在「无咳嗽」「否认咳嗽」上同样为真，
 * 而「把未提及/否认当阳性」是本仓库显式测试过的误报类别（见 clinical-state.ts 的状态词表）。
 * 判据两层，任何一层失效另一层仍然拦得住。
 *
 * 只看紧邻词前、且被标点截断的那一小段：「恶寒无汗，鼻塞」里的「无」属于上一个短句，
 * 不能算到「鼻塞」头上——否则会把真阳性判成阴性，方向错得更难发现。
 */
const NEGATION_MARKERS = /(?:无|未|否认|不|非|没有|排除|阴性|已除外)/;
/**
 * 否定也可以跟在词**后面**：「甲型流感病毒抗原阴性」「胸片未见异常」。
 * 只看词前会把一个阴性结果读成阳性事实——实测它把病例送进了流感专项方案，
 * 拿到列缺/合谷/风池/太阳/外关与「每日1次、每次30分钟」，比不命中更糟。
 */
const NEGATION_SUFFIX = /(?:阴性|未见|未检出|未发现|已排除|已除外|除外|不支持|不考虑|正常)/;
/** 非肯定角色的上下文：证型名出现在鉴别、病机演变、对比里，不等于本例的**结论**。 */
const NON_ASSERTIVE_CONTEXT = /(?:^与|需与|应与|与之|鉴别|相鉴别|不同|区别|相似|类似|初起|日久|入里|化热|转化|演变|继而|进而|逐渐|排除|除外)/;

/** 把一段文字切成分句。否定的作用域到分句为止——跨分句不生效。 */
function clinicalClauses(text: string): string[] {
  return text.split(/[，,。；;、：:\n]/).map((part) => part.trim()).filter(Boolean);
}

function containsAffirmedTerm(text: string, term: string): boolean {
  if (!text || !term) return false;
  // 作用域是**整个分句**，不是紧邻词前的固定窗口（2026-08-11 对抗性复核）。
  // 原实现只回看 4 个字符，于是「无·明·显·发·热·及·咳嗽」中间隔了 5 个字，
  // 窗口取到「显发热及」，一个否定标记都不命中——病历写着「无…咳嗽」却被读成有咳嗽，
  // 而那正是中医师裁定明列要排除的「单纯鼻炎无咳嗽」。
  // 分句边界仍然保留：「恶寒无汗，咳嗽痰白稀」里的「无」属上一分句，不能算到「咳嗽」头上。
  for (const clause of clinicalClauses(text)) {
    const index = clause.indexOf(term);
    if (index < 0) continue;
    if (NEGATION_MARKERS.test(clause.slice(0, index))) continue;
    if (NEGATION_SUFFIX.test(clause.slice(index + term.length))) continue;
    return true;
  }
  return false;
}

/**
 * 证型名在这段已签名文本里是不是以**结论**身份出现的。
 *
 * 2026-08-11 对抗性复核抓到：中医常用的排除性写法「本证与风寒袭肺证鉴别要点在于…」
 * 与病机演变写法「初起风寒袭肺，日久聚湿生痰，痰湿蕴肺」都不含任何否定词，
 * 于是闸门把**一次鉴别诊断/一段病机溯源**读成了「本例已签名证型」——
 * 痰湿蕴肺证患者因此拿到风寒六穴，还标成患者级方案。
 *
 * 两道收紧，方向都取保守侧：
 *   ① 调用方只把**结论性字段**（主证候名）喂进来，不喂叙述性的病机/辨证依据/治法方向；
 *   ② 即便在结论字段里，出现在鉴别/演变语境中的也不算——宁可少开闸，不可开错闸。
 */
function containsConcludedSyndromeTerm(text: string, term: string): boolean {
  if (!text || !term) return false;
  for (const clause of clinicalClauses(text)) {
    const index = clause.indexOf(term);
    if (index < 0) continue;
    if (NEGATION_MARKERS.test(clause.slice(0, index))) continue;
    if (NEGATION_SUFFIX.test(clause.slice(index + term.length))) continue;
    if (NON_ASSERTIVE_CONTEXT.test(clause)) continue;
    return true;
  }
  return false;
}

/**
 * 精确证型模板闸门的**纯判据**：两把钥匙同时对上、且一条排除项都不命中。
 *
 * 单独导出是为了让回归能在**不依赖终审状态**的前提下逐条钉住 7 种情形
 *（风寒咳嗽±鼻窍症状、单纯鼻炎、流感、恢复期、风热、否认/既往咳嗽）——
 * 终审签字与否是另一件事，由 governedTcmTreatmentPrecisePlanTemplate 决定启不启用。
 */
export function precisePlanTemplateGateMatches(
  template: TcmTreatmentPlanTemplate,
  /** 本例**当前**事实（treatmentCurrentFacts：主诉/现病史/四诊，已做阳性化，不含既往史）。 */
  currentFacts: string,
  /**
   * 已签名证候的**结论性**文本（主证候名）。刻意不含病机链/辨证依据/治法方向这些叙述性字段——
   * 「本证与风寒袭肺证鉴别要点在于…」「初起风寒袭肺，日久痰湿蕴肺」都会把闸门骗开。
   */
  signedSyndromeText: string,
  /** 本例年龄（岁）。取不到传 undefined，带年龄下限的模板一律不启用。 */
  patientAgeYears?: number,
): boolean {
  const gate = template.preciseSyndromeGate;
  if (!gate) return false;
  if (typeof gate.minAgeYears === "number") {
    if (typeof patientAgeYears !== "number" || !Number.isFinite(patientAgeYears)) return false;
    if (patientAgeYears < gate.minAgeYears) return false;
  }
  const facts = String(currentFacts || "").normalize("NFKC");
  const signed = String(signedSyndromeText || "").normalize("NFKC");
  if (!facts.trim() || !signed.trim()) return false;
  // 排除优先于命中：任一排除项出现在当前事实**或**已签名结论里都直接出局。
  // 方向刻意取保守侧——宁可回落评估态，也不把专项方案套到不该套的病程阶段或证型上。
  if (gate.excludeAny.some((term) => facts.includes(term) || signed.includes(term))) return false;
  // 命中侧一律走阳性判据；排除侧刻意保持裸 includes——排除是保守方向，
  // 「排除流感」这类写法把病例挡在门外只是少给一条建议，反向漏放才是危险的。
  if (!gate.requireCurrentFactAny.some((term) => containsAffirmedTerm(facts, term))) return false;
  return gate.requireSignedSyndromeAny.some((term) => containsConcludedSyndromeTerm(signed, term));
}

/**
 * 本项目里是否有一条**精确证型模板**匹配本例，以及它的终审状态。
 *
 * 命中但未签字时**不返回可用模板**（`template` 为空），只返回 `deferred`——
 * 中医师 2026-08-11 的原话是「签字前保持评估态是正确的」。但也不能就此静默：
 * 医生需要知道系统已经匹配到一条待签字的标准取穴，否则页面上只剩关键词召回的结果，
 * 看起来就像"系统什么都没有"。这与 deferredSyndromeRefinement 的处置同源。
 */
export function governedTcmTreatmentPrecisePlanTemplate(
  code: TcmTreatmentProjectCode,
  currentFacts: string,
  signedSyndromeText: string,
  patientAgeYears?: number,
): {
  template?: TcmTreatmentPlanTemplate;
  deferred?: { template: TcmTreatmentPlanTemplate; adjudication: TcmRefinementAdjudication };
} {
  const definition = PROJECT_BY_CODE.get(code);
  if (!definition?.patientSpecificParametersAllowed) return {};
  const matched = definition.planTemplates
    .filter((template) => template.preciseSyndromeGate)
    .filter((template) => precisePlanTemplateGateMatches(template, currentFacts, signedSyndromeText, patientAgeYears))
    // 同时命中多条时按 id 稳定排序，结果可复现、不随目录排列漂移。
    .sort((left, right) => left.id.localeCompare(right.id));
  const template = matched[0];
  if (!template) return {};
  const adjudication = tcmRefinementAdjudication(template.preciseSyndromeGate!.adjudicationId);
  if (adjudication.adjudicationStatus !== "approved") return { deferred: { template, adjudication } };
  return { template };
}

/**
 * 本例应加的**条件加穴**（当前事实命中触发词的那些）。
 *
 * 与证型加减分开算：证型加减看已签名证候且每模板只取一条，条件加穴看当前症状且可多条并存。
 */
export function governedTcmTreatmentConditionalPoints(
  template: TcmTreatmentPlanTemplate,
  currentFacts: string,
): TcmTreatmentConditionalPoint[] {
  const facts = String(currentFacts || "").normalize("NFKC");
  if (!facts.trim()) return [];
  // 既往描述写在现病史里也不算数（「…无鼻塞流涕；既往有偏头痛史」不应加风池）：
  // 条件加穴的触发词必须是**本次**症状，标注上写的也正是"本例症状触发"。
  const currentClauses = clinicalClauses(facts)
    .filter((clause) => !/(?:既往|曾经|曾有|此前|过去|多年前|病史)/.test(clause))
    .join("，");
  return (template.conditionalPoints || [])
    .filter((entry) => entry.requireCurrentFactAny.some((term) => containsAffirmedTerm(currentClauses, term)));
}

/**
 * 在**已命中的病种模板内部**，按已签名证候文本挑证型加减。
 *
 * 判据刻意只看已签名的证候/病机/治法文本，不看病历原文：「按本例证型加减」说的是证型，
 * 病历里出现「淋雨受寒」不等于辨证结论是风寒束表。取不到证型时返回 undefined，
 * 呈现层据此如实标注「尚未按本例证型加减」——不猜、不外推。
 *
 * 同一模板下多条加减同时命中时取匹配词最长的一条（最具体者优先），
 * 同长时按 id 稳定排序，保证结果可复现、不随目录排列漂移。
 */
export function governedTcmTreatmentSyndromeRefinement(
  template: TcmTreatmentPlanTemplate,
  signedSyndromeText: string,
  /**
   * 已确认的**阳性**病历事实文本。只有声明了 additionalEvidenceAny 的条目才读它——
   * 中医师 2026-08-11 终审要求：证型名对上不等于该加减就该自动显示（风寒袭肺要有恶寒/无汗/清涕，
   * 痰湿中阻要有苔腻/身重/纳呆，肝肾亏虚要有腰膝酸软/久病/劳则加重）。
   * 传空串时，带证据门槛的条目一律不命中（fail-closed：拿不到证据就不自动加穴）。
   */
  affirmedEvidenceText = "",
): TcmTreatmentSyndromeRefinement | undefined {
  const normalized = String(signedSyndromeText || "").normalize("NFKC");
  if (!normalized.trim()) return undefined;
  const evidence = String(affirmedEvidenceText || "").normalize("NFKC");
  const matched = (template.syndromeRefinements || []).flatMap((refinement) => {
    const hits = refinement.syndromeMatchAny.filter((term) => normalized.includes(term));
    if (hits.length === 0) return [];
    const gate = refinement.additionalEvidenceAny || [];
    // 证据门槛同时看已签名结论与阳性病历事实：证候文本里写了「恶寒重发热轻」同样算数。
    if (gate.length > 0 && !gate.some((term) => evidence.includes(term) || normalized.includes(term))) return [];
    return [{ refinement, weight: Math.max(...hits.map((term) => term.length)) }];
  });
  if (matched.length === 0) return undefined;
  return matched.sort((left, right) =>
    right.weight - left.weight || left.refinement.id.localeCompare(right.refinement.id))[0].refinement;
}

/**
 * 逐穴的来源、权威等级与终审状态（2026-08-11）。
 *
 * 此前对外只有一个拼起来的 `protocolSource` 字符串——两三个来源 ID 用「、」连在一起，
 * 集成方看不出**哪个穴来自哪个来源**、也看不出等级，更看不出有没有分歧。
 * 而这三件事恰恰决定了对方要不要展示、以什么等级展示、能不能采纳。
 *
 * 粒度必须到穴位，因为主穴与加减穴来自不同来源：主穴出自病种模板的 sourceRefs
 * （多为国标操作规范 / 地方诊疗方案），加减穴出自证型配穴规则的 sourceRefs
 * （少数有针灸学会标准，多数只有项目治理教材表）。
 */
/**
 * **只管操作、不管取穴**的来源。这些进 protocolSource 与整条方案的最高等级没问题
 * （安全边界确实由它们背书），但**不能**用来给某个穴位的"凭什么取这个穴"定级。
 *
 * 2026-08-11 对抗性复核：普通风寒咳嗽六个主穴全部报 regulatory_primary（国家标准/规范），
 * 而它们唯一的取穴依据是 2021 咳嗽专家共识——国标 GB/T 针刺操作规范规定的是进针、
 * 补泻、深度与感染控制，一个穴位都没规定。集成方按 authorityTier 决定采纳等级，
 * 这是实打实的过度声称。
 */
const TECHNIQUE_ONLY_SOURCE_IDS = new Set([
  "SRC-SAMR-ACUPUNCTURE-OPS",
  "SRC-TCM-INFECTION-CONTROL",
]);

/** 取穴依据的等级：把纯操作规范类来源排掉再算；全被排掉时回落到原集合（不凭空降级）。 */
function pointSelectionAuthorityTier(sourceRefs: readonly string[]): TcmSourceAuthorityTier {
  const selection = sourceRefs.filter((ref) => !TECHNIQUE_ONLY_SOURCE_IDS.has(ref));
  return highestTcmSourceAuthorityTier(selection.length > 0 ? selection : sourceRefs);
}

export function tcmTreatmentPointProvenance(
  template: TcmTreatmentPlanTemplate,
  refinement: TcmTreatmentSyndromeRefinement | undefined,
  /** 本例实际触发的条件加穴。不传时行为与此前完全一致。 */
  conditionalPoints: readonly TcmTreatmentConditionalPoint[] = [],
): TcmTreatmentPointProvenance[] {
  const baseRefs = [...template.sourceRefs];
  const baseTier = pointSelectionAuthorityTier(baseRefs);
  const records: TcmTreatmentPointProvenance[] = template.sitesOrPoints.map((point) => ({
    point,
    role: "base_point" as const,
    sourceRefs: baseRefs,
    authorityTier: baseTier,
    // 主穴属病种模板，不经证型终审台账；它的可用性由模板本身的治理状态决定。
    adjudicationStatus: "approved" as const,
    conflictNote: null,
  }));
  // 条件加穴与证型加减正交：无论本例有没有命中证型加减，触发了就要记一条，
  // 且必须记在**它自己的来源**上——风池来自北京市卫健委健康指导，不是咳嗽共识的主穴行。
  const basePointNames = new Set(template.sitesOrPoints);
  for (const conditional of conditionalPoints) {
    if (basePointNames.has(conditional.point)) continue;
    records.push({
      point: conditional.point,
      role: "conditional_point",
      sourceRefs: [...conditional.sourceRefs],
      authorityTier: pointSelectionAuthorityTier(conditional.sourceRefs),
      adjudicationStatus: "approved",
      // V1 兼容投影会把 conditional_point 折叠成 syndrome_refinement（新增枚举不得破坏 V1）。
      // 折叠之后 role 已经说不清它是什么了，所以触发说明必须写在**不被折叠**的字段上，
      // 否则 V1 侧会把"本例症状触发的条件加穴"读成"按证型加减新增的穴"。
      conflictNote: `条件加穴：${conditional.triggerNote}。非证型加减穴，按本例当前症状触发。`,
    });
  }
  if (!refinement) return records;
  const refRefs = [...refinement.sourceRefs];
  // 组合推导的条目**不得继承来源等级**：它引用的来源里没有一条与之逐字相同的原文
  //（中医师 2026-08-11 终审：「不能写成教材存在一条完全相同的原文」）。
  // 等级封顶在 project_governed_source，与「本项目自行组合、可核对但非原文照录」如实对应。
  const refTier = refinement.sourceDerivation === "combination_inference"
    ? "project_governed_source" as const
    : pointSelectionAuthorityTier(refRefs);
  const adjudication = tcmRefinementAdjudication(refinement.id);
  const pending = new Set(adjudication.pendingPoints);
  // 已在主穴里的穴**不再作为证型加穴**记一条。候选穴位列表早就按这条去重了
  //（capabilities 层 filter !basePoints.includes），逐穴溯源这一路漏了：
  // HIS 会拿到两条「太渊」，一条 base_point、一条 syndrome_refinement，
  // 于是一个所有证型都在扎的主穴被标成了本证型特有配穴——又一次同判据只铺了一处。
  const basePoints = new Set([...template.sitesOrPoints, ...conditionalPoints.map((item) => item.point)]);
  for (const point of refinement.addPoints) {
    if (basePoints.has(point)) continue;
    records.push({
      point,
      role: "syndrome_refinement",
      sourceRefs: refRefs,
      authorityTier: refTier,
      adjudicationStatus: adjudication.adjudicationStatus,
      // 逐穴分歧优先于整条说明：台账点名了哪个穴有分歧，就把说明挂在那个穴上。
      conflictNote: adjudication.adjudicationStatus === "approved"
        ? null
        : (pending.size > 0 && !pending.has(point) ? null : adjudication.conflictNote),
    });
  }
  for (const point of refinement.removePoints || []) {
    records.push({
      point,
      role: "syndrome_removal",
      sourceRefs: refRefs,
      authorityTier: refTier,
      // 剔除是**保守方向**，未终审也照常执行（见 capabilities 层的注释），因此不标 pending。
      adjudicationStatus: "approved",
      conflictNote: null,
    });
  }
  return records;
}

/**
 * 该模板的 sitesOrPoints 是否**真的是穴位/部位**（甲方评测 2026-08-04 9.1）。
 *
 * 目录里有三条模板把「点哪儿由别处决定」写进了 sitesOrPoints 字段：
 *   moxibustion-influenza-hunan-2025      → 「按针刺方案中与当前证型匹配的穴位」
 *   thread-embedding-obesity-…-assessment → 「具体埋线穴位须经专科查体和辨证确认」
 *   bloodletting-influenza-…-specialist   → 「点刺或刺络部位须由专科医师按证型现场确定」
 * 它们是**延期说明**，不是穴位。呈现层照单全收，于是医生看到的「常用穴位」是一句话
 * （生产实测：产后头痛例灸法卡片的常用穴位 = 「按针刺方案中与当前证型匹配的穴位」）——
 * 甲方原话「推荐治疗项目应列出常用穴位」指的正是这个。
 *
 * 判据取目录自带的 parameterCompleteness 字段，不做任何文本识别：该字段以
 * `points_require_syndrome_selection` / `points_require_exam` / `site_requires_exam` 结尾时，
 * 目录自己声明这条模板的穴位/部位尚未治理。
 * `exact_points_require_exam`（针刺骨骼肌肉痛：局部阿是穴 + 循经远端穴）**不在此列**——
 * 它给出的是受治理的取穴范围，精确定位才需查体，属于正常的临床表述。
 */
export function tcmTreatmentTemplatePointsAreGoverned(template: TcmTreatmentPlanTemplate): boolean {
  const completeness = String(template.parameterCompleteness || "");
  if (completeness.endsWith("exact_points_require_exam")) return true;
  return !(
    completeness.endsWith("points_require_syndrome_selection") ||
    completeness.endsWith("points_require_exam") ||
    completeness.endsWith("site_requires_exam")
  );
}

/** True when every governed template of the project legitimately has no acupoints/sites
 *  (e.g. 食疗法/意疗法 regimen-style projects). Such projects must not be rejected for an
 *  empty suggestedSitesOrPoints list in a governed plan. */
export function tcmTreatmentProjectIsPointFree(code: string): boolean {
  const definition = PROJECT_BY_CODE.get(code as TcmTreatmentProjectCode);
  if (!definition || definition.planTemplates.length === 0) return false;
  return definition.planTemplates.every((template) => template.sitesOrPoints.length === 0);
}

const GENERIC_CLINIC_ASSESSMENT_POSITIONING = "可由本机构医生结合现场查体和禁忌复核后决定是否开展。";

/** Keep clinically material boundaries, but hide the identical card boilerplate from the UI/report. */
export function tcmTreatmentAssessmentPositioningForDisplay(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized !== GENERIC_CLINIC_ASSESSMENT_POSITIONING ? normalized : undefined;
}
