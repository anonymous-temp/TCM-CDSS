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

const INTERNAL_GOVERNANCE_TEXT = new RegExp([
  "病种模板",
  "证型模板",
  "未按证型加减",
  "仅项目评估",
  "政府发布方案",
  "国家标准(?:/规范)?",
  "来源权威",
  "安全边界",
  "操作禁忌与资质",
  "烫伤风险",
  "待终审",
  "待中医师签字",
  "协议缺口",
  "catalog_[a-z_]+",
  "(?:由|须|请).{0,12}(?:现场)?(?:医生|医师).{0,12}(?:确认|复核|实施)",
  "不形成(?:患者级)?操作计划",
  "进入.{0,8}评估",
].join("|"), "iu");

const DIET_ACTION_PATTERNS = [
  /少量多餐/,
  /(?:早餐|午餐|晚餐|餐后|睡前|进食后).{0,16}(?:不|勿|避免|减少|提前|间隔|控制|限制)/,
  /(?:避免|减少|限制|停用|暂停|改为).{0,20}(?:辛辣|油腻|生冷|酒|咖啡|浓茶|夜宵|甜食|高脂|刺激性食物)/,
  /(?:每日|每天|每周|一周).{0,16}(?:餐|次|份|克|毫升|碗)/,
  /(?:细嚼慢咽|定时定量|七分饱|不空腹|不平卧)/,
] as const;

const FOOD_EXAMPLE_PATTERNS = [
  /(?:可用|可选|可吃|选择|例如|如|早餐|午餐|晚餐).{0,24}[\p{Script=Han}]{1,10}(?:粥|羹|汤|饭|面|糊|菜|蔬菜|水果)/u,
  /(?:山药|小米|大米|燕麦|南瓜|莲子|薏苡仁|白扁豆|冬瓜|萝卜|白菜|菠菜|苹果|梨|香蕉|鱼|鸡蛋|豆腐)(?:[、与和及][\p{Script=Han}]{1,8}){0,3}(?:粥|羹|汤|饭|面|糊|菜)?/u,
] as const;

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

function hasConcreteDietAction(value: string): boolean {
  return DIET_ACTION_PATTERNS.some((pattern) => pattern.test(value));
}

function hasConcreteFoodExample(value: string): boolean {
  return FOOD_EXAMPLE_PATTERNS.some((pattern) => pattern.test(value));
}

function hasActionableSchedule(projectCode: string, value: string): boolean {
  const schedule = cleanText(value);
  if (!schedule || containsInternalGovernanceText(schedule)) return false;

  const frequency = /(?:每日|每天|一日|每周|每星期|隔日|每隔\d+天).{0,12}\d+(?:\s*[-–—~至]\s*\d+)?\s*次/.test(schedule);
  if (!frequency) return false;

  if (projectCode === "auricular") {
    const duration = /每次.{0,12}\d+(?:\s*[-–—~至]\s*\d+)?\s*分钟/.test(schedule);
    const replacement = /每\s*\d+(?:\s*[-–—~至]\s*\d+)?\s*天.{0,8}(?:更换|换贴)/.test(schedule);
    return duration && replacement;
  }

  if (projectCode === "moxibustion") {
    return /(?:连续\s*\d+\s*周|\d+\s*周后复评|疗程|\d+\s*次为一疗程)/.test(schedule);
  }

  return /(?:每次.{0,12}(?:分钟|小时)|\d+\s*(?:日|天|周)后复评|疗程|连续\s*\d+\s*(?:日|天|周))/.test(schedule);
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
    const content = cleanText(item.treatmentContent);
    if (!content || containsInternalGovernanceText(content) || !hasActionableSchedule(item.projectCode, schedule)) return null;
    if (!tcmTreatmentProjectIsPointFree(item.projectCode) && sitesOrPoints.length === 0) return null;
    projected = {
      projectCode: item.projectCode,
      title: cleanText(item.projectName),
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
