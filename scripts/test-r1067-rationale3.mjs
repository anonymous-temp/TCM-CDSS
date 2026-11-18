import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { finalRationaleElementContext, unsupportedRationaleElements } = await jiti.import("../src/lib/m03-final-rationale-elements.server");
const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface");

const cases = [
  ["E01", "胃痛", "肝气犯胃证", "气机郁滞", []],
  ["E02", "痰饮", "脾阳虚弱证", "水饮内停", []],
  ["E03", "悬饮", "络气不和证", "饮邪", []],
  ["E04", "感冒", "风寒束表证", "风寒犯肺、鼻窍不利", []],
  ["E05", "虚劳", "肺脾两虚证", "卫外不固", []],
  ["E06", "瘾疹", "风热犯表证", "热灼津伤", []],
  ["E07", "头痛", "血虚头痛", "气血不足", ["气虚"]],
  ["E08", "虚劳", "肺脾两虚证", "气血不足", ["血虚"]],
  ["E09", "妊娠恶阻", "脾胃气虚证", "水湿内停", ["water", "damp"]],
  ["E10", "呕吐", "胃阴亏虚证", "胃失濡润，津液亏耗", []],
  ["E11", "瘾疹", "风热犯表证", "风寒犯肺", ["cold"]],
  ["E12", "头痛", "血虚头痛", "卫外不固", ["insecurity"]],
];
let failed = false;
async function check(id, description, checkCase) {
  if (process.env.R1067_ONLY && process.env.R1067_ONLY !== id) return;
  try {
    await checkCase();
    console.log(`✓ ${id} ${description}`);
  } catch (error) {
    failed = true;
    console.error(`✗ ${id} ${description}\n${error.stack}`);
  }
}
for (const [id, tcmDiseaseName, primarySyndrome, mechanism, expected] of cases) {
  await check(id, `${tcmDiseaseName}·${primarySyndrome} ${mechanism}`, () => {
    const context = finalRationaleElementContext({ overview: { tcmDiseaseName, primarySyndrome, secondarySyndromes: [] } });
    const unsupported = new Set(unsupportedRationaleElements(mechanism, context).map(({ type }) => type));
    if (!expected.length) assert.equal(unsupported.size, 0, [...unsupported].join(","));
    else for (const type of expected) assert.ok(unsupported.has(type), [...unsupported].join(","));
  });
}
await check("E13", "旧可读性清理区分病机词和并列连词", () => {
  const tcmDiagnosticRationale = "卫表失和、津液受灼，络气不和、气机不畅。";
  const project = (stage) => projectDeliveredReasoning({
    schemaVersion: "tcm-cdss-reasoning-v2", stage,
    overview: { tcmDiagnosticRationale, tcmDiseaseRationale: "心悸和、头晕并见。" },
  }).overview;
  assert.equal(project("prescribe").tcmDiagnosticRationale, tcmDiagnosticRationale);
  assert.equal(project("prescribe").tcmDiseaseRationale, "心悸和头晕并见。");
  assert.equal(project("diagnose").tcmDiagnosticRationale, "卫表失和津液受灼，络气不和气机不畅。");
});
await check("E14", "选中教材行所载便秘与病历同向时，肠胃湿热可描述腑气不畅", () => {
  const context = finalRationaleElementContext({ overview: { tcmDiseaseName: "粉刺", primarySyndrome: "肠胃湿热证" } });
  assert.deepEqual(unsupportedRationaleElements("湿热内蕴肠胃，腑气不通", context, "大便干结。"), []);
  assert.equal(unsupportedRationaleElements("湿热内蕴肠胃，腑气不通", context, "无便秘。")[0]?.type, "bowel-excess");
});
if (failed) process.exitCode = 1;
