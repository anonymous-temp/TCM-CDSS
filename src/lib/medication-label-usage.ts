export type MedicationLabelUsage = {
  route?: string;
  singleDose?: string;
  frequency?: string;
  administrationTiming?: string;
  course?: string;
};

function clean(value: string): string {
  return value.trim().replace(/^[：:，,；;。\s]+|[：:，,；;。\s]+$/g, "");
}

export function parseMedicationLabelUsage(value: unknown): MedicationLabelUsage {
  const source = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!source) return {};
  const fragments = source.split(/[，,。；;]+/).map(clean).filter(Boolean);
  const route = fragments.find((item) => item === "口服" || item.startsWith("口服"))?.match(/^口服/)?.[0];
  const singleDose = fragments.find((item) =>
    (item.includes("一次") || item.includes("每次")) && !item.includes("一日") && !item.includes("每日"));
  const frequency = fragments.find((item) =>
    (item.includes("一日") || item.includes("每日")) && item.includes("次"));
  const administrationTiming = fragments.find((item) =>
    item.includes("饭前") || item.includes("饭后") || item.includes("餐前") || item.includes("餐后") ||
    item.includes("空腹") || item.includes("睡前") || item.includes("晨起"));
  const course = fragments.find((item) =>
    (item.includes("疗程") || item.includes("连用") || item.includes("连续服用")) &&
    (item.includes("日") || item.includes("天") || item.includes("周")));
  return {
    ...(route ? { route } : {}),
    ...(singleDose ? { singleDose } : {}),
    ...(frequency ? { frequency } : {}),
    ...(administrationTiming ? { administrationTiming } : {}),
    ...(course ? { course } : {}),
  };
}
