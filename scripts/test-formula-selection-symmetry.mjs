/**
 * Invariant: the M03 formula-identity guard must be symmetric.
 *
 * Why this test exists. enforceRetrievedM03FormulaSelection only ever REMOVES a formula the case
 * cannot support — its first branch returns unchanged when recommendedFormulaNames is empty. So
 * over-claiming was caught and under-claiming passed silently, in a system whose own stated policy
 * is 经典方优先.
 *
 * That asymmetry is expensive in exactly the wrong direction. A recorded end-to-end run on a
 * textbook 心脾两虚 不寐 — 乏力/食欲不振/心悸/健忘/面色萎黄/舌淡苔薄白/脉细弱, an 8-of-8 match for
 * 归脾汤, which the retrieval ranked #1 and which the server's own positive-sufficiency check
 * confirms against the model's OWN signed syndrome — was emitted as self_devised with an empty
 * name list. M04 consequently had no compilable baseline, burned two repair rounds building herbs,
 * doses, 君臣佐使 and P-node bindings from scratch, and degraded to the non-dose contract. The
 * doctor got a refusal page; the harness recorded three green ticks.
 *
 * A self-devised formula carries no 出处 and is clinically harder to defend than the classic it
 * replaced, so under-claiming is not the "safe" direction it looks like.
 *
 * The server must NOT pick the formula — that stays a clinical decision. It may only report what
 * was passed over, so the contract can demand a repair round that names it.
 */
import assert from "node:assert/strict";
import { missedLockableFormulaCandidates } from "../src/lib/tcm-formula-indications.ts";
import { structuredClinicalRepairHint } from "../src/lib/structured-clinical-repair.ts";

/** A complete, well-formed M03 for a textbook 心脾两虚 不寐 — the case that motivated this test. */
function heartSpleenDeficiencyM03(overviewPatch = {}) {
  return {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    overview: {
      tcmDiseaseName: "不寐",
      primarySyndrome: "心脾两虚证",
      primarySyndromeResolution: "bounded",
      overallPathogenesis: "脾虚气血生化不足，心神失养",
      overallTherapy: "补益心脾，养血安神",
      recommendedFormulaNames: [],
      formulaSelectionMode: "self_devised",
      recommendedFormulaDirection: "按已锁定病机与治法辨证组方",
      ...overviewPatch,
    },
    pathogenesis: {
      chain: [
        { nodeId: "P1", patientFact: "入睡困难、多梦易醒3个月", syndromeEvidence: "面色萎黄，舌淡苔薄白，脉细弱", pathogenesis: "心脾两虚，心神失养", therapyDirection: "补益心脾，养血安神" },
        { nodeId: "P2", patientFact: "饭量减少，饭后脘腹胀", syndromeEvidence: "乏力神疲", pathogenesis: "脾失健运", therapyDirection: "健脾益气" },
      ],
      locationDifferentiation: { items: ["心", "脾"] },
      natureDifferentiation: { items: ["气虚", "血虚"] },
    },
    therapy: {
      overallPrinciple: "虚则补之",
      overallMethod: "补益心脾，养血安神",
      subTherapies: [{ therapy: "补益心脾，养血安神", targetPathogenesis: "心脾两虚", priority: "主要" }],
    },
  };
}

// ── the failure this guard exists for ────────────────────────────────────────
const missed = missedLockableFormulaCandidates(heartSpleenDeficiencyM03());
assert.ok(missed.includes("归脾汤"),
  `心脾两虚 不寐 emitted as self_devised must surface 归脾汤 as passed over, saw ${JSON.stringify(missed)}`);
assert.ok(missed.length <= 3, "the repair guidance names a bounded set, not the whole catalog");

// ── legitimate empty selections must stay silent ─────────────────────────────
assert.deepEqual(
  missedLockableFormulaCandidates(heartSpleenDeficiencyM03({ recommendedFormulaNames: ["归脾汤"], formulaSelectionMode: "single" })),
  [],
  "a locked formula is not a missed lock",
);
assert.deepEqual(
  missedLockableFormulaCandidates(heartSpleenDeficiencyM03({ deferredFormulaSelection: { names: ["归脾汤"], reason: "semantic_mapping_pending_clinician_confirmation" } })),
  [],
  "an empty list the server itself produced by deferring the choice is our doing, not an omission",
);
assert.deepEqual(
  missedLockableFormulaCandidates(heartSpleenDeficiencyM03({ primarySyndromeResolution: "unresolved" })),
  [],
  "a formula is locked TO a syndrome — an unresolved syndrome has nothing to bind to",
);
assert.deepEqual(missedLockableFormulaCandidates(null), []);
assert.deepEqual(missedLockableFormulaCandidates({}), []);
assert.deepEqual(missedLockableFormulaCandidates({ overview: {} }), []);

// ── the check must be syndrome-sensitive, not a fixed list ───────────────────
const windColdM03 = {
  ...heartSpleenDeficiencyM03(),
  overview: {
    ...heartSpleenDeficiencyM03().overview,
    primarySyndrome: "风寒束表证",
    overallPathogenesis: "风寒外袭，卫阳被遏",
    overallTherapy: "辛温解表",
  },
  pathogenesis: {
    chain: [{ nodeId: "P1", patientFact: "恶寒发热无汗", syndromeEvidence: "脉浮紧", pathogenesis: "风寒束表", therapyDirection: "辛温解表" }],
    locationDifferentiation: { items: ["肺", "卫表"] },
    natureDifferentiation: { items: ["寒", "实"] },
  },
  therapy: {
    overallPrinciple: "实则泻之",
    overallMethod: "辛温解表",
    subTherapies: [{ therapy: "辛温解表", targetPathogenesis: "风寒束表", priority: "主要" }],
  },
};
const windColdMissed = missedLockableFormulaCandidates(windColdM03);
assert.ok(windColdMissed.length > 0, "a 风寒束表 case also has governed candidates");
assert.ok(!windColdMissed.includes("归脾汤"),
  `candidates must follow the signed syndrome, not a fixed list — saw ${JSON.stringify(windColdMissed)}`);

