import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { clinicalContextForAuthoring } = await jiti.import("../src/lib/m05-followup-authoring.server.ts");
const { buildDiagnosePrompt } = await jiti.import("../src/lib/diagnosis-prompts.ts");
const { createInitialCaseState } = await jiti.import("../src/lib/diagnosis-types.ts");
let checks = 0;
const failures = [];
async function check(name, fn) {
  checks++;
  try { await fn(); } catch (error) { failures.push({ name, message: error.message }); }
}

await check("M05 receives bounded supplied course and lifestyle, including explicit unknown", () => {
  const state = { chiefComplaint: "咳嗽", symptoms: { presentHistory: "咳嗽逐日减轻，夜间仍醒。", tcmDetail: "睡眠未知；日常饮水少。" } };
  const context = clinicalContextForAuthoring(state, "肺气不宣", "肺失宣降", "宣肺", [], "3天后");
  assert.ok(context.includes(state.symptoms.presentHistory));
  assert.ok(context.includes(state.symptoms.tcmDetail));
  assert.ok(context.includes("未提供的生活习惯与症状状态保持未知"));
  const huge = clinicalContextForAuthoring({ ...state, symptoms: { presentHistory: "病程".repeat(10000), tcmDetail: "饮食".repeat(10000) } }, "", "", "", [], "");
  assert.ok(huge.length < 5000);
});
await check("M03 prose asks for concise interpretation and sends concerns to clinical advice", () => {
  const prompt = buildDiagnosePrompt({ ...createInitialCaseState(), chiefComplaint: "咳嗽三天" });
  assert.ok(prompt.includes("每段围绕一项关键患者事实解释其临床意义"));
  assert.ok(prompt.includes("需医生注意的疑点写成针对本例的复核建议"));
  assert.ok(!prompt.includes("仅在结构化 evidence 中标记内部证据缺口"), "model must not be asked to populate server-owned evidence");
});
console.log(JSON.stringify({ checks, failures }, null, 2));
if (failures.length) process.exitCode = 1;
