/**
 * 不变式：方剂目录的**症状维度**必须真实存在，并且真实参与候选池构建。
 *
 * 为什么有这个测试。甲方 5.2（气血亏虚头痛）排障时实测到两件事：
 *
 *  ① 受治理目录 2937 首方里 2031 首（69%）的 symptomTags 是空数组——症状标注的唯一词汇来源
 *     是 tcm-formula-retrieval-concepts 的 39 条人工正则，覆盖不到的临床用语（腰痛/耳鸣/咽痛/
 *     呃逆/畏寒肢冷…）一律标不上。益气聪明汤就是空标签，症状路对它等于不存在。
 *     修法不是再手写一批正则（那是 test:clinical-vocabulary 明令终结的动作），而是把项目里
 *     **已有的**受治理症状词族表（tcm-symptom-axis-map.source.json）合成进概念表。
 *
 *  ② 倒排索引的 symptomToFormulaIds / diseaseToFormulaIds 在 FormulaRetrievalIndex 类型里
 *     声明了、构建期也算了（1623 + 364 条关系），**运行时从来没有被读过**——候选池只用了
 *     concept/syndrome/nature/location 四路。声明与消费脱节，是这一类缺陷最典型的形态：
 *     数据造好了、门开着，就是没人走。
 *
 * 因此本测试钉三件事：覆盖率不得回落、生成物必须可追溯到受治理来源、症状/病名索引必须
 * 真的进候选池。第四段记录 5.2 本身的**数据缺口**——见该段注释，那条不是可以靠代码修的。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  retrieveTcmFormulaIndicationCandidates,
} from "../src/lib/tcm-formula-indications.ts";
import { normalizeCaseStateInput } from "../src/lib/diagnosis-types.ts";

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/data");
const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));

const catalog = read("tcm-formula-governed-catalog.json");
const index = read("tcm-formula-retrieval-index.json");
const concepts = read("tcm-formula-retrieval-concepts.json");
const curated = read("tcm-formula-retrieval-concepts.source.json");
const familyMap = read("tcm-symptom-axis-map.source.json");

/* ── 1. 覆盖率闸门：只能涨不能落 ────────────────────────────────────────────── */
// 基线是本轮补齐后的实测值。降低这三个数字必须是显式动作并写明理由——它们各自对应
// 一条召回通路：概念数=症状词汇面，标注方数=能被症状路召回的方，关系数=索引边。
const CONCEPT_FLOOR = 70;
const SYMPTOM_TAGGED_FORMULA_FLOOR = 1100;
const SYMPTOM_RELATION_FLOOR = 2300;

const symptomTagged = catalog.entries.filter((entry) => (entry.symptomTags || []).length > 0);
assert.ok(
  concepts.entries.length >= CONCEPT_FLOOR,
  `检索概念数回落：${concepts.entries.length} < ${CONCEPT_FLOOR}`,
);
assert.ok(
  symptomTagged.length >= SYMPTOM_TAGGED_FORMULA_FLOOR,
  `symptomTags 覆盖回落：${symptomTagged.length}/${catalog.entries.length} < ${SYMPTOM_TAGGED_FORMULA_FLOOR}`,
);
assert.ok(
  index.summary.symptomRelationCount >= SYMPTOM_RELATION_FLOOR,
  `症状→方剂关系数回落：${index.summary.symptomRelationCount} < ${SYMPTOM_RELATION_FLOOR}`,
);

