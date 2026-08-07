import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const readJson = (name) => JSON.parse(readFileSync(new URL(`../src/data/${name}`, import.meta.url), "utf8"));
const sha256 = (name) => createHash("sha256")
  .update(readFileSync(new URL(`../src/data/${name}`, import.meta.url)))
  .digest("hex");

const manifest = readJson("clinical-governance-table-manifest.json");
assert.equal(manifest.schemaVersion, "clinical-governance-table-manifest-v1");
assert.deepEqual(manifest.tables.map((item) => item.id), ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12"]);
for (const table of manifest.tables) {
  assert.equal(table.sha256, sha256(table.file), `${table.id} manifest hash drift`);
  assert.ok(table.recordCount > 0, `${table.id} must not be empty`);
}
assert.equal(manifest.sourceRegistry.sha256, sha256(manifest.sourceRegistry.file), "source registry manifest hash drift");
assert.equal(manifest.auxiliaryIndexes.length, 1);
assert.equal(manifest.auxiliaryIndexes[0].sha256, sha256(manifest.auxiliaryIndexes[0].file), "T8 retrieval index manifest hash drift");

const syndrome = readJson("tcm-syndrome-lexicon.json");
const nature = readJson("tcm-nature-lexicon.json");
const location = readJson("tcm-location-lexicon.json");
const principles = readJson("tcm-treatment-principle-lexicon.json");
const diagnostics = readJson("diagnostics-context-lexicon.json");
const redflags = readJson("redflag-triage-lexicon.json");
const jargon = readJson("engineering-jargon-lexicon.json");
const formulas = readJson("tcm-formula-governed-catalog.json");
const formulaRetrievalConcepts = readJson("tcm-formula-retrieval-concepts.json");
const formulaRetrievalIndex = readJson("tcm-formula-retrieval-index.json");
const highFrequencyFormulaRelations = readJson("tcm-high-frequency-syndrome-formula-relations.source.json");
const herbs = readJson("tcm-herb-identity-catalog.json");
const requiredFields = readJson("clinical-required-field-matrix.json");
const outputContracts = readJson("clinical-output-contract-registry.json");
const nondrugTreatments = readJson("tcm-nondrug-treatment-evidence-catalog.json");
const sourceRegistry = readJson("clinical-governance-source-registry.json");
const genericSingleAxisSyndromes = new Set(["阴", "阳", "表", "里", "寒", "热", "虚", "实"]);
assert.deepEqual(
  highFrequencyFormulaRelations.entries
    .map((item) => item.syndrome)
    .filter((syndromeName) => genericSingleAxisSyndromes.has(syndromeName)),
  [],
  "T8 不得用单字八纲词直接绑定方剂，否则会退化成“寒->寒泻方”式名称对拍",
);

const governedPayloads = new Map([
  ["T1", syndrome], ["T2", nature], ["T3", location], ["T4", principles],
  ["T5", diagnostics], ["T6", redflags], ["T7", jargon], ["T8", formulas],
  ["T9", herbs], ["T10", requiredFields], ["T11", outputContracts], ["T12", nondrugTreatments],
]);
const recordCount = (id, payload) => {
  if (Array.isArray(payload.entries)) {
    return payload.entries.length + (["T1", "T4"].includes(id) ? (payload.clinicalExtensions || []).length : 0);
  }
  if (id === "T5") return payload.groups.length;
  if (id === "T6") return payload.categoryRules.length;
  throw new Error(`${id} has no governed record collection`);
};
for (const table of manifest.tables) {
  assert.equal(recordCount(table.id, governedPayloads.get(table.id)), table.recordCount, `${table.id} record count drift`);
}

const unique = (items, label) => {
  assert.equal(new Set(items).size, items.length, `${label} contains duplicates`);
};
for (const [label, payload] of [["syndrome", syndrome], ["nature", nature], ["location", location], ["principle", principles]]) {
  unique(payload.entries.map((item) => item.id), `${label} ids`);
  unique(payload.entries.map((item) => item.canonical), `${label} canonical terms`);
}
assert.equal(syndrome.summary.standardTermCount, 2060);
assert.equal(syndrome.summary.clinicalExtensionCount, 1);
assert.equal(syndrome.clinicalExtensions[0].canonical, "肝火扰心");
assert.equal(principles.summary.standardTermCount, 1276);
assert.equal(principles.summary.clinicalExtensionCount, 3);
assert.ok(syndrome.entries.every((item) => item.sourceRefs.includes("SRC-GBT-16751-2-2021")));
assert.ok(principles.entries.every((item) => item.sourceRefs.includes("SRC-GBT-16751-3-2023")));
assert.ok(syndrome.entries.filter((item) => item.definitionSha256).every((item) => /^[a-f0-9]{64}$/.test(item.definitionSha256)));
assert.ok(principles.entries.filter((item) => item.definitionSha256).every((item) => /^[a-f0-9]{64}$/.test(item.definitionSha256)));
const natureIds = new Set(nature.entries.map((item) => item.id));
const locationIds = new Set(location.entries.map((item) => item.id));
for (const item of syndrome.entries) {
  item.natures.forEach((id) => assert.ok(natureIds.has(id), `${item.id} unknown nature ${id}`));
  item.locations.forEach((id) => assert.ok(locationIds.has(id), `${item.id} unknown location ${id}`));
}

const combined = principles.entries.find((item) => item.canonical === "标本兼治");
assert.equal(combined?.permitsPrioritization, true, "标本兼顾 may still document clinical priority with rationale");
assert.ok(combined?.aliases.includes("标本兼顾"));
assert.ok(principles.entries.find((item) => item.canonical === "正治法")?.aliases.includes("正治"));
assert.ok(principles.entries.find((item) => item.canonical === "反治法")?.aliases.includes("反治"));
assert.ok(principles.entries.find((item) => item.canonical === "急则治标")?.aliases.includes("治标"));
assert.ok(principles.entries.find((item) => item.canonical === "缓则治本")?.aliases.includes("治本"));
assert.deepEqual(principles.clinicalExtensions.map((item) => item.canonical), ["三因制宜", "治病求本", "同病异治"]);
const abdominalExam = diagnostics.groups.find((item) => item.id === "tcm_abdominal_examination");
assert.equal(abdominalExam?.tcmReasoningPolicy, "allowed_when_case_bound_and_relevant", "腹诊 must not become a blanket forbidden term");
assert.equal(redflags.governance.hardGateAuthority, "deterministic_rule_or_validated_vital_threshold");
assert.equal(redflags.governance.semanticModelRole, "grounded_additive_detection_and_clarification");
assert.ok(jargon.entries.some((item) => item.terms.includes("程序化")));
assert.ok(jargon.entries.some((item) => item.terms.includes("信息不足，需补齐")));
assert.ok(jargon.entries.some((item) => item.terms.includes("剂量级")));
assert.ok(diagnostics.groups.find((item) => item.id === "modern_laboratory")?.terms.includes("TSH"));
assert.ok(diagnostics.groups.find((item) => item.id === "modern_imaging")?.terms.includes("B超"));
assert.ok(redflags.dimensions.acuteOnset.includes("急性"));
assert.ok(redflags.dimensions.severe.includes("刀割样"));
assert.ok(redflags.categoryRules.find((item) => item.id === "acute_abdomen")?.symptoms.includes("胃部疼痛"));
assert.equal(nature.entries.find((item) => item.canonical === "内风")?.aliases.includes("动风"), true);
assert.equal(nature.entries.some((item) => item.canonical === "虫积"), true);
for (const term of ["太阳", "阳明", "少阳", "太阴", "少阴", "厥阴", "冲任"]) {
  assert.equal(location.entries.some((item) => item.canonical === term), true, `T3 missing ${term}`);
}

// 与 curated 关系表同样的「只增不减」约定：目录与各项资格数会随治理推进增长，
// 用下限而非等值断言——等值字面量每次补一条主治/标签都要手改，改的人往往只改一处
// （本文件与 manifest 曾出现 319/320 不一致，测试红了两天）。下限才守得住真正的不变量：
// 覆盖面不得倒退。
const FORMULA_CATALOG_FLOOR = 1800;
const FORMULA_ELIGIBLE_FLOOR = 1795;
const FORMULA_DOSE_ELIGIBLE_FLOOR = 899;
assert.ok(formulas.summary.governedFormulaCount >= FORMULA_CATALOG_FLOOR,
  `受控方剂数不得低于 ${FORMULA_CATALOG_FLOOR}，实际 ${formulas.summary.governedFormulaCount}`);
assert.ok(formulas.summary.identityLockEligibleCount >= FORMULA_ELIGIBLE_FLOOR,
  `身份锁可用方剂数不得低于 ${FORMULA_ELIGIBLE_FLOOR}，实际 ${formulas.summary.identityLockEligibleCount}`);
assert.ok(formulas.summary.prescriptionLockEligibleCount >= FORMULA_ELIGIBLE_FLOOR,
  `处方锁可用方剂数不得低于 ${FORMULA_ELIGIBLE_FLOOR}，实际 ${formulas.summary.prescriptionLockEligibleCount}`);
assert.ok(formulas.summary.doseCompilationEligibleCount >= FORMULA_DOSE_ELIGIBLE_FLOOR,
  `剂量可编译方剂数不得低于 ${FORMULA_DOSE_ELIGIBLE_FLOOR}，实际 ${formulas.summary.doseCompilationEligibleCount}`);
// The curated T8 relation table is expected to grow. Assert the invariants that actually protect
// recall — every curated row resolves AND stays reachable through the runtime resolver, and the
// table never shrinks below the committed floor — instead of a literal that has to be edited on
// every coverage addition. A reported count that exceeds runtime reachability is the exact
// overstatement this guard exists to catch.
const HIGH_FREQUENCY_SYNDROME_FLOOR = 77;
for (const summary of [formulas.summary, formulaRetrievalIndex.summary]) {
  assert.ok(summary.highFrequencySyndromeTargetCount >= HIGH_FREQUENCY_SYNDROME_FLOOR);
  assert.equal(summary.highFrequencySyndromeSourceResolvedCount, summary.highFrequencySyndromeTargetCount);
  assert.equal(summary.highFrequencySyndromeRuntimeReachableCount, summary.highFrequencySyndromeTargetCount);
  assert.equal(summary.highFrequencySyndromeCoveredCount, summary.highFrequencySyndromeRuntimeReachableCount);
}
assert.ok(formulas.summary.curatedSyndromeFormulaRelationCount >= HIGH_FREQUENCY_SYNDROME_FLOOR);

// ─── 项目补充方压过 SZJG 官方标准的已知清单（不得扩大） ───
// 文档写明出处优先级 official_classic > SZJG 官方标准 > 项目补充，但 governed 目录按插入顺序占名，
// 项目补充先写入，SZJG 循环的 `if name in governed: continue` 会把官方标准整条丢掉。
// 实测被遮蔽的有 4 首，其中 2 首组成有实质差异、有临床后果：
//   归脾汤——目录用《济生》8 味原版，缺当归、远志；SZJG 是薛己 10 味版；
//   逍遥散——目录用 6 味版，缺煨姜、薄荷。
// 另 2 首（酸枣仁汤、附子汤）两版组成基本一致，只是出处标签不同，暂无临床影响。
// **暂不修**：修governed 目录这一侧会让 resolveFormulaSources（读的是另一套
// tcm-formula-sources.json，其候选池根本不含 SZJG 标准方）继续返回旧版本，
// 造成「M04 按 10 味编译、界面标 8 味出处」的分裂；而把 SZJG 变体加进那个候选池，
// 又会与本地工作簿的历史变体近分竞争，触发 bestFormulaSourceCandidate 的
// 「不同组成近分则拒绝归典」守卫，把几百首原本能归典的方变成零出处。
// 真正的修法是统一这两套出处目录，属于独立改造。这条断言的作用是**冻结现状**：
// 名单不得扩大，新增任何一首都说明优先级又被绕过了。
const KNOWN_SUPPLEMENT_OVER_STANDARD = ["归脾汤", "逍遥散", "酸枣仁汤", "附子汤"];
const szjgStandard = readJson("szjg-tcm-formula-standard.json");
const szjgNames = new Set(szjgStandard.entries.map((entry) => entry.name.replace(/\s/g, "")));
const shadowedStandards = formulas.entries
  .filter((entry) => entry.sourceClass === "verified_reference_catalog")
  .filter((entry) => szjgNames.has(entry.name.replace(/\s/g, "")))
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(shadowedStandards, [...KNOWN_SUPPLEMENT_OVER_STANDARD].sort(),
  `项目补充方压过同名 SZJG 官方标准的清单不得扩大，实际：${shadowedStandards.join("、")}`);

// ─── 按方裁定的药味身份必须逐条落地，且只影响被裁定的那一首方 ───
// 赤芍与白芍功效方向相反（清热凉血 vs 养血敛阴）。古方只写「芍药」时品种由该方原书决定，
// 不能全局归一——同一个「芍药」在桂枝汤系里是白芍、在排脓散里是赤芍（王子接注「芍药用赤」）。
// 因此这张表是 (方名, 原文药名) → 品种；这里断言它确实按方生效，而不是被当成全局别名。
const ingredientAdjudications = readJson("tcm-formula-ingredient-identity-adjudications.source.json");
assert.equal(ingredientAdjudications.schemaVersion, "tcm-formula-ingredient-identity-adjudications-v1");
const catalogByName = new Map(formulas.entries.map((entry) => [entry.name, entry]));
const adjudicatedPairs = new Set();
for (const row of ingredientAdjudications.entries) {
  const entry = catalogByName.get(row.formulaName);
  assert.ok(entry, `被裁定的方必须在受控目录里：${row.formulaName}`);
  const link = (entry.ingredientLinks || []).find((item) => item.rawName === row.rawIngredient);
  assert.ok(link, `裁定的原文药名必须真的出现在该方组成里：${row.formulaName}->${row.rawIngredient}`);
  assert.equal(link.adjudicatedIngredient, row.resolvedIngredient,
    `裁定未落地：${row.formulaName}->${row.rawIngredient} 应解析为 ${row.resolvedIngredient}`);
  assert.ok(link.autoResolvable, `裁定后的药味必须能被 T9 自动解析，否则解不出剂量边界：${row.formulaName}->${row.rawIngredient}`);
  adjudicatedPairs.add(`${row.formulaName}\u0000${row.rawIngredient}`);
}
// 反向：没有被裁定的方，其同名药味不得被裁定结果污染。
for (const entry of formulas.entries) {
  for (const link of entry.ingredientLinks || []) {
    if (!link.adjudicatedIngredient) continue;
    assert.ok(adjudicatedPairs.has(`${entry.name}\u0000${link.rawName}`),
      `未被裁定的方出现了裁定结果，说明按方裁定退化成了全局归一：${entry.name}->${link.rawName}`);
  }
}
// 同一味原文药名在不同方里可以判成不同品种——这正是「按方」的意义所在。
const shaoyaoTargets = new Set(ingredientAdjudications.entries
  .filter((row) => row.rawIngredient === "芍药")
  .map((row) => row.resolvedIngredient));
assert.ok(shaoyaoTargets.has("白芍") && shaoyaoTargets.has("赤芍"),
  "芍药裁定必须同时存在白芍与赤芍两种结论，否则说明退化成了一刀切默认");

// ─── 剂量依据未经复核的药材，不得因身份补充而获得剂量编制许可 ───
// 剂量 KB 里有一类药材：它的数值剂量边界**只**出自「常用药典用量/调剂规范待人工复核」
// 「高置信中药饮片剂量校准层」「甲方反馈补充」这类依据，没有任何一条药典条目背书。
// 它们在 T9 身份表里查不到，因此含这些药的方剂一律不可编译剂量——**这是正确的保守行为**。
//
// 本轮我一度往 T9 补了龙骨/五灵脂/败酱草的身份条目，理由写的是「剂量 KB 已有药典口径」。
// 那个理由是错的（basis 明写待人工复核），联网核实龙骨自 1977 年版起已不被《中国药典》收载、
// 15-30g 出自地方炮制规范。后果是含这三味药的方从 0 首变成 30 首可编译剂量——
// 等于用未经复核的校准值给药典外的药开了自动配剂量权限。已撤回。
//
// 这里**从 KB 推导整类**而不是钉死当时那 6 个名字：新增一味 curatedDose-only 的药材时，
// 断言会自动把它纳入保护，不需要有人记得回来改列表。
const PHARMACOPOEIA_DOSE_BASIS = /中华人民共和国药典|中国药典2020一部/;
const UNREVIEWED_BASIS_MARK = /待人工复核|校准层|推定|甲方反馈/;
const isAuthorizedWebCurated = (item) => {
  let source;
  try {
    source = new URL(String(item.sourceUrl || ""));
  } catch {
    return false;
  }
  return item.webCurated === true &&
    source.protocol === "https:" &&
    (source.hostname === "gov.cn" || source.hostname.endsWith(".gov.cn")) &&
    typeof item.herb === "string" && item.herb.trim().length > 0 &&
    typeof item.basis === "string" && item.basis.trim().length > 0 &&
    typeof item.sourceAnchor === "string" && item.sourceAnchor.trim().length > 0 &&
    typeof item.sourceSha256 === "string" && /^[0-9a-f]{64}$/i.test(item.sourceSha256) &&
    !UNREVIEWED_BASIS_MARK.test(item.basis) &&
    Number.isFinite(item.minG) && item.minG > 0 &&
    Number.isFinite(item.maxG) && item.maxG >= item.minG;
};
const doseKnowledge = readJson("tcm-knowledge.json");
// 与运行时同构：只有通过官方来源校验的 webCurated 行才从未复核集合中排除。
// 当前二次验真后的 entries 为空；今后新增记录时必须先满足同一准入函数。
const webDoseSupplements = readJson("tcm-herb-dose-web-supplements.source.json");
assert.deepEqual(
  (webDoseSupplements.entries || []).filter((entry) => !isAuthorizedWebCurated(entry)),
  [],
  "官方联网剂量补充不得接受二手网页、HTTP、无原文锚点/快照哈希、无明确数值边界或待复核依据",
);
assert.ok(
  (webDoseSupplements.rejectedClaims || []).some((entry) =>
    Array.isArray(entry.herbs) && entry.herbs.includes("龙骨") &&
    /未定位到.*数值剂量/.test(String(entry.reason || ""))),
  "已查明的来源错配必须留在治理审计记录中，不能删除痕迹后重新放行",
);
const authorizedWebHerbs = new Set((webDoseSupplements.entries || [])
  .filter((entry) => isAuthorizedWebCurated(entry))
  .flatMap((entry) => [entry.herb, entry.canonicalName].filter(Boolean))
  .map((name) => String(name).replace(/\s+/g, "")));
const unreviewedDoseHerbs = new Set((doseKnowledge.herbs || [])
  .filter((herb) => {
    if (authorizedWebHerbs.has(String(herb.name || "").replace(/\s+/g, ""))) return false;
    const bounded = (herb.entries || []).filter((item) => item.minG != null || item.maxG != null);
    if (bounded.length === 0) return false;
    // 药典正条或「已授权 webCurated 层」任一存在,都不算未复核。
    return !bounded.some((item) => PHARMACOPOEIA_DOSE_BASIS.test(String(item.basis || "")) || isAuthorizedWebCurated(item));
  })
  .map((herb) => herb.name));
assert.ok(unreviewedDoseHerbs.size > 0,
  "未能从 KB 推导出「剂量依据未复核」药材集合，basis 字段口径可能变了——先修这里，别让断言退化成空转");
// 断言直接钉**目录级不变量**，而不是去管 T9 补充表怎么写：
// 「灵脂 → 五灵脂」这类身份映射本身是对的，不该被禁；真正不能发生的是
// **某方因为一个未复核的剂量值而变成可自动配剂量**。按结果断言，既不冤枉正确的身份映射，
// 也拦得住任何一条通往同一后果的新路径（补充表、别名表、重定向、KB 新增条目）。
//
// 生效的剂量名口径必须与构建器一致：doseCanonicalName || canonicalName（不是 inputName），
// 见 build-tcm-governance-tables.py 的 `link["doseCanonicalName"] or link["canonicalName"]`。
//
// 官方联网层必须同时满足：① webCurated:true；② HTTPS 政府域名；
// ③ 明确药名/依据/正数边界；④ basis 不含待复核或推定字样。
// 即便来源文件是政府站点，只要原文不能定位到具体数值，也必须留在 rejectedClaims，不能进 entries。
const effectiveDoseName = (link) => link.doseCanonicalName || link.canonicalName || link.inputName || link.name;
const doseCompiledOnUnreviewedBasis = formulas.entries
  .filter((entry) => entry.doseCompilationEligible)
  .map((entry) => ({
    name: entry.name,
    herbs: [...new Set((entry.ingredientLinks || [])
      .map(effectiveDoseName)
      .filter((name) => name && unreviewedDoseHerbs.has(name)))],
  }))
  .filter((entry) => entry.herbs.length > 0);
// 剂量豁免层启用后（甲方 2026-08-01 决策：降低门禁、审方兜底），这条不变量换了表达方式：
// 「待人工复核/校准层」的推定剂量仍然**不得被当成药典口径**——但处理方式不再是否决整方，
// 而是把该药味明确登记进医师定量豁免表，处方里按 clinicianDoseHerbClass 标注核验级别
//（天南星有毒且列高风险监管目录 → toxic_regulated），用量由医师确定并经灵犀审方复核。
// 因此这里断言的是「登记完整」而不是「一律否决」：任何靠推定值获得编译许可、却没有
// 在豁免表里留痕的药味，都是真正的漏洞——它会以「系统认可的剂量」形态出现在医生面前。
{
  const { clinicianDoseHerbClass } = await import("../src/lib/tcm-knowledge.ts");
  const untracked = doseCompiledOnUnreviewedBasis
    .flatMap((entry) => entry.herbs.map((herb) => ({ formula: entry.name, herb })))
    .filter(({ herb }) => !clinicianDoseHerbClass(herb));
  assert.deepEqual(untracked.slice(0, 10), [],
    "靠「待人工复核/校准层」推定剂量获得编译许可的药味必须登记在医师定量豁免表里并标注核验级别，" +
    "否则它会以「系统认可的剂量」形态呈现给医生：" +
    untracked.slice(0, 10).map((item) => `${item.formula}[${item.herb}]`).join("; "));
}

// ─── 药典只许丸散的药材，不得进入煎剂剂量编制 ───
// 上一条管「剂量数字的依据可不可信」，这一条管「这味药能不能煎」——两个正交的轴，
// 都必须查。KB 里 44 味药的药典分途径条目只有丸散/外用而无煎服：马钱子、巴豆霜、斑蝥、
// 蟾酥、雄黄、朱砂、轻粉、洋金花、闹羊花、甘遂、麝香…它们此前照样拿到煎剂配剂量许可，
// 155 首方受影响，其中 18 首方名明确是汤（升麻鳖甲汤[雄黄]、散瘀和伤汤[马钱子]、
// 十枣汤[甘遂]——而十枣汤的经典用法本就是三药研末、枣汤送服，根本不入煎）。
//
// 判据只认药典自列途径：无分途径条目 ⇒ 不排除（缺数据不等于证据）；
// 「校准层」凭空补出的煎服途径不计入（它与药典同表的「丸散」「有毒且不入汤剂」冲突）。
const DECOCTION_ROUTE = /煎服|汤剂|另煎|另炖/;
const PILL_POWDER_ROUTE = /丸散|丸剂|胶囊/;
const DECOCTION_OPTION_CODE = "DECOCTION_OPTION";
const pillOnlyHerbs = new Set((doseKnowledge.herbs || [])
  .filter((herb) => {
    const routeEntries = (herb.entries || [])
      .filter((item) => item.type === "routeDose" && PHARMACOPOEIA_DOSE_BASIS.test(String(item.basis || "")));
    const routes = routeEntries.map((item) => `${item.routeForm || ""}${item.method || ""}`);
    if (
      routes.length === 0
      || routes.some((route) => DECOCTION_ROUTE.test(route))
      || routeEntries.some((item) => String(item.methodCodes || "").includes(DECOCTION_OPTION_CODE))
    ) return false;
    return routes.some((route) => PILL_POWDER_ROUTE.test(route));
  })
  .map((herb) => herb.name));
assert.equal(pillOnlyHerbs.has("乳香"), false,
  "药典原文“煎汤或入丸散”的 DECOCTION_OPTION 必须保留煎服许可，不能按仅丸散阻断");
assert.ok(pillOnlyHerbs.size > 0,
  "未能从 KB 推导出「药典仅丸散」药材集合，分途径条目口径可能变了——先修这里，别让断言空转");
const decoctionCompiledPillOnly = formulas.entries
  .filter((entry) => entry.doseCompilationEligible)
  .map((entry) => ({
    name: entry.name,
    herbs: [...new Set((entry.ingredientLinks || [])
      .map(effectiveDoseName)
      .filter((name) => name && pillOnlyHerbs.has(name)))],
  }))
  .filter((entry) => entry.herbs.length > 0);
// 剂型正交轴：药典只列丸散/外用的药材（朱砂、麝香、雄黄、冰片…）不得被按汤剂配量。
// 豁免层启用后这条不变量的落点变了——含这类成分的方多数**本身就是丸散膏剂**
//（安宫牛黄丸、紫金锭、七厘散），系统并没有替它们编汤剂数字剂量，而是把该药味登记进
// 医师定量豁免表、按 clinicianDoseHerbClass 标注核验级别，用量与剂型由医师判断、审方复核。
// 因此断言改为「登记完整」：任何获编译许可、却没在豁免表留痕的丸散专用药味都是真漏洞。
{
  const { clinicianDoseHerbClass } = await import("../src/lib/tcm-knowledge.ts");
  const untrackedPillOnly = decoctionCompiledPillOnly
    .flatMap((entry) => entry.herbs.map((herb) => ({ formula: entry.name, herb })))
    .filter(({ herb }) => !clinicianDoseHerbClass(herb));
  assert.deepEqual(untrackedPillOnly.slice(0, 10), [],
    "药典仅丸散/外用的药材若获编译许可，必须登记在医师定量豁免表并标注核验级别：" +
    untrackedPillOnly.slice(0, 10).map((item) => `${item.formula}[${item.herb}]`).join("; "));
}

// ─── 监管轴：管制品种不得自动编制剂量 ───
// 前两条管"剂量数字可不可信"和"这味药能不能煎"，都是药学问题。这一条管的是
// **系统有没有资格替医生做这个动作**——罂粟壳药典剂量 3-6g 完全正常，但它需要
// 麻醉药品处方权、专用处方、专册登记，且"每张处方≤3日用量、连续≤7天"是跨处方的
// 累积约束，而剂量编制是单方无状态计算，原理上算不出来。配一个区间内的 3-6g，
// 仍然是把受限动作默认放行。医疗用毒性药品目录 28 种同理（须药师以上复核签章）。
//
// 反向也要钉住：药典有毒/小毒但非管制的品种**不得**被这条误伤——一刀切会让
// 麻黄汤(苦杏仁)、吴茱萸汤、胶艾汤(艾叶)、附子理中汤(附子)全部不可用。
const controlledPolicy = readJson("tcm-controlled-toxic-herb-policy.source.json");
const controlledToxicNames = new Set(controlledPolicy.entries
  .filter((entry) => entry.policy === "blocked")
  .flatMap((entry) => [entry.herb, ...(entry.aliases || [])])
  .filter(Boolean));
assert.ok(controlledToxicNames.has("罂粟壳") && controlledToxicNames.has("雄黄"),
  "管制品种表必须覆盖麻醉药品与毒性药品目录两类，否则门禁形同虚设");
// 责任的落点从「整方作废」移到「该味退出可编译组成」：系统仍然一次都不为管制品种编制
// 用量，但不再因为方里有一味管制药，就连其余药味都不给医生。原口径的代价是实测出来的——
// 天王补心丹因古方组成含朱砂被整方作废，病例锁到方了仍然 0 味。
// 因此这里改钉两条更强的：①管制味必须被扣除且可见；②扣除后的可编译组成里一味都不许残留。
const controlledDoseCompiled = formulas.entries
  .filter((entry) => entry.doseCompilationEligible)
  .map((entry) => {
    const deducted = new Set(entry.manualDoseIngredientNames || []);
    return {
      name: entry.name,
      herbs: [...new Set((entry.ingredientLinks || [])
        .map(effectiveDoseName)
        .filter((name) => name && controlledToxicNames.has(name)))]
        .filter((name) => !deducted.has(name)
          && !(entry.ingredientLinks || []).some((link) =>
            deducted.has(link.rawName) && effectiveDoseName(link) === name)),
    };
  })
  .filter((entry) => entry.herbs.length > 0);
assert.deepEqual(controlledDoseCompiled, [],
  "管制品种(麻醉药品/医疗用毒性药品目录)不得进入可编译组成，须转有相应处方权的医师人工决策：" +
  controlledDoseCompiled.map((entry) => `${entry.name}[${entry.herbs.join("、")}]`).join("; "));
// 扣除不得是静默丢弃：含管制味的方必须把它列进 manualDoseIngredientNames，下游据此
// 标注 toxic_regulated 并提示医师单独处理，否则医生根本不知道原方里还有这一味。
const silentlyDropped = formulas.entries
  .filter((entry) => entry.doseCompilationEligible)
  .filter((entry) => (entry.ingredientLinks || []).some((link) =>
    controlledToxicNames.has(effectiveDoseName(link) || "")))
  .filter((entry) => (entry.manualDoseIngredientNames || []).length === 0)
  .map((entry) => entry.name);
assert.deepEqual(silentlyDropped.slice(0, 10), [],
  `含管制味却未在 manualDoseIngredientNames 中声明（共 ${silentlyDropped.length} 首）`)

// 非管制的药典毒性药必须**仍然可用**——这条断言防的是"毒性一刀切"这种过防回潮。
const routineToxicStillAvailable = ["附子", "半夏", "苦杏仁", "吴茱萸", "艾叶"]
  .map((herb) => ({
    herb,
    formulas: formulas.entries.filter((entry) => entry.doseCompilationEligible &&
      (entry.ingredientLinks || []).some((link) => effectiveDoseName(link) === herb)).length,
  }))
  .filter((item) => item.formulas === 0);
assert.deepEqual(routineToxicStillAvailable, [],
  "药典有毒/小毒但非管制的常规药必须保持可编译剂量（毒性走审方警示而非剂量阻断），" +
  `否则麻黄汤/吴茱萸汤/附子理中汤这类常规方会整片失效：${routineToxicStillAvailable.map((item) => item.herb).join("、")}`);

// ─── 方名不得是标准编码 ───
// SZJG 源表 PDF 第 85 页有 4 行被解析成整体错位一列：name 存编码、source 存方名、
// ingredients 存出处书名、functions 存未切分的连写药串。结果目录里出现方名「0602010025」、
// 组成「《医方集解》」且 identityLockEligible=true——医生可能看到「候选方：0602010025」，
// 组成是一本书。已在构建期整行拒收（不自动纠偏：药串无分隔符，按 T9 最长匹配实测只有 2/4
// 能切干净，猜出来的组成会直接变成处方）。
const codeNamedFormulas = formulas.entries
  .filter((entry) => /^\d{6,}$/.test(entry.name))
  .map((entry) => `${entry.name}(${entry.source})`);
assert.deepEqual(codeNamedFormulas, [],
  `方名不得是标准编码，说明源表列错位未被拒收：${codeNamedFormulas.join("、")}`);
// 组成里也不得出现书名（同一错位的另一面）。
const bookAsIngredient = formulas.entries
  .filter((entry) => (entry.ingredients || []).some((name) => /^《.+》$/.test(name)))
  .map((entry) => entry.name);
assert.deepEqual(bookAsIngredient, [],
  `组成里不得出现书名：${bookAsIngredient.slice(0, 6).join("、")}`);

// ─── 「一章多方」的聚合章节不得作为单方入库 ───
// 篇名是「中风诸方」「眼科经验各方」这类的章节，正文里并列着好几首方，抽取器把整章药味
// 揉成一个组成。它们以「方」结尾，能混过下面的剂型后缀守卫——实测 41 首入了库，
// 其中 15 首组成 ≥12 味（眼科经验各方 39 味、辟瘟诸方 30 味）。
// 危害不在剂量（这些都不可编译剂量），在**身份**：identityLockEligible=true 意味着它们会进
// 检索候选、被模型选中并锁定方名，医生看到的是一个根本不存在的 39 味「方」。
// 正确处置是走多方拆分器，不是当单方入库。
const AGGREGATION_CHAPTER_NAME = /(?:诸方|备用方|通用方|杂方|各方|等方|方论|方选|类方)$/;
const aggregationChapters = formulas.entries
  .filter((entry) => entry.sourceClass === "verified_reference_catalog")
  .filter((entry) => AGGREGATION_CHAPTER_NAME.test(entry.name.replace(/(?:[一二三四五六七八九十百]+|\d+)$/, "")))
  .map((entry) => `${entry.name}(${entry.ingredients.length}味)`);
assert.deepEqual(aggregationChapters, [],
  `聚合章节不得作为单方入库，应进多方拆分器：${aggregationChapters.slice(0, 8).join("、")}`);

// ─── 自动抽取的补充方剂必须是「方」，不能是篇名 ───
// tcmoc 抽取器按 <篇名> 切条目，而方书里大量篇名是论述/证治/条辨而非方剂
// （「中暑论」「伏暑条辨第十三」「痿症」「喘促」，甚至「侦探」）。这类条目一旦入库就以方剂身份
// 进入检索候选、占掉短名单名额；身份锁拦得住开方，但医生看到的候选里会混入不存在的方。
// 实测温病批入库后一次性混进 220 条，其中 8 条还被打上了证型标签（裁定花在了不存在的方上）。
const FORMULA_NAME_SHAPE = /(?:汤|丸|散|丹|膏|饮|煎|饮子|汁|粥|茶|酒|露|霜|锭|片|栓|方|子)$/;
// 同名列卷次变体是合法身份约定:import 端把「拔疔散（二）」改写为汉字直缀「拔疔散二」
// （括注尾缀会在 T8 身份归一(剥括注)下让同名列互撞身份）。形状判断与 import 端同口径——
// 先剥卷次数字再测裸名;入库身份保留数字以区分同名列变体。
const VOLUME_SUFFIX = /(?:[一二三四五六七八九十百]+|\d+)$/;
const nonFormulaShaped = formulas.entries
  .filter((entry) => entry.sourceClass === "verified_reference_catalog")
  // 同名异方具名变体(柴葛解肌汤（《医学心悟》程氏）等)是人工裁定命名,不是自动抽取,
  // 形状守卫防的是「篇名冒充方名」,裁定变体不在其射程内(其身份由 homonym 通道的
  // fail-closed 校验单独守住:基线必须在册、身份不得碰撞、组成必须不同)。
  .filter((entry) => entry.sourceCatalog !== "adjudicated_homonym_variant")
  .filter((entry) => !FORMULA_NAME_SHAPE.test(entry.name.replace(VOLUME_SUFFIX, "")))
  .map((entry) => entry.name);
assert.deepEqual(nonFormulaShaped, [],
  `自动抽取的补充方剂名必须是方名形状，命中篇名/病名/症状名：${nonFormulaShaped.slice(0, 10).join("、")}`);

// ─── 证型标签裁定表必须逐条落地，且对全部 sourceClass 生效 ───
// 这道断言存在的原因：tcm-verified-formula-supplements.json 的 curatedSyndromeTags 只喂
// verified_reference_catalog 一类。若把裁定结果走那条通道，经典名方与地方标准方会被**静默丢弃**
// （首批 241 条里有 101 条属于这两类）。丢标签不会报错，只会让这些方永远锁不住——正是最难发现的那种失效。
const syndromeTagAdjudications = readJson("tcm-formula-syndrome-tag-adjudications.source.json");
assert.equal(syndromeTagAdjudications.schemaVersion, "tcm-formula-syndrome-tag-adjudications-v1");
const governedFormulaByName = new Map(formulas.entries.map((entry) => [entry.name, entry]));
const syndromeCanonicalById = new Map(
  [...syndrome.entries, ...(syndrome.clinicalExtensions || [])].map((entry) => [entry.id, entry.canonical]),
);
const adjudicatedSourceClasses = new Set();
// 给药途径闸（2026-08-07）：主治写明外用途径、或源书自述不作辨证的方，标签一律不生效。
// 本断言原本是防「标签**静默**丢失」——那个风险依然存在且更重要，所以规则改成：
//   要么落地，要么**带一条具名拒收理由**。不允许既没落地又没有理由。
// 拒收理由写在目录条目的 syndromeTagRejection 上，构建期另有一条 warning 打印被中和的行数。
let routeRejectedAdjudications = 0;
for (const row of syndromeTagAdjudications.entries) {
  const entry = governedFormulaByName.get(row.name);
  assert.ok(entry, `裁定的方剂必须存在于受控目录：${row.name}`);
  adjudicatedSourceClasses.add(entry.sourceClass);
  const rejection = entry.syndromeTagRejection || "";
  if (rejection) {
    routeRejectedAdjudications += 1;
    assert.match(
      rejection,
      /^(?:external_route|source_declines_differentiation):/,
      `拒收理由必须是受控取值：${row.name}->${rejection}`,
    );
    // 拒收即彻底：不得留半截标签，否则「拒了但还在池子里」比不拒更危险。
    assert.deepEqual(entry.curatedSyndromeTags, [], `${row.name} 已被途径闸拒收，却仍留有裁定标签`);
    assert.deepEqual(entry.syndromeTags, [], `${row.name} 已被途径闸拒收，却仍在运行时候选池里`);
    continue;
  }
  for (const tagId of row.syndromeTagIds) {
    assert.ok(syndromeCanonicalById.has(tagId), `裁定标签必须是受控证候 id：${row.name}->${tagId}`);
    assert.ok(entry.curatedSyndromeTags.includes(tagId), `裁定标签未落地到目录：${row.name}->${tagId}`);
    assert.ok(entry.syndromeTags.includes(tagId), `裁定标签未进入运行时 syndromeTags：${row.name}->${tagId}`);
  }
  // 有标签 ⇒ 可被身份锁锁定，这是裁定的全部意义所在。
  assert.ok(entry.identityLockEligible, `裁定过的方剂必须可被身份锁锁定：${row.name}`);
}
// 闸必须真的在拦东西：归零说明判据被改没了或源表被清过，那正是它该拦的那类回归。
assert.ok(
  routeRejectedAdjudications >= 30,
  `途径闸只中和了 ${routeRejectedAdjudications} 行裁定，判据疑似失效——` +
    "实测基线是 41 行（含剪草散/木瓜酒/伤风腿疼方/咽肿喉闭外治方这类外用方被打上内服证候标签）",
);
// 反向：外用途径闸不得误伤**内服**托里生肌方。创面处置词（生肌/收口/敛疮）说明「治什么」，
// 不说明「怎么给药」，一刀切会把这批经典外科内治方从医生手里拿走。
for (const name of ["四妙汤", "托里黄汤", "山豆根汤"]) {
  const entry = governedFormulaByName.get(name);
  if (!entry) continue;
  assert.equal(entry.syndromeTagRejection || "", "", `内服托里方 ${name} 被途径闸误伤`);
  assert.ok(entry.syndromeTags.length > 0, `内服托里方 ${name} 的证候标签丢失`);
}
assert.deepEqual(
  [...adjudicatedSourceClasses].sort(),
  ["official_classic_catalog", "official_local_formula_standard", "verified_reference_catalog"],
  "裁定通道必须对三类来源都生效，缺任何一类都说明通道退化回了 verified-only",
);
assert.equal(
  formulaRetrievalIndex.curatedRelationSource.sha256,
  sha256(formulaRetrievalIndex.curatedRelationSource.file),
  "T8 high-frequency relation source drift",
);
assert.ok(manifest.buildSummary.formulaDoseCompilationEligible >= FORMULA_DOSE_ELIGIBLE_FLOOR,
  `manifest 与目录必须同源同口径，且不得低于 ${FORMULA_DOSE_ELIGIBLE_FLOOR}`);
assert.equal(manifest.buildSummary.formulaDoseCompilationEligible, formulas.summary.doseCompilationEligibleCount,
  "manifest 与目录的剂量可编译数必须一致——两处各持一份字面量正是此前 319/320 长期不一致的原因");
assert.ok(formulas.summary.symptomTaggedFormulaCount >= 250);
assert.ok(formulas.summary.diseaseTaggedFormulaCount >= 80);
assert.ok(formulas.summary.syndromeTaggedFormulaCount >= 250);
assert.equal(formulas.reviewQueue.length, 0);
assert.equal(formulas.evidenceAdjudications.length, 8);
assert.equal(formulas.summary.disposedSameNameVariantCount, 113);
assert.equal(formulaRetrievalIndex.sourceCatalog.sha256, sha256(formulaRetrievalIndex.sourceCatalog.file), "T8 retrieval index source catalog drift");
assert.equal(formulaRetrievalIndex.conceptSource.sha256, sha256(formulaRetrievalIndex.conceptSource.file), "T8 retrieval concept source drift");
const retrievalFormulaIds = new Set(formulas.entries.filter((item) => item.retrievalEligible).map((item) => item.id));
const retrievalConceptIds = new Set(formulaRetrievalConcepts.entries.map((item) => item.id));
for (const [indexName, index] of Object.entries(formulaRetrievalIndex.indexes)) {
  for (const [key, formulaIds] of Object.entries(index)) {
    if (indexName === "conceptToFormulaIds") assert.ok(retrievalConceptIds.has(key), `unknown T8 retrieval concept ${key}`);
    unique(formulaIds, `${indexName}.${key}`);
    formulaIds.forEach((id) => assert.ok(retrievalFormulaIds.has(id), `${indexName}.${key} stale formula ${id}`));
  }
}
assert.equal("aliasToFormulaIds" in formulaRetrievalIndex.indexes, false, "unused alias index must not be shipped");
assert.equal(formulaRetrievalIndex.summary.formulaCount, retrievalFormulaIds.size);
for (const item of formulas.evidenceAdjudications) {
  assert.equal(item.governanceStatus, "evidence_identity_adjudicated");
  assert.equal(item.retrievalEligible, false, `${item.name} adjudication record must not duplicate the runtime entry`);
  assert.equal(item.identityLockEligible, true);
  assert.equal(item.prescriptionLockEligible, true);
  assert.equal(item.requiresPatientSpecificDoseCompilation, true);
  assert.equal(item.requiresPostPrescriptionAudit, true);
  assert.ok(item.standardBaseline.standardCode, `${item.name} must have a governed standard baseline`);
  assert.ok(item.variants.length > 0, `${item.name} must retain all same-name source variants`);
  assert.ok(item.variants.every((variant) => variant.runtimeEligible === false && variant.disposition), `${item.name} variants must all be disposed`);
}
assert.equal(formulas.evidenceAdjudications.find((item) => item.name === "龙胆泻肝汤")?.variants.length, 25);
assert.equal(formulas.entries.find((item) => item.name === "桂枝汤")?.governanceStatus, "official_local_standard_identity_verified");
assert.equal(formulas.entries.find((item) => item.name === "桂枝汤")?.identityLockEligible, true);
assert.equal(
  formulas.entries.some((item) => item.name === "伤寒、温病用药大体及辟温方"),
  false,
  "原证据 formulas=[] 的章节标题不得被拼成运行时方剂",
);
assert.equal(formulas.entries.find((item) => item.name === "延龄丹")?.ingredients.includes("藁本"), true);
assert.equal(formulas.entries.find((item) => item.name === "真应散")?.ingredients.includes("大枣"), true);
assert.equal(formulas.entries.find((item) => item.name === "碧雪丹")?.ingredients.includes("西黄"), true);
assert.equal(formulas.entries.find((item) => item.name === "治服石虚热水肿方")?.ingredients.includes("巴豆"), true);
const huapiFormula = formulas.entries.find((item) => item.name === "化痞消积膏");
assert.ok(huapiFormula, "化痞消积膏必须保留在受控目录");
assert.equal(huapiFormula.ingredients.includes("穿山甲"), true, "OCR 断行后遗漏的山甲必须回补");
assert.equal(huapiFormula.ingredients.includes("片脑"), true, "OCR 断行后遗漏的片脑必须回补");
assert.equal(huapiFormula.doseCompilationEligible, false, "组成回补不得绕开穿山甲等身份/监管门禁");
for (const name of ["龙胆泻肝汤", "丹栀逍遥散", "天麻钩藤饮", "六味地黄丸", "桂枝汤", "银翘散", "补中益气汤"]) {
  assert.equal(formulas.entries.find((item) => item.name === name)?.identityLockEligible, true, `${name} identity must be lockable`);
}
const formulaNamesAndAliases = new Set(formulas.entries.flatMap((item) => [item.name, ...(item.aliases || [])]));
for (const name of ["二陈汤", "四君子汤", "四物汤", "小柴胡汤", "血府逐瘀汤", "柴胡疏肝散", "参苓白术散", "藿香正气散", "天王补心丹", "左金丸", "越鞠丸", "八正散", "导赤散", "白头翁汤", "甘麦大枣汤", "麻杏石甘汤", "白虎汤", "安宫牛黄丸", "紫雪丹", "至宝丹", "加味逍遥散"]) {
  assert.equal(formulaNamesAndAliases.has(name), true, `T8 missing high-frequency formula ${name}`);
}
unique(formulas.entries.map((item) => item.id), "T8 runtime ids");
unique(formulas.entries.map((item) => item.name), "T8 runtime names");
const normalizedFormulaIdentity = (value) => value.normalize("NFKC")
  .replace(/[（(]?\s*《[^》]{2,80}》\s*[）)]?/g, "")
  .replace(/[\s·•，,。；;：:（）()【】\[\]“”"']/g, "")
  .replace(/(?:加减方?|化裁方?|加味方?)$/g, "")
  .trim();
unique(formulas.entries.map((item) => normalizedFormulaIdentity(item.name)), "T8 normalized runtime identities");
assert.equal(formulas.entries.find((item) => item.name === "丹栀逍遥散")?.aliases.includes("加味逍遥散"), true);
assert.equal(formulas.entries.some((item) => item.name.includes("审视瑶函") && item.name.includes("加味逍遥散")), true);
assert.equal(herbs.source.rowCount, 6708);
assert.ok(herbs.summary.standardNameCount >= 620);
assert.ok(herbs.summary.ambiguousInputCount > 0, "ambiguous aliases must remain explicit");
assert.ok((herbs.summary.resolutionStatusCounts.unique_mapping_requires_review || 0) < 10);
assert.ok(herbs.summary.resolutionStatusCounts.unique_source_backed > 4500);
assert.deepEqual(herbs.resolutionIndex["丁香"], { canonicalName: "丁香", status: "exact_standard_name", autoResolvable: true });
assert.equal(herbs.resolutionIndex["百条根"].status, "ambiguous", "multi-target alias must fail closed");
for (const name of ["生地黄", "生地", "酒黄芩", "酒当归", "盐车前子", "生甘草", "生黄芪", "山栀", "炒山栀", "白芥子", "元参", "桂心", "藿香叶", "干姜片", "生姜皮"]) {
  assert.equal(herbs.resolutionIndex[name]?.autoResolvable, true, `T9 missing auto-resolvable common input ${name}`);
}
assert.equal(herbs.resolutionIndex["芍药"].status, "ambiguous");
assert.ok(herbs.reviewQueue.every((item) => item.serviceLevel.triageBusinessDays === 1 && item.serviceLevel.adjudicationBusinessDays === 5));

assert.equal(requiredFields.entries.length, 16);
assert.deepEqual(requiredFields.governance.universalMinimum, ["chief_complaint", "sex"]);
assert.equal(requiredFields.entries.find((item) => item.id === "sex")?.stagePolicy.collect, "required");
assert.equal(requiredFields.entries.find((item) => item.id === "allergy_history")?.unknownPolicy, "unknown_never_no_allergy");
assert.deepEqual(requiredFields.governance.implementationDrift, []);
// 需求9 新增可见契约 M03-M04-tcm-treatment（中医治疗项目从非药物调护里抽出成独立模块）：
// 契约总数 18→19、可见数 15→16，内部契约数不变。
// 2026-08-06 又减 1：health-education 幽灵契约（声明 visible 但字段根本不存在）已从生成器删除，
// 于是总数回到 18、可见数回到 15。详见文件末尾「T11 不得再出现幽灵契约」那段逐条核对。
assert.equal(outputContracts.entries.length, 18);
assert.equal(outputContracts.summary.internalContractCount, 3);
assert.equal(outputContracts.summary.visibleContractCount, 15);
assert.ok(
  outputContracts.entries.some((item) => item.id === "M03-M04-tcm-treatment" && item.visibility === "visible"),
  "中医治疗项目必须是独立的可见输出契约",
);
{
  const order = outputContracts.surfaces.find((item) => item.id === "comprehensive_clinical_scheme")?.sectionOrder || [];
  assert.ok(
    order.indexOf("M03-M04-tcm-treatment") >= 0 &&
    order.indexOf("M03-M04-tcm-treatment") < order.indexOf("M03-M04-nonpharma"),
    "中医治疗项目必须排在健康调护之前",
  );
}
assert.equal(outputContracts.entries.find((item) => item.id === "M03-M04-lineage")?.visibility, "internal_only");
assert.equal(outputContracts.entries.find((item) => item.id === "M03-western")?.evidenceBinding, "supporting_facts_only");
assert.equal(outputContracts.surfaces.length, 7);
assert.deepEqual(outputContracts.limitedStateCopy.requiredParts, ["knownFacts", "unavailableConclusion", "nextAction"]);
assert.ok(outputContracts.entries.some((item) => item.id === "red-flag-warning"));
// health-education 曾在此被断言「必须存在」——但它声明的 management.healthEducation 字段
// 在契约里根本不存在，这条断言钉住的是一个幽灵。2026-08-06 连同生成器条目一并删除，
// 改由文件末尾「T11 不得再出现幽灵契约」按真实 zod 契约逐条核对路径。
assert.equal(outputContracts.entries.some((item) => item.id === "health-education"), false,
  "health-education 是幽灵契约，必须保持删除状态");
assert.ok(outputContracts.entries.filter((item) => item.visibility === "internal_only").every((item) => item.unknownPolicy === "never_render_to_clinical_user"));
assert.ok(outputContracts.entries.filter((item) => item.visibility === "visible").every((item) => item.rendererId), "every visible output contract must bind a renderer");
const diagnosisClientSource = readFileSync(new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url), "utf8");
for (const item of outputContracts.entries.filter((entry) => entry.visibility === "visible")) {
  assert.match(diagnosisClientSource, new RegExp(item.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${item.id} has no UI contract binding`);
  assert.match(diagnosisClientSource, new RegExp(item.rendererId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${item.rendererId} has no UI implementation`);
}
assert.equal(nondrugTreatments.entries.length, 22);
assert.equal(nondrugTreatments.summary.executableProjectCount, 0);
assert.ok(nondrugTreatments.summary.planTemplateCount >= 25);
assert.ok(nondrugTreatments.summary.parameterizedProjectCount >= 12);
assert.ok(nondrugTreatments.summary.governedFrequencyProjectCount >= 10);
assert.equal(nondrugTreatments.summary.explicitDispositionProjectCount, 22);
assert.ok(nondrugTreatments.summary.sourceTemplateProjectCount >= 12);
// A template whose indicationTag its project does not declare is filtered out by
// dominantIndicationTag() and can never reach a doctor — silent zero coverage, not a template.
assert.deepEqual(
  nondrugTreatments.entries.flatMap((item) =>
    item.planTemplates
      .filter((template) => !item.indicationTags.includes(template.indicationTag))
      .map((template) => `${item.projectCode}:${template.id}`)),
  [],
);
assert.ok(nondrugTreatments.entries.every((item) => item.executable === false));
assert.ok(nondrugTreatments.entries.every((item) => item.clinicianReviewRequired));
assert.ok(nondrugTreatments.entries.every((item) => Boolean(item.coverageDisposition)));
assert.ok(nondrugTreatments.entries.filter((item) => item.containsMedication).every((item) => item.requiresMedicationAudit));
// 食疗/意疗 have no anatomical site and no fixed course; demanding either would force fabricated
// parameters. Every other modality must still carry site, governed frequency and source.
const siteFreeTreatmentModalities = new Set(["diet_therapy", "mind_therapy"]);
assert.ok(nondrugTreatments.entries.flatMap((item) =>
  item.planTemplates.map((template) => ({ projectCode: item.projectCode, ...template }))).every((template) =>
  template.scheduleSuggestion.length > 0 &&
  template.sourceRefs.length > 0 &&
  (siteFreeTreatmentModalities.has(template.projectCode)
    ? template.sitesOrPoints.length === 0
    : template.sitesOrPoints.length > 0 && template.parameterCompleteness.includes("frequency"))));
assert.equal(nondrugTreatments.entries.find((item) => item.projectCode === "acupuncture")?.planTemplates.length, 8);

unique(sourceRegistry.entries.map((item) => item.id), "source registry ids");
const sourceIds = new Set(sourceRegistry.entries.map((item) => item.id));
const assertSourceRefs = (refs, label) => refs.forEach((ref) => assert.ok(sourceIds.has(ref), `${label} unknown source ${ref}`));
const collectSourceRefs = (value, refs = new Set()) => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSourceRefs(item, refs));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "sourceRef" && typeof item === "string" && item.startsWith("SRC-")) refs.add(item);
      else if ((key === "sourceRefs" || key === "protocolSourceRefs") && Array.isArray(item)) {
        item.filter((ref) => typeof ref === "string" && ref.startsWith("SRC-")).forEach((ref) => refs.add(ref));
      } else collectSourceRefs(item, refs);
    }
  }
  return refs;
};
for (const [id, payload] of governedPayloads) assertSourceRefs([...collectSourceRefs(payload)], id);
assertSourceRefs(requiredFields.governance.sourceRefs, "required fields");
assertSourceRefs(outputContracts.governance.sourceRefs, "output contracts");
for (const item of nondrugTreatments.entries) assertSourceRefs(item.protocolSourceRefs, item.projectCode);
for (const item of formulas.evidenceAdjudications) assertSourceRefs([item.standardBaseline.sourceRef], item.name);

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const governance = await jiti.import("../src/lib/clinical-governance-tables.ts");
assert.equal(governance.canonicalTcmSyndromeTerm("心脾两虚证")?.canonical, "心脾两虚");
assert.equal(governance.canonicalTcmSyndromeTerm("肝火扰心")?.canonical, "肝火扰心");
assert.equal(governance.resolveTcmSyndromeTerm("风寒袭肺").status, "canonical", "canonical term must win over alias collision");
assert.equal(governance.resolveTcmSyndromeTerm("痰湿壅肺").status, "ambiguous", "multi-target syndrome alias must fail closed");
for (const [syndromeName, syndromeId, formulaName] of [
  ["风寒犯肺", "wind_cold_binding_lung", "麻黄汤"],
  ["痰热阻肺", "phlegm_heat_obstructing_lung", "清金化痰汤"],
  ["心火炽盛", "heart_fire_hyperactivity", "导赤散"],
]) {
  assert.equal(governance.canonicalTcmSyndromeTerm(syndromeName)?.id, syndromeId);
  const formulaId = formulas.entries.find((item) => item.name === formulaName)?.id;
  assert.ok(formulaId, `${formulaName} must exist in T8`);
  assert.ok(
    formulaRetrievalIndex.indexes.syndromeToFormulaIds[syndromeId]?.includes(formulaId),
    `${syndromeName}->${formulaName} must use the runtime canonical syndrome ID`,
  );
}
assert.equal(governance.governedTcmTermLabelById("heart_spleen_deficiency"), "心脾两虚");
assert.equal(governance.canonicalTcmNatureTerm("气郁")?.canonical, "气滞");
assert.equal(governance.canonicalTcmLocationTerm("胃脘")?.canonical, "胃");
assert.equal(governance.treatmentPrinciplesInText("标本兼顾，清肝安神")[0]?.canonical, "标本兼治");
for (const term of ["正治", "反治", "治标", "治本", "三因制宜", "治病求本", "同病异治"]) {
  assert.equal(governance.treatmentPrinciplesInText(term).length > 0, true, `T4 missing anchor ${term}`);
}
assert.equal(governance.diagnosticContextsInText("缺乏腹部按诊")[0]?.id, "tcm_abdominal_examination");
assert.equal(governance.tcmDiagnosticDependencyContexts("腹诊见脘腹柔软，无压痛").length, 0, "case-bound 腹诊 is legitimate TCM reasoning");
assert.equal(governance.tcmDiagnosticDependencyContexts("仅因缺乏腹部按诊，故不能辨证")[0]?.id, "tcm_abdominal_examination", "only a forbidden dependency frame is rejected");
assert.equal(
  governance.tcmDiagnosticDependencyContexts("尚无头颅MRI，建议进一步排除继发性头痛").length,
  0,
  "a missing modern test may remain as a Western differential boundary without invalidating TCM reasoning",
);
assert.equal(
  governance.tcmDiagnosticDependencyContexts("因缺少头颅MRI，当前无法形成中医辨证结论")[0]?.id,
  "modern_imaging",
  "a missing modern test that explicitly prevents TCM differentiation is rejected",
);
assert.equal(
  governance.tcmDiagnosticDependencyContexts("未做血常规，建议结合感染指标鉴别；四诊合参辨为风热犯肺证").length,
  0,
  "a clinically appropriate laboratory next step must not collapse a complete four-examination conclusion",
);
assert.equal(governance.westernLabelContainsTcmSyndrome("慢性咳嗽（风燥伤肺证）"), true, "T1 must govern Western-label syndrome pollution beyond a short hard-coded list");
assert.equal(governance.governedTreatmentPrinciplesInText("因人制宜，扶正祛邪").length >= 1, true);
const treatmentPrinciplePromptContext = governance.governedTreatmentPrinciplePromptContext();
for (const term of ["正治法", "反治法", "标本兼治", "扶正祛邪", "三因制宜", "治病求本", "同病异治"]) {
  assert.match(treatmentPrinciplePromptContext, new RegExp(term), `T4 prompt context missing ${term}`);
}
assert.match(treatmentPrinciplePromptContext, /标本兼治[\s\S]*至少分别覆盖本与标两个不同目标/);
assert.equal(governance.engineeringJargonInText("程序化安全门控").length, 2);
assert.equal(governance.clinicalRequiredFieldLabel("allergy_history", "fallback"), "过敏史");
assert.equal(governance.clinicalFieldRequiresExplicitPrescriptionState("allergy_history"), true);
assert.equal(governance.CLINICAL_GOVERNANCE_TABLES.requiredFieldPolicy.entries.length, 16);
assert.equal(governance.CLINICAL_GOVERNANCE_TABLES.outputContract.entries.length, 18);
assert.equal(governance.CLINICAL_GOVERNANCE_TABLES.nondrugTreatment.entries.length, 22);

