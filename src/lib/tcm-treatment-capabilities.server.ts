import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import {
  TCM_TREATMENT_PROJECTS,
  getTcmTreatmentProjectDefinition,
  isKnownTcmTreatmentProjectCode,
  parseTcmTreatmentCapabilities,
  type TcmTreatmentProjectCode,
  type TcmTreatmentIndicationTag,
} from "./tcm-treatment-projects";

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

// This classifier reads only signed positive diagnosis/pathogenesis fields. Differential diagnoses,
// limitations and free-text case history are intentionally excluded so a negated differential cannot
// manufacture an indication. The catalog tag is the eligibility boundary; the score only determines
// which eligible non-executable assessment cards are shown first.
const INDICATION_PATTERNS: ReadonlyArray<readonly [TcmTreatmentIndicationTag, RegExp]> = [
  ["anorectal", /痔|肛瘘|肛裂|肛周|脱肛|直肠脱垂/],
  ["neurologic_rehabilitation", /中风后|卒中后|脑梗死恢复|脑出血恢复|偏瘫|肢体功能障碍|神经康复|运动功能恢复/],
  ["gynecology", /痛经|月经|经期|经量|闭经|崩漏|带下|胞宫|不孕|围绝经|产后/],
  ["dermatology", /湿疹|湿疮|皮炎|皮损|瘙痒|荨麻疹|银屑|痤疮|皮肤/],
  ["headache", /头痛|偏头痛|头胀|头部疼痛/],
  ["sleep_emotion", /不寐|失眠|入睡困难|易醒|多梦|焦虑|抑郁|情志|心神|烦躁/],
  ["respiratory", /咳嗽|咳痰|气喘|哮喘|肺气|肺失|支气管|呼吸|胸闷气短/],
  ["digestive", /痞满|胃脘|脘腹|腹胀|腹痛|腹泻|泄泻|便秘|纳差|反酸|烧心|呕吐|恶心|胃肠|脾胃|消化/],
  ["musculoskeletal_pain", /颈肩|腰腿|腰痛|膝痛|关节|骨关节|肌筋膜|经筋|筋骨|痹阻|痹证|活动受限|疼痛/],
  ["metabolic_rehabilitation", /肥胖|超重|糖尿病|血糖|血脂|代谢|体重|脂肪肝/],
];

const PROJECT_TAG_AFFINITY: Readonly<Partial<Record<TcmTreatmentProjectCode, Partial<Record<TcmTreatmentIndicationTag, number>>>>> = {
  acupuncture: { digestive: 70, respiratory: 75, musculoskeletal_pain: 95, neurologic_rehabilitation: 100, gynecology: 85, dermatology: 55, headache: 90, sleep_emotion: 75, metabolic_rehabilitation: 65 },
  moxibustion: { digestive: 80, respiratory: 90, musculoskeletal_pain: 75, gynecology: 100, sleep_emotion: 70, metabolic_rehabilitation: 70 },
  tuina: { digestive: 60, respiratory: 55, musculoskeletal_pain: 100, neurologic_rehabilitation: 90, metabolic_rehabilitation: 55 },
  cupping: { respiratory: 85, musculoskeletal_pain: 90 },
  guasha: { respiratory: 70, musculoskeletal_pain: 85, dermatology: 45 },
  needle_knife: { musculoskeletal_pain: 88 },
  acupoint_application: { digestive: 75, respiratory: 95, musculoskeletal_pain: 70, gynecology: 75 },
  medicated_plaster: { musculoskeletal_pain: 92 },
  fumigation_wash: { musculoskeletal_pain: 80, gynecology: 80, dermatology: 95, anorectal: 80 },
  medicated_bath: { musculoskeletal_pain: 75, dermatology: 100 },
  auricular: { digestive: 90, musculoskeletal_pain: 65, gynecology: 90, headache: 100, sleep_emotion: 95, metabolic_rehabilitation: 90 },
  thread_embedding: { respiratory: 75, musculoskeletal_pain: 75, gynecology: 75, metabolic_rehabilitation: 85 },
  medicated_ironing: { digestive: 70, musculoskeletal_pain: 80, gynecology: 70 },
  bloodletting: { musculoskeletal_pain: 65, dermatology: 65 },
  fire_cautery: { dermatology: 70, anorectal: 70 },
  hook_cutting: { musculoskeletal_pain: 70 },
  thread_drainage: { anorectal: 100 },
  ligation: { anorectal: 95 },
  diet_therapy: { digestive: 100, respiratory: 65, gynecology: 70, dermatology: 70, sleep_emotion: 80, metabolic_rehabilitation: 100 },
  mind_therapy: { sleep_emotion: 100 },
  qigong_daoyin: { respiratory: 100, musculoskeletal_pain: 80, neurologic_rehabilitation: 95, sleep_emotion: 90, metabolic_rehabilitation: 95 },
};

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
): Set<TcmTreatmentIndicationTag> {
  const local = indicationTags([node.patientFact, node.syndromeEvidence, node.pathogenesis, node.therapyDirection]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("；"));
  return local.size > 0 ? local : indicationTags(globalIndicationText(prior));
}

