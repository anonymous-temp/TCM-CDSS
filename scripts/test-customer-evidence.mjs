import assert from "node:assert/strict";

const { customerEvidenceDisplayStatus, sanitizeCustomerEvidenceDocument, sanitizeCustomerEvidenceNarrative, sanitizeInlineEvidenceClaims, sanitizeLabeledEvidenceLines, sanitizeUnverifiedClinicalNarrative } = await import("../src/lib/customer-evidence.ts");
const { buildEvidenceScope, sanitizeEvidenceObject, sourceAllowed } = await import("../src/lib/evidence-source-validation.ts");

const input = [
  "**证据依据**：待检索",
  "**证据依据**：《不存在指南》",
  "**引用来源**：虚构共识（2026）",
  "**证据依据**：[VALID-GUIDE-001]",
  "**经典方出处**：《伤寒论》",
  "",
  "| 药名 | 剂量 | 证据依据 |",
  "|---|---|---|",
  "| 甘草 | 6g | 待检索 |",
  "| 百合 | 10g | 《不存在指南》 |",
  "| 旋覆花 | 9g | 《伤寒论》 |",
  "普通临床说明应保留。",
].join("\n");

const output = sanitizeLabeledEvidenceLines(
  input,
  (source) => source.includes("VALID-GUIDE-001") || source.includes("《伤寒论》"),
);

assert.doesNotMatch(output, /待检索|不存在指南|虚构共识/);
assert.match(output, /\[VALID-GUIDE-001\]/);
assert.match(output, /《伤寒论》/);
assert.match(output, /普通临床说明应保留/);
assert.match(output, /\| 甘草 \| 6g \|\s*\|/);
assert.match(output, /\| 百合 \| 10g \|\s*\|/);
assert.match(output, /\| 旋覆花 \| 9g \| 《伤寒论》 \|/);
assert.doesNotMatch(output, /\|[^\n]*(?:待检索|不存在指南)[^\n]*\|/);

const evidenceContext = [
  "[OFFICIAL-CHP-2025] 国家药典委员会《中华人民共和国药典》2025年版 https://2025.chp.org.cn/",
  "[EVID-GUIDE-001] 《甲指南》2024 https://example.org/guide-a",
  "[EVID-GUIDE-002] 《乙指南》2025 https://example.org/guide-b",
].join("\n");
const scope = buildEvidenceScope(evidenceContext);
const mixed = sanitizeLabeledEvidenceLines([
  "| 药名 | 剂量 | 证据依据 |",
  "|---|---|---|",
  "| 酸枣仁 | 15g | [EVID-GUIDE-001]；待检索 |",
  "| 茯苓 | 12g | [EVID-GUIDE-001]；虚构共识（2026） |",
  "| 川芎 | 6g | 中国药典2035年版 |",
  "| 甘草 | 6g | [EVID-GUIDE-001] |",
  "**药典依据**：中国药典2035年版",
].join("\n"), (source) => sourceAllowed(source, undefined, scope));
assert.doesNotMatch(mixed, /待检索|虚构共识|2035/);
assert.match(mixed, /\| 甘草 \| 6g \| \[EVID-GUIDE-001\] \|/);
assert.match(mixed, /\| 酸枣仁 \| 15g \|\s*\|/);
assert.match(mixed, /\| 茯苓 \| 12g \|\s*\|/);
assert.match(mixed, /\| 川芎 \| 6g \|\s*\|/);

assert.equal(sourceAllowed("《甲指南》2025", "guideline", scope), false, "a title cannot borrow the year from another evidence record");
assert.equal(sourceAllowed("[EVID-GUIDE-001]，年份未明", "guideline", scope), false);
assert.equal(sourceAllowed("[EVID-GUIDE-001]，题名未知", "guideline", scope), false);
assert.equal(sourceAllowed("[OFFICIAL-CHP-2025]", "pharmacopoeia", scope), false, "a generic pharmacopoeia homepage cannot substantiate a concrete herb or dose");
assert.equal(sourceAllowed("[EVID-GUIDE-001]", "guideline", scope), true);
assert.equal(sourceAllowed("[EVID-GUIDE-001] 《甲指南》2024 https://example.org/guide-a", "guideline", scope), true, "a title followed by a bare HTTPS URL remains one traceable record");
assert.equal(sourceAllowed("[EVID-GUIDE-001] 阿司匹林可治愈失眠", "guideline", scope), false, "a valid evidence ID cannot authorize a claim absent from its record");
const structured = sanitizeEvidenceObject({
  evidenceLevel: "guideline",
  source: "《甲指南》2025",
  confidence: "高",
}, scope, ["guideline", "pharmacopoeia"]);
assert.equal(structured.evidenceLevel, "insufficient");
assert.equal(structured.source, "内部证据缺口");
assert.equal(customerEvidenceDisplayStatus(structured), "hidden", "internal evidence gaps must never reach customer-facing reference sections");
assert.equal(customerEvidenceDisplayStatus({ evidenceLevel: "guideline", source: "[EVID-GUIDE-001]" }), "traceable");
assert.equal(customerEvidenceDisplayStatus({ evidenceLevel: "model_inference", source: "基于本例病史与症状推断；置信度：中" }), "hidden");
assert.equal(customerEvidenceDisplayStatus({ evidenceLevel: "deterministic_rule", source: "结构化匹配规则" }), "hidden");
assert.equal(customerEvidenceDisplayStatus({ evidenceLevel: "literature", source: "PMID: 12345678" }), "traceable");
assert.equal(
  customerEvidenceDisplayStatus({ evidenceLevel: "guideline", source: "[EVID-GUIDE-001] 主诉：入睡困难、多梦易醒3个月" }),
  "hidden",
  "a valid-looking evidence ID must not turn a copied complaint into a customer-visible reference",
);
assert.equal(
  customerEvidenceDisplayStatus({ evidenceLevel: "literature", source: "患者诉头晕反复3天；PMID: 12345678" }),
  "hidden",
  "bibliographic markers must not authorize patient-narrative pollution",
);
assert.equal(customerEvidenceDisplayStatus({ evidenceLevel: "guideline", source: "待检索" }), "hidden");
assert.equal(customerEvidenceDisplayStatus(undefined), "hidden");

