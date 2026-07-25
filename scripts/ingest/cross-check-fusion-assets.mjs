export function crossCheckFusionAssets({ differentiationRules, formulaDiscriminationGraph, formulaAliases }) {
  const requirements = [
    ["systematicReviewDimensions", differentiationRules.systematicReviewDimensions.length, 10],
    ["pulsePatterns", differentiationRules.pulsePatterns.length, 16],
    ["tonguePatterns", differentiationRules.tonguePatterns.length, 11],
    ["tonguePulseConflictRules", differentiationRules.tonguePulseConflictRules.length, 5],
    ["coldHeatEvidenceDimensions", differentiationRules.coldHeatEvidenceDimensions.length, 8],
    ["sixChannelFormulaRules", differentiationRules.sixChannelFormulaRules.length, 8],
    ["combinedDiseaseRules", differentiationRules.combinedDiseaseRules.length, 11],
    ["treatmentOrderRules", differentiationRules.treatmentOrderRules.length, 4],
    ["discriminationQuestions", differentiationRules.rules.length, 35],
    ["formulaNodes", formulaDiscriminationGraph.nodes.length, 55],
    ["formulaEdges", formulaDiscriminationGraph.edges.length, 45],
    ["formulaAliases", formulaAliases.entries.length, 9],
  ];
  const failed = requirements.filter(([, actual, minimum]) => actual < minimum);
  if (failed.length > 0) {
    throw new Error(`Nihaisha fusion coverage gate failed: ${failed.map(([name, actual, minimum]) => `${name}=${actual}<${minimum}`).join(", ")}`);
  }
  const connected = new Set(formulaDiscriminationGraph.edges.flatMap((edge) => [edge.from, edge.to]));
  const reviewQueue = formulaDiscriminationGraph.nodes
    .filter((node) => !connected.has(node.formulaName))
    .map((node) => ({
      type: "unconnected_formula_node",
      formulaName: node.formulaName,
      sourceRefs: node.sourceRefs,
      action: "补充有来源的相邻方证鉴别边；未补前节点只可检索，不参与自动收敛。",
    }));
  return {
    requirements: Object.fromEntries(requirements.map(([name, actual, minimum]) => [name, { actual, minimum, passed: actual >= minimum }])),
    reviewQueue,
  };
}
