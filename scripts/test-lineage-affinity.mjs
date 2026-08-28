// 流派做实（2026-08-13，甲方基线 §10.2「流派不能只是一个提示词标签」）的机制钉。
//
// 三条硬边界逐条钉住，且负向自检（撤掉守卫必须红）：
//  1) 未终审零影响：全 pending 的真实数据下，展示重排必须是恒等变换；
//  2) 展示层加分不得跨「正向充分性 × 剂量可编译」层上移，且幅度低于单个证候标签权重（6）；
//  3) 锁定路径隔离：retrieveTcmFormulaCandidatesForReasoning 与 enforceRetrievedM03FormulaSelection
//     的函数体内不得出现任何 lineage 词根——systemLockable 自动锁方读的是原始返回序。
// 另钉「三出口共用同一可展示判据」：Markdown / 医生页面 / HIS 三个文件都必须调用
// displayableLineageAdaptation，判据本体只允许存在一份。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const {
  lineageAffinityForFormula,
  applyLineageAffinityPresentationOrder,
  LINEAGE_AFFINITY_PRESENTATION_BONUS,
} = await jiti.import("../src/lib/tcm-formula-lineage-affinity.ts");
const { displayableLineageAdaptation } = await jiti.import("../src/lib/tcm-lineages.ts");
const { SAFETY_DEFERENCE_TEXT } = await jiti.import("../src/lib/cdss-vocab.ts");
const { synchronizeVisibleClinicalSummary } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const affinitySource = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-lineage-affinity.source.json", import.meta.url), "utf8"));
const governedCatalog = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-governed-catalog.json", import.meta.url), "utf8"));

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  ✗ ${name}: ${error.message}`);
  }
}

const VALID_STATUSES = new Set(["pending_clinician_review", "clinician_approved", "clinician_rejected"]);
const SCHOOL_CODES = new Set(["classical-formula", "warm-disease", "nourish-yin-danxi", "warm-tonify", "support-yang"]);

// ─── 1. 数据形状与引用完整性 ─────────────────────────────────────────────
check("bookRules 只允许五个独立流派码与合法状态", () => {
  assert.ok(affinitySource.bookRules.length >= 9);
  for (const rule of affinitySource.bookRules) {
    assert.ok(SCHOOL_CODES.has(rule.lineageCode), `非法流派码 ${rule.lineageCode}`);
    assert.ok(VALID_STATUSES.has(rule.adjudicationStatus), `非法状态 ${rule.adjudicationStatus}`);
    assert.ok(rule.confirmationMode === "rule" || rule.confirmationMode === "per_formula");
  }
});

check("逐首裁定行必须指向受治理目录里的真实方剂", () => {
  const names = new Set(governedCatalog.entries.map((entry) => entry.name));
  for (const row of affinitySource.formulaAdjudications) {
    assert.ok(names.has(row.formulaName), `裁定行「${row.formulaName}」不在受治理目录`);
    assert.ok(VALID_STATUSES.has(row.status), `非法状态 ${row.status}`);
  }
});

// ─── 2. 未终审零影响（当前数据全 pending 时这是对生产行为的直接断言）────────
const sampleCandidates = [
  { name: "乌梅丸", source: "《伤寒论》", score: 20, positiveSufficiency: true, doseCompilationEligible: true },
  { name: "三仁汤", source: "《温病条辨》", score: 18, positiveSufficiency: true, doseCompilationEligible: true },
  { name: "保和丸", source: "《丹溪心法》", score: 12, positiveSufficiency: false, doseCompilationEligible: true },
  { name: "右归丸", source: "《景岳全书》", score: 11, positiveSufficiency: false, doseCompilationEligible: true },
  { name: "某自拟方向", source: "", score: 30, positiveSufficiency: false, doseCompilationEligible: false },
];

check("全 pending 数据下重排是恒等变换（未终审零影响）", () => {
  const allPending = affinitySource.bookRules.every((rule) => rule.adjudicationStatus === "pending_clinician_review") &&
    affinitySource.formulaAdjudications.every((row) => row.status === "pending_clinician_review");
  if (!allPending) return; // 医师终审落库后本条自动退位，由下面的注入用例继续钉机制
  for (const preference of SCHOOL_CODES) {
    const { ordered, affinityByName, applied } = applyLineageAffinityPresentationOrder(sampleCandidates, preference);
    assert.deepEqual(ordered.map((item) => item.name), sampleCandidates.map((item) => item.name));
    assert.equal(affinityByName.size, 0);
    assert.equal(applied, false);
  }
  const affinity = lineageAffinityForFormula("乌梅丸", "《伤寒论》");
  assert.ok(affinity && affinity.adjudicated === false, "书规则未终审时 adjudicated 必须为 false");
});

// ─── 3. 注入终审数据后的机制行为 ─────────────────────────────────────────
const approvedData = {
  bookRules: [
    { book: "伤寒论", lineageCode: "classical-formula", confirmationMode: "rule", adjudicationStatus: "clinician_approved" },
    { book: "景岳全书", lineageCode: "warm-tonify", confirmationMode: "per_formula", adjudicationStatus: "clinician_approved" },
    { book: "医理真传", lineageCode: "support-yang", confirmationMode: "rule", adjudicationStatus: "clinician_approved" },
  ],
  formulaAdjudications: [
    { formulaName: "右归丸", source: "《景岳全书》", lineageCode: "warm-tonify", status: "clinician_approved" },
    { formulaName: "保阴煎", source: "《景岳全书》", lineageCode: "warm-tonify", status: "pending_clinician_review" },
  ],
};

check("温补与扶阳著作归属使用不同 code", () => {
  const warmTonify = lineageAffinityForFormula("右归丸", "《景岳全书》", approvedData);
  const supportYang = lineageAffinityForFormula("四逆汤", "《医理真传》", approvedData);
  assert.equal(warmTonify?.lineageCode, "warm-tonify");
  assert.equal(supportYang?.lineageCode, "support-yang");
});

check("规则级终审后：同层内小分差被加分翻越，标注齐备", () => {
  const candidates = [
    { name: "银翘散", source: "《温病条辨》", score: 10, positiveSufficiency: true, doseCompilationEligible: true },
    { name: "麻黄汤", source: "《伤寒论》", score: 9, positiveSufficiency: true, doseCompilationEligible: true },
  ];
  const { ordered, affinityByName, applied } = applyLineageAffinityPresentationOrder(candidates, "classical-formula", approvedData);
  assert.equal(applied, true);
  assert.deepEqual(ordered.map((item) => item.name), ["麻黄汤", "银翘散"], "分差 1 < 加分 2，应被翻越");
  assert.ok(affinityByName.get("麻黄汤")?.adjudicated);
});

check("加分不得跨层上移：正向充分候选永远压过带加分的非充分候选", () => {
  const candidates = [
    { name: "银翘散", source: "《温病条辨》", score: 3, positiveSufficiency: true, doseCompilationEligible: false },
    { name: "麻黄汤", source: "《伤寒论》", score: 100, positiveSufficiency: false, doseCompilationEligible: true },
  ];
  const { ordered } = applyLineageAffinityPresentationOrder(candidates, "classical-formula", approvedData);
  assert.deepEqual(ordered.map((item) => item.name), ["银翘散", "麻黄汤"], "跨层上移被禁止");
});

check("加分翻不过超出幅度的真实证据差", () => {
  const candidates = [
    { name: "银翘散", source: "《温病条辨》", score: 15, positiveSufficiency: true, doseCompilationEligible: true },
    { name: "麻黄汤", source: "《伤寒论》", score: 9, positiveSufficiency: true, doseCompilationEligible: true },
  ];
  const { ordered } = applyLineageAffinityPresentationOrder(candidates, "classical-formula", approvedData);
  assert.deepEqual(ordered.map((item) => item.name), ["银翘散", "麻黄汤"]);
});

check("逐首模式：书规则终审但方剂行 pending 时零影响；行终审后生效", () => {
  const candidates = [
    { name: "保阴煎", source: "《景岳全书》", score: 10, positiveSufficiency: false, doseCompilationEligible: true },
    { name: "右归丸", source: "《景岳全书》", score: 9, positiveSufficiency: false, doseCompilationEligible: true },
  ];
  const { ordered, affinityByName } = applyLineageAffinityPresentationOrder(candidates, "warm-tonify", approvedData);
  assert.deepEqual(ordered.map((item) => item.name), ["右归丸", "保阴煎"], "右归丸行已终审应加分上移；保阴煎行 pending 不加分");
  assert.ok(!affinityByName.has("保阴煎"), "pending 行不得出现任何标注");
});

check("unrestricted / 空偏好恒为零影响", () => {
  for (const preference of ["", "unrestricted", undefined]) {
    const { applied, affinityByName } = applyLineageAffinityPresentationOrder(sampleCandidates, preference, approvedData);
    assert.equal(applied, false);
    assert.equal(affinityByName.size, 0);
  }
});

check("加分幅度纪律：必须低于单个证候标签权重（6），否则流派能盖过证候证据", () => {
  assert.ok(LINEAGE_AFFINITY_PRESENTATION_BONUS > 0 && LINEAGE_AFFINITY_PRESENTATION_BONUS < 6);
});

// ─── 4. 锁定路径隔离（源码级、不受任何豁免）────────────────────────────────
const indicationsSource = readFileSync(new URL("../src/lib/tcm-formula-indications.ts", import.meta.url), "utf8");

function functionBody(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `找不到 ${marker}——函数被改名或删除时本判据必须显式失败而不是静默通过`);
  const rest = source.slice(start);
  const next = rest.slice(marker.length).search(/\n(?:export )?(?:async )?function |\nexport const /);
  return next >= 0 ? rest.slice(0, marker.length + next) : rest;
}

check("retrieveTcmFormulaCandidatesForReasoning 函数体不得出现 lineage 词根", () => {
  const body = functionBody(indicationsSource, "export function retrieveTcmFormulaCandidatesForReasoning(");
  assert.ok(!/lineage/i.test(body), "锁定序的产地被流派逻辑污染——systemLockable 读的就是这份返回序");
});

check("enforceRetrievedM03FormulaSelection（systemLockable 所在）不得出现 lineage 词根", () => {
  const body = functionBody(indicationsSource, "export function enforceRetrievedM03FormulaSelection(");
  assert.ok(body.includes("systemLockable"), "systemLockable 已不在该函数内，本判据需要跟着搬家");
  assert.ok(!/lineage/i.test(body), "自动锁方支路不得受流派偏好影响");
});

check("展示重排只允许两个调用点（两个 prompt 上下文构建器）", () => {
  const calls = indicationsSource.split("applyLineageAffinityPresentationOrder(").length - 1;
  assert.equal(calls, 2, `发现 ${calls} 个调用点；新增消费方前先确认它不是锁定/准入路径`);
});

// ─── 5. 三出口共用同一可展示判据 ─────────────────────────────────────────
check("Markdown/页面/HIS 三个出口都必须调用 displayableLineageAdaptation", () => {
  for (const file of [
    "../src/lib/diagnosis-visible-summary.ts",
    "../src/app/diagnosis/DiagnosisClient.tsx",
    "../src/lib/his-scheme.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(source.includes("displayableLineageAdaptation("), `${file} 未使用共用判据——判据两处各写各的是本仓库头号缺陷形状`);
  }
});

// ─── 6. 可展示判据本体 ───────────────────────────────────────────────────
check("displayableLineageAdaptation：unrestricted / 空壳 / null 一律不展示", () => {
  assert.equal(displayableLineageAdaptation(null), null);
  assert.equal(displayableLineageAdaptation({ lineageCode: "unrestricted", label: "不限定", applicabilityReason: "x" }), null);
  assert.equal(displayableLineageAdaptation({ lineageCode: "classical-formula", label: "经方思路", applicabilityReason: "", influencedDecisions: [] }), null);
});

check("displayableLineageAdaptation：完整内容正确映射且安全边界永不为空", () => {
  const display = displayableLineageAdaptation({
    lineageCode: "classical-formula",
    label: "经方思路",
    applicable: "applicable",
    applicabilityReason: "太阳表实证与方证对应",
    influencedDecisions: [{ aspect: "方源选择", detail: "优先考虑伤寒方" }, { aspect: "", detail: "无属面被剔除" }],
    safetyDeference: "",
  });
  assert.ok(display);
  assert.equal(display.applicability, "适用");
  assert.equal(display.influencedDecisions.length, 1);
  assert.equal(display.safetyBoundary, SAFETY_DEFERENCE_TEXT);
});

// ─── 7. Markdown 出口端到端：sentinel 载荷 → 报告段 ─────────────────────────
const reasoningWithLineage = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { primarySyndrome: "风寒束表证", overallPathogenesis: "风寒外束，卫阳被遏" },
  pathogenesis: { summary: "风寒外束", chain: [] },
  therapy: { overallPrinciple: "辛温解表", overallMethod: "辛温解表", subTherapies: [] },
  lineageAdaptation: {
    schemaVersion: "tcm-cdss-reasoning-v2",
    lineageCode: "classical-formula",
    label: "经方思路",
    applicable: "applicable",
    applicabilityReason: "表实无汗、脉浮紧，方证对应清楚",
    influencedDecisions: [{ aspect: "方源选择", detail: "候选方优先自《伤寒论》检索短名单中核对" }],
    unaffectedBySafety: [],
    safetyDeference: "急危重风险处置和药事审方要求优先于流派偏好",
  },
};

function sentinelContent(reasoning) {
  return `## 中医诊断概览\n占位正文\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
}

check("带 lineageAdaptation 的载荷：M03 可见报告出现「流派适配记录」段", () => {
  const output = synchronizeVisibleClinicalSummary(sentinelContent(reasoningWithLineage), "diagnose", "", null);
  assert.ok(output.includes("## 流派适配记录"), "报告缺失流派段——甲方基线 §10.2 的承诺未兑现");
  assert.ok(output.includes("经方思路"));
  assert.ok(output.includes("方源选择"));
  assert.ok(output.includes("急危重风险处置和药事审方要求优先于流派偏好"), "流派段必须携带安全让位声明");
});

check("未选流派（lineageAdaptation=null）：报告不得出现流派段", () => {
  const output = synchronizeVisibleClinicalSummary(
    sentinelContent({ ...reasoningWithLineage, lineageAdaptation: null }),
    "diagnose",
    "",
    null,
  );
  assert.ok(!output.includes("流派适配记录"), "空流派也渲染段落——unrestricted 病例会多出一个空模块");
});

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：\n${failures.map((item) => `  - ${item}`).join("\n")}`);
  process.exit(1);
}
console.log("\ntest-lineage-affinity: 全部通过");