/* ── 2. 概念表是生成物，每一条中文都必须追溯到受治理来源 ──────────────────── */
// 这一条挡的是「以后有人直接手改生成物加词」：那样加的词在两个来源文件里都找不到。
const curatedById = new Map(curated.entries.map((entry) => [entry.id, entry]));
const familyTerms = new Set(familyMap.entries.flatMap((family) => family.terms));
assert.equal(concepts.generated, true, "tcm-formula-retrieval-concepts.json 必须标记为生成物");
assert.equal(concepts.summary.curatedCount, curated.entries.length, "生成物必须收全人工受治理概念");
for (const entry of concepts.entries) {
  new RegExp(entry.patientPattern);
  new RegExp(entry.indicationPattern);
  for (const term of entry.derivedFromTerms || []) {
    assert.ok(familyTerms.has(term), `概念 ${entry.id} 的派生词「${term}」不在受治理症状词族表里`);
  }
  if (entry.origin === "derived_symptom_axis_family") {
    assert.ok(!curatedById.has(entry.id), `派生概念 ${entry.id} 与人工概念 id 冲突`);
    assert.ok((entry.derivedFromTerms || []).length > 0, `派生概念 ${entry.id} 必须带出处词族`);
    continue;
  }
  const source = curatedById.get(entry.id);
  assert.ok(source, `非派生概念 ${entry.id} 必须来自人工受治理源表`);
  // 加宽只能加宽，不能改写：源表原正则必须原样保留为首个分支。
  assert.ok(
    entry.patientPattern === source.patientPattern || entry.patientPattern.startsWith(`${source.patientPattern}|`),
    `概念 ${entry.id} 的 patientPattern 不是在源表基础上追加，实得 ${entry.patientPattern}`,
  );
  assert.ok(
    entry.indicationPattern === source.indicationPattern || entry.indicationPattern.startsWith(`${source.indicationPattern}|`),
    `概念 ${entry.id} 的 indicationPattern 不是在源表基础上追加，实得 ${entry.indicationPattern}`,
  );
}

/* ── 3. symptomToFormulaIds / diseaseToFormulaIds 必须真的进候选池 ────────── */
// 只声明不消费正是本轮修掉的缺陷。这里从**索引本身**挑一个只有症状边、没有概念边的方，
// 再用该概念的患者侧措辞造病例：候选池里必须出现它。写死方名会随目录漂移，故动态选取。
function caseFor(text, extra = {}) {
  return normalizeCaseStateInput({
    id: "symptom-route-probe",
    phase: "diagnose",
    patient: { sex: "女", age: "45", occupation: "" },
    chiefComplaint: text,
    hisRecord: {
      source: "manual",
      encounterId: "symptom-route-probe",
      rawText: text,
      fields: { zhushu: text, xianbingshi: text },
      collectedAt: new Date(0).toISOString(),
    },
    tongue: "",
    pulse: "",
    completeness: { level: "C", redFlag: 0.85, infoGain: 0.9, managementImpact: 0.9, answerability: 0.9 },
    conversation: [],
    questionRounds: 1,
    maxQuestionRounds: 2,
    ...extra,
  });
}

const conceptEdges = index.indexes.conceptToFormulaIds;
const symptomEdges = index.indexes.symptomToFormulaIds;
const symptomOnlyPairs = Object.entries(symptomEdges).flatMap(([conceptId, ids]) => {
  const viaConcept = new Set(conceptEdges[conceptId] || []);
  return ids.filter((id) => !viaConcept.has(id)).map((id) => ({ conceptId, id }));
});
assert.ok(
  symptomOnlyPairs.length > 0,
  "症状索引与概念索引完全重合时本断言无意义——索引形态变了，请重新设计本段",
);
const nameById = new Map(catalog.entries.map((entry) => [entry.id, entry.name]));
const conceptById = new Map(concepts.entries.map((entry) => [entry.id, entry]));
{
  const { conceptId, id } = symptomOnlyPairs[0];
  const concept = conceptById.get(conceptId);
  const name = nameById.get(id);
  assert.ok(concept && name, `症状边 ${conceptId}->${id} 在概念表/目录里找不到对应记录`);
  // 概念的患者侧措辞取第一个字面分支（派生概念的分支就是词族原词）。
  const probeTerm = concept.patientPattern.split("|")[0].replace(/\\/g, "");
  const pool = retrieveTcmFormulaIndicationCandidates(caseFor(`${probeTerm}反复发作`), 3000).map((item) => item.name);
  assert.ok(
    pool.includes(name),
    `仅经 symptomToFormulaIds 可达的「${name}」未进入候选池——症状维度没有真的接进候选池构建`,
  );
}