const narrative = sanitizeCustomerEvidenceNarrative("方义解析：本加减思路证据不足，建议待检索后复核。普通临床说明应保留。");
assert.doesNotMatch(narrative, /证据不足|待检索|内部证据缺口/);
assert.match(narrative, /医生结合本例病机/);
assert.match(narrative, /普通临床说明应保留/);

const structuredBlock = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { primarySyndrome: "心脾两虚", note: "证据不足，待检索" },
};
const protectedDocument = sanitizeCustomerEvidenceDocument([
  "正文证据不足/待检索，应隐藏。",
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify(structuredBlock, null, 2),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
const protectedJson = protectedDocument.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0].trim();
assert.deepEqual(JSON.parse(protectedJson), structuredBlock, "Markdown placeholder cleanup must never mutate structured JSON punctuation");
assert.doesNotMatch(protectedDocument.split("<!-- DIAGNOSIS_JSON_START -->")[0], /证据不足|待检索/);
const historicalNarrative = sanitizeCustomerEvidenceDocument("依据《中国药典》2020年版给出当前剂量。\n<!-- DIAGNOSIS_JSON_START -->\n" + JSON.stringify(structuredBlock, null, 2) + "\n<!-- DIAGNOSIS_JSON_END -->");
assert.match(historicalNarrative, /历史药典规则基线（不作为现行药典核验结论）/);
assert.doesNotMatch(historicalNarrative.split("<!-- DIAGNOSIS_JSON_START -->")[0], /药典[^\n]{0,20}2020|2020[^\n]{0,20}药典/);
JSON.parse(historicalNarrative.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0].trim());

const labeledStructuredDocument = sanitizeLabeledEvidenceLines([
  "**证据依据**：待检索",
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify(structuredBlock, null, 2),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"), () => false);
assert.doesNotMatch(labeledStructuredDocument.split("<!-- DIAGNOSIS_JSON_START -->")[0], /待检索/);
JSON.parse(labeledStructuredDocument.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0].trim());

const automationArtifactDocument = sanitizeCustomerEvidenceDocument([
  "药味证据：Playwright structured V2 probe",
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", source: "Playwright structured V2 probe", note: "临床内容保留" }),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
assert.doesNotMatch(automationArtifactDocument, /Playwright|自动化测试探针|回归测试结构化/);
assert.equal(JSON.parse(automationArtifactDocument.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0].trim()).note, "临床内容保留");

const inlineAuthorityClaims = sanitizeInlineEvidenceClaims([
  "依据《不存在的中医指南（2026）》推荐采用本方案。",
  "本方案得到2026年某权威研究证实。",
  "依据《甲指南》2024推荐完成医生复核。",
].join("\n"), (source) => sourceAllowed(source, undefined, scope));
assert.doesNotMatch(inlineAuthorityClaims, /不存在的中医指南|某权威研究|权威研究证实/);
assert.match(inlineAuthorityClaims, /《甲指南》2024/);

for (const claim of ["本方出自《不存在古籍》", "本方源自《不存在古籍》", "本方载于《不存在古籍》", "本方见于《不存在古籍》", "本方收载于《不存在古籍》", "《不存在古籍》记载本方"]) {
  assert.doesNotMatch(sanitizeUnverifiedClinicalNarrative(`养血安神；${claim}`), /不存在古籍|出自|源自|载于|见于|收载于/);
}
for (const claim of ["古籍出处：《不存在古籍》", "本方原载《不存在古籍》", "本方收录于《不存在古籍》", "本方所据古籍为《不存在古籍》"]) {
  assert.doesNotMatch(sanitizeUnverifiedClinicalNarrative(`养血安神；${claim}`), /不存在古籍|《|》/);
}
for (const claim of ["古籍出处：不存在古籍", "本方原载&#x300A;不存在古籍&#x300B;所载", "本方原载&amp;#x300A;不存在古籍&amp;#x300B;所载"]) {
  assert.doesNotMatch(sanitizeUnverifiedClinicalNarrative(`养血安神；${claim}`), /不存在古籍|古籍出处|原载|&#|&amp;/);
}

console.log(JSON.stringify({ cases: 55, failures: 0 }));