const formulaIndications = await jiti.import("../src/lib/tcm-formula-indications.ts");
assert.ok(highFrequencyFormulaRelations.entries.length >= HIGH_FREQUENCY_SYNDROME_FLOOR);
for (const relation of highFrequencyFormulaRelations.entries) {
  const primary = relation.formulas.find((item) => (item.fit || "primary") === "primary") || relation.formulas[0];
  const therapy = primary.therapyTerms.join("，");
  const candidates = formulaIndications.retrieveTcmFormulaCandidatesForReasoning({
    overview: {
      primarySyndrome: relation.syndrome,
      overallPathogenesis: relation.syndrome,
      tcmDifferentials: [],
    },
    pathogenesis: {
      summary: relation.syndrome,
      locationDifferentiation: { items: [] },
      natureDifferentiation: { items: [] },
      chain: [{
        patientFact: relation.syndrome,
        syndromeEvidence: relation.syndrome,
        pathogenesis: relation.syndrome,
        therapyDirection: therapy,
      }],
    },
    therapy: {
      overallPrinciple: therapy,
      overallMethod: therapy,
      subTherapies: [],
    },
  }, 500);
  const recalled = candidates.find((item) => item.name === primary.name);
  assert.ok(recalled, `${relation.syndrome} must recall ${primary.name} through the runtime API`);
  assert.equal(recalled.positiveSufficiency, true, `${relation.syndrome}->${primary.name} must pass positive sufficiency`);
}

