// 甲方「中医相关卡片」临床决策卡片:数据契约 + 接入边界测试。
//
// 这批卡片被定级为 expert_decision_reference(专家决策参考):每份都带参考文献,但全库无
// DOI/PMID,机器不可核验;底层研究多为单中心小样本。按项目「一切结论可追溯」原则,它
// **不能驱动确定性判定**,只能作为标注了来源与等级的参考。本套件把这条结论钉成可执行断言:
//   ① 源数据 schema 完整,每条都有 sourceRef 与 evidenceTier;
//   ② relatedFormulas / relatedSyndromes 里的每个名字都必须真实存在于受治理目录(杜绝臆造);
//   ③ 等级不得被拔高(全部 expert_decision_reference,且 governance 明示不可引用/不驱动判定);
//   ④ 接入路径不得绕过任何安全边界 —— 卡片行不进入可引用来源白名单,借卡片伪造的
//      evidence 对象必须被降级为 insufficient,M05 确定性阶段不注入。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));

const source = readJson("../src/data/tcm-clinical-decision-cards.source.json");
const governedCatalog = readJson("../src/data/tcm-formula-governed-catalog.json");
const syndromeLexicon = readJson("../src/data/tcm-syndrome-lexicon.json");

const {
  CLINICAL_DECISION_CARD_LINE_MARKER,
  buildClinicalDecisionCardContext,
  clinicalDecisionCards,
  clinicalDecisionCardsForClinicianReference,
  selectClinicalDecisionCards,
} = await import("../src/lib/tcm-clinical-decision-cards.ts");
const { buildEvidenceScope, sanitizeEvidenceObject, sourceAllowed } = await import("../src/lib/evidence-source-validation.ts");
const { EVIDENCE_LEVELS } = await import("../src/lib/cdss-vocab.ts");

// ── ① 源数据 schema ──────────────────────────────────────────────────────
assert.equal(source.schemaVersion, "tcm-clinical-decision-cards-v1");
assert.ok(Array.isArray(source.cards) && source.cards.length >= 50, "至少 50 份卡片");
assert.equal(source.summary.cardCount, source.cards.length, "summary.cardCount 与实际条目一致");
assert.equal(new Set(source.cards.map((c) => c.cardId)).size, source.cards.length, "cardId 唯一");
assert.equal(
  new Set(source.cards.map((c) => c.sourceRef.driveFileName)).size,
  source.cards.length,
  "Drive 文件名唯一(同名会让来源标注失去指向)",
);

for (const card of source.cards) {
  const where = card.sourceRef?.driveFileName || card.cardId;
  assert.match(card.cardId, /^TCM-CARD-[0-9A-F]{12}$/, `${where}:cardId 格式`);
  for (const field of ["title", "conclusion", "rationale"]) {
    assert.equal(typeof card[field], "string", `${where}:${field} 必须是字符串`);
  }
  assert.ok(card.title.trim().length > 0, `${where}:title 不得为空`);
  assert.ok(card.conclusion.trim().length > 0, `${where}:conclusion 不得为空`);
  for (const field of ["topics", "relatedFormulas", "relatedSyndromes"]) {
    assert.ok(Array.isArray(card[field]), `${where}:${field} 必须是数组`);
    assert.ok(card[field].every((v) => typeof v === "string" && v.trim()), `${where}:${field} 必须全是非空字符串`);
    assert.equal(new Set(card[field]).size, card[field].length, `${where}:${field} 不得重复`);
  }
  // ② 每条必须有 sourceRef 与 evidenceTier
  assert.equal(card.evidenceTier, "expert_decision_reference", `${where}:证据等级不得被拔高`);
  assert.ok(card.sourceRef?.driveFileName?.endsWith(".md"), `${where}:sourceRef 必须指到 Drive 原文件`);
  assert.ok(card.sourceRef.driveFolder.includes("中医相关卡片"), `${where}:sourceRef 必须标注来源文件夹`);
  assert.match(card.sourceRef.documentSha256, /^[a-f0-9]{64}$/, `${where}:原文指纹`);
  assert.equal(typeof card.provenance.referenceCount, "number", `${where}:provenance.referenceCount`);
  assert.equal(typeof card.provenance.hasPersistentIdentifier, "boolean", `${where}:provenance.hasPersistentIdentifier`);
  assert.equal(typeof card.provenance.containsDoseLevelContent, "boolean", `${where}:provenance.containsDoseLevelContent`);
}

