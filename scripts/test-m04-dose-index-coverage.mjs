/**
 * Invariant: the M04「候选处方剂量限定名单」must equal what the code actually enforces.
 *
 * Why this test exists. The list is handed to M04 in categorical prohibition language
 * (「herbs[]只能选择本名单…未覆盖药味不得输出剂量或放入候选处方」) while the real gate,
 * doseWithinConservativeModelLimit, validates against every dose-resolvable 饮片. When the list was
 * built from data.commonHerbs — the 99-row `tcm_curated_llm_candidates` worklist whose every row
 * reads「待人工复核」— the emitted whitelist contained 马钱子/巴豆霜/斑蝥/朱砂/雄黄/蟾酥/轻粉/罂粟壳
 * but NOT 黄芪/白术/茯苓/当归/龙眼肉, and only 7 of 500 governed formulas had all ingredients inside
 * it. A model obeying that prohibition is being told to prescribe out of a toxicity list.
 *
 * The rule this locks: prompt scope == enforcement scope. A future edit that narrows the list back
 * to a curated subset fails here.
 */
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

const { buildTcmKnowledgeContext, getTcmHerbDoseLimit, clinicianDoseHerbClass, isKnownTcmHerbName } = await jiti.import("../src/lib/tcm-knowledge.ts");
const { createInitialCaseState } = await jiti.import("../src/lib/diagnosis-types.ts");
const knowledge = (await jiti.import("../src/data/tcm-knowledge.json", { default: true }));
const catalog = (await jiti.import("../src/data/tcm-formula-governed-catalog.json", { default: true }));
const governanceManifest = (await jiti.import("../src/data/clinical-governance-table-manifest.json", { default: true }));

const caseState = createInitialCaseState();
caseState.patient.sex = "女";
caseState.chiefComplaint = "入睡困难、多梦易醒3个月，乏力健忘，饭量减少";
caseState.conversation = [{ role: "user", content: caseState.chiefComplaint }];
const context = buildTcmKnowledgeContext(caseState, "prescribe");

const doseSection = context.split("候选处方剂量限定名单")[1]?.split("\n")[0] || "";
assert.ok(doseSection.length > 0, "prescribe context must carry the dose-limit list");

// 1. 组方基石药味必须在名单内。它们的缺席正是原缺陷的临床表现。
const CORE_TONICS = ["人参", "黄芪", "白术", "茯苓", "甘草", "当归", "白芍", "川芎", "熟地黄", "党参", "大枣", "龙眼肉"];
const missingTonics = CORE_TONICS.filter((herb) => !doseSection.includes(herb));
assert.deepEqual(
  missingTonics,
  [],
  `候选处方剂量限定名单缺少组方基石药味：${missingTonics.join("、")}。名单若来自「待人工复核」候选队列而非全部可解析剂量饮片，就会只剩毒性药而没有补益药。`,
);

// 2. 名单范围必须等于代码门禁范围，而不是 commonHerbs 子集。
const doseResolvable = knowledge.herbs.filter((herb) => {
  const limit = getTcmHerbDoseLimit(herb.name);
  return limit?.min != null && limit?.max != null;
});
const listed = doseResolvable.filter((herb) => doseSection.includes(herb.name));
assert.ok(
  listed.length >= doseResolvable.length * 0.98,
  `名单只覆盖 ${listed.length}/${doseResolvable.length} 味可解析剂量饮片；prompt 的禁止性措辞要求它等于代码校验范围`,
);
assert.ok(
  doseResolvable.length > knowledge.commonHerbs.length * 3,
  `可解析剂量饮片 ${doseResolvable.length} 味应远多于 commonHerbs ${knowledge.commonHerbs.length} 行；若接近说明又退回了候选队列`,
);

// 3. 毒性药可以在名单内（药典收载且有剂量），但必须逐条带毒性标注，不能与普通药味无差别并列。
for (const toxic of ["马钱子", "巴豆霜", "斑蝥"]) {
  if (!doseSection.includes(toxic)) continue;
  const segment = doseSection.split("；").find((row) => row.startsWith(toxic)) || "";
  assert.match(segment, /生成前安全:[^；]*毒性/, `${toxic} 出现在剂量名单中时必须带毒性标注`);
}

// 4. 端到端：整个方剂锁链路为之整改的归脾汤，其全部药味必须可解析剂量。
const guipi = catalog.entries.find((entry) => entry.name === "归脾汤");
assert.ok(guipi, "governed catalog must contain 归脾汤");
const guipiIngredients = (guipi.ingredients || []).map((item) => (typeof item === "string" ? item : item.name || item.herb || ""));
const unresolvable = guipiIngredients.filter((herb) => {
  const limit = getTcmHerbDoseLimit(herb);
  return !(limit?.min != null && limit?.max != null);
});
assert.deepEqual(unresolvable, [], `归脾汤 药味无法解析剂量：${unresolvable.join("、")}`);

