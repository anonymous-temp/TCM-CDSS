import table from "../data/redflag-discriminators.json";

/**
 * 指南红旗判别项（2026-10-26 第二十一轮）。
 *
 * 为什么有这一层：红旗原先靠手写规则加一次长的事实抽取。规则没写到的（儿童高热伴按压不褪色紫斑、嗜睡、尿少——C075）只能靠事实层，
 * 而事实层在高负载下超时一次，这一例就只剩「需补充信息」。现在覆盖面来自指南原表，一行一条（NICE NG143 五岁以下发热红绿灯表、
 * NG253/NG254/NG255 疑似脓毒症、曼彻斯特分诊通用判别项；源表与逐字引文在 src/data/redflag-discriminators.source.json）：
 *  · 文字项由服务端小任务读病历、逐项判有没有，带病历原文引文（redflag-discriminator-screen.server.ts），两家模型同发、取并集；
 *  · 数值项（按年龄段的心率、呼吸、体温、血氧、收缩压）由这里按实测值判；
 *  · 任一红色项 → 红旗；脓毒症高危数值项 → 当天评估；五岁以下发热的琥珀色项 → 可见提示。处置口径见源表 gatePolicy。
 * 本模块只读精简运行时表（会进页面打包），不读源表。
 */

export type DiscriminatorAction = "red_flag" | "priority_24h" | "advisory";
type Row = {
  id: string;
  sourceId: string;
  level: "red" | "amber";
  kind: "text" | "numeric";
  conceptId: string;
  labelZh: string;
  population: {
    minAgeMonths?: number; maxAgeMonths?: number; minAgeYears?: number; maxAgeYears?: number;
    requiresFever?: boolean; requiresSuspectedInfection?: boolean; pregnantOrRecentlyPregnant?: boolean;
  };
  numeric?: {
    measure: string; op: ">" | ">=" | "<" | "<=" | "between"; value?: number; min?: number; max?: number;
    minAgeMonths?: number; maxAgeMonths?: number; minAgeYears?: number; maxAgeYears?: number; notPregnant?: boolean;
  };
  action: DiscriminatorAction;
};
const ROWS = (table as unknown as { rows: Row[] }).rows;
const SOURCE_LABELS = (table as unknown as { sourceLabels: Record<string, string> }).sourceLabels;
export const CONTEXT_FEVER = "ctx-fever";
export const CONTEXT_INFECTION = "ctx-infection-suspected";

/** 读病历小任务的结果，随事实层一起签名、缓存。present 只收落地的（引文逐字在病历里、是患者本人此刻的肯定提及）。 */
export type DiscriminatorScreen = {
  status: "checked" | "unavailable";
  present: Array<{ conceptId: string; quote: string }>;
  models?: string[];
};

export type DiscriminatorPatient = {
  ageMonths?: number;
  pregnant?: boolean;
};

export type DiscriminatorVitals = {
  temperature?: number | null;
  heartRate?: number | null;
  respiratoryRate?: number | null;
  spo2?: number | null;
  systolicBP?: number | null;
};

export type DiscriminatorOutcome = {
  redFlags: string[];
  priority: Array<{ text: string; focus: string }>;
  advisories: string[];
};

function ageMatches(bounds: { minAgeMonths?: number; maxAgeMonths?: number; minAgeYears?: number; maxAgeYears?: number }, ageMonths?: number): boolean {
  const hasBound = [bounds.minAgeMonths, bounds.maxAgeMonths, bounds.minAgeYears, bounds.maxAgeYears].some((value) => value != null);
  if (!hasBound) return true;
  // 年龄判不出时，带年龄上下界的行不用（儿童各档阈值差很多，猜一档等于随机）。
  if (ageMonths == null || !Number.isFinite(ageMonths)) return false;
  const months = Math.floor(ageMonths);
  const years = Math.floor(ageMonths / 12);
  if (bounds.minAgeMonths != null && months < bounds.minAgeMonths) return false;
  if (bounds.maxAgeMonths != null && months > bounds.maxAgeMonths) return false;
  if (bounds.minAgeYears != null && years < bounds.minAgeYears) return false;
  if (bounds.maxAgeYears != null && years > bounds.maxAgeYears) return false;
  return true;
}

function populationMatches(row: Row, patient: DiscriminatorPatient, context: { fever: boolean; infection: boolean } | undefined): boolean {
  if (!ageMatches(row.population, patient.ageMonths)) return false;
  if (row.population.pregnantOrRecentlyPregnant && !patient.pregnant) return false;
  // context 为 undefined：只问「这一年龄段可能用到哪些行」（给读病历的小任务列清单），前提条件交给它一起判。
  if (!context) return true;
  if (row.population.requiresFever && !context.fever) return false;
  if (row.population.requiresSuspectedInfection && !(context.infection || context.fever)) return false;
  return true;
}

/** 读病历小任务要判的文字概念：这一年龄段（与妊娠状态）可能用到的文字行，加上两个前提概念。去重后按表序。 */
export function discriminatorTextConceptsForPatient(patient: DiscriminatorPatient): string[] {
  const concepts = new Set<string>([CONTEXT_FEVER, CONTEXT_INFECTION]);
  for (const row of ROWS) {
    if (row.kind === "text" && populationMatches(row, patient, undefined)) concepts.add(row.conceptId);
  }
  return [...concepts];
}

