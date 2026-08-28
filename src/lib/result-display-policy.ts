import { clinicalRequiredFieldLabel, clinicalRequiredFieldPolicy } from "./clinical-governance-tables";

type AuditAdvisory = {
  available: boolean;
  presentationDisabled?: boolean;
};

export type AuditReviewPresentation = {
  kind: "risk" | "unavailable";
  title: string;
  subtitle: string;
};

type MedicineCandidateContext = {
  patient?: { age?: number; sex?: string };
  chiefComplaint?: string;
  symptoms?: Record<string, unknown>;
  vitals?: Record<string, unknown>;
  pastHistory?: string;
  allergyHistory?: string;
  medicationHistory?: string;
  safetyGate?: { status?: "ready" | "needs_information" | "red_flag" };
  hisRecord?: {
    fields?: {
      xianbingshi?: string;
    };
  };
};

type ClinicalDisplayContext = MedicineCandidateContext;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function hasMeaningfulMedicationRisk(section?: string): boolean {
  const text = clean(section).replace(/\s+/g, "");
  if (!text || text === "暂无" || text === "待生成") return false;
  const concreteRiskPattern = /慎用|禁忌|相互作用|ADR|不良反应|过敏|肝肾|出血|妊娠|哺乳|儿童|老年|毒性|当前用药未知|无法评估|减量|替换|停药|转诊|强提示|一般提示|信息不足提示|待补充信息后再评估/;
  const noRiskPattern = /未见明显|未发现|暂无|无明确|无特殊/;
  const onlyNoRisk = noRiskPattern.test(text) && !concreteRiskPattern.test(text);
  if (onlyNoRisk) return false;
  return concreteRiskPattern.test(text) || /需确认|需复核/.test(text);
}

export function resolveAuditReviewPresentation(
  advisory: AuditAdvisory | null | undefined,
  content?: string,
): AuditReviewPresentation | null {
  // 审方展示被关闭时不出任何审方卡片:此时没有「未完成」可言,审方在它自己的接口与页面里。
  if (advisory?.presentationDisabled) return null;
  if (advisory?.available === false) {
    return {
      kind: "unavailable",
      title: "合理用药审查 · 本次未完成",
      subtitle: "当前结果不能视为已完成合理用药审查",
    };
  }
  const hasIssues = hasMeaningfulMedicationRisk(content) ||
    /\|\s*(?:强提示|一般提示|信息不足提示|待补充信息后再评估)\s*\|/.test(content || "");
  if (!hasIssues) return null;
  return {
    kind: "risk",
    title: "合理用药审查 · 发现风险提示",
    subtitle: "按审查问题 ID 逐条复核",
  };
}

function hasRecordedValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  return value != null;
}

function hasRecordedVitals(vitals: Record<string, unknown> | undefined): boolean {
  return Boolean(vitals && Object.values(vitals).some(hasRecordedValue));
}

function presentHistory(context: MedicineCandidateContext): string {
  const symptoms = context.symptoms || {};
  return clean(context.hisRecord?.fields?.xianbingshi) ||
    clean(symptoms.presentHistory) ||
    clean(symptoms.xianbingshi) ||
    clean(symptoms.history);
}

export function buildMedicineCandidateEmptyState(context: MedicineCandidateContext): {
  headline: string;
  explanation: string;
  action: string;
  missingFacts: string[];
} {
  const missingFacts = [
    !(typeof context.patient?.age === "number" && Number.isFinite(context.patient.age)) || !clean(context.patient?.sex)
      ? "年龄/生理状态"
      : "",
    !presentHistory(context) ? "现病史与伴随症状" : "",
    !hasRecordedVitals(context.vitals) ? "生命体征" : "",
    !clean(context.pastHistory) ? "既往史" : "",
    !clean(context.allergyHistory) ? "过敏史" : "",
    !clean(context.medicationHistory) ? "当前用药" : "",
  ].filter(Boolean);
  return {
    headline: "本次没有形成可安全展示的具体候选药物",
    explanation: "本地中成药检索未得到与本例证型/治法及症状同时匹配且可核验的条目；西药候选依赖外部说明书证据，本次未取得可绑定证据时不生成具体药名，也不会为了填满栏目生成具体药名。",
    action: missingFacts.length > 0
      ? `如需重新评估，请先补充${missingFacts.join("、")}，然后重新分析。`
      : "如需重新评估，请补充诊断分型所需信息或检查结果后重新分析。",
    missingFacts,
  };
}

