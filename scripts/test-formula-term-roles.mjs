/**
 * 方证鉴别图的**词位分离**：只有「接诊时医生能观察到的事实」才参与候选评分。
 *
 * 【钉的是什么】2026-08-15 实测到一处真循环：
 *   病历里写上「太阳伤寒」，麻黄汤从第 6 名 score=1 跳到 **第 1 名 score=2**。
 * 医生已经下的判断被当成患者症状再给对应方加分——系统在给自己的结论投票。
 *
 * 图里混着三类词：
 *   · 患者可观察事实（无汗、身痛、脉紧、发汗后腹胀满）
 *   · 诊断标签（太阳伤寒、少阳病往来寒热里的「少阳病」）
 *   · 治法/病机表述（解肌调营卫、发阳宣肺、发汗伤心阳）
 * 后两类必须移出评分位，但**不是删除**——诊断标签留给 M03 后一致性复核，
 * 治法表述留给病机—治法—方剂链验证。
 *
 * 【两个最容易做错的地方，本套件各钉一条】
 *
 * 一、判据不是「像不像治法」，是「能不能观察到」。
 *   「发汗后腹胀满」「发汗太过」「发汗后脐下悸」看着像治法词，实为**坏病病程的可观察事实**——
 *   正是《伤寒论》里厚朴生姜半夏甘草人参汤、桂枝甘草汤的原始指征。按「像不像治法」剔会丢真信号。
 *   （我在设计时先按「像不像治法」扫过一轮，扫出的清单本身就是错的；这条断言防的就是那个错。）
 *
 * 二、复合词要拆不要删。
 *   「少阳病往来寒热」= 少阳病（结论）+ 往来寒热（可观察）。整词删掉会连可观察部分一起丢，
 *   小柴胡汤就此失去一个关键分叉。所以按 observableRemainder 拆开并回填评分位。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { evaluateFormulaCandidates } = await jiti.import("../src/lib/tcm-classic-inference.ts");

const graph = JSON.parse(readFileSync(path.join(repoRoot, "src/data/tcm-formula-discrimination-graph.json"), "utf8"));
const roles = JSON.parse(readFileSync(path.join(repoRoot, "src/data/tcm-formula-term-roles.source.json"), "utf8"));

const rankOf = (text, formulaName) => {
  const all = evaluateFormulaCandidates(text, 300);
  const index = all.findIndex((item) => item.formulaName === formulaName);
  return index < 0 ? null : { rank: index + 1, score: all[index].score, matched: all[index].matchedTerms };
};

// ── 1. 自证加分必须归零 ────────────────────────────────────────────────────
const PLAIN = "发热恶寒无汗身痛脉浮紧";
const WITH_LABEL = "发热恶寒无汗身痛脉浮紧，中医诊断：太阳伤寒";
{
  const plain = rankOf(PLAIN, "麻黄汤");
  const labelled = rankOf(WITH_LABEL, "麻黄汤");
  assert.ok(plain, "夹具前提：纯症状下麻黄汤应在候选内");
  assert.deepEqual(
    { rank: labelled?.rank, score: labelled?.score },
    { rank: plain.rank, score: plain.score },
    "病历里写出证名不得改变任何方剂的排名或分数——那是系统在给自己的结论投票。" +
    `\n实得 纯症状=${JSON.stringify(plain)} 写了证名=${JSON.stringify(labelled)}`,
  );
  assert.ok(
    !labelled.matched.includes("太阳伤寒"),
    `诊断标签不得出现在命中词里，实得 ${JSON.stringify(labelled.matched)}`,
  );
}
// 同一形态在中风侧对称成立
{
  const plain = rankOf("发热恶风汗出脉浮缓", "桂枝汤");
  const labelled = rankOf("发热恶风汗出脉浮缓，中医诊断：太阳中风", "桂枝汤");
  assert.deepEqual(
    { rank: labelled?.rank, score: labelled?.score },
    { rank: plain?.rank, score: plain?.score },
    "太阳中风侧同样不得自证加分",
  );
}

// ── 2. 真信号不得丢（判据是「能不能观察到」，不是「像不像治法」）──────────────
const MUST_KEEP = [
  ["发汗后腹胀满，纳呆", "厚朴生姜半夏甘草人参汤", "坏病病程的可观察事实，是该方原始指征"],
  ["发热恶风汗出，项背强几几", "桂枝加葛根汤", "「项背强」拆自复合词「太阳中风兼项背强」，必须回填评分位"],
  ["往来寒热，胸胁苦满，默默不欲饮食", "小柴胡汤", "「往来寒热」拆自「少阳病往来寒热」"],
];
for (const [text, formula, why] of MUST_KEEP) {
  const hit = rankOf(text, formula);
  assert.ok(hit, `真信号丢失：${formula} 应命中（${why}）｜输入：${text}`);
}

// ── 3. 方向性不得被破坏（反证方仍应因缺决定性支持而落选）────────────────────
assert.equal(rankOf(PLAIN, "桂枝汤"), null, "无汗案里桂枝汤不应取得支持性命中");
assert.ok(rankOf("发热恶风汗出脉浮缓", "桂枝汤"), "汗出案里桂枝汤应重新进入候选");

// ── 4. 受治理表与产物一致 ──────────────────────────────────────────────────
{
  const governed = new Set((roles.entries || []).map((entry) => entry.term));
  assert.ok(governed.size >= 15, `受治理词位表条目过少：${governed.size}`);
  const scoringTerms = new Set();
  for (const node of graph.nodes) for (const term of node.supportTerms || []) scoringTerms.add(term);
  for (const edge of graph.edges) {
    for (const side of Object.values(edge.sides || {})) {
      for (const key of ["supportTerms", "againstTerms"]) {
        for (const term of side[key] || []) scoringTerms.add(term);
      }
    }
  }
  const leaked = [...governed].filter((term) => scoringTerms.has(term));
  assert.deepEqual(leaked, [], `受治理的非观察词仍留在评分位（生成器未生效或产物未重建）：${leaked.join("、")}`);

  // 移出不等于删除：必须仍可在产物里找到，供 M03 后一致性复核与病机链验证
  const parked = new Set();
  for (const node of graph.nodes) {
    for (const term of [...(node.diagnosticLabelTerms || []), ...(node.therapyStatementTerms || [])]) parked.add(term);
  }
  for (const edge of graph.edges) {
    for (const side of Object.values(edge.sides || {})) {
      for (const key of Object.keys(side)) {
        if (/DiagnosticLabels$|TherapyStatements$/.test(key)) for (const term of side[key] || []) parked.add(term);
      }
    }
  }
  assert.ok(parked.has("太阳伤寒"), "诊断标签必须仍保留在产物里（移出评分位≠删除），否则 M03 后一致性复核无据可依");
  assert.ok(
    parked.has("解肌调营卫") || parked.has("发阳宣肺"),
    "治法表述必须仍保留在产物里，供病机—治法—方剂链验证",
  );
  assert.ok(graph.termRoleGovernance?.source, "产物必须带 termRoleGovernance 溯源块");
}

// ── 5. 边界：不得把「发汗后X」这类病程事实误收进治理表 ──────────────────────
{
  const wrongly = (roles.entries || [])
    .map((entry) => entry.term)
    .filter((term) => /^发汗[后太]/.test(term));
  assert.deepEqual(
    wrongly, [],
    "「发汗后腹胀满」「发汗太过」是坏病病程的可观察事实，不是治法表述，不得收进本表——" +
    `实得 ${wrongly.join("、")}`,
  );
}

console.log("test-formula-term-roles: OK", {
  governedTerms: (roles.entries || []).length,
  selfScoringCut: true,
  signalsKept: MUST_KEEP.length,
});