/* ── 4. 益气聪明汤：从「症状路不可达」变为「按其受治理主症可达」 ──────────── */
// 5.2 的实测起点就是这首方 symptomTags=[]。补齐后它拿到了「耳鸣」（来自其受治理主治原文
// 「脾胃气虚所致的内障目昏、耳鸣耳聋」）。这条断言钉的是「症状路对它不再是死路」。
const yiqiCongming = catalog.entries.find((entry) => entry.name === "益气聪明汤");
assert.ok(yiqiCongming, "受治理目录里必须有益气聪明汤");
assert.ok(
  (yiqiCongming.symptomTags || []).length > 0,
  "益气聪明汤的 symptomTags 不得回落为空数组——空标签等于症状路对它永久不可达",
);
{
  const pool = retrieveTcmFormulaIndicationCandidates(caseFor("耳鸣耳聋伴目昏，神疲乏力、食少，舌淡脉弱"), 3000)
    .map((item) => item.name);
  assert.ok(pool.includes("益气聪明汤"), "益气聪明汤必须能被其受治理主症（耳鸣目昏）召回");
}
// ★ 5.2 的**数据缺口**，不是代码缺陷，写在这里防止有人用编造的方证关系「修」掉它：
// 甲方要求「气血亏虚头痛 → 益气聪明汤合四物汤」。但本仓受治理数据里，益气聪明汤的主治原文
// （深圳标准 + 方书 Excel 两处一致）只有内障目昏/耳鸣耳聋，**没有任何一处提到头痛或气血亏虚**；
// 高频方证关系表里 气血两虚 的 primary 方是八珍汤，也没有益气聪明汤。
// 所以这条关系必须以带 sourceRef 的裁定条目补进
// tcm-high-frequency-syndrome-formula-relations.source.json，而不是靠放宽召回凑出来。
// 下面这条断言在数据补进来之前保持为「缺口存在」，补进来之后会失败，提示同步更新本段。
assert.ok(
  !(yiqiCongming.indications || []).some((text) => /头痛|气血/.test(text)),
  "益气聪明汤的受治理主治里出现了头痛/气血——若这是新补的裁定关系，请更新本段并补齐 5.2 断言",
);

/* ── 5. 方向红线：加宽召回不得改变寒热方向 ────────────────────────────────── */
// 历史教训（见 tcm-formula-indications.ts 里 MODERN_CASE_RECALL_ENABLED 的注释）：
// 上一次提升 recall 让风寒表证的首选变成银翘散。方向错是临床错误，召回少是可接受损失。
// test:formula-selection-symmetry / test:syndrome-hypothesis 已从 M03 侧钉这条；这里从
// **召回侧**再钉一次，因为本轮改的正是候选池构建，而那两个套件不覆盖候选池排序。
{
  const coldPool = retrieveTcmFormulaIndicationCandidates(
    caseFor("恶寒发热，无汗，头痛身痛，鼻塞流清涕，舌苔薄白，脉浮紧"), 8,
  ).map((item) => item.name);
  assert.ok(
    !coldPool.slice(0, 3).includes("银翘散"),
    `风寒表实证候选前三不得出现辛凉解表的银翘散，实得 ${JSON.stringify(coldPool.slice(0, 3))}`,
  );
  const heatPool = retrieveTcmFormulaIndicationCandidates(
    caseFor("发热重恶寒轻，咽痛口渴，咳嗽痰黄，舌红苔薄黄，脉浮数"), 8,
  ).map((item) => item.name);
  assert.ok(
    !heatPool.slice(0, 3).includes("麻黄汤"),
    `风热表证候选前三不得出现辛温发汗的麻黄汤，实得 ${JSON.stringify(heatPool.slice(0, 3))}`,
  );
}

console.log(JSON.stringify({
  concepts: concepts.entries.length,
  curated: concepts.summary.curatedCount,
  widened: concepts.summary.widenedCuratedCount,
  derived: concepts.summary.derivedCount,
  symptomTaggedFormulas: symptomTagged.length,
  governedFormulas: catalog.entries.length,
  symptomRelations: index.summary.symptomRelationCount,
  symptomOnlyEdges: symptomOnlyPairs.length,
  failures: 0,
}));
