import lexiconSource from "../data/tcm-inspection-lexicon.json";

/**
 * 望诊受控词表（面象 / 舌象 / 脉象）的运行时入口。
 *
 * 这份词表同时服务两条路，而它们必须是同一份数据：
 *   1. 页面上医生点选的候选项（分组、正常项）
 *   2. 后台判断「这条舌象/脉象/面象到底记没记」的识别面
 *
 * 两条路分家的后果是可证的：字典里有「舌体颤动」「络脉青紫」，而后台的具体性判定是手写正则，
 * 于是医生点了词、后台判为**未记录**，输出净化器再把它改写成「舌象待核实」。
 * 实测该字典 80 个词条里后台原本认不出 27 个舌象词与「平脉」。
 *
 * 医生仍可自由输入：词表只是**补充**识别面，不是白名单。自由文本继续走 clinical-state.ts
 * 原有的形态学正则（舌淡红、苔薄白、脉细弦无力…），两者取并集。
 */

export type InspectionField = "face" | "tongue" | "pulse";

type LexiconGroup = { name: string; terms: string[] };
type LexiconAxis = {
  axis: string;
  field: InspectionField;
  normal: string;
  normalLabel: string;
  groups: LexiconGroup[];
};

const lexicon = lexiconSource as {
  schemaVersion: string;
  sourceFile: string;
  sourceSha256: string;
  termCount: number;
  axes: LexiconAxis[];
};

export const TCM_INSPECTION_AXES: readonly LexiconAxis[] = lexicon.axes;

const axisByField = new Map<InspectionField, LexiconAxis>(
  lexicon.axes.map((axis) => [axis.field, axis]),
);

/** 页面用：某一轴的全部分组与候选词，顺序与甲方字典一致。 */
export function inspectionLexiconGroups(field: InspectionField): readonly LexiconGroup[] {
  return axisByField.get(field)?.groups || [];
}

/** 页面用：某一轴的「正常」表述（面色正常 / 淡红舌，薄白苔 / 平脉）。 */
export function inspectionLexiconNormal(field: InspectionField): string {
  return axisByField.get(field)?.normal || "";
}

/**
 * 该轴的全部可识别字面，含正常项。按长度降序，保证「舌尖点刺」不会先被「舌尖红」的前缀截胡
 * ——匹配只做包含判断，但排序影响 matchedInspectionTerms 的报告顺序与调试可读性。
 */
function axisTerms(field: InspectionField): string[] {
  const axis = axisByField.get(field);
  if (!axis) return [];
  return [
    axis.normal,
    ...axis.groups.flatMap((group) => group.terms),
  ].filter(Boolean).sort((left, right) => right.length - left.length);
}

const termsByField = new Map<InspectionField, string[]>(
  (["face", "tongue", "pulse"] as const).map((field) => [field, axisTerms(field)]),
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 词表识别正则。给 clinical-state.ts 的具体性判定作**并集补充**：它需要知道
 * 「最后一个具体事实出现在哪个下标」，所以这里必须给出可定位的全局正则，而不是布尔判断。
 */
const patternByField = new Map<InspectionField, RegExp>(
  (["face", "tongue", "pulse"] as const).map((field) => [
    field,
    new RegExp((termsByField.get(field) || []).map(escapeRegExp).join("|")),
  ]),
);

export function inspectionLexiconPattern(field: InspectionField): RegExp {
  return patternByField.get(field) as RegExp;
}

/** 文本里命中的受控词条，供后台回写结构化字段与调试使用。 */
export function matchedInspectionTerms(text: unknown, field: InspectionField): string[] {
  const value = typeof text === "string" ? text : "";
  if (!value.trim()) return [];
  return (termsByField.get(field) || []).filter((term) => value.includes(term));
}

/** 该字面是否是本轴的受控词条（页面点选值的精确回读）。 */
export function isControlledInspectionTerm(value: unknown, field: InspectionField): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return false;
  return (termsByField.get(field) || []).includes(text);
}

export const TCM_INSPECTION_LEXICON_META = {
  schemaVersion: lexicon.schemaVersion,
  sourceFile: lexicon.sourceFile,
  sourceSha256: lexicon.sourceSha256,
  termCount: lexicon.termCount,
} as const;
