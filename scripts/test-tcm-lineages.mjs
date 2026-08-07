import assert from "node:assert/strict";

const {
  LINEAGE_CARDS,
  LINEAGE_GROUP_DEFINITIONS,
  LINEAGE_QUESTION_STRATEGIES,
  LINEAGE_SAFETY_OBEDIENCE,
  getLineageCard,
  getLineageQuestionStrategy,
  resolveLineageCode,
} = await import("../src/lib/tcm-lineages.ts");

const LEGACY_ALIASES = {
  unrestricted: ["", "不限定", "循证安全优先"],
  "classical-formula": ["经方", "经方思路", "经典方证", "经典方证对应"],
  "warm-disease": ["温病", "卫气营血", "三焦辨证"],
  "nourish-yin-danxi": ["滋阴", "丹溪", "朱丹溪", "相火", "阴虚"],
  "warm-tonify-yang": ["温补", "扶阳", "温阳", "火神"],
};

// 2026-08-07 下线的 8 张卡。判据是线上可用方剂条数（见 tcm-lineages.ts 顶部注释）。
// 这些名字必须落到默认档，而不是解析出一个卡片表里已经没有的 code。
const RETIRED_LINEAGE_INPUTS = [
  "empirical-formula", "时方", "验方", "临床经验方",
  "spleen-stomach", "脾胃", "补土", "东垣",
  "menghe", "孟河", "孟河医派",
  "lingnan", "岭南", "岭南医派", "暑湿",
  "haipai", "海派", "海派中医",
  "institution-first", "院内", "院内方案优先",
  "gongxie", "攻邪", "攻下",
  "hanliang", "寒凉", "清热解毒",
];

const SEMVER = /^\d+\.\d+\.\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const expectedGroups = ["default", "classic", "school"];

