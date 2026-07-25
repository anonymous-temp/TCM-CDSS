// T16 现代医案语料完整性测试。
// 钉住的:封套评测语义(evaluationOnly/runtimeRetrievalAllowed=false)、全部 replayEligible=false、
// caseId 唯一、sourceRef 行锚可回指、无出生日期泄漏、与抽取产物行数自洽(verified 行 == 语料案数)。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const corpus = JSON.parse(readFileSync(new URL("../src/data/tcm-modern-case-eval-corpus.json", import.meta.url)));
const extracted = readFileSync(new URL("../artifacts/medical-records-extract/cases-extracted.jsonl", import.meta.url), "utf-8")
  .split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

assert.equal(corpus.schemaVersion, "tcm-modern-case-eval-corpus-v1");
assert.equal(corpus.evaluationOnly, true, "仅评测");
assert.equal(corpus.runtimeRetrievalAllowed, false, "禁运行时检索");

const verifiedLines = new Set(extracted.filter((r) => r.ok && r.verified).map((r) => r.line));
assert.equal(corpus.cases.length, verifiedLines.size, "语料案数 == 对拍通过行数(漏案或混案)");
assert.ok(corpus.cases.length > 15000, `语料规模 sanity(实际 ${corpus.cases.length})`);

const ids = new Set(corpus.cases.map((c) => c.caseId));
assert.equal(ids.size, corpus.cases.length, "caseId 唯一");
const DOB = /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*出生|出生日期|出生于\s*\d{4}/;
let withHerbs = 0, withDiag = 0;
for (const c of corpus.cases) {
  assert.equal(c.replayEligible, false, `${c.caseId} 不得进回放池`);
  assert.equal(c.containsQuarantinedContent, false);
  assert.equal(c.tier, "experience");
  assert.match(c.sourceRef, /Medical Records\.txt#L\d+$/, "行锚可回指");
  const lineNo = Number(c.sourceRef.match(/#L(\d+)$/)[1]);
  assert.ok(verifiedLines.has(lineNo), `${c.caseId} 必须来自对拍通过行`);
  const blob = JSON.stringify(c);
  assert.ok(!DOB.test(blob), `${c.caseId} 出生日期不得落地`);
  if (c.herbs.length) withHerbs += 1;
  if (c.diagnosisTcm) withDiag += 1;
}
assert.ok(withHerbs / corpus.cases.length > 0.85, `药味字段覆盖率 ${(withHerbs / corpus.cases.length * 100).toFixed(1)}%`);
assert.ok(withDiag / corpus.cases.length > 0.9, `中医诊断覆盖率 ${(withDiag / corpus.cases.length * 100).toFixed(1)}%`);

console.log(JSON.stringify({ cases: corpus.cases.length, withHerbs, withDiag, withFormulaInCatalog: corpus.cases.filter((c) => c.expectedFormulaNames.length).length }));