const fullyCovered = catalog.entries.filter((entry) => {
  const ingredients = (entry.ingredients || []).map((item) => (typeof item === "string" ? item : item.name || item.herb || "")).filter(Boolean);
  return ingredients.length > 0 && ingredients.every((herb) => {
    const limit = getTcmHerbDoseLimit(herb);
    return limit?.min != null && limit?.max != null;
  });
}).length;
const governedDoseCompilationEligible = catalog.entries.filter((entry) => entry.doseCompilationEligible === true).length;
assert.ok(
  fullyCovered >= 300,
  `仅 ${fullyCovered} 个受控方剂的全部药味可解析剂量（修复前为 7，接入 T9 饮片名解析后为 327）；低于 300 说明剂量覆盖面又退化了`,
);
// 剂量豁免层启用后（甲方 2026-08-01 决策：降低门禁、审方兜底），编译许可数**必然**高于
// 「全部药味可解析剂量」数——差额正是那些无法定数值边界、改由医师确定用量的成分
//（琥珀、龙骨、粳米、朱砂…）。它们不再阻断出方，但也没有获得剂量背书：
// HIS 载荷按 clinicianDoseHerbClass 把它们标为 unverified_dose / toxic_regulated。
// 因此这里不再要求许可数 ≤ 可解析数，改为守住「差额全部来自豁免层」这条更强的不变量：
// 任何一首获许可却含**非豁免**未解析药味的方，都说明豁免链路漏了口子。
{
  const leaked = catalog.entries.filter((entry) => entry.doseCompilationEligible === true).filter((entry) => {
    // manualDoseIngredientNames 是 T8 已从可编译组成中扣除的毒性/管制味：系统不为它们编制
    // 用量，它们也不进处方药味表，因此不在本不变量的定义域内。但扣除不得成为藏缺口的口子——
    // 下方单独断言：每一个扣除味都必须确实缺法定剂量（否则就是把能定量的药也悄悄扣掉了）。
    const deducted = new Set(entry.manualDoseIngredientNames || []);
    const ingredients = (entry.ingredients || [])
      .map((item) => (typeof item === "string" ? item : item.name || item.herb || ""))
      .filter(Boolean)
      .filter((herb) => !deducted.has(herb));
    return ingredients.some((herb) => {
      const limit = getTcmHerbDoseLimit(herb);
      if (limit?.min != null && limit?.max != null) return false;
      return !clinicianDoseHerbClass(herb);
    });
  }).map((entry) => entry.name);
  assert.deepEqual(leaked.slice(0, 10), [],
    `获剂量编译许可的方中存在既无法定剂量、又不在医师定量豁免表内的药味（共 ${leaked.length} 首）`);

  // 扣除只允许从**构建期已证明拿不到内服煎剂剂量边界**的那一批里取，不能自己再挑。
  // 否则「扣除」会变成绕过剂量核验的万能出口：把任何拿不准的药一扣，整方就"可编译"了。
  //
  // 判据必须用目录自己记录的两个集合，而不是回头用 getTcmHerbDoseLimit 重新推一遍——
  // 后者不看给药途径，与构建期的煎剂口径不是同一条规则，重推只会制造假警报：
  //   · 朱砂/雄黄/轻粉 有药典数字（0.1-0.5g 等），但条目自带「有毒且不入汤剂」；
  //   · 大蓟炭 有药典 5-10g，但药典给它列的唯一途径是丸散，没有煎服。
  // 两者都该扣除，用剂量数字判会双双误判为「有边界却被扣掉」。
  //   · 第三类（2026-08-09 新增）：**身份分叉**的味——歧义且落不到唯一规范名上
  //     （芍药→白芍/赤芍、皂角→大皂角/猪牙皂、贯众→狗脊/绵马贯众、乌头→川乌/草乌）。
  //     它此前根本没走扣除通道：歧义属名被「药典未收载」豁免表自动收编，直接放行了 93 首方。
  //     那是个自我授权闭环——豁免表按「哪些名字卡住了方剂」汇总，卡住它的东西自己拿到了豁免。
  //     现在改走扣除：目录不替医生选品种，扣除该味并要求医生**指定品种**（而不是只定用量），
  //     且照旧受 ≥3 味 / ≥60% 守卫约束。它同样是构建期证明过的，记在
  //     varietyUndeterminedIngredients 里，因此计入 provable。
  const wronglyDeducted = catalog.entries.flatMap((entry) => {
    const provable = new Set([
      ...(entry.missingDoseBoundaryIngredientNames || []),
      ...(entry.controlledToxicIngredientNames || []),
      ...(entry.varietyUndeterminedIngredients || []).map((row) => row.name),
    ]);
    return (entry.manualDoseIngredientNames || [])
      .filter((herb) => !provable.has(herb))
      .map((herb) => `${entry.name}/${herb}`);
  });
  assert.deepEqual(wronglyDeducted.slice(0, 10), [],
    `扣除了构建期未证明缺内服剂量边界的药味（共 ${wronglyDeducted.length} 处）`);
}
assert.equal(
  governedDoseCompilationEligible,
  governanceManifest.buildSummary.formulaDoseCompilationEligible,
  "M04 测试、T8 目录与治理 manifest 的剂量可编译统计口径必须一致",
);



