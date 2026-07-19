export function controlledDoseCount(value: string): number | undefined {
  const match = value.trim().match(/^(\d+)剂$/);
  const count = Number(match?.[1]);
  return Number.isInteger(count) && count >= 1 && count <= 30 ? count : undefined;
}

export function controlledCourseDays(value: string): number | undefined {
  const match = value.trim().match(/^(\d+)(日|天|周)$/);
  const amount = Number(match?.[1]);
  if (!Number.isInteger(amount) || amount < 1) return undefined;
  const days = match?.[2] === "周" ? amount * 7 : amount;
  return days >= 1 && days <= 90 ? days : undefined;
}

export function prescriptionRegimenIssue(doseCount: unknown, course: unknown): string | undefined {
  if (typeof doseCount !== "string" || controlledDoseCount(doseCount) == null) return "dose_count";
  if (typeof course !== "string" || controlledCourseDays(course) == null) return "course";
  return controlledDoseCount(doseCount) === controlledCourseDays(course)
    ? undefined
    : "course_inconsistent";
}

export type PrescriptionRegimenDto = {
  doseCount: string;
  doseCountValue: number;
  course: string;
  courseDays: number;
  dosesPerDay: 1;
  administration: string;
  followUpNode: string;
};

export function prescriptionRegimenContractIssue(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "regimen_missing";
  const raw = value as Record<string, unknown>;
  const doseCount = typeof raw.doseCount === "string" ? raw.doseCount.trim() : "";
  const course = typeof raw.course === "string" ? raw.course.trim() : "";
  const baseIssue = prescriptionRegimenIssue(doseCount, course);
  if (baseIssue) return baseIssue;

  const administration = typeof raw.method === "string" ? raw.method.trim() : "";
  if (!administration) return "method_daily_dose";
  const dailyDoseCounts = dailyDoseCountsFromMethod(administration);
  const structuredDailyDoseCount = typeof raw.dailyDoseCount === "number" ? raw.dailyDoseCount : undefined;
  if (structuredDailyDoseCount != null && (!Number.isInteger(structuredDailyDoseCount) || structuredDailyDoseCount !== 1)) {
    return "method_daily_dose";
  }
  if (structuredDailyDoseCount == null && dailyDoseCounts.length === 0) return "method_daily_dose";
  if (dailyDoseCounts.some((count) => count !== 1)) return "method_daily_dose";

  const followUpNode = typeof raw.followUpNode === "string" ? raw.followUpNode.trim() : "";
  if (!followUpNode) return "follow_up_inconsistent";
  const doseCountValue = controlledDoseCount(doseCount);
  const courseDays = controlledCourseDays(course);
  if (doseCountValue == null || courseDays == null) return "regimen_invalid";
  const followUpAfterDoses = typeof raw.followUpAfterDoses === "number" ? raw.followUpAfterDoses : undefined;
  const followUpAfterDays = typeof raw.followUpAfterDays === "number" ? raw.followUpAfterDays : undefined;
  const hasStructuredFollowUp = followUpAfterDoses != null || followUpAfterDays != null;
  if (hasStructuredFollowUp) {
    if (!Number.isInteger(followUpAfterDoses) || followUpAfterDoses !== doseCountValue) return "follow_up_inconsistent";
    if (!Number.isInteger(followUpAfterDays) || followUpAfterDays !== courseDays) return "follow_up_inconsistent";
    if (explicitFollowUpConflicts(followUpNode, doseCountValue, courseDays)) return "follow_up_inconsistent";
  } else if (!followUpMatchesRegimen(followUpNode, doseCountValue, courseDays)) {
    return "follow_up_inconsistent";
  }
  return undefined;
}

function dailyDoseCountsFromMethod(value: string): number[] {
  const normalized = value.replace(/\s+/g, "");
  const matches = normalized.matchAll(/(?:(?:每日|每天|日)(\d+|[一二三四五六七八九十])剂|(\d+|[一二三四五六七八九十])剂\/(?:日|天))/g);
  const chinese: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return Array.from(matches, (match) => {
    const token = match[1] || match[2];
    return /^\d+$/.test(token) ? Number(token) : chinese[token];
  }).filter((count) => Number.isInteger(count) && count > 0);
}

function followUpMatchesRegimen(value: string, doseCount: number, courseDays: number): boolean {
  const normalized = value.replace(/\s+/g, "");
  if (!/复诊|复核|随访/.test(normalized)) return false;
  const doseMatches = Array.from(normalized.matchAll(/完成(\d+)剂后/g));
  if (doseMatches.some((match) => Number(match[1]) !== doseCount)) return false;
  const timeMatches = Array.from(normalized.matchAll(/(?:第|完成)?(\d+)(日|天|周)(?:后)?(?:复诊|复核|随访)/g));
  if (timeMatches.some((match) => {
    const days = Number(match[1]) * (match[2] === "周" ? 7 : 1);
    return !Number.isFinite(days) || days < 1 || days !== courseDays;
  })) return false;
  return doseMatches.length > 0 || timeMatches.length > 0 || /疗程(?:结束|完成)后(?:复诊|复核|随访)/.test(normalized);
}

function explicitFollowUpConflicts(value: string, doseCount: number, courseDays: number): boolean {
  const normalized = value.replace(/\s+/g, "");
  const doseMatches = Array.from(normalized.matchAll(/完成(\d+)剂后/g));
  if (doseMatches.some((match) => Number(match[1]) !== doseCount)) return true;
  const timeMatches = Array.from(normalized.matchAll(/(?:第|完成)?(\d+)(日|天|周)(?:后)?(?:复诊|复核|随访)/g));
  return timeMatches.some((match) => {
    const days = Number(match[1]) * (match[2] === "周" ? 7 : 1);
    return !Number.isFinite(days) || days < 1 || days !== courseDays;
  });
}

export function prescriptionRegimenFromDecoction(value: unknown): PrescriptionRegimenDto | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const doseCount = typeof raw.doseCount === "string" ? raw.doseCount.trim() : "";
  const course = typeof raw.course === "string" ? raw.course.trim() : "";
  const administration = typeof raw.method === "string" ? raw.method.trim() : "";
  const followUpNode = typeof raw.followUpNode === "string" ? raw.followUpNode.trim() : "";
  const doseCountValue = controlledDoseCount(doseCount);
  const courseDays = controlledCourseDays(course);
  if (prescriptionRegimenContractIssue(value) ||
      doseCountValue == null ||
      courseDays == null) {
    return null;
  }
  return {
    doseCount,
    doseCountValue,
    course,
    courseDays,
    dosesPerDay: 1,
    administration,
    followUpNode,
  };
}

export function prescriptionRegimenSummary(regimen: PrescriptionRegimenDto): string {
  return `处方计划：共${regimen.doseCount}，疗程${regimen.course}，每日${regimen.dosesPerDay}剂；服法：${regimen.administration}；复诊节点：${regimen.followUpNode}`;
}