// ── the rejection must be repairable ─────────────────────────────────────────
const hint = structuredClinicalRepairHint("diagnose", "m03_formula_selection_missed_lockable");
assert.ok(hint.length > 0, "every rejection code must carry repair guidance");
assert.match(hint, /recommendedFormulaNames/, "guidance must name the field to correct");
assert.match(hint, /formulaSelectionMode/, "guidance must name the mode field");
assert.match(hint, /逐字/, "guidance must forbid rewriting the retrieved formula name");
assert.match(hint, /才可保持留空|确认短名单中每一条都与本例方证不符/,
  "guidance must leave a legitimate route to keep self-devising — the server does not pick the formula");

console.log(JSON.stringify({
  suite: "formula-selection-symmetry",
  missedForHeartSpleen: missed,
  missedForWindCold: windColdMissed,
  failures: 0,
}, null, 2));

// ─── 复合证候必须能归一到主证，否则命名方永远锁不上 ────────────────────────────
// 身份锁要求 primarySyndromeId 存在。受控证候词表收的是单一证候，而真实病例里主证候多为复合写法
// （10 例公开医案中 6 例如此）。整串归一失败 ⇒ primarySyndromeId 为空 ⇒ 全部候选 positiveSufficiency
// 为 false ⇒ 一律自拟方。实测修正前这 6 例的可锁定候选数都是 0，修正后 温胆汤/真武汤/天麻钩藤饮
// 等原医案实际用方才进入可锁定集合。
{
  const { retrieveTcmFormulaCandidatesForReasoning } = await import("../src/lib/tcm-formula-indications.ts");
  const reasoningFor = (syndrome, therapy, pathogenesis) => ({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: {
      primarySyndrome: syndrome, primarySyndromeResolution: "bounded", primarySyndromeBasis: ["示例事实"],
      overallPathogenesis: pathogenesis, overallTherapy: therapy,
      recommendedFormulaNames: [], formulaSelectionMode: "self_devised", secondarySyndromes: [],
    },
    westernDiagnosis: { primary: { name: "示例", supportingFacts: [] }, differentials: [] },
    pathogenesis: {
      summary: pathogenesis, chain: [{ nodeId: "P1", patientFact: "示例", syndromeEvidence: "示例", pathogenesis, therapyDirection: therapy }],
      locationDifferentiation: { items: [], details: [] }, natureDifferentiation: { items: [], rootDeficiency: [], branchExcess: [] },
      uncertainties: [],
    },
    therapy: { overallPrinciple: "治病求本", overallMethod: therapy, subTherapies: [{ therapy, targetPathogenesis: pathogenesis, priority: "主要" }] },
  });
  const lockable = (reasoning) => retrieveTcmFormulaCandidatesForReasoning(reasoning, 60)
    .filter((entry) => entry.identityLockEligible && entry.positiveSufficiency).map((entry) => entry.name);

  // 复合写法与其单证写法必须得到同一个主证身份——差别只是有没有写兼证。
  for (const [compound, single] of [
    ["肝阳上亢，痰热扰心", "肝阳上亢证"],
    ["心脾两虚兼血瘀", "心脾两虚证"],
    ["肝郁化火，心神不宁", "肝郁化火证"],
  ]) {
    const compoundLockable = lockable(reasoningFor(compound, "平肝潜阳，清热化痰", "示例病机"));
    assert.ok(
      compoundLockable.length > 0,
      `复合证候「${compound}」检索不出任何可锁定命名方——主证段归一失效，M03 只能退回自拟方`,
    );
    const singleLockable = lockable(reasoningFor(single, "平肝潜阳，清热化痰", "示例病机"));
    assert.ok(
      compoundLockable.every((name) => singleLockable.includes(name)),
      `「${compound}」的可锁定集合必须是其主证「${single}」的子集，实得 ${JSON.stringify(compoundLockable)} vs ${JSON.stringify(singleLockable)}`,
    );
  }

  // 只取首段，不得取任意段：否则兼证会反客为主，把方锁到次要矛盾上。
  const secondaryOnly = lockable(reasoningFor("肝阳上亢，痰热扰心", "平肝潜阳", "示例病机"));
  const phlegmHeartOnly = lockable(reasoningFor("痰热扰心证", "清热化痰", "示例病机"));
  const phlegmExclusive = phlegmHeartOnly.filter((name) => !lockable(reasoningFor("肝阳上亢证", "平肝潜阳", "示例病机")).includes(name));
  assert.ok(
    phlegmExclusive.every((name) => !secondaryOnly.includes(name)),
    `兼证「痰热扰心」独有的方 ${JSON.stringify(phlegmExclusive)} 不得因为写在复合证候里就被锁定——主证是「肝阳上亢」`,
  );

  // 无法归一的证候仍须锁不上：这条放宽只覆盖「主证本身在受控词表里」的情形。
  assert.deepEqual(
    lockable(reasoningFor("某某未收录候，另有兼夹", "调理", "示例病机")), [],
    "主证段不在受控词表时不得锁定任何命名方",
  );
}