// 5. T9 受控饮片名解析必须接进剂量层：经典方组成用的是饮片规格与古名。
for (const [input, canonical] of [["黄芩片", "黄芩"], ["附片", "附子"], ["山萸肉", "山茱萸"], ["麦门冬", "麦冬"], ["盐菟丝子", "菟丝子"], ["燀桃仁", "桃仁"], ["熟地", "熟地黄"]]) {
  const resolved = getTcmHerbDoseLimit(input);
  const target = getTcmHerbDoseLimit(canonical);
  assert.ok(resolved, `受控饮片名 ${input} 必须能解析剂量（T9 已将其映射到 ${canonical}）`);
  assert.equal(resolved.min, target?.min, `${input} 的剂量下限必须等于 ${canonical}`);
  assert.equal(resolved.max, target?.max, `${input} 的剂量上限必须等于 ${canonical}`);
}

// 6. Fail-closed：歧义名与毒性药生品不得因上述解析而获得剂量。
for (const ambiguousName of ["芍药", "贝母", "沙参"]) {
  assert.equal(getTcmHerbDoseLimit(ambiguousName), null, `${ambiguousName} 是歧义名（需医生指定具体品种），不得自动解析出剂量`);
}
for (const rawToxic of ["生川乌", "生草乌", "生半夏", "生附子"]) {
  assert.equal(getTcmHerbDoseLimit(rawToxic), null, `${rawToxic} 是毒性药生品，不得通过炮制前缀剥离获得内服剂量`);
}

console.log(JSON.stringify({
  doseResolvableHerbs: doseResolvable.length,
  curatedWorklistRows: knowledge.commonHerbs.length,
  ingredientDoseResolvableFormulas: fullyCovered,
  governedDoseCompilationEligible,
  coreTonicsPresent: CORE_TONICS.length - missingTonics.length,
  failures: 0,
}, null, 2));

// ─── 存在性判定必须覆盖本仓自己的功效权威表 ─────────────────────────────────
// 缺口的形态：《中药学》第十版功效归类表(507 味)认识浮小麦(固表止汗药)、白花蛇舌草、
// 玉米须、绞股蓝…，而 isKnownTcmHerbName 只查剂量知识库，于是同一味药在「有没有功效」上
// 答有、在「存不存在」上答否。M04 据后者以 herb_*_unknown 把整方判死——实测汗证病例
// 开出浮小麦后 0 味，而浮小麦是甘麦大枣汤/牡蛎散的核心药。
// 逐味补是修不完的；这里钉住整表：功效表里的每一味，要么被识别，要么落在两个**显式**的
// 例外集合里。新增缺口一律红。
{
  const functionCategories = await jiti.import("../src/data/tcm-herb-function-categories.json", { default: true });
  // ① 监管轴：门槛来自法规而非数据缺口，不进豁免层（见 tcm-controlled-toxic-herb-policy）。
  const REGULATORY = new Set(["守宫", "海狗肾", "熊胆粉", "甜瓜蒂", "硼砂", "蟾皮", "铅丹", "黄狗肾"]);
  // ② 源表 OCR 残缺名：GB18030 生僻字丢字，必须回源修抽取，不得靠猜测补全
  //    （斑鳌=斑蝥、广董香=广藿香、淡豆鼓=淡豆豉、瓜萎=瓜蒌、稀签草=豨莶草、
  //     罂栗壳=罂粟壳、芒麻根=苎麻根、芜花=芫花、青箱子=青葙子、枳棋子=枳椇子、老鹤草=老鹳草）。
  const SOURCE_OCR_DEFECTS = new Set([
    "广董香", "斑鳌", "枳棋子", "淡豆鼓", "瓜萎", "白鼓", "稀签草", "罂栗壳", "老鹤草",
    "芒麻根", "芜花", "青箱子",
  ]);
  const unrecognized = Object.keys(functionCategories.categories)
    .filter((herb) => !isKnownTcmHerbName(herb))
    .filter((herb) => !REGULATORY.has(herb) && !SOURCE_OCR_DEFECTS.has(herb));
  assert.deepEqual(unrecognized, [],
    `功效表收载但存在性判定不认的药味（M04 会以 herb_*_unknown 作废整方）：${unrecognized.join("、")}`);
  // 反向：例外集合不得被用来掩盖已经修好的缺口，否则它会慢慢变成一张万能白名单。
  const staleExceptions = [...REGULATORY, ...SOURCE_OCR_DEFECTS].filter((herb) => isKnownTcmHerbName(herb));
  assert.deepEqual(staleExceptions, [],
    `已被识别的药味仍留在例外集合里，应当移除：${staleExceptions.join("、")}`);
}
