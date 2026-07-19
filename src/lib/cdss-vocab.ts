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
  kb_entry: "知识库",
  guideline: "指南/共识",
  instruction: "说明书",
  drug_label: "药品标签",
  literature: "文献证据",
  classic_text: "经典出处",
  model_inference: "模型推断",
  insufficient: "证据不足",
};

export const OUTPUT_TIERS = [
  "advisory_only",
  "needs_doctor_review",
  "no_auto_prescription",
] as const;

export type OutputTierValue = typeof OUTPUT_TIERS[number];

export const SECTION_TITLES = {
  redFlag: ["红旗排查", "红旗指征", "红旗风险", "红旗预警", "转诊评估", "转诊建议"],
  westernDiagnosis: ["现代医学风险/需排除方向", "西医诊断", "西医辨病"],
  tcmPattern: ["中医证候诊断", "中医证候", "证候分布与病机映射"],
  mechanism: ["总体病机", "总病机", "核心病机", "子病机拆解", "子病机", "治法框架", "治法"],
  mechanismOverall: ["总体病机", "总病机", "核心病机"],
  mechanismSub: ["子病机拆解", "子病机"],
  therapyFrame: ["治法框架", "治法"],
  herbalPrescription: ["中药饮片处方", "候选方药方案", "推荐处方"],
  westernOrPatent: ["西药/中成药方案", "西药与中成药方案", "联合用药方案"],
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

export const SAFETY_DEFERENCE_TEXT = "安全门控和审方规则优先于流派偏好";
