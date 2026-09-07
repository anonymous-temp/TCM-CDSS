import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { buildM03DiagnosticReviewPrompt } = await jiti.import("../src/lib/m03-diagnostic-review.ts");
const { clinicalContextForAuthoring } = await jiti.import("../src/lib/m05-followup-authoring.server.ts");
let checks = 0;
const failures = [];
async function check(name, fn) {
  checks++;
  try { await fn(); } catch (error) { failures.push({ name, message: error.message }); }
}

await check("unrelated organ examples do not crowd out core case review", () => {
  const prompt = buildM03DiagnosticReviewPrompt("主诉：皮肤瘙痒3天", {});
  for (const marker of ["呼吸与睡眠疾病要额外校准", "急性神经血管事件", "风湿/骨关节急性发作", "呼吸—心源性交叉", "中老年新发或进行性排便"]) {
    assert.ok(!prompt.includes(marker), marker);
  }
  for (const marker of ["主诉主症锚定审计", "当前阳性事实覆盖审计", "事实极性", "正式诊断标准", "unknown", "病机总结投影一致性审计"]) assert.ok(prompt.includes(marker), marker);
});
await check("optional review covers context and candidate mentions without diagnosing from keywords", () => {
  for (const [context, candidate, marker] of [
    ["主诉：夜间憋醒", {}, "呼吸与睡眠疾病要额外校准"],
    ["主诉：身体不适", { westernDiagnosis: { primary: { name: "支气管哮喘" } } }, "呼吸与睡眠疾病要额外校准"],
    ["否认头痛；舌脉未知", {}, "急性神经血管事件"],
    ["关节痛", {}, "风湿/骨关节急性发作"],
    ["便秘", {}, "中老年新发或进行性排便"],
  ]) assert.ok(buildM03DiagnosticReviewPrompt(context, candidate).includes(marker), marker);
});
await check("M05 receives bounded supplied course and lifestyle, including explicit unknown", () => {
  const state = { chiefComplaint: "咳嗽", symptoms: { presentHistory: "咳嗽逐日减轻，夜间仍醒。", tcmDetail: "睡眠未知；日常饮水少。" } };
  const context = clinicalContextForAuthoring(state, "肺气不宣", "肺失宣降", "宣肺", [], "3天后");
  assert.ok(context.includes(state.symptoms.presentHistory));
  assert.ok(context.includes(state.symptoms.tcmDetail));
  assert.ok(context.includes("未提供的生活习惯与症状状态保持未知"));
  const huge = clinicalContextForAuthoring({ ...state, symptoms: { presentHistory: "病程".repeat(10000), tcmDetail: "饮食".repeat(10000) } }, "", "", "", [], "");
  assert.ok(huge.length < 5000);
});
console.log(JSON.stringify({ checks, failures }, null, 2));
if (failures.length) process.exitCode = 1;