function isRealIsoDate(value) {
  if (!ISO_DATE.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function assertNonEmptyText(value, path) {
  assert.equal(typeof value, "string", `${path} must be a string`);
  assert.ok(value.trim(), `${path} must not be empty`);
}

assert.deepEqual(Object.keys(LINEAGE_GROUP_DEFINITIONS).sort(), expectedGroups.sort());
for (const group of expectedGroups) {
  assertNonEmptyText(LINEAGE_GROUP_DEFINITIONS[group].label, `group.${group}.label`);
  assertNonEmptyText(LINEAGE_GROUP_DEFINITIONS[group].definition, `group.${group}.definition`);
}

assert.equal(LINEAGE_CARDS.length, Object.keys(LEGACY_ALIASES).length);
assert.equal(new Set(LINEAGE_CARDS.map((card) => card.code)).size, LINEAGE_CARDS.length, "lineage codes must be unique");

for (const card of LINEAGE_CARDS) {
  const prefix = `lineage.${card.code}`;
  assert.ok(expectedGroups.includes(card.group), `${prefix}.group must use the governed axis`);
  assert.ok(["academic_lineage", "source_preference", "operational"].includes(card.cardNature), `${prefix}.cardNature is invalid`);
  assert.deepEqual(card.aliases, LEGACY_ALIASES[card.code], `${prefix}.aliases changed`);

  assert.ok(Array.isArray(card.provenance.representativePhysicians), `${prefix}.provenance.representativePhysicians must be an array`);
  assert.ok(Array.isArray(card.provenance.representativeWorks), `${prefix}.provenance.representativeWorks must be an array`);
  assert.ok(card.provenance.representativeWorks.length > 0, `${prefix} must disclose at least one work, textbook, or governing source`);
  card.provenance.representativePhysicians.forEach((value, index) => assertNonEmptyText(value, `${prefix}.provenance.representativePhysicians[${index}]`));
  card.provenance.representativeWorks.forEach((value, index) => assertNonEmptyText(value, `${prefix}.provenance.representativeWorks[${index}]`));
  assertNonEmptyText(card.provenance.lineageSummary, `${prefix}.provenance.lineageSummary`);

  assert.match(card.governance.schemaVersion, SEMVER, `${prefix}.governance.schemaVersion must be semver`);
  assert.match(card.governance.cardVersion, SEMVER, `${prefix}.governance.cardVersion must be semver`);
  assert.ok(["draft", "in_review", "active", "retired"].includes(card.governance.status), `${prefix}.governance.status is invalid`);
  assertNonEmptyText(card.governance.author.id, `${prefix}.governance.author.id`);
  assertNonEmptyText(card.governance.author.displayName, `${prefix}.governance.author.displayName`);
  assert.ok(card.governance.reviewedBy.length > 0, `${prefix}.governance.reviewedBy must identify a reviewer`);
  for (const reviewer of card.governance.reviewedBy) {
    assertNonEmptyText(reviewer.id, `${prefix}.governance.reviewedBy.id`);
    assertNonEmptyText(reviewer.displayName, `${prefix}.governance.reviewedBy.displayName`);
  }
  assert.ok(isRealIsoDate(card.governance.reviewedAt), `${prefix}.governance.reviewedAt must be a real ISO date`);
  assert.ok(isRealIsoDate(card.governance.effectiveAt), `${prefix}.governance.effectiveAt must be a real ISO date`);
  assert.ok(card.governance.reviewedAt <= card.governance.effectiveAt, `${prefix} cannot take effect before review`);

  assert.equal(card.safetyObedience, LINEAGE_SAFETY_OBEDIENCE, `${prefix} must retain the global safety-obedience declaration`);
  assert.ok(card.cautions.length > 0, `${prefix}.cautions must retain card-specific safety boundaries`);

  if (card.cardNature === "academic_lineage") {
    assert.ok(card.provenance.representativePhysicians.length > 0, `${prefix} academic provenance requires representative physicians`);
    assert.ok(card.provenance.representativeWorks.length > 0, `${prefix} academic provenance requires representative works`);
  }

  assert.equal(resolveLineageCode(card.code), card.code, `${prefix} code no longer resolves`);
  assert.equal(getLineageCard(card.code).code, card.code, `${prefix} card lookup changed`);
  assert.equal(getLineageQuestionStrategy(card.code).lineageCode, card.code, `${prefix} question strategy changed`);
  assert.equal(LINEAGE_QUESTION_STRATEGIES[card.code]?.lineageCode, card.code, `${prefix} strategy registry is incomplete`);

  for (const alias of LEGACY_ALIASES[card.code]) {
    assert.equal(resolveLineageCode(alias), card.code, `${prefix} legacy alias ${JSON.stringify(alias)} no longer resolves`);
  }
}

assert.equal(getLineageCard("classical-formula").cardNature, "source_preference", "经方 must be disclosed as a source preference, not a single school");
assert.match(getLineageCard("warm-tonify-yang").provenance.lineageSummary, /内部传承并不单一/);
assert.equal(resolveLineageCode(undefined), "unrestricted");
assert.equal(resolveLineageCode("未知流派"), "unrestricted");

// 归一结果必须落在真实卡片集合内。上一版曾出现「resolveLineageCode 返回 gongxie，
// 而 LINEAGE_CARDS 里已经没有 gongxie，getLineageCard 静默兜回第 0 张卡」的形状——
// 归一出来的 code 和实际生效的卡不是同一个东西，是本项目反复出现的「两处各写各的」。
const CARD_CODES = new Set(LINEAGE_CARDS.map((card) => card.code));
const strayResolutions = [];
for (const input of [...RETIRED_LINEAGE_INPUTS, "未知流派", "随便写点什么", "school", "TCM"]) {
  const resolved = resolveLineageCode(input);
  if (!CARD_CODES.has(resolved)) strayResolutions.push(`${input} → ${resolved}`);
}
assert.deepEqual(strayResolutions, [], `resolveLineageCode 归一出了卡片表里不存在的 code：\n  ${strayResolutions.join("\n  ")}`);

const retiredStillResolving = RETIRED_LINEAGE_INPUTS
  .map((input) => [input, resolveLineageCode(input)])
  .filter(([, resolved]) => resolved !== "unrestricted");
assert.deepEqual(
  retiredStillResolving.map(([input, resolved]) => `${input} → ${resolved}`),
  [],
  "已下线流派必须落到默认档 unrestricted",
);

// 问诊策略注册表不得留下没有卡片的孤儿条目（反向：卡片必须有策略，已在上面逐卡断言）。
assert.deepEqual(
  Object.keys(LINEAGE_QUESTION_STRATEGIES).filter((code) => !CARD_CODES.has(code)),
  [],
  "LINEAGE_QUESTION_STRATEGIES 里有卡片表中已不存在的流派",
);

console.log(JSON.stringify({ cards: LINEAGE_CARDS.length, legacyAliases: Object.values(LEGACY_ALIASES).flat().length, failures: 0 }));
