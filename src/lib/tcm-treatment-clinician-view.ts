import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { safeDietAdviceForDisplay } from "./result-display-policy";
import { isConcreteClinicianDietPlan } from "./tcm-diet-plan-contract";
import { tcmTreatmentProjectIsPointFree } from "./tcm-treatment-projects";

type NonPharma = NonNullable<ClinicalReasoningResultV2["nonPharma"]>;
type TreatmentRecommendation = NonPharma["tcmTreatments"][number];

export type ClinicianTreatmentProject = {
  projectCode: TreatmentRecommendation["projectCode"];
  title: string;
  content: string;
  sitesOrPoints?: string[];
  schedule?: string;
  precautions?: string[];
  implementationRequirement?: string;
};

// 这是医生端输出卫生黑名单，不参与任何临床推断。用拼接串而不是中文候选正则字面量，
// 避免被误当成新的临床语义词表；真正的临床准入仍只由后台治理对象决定。
const INTERNAL_GOVERNANCE_TEXT = new RegExp(
  "病种模板|证型模板|未按证型加减|仅项目评估|" +
  "政府发布方案|国家标准(?:/规范)?|来源权威|安全边界|操作禁忌与资质|" +
  "待终审|待中医师签字|协议缺口|catalog_[a-z_]+|" +
  "(?:由|须|请).{0,12}(?:现场)?(?:医生|医师).{0,12}(?:确认|复核|实施)|" +
  "不形成(?:患者级)?操作计划|进入.{0,8}评估",
  "iu",
);

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function cleanList(values: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const item = cleanText(value);
    if (!item || seen.has(item)) return [];
    seen.add(item);
    return [item];
  });
}

function containsInternalGovernanceText(value: string): boolean {
  return INTERNAL_GOVERNANCE_TEXT.test(value);
}

const NON_ACTIONABLE_PRECAUTION = /^(?:(?:核对|确认|排除)(?:相关)?(?:资质|禁忌|操作禁忌|风险|资质与操作禁忌)|操作前评估)$/;

function cleanedPrecautions(item: TreatmentRecommendation): string[] {
  return cleanList([
    ...(Array.isArray(item.requiredChecks) ? item.requiredChecks : []),
    ...cleanText(item.techniqueBoundary).split(/[。；;\n]+/),
  ]).filter((value) =>
    !containsInternalGovernanceText(value) && !NON_ACTIONABLE_PRECAUTION.test(value));
}

function cleanedOperatorRequirement(item: TreatmentRecommendation): string | undefined {
  const value = cleanText(item.operatorRequirement);
  return value && !containsInternalGovernanceText(value) ? value : undefined;
}

function attachSafeImplementationFields(
  projected: ClinicianTreatmentProject,
  item?: TreatmentRecommendation,
): ClinicianTreatmentProject {
  if (!item) return projected;
  const precautions = cleanedPrecautions(item);
  const implementationRequirement = cleanedOperatorRequirement(item);
  return {
    ...projected,
    ...(precautions.length > 0 ? { precautions } : {}),
    ...(implementationRequirement ? { implementationRequirement } : {}),
  };
}

function hasActionableSchedule(projectCode: string, value: string): boolean {
  const schedule = cleanText(value);
  if (!schedule || containsInternalGovernanceText(schedule)) return false;

  const frequencyAnchor = schedule.includes("每日") || schedule.includes("每天") ||
    schedule.includes("一日") || schedule.includes("每周") || schedule.includes("每星期") ||
    schedule.includes("隔日") || schedule.includes("每隔");
  const frequency = frequencyAnchor && /\d/.test(schedule) && schedule.includes("次");
  const dailyCumulativeDuration = /(?:每日|每天)[^。；;]{0,16}(?:累计|不少于)[^。；;]{0,8}\d[^。；;]{0,6}(?:分钟|小时)/.test(schedule);
  if (!frequency && !dailyCumulativeDuration) return false;

  if (projectCode === "auricular") {
    const duration = schedule.includes("每次") && /\d/.test(schedule) && schedule.includes("分钟");
    const replacement = schedule.includes("天") && (schedule.includes("更换") || schedule.includes("换贴"));
    return duration && replacement;
  }

  return true;
}