// ── ② 关联名必须真实存在于受治理目录:杜绝臆造 ───────────────────────────
// 独立重算受治理名字集合(不复用生成脚本的中间量),生成器写错也能被这里抓到。
const governedFormulaNames = new Set();
for (const entry of governedCatalog.entries) {
  if (entry.retrievalEligible !== true) continue;
  for (const name of [entry.name, ...(entry.aliases || [])]) {
    if (typeof name === "string" && name.trim()) governedFormulaNames.add(name.trim());
  }
}
// 证候正名以 GB/T 16751.2 收录的**正名/标准名**为准(排除 category_heading 这类分类标题)。
// 归一化权威是 canonicalTcmSyndromeTerm,它可以把一个 clinical_term 表层写法上归到
// category_term 层的正名(如「肝胃不和」),那仍然是受治理目录里的真实条目。
const governedSyndromeNames = new Set();
for (const entry of syndromeLexicon.entries) {
  if (entry.termClass === "category_heading") continue;
  for (const name of [entry.canonical, entry.standardTerm]) {
    if (typeof name === "string" && name.trim()) governedSyndromeNames.add(name.trim());
  }
}

for (const card of source.cards) {
  for (const name of card.relatedFormulas) {
    assert.ok(
      governedFormulaNames.has(name),
      `${card.sourceRef.driveFileName}:方名「${name}」不在受治理方剂目录中(疑似臆造)`,
    );
  }
  for (const name of card.relatedSyndromes) {
    assert.ok(
      governedSyndromeNames.has(name),
      `${card.sourceRef.driveFileName}:证候「${name}」不在 GB/T 16751.2 受治理证候目录中(疑似臆造)`,
    );
  }
}
// 匹配不到必须留空,而不是塞占位符。
assert.ok(
  source.cards.every((c) => c.relatedFormulas.every((n) => n.length >= 3)),
  "不采信长度 <3 的通用词方名(如“药方”“治方”)",
);
assert.equal(
  source.cards.filter((c) => c.relatedFormulas.length + c.relatedSyndromes.length === 0).length,
  source.cards.length - source.summary.cardsWithAnyGovernedLink,
  "无法关联的卡片必须真的留空,且与 summary 自洽",
);

// ── ③ 等级不得被拔高 ────────────────────────────────────────────────────
assert.equal(source.governance.citableAsCustomerEvidence, false, "卡片不得作为客户可见引用来源");
assert.equal(source.governance.drivesDeterministicDecisions, false, "卡片不得驱动确定性判定");
assert.equal(source.governance.status, "expert_reference_only_not_governed_rule");
assert.equal(
  source.summary.cardsWithPersistentIdentifier,
  source.cards.filter((c) => c.provenance.hasPersistentIdentifier).length,
  "可核验标识计数自洽",
);
// 定级理由的事实前提:全库确实没有 DOI/PMID。若将来甲方补齐了标识,这条会失败,
// 提醒重新评估等级 —— 那才是允许升格的正当时机。
assert.equal(source.summary.cardsWithPersistentIdentifier, 0, "全库无 DOI/PMID,故只能定级为专家参考");

// ── ④ 接入边界:注入可见,引用不可用 ─────────────────────────────────────
const caseState = {
  chiefComplaint: "反复胸闷心前区刺痛3年，气滞血瘀，夜间加重",
  symptoms: { 睡眠: "入睡困难", 情绪: "焦虑" },
};

const cards = selectClinicalDecisionCards(caseState);
assert.ok(cards.length > 0, "本例应能命中若干参考卡片");
assert.ok(cards.length <= 6, "注入卡片数量必须有上限");

