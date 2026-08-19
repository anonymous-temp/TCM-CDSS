import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { normalizeReasoningV2 } = await jiti.import("../src/lib/diagnosis-types.ts");

const evidence = { evidenceLevel: "insufficient", source: "", confidence: "低" };
const standardDisease = {
  evidenceId: "STD-GBT-15657-2021",
  citation: "国家市场监督管理总局, 国家标准化管理委员会. 中医病证分类与代码: GB/T 15657-2021[S]. 2021.",
  sourceType: "standard",
};
const standardSyndrome = {
  evidenceId: "STD-GBT-16751-2-2021",
  citation: "国家市场监督管理总局, 国家标准化管理委员会. 中医临床诊疗术语 第2部分: 证候: GB/T 16751.2-2021[S]. 2021.",
  sourceType: "standard",
};
const differentialReference = {
  evidenceId: "EVID-GUIDE-001",
  citation: "American College of Gastroenterology. ACG Clinical Guideline for GERD[J]. 2022.",
  url: "https://pubmed.ncbi.nlm.nih.gov/34807007/",
  pmid: "34807007",
  sourceType: "guideline",
};

const normalized = normalizeReasoningV2({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "吐酸",
    tcmDiseaseReferences: [standardDisease],
    tcmSyndromeReferences: [standardSyndrome],
    primarySyndrome: "脾胃虚弱证",
    primarySyndromeResolution: "resolved",
    primarySyndromeBasis: ["反酸、嗳气，舌淡胖有齿痕，苔白腻"],
    overallPathogenesis: "脾胃虚弱，湿浊中阻，胃失和降",
    overallTherapy: "健脾益气，化湿和胃",
    recommendedFormulaDirection: "参苓白术散",
    evidence,
  },
  westernDiagnosis: {
    primary: {
      name: "反酸",
      status: "考虑",
      confidence: "中",
      supportingFacts: ["反酸、嗳气反复1年"],
      limitations: [],
      suggestedChecks: [],
      evidence,
    },
    differentials: [{
      name: "胃食管反流病",
      reason: "需结合胃镜与反流监测鉴别",
      distinguishingPoints: "当前仅有症状层依据",
      nextCheck: "胃镜或反流监测",
      guidelineReferences: [differentialReference],
    }],
  },
  pathogenesis: {
    summary: "脾胃虚弱，胃失和降",
    locationDifferentiation: { items: ["脾", "胃"], resolution: "resolved", evidence },
    natureDifferentiation: { items: ["气虚", "湿浊"], resolution: "resolved", evidence },
    chain: [],
    uncertainties: [],
  },
  therapy: { overallPrinciple: "标本兼治", overallMethod: "健脾益气，化湿和胃", subTherapies: [] },
  formula: null,
  nonPharma: null,
  lineageAdaptation: null,
});

assert.ok(normalized, "fixture must normalize");
assert.equal(normalized.overview.tcmDiseaseReferences?.[0]?.sourceType, "standard");
assert.equal(normalized.overview.tcmSyndromeReferences?.[0]?.evidenceId, "STD-GBT-16751-2-2021");
assert.equal(normalized.westernDiagnosis.differentials[0].guidelineReferences?.[0]?.pmid, "34807007");

console.log(JSON.stringify({ suite: "diagnostic-citation-contract", citations: 3, failures: 0 }));
