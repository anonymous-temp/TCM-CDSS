/** 开方核对人群冲突码（herb_N_special_population_high_risk_<code>）→ 写给医生的原因。定稿剔除与交付提示同一张表。 */
const SAFETY_PRUNE_POPULATION_LABELS: Readonly<Record<string, string>> = {
  pregnancy: "孕期不宜", lactation: "哺乳期不宜", pediatric: "儿童不宜", bleeding_anticoagulation: "出血或抗凝状态不宜",
  antithrombotic_therapy: "正在用抗凝或抗血小板药，避免增强抗凝或增加出血风险",
  older_adult: "老年人不宜", hepatic_impairment: "肝功能不全不宜", renal_impairment: "肾功能不全不宜",
  cardiovascular_disease: "心血管病不宜", cardio_glaucoma_prostate: "心血管病、青光眼或前列腺增生不宜", diabetes: "糖尿病不宜",
  frailty_gastric_weakness: "体虚胃弱不宜", athlete: "运动员不宜", allergy: "与病历记录的过敏原同源",
};
export function specialPopulationConflictLabel(issue: string): string {
  const code = issue.replace(/^.*_special_population_high_risk_/u, "");
  return SAFETY_PRUNE_POPULATION_LABELS[code] || "本例特殊人群不宜";
}
