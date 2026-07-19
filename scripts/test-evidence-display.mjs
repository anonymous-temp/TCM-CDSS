import assert from "node:assert/strict";

const { parseEvidenceDisplayReferences, splitEvidenceReferenceItems } = await import("../src/lib/evidence-display.ts");

assert.deepEqual(splitEvidenceReferenceItems("[EVID-GUIDE-1] 指南；《金匮要略》\nhttps://example.org/a"), [
  "[EVID-GUIDE-1] 指南",
  "《金匮要略》",
  "https://example.org/a",
]);

const references = parseEvidenceDisplayReferences(
  "[EVID-INST-1] 国家药监局说明书 2025-06 https://example.org/label；[EVID-LIT-2] PMID 12345 2024",
  "支持用药边界",
  "2026-07-19",
);
assert.equal(references.length, 2);
assert.equal(references[0].sourceType, "药品说明书/监管资料");
assert.equal(references[0].url, "https://example.org/label");
assert.equal(references[0].publicationDate, "2025-06");
assert.equal(references[0].retrievedAt, "2026-07-19");
assert.equal(references[0].relevance, "支持用药边界");
assert.equal(references[1].sourceType, "研究文献");
assert.equal(references[1].publicationDate, "2024");

const unsafe = parseEvidenceDisplayReferences("javascript:alert(1)", "不执行")[0];
assert.equal(unsafe.url, undefined);
assert.equal(unsafe.title, "javascript:alert(1)");

console.log("evidence display tests passed: 14 assertions");
