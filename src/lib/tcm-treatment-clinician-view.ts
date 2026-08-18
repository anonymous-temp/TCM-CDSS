import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { safeDietAdviceForDisplay } from "./result-display-policy";
import { tcmTreatmentProjectIsPointFree } from "./tcm-treatment-projects";

type NonPharma = NonNullable<ClinicalReasoningResultV2["nonPharma"]>;
type TreatmentRecommendation = NonPharma["tcmTreatments"][number];

export type ClinicianTreatmentProject = {
  projectCode: TreatmentRecommendation["projectCode"];
  title: string;
  content: string;
  sitesOrPoints?: string[];
  schedule?: string;
};

// 这是医生端输出卫生黑名单，不参与任何临床推断。用拼接串而不是中文候选正则字面量，
// 避免被误当成新的临床语义词表；真正的临床准入仍只由后台治理对象决定。
const INTERNAL_GOVERNANCE_TEXT = new RegExp(
  "病种模板|证型模板|未按证型加减|仅项目评估|" +
  "政府发布方案|国家标准(?:/规范)?|来源权威|安全边界|操作禁忌与资质|烫伤风险|" +
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

function foodExampleAfterMarker(value: string): string {
  let markerAt = -1;
  let markerLength = 0;
  const keepFirst = (at: number, length: number) => {
    if (at >= 0 && (markerAt < 0 || at < markerAt)) {
      markerAt = at;
      markerLength = length;
    }
  };
  keepFirst(value.indexOf("可适当食用"), 5);
  keepFirst(value.indexOf("可用"), 2);
  keepFirst(value.indexOf("例如"), 2);
  keepFirst(value.indexOf("比如"), 2);
  if (markerAt < 0) return "";
  return value.slice(markerAt + markerLength).split(/[，,。；;]/, 1)[0] || "";
}

function hasConcreteFoodExample(value: string): boolean {
  // 举例引导词后的短语只需是具体中文示例；不维护食物名清单，避免形成第二张临床词表。
  const example = foodExampleAfterMarker(value);
  return (example.match(/\p{Script=Han}/gu) || []).length >= 3;
}

function hasConcreteDietAction(value: string): boolean {
  // 只判“是否写成可执行句式”，不在这里判断食材、证型或功效。
  const hasQuantityOrTiming = /\d+\s*[\p{Script=Han}]{1,3}/u.test(value) || value.includes("少量多餐");
  const hasDirective = value.includes("不") || value.includes("避免") || value.includes("限制") || value.includes("减少");
  return value.length >= 16 && hasDirective && (hasQuantityOrTiming || hasConcreteFoodExample(value));
}

function hasActionableSchedule(projectCode: string, value: string): boolean {
  const schedule = cleanText(value);
  if (!schedule || containsInternalGovernanceText(schedule)) return false;

  const frequencyAnchor = schedule.includes("每日") || schedule.includes("每天") ||
    schedule.includes("一日") || schedule.includes("每周") || schedule.includes("每星期") ||
    schedule.includes("隔日") || schedule.includes("每隔");
  const frequency = frequencyAnchor && /\d/.test(schedule) && schedule.includes("次");
  if (!frequency) return false;

  if (projectCode === "auricular") {
    const duration = schedule.includes("每次") && /\d/.test(schedule) && schedule.includes("分钟");
    const replacement = schedule.includes("天") && (schedule.includes("更换") || schedule.includes("换贴"));
    return duration && replacement;
  }

  if (projectCode === "moxibustion") {
    return schedule.includes("周") && (schedule.includes("复评") || schedule.includes("疗程") || schedule.includes("连续"));
  }

  return schedule.includes("分钟") || schedule.includes("小时") || schedule.includes("复评") ||
    schedule.includes("疗程") || schedule.includes("连续");
}

function isSafeProjection(project: ClinicianTreatmentProject): boolean {
  return !containsInternalGovernanceText(JSON.stringify(project));
}

function projectTreatment(
  item: TreatmentRecommendation,
  diet: string,
): ClinicianTreatmentProject | null {
  if (item.protocolStatus === "assessment_only_no_patient_specific_protocol") return null;

  const sitesOrPoints = cleanList(item.suggestedSitesOrPoints);
  const schedule = cleanText(item.scheduleSuggestion);
  let projected: ClinicianTreatmentProject | null = null;

  if (item.projectCode === "diet_therapy") {
    if (!hasConcreteDietAction(diet) || !hasConcreteFoodExample(diet)) return null;
    projected = {
      projectCode: item.projectCode,
      title: "食疗与饮食",
      content: diet,
      ...(hasActionableSchedule(item.projectCode, schedule) ? { schedule } : {}),
    };
  } else if (item.projectCode === "auricular") {
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

  return projected.title && isSafeProjection(projected) ? projected : null;
}

export function buildClinicianTreatmentProjects(
  nonPharma: NonPharma | null | undefined,
): ClinicianTreatmentProject[] {
  if (!nonPharma) return [];
  const diet = cleanText(safeDietAdviceForDisplay(nonPharma.diet, {}));
  return nonPharma.tcmTreatments.flatMap((item) => {
    const projected = projectTreatment(item, diet);
    return projected ? [projected] : [];
  });
}
