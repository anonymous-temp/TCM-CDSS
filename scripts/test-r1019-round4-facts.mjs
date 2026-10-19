// 10/19 第四轮（2026-10-19）：事实层急症处置分级（A 集 340 例红旗分诊，Claude 评审 17 例漏判）。
//
// 语义判断本身在实机回归（regress-facts-class-parity，CLASS_FILTER=disposition-time-window-emergency，
// positiveCriterion=red_flag）；这里钉不需要模型的三件事。每条断言都带反证（~/runlogs/r1018/work/r1019/counterproofs.txt）。
//
//   1 提示词里「类目 → 可用急诊依据键」一表与解析契约一致：表里列的键，解析接受为 emergency；表外的键，整条作废。
//     此前提示词没有这张表，腹部外伤、胰腺炎、肠梗阻被写成 acute_abdomen + acute_target_organ_damage，
//     唯一一条作废时整份输出无效，连判对了的 disposition=emergency 一起丢失。
//   2 处置去向两档按同一根轴（必须排除项的处置时间窗）分；urgent_specialist 两种情形都写明「晚几天也不会错过时间窗」。
//   3 语义层判对时确定性一半出急诊红旗：类夹具每条阳性样例的正确判定（emergency，possible 也算）经接地→门禁
//     成为引用原文的急诊红旗；同一句改喂修复前的判定（urgent_specialist）则没有红旗——possible 时连剂量都不扣，
//     likely 时只扣剂量（redFlagExplicitOnly）。接地若丢掉正确判定，提示词修得再好也白修。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

