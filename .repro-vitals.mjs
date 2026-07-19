import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { evaluateSafetyGate, currentVitalsSummary } = await jiti.import("./src/lib/diagnosis-safety.ts");
const { normalizeCaseStateInput } = await jiti.import("./src/lib/diagnosis-types.ts");

const base = {
  patient: { sex: "男", age: 40 }, chiefComplaint: "胃脘胀满反复1月。",
  tongue: "舌淡苔薄白", pulse: "脉细",
  allergyHistory: "否认药物及食物过敏", medicationHistory: "否认当前用药",
  clinicalFacts: { redFlags: [], semanticStatus: "checked", resultSource: "fresh", reviewStatus: "checked", sourceCoverage: "full" },
};
const probes = [
  ["spo2-999-struct", { vitals: { spo2: "999" } }],
  ["spo2-999-detail", { vitals: { SpO2: "999%" } }],
  ["bp-abc", { vitals: { bloodPressure: "abc" } }],
  ["bp-abc-his", { hisRecord: { caseId: "x", capturedAt: new Date(0).toISOString(), fields: { zhushu: "胃脘胀满反复1月。", vitalsBP: "abc" }, rawText: "血压：abc" } }],
  ["t-60", { vitals: { temperature: "60℃" } }],
  ["t-60-text", { chiefComplaint: "胃脘胀满反复1月。体温60℃。" }],
  ["hr-0", { vitals: { heartRate: "0" } }],
  ["hr-0b", { vitals: { HR: "0次/分" } }],
  ["pulse-999", { vitals: { pulse: "999" } }],
  ["rr-0", { vitals: { respiratoryRate: "0" } }],
  ["spo2-88-valid", { vitals: { spo2: "88" } }],
  ["spo2-88-plus-invalid", { vitals: { spo2: "999" }, chiefComplaint: "胃脘胀满反复1月。血氧饱和度88%。" }],
];
for (const [id, extra] of probes) {
  const s = normalizeCaseStateInput({ ...base, ...extra }) || { ...base, ...extra };
  const g = evaluateSafetyGate(s);
  console.log(id, "| status:", g.status, "| summary:", currentVitalsSummary(s) || "-", "| missing:", JSON.stringify(g.missingItems.filter(i=>/复核|体征/.test(i))), "| red:", JSON.stringify(g.redFlags));
}