const cardContext = buildClinicalDecisionCardContext(caseState);
assert.ok(cardContext.includes("expert_decision_reference"), "注入段必须标注证据等级");
assert.ok(cardContext.includes("非证据来源"), "注入段必须声明不是证据来源");
assert.ok(/不得.*剂量/.test(cardContext), "注入段必须禁止据卡片确定剂量");
for (const line of cardContext.split("\n").filter((l) => l.startsWith("- "))) {
  assert.ok(
    line.includes(CLINICAL_DECISION_CARD_LINE_MARKER),
    `每一行卡片都必须带行内标记,否则会漏进可引用白名单：${line.slice(0, 60)}`,
  );
}

// 卡片行不得把任何 ID / URL / 题名登记进可引用来源白名单。
const scopeFromCards = buildEvidenceScope(cardContext);
assert.equal(scopeFromCards.ids.size, 0, "卡片行不得贡献可引用 ID");
assert.equal(scopeFromCards.urls.size, 0, "卡片行不得贡献可引用 URL");
assert.equal(scopeFromCards.records.length, 0, "卡片行不得成为证据记录");

// 借卡片标题伪造来源必须被拒。
for (const card of cards) {
  assert.equal(
    sourceAllowed(card.title, "literature", scopeFromCards),
    false,
    `不得以卡片标题作为文献来源：${card.title.slice(0, 24)}`,
  );
  assert.equal(
    sourceAllowed(card.sourceRef.driveFileName, "guideline", scopeFromCards),
    false,
    "不得以卡片文件名作为指南来源",
  );
}

// 结构化 evidence 借卡片提权,必须 fail-closed 降级。
const forged = sanitizeEvidenceObject(
  { claim: "本方案有效", evidenceLevel: "literature", source: `${cards[0].title}（${cards[0].sourceRef.driveFileName}）` },
  scopeFromCards,
  EVIDENCE_LEVELS,
);
assert.equal(forged.evidenceLevel, "insufficient", "以卡片为来源的 evidence 必须降级为 insufficient");
assert.equal(forged.source, "内部证据缺口");

// 卡片行混进真实证据段时,只跳过卡片行,不得连累合法来源。
const mixedContext = [
  "- [OFFICIAL-RX-REVIEW] 国家卫生健康委等《医疗机构处方审核规范》（国卫办医发〔2018〕14号）。https://www.nhc.gov.cn/a.shtml",
  ...cardContext.split("\n"),
].join("\n");
const mixedScope = buildEvidenceScope(mixedContext);
assert.ok(mixedScope.ids.has("OFFICIAL-RX-REVIEW"), "合法证据行必须仍然入白名单");
assert.equal(mixedScope.ids.size, 1, "卡片行不得additional贡献 ID");

// 空病例不注入;医生侧展示必须带等级与来源标注。
assert.equal(buildClinicalDecisionCardContext({ chiefComplaint: "", symptoms: {} }), "", "无病例文本时不注入");
const reference = clinicalDecisionCardsForClinicianReference(caseState);
assert.ok(reference.length > 0);
for (const item of reference) {
  assert.equal(item.evidenceTier, "expert_decision_reference");
  assert.ok(item.sourceLabel.includes("中医相关卡片"), "医生侧展示必须标注来源文件夹");
  assert.ok(/不作为确定性依据/.test(item.evidenceNote), "医生侧展示必须标注不作为确定性依据");
}

// 运行时目录与源文件一致。
assert.equal(clinicalDecisionCards().length, source.cards.length);

console.log(JSON.stringify({
  cards: source.cards.length,
  withGovernedFormula: source.summary.cardsWithGovernedFormula,
  withGovernedSyndrome: source.summary.cardsWithGovernedSyndrome,
  withAnyGovernedLink: source.summary.cardsWithAnyGovernedLink,
  withPersistentIdentifier: source.summary.cardsWithPersistentIdentifier,
  withDoseLevelContent: source.summary.cardsWithDoseLevelContent,
  distinctGovernedFormulas: new Set(source.cards.flatMap((c) => c.relatedFormulas)).size,
  distinctGovernedSyndromes: new Set(source.cards.flatMap((c) => c.relatedSyndromes)).size,
  injectedForSampleCase: cards.length,
}));
