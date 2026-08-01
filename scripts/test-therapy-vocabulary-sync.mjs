/**
 * Invariant: every therapy direction the M04 contract governs must be able to receive a
 * knowledge-base herb shortlist in the M04 prompt.
 *
 * Why this test exists. Three parallel vocabularies decide whether the model can pick a defensible
 * emperor herb, and they are maintained by hand in two different files:
 *
 *   1. TCM_THERAPY_CONCEPTS        (diagnosis-stage-contract.ts) — what the contract VERIFIES
 *   2. KB_THERAPY_KNOWLEDGE_PATTERN(diagnosis-prompts.ts)        — what may ENTER the herb index
 *   3. THERAPY_HERB_CATEGORY_RULES (diagnosis-prompts.ts)        — what is actually INJECTED
 *
 * When (3) is missing a direction that (1) governs, the failure is silent and expensive: the
 * shortlist block is not emitted at all, yet the M04 hard constraint still reads "优先从上方【本例
 * 治法方向的知识库覆盖药味短名单】对应方向中选择君药". The model is pointed at a list that does not
 * exist, falls back to its own prior, and is then deterministically rejected with
 * candidate_*_herb_*_emperor_knowledge_missing — burning repair rounds before degrading to a
 * non-dose result. This is exactly what happened to 开窍/醒神 and 软坚/散结: the knowledge base held
 * 5 and 29 dose-bounded herbs respectively, and none of them could ever be offered.
 *
 * The structural point: adding a concept to the contract must cost the same as making it
 * selectable. Without this test, `["orifice_open", /开窍|醒神/]` is one line in the validator while
 * the shortlist rule that makes it satisfiable is optional and therefore forgotten.
 *
 * This is a behavioural test on the real prompt builder, not a comparison of exported regexes —
 * it fails for ANY reason the direction cannot be offered (missing rule, empty category, no
 * dose-bounded herb), not just for a literal vocabulary mismatch.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPrescribePrompt } from "../src/lib/diagnosis-prompts.ts";

const CONTRACT_SOURCE = readFileSync(new URL("../src/lib/diagnosis-stage-contract.ts", import.meta.url), "utf8");

/** The real shortlist block. Distinct from the hard-constraint back-reference to it. */
const SHORTLIST_BLOCK = "【本例治法方向的知识库覆盖药味短名单（均有服务端功能分类或功用收载，治疗方向可核验）】";
const SHORTLIST_BACK_REFERENCE = "优先从上方【本例治法方向的知识库覆盖药味短名单】对应方向中选择君药";

/**
 * Read the governed concept list straight out of the contract source so a newly added concept
 * shows up here automatically instead of silently skipping coverage.
 */