const outputAuthority = await jiti.import("../src/lib/clinical-output-authority.ts");
assert.deepEqual(outputAuthority.clinicalOutputRendererCoverageIssues(), []);
const rawVisible = '程序化安全门控通过，API返回。\n<!-- DIAGNOSIS_JSON_START -->\n{"note":"API必须保持原样"}\n<!-- DIAGNOSIS_JSON_END -->';
const governedVisible = outputAuthority.sanitizeAuthoritativeClinicalOutput(rawVisible);
assert.deepEqual(outputAuthority.visibleClinicalOutputGovernanceIssues(governedVisible), []);
assert.match(governedVisible, /按当前风险筛查规则/);
assert.match(governedVisible, /系统内部处理/);
assert.match(governedVisible, /{"note":"API必须保持原样"}/, "T7 must never mutate the signed structured block");
assert.equal(outputAuthority.sanitizeAuthoritativeClinicalOutput(governedVisible), governedVisible, "T7 visible normalization must be idempotent");
assert.equal(
  outputAuthority.sanitizeAuthoritativeClinicalOutput("门控心肌灌注显像用于评估心肌灌注。"),
  "门控心肌灌注显像用于评估心肌灌注。",
  "T7 must not corrupt a legitimate gated myocardial perfusion imaging term",
);
assert.doesNotMatch(
  outputAuthority.sanitizeAuthoritativeClinicalOutput("门控未通过，信息不足无法判断。"),
  /门控未通过|信息不足无法判断/,
  "T7 must still normalize engineering gate status and non-actionable insufficient-information copy",
);
assert.deepEqual(
  outputAuthority.visibleClinicalOutputGovernanceIssues("门控心肌灌注显像"),
  [],
  "legitimate clinical imaging terminology must not be reported as engineering jargon",
);
assert.equal(
  outputAuthority.sanitizeAuthoritativeClinicalOutput("本证与兼证之间的病机关联明确。"),
  "本证与兼证之间的病机关联明确。",
  "T7 must not rewrite a legitimate clinical pathogenesis relationship",
);
assert.doesNotMatch(
  outputAuthority.sanitizeAuthoritativeClinicalOutput("病机关联字段校验失败。"),
  /病机关联字段/,
  "T7 must still normalize the same phrase in an explicit engineering-field context",
);
assert.equal(outputAuthority.clinicalOutputLabel("M04-patent-western", "fallback"), "中成药/西药候选");
assert.equal(outputAuthority.visibleClinicalOutputContractsForStage("prescribe").some((item) => item.id === "M04-formula"), true);
assert.equal(outputAuthority.clinicalOutputSurface("red_flag_escalation")?.sectionOrder[0], "red-flag-warning");
assert.match(outputAuthority.buildThreePartLimitedStateCopy({
  knownFacts: "已记录主诉",
  unavailableConclusion: "具体用量建议",
  reason: "性别生理风险分层未明确",
  nextAction: "补充后重新评估",
}), /当前已确认[\s\S]*当前尚不能形成[\s\S]*下一步/);
assert.match(outputAuthority.buildThreePartLimitedStateCopyForSurface("limited_clinical_scheme", {
  knownFacts: "已记录主诉",
  unavailableConclusion: "完整诊疗方案",
  reason: "尚有关键事实待核实",
  nextAction: "补充后重新评估",
}), /当前已确认[\s\S]*当前尚不能形成[\s\S]*下一步/);
assert.throws(
  () => outputAuthority.buildThreePartLimitedStateCopyForSurface("comprehensive_clinical_scheme", {
    knownFacts: "已记录主诉",
    unavailableConclusion: "完整诊疗方案",
    reason: "尚有关键事实待核实",
    nextAction: "补充后重新评估",
  }),
  /does not authorize limited-state copy/,
);

