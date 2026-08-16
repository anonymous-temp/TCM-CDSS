/**
 * 主证串分段归位：并列证候 → 兼证字段，病机结果 → 病机链，两者不得混为一谈。
 *
 * 【钉的是什么】TCMEval-SDT 194 例实测：
 *   157/194（80.9%）把多段内容塞进 primarySyndrome
 *   184/194（94.8%）secondarySyndromes 为空
 * 两个数字合起来说明：兼证不是没有，是没写到该写的地方。
 * 契约里 secondarySyndromes 字段本就存在，提示词也提过一句，但
 *  ①JSON 模板把它硬写成 `[]`（与 resolution 三槽位硬写 "bounded" 同一种模板锚定），
 *  ②没有任何判据读它。
 *
 * 【最容易做错的地方：按逗号一拆了之】
 * 用国标证候词表逐段判定后，157 例其实是两类：
 *   · 83 例真并列证候（「湿热蕴结，气滞血瘀」两段都能解析）⇒ 该外移到 secondarySyndromes；
 *   · 69 例是证候 + **病机结果**（「痰湿上蒙，清阳不展」只有前段能解析）⇒ 后段该进病机链。
 * 直觉修法「按逗号拆进 secondarySyndromes」会把这 69 例做错——把病机当成兼证。
 *
 * 【顺带查证过、结论是「没坏」的一条】解析不出的 86 种措辞里高频几乎全是病机短语
 * （胃失和降 5×、心神失养 4×、肺失宣降 3×、筋脉失养、气化不利…），不是词表缺证候名；
 * 且 governedSyndromeNameAcceptable 对 194 例判不合格 0 例。所以既有判据没问题，
 * 不要因为「有段解析不出」就去放宽它。
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
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
const { segmentPrimarySyndrome } = await jiti.import("../src/lib/clinical-governance-tables.ts");

// ── 1. 真并列证候：两段都归证候位 ──────────────────────────────────────────
const TRUE_MULTI = [
  ["湿热蕴结，气滞血瘀", 2],
  ["阴虚津亏，瘀血阻络", 2],
  ["肝肾阴虚，冲任不固", 2],
  ["脾肾阳虚，气血亏虚", 2],
];
for (const [text, expected] of TRUE_MULTI) {
  const seg = segmentPrimarySyndrome(text);
  assert.equal(
    seg.syndromeSegments.length, expected,
    `真并列证候应全部归入证候位：${text}｜实得 ${JSON.stringify(seg)}`,
  );
  assert.ok(seg.hasMisplacedSegments, `多个并列证候挤在主证里应被标记：${text}`);
}

// ── 2. 证候 + 病机结果：病机段不得被当成兼证 ────────────────────────────────
const SYNDROME_PLUS_MECHANISM = [
  ["肝胃郁热，胃失和降", "肝胃郁热", "胃失和降"],
  ["气阴两虚，虚热内扰", "气阴两虚", "虚热内扰"],
];
for (const [text, syndrome, mechanism] of SYNDROME_PLUS_MECHANISM) {
  const seg = segmentPrimarySyndrome(text);
  assert.ok(
    seg.syndromeSegments.includes(syndrome),
    `证候段应被识别：${text} → 期望含 ${syndrome}，实得 ${JSON.stringify(seg.syndromeSegments)}`,
  );
  assert.ok(
    seg.pathogenesisSegments.includes(mechanism),
    `病机结果不得被当成兼证：${text} →「${mechanism}」应归病机位，实得 ${JSON.stringify(seg)}`,
  );
}

// ── 3. 单一证候不得误报 ────────────────────────────────────────────────────
for (const text of ["胃阴不足证", "肝郁血瘀", "脾肾阳虚"]) {
  const seg = segmentPrimarySyndrome(text);
  assert.equal(seg.pathogenesisSegments.length, 0, `单一规范证候不应产出病机段：${text}`);
  assert.ok(!seg.hasMisplacedSegments, `单一证候不得被标记为夹带：${text}｜实得 ${JSON.stringify(seg)}`);
}

// ── 4. 「兼X」前缀是并列证候的口语写法，剥前缀后应能归位 ────────────────────
{
  const seg = segmentPrimarySyndrome("风痰闭窍，兼血虚");
  assert.ok(
    seg.syndromeSegments.some((item) => item.includes("血虚")),
    `「兼血虚」是并列证候的口语写法，剥掉「兼」后应归证候位，实得 ${JSON.stringify(seg)}`,
  );
}

// ── 4b. 已知局限：措辞与国标不同的证候会被误归为病机 ──────────────────────
// 「痰湿上蒙」是「痰蒙清窍证」的措辞变体，国标词表里没有这个写法，于是整串两段都落进病机位。
// 这是本谓词**已知且可接受**的局限：它服务于影子测量，宁可少认（把证候当病机）也不要多认
// （把病机当兼证）——后者会污染证候字段，前者只是少统计一条。
// 明确钉住这个行为，是为了防止有人日后「顺手放宽匹配」来消掉它，从而引入多认。
{
  const seg = segmentPrimarySyndrome("痰湿上蒙，清阳不展");
  assert.equal(
    seg.syndromeSegments.length, 0,
    "已知局限：措辞变体「痰湿上蒙」当前解析不出，两段都归病机位。"
    + "若此断言变红，说明有人放宽了匹配——请先确认没有把病机短语误认成证候。",
  );
}

// ── 5. 空值与异常输入 ──────────────────────────────────────────────────────
for (const value of ["", "   ", null, undefined, 42]) {
  const seg = segmentPrimarySyndrome(value);
  assert.deepEqual(seg.syndromeSegments, [], `异常输入不得产出证候段：${JSON.stringify(value)}`);
  assert.ok(!seg.hasMisplacedSegments, `异常输入不得被标记为夹带：${JSON.stringify(value)}`);
}

// ── 6. 基线对照：194 例的两类分布钉在案 ────────────────────────────────────
// 不是断言产品行为，是把「修复前长什么样」记住，日后复测才有比对基准。
{
  const exported = path.join(repoRoot, "docs/evaluations/TCMEval-SDT-194-reasoning-vs-gold-20260816.jsonl");
  if (existsSync(exported)) {
    const rows = readFileSync(exported, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    let trueMulti = 0;
    let syndromePlusMechanism = 0;
    for (const item of rows.slice(1)) {
      const primary = item?.productionResult?.reasoning?.overview?.primarySyndrome || "";
      if (primary.split(/[，,、；;]/).filter((part) => part.trim()).length < 2) continue;
      const seg = segmentPrimarySyndrome(primary);
      if (seg.syndromeSegments.length >= 2) trueMulti += 1;
      else if (seg.syndromeSegments.length === 1) syndromePlusMechanism += 1;
    }
    assert.ok(trueMulti >= 70, `基线：真并列证候应在 80 例量级，实得 ${trueMulti}`);
    assert.ok(syndromePlusMechanism >= 55, `基线：证候+病机应在 69 例量级，实得 ${syndromePlusMechanism}`);
  }
}

// ── 7. 提示词与模板不得再锚定空数组 ────────────────────────────────────────
{
  const prompts = readFileSync(path.join(repoRoot, "src/lib/diagnosis-prompts.ts"), "utf8");
  assert.ok(
    !/"secondarySyndromes":\s*\[\],/.test(prompts),
    "JSON 模板不得把 secondarySyndromes 硬写成空数组——那是模板锚定，"
    + "与 resolution 三槽位硬写 bounded 同一种毛病（实测 94.8% 的病例照抄了它）",
  );
  assert.ok(
    /primarySyndrome 只写一个证候/.test(prompts),
    "提示词必须明确要求 primarySyndrome 只写一个证候",
  );
}

console.log("test-primary-syndrome-segmentation: OK", {
  trueMulti: TRUE_MULTI.length,
  syndromePlusMechanism: SYNDROME_PLUS_MECHANISM.length,
});
