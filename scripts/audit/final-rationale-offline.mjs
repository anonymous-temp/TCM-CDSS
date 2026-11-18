/** Offline M03 authoring prompt and validator. Accepts a saved input + diagnose.structured. */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const jiti = createJiti(import.meta.url, {
  alias: { "@": `${repo}src`, "server-only": `${repo}node_modules/next/dist/compiled/server-only/empty.js` },
});
const { normalizeCaseStateInput, normalizeReasoningV2 } = await jiti.import("../../src/lib/diagnosis-types");
const { sanitizeCaseStateForModel, withSafetyGate } = await jiti.import("../../src/lib/diagnosis-safety");
const { buildFinalRationaleContext, finalRationaleMessages } = await jiti.import("../../src/lib/m03-final-rationale-context.server");
const { validateRationalePair } = await jiti.import("../../src/lib/m03-final-rationale-validation.server");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const [savedPath, replyPath] = process.argv.slice(2);
if (!savedPath || !replyPath || process.argv.length !== 4) {
  console.error("用法：node scripts/audit/final-rationale-offline.mjs <保存输出.json> <模型回复.json|--prompt-only>");
  process.exitCode = 2;
} else {
  try {
    const saved = readJson(savedPath);
    if (!saved?.input || !saved.diagnose?.structured) throw new Error("需要 input 与 diagnose.structured");
    const input = normalizeCaseStateInput({
      ...saved.input,
      id: saved.input.id || saved.input.hisRecord?.caseId || `offline-${createHash("sha256").update(JSON.stringify(saved.input)).digest("hex").slice(0, 20)}`,
    });
    if (!input) throw new Error("input 不是合法病例对象");
    const state = sanitizeCaseStateForModel(withSafetyGate(input));
    const root = normalizeReasoningV2(saved.diagnose.structured);
    const context = root && buildFinalRationaleContext(root, state, "offline");
    const result = !context ? { ok: false, reasons: [{ code: "ineligible_snapshot", field: "$" }] } :
      replyPath === "--prompt-only" ? finalRationaleMessages(context) : validateRationalePair(readJson(replyPath), context);
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof SyntaxError ? "输入文件不是合法 JSON。" : error instanceof Error ? error.message : "离线验收失败。");
    process.exitCode = 2;
  }
}