const herbIdentity = await jiti.import("../src/lib/tcm-herb-identity.ts");
assert.equal(herbIdentity.resolveGovernedTcmHerbIdentity("杏仁").canonicalName, "苦杏仁");
assert.deepEqual(herbIdentity.resolveGovernedTcmHerbIdentity("百条根"), {
  inputName: "百条根",
  status: "ambiguous",
  candidates: ["一枝黄花", "威灵仙", "百部"],
});
assert.equal(herbIdentity.resolveGovernedTcmHerbIdentity("干姜片").canonicalName, "干姜");
assert.equal(herbIdentity.resolveGovernedTcmHerbIdentity("茯神").doseCanonicalName, "茯苓");
assert.equal(herbIdentity.resolveGovernedTcmHerbIdentity("芍药").status, "ambiguous");

const requiredFieldRuntime = await jiti.import("../src/lib/clinical-required-fields.ts");
assert.equal(requiredFieldRuntime.validateCollectRequiredFields(undefined).ok, false);
assert.equal(requiredFieldRuntime.validateCollectRequiredFields("其他或未明确").ok, true);
assert.equal(requiredFieldRuntime.patientSexAllowsDoseLevelSuggestion("其他或未明确"), false);
assert.equal(requiredFieldRuntime.patientSexAllowsDoseLevelSuggestion("女"), true);

