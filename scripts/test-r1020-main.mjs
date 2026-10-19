// 10/19 第八轮（主控）：教材行名补分组前缀。代理各自的修复在 test-r1020-<领域>.mjs。
//
//   1 厥证「实证/虚证」行拼上分组：气厥实证、气厥虚证、血厥实证、血厥虚证（X-C-0123/0173 主证只写「实证/虚证」）；
//     痰厥、暑厥与其他病的行名不变（对照）

import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const check = async (name, run) => {
  cases += 1;
  try {
    await run();
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const t = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");

await check("1.1 厥证的气厥/血厥行以「气厥实证」「血厥虚证」命名并能按全名查到；痰厥、哮病肺虚证照旧（对照）", () => {
  assert.deepEqual(t.textbookRowForSyndrome("厥证", "气厥实证")?.formulas, ["通关散", "五磨饮子"]);
  assert.deepEqual(t.textbookRowForSyndrome("厥证", "血厥虚证")?.formulas, ["独参汤", "人参养荣汤"]);
  assert.equal(t.textbookRowForSyndrome("厥证", "痰厥")?.syndromeName, "痰厥");
  assert.equal(t.textbookRowForSyndrome("哮病", "肺虚证")?.syndromeName, "肺虚证");
  const names = t.textbookCandidatesForCase({ chiefComplaint: "突然昏倒", presentHistory: "情志刺激后突然昏倒，不省人事，四肢厥冷，呼吸气粗", sex: "男", ageYears: 40, preferredDiseases: ["厥证"] })
    .flatMap((disease) => disease.rows.map((row) => row.syndromeName));
  assert.ok(names.includes("气厥实证") && !names.includes("实证"), JSON.stringify(names));
});

console.log(JSON.stringify({ suite: "r1020-main", cases, failures: process.exitCode ? "see above" : 0 }));