delete process.env.CDSS_CLINICAL_FACTS_BACKSTOP;
delete process.env.CDSS_REDFLAG_EXPLICIT_ONLY;
process.env.CLINICAL_FACTS_ATTESTATION_KEY = "r1019-round4-facts-test-key-2026";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const check = async (name, run) => {
  cases += 1;
  try {
    await run();
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const facts = await jiti.import("../src/lib/clinical-facts.ts");
const runtime = await jiti.import("../src/lib/clinical-facts-runtime.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const { OPEN_LANGUAGE_CLASS_CONTEXTS } = await import("./lib/open-language-class-contexts.mjs");
const fixture = JSON.parse(readFileSync("scripts/fixtures/open-language-classes/disposition-time-window-emergency.json", "utf8"));
const prompt = facts.buildClinicalFactsExtractionPrompt("患者自述：头晕。");

const EMERGENCY_BASES = Object.keys(facts.TRIAGE_BASIS).filter((basis) =>
  !["urgent_review", "clarification_needed", "routine_care"].includes(basis));

await check("1.1 提示词「类目→可用急诊依据键」一表逐类与解析契约一致（表内的键解析接受为 emergency，表外的键整条作废）；每个类目都有一行", async () => {
  const header = "urgency=emergency 时，每个类目只能配下列处置依据键之一";
  const start = prompt.indexOf(header);
  assert.ok(start >= 0, "提示词里没有类目→急诊依据键一表");
  const table = prompt.slice(start, prompt.indexOf("硬规则：", start));
  const categories = Object.keys(facts.BACKSTOP_RED_FLAG_CATEGORIES);
  const rows = new Map([...table.matchAll(/^ {2}"([a-z_]+)"：(.+)$/gmu)].map((match) => [match[1], new Set([...match[2].matchAll(/"([a-z_]+)"/gu)].map((key) => key[1]))]));
  // 越界守卫：表行数必须正好等于类目数，切过头会把下一段的键也算进来。
  assert.equal(rows.size, categories.length, `表里 ${rows.size} 行，类目 ${categories.length} 个`);
  let accepted = 0;
  let rejected = 0;
  for (const category of categories) {
    assert.ok(rows.has(category), `表里缺 ${category}`);
    for (const basis of EMERGENCY_BASES) {
      // 引文写足急性证据，让各类目的证据下限不把 emergency 压回 urgent——这里只量类目×依据键的契约。
      const parsed = facts.parseClinicalFacts(JSON.stringify({ redFlags: [{
        category, subject: "patient", status: "positive", urgency: "emergency", triageBasis: basis,
        quote: "突发剧烈腹痛伴反跳痛，大量呕血，意识改变，体温41℃",
      }] }));
      if (rows.get(category).has(basis)) {
        assert.ok(parsed && parsed.redFlags.length === 1, `${category}+${basis} 表内却被解析作废`);
        accepted += 1;
      } else {
        assert.equal(parsed, null, `${category}+${basis} 表外却被解析接受`);
        rejected += 1;
      }
    }
  }
  assert.ok(accepted > 0 && rejected > 0, `两个方向都要量到：接受 ${accepted}，作废 ${rejected}`);
});

await check("2.1 处置去向两档按同一根轴分：分界原则在；urgent_specialist 两种情形写明晚几天也不会错过时间窗；类夹具锚点在提示词里", async () => {
  assert.ok(prompt.includes(fixture.promptAnchor), `提示词里找不到类夹具锚点「${fixture.promptAnchor}」`);
  assert.ok(prompt.includes("晚几天到几周评估也不会错过处置时间窗的新问题"), "urgent_specialist ① 缺时间窗限定");
  assert.ok(prompt.includes("但还没到当天不处理就会出事的程度"), "urgent_specialist ② 缺时间窗限定");
  assert.ok(!prompt.includes("要靠影像/病理/手术/住院才能明确或处理的新问题"), "① 还是只按「靠什么手段明确」定义");
  assert.ok(prompt.includes("单凭这类用语不构成急腹症或梗阻的急性表现"), "中医辨证用语（拒按、腹胀如鼓）的限定丢了（A 集对照 A-out-single_0475 会被升急诊）");
});

function stubLlm(disposition) {
  return async () => JSON.stringify({
    disposition,
    redFlags: [],
    encounterScope: { status: "active_current_target", quote: disposition.mustNotMiss[0].evidenceQuotes[0] },
  });
}

async function gateWith(context, text, customerId, disposition) {
  const state = OPEN_LANGUAGE_CLASS_CONTEXTS[context](text, customerId);
  const withFacts = await runtime.maybeAttachClinicalFactsBackstop(state, stubLlm(disposition));
  assert.equal(withFacts.clinicalFacts?.semanticStatus, "checked", `${context}: ${text} 桩抽取未落成 checked`);
  return safety.evaluateSafetyGate(withFacts);
}

await check("3.1 类夹具每条阳性样例：正确判定（emergency）→ 引用原文的急诊红旗；修复前判定（urgent_specialist）→ 无红旗（possible 时也不经处置去向扣剂量，likely 时只扣剂量）", async () => {
  let index = 0;
  for (const [setName, set] of Object.entries(fixture.sets)) {
    for (const text of set.positive) {
      const expected = fixture.expectedDispositions?.[text];
      assert.ok(expected?.setting === "emergency" && text.includes(expected.quote), `${setName}: 「${text}」缺正确判定或引用不是逐字原文`);
      const item = { condition: expected.condition, plausibility: expected.plausibility, evidenceQuotes: [expected.quote] };
      const citation = `原文依据：“${expected.quote}”`;
      for (const context of fixture.contexts) {
        index += 1;
        const where = `${setName}/${context}: ${text}`;
        const right = await gateWith(context, text, `r4f-right-${index}`, { setting: "emergency", mustNotMiss: [item], rationale: "需当天急诊排除" });
        assert.equal(right.status, "red_flag", `${where} 正确判定下没有急诊红旗`);
        assert.ok(right.redFlags.some((flag) => flag.includes("需立即急诊评估") && flag.includes(citation)), `${where} 急诊红旗没引用原文\n${right.redFlags.join("\n")}`);
        const wrongPossible = await gateWith(context, text, `r4f-wrong-${index}`, { setting: "urgent_specialist", mustNotMiss: [item], rationale: "需尽快专科评估" });
        assert.ok(!wrongPossible.redFlags.some((flag) => flag.includes(citation)), `${where} 修复前判定下也出了急诊红旗，断言分辨不出两种结果`);
        assert.ok(!wrongPossible.missingItems.some((entry) => entry.includes("开方前处置去向") && entry.includes(citation)), `${where} possible 的 urgent_specialist 本不该扣剂量（redFlagExplicitOnly）`);
        const wrongLikely = await gateWith(context, text, `r4f-likely-${index}`, { setting: "urgent_specialist", mustNotMiss: [{ ...item, plausibility: "likely" }], rationale: "需尽快专科评估" });
        assert.notEqual(wrongLikely.status, "red_flag", `${where} likely 的 urgent_specialist 不该是急诊`);
        assert.ok(wrongLikely.missingItems.some((entry) => entry.includes("宜先由西医相关专科尽快评估") && entry.includes(citation)), `${where} likely 的 urgent_specialist 应扣剂量`);
      }
    }
  }
  assert.ok(index >= 20, `阳性样例过少：${index}`);
});

console.log(JSON.stringify({ suite: "r1019-round4-facts", cases, failures: process.exitCode ? "see above" : 0 }));
