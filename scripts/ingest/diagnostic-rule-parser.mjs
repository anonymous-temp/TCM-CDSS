import { bulletsAfterLabel, compactTerms, markdownSections, markdownTableRows } from "./markdown-record-parser.mjs";
import { formulaNamesInText } from "./formula-rule-parser.mjs";

const DIMENSIONS = [
  ["sleep", "睡眠", "standard"],
  ["appetite", "胃口与进食", "standard"],
  ["stool", "大便", "standard"],
  ["urination", "小便", "standard"],
  ["thirst", "口渴与饮水", "standard"],
  ["hot_cold", "寒热与手足温度", "standard"],
  ["sweating", "汗出", "standard"],
  ["energy", "体力与精神", "standard"],
  ["sexual_function", "性功能（仅在病例相关且适宜时询问）", "sensitive_context_only"],
  ["menstruation", "月经（仅对相关患者且适宜时询问）", "sensitive_context_only"],
];

function stableRows(stableMarkdown, heading, requiredColumn) {
  return markdownTableRows(stableMarkdown)
    .filter((row) => row.heading === heading && row.values[requiredColumn]);
}

function makePatternRows(stableMarkdown) {
  const pulseSimple = stableRows(stableMarkdown, "脉诊速查", "脉象").map((row) => ({
    id: `T13-PULSE-${row.line}`,
    name: row.values["脉象"],
    interpretation: row.values["主病"],
    note: row.values["备注"],
    sourceRef: `nihaixia-StableV2026.5.23/SKILL.md:${row.line}`,
    tier: "common",
  }));
  const pulseCombined = stableRows(stableMarkdown, "脉诊速查", "脉象组合").map((row) => ({
    id: `T13-PULSE-COMBINED-${row.line}`,
    name: row.values["脉象组合"],
    interpretation: row.values["主病"],
    formulaNames: formulaNamesInText(row.values["方剂"]),
    sourceRef: `nihaixia-StableV2026.5.23/SKILL.md:${row.line}`,
    tier: "common",
  }));
  const tongueSimple = stableRows(stableMarkdown, "舌诊速查", "舌象").map((row) => ({
    id: `T13-TONGUE-${row.line}`,
    name: row.values["舌象"],
    interpretation: row.values["主病"],
    sourceRef: `nihaixia-StableV2026.5.23/SKILL.md:${row.line}`,
    tier: "common",
  }));
  const tongueCombined = stableRows(stableMarkdown, "舌诊速查", "舌象组合").map((row) => ({
    id: `T13-TONGUE-COMBINED-${row.line}`,
    name: row.values["舌象组合"],
    interpretation: row.values["主病"],
    formulaNames: formulaNamesInText(row.values["方剂"]),
    sourceRef: `nihaixia-StableV2026.5.23/SKILL.md:${row.line}`,
    tier: "common",
  }));
  const conflicts = stableRows(stableMarkdown, "舌诊速查", "矛盾情况")
    .map((row) => ({
      id: `T13-TONGUE-PULSE-CONFLICT-${row.line}`,
      conflict: row.values["矛盾情况"],
      sourceHandling: row.values["处理原则"],
      runtimeHandling: "两类证据均保留并降为待复核；重复采集并结合患者症状、二便、寒热和时序后再判断。",
      sourceRef: `nihaixia-StableV2026.5.23/SKILL.md:${row.line}`,
      tier: "experience",
    }));
  return {
    pulsePatterns: [...pulseSimple, ...pulseCombined],
    tonguePatterns: [...tongueSimple, ...tongueCombined],
    tonguePulseConflictRules: conflicts,
  };
}

function coldHeatDimensions(stableMarkdown) {
  const rows = stableRows(stableMarkdown, "真寒假热 / 真热假寒 鉴别（八维法）", "项目");
  const cold = rows.slice(0, 8);
  const heat = rows.slice(8, 16);
  const heatByItem = new Map(heat.map((row) => [row.values["项目"], row]));
  return cold.map((row) => ({
    id: `T13-COLD-HEAT-${row.line}`,
    dimension: row.values["项目"],
    trueColdFalseHeat: row.values["表现"],
    trueHeatFalseCold: heatByItem.get(row.values["项目"])?.values["表现"] || "",
    runtimePolicy: "仅在患者事实明确且至少两个维度同向时参与寒热收敛；冲突或缺失保持 unknown。",
    sourceRefs: [
      `nihaixia-StableV2026.5.23/SKILL.md:${row.line}`,
      ...(heatByItem.has(row.values["项目"])
        ? [`nihaixia-StableV2026.5.23/SKILL.md:${heatByItem.get(row.values["项目"]).line}`]
        : []),
    ],
    tier: "common",
  }));
}

function combinedDiseaseRules(stableMarkdown) {
  return stableRows(stableMarkdown, "公式八：合病/并病速查", "合病类型").map((row) => ({
    id: `T13-COMBINED-${row.line}`,
    type: row.values["合病类型"],
    positiveTerms: compactTerms(row.values["核心症状"]),
    formulaNames: formulaNamesInText(row.values["方剂"]),
    sourceRef: `nihaixia-StableV2026.5.23/SKILL.md:${row.line}`,
    tier: "common",
  }));
}

