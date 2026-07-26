import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const {
  canonicalTcmDiseaseName,
  canonicalWesternDiagnosisName,
  canonicalWesternDifferentialName,
  westernDifferentialIdentity,
  withCanonicalClinicalTerminology,
} = await jiti.import("../src/lib/clinical-terminology.ts");

assert.equal(canonicalWesternDiagnosisName("失眠，障碍"), "失眠障碍");
assert.equal(canonicalWesternDiagnosisName("慢性-失眠障碍倾向"), "慢性失眠障碍");
assert.equal(canonicalWesternDiagnosisName("原发性高血压病"), "高血压");
assert.equal(canonicalWesternDiagnosisName("阻塞性睡眠呼吸暂停低通气综合征"), "阻塞性睡眠呼吸暂停");
assert.equal(canonicalWesternDifferentialName("劳力性呼吸困难待查：考虑心源性可能，需排除阻塞性睡眠呼吸暂停"), "阻塞性睡眠呼吸暂停");
assert.equal(
  westernDifferentialIdentity("劳力性呼吸困难待查：考虑心源性可能，需排除 OSAHS"),
  westernDifferentialIdentity("阻塞性睡眠呼吸暂停低通气综合征"),
  "wrapped aliases must share one differential identity",
);

const sparseContext = {
  overview: { primarySyndrome: "心脾两虚证" },
  westernDiagnosis: { primary: { name: "睡眠问题" }, differentials: [] },
};
assert.equal(canonicalTcmDiseaseName(undefined, sparseContext), undefined, "a syndrome alone must not invent a TCM disease");
assert.equal(canonicalTcmDiseaseName("失眠", sparseContext), "不寐病"); // 辩病词表(GB/T 15657)正名为不寐病,失眠为其别名(2026-07-26 词表升级)

const normalized = withCanonicalClinicalTerminology({
  overview: { primarySyndrome: "心脾两虚证", tcmDiseaseName: "失眠" },
  westernDiagnosis: {
    primary: { name: "慢性失眠障碍倾向" },
    differentials: [{ name: "OSA综合征" }],
  },
});
assert.equal(normalized.overview.tcmDiseaseName, "不寐病");
assert.equal(normalized.westernDiagnosis.primary.name, "慢性失眠障碍");
assert.equal(normalized.westernDiagnosis.differentials[0].name, "阻塞性睡眠呼吸暂停");

console.log(JSON.stringify({ cases: 10, failures: 0 }));
