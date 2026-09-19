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
assert.match(visible, /中医辨病循证依据/);
assert.match(visible, /中医辨证循证依据/);
assert.match(visible, /西医鉴别诊断/);
assert.doesNotMatch(visible, /参考文献[^\n]*appliesTo/);

// 医生页面的「标签 ↔ 字段」配对与对外接口文档一致（甲方 2026-09-17/18「辨病依据、辨证依据对不上」）。
// 页面没有渲染测试设施，这里钉**标签与它渲染的那个字段在同一处**，而不只是两个字符串各自出现。
const pairings = [
  [/<ClinicalCitationLinks label="中医辨病循证依据" citations=\{reasoning\.overview\.tcmDiseaseReferences\} \/>/, "国标病名引用 = 辨病循证依据"],
  [/<ClinicalCitationLinks label="中医辨证循证依据" citations=\{reasoning\.overview\.tcmSyndromeReferences\} \/>/, "国标证候引用 = 辨证循证依据"],
  [/辨病依据：<\/span>\{tcmDiseaseRationale\}/, "辨病依据 = tcmDiseaseRationale"],
  [/辨证依据：<\/span>\{tcmRationale\}/, "辨证依据 = tcmDiagnosticRationale"],
];
for (const [pattern, why] of pairings) assert.match(client, pattern, why);
assert.match(client, /const tcmRationale = isDisplayableClinicalText\(reasoning\.overview\.tcmDiagnosticRationale/,
  "tcmRationale 必须读 tcmDiagnosticRationale，上面那条配对才成立");
for (const stale of [/label="中医辨病依据"/, /label="中医辨证依据"/, /辨病推理：<\/span>/, /辨证推理：<\/span>/]) {
  assert.doesNotMatch(client, stale, `页面不得再出现交叉的旧标题：${stale}`);
}

// 接口文档 §5.1 与页面必须给同一个字段同一个名字：两边各自命名，正是这次「对不上」的来源。
// 上面钉的是页面侧的配对，这里钉文档侧的同一组配对，任何一边单独改名都会变红。
const apiDoc = readFileSync(new URL("../docs/中医CDSS-对外接口文档.md", import.meta.url), "utf8");
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
for (const [label, path] of [
  ["中医辨病依据", "overview.tcmDiseaseRationale"],
  ["中医辨证依据", "overview.tcmDiagnosticRationale"],
  ["中医辨病循证依据", "overview.tcmDiseaseReferences[]"],
  ["中医辨证循证依据", "overview.tcmSyndromeReferences[]"],
]) {
  assert.match(apiDoc, new RegExp(`^\\| ${escapeRegExp(label)} \\| \`${escapeRegExp(path)}\``, "m"), `接口文档 §5.1：${label} ↔ ${path}`);
}

console.log(JSON.stringify({ suite: "diagnosis-citation-presentation", checks: 23, failures: 0 }));