export function herbCaseMeaning(herb: {
  function?: string;
  prescriptionRole?: string;
}): string {
  const functionText = clean(herb.function).replace(/[；;。]+$/g, "");
  const prescriptionRole = clean(herb.prescriptionRole).replace(/[；;。]+$/g, "");
  if (!functionText) return prescriptionRole;
  if (!prescriptionRole || functionText.includes(prescriptionRole)) return functionText;
  if (prescriptionRole.includes(functionText)) return prescriptionRole;
  return `${functionText}；${prescriptionRole}`;
}

function uniqueText(items: string[]): string[] {
  return [...new Set(items.map((item) => clean(item)).filter(Boolean))];
}

function reasoningFingerprint(value: string): string {
  return value.normalize("NFKC").replace(/[\s，,。.；;：:（）()、"'“”‘’]/g, "");
}

/** A rationale must add an explanatory link, not merely repeat the fact list in sentence form. */
export function isNonRedundantClinicalRationale(rationale: string, supportingFacts: readonly string[]): boolean {
  const reasoning = reasoningFingerprint(rationale);
  if (reasoning.length < 8) return false;
  const facts = supportingFacts.map(reasoningFingerprint).filter(Boolean);
  if (facts.some((fact) => fact === reasoning || fact.includes(reasoning))) return false;
  const copiedLength = facts.reduce((total, fact) => total + (reasoning.includes(fact) ? fact.length : 0), 0);
  const hasInferenceLink = /(?:提示|支持|符合|考虑|因而|故|结合|但|尚不能|不支持|区别于|排除)/.test(rationale);
  return hasInferenceLink && copiedLength / reasoning.length < 0.8;
}

/**
 * 「先补录再检查」这一步该点名**哪些**字段——按本例真正缺的那几项，不是一句固定话术。
 *
 * 甲方 2026-08-12 线上实测：病历已提供病程、诱因、伴随症状与既往史，这一栏仍打印
 * 「先补充病程、诱因、伴随症状及既往史，测量生命体征并完成神经系统查体。」——无效追问。
 *
 * 根因：这句话原先是一个写死的常量，而触发它的判据是「现病史非空 / 生命体征非空 /
 * 年龄是有限数」三项的**析取**——与话里点名的四项是两个不相交的集合，既往史更是
 * 从头到尾没被读过。于是只要年龄或生命体征缺一项，就照样要求补四样已经有的东西。
 *
 * 改法：缺什么说什么，且「这个字段有没有内容」读受治理必填字段矩阵的 casePaths
 * （clinical-governance-tables），本文件不另写第二份字段路径表。
 *
 * **触发条件本身刻意不动**（仍是现病史 / 生命体征 / 年龄）。把「既往史」也加进触发条件
 * 是另一回事：那会让影像分级触发得更频繁、模型给出的检查被下调得更多，是一次行为扩张，
 * 不在本次缺陷范围内。本次修的是「点名的四项与判据的三项是两个不相交的集合」。
 */
function valueAtCasePath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) =>
    (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), root);
}

/** 受治理字段在本例里有没有可用内容。判据来自矩阵的 casePaths，不在本文件写死路径。 */
export function hasGovernedClinicalFieldValue(context: unknown, fieldId: string): boolean {
  const paths = clinicalRequiredFieldPolicy(fieldId)?.casePaths || [];
  return paths.some((path: string) => {
    const value = valueAtCasePath(context, path);
    if (typeof value === "string") return Boolean(clean(value));
    // vitals 是对象：任一项被记录即算有（与 hasRecordedVitals 同一口径）。
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.values(value as Record<string, unknown>).some(hasRecordedValue);
    }
    return hasRecordedValue(value);
  });
}

