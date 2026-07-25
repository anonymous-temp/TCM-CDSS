import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": `${process.cwd()}/src` },
});
const {
  auditPrescriptionWithLingxi,
  isMechanicallyPreventableAuditIssue,
  normalizeAuditOutcomeForPatient,
} = await jiti.import("../src/lib/rxaudit.ts");

function prescriptionState({ sex = "男", pastHistory = "否认肝肾功能不全", allergyHistory, medicationHistory, rows }) {
  return {
    patient: { sex, age: 46 },
    chiefComplaint: "入睡困难、多梦易醒三个月",
    ...(pastHistory ? { pastHistory } : {}),
    allergyHistory,
    medicationHistory,
    tongue: "舌淡，边有齿痕，苔薄白",
    pulse: "脉细弱",
    diagnosis: "## 西医诊断\n失眠障碍\n\n## 中医辨证结论\n证型：心脾两虚证",
    prescription: [
      "## 中药饮片处方",
      "| 药名 | 剂量 |",
      "|---|---|",
      ...rows.map(([name, dose]) => `| ${name} | ${dose} |`),
    ].join("\n"),
    reasoningPrescribe: {
      stage: "prescribe",
      formula: {
        candidates: [{
          herbs: rows.map(([name, dose]) => ({
            name,
            dose,
            processing: null,
            decoctionRequirement: null,
          })),
          decoction: {
            doseCount: "5剂",
            dosesPerDay: 1,
            administrationTimesPerDay: 2,
            course: "5日",
            method: "每日1剂，水煎2次，早晚分服",
            followUpNode: "完成5剂后复诊",
          },
        }],
      },
    },
    conversation: [],
  };
}

const baselineRows = [
  ["黄芪", "15g"],
  ["白术", "10g"],
  ["茯苓", "15g"],
  ["酸枣仁", "15g"],
  ["龙眼肉", "12g"],
  ["木香", "6g"],
  ["甘草", "6g"],
];

const probes = [
  {
    name: "baseline-negative-history",
    state: prescriptionState({
      allergyHistory: "否认药物及食物过敏",
      medicationHistory: "否认当前西药、中成药和其他中药",
      rows: baselineRows,
    }),
  },
  {
    name: "omitted-negative-history-control",
    state: prescriptionState({
      pastHistory: "",
      allergyHistory: "否认药物及食物过敏",
      medicationHistory: "否认当前西药、中成药和其他中药",
      rows: baselineRows,
    }),
  },
  {
    name: "male-pregnancy-filter",
    state: prescriptionState({
      allergyHistory: "未发现明确药物过敏",
      medicationHistory: "当前未服其他药物",
      rows: baselineRows,
    }),
  },
  {
    name: "high-dose-pressure",
    state: prescriptionState({
      allergyHistory: "否认药物过敏",
      medicationHistory: "否认当前用药",
      rows: baselineRows.map(([name, dose]) => name === "甘草" ? [name, "60g"] : [name, dose]),
    }),
  },
];

const results = [];
for (const probe of probes) {
  const startedAt = Date.now();
  const raw = await auditPrescriptionWithLingxi(probe.state);
  assert.equal(
    raw.ok,
    true,
    `${probe.name}: the live audit service must return a usable result (reason=${raw.reason || "unknown"}, source=${raw.source || "unknown"}, durationMs=${Date.now() - startedAt})`,
  );
  assert.equal(raw.degraded, false, `${probe.name}: the live audit result must not be degraded`);
  const effective = normalizeAuditOutcomeForPatient(raw, probe.state.patient.sex);
  const ids = effective.issues.map((issue) => issue.issueId).filter(Boolean);
  assert.equal(ids.length, effective.issues.length, `${probe.name}: every provider issue must preserve or receive an issue id`);
  assert.equal(new Set(ids.map((id) => id.toUpperCase())).size, ids.length, `${probe.name}: issue ids must remain unique after normalization`);
  assert.equal(effective.issues.some((issue) => issue.issueIdGenerated === true || /^LOCAL-/i.test(String(issue.issueId || ""))), false, `${probe.name}: live Lingxi issues must retain real provider issue ids`);
  assert.equal(
    raw.issues.some((issue) => /妊娠|孕妇|孕期/.test(`${issue.title} ${issue.description}`)),
    false,
    `${probe.name}: the provider must not emit a female-only warning for a confirmed male patient`,
  );
  if (probe.name === "baseline-negative-history") {
    assert.equal(
      raw.issues.some((issue) => issue.issueType === "COMORBIDITY"),
      false,
      "an explicitly negated disease history must not become a positive comorbidity alert",
    );
  }
  const applicable = effective.issues;
  assert.equal(
    applicable.some((issue) => issue.issueType === "TCM_DECOCTION_METHOD" && isMechanicallyPreventableAuditIssue(issue)),
    true,
    `${probe.name}: the intentionally omitted 木香后下 instruction must remain a detected positive control`,
  );
  assert.equal(
    applicable.some((issue) => issue.issueType === "DOSE_OVER"),
    probe.name === "high-dose-pressure",
    `${probe.name}: only the 60g 甘草 pressure probe should trigger DOSE_OVER`,
  );
  results.push({
    name: probe.name,
    durationMs: Date.now() - startedAt,
    auditResult: effective.auditResult,
    highestRiskLevel: effective.highestRiskLevel,
    needManualReview: effective.needManualReview,
    issueCount: effective.issues.length,
    issues: effective.issues.map((issue) => ({
      issueId: issue.issueId,
      issueIdGenerated: issue.issueIdGenerated === true,
      riskLevel: issue.riskLevel,
      issueType: issue.issueType,
      title: issue.title,
      description: issue.description,
      action: issue.action,
      suggestions: issue.suggestions,
      evidence: issue.evidence,
      patientApplicability: issue.patientApplicability,
      relatedItemNos: issue.relatedItemNos,
    })),
  });
}

console.log(JSON.stringify({ probes: results.length, failures: 0, results }, null, 2));
