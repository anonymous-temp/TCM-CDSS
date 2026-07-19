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

// P2-7 契约锁定：DOI/PMID 等文献标识必须原样保留在 raw 中，供展示层提取；解析层不得伪造 url 或检索时间。
const withIdentifiers = parseEvidenceDisplayReferences(
  "[EVID-LIT-1] 失眠障碍诊疗共识 DOI:10.3760/cma.j.cn112137-20240101-00001 2024；[EVID-LIT-2] Insomnia consensus PMID 38063870 2023",
  "支持当前西医诊断倾向或鉴别边界",
);
assert.equal(withIdentifiers.length, 2);
assert.match(withIdentifiers[0].raw, /DOI:10\.3760\/cma\.j\.cn112137-20240101-00001/, "DOI must survive verbatim in raw for display-layer extraction");
assert.equal(withIdentifiers[0].url, undefined, "a DOI string without an http(s) link must not be turned into a link");
assert.match(withIdentifiers[1].raw, /PMID 38063870/);
assert.equal(withIdentifiers[0].retrievedAt, undefined, "检索时间只能来自传入的证据元数据；未提供时保持为空，绝不伪造");
assert.equal(withIdentifiers[1].retrievedAt, undefined);
const withRetrievalMetadata = parseEvidenceDisplayReferences("[EVID-INST-1] 国家药监局说明书", "支持用药边界", "2026-07-19");
assert.equal(withRetrievalMetadata[0].retrievedAt, "2026-07-19", "检索时间仅来自证据块元数据（显式传入）");

console.log("evidence display tests passed: 24 assertions");
