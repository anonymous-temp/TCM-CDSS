// T16 现代医案语料完整性测试。
// 钉住的:封套评测语义(evaluationOnly/runtimeRetrievalAllowed=false)、全部 replayEligible=false、
// caseId 唯一、sourceRef 行锚可回指、无出生日期泄漏、与抽取产物行数自洽(verified 行 == 语料案数)。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const corpus = JSON.parse(readFileSync(new URL("../src/data/tcm-modern-case-eval-corpus.json", import.meta.url)));

// 抽取产物在 artifacts/ 下，而 .gitignore 排除了整个 artifacts —— 干净克隆里它不存在，
// 且无法重建（源语料 中医补充数据/ 未入库，重建还需 API key 与约 1.8 万次模型调用）。
// 原先这里是裸 readFileSync：任何干净检出上 test:deterministic 会在此 ENOENT 崩溃，
// 而 runner 是 fail-fast 的，于是**后面所有确定性套件连跑都跑不到**，verify:release 整条闸门失效。
// 发布闸门不能依赖一个不入库、也不可重建的中间产物。
// 因此把「与抽取产物对拍」的行锚集合固化进语料封套（corpus.sourceExtraction.verifiedLines），
// 本机有产物时额外校验封套与产物一致——两边都钉住，干净环境也不放空。
const extractedPath = new URL("../artifacts/medical-records-extract/cases-extracted.jsonl", import.meta.url);
const extracted = existsSync(extractedPath)
  ? readFileSync(extractedPath, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l))
  : null;

assert.equal(corpus.schemaVersion, "tcm-modern-case-eval-corpus-v1");
assert.equal(corpus.evaluationOnly, true, "仅评测");
assert.equal(corpus.runtimeRetrievalAllowed, false, "禁运行时检索");

// 封套里固化的对拍通过行锚：干净环境下由它承担「漏案/混案」这条不变量。
const envelopeLines = corpus.sourceExtraction?.verifiedLines;
assert.ok(Array.isArray(envelopeLines) && envelopeLines.length > 0,
  "语料封套必须固化 sourceExtraction.verifiedLines，否则干净环境下漏案/混案无人把关");
const envelopeLineSet = new Set(envelopeLines);
assert.equal(envelopeLineSet.size, envelopeLines.length, "封套行锚不得重复");
assert.equal(corpus.cases.length, envelopeLineSet.size, "语料案数 == 封套对拍通过行数(漏案或混案)");
// 本机若有抽取产物，再校验封套确实来自它——防封套被手改成自洽但与真实抽取脱节。
if (extracted) {
  const verifiedLines = new Set(extracted.filter((r) => r.ok && r.verified).map((r) => r.line));
  assert.equal(verifiedLines.size, envelopeLineSet.size, "封套行锚数必须等于抽取产物的对拍通过行数");
  for (const line of envelopeLineSet) {
    assert.ok(verifiedLines.has(line), `封套行锚在抽取产物中不存在：${line}`);
  }
}
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
  assert.ok(envelopeLineSet.has(lineNo), `${c.caseId} 必须来自对拍通过行`);
  const blob = JSON.stringify(c);
  assert.ok(!DOB.test(blob), `${c.caseId} 出生日期不得落地`);
  if (c.herbs.length) withHerbs += 1;
  if (c.diagnosisTcm) withDiag += 1;
}
assert.ok(withHerbs / corpus.cases.length > 0.85, `药味字段覆盖率 ${(withHerbs / corpus.cases.length * 100).toFixed(1)}%`);
assert.ok(withDiag / corpus.cases.length > 0.9, `中医诊断覆盖率 ${(withDiag / corpus.cases.length * 100).toFixed(1)}%`);

console.log(JSON.stringify({ cases: corpus.cases.length, withHerbs, withDiag, withFormulaInCatalog: corpus.cases.filter((c) => c.expectedFormulaNames.length).length }));
