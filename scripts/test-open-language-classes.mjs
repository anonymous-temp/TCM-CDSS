/**
 * 开放语言类目样例（scripts/fixtures/open-language-classes/*.json）的确定性一半。
 *
 * 冻结令要求开放语言漏检/误报走「受治理类目样例 + 整类 parity 回归（含反例）+ 归因记录」。
 * 语义判断本身要真实模型，在 `npm run regress:facts-class-parity`（不进闸门）；这里钉住
 * 不需要模型的三件事：
 *
 *   ① 样例本身合规：阳性、反例都非空；同一句话不在两组里重复出现（留出集重复了开发集就不再是留出）；
 *      目标类目都在事实层类目表里；每条阳性样例都有一条「正确语义判定」，且引用逐字取自原文。
 *   ② 提示词里还有这条原则（fixture.promptAnchor）。删掉它，实机回归要跑几百次模型调用才看得出；
 *      这里在提交时就红。
 *   ③ 语义层判对时，确定性这一半确实扣剂量：把 fixture 记录的正确判定喂给抽取→接地→门禁，
 *      每条阳性样例、每种病历语境都必须出现引用该原文的优先评估项并扣剂量；同一句话改喂
 *      修复前的错误判定（historical/routine）则不得出现该项——这一臂证明断言能分辨两种结果。
 *      接地层（hasCurrentQuoteOccurrence）对「昨天」「…后」这类时序另有自己的判据，
 *      它若把正确的阳性判定丢掉，提示词修得再好也白修。
 *
 * 反例只在实机回归里量：反例上的语义判断归模型，确定性层对部分反例本就保守
 * （见 fixture 的 knownDeterministicFindings）。
 *
 * mode = "deterministic" 的类目（缺陷在确定性层自己，与模型无关）整类都在这里量，不走实机回归：
 *   兄弟句法 parity——「背景句，当前急症」的门禁结果（状态、剂量、红旗条数）必须与单说
 *   「当前急症」相同，且单说时本身不是 ready（否则两边都 ready 也算相同，断言空转）；
 *   反例——背景句后面接真正的既往/已缓解内容，门禁必须保持 ready 且无红旗。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { OPEN_LANGUAGE_CLASS_CONTEXTS } from "./lib/open-language-class-contexts.mjs";

delete process.env.CDSS_CLINICAL_FACTS_BACKSTOP;
process.env.CLINICAL_FACTS_ATTESTATION_KEY = "open-language-class-test-key-2026";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { BACKSTOP_RED_FLAG_CATEGORIES, buildClinicalFactsExtractionPrompt } =
  await jiti.import("../src/lib/clinical-facts.ts");
const { maybeAttachClinicalFactsBackstop } = await jiti.import("../src/lib/clinical-facts-runtime.ts");
const { evaluateSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");

const TRIAGE_BASIS_FOR_URGENCY = { urgent: "urgent_review", clarify: "clarification_needed", routine: "routine_care" };
const fixtureDir = path.join(here, "fixtures/open-language-classes");
const fixtureFiles = readdirSync(fixtureDir).filter((file) => file.endsWith(".json"));
assert.ok(fixtureFiles.length > 0, "至少要有一个开放语言类目样例");

const prompt = buildClinicalFactsExtractionPrompt("患者自述：头晕。");
let cases = 0;

function judgementCall(judgement) {
  return async () => JSON.stringify({
    redFlags: [{
      category: judgement.category,
      subject: "patient",
      status: judgement.status,
      urgency: judgement.urgency,
      triageBasis: TRIAGE_BASIS_FOR_URGENCY[judgement.urgency],
      quote: judgement.quote,
    }],
    encounterScope: { status: "active_current_target", quote: judgement.quote },
  });
}

async function gateFor(context, text, customerId, judgement) {
  const state = OPEN_LANGUAGE_CLASS_CONTEXTS[context](text, customerId);
  const withFacts = await maybeAttachClinicalFactsBackstop(state, judgementCall(judgement));
  assert.equal(withFacts.clinicalFacts?.semanticStatus, "checked", `${context}: ${text} 桩抽取未落成 checked`);
  return evaluateSafetyGate(withFacts);
}

function gateSignature(context, text) {
  const gate = evaluateSafetyGate(OPEN_LANGUAGE_CLASS_CONTEXTS[context](text, "olc-deterministic"));
  return `${gate.status}/${gate.allowDosePrescription ? "dose" : "no-dose"}/redFlags=${gate.redFlags.length}`;
}

function checkDeterministicClass(entry, label) {
  assert.ok(entry.layerAttribution?.exception, `${label}: 确定性类目必须写明冻结令的哪条例外`);
  const { closedPrefixes, anyPrefixes, unanchoredEvents, anchoredEvents } = entry.parity;
  for (const context of entry.contexts) {
    for (const event of [...unanchoredEvents, ...anchoredEvents]) {
      assert.ok(!gateSignature(context, event).startsWith("ready/"), `${label}/${context}: 「${event}」单说就是 ready，parity 断言会空转`);
    }
    const pairs = [
      ...closedPrefixes.flatMap((prefix) => [...unanchoredEvents, ...anchoredEvents].map((event) => [prefix, event])),
      ...anyPrefixes.flatMap((prefix) => anchoredEvents.map((event) => [prefix, event])),
    ];
    for (const [prefix, event] of pairs) {
      assert.equal(gateSignature(context, `${prefix}，${event}`), gateSignature(context, event), `${label}/${context}: 「${prefix}，${event}」与单说「${event}」判定不同`);
      cases += 1;
    }
    for (const text of entry.controls.texts) {
      assert.equal(gateSignature(context, text), "ready/dose/redFlags=0", `${label}/${context}: 反例「${text}」被抬成当前风险`);
      cases += 1;
    }
  }
}

for (const file of fixtureFiles) {
  const entry = JSON.parse(readFileSync(path.join(fixtureDir, file), "utf8"));
  const label = entry.id || file;
  if (entry.mode === "deterministic") {
    assert.equal(entry.schemaVersion, "cdss-open-language-class-v1", `${label}: schemaVersion`);
    assert.ok(entry.layerAttribution?.layer && entry.layerAttribution?.mechanism, `${label}: 缺归因记录`);
    checkDeterministicClass(entry, label);
    continue;
  }

  // ① 样例合规
  assert.equal(entry.schemaVersion, "cdss-open-language-class-v1", `${label}: schemaVersion`);
  assert.ok(entry.layerAttribution?.layer && entry.layerAttribution?.mechanism, `${label}: 缺归因记录`);
  assert.ok(Array.isArray(entry.targetCategories) && entry.targetCategories.length > 0, `${label}: 缺目标类目`);
  for (const category of entry.targetCategories) {
    assert.ok(Object.hasOwn(BACKSTOP_RED_FLAG_CATEGORIES, category), `${label}: 未知类目 ${category}`);
  }
  for (const context of entry.contexts) {
    assert.ok(Object.hasOwn(OPEN_LANGUAGE_CLASS_CONTEXTS, context), `${label}: 未知病历语境 ${context}`);
  }
  const seen = new Map();
  for (const [setName, set] of Object.entries(entry.sets)) {
    assert.ok(set.positive.length > 0 && set.control.length > 0, `${label}/${setName}: 阳性与反例都不能为空`);
    for (const text of [...set.positive, ...set.control]) {
      assert.ok(!seen.has(text), `${label}: 「${text}」同时出现在 ${seen.get(text)} 与 ${setName}`);
      seen.set(text, setName);
    }
    for (const text of set.positive) {
      const judgement = entry.expectedSemanticJudgements?.[text];
      assert.ok(judgement, `${label}: 阳性样例「${text}」缺正确语义判定`);
      assert.ok(entry.targetCategories.includes(judgement.category), `${label}: 「${text}」判定类目不在目标类目内`);
      assert.ok(text.includes(judgement.quote), `${label}: 「${text}」的引用不是逐字原文`);
      assert.ok(judgement.status === "positive" || judgement.status === "possible", `${label}: 「${text}」正确判定必须是当前阳性`);
      assert.ok(judgement.urgency !== "routine", `${label}: 「${text}」正确判定不能是 routine`);
    }
  }
  cases += 1;

  // ② 提示词原则仍在
  assert.ok(entry.promptAnchor && prompt.includes(entry.promptAnchor), `${label}: 事实抽取提示词里找不到「${entry.promptAnchor}」`);
  cases += 1;

  // ③ 语义层判对 ⇒ 确定性一半扣剂量；判错（修复前形态）⇒ 不出该项
  let index = 0;
  for (const [setName, set] of Object.entries(entry.sets)) {
    for (const text of set.positive) {
      const judgement = entry.expectedSemanticJudgements[text];
      const citation = `原文依据：“${judgement.quote}”`;
      for (const context of entry.contexts) {
        index += 1;
        const where = `${label}/${setName}/${context}: ${text}`;
        const right = await gateFor(context, text, `olc-right-${index}`, judgement);
        assert.equal(right.allowDosePrescription, false, `${where} 正确判定下仍给剂量`);
        assert.ok(right.missingItems.some((item) => item.includes(citation)), `${where} 正确判定未形成引用原文的优先评估项\n${right.missingItems.join("\n")}`);
        const wrong = await gateFor(context, text, `olc-wrong-${index}`, {
          ...judgement, status: "historical", urgency: "routine",
        });
        assert.ok(!wrong.missingItems.some((item) => item.includes(citation)), `${where} 错误判定下也出现了该项，断言分辨不出两种结果`);
        cases += 2;
      }
    }
  }
}

console.log(JSON.stringify({ suite: "open-language-classes", fixtures: fixtureFiles.length, cases, failures: 0 }));