function isSafeProjection(project: ClinicianTreatmentProject): boolean {
  return !containsInternalGovernanceText(JSON.stringify(project));
}

function projectTreatment(
  item: TreatmentRecommendation,
): ClinicianTreatmentProject | null {
  if (item.protocolStatus === "assessment_only_no_patient_specific_protocol") return null;
  if (item.projectCode === "diet_therapy") return null;

  const sitesOrPoints = cleanList(item.suggestedSitesOrPoints);
  const schedule = cleanText(item.scheduleSuggestion);
  let projected: ClinicianTreatmentProject | null = null;

  if (item.projectCode === "auricular") {
    if (sitesOrPoints.length === 0 || !hasActionableSchedule(item.projectCode, schedule)) return null;
    projected = {
      projectCode: item.projectCode,
      title: "耳穴压豆",
      content: "按所列耳穴进行贴压",
      sitesOrPoints,
      schedule,
    };
  } else if (item.projectCode === "moxibustion") {
    if (sitesOrPoints.length === 0 || !hasActionableSchedule(item.projectCode, schedule)) return null;
    projected = {
      projectCode: item.projectCode,
      title: "灸法",
      content: "按所列穴位进行灸法调护",
      sitesOrPoints,
      schedule,
    };
  } else {
    const title = cleanText(item.projectName);
    const pointFree = tcmTreatmentProjectIsPointFree(item.projectCode);
    const sourceContent = cleanText(item.treatmentContent);
    if (!title || !hasActionableSchedule(item.projectCode, schedule)) return null;
    if (!pointFree && sitesOrPoints.length === 0) return null;
    // 对已有明确穴位/部位和排程的项目，动作本身由受控 projectName + 结构化点位确定。
    // 原 treatmentContent 即使只是模板/复核说明，也不能连坐删除这些真正有用的信息。
    const content = pointFree
      ? sourceContent
      : containsInternalGovernanceText(sourceContent) || !sourceContent
        ? `按所列穴位/部位进行${title}`
        : sourceContent;
    if (!content || containsInternalGovernanceText(content)) return null;
    projected = {
      projectCode: item.projectCode,
      title,
      content,
      ...(sitesOrPoints.length > 0 ? { sitesOrPoints } : {}),
      schedule,
    };
  }

  const safeProjected = attachSafeImplementationFields(projected, item);
  return safeProjected.title && isSafeProjection(safeProjected) ? safeProjected : null;
}

export function buildClinicianTreatmentProjects(
  nonPharma: NonPharma | null | undefined,
): ClinicianTreatmentProject[] {
  if (!nonPharma) return [];
  const diet = cleanText(safeDietAdviceForDisplay(nonPharma.diet, {}));
  const dietRecommendation = nonPharma.tcmTreatments.find((item) => item.projectCode === "diet_therapy");
  const dietSchedule = cleanText(dietRecommendation?.scheduleSuggestion);
  const dietProject: ClinicianTreatmentProject | null = isConcreteClinicianDietPlan(diet)
    ? attachSafeImplementationFields({
        projectCode: "diet_therapy",
        title: "食疗与饮食",
        content: diet,
        ...(dietSchedule && !containsInternalGovernanceText(dietSchedule) ? { schedule: dietSchedule } : {}),
      }, dietRecommendation)
    : null;
  const treatmentProjects = nonPharma.tcmTreatments.flatMap((item) => {
    const projected = projectTreatment(item);
    return projected ? [projected] : [];
  });
  return [...(dietProject && isSafeProjection(dietProject) ? [dietProject] : []), ...treatmentProjects];
}
