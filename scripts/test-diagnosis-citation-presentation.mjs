import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { guidelineReferenceDisplay } = await import("../src/lib/clinical-fact-source.ts");
const authority = readFileSync(new URL("../src/lib/clinical-output-authority.ts", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url), "utf8");
const visible = readFileSync(new URL("../src/lib/diagnosis-visible-summary.ts", import.meta.url), "utf8");

assert.deepEqual(
  guidelineReferenceDisplay({
    citation: "某指南（中华医学会，2025）",
    appliesTo: "本例支持说明不应混进文献",
    url: "https://example.org/guideline",
  }),
  { text: "某指南（中华医学会，2025）", href: "https://example.org/guideline" },
  "文献显示必须忽略模型适用说明，只保留标准引用与链接",
);
assert.match(authority, /TCM_DISEASE_NAME_VISIBLE_TO_CLINICIAN\s*=\s*true/);
assert.match(client, /辨病：/);
assert.match(client, /辨证：/);
assert.match(client, /tcmDiseaseReferences/);
assert.match(client, /tcmSyndromeReferences/);
assert.match(client, /guidelineReferences/);
assert.match(visible, /中医辨病依据/);
assert.match(visible, /中医辨证依据/);
assert.match(visible, /西医鉴别诊断/);
assert.doesNotMatch(visible, /参考文献[^\n]*appliesTo/);

console.log(JSON.stringify({ suite: "diagnosis-citation-presentation", checks: 10, failures: 0 }));
