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
const { checkFinalRationaleClaims } = await jiti.import("../../src/lib/m03-final-rationale-claims.server");
const { parsePatientClaimRemovals, patientClaimFields } = await jiti.import("../../src/lib/m03-patient-claim-check.server");
const { validateRationalePair } = await jiti.import("../../src/lib/m03-final-rationale-validation.server");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const [savedPath, replyPath, ...flags] = process.argv.slice(2);
if (!savedPath || !replyPath || flags.some((flag) => flag !== "--revision")) {
  console.error("用法：node scripts/audit/final-rationale-offline.mjs <保存输出.json> <模型回复.json|--prompt-only> [--revision]");
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
    let result;
    if (!context) {
      result = { ok: false, reasons: [{ code: "ineligible_snapshot", field: "$" }] };
    } else if (replyPath === "--prompt-only") {
      result = finalRationaleMessages(context);
    } else {
      const draft = validateRationalePair(fs.readFileSync(replyPath, "utf8"), context, { revision: flags.includes("--revision") });
      result = draft;
      if (draft.ok) {
        const stub = process.env.R1067_CLAIM_REMOVALS || "[]";
        const claims = stub === "unavailable" ? undefined : JSON.parse(stub);
        if (claims !== undefined && !Array.isArray(claims)) throw new Error("R1067_CLAIM_REMOVALS 需为片段数组或 unavailable");
        const { verdict, ...telemetry } = await checkFinalRationaleClaims(draft, context, new AbortController().signal,
          async (content, recordText) => claims && parsePatientClaimRemovals(JSON.stringify({ claims }), patientClaimFields(JSON.parse(content), "tcm"), recordText));
        result = { ...verdict, ...telemetry };
      }
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof SyntaxError ? "输入文件不是合法 JSON。" : error instanceof Error ? error.message : "离线验收失败。");
    process.exitCode = 2;
  }
}