function governedTherapyConcepts() {
  const table = CONTRACT_SOURCE.match(
    /const TCM_THERAPY_CONCEPTS: ReadonlyArray<\[TcmTherapyConcept, RegExp\]> = \[([\s\S]*?)\n\];/,
  );
  assert.ok(table, "TCM_THERAPY_CONCEPTS table not found — update this test's extractor");
  return [...table[1].matchAll(/\["([a-z_]+)",/g)].map((match) => match[1]);
}

/**
 * One representative therapy phrase per governed concept, worded the way M03 actually writes
 * therapy directions. These must be real clinical language, not the regex source: the point is to
 * prove a plausible M03 output reaches a shortlist.
 */
const REPRESENTATIVE_THERAPY = {
  qi_tonify: "补中益气",
  blood_nourish: "养血补血",
  calm_spirit: "养心安神",
  spleen_support: "健脾运化",
  qi_regulate: "疏肝理气",
  heat_clear: "清热泻火",
  phlegm_resolve: "化痰祛痰",
  damp_resolve: "利水渗湿",
  yang_warm: "温阳散寒",
  yin_nourish: "滋阴生津",
  exterior_release: "解表疏风",
  blood_move: "活血化瘀",
  purge: "通便泻下",
  astringe: "收涩固精",
  hemostasis: "凉血止血",
  cough_relieve: "止咳平喘",
  food_resolve: "消食导滞",
  wind_extinguish: "平肝息风",
  orifice_open: "开窍醒神",
  mass_soften: "软坚散结",
  menstrual_regulate: "养血调经",
};

function caseStateForTherapy(therapy) {
  const prior = {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    completeness: { level: "C", redFlag: 0.85, infoGain: 0.75, managementImpact: 0.7, answerability: 0.7 },
    overview: {
      tcmDiseaseName: "示例病", primarySyndrome: "示例证", primarySyndromeResolution: "bounded",
      primarySyndromeBasis: ["示例事实"], primarySyndromeResolutionReason: "", tcmDiagnosticRationale: "",
      tcmDifferentials: [], secondarySyndromes: [], overallPathogenesis: "示例病机",
      overallTherapy: therapy, recommendedFormulaDirection: "按已锁定病机与治法辨证组方",
      recommendedFormulaNames: [], formulaSelectionMode: "self_devised",
      evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" },
    },
    westernDiagnosis: {
      primary: {
        name: "示例", status: "考虑", confidence: "中", supportingFacts: [],
        clinicalRationale: "", limitations: [], suggestedChecks: [], evidence: {},
      },
      differentials: [],
    },
    pathogenesis: {
      summary: "示例",
      locationDifferentiation: { items: [], details: [], resolution: "bounded", resolutionReason: "", evidence: {} },
      natureDifferentiation: { items: [], rootDeficiency: [], branchExcess: [], basis: "", resolution: "bounded", resolutionReason: "", evidence: {} },
      symptomClusters: [],
      caseRelationship: { rootPattern: "", mainManifestation: "", relationship: "" },
      chain: [{ nodeId: "P1", patientFact: "示例事实", syndromeEvidence: "示例证据", pathogenesis: "示例病机", therapyDirection: therapy, evidence: {} }],
      uncertainties: [],
    },
    therapy: {
      overallPrinciple: "治病求本",
      overallMethod: therapy,
      subTherapies: [{ therapy, targetPathogenesis: "示例病机", priority: "主要", evidence: {} }],
    },
    formula: null,
    nonPharma: null,
    lineageAdaptation: {
      schemaVersion: "tcm-cdss-reasoning-v2", lineageCode: "unrestricted", label: "不限定",
      applicable: "partial", applicabilityReason: "", influencedDecisions: [],
      unaffectedBySafety: [], safetyDeference: "",
    },
    management: { mustCollect: [], followupSafetyNet: "" },
  };
  return {
    id: "therapy_vocabulary_sync", phase: "prescribe",
    patient: { sex: "女", age: 46 }, chiefComplaint: "示例主诉",
    symptoms: { presentHistory: "示例现病史" }, tongue: "舌淡红", pulse: "脉平",
    faceNote: "", vitals: {}, pastHistory: "", medicationHistory: "", allergyHistory: "",
    completeness: prior.completeness, questionRounds: 1, maxQuestionRounds: 1,
    questionOutcome: "answered", tcmLineagePreference: "unrestricted",
    conversation: [{ role: "user", content: "示例" }],
    clinicalFacts: { redFlags: [], evaluationItems: [] },
    reasoningDiagnose: prior,
    safetyGate: { status: "pass", allowDosePrescription: true, allowDiagnosis: true, missingItems: [] },
  };
}

/** Herb rows look like `- 清热方向：地骨皮[9-12g]、大青叶[9-15g]`. */
function shortlistDirectionRows(prompt) {
  const start = prompt.indexOf(SHORTLIST_BLOCK);
  if (start < 0) return [];
  const end = prompt.indexOf("\n使用规则：", start);
  return prompt
    .slice(start, end < 0 ? prompt.length : end)
    .split("\n")
    // 短名单每个方向渲染两行：君药面「（君臣佐使均可选）」与配伍面「（仅可作臣佐使配伍，不得为君）」。
    // 本检查关心的是「该方向到底有没有可下的药」，两行都算数。
    .filter((line) => /^- .+方向（[^）]+）：/.test(line));
}

const concepts = governedTherapyConcepts();
assert.ok(concepts.length >= 20, `expected the full governed concept table, saw ${concepts.length}`);

const failures = [];
let checked = 0;

for (const concept of concepts) {
  const therapy = REPRESENTATIVE_THERAPY[concept];
  // A new concept with no representative phrase is itself a coverage hole: the test cannot prove
  // the direction is offerable, so fail loudly rather than skipping quietly.
  if (!therapy) {
    failures.push(`${concept}: no representative therapy phrase — add one to REPRESENTATIVE_THERAPY`);
    continue;
  }
  checked += 1;
  const prompt = buildPrescribePrompt(caseStateForTherapy(therapy));

  if (!prompt.includes(SHORTLIST_BLOCK)) {
    failures.push(`${concept}（治法「${therapy}」）: shortlist block absent while the prompt still back-references it`);
    continue;
  }

  const rows = shortlistDirectionRows(prompt);
  if (rows.length === 0) {
    failures.push(`${concept}（治法「${therapy}」）: shortlist block present but carries no direction row`);
    continue;
  }

  // At least one offered herb must carry a usable dose range, otherwise every candidate in the
  // direction is annotated 「无剂量边界，不得进入剂量候选」 and the shortlist cannot yield a
  // dose-level prescription.
  const hasDoseBoundedHerb = rows.some((row) => /\[\d+(?:\.\d+)?-\d+(?:\.\d+)?g/.test(row));
  if (!hasDoseBoundedHerb) {
    failures.push(`${concept}（治法「${therapy}」）: no dose-bounded herb offered — ${rows[0].slice(0, 80)}`);
  }
}

// The back-reference is unconditional in the hard constraints, which is precisely why an absent
// block is dangerous. Assert it is still there so this test keeps meaning if the wording moves.
const referencePrompt = buildPrescribePrompt(caseStateForTherapy(REPRESENTATIVE_THERAPY.blood_move));
assert.ok(
  referencePrompt.includes(SHORTLIST_BACK_REFERENCE),
  "the M04 hard constraint no longer back-references the shortlist — update SHORTLIST_BACK_REFERENCE",
);

// ─── 跨概念子串误命中 ────────────────────────────────────────────────────────
// 治法概念词表是一组正则，两个含义不同的概念可能在同一个规范术语里撞车。已实测一处：
// blood_move 的「通经」命中「温**通经**脉」——那是「温通 + 经脉」，表达温阳通脉而不是活血。
// 后果是桂枝的药典功用句「温通经脉，助阳化气」让它在肾阳虚证（治法「温补肾阳，化气利水」）里
// 被判活血方向未成立而驳回，而桂枝正是金匮肾气丸的法定组成。
//
// 下表逐条钉住「这个规范术语应当、且只应当命中哪些高影响方向」。新增或放宽任何一条概念正则时，
// 这里会先失败——比在门诊里被医生发现便宜得多。
const HIGH_IMPACT = ["heat_clear", "yang_warm", "blood_move", "purge", "orifice_open", "mass_soften"];
const PHRASE_EXPECTATIONS = [
  ["温通经脉", ["yang_warm"]],
  ["温经散寒", ["yang_warm"]],
  ["助阳化气", []],
  ["调和营卫", []],
  ["通经活络", ["blood_move"]],
  ["活血通经", ["blood_move"]],
  ["活血调经", ["blood_move"]],
  ["润肠通便", ["purge"]],
  ["泄热通便", ["heat_clear", "purge"]],
  // 通腑是泻下法的标准治法用语（通腑止痛/通腑泄热）。实测缺了它：M03 治法明确写「通腑止痛」，
  // 大黄仍被判 purge 方向未成立而驳回，清胃散加大黄的整方 0 味。
  ["通腑止痛", ["purge"]],
  ["通腑泄热", ["heat_clear", "purge"]],
  ["软坚散结", ["mass_soften"]],
  ["开窍醒神", ["orifice_open"]],
  ["温肺化饮", ["yang_warm"]],
  ["清热化痰", ["heat_clear"]],
  ["健脾益气", []],
  ["养血安神", []],
  ["平肝潜阳", []],
];
const conceptRegexes = readFileSync(new URL("../src/lib/diagnosis-stage-contract.ts", import.meta.url), "utf8")
  .match(/const TCM_THERAPY_CONCEPTS[^\[]*\[([\s\S]*?)\n\];/)?.[1] || "";
assert.ok(conceptRegexes, "无法从 diagnosis-stage-contract 提取 TCM_THERAPY_CONCEPTS —— 结构变了，请更新本检查");
const parsedConcepts = [...conceptRegexes.matchAll(/\["([a-z_]+)",\s*(\/(?:[^/\\\n]|\\.)+\/)\]/g)]
  .map(([, name, source]) => [name, new RegExp(source.slice(1, -1))]);
assert.ok(parsedConcepts.length >= 18, `只解析出 ${parsedConcepts.length} 条概念正则，解析器与源码结构脱节`);
const phraseFailures = [];
for (const [phrase, expected] of PHRASE_EXPECTATIONS) {
  const hit = parsedConcepts.filter(([, re]) => re.test(phrase)).map(([name]) => name)
    .filter((name) => HIGH_IMPACT.includes(name)).sort();
  const want = [...expected].sort();
  if (JSON.stringify(hit) !== JSON.stringify(want)) {
    phraseFailures.push(`「${phrase}」应命中 [${want.join(",")}]，实得 [${hit.join(",")}]`);
  }
}
assert.deepEqual(phraseFailures, [], `治法概念词表出现跨概念子串误命中：\n  ${phraseFailures.join("\n  ")}`);

// ─── 药侧触发收窄口径（HIGH_IMPACT_HERB_TRIGGER_OVERRIDES）────────────────────
// 高影响门对**药材知识文本**的触发用收窄正则；治法侧声明仍用上面的全口径。
// 实测类：归脾汤锁定后当归（补血活血，调经止痛，润肠通便）被判
// unsupported_high_impact_blood_move_purge，透明降级整方 0 味。695 味全量审计：
// purge 收窄仅改变 9 味润下兼功药，blood_move 收窄仅改变当归。
const triggerBlock = readFileSync(new URL("../src/lib/diagnosis-stage-contract.ts", import.meta.url), "utf8")
  .match(/const HIGH_IMPACT_HERB_TRIGGER_OVERRIDES[^\[]*\[([\s\S]*?)\n\];/)?.[1] || "";
assert.ok(triggerBlock, "无法提取 HIGH_IMPACT_HERB_TRIGGER_OVERRIDES —— 结构变了，请更新本检查");
const parsedTriggers = new Map([...triggerBlock.matchAll(/\["([a-z_]+)",\s*(\/(?:[^/\\\n]|\\.)+\/)\]/g)]
  .map(([, name, source]) => [name, new RegExp(source.slice(1, -1))]));
assert.ok(parsedTriggers.has("purge") && parsedTriggers.has("blood_move"), "触发收窄表缺 purge/blood_move 条目");
const TRIGGER_EXPECTATIONS = [
  // [药材知识文本片段, 概念, 是否触发]
  ["补血活血，调经止痛，润肠通便", "purge", false],   // 当归：润下兼功不是攻下身份
  ["补血活血，调经止痛，润肠通便", "blood_move", false], // 当归：和血搭配不是破血逐瘀身份
  ["泻下攻积，清热泻火，凉血解毒", "purge", true],    // 大黄
  ["泻热行滞，通便，利水", "purge", true],            // 番泻叶：独立「通便」仍触发
  ["泻水逐饮，消肿散结；泻下药；峻下逐水药", "purge", true], // 甘遂：功用文本无「逐水」原词，靠分类触发（narrowedOut 的输入=功用∪分类∪风险）
  ["活血祛瘀，止痛，润肠通便", "blood_move", true],   // 桃仁：独立「活血」仍触发
  ["活血行气，祛风止痛", "blood_move", true],         // 川芎
  ["养血活血，调经", "blood_move", false],            // 和血类
];
const triggerFailures = [];
for (const [text, concept, expected] of TRIGGER_EXPECTATIONS) {
  const hit = parsedTriggers.get(concept).test(text);
  if (hit !== expected) triggerFailures.push(`「${text}」×${concept} 期望 ${expected}，实得 ${hit}`);
}
assert.deepEqual(triggerFailures, [], `药侧触发收窄口径失守：\n  ${triggerFailures.join("\n  ")}`);

// ─── 锚点表↔概念表同域同步（妇科调固类）────────────────────────────────────────
// 锚点表（TCM_PATHOGENESIS/THERAPY_ANCHOR）管 M03 病机链锚定，概念表管 M04 治法归解；
// 同一词汇域的两张投影，扩一张不同步另一张的实测后果：M03 治法「调理冲任，固经调冲」通过
// 链锚定，M04 侧 requiredTherapyConcepts 为空集，每一版候选都被 transparent_therapy_unresolved
// 整方驳回（月经先期-血热 三连拒 0 味）。下表钉住：链锚定认可的治法措辞必须能解析出概念。
const GYN_THERAPY_PHRASES = [
  ["调理冲任，固经调冲", ["astringe", "menstrual_regulate"]],
  ["固冲摄血", ["astringe", "hemostasis"]],
  ["清热凉血，固冲调经", ["astringe", "heat_clear", "menstrual_regulate"]],
  ["固经止崩", ["astringe"]],
  ["养血调经", ["blood_nourish", "menstrual_regulate"]],
];
const gynFailures = [];
for (const [phrase, expected] of GYN_THERAPY_PHRASES) {
  const hit = parsedConcepts.filter(([, re]) => re.test(phrase)).map(([name]) => name).sort();
  const want = [...expected].sort();
  if (JSON.stringify(hit) !== JSON.stringify(want)) gynFailures.push(`「${phrase}」应解析 [${want.join(",")}]，实得 [${hit.join(",")}]`);
  if (hit.length === 0) gynFailures.push(`「${phrase}」解析为空集——M04 将以 transparent_therapy_unresolved 整方驳回`);
}
assert.deepEqual(gynFailures, [], `妇科调固类治法概念解析失守：\n  ${gynFailures.join("\n  ")}`);

// ─── 「补益动词 + 脏腑 + 阴阳」构词（动词与阴/阳被脏腑名隔开）─────────────────
// 实测腰痛-肾阴虚：M03 治法写「滋补肾阴，壮水制火」，而 yin_nourish 只认紧邻的「滋阴/补阴」，
// requiredTherapyConcepts 解析为空集，M04 以 transparent_therapy_unresolved 整方作废、0 味。
// 这是构词类而非单词遗漏：滋补肾阴/滋养肝阴/滋补肝肾/补益肝肾/滋肾养肝/补肾壮阳 同族。
const ORGAN_TONIFY_PHRASES = [
  ["滋补肾阴", "yin_nourish"],
  ["滋养肝阴", "yin_nourish"],
  ["滋补肝肾", "yin_nourish"],
  ["补益肝肾", "yin_nourish"],
  ["滋肾养肝", "yin_nourish"],
  ["壮水制火", "yin_nourish"],
  ["补肾壮阳", "yang_warm"],
  ["温补肾阳", "yang_warm"],
];
const organFailures = [];
for (const [phrase, expected] of ORGAN_TONIFY_PHRASES) {
  const hit = parsedConcepts.filter(([, re]) => re.test(phrase)).map(([name]) => name);
  if (!hit.includes(expected)) organFailures.push(`「${phrase}」应命中 ${expected}，实得 [${hit.join(",")}]`);
}
assert.deepEqual(organFailures, [], `补益类构词解析失守：\n  ${organFailures.join("\n  ")}`);
// 边界：桂枝「助阳化气」是温通助阳而非温里方向，扩展构词不得把它吞进 yang_warm
// （既有钉子在 PHRASE_EXPECTATIONS 里，这里再钉一次动机，避免下次扩正则时重蹈覆辙）。
{
  const yangWarm = new Map(parsedConcepts).get("yang_warm");
  assert.equal(yangWarm.test("助阳化气"), false, "「助阳化气」不得命中 yang_warm——它是桂枝的温通助阳，不是温里");
}
// 治法侧全口径不受收窄影响：润肠通便作为治法声明仍算 purge 方向已成立。
{
  const shared = new Map(parsedConcepts);
  assert.equal(shared.get("purge").test("润肠通便"), true, "治法侧共享词表必须保留 润肠通便→purge 声明能力");
  assert.equal(shared.get("blood_move").test("养血活血"), true, "治法侧共享词表必须保留 养血活血→blood_move 声明能力");
}

assert.deepEqual(failures, [], `governed therapy directions without an injectable shortlist:\n  ${failures.join("\n  ")}`);

console.log(JSON.stringify({ governedConcepts: concepts.length, checked, failures: failures.length }, null, 2));

// ─── prompt 顺序即缓存边界 ───────────────────────────────────────────────────
// DeepSeek 的 context caching 按**前缀**自动命中（实测同一 2866-token 前缀第二次起命中 2816，
// 无需任何请求参数）。M03 模板此前把患者资料排在第 114 个字符，等于把其后约 16k 字符的
// 固定规范全挡在缓存外——每个病例都重新处理一遍完全相同的输出规范。
// 因此固定规范必须整体前置、逐例变化的内容整体后置。这条一旦被改回，缓存收益会静默消失，
// 没有任何测试会红——所以在这里钉住。
{
  const { buildDiagnosePrompt } = await import("../src/lib/diagnosis-prompts.ts");
  const caseState = caseStateForTherapy("疏肝理气");
  caseState.chiefComplaint = "缓存边界探针主诉ABCXYZ";
  caseState.phase = "diagnose";
  const prompt = buildDiagnosePrompt(caseState, {});
  const boundary = prompt.indexOf("以上为固定规范");
  assert.ok(boundary > 0, "M03 模板必须保留固定规范与病例资料之间的显式分界句");
  const caseAt = prompt.indexOf("缓存边界探针主诉ABCXYZ");
  assert.ok(caseAt > boundary,
    `患者资料必须排在固定规范之后（分界 ${boundary}，资料 ${caseAt}）——否则前缀缓存只能覆盖到资料之前`);
  assert.ok(boundary / prompt.length >= 0.5,
    `可缓存前缀应覆盖模板的大部分（当前 ${Math.round(boundary * 100 / prompt.length)}%）`);
  // 结构化输出契约属于固定规范，必须在分界之前（用 schema 版本号定位，sentinel 字面串
  // 由下游注入、不出现在本模板里）。
  const contractAt = prompt.indexOf("tcm-cdss-reasoning-v2");
  assert.ok(contractAt > 0 && contractAt < boundary,
    "结构化输出契约是逐例不变的规范，必须留在可缓存前缀内");
}

// ─── 国标治法词表覆盖率 + 未覆盖时的能力边界降级 ─────────────────────────────
// 缺口的成因不是「某几种说法没想到」，而是概念正则与 GB/T 受控治法词表从未做过全量对账。
// 实测：「滋补肾阴」（词表收录、正则未覆盖）→ requiredTherapyConcepts 为空 →
// transparent_therapy_unresolved → 整方 0 味。逐条补说法只会让下一条同类缺口重演。
// 因此这里同时钉住两件事：
//   (a) 全量对账后的覆盖率下限——回归到补丁式维护会立刻红；
//   (b) 真·长尾（针灸/推拿/外科外治，本就无内服药味方向）不得再判成临床错误。
{
  const { readFileSync } = await import("node:fs");
  const { affirmedTcmTherapyConcepts } = await import("../src/lib/diagnosis-stage-contract.ts");
  const lexicon = JSON.parse(readFileSync(new URL("../src/data/tcm-treatment-principle-lexicon.json", import.meta.url), "utf8"));
  const terms = lexicon.entries
    .filter((e) => e.category === "治法类术语" && e.termClass !== "category_heading")
    .map((e) => e.standardTerm)
    .filter((t) => typeof t === "string" && t);
  assert.ok(terms.length > 900, `国标治法词表应当被完整读入（当前 ${terms.length} 条）`);
  // 操作疗法（针灸/推拿/拔罐/注射/手术…）与外科疮疡外治不映射药味方向，属定义域之外。
  const PROCEDURE = /疗法$|针法|灸法|针刺|推拿|按摩|拔罐|刮痧|挂线|注射|切开|结扎|熏洗|坐浴|敷|贴|导引|气功|手法|术$|其他/;
  const TOPICAL = /止痒|开音|明目|利耳|利鼻|利咽|濡耳|去翳|退翳|固齿|通耳|通鼻|定痛|收口|排脓|生肌|祛腐|托毒|提脓|长肉|消肿|拔毒/;
  const internal = terms.filter((t) => !PROCEDURE.test(t) && !TOPICAL.test(t));
  const uncovered = internal.filter((t) => affirmedTcmTherapyConcepts(t).size === 0);
  const rate = (internal.length - uncovered.length) / internal.length;
  assert.ok(rate >= 0.95,
    `国标内服治法覆盖率 ${(rate * 100).toFixed(1)}%（${uncovered.length}/${internal.length} 未覆盖）低于 95% 下限；` +
    `未覆盖样例：${uncovered.slice(0, 12).join("、")}`);

  // (b) 词表覆盖不到 ≠ 治法不成立。方向不可核验时降级为「该维度不自动核验」，
  // 其余检查（药味知识/剂量/配伍禁忌/特殊人群/君臣结构/灵犀审方）一条不减。
  const prior = caseStateForTherapy("治五官法");            // 定义域之外、必然解析为空的治法
  const { transparentFormulaTherapyIssue } = await import("../src/lib/diagnosis-stage-contract.ts");
  assert.equal(affirmedTcmTherapyConcepts("治五官法").size, 0, "该探针治法应当解析为空（用于探测降级路径）");
  const reasoning = {
    formula: {
      candidates: [{
        name: "辨证组方", formulaNames: [], constructionType: "self_devised", therapyMatch: "治五官法",
        herbs: [{ name: "桔梗", dose: "6g", role: "君", prescriptionRole: "宣肺利咽", targetKind: "pathogenesis_node", targetRef: "P1", targetPathogenesis: "示例病机", function: "", decoctionRequirement: "" }],
      }],
    },
  };
  const probe = transparentFormulaTherapyIssue(reasoning, prior);
  assert.notEqual(probe, "transparent_therapy_unresolved",
    "词表未覆盖的治法必须降级为不自动核验，而不是把整方判为 transparent_therapy_unresolved");
}