/**
 * 一条建议是不是本函数自己生成的「补录首步」。
 *
 * 原先靠 `startsWith(固定前缀)` 做不动点保护；现在首步措辞随缺项变化，判据改为
 * 「以本函数的三种开头之一起头 + 以本函数的查体措辞收尾」——与生成器同源，
 * 生成器改了这里必须跟着改，不会各自漂移。
 */
const TIERED_FIRST_STEP_OPENERS = ["先补充", "测量生命体征", "完成"] as const;
const TIERED_FIRST_STEP_TAIL = /完成(?:神经系统查体|与主诉相关的体格检查)[。.]?$/;

export function isTieredFirstStep(value: string): boolean {
  const text = clean(value);
  return TIERED_FIRST_STEP_OPENERS.some((opener) => text.startsWith(opener)) &&
    TIERED_FIRST_STEP_TAIL.test(text);
}

export function buildTieredSuggestedChecks(
  context: ClinicalDisplayContext,
  checks: string[],
): string[] {
  const normalizedChecks = uniqueText(checks).map((item) => clean(item
    .replace(/(?:[；;，,]\s*)?(?:接诊时核实相关症状是否存在|当前为?(?:当前为)?有限资料下的工作判断|判断把握度(?:较)?低)[。.]?/g, "")
    .replace(/^[；;，,\s]+|[；;，,\s]+$/g, "")))
    .filter(Boolean);
  if (context.safetyGate?.status === "red_flag") return normalizedChecks;
  // 已分级过的列表再进来一次必须原样返回。这个函数曾经只在渲染时调用一次，
  // 但它的产物是可以被再次喂回来的（写回 payload、服务端二次规整都会），
  // 不做不动点保护就会出现"先补充病程…"被叠加两遍。
  if (normalizedChecks[0] && isTieredFirstStep(normalizedChecks[0])) return normalizedChecks;

  // 缺什么点名什么。判据与措辞**同源**：同一份 missing 既决定要不要插这一步，也决定这句话怎么写。
  //
  // 触发条件本身一字未动（现病史 / 生命体征 / 年龄），只是每一项额外认受治理矩阵登记的
  // casePaths——HIS 直传时生命体征在 hisRecord.fields.vitalsBP 之类的位置，
  // 原来的 hasRecordedVitals 只看 context.vitals，会把「已经量过」误判成「没量」。
  // 并集方向是**更少触发**（资料其实齐备时不再下调模型给出的检查），不会多拦任何东西。
  const missing = [
    ...(presentHistory(context) || hasGovernedClinicalFieldValue(context, "present_illness")
      ? [] : [clinicalRequiredFieldLabel("present_illness", "现病史")]),
    ...(hasRecordedVitals(context.vitals) || hasGovernedClinicalFieldValue(context, "vitals")
      ? [] : [clinicalRequiredFieldLabel("vitals", "生命体征")]),
    ...(typeof context.patient?.age === "number" && Number.isFinite(context.patient.age) ? [] : ["年龄"]),
  ];
  if (missing.length === 0) return normalizedChecks;

  const hasAdvancedTesting = normalizedChecks.some((item) =>
    /\bCT\b|MRI|磁共振|增强扫描|经颅多普勒|TCD|血管造影|CTA|MRA/i.test(item));
  const hasOtherTesting = normalizedChecks.some((item) =>
    !/\bCT\b|MRI|磁共振|增强扫描|经颅多普勒|TCD|血管造影|CTA|MRA/i.test(item));
  const nonAdvancedChecks = normalizedChecks.filter((item) =>
    !/\bCT\b|MRI|磁共振|增强扫描|经颅多普勒|TCD|血管造影|CTA|MRA/i.test(item));
  const complaint = clean(context.chiefComplaint);
  const examinationFocus = /头痛|头疼|头晕|眩晕|肢体|麻木|抽搐|意识|言语/.test(complaint)
    ? "神经系统查体"
    : "与主诉相关的体格检查";
  // 生命体征说「测量」、其余说「补充」——同一句话里两个动作各归各的，缺哪项写哪项。
  const vitalsLabel = clinicalRequiredFieldLabel("vitals", "生命体征");
  const toGather = missing.filter((label) => label !== vitalsLabel);
  const firstStep = [
    toGather.length > 0 ? `先补充${toGather.join("、")}` : "",
    missing.includes(vitalsLabel) ? `测量${vitalsLabel}` : "",
    `完成${examinationFocus}`,
  ].filter(Boolean).join("，");
  return [
    `${firstStep}。`,
    ...(hasAdvancedTesting
      ? [`若补充问诊或${examinationFocus}出现相应指征，再由接诊医生评估针对性影像学检查。`]
      : []),
    ...(hasOtherTesting ? nonAdvancedChecks : []),
  ];
}