function sixChannelFormulaRules(stableMarkdown) {
  const output = [];
  const sections = markdownSections(stableMarkdown)
    .filter((section) => /^公式[一二三四五六七八]：/.test(section.heading));
  for (const section of sections) {
    const sectionText = section.lines.join("\n");
    const formulaNames = formulaNamesInText(sectionText);
    output.push({
      id: `T13-SIX-CHANNEL-${section.line}`,
      title: section.heading,
      positiveTerms: compactTerms(sectionText.match(/```\s*\n?IF\s+(.+?)→/s)?.[1] || sectionText.slice(0, 240)),
      formulaNames,
      sourceRef: `nihaixia-StableV2026.5.23/SKILL.md:${section.line}`,
      tier: "common",
    });
  }
  return output;
}

function sourceRules(seedRules, symptomMarkdown, beginnerMarkdown, sixChannelMarkdown) {
  const rules = [...seedRules];
  const add = (rule) => {
    if (!rule.question || rule.triggerTerms.length === 0) return;
    const signature = `${rule.question}::${rule.resolves.join("/")}`;
    if (rules.some((item) => `${item.question}::${item.resolves.join("/")}` === signature)) return;
    rules.push(rule);
  };
  for (const row of markdownTableRows(symptomMarkdown).filter((item) => item.heading === "快速分水岭")) {
    add({
      id: `T13-WATERSHED-${row.line}`,
      triggerTerms: compactTerms(row.values["用户症状"]),
      question: row.values["第一分水岭"],
      resolves: formulaNamesInText(row.values["偏向课程模块"]).length > 0
        ? formulaNamesInText(row.values["偏向课程模块"])
        : compactTerms(row.values["偏向课程模块"]),
      discriminates: compactTerms(row.values["偏向课程模块"]),
      dimensions: ["病位", "寒热", "虚实"],
      priority: 90,
      informationGain: 1,
      sourceRefs: [`symptom-index.md:${row.line}`],
    });
  }
  for (const section of markdownSections(symptomMarkdown)) {
    const mustAsk = bulletsAfterLabel(section.lines, "必须问");
    if (mustAsk.length === 0) continue;
    const sectionText = section.lines.join("\n");
    add({
      id: `T13-MUST-ASK-${section.line}`,
      triggerTerms: compactTerms(section.heading),
      question: mustAsk.join("；"),
      resolves: formulaNamesInText(sectionText),
      discriminates: compactTerms(sectionText).slice(0, 16),
      dimensions: ["四诊合参", "缺口回补"],
      priority: 80,
      informationGain: Math.min(1, 0.45 + mustAsk.length * 0.08),
      sourceRefs: [`symptom-index.md:${section.line}`],
    });
  }
  for (const row of markdownTableRows(beginnerMarkdown).filter((item) => item.heading === "常见白话场景")) {
    add({
      id: `T13-COLLOQUIAL-${row.line}`,
      triggerTerms: compactTerms(row.values["普通用户问法"]),
      question: row.values["先问的简单问题"],
      resolves: formulaNamesInText(row.values["课程入口"]).length > 0
        ? formulaNamesInText(row.values["课程入口"])
        : compactTerms(row.values["课程入口"]),
      discriminates: compactTerms(row.values["课程入口"]),
      dimensions: ["白话入口", "信息增益"],
      priority: 60,
      informationGain: 0.7,
      sourceRefs: [`beginner-questions.md:${row.line}`],
    });
  }
  for (const section of markdownSections(sixChannelMarkdown)) {
    const mustAsk = bulletsAfterLabel(section.lines, "必须追问");
    if (mustAsk.length === 0) continue;
    const sectionText = section.lines.join("\n");
    add({
      id: `T13-SIX-MUST-ASK-${section.line}`,
      triggerTerms: compactTerms(section.heading),
      question: mustAsk.join("；"),
      resolves: formulaNamesInText(sectionText),
      discriminates: compactTerms(sectionText).slice(0, 16),
      dimensions: ["六经", "四诊合参"],
      priority: 75,
      informationGain: Math.min(1, 0.5 + mustAsk.length * 0.08),
      sourceRefs: [`six-channel.md:${section.line}`],
    });
  }
  return rules.map((rule) => ({
    priority: /^T13-(?:SOLAR|SHAOYANG|YANGMING|DIARRHEA|WATER|COLD|RESTLESSNESS)/.test(rule.id) ? 100 : 50,
    informationGain: 0.5,
    discriminates: rule.resolves,
    ...rule,
  }));
}

export function buildDiagnosticRuleAsset({
  seed,
  symptomMarkdown,
  beginnerMarkdown,
  sixChannelMarkdown,
  stableMarkdown,
}) {
  const patterns = makePatternRows(stableMarkdown);
  const treatmentOrderSection = markdownSections(stableMarkdown)
    .find((section) => section.heading === "公式八：合病/并病速查");
  const treatmentOrderRules = treatmentOrderSection
    ? bulletsAfterLabel(treatmentOrderSection.lines, "治疗先后原则").map((rule, index) => ({
        id: `T13-TREATMENT-ORDER-${index + 1}`,
        rule,
        sourceRef: `nihaixia-StableV2026.5.23/SKILL.md:${treatmentOrderSection.line}`,
        tier: "common",
      }))
    : [];
  return {
    ...seed,
    schemaVersion: "tcm-differentiation-rules-v2",
    systematicReviewDimensions: DIMENSIONS.map(([id, label, safetyClass]) => ({
      id,
      label,
      safetyClass,
      sourceRef: "nihaixia-StableV2026.5.23/SKILL.md:6065",
    })),
    coldHeatEvidenceDimensions: coldHeatDimensions(stableMarkdown),
    tonguePulseConflictPolicy: {
      ...seed.tonguePulseConflictPolicy,
      sourceClaim: "参考材料列出 5 类脉舌矛盾；运行时不得机械采用“以舌为准”的经验结论。",
    },
    ...patterns,
    sixChannelFormulaRules: sixChannelFormulaRules(stableMarkdown),
    combinedDiseaseRules: combinedDiseaseRules(stableMarkdown),
    treatmentOrderRules,
    rules: sourceRules(seed.rules, symptomMarkdown, beginnerMarkdown, sixChannelMarkdown),
  };
}
