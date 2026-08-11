process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = "acupuncture";
const { compileTcmTreatmentRecommendations } = await import("../src/lib/tcm-treatment-capabilities.server.ts");
const signedPrior = (syndrome, pathogenesis, therapy) => ({
  stage: "diagnose",
  contractSignatureVersion: "tcm-cdss-m03-signature-v4",
  contractSignature: `hmac-sha256:${"a".repeat(64)}`,
  overview: { primarySyndrome: syndrome, overallPathogenesis: pathogenesis },
  westernDiagnosis: { primary: { name: "急性支气管炎", status: "working_diagnosis", supportingFacts: [] } },
  therapy: { overallPrinciple: therapy, overallMethod: therapy },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "咳嗽", syndromeEvidence: syndrome, pathogenesis, therapyDirection: therapy }] },
});
const run = (label, caseState, prior) => {
  const [item] = compileTcmTreatmentRecommendations([{ projectCode: "acupuncture", targetRef: "P1" }], prior, caseState);
  console.log("###", label);
  if (!item) return console.log("  (no item)");
  console.log("  points:", item.suggestedSitesOrPoints.join(" / "));
  console.log("  protocolStatus:", item.protocolStatus, "| tailoring:", item.tailoringStatus, "| gap:", item.protocolGap);
  console.log("  tier:", item.sourceAuthorityTier, "| deferred:", JSON.stringify(item.deferredGovernedTemplate));
  console.log("  provenance:", (item.pointProvenance||[]).map(p=>`${p.point}[${p.role}/${p.authorityTier}]`).join(" "));
};
run("风热咳嗽", { chiefComplaint: "咳嗽4天", symptoms: { presentHistory: "4天前起咳嗽，痰黄黏稠，咽痛口渴，微恶风。" }, clinicTreatmentCapabilities:["acupuncture"], safetyGate:{status:"ready"} },
  signedPrior("风热犯肺证", "风热犯肺，肺失清肃", "疏风清热、宣肺止咳"));
run("恢复期咳嗽（肺脾气虚）", { chiefComplaint: "咳嗽2周", symptoms: { presentHistory: "感染恢复期，咳嗽乏力，气短自汗。" }, clinicTreatmentCapabilities:["acupuncture"], safetyGate:{status:"ready"} },
  signedPrior("肺脾气虚证", "肺脾气虚", "健脾益肺"));
run("风寒咳嗽+鼻塞", { chiefComplaint: "咳嗽5天", symptoms: { presentHistory: "5天前受凉后咳嗽，痰白清稀，恶寒无汗，鼻塞流清涕。" }, clinicTreatmentCapabilities:["acupuncture"], safetyGate:{status:"ready"} },
  signedPrior("风寒袭肺证", "风寒袭肺，肺气失宣", "疏风散寒、宣肺止咳"));