function measured(vitals: DiscriminatorVitals, measure: string): number | undefined {
  const value = measure === "temperature" ? vitals.temperature
    : measure === "heartRate" ? vitals.heartRate
      : measure === "respiratoryRate" ? vitals.respiratoryRate
        : measure === "spo2" ? vitals.spo2
          : measure === "systolicBP" ? vitals.systolicBP
            : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numericHit(row: Row, vitals: DiscriminatorVitals, patient: DiscriminatorPatient): number | undefined {
  const rule = row.numeric;
  if (!rule) return undefined;
  if (!ageMatches(rule, patient.ageMonths)) return undefined;
  if (rule.notPregnant && patient.pregnant) return undefined;
  const value = measured(vitals, rule.measure);
  if (value === undefined) return undefined;
  const hit = rule.op === ">" ? value > (rule.value ?? Infinity)
    : rule.op === ">=" ? value >= (rule.value ?? Infinity)
      : rule.op === "<" ? value < (rule.value ?? -Infinity)
        : rule.op === "<=" ? value <= (rule.value ?? -Infinity)
          : value >= (rule.min ?? Infinity) && value <= (rule.max ?? -Infinity);
  return hit ? value : undefined;
}

const MEASURE_LABEL: Record<string, string> = {
  temperature: "体温", heartRate: "心率", respiratoryRate: "呼吸", spo2: "血氧饱和度", systolicBP: "收缩压",
};
const MEASURE_UNIT: Record<string, string> = {
  temperature: "℃", heartRate: "次/分", respiratoryRate: "次/分", spo2: "%", systolicBP: "mmHg",
};

/**
 * 判别项 → 闸门结果。同一概念只出一条（多份指南同义的行共用 conceptId）；红旗按表序，最多 3 条，其余并进第一条的「另见」。
 */
export function evaluateDiscriminators(input: {
  patient: DiscriminatorPatient;
  vitals: DiscriminatorVitals;
  screen?: DiscriminatorScreen;
}): DiscriminatorOutcome {
  const { patient, vitals, screen } = input;
  const present = new Map((screen?.status === "checked" ? screen.present : []).map((item) => [item.conceptId, item.quote]));
  const fever = present.has(CONTEXT_FEVER) || (measured(vitals, "temperature") ?? 0) >= 38;
  const infection = present.has(CONTEXT_INFECTION);
  const context = { fever, infection };
  const redByConcept = new Map<string, string>();
  const priorityByConcept = new Map<string, string>();
  const advisoryLabels: string[] = [];
  for (const row of ROWS) {
    if (!populationMatches(row, patient, context)) continue;
    const source = SOURCE_LABELS[row.sourceId] || row.sourceId;
    let message: string | undefined;
    if (row.kind === "text") {
      const quote = present.get(row.conceptId);
      if (!quote) continue;
      message = row.action === "red_flag"
        ? `${row.labelZh}（${source}红色征象），需立即急诊评估。原文依据：“${quote}”`
        : row.action === "priority_24h"
          ? `疑似感染伴脓毒症高危表现：${row.labelZh}（${source}），宜当天评估是否为脓毒症（需排除：脓毒症）；处方前需完成评估。原文依据：“${quote}”`
          : row.labelZh;
    } else {
      const value = numericHit(row, vitals, patient);
      if (value === undefined || !row.numeric) continue;
      const reading = `实测${MEASURE_LABEL[row.numeric.measure] || ""} ${value}${MEASURE_UNIT[row.numeric.measure] || ""}`;
      message = row.action === "red_flag"
        ? `${row.labelZh}（${reading}，${source}红色征象），需立即急诊评估`
        : row.action === "priority_24h"
          ? `疑似感染伴脓毒症高危指标：${row.labelZh}（${reading}，${source}），宜当天评估是否为脓毒症（需排除：脓毒症）；处方前需完成评估`
          : `${row.labelZh}（${reading}）`;
    }
    if (row.action === "red_flag" && !redByConcept.has(row.conceptId)) redByConcept.set(row.conceptId, message);
    else if (row.action === "priority_24h" && !priorityByConcept.has(row.conceptId)) priorityByConcept.set(row.conceptId, message);
    else if (row.action === "advisory" && !advisoryLabels.includes(message)) advisoryLabels.push(message);
  }
  const red = [...redByConcept.values()];
  const redFlags = red.length > 3 ? [...red.slice(0, 2), `${red[2]}；另见：${red.slice(3).map((item) => item.split("（")[0]).join("、")}`] : red;
  // 已经是红旗时，当天评估与琥珀色提示都不再单列（处置以红旗为准）。
  const priority = redFlags.length > 0 ? [] : [...priorityByConcept.values()].slice(0, 1).map((text) => ({ text, focus: "脓毒症" }));
  const advisories = redFlags.length > 0 || advisoryLabels.length === 0
    ? []
    : [`五岁以下发热患儿有指南琥珀色征象（${advisoryLabels.slice(0, 6).join("；")}；NICE NG143），需当面复核，并告知家长出现按压不褪色皮疹、叫不醒、呼吸费力等表现时立即就医`];
  return { redFlags, priority, advisories };
}

/** 两路读病历都没完成时，给医生的当面核对清单：这一年龄段的红色文字项（前 8 个）。 */
export function redFeatureChecklistForPatient(patient: DiscriminatorPatient): string[] {
  const labels: string[] = [];
  for (const row of ROWS) {
    if (row.kind !== "text" || row.action !== "red_flag" || !ageMatches(row.population, patient.ageMonths)) continue;
    if (row.population.pregnantOrRecentlyPregnant && !patient.pregnant) continue;
    const label = row.labelZh.replace(/（[^）]*）/gu, "");
    if (!labels.includes(label)) labels.push(label);
    if (labels.length >= 8) break;
  }
  return labels;
}
