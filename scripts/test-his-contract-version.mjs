// HIS 契约版本协商与 V1 兼容投影（2026-08-11）。
//
// 背景：V1.4 在 `schemaVersion` 不变的前提下给 protocolStatus 加了第三个枚举值。
// 对用 Java enum / Jackson FAIL_ON_UNKNOWN / TypeScript union 反序列化的集成方，
// 这不是「多一个可忽略的值」，而是**解析直接抛异常**。在变更记录里登记「这是破坏性变更」
// 不等于没有破坏它。
//
// 本套件钉的是收敛后的三条：
//   ① V1（默认）只回旧两态，第三态向**更保守**的一侧折叠；
//   ② 两版都带 tailoringStatus，三态的真实值恒在这里，永不折叠；
//   ③ V2 显式请求时才开放真三态。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const {
  HIS_SCHEME_VERSION_IDS,
  canonicalTcmProjectProtocolStatuses,
  hisSchemeContractVersionFromRequest,
  projectHisSchemeForContractVersion,
} = await jiti.import("../src/lib/his-scheme-contract-version.ts");

const failures = [];
const check = (name, fn) => { try { fn(); } catch (error) { failures.push(`${name}: ${error.message}`); } };

const payload = (statuses) => ({
  schemaVersion: "tcm-cdss-his-ai-scheme-v1",
  treatments: {
    tcmProjects: statuses.map((protocolStatus, index) => ({
      projectCode: "acupuncture",
      projectName: `项目${index + 1}`,
      protocolStatus,
      adoptable: false,
      clinicianReviewRequired: true,
    })),
  },
});

const ALL_THREE = [
  "governed_patient_specific_plan",
  "governed_class_template_not_syndrome_tailored",
  "assessment_only_no_patient_specific_protocol",
];

check("① V1 默认只回旧两态，第三态折叠为评估态", () => {
  const source = payload(ALL_THREE);
  const out = projectHisSchemeForContractVersion(source, "v1", canonicalTcmProjectProtocolStatuses(source));
  assert.equal(out.schemaVersion, HIS_SCHEME_VERSION_IDS.v1);
  assert.deepEqual(out.treatments.tcmProjects.map((p) => p.protocolStatus), [
    "governed_patient_specific_plan",
    "assessment_only_no_patient_specific_protocol",
    "assessment_only_no_patient_specific_protocol",
  ], "V1 出参里绝不能出现第三个枚举值——旧集成方的 enum 反序列化会直接抛异常");
});

check("② 两个版本都带 tailoringStatus，且它永远是真实值", () => {
  for (const version of ["v1", "v2"]) {
    const source = payload(ALL_THREE);
    const out = projectHisSchemeForContractVersion(source, version, canonicalTcmProjectProtocolStatuses(source));
    assert.deepEqual(out.treatments.tcmProjects.map((p) => p.tailoringStatus), [
      "syndrome_tailored", "class_template_only", "assessment_only",
    ], `${version}: tailoringStatus 必须保留三态真实值，不随 protocolStatus 折叠`);
  }
});

check("③ V2 才开放真三态", () => {
  const source = payload(ALL_THREE);
  const out = projectHisSchemeForContractVersion(source, "v2", canonicalTcmProjectProtocolStatuses(source));
  assert.equal(out.schemaVersion, HIS_SCHEME_VERSION_IDS.v2);
  assert.deepEqual(out.treatments.tcmProjects.map((p) => p.protocolStatus), ALL_THREE);
});

check("折叠方向单向：评估态绝不会被提升成患者级方案", () => {
  for (const version of ["v1", "v2"]) {
    const source = payload(["assessment_only_no_patient_specific_protocol"]);
    const out = projectHisSchemeForContractVersion(source, version, canonicalTcmProjectProtocolStatuses(source));
    assert.equal(out.treatments.tcmProjects[0].protocolStatus, "assessment_only_no_patient_specific_protocol");
    assert.equal(out.treatments.tcmProjects[0].tailoringStatus, "assessment_only");
  }
});

check("投影幂等：对已投影的载荷再跑一次结果不变", () => {
  const source = payload(ALL_THREE);
  const canonical = canonicalTcmProjectProtocolStatuses(source);
  const once = projectHisSchemeForContractVersion(source, "v1", canonical);
  const twice = projectHisSchemeForContractVersion(once, "v1", canonical);
  assert.deepEqual(twice, once);
});

check("版本协商：query / header / body 三处都认，认不出一律回 V1", () => {
  const req = (url, headers = {}) => new Request(url, { headers });
  const base = "https://example.test/api/diagnosis/his-scheme";
  assert.equal(hisSchemeContractVersionFromRequest(req(base)), "v1", "缺省必须是 V1");
  assert.equal(hisSchemeContractVersionFromRequest(req(`${base}?schemaVersion=v2`)), "v2");
  assert.equal(hisSchemeContractVersionFromRequest(req(`${base}?schemaVersion=${HIS_SCHEME_VERSION_IDS.v2}`)), "v2");
  assert.equal(hisSchemeContractVersionFromRequest(req(base, { "x-cdss-his-scheme-version": "v2" })), "v2");
  assert.equal(hisSchemeContractVersionFromRequest(req(base), { hisSchemeVersion: "v2" }), "v2");
  // 拼错版本号的集成方应当拿到最保守的 V1，而不是 400——把对方打挂不是兼容策略。
  assert.equal(hisSchemeContractVersionFromRequest(req(`${base}?schemaVersion=v9`)), "v1");
  assert.equal(hisSchemeContractVersionFromRequest(req(base, { "x-cdss-his-scheme-version": "  " })), "v1");
});

check("没有诊疗项目时不产出空的 treatments 结构", () => {
  const out = projectHisSchemeForContractVersion({ schemaVersion: "tcm-cdss-his-ai-scheme-v1" }, "v1", []);
  assert.equal(out.schemaVersion, HIS_SCHEME_VERSION_IDS.v1);
  assert.equal(out.treatments, undefined);
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "his-contract-version", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "his-contract-version", checks: 7, failures: 0 }));