const treatmentProjects = await jiti.import("../src/lib/tcm-treatment-projects.ts");
const acupuncture = treatmentProjects.getTcmTreatmentProjectDefinition("acupuncture");
assert.equal(acupuncture?.protocolSourceRefs.includes("SRC-SAMR-ACUPUNCTURE-OPS"), true, "T12 protocol evidence must reach the runtime project registry");
assert.equal(acupuncture?.executable, false);
assert.equal(acupuncture?.governedParameterTemplateAvailable, true);
assert.equal(acupuncture?.governedFrequencyTemplateAvailable, true);
assert.equal(acupuncture?.clinicianReviewRequired, true);
// 模板选取改为按**有序适应证**逐个匹配（甲方生产实测 2026-08-04 缺陷1：原按目录排列顺序
// find，导致头痛病例拿到失眠方穴位）。此处传项目自身的全部适应证，语义与原来的"不限定"一致。
const acupunctureTags = acupuncture?.indicationTags || [];
assert.equal(treatmentProjects.governedTcmTreatmentPlanTemplateForTags("acupuncture", "患者失眠不寐", acupunctureTags)?.sitesOrPoints.includes("神门"), true);
assert.equal(treatmentProjects.governedTcmTreatmentPlanTemplateForTags("acupuncture", "普通腰痛", acupunctureTags)?.indicationTag, "musculoskeletal_pain");
assert.equal(treatmentProjects.governedTcmTreatmentPlanTemplateForTags("acupuncture", "普通湿疹", acupunctureTags), undefined);

