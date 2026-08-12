export const EVIDENCE_LEVELS = [
  "deterministic_rule",
  "kb_entry",
  "guideline",
  "instruction",
  "drug_label",
  "literature",
  "classic_text",
  "model_inference",
  "insufficient",
] as const;

export type EvidenceLevelValue = typeof EVIDENCE_LEVELS[number];

export const EVIDENCE_LEVEL_LABELS: Record<EvidenceLevelValue, string> = {
  deterministic_rule: "确定性规则",
  kb_entry: "标准资料",
  guideline: "指南/共识",
  instruction: "说明书",
  drug_label: "药品标签",
  literature: "文献证据",
  classic_text: "经典出处",
  model_inference: "病例内推理",
  insufficient: "证据不足",
};

export const OUTPUT_TIERS = [
  "advisory_only",
  "needs_doctor_review",
  "no_auto_prescription",
] as const;

export type OutputTierValue = typeof OUTPUT_TIERS[number];

/**
 * 医生可见正文的分节标题词表。**下游按整行精确匹配**（his-scheme.ts 的 section() 正则以
 * `^##…$` 收尾），所以这里少一个别名 = 对应模块在 HIS「AI 诊疗支持方案」里恒空。
 *
 * 2026-08-06 修复的正是这个形态，且它静默了整整一轮甲方评测：
 * 「模块改名」那次（8ef5606b）把可见标题改成了受治理输出契约登记表
 * （src/data/clinical-output-contract-registry.json，经 clinicalOutputLabel 读取）里的
 * 新名字——西医诊断倾向 / 中医诊断概览 / 病机拆解 / 治则治法 / 中成药‑西药候选——
 * 但本词表没跟着改。于是 6 个分组全部失配，HIS 方案里的诊断三卡与中成药卡**内容恒为空串**。
 * 更隐蔽的是：diagnosis-safety.ts 降级路径用的还是旧标题（## 西医诊断 / ## 中医证候诊断 /
 * ## 总体病机 / ## 治法框架 / ## 西药‑中成药方案），因此**只有报废输出能进 HIS，
 * 正常输出反而进不去**——甲方看到的「无此模块」由此而来。
 *
 * 旧标题必须保留：降级路径仍在产出它们，删掉就把降级页也一并弄空了。
 * 新增可见标题时，两处都要登记；test:his-section-coupling 会按登记表逐条核对，
 * 下一次改名如果只改一边，该套件先红。
 */
export const SECTION_TITLES = {
  redFlag: ["红旗排查", "红旗指征", "红旗风险", "红旗预警", "转诊评估", "转诊建议"],
  westernDiagnosis: ["西医诊断倾向", "现代医学风险/需排除方向", "西医诊断", "西医辨病"],
  tcmPattern: ["中医诊断概览", "中医证候诊断", "中医证候", "证候分布与病机映射"],
  mechanism: ["病机拆解", "总体病机", "总病机", "核心病机", "子病机拆解", "子病机", "治则治法", "治法框架", "治法"],
  // 「病机拆解」只登记在 mechanismOverall 一处：his-scheme 的 mechanism 卡是
  // mechanismOverall + mechanismSub + therapyFrame 三段拼接，两处都登记会把同一段抓两遍。
  mechanismOverall: ["病机拆解", "总体病机", "总病机", "核心病机"],
  mechanismSub: ["子病机拆解", "子病机"],
  therapyFrame: ["治则治法", "治法框架", "治法"],
  herbalPrescription: ["中药饮片处方", "候选方药方案", "推荐处方"],
  westernOrPatent: ["中成药/西药候选", "西药/中成药方案", "西药与中成药方案", "联合用药方案"],
  checks: ["辅助检查建议"],
  followup: ["随访管理方案", "随访方案", "随访时间轴", "时间轴"],
  followupPlan: ["随访管理方案", "随访方案"],
  followupTimeline: ["随访时间轴", "时间轴"],
  riskSummary: ["处方安全总评", "风险总评", "安全总评"],
  prescriptionRisk: ["用药风险提示", "安全校验", "处方风险提示"],
  compatibilityRisk: ["十八反十九畏与配伍禁忌"],
  adrRisk: ["ADR与不良反应风险"],
  interactionRisk: ["当前用药相互作用", "当前用药-新处方冲突", "中西药/中成药相互作用"],
  specialPopulationRisk: ["特殊人群与剂量风险", "特殊人群用药风险", "剂量风险"],
  lingxiAudit: ["合理用药审方（灵犀统一审方引擎）", "确定性处方风险复核"],
} as const;

export function sectionTitleGroup<K extends keyof typeof SECTION_TITLES>(key: K): string[] {
  return [...SECTION_TITLES[key]];
}

export const SAFETY_DEFERENCE_TEXT = "急危重风险处置和药事审方要求优先于流派偏好";