export function safeDietAdviceForDisplay(
  advice: string,
  context: ClinicalDisplayContext,
): string {
  const text = clean(advice);
  if (!text) return text;
  const therapeuticFoodClaim = /多食|宜多食|食疗|药膳|活血化瘀|补气(?:血)?|滋阴|温阳|清热解毒|祛湿|安神(?:助眠)?|软坚散结/.test(text);
  if (!therapeuticFoodClaim) return text;
  const needsIndividualReview = !clean(context.allergyHistory) || !clean(context.medicationHistory);
  if (!needsIndividualReview) {
    return "保持规律、均衡饮食和充足饮水；不要把食疗替代诊疗或药物。具体饮食调整请由接诊医生结合基础病、过敏史和当前用药确认。";
  }
  return "保持规律、均衡饮食和充足饮水；不要把食疗替代诊疗或药物。存在基础病、过敏或正在用药时，具体饮食调整请由接诊医生结合实际情况确认。";
}

// ── 面向医生的用语：内部口径词一律不上屏（甲方 2026-08-12）────────────────────────
//
// 甲方原话：「页面仍显示『剂量来源：受治理知识库边界校验』…你要求知识库不对用户展示，
// 这句话也应删除或改为『剂量已完成规则校验』」。
//
// 这不是一处文案。全仓扫下来有 7 处**会渲染给医生看**的串带着内部口径词
//（知识库 / 受治理 / 闭集 / 受控），分布在医生页面、服务端 Markdown 与 HIS 三个出口，
// 各写各的：服务端 Markdown 有一道净化器（scrubVisibleMarkdownHead）在改写这类词，
// 但它归一到的目标恰恰还是「中药知识库」——归一到了一个同样不该上屏的词；
// 而医生页面上那几处是写死的字符串，从来不经过那道净化器。
//
// 措辞在这里定义一次，三个出口都调这里。**枚举值本身不动**：doseSource 的
// governed_boundary / classical_source / none 是 HIS 出参的机器取值（his-scheme.ts:188），
// 改它是破坏性契约变更；这里改的只是它的可见中文名。
export const DOCTOR_FACING_DOSE_SOURCE_LABEL: Readonly<Record<string, string>> = {
  governed_boundary: "剂量已完成规则校验",
  classical_source: "经典来源原方量",
  none: "未形成可执行来源",
};

export function doseSourceLabelForDisplay(doseSource: string | null | undefined): string {
  const key = String(doseSource || "").trim();
  return DOCTOR_FACING_DOSE_SOURCE_LABEL[key] || DOCTOR_FACING_DOSE_SOURCE_LABEL.none;
}

/**
 * 「本系统据以核对药材/方剂的那套标准数据」的对外说法。
 *
 * 医生要知道的是"这条信息有标准依据、不是模型现编的"，不是我们内部管它叫什么。
 */
export const GOVERNED_HERB_DATA_LABEL = "标准药材资料";
export const GOVERNED_FORMULA_DATA_LABEL = "标准方剂资料";