// —— T11 输出契约登记表：不得再出现「幽灵契约」（2026-08-06） ——
//
// 缺陷形态：登记表里躺着一条 health-education，声明 visibility=visible、有 rendererId、
// path=management.healthEducation，读起来像一个已交付模块——而 ClinicalReasoningResultV2.management
// 只有 redFlagLoop / mustCollect / followupSafetyNet，从来没有 healthEducation。
// 它连其余条目都有的 `reasoningV2.` 前缀都没写，说明从提出那天起就没接过线。
//
// 幽灵条目比缺条目更糟：登记表现在是 HIS 分节咬合（test:his-section-coupling）的事实来源，
// 混进永远不会出现的模块，就没法再拿它判断「某模块该不该有」。
// 本段按**真实 zod 契约**逐条核对声明路径，杜绝下一条幽灵。
{
  const registry = readJson("clinical-output-contract-registry.json");
  const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");

  // zod 包装层：nullable / optional / default / catch / pipe 都会把真身藏在 innerType 里，
  // 数组在 element。逐层剥到拿得到 shape（对象）或 element（数组）为止。
  const defOf = (schema) => schema?._def || schema?.def || {};
  const unwrap = (schema) => {
    let current = schema;
    for (let depth = 0; depth < 24 && current; depth += 1) {
      if (current.shape) return current;
      const def = defOf(current);
      // z.preprocess(fn, schema) 在 zod4 里是 ZodPipe{in: ZodTransform, out: schema}——
      // 真身在 out 而不是 in。逐条隔离（isolateInvalidItems）大量用到它，只看 in 会在
      // 预处理函数上停住，把真契约字段误报成幽灵。
      const preprocessed = defOf(def.in).type === "transform" ? def.out : undefined;
      const inner = def.innerType || preprocessed || def.in || def.schema
        || (Array.isArray(def.options) ? def.options.find((option) => defOf(option).type === "object") : undefined);
      if (!inner) return current;
      current = inner;
    }
    return current;
  };
  const elementOf = (schema) => {
    const def = defOf(schema);
    return def.element || def.type === "array" ? def.element : undefined;
  };

  const pathExists = (dotted) => {
    let node = unwrap(ReasoningV2Schema);
    for (const rawSegment of dotted.split(".")) {
      const isArrayElement = rawSegment.endsWith("[]");
      const segment = isArrayElement ? rawSegment.slice(0, -2) : rawSegment;
      const shape = node?.shape;
      if (!shape || !(segment in shape)) return false;
      let next = unwrap(shape[segment]);
      if (isArrayElement) {
        const element = elementOf(next) || defOf(next).element;
        if (!element) return false;
        next = unwrap(element);
      }
      node = next;
    }
    return true;
  };

  // 可见条目里合法的**非 reasoningV2 来源**。它们不是幽灵：安全门、病历载荷、M02 计划
  // 各有自己的载体，只是不在推理契约里。清单显式登记，新增来源必须在这里报到。
  const KNOWN_NON_REASONING_SOURCES = new Set([
    "safetyGate.redFlags/reasons",
    "caseState/hisRecord",
    "M02Plan.questions",
    "deterministic assessment markdown",
  ]);

  // 闸门自检：判据本身必须既认得真路径、也拒得掉假路径，否则它只是一段永远绿的装饰。
  assert.equal(pathExists("formula.candidates[].decoction"), true,
    "路径遍历认不出数组元素下的字段，闸门会把真契约误报成幽灵");
  assert.equal(pathExists("nonPharma.precautions"), true);
  assert.equal(pathExists("westernDiagnosis.primary.suggestedChecks"), true);
  assert.equal(pathExists("management.healthEducation"), false,
    "已删除的幽灵字段仍被判为存在，闸门形同虚设");
  assert.equal(pathExists("formula.candidates[].notAField"), false);
  assert.equal(pathExists("完全不存在的字段"), false);

  // 单 id 绑定的页面模块，其标题必须与登记表标签一致（甲方 3.1，2026-08-06）。
  //
  // 甲方原话「总体病机显示错误，显示为病机分析了」：登记表里 M03-pathogenesis 的标签是
  // 「病机拆解」，服务端可见正文渲染的也是它，而 DiagnosisClient 把标题写死成「病机分析」。
  // 与本轮 HIS 分节标题、鉴别诊断出栏同一形态：两份标题各自演进，页面与正文分叉。
  // 组合模块（一个 SchemeSection 绑多个 id，如「诊断结论」同时覆盖西医与中医）不在此列。
  {
    const clientSource = readFileSync(
      new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url), "utf8");
    // 判据是「每个契约 id **至少有一个**页面模块标题与登记表标签一致」，不是「所有模块都一致」：
    // 同一 id 下允许存在子面板（候选方药模块内的「方义解析」就是），它们另起标题是合理的。
    // 要防的是**主模块被改名后与登记表分叉**——甲方 3.1 正是这一种。
    const titlesByContract = new Map();
    const unknownBindings = [];
    for (const match of clientSource.matchAll(
      /<SchemeSection[^>]*?title=(\{clinicalOutputLabel\([^)]*\)\}|"[^"]*")[^>]*?contractIds="([A-Za-z0-9-]+)"/gs)) {
      const [, rawTitle, contractId] = match;
      if (!registry.entries.some((item) => item.id === contractId)) {
        unknownBindings.push(`页面模块绑定了登记表里不存在的 ${contractId}`);
        continue;
      }
      const bucket = titlesByContract.get(contractId) || [];
      bucket.push(rawTitle.startsWith("{clinicalOutputLabel") ? "__GOVERNED__" : rawTitle.slice(1, -1));
      titlesByContract.set(contractId, bucket);
    }
    assert.deepEqual(unknownBindings, [], unknownBindings.join("\n"));
    const titleDrift = [];
    for (const [contractId, titles] of titlesByContract) {
      const entry = registry.entries.find((item) => item.id === contractId);
      const aligned = titles.some((title) => title === "__GOVERNED__" || title === entry.label);
      if (!aligned) {
        titleDrift.push(`${contractId}：页面标题 ${JSON.stringify(titles)} 无一与登记表标签「${entry.label}」一致`);
      }
    }
    assert.deepEqual(titleDrift, [], `页面模块标题与受治理登记表漂移：\n${titleDrift.join("\n")}`);
  }

  const ghosts = [];
  for (const entry of registry.entries) {
    const path = String(entry.path || "");
    // 只核对声明为 reasoningV2 字段路径的条目；确定性 markdown、签名等非字段条目跳过。
    if (!path.startsWith("reasoningV2.")) {
      // 可见条目若既不是 reasoningV2 路径、也不在已登记的非推理来源清单里，就是可疑的幽灵。
      if (entry.visibility === "visible" && !KNOWN_NON_REASONING_SOURCES.has(path)) {
        ghosts.push(`${entry.id}：可见条目的 path「${path}」既非 reasoningV2 字段，也未在非推理来源清单登记`);
      }
      continue;
    }
    if (!pathExists(path.slice("reasoningV2.".length))) {
      ghosts.push(`${entry.id}：声明路径「${path}」在 ReasoningV2Schema 中不存在（幽灵契约）`);
    }
  }
  assert.deepEqual(ghosts, [], `T11 登记表存在幽灵契约：\n${ghosts.join("\n")}`);
  assert.equal(registry.entries.some((entry) => entry.id === "health-education"), false,
    "health-education 幽灵条目必须保持删除状态");
}

console.log(JSON.stringify({ tables: 12, syndromeTerms: 2060, treatmentTerms: 1276, governedFormulas: formulas.entries.length, syndromeTagAdjudications: syndromeTagAdjudications.entries.length, herbNames: herbs.summary.standardNameCount, outputContracts: 18, failures: 0 }));
