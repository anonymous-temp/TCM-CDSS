import assert from "node:assert/strict";
import { summarizeProbeUsage } from "./lib/model-usage-summary.mjs";

// Synthetic retrieval tasks, not clinical vignettes or an estimate of diagnostic accuracy.
// Opt-in protects normal tests from paid/provider traffic. No runtime secrets are printed.
if (process.env.EVIDENCE_RERANK_PROBE_LIVE !== "1") {
  throw new Error("Set EVIDENCE_RERANK_PROBE_LIVE=1 to run the synthetic provider probe");
}
const apiKey = process.env.BAILIAN_QWEN_API_KEY || process.env.DASHSCOPE_API_KEY;
if (!apiKey) throw new Error("Bailian provider credential unavailable");

const cases = [
  { id: "general-vertigo", query: "成人普通眩晕、恶心的诊断评估，病历未记录癌症或化疗背景；寻找适用的诊断资料。", expected: 1,
    documents: ["合成资料：化疗所致恶心呕吐预防指南。研究对象是正在接受化疗的癌症患者。", "合成资料：成人眩晕与头晕的初始评估指南。讨论病史、伴随症状、查体与鉴别诊断。"] },
  { id: "chemotherapy-context", query: "正在接受化疗的成人癌症患者出现恶心呕吐，寻找化疗相关支持治疗资料。", expected: 0,
    documents: ["合成资料：化疗所致恶心呕吐预防指南。研究对象是正在接受化疗的癌症患者。", "合成资料：普通成人眩晕的初始评估指南，讨论头晕症状鉴别。"] },
  { id: "male-iron-deficiency", query: "45岁男性缺铁性贫血的病因诊断与评估。", expected: 1,
    documents: ["合成资料：妊娠期缺铁性贫血管理，适用于孕妇，讨论孕期营养需求。", "合成资料：成人缺铁性贫血诊断指南，涵盖男性与女性；摘要提及育龄妇女的月经失血。"] },
  { id: "pregnancy-iron-deficiency", query: "妊娠24周女性的缺铁性贫血诊断与管理。", expected: 0,
    documents: ["合成资料：妊娠期缺铁性贫血管理，适用于孕妇，讨论孕期营养需求。", "合成资料：老年男性缺铁性贫血的评估。"] },
  { id: "postmenopausal-bone", query: "68岁绝经女性骨质疏松的诊断评估。", expected: 1,
    documents: ["合成资料：妊娠与哺乳相关骨质疏松，研究对象是孕期和哺乳期妇女。", "合成资料：原发性骨质疏松诊断指南，适用于绝经后女性和老年男性，摘要讨论妇女月经及绝经相关骨量变化。"] },
  { id: "adult-cough", query: "50岁成人咳嗽3周，寻找成人咳嗽的鉴别诊断资料。", expected: 1,
    documents: ["合成资料：儿童咳嗽诊断指南，适用年龄0至14岁。", "合成资料：成人咳嗽诊断指南，讨论急性、亚急性与慢性咳嗽的评估。"] },
  { id: "child-cough", query: "8岁儿童反复咳嗽，寻找儿童适用的诊断资料。", expected: 0,
    documents: ["合成资料：儿童咳嗽诊断指南，适用年龄0至14岁。", "合成资料：老年人慢性咳嗽诊断资料，研究对象为65岁以上成人。"] },
  { id: "no-surgery-context", query: "成人吞咽困难的初诊评估，未记录食管手术史。", expected: 0,
    documents: ["合成资料：成人吞咽困难初诊评估，讨论口咽及食管病因的鉴别。", "合成资料：食管癌术后吞咽康复，适用于已经接受食管切除术的患者。"] },
];

const output = [];
for (const item of cases) {
  const started = performance.now();
  let row;
  try {
    const response = await fetch("https://dashscope.aliyuncs.com/compatible-api/v1/reranks", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(3_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "qwen3-rerank", query: item.query, documents: item.documents,
        top_n: item.documents.length,
        instruct: "Rank retrieved evidence by applicability to the documented population, condition and treatment setting. Do not infer unrecorded patient facts." }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.results?.length, item.documents.length);
    const order = body.results.map(result => result.index);
    assert.deepEqual([...order].sort(), [0, 1]);
    row = { id: item.id, status: response.status, order, expected: item.expected,
      correct: order[0] === item.expected, tokens: body.usage?.total_tokens ?? null };
  } catch (error) {
    row = { id: item.id, correct: false, errorType: error.name };
  }
  row.durationMs = Math.round(performance.now() - started);
  output.push(row);
  console.log(JSON.stringify({ type: "probe_case", ...row }));
}
const failed = output.filter(row => !row.correct).length;
const times = output.map(row => row.durationMs).sort((a, b) => a - b);
console.log(JSON.stringify({ type: "summary", scope: "synthetic_retrieval_only", cases: cases.length,
  originalOrderTop1: cases.filter(item => item.expected === 0).length,
  rerankedTop1: cases.length - failed, failed,
  medianMs: times[Math.floor(times.length / 2)], maxMs: times.at(-1),
  ...summarizeProbeUsage(output) }));
process.exitCode = failed ? 1 : 0;