function clinicalAffinity(
  projectCode: TcmTreatmentProjectCode,
  tags: ReadonlySet<TcmTreatmentIndicationTag>,
): number {
  const definition = getTcmTreatmentProjectDefinition(projectCode);
  if (!definition) return 0;
  const compatible = definition.indicationTags.filter((tag) => tags.has(tag));
  if (compatible.length === 0) return 0;
  return Math.max(...compatible.map((tag) => PROJECT_TAG_AFFINITY[projectCode]?.[tag] || 50));
}

function rankedTreatmentCandidates(
  scope: CapabilityScope,
  prior: ClinicalReasoningResultV2,
  proposals: readonly ModelTreatmentProposal[],
  includeAssessmentOnlyProjects = false,
): TreatmentCandidate[] {
  const chain = Array.isArray(prior.pathogenesis?.chain) ? prior.pathogenesis.chain : [];
  const nodeById = new Map(chain.map((node, index) => [node.nodeId || `P${index + 1}`, node] as const));
  const capabilityByCode = new Map(scope.items.map((item) => [item.projectCode, item]));
  const proposedCodes = new Set(proposals.map((item) => item.projectCode));
  const scoredByKey = new Map<string, TreatmentCandidate>();
  const consider = (projectCode: TcmTreatmentProjectCode, targetRef: string, explicit: boolean) => {
    if (projectCode === "miscellaneous" || !capabilityByCode.has(projectCode)) return;
    const node = nodeById.get(targetRef);
    if (!node) return;
    const score = clinicalAffinity(projectCode, nodeIndicationTags(prior, node));
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
  caseState?: Pick<CaseState, "clinicTreatmentCapabilities" | "clinicTreatmentCapabilitiesRestricted" | "reasoningDiagnose">,
): string {
  const scope = effectiveCapabilityScope(caseState);
  const trustedPrior = isTrustedM03(caseState?.reasoningDiagnose) ? caseState.reasoningDiagnose : undefined;
  const chain = trustedPrior?.pathogenesis?.chain || [];
  const availableItems = scope.items.filter((item) => item.projectCode !== "miscellaneous");
  if (!scope.valid || chain.length === 0 || availableItems.length === 0) {
    return "【中医非药物治疗项目】当前机构未配置可推荐项目，tcmTreatments 必须输出空数组。";
  }
  const personalized = rankedTreatmentCandidates(scope, trustedPrior!, [], true).filter((item, index, all) =>
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
  caseState?: Pick<CaseState, "clinicTreatmentCapabilities" | "clinicTreatmentCapabilitiesRestricted" | "safetyGate">,
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
  const rankedPool = rankedTreatmentCandidates(scope, prior, proposals);
  const proposalPool = rankedPool.some((item) => item.explicit) ? rankedPool : rankedPool.slice(0, 2);

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
    return [{
      projectCode: definition.code,
      projectName: definition.name,
      availability: clinicAvailable ? "clinic_available" as const : "referral_only" as const,
      riskLevel: definition.risk,
      recommendationMode: specialist ? "specialist_assessment_only" as const : clinicAvailable ? "clinician_assessment" as const : "referral_assessment" as const,
      targetRef: proposal.targetRef,
      targetPathogenesis: node.pathogenesis || node.syndromeEvidence || prior.overview.overallPathogenesis,
      assessmentPositioning: specialist
        ? "仅建议由具备专项资质的医生进行适应证与可行性评估，不形成操作医嘱。"
        : medicationAssessment || (clinicAvailable
          ? "可由本机构医生结合现场查体和禁忌复核后决定是否开展。"
          : "当前仅作转介或现场评估方向，不代表本机构可开展。"),
      operatorRequirement: definition.operatorRequirement,
      requiredChecks: [
        definition.safetyFocus,
        ...(definition.requiresMedicationAudit ? ["含药外治采用前须完成成分、过敏、禁忌、相互作用及重复用药的独立用药审方。"] : []),
      ],
      containsMedication: definition.containsMedication,
      requiresMedicationAudit: definition.requiresMedicationAudit,
      executable: false as const,
      clinicianReviewRequired: true as const,
    }];
  }).slice(0, 3);
}

export function applyTcmTreatmentCapabilityPriority(
  content: string,
  caseState?: Pick<CaseState, "clinicTreatmentCapabilities" | "clinicTreatmentCapabilitiesRestricted" | "safetyGate">,
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
      monitoring: [],
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
