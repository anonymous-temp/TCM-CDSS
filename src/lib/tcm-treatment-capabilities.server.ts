import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import {
  TCM_TREATMENT_PROJECTS,
  getTcmTreatmentProjectDefinition,
  isKnownTcmTreatmentProjectCode,
  parseTcmTreatmentCapabilities,
  type TcmTreatmentProjectCode,
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
  return [
    "【中医非药物治疗项目受控候选】",
    "以下仅列出部署配置允许的项目；模型须结合已签名 M03 的患者事实、病机节点、治法、禁忌和项目风险独立判断是否适合，不需要为了凑数而推荐。标记本机构可开展的项目优先。",
    ...availableItems.slice().sort((left, right) => left.priority - right.priority).map((item) => {
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
  const proposalPool: ModelTreatmentProposal[] = [];

  for (const proposal of proposals) {
    if (proposal.projectCode === "miscellaneous") continue;
    const definition = getTcmTreatmentProjectDefinition(proposal.projectCode);
    const node = nodeById.get(proposal.targetRef);
    if (!definition || !node || !capabilityByCode.has(proposal.projectCode)) continue;
    proposalPool.push(proposal);
  }

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
  }).sort((left, right) => {
    const leftCapability = capabilityByCode.get(left.projectCode);
    const rightCapability = capabilityByCode.get(right.projectCode);
    return (leftCapability?.priority ?? 999) - (rightCapability?.priority ?? 999);
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
    specialistProjectsRequireExplicitConfiguration: true,
    ...(scope.reason ? { reason: scope.reason } : {}),
  };
}
