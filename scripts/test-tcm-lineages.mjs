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
  "empirical-formula": ["时方", "验方", "时方/验方", "临床经验方"],
  "warm-disease": ["温病", "卫气营血", "三焦辨证"],
  "spleen-stomach": ["脾胃", "补土", "中焦", "东垣"],
  "nourish-yin-danxi": ["滋阴", "丹溪", "朱丹溪", "相火", "阴虚"],
  "warm-tonify-yang": ["温补", "扶阳", "温阳", "火神"],
  menghe: ["孟河", "孟河医派", "轻灵平正"],
  lingnan: ["岭南", "岭南医派", "湿热", "暑湿"],
  haipai: ["海派", "海派中医", "中西参证"],
  "institution-first": ["院内", "院内方案", "院内方案优先", "本院常用方案"],
  gongxie: ["攻邪", "攻下", "祛邪", "急则治标"],
  hanliang: ["寒凉", "清热", "清热解毒", "清热凉血"],
};

const SEMVER = /^\d+\.\d+\.\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const expectedGroups = ["default", "classic", "school", "regional", "institutional"];

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

assert.equal(getLineageCard("empirical-formula").cardNature, "source_preference", "时方/验方 must be disclosed as a source preference");
assert.equal(getLineageCard("institution-first").cardNature, "operational", "院内方案 must be disclosed as an operational strategy");
assert.match(getLineageCard("empirical-formula").provenance.lineageSummary, /不对应.*学术流派/);
assert.match(getLineageCard("institution-first").provenance.lineageSummary, /运营策略.*不是历史医派/);
assert.equal(resolveLineageCode(undefined), "unrestricted");
assert.equal(resolveLineageCode("未知流派"), "unrestricted");

console.log(JSON.stringify({ cards: LINEAGE_CARDS.length, legacyAliases: Object.values(LEGACY_ALIASES).flat().length, failures: 0 }));
